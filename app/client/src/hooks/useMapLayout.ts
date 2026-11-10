import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LayoutPosition, MapDirection } from "../../../shared/maplayout/types";
import { getMapLayout, resetMapLayout, saveMapMoves } from "../lib/layout-api";
import { type Spot, movedNodes } from "../lib/layoutMerge";

const LOAD_PROBLEM = "Saved positions couldn't load, so the map shows the automatic layout. Moving boxes is off until they load.";
const MOVE_PROBLEM = "That move couldn't be saved, so the box went back.";
const TIDY_PROBLEM = "Tidy up couldn't be saved, so the boxes stayed where they were.";

/** How long after the last arrow key a box moved with the keys is saved. */
const KEY_MOVE_SAVE_MS = 600;

export interface MapLayoutState {
  /** Loading until the direction's saved positions are in; failed when they could not be read. */
  status: "loading" | "ready" | "failed";
  /** The direction's saved positions, with this page's moves in them. Empty unless ready. */
  positions: LayoutPosition[];
  /** What went wrong, as a line for the page: the load, the last move or the last Tidy up. */
  problem: string | null;
  // `this: void`: safe to pass on unbound, as in `useBoxMoves(layout.move)`.
  /** Saves moved boxes. They show at once, and go back (with the problem set) when the save fails. Resolves with whether it saved. */
  move(this: void, moves: LayoutPosition[]): Promise<boolean>;
  /** Tidy up: clears the direction's saved positions for everyone. The boxes move once the server has done it. */
  reset(this: void): Promise<boolean>;
  /** Asks for the saved positions again, after a failed load. */
  retry(this: void): void;
}

/** A load's answer for a direction, with this page's changes since. */
interface Loaded {
  direction: MapDirection;
  /** The retry it answers: a newer retry makes it old. */
  attempt: number;
  status: "ready" | "failed";
  positions: LayoutPosition[];
  problem: string | null;
}

const NO_POSITIONS: LayoutPosition[] = [];

/** The positions with the moves in them: a moved box's spot is replaced, a box new to the layout is added. */
function withMoves(positions: LayoutPosition[], moves: LayoutPosition[]): LayoutPosition[] {
  const next = new Map(positions.map((position) => [position.nodeKey, position]));
  for (const move of moves) next.set(move.nodeKey, move);
  return [...next.values()];
}

/** The positions with failed moves taken back: each box gets its spot from before, unless a later move has moved it since. */
function withoutMoves(positions: LayoutPosition[], moves: LayoutPosition[], before: ReadonlyMap<string, LayoutPosition>): LayoutPosition[] {
  const next = new Map(positions.map((position) => [position.nodeKey, position]));
  for (const move of moves) {
    const now = next.get(move.nodeKey);
    if (now === undefined || now.x !== move.x || now.y !== move.y) continue;
    const earlier = before.get(move.nodeKey);
    if (earlier) next.set(move.nodeKey, earlier);
    else next.delete(move.nodeKey);
  }
  return [...next.values()];
}

/**
 * The map's saved box positions for one direction, shared by everyone who
 * opens the map. A direction change loads that direction's positions; until
 * they are in, the status is loading and no positions show. Moves are
 * optimistic: they show at once and go back if their save fails.
 */
export function useMapLayout(direction: MapDirection): MapLayoutState {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    // An answer that comes after the direction changed, or after a retry, is dropped.
    let current = true;
    void getMapLayout(direction).then(
      (layout) => {
        if (current) setLoaded({ direction, attempt, status: "ready", positions: layout.positions, problem: null });
      },
      () => {
        if (current) setLoaded({ direction, attempt, status: "failed", positions: NO_POSITIONS, problem: LOAD_PROBLEM });
      },
    );
    return () => {
      current = false;
    };
  }, [direction, attempt]);

  // The last answer counts only for its own direction and retry; until a newer one is in, the positions are loading.
  const shown = loaded !== null && loaded.direction === direction && loaded.attempt === attempt ? loaded : null;
  const ready = shown?.status === "ready";
  const positions = shown !== null && ready ? shown.positions : NO_POSITIONS;

  const move = useCallback(
    async (moves: LayoutPosition[]): Promise<boolean> => {
      if (!ready) return false;
      if (moves.length === 0) return true;
      const before = new Map(positions.map((position) => [position.nodeKey, position]));
      // A change applies only to the answer it was made on, not to one for another direction or a later load.
      const sameLoad = (state: Loaded | null): state is Loaded => state !== null && state.direction === direction && state.attempt === attempt;
      setLoaded((state) => (sameLoad(state) ? { ...state, positions: withMoves(state.positions, moves), problem: null } : state));
      try {
        await saveMapMoves(direction, moves);
        return true;
      } catch {
        setLoaded((state) => (sameLoad(state) ? { ...state, positions: withoutMoves(state.positions, moves, before), problem: MOVE_PROBLEM } : state));
        return false;
      }
    },
    [ready, positions, direction, attempt],
  );

  const reset = useCallback(async (): Promise<boolean> => {
    if (!ready) return false;
    const sameLoad = (state: Loaded | null): state is Loaded => state !== null && state.direction === direction && state.attempt === attempt;
    setLoaded((state) => (sameLoad(state) ? { ...state, problem: null } : state));
    try {
      await resetMapLayout(direction);
      setLoaded((state) => (sameLoad(state) ? { ...state, positions: NO_POSITIONS } : state));
      return true;
    } catch {
      setLoaded((state) => (sameLoad(state) ? { ...state, problem: TIDY_PROBLEM } : state));
      return false;
    }
  }, [ready, direction, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { status: shown?.status ?? "loading", positions, problem: shown?.problem ?? null, move, reset, retry };
}

/** Boxes on the move, before the layout has them: dragged, or moved with the arrow keys. */
export interface BoxMoves {
  /** Where each box on the move is now: the map draws it there. */
  moving: ReadonlyMap<string, Spot>;
  /** A drag has taken a box here. */
  drag(id: string, to: Spot): void;
  /** A drag ended: saves each dragged box that moved at least a pixel from where it was (`before`). */
  drop(before: ReadonlyMap<string, Spot>, dragged: { id: string; position: Spot }[]): void;
  /** An arrow key moved a box by (dx, dy) from `from`, or from where the keys have it already. Saved once, 600 ms after the last key. */
  nudge(id: string, from: Spot, dx: number, dy: number): void;
  /** Saves a key move that is still waiting, now. */
  flush(): void;
  /** Drops a key move that is still waiting: the box goes back to its saved spot. */
  cancel(): void;
}

const STILL: ReadonlyMap<string, Spot> = new Map();

function without(moving: ReadonlyMap<string, Spot>, ids: string[]): ReadonlyMap<string, Spot> {
  if (!ids.some((id) => moving.has(id))) return moving;
  const next = new Map(moving);
  for (const id of ids) next.delete(id);
  return next.size === 0 ? STILL : next;
}

/**
 * The boxes a drag or the arrow keys are moving, and their saves through
 * `move` (MapLayoutState.move): a drag saves when it ends, arrow keys once
 * they have stopped for 600 ms. A key move still waiting when the map goes
 * away is saved then.
 */
export function useBoxMoves(move: (moves: LayoutPosition[]) => Promise<boolean>): BoxMoves {
  const [moving, setMoving] = useState(STILL);
  // The key move waiting for its save: the box, where the keys started it, and where they have it.
  const waiting = useRef<{ id: string; from: Spot; at: Spot } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  // The newest move, for a save that runs after the wait.
  const save = useRef(move);
  useLayoutEffect(() => {
    save.current = move;
  });

  /** Ends the waiting key move: saves it (keep) or drops it. */
  const settle = useCallback((keep: boolean) => {
    window.clearTimeout(timer.current);
    const keys = waiting.current;
    waiting.current = null;
    if (keys === null) return;
    setMoving((now) => without(now, [keys.id]));
    const moves = keep ? movedNodes(new Map([[keys.id, keys.from]]), [{ id: keys.id, position: keys.at }]) : [];
    if (moves.length > 0) void save.current(moves);
  }, []);

  useEffect(() => () => settle(true), [settle]);

  const drag = useCallback((id: string, to: Spot) => setMoving((now) => new Map(now).set(id, to)), []);

  const drop = useCallback((before: ReadonlyMap<string, Spot>, dragged: { id: string; position: Spot }[]) => {
    // The keys were moving this box too: where the drag left it is what to save.
    const keys = waiting.current;
    if (keys !== null && dragged.some((box) => box.id === keys.id)) {
      window.clearTimeout(timer.current);
      waiting.current = null;
    }
    setMoving((now) => without(now, dragged.map((box) => box.id)));
    const moves = movedNodes(before, dragged);
    if (moves.length > 0) void save.current(moves);
  }, []);

  const nudge = useCallback(
    (id: string, from: Spot, dx: number, dy: number) => {
      // Keys on another box: the first box's move is saved now.
      if (waiting.current !== null && waiting.current.id !== id) settle(true);
      const keys = waiting.current ?? { id, from, at: from };
      const at = { x: keys.at.x + dx, y: keys.at.y + dy };
      waiting.current = { id, from: keys.from, at };
      setMoving((now) => new Map(now).set(id, at));
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => settle(true), KEY_MOVE_SAVE_MS);
    },
    [settle],
  );

  const flush = useCallback(() => settle(true), [settle]);
  const cancel = useCallback(() => settle(false), [settle]);

  return useMemo(() => ({ moving, drag, drop, nudge, flush, cancel }), [moving, drag, drop, nudge, flush, cancel]);
}
