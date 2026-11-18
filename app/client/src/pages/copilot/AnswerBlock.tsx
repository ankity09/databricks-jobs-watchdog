import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger, Skeleton, inferChartType, transformGenieData, type ChartType } from "@databricks/appkit-ui/react";
import { ChevronDown, Download, RotateCw } from "lucide-react";
import { Suspense, lazy, useMemo, useState } from "react";
import type { CopilotQuery } from "../../hooks/useCopilot";
import { cn } from "../../lib/utils";
import { AnswerTable } from "./AnswerTable";
import { chooseAnswerView, csvFileName, toCsv } from "./answerView";
import { SqlDisclosure, type ResultState } from "./SqlDisclosure";

const AnswerChart = lazy(() => import("./AnswerChart"));

/** The chart height in pixels; the skeleton's class below must match it. */
const CHART_HEIGHT = 260;

const TYPE_LABEL: Record<ChartType, string> = { bar: "Bar", line: "Line", area: "Area", pie: "Pie", donut: "Donut", scatter: "Scatter", heatmap: "Heatmap", radar: "Radar" };

export interface AnswerBlockProps {
  query: CopilotQuery;
  /** The signed-in person's email. Genie runs each query as the person asking. */
  ranAs: string | null;
  resultState: ResultState;
  /** Fetches the rows again. Without it, only asking again brings them back. */
  onRetryRows?: () => void;
  /** The last Retry for the rows failed. */
  retryFailed?: boolean;
}

type Mode = "chart" | "table";

function rowsLabel(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "row" : "rows"}`;
}

/** How long the CSV file's URL stays good after the click: the browser reads the file once the click has returned. */
const CSV_URL_LIFETIME_MS = 5_000;

/** Downloads the rows as a CSV file named after the answer. */
function downloadCsv(query: CopilotQuery, columns: string[], rows: (string | null)[][]) {
  const url = URL.createObjectURL(new Blob([toCsv(columns, rows)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = csvFileName(query.title);
  document.body.append(link);
  link.click();
  link.remove();
  // Not at once: revoking the URL right after click() can cancel the download.
  window.setTimeout(() => URL.revokeObjectURL(url), CSV_URL_LIFETIME_MS);
}

function ChartSkeleton() {
  return <Skeleton aria-label="Loading the chart" className="h-[260px] w-full" />;
}

/** One query behind an answer: a chart, a number or a table, with CSV and the SQL it ran. */
export function AnswerBlock({ query, ranAs, resultState, onRetryRows, retryFailed = false }: AnswerBlockProps) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [typeChoice, setTypeChoice] = useState<ChartType | null>(null);
  const view = useMemo(() => chooseAnswerView(query.statement), [query.statement]);
  const data = useMemo(() => transformGenieData(query.statement), [query.statement]);

  // A long list of categories starts as a table but may still be charted, so find its axes here.
  const plan = useMemo(() => {
    if (view.kind === "number" || view.choices.length === 0) return null;
    if (view.kind === "chart") return { xKey: view.xKey, yKey: view.yKey, defaultType: view.chartType, choices: view.choices };
    const inferred = data ? inferChartType(data.rows, data.columns) : null;
    if (!inferred) return null;
    return { xKey: inferred.xKey, yKey: inferred.yKey, defaultType: view.choices.includes("bar") ? "bar" : view.choices[0], choices: view.choices };
  }, [view, data]);

  const title = <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">{query.title ?? "Query result"}</h3>;

  if (resultState === "loading" && !query.result) {
    return (
      <section aria-label="Query result" className="flex flex-col gap-2">
        {title}
        <div className="space-y-1.5" aria-label="Loading the rows">
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-3.5 w-1/2" />
        </div>
        <SqlDisclosure query={query} ranAs={ranAs} />
      </section>
    );
  }

  if (!query.result) {
    return (
      <section aria-label="Query result" className="flex flex-col gap-2">
        {title}
        {onRetryRows ? (
          <div className="flex items-center gap-3">
            <p className="text-xs text-muted-foreground">The rows are not available.</p>
            {retryFailed ? (
              <p role="status" className="text-xs text-destructive">
                Could not load the rows.
              </p>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={onRetryRows} className="h-7 gap-1.5 px-2.5 text-xs">
              <RotateCw aria-hidden="true" className="size-3.5" />
              Retry
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">The rows are not available. Ask again to run the query again.</p>
        )}
        <SqlDisclosure query={query} ranAs={ranAs} />
      </section>
    );
  }

  const { columns, rows } = query.result;
  const activeMode: Mode = plan ? (mode ?? (view.kind === "chart" ? "chart" : "table")) : "table";
  const activeType = plan ? (typeChoice && plan.choices.includes(typeChoice) ? typeChoice : plan.defaultType) : null;
  const count = query.rowCount ?? rows.length;

  let body;
  if (rows.length === 0) {
    body = <p className="text-xs text-muted-foreground">The query returned no rows.</p>;
  } else if (view.kind === "number") {
    body = (
      <div className="flex flex-col gap-0.5 py-2">
        <span className="font-mono text-4xl font-medium text-foreground tabular-nums">{view.value}</span>
        <span className="font-mono text-xs text-muted-foreground">{view.label}</span>
      </div>
    );
  } else if (plan && activeType && activeMode === "chart" && data) {
    body = (
      <Suspense fallback={<ChartSkeleton />}>
        <AnswerChart chartType={activeType} data={data.rows} xKey={plan.xKey} yKey={plan.yKey} height={CHART_HEIGHT} />
      </Suspense>
    );
  } else {
    body = <AnswerTable columns={columns} rows={rows} total={query.rowCount} truncated={query.truncated} />;
  }

  return (
    <section aria-label="Query result" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {title}
        <div className="flex items-center gap-1.5">
          {plan ? (
            <div className="inline-flex overflow-hidden rounded-md border border-border">
              {(["chart", "table"] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={activeMode === value}
                  onClick={() => setMode(value)}
                  className={cn("h-7 rounded-none px-2.5 text-xs", activeMode === value && "bg-foreground text-background hover:bg-foreground hover:text-background")}
                >
                  {value === "chart" ? "Chart" : "Table"}
                </Button>
              ))}
            </div>
          ) : null}
          {plan && activeType && activeMode === "chart" ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm" aria-label="Chart type" className="h-7 gap-1 px-2 text-xs">
                  {TYPE_LABEL[activeType]}
                  <ChevronDown aria-hidden="true" className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Chart type</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={activeType} onValueChange={(value) => setTypeChoice(plan.choices.find((type) => type === value) ?? null)}>
                  {plan.choices.map((type) => (
                    <DropdownMenuRadioItem key={type} value={type}>
                      {TYPE_LABEL[type]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {rows.length > 0 ? (
            <Button type="button" variant="outline" size="sm" aria-label="Download the rows as CSV" onClick={() => downloadCsv(query, columns, rows)} className="h-7 gap-1.5 px-2 text-xs">
              <Download aria-hidden="true" className="size-3.5" />
              CSV
            </Button>
          ) : null}
        </div>
      </div>
      {body}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <SqlDisclosure query={query} ranAs={ranAs} />
        </div>
        <span className="py-2 font-mono text-xs whitespace-nowrap text-muted-foreground">{rowsLabel(count)}</span>
      </div>
    </section>
  );
}
