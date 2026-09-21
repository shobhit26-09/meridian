// Binary min-heap keyed by numeric priority. The backbone of every search here.
export class MinHeap {
  constructor() {
    this.items = [];   // node ids
    this.prios = [];   // priorities
  }
  get size() { return this.items.length; }
  push(item, prio) {
    const items = this.items, prios = this.prios;
    items.push(item);
    prios.push(prio);
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (prios[p] <= prios[i]) break;
      [items[p], items[i]] = [items[i], items[p]];
      [prios[p], prios[i]] = [prios[i], prios[p]];
      i = p;
    }
  }
  pop() {
    const items = this.items, prios = this.prios;
    const top = items[0];
    const lastItem = items.pop(), lastPrio = prios.pop();
    if (items.length > 0) {
      items[0] = lastItem;
      prios[0] = lastPrio;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let s = i;
        if (l < items.length && prios[l] < prios[s]) s = l;
        if (r < items.length && prios[r] < prios[s]) s = r;
        if (s === i) break;
        [items[s], items[i]] = [items[i], items[s]];
        [prios[s], prios[i]] = [prios[i], prios[s]];
        i = s;
      }
    }
    return top;
  }
}
