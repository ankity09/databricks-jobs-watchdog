/**
 * Python's repr() for the values a YAML document holds, so messages ported from
 * config.py print the same text ("{raw!r}", "{value!r}").
 */

/** Python's string order: by code point, not by UTF-16 code unit. */
export function comparePy(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) ?? 0;
    const y = b.codePointAt(j) ?? 0;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return a.length - i - (b.length - j);
}

/** sorted(items) for strings, in Python's order. */
export function pySorted(items: Iterable<string>): string[] {
  return Array.from(items).sort(comparePy);
}

/**
 * Python's repr() of a float: the shortest digits that read back as the same
 * number (JavaScript picks the same digits), in exponent form below 1e-4 and
 * from 1e16 up, and with ".0" on a whole number.
 */
export function pyFloatRepr(n: number): string {
  if (Number.isNaN(n)) return "nan";
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  if (n === 0) return Object.is(n, -0) ? "-0.0" : "0.0";
  const [mantissa, expText] = n.toExponential().split("e");
  const digits = mantissa.replace("-", "").replace(".", "");
  const exp = Number(expText);
  let body: string;
  if (exp >= -4 && exp < 16) {
    body = exp >= 0
      ? `${digits.slice(0, exp + 1).padEnd(exp + 1, "0")}.${digits.slice(exp + 1) || "0"}`
      : `0.${"0".repeat(-exp - 1)}${digits}`;
  } else {
    const rest = digits.slice(1);
    body = `${digits[0]}${rest ? `.${rest}` : ""}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return n < 0 ? `-${body}` : body;
}

/**
 * A float that has no fraction, such as 60.0. After parsing, 60.0 and 60 are the
 * same JavaScript number, but Python keeps them apart, so the YAML parse marks
 * these floats and the rules reject them where Python wants a whole number.
 */
export class PyFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
  toString(): string {
    return pyFloatRepr(this.value);
  }
}

/**
 * A YAML timestamp, which PyYAML reads as a date or a datetime. Python's str()
 * and repr() of those differ ("2024-11-05" and "datetime.date(2024, 11, 5)"),
 * so the marker keeps both. A text field stores the str() form.
 */
export class PyTimestamp {
  readonly type: "date" | "datetime";
  readonly str: string;
  readonly repr: string;
  constructor(type: "date" | "datetime", str: string, repr: string) {
    this.type = type;
    this.str = str;
    this.repr = repr;
  }
  toString(): string {
    return this.str;
  }
  toJSON(): string {
    return this.str;
  }
}

/** The characters Python's str.strip() removes: str.isspace(), which differs from trim() (\x1c-\x1f, \x85, not \ufeff). */
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");

/** Python's text.strip(). */
export function pyStrip(text: string): string {
  return text.replace(PY_STRIP, "");
}

function reprString(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return out + quote;
}

export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return reprString(value);
  // A whole number in a JSON document is a Python int; YAML floats with no fraction come as PyFloat.
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof PyFloat) return value.toString();
  if (value instanceof PyTimestamp) return value.repr;
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    const parts = Object.entries(value).map(([k, v]) => `${reprString(k)}: ${pyRepr(v)}`);
    return `{${parts.join(", ")}}`;
  }
  return typeof value;
}

/** Python's str() for the values a YAML document holds. */
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof PyTimestamp) return value.str;
  return pyRepr(value);
}
