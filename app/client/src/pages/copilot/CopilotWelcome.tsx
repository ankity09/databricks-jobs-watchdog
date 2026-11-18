import { Radar } from "lucide-react";
import { useId } from "react";
import { SUGGESTED_QUESTIONS } from "./SuggestedPrompts";

/** One line under each starter question, in the same order as the questions. */
const HINTS = ["Open problems, worst first", "Schedule gaps by job", "The downstream chain", "Findings and scans in one read"] as const;

// The starter list is data, shared with the tests; it is not a component.
// eslint-disable-next-line react-refresh/only-export-components
export const STARTER_QUESTIONS: readonly { question: string; hint: string }[] = SUGGESTED_QUESTIONS.map((question, i) => ({ question, hint: HINTS[i] ?? "" }));

export interface CopilotWelcomeProps {
  onPick: (question: string) => void;
  disabled?: boolean;
}

/** The new chat: what the copilot answers from, and four questions to start with. */
export function CopilotWelcome({ onPick, disabled = false }: CopilotWelcomeProps) {
  const idBase = useId();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 py-8">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Radar className="size-5" strokeWidth={2.25} />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">What do you want to know?</h2>
          <p className="text-xs text-muted-foreground">Answers come from the Watchdog tables and run as you. Your recent chats are in the sidebar.</p>
        </div>
      </div>
      <div role="group" aria-label="Suggested questions" className="grid gap-2 sm:grid-cols-2">
        {STARTER_QUESTIONS.map(({ question, hint }, i) => (
          <button
            key={question}
            type="button"
            disabled={disabled}
            aria-label={question}
            aria-describedby={`${idBase}-${i}`}
            onClick={() => onPick(question)}
            className="flex flex-col gap-0.5 rounded-lg border border-border bg-card px-3.5 py-2.5 text-left transition-colors hover:border-foreground/30 hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="text-sm font-medium text-foreground">{question}</span>
            <span id={`${idBase}-${i}`} className="text-xs text-muted-foreground">
              {hint}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
