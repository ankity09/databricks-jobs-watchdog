/**
 * The deep link into the copilot from a job on the Monitoring page:
 * /copilot?job=<name>&workspace=<id>&status=<status>. The copilot fills in a
 * question about that job and waits for the person to send it.
 */

export interface CopilotLinkTarget {
  job: string;
  workspace?: string | null;
  status?: string | null;
}

/** The copilot address for a question about one job. */
export function copilotLink({ job, workspace, status }: CopilotLinkTarget): string {
  const params = new URLSearchParams({ job });
  if (workspace) params.set("workspace", workspace);
  if (status) params.set("status", status);
  return `/copilot?${params.toString()}`;
}

/** The question a deep link fills in, or "" when the link names no job. */
export function questionFromLink(params: URLSearchParams): string {
  const job = params.get("job")?.trim();
  if (!job) return "";
  const workspace = params.get("workspace")?.trim();
  const where = workspace ? ` in workspace ${workspace}` : "";
  switch (params.get("status")?.trim().toUpperCase()) {
    case "FAILED":
      return `Why is ${job} failing${where}, and what does it affect?`;
    case "WARNING":
      return `Why does ${job} have a warning${where}, and what should I check?`;
    case "UNKNOWN":
      return `Why can the Watchdog not tell the status of ${job}${where}?`;
    default:
      return `What is the status of ${job}${where}?`;
  }
}
