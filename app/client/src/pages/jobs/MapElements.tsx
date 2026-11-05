import { Skeleton } from "@databricks/appkit-ui/react";
import { BaseEdge, type EdgeProps, Handle, type NodeProps, Position, getBezierPath } from "@xyflow/react";
import { Server } from "lucide-react";
import type { EdgeLine } from "../../lib/graph";
import { statusTone } from "../../lib/status";
import { cn } from "../../lib/utils";
import {
  ARROW_MARKER,
  ARROW_MARKER_ACCENT,
  type JobFlowNode,
  LEGEND_STATUSES,
  LINE_DASH,
  type LinkFlowEdge,
  type NodeHighlight,
  STATUS_LABEL,
  type SectionFlowNode,
  type ServiceFlowNode,
  TONE_DOT,
  TONE_EDGE,
  boxLabel,
} from "./mapModel";

const HIGHLIGHT: Record<NodeHighlight, string> = {
  none: "",
  selected: "ring-2 ring-primary ring-offset-2 ring-offset-muted",
  downstream: "ring-1 ring-primary/60",
  dimmed: "opacity-35",
  source: "ring-2 ring-primary ring-offset-2 ring-offset-muted",
  candidate: "hover:ring-1 hover:ring-primary/50",
  unavailable: "cursor-not-allowed opacity-35",
};

/** Invisible handles at the middle of the left and right sides, where links start and end. */
function Sides() {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} className="opacity-0" />
      <Handle type="source" position={Position.Right} isConnectable={false} className="opacity-0" />
    </>
  );
}

/** A job: a white box with its status as the left edge, the name in mono, and the status below. */
export function JobNode({ data }: NodeProps<JobFlowNode>) {
  const { box, highlight, statusLoading } = data;
  const tone = statusTone(box.status);
  return (
    <>
      <Sides />
      <button
        type="button"
        aria-label={boxLabel(box, statusLoading)}
        aria-pressed={highlight === "selected"}
        aria-disabled={highlight === "unavailable" || undefined}
        data-highlight={highlight}
        className={cn(
          "relative flex size-full cursor-pointer flex-col justify-center gap-1 rounded-md border border-border border-l-[3px] bg-card px-3 text-left shadow-xs outline-none",
          "transition-[opacity,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
          box.listed ? TONE_EDGE[tone] : "border-dashed border-l-muted-foreground/40",
          HIGHLIGHT[highlight],
        )}
      >
        <span className="truncate font-mono text-[13px] leading-4 font-medium text-foreground" title={box.name}>
          {box.name}
        </span>
        <span className="flex h-4 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
          {!box.listed ? (
            "Not in the job list"
          ) : statusLoading ? (
            <Skeleton className="h-2.5 w-16" />
          ) : (
            <>
              <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone])} aria-hidden="true" />
              {STATUS_LABEL[box.status]}
              {box.active ? null : <span className="text-muted-foreground/80">· Off</span>}
            </>
          )}
        </span>
        {highlight === "downstream" ? (
          <span
            className="absolute -top-2 right-2 rounded-sm bg-primary px-1 text-[10px] leading-4 font-medium text-primary-foreground"
            aria-hidden="true"
          >
            Affected
          </span>
        ) : null}
      </button>
    </>
  );
}

/** A service: a grey pill with its name in mono. */
export function ServiceNode({ data }: NodeProps<ServiceFlowNode>) {
  const { box, highlight } = data;
  return (
    <>
      <Sides />
      <button
        type="button"
        aria-label={boxLabel(box, false)}
        aria-pressed={highlight === "selected"}
        aria-disabled={highlight === "unavailable" || undefined}
        data-highlight={highlight}
        className={cn(
          "flex size-full cursor-pointer items-center justify-center gap-1.5 rounded-full border border-border bg-secondary px-3 text-muted-foreground outline-none",
          "transition-[opacity,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
          HIGHLIGHT[highlight],
        )}
      >
        <Server className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate font-mono text-[12px] leading-4" title={box.name}>
          {box.name}
        </span>
      </button>
    </>
  );
}

/** A heading on the canvas, above the jobs that have no links. */
export function SectionNode({ data }: NodeProps<SectionFlowNode>) {
  return <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{data.text}</p>;
}

/** A link: a thin neutral curve with an arrow at the downstream end, dashed for child jobs, dotted for services. */
export function LinkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, interactionWidth }: EdgeProps<LinkFlowEdge>) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const highlight = data?.highlight ?? "none";
  const accent = selected === true || highlight === "downstream";
  return (
    <BaseEdge
      id={id}
      path={path}
      interactionWidth={interactionWidth}
      markerEnd={`url(#${accent ? ARROW_MARKER_ACCENT : ARROW_MARKER})`}
      className={cn(
        "transition-opacity duration-150 motion-reduce:transition-none",
        LINE_DASH[data?.link.line ?? "solid"],
        accent ? "stroke-primary [stroke-width:1.75]" : "stroke-muted-foreground/55 [stroke-width:1.25]",
        highlight === "dimmed" && "opacity-25",
      )}
    />
  );
}

/** The two arrowheads the links use: neutral, and the accent for a selection. */
export function MapMarkers() {
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute size-0 overflow-hidden">
      <defs>
        <marker id={ARROW_MARKER} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M0,1 L9,5 L0,9 Z" className="fill-muted-foreground/70" />
        </marker>
        <marker id={ARROW_MARKER_ACCENT} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M0,1 L9,5 L0,9 Z" className="fill-primary" />
        </marker>
      </defs>
    </svg>
  );
}

interface LineSampleProps {
  line: EdgeLine;
}

function LineSample({ line }: LineSampleProps) {
  return (
    <svg width="22" height="6" aria-hidden="true" className="shrink-0">
      <line x1="1" y1="3" x2="21" y2="3" className={cn("stroke-muted-foreground [stroke-width:1.5]", LINE_DASH[line])} />
    </svg>
  );
}

/** What the colors and the line styles mean. */
export function MapLegend() {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-[11px] text-muted-foreground shadow-xs">
      <ul className="flex items-center gap-3" aria-label="Status colors">
        {LEGEND_STATUSES.map((status) => (
          <li key={status} className="flex items-center gap-1.5">
            <span className={cn("size-2 rounded-full", TONE_DOT[statusTone(status)])} aria-hidden="true" />
            {STATUS_LABEL[status]}
          </li>
        ))}
      </ul>
      <ul className="flex items-center gap-3" aria-label="Link types">
        <li className="flex items-center gap-1.5">
          <LineSample line="solid" />
          Job
        </li>
        <li className="flex items-center gap-1.5">
          <LineSample line="dashed" />
          Child job
        </li>
        <li className="flex items-center gap-1.5">
          <LineSample line="dotted" />
          Service
        </li>
      </ul>
    </div>
  );
}
