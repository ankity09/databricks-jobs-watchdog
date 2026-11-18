import { Button, Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@databricks/appkit-ui/react";
import { isRouteErrorResponse, useRouteError } from "react-router";
import { PageHeader } from "../layout/PageHeader";

/** Shown in place of a page that failed to render. The nav stays, so the rest of the app still works. */
export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "An unexpected error occurred.";
  return (
    <>
      <PageHeader title="This page failed to load" />
      <Empty className="flex-none border border-dashed border-border bg-muted/40 md:py-16">
        <EmptyHeader>
          <EmptyTitle>Something went wrong on this page</EmptyTitle>
          <EmptyDescription className="font-mono text-xs">{message}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            Reload the page
          </Button>
        </EmptyContent>
      </Empty>
    </>
  );
}
