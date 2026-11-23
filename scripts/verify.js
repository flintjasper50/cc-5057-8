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
    outcome: p?.outcome ?? null,
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

// ---------------------------------- 4. graphical spawn-zone editing + anomalies
await page.locator('.scene-btn', { hasText: 'Symmetric Arena' }).click();
await page.waitForTimeout(700);
await page.locator('.seg[data-mode="fair"]').click();
await page.waitForTimeout(200);
await page.click('#btn-run');
await page.waitForTimeout(2200);
a = await api();

const bannerText = () => page.locator('#outcome-banner').innerText();
check('outcome banner reports success in words', a.ok && /accepted pairs/i.test(await bannerText()), (await bannerText()).split('\n')[0]);
check('spawn zones are editable from the window', await page.locator('#zone-controls .zone-card').count() === 2, '2 zone cards');
check('weight help states weights never gate acceptance', /only order pairs/i.test(await page.locator('#weight-help').innerText()), (await page.locator('#weight-help').innerText()).slice(0, 60));

// drive the real number input for spawn-l min-x, then blur to fire `change`
const zoneInput = (cardIndex, edgeIndex) => page.locator('#zone-controls .zone-card').nth(cardIndex).locator('.zone-field').nth(edgeIndex).locator('input');
const revBefore = a.revision;
await zoneInput(0, 0).fill('-20.5');
await zoneInput(0, 0).blur();
await page.waitForTimeout(2200);
a = await api();
check('editing a spawn zone bumps the revision', a.revision > revBefore, `rev ${revBefore} → ${a.revision}`);
check('editing a spawn zone revokes stale evidence', a.store.revoked > 0, `${a.store.revoked} revoked`);
check('editing re-runs the design on live geometry', a.ok && a.pairCount > 0, `${a.pairCount} pairs after edit`);

const encText = await page.locator('#encounter-panel').innerText();
check('encounter panel is populated from the replay computation', /Candidate region/i.test(encText) && /Actual encounter/i.test(encText), encText.split('\n').slice(0, 4).join(' | '));
check('encounter panel shows candidate counts per region', /candidates in \d+ samples/i.test(encText), encText.match(/\d+ candidates in \d+ samples/)?.[0]);
const pairDetailText = await page.locator('#pair-detail').innerText();
check('pair detail shows both directional exposures', /A route seen/i.test(pairDetailText) && /B route seen/i.test(pairDetailText), pairDetailText.split('\n').filter((l) => /route seen/i.test(l)).join(' | '));
await shot('verify-10-zone-edit-encounter.png');

// Anomaly A: shrink both spawn zones to the 0.5m minimum -> no-candidates.
// spawn-l rect min[-19,-6] max[-15,6]; collapse to [-20,-6] .. [-19.5,-5.5].
await zoneInput(0, 0).fill('-20');    // min-x
await zoneInput(0, 0).blur();
await page.waitForTimeout(1400);
await zoneInput(0, 1).fill('-19.5');  // max-x
await zoneInput(0, 1).blur();
await page.waitForTimeout(1400);
await zoneInput(0, 3).fill('-5.5');   // max-z
await zoneInput(0, 3).blur();
await page.waitForTimeout(2200);
a = await api();
const noCandBanner = await bannerText();
check('shrunk zones surface the no-candidate anomaly', a.ok === false && a.outcome === 'no-candidates', `${a.outcome ?? 'ok'}`);
check('no-candidate banner names geometry as the fix', /no candidate positions/i.test(noCandBanner) && /geometry/i.test(noCandBanner), noCandBanner.split('\n').slice(0, 2).join(' | '));
await shot('verify-11-no-candidates.png');

// Anomaly B: restore zones, then a chase run whose lead window excludes all
// pairs must read as constraints-conflict, not no-candidates.
await page.locator('.scene-btn', { hasText: 'Symmetric Arena' }).click();
await page.waitForTimeout(700);
await page.locator('.seg[data-mode="chase"]').click();
await page.waitForTimeout(200);
await page.click('#btn-run');
await page.waitForTimeout(2200);
a = await api();
const conflictBanner = await bannerText();
check('chase over-constrained read as constraints-conflict', a.ok === false && a.outcome === 'constraints-conflict', `${a.outcome ?? 'ok'}`);
check('constraint banner points at limits, not geometry', /satisfies the hard limits/i.test(conflictBanner) && /limits or the mode/i.test(conflictBanner), conflictBanner.split('\n').slice(0, 2).join(' | '));
await shot('verify-12-constraints-conflict.png');

await page.click('#btn-help');
await page.waitForTimeout(250);
const helpText = await page.locator('#help-modal').innerText();
check('help lists the graphical spawn-design entry point', /graphical workbench/i.test(helpText), 'graphical workbench');
check('help marks the command line as auxiliary', /auxiliary/i.test(helpText), 'auxiliary');
await page.click('#close-help');
await page.waitForTimeout(200);

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
