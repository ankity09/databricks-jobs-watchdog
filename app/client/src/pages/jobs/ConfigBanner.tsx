import { Alert, AlertDescription, AlertTitle, useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { CircleAlert, Info } from "lucide-react";
import { z } from "zod";
import { useRefreshKey } from "../../hooks/useRefreshKey";
import { useQueryRows, useWatchdogLocation } from "../../hooks/useWatchdogRows";
import { formatUtc } from "../../lib/time";
import { QueryProblemLine } from "./QueryProblemLine";

/** A whole number from the warehouse, which sends every value as a string. */
function toVersion(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  return Number.isSafeInteger(n) ? n : null;
}

/** AppKit parses a string that starts with { or [ as JSON, so an error text can arrive as a value. */
function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** One row of config_load_latest.obo.sql, newest first. */
const LoadRow = z.object({
  loaded_at: z.string(),
  source: z.string(),
  version: z.union([z.string(), z.number()]).nullable().transform(toVersion),
  status: z.string(),
  error: z.unknown().transform(toText),
});

type Load = z.infer<typeof LoadRow>;

export interface ConfigBannerProps {
  /** The newest saved version of the job list: null when nothing is saved, undefined while the list loads. */
  savedVersion: number | null | undefined;
}

/**
 * Which job list the scan uses, from the newest config_loads row (notebook 02
 * writes one per load): a failed load, a scan that still reads the YAML file,
 * or a scan that is behind the saved version. Nothing shows when the scan is up
 * to date, or before any load is recorded. Only the newest row counts: a
 * retried task can write the same FAILED row more than once.
 *
 * The query goes through Monitoring's path (useWatchdogLocation and
 * useQueryRows): while a refresh loads or after it fails, the last answer
 * stays; with no answer, the problem says what to ask for, with Retry.
 */
export function ConfigBanner({ savedVersion }: ConfigBannerProps) {
  const { bump } = useRefreshKey();
  const where = useWatchdogLocation();
  const query = useAnalyticsQuery("config_load_latest", where.params, { autoStart: where.ready });
  const loads = useQueryRows(query, LoadRow, where, "config_load_latest");

  if (loads.rows === null) {
    return loads.problem ? (
      <QueryProblemLine
        title="Could not check which job-list version the scan uses"
        problem={loads.problem}
        location={where.location}
        onRetry={bump}
      />
    ) : null;
  }
  const newest = loads.rows[0] ?? null;
  if (newest === null) return null;
  return <LoadBanner load={newest} savedVersion={savedVersion} />;
}

function LoadBanner({ load, savedVersion }: { load: Load; savedVersion: number | null | undefined }) {
  if (load.status === "FAILED") {
    return (
      <Alert variant="destructive" className="border-destructive/40">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>The scan could not load the job list</AlertTitle>
        <AlertDescription>
          <p>
            The load at <time className="font-mono">{formatUtc(load.loaded_at)}</time> failed. The scan keeps using the list it loaded
            before.
          </p>
          {load.error ? <p className="font-mono text-xs break-all whitespace-pre-wrap text-destructive">{load.error}</p> : null}
        </AlertDescription>
      </Alert>
    );
  }
  if (load.source === "yaml") {
    return (
      <Alert role="status" className="border-border bg-muted/50">
        <Info aria-hidden="true" />
        <AlertDescription className="text-foreground">
          <p>
            The scan still reads the YAML file. To use this list, set <code className="font-mono text-[13px]">scan.config_source</code> to{" "}
            <code className="font-mono text-[13px]">lakebase</code> and redeploy.
          </p>
        </AlertDescription>
      </Alert>
    );
  }
  if (load.source === "lakebase" && typeof savedVersion === "number" && (load.version === null || load.version < savedVersion)) {
    return (
      <Alert role="status" className="border-border bg-muted/50">
        <Info aria-hidden="true" />
        <AlertDescription className="text-foreground">
          <p>
            Saved as version <span className="font-mono">{savedVersion}</span>. The scan is on version{" "}
            <span className="font-mono">{load.version ?? "unknown"}</span>. It applies at the next scan, or click Scan now in the sidebar.
          </p>
        </AlertDescription>
      </Alert>
    );
  }
  return null;
}
