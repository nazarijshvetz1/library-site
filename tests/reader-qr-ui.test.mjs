import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspace = await readFile(new URL("../app/librarian/literature/workspace.tsx", import.meta.url), "utf8");
const readerPortal = await readFile(new URL("../app/reader/reader-portal.tsx", import.meta.url), "utf8");
const readerAccess = await readFile(new URL("../app/librarian/literature/reader-access.tsx", import.meta.url), "utf8");

test("reader Telegram login captures launch data before removing the private invitation from the address", () => {
  const capture = readerPortal.indexOf("telegramInitData.current=app.initData");
  const clearAddress = readerPortal.indexOf("window.history.replaceState");
  assert.ok(capture >= 0, "Telegram initData must be captured in memory");
  assert.ok(clearAddress > capture, "Telegram initData must be captured before the hash is cleared");
  assert.match(readerPortal, /telegramInitData=useRef\(""\)/u);
  assert.match(readerPortal, /Так, це мій профіль — підключити/u);
  assert.match(readerPortal, /!telegram&&<><label className=\{s\.check\}>/u);
  assert.match(readerPortal, /Відкрити запрошення через бота/u);
  assert.match(readerPortal, /\?start=ra_/u);
  assert.match(readerPortal, /Telegram залишиться підключеним|Після першого підключення/u);
});

test("student web login uses a private directory selection, temporary code and mandatory four-digit PIN",()=>{
  assert.match(readerPortal,/\/api\/reader\/directory\?q=/u);
  assert.match(readerPortal,/normalized\.length<3/u);
  assert.match(readerPortal,/selected\.loginId/u);
  assert.match(readerPortal,/action:"login"/u);
  assert.match(readerPortal,/action:"set_pin"/u);
  assert.match(readerPortal,/Введіть щонайменше 3 літери/u);
  assert.match(readerPortal,/Тимчасовий код або PIN/u);
  assert.match(readerPortal,/Створити PIN і увійти/u);
  assert.match(readerPortal,/Читацький номер, телефон та інші особисті дані не показуються/u);
  assert.doesNotMatch(readerPortal,/localStorage|sessionStorage/u);
});

test("librarian creates one web access package and keeps Telegram invitation separate",()=>{
  assert.match(workspace,/ReaderAccess/u);
  assert.match(readerAccess,/action:string/u);
  assert.match(readerAccess,/"web_access"/u);
  assert.match(readerAccess,/Тимчасовий код/u);
  assert.match(readerAccess,/QR для Telegram/u);
  assert.match(readerAccess,/Telegram залишиться підключеним/u);
});
