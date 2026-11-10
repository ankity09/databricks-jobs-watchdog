import { z } from "zod";
import { MAX_MOVES_PER_SAVE, type LayoutPosition, type MapDirection, type MapLayout } from "../../../shared/maplayout/types";
import { apiFetch } from "./api";

const LayoutSchema = z.object({
  direction: z.enum(["LR", "TB"]),
  positions: z.array(z.object({ nodeKey: z.string(), x: z.number(), y: z.number() })),
});

const NoBody = z.null();
const post = (path: string, body: unknown): Promise<null> =>
  apiFetch(path, NoBody, { method: "POST", body: JSON.stringify(body) });

export function getMapLayout(direction: MapDirection): Promise<MapLayout> {
  return apiFetch(`/api/map-layout?direction=${direction}`, LayoutSchema);
}

/** Saves moves in batches of at most MAX_MOVES_PER_SAVE, in order. */
export async function saveMapMoves(direction: MapDirection, moves: LayoutPosition[]): Promise<void> {
  for (let i = 0; i < moves.length; i += MAX_MOVES_PER_SAVE) {
    await post("/api/map-layout/moves", { direction, moves: moves.slice(i, i + MAX_MOVES_PER_SAVE) });
  }
}

export async function resetMapLayout(direction: MapDirection): Promise<void> {
  await post("/api/map-layout/reset", { direction });
}
