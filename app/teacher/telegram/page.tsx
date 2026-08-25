import type { Metadata } from "next";

import { telegramMiniAppPublicConfiguration } from "@/lib/telegram-mini-app-auth";
import TelegramTeacherLaunch from "./telegram-teacher-launch";
import { boundedTeacherTab, type TeacherPortalTab } from "@/app/teacher/_components/teacher-routes";

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
  const launchMode = boundedMode(params?.mode);
  return (
    <TelegramTeacherLaunch
      targetTab={boundedTab(params?.tab)}
      initialOrderMaterialId={boundedMaterialId(params?.material)}
      initialMode={launchMode ?? "login"}
      returnToChat={launchMode !== null}
      enabled={configuration.enabled}
      botUsername={configuration.botUsername}
    />
  );
}

function boundedMode(value: string | string[] | undefined): "login" | "activate" | null {
  return value === "login" || value === "activate" ? value : null;
}

function boundedTab(value: string | string[] | undefined): TeacherPortalTab {
  return boundedTeacherTab(value);
}

function boundedMaterialId(value: string | string[] | undefined): string {
  const candidate = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^CAT-\d{4,}$/u.test(candidate) ? candidate : "";
}
