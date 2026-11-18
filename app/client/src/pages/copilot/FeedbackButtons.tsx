import { Button } from "@databricks/appkit-ui/react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";
import { type FeedbackRating, sendFeedback } from "../../lib/copilot-api";

export interface FeedbackButtonsProps {
  /** The chat this answer belongs to; null until Genie has named it. */
  conversationId: string | null;
  /** Genie's ID for the answer. The app's own placeholder ID (local-...) shows no buttons. */
  messageId: string;
  /** The rating Genie already holds for this answer, for a chat that is reopened. */
  initial?: FeedbackRating | null;
}

/** Thumbs up and down for one finished answer. A second click on the pressed one clears the rating. */
export function FeedbackButtons({ conversationId, messageId, initial = null }: FeedbackButtonsProps) {
  const [rating, setRating] = useState<FeedbackRating>(initial ?? "NONE");
  const [failed, setFailed] = useState(false);
  const [sending, setSending] = useState(false);

  if (!conversationId || !messageId || messageId.startsWith("local-")) return null;

  async function choose(target: "POSITIVE" | "NEGATIVE") {
    if (!conversationId || sending) return;
    // A later write or rollback must not race this answer's pending rating.
    setSending(true);
    const previous = rating;
    const next: FeedbackRating = previous === target ? "NONE" : target;
    setRating(next);
    setFailed(false);
    try {
      await sendFeedback({ conversationId, messageId, rating: next });
    } catch {
      setRating(previous);
      setFailed(true);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={sending}
        aria-label="Good answer"
        aria-pressed={rating === "POSITIVE"}
        onClick={() => void choose("POSITIVE")}
        className="size-7 text-muted-foreground aria-pressed:bg-primary/10 aria-pressed:text-primary"
      >
        <ThumbsUp aria-hidden="true" className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={sending}
        aria-label="Bad answer"
        aria-pressed={rating === "NEGATIVE"}
        onClick={() => void choose("NEGATIVE")}
        className="size-7 text-muted-foreground aria-pressed:bg-primary/10 aria-pressed:text-primary"
      >
        <ThumbsDown aria-hidden="true" className="size-3.5" />
      </Button>
      {failed ? (
        <p role="status" className="ml-1 text-xs text-destructive">
          Your feedback couldn&apos;t be sent.
        </p>
      ) : null}
    </div>
  );
}
