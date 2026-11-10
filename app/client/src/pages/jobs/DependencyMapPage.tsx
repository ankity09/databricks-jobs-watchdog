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
  type Connection,
  ConnectionMode,
  type EdgeTypes,
  MiniMap,
  type NodeTypes,
  type OnConnectEnd,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Viewport,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { CircleAlert, Link2, Network, Plus, RotateCw, Server, X } from "lucide-react";
import {
  type FocusEvent,
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
import type { LayoutPosition } from "../../../../shared/maplayout/types";
import { type ReloadJobList, type SaveOutcome, useJobList } from "../../hooks/useJobList";
import { useLiveStatus } from "../../hooks/useLiveStatus";
import { useBoxMoves, useMapLayout } from "../../hooks/useMapLayout";
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
  jobNodeId,
  unlinkChange,
} from "../../lib/graph";
import { applySavedLayout, notLinkedYet } from "../../lib/layoutMerge";
import { proposeLink } from "../../lib/linkRules";
import type { EntryJobIds } from "../../lib/picker";
import { statusTone } from "../../lib/status";
import { cn } from "../../lib/utils";
import { AddFromWorkspaceDialog } from "./AddFromWorkspaceDialog";
import { AddLinkDialog, AddServiceDialog } from "./AddLinkDialog";
import { ConfigBanner } from "./ConfigBanner";
import { JobEditorSheet } from "./JobEditorSheet";
import { type Upstream, affectsText, impactSteps, upstreamOf } from "./mapChain";
import { DraftLine, JobNode, LinkEdge, MapLegend, MapMarkers, SectionNode, ServiceNode } from "./MapElements";
import { type CardFacts, cardFacts } from "./mapFacts";
import {
  type EdgeHighlight,
  type LinkFlowEdge,
  type MapFlowNode,
  type Measurable,
  EDGE_GAP,
  MINIMAP_FROM,
  type NodeHighlight,
  OVERLAY,
  PANEL_OVER_FROM,
  TONE_FILL,
  fitOptions,
  linkLabel,
  linkMeaning,
  panelGoesUnder,
  viewDuration,
} from "./mapModel";
import { DeleteJobDialog } from "./DeleteJobDialog";
import { MapSidePanel } from "./MapSidePanel";
import { MapToolbar, type MapToolbarProps } from "./MapToolbar";
import { useMapUndo } from "./mapUndo";
import { NewLinkCard } from "./NewLinkCard";
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
const FIRST_FIT = fitOptions(MINIMAP_FROM);

/** React Flow's keyboard hints, without the delete key, which the map does not use. */
const ARIA_LABELS = {
  "edge.a11yDescription.default": "Press Enter to see this link and remove it, or Escape to close it.",
  "minimap.ariaLabel": "Overview of the map",
};

/** Which way each arrow key moves the selected box; it moves 10 pixels, or 50 with Shift. */
const ARROWS = new Map([
  ["ArrowLeft", { x: -1, y: 0 }],
  ["ArrowRight", { x: 1, y: 0 }],
  ["ArrowUp", { x: 0, y: -1 }],
  ["ArrowDown", { x: 0, y: 1 }],
]);
const KEY_STEP = 10;
const KEY_STEP_SHIFT = 50;

/** Whether a key went to something a person types in: a text field, a list, or editable text. */
function typingIn(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null;
}

/** Whether a key came from inside the side panel. */
function inPanel(target: EventTarget | null, panel: HTMLElement | null): boolean {
  return target instanceof Node && panel?.contains(target) === true;
}

/** Whether a key came from the side panel's settings form, whose unsaved edits go when the panel closes. */
function inPanelForm(target: EventTarget | null, panel: HTMLElement | null): boolean {
  const form = target instanceof Element ? target.closest("form") : null;
  return form !== null && panel?.contains(form) === true;
}

/** Ctrl+Z, or Cmd+Z: Undo. Not with Shift, which is redo elsewhere, nor with Alt. */
function isUndoKey(event: globalThis.KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z";
}

/** Whether a dialog, the job editor, the link menu or the New link card is open: Undo's keys wait until it closes. */
function overlayOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

/** The link a key or a focus went to, by its ID; null when it went to anything else. */
function edgeIdOf(target: EventTarget | null): string | null {
  return target instanceof Element ? (target.closest(".react-flow__edge")?.getAttribute("data-id") ?? null) : null;
}

/**
 * Whether a key came from the map itself: a card, a link, or the map's frame.
 * Not from the toolbar or a panel over the map, where the arrow keys scroll
 * or pick as usual.
 */
function onCanvas(target: EventTarget, map: HTMLElement | null): boolean {
  if (map === null || !(target instanceof Element) || !map.contains(target)) return false;
  return target === map || target.closest(".react-flow__node, .react-flow__edge") !== null;
}

/** Adding a link: pick the upstream box, then the downstream job, then the type. */
type LinkMode =
  | { step: "off" }
  | { step: "source" }
  | { step: "target"; source: GraphNode; hint: string | null }
  | { step: "type"; source: GraphNode; target: GraphNode };

type Problem = { kind: "conflict" } | { kind: "invalid"; message: string; issues: RuleIssue[] } | { kind: "failed"; message: string };

/**
 * A link dropped on the map, waiting in the New link card: its two boxes by
 * node ID, as React Flow gives them (the source is upstream of the target),
 * and the box it was dropped on, which the card opens next to.
 */
interface DroppedLink {
  source: string;
  target: string;
  at: string;
}

function rect(x: number, y: number, width = 0, height = 0): DOMRect {
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({ x, y, width, height }) };
}

/** A link's or a box's element on the map, by the id React Flow puts in data-id. */
function mapElement(container: HTMLElement | null, kind: "edge" | "node", id: string): HTMLElement | SVGElement | null {
  return container?.querySelector<HTMLElement | SVGElement>(`.react-flow__${kind}[data-id="${id.replace(/["\\]/g, "\\$&")}"]`) ?? null;
}

/** The job or service box under the pointer where a link drag ended, by its node ID; null over anything else. */
function boxUnder(event: MouseEvent | TouchEvent, nodes: GraphNode[]): string | null {
  const point = "changedTouches" in event ? event.changedTouches.item(0) : event;
  if (point === null) return null;
  const id = document.elementFromPoint(point.clientX, point.clientY)?.closest(".react-flow__node")?.getAttribute("data-id");
  return id && nodes.some((n) => n.id === id) ? id : null;
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
 * and the map's menu and panel open without one. "if-lost" moves focus only
 * when it went with what was removed, such as a line an undo took away.
 */
type FocusTarget = { kind: "link" | "box"; id: string } | { kind: "panel" } | { kind: "map" } | { kind: "if-lost"; then: FocusTarget };

function boxButton(container: HTMLElement | null, id: string): HTMLButtonElement | null {
  return mapElement(container, "node", id)?.querySelector("button") ?? null;
}

function focusOn(container: HTMLElement | null, panel: HTMLElement | null, target: FocusTarget): void {
  if (target.kind === "if-lost") {
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected) focusOn(container, panel, target.then);
    return;
  }
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

/** Each moving box's spot before its move, for Undo: where the map draws it now, its saved spot or its automatic one. */
function spotsOf(graph: Pick<Graph, "nodes"> | null, moves: LayoutPosition[]): LayoutPosition[] {
  return moves.flatMap(({ nodeKey }) => {
    const box = graph?.nodes.find((n) => n.id === nodeKey);
    return box ? [{ nodeKey, x: box.position.x, y: box.position.y }] : [];
  });
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
      { id: "in", type: "target", position: Position.Left, x: -half, y: box.height / 2 - half, ...size },
      { id: "out", type: "source", position: Position.Right, x: box.width - half, y: box.height / 2 - half, ...size },
    ];
  }
  return [
    { id: "in", type: "target", position: Position.Top, x: box.width / 2 - half, y: -half, ...size },
    { id: "out", type: "source", position: Position.Bottom, x: box.width / 2 - half, y: box.height - half, ...size },
  ];
}

/**
 * A box on the canvas. `draggable` is true once the saved positions are in, so a drag never lands on the automatic
 * layout; `connectable` is true when a link can be dragged from its ports.
 */
function toFlowNode(
  box: GraphNode,
  highlight: NodeHighlight,
  statusLoading: boolean,
  direction: LayoutDirection,
  facts: CardFacts | null,
  draggable: boolean,
  connectable: boolean,
): MapFlowNode {
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
    // The page moves the selected box with the arrow keys itself, so React Flow's own node focus and key moves stay off.
    focusable: false,
    draggable,
    connectable,
  };
}

/** The group frame's room around its cards: its label sits in the top band. */
const GROUP_PAD = { x: 16, top: 40, bottom: 16 } as const;

/** The labeled group around the jobs without links, when other boxes are on the map: a box dragged out of it (placed) stays out. */
function sectionNode(nodes: GraphNode[], placed: ReadonlySet<string>): MapFlowNode | null {
  const unlinked = notLinkedYet(nodes, placed);
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
 * rule errors come back as alerts. Dragging a card, or the arrow keys on a
 * selected one, moves it: its spot is saved for everyone (useMapLayout), never
 * as a version of the job list. Add job adds a job picked from the workspace,
 * and Undo takes back the person's own moves, Tidy ups and link changes
 * (useMapUndo).
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
  // The boxes' saved spots for this direction, shared by everyone; boxes move only once they are in.
  const layout = useMapLayout(direction);
  const canMove = layout.status === "ready";
  // Counts the Tidy ups and their undos, after which the view fits the layout again.
  const [tidies, setTidies] = useState(0);
  // Laid out again only when the list, the statuses, the direction or the services switch change, never on a selection.
  const automatic = useMemo(
    () => (document ? buildGraph(document, live.byJob, { direction, services: showServices }) : null),
    [document, live.byJob, direction, showServices],
  );
  // The saved spots over the automatic layout: what the map draws.
  const graph = useMemo(() => {
    if (!automatic) return null;
    const { nodes, placed } = applySavedLayout(automatic.nodes, layout.positions);
    return { nodes, edges: automatic.edges, placed };
  }, [automatic, layout.positions]);
  // Every link, the hidden service links too: the side panel lists a job's real links whatever the map shows.
  const allEdges = useMemo(() => (document ? buildEdges(document) : []), [document]);
  const facts = useMemo(() => (document ? cardFacts(document) : null), [document]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [link, setLink] = useState<LinkMode>({ step: "off" });
  const [serviceOpen, setServiceOpen] = useState(false);
  const [menuEdge, setMenuEdge] = useState<string | null>(null);
  // The line selected with a pointer, which shows its ×; Enter on a line opens its menu instead.
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [dropped, setDropped] = useState<DroppedLink | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  // Add job: the workspace picker is open, then the job editor with the picked job's draft.
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState<JobEntry | null>(null);
  // The job whose Remove from Watchdog is asking to confirm.
  const [removing, setRemoving] = useState<string | null>(null);
  // A job someone else deleted while its editor was open, for the line that says so.
  const [goneJob, setGoneJob] = useState<string | null>(null);
  // Counts the toolbar's finished fits, after which the map slides a selection clear of the panel again.
  const [fits, setFits] = useState(0);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  // Said politely when a box is selected, for people who select one from the keyboard; focus stays on the box.
  const [announcement, setAnnouncement] = useState("");

  // The page's own content: Undo's keys count from there, not from the nav beside it.
  const pageRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  // The card of the job being edited, kept when Edit job is pressed: focus goes there if the panel closed meanwhile.
  const editedCardRef = useRef<HTMLElement | null>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const addJobRef = useRef<HTMLButtonElement>(null);
  const addLinkRef = useRef<HTMLButtonElement>(null);
  const addServiceRef = useRef<HTMLButtonElement>(null);
  const anchor = useRef<Measurable>({ getBoundingClientRect: () => rect(0, 0) });
  const cardAnchor = useRef<Measurable>({ getBoundingClientRect: () => rect(0, 0) });
  // The line that says why a save failed: its Reload leaves the New link card open.
  const problemRef = useRef<HTMLDivElement>(null);
  // The box a link drag started from, so the New link card opens at the box the link is dropped on.
  const dragFrom = useRef<string | null>(null);
  const [refocus, setRefocus] = useState<FocusTarget | null>(null);

  // A box removed by a save (a service whose last link went), or hidden by the services switch, drops out of the selection on its own.
  const selected = graph?.nodes.find((n) => n.id === selectedId) ?? null;
  const chain = useMemo<Chain | null>(
    () => (document && graph && selected ? { downstream: downstreamOf(document, selected), upstream: upstreamOf(graph.edges, selected.id) } : null),
    [document, graph, selected],
  );
  const steps = useMemo(() => (document && selected ? impactSteps(document, selected) : null), [document, selected]);
  const menuLink = graph?.edges.find((e) => e.id === menuEdge) ?? null;
  const selectedLink = graph?.edges.find((e) => e.id === selectedEdge) ?? null;
  // What the dropped link would be, from the newest list: a reload can change it. Gone with either of its boxes.
  const proposal = useMemo(() => {
    const from = graph?.nodes.find((n) => n.id === dropped?.source);
    const to = graph?.nodes.find((n) => n.id === dropped?.target);
    return document && from && to ? proposeLink(document, from, to) : null;
  }, [document, graph, dropped]);
  const statusLoading = live.loading && live.byJob.size === 0;
  const panelOpen = selected !== null && link.step === "off";
  const editingJob = editing !== null ? document?.jobs.find((job) => job.job_name === editing) : undefined;
  // A reload showed the job is gone: the editor closes for good and the page says so, as on the Job list.
  if (editing !== null && document !== null && editingJob === undefined) {
    setGoneJob(editing);
    setEditing(null);
  }
  // When the editor closes: Edit job, else the job's card (the panel closed meanwhile), else the map.
  const editorReturnFocus = useMemo<ReturnFocus>(() => [editRef, editedCardRef, mapRef], []);
  // When Add job's picker or editor closes without a save: Add job, else the map. A save focuses the new job's box.
  const addJobReturnFocus = useMemo<ReturnFocus>(() => [addJobRef, mapRef], []);

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

  /**
   * Saves one change made on the map; `baseVersion` is the version on screen when it was made. A refusal shows above
   * the map: a conflict with Reload, the rule issues, or another failure. Undo says itself why the rules refused its
   * change, so it passes `showIssues` false.
   */
  const saveOnMap = useCallback(
    async (change: Change, baseVersion: number | null, showIssues = true): Promise<SaveOutcome> => {
      setSaving(true);
      setProblem(null);
      setNotice(null);
      const outcome = await save(change, baseVersion);
      setSaving(false);
      if (outcome.ok) setNotice(`Saved version ${outcome.result.version}: ${outcome.result.summary}.`);
      else if (outcome.conflict) setProblem({ kind: "conflict" });
      else if (outcome.issues.length === 0) setProblem({ kind: "failed", message: outcome.message });
      else if (showIssues) setProblem({ kind: "invalid", message: outcome.message, issues: outcome.issues });
      return outcome;
    },
    [save],
  );

  /** Saves one change made on the map, as saveOnMap does. True when the save worked. */
  const runSave = useCallback(
    async (change: Change, baseVersion: number | null): Promise<boolean> => (await saveOnMap(change, baseVersion)).ok,
    [saveOnMap],
  );

  /**
   * Saves the change an undo makes to the job list. A link it removes lets go of its ×, and when focus went with the
   * line or a box, it moves to what stays, as after Remove link. Focus anywhere else stays put.
   */
  const saveUndoChange = async (change: Change): Promise<SaveOutcome> => {
    const removed = change.kind === "delete" && change.target.type === "dependency" ? change.target.key : null;
    const after = removed !== null && graph ? focusAfterRemoving(graph, removed) : null;
    const outcome = await saveOnMap(change, version, false);
    if (outcome.ok && removed !== null) {
      setSelectedEdge((current) => (current === removed ? null : current));
      if (after) setRefocus({ kind: "if-lost", then: after });
    }
    return outcome;
  };

  // Undo: the person's own moves, Tidy ups and link changes on this map, this session.
  const history = useMapUndo({
    direction,
    layout,
    document,
    saving,
    saveChange: saveUndoChange,
    turn: setDirection,
    onUndone: (action) => {
      if (action.kind === "tidy") setTidies((n) => n + 1);
    },
  });
  const recordAction = history.record;
  // A drag or a key move is saved as a move Undo can take back, with each box's spot from before: where the map draws it.
  const moves = useBoxMoves((positions) => history.move(positions, spotsOf(graph, positions)));

  /** Undo: a key move still waiting for its save is dropped, and its box goes back; else the newest action is undone. */
  const undo = () => {
    if (moves.moving.size > 0) moves.cancel();
    else history.undo();
  };

  /** Turns the map to the other direction; a key move still waiting is saved for the direction it was made in. */
  const changeDirection = (next: LayoutDirection) => {
    moves.flush();
    setDirection(next);
  };

  /** Saves the job editor's entry, the way the Job list does; the editor shows its own conflicts and issues. */
  const saveEntry = async (entry: JobEntry, baseVersion: number | null): Promise<SaveOutcome> => {
    const outcome = await save({ kind: "upsert", target: { type: "job", name: entry.job_name }, value: entry }, baseVersion);
    if (outcome.ok) {
      setProblem(null);
      setNotice(`Saved version ${outcome.result.version}: ${outcome.result.summary}.`);
    }
    return outcome;
  };

  /** Saves a job's settings from the side panel; a refusal shows on the line above the map, as for a link. */
  const saveSettings = async (entry: JobEntry): Promise<SaveOutcome> => {
    setSaving(true);
    setNotice(null);
    const outcome = await saveEntry(entry, version);
    setSaving(false);
    if (outcome.ok) return outcome;
    if (outcome.conflict) setProblem({ kind: "conflict" });
    else if (outcome.issues.length > 0) setProblem({ kind: "invalid", message: outcome.message, issues: outcome.issues });
    else setProblem({ kind: "failed", message: outcome.message });
    return outcome;
  };

  /** Saves a job added from the map, the way the editor's edits save, then selects the new job's box and focuses it. */
  const saveNewJob = async (entry: JobEntry, baseVersion: number | null): Promise<SaveOutcome> => {
    const outcome = await saveEntry(entry, baseVersion);
    if (outcome.ok) {
      const id = jobNodeId(entry.job_name);
      setLink({ step: "off" });
      setMenuEdge(null);
      setSelectedEdge(null);
      setSelectedId(id);
      setRefocus({ kind: "box", id });
    }
    return outcome;
  };

  /**
   * Saves a new link, from the New link card, the Add link dialog or the Add service dialog, as an action Undo can take
   * back. True when the save worked.
   */
  const addLink = async (change: Change): Promise<boolean> => {
    const saved = await runSave(change, version);
    if (saved && change.target.type === "dependency") recordAction({ kind: "link-add", edgeKey: change.target.key });
    return saved;
  };

  /**
   * Removes a link, from its line (its × or Delete), its menu or the side panel, as an action Undo can take back, and
   * moves focus to something that stays. True when the save worked.
   */
  const removeLink = useCallback(
    async (edgeId: string, from: "map" | "panel" = "map"): Promise<boolean> => {
      const panelStays = from === "panel" && graph !== null && selected !== null && staysWithout(graph, edgeId, selected.id);
      const after: FocusTarget = panelStays ? { kind: "panel" } : graph ? focusAfterRemoving(graph, edgeId) : { kind: "map" };
      // Its fields, for Undo, which saves it again.
      const edge = allEdges.find((e) => e.id === edgeId);
      const saved = await runSave(unlinkChange(edgeId), version);
      setMenuEdge(null);
      // The removed line lets go of its ×; a line still there after a failed save keeps it.
      if (saved) setSelectedEdge((current) => (current === edgeId ? null : current));
      if (saved && edge) recordAction({ kind: "link-remove", edge });
      // When the save fails, the link is still there: focus goes back to where the removal started.
      setRefocus(saved ? after : from === "map" ? { kind: "link", id: edgeId } : { kind: "panel" });
      return saved;
    },
    [graph, selected, allEdges, runSave, version, recordAction],
  );

  /** Opens a link's menu, which takes the place of the × of a line selected with a pointer. */
  const openEdge = (edgeId: string) => {
    let last = rect(0, 0);
    anchor.current = {
      getBoundingClientRect: () => {
        last = edgeRect(mapRef.current, edgeId, last);
        return last;
      },
    };
    setSelectedEdge(null);
    setMenuEdge(edgeId);
  };

  // A box was clicked or pressed: select it, or pick it while adding a link.
  const activate = (box: GraphNode) => {
    setMenuEdge(null);
    setSelectedEdge(null);
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

  /** A click on the canvas or on the group frame: close the menu, let go of a line, and clear the selection unless a link is being added. */
  const clearOnCanvas = () => {
    setMenuEdge(null);
    setSelectedEdge(null);
    if (link.step === "off") setSelectedId(null);
  };

  /** Opens the New link card for a link dropped on the map, next to the box it was dropped on. Not while a save is on its way. */
  const openDropped = (source: string, target: string, at: string) => {
    if (saving) return;
    let last = rect(0, 0);
    cardAnchor.current = {
      getBoundingClientRect: () => {
        last = mapElement(mapRef.current, "node", at)?.getBoundingClientRect() ?? last;
        return last;
      },
    };
    setMenuEdge(null);
    setSelectedEdge(null);
    // The card takes focus: a focus move still waiting from before (such as the last card's) would close it.
    setRefocus(null);
    setDropped({ source, target, at });
  };

  /** A link dropped on a port. React Flow gives its ends upstream first, whichever port the drag started from. */
  const onConnect = (connection: Connection) => {
    openDropped(connection.source, connection.target, connection.target === dragFrom.current ? connection.source : connection.target);
  };

  /** A link dropped on a box's card, not on a port, which React Flow leaves alone. */
  const onConnectEnd: OnConnectEnd = (event, state) => {
    dragFrom.current = null;
    // A drop on a port went to onConnect.
    if (state.isValid || !state.fromNode || !state.fromHandle || !graph) return;
    const at = boxUnder(event, graph.nodes);
    if (at === null || at === state.fromNode.id) return;
    // From the port where links start, the box it was dropped on depends on the box it came from; from the other port, the other way round.
    if (state.fromHandle.type === "source") openDropped(state.fromNode.id, at, at);
    else openDropped(at, state.fromNode.id, at);
  };

  // The ports take a link drag except while a link is being picked with Add link.
  const canConnect = link.step === "off";

  const laidOut = useMemo<MapFlowNode[]>(() => {
    if (!graph) return [];
    const nodes = graph.nodes.map((box) =>
      toFlowNode(
        box,
        nodeHighlight(box, link, selected, chain),
        statusLoading,
        direction,
        box.kind === "job" ? (facts?.get(box.name) ?? null) : null,
        canMove,
        canConnect,
      ),
    );
    const section = sectionNode(graph.nodes, graph.placed);
    // The group frame goes first, so it is drawn under its cards.
    return section ? [section, ...nodes] : nodes;
  }, [graph, link, selected, chain, statusLoading, direction, facts, canMove, canConnect]);
  // A box on the move is drawn where the drag or the keys have it; the others keep their node, so a drag redraws one box.
  const flowNodes = useMemo(() => {
    if (moves.moving.size === 0) return laidOut;
    return laidOut.map((node) => {
      const at = moves.moving.get(node.id);
      return at ? { ...node, position: at } : node;
    });
  }, [laidOut, moves.moving]);

  // Changes when the automatic layout changes (boxes come or go, a link edit moves boxes, the direction or the services
  // switch), the saved spots load or Tidy up runs, so the view fits the new layout. Moving a box changes only its saved
  // spot, never the automatic layout, so a drag or a key move never refits the view.
  const layoutKey = useMemo(
    () => [direction, showServices, layout.status, tidies, ...(automatic?.nodes ?? []).map((n) => `${n.id}@${n.position.x},${n.position.y}`)].join("|"),
    [direction, showServices, layout.status, tidies, automatic],
  );

  const flowEdges = useMemo<LinkFlowEdge[]>(
    () =>
      (graph?.edges ?? []).map((edge) => {
        const highlight = edgeHighlight(edge, link, selected, chain);
        const picked = edge.id === selectedEdge;
        return {
          id: edge.id,
          type: "link",
          source: edge.source,
          target: edge.target,
          data: { link: edge, highlight, ...(picked ? { onRemove: () => void removeLink(edge.id), saving } : {}) },
          // The group LinkEdge's focus classes look at: React Flow puts this class on the link's focusable <g>.
          className: link.step === "off" ? "group cursor-pointer" : "group",
          selected: picked || edge.id === menuEdge,
          // A click selects a line and Enter opens its menu, both by the page (onEdgeClick, onKeyDown): React Flow's own
          // selection, which does both on either, stays out of it.
          selectable: false,
          focusable: true,
          ariaLabel: linkLabel(edge),
          ariaRole: "button",
          interactionWidth: 18,
          // The selection's chain draws over the faded links.
          zIndex: highlight === "downstream" || highlight === "upstream" || picked || edge.id === menuEdge ? 1 : 0,
        };
      }),
    [graph, link, selected, chain, selectedEdge, menuEdge, removeLink, saving],
  );

  const onKeyDown = (event: KeyboardEvent) => {
    const arrow = ARROWS.get(event.key);
    if (arrow) {
      // The arrow keys move the selected box when they come from the map, not while a person types in a field, nor when
      // a control used the key.
      if (!selected || !canMove || !onCanvas(event.target, mapRef.current)) return;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || typingIn(event.target)) return;
      event.preventDefault();
      const step = event.shiftKey ? KEY_STEP_SHIFT : KEY_STEP;
      moves.nudge(selected.id, selected.position, arrow.x * step, arrow.y * step);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      // Delete or Backspace removes the line selected with a pointer, never a box: only when the key comes from that
      // line, which has focus, and not while a save is on its way.
      if (!selectedLink || saving || edgeIdOf(event.target) !== selectedLink.id) return;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      void removeLink(selectedLink.id);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      // Enter or Space on a focused link opens its menu.
      const edgeId = edgeIdOf(event.target);
      if (!edgeId || link.step !== "off" || event.defaultPrevented) return;
      event.preventDefault();
      openEdge(edgeId);
      return;
    }
    if (event.key !== "Escape") return;
    const from = event.target instanceof Node ? event.target : null;
    if (link.step !== "off") {
      setLink({ step: "off" });
      // From the banner, which goes with the mode: back to Add link.
      if (from && bannerRef.current?.contains(from)) addLinkRef.current?.focus();
      return;
    }
    // A selected line lets go first, and a selected box stays. From the line's ×, which goes with it: to the line.
    if (selectedEdge !== null) {
      if (event.target instanceof Element && event.target.closest(".react-flow__edgelabel-renderer")) setRefocus({ kind: "link", id: selectedEdge });
      setSelectedEdge(null);
      return;
    }
    // The panel stays when a control used the key (Radix closes a list or a tooltip with it, and React events bubble out
    // of portals), when it came from a text field, and anywhere in the panel's settings form: closing would drop its edits.
    if (event.defaultPrevented || typingIn(event.target) || inPanelForm(event.target, panelRef.current)) return;
    // From inside the side panel, which closes: back to its box.
    if (selected && from && panelRef.current?.contains(from)) setRefocus({ kind: "box", id: selected.id });
    setSelectedId(null);
  };

  /** Another line took focus, such as with Tab: the selected line lets go of its ×, so Delete never removes a line that has no focus. */
  const onFocus = (event: FocusEvent) => {
    const edgeId = edgeIdOf(event.target);
    if (edgeId !== null) setSelectedEdge((current) => (current !== null && current !== edgeId ? null : current));
  };

  // Ctrl+Z or Cmd+Z undoes from anywhere on the page, or with nothing focused; not from outside it, such as the nav,
  // not in a text field, which keeps its own undo, not from the side panel, whose controls edit the job it shows, and
  // not while a dialog, the job editor, the link menu or the New link card is open.
  const onUndoKey = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (!isUndoKey(event) || event.defaultPrevented || typingIn(event.target) || overlayOpen()) return;
    const onPage = event.target === window.document.body || (event.target instanceof Node && pageRef.current?.contains(event.target) === true);
    if (!onPage || inPanel(event.target, panelRef.current)) return;
    event.preventDefault();
    undo();
  });
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => onUndoKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const closeMenu = (returnFocus: boolean) => {
    if (returnFocus && menuEdge !== null) setRefocus({ kind: "link", id: menuEdge });
    setMenuEdge(null);
  };

  /** Save link in the New link card: the card closes once the link is saved, and keeps its choices when the save fails. */
  const saveDropped = (change: Change) => {
    const shown = dropped;
    void addLink(change).then((saved) => {
      if (!saved || shown === null) return;
      setDropped(null);
      setRefocus({ kind: "box", id: shown.at });
    });
  };

  /** Closes the New link card, unless its save is on its way: then the save's answer decides. */
  const closeDropped = (returnFocus: boolean) => {
    if (saving || dropped === null) return;
    if (returnFocus) setRefocus({ kind: "box", id: dropped.at });
    setDropped(null);
  };

  /** Tidy up: the automatic layout again for this direction, for everyone, with the view fitted to it. Undo can take it back. */
  const tidy = () => {
    moves.cancel();
    void history.tidy().then((done) => {
      if (done) setTidies((n) => n + 1);
    });
  };

  const jobCount = document?.jobs.length ?? 0;
  const canLink = graph !== null && jobCount > 0 && graph.nodes.length >= 2;
  const headerActions = (
    <>
      {/* The workspace picker, then the job editor with the picked job: as Add from workspace on the Job list. */}
      <Button ref={addJobRef} variant="outline" size="sm" disabled={document === null || saving} onClick={() => setPicking(true)}>
        <Plus aria-hidden="true" />
        Add job
      </Button>
      <Button
        ref={addLinkRef}
        variant={link.step === "off" ? "outline" : "default"}
        size="sm"
        aria-pressed={link.step !== "off"}
        disabled={!canLink || saving}
        onClick={() => {
          setMenuEdge(null);
          setSelectedEdge(null);
          setDropped(null);
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

  // The selected box's panel, given its size where it opens: over the map's right side, or under a narrow map.
  const sidePanel =
    panelOpen && document
      ? (className: string | undefined) => (
          <MapSidePanel
            box={selected}
            document={document}
            links={allEdges.filter((e) => e.source === selected.id || e.target === selected.id)}
            steps={steps ?? new Map()}
            statusLoading={statusLoading}
            saving={saving}
            panelRef={panelRef}
            editRef={editRef}
            className={className}
            onRemove={(edgeId) => void removeLink(edgeId, "panel")}
            onSaveSettings={saveSettings}
            onRemoveJob={() => setRemoving(selected.name)}
            onEdit={() => {
              editedCardRef.current = boxButton(mapRef.current, selected.id);
              setEditing(selected.name);
            }}
            onClose={() => {
              setSelectedId(null);
              setRefocus({ kind: "box", id: selected.id });
            }}
          />
        )
      : null;

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
          {/* Escape works the same on the map and in a side panel opened under it. */}
          <div className="flex min-h-[520px] flex-1 flex-col gap-3" onKeyDown={onKeyDown} onFocus={onFocus}>
            {/* tabIndex -1: focus lands on the map itself when nothing on it can take it. */}
            <div
              ref={mapRef}
              tabIndex={-1}
              className="@container relative min-h-[520px] flex-1 overflow-hidden rounded-lg border border-border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MapMarkers />
              {/* Before the canvas, so Tab reaches the toolbar before the links and the cards. */}
              <Toolbar
                className="absolute top-3 left-3 z-10"
                direction={direction}
                onDirectionChange={changeDirection}
                showServices={showServices}
                onShowServicesChange={setShowServices}
                onFitted={() => setFits((n) => n + 1)}
                onTidy={tidy}
                tidyDisabled={!canMove || layout.positions.length === 0}
                onUndo={undo}
                undoDisabled={history.disabled}
                undoLabel={history.label}
              />
              <div className="absolute inset-0">
                {/* Until the direction's saved spots are in, card skeletons: no box shows in a spot it is about to leave. The toolbar stays. */}
                {layout.status === "loading" ? (
                  <SkeletonCards />
                ) : (
                  <ReactFlow<MapFlowNode, LinkFlowEdge>
                    nodes={flowNodes}
                    edges={flowEdges}
                    nodeTypes={NODE_TYPES}
                    edgeTypes={EDGE_TYPES}
                    // Also what gives the cards pointer events: React Flow turns them off on a node that is neither selectable nor clickable.
                    // Safari, and Firefox on macOS, do not focus a box on a click, and the arrow keys go to what has focus.
                    onNodeClick={(_event, node) => {
                      if (node.type === "section") {
                        clearOnCanvas();
                        return;
                      }
                      activate(node.data.box);
                      boxButton(mapRef.current, node.id)?.focus();
                    }}
                    // A pointer click selects a line, which shows its ×. Safari does not focus a line on a click, and Delete
                    // goes to what has focus.
                    onEdgeClick={(event, edge) => {
                      if (link.step !== "off") return;
                      setMenuEdge(null);
                      setSelectedEdge(edge.id);
                      if (event.currentTarget instanceof SVGElement) event.currentTarget.focus();
                    }}
                    onPaneClick={clearOnCanvas}
                    // A drag draws its box where the pointer has it, and saves the spot when it ends; it never saves a version.
                    onNodesChange={(changes) => {
                      for (const change of changes) if (change.type === "position" && change.position) moves.drag(change.id, change.position);
                    }}
                    onNodeDragStop={(_event, _node, dragged) => moves.drop(new Map(graph.nodes.map((n) => [n.id, n.position])), dragged)}
                    // Off unless a box turns it on (toFlowNode): job and service boxes, once the saved spots are in; never the group frame.
                    nodesDraggable={false}
                    // A press that moves under 4 pixels is a click: it selects the box and moves nothing. The click distance lets
                    // that click through; d3's drag would swallow the click after any movement otherwise.
                    nodeDragThreshold={4}
                    nodeClickDistance={4}
                    // A link is dragged from a box's port to another box's port or card; each end's port may start it. A
                    // click on a port does not start one.
                    nodesConnectable={canConnect}
                    connectionMode={ConnectionMode.Loose}
                    connectOnClick={false}
                    isValidConnection={(connection) => connection.source !== connection.target}
                    onConnectStart={(_event, { nodeId }) => {
                      dragFrom.current = nodeId;
                    }}
                    onConnect={onConnect}
                    onConnectEnd={onConnectEnd}
                    connectionLineComponent={DraftLine}
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
                    <MapMinimap panelOpen={panelOpen} />
                    <ViewKeeper
                      layoutKey={layoutKey}
                      chain={panelOpen ? [selected.id, ...(chain?.downstream.jobs ?? []).map(jobNodeId)] : null}
                      upstream={chain ? [...chain.upstream.nodes] : []}
                      fits={fits}
                    />
                    <Panel position="bottom-left" className="m-3">
                      <MapLegend />
                    </Panel>
                    {/* Adding a link clears the selection, so the banner takes the panel's corner, below the toolbar where both don't fit. */}
                    {link.step !== "off" ? (
                      <Panel position="top-right" className="m-3 @max-5xl:mt-14">
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
                    <PanelSlot placement="over" panel={sidePanel} />
                  </ReactFlow>
                )}
              </div>
              <LinkMenu link={menuLink} anchor={anchor} saving={saving} onRemove={(edgeId) => void removeLink(edgeId, "map")} onClose={closeMenu} />
              <NewLinkCard
                proposal={proposal}
                anchor={cardAnchor}
                document={state.document}
                saving={saving}
                keepOpenWithin={problemRef}
                onSave={saveDropped}
                onClose={closeDropped}
              />
            </div>
            <PanelSlot placement="under" panel={sidePanel} />
          </div>
        </ReactFlowProvider>
      </>
    );
  }

  return (
    // The page's own content, for Undo's keys. `contents` leaves its children in the layout's column, as before.
    <div ref={pageRef} className="contents">
      <PageHeader
        title="Dependency map"
        description="How the monitored jobs depend on each other and on services. Select a card to see what a failure there affects. Drag a card to move it, or drag from its dot to link it."
        actions={headerActions}
      />
      <ConfigBanner savedVersion={state ? state.version : undefined} />
      {problem ? (
        <div ref={problemRef}>
          <SaveProblem problem={problem} onReload={reload} onReloaded={() => setProblem(null)} />
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="-mt-2 font-mono text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {goneJob ? (
        <div role="status" className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-foreground">
          <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
          <p className="min-w-0 flex-1 leading-5">{goneJob} is no longer in the list. Someone deleted it while you were editing.</p>
          <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Dismiss" onClick={() => setGoneJob(null)}>
            <X aria-hidden="true" />
          </Button>
        </div>
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
      {layout.problem && graph ? (
        // The saved spots did not load (Retry asks again), or a move or a Tidy up was not saved.
        <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-destructive">
          <CircleAlert className="size-3.5" aria-hidden="true" />
          {layout.problem}
          {layout.status === "failed" ? (
            <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={layout.retry}>
              Retry
            </Button>
          ) : null}
        </p>
      ) : null}
      {history.problem ? (
        // An undo the rules refused: it left the stack, and this says why.
        <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-destructive">
          <CircleAlert className="size-3.5" aria-hidden="true" />
          {history.problem}
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
            onSave={(change) => void addLink(change).then(() => setLink({ step: "off" }))}
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
              void addLink(change).then((saved) => {
                setServiceOpen(false);
                // A new service shows on the map, even when the switch had hidden the services.
                if (saved) setShowServices(true);
              })
            }
          />
          <AddFromWorkspaceDialog open={picking} onOpenChange={setPicking} document={document} onPick={setAdding} returnFocus={addJobReturnFocus} />
        </>
      ) : null}
      {state && removing !== null ? (
        <DeleteJobDialog
          name={removing}
          document={state.document}
          version={state.version}
          onCancel={() => setRemoving(null)}
          onDelete={async (baseVersion) => {
            const outcome = await save({ kind: "delete", target: { type: "job", name: removing } }, baseVersion);
            if (outcome.ok) {
              setProblem(null);
              setNotice(`Saved version ${outcome.result.version}: ${outcome.result.summary}.`);
              setRemoving(null);
              setSelectedId(null);
              setRefocus({ kind: "map" });
            }
            return outcome;
          }}
          onReload={reload}
          returnFocus={editorReturnFocus}
        />
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
      {/* Add job's editor, opened by a pick in the workspace picker. A save selects the new job's box. */}
      {state ? (
        <JobEditorSheet
          open={adding !== null}
          onOpenChange={(open) => {
            if (!open) setAdding(null);
          }}
          mode="create"
          initial={adding ?? { job_name: "" }}
          document={state.document}
          version={state.version}
          onSave={saveNewJob}
          renderPatternPreview={patternPreview}
          onReload={reload}
          returnFocus={addJobReturnFocus}
        />
      ) : null}
    </div>
  );
}

/** The canvas while the job list loads: the toolbar's and a few cards' skeletons on the dot grid. */
function CanvasSkeleton() {
  return (
    <div className="relative min-h-[520px] flex-1 overflow-hidden rounded-lg border border-border bg-muted">
      <SkeletonCards />
      {/* As wide as the toolbar it stands for, so nothing shifts when the map comes in. */}
      <Skeleton className="absolute top-3 left-3 h-9 w-[464px] rounded-full" />
    </div>
  );
}

/** A few cards' and the legend's skeletons on the dot grid: under a loading job list, and on the map while its saved spots load. */
function SkeletonCards() {
  return (
    <div className="absolute inset-0 bg-[radial-gradient(var(--input)_1px,transparent_1.2px)] bg-size-[16px_16px]">
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

/** The toolbar with the fit for the canvas's width, which only the map's store knows. */
function Toolbar(props: Omit<MapToolbarProps, "fitOptions">) {
  const width = useStore((state) => state.width);
  return <MapToolbar {...props} fitOptions={fitOptions(width)} />;
}

interface MapMinimapProps {
  panelOpen: boolean;
}

/** The minimap, hidden while the side panel is open over the map's right side, which would cover all but a sliver of it. */
function MapMinimap({ panelOpen }: MapMinimapProps) {
  const width = useStore((state) => state.width);
  return (
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
      className={cn(
        "m-3 overflow-hidden rounded-lg border border-border shadow-[0_1px_2px_rgb(27_49_57/0.06)] @max-2xl:hidden [&>svg]:h-[120px] [&>svg]:w-[160px]",
        panelOpen && !panelGoesUnder(width) && "hidden",
      )}
    />
  );
}

interface PanelSlotProps {
  placement: "over" | "under";
  /** The side panel, given its size here; null when no box is selected. */
  panel: ((className: string | undefined) => ReactNode) | null;
}

/**
 * Where the side panel opens: over the map's right side, or under a map too
 * narrow for both, where the panel would hide the selection's chain. One of
 * the two slots shows it.
 */
function PanelSlot({ placement, panel }: PanelSlotProps) {
  const width = useStore((state) => state.width);
  if (panel === null || (placement === "under") !== panelGoesUnder(width)) return null;
  if (placement === "under") return panel("w-full");
  return (
    // Down the right, over the minimap's corner when it needs the height, and below the toolbar where both don't fit
    // side by side; the frame lets clicks through around the panel.
    <Panel position="top-right" className="pointer-events-none bottom-0 m-3 flex items-start @max-4xl:mt-14">
      {panel(undefined)}
    </Panel>
  );
}

/** A slide the map made to bring a selection out from under the side panel. */
interface Slide {
  from: Viewport;
  to: Viewport;
  /** Until when its glide may still run: a slide that starts before then goes on from the same place. */
  until: number;
}

/** The same view, to half a pixel. */
function sameView(a: Viewport, b: Viewport): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.zoom - b.zoom) < 1e-6;
}

interface ViewKeeperProps {
  /** Changes when the view should fit the layout again. */
  layoutKey: string;
  /** The selected box first, then the boxes its failure affects, while the side panel is open; else null. */
  chain: string[] | null;
  /** The boxes upstream of it, brought into view too when the whole chain fits. */
  upstream: string[];
  /** Counts the toolbar's finished fits. */
  fits: number;
}

/**
 * Keeps the view sensible as the map changes:
 * - fits it again when the layout key changes (the automatic layout changes:
 *   boxes come or go, a link edit moves them, the direction or the services
 *   switch; Tidy up; the saved spots load; never a box someone moved) or the
 *   map's area changes size (an alert or a note above it, or the window), as
 *   if the side panel were closed: a fit never zooms for the panel;
 * - while the panel is open over the map, slides the map left at the same zoom
 *   so the selected box and what its failure affects clear the panel (its
 *   upstream path too, when all of it fits), never so far that the selected
 *   box leaves the screen: after a new selection, a refit or the toolbar's Fit;
 * - when the panel closes, slides back to where the slides began, unless the
 *   person moved the view since.
 * The first fit is the fitView prop's, which runs before the size is known.
 */
function ViewKeeper({ layoutKey, chain, upstream, fits }: ViewKeeperProps) {
  const { fitView, getInternalNode, getViewport, setViewport } = useReactFlow();
  // The size of the drawing area, which React Flow measures on every resize.
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const first = useRef(true);
  const slide = useRef<Slide | null>(null);

  // These read the newest chain and size when they run.
  const reveal = useEffectEvent(() => {
    if (chain === null || width < PANEL_OVER_FROM) return;
    const view = getViewport();
    /** The boxes' left and right edges on screen. */
    const span = (list: string[]) => {
      let left = Infinity;
      let right = -Infinity;
      for (const id of list) {
        const node = getInternalNode(id);
        if (!node) continue;
        left = Math.min(left, view.x + node.internals.positionAbsolute.x * view.zoom);
        right = Math.max(right, view.x + (node.internals.positionAbsolute.x + (node.measured.width ?? node.width ?? 0)) * view.zoom);
      }
      return { left, right };
    };
    const edge = width - (OVERLAY.inset + OVERLAY.panel + EDGE_GAP.panel);
    const selected = span(chain.slice(0, 1));
    const all = span([...chain, ...upstream]);
    const target = all.right - all.left <= edge - EDGE_GAP.left ? all : span(chain);
    if (!Number.isFinite(selected.left) || target.right <= edge) return;
    // The whole chain when it fits; otherwise as far as the selected box allows.
    const shift = Math.min(target.right - edge, (target === all ? all.left : selected.left) - EDGE_GAP.left);
    if (!(shift > 0)) return;
    const duration = viewDuration();
    const to = { x: view.x - shift, y: view.y, zoom: view.zoom };
    const last = slide.current;
    // Slides add up while the person leaves the view alone, so closing the panel goes back to where the first began.
    const from = last !== null && (sameView(view, last.to) || Date.now() < last.until) ? last.from : view;
    slide.current = { from, to, until: Date.now() + duration + 80 };
    // A straight glide: the smooth path would zoom out and back in on the way.
    void setViewport(to, { duration, interpolate: "linear" });
  });
  const slideBack = useEffectEvent(() => {
    const last = slide.current;
    slide.current = null;
    if (last !== null && sameView(getViewport(), last.to)) void setViewport(last.from, { duration: viewDuration(), interpolate: "linear" });
  });
  const refit = useEffectEvent(() => {
    slide.current = null;
    // Instant, so the slide after it starts from the new fit.
    void fitView(fitOptions(width)).then(() => reveal());
  });
  const afterFit = useEffectEvent(() => {
    slide.current = null;
    reveal();
  });

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // After React Flow has taken the new nodes into its store.
    const frame = window.requestAnimationFrame(() => refit());
    return () => window.cancelAnimationFrame(frame);
  }, [layoutKey, width, height]);

  // A new selection, a save that changed its chain, or the panel closing; not a re-render with the same chain.
  const key = chain?.join("|") ?? null;
  useEffect(() => {
    // After the panel is drawn, or gone.
    const frame = window.requestAnimationFrame(() => (key === null ? slideBack() : reveal()));
    return () => window.cancelAnimationFrame(frame);
  }, [key]);

  useEffect(() => {
    if (fits === 0) return;
    const frame = window.requestAnimationFrame(() => afterFit());
    return () => window.cancelAnimationFrame(frame);
  }, [fits]);
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
