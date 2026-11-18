import { Button } from "@databricks/appkit-ui/react";
import { CircleAlert, RotateCw } from "lucide-react";
import { describeProblem, type QueryProblem } from "../../lib/queryProblem";

export interface QueryProblemLineProps {
  /** What is missing, without a full stop, such as "Live status is not available". */
  title: string;
  problem: QueryProblem;
  /** "catalog.schema", named in the text. */
  location: string | null;
  /** A sentence after the next step, such as what the page shows meanwhile. */
  note?: string;
  /** Runs the queries again (bump()). */
  onRetry: () => void;
}

/**
 * A Watchdog query that has no answer, in one line under the page header:
 * what is missing, then why and the next step in Monitoring's words (it names
 * the schema and the grants to ask for), and Retry.
 */
export function QueryProblemLine({ title, problem, location, note, onRetry }: QueryProblemLineProps) {
  const { detail } = describeProblem(problem, location);
  return (
    <div
      role="status"
      data-slot="query-problem"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-muted-foreground"
    >
      <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 leading-5 text-pretty">
        <span className="font-medium text-foreground">{title}.</span> {note ? `${detail} ${note}` : detail}
      </p>
      <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2" onClick={onRetry}>
        <RotateCw className="size-3.5" aria-hidden="true" />
        Retry
      </Button>
    </div>
  );
}
