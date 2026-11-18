// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Change, JobListDocument } from "../../../../shared/joblist/types";
import type { SaveOutcome } from "../../hooks/useJobList";
import type { ApiError } from "../../lib/api";
import { DefaultsForm } from "./DefaultsForm";

const DOC: JobListDocument = { defaults: { owner: "platform-team", max_gap_minutes: 60 }, jobs: [{ job_name: "orders_ingest" }] };
/** The same list after someone else changed the default owner. */
const NEWER: JobListDocument = { ...DOC, defaults: { owner: "data-platform", max_gap_minutes: 60 } };

function renderForm() {
  const props = {
    onSave: vi.fn<(change: Change, baseVersion: number | null) => Promise<SaveOutcome>>(),
    onSaved: vi.fn(),
    onReload: vi.fn<() => Promise<ApiError | null>>(() => Promise.resolve(null)),
  };
  const view = render(<DefaultsForm document={DOC} version={4} {...props} />);
  return {
    newerArrives: () => view.rerender(<DefaultsForm document={NEWER} version={5} {...props} />),
  };
}

describe("DefaultsForm when newer defaults arrive and it has no edits", () => {
  it("moves focus to the card when focus was in the form, which starts again under it", async () => {
    const { newerArrives } = renderForm();
    await userEvent.click(screen.getByLabelText("Owner"));
    newerArrives();
    await waitFor(() => expect(screen.getByLabelText("Owner")).toHaveValue("data-platform"));
    expect(screen.getByText("This form now shows the newest saved values.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("region", { name: "Defaults" })).toHaveFocus());
  });

  it("leaves focus alone when the person moved it out of the form, to the page body too", async () => {
    const { newerArrives } = renderForm();
    await userEvent.click(screen.getByLabelText("Owner"));
    // A click on the page outside the form: focus goes to the body.
    await userEvent.click(document.body);
    expect(document.body).toHaveFocus();
    newerArrives();
    await waitFor(() => expect(screen.getByLabelText("Owner")).toHaveValue("data-platform"));
    expect(screen.getByText("This form now shows the newest saved values.")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole("region", { name: "Defaults" })).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });
});
