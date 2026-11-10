/** The map's direction state: left to right, or top to bottom. */
export type MapDirection = "LR" | "TB";

/** Where a person put one box. nodeKey is the map's node ID (jobNodeId / serviceNodeId in lib/graph.ts). */
export interface LayoutPosition {
  nodeKey: string;
  x: number;
  y: number;
}

export interface MapLayout {
  direction: MapDirection;
  positions: LayoutPosition[];
}

/** The most moves one save may carry. */
export const MAX_MOVES_PER_SAVE = 500;
