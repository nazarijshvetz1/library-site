import { and, eq, sql } from "drizzle-orm";

import type { ChatGPTUser } from "@/app/chatgpt-auth";
import { getDb } from "@/db";
import { librarianDrafts } from "@/db/schema";
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
  outcome?: "applied" | "failed";
  code?: string;
  message?: string;
  result?: Record<string, unknown>;
};

export type DraftApplyClaim = {
  draft: LibrarianDraft;
  requestId: string;
  sourceRevision: number;
  alreadyApplied: boolean;
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
  const [claimed] = await db
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
    .returning();

  if (claimed) {
    return {
      draft: presentDraft(claimed),
      requestId,
      sourceRevision: expectedRevision,
      alreadyApplied: false,
    };
  }

  const existing = await ownedDraftRow(user, id);
  const existingMetadata = parseApplyMetadata(existing.reviewNote);
  if (existingMetadata &&
      (existing.status === "approved_pending_apply" || existing.status === "applied")) {
    const isIdempotentRevision =
      expectedRevision === existing.revision ||
      expectedRevision === existingMetadata.sourceRevision;
    if (!isIdempotentRevision) throw new DraftConflictError(existing.revision);
    if (existing.status === "approved_pending_apply" || existing.status === "applied") {
      return {
        draft: presentDraft(existing),
        requestId: existingMetadata.requestId,
        sourceRevision: existingMetadata.sourceRevision,
        alreadyApplied: existing.status === "applied",
      };
    }
  }
  if (existing.status === "approved_pending_apply") {
    throw new DraftApplyRequestConflictError();
  }
  if (existing.revision !== expectedRevision) {
    throw new DraftConflictError(existing.revision);
  }
  throw new DraftLockedError(existing.status);
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
  const [updated] = await db
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
    .returning();
  if (updated) return presentDraft(updated);

  const current = await ownedDraftRow(user, id);
  if (current.revision !== expectedRevision) {
    throw new DraftConflictError(current.revision);
  }
  throw new DraftLockedError(current.status);
}
