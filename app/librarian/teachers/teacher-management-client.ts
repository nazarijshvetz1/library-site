import { visitApi } from "../../visits/visit-client.ts";

export type TeacherDirectoryStatus = "active" | "inactive";

export type TeacherLocation = { id: string; name: string; type: string };

export type TeacherAccess = {
  hasCode: boolean;
  status: "active" | "disabled" | "locked" | null;
  version?: number | null;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  activeSessions: number;
};

export type TeacherAttention = {
  openRequests: number;
  openLoans: number;
  overdueLoans: number;
  readyUncollected: number;
};

export type TeacherTelegram = {
  connected: boolean;
  status: "active" | "disabled" | "blocked" | null;
  notificationsEnabled: boolean;
  notificationsMuted: boolean;
  linkedAt: string | null;
};

export type TeacherDirectoryRow = {
  id: string;
  fullName: string;
  accountRole: "teacher" | "admin" | "librarian";
  status: TeacherDirectoryStatus;
  subjectPosition: string;
  primaryLocation: { id: string; name: string } | null;
  serviceContact: string;
  photoUrl: string | null;
  librarianNote?: string;
  closedAt?: string | null;
  version: number;
  access: TeacherAccess;
  telegram: TeacherTelegram;
  attention: TeacherAttention;
  createdAt: string;
  updatedAt: string;
};

export type TeacherDirectoryCounters = {
  total: number;
  active: number;
  inactive: number;
  withCode: number;
  withoutCode: number;
  locked: number;
  withOpenLoans: number;
  withOverdueLoans: number;
  withOpenRequests: number;
  telegramConnected: number;
  telegramNotConnected: number;
  telegramNotificationsOff: number;
  telegramBlocked: number;
};

export type TeacherDirectoryEnvelope = {
  schemaVersion: 1;
  success: true;
  writesEnabled: boolean;
  counters: TeacherDirectoryCounters;
  teachers: TeacherDirectoryRow[];
  locations: TeacherLocation[];
  page: { limit: number; hasMore: boolean; nextCursor: string | null };
};

type RawRequest = {
  id: string;
  status: string;
  teacher_notes?: string;
  librarian_note?: string;
  version: number;
  submitted_at: string;
  updated_at: string;
  requested_quantity: number;
  items: Array<{
    id: string;
    title_snapshot: string;
    author_snapshot: string;
    requested_quantity: number;
    approved_quantity: number | null;
    fulfilled_quantity: number;
    reserved_quantity: number;
  }>;
};

type RawLoan = {
  id: string;
  status: string;
  issued_at: string;
  due_at: string | null;
  closed_at: string | null;
  outstanding_quantity: number;
  items: Array<{
    id: string;
    title: string;
    author: string;
    source_location_name: string;
    condition: string;
    quantity_issued: number;
    quantity_returned: number;
    outstanding_quantity: number;
  }>;
};

type RawVisit = {
  id: string;
  visit_date: string;
  start_time: string;
  end_time: string;
  class_label?: string | null;
  purpose?: string | null;
  status: string;
};

export type TeacherDetail = {
  teacher: TeacherDirectoryRow & { librarianNote: string; closedAt: string | null };
  assignedClasses: Array<Record<string, unknown>>;
  futureVisits: RawVisit[];
  requests: RawRequest[];
  loans: RawLoan[];
  classResponsibilities: Array<Record<string, unknown>>;
  notifications: { unreadCount: number; items: Array<Record<string, unknown>> };
  history: Array<Record<string, unknown>>;
  dependencySummary: Record<string, number> & { totalDependencies: number };
};

export type TeacherDetailEnvelope = TeacherDetail & {
  schemaVersion: 1;
  success: true;
  writesEnabled: boolean;
};

export type TeacherMutationEnvelope = {
  schemaVersion: 1;
  success: true;
  writesEnabled: boolean;
  teacher: TeacherDirectoryRow;
};

export type TeacherDirectoryFilters = {
  query?: string;
  status?: "active" | "inactive" | "all";
  telegram?: "all" | "connected" | "disconnected" | "muted" | "blocked";
  cursor?: string | null;
  limit?: number;
};

export type TeacherProfileDraft = {
  fullName: string;
  subjectPosition: string;
  primaryLocationId: string;
  serviceContact: string;
  librarianNote: string;
};

export type DuplicateTeacherCandidate = { id: string; fullName: string; status: TeacherDirectoryStatus };

export class TeacherDuplicateWarning extends Error {
  readonly candidates: DuplicateTeacherCandidate[];

  constructor(candidates: DuplicateTeacherCandidate[]) {
    super("Вже існує картка зі схожим ПІБ.");
    this.name = "TeacherDuplicateWarning";
    this.candidates = candidates;
  }
}

export const TEACHER_DIRECTORY_URL = "/api/librarian/teachers";

export function teacherDirectoryUrl(filters: TeacherDirectoryFilters): string {
  const params = new URLSearchParams();
  if (filters.query?.trim()) params.set("q", filters.query.trim());
  params.set("status", filters.status ?? "active");
  params.set("telegram", filters.telegram ?? "all");
  if (filters.cursor) params.set("cursor", filters.cursor);
  params.set("limit", String(filters.limit ?? 30));
  return `${TEACHER_DIRECTORY_URL}?${params.toString()}`;
}

export function teacherDetailUrl(teacherId: string): string {
  return `${TEACHER_DIRECTORY_URL}/${encodeURIComponent(teacherId)}`;
}

export async function loadTeacherDirectory(filters: TeacherDirectoryFilters) {
  return visitApi<TeacherDirectoryEnvelope>(teacherDirectoryUrl(filters));
}

export async function loadTeacherDetail(teacherId: string) {
  return visitApi<TeacherDetailEnvelope>(teacherDetailUrl(teacherId));
}

export async function createTeacherProfile(draft: TeacherProfileDraft, forceDuplicate = false) {
  return teacherMutation<TeacherMutationEnvelope>(TEACHER_DIRECTORY_URL, {
    method: "POST",
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      fullName: draft.fullName.trim(),
      subjectPosition: draft.subjectPosition.trim(),
      primaryLocationId: draft.primaryLocationId || null,
      serviceContact: draft.serviceContact.trim(),
      librarianNote: draft.librarianNote.trim(),
      forceDuplicate,
    }),
  });
}

export async function updateTeacherProfile(
  teacherId: string,
  expectedVersion: number,
  draft: TeacherProfileDraft,
  forceDuplicate = false,
) {
  return teacherMutation<TeacherMutationEnvelope>(teacherDetailUrl(teacherId), {
    method: "PATCH",
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      expectedVersion,
      action: "update",
      changes: {
        fullName: draft.fullName.trim(),
        subjectPosition: draft.subjectPosition.trim(),
        primaryLocationId: draft.primaryLocationId || null,
        serviceContact: draft.serviceContact.trim(),
        librarianNote: draft.librarianNote.trim(),
      },
      reason: "",
      forceDuplicate,
    }),
  });
}

export async function changeTeacherStatus(
  teacherId: string,
  expectedVersion: number,
  action: "close" | "restore",
  reason: string,
) {
  return teacherMutation<TeacherMutationEnvelope>(teacherDetailUrl(teacherId), {
    method: "PATCH",
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      expectedVersion,
      action,
      changes: {},
      reason: reason.trim(),
      forceDuplicate: false,
    }),
  });
}

export async function deleteTeacherProfile(teacherId: string, expectedVersion: number, confirmedFullName: string) {
  return teacherMutation<{ success: true; deleted: true; teacherId: string }>(teacherDetailUrl(teacherId), {
    method: "DELETE",
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      expectedVersion,
      confirmation: "DELETE_TEACHER_CARD",
      confirmedFullName: confirmedFullName.trim(),
    }),
  });
}

export function emptyTeacherCounters(): TeacherDirectoryCounters {
  return { total: 0, active: 0, inactive: 0, withCode: 0, withoutCode: 0, locked: 0, withOpenLoans: 0, withOverdueLoans: 0, withOpenRequests: 0, telegramConnected: 0, telegramNotConnected: 0, telegramNotificationsOff: 0, telegramBlocked: 0 };
}

export function teacherProfileDraft(teacher?: TeacherDirectoryRow | null): TeacherProfileDraft {
  return {
    fullName: teacher?.fullName ?? "",
    subjectPosition: teacher?.subjectPosition ?? "",
    primaryLocationId: teacher?.primaryLocation?.id ?? "",
    serviceContact: teacher?.serviceContact ?? "",
    librarianNote: teacher?.librarianNote ?? "",
  };
}

async function teacherMutation<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json", ...(init.headers || {}) },
    });
  } catch {
    throw new Error("Немає зв’язку із сервером.");
  }
  const body = await response.json().catch(() => null) as (T & { success?: boolean; code?: string; error?: string; message?: string; details?: { duplicates?: DuplicateTeacherCandidate[] }; duplicates?: DuplicateTeacherCandidate[] }) | null;
  if (response.status === 409 && body?.code === "teacher_duplicate_warning") {
    throw new TeacherDuplicateWarning(body.details?.duplicates ?? body.duplicates ?? []);
  }
  if (!response.ok || !body || body.success === false) {
    throw new Error(body?.error || body?.message || `Запит не виконано (${response.status}).`);
  }
  return body;
}
