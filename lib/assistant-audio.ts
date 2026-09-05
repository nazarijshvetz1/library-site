export type AssistantAudioMode = "natural" | "noisy" | "manual";
export type AssistantMicrophone = "speaker" | "headset";

export function assistantAudioInput(mode: AssistantAudioMode, microphone: AssistantMicrophone) {
  return {
    noise_reduction: { type: microphone === "headset" ? "near_field" : "far_field" },
    transcription: { model: "gpt-4o-mini-transcribe", language: "uk" },
    turn_detection: mode === "manual" ? null : mode === "noisy"
      ? { type: "server_vad", threshold: 0.75, prefix_padding_ms: 350, silence_duration_ms: 800, interrupt_response: false, create_response: true }
      : { type: "semantic_vad", eagerness: "low", interrupt_response: true, create_response: true },
  };
}

// Track gating is separate from VAD: ambient audio is not sent while paused.
export function assistantMicEnabled(mode: AssistantAudioMode, paused: boolean, speaking: boolean, manualRecording: boolean) {
  return !paused && (mode === "manual" ? manualRecording : mode !== "noisy" || !speaking);
}
