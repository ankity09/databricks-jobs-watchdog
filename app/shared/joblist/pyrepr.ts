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
    const text = String(this.value);
    return /^-?\d+$/.test(text) ? `${text}.0` : text;
  }
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
  if (typeof value === "number") return Number.isNaN(value) ? "nan" : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof PyFloat) return value.toString();
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    const parts = Object.entries(value).map(([k, v]) => `${reprString(k)}: ${pyRepr(v)}`);
    return `{${parts.join(", ")}}`;
  }
  return typeof value;
}

/** Python's str() for the values a YAML document holds. */
export function pyStr(value: unknown): string {
  return typeof value === "string" ? value : pyRepr(value);
}
