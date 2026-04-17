// Relative-time formatter shared by the creator profile metrics row and
// future list surfaces (applications/submissions). Matches the "x ago"
// casing used throughout docs/design.md — plain-English, no i18n for v1.
//
// `now` is injectable so tests and the eventual metric-refresh realtime
// subscription can anchor the result without faking the system clock.

export function formatRelativeTime(
  date: Date | null | undefined,
  now: Date = new Date(),
): string {
  if (!date) return 'Never';
  const diffMs = Math.max(0, now.getTime() - date.getTime());
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const month = 30 * day;
  const year = 365 * day;

  if (diffMs < minute) return 'just now';
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs < month) return `${Math.floor(diffMs / day)}d ago`;
  if (diffMs < year) return `${Math.floor(diffMs / month)}mo ago`;
  return `${Math.floor(diffMs / year)}y ago`;
}

// Formats a `retry_after_sec` value from the metrics-refresh 429 body as
// "Xh Ym" (or "Ym"/"Xh") for the rate-limit toast per US-036 AC. Rounds up
// to the next whole minute so a 200s retry reads "4m" not "3m".
export function formatRetryAfter(seconds: number): string {
  const safe = Math.max(0, Math.ceil(seconds));
  const minutes = Math.ceil(safe / 60);
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
