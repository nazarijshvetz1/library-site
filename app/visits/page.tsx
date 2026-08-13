import type { Metadata } from "next";

import VisitBookingWorkspace from "./visit-booking-workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Запис до бібліотеки",
  description: "Запис учителів на відвідування бібліотеки без email-адреси.",
  robots: { index: false, follow: false },
};

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function VisitsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  return (
    <VisitBookingWorkspace
      initialDate={boundedDate(params?.date)}
      initialStartTime={boundedTime(params?.start)}
      initialEndTime={boundedTime(params?.end)}
      initialTab="visits"
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
