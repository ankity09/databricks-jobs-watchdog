import type { DependencyType, Target } from "../../../shared/joblist/types";

/** The section a change target belongs to, as the job list pages name it. */
export type TargetSection = "Defaults" | "Workspace label" | "Job" | "Link";

export interface DescribedTarget {
  section: TargetSection | null;
  /** The job name, the link as "a -> b (type)", the workspace ID or name; empty for the defaults. */
  name: string;
}

const LINK_TYPES: Record<DependencyType, string> = { job: "job", child_job: "child job", service: "service" };

function isDependencyType(value: string): value is DependencyType {
  return value === "job" || value === "child_job" || value === "service";
}

/**
 * A target key from targetKey() (job:<name>, dependency:<a>-><b>:<type>,
 * workspace:<key>, defaults) as a section and a name. A key that does not
 * parse is shown as it is.
 */
export function describeTarget(target: string): DescribedTarget {
  if (target === "defaults") return { section: "Defaults", name: "" };
  const colon = target.indexOf(":");
  const kind = colon < 0 ? target : target.slice(0, colon);
  const rest = colon < 0 ? "" : target.slice(colon + 1);
  if (kind === "job") return { section: "Job", name: rest };
  if (kind === "workspace") return { section: "Workspace label", name: rest };
  if (kind === "dependency") {
    // <job_name>-><depends_on>:<type>; a service name may hold a colon, so the type follows the last one.
    const arrow = rest.indexOf("->");
    const typeAt = rest.lastIndexOf(":");
    const type = typeAt < 0 ? "" : rest.slice(typeAt + 1);
    if (arrow > 0 && typeAt > arrow && isDependencyType(type)) {
      return { section: "Link", name: `${rest.slice(0, arrow)} -> ${rest.slice(arrow + 2, typeAt)} (${LINK_TYPES[type]})` };
    }
  }
  return { section: null, name: target };
}

/** A target key back as a Target, so its entry can be looked up in a document. Null when the key does not parse. */
export function parseTargetKey(key: string): Target | null {
  if (key === "defaults") return { type: "defaults" };
  const colon = key.indexOf(":");
  if (colon < 0) return null;
  const kind = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  if (rest === "") return null;
  if (kind === "job") return { type: "job", name: rest };
  if (kind === "dependency") return { type: "dependency", key: rest };
  if (kind === "workspace") return { type: "workspace", key: rest };
  return null;
}

/** A setting's value as one line of text: "unset" when missing, lists and mappings in YAML's flow style. */
export function formatValue(value: unknown): string {
  if (value === undefined) return "unset";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, item]) => `${key}: ${formatValue(item)}`)
      .join(", ")}}`;
  }
  return typeof value;
}
