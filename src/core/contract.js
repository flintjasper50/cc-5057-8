import {
  activityClearance, floorById, zoneById, spawnZones, objectiveZones, sceneHash,
  cloneScene,
} from './scene.js';
import { getNavGraph, clearNavCache } from './nav.js';
import { pairEvidence } from './candidates.js';
import { pursuerExposure } from './metrics.js';
import { planSpawns, replayPair, resolveConfig } from './engine.js';

// The spawn-evaluation contract.
//
// Every number the planner reports must be reproducible from the scene by an
// independent query. This module re-derives each one — clearance, path cost,
// reachability, separation, sightline, directional exposure, door neutrality,
// replay arrival, score arithmetic, and the accept/reject decision itself —
// and returns a report that fails loudly on any mismatch. It never reads a
// hand-authored expectation: the only inputs are the live scene and the plan
// the engine just produced.
//
// A "misreport" is any of:
//   - a stored metric that differs from a fresh computation;
//   - an accepted pair that violates a hard limit;
//   - a rejected pair whose stated reason does not reproduce;
//   - a soft weight that changes the accept/reject set;
//   - a replay arrival that disagrees with the planner's route cost;
//   - an outcome label that does not match the actual failure mode.

const EPS = 1e-6;
const near = (a, b, tol = 1e-3) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

function freshNav(scene) {
  clearNavCache();
  return getNavGraph(scene);
}

export function checkPlan(scene, plan, options = {}) {
  const checks = [];
  const pass = (name, detail) => checks.push({ name, ok: true, detail });
  const fail = (name, detail) => checks.push({ name, ok: false, detail });
  const expect = (cond, name, detail) => (cond ? pass(name, detail) : fail(name, detail));

  if (!plan) {
    fail('plan-present', 'no plan to check');
    return summarize(checks, options);
  }

  // ---------------------------------------------------------------- identity
  expect(plan.sceneHash === sceneHash(scene), 'scene-hash-matches', `${plan.sceneHash}`);
  expect(plan.revision === scene.revision, 'revision-matches', `rev ${plan.revision} vs ${scene.revision}`);
  expect(plan.ok ? plan.outcome === 'success' : plan.outcome !== 'success',
    'outcome-matches-ok', `ok=${plan.ok} outcome=${plan.outcome}`);

  if (plan.outcome === 'invalid-scene') return finishInvalidScene(scene, plan, checks, expect);
  if (plan.outcome === 'no-candidates') return finishNoCandidates(scene, plan, checks, expect);

  const config = resolveConfig(plan.config ?? {});
  const nav = freshNav(scene);
  const primary = objectiveZones(scene)[0];
  const candidateById = collectCandidates(scene, plan, nav, config, primary, expect);

  for (const pair of plan.pairs ?? []) {
    const a = candidateById.get(pair.a);
    const b = candidateById.get(pair.b);
    if (!a || !b) { fail(`pair-candidates:${pair.id}`, 'candidate missing from zone reports'); continue; }
    checkAcceptedPair(scene, nav, config, primary, pair, a, b, expect);
  }

  for (const rej of plan.pairRejections ?? []) {
    const a = candidateById.get(rej.a);
    const b = candidateById.get(rej.b);
    if (!a || !b) { fail(`rejection-candidates:${rej.a}::${rej.b}`, 'candidate missing'); continue; }
    checkRejection(scene, nav, config, primary, rej, a, b, expect);
  }

  checkWeightsDoNotGate(scene, plan, config, expect);

  for (const pair of plan.pairs ?? []) checkReplay(scene, nav, config, primary, plan, pair, expect);
  for (const pair of plan.pairs ?? []) checkScoreArithmetic(pair, config, expect);

  return summarize(checks, options);
}

// --------------------------------------------------------------------- helpers

function collectCandidates(scene, plan, nav, config, primary, expect) {
  const map = new Map();
  for (const zr of plan.zoneReports ?? []) {
    const zone = zoneById(scene, zr.zoneId);
    expect(!!zone, `zone-exists:${zr.zoneId}`, zr.zoneId);
    const floor = zone ? floorById(scene, zone.floor) : null;
    for (const cand of zr.candidates) {
      map.set(cand.id, cand);
      const cl = activityClearance(scene, floor, cand.pos[0], cand.pos[1]);
      expect(near(cand.clearance.radius, cl.radius, 1e-3), `clearance:${cand.id}`,
        `stored ${cand.clearance.radius} vs fresh ${cl.radius}`);
      const route = cand.routes[0];
      const fresh = nav.routeDetail(cand.floorId, cand.pos, primary);
      expect(route.reachable === fresh.reachable, `reachable:${cand.id}`,
        `stored ${route.reachable} vs fresh ${fresh.reachable}`);
      if (route.reachable && fresh.reachable) {
        expect(near(route.cost, fresh.cost, 1e-2), `path-cost:${cand.id}`,
          `stored ${route.cost} vs fresh ${fresh.cost}`);
      }
      expect(!cand.blockedReason, `picked-not-blocked:${cand.id}`, cand.blockedReason ?? 'clean');
    }
    // Rejected positions must still be genuinely invalid on recompute.
    for (const rej of zr.candidatesRaw?.rejected ?? []) {
      const cl = activityClearance(scene, floor, rej.pos[0], rej.pos[1]);
      const fresh = nav.routeDetail(rej.floorId, rej.pos, primary);
      const clearanceBad = cl.radius < (config.limits?.minClearance ?? 0.9) - EPS;
      const headroomBad = cl.headroom !== null && cl.headroom < (config.limits?.minHeadroom ?? 2.0) - EPS;
      const unreachable = !fresh.reachable;
      expect(clearanceBad || headroomBad || unreachable, `rejected-position-justified:${rej.id}`,
        rej.blockedReason ?? 'no reason');
    }
    // A accepted count must match the picked list.
    expect(zr.accepted === zr.candidates.length, `zone-accepted-count:${zr.zoneId}`,
      `${zr.accepted} vs ${zr.candidates.length}`);
  }
  return map;
}

function measured(ctx) {
  const { costA, costB } = ctx;
  const delta = Math.abs(costA - costB);
  const rel = Number.isFinite(delta) ? delta / Math.min(costA, costB) : Infinity;
  return { delta, rel };
}

function checkAcceptedPair(scene, nav, config, primary, pair, a, b, expect) {
  const sep = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]);
  expect(near(pair.metrics.separation, sep, 1e-2), `pair-separation:${pair.id}`,
    `${pair.metrics.separation} vs ${sep.toFixed(3)}`);

  const routeA = nav.routeDetail(a.floorId, a.pos, primary);
  const routeB = nav.routeDetail(b.floorId, b.pos, primary);
  expect(near(pair.metrics.costA, routeA.cost, 1e-2), `pair-costA:${pair.id}`, `${pair.metrics.costA} vs ${routeA.cost}`);
  expect(near(pair.metrics.costB, routeB.cost, 1e-2), `pair-costB:${pair.id}`, `${pair.metrics.costB} vs ${routeB.cost}`);
  const { delta, rel } = measured({ costA: routeA.cost, costB: routeB.cost });
  expect(near(pair.metrics.delta, delta, 1e-2), `pair-delta:${pair.id}`, `${pair.metrics.delta} vs ${delta.toFixed(3)}`);

  const ev = pairEvidence(scene, a, b);
  expect(pair.mutualVisibility === ev.sight.visible, `pair-sight:${pair.id}`,
    `stored ${pair.mutualVisibility} vs fresh ${ev.sight.visible}`);
  expect(near(pair.visibility.exposureA, ev.exposure.a.fraction, 1e-2), `pair-exposureA:${pair.id}`,
    `${pair.visibility.exposureA} vs ${ev.exposure.a.fraction.toFixed(3)}`);
  expect(near(pair.visibility.exposureB, ev.exposure.b.fraction, 1e-2), `pair-exposureB:${pair.id}`,
    `${pair.visibility.exposureB} vs ${ev.exposure.b.fraction.toFixed(3)}`);

  const { limits } = config;
  if (limits.requireObjectiveReachable) {
    expect(routeA.reachable && routeB.reachable, `accepted-reachable:${pair.id}`, `${routeA.reachable}/${routeB.reachable}`);
  }
  expect(sep >= limits.minPairSeparation - EPS, `accepted-separation-min:${pair.id}`, `${sep.toFixed(2)} >= ${limits.minPairSeparation}`);
  expect(sep <= limits.maxPairSeparation + EPS, `accepted-separation-max:${pair.id}`, `${sep.toFixed(2)} <= ${limits.maxPairSeparation}`);

  if (config.mode === 'fair') {
    const violates = delta > limits.maxPathCostDelta && rel > limits.maxRelativeDelta;
    expect(!violates, `accepted-fair-delta:${pair.id}`, `delta ${delta.toFixed(3)} rel ${rel.toFixed(4)}`);
    if (limits.rejectOneWayFair) {
      expect((pair.advantage.oneWay?.exclusiveBenefit ?? 0) <= 1e-3, `accepted-oneway-neutral:${pair.id}`,
        `exclusive ${pair.advantage.oneWay?.exclusiveBenefit}`);
    }
    if (limits.rejectMutualVisibilityFair) {
      expect(!ev.sight.visible, `accepted-no-headon:${pair.id}`, `visible ${ev.sight.visible}`);
    }
  } else {
    const lo = Math.max(0, config.chase.leadSeconds - config.chase.leadToleranceSeconds);
    const hi = config.chase.leadSeconds + config.chase.leadToleranceSeconds;
    expect(delta >= lo - EPS && delta <= hi + EPS, `accepted-lead-window:${pair.id}`, `${delta.toFixed(3)} in [${lo}, ${hi}]`);
    const pursuit = pursuerExposure(routeA.cost, routeB.cost, ev.exposure.a.fraction, ev.exposure.b.fraction);
    expect(pursuit.fraction >= config.chase.minPursuitVisibility - EPS, `accepted-pursuit:${pair.id}`,
      `${pursuit.fraction.toFixed(3)} >= ${config.chase.minPursuitVisibility}`);
  }
}

function checkRejection(scene, nav, config, primary, rej, a, b, expect) {
  expect(rej.reasons?.length > 0, `rejection-has-reason:${rej.a}::${rej.b}`, `${rej.reasons?.length ?? 0}`);
  const routeA = nav.routeDetail(a.floorId, a.pos, primary);
  const routeB = nav.routeDetail(b.floorId, b.pos, primary);
  const ctx = {
    config, costA: routeA.cost, costB: routeB.cost,
    sep: Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]),
    routeA, routeB,
    ev: pairEvidence(scene, a, b),
  };
  ctx.pursuit = pursuerExposure(ctx.costA, ctx.costB, ctx.ev.exposure.a.fraction, ctx.ev.exposure.b.fraction);
  ctx.exclusive = oneWayExclusive(scene, primary, a, b, ctx.costA, ctx.costB);

  let anyHolds = false;
  for (const reason of rej.reasons) {
    const holds = reasonHolds(reason.code, ctx);
    anyHolds = anyHolds || holds;
    expect(holds, `rejection-holds:${rej.a}::${rej.b}:${reason.code}`, reason.detail);
  }
  expect(anyHolds, `rejection-justified:${rej.a}::${rej.b}`, rej.reasons.map((r) => r.code).join(','));
}

function reasonHolds(code, ctx) {
  const { config, routeA, routeB, sep } = ctx;
  const { delta, rel } = measured(ctx);
  switch (code) {
    case 'unreachable-side':
      return !routeA.reachable || !routeB.reachable;
    case 'too-close':
      return sep < config.limits.minPairSeparation - EPS;
    case 'too-far':
      return sep > config.limits.maxPairSeparation + EPS;
    case 'one-way-advantage':
      return ctx.exclusive > 1e-3;
    case 'unfair-cost-gap':
      return Number.isFinite(delta) && delta > config.limits.maxPathCostDelta && rel > config.limits.maxRelativeDelta;
    case 'head-on-visibility':
      return ctx.ev.sight.visible;
    case 'lead-out-of-window': {
      const lo = Math.max(0, config.chase.leadSeconds - config.chase.leadToleranceSeconds);
      const hi = config.chase.leadSeconds + config.chase.leadToleranceSeconds;
      return !(delta >= lo && delta <= hi);
    }
    case 'pursuer-cannot-find':
      return ctx.pursuit.fraction < config.chase.minPursuitVisibility - EPS;
    default:
      return false;
  }
}

// Independent one-way-exclusivity figure: rebuild the graph with each one-way
// door neutralised and take the largest per-side saving difference. This is a
// different code path from the engine's cached control, so agreement is real
// evidence rather than a shared bug.
function oneWayExclusive(scene, primary, a, b, costA, costB) {
  const doors = scene.solids.filter((s) => s.role === 'door' && s.door?.kind === 'one-way');
  let best = 0;
  for (const door of doors) {
    const neutral = cloneScene(scene);
    const nd = neutral.solids.find((x) => x.id === door.id);
    nd.door = { ...nd.door, kind: 'two-way', state: 'open' };
    const nav = getNavGraph(neutral);
    const ra = nav.routeDetail(a.floorId, a.pos, primary);
    const rb = nav.routeDetail(b.floorId, b.pos, primary);
    if (!ra.reachable || !rb.reachable) continue;
    best = Math.max(best, Math.abs((costA - ra.cost) - (costB - rb.cost)));
  }
  return best;
}

function checkWeightsDoNotGate(scene, plan, config, expect) {
  // maxPairs truncates the surfaced list, so a weight change can legitimately
  // reorder which accepted pairs appear. To isolate the property that matters —
  // weights never decide accept/reject — lift the truncation in both runs and
  // compare the complete accepted and rejected sets.
  const untruncated = { ...plan.config, maxPairs: 1e9 };
  const base = planSpawns(scene, untruncated);
  const perturbedWeights = {};
  for (const key of Object.keys(config.weights)) perturbedWeights[key] = config.weights[key] + 1.7;
  const perturbed = planSpawns(scene, { ...untruncated, weights: perturbedWeights });
  const sig = (p) => JSON.stringify({
    accepted: [...(p.acceptedPool ?? [])].sort(),
    rejections: (p.pairRejections ?? [])
      .map((r) => `${r.a}~${r.b}~${[...new Set(r.reasons.map((x) => x.code))].sort().join(',')}`)
      .sort(),
  });
  expect(sig(perturbed) === sig(base), 'weights-do-not-gate',
    'perturbing every weight changed the accepted pool or rejections');
  // The surfaced plan must be a ranked subset of the accepted pool.
  const accepted = new Set(base.acceptedPool ?? []);
  expect((plan.pairs ?? []).every((p) => accepted.has(p.id)), 'truncation-subset',
    'surfaced pair was not in the accepted pool');
}

function checkReplay(scene, nav, config, primary, plan, pair, expect) {
  const replay = replayPair(scene, plan, pair.id);
  for (const side of ['A', 'B']) {
    const cand = side === 'A' ? pair.candidates[0] : pair.candidates[1];
    const route = nav.routeDetail(cand.floorId, cand.pos, primary);
    expect(near(replay.sides[side].arrivalTime, route.cost, 0.05), `replay-arrival:${pair.id}:${side}`,
      `arrival ${replay.sides[side].arrivalTime} vs cost ${route.cost}`);
  }
  expect(near(replay.arrivalDelta, pair.metrics.delta, 0.05), `replay-delta:${pair.id}`,
    `replay ${replay.arrivalDelta} vs plan ${pair.metrics.delta}`);
  if (config.mode === 'fair') {
    const tol = config.limits.maxPathCostDelta + 0.25;
    const expected = replay.arrivalDelta <= tol ? 'accepted-fair' : 'rejected-by-replay';
    expect(replay.verdict === expected, `replay-verdict:${pair.id}`, replay.verdict);
  }
}

function checkScoreArithmetic(pair, config, expect) {
  const s = pair.scores;
  if (!s?.components?.length) { expect(false, `score-components:${pair.id}`, 'missing'); return; }
  let total = 0;
  let weightSum = 0;
  let weightsOk = true;
  for (const c of s.components) {
    if (config.weights[c.key] !== undefined && c.weight !== config.weights[c.key]) weightsOk = false;
    total += c.weight * c.score;
    weightSum += c.weight;
  }
  const expectedComponents = config.mode === 'fair'
    ? ['clearance', 'approachParity', 'concealment', 'routeExposure', 'spatialSpread']
    : ['clearance', 'leadWindow', 'concealment', 'routeExposure', 'spatialSpread'];
  expect(weightsOk, `score-weights:${pair.id}`, 'component weight differs from config');
  expect(near(s.weighted, total, 1e-3), `score-weighted:${pair.id}`, `${s.weighted} vs ${total.toFixed(4)}`);
  expect(near(s.normalized, weightSum ? total / weightSum : 0, 1e-3), `score-normalized:${pair.id}`,
    `${s.normalized} vs ${(weightSum ? total / weightSum : 0).toFixed(4)}`);
  expect(JSON.stringify(s.components.map((c) => c.key)) === JSON.stringify(expectedComponents),
    `score-mode-components:${pair.id}`, s.components.map((c) => c.key).join(','));
}

function finishInvalidScene(scene, plan, checks, expect) {
  if (plan.code === 'need-two-spawn-zones') {
    expect(spawnZones(scene).length < 2, 'invalid-scene-basis', `${spawnZones(scene).length} spawn zone(s)`);
  } else if (plan.code === 'no-objective') {
    expect(objectiveZones(scene).length === 0, 'invalid-scene-basis', 'no objective zone');
  }
  expect((plan.pairs?.length ?? 0) === 0, 'invalid-scene-no-pairs', 'no pairs claimed');
  return summarize(checks);
}

function finishNoCandidates(scene, plan, checks, expect) {
  const config = resolveConfig(plan.config ?? {});
  const nav = freshNav(scene);
  const primary = objectiveZones(scene)[0];
  let anyEmpty = false;
  for (const zr of plan.zoneReports ?? []) {
    if (zr.accepted !== 0) continue;
    anyEmpty = true;
    const zone = zoneById(scene, zr.zoneId);
    const floor = floorById(scene, zone.floor);
    const probe = probeZone(scene, nav, config, zone, floor, primary);
    expect(probe.every((p) => p.invalid), `no-candidates-basis:${zr.zoneId}`,
      `${probe.filter((p) => !p.invalid).length} valid position(s) found on recompute`);
  }
  expect(anyEmpty, 'no-candidates-outcome-basis', 'at least one empty zone');
  expect((plan.pairs?.length ?? 0) === 0, 'no-candidates-no-pairs', 'no pairs claimed');
  return summarize(checks);
}

// Re-samples the zone with the planner's own grid and only classifies validity;
// it does not reuse stored candidates.
function probeZone(scene, nav, config, zone, floor, primary) {
  const inset = config.spawnInset ?? 0.6;
  const rect = {
    min: [zone.rect.min[0] + inset, zone.rect.min[1] + inset],
    max: [zone.rect.max[0] - inset, zone.rect.max[1] - inset],
  };
  if (rect.max[0] <= rect.min[0] || rect.max[1] <= rect.min[1]) return [{ invalid: true }];
  const spacing = config.sampleSpacing ?? 1.1;
  const nx = Math.max(1, Math.ceil((rect.max[0] - rect.min[0]) / spacing));
  const nz = Math.max(1, Math.ceil((rect.max[1] - rect.min[1]) / spacing));
  const out = [];
  for (let ix = 0; ix <= nx; ix++) {
    for (let iz = 0; iz <= nz; iz++) {
      const x = rect.min[0] + (ix / nx) * (rect.max[0] - rect.min[0]);
      const z = rect.min[1] + (iz / nz) * (rect.max[1] - rect.min[1]);
      const cl = activityClearance(scene, floor, x, z);
      const route = nav.routeDetail(zone.floor, [x, z], primary);
      const clearanceBad = cl.radius < (config.limits?.minClearance ?? 0.9);
      const headroomBad = cl.headroom !== null && cl.headroom < (config.limits?.minHeadroom ?? 2.0);
      out.push({ invalid: clearanceBad || headroomBad || !route.reachable });
    }
  }
  return out;
}

function summarize(checks, options = {}) {
  const failures = checks.filter((c) => !c.ok);
  return {
    ok: failures.length === 0,
    total: checks.length,
    passed: checks.length - failures.length,
    failed: failures.length,
    failures,
    checks: options.verbose ? checks : undefined,
    generatedAt: new Date().toISOString(),
  };
}

// Convenience for scripts/tests: plan a scene and check it in one call.
export function checkScene(scene, config, options = {}) {
  const plan = planSpawns(scene, config);
  return { plan, report: checkPlan(scene, plan, options) };
}
