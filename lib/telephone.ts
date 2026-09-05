/** Do not turn legacy free-form contact notes into dialable links. */
export function telephoneHref(value: string | null | undefined): string | undefined {
  const text = value?.trim() ?? "";
  if (!/^\+?[0-9() .-]+$/u.test(text)) return undefined;
  const digits = text.replace(/\D/gu, "");
  if (digits.length < 7 || digits.length > 15) return undefined;
  return `tel:${text.startsWith("+") ? "+" : ""}${digits}`;
}
