/**
 * Orchestrator heartbeat — periodic structured log line.
 *
 * The user runs logs-only observability, so we emit a single JSON line every
 * 30 seconds with the state any operator would otherwise want to grep:
 *
 *   - queue depth + active jobs
 *   - per-tier model registry
 *   - per-account cooldown remaining (max across configured models)
 *   - recent 429 count
 *
 * Grep-friendly tag: `[orch/heartbeat]` + a single JSON object on one line.
 *
 *   $ tail -F server.log | grep '[orch/heartbeat]' | jq '.'
 *
 * The heartbeat is process-local and starts on first import — Next.js's
 * route handler runtime tolerates background timers for the lifetime of
 * the server process. The interval can be overridden with
 * `AI_HEARTBEAT_INTERVAL_MS=0` to disable entirely.
 */

import { describeAccounts, describeTierRegistry } from "../providers";
import { modelCooldownRemainingMs } from "../providers/token-budget";

import { getOrchestratorStats } from "./index";
import { getLiveKeysStats, getRecentRateLimitEvents } from "./state";

const DEFAULT_INTERVAL_MS = 30_000;

function intervalMs(): number {
  const raw = process.env.AI_HEARTBEAT_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(0, n) : DEFAULT_INTERVAL_MS;
}

interface HeartbeatLine {
  ts: string;
  queue: {
    queued: number;
    active: number;
    activeByTier: Record<string, number>;
    totalDispatched: number;
    totalExpired: number;
    totalAborted: number;
    totalRetries: number;
  };
  tiers: Record<string, string[]>;
  accounts: Array<{
    id: number;
    status: string;
    rpm: number;
    tpm: number;
    cooldownLeftSec: number;
    dailyTokensUsed: number;
    dailyQuotaLimit: number;
    rate429: number;
  }>;
  cooldowns: Array<{ model: string; accountId: number; secondsLeft: number }>;
  recent429s: number;
}

function buildHeartbeat(): HeartbeatLine {
  const stats = getOrchestratorStats();
  const tiers = describeTierRegistry();
  const accounts = describeAccounts();
  const tierModels = Array.from(
    new Set([...tiers.light, ...tiers.mid, ...tiers.premium]),
  );

  // Sample the first model in each tier for per-account stats — getLiveKeysStats
  // is keyed by model id, and accounts share state across models in our impl.
  const sampleModel = tierModels[0];
  const liveKeys = sampleModel ? getLiveKeysStats(sampleModel) : [];

  const cooldownRows: Array<{ model: string; accountId: number; secondsLeft: number }> = [];
  for (const m of tierModels) {
    for (const a of accounts) {
      const left = modelCooldownRemainingMs(m, a.id);
      if (left > 0) {
        cooldownRows.push({
          model: m,
          accountId: a.id,
          secondsLeft: Math.ceil(left / 1000),
        });
      }
    }
  }

  return {
    ts: new Date().toISOString(),
    queue: {
      queued: stats.queued,
      active: stats.active,
      activeByTier: stats.activeByTier as unknown as Record<string, number>,
      totalDispatched: stats.totalDispatched,
      totalExpired: stats.totalExpired,
      totalAborted: stats.totalAborted,
      totalRetries: stats.totalRetries,
    },
    tiers,
    accounts: liveKeys.map((k) => ({
      id: k.accountId,
      status: k.status,
      rpm: k.requestsLastMin,
      tpm: k.tokensLastMin,
      cooldownLeftSec: Math.ceil(k.cooldownLeftMs / 1000),
      dailyTokensUsed: k.dailyTokensUsed,
      dailyQuotaLimit: k.dailyQuotaLimit,
      rate429: k.rate429,
    })),
    cooldowns: cooldownRows,
    recent429s: getRecentRateLimitEvents().length,
  };
}

let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatStarted = false;

export function startOrchestratorHeartbeat(): void {
  if (heartbeatStarted) return;
  const ms = intervalMs();
  if (ms === 0) {
    console.info("[orch/heartbeat] disabled (AI_HEARTBEAT_INTERVAL_MS=0).");
    heartbeatStarted = true;
    return;
  }
  heartbeatStarted = true;
  const tick = () => {
    try {
      const line = buildHeartbeat();
      console.info(`[orch/heartbeat] ${JSON.stringify(line)}`);
    } catch (err) {
      console.warn(`[orch/heartbeat] failed to emit: ${String(err)}`);
    }
  };
  // Fire one shortly after boot so the first observation lands in logs
  // without waiting the full interval.
  setTimeout(tick, 5_000);
  heartbeatTimer = setInterval(tick, ms);
  // Detach so the interval doesn't block process exit (CLI scripts).
  heartbeatTimer.unref?.();
}

export function stopOrchestratorHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  heartbeatStarted = false;
}
