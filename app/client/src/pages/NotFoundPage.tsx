import { Button, Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@databricks/appkit-ui/react";
import { Link } from "react-router";
import { PageHeader } from "../layout/PageHeader";

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <Empty className="flex-none border border-dashed border-border bg-muted/40 md:py-16">
        <EmptyHeader>
          <EmptyTitle>There is no page at this address</EmptyTitle>
          <EmptyDescription>Check the link, or go back to Monitoring.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline" size="sm">
            <Link to="/monitoring">Go to Monitoring</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </>
  );
}
