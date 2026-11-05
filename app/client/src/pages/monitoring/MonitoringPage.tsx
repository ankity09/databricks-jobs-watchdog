import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@databricks/appkit-ui/react";
import { Activity } from "lucide-react";
import { PageHeader } from "../../layout/PageHeader";

/** Placeholder: Task 5 builds the Monitoring page. */
export function MonitoringPage() {
  return (
    <>
      <PageHeader title="Monitoring" description="The status of every monitored job, from the newest scans." />
      <Empty className="flex-none border border-dashed border-border bg-muted/40 md:py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Activity aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Job status will show here</EmptyTitle>
          <EmptyDescription>
            This page will list every monitored job with its latest status, the checks behind it, and its recent scan history.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </>
  );
}
