// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { JobEntry, JobListDocument } from "../../../../shared/joblist/types";
import type { SaveOutcome } from "../../hooks/useJobList";
import { mockReactFlow } from "../../test/reactflow-mocks";
import { MapSettingsForm } from "./MapSettingsForm";

const DOC: JobListDocument = {
  defaults: { schedule_type: "scheduled", severity: "WARNING", owner: "platform-team", max_retries: 2 },
  jobs: [
    { job_name: "orders_ingest", owner: "ingestion-team", max_gap_minutes: 60, max_runtime_minutes: 30 },
    { job_name: "daily_revenue_report", max_gap_minutes: 1500 },
  ],
};

const SAVED: SaveOutcome = { ok: true, result: { version: 5, summary: "Updated job orders_ingest", document: DOC } };

function renderForm(job: JobEntry = DOC.jobs[0]) {
  const onSave = vi.fn<(entry: JobEntry) => Promise<SaveOutcome>>(() => Promise.resolve(SAVED));
  render(<MapSettingsForm job={job} document={DOC} saving={false} onSave={onSave} />);
  return { onSave };
}

describe("MapSettingsForm", () => {
  // Radix's switch and toggle group measure with a ResizeObserver, which jsdom lacks.
  beforeAll(() => mockReactFlow());

  it("Save sends one upsert with the changed owner", async () => {
    const user = userEvent.setup();
    const { onSave } = renderForm();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    const owner = screen.getByRole("textbox", { name: "Owner" });
    await user.clear(owner);
    await user.type(owner, "data-team");
    await user.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ ...DOC.jobs[0], owner: "data-team" });
  });

  it("an empty number inherits and shows the inherited value as its placeholder", async () => {
    const user = userEvent.setup();
    const { onSave } = renderForm();
    const retries = screen.getByRole("textbox", { name: "Max retries" });
    expect(retries).toHaveValue("");
    expect(retries).toHaveAttribute("placeholder", "From defaults: 2");
    await user.type(retries, "4");
    await user.clear(retries);
    // Back to what was saved: nothing changed.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    const runtime = screen.getByRole("textbox", { name: /Max runtime/ });
    await user.clear(runtime);
    await user.click(screen.getByRole("button", { name: "Save" }));
    const sent = onSave.mock.calls[0]?.[0];
    expect(sent).toEqual({ job_name: "orders_ingest", owner: "ingestion-team", max_gap_minutes: 60 });
  });

  it("a scheduled job with no max gap shows the rule's message and Save stays off", async () => {
    const user = userEvent.setup();
    const { onSave } = renderForm();
    await user.clear(screen.getByRole("textbox", { name: /Max gap/ }));
    expect(await screen.findByText("scheduled jobs need max_gap_minutes")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await user.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Cancel restores the values", async () => {
    const user = userEvent.setup();
    renderForm();
    const owner = screen.getByRole("textbox", { name: "Owner" });
    await user.clear(owner);
    await user.type(owner, "data-team");
    await user.click(screen.getByRole("radio", { name: "Continuous" }));
    await user.click(screen.getByRole("switch", { name: "Monitored" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(owner).toHaveValue("ingestion-team");
    expect(screen.getByRole("radio", { name: "Scheduled" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Monitored" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
