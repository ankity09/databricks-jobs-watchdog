import { SidebarInset, SidebarProvider } from "@databricks/appkit-ui/react";
import { useCallback, useState } from "react";
import { Outlet } from "react-router";
import { AppSidebar } from "./AppSidebar";

const SIDEBAR_KEY = "watchdog.sidebar.open";

function readSidebarOpen(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) !== "false";
  } catch {
    return true;
  }
}

/** The page frame: the collapsible left nav and the page itself. The nav remembers whether it was open. */
export function AppLayout() {
  const [open, setOpen] = useState(readSidebarOpen);
  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(SIDEBAR_KEY, String(next));
    } catch {
      // Storage can be off (private windows). The nav still works; it just forgets.
    }
  }, []);

  return (
    // 18rem fits "Defaults and workspace labels". The provider sets the width inline, so the class needs !important.
    <SidebarProvider open={open} onOpenChange={onOpenChange} className="[--sidebar-width:18rem]!">
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <div className="flex min-h-svh w-full flex-col gap-5 px-6 py-5 lg:px-8">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
