import { Button } from "@databricks/appkit-ui/react";
import { CircleHelp, History, MessageSquareText, Server, SquarePen, X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { Link } from "react-router";
import { impactOf } from "../../../../shared/joblist/impact";
import type { JobListDocument } from "../../../../shared/joblist/types";
import { copilotLink } from "../../lib/copilot-link";
import type { GraphEdge, GraphNode } from "../../lib/graph";
import { inheritedSettings } from "../../lib/job-form";
import { statusTone } from "../../lib/status";
import { cn } from "../../lib/utils";
import { affectsText, stepsLabel } from "./mapChain";
import { type Detail, jobDetails } from "./mapFacts";
import { CriticalMarker, StatusChip } from "./MapElements";
import { SCHEDULE_ICON, TONE_TILE, TYPE_LABEL, linkLabel } from "./mapModel";

/** The change log, filtered to one job and its links (the contract with the change log's filters). */
function historyLink(name: string): string {
  return `/jobs/changes?${new URLSearchParams({ job: name }).toString()}`;
}

interface PanelSectionProps {
  title: string;
  children: ReactNode;
}

function PanelSection({ title, children }: PanelSectionProps) {
  return (
    <section className="border-b border-border px-4 py-3 last:border-b-0">
      <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

interface DetailCellProps {
  label: string;
  detail: Detail;
  mono?: boolean;
  className?: string;
}

/** One setting in the details grid: its label over its value, muted with "(default)" for screen readers when the job takes it from the defaults. */
function DetailCell({ label, detail, mono = false, className }: DetailCellProps) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-[11px] leading-4 text-muted-foreground">{label}</dt>
      <dd
        className={cn("truncate text-xs leading-5", mono && "font-mono text-[11.5px]", detail.inherited ? "text-muted-foreground" : "text-foreground")}
        title={detail.inherited ? `${detail.text}, from the defaults` : detail.text}
      >
        {detail.text}
        {detail.inherited ? <span className="sr-only"> (default)</span> : null}
      </dd>
    </div>
  );
}

interface LinkRowsProps {
  links: GraphEdge[];
  /** Which end of each link to name: the upstream end (what the box depends on) or the downstream end. */
  end: "upstream" | "downstream";
  saving: boolean;
  empty: string;
  onRemove: (edgeId: string) => void;
}

function LinkRows({ links, end, saving, empty, onRemove }: LinkRowsProps) {
  if (links.length === 0) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <ul className="-my-1 flex flex-col">
      {links.map((edge) => {
        const other = end === "upstream" ? edge.dependency.depends_on : edge.dependency.job_name;
        return (
          <li key={edge.id} className="flex items-center gap-2 py-1">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={linkLabel(edge)}>
              {other}
            </span>
            <span className="shrink-0 rounded-[5px] border border-border bg-muted px-1.5 text-[10.5px] leading-[18px] text-muted-foreground">
              {TYPE_LABEL[edge.type]}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-1.5 text-xs text-muted-foreground hover:text-destructive"
              disabled={saving}
              aria-label={`Remove the link: ${linkLabel(edge)}`}
              onClick={() => onRemove(edge.id)}
            >
              Remove
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

export interface MapSidePanelProps {
  box: GraphNode;
  document: JobListDocument;
  /** Every link that starts or ends at the box, shown on the map or not. */
  links: GraphEdge[];
  /** Each job a failure here affects, with its steps from the box (impactSteps). */
  steps: ReadonlyMap<string, number>;
  statusLoading: boolean;
  saving: boolean;
  /** The panel's element, which takes focus after a link is removed in it. */
  panelRef: RefObject<HTMLElement | null>;
  /** Edit job, where focus goes back when the editor closes. */
  editRef: RefObject<HTMLButtonElement | null>;
  onRemove: (edgeId: string) => void;
  onEdit: () => void;
  onClose: () => void;
  /** Its size where it opens: a 360 pixel column over the map, or the map's width under it. */
  className?: string;
}

/**
 * The selected box's settings, in the style of a designer's config panel: its
 * status, its details, its links both ways (each with Remove), what a failure
 * there affects (with the steps from it), and links to its history, the
 * copilot and the job editor.
 */
export function MapSidePanel({ box, document, links, steps, statusLoading, saving, panelRef, editRef, onRemove, onEdit, onClose, className }: MapSidePanelProps) {
  const isJob = box.kind === "job";
  const entry = isJob ? document.jobs.find((job) => job.job_name === box.name) : undefined;
  const details = entry ? jobDetails(entry, inheritedSettings(document)) : null;
  const parent = isJob ? impactOf(document, box.name).parentJob : null;
  const dependsOn = links.filter((edge) => edge.target === box.id);
  const neededBy = links.filter((edge) => edge.source === box.id);
  const affected = [...steps.entries()].sort(([a, sa], [b, sb]) => sa - sb || (a < b ? -1 : a > b ? 1 : 0));
  const tone = entry ? statusTone(box.status) : "muted";
  // A job that is not in the list has no schedule: the question mark, as on its card.
  const Icon = isJob ? (entry ? SCHEDULE_ICON[entry.schedule_type ?? inheritedSettings(document).schedule_type] : CircleHelp) : Server;

  let kind = "Service";
  if (isJob) kind = entry ? (parent ? `Child job of ${parent}` : "Job") : "Not in the job list";

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      aria-label={box.name}
      className={cn(
        "pointer-events-auto flex flex-col overflow-hidden rounded-lg border border-border bg-card text-sm shadow-[0_4px_24px_rgb(27_49_57/0.12)] outline-none",
        className ?? "max-h-full w-[min(360px,calc(100cqw-24px))]",
      )}
    >
      <header className="flex items-start gap-3 border-b border-border px-4 py-3">
        <span
          data-part="tile"
          className={cn(
            "relative mt-0.5 grid size-9 shrink-0 place-items-center ring-1 ring-inset",
            isJob ? "rounded-md" : "rounded-full",
            isJob ? TONE_TILE[tone] : "bg-secondary text-muted-foreground ring-transparent",
          )}
        >
          <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden="true" />
          {details?.severity.text === "CRITICAL" ? <CriticalMarker className="absolute -top-1.5 -right-1.5" /> : null}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className={cn("truncate text-sm leading-5 font-medium text-foreground", isJob && "font-mono text-[13.5px]")} title={box.name}>
            {box.name}
          </h2>
          <p className="truncate text-xs text-muted-foreground" title={parent ? kind : undefined}>
            {kind}
          </p>
        </div>
        {entry && !statusLoading ? <StatusChip status={box.status} className="mt-1" /> : null}
        <Button variant="ghost" size="icon-sm" className="-mt-0.5 -mr-1.5 size-7 text-muted-foreground" aria-label="Clear the selection" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {details ? (
          <PanelSection title="Details">
            <dl className="grid grid-cols-3 gap-x-3 gap-y-2">
              <DetailCell label="Owner" detail={details.owner} />
              <DetailCell label="Schedule" detail={details.schedule} />
              <DetailCell label="Severity" detail={details.severity} mono />
              <DetailCell label="Max gap" detail={details.maxGap} mono />
              <DetailCell label="Max runtime" detail={details.maxRuntime} mono />
              <DetailCell label="Max retries" detail={details.maxRetries} mono />
              <DetailCell label="Enabled" detail={details.enabled} className="col-span-3" />
            </dl>
          </PanelSection>
        ) : null}
        {isJob ? (
          <PanelSection title="Depends on">
            {/* The links come from the list, not the map, so a link to a hidden service still shows here. */}
            <LinkRows links={dependsOn} end="upstream" saving={saving} empty="It depends on nothing." onRemove={onRemove} />
          </PanelSection>
        ) : null}
        <PanelSection title="Needed by">
          <LinkRows links={neededBy} end="downstream" saving={saving} empty="No job depends on it." onRemove={onRemove} />
        </PanelSection>
        <PanelSection title="Affects">
          <p className="text-xs font-medium text-foreground">{affectsText(affected.length)}</p>
          {affected.length > 0 ? (
            <ul className="mt-1.5 flex flex-col">
              {affected.map(([name, count]) => (
                <li key={name} className="flex items-center justify-between gap-3 py-[3px]">
                  <span className="min-w-0 truncate font-mono text-xs text-foreground" title={name}>
                    {name}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{stepsLabel(count)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </PanelSection>
      </div>

      <footer className="grid grid-cols-2 gap-2 border-t border-border bg-muted/40 px-4 py-3">
        {entry ? (
          <Button ref={editRef} variant="outline" size="sm" className="col-span-2" onClick={onEdit}>
            <SquarePen aria-hidden="true" />
            Edit job
          </Button>
        ) : null}
        <Button asChild variant="outline" size="sm" className={cn(!isJob && "col-span-2")}>
          <Link to={historyLink(box.name)}>
            <History aria-hidden="true" />
            View history
          </Link>
        </Button>
        {isJob ? (
          <Button asChild variant="outline" size="sm">
            <Link to={copilotLink({ job: box.name, status: box.status })}>
              <MessageSquareText aria-hidden="true" />
              Ask the copilot
            </Link>
          </Button>
        ) : null}
      </footer>
    </section>
  );
}
