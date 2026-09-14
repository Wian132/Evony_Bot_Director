'use strict';
// ReportsToKeep (NEAT wiki ReportsToKeep): read the account's army reports and
// delete the farming reports not worth keeping.
//
//   reportstokeep <treasure> <valley> <npc5> <npc10 low> <npc10 high>
//   reportstokeep 1 a:500 b:1 a:3800 a:6000
//
// The wiki's example, word for word: a report with treasure acquired is kept
// (the first number is 1); a valley attack report is kept if 500 or more
// archers were lost in it; an npc5 attack report if 1 or more ballistas were
// lost; an npc10 report if the archers lost are under 3,800 or over 6,000.
// A number set to 0 keeps every report of its kind ("reportstokeep 1 a:0 b:0
// a:0 a:0" keeps them all). The troop is any troop word the goals know
// (constants.js TROOP_WORDS), the numbers take 5k / 1.5m.
//
// What is deleted, and why only that. NEAT reads and deletes "all other
// reports". This is more careful, on purpose:
//   - Only army reports are listed (report.receiveReportList, reportType 1);
//     trade and other reports are never touched.
//   - A report is only opened when its own row says it can be judged: an
//     attack march (the row's armyType, ObjConstants ARMY_MISSION_OCCUPY = 5,
//     when the row carries one) from one of this account's cities, on a tile
//     the map cache knows as an NPC camp or a valley. Player cities, flats,
//     scouting, transports and reinforcements are never opened or deleted.
//   - Once opened (report.markAsRead, which is how the client opens one) only
//     two kinds can be deleted: our attack's battle report and that army's
//     return report. Anything else, or anything that cannot be decoded, is kept.
//   - Our own caution where the wiki says nothing: a battle our side lost, or
//     one in which a hero of ours was captured, is always kept.
//   - An NPC camp the map cache knows without a level cannot be told apart
//     between npc5, npc10 and the rest, so its battle reports are kept.
//   - NPC attacks of other levels (npc1-4, npc6-9), and the return reports of
//     every judged attack, have no rule that keeps them, so they go, as in
//     NEAT — unless their kind's number is 0, which keeps every one.
// A valley is recognised only once it is in the map cache (the console's map
// scans keep owned valleys; a later step's background scan keeps the rest).
//
// Reports belong to the account, not to a city: the goal runs from one city
// only, the first of the account's cities whose goals have a readable
// reportstokeep line, with that city's numbers. Every other city's plan says so.
//
// Paced: each run lists at most REPORT_PAGES pages of 50 and opens at most
// REPORT_BATCH reports, then deletes the ones to go in one request. It runs
// again after a minute while it keeps finding work, after 10 minutes once it
// finds none, and after 5 when the server did not answer.
//
// Report replies name their command and nothing else, so the game.js report
// calls each wait in their own lane (the console's Reports window uses them too).

const C = require('./constants');
const MB = require('./mailbox');

const n = (x) => Number(x || 0);
const fmt = (x) => Math.round(n(x)).toLocaleString('en-US');

const REPORT_BATCH = 5;             // reports opened per run
const REPORT_PAGES = 3;             // list pages (of REPORT_PAGE_SIZE) looked at per run
const REPORT_PAGE_SIZE = 50;
const REPORT_BUSY_MS = 60 * 1000;   // it opened a full batch: more may be waiting
const REPORT_IDLE_MS = 10 * 60000;  // nothing left to judge
const REPORT_RETRY_MS = 5 * 60000;  // the server did not answer, or refused
const REMEMBER_KEPT = 1000;         // kept ids remembered, so none is opened twice
const DELETE_TRIES = 3;             // a delete refused this often leaves those reports be

// The valley terrains (constants.js FIELD_TYPES 1-6, session.js mapBlockTiles' `kind`).
const VALLEY_KINDS = new Set(['forest', 'desert', 'hill', 'swamp', 'grassland', 'lake']);

// The goals number grammar (goals.js NUM). goals.js loads this module, so it
// cannot be required from here; goal-war.js keeps the same copy.
const NUM = (s) => {
  const m = String(s).trim().match(/^([\d.]+)\s*([kmbd])?$/i);
  if (!m) return null;
  const v = parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9, d: 1e9 }[(m[2] || '').toLowerCase()] || 1);
  return Number.isFinite(v) ? v : null;
};

// "a:500" -> { word, troop, typeId, count, text } or null with an error.
function lossRule(tok, label, errs) {
  const s = String(tok === undefined ? '' : tok).trim();
  const i = s.indexOf(':');
  if (i < 0) { errs.push(`${label}: "${s}" should be troop:count, e.g. a:500`); return null; }
  const t = C.troopByWord(s.slice(0, i));
  if (!t) { errs.push(`${label}: unknown troop "${s.slice(0, i)}"`); return null; }
  const v = NUM(s.slice(i + 1));
  if (v === null || !Number.isInteger(v) || v < 0) { errs.push(`${label}: "${s.slice(i + 1)}" is not a whole number of troops`); return null; }
  return { word: s.slice(0, i), troop: t.name, typeId: t.typeId, count: v, text: `${s.slice(0, i)}:${v}` };
}

const USAGE = 'expected: reportstokeep <treasure 0|1> <valley troop:count> <npc5 troop:count> <npc10 low troop:count> <npc10 high troop:count>, e.g. reportstokeep 1 a:500 b:1 a:3800 a:6000';

const parsers = {
  // One per city; the account runs the first city's (see above).
  reportstokeep: {
    kind: 'directive', multi: false,
    parse(args) {
      const errs = [];
      const a = (args || []).map(String).filter(Boolean);
      if (a.length !== 5) errs.push(`${USAGE} — got ${a.length} value(s)`);
      const sw = a[0] === undefined ? '' : a[0].trim();
      if (a.length && !/^[01]$/.test(sw)) errs.push(`the treasure switch is 0 (off) or 1 (keep reports with treasure acquired), got "${sw}"`);
      const valley = a.length > 1 ? lossRule(a[1], 'valley', errs) : null;
      const npc5 = a.length > 2 ? lossRule(a[2], 'npc5', errs) : null;
      const npc10low = a.length > 3 ? lossRule(a[3], 'npc10 low', errs) : null;
      const npc10high = a.length > 4 ? lossRule(a[4], 'npc10 high', errs) : null;
      // a line with any error reads, opens and deletes nothing
      return { treasure: sw === '1', valley, npc5, npc10low, npc10high, valid: !errs.length, errors: errs };
    },
  },
};

// The rules an action carries (what the plan read off the line).
const rulesOf = (g) => ({ treasure: g.treasure, valley: g.valley, npc5: g.npc5, npc10low: g.npc10low, npc10high: g.npc10high });
const ruleText = (r) => `${r.treasure ? 1 : 0} ${r.valley.text} ${r.npc5.text} ${r.npc10low.text} ${r.npc10high.text}`;

// ------------------------------------------------------------ who runs it
const lineOf = (goals) => (goals || []).find((g) => g.name === 'reportstokeep') || null;

// The first of the account's cities whose goals have a readable line.
function runnerOf(ctx) {
  const game = ctx.game || {};
  const castles = Array.isArray(game.castles) ? game.castles : [];
  const idOf = (c) => (typeof game.castleId === 'function' ? game.castleId(c) : (c.castleId ?? c.id));
  if (typeof ctx.goalsOf !== 'function' || !castles.length) return ctx.castle;
  for (const c of castles) {
    const goals = idOf(c) === idOf(ctx.castle) ? ctx.goals : ctx.goalsOf(c);
    const g = lineOf(goals);
    if (g && g.valid) return c;
  }
  return ctx.castle;
}

// ------------------------------------------------------------ the map
// "Name(123,456)" -> { name, x, y } (the report row's startPos / targetPos,
// as the console's Reports window prints them).
function posOf(s) {
  const m = String(s == null ? '' : s).match(/^(.*)\((\d+)\s*,\s*(\d+)\)\s*$/);
  return m ? { name: m[1].trim(), x: Number(m[2]), y: Number(m[3]) } : null;
}

// The map cache (db.js mapCache, fed by the console's map scans), read once
// per cache version: fieldId -> tile.
let _tiles = { version: -1, map: null };
function tileAt(fieldId) {
  const D = require('./db');
  const v = D.mapCache.version();
  if (_tiles.version !== v || !_tiles.map) {
    const raw = D.mapCache.asJson();
    _tiles = { version: v, map: new Map(Object.values((raw && raw.castles) || {}).map((t) => [Number(t.id), t])) };
  }
  return _tiles.map.get(Number(fieldId)) || null;
}

// What the row's target is, judged from the row alone, or null when the row
// is not one this goal may open: { kind: 'npc'|'valley', level, where }.
function targetOf(row, ownFields, lookup = tileAt) {
  const mission = row.armyType;
  if (mission !== undefined && mission !== null && mission !== '' && Number(mission) !== C.MISSION.attack) return null;
  const from = posOf(row.startPos), to = posOf(row.targetPos);
  if (!from || !to) return null;
  // one of our own marches: it left from one of this account's cities
  if (!ownFields.has(C.coordsToFieldId(from.x, from.y))) return null;
  const tile = lookup(C.coordsToFieldId(to.x, to.y));
  if (!tile) return null;
  const where = `${to.x},${to.y}`;
  if (tile.npc === true || tile.kind === 'npc') {
    const lv = Number(tile.level);
    return { kind: 'npc', level: Number.isInteger(lv) && lv >= 1 && lv <= 10 ? lv : null, where };
  }
  if (VALLEY_KINDS.has(tile.kind) && !tile.npc) return { kind: 'valley', level: Number(tile.level) || null, where };
  return null;
}

// ------------------------------------------------------------ judging one report
// What the report says, through mailbox.js's decoder (the console's Reports
// window shows the same). Returns { form: 'battle'|'return'|'other', ... }.
function readContent(content, bean) {
  const d = MB.describeReport(content, bean);
  if (d.kind === 'battle') {
    const sides = ((d.sections.find((s) => s.type === 'sides') || {}).sides) || [];
    const ours = sides.filter((s) => s.whose === 'you');
    const lost = {};
    for (const s of ours) for (const u of s.troops) lost[u.typeId] = n(lost[u.typeId]) + n(u.lost);
    return {
      form: 'battle',
      ourAttack: ours.length > 0 && ours.every((s) => s.role === 'Attacker'),
      treasure: d.sections.some((s) => s.title === 'Treasure acquired'),
      won: d.verdict ? d.verdict.good : null,
      heroCaptured: d.sections.some((s) => / — the hero was captured$/.test(String(s.title || ''))),
      lost,
    };
  }
  if (d.kind === 'movement') {
    // TroopMovementDetail: type is the mission, isBack a march home
    let tm = null;
    try { const x = MB.parseXml(content); tm = x && x.reportData && x.reportData.troopMovement; } catch { tm = null; }
    const back = tm && (tm.isBack === true || String(tm.isBack).toLowerCase() === 'true');
    return { form: back && Number(tm.type) === C.MISSION.attack ? 'return' : 'other', what: 'a march report' };
  }
  return { form: 'other', what: `${d.kind === 'text' ? 'an unreadable' : `a ${d.kind}`} report` };
}

// A kind whose number is 0 keeps every report of that kind.
function keepsAll(r, t) {
  if (t.kind === 'valley') return r.valley.count === 0;
  if (t.level === 5) return r.npc5.count === 0;
  if (t.level === 10) return r.npc10low.count === 0 || r.npc10high.count === 0;
  if (t.level === null) return r.npc5.count === 0 || r.npc10low.count === 0 || r.npc10high.count === 0;
  return false;
}
const what = (t) => (t.kind === 'valley' ? `valley ${t.where}` : `npc${t.level === null ? '' : t.level} ${t.where}`);
// Archer -> archers, Pikeman -> pikemen, Cavalry -> cavalry
const plural = (name) => {
  const w = String(name).toLowerCase();
  return /man$/.test(w) ? w.replace(/man$/, 'men') : w === 'cavalry' ? w : `${w}s`;
};

// { keep: true|false, why }
function judge(r, t, c) {
  const name = what(t);
  if (c.form === 'other') return { keep: true, why: `${name}: ${c.what}, not ours to judge` };
  if (c.form === 'return') {
    return keepsAll(r, t) ? { keep: true, why: `${name}: return report, kept (its number is 0: keep every report)` }
      : { keep: false, why: `${name}: the army's return report` };
  }
  if (!c.ourAttack) return { keep: true, why: `${name}: not our attack` };
  if (r.treasure && c.treasure) return { keep: true, why: `${name}: treasure acquired` };
  if (c.won === false) return { keep: true, why: `${name}: the attack failed` };
  if (c.heroCaptured) return { keep: true, why: `${name}: a hero was captured` };
  const lost = (rule) => n(c.lost[rule.typeId]);
  const lostText = (rule) => `${fmt(lost(rule))} ${plural(rule.troop)} lost`;
  if (t.kind === 'valley') {
    const v = r.valley;
    if (v.count === 0) return { keep: true, why: `${name}: every valley report is kept (0)` };
    return lost(v) >= v.count ? { keep: true, why: `${name}: ${lostText(v)} >= ${fmt(v.count)}` }
      : { keep: false, why: `${name}: ${lostText(v)} < ${fmt(v.count)}` };
  }
  if (t.level === null) return { keep: true, why: `${name}: the map cache has no level for this camp` };
  if (t.level === 5) {
    const v = r.npc5;
    if (v.count === 0) return { keep: true, why: `${name}: every npc5 report is kept (0)` };
    return lost(v) >= v.count ? { keep: true, why: `${name}: ${lostText(v)} >= ${fmt(v.count)}` }
      : { keep: false, why: `${name}: ${lostText(v)} < ${fmt(v.count)}` };
  }
  if (t.level === 10) {
    const lo = r.npc10low, hi = r.npc10high;
    if (lo.count === 0 || hi.count === 0) return { keep: true, why: `${name}: every npc10 report is kept (0)` };
    if (lost(lo) < lo.count) return { keep: true, why: `${name}: ${lostText(lo)} < ${fmt(lo.count)}` };
    if (lost(hi) > hi.count) return { keep: true, why: `${name}: ${lostText(hi)} > ${fmt(hi.count)}` };
    return { keep: false, why: `${name}: ${lostText(lo)}, between ${fmt(lo.count)} and ${fmt(hi.count)}` };
  }
  return { keep: false, why: `${name}: no rule keeps npc${t.level} reports` };
}

// ------------------------------------------------------------ the plan
const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);
const span = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.round(s / 60)} min`; };

function summary(st) {
  const bits = [`${fmt(st.deleted)} deleted, ${fmt(st.kept)} kept so far`];
  const l = st.last;
  if (l) {
    bits.push(`last look ${hhmm(l.at)}: ${l.error ? `failed (${l.error})`
      : `opened ${l.read}, deleted ${l.deleted}, kept ${l.kept}${l.why && l.why.length ? ` — ${l.why.slice(0, 2).join('; ')}` : ''}`}`);
  }
  return bits.join('; ');
}

function reportsPlan(ctx, state) {
  const g = lineOf(ctx.goals);
  if (!g) return null;
  if (!g.valid) return { note: 'reportstokeep: the line has an error, so no report is opened or deleted', actions: [] };
  const game = ctx.game || {};
  const idOf = (c) => (typeof game.castleId === 'function' ? game.castleId(c) : (c.castleId ?? c.id));
  const runner = runnerOf(ctx);
  if (runner && idOf(runner) !== idOf(ctx.castle)) {
    return { note: `reportstokeep: reports belong to the account, so ${runner.name || `city ${idOf(runner)}`} sorts them, with its own line (the first city that has one)`, actions: [] };
  }
  const st = (state && state.reports) || {};
  const head = `reportstokeep ${ruleText(g)} (the account's army reports)`;
  const now = Date.now();
  if (n(st.nextAt) > now) return { note: `${head}: ${summary(st)}; next look in ${span(n(st.nextAt) - now)}`, actions: [] };
  return {
    note: `${head}: ${summary(st)}`,
    actions: [{
      kind: 'reportsToKeep', rules: rulesOf(g),
      label: `reportstokeep: open up to ${REPORT_BATCH} NPC/valley attack reports and delete the ones not worth keeping`,
    }],
  };
}

// ------------------------------------------------------------ the executor
// One run. `state` is the running city's engine state; it keeps
//   reports.kept / .deleted   counts since the goal was first run
//   reports.keptIds           {id: 1} of the reports judged and kept
//   reports.retry             ids judged for deletion whose delete failed
//                             (retryTries: how often; DELETE_TRIES and they stay)
//   reports.last / .nextAt    the last run, and when the next is due
async function runReports(game, castle, a, state) {
  const st = (state.reports = state.reports || {});
  st.kept = n(st.kept); st.deleted = n(st.deleted);
  st.keptIds = st.keptIds && typeof st.keptIds === 'object' ? st.keptIds : {};
  const now = Date.now();
  const last = (st.last = { at: now, read: 0, deleted: 0, kept: 0, why: [], error: null });
  const r = a.rules;
  const ownFields = new Set((game.castles || []).map((c) => Number(c.fieldId)).filter(Number.isFinite));
  try {
    // a delete that failed last time goes first, and nothing is opened again for it
    const drop = Array.isArray(st.retry) ? st.retry.slice(0, 50) : [];
    const picked = [];
    for (let page = 1; page <= REPORT_PAGES && picked.length < REPORT_BATCH; page++) {
      const list = await game.reportList('army', page, REPORT_PAGE_SIZE);
      if (!list || list.ok !== 1) throw new Error((list && list.errorMsg) || 'the server refused the report list');
      for (const row of list.reports || []) {
        const id = Number(row.id);
        if (!Number.isInteger(id) || st.keptIds[id] || drop.includes(id) || picked.some((p) => p.id === id)) continue;
        const t = targetOf(row, ownFields);
        if (t) picked.push({ id, row, t });
        if (picked.length >= REPORT_BATCH) break;
      }
      if (!n(list.totalPage) || page >= n(list.totalPage)) break;
    }
    // A report that will not open stops the run; what was judged before it
    // is still dealt with below.
    let failed = null;
    for (const p of picked) {
      let d;
      try { d = await game.readReport(p.id); } catch (e) { failed = e.message; break; }
      if (!d || d.ok !== 1 || !d.report) { failed = (d && d.errorMsg) || `report ${p.id} would not open`; break; }
      last.read++;
      const verdict = judge(r, p.t, readContent(d.report.content, { ...p.row, ...d.report }));
      last.why.push(verdict.why);
      if (verdict.keep) { st.keptIds[p.id] = 1; st.kept++; last.kept++; } else drop.push(p.id);
    }
    if (drop.length) {
      let del;
      try { del = await game.deleteReports(drop); } catch (e) { del = { ok: 0, errorMsg: e.message }; }
      if (!del || del.ok !== 1) {
        const why = (del && del.errorMsg) || 'no reason given';
        st.retryTries = n(st.retryTries) + 1;
        if (st.retryTries >= DELETE_TRIES) {
          // left in the box for good rather than tried forever
          for (const id of drop) st.keptIds[id] = 1;
          st.retry = []; st.retryTries = 0;
          throw new Error(`the delete was refused ${DELETE_TRIES} times (${why}) — those ${drop.length} report(s) are left in the box`);
        }
        st.retry = drop;          // deleted next time, without opening them again
        throw new Error(`the delete was refused (${why})`);
      }
      st.deleted += drop.length; last.deleted = drop.length;
    }
    st.retry = []; st.retryTries = 0;
    // the oldest kept ids go first (report ids only grow)
    const ids = Object.keys(st.keptIds);
    for (const k of ids.slice(0, Math.max(0, ids.length - REMEMBER_KEPT))) delete st.keptIds[k];
    if (failed) throw new Error(failed);
    st.nextAt = now + (picked.length >= REPORT_BATCH ? REPORT_BUSY_MS : REPORT_IDLE_MS);
    return { ok: 1, msg: `opened ${last.read}, deleted ${last.deleted}, kept ${last.kept}` };
  } catch (e) {
    last.error = e.message;
    st.nextAt = now + REPORT_RETRY_MS;
    return { ok: 0, errorMsg: `reportstokeep: ${e.message} — trying again in ${span(REPORT_RETRY_MS)}` };
  }
}

const executors = {
  reportsToKeep: (game, castle, a, state) => runReports(game, castle, a, state || {}),
};

module.exports = {
  parsers,
  plans: { reportstokeep: reportsPlan },
  executors,
  configKeys: [],
  // exported for the tests
  _internals: {
    REPORT_BATCH, REPORT_PAGES, REPORT_PAGE_SIZE, REPORT_BUSY_MS, REPORT_IDLE_MS, REPORT_RETRY_MS, REMEMBER_KEPT, DELETE_TRIES,
    posOf, targetOf, readContent, judge, keepsAll, runnerOf, runReports, tileAt,
  },
};
