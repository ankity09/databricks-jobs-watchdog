import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@databricks/appkit-ui/react";
import { Check, ChevronRight, Copy, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { CopilotQuery } from "../../hooks/useCopilot";
import { cn } from "../../lib/utils";

/** loading: the rows are on their way; ready: they came back; missing: they will not come (an expired or failed result). */
export type ResultState = "loading" | "ready" | "missing";

export interface SqlDisclosureProps {
  query: CopilotQuery;
  /** The signed-in person's email. Genie runs each query as the person asking. */
  ranAs: string | null;
  resultState: ResultState;
  /** Fetches the rows again. Without it, only asking again brings them back. */
  onRetryRows?: () => void;
}

/** The table shows at most this many rows of a result. */
const MAX_ROWS = 20;

/** Keys made from the content, for rows and columns that have no ID; a repeated value gets a running count. */
function contentKeys(values: string[]): string[] {
  const seen = new Map<string, number>();
  return values.map((value) => {
    const count = seen.get(value) ?? 0;
    seen.set(value, count + 1);
    return count === 0 ? value : `${value}#${count}`;
  });
}

function ResultTable({ query, resultState, onRetryRows }: Pick<SqlDisclosureProps, "query" | "resultState" | "onRetryRows">) {
  if (resultState === "loading" && !query.result) {
    return (
      <div className="space-y-1.5 px-3 py-3" aria-label="Loading the rows">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3.5 w-1/2" />
      </div>
    );
  }
  if (!query.result) {
    if (!onRetryRows) return <p className="px-3 py-2.5 text-xs text-muted-foreground">The rows are not available. Ask again to run the query again.</p>;
    return (
      <div className="flex items-center gap-3 px-3 py-2">
        <p className="text-xs text-muted-foreground">The rows are not available.</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetryRows} className="h-7 gap-1.5 px-2.5 text-xs">
          <RotateCw aria-hidden="true" className="size-3.5" />
          Retry
        </Button>
      </div>
    );
  }
  const { columns, rows } = query.result;
  if (rows.length === 0) return <p className="px-3 py-2.5 text-xs text-muted-foreground">The query returned no rows.</p>;
  const columnKeys = contentKeys(columns);
  const keyedColumns = columns.map((name, position) => ({ key: columnKeys[position], name }));
  const shown = rows.slice(0, MAX_ROWS);
  const rowKeys = contentKeys(shown.map((row) => JSON.stringify(row)));
  const keyedRows = shown.map((row, position) => ({ key: rowKeys[position], cells: columnKeys.map((key, column) => ({ key, value: row[column] ?? null })) }));
  return (
    <div className="border-t border-border">
      <div className="max-h-80 overflow-auto">
        <Table className="text-xs">
          <TableHeader className="sticky top-0 bg-muted">
            <TableRow>
              {keyedColumns.map((column) => (
                <TableHead key={column.key} className="h-8 px-3 font-mono text-[11px] font-medium text-muted-foreground">
                  {column.name}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {keyedRows.map((row) => (
              <TableRow key={row.key}>
                {row.cells.map((cell) => (
                  <TableCell key={cell.key} className="max-w-80 truncate px-3 py-1.5 font-mono text-xs" title={cell.value ?? "null"}>
                    {cell.value === null ? <span className="text-muted-foreground italic">null</span> : cell.value}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {rows.length > MAX_ROWS ? (
        <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          Showing {MAX_ROWS} of {rows.length} rows.
        </p>
      ) : null}
    </div>
  );
}

/** One query behind an answer: who it ran as, and, on request, its SQL and a small result table. */
export function SqlDisclosure({ query, ranAs, resultState, onRetryRows }: SqlDisclosureProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void navigator.clipboard?.writeText(query.sql).then(
      () => setCopied(true),
      () => undefined,
    );
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="overflow-hidden rounded-md border border-border bg-muted/50">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1 pr-3 pl-1.5 text-xs">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-1.5 text-xs font-medium">
            <ChevronRight aria-hidden="true" className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
            {open ? "Hide SQL" : "Show SQL"}
          </Button>
        </CollapsibleTrigger>
        {query.title ? <span className="min-w-0 truncate text-muted-foreground">{query.title}</span> : null}
        <span className="ml-auto flex min-w-0 items-center gap-1 text-muted-foreground">
          <span>Ran as</span>
          <span className="truncate font-mono text-[11px] text-foreground">{ranAs ?? "you, the signed-in person"}</span>
        </span>
      </div>
      <CollapsibleContent className="border-t border-border bg-background">
        {query.description ? <p className="px-3 pt-2.5 text-xs leading-5 text-muted-foreground">{query.description}</p> : null}
        <div className="flex items-center justify-between gap-3 px-3 pt-2">
          <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">SQL</span>
          <Button type="button" variant="outline" size="sm" onClick={copy} className="h-7 gap-1.5 px-2 text-xs">
            {copied ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
            {copied ? "Copied" : "Copy SQL"}
          </Button>
        </div>
        <pre className="max-h-72 overflow-auto px-3 pt-1.5 pb-2.5 font-mono text-xs leading-5 whitespace-pre text-foreground">
          <code>{query.sql}</code>
        </pre>
        <ResultTable query={query} resultState={resultState} onRetryRows={onRetryRows} />
      </CollapsibleContent>
    </Collapsible>
  );
}
