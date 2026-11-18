import { Button, Popover, PopoverAnchor, PopoverContent } from "@databricks/appkit-ui/react";
import { type RefObject, useId, useRef } from "react";
import type { Change, JobListDocument } from "../../../../shared/joblist/types";
import type { LinkProposal } from "../../lib/linkRules";
import { LinkForm, Mono } from "./LinkForm";
import type { Measurable } from "./mapModel";

export interface NewLinkCardProps {
  /** The link dropped on the map, or why it can't be made; null when no link was dropped. */
  proposal: LinkProposal | null;
  /** The box the link was dropped on, which the card opens next to. */
  anchor: RefObject<Measurable>;
  document: JobListDocument;
  saving: boolean;
  /** Where a press or focus leaves the card open: the line that says why a save failed, so Reload keeps the choices. */
  keepOpenWithin: RefObject<HTMLElement | null>;
  onSave: (change: Change) => void;
  /** returnFocus is false when a click or focus outside closed the card: focus stays where the person put it. */
  onClose: (returnFocus: boolean) => void;
}

/**
 * The card a dropped link opens, next to the box it was dropped on: the link
 * as a sentence, then its type, notes and Save link (LinkForm). A link that
 * can't be made shows why, with Close. Escape closes it.
 */
export function NewLinkCard({ proposal, anchor, document, saving, keepOpenWithin, onSave, onClose }: NewLinkCardProps) {
  const titleId = useId();
  const sentenceId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const outside = useRef(false);
  return (
    <Popover
      open={proposal !== null}
      onOpenChange={(open) => {
        if (open) return;
        const returnFocus = !outside.current;
        outside.current = false;
        onClose(returnFocus);
      }}
    >
      <PopoverAnchor virtualRef={anchor} />
      {proposal ? (
        <PopoverContent
          ref={contentRef}
          aria-labelledby={titleId}
          aria-describedby={sentenceId}
          tabIndex={-1}
          // Focus the card itself, which names it, not its first choice.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            outside.current = false;
            contentRef.current?.focus();
          }}
          onInteractOutside={(event) => {
            if (event.target instanceof Node && keepOpenWithin.current?.contains(event.target)) event.preventDefault();
            else outside.current = true;
          }}
          // The page moves focus on close: back to the box.
          onCloseAutoFocus={(event) => event.preventDefault()}
          // Escape closes the card, also when the tooltip of the box under the pointer is open, which would take the key
          // first; and nothing else: React events bubble out of portals, and on the map Escape clears the selection.
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            onClose(true);
          }}
          side="bottom"
          align="start"
          sideOffset={10}
          updatePositionStrategy="always"
          className="flex w-[22rem] flex-col gap-3 p-4 outline-none"
        >
          <div className="flex flex-col gap-1">
            <p id={titleId} className="text-sm font-medium">
              New link
            </p>
            {proposal.ok ? (
              <p id={sentenceId} className="text-xs text-muted-foreground">
                <Mono>{proposal.jobName}</Mono> depends on <Mono>{proposal.dependsOn}</Mono>.
              </p>
            ) : (
              <p id={sentenceId} className="text-sm text-muted-foreground">
                {proposal.reason}
              </p>
            )}
          </div>
          {proposal.ok ? (
            // Keyed by the pair, so a new drop starts with the default type and no notes.
            <LinkForm
              key={`${proposal.dependsOn}->${proposal.jobName}:${proposal.service}`}
              jobName={proposal.jobName}
              dependsOn={proposal.dependsOn}
              service={proposal.service}
              document={document}
              saving={saving}
              onCancel={() => onClose(true)}
              onSave={onSave}
            />
          ) : (
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => onClose(true)}>
                Close
              </Button>
            </div>
          )}
        </PopoverContent>
      ) : null}
    </Popover>
  );
}
