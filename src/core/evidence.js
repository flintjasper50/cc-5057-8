import { sceneHash } from './scene.js';

// A small store that keeps evidence alongside the scene revision it was
// measured against. When the scene changes, stale candidates are revoked
// rather than silently reused: the UI must show the revoke, not pretend the
// old scores still hold.
export class EvidenceStore {
  constructor() {
    this.sceneHash = null;
    this.revision = null;
    this.candidates = new Map();   // id -> record
    this.revoked = [];             // records revoked by a scene change
    this.pairs = new Map();
    this.replays = new Map();
    this.log = [];
  }

  beginScene(scene, plan) {
    const hash = sceneHash(scene);
    if (this.sceneHash && this.sceneHash !== hash) {
      this.revokeAll(`scene changed ${this.sceneHash} -> ${hash} (revision ${this.revision} -> ${scene.revision})`);
    }
    this.sceneHash = hash;
    this.revision = scene.revision;
    if (!plan?.zoneReports) return;
    for (const zr of plan.zoneReports) {
      for (const cand of zr.candidates) {
        const existing = this.candidates.get(cand.id);
        const record = {
          ...cand,
          sceneHash: hash,
          revision: scene.revision,
          firstSeenAt: existing?.firstSeenAt ?? plan.generatedAt,
          lastSeenAt: plan.generatedAt,
          state: existing ? 'retained' : 'new',
          // Keep evidence snapshots keyed by scene hash so a conflicting pair
          // of verdicts (visible at one epoch, concealed at another) survives.
          evidenceHistory: mergeHistory(existing?.evidenceHistory, cand.evidence, hash),
        };
        this.candidates.set(cand.id, record);
      }
    }
    this.log.push({ at: plan.generatedAt, kind: 'plan', sceneHash: hash, revision: scene.revision, mode: plan.mode, ok: plan.ok });
  }

  recordPairs(plan) {
    if (!plan?.pairs) return;
    for (const pair of plan.pairs) {
      this.pairs.set(pair.id, {
        ...pair,
        sceneHash: plan.sceneHash,
        revision: plan.revision,
      });
    }
  }

  recordReplay(replay) {
    this.replays.set(`${replay.pairId}@${replay.sceneHash}`, replay);
    this.log.push({ at: new Date().toISOString(), kind: 'replay', sceneHash: replay.sceneHash, pairId: replay.pairId, verdict: replay.verdict });
  }

  revokeAll(reason) {
    for (const [id, rec] of this.candidates) {
      if (rec.state !== 'revoked') {
        this.revoked.push({ ...rec, state: 'revoked', revokedAt: new Date().toISOString(), revokeReason: reason });
        this.candidates.delete(id);
      }
    }
    this.pairs.clear();
    this.log.push({ at: new Date().toISOString(), kind: 'revoke-all', reason });
  }

  revoke(id, reason) {
    const rec = this.candidates.get(id);
    if (!rec) return null;
    const revoked = { ...rec, state: 'revoked', revokedAt: new Date().toISOString(), revokeReason: reason };
    this.revoked.push(revoked);
    this.candidates.delete(id);
    return revoked;
  }

  allEvidenceFor(candidateId) {
    const live = this.candidates.get(candidateId);
    const revoked = this.revoked.filter((r) => r.id === candidateId);
    return { live: live ?? null, revoked };
  }

  summary() {
    return {
      sceneHash: this.sceneHash,
      revision: this.revision,
      live: this.candidates.size,
      revoked: this.revoked.length,
      pairs: this.pairs.size,
      replays: this.replays.size,
      log: this.log.slice(-12),
    };
  }
}

function mergeHistory(history, evidence, hash) {
  const next = history ? [...history] : [];
  if (!evidence) return next;
  const existing = next.find((h) => h.sceneHash === hash);
  if (existing) return next;
  next.push({ sceneHash: hash, evidence: evidence.map((e) => ({ ...e })) });
  return next;
}
