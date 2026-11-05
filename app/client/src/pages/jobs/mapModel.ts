import type { Edge, Node } from "@xyflow/react";
import type { DependencyType } from "../../../../shared/joblist/types";
import type { EdgeLine, GraphEdge, GraphNode } from "../../lib/graph";
import type { Status, StatusTone } from "../../lib/status";

/** How a box looks right now: selected, affected by the selection, dimmed, or its state while picking a link. */
export type NodeHighlight = "none" | "selected" | "downstream" | "dimmed" | "source" | "candidate" | "unavailable";
export type EdgeHighlight = "none" | "downstream" | "dimmed";

// React Flow wants type aliases, not interfaces, for node and edge data.
export type MapNodeData = { box: GraphNode; highlight: NodeHighlight; statusLoading: boolean };
export type JobFlowNode = Node<MapNodeData, "job">;
export type ServiceFlowNode = Node<MapNodeData, "service">;
export type SectionFlowNode = Node<{ text: string }, "section">;
export type MapFlowNode = JobFlowNode | ServiceFlowNode | SectionFlowNode;
export type LinkEdgeData = { link: GraphEdge; highlight: EdgeHighlight };
export type LinkFlowEdge = Edge<LinkEdgeData, "link">;

export const ARROW_MARKER = "watchdog-map-arrow";
export const ARROW_MARKER_ACCENT = "watchdog-map-arrow-accent";

export const STATUS_LABEL: Record<Status, string> = { FAILED: "Failed", WARNING: "Warning", UNKNOWN: "Unknown", HEALTHY: "Healthy" };

/** The legend's order: healthy first, as the eye reads left to right. */
export const LEGEND_STATUSES: Status[] = ["HEALTHY", "WARNING", "FAILED", "UNKNOWN"];

export const TONE_EDGE: Record<StatusTone, string> = {
  destructive: "border-l-destructive",
  warning: "border-l-warning",
  muted: "border-l-muted-foreground/40",
  success: "border-l-success",
};

export const TONE_DOT: Record<StatusTone, string> = {
  destructive: "bg-destructive",
  warning: "bg-warning",
  muted: "bg-muted-foreground/45",
  success: "bg-success",
};

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

const TYPE_NAME: Record<DependencyType, string> = { job: "job", child_job: "child job", service: "service" };

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
