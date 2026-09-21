// Turn-by-turn from a route's edge list: group by road name, classify the
// turn angle at each junction, emit Apple-Maps-style instructions.
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function classifyTurn(delta) {
  // delta: change in bearing, -180..180 (positive = right)
  const a = Math.abs(delta);
  if (a < 20) return 'Continue';
  if (a > 160) return 'Make a U-turn';
  const side = delta > 0 ? 'right' : 'left';
  if (a < 60) return `Bear ${side}`;
  if (a < 120) return `Turn ${side}`;
  return `Make a sharp ${side}`;
}

export function buildSteps(g, edgeIds, coords) {
  if (edgeIds.length === 0) return [];
  const nameOf = (e) => g.names[g.edgeName[e]] || 'Unnamed road';

  // group consecutive edges sharing a name
  const groups = [];
  for (const e of edgeIds) {
    const name = nameOf(e);
    const last = groups[groups.length - 1];
    if (last && last.name === name) {
      last.distanceM += g.edgeDist[e];
      last.endCoord += g.edgeGeoLen[e] - 1;
    } else {
      groups.push({
        name,
        distanceM: g.edgeDist[e],
        startCoord: groups.length ? last.endCoord + 1 : 0,
        endCoord: g.edgeGeoLen[e] - 1,
      });
    }
  }

  const steps = [];
  for (let i = 0; i < groups.length; i++) {
    const grp = groups[i];
    const locIdx = Math.min(grp.startCoord, coords.length - 1);
    const loc = coords[locIdx];
    if (i === 0) {
      const b = coords.length > 1 ? bearing(coords[0][0], coords[0][1], coords[1][0], coords[1][1]) : 0;
      const dir = COMPASS[Math.round(b / 45) % 8];
      steps.push({
        instruction: `Head ${dir} on ${grp.name}`,
        name: grp.name,
        distanceM: grp.distanceM,
        location: loc,
        kind: 'depart',
      });
      continue;
    }
    // turn angle between the previous group's last segment and this one's first
    const prevEnd = Math.max(groups[i - 1].endCoord, 1);
    const a1 = coords[Math.min(prevEnd - 1, coords.length - 1)];
    const a2 = coords[Math.min(prevEnd, coords.length - 1)];
    const b1 = coords[Math.min(prevEnd + 1, coords.length - 1)];
    const inB = bearing(a1[0], a1[1], a2[0], a2[1]);
    const outB = bearing(a2[0], a2[1], b1[0], b1[1]);
    let delta = outB - inB;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    const turn = classifyTurn(delta);
    steps.push({
      instruction: turn === 'Continue' ? `Continue on ${grp.name}` : `${turn} onto ${grp.name}`,
      name: grp.name,
      distanceM: grp.distanceM,
      location: loc,
      kind: 'turn',
      delta,
    });
  }
  steps.push({
    instruction: 'Arrive at your destination',
    name: '',
    distanceM: 0,
    location: coords[coords.length - 1],
    kind: 'arrive',
  });
  return steps;
}
