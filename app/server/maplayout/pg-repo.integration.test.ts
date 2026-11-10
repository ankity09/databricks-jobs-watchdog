import { randomUUID } from "node:crypto";
import type { LakebasePool } from "@databricks/appkit";
import { createLakebasePool } from "@databricks/appkit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LayoutPosition } from "../../shared/maplayout/types";
import { ensureSchema } from "../db/schema";
import { createPgMapLayoutRepo } from "./repo";

// Runs only against a dev Lakebase branch: WATCHDOG_PG_TEST=1 and LAKEBASE_ENDPOINT naming a /branches/dev-* branch.
//   WATCHDOG_PG_TEST=1 npx vitest run server/maplayout/pg-repo.integration.test.ts
// A reset row hides every saved position in its direction, so this must never run on a branch with real layouts.
// The test writes only rows marked with a test-only updated_by, and removes only those.
const onDevBranch = (process.env.LAKEBASE_ENDPOINT ?? "").includes("/branches/dev-");
const enabled = process.env.WATCHDOG_PG_TEST === "1" && onDevBranch;
if (process.env.WATCHDOG_PG_TEST === "1" && !onDevBranch) {
  console.warn("[map-layout] Skipping the Postgres test: LAKEBASE_ENDPOINT is not a /branches/dev-* branch.");
}

const BY = `it-${randomUUID().slice(0, 8)}`;
const key = (name: string): string => `${BY}:${name}`;
const mine = (positions: LayoutPosition[]): LayoutPosition[] => positions.filter((p) => p.nodeKey.startsWith(`${BY}:`));

describe.skipIf(!enabled)("pg map layout repo (Lakebase)", () => {
  let pool: LakebasePool;
  const clean = () => pool.query("DELETE FROM watchdog_app.map_layout WHERE updated_by = $1", [BY]);

  beforeAll(async () => {
    pool = createLakebasePool();
    await ensureSchema(pool);
    await clean();
  }, 60_000);

  beforeEach(async () => {
    await clean();
  });

  afterAll(async () => {
    await clean();
    await pool.end();
  }, 60_000);

  it("the newest move wins", async () => {
    const repo = createPgMapLayoutRepo(pool);
    await repo.appendMoves("LR", [{ nodeKey: key("job:a"), x: 10, y: 10 }], BY);
    await repo.appendMoves("LR", [{ nodeKey: key("job:a"), x: 30, y: 40 }], BY);
    expect(mine(await repo.read("LR"))).toEqual([{ nodeKey: key("job:a"), x: 30, y: 40 }]);
  });

  it("a reset hides older moves", async () => {
    const repo = createPgMapLayoutRepo(pool);
    await repo.appendMoves("LR", [{ nodeKey: key("job:a"), x: 1, y: 2 }, { nodeKey: key("job:b"), x: 3, y: 4 }], BY);
    await repo.appendReset("LR", BY);
    expect(mine(await repo.read("LR"))).toEqual([]);
    await repo.appendMoves("LR", [{ nodeKey: key("job:b"), x: 5, y: 6 }], BY);
    expect(mine(await repo.read("LR"))).toEqual([{ nodeKey: key("job:b"), x: 5, y: 6 }]);
  });

  it("directions are separate", async () => {
    const repo = createPgMapLayoutRepo(pool);
    await repo.appendMoves("TB", [{ nodeKey: key("job:a"), x: 1, y: 2 }], BY);
    expect(mine(await repo.read("LR"))).toEqual([]);
    await repo.appendReset("LR", BY);
    expect(mine(await repo.read("TB"))).toEqual([{ nodeKey: key("job:a"), x: 1, y: 2 }]);
  });

  it("two saves at once get different numbers", async () => {
    const repo = createPgMapLayoutRepo(pool);
    await Promise.all([
      repo.appendMoves("LR", [{ nodeKey: key("job:a"), x: 1, y: 1 }], BY),
      repo.appendMoves("LR", [{ nodeKey: key("job:b"), x: 2, y: 2 }], BY),
    ]);
    expect(mine(await repo.read("LR")).length).toBe(2);
  });
});
