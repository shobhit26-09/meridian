/* Meridian frontend: MapLibre map, draggable waypoints, live engine comparison. */
/* global maplibregl */

const BOUNDS = [[75.55, 30.30], [79.05, 33.30]]; // graph coverage (Himachal)
const state = { from: null, to: null, algo: 'ch', route: null, compare: null, setting: 'from' };

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  center: [77.25, 31.8],
  zoom: 7.4,
  maxBounds: [[73.5, 28.5], [81, 35]],
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

const $ = (id) => document.getElementById(id);
const fmtCoord = (p) => `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;

function makePin(kind) {
  const el = document.createElement('div');
  el.className = `pin ${kind}`;
  const marker = new maplibregl.Marker({ element: el, draggable: true, anchor: 'bottom' });
  marker.on('dragend', () => {
    const p = marker.getLngLat();
    state[kind] = p;
    $(kind === 'from' ? 'fromInput' : 'toInput').value = fmtCoord(p);
    route();
  });
  return marker;
}
const fromMarker = makePin('from');
const toMarker = makePin('to');

map.on('click', (e) => {
  if (!state.from || state.setting === 'from') {
    state.from = e.lngLat;
    fromMarker.setLngLat(e.lngLat).addTo(map);
    $('fromInput').value = fmtCoord(e.lngLat);
    state.setting = 'to';
    $('hint').classList.add('gone');
    if (state.to) route();
    return;
  }
  state.to = e.lngLat;
  toMarker.setLngLat(e.lngLat).addTo(map);
  $('toInput').value = fmtCoord(e.lngLat);
  state.setting = 'from';
  route();
});

$('swapBtn').addEventListener('click', () => {
  if (!state.from && !state.to) return;
  [state.from, state.to] = [state.to, state.from];
  if (state.from) { fromMarker.setLngLat(state.from).addTo(map); $('fromInput').value = fmtCoord(state.from); }
  else { fromMarker.remove(); $('fromInput').value = ''; }
  if (state.to) { toMarker.setLngLat(state.to).addTo(map); $('toInput').value = fmtCoord(state.to); }
  else { toMarker.remove(); $('toInput').value = ''; }
  route();
});

document.querySelectorAll('.algo').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.algo').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.algo = btn.dataset.algo;
    renderFromCache();
  });
});

let routeSeq = 0;
async function route() {
  if (!state.from || !state.to) return;
  const seq = ++routeSeq;
  const q = `from=${state.from.lat},${state.from.lng}&to=${state.to.lat},${state.to.lng}&compare=1&algo=${state.algo}`;
  let data;
  try {
    const res = await fetch(`/api/route?${q}`);
    data = await res.json();
    if (!res.ok) throw new Error(data.error || 'routing failed');
  } catch (err) {
    if (seq !== routeSeq) return;
    toast(err.message === 'no route between those points'
      ? 'No road route between those points.'
      : 'No road found near that point - try clicking closer to a road.');
    return;
  }
  if (seq !== routeSeq) return;
  state.route = data;
  drawRoute(data.geometry);
  renderFromCache();
}

function renderFromCache() {
  const data = state.route;
  if (!data) return;
  const stats = data.stats || {};
  const sel = stats[state.algo] || stats.ch;
  const secs = sel ? sel.timeSeconds : data.timeSeconds;

  $('summaryTime').textContent = fmtDuration(secs);
  $('summarySub').textContent = `${fmtDistance(data.distanceMeters)} via ${mainRoad(data.steps)}`;
  const names = { ch: 'Contraction hierarchies', astar: 'A*', dijkstra: 'Dijkstra' };
  const algoName = names[state.algo];
  if (sel) {
    let line = `<strong>${algoName}</strong> answered in <strong>${sel.ms.toFixed(sel.ms < 10 ? 2 : 1)} ms</strong> after settling <strong>${sel.settled.toLocaleString()}</strong> nodes.`;
    if (state.algo !== 'dijkstra' && stats.dijkstra) {
      const x = stats.dijkstra.ms / sel.ms;
      line += ` That is <strong>${x >= 100 ? Math.round(x) : x.toFixed(1)}x</strong> faster than Dijkstra on this route, same optimal answer.`;
    }
    $('engineLine').innerHTML = line;
  }
  $('summaryCard').classList.remove('hidden');
  renderSteps(data.steps);
  renderEngineCard(stats);
}

function drawRoute(geometry) {
  const line = geometry.map(([lat, lon]) => [lon, lat]);
  const geojson = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } };
  const src = map.getSource('route');
  if (src) src.setData(geojson);
  else {
    map.addSource('route', { type: 'geojson', data: geojson });
    map.addLayer({
      id: 'route-casing', type: 'line', source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.9 },
    });
    map.addLayer({
      id: 'route-line', type: 'line', source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#007aff', 'line-width': 5 },
    });
  }
  const b = line.reduce(
    (bb, c) => [[Math.min(bb[0][0], c[0]), Math.min(bb[0][1], c[1])], [Math.max(bb[1][0], c[0]), Math.max(bb[1][1], c[1])]],
    [[Infinity, Infinity], [-Infinity, -Infinity]],
  );
  const isMobile = window.innerWidth <= 720;
  map.fitBounds(b, {
    padding: isMobile ? { top: 170, bottom: 240, left: 40, right: 40 } : { top: 80, bottom: 80, left: 400, right: 80 },
    duration: 600,
  });
}

function renderSteps(steps) {
  const list = $('stepsList');
  list.innerHTML = '';
  for (const s of steps) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="step-icon">${iconFor(s)}</span>
      <span><span class="step-text">${escapeHtml(s.instruction)}</span>
      ${s.distanceM > 0 ? `<div class="step-dist">${fmtDistance(s.distanceM)}</div>` : ''}</span>`;
    list.appendChild(li);
  }
}

function renderEngineCard(stats) {
  if (!stats || !stats.dijkstra || !stats.astar || !stats.ch) return;
  const rows = [
    ['dijkstra', 'Dijkstra'],
    ['astar', 'A*'],
    ['ch', 'Engine · CH'],
  ];
  $('engineGrid').innerHTML = rows.map(([k, label]) => {
    const s = stats[k];
    const tag = k === state.algo ? '<span class="eg-tag">SHOWING</span>' : '';
    return `<span class="eg-name">${label}${tag}</span>
      <span class="eg-ms">${s.ms.toFixed(s.ms < 10 ? 2 : 1)} ms</span>
      <span class="eg-settled">${s.settled.toLocaleString()} nodes</span>`;
  }).join('');
  const x = stats.dijkstra.ms / stats.ch.ms;
  const xs = stats.dijkstra.settled / Math.max(stats.ch.settled, 1);
  $('engineNote').innerHTML =
    `Identical optimal route. CH settled <strong>${xs >= 100 ? Math.round(xs).toLocaleString() : xs.toFixed(0)}x</strong> fewer nodes and answered <strong>${x >= 100 ? Math.round(x) : x.toFixed(1)}x</strong> faster than Dijkstra.`;
  $('engineCard').classList.remove('hidden');
}

function iconFor(s) {
  const base = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">';
  if (s.kind === 'depart') return `${base}<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>`;
  if (s.kind === 'arrive') return `${base}<path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5" fill="currentColor" stroke="none"/></svg>`;
  const d = s.delta || 0;
  if (Math.abs(d) < 20) return `${base}<path d="M12 20V5"/><path d="M6 11l6-6 6 6"/></svg>`;
  if (Math.abs(d) > 160) return `${base}<path d="M8 14c0-4 8-4 8 0v6"/><path d="M5 8l3 3 3-3" transform="translate(0 3)"/></svg>`;
  if (d > 0) return d < 60
    ? `${base}<path d="M9 20v-6l8-8"/><path d="M12 5h5v5"/></svg>`
    : `${base}<path d="M8 20v-7h8"/><path d="M13 9l4 4-4 4"/></svg>`;
  return d > -60
    ? `${base}<path d="M15 20v-6L7 6"/><path d="M12 5H7v5"/></svg>`
    : `${base}<path d="M16 20v-7H8"/><path d="M11 9l-4 4 4 4"/></svg>`;
}

function fmtDuration(secs) {
  const m = Math.round(secs / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} hr ${m % 60} min`;
}
function fmtDistance(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}
function mainRoad(steps) {
  let best = '', bestD = -1;
  for (const s of steps) {
    if (s.distanceM > bestD && s.name && s.name !== 'Unnamed road') { bestD = s.distanceM; best = s.name; }
  }
  return best || 'local roads';
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

// preload engine meta for future polish (benchmark numbers, region stats)
fetch('/api/meta').then((r) => r.json()).then((m) => { window.__meta = m; }).catch(() => {});
