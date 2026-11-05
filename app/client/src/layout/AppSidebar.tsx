import {
  Badge,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  SidebarTrigger,
  Skeleton,
  useSidebar,
} from "@databricks/appkit-ui/react";
import { Activity, ListChecks, MessageSquareText, Radar } from "lucide-react";
import { Link, NavLink, useLocation } from "react-router";
import { useAppConfig } from "../hooks/useAppConfig";
import { useWhoAmI } from "../hooks/useWhoAmI";
import { RecentChats } from "./RecentChats";
import { ScanStatus } from "./ScanStatus";

const JOB_PAGES = [
  { to: "/jobs", label: "Job list" },
  { to: "/jobs/map", label: "Dependency map" },
  { to: "/jobs/changes", label: "Change log" },
  { to: "/jobs/settings", label: "Defaults and workspace labels" },
] as const;

function RegionBadge() {
  const { config, loading } = useAppConfig();
  if (loading) return <Skeleton className="h-5 w-16 rounded-full" />;
  if (!config?.region) return null;
  return (
    <Badge variant="outline" className="h-5 border-sidebar-border bg-background px-1.5 font-mono text-[11px] font-normal text-muted-foreground">
      {config.region}
    </Badge>
  );
}

function SignedInAs() {
  const { whoami, loading } = useWhoAmI();
  const email = whoami?.email ?? whoami?.user ?? null;
  if (loading) return <Skeleton className="mx-2 h-3.5 w-40 group-data-[collapsible=icon]:hidden" />;
  if (!email) return null;
  return (
    <div className="flex min-h-7 items-center gap-2 px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
      <span
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-[11px] font-semibold uppercase text-sidebar-accent-foreground"
        title={email}
        aria-hidden="true"
      >
        {email.charAt(0)}
      </span>
      <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground group-data-[collapsible=icon]:hidden" title={email}>
        <span className="sr-only">Signed in as </span>
        {email}
      </span>
    </div>
  );
}

/** The left nav: Monitoring, the job list pages, and the copilot. Collapses to icons, with tooltips. */
export function AppSidebar() {
  const { pathname } = useLocation();
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const inJobs = pathname === "/jobs" || pathname.startsWith("/jobs/");

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border px-2 py-2.5">
        <div className="flex items-center gap-2 group-data-[collapsible=icon]:flex-col">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground" aria-hidden="true">
            <Radar className="size-[18px]" strokeWidth={2.25} />
          </span>
          <div className="flex min-w-0 flex-1 items-center gap-2 group-data-[collapsible=icon]:hidden">
            <span className="truncate text-[15px] font-semibold tracking-tight">Watchdog</span>
            <RegionBadge />
          </div>
          <SidebarTrigger className="text-muted-foreground hover:text-foreground" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <nav aria-label="Main">
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={pathname.startsWith("/monitoring")} tooltip="Monitoring">
                    <NavLink to="/monitoring">
                      <Activity aria-hidden="true" />
                      <span>Monitoring</span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>

                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={collapsed && inJobs} tooltip="Jobs and dependencies">
                    <Link to="/jobs">
                      <ListChecks aria-hidden="true" />
                      <span>Jobs and dependencies</span>
                    </Link>
                  </SidebarMenuButton>
                  <SidebarMenuSub>
                    {JOB_PAGES.map((page) => (
                      <SidebarMenuSubItem key={page.to}>
                        <SidebarMenuSubButton asChild isActive={pathname === page.to}>
                          <NavLink to={page.to} end>
                            <span>{page.label}</span>
                          </NavLink>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                </SidebarMenuItem>

                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={pathname.startsWith("/copilot")} tooltip="Copilot">
                    <NavLink to="/copilot">
                      <MessageSquareText aria-hidden="true" />
                      <span>Copilot</span>
                    </NavLink>
                  </SidebarMenuButton>
                  <RecentChats />
                </SidebarMenuItem>
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="gap-1 border-t border-sidebar-border py-2.5">
        <ScanStatus />
        <SignedInAs />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
