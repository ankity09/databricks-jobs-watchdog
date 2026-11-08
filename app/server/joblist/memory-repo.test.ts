import { describe, expect, it } from "vitest";
import { describeFilters, SCOPE, SEEDS } from "./filters.contract";
import { MemoryVersionRepo } from "./memory-repo";

function seeded() {
  return Promise.resolve(build());
}

function build() {
  const repo = new MemoryVersionRepo();
  repo.rows.push(...SEEDS.map((seed) => ({ ...seed, document: { jobs: [] } })));
  return { repo, scope: SCOPE };
}

describeFilters(seeded);

describe("memory repo facets", () => {
  it("counts exactly", async () => {
    const { repo } = await seeded();
    const facets = await repo.facets();
    expect(facets.kinds).toEqual([
      { kind: "import", count: 1 }, { kind: "create", count: 4 }, { kind: "update", count: 5 },
      { kind: "delete", count: 1 }, { kind: "restore", count: 1 },
    ]);
    expect(facets.firstSavedAt).toBe("2001-03-01T10:00:00.000Z");
    expect(facets.lastSavedAt).toBe("2001-03-10T09:00:00.000Z");
  });

  it("is empty for an empty repo", async () => {
    const facets = await new MemoryVersionRepo().facets();
    expect(facets).toEqual({ people: [], jobs: [], kinds: [], firstSavedAt: null, lastSavedAt: null });
  });
});
