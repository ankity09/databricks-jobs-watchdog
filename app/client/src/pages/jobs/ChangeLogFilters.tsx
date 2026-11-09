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

/** How long a date box waits after the last change before it tells the page. */
export const DATE_DELAY_MS = 500;

/** The people, jobs and kinds to pick from. A failed load leaves the list working: the controls say so and offer Retry. */
export interface FacetsState {
  facets: VersionFacets | null;
  failed: boolean;
  retry: () => void;
}

export interface ChangeLogFiltersProps {
  filters: ChangeFilters;
  facets: FacetsState;
  /** `replace`: this change takes the place of the history entry, instead of adding one. */
  onChange: (patch: Partial<ChangeFilters>, replace?: boolean) => void;
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
    <div className="flex flex-wrap items-end gap-x-3 gap-y-3" role="search" aria-label="Filter the change log">
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
              className={cn("h-8 gap-1 rounded-md! border px-1.5 text-[13px] font-normal data-[state=on]:font-medium", KIND_CHIP_ON[kind])}
            >
              {filters.kinds.includes(kind) ? <Check className="size-3" aria-hidden="true" /> : null}
              {KIND_LABEL[kind]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>
      <Field label="Job">
        <JobCombobox value={filters.job} facets={facets} onChange={(job) => onChange({ job })} />
      </Field>
      <WhenFields key={resetKey} id={id} filters={filters} onChange={onChange} />
      <Field label="Search" htmlFor={`${id}-search`}>
        <SearchBox key={resetKey} id={`${id}-search`} value={filters.q} focusOnMount={resetKey > 0} onCommit={(q) => onChange({ q }, true)} />
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
      <SelectTrigger size="sm" aria-label="Who" className={cn("h-8 w-48 bg-background text-[13px]", value !== null && "border-foreground/30")}>
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
          className={cn("h-8 w-44 justify-between bg-background px-3 text-[13px] font-normal", value !== null && "border-foreground/30")}
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

function WhenFields({ id, filters, onChange }: { id: string; filters: ChangeFilters; onChange: (patch: Partial<ChangeFilters>, replace?: boolean) => void }) {
  // "Custom" with no dates yet is only on the page: the URL holds dates, never the preset's name.
  const [customOpen, setCustomOpen] = useState(false);
  const preset = presetOf(filters, new Date());
  // Once Custom is picked it stays while the dates are typed, even when they happen to match a preset.
  const shown: WhenPreset = customOpen ? "custom" : preset;
  return (
    <>
      <Field label="When">
        <Select
          value={shown}
          onValueChange={(next) => {
            const when = WHEN_ORDER.find((option) => option === next) ?? "any";
            setCustomOpen(when === "custom");
            if (when === "any") onChange({ from: null, to: null });
            // A preset becomes the dates the inputs show (a 24-hour date-time becomes its date); from Any time there is nothing to change.
            else if (when === "custom") onChange(preset === "any" || preset === "custom" ? {} : { from: filters.from?.slice(0, 10) ?? null, to: null });
            else onChange({ from: presetFrom(when, new Date()), to: null });
          }}
        >
          <SelectTrigger size="sm" aria-label="When" className={cn("h-8 w-36 bg-background text-[13px]", shown !== "any" && "border-foreground/30")}>
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
            <DateBox
              id={`${id}-from`}
              value={filters.from?.slice(0, 10) ?? ""}
              max={filters.to?.slice(0, 10) || undefined}
              // A From after To would match nothing: To moves with it.
              onCommit={(from) => onChange(from !== null && filters.to !== null && from > filters.to.slice(0, 10) ? { from, to: from } : { from }, true)}
            />
          </Field>
          <Field label="To" htmlFor={`${id}-to`}>
            <DateBox
              id={`${id}-to`}
              value={filters.to?.slice(0, 10) ?? ""}
              min={filters.from?.slice(0, 10) || undefined}
              onCommit={(to) => onChange(to !== null && filters.from !== null && to < filters.from.slice(0, 10) ? { from: to, to } : { to }, true)}
            />
          </Field>
        </>
      ) : null}
    </>
  );
}

/**
 * A date input that tells the page when typing pauses for DATE_DELAY_MS on a complete date with a four-digit year,
 * or when the box is left. Chrome reports every step on the way: editing 2026-11-09 to 2026-11-05 passes through
 * 2026-01-09, and a year goes 0002, 0020, 0202, 2026. A step is not a date to filter by, and the other bound moves
 * only for a date the person meant.
 */
function DateBox({ id, value, min, max, onCommit }: { id: string; value: string; min?: string; max?: string; onCommit: (date: string | null) => void }) {
  const [text, setText] = useState(value);
  const [told, setTold] = useState(value);
  if (value !== told) {
    setTold(value);
    setText(value);
  }
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commit = useRef(onCommit);
  useEffect(() => {
    commit.current = onCommit;
  });
  useEffect(() => () => clearTimeout(timer.current), []);
  const usable = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number(date.slice(0, 4)) >= 1000;
  const send = (date: string | null) => {
    setTold(date ?? "");
    commit.current(date);
  };
  return (
    <Input
      id={id}
      type="date"
      className="h-8 w-40 bg-background font-mono text-xs"
      value={text}
      min={min}
      max={max}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        clearTimeout(timer.current);
        if (usable(next)) timer.current = setTimeout(() => send(next), DATE_DELAY_MS);
      }}
      onBlur={() => {
        clearTimeout(timer.current);
        if (text === told) return;
        if (text === "") send(null);
        else if (usable(text)) send(text);
        else setText(told);
      }}
    />
  );
}

/** A text input that tells the page what was typed once typing pauses for SEARCH_DELAY_MS. */
function SearchBox({ id, value, focusOnMount, onCommit }: { id: string; value: string; focusOnMount: boolean; onCommit: (q: string) => void }) {
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
  // Only a value that this box did not send ends a pause that is running: its own commit, coming back, must not.
  const sent = useRef(value);
  useEffect(() => {
    if (value === sent.current) return;
    sent.current = value;
    clearTimeout(timer.current);
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input
        id={id}
        type="search"
        autoComplete="off"
        placeholder="Search summaries"
        maxLength={200}
        autoFocus={focusOnMount}
        className="h-8 w-44 bg-background pl-7 text-[13px]"
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            const q = next.trim();
            sent.current = q;
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
