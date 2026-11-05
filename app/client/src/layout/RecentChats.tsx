import { Skeleton, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from "@databricks/appkit-ui/react";
import { useEffect, useState, type JSX } from "react";
import { NavLink, useLocation } from "react-router";
import { toApiError } from "../lib/api";
import { type ConversationSummary, listConversations, onConversationsChanged } from "../lib/copilot-api";

/** The nav lists this many of the person's newest chats. */
const SHOWN = 8;

interface ChatsState {
  chats: ConversationSummary[] | null;
  error: string | null;
}

/** The person's newest copilot chats, under Copilot in the nav. Genie keeps them; each opens at /copilot/<conversation ID>. */
export function RecentChats(): JSX.Element {
  const { pathname } = useLocation();
  const [state, setState] = useState<ChatsState>({ chats: null, error: null });
  const [round, setRound] = useState(0);

  useEffect(() => onConversationsChanged(() => setRound((n) => n + 1)), []);
  useEffect(() => {
    let active = true;
    listConversations().then(
      (chats) => {
        if (active) setState({ chats, error: null });
      },
      (error: unknown) => {
        // Keep the chats already shown when a reload fails.
        if (active) setState((previous) => ({ chats: previous.chats, error: toApiError(error).message }));
      },
    );
    return () => {
      active = false;
    };
  }, [round]);

  const retry = () => {
    setState({ chats: null, error: null });
    setRound((n) => n + 1);
  };

  let items: JSX.Element | JSX.Element[];
  if (state.chats === null && state.error === null) {
    items = [0, 1, 2].map((n) => (
      <SidebarMenuSubItem key={`loading-${n}`}>
        <span className="flex h-7 items-center px-2">
          <Skeleton className="h-3 w-full max-w-36" />
        </span>
      </SidebarMenuSubItem>
    ));
  } else if (state.chats === null || (state.chats.length === 0 && state.error !== null)) {
    items = (
      <SidebarMenuSubItem>
        <span className="flex min-h-7 items-center gap-1.5 px-2 text-xs text-muted-foreground" title={state.error ?? undefined}>
          Could not load chats.
          <button
            type="button"
            onClick={retry}
            aria-label="Retry loading chats"
            className="rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Retry
          </button>
        </span>
      </SidebarMenuSubItem>
    );
  } else if (state.chats.length === 0) {
    items = (
      <SidebarMenuSubItem>
        <span className="flex h-7 items-center px-2 text-xs text-muted-foreground">No chats yet</span>
      </SidebarMenuSubItem>
    );
  } else {
    items = state.chats.slice(0, SHOWN).map((chat) => {
      const to = `/copilot/${encodeURIComponent(chat.id)}`;
      return (
        <SidebarMenuSubItem key={chat.id}>
          <SidebarMenuSubButton asChild isActive={pathname === to}>
            <NavLink to={to} title={chat.title}>
              <span className="truncate">{chat.title}</span>
            </NavLink>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      );
    });
  }

  return <SidebarMenuSub aria-label="Recent chats">{items}</SidebarMenuSub>;
}
