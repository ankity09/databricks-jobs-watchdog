import { Skeleton, Tooltip, TooltipContent, TooltipTrigger } from "@databricks/appkit-ui/react";
import { BaseEdge, type EdgeProps, Handle, type NodeProps, Position, getSmoothStepPath } from "@xyflow/react";
import { CircleHelp, Server } from "lucide-react";
import type { ReactElement } from "react";
import type { EdgeLine, LayoutDirection } from "../../lib/graph";
import { type Status, statusTone } from "../../lib/status";
import { cn } from "../../lib/utils";
import { TONE_CHIP } from "../monitoring/format";
import { SCHEDULE_LABEL } from "./mapFacts";
import {
  ARROW,
  type ArrowTone,
  type JobFlowNode,
  LEGEND_STATUSES,
  LINE_DASH,
  LINE_FLOW,
  type LinkFlowEdge,
  type NodeHighlight,
  SCHEDULE_ICON,
  STATUS_LABEL,
  type SectionFlowNode,
  type ServiceFlowNode,
  TONE_TILE,
  boxLabel,
} from "./mapModel";

/** The card's frame for each highlight: border, ring and opacity. */
const FRAME: Record<NodeHighlight, string> = {
  none: "border-border hover:border-muted-foreground/45",
  selected: "border-primary ring-1 ring-primary shadow-[0_0_0_4px_rgb(255_54_33/0.12)]",
  downstream: "border-primary/50 hover:border-primary/75",
  upstream: "border-foreground/35 hover:border-foreground/50",
  dimmed: "border-border opacity-35",
  source: "border-primary ring-1 ring-primary shadow-[0_0_0_4px_rgb(255_54_33/0.12)]",
  candidate: "border-border hover:border-primary hover:ring-1 hover:ring-primary/40",
  unavailable: "cursor-not-allowed border-border opacity-35",
};

/** What every card shares: white, a 1 pixel border, a light shadow that lifts on hover, and the focus outline. */
const CARD =
  "relative flex size-full cursor-pointer items-center border bg-card text-left outline-none " +
  "shadow-[0_1px_2px_rgb(27_49_57/0.06)] hover:shadow-[0_2px_10px_rgb(27_49_57/0.10)] " +
  "transition-[border-color,box-shadow,opacity] duration-150 motion-reduce:transition-none " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid";

type PortEmphasis = "rest" | "strong" | "accent";

const PORT: Record<PortEmphasis, string> = {
  // Subtle at rest; the node wrapper is the group, so hovering the card makes them stronger.
  rest: "border-input group-hover:border-muted-foreground",
  strong: "border-muted-foreground",
  accent: "border-primary",
};

function portEmphasis(highlight: NodeHighlight): PortEmphasis {
  if (highlight === "selected" || highlight === "source") return "accent";
  return highlight === "candidate" ? "strong" : "rest";
}

interface PortsProps {
  direction: LayoutDirection;
  highlight: NodeHighlight;
}

/** The in and out ports: small circles at the middle of the left and right sides, or of the top and bottom. */
function Ports({ direction, highlight }: PortsProps) {
  const className = cn(
    "size-2 min-h-0 min-w-0 rounded-full border-[1.5px] bg-card transition-colors duration-150 motion-reduce:transition-none",
    PORT[portEmphasis(highlight)],
  );
  return (
    <>
      <Handle type="target" position={direction === "LR" ? Position.Left : Position.Top} isConnectable={false} className={className} />
      <Handle type="source" position={direction === "LR" ? Position.Right : Position.Bottom} isConnectable={false} className={className} />
    </>
  );
}

interface StatusChipProps {
  status: Status;
  className?: string;
}

/** A job's status as a chip in the app's status tones. */
export function StatusChip({ status, className }: StatusChipProps) {
  return (
    <span
      data-part="status"
      className={cn("inline-flex h-[18px] items-center rounded-[5px] border px-1.5 text-[10.5px] leading-none font-medium", TONE_CHIP[statusTone(status)], className)}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/** The chip of a job switched off in every environment. */
export function OffChip() {
  return (
    <span
      data-part="off"
      className="inline-flex h-[18px] items-center rounded-[5px] border border-border bg-muted px-1.5 text-[10.5px] leading-none font-medium text-muted-foreground"
    >
      Off
    </span>
  );
}

interface CriticalMarkerProps {
  className?: string;
}

/** The small marker of a CRITICAL job, on its tile's corner. */
export function CriticalMarker({ className }: CriticalMarkerProps) {
  return (
    <span
      data-part="critical"
      role="img"
      aria-label="Critical"
      className={cn(
        "grid size-3.5 place-items-center rounded-full bg-destructive text-[9px] leading-none font-bold text-white ring-2 ring-card",
        className,
      )}
    >
      <span aria-hidden="true">!</span>
    </span>
  );
}

interface CardNameProps {
  name: string;
  className?: string;
}

/** A card's name, cut short with an ellipsis when it is long; CardTooltip shows all of it. */
function CardName({ name, className }: CardNameProps) {
  return <span className={cn("block truncate font-mono text-[13px] leading-4 font-medium text-foreground", className)}>{name}</span>;
}

interface CardTooltipProps {
  name: string;
  /** The card's second line, in full: it may be cut short on the card. */
  meta: string;
  children: ReactElement;
}

/** The whole name and second line of a card, on hover and on focus. */
function CardTooltip({ name, meta, children }: CardTooltipProps) {
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="flex max-w-80 flex-col gap-0.5 text-left">
        <span className="font-mono text-xs break-all">{name}</span>
        <span className="text-[11px] text-background/75">{meta}</span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A job: a white card with an icon tile in its status tone (the icon says the
 * schedule type), the name in mono, the owner and schedule under it, and the
 * status chip at the right. A CRITICAL job has a marker on its tile; a job
 * switched off everywhere is dimmed, with an Off chip.
 */
export function JobNode({ data }: NodeProps<JobFlowNode>) {
  const { box, highlight, statusLoading, direction, facts } = data;
  const tone = box.listed ? statusTone(box.status) : "muted";
  const Icon = facts ? SCHEDULE_ICON[facts.schedule] : CircleHelp;
  let meta = "Not in the job list";
  if (facts) meta = facts.owner ? `${facts.owner} · ${SCHEDULE_LABEL[facts.schedule]}` : SCHEDULE_LABEL[facts.schedule];
  return (
    <>
      <Ports direction={direction} highlight={highlight} />
      <CardTooltip name={box.name} meta={meta}>
        <button
          type="button"
          aria-label={boxLabel(box, statusLoading)}
          aria-pressed={highlight === "selected"}
          aria-disabled={highlight === "unavailable" || undefined}
          data-highlight={highlight}
          data-active={box.active}
          className={cn(CARD, "gap-2.5 rounded-lg px-2.5", !box.listed && "border-dashed", FRAME[highlight])}
        >
          <span
            data-part="tile"
            data-schedule={facts?.schedule ?? "unknown"}
            data-tone={tone}
            className={cn("relative grid size-9 shrink-0 place-items-center rounded-md ring-1 ring-inset", TONE_TILE[tone], !box.active && "opacity-60")}
          >
            <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden="true" />
            {facts?.critical ? <CriticalMarker className="absolute -top-1.5 -right-1.5" /> : null}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <CardName name={box.name} className={box.active ? undefined : "text-foreground/70"} />
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[11px] leading-[18px] text-muted-foreground">{meta}</span>
              {box.active ? null : <OffChip />}
              {!box.listed ? null : statusLoading ? <Skeleton className="h-[18px] w-14 rounded-[5px]" /> : <StatusChip status={box.status} />}
            </span>
          </span>
          {highlight === "downstream" ? (
            <span
              data-part="affected"
              aria-hidden="true"
              className="absolute -top-2.5 right-3 rounded-full bg-primary px-1.5 text-[10px] leading-[18px] font-medium text-primary-foreground shadow-sm"
            >
              Affected
            </span>
          ) : null}
        </button>
      </CardTooltip>
    </>
  );
}

/** A service: a narrower, rounder card in a neutral tone, with a service icon, its name and a "Service" caption. */
export function ServiceNode({ data }: NodeProps<ServiceFlowNode>) {
  const { box, highlight, direction } = data;
  return (
    <>
      <Ports direction={direction} highlight={highlight} />
      <CardTooltip name={box.name} meta="Service">
        <button
          type="button"
          aria-label={boxLabel(box, false)}
          aria-pressed={highlight === "selected"}
          aria-disabled={highlight === "unavailable" || undefined}
          data-highlight={highlight}
          className={cn(CARD, "gap-2.5 rounded-full py-1.5 pr-4 pl-2", FRAME[highlight])}
        >
          <span data-part="tile" className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground">
            <Server className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] leading-4 font-medium text-foreground">{box.name}</span>
            <span className="text-[11px] leading-4 text-muted-foreground">Service</span>
          </span>
        </button>
      </CardTooltip>
    </>
  );
}

/** The labeled group around the jobs that have no links yet. */
export function SectionNode({ data }: NodeProps<SectionFlowNode>) {
  return (
    <div className="pointer-events-none size-full rounded-xl border-[1.5px] border-dashed border-muted-foreground/30 bg-card/40">
      <p className="absolute top-2.5 left-4 flex items-baseline gap-2 leading-5">
        <span className="text-[13px] font-medium text-foreground/80">{data.title}</span>
        <span className="font-mono text-xs text-muted-foreground">{data.count === 1 ? "1 job" : `${data.count} jobs`}</span>
      </p>
    </div>
  );
}

/** Each line color, with its width: neutral, lighter for services, the accent downstream, dark neutral upstream. */
const STROKE: Record<ArrowTone, string> = {
  neutral: "stroke-muted-foreground/60 [stroke-width:1.5]",
  light: "stroke-muted-foreground/40 [stroke-width:1.5]",
  accent: "stroke-primary [stroke-width:2]",
  dark: "stroke-foreground/70 [stroke-width:2]",
};

const TAG_TONE: Record<ArrowTone, { box: string; text: string }> = {
  neutral: { box: "stroke-input", text: "fill-muted-foreground" },
  light: { box: "stroke-input", text: "fill-muted-foreground" },
  accent: { box: "stroke-primary/50", text: "fill-primary" },
  dark: { box: "stroke-foreground/35", text: "fill-foreground" },
};

interface EdgeTagProps {
  x: number;
  y: number;
  tone: ArrowTone;
  dimmed: boolean;
}

/** The small "child" label at the middle of a child-job link. */
function EdgeTag({ x, y, tone, dimmed }: EdgeTagProps) {
  return (
    <g
      transform={`translate(${x} ${y})`}
      aria-hidden="true"
      data-part="edge-tag"
      className={cn("pointer-events-none transition-opacity duration-150 motion-reduce:transition-none", dimmed && "opacity-35", "group-focus-visible:opacity-100")}
    >
      <rect x={-17} y={-8} width={34} height={16} rx={8} className={cn("fill-card [stroke-width:1]", TAG_TONE[tone].box)} />
      <text textAnchor="middle" dominantBaseline="central" className={cn("text-[10px] font-medium", TAG_TONE[tone].text)}>
        child
      </text>
    </g>
  );
}

/**
 * A link: a rounded orthogonal line with a closed arrowhead at the dependent
 * end. Job links are solid, child-job links dashed with a "child" label, and
 * service links dotted and lighter. A selection's downstream links turn the
 * accent and flow; its upstream path turns dark neutral; the rest fade. A link
 * with keyboard focus turns the focus color and wider, even when faded: its
 * <g> is the "group" (the edge's className), and these classes beat React
 * Flow's own focus style, which sits in the components layer.
 */
export function LinkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, interactionWidth }: EdgeProps<LinkFlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 12, offset: 18 });
  const highlight = data?.highlight ?? "none";
  const lineStyle = data?.link.line ?? "solid";
  // `selected` is the link whose menu is open.
  let tone: ArrowTone = lineStyle === "dotted" ? "light" : "neutral";
  if (selected === true || highlight === "downstream") tone = "accent";
  else if (highlight === "upstream") tone = "dark";
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={interactionWidth}
        markerEnd={`url(#${ARROW[tone]})`}
        data-line={lineStyle}
        data-highlight={highlight}
        className={cn(
          "transition-[opacity,stroke] duration-150 motion-reduce:transition-none",
          LINE_DASH[lineStyle],
          highlight === "downstream" && LINE_FLOW[lineStyle],
          STROKE[tone],
          highlight === "dimmed" && "opacity-35",
          "group-focus-visible:stroke-ring group-focus-visible:opacity-100 group-focus-visible:[stroke-width:2.5]",
        )}
      />
      {lineStyle === "dashed" ? <EdgeTag x={labelX} y={labelY} tone={tone} dimmed={highlight === "dimmed"} /> : null}
    </>
  );
}

const ARROW_FILL: Record<ArrowTone, string> = {
  neutral: "fill-muted-foreground/75",
  light: "fill-muted-foreground/50",
  accent: "fill-primary",
  dark: "fill-foreground/75",
};

/** The arrowheads the links use, one per line color. */
export function MapMarkers() {
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute size-0 overflow-hidden">
      <defs>
        {(Object.keys(ARROW) as ArrowTone[]).map((tone) => (
          <marker key={tone} id={ARROW[tone]} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
            <path d="M0,1.5 L9,5 L0,8.5 Z" className={ARROW_FILL[tone]} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

interface LineSampleProps {
  line: EdgeLine;
}

function LineSample({ line }: LineSampleProps) {
  const light = line === "dotted";
  return (
    <svg width="34" height="10" aria-hidden="true" className="shrink-0 overflow-visible">
      <line x1="1" y1="5" x2="27" y2="5" className={cn("[stroke-width:1.5]", light ? "stroke-muted-foreground/45" : "stroke-muted-foreground/70", LINE_DASH[line])} />
      <path d="M26,1.5 L33,5 L26,8.5 Z" className={light ? "fill-muted-foreground/50" : "fill-muted-foreground/75"} />
    </svg>
  );
}

/** What the chips, the marker and the line styles mean. */
export function MapLegend() {
  return (
    <div role="group" aria-label="Legend" className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-[11px] leading-4 text-muted-foreground shadow-[0_1px_2px_rgb(27_49_57/0.06)]">
      <ul aria-label="Job status" className="flex flex-wrap items-center gap-1.5">
        {LEGEND_STATUSES.map((status) => (
          <li key={status}>
            <StatusChip status={status} />
          </li>
        ))}
        <li>
          <OffChip />
        </li>
        <li className="ml-1 flex items-center gap-1.5">
          <CriticalMarker className="ring-0" />
          Critical
        </li>
      </ul>
      <ul aria-label="Link types" className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
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
