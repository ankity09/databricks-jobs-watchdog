import { CHANGE_KINDS, type ChangeKind } from "../../../shared/joblist/types";

/**
 * What the change log is filtered by. It lives in the URL (`?person=&kind=create,update&job=&from=&to=&q=`), so the
 * back button and a copied link keep it. The API takes the same names.
 */
export interface ChangeFilters {
  person: string | null;
  kinds: ChangeKind[];
  job: string | null;
  /** A date (`2026-11-01`, from 00:00 UTC) or a date-time. */
  from: string | null;
  /** A date (`2026-11-07`, to the end of that day, UTC) or a date-time. */
  to: string | null;
  q: string;
}

export const NO_FILTERS: ChangeFilters = { person: null, kinds: [], job: null, from: null, to: null, q: "" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

function dateOf(value: string | null): string | null {
  return value !== null && (DATE.test(value) || DATE_TIME.test(value)) ? value : null;
}

export function parseFilters(params: URLSearchParams): ChangeFilters {
  const asked = (params.get("kind") ?? "").split(",");
  return {
    person: params.get("person") || null,
    kinds: CHANGE_KINDS.filter((kind) => asked.includes(kind)),
    job: params.get("job") || null,
    from: dateOf(params.get("from")),
    to: dateOf(params.get("to")),
    q: params.get("q") ?? "",
  };
}

/** Only what is set, in a fixed order, so the same filters always make the same URL. */
export function writeFilters(filters: ChangeFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.person) params.set("person", filters.person);
  if (filters.kinds.length > 0) params.set("kind", CHANGE_KINDS.filter((kind) => filters.kinds.includes(kind)).join(","));
  if (filters.job) params.set("job", filters.job);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.q) params.set("q", filters.q);
  return params;
}

export function hasFilters(filters: ChangeFilters): boolean {
  return writeFilters(filters).size > 0;
}

/** The link to the change log of one job. */
export function jobHistoryPath(name: string): string {
  return `/jobs/changes?${new URLSearchParams({ job: name }).toString()}`;
}

export type WhenPreset = "any" | "24h" | "7d" | "30d" | "custom";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const day = (at: Date) => at.toISOString().slice(0, 10);

/** The real `from` a preset stands for, now: the 24 hours as an instant, the longer ones as UTC dates. */
export function presetFrom(preset: "24h" | "7d" | "30d", now: Date): string {
  if (preset === "24h") return `${new Date(now.getTime() - DAY).toISOString().slice(0, 19)}Z`;
  return day(new Date(now.getTime() - (preset === "7d" ? 7 : 30) * DAY));
}

/**
 * The preset the dates match, for the select to show. A 24-hour window moves as time passes, so it counts as
 * "Last 24 hours" for an hour after it was set; an older copied link shows Custom.
 */
export function presetOf(filters: ChangeFilters, now: Date): WhenPreset {
  const { from, to } = filters;
  if (from === null && to === null) return "any";
  if (from === null || to !== null) return "custom";
  if (from === presetFrom("7d", now)) return "7d";
  if (from === presetFrom("30d", now)) return "30d";
  if (DATE_TIME.test(from)) {
    const age = now.getTime() - new Date(HAS_ZONE.test(from) ? from : `${from}Z`).getTime();
    if (age >= -60_000 && age <= DAY + HOUR) return "24h";
  }
  return "custom";
}

const HAS_ZONE = /(Z|[+-]\d{2}:\d{2})$/;
