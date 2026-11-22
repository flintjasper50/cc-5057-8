export function renderPairList(el, plan, selectedId, onSelect) {
  el.innerHTML = '';
  if (!plan?.ok) return;
  for (const pair of plan.pairs) {
    const card = document.createElement('div');
    card.className = 'pair-card' + (pair.id === selectedId ? ' active' : '');
    const badge = plan.mode === 'fair'
      ? '<span class="badge fair">fair</span>'
      : '<span class="badge chase">chase</span>';
    const conflict = pair.conflicts?.length ? '<span class="badge warn">sight conflict</span>' : '';
    card.innerHTML = `
      <div class="pt"><span class="pid">${escapeHtml(pair.a)} ↔ ${escapeHtml(pair.b)}</span>${badge}</div>
      <div class="pmeta">
        <span>Δ <b>${fmt(pair.metrics.delta)}s</b></span>
        <span>lead <b>${fmt(pair.metrics.leadSeconds)}s</b></span>
        <span>sep <b>${fmt(pair.metrics.separation)}m</b></span>
        <span>${pair.mutualVisibility ? 'visible' : 'concealed'}</span>
        <span>${conflict}</span>
      </div>
    `;
    card.addEventListener('click', () => onSelect(pair.id));
    el.appendChild(card);
  }
}

export function renderCounterfactuals(el, plan) {
  el.innerHTML = '';
  if (!plan) {
    el.innerHTML = '<div class="muted small">Run a design to see which side inherits the lead if a one-way door is flipped.</div>';
    return;
  }
  const cfs = plan.counterfactuals ?? [];
  if (!cfs.length) {
    const hasDoors = plan.config && plan.zoneReports; // plan exists
    const summary = plan.counterfactualsUnavailable;
    el.innerHTML = `<div class="muted small">${escapeHtml(summary ?? (hasDoors ? 'No accepted pair to compare against a door flip.' : 'No one-way doors in this scene.'))}</div>`;
    return;
  }
  for (const cf of cfs) {
    const g = document.createElement('div');
    g.className = 'rej-group';
    const rows = cf.pairs.map((p) => `<li>${escapeHtml(p.pairId)}: leader <b>${p.previousLeader ?? '—'}</b> → <b>${p.leader}</b> · Δ ${fmt(p.delta)}s · <span class="badge ${p.verdict === 'legal' ? 'fair' : 'bad'}">${escapeHtml(p.verdict)}</span></li>`).join('');
    g.innerHTML = `<div class="rg"><span>Flip ${escapeHtml(cf.doorId)} (${cf.fromSign > 0 ? '+' : '−'} → ${cf.toSign > 0 ? '+' : '−'})</span></div>
      <div class="muted small" style="margin-top:3px">${escapeHtml(cf.advantageMovedTo)}</div>
      <ul>${rows || '<li>No pair survives the flip.</li>'}</ul>`;
    el.appendChild(g);
  }
}

export function renderPairDetail(el, plan, pair, options = {}) {  if (!pair) {
    el.className = 'pair-detail muted';
    el.textContent = 'No pair selected.';
    return;
  }
  el.className = 'pair-detail';
  const s = pair.scores;
  const components = s.components.map((c) => `
    <div class="score-row">
      <div class="sl" title="${escapeHtml(c.note)}">${escapeHtml(c.label)} <span class="muted">×${c.weight}</span></div>
      <div class="sb"><i style="width:${Math.round(c.score * 100)}%"></i></div>
      <div class="sv">${fmt(c.score)}</div>
    </div>`).join('');

  const ev = [...(pair.evidence ?? []), ...(pair.doorEvidence ?? [])];
  const evidence = ev.map((e) => `
    <div class="evidence ${e.source.startsWith('nav') ? 'nav' : 'geom'}">
      <div class="es">${escapeHtml(e.source)} · ${escapeHtml(e.verdict)}</div>
      <div class="ed">${escapeHtml(e.detail)}</div>
      <div class="eq">${escapeHtml(JSON.stringify(e.query))}</div>
    </div>`).join('');

  const conflicts = (pair.conflicts ?? []).map((c) => `<div class="conflict"><b>Evidence conflict:</b> ${escapeHtml(c.detail)}</div>`).join('');

  const routes = pair.candidates.map((c, i) => {
    const r = c.routes?.[0];
    const side = i === 0 ? 'A' : 'B';
    if (!r) return '';
    const usage = [
      r.connectors?.length ? `connectors: ${r.connectors.join(', ')}` : 'no connector (same level)',
      r.ascent ? `climb: ${fmt(r.ascent)}m` : 'level route',
      r.crossings?.length ? `doors: ${r.crossings.map((d) => `${d.solidId}(${d.allowed ? 'allowed' : 'blocked'})`).join(', ')}` : 'no door',
    ].join(' · ');
    return `<div class="evidence ${r.ascent ? 'nav' : 'geom'}" style="margin-top:4px">
      <div class="es">route ${side} → ${escapeHtml(r.zoneId)}</div>
      <div class="ed">${escapeHtml(usage)}</div>
      <div class="eq">${r.length2D !== null ? `${fmt(r.length2D)}m path, cost ${fmt(r.cost)}s` : 'unreachable'}</div>
    </div>`;
  }).join('');

  const replayInfo = options.replay ? renderReplayInfo(options.replay) : '';

  el.innerHTML = `
    <div class="pmeta" style="flex-wrap:wrap;gap:10px;margin-bottom:6px">
      <span>A <b>${escapeHtml(pair.a)}</b></span><span>B <b>${escapeHtml(pair.b)}</b></span>
    </div>
    <div class="pmeta" style="flex-wrap:wrap;gap:10px">
      <span>cost A <b>${fmt(pair.metrics.costA)}s</b></span>
      <span>cost B <b>${fmt(pair.metrics.costB)}s</b></span>
      <span>ascent A <b>${fmt(pair.metrics.ascentA)}m</b></span>
      <span>ascent B <b>${fmt(pair.metrics.ascentB)}m</b></span>
    </div>
    <div class="pmeta" style="margin-top:6px">
      <span>one-way owner: <b>${pair.advantage.oneWayAdvantageOwner ?? 'none'}</b></span>
      <span>leader: <b>${pair.advantage.leader ?? '—'}</b></span>
    </div>
    ${conflicts}
    <h3>Soft score components <span class="muted small">(ranking only, not a fairness proof)</span></h3>
    ${components}
    <div class="muted small" style="margin:4px 0 8px">normalised preference ${fmt(s.normalized)} — ${escapeHtml(s.disclaimer)}</div>
    <h3>Evidence (re-checkable queries)</h3>
    <div class="evidence-list">${evidence || '<div class="muted small">No evidence records.</div>'}</div>
    <h3>Route provenance</h3>
    ${routes}
    ${replayInfo}
  `;
}

function renderReplayInfo(r) {
  const rows = ['A', 'B'].map((side) => {
    const s = r.sides[side];
    return `<div class="pmeta" style="gap:8px;margin:2px 0">
      <span><b>${side}</b></span>
      <span>arrival <b>${fmt(s.arrivalTime)}s</b></span>
      <span>${s.doors.length ? `${s.doors.length} door` : 'no door'}</span>
      <span>${s.connectors.length ? s.connectors.join(',') : 'level'}</span>
    </div>`;
  }).join('');
  const firstVis = r.firstVisibility ? `first mutual sight at ${fmt(r.firstVisibility.t)}s` : 'no mutual sight along sampled route';
  const cls = r.verdict === 'accepted-fair' ? 'fair' : r.verdict === 'rejected-by-replay' ? 'bad' : 'chase';
  return `
    <h3>Replay (both characters dispatched)</h3>
    ${rows}
    <div style="margin:6px 0"><span class="badge ${cls}">${escapeHtml(r.verdict)}</span> ${escapeHtml(r.verdictDetail ?? '')}</div>
    <div class="muted small">${escapeHtml(firstVis)}. Winner: ${r.winner ?? '—'}.</div>
  `;
}

export function renderSuggestions(el, plan) {
  el.innerHTML = '';
  if (!plan || plan.ok) return;
  const items = plan.suggestions ?? [];
  if (!items.length) {
    el.innerHTML = `<div class="suggestion"><span class="sc">No usable pair</span>${escapeHtml(plan.message ?? 'No pair survived the hard limits.')}</div>`;
    return;
  }
  for (const s of items) {
    const div = document.createElement('div');
    div.className = 'suggestion';
    div.innerHTML = `<span class="sc">${escapeHtml(s.code)}${s.count ? ` ×${s.count}` : ''}</span>${escapeHtml(s.message)}`
      + (s.evidence ? `<div class="muted small" style="margin-top:4px">${escapeHtml(s.evidence)}</div>` : '');
    el.appendChild(div);
  }
}

export function renderRunStatus(el, plan, store) {
  if (!plan) {
    el.innerHTML = 'Press <b>Run design</b> to generate candidates.';
    return;
  }
  const pairCount = plan.pairs?.length ?? 0;
  const rej = plan.pairRejections?.length ?? 0;
  const zones = plan.zoneReports?.map((z) => `${z.zoneId}: ${z.accepted}/${z.poolSize}`).join(' · ') ?? '';
  if (plan.ok) {
    el.innerHTML = `<span class="ok">${pairCount} candidate pair${pairCount === 1 ? '' : 's'}</span> for ${escapeHtml(plan.mode)} mode. ${rej} pair(s) rejected. <br><span class="muted small">${escapeHtml(zones)}</span>`;
  } else {
    el.innerHTML = `<span class="bad">No usable pair</span> in ${escapeHtml(plan.mode)} mode. ${rej} pair(s) rejected.`
      + (plan.code ? `<br><span class="muted small">${escapeHtml(plan.code)}: ${escapeHtml(plan.message ?? '')}</span>` : '');
  }
}

export function renderRejected(el, plan, state) {
  if (!plan) {
    el.className = 'rejected-panel muted';
    el.textContent = 'Run a design to inspect rejected positions.';
    return;
  }
  el.className = 'rejected-panel';
  const tab = state.rejectedTab ?? 'pairs';
  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  tabs.innerHTML = `
    <button data-tab="pairs" class="${tab === 'pairs' ? 'active' : ''}">Rejected pairs (${plan.pairRejections.length})</button>
    <button data-tab="positions" class="${tab === 'positions' ? 'active' : ''}">Rejected positions (${plan.zoneReports.reduce((n, z) => n + z.rejected, 0)})</button>
  `;
  el.innerHTML = '';
  el.appendChild(tabs);
  const body = document.createElement('div');
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '8px';
  if (tab === 'pairs') {
    if (!plan.pairRejections.length) {
      body.innerHTML = '<div class="muted small">No pair-level rejections.</div>';
    }
    for (const r of plan.pairRejections.slice(0, 40)) {
      const g = document.createElement('div');
      g.className = 'rej-group';
      g.innerHTML = `<div class="rg"><span>${escapeHtml(r.a)} ↔ ${escapeHtml(r.b)}</span><span class="muted">${r.reasons.length} reason(s)</span></div>
        <ul>${r.reasons.map((x) => `<li><b>${escapeHtml(x.code)}</b> — ${escapeHtml(x.detail)}</li>`).join('')}</ul>`;
      body.appendChild(g);
    }
    if (plan.pairRejections.length > 40) {
      body.insertAdjacentHTML('beforeend', `<div class="muted small">Showing 40 of ${plan.pairRejections.length}.</div>`);
    }
  } else {
    for (const zr of plan.zoneReports) {
      const g = document.createElement('div');
      g.className = 'rej-group';
      const groups = new Map();
      for (const cand of zr.candidatesRaw?.rejected ?? []) {
        const key = cand.blockedReason.split('(')[0].trim();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(cand);
      }
      const list = [...groups.entries()].slice(0, 6).map(([reason, list2]) =>
        `<li>${escapeHtml(reason)} — ${list2.length} position(s), e.g. ${list2.slice(0, 3).map((c) => `(${c.pos[0]}, ${c.pos[1]}) · flash`).join(' ')}</li>`).join('');
      g.innerHTML = `<div class="rg"><span>${escapeHtml(zr.zoneId)}</span><span class="muted">${zr.rejected} rejected / ${zr.poolSize}</span></div>`
        + `<ul>${list || '<li>None rejected.</li>'}</ul>`;
      body.appendChild(g);
    }
  }
  el.appendChild(body);
  tabs.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => state.onRejectedTab?.(b.dataset.tab));
  });
}

export function renderLog(el, store) {
  const entries = [...store.log].slice(-12).reverse();
  el.innerHTML = entries.map((e) => {
    if (e.kind === 'revoke-all') return `<div class="revoked">↯ revoked: ${escapeHtml(e.reason)}</div>`;
    if (e.kind === 'replay') return `<div>↻ replay ${escapeHtml(e.pairId)} → ${escapeHtml(e.verdict)}</div>`;
    return `<div>▣ plan ${escapeHtml(e.mode)} ${e.ok ? 'ok' : 'no-pair'} @ rev ${e.revision} (${e.sceneHash})</div>`;
  }).join('');
}

export function renderSceneLogStatus(el, store) {
  const s = store.summary();
  el.textContent = `${s.live} live candidates · ${s.revoked} revoked · ${s.pairs} pairs · ${s.replays} replays`;
}

function fmt(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  if (x === Infinity) return '∞';
  if (typeof x === 'number') return (Math.round(x * 100) / 100).toString();
  return String(x);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
