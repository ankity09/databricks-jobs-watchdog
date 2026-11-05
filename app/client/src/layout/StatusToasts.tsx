import { ResourceStatusIndicator } from "@databricks/appkit-ui/react";
import { CircleCheck, Hourglass, Info, OctagonX, TriangleAlert } from "lucide-react";

/**
 * appkit-ui's toast icons, except loading: a still hourglass instead of the
 * spinning loader. Passing `icons` replaces the whole set, so all five are here.
 */
const ICONS = {
  success: <CircleCheck className="size-4" aria-hidden="true" />,
  info: <Info className="size-4" aria-hidden="true" />,
  warning: <TriangleAlert className="size-4" aria-hidden="true" />,
  error: <OctagonX className="size-4" aria-hidden="true" />,
  loading: <Hourglass className="size-4 text-muted-foreground" aria-hidden="true" />,
};

/**
 * The toast that says a resource is getting ready (the SQL warehouse starting,
 * for one), for the whole page. Light, like the rest of the app.
 */
export function StatusToasts() {
  return <ResourceStatusIndicator theme="light" icons={ICONS} />;
}
