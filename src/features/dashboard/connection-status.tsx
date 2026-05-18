"use client";

import { Radio } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useMarketStore } from "@/store/market-store";

const LABEL: Record<string, string> = {
  open: "Live",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  closed: "Offline",
  error: "Error",
  idle: "Idle",
};

const TONE: Record<string, "bull" | "warn" | "bear" | "muted"> = {
  open: "bull",
  connecting: "warn",
  reconnecting: "warn",
  closed: "muted",
  error: "bear",
  idle: "muted",
};

export function ConnectionStatus() {
  const status = useMarketStore((s) => s.status);
  const tone = TONE[status] ?? "muted";
  const label = LABEL[status] ?? status;
  const live = status === "open";
  return (
    <Badge variant={tone}>
      <span
        className={cn(
          "relative inline-block size-1.5 rounded-full",
          tone === "bull" && "bg-[var(--color-bull)]",
          tone === "warn" && "bg-[var(--color-warn)]",
          tone === "bear" && "bg-[var(--color-bear)]",
          tone === "muted" && "bg-[var(--color-fg-subtle)]",
        )}
      >
        {live ? (
          <span
            aria-hidden
            className="absolute inset-0 rounded-full animate-ping bg-[var(--color-bull)] opacity-70"
          />
        ) : null}
      </span>
      <Radio className="size-3" />
      {label}
    </Badge>
  );
}
