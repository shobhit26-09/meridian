// Benchmark Dijkstra vs A* vs CH on random long-range pairs.
// Verifies all three return the same optimal time (correctness), then reports
// speed and search space -> the README table.
import { loadGraph, loadCH } from '../src/engine/graph.js';
import { dijkstra, astar } from '../src/engine/search.js';
import { chQuery } from '../src/engine/ch.js';
import fs from 'node:fs';

const PAIRS = Number(process.env.PAIRS || 30);
const g = loadGraph('data/graph.bin');
const ch = loadCH('data/ch.bin');
console.log(`loaded: ${g.nNodes} nodes, ${g.nEdges} base edges`);

let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// pick pairs at least MIN_KM apart (straight line) so queries are long-range
const MIN_KM = Number(process.env.MIN_KM || 40);
const pairs = [];
let guard = 0;
while (pairs.length < PAIRS && guard++ < PAIRS * 200) {
  const a = (rand() * g.nNodes) | 0, b = (rand() * g.nNodes) | 0;
  if (a === b) continue;
  const d = Math.hypot(g.nodeLat(a) - g.nodeLat(b), g.nodeLon(a) - g.nodeLon(b)) * 111;
  if (d < MIN_KM) continue;
  pairs.push([a, b]);
}

const rows = [];
let ok = 0;
for (const [a, b] of pairs) {
  const t0 = performance.now();
  const d = dijkstra(g, a, b);
  const t1 = performance.now();
  const as = astar(g, a, b);
  const t2 = performance.now();
  const c = chQuery(g, ch, a, b);
  const t3 = performance.now();
  if (!d.found) continue;
  const same = Math.abs(d.time - as.time) < 1e-4 && Math.abs(d.time - c.time) < 1e-3;
  if (!same) {
    console.log(`MISMATCH ${a}->${b}: dij=${d.time.toFixed(3)} astar=${as.time.toFixed(3)} ch=${c.time.toFixed(3)}`);
    continue;
  }
  ok++;
  rows.push({
    dijkstraMs: t1 - t0, astarMs: t2 - t1, chMs: t3 - t2,
    dijkstraSettled: d.settled, astarSettled: as.settled, chSettled: c.settled,
    hours: d.time / 3600,
  });
}

const avg = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
const p95 = (k) => rows.map((r) => r[k]).sort((x, y) => x - y)[Math.floor(rows.length * 0.95)];
const summary = {
  pairs: ok,
  graphNodes: g.nNodes,
  baseEdges: g.nEdges,
  dijkstra: { avgMs: avg('dijkstraMs'), p95Ms: p95('dijkstraMs'), avgSettled: Math.round(avg('dijkstraSettled')) },
  astar: { avgMs: avg('astarMs'), p95Ms: p95('astarMs'), avgSettled: Math.round(avg('astarSettled')) },
  ch: { avgMs: avg('chMs'), p95Ms: p95('chMs'), avgSettled: Math.round(avg('chSettled')) },
};
summary.speedupDijkstra = summary.dijkstra.avgMs / summary.ch.avgMs;
summary.speedupAstar = summary.astar.avgMs / summary.ch.avgMs;
summary.settledReduction = summary.dijkstra.avgSettled / summary.ch.avgSettled;
fs.writeFileSync('data/benchmark.json', JSON.stringify(summary, null, 2));

console.log(`\ncorrect results: ${ok}/${rows.length}`);
console.log('| algorithm | avg time | p95 time | nodes settled (avg) |');
console.log('|---|---|---|---|');
console.log(`| Dijkstra | ${summary.dijkstra.avgMs.toFixed(1)} ms | ${summary.dijkstra.p95Ms.toFixed(1)} ms | ${summary.dijkstra.avgSettled.toLocaleString()} |`);
console.log(`| A* | ${summary.astar.avgMs.toFixed(1)} ms | ${summary.astar.p95Ms.toFixed(1)} ms | ${summary.astar.avgSettled.toLocaleString()} |`);
console.log(`| Contraction hierarchies | ${summary.ch.avgMs.toFixed(2)} ms | ${summary.ch.p95Ms.toFixed(2)} ms | ${summary.ch.avgSettled.toLocaleString()} |`);
console.log(`\nCH speedup vs Dijkstra: ${summary.speedupDijkstra.toFixed(0)}x, vs A*: ${summary.speedupAstar.toFixed(0)}x; settled reduction ${summary.settledReduction.toFixed(0)}x`);
