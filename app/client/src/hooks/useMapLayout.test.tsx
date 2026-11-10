// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LayoutPosition, MapDirection } from "../../../shared/maplayout/types";
import { useMapLayout } from "./useMapLayout";

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** fetch for the layout routes: each direction's saved positions, and a save of moves answered by `saveMoves`. */
function mockLayout(saved: Record<MapDirection, LayoutPosition[]>, saveMoves: () => Promise<Response> = () => Promise.resolve(new Response(null, { status: 204 }))) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const read = /^\/api\/map-layout\?direction=(LR|TB)$/.exec(url);
    if (read && (init?.method ?? "GET") === "GET") {
      const direction = read[1] === "TB" ? "TB" : "LR";
      return Promise.resolve(json(200, { direction, positions: saved[direction] }));
    }
    if (url === "/api/map-layout/moves" && init?.method === "POST") return saveMoves();
    return Promise.resolve(json(404, { error: "not_found", message: `No route for ${url}` }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("useMapLayout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a failed move reverts and sets the problem", async () => {
    let answer: (response: Response) => void = () => undefined;
    mockLayout({ LR: [{ nodeKey: "job:orders_ingest", x: 10, y: 20 }], TB: [] }, () => new Promise<Response>((resolve) => (answer = resolve)));
    const { result } = renderHook(() => useMapLayout("LR"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let saved: Promise<boolean> = Promise.resolve(true);
    act(() => {
      saved = result.current.move([{ nodeKey: "job:orders_ingest", x: 50, y: 60 }]);
    });
    // The box is at its new spot while the save is on its way.
    expect(result.current.positions).toEqual([{ nodeKey: "job:orders_ingest", x: 50, y: 60 }]);
    expect(result.current.problem).toBeNull();

    await act(async () => {
      answer(json(503, { error: "not_ready", message: "The map's database did not answer. Try again in a moment." }));
      expect(await saved).toBe(false);
    });
    expect(result.current.positions).toEqual([{ nodeKey: "job:orders_ingest", x: 10, y: 20 }]);
    expect(result.current.problem).toBe("That move couldn't be saved, so the box went back.");
  });

  it("a direction change loads that direction", async () => {
    const fetchMock = mockLayout({ LR: [{ nodeKey: "job:orders_ingest", x: 10, y: 20 }], TB: [{ nodeKey: "job:orders_ingest", x: 300, y: 400 }] });
    const { result, rerender } = renderHook(({ direction }: { direction: MapDirection }) => useMapLayout(direction), { initialProps: { direction: "LR" } });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.positions).toEqual([{ nodeKey: "job:orders_ingest", x: 10, y: 20 }]);

    rerender({ direction: "TB" });
    // Until that direction's positions are in, none of the other direction's show.
    expect(result.current.status).toBe("loading");
    expect(result.current.positions).toEqual([]);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.positions).toEqual([{ nodeKey: "job:orders_ingest", x: 300, y: 400 }]);
    expect(fetchMock.mock.calls.map(([input]) => urlOf(input))).toEqual(["/api/map-layout?direction=LR", "/api/map-layout?direction=TB"]);
  });
});
