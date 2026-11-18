// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportPreview, SaveResult } from "../../../../shared/joblist/types";
import { ApiError } from "../../lib/api";
import { ImportDialog } from "./ImportDialog";

const YAML = "jobs:\n  - job_name: orders_ingest\n    max_gap_minutes: 60\n";

const PREVIEW: ImportPreview = {
  document: {
    jobs: [
      { job_name: "orders_ingest", max_gap_minutes: 60 },
      { job_name: "orders_enrich", max_gap_minutes: 90 },
    ],
    dependencies: [{ job_name: "orders_enrich", depends_on: "orders_ingest", dependency_type: "job" }],
  },
  diff: [
    { target: "defaults", kind: "changed", fields: ["owner", "severity"] },
    { target: "job:orders_enrich", kind: "added", fields: [] },
    { target: "job:orders_ingest", kind: "changed", fields: ["max_gap_minutes"] },
    { target: "job:daily_revenue_report", kind: "removed", fields: [] },
    { target: "dependency:orders_enrich->orders_ingest:job", kind: "added", fields: [] },
  ],
  issues: [],
  summary: "Imported 2 jobs, 1 link and 0 workspace labels from YAML",
};

const SAVED: SaveResult = { version: 8, summary: PREVIEW.summary, document: PREVIEW.document };

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function bodyOf(init?: RequestInit): unknown {
  return JSON.parse(typeof init?.body === "string" ? init.body : "null");
}

/** fetch answers the preview with `preview` and the import with each of `imports` in turn. */
function mockApi(preview: ImportPreview | Response, imports: Response[] = []) {
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = urlOf(input);
    if (url === "/api/job-list/import/preview") return Promise.resolve(preview instanceof Response ? preview : json(200, preview));
    if (url === "/api/job-list/import") return Promise.resolve(imports.shift() ?? json(500, { error: "unexpected", message: "No answer" }));
    return Promise.resolve(json(404, { error: "not_found", message: url }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function callsTo(fetchMock: ReturnType<typeof mockApi>, path: string) {
  return fetchMock.mock.calls.filter(([input]) => urlOf(input) === path);
}

function renderDialog(props: Partial<Parameters<typeof ImportDialog>[0]> = {}) {
  const onImported = vi.fn<(result: SaveResult) => void>();
  const onReload = vi.fn<() => Promise<ApiError | null>>(() => Promise.resolve(null));
  const onOpenChange = vi.fn<(open: boolean) => void>();
  render(<ImportDialog open onOpenChange={onOpenChange} baseVersion={7} onReload={onReload} onImported={onImported} {...props} />);
  return { onImported, onReload, onOpenChange };
}

async function pasteAndPreview(text = YAML) {
  await userEvent.click(screen.getByLabelText("YAML"));
  await userEvent.paste(text);
}

describe("ImportDialog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("previews pasted YAML as soon as it is pasted", async () => {
    const fetchMock = mockApi(PREVIEW);
    renderDialog();
    await userEvent.click(screen.getByLabelText("YAML"));
    await userEvent.paste(YAML);
    await screen.findByRole("heading", { name: "What the import changes" });
    const calls = callsTo(fetchMock, "/api/job-list/import/preview");
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0]?.[1])).toEqual({ yaml: YAML });
  });

  it("previews typed changes with Preview changes", async () => {
    const fetchMock = mockApi(PREVIEW);
    renderDialog();
    await userEvent.type(screen.getByLabelText("YAML"), "jobs:");
    expect(callsTo(fetchMock, "/api/job-list/import/preview")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await screen.findByRole("heading", { name: "What the import changes" });
    expect(bodyOf(callsTo(fetchMock, "/api/job-list/import/preview")[0]?.[1])).toEqual({ yaml: "jobs:" });
  });

  it("previews an uploaded .yml or .yaml file", async () => {
    const fetchMock = mockApi(PREVIEW);
    renderDialog();
    await userEvent.upload(screen.getByLabelText("Choose file"), new File([YAML], "monitored_jobs.yaml", { type: "application/yaml" }));
    await screen.findByRole("heading", { name: "What the import changes" });
    expect(bodyOf(callsTo(fetchMock, "/api/job-list/import/preview")[0]?.[1])).toEqual({ yaml: YAML });
    expect(screen.getByText("monitored_jobs.yaml")).toBeInTheDocument();
  });

  it("refuses a file that is not YAML, or larger than 1 MB, without a preview", async () => {
    const fetchMock = mockApi(PREVIEW);
    renderDialog();
    const picker = screen.getByLabelText("Choose file");
    fireEvent.change(picker, { target: { files: [new File(["a,b"], "jobs.csv", { type: "text/csv" })] } });
    expect(await screen.findByText("Choose a .yml or .yaml file.")).toBeInTheDocument();
    fireEvent.change(picker, { target: { files: [new File(["x".repeat(1024 * 1024 + 1)], "big.yml")] } });
    expect(await screen.findByText("The file is larger than 1 MB. A job list is usually much smaller.")).toBeInTheDocument();
    expect(callsTo(fetchMock, "/api/job-list/import/preview")).toHaveLength(0);
  });

  it("lists the differences as added, changed and removed, with the field names", async () => {
    mockApi(PREVIEW);
    renderDialog();
    await pasteAndPreview();
    const added = await screen.findByRole("region", { name: "Added (2)" });
    expect(within(added).getByText("orders_enrich")).toBeInTheDocument();
    expect(within(added).getByText("orders_enrich -> orders_ingest (job)")).toBeInTheDocument();
    const changed = screen.getByRole("region", { name: "Changed (2)" });
    expect(within(changed).getByText("max_gap_minutes")).toBeInTheDocument();
    expect(within(changed).getByText("owner")).toBeInTheDocument();
    expect(within(changed).getByText("severity")).toBeInTheDocument();
    const removed = screen.getByRole("region", { name: "Removed (1)" });
    expect(within(removed).getByText("daily_revenue_report")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
  });

  it("lists a repeated issue once", async () => {
    const duplicate = { path: "jobs[orders_ingest]", message: "duplicate job_name 'orders_ingest' in the job list" };
    mockApi({ ...PREVIEW, issues: [duplicate, duplicate] });
    renderDialog();
    await pasteAndPreview();
    const issues = await screen.findByRole("region", { name: "Problems (1)" });
    expect(within(issues).getAllByText("duplicate job_name 'orders_ingest' in the job list")).toHaveLength(1);
  });

  it("lists every issue and blocks Import while there is one", async () => {
    mockApi({
      ...PREVIEW,
      issues: [
        { path: "jobs[orders_ingest].max_gap_minutes", message: "job orders_ingest: scheduled jobs need max_gap_minutes" },
        { path: "workspaces[0].environment", message: "workspace 123: environment is required, for example production or lower" },
      ],
    });
    renderDialog();
    await pasteAndPreview();
    const issues = await screen.findByRole("region", { name: "Problems (2)" });
    expect(within(issues).getByText("job orders_ingest: scheduled jobs need max_gap_minutes")).toBeInTheDocument();
    expect(within(issues).getByText("workspace 123: environment is required, for example production or lower")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  });

  it("shows the parser's message for YAML that does not parse", async () => {
    mockApi(json(400, { error: "yaml", message: "Map keys must be unique at line 3, column 3" }));
    renderDialog();
    await pasteAndPreview("jobs: [");
    expect(await screen.findByText("Map keys must be unique at line 3, column 3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import" })).not.toBeInTheDocument();
  });

  it("imports with the version the person has open", async () => {
    const fetchMock = mockApi(PREVIEW, [json(201, SAVED)]);
    const { onImported, onOpenChange } = renderDialog({ baseVersion: 7 });
    await pasteAndPreview();
    await userEvent.click(await screen.findByRole("button", { name: "Import" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(SAVED));
    expect(bodyOf(callsTo(fetchMock, "/api/job-list/import")[0]?.[1])).toEqual({ yaml: YAML, baseVersion: 7 });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("says the list changed on a 409, and previews again after a reload", async () => {
    const conflict = json(409, {
      error: "conflict",
      message: "Someone else changed this since you opened it. Reload to see their change.",
      latestVersion: 9,
    });
    const fetchMock = mockApi(PREVIEW, [conflict]);
    const { onReload, onImported } = renderDialog({ baseVersion: 7 });
    await pasteAndPreview();
    await userEvent.click(await screen.findByRole("button", { name: "Import" }));
    expect(
      await screen.findByText("The job list changed since you previewed this file. Preview again to see the newest differences."),
    ).toBeInTheDocument();
    expect(onImported).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Preview again" }));
    await waitFor(() => expect(callsTo(fetchMock, "/api/job-list/import/preview")).toHaveLength(2));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("says when the reload before a new preview fails, and keeps the conflict", async () => {
    const conflict = json(409, { error: "conflict", message: "Someone else changed this.", latestVersion: 9 });
    const fetchMock = mockApi(PREVIEW, [conflict]);
    const { onReload } = renderDialog({ baseVersion: 7 });
    onReload.mockResolvedValueOnce(new ApiError(500, "server", "The job list could not be read or saved. Try again.", null));
    await pasteAndPreview();
    await userEvent.click(await screen.findByRole("button", { name: "Import" }));
    await userEvent.click(await screen.findByRole("button", { name: "Preview again" }));
    expect(await screen.findByText("The job list did not reload. The job list could not be read or saved. Try again.")).toBeInTheDocument();
    expect(
      screen.getByText("The job list changed since you previewed this file. Preview again to see the newest differences."),
    ).toBeInTheDocument();
    expect(callsTo(fetchMock, "/api/job-list/import/preview")).toHaveLength(1);
  });

  it("says when the file matches the saved list, and does not offer an import", async () => {
    mockApi({ ...PREVIEW, diff: [] });
    renderDialog();
    await pasteAndPreview();
    expect(await screen.findByText("This file matches the saved job list. There is nothing to import.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  });
});
