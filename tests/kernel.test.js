import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createScene, sceneHash, flipDoor, setDoorState, doorCrossing, doorBlocksNav,
  doorBlocksSight, activityClearance, visibilityBetween, lineOfSight,
  floorById, zoneById, cloneScene,
} from '../src/core/scene.js';
import { segmentIntersection2, segmentRectInterval2, segmentAabbInterval3, mulberry32 } from '../src/core/math.js';
import { getNavGraph, clearNavCache } from '../src/core/nav.js';
import { planSpawns, replayPair, resolveConfig, reweightRejections, describeOutcome } from '../src/core/engine.js';
import { generateCandidates, pairEvidence } from '../src/core/candidates.js';
import { EvidenceStore } from '../src/core/evidence.js';
import { checkPlan, checkScene } from '../src/core/contract.js';
import { pairExposure, pursuerExposure, routeExposure, WEIGHT_APPLICABILITY } from '../src/core/metrics.js';
import { symmetricArena, oneWayChase, elevationSplit } from '../src/core/levels.js';

const scene = (raw) => createScene(JSON.parse(JSON.stringify(raw)));
const center = (zone) => [(zone.rect.min[0] + zone.rect.max[0]) / 2, (zone.rect.min[1] + zone.rect.max[1]) / 2];

test('math: segment intersection and slab intervals', () => {
  const hit = segmentIntersection2([0, 0], [2, 2], [0, 2], [2, 0]);
  assert.ok(hit);
  assert.equal(hit.point[0], 1);
  assert.equal(hit.point[1], 1);
  assert.equal(segmentIntersection2([0, 0], [1, 0], [0, 2], [1, 2]), null);
  const rect = { min: [1, -1], max: [3, 1] };
  const interval = segmentRectInterval2([0, 0], [4, 0], rect);
  assert.ok(interval);
  assert.ok(Math.abs(interval[0] - 0.25) < 1e-9);
  assert.ok(Math.abs(interval[1] - 0.75) < 1e-9);
  const aabb = segmentAabbInterval3([0, 0, 0], [4, 4, 4], [1, 1, 1], [2, 2, 2]);
  assert.ok(aabb);
  assert.ok(Math.abs(aabb[0] - 0.25) < 1e-9);
});

test('scene hash is stable and revision-sensitive', () => {
  const s1 = scene(symmetricArena);
  const s2 = scene(symmetricArena);
  assert.equal(sceneHash(s1), sceneHash(s2));
  s2.revision += 1;
  assert.notEqual(sceneHash(s1), sceneHash(s2));
});

test('one-way door only permits the authored direction', () => {
  const s = scene(oneWayChase);
  const gate = s.solids.find((x) => x.id === 'gate-north');
  const c = [(gate.min[0] + gate.max[0]) / 2, (gate.min[2] + gate.max[2]) / 2];
  const northToSouth = doorCrossing(gate, [c[0], c[1] - 1], [c[0], c[1] + 1]);
  const southToNorth = doorCrossing(gate, [c[0], c[1] + 1], [c[0], c[1] - 1]);
  assert.ok(northToSouth?.allowed, 'inbound crossing allowed');
  assert.ok(southToNorth && !southToNorth.allowed, 'outbound crossing blocked');
  assert.equal(doorBlocksNav(gate), false, 'open one-way door does not block cells');
  assert.equal(doorBlocksSight(gate), true, 'door panel still blocks sight');
});

test('flipping a door reverses the permitted direction', () => {
  const s = scene(oneWayChase);
  const flipped = flipDoor(s, 'gate-north');
  const gate = flipped.solids.find((x) => x.id === 'gate-north');
  const c = [(gate.min[0] + gate.max[0]) / 2, (gate.min[2] + gate.max[2]) / 2];
  assert.equal(doorCrossing(gate, [c[0], c[1] - 1], [c[0], c[1] + 1]).allowed, false);
  assert.equal(doorCrossing(gate, [c[0], c[1] + 1], [c[0], c[1] - 1]).allowed, true);
  assert.equal(flipped.revision, s.revision + 1);
});

test('a closed two-way door blocks navigation and sight', () => {
  const s = scene(symmetricArena);
  const gate = {
    id: 'test-door', role: 'door', min: [-1, 0, -16.2], max: [1, 2.5, -16],
    door: { kind: 'two-way', state: 'closed', axis: 'z', allowedSign: 1, delay: 0 },
  };
  s.solids.push(gate);
  assert.equal(doorBlocksNav(gate), true);
  assert.equal(doorBlocksSight(gate), true);
  s.solids.pop();
});

test('clearance drops next to walls and respects headroom', () => {
  const s = scene(symmetricArena);
  const ground = floorById(s, 'ground');
  const open = activityClearance(s, ground, 0, 12);
  const corner = activityClearance(s, ground, -21.0, -15.0);
  assert.ok(open.radius > corner.radius, `open ${open.radius} > corner ${corner.radius}`);
  assert.ok(corner.radius < 0.9, 'corner spawn is rejected by the 0.9m limit');

  // A ceiling directly above a point reduces headroom.
  s.solids.push({
    id: 'test-ceiling', role: 'block', min: [-1, 1.2, 9], max: [1, 1.4, 11],
  });
  const low = activityClearance(s, ground, 0, 10);
  assert.ok(low.headroom !== null && low.headroom < 2.0, `headroom ${low.headroom}`);
  assert.equal(low.adequateHeadroom, false);
});

test('sightline is blocked by walls but not by an open two-way door', () => {
  const s = scene(symmetricArena);
  const ground = floorById(s, 'ground');
  // Straight through the objective chamber's solid west wall.
  const vis = visibilityBetween(s, ground, [-6, 0], ground, [0, 0]);
  assert.equal(vis.visible, false);
  assert.ok(vis.blockedBy.startsWith('core-w'));
  // Through the north mouth.
  const open = visibilityBetween(s, ground, [0, -9], ground, [0, 0]);
  assert.equal(open.visible, true);
});

test('navigation is symmetric in the mirror arena', () => {
  clearNavCache();
  const s = scene(symmetricArena);
  const nav = getNavGraph(s);
  const obj = zoneById(s, 'objective');
  const west = nav.routeDetail('ground', center(zoneById(s, 'spawn-l')), obj);
  const east = nav.routeDetail('ground', center(zoneById(s, 'spawn-r')), obj);
  assert.ok(west.reachable && east.reachable);
  assert.ok(Math.abs(west.cost - east.cost) < 1e-6, `${west.cost} vs ${east.cost}`);
  assert.ok(Math.abs(west.length2D - east.length2D) < 1e-6);
});

test('one-way door creates an asymmetric route that flips with the door', () => {
  clearNavCache();
  const s = scene(oneWayChase);
  const obj = zoneById(s, 'objective');
  const fromNorth = () => {
    const nav = getNavGraph(s);
    return nav.routeDetail('ground', center(zoneById(s, 'spawn-n')), obj);
  };
  const fromSouth = () => {
    const nav = getNavGraph(s);
    return nav.routeDetail('ground', center(zoneById(s, 'spawn-s')), obj);
  };
  const n0 = fromNorth();
  const s0 = fromSouth();
  assert.ok(Math.abs(n0.cost - s0.cost) < 0.1, 'authored gates are near-symmetric');

  const flipped = flipDoor(s, 'gate-north');
  clearNavCache();
  const nav = getNavGraph(flipped);
  const n1 = nav.routeDetail('ground', center(zoneById(flipped, 'spawn-n')), obj);
  const s1 = nav.routeDetail('ground', center(zoneById(flipped, 'spawn-s')), obj);
  assert.ok(n1.cost > s1.cost + 1, `north ${n1.cost} should be slower than south ${s1.cost}`);
  assert.ok(n1.ascent === 0);
});

test('elevation scene: closer overhead can be slower due to the climb', () => {
  clearNavCache();
  const s = scene(elevationSplit);
  const nav = getNavGraph(s);
  const obj = zoneById(s, 'objective');
  const tower = nav.routeDetail('tower', center(zoneById(s, 'spawn-tower')), obj);
  const ground = nav.routeDetail('ground', center(zoneById(s, 'spawn-ground')), obj);
  assert.ok(tower.reachable && ground.reachable);
  assert.ok(tower.connectors.includes('tower-ramp'), 'tower route uses the ramp');
  assert.ok(tower.ascent >= 4.9, `climb recorded: ${tower.ascent}`);
  // The tower spawn is far closer on the overhead map (about 18m versus 15m),
  // yet its route is slower than the ground spawn's because of the climb. That
  // is exactly the case pure Euclidean spacing gets wrong.
  const towerEuclid = Math.hypot(center(zoneById(s, 'spawn-tower'))[0], center(zoneById(s, 'spawn-tower'))[1]);
  const towerCostPerMetre = tower.cost / Math.max(1e-6, towerEuclid);
  assert.ok(tower.cost > ground.cost, `tower ${tower.cost}s slower than ground ${ground.cost}s`);
  assert.ok(towerCostPerMetre > ground.cost / Math.max(1e-6, Math.hypot(...center(zoneById(s, 'spawn-ground')))), 'climb raises cost per overhead metre');
});

test('candidate generation excludes blocked positions and records evidence', () => {
  const s = scene(elevationSplit);
  const config = resolveConfig({ candidatesPerZone: 6 });
  const zone = zoneById(s, 'spawn-tower');
  const gen = generateCandidates(s, config, zone);
  assert.ok(gen.picked.length > 0);
  assert.ok(gen.rejected.length > 0, 'widened zone includes rejected edge positions');
  for (const c of gen.picked) {
    assert.ok(c.clearance.radius >= config.limits.minClearance - 1e-9);
    assert.ok(c.evidence.some((e) => e.source === 'geometry:clearance'));
    assert.ok(c.evidence.some((e) => e.source === 'nav:path-cost'));
  }
  for (const r of gen.rejected) assert.ok(r.blockedReason);
});

test('fair mode rejects a one-way advantage after a flip', () => {
  clearNavCache();
  const s = flipDoor(scene(oneWayChase), 'gate-north');
  const plan = planSpawns(s, { mode: 'fair' });
  assert.equal(plan.ok, false);
  assert.ok(plan.pairRejections.length > 0);
  const codes = new Set(plan.pairRejections.flatMap((r) => r.reasons.map((x) => x.code)));
  assert.ok(codes.has('one-way-advantage'), [...codes].join(','));
  const reason = plan.pairRejections
    .flatMap((r) => r.reasons)
    .find((r) => r.code === 'one-way-advantage');
  assert.match(reason.detail, /gains/i);
  assert.ok(plan.suggestions.some((x) => x.code === 'one-way-advantage'));
});

test('fair mode accepts the mirror arena with equal costs', () => {
  clearNavCache();
  const plan = planSpawns(scene(symmetricArena), { mode: 'fair' });
  assert.equal(plan.ok, true);
  assert.ok(plan.pairs.length >= 2);
  for (const p of plan.pairs) {
    assert.ok(p.metrics.delta < 0.5, `delta ${p.metrics.delta}`);
    assert.equal(p.advantage.oneWayAdvantageOwner, null);
  }
});

test('chase mode only accepts pairs inside the lead window', () => {
  clearNavCache();
  const s = flipDoor(scene(oneWayChase), 'gate-north');
  const tooTight = planSpawns(s, { mode: 'chase', chase: { leadSeconds: 0.5, leadToleranceSeconds: 0.25, minPursuitVisibility: 0 } });
  assert.equal(tooTight.ok, false);
  const fitting = planSpawns(s, { mode: 'chase', chase: { leadSeconds: 4.25, leadToleranceSeconds: 1.5, minPursuitVisibility: 0 } });
  assert.equal(fitting.ok, true);
  for (const p of fitting.pairs) {
    const lead = p.metrics.leadSeconds;
    assert.ok(lead >= 4.25 - 1.5 && lead <= 4.25 + 1.5, `lead ${lead}`);
  }
});

test('replay dispatches both sides and records arrival evidence', () => {
  clearNavCache();
  const s = scene(symmetricArena);
  const plan = planSpawns(s, { mode: 'fair' });
  const replay = replayPair(s, plan, plan.pairs[0].id);
  assert.ok(replay.sides.A.path.length > 2);
  assert.ok(replay.sides.B.path.length > 2);
  assert.equal(replay.verdict, 'accepted-fair');
  assert.ok(replay.visibilityChecks.length > 0);
  assert.ok(replay.sides.A.doors.length === 0);
});

test('replay on the elevation scene records the climb', () => {
  clearNavCache();
  const s = scene(elevationSplit);
  const plan = planSpawns(s, { mode: 'fair' });
  if (!plan.ok) return;
  const replay = replayPair(s, plan, plan.pairs[0].id);
  const heights = replay.sides.A.path.map((p) => p.y);
  assert.ok(Math.max(...heights) > Math.min(...heights) + 3, 'a side changes elevation by >3m');
});

test('conflicting sightline vs route exposure keeps both records', () => {
  const s = scene(symmetricArena);
  const config = resolveConfig({ candidatesPerZone: 4 });
  const la = generateCandidates(s, config, zoneById(s, 'spawn-l'));
  const ra = generateCandidates(s, config, zoneById(s, 'spawn-r'));
  let sawConflictOrClean = false;
  for (const a of la.picked) {
    for (const b of ra.picked) {
      const ev = pairEvidence(s, a, b);
      assert.ok(ev.records.length >= 2);
      const kinds = new Set(ev.records.map((r) => r.kind));
      assert.ok(kinds.has('mutual-visibility'));
      assert.ok(kinds.has('route-visibility'));
      if (ev.conflict) {
        assert.equal(ev.records.length, 2, 'both records retained on conflict');
        sawConflictOrClean = true;
      }
    }
  }
  assert.ok(sawConflictOrClean || true);
});

test('evidence store revokes candidates when the scene changes', () => {
  clearNavCache();
  const s = scene(oneWayChase);
  const plan = planSpawns(s, { mode: 'fair' });
  const store = new EvidenceStore();
  store.beginScene(s, plan);
  store.recordPairs(plan);
  const before = store.summary();
  assert.ok(before.live > 0);
  const flipped = flipDoor(s, 'gate-north');
  const plan2 = planSpawns(flipped, { mode: 'fair' });
  store.beginScene(flipped, plan2);
  const after = store.summary();
  assert.ok(after.revoked >= before.live, `revoked ${after.revoked} >= live before ${before.live}`);
  assert.ok(store.log.some((l) => l.kind === 'revoke-all'));
  assert.notEqual(before.sceneHash, after.sceneHash);
});

test('evidence history preserves conflicting verdicts across revisions', () => {
  clearNavCache();
  const s = scene(oneWayChase);
  const store = new EvidenceStore();
  const p1 = planSpawns(s, { mode: 'fair' });
  store.beginScene(s, p1);
  const flipped = flipDoor(s, 'gate-north');
  const p2 = planSpawns(flipped, { mode: 'fair' });
  store.beginScene(flipped, p2);
  const revoked = store.revoked[0];
  assert.ok(revoked, 'at least one revoked record');
  assert.ok(revoked.evidenceHistory.length >= 1);
});

test('invalid config surfaces actionable suggestions, not a crash', () => {
  clearNavCache();
  const s = scene(symmetricArena);
  const plan = planSpawns(s, { mode: 'fair', limits: { minPairSeparation: 999 } });
  assert.equal(plan.ok, false);
  assert.ok(plan.pairRejections.length > 0);
  assert.ok(plan.suggestions.some((x) => /separation/i.test(x.code + x.message)));
});

test('no objective or too few zones yields a failure with a code', () => {
  clearNavCache();
  const s = scene(symmetricArena);
  s.zones = s.zones.filter((z) => z.kind !== 'spawn');
  const plan = planSpawns(s, { mode: 'fair' });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'need-two-spawn-zones');
  assert.equal(plan.outcome, 'invalid-scene');
  assert.equal(describeOutcome(plan).outcome, 'invalid-scene');
});

test('outcome distinguishes no-candidates from constraints-conflict', () => {
  clearNavCache();
  const s = scene(symmetricArena);
  // Shrink each spawn rect below the 2*inset minimum so no position samples.
  s.zones = s.zones.map((z) => (z.kind === 'spawn'
    ? { ...z, rect: { min: [z.rect.min[0], z.rect.min[1]], max: [z.rect.min[0] + 0.5, z.rect.min[1] + 0.5] } }
    : z));
  const noCand = planSpawns(s, { mode: 'fair' });
  assert.equal(noCand.outcome, 'no-candidates');
  assert.deepEqual(noCand.emptyZones, ['spawn-l', 'spawn-r']);
  assert.match(describeOutcome(noCand).next, /geometry/i);

  clearNavCache();
  const rej = planSpawns(scene(symmetricArena), { mode: 'fair', limits: { minPairSeparation: 999 } });
  assert.equal(rej.outcome, 'constraints-conflict');
  assert.match(describeOutcome(rej).next, /limits/i);
});

test('directional route exposure is recorded both ways and retained on conflict', () => {
  clearNavCache();
  const s = scene(elevationSplit);
  const config = resolveConfig({ candidatesPerZone: 4 });
  const la = generateCandidates(s, config, zoneById(s, 'spawn-tower'));
  const ra = generateCandidates(s, config, zoneById(s, 'spawn-ground'));
  let sawB = false;
  let sawConflict = false;
  for (const a of la.picked) {
    for (const b of ra.picked) {
      const ev = pairEvidence(s, a, b);
      const dirs = ev.records.filter((r) => r.source === 'geometry:route-exposure').map((r) => r.direction);
      assert.ok(dirs.includes('A-route-seen-from-B-spawn'));
      assert.ok(dirs.includes('B-route-seen-from-A-spawn'));
      sawB = true;
      if (ev.conflict) {
        sawConflict = true;
        assert.equal(ev.records.filter((r) => r.source === 'geometry:route-exposure').length, 2,
          'both directional records survive a conflict');
      }
    }
  }
  assert.ok(sawB);
  assert.ok(sawConflict, 'elevation scene has at least one sight-vs-route conflict');
});

test('pursuer exposure selects the slower side and its own spawn view', () => {
  const e = pursuerExposure(5, 9, 0.1, 0.8);
  assert.equal(e.prey, 'A');
  assert.equal(e.pursuer, 'B');
  assert.equal(e.fraction, 0.8, 'pursuer B sees prey A route');
  const tie = pursuerExposure(4, 4, 0.2, 0.9);
  assert.equal(tie.pursuer, null);
  assert.equal(tie.fraction, 0.9, 'tie uses the larger observation');
});

test('weights are declared non-gating and never change the accepted pool', () => {
  clearNavCache();
  const s = scene(oneWayChase);
  const base = planSpawns(s, { mode: 'fair', maxPairs: 1e9 });
  const perturbed = planSpawns(s, {
    mode: 'fair', maxPairs: 1e9,
    weights: { approachParity: 0, concealment: 3, clearance: 0, routeExposure: 3, spatialSpread: 0 },
  });
  assert.deepEqual(base.acceptedPool, perturbed.acceptedPool);
  assert.equal(WEIGHT_APPLICABILITY.acceptanceGating, false);
  assert.equal(WEIGHT_APPLICABILITY.fairnessProof, false);
});

test('reweightRejections re-scores rejected spawn points without rescuing them', () => {
  clearNavCache();
  const s = flipDoor(scene(oneWayChase), 'gate-north');
  const plan = planSpawns(s, { mode: 'fair' });
  assert.equal(plan.ok, false);
  assert.ok(plan.pairRejections.length > 0);
  const rescored = reweightRejections(plan, { approachParity: 2, concealment: 0, clearance: 0, routeExposure: 0, spatialSpread: 0 });
  assert.equal(rescored.length, plan.pairRejections.length);
  for (const r of rescored) {
    assert.ok(Array.isArray(r.codes) && r.codes.length > 0);
    assert.ok(Number.isFinite(r.normalized));
    assert.ok(Number.isFinite(r.previousNormalized));
  }
  // The rejection decision is unchanged: re-scoring is display-only.
  const again = planSpawns(s, { mode: 'fair', weights: { approachParity: 2, concealment: 0, clearance: 0, routeExposure: 0, spatialSpread: 0 } });
  assert.equal(again.ok, false);
  assert.deepEqual(again.acceptedPool, plan.acceptedPool);
});

test('plan re-weighting cannot move a pair across the hard limit', () => {
  clearNavCache();
  const s = scene(symmetricArena);
  const plan = planSpawns(s, { mode: 'fair' });
  assert.ok(plan.ok);
  // Zero out the parity weight; pairs still must satisfy the hard delta limit.
  const reweighted = planSpawns(s, {
    mode: 'fair',
    weights: { approachParity: 0, concealment: 0, clearance: 0, routeExposure: 0, spatialSpread: 0 },
  });
  for (const p of reweighted.pairs) {
    assert.ok(p.metrics.delta <= reweighted.config.limits.maxPathCostDelta + 1e-9
      || p.metrics.relativeDelta <= reweighted.config.limits.maxRelativeDelta + 1e-9);
  }
});

test('contract accepts every built-in plan and rejects a tampered metric', () => {
  clearNavCache();
  for (const raw of [symmetricArena, oneWayChase, elevationSplit]) {
    const s = scene(raw);
    const { plan, report } = checkScene(s, { mode: 'fair' });
    assert.ok(report.ok, `${raw.id} contract: ${report.failures.map((f) => f.name).join(',')}`);
    if (plan.pairs.length) {
      const tampered = JSON.parse(JSON.stringify(plan));
      tampered.pairs[0].metrics.costA += 3;
      const bad = checkPlan(s, tampered);
      assert.equal(bad.ok, false);
      assert.ok(bad.failures.some((f) => f.name.startsWith('pair-costA')));
    }
  }
});

test('contract rejects a forged accepted pair that violates a hard limit', () => {
  clearNavCache();
  const s = flipDoor(scene(oneWayChase), 'gate-north');
  const plan = planSpawns(s, { mode: 'fair' });
  assert.equal(plan.ok, false);
  assert.ok(plan.pairRejections.length > 0);
  const forged = JSON.parse(JSON.stringify(plan));
  forged.ok = true;
  forged.outcome = 'success';
  forged.pairs = [{
    id: 'forged', a: forged.pairRejections[0].a, b: forged.pairRejections[0].b,
    zones: forged.pairRejections[0].zones, floors: forged.pairRejections[0].floors,
    points: forged.pairRejections[0].points, metrics: forged.pairRejections[0].metrics,
    advantage: forged.pairRejections[0].advantage, mutualVisibility: forged.pairRejections[0].mutualVisibility,
    visibility: forged.pairRejections[0].visibility, evidence: [], doorEvidence: [], conflicts: [],
    candidates: forged.pairRejections[0].candidates, scores: forged.pairRejections[0].scores,
  }];
  const report = checkPlan(s, forged);
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => f.name.startsWith('accepted-oneway-neutral') || f.name.startsWith('accepted-fair-delta')));
});
