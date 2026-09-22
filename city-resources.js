'use strict';
// The hourly resource record: every city's food, wood, stone, iron and gold, from the
// snapshot each console publishes (snapshot.js cityList, which carries each city's own
// stock since 2026-09-19). The Director records it once an hour, on the hour, and on
// demand; its Resources tab charts it (the user, 2026-09-19).
//
// The figures are the console's own — they can lag on a busy account (EVONY-RULES §3);
// right after a console's login they are the server's.
const D = require('./db');

D.run(`CREATE TABLE IF NOT EXISTS city_resources (
  orgId TEXT, accountId TEXT, label TEXT, at INTEGER, snapAt INTEGER,
  cityId TEXT, city TEXT, x INTEGER, y INTEGER,
  food REAL, wood REAL, stone REAL, iron REAL, gold REAL)`);
D.run('CREATE INDEX IF NOT EXISTS city_resources_org_at ON city_resources (orgId, at)');
// `label` is the ACCOUNT's name (it has held that since the table was made and the
// Resources tab reads it as such), so which KIND of record a row is gets its own
// column: null for the hourly record, `morning:<YYYY-MM-DD>` for the daily 08:30 one
// (2026-09-20).
try { D.run('ALTER TABLE city_resources ADD COLUMN kind TEXT'); } catch { /* already there */ }
D.run('CREATE INDEX IF NOT EXISTS city_resources_org_kind ON city_resources (orgId, kind)');

const RES = ['food', 'wood', 'stone', 'iron', 'gold'];
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// File one record of every city of every account (of one org, or all). A snapshot
// older than maxAgeMs, or one from a console not yet carrying per-city figures, is left
// out and named in `skipped`. `kind` marks a record that is not the hourly one.
function record({ orgId = null, now = Date.now(), maxAgeMs = 3 * 3600000, kind = null, label = null } = {}) {
  // `label` was the old name of this argument and was never stored; keep taking it.
  kind = kind || label || null;
  const accs = orgId ? D.all('SELECT id, label, orgId FROM accounts WHERE orgId = ?', orgId)
    : D.all('SELECT id, label, orgId FROM accounts');
  let rows = 0;
  const skipped = [];
  for (const a of accs) {
    const r = D.one('SELECT at, json FROM account_latest WHERE accountId = ?', a.id);
    if (!r) { skipped.push(`${a.label}: no snapshot`); continue; }
    let j;
    try { j = JSON.parse(r.json); } catch { skipped.push(`${a.label}: unreadable snapshot`); continue; }
    const snapAt = num(j.at || r.at);
    const list = (j.cityList || []).filter((c) => c.food !== undefined);
    if (!list.length) { skipped.push(`${a.label}: no per-city figures yet (its console predates them)`); continue; }
    if (now - snapAt > maxAgeMs) { skipped.push(`${a.label}: snapshot ${Math.round((now - snapAt) / 60000)} min old`); continue; }
    for (const c of list) {
      D.run(`INSERT INTO city_resources (orgId,accountId,label,at,snapAt,cityId,city,x,y,food,wood,stone,iron,gold,kind)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, a.orgId, a.id, a.label, now, snapAt, String(c.id != null ? c.id : `${c.x},${c.y}`),
      String(c.name || ''), num(c.x), num(c.y), num(c.food), num(c.wood), num(c.stone), num(c.iron), num(c.gold), kind);
      rows++;
    }
  }
  return { at: now, rows, skipped, kind, label: kind };
}

// When the last record was filed (0: never).
function lastAt(orgId) {
  const r = D.one('SELECT max(at) at FROM city_resources WHERE orgId = ?', orgId);
  return num(r && r.at);
}

// The chart's data: per record time, each resource summed over the cities that match;
// and each matching city's latest figures. Filters: accounts (ids), q (text in the
// account, city name or x,y), hours back.
function series({ orgId, hours = 168, accounts = null, q = '' } = {}) {
  const since = Date.now() - hours * 3600000;
  const rows = D.all('SELECT * FROM city_resources WHERE orgId = ? AND at >= ? ORDER BY at', orgId, since);
  const want = accounts && accounts.length ? new Set(accounts) : null;
  const text = String(q || '').trim().toLowerCase();
  const match = (r) => (!want || want.has(r.accountId))
    && (!text || `${r.label} ${r.city} ${r.x},${r.y}`.toLowerCase().includes(text));
  const byAt = new Map();
  const latest = new Map();
  const allAccounts = new Map();
  for (const r of rows) {
    allAccounts.set(r.accountId, r.label);
    if (!match(r)) continue;
    let p = byAt.get(r.at);
    if (!p) { p = { at: r.at, cities: 0, ...Object.fromEntries(RES.map((k) => [k, 0])) }; byAt.set(r.at, p); }
    p.cities++;
    for (const k of RES) p[k] += num(r[k]);
    latest.set(`${r.accountId}|${r.cityId}`, r);
  }
  const points = [...byAt.values()];
  const last = points.length ? points[points.length - 1].at : null;
  return {
    now: Date.now(), hours, res: RES, points,
    cities: [...latest.values()].filter((r) => r.at === last)
      .map((r) => ({ accountId: r.accountId, label: r.label, city: r.city, x: r.x, y: r.y, at: r.at, snapAt: r.snapAt,
        ...Object.fromEntries(RES.map((k) => [k, num(r[k])])) }))
      .sort((a, b) => String(a.label).localeCompare(String(b.label)) || String(a.city).localeCompare(String(b.city))),
    accounts: [...allAccounts.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => String(a.label).localeCompare(String(b.label))),
  };
}

// ======================================================================
//  The daily 08:30 record
// ======================================================================
//
// Daily maintenance starts somewhere around 08:30-09:30 SAST (EVONY-RULES §2), so a
// record taken at 08:30 is the last honest picture of what every town was holding
// going INTO it — which is what the glitch is judged against. It is taken besides
// the hourly record and marked `kind = 'morning:<YYYY-MM-DD>'`, never mixed in with
// the hourly rows. If the Director was down at 08:30 the record is taken at its next
// start-up, still under the day it belongs to (and flagged `late`); a morning that
// went by entirely while the Director was down is never invented after the fact —
// today's figures are not yesterday's.
const MORNING_H = 8, MORNING_M = 30;
const pad2 = (n) => String(n).padStart(2, '0');
// local dates, because 08:30 means 08:30 on this machine's clock
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const atOn = (day, h, m) => {
  const [Y, M, D2] = String(day).split('-').map(Number);
  return new Date(Y, (M || 1) - 1, D2 || 1, h, m, 0, 0).getTime();
};
const morningKind = (day) => 'morning:' + day;

function morningTaken(orgId, day) {
  const r = D.one('SELECT count(*) c FROM city_resources WHERE orgId = ? AND kind = ?', orgId, morningKind(day));
  return num(r && r.c) > 0;
}

// The morning record this org still owes, or null. Only ever today's, and only for a
// few hours after 08:30: a morning that passed while nothing was running cannot be
// reconstructed, and this evening's figures are not this morning's.
const MORNING_GRACE_MS = 6 * 3600000;
function morningDue(orgId, now = Date.now()) {
  const day = dayKey(now);
  const due = atOn(day, MORNING_H, MORNING_M);
  if (now < due || now - due > MORNING_GRACE_MS || morningTaken(orgId, day)) return null;
  return { day, due, late: now - due > 15 * 60000 };
}

function recordMorning({ orgId, now = Date.now(), maxAgeMs = 3 * 3600000 } = {}) {
  const due = morningDue(orgId, now);
  if (!due) return null;
  const r = record({ orgId, now, maxAgeMs, kind: morningKind(due.day) });
  // Nothing recorded (every console stale or down) is not a morning taken: leave it
  // owed so the next try can still catch it.
  if (!r.rows) { D.run('DELETE FROM city_resources WHERE orgId = ? AND kind = ?', orgId, morningKind(due.day)); return { ...r, ...due, taken: false }; }
  return { ...r, ...due, taken: true };
}

// The last `days` mornings, town by town: { days, towns: [{ ..., by: { day: {food..} } }] }
function mornings({ orgId, days = 14, accounts = null, q = '' } = {}) {
  const rows = D.all(`SELECT * FROM city_resources WHERE orgId = ? AND kind LIKE 'morning:%' ORDER BY at`, orgId);
  const want = accounts && accounts.length ? new Set(accounts) : null;
  const text = String(q || '').trim().toLowerCase();
  const seen = [...new Set(rows.map((r) => String(r.kind).slice('morning:'.length)))].sort();
  const keep = new Set(seen.slice(-Math.max(1, days)));
  const towns = new Map();
  for (const r of rows) {
    const day = String(r.kind).slice('morning:'.length);
    if (!keep.has(day)) continue;
    if (want && !want.has(r.accountId)) continue;
    if (text && !`${r.label} ${r.city} ${r.x},${r.y}`.toLowerCase().includes(text)) continue;
    const key = `${r.accountId}|${r.cityId}`;
    let t = towns.get(key);
    if (!t) { t = { key, accountId: r.accountId, label: r.label, city: r.city, x: r.x, y: r.y, by: {} }; towns.set(key, t); }
    t.city = r.city; t.x = r.x; t.y = r.y;
    // a record the Director caught up on after a restart is not an 08:30 reading, and
    // the page says so rather than let it pass for one
    t.by[day] = { at: r.at, snapAt: r.snapAt, late: r.at - atOn(day, MORNING_H, MORNING_M) > 15 * 60000,
      ...Object.fromEntries(RES.map((k) => [k, num(r[k])])) };
  }
  return {
    days: [...keep].sort(),
    at: MORNING_H + ':' + pad2(MORNING_M),
    towns: [...towns.values()].sort((a, b) => String(a.label).localeCompare(String(b.label)) || String(a.city).localeCompare(String(b.city))),
  };
}

// ======================================================================
//  Which towns the market glitch does not restore
// ======================================================================
//
// An account on holiday has its resources put back at every maintenance to what it
// held at the maintenance before (EVONY-RULES §4). The user's observation
// (2026-09-20) is that one or two towns per account are NOT put back — and those are
// the towns we must not sell dry, because what leaves them is gone for good.
//
// Detection, per town and per maintenance:
//   before  the freshest record whose SNAPSHOT was taken before the server went down
//   after   the first record whose SNAPSHOT was taken after it came back
//   anchor  what that town was put back to at the PREVIOUS maintenance (the previous
//           maintenance's `after`) — the amount the game restores to
// A resource counts as `drained` when it sits at half the anchor or less; as `back`
// when `after` lands on the anchor again (within half a percent — a restore is exact,
// a market fill never is); as `risen` when it jumped by half again and 100m or more,
// which is how a restore shows up at the FIRST maintenance we have records for, where
// there is no anchor yet.
//
// What it cannot see, and says so rather than guess:
//   * whether an account was on holiday at all — so a town is only judged when its
//     own account was visibly restored at that maintenance (see `judged` below);
//   * a restore that was sold off again before the first record after maintenance —
//     that reads as "not restored", which is why one maintenance is thin evidence;
//   * anything before 2026-09-19, when the record began.
const MIN_ABS = 100e6;        // below this a change is production or noise
const DRAIN_AT = 0.5;         // at or under half the anchor: drained
const RISE_BY = 1.5;          // a restore shows as at least half again
const BACK_TOL = 0.005;       // a restore lands on the anchor, not near it
const AFTER_MAX_MS = 12 * 3600000;
const BEFORE_MAX_MS = 24 * 3600000;

// The maintenances we can place in time. `maintEnded:<accountId>` holds only the most
// recent one per account, so the settings give the last day or two; every other day in
// the range falls back to the daily window (EVONY-RULES §2: 08:30-09:30 SAST).
function maintenances({ orgId, now = Date.now(), fromAt = null } = {}) {
  const byDay = new Map();
  for (const r of D.all("SELECT k, v FROM settings WHERE orgId = ? AND k LIKE 'maintEnded:%'", orgId)) {
    let j = null;
    try { j = JSON.parse(r.v); } catch { continue; }
    if (!j || !j.day || !num(j.at)) continue;
    const e = byDay.get(j.day) || { day: j.day, ends: [], accounts: [] };
    e.ends.push(num(j.at));
    e.accounts.push(String(r.k).slice('maintEnded:'.length));
    byDay.set(j.day, e);
  }
  const windows = [];
  for (const r of D.all("SELECT k, v FROM settings WHERE orgId = ? AND k LIKE 'maintWindow:%'", orgId)) {
    let j = null;
    try { j = JSON.parse(r.v); } catch { continue; }
    if (j && num(j.startAt)) windows.push({ startAt: num(j.startAt), until: num(j.until) });
  }
  const first = num(fromAt) || num((D.one('SELECT min(at) a FROM city_resources WHERE orgId = ?', orgId) || {}).a);
  if (!first) return [];
  const out = [];
  // every day from the first record to now, by the calendar rather than by 24 hours,
  // so a daylight shift cannot drop or double one
  const days = [];
  for (const d = new Date(atOn(dayKey(first), 0, 0)); d.getTime() <= now; d.setDate(d.getDate() + 1)) days.push(dayKey(d.getTime()));
  for (const day of days) {
    const rec = byDay.get(day);
    const win = windows.find((w) => dayKey(w.startAt) === day) || null;
    let startAt = win ? win.startAt : atOn(day, MORNING_H, MORNING_M);
    const endAt = rec ? Math.min(...rec.ends) : atOn(day, 9, 30);
    if (startAt >= endAt) startAt = endAt - 3600000;
    if (endAt > now) continue;
    out.push({ day, startAt, endAt, cameBack: rec ? rec.ends.length : 0,
      source: rec && win ? 'recorded' : rec ? 'end recorded, window assumed' : 'assumed' });
  }
  return out;
}

const townKey = (r) => `${r.accountId}|${r.cityId}`;

// The whole report: every town, every maintenance we have records either side of, and
// the towns that have never once been put back.
function restoreReport({ orgId, now = Date.now() } = {}) {
  const rows = D.all('SELECT * FROM city_resources WHERE orgId = ? ORDER BY at', orgId);
  const events = maintenances({ orgId, now });
  const byTown = new Map();
  for (const r of rows) {
    const k = townKey(r);
    if (!byTown.has(k)) byTown.set(k, []);
    byTown.get(k).push(r);
  }
  const anchors = new Map();     // town -> the record it was last put back to
  const towns = new Map();       // town -> { ..., checks: [] }
  const checked = [];            // the events that could be judged at all

  for (const ev of events) {
    const cut = Math.min(ev.startAt, ev.endAt);
    const byAccount = new Map();
    for (const [key, recs] of byTown) {
      const before = [...recs].reverse().find((r) => r.snapAt < cut && cut - r.snapAt <= BEFORE_MAX_MS) || null;
      const after = recs.find((r) => r.snapAt >= ev.endAt && r.snapAt - ev.endAt <= AFTER_MAX_MS) || null;
      const last = recs[recs.length - 1];
      let t = towns.get(key);
      if (!t) {
        t = { key, accountId: last.accountId, label: last.label, city: last.city, x: last.x, y: last.y, checks: [] };
        towns.set(key, t);
      }
      t.city = last.city; t.x = last.x; t.y = last.y; t.label = last.label;
      const anchor = anchors.get(key) || null;
      // whatever a town came out of this maintenance holding is what the next one
      // should put it back to — even when this one could not be judged
      if (after) anchors.set(key, after);
      if (!before || !after) {
        t.checks.push({ day: ev.day, verdict: 'unclear',
          why: !before && !after ? 'no records either side of this maintenance'
            : !before ? 'no record before this maintenance' : 'no record after this maintenance' });
        continue;
      }
      const res = {};
      const drained = [], back = [], risen = [];
      for (const k of RES) {
        const b = num(before[k]), a = num(after[k]), an = anchor ? num(anchor[k]) : null;
        const isDrained = an !== null && an - b >= MIN_ABS && b <= an * DRAIN_AT;
        const isBack = an !== null && Math.abs(a - an) <= Math.max(1e6, an * BACK_TOL);
        const isRisen = a - b >= MIN_ABS && a >= b * RISE_BY;
        res[k] = { before: b, after: a, anchor: an, drained: isDrained, back: isBack, risen: isRisen };
        if (isDrained) drained.push(k);
        if (isDrained && isBack) back.push(k);
        if (isRisen) risen.push(k);
      }
      const restored = back.length > 0 || risen.length > 0;
      const missing = drained.filter((k) => !res[k].back && !res[k].risen);
      const chk = {
        day: ev.day, verdict: restored ? 'restored' : missing.length ? 'not restored' : 'no change',
        beforeAt: before.at, beforeSnapAt: before.snapAt, afterAt: after.at, afterSnapAt: after.snapAt,
        drained, back, risen, missing, res, anchorFrom: anchor ? anchor.at : null,
      };
      t.checks.push(chk);
      if (!byAccount.has(t.accountId)) byAccount.set(t.accountId, []);
      byAccount.get(t.accountId).push([t, chk]);
    }

    // Was this account visibly restored at all? Nothing in the record says who was on
    // holiday, so the account's own towns answer it: a town that landed back exactly on
    // its anchor is a restore and nothing else, and half an account's towns jumping at
    // once is the same event. Without that, a drained town proves nothing — a normal
    // account spends its resources and never gets them back, which is not a fault.
    let judgedHere = 0;
    for (const [, list] of byAccount) {
      const exact = list.filter(([, c]) => c.back && c.back.length).length;
      const rose = list.filter(([, c]) => c.verdict === 'restored').length;
      const gate = exact >= 1 || rose >= Math.max(2, Math.ceil(list.length / 2));
      for (const [, c] of list) {
        c.holidayLike = gate;
        if (!gate && c.verdict === 'not restored') {
          c.verdict = 'unclear';
          c.why = 'no town of this account was put back at this maintenance — it was most likely not on holiday';
        }
        if (c.verdict === 'restored' || c.verdict === 'not restored') judgedHere++;
      }
    }
    if (judgedHere) checked.push({ ...ev, judged: judgedHere });
  }

  // A town is flagged when every maintenance that could judge it says it was not put
  // back. `judged` says on how many — one is thin, and the UI must say so.
  const list = [...towns.values()].map((t) => {
    const judged = t.checks.filter((c) => c.verdict === 'restored' || c.verdict === 'not restored');
    const bad = judged.filter((c) => c.verdict === 'not restored');
    const withRes = t.checks.filter((c) => c.res);
    const level = withRes.length ? Object.fromEntries(RES.map((k) => [k, withRes[withRes.length - 1].res[k].after])) : null;
    // "came back" means it moved back up, not that it simply sat where it was: an
    // untouched resource lands on its anchor every maintenance without proving a thing
    const everBack = Object.fromEntries(RES.map((k) => [k, withRes.some((c) => c.res[k].risen || (c.res[k].drained && c.res[k].back))]));
    return { ...t, judged: judged.length, notRestored: bad.length,
      restored: judged.length - bad.length, level, everBack,
      holidayLike: t.checks.some((c) => c.holidayLike),
      notRestoredEvery: judged.length > 0 && bad.length === judged.length };
  }).sort((a, b) => String(a.label).localeCompare(String(b.label)) || String(a.city).localeCompare(String(b.city)));

  // ---- the town that was emptied long ago and is never filled again ----
  //
  // The check above can only speak for the maintenances we have records for, and the
  // damage the user is looking for was done before the record began: a town sold dry
  // while on holiday, whose put-back amount is now that empty amount for good. What
  // that leaves behind IS visible — the town sits at a sliver of what the account's
  // other towns are put back to, and stays there through every maintenance. Two
  // resources have to say so before a town is named, because one lopsided town is
  // ordinary (a treb town, a new city); and only for an account the record has
  // actually seen restored, so an ordinary account that simply spends is never blamed.
  // Judged on wood, stone and iron alone. Food is eaten by troops and capped at 950b,
  // and gold is spent on everything, so either can be near nothing in a perfectly
  // healthy town; the three that only move because we moved them are the honest ones.
  // Food and gold are still shown beside them as evidence.
  const STARVED_FRAC = 0.05;    // a twentieth of what its siblings are put back to
  const STARVED_GAP = 1e9;      // and at least a billion short, so small towns are safe
  const STARVED_RES = ['wood', 'stone', 'iron'];
  const byAcct = new Map();
  for (const t of list) {
    if (!byAcct.has(t.accountId)) byAcct.set(t.accountId, []);
    byAcct.get(t.accountId).push(t);
  }
  for (const [, ts] of byAcct) {
    const seen = ts.filter((t) => t.level);
    const anyRestored = ts.some((t) => t.restored > 0);
    const median = {};
    for (const k of RES) {
      const v = seen.map((t) => t.level[k]).sort((a, b) => a - b);
      median[k] = v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : 0;
    }
    for (const t of ts) {
      t.median = median;
      t.starvedRes = !t.level || !anyRestored ? []
        : STARVED_RES.filter((k) => median[k] > 0 && t.level[k] <= median[k] * STARVED_FRAC
          && median[k] - t.level[k] >= STARVED_GAP && !t.everBack[k]);
      t.starved = t.starvedRes.length >= 2;
      t.concern = t.notRestoredEvery ? 'not restored' : t.starved ? 'starved' : null;
      t.flagged = !!t.concern;
    }
  }

  const accounts = new Map();
  for (const t of list) {
    if (!accounts.has(t.accountId)) accounts.set(t.accountId, { id: t.accountId, label: t.label, towns: [], flagged: 0, judged: 0, holidayLike: false });
    const a = accounts.get(t.accountId);
    a.towns.push(t);
    if (t.flagged) a.flagged++;
    if (t.holidayLike) a.holidayLike = true;
    a.judged = Math.max(a.judged, t.judged);
  }
  return {
    now, res: RES, events: checked, since: rows.length ? rows[0].at : null,
    towns: list, flagged: list.filter((t) => t.flagged),
    notRestored: list.filter((t) => t.notRestoredEvery),
    starved: list.filter((t) => t.starved),
    accounts: [...accounts.values()].sort((a, b) => String(a.label).localeCompare(String(b.label))),
  };
}

module.exports = { record, series, lastAt, RES,
  recordMorning, morningDue, morningTaken, mornings, morningKind, dayKey,
  maintenances, restoreReport };
