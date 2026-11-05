// @vitest-environment jsdom
import { ResourceStatusProvider, useResourceStatusPublisher } from "@databricks/appkit-ui/react";
import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { StatusToasts } from "./StatusToasts";

/** Publishes what the analytics plugin publishes while the SQL warehouse starts. */
function StartingWarehouse() {
  const { publish } = useResourceStatusPublisher("test-warehouse", "Scan results", { kindHint: "warehouse" });
  useEffect(() => {
    publish({ kind: "warehouse", state: "STARTING", severity: "pending", startedAt: Date.now() });
  }, [publish]);
  return null;
}

describe("StatusToasts", () => {
  it("says the warehouse is warming up, with a still icon instead of a spinner, on a light toast", async () => {
    render(
      <ResourceStatusProvider>
        <StatusToasts />
        <StartingWarehouse />
      </ResourceStatusProvider>,
    );
    expect(await screen.findByText("SQL warehouse warming up")).toBeInTheDocument();
    expect(document.querySelector("[data-sonner-toast] .animate-spin")).toBeNull();
    expect(document.querySelector("[data-sonner-toast] svg")).not.toBeNull();
    expect(document.querySelector("[data-sonner-toaster]")).toHaveAttribute("data-sonner-theme", "light");
  });
});
