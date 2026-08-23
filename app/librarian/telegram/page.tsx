import type { Metadata } from "next";

import { telegramMiniAppPublicConfiguration } from "@/lib/telegram-mini-app-auth";
import TelegramLibrarianLaunch from "./telegram-librarian-launch";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Кабінет бібліотекаря в Telegram",
  robots: { index: false, follow: false },
};

type PageProps = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

export default async function TelegramLibrarianPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const configuration = telegramMiniAppPublicConfiguration();
  return (
    <TelegramLibrarianLaunch
      target={boundedTarget(params?.target)}
      teacherTab={boundedTeacherTab(params?.tab)}
      enabled={configuration.enabled}
      botUsername={configuration.botUsername}
    />
  );
}

function boundedTarget(value: string | string[] | undefined): "home" | "visits" | "teachers" | "acquisitions" {
  return value === "visits" || value === "teachers" || value === "acquisitions" ? value : "home";
}

function boundedTeacherTab(value: string | string[] | undefined): "overview" | "teachers" | "orders" | "visits" | "telegram" {
  return value === "teachers" || value === "orders" || value === "visits" || value === "telegram" ? value : "overview";
}
