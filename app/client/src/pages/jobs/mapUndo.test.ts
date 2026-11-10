import { describe, expect, it } from "vitest";
import type { LayoutPosition } from "../../../../shared/maplayout/types";
import { type GraphEdge, buildEdges } from "../../lib/graph";
import { EXAMPLE_DOCUMENT } from "../../test/example-document";
import { type MapAction, UNDO_LIMIT, pushAction, undoChange, undoLabel, undoneAlready } from "./mapUndo";

const LINKS = buildEdges(EXAMPLE_DOCUMENT);

function link(id: string): GraphEdge {
  const found = LINKS.find((edge) => edge.id === id);
  if (!found) throw new Error(`no link ${id}`);
  return found;
}

function spot(n: number): LayoutPosition {
  return { nodeKey: `job:job_${n}`, x: n * 10, y: 0 };
}

describe("mapUndo", () => {
  it("the stack keeps the newest 20", () => {
    expect(UNDO_LIMIT).toBe(20);
    let stack: MapAction[] = [];
    for (let n = 1; n <= 25; n++) stack = pushAction(stack, { kind: "move", direction: "LR", before: [spot(n)] });
    expect(stack).toHaveLength(20);
    // The five oldest went, and the newest is on top.
    expect(stack[0]).toEqual({ kind: "move", direction: "LR", before: [spot(6)] });
    expect(stack.at(-1)).toEqual({ kind: "move", direction: "LR", before: [spot(25)] });

    // A push gives a new stack and leaves the one it was given as it was.
    const kept = [...stack];
    const next = pushAction(stack, { kind: "link-add", edgeKey: "orders_enrich->orders_ingest:job" });
    expect(stack).toEqual(kept);
    expect(next).toHaveLength(20);
    expect(next.at(-1)).toEqual({ kind: "link-add", edgeKey: "orders_enrich->orders_ingest:job" });
  });

  it("labels name the action", () => {
    expect(undoLabel(undefined)).toBe("Nothing to undo");
    expect(undoLabel({ kind: "move", direction: "LR", before: [spot(1), spot(2)] })).toBe("Undo: move 2 boxes");
    expect(undoLabel({ kind: "move", direction: "TB", before: [spot(1)] })).toBe("Undo: move 1 box");
    expect(undoLabel({ kind: "tidy", direction: "LR", before: [spot(1), spot(2), spot(3)] })).toBe("Undo: Tidy up");
    expect(undoLabel({ kind: "link-add", edgeKey: "orders_enrich->orders_ingest:job" })).toBe("Undo: add the link");
    expect(undoLabel({ kind: "link-remove", edge: link("orders_enrich->orders_ingest:job") })).toBe("Undo: remove the link");
  });

  it("undoing a link saves the reverse change, a removed link from its own fields", () => {
    expect(undoChange({ kind: "link-add", edgeKey: "orders_enrich->orders_ingest:job" })).toEqual({
      kind: "delete",
      target: { type: "dependency", key: "orders_enrich->orders_ingest:job" },
    });
    expect(undoChange({ kind: "link-remove", edge: link("daily_revenue_export->daily_revenue_report:child_job") })).toEqual({
      kind: "upsert",
      target: { type: "dependency", key: "daily_revenue_export->daily_revenue_report:child_job" },
      value: {
        job_name: "daily_revenue_export",
        depends_on: "daily_revenue_report",
        dependency_type: "child_job",
        notes: "daily_revenue_report starts it as its last task.",
      },
    });
  });

  it("knows when the job list already shows a link action undone", () => {
    const added = { kind: "link-add", edgeKey: "orders_enrich->orders_ingest:job" } as const;
    const removed = { kind: "link-remove", edge: link("orders_ingest->kafka:service") } as const;
    // The added link is still there, and so is the removed one: someone saved it again.
    expect(undoneAlready(added, LINKS)).toBe(false);
    expect(undoneAlready(removed, LINKS)).toBe(true);
    // Without them: the added link is gone already, and the removed one still needs saving again.
    const without = LINKS.filter((edge) => edge.id !== "orders_enrich->orders_ingest:job" && edge.id !== "orders_ingest->kafka:service");
    expect(undoneAlready(added, without)).toBe(true);
    expect(undoneAlready(removed, without)).toBe(false);
  });
});
