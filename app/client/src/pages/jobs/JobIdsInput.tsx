import { X } from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, useId, useState } from "react";
import { cn } from "../../lib/utils";

export interface JobIdsInputProps {
  /** The job IDs, as strings of digits. They are never turned into numbers, so a 16-digit ID keeps every digit. */
  value: string[];
  onChange: (next: string[]) => void;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Set by FormControl: the field's description and message. */
  "aria-describedby"?: string;
  /** Set by FormControl when the field has a rule issue. */
  "aria-invalid"?: boolean | "true" | "false";
  className?: string;
}

/** Commas, spaces and new lines separate IDs, so a pasted list adds every ID in it. */
const SEPARATOR = /[\s,]+/;

interface Added {
  next: string[];
  /** What stays in the input: the tokens that were refused. */
  rest: string;
  problem: string | null;
}

/** Adds each token that is a new string of digits. The first refused token explains itself. */
function addTokens(current: string[], tokens: string[]): Added {
  const next = [...current];
  const refused: string[] = [];
  let problem: string | null = null;
  for (const token of tokens) {
    if (!/^[0-9]+$/.test(token)) {
      refused.push(token);
      problem ??= `Job IDs are digits only. ${token} is not a job ID.`;
    } else if (next.includes(token)) {
      problem ??= `Job ID ${token} is already in the list.`;
    } else {
      next.push(token);
    }
  }
  return { next, rest: refused.join(", "), problem };
}

function tokensOf(text: string): string[] {
  return text.split(SEPARATOR).filter((token) => token !== "");
}

/**
 * Job IDs as chips. Enter, a comma or leaving the field adds the typed ID;
 * Backspace in an empty field removes the last one. Anything but digits is
 * refused with a message, and the text stays so it can be fixed.
 */
export function JobIdsInput({
  value,
  onChange,
  id,
  placeholder = "Type a job ID, then Enter",
  disabled = false,
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
  className,
}: JobIdsInputProps) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const messageId = useId();

  const commit = (tokens: string[], keep = "") => {
    if (tokens.length === 0) {
      setText(keep);
      return;
    }
    const added = addTokens(value, tokens);
    setProblem(added.problem);
    setText([added.rest, keep].filter((part) => part !== "").join(", "));
    if (added.next.length !== value.length) onChange(added.next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(tokensOf(text));
    } else if (event.key === "Backspace" && text === "" && value.length > 0) {
      event.preventDefault();
      setProblem(null);
      onChange(value.slice(0, -1));
    }
  };

  const onTextChange = (next: string) => {
    // A separator typed or pasted in the middle: add what comes before it, keep what follows.
    const parts = next.split(SEPARATOR);
    if (parts.length > 1) {
      const last = parts.pop() ?? "";
      commit(
        parts.filter((part) => part !== ""),
        last,
      );
      return;
    }
    setText(next);
    if (problem !== null) setProblem(null);
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text");
    if (!SEPARATOR.test(pasted)) return;
    event.preventDefault();
    commit(tokensOf(`${text}${pasted}`));
  };

  const remove = (target: string) => {
    setProblem(null);
    onChange(value.filter((item) => item !== target));
  };

  const invalid = problem !== null || ariaInvalid === true || ariaInvalid === "true";
  const describedByAll = [describedBy, problem ? messageId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("grid gap-1.5", className)}>
      <div
        data-slot="job-ids-input"
        aria-invalid={invalid}
        className={cn(
          "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 shadow-xs transition-[color,box-shadow]",
          "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
          "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
          disabled && "pointer-events-none opacity-50",
        )}
      >
        {value.length > 0 ? (
          <ul className="contents" aria-label="Job IDs in the list">
            {value.map((jobId) => (
              <li
                key={jobId}
                className="inline-flex h-6 items-center gap-1 rounded-sm border border-border bg-muted pr-0.5 pl-1.5 font-mono text-xs text-foreground"
              >
                {jobId}
                <button
                  type="button"
                  className="inline-flex size-5 items-center justify-center rounded-xs text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Remove job ID ${jobId}`}
                  disabled={disabled}
                  onClick={() => remove(jobId)}
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          className="h-6 min-w-[12ch] flex-1 bg-transparent font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground"
          placeholder={value.length === 0 ? placeholder : undefined}
          value={text}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={describedByAll}
          onChange={(event) => onTextChange(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => commit(tokensOf(text))}
        />
      </div>
      {problem ? (
        <p id={messageId} className="text-sm text-destructive" aria-live="polite">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
