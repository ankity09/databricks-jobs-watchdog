import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@databricks/appkit-ui/react";
import { CircleAlert, History, RotateCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { ChangeKind, VersionSummary } from "../../../../shared/joblist/types";
import { type ApiError, toApiError } from "../../lib/api";
import { listVersions } from "../../lib/joblist-api";
import { formatUtc } from "../../lib/time";
import { cn } from "../../lib/utils";
import { PageHeader } from "../../layout/PageHeader";
import { ConfigBanner } from "./ConfigBanner";
import { VersionDiffSheet } from "./VersionDiffSheet";

const LIMIT = 50;

const KIND_STYLE: Record<ChangeKind, string> = {
  import: "border-foreground/20 bg-background text-foreground",
  create: "border-success/30 bg-success/10 text-success",
  update: "border-border bg-secondary text-secondary-foreground",
  delete: "border-destructive/30 bg-destructive/10 text-destructive",
  restore: "border-warning/30 bg-warning/10 text-warning",
};

interface VersionsState {
  versions: VersionSummary[] | null;
  error: ApiError | null;
}

/** The newest versions, newest first. A failed reload keeps the versions already shown. */
function useVersions(): VersionsState & { reload: () => Promise<void> } {
  const [state, setState] = useState<VersionsState>({ versions: null, error: null });
  const reload = useCallback(async () => {
    try {
      const versions = await listVersions(LIMIT);
      setState({ versions, error: null });
    } catch (error) {
      setState((current) => ({ versions: current.versions, error: toApiError(error) }));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { ...state, reload };
}

/** Every saved version of the job list: who saved it, when, and what changed. */
export function ChangeLogPage() {
  const { versions, error, reload } = useVersions();
  const [open, setOpen] = useState<VersionSummary | null>(null);

  let body: ReactNode;
  if (versions === null) {
    body = error ? <LoadError message={error.message} onRetry={() => void reload()} /> : <TableSkeleton />;
  } else if (versions.length === 0) {
    body = (
      <Empty className="flex-none border border-dashed border-border bg-muted/40 md:py-14">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <History aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Nothing is saved yet</EmptyTitle>
          <EmptyDescription>No versions yet. Import your job list or add a job on the Job list page.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline" size="sm">
            <Link to="/jobs">Go to the job list</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  } else {
    body = (
      <section className="flex flex-col gap-2" aria-label="Versions">
        {error ? (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <CircleAlert className="size-3.5" aria-hidden="true" />
            The newest versions did not load. {error.message}
          </p>
        ) : null}
        <div className="overflow-hidden rounded-md border border-border">
          <Table className="text-[13px]">
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-9 w-20 px-3 text-xs font-medium text-muted-foreground">Version</TableHead>
                <TableHead className="h-9 w-44 px-3 text-xs font-medium text-muted-foreground">When</TableHead>
                <TableHead className="h-9 w-56 px-3 text-xs font-medium text-muted-foreground">Who</TableHead>
                <TableHead className="h-9 px-3 text-xs font-medium text-muted-foreground">Summary</TableHead>
                <TableHead className="h-9 w-24 px-3 text-xs font-medium text-muted-foreground">Kind</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((version) => (
                <TableRow key={version.version} className="cursor-pointer" onClick={() => setOpen(version)}>
                  <TableCell className="px-3 py-2 font-mono">{version.version}</TableCell>
                  <TableCell className="px-3 py-2 font-mono text-xs text-muted-foreground">{formatUtc(version.savedAt)}</TableCell>
                  <TableCell className="max-w-56 truncate px-3 py-2 font-mono text-xs" title={version.savedBy}>
                    {version.savedBy}
                  </TableCell>
                  <TableCell className="max-w-0 px-3 py-2">
                    <button
                      type="button"
                      className="block max-w-full truncate rounded-xs text-left text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      title={version.summary}
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpen(version);
                      }}
                    >
                      {version.summary}
                    </button>
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <Badge
                      variant="outline"
                      className={cn("rounded-sm px-1.5 py-0 font-mono text-[11px] font-normal", KIND_STYLE[version.changeKind])}
                    >
                      {version.changeKind}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {versions.length === LIMIT ? <p className="text-xs text-muted-foreground">The newest {LIMIT} versions.</p> : null}
      </section>
    );
  }

  return (
    <>
      <PageHeader
        title="Change log"
        description="Every saved version of the job list: who saved it, when, and what changed. Click a version to see its changes."
        actions={
          versions !== null ? (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void reload()}>
              <RotateCw aria-hidden="true" />
              Refresh
            </Button>
          ) : null
        }
      />
      <ConfigBanner savedVersion={versions === null ? undefined : (versions[0]?.version ?? null)} />
      {body}
      <VersionDiffSheet
        version={open}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
      />
    </>
  );
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert variant="destructive" className="border-destructive/40">
      <CircleAlert aria-hidden="true" />
      <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p>The change log did not load. {message}</p>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onRetry}>
          <RotateCw aria-hidden="true" />
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function TableSkeleton() {
  return (
    <div className="overflow-hidden rounded-md border border-border" aria-label="Loading the change log">
      <div className="h-9 border-b border-border bg-muted/50" />
      {["a", "b", "c", "d"].map((key) => (
        <div key={key} className="flex h-10 items-center gap-6 border-b border-border px-3 last:border-0">
          <Skeleton className="h-3.5 w-8" />
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3.5 w-80" />
        </div>
      ))}
    </div>
  );
}
