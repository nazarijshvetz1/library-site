export function normalizeIsbn(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const isbn = value.toUpperCase().replace(/[\s-]+/g, "").trim();
  if (isbn.length === 10) return validIsbn10(isbn) ? isbn : null;
  if (isbn.length === 13) return validIsbn13(isbn) ? isbn : null;
  return null;
}

function validIsbn10(value: string): boolean {
  if (!/^\d{9}[\dX]$/.test(value)) return false;
  const sum = [...value].reduce((total, character, index) => {
    const digit = character === "X" ? 10 : Number(character);
    return total + digit * (10 - index);
  }, 0);
  return sum % 11 === 0;
}

function validIsbn13(value: string): boolean {
  if (!/^(?:978|979)\d{10}$/.test(value)) return false;
  const sum = [...value.slice(0, 12)].reduce(
    (total, character, index) =>
      total + Number(character) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return (10 - (sum % 10)) % 10 === Number(value[12]);
}
