import { type Status, STATUSES, statusTone } from "../../lib/status";
import { cn } from "../../lib/utils";
import { STATUS_LABEL, TONE_FILL, TONE_SELECTED } from "./format";

export interface SummaryCountsProps {
  counts: Record<Status, number>;
  /** The status the table is filtered to, if any. */
  selected: Status | null;
  /** Called with the clicked status, or with null when the selected one is clicked again. */
  onSelect(this: void, status: Status | null): void;
  /** How many jobs have a new open incident. Null leaves the tile out (the incidents are not available). */
  newCount?: number | null;
  /** The table is filtered to the jobs with a new open incident. */
  newSelected?: boolean;
  onSelectNew?(this: void, selected: boolean): void;
}

/** How many jobs are failed, warning, unknown and healthy. Each count is a toggle that filters the table. */
export function SummaryCounts({ counts, selected, onSelect, newCount = null, newSelected = false, onSelectNew }: SummaryCountsProps) {
  return (
    <div role="group" aria-label="Jobs by status" className={cn("grid grid-cols-2 gap-3", newCount === null ? "lg:grid-cols-4" : "lg:grid-cols-5")}>
      {STATUSES.map((status) => {
        const tone = statusTone(status);
        const pressed = selected === status;
        const count = counts[status];
        return (
          <button
            key={status}
            type="button"
            aria-pressed={pressed}
            onClick={() => onSelect(pressed ? null : status)}
            className={cn(
              "flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3 text-left shadow-xs transition-colors",
              "outline-none hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring",
              pressed && TONE_SELECTED[tone],
            )}
          >
            <span className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
              <span className={cn("size-2 shrink-0 rounded-full", TONE_FILL[tone])} aria-hidden="true" />
              {STATUS_LABEL[status]}
            </span>
            <span className="sr-only">: </span>
            <span className={cn("font-mono text-[26px] leading-none font-medium tabular-nums", count === 0 ? "text-muted-foreground" : "text-foreground")}>{count}</span>
            <span className="sr-only">{count === 1 ? " job" : " jobs"}</span>
          </button>
        );
      })}
      {newCount === null ? null : (
        <button
          type="button"
          aria-pressed={newSelected}
          onClick={() => onSelectNew?.(!newSelected)}
          className={cn(
            "flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3 text-left shadow-xs transition-colors",
            "outline-none hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring",
            newSelected && "border-primary/60 bg-primary/[0.04]",
          )}
        >
          <span className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
            <span className="size-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
            New this scan
          </span>
          <span className="sr-only">: </span>
          <span className={cn("font-mono text-[26px] leading-none font-medium tabular-nums", newCount === 0 ? "text-muted-foreground" : "text-foreground")}>{newCount}</span>
          <span className="sr-only">{newCount === 1 ? " job" : " jobs"}</span>
        </button>
      )}
    </div>
  );
}
