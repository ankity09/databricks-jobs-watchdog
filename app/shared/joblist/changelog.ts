/** Which jobs a version's `change_target` touches. Shared by the in-memory repo and the facets. */

/**
 * The job names in a change target:
 * - `job:<name>` gives the name;
 * - `dependency:<job>-><depends_on>:<type>` gives the left end, and the right end too unless the type is `service`
 *   (a service is not a job);
 * - anything else (workspace, defaults, null) gives none.
 */
export function jobsInTarget(target: string | null): string[] {
  if (target === null) return [];
  if (target.startsWith("job:")) {
    const name = target.slice(4);
    return name === "" ? [] : [name];
  }
  if (!target.startsWith("dependency:")) return [];
  const rest = target.slice("dependency:".length);
  const colon = rest.lastIndexOf(":");
  if (colon < 0) return [];
  const type = rest.slice(colon + 1);
  const link = rest.slice(0, colon);
  const arrow = link.indexOf("->");
  if (arrow < 0) return [];
  const left = link.slice(0, arrow);
  const right = link.slice(arrow + 2);
  const names = type === "service" ? [left] : [left, right];
  return [...new Set(names.filter((name) => name !== ""))];
}
