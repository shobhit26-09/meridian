// Preprocess contraction hierarchies over graph.bin -> ch.bin
import { loadGraph } from '../src/engine/graph.js';
import { preprocessCH } from '../src/engine/ch.js';
import fs from 'node:fs';

const t0 = Date.now();
const g = loadGraph('data/graph.bin');
console.log(`graph loaded: ${g.nNodes} nodes, ${g.nEdges} edges (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

const ch = preprocessCH(g, { log: (s) => console.log(s) });

const n = g.nNodes;
const m = ch.chFrom.length;
const buf = Buffer.alloc(9 + 8 + 4 * n + m * (4 * 7 + 4));
let off = 0;
buf.write('MRCH1', off, 'latin1'); off += 5;
buf.writeUInt32LE(n, off); off += 4;
buf.writeUInt32LE(m, off); off += 4;
for (let i = 0; i < n; i++) { buf.writeUInt32LE(ch.rank[i], off); off += 4; }
const writeArr = (arr, signed = false, float = false) => {
  for (let i = 0; i < m; i++) {
    if (float) buf.writeFloatLE(arr[i], off);
    else if (signed) buf.writeInt32LE(arr[i], off);
    else buf.writeUInt32LE(arr[i], off);
    off += 4;
  }
};
writeArr(ch.chFrom); writeArr(ch.chTo);
writeArr(ch.chTime, false, true); writeArr(ch.chDist, false, true);
writeArr(ch.chVia, true); writeArr(ch.chBase, true);
writeArr(ch.chE1, true); writeArr(ch.chE2, true);
fs.writeFileSync('data/ch.bin', buf);
console.log(`ch.bin written: ${(buf.length / 1e6).toFixed(1)} MB, total ${((Date.now() - t0) / 1000).toFixed(0)}s`);
