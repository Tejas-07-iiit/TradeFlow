import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AIDecision } from "@/types/ai-decision";

interface SignalState {
  history: AIDecision[];
  activeSignals: Record<string, AIDecision | null>; // symbol -> signal
  addSignal: (signal: AIDecision) => void;
  updateSignalStatus: (symbol: string, status: AIDecision["status"]) => void;
  clearHistory: () => void;
  checkExpirations: () => void;
}

export const useSignalStore = create<SignalState>()(
  persist(
    (set, get) => ({
      history: [],
      activeSignals: {},
      addSignal: (signal) =>
        set((state) => {
          const active = state.activeSignals[signal.symbol];
          
          // Cooldown/Duplicate logic: 
          // If there's an active signal of the same type, don't add
          if (active && active.type === signal.type && active.status === "ACTIVE") {
            return state;
          }

          // If signal was COMPLETED or EXPIRED recently, we can allow a new one
          // but for intraday, we usually want at least a small gap.
          
          const newActive = { ...state.activeSignals, [signal.symbol]: signal };
          const newHistory = [signal, ...state.history].slice(0, 100);
          
          return { 
            activeSignals: newActive,
            history: newHistory 
          };
        }),
      updateSignalStatus: (symbol, status) => 
        set((state) => {
          const active = state.activeSignals[symbol];
          if (!active) return state;

          const updated = { ...active, status };
          return {
            activeSignals: { ...state.activeSignals, [symbol]: updated },
            history: state.history.map(s => 
              s.generatedAt === active.generatedAt && s.symbol === symbol 
                ? { ...s, status } 
                : s
            )
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
      clearHistory: () => set({ history: [], activeSignals: {} }),
    }),
    {
      name: "tradeflow-signals-v2",
    }
  )
);
