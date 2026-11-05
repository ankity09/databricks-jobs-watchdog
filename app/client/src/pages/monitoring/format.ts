import type { Status, StatusTone } from "../../lib/status";
import type { Severity } from "./jobs";

/** Words and colors for the Monitoring page. Colors are the theme's status tokens, never raw hex. */

export const STATUS_LABEL: Record<Status, string> = { FAILED: "Failed", WARNING: "Warning", UNKNOWN: "Unknown", HEALTHY: "Healthy" };

export const SEVERITY_LABEL: Record<Severity, string> = { CRITICAL: "Critical", WARNING: "Warning" };

/** Text in the status color. */
export const TONE_TEXT: Record<StatusTone, string> = {
  destructive: "text-destructive",
  warning: "text-warning",
  muted: "text-muted-foreground",
  success: "text-success",
};

/** A solid fill in the status color, for dots and history cells. */
export const TONE_FILL: Record<StatusTone, string> = {
  destructive: "bg-destructive",
  warning: "bg-warning",
  muted: "bg-muted-foreground/50",
  success: "bg-success",
};

/** A tinted chip: status-colored text and border on a light tint (AA on every status color). */
export const TONE_CHIP: Record<StatusTone, string> = {
  destructive: "border-destructive/25 bg-destructive/[0.06] text-destructive",
  warning: "border-warning/30 bg-warning/[0.07] text-warning",
  muted: "border-border bg-muted text-muted-foreground",
  success: "border-success/25 bg-success/[0.06] text-success",
};

/** The border of a selected summary count. */
export const TONE_SELECTED: Record<StatusTone, string> = {
  destructive: "border-destructive/60 bg-destructive/[0.04]",
  warning: "border-warning/60 bg-warning/[0.05]",
  muted: "border-muted-foreground/50 bg-muted/70",
  success: "border-success/60 bg-success/[0.04]",
};

const SOURCES: Record<string, string> = { SYSTEM_TABLES: "System tables", JOBS_API: "Jobs API", CUSTOM: "Custom check" };

export function sourceLabel(source: string): string {
  return SOURCES[source] ?? source;
}

const TRIGGERS: Record<string, string> = {
  SCHEDULE: "Schedule",
  ONE_TIME: "Run now or the API",
  RETRY: "Retry",
  CONTINUOUS: "Continuous",
  FILE_ARRIVAL: "File arrival",
  TABLE_UPDATE: "Table update",
  JOB_TASK: "Another job",
};

export function triggerLabel(trigger: string, by: string | null): string {
  const label = TRIGGERS[trigger] ?? trigger;
  return by ? `${label}, by ${by}` : label;
}

const CATEGORIES: Record<string, string> = {
  FUNCTIONAL: "Functional",
  INFRASTRUCTURE: "Infrastructure",
  SLA_EXCEEDED: "SLA exceeded",
  SCHEDULE_GAP: "Schedule gap",
  RETRY_LOOP: "Retry loop",
  COVERAGE: "Coverage",
};

/** The failure category, or null for NONE and empty. */
export function categoryLabel(category: string | null): string | null {
  if (category === null || category === "NONE" || category === "") return null;
  return CATEGORIES[category] ?? category;
}

/** A long commit hash in a code version cut to its first 7 characters: "feat/x@bf44b3b". Anything else stays as it is. */
export function shortCodeVersion(version: string): string {
  return version.replace(/(^|@)([0-9a-f]{7})[0-9a-f]{5,33}$/i, "$1$2");
}

/** "31 s", "4 min 12 s", "2 h 5 min". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return s % 60 === 0 ? `${minutes} min` : `${minutes} min ${s % 60} s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}
