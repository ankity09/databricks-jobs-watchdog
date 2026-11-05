import type { ScalarTag, Tags } from "yaml";
import { PyFloat, PyTimestamp } from "./pyrepr";

/**
 * The yaml library's YAML 1.1 schema reads some plain scalars differently from
 * PyYAML, which the Python loader uses: it reads y and n as booleans, 1e3 and 09
 * as numbers, and 2024-1-5 as a date. So the scalar tags here are PyYAML's own:
 * its implicit resolvers (yaml/resolver.py) and its safe constructors
 * (yaml/constructor.py). tests/fixtures/yaml-scalars.json pins the result
 * against PyYAML. Quoted scalars are always text, in both.
 */

const BOOL = /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;
const NULL = /^(?:~|null|Null|NULL|)$/;
const INT = /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/;
const FLOAT = /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
const TIMESTAMP = /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/;
/** PyYAML resolves a plain `=` to the value tag, and its safe loader has no constructor for it. */
const VALUE = /^(?:=)$/;
/** PyYAML resolves a plain `<<` to the merge tag: a merge key, which its safe loader refuses as a value. */
const MERGE = /^(?:<<)$/;
/** The parts of a timestamp, as PyYAML's constructor reads them (it also takes 1-digit months and days). */
const TIMESTAMP_PARTS = /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:[Tt]|[ \t]+)([0-9]{1,2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]*))?(?:[ \t]*(Z|([-+])([0-9]{1,2})(?::([0-9]{2}))?))?)?$/;

type OnError = (message: string) => void;

/** construct_yaml_int: base 2, 8, 16, 10 or 60 (12:30 is 750), underscores dropped. */
function pyInt(text: string, onError: OnError): bigint | string {
  let value = text.replace(/_/g, "");
  const sign = value.startsWith("-") ? -1n : 1n;
  if (value.startsWith("-") || value.startsWith("+")) value = value.slice(1);
  try {
    if (value === "0") return 0n;
    if (value.startsWith("0b")) return sign * BigInt(`0b${value.slice(2)}`);
    if (value.startsWith("0x")) return sign * BigInt(`0x${value.slice(2)}`);
    if (value.startsWith("0")) return sign * BigInt(`0o${value.slice(1)}`);
    if (value.includes(":")) return sign * value.split(":").reduce((total, part) => total * 60n + BigInt(part), 0n);
    return sign * BigInt(value);
  } catch {
    onError(`invalid literal for int(): ${text}`);
    return text;
  }
}

/** construct_yaml_float: .inf, .nan, base 60 (1:20.5 is 80.5), otherwise float(). A whole result is marked PyFloat. */
function pyFloat(text: string, onError: OnError): number | PyFloat | string {
  let value = text.replace(/_/g, "").toLowerCase();
  const sign = value.startsWith("-") ? -1 : 1;
  if (value.startsWith("-") || value.startsWith("+")) value = value.slice(1);
  let n: number;
  if (value === ".inf") n = sign * Infinity;
  else if (value === ".nan") n = NaN;
  else if (value.includes(":")) {
    // Python adds the parts from the last one up, each times its power of 60, then applies the sign.
    let base = 1;
    n = 0;
    for (const part of value.split(":").reverse()) {
      n += Number(part) * base;
      base *= 60;
    }
    n *= sign;
  } else {
    n = value === "" || /[^0-9.e+-]/.test(value) ? NaN : sign * Number(value);
    if (Number.isNaN(n)) {
      onError(`could not convert string to float: ${text}`);
      return text;
    }
  }
  return Number.isInteger(n) ? new PyFloat(n) : n;
}

function daysIn(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** Python's repr() of datetime.timedelta(minutes=offset), with days and seconds as Python keeps them. */
function timedeltaRepr(minutes: number): string {
  const total = minutes * 60;
  const days = Math.floor(total / 86400);
  const seconds = total - days * 86400;
  const parts = [days ? `days=${days}` : "", seconds ? `seconds=${seconds}` : ""].filter(Boolean);
  return `datetime.timedelta(${parts.join(", ") || "0"})`;
}

/**
 * construct_yaml_timestamp: a date, or a datetime with an optional fraction
 * (6 digits) and time zone. Python refuses an impossible date or time with a
 * ValueError, which stops the Python loader, so it is an error here too.
 */
function pyTimestamp(text: string, onError: OnError): PyTimestamp | string {
  const m = TIMESTAMP_PARTS.exec(text);
  if (!m) {
    onError(`not a timestamp: ${text}`);
    return text;
  }
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) {
    onError(`${text} is not a valid date`);
    return text;
  }
  const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  if (m[4] === undefined) return new PyTimestamp("date", date, `datetime.date(${year}, ${month}, ${day})`);
  const [hour, minute, second] = [Number(m[4]), Number(m[5]), Number(m[6])];
  const micro = m[7] ? Number(m[7].slice(0, 6).padEnd(6, "0")) : 0;
  if (hour > 23 || minute > 59 || second > 59) {
    onError(`${text} is not a valid time`);
    return text;
  }
  let zoneStr = "";
  let zoneRepr = "";
  if (m[8] !== undefined) {
    const offset = m[9] ? (m[9] === "-" ? -1 : 1) * (Number(m[10]) * 60 + Number(m[11] ?? 0)) : 0;
    if (Math.abs(offset) >= 24 * 60) {
      onError(`${text} has a time zone offset of 24 hours or more`);
      return text;
    }
    const abs = Math.abs(offset);
    zoneStr = `${offset < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    // Python's datetime.timezone(timedelta(0)) is datetime.timezone.utc.
    zoneRepr = `, tzinfo=${offset === 0 ? "datetime.timezone.utc" : `datetime.timezone(${timedeltaRepr(offset)})`}`;
  }
  const str = `${date} ${pad(hour)}:${pad(minute)}:${pad(second)}${micro ? `.${pad(micro, 6)}` : ""}${zoneStr}`;
  // Python's repr leaves out a zero second and a zero microsecond at the end.
  const fields = [year, month, day, hour, minute, ...(second || micro ? [second] : []), ...(micro ? [micro] : [])];
  return new PyTimestamp("datetime", str, `datetime.datetime(${fields.join(", ")}${zoneRepr})`);
}

function scalarTag(tag: string, test: RegExp, resolve: (text: string, onError: OnError) => unknown): ScalarTag {
  return { tag, default: true, test, resolve };
}

/** PyYAML's scalar types. They replace the yaml library's 1.1 bool, int, float, null and timestamp tags. */
const PYYAML_SCALARS: ScalarTag[] = [
  scalarTag("tag:yaml.org,2002:bool", BOOL, (text, onError) => {
    const word = text.toLowerCase();
    if (["yes", "true", "on"].includes(word)) return true;
    if (["no", "false", "off"].includes(word)) return false;
    onError(`not a boolean: ${text}`);
    return text;
  }),
  scalarTag("tag:yaml.org,2002:null", NULL, () => null),
  scalarTag("tag:yaml.org,2002:int", INT, pyInt),
  scalarTag("tag:yaml.org,2002:float", FLOAT, pyFloat),
  scalarTag("tag:yaml.org,2002:timestamp", TIMESTAMP, pyTimestamp),
  scalarTag("tag:yaml.org,2002:value", VALUE, (text, onError) => {
    onError("could not determine a constructor for the tag 'tag:yaml.org,2002:value'");
    return text;
  }),
];

const REPLACED = new Set(PYYAML_SCALARS.map((t) => t.tag));

/**
 * Parse options that match PyYAML's safe loader for the job list: YAML 1.1 with
 * PyYAML's scalar types (so `yes` is true and `y` is text), merge keys, big
 * integers as bigint, floats with no fraction (60.0) marked as PyFloat, and
 * timestamps as PyTimestamp. readJobListYaml also refuses an unknown tag, as
 * PyYAML's safe loader has no constructor for one.
 */
export const pythonYamlOptions = {
  version: "1.1",
  merge: true,
  intAsBigInt: true,
  customTags: (tags: Tags): Tags => [
    ...PYYAML_SCALARS,
    ...tags.filter((tag) => typeof tag === "string" || !REPLACED.has(tag.tag)),
  ],
} as const;

/**
 * Tags for writing YAML that PyYAML reads back as the same text. The yaml library
 * quotes a string when a tag's test matches it, and its own 1.1 tests miss some
 * text PyYAML reads as another type (a time zone offset of 24 hours or more is
 * still a timestamp to PyYAML, which then refuses it). So PyYAML's own resolvers
 * are added as tests that never claim a value: bool, null, int, float, timestamp,
 * value (=) and merge (<<). The library's merge tag is left out, as it writes the
 * text << as a plain merge key, which PyYAML would merge as a key or refuse as a
 * value. tests/fixtures/yaml-export.json pins an export PyYAML reads back.
 */
export function pythonYamlWriteTags(tags: Tags): Tags {
  const quoteFor = [BOOL, NULL, INT, FLOAT, TIMESTAMP, VALUE, MERGE].map(
    (test, i): ScalarTag => ({ tag: `tag:watchdog.example.com,2026:pyyaml-${i}`, default: true, test, identify: () => false, resolve: (text) => text }),
  );
  return [...tags.filter((tag) => typeof tag === "string" || tag.tag !== "tag:yaml.org,2002:merge"), ...quoteFor];
}
