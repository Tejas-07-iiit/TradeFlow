import { Bell, KeyRound, Palette, Shield, SlidersHorizontal, User2 } from "lucide-react";

import { PageShell, StatusBadge } from "@/components/shared/page-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { settingsGroups } from "@/features/settings/settings-config";

export const dynamic = "force-dynamic";

const icons = [User2, Palette, Bell, SlidersHorizontal, Shield, KeyRound];

export default function SettingsPage() {
  return (
    <PageShell
      eyebrow="Settings"
      title="Workspace Preferences"
      description="Profile, appearance, notifications, paper trading defaults, risk controls, and future integration placeholders."
      action={<Badge variant="muted">Local UI only</Badge>}
    >
      <Tabs defaultValue="profile" className="space-y-4">
        <TabsList className="flex w-full flex-wrap justify-start">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="trading">Trading</TabsTrigger>
          <TabsTrigger value="risk">Risk</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <SettingsGrid start={0} end={1} />
        </TabsContent>
        <TabsContent value="appearance">
          <SettingsGrid start={1} end={2} />
        </TabsContent>
        <TabsContent value="notifications">
          <SettingsGrid start={2} end={3} />
        </TabsContent>
        <TabsContent value="trading">
          <SettingsGrid start={3} end={4} />
        </TabsContent>
        <TabsContent value="risk">
          <SettingsGrid start={4} end={5} />
        </TabsContent>
        <TabsContent value="integrations">
          <SettingsGrid start={5} end={6} />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}

function SettingsGrid({ start, end }: { start: number; end: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <section className="space-y-4">
        {settingsGroups.slice(start, end).map((group, index) => {
          const Icon = icons[start + index];
          return (
            <Card key={group.title}>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Icon className="size-4 text-[var(--color-accent)]" />
                  <CardTitle>{group.title}</CardTitle>
                </div>
                <StatusBadge tone="muted">Phase 1</StatusBadge>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm leading-6 text-[var(--color-fg-muted)]">
                  {group.description}
                </p>
                {group.rows.map((row) => (
                  <div key={row} className="grid gap-2 md:grid-cols-[220px_minmax(0,1fr)] md:items-center">
                    <Label>{row}</Label>
                    <Input defaultValue={row.includes("disabled") ? "Disabled" : "Configured placeholder"} />
                  </div>
                ))}
              </CardContent>
            </Card>
          );
        })}
      </section>

      <aside>
        <Card>
          <CardHeader>
            <CardTitle>Configuration Status</CardTitle>
            <Badge variant="accent">Ready</Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            {["Auth configured", "Paper wallet active", "Real trading disabled", "API keys not required"].map((item) => (
              <div key={item} className="flex items-center justify-between rounded-md bg-white/[0.025] px-3 py-2.5">
                <span className="text-sm text-[var(--color-fg-muted)]">{item}</span>
                <StatusBadge tone={item.includes("disabled") || item.includes("not") ? "warn" : "bull"}>
                  {item.includes("disabled") || item.includes("not") ? "Safe" : "On"}
                </StatusBadge>
              </div>
            ))}
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
