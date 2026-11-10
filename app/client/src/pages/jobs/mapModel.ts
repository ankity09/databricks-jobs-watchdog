import type { Edge, FitViewOptions, Node } from "@xyflow/react";
import { CalendarClock, Infinity as InfinityIcon, type LucideIcon, Zap } from "lucide-react";
import type { DependencyType, ScheduleType } from "../../../../shared/joblist/types";
import type { EdgeLine, GraphEdge, GraphNode, LayoutDirection } from "../../lib/graph";
import type { Status, StatusTone } from "../../lib/status";
import type { CardFacts } from "./mapFacts";

/**
 * How a box looks right now: selected; downstream of the selection (affected
 * by a failure there); upstream of it (what it depends on); dimmed; or its
 * state while picking a link.
 */
export type NodeHighlight = "none" | "selected" | "downstream" | "upstream" | "dimmed" | "source" | "candidate" | "unavailable";
export type EdgeHighlight = "none" | "downstream" | "upstream" | "dimmed";

// React Flow wants type aliases, not interfaces, for node and edge data.
export type MapNodeData = {
  box: GraphNode;
  highlight: NodeHighlight;
  statusLoading: boolean;
  direction: LayoutDirection;
  /** What a listed job's card says under its name; null for a service or a job that is not in the list. */
  facts: CardFacts | null;
};
export type JobFlowNode = Node<MapNodeData, "job">;
export type ServiceFlowNode = Node<MapNodeData, "service">;
export type SectionFlowNode = Node<{ title: string; count: number }, "section">;
export type MapFlowNode = JobFlowNode | ServiceFlowNode | SectionFlowNode;
export type LinkEdgeData = {
  link: GraphEdge;
  highlight: EdgeHighlight;
  /** On the line selected with a pointer: what its × does, which is to remove the link. */
  onRemove?: () => void;
  /** True while a change saves, when the × waits. */
  saving?: boolean;
};
export type LinkFlowEdge = Edge<LinkEdgeData, "link">;

/** What a popover on the map anchors to: anything with a screen rectangle, such as a link or a box. */
export interface Measurable {
  getBoundingClientRect(): DOMRect;
}

/** The arrowheads: one per line color, since a marker cannot follow its line's CSS. */
export const ARROW = {
  neutral: "watchdog-map-arrow",
  light: "watchdog-map-arrow-light",
  accent: "watchdog-map-arrow-accent",
  dark: "watchdog-map-arrow-dark",
} as const;
export type ArrowTone = keyof typeof ARROW;

export const STATUS_LABEL: Record<Status, string> = { FAILED: "Failed", WARNING: "Warning", UNKNOWN: "Unknown", HEALTHY: "Healthy" };

/** The legend's order: healthy first, as the eye reads left to right. */
export const LEGEND_STATUSES: Status[] = ["HEALTHY", "WARNING", "FAILED", "UNKNOWN"];

/** The lucide icon on a job's tile, by schedule type. */
export const SCHEDULE_ICON: Record<ScheduleType, LucideIcon> = { scheduled: CalendarClock, continuous: InfinityIcon, triggered: Zap };

/** A card's icon tile, tinted by the job's status. */
export const TONE_TILE: Record<StatusTone, string> = {
  destructive: "bg-destructive/10 text-destructive ring-destructive/15",
  warning: "bg-warning/10 text-warning ring-warning/15",
  muted: "bg-muted-foreground/10 text-muted-foreground ring-muted-foreground/10",
  success: "bg-success/10 text-success ring-success/15",
};

/** The minimap's boxes. */
export const TONE_FILL: Record<StatusTone, string> = {
  destructive: "fill-destructive/70",
  warning: "fill-warning/70",
  muted: "fill-muted-foreground/30",
  success: "fill-success/70",
};

export const LINE_DASH: Record<EdgeLine, string> = {
  solid: "",
  dashed: "[stroke-dasharray:6_4]",
  dotted: "[stroke-dasharray:1_4] [stroke-linecap:round]",
};

/**
 * The slow dash flow along a selected job's downstream links, only when the
 * person has not asked for reduced motion. A solid link takes dashes for the
 * flow; dashed and dotted links move their own pattern.
 */
export const LINE_FLOW: Record<EdgeLine, string> = {
  solid: "motion-safe:[stroke-dasharray:6_4] motion-safe:animate-map-flow",
  dashed: "motion-safe:animate-map-flow",
  dotted: "motion-safe:animate-map-flow",
};

const TYPE_NAME: Record<DependencyType, string> = { job: "job", child_job: "child job", service: "service" };

/** The type of a link, as the side panel names it. */
export const TYPE_LABEL: Record<DependencyType, string> = { job: "Job", child_job: "Child job", service: "Service" };

/** A box's accessible name: its name, then its status, or that it is a service. */
export function boxLabel(box: GraphNode, statusLoading: boolean): string {
  if (box.kind === "service") return `${box.name} (service)`;
  if (!box.listed) return `${box.name} (not in the job list)`;
  const status = statusLoading ? "loading status" : STATUS_LABEL[box.status];
  return `${box.name} (${status}${box.active ? "" : ", switched off"})`;
}

/** A link's accessible name, such as "orders_enrich depends on orders_ingest (job link)". */
export function linkLabel(link: GraphEdge): string {
  return `${link.dependency.job_name} depends on ${link.dependency.depends_on} (${TYPE_NAME[link.type]} link)`;
}

/** What a link means, in one sentence. */
export function linkMeaning(link: GraphEdge): string {
  const { job_name: job, depends_on: on } = link.dependency;
  switch (link.type) {
    case "job":
      return `Job link. A failure of ${on} affects ${job}.`;
    case "child_job":
      return `Child job. ${on} starts ${job}, so a failure of either affects the other.`;
    case "service":
      return `Service link. ${job} needs ${on}.`;
  }
}

/**
 * Where the overlays sit on the canvas, in pixels: each is `inset` from the
 * edges. The toolbar is at the top left, the legend at the bottom left, the
 * minimap at the bottom right, and the side panel down the right.
 */
export const OVERLAY = { inset: 12, toolbar: 36, legend: 90, minimap: 120, panel: 360 } as const;
/** The canvas width from which the minimap shows (Tailwind's @2xl, 42rem). */
export const MINIMAP_FROM = 672;
/** The canvas width from which the side panel opens over the map; on a narrower canvas it opens under it. */
export const PANEL_OVER_FROM = 768;
/**
 * React Flow's canvas width is 0 until it measures the canvas (1 under the
 * test stand-ins). A width below this is not a measurement yet.
 */
export const MEASURED_FROM = 200;
/** The space a slide keeps between a card and the panel or the canvas's left edge. */
export const EDGE_GAP = { left: 24, panel: 16 } as const;
const GAP = 16;

/**
 * How the view fits the cards: clear of the toolbar at the top, and of the
 * legend and the minimap at the bottom. A fit never makes room for the side
 * panel: it would zoom the whole map into the space beside the panel and
 * leave it there when the panel closes. A slide clears the panel instead.
 */
export function fitOptions(width: number): FitViewOptions {
  const top = OVERLAY.inset + OVERLAY.toolbar + GAP;
  const bottom = OVERLAY.inset + (width >= MINIMAP_FROM ? OVERLAY.minimap : OVERLAY.legend) + GAP;
  return { padding: { top: `${top}px`, right: "24px", bottom: `${bottom}px`, left: "24px" }, maxZoom: 1.1 };
}

/** True when the side panel opens under the map instead of over it. */
export function panelGoesUnder(width: number): boolean {
  return width >= MEASURED_FROM && width < PANEL_OVER_FROM;
}

/** True when the person asked for less motion. */
export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** How long a zoom or a fit from the toolbar takes: a short glide, or none with reduced motion. */
export function viewDuration(): number {
  return prefersReducedMotion() ? 0 : 200;
}
