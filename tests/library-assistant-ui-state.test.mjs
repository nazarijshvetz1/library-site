import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/_components/library-assistant.tsx", import.meta.url), "utf8");
const start = source.indexOf("  async function finishAction(");
const handler = ts.transpileModule(source.slice(start, source.indexOf("\n  async function addCardToCart", start)), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test("late cancellation cannot clear a new action, receipt, or operation lock after reopening", async () => {
  let resolve;
  const reply = new Promise((done) => { resolve = done; });
  const generation = { current: 1 }, operationLock = { current: false }, actionRequest = { current: null };
  let stored = "A", busy = false, preview = "A";
  const mocks = {
    actionPreview: { id: "A", title: "Action A", lines: [] }, operationLock, consentChange: { current: null }, generation, actionRequest,
    actionPendingRef: { current: false }, api: () => reply,
    cartRef: { current: null }, applyActionReceipt: () => {},
    clearStoredAction: (id) => { if (stored === id) stored = null; },
    setBusy: (value) => { busy = value; }, setActionPreview: (value) => { preview = value; },
    setActionPending: () => {}, setNotice: () => {}, append: () => {}, channel: { current: null },
    window: { dispatchEvent() {} }, AssistantApiError: class extends Error {}, CustomEvent: class {},
  };
  const finish = new Function(...Object.keys(mocks), `${handler}; return finishAction;`)(...Object.values(mocks));
  const pending = finish(false);
  assert.equal(busy, true);
  generation.current = 2; stored = "B"; preview = "B"; actionRequest.current = "B"; operationLock.current = true;
  resolve({ success: true, message: "Cancelled A" });
  await pending;
  assert.equal(stored, "B"); assert.equal(preview, "B"); assert.equal(busy, true);
  assert.equal(operationLock.current, true); assert.equal(actionRequest.current, "B");
});

test("pending action restores canonical server preview and never trusts cached review text", () => {
  assert.match(source, /api\("action_status", \{ draftId: id \}\)/u);
  assert.match(source, /JSON\.stringify\(\{ id: draft\.id \}\)/u);
  assert.doesNotMatch(source, /setActionPreview\(stored\)/u);
});

test("failed consent revocation is retained even after closing and reopening the panel", async () => {
  const begin = source.indexOf("  async function changeConsent(");
  const code = ts.transpileModule(source.slice(begin, source.indexOf("\n  async function finishOwnSessions", begin)), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let reject;
  const pending = new Promise((_, fail) => { reject = fail; });
  const generation = { current: 1 }, revokeIntent = { current: false }, consentChange = { current: null };
  let consent = true, revokeFailed = false;
  const mocks = { generation, revokeIntent, consentChange, consentInfo: null, checking: false,
    stop() { generation.current++; }, api: () => pending,
    setConsent: (value) => { consent = value; }, setRevokeFailed: (value) => { revokeFailed = value; },
    setSavingConsent() {}, setNotice() {}, setConsentInfo() {}, setPreview() {}, setActionPreview() {},
    pendingRef: { current: false }, actionPendingRef: { current: false },
  };
  const change = new Function(...Object.keys(mocks), `${code}; return changeConsent;`)(...Object.values(mocks));
  const result = change(false);
  generation.current++; // panel closes while the server response is still pending
  reject(new Error("network unavailable"));
  await result;
  assert.equal(revokeIntent.current, true); assert.equal(revokeFailed, true); assert.equal(consent, false);
  assert.match(source, /setConsent\(reply\.consent\.accepted && !revokeIntent\.current\)/u);
});
