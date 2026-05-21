import type { Metadata } from "next";
import { Toaster } from "sonner";

import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "TradeFlow — AI Crypto Trading Terminal",
  description:
    "Institutional-grade AI-assisted crypto trading workspace with paper trading, live market data, and decision-support intelligence.",
  metadataBase: new URL("http://localhost:3000"),
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-[var(--bg)] text-[var(--fg)]" suppressHydrationWarning>
        <Providers>{children}</Providers>
        <Toaster
          theme="system"
          position="bottom-right"
          toastOptions={{
            style: {
              background: "var(--card)",
              border: "1px solid var(--border)",
              color: "var(--fg)",
            },
          }}
        />
      </body>
    </html>
  );
}
