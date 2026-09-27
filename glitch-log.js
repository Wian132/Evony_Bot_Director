'use strict';
// The glitch log: one record per maintenance, of what every town of every account
// was holding going IN and what it was holding coming OUT — plus the trading runs
// that belong to that day.
//
// WHY THIS EXISTS (2026-09-23, the user's ask). The market glitch is a bet on one
// thing: an account on holiday has its resources put back at maintenance to what it
// held at the maintenance before (EVONY-RULES §4). Until now the only evidence of
// that was the hourly resource record and the 08:30 morning record — neither of
// which is tied to a maintenance, so nobody could open a day and say "this is what
// each town went in with, this is what it came out with, and this is what the run
// that morning actually moved". The put-back is random town by town (§4), so the
// whole value is in the pairs, day after day.
//
// What it records, per maintenance:
//
//   before  taken at the fleet's stand-down (maint.js pauseAt, 5 minutes before the
//           announced start) — the last honest picture before the server goes.
//   after   taken once an account is verifiably back in, when the consoles have
//           published a snapshot from after the window. A login is a fresh read, so
//           the "after" figures are the server's by definition.
//   relog   the user's choice (2026-09-23): before the "before" record, every
//           console is asked to log in afresh, because a console's cached figures go
//           stale on a busy account and only a relog refreshes them (EVONY-RULES §3).
//           THIS COSTS SOMETHING — a refresh kills every city's autorun script and
//           nothing puts it back (EVONY-RULES §4) — so it fires once per maintenance,
//           only on an ANNOUNCED window, and never inside the stand-down.
//
// The per-city figures are filed in `city_resources` (the same table the Resources
// tab charts) under `kind = 'maint:<day>:before' | 'maint:<day>:after'`, so there is
// one source of truth for what a town held and the restore report sees these records
// too. This file's own table holds what that table has no room for: the window, who
// was relogged, and which side of the play each account was on that day.
const D = require('./db');
const CITY = require('./city-resources');

const RES = CITY.RES;                     // food, wood, stone, iron, gold
const SIDES = ['before', 'after'];
const kindOf = (day, side) => `maint:${day}:${side}`;
const dayKey = CITY.dayKey;

// One row per maintenance per org. `source` is how we know when it was:
// 'announced' (a console heard the system chat, or the Director's own fleet
// verdict) or 'assumed' (nobody heard anything and the daily window was used).
D.run(`CREATE TABLE IF NOT EXISTS glitch_maint (
  orgId TEXT, day TEXT, server TEXT,
  startAt INTEGER, pauseAt INTEGER, resumeAt INTEGER, endAt INTEGER,
  beforeAt INTEGER, afterAt INTEGER, relogAt INTEGER,
  source TEXT, accounts TEXT, relog TEXT, note TEXT,
  PRIMARY KEY (orgId, day))`);

// Every trading run, kept after it ends. The runner itself keeps only the CURRENT
// run in the settings (trading-setup RUN_KEY), so without this a finished run — the
// play, the price, who was buying, what it said as it went — was gone the moment the
// next one started, and the log could never say what a day's glitch actually was.
D.run(`CREATE TABLE IF NOT EXISTS glitch_runs (
  orgId TEXT, id TEXT, day TEXT, createdAt INTEGER, stoppedAt INTEGER,
  state TEXT, kind TEXT, bankSide TEXT, res TEXT, price REAL, json TEXT,
  PRIMARY KEY (orgId, id))`);
D.run('CREATE INDEX IF NOT EXISTS glitch_runs_org_day ON glitch_runs (orgId, day)');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const json = (v, d = null) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

// ======================================================================
//  Settings
// ======================================================================
//
// `relog` is the one switch with a cost behind it: leave it off and the "before"
// figures are whatever each console had cached, which can be an hour stale on a busy
// account. `leadMin` is how long before the announced START the relog goes out — it
// must leave the login time to finish before the stand-down at start-5min, so 10
// minutes (5 minutes of room) is the default and 6 the floor.
const CFG_KEY = 'glitchLog';
const DEFAULT_CFG = { on: true, relog: true, leadMin: 10 };
const LEAD_MIN = 6, LEAD_MAX = 30;

function config(org) {
  const raw = (org && org.settings && org.settings.get(CFG_KEY, null)) || null;
  const c = { ...DEFAULT_CFG, ...(raw || {}) };
  return {
    on: c.on !== false,
    relog: c.relog !== false,
    leadMin: Math.min(LEAD_MAX, Math.max(LEAD_MIN, num(c.leadMin) || DEFAULT_CFG.leadMin)),
  };
}
function setConfig(org, patch = {}) {
  const cur = config(org);
  const next = {
    on: patch.on === undefined ? cur.on : !!patch.on,
    relog: patch.relog === undefined ? cur.relog : !!patch.relog,
    leadMin: patch.leadMin === undefined ? cur.leadMin
      : Math.min(LEAD_MAX, Math.max(LEAD_MIN, num(patch.leadMin) || cur.leadMin)),
  };
  org.settings.set(CFG_KEY, next);
  return next;
}

// ======================================================================
//  The event row
// ======================================================================

function eventRow(orgId, day) {
  const r = D.one('SELECT * FROM glitch_maint WHERE orgId = ? AND day = ?', orgId, day);
  return r ? { ...r, accounts: json(r.accounts, {}) || {}, relog: json(r.relog, {}) || {} } : null;
}

function saveEvent(orgId, day, patch = {}) {
  const cur = eventRow(orgId, day);
  const row = {
    server: null, startAt: 0, pauseAt: 0, resumeAt: 0, endAt: 0,
    beforeAt: 0, afterAt: 0, relogAt: 0, source: 'assumed', accounts: {}, relog: {}, note: null,
    ...(cur || {}), ...patch,
  };
  D.run(`INSERT INTO glitch_maint (orgId,day,server,startAt,pauseAt,resumeAt,endAt,beforeAt,afterAt,relogAt,source,accounts,relog,note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(orgId,day) DO UPDATE SET server=excluded.server, startAt=excluded.startAt,
           pauseAt=excluded.pauseAt, resumeAt=excluded.resumeAt, endAt=excluded.endAt,
           beforeAt=excluded.beforeAt, afterAt=excluded.afterAt, relogAt=excluded.relogAt,
           source=excluded.source, accounts=excluded.accounts, relog=excluded.relog, note=excluded.note`,
  orgId, day, row.server, num(row.startAt), num(row.pauseAt), num(row.resumeAt), num(row.endAt),
  num(row.beforeAt), num(row.afterAt), num(row.relogAt), row.source,
  JSON.stringify(row.accounts || {}), JSON.stringify(row.relog || {}), row.note || null);
  return eventRow(orgId, day);
}

// The window the fleet believes in, written down so the record survives it: maint.js
// keeps a record for 90 minutes and then forgets it, but the "after" record can still
// be owed hours later if every console was down.
//
// `rec` is maint.read()'s answer (null when nothing is known). An announced window
// always wins over one we assumed earlier the same day.
function ensureEvent(orgId, rec, now = Date.now()) {
  if (!rec || !rec.startAt) return null;
  const day = dayKey(rec.startAt);
  const cur = eventRow(orgId, day);
  // A real window replaces one we had only assumed. A second reading of the same
  // announced window must not move a start we have already acted on — the
  // announcement repeats every three minutes — so only the end is filled in.
  if (cur && cur.source === 'announced' && num(cur.startAt)) {
    return rec.over && !num(cur.endAt) ? saveEvent(orgId, day, { endAt: rec.over }) : cur;
  }
  return saveEvent(orgId, day, {
    server: rec.server || 'ss71',
    startAt: rec.startAt, pauseAt: rec.pauseAt, resumeAt: rec.resumeAt,
    endAt: rec.over || (cur ? num(cur.endAt) : 0),
    // Both ways a window gets declared are evidence, not a guess: a console heard
    // the system chat, or the fleet itself went down together (maint.js verdict).
    source: 'announced',
  });
}

// Nobody heard anything today. Once the assumed stand-down has passed with no
// window on record, open one anyway so the day still gets a "before" record — this
// is the fallback the daily window gives us (EVONY-RULES §2). It is marked
// `assumed`, and `due()` will not relog on it: a relog fired on a guessed time can
// land inside a real maintenance, and that holds the account back for half an hour.
function ensureAssumed(orgId, now = Date.now()) {
  const day = dayKey(now);
  const cur = eventRow(orgId, day);
  if (cur) return cur;
  const w = assumedWindow(day);
  if (now < w.pauseAt || now > w.resumeAt + BEFORE_LATE_MS) return null;
  return saveEvent(orgId, day, { server: null, ...w, endAt: 0, source: 'assumed' });
}

// The daily window when nobody heard an announcement (EVONY-RULES §2: somewhere
// 08:30-09:30 SAST). It is enough to hang a "before" record on, and it is NEVER
// enough to relog on — a relog fired on a guess can land inside a real maintenance,
// which holds the account back for half an hour (§2). `due()` enforces that.
const ASSUMED_START_H = 8, ASSUMED_START_M = 30;
const ASSUMED_END_H = 9, ASSUMED_END_M = 30;
function atOn(day, h, m) {
  const [Y, M, Dd] = String(day).split('-').map(Number);
  return new Date(Y, (M || 1) - 1, Dd || 1, h, m, 0, 0).getTime();
}
function assumedWindow(day) {
  const startAt = atOn(day, ASSUMED_START_H, ASSUMED_START_M);
  return { startAt, pauseAt: startAt - 5 * 60000, resumeAt: atOn(day, ASSUMED_END_H, ASSUMED_END_M) };
}

// ======================================================================
//  What is due right now
// ======================================================================
//
// One step at a time, in the order they must happen. The caller (the Director's
// ticker) does the step and calls back; nothing here talks to the game.
//
//   relog    log every console in afresh, so the "before" figures are the server's
//   before   file the record, at the stand-down
//   after    file the record, once the fleet is verifiably back in
//
// The windows each step is allowed in are deliberately narrow: a step missed is a
// gap in the log, and a step taken at the wrong moment is a login into a closed
// server or a play killed for nothing.
const BEFORE_LATE_MS = 60 * 60000;        // still worth filing this long past the stand-down
const AFTER_WAIT_MS = 20 * 60000;         // wait this long for the consoles' own fresh snapshots
const AFTER_LATE_MS = 12 * 3600000;       // ...but an owed "after" is still filed hours later

function due(org, now = Date.now(), { rec = null } = {}) {
  const cfg = config(org);
  if (!cfg.on) return null;
  const orgId = org.orgId || org.id;
  if (rec) ensureEvent(orgId, rec, now);
  else ensureAssumed(orgId, now);

  // today first, then yesterday: an "after" can still be owed across midnight
  for (const day of [dayKey(now), dayKey(now - 86400000)]) {
    const row = eventRow(orgId, day);
    if (!row || !num(row.startAt)) continue;
    const startAt = num(row.startAt);
    const pauseAt = num(row.pauseAt) || startAt - 5 * 60000;
    const resumeAt = num(row.resumeAt) || startAt + 15 * 60000;
    const endAt = num(row.endAt);

    // ---- relog, so the "before" figures are not a stale cache ----
    // Only on an announced window, only in the gap between the lead time and the
    // stand-down, and only once.
    if (cfg.relog && !num(row.relogAt) && !num(row.beforeAt) && row.source === 'announced'
        && now >= startAt - cfg.leadMin * 60000 && now < pauseAt) {
      return { action: 'relog', day, row, startAt, pauseAt, resumeAt,
        deadline: pauseAt, why: `maintenance at ${new Date(startAt).toLocaleTimeString()} — refreshing every account before the record` };
    }

    // ---- the "before" record, at the stand-down ----
    if (!num(row.beforeAt) && now >= pauseAt && now < Math.max(resumeAt, pauseAt + BEFORE_LATE_MS)) {
      return { action: 'before', day, row, startAt, pauseAt, resumeAt,
        // nothing a console read after the server went down is a "before" figure
        maxSnapAt: startAt,
        late: now - pauseAt > 10 * 60000, why: 'the fleet has stood down — what every town is carrying in' };
    }

    // ---- the "after" record, once the fleet is back ----
    if (num(row.beforeAt) && !num(row.afterAt)) {
      const back = endAt || (now >= resumeAt ? resumeAt : 0);
      if (!back) continue;
      if (now - back > AFTER_LATE_MS) continue;               // too old to mean anything
      const ready = afterReady(orgId, back, now);
      if (ready.ready || now - back > AFTER_WAIT_MS) {
        return { action: 'after', day, row, startAt, pauseAt, resumeAt, endAt: back,
          // ...and nothing read before the server came back is an "after" figure
          minSnapAt: back,
          waited: now - back > AFTER_WAIT_MS && !ready.ready, fresh: ready.fresh, total: ready.total,
          why: ready.ready ? 'every console is back in with fresh figures'
            : `${ready.fresh}/${ready.total} consoles back — filing it anyway, ${Math.round((now - back) / 60000)} min on` };
      }
    }
  }
  return null;
}

// How many accounts have published a snapshot taken AFTER the server came back. A
// login is a fresh read, so once a console has snapshotted since `endAt` its figures
// are the server's; before that they are whatever it held going into maintenance,
// which would file the "before" figures twice.
function afterReady(orgId, endAt, now = Date.now()) {
  const accs = D.all('SELECT id FROM accounts WHERE orgId = ?', orgId);
  let fresh = 0;
  for (const a of accs) {
    const r = D.one('SELECT at FROM account_latest WHERE accountId = ?', a.id);
    if (r && num(r.at) > endAt) fresh++;
  }
  return { ready: accs.length > 0 && fresh >= accs.length, fresh, total: accs.length, at: now };
}

// ======================================================================
//  Taking a record
// ======================================================================
//
// `accounts` is what the Director knows about each account right now — its label,
// its in-game lord, whether it is on holiday, and which side of the play it is on.
// It is stored WITH the event because none of it can be recovered afterwards: an
// account comes off holiday, a run ends, and the log would then say a bank was an
// ordinary account.
// `maxSnapAt` / `minSnapAt` are what keep a record honest when it is taken late. The
// figures come from whatever each console last published, and a console that has
// already been through the maintenance is holding the numbers from the OTHER side of
// it — filing those as "before" would invent a town that was never drained, or as
// "after" a restore that never happened. A row from the wrong side of the window is
// dropped and its account named, rather than quietly counted.
function take({ orgId, day, side, now = Date.now(), accounts = [], maxAgeMs = 3 * 3600000,
  maxSnapAt = 0, minSnapAt = 0 } = {}) {
  if (!SIDES.includes(side)) throw new Error(`side must be before or after, not ${side}`);
  const kind = kindOf(day, side);
  // a second take of the same side replaces the first rather than doubling the towns
  D.run('DELETE FROM city_resources WHERE orgId = ? AND kind = ?', orgId, kind);
  const r = CITY.record({ orgId, now, maxAgeMs, kind });
  const skipped = [...r.skipped];
  const cut = side === 'before' ? num(maxSnapAt) : num(minSnapAt);
  if (r.rows && cut) {
    const test = side === 'before' ? 'snapAt >= ?' : 'snapAt <= ?';
    const wrong = D.all(`SELECT DISTINCT label FROM city_resources WHERE orgId = ? AND kind = ? AND ${test}`, orgId, kind, cut);
    if (wrong.length) {
      D.run(`DELETE FROM city_resources WHERE orgId = ? AND kind = ? AND ${test}`, orgId, kind, cut);
      for (const w of wrong) skipped.push(`${w.label}: its figures are from the other side of the maintenance`);
      r.rows = num((D.one('SELECT count(*) c FROM city_resources WHERE orgId = ? AND kind = ?', orgId, kind) || {}).c);
    }
  }
  r.skipped = skipped;
  if (!r.rows) {
    D.run('DELETE FROM city_resources WHERE orgId = ? AND kind = ?', orgId, kind);
    return { ...r, day, side, taken: false };
  }
  const row = eventRow(orgId, day) || saveEvent(orgId, day, {});
  const meta = { ...(row.accounts || {}) };
  for (const a of accounts || []) {
    const was = meta[a.id] || {};
    meta[a.id] = {
      label: a.label ?? was.label ?? null,
      lord: a.lord ?? was.lord ?? null,
      // an account's holiday badge is only knowable while its console is up, so a
      // reading of null keeps whatever we last knew rather than erasing it
      holiday: a.holiday === null || a.holiday === undefined ? (was.holiday ?? null) : !!a.holiday,
      side: a.side ?? was.side ?? null,
    };
  }
  saveEvent(orgId, day, { accounts: meta, [side === 'before' ? 'beforeAt' : 'afterAt']: now });
  return { ...r, day, side, taken: true, kind };
}

// What the relog pass did, account by account: { id: { ok, at, error, skipped } }.
function markRelog(orgId, day, results = {}, now = Date.now()) {
  const row = eventRow(orgId, day) || saveEvent(orgId, day, {});
  return saveEvent(orgId, day, { relogAt: now, relog: { ...(row.relog || {}), ...results } });
}

// ======================================================================
//  The runs
// ======================================================================

// Called every time the runner saves, so a run is archived while it happens and its
// final state is the one that sticks.
function archiveRun(orgId, run) {
  if (!run || !run.id) return null;
  const day = dayKey(num(run.createdAt) || Date.now());
  D.run(`INSERT INTO glitch_runs (orgId,id,day,createdAt,stoppedAt,state,kind,bankSide,res,price,json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(orgId,id) DO UPDATE SET stoppedAt=excluded.stoppedAt, state=excluded.state,
           kind=excluded.kind, bankSide=excluded.bankSide, res=excluded.res, price=excluded.price, json=excluded.json`,
  orgId, String(run.id), day, num(run.createdAt), num(run.stoppedAt), run.state || null,
  run.kind || null, run.bankSide || null, run.res || null, num(run.price), JSON.stringify(run));
  return day;
}

// Every run that belongs to a day: one started that day, and one started the day
// before that was still going into it.
function runsOf(orgId, day) {
  const from = atOn(day, 0, 0), to = from + 86400000;
  return D.all(`SELECT * FROM glitch_runs WHERE orgId = ? AND createdAt < ?
                AND (stoppedAt = 0 OR stoppedAt IS NULL OR stoppedAt >= ?) ORDER BY createdAt`, orgId, to, from)
    .map((r) => {
      const j = json(r.json, {}) || {};
      return {
        id: r.id, day: r.day, createdAt: num(r.createdAt), stoppedAt: num(r.stoppedAt) || null,
        state: r.state, kind: r.kind, bankSide: r.bankSide, res: r.res, price: num(r.price),
        by: j.by || null, buy: j.buy || [], sell: j.sell || [], banks: j.banks || [],
        labels: j.labels || {}, cleanBefore: !!j.cleanBefore, cleanAfter: !!j.cleanAfter,
        ladder: !!j.ladder, events: (j.events || []).slice(-60),
      };
    });
}

// ======================================================================
//  Reading it back
// ======================================================================

const ZERO = () => Object.fromEntries(RES.map((k) => [k, 0]));

// The totals of one side of one day, straight out of SQL.
function sideTotals(orgId, day, side) {
  const r = D.one(`SELECT count(*) cities, count(DISTINCT accountId) accounts, min(at) at, ${RES.map((k) => `sum(${k}) ${k}`).join(', ')}
                   FROM city_resources WHERE orgId = ? AND kind = ?`, orgId, kindOf(day, side));
  if (!r || !num(r.cities)) return null;
  return { cities: num(r.cities), accounts: num(r.accounts), at: num(r.at), ...Object.fromEntries(RES.map((k) => [k, num(r[k])])) };
}

// The list the tab filters by date. `from`/`to` are YYYY-MM-DD, inclusive.
function days({ orgId, from = null, to = null, limit = 120 } = {}) {
  const where = ['orgId = ?'];
  const args = [orgId];
  if (from) { where.push('day >= ?'); args.push(String(from)); }
  if (to) { where.push('day <= ?'); args.push(String(to)); }
  const rows = D.all(`SELECT * FROM glitch_maint WHERE ${where.join(' AND ')} ORDER BY day DESC LIMIT ?`, ...args, Math.max(1, limit));
  const out = rows.map((r) => {
    const row = { ...r, accounts: json(r.accounts, {}) || {}, relog: json(r.relog, {}) || {} };
    const before = sideTotals(orgId, r.day, 'before');
    const after = sideTotals(orgId, r.day, 'after');
    const relog = Object.values(row.relog);
    const runs = runsOf(orgId, r.day);
    return {
      day: r.day, server: r.server, source: r.source,
      startAt: num(r.startAt), pauseAt: num(r.pauseAt), resumeAt: num(r.resumeAt), endAt: num(r.endAt),
      beforeAt: num(r.beforeAt), afterAt: num(r.afterAt), relogAt: num(r.relogAt),
      relogged: relog.filter((x) => x && x.ok).length, relogFailed: relog.filter((x) => x && !x.ok).length,
      before, after,
      delta: before && after ? Object.fromEntries(RES.map((k) => [k, after[k] - before[k]])) : null,
      runs: runs.map((x) => ({ id: x.id, createdAt: x.createdAt, stoppedAt: x.stoppedAt, state: x.state,
        kind: x.kind, bankSide: x.bankSide, res: x.res, price: x.price,
        buy: x.buy.length, sell: x.sell.length, banks: x.banks.length })),
      note: r.note || null,
    };
  });
  // The dates the picker offers, so it never offers a day with nothing in it.
  const span = D.one('SELECT min(day) a, max(day) b FROM glitch_maint WHERE orgId = ?', orgId) || {};
  return { now: Date.now(), res: RES, from, to, days: out, first: span.a || null, last: span.b || null };
}

// One day in full: every town, what it went in with, what it came out with, and the
// difference. A town that only appears on one side is still listed — that is itself
// the finding (a console that was down, a city taken or lost).
function detail({ orgId, day, accounts = null, q = '' } = {}) {
  const row = eventRow(orgId, day);
  if (!row) return { day, found: false };
  const want = accounts && accounts.length ? new Set(accounts) : null;
  const text = String(q || '').trim().toLowerCase();
  const towns = new Map();
  for (const side of SIDES) {
    for (const r of D.all('SELECT * FROM city_resources WHERE orgId = ? AND kind = ? ORDER BY label, city', orgId, kindOf(day, side))) {
      if (want && !want.has(r.accountId)) continue;
      if (text && !`${r.label} ${r.city} ${r.x},${r.y}`.toLowerCase().includes(text)) continue;
      const key = `${r.accountId}|${r.cityId}`;
      let t = towns.get(key);
      if (!t) {
        t = { key, accountId: r.accountId, label: r.label, city: r.city, x: num(r.x), y: num(r.y), before: null, after: null };
        towns.set(key, t);
      }
      t.city = r.city; t.x = num(r.x); t.y = num(r.y); t.label = r.label;
      t[side] = { at: num(r.at), snapAt: num(r.snapAt), ...Object.fromEntries(RES.map((k) => [k, num(r[k])])) };
    }
  }
  const relog = row.relog || {};
  const list = [...towns.values()].map((t) => {
    const rl = relog[t.accountId] || null;
    // Was the "before" reading a fresh one? Only if this account was relogged and its
    // snapshot was taken after that login came back. Anything else is the console's
    // cache, which can be an hour behind on a busy account (EVONY-RULES §3).
    const live = !!(t.before && rl && rl.ok && num(rl.at) && t.before.snapAt >= num(rl.at));
    return {
      ...t, live,
      delta: t.before && t.after ? Object.fromEntries(RES.map((k) => [k, t.after[k] - t.before[k]])) : null,
    };
  }).sort((a, b) => String(a.label).localeCompare(String(b.label)) || String(a.city).localeCompare(String(b.city)));

  // per account, and per side of the play
  const byAccount = new Map();
  for (const t of list) {
    let a = byAccount.get(t.accountId);
    if (!a) {
      const m = (row.accounts || {})[t.accountId] || {};
      a = { id: t.accountId, label: t.label, lord: m.lord || null, holiday: m.holiday ?? null, side: m.side || null,
        relog: relog[t.accountId] || null, towns: 0, live: 0, before: ZERO(), after: ZERO(), delta: ZERO() };
      byAccount.set(t.accountId, a);
    }
    a.towns++;
    if (t.live) a.live++;
    for (const k of RES) {
      if (t.before) a.before[k] += t.before[k];
      if (t.after) a.after[k] += t.after[k];
      if (t.delta) a.delta[k] += t.delta[k];
    }
  }
  const totals = { before: ZERO(), after: ZERO(), delta: ZERO() };
  const bySide = { hol: ZERO(), out: ZERO(), unk: ZERO() };
  for (const a of byAccount.values()) {
    for (const k of RES) {
      totals.before[k] += a.before[k]; totals.after[k] += a.after[k]; totals.delta[k] += a.delta[k];
      bySide[a.holiday === true ? 'hol' : a.holiday === false ? 'out' : 'unk'][k] += a.delta[k];
    }
  }
  return {
    found: true, day, res: RES, server: row.server, source: row.source,
    startAt: num(row.startAt), pauseAt: num(row.pauseAt), resumeAt: num(row.resumeAt), endAt: num(row.endAt),
    beforeAt: num(row.beforeAt), afterAt: num(row.afterAt), relogAt: num(row.relogAt),
    relog, note: row.note || null,
    towns: list, accounts: [...byAccount.values()].sort((a, b) => String(a.label).localeCompare(String(b.label))),
    totals, bySide, runs: runsOf(orgId, day),
  };
}

// Old records go the way of the snapshots they came from.
function prune(keepDays = 120, now = Date.now()) {
  const cut = dayKey(now - keepDays * 86400000);
  D.run('DELETE FROM glitch_maint WHERE day < ?', cut);
  D.run('DELETE FROM glitch_runs WHERE day < ?', cut);
  D.run("DELETE FROM city_resources WHERE kind LIKE 'maint:%' AND substr(kind, 7, 10) < ?", cut);
}

module.exports = {
  RES, SIDES, kindOf, dayKey, atOn, assumedWindow,
  config, setConfig, CFG_KEY, DEFAULT_CFG,
  eventRow, saveEvent, ensureEvent, due, afterReady, take, markRelog,
  archiveRun, runsOf, days, detail, prune,
  BEFORE_LATE_MS, AFTER_WAIT_MS, AFTER_LATE_MS,
};
