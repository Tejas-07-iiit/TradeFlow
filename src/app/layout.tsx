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
      <body className="min-h-full flex flex-col bg-[var(--color-bg)] text-[var(--color-fg)]">
        <Providers>{children}</Providers>
        <Toaster
          theme="dark"
          position="bottom-right"
          toastOptions={{
            style: {
              background: "var(--color-card)",
              border: "1px solid var(--color-border)",
              color: "var(--color-fg)",
            },
          }}
        />
      </body>
    </html>
  );
}
