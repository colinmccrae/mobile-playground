#!/usr/bin/env python3
"""Sanity-check the site before pushing.

Run from the repo root:  python3 scripts/validate.py

Checks:
  * tools.json parses and every entry has the required fields
  * every entry's slug is kebab-case and unique
  * every entry has a matching tools/<slug>/index.html
  * every tools/<slug>/ directory (except _template) is listed in tools.json
  * every tool page has a viewport meta, links the shared stylesheet, and links back home
Exit status is non-zero on any failure, so it can gate a push.
"""
import json
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS_DIR = ROOT / "tools"
REGISTRY = ROOT / "tools.json"
REQUIRED = ("slug", "name", "description", "icon", "added")
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

errors: list[str] = []


def err(msg: str) -> None:
    errors.append(msg)


def main() -> int:
    try:
        data = json.loads(REGISTRY.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        print(f"FAIL tools.json does not parse: {e}")
        return 1

    tools = data.get("tools")
    if not isinstance(tools, list):
        print('FAIL tools.json must be {"tools": [...]}')
        return 1

    seen: set[str] = set()
    for i, t in enumerate(tools):
        where = f"tools.json entry {i}"
        for key in REQUIRED:
            if not t.get(key):
                err(f"{where}: missing '{key}'")
        slug = t.get("slug", "")
        if slug and not SLUG_RE.match(slug):
            err(f"{where}: slug '{slug}' must be kebab-case (a-z, 0-9, hyphens)")
        if slug in seen:
            err(f"{where}: duplicate slug '{slug}'")
        seen.add(slug)
        if "tags" in t and not (isinstance(t["tags"], list) and all(isinstance(x, str) for x in t["tags"])):
            err(f"{where}: 'tags' must be a list of strings")
        added = t.get("added", "")
        try:
            date.fromisoformat(added)
        except ValueError:
            err(f"{where}: 'added' must be YYYY-MM-DD, got '{added}'")

        page = TOOLS_DIR / slug / "index.html"
        if not page.is_file():
            err(f"{where}: {page.relative_to(ROOT)} does not exist")
            continue
        html = page.read_text(encoding="utf-8", errors="replace")
        if 'name="viewport"' not in html:
            err(f"{page.relative_to(ROOT)}: missing <meta name=\"viewport\">")
        if "../../assets/style.css" not in html:
            err(f"{page.relative_to(ROOT)}: should link ../../assets/style.css")
        if 'href="../../"' not in html:
            err(f"{page.relative_to(ROOT)}: missing a link back to the landing page (href=\"../../\")")
        if re.search(r"TOOL_(NAME|SLUG|ICON|DESCRIPTION)", html):
            err(f"{page.relative_to(ROOT)}: still contains TOOL_* placeholders from the template")

    if TOOLS_DIR.is_dir():
        for d in sorted(TOOLS_DIR.iterdir()):
            if d.is_dir() and not d.name.startswith("_") and d.name not in seen:
                err(f"tools/{d.name}/ exists but is not listed in tools.json")

    if errors:
        print("FAIL")
        for e in errors:
            print(f"  - {e}")
        return 1
    print(f"OK  {len(tools)} tool(s) registered, all pages present.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
