import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@databricks/appkit-ui/react";
import { cn } from "../../lib/utils";
import { toStatus } from "../../lib/status";
import { StatusBadge } from "../monitoring/StatusBadge";
import { statusColumnIndexes } from "./answerView";

export interface AnswerTableProps {
  columns: string[];
  rows: (string | null)[][];
  /** How many rows the query has in all, when that is more than the rows given. */
  total?: number | null;
  /** The most rows to show. */
  limit?: number;
  /** Genie cut the result short: the rows given are only part of it. */
  truncated?: boolean;
}

const NUMBER = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Keys made from the content, for rows and columns that have no ID; a repeated value gets a running count. */
function contentKeys(values: string[]): string[] {
  const seen = new Map<string, number>();
  return values.map((value) => {
    const count = seen.get(value) ?? 0;
    seen.set(value, count + 1);
    return count === 0 ? value : `${value}#${count}`;
  });
}

/** The columns whose cells are all numbers (or null), so they read right-aligned. */
function numberColumns(columns: string[], rows: (string | null)[][]): Set<number> {
  const found = new Set<number>();
  columns.forEach((_, index) => {
    const values = rows.map((row) => row[index] ?? null).filter((value): value is string => value !== null);
    if (values.length > 0 && values.every((value) => NUMBER.test(value))) found.add(index);
  });
  return found;
}

/** The rows of an answer: status words as badges, numbers right-aligned in mono, null in italics. */
export function AnswerTable({ columns, rows, total = null, limit = 50, truncated = false }: AnswerTableProps) {
  const shown = rows.slice(0, limit);
  const all = Math.max(total ?? 0, rows.length);
  const statusColumns = statusColumnIndexes(columns, rows);
  const numeric = numberColumns(columns, rows);
  const columnKeys = contentKeys(columns);
  const rowKeys = contentKeys(shown.map((row) => JSON.stringify(row)));

  return (
    <div>
      <div className="max-h-80 overflow-auto rounded-md border border-border">
        <Table className="text-xs">
          <TableHeader className="sticky top-0 bg-muted">
            <TableRow>
              {columns.map((name, column) => (
                <TableHead key={columnKeys[column]} className={cn("h-8 px-3 font-mono text-[11px] font-medium text-muted-foreground", numeric.has(column) && "text-right")}>
                  {name}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((row, position) => (
              <TableRow key={rowKeys[position]}>
                {columns.map((_, column) => {
                  const value = row[column] ?? null;
                  return (
                    <TableCell
                      key={columnKeys[column]}
                      className={cn("max-w-80 truncate px-3 py-1.5", numeric.has(column) && "text-right font-mono")}
                      title={value ?? "null"}
                    >
                      {value === null ? (
                        <span className="text-muted-foreground italic">null</span>
                      ) : statusColumns.has(column) ? (
                        <StatusBadge status={toStatus(value.toUpperCase())} />
                      ) : (
                        value
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {all > shown.length ? (
        <p className="px-1 pt-1.5 text-xs text-muted-foreground">
          Showing {shown.length.toLocaleString("en-US")} of {all.toLocaleString("en-US")} rows
        </p>
      ) : null}
      {truncated ? <p className="px-1 pt-1.5 text-xs text-muted-foreground">Genie returned only part of this result. The table and the CSV hold the rows it sent.</p> : null}
    </div>
  );
}
