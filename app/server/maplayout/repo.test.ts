import { describe, expect, it } from "vitest";
import { MemoryMapLayoutRepo } from "./repo";

describe("memory map layout repo", () => {
  it("the newest move wins", async () => {
    const repo = new MemoryMapLayoutRepo();
    await repo.appendMoves("LR", [{ nodeKey: "job:a", x: 10, y: 10 }], "me");
    await repo.appendMoves("LR", [{ nodeKey: "job:a", x: 30, y: 40 }], "me");
    expect(await repo.read("LR")).toEqual([{ nodeKey: "job:a", x: 30, y: 40 }]);
  });

  it("a reset hides older moves", async () => {
    const repo = new MemoryMapLayoutRepo();
    await repo.appendMoves("LR", [{ nodeKey: "job:a", x: 1, y: 2 }, { nodeKey: "job:b", x: 3, y: 4 }], "me");
    await repo.appendReset("LR", "me");
    expect(await repo.read("LR")).toEqual([]);
    await repo.appendMoves("LR", [{ nodeKey: "job:b", x: 5, y: 6 }], "me");
    expect(await repo.read("LR")).toEqual([{ nodeKey: "job:b", x: 5, y: 6 }]);
  });

  it("directions are separate", async () => {
    const repo = new MemoryMapLayoutRepo();
    await repo.appendMoves("TB", [{ nodeKey: "job:a", x: 1, y: 2 }], "me");
    expect(await repo.read("LR")).toEqual([]);
    await repo.appendMoves("LR", [{ nodeKey: "job:b", x: 3, y: 4 }], "me");
    await repo.appendReset("LR", "me");
    expect(await repo.read("TB")).toEqual([{ nodeKey: "job:a", x: 1, y: 2 }]);
  });
});
