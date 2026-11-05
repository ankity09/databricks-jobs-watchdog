"""Can the system-table scan run a pattern?

The system-table scan matches job names with Spark SQL's regexp_like, which
compiles each pattern with Java's regex (java.util.regex.Pattern), and one
pattern Java refuses fails the scan for every job. Java refuses some patterns
Python's re accepts. So, for a pattern re has compiled, java_regex_problem
follows Java's parser (JDK 17, the Java our SQL warehouse and serverless
compute run) far enough to tell whether it compiles, and names the construct
Java stops at. It checks syntax only; some patterns compile in both and still
match differently (Python reads \\101 as "A", Java as group 1 and "01").

app/shared/joblist/javaregex.ts is the same check for the Watchdog app. The
java field of tests/fixtures/regex-patterns.json pins both, and each construct
below was checked against regexp_like on a SQL warehouse.

Two answers are policy rather than Java's:
- Every \\N{...} is refused. Java knows a character's own Unicode 13 name
  (\\N{EM DASH}), but not Python's aliases (\\N{NBSP}), its generated CJK and
  Hangul names, or newer characters, and neither check can look names up.
- Java also refuses a look-behind longer than 2147483647 characters; that
  length is not measured here. Python 3.10 refuses such a look-behind too.
"""

import re

EOF = ""
INT_MAX = 2147483647
MAX_REPS = INT_MAX  # Java's limit for * and +

NAMED_GROUP = "a (?P<name>...) group"
CONDITIONAL = "a (?(...)...) conditional"
COMMENT = "a (?#...) comment"
BRACE = "a { that is not a {n}, {n,} or {n,m} repeat"
REPEAT_COUNT = "a repeat count above 2147483647"
REPEAT_ORDER = "a repeat whose maximum is below its minimum"
OCTAL_ZERO = "a \\0 with no octal digit after it"
U_ESCAPE = "a \\U escape"
NAMED_CHARACTER = "a \\N{...} character name"
GRAPHEME_BOUNDARY = "a \\b{ that is not \\b{g}"
SET_BOUNDARY = "\\b inside a set"
SET_OCTAL = "an octal escape such as \\1 or \\101 inside a set"
NESTED_SET = "an unescaped [ inside a set"
SET_INTERSECTION = "&& with nothing on either side inside a set"
VERBOSE_SET = "a space or # inside a set in a verbose (?x) pattern"
VERBOSE_COMMENT = "a # comment with a line break other than \\n in it"
LOOKBEHIND_REFERENCE = "a back reference inside a look-behind"
LOOKBEHIND_REPEAT = "a repeated group with a choice in it, such as (?:a|b){2}, inside a look-behind"
OTHER = "syntax that Java's regex refuses"

# Inline flags Python has and Java lacks: a (ASCII), t (3.10 to 3.12's TEMPLATE) and L (bytes only).
PYTHON_ONLY_FLAGS = frozenset("atL")
JAVA_FLAGS = frozenset("imsducxU")
# Java's ASCII.isSpace: what a verbose (?x) pattern skips.
SPACES = frozenset(" \t\n\x0b\x0c\r")
# Where Java ends a # comment besides \n, which is Python's only end: \r, NEL, the Unicode line and
# paragraph separators, NUL.
OTHER_COMMENT_ENDS = frozenset(map(chr, (0x0D, 0x85, 0x2028, 0x2029, 0x00)))
DIGITS = frozenset("0123456789")
OCTDIGITS = frozenset("01234567")
HEXDIGITS = frozenset("0123456789abcdefABCDEF")
ASCII_LETTER = re.compile(r"[A-Za-z]")


class _Refusal(Exception):
    def __init__(self, construct):
        super().__init__(construct)
        self.construct = construct


class _Study:
    """What Java's study of a look-behind (TreeInfo) learns from a stretch of pattern.

    A look-behind compiles only when Java can bound its length, which a back reference or a Loop
    prevents; Java repeats a group with a Loop when the group holds a choice (|, ?, or a repeat
    whose count varies).
    """

    def __init__(self):
        self.choice = False
        self.unbounded = None


class _Group:
    """A group a repeat applies to, and whether it holds a choice."""

    def __init__(self, choice):
        self.choice = choice


class _JavaParser:
    """A port of the parts of Java's Pattern parser that decide whether a pattern compiles."""

    def __init__(self, pattern):
        self.chars = pattern
        self.cursor = 0
        self.comments = False
        self.groups = 1  # Java's capturingGroupCount: the number the next capturing group gets
        self.nested = 0  # how many sets opened by [ inside another set are open
        self.comment_cut_short = False  # a # comment ended where Java ends it and Python does not

    def check(self):
        self.expr(_Study())
        if self.cursor != len(self.chars):  # Java's compile(): "Unmatched closing ')'"
            raise _Refusal(OTHER)

    def at(self, i):
        return self.chars[i] if 0 <= i < len(self.chars) else EOF

    def ends_comment(self, ch):
        if ch in (EOF, "\n"):
            return True
        if ch not in OTHER_COMMENT_ENDS:
            return False
        self.comment_cut_short = True
        return True

    def peek_past_line(self):
        self.cursor += 1
        ch = self.at(self.cursor)
        while not self.ends_comment(ch):
            self.cursor += 1
            ch = self.at(self.cursor)
        return ch

    def peek_past_whitespace(self, ch):
        while ch in SPACES or ch == "#":
            while ch in SPACES:
                self.cursor += 1
                ch = self.at(self.cursor)
            if ch == "#":
                ch = self.peek_past_line()
        return ch

    def parse_past_line(self):
        ch = self.at(self.cursor)
        self.cursor += 1
        while not self.ends_comment(ch):
            ch = self.at(self.cursor)
            self.cursor += 1
        return ch

    def parse_past_whitespace(self, ch):
        while ch in SPACES or ch == "#":
            while ch in SPACES:
                ch = self.at(self.cursor)
                self.cursor += 1
            if ch == "#":
                ch = self.parse_past_line()
        return ch

    # Java's peek(), read(), next(), skip() and unread(); the first three skip a verbose
    # pattern's spaces and comments.
    def peek(self):
        ch = self.at(self.cursor)
        return self.peek_past_whitespace(ch) if self.comments else ch

    def read(self):
        ch = self.at(self.cursor)
        self.cursor += 1
        return self.parse_past_whitespace(ch) if self.comments else ch

    def next(self):
        self.cursor += 1
        ch = self.at(self.cursor)
        return self.peek_past_whitespace(ch) if self.comments else ch

    def skip(self):
        ch = self.at(self.cursor + 1)
        self.cursor += 2
        return ch

    def unread(self):
        self.cursor -= 1

    def expr(self, study):
        while True:
            self.sequence(study)
            if self.peek() != "|":
                return
            study.choice = True
            self.next()

    def sequence(self, study):
        while True:
            ch = self.peek()
            atom = None
            if ch == "(":
                atom = self.group(study)
                if atom is False:
                    continue  # inline flags such as (?x): nothing to repeat
            elif ch == "[":
                self.set(True)
            elif ch in ("^", "$", "."):
                self.next()
            elif ch in ("|", ")", EOF):
                return
            elif ch in ("?", "*", "+"):
                raise _Refusal(OTHER)  # Java: "Dangling meta character"
            else:
                self.atom(study)
            self.closure(atom, study)

    def atom(self, study):
        """Java's atom(): a run of literal characters, which stops before the last one when a repeat follows it."""
        first = 0
        prev = -1
        ch = self.peek()
        while True:
            if ch in ("*", "+", "?", "{"):
                if first > 1:
                    self.cursor = prev
                return
            if ch == EOF or ch in "$.^([|)":
                return
            if ch == "\\":
                prev = self.cursor
                kind, _ = self.escape(False, first == 0, False, study)
                if kind == "char":
                    first += 1
                    ch = self.peek()
                    continue
                if first > 0:
                    self.cursor = prev  # a \d or \b after literals starts the next atom
                return
            prev = self.cursor
            first += 1
            ch = self.next()

    def closure(self, atom, study):
        """Java's closure(): ?, *, + and {n}, {n,}, {n,m}, each maybe lazy (?) or possessive (+)."""
        ch = self.peek()
        if ch == "?":
            after = self.next()
            if after in ("?", "+"):
                self.next()
            study.choice = True
            return
        if ch in ("*", "+"):
            low, high = (0 if ch == "*" else 1), MAX_REPS
            after = self.next()
            if after in ("?", "+"):
                self.next()
        elif ch == "{":
            c = self.skip()
            if c not in DIGITS:
                raise _Refusal(BRACE)
            low = 0
            while True:
                low = low * 10 + int(c)
                if low > INT_MAX:
                    raise _Refusal(REPEAT_COUNT)
                c = self.read()
                if c not in DIGITS:
                    break
            high = low
            if c == ",":
                c = self.read()
                if c == "}":
                    high = MAX_REPS
                else:
                    high = 0
                    while c in DIGITS and c != EOF:
                        high = high * 10 + int(c)
                        if high > INT_MAX:
                            raise _Refusal(REPEAT_COUNT)
                        c = self.read()
            if c != "}":
                raise _Refusal(BRACE)
            if high < low:
                raise _Refusal(REPEAT_ORDER)
            after = self.peek()
            if after in ("?", "+"):
                self.next()
        else:
            return
        if low != high:
            study.choice = True
        if isinstance(atom, _Group) and atom.choice and after != "+":
            study.choice = True
            if study.unbounded is None:
                study.unbounded = LOOKBEHIND_REPEAT

    def group(self, study):
        """Java's group0(). Returns False for inline flags such as (?x), which nothing may repeat."""
        saved = self.comments
        body = _Study()
        lookaround = atomic = False
        ch = self.next()
        if ch == "?":
            ch = self.skip()
            if ch == ":":
                self.expr(body)
            elif ch in ("=", "!"):
                lookaround = True
                self.expr(body)
            elif ch == ">":
                atomic = True
                self.expr(body)
            elif ch == "<":
                ch = self.read()
                if ch not in ("=", "!"):
                    raise _Refusal(OTHER)  # Java's (?<name>...), which Python refuses
                lookaround = True
                self.expr(body)
                if body.unbounded is not None:
                    raise _Refusal(body.unbounded)
            elif ch == "P":
                raise _Refusal(NAMED_GROUP)  # Python defines a group before (?P=name) can use it
            elif ch == "(":
                raise _Refusal(CONDITIONAL)
            elif ch == "#":
                raise _Refusal(COMMENT)
            else:
                self.unread()
                self.add_flags()
                ch = self.read()
                if ch == ")":
                    return False  # the flags hold to the end of the enclosing group
                if ch != ":":
                    raise _Refusal(f"the {ch} flag" if ch and ch in PYTHON_ONLY_FLAGS else OTHER)
                self.expr(body)
        else:
            self.groups += 1
            self.expr(body)
        if self.read() != ")":
            raise _Refusal(OTHER)  # Java: "Unclosed group"
        self.comments = saved
        if lookaround:
            return None  # Java does not measure what a look-ahead or look-behind holds
        if body.choice:
            study.choice = True
        if study.unbounded is None:
            study.unbounded = body.unbounded
        return None if atomic else _Group(body.choice)

    def add_flags(self):
        """Java's addFlag() and subFlag(). Only x matters here: it changes how the rest is read."""
        ch = self.peek()
        while True:
            if ch == "-":
                self.next()
                self.sub_flags()
                return
            if not ch or ch not in JAVA_FLAGS:
                return
            if ch == "x":
                self.comments = True
            ch = self.next()

    def sub_flags(self):
        ch = self.peek()
        while ch and ch in JAVA_FLAGS and ch != "U":  # Java's subFlag stops at U without moving past it
            if ch == "x":
                self.comments = False
            ch = self.next()

    def escape(self, in_set, create, is_range, study):
        """Java's escape(), in or out of a set: ("char", code), or ("meta", None) for a back reference, class or position."""
        ch = self.skip()
        if ch == "0":
            return "char", self.octal()
        if ch and ch in DIGITS:
            if in_set:
                raise _Refusal(SET_OCTAL)
            if create and study is not None:
                self.reference(int(ch))
                if study.unbounded is None:
                    study.unbounded = LOOKBEHIND_REFERENCE
            return "meta", None
        if ch == "b":
            if in_set:
                raise _Refusal(SET_BOUNDARY)
            if create and self.peek() == "{":
                if self.skip() == "g":
                    if self.read() == "}":
                        return "meta", None  # \b{g}, a grapheme boundary
                    raise _Refusal(GRAPHEME_BOUNDARY)
                self.unread()
                self.unread()
            return "meta", None
        if ch and ch in "ABGRXZz":
            if in_set:
                raise _Refusal(OTHER)
            return "meta", None
        if ch and ch in "dDhHsSVwW":
            return "meta", None
        if ch == "v":
            return ("char", 0x0B) if is_range else ("meta", None)
        if ch == "N":
            raise _Refusal(NAMED_CHARACTER)
        if ch == "U":
            raise _Refusal(U_ESCAPE)
        simple = {"a": 0x07, "e": 0x1B, "f": 0x0C, "n": 0x0A, "r": 0x0D, "t": 0x09}
        if ch in simple and ch:
            return "char", simple[ch]
        if ch == "c":
            control = self.read()  # \cX; Python has no \c
            if control == EOF:
                raise _Refusal(OTHER)
            return "char", ord(control) ^ 64
        if ch == "u":
            return "char", self.unicode()
        if ch == "x":
            return "char", self.hex()
        if ASCII_LETTER.fullmatch(ch):
            # \k needs a (?<name>...) group, which Python refuses; the other letters are not escapes in Java
            raise _Refusal(OTHER)
        return "char", ord(ch) if ch else 0

    def octal(self):
        """Java's o(): \\0 needs one octal digit, takes a second, and a third when the first is 0 to 3."""
        n = self.read()
        if not n or n not in OCTDIGITS:
            raise _Refusal(OCTAL_ZERO)
        m = self.read()
        if not m or m not in OCTDIGITS:
            self.unread()
            return int(n)
        o = self.read()
        if o and o in OCTDIGITS and n <= "3":
            return int(n + m + o, 8)
        self.unread()
        return int(n + m, 8)

    def hex(self):
        """Java's x() for \\xhh, the only form Python has."""
        n = self.read()
        m = self.read() if n and n in HEXDIGITS else EOF
        if not m or m not in HEXDIGITS:
            raise _Refusal(OTHER)
        return int(n + m, 16)

    def unicode(self):
        """Java's u(): \\uhhhh, and a following \\uhhhh joins a high surrogate to its low one."""
        high = self.uxxxx()
        if not 0xD800 <= high <= 0xDBFF:
            return high
        cursor = self.cursor
        if self.read() == "\\" and self.read() == "u":
            low = self.uxxxx()
            if 0xDC00 <= low <= 0xDFFF:
                return 0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00)
        self.cursor = cursor
        return high

    def uxxxx(self):
        value = 0
        for _ in range(4):
            ch = self.read()
            if not ch or ch not in HEXDIGITS:
                raise _Refusal(OTHER)
            value = value * 16 + int(ch, 16)
        return value

    def reference(self, number):
        """Java's ref(): more digits belong to the reference while that group exists."""
        while True:
            ch = self.peek()
            if not ch or ch not in DIGITS:
                return
            longer = number * 10 + int(ch)
            if self.groups - 1 < longer:
                return
            number = longer
            self.read()

    def set(self, consume):
        """Java's clazz(): sets nest, && intersects, and ] closes a set only once it has a member."""
        members = False
        ch = self.next()
        if ch == "^" and self.at(self.cursor - 1) == "[":
            ch = self.next()
        while True:
            if ch == "[":
                self.nested_set()
                members = True
                ch = self.peek()
                continue
            if ch == "&":
                ch = self.next()
                if ch == "&":
                    ch = self.next()
                    right = False
                    while ch not in ("]", "&"):
                        if ch == "[":
                            self.nested_set()
                        else:
                            self.unread()
                            self.set(False)
                        right = True
                        ch = self.peek()
                    if not members and not right:
                        raise _Refusal(SET_INTERSECTION)
                    members = True
                    continue
                self.unread()  # a single & is a member
            elif ch == EOF:
                # Java: "Unclosed character class"
                if self.comments:
                    raise _Refusal(VERBOSE_SET)
                raise _Refusal(NESTED_SET if self.nested else OTHER)
            elif ch == "]" and members:
                if consume:
                    self.next()
                return
            self.range()
            members = True
            ch = self.peek()

    def nested_set(self):
        self.nested += 1
        self.set(True)
        self.nested -= 1

    def range(self):
        """Java's range(): one member, or a range such as a-z whose end is not below its start."""
        ch = self.peek()
        if ch == "\\":
            is_range = self.at(self.cursor + 2) == "-"
            kind, start = self.escape(True, True, is_range, None)
            if kind == "meta":
                return
        else:
            self.next()
            start = ord(ch) if ch else 0
        if self.peek() != "-":
            return
        if self.at(self.cursor + 1) in ("[", "]"):
            return
        self.next()
        m = self.peek()
        if m == "\\":
            kind, end = self.escape(True, False, True, None)
            if kind == "meta":
                end = -1
        else:
            self.next()
            end = ord(m) if m else 0
        if end < start:
            # Java: "Illegal character range"; in a verbose pattern a space or # moved the end
            raise _Refusal(VERBOSE_SET if self.comments else OTHER)


def java_regex_problem(pattern):
    """The construct that stops Java compiling the pattern, or None when Java compiles it.

    Give it patterns re.compile accepts; others may be accepted.
    """
    parser = _JavaParser(pattern)
    try:
        parser.check()
    except _Refusal as refusal:
        if refusal.construct == OTHER and parser.comment_cut_short:
            return VERBOSE_COMMENT
        return refusal.construct
    return None


def java_regex_clause(construct):
    """What the loader says about a pattern the system-table scan can't run, after the field and the pattern."""
    if construct == NAMED_CHARACTER:
        return f"uses {construct}, which the system-table scan may not know; write the character itself"
    return f"uses {construct}, which the system-table scan can't run"
