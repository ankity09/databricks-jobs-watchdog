import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@databricks/appkit-ui/react";
import { type FormEvent, useId, useMemo, useState } from "react";
import type { Change, JobListDocument } from "../../../../shared/joblist/types";
import { type NodeKind, changeIssues, linkChange } from "../../lib/graph";
import { linkExists } from "../../lib/linkRules";
import { LinkForm, LinkProblems, Mono } from "./LinkForm";
import { type ReturnFocus, useReturnFocus } from "./returnFocus";

/** One end of a new link, as picked on the map. */
export interface LinkEnd {
  kind: NodeKind;
  name: string;
}

export interface AddLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The upstream box: a job, or a service the target needs. */
  source: LinkEnd | null;
  /** The downstream box, always a job. */
  target: LinkEnd | null;
  document: JobListDocument;
  saving: boolean;
  /** Where focus goes when the dialog closes, such as the button that started adding the link (see useReturnFocus). */
  returnFocus?: ReturnFocus;
  onSave: (change: Change) => void;
}

/** Choose the type of a link picked on the map: job or child job between two jobs; a service link from a service. */
export function AddLinkDialog({ open, onOpenChange, source, target, document, saving, returnFocus, onSave }: AddLinkDialogProps) {
  const onCloseAutoFocus = useReturnFocus(returnFocus);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Add a link</DialogTitle>
          <DialogDescription>
            {source && target ? (
              <>
                <Mono>{target.name}</Mono> depends on <Mono>{source.name}</Mono>.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        {source && target ? (
          // Keyed by the pair, so a new pair starts with the default type and no notes.
          <LinkForm
            key={`${source.kind}:${source.name}->${target.name}`}
            jobName={target.name}
            dependsOn={source.name}
            service={source.kind === "service"}
            document={document}
            saving={saving}
            onCancel={() => onOpenChange(false)}
            onSave={onSave}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export interface AddServiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: JobListDocument;
  /** The job to suggest, such as the job selected on the map. */
  defaultJob: string | null;
  saving: boolean;
  /** Where focus goes when the dialog closes, such as the button that opened it. */
  /** Where focus goes when the dialog closes (see useReturnFocus). */
  returnFocus?: ReturnFocus;
  onSave: (change: Change) => void;
}

/** Add a service: its name, then the job that needs it. A service exists on the map through its links. */
export function AddServiceDialog({ open, onOpenChange, document, defaultJob, saving, returnFocus, onSave }: AddServiceDialogProps) {
  const onCloseAutoFocus = useReturnFocus(returnFocus);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Add a service</DialogTitle>
          <DialogDescription>
            A service is something a job needs that the Watchdog does not check, such as a message broker or an API.
          </DialogDescription>
        </DialogHeader>
        <ServiceForm document={document} defaultJob={defaultJob} saving={saving} onCancel={() => onOpenChange(false)} onSave={onSave} />
      </DialogContent>
    </Dialog>
  );
}

interface ServiceFormProps {
  document: JobListDocument;
  defaultJob: string | null;
  saving: boolean;
  onCancel: () => void;
  onSave: (change: Change) => void;
}

function ServiceForm({ document, defaultJob, saving, onCancel, onSave }: ServiceFormProps) {
  const id = useId();
  const jobs = useMemo(() => document.jobs.map((job) => job.job_name).sort(), [document]);
  const [name, setName] = useState("");
  const [job, setJob] = useState(defaultJob !== null && jobs.includes(defaultJob) ? defaultJob : "");
  const [notes, setNotes] = useState("");

  const service = name.trim();
  const change = useMemo(
    () => (service !== "" && job !== "" ? linkChange(service, job, "service", notes.trim() || undefined) : null),
    [service, job, notes],
  );
  const exists = useMemo(() => (change ? linkExists(document, change) : false), [document, change]);
  const issues = useMemo(() => (change && !exists ? changeIssues(document, change) : []), [document, change, exists]);
  const blocked = change === null || exists || issues.length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (change && !blocked && !saving) onSave(change);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-name`}>Service name</Label>
        <Input
          id={`${id}-name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="kafka"
          className="font-mono text-[13px]"
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-job`}>Job that needs it</Label>
        <Select value={job} onValueChange={setJob}>
          <SelectTrigger id={`${id}-job`} className="w-full font-mono text-[13px]">
            <SelectValue placeholder="Pick a job" />
          </SelectTrigger>
          <SelectContent>
            {jobs.map((jobName) => (
              <SelectItem key={jobName} value={jobName} className="font-mono text-[13px]">
                {jobName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-notes`}>Notes (optional)</Label>
        <Input id={`${id}-notes`} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="What the job uses it for" />
      </div>

      <LinkProblems exists={exists} issues={issues} />

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={blocked || saving}>
          {saving ? "Saving" : "Save service"}
        </Button>
      </DialogFooter>
    </form>
  );
}
