// Checks that the replay's arrival times match the planner's route costs, so a
// pair's stated delta is the same evidence the replay shows. Run: node scripts/consistency.mjs
import { createScene, flipDoor } from '../src/core/scene.js';
import { planSpawns, replayPair } from '../src/core/engine.js';
import { builtinScenes } from '../src/core/levels.js';

let failures = 0;
let checked = 0;

for (const raw of builtinScenes) {
  for (const flip of [false, true]) {
    let scene = createScene(JSON.parse(JSON.stringify(raw)));
    const flippable = scene.solids.find((s) => s.role === 'door' && s.door?.kind === 'one-way');
    if (flip) {
      if (!flippable) continue;
      scene = flipDoor(scene, flippable.id);
    }
    const config = flip
      ? { mode: 'chase', chase: { leadSeconds: 4.25, leadToleranceSeconds: 1.5, minPursuitVisibility: 0 } }
      : { mode: 'fair' };
    const plan = planSpawns(scene, config);
    console.log(`${raw.id}${flip ? ' (flipped)' : ''} ${config.mode}: ok=${plan.ok} pairs=${plan.pairs.length}`);
    for (const pair of plan.pairs) {
      const replay = replayPair(scene, plan, pair.id);
      const planDelta = Math.abs(pair.metrics.costA - pair.metrics.costB);
      const match = Math.abs(planDelta - replay.arrivalDelta) < 0.05;
      checked++;
      if (!match) failures++;
      console.log(`  ${match ? 'OK ' : 'BAD'} planDelta=${planDelta.toFixed(3)}s replayDelta=${replay.arrivalDelta}s verdict=${replay.verdict}`);
    }
  }
}

console.log(`\n${checked - failures}/${checked} replays match planner costs.`);
process.exit(failures ? 1 : 0);
