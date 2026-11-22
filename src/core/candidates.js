import {
  activityClearance, floorById, zoneById, spawnZones, objectiveZones,
  zoneCenter, floorEdgeInfo, nearestOccluder, visibilityBetween, zoneById as _z,
} from './scene.js';
import { getNavGraph } from './nav.js';
import { round, mulberry32 } from './math.js';

// Deterministic candidate sampling inside a spawn zone. Points are walkable,
// horizontally clear and headroom-adequate; sampling is spread with a
// farthest-point pass so candidates are visibly distinct, not a random sprinkle
// weighted by Euclidean distance alone.
export function generateCandidates(scene, config, zone) {
  const nav = getNavGraph(scene);
  const floor = floorById(scene, zone.floor);
  if (!floor) return [];
  const inset = config.spawnInset ?? 0.6;
  const rect = {
    min: [zone.rect.min[0] + inset, zone.rect.min[1] + inset],
    max: [zone.rect.max[0] - inset, zone.rect.max[1] - inset],
  };
  if (rect.max[0] <= rect.min[0] || rect.max[1] <= rect.min[1]) return [];

  const spacing = config.sampleSpacing ?? 1.1;
  const raw = [];
  const nx = Math.max(1, Math.ceil((rect.max[0] - rect.min[0]) / spacing));
  const nz = Math.max(1, Math.ceil((rect.max[1] - rect.min[1]) / spacing));
  for (let ix = 0; ix <= nx; ix++) {
    for (let iz = 0; iz <= nz; iz++) {
      const x = rect.min[0] + (ix / nx) * (rect.max[0] - rect.min[0]);
      const z = rect.min[1] + (iz / nz) * (rect.max[1] - rect.min[1]);
      raw.push([x, z]);
    }
  }
  // Zone center always considered.
  const c = zoneCenter(zone);
  raw.push([c[0], c[1]]);

  const objectives = objectiveZones(scene);
  const seen = new Set();
  const evaluated = [];
  for (const [x, z] of raw) {
    const key = `${x.toFixed(2)},${z.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const clearance = activityClearance(scene, floor, x, z);
    const routes = objectives.map((oz) => nav.routeDetail(zone.floor, [x, z], oz));
    const reachableTo = objectives.filter((_, i) => routes[i].reachable);
    const primaryIdx = 0;
    const primary = routes[primaryIdx];
    const blockedReason =
      clearance.radius < (config.limits?.minClearance ?? 0.9)
        ? `initial clearance ${clearance.radius}m < ${config.limits?.minClearance ?? 0.9}m`
        : (clearance.headroom !== null && clearance.headroom < (config.limits?.minHeadroom ?? 2.0))
          ? `headroom ${clearance.headroom}m < ${config.limits?.minHeadroom ?? 2.0}m`
          : !primary?.reachable
            ? `primary objective unreachable (${primary?.reason ?? 'no route'})`
            : null;
    const nearEdge = floorEdgeInfo(scene, floor, x, z);
    if (!blockedReason && nearEdge < 0.5) {
      // still spawnable, but note it: edge-hugging spawns are fragile.
    }
    const occluder = nearestOccluder(scene, floor, [x, z], 3);
    evaluated.push({
      id: `${zone.id}@${x.toFixed(2)},${z.toFixed(2)}`,
      zoneId: zone.id,
      floorId: zone.floor,
      floorY: floor.y,
      pos: [round(x, 3), round(z, 3)],
      clearance,
      occluder,
      distanceToEdge: nearEdge,
      routes: objectives.map((oz, i) => ({
        zoneId: oz.id,
        reachable: routes[i].reachable,
        cost: Number.isFinite(routes[i].cost) ? round(routes[i].cost, 3) : null,
        length2D: Number.isFinite(routes[i].length2D) ? routes[i].length2D : null,
        ascent: routes[i].ascent ?? 0,
        connectors: routes[i].connectors ?? [],
        crossings: routes[i].crossings ?? [],
        waypoints: routes[i].points ?? null,
        pathIds: routes[i].path ?? null,
        reason: routes[i].reason ?? null,
      })),
      reachableTo: reachableTo.map((o) => o.id),
      blockedReason,
    });
  }

  const allowed = evaluated.filter((c) => !c.blockedReason);
  const rejected = evaluated.filter((c) => c.blockedReason);
  const picked = spreadPick(allowed, config.candidatesPerZone ?? 6, zone);
  // Candidates with route snap distances far from the requested point are
  // marked so the UI can show why the marker snaps when replayed.
  for (const cand of picked) {
    cand.evidence = buildCandidateEvidence(scene, floor, cand, objectives);
  }
  return { picked, rejected, poolSize: evaluated.length };
}

function spreadPick(list, k, zone) {
  if (list.length <= k) return [...list].sort((a, b) => b.clearance.radius - a.clearance.radius);
  const byClearance = [...list].sort((a, b) => b.clearance.radius - a.clearance.radius);
  const picked = [byClearance[0]];
  const remaining = new Set(list);
  remaining.delete(byClearance[0]);
  while (picked.length < k && remaining.size) {
    let best = null;
    for (const cand of remaining) {
      let minD = Infinity;
      for (const p of picked) {
        const d = Math.hypot(cand.pos[0] - p.pos[0], cand.pos[1] - p.pos[1]);
        if (d < minD) minD = d;
      }
      // Prefer spatial spread, break ties with clearance.
      const score = minD + cand.clearance.radius * 0.15;
      if (!best || score > best.score) best = { cand, score };
    }
    if (!best) break;
    picked.push(best.cand);
    remaining.delete(best.cand);
  }
  return picked;
}

function buildCandidateEvidence(scene, floor, cand, objectives) {
  const evidence = [];
  // Geometry source: radial clearance.
  const cl = cand.clearance;
  evidence.push({
    id: `${cand.id}:clearance`,
    source: 'geometry:clearance',
    kind: 'clearance',
    value: cl.radius,
    verdict: cl.adequacy ?? (cl.radius >= 0.9 ? 'adequate' : 'tight'),
    detail: `min free radius ${cl.radius}m over ${cl.hits.length} rays; headroom ${cl.headroom ?? 'open'}`,
    query: { type: 'radial-raycast', origin: cand.pos, floor: floor.id, rays: cl.hits.length },
  });
  // Navigation source: route to each objective.
  for (const route of cand.routes) {
    evidence.push({
      id: `${cand.id}:route:${route.zoneId}`,
      source: 'nav:path-cost',
      kind: 'route',
      value: route.cost,
      verdict: route.reachable ? 'reachable' : 'unreachable',
      detail: route.reachable
        ? `${route.cost} cost, ${route.length2D}m, ascent ${route.ascent}, doors ${route.crossings.map((c) => `${c.solidId}(${c.allowed ? 'ok' : 'blocked'})`).join(',') || 'none'}`
        : `no route (${route.reason})`,
      query: { type: 'nav-dijkstra', floor: floor.id, to: route.zoneId },
    });
  }
  // Sightline source: is the spawn itself visible from each objective?
  for (const oz of objectives) {
    const ozFloor = floorById(scene, oz.floor);
    const vis = visibilityBetween(scene, floor, cand.pos, ozFloor, zoneCenter(oz));
    evidence.push({
      id: `${cand.id}:sight:${oz.id}`,
      source: 'geometry:sightline',
      kind: 'visibility',
      value: vis.visible,
      verdict: vis.visible ? 'exposed' : 'concealed',
      detail: vis.visible
        ? `eye line clear to ${oz.id} over ${vis.distance}m`
        : `blocked by ${vis.blockedBy} (${vis.blockedKind})`,
      query: { type: 'segment-aabb-loS', from: vis.eyeA, to: vis.eyeB },
    });
  }
  return evidence;
}

// Pairwise sightline evidence, plus route exposure. When the sightline says
// "concealed" but route sampling says "exposed" (or the reverse) both records
// are kept and flagged as a conflict instead of being collapsed into one score.
export function pairEvidence(scene, candA, candB) {
  const floorA = floorById(scene, candA.floorId);
  const floorB = floorById(scene, candB.floorId);
  const sight = visibilityBetween(scene, floorA, candA.pos, floorB, candB.pos);
  const records = [];
  records.push({
    id: `${candA.id}|${candB.id}:spawn-sight`,
    source: 'geometry:sightline',
    kind: 'mutual-visibility',
    value: sight.visible,
    verdict: sight.visible ? 'visible' : 'hidden',
    detail: sight.visible
      ? `spawns see each other across ${sight.distance}m`
      : `spawns hidden by ${sight.blockedBy}`,
    query: { type: 'segment-aabb-LoS', from: sight.eyeA, to: sight.eyeB },
  });

  const primary = candA.routes[0];
  const exposure = routeExposure(scene, candA, floorB, candB.pos);
  records.push({
    id: `${candA.id}|${candB.id}:route-exposure`,
    source: 'geometry:route-exposure',
    kind: 'route-visibility',
    value: exposure.fraction,
    verdict: exposure.fraction >= 0.25 ? 'exposed' : 'covered',
    detail: `${Math.round(exposure.fraction * 100)}% of sampled route points have eye-line to the opposing spawn`,
    query: { type: 'route-sample-LoS', samples: exposure.samples, hit: exposure.hits },
  });

  const sightScore = sight.visible ? 0 : 1;          // concealment reward
  const routeScore = 1 - exposure.fraction;          // covered route reward
  const conflict = Math.abs(sightScore - routeScore) >= 0.5;
  return { sight, exposure, records, conflict, sightScore, routeScore };
}

export function routeExposure(scene, cand, opponentFloor, opponentPos) {
  const route = cand.routes[0];
  if (!route?.waypoints?.length) return { fraction: 1, samples: 0, hits: 0 };
  const pts = route.waypoints;
  const samples = [];
  const step = Math.max(1, Math.floor(pts.length / 10));
  for (let i = 0; i < pts.length; i += step) samples.push(pts[i]);
  let hits = 0;
  const eyeOpp = [opponentPos[0], opponentFloor.y + scene.agent.eyeHeight, opponentPos[1]];
  for (const p of samples) {
    const floor = floorById(scene, cand.floorId);
    const eye = [p[0], floor.y + scene.agent.eyeHeight, p[1]];
    const vis = visibilityBetween(scene, floor, p, opponentFloor, opponentPos);
    if (vis.visible) hits++;
  }
  return { fraction: samples.length ? hits / samples.length : 1, samples: samples.length, hits, eyeOpp };
}
