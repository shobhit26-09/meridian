#!/usr/bin/env python3
"""PBF -> graph pipeline via pyosmium (low-memory, for small regional extracts).

Stage 'parse': two pyosmium passes (driving ways, then referenced node coords)
               -> checkpoint_ways.pkl
Stage 'chain': chain way segments, split at intersections, weight edges
               -> checkpoint_graph.pkl (same format build_graph.py 'finish' eats)
"""
import sys, pickle, time, math
from array import array
from collections import defaultdict

PBF = 'data/newdelhi.osm.pbf'
STAGE = sys.argv[1] if len(sys.argv) > 1 else 'all'

SPEEDS = {
    'motorway': 100, 'trunk': 80, 'primary': 65, 'secondary': 55,
    'tertiary': 45, 'unclassified': 35, 'residential': 30,
    'living_street': 15, 'service': 20,
    'motorway_link': 60, 'trunk_link': 50, 'primary_link': 45,
    'secondary_link': 40, 'tertiary_link': 35,
}
CLASS_CODES = {h: i for i, h in enumerate(sorted(SPEEDS))}

def hav(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(a))

if STAGE in ('parse', 'all'):
    import osmium
    t0 = time.time()

    class WayCollector(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.ways = {}
        def way(self, w):
            hw = w.tags.get('highway')
            if hw not in SPEEDS:
                return
            if w.tags.get('area') == 'yes':
                return
            access = w.tags.get('access', '')
            mv = w.tags.get('motor_vehicle', '')
            mc = w.tags.get('motorcar', '')
            if (access in ('no', 'private') or mv in ('no', 'private')) and mc != 'yes' and mv != 'yes':
                return
            oneway = w.tags.get('oneway', '') in ('yes', 'true', '1') or w.tags.get('junction') == 'roundabout' or hw == 'motorway'
            reverse = w.tags.get('oneway', '') == '-1'
            name = w.tags.get('name') or w.tags.get('ref') or ''
            self.ways[int(w.id)] = {
                'nodes': [int(n.ref) for n in w.nodes],
                'name': name, 'cls': hw, 'oneway': oneway, 'reverse': reverse,
            }

    wc = WayCollector()
    wc.apply_file(PBF)
    print(f'parse pass1: {len(wc.ways)} drivable ways, {time.time()-t0:.0f}s', flush=True)

    needed = set()
    for w in wc.ways.values():
        needed.update(w['nodes'])
    print(f'parse pass1: {len(needed)} referenced nodes', flush=True)

    coords = {}
    class NodeCollector(osmium.SimpleHandler):
        def node(self, n):
            if int(n.id) in needed:
                coords[int(n.id)] = (n.location.lat, n.location.lon)
    nc = NodeCollector()
    nc.apply_file(PBF)
    print(f'parse pass2: {len(coords)} coords resolved, {time.time()-t0:.0f}s total', flush=True)

    ids = {}
    lats = array('d')
    lons = array('d')
    ways = {}
    dropped = 0
    for wid, w in wc.ways.items():
        segs = []
        ns = w['nodes']
        for j in range(len(ns) - 1):
            a = coords.get(ns[j])
            b = coords.get(ns[j+1])
            if a is None or b is None:
                dropped += 1
                continue
            ua = ids.get(ns[j])
            if ua is None:
                ua = len(lats); ids[ns[j]] = ua; lats.append(a[0]); lons.append(a[1])
            ub = ids.get(ns[j+1])
            if ub is None:
                ub = len(lats); ids[ns[j+1]] = ub; lats.append(b[0]); lons.append(b[1])
            segs.append((ua, ub, hav(a[0], a[1], b[0], b[1])))
        if segs:
            ways[wid] = {'segs': segs, 'name': w['name'], 'cls': w['cls'],
                         'oneway': w['oneway'], 'reverse': w['reverse']}
    with open('data/checkpoint_ways.pkl', 'wb') as f:
        pickle.dump({'ids': ids, 'lats': lats, 'lons': lons, 'ways': ways}, f, protocol=4)
    print(f'parse: {len(ways)} usable ways ({dropped} segs dropped at extract edge), {len(ids)} nodes, {time.time()-t0:.0f}s', flush=True)

if STAGE in ('chain', 'all'):
    if STAGE == 'chain':
        with open('data/checkpoint_ways.pkl', 'rb') as f:
            ck = pickle.load(f)
        ids, lats, lons, ways = ck['ids'], ck['lats'], ck['lons'], ck['ways']
    t0 = time.time()

    seg_count = defaultdict(int)
    way_set = defaultdict(set)
    for wid, w in ways.items():
        for u, v, _ in w['segs']:
            seg_count[u] += 1
            seg_count[v] += 1
            way_set[u].add(wid)
            way_set[v].add(wid)

    def is_intersection(idx):
        return len(way_set[idx]) >= 2 or seg_count[idx] != 2

    gnode_of = {}
    gnode_coord = array('I')
    edges_out = []
    names = {}

    def gnode(ci):
        g = gnode_of.get(ci)
        if g is None:
            g = len(gnode_coord)
            gnode_of[ci] = g
            gnode_coord.append(ci)
        return g

    for wid, w in ways.items():
        segs = w['segs']
        if not segs:
            continue
        ordered = [segs[0]]
        rest = {s[0]: s for s in segs[1:]}
        while len(ordered) < len(segs):
            nxt = rest.pop(ordered[-1][1], None)
            if nxt is None:
                break
            ordered.append(nxt)
        seq = [ordered[0][0]] + [s[1] for s in ordered]
        seg_lens = [s[2] for s in ordered]
        name_id = names.setdefault(w['name'], len(names))
        speed = SPEEDS[w['cls']] / 3.6
        start = 0
        for k in range(1, len(seq)):
            is_end = k == len(seq) - 1
            if is_intersection(seq[k]) or is_end:
                geo = seq[start:k+1]
                dist = sum(seg_lens[start:k])
                if dist <= 0:
                    dist = sum(hav(lats[geo[j]], lons[geo[j]], lats[geo[j+1]], lons[geo[j+1]]) for j in range(len(geo)-1))
                t = dist / speed
                u, v = gnode(geo[0]), gnode(geo[-1])
                cc = CLASS_CODES[w['cls']]
                if w['reverse']:
                    edges_out.append((v, u, t, dist, name_id, cc, geo[::-1]))
                else:
                    edges_out.append((u, v, t, dist, name_id, cc, geo))
                    if not w['oneway']:
                        edges_out.append((v, u, t, dist, name_id, cc, geo[::-1]))
                start = k

    with open('data/checkpoint_graph.pkl', 'wb') as f:
        pickle.dump({'gnode_coord': gnode_coord, 'edges': edges_out, 'names': names,
                     'lats': lats, 'lons': lons}, f, protocol=4)
    print(f'chain: {len(gnode_coord)} graph nodes, {len(edges_out)} directed edges, {len(names)} names, {time.time()-t0:.0f}s', flush=True)
