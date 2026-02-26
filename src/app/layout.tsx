import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WikiMigrator - PDF to Notion",
  description: "PDF 파일을 Notion 페이지로 변환하세요",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body className="bg-gray-50 text-gray-900 antialiased">{children}</body>
    </html>
  );
}
