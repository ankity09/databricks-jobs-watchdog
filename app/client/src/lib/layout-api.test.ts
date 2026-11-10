import { afterEach, describe, expect, it, vi } from "vitest";
import { getMapLayout, resetMapLayout, saveMapMoves } from "./layout-api";

function answer(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body === null ? null : JSON.stringify(body), { status })));
}

afterEach(() => vi.unstubAllGlobals());

describe("layout api", () => {
  it("reads a layout", async () => {
    answer(200, { direction: "LR", positions: [{ nodeKey: "job:a", x: 1, y: 2 }] });
    expect(await getMapLayout("LR")).toEqual({ direction: "LR", positions: [{ nodeKey: "job:a", x: 1, y: 2 }] });
  });

  it("rejects a malformed body", async () => {
    answer(200, { direction: "LR", positions: [{ nodeKey: "job:a", x: "1" }] });
    await expect(getMapLayout("LR")).rejects.toMatchObject({ error: "invalid_response" });
  });

  it("saves moves and resets with a 204", async () => {
    answer(204, null);
    await saveMapMoves("TB", [{ nodeKey: "job:a", x: 1, y: 2 }]);
    await resetMapLayout("TB");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("sends more than 500 moves in batches", async () => {
    answer(204, null);
    await saveMapMoves("LR", Array.from({ length: 501 }, (_, i) => ({ nodeKey: `job:${i}`, x: i, y: i })));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
