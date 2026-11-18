import { type Change, type DependencyEntry, type JobListDocument, dependencyKey } from "../../../shared/joblist/types";

/** A box on the map, by what it is and its name: a job and a service may share a name. */
export interface MapNodeRef {
  kind: "job" | "service";
  name: string;
}

/** What a link dragged between two boxes would be, or why it can't be made. */
export type LinkProposal = { ok: true; jobName: string; dependsOn: string; service: boolean } | { ok: false; reason: string };

function sameBox(a: MapNodeRef, b: MapNodeRef): boolean {
  return a.kind === b.kind && a.name === b.name;
}

/** The boxes a link joins, as the map draws it: from what is depended on (a service for a service link) to the job. */
function ends(dependency: DependencyEntry): [MapNodeRef, MapNodeRef] {
  const upstream: MapNodeRef = { kind: (dependency.dependency_type ?? "job") === "service" ? "service" : "job", name: dependency.depends_on };
  return [upstream, { kind: "job", name: dependency.job_name }];
}

/**
 * The link a drag from one box to another proposes. Between two jobs, the box
 * the drag went to depends on the box it came from. With a service, the job
 * depends on the service, whichever way the drag went. Refused: a box to
 * itself, two services, and two boxes a link already joins, either way round.
 */
export function proposeLink(document: JobListDocument, from: MapNodeRef, to: MapNodeRef): LinkProposal {
  if (sameBox(from, to)) return { ok: false, reason: "A box can't link to itself." };
  if (from.kind === "service" && to.kind === "service") return { ok: false, reason: "Two services can't be linked." };
  const linked = (document.dependencies ?? []).some((dependency) => {
    const [upstream, downstream] = ends(dependency);
    return (sameBox(upstream, from) && sameBox(downstream, to)) || (sameBox(upstream, to) && sameBox(downstream, from));
  });
  if (linked) return { ok: false, reason: "These two are already linked." };
  if (from.kind === "service") return { ok: true, jobName: to.name, dependsOn: from.name, service: true };
  if (to.kind === "service") return { ok: true, jobName: from.name, dependsOn: to.name, service: true };
  return { ok: true, jobName: to.name, dependsOn: from.name, service: false };
}

/** True when the job list already has the link a change adds: the same two ends and the same type. */
export function linkExists(document: JobListDocument, change: Change): boolean {
  if (change.target.type !== "dependency") return false;
  const key = change.target.key;
  return (document.dependencies ?? []).some((d) => dependencyKey(d) === key);
}
