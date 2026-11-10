import { Button, DialogFooter, Input, Label, RadioGroup, RadioGroupItem } from "@databricks/appkit-ui/react";
import { type FormEvent, useId, useMemo, useState } from "react";
import { parentJobs } from "../../../../shared/joblist/impact";
import type { Change, DependencyType, JobListDocument, RuleIssue } from "../../../../shared/joblist/types";
import { changeIssues, linkChange } from "../../lib/graph";
import { linkExists } from "../../lib/linkRules";
import { cn } from "../../lib/utils";

interface MonoProps {
  children: string;
}

/** A job's or a service's name in a sentence, in mono. */
export function Mono({ children }: MonoProps) {
  return <span className="font-mono text-[12px] text-foreground">{children}</span>;
}

interface LinkProblemsProps {
  exists: boolean;
  issues: RuleIssue[];
}

/** Why Save is off: the link is there already, or the rules would refuse it. */
export function LinkProblems({ exists, issues }: LinkProblemsProps) {
  if (!exists && issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" aria-live="polite">
      {exists ? <li>This link already exists.</li> : null}
      {issues.map((issue) => (
        <li key={`${issue.path}:${issue.message}`}>{issue.message}</li>
      ))}
    </ul>
  );
}

export interface LinkFormProps {
  /** The job that depends on the other box. */
  jobName: string;
  /** What it depends on: a job, or a service when `service` is true. */
  dependsOn: string;
  service: boolean;
  document: JobListDocument;
  saving: boolean;
  onCancel: () => void;
  onSave: (change: Change) => void;
}

/**
 * A new link's type and notes, with Cancel and Save link: Job or Child job
 * between two jobs (a job has one parent at most), or a service link, which
 * has no choice. Save stays off while the link exists or the rules refuse it,
 * and the form says why.
 */
export function LinkForm({ jobName, dependsOn, service, document, saving, onCancel, onSave }: LinkFormProps) {
  const id = useId();
  const [type, setType] = useState<DependencyType>(service ? "service" : "job");
  const [notes, setNotes] = useState("");
  const parent = useMemo(() => {
    const parents = parentJobs(document.dependencies ?? []);
    return Object.hasOwn(parents, jobName) ? parents[jobName] : null;
  }, [document, jobName]);
  const otherParent = parent !== null && parent !== dependsOn ? parent : null;

  const change = useMemo(() => linkChange(dependsOn, jobName, type, notes.trim() || undefined), [dependsOn, jobName, type, notes]);
  const exists = useMemo(() => linkExists(document, change), [document, change]);
  const issues = useMemo(() => (exists ? [] : changeIssues(document, change)), [document, change, exists]);
  const blocked = exists || issues.length > 0 || (type === "child_job" && otherParent !== null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!blocked && !saving) onSave(change);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {service ? (
        <p className="text-sm text-muted-foreground">
          A service link: <Mono>{jobName}</Mono> needs the service <Mono>{dependsOn}</Mono>. The Watchdog does not check services, but the map
          shows which jobs an outage would affect.
        </p>
      ) : (
        <RadioGroup value={type} onValueChange={(value) => setType(value === "child_job" ? "child_job" : "job")} className="gap-3">
          <div className="flex items-start gap-3">
            <RadioGroupItem value="job" id={`${id}-job`} className="mt-0.5" />
            <Label htmlFor={`${id}-job`} className="flex flex-col items-start gap-0.5 font-normal">
              <span className="font-medium">Job</span>
              <span className="text-xs text-muted-foreground">
                {jobName} runs after {dependsOn}. A failure of {dependsOn} affects {jobName}.
              </span>
            </Label>
          </div>
          <div className="flex items-start gap-3">
            <RadioGroupItem value="child_job" id={`${id}-child`} className="mt-0.5" disabled={otherParent !== null} />
            <Label htmlFor={`${id}-child`} className={cn("flex flex-col items-start gap-0.5 font-normal", otherParent !== null && "opacity-60")}>
              <span className="font-medium">Child job</span>
              <span className="text-xs text-muted-foreground">
                {otherParent !== null
                  ? `${jobName} already has a parent job, ${otherParent}. A job can have only one.`
                  : `${dependsOn} starts ${jobName} as one of its tasks. A failure of either affects the other.`}
              </span>
            </Label>
          </div>
        </RadioGroup>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-notes`}>Notes (optional)</Label>
        <Input id={`${id}-notes`} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Why the jobs are linked" />
      </div>

      <LinkProblems exists={exists} issues={issues} />

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={blocked || saving}>
          {saving ? "Saving" : "Save link"}
        </Button>
      </DialogFooter>
    </form>
  );
}
