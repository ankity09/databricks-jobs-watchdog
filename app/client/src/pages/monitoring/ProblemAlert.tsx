import { Alert, AlertDescription, AlertTitle, Button } from "@databricks/appkit-ui/react";
import { CircleAlert, RotateCw } from "lucide-react";
import { describeProblem, type QueryProblem } from "../../lib/queryProblem";
import { cn } from "../../lib/utils";

export interface ProblemAlertProps {
  problem: QueryProblem;
  /** "catalog.schema", named in the text. */
  location: string | null;
  /** Replaces the problem's own title, for a section ("Could not load the scan history"). */
  title?: string;
  /** Replaces the problem's own text. */
  detail?: string;
  /** Calls bump(), so every query runs again. */
  onRetry(this: void): void;
  className?: string;
}

/** A query that has no answer: what went wrong, the next step, and Retry. */
export function ProblemAlert({ problem, location, title, detail, onRetry, className }: ProblemAlertProps) {
  const text = describeProblem(problem, location);
  return (
    <Alert className={cn("flex items-start gap-3 border-border bg-card py-3", className)}>
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <AlertTitle className="line-clamp-none text-sm font-semibold text-foreground">{title ?? text.title}</AlertTitle>
        <AlertDescription className="mt-0.5 text-sm text-pretty text-muted-foreground">{detail ?? text.detail}</AlertDescription>
      </div>
      <Button variant="outline" size="sm" className="shrink-0" onClick={onRetry}>
        <RotateCw aria-hidden="true" />
        Retry
      </Button>
    </Alert>
  );
}
