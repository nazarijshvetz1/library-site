export type DraftGatewayFailureDisposition =
  | "return_for_changes"
  | "keep_pending"
  | "fail";

const CORRECTABLE_APPLY_FAILURES = new Set([
  "stale_material",
  "stale_class_year",
  "stale_stock",
  "stale_rollover_class",
  "stock_snapshot_missing",
  "insufficient_stock",
  "same_location",
  "duplicate_isbn",
  "duplicate_class_year",
  "duplicate_target_class",
  "duplicate_target_cohort",
  "academic_year_conflict",
  "academic_year_closed",
  "academic_year_not_found",
  "class_year_closed",
  "class_year_completed",
  "class_year_not_found",
  "cohort_closed",
  "cohort_not_found",
  "cohort_still_open",
  "location_not_found",
  "material_not_found",
  "teacher_not_found",
  "incomplete_rollover",
  "rollover_override_required",
  "invalid_rollover_status",
]);

export function draftGatewayFailureDisposition(input: {
  code: string;
  retryable: boolean;
  outcomeKnown: boolean;
}): DraftGatewayFailureDisposition {
  if (input.retryable || !input.outcomeKnown) return "keep_pending";
  if (CORRECTABLE_APPLY_FAILURES.has(input.code)) return "return_for_changes";
  return "fail";
}
