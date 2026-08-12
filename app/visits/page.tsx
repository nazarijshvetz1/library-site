import type { Metadata } from "next";

import { chatGPTSignOutPath, requireChatGPTUser } from "@/app/chatgpt-auth";
import VisitBookingWorkspace from "./visit-booking-workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Запис до бібліотеки",
  robots: { index: false, follow: false },
};

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function VisitsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const query = new URLSearchParams();
  const initialDate = boundedDate(params?.date);
  const initialStartTime = boundedTime(params?.start);
  const initialEndTime = boundedTime(params?.end);
  if (initialDate) query.set("date", initialDate);
  if (initialStartTime) query.set("start", initialStartTime);
  if (initialEndTime) query.set("end", initialEndTime);
  const returnTo = query.size ? `/visits?${query.toString()}` : "/visits";
  return (
    <AuthenticatedVisits
      returnTo={returnTo}
      initialDate={initialDate}
      initialStartTime={initialStartTime}
      initialEndTime={initialEndTime}
    />
  );
}

async function AuthenticatedVisits({
  returnTo,
  initialDate,
  initialStartTime,
  initialEndTime,
}: {
  returnTo: string;
  initialDate: string;
  initialStartTime: string;
  initialEndTime: string;
}) {
  const user = await requireChatGPTUser(returnTo);

  return (
    <VisitBookingWorkspace
      pendingScope={await visitPendingScope(user.userId)}
      displayName={user.displayName}
      signOutHref={chatGPTSignOutPath("/")}
      initialDate={initialDate}
      initialStartTime={initialStartTime}
      initialEndTime={initialEndTime}
    />
  );
}

function boundedDate(value: string | string[] | undefined): string {
  return typeof value === "string" && /^20\d{2}-\d{2}-\d{2}$/u.test(value)
    ? value
    : "";
}

function boundedTime(value: string | string[] | undefined): string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)
    ? value
    : "";
}

async function visitPendingScope(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId));
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
