/* Meet Halfway: shade a map by drive time from two places and suggest fair, nice places to meet.
 * Routing: OSRM demo server (router.project-osrm.org) table service, keyless, CORS-enabled.
 * Places: Wikivoyage geosearch. Geocoding: Nominatim (only on an explicit search, never per keystroke). */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const RAD = Math.PI / 180;
  const OSRM = 'https://router.project-osrm.org/table/v1/driving/';
  const WV_API = 'https://en.wikivoyage.org/w/api.php';
  const WV_PAGE = 'https://en.wikivoyage.org/wiki/';
  const GEOCODE = 'https://nominatim.openstreetmap.org/search';
  const KEY = 'meet-halfway:';
  const GRID_TARGET = 1100;  // routed points per map
  const BATCH = 400;         // destinations per OSRM request (keeps the URL well under 8 KB)
  const STEPS = [1, 2, 3, 4, 6, 8, 12]; // band edges, in multiples of the step
  const lang = navigator.language || 'en-GB';
  const MILES = /^en$/i.test(lang) || /-(GB|US)$/i.test(lang);
  const DARK = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;

  // ---- Small helpers -------------------------------------------------------
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2));
  const invMerc = y => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD;
  function haversine(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function fmtDur(s) {
    if (s == null || !isFinite(s)) return '–';
    const m = Math.round(s / 60);
    return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  }
  function fmtDist(m) {
    if (m == null || !isFinite(m)) return '–';
    const v = MILES ? m / 1609.344 : m / 1000;
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + (MILES ? ' mi' : ' km');
  }
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(KEY + k)); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); return true; } catch (_) { return false; } },
    del(k) { try { localStorage.removeItem(KEY + k); } catch (_) { /* ignore */ } },
  };
  async function getJSON(url, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 30000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      return await r.json();
    } finally { clearTimeout(t); }
  }

  // ---- Cities (instant suggestions) ---------------------------------------
  const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const CITIES = (window.CITIES || []).map(c => ({
    name: c[0], region: c[1], country: c[2], iso2: c[3], lat: c[4], lng: c[5], pop: c[7],
    key: norm(c[0]), keyFull: norm(c[0] + ' ' + c[1] + ' ' + c[2] + ' ' + c[3]),
  }));
  function searchCities(q) {
    q = norm(String(q || '').trim());
    if (!q) return [];
    const parts = q.split(/[\s,]+/).filter(Boolean);
    const out = [];
    for (const c of CITIES) {
      let score = 0;
      if (c.key === q) score = 4;
      else if (c.key.startsWith(q)) score = 3;
      else if (c.key.includes(q)) score = 2;
      else if (parts.length > 1 && parts.every(p => c.keyFull.includes(p))) score = 1;
      if (score) out.push([score, c]);
    }
    out.sort((a, b) => b[0] - a[0] || b[1].pop - a[1].pop);
    return out.slice(0, 6).map(x => x[1]);
  }
  function nearestCityName(lat, lng) {
    let best = null, bestD = Infinity;
    for (const c of CITIES) { const d = haversine(lat, lng, c.lat, c.lng); if (d < bestD) { bestD = d; best = c; } }
    return best && bestD < 40 ? best.name : null;
  }

  // ---- State -----------------------------------------------------------------
  const S = { a: null, b: null, mode: 'total', measure: 'time', grid: null, places: [], run: 0 };

  // ---- Map ---------------------------------------------------------------------
  const map = L.map('map', { zoomSnap: 0.5, worldCopyJump: false });  // view is set by compute() once both places are known
  map.createPane('shade').style.zIndex = 350;
  map.getPane('shade').style.pointerEvents = 'none';
  // OpenStreetMap's standard tiles (keyless; CARTO's now need a key), faded so the shading stands out.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'base-tiles', opacity: DARK ? 0.35 : 0.55,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · routes <a href="https://project-osrm.org/">OSRM</a>',
  }).addTo(map);

  const pinIcon = (cls, text, size) => L.divIcon({ className: '', html: `<div class="pin ${cls}">${esc(text)}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2] });
  const layers = { overlay: null, line: null, lineCase: null, a: null, b: null, star: null, places: L.layerGroup().addTo(map) };

  // ---- Colour bands --------------------------------------------------------
  // Sequential (best -> worst): deep indigo to faint yellow ("plasma"), fading out as it gets worse.
  const SEQ = [[13, 8, 135, .80], [84, 2, 163, .74], [139, 10, 165, .68], [185, 50, 137, .60],
               [219, 92, 104, .52], [244, 136, 73, .44], [254, 189, 42, .34], [240, 249, 33, 0]];
  const EQUAL = [124, 58, 237, .62];
  const SIDE_A = [[37, 99, 235, .22], [37, 99, 235, .38], [37, 99, 235, .54]];
  const SIDE_B = [[234, 88, 12, .22], [234, 88, 12, .38], [234, 88, 12, .54]];
  const rgba = c => `rgba(${c[0]},${c[1]},${c[2]},${Math.min(1, c[3] + .15)})`;

  function unitScale() { return S.measure === 'time' ? 60 : (MILES ? 1609.344 : 1000); }
  const fmtVal = v => S.measure === 'time' ? fmtDur(v) : fmtDist(v);
  function niceStep(displayDirect) {
    const want = displayDirect / 20;
    const opts = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];
    let s = opts[0];
    for (const o of opts) if (o <= want) s = o;
    return s * unitScale();
  }

  // ---- Grid ------------------------------------------------------------------
  function makeGrid(A, B) {
    const latMid = (A.lat + B.lat) / 2;
    const kmLat = 111.32, kmLon = Math.max(5, 111.32 * Math.cos(latMid * RAD));
    const D = haversine(A.lat, A.lng, B.lat, B.lng);
    const pad = Math.max(0.35 * D, 25);
    const lonMin = Math.min(A.lng, B.lng) - pad / kmLon, lonMax = Math.max(A.lng, B.lng) + pad / kmLon;
    const latMin = clamp(Math.min(A.lat, B.lat) - pad / kmLat, -80, 80), latMax = clamp(Math.max(A.lat, B.lat) + pad / kmLat, -80, 80);
    const wKm = (lonMax - lonMin) * kmLon, hKm = (latMax - latMin) * kmLat;
    const cellKm = Math.sqrt(wKm * hKm / GRID_TARGET);
    const nx = Math.max(8, Math.round(wKm / cellKm) + 1), ny = Math.max(8, Math.round(hKm / cellKm) + 1);
    const yMin = mercY(latMin), yMax = mercY(latMax);
    const n = nx * ny, lat = new Float64Array(n), lon = new Float64Array(n);
    for (let j = 0; j < ny; j++) {
      const la = invMerc(yMax - j * (yMax - yMin) / (ny - 1));
      for (let i = 0; i < nx; i++) { lat[j * nx + i] = la; lon[j * nx + i] = lonMin + i * (lonMax - lonMin) / (nx - 1); }
    }
    return {
      nx, ny, lonMin, lonMax, latMin, latMax, yMin, yMax, cellKm, lat, lon,
      snapMax: Math.max(3000, 0.75 * cellKm * 1000),
      ok: new Uint8Array(n), ta: new Float64Array(n), tb: new Float64Array(n), da: new Float64Array(n), db: new Float64Array(n),
      direct: null, complete: false,
    };
  }
  const gridToLatLng = (G, gx, gy) => [invMerc(G.yMax - gy / (G.ny - 1) * (G.yMax - G.yMin)), G.lonMin + gx / (G.nx - 1) * (G.lonMax - G.lonMin)];
  function latLngToGrid(G, lat, lng) {
    return [(lng - G.lonMin) / (G.lonMax - G.lonMin) * (G.nx - 1), (G.yMax - mercY(lat)) / (G.yMax - G.yMin) * (G.ny - 1)];
  }
  // Bilinear sample of f(k) over valid nodes; NaN outside the grid or where the nearest node is unusable.
  function sampleGrid(G, lat, lng, f) {
    const [gx, gy] = latLngToGrid(G, lat, lng);
    if (!(gx >= 0 && gy >= 0 && gx <= G.nx - 1 && gy <= G.ny - 1)) return NaN;
    const i0 = Math.min(G.nx - 2, Math.floor(gx)), j0 = Math.min(G.ny - 2, Math.floor(gy));
    const fx = gx - i0, fy = gy - j0, k = j0 * G.nx + i0;
    const ks = [k, k + 1, k + G.nx, k + G.nx + 1], ws = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
    const near = ks[(fx < .5 ? 0 : 1) + (fy < .5 ? 0 : 2)];
    if (G.ok[near] !== 1) return NaN;
    let s = 0, w = 0;
    for (let q = 0; q < 4; q++) if (G.ok[ks[q]] === 1) { s += ws[q] * f(ks[q]); w += ws[q]; }
    return w ? s / w : NaN;
  }

  // ---- Routing -----------------------------------------------------------------
  const coordStr = p => p[1].toFixed(4) + ',' + p[0].toFixed(4); // p = [lat, lng]
  async function table(points) {
    const url = OSRM + points.map(coordStr).join(';') + '?sources=0;1&annotations=duration,distance';
    let wait = 1500;
    for (let attempt = 0; ; attempt++) {
      try {
        const j = await getJSON(url, 30000);
        if (j.code !== 'Ok') throw new Error(j.message || j.code);
        return j;
      } catch (e) {
        const retryable = !e.status || e.status === 429 || e.status >= 500;
        if (attempt >= 2 || !retryable) throw e;
        await sleep(wait); wait *= 2.5;
      }
    }
  }

  async function compute() {
    const A = S.a, B = S.b;
    if (!A || !B) return;
    const run = ++S.run;
    hideError();
    clearPlaces('Places appear once the map is ready.');
    if (haversine(A.lat, A.lng, B.lat, B.lng) < 1) { showError('Pick two different starting places.'); return; }
    const G = makeGrid(A, B);
    S.grid = G;
    drawEndpoints();
    map.fitBounds(L.latLngBounds([[A.lat, A.lng], [B.lat, B.lng]]).pad(0.2), { maxZoom: 11 });
    clearShading();

    if (loadCache(G, A, B)) { renderAll(); findPlaces(run); return; }

    const n = G.lat.length;
    setStatus('Working out drive times…', 0.03);
    try {
      for (let s = 0; s < n; s += BATCH) {
        const e = Math.min(n, s + BATCH);
        const pts = [[A.lat, A.lng], [B.lat, B.lng]];
        for (let i = s; i < e; i++) pts.push([G.lat[i], G.lon[i]]);
        const j = await table(pts);
        if (run !== S.run) return;
        if (!G.direct) {
          G.direct = { t: j.durations[0][1], d: j.distances[0][1], snapA: j.sources[0].distance, snapB: j.sources[1].distance };
          if (G.direct.t == null) { setStatus(null); showError(`There's no road route between ${A.name} and ${B.name}.`); return; }
        }
        for (let i = s; i < e; i++) {
          const k = i - s + 2;
          const ta = j.durations[0][k], tb = j.durations[1][k], snap = j.destinations[k].distance;
          if (ta == null || tb == null || snap > G.snapMax) { G.ok[i] = 2; continue; }
          G.ok[i] = 1; G.ta[i] = ta; G.tb[i] = tb; G.da[i] = j.distances[0][k]; G.db[i] = j.distances[1][k];
        }
        setStatus(`Working out drive times… ${Math.round(e / n * 100)}%`, e / n);
        renderAll();
        if (e < n) await sleep(350); // be gentle with the free demo server
      }
    } catch (err) {
      if (run !== S.run) return;
      setStatus(null);
      showError(err.status === 429
        ? 'The free routing server is busy right now. Wait a minute and try again.'
        : `Couldn't reach the routing server (${esc(err.message || err)}). Check your connection and try again.`, true);
      return;
    }
    G.complete = true;
    setStatus(null);
    saveCache(G, A, B);
    renderAll();
    findPlaces(run);
  }

  // ---- Cache (per pair of places, last 4 pairs) -----------------------------------
  const cacheKey = (A, B) => 'grid:' + [A.lat, A.lng, B.lat, B.lng].map(x => x.toFixed(3)).join(',');
  function saveCache(G, A, B) {
    const k = cacheKey(A, B);
    const r = a => Array.from(a, x => Math.round(x));
    const data = { v: 1, nx: G.nx, ny: G.ny, direct: G.direct, ok: Array.from(G.ok).join(''), ta: r(G.ta), tb: r(G.tb), da: r(G.da), db: r(G.db), at: Date.now() };
    let idx = (store.get('grids') || []).filter(x => x !== k);
    idx.unshift(k);
    const drop = old => { store.del(old); store.del('places:' + old); };
    while (idx.length > 4) drop(idx.pop());
    if (!store.set(k, data)) { while (idx.length > 1) drop(idx.pop()); store.set(k, data); }
    store.set('grids', idx);
  }
  function loadCache(G, A, B) {
    const c = store.get(cacheKey(A, B));
    if (!c || c.v !== 1 || c.nx !== G.nx || c.ny !== G.ny || Date.now() - c.at > 30 * 864e5) return false;
    const n = G.nx * G.ny;
    if (c.ok.length !== n) return false;
    for (let i = 0; i < n; i++) { G.ok[i] = +c.ok[i]; G.ta[i] = c.ta[i]; G.tb[i] = c.tb[i]; G.da[i] = c.da[i]; G.db[i] = c.db[i]; }
    G.direct = c.direct; G.complete = true;
    return true;
  }

  // ---- Rendering ----------------------------------------------------------------
  function series(G) {
    return S.measure === 'time' ? { a: G.ta, b: G.tb, direct: G.direct.t } : { a: G.da, b: G.db, direct: G.direct.d };
  }
  // Per-node metric and band classifier for the current mode/measure.
  function model(G) {
    const { a, b, direct } = series(G);
    const n = G.nx * G.ny;
    let minTot = direct, minMax = Infinity, best = -1;
    for (let i = 0; i < n; i++) {
      if (G.ok[i] !== 1) continue;
      const m = Math.max(a[i], b[i]), t = a[i] + b[i];
      if (t < minTot) minTot = t;
      if (m < minMax || (m === minMax && best >= 0 && t < a[best] + b[best])) { minMax = m; best = i; }
    }
    const step = niceStep(direct / unitScale());
    let metric, band, keys;
    if (S.mode === 'split') {
      metric = i => a[i] - b[i];
      band = v => { const x = Math.abs(v); const lvl = x <= step ? -1 : x <= 2 * step ? 0 : x <= 4 * step ? 1 : 2; return lvl < 0 ? EQUAL : (v > 0 ? SIDE_A : SIDE_B)[lvl]; };
      const nA = S.a.name, nB = S.b.name, f = fmtVal;
      keys = [[SIDE_A[2], `${nA} ${f(4 * step)}+ more`], [SIDE_A[0], `${nA} more`], [EQUAL, `About equal (±${f(step)})`], [SIDE_B[0], `${nB} more`], [SIDE_B[2], `${nB} ${f(4 * step)}+ more`]];
    } else {
      const base = S.mode === 'total' ? minTot : minMax;
      metric = S.mode === 'total' ? (i => a[i] + b[i] - base) : (i => Math.max(a[i], b[i]) - base);
      band = v => { for (let k = 0; k < STEPS.length; k++) if (v <= STEPS[k] * step) return SEQ[k]; return SEQ[SEQ.length - 1]; };
      const what = S.mode === 'total' ? 'total' : 'longest';
      keys = STEPS.map((m, k) => [SEQ[k], (k === 0 ? `≤ ${fmtVal(base + m * step)} ${what}` : `≤ ${fmtVal(base + m * step)}`)]);
      keys.push([null, 'more: unshaded']);
    }
    return { a, b, direct, metric, band, keys, best, minTot, minMax, step };
  }

  function clearShading() {
    for (const k of ['overlay', 'line', 'lineCase', 'star']) if (layers[k]) { map.removeLayer(layers[k]); layers[k] = null; }
    $('legend').innerHTML = '';
    $('summary').classList.add('hidden');
  }

  function renderAll() {
    const G = S.grid;
    if (!G || !G.direct) return;
    const M = model(G);
    renderOverlay(G, M);
    renderLine(G, M);
    renderStar(G, M);
    renderLegend(M);
    renderSummary(G, M);
    renderHelp();
  }

  function renderOverlay(G, M) {
    const n = G.nx * G.ny, v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = G.ok[i] === 1 ? M.metric(i) : NaN;
    const spanX = (G.lonMax - G.lonMin) * RAD, spanY = G.yMax - G.yMin;
    const W = spanX >= spanY ? 800 : Math.max(16, Math.round(800 * spanX / spanY));
    const H = spanX >= spanY ? Math.max(16, Math.round(800 * spanY / spanX)) : 800;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(W, H), d = img.data;
    const nx = G.nx, ny = G.ny;
    for (let py = 0; py < H; py++) {
      const gy = (py + .5) / H * (ny - 1), j0 = Math.min(ny - 2, Math.floor(gy)), fy = gy - j0;
      for (let px = 0; px < W; px++) {
        const gx = (px + .5) / W * (nx - 1), i0 = Math.min(nx - 2, Math.floor(gx)), fx = gx - i0;
        const k00 = j0 * nx + i0, k10 = k00 + 1, k01 = k00 + nx, k11 = k01 + 1;
        const near = fx < .5 ? (fy < .5 ? k00 : k01) : (fy < .5 ? k10 : k11);
        if (isNaN(v[near])) continue;
        let s = 0, w = 0, ww;
        if (!isNaN(v[k00])) { ww = (1 - fx) * (1 - fy); s += ww * v[k00]; w += ww; }
        if (!isNaN(v[k10])) { ww = fx * (1 - fy); s += ww * v[k10]; w += ww; }
        if (!isNaN(v[k01])) { ww = (1 - fx) * fy; s += ww * v[k01]; w += ww; }
        if (!isNaN(v[k11])) { ww = fx * fy; s += ww * v[k11]; w += ww; }
        const c = M.band(s / w), o = (py * W + px) * 4;
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = Math.round(c[3] * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    const url = cv.toDataURL('image/png');
    const bounds = L.latLngBounds([G.latMin, G.lonMin], [G.latMax, G.lonMax]);
    if (layers.overlay) { layers.overlay.setUrl(url); layers.overlay.setBounds(bounds); }
    else layers.overlay = L.imageOverlay(url, bounds, { pane: 'shade', interactive: false }).addTo(map);
  }

  // Marching squares on (a - b) = 0: the line where both drives are equal. Chained into polylines.
  function renderLine(G, M) {
    const { a, b } = M, nx = G.nx, ny = G.ny;
    const val = k => G.ok[k] === 1 ? a[k] - b[k] : NaN;
    const pts = {}, adj = {};
    const edge = (id, k1, k2, i1, j1, i2, j2) => {
      if (!pts[id]) { const v1 = val(k1), v2 = val(k2), t = v1 / (v1 - v2); pts[id] = gridToLatLng(G, i1 + t * (i2 - i1), j1 + t * (j2 - j1)); }
      return id;
    };
    const link = (p, q) => { (adj[p] = adj[p] || []).push(q); (adj[q] = adj[q] || []).push(p); };
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const k00 = j * nx + i, k10 = k00 + 1, k01 = k00 + nx, k11 = k01 + 1;
      const v00 = val(k00), v10 = val(k10), v01 = val(k01), v11 = val(k11);
      if (isNaN(v00) || isNaN(v10) || isNaN(v01) || isNaN(v11)) continue;
      const c = [];
      if ((v00 < 0) !== (v10 < 0)) c.push(edge(`h${i},${j}`, k00, k10, i, j, i + 1, j));
      if ((v10 < 0) !== (v11 < 0)) c.push(edge(`v${i + 1},${j}`, k10, k11, i + 1, j, i + 1, j + 1));
      if ((v01 < 0) !== (v11 < 0)) c.push(edge(`h${i},${j + 1}`, k01, k11, i, j + 1, i + 1, j + 1));
      if ((v00 < 0) !== (v01 < 0)) c.push(edge(`v${i},${j}`, k00, k01, i, j, i, j + 1));
      if (c.length === 2) link(c[0], c[1]);
      else if (c.length === 4) { link(c[0], c[1]); link(c[2], c[3]); }
    }
    // Chain segments: start from loose ends, then any loops left over.
    const used = new Set(), lines = [];
    const walk = start => {
      const line = [pts[start]]; let prev = null, cur = start;
      for (;;) {
        const nxt = (adj[cur] || []).find(q => q !== prev && !used.has(cur + '|' + q));
        if (!nxt) break;
        used.add(cur + '|' + nxt); used.add(nxt + '|' + cur);
        line.push(pts[nxt]); prev = cur; cur = nxt;
        if (cur === start) break;
      }
      if (line.length > 1) lines.push(line);
    };
    const ids = Object.keys(adj);
    ids.filter(id => adj[id].length === 1).forEach(walk);
    ids.forEach(id => { if (adj[id].some(q => !used.has(id + '|' + q))) walk(id); });
    if (layers.line) map.removeLayer(layers.line);
    if (layers.lineCase) map.removeLayer(layers.lineCase);
    layers.line = layers.lineCase = null;
    if (!lines.length) return;
    layers.lineCase = L.polyline(lines, { color: DARK ? '#000' : '#fff', weight: 5, opacity: .7, interactive: false }).addTo(map);
    layers.line = L.polyline(lines, { color: DARK ? '#fff' : '#111', weight: 2.5, dashArray: '7 6', opacity: .9, interactive: false }).addTo(map);
  }

  function renderStar(G, M) {
    if (layers.star) map.removeLayer(layers.star);
    layers.star = null;
    if (M.best < 0) return;
    const k = M.best;
    layers.star = L.marker([G.lat[k], G.lon[k]], { icon: pinIcon('pin-star', '★', 30), title: 'Fairest spot', zIndexOffset: 500 })
      .bindPopup(() => popupHtml('★ Fairest spot', G.ta[k], G.tb[k], G.da[k], G.db[k], [G.lat[k], G.lon[k]]))
      .addTo(map);
  }

  function renderLegend(M) {
    const sw = c => `<span class="sw" style="background:${rgba(c)}"></span>`;
    let html = M.keys.map(([c, t]) => c ? `<span class="key">${sw(c)}${esc(t)}</span>` : `<span class="key">${esc(t)}</span>`).join('');
    html += `<span class="key"><span class="line"></span>Equal drive</span><span class="key">★ Fairest spot</span>`;
    $('legend').innerHTML = html;
  }

  function renderSummary(G, M) {
    const A = S.a, B = S.b, d = G.direct, k = M.best;
    let html = `<p><strong>${esc(A.name)} ↔ ${esc(B.name)}:</strong> ${fmtDur(d.t)} · ${fmtDist(d.d)} driving directly.</p>`;
    if (k >= 0) {
      html += `<p>★ Fairest spot: <span class="dot dot-a"></span>${fmtDur(G.ta[k])} · <span class="dot dot-b"></span>${fmtDur(G.tb[k])}` +
        ` <span class="muted">(${fmtDist(G.da[k])} / ${fmtDist(G.db[k])})</span></p>`;
    }
    const far = [];
    if (d.snapA > 2000) far.push(`${A.name} is ${fmtDist(d.snapA)} from the nearest road`);
    if (d.snapB > 2000) far.push(`${B.name} is ${fmtDist(d.snapB)} from the nearest road`);
    if (far.length) html += `<p class="small muted">Note: ${esc(far.join('; '))}.</p>`;
    if (!G.complete) html += '<p class="small muted">Still filling in the map…</p>';
    $('summary').innerHTML = html;
    $('summary').classList.remove('hidden');
  }

  function renderHelp() {
    const A = S.a ? S.a.name : 'A', B = S.b ? S.b.name : 'B';
    const word = S.measure === 'time' ? 'driving time' : 'distance';
    $('mode-help').textContent = {
      total: `Shaded by total ${word} for both of you. The darkest band hugs the direct route; follow the dashed line (equal drives) to where it is darkest.`,
      fair: `Shaded by the longer of the two drives. The darkest patch, around ★, is where neither of you drives far.`,
      split: `Purple is roughly equal. Blue means ${A} drives further, orange means ${B} does.`,
    }[S.mode];
  }

  // ---- Popups / probing ---------------------------------------------------------
  const gmaps = (from, to) => `https://www.google.com/maps/dir/?api=1&origin=${from[0].toFixed(5)},${from[1].toFixed(5)}&destination=${to[0].toFixed(5)},${to[1].toFixed(5)}&travelmode=driving`;
  function popupHtml(title, ta, tb, da, db, ll, extra) {
    const A = S.a, B = S.b, d = S.grid && S.grid.direct;
    const extraT = d ? ta + tb - d.t : NaN;
    return `<p><strong>${title}</strong></p>${extra || ''}` +
      `<p><span class="dot dot-a"></span>${esc(A.name)}: <strong>${fmtDur(ta)}</strong> · ${fmtDist(da)}</p>` +
      `<p><span class="dot dot-b"></span>${esc(B.name)}: <strong>${fmtDur(tb)}</strong> · ${fmtDist(db)}</p>` +
      `<p class="muted">Together ${fmtDur(ta + tb)}${isFinite(extraT) ? `, ${extraT < 90 ? 'no detour' : fmtDur(extraT) + ' more than the direct drive'}` : ''}.</p>` +
      `<p><a href="${gmaps([A.lat, A.lng], ll)}" target="_blank" rel="noopener">Route from ${esc(A.name)}</a> · ` +
      `<a href="${gmaps([B.lat, B.lng], ll)}" target="_blank" rel="noopener">from ${esc(B.name)}</a></p>`;
  }
  map.on('click', async e => {
    if (!S.a || !S.b) return;
    const ll = [e.latlng.lat, e.latlng.lng];
    const pop = L.popup().setLatLng(e.latlng).setContent('Working out drive times…').openOn(map);
    try {
      const j = await table([[S.a.lat, S.a.lng], [S.b.lat, S.b.lng], ll]);
      const ta = j.durations[0][2], tb = j.durations[1][2];
      if (ta == null || tb == null) { pop.setContent('No road route to here.'); return; }
      const snap = j.destinations[2].distance;
      const note = snap > 1000 ? `<p class="small muted">Nearest road is ${fmtDist(snap)} away.</p>` : '';
      pop.setContent(popupHtml('This spot', ta, tb, j.distances[0][2], j.distances[1][2], ll, note));
    } catch (_) { pop.setContent("Couldn't reach the routing server."); }
  });

  // ---- Nice places (Wikivoyage) ---------------------------------------------------
  const CATS = ['City articles', 'Park articles', 'Rural area articles', 'Region articles', 'District articles', 'Country articles',
    'Itinerary articles', 'Airport articles', 'Outline articles', 'Usable articles', 'Guide articles', 'Star articles'];
  const STATUS = { 'Outline articles': 0, 'Usable articles': 1, 'Guide articles': 2, 'Star articles': 3 };
  const STATUS_LABEL = ['Brief guide', 'Guide', 'Good guide', 'Star guide'];
  const BONUS = [0, 300, 600, 900]; // seconds of head start by guide quality

  function clearPlaces(msg) {
    S.places = [];
    layers.places.clearLayers();
    $('places').innerHTML = '';
    $('places-status').textContent = msg || '';
  }

  async function wvAround(lat, lng) {
    const p = new URLSearchParams({
      action: 'query', format: 'json', formatversion: '2', origin: '*',
      generator: 'geosearch', ggscoord: `${lat.toFixed(4)}|${lng.toFixed(4)}`, ggsradius: '10000', ggslimit: '50', ggsnamespace: '0',
      prop: 'coordinates|info|categories|description', colimit: 'max', cllimit: 'max',
      clcategories: CATS.map(c => 'Category:' + c).join('|'),
    });
    let j;
    try { j = await getJSON(WV_API + '?' + p, 20000); }
    catch (e) { if (e.status !== 429) throw e; await sleep(2500); j = await getJSON(WV_API + '?' + p, 20000); }
    return (j.query && j.query.pages) || [];
  }

  async function pool(items, size, fn) {
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  }

  async function findPlaces(run) {
    const G = S.grid;
    if (!G || !G.direct) return;
    // Places for this pair found within the last week are reused, so a repeat visit makes no Wikivoyage calls.
    const cached = store.get('places:' + cacheKey(S.a, S.b));
    if (cached && Array.isArray(cached.list) && cached.list.length && Date.now() - cached.at < 7 * 864e5) {
      S.places = cached.list; renderPlaces(); return;
    }
    const n = G.nx * G.ny;
    // The "fair zone": where the longer drive is within a slack of the best possible.
    let best = Infinity;
    for (let i = 0; i < n; i++) if (G.ok[i] === 1) best = Math.min(best, Math.max(G.ta[i], G.tb[i]));
    if (!isFinite(best)) { clearPlaces('No routable points on the map.'); return; }
    const slack = clamp(0.25 * best, 1200, 3600);
    const zone = [];
    for (let i = 0; i < n; i++) if (G.ok[i] === 1 && Math.max(G.ta[i], G.tb[i]) <= best + slack) zone.push(i);
    zone.sort((p, q) => Math.max(G.ta[p], G.tb[p]) - Math.max(G.ta[q], G.tb[q]));
    const samples = [];
    for (const k of zone) {
      if (samples.every(s => haversine(G.lat[k], G.lon[k], G.lat[s], G.lon[s]) >= 15)) samples.push(k);
      if (samples.length >= 16) break;
    }
    $('places-status').textContent = 'Looking for nice places in the fairest area…';

    const pages = new Map();
    let failures = 0;
    await pool(samples, 2, async k => {
      try { for (const p of await wvAround(G.lat[k], G.lon[k])) if (!pages.has(p.pageid)) pages.set(p.pageid, p); }
      catch (_) { failures++; }
    });
    if (run !== S.run) return;
    if (!pages.size && failures) { clearPlaces("Couldn't reach Wikivoyage for place suggestions. Tap the map to check any spot."); return; }

    let cands = [];
    // Article type categories; if Wikivoyage ever stops returning them, keep everything rather than nothing.
    const TYPES = CATS.slice(0, 8).map(c => 'Category:' + c);
    const anyTyped = [...pages.values()].some(p => (p.categories || []).some(c => TYPES.includes(c.title)));
    for (const p of pages.values()) {
      const co = p.coordinates && p.coordinates[0];
      if (!co || p.title.includes('/')) continue;
      const cats = (p.categories || []).map(c => c.title.replace(/^Category:/, ''));
      const keep = cats.some(c => c === 'City articles' || c === 'Park articles' || c === 'Rural area articles');
      if (anyTyped && !keep) continue;
      const fair = sampleGrid(G, co.lat, co.lon, i => Math.max(G.ta[i], G.tb[i]));
      if (!(fair <= best + slack * 1.25)) continue;
      const status = Math.max(0, ...cats.map(c => STATUS[c] || 0));
      cands.push({ title: p.title, desc: p.description || '', lat: co.lat, lng: co.lon, status, len: p.length || 0 });
    }
    if (!cands.length) { clearPlaces('No towns with a travel guide in the fairest area. Tap the map to check any spot.'); return; }
    cands.sort((p, q) => q.status - p.status || q.len - p.len);
    cands = cands.slice(0, 30);

    $('places-status').textContent = `Checking drive times to ${cands.length} places…`;
    let j;
    try { j = await table([[S.a.lat, S.a.lng], [S.b.lat, S.b.lng]].concat(cands.map(c => [c.lat, c.lng]))); }
    catch (_) { if (run === S.run) clearPlaces("Couldn't get exact drive times for places. Try again shortly."); return; }
    if (run !== S.run) return;
    cands.forEach((c, i) => {
      c.ta = j.durations[0][i + 2]; c.tb = j.durations[1][i + 2];
      c.da = j.distances[0][i + 2]; c.db = j.distances[1][i + 2];
    });
    cands = cands.filter(c => c.ta != null && c.tb != null && Math.max(c.ta, c.tb) <= best + slack * 1.25);
    cands.forEach(c => { c.score = Math.max(c.ta, c.tb) - BONUS[c.status]; });
    cands.sort((p, q) => p.score - q.score || (p.ta + p.tb) - (q.ta + q.tb));
    S.places = cands.slice(0, 10);
    store.set('places:' + cacheKey(S.a, S.b), { at: Date.now(), list: S.places });
    renderPlaces();
  }

  function renderPlaces() {
    layers.places.clearLayers();
    const list = $('places');
    if (!S.places.length) { list.innerHTML = ''; $('places-status').textContent = 'No towns with a travel guide in the fairest area. Tap the map to check any spot.'; return; }
    $('places-status').textContent = `Towns and parks with a travel guide near the fairest spot, best first. ${S.a.name} is A, ${S.b.name} is B.`;
    list.innerHTML = S.places.map((p, i) => {
      const url = WV_PAGE + encodeURIComponent(p.title.replace(/ /g, '_'));
      const name = p.title.replace(/ \(.*\)$/, '');
      return `<li class="place">
        <span class="place-num">${i + 1}</span>
        <div class="place-name">${esc(name)} <span class="tag">${STATUS_LABEL[p.status]}</span></div>
        <div class="place-desc">${esc(p.desc)}</div>
        <div class="place-times"><span><span class="dot dot-a"></span>${fmtDur(p.ta)} · ${fmtDist(p.da)}</span><span><span class="dot dot-b"></span>${fmtDur(p.tb)} · ${fmtDist(p.db)}</span></div>
        <div class="place-actions"><button type="button" class="btn-secondary" data-show="${i}">Show on map</button><a class="btn btn-secondary" href="${url}" target="_blank" rel="noopener">Travel guide</a></div>
      </li>`;
    }).join('');
    S.places.forEach((p, i) => {
      const url = WV_PAGE + encodeURIComponent(p.title.replace(/ /g, '_'));
      p.marker = L.marker([p.lat, p.lng], { icon: pinIcon('pin-place', String(i + 1), 24), title: p.title, zIndexOffset: 400 - i })
        .bindPopup(() => popupHtml(`${i + 1}. ${esc(p.title.replace(/ \(.*\)$/, ''))}`, p.ta, p.tb, p.da, p.db, [p.lat, p.lng],
          `<p class="small muted">${esc(p.desc)} · <a href="${url}" target="_blank" rel="noopener">guide</a></p>`))
        .addTo(layers.places);
    });
  }
  $('places').addEventListener('click', e => {
    const btn = e.target.closest('[data-show]');
    if (!btn) return;
    const p = S.places[+btn.dataset.show];
    if (!p) return;
    $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
    map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), 9), { duration: 0.8 });
    setTimeout(() => p.marker.openPopup(), 850);
  });

  // ---- Endpoints --------------------------------------------------------------------
  function drawEndpoints() {
    for (const k of ['a', 'b']) {
      if (layers[k]) map.removeLayer(layers[k]);
      const p = S[k];
      layers[k] = p ? L.marker([p.lat, p.lng], { icon: pinIcon('pin-' + k, k.toUpperCase(), 30), title: p.name, zIndexOffset: 1000 })
        .bindPopup(`<strong>${k.toUpperCase()}: ${esc(p.name)}</strong>`).addTo(map) : null;
    }
  }

  // ---- Status / errors -----------------------------------------------------------------
  function setStatus(text, frac) {
    const el = $('status');
    if (!text) { el.classList.add('hidden'); return; }
    $('status-text').textContent = text;
    $('bar').style.width = Math.round(clamp(frac || 0, 0, 1) * 100) + '%';
    el.classList.remove('hidden');
  }
  function showError(html, retry) {
    const el = $('error');
    el.innerHTML = html + (retry ? ' <button type="button" class="btn-secondary" id="retry">Try again</button>' : '');
    el.classList.remove('hidden');
    if (retry) $('retry').addEventListener('click', compute);
  }
  function hideError() { $('error').classList.add('hidden'); }

  // ---- Place pickers ----------------------------------------------------------------------
  function Picker(prefix, onPick) {
    const input = $(prefix + '-input'), list = $(prefix + '-list'), loc = $(prefix + '-locate');
    let items = [], active = -1, current = null, seq = 0;
    function show(arr) {
      items = arr;
      active = arr.findIndex(it => it.place || it.search);
      list.innerHTML = arr.map((it, i) => `<li role="option" id="${prefix}-opt-${i}" data-i="${i}" class="${it.note ? 'note' : ''}${i === active ? ' active' : ''}" aria-selected="${i === active}">` +
        `<span>${esc(it.label)}</span>${it.sub ? `<span class="small muted">${esc(it.sub)}</span>` : ''}</li>`).join('');
      list.classList.toggle('hidden', !arr.length);
      input.setAttribute('aria-expanded', arr.length ? 'true' : 'false');
      if (active >= 0) input.setAttribute('aria-activedescendant', `${prefix}-opt-${active}`); else input.removeAttribute('aria-activedescendant');
    }
    const hide = () => show([]);
    function suggestions(q) {
      const out = searchCities(q).map(c => ({ label: c.name, sub: [c.region, c.country].filter(Boolean).join(', '), place: { name: c.name, lat: c.lat, lng: c.lng } }));
      if (q.trim().length >= 2) out.push({ label: `Search for “${q.trim()}”`, sub: 'Any town, village or postcode', search: q.trim() });
      return out;
    }
    function move(dir) {
      if (!items.length) return;
      let i = active;
      do { i = (i + dir + items.length) % items.length; } while (items[i].note && i !== active);
      active = i;
      [...list.children].forEach((li, k) => { li.classList.toggle('active', k === i); li.setAttribute('aria-selected', k === i); });
      input.setAttribute('aria-activedescendant', `${prefix}-opt-${i}`);
      list.children[i].scrollIntoView({ block: 'nearest' });
    }
    async function choose(it) {
      if (!it || it.note) return;
      if (it.place) { set(it.place); hide(); input.blur(); return; }
      if (!it.search) return;
      const my = ++seq;
      show([{ label: 'Searching…', note: true }]);
      try {
        // Prefer (not restrict to) places around what the map is showing.
        const bb = map.getBounds().pad(0.5);
        const p = new URLSearchParams({ format: 'jsonv2', limit: '6', q: it.search, 'accept-language': 'en', bounded: '0',
          viewbox: [bb.getWest(), bb.getNorth(), bb.getEast(), bb.getSouth()].map(x => clamp(x, -180, 180).toFixed(3)).join(',') });
        const res = await getJSON(GEOCODE + '?' + p, 15000);
        if (my !== seq) return;
        if (!res.length) { show([{ label: `No places found for “${it.search}”`, note: true }]); return; }
        show(res.map(r => {
          const parts = String(r.display_name || '').split(', ');
          const name = r.name || parts[0] || it.search;
          return { label: name, sub: parts.filter(x => x !== name).slice(0, 3).join(', '), place: { name, lat: +r.lat, lng: +r.lon } };
        }));
      } catch (_) { if (my === seq) show([{ label: "Search isn't available right now. Pick a city from the list.", note: true }]); }
    }
    function set(p, silent) {
      current = p;
      input.value = p.name;
      if (!silent) onPick(p);
    }
    input.addEventListener('input', () => { seq++; show(suggestions(input.value)); });
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Escape') { hide(); if (current) input.value = current.name; }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (active >= 0 && items[active]) choose(items[active]);
        else if (input.value.trim()) choose({ search: input.value.trim() });
      }
    });
    list.addEventListener('mousedown', e => e.preventDefault()); // keep focus in the input while tapping
    list.addEventListener('click', e => { const li = e.target.closest('li[data-i]'); if (li) choose(items[+li.dataset.i]); });
    input.addEventListener('blur', () => setTimeout(() => {
      if (document.activeElement === input) return;
      hide(); if (current) input.value = current.name;
    }, 200));
    loc.addEventListener('click', () => {
      if (!navigator.geolocation) { showError('Location is not available in this browser.'); return; }
      loc.disabled = true;
      navigator.geolocation.getCurrentPosition(pos => {
        loc.disabled = false;
        const lat = pos.coords.latitude, lng = pos.coords.longitude, near = nearestCityName(lat, lng);
        set({ name: near ? `My location (near ${near})` : 'My location', lat, lng });
      }, err => {
        loc.disabled = false;
        showError(err.code === 1 ? 'Location permission was refused. Type a place instead.' : "Couldn't get your location. Type a place instead.");
      }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
    });
    return { set, get: () => current };
  }

  // ---- URL + saved state -------------------------------------------------------------------
  const toParam = p => `${p.name}@${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
  function fromParam(s) {
    if (!s) return null;
    const m = /^(.*)@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(s);
    if (m) {
      const lat = +m[2], lng = +m[3];
      if (Math.abs(lat) <= 85 && Math.abs(lng) <= 180) return { name: m[1].trim() || 'Pinned place', lat, lng };
      return null;
    }
    const c = searchCities(s)[0];
    return c ? { name: c.name, lat: c.lat, lng: c.lng } : null;
  }
  function persist() {
    if (!S.a || !S.b) return;
    store.set('pair', { a: S.a, b: S.b });
    const u = new URL(location.href);
    u.searchParams.set('a', toParam(S.a));
    u.searchParams.set('b', toParam(S.b));
    if (S.mode !== 'total') u.searchParams.set('mode', S.mode); else u.searchParams.delete('mode');
    if (S.measure !== 'time') u.searchParams.set('by', S.measure); else u.searchParams.delete('by');
    try { history.replaceState(null, '', u); } catch (_) { /* ignore */ }
  }

  let debounce = 0;
  const onPick = which => p => {
    S[which] = p;
    persist();
    clearTimeout(debounce);
    debounce = setTimeout(compute, 150);
  };
  const pickA = Picker('a', onPick('a')), pickB = Picker('b', onPick('b'));

  document.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', () => {
    S.mode = r.value; persist(); renderAll(); if (!S.grid || !S.grid.direct) renderHelp();
  }));
  document.querySelectorAll('input[name="measure"]').forEach(r => r.addEventListener('change', () => {
    S.measure = r.value; persist(); renderAll(); if (!S.grid || !S.grid.direct) renderHelp();
  }));

  // ---- Start ---------------------------------------------------------------------------------
  (function init() {
    const q = new URLSearchParams(location.search);
    const saved = store.get('pair');
    const valid = p => p && typeof p.name === 'string' && isFinite(p.lat) && isFinite(p.lng);
    S.a = fromParam(q.get('a')) || (saved && valid(saved.a) ? saved.a : null) || { name: 'Liverpool', lat: 53.4084, lng: -2.9916 };
    S.b = fromParam(q.get('b')) || (saved && valid(saved.b) ? saved.b : null) || { name: 'Edinburgh', lat: 55.9533, lng: -3.1883 };
    if (['total', 'fair', 'split'].includes(q.get('mode'))) S.mode = q.get('mode');
    if (q.get('by') === 'dist') S.measure = 'dist';
    document.querySelector(`input[name="mode"][value="${S.mode}"]`).checked = true;
    document.querySelector(`input[name="measure"][value="${S.measure}"]`).checked = true;
    pickA.set(S.a, true);
    pickB.set(S.b, true);
    renderHelp();
    compute();
  })();
})();
