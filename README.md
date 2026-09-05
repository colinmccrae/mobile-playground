# Mobile Playground

Small, single-purpose web tools, built on the go with [Claude Code](https://claude.com/claude-code) and published automatically with GitHub Pages.

**Live site:** https://colinmccrae.github.io/mobile-playground/

## How it works

- Every tool is a self-contained static page under `tools/<slug>/`, using plain HTML, CSS and JavaScript. No frameworks, no build step, no server.
- `tools.json` is the registry. The landing page reads it and renders a card for every tool, newest first.
- Whatever lands on `main` is live on the site within a minute or two.
- The whole process of building a tool and getting it online is scripted for Claude Code in [`CLAUDE.md`](CLAUDE.md).

## Adding a tool

Open Claude Code (mobile app, web, or CLI) against this repo and describe the tool. For example:

> Build a tool that converts between metric and imperial units. Live on main when done.

Claude will scaffold `tools/<slug>/` from the template, register it in `tools.json`, validate and preview it, commit, and push to `main`. The tool then appears at `https://colinmccrae.github.io/mobile-playground/tools/<slug>/` and on the landing page.

To do it by hand:

1. `cp -r tools/_template tools/my-tool` and edit `tools/my-tool/index.html`.
2. Add an entry to `tools.json` (see the schema in `CLAUDE.md`).
3. `python3 scripts/validate.py`
4. Commit and push to `main`.
5. `scripts/check-live.sh my-tool` to confirm it is being served.

## Repository layout

```
index.html         landing page (renders tools.json)
tools.json         registry of tools
tools/<slug>/      one directory per tool
tools/_template/   starting point for new tools
assets/style.css   shared, mobile-first stylesheet with dark mode
scripts/           validate.py (consistency check), preview.sh (screenshots + console errors),
                   check-live.sh (confirms the published site matches the repo)
```

## Local preview

```bash
python3 -m http.server 8000     # then open http://localhost:8000/
scripts/preview.sh epoch        # screenshots at phone + desktop size (needs Playwright)
scripts/preview.sh --live epoch # the same checks against the live site
scripts/check-live.sh epoch     # wait until the live site serves the committed files
```

## Licence

[MIT](LICENSE)
