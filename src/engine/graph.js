// Loader for the MRDG1 binary graph + reverse adjacency + grid snapping index.
import fs from 'node:fs';

export function loadGraph(path) {
  const buf = fs.readFileSync(path);
  if (buf.subarray(0, 5).toString('latin1') !== 'MRDG1') throw new Error('bad graph magic');
  let off = 5;
  const u32 = () => { const v = buf.readUInt32LE(off); off += 4; return v; };
  const nNodes = u32(), nEdges = u32(), nCoords = u32(), nNames = u32(); u32();

  const readArray = (Ctor, bytes, n) => {
    const ab = new ArrayBuffer(n * bytes);
    new Uint8Array(ab).set(buf.subarray(off, off + n * bytes));
    off += n * bytes;
    return new Ctor(ab);
  };

  const coordLat = readArray(Float64Array, 8, nCoords);
  const coordLon = readArray(Float64Array, 8, nCoords);
  const nodeCoord = readArray(Uint32Array, 4, nNodes);
  const firstEdge = readArray(Uint32Array, 4, nNodes + 1);
  const edgeTo = readArray(Uint32Array, 4, nEdges);
  const edgeTime = readArray(Float32Array, 4, nEdges);
  const edgeDist = readArray(Float32Array, 4, nEdges);
  const edgeName = readArray(Uint32Array, 4, nEdges);
  const edgeGeoOff = readArray(Uint32Array, 4, nEdges);
  const edgeGeoLen = readArray(Uint32Array, 4, nEdges);
  const edgeClass = readArray(Uint32Array, 4, nEdges);
  const geoCoord = readArray(Uint32Array, 4, (buf.length - off) / 4 | 0);

  // geoCoord length is not in the header; recompute from names section.
  // namesOff is nNames+1 u32s followed by the blob, so walk from the end:
  // (we know nNames; the last 4*(nNames+1) bytes before the blob are offsets)
  // Simpler: geoCoord length = sum of edgeGeoLen.
  let geoLen = 0;
  for (let e = 0; e < nEdges; e++) geoLen += edgeGeoLen[e];
  const geo = geoCoord.subarray(0, geoLen);
  off = off; // offsets continue after geo
  const afterGeo = 25 + 8 * nCoords * 2 + 4 * nNodes + 4 * (nNodes + 1) + 4 * nEdges * 7 + 4 * geoLen;
  const namesOff = new Uint32Array(nNames + 1);
  for (let i = 0; i <= nNames; i++) namesOff[i] = buf.readUInt32LE(afterGeo + 4 * i);
  const blobStart = afterGeo + 4 * (nNames + 1);
  const decoder = new TextDecoder();
  const names = new Array(nNames);
  for (let i = 0; i < nNames; i++) {
    names[i] = decoder.decode(buf.subarray(blobStart + namesOff[i], blobStart + namesOff[i + 1]));
  }

  // reverse adjacency (revEdge[e] = forward edge id this reverses)
  const revFirst = new Uint32Array(nNodes + 1);
  for (let e = 0; e < nEdges; e++) revFirst[edgeTo[e] + 1]++;
  for (let i = 1; i <= nNodes; i++) revFirst[i] += revFirst[i - 1];
  const revHead = new Uint32Array(nEdges);
  const revEdge = new Uint32Array(nEdges);
  {
    const cursor = revFirst.slice(0, nNodes);
    for (let u = 0; u < nNodes; u++) {
      for (let e = firstEdge[u]; e < firstEdge[u + 1]; e++) {
        const v = edgeTo[e];
        const slot = cursor[v]++;
        revHead[slot] = u;
        revEdge[slot] = e;
      }
    }
  }

  // snapping grid over graph nodes (cells ~0.005 deg, about 500 m)
  const CELL = 0.005;
  const grid = new Map();
  const key = (lat, lon) => `${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`;
  for (let i = 0; i < nNodes; i++) {
    const c = nodeCoord[i];
    const k = key(coordLat[c], coordLon[c]);
    let arr = grid.get(k);
    if (!arr) grid.set(k, arr = []);
    arr.push(i);
  }

  function nearestNode(lat, lon) {
    const baseLa = Math.floor(lat / CELL), baseLo = Math.floor(lon / CELL);
    for (let ring = 0; ring <= 40; ring++) {
      let best = -1, bestD = Infinity;
      for (let dla = -ring; dla <= ring; dla++) {
        for (let dlo = -ring; dlo <= ring; dlo++) {
          if (Math.max(Math.abs(dla), Math.abs(dlo)) !== ring) continue;
          const arr = grid.get(`${baseLa + dla},${baseLo + dlo}`);
          if (!arr) continue;
          for (const i of arr) {
            const c = nodeCoord[i];
            const d = haversine(lat, lon, coordLat[c], coordLon[c]);
            if (d < bestD) { bestD = d; best = i; }
          }
        }
      }
      if (best >= 0) return { node: best, distanceM: bestD };
    }
    return null;
  }

  const nodeLat = (i) => coordLat[nodeCoord[i]];
  const nodeLon = (i) => coordLon[nodeCoord[i]];

  return {
    nNodes, nEdges, coordLat, coordLon, nodeCoord,
    firstEdge, edgeTo, edgeTime, edgeDist, edgeName, edgeGeoOff, edgeGeoLen, edgeClass,
    geo, names, revFirst, revHead, revEdge, nearestNode, nodeLat, nodeLon,
    maxSpeedMps: 100 / 3.6,
  };
}

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Load ch.bin and build the upward/downward CSR views the query needs.
export function loadCH(path, rankHolder) {
  const buf = fs.readFileSync(path);
  if (buf.subarray(0, 5).toString('latin1') !== 'MRCH1') throw new Error('bad ch magic');
  let off = 5;
  const n = buf.readUInt32LE(off); off += 4;
  const m = buf.readUInt32LE(off); off += 4;
  const read = (signed = false, float = false, count = m) => {
    const ab = new ArrayBuffer(count * 4);
    new Uint8Array(ab).set(buf.subarray(off, off + count * 4));
    off += count * 4;
    return float ? new Float32Array(ab) : signed ? new Int32Array(ab) : new Uint32Array(ab);
  };
  const rank = read(false, false, n);
  const chFrom = read(), chTo = read();
  const chTime = read(false, true), chDist = read(false, true);
  const chVia = read(true), chBase = read(true);
  const chE1 = read(true), chE2 = read(true);

  // upward edges indexed by source; the same set indexed by target for the
  // backward search
  // forward search uses upward edges (low rank -> high rank) by source;
  // backward search uses downward edges (high rank -> low rank) by target
  const upFirst = new Uint32Array(n + 1);
  const downFirst = new Uint32Array(n + 1);
  const isUp = new Uint8Array(m);
  for (let e = 0; e < m; e++) {
    if (rank[chTo[e]] > rank[chFrom[e]]) {
      isUp[e] = 1;
      upFirst[chFrom[e] + 1]++;
    } else {
      downFirst[chTo[e] + 1]++;
    }
  }
  for (let i = 1; i <= n; i++) { upFirst[i] += upFirst[i - 1]; downFirst[i] += downFirst[i - 1]; }
  const upEdge = new Uint32Array(upFirst[n]);
  const downEdge = new Uint32Array(downFirst[n]);
  {
    const cu = upFirst.slice(0, n), cd = downFirst.slice(0, n);
    for (let e = 0; e < m; e++) {
      if (isUp[e]) upEdge[cu[chFrom[e]]++] = e;
      else downEdge[cd[chTo[e]]++] = e;
    }
  }
  return { rank, chFrom, chTo, chTime, chDist, chVia, chBase, chE1, chE2, upFirst, upEdge, downFirst, downEdge };
}
