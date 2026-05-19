"use client";

import { create } from "zustand";

import type { MarketBias, MarketThesis, SetupQuality } from "@/services/ai/schemas";

export interface ThesisEntry {
  thesis: MarketThesis;
  generatedAt: string;
  provider: string;
  model: string;
}

interface AiThesisState {
  /** symbol → most recent thesis we've successfully fetched */
  bySymbol: Record<string, ThesisEntry | undefined>;
  /** symbols that currently have an in-flight fetch */
  loading: Record<string, boolean | undefined>;
  /** last error message per symbol, cleared on next success */
  error: Record<string, string | undefined>;

  setThesis: (symbol: string, entry: ThesisEntry) => void;
  setLoading: (symbol: string, loading: boolean) => void;
  setError: (symbol: string, error: string | undefined) => void;
}

export const useAiThesisStore = create<AiThesisState>((set) => ({
  bySymbol: {},
  loading: {},
  error: {},
  setThesis: (symbol, entry) =>
    set((s) => ({
      bySymbol: { ...s.bySymbol, [symbol]: entry },
      error: { ...s.error, [symbol]: undefined },
    })),
  setLoading: (symbol, loading) =>
    set((s) => ({ loading: { ...s.loading, [symbol]: loading } })),
  setError: (symbol, error) =>
    set((s) => ({ error: { ...s.error, [symbol]: error } })),
}));

export type { MarketBias, MarketThesis, SetupQuality };
