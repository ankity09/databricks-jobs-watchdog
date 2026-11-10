import {
  type ChartType,
  type GenieStatementResponse,
  getCompatibleChartTypes,
  inferChartType,
  transformGenieData,
} from '@databricks/appkit-ui/react';

/** How one Genie answer shows: a chart, a single number, or a table. */
export type AnswerView =
  | { kind: 'chart'; chartType: ChartType; xKey: string; yKey: string | string[]; choices: ChartType[] }
  | { kind: 'number'; label: string; value: string }
  | { kind: 'table'; choices: ChartType[] };

const PIE_MAX_ROWS = 8;
const TEXT_AXIS_MAX_ROWS = 50;

function isPie(type: ChartType): boolean {
  return type === 'pie' || type === 'donut';
}

/**
 * Picks the view for a statement. AppKit infers the chart first; these guards
 * then keep a pie to parts of a whole and a long list of categories in a table.
 */
export function chooseAnswerView(statement: GenieStatementResponse | null): AnswerView {
  const data = transformGenieData(statement);
  if (!data) return { kind: 'table', choices: [] };
  const { rows, columns } = data;

  if (rows.length === 1 && columns.length === 1 && columns[0].category === 'numeric') {
    const cell = statement?.result.data_array[0]?.[0];
    if (cell !== null && cell !== undefined) return { kind: 'number', label: columns[0].name, value: cell };
  }

  const inferred = inferChartType(rows, columns);
  if (!inferred) return { kind: 'table', choices: [] };

  const numeric = columns.filter((c) => c.category === 'numeric');
  const text = columns.filter((c) => c.category === 'string');
  const partsOfAWhole =
    columns.length === 2 &&
    text.length === 1 &&
    numeric.length === 1 &&
    rows.length <= PIE_MAX_ROWS &&
    !rows.some((row) => {
      const value = row[numeric[0].name];
      return typeof value === 'number' && value < 0;
    });
  const choices = getCompatibleChartTypes(rows, columns).filter((type) => partsOfAWhole || !isPie(type));

  const xIsText = text.some((c) => c.name === inferred.xKey);
  if (xIsText && rows.length > TEXT_AXIS_MAX_ROWS) return { kind: 'table', choices };

  let chartType = inferred.chartType;
  if (isPie(chartType) && !partsOfAWhole) {
    if (!choices.includes('bar')) return { kind: 'table', choices };
    chartType = 'bar';
  }
  return { kind: 'chart', chartType, xKey: inferred.xKey, yKey: inferred.yKey, choices };
}

const NUMBER = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** A cell that a spreadsheet could read as a formula gets a leading quote. */
function guardFormula(cell: string): string {
  if (/^[=+@\t\r]/.test(cell)) return `'${cell}`;
  if (cell.startsWith('-') && !NUMBER.test(cell)) return `'${cell}`;
  return cell;
}

function csvCell(cell: string | null): string {
  if (cell === null) return '';
  const safe = guardFormula(cell);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The rows as CSV (RFC 4180 quoting, CRLF between lines), safe to open in a spreadsheet. */
export function toCsv(columns: string[], rows: (string | null)[][]): string {
  return [columns, ...rows].map((line) => line.map(csvCell).join(',')).join('\r\n');
}

/** The download name for an answer's CSV: its title as a slug. */
export function csvFileName(title: string | null): string {
  const slug = (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `${slug}.csv` : 'copilot-answer.csv';
}

const STATUS_VALUES = new Set(['HEALTHY', 'WARNING', 'FAILED', 'UNKNOWN']);

/** The columns to show as status pills: named like a status, holding only status values. */
export function statusColumnIndexes(columns: string[], rows: (string | null)[][]): Set<number> {
  const found = new Set<number>();
  columns.forEach((name, index) => {
    if (!name.toLowerCase().includes('status')) return;
    const values = rows
      .map((row) => row[index])
      .filter((value): value is string => value !== null && value !== undefined);
    if (values.length > 0 && values.every((value) => STATUS_VALUES.has(value.toUpperCase()))) found.add(index);
  });
  return found;
}
