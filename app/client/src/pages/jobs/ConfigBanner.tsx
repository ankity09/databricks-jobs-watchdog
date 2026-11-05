import { sql } from "@databricks/appkit-ui/js";
import { Alert, AlertDescription, AlertTitle, Button, useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { CircleAlert, Info, RotateCw } from "lucide-react";
import { useMemo } from "react";
import { z } from "zod";
import { useAppConfig } from "../../hooks/useAppConfig";
import { useLastGood } from "../../hooks/useLastGood";
import { useRefreshKey } from "../../hooks/useRefreshKey";
import { formatUtc } from "../../lib/time";

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

const LoadRows = z.array(
  z.object({
    loaded_at: z.string(),
    source: z.string(),
    version: z.union([z.string(), z.number()]).nullable().transform(toVersion),
    status: z.string(),
    error: z.unknown().transform(toText),
  }),
);

type Load = z.infer<typeof LoadRows>[number];

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
 */
export function ConfigBanner({ savedVersion }: ConfigBannerProps) {
  const { refresh, bump } = useRefreshKey();
  const { config, error: configError } = useAppConfig(refresh);
  const ready = config !== null && config.catalog !== "";
  const parameters = useMemo(
    () => ({ catalog: sql.string(config?.catalog ?? ""), schema: sql.string(config?.schema ?? ""), refresh: sql.int(refresh) }),
    [config, refresh],
  );
  const query = useAnalyticsQuery("config_load_latest", parameters, { autoStart: ready });
  // null until the current query answers (AppKit's first render for new parameters is idle, not loading).
  const parsed = useMemo(() => (query.data === null ? null : LoadRows.safeParse(query.data)), [query.data]);
  const answer = useMemo(() => (parsed?.success ? { newest: parsed.data[0] ?? null } : null), [parsed]);
  // While a newer query loads, keep the last answer, so the banner does not blink on a refresh.
  const shown = useLastGood(answer);

  const failed = configError !== null || (config !== null && !ready) || query.error !== null || parsed?.success === false;
  if (failed) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
        <p>{configError ? configError.message : "The app could not check which job-list version the scan uses."}</p>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2" onClick={() => bump()}>
          <RotateCw className="size-3.5" aria-hidden="true" />
          Retry
        </Button>
      </div>
    );
  }
  const newest = shown?.newest ?? null;
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
