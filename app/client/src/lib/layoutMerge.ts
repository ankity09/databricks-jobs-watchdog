import type { LayoutPosition } from "../../../shared/maplayout/types";
import type { GraphNode } from "./graph";

/** A spot on the map: a box's top-left corner. */
export interface Spot {
  x: number;
  y: number;
}

/** The room a box without a saved spot keeps from the others, which is also the gap it steps down by. */
const MARGIN = 16;
/** How many times such a box steps down, looking for a free spot. */
const MAX_STEPS = 50;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Whether `a`, with the margin around it, overlaps `b`. */
function crowds(a: Rect, b: Rect): boolean {
  return a.x - MARGIN < b.x + b.width && b.x < a.x + a.width + MARGIN && a.y - MARGIN < b.y + b.height && b.y < a.y + a.height + MARGIN;
}

/**
 * The map's boxes with the saved positions put over the automatic layout.
 * - A box with a saved position goes there. Saved positions for boxes that
 *   are not on the map (a job removed or renamed) are left out.
 * - A box without one keeps its automatic spot, unless that spot comes
 *   within 16 pixels of a placed box. Then it steps down by its height plus
 *   16, up to 50 times, until it is clear of every other box. The step is
 *   the automatic layout's gap, so stopping at the first spot clear of the
 *   placed boxes would land it on the box under it.
 *
 * `placed` holds the boxes that have a saved position.
 */
export function applySavedLayout(nodes: GraphNode[], saved: LayoutPosition[]): { nodes: GraphNode[]; placed: Set<string> } {
  const onMap = new Set(nodes.map((n) => n.id));
  const spots = new Map<string, Spot>();
  for (const position of saved) if (onMap.has(position.nodeKey)) spots.set(position.nodeKey, { x: position.x, y: position.y });
  const placed = new Set(spots.keys());
  if (placed.size === 0) return { nodes, placed };

  // Every box where it is now: at its saved spot, or at its automatic spot until it settles.
  const rects = new Map<string, Rect>(nodes.map((n) => [n.id, { ...(spots.get(n.id) ?? n.position), width: n.width, height: n.height }]));
  const placedRects = [...placed].flatMap((id) => rects.get(id) ?? []);
  for (const n of nodes) {
    const rect = rects.get(n.id);
    if (rect === undefined || placed.has(n.id) || !placedRects.some((other) => crowds(rect, other))) continue;
    const blocked = () => [...rects].some(([id, other]) => id !== n.id && crowds(rect, other));
    for (let step = 0; step < MAX_STEPS && blocked(); step++) rect.y += n.height + MARGIN;
  }
  return {
    nodes: nodes.map((n) => {
      const rect = rects.get(n.id);
      return rect === undefined || (rect.x === n.position.x && rect.y === n.position.y) ? n : { ...n, position: { x: rect.x, y: rect.y } };
    }),
    placed,
  };
}

/** The boxes the "Not linked yet" group holds: those with no links and no saved spot. A box dragged out of it stays out. */
export function notLinkedYet(nodes: GraphNode[], placed: ReadonlySet<string>): GraphNode[] {
  return nodes.filter((n) => !n.linked && !placed.has(n.id));
}

/**
 * The boxes that moved at least `threshold` pixels from where they were
 * (`before`), as the positions to save. A box with no spot before counts as
 * moved.
 */
export function movedNodes(before: ReadonlyMap<string, Spot>, after: { id: string; position: Spot }[], threshold = 1): LayoutPosition[] {
  return after
    .filter(({ id, position }) => {
      const from = before.get(id);
      return from === undefined || Math.hypot(position.x - from.x, position.y - from.y) >= threshold;
    })
    .map(({ id, position }) => ({ nodeKey: id, x: position.x, y: position.y }));
}
