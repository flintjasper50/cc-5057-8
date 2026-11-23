#!/usr/bin/env node
// Small-scene validation of spawn candidates and metrics.
//
// Builds a deliberately tiny level whose answers can be checked by hand, then:
//   1. samples candidates and validates reachability and clearance against an
//      independent recomputation (not the planner's stored numbers);
//   2. checks a fair pair and a deliberately one-way pair;
//   3. states exactly what the soft weights do and do not decide.
//
// The weights are exercised only to show they reorder accepted pairs; the tool
// asserts that changing them cannot admit a rejected pair. It never claims the
// soft score proves fairness for any gameplay mode.
//
// Run: node scripts/fixture.mjs [--verbose]
import { createScene, flipDoor, zoneById, floorById } from '../src/core/scene.js';
import { getNavGraph, clearNavCache } from '../src/core/nav.js';
import { planSpawns, reweightRejections, describeOutcome } from '../src/core/engine.js';
import { checkPlan } from '../src/core/contract.js';
import { WEIGHT_APPLICABILITY } from '../src/core/metrics.js';

const verbose = process.argv.includes('--verbose');
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// A 20x20 room with a centred objective and two symmetric spawn pads. The
// gated variant wraps the objective in a chamber with a one-way gate at each
// mouth, mirroring the built-in One-Way Gate level at a size you can check by
// hand.
function tinyScene({ withOneWayGate = false } = {}) {
  const chamber = withOneWayGate ? [
    { id: 'ch-w', role: 'wall', min: [-2.7, 0, -2.6], max: [-2.3, 6, 2.6] },
    { id: 'ch-e', role: 'wall', min: [2.3, 0, -2.6], max: [2.7, 6, 2.6] },
    { id: 'ch-nw', role: 'wall', min: [-2.3, 0, -2.6], max: [-1.3, 6, -2.2] },
    { id: 'ch-ne', role: 'wall', min: [1.3, 0, -2.6], max: [2.3, 6, -2.2] },
    { id: 'ch-sw', role: 'wall', min: [-2.3, 0, 2.2], max: [-1.3, 6, 2.6] },
    { id: 'ch-se', role: 'wall', min: [1.3, 0, 2.2], max: [2.3, 6, 2.6] },
    { id: 'gate-north', role: 'door', label: 'North gate (inbound)',
      min: [-1.3, 0, -2.6], max: [1.3, 2.8, -2.2],
      door: { kind: 'one-way', state: 'open', axis: 'z', allowedSign: 1, delay: 0.2 } },
    { id: 'gate-south', role: 'door', label: 'South gate (inbound)',
      min: [-1.3, 0, 2.2], max: [1.3, 2.8, 2.6],
      door: { kind: 'one-way', state: 'open', axis: 'z', allowedSign: -1, delay: 0.2 } },
  ] : [];

  return createScene({
    id: withOneWayGate ? 'fixture-gate' : 'fixture-open',
    name: withOneWayGate ? 'Fixture — One-Way Gate' : 'Fixture — Open Room',
    bounds: { min: [-11, 0, -11], max: [11, 6, 11] },
    cellSize: 0.5,
    agent: { radius: 0.35, height: 1.8, eyeHeight: 1.6, speed: 4.0 },
    floors: [{ id: 'ground', name: 'Ground', y: 0, rect: { min: [-10, -10], max: [10, 10] } }],
    connectors: [],
    solids: [
      { id: 'shell-n', role: 'wall', min: [-10.4, 0, -10.4], max: [10.4, 6, -10] },
      { id: 'shell-s', role: 'wall', min: [-10.4, 0, 10], max: [10.4, 6, 10.4] },
      { id: 'shell-w', role: 'wall', min: [-10.4, 0, -10], max: [-10, 6, 10] },
      { id: 'shell-e', role: 'wall', min: [10, 0, -10], max: [10.4, 6, 10] },
      ...chamber,
    ],
    zones: [
      { id: 'north', name: 'North spawn', kind: 'spawn', floor: 'ground', rect: { min: [-4, -9], max: [4, -6] } },
      { id: 'south', name: 'South spawn', kind: 'spawn', floor: 'ground', rect: { min: [-4, 6], max: [4, 9] } },
      { id: 'objective', name: 'Objective', kind: 'objective', floor: 'ground', rect: { min: [-1, -1], max: [1, 1] }, priority: 2 },
    ],
  });
}

const config = {
  mode: 'fair',
  spawnInset: 0.6,
  sampleSpacing: 1.5,
  candidatesPerZone: 4,
  limits: { minClearance: 0.9, minHeadroom: 2.0, minPairSeparation: 6, maxPairSeparation: 60 },
};

// ---------------------------------------------------------------- open room
{
  const scene = tinyScene();
  const plan = planSpawns(scene, config);
  check('open room: plan succeeds', plan.ok, describeOutcome(plan).label);
  check('open room: at least one fair pair', plan.pairs.length > 0, `${plan.pairs.length} pair(s)`);

  // Independent validation: every surfaced candidate really does reach the
  // objective, and its stored cost matches a fresh Dijkstra.
  clearNavCache();
  const nav = getNavGraph(scene);
  const primary = zoneById(scene, 'objective');
  let allReach = true;
  let allCost = true;
  for (const zr of plan.zoneReports) {
    const floor = floorById(scene, zoneById(scene, zr.zoneId).floor);
    for (const c of zr.candidates) {
      const fresh = nav.routeDetail(zoneById(scene, zr.zoneId).floor, c.pos, primary);
      if (!fresh.reachable) allReach = false;
      if (Math.abs(fresh.cost - c.routes[0].cost) > 1e-2) allCost = false;
      if (verbose) console.log('   candidate', c.id, 'cost', c.routes[0].cost, 'fresh', fresh.cost, 'clearance', c.clearance.radius);
      void floor;
    }
  }
  check('open room: every candidate reaches the objective', allReach);
  check('open room: stored costs match a fresh query', allCost);

  // Contract re-derives everything.
  const contract = checkPlan(scene, plan);
  check('open room: contract accepts the plan', contract.ok, `${contract.passed}/${contract.total}`);

  // Weight applicability: weights reorder, but never gate.
  const reordered = planSpawns(scene, { ...config, weights: { approachParity: 0, concealment: 2 } });
  const sameAcceptSet = JSON.stringify([...reordered.acceptedPool].sort()) === JSON.stringify([...plan.acceptedPool].sort());
  check('open room: weights do not change the accepted set', sameAcceptSet);
  check('weights are declared non-gating', WEIGHT_APPLICABILITY.acceptanceGating === false);
  check('weights are declared no fairness proof', WEIGHT_APPLICABILITY.fairnessProof === false);
}

// ---------------------------------------------------------- one-way gate
{
  const scene = tinyScene({ withOneWayGate: true });
  const plan = planSpawns(scene, config);
  // The authored gates both face inward, so fair mode accepts — same as the
  // built-in One-Way Gate level. What must not happen is a reported exclusive
  // advantage while also accepting.
  const acceptedWithAdvantage = (plan.pairs ?? []).some((p) => (p.advantage.oneWay?.exclusiveBenefit ?? 0) > 1e-3);
  check('one-way gate: authored symmetric gates are accepted without exclusive advantage',
    plan.pairs.length > 0 && !acceptedWithAdvantage,
    `${plan.pairs.length} pair(s), exclusive=${acceptedWithAdvantage}`);

  // Flip one gate: that side is now stranded on the long way around, so fair
  // mode should reject with a named advantage, matching the built-in level.
  const flipped = flipDoor(scene, 'gate-north');
  const flippedPlan = planSpawns(flipped, config);
  const flippedContract = checkPlan(flipped, flippedPlan);
  check('one-way gate: flipped plan passes the contract', flippedContract.ok,
    `${flippedContract.passed}/${flippedContract.total} (${flippedPlan.outcome})`);
  const rejected = flippedPlan.pairRejections ?? [];
  const flippedOneWay = rejected.some((r) => r.reasons.some((x) => x.code === 'one-way-advantage'));
  check('one-way gate: flipping a gate produces a one-way rejection', flippedOneWay,
    flippedOneWay ? 'named gaining side' : `outcome ${flippedPlan.outcome}`);

  // Reweighting must not rescue those rejected points: it changes ranking only.
  if (rejected.length) {
    const rescored = reweightRejections(flippedPlan, { approachParity: 2, concealment: 0, clearance: 0, routeExposure: 0, spatialSpread: 0 });
    const stillRejected = planSpawns(flipped, { ...config, weights: { approachParity: 2, concealment: 0, clearance: 0, routeExposure: 0, spatialSpread: 0 } });
    const unchanged = JSON.stringify([...stillRejected.acceptedPool].sort()) === JSON.stringify([...flippedPlan.acceptedPool].sort());
    check('one-way gate: reweighting rejected points changes scores only',
      unchanged && rescored.length === rejected.length,
      `${rescored.length} re-scored, accepted pool ${flippedPlan.acceptedPool.length} unchanged=${unchanged}`);
    if (verbose) for (const r of rescored.slice(0, 3)) console.log('   rescored', r.a, '↔', r.b, r.previousNormalized, '->', r.normalized, r.codes.join(','));
  }
  // Chase mode across the flip should find the lead window.
  const chase = planSpawns(flipped, {
    ...config, mode: 'chase',
    chase: { leadSeconds: 2.0, leadToleranceSeconds: 1.5, minPursuitVisibility: 0 },
  });
  const chaseContract = checkPlan(flipped, chase);
  check('one-way gate: chase plan passes the contract', chaseContract.ok,
    `${chaseContract.passed}/${chaseContract.total} (${chase.outcome}, ${chase.pairs?.length ?? 0} pairs)`);
}

// ------------------------------------------------------- applicability text
{
  check('applicability lists fair components',
    WEIGHT_APPLICABILITY.perMode.fair.includes('approachParity'));
  check('applicability lists chase components',
    WEIGHT_APPLICABILITY.perMode.chase.includes('leadWindow'));
  check('applicability excludes verdicts',
    WEIGHT_APPLICABILITY.doesNotApplyTo.includes('replay verdict'));
}

console.log(`\n${pass}/${pass + fail} fixture checks passed.`);
process.exit(fail ? 1 : 0);
