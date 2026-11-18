import type { QueryRows } from "../../hooks/useWatchdogRows";
import type { IncidentRow } from "../../lib/rows";
import { parseTime } from "../../lib/time";
import { compareText, jobKey } from "./jobs";

/** What Monitoring knows about one job's incidents (from the incidents view). Pure, so the page stays a thin layer. */
export interface JobIncidents {
  /** An open incident opened in its source's newest scan. */
  isNew: boolean;
  /** The open incidents, the oldest first. */
  open: IncidentRow[];
  /** The incidents that cleared in the last 24 hours, the newest first. */
  cleared: IncidentRow[];
}

/** The incidents by job (the key from jobKey). A job with none has no entry. */
export type IncidentsByJob = ReadonlyMap<string, JobIncidents>;

function ms(iso: string | null): number {
  return (iso === null ? null : parseTime(iso)) ?? 0;
}

export function groupIncidents(rows: readonly IncidentRow[]): IncidentsByJob {
  const byJob = new Map<string, JobIncidents>();
  for (const row of rows) {
    const key = jobKey(row);
    const entry = byJob.get(key) ?? { isNew: false, open: [], cleared: [] };
    if (row.state === "OPEN") {
      entry.open.push(row);
      if (row.is_new) entry.isNew = true;
    } else {
      entry.cleared.push(row);
    }
    byJob.set(key, entry);
  }
  for (const entry of byJob.values()) {
    entry.open.sort((a, b) => ms(a.opened_at) - ms(b.opened_at) || compareText(a.check_id, b.check_id));
    entry.cleared.sort((a, b) => ms(b.resolved_at) - ms(a.resolved_at) || compareText(a.check_id, b.check_id));
  }
  return byJob;
}

/** The keys of the jobs with a new open incident. */
export function newJobKeys(byJob: IncidentsByJob): Set<string> {
  const keys = new Set<string>();
  for (const [key, entry] of byJob) if (entry.isNew) keys.add(key);
  return keys;
}

/**
 * Whether Monitoring can show the incident parts. A missing view (an older schema, before notebook 01 has run)
 * makes the query fail. AppKit often does not say why, so a failure with no answer to keep is "unavailable",
 * and the reason is only as specific as the message. The page still works without the parts.
 */
export type IncidentsUnavailable = "missing" | "no-access" | "unreadable" | "shape";
export type IncidentsView = { status: "loading" } | { status: "unavailable"; reason: IncidentsUnavailable } | { status: "ready"; byJob: IncidentsByJob };

const NOT_FOUND = /TABLE_OR_VIEW_NOT_FOUND|NOT_FOUND/;
const NO_ACCESS = /INSUFFICIENT_PERMISSIONS|PERMISSION_DENIED|NO_ACCESS/;

/** What the error says, when AppKit passes the reason on: a missing view, no access, or nothing definite. */
function queryReason(message: string, code: string | null): IncidentsUnavailable {
  const text = `${code ?? ""} ${message}`;
  if (NO_ACCESS.test(text)) return "no-access";
  if (NOT_FOUND.test(text)) return "missing";
  return "unreadable";
}

export function incidentsView(result: QueryRows<IncidentRow>): IncidentsView {
  if (result.rows !== null) return { status: "ready", byJob: groupIncidents(result.rows) };
  if (result.problem?.kind === "query") return { status: "unavailable", reason: queryReason(result.problem.message, result.problem.code) };
  if (result.problem?.kind === "shape") return { status: "unavailable", reason: "shape" };
  return { status: "loading" };
}
