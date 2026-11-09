import type { LakebasePool } from "@databricks/appkit";
import express from "express";
import { z } from "zod";
import { diffDocuments, importSummary } from "../../shared/joblist/diff";
import { impactOf } from "../../shared/joblist/impact";
import {
  CHANGE_KINDS, EMPTY_DOCUMENT,
  type Change, type ChangeKind, type ImportPreview, type JobListState, type SaveResult, type VersionDetail, type VersionList,
  type VersionSummary,
} from "../../shared/joblist/types";
import { isPermissionDenied, NO_ACCESS_MESSAGE } from "../db/schema";
import { principal } from "../identity";
import { createPgVersionRepo } from "./pg-repo";
import { ConflictError, createJobListStore, InvalidError, NotFoundError, type JobListStore, type VersionFilter, type VersionRow } from "./store";
import { readJobListYaml, toJobListYaml, YamlError } from "./yaml";

const Target = z.discriminatedUnion("type", [
  z.object({ type: z.literal("job"), name: z.string().min(1) }),
  z.object({ type: z.literal("dependency"), key: z.string().min(1) }),
  z.object({ type: z.literal("workspace"), key: z.string().min(1) }),
  z.object({ type: z.literal("defaults") }),
]);

/** The shape of a change. The rules check the entry's contents when the change is saved. */
const ChangeBody = z.union([
  z.object({ kind: z.literal("upsert"), target: Target, value: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("delete"), target: Target }),
]);

const Version = z.number().int().min(1);
const Base = z.number().int().min(0).nullable();

const ChangeRequest = z.object({ baseVersion: Base, change: ChangeBody });
const PreviewRequest = z.object({ yaml: z.string() });
const ImportRequest = z.object({ yaml: z.string(), baseVersion: Base });
const RestoreRequest = z.object({ version: Version, baseVersion: Base });
/** An optional text parameter: a missing or empty one is not set. */
const Optional = (schema: z.ZodString) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const HAS_ZONE = /(Z|[+-]\d{2}:\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A date (`2026-03-02`, the whole day in UTC) or a date-time (UTC unless it names an offset), as an instant. */
function instantOf(text: string): { at: Date; wholeDay: boolean } | null {
  const wholeDay = DATE.test(text);
  if (!wholeDay && !DATE_TIME.test(text)) return null;
  // V8 reads 2026-02-30 as March 2: the day has to be a real one.
  const [y, m, d] = text.slice(0, 10).split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) return null;
  const at = new Date(wholeDay || HAS_ZONE.test(text) ? text : `${text}Z`);
  return Number.isNaN(at.getTime()) ? null : { at, wholeDay };
}

const DateParam = (name: string) =>
  Optional(z.string()).transform((text, ctx) => {
    if (text === undefined) return undefined;
    const instant = instantOf(text);
    if (!instant) {
      ctx.addIssue({ code: "custom", message: `${name} must be a date like 2026-03-02 or a date-time like 2026-03-02T09:30:00Z.` });
      return z.NEVER;
    }
    return instant;
  });

/** `before` pages back: the versions older than it. All the filters combine with AND; `before` and `limit` page inside them. */
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().min(1).optional(),
  person: Optional(z.string()),
  kind: Optional(z.string()),
  job: Optional(z.string()),
  from: DateParam("from"),
  to: DateParam("to"),
  q: Optional(z.string().max(200, "q must be at most 200 characters.")),
}).transform((query, ctx) => {
  const kinds: ChangeKind[] = [];
  for (const part of query.kind === undefined ? [] : query.kind.split(",")) {
    const kind = CHANGE_KINDS.find((k) => k === part);
    if (!kind) {
      ctx.addIssue({ code: "custom", path: ["kind"], message: `kind has "${part}", which is not one of ${CHANGE_KINDS.join(", ")}.` });
      return z.NEVER;
    }
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  // A plain date `to` runs to the end of that day; a date-time `to` is inclusive.
  const until = query.to === undefined ? undefined : new Date(query.to.at.getTime() + (query.to.wholeDay ? DAY_MS : 1));
  if (query.from !== undefined && until !== undefined && query.from.at.getTime() >= until.getTime()) {
    ctx.addIssue({ code: "custom", path: ["from"], message: "from must not be after to." });
    return z.NEVER;
  }
  const filter: VersionFilter = {
    person: query.person, kinds: kinds.length > 0 ? kinds : undefined, job: query.job, from: query.from?.at, until, q: query.q,
  };
  return { limit: query.limit, before: query.before, filter };
});

function param(req: express.Request, name: string): string {
  const value: unknown = req.params[name];
  return typeof value === "string" ? value : "";
}

function summaryOf(row: VersionRow): VersionSummary {
  return {
    version: row.version, savedAt: row.savedAt.toISOString(), savedBy: row.savedBy,
    changeKind: row.changeKind, changeTarget: row.changeTarget, summary: row.summary,
  };
}

function saveResult(row: VersionRow): SaveResult {
  return { version: row.version, summary: row.summary, document: row.document };
}

/** A change body was checked by zod for shape; the job-list rules check its contents on save. */
function asChange(body: z.infer<typeof ChangeBody>): Change {
  return body as Change;
}

/** 503 while the app cannot use its schema: no access yet (42501), or a database that did not answer. */
function sendUnavailable(res: express.Response, error: unknown): void {
  if (isPermissionDenied(error)) {
    res.status(503).json({ error: "no_access", message: NO_ACCESS_MESSAGE });
    return;
  }
  console.error("[job-list] The job list's database is not ready:", error instanceof Error ? error.message : error);
  res.status(503).json({ error: "not_ready", message: "The job list's database did not answer. Try again in a moment." });
}

export interface JobListRouterOptions {
  /** Resolves once the app's schema is in place; the routes wait for it, and answer 503 while it fails. */
  ready?: () => Promise<void>;
}

/**
 * A body that is not JSON, or one over the limit, as JSON answers. In the
 * deployed app AppKit's server parses JSON for every route first, with a 1 MB
 * limit, so its errors never reach the router: mountJobList also adds this at
 * the app level for /api/job-list.
 */
export function jobListBodyErrors(error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction): void {
  const type = typeof error === "object" && error !== null && "type" in error ? error.type : undefined;
  if (type === "entity.too.large") {
    res.status(413).json({ error: "too_large", message: "The request is larger than 1 MB." });
  } else if (type === "entity.parse.failed") {
    res.status(400).json({ error: "bad_request", message: "The request body is not valid JSON." });
  } else {
    next(error);
  }
}

export function createJobListRouter(store: JobListStore, options: JobListRouterOptions = {}): express.Router {
  const router = express.Router();
  // AppKit's server already parsed the body (1 MB); this parser serves a router mounted on its own, as in the tests.
  router.use(express.json({ limit: "1mb" }));
  router.use(jobListBodyErrors);

  const { ready } = options;
  if (ready) {
    router.use((_req, res, next) => {
      ready().then(() => next(), (error: unknown) => sendUnavailable(res, error));
    });
  }

  const handle = (fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler =>
    (req, res) => {
      fn(req, res).catch((error: unknown) => {
        if (error instanceof ConflictError) {
          res.status(409).json({ error: "conflict", message: error.message, latestVersion: error.latestVersion });
        } else if (error instanceof InvalidError) {
          res.status(422).json({ error: "invalid", message: error.message, issues: error.issues });
        } else if (error instanceof YamlError) {
          res.status(400).json({ error: "yaml", message: error.message });
        } else if (error instanceof NotFoundError) {
          res.status(404).json({ error: "not_found", message: error.message });
        } else if (isPermissionDenied(error)) {
          sendUnavailable(res, error);
        } else {
          console.error("[job-list]", error);
          res.status(500).json({ error: "server", message: "The job list could not be read or saved. Try again." });
        }
      });
    };

  const bad = (res: express.Response, error: z.ZodError): void => {
    res.status(400).json({ error: "bad_request", message: z.prettifyError(error) });
  };

  /** A bad filter answers in a sentence, not zod's layout: each problem says which parameter it is about. */
  const plainBad = (res: express.Response, error: z.ZodError): void => {
    const message = error.issues
      .map((issue) => {
        const name = issue.path.join(".");
        return name === "" || issue.message.startsWith(name) ? issue.message : `${name}: ${issue.message}`;
      })
      .join(" ");
    res.status(400).json({ error: "bad_request", message });
  };

  router.get("/", handle(async (_req, res) => {
    const row = await store.latest();
    const state: JobListState = row
      ? { version: row.version, savedAt: row.savedAt.toISOString(), savedBy: row.savedBy, document: row.document }
      : { version: null, savedAt: null, savedBy: null, document: EMPTY_DOCUMENT };
    res.json(state);
  }));

  router.get("/versions", handle(async (req, res) => {
    const query = ListQuery.safeParse(req.query);
    if (!query.success) return plainBad(res, query.error);
    const { limit, before, filter } = query.data;
    const [rows, total] = await Promise.all([store.list(limit, before, filter), store.count(filter)]);
    const list: VersionList = { versions: rows.map(summaryOf), total };
    res.json(list);
  }));

  router.get("/versions/facets", handle(async (_req, res) => {
    res.json(await store.facets());
  }));

  router.get("/versions/:version", handle(async (req, res) => {
    const version = Version.safeParse(Number(param(req, "version")));
    const row = version.success ? await store.get(version.data) : null;
    if (!row) throw new NotFoundError(`Version ${param(req, "version")} does not exist.`);
    const detail: VersionDetail = { ...summaryOf(row), document: row.document };
    res.json(detail);
  }));

  router.post("/changes", handle(async (req, res) => {
    const body = ChangeRequest.safeParse(req.body);
    if (!body.success) return bad(res, body.error);
    const row = await store.saveChange({
      baseVersion: body.data.baseVersion, change: asChange(body.data.change), savedBy: principal(req).email,
    });
    res.status(201).json(saveResult(row));
  }));

  router.post("/import/preview", handle(async (req, res) => {
    const body = PreviewRequest.safeParse(req.body);
    if (!body.success) return bad(res, body.error);
    const { document, issues } = readJobListYaml(body.data.yaml);
    const latest = await store.latest();
    const preview: ImportPreview = {
      document, issues, diff: diffDocuments(latest?.document ?? EMPTY_DOCUMENT, document),
      summary: importSummary(document),
    };
    res.json(preview);
  }));

  router.post("/import", handle(async (req, res) => {
    const body = ImportRequest.safeParse(req.body);
    if (!body.success) return bad(res, body.error);
    const { document, issues } = readJobListYaml(body.data.yaml);
    if (issues.length > 0) throw new InvalidError(issues);
    const row = await store.importDocument({ baseVersion: body.data.baseVersion, document, savedBy: principal(req).email });
    res.status(201).json(saveResult(row));
  }));

  router.post("/restore", handle(async (req, res) => {
    const body = RestoreRequest.safeParse(req.body);
    if (!body.success) return bad(res, body.error);
    const row = await store.restore({ ...body.data, savedBy: principal(req).email });
    res.status(201).json(saveResult(row));
  }));

  router.get("/export", handle(async (_req, res) => {
    const row = await store.latest();
    if (!row) throw new NotFoundError("Nothing is saved yet. Import or add a job first.");
    res.type("text/yaml").set("Content-Disposition", `attachment; filename="monitored_jobs.v${row.version}.yml"`);
    res.send(toJobListYaml(row.document, { version: row.version, savedAt: row.savedAt.toISOString(), savedBy: row.savedBy }));
  }));

  router.get("/impact/:jobName", handle(async (req, res) => {
    const row = await store.latest();
    const name = param(req, "jobName");
    if (!row?.document.jobs.some((j) => j.job_name === name)) throw new NotFoundError(`There is no job ${name}.`);
    res.json(impactOf(row.document, name));
  }));

  return router;
}

/** Mounts the job list router under /api/job-list, with the body errors of an app-level JSON parser. */
export function mountJobList(app: express.Application, router: express.Router): void {
  app.use("/api/job-list", router);
  app.use("/api/job-list", jobListBodyErrors);
}

/** The job list routes under /api/job-list (see the route contract). With ready, each request waits for the schema. */
export function registerJobListRoutes(app: express.Application, ctx: { pool: LakebasePool; ready?: () => Promise<void> }): void {
  mountJobList(app, createJobListRouter(createJobListStore(createPgVersionRepo(ctx.pool)), { ready: ctx.ready }));
}
