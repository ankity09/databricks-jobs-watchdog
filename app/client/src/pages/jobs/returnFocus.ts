import { type RefObject, useCallback } from "react";

/**
 * Where focus goes when a sheet or dialog of the job pages closes: the first
 * of these controls that is still on the page. The first is the control that
 * opened it; the others stand in when that control went with its row (a
 * deleted job) or its empty state (the first job added).
 */
export type ReturnFocus = readonly RefObject<HTMLElement | null>[];

/** A sheet's or a dialog's content while it animates out: Radix marks it closed until it unmounts. */
const CLOSING = '[role="dialog"][data-state="closed"], [role="alertdialog"][data-state="closed"]';

/** On the page, not switched off, and not inside a sheet or dialog that is closing. */
function canTakeFocus(element: Element | null | undefined): element is HTMLElement {
  return element instanceof HTMLElement && element.isConnected && !element.matches(":disabled") && element.closest(CLOSING) === null;
}

/**
 * The onCloseAutoFocus handler of a sheet or dialog. Radix gives focus back
 * only to a Trigger, and the job pages open their sheets and dialogs from
 * their own buttons and rows, so without this, focus ends on the page body.
 * When another sheet or dialog has taken focus meanwhile (a pick in Add from
 * workspace opens the editor), focus stays there.
 */
export function useReturnFocus(targets: ReturnFocus | undefined): (event: Event) => void {
  return useCallback(
    (event: Event) => {
      event.preventDefault();
      const active = document.activeElement;
      if (active !== document.body && canTakeFocus(active)) return;
      targets?.map((target) => target.current).find(canTakeFocus)?.focus();
    },
    [targets],
  );
}
