import { env } from "cloudflare:workers";

type RuntimeEnvironment = Record<string, unknown>;

function runtimeEnvironment(): RuntimeEnvironment {
  return env as unknown as RuntimeEnvironment;
}

export function getRuntimeString(name: string): string | null {
  const value = runtimeEnvironment()[name];
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return trimmed || null;
}

export function getRuntimeBoolean(name: string): boolean {
  return getRuntimeString(name)?.toLowerCase() === "true";
}
