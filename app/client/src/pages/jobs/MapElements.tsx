import { Skeleton, Tooltip, TooltipContent, TooltipTrigger } from "@databricks/appkit-ui/react";
import {
  BaseEdge,
  type ConnectionLineComponentProps,
  EdgeLabelRenderer,
  type EdgeProps,
  Handle,
  type NodeProps,
  Position,
  getBezierPath,
  getSmoothStepPath,
} from "@xyflow/react";
import { CircleHelp, Server, X } from "lucide-react";
import type { ReactElement } from "react";
import type { EdgeLine, GraphEdge, LayoutDirection } from "../../lib/graph";
import { type Status, statusTone } from "../../lib/status";
import { cn } from "../../lib/utils";
import { TONE_CHIP } from "../monitoring/format";
import { SCHEDULE_TYPES } from "../../lib/job-form";
import { SCHEDULE_LABEL } from "./mapFacts";
import {
  ARROW,
  type ArrowTone,
  type JobFlowNode,
  LEGEND_STATUSES,
  LINE_DASH,
  LINE_FLOW,
  type LinkFlowEdge,
  type MapFlowNode,
  type NodeHighlight,
  SCHEDULE_ICON,
  STATUS_LABEL,
  type SectionFlowNode,
  type ServiceFlowNode,
  TONE_TILE,
  boxLabel,
  linkLabel,
} from "./mapModel";

/** The card's frame for each highlight: border, ring and opacity. */
const FRAME: Record<NodeHighlight, string> = {
  none: "border-border hover:border-muted-foreground/45",
  selected: "border-primary ring-1 ring-primary shadow-[0_0_0_4px_rgb(255_54_33/0.12)]",
  downstream: "border-primary/50 hover:border-primary/75",
  upstream: "border-foreground/35 hover:border-foreground/50",
  // Faded, except while it has keyboard focus: the focus ring must not fade with the card.
  dimmed: "border-border opacity-35 focus-visible:opacity-100",
  source: "border-primary ring-1 ring-primary shadow-[0_0_0_4px_rgb(255_54_33/0.12)]",
  candidate: "border-border hover:border-primary hover:ring-1 hover:ring-primary/40",
  unavailable: "cursor-not-allowed border-border opacity-35 focus-visible:opacity-100",
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

/**
 * When the ports show: always on a selected card; else on hover, while the
 * card has focus, and on the port a link drag starts from or snaps to.
 */
function portVisibility(highlight: NodeHighlight): string {
  if (highlight === "selected" || highlight === "source") return "opacity-100";
  // The ports sit outside the card, so they fade with a faded card here.
  const faded = highlight === "dimmed" || highlight === "unavailable";
  return cn(
    "opacity-0 group-focus-within:opacity-100 [&.connectingfrom]:opacity-100 [&.connectingto]:opacity-100",
    faded ? "group-hover:opacity-35" : "group-hover:opacity-100",
  );
}

interface PortsProps {
  /** The box's name, which names its ports. */
  name: string;
  direction: LayoutDirection;
  highlight: NodeHighlight;
  /** True when a link can be dragged from or to the ports. */
  connectable: boolean;
}

/**
 * The in and out ports: small circles at the middle of the left and right
 * sides, or of the top and bottom. A link is dragged from a box's port to
 * another box. The in port is named "Link to <name>", the out port "Link from
 * <name>". They sit over the card's edge, with a little room around them, so a
 * press on any part of a port starts a link.
 */
function Ports({ name, direction, highlight, connectable }: PortsProps) {
  const className = cn(
    "z-10 size-2 min-h-0 min-w-0 rounded-full border-[1.5px] bg-card transition-[border-color,opacity] duration-150 motion-reduce:transition-none",
    "before:absolute before:-inset-1.5 before:rounded-full before:content-['']",
    PORT[portEmphasis(highlight)],
    portVisibility(highlight),
  );
  return (
    <>
      <Handle
        id="in"
        type="target"
        position={direction === "LR" ? Position.Left : Position.Top}
        isConnectable={connectable}
        role="img"
        aria-label={`Link to ${name}`}
        className={className}
      />
      <Handle
        id="out"
        type="source"
        position={direction === "LR" ? Position.Right : Position.Bottom}
        isConnectable={connectable}
        role="img"
        aria-label={`Link from ${name}`}
        className={className}
      />
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
export function JobNode({ data, isConnectable }: NodeProps<JobFlowNode>) {
  const { box, highlight, statusLoading, direction, facts } = data;
  const tone = box.listed ? statusTone(box.status) : "muted";
  const Icon = facts ? SCHEDULE_ICON[facts.schedule] : CircleHelp;
  let meta = "Not in the job list";
  if (facts) meta = facts.owner ? `${facts.owner} · ${SCHEDULE_LABEL[facts.schedule]}` : SCHEDULE_LABEL[facts.schedule];
  return (
    <>
      <Ports name={box.name} direction={direction} highlight={highlight} connectable={isConnectable} />
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
              {/* One line: when the schedule does not fit after the owner, it wraps onto a hidden second line instead of being cut. */}
              <span data-part="meta" className="flex h-[18px] min-w-0 flex-1 flex-wrap overflow-hidden text-[11px] leading-[18px] text-muted-foreground">
                {facts?.owner ? <span className="max-w-full truncate">{facts.owner}</span> : null}
                <span className="whitespace-nowrap">{facts?.owner ? `\u00a0·\u00a0${SCHEDULE_LABEL[facts.schedule]}` : meta}</span>
              </span>
              {box.active ? null : <OffChip />}
              {!box.listed ? null : statusLoading ? <Skeleton className="h-[18px] w-14 rounded-[5px]" /> : <StatusChip status={box.status} />}
            </span>
          </span>
          {highlight === "downstream" ? (
            <span
              data-part="affected"
              aria-hidden="true"
              // The accent as the outline, the text in the foreground color: 10 px white on #FF3621 is only 3.6:1.
              className="absolute -top-2.5 right-3 rounded-full border border-primary bg-card px-1.5 text-[10px] leading-4 font-medium text-foreground shadow-sm"
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
export function ServiceNode({ data, isConnectable }: NodeProps<ServiceFlowNode>) {
  const { box, highlight, direction } = data;
  return (
    <>
      <Ports name={box.name} direction={direction} highlight={highlight} connectable={isConnectable} />
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

/** The child tag's outline and text: the line's color as the outline, and readable text (10 px #FF3621 on white is only 3.6:1). */
const TAG_TONE: Record<ArrowTone, { box: string; text: string }> = {
  neutral: { box: "stroke-input", text: "fill-muted-foreground" },
  light: { box: "stroke-input", text: "fill-muted-foreground" },
  accent: { box: "stroke-primary", text: "fill-foreground" },
  dark: { box: "stroke-foreground/35", text: "fill-foreground" },
};

/** The child tag's width: "child" at 10 px with 4 pixels on each side, so it fits the 56 pixel gap between ranks. */
const TAG_WIDTH = 30;

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
      <rect x={-TAG_WIDTH / 2} y={-8} width={TAG_WIDTH} height={16} rx={8} className={cn("fill-card [stroke-width:1]", TAG_TONE[tone].box)} />
      <text textAnchor="middle" dominantBaseline="central" className={cn("text-[10px] font-medium", TAG_TONE[tone].text)}>
        child
      </text>
    </g>
  );
}

interface RemoveButtonProps {
  link: GraphEdge;
  /** The middle of the line, on the canvas. */
  x: number;
  y: number;
  saving: boolean;
  onRemove: () => void;
}

/**
 * The × at the middle of a selected line: it removes the link. Its z-index
 * puts it over the selected line, whose layer React Flow raises (zIndex 1), so
 * the line's wide hit area does not take the click.
 */
function RemoveButton({ link, x, y, saving, onRemove }: RemoveButtonProps) {
  return (
    <EdgeLabelRenderer>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`Remove the link: ${linkLabel(link)}`}
            disabled={saving}
            // nodrag and nopan: pressing the × neither drags nor pans the map.
            className={cn(
              "nodrag nopan pointer-events-auto absolute top-0 left-0 z-10 grid size-5 cursor-pointer place-items-center rounded-full border border-primary bg-card text-primary",
              "shadow-[0_1px_3px_rgb(27_49_57/0.15)] transition-colors duration-150 hover:bg-primary hover:text-primary-foreground motion-reduce:transition-none",
              "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
            // The line's middle moves with the boxes, so the × is placed where it is now.
            style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
            onClick={(event) => {
              // The click stays with the ×: on the line it would select the line again.
              event.stopPropagation();
              onRemove();
            }}
          >
            <X className="size-3" strokeWidth={2.5} aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">Remove link</TooltipContent>
      </Tooltip>
    </EdgeLabelRenderer>
  );
}

/**
 * A link: a rounded orthogonal line with a closed arrowhead at the dependent
 * end. Job links are solid, child-job links dashed with a "child" label, and
 * service links dotted and lighter. A selection's downstream links turn the
 * accent and flow; its upstream path turns dark neutral; the rest fade. A link
 * with keyboard focus turns the focus color and wider, even when faded: its
 * <g> is the "group" (the edge's className), and these classes beat React
 * Flow's own focus style, which sits in the components layer. A line selected
 * with a pointer has a × at its middle, which removes it.
 */
export function LinkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, interactionWidth }: EdgeProps<LinkFlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 12, offset: 18 });
  const highlight = data?.highlight ?? "none";
  const lineStyle = data?.link.line ?? "solid";
  // `selected` is the line selected with a pointer, or the link whose menu is open.
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
      {data?.onRemove ? <RemoveButton link={data.link} x={labelX} y={labelY} saving={data.saving ?? false} onRemove={data.onRemove} /> : null}
    </>
  );
}

/** A link while it is dragged: a dashed line in the accent, from the port it started at to the pointer. */
export function DraftLine({ fromX, fromY, toX, toY, fromPosition, toPosition }: ConnectionLineComponentProps<MapFlowNode>) {
  const [path] = getBezierPath({ sourceX: fromX, sourceY: fromY, sourcePosition: fromPosition, targetX: toX, targetY: toY, targetPosition: toPosition });
  return <path d={path} fill="none" className="stroke-primary [stroke-dasharray:6_4] [stroke-width:2]" />;
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

/** What the chips, the marker, the schedule icons and the line styles mean. */
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
      <ul aria-label="Schedule" className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
        {SCHEDULE_TYPES.map((schedule) => {
          const Icon = SCHEDULE_ICON[schedule];
          return (
            <li key={schedule} className="flex items-center gap-1.5">
              <Icon className="size-3.5 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
              {SCHEDULE_LABEL[schedule]}
            </li>
          );
        })}
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
