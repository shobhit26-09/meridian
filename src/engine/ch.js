// Contraction hierarchies: preprocess once, then answer shortest-path queries
// by scanning only "upward" edges - microseconds instead of a full Dijkstra.
import { MinHeap } from './heap.js';

// ---------------------------------------------------------------------------
// Preprocessing. Works on mutable adjacency (arrays of edge objects):
//   { to, w (seconds), d (meters), via (-1 base | middle node), baseId, e1, e2 }
// ---------------------------------------------------------------------------
export function preprocessCH(g, { log = () => {} } = {}) {
  const n = g.nNodes;
  const outAdj = new Array(n);
  const inAdj = new Array(n);
  for (let i = 0; i < n; i++) { outAdj[i] = []; inAdj[i] = []; }
  for (let u = 0; u < n; u++) {
    for (let e = g.firstEdge[u]; e < g.firstEdge[u + 1]; e++) {
      const v = g.edgeTo[e];
      if (v === u) continue;
      // parallel edges: keep the fastest
      const existing = outAdj[u].find((x) => x.to === v);
      if (existing) {
        if (g.edgeTime[e] < existing.w) {
          existing.w = g.edgeTime[e];
          existing.d = g.edgeDist[e];
          existing.baseId = e;
        }
        continue;
      }
      const edge = { to: v, w: g.edgeTime[e], d: g.edgeDist[e], via: -1, baseId: e, e1: null, e2: null, deleted: false };
      outAdj[u].push(edge);
      inAdj[v].push(edge);
    }
  }

  const contracted = new Uint8Array(n);
  const contractedNeighbors = new Uint16Array(n);
  const rank = new Uint32Array(n);
  let order = 0;

  // witness search: is there a u->x path <= limit avoiding v (uncontracted only)?
  function witness(u, x, v, limit) {
    const seen = new Map();
    const heap = new MinHeap();
    seen.set(u, 0);
    heap.push(u, 0);
    let hops = 0;
    while (heap.size > 0) {
      const cur = heap.pop();
      const dc = seen.get(cur);
      if (cur === x) return dc <= limit;
      if (dc > limit) continue;
      if (++hops > 2000) return false; // no cheap witness found in time
      for (const e of outAdj[cur]) {
        if (e.deleted) continue;
        const t = e.to;
        if (t === v || contracted[t]) continue;
        const nd = dc + e.w;
        if (nd <= limit && (!seen.has(t) || nd < seen.get(t))) {
          seen.set(t, nd);
          heap.push(t, nd);
        }
      }
    }
    return false;
  }

  // We need edge sources; rebuild inAdj as {edge, from} pairs instead.
  for (let i = 0; i < n; i++) inAdj[i] = [];
  for (let u = 0; u < n; u++) {
    for (const e of outAdj[u]) inAdj[e.to].push({ edge: e, from: u });
  }

  function shortcutsNeeded(v) {
    let count = 0;
    const pairs = [];
    for (const { edge: ein, from: u } of inAdj[v]) {
      if (contracted[u]) continue;
      for (const eout of outAdj[v]) {
        const x = eout.to;
        if (contracted[x] || x === u) continue;
        const cost = ein.w + eout.w;
        // direct edge check first (cheap witness)
        let hasDirect = false;
        for (const e of outAdj[u]) {
          if (!e.deleted && e.to === x && e.w <= cost) { hasDirect = true; break; }
        }
        if (hasDirect) continue;
        if (!witness(u, x, v, cost)) {
          count++;
          pairs.push([u, x, ein, eout, cost]);
        }
      }
    }
    return { count, pairs };
  }

  function importance(v) {
    const remaining = outAdj[v].filter((e) => !e.deleted && !contracted[e.to]).length +
      inAdj[v].filter((p) => !p.edge.deleted && !contracted[p.from]).length;
    const { count } = shortcutsNeeded(v);
    return (count - remaining) + 2 * contractedNeighbors[v];
  }

  const heap = new MinHeap();
  for (let v = 0; v < n; v++) heap.push(v, importance(v));

  const t0 = Date.now();
  while (heap.size > 0) {
    const v = heap.pop();
    if (contracted[v]) continue;
    const imp = importance(v);
    // lazy update: only contract when v is still (one of) the cheapest;
    // otherwise reinsert with its fresh importance and take the cheaper node
    if (heap.size > 0 && imp > heap.prios[0]) {
      heap.push(v, imp);
      continue;
    }
    contracted[v] = 1;
    rank[v] = order++;
    const { pairs } = shortcutsNeeded(v);
    for (const [u, x, ein, eout, cost] of pairs) {
      const sc = { to: x, w: cost, d: ein.d + eout.d, via: v, baseId: -1, e1: ein, e2: eout, deleted: false };
      outAdj[u].push(sc);
      inAdj[x].push({ edge: sc, from: u });
    }
    for (const e of outAdj[v]) e.deleted = true;
    for (const p of inAdj[v]) p.edge.deleted = true;
    for (const p of inAdj[v]) if (!contracted[p.from]) contractedNeighbors[p.from]++;
    for (const e of outAdj[v]) if (!contracted[e.to]) contractedNeighbors[e.to]++;
    if (order % 20000 === 0) log(`contracted ${order}/${n} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }

  // flatten all live edges (base + shortcuts) into one table
  const chFrom = [], chTo = [], chTime = [], chDist = [], chVia = [], chBase = [];
  const chE1 = [], chE2 = []; // indices into the ch table
  const idOf = new Map();
  for (let u = 0; u < n; u++) {
    for (const e of outAdj[u]) {
      idOf.set(e, chFrom.length);
      chFrom.push(u);
      chTo.push(e.to);
      chTime.push(e.w);
      chDist.push(e.d);
      chVia.push(e.via);
      chBase.push(e.baseId);
      chE1.push(-1);
      chE2.push(-1);
    }
  }
  for (let u = 0; u < n; u++) {
    for (const e of outAdj[u]) {
      if (e.via < 0) continue;
      const id = idOf.get(e);
      chE1[id] = idOf.get(e.e1);
      chE2[id] = idOf.get(e.e2);
    }
  }
  log(`CH done: ${order} nodes contracted, ${chFrom.length} edges total (${chFrom.filter((_, i) => chVia[i] >= 0).length} shortcuts)`);
  return { rank, chFrom, chTo, chTime, chDist, chVia, chBase, chE1, chE2 };
}

// ---------------------------------------------------------------------------
// Query: bidirectional search over upward edges only.
// ---------------------------------------------------------------------------
export function chQuery(g, ch, source, target) {
  const n = g.nNodes;
  const { rank, chFrom, chTo, chTime, chVia } = ch;
  const distF = new Float64Array(n).fill(Infinity);
  const distB = new Float64Array(n).fill(Infinity);
  const prevF = new Int32Array(n).fill(-1); // ch edge id
  const prevB = new Int32Array(n).fill(-1);
  distF[source] = 0;
  distB[target] = 0;
  const heapF = new MinHeap();
  const heapB = new MinHeap();
  heapF.push(source, 0);
  heapB.push(target, 0);
  let settled = 0;
  let best = Infinity, meet = -1;

  while (heapF.size > 0 || heapB.size > 0) {
    if (heapF.size > 0) {
      const u = heapF.pop();
      const du = distF[u];
      if (du + 0 <= best) {
        if (du + distB[u] < best) { best = du + distB[u]; meet = u; }
        settled++;
        for (let e = ch.upFirst[u]; e < ch.upFirst[u + 1]; e++) {
          const ce = ch.upEdge[e];
          if (rank[chTo[ce]] <= rank[u]) continue;
          const v = chTo[ce];
          const nd = du + chTime[ce];
          if (nd < distF[v]) { distF[v] = nd; prevF[v] = ce; heapF.push(v, nd); }
        }
      }
    }
    if (heapB.size > 0) {
      const u = heapB.pop();
      const du = distB[u];
      if (du <= best) {
        if (du + distF[u] < best) { best = du + distF[u]; meet = u; }
        settled++;
        for (let e = ch.downFirst[u]; e < ch.downFirst[u + 1]; e++) {
          const ce = ch.downEdge[e];
          // downEdge entries are ch edges ending at u from a higher-ranked node
          const v = chFrom[ce];
          const nd = du + chTime[ce];
          if (nd < distB[v]) { distB[v] = nd; prevB[v] = ce; heapB.push(v, nd); }
        }
      }
    }
    // No early topF+topB>=best break: with stale heap entries the tops do not
    // lower-bound every pending meet improvement, and the break was observed to
    // cut off optimal paths on the real Delhi graph (benchmark agreement fell
    // to 18/30). The du<=best prune above keeps the drain cheap; correctness
    // beats the last few settled nodes.
    void 0;
  }

  if (meet < 0) return { found: false, settled };

  // collect ch edges along the path, then unpack shortcuts into base edges
  const chain = [];
  for (let v = meet; v !== source;) {
    const ce = prevF[v];
    chain.unshift(ce);
    v = chFrom[ce];
  }
  const back = [];
  for (let v = meet; v !== target;) {
    const ce = prevB[v];
    back.push(ce);
    v = chTo[ce];
  }
  chain.push(...back);

  const ordered = [];
  // recursive unpack preserving order
  function unpack(ce) {
    if (chVia[ce] < 0) { ordered.push(ch.chBase[ce]); return; }
    unpack(ch.chE1[ce]);
    unpack(ch.chE2[ce]);
  }
  for (const ce of chain) unpack(ce);
  return { found: true, time: best, edgeIds: ordered, settled, meet };
}
