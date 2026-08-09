import { sql } from "drizzle-orm";

import type { ChatGPTUser } from "@/app/chatgpt-auth";
import { librarianDrafts } from "@/db/schema";
import type { DraftStatus } from "@/lib/draft-validation";

export type DraftEventAction =
  | "created"
  | "updated"
  | "submitted"
  | "cancelled"
  | "approved"
  | "returned_for_changes"
  | "applied"
  | "failed";

type DraftEventInput = {
  draftId: string;
  user: ChatGPTUser;
  action: DraftEventAction;
  fromStatus: DraftStatus | null;
  toStatus: DraftStatus;
  revision: number;
  createdAt: string;
};

export function guardedDraftEventValues(input: DraftEventInput) {
  return {
    id: crypto.randomUUID(),
    // This insert must immediately follow the draft INSERT/UPDATE in one D1
    // batch. A zero-row optimistic update makes the scalar subquery NULL, so
    // the NOT NULL constraint aborts and rolls back the whole batch instead of
    // recording an event for a mutation that never happened.
    draftId: sql<string>`(
      select ${librarianDrafts.id}
      from ${librarianDrafts}
      where ${librarianDrafts.id} = ${input.draftId}
        and ${librarianDrafts.ownerUserId} = ${input.user.userId}
        and ${librarianDrafts.status} = ${input.toStatus}
        and ${librarianDrafts.revision} = ${input.revision}
        and ${librarianDrafts.updatedByUserId} = ${input.user.userId}
        and ${librarianDrafts.updatedByEmail} = ${input.user.email}
        and ${librarianDrafts.updatedAt} = ${input.createdAt}
        and changes() = 1
    )`,
    actorUserId: input.user.userId,
    actorEmail: input.user.email,
    action: input.action,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    revision: input.revision,
    createdAt: input.createdAt,
  };
}
