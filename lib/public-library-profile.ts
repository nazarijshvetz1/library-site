import type { VisitD1Database } from "./visit-schedule-store.ts";

type ProfileRow = {
  librarian_name: string;
  librarian_description: string;
  librarian_phone: string;
  librarian_email: string;
  assistant_name: string;
  assistant_description: string;
  assistant_phone: string;
  assistant_email: string;
  version: number;
  updated_at: string;
};

export type PublicLibraryContactProfile = {
  librarian: { name: string; description: string; phone: string; email: string };
  assistant: { name: string; description: string; phone: string; email: string } | null;
  updatedAt: string;
};

export type LibrarianContactProfile = PublicLibraryContactProfile & { version: number };

export type ContactProfileChanges = {
  librarianName: string;
  librarianDescription: string;
  librarianPhone: string;
  librarianEmail: string;
  assistantName: string;
  assistantDescription: string;
  assistantPhone: string;
  assistantEmail: string;
};

export class PublicLibraryProfileError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = "PublicLibraryProfileError";
  }
}

export async function getPublicLibraryContactProfile(
  db: VisitD1Database,
): Promise<PublicLibraryContactProfile> {
  return project(await readProfile(db));
}

export async function getLibrarianContactProfile(
  db: VisitD1Database,
): Promise<LibrarianContactProfile> {
  const row = await readProfile(db);
  return { ...project(row), version: Number(row.version) };
}

export async function updatePublicLibraryContactProfile(
  db: VisitD1Database,
  actor: { id: string; email: string },
  input: { requestId: string; expectedVersion: number; changes: ContactProfileChanges },
): Promise<LibrarianContactProfile> {
  const changes = normalizeChanges(input.changes);
  validateChanges(changes);
  const requestHash = await sha256Json({
    kind: "public_library_profile.update",
    actorUserId: actor.id,
    expectedVersion: input.expectedVersion,
    changes,
  });
  const replay = await readCompletedCommand(db, actor.id, input.requestId, requestHash);
  if (replay) return replay;
  const current = await readProfile(db);
  if (Number(current.version) !== input.expectedVersion) {
    throw new PublicLibraryProfileError("contact_version_conflict", 409,
      "Контакти вже змінилися. Оновіть форму й повторіть дію.");
  }
  const now = new Date().toISOString();
  const result: LibrarianContactProfile = {
    ...project({
      librarian_name: changes.librarianName,
      librarian_description: changes.librarianDescription,
      librarian_phone: changes.librarianPhone,
      librarian_email: changes.librarianEmail,
      assistant_name: changes.assistantName,
      assistant_description: changes.assistantDescription,
      assistant_phone: changes.assistantPhone,
      assistant_email: changes.assistantEmail,
      version: input.expectedVersion + 1,
      updated_at: now,
    }),
    version: input.expectedVersion + 1,
  };
  try {
    await db.batch([
      db.prepare(`INSERT INTO mutation_commands(
          id,draft_id,kind,actor_user_id,status,target_type,target_id,request_hash,
          result_json,error_code,error_message,created_at,updated_at,completed_at)
        SELECT ?,NULL,'public_library_profile.update',?,'processing','public_library_profile','primary',?,
          NULL,NULL,NULL,?,?,NULL
        FROM public_library_profile WHERE id='primary' AND version=?`)
        .bind(input.requestId, actor.id, requestHash, now, now, input.expectedVersion),
      db.prepare(`UPDATE public_library_profile SET librarian_name=?,librarian_description=?,
          librarian_phone=?,librarian_email=?,assistant_name=?,assistant_description=?,
          assistant_phone=?,assistant_email=?,version=version+1,last_mutation_request_id=?,
          updated_by_user_id=?,updated_at=?
        WHERE id='primary' AND version=?
          AND EXISTS(SELECT 1 FROM mutation_commands WHERE id=? AND actor_user_id=?
            AND request_hash=? AND status='processing')`)
        .bind(changes.librarianName, changes.librarianDescription, changes.librarianPhone,
          changes.librarianEmail, changes.assistantName, changes.assistantDescription,
          changes.assistantPhone, changes.assistantEmail, input.requestId, actor.id, now,
          input.expectedVersion, input.requestId, actor.id, requestHash),
      db.prepare(`INSERT INTO audit_events(
          id,actor_user_id,actor_email,action,entity_type,entity_id,request_id,
          before_json,after_json,metadata_json,created_at)
        SELECT ?,?,?,'public_library_profile.updated','public_library_profile','primary',?,
          ?,?,json_object('publicFieldsOnly',1),?
        FROM public_library_profile WHERE id='primary' AND version=?
          AND last_mutation_request_id=?`)
        .bind(`AUD-${crypto.randomUUID()}`, actor.id, actor.email.toLowerCase(), input.requestId,
          JSON.stringify(project(current)), JSON.stringify(result), now,
          input.expectedVersion + 1, input.requestId),
      db.prepare(`UPDATE mutation_commands SET status='completed',result_json=?,updated_at=?,completed_at=?
        WHERE id=? AND actor_user_id=? AND request_hash=? AND status='processing'
          AND EXISTS(SELECT 1 FROM public_library_profile WHERE id='primary'
            AND version=? AND last_mutation_request_id=?)`)
        .bind(JSON.stringify(result), now, now, input.requestId, actor.id, requestHash,
          input.expectedVersion + 1, input.requestId),
    ]);
  } catch (error) {
    const raced = await readCompletedCommand(db, actor.id, input.requestId, requestHash);
    if (raced) return raced;
    throw error;
  }
  const completed = await readCompletedCommand(db, actor.id, input.requestId, requestHash);
  if (!completed) {
    throw new PublicLibraryProfileError("contact_version_conflict", 409,
      "Контакти вже змінилися. Оновіть форму й повторіть дію.");
  }
  return completed;
}

function project(row: ProfileRow): PublicLibraryContactProfile {
  const assistant = {
    name: row.assistant_name,
    description: row.assistant_description,
    phone: row.assistant_phone,
    email: row.assistant_email,
  };
  return {
    librarian: {
      name: row.librarian_name,
      description: row.librarian_description,
      phone: row.librarian_phone,
      email: row.librarian_email,
    },
    assistant: Object.values(assistant).some(Boolean) ? assistant : null,
    updatedAt: row.updated_at,
  };
}

async function readProfile(db: VisitD1Database): Promise<ProfileRow> {
  const row = await db.prepare(`SELECT librarian_name,librarian_description,librarian_phone,
      librarian_email,assistant_name,assistant_description,assistant_phone,assistant_email,
      version,updated_at FROM public_library_profile WHERE id='primary' LIMIT 1`)
    .first<ProfileRow>();
  if (!row) throw new PublicLibraryProfileError("contact_profile_missing", 503,
    "Профіль контактів ще не створено.");
  return { ...row, version: Number(row.version) };
}

async function readCompletedCommand(
  db: VisitD1Database,
  actorUserId: string,
  requestId: string,
  requestHash: string,
): Promise<LibrarianContactProfile | null> {
  const command = await db.prepare(`SELECT actor_user_id,target_type,target_id,status,request_hash,result_json
    FROM mutation_commands WHERE id=? LIMIT 1`).bind(requestId).first<{
      actor_user_id: string; target_type: string | null; target_id: string | null;
      status: string; request_hash: string; result_json: string | null;
    }>();
  if (!command) return null;
  if (command.actor_user_id !== actorUserId || command.target_type !== "public_library_profile"
    || command.target_id !== "primary" || command.request_hash !== requestHash) {
    throw new PublicLibraryProfileError("request_id_conflict", 409,
      "Цей requestId уже використано для іншої зміни.");
  }
  if (command.status !== "completed" || !command.result_json) {
    throw new PublicLibraryProfileError("mutation_in_progress", 409,
      "Зміна контактів ще виконується. Оновіть форму.");
  }
  try { return JSON.parse(command.result_json) as LibrarianContactProfile; } catch {
    throw new PublicLibraryProfileError("mutation_result_invalid", 503,
      "Збережений результат зміни контактів пошкоджено.");
  }
}

function normalizeChanges(input: ContactProfileChanges): ContactProfileChanges {
  return {
    librarianName: clean(input.librarianName, false),
    librarianDescription: clean(input.librarianDescription, true),
    librarianPhone: clean(input.librarianPhone, false),
    librarianEmail: clean(input.librarianEmail, false).toLowerCase(),
    assistantName: clean(input.assistantName, false),
    assistantDescription: clean(input.assistantDescription, true),
    assistantPhone: clean(input.assistantPhone, false),
    assistantEmail: clean(input.assistantEmail, false).toLowerCase(),
  };
}

function clean(value: string, multiline: boolean): string {
  const normalized = value.normalize("NFKC").replace(/\r\n?/gu, "\n");
  return multiline
    ? normalized.split("\n").map((line) => line.trim()).join("\n").replace(/\n{3,}/gu, "\n\n").trim()
    : normalized.replace(/\s+/gu, " ").trim();
}

function validateChanges(value: ContactProfileChanges): void {
  if (value.librarianName.length > 160 || value.librarianDescription.length > 2000
    || value.librarianPhone.length > 80 || value.librarianEmail.length > 254
    || value.assistantName.length > 160 || value.assistantDescription.length > 2000
    || value.assistantPhone.length > 80 || value.assistantEmail.length > 254) {
    throw new PublicLibraryProfileError("validation_failed", 400, "Скоротіть надто довгі поля контактів.");
  }
  for (const email of [value.librarianEmail, value.assistantEmail]) {
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
      throw new PublicLibraryProfileError("validation_failed", 400, "Перевірте електронну адресу.");
    }
  }
  if ((value.assistantDescription || value.assistantPhone || value.assistantEmail) && !value.assistantName) {
    throw new PublicLibraryProfileError("validation_failed", 400,
      "Якщо додаєте дані помічника, спочатку вкажіть його ім’я.");
  }
}

async function sha256Json(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
