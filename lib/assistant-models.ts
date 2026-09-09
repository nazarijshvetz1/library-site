export type AssistantModelRole = "teacher" | "librarian";
export type AssistantModelKind = "text" | "realtime";

type RuntimeStringReader = (name: string) => string | null;

export const ASSISTANT_MODEL_DEFAULTS = Object.freeze({
  teacher: Object.freeze({
    text: "gpt-5.4-mini",
    realtime: "gpt-realtime-mini",
  }),
  librarian: Object.freeze({
    text: "gpt-6-astra",
    realtime: "gpt-realtime-2.1",
  }),
});

const ROLE_MODEL_VARIABLES = Object.freeze({
  teacher: Object.freeze({
    text: "ASSISTANT_TEACHER_TEXT_MODEL",
    realtime: "ASSISTANT_TEACHER_REALTIME_MODEL",
  }),
  librarian: Object.freeze({
    text: "ASSISTANT_LIBRARIAN_TEXT_MODEL",
    realtime: "ASSISTANT_LIBRARIAN_REALTIME_MODEL",
  }),
});

const LEGACY_TEACHER_MODEL_VARIABLES = Object.freeze({
  text: "ASSISTANT_TEXT_MODEL",
  realtime: "ASSISTANT_REALTIME_MODEL",
});

export function assistantModel(
  role: AssistantModelRole,
  kind: AssistantModelKind,
  readRuntimeString: RuntimeStringReader,
): string {
  const roleSpecific = readRuntimeString(ROLE_MODEL_VARIABLES[role][kind]);
  if (roleSpecific) return roleSpecific;

  // The original shared variables remain a compatibility fallback for the
  // teacher. They intentionally do not override Jarvis's stronger defaults.
  if (role === "teacher") {
    const legacy = readRuntimeString(LEGACY_TEACHER_MODEL_VARIABLES[kind]);
    if (legacy) return legacy;
  }

  return ASSISTANT_MODEL_DEFAULTS[role][kind];
}
