import { Button, Switch, ToggleGroup, ToggleGroupItem, Tooltip, TooltipContent, TooltipTrigger } from "@databricks/appkit-ui/react";
import { type FitViewOptions, useReactFlow, useStore } from "@xyflow/react";
import { Maximize, Minus, MoveDown, MoveRight, Plus, Undo2 } from "lucide-react";
import { type ReactElement, useRef } from "react";
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

const UNAVAILABLE = "aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground";
const ICON_BUTTON = `size-7 rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground ${UNAVAILABLE}`;
const TEXT_BUTTON = `h-7 gap-1 rounded-full px-2.5 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground ${UNAVAILABLE}`;

/** One zoom step, the same as React Flow's own zoom in and zoom out. */
const STEP = 1.2;
/** How long past its glide a zoom target stays good: a fit, a wheel, a drag or a slide can cut the glide short. */
const TARGET_SLACK_MS = 80;

export interface MapToolbarProps {
  direction: LayoutDirection;
  onDirectionChange: (direction: LayoutDirection) => void;
  showServices: boolean;
  onShowServicesChange: (show: boolean) => void;
  /** The fit the Fit button makes: clear of the overlays (fitOptions). */
  fitOptions: FitViewOptions;
  /** Called when the Fit button's fit has finished, so the map can slide a selection clear of the side panel. */
  onFitted?: () => void;
  /** Tidy up: puts the automatic layout back for this direction, for everyone. */
  onTidy: () => void;
  /** True when the direction has no saved positions, or they have not loaded. */
  tidyDisabled: boolean;
  onUndo: () => void;
  undoDisabled: boolean;
  /** What Undo would undo, such as "Undo: move 2 boxes", or "Nothing to undo". */
  undoLabel: string;
  className?: string;
}

/**
 * The map's floating toolbar, as on a designer canvas: zoom out, the zoom,
 * zoom in, fit to screen, the layout direction, the services switch, Tidy up
 * and Undo. It reads and moves the view through React Flow's store, so it
 * sits anywhere inside the map's ReactFlowProvider.
 */
export function MapToolbar({
  direction,
  onDirectionChange,
  showServices,
  onShowServicesChange,
  fitOptions,
  onFitted,
  onTidy,
  tidyDisabled,
  onUndo,
  undoDisabled,
  undoLabel,
  className,
}: MapToolbarProps) {
  const { zoomTo, fitView } = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);
  const minZoom = useStore((state) => state.minZoom);
  const maxZoom = useStore((state) => state.maxZoom);
  const atMin = zoom <= minZoom;
  const atMax = zoom >= maxZoom;
  // Where the zoom is gliding to, until when: a click during the glide takes its step from there, so two quick
  // clicks are two steps. After that the target is stale, and the step starts from the zoom on screen.
  const target = useRef<{ zoom: number; until: number } | null>(null);
  const zoomBy = (factor: number) => {
    // At a limit the button says so (aria-disabled) and keeps focus; a press does nothing.
    if (factor < 1 ? atMin : atMax) return;
    const duration = viewDuration();
    const pending = target.current !== null && Date.now() < target.current.until ? target.current.zoom : null;
    const next = Math.min(maxZoom, Math.max(minZoom, (pending ?? zoom) * factor));
    const step = { zoom: next, until: Date.now() + duration + TARGET_SLACK_MS };
    target.current = step;
    void zoomTo(next, { duration }).then(() => {
      if (target.current === step) target.current = null;
    });
  };
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
        <Button variant="ghost" size="icon-sm" aria-label="Zoom out" aria-disabled={atMin || undefined} className={ICON_BUTTON} onClick={() => zoomBy(1 / STEP)}>
          <Minus aria-hidden="true" />
        </Button>
      </ToolTip>
      <span className="w-11 text-center font-mono text-[11px] text-muted-foreground tabular-nums">
        <span className="sr-only">Zoom </span>
        {Math.round(zoom * 100)}%
      </span>
      <ToolTip label="Zoom in">
        <Button variant="ghost" size="icon-sm" aria-label="Zoom in" aria-disabled={atMax || undefined} className={ICON_BUTTON} onClick={() => zoomBy(STEP)}>
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
          onClick={() => void fitView({ ...fitOptions, duration: viewDuration() }).then(() => onFitted?.())}
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
      <Divider />
      {/* Unavailable through aria-disabled, as at the zoom limits: a button that goes off as it is pressed keeps focus. */}
      <ToolTip label="Put the automatic layout back, for everyone">
        <Button
          variant="ghost"
          size="sm"
          aria-disabled={tidyDisabled || undefined}
          className={TEXT_BUTTON}
          onClick={() => {
            if (!tidyDisabled) onTidy();
          }}
        >
          Tidy up
        </Button>
      </ToolTip>
      <ToolTip label={undoLabel}>
        <Button
          variant="ghost"
          size="sm"
          aria-label={undoLabel}
          aria-disabled={undoDisabled || undefined}
          className={cn(TEXT_BUTTON, "mr-0.5 pl-2")}
          onClick={() => {
            if (!undoDisabled) onUndo();
          }}
        >
          <Undo2 className="size-3.5" aria-hidden="true" />
          Undo
        </Button>
      </ToolTip>
    </div>
  );
}
