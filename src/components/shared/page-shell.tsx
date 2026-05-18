import type { ElementType, ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function PageShell({
  eyebrow,
  title,
  description,
  action,
  children,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4 fade-in">
      <header className="flex flex-col gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]/55 p-5 shadow-[var(--shadow-card)] lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl">
          {eyebrow ? (
            <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--color-accent)]">
              {eyebrow}
            </div>
          ) : null}
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
            {title}
          </h1>
          <p className="mt-2 text-sm leading-6 text-[var(--color-fg-muted)]">
            {description}
          </p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      {children}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = "muted",
}: {
  label: string;
  value: string;
  detail?: string;
  icon: ElementType;
  tone?: "accent" | "bull" | "bear" | "warn" | "muted";
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
              {label}
            </div>
            <div className="mt-2 text-mono-tabular text-xl font-semibold text-[var(--color-fg)]">
              {value}
            </div>
            {detail ? (
              <div className="mt-1 text-xs text-[var(--color-fg-muted)]">
                {detail}
              </div>
            ) : null}
          </div>
          <div
            className={cn(
              "grid size-9 place-items-center rounded-md border",
              tone === "accent" &&
                "border-[var(--color-accent)]/20 bg-[var(--color-accent-soft)] text-[var(--color-accent)]",
              tone === "bull" &&
                "border-[var(--color-bull)]/20 bg-[var(--color-bull-soft)] text-[var(--color-bull)]",
              tone === "bear" &&
                "border-[var(--color-bear)]/20 bg-[var(--color-bear-soft)] text-[var(--color-bear)]",
              tone === "warn" &&
                "border-[var(--color-warn)]/20 bg-[var(--color-warn-soft)] text-[var(--color-warn)]",
              tone === "muted" &&
                "border-[var(--color-border)] bg-white/[0.03] text-[var(--color-fg-muted)]",
            )}
          >
            <Icon className="size-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function StatusBadge({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "accent" | "bull" | "bear" | "warn" | "muted";
}) {
  return (
    <Badge
      variant={
        tone === "accent"
          ? "accent"
          : tone === "bull"
            ? "bull"
            : tone === "bear"
              ? "bear"
              : tone === "warn"
                ? "warn"
                : "muted"
      }
    >
      {children}
    </Badge>
  );
}

export function MiniBars({
  values,
  tone = "accent",
}: {
  values: number[];
  tone?: "accent" | "bull" | "bear";
}) {
  const max = Math.max(...values, 1);
  return (
    <div className="flex h-8 items-end gap-0.5">
      {values.map((value, index) => (
        <span
          key={`${value}-${index}`}
          className={cn(
            "w-1.5 rounded-t opacity-80",
            tone === "accent" && "bg-[var(--color-accent)]",
            tone === "bull" && "bg-[var(--color-bull)]",
            tone === "bear" && "bg-[var(--color-bear)]",
          )}
          style={{ height: `${Math.max(16, (value / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] bg-white/[0.02] p-6 text-center">
      <div className="text-sm font-medium text-[var(--color-fg)]">{title}</div>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--color-fg-muted)]">
        {description}
      </p>
    </div>
  );
}
