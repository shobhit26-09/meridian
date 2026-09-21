// Dijkstra and A* over the CSR graph. A* uses haversine-to-target / max speed,
// an admissible heuristic (no road beats 100 km/h), so results stay exact.
import { MinHeap } from './heap.js';
import { haversine } from './graph.js';

export function dijkstra(g, source, target) {
  const { nNodes, firstEdge, edgeTo, edgeTime } = g;
  const dist = new Float64Array(nNodes).fill(Infinity);
  const prevEdge = new Int32Array(nNodes).fill(-1);
  const prevNode = new Int32Array(nNodes).fill(-1);
  const heap = new MinHeap();
  dist[source] = 0;
  heap.push(source, 0);
  let settled = 0;
  while (heap.size > 0) {
    const u = heap.pop();
    if (u === target) { settled++; break; }
    settled++;
    const du = dist[u];
    for (let e = firstEdge[u]; e < firstEdge[u + 1]; e++) {
      const v = edgeTo[e];
      const nd = du + edgeTime[e];
      if (nd < dist[v]) {
        dist[v] = nd;
        prevEdge[v] = e;
        prevNode[v] = u;
        heap.push(v, nd);
      }
    }
  }
  return { time: dist[target], prevEdge, prevNode, settled, found: dist[target] < Infinity };
}

export function astar(g, source, target) {
  const { nNodes, firstEdge, edgeTo, edgeTime, nodeLat, nodeLon, maxSpeedMps } = g;
  const tLat = nodeLat(target), tLon = nodeLon(target);
  const h = (v) => haversine(nodeLat(v), nodeLon(v), tLat, tLon) / maxSpeedMps;
  const dist = new Float64Array(nNodes).fill(Infinity);
  const prevEdge = new Int32Array(nNodes).fill(-1);
  const prevNode = new Int32Array(nNodes).fill(-1);
  const heap = new MinHeap();
  dist[source] = 0;
  heap.push(source, h(source));
  let settled = 0;
  while (heap.size > 0) {
    const u = heap.pop();
    if (u === target) { settled++; break; }
    settled++;
    const du = dist[u];
    for (let e = firstEdge[u]; e < firstEdge[u + 1]; e++) {
      const v = edgeTo[e];
      const nd = du + edgeTime[e];
      if (nd < dist[v]) {
        dist[v] = nd;
        prevEdge[v] = e;
        prevNode[v] = u;
        heap.push(v, nd + h(v));
      }
    }
  }
  return { time: dist[target], prevEdge, prevNode, settled, found: dist[target] < Infinity };
}

// Walk prev pointers back from target; returns edge ids in travel order.
export function unwind(source, target, prevEdge, prevNode) {
  const edges = [];
  let v = target;
  let guard = 0;
  while (v !== source) {
    const e = prevEdge[v];
    if (e < 0 || guard++ > 10_000_000) return null;
    edges.push(e);
    v = prevNode[v];
  }
  return edges.reverse();
}
