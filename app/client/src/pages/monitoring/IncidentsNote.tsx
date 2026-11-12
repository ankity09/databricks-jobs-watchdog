import type { IncidentsView } from "./incidents";

export interface IncidentsNoteProps {
  /** Why the incident parts are missing. */
  reason: Extract<IncidentsView, { status: "unavailable" }>["reason"];
  className?: string;
}

/** One small line where the New badge, "Open since" and the problem lists would be. */
export function IncidentsNote({ reason, className }: IncidentsNoteProps) {
  return (
    <p className={className ?? "text-xs text-muted-foreground"}>
      {reason === "missing"
        ? "The incidents view isn't there yet, so what is new and how long a problem has been open are not shown. Notebook 01 or the next scheduled scan creates it."
        : "The incidents could not be read, so what is new and how long a problem has been open are not shown. Check that the app and the scan are on the same version."}
    </p>
  );
}
