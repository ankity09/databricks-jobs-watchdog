import type { LakebasePool } from "@databricks/appkit";
import { createLakebasePool } from "@databricks/appkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSchema } from "../db/schema";
import { createPgMapLayoutRepo } from "./repo";

// Runs only against a Lakebase branch: WATCHDOG_PG_TEST=1 npx vitest run server/maplayout/pg-repo.integration.test.ts
// The table is the app's real one, so the test clears it before and after. Run it on a dev branch only.
const enabled = process.env.WATCHDOG_PG_TEST === "1";

describe.skipIf(!enabled)("pg map layout repo (Lakebase)", () => {
  let pool: LakebasePool;
  const clean = () => pool.query("DELETE FROM watchdog_app.map_layout");

  beforeAll(async () => {
    pool = createLakebasePool();
    await ensureSchema(pool);
    await clean();
  }, 60_000);

  afterAll(async () => {
    await clean();
    await pool.end();
  }, 60_000);

  it("the newest move wins", async () => {
    await clean();
    const repo = createPgMapLayoutRepo(pool);
    await repo.appendMoves("LR", [{ nodeKey: "job:a", x: 10, y: 10 }], "me");
    await repo.appendMoves("LR", [{ nodeKey: "job:a", x: 30, y: 40 }], "me");
    expect(await repo.read("LR")).toEqual([{ nodeKey: "job:a", x: 30, y: 40 }]);
  });

  it("a reset hides older moves", async () => {
    await clean();
    const repo = createPgMapLayoutRepo(pool);
    await repo.appendMoves("LR", [{ nodeKey: "job:a", x: 1, y: 2 }, { nodeKey: "job:b", x: 3, y: 4 }], "me");
    await repo.appendReset("LR", "me");
    expect(await repo.read("LR")).toEqual([]);
    await repo.appendMoves("LR", [{ nodeKey: "job:b", x: 5, y: 6 }], "me");
    expect(await repo.read("LR")).toEqual([{ nodeKey: "job:b", x: 5, y: 6 }]);
  });

  it("directions are separate", async () => {
    await clean();
    const repo = createPgMapLayoutRepo(pool);
    await repo.appendMoves("TB", [{ nodeKey: "job:a", x: 1, y: 2 }], "me");
    expect(await repo.read("LR")).toEqual([]);
    await repo.appendReset("LR", "me");
    expect(await repo.read("TB")).toEqual([{ nodeKey: "job:a", x: 1, y: 2 }]);
  });

  it("two saves at once get different numbers", async () => {
    await clean();
    const repo = createPgMapLayoutRepo(pool);
    await Promise.all([
      repo.appendMoves("LR", [{ nodeKey: "job:a", x: 1, y: 1 }], "a"),
      repo.appendMoves("LR", [{ nodeKey: "job:b", x: 2, y: 2 }], "b"),
    ]);
    expect((await repo.read("LR")).length).toBe(2);
  });
});
