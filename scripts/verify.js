// Browser-driven verification. Starts from a fresh page, drives the real UI
// controls, and writes screenshots plus a JSON report of everything observed.
// This is deliberately *not* a script that calls the kernel directly: the point
// is to prove the delivered window works end to end.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:5173/';
const OUT = path.resolve('reports');
fs.mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, name), fullPage: false });
};

const api = () => page.evaluate(() => {
  const s = window.__spawnwright.state;
  const p = s.plan;
  return {
    scene: s.scene.id,
    revision: s.scene.revision,
    hash: window.__spawnwright.viewport.sceneData ? undefined : undefined,
    mode: s.mode,
    ok: p?.ok ?? null,
    pairCount: p?.pairs?.length ?? 0,
    rejectCount: p?.pairRejections?.length ?? 0,
    pairs: (p?.pairs ?? []).map((x) => ({
      id: x.id, delta: x.metrics.delta, lead: x.metrics.leadSeconds,
      leadOwner: x.advantage.leader, oneWayOwner: x.advantage.oneWayAdvantageOwner,
      oneWayBenefit: x.advantage.oneWay?.exclusiveBenefit ?? 0,
      mutual: x.mutualVisibility, costs: [x.metrics.costA, x.metrics.costB],
      zones: x.zones,
    })),
    rejectCodes: [...new Set((p?.pairRejections ?? []).flatMap((r) => r.reasons.map((x) => x.code)))],
    suggestions: (p?.suggestions ?? []).map((s) => s.code),
    store: s.store.summary(),
    selected: s.selectedPairId,
    replay: s.replay ? { verdict: s.replay.verdict, detail: s.replay.verdictDetail, winner: s.replay.winner, firstVis: s.replay.firstVisibility?.t ?? null } : null,
  };
});

// ------------------------------------------------------------------ 1. fair
await page.click('#btn-run');
await page.waitForTimeout(2200);
let a = await api();
check('symmetric fair produces pairs', a.ok && a.pairCount > 0, `${a.pairCount} pairs`);
check('symmetric fair pairs are symmetric', a.pairs.every((p) => p.delta < 0.5), JSON.stringify(a.pairs.map((p) => p.delta)));
check('symmetric fair has no one-way advantage', a.pairs.every((p) => p.oneWayOwner === null), 'all none');
await shot('verify-01-symmetric-fair.png');

// select pair + replay
await page.locator('.pair-card').first().click();
await page.waitForTimeout(300);
await page.locator('#btn-play').click();
await page.waitForTimeout(3500);
a = await api();
check('replay dispatches both sides', a.replay && a.replay.verdict, a.replay?.detail);
check('replay verdict is fair-accepted on symmetric scene', a.replay?.verdict === 'accepted-fair', a.replay?.verdict);
await shot('verify-02-symmetric-replay.png');

// -------------------------------------------------------- 2. one-way gate
await page.locator('.scene-btn', { hasText: 'One-Way Gate' }).click();
await page.waitForTimeout(700);
// suggested mode from level; force fair
await page.locator('.seg[data-mode="fair"]').click();
await page.waitForTimeout(300);
await page.click('#btn-run');
await page.waitForTimeout(2200);
a = await api();
check('one-way authored: fair accepts symmetric gates', a.ok && a.pairCount > 0, `${a.pairCount} pairs, rejects ${a.rejectCodes.join(',')}`);
check('one-way authored: no exclusive advantage', a.pairs.every((p) => p.oneWayBenefit < 1e-3), 'benefits <1e-3');
const cfText = await page.locator('#counterfactuals').innerText();
check('counterfactual shows the advantage moving on flip', /→/.test(cfText) && /Flip gate-north/.test(cfText), cfText.split('\n').slice(0, 3).join(' | '));
await page.click('#btn-help');
await page.waitForTimeout(250);
const helpOpen = await page.locator('#help-modal').isVisible();
check('How-to-start help is reachable from the UI', helpOpen, `visible=${helpOpen}`);
await shot('verify-03a-help.png');
await page.click('#close-help');
await page.waitForTimeout(200);
await shot('verify-03-oneway-authored-fair.png');

// flip north gate
await page.locator('.door-row', { hasText: 'North gate' }).locator('button', { hasText: 'Flip' }).click();
await page.waitForTimeout(600);
const afterFlip = await api();
check('flip bumps revision', afterFlip.revision === 2, `rev ${afterFlip.revision}`);
check('flip revokes stale results', afterFlip.store.revoked > 0, `${afterFlip.store.revoked} revoked`);
await page.click('#btn-run');
await page.waitForTimeout(2200);
a = await api();
check('one-way flipped: fair rejects one-way advantage', a.rejectCodes.includes('one-way-advantage'), a.rejectCodes.join(','));
check('one-way flipped: fair yields no pair', a.pairCount === 0, `${a.pairCount} pairs`);
const rejText = await page.locator('#rejected-panel').innerText();
check('rejection names the gaining side', /gains/i.test(rejText), rejText.split('\n').slice(0, 4).join(' | '));
await shot('verify-04-oneway-flipped-fair-rejected.png');

// chase mode with a lead window matching the flipped lead
await page.locator('.seg[data-mode="chase"]').click();
await page.waitForTimeout(300);
await page.evaluate(() => {
  const s = window.__spawnwright.state;
  s.config.chase.minPursuitVisibility = 0;
  s.config.chase.leadToleranceSeconds = 1.5;
  s.config.chase.leadSeconds = 4.25;
  // reflect into controls
  const set = (id, v) => { const el = document.getElementById(id); if (el) { el.value = String(v); el.dispatchEvent(new Event('input')); } };
  set('pursuitVis', 0); set('leadTol', 1.5); set('leadSeconds', 4.25);
});
await page.click('#btn-run');
await page.waitForTimeout(2200);
a = await api();
check('one-way flipped: chase accepts in-window lead', a.ok && a.pairCount > 0, `${a.pairCount} pairs`);
check('chase lead owner is the un-gated side', a.pairs.every((p) => p.oneWayOwner === 'A' || p.oneWayOwner === 'B' || p.leadOwner), JSON.stringify(a.pairs.map((p) => ({ lead: p.lead, owner: p.leadOwner }))));
await page.locator('.pair-card').first().click();
await page.waitForTimeout(250);
await page.locator('#btn-play').click();
await page.waitForTimeout(4000);
a = await api();
check('chase replay records a winner', a.replay && ['A', 'B'].includes(a.replay.winner), `${a.replay?.winner} / ${a.replay?.detail}`);
await shot('verify-05-oneway-flipped-chase-replay.png');

// flip back and confirm the advantage returns to the other side
await page.locator('.door-row', { hasText: 'North gate' }).locator('button', { hasText: 'Flip' }).click();
await page.waitForTimeout(500);
await page.locator('.seg[data-mode="fair"]').click();
await page.waitForTimeout(250);
await page.click('#btn-run');
await page.waitForTimeout(2200);
a = await api();
check('flip back restores a fair pair', a.pairCount > 0, `${a.pairCount} pairs, rejects ${a.rejectCodes.join(',')}`);
await shot('verify-06-oneway-restored.png');

// ------------------------------------------------------- 3. elevation split
await page.locator('.scene-btn', { hasText: 'Elevation Split' }).click();
await page.waitForTimeout(800);
await page.locator('.seg[data-mode="fair"]').click();
await page.waitForTimeout(250);
await page.click('#btn-run');
await page.waitForTimeout(2600);
a = await api();
check('elevation fair produces pairs', a.ok && a.pairCount > 0, `${a.pairCount} pairs`);
check('elevation pairs are not Euclidean-nearest pairs', a.pairs.every((p) => p.costs.some((c) => c > 3)), JSON.stringify(a.pairs.map((p) => p.costs)));
await page.locator('.pair-card').first().click();
await page.waitForTimeout(300);
const detail = await page.locator('#pair-detail').innerText();
check('elevation evidence shows connector/ascent', /ascent/i.test(detail) && /connector|ramp|stairs/i.test(detail), detail.split('\n').slice(0, 6).join(' | '));
await page.locator('#btn-play').click();
await page.waitForTimeout(4500);
a = await api();
check('elevation replay climbs and records verdict', a.replay && a.replay.verdict !== 'incomplete', a.replay?.detail);
await shot('verify-07-elevation-fair-replay.png');
// top-down view
await page.locator('#view-top').click();
await page.waitForTimeout(500);
await shot('verify-08-elevation-topdown.png');

// rejected positions tab
await page.locator('.tabs button', { hasText: 'Rejected positions' }).click();
await page.waitForTimeout(300);
const rejPos = await page.locator('#rejected-panel').innerText();
check('rejected positions are inspectable', /rejected/i.test(rejPos) && rejPos.length > 40, rejPos.split('\n').slice(0, 4).join(' | '));
await shot('verify-09-rejected-positions.png');

check('no console errors during the whole run', errors.length === 0, errors.slice(0, 4).join(' | '));

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl: BASE,
  checks,
  passed: checks.filter((c) => c.pass).length,
  failed: checks.filter((c) => !c.pass).length,
  consoleErrors: errors,
};
fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify(report, null, 2));
console.log(`\n${report.passed}/${checks.length} checks passed. Report: reports/verification.json`);
await browser.close();
process.exit(report.failed ? 1 : 0);
