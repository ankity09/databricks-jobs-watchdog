import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { ChangeKind } from "../../shared/joblist/types";
import { MemoryVersionRepo } from "./memory-repo";
import { createJobListRouter, mountJobList } from "./routes";
import { createJobListStore, type JobListStore } from "./store";

/** The fields the tests read from a response body; the routes' contract fixes their types. */
interface Body {
  error: string; message: string; latestVersion: number; version: number | null; savedBy: string; summary: string;
  issues: { path: string; message: string }[]; diff: unknown[]; document: { jobs: unknown[] }; versions: Record<string, unknown>[];
}
const body = (res: { body: unknown }): Body => res.body as Body;

function app() {
  const server = express();
  server.use("/api/job-list", createJobListRouter(createJobListStore(new MemoryVersionRepo())));
  return server;
}

const upsert = (name: string, gap = 60) => ({
  kind: "upsert", target: { type: "job", name }, value: { job_name: name, max_gap_minutes: gap },
});
const YAML = "jobs:\n  - job_name: orders_ingest\n    max_gap_minutes: 60\n  - job_name: orders_enrich\n    max_gap_minutes: 30\ndependencies:\n  - job_name: orders_enrich\n    depends_on: orders_ingest\n";

describe("job-list routes", () => {
  it("returns an empty state before anything is saved", async () => {
    const res = await request(app()).get("/api/job-list");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: null, savedAt: null, savedBy: null, document: { jobs: [] } });
  });

  it("saves a change as the forwarded email and returns 201", async () => {
    const a = app();
    const res = await request(a).post("/api/job-list/changes").set("x-forwarded-email", "me@example.com")
      .send({ baseVersion: null, change: upsert("orders_ingest") });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ version: 1, summary: "Added job orders_ingest", document: { jobs: [{ job_name: "orders_ingest", max_gap_minutes: 60 }] } });
    const state = await request(a).get("/api/job-list");
    expect(state.body).toMatchObject({ version: 1, savedBy: "me@example.com" });
    const versions = await request(a).get("/api/job-list/versions?limit=10");
    expect(body(versions).versions).toHaveLength(1);
    expect(body(versions).versions[0]).toMatchObject({ version: 1, savedBy: "me@example.com", changeKind: "create", changeTarget: "job:orders_ingest" });
    expect(body(versions).versions[0]).not.toHaveProperty("document");
  });

  it("falls back to local-dev without the header", async () => {
    const a = app();
    await request(a).post("/api/job-list/changes").send({ baseVersion: null, change: upsert("a") });
    expect(body(await request(a).get("/api/job-list")).savedBy).toBe("local-dev");
  });

  it("pages through older versions with before, in the same shape", async () => {
    const a = app();
    for (let n = 1; n <= 5; n++) {
      await request(a).post("/api/job-list/changes").send({ baseVersion: n === 1 ? null : n - 1, change: upsert("a", n * 10) });
    }
    const listed = async (query: string) => {
      const res = await request(a).get(`/api/job-list/versions${query}`);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body as object)).toEqual(["versions", "total"]);
      return body(res).versions.map((v) => v.version);
    };
    expect(await listed("?limit=2")).toEqual([5, 4]);
    expect(await listed("?limit=2&before=4")).toEqual([3, 2]);
    expect(await listed("?limit=2&before=2")).toEqual([1]);
    expect(await listed("?before=1")).toEqual([]);
    expect(await listed("?before=99")).toEqual([5, 4, 3, 2, 1]);
    expect((await request(a).get("/api/job-list/versions?before=0")).status).toBe(400);
    expect((await request(a).get("/api/job-list/versions?before=abc")).status).toBe(400);
  });

  describe("change log filters", () => {
    const filtered = async (a: express.Express, query: string) => {
      const res = await request(a).get(`/api/job-list/versions${query}`);
      return { status: res.status, versions: body(res).versions.map((v) => v.version), total: (res.body as { total: number }).total, res };
    };
    const seed = () => {
      const a = express();
      const repo = new MemoryVersionRepo();
      a.use("/api/job-list", createJobListRouter(createJobListStore(repo)));
      const rows: [string, string, ChangeKind, string | null, string][] = [
        ["2026-03-01T10:00:00Z", "a@example.com", "create", "job:orders_ingest", "Added job orders_ingest"],
        ["2026-03-02T23:59:59Z", "b@example.com", "update", "job:orders", "Changed 100% of orders"],
        ["2026-03-03T00:00:00Z", "a@example.com", "delete", "job:orders_ingest", "Deleted job orders_ingest"],
        ["2026-03-04T12:00:00Z", "b@example.com", "restore", null, "Restored version 1"],
      ];
      rows.forEach(([savedAt, savedBy, changeKind, changeTarget, summary], i) => {
        repo.rows.push({ version: i + 1, document: { jobs: [] }, savedBy, savedAt: new Date(savedAt), changeKind, changeTarget, summary });
      });
      return a;
    };

    it("answers a total with and without filters, and pages inside the filtered set", async () => {
      const a = seed();
      expect(await filtered(a, "")).toMatchObject({ status: 200, versions: [4, 3, 2, 1], total: 4 });
      expect(await filtered(a, "?person=a@example.com&limit=1")).toMatchObject({ versions: [3], total: 2 });
      expect(await filtered(a, "?person=a@example.com&limit=1&before=3")).toMatchObject({ versions: [1], total: 2 });
      expect(await filtered(a, "?kind=create,update")).toMatchObject({ versions: [2, 1], total: 2 });
      expect(await filtered(a, "?job=orders")).toMatchObject({ versions: [2], total: 1 });
      expect(await filtered(a, "?job=orders_ingest")).toMatchObject({ versions: [3, 1], total: 2 });
      expect(await filtered(a, "?q=100%25")).toMatchObject({ versions: [2], total: 1 });
      expect(await filtered(a, "?q=nothing")).toMatchObject({ versions: [], total: 0 });
    });

    it("reads a plain date as whole days in UTC, and a date-time as an instant", async () => {
      const a = seed();
      // 2026-03-02 to 2026-03-03 covers 23:59:59 on the 2nd and 00:00 on the 3rd.
      expect((await filtered(a, "?from=2026-03-02&to=2026-03-03")).versions).toEqual([3, 2]);
      expect((await filtered(a, "?from=2026-03-03&to=2026-03-03")).versions).toEqual([3]);
      expect((await filtered(a, "?from=2026-03-02&to=2026-03-02")).versions).toEqual([2]);
      expect((await filtered(a, "?from=2026-03-03T00:00:00Z")).versions).toEqual([4, 3]);
      expect((await filtered(a, "?to=2026-03-02T23:59:59Z")).versions).toEqual([2, 1]);
      expect((await filtered(a, "?to=2026-03-02T23:59:58Z")).versions).toEqual([1]);
      expect((await filtered(a, "?from=2026-03-03T01:00:00%2B01:00")).versions).toEqual([4, 3]);
      expect((await filtered(a, "?from=2026-03-02T00:00:00&to=2026-03-02T23:59:59")).versions).toEqual([2]);
    });

    it("rejects bad parameters with a plain 400", async () => {
      const a = seed();
      for (const query of [
        "?kind=create,nope", "?kind=Create", "?from=yesterday", "?from=2026-13-01", "?from=2026-02-30", "?to=2026-03-01T25:00:00Z",
        "?from=2026-03-05&to=2026-03-01", "?from=2026-03-05T10:00:00Z&to=2026-03-05T09:00:00Z", `?q=${"x".repeat(201)}`,
        "?person=a&person=b",
      ]) {
        const res = await request(a).get(`/api/job-list/versions${query}`);
        expect([query, res.status]).toEqual([query, 400]);
        expect(Object.keys(res.body as object)).toEqual(["error", "message"]);
        expect(body(res).error).toBe("bad_request");
      }
      const kind = await request(a).get("/api/job-list/versions?kind=create,nope");
      expect(body(kind).message).toBe('kind has "nope", which is not one of import, create, update, delete, restore.');
      const range = await request(a).get("/api/job-list/versions?from=2026-03-05&to=2026-03-01");
      expect(body(range).message).toMatch(/from.*after.*to/i);
      expect((await filtered(a, `?q=${"x".repeat(200)}`)).status).toBe(200);
    });

    it("rejects a year before 1000 and a NUL character, in a plain sentence", async () => {
      const a = seed();
      for (const [query, expected] of [
        ["?from=0002-11-05", "from must be a date in the year 1000 or later."],
        ["?to=0020-11-05", "to must be a date in the year 1000 or later."],
        ["?to=0202-11-05T10:00:00Z", "to must be a date in the year 1000 or later."],
        ["?q=a%00b", "q must not contain a NUL character."],
        ["?person=a%00b", "person must not contain a NUL character."],
        ["?job=a%00b", "job must not contain a NUL character."],
      ] as const) {
        const res = await request(a).get(`/api/job-list/versions${query}`);
        expect([query, res.status, body(res).message]).toEqual([query, 400, expected]);
      }
      expect((await request(a).get("/api/job-list/versions?from=1000-01-01")).status).toBe(200);
    });

    it("treats empty filters as not set", async () => {
      const a = seed();
      expect(await filtered(a, "?person=&kind=&job=&from=&to=&q=")).toMatchObject({ status: 200, total: 4 });
    });

    it("lists the facets over every version", async () => {
      const a = seed();
      const res = await request(a).get("/api/job-list/versions/facets");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        people: [{ email: "a@example.com", count: 2 }, { email: "b@example.com", count: 2 }],
        jobs: [{ name: "orders", count: 1 }, { name: "orders_ingest", count: 2 }],
        kinds: [{ kind: "create", count: 1 }, { kind: "update", count: 1 }, { kind: "delete", count: 1 }, { kind: "restore", count: 1 }],
        firstSavedAt: "2026-03-01T10:00:00.000Z",
        lastSavedAt: "2026-03-04T12:00:00.000Z",
      });
    });

    it("answers empty facets before anything is saved", async () => {
      const res = await request(app()).get("/api/job-list/versions/facets");
      expect(res.body).toEqual({ people: [], jobs: [], kinds: [], firstSavedAt: null, lastSavedAt: null });
    });
  });

  it("returns 409 with the latest version on a conflict", async () => {
    const a = app();
    await request(a).post("/api/job-list/changes").send({ baseVersion: null, change: upsert("a") });
    await request(a).post("/api/job-list/changes").send({ baseVersion: 1, change: upsert("a", 90) });
    const res = await request(a).post("/api/job-list/changes").send({ baseVersion: 1, change: upsert("a", 120) });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "conflict", message: "Someone else changed this since you opened it. Reload to see their change.", latestVersion: 2,
    });
  });

  it("returns 422 with the issues for an invalid change", async () => {
    const res = await request(app()).post("/api/job-list/changes").send({ baseVersion: null, change: upsert("a", -1) });
    expect(res.status).toBe(422);
    expect(body(res).error).toBe("invalid");
    expect(body(res).message).toBe("The job list has a problem.");
    expect(body(res).issues[0]).toMatchObject({ path: "jobs[a].max_gap_minutes" });
  });

  it("returns 400 with zod's message for a bad body", async () => {
    const res = await request(app()).post("/api/job-list/changes").send({ baseVersion: "x", change: { kind: "nope" } });
    expect(res.status).toBe(400);
    expect(body(res).error).toBe("bad_request");
    expect(body(res).message).toContain("baseVersion");
  });

  it("returns 404 for a missing version, and 400 for a bad limit", async () => {
    const a = app();
    expect((await request(a).get("/api/job-list/versions/7")).status).toBe(404);
    expect((await request(a).get("/api/job-list/versions/abc")).status).toBe(404);
    expect((await request(a).get("/api/job-list/versions?limit=0")).status).toBe(400);
  });

  it("returns a version's detail", async () => {
    const a = app();
    await request(a).post("/api/job-list/changes").send({ baseVersion: null, change: upsert("a") });
    const res = await request(a).get("/api/job-list/versions/1");
    expect(res.status).toBe(200);
    expect(body(res).document.jobs).toHaveLength(1);
    expect(body(res).summary).toBe("Added job a");
  });

  it("previews an import without saving", async () => {
    const a = app();
    const res = await request(a).post("/api/job-list/import/preview").send({ yaml: YAML });
    expect(res.status).toBe(200);
    expect(body(res).summary).toBe("Imported 2 jobs, 1 link and 0 workspace labels from YAML");
    expect(body(res).issues).toEqual([]);
    expect(body(res).diff).toContainEqual({ target: "job:orders_ingest", kind: "added", fields: [] });
    expect(body(await request(a).get("/api/job-list")).version).toBeNull();
  });

  it("shows rule issues in a preview and rejects bad YAML with 400", async () => {
    const a = app();
    const issues = await request(a).post("/api/job-list/import/preview").send({ yaml: "jobs:\n  - job_name: a\n    max_gap_minutes: 60.0\n" });
    expect(body(issues).issues[0].message).toContain("got 60.0");
    const bad = await request(a).post("/api/job-list/import/preview").send({ yaml: "- a\n" });
    expect(bad.status).toBe(400);
    expect(body(bad).error).toBe("yaml");
  });

  it("preview and import agree on a too-large number, and a large safe one passes", async () => {
    const a = app();
    const huge = "jobs:\n  - job_name: orders_ingest\n    max_gap_minutes: 99999999999999999999\n";
    const preview = await request(a).post("/api/job-list/import/preview").send({ yaml: huge });
    const imported = await request(a).post("/api/job-list/import").send({ yaml: huge, baseVersion: null });
    const message = "job orders_ingest: max_gap_minutes is too large (at most 9007199254740991), got 99999999999999999999";
    expect(preview.status).toBe(200);
    expect(body(preview).issues[0].message).toBe(message);
    expect(imported.status).toBe(422);
    expect(body(imported).issues[0].message).toBe(message);
    const safe = "jobs:\n  - job_name: orders_ingest\n    max_gap_minutes: 9007199254740991\n";
    expect(body(await request(a).post("/api/job-list/import/preview").send({ yaml: safe })).issues).toEqual([]);
    expect((await request(a).post("/api/job-list/import").send({ yaml: safe, baseVersion: null })).status).toBe(201);
  });

  it("imports, then exports with the headers", async () => {
    const a = app();
    const imp = await request(a).post("/api/job-list/import").set("x-forwarded-email", "me@example.com").send({ yaml: YAML, baseVersion: null });
    expect(imp.status).toBe(201);
    expect(body(imp).summary).toBe("Imported 2 jobs, 1 link and 0 workspace labels from YAML");
    const stale = await request(a).post("/api/job-list/import").send({ yaml: YAML, baseVersion: null });
    expect(stale.status).toBe(409);
    const out = await request(a).get("/api/job-list/export");
    expect(out.status).toBe(200);
    expect(out.headers["content-type"]).toContain("text/yaml");
    expect(out.headers["content-disposition"]).toBe('attachment; filename="monitored_jobs.v1.yml"');
    expect(out.text).toContain("# Exported from the Watchdog app: version 1, saved ");
    expect(out.text).toContain("by me@example.com");
  });

  it("rejects an import with rule problems using 422", async () => {
    const res = await request(app()).post("/api/job-list/import").send({ yaml: "jobs: []\n", baseVersion: null });
    expect(res.status).toBe(422);
    expect(body(res).issues[0].message).toBe("the YAML file lists no jobs");
  });

  it("404s an export with nothing saved", async () => {
    expect((await request(app()).get("/api/job-list/export")).status).toBe(404);
  });

  it("restores a version, and 404s a missing one", async () => {
    const a = app();
    await request(a).post("/api/job-list/changes").send({ baseVersion: null, change: upsert("a") });
    await request(a).post("/api/job-list/changes").send({ baseVersion: 1, change: upsert("b") });
    const res = await request(a).post("/api/job-list/restore").send({ version: 1, baseVersion: 2 });
    expect(res.status).toBe(201);
    expect(body(res).summary).toBe("Restored version 1");
    expect((await request(a).post("/api/job-list/restore").send({ version: 9, baseVersion: 3 })).status).toBe(404);
  });

  it("returns a job's impact, 404 for an unknown job", async () => {
    const a = app();
    await request(a).post("/api/job-list/import").send({ yaml: YAML, baseVersion: null });
    const res = await request(a).get("/api/job-list/impact/orders_ingest");
    expect(res.body).toEqual({ jobName: "orders_ingest", parentJob: null, affectsDirectly: ["orders_enrich"], affectsInAll: ["orders_enrich"] });
    expect((await request(a).get("/api/job-list/impact/nope")).status).toBe(404);
  });

  it("answers a body that is not JSON with 400 bad_request", async () => {
    const res = await request(app()).post("/api/job-list/changes").set("Content-Type", "application/json").send("{not json");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "bad_request", message: "The request body is not valid JSON." });
  });

  it("answers a body over 1 MB with 413 too_large", async () => {
    const res = await request(app()).post("/api/job-list/import/preview").send({ yaml: "x".repeat(1024 * 1024 + 1024) });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "too_large", message: "The request is larger than 1 MB." });
  });

  it("answers a YAML alias bomb with the yaml error, not a 500", async () => {
    const bomb = "a: &a [x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]\nd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]\ne: &e [*d, *d, *d, *d, *d, *d, *d, *d, *d]\nf: &f [*e, *e, *e, *e, *e, *e, *e, *e, *e]\njobs: []\n";
    const res = await request(app()).post("/api/job-list/import/preview").send({ yaml: bomb });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "yaml", message: "The YAML file uses too many aliases." });
  });
});

const denied = () => Object.assign(new Error("permission denied for schema watchdog_app"), { code: "42501" });

function appWith(store: JobListStore, ready?: () => Promise<void>) {
  const server = express();
  server.use("/api/job-list", createJobListRouter(store, { ready }));
  return server;
}

describe("when the app cannot use its schema", () => {
  it("says what to do, with 503, when the startup check was refused for lack of a privilege", async () => {
    const res = await request(appWith(createJobListStore(new MemoryVersionRepo()), () => Promise.reject(denied())))
      .get("/api/job-list");
    expect(res.status).toBe(503);
    expect(body(res).error).toBe("no_access");
    // without -t the CLI runs the bundle's default target, dev, which may not be the one deployed
    expect(body(res).message).toContain("databricks bundle run watchdog_app_access -t <target>");
  });

  it("answers 503 not_ready when the database did not answer, and lets the request through once it is ready", async () => {
    let ready: () => Promise<void> = () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const server = appWith(createJobListStore(new MemoryVersionRepo()), () => ready());
    const first = await request(server).get("/api/job-list");
    expect(first.status).toBe(503);
    expect(body(first).error).toBe("not_ready");
    expect(JSON.stringify(first.body)).not.toContain("ECONNREFUSED");
    ready = () => Promise.resolve();
    expect((await request(server).get("/api/job-list")).status).toBe(200);
  });

  it("says the same when a query is refused later, for example after a grant was taken back", async () => {
    const store = createJobListStore(new MemoryVersionRepo());
    const refusing: JobListStore = { ...store, latest: () => Promise.reject(denied()) };
    const res = await request(appWith(refusing)).get("/api/job-list");
    expect(res.status).toBe(503);
    expect(body(res).error).toBe("no_access");
  });
});

describe("behind AppKit's server, which parses JSON for every route first (1 MB)", () => {
  /** As the deployed app: AppKit's own express.json, then the routes. The pool is never reached here. */
  function appkitLike(): express.Application {
    const server = express();
    server.use(express.json({ limit: "1mb", type: (req) => (req.headers["content-type"] ?? "").includes("json") }));
    mountJobList(server, createJobListRouter(createJobListStore(new MemoryVersionRepo())));
    return server;
  }

  it("answers a body over the limit with the job list's own 413", async () => {
    const res = await request(appkitLike()).post("/api/job-list/import/preview").send({ yaml: "x".repeat(1024 * 1024 + 1024) });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "too_large", message: "The request is larger than 1 MB." });
  });

  it("answers a body that is not JSON with the job list's own 400", async () => {
    const res = await request(appkitLike()).post("/api/job-list/changes").set("content-type", "application/json").send("{nope");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "bad_request", message: "The request body is not valid JSON." });
  });
});

describe("a job list an older app stored with job_name 20241105 as a number", () => {
  function seeded() {
    const repo = new MemoryVersionRepo();
    const document: unknown = JSON.parse('{"jobs": [{"job_name": 20241105, "max_gap_minutes": 60}, {"job_name": "orders_ingest", "max_gap_minutes": 60}]}');
    repo.rows.push({
      version: 1, savedBy: "someone@example.com", savedAt: new Date(), changeKind: "import", changeTarget: null,
      summary: "Imported 2 jobs, 0 links and 0 workspace labels from YAML", document: document as { jobs: [] },
    });
    return appWith(createJobListStore(repo));
  }

  it("is read with the name as text, and an edit of that job saves instead of answering duplicate job_name", async () => {
    const server = seeded();
    const state = await request(server).get("/api/job-list");
    expect(body(state).document.jobs[0]).toEqual({ job_name: "20241105", max_gap_minutes: 60 });
    const res = await request(server).post("/api/job-list/changes").send({
      baseVersion: 1, change: { kind: "upsert", target: { type: "job", name: "20241105" }, value: { job_name: "20241105", max_gap_minutes: 90 } },
    });
    expect(res.status).toBe(201);
    expect(body(res).summary).toBe("Changed max_gap_minutes on 20241105 from 60 to 90");
    expect(body(res).document.jobs).toEqual([{ job_name: "20241105", max_gap_minutes: 90 }, { job_name: "orders_ingest", max_gap_minutes: 60 }]);
  });
});
