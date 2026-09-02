"""Static check of the frontend's ES modules.

The frontend has no build step, which is the point -- no npm, no bundler, instant
startup. The cost is that nothing checks the module graph until a browser loads
it, and the failure mode is silent: an import of a name that does not exist gives
`undefined`, and the page dies at the first call with a console error nobody is
watching.

This closes that gap without adding a toolchain:

* every relative import resolves to a file that exists;
* every named import actually corresponds to an export in the target;
* nothing imports a name it never uses (dead imports drift into rot);
* braces, parens and brackets balance, and template literals are closed
  (a crude but effective syntax smoke test);
* no accidental `console.log` left behind.

Run it after touching anything under web/js:

    .venv/bin/python tools/check_frontend.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JS_DIR = ROOT / "web" / "js"

GREEN, RED, YELLOW, DIM, RESET = (
    "\033[32m", "\033[31m", "\033[33m", "\033[90m", "\033[0m",
)

# import { a, b as c } from "./x.js"   |   import * as ns from "./x.js"
IMPORT_RE = re.compile(
    r"""^\s*import\s+(?:
            (?P<namespace>\*\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*)
          | \{(?P<named>[^}]*)\}
          | (?P<default>[A-Za-z_$][A-Za-z0-9_$]*)
        )\s+from\s+["'](?P<source>[^"']+)["']""",
    re.MULTILINE | re.VERBOSE,
)
BARE_IMPORT_RE = re.compile(r"""^\s*import\s+["'](?P<source>[^"']+)["']""", re.MULTILINE)

# `[A-Za-z_$][\w$]*`, not `\w+`: `$` and `$$` are legal JS identifiers and are
# the names of the two query helpers in dom.js. A `\w`-only pattern reported
# every `import { $ }` in the codebase as importing a non-existent export.
IDENT = r"[A-Za-z_$][A-Za-z0-9_$]*"

EXPORT_DECL_RE = re.compile(
    rf"^\s*export\s+(?:async\s+)?(?:function|class|const|let|var)\s+({IDENT})",
    re.MULTILINE,
)
# export { a, b as c }
EXPORT_LIST_RE = re.compile(r"^\s*export\s*\{([^}]*)\}", re.MULTILINE)
EXPORT_DEFAULT_RE = re.compile(r"^\s*export\s+default\b", re.MULTILINE)

# Strings and comments are stripped before brace counting, otherwise a brace
# inside a CSS-in-JS string or a regex breaks the balance check.
STRIP_RE = re.compile(
    r"""
      //[^\n]*                      # line comment
    | /\*.*?\*/                     # block comment
    | "(?:\\.|[^"\\\n])*"           # double-quoted
    | '(?:\\.|[^'\\\n])*'           # single-quoted
    | `(?:\\.|[^`\\])*`             # template literal
    """,
    re.DOTALL | re.VERBOSE,
)

problems: list[str] = []
warnings: list[str] = []


def note_problem(message: str) -> None:
    problems.append(message)


def note_warning(message: str) -> None:
    warnings.append(message)


def exports_of(text: str) -> set[str]:
    names = set(EXPORT_DECL_RE.findall(text))
    for group in EXPORT_LIST_RE.findall(text):
        for part in group.split(","):
            part = part.strip()
            if not part:
                continue
            # `x as y` exports y.
            names.add(part.split(" as ")[-1].strip())
    if EXPORT_DEFAULT_RE.search(text):
        names.add("default")
    return names


def imports_of(text: str) -> list[tuple[str, list[str], bool]]:
    """-> [(source, [imported names], is_namespace)]"""
    found: list[tuple[str, list[str], bool]] = []
    for match in IMPORT_RE.finditer(text):
        source = match.group("source")
        if match.group("namespace"):
            found.append((source, [], True))
        elif match.group("named"):
            names = []
            for part in match.group("named").split(","):
                part = part.strip()
                if not part:
                    continue
                names.append(part.split(" as ")[0].strip())
            found.append((source, names, False))
        elif match.group("default"):
            found.append((source, ["default"], False))
    for match in BARE_IMPORT_RE.finditer(text):
        found.append((match.group("source"), [], False))
    return found


def local_names(text: str, source: str) -> list[str]:
    """Names bound by an import, for the unused-import check."""
    out = []
    for match in IMPORT_RE.finditer(text):
        if match.group("source") != source:
            continue
        if match.group("namespace"):
            out.append(match.group("namespace").split("as")[-1].strip())
        elif match.group("named"):
            for part in match.group("named").split(","):
                part = part.strip()
                if part:
                    out.append(part.split(" as ")[-1].strip())
        elif match.group("default"):
            out.append(match.group("default"))
    return out


def check_balance(path: Path, text: str) -> None:
    stripped = STRIP_RE.sub(lambda m: " " * len(m.group(0)), text)
    pairs = {"{": "}", "(": ")", "[": "]"}
    closers = {v: k for k, v in pairs.items()}
    stack: list[tuple[str, int]] = []
    line = 1
    for char in stripped:
        if char == "\n":
            line += 1
        elif char in pairs:
            stack.append((char, line))
        elif char in closers:
            if not stack:
                note_problem(f"{path.name}:{line}: unmatched '{char}'")
                return
            opener, opened_at = stack.pop()
            if pairs[opener] != char:
                note_problem(
                    f"{path.name}:{line}: '{char}' closes '{opener}' opened on "
                    f"line {opened_at}"
                )
                return
    if stack:
        opener, opened_at = stack[-1]
        note_problem(f"{path.name}: '{opener}' opened on line {opened_at} never closed")

    # Unterminated template literal: an odd number of backticks outside
    # comments and quotes.
    without_templates = re.sub(r"`(?:\\.|[^`\\])*`", "", text, flags=re.DOTALL)
    without_templates = re.sub(r"//[^\n]*|/\*.*?\*/", "", without_templates, flags=re.DOTALL)
    if without_templates.count("`") % 2:
        note_problem(f"{path.name}: unterminated template literal (odd backtick count)")


def main() -> int:
    files = sorted(JS_DIR.rglob("*.js"))
    if not files:
        print(f"{RED}No JS files found under {JS_DIR}{RESET}")
        return 1

    texts: dict[Path, str] = {}
    export_map: dict[Path, set[str]] = {}
    for path in files:
        text = path.read_text(encoding="utf-8")
        texts[path] = text
        export_map[path] = exports_of(text)

    print(f"\nchecking {len(files)} module(s) under web/js\n" + "-" * 66)

    for path in files:
        text = texts[path]
        rel = path.relative_to(JS_DIR).as_posix()
        issues_before = len(problems)

        check_balance(path, text)

        for source, names, is_namespace in imports_of(text):
            if not source.startswith("."):
                note_problem(f"{rel}: bare import {source!r} — there is no bundler, "
                             "so only relative paths resolve")
                continue
            if not source.endswith(".js"):
                note_problem(f"{rel}: import {source!r} has no .js extension — "
                             "browsers do not add one")
                continue

            target = (path.parent / source).resolve()
            if target not in export_map:
                note_problem(f"{rel}: imports {source!r}, which does not exist")
                continue

            if is_namespace:
                continue
            available = export_map[target]
            for name in names:
                if name not in available:
                    close = sorted(
                        candidate for candidate in available
                        if candidate.lower().startswith(name.lower()[:4])
                    )
                    hint = f" (did you mean {', '.join(close[:3])}?)" if close else ""
                    note_problem(
                        f"{rel}: imports {{{name}}} from {source}, which does not "
                        f"export it{hint}"
                    )

            # Unused imports. `\b` is useless around `$`, which is not a word
            # character, so the boundary is expressed as "not preceded/followed
            # by an identifier character" instead.
            body = IMPORT_RE.sub("", text)
            for bound in local_names(text, source):
                pattern = (rf"(?<![A-Za-z0-9_$]){re.escape(bound)}"
                           rf"(?![A-Za-z0-9_$])")
                if not re.search(pattern, body):
                    note_warning(f"{rel}: imports {bound!r} but never uses it")

        for match in re.finditer(r"\bconsole\.log\(", text):
            line = text[: match.start()].count("\n") + 1
            note_warning(f"{rel}:{line}: stray console.log")

        status = f"{RED}FAIL{RESET}" if len(problems) > issues_before else f"{GREEN}ok  {RESET}"
        exported = len(export_map[path])
        print(f"{status} {rel:<28} {exported:>2} export(s)  "
              f"{len(text.splitlines()):>4} lines")

    # Cross-check: exports nobody imports (dead code, or an intentional API).
    imported_anywhere: set[tuple[Path, str]] = set()
    for path in files:
        for source, names, is_namespace in imports_of(texts[path]):
            if not source.startswith("."):
                continue
            target = (path.parent / source).resolve()
            if is_namespace:
                # `import * as fmt from "./format.js"` uses the whole surface.
                # Without this, every formatter looked like dead code.
                for name in export_map.get(target, ()):
                    imported_anywhere.add((target, name))
                continue
            for name in names:
                imported_anywhere.add((target, name))
    entry = JS_DIR / "app.js"
    for path in files:
        if path == entry:
            continue
        for name in sorted(export_map[path]):
            if (path, name) not in imported_anywhere:
                note_warning(
                    f"{path.relative_to(JS_DIR).as_posix()}: exports {name!r} that "
                    "nothing imports"
                )

    print("-" * 66)
    for warning in warnings:
        print(f"{YELLOW}warn{RESET} {warning}")
    for problem in problems:
        print(f"{RED}FAIL{RESET} {problem}")

    if problems:
        print(f"\n{RED}{len(problems)} problem(s) — the page would break in a "
              f"browser.{RESET}\n")
        return 1
    print(f"\n{GREEN}Module graph is consistent.{RESET}"
          f"{f' {len(warnings)} warning(s).' if warnings else ''}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
