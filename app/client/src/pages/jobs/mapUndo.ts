import { useCallback, useEffect, useEffectEvent, useState } from "react";
import type { Change, JobListDocument } from "../../../../shared/joblist/types";
import type { LayoutPosition, MapDirection } from "../../../../shared/maplayout/types";
import type { SaveOutcome } from "../../hooks/useJobList";
import type { MapLayoutState } from "../../hooks/useMapLayout";
import { type GraphEdge, buildEdges, changeIssues, linkChange, unlinkChange } from "../../lib/graph";

/**
 * One change a person made on the map, with what Undo needs to take it back:
 * for a move or a Tidy up, the direction it was made in and each box's spot
 * from before; for a link added, its key; for a link removed, the link itself.
 *
 * A move of a box that had no saved spot also keeps `saved`: every saved spot
 * of the direction from before the move. Undo clears the direction and saves
 * those again, so the box goes back to the automatic layout instead of being
 * pinned where the automatic layout had it.
 */
export type MapAction =
  | { kind: "move"; direction: MapDirection; before: LayoutPosition[]; saved?: LayoutPosition[] }
  | { kind: "tidy"; direction: MapDirection; before: LayoutPosition[] }
  | { kind: "link-add"; edgeKey: string }
  | { kind: "link-remove"; edge: GraphEdge };

type LayoutAction = Extract<MapAction, { kind: "move" | "tidy" }>;
type LinkAction = Extract<MapAction, { kind: "link-add" | "link-remove" }>;

/** How many actions Undo keeps. */
export const UNDO_LIMIT = 20;

function isLayoutAction(action: MapAction): action is LayoutAction {
  return action.kind === "move" || action.kind === "tidy";
}

/** The stack with the action on top. Past 20 actions, the oldest goes. */
export function pushAction(stack: readonly MapAction[], action: MapAction): MapAction[] {
  return [...stack, action].slice(-UNDO_LIMIT);
}

/** What Undo would take back, as the toolbar's Undo button names it. */
export function undoLabel(action: MapAction | undefined): string {
  if (action === undefined) return "Nothing to undo";
  switch (action.kind) {
    case "move":
      return `Undo: move ${action.before.length} ${action.before.length === 1 ? "box" : "boxes"}`;
    case "tidy":
      return "Undo: Tidy up";
    case "link-add":
      return "Undo: add the link";
    case "link-remove":
      return "Undo: remove the link";
  }
}

/** The job list change that undoes a link action: the added link removed, or the removed link saved again from its own fields. */
export function undoChange(action: LinkAction): Change {
  if (action.kind === "link-add") return unlinkChange(action.edgeKey);
  const { dependency, type } = action.edge;
  return linkChange(dependency.depends_on, dependency.job_name, type, dependency.notes);
}

/** Whether the job list shows a link action undone already: the added link is gone, or the removed one is back. */
export function undoneAlready(action: LinkAction, links: readonly GraphEdge[]): boolean {
  const key = action.kind === "link-add" ? action.edgeKey : action.edge.id;
  const there = links.some((link) => link.id === key);
  return action.kind === "link-add" ? !there : there;
}

/** The line that says an undo can't be done, from the first issue the rules found with its change. */
export function cannotUndo(issue: string): string {
  return `That change can't be undone: ${issue.replace(/\.$/, "")}.`;
}

export interface MapUndoOptions {
  /** The direction the map shows. `layout` holds its saved spots. */
  direction: MapDirection;
  layout: Pick<MapLayoutState, "status" | "positions" | "move" | "reset">;
  /** The job list on screen, which an undo of a link is checked against. */
  document: JobListDocument | null;
  /** True while a change to the job list is on its way: Undo waits for it, as the other edits do. */
  saving: boolean;
  /**
   * Saves a change an undo makes to the job list, from the version on screen. The page shows a conflict or another
   * failure; not rule issues, since Undo says itself why it can't be done.
   */
  saveChange: (change: Change) => Promise<SaveOutcome>;
  /** Turns the map to another direction, to undo a move or a Tidy up made there. */
  turn: (direction: MapDirection) => void;
  /** Called once an action's undo is saved. */
  onUndone: (action: MapAction) => void;
}

export interface MapUndo {
  /** What Undo would take back, or "Nothing to undo". */
  label: string;
  /** True with nothing to undo, while an undo or a job list save is on its way, or until the direction's spots are in. */
  disabled: boolean;
  /** Why the last undo can't be done: the rules refused its change, so it left the stack. Null otherwise. */
  problem: string | null;
  // `this: void`: safe to pass on unbound, as in `const recordAction = history.record`.
  /** Saves moved boxes as a move Undo can take back. `before` holds each box's spot before the move. */
  move(this: void, moves: LayoutPosition[], before: LayoutPosition[]): Promise<boolean>;
  /** Tidy up, as an action Undo can take back. */
  tidy(this: void): Promise<boolean>;
  /** Puts a link change that saved on the stack. */
  record(this: void, action: LinkAction): void;
  /** Takes back the newest action. */
  undo(this: void): void;
}

/**
 * The map's Undo: the person's own map actions in this session, newest on
 * top, up to 20 (moves, Tidy ups, links added and links removed). It is page
 * state, so it clears on reload. Settings saves and an undo's own saves are
 * never on it.
 *
 * Undoing a move or a Tidy up saves the earlier spots again (saves go out in
 * turn, so after the reset for a Tidy up). A move of a box that had no saved
 * spot undoes as a Tidy up's undo does: a reset, then the saved spots from
 * before the move. One made in the other direction turns the map there first,
 * and runs once that direction's spots are in.
 *
 * Undoing a link saves the reverse change as a new version, unless the job
 * list shows it undone already. When the rules refuse that change (checked
 * here first, or a 422 from the server), it can't be undone: it leaves the
 * stack, and `problem` says why. Any other action leaves the stack once its
 * undo is saved, so an undo that meets a conflict or a failure can be tried
 * again.
 */
export function useMapUndo({ direction, layout, document, saving, saveChange, turn, onUndone }: MapUndoOptions): MapUndo {
  const [stack, setStack] = useState<MapAction[]>([]);
  // The action being undone: its save is on its way, or the map is turning to its direction first.
  const [undoing, setUndoing] = useState<{ action: MapAction; turning: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const top = stack.at(-1);
  const { status, positions, move: saveMoves, reset } = layout;

  // A new action makes the line about an undo that can't be done old.
  const record = useCallback((action: MapAction) => {
    setProblem(null);
    setStack((current) => pushAction(current, action));
  }, []);
  const forget = useCallback((action: MapAction) => setStack((current) => current.filter((other) => other !== action)), []);

  const move = useCallback(
    (moves: LayoutPosition[], before: LayoutPosition[]): Promise<boolean> => {
      if (moves.length === 0) return saveMoves(moves);
      // On the stack at once, so an Undo pressed while the save is on its way takes back this move.
      const unsaved = moves.some((moved) => !positions.some((spot) => spot.nodeKey === moved.nodeKey));
      const action: MapAction = { kind: "move", direction, before, ...(unsaved ? { saved: positions } : {}) };
      record(action);
      return saveMoves(moves).then((saved) => {
        if (!saved) forget(action);
        return saved;
      });
    },
    [direction, positions, saveMoves, record, forget],
  );

  const tidy = useCallback((): Promise<boolean> => {
    const action: MapAction = { kind: "tidy", direction, before: positions };
    record(action);
    return reset().then((done) => {
      if (!done) forget(action);
      return done;
    });
  }, [direction, positions, reset, record, forget]);

  /** Clears the direction, then saves these spots again: both go out at once, in turn. */
  const putBack = (spots: LayoutPosition[]): Promise<boolean> =>
    Promise.all([reset(), saveMoves(spots)]).then(([cleared, saved]) => cleared && saved);

  /** The rules refuse the undo's change: it can't be done, so it leaves the stack, and the page says why. */
  const refuse = (action: MapAction, issue: string): false => {
    forget(action);
    setProblem(cannotUndo(issue));
    return false;
  };

  /** Saves the reverse of a link action, unless the job list shows it undone already or the rules would refuse it. */
  const undoLink = (action: LinkAction): Promise<boolean> => {
    if (document === null) return Promise.resolve(false);
    if (undoneAlready(action, buildEdges(document))) return Promise.resolve(true);
    const change = undoChange(action);
    const [issue] = changeIssues(document, change);
    if (issue) return Promise.resolve(refuse(action, issue.message));
    return saveChange(change).then((outcome) => {
      if (outcome.ok) return true;
      // The server's rules refused it: the same as above. A conflict or another failure leaves it to try again.
      if (!outcome.conflict && outcome.issues.length > 0) return refuse(action, outcome.issues[0].message);
      return false;
    });
  };

  /** Undoes the action on the direction on screen. */
  const run = (action: MapAction) => {
    setUndoing({ action, turning: false });
    let saved: Promise<boolean>;
    if (action.kind === "move" && action.saved) saved = putBack(action.saved);
    else if (isLayoutAction(action)) saved = saveMoves(action.before);
    else saved = undoLink(action);
    void saved.then((done) => {
      if (done) {
        forget(action);
        onUndone(action);
      }
      setUndoing(null);
    });
  };

  const waitsForSpots = top !== undefined && isLayoutAction(top) && top.direction === direction && status !== "ready";
  const disabled = top === undefined || undoing !== null || saving || waitsForSpots;

  const undo = () => {
    if (top === undefined || disabled) return;
    setProblem(null);
    if (isLayoutAction(top) && top.direction !== direction) {
      setUndoing({ action: top, turning: true });
      turn(top.direction);
      return;
    }
    run(top);
  };

  // After the map turned for an undo: it runs once the direction's spots are in. When they don't load, or the person
  // turns the map away again first, it doesn't run, and the action stays on the stack.
  const afterTurn = useEffectEvent(() => {
    if (undoing === null || !undoing.turning) return;
    const { action } = undoing;
    if (!isLayoutAction(action) || action.direction !== direction || status === "failed") setUndoing(null);
    else if (status === "ready") run(action);
  });
  useEffect(() => afterTurn(), [undoing, direction, status]);

  return { label: undoLabel(top), disabled, problem, move, tidy, record, undo };
}
