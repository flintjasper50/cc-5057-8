import {
  clamp, pointInRect2, rectCenter2, distancePointSegment2, segmentRectInterval2,
  segmentAabbInterval3, hashString, round, norm2,
} from './math.js';

export const SOLID_ROLES = new Set(['wall', 'block', 'crate', 'door', 'railing', 'decor', 'slab']);

export function createScene(input) {
  const scene = {
    revision: 1,
    cellSize: 0.4,
    agent: { radius: 0.35, height: 1.8, eyeHeight: 1.6, speed: 4.4 },
    ...input,
  };
  scene.floors = scene.floors.map((f, i) => ({
    id: f.id ?? `floor-${i}`,
    name: f.name ?? f.id ?? `Floor ${i}`,
    y: f.y ?? 0,
    rect: f.rect,
    holes: f.holes ?? [],
    slabThickness: f.slabThickness ?? 0.16,
  }));
  scene.solids = (scene.solids ?? []).map((s, i) => ({
    id: s.id ?? `solid-${i}`,
    role: s.role ?? 'wall',
    min: s.min,
    max: s.max,
    label: s.label ?? s.id ?? `Solid ${i}`,
    ...(s.door ? { door: { kind: 'two-way', state: 'open', axis: 'x', allowedSign: 1, delay: 0, ...s.door } } : {}),
  }));
  scene.connectors = (scene.connectors ?? []).map((c, i) => ({
    id: c.id ?? `connector-${i}`,
    kind: c.kind ?? 'stairs',
    lower: c.lower,
    upper: c.upper,
    rect: c.rect,
    costFactor: c.costFactor ?? (c.kind === 'ramp' ? 1.3 : 2.0),
    label: c.label ?? c.id ?? `Connector ${i}`,
  }));
  scene.zones = (scene.zones ?? []).map((z, i) => ({
    id: z.id ?? `zone-${i}`,
    name: z.name ?? z.id ?? `Zone ${i}`,
    kind: z.kind ?? 'objective',
    floor: z.floor,
    rect: z.rect,
    priority: z.priority ?? 1,
    color: z.color ?? (z.kind === 'spawn' ? '#4fc3f7' : '#ffcc69'),
  }));
  return scene;
}

export function cloneScene(scene) {
  return JSON.parse(JSON.stringify(scene));
}

export function sceneHash(scene) {
  const sig = {
    revision: scene.revision,
    bounds: scene.bounds,
    cellSize: scene.cellSize,
    agent: scene.agent,
    floors: scene.floors.map((f) => ({
      id: f.id, y: f.y, rect: f.rect, holes: f.holes, slabThickness: f.slabThickness,
    })),
    solids: scene.solids.map((s) => ({
      id: s.id, role: s.role, min: s.min, max: s.max,
      door: s.door ? {
        kind: s.door.kind, state: s.door.state, axis: s.door.axis,
        allowedSign: s.door.allowedSign, delay: s.door.delay,
      } : undefined,
    })),
    connectors: scene.connectors.map((c) => ({
      id: c.id, kind: c.kind, lower: c.lower, upper: c.upper, rect: c.rect, costFactor: c.costFactor,
    })),
    zones: scene.zones.map((z) => ({
      id: z.id, kind: z.kind, floor: z.floor, rect: z.rect, priority: z.priority,
    })),
  };
  return hashString(JSON.stringify(sig)).toString(16).padStart(8, '0');
}

export function floorById(scene, id) {
  return scene.floors.find((f) => f.id === id) ?? null;
}

export function zoneById(scene, id) {
  return scene.zones.find((z) => z.id === id) ?? null;
}

export function spawnZones(scene) {
  return scene.zones.filter((z) => z.kind === 'spawn');
}

export function objectiveZones(scene) {
  return scene.zones.filter((z) => z.kind === 'objective').sort((a, b) => b.priority - a.priority);
}

export function solidById(scene, id) {
  return scene.solids.find((s) => s.id === id) ?? null;
}

export function doorSolids(scene) {
  return scene.solids.filter((s) => s.role === 'door' && s.door);
}

export function doorNormal(door) {
  return door.axis === 'x' ? [1, 0] : [0, 1];
}

export function doorCenter2(solid) {
  return [(solid.min[0] + solid.max[0]) / 2, (solid.min[2] + solid.max[2]) / 2];
}

export function doorPanelHalfExtent(solid, door) {
  if (door.axis === 'x') return (solid.max[2] - solid.min[2]) / 2;
  return (solid.max[0] - solid.min[0]) / 2;
}

// True when a movement from a->b crosses the door plane within its panel.
export function doorCrossing(solid, a, b, eps = 1e-6) {
  const door = solid.door;
  if (!door) return null;
  const n = doorNormal(door);
  const c = doorCenter2(solid);
  const sa = (a[0] - c[0]) * n[0] + (a[1] - c[1]) * n[1];
  const sb = (b[0] - c[0]) * n[0] + (b[1] - c[1]) * n[1];
  // Nodes can land exactly on the door plane; treat "on plane -> other side"
  // as a crossing so the direction filter is never silently skipped.
  const crosses = (sa < 0 && sb >= 0) || (sa >= 0 && sb < 0);
  if (!crosses) return null;
  let t = Math.abs(sa - sb) < eps ? 0.5 : sa / (sa - sb);
  t = Math.min(1, Math.max(0, t));
  const px = a[0] + (b[0] - a[0]) * t;
  const pz = a[1] + (b[1] - a[1]) * t;
  const tangent = door.axis === 'x' ? Math.abs(pz - c[1]) : Math.abs(px - c[0]);
  if (tangent > doorPanelHalfExtent(solid, door) + eps) return null;
  const sign = sb > sa ? 1 : -1;
  const open = (door.state ?? 'open') === 'open';
  const allowed = open && (door.kind === 'two-way' ? true : sign === door.allowedSign);
  return { t, point: [px, pz], sign, allowed, open };
}

export function doorBlocksNav(solid) {
  if (!solid.door) return true;
  if (solid.door.kind === 'one-way') return solid.door.state === 'closed';
  return solid.door.state !== 'open';
}

export function doorBlocksSight(solid) {
  if (!solid.door) return true;
  if (solid.door.kind === 'one-way') return true; // physical panel, even if passable one way
  return solid.door.state !== 'open';
}

export function solidBlocksAt(scene, floor, solid, x, z, agent = scene.agent) {
  if (!SOLID_ROLES.has(solid.role)) return false;
  if (solid.role === 'slab' || solid.role === 'decor') return false;
  if (solid.role === 'door' && !doorBlocksNav(solid)) return false;
  if (solid.role === 'railing') {
    // railings stop bodies but are low enough to see over
    if (solid.max[1] < floor.y + 0.2) return false;
  }
  const yLow = floor.y + 0.1;
  const yHigh = floor.y + agent.height;
  if (solid.max[1] <= yLow || solid.min[1] >= yHigh) return false;
  const r = agent.radius;
  return x >= solid.min[0] - r && x <= solid.max[0] + r &&
         z >= solid.min[2] - r && z <= solid.max[2] + r;
}

export function pointBlocked(scene, floor, x, z) {
  for (const s of scene.solids) {
    if (solidBlocksAt(scene, floor, s, x, z)) return s;
  }
  return null;
}

export function insideFloor(scene, floor, x, z, margin = 0) {
  if (!pointInRect2([x, z], {
    min: [floor.rect.min[0] + margin, floor.rect.min[1] + margin],
    max: [floor.rect.max[0] - margin, floor.rect.max[1] - margin],
  })) return false;
  for (const h of floor.holes) {
    if (pointInRect2([x, z], h)) {
      const inConnector = scene.connectors.some((c) =>
        (c.lower === floor.id || c.upper === floor.id) && pointInRect2([x, z], c.rect));
      if (!inConnector) return false;
    }
  }
  return true;
}

// Keeps a rect inside the floor footprint while avoiding holes unless a
// connector explicitly makes the opening walkable.
export function cellWalkable(scene, floor, x, z) {
  if (!insideFloor(scene, floor, x, z)) return false;
  return !pointBlocked(scene, floor, x, z);
}

export function footprintOf(solid) {
  return { min: [solid.min[0], solid.min[2]], max: [solid.max[0], solid.max[2]] };
}

export function segmentHitsSolid2D(scene, floor, a, b, ignoreDoorMembranes = true) {
  for (const s of scene.solids) {
    if (s.role === 'slab' || s.role === 'decor') continue;
    if (s.role === 'door' && ignoreDoorMembranes) continue;
    if (s.role === 'door' && doorBlocksNav(s)) {
      if (s.max[1] <= floor.y + 0.1 || s.min[1] >= floor.y + scene.agent.height) continue;
    }
    if (s.max[1] <= floor.y + 0.1 || s.min[1] >= floor.y + scene.agent.height) continue;
    const fp = footprintOf(s);
    const r = scene.agent.radius * 0.75;
    const expanded = { min: [fp.min[0] - r, fp.min[1] - r], max: [fp.max[0] + r, fp.max[1] + r] };
    const interval = segmentRectInterval2(a, b, expanded);
    if (interval && interval[1] - interval[0] > 1e-6) return s;
  }
  return null;
}

// Geometric free-run profile for a spawn: 16 horizontal rays plus headroom.
export function activityClearance(scene, floor, x, z, directions = 16) {
  const hits = [];
  let minFree = Infinity;
  const maxRay = Math.max(
    floor.rect.max[0] - floor.rect.min[0],
    floor.rect.max[1] - floor.rect.min[1],
  ) + 1;
  for (let i = 0; i < directions; i++) {
    const ang = (i / directions) * Math.PI * 2;
    const d = [Math.cos(ang), Math.sin(ang)];
    let best = maxRay;
    let bestSolid = null;
    let bestT = 1;
    for (const s of scene.solids) {
      if (s.role === 'slab' || s.role === 'decor') continue;
      if (s.role === 'door' && !doorBlocksNav(s)) continue;
      if (s.max[1] <= floor.y + 0.1 || s.min[1] >= floor.y + scene.agent.height) continue;
      // ray vs expanded footprint (AABB slab test in 2D)
      const r = scene.agent.radius;
      const fp = {
        min: [s.min[0] - r, s.min[2] - r],
        max: [s.max[0] + r, s.max[2] + r],
      };
      // Liang-Barsky against fp, direction only (t in [0,1] where endpoint distance = maxRay)
      const q = [x + d[0] * maxRay, z + d[1] * maxRay];
      const interval = segmentRectInterval2([x, z], q, fp);
      if (interval && interval[0] >= -1e-9) {
        const dist = interval[0] * maxRay;
        if (dist < best && dist > 1e-6) {
          best = dist;
          bestSolid = s.id;
          bestT = interval[0];
        }
      }
    }
    // floor boundary
    let boundary = maxRay;
    for (const [axis, sign] of [[0, 1], [0, -1], [1, 1], [1, -1]]) {
      const comp = d[axis];
      if (Math.abs(comp) < 1e-9) continue;
      const edge = axis === 0
        ? (sign > 0 ? floor.rect.max[0] : floor.rect.min[0])
        : (sign > 0 ? floor.rect.max[1] : floor.rect.min[1]);
      const t = (edge - (axis === 0 ? x : z)) / comp;
      if (t > 1e-6 && t < boundary) boundary = t;
    }
    const free = Math.min(best, boundary);
    if (free < minFree) minFree = free;
    hits.push({ dir: round(ang, 3), free: round(free, 3), solidId: bestSolid, t: round(Math.min(bestT, 1), 4) });
  }

  // headroom from floor slabs / solids directly above.
  let ceiling = Infinity;
  let ceilingId = null;
  for (const f of scene.floors) {
    if (f.y <= floor.y + 0.05) continue;
    if (pointInRect2([x, z], f.rect)) {
      const inHole = f.holes.some((h) => pointInRect2([x, z], h));
      if (!inHole && f.y - floor.y < ceiling) {
        ceiling = f.y - floor.y;
        ceilingId = `slab:${f.id}`;
      }
    }
  }
  for (const s of scene.solids) {
    if (s.role === 'slab') continue;
    if (s.min[1] <= floor.y + 0.05) continue;
    if (x >= s.min[0] - scene.agent.radius && x <= s.max[0] + scene.agent.radius &&
        z >= s.min[2] - scene.agent.radius && z <= s.max[2] + scene.agent.radius) {
      const h = s.min[1] - floor.y;
      if (h < ceiling) { ceiling = h; ceilingId = s.id; }
    }
  }
  const headroom = ceiling === Infinity ? null : ceiling - floor.y;
  const horizontal = Math.max(0, minFree - scene.agent.radius);
  return {
    radius: round(horizontal, 3),
    minFree: round(minFree, 3),
    headroom: headroom === null ? null : round(headroom, 3),
    ceilingId,
    hits,
    adequateHeadroom: headroom === null ? true : headroom >= scene.agent.height + 0.1,
  };
}

export function eyePoint(scene, floor, x, z) {
  return [x, floor.y + scene.agent.eyeHeight, z];
}

// 3D line of sight against walls, crates and floor slabs (holes respected).
export function lineOfSight(scene, a3, b3) {
  for (const s of scene.solids) {
    if (s.role === 'slab' || s.role === 'decor') continue;
    if (s.role === 'door' && !doorBlocksSight(s)) continue;
    if (s.role === 'railing' && s.max[1] - s.min[1] < scene.agent.eyeHeight * 0.7) continue;
    const interval = segmentAabbInterval3(a3, b3, s.min, s.max);
    if (interval && interval[1] - interval[0] > 1e-6) {
      return { blocked: true, by: s.id, kind: 'solid', t: round(interval[0], 4) };
    }
  }
  for (const f of scene.floors) {
    if (Math.abs(a3[1] - b3[1]) < 1e-6) continue;
    const slabMin = [f.rect.min[0], f.y - f.slabThickness, f.rect.min[1]];
    const slabMax = [f.rect.max[0], f.y, f.rect.max[1]];
    const interval = segmentAabbInterval3(a3, b3, slabMin, slabMax);
    if (!interval || interval[1] - interval[0] <= 1e-6) continue;
    const t = interval[0];
    const px = a3[0] + (b3[0] - a3[0]) * t;
    const pz = a3[2] + (b3[2] - a3[2]) * t;
    const inHole = f.holes.some((h) => pointInRect2([px, pz], h));
    if (!inHole) {
      return { blocked: true, by: `slab:${f.id}`, kind: 'slab', t: round(t, 4) };
    }
  }
  return { blocked: false, by: null, kind: null, t: null };
}

export function visibilityBetween(scene, floorA, pointA, floorB, pointB) {
  const eyeA = eyePoint(scene, floorA, pointA[0], pointA[1]);
  const eyeB = eyePoint(scene, floorB, pointB[0], pointB[1]);
  const los = lineOfSight(scene, eyeA, eyeB);
  return {
    visible: !los.blocked,
    eyeA,
    eyeB,
    blockedBy: los.by,
    blockedKind: los.kind,
    distance: round(Math.hypot(eyeA[0] - eyeB[0], eyeA[1] - eyeB[1], eyeA[2] - eyeB[2]), 3),
  };
}

export function floorEdgeInfo(scene, floor, x, z) {
  const dx = Math.min(x - floor.rect.min[0], floor.rect.max[0] - x);
  const dz = Math.min(z - floor.rect.min[1], floor.rect.max[1] - z);
  return round(Math.min(dx, dz), 3);
}

export function distance2D(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function nearestPointInRect(p, rect) {
  return [
    clamp(p[0], rect.min[0], rect.max[0]),
    clamp(p[1], rect.min[1], rect.max[1]),
  ];
}

export function zoneCenter(z) {
  return rectCenter2(z.rect);
}

export function distanceToZone(point, zone) {
  const q = nearestPointInRect(point, zone.rect);
  return distance2D(point, q);
}

export function sceneBoundsSummary(scene) {
  return {
    ...scene.bounds,
    diagonal: round(Math.hypot(
      scene.bounds.max[0] - scene.bounds.min[0],
      scene.bounds.max[2] - scene.bounds.min[2],
    ), 3),
  };
}

export function doorArrow(scene, solid) {
  const door = solid.door;
  const n = doorNormal(door);
  const sign = door.kind === 'two-way' ? 0 : door.allowedSign;
  const c = doorCenter2(solid);
  return { from: [c[0] - n[0] * sign * 0.8, c[1] - n[1] * sign * 0.8], to: [c[0] + n[0] * sign * 0.8, c[1] + n[1] * sign * 0.8] };
}

// Scene edits used by the editor and tests. They bump the revision so every
// candidate/evidence record can be recognized as stale.
export function flipDoor(scene, solidId) {
  const next = cloneScene(scene);
  const s = next.solids.find((x) => x.id === solidId);
  if (!s || !s.door) throw new Error(`No door solid "${solidId}"`);
  if (s.door.kind !== 'one-way') throw new Error(`Door "${solidId}" is not one-way`);
  s.door.allowedSign *= -1;
  next.revision = scene.revision + 1;
  return next;
}

export function setDoorState(scene, solidId, state) {
  const next = cloneScene(scene);
  const s = next.solids.find((x) => x.id === solidId);
  if (!s || !s.door) throw new Error(`No door solid "${solidId}"`);
  s.door.state = state;
  next.revision = scene.revision + 1;
  return next;
}

export function moveSolid(scene, solidId, delta) {
  const next = cloneScene(scene);
  const s = next.solids.find((x) => x.id === solidId);
  if (!s) throw new Error(`No solid "${solidId}"`);
  s.min = [s.min[0] + delta[0], s.min[1] + (delta[1] ?? 0), s.min[2] + delta[2]];
  s.max = [s.max[0] + delta[0], s.max[1] + (delta[1] ?? 0), s.max[2] + delta[2]];
  next.revision = scene.revision + 1;
  return next;
}

export function distancePointToSolid2D(p, solid) {
  const fp = footprintOf(solid);
  const q = nearestPointInRect(p, fp);
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}

export function nearestOccluder(scene, floor, p, maxDistance = Infinity) {
  let best = null;
  for (const s of scene.solids) {
    if (s.role === 'slab' || s.role === 'decor') continue;
    if (s.role === 'door' && !doorBlocksSight(s)) continue;
    if (s.max[1] <= floor.y + 0.1 || s.min[1] >= floor.y + scene.agent.height) continue;
    const d = distancePointToSolid2D(p, s);
    if (d <= maxDistance && (!best || d < best.distance)) {
      best = { solidId: s.id, role: s.role, distance: round(d, 3) };
    }
  }
  return best;
}

export function setupIssues(scene) {
  const issues = [];
  if (!scene.floors?.length) issues.push('Scene has no floors.');
  const floorIds = new Set((scene.floors ?? []).map((f) => f.id));
  for (const z of scene.zones ?? []) {
    if (!floorIds.has(z.floor)) issues.push(`Zone "${z.id}" references unknown floor "${z.floor}".`);
  }
  for (const c of scene.connectors ?? []) {
    if (!floorIds.has(c.lower) || !floorIds.has(c.upper)) {
      issues.push(`Connector "${c.id}" references unknown floor.`);
    }
  }
  for (const z of scene.zones ?? []) {
    for (const s of scene.solids) {
      if (s.role !== 'door' && s.role !== 'decor' && s.role !== 'slab') {
        const fp = footprintOf(s);
        if (fp.min[0] < z.rect.max[0] && fp.max[0] > z.rect.min[0] &&
            fp.min[1] < z.rect.max[1] && fp.max[1] > z.rect.min[1]) {
          issues.push(`Zone "${z.id}" overlaps solid "${s.id}".`);
        }
      }
    }
  }
  return issues;
}

export { norm2, distancePointSegment2 };
