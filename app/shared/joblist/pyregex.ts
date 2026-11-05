/**
 * Does a pattern compile with Python's re? The Python loader checks every
 * job_name_regex and job_name_exclude_regex with re.compile, and JavaScript's
 * RegExp accepts and refuses different patterns (it refuses (?i) and (?P<x>a); it
 * accepts \p{L}, \k<x>, (?<name>a), [] and a look-behind of any width). So this
 * is a port of CPython's parser (re/_parser.py) and of the one check its
 * compiler adds (re/_compiler.py: a look-behind must have a fixed width). It
 * only checks syntax; nothing here matches text.
 *
 * Which Python? The scan runs on serverless compute, whose Python can be as old
 * as 3.10 (the default notebook environment is 3.10.12 in our test workspace).
 * So a pattern passes only when Python 3.10 and every later version up to 3.14
 * compile it, and the message is that of the newest version that refuses it.
 * In practice: no atomic groups (?>...) and no possessive repeats (a*+), which
 * 3.10 lacks; no \z, which only 3.14 has; and inline global flags only at the
 * start, as 3.11 and later require. tests/fixtures/regex-patterns.json pins this
 * per Python version (pytest checks it on the Python it runs on, vitest checks
 * this port).
 *
 * The one gap: a \N{...} character name. Python looks the name up in its
 * Unicode database, which JavaScript does not have, so the app refuses every
 * \N{...} rather than let an unknown name through to the scan.
 *
 * Positions count code points, as Python's do.
 */

const MAXREPEAT = 4294967295n; // _sre.MAXREPEAT
const MAXGROUPS = 1073741823; // _sre.MAXGROUPS
const MAXCODE = 4294967295n; // (1 << 32) - 1 for a 4-byte code size
const MAXWIDTH = 1n << 64n;

const SRE_FLAG_IGNORECASE = 2;
const SRE_FLAG_LOCALE = 4;
const SRE_FLAG_MULTILINE = 8;
const SRE_FLAG_DOTALL = 16;
const SRE_FLAG_UNICODE = 32;
const SRE_FLAG_VERBOSE = 64;
const SRE_FLAG_ASCII = 256;
const TYPE_FLAGS = SRE_FLAG_ASCII | SRE_FLAG_LOCALE | SRE_FLAG_UNICODE;
const FLAGS = new Map<string, number>([
  ["i", SRE_FLAG_IGNORECASE], ["L", SRE_FLAG_LOCALE], ["m", SRE_FLAG_MULTILINE], ["s", SRE_FLAG_DOTALL],
  ["x", SRE_FLAG_VERBOSE], ["a", SRE_FLAG_ASCII], ["u", SRE_FLAG_UNICODE],
]);

const SPECIAL_CHARS = new Set(".\\[{()*+?^$|");
const REPEAT_CHARS = new Set("*+?{");
const DIGITS = new Set("0123456789");
const OCTDIGITS = new Set("01234567");
const HEXDIGITS = new Set("0123456789abcdefABCDEF");
const WHITESPACE = new Set(" \t\n\r\v\f");
const isAsciiLetter = (c: string): boolean => /^[A-Za-z]$/.test(c);
/** str.isidentifier(): XID_Start or "_", then XID_Continue. */
const isIdentifier = (name: string): boolean => /^[\p{XID_Start}_]\p{XID_Continue}*$/u.test(name);

/** Escapes that stand for one character, in and out of a set, with their code (a set range compares them). */
const ESCAPES = new Map([["\\a", 7], ["\\b", 8], ["\\f", 12], ["\\n", 10], ["\\r", 13], ["\\t", 9], ["\\v", 11], ["\\\\", 92]]);
/** Escapes for a class of characters (usable in a set) or a position (not in a set). */
const CATEGORY_SETS = new Set(["\\d", "\\D", "\\s", "\\S", "\\w", "\\W"]);
/** \z is 3.14's; Python 3.10 to 3.13 refuse it, so it is left out. */
const CATEGORY_POSITIONS = new Set(["\\A", "\\b", "\\B", "\\Z"]);

/** Python's len(): code points, not UTF-16 units. */
const len = (text: string): number => Array.from(text).length;

/** re.error, with str() as Python prints it. Other errors Python raises (OverflowError, ValueError) use their message alone. */
class PatternError extends Error {
  constructor(msg: string, pattern?: string[], pos?: number) {
    let text = msg;
    if (pattern !== undefined && pos !== undefined) {
      text = `${msg} at position ${pos}`;
      if (pattern.includes("\n")) {
        const before = pattern.slice(0, pos);
        const lineno = before.filter((ch) => ch === "\n").length + 1;
        text = `${text} (line ${lineno}, column ${pos - before.lastIndexOf("\n")})`;
      }
    }
    super(text);
    this.name = "PatternError";
  }
}

/** Python's repr() of a str, for the messages that quote a group name. */
function repr(s: string): string {
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

type Width = [bigint, bigint];

type Node =
  | { op: "UNIT" } // LITERAL, NOT_LITERAL, ANY, IN, RANGE, CATEGORY: one character
  | { op: "LITERAL"; code: number } // a one-character item that a set range can use
  | { op: "IN" } // a category such as \d, which a set range cannot use
  | { op: "AT" }
  | { op: "BRANCH"; items: SubPattern[] }
  | { op: "SUBPATTERN"; group: number | null; addFlags: number; delFlags: number; p: SubPattern }
  | { op: "REPEAT"; min: bigint; max: bigint; item: SubPattern }
  | { op: "GROUPREF"; group: number }
  | { op: "GROUPREF_EXISTS"; group: number; yes: SubPattern; no: SubPattern | null }
  | { op: "ASSERT"; dir: number; p: SubPattern }
  | { op: "FAILURE" };

class State {
  flags = 0;
  readonly groupdict = new Map<string, number>();
  readonly groupwidths: (Width | null)[] = [null];
  lookbehindgroups: number | null = null;
  readonly grouprefpos = new Map<number, number>();
  get groups(): number {
    return this.groupwidths.length;
  }
  opengroup(name: string | null): number {
    const gid = this.groups;
    this.groupwidths.push(null);
    if (this.groups > MAXGROUPS) throw new PatternError("too many groups");
    if (name !== null) {
      const ogid = this.groupdict.get(name);
      if (ogid !== undefined) throw new PatternError(`redefinition of group name ${repr(name)} as group ${gid}; was group ${ogid}`);
      this.groupdict.set(name, gid);
    }
    return gid;
  }
  closegroup(gid: number, p: SubPattern): void {
    this.groupwidths[gid] = p.getwidth();
  }
  checkgroup(gid: number): boolean {
    return gid < this.groups && this.groupwidths[gid] !== null;
  }
  checklookbehindgroup(gid: number, source: Tokenizer): void {
    if (this.lookbehindgroups !== null) {
      if (!this.checkgroup(gid)) throw source.error("cannot refer to an open group");
      if (gid >= this.lookbehindgroups) throw source.error("cannot refer to group defined in the same lookbehind subpattern");
    }
  }
}

const minW = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const maxW = (a: bigint, b: bigint): bigint => (a > b ? a : b);

class SubPattern {
  readonly data: Node[] = [];
  private width: Width | null = null;
  readonly state: State;
  constructor(state: State) {
    this.state = state;
  }
  getwidth(): Width {
    if (this.width) return this.width;
    let lo = 0n;
    let hi = 0n;
    for (const node of this.data) {
      switch (node.op) {
        case "BRANCH": {
          let i = MAXWIDTH;
          let j = 0n;
          for (const item of node.items) {
            const [l, h] = item.getwidth();
            i = minW(i, l);
            j = maxW(j, h);
          }
          lo += i;
          hi += j;
          break;
        }
        case "SUBPATTERN": {
          const [i, j] = node.p.getwidth();
          lo += i;
          hi += j;
          break;
        }
        case "REPEAT": {
          const [i, j] = node.item.getwidth();
          lo += i * node.min;
          hi = node.max === MAXREPEAT && j ? MAXWIDTH : hi + j * node.max;
          break;
        }
        case "UNIT":
        case "LITERAL":
        case "IN":
          lo += 1n;
          hi += 1n;
          break;
        case "GROUPREF": {
          const [i, j] = this.state.groupwidths[node.group] ?? [0n, 0n];
          lo += i;
          hi += j;
          break;
        }
        case "GROUPREF_EXISTS": {
          let [i, j] = node.yes.getwidth();
          if (node.no !== null) {
            const [l, h] = node.no.getwidth();
            i = minW(i, l);
            j = maxW(j, h);
          } else {
            i = 0n;
          }
          lo += i;
          hi += j;
          break;
        }
        default:
          break;
      }
    }
    this.width = [minW(lo, MAXWIDTH), minW(hi, MAXWIDTH)];
    return this.width;
  }
}

class Tokenizer {
  readonly chars: string[];
  private index = 0;
  next: string | null = null;
  constructor(pattern: string) {
    this.chars = Array.from(pattern);
    this.advance();
  }
  private advance(): void {
    let index = this.index;
    if (index >= this.chars.length) {
      this.next = null;
      return;
    }
    let char = this.chars[index];
    if (char === "\\") {
      index += 1;
      if (index >= this.chars.length) throw new PatternError("bad escape (end of pattern)", this.chars, this.chars.length - 1);
      char += this.chars[index];
    }
    this.index = index + 1;
    this.next = char;
  }
  match(char: string): boolean {
    if (char === this.next) {
      this.advance();
      return true;
    }
    return false;
  }
  get(): string | null {
    const token = this.next;
    this.advance();
    return token;
  }
  getwhile(n: number, charset: Set<string>): string {
    let result = "";
    for (let k = 0; k < n; k++) {
      const c = this.next;
      if (c === null || !charset.has(c)) break;
      result += c;
      this.advance();
    }
    return result;
  }
  getuntil(terminator: string, name: string): string {
    let result = "";
    for (;;) {
      const c = this.next;
      this.advance();
      if (c === null) {
        if (!result) throw this.error(`missing ${name}`);
        throw this.error(`missing ${terminator}, unterminated name`, len(result));
      }
      if (c === terminator) {
        if (!result) throw this.error(`missing ${name}`, 1);
        break;
      }
      result += c;
    }
    return result;
  }
  tell(): number {
    return this.index - (this.next === null ? 0 : len(this.next));
  }
  seek(index: number): void {
    this.index = index;
    this.advance();
  }
  error(msg: string, offset = 0): PatternError {
    return new PatternError(msg, this.chars, this.tell() - offset);
  }
  checkgroupname(name: string, offset: number): void {
    if (!isIdentifier(name)) throw this.error(`bad character in group name ${repr(name)}`, len(name) + offset);
  }
}

/** A \x, \u, \U, \N or octal escape, shared by sets and expressions. Returns null when the escape is not one of them. */
function numericEscape(source: Tokenizer, escape: string): Node | null {
  const c = escape.slice(1, 2);
  if (c === "x" || c === "u" || c === "U") {
    const digits = c === "x" ? 2 : c === "u" ? 4 : 8;
    escape += source.getwhile(digits, HEXDIGITS);
    if (len(escape) !== digits + 2) throw source.error(`incomplete escape ${escape}`, len(escape));
    const code = Number.parseInt(escape.slice(2), 16);
    if (code > 0x10ffff) throw source.error(`bad escape ${escape}`, len(escape)); // chr() refuses it
    return { op: "LITERAL", code };
  }
  if (c === "N") {
    if (!source.match("{")) throw source.error("missing {");
    const charname = source.getuntil("}", "character name");
    // Python looks the name up in its Unicode database; the app cannot, so it refuses the escape.
    throw source.error(`the app cannot check the character name ${repr(charname)}; write the character itself`, len(charname) + 4);
  }
  return null;
}

function classEscape(source: Tokenizer, escape: string): Node {
  const literal = ESCAPES.get(escape);
  if (literal !== undefined) return { op: "LITERAL", code: literal };
  if (CATEGORY_SETS.has(escape)) return { op: "IN" };
  const numeric = numericEscape(source, escape);
  if (numeric) return numeric;
  const c = escape.slice(1, 2);
  if (OCTDIGITS.has(c)) {
    escape += source.getwhile(2, OCTDIGITS);
    const code = Number.parseInt(escape.slice(1), 8);
    if (code > 0o377) throw source.error(`octal escape value ${escape} outside of range 0-0o377`, len(escape));
    return { op: "LITERAL", code };
  }
  if (!DIGITS.has(c) && len(escape) === 2 && !isAsciiLetter(c)) return { op: "LITERAL", code: c.codePointAt(0) ?? 0 };
  throw source.error(`bad escape ${escape}`, len(escape));
}

function expressionEscape(source: Tokenizer, escape: string, state: State): Node {
  if (CATEGORY_POSITIONS.has(escape)) return { op: "AT" };
  if (CATEGORY_SETS.has(escape)) return { op: "IN" };
  if (ESCAPES.has(escape)) return { op: "UNIT" };
  const numeric = numericEscape(source, escape);
  if (numeric) return numeric;
  const c = escape.slice(1, 2);
  if (c === "0") {
    source.getwhile(2, OCTDIGITS);
    return { op: "UNIT" };
  }
  if (DIGITS.has(c)) {
    // an octal escape or a numbered group reference
    if (source.next !== null && DIGITS.has(source.next)) {
      escape += source.get() ?? "";
      if (OCTDIGITS.has(escape[1]) && OCTDIGITS.has(escape[2]) && source.next !== null && OCTDIGITS.has(source.next)) {
        escape += source.get() ?? "";
        const code = Number.parseInt(escape.slice(1), 8);
        if (code > 0o377) throw source.error(`octal escape value ${escape} outside of range 0-0o377`, len(escape));
        return { op: "UNIT" };
      }
    }
    const group = Number.parseInt(escape.slice(1), 10);
    if (group < state.groups) {
      if (!state.checkgroup(group)) throw source.error("cannot refer to an open group", len(escape));
      state.checklookbehindgroup(group, source);
      return { op: "GROUPREF", group };
    }
    throw source.error(`invalid group reference ${group}`, len(escape) - 1);
  }
  if (len(escape) === 2 && !isAsciiLetter(c)) return { op: "UNIT" };
  throw source.error(`bad escape ${escape}`, len(escape));
}

function parseSub(source: Tokenizer, state: State, verbose: boolean, nested: number): SubPattern {
  const items: SubPattern[] = [];
  for (;;) {
    items.push(parse(source, state, verbose, nested + 1, nested === 0 && items.length === 0));
    if (!source.match("|")) break;
    if (nested === 0) verbose = (state.flags & SRE_FLAG_VERBOSE) !== 0;
  }
  if (items.length === 1) return items[0];
  const sub = new SubPattern(state);
  sub.data.push({ op: "BRANCH", items });
  return sub;
}

function parseSet(source: Tokenizer, here: number): Node {
  let items = 0;
  source.match("^");
  for (;;) {
    const thisToken = source.get();
    if (thisToken === null) throw source.error("unterminated character set", source.tell() - here);
    if (thisToken === "]" && items > 0) break;
    const code1: Node = thisToken.startsWith("\\") ? classEscape(source, thisToken) : { op: "LITERAL", code: thisToken.codePointAt(0) ?? 0 };
    if (source.match("-")) {
      const that = source.get();
      if (that === null) throw source.error("unterminated character set", source.tell() - here);
      if (that === "]") {
        items += 2;
        break;
      }
      const code2: Node = that.startsWith("\\") ? classEscape(source, that) : { op: "LITERAL", code: that.codePointAt(0) ?? 0 };
      if (code1.op !== "LITERAL" || code2.op !== "LITERAL" || code2.code < code1.code) {
        throw source.error(`bad character range ${thisToken}-${that}`, len(thisToken) + 1 + len(that));
      }
    }
    items += 1;
  }
  return { op: "UNIT" };
}

function parseFlags(source: Tokenizer, state: State, first: string): [number, number] | null {
  let char: string | null = first;
  let addFlags = 0;
  let delFlags = 0;
  if (char !== "-") {
    for (;;) {
      const flag = FLAGS.get(char) ?? 0;
      if (char === "L") throw source.error("bad inline flags: cannot use 'L' flag with a str pattern");
      addFlags |= flag;
      if ((flag & TYPE_FLAGS) && (addFlags & TYPE_FLAGS) !== flag) throw source.error("bad inline flags: flags 'a', 'u' and 'L' are incompatible");
      char = source.get();
      if (char === null) throw source.error("missing -, : or )");
      if (char === ")" || char === "-" || char === ":") break;
      if (!FLAGS.has(char)) throw source.error(/^\p{L}+$/u.test(char) ? "unknown flag" : "missing -, : or )", len(char));
    }
  }
  if (char === ")") {
    state.flags |= addFlags;
    return null;
  }
  if (char === "-") {
    char = source.get();
    if (char === null) throw source.error("missing flag");
    if (!FLAGS.has(char)) throw source.error(/^\p{L}+$/u.test(char) ? "unknown flag" : "missing flag", len(char));
    for (;;) {
      const flag = FLAGS.get(char) ?? 0;
      if (flag & TYPE_FLAGS) throw source.error("bad inline flags: cannot turn off flags 'a', 'u' and 'L'");
      delFlags |= flag;
      char = source.get();
      if (char === null) throw source.error("missing :");
      if (char === ":") break;
      if (!FLAGS.has(char)) throw source.error(/^\p{L}+$/u.test(char) ? "unknown flag" : "missing :", len(char));
    }
  }
  if (addFlags & delFlags) throw source.error("bad inline flags: flag turned on and off", 1);
  return [addFlags, delFlags];
}

function parseRepeat(source: Tokenizer, sub: SubPattern, thisToken: string): boolean {
  const here = source.tell();
  let min = 0n;
  let max = MAXREPEAT;
  if (thisToken === "?") max = 1n;
  else if (thisToken === "+") min = 1n;
  else if (thisToken === "{") {
    if (source.next === "}") {
      sub.data.push({ op: "UNIT" });
      return true;
    }
    let lo = "";
    let hi = "";
    while (source.next !== null && DIGITS.has(source.next)) lo += source.get() ?? "";
    if (source.match(",")) {
      while (source.next !== null && DIGITS.has(source.next)) hi += source.get() ?? "";
    } else {
      hi = lo;
    }
    if (!source.match("}")) {
      sub.data.push({ op: "UNIT" });
      source.seek(here);
      return true;
    }
    if (lo) {
      min = BigInt(lo);
      if (min >= MAXREPEAT) throw new PatternError("the repetition number is too large");
    }
    if (hi) {
      max = BigInt(hi);
      if (max >= MAXREPEAT) throw new PatternError("the repetition number is too large");
      if (max < min) throw source.error("min repeat greater than max repeat", source.tell() - here);
    }
  }
  const last = sub.data[sub.data.length - 1];
  if (last === undefined || last.op === "AT") throw source.error("nothing to repeat", source.tell() - here + len(thisToken));
  if (last.op === "REPEAT") throw source.error("multiple repeat", source.tell() - here + len(thisToken));
  let item = new SubPattern(sub.state);
  item.data.push(last);
  if (last.op === "SUBPATTERN" && last.group === null && !last.addFlags && !last.delFlags) item = last.p;
  // A lazy repeat (a*?). A possessive one (a*+) is 3.11's: Python 3.10 reads the + as a second repeat.
  source.match("?");
  sub.data[sub.data.length - 1] = { op: "REPEAT", min, max, item };
  return true;
}

function parseGroup(source: Tokenizer, state: State, sub: SubPattern, verbose: boolean, nested: number, first: boolean): boolean {
  const start = source.tell() - 1;
  let capture = true;
  let name: string | null = null;
  let addFlags = 0;
  let delFlags = 0;
  if (source.match("?")) {
    const char = source.get();
    if (char === null) throw source.error("unexpected end of pattern");
    if (char === "P") {
      if (source.match("<")) {
        name = source.getuntil(">", "group name");
        source.checkgroupname(name, 1);
      } else if (source.match("=")) {
        const ref = source.getuntil(")", "group name");
        source.checkgroupname(ref, 1);
        const gid = state.groupdict.get(ref);
        if (gid === undefined) throw source.error(`unknown group name ${repr(ref)}`, len(ref) + 1);
        if (!state.checkgroup(gid)) throw source.error("cannot refer to an open group", len(ref) + 1);
        state.checklookbehindgroup(gid, source);
        sub.data.push({ op: "GROUPREF", group: gid });
        return true;
      } else {
        const next = source.get();
        if (next === null) throw source.error("unexpected end of pattern");
        throw source.error(`unknown extension ?P${next}`, len(next) + 2);
      }
    } else if (char === ":") {
      capture = false;
    } else if (char === "#") {
      for (;;) {
        if (source.next === null) throw source.error("missing ), unterminated comment", source.tell() - start);
        if (source.get() === ")") break;
      }
      return true;
    } else if (char === "=" || char === "!" || char === "<") {
      let kind = char;
      let dir = 1;
      let outerLookbehind: number | null = null;
      if (kind === "<") {
        const next = source.get();
        if (next === null) throw source.error("unexpected end of pattern");
        if (next !== "=" && next !== "!") throw source.error(`unknown extension ?<${next}`, len(next) + 2);
        kind = next;
        dir = -1;
        outerLookbehind = state.lookbehindgroups;
        if (outerLookbehind === null) state.lookbehindgroups = state.groups;
      }
      const p = parseSub(source, state, verbose, nested + 1);
      if (dir < 0 && outerLookbehind === null) state.lookbehindgroups = null;
      if (!source.match(")")) throw source.error("missing ), unterminated subpattern", source.tell() - start);
      if (kind === "=" || p.data.length > 0) sub.data.push({ op: "ASSERT", dir, p });
      else sub.data.push({ op: "FAILURE" });
      return true;
    } else if (char === "(") {
      const condname = source.getuntil(")", "group name");
      let condgroup: number;
      if (!/^[0-9]+$/.test(condname)) {
        source.checkgroupname(condname, 1);
        const gid = state.groupdict.get(condname);
        if (gid === undefined) throw source.error(`unknown group name ${repr(condname)}`, len(condname) + 1);
        condgroup = gid;
      } else {
        condgroup = Number.parseInt(condname, 10);
        if (!condgroup) throw source.error("bad group number", len(condname) + 1);
        if (condgroup >= MAXGROUPS) throw source.error(`invalid group reference ${condgroup}`, len(condname) + 1);
        if (!state.grouprefpos.has(condgroup)) state.grouprefpos.set(condgroup, source.tell() - len(condname) - 1);
      }
      state.checklookbehindgroup(condgroup, source);
      const yes = parse(source, state, verbose, nested + 1);
      let no: SubPattern | null = null;
      if (source.match("|")) {
        no = parse(source, state, verbose, nested + 1);
        if (source.next === "|") throw source.error("conditional backref with more than two branches");
      }
      if (!source.match(")")) throw source.error("missing ), unterminated subpattern", source.tell() - start);
      sub.data.push({ op: "GROUPREF_EXISTS", group: condgroup, yes, no });
      return true;
    } else if (FLAGS.has(char) || char === "-") {
      const flags = parseFlags(source, state, char);
      if (flags === null) {
        if (!first || sub.data.length > 0) throw source.error("global flags not at the start of the expression", source.tell() - start);
        return false; // global flags: the caller re-reads verbose
      }
      [addFlags, delFlags] = flags;
      capture = false;
    } else {
      throw source.error(`unknown extension ?${char}`, len(char) + 1);
    }
  }
  let group: number | null = null;
  if (capture) {
    try {
      group = state.opengroup(name);
    } catch (error) {
      if (error instanceof PatternError) throw source.error(error.message, len(name ?? "") + 1);
      throw error;
    }
  }
  const subVerbose = (verbose || (addFlags & SRE_FLAG_VERBOSE) !== 0) && (delFlags & SRE_FLAG_VERBOSE) === 0;
  const p = parseSub(source, state, subVerbose, nested + 1);
  if (!source.match(")")) throw source.error("missing ), unterminated subpattern", source.tell() - start);
  if (group !== null) state.closegroup(group, p);
  sub.data.push({ op: "SUBPATTERN", group, addFlags, delFlags, p });
  return true;
}

function parse(source: Tokenizer, state: State, verbose: boolean, nested: number, first = false): SubPattern {
  const sub = new SubPattern(state);
  for (;;) {
    const thisToken = source.next;
    if (thisToken === null) break;
    if (thisToken === "|" || thisToken === ")") break;
    source.get();
    if (verbose) {
      if (WHITESPACE.has(thisToken)) continue;
      if (thisToken === "#") {
        for (;;) {
          const skipped = source.get();
          if (skipped === null || skipped === "\n") break;
        }
        continue;
      }
    }
    if (thisToken.startsWith("\\")) {
      sub.data.push(expressionEscape(source, thisToken, state));
    } else if (!SPECIAL_CHARS.has(thisToken)) {
      sub.data.push({ op: "UNIT" });
    } else if (thisToken === "[") {
      sub.data.push(parseSet(source, source.tell() - 1));
    } else if (REPEAT_CHARS.has(thisToken)) {
      parseRepeat(source, sub, thisToken);
    } else if (thisToken === ".") {
      sub.data.push({ op: "UNIT" });
    } else if (thisToken === "(") {
      if (!parseGroup(source, state, sub, verbose, nested, first)) verbose = (state.flags & SRE_FLAG_VERBOSE) !== 0;
    } else {
      sub.data.push({ op: "AT" }); // ^ or $
    }
  }
  return sub;
}

/** The compiler's check: a look-behind must match a fixed number of characters. */
function checkLookbehinds(sub: SubPattern): void {
  for (const node of sub.data) {
    switch (node.op) {
      case "ASSERT":
        if (node.dir < 0) {
          const [lo, hi] = node.p.getwidth();
          if (lo > MAXCODE) throw new PatternError("looks too much behind");
          if (lo !== hi) throw new PatternError("look-behind requires fixed-width pattern");
        }
        checkLookbehinds(node.p);
        break;
      case "BRANCH":
        node.items.forEach(checkLookbehinds);
        break;
      case "SUBPATTERN":
        checkLookbehinds(node.p);
        break;
      case "REPEAT":
        checkLookbehinds(node.item);
        break;
      case "GROUPREF_EXISTS":
        checkLookbehinds(node.yes);
        if (node.no) checkLookbehinds(node.no);
        break;
      default:
        break;
    }
  }
}

/**
 * What re.compile(pattern) raises, as str(error), or null when the pattern
 * compiles. An OverflowError or ValueError (a repeat count too large, both the
 * a and u flags) also stops the Python loader, so its message is returned too.
 */
export function pythonRegexError(pattern: string): string | null {
  try {
    const source = new Tokenizer(pattern);
    const state = new State();
    const p = parseSub(source, state, false, 0);
    if (state.flags & SRE_FLAG_LOCALE) return "cannot use LOCALE flag with a str pattern";
    if ((state.flags & SRE_FLAG_ASCII) && (state.flags & SRE_FLAG_UNICODE)) return "ASCII and UNICODE flags are incompatible";
    if (source.next !== null) throw source.error("unbalanced parenthesis");
    for (const [group, pos] of state.grouprefpos) {
      if (group >= state.groups) throw new PatternError(`invalid group reference ${group}`, source.chars, pos);
    }
    checkLookbehinds(p);
    return null;
  } catch (error) {
    if (error instanceof PatternError) return error.message;
    throw error;
  }
}
