import type { IncidentsUnavailable } from "./incidents";

const TEXT: Record<IncidentsUnavailable, string> = {
  missing: "The incidents view isn't there yet, so what's new and how long problems have been open aren't shown. Notebook 01 or the next scheduled scan creates it.",
  "no-access": "You can't read the incidents view, so what's new and how long problems have been open aren't shown. Ask for SELECT on it.",
  unreadable:
    "The incidents couldn't be read, so what's new and how long problems have been open aren't shown. The view may not exist yet (notebook 01 or the next scheduled scan creates it), or you may not have access to it.",
  shape: "The incidents could not be read, so what's new and how long problems have been open aren't shown. Check that the app and the scan are on the same version.",
};

export interface IncidentsNoteProps {
  /** Why the incident parts are missing. */
  reason: IncidentsUnavailable;
  className?: string;
}

/** One small line where the New badge, "Open since" and the problem lists would be. */
export function IncidentsNote({ reason, className }: IncidentsNoteProps) {
  return (
    <p className={className ?? "text-xs text-muted-foreground"}>
      {TEXT[reason]}
    </p>
  );
}
