import type { LakebasePool } from "@databricks/appkit";
import express from "express";
import { z } from "zod";
import { diffDocuments, importSummary } from "../../shared/joblist/diff";
import { impactOf } from "../../shared/joblist/impact";
import {
  EMPTY_DOCUMENT,
  type Change, type ImportPreview, type JobListState, type SaveResult, type VersionDetail, type VersionSummary,
} from "../../shared/joblist/types";
import { principal } from "../identity";
import { createPgVersionRepo } from "./pg-repo";
import { ConflictError, createJobListStore, InvalidError, NotFoundError, type JobListStore, type VersionRow } from "./store";
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
/** `before` pages back: the versions older than it. The answer has the same shape with or without it. */
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().min(1).optional(),
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

export function createJobListRouter(store: JobListStore): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "2mb" }));

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
        } else {
          console.error("[job-list]", error);
          res.status(500).json({ error: "server", message: "The job list could not be read or saved. Try again." });
        }
      });
    };

  const bad = (res: express.Response, error: z.ZodError): void => {
    res.status(400).json({ error: "bad_request", message: z.prettifyError(error) });
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
    if (!query.success) return bad(res, query.error);
    const rows = await store.list(query.data.limit, query.data.before);
    res.json({ versions: rows.map(summaryOf) });
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

/** The job list routes under /api/job-list (see the route contract). */
export function registerJobListRoutes(app: express.Application, ctx: { pool: LakebasePool }): void {
  app.use("/api/job-list", createJobListRouter(createJobListStore(createPgVersionRepo(ctx.pool))));
}
