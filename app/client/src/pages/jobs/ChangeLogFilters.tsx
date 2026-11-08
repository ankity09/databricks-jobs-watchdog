import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  ToggleGroup,
  ToggleGroupItem,
} from "@databricks/appkit-ui/react";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { CHANGE_KINDS, type VersionFacets } from "../../../../shared/joblist/types";
import { type ChangeFilters, presetFrom, presetOf, type WhenPreset } from "../../lib/changeFilters";
import { cn } from "../../lib/utils";
import { KIND_CHIP_ON, KIND_LABEL } from "./changeKinds";

/** How long typing in Search waits before the list is asked again. */
export const SEARCH_DELAY_MS = 300;

/** The people, jobs and kinds to pick from. A failed load leaves the list working: the controls say so and offer Retry. */
export interface FacetsState {
  facets: VersionFacets | null;
  failed: boolean;
  retry: () => void;
}

export interface ChangeLogFiltersProps {
  filters: ChangeFilters;
  facets: FacetsState;
  onChange: (patch: Partial<ChangeFilters>) => void;
  /** A new value starts the Search box again, dropping text that is still waiting to be sent. */
  resetKey?: number;
}

/** Radix Select keeps "" for "no value", so "anyone" has a value of its own. */
const ANYONE = "__anyone__";

const WHEN_LABEL: Record<WhenPreset, string> = {
  any: "Any time",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  custom: "Custom",
};
const WHEN_ORDER: WhenPreset[] = ["any", "24h", "7d", "30d", "custom"];

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function OptionsProblem({ retry }: { retry: () => void }) {
  return (
    <div className="flex h-8 items-center gap-2 text-[13px] text-destructive">
      Couldn&apos;t load the options
      <Button variant="link" size="sm" className="h-auto p-0 text-[13px]" onClick={retry}>
        Retry
      </Button>
    </div>
  );
}

/** The filter bar of the change log: who, what kind of change, which job, when, and a text search. */
export function ChangeLogFilters({ filters, facets, onChange, resetKey = 0 }: ChangeLogFiltersProps) {
  const id = useId();
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3" role="search" aria-label="Filter the change log">
      <Field label="Who">
        <WhoSelect value={filters.person} facets={facets} onChange={(person) => onChange({ person })} />
      </Field>
      <Field label="Change">
        <ToggleGroup
          type="multiple"
          variant="outline"
          size="sm"
          spacing={1}
          aria-label="Kinds of change"
          value={filters.kinds}
          onValueChange={(next) => onChange({ kinds: CHANGE_KINDS.filter((kind) => next.includes(kind)) })}
        >
          {CHANGE_KINDS.map((kind) => (
            <ToggleGroupItem
              key={kind}
              value={kind}
              className={cn("h-8 rounded-md! border px-2.5 text-[13px] font-normal", KIND_CHIP_ON[kind])}
            >
              {KIND_LABEL[kind]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>
      <Field label="Job">
        <JobCombobox value={filters.job} facets={facets} onChange={(job) => onChange({ job })} />
      </Field>
      <WhenFields id={id} filters={filters} onChange={onChange} />
      <Field label="Search" htmlFor={`${id}-search`}>
        <SearchBox key={resetKey} id={`${id}-search`} value={filters.q} onCommit={(q) => onChange({ q })} />
      </Field>
    </div>
  );
}

function WhoSelect({ value, facets, onChange }: { value: string | null; facets: FacetsState; onChange: (person: string | null) => void }) {
  if (facets.facets === null) {
    return facets.failed ? <OptionsProblem retry={facets.retry} /> : <Skeleton className="h-8 w-48" />;
  }
  const people = facets.facets.people;
  // A person in the URL who is not listed stays in the list, so the select says what the filter is.
  const shown = value !== null && !people.some((p) => p.email === value) ? [...people, { email: value, count: 0 }] : people;
  return (
    <Select value={value ?? ANYONE} onValueChange={(next) => onChange(next === ANYONE ? null : next)}>
      <SelectTrigger size="sm" aria-label="Who" className={cn("h-8 w-56 bg-background text-[13px]", value !== null && "border-foreground/30")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANYONE}>Anyone</SelectItem>
        {shown.map((person) => (
          <SelectItem key={person.email} value={person.email}>
            <span className="font-mono text-xs">{person.email}</span>
            <span className="font-mono text-xs text-muted-foreground">{person.count}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function JobCombobox({ value, facets, onChange }: { value: string | null; facets: FacetsState; onChange: (job: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const jobs = facets.facets?.jobs ?? [];
  const name = typed.trim();
  // The typed text is offered as it is when it is not a listed job: a name the list lacks still works.
  const offerTyped = name !== "" && !jobs.some((job) => job.name === name);
  const pick = (job: string | null) => {
    onChange(job);
    setOpen(false);
    setTyped("");
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setTyped("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-label="Job"
          aria-expanded={open}
          className={cn("h-8 w-56 justify-between bg-background px-3 text-[13px] font-normal", value !== null && "border-foreground/30")}
        >
          <span className={cn("truncate", value !== null && "font-mono text-xs")}>{value ?? "Any job"}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Find or type a job name" value={typed} onValueChange={setTyped} />
          {facets.facets === null && facets.failed ? (
            <div className="border-b border-border px-3 py-2">
              <OptionsProblem retry={facets.retry} />
            </div>
          ) : null}
          <CommandList>
            {offerTyped ? null : (
              <CommandEmpty>{facets.facets === null && !facets.failed ? "Loading the jobs..." : "No job has this name."}</CommandEmpty>
            )}
            {value !== null || offerTyped ? (
              // forceMount: these two always show, whatever the typed text filters out of the list below.
              <CommandGroup forceMount>
                {value !== null ? (
                  <CommandItem value="__any_job__" forceMount onSelect={() => pick(null)}>
                    Any job
                  </CommandItem>
                ) : null}
                {offerTyped ? (
                  <CommandItem value={`__typed__${name}`} forceMount onSelect={() => pick(name)}>
                    Use <span className="font-mono text-xs">{name}</span>
                  </CommandItem>
                ) : null}
              </CommandGroup>
            ) : null}
            <CommandGroup>
              {jobs.map((job) => (
                <CommandItem key={job.name} value={job.name} onSelect={() => pick(job.name)}>
                  <Check className={cn("size-3.5", job.name === value ? "opacity-100" : "opacity-0")} aria-hidden="true" />
                  <span className="truncate font-mono text-xs">{job.name}</span>
                  <span className="ml-auto font-mono text-xs text-muted-foreground">{job.count}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function WhenFields({ id, filters, onChange }: { id: string; filters: ChangeFilters; onChange: (patch: Partial<ChangeFilters>) => void }) {
  // "Custom" with no dates yet is only on the page: the URL holds dates, never the preset's name.
  const [customOpen, setCustomOpen] = useState(false);
  const preset = presetOf(filters, new Date());
  const shown: WhenPreset = customOpen && preset === "any" ? "custom" : preset;
  return (
    <>
      <Field label="When">
        <Select
          value={shown}
          onValueChange={(next) => {
            const when = WHEN_ORDER.find((option) => option === next) ?? "any";
            setCustomOpen(when === "custom");
            if (when === "any") onChange({ from: null, to: null });
            else if (when === "custom") onChange(preset === "any" || preset === "custom" ? {} : { to: null });
            else onChange({ from: presetFrom(when, new Date()), to: null });
          }}
        >
          <SelectTrigger size="sm" aria-label="When" className={cn("h-8 w-40 bg-background text-[13px]", shown !== "any" && "border-foreground/30")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WHEN_ORDER.map((option) => (
              <SelectItem key={option} value={option}>
                {WHEN_LABEL[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {shown === "custom" ? (
        <>
          <Field label="From" htmlFor={`${id}-from`}>
            <Input
              id={`${id}-from`}
              type="date"
              className="h-8 w-40 bg-background font-mono text-xs"
              value={filters.from?.slice(0, 10) ?? ""}
              max={filters.to?.slice(0, 10) || undefined}
              onChange={(event) => onChange({ from: event.target.value || null })}
            />
          </Field>
          <Field label="To" htmlFor={`${id}-to`}>
            <Input
              id={`${id}-to`}
              type="date"
              className="h-8 w-40 bg-background font-mono text-xs"
              value={filters.to?.slice(0, 10) ?? ""}
              min={filters.from?.slice(0, 10) || undefined}
              onChange={(event) => onChange({ to: event.target.value || null })}
            />
          </Field>
        </>
      ) : null}
    </>
  );
}

/** A text input that tells the page what was typed once typing pauses for SEARCH_DELAY_MS. */
function SearchBox({ id, value, onCommit }: { id: string; value: string; onCommit: (q: string) => void }) {
  const [text, setText] = useState(value);
  // The last text the page has, as this box knows it: a different value from outside (Clear, the back button) replaces what is typed.
  const [told, setTold] = useState(value);
  if (value !== told) {
    setTold(value);
    setText(value);
  }
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The page re-renders with new filters meanwhile (a chip pressed): the pause ends with the latest onCommit, not the one it started with.
  const commit = useRef(onCommit);
  useEffect(() => {
    commit.current = onCommit;
  });
  useEffect(() => {
    clearTimeout(timer.current);
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input
        id={id}
        type="search"
        autoComplete="off"
        placeholder="Search summaries"
        className="h-8 w-56 bg-background pl-8 text-[13px]"
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            const q = next.trim();
            setTold(q);
            commit.current(q);
          }, SEARCH_DELAY_MS);
        }}
      />
    </div>
  );
}

/** Clear filters: sets every filter back to none. */
export function ClearFiltersButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <Button variant="ghost" size="sm" className={cn("h-7 gap-1 px-2 text-[13px] text-muted-foreground", className)} onClick={onClick}>
      <X aria-hidden="true" />
      Clear filters
    </Button>
  );
}
