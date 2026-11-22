import {
  floorById, spawnZones, objectiveZones, zoneById, zoneCenter,
  flipDoor, cloneScene, sceneHash, doorSolids, doorNormal, doorCenter2,
} from './scene.js';
import { getNavGraph } from './nav.js';
import { generateCandidates, pairEvidence, routeExposure } from './candidates.js';
import { round, hashString } from './math.js';

export const DEFAULT_CONFIG = {
  mode: 'fair',                      // 'fair' | 'chase'
  spawnInset: 0.6,
  sampleSpacing: 1.1,
  candidatesPerZone: 6,
  maxPairs: 4,
  limits: {
    minClearance: 0.9,
    minHeadroom: 2.0,
    maxPathCostDelta: 0.5,           // seconds between pair sides (fair)
    maxRelativeDelta: 0.08,          // or fraction of cheaper route
    rejectOneWayFair: true,          // fair mode refuses one-way advantage
    minPairSeparation: 6,            // world meters between the two spawns
    maxPairSeparation: 60,
    rejectMutualVisibilityFair: false, // option: forbid head-on sightlines in fair mode
    requireObjectiveReachable: true,
  },
  chase: {
    leadSeconds: 2.5,                // allowed arrival lead
    leadToleranceSeconds: 0.75,
    minPursuitVisibility: 0.25,      // prereq: pursuer must be able to find prey sometimes
    maxPursuitVisibility: 1.0,
  },
  weights: {
    // Soft objective, kept separate from hard limits.
    approachParity: 1.0,             // lower cost gap is better (fair mode)
    leadWindow: 1.0,                 // distance-to-target lead window (chase mode)
    concealment: 0.6,                // mutual visibility is penalised when visible
    clearance: 0.7,                  // prefer roomier spawns
    routeExposure: 0.4,              // prefer covered routes
    spatialSpread: 0.5,              // prefer pairs on different approaches
  },
};

export function resolveConfig(partial = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    limits: { ...DEFAULT_CONFIG.limits, ...(partial.limits ?? {}) },
    chase: { ...DEFAULT_CONFIG.chase, ...(partial.chase ?? {}) },
    weights: { ...DEFAULT_CONFIG.weights, ...(partial.weights ?? {}) },
  };
}

export function planSpawns(scene, partialConfig = {}) {
  const config = resolveConfig(partialConfig);
  const hash = sceneHash(scene);
  const nav = getNavGraph(scene);
  const spawns = spawnZones(scene);
  const objectives = objectiveZones(scene);
  const primaryObjective = objectives[0] ?? null;

  if (spawns.length < 2) {
    return failure(scene, config, 'need-two-spawn-zones',
      `Fair/chase pairing needs at least two spawn zones; found ${spawns.length}.`);
  }
  if (!primaryObjective) {
    return failure(scene, config, 'no-objective', 'No objective zone is defined.');
  }

  const candidateSets = [];
  const zoneReports = [];
  for (const zone of spawns) {
    const gen = generateCandidates(scene, config, zone);
    if (!gen.picked.length) {
      return failure(scene, config, 'no-candidates',
        `Spawn zone "${zone.id}" produced no geometrically valid candidate positions.`,
        { zoneId: zone.id, rejected: gen.rejected });
    }
    candidateSets.push({ zone, ...gen });
    zoneReports.push({
      zoneId: zone.id,
      poolSize: gen.poolSize,
      accepted: gen.picked.length,
      rejected: gen.rejected.length,
      rejectionReasons: summarizeRejections(gen.rejected),
      candidates: gen.picked,
      candidatesRaw: { rejected: gen.rejected },
    });
  }

  const { pairs, pairRejections } = buildPairs(scene, nav, config, candidateSets, objectives, primaryObjective);
  const ranked = rankPairs(scene, config, pairs, primaryObjective);
  const top = ranked.slice(0, config.maxPairs);

  // Chase mode still reports a "mirror" reading so the author can see whether
  // the authored geometry would be fair under the stricter rule.
  const fairCheck = shadowsFairCheck(scene, config, candidateSets, nav, objectives, primaryObjective);
  const suggestions = top.length ? [] : diagnoseNoPairs(scene, config, pairRejections, zoneReports);
  const counterfactuals = doorCounterfactuals(scene, config, top);
  const counterfactualsUnavailable = counterfactuals.length ? null
    : doorSolids(scene).length
      ? 'No accepted pair to compare against a door flip. Resolve the rejections above, then flip a gate to see the lead move.'
      : 'No one-way doors in this scene.';

  return {
    ok: top.length > 0,
    kind: 'plan',
    sceneId: scene.id,
    sceneHash: hash,
    revision: scene.revision,
    mode: config.mode,
    config,
    objective: { id: primaryObjective.id, name: primaryObjective.name, center: zoneCenter(primaryObjective) },
    zoneReports,
    pairs: top,
    pairRejections,
    fairCheck,
    counterfactuals,
    counterfactualsUnavailable,
    suggestions,
    generatedAt: new Date().toISOString(),
  };
}

function failure(scene, config, code, message, extra = {}) {
  return {
    ok: false, kind: 'plan', sceneId: scene.id, sceneHash: sceneHash(scene),
    revision: scene.revision, mode: config.mode, config, code, message, ...extra,
    generatedAt: new Date().toISOString(),
  };
}

function summarizeRejections(rejected) {
  const map = new Map();
  for (const r of rejected) {
    const key = r.blockedReason.split('(')[0].trim();
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].map(([reason, count]) => ({ reason, count }));
}

// Actionable guidance that flows back into the spawn-design controls when no
// pair survives. Each item names the limit or geometry responsible.
function diagnoseNoPairs(scene, config, pairRejections, zoneReports) {
  const counts = new Map();
  const sample = new Map();
  for (const r of pairRejections) {
    for (const reason of r.reasons) {
      counts.set(reason.code, (counts.get(reason.code) ?? 0) + 1);
      if (!sample.has(reason.code)) sample.set(reason.code, reason.detail);
    }
  }
  const out = [];
  if (counts.has('one-way-advantage')) {
    const door = scene.solids.find((s) => s.role === 'door' && s.door?.kind === 'one-way');
    out.push({
      code: 'one-way-advantage',
      count: counts.get('one-way-advantage'),
      message: `One-way door ${door?.id ?? ''} gives one side a route the other cannot match. Mirror the gate on the opposite side, flip it, or allow one-way advantage in chase mode.`,
      controls: { mode: 'chase', limit: 'rejectOneWayFair', value: false },
      evidence: sample.get('one-way-advantage'),
    });
  }
  if (counts.has('unfair-cost-gap')) {
    out.push({
      code: 'unfair-cost-gap',
      count: counts.get('unfair-cost-gap'),
      message: `Approach costs exceed the fair delta of ${config.limits.maxPathCostDelta}s / ${Math.round(config.limits.maxRelativeDelta * 100)}%. Move spawn zones, shorten the long lane, or switch to chase mode with a lead window.`,
      controls: { limit: 'maxPathCostDelta', value: config.limits.maxPathCostDelta },
      evidence: sample.get('unfair-cost-gap'),
    });
  }
  if (counts.has('lead-out-of-window')) {
    out.push({
      code: 'lead-out-of-window',
      count: counts.get('lead-out-of-window'),
      message: `No pair produces a lead inside ${config.chase.leadSeconds}s ± ${config.chase.leadToleranceSeconds}s. Widen the tolerance or change the intended lead time.`,
      controls: { chase: 'leadToleranceSeconds', value: config.chase.leadToleranceSeconds },
      evidence: sample.get('lead-out-of-window'),
    });
  }
  if (counts.has('pursuer-cannot-find')) {
    out.push({
      code: 'pursuer-cannot-find',
      count: counts.get('pursuer-cannot-find'),
      message: `Pursuer routes see the prey for under ${Math.round(config.chase.minPursuitVisibility * 100)}% of their length. Lower the requirement or open sightlines.`,
      controls: { chase: 'minPursuitVisibility', value: config.chase.minPursuitVisibility },
      evidence: sample.get('pursuer-cannot-find'),
    });
  }
  if (counts.has('too-close') || counts.has('too-far')) {
    out.push({
      code: 'pair-separation',
      count: (counts.get('too-close') ?? 0) + (counts.get('too-far') ?? 0),
      message: `Pair separation falls outside ${config.limits.minPairSeparation}-${config.limits.maxPairSeparation}m. Adjust the spawn-zone rects.`,
      controls: { limit: 'minPairSeparation', value: config.limits.minPairSeparation },
    });
  }
  if (counts.has('unreachable-side')) {
    out.push({
      code: 'unreachable-side',
      count: counts.get('unreachable-side'),
      message: 'One side cannot navigate to the primary objective. Check door state, floor holes and connector rects.',
    });
  }
  const deadZones = zoneReports.filter((z) => z.accepted === 0);
  for (const z of deadZones) {
    out.push({
      code: 'zone-no-candidates',
      zoneId: z.zoneId,
      message: `Zone "${z.zoneId}" produced no valid candidates: ${z.rejectionReasons.map((r) => r.reason).join('; ')}. Enlarge the zone or reduce the clearance limit.`,
      controls: { limit: 'minClearance', value: config.limits.minClearance },
    });
  }
  return out;
}

function buildPairs(scene, nav, config, candidateSets, objectives) {
  const pairs = [];
  const pairRejections = [];
  for (let i = 0; i < candidateSets.length; i++) {
    for (let j = i + 1; j < candidateSets.length; j++) {
      const setA = candidateSets[i];
      const setB = candidateSets[j];
      for (const a of setA.picked) {
        for (const b of setB.picked) {
          const evaluation = evaluatePair(scene, nav, config, a, b, setA.zone, setB.zone, objectives);
          if (evaluation.rejected) {
            pairRejections.push({ a: a.id, b: b.id, zones: [setA.zone.id, setB.zone.id], ...evaluation });
          } else {
            pairs.push(evaluation.pair);
          }
        }
      }
    }
  }
  return { pairs, pairRejections };
}

function evaluatePair(scene, nav, config, a, b, zoneA, zoneB, objectives) {
  const limits = config.limits;
  const primary = objectives[0];
  const primaryIdx = 0;
  const routeA = a.routes[primaryIdx];
  const routeB = b.routes[primaryIdx];
  const rejectReasons = [];

  if (limits.requireObjectiveReachable && (!routeA.reachable || !routeB.reachable)) {
    rejectReasons.push({
      code: 'unreachable-side',
      detail: `primary objective unreachable from ${!routeA.reachable ? a.id : b.id}`,
    });
  }

  const sep = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]);
  if (sep < limits.minPairSeparation) {
    rejectReasons.push({ code: 'too-close', detail: `pair separation ${round(sep, 2)}m < ${limits.minPairSeparation}m` });
  }
  if (sep > limits.maxPairSeparation) {
    rejectReasons.push({ code: 'too-far', detail: `pair separation ${round(sep, 2)}m > ${limits.maxPairSeparation}m` });
  }

  const ev = pairEvidence(scene, a, b);
  const costA = routeA.cost ?? Infinity;
  const costB = routeB.cost ?? Infinity;
  const delta = Number.isFinite(costA) && Number.isFinite(costB) ? Math.abs(costA - costB) : Infinity;
  const cheaper = costA <= costB ? 'A' : 'B';
  const rel = Number.isFinite(delta) ? delta / Math.min(costA, costB) : Infinity;

  const doorAdvantage = doorAdvantageReport(scene, a, b, costA, costB, objectives[0]);

  // Hard mode limits.
  if (config.mode === 'fair') {
    if (limits.rejectOneWayFair && doorAdvantage.exclusiveBenefit > 1e-3) {
      rejectReasons.push({
        code: 'one-way-advantage',
        detail: `${doorAdvantage.owner} gains ${round(doorAdvantage.exclusiveBenefit, 2)}s from ${doorAdvantage.doorId}'s orientation that the other side cannot match; neutral-door costs ${doorAdvantage.neutralA}/${doorAdvantage.neutralB}s vs directed ${round(costA, 2)}/${round(costB, 2)}s`,
        doorId: doorAdvantage.doorId,
      });
    }
    if (Number.isFinite(delta) && delta > limits.maxPathCostDelta && rel > limits.maxRelativeDelta) {
      rejectReasons.push({
        code: 'unfair-cost-gap',
        detail: `route costs differ by ${round(delta, 2)}s (${round(rel * 100, 1)}%), over abs ${limits.maxPathCostDelta}s and rel ${round(limits.maxRelativeDelta * 100, 1)}%`,
      });
    }
    if (limits.rejectMutualVisibilityFair && ev.sight.visible) {
      rejectReasons.push({ code: 'head-on-visibility', detail: 'spawns have a direct head-on sightline' });
    }
  } else {
    // Chase mode: convert the cost gap into a lead time and compare with the
    // configured window. A pair is usable if the intended leader has a lead in
    // [leadSeconds - tol, leadSeconds + tol]; otherwise the lead is either too
    // small to matter or so large it stops being a chase.
    const lead = Number.isFinite(delta) ? delta : Infinity;
    const lo = Math.max(0, config.chase.leadSeconds - config.chase.leadToleranceSeconds);
    const hi = config.chase.leadSeconds + config.chase.leadToleranceSeconds;
    if (!(lead >= lo && lead <= hi)) {
      rejectReasons.push({
        code: 'lead-out-of-window',
        detail: `lead ${round(lead, 2)}s outside [${round(lo, 2)}, ${round(hi, 2)}]s window`,
      });
    }
    if (ev.exposure.fraction < config.chase.minPursuitVisibility) {
      rejectReasons.push({
        code: 'pursuer-cannot-find',
        detail: `only ${round(ev.exposure.fraction * 100, 0)}% of pursuer route sees the prey (< ${round(config.chase.minPursuitVisibility * 100, 0)}%)`,
      });
    }
  }

  if (rejectReasons.length) {
    return {
      rejected: true,
      reasons: rejectReasons,
      metrics: { costA, costB, delta, rel, separation: round(sep, 3), leadSeconds: Number.isFinite(delta) ? round(delta, 3) : null },
      evidence: ev.records,
    };
  }

  const leadSeconds = Number.isFinite(delta) ? delta : 0;
  const leader = config.mode === 'chase'
    ? (costA < costB ? 'A' : 'B')
    : cheaper;
  const pair = {
    id: `pair:${a.id}::${b.id}`,
    a: a.id,
    b: b.id,
    zones: [zoneA.id, zoneB.id],
    floors: [a.floorId, b.floorId],
    points: { A: a.pos, B: b.pos },
    metrics: {
      costA: round(costA, 3),
      costB: round(costB, 3),
      delta: round(delta, 3),
      relativeDelta: round(rel, 4),
      leadSeconds: round(leadSeconds, 3),
      separation: round(sep, 3),
      clearanceA: a.clearance.radius,
      clearanceB: b.clearance.radius,
      ascentA: routeA.ascent,
      ascentB: routeB.ascent,
    },
    advantage: {
      cheaperSide: cheaper,
      leader,
      oneWay: doorAdvantage,
      oneWayAdvantageOwner: doorAdvantage.owner,
    },
    mutualVisibility: ev.sight.visible,
    visibility: {
      sight: { visible: ev.sight.visible, blockedBy: ev.sight.blockedBy, distance: ev.sight.distance },
      exposureA: round(ev.exposure.fraction, 3),
    },
    evidence: ev.records,
    doorEvidence: doorAdvantage.doorId ? [{
      id: `${doorAdvantage.doorId}:neutral-control`,
      source: 'nav:door-neutral-control',
      kind: 'one-way-control',
      value: doorAdvantage.exclusiveBenefit,
      verdict: doorAdvantage.owner ? `exclusive-to-${doorAdvantage.owner}` : 'symmetric',
      detail: `with ${doorAdvantage.doorId} neutralised: A=${doorAdvantage.neutralA}s B=${doorAdvantage.neutralB}s; authored gains A=${doorAdvantage.gainA}s B=${doorAdvantage.gainB}s`,
      query: { type: 'nav-dijkstra-door-neutralised', doorId: doorAdvantage.doorId },
    }] : [],
    conflicts: ev.conflict ? [{ code: 'sight-vs-route', detail: 'spawn-level sightline and route sampling disagree; both records retained' }] : [],
    candidates: [a, b],
    scores: scorePair(scene, config, a, b, ev, delta, rel, sep),
  };
  // Deliberately not flattening to a single number: keep both components and
  // their rationale for the result panel.
  return { rejected: false, pair };
}

const neutralDoorCache = new Map();

function neutralDoorScene(scene, doorId) {
  const key = `${sceneHash(scene)}|${doorId}`;
  if (neutralDoorCache.has(key)) return neutralDoorCache.get(key);
  const neutral = cloneScene(scene);
  const nd = neutral.solids.find((x) => x.id === doorId);
  if (!nd?.door) return null;
  nd.door = { ...nd.door, kind: 'two-way', state: 'open' };
  neutral.revision = scene.revision;
  neutralDoorCache.set(key, neutral);
  while (neutralDoorCache.size > 12) {
    neutralDoorCache.delete(neutralDoorCache.keys().next().value);
  }
  return neutral;
}

function doorAdvantageReport(scene, a, b, costA, costB, primary) {  // Neutral-door control: temporarily make every one-way door passable in both
  // directions, re-run each side, and see which side's cost changes. An
  // advantage exists only when one side's improvement is exclusive.
  const doors = doorSolids(scene);
  if (!doors.length || !Number.isFinite(costA) || !Number.isFinite(costB)) {
    return { doorId: null, owner: null, exclusiveBenefit: 0, neutralA: null, neutralB: null, neutralDelta: null };
  }
  let report = { doorId: null, owner: null, exclusiveBenefit: 0, neutralA: null, neutralB: null, neutralDelta: null };
  for (const door of doors) {
    const neutral = neutralDoorScene(scene, door.id);
    if (!neutral) continue;
    const nav = getNavGraph(neutral);
    const ra = nav.routeDetail(a.floorId, a.pos, primary);
    const rb = nav.routeDetail(b.floorId, b.pos, primary);
    if (!ra.reachable || !rb.reachable) continue;
    const gainA = costA - ra.cost; // seconds saved on side A by the door orientation
    const gainB = costB - rb.cost;
    const exclusive = gainA - gainB; // positive -> A benefits more than B
    if (Math.abs(exclusive) > 1e-3) {
      const owner = exclusive > 0 ? 'A' : 'B';
      if (Math.abs(exclusive) > Math.abs(report.exclusiveBenefit)) {
        report = {
          doorId: door.id,
          owner,
          exclusiveBenefit: Math.abs(exclusive),
          neutralA: round(ra.cost, 3),
          neutralB: round(rb.cost, 3),
          neutralDelta: round(Math.abs(ra.cost - rb.cost), 3),
          gainA: round(gainA, 3),
          gainB: round(gainB, 3),
        };
      }
    }
  }
  return report;
}

function scorePair(scene, config, a, b, ev, delta, rel, sep) {
  const w = config.weights;
  const components = [];
  const clearance = (a.clearance.radius + b.clearance.radius) / 2;
  const maxClear = Math.max(1e-6, ...(config._clearanceRef ? [config._clearanceRef] : [clearance]));
  const clearanceScore = clamp01(clearance / 3.5);
  components.push({ key: 'clearance', label: 'Initial free room', weight: w.clearance, raw: round(clearance, 3), score: round(clearanceScore, 3), note: 'mean radial clearance / 3.5m' });

  if (config.mode === 'fair') {
    const parity = Number.isFinite(rel) ? clamp01(1 - rel / Math.max(1e-6, config.limits.maxRelativeDelta)) : 0;
    components.push({ key: 'approachParity', label: 'Approach parity', weight: w.approachParity, raw: round(rel, 4), score: round(parity, 3), note: 'shorter the relative cost gap, higher parity' });
  } else {
    const lead = Number.isFinite(delta) ? delta : 0;
    const mid = config.chase.leadSeconds;
    const half = Math.max(1e-6, config.chase.leadToleranceSeconds);
    const inWindow = clamp01(1 - Math.abs(lead - mid) / (half * 2));
    components.push({ key: 'leadWindow', label: 'Lead window fit', weight: w.leadWindow, raw: round(lead, 3), score: round(inWindow, 3), note: `target ${mid}s +/- ${half}s` });
  }

  const conceal = clamp01(ev.sight.visible ? 0 : 1);
  components.push({ key: 'concealment', label: 'Mutual concealment', weight: w.concealment, raw: ev.sight.visible, score: round(conceal, 3), note: ev.sight.visible ? `visible over ${ev.sight.distance}m` : `hidden by ${ev.sight.blockedBy}` });
  components.push({ key: 'routeExposure', label: 'Route cover', weight: w.routeExposure, raw: round(ev.exposure.fraction, 3), score: round(clamp01(1 - ev.exposure.fraction), 3), note: `${Math.round(ev.exposure.fraction * 100)}% of route sampled in view of opponent spawn` });
  const spread = clamp01(sep / Math.max(1e-6, config.limits.maxPairSeparation));
  components.push({ key: 'spatialSpread', label: 'Approach separation', weight: w.spatialSpread, raw: round(sep, 3), score: round(spread, 3), note: 'wider separation / max pair separation' });

  const total = components.reduce((s, c) => s + c.weight * c.score, 0);
  const weightSum = components.reduce((s, c) => s + c.weight, 0);
  return {
    components,
    weighted: round(total, 4),
    normalized: round(weightSum ? total / weightSum : 0, 4),
    // Display-only; never used as a hard gate.
    disclaimer: 'Composite is a soft preference for ranking, not a fairness proof.',
  };
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function rankPairs(scene, config, pairs, primaryObjective) {
  const seen = new Set();
  const ranked = [];
  // Greedy diversity: don't return several pairs built from the same spawn cell.
  const usedSpawns = new Set();
  const sorted = [...pairs].sort((x, y) => {
    const a = x.scores.normalized;
    const b = y.scores.normalized;
    if (Math.abs(a - b) > 1e-6) return b - a;
    return (x.metrics.delta ?? Infinity) - (y.metrics.delta ?? Infinity);
  });
  for (const pair of sorted) {
    if (seen.has(pair.id)) continue;
    const reuse = [pair.a, pair.b].filter((id) => usedSpawns.has(id)).length;
    if (reuse >= 2) continue;
    seen.add(pair.id);
    usedSpawns.add(pair.a);
    usedSpawns.add(pair.b);
    ranked.push(pair);
  }
  return ranked;
}

// For chase-mode results, show what fair mode would have said about the same
// pair: this is evidence, not an automatic rejection, and stops one high total
// from being read as "fair for all gameplay".
function shadowsFairCheck(scene, config, candidateSets, nav, objectives, primary) {
  const fairConfig = resolveConfig({ ...config, mode: 'fair' });
  const report = { evaluated: 0, acceptable: 0, rejections: [] };
  for (const setA of candidateSets) {
    for (const setB of candidateSets) {
      if (setA.zone.id >= setB.zone.id) continue;
      for (const a of setA.picked) {
        for (const b of setB.picked) {
          const ev = evaluatePair(scene, nav, fairConfig, a, b, setA.zone, setB.zone, objectives);
          report.evaluated++;
          if (!ev.rejected) report.acceptable++;
          else if (report.rejections.length < 8) {
            report.rejections.push({ a: a.id, b: b.id, reasons: ev.reasons });
          }
        }
      }
    }
  }
  return report;
}

// For each one-way door, re-run the top pairs with the door flipped and report
// which side inherits the lead and whether the pair would still be legal. This
// is the "advantage moved to the other side" record the author can inspect
// without manually flipping and re-running.
function doorCounterfactuals(scene, config, pairs) {
  const doors = doorSolids(scene).filter((d) => d.door.kind === 'one-way');
  if (!doors.length || !pairs.length) return [];
  const objectives = objectiveZones(scene);
  const primary = objectives[0];
  const out = [];
  for (const door of doors) {
    const flipped = flipDoor(scene, door.id);
    const nav = getNavGraph(flipped);
    const perPair = [];
    for (const pair of pairs) {
      const candA = pair.candidates[0];
      const candB = pair.candidates[1];
      const ra = nav.routeDetail(candA.floorId, candA.pos, primary);
      const rb = nav.routeDetail(candB.floorId, candB.pos, primary);
      if (!ra.reachable || !rb.reachable) continue;
      const delta = Math.abs(ra.cost - rb.cost);
      const leader = ra.cost < rb.cost ? 'A' : rb.cost < ra.cost ? 'B' : 'tie';
      const before = pair.advantage.leader;
      let verdict;
      if (config.mode === 'fair') {
        const violatesDelta = delta > config.limits.maxPathCostDelta && delta / Math.min(ra.cost, rb.cost) > config.limits.maxRelativeDelta;
        verdict = violatesDelta ? 'rejected-cost-gap' : 'legal';
      } else {
        const lo = Math.max(0, config.chase.leadSeconds - config.chase.leadToleranceSeconds);
        const hi = config.chase.leadSeconds + config.chase.leadToleranceSeconds;
        verdict = delta >= lo && delta <= hi ? 'legal' : 'rejected-lead-window';
      }
      perPair.push({
        pairId: pair.id,
        leader,
        previousLeader: before,
        moved: leader !== before,
        delta: round(delta, 3),
        costs: [round(ra.cost, 3), round(rb.cost, 3)],
        verdict,
        doors: { A: ra.crossings, B: rb.crossings },
      });
    }
    out.push({
      doorId: door.id,
      fromSign: door.door.allowedSign,
      toSign: -door.door.allowedSign,
      pairs: perPair,
      advantageMovedTo: summarizeMoved(perPair),
    });
  }
  return out;
}

function summarizeMoved(perPair) {
  const moved = perPair.filter((p) => p.moved);
  if (!moved.length) return 'unchanged';
  return moved.map((p) => `${p.pairId}: ${p.previousLeader} → ${p.leader}`).join('; ');
}
export function replayPair(scene, plan, pairId, options = {}) {
  const config = resolveConfig(plan.config ?? {});
  const pair = plan.pairs.find((p) => p.id === pairId);
  if (!pair) throw new Error(`Unknown pair "${pairId}"`);
  const nav = getNavGraph(scene);
  const primary = objectiveZones(scene)[0];
  const dt = options.dt ?? 1 / 30;
  const result = { pairId, sceneHash: sceneHash(scene), revision: scene.revision, dt, sides: {}, events: [] };

  const sides = { A: pair.candidates[0], B: pair.candidates[1] };
  for (const side of ['A', 'B']) {
    const cand = sides[side];
    const route = nav.routeDetail(cand.floorId, cand.pos, primary);
    const samples = sampleRoute(scene, cand, route, dt);
    result.sides[side] = {
      candidateId: cand.id,
      pos: cand.pos,
      floorId: cand.floorId,
      reachable: route.reachable,
      cost: route.reachable ? round(route.cost, 3) : null,
      length2D: route.length2D,
      ascent: route.ascent,
      doors: route.crossings,
      connectors: route.connectors,
      arrivalTime: samples.length ? round(samples[samples.length - 1].t, 3) : null,
      path: samples,
    };
  }

  const tA = result.sides.A.arrivalTime;
  const tB = result.sides.B.arrivalTime;
  result.arrivalDelta = Number.isFinite(tA) && Number.isFinite(tB) ? round(Math.abs(tA - tB), 3) : null;
  if (Number.isFinite(tA) && Number.isFinite(tB)) {
    result.winner = tA < tB ? 'A' : tB < tA ? 'B' : 'tie';
    const lead = Math.abs(tA - tB);
    if (config.mode === 'fair') {
      const tol = config.limits.maxPathCostDelta + 0.25;
      result.verdict = lead <= tol ? 'accepted-fair' : 'rejected-by-replay';
      result.verdictDetail = lead <= tol
        ? `arrival difference ${round(lead, 2)}s within fair tolerance ${round(tol, 2)}s`
        : `arrival difference ${round(lead, 2)}s exceeds fair tolerance ${round(tol, 2)}s`;
    } else {
      result.verdict = 'chase-recorded';
      result.verdictDetail = `leader ${result.winner} by ${round(lead, 2)}s (configured window ${config.chase.leadSeconds}s +/- ${config.chase.leadToleranceSeconds}s)`;
    }
  } else {
    result.winner = null;
    result.verdict = 'incomplete';
    result.verdictDetail = 'one or both routes were not reachable';
  }

  // First-moment mutual visibility along the replay (both present).
  const maxT = Math.max(tA ?? 0, tB ?? 0);
  const checks = [];
  for (let t = 0; t <= maxT + 1e-9; t += 0.5) {
    const pA = sampleAt(result.sides.A.path, t);
    const pB = sampleAt(result.sides.B.path, t);
    if (!pA || !pB) continue;
    const vis = scene.agent ? mutualVisible(scene, pA, pB) : false;
    checks.push({ t: round(t, 2), visible: vis, a: pA.pos2, b: pB.pos2 });
  }
  result.visibilityChecks = checks;
  result.firstVisibility = checks.find((c) => c.visible) ?? null;
  return result;
}

function mutualVisible(scene, pA, pB) {
  const a3 = [pA.pos2[0], pA.y + scene.agent.eyeHeight, pA.pos2[1]];
  const b3 = [pB.pos2[0], pB.y + scene.agent.eyeHeight, pB.pos2[1]];
  for (const s of scene.solids) {
    if (s.role === 'slab' || s.role === 'decor') continue;
    if (s.role === 'door' && s.door && s.door.state === 'open' && s.door.kind === 'two-way') continue;
    if (s.role === 'railing' && s.max[1] - s.min[1] < scene.agent.eyeHeight * 0.7) continue;
    const lo = [Math.min(a3[0], b3[0]), Math.min(a3[1], b3[1]), Math.min(a3[2], b3[2])];
    const hi = [Math.max(a3[0], b3[0]), Math.max(a3[1], b3[1]), Math.max(a3[2], b3[2])];
    if (hi[0] < s.min[0] || lo[0] > s.max[0]) continue;
    if (hi[1] < s.min[1] || lo[1] > s.max[1]) continue;
    if (hi[2] < s.min[2] || lo[2] > s.max[2]) continue;
    // Narrow-phase exact slab test.
    let t0 = 0, t1 = 1, hit = true;
    for (let k = 0; k < 3; k++) {
      const d = b3[k] - a3[k];
      if (Math.abs(d) < 1e-9) {
        if (a3[k] < s.min[k] || a3[k] > s.max[k]) { hit = false; break; }
      } else {
        let ta = (s.min[k] - a3[k]) / d;
        let tb = (s.max[k] - a3[k]) / d;
        if (ta > tb) [ta, tb] = [tb, ta];
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) { hit = false; break; }
      }
    }
    if (hit && t1 - t0 > 1e-6) return false;
  }
  return true;
}

function sampleRoute(scene, cand, route, dt) {
  if (!route.reachable || !route.points?.length) return [];
  const floor = floorById(scene, cand.floorId);
  const pts = route.points;
  const heights = route.points3 ?? pts.map((p) => [p[0], floor.y + 0.05, p[1]]);
  // Prefer planner-provided timestamps so replay arrival matches plan cost.
  const times = route.times && route.times.length === pts.length ? route.times : null;
  const out = [];
  out.push({ t: 0, pos2: pts[0], y: floor.y, s: 0 });
  let t = 0;
  let travelled = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ya = heights[i - 1][1] - 0.05;
    const yb = heights[i][1] - 0.05;
    const segTime = times ? Math.max(0, times[i] - times[i - 1]) : segLen / scene.agent.speed;
    if (segLen < 1e-6 && segTime < 1e-6) continue;
    const steps = Math.max(1, Math.ceil(Math.max(segLen / (scene.agent.speed * dt), segTime / dt)));
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      travelled += segLen / steps;
      t += segTime / steps;
      out.push({
        t: round(t, 4),
        pos2: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f],
        y: ya + (yb - ya) * f,
        s: round(travelled, 3),
      });
    }
  }
  return out;
}

function sampleAt(path, t) {
  if (!path?.length) return null;
  if (t <= path[0].t) return path[0];
  for (let i = 1; i < path.length; i++) {
    if (path[i].t >= t) {
      return path[i];
    }
  }
  return path[path.length - 1];
}
