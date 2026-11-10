import { Alert, AlertDescription, AlertTitle, Button, Skeleton } from "@databricks/appkit-ui/react";
import { CircleAlert, Radar, RotateCw } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CopilotMessage as Message } from "../../hooks/useCopilot";
import { AnswerBlock } from "./AnswerBlock";

export interface CopilotMessageProps {
  message: Message;
  /** The signed-in person's email: Genie ran the queries as them. */
  ranAs: string | null;
  /** The step of this answer while it is on its way, in plain words. */
  statusLabel: string | null;
  /** Asks the failed question again. Set on the newest answer only. */
  onRetry?: () => void;
  /** Sends a follow-up question Genie suggested. */
  onAsk?: (question: string) => void;
  /** Another answer is on its way, so follow-ups wait. */
  busy?: boolean;
  /** The saved chat is still loading, so rows that have not come yet are on their way. */
  loadingChat?: boolean;
  /** The rows of this answer are being fetched again. */
  loadingRows?: boolean;
  /** Fetches this answer's rows again. */
  onRetryRows?: () => void;
  /** The last Retry for the rows failed. */
  rowsFailed?: boolean;
}

/** Markdown elements for Genie's answers: links open in a new tab, tables scroll, single line breaks stay. */
function withoutNode<T extends { node?: unknown }>(props: T): Omit<T, "node"> {
  const { node: _node, ...rest } = props;
  return rest;
}

const MARKDOWN: Components = {
  p: (props) => <p className="my-1.5 whitespace-pre-wrap first:mt-0 last:mb-0" {...withoutNode(props)} />,
  li: (props) => <li className="my-0.5 whitespace-pre-wrap" {...withoutNode(props)} />,
  ul: (props) => <ul className="my-1.5 list-disc space-y-0.5 pl-5" {...withoutNode(props)} />,
  ol: (props) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5" {...withoutNode(props)} />,
  a: (props) => (
    <a
      className="break-all text-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground"
      target="_blank"
      rel="noreferrer"
      {...withoutNode(props)}
    />
  ),
  strong: (props) => <strong className="font-semibold" {...withoutNode(props)} />,
  code: (props) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]" {...withoutNode(props)} />,
  pre: (props) => <pre className="my-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs" {...withoutNode(props)} />,
  table: (props: ComponentPropsWithoutRef<"table"> & { node?: unknown }) => (
    <div className="my-2 overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs" {...withoutNode(props)} />
    </div>
  ),
  th: (props) => <th className="border-b border-border bg-muted px-2.5 py-1.5 text-left font-medium" {...withoutNode(props)} />,
  td: (props) => <td className="border-b border-border px-2.5 py-1.5 font-mono last:border-b-0" {...withoutNode(props)} />,
  h1: (props) => <h3 className="mt-3 mb-1 text-sm font-semibold" {...withoutNode(props)} />,
  h2: (props) => <h3 className="mt-3 mb-1 text-sm font-semibold" {...withoutNode(props)} />,
  h3: (props) => <h4 className="mt-3 mb-1 text-sm font-semibold" {...withoutNode(props)} />,
};

function AnswerShell({ children }: { children: ReactNode }) {
  return (
    <article aria-label="Copilot answer" className="flex gap-3">
      <span aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Radar className="size-4" strokeWidth={2.25} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
    </article>
  );
}

/** The step Genie is on, with placeholder lines and a block where the answer will land. */
function RunningState({ label }: { label: string }) {
  return (
    <>
      <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="relative flex size-2" aria-hidden="true">
          <span className="absolute inline-flex size-full rounded-full bg-primary opacity-60 motion-safe:animate-ping" />
          <span className="relative inline-flex size-2 rounded-full bg-primary" />
        </span>
        {label}
      </div>
      <div data-testid="running-skeleton" className="space-y-2" aria-hidden="true">
        <Skeleton className="h-3 w-11/12 motion-reduce:animate-none" />
        <Skeleton className="h-3 w-3/4 motion-reduce:animate-none" />
      </div>
      <div data-testid="running-block" aria-hidden="true" className="h-24 w-full rounded-lg bg-muted motion-safe:animate-pulse" />
    </>
  );
}

/** One turn of the chat: the person's question, or Genie's answer with the SQL behind it. */
export function CopilotMessage({ message, ranAs, statusLabel, onRetry, onAsk, busy = false, loadingChat = false, loadingRows = false, onRetryRows, rowsFailed = false }: CopilotMessageProps) {
  if (message.role === "user") {
    return (
      <article aria-label="Your question" className="flex justify-end">
        <p className="max-w-[80%] rounded-lg rounded-br-sm bg-secondary px-3.5 py-2 text-sm leading-6 whitespace-pre-wrap text-foreground">{message.text}</p>
      </article>
    );
  }

  const inProgress = message.status !== null;
  const hasAnswer = message.text !== "" || message.queries.length > 0;
  const rowsComing = inProgress || loadingChat || loadingRows;

  if (inProgress && !hasAnswer) {
    return (
      <AnswerShell>
        <RunningState label={statusLabel ?? "Working"} />
      </AnswerShell>
    );
  }

  const showFooter = !inProgress && hasAnswer;
  const showSuggestions = showFooter && message.suggestions.length > 0 && onAsk !== undefined;

  return (
    <AnswerShell>
      {inProgress ? (
        <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="relative flex size-2" aria-hidden="true">
            <span className="absolute inline-flex size-full rounded-full bg-primary opacity-60 motion-safe:animate-ping" />
            <span className="relative inline-flex size-2 rounded-full bg-primary" />
          </span>
          {statusLabel ?? "Working"}
        </div>
      ) : null}

      {hasAnswer || message.error ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card px-3.5 py-3">
          {message.text ? (
            <div className="text-sm leading-6 text-foreground">
              <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN}>
                {message.text}
              </Markdown>
            </div>
          ) : null}

          {message.queries.map((query) => (
            <AnswerBlock
              key={query.id}
              query={query}
              ranAs={ranAs}
              resultState={rowsComing ? "loading" : query.result ? "ready" : "missing"}
              onRetryRows={onRetryRows}
              retryFailed={rowsFailed}
            />
          ))}

          {message.error ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>The copilot could not answer.</AlertTitle>
              <AlertDescription>
                <p>{message.error}</p>
                {onRetry ? (
                  <Button type="button" variant="outline" size="sm" onClick={onRetry} className="mt-2 h-7 gap-1.5 px-2.5 text-xs text-foreground">
                    <RotateCw aria-hidden="true" className="size-3.5" />
                    Retry
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          {showFooter ? <p className="text-xs text-muted-foreground">AI-generated. Check before acting.</p> : null}
        </div>
      ) : null}

      {!inProgress && !message.error && !hasAnswer ? <p className="text-sm text-muted-foreground">Genie sent no answer to this question.</p> : null}

      {showSuggestions ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Follow-up questions">
          {message.suggestions.map((suggestion) => (
            <Button
              key={suggestion}
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onAsk?.(suggestion)}
              className="h-auto min-h-7 rounded-full px-3 py-1 text-left text-xs font-normal whitespace-normal text-foreground"
            >
              {suggestion}
            </Button>
          ))}
        </div>
      ) : null}
    </AnswerShell>
  );
}
