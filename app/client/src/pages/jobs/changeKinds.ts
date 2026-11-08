import type { ChangeKind } from "../../../../shared/joblist/types";

/** The colors of a kind, in the table's badge and in the filter chip when it is on. */
export const KIND_STYLE: Record<ChangeKind, string> = {
  import: "border-foreground/20 bg-background text-foreground",
  create: "border-success/30 bg-success/10 text-success",
  update: "border-border bg-secondary text-secondary-foreground",
  delete: "border-destructive/30 bg-destructive/10 text-destructive",
  restore: "border-warning/30 bg-warning/10 text-warning",
};

/** What the filter chips call each kind. */
export const KIND_LABEL: Record<ChangeKind, string> = {
  import: "Imported",
  create: "Added",
  update: "Changed",
  delete: "Deleted",
  restore: "Restored",
};

/** A filter chip that is on wears its kind's colors. */
export const KIND_CHIP_ON: Record<ChangeKind, string> = {
  import: "data-[state=on]:border-foreground/20 data-[state=on]:bg-background data-[state=on]:text-foreground",
  create: "data-[state=on]:border-success/30 data-[state=on]:bg-success/10 data-[state=on]:text-success",
  update: "data-[state=on]:border-border data-[state=on]:bg-secondary data-[state=on]:text-secondary-foreground",
  delete: "data-[state=on]:border-destructive/30 data-[state=on]:bg-destructive/10 data-[state=on]:text-destructive",
  restore: "data-[state=on]:border-warning/30 data-[state=on]:bg-warning/10 data-[state=on]:text-warning",
};
