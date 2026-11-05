import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@databricks/appkit-ui/react";
import { Network } from "lucide-react";
import { useJobList } from "../../hooks/useJobList";
import { PageHeader } from "../../layout/PageHeader";
import { ConfigBanner } from "./ConfigBanner";

/** Placeholder: Task 7 builds the dependency map. The banner says which job-list version the scan uses. */
export function DependencyMapPage() {
  const { state } = useJobList();
  return (
    <>
      <PageHeader title="Dependency map" description="How the monitored jobs depend on each other and on services." />
      <ConfigBanner savedVersion={state ? state.version : undefined} />
      <Empty className="flex-none border border-dashed border-border bg-muted/40 md:py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Network aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>The dependency map will show here</EmptyTitle>
          <EmptyDescription>
            This page will draw the jobs and services as a graph, colored by live status, and show what a failure affects.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </>
  );
}
