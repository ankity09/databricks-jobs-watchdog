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

/**
 * Whether a job filter matches a change target. This is the filter's rule, and the SQL in pg-repo.ts says the same
 * thing: the job's own `job:<name>`; a link whose left end is the job (the text after `dependency:` starts with
 * `<name>->`); or a job or child_job link whose right end is the job (the text after the first `->` is `<name>:job` or
 * `<name>:child_job`). A job name that holds `->` is read by these two string tests, not by splitting the link.
 */
export function targetMentionsJob(target: string | null, job: string): boolean {
  if (target === null) return false;
  if (target === `job:${job}`) return true;
  if (!target.startsWith("dependency:")) return false;
  if (target.startsWith(`dependency:${job}->`)) return true;
  const arrow = target.indexOf("->");
  const right = arrow < 0 ? "" : target.slice(arrow + 2);
  return right === `${job}:job` || right === `${job}:child_job`;
}
