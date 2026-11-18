import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@databricks/appkit-ui/react";
import { Check, ChevronRight, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import type { CopilotQuery } from "../../hooks/useCopilot";
import { cn } from "../../lib/utils";

/** loading: the rows are on their way; ready: they came back; missing: they will not come (an expired or failed result). */
export type ResultState = "loading" | "ready" | "missing";

export interface SqlDisclosureProps {
  query: CopilotQuery;
  /** The signed-in person's email. Genie runs each query as the person asking. */
  ranAs: string | null;
}

/** The SQL behind an answer and who it ran as. The SQL stays folded until asked. */
export function SqlDisclosure({ query, ranAs }: SqlDisclosureProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void navigator.clipboard?.writeText(query.sql).then(
      () => setCopied(true),
      () => undefined,
    );
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="overflow-hidden rounded-md border border-border bg-muted/50">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1 pr-3 pl-1.5 text-xs">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-1.5 text-xs font-medium">
            <ChevronRight aria-hidden="true" className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
            {open ? "Hide SQL" : "Show SQL"}
          </Button>
        </CollapsibleTrigger>
        <span className="ml-auto flex min-w-0 items-center gap-1 text-muted-foreground">
          <span>Ran as</span>
          <span className="truncate font-mono text-[11px] text-foreground">{ranAs ?? "you"}</span>
        </span>
      </div>
      <CollapsibleContent className="border-t border-border bg-background">
        {query.description ? <p className="px-3 pt-2.5 text-xs leading-5 text-muted-foreground">{query.description}</p> : null}
        <div className="flex items-center justify-between gap-3 px-3 pt-2">
          <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">SQL</span>
          <Button type="button" variant="outline" size="sm" onClick={copy} className="h-7 gap-1.5 px-2 text-xs">
            {copied ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
            {copied ? "Copied" : "Copy SQL"}
          </Button>
        </div>
        <pre className="max-h-72 overflow-auto px-3 pt-1.5 pb-2.5 font-mono text-xs leading-5 whitespace-pre text-foreground">
          <code>{query.sql}</code>
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
