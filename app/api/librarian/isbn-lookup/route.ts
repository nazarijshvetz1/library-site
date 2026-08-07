import { authorizeLibrarianApi, librarianError, librarianJson } from "@/lib/librarian-api";
import { lookupBookByIsbn } from "@/lib/isbn-lookup";
import { normalizeIsbn } from "@/lib/isbn";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authorization = await authorizeLibrarianApi();
  if (!authorization.ok) return authorization.response;

  const rawIsbn = new URL(request.url).searchParams.get("isbn") ?? "";
  const isbn = normalizeIsbn(rawIsbn);
  if (!isbn) {
    return librarianError(
      400,
      "invalid_isbn",
      "Введіть коректний ISBN-10 або ISBN-13.",
      authorization.value.access.writesEnabled,
      { isbn: "Некоректний ISBN." },
    );
  }

  try {
    const candidates = await lookupBookByIsbn(isbn);
    return librarianJson({
      success: true,
      isbn,
      found: candidates.length > 0,
      candidates,
      writesEnabled: authorization.value.access.writesEnabled,
    });
  } catch {
    return librarianError(
      503,
      "book_lookup_unavailable",
      "Сервіси пошуку книги тимчасово недоступні. Дані можна ввести вручну.",
      authorization.value.access.writesEnabled,
    );
  }
}
