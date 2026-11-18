import { TooltipProvider } from "@databricks/appkit-ui/react";
import { type DataRouter, RouterProvider } from "react-router";
import { RefreshProvider } from "./hooks/useRefreshKey";

export interface AppProps {
  /** main.tsx passes a browser router over `routes`; tests pass a memory router. */
  router: DataRouter;
}

export default function App({ router }: AppProps) {
  return (
    <RefreshProvider>
      <TooltipProvider delayDuration={200}>
        <RouterProvider router={router} />
      </TooltipProvider>
    </RefreshProvider>
  );
}
