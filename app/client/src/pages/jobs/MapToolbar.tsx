import { Button, Switch, ToggleGroup, ToggleGroupItem, Tooltip, TooltipContent, TooltipTrigger } from "@databricks/appkit-ui/react";
import { type FitViewOptions, useReactFlow, useStore } from "@xyflow/react";
import { Maximize, Minus, MoveDown, MoveRight, Plus } from "lucide-react";
import type { ReactElement } from "react";
import type { LayoutDirection } from "../../lib/graph";
import { cn } from "../../lib/utils";
import { viewDuration } from "./mapModel";

interface ToolTipProps {
  label: string;
  children: ReactElement;
}

/** The name of an icon-only control, shown on hover and focus. */
function ToolTip({ label, children }: ToolTipProps) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function Divider() {
  return <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />;
}

const ICON_BUTTON = "size-7 rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40";

export interface MapToolbarProps {
  direction: LayoutDirection;
  onDirectionChange: (direction: LayoutDirection) => void;
  showServices: boolean;
  onShowServicesChange: (show: boolean) => void;
  /** The fit the Fit button makes: clear of the overlays (fitOptions). */
  fitOptions: FitViewOptions;
  className?: string;
}

/**
 * The map's floating toolbar, as on a designer canvas: zoom out, the zoom,
 * zoom in, fit to screen, the layout direction and the services switch. It
 * reads and moves the view through React Flow's store, so it sits anywhere
 * inside the map's ReactFlowProvider.
 */
export function MapToolbar({ direction, onDirectionChange, showServices, onShowServicesChange, fitOptions, className }: MapToolbarProps) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);
  const minZoom = useStore((state) => state.minZoom);
  const maxZoom = useStore((state) => state.maxZoom);
  return (
    <div
      role="group"
      aria-label="Map view"
      className={cn(
        "flex h-9 items-center rounded-full border border-border bg-card px-1 text-foreground shadow-[0_1px_2px_rgb(27_49_57/0.06),0_2px_8px_rgb(27_49_57/0.06)]",
        className,
      )}
    >
      <ToolTip label="Zoom out">
        <Button variant="ghost" size="icon-sm" aria-label="Zoom out" className={ICON_BUTTON} disabled={zoom <= minZoom} onClick={() => void zoomOut({ duration: viewDuration() })}>
          <Minus aria-hidden="true" />
        </Button>
      </ToolTip>
      <span className="w-11 text-center font-mono text-[11px] text-muted-foreground tabular-nums">
        <span className="sr-only">Zoom </span>
        {Math.round(zoom * 100)}%
      </span>
      <ToolTip label="Zoom in">
        <Button variant="ghost" size="icon-sm" aria-label="Zoom in" className={ICON_BUTTON} disabled={zoom >= maxZoom} onClick={() => void zoomIn({ duration: viewDuration() })}>
          <Plus aria-hidden="true" />
        </Button>
      </ToolTip>
      <Divider />
      <ToolTip label="Fit to screen">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Fit the map to the screen"
          className={ICON_BUTTON}
          onClick={() => void fitView({ ...fitOptions, duration: viewDuration() })}
        >
          <Maximize aria-hidden="true" />
        </Button>
      </ToolTip>
      <Divider />
      <ToggleGroup
        type="single"
        value={direction}
        aria-label="Layout direction"
        className="gap-0.5"
        // Pressing the chosen direction again would leave none: keep it.
        onValueChange={(value) => {
          if (value === "LR" || value === "TB") onDirectionChange(value);
        }}
      >
        <ToolTip label="Left to right">
          <ToggleGroupItem value="LR" aria-label="Left to right" className={cn(ICON_BUTTON, "min-w-0 px-0 data-[state=on]:bg-secondary data-[state=on]:text-foreground")}>
            <MoveRight aria-hidden="true" />
          </ToggleGroupItem>
        </ToolTip>
        <ToolTip label="Top to bottom">
          <ToggleGroupItem value="TB" aria-label="Top to bottom" className={cn(ICON_BUTTON, "min-w-0 px-0 data-[state=on]:bg-secondary data-[state=on]:text-foreground")}>
            <MoveDown aria-hidden="true" />
          </ToggleGroupItem>
        </ToolTip>
      </ToggleGroup>
      <Divider />
      <label className="flex cursor-pointer items-center gap-2 pr-2.5 pl-1.5 text-xs font-medium text-foreground select-none">
        <Switch checked={showServices} aria-label="Show services" className="h-4 w-7 [&_[data-slot=switch-thumb]]:size-3.5" onCheckedChange={onShowServicesChange} />
        Services
      </label>
    </div>
  );
}
