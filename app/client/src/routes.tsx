import { Navigate, type RouteObject } from "react-router";
import { AppLayout } from "./layout/AppLayout";
import { CopilotPage } from "./pages/copilot/CopilotPage";
import { ChangeLogPage } from "./pages/jobs/ChangeLogPage";
import { DependencyMapPage } from "./pages/jobs/DependencyMapPage";
import { JobListPage } from "./pages/jobs/JobListPage";
import { SettingsPage } from "./pages/jobs/SettingsPage";
import { MonitoringPage } from "./pages/monitoring/MonitoringPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { RouteError } from "./pages/RouteError";

/** Every page renders inside AppLayout. A page that fails to render shows RouteError, and the nav stays. */
export const routes: RouteObject[] = [
  {
    element: <AppLayout />,
    children: [
      {
        errorElement: <RouteError />,
        children: [
          { path: "/", element: <Navigate to="/monitoring" replace /> },
          { path: "/monitoring", element: <MonitoringPage /> },
          { path: "/jobs", element: <JobListPage /> },
          { path: "/jobs/map", element: <DependencyMapPage /> },
          { path: "/jobs/changes", element: <ChangeLogPage /> },
          { path: "/jobs/settings", element: <SettingsPage /> },
          { path: "/copilot", element: <CopilotPage /> },
          { path: "/copilot/:threadId", element: <CopilotPage /> },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
];
