"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { toast } from "sonner";
import { ArrowRight, Loader2, Wallet } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type FieldErrors = Partial<Record<"name" | "email" | "password", string>>;

export function RegisterForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [topError, setTopError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setTopError(null);
    startTransition(async () => {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });

      if (!res.ok) {
        try {
          const body = await res.json();
          if (res.status === 422 && body.issues) {
            const fe: FieldErrors = {};
            for (const k of Object.keys(body.issues) as (keyof FieldErrors)[]) {
              fe[k] = body.issues[k]?.[0];
            }
            setErrors(fe);
          } else {
            setTopError(body.error ?? "Could not create your account.");
          }
        } catch {
          setTopError("Could not create your account.");
        }
        return;
      }

      // Auto sign-in after successful registration
      const signin = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });

      if (!signin || signin.error) {
        setTopError("Account created. Please sign in.");
        router.replace("/login");
        return;
      }

      toast.success("Paper wallet funded with 10,000 USDT.");
      router.replace("/dashboard");
      router.refresh();
    });
  }

  return (
    <div className="space-y-7">
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">
          Create your terminal
        </h2>
        <p className="text-sm text-[var(--color-fg-muted)]">
          We&apos;ll provision a paper wallet with{" "}
          <span className="text-mono-tabular text-[var(--color-fg)]">
            10,000 USDT
          </span>{" "}
          so you can trade risk-free.
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="name">Full name</Label>
          <Input
            id="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Trader"
          />
          {errors.name ? (
            <p className="text-[11px] text-[var(--color-bear)]">{errors.name}</p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@firm.com"
          />
          {errors.email ? (
            <p className="text-[11px] text-[var(--color-bear)]">{errors.email}</p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
          />
          {errors.password ? (
            <p className="text-[11px] text-[var(--color-bear)]">
              {errors.password}
            </p>
          ) : null}
        </div>

        {topError ? (
          <div className="rounded-md border border-[var(--color-bear)]/30 bg-[var(--color-bear-soft)] px-3 py-2 text-xs text-[var(--color-bear)]">
            {topError}
          </div>
        ) : null}

        <div className="flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-white/[0.02] px-3 py-2.5 text-[11px] text-[var(--color-fg-muted)]">
          <Wallet className="size-3.5 mt-0.5 text-[var(--color-accent)]" />
          <span>
            Your paper wallet is provisioned automatically during signup. All
            positions execute against simulated markets.
          </span>
        </div>

        <Button type="submit" disabled={isPending} className="w-full">
          {isPending ? (
            <>
              <Loader2 className="animate-spin" />
              Provisioning workspace
            </>
          ) : (
            <>
              Create account
              <ArrowRight />
            </>
          )}
        </Button>
      </form>

      <p className="text-sm text-[var(--color-fg-muted)]">
        Already trading?{" "}
        <Link
          href="/login"
          className="text-[var(--color-accent)] hover:underline underline-offset-4"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
