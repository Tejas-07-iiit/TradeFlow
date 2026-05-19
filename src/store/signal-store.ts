import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AIDecision } from "@/types/ai-decision";

/**
 * A signal's execution identity. Two signals from the same symbol generated
 * at the same instant collapse — that's intentional: re-rendering must never
 * fire a duplicate order.
 */
const executionKey = (signal: AIDecision) =>
  `${signal.symbol}:${signal.generatedAt}`;

interface AutoExecState {
  /** Signal direction we last auto-fired for this symbol. */
  signal: "BUY" | "SELL";
  /** Setup type we last fired on — flipping setup type within same direction still counts as new event. */
  type: string;
  /** ms timestamp. Used for the cooldown to suppress flap. */
  executedAt: number;
}

interface SignalState {
  history: AIDecision[];
  /** symbol → currently-active signal (or null) */
  activeSignals: Record<string, AIDecision | null>;
  /**
   * Keys of signals we've already auto-executed (or manually fired). Persisted
   * so that page refresh / navigation can't replay the same paper order.
   *
   * NOTE: this map is keyed by symbol:generatedAt and was useful for the
   * old manual-execute flow. The auto-executor uses `autoExec` below instead,
   * which dedupes on *signal transition* rather than timestamp (the rule
   * engine stamps generatedAt every tick).
   */
  executedSignalIds: Record<string, true>;
  /** Per-symbol last auto-executed transition. The auto-executor checks this. */
  autoExec: Record<string, AutoExecState | undefined>;
  /** History of all auto-executions across all symbols. */
  autoExecHistory: (AutoExecState & { symbol: string })[];

  addSignal: (signal: AIDecision) => void;
  updateSignalStatus: (symbol: string, status: AIDecision["status"]) => void;
  clearHistory: () => void;
  checkExpirations: () => void;
  /** Records a signal as executed. Idempotent. */
  markSignalExecuted: (signal: AIDecision) => void;
  /** Lookup helper. */
  hasExecuted: (signal: AIDecision) => boolean;
  /** Record an auto-execution transition for a symbol. */
  markAutoExecuted: (symbol: string, signal: "BUY" | "SELL", type: string) => void;
}

export const useSignalStore = create<SignalState>()(
  persist(
    (set, get) => ({
      history: [],
      activeSignals: {},
      executedSignalIds: {},
      autoExec: {},
      autoExecHistory: [],
      addSignal: (signal) =>
        set((state) => {
          const active = state.activeSignals[signal.symbol];

          // Cooldown/Duplicate logic:
          // If there's an active signal of the same type, don't add
          if (active && active.type === signal.type && active.status === "ACTIVE") {
            return state;
          }

          const newActive = { ...state.activeSignals, [signal.symbol]: signal };
          const newHistory = [signal, ...state.history].slice(0, 100);

          return {
            activeSignals: newActive,
            history: newHistory,
          };
        }),
      updateSignalStatus: (symbol, status) =>
        set((state) => {
          const active = state.activeSignals[symbol];
          if (!active) return state;

          const updated = { ...active, status };
          return {
            activeSignals: { ...state.activeSignals, [symbol]: updated },
            history: state.history.map((s) =>
              s.generatedAt === active.generatedAt && s.symbol === symbol
                ? { ...s, status }
                : s,
            ),
          };
        }),
      checkExpirations: () => {
        const now = new Date().toISOString();
        const { activeSignals, updateSignalStatus } = get();
        Object.entries(activeSignals).forEach(([symbol, signal]) => {
          if (signal && signal.status === "ACTIVE" && signal.expiresAt < now) {
            updateSignalStatus(symbol, "EXPIRED");
          }
        });
      },
      clearHistory: () =>
        set({
          history: [],
          activeSignals: {},
          executedSignalIds: {},
          autoExec: {},
          autoExecHistory: [],
        }),
      markSignalExecuted: (signal) =>
        set((state) => {
          const key = executionKey(signal);
          if (state.executedSignalIds[key]) return state;
          return {
            executedSignalIds: { ...state.executedSignalIds, [key]: true },
          };
        }),
      hasExecuted: (signal) => Boolean(get().executedSignalIds[executionKey(signal)]),
      markAutoExecuted: (symbol, signal, type) =>
        set((state) => {
          const event = { symbol, signal, type, executedAt: Date.now() };
          return {
            autoExec: {
              ...state.autoExec,
              [symbol]: event,
            },
            autoExecHistory: [event, ...state.autoExecHistory].slice(0, 50),
          };
        }),
    }),
    {
      name: "tradeflow-signals-v5",
    },
  ),
);

export { executionKey };
