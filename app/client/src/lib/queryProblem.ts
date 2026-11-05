/**
 * Why a Watchdog query has no answer to show, and how to say so.
 *
 * AppKit sends a failed SQL statement to the browser as "Query execution
 * failed" with errorCode BAD_REQUEST: the reason (INSUFFICIENT_PERMISSIONS,
 * TABLE_OR_VIEW_NOT_FOUND) stays in the server log. So a BAD_REQUEST on these
 * fixed, known-good queries means the tables are missing or not readable, and
 * the text names both next steps. When a message does carry the reason, the
 * text is specific.
 */
export type QueryProblem =
  | { kind: "config"; message: string }
  | { kind: "no-catalog" }
  | { kind: "query"; message: string; code: string | null }
  | { kind: "shape"; bad: number };

export interface ProblemText {
  title: string;
  detail: string;
}

const NO_ACCESS = /PERMISSION_DENIED|INSUFFICIENT_PERMISSIONS/;
const NOT_FOUND = /TABLE_OR_VIEW_NOT_FOUND|SCHEMA_NOT_FOUND|CATALOG_NOT_FOUND/;

/** A title and one or two plain sentences with the next step. `location` is "catalog.schema". */
export function describeProblem(problem: QueryProblem, location: string | null): ProblemText {
  const where = location ?? "the Watchdog schema";
  switch (problem.kind) {
    case "config":
      return { title: "Could not load the app settings", detail: problem.message };
    case "no-catalog":
      return {
        title: "No catalog set",
        detail: "The watchdog_scan job has no catalog parameter, so the app cannot find the Watchdog tables. Set it in the job, then retry.",
      };
    case "shape":
      return {
        title: "Unexpected results",
        detail: `The scan results had an unexpected shape (${problem.bad} ${problem.bad === 1 ? "row" : "rows"}). Check that the app and the scan are on the same version.`,
      };
    case "query":
      if (NO_ACCESS.test(problem.message)) {
        return { title: "No access to the Watchdog tables", detail: `You cannot read ${where}. Ask its owner or an admin for USE CATALOG, USE SCHEMA and SELECT on it.` };
      }
      if (NOT_FOUND.test(problem.message)) {
        return {
          title: "No Watchdog tables yet",
          detail: `${where} has no Watchdog tables yet. Click Scan now to run the first scan, which creates them. If scans have run, ask whoever set up the Watchdog to check its catalog and schema.`,
        };
      }
      if (problem.code === "BAD_REQUEST") {
        return {
          title: "Could not read the Watchdog tables",
          detail: `The query on ${where} failed. If no scan has run yet, click Scan now to create the tables. Otherwise, ask the owner of ${where} for USE CATALOG, USE SCHEMA and SELECT on it.`,
        };
      }
      return { title: "Could not load the results", detail: problem.message };
  }
}
