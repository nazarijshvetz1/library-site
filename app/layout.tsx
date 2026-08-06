import type { Metadata } from "next";
import "./globals.css";

const SITE_ORIGIN = "https://nazarijshvetz1.github.io/library-site";

export const metadata: Metadata = {
  title: {
    default: "Єдина бібліотека ліцею",
    template: "%s · Єдина бібліотека",
  },
  description:
    "Каталог і захищене робоче місце бібліотеки Міжнародного ліцею МАУП.",
  icons: { icon: `${SITE_ORIGIN}/library-logo.png` },
  openGraph: {
    title: "Єдина бібліотека ліцею",
    description: "Каталог і робоче місце бібліотеки Міжнародного ліцею МАУП.",
    locale: "uk_UA",
    type: "website",
    images: [{ url: `${SITE_ORIGIN}/og.png`, width: 1200, height: 630 }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="uk">
      <body>{children}</body>
    </html>
  );
}
