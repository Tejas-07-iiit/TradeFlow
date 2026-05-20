"use client";

import { useEffect, useRef } from "react";

import { WATCHLIST_SYMBOLS } from "@/lib/market/symbols";
import { calculateIndicators } from "@/lib/signals/signal-engine";
import { getMarketThesis } from "@/server/ai-thesis";
import { getSentiment } from "@/server/sentiment";
import { useAiThesisStore } from "@/store/ai-thesis-store";
import { useMarketStore } from "@/store/market-store";
import { useSignalStore } from "@/store/signal-store";

/**
 * Refresh interval per symbol. With 5 symbols, the round-robin tick fires
 * every (CYCLE / N) = 36s, so each symbol gets a fresh thesis every ~3 min.
 */
const FULL_CYCLE_MS = 3 * 60 * 1000;

/**
 * Global multi-symbol thesis refresher. Mounted at the platform layout.
 *
 * Strategy:
 *   - On mount, fan-out and request a thesis for every watchlist symbol in
 *     parallel (with a small stagger so we don't hit the provider with a
 *     simultaneous burst).
 *   - After warm-up, enter round-robin: every (FULL_CYCLE_MS / N) ms, refresh
 *     ONE symbol. By the time we wrap around, the oldest entry is ~3 min old.
 *   - Also kick a fresh refresh when the active symbol or its rule signal
 *     transitions — the user actively looking at a symbol expects a current
 *     read.
 *
 * Per-symbol in-flight guard prevents two outstanding requests for the same
 * symbol if a round-robin tick lands while a manual trigger is still running.
 */
export function AiThesisSubscriber() {
  const symbol = useMarketStore((s) => s.symbol);
  const interval = useMarketStore((s) => s.interval);

  const setThesis = useAiThesisStore((s) => s.setThesis);
  const setLoading = useAiThesisStore((s) => s.setLoading);
  const setError = useAiThesisStore((s) => s.setError);

  const inFlightRef = useRef<Record<string, boolean>>({});
  const intervalRef = useRef(interval);
  intervalRef.current = interval;

  const activeSignal = useSignalStore((s) => s.activeSignals[symbol]);
  const lastTriggerRef = useRef<string>("");

  const refresh = async (target: string) => {
    if (inFlightRef.current[target]) return;
    const tf = intervalRef.current;
    const bars = useMarketStore.getState().candles[`${target}:${tf}`];
    if (!bars || bars.length < 30) return;

    const indicators = calculateIndicators(bars);
    const lastClose = bars.at(-1)?.close;
    if (lastClose == null) return;

    const ruleSignal = useSignalStore.getState().activeSignals[target];

    inFlightRef.current[target] = true;
    setLoading(target, true);
    try {
      const sentimentPromise = getSentiment(target).catch(() => null);
      const sentimentRes = await sentimentPromise;
      const sentiment = sentimentRes?.ok ? sentimentRes.sentiment : undefined;

      const res = await getMarketThesis({
        symbol: target,
        timeframe: tf,
        price: lastClose,
        marketRegime: indicators.regime,
        ruleSignal: ruleSignal?.signal ?? "HOLD",
        ruleConfidence: ruleSignal?.confidence ?? 50,
        indicators: {
          ema50: indicators.ema50,
          ema200: indicators.ema200,
          rsi14: indicators.rsi14,
          atr14: indicators.atr14,
          adx14: indicators.adx14,
          atrPct: indicators.atrPct,
        },
        sentiment,
      });
      if (res.ok && res.thesis && res.generatedAt) {
        setThesis(target, {
          thesis: res.thesis as ThesisEntryThesis,
          generatedAt: res.generatedAt,
          provider: res.provider ?? "groq",
          model: res.model ?? "unknown",
        });
      } else {
        setError(target, res.error ?? "Unknown error");
      }
    } catch (err) {
      setError(target, err instanceof Error ? err.message : "Request failed");
    } finally {
      inFlightRef.current[target] = false;
      setLoading(target, false);
    }
  };

  // Initial fan-out across watchlist symbols, lightly staggered so the
  // provider sees them as discrete requests rather than a thundering herd.
  useEffect(() => {
    const STAGGER_MS = 3000;
    const timers: ReturnType<typeof setTimeout>[] = [];
    WATCHLIST_SYMBOLS.forEach((sym, i) => {
      timers.push(setTimeout(() => void refresh(sym), i * STAGGER_MS));
    });
    return () => {
      timers.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Round-robin: one symbol refreshed every (cycle / N) ms.
  useEffect(() => {
    let cursor = 0;
    const tickMs = Math.max(15_000, Math.floor(FULL_CYCLE_MS / WATCHLIST_SYMBOLS.length));
    const timer = setInterval(() => {
      const target = WATCHLIST_SYMBOLS[cursor];
      cursor = (cursor + 1) % WATCHLIST_SYMBOLS.length;
      void refresh(target);
    }, tickMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On-demand refresh for whatever symbol the user is currently looking at,
  // gated on (symbol, interval, ruleSignal, signal-generatedAt) so it fires
  // exactly once per transition, not per render.
  useEffect(() => {
    const trigger = `${symbol}:${interval}:${activeSignal?.signal ?? "HOLD"}:${activeSignal?.generatedAt ?? ""}`;
    if (lastTriggerRef.current === trigger) return;
    lastTriggerRef.current = trigger;
    void refresh(symbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, activeSignal?.signal, activeSignal?.generatedAt]);

  return null;
}

type ThesisEntryThesis = import("@/services/ai/schemas").MarketThesis;
