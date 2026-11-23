#!/usr/bin/env node
// Maintenance check for the spawn-evaluation contract.
//
// Runs the independent contract checker over every built-in scene in both
// modes, with and without a one-way door flip, plus the no-candidate and
// invalid-scene outcomes. It reads only the live scenes and freshly computed
// plans — never a hand-authored expectation — so it is the same evidence the
// UI produces, re-derived. Exits non-zero on any misreport.
//
// Run: node scripts/contract.mjs [--verbose]
import { createScene, flipDoor, spawnZones } from '../src/core/scene.js';
import { checkScene, checkPlan } from '../src/core/contract.js';
import { planSpawns } from '../src/core/engine.js';
import { builtinScenes } from '../src/core/levels.js';

const verbose = process.argv.includes('--verbose');
let total = 0;
let failed = 0;
const rows = [];

function run(label, scene, config) {
  const { plan, report } = checkScene(scene, config, { verbose });
  total++;
  if (!report.ok) failed++;
  rows.push({ label, ok: report.ok, outcome: plan.outcome, passed: report.passed, total: report.total, failures: report.failures });
}

const configs = [
  { label: 'fair', config: { mode: 'fair' } },
  {
    label: 'chase',
    config: { mode: 'chase', chase: { leadSeconds: 4.25, leadToleranceSeconds: 1.5, minPursuitVisibility: 0 } },
  },
];

for (const raw of builtinScenes) {
  for (const flip of [false, true]) {
    let scene = createScene(JSON.parse(JSON.stringify(raw)));
    if (flip) {
      const door = scene.solids.find((s) => s.role === 'door' && s.door?.kind === 'one-way');
      if (!door) continue;
      scene = flipDoor(scene, door.id);
    }
    for (const { label, config } of configs) {
      run(`${raw.id}${flip ? ' (flipped)' : ''} ${label}`, scene, config);
    }
  }
}

// Negative cases: the outcome classifier must distinguish these, and the
// contract must agree with the reason it names.
{
  const tiny = createScene(JSON.parse(JSON.stringify(builtinScenes[0])));
  tiny.zones = tiny.zones.map((z) => z.kind === 'spawn'
    ? { ...z, rect: { min: [z.rect.min[0], z.rect.min[1]], max: [z.rect.min[0] + 0.5, z.rect.min[1] + 0.5] } }
    : z);
  const { plan, report } = checkScene(tiny, { mode: 'fair' });
  total++; if (!report.ok) failed++;
  rows.push({ label: 'degenerate-zone -> no-candidates', ok: report.ok, outcome: plan.outcome, passed: report.passed, total: report.total, failures: report.failures });
  if (plan.outcome !== 'no-candidates') {
    failed++;
    rows.push({ label: 'outcome-classification', ok: false, outcome: plan.outcome, passed: 0, total: 1, failures: [{ name: 'expected-no-candidates', detail: plan.outcome }] });
  }
}
{
  const s = createScene(JSON.parse(JSON.stringify(builtinScenes[0])));
  s.zones = s.zones.filter((z) => z.kind !== 'spawn');
  const { plan, report } = checkScene(s, { mode: 'fair' });
  total++; if (!report.ok) failed++;
  rows.push({ label: 'no-spawns -> invalid-scene', ok: report.ok, outcome: plan.outcome, passed: report.passed, total: report.total, failures: report.failures });
  if (plan.outcome !== 'invalid-scene') {
    failed++;
    rows.push({ label: 'outcome-classification', ok: false, outcome: plan.outcome, passed: 0, total: 1, failures: [{ name: 'expected-invalid-scene', detail: plan.outcome }] });
  }
}

// Misreport detection: tamper with a reported number and confirm the contract
// catches it. This proves the checker is not vacuously green.
{
  const scene = createScene(JSON.parse(JSON.stringify(builtinScenes[0])));
  const plan = planSpawns(scene, { mode: 'fair' });
  if (plan.pairs?.length) {
    const tampered = JSON.parse(JSON.stringify(plan));
    tampered.pairs[0].metrics.costA = Math.round((tampered.pairs[0].metrics.costA + 5) * 1000) / 1000;
    const report = checkPlan(scene, tampered);
    const caught = !report.ok && report.failures.some((f) => f.name.startsWith('pair-costA'));
    total++; if (!caught) failed++;
    rows.push({ label: 'tamper-detected (costA)', ok: caught, outcome: 'tampered', passed: caught ? 1 : 0, total: 1, failures: caught ? [] : [{ name: 'tamper-not-detected', detail: 'contract accepted a misreported cost' }] });
  }
  const badDelta = JSON.parse(JSON.stringify(plan));
  if (badDelta.pairs?.length) {
    badDelta.pairs[0].metrics.delta = 999;
    const report = checkPlan(scene, badDelta);
    const caught = !report.ok && report.failures.some((f) => f.name.startsWith('pair-delta'));
    total++; if (!caught) failed++;
    rows.push({ label: 'tamper-detected (delta)', ok: caught, outcome: 'tampered', passed: caught ? 1 : 0, total: 1, failures: caught ? [] : [{ name: 'tamper-not-detected', detail: 'contract accepted a misreported delta' }] });
  }
  // A forged accepted pair (inject a rejected pair into pairs[]) must be caught
  // by the hard-limit checks.
  if (plan.pairRejections?.length) {
    const forged = JSON.parse(JSON.stringify(plan));
    forged.pairs.push({ ...forged.pairRejections[0], metrics: forged.pairRejections[0].metrics, scores: forged.pairRejections[0].scores });
    const report = checkPlan(scene, forged);
    const caught = !report.ok;
    total++; if (!caught) failed++;
    rows.push({ label: 'forged-accept-detected', ok: caught, outcome: 'forged', passed: caught ? 1 : 0, total: 1, failures: caught ? [] : [{ name: 'forgery-not-detected', detail: 'contract accepted a pair that violates a limit' }] });
  }
}

for (const r of rows) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}  [${r.outcome}]  ${r.passed}/${r.total}`);
  if (!r.ok) for (const f of r.failures.slice(0, 6)) console.log(`        - ${f.name}: ${f.detail}`);
}

console.log(`\n${total - failed}/${total} contract checks passed.`);
process.exit(failed ? 1 : 0);
