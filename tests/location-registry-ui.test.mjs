import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("librarian can manage cabinets without deleting inventory history", async () => {
  const [workspace, store, listRoute, detailRoute] = await Promise.all([
    read("app/librarian/d1-workspace.tsx"),
    read("lib/location-registry-store.ts"),
    read("app/api/librarian/locations/route.ts"),
    read("app/api/librarian/locations/[id]/route.ts"),
  ]);
  assert.match(workspace, /id: "locations"[\s\S]*label: "Кабінети"/u);
  assert.match(workspace, /Додати кабінет/u);
  assert.match(workspace, /Закрити/u);
  assert.match(workspace, /Поновити/u);
  assert.match(workspace, /Видалити/u);
  assert.match(store, /totalReferences === 0/u);
  assert.match(store, /row\.type !== "library"/u);
  assert.match(store, /active_reservations/u);
  assert.match(store, /class_loan_transaction_lines/u);
  assert.match(store, /inventory_transaction_lines/u);
  assert.match(store, /material_request_reservations/u);
  assert.match(store, /expectedUpdatedAt/u);
  for (const route of [listRoute, detailRoute]) assert.match(route, /authorizeLibrarianApi\(\)/u);
  assert.match(listRoute, /isSameOriginRequest\(request\)/u);
  assert.match(detailRoute, /isSameOriginRequest\(request\)/u);
});

test("remote cover loader is authenticated and restricted to book APIs", async () => {
  const route = await read("app/api/librarian/cover-photo/remote/route.ts");
  assert.match(route, /authorizeLibrarianApi\(\)/u);
  assert.match(route, /books\.google\.com/u);
  assert.match(route, /books\.googleusercontent\.com/u);
  assert.match(route, /covers\.openlibrary\.org/u);
  assert.match(route, /redirect: "manual"/u);
  assert.match(route, /MAX_IMAGE_BYTES/u);
  assert.match(route, /response\.body\.getReader\(\)/u);
  assert.match(route, /controller\.abort\(\)/u);
  assert.match(route, /size > MAX_IMAGE_BYTES/u);
  assert.doesNotMatch(route, /yakaboo|pidruchnyk/iu);
});
