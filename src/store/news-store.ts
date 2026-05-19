"use client";

import { create } from "zustand";

import type { NewsFeed } from "@/services/news";

interface NewsState {
  feed: NewsFeed | null;
  loading: boolean;
  error: string | null;

  setFeed: (feed: NewsFeed) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useNewsStore = create<NewsState>((set) => ({
  feed: null,
  loading: false,
  error: null,

  setFeed: (feed) => set({ feed, error: null }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}));
