'use strict';
// The console's events feed, for Claude (2026-09-28).
//
// Claude used to follow a console by polling: curl a route, sleep, curl again,
// and grep a 30 MB console-<id>.log to find out what happened in between. It was
// always behind, and every look cost a round trip and a pile of tokens. So each
// console now keeps a short memory of the things worth reacting to — a login, a
// drop, a real attack on its way, a wave landing, a march home, a script ending,
// a gate moving, maintenance — each with a monotonic `seq`. /api/events hands
// back what came after a seq and, when nothing has yet, holds the request open
// until something does (a long poll), so a waiting Claude wakes the moment it
// matters instead of on its next sleep.
//
// Memory only, on purpose: a restart starts the feed over (seq from 1 again, and
// `boot` changes so a reader can tell). The logs are still the record.
//
// Everything here is pure and cheap — it runs inside the push handlers of live
// consoles, so it only diffs small arrays and never touches the game.

const MAX_EVENTS = 2000;
const MAX_WAIT_MS = 60000;

class EventRing {
  constructor(max = MAX_EVENTS) {
    this.max = max;
    this.list = [];
    this.seq = 0;
    this.boot = `${process.pid}-${Date.now().toString(36)}`;
    this.waiters = new Set();      // { types, resolve, timer }
  }

  // -> the event as stored. Never throws: a feed must not break a push handler.
  emit(type, data = {}) {
    const ev = { seq: ++this.seq, t: Date.now(), type: String(type), ...(data || {}) };
    this.list.push(ev);
    if (this.list.length > this.max) this.list.splice(0, this.list.length - this.max);
    for (const w of [...this.waiters]) {
      if (w.types && !w.types.has(ev.type)) continue;
      this.waiters.delete(w);
      clearTimeout(w.timer);
      try { w.resolve(); } catch { /* the request went away */ }
    }
    return ev;
  }

  // Events after `since`, of `types` (a Set, or null for all), at most `limit`.
  since(since = 0, types = null, limit = 500) {
    const s = Number(since) || 0;
    // A reader holding a seq from before a restart would otherwise wait forever
    // for numbers this process has not reached yet.
    const from = s > this.seq ? 0 : s;
    const out = [];
    for (const ev of this.list) {
      if (ev.seq <= from) continue;
      if (types && !types.has(ev.type)) continue;
      out.push(ev);
    }
    return out.length > limit ? out.slice(-limit) : out;
  }

  // Resolves with since(...) as soon as there is anything, or after waitMs.
  async wait(since = 0, types = null, waitMs = 0, limit = 500) {
    const now = this.since(since, types, limit);
    const ms = Math.max(0, Math.min(MAX_WAIT_MS, Number(waitMs) || 0));
    if (now.length || !ms) return now;
    await new Promise((resolve) => {
      const w = { types, resolve };
      w.timer = setTimeout(() => { this.waiters.delete(w); resolve(); }, ms);
      this.waiters.add(w);
    });
    return this.since(since, types, limit);
  }

  // What /api/events answers with.
  view(events) {
    return { ok: true, boot: this.boot, seq: this.seq, oldest: this.list.length ? this.list[0].seq : null, events };
  }
}

// "a,b , c" -> Set | null
function typeSet(v) {
  const list = String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? new Set(list) : null;
}

// ---- army lists --------------------------------------------------------------
// Both lists arrive WHOLE on every push (session.js wire), so what changed is
// worked out by keeping the previous one keyed by army id.

const MISSION = { 1: 'transport', 2: 'reinforce', 3: 'scout', 4: 'construct', 5: 'attack' };
const DIRECTION = { 1: 'out', 2: 'back', 3: 'camped' };

// TroopStrBean values are STRINGS and an unscouted army sends "?": null means
// unknown, never zero (the same trap engine.js inboundArmy documents).
function troopTotal(a) {
  const troop = (a && (a.troop || a.troops)) || {};
  let total = 0, any = false;
  if (typeof troop !== 'object') return null;
  for (const v of Object.values(troop)) {
    const s = String(v ?? '').trim().replace(/[,\s]/g, '');
    if (!/^\d+$/.test(s)) continue;
    total += parseInt(s, 10); any = true;
  }
  return any ? total : null;
}

const keyOf = (a) => (a && a.armyId !== undefined && a.armyId !== null ? String(a.armyId) : `${a && a.startPosName}@${a && a.reachTime}`);

// Hostile armies at our cities: which arrived since the last push, and which
// left the list — landed (their time was up) or turned back.
//   prev: Map key -> summary (from the last call), or null
//   castles: [{ id, name, fieldId }]
//   isReal(summary, castleId) -> bool: the junk filter (attacks.js when there,
//     else "attack mission and not known to be tiny")
// -> { next: Map, events: [{type, ...}] }
function diffEnemy(prev, armies, castles, { now = Date.now(), isReal = null, junkLine = 1000 } = {}) {
  const byField = new Map();
  for (const c of castles || []) byField.set(Number(c.fieldId), c);
  const next = new Map();
  const events = [];
  for (const a of armies || []) {
    if (!a) continue;
    const d = Number(a.direction);
    if (d === 2 || d === 3) continue;                     // going home / encamped: not landing
    const c = byField.get(Number(a.targetFieldId));
    if (!c) continue;                                       // a valley or a flat, not a city
    const s = {
      key: keyOf(a), armyId: a.armyId ?? null, cityId: c.id, city: c.name,
      mission: MISSION[Number(a.missionType)] || String(a.missionType),
      king: a.king || null, alliance: a.alliance || null, from: a.startPosName || null,
      troops: troopTotal(a), reachTime: Number(a.reachTime) || null,
    };
    if (s.mission === 'scout') s.real = false;
    else if (s.mission !== 'attack') s.real = false;
    else if (isReal) s.real = !!isReal(s, c.id);
    else s.real = s.troops === null || s.troops >= junkLine;
    next.set(s.key, s);
    if (prev && prev.has(s.key)) continue;
    const type = s.mission === 'scout' ? 'scout_incoming' : s.mission !== 'attack' ? 'army_incoming'
      : s.real ? 'attack_incoming' : 'attack_junk';
    events.push({ type, ...s, inSec: s.reachTime ? Math.round((s.reachTime - now) / 1000) : null });
  }
  if (prev) {
    for (const [k, s] of prev) {
      if (next.has(k)) continue;
      const landed = s.reachTime && s.reachTime <= now + 2000;
      if (s.mission === 'attack') {
        events.push({ type: landed ? (s.real ? 'attack_landed' : 'junk_landed') : 'attack_turned_back', ...s });
      } else if (s.mission === 'scout' && landed) {
        events.push({ type: 'scout_landed', ...s });
      }
    }
  }
  return { next, events };
}

// Our own marches: which went out, which reached their target (direction 1 ->
// 2 or 3), and which are home (gone from the list).
function diffSelf(prev, armies, { now = Date.now() } = {}) {
  const next = new Map();
  const events = [];
  for (const a of armies || []) {
    if (!a) continue;
    const s = {
      key: keyOf(a), armyId: a.armyId ?? null,
      mission: MISSION[Number(a.missionType)] || String(a.missionType),
      from: a.startPosName || null, to: a.targetPosName || null, hero: typeof a.hero === 'string' ? a.hero : null,
      troops: troopTotal(a), direction: DIRECTION[Number(a.direction)] || null, reachTime: Number(a.reachTime) || null,
    };
    next.set(s.key, s);
    if (!prev) continue;
    const was = prev.get(s.key);
    if (!was) events.push({ type: 'march_started', ...s });
    else if (was.direction === 'out' && s.direction !== 'out') events.push({ type: 'march_arrived', ...s });
  }
  if (prev) {
    for (const [k, s] of prev) {
      if (next.has(k)) continue;
      // Gone while still going out and early: recalled, or the city fell away.
      const home = s.direction === 'back' || (s.reachTime && s.reachTime <= now + 2000);
      events.push({ type: home ? 'march_returned' : 'march_gone', ...s });
    }
  }
  return { next, events };
}

module.exports = { EventRing, typeSet, diffEnemy, diffSelf, troopTotal, MAX_EVENTS, MAX_WAIT_MS };
