import { ResourceStatusIndicator, ResourceStatusProvider } from "@databricks/appkit-ui/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import "./index.css";
import App from "./App.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { routes } from "./routes.tsx";

const router = createBrowserRouter(routes);

const container = document.getElementById("root");
if (!container) throw new Error("index.html has no #root element.");

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      {/* Shows a toast while the SQL warehouse starts, for every query on the page. */}
      <ResourceStatusProvider>
        <ResourceStatusIndicator />
        <App router={router} />
      </ResourceStatusProvider>
    </ErrorBoundary>
  </StrictMode>,
);
