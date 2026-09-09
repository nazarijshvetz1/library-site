import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspace = await readFile(new URL("../app/librarian/literature/workspace.tsx", import.meta.url), "utf8");
const readerPortal = await readFile(new URL("../app/reader/reader-portal.tsx", import.meta.url), "utf8");

test("librarian reader invitations expose a local QR login for web and Telegram", () => {
  assert.match(workspace, /QRCodeWriter/u);
  assert.match(workspace, /BarcodeFormat\.QR_CODE/u);
  assert.match(workspace, /QR-вхід: /u);
  assert.match(workspace, /QR-вхід читача/u);
  assert.match(workspace, /\/reader#invite=/u);
  assert.match(workspace, /start=ra_/u);
  assert.match(workspace, /Завантажити QR/u);
  assert.match(workspace, /inviteRemainingSeconds/u);
  assert.match(workspace, /Покажіть цей код саме учневі або вчителю/u);
});

test("reader Telegram login captures launch data before removing the private invitation from the address", () => {
  const capture = readerPortal.indexOf("telegramInitData.current=app.initData");
  const clearAddress = readerPortal.indexOf("window.history.replaceState");
  assert.ok(capture >= 0, "Telegram initData must be captured in memory");
  assert.ok(clearAddress > capture, "Telegram initData must be captured before the hash is cleared");
  assert.match(readerPortal, /telegramInitData=useRef\(""\)/u);
  assert.match(readerPortal, /Так, це мій профіль — підключити/u);
  assert.match(readerPortal, /!telegram&&<label className=\{s\.check\}>/u);
  assert.match(readerPortal, /Відкрити запрошення через бота/u);
  assert.match(readerPortal, /\?start=ra_/u);
  assert.match(readerPortal, /error&&!needsLogin/u);
});
