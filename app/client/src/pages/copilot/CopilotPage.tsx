import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@databricks/appkit-ui/react";
import { MessageSquareText } from "lucide-react";
import { PageHeader } from "../../layout/PageHeader";

/** Placeholder: Task 8 builds the copilot, on a Genie space. Serves /copilot and /copilot/:threadId. */
export function CopilotPage() {
  return (
    <>
      <PageHeader title="Copilot" description="Ask questions about the monitored jobs and their runs." />
      <Empty className="flex-none border border-dashed border-border bg-muted/40 md:py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageSquareText aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>The copilot will show here</EmptyTitle>
          <EmptyDescription>
            This page will answer questions about job status, failures and what they affect, from the Watchdog tables, and show the SQL behind each answer.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </>
  );
}
