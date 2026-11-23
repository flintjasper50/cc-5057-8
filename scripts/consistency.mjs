#!/usr/bin/env node
// Consistency check: the replay's arrival times must equal the planner's route
// costs, and the contract's independently recomputed costs must equal both.
// It reads the *actual* records the planner produced for each built-in scene —
// no hand-written expected numbers.
//
// Run: node scripts/consistency.mjs
import { createScene, flipDoor, sceneHash } from '../src/core/scene.js';
import { planSpawns, replayPair } from '../src/core/engine.js';
import { checkPlan } from '../src/core/contract.js';
import { builtinScenes } from '../src/core/levels.js';

let failures = 0;
let checked = 0;

function report(ok, line) {
  if (!ok) failures++;
  console.log(`${ok ? 'OK ' : 'BAD'} ${line}`);
}

for (const raw of builtinScenes) {
  for (const flip of [false, true]) {
    let scene = createScene(JSON.parse(JSON.stringify(raw)));
    if (flip) {
      const door = scene.solids.find((s) => s.role === 'door' && s.door?.kind === 'one-way');
      if (!door) continue;
      scene = flipDoor(scene, door.id);
    }
    const modes = [
      { mode: 'fair' },
      { mode: 'chase', chase: { leadSeconds: 4.25, leadToleranceSeconds: 1.5, minPursuitVisibility: 0 } },
    ];
    for (const config of modes) {
      const plan = planSpawns(scene, config);
      checked++;
      if (!plan.ok) {
        // A scene/mode with no accepted pair has nothing to replay; the contract
        // still has to validate the rejections it reported.
        const contract = checkPlan(scene, plan);
        report(contract.ok, `${raw.id}${flip ? ' (flipped)' : ''} ${config.mode}: no pair (${plan.outcome}); contract ${contract.passed}/${contract.total}`);
        continue;
      }
      const contract = checkPlan(scene, plan);
      report(contract.ok, `${raw.id}${flip ? ' (flipped)' : ''} ${config.mode}: plan ${plan.pairs.length} pairs; contract ${contract.passed}/${contract.total}`);
      for (const pair of plan.pairs) {
        const replay = replayPair(scene, plan, pair.id);
        const planDelta = Math.abs(pair.metrics.costA - pair.metrics.costB);
        const arrivalMatch = Math.abs(planDelta - replay.arrivalDelta) < 0.05;
        const hashMatch = replay.sceneHash === sceneHash(scene);
        checked++;
        report(arrivalMatch && hashMatch,
          `  ${pair.id} planDelta=${planDelta.toFixed(3)}s replayDelta=${replay.arrivalDelta}s verdict=${replay.verdict}`);
        if (!arrivalMatch) {
          console.log(`      plan costs ${pair.metrics.costA}/${pair.metrics.costB}, replay arrivals ${replay.sides.A.arrivalTime}/${replay.sides.B.arrivalTime}`);
        }
      }
    }
  }
}

console.log(`\n${checked - failures}/${checked} consistency checks passed.`);
process.exit(failures ? 1 : 0);
