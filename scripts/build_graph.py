#!/usr/bin/env python3
"""Build Meridian's road graph from an OSM PBF extract, in stages.

Stage 'nodes': collect every node inside the bbox -> checkpoint pickle.
Stage 'ways':  keep drivable ways touching those nodes, mark intersections,
               compress straight runs into weighted edges -> checkpoint.
Stage 'finish': largest-component filter, CSR layout, binary + meta out.

Binary format (little endian):
  magic "MRDG1" | u32 n_nodes | u32 n_edges | u32 n_coords | u32 n_names | u32 reserved
  coordLat[n_coords] f64 | coordLon[n_coords] f64
  nodeCoord[n_nodes] u32                 # graph node -> coord index
  firstEdge[n_nodes+1] u32               # CSR adjacency
  edgeTo[n_edges] u32 | edgeTime f32 | edgeDist f32 | edgeName u32
  edgeGeoOff u32 | edgeGeoLen u32
  geoCoord[sum geo_len] u32              # polylines as coord indices
  namesOff[n_names+1] u32 | names blob (utf8)
"""
import osmium, sys, pickle, struct, time, math, json, os
from array import array
from collections import Counter

BBOX = (75.55, 30.30, 79.05, 33.30)  # min_lon, min_lat, max_lon, max_lat (Himachal + pad)
PBF = sys.argv[1] if len(sys.argv) > 1 else 'data/india.osm.pbf'
STAGE = sys.argv[2] if len(sys.argv) > 2 else 'all'

SPEEDS = {
    'motorway': 100, 'trunk': 80, 'primary': 65, 'secondary': 55,
    'tertiary': 45, 'unclassified': 35, 'residential': 30,
    'living_street': 15, 'service': 20,
    'motorway_link': 60, 'trunk_link': 50, 'primary_link': 45,
    'secondary_link': 40, 'tertiary_link': 35,
}
CLASS_CODES = {h: i for i, h in enumerate(sorted(SPEEDS))}
SKIP = {'footway','cycleway','path','track','pedestrian','steps','bridleway',
        'construction','proposed','raceway','corridor','elevator','bus_guideway','escape'}

def in_bbox(lat, lon):
    return BBOX[1] <= lat <= BBOX[3] and BBOX[0] <= lon <= BBOX[2]

class NodePass(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ids = {}
        self.lats = array('d')
        self.lons = array('d')
        self.kept = 0
    def node(self, n):
        if n.location.valid() and in_bbox(n.location.lat, n.location.lon):
            self.ids[n.id] = self.kept
            self.lats.append(n.location.lat)
            self.lons.append(n.location.lon)
            self.kept += 1

class WayPass(osmium.SimpleHandler):
    def __init__(self, node_ids):
        super().__init__()
        self.node_ids = node_ids
        self.ways = []
        self.kept_ways = 0
    def way(self, w):
        tags = w.tags
        hw = tags.get('highway')
        if not hw or hw in SKIP or hw not in SPEEDS:
            return
        access = tags.get('access')
        mv = tags.get('motor_vehicle')
        mc = tags.get('motorcar')
        if (access in ('no', 'private') or mv in ('no', 'private')) and mc != 'yes' and mv != 'yes':
            return
        idxs = [self.node_ids.get(ref.ref) for ref in w.nodes]
        name = tags.get('name') or tags.get('ref') or ''
        oneway = tags.get('oneway') in ('yes', 'true', '1') or tags.get('junction') == 'roundabout' or hw == 'motorway'
        reverse = tags.get('oneway') == '-1'
        run = []
        for i in list(idxs) + [None]:
            if i is not None:
                run.append(i)
            else:
                if len(run) >= 2:
                    self.ways.append((run, name, hw, oneway, reverse))
                    self.kept_ways += 1
                run = []

def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(a))

if STAGE in ('nodes', 'all'):
    t0 = time.time()
    np_ = NodePass()
    np_.apply_file(PBF, locations=False)
    with open('data/checkpoint_nodes.pkl', 'wb') as f:
        pickle.dump({'ids': np_.ids, 'lats': np_.lats, 'lons': np_.lons}, f, protocol=4)
    print(f'nodes: kept {np_.kept} in bbox, {time.time()-t0:.0f}s', flush=True)

if STAGE in ('ways', 'all'):
    if STAGE == 'ways':
        with open('data/checkpoint_nodes.pkl', 'rb') as f:
            ck = pickle.load(f)
        node_ids, lats, lons = ck['ids'], ck['lats'], ck['lons']
    else:
        node_ids, lats, lons = np_.ids, np_.lats, np_.lons
    t0 = time.time()
    wp = WayPass(node_ids)
    wp.apply_file(PBF, locations=False)
    print(f'ways: kept {wp.kept_ways} clipped runs, {time.time()-t0:.0f}s', flush=True)

    usage = array('I', bytes(4 * len(node_ids)))
    for run, _, _, _, _ in wp.ways:
        for i in run:
            usage[i] += 1

    gnode_of = {}
    gnode_coord = array('I')
    edges = []
    names = {}
    def gnode(ci):
        g = gnode_of.get(ci)
        if g is None:
            g = len(gnode_coord)
            gnode_of[ci] = g
            gnode_coord.append(ci)
        return g

    for run, name, cls, oneway, reverse in wp.ways:
        name_id = names.setdefault(name, len(names))
        speed = SPEEDS[cls] / 3.6
        start = 0
        for k in range(1, len(run)):
            is_end = k == len(run) - 1
            if usage[run[k]] > 1 or is_end:
                geo = run[start:k+1]
                dist = sum(haversine_m(lats[geo[j]], lons[geo[j]], lats[geo[j+1]], lons[geo[j+1]])
                           for j in range(len(geo)-1))
                t = dist / speed
                u, v = gnode(geo[0]), gnode(geo[-1])
                if reverse:
                    edges.append((v, u, t, dist, name_id, CLASS_CODES[cls], geo[::-1]))
                else:
                    edges.append((u, v, t, dist, name_id, CLASS_CODES[cls], geo))
                    if not oneway:
                        edges.append((v, u, t, dist, name_id, CLASS_CODES[cls], geo[::-1]))
                start = k
    with open('data/checkpoint_graph.pkl', 'wb') as f:
        pickle.dump({'gnode_coord': gnode_coord, 'edges': edges, 'names': names,
                     'lats': lats, 'lons': lons}, f, protocol=4)
    print(f'compress: {len(gnode_coord)} graph nodes, {len(edges)} directed edges, {len(names)} unique names', flush=True)

if STAGE in ('finish', 'all'):
    if STAGE == 'finish':
        with open('data/checkpoint_graph.pkl', 'rb') as f:
            ck = pickle.load(f)
        gnode_coord, edges, names, lats, lons = ck['gnode_coord'], ck['edges'], ck['names'], ck['lats'], ck['lons']
    n = len(gnode_coord)

    parent = list(range(n))
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for u, v, *_ in edges:
        ru, rv = find(u), find(v)
        if ru != rv:
            parent[ru] = rv
    comp = Counter(find(i) for i in range(n))
    main = comp.most_common(1)[0][0]
    remap = {}
    new_coord = array('I')
    for i in range(n):
        if find(i) == main:
            remap[i] = len(new_coord)
            new_coord.append(gnode_coord[i])
    edges = [(remap[u], remap[v], t, d, nm, c, g) for u, v, t, d, nm, c, g in edges
             if u in remap and v in remap]
    print(f'largest component: {len(new_coord)}/{n} nodes, {len(edges)} edges', flush=True)

    n2 = len(new_coord)
    firstEdge = array('I', bytes(4 * (n2 + 1)))
    for u, *_ in edges:
        firstEdge[u+1] += 1
    for i in range(1, n2 + 1):
        firstEdge[i] += firstEdge[i-1]
    m = len(edges)
    edgeTo = array('I', bytes(4 * m))
    edgeTime = array('f', bytes(4 * m))
    edgeDist = array('f', bytes(4 * m))
    edgeName = array('I', bytes(4 * m))
    edgeGeoOff = array('I', bytes(4 * m))
    edgeGeoLen = array('I', bytes(4 * m))
    edgeClass = array('I', bytes(4 * m))
    geoCoord = array('I')
    cursor = array('I', firstEdge[:n2])
    names_list = [''] * len(names)
    for name, i in names.items():
        names_list[i] = name
    for u, v, t, d, nm, c, g in edges:
        e = cursor[u]
        cursor[u] += 1
        edgeTo[e] = v
        edgeTime[e] = t
        edgeDist[e] = d
        edgeName[e] = nm
        edgeClass[e] = c
        edgeGeoOff[e] = len(geoCoord)
        edgeGeoLen[e] = len(g)
        geoCoord.extend(g)

    names_blob = b''
    namesOff = array('I', [0])
    for name in names_list:
        names_blob += name.encode('utf-8')
        namesOff.append(len(names_blob))

    # drop coords no edge geometry references (buildings, POIs, ...) and remap
    used = bytearray(len(lats))
    for ci in geoCoord:
        used[ci] = 1
    for ci in new_coord:
        used[ci] = 1
    coord_remap = array('I', bytes(4 * len(lats)))
    slim_lat = array('d')
    slim_lon = array('d')
    for ci in range(len(lats)):
        if used[ci]:
            coord_remap[ci] = len(slim_lat)
            slim_lat.append(lats[ci])
            slim_lon.append(lons[ci])
    print(f'coords: kept {len(slim_lat)}/{len(lats)} referenced by road geometry', flush=True)
    for i in range(len(new_coord)):
        new_coord[i] = coord_remap[new_coord[i]]
    for i in range(len(geoCoord)):
        geoCoord[i] = coord_remap[geoCoord[i]]

    with open('data/graph.bin', 'wb') as f:
        f.write(b'MRDG1')
        f.write(struct.pack('<5I', n2, m, len(slim_lat), len(names_list), 0))
        slim_lat.tofile(f)
        slim_lon.tofile(f)
        new_coord.tofile(f)
        firstEdge.tofile(f)
        edgeTo.tofile(f)
        edgeTime.tofile(f)
        edgeDist.tofile(f)
        edgeName.tofile(f)
        edgeGeoOff.tofile(f)
        edgeGeoLen.tofile(f)
        edgeClass.tofile(f)
        geoCoord.tofile(f)
        namesOff.tofile(f)
        f.write(names_blob)

    meta = {
        'graphNodes': n2, 'edges': m, 'coords': len(slim_lat),
        'names': len(names_list), 'bbox': BBOX, 'region': 'Himachal Pradesh, India',
        'source': 'Geofabrik india-latest.osm.pbf (c) OpenStreetMap contributors',
        'builtAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'graphBinBytes': os.path.getsize('data/graph.bin'),
    }
    with open('data/meta.json', 'w') as f:
        json.dump(meta, f, indent=2)
    print('wrote data/graph.bin + data/meta.json:', json.dumps(meta), flush=True)
