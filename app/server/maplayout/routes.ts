import type { LakebasePool } from "@databricks/appkit";
import express from "express";
import { z } from "zod";
import { MAX_MOVES_PER_SAVE } from "../../shared/maplayout/types";
import { isPermissionDenied, NO_ACCESS_MESSAGE } from "../db/schema";
import { principal } from "../identity";
import { createPgMapLayoutRepo, type MapLayoutRepo } from "./repo";

const Direction = z.enum(["LR", "TB"]);
const Coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const Position = z.object({ nodeKey: z.string().min(1).max(300), x: Coordinate, y: Coordinate });
const MovesBody = z.object({ direction: Direction, moves: z.array(Position).min(1).max(MAX_MOVES_PER_SAVE) });
const ResetBody = z.object({ direction: Direction });
const LayoutQuery = z.object({ direction: Direction });

export interface MapLayoutRouterOptions {
  /** Resolves once the app's schema is in place; the routes wait for it, and answer 503 while it fails. */
  ready: () => Promise<void>;
}

/** 503 while the app cannot use its schema: no access yet (42501), or a database that did not answer. */
function sendUnavailable(res: express.Response, error: unknown): void {
  if (isPermissionDenied(error)) {
    res.status(503).json({ error: "no_access", message: NO_ACCESS_MESSAGE });
    return;
  }
  console.error("[map-layout] The database is not ready:", error instanceof Error ? error.message : error);
  res.status(503).json({ error: "not_ready", message: "The map's database did not answer. Try again in a moment." });
}

export function createMapLayoutRouter(repo: MapLayoutRepo, options: MapLayoutRouterOptions): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "256kb" }));
  router.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const type = typeof error === "object" && error !== null && "type" in error ? error.type : undefined;
    if (type === "entity.too.large") {
      res.status(413).json({ error: "too_large", message: "The request is larger than 256 KB." });
    } else if (type === "entity.parse.failed") {
      res.status(400).json({ error: "invalid", message: "The request body is not valid JSON." });
    } else {
      next(error);
    }
  });
  router.use((_req, res, next) => {
    options.ready().then(() => next(), (error: unknown) => sendUnavailable(res, error));
  });

  const handle = (fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler =>
    (req, res) => {
      fn(req, res).catch((error: unknown) => {
        if (isPermissionDenied(error)) {
          sendUnavailable(res, error);
          return;
        }
        console.error("[map-layout]", error);
        res.status(500).json({ error: "server", message: "The map layout could not be read or saved. Try again." });
      });
    };

  const invalid = (res: express.Response, error: z.ZodError): void => {
    res.status(400).json({ error: "invalid", message: z.prettifyError(error) });
  };

  router.get("/", handle(async (req, res) => {
    const query = LayoutQuery.safeParse(req.query);
    if (!query.success) return invalid(res, query.error);
    const positions = await repo.read(query.data.direction);
    res.json({ direction: query.data.direction, positions });
  }));

  router.post("/moves", handle(async (req, res) => {
    const parsed = MovesBody.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error);
    await repo.appendMoves(parsed.data.direction, parsed.data.moves, principal(req).email);
    res.status(204).end();
  }));

  router.post("/reset", handle(async (req, res) => {
    const parsed = ResetBody.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error);
    await repo.appendReset(parsed.data.direction, principal(req).email);
    res.status(204).end();
  }));

  return router;
}

/** The map layout routes under /api/map-layout. */
export function registerMapLayoutRoutes(app: express.Application, ctx: { pool: LakebasePool; ready: () => Promise<void> }): void {
  app.use("/api/map-layout", createMapLayoutRouter(createPgMapLayoutRepo(ctx.pool), { ready: ctx.ready }));
}
