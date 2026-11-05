import {
  Alert,
  AlertDescription,
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Skeleton,
} from "@databricks/appkit-ui/react";
import { CircleAlert, CircleCheck, RotateCw, SlidersHorizontal, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";
import type { SaveResult } from "../../../../shared/joblist/types";
import { useJobList } from "../../hooks/useJobList";
import { PageHeader } from "../../layout/PageHeader";
import { DefaultsForm } from "./DefaultsForm";
import { WorkspaceLabels } from "./WorkspaceLabels";

/** The defaults every job inherits, and the environment label of each workspace. */
export function SettingsPage() {
  const { state, loading, error, reload, save } = useJobList();
  const [notice, setNotice] = useState<string | null>(null);
  const saved = (result: SaveResult) => setNotice(`Saved version ${result.version}: ${result.summary}.`);

  let body: ReactNode;
  if (state === null) {
    body =
      error && !loading ? (
        <Alert variant="destructive" className="border-destructive/40">
          <CircleAlert aria-hidden="true" />
          <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p>The job list did not load. {error.message}</p>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void reload()}>
              <RotateCw aria-hidden="true" />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-6" aria-label="Loading the settings">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      );
  } else if (state.document.jobs.length === 0) {
    body = (
      <Empty className="flex-none border border-dashed border-border bg-muted/40 md:py-14">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SlidersHorizontal aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Add jobs first</EmptyTitle>
          <EmptyDescription>
            The job list needs at least one job before its defaults and labels can be saved. Import your monitored-jobs YAML file, or add a
            job.
          </EmptyDescription>
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
      <div className="grid gap-6">
        <DefaultsForm document={state.document} onSave={save} onSaved={saved} onReload={reload} />
        <WorkspaceLabels document={state.document} onSave={save} onSaved={saved} onReload={reload} />
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Defaults and workspace labels"
        description="The settings every job inherits, and the environment label of each workspace. Each save is a new version in the change log."
      />
      {notice ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-foreground"
        >
          <CircleCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
          <p className="min-w-0 flex-1 leading-5">{notice}</p>
          <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Dismiss" onClick={() => setNotice(null)}>
            <X aria-hidden="true" />
          </Button>
        </div>
      ) : null}
      {body}
    </>
  );
}
