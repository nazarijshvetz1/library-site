export type DraftApplyClaimDecision =
  | "claim"
  | "replay_pending"
  | "already_applied"
  | "revision_conflict"
  | "request_conflict"
  | "locked";

export type DraftApplyReturnDecision =
  | "return_for_changes"
  | "already_returned"
  | "revision_conflict"
  | "request_conflict"
  | "locked";

export function draftApplyClaimDecision(input: {
  status: string;
  currentRevision: number;
  expectedRevision: number;
  requestedId?: string;
  metadata: { requestId: string; sourceRevision: number } | null;
}): DraftApplyClaimDecision {
  const resumable = input.status === "approved_pending_apply"
    || input.status === "applied";
  if (resumable && input.metadata) {
    const idempotentRevision = input.expectedRevision === input.currentRevision
      || input.expectedRevision === input.metadata.sourceRevision;
    if (!idempotentRevision) return "revision_conflict";
    if (input.requestedId && input.requestedId !== input.metadata.requestId) {
      return "request_conflict";
    }
    return input.status === "applied" ? "already_applied" : "replay_pending";
  }
  if (input.status === "approved_pending_apply") return "request_conflict";
  if (input.currentRevision !== input.expectedRevision) return "revision_conflict";
  if (input.status !== "ready_for_review") return "locked";
  return "claim";
}

export function draftApplyReturnDecision(input: {
  status: string;
  currentRevision: number;
  expectedRevision: number;
  requestId: string;
  metadata: {
    requestId: string;
    outcome?: string;
  } | null;
}): DraftApplyReturnDecision {
  if (!input.metadata || input.metadata.requestId !== input.requestId) {
    return "request_conflict";
  }
  if (
    input.status === "draft"
    && input.metadata.outcome === "returned_for_changes"
  ) return "already_returned";
  if (input.currentRevision !== input.expectedRevision) return "revision_conflict";
  if (input.status !== "approved_pending_apply") return "locked";
  return "return_for_changes";
}
