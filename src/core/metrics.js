import { activityClearance, floorById, visibilityBetween } from './scene.js';

// Canonical metric definitions. Every score or rejection in the planner must
// trace to one of these sources; the contract checker (src/core/contract.js)
// recomputes each one independently rather than trusting a stored number.
//
// Units:
//   path cost     seconds (distance / agent.speed + door delay, connector factor)
//   clearance     metres of free radius, and metres of headroom
//   visibility    boolean (line of sight) or a 0..1 fraction of route samples
export const METRIC_DEFINITIONS = {
  'nav:path-cost': {
    id: 'nav:path-cost',
    unit: 'seconds',
    meaning: 'Dijkstra travel time from the candidate to the objective zone centre, on the directed raster graph.',
    includes: ['walk distance / agent speed', 'one-way door direction filter', 'door delay', 'connector cost factor'],
    direction: 'candidate -> objective',
  },
  'geometry:clearance': {
    id: 'geometry:clearance',
    unit: 'metres',
    meaning: 'Radial free room around the candidate (16 rays) minus the agent radius, and vertical headroom.',
    includes: ['expanded solid footprints', 'floor boundary', 'floor slab ceilings', 'solid undersides'],
    direction: 'symmetric',
  },
  'geometry:sightline': {
    id: 'geometry:sightline',
    unit: 'boolean',
    meaning: 'True when the 3D eye-to-eye segment is unobstructed by solids or floor slabs (holes and low railings respected).',
    includes: ['walls', 'crates', 'blocks', 'closed doors / one-way panels', 'floor slabs'],
    direction: 'symmetric between the two eye points',
  },
  'geometry:route-exposure': {
    id: 'geometry:route-exposure',
    unit: 'fraction',
    meaning: 'Fraction of sampled points on one side\'s route whose eye point has a clear line of sight to the opposing spawn eye point.',
    includes: ['route waypoints', 'opposing spawn eye height', 'same occlusion rules as sightline'],
    direction: 'two separate records: A route seen from B spawn, and B route seen from A spawn',
  },
  'nav:door-neutral-control': {
    id: 'nav:door-neutral-control',
    unit: 'seconds',
    meaning: 'Route cost change when every one-way door is temporarily made two-way; an exclusive benefit belongs to one side only.',
    includes: ['rebuilt nav graph with neutral doors', 'per-side authored vs neutral cost'],
    direction: 'pair-level',
  },
};

// The composite score is a ranking preference. It never admits or rejects a
// pair, and it is not a fairness proof for any gameplay mode. Callers that want
// to rank may use it; callers that need a verdict must use the hard limits and
// the per-record evidence.
export const WEIGHT_APPLICABILITY = {
  acceptanceGating: false,
  fairnessProof: false,
  statement: 'Weights only reorder pairs that already passed every hard limit. Changing a weight cannot admit a rejected pair, reject an admitted pair, or prove that any gameplay mode is fair.',
  appliesTo: [
    'ordering of accepted pairs (scores.normalized)',
    'which pair the UI lists first',
  ],
  doesNotApplyTo: [
    'hard-limit rejection',
    'reachability',
    'door neutrality',
    'replay verdict',
    'fairness of the authored level',
  ],
  perMode: {
    fair: ['approachParity', 'concealment', 'clearance', 'routeExposure', 'spatialSpread'],
    chase: ['leadWindow', 'concealment', 'clearance', 'routeExposure', 'spatialSpread'],
  },
};

// Spatial clearance is symmetric and geomeasurement-only; it never depends on
// a route or a weight.
export function clearanceMetric(scene, floorId, point) {
  const floor = floorById(scene, floorId);
  if (!floor) return null;
  return activityClearance(scene, floor, point[0], point[1]);
}

// Eye-to-eye visibility between a candidate and another floor point.
export function sightlineMetric(scene, floorA, pointA, floorB, pointB) {
  return visibilityBetween(scene, floorA, pointA, floorB, pointB);
}

// Fraction of one candidate's primary route that its opponent spawn can see.
// Direction is explicit: `cand` supplies the route, `opponentPos` is the eye
// that does the looking. A symmetric scene yields equal values in both
// directions; a wall that shelters one lane makes them differ, and that
// difference is retained (not averaged away).
export function routeExposure(scene, cand, opponentFloor, opponentPos) {
  const route = cand.routes?.[0];
  if (!route?.waypoints?.length) {
    return { fraction: 1, samples: 0, hits: 0, points: [] };
  }
  const pts = route.waypoints;
  const step = Math.max(1, Math.floor(pts.length / 10));
  const samples = [];
  for (let i = 0; i < pts.length; i += step) samples.push(pts[i]);
  const floor = floorById(scene, cand.floorId);
  let hits = 0;
  const visiblePoints = [];
  for (const p of samples) {
    const vis = visibilityBetween(scene, floor, p, opponentFloor, opponentPos);
    if (vis.visible) {
      hits++;
      visiblePoints.push(p);
    }
  }
  return {
    fraction: samples.length ? hits / samples.length : 1,
    samples: samples.length,
    hits,
    points: visiblePoints,
  };
}

// Both directions at once. `a` is the fraction of A's route visible from B's
// spawn; `b` is the fraction of B's route visible from A's spawn.
export function pairExposure(scene, candA, candB) {
  const floorA = floorById(scene, candA.floorId);
  const floorB = floorById(scene, candB.floorId);
  return {
    a: routeExposure(scene, candA, floorB, candB.pos),
    b: routeExposure(scene, candB, floorA, candA.pos),
  };
}

// Who is chasing whom. The cheaper (faster) side arrives first and is the prey;
// the slower side is the pursuer. Pursuer visibility is the exposure of the
// prey's route as seen from the pursuer's spawn. When costs tie there is no
// pursuer, so use the more generous direction rather than rejecting on a
// technicality.
export function pursuerExposure(costA, costB, exposureA, exposureB) {
  if (!Number.isFinite(costA) || !Number.isFinite(costB) || Math.abs(costA - costB) < 1e-9) {
    return { prey: null, pursuer: null, fraction: Math.max(exposureA, exposureB) };
  }
  const prey = costA < costB ? 'A' : 'B';
  const pursuer = prey === 'A' ? 'B' : 'A';
  const fraction = pursuer === 'A' ? exposureA : exposureB;
  return { prey, pursuer, fraction };
}

// Whether a spawn-level sightline verdict and the route-exposure samples
// disagree enough that both must be shown rather than collapsed.
export function exposureConflict(sightVisible, exposureA, exposureB, threshold = 0.5) {
  const sightScore = sightVisible ? 0 : 1; // 1 = concealed
  const coverA = 1 - exposureA;
  const coverB = 1 - exposureB;
  return Math.abs(sightScore - coverA) >= threshold || Math.abs(sightScore - coverB) >= threshold;
}
