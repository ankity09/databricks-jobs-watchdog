import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@databricks/appkit-ui/react";
import { ListChecks } from "lucide-react";
import { PageHeader } from "../../layout/PageHeader";

/** Placeholder: Task 6 builds the job list. */
export function JobListPage() {
  return (
    <>
      <PageHeader title="Job list" description="The jobs the Watchdog monitors, and the limits for each." />
      <Empty className="flex-none border border-dashed border-border bg-muted/40 md:py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListChecks aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>The job list will show here</EmptyTitle>
          <EmptyDescription>
            This page will list the monitored jobs with their schedule, limits, severity and owner. You will add, edit and remove jobs here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </>
  );
}
