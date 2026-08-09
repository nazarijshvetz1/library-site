import { and, desc, eq, inArray, or, sql } from "drizzle-orm";

import type { ChatGPTUser } from "@/app/chatgpt-auth";
import { getDb } from "@/db";
import { librarianDraftEvents, librarianDrafts } from "@/db/schema";
import { guardedDraftEventValues } from "@/lib/draft-event";
import type {
  DraftAction,
  DraftKind,
  DraftStatus,
  ValidatedDraftInput,
} from "@/lib/draft-validation";

const CURRENT_DRAFT_SCHEMA_VERSION = 2;

export type LibrarianDraft = {
  id: string;
  kind: DraftKind;
  payload: Record<string, unknown>;
  schemaVersion: number;
  revision: number;
  status: DraftStatus;
  groupId: string | null;
  targetKey: string | null;
  submittedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export class DraftNotFoundError extends Error {
  constructor() {
    super("Draft not found");
    this.name = "DraftNotFoundError";
  }
}

export class DraftConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super("Draft revision conflict");
    this.name = "DraftConflictError";
    this.currentRevision = currentRevision;
  }
}

export class DraftRevisionRequiredError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super("Draft revision is required");
    this.name = "DraftRevisionRequiredError";
    this.currentRevision = currentRevision;
  }
}

export class DraftLockedError extends Error {
  readonly status: DraftStatus;

  constructor(status: DraftStatus) {
    super("Draft is not editable");
    this.name = "DraftLockedError";
    this.status = status;
  }
}

type DraftRow = typeof librarianDrafts.$inferSelect;

function presentDraft(row: DraftRow): LibrarianDraft {
  const parsed: unknown = JSON.parse(row.payloadJson);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Stored draft payload is invalid");
  }

  return {
    id: row.id,
    kind: row.kind,
    payload: parsed as Record<string, unknown>,
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

function targetKeyFor(input: ValidatedDraftInput): string | null {
  const payload = input.payload;
  const candidates = input.kind === "academic-year.create"
    ? ["label"]
    : input.kind === "academic-year.rollover"
      ? ["targetYearId", "sourceYearId"]
      : input.kind.startsWith("class-year.")
        ? ["classYearId", "academicYearId", "cohortId"]
        : ["materialId"];
  for (const field of candidates) {
    const value = payload[field];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

export async function listDrafts(
  ownerUserId: string,
  id?: string,
): Promise<LibrarianDraft[]> {
  const db = getDb();
  const predicate = id
    ? and(
        eq(librarianDrafts.ownerUserId, ownerUserId),
        eq(librarianDrafts.id, id),
      )
    : eq(librarianDrafts.ownerUserId, ownerUserId);

  const rows = await db
    .select()
    .from(librarianDrafts)
    .where(predicate)
    .orderBy(desc(librarianDrafts.updatedAt))
    .limit(id ? 1 : 100);

  return rows.map(presentDraft);
}

export async function activeDraftReferencesCoverPhoto(
  ownerUserId: string,
  coverPhotoKey: string,
): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: librarianDrafts.id })
    .from(librarianDrafts)
    .where(
      and(
        eq(librarianDrafts.ownerUserId, ownerUserId),
        inArray(librarianDrafts.status, [
          "draft",
          "ready_for_review",
          "approved_pending_apply",
        ]),
        or(
          sql`json_extract(${librarianDrafts.payloadJson}, '$.coverPhotoKey') = ${coverPhotoKey}`,
          sql`json_extract(${librarianDrafts.payloadJson}, '$.changes.coverPhotoKey') = ${coverPhotoKey}`,
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function saveDraft(
  user: ChatGPTUser,
  input: ValidatedDraftInput,
): Promise<{ draft: LibrarianDraft; created: boolean }> {
  const db = getDb();
  const now = new Date().toISOString();
  const payloadJson = JSON.stringify(input.payload);
  const targetKey = targetKeyFor(input);

  if (input.id) {
    const [existing] = await db
      .select()
      .from(librarianDrafts)
      .where(eq(librarianDrafts.id, input.id))
      .limit(1);
    if (existing && existing.ownerUserId !== user.userId) {
      throw new DraftNotFoundError();
    }
    if (existing && existing.status !== "draft") {
      throw new DraftLockedError(existing.status);
    }
    if (existing && input.revision === undefined) {
      const identicalFirstRequest =
        existing.revision === 1 &&
        existing.kind === input.kind &&
        existing.payloadJson === payloadJson &&
        existing.groupId === (input.groupId ?? null) &&
        existing.targetKey === targetKey;
      if (identicalFirstRequest) {
        return { draft: presentDraft(existing), created: false };
      }
      throw new DraftRevisionRequiredError(existing.revision);
    }
    if (existing && existing.revision !== input.revision) {
      throw new DraftConflictError(existing.revision);
    }
    if (!existing && input.revision !== undefined) {
      throw new DraftNotFoundError();
    }

    if (existing) {
      let batchError: unknown;
      try {
        const [updatedRows] = await db.batch([
          db
            .update(librarianDrafts)
            .set({
              ownerEmail: user.email,
              kind: input.kind,
              payloadJson,
              schemaVersion: CURRENT_DRAFT_SCHEMA_VERSION,
              revision: sql`${librarianDrafts.revision} + 1`,
              groupId: input.groupId ?? null,
              targetKey,
              updatedByUserId: user.userId,
              updatedByEmail: user.email,
              updatedAt: now,
            })
            .where(
              and(
                eq(librarianDrafts.id, input.id),
                eq(librarianDrafts.ownerUserId, user.userId),
                eq(librarianDrafts.status, "draft"),
                eq(librarianDrafts.revision, input.revision!),
              ),
            )
            .returning(),
          db.insert(librarianDraftEvents).values(
            guardedDraftEventValues({
              draftId: input.id,
              user,
              action: "updated",
              fromStatus: "draft",
              toStatus: "draft",
              revision: input.revision! + 1,
              createdAt: now,
            }),
          ),
        ]);
        const updated = updatedRows[0];
        if (!updated) throw new Error("Draft update did not return a row");
        return { draft: presentDraft(updated), created: false };
      } catch (error) {
        batchError = error;
      }

      const [current] = await db
        .select({
          ownerUserId: librarianDrafts.ownerUserId,
          revision: librarianDrafts.revision,
          status: librarianDrafts.status,
        })
        .from(librarianDrafts)
        .where(eq(librarianDrafts.id, input.id))
        .limit(1);
      if (!current || current.ownerUserId !== user.userId) {
        throw new DraftNotFoundError();
      }
      if (current.status !== "draft") throw new DraftLockedError(current.status);
      if (current.revision !== input.revision) {
        throw new DraftConflictError(current.revision);
      }
      throw batchError;
    }

    try {
      const [createdRows] = await db.batch([
        db
          .insert(librarianDrafts)
          .values({
            id: input.id,
            ownerUserId: user.userId,
            ownerEmail: user.email,
            kind: input.kind,
            payloadJson,
            schemaVersion: CURRENT_DRAFT_SCHEMA_VERSION,
            revision: 1,
            status: "draft",
            groupId: input.groupId ?? null,
            targetKey,
            updatedByUserId: user.userId,
            updatedByEmail: user.email,
            createdAt: now,
            updatedAt: now,
          })
          .returning(),
        db.insert(librarianDraftEvents).values(
          guardedDraftEventValues({
            draftId: input.id,
            user,
            action: "created",
            fromStatus: null,
            toStatus: "draft",
            revision: 1,
            createdAt: now,
          }),
        ),
      ]);
      const createdWithClientId = createdRows[0];
      if (!createdWithClientId) {
        throw new Error("Draft insert did not return a row");
      }
      return { draft: presentDraft(createdWithClientId), created: true };
    } catch (error) {
      const [raced] = await db
        .select()
        .from(librarianDrafts)
        .where(eq(librarianDrafts.id, input.id))
        .limit(1);
      if (!raced) throw error;
      if (raced.ownerUserId !== user.userId) throw new DraftNotFoundError();
      const identicalFirstRequest =
        raced.revision === 1 &&
        raced.status === "draft" &&
        raced.kind === input.kind &&
        raced.payloadJson === payloadJson &&
        raced.groupId === (input.groupId ?? null) &&
        raced.targetKey === targetKey;
      if (identicalFirstRequest) {
        return { draft: presentDraft(raced), created: false };
      }
      throw new DraftRevisionRequiredError(raced.revision);
    }
  }

  const id = crypto.randomUUID();
  const [createdRows] = await db.batch([
    db
      .insert(librarianDrafts)
      .values({
        id,
        ownerUserId: user.userId,
        ownerEmail: user.email,
        kind: input.kind,
        payloadJson,
        schemaVersion: CURRENT_DRAFT_SCHEMA_VERSION,
        revision: 1,
        status: "draft",
        groupId: input.groupId ?? null,
        targetKey,
        updatedByUserId: user.userId,
        updatedByEmail: user.email,
        createdAt: now,
        updatedAt: now,
      })
      .returning(),
    db.insert(librarianDraftEvents).values(
      guardedDraftEventValues({
        draftId: id,
        user,
        action: "created",
        fromStatus: null,
        toStatus: "draft",
        revision: 1,
        createdAt: now,
      }),
    ),
  ]);
  const created = createdRows[0];

  if (!created) throw new Error("Draft insert did not return a row");
  return { draft: presentDraft(created), created: true };
}

export async function transitionDraft(
  user: ChatGPTUser,
  id: string,
  expectedRevision: number,
  action: DraftAction,
): Promise<LibrarianDraft> {
  const db = getDb();
  const now = new Date().toISOString();
  const nextStatus: DraftStatus = action === "submit"
    ? "ready_for_review"
    : "cancelled";
  const allowedStatuses: DraftStatus[] = action === "submit"
    ? ["draft"]
    : ["draft", "ready_for_review"];

  const [existing] = await db
    .select()
    .from(librarianDrafts)
    .where(eq(librarianDrafts.id, id))
    .limit(1);
  if (!existing || existing.ownerUserId !== user.userId) {
    throw new DraftNotFoundError();
  }
  if (existing.revision !== expectedRevision) {
    throw new DraftConflictError(existing.revision);
  }
  if (!allowedStatuses.includes(existing.status)) {
    throw new DraftLockedError(existing.status);
  }

  let batchError: unknown;
  try {
    const [updatedRows] = await db.batch([
      db
        .update(librarianDrafts)
        .set({
          status: nextStatus,
          revision: sql`${librarianDrafts.revision} + 1`,
          updatedByUserId: user.userId,
          updatedByEmail: user.email,
          updatedAt: now,
          ...(action === "submit" ? { submittedAt: now } : { cancelledAt: now }),
        })
        .where(
          and(
            eq(librarianDrafts.id, id),
            eq(librarianDrafts.ownerUserId, user.userId),
            eq(librarianDrafts.revision, expectedRevision),
            eq(librarianDrafts.status, existing.status),
          ),
        )
        .returning(),
      db.insert(librarianDraftEvents).values(
        guardedDraftEventValues({
          draftId: id,
          user,
          action: action === "submit" ? "submitted" : "cancelled",
          fromStatus: existing.status,
          toStatus: nextStatus,
          revision: expectedRevision + 1,
          createdAt: now,
        }),
      ),
    ]);
    const updated = updatedRows[0];
    if (!updated) throw new Error("Draft transition did not return a row");
    return presentDraft(updated);
  } catch (error) {
    batchError = error;
  }

  const [current] = await db
    .select({
      ownerUserId: librarianDrafts.ownerUserId,
      revision: librarianDrafts.revision,
      status: librarianDrafts.status,
    })
    .from(librarianDrafts)
    .where(eq(librarianDrafts.id, id))
    .limit(1);
  if (!current || current.ownerUserId !== user.userId) {
    throw new DraftNotFoundError();
  }
  if (current.revision !== expectedRevision) {
    throw new DraftConflictError(current.revision);
  }
  if (!allowedStatuses.includes(current.status)) {
    throw new DraftLockedError(current.status);
  }
  throw batchError;
}
