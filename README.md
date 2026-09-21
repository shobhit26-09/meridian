# Meridian

A routing engine for Indian roads. Real OpenStreetMap data parsed into a road
graph, three shortest-path engines implemented from scratch - Dijkstra, A*,
and contraction hierarchies - and a MapLibre UI with draggable waypoints and
turn-by-turn directions.

**Live:** _deploy link lands here_

![Meridian routing from Dharamshala to Shimla](docs/screenshot.png)

## What it does

- Drag two pins anywhere in Himachal Pradesh. Meridian snaps them to the road
  network and returns the optimal driving route with turn-by-turn steps.
- Pick your engine: **contraction hierarchies**, **A***, or **Dijkstra**. Every
  engine returns the identical optimal answer - the difference is how much of
  the graph they had to look at, and the UI shows it live.
- The API can run all three on the same query (`compare=1`) so the comparison
  is apples to apples.

## Measured performance

_Benchmark numbers land here after the benchmark run._

## How it works

```
Geofabrik india-latest.osm.pbf (1.7 GB)
  -> scripts/build_graph.py   drivable ways inside the Himachal bbox,
                              intersections become graph nodes, straight runs
                              compress into weighted edges (weight = drive time)
                              -> data/graph.bin (custom CSR binary)
  -> scripts/build_ch.js      contraction hierarchies preprocessing:
                              nodes ordered by importance, shortcuts added,
                              ranks serialized -> data/ch.bin
  -> server/index.js          loads both, answers /api/route in milliseconds
```

- **Graph**: edge weights are drive time (haversine distance / per-class speed),
  one-way tags and access restrictions respected, largest connected component kept.
- **Dijkstra** settles nodes in cost order until the target pops - correct,
  and on a regional graph it looks at most of the map.
- **A*** adds an admissible heuristic (straight-line distance / 100 km/h), which
  steers the search toward the target without changing the answer.
- **Contraction hierarchies** preprocess the graph once: contract unimportant
  nodes first, adding shortcut edges that preserve all shortest paths. Queries
  then scan only "upward" edges from both ends and meet in the middle - which
  is why they settle a few hundred nodes instead of a hundred thousand.
  Shortcuts unpack back into real road geometry for rendering.

## API

`GET /api/route?from=LAT,LON&to=LAT,LON&algo=ch|astar|dijkstra[&compare=1]`

Returns distance, drive time, the route polyline, turn-by-turn steps, and per
engine query time + settled-node counts. `GET /api/meta` returns graph stats
and the benchmark summary served to the UI.

## Run it locally

```bash
npm install
npm start          # serves UI + API on :3000 (data/ is committed)
```

Rebuild the graph from scratch:

```bash
pip install osmium
npm run build:graph  # needs the Geofabrik pbf in data/
npm run build:ch
npm run benchmark
```

## Stack

Plain JavaScript end to end: Node + Express API, vanilla JS + MapLibre GL
frontend, Python (pyosmium) for the one-time PBF pipeline. No framework, no
TypeScript, no paid services. Map tiles by CARTO, data (c) OpenStreetMap
contributors.
