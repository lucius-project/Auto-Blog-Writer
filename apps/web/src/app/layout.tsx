import type { Metadata } from "next";
import "./globals.css";
import AuthClient from "../lib/auth-client";
import TopNav from "../components/TopNav";
import CreditsAlert from "../components/CreditsAlert";

export const metadata: Metadata = {
  title: "Automated Blog Writer",
  description:
    "Multi-tenant AI blog automation: research, gap analysis, SEO/AEO content, publishing.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 text-gray-900 antialiased">
        <AuthClient />
        <TopNav />
        <CreditsAlert />
        {children}
      </body>
    </html>
  );
}
