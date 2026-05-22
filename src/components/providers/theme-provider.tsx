"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ThemeProviderProps } from "next-themes";

if (process.env.NODE_ENV === "development") {
  const orig = console.error;
  console.error = (...args: any[]) => {
    const isScriptWarning = args.some(
      (arg) =>
        typeof arg === "string" &&
        (arg.includes("Encountered a script tag") ||
          arg.includes("scripts inside React components") ||
          arg.includes("Scripts inside React components"))
    );
    if (isScriptWarning) {
      return;
    }
    orig.apply(console, args);
  };
}

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
