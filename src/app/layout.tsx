import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Defense Tech Monitor — Veille défense & technologie",
  description:
    "Un espace de veille pour suivre les technologies de défense, retrouver les sources et affiner votre sélection.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
