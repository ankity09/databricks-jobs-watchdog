import { Button } from "@databricks/appkit-ui/react";
import { ArrowUpRight, MessageSquareText } from "lucide-react";

/**
 * The Genie agent's sample questions (resources/watchdog_copilot.genie.yml),
 * in the same order. tests/test_bundle_config.py checks that they match.
 */
const SUGGESTED_QUESTIONS = [
  "What is failing right now?",
  "Which jobs missed their schedule?",
  "What breaks if orders_ingest fails?",
  "Summarize the last 24 hours.",
] as const;

export interface SuggestedPromptsProps {
  onPick: (question: string) => void;
  disabled?: boolean;
}

/** The empty chat: what the copilot answers from, and questions to start with. */
export function SuggestedPrompts({ onPick, disabled = false }: SuggestedPromptsProps) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-5 px-4 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-secondary text-foreground" aria-hidden="true">
        <MessageSquareText className="size-5" />
      </span>
      <div className="space-y-1.5">
        <h2 className="text-base font-semibold text-foreground">Ask about your monitored jobs</h2>
        <p className="text-sm text-muted-foreground">
          The copilot reads the Watchdog&apos;s findings, the job list and its dependencies. It writes SQL, runs it as you and shows that SQL with each answer.
        </p>
      </div>
      <div role="group" aria-label="Suggested questions" className="grid w-full gap-2 sm:grid-cols-2">
        {SUGGESTED_QUESTIONS.map((question) => (
          <Button
            key={question}
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => onPick(question)}
            className="group h-auto min-h-11 justify-between gap-3 px-3.5 py-2.5 text-left text-sm font-normal whitespace-normal"
          >
            {question}
            <ArrowUpRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
          </Button>
        ))}
      </div>
    </div>
  );
}
