'use strict';
// The market play, read off the consoles' own logs (console-<id>.log): every order
// a city placed, which cities sit a transfer out, the connection's story, and the
// live figures each city printed at its last login. The Director's Trading tab
// shows it (director.js /api/trading).
//
// The logs only carry a time of day ("16:58:17.540"), so each line is dated as the
// latest day that puts it no later than now (+5 min of clock skew): a tail read at
// start-up walks backwards and steps a day back wherever the times jump forward.
// Each file is read once from its last 8 MB and afterwards only for what was added.
const fs = require('fs');
const path = require('path');

const ORDER = 99999999;                 // every glitch order (script-cmd-market MAX_TRADE)
const KEEP_MS = 26 * 3600000;           // events older than this are dropped
const TAIL_BYTES = 8 * 1024 * 1024;     // the first read of a file

const RES = ['food', 'wood', 'stone', 'iron'];
// "[autorun 7] 13:42:45.820 line 18: sell iron 99999999 1 x10 · 10 × sell 99,999,999 iron @ 1 from 2 · … — 10 of 10 placed"
// "[autorun 3] 13:49:00.871 line 18: … · sell 99,999,999 iron @ 0.5 from 3 · … — placed"
// "[autorun 1] 14:40:08.254 line 18: … · 10 × sell 99,999,999 iron @ 1 from 1 -> none placed: …"
const STAMP = /^\[autorun ([^\]]+)\] (\d\d):(\d\d):(\d\d)\.(\d{3}) line \d+: (.*)$/;
const CONN = /^\[conn\] (\d\d):(\d\d):(\d\d)\.(\d{3}) (.*)$/;
const MANY = /· (\d+) × (sell|buy) [\d,]+ (food|wood|stone|iron) @ ([\d.]+) from .*?(?:— (\d+) of (\d+) placed|-> none placed)/;
const ONE = /· (sell|buy) [\d,]+ (food|wood|stone|iron) @ ([\d.]+) from .*?(— placed|-> FAILED|-> none placed)/;
// A CANCELLED ORDER IS NOT A FILL. Our buying side recycles its slots — it cancels its own
// resting bids so the next loop places fresh ones that cross the banks' asks (the user,
// 2026-09-23: "make it instant") — and counting those re-places as purchases is what made
// the Trading tab read "ours bought 235.98t" against 66.20t the banks had actually sold,
// and a return climbing to 1072% as the banks ran dry (the user, 2026-09-24: "are we buying
// someone elses stone?"). The seller never cancels during a play, so its count was always
// honest; ours is placed MINUS cancelled from here on.
//   "· canceltrade buy · cancelled 8 of 8 offer(s) in main"          -> 8 taken back
//   "· canceltrade buy · New city has no open bids to cancel"        -> nothing
//   "· canceltrade buy · none of the 10 offer(s) in 6 were cancelled: …" -> nothing
const CANCELLED = new RegExp('· cancelled (\\d+) of \\d+ offer\\(s\\)');
const FRESH = /FRESHSTART (sell|buy) food ([\d.e+]+) wood ([\d.e+]+) stone ([\d.e+]+) iron ([\d.e+]+)/;
const SITOUT = /· SITOUT (?:(sell|buy) (food|wood|stone|iron) — over the cap|over — trading again)/;
// clean-then-buy/sell.txt and clean-reports.txt echo these from the account's first city:
// "[autorun New city] 05:25:00.109 line 15: echo … · CLEANREPORTS done — removed 23718"
// A clean run from the console's Script tab logs the same under "[script] hh:mm:ss.mmm".
const CLEAN = /· CLEANREPORTS (start|done — removed (\d+))\s*$/;
const SCRIPT_STAMP = /^\[script\] (\d\d):(\d\d):(\d\d)\.(\d{3}) line \d+: (.*)$/;

// One line -> an event, or null. `t` is the time of day in ms; the date comes later.
function parseLine(line) {
  let m = STAMP.exec(line);
  if (m) {
    const tod = ((+m[2] * 60 + +m[3]) * 60 + +m[4]) * 1000 + +m[5];
    const city = m[1], rest = m[6];
    let o = MANY.exec(rest);
    if (o) {
      const placed = o[5] !== undefined ? +o[5] : 0;
      const sent = o[6] !== undefined ? +o[6] : +o[1];
      return { kind: 'order', tod, city, side: o[2], res: o[3], price: o[4], placed, refused: sent - placed };
    }
    o = ONE.exec(rest);
    if (o) {
      const ok = o[4] === '— placed';
      return { kind: 'order', tod, city, side: o[1], res: o[2], price: o[3], placed: ok ? 1 : 0, refused: ok ? 0 : 1 };
    }
    o = CANCELLED.exec(rest);
    if (o) return { kind: 'cancel', tod, city, n: +o[1] };
    o = FRESH.exec(rest);
    if (o) {
      return { kind: 'fresh', tod, city, side: o[1], res: { food: +o[2], wood: +o[3], stone: +o[4], iron: +o[5] } };
    }
    o = SITOUT.exec(rest);
    if (o) return { kind: 'sitout', tod, city, out: !!o[1], side: o[1] || null, res: o[2] || null };
    o = CLEAN.exec(rest);
    if (o) return { kind: 'clean', tod, city, done: o[1] !== 'start', removed: o[2] !== undefined ? +o[2] : null };
    return null;
  }
  m = SCRIPT_STAMP.exec(line);
  if (m) {
    const o = CLEAN.exec(m[5]);
    if (!o) return null;
    const tod = ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4];
    return { kind: 'clean', tod, city: 'script', done: o[1] !== 'start', removed: o[2] !== undefined ? +o[2] : null };
  }
  m = CONN.exec(line);
  if (m) {
    const tod = ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4];
    return { kind: 'conn', tod, text: m[5] };
  }
  return null;
}

// Local midnight of the day `t` falls on.
function dayStart(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }

// Date a run of events read in file order, the last of them nearest to `now`.
// Walking backwards, a time later than the one after it means the day before.
function dateBackwards(evs, now) {
  let day = dayStart(now);
  let next = null;
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (next === null) { if (day + e.tod > now + 300000) day -= 86400000; }
    else if (e.tod > next + 3600000) day -= 86400000;       // crossed midnight going back
    e.t = day + e.tod;
    next = e.tod;
  }
  return evs;
}
// A line just appended: today, unless that would put it in the future.
function dateForward(e, now) {
  let t = dayStart(now) + e.tod;
  if (t > now + 300000) t -= 86400000;
  e.t = t;
  return e;
}

class Monitor {
  constructor({ dir = __dirname, now = () => Date.now() } = {}) {
    this.dir = dir;
    this.now = now;
    this.files = new Map();     // id -> { offset, rest, events: [] }
  }

  // Read what an account's log has gained since the last call.
  update(id) {
    const file = path.join(this.dir, `console-${id}.log`);
    let st;
    try { st = fs.statSync(file); } catch { return this.files.get(id) || null; }
    let f = this.files.get(id);
    const now = this.now();
    if (!f || st.size < f.offset) {                      // first read, or the file was replaced
      const from = Math.max(0, st.size - TAIL_BYTES);
      const text = readRange(file, from, st.size);
      const lines = text.split(/\r?\n/);
      if (from > 0) lines.shift();                       // the first one is cut
      const rest = lines.pop();                          // the last may not be finished
      const evs = [];
      for (const l of lines) { const e = parseLine(l); if (e) evs.push(e); }
      f = { offset: st.size - Buffer.byteLength(rest || ''), rest: '', events: dateBackwards(evs, now) };
      this.files.set(id, f);
    } else if (st.size > f.offset) {
      const text = readRange(file, f.offset, st.size);
      f.offset = st.size;
      const lines = (f.rest + text).split(/\r?\n/);
      f.rest = lines.pop();
      for (const l of lines) { const e = parseLine(l); if (e) f.events.push(dateForward(e, now)); }
    }
    const cut = now - KEEP_MS;
    if (f.events.length && f.events[0].t < cut) f.events = f.events.filter((e) => e.t >= cut);
    return f;
  }

  events(id) { const f = this.update(id); return f ? f.events : []; }
}

function readRange(file, from, to) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(to - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

// The live control file's settings (scripts/glitch-res-control.txt).
function readControl(dir = __dirname) {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'scripts', 'glitch-res-control.txt'), 'utf8'); } catch { return null; }
  const val = (k) => {
    const m = new RegExp(`^${k} = (.*)$`, 'm').exec(text);
    if (!m) return null;
    const v = m[1].trim();
    return /^".*"$/.test(v) ? v.slice(1, -1) : Number(v);
  };
  const out = { res: val('res'), price: val('price'), prevRes: val('prevRes'), play: val('play'),
    capRes: val('capRes'), capGold: val('capGold'), keepGold: val('keepGold'), keepRes: val('keepRes'),
    foodCap: val('foodCap'), stopped: /^\s*end\s*$/m.test(text.split('\n')[0] || '') };
  out.kind = out.play === 'gold' || (out.play === 'auto' && Number(out.price) >= 50) ? 'gold' : 'res';
  return out;
}

// Everything the Trading tab shows.
//   accounts: [{ id, label, holiday }]  — holiday decides which side of the play it is on
function report(mon, accounts, { minutes = 60, bucketMin = 5, dir = __dirname } = {}) {
  const now = mon.now();
  const control = readControl(dir);
  const from = now - minutes * 60000;
  const B = bucketMin * 60000;
  const first = Math.floor(from / B) * B;
  const buckets = [];
  for (let t = first; t < now; t += B) buckets.push({ t, hol: 0, ours: 0, res: {}, prices: {} });
  const acc = [];
  const readings = [];
  const R10 = 10 * 60000;
  const r10first = Math.floor((now - 60 * 60000) / R10) * R10;
  for (let t = r10first; t < now; t += R10) readings.push({ t, hol: 0, ours: 0 });

  for (const a of accounts) {
    const evs = mon.events(a.id);
    const row = { id: a.id, label: a.label, holiday: !!a.holiday, connected: a.connected ?? null,
      placed2: 0, refused2: 0, placed10: 0, sells10: 0, buys10: 0, active: new Set(), sitting: new Map(),
      // orders this account took back off the book in the same windows: placed less these
      // is what it actually traded (see CANCELLED above)
      cancelled2: 0, cancelled10: 0,
      lastOrderAt: null, conn: [], fresh: null, freshAt: null, freshCities: 0,
      // report cleaning: the latest one ({ startAt, doneAt, removed, running }) and what
      // was removed inside the window
      clean: null, cleanedInWindow: 0, cleansInWindow: 0 };
    const freshBy = new Map();
    for (const e of evs) {
      if (e.kind === 'conn') { row.conn.push({ t: e.t, text: e.text }); continue; }
      if (e.kind === 'clean') {
        if (!e.done) row.clean = { startAt: e.t, doneAt: null, removed: null, running: true };
        else {
          row.clean = { startAt: row.clean && row.clean.running ? row.clean.startAt : null, doneAt: e.t, removed: e.removed, running: false };
          if (e.t >= from) { row.cleanedInWindow += e.removed || 0; row.cleansInWindow++; }
        }
        continue;
      }
      if (e.kind === 'fresh') { freshBy.set(e.city, e); continue; }
      if (e.kind === 'sitout') { if (e.out) row.sitting.set(e.city, { t: e.t, res: e.res }); else row.sitting.delete(e.city); continue; }
      if (e.kind === 'cancel') {
        if (e.t >= now - 120000) row.cancelled2 += e.n;
        if (e.t >= now - 600000) row.cancelled10 += e.n;
        if (e.t >= first) {
          const cb = buckets[Math.floor((e.t - first) / B)];
          if (cb) { if (row.holiday) cb.hol -= e.n; else cb.ours -= e.n; }
          const cr = readings[Math.floor((e.t - r10first) / R10)];
          if (cr) { if (row.holiday) cr.hol -= e.n; else cr.ours -= e.n; }
        }
        continue;
      }
      if (e.kind !== 'order') continue;
      if (e.t >= now - 120000) { row.placed2 += e.placed; row.refused2 += e.refused; }
      if (e.t >= now - 600000) {
        row.placed10 += e.placed;
        if (e.side === 'sell') row.sells10 += e.placed; else row.buys10 += e.placed;
        if (e.placed) row.active.add(e.city);
      }
      if (e.placed) row.lastOrderAt = e.t;
      if (e.t < first || !e.placed) continue;
      const b = buckets[Math.floor((e.t - first) / B)];
      if (!b) continue;
      if (row.holiday) b.hol += e.placed; else b.ours += e.placed;
      b.res[e.res] = (b.res[e.res] || 0) + e.placed;
      b.prices[e.price] = true;
      const r = readings[Math.floor((e.t - r10first) / R10)];
      if (r) { if (row.holiday) r.hol += e.placed; else r.ours += e.placed; }
    }
    // the latest login's figures: every city's FRESHSTART from the last one
    if (freshBy.size) {
      const latest = Math.max(...[...freshBy.values()].map((e) => e.t));
      const recent = [...freshBy.values()].filter((e) => e.t >= latest - 10 * 60000);
      row.freshAt = latest;
      row.freshCities = recent.length;
      row.fresh = Object.fromEntries(RES.map((k) => [k, recent.reduce((s, e) => s + e.res[k], 0)]));
      row.freshBy = recent.map((e) => ({ city: e.city, ...e.res }));
    }
    row.side = row.sells10 > row.buys10 ? 'sell' : row.buys10 > row.sells10 ? 'buy' : null;
    row.active = row.active.size;
    row.sitting = [...row.sitting.entries()].map(([city, s]) => ({ city, ...s }));
    row.conn = row.conn.slice(-6);
    acc.push(row);
  }

  // the current resource's totals, from its first order until now
  let total = null;
  if (control && control.res) {
    let hol = 0, ours = 0;
    const since = playSince(mon, accounts, control.res, now);
    for (const a of accounts) {
      for (const e of mon.events(a.id)) {
        // a cancel names no resource, but during a play every open order of a city is the
        // one being played — the control file takes any other down — and anything before
        // `since` belongs to the play before, so the window itself keeps it honest
        if (e.kind === 'cancel') { if (e.t >= since) { if (a.holiday) hol -= e.n; else ours -= e.n; } continue; }
        if (e.kind !== 'order' || e.res !== control.res || !e.placed || e.t < since) continue;
        if (a.holiday) hol += e.placed; else ours += e.placed;
      }
    }
    // a city can cancel in one window what it placed in the one before, so clamp
    hol = Math.max(0, hol); ours = Math.max(0, ours);
    total = { res: control.res, since, hol, ours, pct: hol ? Math.round(100 * ours / hol) : null,
      holT: hol * ORDER / 1e12, oursT: ours * ORDER / 1e12 };
  }
  for (const b of buckets) { b.hol = Math.max(0, b.hol); b.ours = Math.max(0, b.ours); }
  for (const r of readings) { r.hol = Math.max(0, r.hol); r.ours = Math.max(0, r.ours); }
  for (const b of buckets) { b.pct = b.hol ? Math.round(100 * b.ours / b.hol) : null; b.prices = Object.keys(b.prices); }
  const cleaned = { removed: acc.reduce((s, a) => s + a.cleanedInWindow, 0), runs: acc.reduce((s, a) => s + a.cleansInWindow, 0),
    running: acc.filter((a) => a.clean && a.clean.running).map((a) => a.id) };
  for (const r of readings) r.pct = r.hol ? Math.round(100 * r.ours / r.hol) : null;
  return { now, control, accounts: acc, buckets, bucketMs: B, readings, total, cleaned, order: ORDER };
}

// When the play turned to `res`: the start of the latest stretch in which only `res`
// was traded (any order of another resource ends a stretch).
function playSince(mon, accounts, res, now) {
  let lastOther = 0, firstRes = null;
  for (const a of accounts) {
    for (const e of mon.events(a.id)) {
      if (e.kind !== 'order' || !e.placed) continue;
      if (e.res !== res) { if (e.t > lastOther) lastOther = e.t; }
    }
  }
  for (const a of accounts) {
    for (const e of mon.events(a.id)) {
      if (e.kind === 'order' && e.placed && e.res === res && e.t > lastOther && (firstRes === null || e.t < firstRes)) firstRes = e.t;
    }
  }
  return firstRes === null ? now : firstRes;
}

module.exports = { Monitor, parseLine, dateBackwards, dateForward, readControl, report, ORDER };
