import type { Metadata } from "next";

import { telegramMiniAppPublicConfiguration } from "@/lib/telegram-mini-app-auth";
import TelegramTeacherLaunch from "./telegram-teacher-launch";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Кабінет учителя в Telegram",
  description: "Безпечний вхід до кабінету вчителя з Telegram.",
  robots: { index: false, follow: false },
};

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function TelegramTeacherPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const configuration = telegramMiniAppPublicConfiguration();
  return (
    <TelegramTeacherLaunch
      targetTab={boundedTab(params?.tab)}
      enabled={configuration.enabled}
      botUsername={configuration.botUsername}
    />
  );
}

function boundedTab(value: string | string[] | undefined): "overview" | "visits" | "orders" | "loans" | "notifications" {
  return value === "visits" || value === "orders" || value === "loans" || value === "notifications"
    ? value
    : "overview";
}
