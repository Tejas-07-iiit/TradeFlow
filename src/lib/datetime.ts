/**
 * Centralized time/date helpers.
 *
 * All data is stored and transmitted in UTC. Display layers should use these
 * helpers so the user sees their local timezone — never a mix of UTC and local
 * across the app.
 */

import type {
  BusinessDay,
  Time,
  UTCTimestamp,
} from "lightweight-charts";

function isUtcTimestamp(t: Time): t is UTCTimestamp {
  return typeof t === "number";
}

function isBusinessDay(t: Time): t is BusinessDay {
  return typeof t === "object" && t !== null && "day" in t;
}

/**
 * Convert a lightweight-charts `Time` to a JavaScript `Date` in UTC, suitable
 * for feeding into Intl formatters that will then localize. Throws for unknown
 * shapes — we don't pass strings into the chart so that branch shouldn't occur.
 */
function chartTimeToDate(time: Time): Date {
  if (isUtcTimestamp(time)) return new Date(time * 1000);
  if (isBusinessDay(time)) {
    return new Date(Date.UTC(time.year, time.month - 1, time.day));
  }
  // ISO "yyyy-mm-dd" fallback.
  return new Date(time);
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
});

/**
 * For lightweight-charts `localization.timeFormatter`. Renders the crosshair
 * label in the viewer's local timezone instead of UTC. Returns date+time for
 * intraday candles so the user sees both the day and the minute.
 */
export function chartTimeFormatter(time: Time): string {
  return dateTimeFormat.format(chartTimeToDate(time));
}

/**
 * For lightweight-charts `timeScale.tickMarkFormatter`. Renders axis tick
 * labels in local time. lightweight-charts already chooses tick granularity;
 * we just localize the value.
 */
export function chartTickMarkFormatter(time: Time): string {
  const date = chartTimeToDate(time);
  // Crude heuristic: midnight ticks get the date; everything else gets HH:MM.
  // lightweight-charts requests both granularities at different zoom levels,
  // so each tick is formatted based on its own value, not a global mode.
  if (date.getHours() === 0 && date.getMinutes() === 0) {
    return dateFormat.format(date);
  }
  return timeFormat.format(date);
}

/** General-purpose: format any UTC moment (ms, ISO, or Date) in local TZ. */
export function formatLocalDateTime(input: number | string | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  return dateTimeFormat.format(d);
}

export function formatLocalTime(input: number | string | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  return timeFormat.format(d);
}
