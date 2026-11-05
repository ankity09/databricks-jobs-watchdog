import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@databricks/appkit-ui/react";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { SEVERITY_LABEL } from "./format";
import { type FilterOption, type FilterOptions, hasFilters, type JobFilterValue, NO_FILTERS, SEVERITIES, type Severity } from "./jobs";

/** Radix Select keeps "" for "no value", so "all" has a value of its own. */
const ALL = "__all__";

interface FilterSelectProps {
  label: string;
  allLabel: string;
  value: string | null;
  options: FilterOption[];
  onChange(this: void, value: string | null): void;
}

function FilterSelect({ label, allLabel, value, options, onChange }: FilterSelectProps) {
  const chosen = options.find((option) => option.value === value);
  return (
    <Select value={value ?? ALL} onValueChange={(next) => onChange(next === ALL ? null : next)}>
      <SelectTrigger
        size="sm"
        aria-label={label}
        className={cn("h-8 min-w-36 max-w-60 bg-background text-[13px]", chosen && "border-foreground/30 text-foreground")}
      >
        <SelectValue>{chosen ? `${label}: ${chosen.label}` : allLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const SEVERITY_OPTIONS: FilterOption[] = SEVERITIES.map((severity) => ({ value: severity, label: SEVERITY_LABEL[severity] }));

function toSeverity(value: string | null): Severity | null {
  return SEVERITIES.find((severity) => severity === value) ?? null;
}

export interface JobFiltersProps {
  options: FilterOptions;
  value: JobFilterValue;
  onChange(this: void, value: JobFilterValue): void;
  /** Jobs that pass the filters, and all jobs. */
  shown: number;
  total: number;
}

/** The environment, owner, severity and workspace filters, and how many jobs they leave. */
export function JobFilters({ options, value, onChange, shown, total }: JobFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterSelect label="Environment" allLabel="All environments" value={value.environment} options={options.environments} onChange={(environment) => onChange({ ...value, environment })} />
      <FilterSelect label="Owner" allLabel="All owners" value={value.owner} options={options.owners} onChange={(owner) => onChange({ ...value, owner })} />
      <FilterSelect label="Severity" allLabel="All severities" value={value.severity} options={SEVERITY_OPTIONS} onChange={(severity) => onChange({ ...value, severity: toSeverity(severity) })} />
      <FilterSelect label="Workspace" allLabel="All workspaces" value={value.workspace} options={options.workspaces} onChange={(workspace) => onChange({ ...value, workspace })} />
      {hasFilters(value) ? (
        <Button variant="ghost" size="sm" className="h-8 text-[13px] text-muted-foreground" onClick={() => onChange(NO_FILTERS)}>
          <X aria-hidden="true" />
          Clear filters
        </Button>
      ) : null}
      <p className="ml-auto text-[13px] text-muted-foreground" aria-live="polite">
        Showing <span className="font-mono text-foreground tabular-nums">{shown}</span> of <span className="font-mono tabular-nums">{total}</span> {total === 1 ? "job" : "jobs"}
      </p>
    </div>
  );
}
