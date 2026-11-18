import { SidebarInset, SidebarProvider, SidebarTrigger } from "@databricks/appkit-ui/react";
import { Radar } from "lucide-react";
import { useCallback, useState } from "react";
import { Outlet } from "react-router";
import { ScanNowProvider } from "../hooks/ScanNowProvider";
import { AppSidebar } from "./AppSidebar";

const SIDEBAR_KEY = "watchdog.sidebar.open";

function readSidebarOpen(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) !== "false";
  } catch {
    return true;
  }
}

/**
 * The page frame: the collapsible left nav and the page itself. The nav remembers whether it was open.
 * Below 768 px the nav is a sheet with nothing outside it to open it, so a small row at the top of the page
 * holds the menu button and the app name. It is the small-screen menu, not a top bar: it is hidden from 768 px up.
 */
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
      <ScanNowProvider>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2 md:hidden" data-slot="small-screen-menu">
            <SidebarTrigger className="text-muted-foreground hover:text-foreground" aria-label="Open navigation" />
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground" aria-hidden="true">
              <Radar className="size-3.5" strokeWidth={2.25} />
            </span>
            <span className="text-sm font-semibold tracking-tight">Watchdog</span>
          </div>
          <div className="flex min-h-svh w-full flex-col gap-5 px-6 py-5 lg:px-8">
            <Outlet />
          </div>
        </SidebarInset>
      </ScanNowProvider>
    </SidebarProvider>
  );
}
