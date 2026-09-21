// Meridian API: routing over the preprocessed Delhi road graph.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { loadGraph, loadCH } from '../src/engine/graph.js';
import { dijkstra, astar, unwind } from '../src/engine/search.js';
import { chQuery } from '../src/engine/ch.js';
import { buildSteps } from './steps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.MERIDIAN_DATA || path.join(__dirname, '..', 'data');

const g = loadGraph(path.join(DATA, 'graph.bin'));
const ch = fs.existsSync(path.join(DATA, 'ch.bin')) ? loadCH(path.join(DATA, 'ch.bin')) : null;
const meta = JSON.parse(fs.readFileSync(path.join(DATA, 'meta.json'), 'utf8'));
const benchmark = fs.existsSync(path.join(DATA, 'benchmark.json'))
  ? JSON.parse(fs.readFileSync(path.join(DATA, 'benchmark.json'), 'utf8'))
  : null;
console.log(`meridian: ${g.nNodes} nodes, ${g.nEdges} edges, CH ${ch ? 'loaded' : 'MISSING'}`);

const app = express();
app.use(express.json());

app.get('/api/meta', (_req, res) => {
  res.json({ ...meta, chLoaded: Boolean(ch), benchmark });
});

function runQuery(algo, a, b) {
  const t0 = performance.now();
  if (algo === 'ch') {
    const r = chQuery(g, ch, a, b);
    return { ms: performance.now() - t0, time: r.time, settled: r.settled, found: r.found, edgeIds: r.edgeIds };
  }
  const r = algo === 'astar' ? astar(g, a, b) : dijkstra(g, a, b);
  const edgeIds = r.found ? unwind(a, b, r.prevEdge, r.prevNode) : null;
  return { ms: performance.now() - t0, time: r.time, settled: r.settled, found: r.found, edgeIds };
}

// /api/route?from=lat,lon&to=lat,lon&algo=dijkstra|astar|ch[&compare=1]
app.get('/api/route', (req, res) => {
  const parse = (s) => {
    const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(String(s || ''));
    return m ? { lat: +m[1], lon: +m[2] } : null;
  };
  const from = parse(req.query.from), to = parse(req.query.to);
  if (!from || !to) return res.status(400).json({ error: 'from and to must be lat,lon' });
  const algo = ['dijkstra', 'astar', 'ch'].includes(req.query.algo) ? req.query.algo : 'ch';
  if (algo === 'ch' && !ch) return res.status(503).json({ error: 'CH data not loaded' });

  const snapA = g.nearestNode(from.lat, from.lon);
  const snapB = g.nearestNode(to.lat, to.lon);
  if (!snapA || !snapB) return res.status(404).json({ error: 'no road found near those points' });

  const compare = req.query.compare === '1' && ch;
  const stats = {};
  let primary;
  if (compare) {
    stats.dijkstra = runQuery('dijkstra', snapA.node, snapB.node);
    stats.astar = runQuery('astar', snapA.node, snapB.node);
    stats.ch = runQuery('ch', snapA.node, snapB.node);
    primary = stats[algo];
    // every engine must agree on the optimal time
    const t = stats.dijkstra.time;
    stats.agree = Math.abs(stats.astar.time - t) < 1e-3 && Math.abs(stats.ch.time - t) < 1e-3;
  } else {
    primary = runQuery(algo, snapA.node, snapB.node);
    stats[algo] = { ms: primary.ms, settled: primary.settled };
  }
  if (!primary.found || !primary.edgeIds) return res.status(404).json({ error: 'no route between those points' });

  const coords = [];
  let distM = 0;
  for (const e of primary.edgeIds) {
    distM += g.edgeDist[e];
    const start = g.edgeGeoOff[e], len = g.edgeGeoLen[e];
    for (let i = 0; i < len; i++) {
      const c = g.geo[start + i];
      const pt = [g.coordLat[c], g.coordLon[c]];
      const last = coords[coords.length - 1];
      if (!last || last[0] !== pt[0] || last[1] !== pt[1]) coords.push(pt);
    }
  }

  const publicStats = {};
  for (const [k, v] of Object.entries(stats)) {
    if (k === 'agree') continue;
    publicStats[k] = { ms: v.ms, settled: v.settled, timeSeconds: v.time };
  }
  if (stats.agree !== undefined) publicStats.agree = stats.agree;

  res.json({
    algo,
    timeSeconds: primary.time,
    distanceMeters: distM,
    queryMs: primary.ms,
    settled: primary.settled,
    stats: publicStats,
    geometry: coords,
    steps: buildSteps(g, primary.edgeIds, coords),
    snap: {
      from: { lat: g.nodeLat(snapA.node), lon: g.nodeLon(snapA.node), distanceM: snapA.distanceM },
      to: { lat: g.nodeLat(snapB.node), lon: g.nodeLon(snapB.node), distanceM: snapB.distanceM },
    },
  });
});

app.use(express.static(path.join(__dirname, '..', 'web')));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`meridian listening on :${port}`));
