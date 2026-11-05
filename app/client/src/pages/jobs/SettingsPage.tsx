import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@databricks/appkit-ui/react";
import { SlidersHorizontal } from "lucide-react";
import { PageHeader } from "../../layout/PageHeader";

/** Placeholder: Task 6 builds the defaults and workspace labels. */
export function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Defaults and workspace labels"
        description="The settings every job inherits, and the environment label of each workspace."
      />
      <Empty className="flex-none border border-dashed border-border bg-muted/40 md:py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SlidersHorizontal aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Defaults and labels will show here</EmptyTitle>
          <EmptyDescription>
            This page will show the default limits for all jobs, and the label of each workspace, such as production or lower.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </>
  );
}
