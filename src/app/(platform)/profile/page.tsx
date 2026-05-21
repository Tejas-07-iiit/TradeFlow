"use client";

import { useSession } from "next-auth/react";
import { User2, Mail, Key, ShieldCheck, Cpu } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

export default function ProfilePage() {
  const { data: session } = useSession();

  const initials = (session?.user?.name || session?.user?.email || "T")
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-[var(--fg)]">
          Trader Profile
        </h1>
        <p className="text-[var(--fg-muted)] mt-1">
          Manage your account settings and preferences.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Profile Card */}
        <div className="panel p-6 flex flex-col items-center text-center space-y-4 md:col-span-1">
          <Avatar className="size-24 border-4 border-[var(--bg)] ring-2 ring-[var(--border)] shadow-xl">
            <AvatarFallback className="text-2xl bg-[var(--card-hover)] text-[var(--fg)]">
              {initials}
            </AvatarFallback>
          </Avatar>
          <div>
            <h2 className="text-xl font-semibold text-[var(--fg)]">
              {session?.user?.name || "Anonymous Trader"}
            </h2>
            <p className="text-sm text-[var(--fg-muted)] flex items-center justify-center gap-1.5 mt-1">
              <Mail className="size-3.5" />
              {session?.user?.email || "No email attached"}
            </p>
          </div>
          <Badge variant="bull" className="bg-[var(--bull-soft)] text-[var(--bull)] border-[var(--bull)]/20 px-3 py-1 mt-2">
            Pro Plan Active
          </Badge>
        </div>

        {/* Details Cards */}
        <div className="md:col-span-2 space-y-6">
          <div className="panel">
            <div className="p-4 border-b border-[var(--border)] flex items-center gap-2">
              <ShieldCheck className="size-4 text-[var(--accent)]" />
              <h3 className="font-semibold text-[var(--fg)]">Account Security</h3>
            </div>
            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-[var(--fg)]">Password</p>
                  <p className="text-xs text-[var(--fg-muted)]">Last changed 30 days ago</p>
                </div>
                <button className="text-xs px-3 py-1.5 bg-[var(--card-hover)] border border-[var(--border)] rounded text-[var(--fg)] hover:bg-[var(--border)] transition-colors">
                  Update
                </button>
              </div>
              <Separator className="bg-[var(--border)]" />
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-[var(--fg)]">Two-Factor Authentication</p>
                  <p className="text-xs text-[var(--fg-muted)]">Enhance security with 2FA</p>
                </div>
                <button className="text-xs px-3 py-1.5 bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)]/20 rounded hover:bg-[var(--accent)] hover:text-[var(--fg)] transition-colors">
                  Enable
                </button>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="p-4 border-b border-[var(--border)] flex items-center gap-2">
              <Cpu className="size-4 text-[var(--accent)]" />
              <h3 className="font-semibold text-[var(--fg)]">AI Connections</h3>
            </div>
            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="size-8 rounded bg-[var(--card-hover)] border border-[var(--border)] flex items-center justify-center">
                    <Key className="size-4 text-[var(--fg-subtle)]" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-[var(--fg)]">Groq API Key</p>
                    <p className="text-xs text-[var(--fg-muted)]">Active • Used for live inference</p>
                  </div>
                </div>
                <Badge variant="bull" className="bg-[var(--bull-soft)] text-[var(--bull)] border-[var(--bull)]/20">Connected</Badge>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
