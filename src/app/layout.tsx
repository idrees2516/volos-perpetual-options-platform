import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "VolOS — Perpetual Options Strategy Terminal",
  description:
    "Build any options strategy — dated, everlasting or mixed — with live animated risk/return profiles, scenario stress tests, carry budgets and strategy-level RFQ. Rust analytics engine + Next.js 16.",
  keywords: [
    "perpetual options",
    "everlasting options",
    "options strategy builder",
    "payoff diagram",
    "crypto options",
    "Derive",
    "Paradex",
    "Paradigm",
    "volatility",
    "greeks",
  ],
  authors: [{ name: "VolOS" }],
  openGraph: {
    title: "VolOS — Perpetual Options Strategy Terminal",
    description:
      "Dynamic, customizable strategy construction with animated risk profiles — the layer onchain options platforms are missing.",
    siteName: "VolOS",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#05070a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[#05070a] text-zinc-200`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
