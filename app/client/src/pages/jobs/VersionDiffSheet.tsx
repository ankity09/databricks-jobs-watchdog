import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Skeleton,
} from "@databricks/appkit-ui/react";
import { CircleAlert, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { targetValue } from "../../../../shared/joblist/apply";
import { diffDocuments } from "../../../../shared/joblist/diff";
import { type DiffEntry, EMPTY_DOCUMENT, type JobListDocument, type VersionSummary } from "../../../../shared/joblist/types";
import { toApiError } from "../../lib/api";
import { getVersion } from "../../lib/joblist-api";
import { describeTarget, formatValue, parseTargetKey } from "../../lib/targets";
import { formatUtc } from "../../lib/time";
import { cn } from "../../lib/utils";
import { type ReturnFocus, useReturnFocus } from "./returnFocus";

export interface VersionDiffSheetProps {
  /** The version to show; null keeps the sheet closed. */
  version: VersionSummary | null;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes when the sheet closes (see useReturnFocus). */
  returnFocus?: ReturnFocus;
}

type Loaded = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; before: JobListDocument; after: JobListDocument };

/** The version and the one before it (an empty list before version 1). */
async function loadPair(version: number): Promise<{ before: JobListDocument; after: JobListDocument }> {
  const afterPromise = getVersion(version);
  const beforePromise =
    version > 1
      ? getVersion(version - 1).then(
          (detail) => detail.document,
          (error: unknown) => {
            if (toApiError(error).status === 404) return EMPTY_DOCUMENT;
            throw error;
          },
        )
      : Promise.resolve(EMPTY_DOCUMENT);
  const [after, before] = await Promise.all([afterPromise, beforePromise]);
  return { before, after: after.document };
}

/** What one saved version changed, compared with the version before it, field by field. */
export function VersionDiffSheet({ version, onOpenChange, returnFocus }: VersionDiffSheetProps) {
  const onCloseAutoFocus = useReturnFocus(returnFocus);
  return (
    <Sheet open={version !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-2xl" onCloseAutoFocus={onCloseAutoFocus}>
        {version ? <VersionDiff key={version.version} version={version} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function VersionDiff({ version }: { version: VersionSummary }) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  // Bumped by Retry, so the effect loads the pair again.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    loadPair(version.version).then(
      (pair) => {
        if (active) setLoaded({ kind: "ready", ...pair });
      },
      (error: unknown) => {
        if (active) setLoaded({ kind: "error", message: toApiError(error).message });
      },
    );
    return () => {
      active = false;
    };
  }, [version.version, attempt]);

  const diff = loaded.kind === "ready" ? diffDocuments(loaded.before, loaded.after) : [];
  return (
    <>
      <SheetHeader className="gap-1 border-b border-border px-6 py-4">
        <SheetTitle className="text-base">Version {version.version}</SheetTitle>
        <SheetDescription>{version.summary}</SheetDescription>
        <p className="font-mono text-[11px] text-muted-foreground">
          {version.changeKind}, saved {formatUtc(version.savedAt)} by {version.savedBy}
        </p>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
        {loaded.kind === "loading" ? (
          <div className="grid gap-3" aria-label="Loading the changes">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : loaded.kind === "error" ? (
          <Alert variant="destructive" className="border-destructive/40">
            <CircleAlert aria-hidden="true" />
            <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p>The changes did not load. {loaded.message}</p>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  setLoaded({ kind: "loading" });
                  setAttempt((n) => n + 1);
                }}
              >
                <RotateCw aria-hidden="true" />
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : diff.length === 0 ? (
          <p className="text-sm text-muted-foreground">This version holds the same job list as the one before it.</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {version.version > 1 ? `Compared with version ${version.version - 1}.` : "The first version, so everything in it is new."}
            </p>
            {diff.map((entry) => (
              <DiffTable key={entry.target} entry={entry} before={loaded.before} after={loaded.after} />
            ))}
          </>
        )}
      </div>
    </>
  );
}

const KIND_LABEL = { added: "Added", removed: "Removed", changed: "Changed" } as const;
const KIND_STYLE = {
  added: "border-success/30 bg-success/10 text-success",
  removed: "border-destructive/30 bg-destructive/10 text-destructive",
  changed: "border-border bg-secondary text-secondary-foreground",
} as const;

/** The entry a target names in a document, as a record of its settings. */
function entryOf(document: JobListDocument, target: string): Record<string, unknown> {
  const parsed = parseTargetKey(target);
  const value = parsed ? targetValue(document, parsed) : undefined;
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value)) : {};
}

function DiffTable({ entry, before, after }: { entry: DiffEntry; before: JobListDocument; after: JobListDocument }) {
  const target = describeTarget(entry.target);
  const title = target.name ? `${target.section ?? "Entry"} ${target.name}` : (target.section ?? entry.target);
  const was = entryOf(before, entry.target);
  const now = entryOf(after, entry.target);
  const fields = entry.kind === "changed" ? entry.fields : Object.keys(entry.kind === "added" ? now : was);
  return (
    <section className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-2">
        <Badge variant="outline" className={cn("rounded-sm px-1.5 py-0 text-[11px] font-medium", KIND_STYLE[entry.kind])}>
          {KIND_LABEL[entry.kind]}
        </Badge>
        <span className="text-xs text-muted-foreground">{target.section ?? "Entry"}</span>
        {target.name ? <span className="min-w-0 truncate font-mono text-[13px] text-foreground">{target.name}</span> : null}
      </div>
      <table className="w-full text-[13px]" aria-label={title}>
        <thead className="sr-only">
          <tr>
            <th scope="col">Setting</th>
            {entry.kind !== "added" ? <th scope="col">Before</th> : null}
            {entry.kind !== "removed" ? <th scope="col">After</th> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {fields.map((field) => (
            <tr key={field} className="align-top">
              <th scope="row" className="w-48 px-3 py-1.5 text-left font-mono text-xs font-normal text-muted-foreground">
                {field}
              </th>
              {entry.kind !== "added" ? (
                <td
                  className={cn(
                    "px-3 py-1.5 font-mono text-xs break-all",
                    entry.kind === "changed" && "text-muted-foreground line-through decoration-muted-foreground/50",
                  )}
                >
                  {formatValue(was[field])}
                </td>
              ) : null}
              {entry.kind !== "removed" ? (
                <td className="px-3 py-1.5 font-mono text-xs break-all text-foreground">{formatValue(now[field])}</td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
