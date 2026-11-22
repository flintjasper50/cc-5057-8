import './styles.css';
import { createScene, sceneHash, flipDoor, doorSolids, cloneScene, floorById, activityClearance } from './core/scene.js';
import { builtinScenes } from './core/levels.js';
import { planSpawns, replayPair, DEFAULT_CONFIG, resolveConfig } from './core/engine.js';
import { EvidenceStore } from './core/evidence.js';
import { Viewport } from './ui/viewport.js';
import {
  renderPairList, renderPairDetail, renderSuggestions, renderRunStatus,
  renderRejected, renderCounterfactuals, renderLog, renderSceneLogStatus,
} from './ui/panels.js';

const state = {
  sceneIndex: 0,
  scene: null,
  plan: null,
  selectedPairId: null,
  replay: null,
  mode: 'fair',
  config: structuredClone(DEFAULT_CONFIG),
  store: new EvidenceStore(),
  rejectedTab: 'pairs',
  view: 'persp',
};

const el = {
  viewport: document.getElementById('viewport'),
  sceneList: document.getElementById('scene-list'),
  sceneBlurb: document.getElementById('scene-blurb'),
  sceneHash: document.getElementById('scene-hash'),
  revision: document.getElementById('revision'),
  runBtn: document.getElementById('btn-run'),
  modeHelp: document.getElementById('mode-help'),
  pairList: document.getElementById('pair-list'),
  pairDetail: document.getElementById('pair-detail'),
  runStatus: document.getElementById('run-status'),
  suggestions: document.getElementById('suggestions'),
  rejected: document.getElementById('rejected-panel'),
  log: document.getElementById('scene-log'),
  statusLeft: document.getElementById('status-left'),
  statusRight: document.getElementById('status-right'),
  stageStatus: document.getElementById('stage-status'),
  doorControls: document.getElementById('door-controls'),
  replayBar: document.getElementById('replay-bar'),
  replayScrub: document.getElementById('replay-scrub'),
  replayTime: document.getElementById('replay-time'),
  counterfactuals: document.getElementById('counterfactuals'),
  help: document.getElementById('help-modal'),
};

const viewport = new Viewport(el.viewport);

// ---- scene ---------------------------------------------------------------

function loadScene(index, { keepMode = true } = {}) {
  state.sceneIndex = index;
  const raw = builtinScenes[index];
  state.scene = createScene(raw);
  state.plan = null;
  state.selectedPairId = null;
  state.replay = null;
  if (!keepMode && raw.suggested?.mode) {
    state.mode = raw.suggested.mode;
  }
  applySuggestedConfig(raw);
  viewport.buildScene(state.scene);
  syncSceneChrome();
  renderSceneList();
  renderDoorControls();
  resetResultPanels();
  document.body.dataset.mode = state.mode;
  syncModeUI();
  setStatus(`Loaded "${raw.name}" (rev ${state.scene.revision}).`);
}

function applySuggestedConfig(raw) {
  const s = raw.suggested;
  if (!s) return;
  if (s.mode) state.mode = s.mode;
  if (s.chase) state.config.chase = { ...state.config.chase, ...s.chase };
}

function syncSceneChrome() {
  el.sceneHash.textContent = sceneHash(state.scene);
  el.revision.textContent = `rev ${state.scene.revision}`;
}

function renderSceneList() {
  el.sceneList.innerHTML = '';
  builtinScenes.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.className = 'scene-btn' + (i === state.sceneIndex ? ' active' : '');
    btn.innerHTML = `<span class="sn">${s.name}</span><span class="sd">${s.id}</span>`;
    btn.addEventListener('click', () => loadScene(i));
    el.sceneList.appendChild(btn);
  });
  el.sceneBlurb.textContent = builtinScenes[state.sceneIndex].blurb;
}

function renderDoorControls() {
  el.doorControls.innerHTML = '';
  const doors = doorSolids(state.scene);
  if (!doors.length) {
    el.doorControls.innerHTML = '<div class="muted small">This scene has no doors to flip.</div>';
    return;
  }
  for (const door of doors) {
    const row = document.createElement('div');
    row.className = 'door-row';
    const dirLabel = door.door.kind === 'two-way'
      ? 'two-way'
      : (door.door.allowedSign > 0 ? 'one-way +axis ⇢' : 'one-way −axis ⇠');
    row.innerHTML = `<div class="di"><span class="dn">${door.label ?? door.id}</span><span class="ds">${door.door.kind} · ${door.door.state}</span></div>
      <span class="dir">${dirLabel}</span>`;
    if (door.door.kind === 'one-way') {
      const btn = document.createElement('button');
      btn.className = 'mini';
      btn.textContent = 'Flip';
      btn.addEventListener('click', () => flipDoorInScene(door.id));
      row.appendChild(btn);
    }
    el.doorControls.appendChild(row);
  }
}

function flipDoorInScene(id) {
  state.scene = flipDoor(state.scene, id);
  state.plan = null;
  state.selectedPairId = null;
  state.replay = null;
  viewport.buildScene(state.scene);
  syncSceneChrome();
  renderDoorControls();
  resetResultPanels();
  // Revoke is immediate: results measured on the old revision cannot be trusted.
  state.store.revokeAll(`door ${id} flipped, revision ${state.scene.revision}`);
  renderLog(el.log, state.store);
  renderSceneLogStatus(el.statusRight, state.store);
  setStatus(`Flipped ${id}. Revision ${state.scene.revision}. Old results revoked — run again.`);
}

// ---- mode ----------------------------------------------------------------

function setMode(mode) {
  state.mode = mode;
  state.plan = null;
  state.selectedPairId = null;
  state.replay = null;
  document.body.dataset.mode = mode;
  syncModeUI();
  resetResultPanels();
  setStatus(`Mode: ${mode === 'fair' ? 'fair opening' : 'asymmetric chase'}. Run design to evaluate.`);
}

function syncModeUI() {
  document.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  el.modeHelp.textContent = state.mode === 'fair'
    ? 'Both sides are run once. One-way advantages are detected with a door-neutral control and rejected. Pairs must land within the cost delta.'
    : 'One side is intended to lead. The lead is compared against the configured window, and the fair-mode reading is still reported alongside.';
}

// ---- controls ------------------------------------------------------------

function bindRange(id, get, set, fmt = (v) => v) {
  const input = document.getElementById(id);
  const out = document.getElementById(`o-${id}`);
  const sync = () => {
    const v = Number(input.value);
    set(v);
    out.textContent = fmt(v);
  };
  input.value = get();
  out.textContent = fmt(get());
  input.addEventListener('input', sync);
  return input;
}

function bindConfigControls() {
  bindRange('candPerZone', () => state.config.candidatesPerZone, (v) => { state.config.candidatesPerZone = v; });
  bindRange('minClearance', () => state.config.limits.minClearance, (v) => { state.config.limits.minClearance = v; }, (v) => `${v.toFixed(1)}m`);
  bindRange('minPairSep', () => state.config.limits.minPairSeparation, (v) => { state.config.limits.minPairSeparation = v; }, (v) => `${v}m`);
  bindRange('maxDelta', () => state.config.limits.maxPathCostDelta, (v) => { state.config.limits.maxPathCostDelta = v; }, (v) => `${v.toFixed(2)}s`);
  bindRange('leadSeconds', () => state.config.chase.leadSeconds, (v) => { state.config.chase.leadSeconds = v; }, (v) => `${v.toFixed(2)}s`);
  bindRange('leadTol', () => state.config.chase.leadToleranceSeconds, (v) => { state.config.chase.leadToleranceSeconds = v; }, (v) => `±${v.toFixed(2)}s`);
  bindRange('pursuitVis', () => state.config.chase.minPursuitVisibility, (v) => { state.config.chase.minPursuitVisibility = v; }, (v) => `${Math.round(v * 100)}%`);
  bindRange('wParity', () => state.config.weights.approachParity, (v) => { state.config.weights.approachParity = v; }, (v) => v.toFixed(1));
  bindRange('wConceal', () => state.config.weights.concealment, (v) => { state.config.weights.concealment = v; }, (v) => v.toFixed(1));
  bindRange('wClearance', () => state.config.weights.clearance, (v) => { state.config.weights.clearance = v; }, (v) => v.toFixed(1));
  bindRange('wExposure', () => state.config.weights.routeExposure, (v) => { state.config.weights.routeExposure = v; }, (v) => v.toFixed(1));

  const oneWay = document.getElementById('rejectOneWay');
  oneWay.checked = state.config.limits.rejectOneWayFair;
  oneWay.addEventListener('change', () => { state.config.limits.rejectOneWayFair = oneWay.checked; });
  const sight = document.getElementById('rejectSightline');
  sight.checked = state.config.limits.rejectMutualVisibilityFair;
  sight.addEventListener('change', () => { state.config.limits.rejectMutualVisibilityFair = sight.checked; });

  document.querySelectorAll('.seg').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  el.runBtn.addEventListener('click', runDesign);
}

// ---- run -----------------------------------------------------------------

function runDesign() {
  const t0 = performance.now();
  setStatus('Running design…');
  el.runBtn.disabled = true;
  // Yield one frame so the status paints before the synchronous kernel runs.
  requestAnimationFrame(() => {
    try {
      const plan = planSpawns(state.scene, { ...state.config, mode: state.mode });
      state.plan = plan;
      state.replay = null;
      state.selectedPairId = plan.pairs?.[0]?.id ?? null;
      state.store.beginScene(state.scene, plan);
      state.store.recordPairs(plan);
      viewport.showPlan(state.scene, plan);
      if (state.selectedPairId) {
        const pair = plan.pairs.find((p) => p.id === state.selectedPairId);
        viewport.focusPair(pair);
      }
      renderResults();
      renderLog(el.log, state.store);
      renderSceneLogStatus(el.statusRight, state.store);
      const dt = performance.now() - t0;
      setStatus(plan.ok
        ? `Design complete in ${dt.toFixed(0)}ms — ${plan.pairs.length} pair(s), ${plan.pairRejections.length} rejected.`
        : `No usable pair in ${dt.toFixed(0)}ms — see the suggestions in the result rail.`);
      el.stageStatus.textContent = sceneHash(state.scene);
    } catch (err) {
      console.error(err);
      setStatus(`Run failed: ${err.message}`);
      el.runStatus.innerHTML = `<span class="bad">Run failed:</span> ${escapeHtml(err.message)}`;
    } finally {
      el.runBtn.disabled = false;
    }
  });
}

function renderResults() {
  const plan = state.plan;
  renderRunStatus(el.runStatus, plan, state.store);
  renderSuggestions(el.suggestions, plan);
  renderPairList(el.pairList, plan, state.selectedPairId, selectPair);
  renderRejectedPanel();
  renderCounterfactuals(el.counterfactuals, plan);
  if (plan?.ok) {
    const pair = plan.pairs.find((p) => p.id === state.selectedPairId);
    renderPairDetail(el.pairDetail, plan, pair, { replay: state.replay });
    el.replayBar.classList.remove('hidden');
    setStatus(`Selected ${pair.id}. Play the replay to dispatch both characters.`);
  } else {
    el.pairDetail.className = 'pair-detail muted';
    el.pairDetail.textContent = 'No pair to inspect. Read the suggestions, adjust conditions, or switch mode.';
    el.replayBar.classList.add('hidden');
  }
}

function renderRejectedPanel() {
  renderRejected(el.rejected, state.plan, {
    ...state,
    onRejectedTab: (tab) => {
      state.rejectedTab = tab;
      renderRejectedPanel();
    },
  });
}

function selectPair(id) {
  if (!state.plan) return;
  state.selectedPairId = id;
  const pair = state.plan.pairs.find((p) => p.id === id);
  if (!pair) return;
  renderPairList(el.pairList, state.plan, id, selectPair);
  viewport.focusPair(pair);
  state.replay = null;
  renderPairDetail(el.pairDetail, state.plan, pair, { replay: null });
  el.replayBar.classList.remove('hidden');
  el.replayScrub.value = '0';
}

function resetResultPanels() {
  renderRunStatus(el.runStatus, null, state.store);
  renderSuggestions(el.suggestions, null);
  el.pairList.innerHTML = '';
  el.pairDetail.className = 'pair-detail muted';
  el.pairDetail.textContent = 'No pair selected.';
  renderRejected(el.rejected, null, state);
  el.replayBar.classList.add('hidden');
  el.stageStatus.textContent = sceneHash(state.scene);
  viewport.clearOverlay();
  renderCounterfactuals(el.counterfactuals, null);
}

// ---- replay --------------------------------------------------------------

function ensureReplay() {
  if (!state.plan?.ok || !state.selectedPairId) return null;
  const current = state.replay;
  if (current && current.pairId === state.selectedPairId && current.sceneHash === sceneHash(state.scene)) return current;
  const replay = replayPair(state.scene, state.plan, state.selectedPairId);
  state.replay = replay;
  state.store.recordReplay(replay);
  renderLog(el.log, state.store);
  renderSceneLogStatus(el.statusRight, state.store);
  const pair = state.plan.pairs.find((p) => p.id === state.selectedPairId);
  renderPairDetail(el.pairDetail, state.plan, pair, { replay });
  el.replayScrub.max = String(replay.sides.A.arrivalTime ?? 1);
  return replay;
}

function playReplay() {
  const replay = ensureReplay();
  if (!replay) return;
  if (replay.verdict === 'rejected-by-replay') {
    setStatus(`Replay contradicts the fair limit: ${replay.verdictDetail}. The pair is flagged, not hidden.`);
  } else if (replay.verdict === 'chase-recorded') {
    setStatus(`Replay: ${replay.verdictDetail}.`);
  }
  viewport.playReplay(replay, (t, duration) => {
    el.replayScrub.value = String(t);
    el.replayTime.textContent = `${t.toFixed(2)}s`;
    if (t >= duration) el.replayTime.textContent = `${t.toFixed(2)}s · done`;
  });
}

function bindReplay() {
  document.getElementById('btn-play').addEventListener('click', playReplay);
  document.getElementById('btn-step').addEventListener('click', () => {
    const replay = ensureReplay();
    if (!replay) return;
    const duration = Math.max(replay.sides.A.arrivalTime ?? 0, replay.sides.B.arrivalTime ?? 0, 0.1);
    const t = Math.min(duration, Number(el.replayScrub.value) + 0.25);
    el.replayScrub.value = String(t);
    el.replayTime.textContent = `${t.toFixed(2)}s`;
    viewport.setReplayTime(t);
  });
  el.replayScrub.addEventListener('input', () => {
    const replay = state.replay;
    if (!replay) return;
    const t = Number(el.replayScrub.value);
    el.replayTime.textContent = `${t.toFixed(2)}s`;
    viewport.setReplayTime(t);
  });
}

// ---- view buttons & status ----------------------------------------------

function bindViewControls() {
  document.getElementById('view-persp').addEventListener('click', () => setView('persp'));
  document.getElementById('view-top').addEventListener('click', () => setView('top'));
  document.getElementById('view-reset').addEventListener('click', () => {
    viewport.setView(state.view, true);
  });
  viewport.renderer.domElement.addEventListener('dblclick', (ev) => {
    const hit = viewport.pickAt(ev.clientX, ev.clientY);
    if (hit?.type === 'pair') selectPair(hit.id);
    if (hit?.type === 'candidate' || hit?.type === 'rejected') {
      if (hit.type === 'rejected') {
        const reason = findRejectedReason(state.plan, hit.id);
        viewport.highlightRejected(hit.id, true);
        setStatus(`Rejected ${hit.id}: ${reason ?? 'see the rejected-positions tab for the recorded reason.'}`);
      } else {
        setStatus(`Candidate ${hit.id} — its evidence is listed under the selected pair or the rejected tab.`);
      }
    }
  });
}

function setView(mode) {
  state.view = mode;
  document.getElementById('view-persp').classList.toggle('active', mode === 'persp');
  document.getElementById('view-top').classList.toggle('active', mode === 'top');
  viewport.setView(mode, true);
}

function setStatus(text) {
  el.statusLeft.textContent = text;
}

function findRejectedReason(plan, id) {
  for (const zr of plan?.zoneReports ?? []) {
    const found = (zr.candidatesRaw?.rejected ?? []).find((c) => c.id === id);
    if (found) return found.blockedReason;
  }
  return null;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---- bootstrap -----------------------------------------------------------

bindConfigControls();
bindViewControls();
bindReplay();
document.getElementById('close-help').addEventListener('click', () => el.help.classList.add('hidden'));
document.getElementById('btn-help').addEventListener('click', () => el.help.classList.remove('hidden'));
document.addEventListener('keydown', (e) => {
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    el.help.classList.toggle('hidden');
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runDesign();
});

loadScene(0);
renderLog(el.log, state.store);
renderSceneLogStatus(el.statusRight, state.store);
document.getElementById('help-modal').classList.add('hidden');

// Expose a small handle for the automated verification harness.
window.__spawnwright = {
  get state() { return state; },
  get plan() { return state.plan; },
  runDesign,
  selectPair,
  playReplay,
  loadScene,
  flipDoor: flipDoorInScene,
  setMode,
  viewport,
};
