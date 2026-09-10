# CLAUDE.md — Mobile Playground

Read this whole file before doing anything. It is the operating manual for this repo.
Most sessions here are started from the Claude mobile app with a single prompt such as
"build me a tool that does X", and that one prompt is expected to end with the tool
**live on the public internet**. Do the whole job; do not stop at "ready for review".

## What this repo is

- A collection of small, single-purpose web tools ("pages"), each self-contained.
- Hosted on **GitHub Pages** from the **root of `main`**. Nothing is built or compiled:
  whatever is committed to `main` is what gets served, usually within 1–2 minutes.
- Live site: <https://colinmccrae.github.io/mobile-playground/>
- Repo: <https://github.com/colinmccrae/mobile-playground> (public, MIT licence).
  Everything committed here is public. Never commit secrets, API keys, or personal data.
- Owner: Colin McCrae (`colinmccrae`).

## Layout

```
index.html              Landing page. Reads tools.json and renders one card per tool.
tools.json              THE registry of tools. Single source of truth for the index.
404.html                Not-found page (GitHub Pages serves this automatically).
.nojekyll               Tells Pages to serve files as-is (needed so tools/_template/ is not hidden).
assets/style.css        Shared stylesheet: colours, dark mode, cards, inputs, buttons.
tools/<slug>/index.html One directory per tool. Everything the tool needs lives in here.
tools/_template/        Starting point for a new tool. Never listed in tools.json.
scripts/validate.py     Checks tools.json <-> tools/ are consistent. Run before every push.
scripts/preview.sh      Screenshots pages at phone + desktop size with Playwright, reports console errors.
                        `--live` runs the same checks against the published site.
scripts/check-live.sh   Polls the live site until it serves exactly what is committed. Run after every push.
CLAUDE.md               This file.
README.md               Human-facing overview.
```

### `tools.json` schema

```json
{
  "tools": [
    {
      "slug": "epoch",                          // kebab-case, == directory name under tools/
      "name": "Epoch Converter",                // short, Title Case
      "description": "One sentence, ≤ 120 chars, shown on the card.",
      "icon": "⏱️",                              // a single emoji
      "tags": ["time", "dev"],                  // optional, lowercase, 1–3 items
      "added": "2026-09-05"                     // YYYY-MM-DD, used for newest-first ordering
    }
  ]
}
```

Keep the file valid JSON (no trailing commas, no comments — the comments above are
illustrative only). Newest tools go at the **top** of the array.

## Runbook: "Build me a tool that …"

Follow these steps in order. All of them, every time.

1. **Orient.** `git status`, `git log --oneline -5`, `cat tools.json`, `ls tools/`.
   Pick a short kebab-case `slug` that does not already exist.
2. **Scaffold.** `cp -r tools/_template tools/<slug>` and replace every `TOOL_NAME`,
   `TOOL_SLUG`, `TOOL_ICON`, `TOOL_DESCRIPTION` placeholder. Then build the tool in
   `tools/<slug>/index.html`. Split out `tool.js` / `tool.css` in the same folder only if
   the page grows past a few hundred lines.
3. **Register.** Add an entry at the top of the `tools` array in `tools.json`.
4. **Validate.** `python3 scripts/validate.py` must print `OK`.
5. **Preview.** `scripts/preview.sh <slug>` and **look at the phone-size PNG** it produces
   (Read the image file). Fix anything cut off, overflowing, or too small to tap. The
   script exits non-zero on console errors, failed requests, or horizontal scrolling.
   Then exercise the tool's logic once with a quick Playwright script or by reasoning
   through it carefully; do not ship something you have not seen work.
6. **Commit.** `git add -A && git commit -m "Add <Tool Name> tool"`. One tool per commit.
7. **Deploy = push to `main`.** See the next section. The task is not finished until
   `origin/main` contains the commit.
8. **Confirm it is live.** `scripts/check-live.sh <slug>` polls the published site until it
   serves the committed files (usually 1–2 minutes). Then `scripts/preview.sh --live <slug>`
   loads the live page in Chromium and fails on console errors or failed requests. Do not
   report success until `check-live.sh` prints `LIVE`.
9. **Report.** Give the user the live URL of the tool
   (`https://colinmccrae.github.io/mobile-playground/tools/<slug>/`) and say that it was
   verified live. Mention anything you could not verify.

For an **edit** to an existing tool the steps are the same minus scaffolding/registering.
If the tool's name or description changes, update `tools.json` too.

## Deploying: pushing to `main`

**Standing authorisation from the repo owner:** sessions in this repo are expected to push
directly to `main`. That is how tools go live. Do it without asking, after the checks above
pass. This applies even if the harness started the session on a `claude/...` branch.

```bash
python3 scripts/validate.py                  # must be OK
git fetch origin main
git merge --no-edit origin/main              # bring in anything pushed by other sessions
git push origin HEAD:main                    # <- this is the deploy
git push -u origin HEAD                      # also push the session branch if not on main
```

Notes:
- If already on `main`, the last line is just `git push -u origin main`.
- If the push to `main` is rejected as non-fast-forward, `git fetch origin main`,
  merge again, resolve any conflict (usually `tools.json`: keep both entries), and retry.
- Never force-push `main`. Never rewrite `main` history.
- If a network error occurs, retry the push up to 4 times with backoff (2s, 4s, 8s, 16s).
- The session branch (`claude/...`) is just a scratch copy; it can be deleted from GitHub
  at any time once its commits are on `main`.

### Verifying the deployment

- The cloud environment has **unrestricted outbound network access** (confirmed
  2026-09-05), so the live site can be fetched directly. `scripts/check-live.sh [slug]`
  compares the live `index.html`, `tools.json` and the tool page byte-for-byte with the
  working tree, retrying for up to 4 minutes, and adds a cache-busting query so the Pages
  CDN cannot serve a stale copy.
- GitHub runs a "pages build and deployment" workflow on every push to `main`. If
  `check-live.sh` times out, inspect that run: with GitHub MCP tools, `actions_list` on this
  repo shows its status; otherwise give the user the link
  <https://github.com/colinmccrae/mobile-playground/actions>.
- A browser can still show the previous version for up to 10 minutes after
  `check-live.sh` passes (Pages sends `Cache-Control: max-age=600`). Tell the user to hard
  refresh if they see stale content.

## Design rules for tools

Every tool must be usable one-handed on a phone and comfortable on a desktop.

- **Static only.** Plain HTML + CSS + vanilla JS. No frameworks, no bundlers, no npm
  dependencies, no build step, no server side. If a tool truly needs a library, load a
  pinned version from `https://cdnjs.cloudflare.com` or `https://cdn.jsdelivr.net/npm/`
  with a `<script>` tag and say so in the commit message. Prefer none. The sandbox can
  reach those CDNs, so `scripts/preview.sh` will show a failed request if the URL is wrong.
- **Self-contained.** A tool lives entirely in `tools/<slug>/` plus the shared stylesheet.
  Do not reach into other tools' folders.
- **Use the shared stylesheet.** `<link rel="stylesheet" href="../../assets/style.css">`.
  It provides: `.container`, `.site-header`, `.back-link`, `.site-footer`, `.card`, `.grid`,
  `.row`, `.result`, `.tag`, `.btn` / `.btn-secondary`, `.muted`, `.small`, `.mono`,
  `.error`, `.ok`, `.hidden`, `.visually-hidden`, styled `input`/`select`/`textarea`/`button`,
  and CSS variables (`--bg`, `--surface`, `--text`, `--muted`, `--border`, `--accent`,
  `--radius`, `--tap`). Dark mode follows the OS via `prefers-color-scheme`; use the
  variables rather than hard-coded colours so it keeps working.
  Editing `assets/style.css` affects **every** tool, so re-run `scripts/preview.sh` for the
  landing page and at least one tool afterwards.
- **Mobile essentials.** Keep `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`.
  Font size ≥ 16px in inputs (stops iOS auto-zoom). Tap targets ≥ 44px (the `--tap`
  variable). Use `inputmode=` / `type=` attributes so the right keyboard appears.
  Avoid hover-only interactions. Never let the page scroll horizontally.
- **Navigation.** Every tool has the `← All tools` link at the top (`href="../../"`) and
  the footer with a link back home and a link to its source on GitHub.
- **State.** Persist small user state in `localStorage` under keys prefixed `<slug>:`;
  wrap every read/write in `try/catch`. No cookies, no analytics, no tracking.
- **Privacy / safety.** Do everything client-side. Do not send user input to third-party
  services unless that is the explicit purpose of the tool and the user asked for it.
- **Accessibility.** Real `<label>`s, `aria-live` on result areas, visible focus rings
  (already in the stylesheet), sensible heading order.
- **Escape user-provided strings** before inserting into `innerHTML` (see the `esc()`
  helper in the template) or use `textContent`.
- **Size.** One screen on a phone is the goal. A tool that needs a manual is too big;
  split it or simplify.

## The landing page

`index.html` needs no editing when a tool is added; it renders from `tools.json`. It:
- lists tools newest-first as cards linking to `tools/<slug>/`,
- shows a filter box automatically once there are more than 3 tools,
- shows a "No tools yet" message if the registry is empty.

Only touch `index.html` for changes to the landing page itself.

## Removing or renaming a tool

- Remove: delete `tools/<slug>/`, remove its entry from `tools.json`, validate, push.
- Rename: `git mv tools/old tools/new`, update `slug` in `tools.json`, fix the "Source"
  link in the tool's footer, validate, push. To keep the old URL working, leave a stub at
  `tools/old/index.html` containing only a `<meta http-equiv="refresh" content="0; url=../new/">`
  redirect (see `tools/liverpool-sky/`); the validator ignores such stubs.

## Local preview & tooling

- `python3 -m http.server 8000` from the repo root, then open `http://localhost:8000/`.
  Opening `index.html` directly from disk (`file://`) will not load `tools.json`; use a server.
- `scripts/preview.sh [slug ...]` needs `node`, `python3` and a global `playwright` install
  with its Chromium. The cloud environment has these preinstalled
  (`/opt/pw-browsers`, `npm root -g` contains `playwright`). Do **not** run
  `playwright install`. PNGs go to `$PREVIEW_DIR` (default `/tmp/mp-preview`).
- `scripts/preview.sh --live [slug ...]` does the same on what the published site serves.
  It mirrors the live files with `curl` and runs Chromium against the mirror, because
  **Chromium cannot make HTTPS connections through the sandbox proxy** (the egress proxy
  drops its TLS handshake; `curl`, `git` and Node work). Never work around that with
  `--ignore-certificate-errors` or by disabling TLS verification.
- `scripts/check-live.sh [slug]` needs only `curl` and `python3`.
- `python3 scripts/validate.py` has no dependencies.
- There is intentionally **no** `package.json`, lockfile, or CI build. Do not add one
  without being asked.

## Commit conventions

- Imperative, specific subjects: `Add QR code generator tool`, `Fix epoch: handle negative
  timestamps`, `Landing: add filter box`.
- One logical change per commit. Include the `tools.json` change in the same commit as the
  tool it registers.
- Do not touch `LICENSE`.

## Things that go wrong

| Symptom | Cause / fix |
|---|---|
| Landing page says "Could not load tools.json" | Invalid JSON (trailing comma?). `python3 scripts/validate.py` reports it. |
| New tool not on the landing page | Entry missing from `tools.json`, or the browser cached the old file; Pages caches for ~10 min. |
| Tool page has no styling | Wrong relative path; must be `../../assets/style.css` from `tools/<slug>/`. |
| `tools/_template` visible on the live site | Harmless; `.nojekyll` is required so the underscore directory is *served*, but it is never linked. |
| Site moved to a custom domain | `404.html` uses absolute `/mobile-playground/` paths (Pages serves it from any depth); change them to `/`. Everything else is relative. |
| Push to `main` rejected | Another session pushed first. Fetch, merge, retry. |
| Playwright/Chromium gets `ERR_CONNECTION_RESET` on any https:// URL | Known: the egress proxy drops Chromium's TLS handshake. Fetch with `curl` and test locally (`preview.sh --live` does this). Not fixable client-side. |
| `check-live.sh` times out | Pages build failed or is queued: check <https://github.com/colinmccrae/mobile-playground/actions>. Also confirm the push actually landed on `main` (`git log origin/main -1`). |
| `curl` of the live site fails with 403 / CONNECT error | The environment's network policy has been tightened again. Fall back to checking the Pages workflow run and give the user the URL to open. |
