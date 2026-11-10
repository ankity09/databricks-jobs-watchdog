import { describe, expect, it } from "vitest";
import type { GraphNode } from "./graph";
import { applySavedLayout, movedNodes, notLinkedYet } from "./layoutMerge";

/** A job's box at a spot from the automatic layout. */
function job(name: string, x: number, y: number, linked = true): GraphNode {
  return { id: `job:${name}`, kind: "job", name, status: "UNKNOWN", active: true, listed: true, linked, position: { x, y }, width: 248, height: 68 };
}

/** Whether two boxes cover some of the same area. */
function overlaps(a: GraphNode, b: GraphNode): boolean {
  return (
    a.position.x < b.position.x + b.width &&
    b.position.x < a.position.x + a.width &&
    a.position.y < b.position.y + b.height &&
    b.position.y < a.position.y + a.height
  );
}

describe("applySavedLayout", () => {
  it("a saved position wins", () => {
    const { nodes, placed } = applySavedLayout([job("orders_ingest", 0, 0), job("orders_enrich", 304, 0)], [{ nodeKey: "job:orders_enrich", x: 900, y: 450 }]);
    expect(nodes.map((n) => n.position)).toEqual([
      { x: 0, y: 0 },
      { x: 900, y: 450 },
    ]);
    expect([...placed]).toEqual(["job:orders_enrich"]);
  });

  it("an unknown key is ignored", () => {
    const automatic = [job("orders_ingest", 0, 0), job("orders_enrich", 304, 0)];
    // A job that was renamed or removed keeps its saved row; the map leaves it out.
    const { nodes, placed } = applySavedLayout(automatic, [{ nodeKey: "job:orders_renamed", x: 900, y: 450 }]);
    expect(nodes).toEqual(automatic);
    expect(placed.size).toBe(0);
  });

  it("a node without a saved spot never overlaps a placed node", () => {
    // Two boxes at the same automatic spot, and one is saved there.
    const { nodes } = applySavedLayout([job("orders_ingest", 100, 100), job("orders_enrich", 100, 100)], [{ nodeKey: "job:orders_ingest", x: 100, y: 100 }]);
    const [saved, other] = nodes;
    expect(saved.position).toEqual({ x: 100, y: 100 });
    expect(overlaps(saved, other)).toBe(false);
    // It steps down by its height plus 16, which leaves a 16 pixel gap.
    expect(other.position).toEqual({ x: 100, y: 100 + 68 + 16 });
  });

  it("a box that steps down goes past the boxes under it, and they keep their spots", () => {
    // A column with 16 pixels between the boxes, as the automatic layout makes it; a box is dropped on the first.
    const column = [job("orders_ingest", 0, 0), job("orders_enrich", 0, 84), job("daily_revenue_report", 0, 168)];
    const { nodes } = applySavedLayout([...column, job("watchdog_demo_slow", 600, 0)], [{ nodeKey: "job:watchdog_demo_slow", x: 0, y: 0 }]);
    const spot = new Map(nodes.map((n) => [n.id, n.position]));
    expect(spot.get("job:orders_enrich")).toEqual({ x: 0, y: 84 });
    expect(spot.get("job:daily_revenue_report")).toEqual({ x: 0, y: 168 });
    expect(spot.get("job:orders_ingest")).toEqual({ x: 0, y: 252 });
    for (const a of nodes) for (const b of nodes) if (a !== b) expect(overlaps(a, b)).toBe(false);
  });

  it("a placed unlinked node leaves the section", () => {
    const automatic = [job("orders_ingest", 0, 0), job("watchdog_demo_slow", 0, 200, false), job("watchdog_demo_retries", 272, 200, false)];
    const { nodes, placed } = applySavedLayout(automatic, [{ nodeKey: "job:watchdog_demo_slow", x: 600, y: 0 }]);
    expect(notLinkedYet(nodes, placed).map((n) => n.id)).toEqual(["job:watchdog_demo_retries"]);
    expect(notLinkedYet(automatic, new Set()).map((n) => n.id)).toEqual(["job:watchdog_demo_slow", "job:watchdog_demo_retries"]);
  });
});

describe("movedNodes", () => {
  it("movedNodes skips moves under 1 px", () => {
    const before = new Map([
      ["job:orders_ingest", { x: 0, y: 0 }],
      ["job:orders_enrich", { x: 100, y: 0 }],
      ["job:daily_revenue_report", { x: 200, y: 0 }],
    ]);
    const after = [
      { id: "job:orders_ingest", position: { x: 0.6, y: 0.6 } },
      { id: "job:orders_enrich", position: { x: 101, y: 0 } },
      { id: "job:daily_revenue_report", position: { x: 200, y: 0 } },
    ];
    expect(movedNodes(before, after)).toEqual([{ nodeKey: "job:orders_enrich", x: 101, y: 0 }]);
    // A larger threshold leaves out the one pixel move too.
    expect(movedNodes(before, after, 2)).toEqual([]);
  });
});
