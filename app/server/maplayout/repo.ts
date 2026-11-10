import type { LakebasePool } from "@databricks/appkit";
import { z } from "zod";
import type { LayoutPosition, MapDirection } from "../../shared/maplayout/types";
import { withRetry } from "../db/retry";

/**
 * Box positions are an append-only log: a move adds a row, a reset adds a row that hides older moves.
 * The newest move for a box wins.
 */
export interface MapLayoutRepo {
  read(direction: MapDirection): Promise<LayoutPosition[]>;
  appendMoves(direction: MapDirection, moves: LayoutPosition[], by: string): Promise<void>;
  appendReset(direction: MapDirection, by: string): Promise<void>;
}

interface Entry {
  seq: number;
  direction: MapDirection;
  move: LayoutPosition | null;
  by: string;
}

/** For tests: the same rules as the Postgres repo, kept in memory. `log` shows who made each append. */
export class MemoryMapLayoutRepo implements MapLayoutRepo {
  private entries: Entry[] = [];

  get log(): readonly Readonly<Entry>[] {
    return this.entries;
  }

  private append(direction: MapDirection, rows: (LayoutPosition | null)[], by: string): void {
    for (const move of rows) {
      this.entries.push({ seq: this.entries.length + 1, direction, move: move ? { ...move } : null, by });
    }
  }

  read(direction: MapDirection): Promise<LayoutPosition[]> {
    const mine = this.entries.filter((e) => e.direction === direction);
    const lastReset = mine.reduce((max, e) => (e.move === null ? Math.max(max, e.seq) : max), 0);
    const newest = new Map<string, LayoutPosition>();
    for (const e of mine) {
      if (e.move !== null && e.seq > lastReset) newest.set(e.move.nodeKey, { ...e.move });
    }
    return Promise.resolve([...newest.values()]);
  }

  appendMoves(direction: MapDirection, moves: LayoutPosition[], by: string): Promise<void> {
    this.append(direction, moves, by);
    return Promise.resolve();
  }

  appendReset(direction: MapDirection, by: string): Promise<void> {
    this.append(direction, [null], by);
    return Promise.resolve();
  }
}

/** One lock for every append: a transaction holds it until it commits, so numbering never collides. */
const LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('watchdog_app.map_layout'))";

const PositionRow = z.object({ node_key: z.string(), x: z.number(), y: z.number() });

const READ_SQL = `SELECT DISTINCT ON (node_key) node_key, x, y FROM watchdog_app.map_layout
WHERE direction = $1 AND kind = 'move'
  AND seq > COALESCE((SELECT max(seq) FROM watchdog_app.map_layout WHERE direction = $1 AND kind = 'reset'), 0)
ORDER BY node_key, seq DESC`;

/** The Postgres repo. There is no sequence (the grant helper gives SELECT and INSERT only): numbers come from max(seq) under the lock. */
export function createPgMapLayoutRepo(pool: LakebasePool): MapLayoutRepo {
  /** Inserts rows with the next numbers in one transaction. A null move is a reset. */
  async function append(direction: MapDirection, rows: (LayoutPosition | null)[], by: string): Promise<void> {
    const client = await withRetry(() => pool.connect());
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      await client.query(LOCK_SQL);
      const top = await client.query("SELECT COALESCE(max(seq), 0) AS top FROM watchdog_app.map_layout");
      let seq = Number(z.object({ top: z.union([z.string(), z.number()]) }).parse(top.rows[0]).top);
      for (const move of rows) {
        seq += 1;
        await client.query(
          `INSERT INTO watchdog_app.map_layout (seq, direction, kind, node_key, x, y, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [seq, direction, move ? "move" : "reset", move?.nodeKey ?? null, move?.x ?? null, move?.y ?? null, by],
        );
      }
      try {
        await client.query("COMMIT");
      } catch (error) {
        broken = error instanceof Error ? error : new Error("COMMIT failed");
        throw error;
      }
    } catch (error) {
      if (!broken) {
        await client.query("ROLLBACK").catch((rollbackError: unknown) => {
          broken = rollbackError instanceof Error ? rollbackError : new Error("ROLLBACK failed");
        });
      }
      throw error;
    } finally {
      if (broken) client.release(broken);
      else client.release();
    }
  }

  return {
    read: async (direction) => {
      const result = await withRetry(() => pool.query(READ_SQL, [direction]));
      return result.rows.map((raw) => {
        const row = PositionRow.parse(raw);
        return { nodeKey: row.node_key, x: row.x, y: row.y };
      });
    },
    appendMoves: (direction, moves, by) => append(direction, moves, by),
    appendReset: (direction, by) => append(direction, [null], by),
  };
}
