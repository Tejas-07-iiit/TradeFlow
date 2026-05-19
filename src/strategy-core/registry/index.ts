import type { StrategyCategory, StrategyDefinition } from "../types";

/**
 * Strategy registry — central catalogue of every live strategy module.
 *
 * Modules register themselves at import time via `registerStrategy`. This
 * mirrors the existing zustand store pattern (singleton, module-scoped) so
 * we don't introduce a new state framework just for strategies.
 *
 * Order matters only for deterministic logging — the evaluator runs in
 * parallel so registration order does not affect output.
 */
class StrategyRegistryImpl {
  private readonly byId = new Map<string, StrategyDefinition>();

  register(def: StrategyDefinition): void {
    if (this.byId.has(def.id)) {
      console.warn(`[strategy-registry] duplicate id "${def.id}" — replacing.`);
    }
    this.byId.set(def.id, def);
  }

  get(id: string): StrategyDefinition | undefined {
    return this.byId.get(id);
  }

  all(): StrategyDefinition[] {
    return Array.from(this.byId.values());
  }

  enabled(): StrategyDefinition[] {
    return this.all().filter((d) => d.enabled);
  }

  byCategory(category: StrategyCategory): StrategyDefinition[] {
    return this.all().filter((d) => d.category === category);
  }

  setEnabled(id: string, enabled: boolean): void {
    const def = this.byId.get(id);
    if (!def) return;
    def.enabled = enabled;
  }

  size(): number {
    return this.byId.size;
  }
}

export const StrategyRegistry = new StrategyRegistryImpl();

export function registerStrategy(def: StrategyDefinition): void {
  StrategyRegistry.register(def);
}
