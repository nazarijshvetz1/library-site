import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { assistantAudioInput, assistantMicEnabled } from "../lib/assistant-audio.ts";
import { cartSignature, parseAssistantCart } from "../lib/teacher-cart.ts";
import { telephoneHref } from "../lib/telephone.ts";

const source = await readFile(new URL("../app/_components/library-assistant.tsx", import.meta.url), "utf8");
function extract(start, end, mocks, fn) {
  const code = ts.transpileModule(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(mocks), `${code}; return ${fn};`)(...Object.values(mocks));
}
test("voice presets separate semantic timing, noise threshold and manual commit", () => {
  assert.equal(assistantAudioInput("natural", "headset").turn_detection.type, "semantic_vad");
  assert.equal(assistantAudioInput("noisy", "speaker").turn_detection.threshold, 0.75);
  assert.equal(assistantAudioInput("noisy", "speaker").turn_detection.interrupt_response, false);
  assert.equal(assistantAudioInput("noisy", "speaker").noise_reduction.type, "far_field");
  assert.equal(assistantAudioInput("natural", "headset").noise_reduction.type, "near_field");
  assert.equal(assistantAudioInput("manual", "speaker").turn_detection, null);
  for (const mode of ["natural", "noisy", "manual"]) assert.equal(assistantMicEnabled(mode, true, false, true), false);
  assert.equal(assistantMicEnabled("noisy", false, true, false), false);
  assert.equal(assistantMicEnabled("noisy", false, false, false), true);
  assert.equal(assistantMicEnabled("manual", false, false, false), false);
  assert.equal(assistantMicEnabled("manual", false, false, true), true);
});
test("microphone stays disabled during hidden startup and unacknowledged audio configuration", () => {
  const track = { enabled: true };
  const visibleRef = { current: false }, audioConfig = { current: null };
  const audioControl = { current: { mode: "natural", paused: false, speaking: false, recording: false } };
  const document = { hidden: false };
  const sync = extract("  function syncMicrophone()", "  function discardVoiceInput()", { audioControl, audioConfig, visibleRef, document, assistantMicEnabled, stream: { current: { getAudioTracks: () => [track] } } }, "syncMicrophone");
  sync(); assert.equal(track.enabled, false);
  visibleRef.current = true; sync(); assert.equal(track.enabled, true);
  document.hidden = true; sync(); assert.equal(track.enabled, false);
  document.hidden = false; audioConfig.current = { mode: "manual" }; sync(); assert.equal(track.enabled, false);
  audioConfig.current = null; audioControl.current.mode = "noisy"; audioControl.current.speaking = true; sync(); assert.equal(track.enabled, false);
});
test("manual turn resumes audio but does not request response before commit acknowledgement", () => {
  let played = 0, now = 1000, phase = ""; const sent = [];
  const audioControl = { current: { mode: "manual", paused: true, recording: false, started: 0 } }, commitPending = { current: false };
  const toggle = extract("  function toggleRecording()", "  function clearStoredAction", {
    channel: { current: { readyState: "open", send: (s) => sent.push(JSON.parse(s)) } }, audioControl, audioConfig: { current: null }, visibleRef: { current: true },
    audio: { current: { play: () => { played++; return Promise.resolve(); } } }, discardVoiceInput() {}, syncMicrophone() {},
    setMuted() {}, setRecording() {}, setPhase: v => { phase = v; }, performance: { now: () => now }, commitPending,
  }, "toggleRecording");
  toggle(); assert.equal(played, 1); assert.equal(audioControl.current.recording, true);
  now += 1200; toggle(); assert.equal(audioControl.current.recording, false);
  assert.deepEqual(sent, [{ type: "input_audio_buffer.commit" }]); assert.equal(commitPending.current, true);
  assert.equal(phase, "Перевіряю запит");
  assert.match(source, /input_audio_buffer\.committed" && commitPending\.current/u);
});
test("discarded voice work invalidates the current turn and clears both audio buffers", () => {
  const events = [], turnEpoch = { current: 4 }, commitPending = { current: true };
  const discard = extract("  function discardVoiceInput()", "  function pauseMicrophone", {
    channel: { current: { readyState: "open", send: s => events.push(JSON.parse(s).type) } }, turnEpoch, commitPending,
    responseQueued: { current: true }, responseActive: { current: true },
  }, "discardVoiceInput");
  discard(); assert.equal(turnEpoch.current, 5); assert.equal(commitPending.current, false);
  assert.deepEqual(events, ["response.cancel", "output_audio_buffer.clear", "input_audio_buffer.clear"]);
  assert.match(source, /if \(epoch !== turnEpoch\.current\) return;/u);
});
test("cart signature is order independent and rejects malformed duplicate or cross-purpose input", () => {
  const cart = { items: [{ materialId: "CAT-0001", quantity: 2 }, { materialId: "CAT-0002", quantity: 1 }], notes: "  Урок  " };
  assert.equal(cartSignature(cart), cartSignature({ items: [...cart.items].reverse(), notes: "Урок" }));
  assert.deepEqual(parseAssistantCart(cart), cart);
  assert.throws(() => parseAssistantCart({ items: [cart.items[0], cart.items[0]], notes: "" }));
  assert.throws(() => parseAssistantCart({ items: [{ materialId: "USR-other", quantity: 1 }], notes: "" }));
  assert.throws(() => parseAssistantCart({ items: [{ materialId: "CAT-0001", quantity: 0 }], notes: "" }));
});
test("telephone links preserve dialable numbers, never turn contact notes or email into calls", () => {
  assert.equal(telephoneHref("+380 (67) 123-45-67"), "tel:+380671234567");
  assert.equal(telephoneHref("067 123 45 67"), "tel:0671234567");
  assert.equal(telephoneHref("Кабінет 205, телефон 123"), undefined);
  assert.equal(telephoneHref("teacher@example.test"), undefined);
  assert.equal(telephoneHref("123"), undefined);
});
test("teacher uses embedded assistant and both librarian pickers keep touch selection intact", async () => {
  const workspace = await readFile(new URL("../app/visits/visit-booking-workspace.tsx", import.meta.url), "utf8");
  const librarian = await readFile(new URL("../app/librarian/d1-workspace.tsx", import.meta.url), "utf8");
  assert.equal((workspace.match(/<LibraryAssistant /gu) ?? []).length, 1);
  assert.match(workspace, /embedded visible=\{activeTab === "assistant"\} cartBridge=\{sharedCart.bridge\}/u);
  assert.match(workspace, /library:assistant-action-completed", refreshAfterAction/u);
  assert.match(workspace, /const refreshAfterAction = \(\) => \{ void load\(true\); void loadProfile\(\); \}/u);
  assert.match(librarian, /onPointerDown=\{\(event\) => event.preventDefault\(\)\}/u);
  assert.doesNotMatch(librarian, /onBlur=\{\(\) => window.setTimeout\(\(\) => setTeacherPickerOpen/u);
  assert.match(librarian, /generation === scannerGeneration.current/u);
  assert.match(librarian, /if \(!isCurrent\(\)\) \{ activeControls.stop\(\); return; \}/u);
});
