
+"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--accent)] text-[var(--accent-fg)] hover:brightness-110 shadow-[var(--shadow-glow-val)]",
        outline:
          "border border-[var(--border-strong)] bg-transparent text-[var(--fg)] hover:bg-[var(--card-hover)] hover:border-[var(--border-strong)]",
        ghost:
          "bg-transparent text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--card-hover)]",
        bull: "bg-[var(--bull)] text-[var(--bull-fg)] hover:brightness-110",
        bear: "bg-[var(--bear)] text-[var(--bear-fg)] hover:brightness-110",
        secondary:
          "bg-[var(--surface-elevated)] text-[var(--fg)] border border-[var(--border)] hover:bg-[var(--card-hover)]",
        link: "text-[var(--accent)] underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-10 px-4 text-sm",
        lg: "h-11 px-5 text-sm",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
  VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
