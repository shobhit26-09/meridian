#!/usr/bin/env python3
"""Fast PBF -> graph pipeline via pyrosm (C++ parse, bbox filter).

Stage 'parse': pyrosm driving network inside the Himachal bbox -> ways pickle
Stage 'chain': chain way segments, split at intersections, weight edges
               -> checkpoint_graph.pkl (same format build_graph.py 'finish' eats)
"""
import sys, pickle, time, math
from array import array

BBOX = [75.55, 30.30, 79.05, 33.30]
PBF = 'data/india.osm.pbf'
STAGE = sys.argv[1] if len(sys.argv) > 1 else 'all'

SPEEDS = {
    'motorway': 100, 'trunk': 80, 'primary': 65, 'secondary': 55,
    'tertiary': 45, 'unclassified': 35, 'residential': 30,
    'living_street': 15, 'service': 20,
    'motorway_link': 60, 'trunk_link': 50, 'primary_link': 45,
    'secondary_link': 40, 'tertiary_link': 35,
}
CLASS_CODES = {h: i for i, h in enumerate(sorted(SPEEDS))}

if STAGE in ('parse', 'all'):
    from pyrosm import OSM
    t0 = time.time()
    osm = OSM(PBF, bounding_box=BBOX)
    nodes, edges = osm.get_network(
        network_type='driving', nodes=True,
        extra_attributes=['name', 'ref', 'junction', 'maxspeed', 'access', 'motor_vehicle', 'motorcar'],
    )
    print(f'pyrosm: {len(nodes)} nodes, {len(edges)} segments, {time.time()-t0:.0f}s', flush=True)

    # node id -> compact index with coords
    ids = {}
    lats = array('d')
    lons = array('d')
    for nid, lat, lon in zip(nodes['id'].to_numpy(), nodes['lat'].to_numpy(), nodes['lon'].to_numpy()):
        ids[int(nid)] = len(lats)
        lats.append(float(lat))
        lons.append(float(lon))

    # group segments into ways, preserving way order
    ways = {}  # way_id -> {'segs': [(u_idx, v_idx)], 'name', 'cls', 'oneway', 'reverse'}
    cols = edges[['id', 'u', 'v', 'length', 'highway', 'oneway', 'name', 'ref', 'junction', 'access', 'motor_vehicle', 'motorcar']].fillna('')
    for row in cols.itertuples(index=False):
        hw = row.highway if row.highway in SPEEDS else None
        if hw is None:
            continue
        access, mv, mc = str(row.access), str(row.motor_vehicle), str(row.motorcar)
        if (access in ('no', 'private') or mv in ('no', 'private')) and mc != 'yes' and mv != 'yes':
            continue
        u = ids.get(int(row.u))
        v = ids.get(int(row.v))
        if u is None or v is None:
            continue
        oneway = str(row.oneway) in ('yes', 'true', '1', 'True') or str(row.junction) == 'roundabout' or hw == 'motorway'
        reverse = str(row.oneway) == '-1'
        name = str(row.name) if str(row.name) not in ('', 'nan', 'None') else (str(row.ref) if str(row.ref) not in ('', 'nan', 'None') else '')
        wid = int(row.id)
        w = ways.setdefault(wid, {'segs': [], 'name': name, 'cls': hw, 'oneway': oneway, 'reverse': reverse})
        w['segs'].append((u, v, float(row.length)))
    with open('data/checkpoint_ways.pkl', 'wb') as f:
        pickle.dump({'ids': ids, 'lats': lats, 'lons': lons, 'ways': ways}, f, protocol=4)
    print(f'parse: {len(ways)} drivable ways, {time.time()-t0:.0f}s total', flush=True)

if STAGE in ('chain', 'all'):
    if STAGE == 'chain':
        with open('data/checkpoint_ways.pkl', 'rb') as f:
            ck = pickle.load(f)
        ids, lats, lons, ways = ck['ids'], ck['lats'], ck['lons'], ck['ways']
    t0 = time.time()

    # node usage: how many segment endpoints, across how many distinct ways
    from collections import defaultdict
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

    def hav(lat1, lon1, lat2, lon2):
        R = 6371000.0
        p1, p2 = math.radians(lat1), math.radians(lat2)
        dp = math.radians(lat2 - lat1)
        dl = math.radians(lon2 - lon1)
        a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
        return 2 * R * math.asin(math.sqrt(a))

    for wid, w in ways.items():
        segs = w['segs']
        if not segs:
            continue
        # order segments into a path: match v -> next u
        ordered = [segs[0]]
        rest = {s[0]: s for s in segs[1:]}
        while len(ordered) < len(segs):
            nxt = rest.pop(ordered[-1][1], None)
            if nxt is None:
                break
            ordered.append(nxt)
        # node sequence + per-segment lengths
        seq = [ordered[0][0]] + [s[1] for s in ordered]
        seg_lens = [s[2] for s in ordered]
        name_id = names.setdefault(w['name'], len(names))
        speed = SPEEDS[w['cls']] / 3.6
        start = 0
        for k in range(1, len(seq)):
            is_end = k == len(seq) - 1
            if is_intersection(seq[k]) or is_end:
                geo = seq[start:k+1]
                dist = sum(seg_lens[start:k]) if sum(seg_lens[start:k]) > 0 else sum(
                    hav(lats[geo[j]], lons[geo[j]], lats[geo[j+1]], lons[geo[j+1]]) for j in range(len(geo)-1))
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
