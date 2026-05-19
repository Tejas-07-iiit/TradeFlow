"use client";

import { useEffect, useRef } from "react";

import { fetchNewsFeed } from "@/server/news";
import { useNewsStore } from "@/store/news-store";

/**
 * Mounts in the platform layout; keeps the news store fresh.
 *
 * On mount: immediate fetch.
 * Then: every 5 minutes (matches the service-level cache TTL so we don't
 * spend a roundtrip just to get the same cached payload).
 *
 * Visibility-aware: pauses while the tab is hidden, refreshes immediately on
 * tab-visible so a user returning after lunch doesn't see stale headlines.
 */
const REFRESH_MS = 5 * 60 * 1000;

export function NewsSubscriber() {
  const setFeed = useNewsStore((s) => s.setFeed);
  const setLoading = useNewsStore((s) => s.setLoading);
  const setError = useNewsStore((s) => s.setError);

  const inFlightRef = useRef(false);

  const refresh = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    try {
      const res = await fetchNewsFeed();
      if (res.ok && res.feed) setFeed(res.feed);
      else if (res.error) setError(res.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : "News fetch failed");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
