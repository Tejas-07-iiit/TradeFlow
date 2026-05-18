import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-wide",
  {
    variants: {
      variant: {
        default:
          "bg-white/[0.05] text-[var(--color-fg)] border border-[var(--color-border)]",
        accent:
          "bg-[var(--color-accent-soft)] text-[var(--color-accent)] border border-[var(--color-accent)]/20",
        bull: "bg-[var(--color-bull-soft)] text-[var(--color-bull)] border border-[var(--color-bull)]/20",
        bear: "bg-[var(--color-bear-soft)] text-[var(--color-bear)] border border-[var(--color-bear)]/20",
        warn: "bg-[var(--color-warn-soft)] text-[var(--color-warn)] border border-[var(--color-warn)]/20",
        muted:
          "bg-transparent text-[var(--color-fg-muted)] border border-[var(--color-border)]",
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
