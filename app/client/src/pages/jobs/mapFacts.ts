import type { JobEntry, JobListDocument, ScheduleType } from "../../../../shared/joblist/types";
import { type InheritedSettings, type NumberKey, blocksDefault, inheritedSettings } from "../../lib/job-form";

/** A job's settings as the map shows them: each from the job, or from the defaults. */

export const SCHEDULE_LABEL: Record<ScheduleType, string> = { scheduled: "Scheduled", continuous: "Continuous", triggered: "Triggered" };

/** What a job's card says under its name, and whether it carries the severity marker. */
export interface CardFacts {
  /** "" when the job has no owner. */
  owner: string;
  schedule: ScheduleType;
  critical: boolean;
}

/** A job's owner: its own, else the default, and "" when an own null or "" switches the default off. */
function ownerOf(job: JobEntry, inherited: InheritedSettings): string {
  return blocksDefault(job, "owner") ? "" : (job.owner ?? inherited.owner);
}

/** The facts on each listed job's card, by job name. */
export function cardFacts(doc: JobListDocument): Map<string, CardFacts> {
  const inherited = inheritedSettings(doc);
  return new Map(
    doc.jobs.map((job) => [
      job.job_name,
      {
        owner: ownerOf(job, inherited),
        schedule: job.schedule_type ?? inherited.schedule_type,
        critical: (job.severity ?? inherited.severity) === "CRITICAL",
      },
    ]),
  );
}

/** One line of the side panel's details: the value, and whether the job takes it from the defaults. */
export interface Detail {
  text: string;
  inherited: boolean;
}

export interface JobDetails {
  owner: Detail;
  schedule: Detail;
  severity: Detail;
  maxGap: Detail;
  maxRuntime: Detail;
  maxRetries: Detail;
  enabled: Detail;
}

const NONE: Detail = { text: "None", inherited: false };

function limit(job: JobEntry, inherited: InheritedSettings, key: NumberKey, unit: string): Detail {
  // A saved null switches the default off: the job has no such limit.
  if (blocksDefault(job, key)) return NONE;
  const own = job[key];
  const value = own ?? inherited.numbers[key];
  return typeof value === "number" ? { text: `${value}${unit}`, inherited: own === undefined } : NONE;
}

/**
 * A job's settings for the side panel, the way the Job list reads them: a
 * continuous job takes only its own gap (30 minutes when unset), a triggered
 * job has none, and Enabled names the environments that differ.
 */
export function jobDetails(job: JobEntry, inherited: InheritedSettings): JobDetails {
  const schedule = job.schedule_type ?? inherited.schedule_type;
  let maxGap: Detail;
  if (schedule === "triggered") maxGap = NONE;
  else if (schedule === "continuous") maxGap = { text: `${job.max_gap_minutes ?? 30} min`, inherited: false };
  else maxGap = limit(job, inherited, "max_gap_minutes", " min");

  const owner = ownerOf(job, inherited);
  const enabled = job.enabled ?? inherited.enabled;
  const differ = Object.entries(job.environments ?? {})
    .filter(([, overrides]) => typeof overrides?.enabled === "boolean" && overrides.enabled !== enabled)
    .map(([label]) => label);
  let enabledText = enabled ? "Yes" : "No";
  if (differ.length > 0) enabledText += `, ${enabled ? "off" : "on"} in ${differ.join(", ")}`;

  return {
    owner: owner === "" ? { text: "Not set", inherited: false } : { text: owner, inherited: job.owner === undefined },
    schedule: { text: SCHEDULE_LABEL[schedule], inherited: job.schedule_type === undefined },
    severity: { text: job.severity ?? inherited.severity, inherited: job.severity === undefined },
    maxGap,
    maxRuntime: limit(job, inherited, "max_runtime_minutes", " min"),
    maxRetries: limit(job, inherited, "max_retries", ""),
    enabled: { text: enabledText, inherited: job.enabled === undefined },
  };
}
