// Correctness: Dijkstra, A* and CH must agree on known shortest paths.
import { dijkstra, astar, unwind } from '../src/engine/search.js';
import { preprocessCH, chQuery } from '../src/engine/ch.js';

// Build a small weighted graph with a forced detour and a one-way street.
// 0 -1- 1 -1- 2
// |     |     |
// 10    1     1
// |     |     |
// 3 -1- 4 -5- 5   and a one-way 2 -> 5 (weight 1, no reverse)
const N = 6;
const undirected = [
  [0, 1, 1], [1, 2, 1], [0, 3, 10], [1, 4, 1], [2, 5, 1], [3, 4, 1], [4, 5, 5],
];
const directed = [[2, 5, 1]];
const edges = [];
for (const [u, v, w] of undirected) { edges.push([u, v, w]); edges.push([v, u, w]); }
for (const [u, v, w] of directed) edges.push([u, v, w]);

const firstEdge = new Uint32Array(N + 1);
for (const [u] of edges) firstEdge[u + 1]++;
for (let i = 1; i <= N; i++) firstEdge[i] += firstEdge[i - 1];
const edgeTo = new Uint32Array(edges.length);
const edgeTime = new Float32Array(edges.length);
const edgeDist = new Float32Array(edges.length);
{
  const cur = firstEdge.slice(0, N);
  edges.forEach(([u, v, w], i) => { const s = cur[u]++; edgeTo[s] = v; edgeTime[s] = w; edgeDist[s] = w * 100; });
}
const g = {
  nNodes: N, nEdges: edges.length, firstEdge, edgeTo, edgeTime, edgeDist,
  nodeLat: (i) => [0, 0, 0, 1, 1, 1][i] * 1e-6,
  nodeLon: (i) => [0, 1, 2, 0, 1, 2][i] * 1e-6,
  maxSpeedMps: 100 / 3.6,
};

// known answers: 0->5 optimal is 0-1-2-5 = 3; 5->0 optimal is 5-2-1-0 = 3
// (one-way 2->5 does not help going back, and 5->2 has no edge)
const ch = preprocessCH(g);
// minimal loadCH-equivalent structures
const rank = ch.rank;
const m = ch.chFrom.length;
const upFirst = new Uint32Array(N + 1), downFirst = new Uint32Array(N + 1);
const isUpT = new Uint8Array(m);
for (let e = 0; e < m; e++) {
  if (rank[ch.chTo[e]] > rank[ch.chFrom[e]]) { isUpT[e] = 1; upFirst[ch.chFrom[e] + 1]++; }
  else downFirst[ch.chTo[e] + 1]++;
}
for (let i = 1; i <= N; i++) { upFirst[i] += upFirst[i - 1]; downFirst[i] += downFirst[i - 1]; }
const upEdge = new Uint32Array(upFirst[N]), downEdge = new Uint32Array(downFirst[N]);
{
  const cu = upFirst.slice(0, N), cd = downFirst.slice(0, N);
  for (let e = 0; e < m; e++) {
    if (isUpT[e]) upEdge[cu[ch.chFrom[e]]++] = e;
    else downEdge[cd[ch.chTo[e]]++] = e;
  }
}
const chq = { ...ch, upFirst, upEdge, downFirst, downEdge };

let failures = 0;
for (const [a, b, expected] of [[0, 5, 3], [5, 0, 3], [0, 2, 2], [3, 2, 3], [4, 0, 2]]) {
  const d = dijkstra(g, a, b);
  const as = astar(g, a, b);
  const c = chQuery(g, chq, a, b);
  const ok = Math.abs(d.time - expected) < 1e-6 && Math.abs(as.time - expected) < 1e-6 && Math.abs(c.time - expected) < 1e-6;
  // unpacked CH path must sum to the same time and form a real chain
  let chainTime = 0, chainOk = true;
  if (c.found) {
    let node = a;
    for (const e of c.edgeIds) {
      chainTime += edgeTime[e];
      if (edgeTo[e] === undefined) chainOk = false;
      // verify contiguity: edge must leave the current node
      let found = false;
      for (let s = firstEdge[node]; s < firstEdge[node + 1]; s++) if (s === e) { found = true; break; }
      if (!found) { chainOk = false; break; }
      node = edgeTo[e];
    }
    if (node !== b) chainOk = false;
  }
  const pass = ok && c.found && chainOk && Math.abs(chainTime - expected) < 1e-4;
  console.log(`${a}->${b}: dij=${d.time} astar=${as.time} ch=${c.time.toFixed(4)} chain=${chainOk} ${pass ? 'PASS' : 'FAIL'}`);
  if (!pass) failures++;
}
console.log(failures === 0 ? 'ALL ENGINE TESTS PASSED' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
