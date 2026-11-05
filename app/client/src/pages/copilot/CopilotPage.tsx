import { Alert, AlertDescription, AlertTitle, Button, Skeleton, Textarea } from "@databricks/appkit-ui/react";
import { CircleAlert, Plus, RotateCw, SendHorizontal } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { useCopilot } from "../../hooks/useCopilot";
import { useWhoAmI } from "../../hooks/useWhoAmI";
import { PageHeader } from "../../layout/PageHeader";
import { conversationsChanged } from "../../lib/copilot-api";
import { questionFromLink } from "../../lib/copilot-link";
import { CopilotMessage } from "./CopilotMessage";
import { SuggestedPrompts } from "./SuggestedPrompts";

/**
 * The key of the chat a history entry shows. A chat started on /copilot keeps
 * its key when the address moves to /copilot/<conversation ID>, so it keeps
 * streaming; every other visit gets the entry's own key, so it starts fresh.
 */
function chatKeyOf(state: unknown): string | null {
  if (typeof state === "object" && state !== null && "chatKey" in state && typeof state.chatKey === "string") return state.chatKey;
  return null;
}

function ChatSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-6" aria-label="Loading the chat">
      <Skeleton className="ml-auto h-9 w-2/5 rounded-lg" />
      <div className="flex gap-3">
        <Skeleton className="size-7 shrink-0 rounded-md" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
      </div>
    </div>
  );
}

interface CopilotChatProps {
  chatKey: string;
  /** The Genie conversation in the address, when the chat was opened from one. */
  conversationId: string | undefined;
}

function CopilotChat({ chatKey, conversationId }: CopilotChatProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { whoami } = useWhoAmI();
  const ranAs = whoami?.email ?? whoami?.user ?? null;
  // A deep link from Monitoring fills in a question; it waits for the person to send it.
  const [draft, setDraft] = useState(() => questionFromLink(searchParams));
  const inputId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const chat = useCopilot({
    conversationId,
    onConversationStart: (id) => {
      void navigate(`/copilot/${encodeURIComponent(id)}`, { replace: true, state: { chatKey } });
      conversationsChanged();
    },
  });

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [chat.messages, chat.status]);

  const busy = chat.streaming || chat.loading;
  const ask = (question: string) => {
    if (!busy) void chat.send(question);
  };
  const submit = () => {
    const question = draft.trim();
    if (!question || busy) return;
    setDraft("");
    void chat.send(question);
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const newest = chat.messages.at(-1);
  const canRetry = !busy && newest?.role === "assistant" && newest.error !== null;

  let body;
  if (chat.loading && chat.messages.length === 0) {
    body = <ChatSkeleton />;
  } else if (chat.loadError !== null) {
    body = (
      <div className="mx-auto w-full max-w-3xl px-5 py-6">
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>This chat could not be loaded.</AlertTitle>
          <AlertDescription>
            <p>{chat.loadError}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void chat.retry()} className="mt-2 h-7 gap-1.5 px-2.5 text-xs text-foreground">
              <RotateCw aria-hidden="true" className="size-3.5" />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  } else if (chat.messages.length === 0) {
    body = <SuggestedPrompts onPick={ask} disabled={busy} />;
  } else {
    body = (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 py-5">
        {chat.messages.map((message) => (
          <CopilotMessage
            key={message.id}
            message={message}
            ranAs={ranAs}
            statusLabel={message.status !== null ? chat.status : null}
            onRetry={canRetry && message === newest ? () => void chat.retry() : undefined}
            onAsk={ask}
            busy={busy}
          />
        ))}
      </div>
    );
  }

  return (
    <section aria-label="Chat" className="flex min-h-[24rem] flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div ref={listRef} role="log" aria-label="Messages" aria-busy={busy} className="min-h-0 flex-1 overflow-y-auto">
        {body}
      </div>
      <form onSubmit={onSubmit} className="border-t border-border bg-background px-4 py-3">
        <div className="mx-auto w-full max-w-3xl">
          <label htmlFor={inputId} className="sr-only">
            Question
          </label>
          <div className="flex items-end gap-2">
            <Textarea
              id={inputId}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Ask about failures, missed schedules or what a failure affects"
              className="max-h-40 min-h-10 resize-none bg-background text-sm"
            />
            <Button type="submit" disabled={busy || draft.trim() === ""} className="h-10 gap-1.5 px-3.5">
              <SendHorizontal aria-hidden="true" className="size-4" />
              Send
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Questions run as you, with your Unity Catalog access. The copilot only reads; it cannot change or rerun jobs.
          </p>
        </div>
      </form>
    </section>
  );
}

/** The copilot: a chat with the Watchdog's Genie agent. Serves /copilot and /copilot/:threadId (a Genie conversation ID). */
export function CopilotPage() {
  const { threadId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const chatKey = chatKeyOf(location.state) ?? location.key;

  return (
    // The page is exactly the viewport's height less the layout's padding, so the chat scrolls inside and the page never does.
    <div className="flex h-[calc(100svh-2.5rem)] min-h-[32rem] flex-col gap-5">
      <PageHeader
        title="Copilot"
        description="Ask about job status, failures and what they affect. Each answer shows the SQL it ran."
        actions={
          <Button type="button" variant="outline" size="sm" onClick={() => void navigate("/copilot")} className="gap-1.5">
            <Plus aria-hidden="true" className="size-4" />
            New chat
          </Button>
        }
      />
      <CopilotChat key={chatKey} chatKey={chatKey} conversationId={threadId} />
    </div>
  );
}
