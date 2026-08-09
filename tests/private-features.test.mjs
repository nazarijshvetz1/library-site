import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  coverOwnerPrefix,
  detectCoverImage,
  MAX_COVER_PHOTO_BYTES,
  validCoverPhotoKey,
} from "../lib/cover-upload.ts";
import { lookupBookByIsbn } from "../lib/isbn-lookup.ts";
import { normalizeIsbn } from "../lib/isbn.ts";

test("normalizes and validates ISBN-10 and ISBN-13", () => {
  assert.equal(normalizeIsbn("978-0-306-40615-7"), "9780306406157");
  assert.equal(normalizeIsbn("0-306-40615-2"), "0306406152");
  assert.equal(normalizeIsbn("9780306406158"), null);
  assert.equal(normalizeIsbn("../9780306406157"), null);
});

test("combines fixed-host ISBN metadata providers without credentials", async () => {
  const requests = [];
  const fetcher = async (input) => {
    const url = new URL(input);
    requests.push(url);
    if (url.hostname === "www.googleapis.com") {
      return Response.json({
        items: [{
          volumeInfo: {
            title: "Математика. 5 клас",
            authors: ["Олена Авторка"],
            publisher: "Освіта",
            publishedDate: "2025",
            imageLinks: { thumbnail: "http://books.google.test/cover.jpg" },
            infoLink: "https://books.google.test/book",
          },
        }],
      });
    }
    return Response.json({
      docs: [{
        key: "/books/OL1M",
        title: "Інший збіг",
        author_name: ["Інший Автор"],
        publisher: ["Видавництво"],
        first_publish_year: 2024,
        cover_i: 123,
      }],
    });
  };

  const candidates = await lookupBookByIsbn("9780306406157", fetcher);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].publishedYear, 2025);
  assert.equal(candidates[0].coverUrl, "https://books.google.test/cover.jpg");
  assert.ok(requests.some((url) => url.hostname === "www.googleapis.com" && url.searchParams.get("q") === "isbn:9780306406157"));
  assert.ok(requests.some((url) => url.hostname === "openlibrary.org" && url.searchParams.get("isbn") === "9780306406157"));
});

test("recognizes only supported cover image signatures and owner-scoped keys", async () => {
  assert.deepEqual(detectCoverImage(Uint8Array.from([0xff, 0xd8, 0xff, 0x00])), {
    extension: "jpg",
    contentType: "image/jpeg",
  });
  assert.deepEqual(detectCoverImage(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), {
    extension: "png",
    contentType: "image/png",
  });
  assert.deepEqual(detectCoverImage(Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
  ])), {
    extension: "webp",
    contentType: "image/webp",
  });
  assert.equal(detectCoverImage(Uint8Array.from([0x3c, 0x73, 0x76, 0x67])), null);
  assert.equal(MAX_COVER_PHOTO_BYTES, 8 * 1024 * 1024);

  const owner = await coverOwnerPrefix("user-123");
  assert.match(owner, /^[0-9a-f]{24}$/);
  assert.equal(validCoverPhotoKey(`cover-drafts/${owner}/8092f8cf-6e7b-4f4b-9e29-56dd684268f2.webp`), true);
  assert.equal(validCoverPhotoKey("cover-drafts/../../secret.jpg"), false);
});

test("private lookup and upload routes keep authentication and same-origin checks", async () => {
  const [lookupRoute, uploadRoute, draftRoute, draftStore, coverStorage, workspace, hosting] = await Promise.all([
    readFile(new URL("../app/api/librarian/isbn-lookup/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/librarian/cover-photo/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/librarian/drafts/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/draft-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/cover-storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/librarian/workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  assert.match(lookupRoute, /authorizeLibrarianApi\(\)/);
  assert.match(lookupRoute, /lookupBookByIsbn/);
  assert.match(uploadRoute, /authorizeLibrarianApi\(\)/);
  assert.match(uploadRoute, /isSameOriginRequest\(request\)/);
  assert.match(uploadRoute, /MAX_COVER_PHOTO_BYTES/);
  assert.match(uploadRoute, /request\.body\.getReader\(\)/);
  assert.match(uploadRoute, /MAX_COVER_UPLOAD_REQUEST_BYTES/);
  assert.match(uploadRoute, /invalid_content_length/);
  assert.match(uploadRoute, /new Request\(request\.url/);
  assert.match(uploadRoute, /ownerUserId/);
  assert.match(uploadRoute, /activeDraftReferencesCoverPhoto/);
  assert.match(uploadRoute, /cover_in_use/);
  assert.match(draftRoute, /verifyOwnedCoverPhoto/);
  assert.match(draftRoute, /action === "submit"/);
  assert.match(draftStore, /json_extract\(\$\{librarianDrafts\.payloadJson\}, '\$\.coverPhotoKey'\)/);
  assert.match(draftStore, /json_extract\(\$\{librarianDrafts\.payloadJson\}, '\$\.changes\.coverPhotoKey'\)/);
  assert.match(coverStorage, /bucket\.head\(key\)/);
  assert.match(coverStorage, /object\.customMetadata\?\.ownerUserId !== userId/);
  assert.match(coverStorage, /readOwnedCoverAttachment/);
  assert.match(coverStorage, /readStoredCoverBytes\(object, 900 \* 1024\)/);
  assert.match(coverStorage, /detectCoverImage/);
  assert.match(coverStorage, /jpegDimensions/);
  assert.match(workspace, /\/api\/librarian\/isbn-lookup\?isbn=/);
  assert.match(workspace, /\/api\/librarian\/cover-photo/);
  assert.match(workspace, /name="coverConfirmed"/);
  assert.match(workspace, /За ISBN нічого не знайдено/);
  assert.equal(hosting.r2, "COVER_UPLOADS");
});

test("private reference data uses signed POST and never extends the public PII API", async () => {
  const [appsScript, gateway, route, publicApi] = await Promise.all([
    readFile(new URL("../apps-script/LibrarianGateway.gs", import.meta.url), "utf8"),
    readFile(new URL("../lib/sheets-gateway.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/librarian/reference-data/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../apps-script/PublicCatalogApi.gs", import.meta.url), "utf8"),
  ]);

  assert.doesNotThrow(() => new Function(appsScript));
  assert.match(appsScript, /function doPost\(e\)/);
  assert.match(appsScript, /computeHmacSha256Signature/);
  assert.match(appsScript, /CacheService\.getScriptCache\(\)/);
  assert.match(appsScript, /SHEETS_GATEWAY_SECRET/);
  assert.match(appsScript, /Користувачі/);
  assert.match(appsScript, /return \{ id: row\[0\], name: row\[1\], role: row\[2\], status: row\[5\] \}/);
  assert.doesNotMatch(appsScript, /email\s*:/i);
  assert.match(gateway, /crypto\.subtle\.sign\("HMAC"/);
  assert.match(gateway, /script\\\.google\\\.com/);
  assert.match(route, /authorizeLibrarianApi\(\)/);
  assert.match(route, /fetchLibrarianReferenceData/);
  assert.doesNotMatch(
    publicApi,
    /requiredSheet_\(spreadsheet, "(?:Користувачі|Класи за роками|Навчальні роки)"\)/,
  );
});
