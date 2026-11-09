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
  type EdgeChange,
  type EdgeTypes,
  MiniMap,
  type NodeTypes,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { CircleAlert, Link2, Network, RotateCw, Server } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";
import type { Change, JobEntry, RuleIssue } from "../../../../shared/joblist/types";
import { type ReloadJobList, type SaveOutcome, useJobList } from "../../hooks/useJobList";
import { useLiveStatus } from "../../hooks/useLiveStatus";
import { useRefreshKey } from "../../hooks/useRefreshKey";
import { PageHeader } from "../../layout/PageHeader";
import {
  type Downstream,
  type GraphEdge,
  type GraphNode,
  type LayoutDirection,
  buildEdges,
  buildGraph,
  downstreamOf,
  unlinkChange,
} from "../../lib/graph";
import type { EntryJobIds } from "../../lib/picker";
import { statusTone } from "../../lib/status";
import { AddLinkDialog, AddServiceDialog } from "./AddLinkDialog";
import { ConfigBanner } from "./ConfigBanner";
import { JobEditorSheet } from "./JobEditorSheet";
import { type Upstream, affectsText, impactSteps, upstreamOf } from "./mapChain";
import { JobNode, LinkEdge, MapLegend, MapMarkers, SectionNode, ServiceNode } from "./MapElements";
import { type CardFacts, cardFacts } from "./mapFacts";
import {
  type EdgeHighlight,
  type LinkFlowEdge,
  type MapFlowNode,
  MINIMAP_FROM,
  type NodeHighlight,
  OVERLAY,
  PANEL_CLEAR_FROM,
  TONE_FILL,
  fitOptions,
  linkLabel,
  linkMeaning,
  viewDuration,
} from "./mapModel";
import { MapSidePanel } from "./MapSidePanel";
import { MapToolbar, type MapToolbarProps } from "./MapToolbar";
import { PatternMatches } from "./PatternMatches";
import { QueryProblemLine } from "./QueryProblemLine";
import { ReloadButton } from "./ReloadButton";
import type { ReturnFocus } from "./returnFocus";

const NODE_TYPES: NodeTypes = { job: JobNode, service: ServiceNode, section: SectionNode };
const EDGE_TYPES: EdgeTypes = { link: LinkEdge };
const EMPTY_COPY = "No links yet. Add a link, or import a job list that has dependencies.";
/** The ports' size: the static handles below match the rendered ones. */
const PORT = 8;
/** The first fit, before the canvas's width is known: clear of the minimap too, which a wide canvas shows. */
const FIRST_FIT = fitOptions(MINIMAP_FROM, false);

/** React Flow's keyboard hints, without the delete key, which the map does not use. */
const ARIA_LABELS = {
  "edge.a11yDescription.default": "Press Enter to see this link and remove it, or Escape to close it.",
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

/** A link's or a box's element on the map, by the id React Flow puts in data-id. */
function mapElement(container: HTMLElement | null, kind: "edge" | "node", id: string): HTMLElement | SVGElement | null {
  return container?.querySelector<HTMLElement | SVGElement>(`.react-flow__${kind}[data-id="${id.replace(/["\\]/g, "\\$&")}"]`) ?? null;
}

/** Where a link is on screen, so its menu opens next to it and follows a pan or zoom. */
function edgeRect(container: HTMLElement | null, edgeId: string, fallback: DOMRect): DOMRect {
  const element = mapElement(container, "edge", edgeId);
  if (!element) return fallback;
  const box = element.getBoundingClientRect();
  return rect(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Where focus goes when what had it goes away: a link (its menu closed), a box,
 * the side panel, or the map itself. Radix gives focus back only to a trigger,
 * and the map's menu and panel open without one.
 */
type FocusTarget = { kind: "link" | "box"; id: string } | { kind: "panel" } | { kind: "map" };

function boxButton(container: HTMLElement | null, id: string): HTMLButtonElement | null {
  return mapElement(container, "node", id)?.querySelector("button") ?? null;
}

function focusOn(container: HTMLElement | null, panel: HTMLElement | null, target: FocusTarget): void {
  let element: HTMLElement | SVGElement | null = null;
  if (target.kind === "link") element = mapElement(container, "edge", target.id);
  else if (target.kind === "box") element = boxButton(container, target.id);
  else if (target.kind === "panel") element = panel;
  (element ?? container)?.focus();
}

type Graph = ReturnType<typeof buildGraph>;

/**
 * Where focus goes after a link is removed: the box at its upstream end, else
 * the one at its downstream end, whichever stays on the map without the link
 * (a service, or a job that is not in the job list, goes with its last link).
 */
function focusAfterRemoving(graph: Graph, edgeId: string): FocusTarget {
  const edge = graph.edges.find((e) => e.id === edgeId);
  const id = edge ? [edge.source, edge.target].find((end) => staysWithout(graph, edgeId, end)) : undefined;
  return id === undefined ? { kind: "map" } : { kind: "box", id };
}

/** Whether a box stays on the map without a link: a job in the job list does, anything else only while another link has it. */
function staysWithout(graph: Graph, edgeId: string, nodeId: string): boolean {
  if (graph.nodes.some((n) => n.id === nodeId && n.kind === "job" && n.listed)) return true;
  return graph.edges.some((e) => e.id !== edgeId && (e.source === nodeId || e.target === nodeId));
}

/** The selection's chain: what a failure there affects (downstream) and what it depends on (upstream). */
interface Chain {
  downstream: Downstream;
  upstream: Upstream;
}

function nodeHighlight(box: GraphNode, link: LinkMode, selected: GraphNode | null, chain: Chain | null): NodeHighlight {
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
      // A child job's parent is both upstream and affected: affected wins, as on the scan's impact.
      if (box.kind === "job" && chain?.downstream.jobs.includes(box.name)) return "downstream";
      return chain?.upstream.nodes.has(box.id) ? "upstream" : "dimmed";
  }
}

function edgeHighlight(edge: GraphEdge, link: LinkMode, selected: GraphNode | null, chain: Chain | null): EdgeHighlight {
  if (link.step !== "off" || selected === null) return "none";
  if (chain?.downstream.edges.has(edge.id)) return "downstream";
  return chain?.upstream.edges.has(edge.id) ? "upstream" : "dimmed";
}

/** The ports' bounds, the same as the rendered handles, so links draw before the cards are measured. */
function portsOf(box: GraphNode, direction: LayoutDirection): NonNullable<MapFlowNode["handles"]> {
  const half = PORT / 2;
  const size = { width: PORT, height: PORT };
  if (direction === "LR") {
    return [
      { type: "target", position: Position.Left, x: -half, y: box.height / 2 - half, ...size },
      { type: "source", position: Position.Right, x: box.width - half, y: box.height / 2 - half, ...size },
    ];
  }
  return [
    { type: "target", position: Position.Top, x: box.width / 2 - half, y: -half, ...size },
    { type: "source", position: Position.Bottom, x: box.width / 2 - half, y: box.height - half, ...size },
  ];
}

function toFlowNode(box: GraphNode, highlight: NodeHighlight, statusLoading: boolean, direction: LayoutDirection, facts: CardFacts | null): MapFlowNode {
  return {
    id: box.id,
    type: box.kind,
    position: box.position,
    data: { box, highlight, statusLoading, direction, facts },
    // The group the ports' hover classes look at.
    className: "group",
    // Fixed sizes and handles, the same as the rendered ones, so links draw before the cards are measured.
    width: box.width,
    height: box.height,
    measured: { width: box.width, height: box.height },
    handles: portsOf(box, direction),
    selectable: false,
    focusable: false,
    draggable: false,
    connectable: false,
  };
}

/** The group frame's room around its cards: its label sits in the top band. */
const GROUP_PAD = { x: 16, top: 40, bottom: 16 } as const;

/** The labeled group around the jobs without links, when there are linked jobs above them. */
function sectionNode(nodes: GraphNode[]): MapFlowNode | null {
  const unlinked = nodes.filter((n) => !n.linked);
  if (unlinked.length === 0 || unlinked.length === nodes.length) return null;
  const left = Math.min(...unlinked.map((n) => n.position.x)) - GROUP_PAD.x;
  const top = Math.min(...unlinked.map((n) => n.position.y)) - GROUP_PAD.top;
  const width = Math.max(...unlinked.map((n) => n.position.x + n.width)) + GROUP_PAD.x - left;
  const height = Math.max(...unlinked.map((n) => n.position.y + n.height)) + GROUP_PAD.bottom - top;
  return {
    id: "section:unlinked",
    type: "section",
    position: { x: left, y: top },
    data: { title: "Not linked yet", count: unlinked.length },
    width,
    height,
    measured: { width, height },
    selectable: false,
    focusable: false,
    draggable: false,
    connectable: false,
  };
}

function minimapClass(node: MapFlowNode): string {
  if (node.type === "section") return "fill-transparent";
  if (node.type === "service") return "fill-muted-foreground/25";
  return TONE_FILL[statusTone(node.data.box.status)];
}

/** Under the editor's pattern fields, as on the Job list: which of the region's jobs the patterns match. */
function patternPreview(pattern: string, exclude: string, jobIds: EntryJobIds): ReactNode {
  return <PatternMatches pattern={pattern} exclude={exclude} jobIds={jobIds} />;
}

/**
 * The dependency map, as a designer canvas: jobs and services as cards on a
 * dot grid, links as arrows, colored by live status. Select a card to see what
 * a failure there affects downstream and what it depends on upstream, with its
 * settings in the side panel; add a link by picking two cards; click a link to
 * remove it. Every edit saves one change through useJobList, so conflicts and
 * rule errors come back as alerts.
 */
export function DependencyMapPage() {
  const { state, loading, error, reload, save } = useJobList();
  const live = useLiveStatus();
  const { bump } = useRefreshKey();
  const document = state?.document ?? null;
  // The version on screen: a change made on the map is made from it.
  const version = state?.version ?? null;
  const [direction, setDirection] = useState<LayoutDirection>("LR");
  const [showServices, setShowServices] = useState(true);
  // Laid out again only when the list, the statuses, the direction or the services switch change, never on a selection.
  const graph = useMemo(
    () => (document ? buildGraph(document, live.byJob, { direction, services: showServices }) : null),
    [document, live.byJob, direction, showServices],
  );
  // Every link, the hidden service links too: the side panel lists a job's real links whatever the map shows.
  const allEdges = useMemo(() => (document ? buildEdges(document) : []), [document]);
  const facts = useMemo(() => (document ? cardFacts(document) : null), [document]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [link, setLink] = useState<LinkMode>({ step: "off" });
  const [serviceOpen, setServiceOpen] = useState(false);
  const [menuEdge, setMenuEdge] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  // Said politely when a box is selected, for people who select one from the keyboard; focus stays on the box.
  const [announcement, setAnnouncement] = useState("");

  const mapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  // The card of the job being edited, kept when Edit job is pressed: focus goes there if the panel closed meanwhile.
  const editedCardRef = useRef<HTMLElement | null>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const addLinkRef = useRef<HTMLButtonElement>(null);
  const addServiceRef = useRef<HTMLButtonElement>(null);
  const anchor = useRef<Measurable>({ getBoundingClientRect: () => rect(0, 0) });
  const [refocus, setRefocus] = useState<FocusTarget | null>(null);

  // A box removed by a save (a service whose last link went), or hidden by the services switch, drops out of the selection on its own.
  const selected = graph?.nodes.find((n) => n.id === selectedId) ?? null;
  const chain = useMemo<Chain | null>(
    () => (document && graph && selected ? { downstream: downstreamOf(document, selected), upstream: upstreamOf(graph.edges, selected.id) } : null),
    [document, graph, selected],
  );
  const steps = useMemo(() => (document && selected ? impactSteps(document, selected) : null), [document, selected]);
  const menuLink = graph?.edges.find((e) => e.id === menuEdge) ?? null;
  const statusLoading = live.loading && live.byJob.size === 0;
  const panelOpen = selected !== null && link.step === "off";
  const editingJob = editing !== null ? document?.jobs.find((job) => job.job_name === editing) : undefined;
  // When the editor closes: Edit job, else the job's card (the panel closed meanwhile), else the map.
  const editorReturnFocus = useMemo<ReturnFocus>(() => [editRef, editedCardRef, mapRef], []);

  // Moves focus on when a change takes away what had it.
  useEffect(() => {
    if (refocus === null) return;
    // After React Flow has drawn the change.
    const frame = window.requestAnimationFrame(() => {
      focusOn(mapRef.current, panelRef.current, refocus);
      setRefocus(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [refocus]);

  /** Saves one change made on the map; `baseVersion` is the version on screen when it was made. */
  const runSave = useCallback(
    async (change: Change, baseVersion: number | null): Promise<boolean> => {
      setSaving(true);
      setProblem(null);
      setNotice(null);
      const outcome = await save(change, baseVersion);
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

  /** Saves the job editor's entry, the way the Job list does; the editor shows its own conflicts and issues. */
  const saveEntry = async (entry: JobEntry, baseVersion: number | null): Promise<SaveOutcome> => {
    const outcome = await save({ kind: "upsert", target: { type: "job", name: entry.job_name }, value: entry }, baseVersion);
    if (outcome.ok) {
      setProblem(null);
      setNotice(`Saved version ${outcome.result.version}: ${outcome.result.summary}.`);
    }
    return outcome;
  };

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
      const selecting = selectedId !== box.id;
      setSelectedId(selecting ? box.id : null);
      setAnnouncement(selecting && document ? `Selected ${box.name}. ${affectsText(downstreamOf(document, box).jobs.length)}` : "");
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

  /** A click on the canvas or on the group frame: close the menu, and clear the selection unless a link is being added. */
  const clearOnCanvas = () => {
    setMenuEdge(null);
    if (link.step === "off") setSelectedId(null);
  };

  const flowNodes = useMemo<MapFlowNode[]>(() => {
    if (!graph) return [];
    const nodes = graph.nodes.map((box) =>
      toFlowNode(box, nodeHighlight(box, link, selected, chain), statusLoading, direction, box.kind === "job" ? (facts?.get(box.name) ?? null) : null),
    );
    const section = sectionNode(graph.nodes);
    // The group frame goes first, so it is drawn under its cards.
    return section ? [section, ...nodes] : nodes;
  }, [graph, link, selected, chain, statusLoading, direction, facts]);

  // Changes when a save, the direction or the services switch adds, removes or moves a box, so the view fits the new layout.
  const layoutKey = useMemo(() => (graph?.nodes ?? []).map((n) => `${n.id}@${n.position.x},${n.position.y}`).join("|"), [graph]);

  const flowEdges = useMemo<LinkFlowEdge[]>(
    () =>
      (graph?.edges ?? []).map((edge) => {
        const highlight = edgeHighlight(edge, link, selected, chain);
        return {
          id: edge.id,
          type: "link",
          source: edge.source,
          target: edge.target,
          data: { link: edge, highlight },
          // The group LinkEdge's focus classes look at: React Flow puts this class on the link's focusable <g>.
          className: "group",
          selected: edge.id === menuEdge,
          selectable: link.step === "off",
          focusable: true,
          ariaLabel: linkLabel(edge),
          ariaRole: "button",
          interactionWidth: 18,
          // The selection's chain draws over the faded links.
          zIndex: highlight === "downstream" || highlight === "upstream" || edge.id === menuEdge ? 1 : 0,
        };
      }),
    [graph, link, selected, chain, menuEdge],
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
    const from = event.target instanceof Node ? event.target : null;
    // React Flow takes focus off a link on Escape, which would drop it on the page body: the link keeps it.
    const fromLink = event.target instanceof Element ? event.target.closest(".react-flow__edge") : null;
    if (fromLink instanceof SVGElement || fromLink instanceof HTMLElement) fromLink.focus();
    if (link.step !== "off") {
      setLink({ step: "off" });
      // From the banner, which goes with the mode: back to Add link.
      if (from && bannerRef.current?.contains(from)) addLinkRef.current?.focus();
      return;
    }
    // From inside the side panel, which closes: back to its box.
    if (selected && from && panelRef.current?.contains(from)) setRefocus({ kind: "box", id: selected.id });
    setSelectedId(null);
  };

  const closeMenu = (returnFocus: boolean) => {
    if (returnFocus && menuEdge !== null) setRefocus({ kind: "link", id: menuEdge });
    setMenuEdge(null);
  };

  /** Removes a link, from its menu or from the side panel, and moves focus to something that stays. */
  const removeLink = (edgeId: string, from: "menu" | "panel") => {
    const panelStays = from === "panel" && graph !== null && selected !== null && staysWithout(graph, edgeId, selected.id);
    const after: FocusTarget = panelStays ? { kind: "panel" } : graph ? focusAfterRemoving(graph, edgeId) : { kind: "map" };
    void runSave(unlinkChange(edgeId), version).then((saved) => {
      setMenuEdge(null);
      // When the save fails, the link is still there: focus goes back to where the removal started.
      setRefocus(saved ? after : from === "menu" ? { kind: "link", id: edgeId } : { kind: "panel" });
    });
  };

  const jobCount = document?.jobs.length ?? 0;
  const canLink = graph !== null && jobCount > 0 && graph.nodes.length >= 2;
  const headerActions = (
    <>
      <Button
        ref={addLinkRef}
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
      <Button ref={addServiceRef} variant="outline" size="sm" disabled={jobCount === 0 || saving} onClick={() => setServiceOpen(true)}>
        <Server aria-hidden="true" />
        Add service
      </Button>
    </>
  );

  let body: ReactNode;
  if (state === null && error === null) {
    body = <CanvasSkeleton />;
  } else if (state === null) {
    body = (
      <Alert variant="destructive">
        <AlertTitle>The job list did not load.</AlertTitle>
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
        {allEdges.length === 0 && link.step === "off" ? (
          <p className="-mt-1 flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            <Network className="size-4 shrink-0" aria-hidden="true" />
            {EMPTY_COPY}
          </p>
        ) : null}
        <ReactFlowProvider>
          {/* tabIndex -1: focus lands on the map itself when nothing on it can take it. */}
          <div
            ref={mapRef}
            tabIndex={-1}
            className="@container relative min-h-[520px] flex-1 overflow-hidden rounded-lg border border-border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onKeyDown={onKeyDown}
          >
            <MapMarkers />
            {/* Before the canvas, so Tab reaches the toolbar before the links and the cards. */}
            <Toolbar
              className="absolute top-3 left-3 z-10"
              direction={direction}
              onDirectionChange={setDirection}
              showServices={showServices}
              onShowServicesChange={setShowServices}
              panelOpen={panelOpen}
            />
            <div className="absolute inset-0">
              <ReactFlow<MapFlowNode, LinkFlowEdge>
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={NODE_TYPES}
                edgeTypes={EDGE_TYPES}
                // Also what gives the cards pointer events: React Flow turns them off on a node that is neither selectable nor clickable.
                onNodeClick={(_event, node) => {
                  if (node.type === "section") clearOnCanvas();
                  else activate(node.data.box);
                }}
                onEdgeClick={(_event, edge) => {
                  if (link.step === "off") openEdge(edge.id);
                }}
                onEdgesChange={onEdgesChange}
                onPaneClick={clearOnCanvas}
                nodesDraggable={false}
                nodesConnectable={false}
                nodesFocusable={false}
                edgesFocusable
                deleteKeyCode={null}
                selectionKeyCode={null}
                multiSelectionKeyCode={null}
                fitView
                fitViewOptions={FIRST_FIT}
                // Low enough for a fit to show a 200-job map whole; zoom in, pan or use the minimap from there.
                minZoom={0.1}
                maxZoom={1.75}
                colorMode="light"
                // React Flow asks that only Pro subscribers hide its attribution; it sits between the legend and the minimap.
                attributionPosition="bottom-center"
                ariaLabelConfig={ARIA_LABELS}
                aria-label="Dependency map"
              >
                <Background variant={BackgroundVariant.Dots} gap={16} size={1.1} color="var(--input)" bgColor="var(--muted)" />
                <MiniMap<MapFlowNode>
                  pannable
                  zoomable
                  position="bottom-right"
                  nodeClassName={minimapClass}
                  nodeBorderRadius={6}
                  bgColor="var(--card)"
                  maskColor="color-mix(in srgb, var(--muted) 72%, transparent)"
                  maskStrokeColor="var(--input)"
                  maskStrokeWidth={1}
                  className="m-3 overflow-hidden rounded-lg border border-border shadow-[0_1px_2px_rgb(27_49_57/0.06)] @max-2xl:hidden [&>svg]:h-[120px] [&>svg]:w-[160px]"
                />
                <Refit layoutKey={layoutKey} panelOpen={panelOpen} />
                <KeepInView nodeId={panelOpen ? selected.id : null} />
                <Panel position="bottom-left" className="m-3">
                  <MapLegend />
                </Panel>
                {/* Adding a link clears the selection, so the banner takes the panel's corner, below the toolbar on a narrow canvas. */}
                {link.step !== "off" ? (
                  <Panel position="top-right" className="m-3 @max-3xl:mt-14">
                    <LinkBanner
                      mode={link}
                      containerRef={bannerRef}
                      onCancel={() => {
                        setLink({ step: "off" });
                        addLinkRef.current?.focus();
                      }}
                    />
                  </Panel>
                ) : null}
                {panelOpen && document ? (
                  // Down the right, over the minimap when it needs the height; the frame lets clicks through around the panel.
                  <Panel position="top-right" className="pointer-events-none bottom-0 m-3 flex items-start">
                    <MapSidePanel
                      box={selected}
                      document={document}
                      links={allEdges.filter((e) => e.source === selected.id || e.target === selected.id)}
                      steps={steps ?? new Map()}
                      statusLoading={statusLoading}
                      saving={saving}
                      panelRef={panelRef}
                      editRef={editRef}
                      onRemove={(edgeId) => removeLink(edgeId, "panel")}
                      onEdit={() => {
                        editedCardRef.current = boxButton(mapRef.current, selected.id);
                        setEditing(selected.name);
                      }}
                      onClose={() => {
                        setSelectedId(null);
                        setRefocus({ kind: "box", id: selected.id });
                      }}
                    />
                  </Panel>
                ) : null}
              </ReactFlow>
            </div>
            <LinkMenu link={menuLink} anchor={anchor} saving={saving} onRemove={(edgeId) => removeLink(edgeId, "menu")} onClose={closeMenu} />
          </div>
        </ReactFlowProvider>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Dependency map"
        description="How the monitored jobs depend on each other and on services. Select a card to see what a failure there affects."
        actions={headerActions}
      />
      <ConfigBanner savedVersion={state ? state.version : undefined} />
      {problem ? <SaveProblem problem={problem} onReload={reload} onReloaded={() => setProblem(null)} /> : null}
      {notice ? (
        <p role="status" className="-mt-2 font-mono text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {state !== null && error !== null && !loading ? (
        // The map on screen loaded, but a later load did not: the same line as on the job list.
        <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-destructive">
          <CircleAlert className="size-3.5" aria-hidden="true" />
          The newest job list did not load. {error.message} The map shows the version loaded before.
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => void reload()}>
            Retry
          </Button>
        </p>
      ) : null}
      {live.problem && graph ? (
        <QueryProblemLine
          title={live.stale ? "Live status did not refresh" : "Live status is not available"}
          problem={live.problem}
          location={live.location}
          note={live.stale ? "The map shows the statuses from before." : "Every job shows Unknown until it loads."}
          onRetry={bump}
        />
      ) : null}
      {body}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
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
            returnFocus={[addLinkRef]}
            onSave={(change) => void runSave(change, version).then(() => setLink({ step: "off" }))}
          />
          <AddServiceDialog
            open={serviceOpen}
            onOpenChange={(open) => {
              if (!saving) setServiceOpen(open);
            }}
            document={document}
            defaultJob={selected?.kind === "job" ? selected.name : null}
            saving={saving}
            returnFocus={[addServiceRef]}
            onSave={(change) =>
              void runSave(change, version).then((saved) => {
                setServiceOpen(false);
                // A new service shows on the map, even when the switch had hidden the services.
                if (saved) setShowServices(true);
              })
            }
          />
        </>
      ) : null}
      {/* Outside the map, so Escape in the editor closes the editor and leaves the selection alone. */}
      {state ? (
        <JobEditorSheet
          open={editingJob !== undefined}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          mode="edit"
          initial={editingJob ?? { job_name: "" }}
          document={state.document}
          version={state.version}
          onSave={saveEntry}
          renderPatternPreview={patternPreview}
          onReload={reload}
          returnFocus={editorReturnFocus}
        />
      ) : null}
    </>
  );
}

/** The canvas while the job list loads: a dot grid with a few card skeletons. */
function CanvasSkeleton() {
  return (
    <div className="relative min-h-[520px] flex-1 overflow-hidden rounded-lg border border-border bg-muted bg-[radial-gradient(var(--input)_1px,transparent_1.2px)] bg-size-[16px_16px]">
      <Skeleton className="absolute top-3 left-3 h-9 w-80 rounded-full" />
      <div className="absolute inset-0 flex items-center justify-center gap-24">
        <div className="flex flex-col gap-6">
          <Skeleton className="h-[68px] w-[248px] rounded-lg" />
          <Skeleton className="h-[52px] w-[184px] rounded-full" />
        </div>
        <div className="flex flex-col gap-6">
          <Skeleton className="h-[68px] w-[248px] rounded-lg" />
          <Skeleton className="h-[68px] w-[248px] rounded-lg" />
        </div>
        <div className="hidden flex-col gap-6 xl:flex">
          <Skeleton className="h-[68px] w-[248px] rounded-lg" />
        </div>
      </div>
      <Skeleton className="absolute bottom-3 left-3 h-[66px] w-[300px] rounded-lg" />
    </div>
  );
}

interface ToolbarProps extends Omit<MapToolbarProps, "fitOptions"> {
  panelOpen: boolean;
}

/** The toolbar with the fit for the canvas's width, which only the map's store knows. */
function Toolbar({ panelOpen, ...props }: ToolbarProps) {
  const width = useStore((state) => state.width);
  return <MapToolbar {...props} fitOptions={fitOptions(width, panelOpen)} />;
}

interface RefitProps {
  layoutKey: string;
  panelOpen: boolean;
}

/**
 * Fits the view again when the boxes change place (a save, the direction or
 * the services switch moved them) and when the map's area changes size (an
 * alert or a note above it came or went, or the window changed), clear of the
 * overlays and of the side panel while it is open. Opening the panel does not
 * refit: the view stays where the person put it. The first fit is the fitView
 * prop's, which runs before the size is known.
 */
function Refit({ layoutKey, panelOpen }: RefitProps) {
  const { fitView } = useReactFlow();
  // The size of the drawing area, which React Flow measures on every resize.
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const first = useRef(true);
  const refit = useEffectEvent(() => void fitView(fitOptions(width, panelOpen)));
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // After React Flow has taken the new nodes into its store.
    const frame = window.requestAnimationFrame(() => refit());
    return () => window.cancelAnimationFrame(frame);
  }, [layoutKey, width, height]);
  return null;
}

interface KeepInViewProps {
  /** The selected box while the side panel is open, else null. */
  nodeId: string | null;
}

/**
 * Brings a newly selected box out from under the side panel: the view moves
 * left just enough, at the same zoom. A box already in view does not move it.
 */
function KeepInView({ nodeId }: KeepInViewProps) {
  const { getInternalNode, getViewport, setViewport } = useReactFlow();
  const width = useStore((state) => state.width);
  const reveal = useEffectEvent((id: string) => {
    if (width < PANEL_CLEAR_FROM) return;
    const node = getInternalNode(id);
    if (!node) return;
    const { x, y, zoom } = getViewport();
    const left = x + node.internals.positionAbsolute.x * zoom;
    const right = left + (node.measured.width ?? node.width ?? 0) * zoom;
    const edge = width - (OVERLAY.inset + OVERLAY.panel + 16);
    // Never past the left edge of the canvas.
    const shift = Math.min(right - edge, left - 24);
    // A straight glide: the smooth path would zoom out and back in on the way.
    if (right > edge && shift > 0) void setViewport({ x: x - shift, y, zoom }, { duration: viewDuration(), interpolate: "linear" });
  });
  useEffect(() => {
    if (nodeId === null) return;
    // After the panel is drawn.
    const frame = window.requestAnimationFrame(() => reveal(nodeId));
    return () => window.cancelAnimationFrame(frame);
  }, [nodeId]);
  return null;
}

interface LinkBannerProps {
  mode: Exclude<LinkMode, { step: "off" }>;
  /** The banner's element, so Escape from inside it can move focus out before it goes. */
  containerRef: RefObject<HTMLDivElement | null>;
  onCancel: () => void;
}

/** The step of adding a link, over the canvas, with Cancel. */
function LinkBanner({ mode, containerRef, onCancel }: LinkBannerProps) {
  let text: string;
  if (mode.step === "source") text = "Pick the upstream job or service.";
  else if (mode.step === "target") text = mode.hint ?? `Now pick the job that depends on ${mode.source.name}.`;
  else text = `Choose how ${mode.target.name} depends on ${mode.source.name}.`;
  return (
    <div
      ref={containerRef}
      className="flex max-w-[min(28rem,calc(100cqw-24px))] items-center gap-3 rounded-xl border border-primary/35 bg-card py-1.5 pr-1.5 pl-3.5 text-[13px] shadow-[0_2px_10px_rgb(27_49_57/0.10)]"
      role="status"
      aria-live="polite"
    >
      <span className="relative flex size-2 shrink-0" aria-hidden="true">
        <span className="absolute inline-flex size-full rounded-full bg-primary opacity-60 motion-safe:animate-ping" />
        <span className="relative inline-flex size-2 rounded-full bg-primary" />
      </span>
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
  /** returnFocus is false when a click or focus outside closed the menu: focus stays where the person put it. */
  onClose: (returnFocus: boolean) => void;
}

/** The menu that opens on a link: what it means, and Remove link. */
function LinkMenu({ link, anchor, saving, onRemove, onClose }: LinkMenuProps) {
  const headingId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const outside = useRef(false);
  return (
    <Popover
      open={link !== null}
      onOpenChange={(open) => {
        if (!open) onClose(!outside.current);
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
            outside.current = false;
            contentRef.current?.focus();
          }}
          onInteractOutside={() => {
            outside.current = true;
          }}
          // The page moves focus on close: back to the link, or to a box when the link is gone.
          onCloseAutoFocus={(event) => event.preventDefault()}
          // Escape closes the menu and nothing else: React events bubble out of portals, and on the map Escape clears the selection.
          onKeyDown={(event) => {
            if (event.key === "Escape") event.stopPropagation();
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
            <Button variant="ghost" size="sm" onClick={() => onClose(true)}>
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

interface SaveProblemProps {
  problem: Problem;
  onReload: ReloadJobList;
  /** Runs once the newest job list has loaded, which clears the conflict. */
  onReloaded: () => void;
}

/** A save the server refused: a conflict with Reload, the rule issues, or another failure. */
function SaveProblem({ problem, onReload, onReloaded }: SaveProblemProps) {
  if (problem.kind === "conflict") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Someone else changed the job list since you opened it.</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>Reload to see their change, then try again.</span>
          {/* A reload that fails says so and keeps the conflict, so the next save cannot go out from the old version. */}
          <ReloadButton onReload={onReload} onReloaded={onReloaded} />
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
