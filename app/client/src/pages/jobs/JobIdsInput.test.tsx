// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { JobIdsInput } from "./JobIdsInput";

/** A controlled JobIdsInput that reports every change to `spy`. */
function Harness({ initial = [], spy }: { initial?: string[]; spy: (ids: string[]) => void }) {
  const [ids, setIds] = useState<string[]>(initial);
  return (
    <>
      <label htmlFor="ids">Job IDs</label>
      <JobIdsInput
        id="ids"
        value={ids}
        onChange={(next) => {
          spy(next);
          setIds(next);
        }}
      />
    </>
  );
}

function setup(initial: string[] = []) {
  const spy = vi.fn<(ids: string[]) => void>();
  render(<Harness initial={initial} spy={spy} />);
  return { spy, input: screen.getByLabelText("Job IDs") };
}

describe("JobIdsInput", () => {
  it("adds an ID on Enter", async () => {
    const { spy, input } = setup();
    await userEvent.type(input, "123456789012345{Enter}");
    expect(spy).toHaveBeenLastCalledWith(["123456789012345"]);
    expect(input).toHaveValue("");
    expect(screen.getByText("123456789012345")).toBeInTheDocument();
  });

  it("adds an ID on a comma", async () => {
    const { spy, input } = setup(["111"]);
    await userEvent.type(input, "222,");
    expect(spy).toHaveBeenLastCalledWith(["111", "222"]);
    expect(input).toHaveValue("");
  });

  it("refuses letters with a message", async () => {
    const { spy, input } = setup();
    await userEvent.type(input, "12a4{Enter}");
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByText("Job IDs are digits only. 12a4 is not a job ID.")).toBeInTheDocument();
    expect(input).toHaveValue("12a4");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("keeps a 16-digit ID as the exact string typed", async () => {
    const { spy, input } = setup();
    await userEvent.type(input, "9007199254740993{Enter}");
    expect(spy).toHaveBeenLastCalledWith(["9007199254740993"]);
    expect(screen.getByText("9007199254740993")).toBeInTheDocument();
  });

  it("removes the last chip on Backspace in an empty input", async () => {
    const { spy, input } = setup(["111", "222"]);
    await userEvent.click(input);
    await userEvent.keyboard("{Backspace}");
    expect(spy).toHaveBeenLastCalledWith(["111"]);
    expect(screen.queryByText("222")).not.toBeInTheDocument();
  });

  it("refuses an ID that is already listed", async () => {
    const { spy, input } = setup(["111"]);
    await userEvent.type(input, "111{Enter}");
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByText("Job ID 111 is already in the list.")).toBeInTheDocument();
  });

  it("adds every ID of a pasted list", async () => {
    const { spy, input } = setup();
    await userEvent.click(input);
    await userEvent.paste("111, 222\n333");
    expect(spy).toHaveBeenLastCalledWith(["111", "222", "333"]);
    expect(input).toHaveValue("");
  });

  it("removes one ID with its remove button", async () => {
    const { spy } = setup(["111", "222"]);
    await userEvent.click(screen.getByRole("button", { name: "Remove job ID 111" }));
    expect(spy).toHaveBeenLastCalledWith(["222"]);
  });

  it("adds a typed ID when focus leaves the input", async () => {
    const { spy, input } = setup();
    await userEvent.type(input, "444");
    await userEvent.tab();
    expect(spy).toHaveBeenLastCalledWith(["444"]);
  });
});
