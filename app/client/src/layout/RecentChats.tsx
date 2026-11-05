import { SidebarMenuSub, SidebarMenuSubItem } from "@databricks/appkit-ui/react";
import type { JSX } from "react";

/** The newest copilot conversations, under Copilot in the nav. Task 8 fills this in. */
export function RecentChats(): JSX.Element {
  return (
    <SidebarMenuSub aria-label="Recent chats">
      <SidebarMenuSubItem>
        <span className="flex h-7 items-center px-2 text-xs text-muted-foreground">No chats yet</span>
      </SidebarMenuSubItem>
    </SidebarMenuSub>
  );
}
