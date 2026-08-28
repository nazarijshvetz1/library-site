import type { Metadata } from "next";

import TextbookCatalog from "./textbook-catalog";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Е-підручники 1–11 класів",
  description: "Офіційні електронні версії підручників, якими користуються учні Міжнародного ліцею МАУП.",
  alternates: { canonical: "/textbooks" },
};

export default function TextbooksPage() {
  return <TextbookCatalog />;
}
