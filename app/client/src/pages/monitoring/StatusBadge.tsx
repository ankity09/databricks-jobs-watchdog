import { Badge } from "@databricks/appkit-ui/react";
import { CircleCheck, CircleHelp, CircleX, type LucideIcon, TriangleAlert } from "lucide-react";
import { type Status, statusTone } from "../../lib/status";
import { cn } from "../../lib/utils";
import { STATUS_LABEL, TONE_CHIP } from "./format";

const ICONS: Record<Status, LucideIcon> = { FAILED: CircleX, WARNING: TriangleAlert, UNKNOWN: CircleHelp, HEALTHY: CircleCheck };

export interface StatusBadgeProps {
  status: Status;
  className?: string;
}

/** A job's or a check's status: an icon and a word in the status color, so it never relies on color alone. */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  const Icon = ICONS[status];
  return (
    <Badge variant="outline" className={cn("h-[22px] gap-1 rounded-md px-1.5 font-medium", TONE_CHIP[statusTone(status)], className)}>
      <Icon aria-hidden="true" />
      {STATUS_LABEL[status]}
    </Badge>
  );
}
