import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  buttonVariants,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Skeleton,
  Textarea,
} from "@databricks/appkit-ui/react";
import { CircleAlert, FileUp, RotateCw } from "lucide-react";
import { type ChangeEvent, type DragEvent, type ReactNode, useId, useRef, useState } from "react";
import type { DiffEntry, ImportPreview, JobListDocument, RuleIssue, SaveResult } from "../../../../shared/joblist/types";
import type { ReloadJobList } from "../../hooks/useJobList";
import { toApiError } from "../../lib/api";
import { uniqueIssues } from "../../lib/draft";
import { ConflictBodySchema, InvalidBodySchema, importYaml, previewImport } from "../../lib/joblist-api";
import { describeTarget } from "../../lib/targets";
import { cn } from "../../lib/utils";
import { ReloadButton } from "./ReloadButton";

const MAX_BYTES = 1024 * 1024;

export interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The version the person has open. The server refuses the import (409) when someone saved a newer one. */
  baseVersion: number | null;
  /** Reloads the job list, so the next preview and import start from the newest version. */
  onReload: ReloadJobList;
  /** After a successful import, with the version it saved. */
  onImported: (result: SaveResult) => void;
}

/**
 * Imports a monitored-jobs YAML file in two steps: a preview of what would
 * change, then Import. Nothing is saved before Import, and Import saves exactly
 * the text that was previewed.
 */
export function ImportDialog({ open, onOpenChange, baseVersion, onReload, onImported }: ImportDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Import YAML</DialogTitle>
          <DialogDescription>
            Paste your monitored-jobs file, or choose it from your computer. You see what changes before anything is saved, and the import
            is saved as a new version. Earlier versions stay in the change log.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so every import starts from an empty form. */}
        {open ? (
          <ImportForm baseVersion={baseVersion} onReload={onReload} onImported={onImported} onClose={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type PreviewState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "ready"; yaml: string; preview: ImportPreview }
  | { kind: "yaml-error"; message: string }
  | { kind: "error"; message: string };

type ImportState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "conflict" }
  | { kind: "invalid"; issues: RuleIssue[]; message: string }
  | { kind: "error"; message: string };

interface ImportFormProps {
  baseVersion: number | null;
  onReload: ReloadJobList;
  onImported: (result: SaveResult) => void;
  onClose: () => void;
}

function ImportForm({ baseVersion, onReload, onImported, onClose }: ImportFormProps) {
  const [yaml, setYaml] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ kind: "none" });
  const [saving, setSaving] = useState<ImportState>({ kind: "idle" });
  const textareaId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);

  const runPreview = async (text: string) => {
    if (new Blob([text]).size > MAX_BYTES) {
      setFileProblem("The YAML is larger than 1 MB. A job list is usually much smaller.");
      return;
    }
    setFileProblem(null);
    setSaving({ kind: "idle" });
    setPreview({ kind: "loading" });
    try {
      setPreview({ kind: "ready", yaml: text, preview: await previewImport(text) });
    } catch (e) {
      const error = toApiError(e);
      setPreview(
        error.status === 400 && error.error === "yaml"
          ? { kind: "yaml-error", message: error.message }
          : { kind: "error", message: error.message },
      );
    }
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.ya?ml$/i.test(file.name)) {
      setFileProblem("Choose a .yml or .yaml file.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setFileProblem("The file is larger than 1 MB. A job list is usually much smaller.");
      return;
    }
    const text = await file.text();
    setFileName(file.name);
    setYaml(text);
    await runPreview(text);
  };

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // so choosing the same file again still fires
    void readFile(file);
  };

  // A paste previews at once, from the text as it is after the paste lands.
  const onPaste = () => {
    window.setTimeout(() => {
      const text = textarea.current?.value ?? "";
      if (text.trim() !== "") void runPreview(text);
    }, 0);
  };

  const onDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    const file = event.dataTransfer.files[0];
    if (!file) return;
    event.preventDefault();
    void readFile(file);
  };

  const ready = preview.kind === "ready" ? preview : null;
  // The rules can report one issue twice (a name listed three times): each shows once.
  const issues = uniqueIssues(saving.kind === "invalid" ? saving.issues : (ready?.preview.issues ?? []));
  const stale = ready !== null && ready.yaml !== yaml;
  const canImport =
    ready !== null &&
    !stale &&
    issues.length === 0 &&
    ready.preview.diff.length > 0 &&
    saving.kind !== "saving" &&
    saving.kind !== "conflict";

  const runImport = async () => {
    if (!ready || !canImport) return;
    setSaving({ kind: "saving" });
    try {
      const result = await importYaml(ready.yaml, baseVersion);
      onImported(result);
      onClose();
    } catch (e) {
      const error = toApiError(e);
      if (error.status === 409 && ConflictBodySchema.safeParse(error.body).success) {
        setSaving({ kind: "conflict" });
        return;
      }
      const invalid = error.status === 422 ? InvalidBodySchema.safeParse(error.body) : null;
      if (invalid?.success) {
        setSaving({ kind: "invalid", issues: invalid.data.issues, message: invalid.data.message });
        return;
      }
      setSaving({ kind: "error", message: error.message });
    }
  };

  return (
    <>
      <div className="grid min-h-0 gap-4 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor={textareaId}>YAML</Label>
            <div className="flex min-w-0 items-center gap-2">
              {fileName ? <span className="truncate font-mono text-xs text-muted-foreground">{fileName}</span> : null}
              <label
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "focus-within:ring-[3px] focus-within:ring-ring")}
              >
                <FileUp aria-hidden="true" />
                Choose file
                <input type="file" accept=".yml,.yaml" className="sr-only" onChange={onFile} />
              </label>
            </div>
          </div>
          <Textarea
            id={textareaId}
            ref={textarea}
            value={yaml}
            onChange={(event) => setYaml(event.target.value)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
            onPaste={onPaste}
            spellCheck={false}
            wrap="off"
            placeholder={'jobs:\n  - job_name: orders_ingest\n    job_name_regex: "^orders_ingest_(prod|dev)$"\n    max_gap_minutes: 60'}
            className="h-[min(52vh,32rem)] resize-none field-sizing-fixed font-mono text-xs leading-5"
          />
          {fileProblem ? (
            <p className="text-sm text-destructive" aria-live="polite">
              {fileProblem}
            </p>
          ) : null}
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={yaml.trim() === "" || preview.kind === "loading"}
              onClick={() => void runPreview(yaml)}
            >
              Preview changes
            </Button>
            {stale ? (
              <p className="text-xs text-muted-foreground">The YAML changed since the preview. Preview again before you import.</p>
            ) : null}
          </div>
        </div>

        <div
          className="min-h-0 min-w-0 overflow-y-auto rounded-md border border-border bg-muted/30 p-4 md:h-[min(52vh,32rem)] md:mt-8"
          aria-live="polite"
        >
          <PreviewPanel state={preview} issues={issues} onRetry={() => void runPreview(yaml)} />
        </div>
      </div>

      <DialogFooter className="items-center gap-3 sm:justify-between">
        <ImportStatus state={saving} onReload={onReload} onReloaded={() => void runPreview(yaml)} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {ready ? (
            <Button disabled={!canImport} onClick={() => void runImport()}>
              {saving.kind === "saving" ? "Importing..." : "Import"}
            </Button>
          ) : null}
        </div>
      </DialogFooter>
    </>
  );
}

interface ImportStatusProps {
  state: ImportState;
  onReload: ReloadJobList;
  /** Previews the file again, once the newest list has loaded. */
  onReloaded: () => void;
}

function ImportStatus({ state, onReload, onReloaded }: ImportStatusProps) {
  if (state.kind === "conflict") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-destructive" role="alert">
        <p className="leading-5">The job list changed since you previewed this file. Preview again to see the newest differences.</p>
        <ReloadButton onReload={onReload} onReloaded={onReloaded}>
          Preview again
        </ReloadButton>
      </div>
    );
  }
  if (state.kind === "invalid")
    return (
      <p className="text-sm text-destructive" role="alert">
        {state.message} Fix the file, then preview again.
      </p>
    );
  if (state.kind === "error")
    return (
      <p className="text-sm text-destructive" role="alert">
        {state.message}
      </p>
    );
  return <span />;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The preview's document is checked for structure only, so each section is read with care. */
function holdsSentence(doc: JobListDocument): string {
  const jobs = Array.isArray(doc.jobs) ? doc.jobs.length : 0;
  const links = Array.isArray(doc.dependencies) ? doc.dependencies.length : 0;
  const labels = Array.isArray(doc.workspaces) ? doc.workspaces.length : 0;
  return `The file holds ${count(jobs, "job", "jobs")}, ${count(links, "link", "links")} and ${count(labels, "workspace label", "workspace labels")}.`;
}

function PreviewPanel({ state, issues, onRetry }: { state: PreviewState; issues: RuleIssue[]; onRetry: () => void }) {
  if (state.kind === "none") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
        <p className="text-sm font-medium text-foreground">No preview yet</p>
        <p className="max-w-xs text-sm text-muted-foreground">
          Paste or choose your file, then click Preview changes. Nothing is saved until you import.
        </p>
      </div>
    );
  }
  if (state.kind === "loading") {
    return (
      <div className="flex flex-col gap-3" aria-label="Loading the preview">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (state.kind === "yaml-error") {
    return (
      <Alert variant="destructive">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>This is not valid YAML</AlertTitle>
        <AlertDescription>
          <p className="font-mono text-xs break-words whitespace-pre-wrap">{state.message}</p>
        </AlertDescription>
      </Alert>
    );
  }
  if (state.kind === "error") {
    return (
      <Alert variant="destructive">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>The preview failed</AlertTitle>
        <AlertDescription>
          <p>{state.message}</p>
          <Button variant="outline" size="sm" className="mt-1 gap-1.5" onClick={onRetry}>
            <RotateCw aria-hidden="true" />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  const { preview } = state;
  const added = preview.diff.filter((d) => d.kind === "added");
  const changed = preview.diff.filter((d) => d.kind === "changed");
  const removed = preview.diff.filter((d) => d.kind === "removed");
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">What the import changes</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">{holdsSentence(preview.document)}</p>
      </div>
      {issues.length > 0 ? (
        <Group
          title={`Problems (${issues.length})`}
          tone="destructive"
          note="Fix these in the file, then preview again. Nothing can be imported until they are gone."
        >
          {issues.map((issue) => (
            <li key={`${issue.path}|${issue.message}`} className="grid gap-0.5 py-1.5">
              {issue.path ? <span className="font-mono text-[11px] text-muted-foreground">{issue.path}</span> : null}
              <span className="text-sm text-foreground">{issue.message}</span>
            </li>
          ))}
        </Group>
      ) : null}
      {preview.diff.length === 0 ? (
        <p className="text-sm text-foreground">This file matches the saved job list. There is nothing to import.</p>
      ) : (
        <>
          {added.length > 0 ? <DiffGroup title={`Added (${added.length})`} entries={added} /> : null}
          {changed.length > 0 ? <DiffGroup title={`Changed (${changed.length})`} entries={changed} /> : null}
          {removed.length > 0 ? (
            <DiffGroup
              title={`Removed (${removed.length})`}
              entries={removed}
              tone="destructive"
              note="Removed jobs are no longer checked after the import."
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function Group({ title, tone, note, children }: { title: string; tone?: "destructive"; note?: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <h4
        id={headingId}
        className={cn(
          "text-xs font-semibold tracking-wide uppercase",
          tone === "destructive" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {title}
      </h4>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      <ul className="divide-y divide-border rounded-md border border-border bg-background px-3">{children}</ul>
    </section>
  );
}

function DiffGroup({ title, entries, tone, note }: { title: string; entries: DiffEntry[]; tone?: "destructive"; note?: string }) {
  return (
    <Group title={title} tone={tone} note={note}>
      {entries.map((entry) => {
        const target = describeTarget(entry.target);
        return (
          <li key={entry.target} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-1.5">
            <span className="w-28 shrink-0 text-xs text-muted-foreground">{target.section ?? "Entry"}</span>
            {target.name ? <span className="min-w-0 font-mono text-[13px] break-words text-foreground">{target.name}</span> : null}
            {entry.fields.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {entry.fields.map((field) => (
                  <span key={field} className="rounded-sm bg-secondary px-1.5 py-px font-mono text-[11px] text-secondary-foreground">
                    {field}
                  </span>
                ))}
              </span>
            ) : null}
          </li>
        );
      })}
    </Group>
  );
}
