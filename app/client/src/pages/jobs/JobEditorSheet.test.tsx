// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobEntry, JobListDocument } from "../../../../shared/joblist/types";
import type { SaveOutcome } from "../../hooks/useJobList";
import { ApiError } from "../../lib/api";
import { JobEditorSheet, type JobEditorSheetProps } from "./JobEditorSheet";

const ORDERS_ENRICH: JobEntry = {
  job_name: "orders_enrich",
  job_name_regex: "^orders_enrich_(web|mobile)_(prod|dev)$",
  max_gap_minutes: 90,
  max_runtime_minutes: 45,
  max_retries: 2,
  owner: "ingestion-team",
  notes: "Runs hourly, once per variant.",
  environments: { lower: { enabled: false } },
};

const DOC: JobListDocument = {
  defaults: { owner: "platform-team", job_name_exclude_regex: "_test(_|$)" },
  workspaces: [
    { workspace_name: "example-prod", environment: "production" },
    { workspace_id: "1111111111111111", environment: "lower" },
  ],
  jobs: [{ job_name: "orders_ingest", schedule_type: "continuous", severity: "CRITICAL" }, ORDERS_ENRICH],
  dependencies: [{ job_name: "orders_enrich", depends_on: "orders_ingest", dependency_type: "job" }],
};

const SAVED: SaveOutcome = {
  ok: true,
  result: { version: 13, summary: "Changed max_gap_minutes on orders_enrich from 90 to 120", document: DOC },
};

function renderSheet(props: Partial<JobEditorSheetProps> = {}) {
  const onSave = vi.fn<(entry: JobEntry) => Promise<SaveOutcome>>(() => Promise.resolve(SAVED));
  const onOpenChange = vi.fn<(open: boolean) => void>();
  const onReload = vi.fn<() => Promise<ApiError | null>>(() => Promise.resolve(null));
  render(
    <JobEditorSheet
      open
      onOpenChange={onOpenChange}
      mode="edit"
      initial={ORDERS_ENRICH}
      document={DOC}
      onSave={onSave}
      onReload={onReload}
      {...props}
    />,
  );
  return { onSave, onOpenChange, onReload };
}

const field = (label: string) => screen.getByLabelText(label);

describe("JobEditorSheet", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders every field of a job, and the overrides for each workspace label", async () => {
    renderSheet();
    for (const label of [
      "Job name",
      "Enabled",
      "Name pattern",
      "Exclude pattern",
      "Job IDs",
      "Schedule type",
      "Max gap (minutes)",
      "Max runtime (minutes)",
      "Max retries",
      "Min attempt (minutes)",
      "Severity",
      "Owner",
      "Notes",
    ]) {
      expect(field(label)).toBeInTheDocument();
    }
    expect(field("Name pattern")).toHaveValue("^orders_enrich_(web|mobile)_(prod|dev)$");
    expect(field("Max gap (minutes)")).toHaveValue(90);
    expect(field("Owner")).toHaveValue("ingestion-team");
    expect(field("Notes")).toHaveValue("Runs hourly, once per variant.");

    // lower has an override, so it starts open; production starts closed.
    expect(field("Enabled in lower")).toHaveTextContent("Off");
    await userEvent.click(screen.getByRole("button", { name: /production/ }));
    for (const label of [
      "Severity",
      "Owner",
      "Enabled",
      "Max gap (minutes)",
      "Max runtime (minutes)",
      "Max retries",
      "Min attempt (minutes)",
      "Job IDs",
    ]) {
      expect(field(`${label} in production`)).toBeInTheDocument();
    }
  });

  it("shows each rule issue next to its field as you type, 200 ms after the last key", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    renderSheet();
    await user.clear(field("Max gap (minutes)"));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(field("Max gap (minutes)")).not.toHaveAccessibleDescription(/scheduled jobs need max_gap_minutes/);
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(field("Max gap (minutes)")).toHaveAccessibleDescription(/scheduled jobs need max_gap_minutes/);

    await user.type(field("Max retries"), "{Backspace}-1");
    act(() => {
      vi.advanceTimersByTime(210);
    });
    expect(field("Max retries")).toHaveAccessibleDescription(/max_retries must be a whole number of zero or more, got -1/);
  });

  it("keeps Save off until something changes, and while there are issues", async () => {
    renderSheet();
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();
    await userEvent.type(field("Owner"), "-eu");
    await vi.waitFor(() => expect(save).toBeEnabled());
    await userEvent.type(field("Owner"), "{Backspace}{Backspace}{Backspace}");
    await vi.waitFor(() => expect(save).toBeDisabled());
    await userEvent.clear(field("Max gap (minutes)"));
    await vi.waitFor(() => expect(save).toBeDisabled());
    await userEvent.type(field("Max gap (minutes)"), "120");
    await vi.waitFor(() => expect(save).toBeEnabled());
  });

  it("makes the job name read-only in edit mode, with the rename hint", () => {
    renderSheet();
    expect(field("Job name")).toHaveAttribute("readonly");
    expect(field("Job name")).toHaveAccessibleDescription("To rename a job, delete it and add it again.");
  });

  it("saves the entry the form describes: an emptied field removes its key", async () => {
    const { onSave, onOpenChange } = renderSheet();
    await userEvent.clear(field("Max retries"));
    await userEvent.clear(field("Max gap (minutes)"));
    await userEvent.type(field("Max gap (minutes)"), "120");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const { max_retries: _gone, ...rest } = ORDERS_ENRICH;
    expect(onSave).toHaveBeenCalledWith({ ...rest, max_gap_minutes: 120 });
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("says someone else changed the job on a 409, and reloads on Reload", async () => {
    const { onSave, onReload } = renderSheet();
    onSave.mockResolvedValueOnce({ ok: false, conflict: true, latestVersion: 14 });
    await userEvent.type(field("Owner"), "-eu");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Someone else changed this job since you opened it.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    await vi.waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("This form now shows the newest saved values. Make your change again.")).toBeInTheDocument();
    expect(field("Owner")).toHaveValue("ingestion-team");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("says when the reload fails, and keeps the conflict", async () => {
    const { onSave, onReload } = renderSheet();
    onSave.mockResolvedValueOnce({ ok: false, conflict: true, latestVersion: 14 });
    onReload.mockResolvedValueOnce(new ApiError(500, "server", "The job list could not be read or saved. Try again.", null));
    await userEvent.type(field("Owner"), "-eu");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await userEvent.click(await screen.findByRole("button", { name: "Reload" }));
    expect(await screen.findByText("The job list did not reload. The job list could not be read or saved. Try again.")).toBeInTheDocument();
    expect(screen.getByText("Someone else changed this job since you opened it.")).toBeInTheDocument();
    expect(screen.queryByText(/This form now shows the newest saved values/)).not.toBeInTheDocument();
    expect(field("Owner")).toHaveValue("ingestion-team-eu");
  });

  it("asks to open the job again on a 409 when it cannot reload", async () => {
    const { onSave } = renderSheet({ onReload: undefined });
    onSave.mockResolvedValueOnce({ ok: false, conflict: true, latestVersion: 14 });
    await userEvent.type(field("Owner"), "-eu");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText(
        "Someone else changed this job since you opened it. Close this form and open the job again to see their change.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
  });

  it("shows the server's issues of a 422 on their fields", async () => {
    const { onSave } = renderSheet();
    onSave.mockResolvedValueOnce({
      ok: false,
      conflict: false,
      message: "The job list has a problem.",
      issues: [
        { path: "jobs[orders_enrich].owner", message: "job orders_enrich: owner must name a team" },
        {
          path: "dependencies[orders_enrich->orders_ingest:job]",
          message: "dependency orders_enrich -> orders_ingest: orders_ingest is not a configured job",
        },
      ],
    });
    await userEvent.type(field("Owner"), "-eu");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await vi.waitFor(() => expect(field("Owner")).toHaveAccessibleDescription(/owner must name a team/));
    const other = screen.getByRole("region", { name: "Other problems in the job list" });
    expect(within(other).getByText("dependency orders_enrich -> orders_ingest: orders_ingest is not a configured job")).toBeInTheDocument();
  });

  it("refuses a new job whose name is taken", async () => {
    renderSheet({ mode: "create", initial: { job_name: "", max_gap_minutes: 60 } });
    expect(field("Job name")).not.toHaveAttribute("readonly");
    await userEvent.type(field("Job name"), "orders_ingest");
    await vi.waitFor(() => expect(field("Job name")).toHaveAccessibleDescription(/duplicate job_name 'orders_ingest' in the job list/));
    expect(screen.getByRole("button", { name: "Add job" })).toBeDisabled();
  });

  it("passes no pattern to the pattern preview while a new job has no name", async () => {
    const renderPatternPreview = vi.fn((pattern: string) => <p>preview of [{pattern}]</p>);
    renderSheet({ mode: "create", initial: { job_name: "" }, renderPatternPreview });
    expect(await screen.findByText("preview of []")).toBeInTheDocument();
  });

  it("passes the patterns the scan would use to the pattern preview", async () => {
    const renderPatternPreview = vi.fn((pattern: string, exclude: string) => (
      <p>
        preview of {pattern} without {exclude}
      </p>
    ));
    renderSheet({ renderPatternPreview });
    expect(await screen.findByText("preview of ^orders_enrich_(web|mobile)_(prod|dev)$ without _test(_|$)")).toBeInTheDocument();
    await userEvent.clear(field("Name pattern"));
    await vi.waitFor(() => expect(renderPatternPreview).toHaveBeenLastCalledWith("^orders_enrich$", "_test(_|$)"));
  });
});
