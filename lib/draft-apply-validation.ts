import {
  DRAFT_KINDS,
  isDraftId,
  type DraftKind,
} from "./draft-validation.ts";

export const SUPPORTED_DRAFT_APPLY_KINDS = DRAFT_KINDS satisfies readonly DraftKind[];

export type DraftApplyInput = {
  id: string;
  revision: number;
};

export type DraftApplyValidationResult =
  | { ok: true; value: DraftApplyInput }
  | { ok: false; fieldErrors: Record<string, string> };

export function isSupportedDraftApplyKind(
  kind: DraftKind,
): kind is (typeof SUPPORTED_DRAFT_APPLY_KINDS)[number] {
  return (SUPPORTED_DRAFT_APPLY_KINDS as readonly string[]).includes(kind);
}

export function validateDraftApplyInput(
  input: Record<string, unknown>,
): DraftApplyValidationResult {
  const fieldErrors: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (!["id", "revision"].includes(key)) {
      fieldErrors[key] = "Непідтримуване поле.";
    }
  }

  const id = typeof input.id === "string" ? input.id.trim() : "";
  const revision = typeof input.revision === "number"
    ? input.revision
    : Number.NaN;

  if (!isDraftId(id)) {
    fieldErrors.id = "Некоректний ідентифікатор чернетки.";
  }
  if (!Number.isInteger(revision) || revision < 1 || revision > 1_000_000_000) {
    fieldErrors.revision = "Вкажіть актуальний номер ревізії чернетки.";
  }

  return Object.keys(fieldErrors).length > 0
    ? { ok: false, fieldErrors }
    : {
        ok: true,
        value: {
          id,
          revision,
        },
      };
}
