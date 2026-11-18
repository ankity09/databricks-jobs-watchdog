import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@databricks/appkit-ui/react";
import { useMemo, useState } from "react";
import { dependencyKey, type JobListDocument } from "../../../../shared/joblist/types";
import { type ReloadJobList, type SaveOutcome, useOpenedVersion } from "../../hooks/useJobList";
import { changeIssues, linksRemovedWith } from "../../lib/draft";
import { describeTarget } from "../../lib/targets";
import { ReloadButton } from "./ReloadButton";
import { type ReturnFocus, useReturnFocus } from "./returnFocus";

export interface DeleteJobDialogProps {
  name: string;
  document: JobListDocument;
  /** The version `document` is. */
  version: number | null;
  onCancel: () => void;
  /** Deletes the job; `baseVersion` is the version the dialog opened at. */
  onDelete: (baseVersion: number | null) => Promise<SaveOutcome>;
  onReload: ReloadJobList;
  /** Where focus goes when the dialog closes (see useReturnFocus). */
  returnFocus?: ReturnFocus;
}

/** Confirms a delete, and names the links that go with it. */
export function DeleteJobDialog({ name, document, version, onCancel, onDelete, onReload, returnFocus }: DeleteJobDialogProps) {
  const onCloseAutoFocus = useReturnFocus(returnFocus);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  // The version the dialog opened at, until a reload after a conflict shows a newer one.
  const [openedAt, takeNewest] = useOpenedVersion(version);
  const links = useMemo(() => linksRemovedWith(document, name), [document, name]);
  const blockers = useMemo(() => changeIssues(document, { kind: "delete", target: { type: "job", name } }), [document, name]);

  const confirm = async () => {
    setBusy(true);
    const result = await onDelete(openedAt);
    setBusy(false);
    if (!result.ok) setOutcome(result);
  };
  const failure = outcome !== null && !outcome.ok ? outcome : null;
  const conflict = failure?.conflict === true;
  const message = failure !== null && !failure.conflict ? (failure.issues[0]?.message ?? failure.message) : null;

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>The Watchdog stops checking this job. The change log keeps every earlier version.</AlertDialogDescription>
        </AlertDialogHeader>
        {links.length > 0 ? (
          <div className="grid gap-1.5 text-sm">
            <p>{links.length === 1 ? "This also removes 1 link:" : `This also removes ${links.length} links:`}</p>
            <ul className="grid gap-1 rounded-md border border-border bg-muted/40 px-3 py-2">
              {links.map((link) => (
                <li key={dependencyKey(link)} className="font-mono text-xs">
                  {describeTarget(`dependency:${dependencyKey(link)}`).name}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {blockers.length > 0 ? (
          <p className="text-sm text-destructive">
            {blockers[0]?.path === "jobs"
              ? "This is the only job, and the list needs at least one."
              : `This job cannot be deleted: ${blockers[0]?.message ?? ""}`}
          </p>
        ) : null}
        {conflict ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
            <p className="leading-5">Someone else changed this job since you opened it.</p>
            <ReloadButton
              onReload={onReload}
              onReloaded={() => {
                setOutcome(null);
                takeNewest();
              }}
            />
          </div>
        ) : null}
        {message ? (
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            disabled={busy || blockers.length > 0 || conflict}
            onClick={(event) => {
              // Keep the dialog open until the save answers.
              event.preventDefault();
              void confirm();
            }}
          >
            {busy ? "Deleting..." : "Delete job"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
