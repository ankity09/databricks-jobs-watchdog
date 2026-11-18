const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A zone suffix such as Z, +02:00 or -0500. */
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Milliseconds since the epoch, or null when the value is not a time.
 * Databricks SQL sends ISO times with a Z; a time with no zone is read as UTC.
 */
export function parseTime(iso: string): number | null {
  const value = iso.trim();
  if (!value) return null;
  const normalized = HAS_ZONE.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

/** "12 min ago", "3 h ago" or "2 days ago". The last minute, and a time a little ahead of now, are "just now". */
export function formatAgo(iso: string, now: Date): string {
  const ms = parseTime(iso);
  if (ms === null) return "unknown";
  const elapsed = now.getTime() - ms;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  const days = Math.floor(elapsed / DAY);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "2026-11-05 10:05 UTC". */
export function formatUtc(iso: string): string {
  const ms = parseTime(iso);
  if (ms === null) return "unknown";
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "10:05 UTC" when `iso` is on the same UTC day as `earlier`, else the full formatUtc. For an end after a start. */
export function formatUtcAfter(iso: string, earlier: string): string {
  const full = formatUtc(iso);
  const start = formatUtc(earlier);
  return full !== "unknown" && full.slice(0, 10) === start.slice(0, 10) ? full.slice(11) : full;
}
