#!/usr/bin/env node
/* Screenshot the landing page and (optionally) tool pages at phone + desktop
 * sizes with Playwright, and report any console errors / failed requests.
 *
 *   scripts/preview.sh              # landing page only
 *   scripts/preview.sh epoch        # landing page + tools/epoch/
 *   scripts/preview.sh epoch other  # several tools
 *
 * Use scripts/preview.sh rather than calling this directly: it sets NODE_PATH
 * so the globally-installed playwright resolves, and starts a local server.
 * Output PNGs go to $PREVIEW_DIR (default /tmp/mp-preview).
 */
const path = require('path');
const fs = require('fs');

let playwright;
try { playwright = require('playwright'); }
catch { console.error('playwright not found. Run via scripts/preview.sh, or `npm i -g playwright`.'); process.exit(1); }

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765';
const OUT = process.env.PREVIEW_DIR || '/tmp/mp-preview';
const slugs = process.argv.slice(2);

const targets = [['index', '/']].concat(slugs.map(s => [s, `/tools/${s}/`]));
const viewports = [
  { name: 'phone',   viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await playwright.chromium.launch({ args: ['--no-sandbox'] });
  let problems = 0;

  for (const vp of viewports) {
    const ctx = await browser.newContext(vp);
    for (const [name, urlPath] of targets) {
      const page = await ctx.newPage();
      const issues = [];
      page.on('console', m => { if (m.type() === 'error') issues.push(`console.error: ${m.text()}`); });
      page.on('pageerror', e => issues.push(`uncaught: ${e.message}`));
      page.on('requestfailed', r => issues.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
      page.on('response', r => { if (r.status() >= 400) issues.push(`HTTP ${r.status()}: ${r.url()}`); });

      await page.goto(BASE + urlPath, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300); // let async rendering settle

      // Horizontal overflow is the most common mobile bug; flag it.
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) issues.push(`page scrolls horizontally by ${overflow}px`);

      const file = path.join(OUT, `${name}-${vp.name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(`${issues.length ? 'WARN' : 'OK  '} ${file}`);
      for (const i of issues) { console.log(`       - ${i}`); problems++; }
      await page.close();
    }
    await ctx.close();
  }
  await browser.close();
  process.exit(problems ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
