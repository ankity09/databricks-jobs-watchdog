import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@databricks/appkit-ui/react";
import { History } from "lucide-react";
import { PageHeader } from "../../layout/PageHeader";

/** Placeholder: Task 6 builds the change log. */
export function ChangeLogPage() {
  return (
    <>
      <PageHeader title="Change log" description="Every saved version of the job list." />
      <Empty className="flex-none border border-dashed border-border bg-muted/40 md:py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <History aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Saved versions will show here</EmptyTitle>
          <EmptyDescription>
            This page will list each version of the job list: who saved it, when, and what changed. You will restore an older version here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </>
  );
}
