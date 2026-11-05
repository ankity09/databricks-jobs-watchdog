import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Popover,
  PopoverAnchor,
  PopoverContent,
  Skeleton,
} from "@databricks/appkit-ui/react";
import {
  Background,
  BackgroundVariant,
  Controls,
  type EdgeChange,
  type EdgeTypes,
  MiniMap,
  type NodeTypes,
  Panel,
  Position,
  ReactFlow,
  useReactFlow,
} from "@xyflow/react";
import { Link2, Network, RotateCw, Server, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { impactOf } from "../../../../shared/joblist/impact";
import type { Change, JobListDocument, RuleIssue } from "../../../../shared/joblist/types";
import { useJobList } from "../../hooks/useJobList";
import { useLiveStatus } from "../../hooks/useLiveStatus";
import { useRefreshKey } from "../../hooks/useRefreshKey";
import { PageHeader } from "../../layout/PageHeader";
import { type Downstream, type GraphEdge, type GraphNode, buildGraph, downstreamOf, unlinkChange } from "../../lib/graph";
import { statusTone } from "../../lib/status";
import { cn } from "../../lib/utils";
import { AddLinkDialog, AddServiceDialog } from "./AddLinkDialog";
import { JobNode, LinkEdge, MapLegend, MapMarkers, SectionNode, ServiceNode } from "./MapElements";
import {
  type EdgeHighlight,
  type LinkFlowEdge,
  type MapFlowNode,
  type NodeHighlight,
  STATUS_LABEL,
  TONE_DOT,
  TONE_FILL,
  linkLabel,
  linkMeaning,
} from "./mapModel";

const NODE_TYPES: NodeTypes = { job: JobNode, service: ServiceNode, section: SectionNode };
const EDGE_TYPES: EdgeTypes = { link: LinkEdge };
const EMPTY_COPY = "No links yet. Add a link, or import a job list that has dependencies.";
const FIT_OPTIONS = { padding: 0.06, maxZoom: 1.1 };

/** React Flow's keyboard hints, without the delete key, which the map does not use. */
const ARIA_LABELS = {
  "edge.a11yDescription.default": "Press Enter to see this link and remove it, or Escape to close it.",
  "controls.ariaLabel": "Map controls",
  "controls.zoomIn.ariaLabel": "Zoom in",
  "controls.zoomOut.ariaLabel": "Zoom out",
  "controls.fitView.ariaLabel": "Fit the map to the screen",
  "minimap.ariaLabel": "Overview of the map",
};

/** Adding a link: pick the upstream box, then the downstream job, then the type. */
type LinkMode =
  | { step: "off" }
  | { step: "source" }
  | { step: "target"; source: GraphNode; hint: string | null }
  | { step: "type"; source: GraphNode; target: GraphNode };

type Problem = { kind: "conflict" } | { kind: "invalid"; message: string; issues: RuleIssue[] } | { kind: "failed"; message: string };

/** What a popover anchors to: anything with a screen rectangle. */
interface Measurable {
  getBoundingClientRect(): DOMRect;
}

function rect(x: number, y: number, width = 0, height = 0): DOMRect {
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({ x, y, width, height }) };
}

/** Where a link is on screen, so its menu opens next to it and follows a pan or zoom. */
function edgeRect(container: HTMLElement | null, edgeId: string, fallback: DOMRect): DOMRect {
  const selector = `.react-flow__edge[data-id="${edgeId.replace(/["\\]/g, "\\$&")}"]`;
  const element = container?.querySelector(selector);
  if (!element) return fallback;
  const box = element.getBoundingClientRect();
  return rect(box.x + box.width / 2, box.y + box.height / 2);
}

function nodeHighlight(box: GraphNode, link: LinkMode, selected: GraphNode | null, downstream: Downstream | null): NodeHighlight {
  switch (link.step) {
    case "source":
      return "candidate";
    case "target":
      if (box.id === link.source.id) return "source";
      return box.kind === "job" ? "candidate" : "unavailable";
    case "type":
      return box.id === link.source.id || box.id === link.target.id ? "source" : "dimmed";
    case "off":
      if (selected === null) return "none";
      if (box.id === selected.id) return "selected";
      return box.kind === "job" && downstream?.jobs.includes(box.name) ? "downstream" : "dimmed";
  }
}

function edgeHighlight(edge: GraphEdge, link: LinkMode, selected: GraphNode | null, downstream: Downstream | null): EdgeHighlight {
  if (link.step !== "off" || selected === null) return "none";
  return downstream?.edges.has(edge.id) ? "downstream" : "dimmed";
}

function toFlowNode(box: GraphNode, highlight: NodeHighlight, statusLoading: boolean): MapFlowNode {
  const middle = box.height / 2 - 2.5;
  return {
    id: box.id,
    type: box.kind,
    position: box.position,
    data: { box, highlight, statusLoading },
    // Fixed sizes and handles, the same as the rendered ones, so links draw before the boxes are measured.
    width: box.width,
    height: box.height,
    measured: { width: box.width, height: box.height },
    handles: [
      { type: "target", position: Position.Left, x: -2.5, y: middle, width: 5, height: 5 },
      { type: "source", position: Position.Right, x: box.width - 2.5, y: middle, width: 5, height: 5 },
    ],
    selectable: false,
    focusable: false,
    draggable: false,
    connectable: false,
  };
}

/** The heading above the jobs without links, when there are linked jobs above them. */
function sectionNode(nodes: GraphNode[]): MapFlowNode | null {
  const unlinked = nodes.filter((n) => !n.linked);
  if (unlinked.length === 0 || unlinked.length === nodes.length) return null;
  const top = Math.min(...unlinked.map((n) => n.position.y));
  return {
    id: "section:unlinked",
    type: "section",
    position: { x: 0, y: top - 28 },
    data: { text: "Jobs with no links" },
    width: 240,
    height: 16,
    measured: { width: 240, height: 16 },
    selectable: false,
    focusable: false,
    draggable: false,
    connectable: false,
  };
}

function minimapClass(node: MapFlowNode): string {
  if (node.type === "section") return "fill-transparent";
  if (node.type === "service") return "fill-secondary";
  return TONE_FILL[statusTone(node.data.box.status)];
}

/**
 * The dependency map: jobs and services as boxes, links as arrows, colored by
 * live status. Select a box to see what a failure there affects; add a link
 * by picking two boxes; click a link to remove it. Every edit saves one change
 * through useJobList, so conflicts and rule errors come back as alerts.
 */
export function DependencyMapPage() {
  const { state, loading, error, reload, save } = useJobList();
  const live = useLiveStatus();
  const { bump } = useRefreshKey();
  const document = state?.document ?? null;
  const graph = useMemo(() => (document ? buildGraph(document, live.byJob) : null), [document, live.byJob]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [link, setLink] = useState<LinkMode>({ step: "off" });
  const [serviceOpen, setServiceOpen] = useState(false);
  const [menuEdge, setMenuEdge] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  const mapRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<Measurable>({ getBoundingClientRect: () => rect(0, 0) });

  // A box removed by a save (a service whose last link went) drops out of the selection on its own.
  const selected = graph?.nodes.find((n) => n.id === selectedId) ?? null;
  const downstream = useMemo(() => (document && selected ? downstreamOf(document, selected) : null), [document, selected]);
  const menuLink = graph?.edges.find((e) => e.id === menuEdge) ?? null;
  const statusLoading = live.loading && live.byJob.size === 0;

  const runSave = useCallback(
    async (change: Change): Promise<boolean> => {
      setSaving(true);
      setProblem(null);
      setNotice(null);
      const outcome = await save(change);
      setSaving(false);
      if (outcome.ok) {
        setNotice(`Saved version ${outcome.result.version}: ${outcome.result.summary}.`);
        return true;
      }
      if (outcome.conflict) setProblem({ kind: "conflict" });
      else if (outcome.issues.length > 0) setProblem({ kind: "invalid", message: outcome.message, issues: outcome.issues });
      else setProblem({ kind: "failed", message: outcome.message });
      return false;
    },
    [save],
  );

  const openEdge = useCallback((edgeId: string) => {
    let last = rect(0, 0);
    anchor.current = {
      getBoundingClientRect: () => {
        last = edgeRect(mapRef.current, edgeId, last);
        return last;
      },
    };
    setMenuEdge(edgeId);
  }, []);

  // A box was clicked or pressed: select it, or pick it while adding a link.
  const activate = (box: GraphNode) => {
    setMenuEdge(null);
    if (link.step === "off") {
      setSelectedId((current) => (current === box.id ? null : box.id));
      return;
    }
    setLink((mode) => {
      if (mode.step === "source") return { step: "target", source: box, hint: null };
      if (mode.step !== "target") return mode;
      if (box.id === mode.source.id) return { step: "source" };
      if (box.kind !== "job") return { ...mode, hint: "A service can't depend on anything. Pick a job." };
      return { step: "type", source: mode.source, target: box };
    });
  };

  const flowNodes = useMemo<MapFlowNode[]>(() => {
    if (!graph) return [];
    const nodes = graph.nodes.map((box) => toFlowNode(box, nodeHighlight(box, link, selected, downstream), statusLoading));
    const section = sectionNode(graph.nodes);
    return section ? [...nodes, section] : nodes;
  }, [graph, link, selected, downstream, statusLoading]);

  // Changes when a save adds, removes or moves a box, so the view fits the new layout.
  const layoutKey = useMemo(() => (graph?.nodes ?? []).map((n) => `${n.id}@${n.position.x},${n.position.y}`).join("|"), [graph]);

  const flowEdges = useMemo<LinkFlowEdge[]>(
    () =>
      (graph?.edges ?? []).map((edge) => {
        const highlight = edgeHighlight(edge, link, selected, downstream);
        return {
          id: edge.id,
          type: "link",
          source: edge.source,
          target: edge.target,
          data: { link: edge, highlight },
          selected: edge.id === menuEdge,
          selectable: link.step === "off",
          focusable: true,
          ariaLabel: linkLabel(edge),
          ariaRole: "button",
          interactionWidth: 18,
          zIndex: highlight === "downstream" || edge.id === menuEdge ? 1 : 0,
        };
      }),
    [graph, link, selected, downstream, menuEdge],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<LinkFlowEdge>[]) => {
      // Enter on a focused link selects it; open its menu, as a click does.
      for (const change of changes) if (change.type === "select" && change.selected && link.step === "off") openEdge(change.id);
    },
    [link.step, openEdge],
  );

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (link.step !== "off") setLink({ step: "off" });
    else setSelectedId(null);
  };

  const removeLink = (edgeId: string) => {
    void runSave(unlinkChange(edgeId)).then(() => setMenuEdge(null));
  };

  const jobCount = document?.jobs.length ?? 0;
  const canLink = graph !== null && jobCount > 0 && graph.nodes.length >= 2;
  const headerActions = (
    <>
      <Button
        variant={link.step === "off" ? "outline" : "default"}
        size="sm"
        aria-pressed={link.step !== "off"}
        disabled={!canLink || saving}
        onClick={() => {
          setMenuEdge(null);
          setSelectedId(null);
          setLink((mode) => (mode.step === "off" ? { step: "source" } : { step: "off" }));
        }}
      >
        <Link2 aria-hidden="true" />
        Add link
      </Button>
      <Button variant="outline" size="sm" disabled={jobCount === 0 || saving} onClick={() => setServiceOpen(true)}>
        <Server aria-hidden="true" />
        Add service
      </Button>
    </>
  );

  let body: ReactNode;
  if (state === null && error === null) {
    body = <Skeleton className="min-h-[520px] w-full flex-1 rounded-md" />;
  } else if (state === null) {
    body = (
      <Alert variant="destructive">
        <AlertTitle>Could not load the job list.</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>{error?.message}</span>
          <Button variant="outline" size="sm" className="h-7 gap-1.5" disabled={loading} onClick={() => void reload()}>
            <RotateCw className="size-3.5" aria-hidden="true" />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (jobCount === 0 || graph === null) {
    body = (
      <Empty className="flex-none border border-dashed border-border bg-muted/40 md:py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Network aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Nothing on the map yet</EmptyTitle>
          <EmptyDescription>{EMPTY_COPY}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline" size="sm">
            <Link to="/jobs">Go to the job list</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  } else {
    body = (
      <>
        {graph.edges.length === 0 && link.step === "off" ? (
          <p className="-mt-1 flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            <Network className="size-4 shrink-0" aria-hidden="true" />
            {EMPTY_COPY}
          </p>
        ) : null}
        <div ref={mapRef} className="relative min-h-[520px] flex-1 overflow-hidden rounded-md border border-border bg-muted" onKeyDown={onKeyDown}>
          <MapMarkers />
          <div className="absolute inset-0">
            <ReactFlow<MapFlowNode, LinkFlowEdge>
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              // Also what gives the boxes pointer events: React Flow turns them off on a node that is neither selectable nor clickable.
              onNodeClick={(_event, node) => {
                if (node.type !== "section") activate(node.data.box);
              }}
              onEdgeClick={(_event, edge) => {
                if (link.step === "off") openEdge(edge.id);
              }}
              onEdgesChange={onEdgesChange}
              onPaneClick={() => {
                setMenuEdge(null);
                if (link.step === "off") setSelectedId(null);
              }}
              nodesDraggable={false}
              nodesConnectable={false}
              nodesFocusable={false}
              edgesFocusable
              deleteKeyCode={null}
              selectionKeyCode={null}
              multiSelectionKeyCode={null}
              fitView
              fitViewOptions={FIT_OPTIONS}
              minZoom={0.2}
              maxZoom={1.75}
              colorMode="light"
              // React Flow asks that only Pro subscribers hide its attribution; it sits between the controls and the minimap.
              attributionPosition="bottom-center"
              ariaLabelConfig={ARIA_LABELS}
              aria-label="Dependency map"
              className="[--xy-edge-stroke-selected:var(--primary)]"
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--input)" bgColor="var(--muted)" />
              <Controls
                showInteractive={false}
                position="bottom-left"
                className="overflow-hidden rounded-md border border-border bg-card shadow-xs [&_.react-flow__controls-button]:border-b [&_.react-flow__controls-button]:border-border [&_.react-flow__controls-button]:bg-card [&_.react-flow__controls-button]:text-foreground [&_.react-flow__controls-button:hover]:bg-muted [&_.react-flow__controls-button:last-child]:border-b-0"
              />
              <MiniMap<MapFlowNode>
                pannable
                zoomable
                position="bottom-right"
                nodeClassName={minimapClass}
                nodeBorderRadius={4}
                bgColor="var(--card)"
                maskColor="color-mix(in srgb, var(--muted) 75%, transparent)"
                maskStrokeColor="var(--border)"
                className="overflow-hidden rounded-md border border-border shadow-xs"
              />
              <Refit layoutKey={layoutKey} />
              <Panel position="top-left">
                <MapLegend />
              </Panel>
              {/* Adding a link clears the selection, so the banner takes the inspector's corner and never covers the legend. */}
              {link.step !== "off" ? (
                <Panel position="top-right">
                  <LinkBanner mode={link} onCancel={() => setLink({ step: "off" })} />
                </Panel>
              ) : null}
              {selected && document ? (
                <Panel position="top-right">
                  <Inspector
                    box={selected}
                    document={document}
                    downstream={downstream}
                    links={graph.edges.filter((e) => e.source === selected.id || e.target === selected.id)}
                    saving={saving}
                    onRemove={removeLink}
                    onClose={() => setSelectedId(null)}
                  />
                </Panel>
              ) : null}
            </ReactFlow>
          </div>
          <LinkMenu link={menuLink} anchor={anchor} saving={saving} onRemove={removeLink} onClose={() => setMenuEdge(null)} />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Dependency map"
        description="How the monitored jobs depend on each other and on services. Select a box to see what a failure there affects."
        actions={headerActions}
      />
      {problem ? <SaveProblem problem={problem} onReload={() => void reload().then(() => setProblem(null))} /> : null}
      {notice ? (
        <p role="status" className="-mt-2 font-mono text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {state !== null && error !== null ? (
        <Alert variant="destructive">
          <AlertTitle>Could not reload the job list.</AlertTitle>
          <AlertDescription>{error.message} The map shows the version loaded before.</AlertDescription>
        </Alert>
      ) : null}
      {live.error && graph ? (
        <p className="-mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          Live status is unavailable, so every job shows Unknown. {live.error}
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs" onClick={() => bump()}>
            <RotateCw className="size-3" aria-hidden="true" />
            Retry
          </Button>
        </p>
      ) : null}
      {body}
      {document ? (
        <>
          <AddLinkDialog
            open={link.step === "type"}
            onOpenChange={(open) => {
              if (!open && !saving) setLink({ step: "off" });
            }}
            source={link.step === "type" ? { kind: link.source.kind, name: link.source.name } : null}
            target={link.step === "type" ? { kind: link.target.kind, name: link.target.name } : null}
            document={document}
            saving={saving}
            onSave={(change) => void runSave(change).then(() => setLink({ step: "off" }))}
          />
          <AddServiceDialog
            open={serviceOpen}
            onOpenChange={(open) => {
              if (!saving) setServiceOpen(open);
            }}
            document={document}
            defaultJob={selected?.kind === "job" ? selected.name : null}
            saving={saving}
            onSave={(change) => void runSave(change).then(() => setServiceOpen(false))}
          />
        </>
      ) : null}
    </>
  );
}

interface RefitProps {
  layoutKey: string;
}

/** Fits the view again when the boxes change place, after a save adds or removes one. The first fit is the fitView prop's. */
function Refit({ layoutKey }: RefitProps) {
  const { fitView } = useReactFlow();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // After React Flow has taken the new nodes into its store.
    const frame = window.requestAnimationFrame(() => void fitView(FIT_OPTIONS));
    return () => window.cancelAnimationFrame(frame);
  }, [layoutKey, fitView]);
  return null;
}

interface LinkBannerProps {
  mode: Exclude<LinkMode, { step: "off" }>;
  onCancel: () => void;
}

/** The step of adding a link, above the map, with Cancel. */
function LinkBanner({ mode, onCancel }: LinkBannerProps) {
  let text: string;
  if (mode.step === "source") text = "Pick the upstream job or service.";
  else if (mode.step === "target") text = mode.hint ?? `Now pick the job that depends on ${mode.source.name}.`;
  else text = `Choose how ${mode.target.name} depends on ${mode.source.name}.`;
  return (
    <div
      className="flex max-w-md items-center gap-3 rounded-md border border-primary/40 bg-card py-1.5 pr-1.5 pl-3 text-sm shadow-sm"
      role="status"
      aria-live="polite"
    >
      <span className="size-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
      <span className="min-w-0 break-words">{text}</span>
      <Button variant="ghost" size="sm" className="h-7" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

interface LinkMenuProps {
  link: GraphEdge | null;
  anchor: RefObject<Measurable>;
  saving: boolean;
  onRemove: (edgeId: string) => void;
  onClose: () => void;
}

/** The menu that opens on a link: what it means, and Remove link. */
function LinkMenu({ link, anchor, saving, onRemove, onClose }: LinkMenuProps) {
  const headingId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <Popover
      open={link !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverAnchor virtualRef={anchor} />
      {link ? (
        <PopoverContent
          ref={contentRef}
          aria-labelledby={headingId}
          tabIndex={-1}
          // Focus the menu itself, not its first button: Enter or Space opened it, and the same key press would press that button.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
          }}
          side="top"
          sideOffset={10}
          updatePositionStrategy="always"
          className="w-80 p-3 outline-none"
        >
          <p id={headingId} className="text-sm font-medium">
            <span className="font-mono text-[12px]">{link.dependency.job_name}</span> depends on{" "}
            <span className="font-mono text-[12px]">{link.dependency.depends_on}</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{linkMeaning(link)}</p>
          {link.dependency.notes ? <p className="mt-2 text-xs text-foreground">{link.dependency.notes}</p> : null}
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
            <Button variant="destructive" size="sm" disabled={saving} onClick={() => onRemove(link.id)}>
              {saving ? "Removing" : "Remove link"}
            </Button>
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

interface InspectorProps {
  box: GraphNode;
  document: JobListDocument;
  downstream: Downstream | null;
  links: GraphEdge[];
  saving: boolean;
  onRemove: (edgeId: string) => void;
  onClose: () => void;
}

function affectsText(count: number): string {
  if (count === 0) return "A failure here affects no other job.";
  return count === 1 ? "A failure here affects 1 job." : `A failure here affects ${count} jobs.`;
}

/** The selected box: its status, what a failure there affects, and its links, each with Remove. */
function Inspector({ box, document, downstream, links, saving, onRemove, onClose }: InspectorProps) {
  const affected = downstream?.jobs ?? [];
  const parent = box.kind === "job" ? impactOf(document, box.name).parentJob : null;
  const tone = statusTone(box.status);
  return (
    <section
      aria-label={box.name}
      className="flex max-h-[min(60svh,520px)] w-80 flex-col overflow-hidden rounded-md border border-border bg-card text-sm shadow-sm"
    >
      <header className="flex items-start gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[13px] font-medium" title={box.name}>
            {box.name}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {box.kind === "service" ? (
              "Service"
            ) : (
              <>
                <span className={cn("size-1.5 rounded-full", TONE_DOT[tone])} aria-hidden="true" />
                {STATUS_LABEL[box.status]}
                {box.active ? null : " · Switched off"}
              </>
            )}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Clear the selection" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="flex flex-col gap-3 overflow-auto px-3 py-2.5">
        {parent ? (
          <p className="text-xs text-muted-foreground">
            Child job of <span className="font-mono text-foreground">{parent}</span>
          </p>
        ) : null}
        <div>
          <p className="text-xs font-medium text-foreground">{affectsText(affected.length)}</p>
          {affected.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-0.5">
              {affected.map((name) => (
                <li key={name} className="truncate font-mono text-[11px] text-muted-foreground" title={name}>
                  {name}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {links.length > 0 ? (
          <div>
            <p className="text-xs font-medium text-foreground">Links</p>
            <ul className="mt-1 flex flex-col">
              {links.map((edge) => {
                const upstream = edge.target === box.id;
                const other = upstream ? edge.dependency.depends_on : edge.dependency.job_name;
                return (
                  <li key={edge.id} className="flex items-center gap-2 border-b border-border/60 py-1 last:border-b-0">
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={linkLabel(edge)}>
                      {upstream ? "Needs " : "Needed by "}
                      <span className="font-mono text-foreground">{other}</span>
                      {edge.type === "child_job" ? " (child job)" : edge.type === "service" ? " (service)" : null}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-xs text-muted-foreground hover:text-destructive"
                      disabled={saving}
                      aria-label={`Remove the link: ${linkLabel(edge)}`}
                      onClick={() => onRemove(edge.id)}
                    >
                      Remove
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

interface SaveProblemProps {
  problem: Problem;
  onReload: () => void;
}

/** A save the server refused: a conflict with Reload, the rule issues, or another failure. */
function SaveProblem({ problem, onReload }: SaveProblemProps) {
  if (problem.kind === "conflict") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Someone else changed the job list since you opened it.</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>Reload to see their change, then try again.</span>
          <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={onReload}>
            <RotateCw className="size-3.5" aria-hidden="true" />
            Reload
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (problem.kind === "invalid") {
    return (
      <Alert variant="destructive">
        <AlertTitle>{problem.message}</AlertTitle>
        <AlertDescription>
          <ul className="list-disc pl-4">
            {problem.issues.map((issue) => (
              <li key={`${issue.path}:${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <AlertTitle>Could not save the change.</AlertTitle>
      <AlertDescription>{problem.message}</AlertDescription>
    </Alert>
  );
}
