/** A job's or a check's status, worst first. The scan writes these to findings.status. */
export const STATUSES = ["FAILED", "WARNING", "UNKNOWN", "HEALTHY"] as const;

export type Status = (typeof STATUSES)[number];

export type StatusTone = "destructive" | "warning" | "muted" | "success";

/** FAILED 3, WARNING 2, UNKNOWN 1, HEALTHY 0, the order the job_live_status query uses. */
export function statusRank(s: Status): 3 | 2 | 1 | 0 {
  switch (s) {
    case "FAILED":
      return 3;
    case "WARNING":
      return 2;
    case "UNKNOWN":
      return 1;
    case "HEALTHY":
      return 0;
  }
}

/** The worst status of a list. An empty list is UNKNOWN: nothing is known about it. */
export function worstStatus(list: Status[]): Status {
  if (list.length === 0) return "UNKNOWN";
  return list.reduce((worst, s) => (statusRank(s) > statusRank(worst) ? s : worst));
}

/** The theme color for a status: the --destructive, --warning, --muted-foreground or --success variable. */
export function statusTone(s: Status): StatusTone {
  switch (s) {
    case "FAILED":
      return "destructive";
    case "WARNING":
      return "warning";
    case "UNKNOWN":
      return "muted";
    case "HEALTHY":
      return "success";
  }
}

/** A status string from a query row. Anything unexpected is UNKNOWN. */
export function toStatus(value: unknown): Status {
  return STATUSES.find((s) => s === value) ?? "UNKNOWN";
}
