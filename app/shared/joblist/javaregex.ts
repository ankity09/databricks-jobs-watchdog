/**
 * Can the system-table scan run a pattern? That scan matches job names with
 * Spark SQL's regexp_like, which compiles each pattern with Java's regex
 * (java.util.regex.Pattern), and one pattern Java refuses fails the scan for
 * every job. Java refuses some patterns Python's re accepts. So, for a pattern
 * Python has accepted, this follows Java's parser (JDK 17, the Java our SQL
 * warehouse and serverless compute run) far enough to tell whether it
 * compiles, and names the construct Java stops at. It checks syntax only;
 * some patterns compile in both and still match differently (Python reads
 * \101 as "A", Java as group 1 and "01").
 *
 * jobs_watchdog/java_regex.py is the same check in Python, for the loader.
 * The java field of tests/fixtures/regex-patterns.json pins both, and each
 * construct below was checked against regexp_like on a SQL warehouse.
 *
 * Two answers are policy rather than Java's:
 * - Every \N{...} is refused. Java knows a character's own Unicode 13 name
 *   (\N{EM DASH}), but not Python's aliases (\N{NBSP}), its generated CJK and
 *   Hangul names, or newer characters, and neither check can look names up.
 * - Java also refuses a look-behind longer than 2147483647 characters; that
 *   length is not measured here. Python 3.10 refuses such a look-behind too.
 */

const EOF = "";
const INT_MAX = 2147483647n;
const MAX_REPS = INT_MAX; // Java's limit for * and +

export const JAVA_CONSTRUCTS = {
  namedGroup: "a (?P<name>...) group",
  conditional: "a (?(...)...) conditional",
  comment: "a (?#...) comment",
  brace: "a { that is not a {n}, {n,} or {n,m} repeat",
  repeatCount: "a repeat count above 2147483647",
  repeatOrder: "a repeat whose maximum is below its minimum",
  octalZero: "a \\0 with no octal digit after it",
  uEscape: "a \\U escape",
  namedCharacter: "a \\N{...} character name",
  graphemeBoundary: "a \\b{ that is not \\b{g}",
  setBoundary: "\\b inside a set",
  setOctal: "an octal escape such as \\1 or \\101 inside a set",
  nestedSet: "an unescaped [ inside a set",
  setIntersection: "&& with nothing on either side inside a set",
  verboseSet: "a space or # inside a set in a verbose (?x) pattern",
  verboseComment: "a # comment with a line break other than \\n in it",
  lookbehindReference: "a back reference inside a look-behind",
  lookbehindRepeat: "a repeated group with a choice in it, such as (?:a|b){2}, inside a look-behind",
  other: "syntax that Java's regex refuses",
} as const;

/** Inline flags Python has and Java lacks: a (ASCII), t (3.10 to 3.12's TEMPLATE) and L (bytes only). */
const PYTHON_ONLY_FLAGS = new Set(["a", "t", "L"]);
const flagConstruct = (letter: string): string => `the ${letter} flag`;
const JAVA_FLAGS = new Set(["i", "m", "s", "d", "u", "c", "x", "U"]);

class JavaRefusal extends Error {
  readonly construct: string;
  constructor(construct: string) {
    super(construct);
    this.construct = construct;
  }
}

const isDigit = (c: string): boolean => c.length === 1 && c >= "0" && c <= "9";
const isOctal = (c: string): boolean => c.length === 1 && c >= "0" && c <= "7";
const isHex = (c: string): boolean => /^[0-9a-fA-F]$/.test(c);
const digit = (c: string): number => c.charCodeAt(0) - 48;
const codeOf = (c: string): number => c.codePointAt(0) ?? 0;
/** Java's ASCII.isSpace: what a verbose (?x) pattern skips. */
const SPACES = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);
const isSpace = (c: string): boolean => c !== EOF && SPACES.has(codeOf(c));
/** Where Java ends a # comment besides \n, which is Python's only end: \r, NEL, the Unicode line and paragraph separators, NUL. */
const OTHER_COMMENT_ENDS = new Set([0x0d, 0x85, 0x2028, 0x2029, 0x00]);

type Escape = { kind: "char"; value: number } | { kind: "meta" };
const META: Escape = { kind: "meta" };
const char = (value: number): Escape => ({ kind: "char", value });

/**
 * What Java's study of a look-behind (TreeInfo) learns from a stretch of pattern. A look-behind
 * compiles only when Java can bound its length, which a back reference or a Loop prevents; Java
 * repeats a group with a Loop when the group holds a choice (|, ?, or a repeat whose count varies).
 */
interface Study {
  choice: boolean;
  unbounded: string | null;
}
const fresh = (): Study => ({ choice: false, unbounded: null });

/** What a repeat applies to: a group with or without a choice in it, or anything else. */
type Atom = { kind: "group"; choice: boolean } | { kind: "other" };
const OTHER: Atom = { kind: "other" };

/** A port of the parts of Java's Pattern parser that decide whether a pattern compiles. */
class JavaParser {
  private readonly chars: string[];
  private cursor = 0;
  private comments = false;
  /** Java's capturingGroupCount: the number the next capturing group gets. */
  private groups = 1;
  /** How many sets opened by [ inside another set are open. */
  private nested = 0;
  /** A # comment ended where Java ends it and Python does not, so Java read what Python skipped. */
  commentCutShort = false;

  constructor(pattern: string) {
    this.chars = Array.from(pattern);
  }

  check(): void {
    this.expr(fresh());
    // Java's compile(): "Unmatched closing ')'" when the pattern goes on
    if (this.cursor !== this.chars.length) throw new JavaRefusal(JAVA_CONSTRUCTS.other);
  }

  private at(i: number): string {
    return this.chars[i] ?? EOF;
  }

  private endsComment(ch: string): boolean {
    if (ch === EOF || ch === "\n") return true;
    if (!OTHER_COMMENT_ENDS.has(codeOf(ch))) return false;
    this.commentCutShort = true;
    return true;
  }

  private peekPastLine(): string {
    let ch = this.at(++this.cursor);
    while (!this.endsComment(ch)) ch = this.at(++this.cursor);
    return ch;
  }

  private peekPastWhitespace(start: string): string {
    let ch = start;
    while (isSpace(ch) || ch === "#") {
      while (isSpace(ch)) ch = this.at(++this.cursor);
      if (ch === "#") ch = this.peekPastLine();
    }
    return ch;
  }

  private parsePastLine(): string {
    let ch = this.at(this.cursor++);
    while (!this.endsComment(ch)) ch = this.at(this.cursor++);
    return ch;
  }

  private parsePastWhitespace(start: string): string {
    let ch = start;
    while (isSpace(ch) || ch === "#") {
      while (isSpace(ch)) ch = this.at(this.cursor++);
      if (ch === "#") ch = this.parsePastLine();
    }
    return ch;
  }

  /** Java's peek(), read(), next(), skip() and unread(); the first three skip a verbose pattern's spaces and comments. */
  private peek(): string {
    const ch = this.at(this.cursor);
    return this.comments ? this.peekPastWhitespace(ch) : ch;
  }

  private read(): string {
    const ch = this.at(this.cursor++);
    return this.comments ? this.parsePastWhitespace(ch) : ch;
  }

  private next(): string {
    const ch = this.at(++this.cursor);
    return this.comments ? this.peekPastWhitespace(ch) : ch;
  }

  private skip(): string {
    const ch = this.at(this.cursor + 1);
    this.cursor += 2;
    return ch;
  }

  private unread(): void {
    this.cursor--;
  }

  private expr(study: Study): void {
    for (;;) {
      this.sequence(study);
      if (this.peek() !== "|") return;
      study.choice = true;
      this.next();
    }
  }

  private sequence(study: Study): void {
    for (;;) {
      const ch = this.peek();
      let atom = OTHER;
      if (ch === "(") {
        const group = this.group(study);
        if (group === null) continue; // inline flags such as (?x): nothing to repeat
        atom = group;
      } else if (ch === "[") {
        this.set(true);
      } else if (ch === "^" || ch === "$" || ch === ".") {
        this.next();
      } else if (ch === "|" || ch === ")" || ch === EOF) {
        return;
      } else if (ch === "?" || ch === "*" || ch === "+") {
        throw new JavaRefusal(JAVA_CONSTRUCTS.other); // Java: "Dangling meta character"
      } else {
        this.atom(study);
      }
      this.closure(atom, study);
    }
  }

  /** Java's atom(): a run of literal characters, which stops before the last one when a repeat follows it. */
  private atom(study: Study): void {
    let first = 0;
    let prev = -1;
    let ch = this.peek();
    for (;;) {
      if (ch === "*" || ch === "+" || ch === "?" || ch === "{") {
        if (first > 1) this.cursor = prev;
        return;
      }
      if (ch === EOF || "$.^([|)".includes(ch)) return;
      if (ch === "\\") {
        prev = this.cursor;
        const escaped = this.escape(false, first === 0, false, study);
        if (escaped.kind === "char") {
          first++;
          ch = this.peek();
          continue;
        }
        if (first > 0) this.cursor = prev; // a \d or \b after literals starts the next atom
        return;
      }
      prev = this.cursor;
      first++;
      ch = this.next();
    }
  }

  /** Java's closure(): ?, *, + and {n}, {n,}, {n,m}, each maybe lazy (?) or possessive (+). */
  private closure(atom: Atom, study: Study): void {
    const ch = this.peek();
    let min: bigint;
    let max: bigint;
    let possessive = false;
    if (ch === "?") {
      const after = this.next();
      if (after === "?" || after === "+") this.next();
      study.choice = true;
      return;
    }
    if (ch === "*" || ch === "+") {
      min = ch === "*" ? 0n : 1n;
      max = MAX_REPS;
      const after = this.next();
      if (after === "?" || after === "+") this.next();
      possessive = after === "+";
    } else if (ch === "{") {
      let c = this.skip();
      if (!isDigit(c)) throw new JavaRefusal(JAVA_CONSTRUCTS.brace);
      min = 0n;
      do {
        min = min * 10n + BigInt(digit(c));
        if (min > INT_MAX) throw new JavaRefusal(JAVA_CONSTRUCTS.repeatCount);
      } while (isDigit((c = this.read())));
      max = min;
      if (c === ",") {
        c = this.read();
        if (c === "}") {
          max = MAX_REPS;
        } else {
          max = 0n;
          while (isDigit(c)) {
            max = max * 10n + BigInt(digit(c));
            if (max > INT_MAX) throw new JavaRefusal(JAVA_CONSTRUCTS.repeatCount);
            c = this.read();
          }
        }
      }
      if (c !== "}") throw new JavaRefusal(JAVA_CONSTRUCTS.brace);
      if (max < min) throw new JavaRefusal(JAVA_CONSTRUCTS.repeatOrder);
      const after = this.peek();
      if (after === "?" || after === "+") this.next();
      possessive = after === "+";
    } else {
      return;
    }
    if (min !== max) study.choice = true;
    if (atom.kind === "group" && atom.choice && !possessive) {
      study.choice = true;
      if (study.unbounded === null) study.unbounded = JAVA_CONSTRUCTS.lookbehindRepeat;
    }
  }

  /** Java's group0(). Returns null for inline flags such as (?x), which nothing may repeat. */
  private group(study: Study): Atom | null {
    const saved = this.comments;
    const body = fresh();
    let lookaround = false;
    let atomic = false;
    let ch = this.next();
    if (ch === "?") {
      ch = this.skip();
      if (ch === ":") {
        this.expr(body);
      } else if (ch === "=" || ch === "!") {
        lookaround = true;
        this.expr(body);
      } else if (ch === ">") {
        atomic = true;
        this.expr(body);
      } else if (ch === "<") {
        ch = this.read();
        if (ch !== "=" && ch !== "!") throw new JavaRefusal(JAVA_CONSTRUCTS.other); // Java's (?<name>...)
        lookaround = true;
        this.expr(body);
        if (body.unbounded !== null) throw new JavaRefusal(body.unbounded);
      } else if (ch === "P") {
        throw new JavaRefusal(JAVA_CONSTRUCTS.namedGroup); // Python defines a group before (?P=name) can use it
      } else if (ch === "(") {
        throw new JavaRefusal(JAVA_CONSTRUCTS.conditional);
      } else if (ch === "#") {
        throw new JavaRefusal(JAVA_CONSTRUCTS.comment);
      } else {
        this.unread();
        this.addFlags();
        ch = this.read();
        if (ch === ")") return null; // the flags hold to the end of the enclosing group
        if (ch !== ":") throw new JavaRefusal(PYTHON_ONLY_FLAGS.has(ch) ? flagConstruct(ch) : JAVA_CONSTRUCTS.other);
        this.expr(body);
      }
    } else {
      this.groups++;
      this.expr(body);
    }
    if (this.read() !== ")") throw new JavaRefusal(JAVA_CONSTRUCTS.other); // Java: "Unclosed group"
    this.comments = saved;
    if (lookaround) return OTHER; // Java does not measure what a look-ahead or look-behind holds
    if (body.choice) study.choice = true;
    if (study.unbounded === null) study.unbounded = body.unbounded;
    return atomic ? OTHER : { kind: "group", choice: body.choice };
  }

  /** Java's addFlag() and subFlag(). Only x matters here: it changes how the rest is read. */
  private addFlags(): void {
    let ch = this.peek();
    for (;;) {
      if (ch === "-") {
        this.next();
        this.subFlags();
        return;
      }
      if (!JAVA_FLAGS.has(ch)) return;
      if (ch === "x") this.comments = true;
      ch = this.next();
    }
  }

  private subFlags(): void {
    let ch = this.peek();
    // Java's subFlag stops at U without moving past it
    while (JAVA_FLAGS.has(ch) && ch !== "U") {
      if (ch === "x") this.comments = false;
      ch = this.next();
    }
  }

  /** Java's escape(), in or out of a set. A back reference, class or position is "meta". */
  private escape(inSet: boolean, create: boolean, isRange: boolean, study: Study | null): Escape {
    const ch = this.skip();
    if (ch === "0") return char(this.octal());
    if (isDigit(ch)) {
      if (inSet) throw new JavaRefusal(JAVA_CONSTRUCTS.setOctal);
      if (create && study) {
        this.reference(digit(ch));
        if (study.unbounded === null) study.unbounded = JAVA_CONSTRUCTS.lookbehindReference;
      }
      return META;
    }
    switch (ch) {
      case "b":
        if (inSet) throw new JavaRefusal(JAVA_CONSTRUCTS.setBoundary);
        if (create && this.peek() === "{") {
          if (this.skip() === "g") {
            if (this.read() === "}") return META; // \b{g}, a grapheme boundary
            throw new JavaRefusal(JAVA_CONSTRUCTS.graphemeBoundary);
          }
          this.unread();
          this.unread();
        }
        return META;
      case "A": case "B": case "G": case "R": case "X": case "Z": case "z":
        if (inSet) throw new JavaRefusal(JAVA_CONSTRUCTS.other);
        return META;
      case "d": case "D": case "h": case "H": case "s": case "S": case "V": case "w": case "W":
        return META;
      case "v":
        return isRange ? char(0x0b) : META;
      case "N":
        throw new JavaRefusal(JAVA_CONSTRUCTS.namedCharacter);
      case "U":
        throw new JavaRefusal(JAVA_CONSTRUCTS.uEscape);
      case "a": return char(0x07);
      case "e": return char(0x1b);
      case "f": return char(0x0c);
      case "n": return char(0x0a);
      case "r": return char(0x0d);
      case "t": return char(0x09);
      case "c": {
        const control = this.read(); // \cX; Python has no \c
        if (control === EOF) throw new JavaRefusal(JAVA_CONSTRUCTS.other);
        return char(codeOf(control) ^ 64);
      }
      case "u": return char(this.unicode());
      case "x": return char(this.hex());
      default:
        // \k needs a (?<name>...) group, which Python refuses; the other letters are not escapes in Java
        if (/^[A-Za-z]$/.test(ch)) throw new JavaRefusal(JAVA_CONSTRUCTS.other);
        return char(codeOf(ch));
    }
  }

  /** Java's o(): \0 needs one octal digit, takes a second, and a third when the first is 0 to 3. */
  private octal(): number {
    const n = this.read();
    if (!isOctal(n)) throw new JavaRefusal(JAVA_CONSTRUCTS.octalZero);
    const m = this.read();
    if (!isOctal(m)) {
      this.unread();
      return digit(n);
    }
    const o = this.read();
    if (isOctal(o) && n <= "3") return digit(n) * 64 + digit(m) * 8 + digit(o);
    this.unread();
    return digit(n) * 8 + digit(m);
  }

  /** Java's x() for \xhh, the only form Python has. */
  private hex(): number {
    const n = this.read();
    const m = isHex(n) ? this.read() : EOF;
    if (!isHex(m)) throw new JavaRefusal(JAVA_CONSTRUCTS.other);
    return Number.parseInt(n + m, 16);
  }

  /** Java's u(): \uhhhh, and a following \uhhhh joins a high surrogate to its low one. */
  private unicode(): number {
    const high = this.uxxxx();
    if (high < 0xd800 || high > 0xdbff) return high;
    const cursor = this.cursor;
    if (this.read() === "\\" && this.read() === "u") {
      const low = this.uxxxx();
      if (low >= 0xdc00 && low <= 0xdfff) return 0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00);
    }
    this.cursor = cursor;
    return high;
  }

  private uxxxx(): number {
    let value = 0;
    for (let k = 0; k < 4; k++) {
      const ch = this.read();
      if (!isHex(ch)) throw new JavaRefusal(JAVA_CONSTRUCTS.other);
      value = value * 16 + Number.parseInt(ch, 16);
    }
    return value;
  }

  /** Java's ref(): more digits belong to the reference while that group exists. */
  private reference(first: number): void {
    let number = first;
    for (;;) {
      const ch = this.peek();
      if (!isDigit(ch)) return;
      const longer = number * 10 + digit(ch);
      if (this.groups - 1 < longer) return;
      number = longer;
      this.read();
    }
  }

  /** Java's clazz(): sets nest, && intersects, and ] closes a set only once it has a member. */
  private set(consume: boolean): void {
    let members = false;
    let ch = this.next();
    if (ch === "^" && this.at(this.cursor - 1) === "[") ch = this.next();
    for (;;) {
      if (ch === "[") {
        this.nestedSet();
        members = true;
        ch = this.peek();
        continue;
      }
      if (ch === "&") {
        ch = this.next();
        if (ch === "&") {
          ch = this.next();
          let right = false;
          while (ch !== "]" && ch !== "&") {
            if (ch === "[") {
              this.nestedSet();
            } else {
              this.unread();
              this.set(false);
            }
            right = true;
            ch = this.peek();
          }
          if (!members && !right) throw new JavaRefusal(JAVA_CONSTRUCTS.setIntersection);
          members = true;
          continue;
        }
        this.unread(); // a single & is a member
      } else if (ch === EOF) {
        // Java: "Unclosed character class"
        if (this.comments) throw new JavaRefusal(JAVA_CONSTRUCTS.verboseSet);
        throw new JavaRefusal(this.nested > 0 ? JAVA_CONSTRUCTS.nestedSet : JAVA_CONSTRUCTS.other);
      } else if (ch === "]" && members) {
        if (consume) this.next();
        return;
      }
      this.range();
      members = true;
      ch = this.peek();
    }
  }

  private nestedSet(): void {
    this.nested++;
    this.set(true);
    this.nested--;
  }

  /** Java's range(): one member, or a range such as a-z whose end is not below its start. */
  private range(): void {
    const ch = this.peek();
    let start: number;
    if (ch === "\\") {
      const isRange = this.at(this.cursor + 2) === "-";
      const escaped = this.escape(true, true, isRange, null);
      if (escaped.kind === "meta") return;
      start = escaped.value;
    } else {
      this.next();
      start = codeOf(ch);
    }
    if (this.peek() !== "-") return;
    const endRange = this.at(this.cursor + 1);
    if (endRange === "[" || endRange === "]") return;
    this.next();
    const m = this.peek();
    let end: number;
    if (m === "\\") {
      const escaped = this.escape(true, false, true, null);
      end = escaped.kind === "char" ? escaped.value : -1;
    } else {
      this.next();
      end = codeOf(m);
    }
    // Java: "Illegal character range"; in a verbose pattern a space or # moved the end
    if (end < start) throw new JavaRefusal(this.comments ? JAVA_CONSTRUCTS.verboseSet : JAVA_CONSTRUCTS.other);
  }
}

/**
 * The construct that stops Java compiling the pattern, or null when Java compiles it. Give it
 * patterns Python's re accepts (pythonRegexError returns null); others may be accepted.
 */
export function javaRegexProblem(pattern: string): string | null {
  const parser = new JavaParser(pattern);
  try {
    parser.check();
    return null;
  } catch (error) {
    if (!(error instanceof JavaRefusal)) throw error;
    if (error.construct === JAVA_CONSTRUCTS.other && parser.commentCutShort) return JAVA_CONSTRUCTS.verboseComment;
    return error.construct;
  }
}

/** What the loader (jobs_watchdog/config.py) says about a pattern the system-table scan can't run. */
export function javaRegexClause(construct: string): string {
  if (construct === JAVA_CONSTRUCTS.namedCharacter) {
    return `uses ${construct}, which the system-table scan may not know; write the character itself`;
  }
  return `uses ${construct}, which the system-table scan can't run`;
}
