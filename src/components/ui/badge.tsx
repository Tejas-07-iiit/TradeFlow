import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-wide",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--card-hover)] text-[var(--fg)] border border-[var(--border)]",
        accent:
          "bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)]/20",
        bull: "bg-[var(--bull-soft)] text-[var(--bull)] border border-[var(--bull)]/20",
        bear: "bg-[var(--bear-soft)] text-[var(--bear)] border border-[var(--bear)]/20",
        warn: "bg-[var(--warn-soft)] text-[var(--warn)] border border-[var(--warn)]/20",
        muted:
          "bg-transparent text-[var(--fg-muted)] border border-[var(--border)]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
