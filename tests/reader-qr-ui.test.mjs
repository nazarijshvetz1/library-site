import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspace = await readFile(new URL("../app/librarian/literature/workspace.tsx", import.meta.url), "utf8");

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
