"use client";

import { useEffect, useRef } from "react";

import { WATCHLIST_SYMBOLS } from "@/lib/market/symbols";
import { getStrategyDecision } from "@/server/ai-decision";
import { getSentiment } from "@/server/sentiment";
import { useAiDecisionStore } from "@/store/ai-decision-store";
import { useMarketStore } from "@/store/market-store";
import { usePortfolioStore } from "@/store/portfolio-store";

/** Maximum bars to ship to the server per refresh. Keeps the payload small
 *  while still covering EMA200 and the 52-bar range strategy comfortably. */
const CANDLE_WINDOW = 300;

/**
 * Periodically asks the LLM for a fresh decision per watchlist symbol.
 *
 * Cadence:
 *   - Initial fan-out, staggered 600ms apart so the provider sees discrete
 *     requests rather than a thundering herd.
 *   - Round-robin: one symbol refreshed every (CYCLE / N) ms ≈ 60s/symbol.
 *   - On-demand: re-fetches the active symbol when the user switches symbol
 *     or timeframe (exactly once per transition).
 *
 * Per-symbol in-flight guard prevents two outstanding requests for the same
 * symbol if the round-robin tick races with the active-symbol trigger.
 *
 * The reasoning layer already deduplicates via fingerprint + 90s TTL, so this
 * subscriber is the soft rate-limit and the reasoning layer is the hard one.
 */
/** 8 minutes across N symbols ≈ 96s per symbol on a 5-symbol watchlist.
 *  Slower cadence keeps us inside Groq's 12K TPM ceiling once the
 *  payload-shrinking changes are factored in. */
const FULL_CYCLE_MS = 8 * 60 * 1000;

export function AiDecisionSubscriber() {
  const symbol = useMarketStore((s) => s.symbol);
  const interval = useMarketStore((s) => s.interval);

  const setDecision = useAiDecisionStore((s) => s.setDecision);
  const setLoading = useAiDecisionStore((s) => s.setLoading);
  const setError = useAiDecisionStore((s) => s.setError);

  const inFlightRef = useRef<Record<string, boolean>>({});
  const intervalRef = useRef(interval);
  // Assigning to refs is illegal during render under React 19's lint rules,
  // so we sync the latest interval inside an effect. The ref is what async
  // refresh() callbacks read so they see the user's current timeframe.
  useEffect(() => {
    intervalRef.current = interval;
  }, [interval]);

  const refresh = async (target: string, retry = 0) => {
    if (inFlightRef.current[target]) return;
    const tf = intervalRef.current;
    const bars = useMarketStore.getState().candles[`${target}:${tf}`];
    if (!bars || bars.length < 30) {
      // Cold-start race: warm-up can fire before WebSocket candles
      // arrive. Retry a handful of times so the first decision lands
      // promptly instead of waiting the full round-robin window.
      if (retry < 5) {
        setTimeout(() => void refresh(target, retry + 1), 3000);
      }
      return;
    }

    const lastClose = bars.at(-1)?.close;
    if (lastClose == null || !Number.isFinite(lastClose) || lastClose <= 0) return;

    const portfolio = usePortfolioStore.getState();
    const openCount = portfolio.positions.filter(
      (p) => p.status === "OPEN" || p.status === "PARTIALLY_CLOSED",
    ).length;
    const hasThisSymbol = portfolio.positions.some(
      (p) =>
        p.symbol === target &&
        (p.status === "OPEN" || p.status === "PARTIALLY_CLOSED"),
    );

    // Skip AI analysis entirely if we already have an open trade on this coin.
    // It will resume automatically once the trade is closed.
    if (hasThisSymbol) {
      return;
    }

    inFlightRef.current[target] = true;
    setLoading(target, true);
    try {
      // Sentiment fetched in parallel — service owns its own cache. We
      // tolerate null so the LLM call still runs in degraded mode.
      const sentimentPromise = getSentiment(target).catch(() => null);
      const sentimentRes = await sentimentPromise;
      const sentiment = sentimentRes?.ok ? sentimentRes.sentiment : undefined;

      const windowed = bars.slice(-CANDLE_WINDOW);

      const res = await getStrategyDecision({
        symbol: target,
        timeframe: tf,
        candles: windowed,
        sentiment,
        portfolio: {
          accountBalance: portfolio.walletBalance - portfolio.usedMargin,
          openPositionsCount: openCount,
          hasOpenPositionThisSymbol: hasThisSymbol,
        },
      });
      if (res.ok && res.decision && res.generatedAt && res.key) {
        const srcTag =
          res.source === "prefilter"
            ? "[prefilter]"
            : res.source === "local-fallback"
              ? "[fallback]"
              : "[LLM]";
        console.info(
          `${srcTag} ${target} → ${res.decision.decision} conf=${res.decision.confidence} setup=${res.decision.setupQuality} exec=${res.decision.executeTrade} (${res.provider ?? "groq"}:${res.model ?? "?"})`,
        );
        setDecision(target, {
          decision: res.decision,
          generatedAt: res.generatedAt,
          provider: res.provider ?? "groq",
          model: res.model ?? "unknown",
          key: res.key,
        });
      } else {
        console.warn(`[LLM] ${target} decision failed: ${res.error ?? "unknown"}`);
        setError(target, res.error ?? "Unknown error");
      }
    } catch (err) {
      console.error(
        `[LLM] ${target} request error:`,
        err instanceof Error ? err.message : err,
      );
      setError(target, err instanceof Error ? err.message : "Request failed");
    } finally {
      inFlightRef.current[target] = false;
      setLoading(target, false);
    }
  };

  // Initial fan-out — staggered hard so we don't blow the TPM bucket on
  // startup. With 5 symbols × ~3K tokens each, we need ≥15s between calls
  // to stay inside Groq's 12K-token-per-60s window on the decision model.
  useEffect(() => {
    const STAGGER_MS = 15_000;
    const timers: ReturnType<typeof setTimeout>[] = [];
    WATCHLIST_SYMBOLS.forEach((sym, i) => {
      timers.push(setTimeout(() => void refresh(sym), i * STAGGER_MS));
    });
    return () => {
      timers.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Round-robin: one symbol every (cycle / N) ms.
  useEffect(() => {
    let cursor = 0;
    const tickMs = Math.max(
      15_000,
      Math.floor(FULL_CYCLE_MS / WATCHLIST_SYMBOLS.length),
    );
    const timer = setInterval(() => {
      const target = WATCHLIST_SYMBOLS[cursor];
      cursor = (cursor + 1) % WATCHLIST_SYMBOLS.length;
      void refresh(target);
    }, tickMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fire fresh fetch when the user switches symbol/timeframe.
  const lastTriggerRef = useRef<string>("");
  useEffect(() => {
    const trigger = `${symbol}:${interval}`;
    if (lastTriggerRef.current === trigger) return;
    lastTriggerRef.current = trigger;
    void refresh(symbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval]);

  return null;
}
