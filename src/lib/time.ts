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
