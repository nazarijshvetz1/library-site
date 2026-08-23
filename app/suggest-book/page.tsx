import type { Metadata } from "next";
import SuggestBookForm from "./suggest-book-form";

const publicCatalogUrl = "https://nazarijshvetz1.github.io/library-site/";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Запропонувати книгу бібліотеці",
  description: "Запропонуйте видання для фонду Єдиної бібліотеки. Потрібні лише клас, ім’я, назва та автор книги.",
  robots: { index: true, follow: true },
  alternates: { canonical: "https://yedyna-biblioteka-liceiu.nazarijshvetz1.chatgpt.site/suggest-book" },
  openGraph: {
    title: "Запропонувати книгу — Єдина бібліотека",
    description: "Відкрита форма пропозицій учнів для бібліотеки Міжнародного ліцею МАУП.",
    type: "website",
    images: [{ url: `${publicCatalogUrl}og.png`, width: 1200, height: 630, alt: "Єдина бібліотека Міжнародного ліцею МАУП" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Запропонувати книгу — Єдина бібліотека",
    description: "Порадьте видання, яке варто додати до бібліотечного фонду.",
    images: [`${publicCatalogUrl}og.png`],
  },
};

export default function SuggestBookPage() {
  return <SuggestBookForm />;
}
