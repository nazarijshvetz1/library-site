import { and, eq, sql } from "drizzle-orm";

import type { ChatGPTUser } from "@/app/chatgpt-auth";
import { getDb } from "@/db";
import { librarianDraftEvents, librarianDrafts } from "@/db/schema";
import { guardedDraftEventValues } from "@/lib/draft-event";
import {
  draftApplyClaimDecision,
  draftApplyReturnDecision,
} from "@/lib/draft-apply-state";
import {
  DraftConflictError,
  DraftLockedError,
  DraftNotFoundError,
  type LibrarianDraft,
} from "@/lib/draft-store";

type DraftRow = typeof librarianDrafts.$inferSelect;

type ApplyMetadata = {
  version: 1;
  requestId: string;
  sourceRevision: number;
  requestedAt: string;
  completedAt?: string;
  outcome?: "applied" | "failed" | "returned_for_changes";
  code?: string;
  message?: string;
  result?: Record<string, unknown>;
};

export type DraftApplyClaim = {
  draft: LibrarianDraft;
  requestId: string;
  sourceRevision: number;
  alreadyApplied: boolean;
  persistedResult: Record<string, unknown> | null;
};

export class DraftApplyRequestConflictError extends Error {
  constructor() {
    super("A different apply request already owns this draft");
    this.name = "DraftApplyRequestConflictError";
  }
}

function presentDraft(row: DraftRow): LibrarianDraft {
  const payload: unknown = JSON.parse(row.payloadJson);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Stored draft payload is invalid");
  }
  return {
    id: row.id,
    kind: row.kind,
    payload: payload as Record<string, unknown>,
    schemaVersion: row.schemaVersion,
    revision: row.revision,
    status: row.status,
    groupId: row.groupId,
    targetKey: row.targetKey,
    submittedAt: row.submittedAt,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function encodeApplyMetadata(metadata: ApplyMetadata): string {
  return JSON.stringify(metadata);
}

function parseApplyMetadata(value: string | null): ApplyMetadata | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const candidate = parsed as {
      version?: unknown;
      requestId?: unknown;
      sourceRevision?: unknown;
    };
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      candidate.version !== 1 ||
      typeof candidate.requestId !== "string" ||
      typeof candidate.sourceRevision !== "number" ||
      !Number.isInteger(candidate.sourceRevision)
    ) {
      return null;
    }
    return parsed as ApplyMetadata;
  } catch {
    return null;
  }
}

async function ownedDraftRow(user: ChatGPTUser, id: string): Promise<DraftRow> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(librarianDrafts)
    .where(eq(librarianDrafts.id, id))
    .limit(1);
  if (!row || row.ownerUserId !== user.userId) throw new DraftNotFoundError();
  return row;
}

function existingClaimOrThrow(
  row: DraftRow,
  metadata: ApplyMetadata | null,
  expectedRevision: number,
  requestedId?: string,
): DraftApplyClaim | null {
  const decision = draftApplyClaimDecision({
    status: row.status,
    currentRevision: row.revision,
    expectedRevision,
    requestedId,
    metadata,
  });
  if (decision === "revision_conflict") throw new DraftConflictError(row.revision);
  if (decision === "request_conflict") throw new DraftApplyRequestConflictError();
  if (decision === "locked") throw new DraftLockedError(row.status);
  if (decision === "claim") return null;
  if (!metadata) throw new DraftApplyRequestConflictError();
  return {
    draft: presentDraft(row),
    requestId: metadata.requestId,
    sourceRevision: metadata.sourceRevision,
    alreadyApplied: decision === "already_applied",
    persistedResult:
      decision === "already_applied"
      && typeof metadata.result === "object"
      && metadata.result !== null
      && !Array.isArray(metadata.result)
        ? metadata.result
        : null,
  };
}

function returnDecisionOrThrow(
  row: DraftRow,
  metadata: ApplyMetadata | null,
  expectedRevision: number,
  requestId: string,
): "return_for_changes" | "already_returned" {
  const decision = draftApplyReturnDecision({
    status: row.status,
    currentRevision: row.revision,
    expectedRevision,
    requestId,
    metadata,
  });
  if (decision === "revision_conflict") throw new DraftConflictError(row.revision);
  if (decision === "request_conflict") throw new DraftApplyRequestConflictError();
  if (decision === "locked") throw new DraftLockedError(row.status);
  return decision;
}

export async function beginDraftApply(
  user: ChatGPTUser,
  id: string,
  expectedRevision: number,
  requestedId?: string,
): Promise<DraftApplyClaim> {
  const db = getDb();
  const now = new Date().toISOString();
  const requestId = requestedId || crypto.randomUUID();
  const metadata: ApplyMetadata = {
    version: 1,
    requestId,
    sourceRevision: expectedRevision,
    requestedAt: now,
  };
  const existing = await ownedDraftRow(user, id);
  const existingMetadata = parseApplyMetadata(existing.reviewNote);
  const existingClaim = existingClaimOrThrow(
    existing,
    existingMetadata,
    expectedRevision,
    requestedId,
  );
  if (existingClaim) return existingClaim;

  let batchError: unknown;
  try {
    const [claimedRows] = await db.batch([
      db
        .update(librarianDrafts)
        .set({
          status: "approved_pending_apply",
          revision: sql`${librarianDrafts.revision} + 1`,
          reviewedAt: now,
          reviewedByUserId: user.userId,
          reviewedByEmail: user.email,
          reviewNote: encodeApplyMetadata(metadata),
          updatedByUserId: user.userId,
          updatedByEmail: user.email,
          updatedAt: now,
        })
        .where(
          and(
            eq(librarianDrafts.id, id),
            eq(librarianDrafts.ownerUserId, user.userId),
            eq(librarianDrafts.status, "ready_for_review"),
            eq(librarianDrafts.revision, expectedRevision),
          ),
        )
        .returning(),
      db.insert(librarianDraftEvents).values(
        guardedDraftEventValues({
          draftId: id,
          user,
          action: "approved",
          fromStatus: "ready_for_review",
          toStatus: "approved_pending_apply",
          revision: expectedRevision + 1,
          createdAt: now,
        }),
      ),
    ]);
    const claimed = claimedRows[0];
    if (!claimed) throw new Error("Draft apply claim did not return a row");
    return {
      draft: presentDraft(claimed),
      requestId,
      sourceRevision: expectedRevision,
      alreadyApplied: false,
      persistedResult: null,
    };
  } catch (error) {
    batchError = error;
  }

  const current = await ownedDraftRow(user, id);
  const currentMetadata = parseApplyMetadata(current.reviewNote);
  const currentClaim = existingClaimOrThrow(
    current,
    currentMetadata,
    expectedRevision,
    requestedId,
  );
  if (currentClaim) return currentClaim;
  throw batchError;
}

export async function completeDraftApply(
  user: ChatGPTUser,
  id: string,
  expectedRevision: number,
  requestId: string,
  result: Record<string, unknown>,
): Promise<LibrarianDraft> {
  return finishDraftApply(
    user,
    id,
    expectedRevision,
    requestId,
    "applied",
    { result },
  );
}

export async function failDraftApply(
  user: ChatGPTUser,
  id: string,
  expectedRevision: number,
  requestId: string,
  code: string,
  message: string,
): Promise<LibrarianDraft> {
  return finishDraftApply(
    user,
    id,
    expectedRevision,
    requestId,
    "failed",
    { code: code.slice(0, 80), message: message.slice(0, 500) },
  );
}

export async function returnDraftApplyForChanges(
  user: ChatGPTUser,
  id: string,
  expectedRevision: number,
  requestId: string,
  code: string,
  message: string,
): Promise<LibrarianDraft> {
  const db = getDb();
  const existing = await ownedDraftRow(user, id);
  const metadata = parseApplyMetadata(existing.reviewNote);
  const decision = returnDecisionOrThrow(
    existing,
    metadata,
    expectedRevision,
    requestId,
  );
  if (decision === "already_returned") return presentDraft(existing);
  if (!metadata) throw new DraftApplyRequestConflictError();

  const now = new Date().toISOString();
  const reviewNote = encodeApplyMetadata({
    ...metadata,
    completedAt: now,
    outcome: "returned_for_changes",
    code: code.slice(0, 80),
    message: message.slice(0, 500),
  });
  let batchError: unknown;
  try {
    const [updatedRows] = await db.batch([
      db
        .update(librarianDrafts)
        .set({
          status: "draft",
          revision: sql`${librarianDrafts.revision} + 1`,
          submittedAt: null,
          reviewedAt: null,
          reviewedByUserId: null,
          reviewedByEmail: null,
          reviewNote,
          updatedByUserId: user.userId,
          updatedByEmail: user.email,
          updatedAt: now,
        })
        .where(
          and(
            eq(librarianDrafts.id, id),
            eq(librarianDrafts.ownerUserId, user.userId),
            eq(librarianDrafts.status, "approved_pending_apply"),
            eq(librarianDrafts.revision, expectedRevision),
            eq(librarianDrafts.reviewNote, existing.reviewNote!),
          ),
        )
        .returning(),
      db.insert(librarianDraftEvents).values(
        guardedDraftEventValues({
          draftId: id,
          user,
          action: "returned_for_changes",
          fromStatus: "approved_pending_apply",
          toStatus: "draft",
          revision: expectedRevision + 1,
          createdAt: now,
        }),
      ),
    ]);
    const updated = updatedRows[0];
    if (!updated) throw new Error("Returned draft did not return a row");
    return presentDraft(updated);
  } catch (error) {
    batchError = error;
  }

  const current = await ownedDraftRow(user, id);
  const currentMetadata = parseApplyMetadata(current.reviewNote);
  const currentDecision = returnDecisionOrThrow(
    current,
    currentMetadata,
    expectedRevision,
    requestId,
  );
  if (currentDecision === "already_returned") return presentDraft(current);
  if (current.reviewNote !== existing.reviewNote) throw new DraftApplyRequestConflictError();
  throw batchError;
}

async function finishDraftApply(
  user: ChatGPTUser,
  id: string,
  expectedRevision: number,
  requestId: string,
  outcome: "applied" | "failed",
  details: Pick<ApplyMetadata, "code" | "message" | "result">,
): Promise<LibrarianDraft> {
  const db = getDb();
  const existing = await ownedDraftRow(user, id);
  const metadata = parseApplyMetadata(existing.reviewNote);
  if (!metadata || metadata.requestId !== requestId) {
    throw new DraftApplyRequestConflictError();
  }
  if (existing.status === outcome) return presentDraft(existing);
  if (existing.revision !== expectedRevision) {
    throw new DraftConflictError(existing.revision);
  }
  if (existing.status !== "approved_pending_apply") {
    throw new DraftLockedError(existing.status);
  }

  const now = new Date().toISOString();
  const reviewNote = encodeApplyMetadata({
    ...metadata,
    completedAt: now,
    outcome,
    ...details,
  });
  let batchError: unknown;
  try {
    const [updatedRows] = await db.batch([
      db
        .update(librarianDrafts)
        .set({
          status: outcome,
          revision: sql`${librarianDrafts.revision} + 1`,
          reviewNote,
          updatedByUserId: user.userId,
          updatedByEmail: user.email,
          updatedAt: now,
        })
        .where(
          and(
            eq(librarianDrafts.id, id),
            eq(librarianDrafts.ownerUserId, user.userId),
            eq(librarianDrafts.status, "approved_pending_apply"),
            eq(librarianDrafts.revision, expectedRevision),
            eq(librarianDrafts.reviewNote, existing.reviewNote!),
          ),
        )
        .returning(),
      db.insert(librarianDraftEvents).values(
        guardedDraftEventValues({
          draftId: id,
          user,
          action: outcome,
          fromStatus: "approved_pending_apply",
          toStatus: outcome,
          revision: expectedRevision + 1,
          createdAt: now,
        }),
      ),
    ]);
    const updated = updatedRows[0];
    if (!updated) throw new Error("Draft apply result did not return a row");
    return presentDraft(updated);
  } catch (error) {
    batchError = error;
  }

  const current = await ownedDraftRow(user, id);
  const currentMetadata = parseApplyMetadata(current.reviewNote);
  if (
    current.status === outcome &&
    currentMetadata?.requestId === requestId &&
    currentMetadata.outcome === outcome
  ) {
    return presentDraft(current);
  }
  if (current.revision !== expectedRevision) {
    throw new DraftConflictError(current.revision);
  }
  if (current.status !== "approved_pending_apply") {
    throw new DraftLockedError(current.status);
  }
  if (current.reviewNote !== existing.reviewNote) {
    throw new DraftApplyRequestConflictError();
  }
  throw batchError;
}
