'use strict';
// The Director's Trading tab, the SETUP side: which accounts buy and which sell, the play
// (resource, price, caps, runways), and the "Start process" / "Stop" buttons that run the
// market glitch exactly the way it is run by hand (EVONY-RULES.md §3/§4, the evony-glitch
// skill):
//
//   Start: check the sides against the holiday badges -> ONE atomic write of the control
//   file -> `glitch-run.js snap before --reset` -> `glitch-run.js start` for each buyer
//   (clean-then-buy.txt when "clean before") -> the delay -> each seller -> a watchdog
//   (play-watch.js's rules) and, if ticked, the price ladder (res-ladder.js's rules).
//   Stop: `end` as the control file's first line -> wait until the runs have gone quiet
//   -> take the `end` out again -> if ticked, `glitch-run.js start` each account onto
//   clean-reports.txt.
//
// Everything that touches the world is handed in (the store, the control file, the
// process runner, the consoles' live headers, the logs, the clock), so the whole
// sequence is tested offline (test-trading-setup.js). It is driven by tick(), which the
// Director calls every few seconds; a tick never overlaps the one before it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RES = ['food', 'wood', 'stone', 'iron'];
const FOOD_HARD = 950e9;                 // a city's food never past 950b: at 1t it RESETS TO 0
const GATE_MS = 10 * 60000;              // a console skips its autorun inside this (script-console AUTORUN_GAP_MS)
const GATE_PAD = 20000;                  // start a little after it, never on its edge
const SETUP_KEY = 'tradingSetup';
const RUN_KEY = 'tradingRun';
const GATE_KEY = 'autorunLastStart';
const SCRIPT = {
  buy: 'glitch-res-buy.txt', sell: 'glitch-res-sell.txt',
  cleanBuy: 'clean-then-buy.txt', cleanSell: 'clean-then-sell.txt', clean: 'clean-reports.txt',
};
const WATCH_MS = 2 * 60000;              // the watchdog's round (play-watch.js)
const SCRIPTLESS_MS = 4 * 60000;         // a console up this long with no order has no script
const QUIET_MS = 12 * 60000;             // no order for this long while the play is on = stopped
const REWATCH_MS = 11 * 60000;           // never restart one account twice inside the gate
const LADDER_EVERY = 10 * 60000;         // a reading every 10 minutes (res-ladder.js)
const LADDER_SETTLE = 2 * 60000;         // ignore the first 2 minutes after a price change
const LADDER_HIGH = 80, LADDER_LOW = 60;
const RUNGS = { res: [0.01, 0.1, 0.5, 1, 2, 3], gold: [100, 110, 120, 130, 140, 150] };
const DRAIN_MIN = 20000;                 // after `end`: at least this long before it comes out
const DRAIN_QUIET = 15000;               // ...and every play account's log quiet this long
const DRAIN_MAX = 150000;                // still logging after this: `end` stays in
const CLEAN_WAIT_MAX = 15 * 60000;       // clean after: give up on an account's gate after this
const LIVE_FRESH = 3 * 60000;            // a console header older than this is not "now"

const DEFAULT_SETUP = {
  sides: {},                             // accountId -> 'buy' | 'sell' (unlisted = not trading)
  play: { res: 'wood', price: 1, prevRes: 'auto', keepGold: 10e9, keepRes: 10e9, capGold: 25e12,
    caps: { food: 800e9, wood: 800e9, stone: 800e9, iron: 800e9 } },
  cleanBefore: false, cleanAfter: false, delaySec: 60, ladder: false, watchdog: true,
  gateMin: 10,                           // wait this long after an account's last restart before the tab starts it (0 = at once)
  // the price ladder, the user's own (2026-09-22): its rungs cheap -> dear, when it steps, how often
  ladderCfg: { res: [0.001, 0.01, 0.1, 0.5, 1, 2, 3], gold: RUNGS.gold.slice(), high: LADDER_HIGH, low: LADDER_LOW, everyMin: LADDER_EVERY / 60000 },
  updatedAt: null, updatedBy: null,
};

// ------------------------------------------------------------------ amounts
// "800b", "25t", "10m", "1.5k", "1,000,000", 1e12 -> a number (NaN if it is not one)
function parseAmount(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).trim().toLowerCase().replace(/[,_\s]/g, '');
  if (!s) return NaN;
  const m = /^(\d+(?:\.\d+)?(?:e\d+)?)([kmbt]?)$/.exec(s);
  if (!m) return NaN;
  const mul = { '': 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2]];
  return Math.round(Number(m[1]) * mul);
}
function fmtAmount(n) {
  n = Number(n) || 0;
  const u = [[1e12, 't'], [1e9, 'b'], [1e6, 'm'], [1e3, 'k']].find(([d]) => n >= d && n % (d / 100) === 0);
  return u ? `${+(n / u[0]).toFixed(2)}${u[1]}` : String(n);
}
// a price as the game's box takes it: at most 5 characters, 0.001 .. 150
function priceText(p) {
  const n = Number(p);
  if (!Number.isFinite(n) || n < 0.001 || n > 150) throw new Error(`price ${p} is outside the market's 0.001 – 150`);
  const s = String(+n.toFixed(3));
  if (s.length > 5) throw new Error(`price ${p} is longer than the price box's 5 characters`);
  return s;
}

// ------------------------------------------------------------- control file
// The value lines this edits are the file's top-level assignments — `res = "wood"`,
// `price = 150`, … — and the per-resource cap lines `if res == "food" capRes = …`. Every
// other line (the comments, the stop rules, the small accounts) is left exactly as it is.
const TOP = ['res', 'price', 'prevRes', 'keepGold', 'keepRes', 'capRes', 'capGold', 'foodCap', 'play'];
const topRe = (k) => new RegExp(`^${k}\\s*=\\s*(.*?)\\s*$`);
const CAP_RE = /^if res == "(food|wood|stone|iron)" capRes = ([\d.e+]+)\s*$/;
const HOLI_RE = /^if (u == "[^"]*"(?: \|\| u == "[^"]*")*) holi = 1\s*$/;
const eolOf = (text) => (/\r\n/.test(text) ? '\r\n' : '\n');
const splitLines = (text) => String(text).split(/\r?\n/);
const unquote = (v) => (/^".*"$/.test(v) ? v.slice(1, -1) : Number(v));

function parseControl(text) {
  const lines = splitLines(text);
  const out = { stopped: (lines[0] || '').trim() === 'end', caps: {}, capLines: {}, holi: [], eol: eolOf(text) };
  for (const k of TOP) {
    const re = topRe(k);
    const i = lines.findIndex((l) => re.test(l));
    out[k] = i < 0 ? null : unquote(re.exec(lines[i])[1]);
  }
  for (const l of lines) {
    const m = CAP_RE.exec(l);
    if (m && !(m[1] in out.capLines)) out.capLines[m[1]] = Number(m[2]);
    const h = HOLI_RE.exec(l);
    if (h) for (const x of h[1].matchAll(/u == "([^"]*)"/g)) if (!out.holi.includes(x[1])) out.holi.push(x[1]);
  }
  for (const r of RES) out.caps[r] = r in out.capLines ? out.capLines[r] : out.capRes;
  out.kind = out.play === 'gold' || (out.play !== 'res' && Number(out.price) >= 50) ? 'gold' : 'res';
  return out;
}

// The control file with `ch` applied — every change in ONE text, so it goes out in one
// write (EVONY-RULES §4: a window between two edits is a window the whole fleet acts on).
//   ch: { res, price, prevRes, keepGold, keepRes, capGold, caps: {food,…}, holi: [lords],
//         stop: true (put `end` first) | false (take a leading `end` out) }
function applyControl(text, ch = {}) {
  const eol = eolOf(text);
  let lines = splitLines(text);
  const cur = parseControl(text);
  const need = (k) => {
    const re = topRe(k);
    const i = lines.findIndex((l) => re.test(l));
    if (i < 0) throw new Error(`the control file has no "${k} = …" line — it is not the file this knows how to edit`);
    return i;
  };
  const set = (k, v) => { lines[need(k)] = `${k} = ${v}`; };
  if (!(Number(cur.foodCap) > 0 && Number(cur.foodCap) <= FOOD_HARD)) {
    throw new Error(`the control file's foodCap is ${cur.foodCap} — it must be at most 950b (at 1t a city's food resets to 0); fix it by hand first`);
  }
  if (ch.res !== undefined) {
    if (!RES.includes(ch.res)) throw new Error(`res must be one of ${RES.join(', ')}`);
    set('res', `"${ch.res}"`);
  }
  if (ch.price !== undefined) set('price', priceText(ch.price));
  if (ch.prevRes !== undefined) {
    if (ch.prevRes !== '' && !RES.includes(ch.prevRes)) throw new Error(`prevRes must be "" or one of ${RES.join(', ')}`);
    set('prevRes', `"${ch.prevRes}"`);
  }
  const amount = (k, v, { max } = {}) => {
    const n = parseAmount(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be an amount (e.g. 10b, 800b, 25t), not "${v}"`);
    if (max !== undefined && n > max) throw new Error(`${k} ${fmtAmount(n)} is over ${fmtAmount(max)}`);
    return Math.round(n);
  };
  for (const k of ['keepGold', 'keepRes', 'capGold']) if (ch[k] !== undefined) set(k, amount(k, ch[k]));
  if (ch.caps) {
    for (const r of RES) {
      if (ch.caps[r] === undefined) continue;
      // food's soft cap may never pass the hard one: at 1t food a city resets to 0
      const v = amount(`the ${r} cap`, ch.caps[r], r === 'food' ? { max: FOOD_HARD } : {});
      const i = lines.findIndex((l) => CAP_RE.test(l) && CAP_RE.exec(l)[1] === r);
      if (i >= 0) { lines[i] = `if res == "${r}" capRes = ${v}`; continue; }
      // a resource without its own line yet: add one after the last cap line (or capGold)
      let at = -1;
      lines.forEach((l, j) => { if (CAP_RE.test(l)) at = j; });
      if (at < 0) at = need('capGold');
      lines.splice(at + 1, 0, `if res == "${r}" capRes = ${v}`);
    }
  }
  if (ch.holi !== undefined) {
    const names = [...new Set((ch.holi || []).map((x) => String(x).trim()).filter(Boolean))];
    if (!names.length) throw new Error('the holi list cannot be emptied from here — a play needs its holiday accounts');
    if (names.some((x) => /["\\]/.test(x))) throw new Error('a lord name with a quote or backslash in it cannot go in the holi list');
    const at = lines.map((l, j) => (HOLI_RE.test(l) ? j : -1)).filter((j) => j >= 0);
    if (!at.length) throw new Error('the control file has no `if u == "…" holi = 1` line — add the SAFETY lines by hand first');
    lines[at[0]] = `if ${names.map((x) => `u == "${x}"`).join(' || ')} holi = 1`;
    for (const j of at.slice(1).reverse()) lines.splice(j, 1);
  }
  if (ch.stop === true && (lines[0] || '').trim() !== 'end') lines = ['end', ...lines];
  if (ch.stop === false) while (lines.length && lines[0].trim() === 'end') lines.shift();
  const next = lines.join(eol);
  // read back what was written: the text must parse to what was asked
  const chk = parseControl(next);
  if (ch.res !== undefined && chk.res !== ch.res) throw new Error('internal: res did not take');
  if (ch.price !== undefined && Number(chk.price) !== Number(priceText(ch.price))) throw new Error('internal: price did not take');
  if (Number(chk.foodCap) !== Number(cur.foodCap)) throw new Error('internal: foodCap changed');
  return next;
}

const versionOf = (text) => crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 12);

// Replace a file in one step: the whole text goes to a temporary file beside it, then a
// rename puts it in place. ~150 cities read the control file every second; with a plain
// write one of them could read it half-written and act on that.
function writeAtomic(file, text, { fsx = fs } = {}) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fsx.openSync(tmp, 'w');
  try { fsx.writeSync(fd, text); fsx.fsyncSync(fd); } finally { fsx.closeSync(fd); }
  let err = null;
  for (let i = 0; i < 40; i++) {
    try { fsx.renameSync(tmp, file); return; } catch (e) {
      err = e;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);   // a reader has it open: a moment
    }
  }
  try { fsx.unlinkSync(tmp); } catch { /* gone */ }
  throw new Error(`could not put the control file in place (${err && err.code || err}) — nothing was changed`);
}

// The control file as a store: read() -> { text, version }; write(text, expect) refuses
// if the file changed since `expect` was read (another session, a hand edit).
function controlFile(file, { fsx = fs } = {}) {
  return {
    file,
    read() { const text = fsx.readFileSync(file, 'utf8'); return { text, version: versionOf(text) }; },
    write(text, expect) {
      if (expect) {
        const now = versionOf(fsx.readFileSync(file, 'utf8'));
        if (now !== expect) throw Object.assign(new Error('the control file changed since it was read — reload and try again'), { conflict: true });
      }
      writeAtomic(file, text, { fsx });
      return versionOf(text);
    },
  };
}

// ------------------------------------------------------------------- the logs
// When an account's console last logged a line of a glitch loop, from the end of its log:
// every loop of glitch-res-buy/sell.txt logs either its order batch ("line 25: buy wood …")
// or its wait on a full city ("line 30: sleep 0.3") — the control file's own lines are
// silenced by @call. Other scripts (a job, a capture) are not counted. 0 if none in 64 KB.
const PLAY_LINE = /^\[(?:autorun [^\]]+|script)\] (\d\d):(\d\d):(\d\d)\.(\d{3}) line \d+: (?:sleep 0\.3\s*$|(?:buy|sell) (?:food|wood|stone|iron) )/;
function lastScriptLineAt(dir, id, now = Date.now()) {
  const f = path.join(dir, `console-${id}.log`);
  let text = '';
  try {
    const size = fs.statSync(f).size, from = Math.max(0, size - 65536);
    const fd = fs.openSync(f, 'r');
    try { const b = Buffer.alloc(size - from); fs.readSync(fd, b, 0, b.length, from); text = b.toString('utf8'); } finally { fs.closeSync(fd); }
  } catch { return 0; }
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = PLAY_LINE.exec(lines[i]);
    if (!m) continue;
    const d = new Date(now); d.setHours(+m[1], +m[2], +m[3], +m[4]);
    let t = d.getTime();
    if (t > now + 300000) t -= 86400000;
    return t;
  }
  return 0;
}

// ------------------------------------------------------------------- checks
// accounts: [{ id, label, enabled, holiday: true|false|null, lord, connected, state,
//              reason, processDown, maintenance }]
// -> { errors, warnings, kind, bankSide, oursSide, buy, sell }
function checkPlay({ sides = {}, accounts = [], price, control = null, forStart = false }) {
  const errors = [], warnings = [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const buy = [], sell = [];
  for (const [id, s] of Object.entries(sides)) {
    if (!byId.has(id)) { warnings.push(`${id} is in the setup but not in the fleet — left out`); continue; }
    if (s === 'buy') buy.push(id); else if (s === 'sell') sell.push(id);
  }
  const p = Number(price);
  const kind = p >= 50 ? 'gold' : 'res';
  const bankSide = kind === 'gold' ? 'buy' : 'sell';
  const oursSide = bankSide === 'buy' ? 'sell' : 'buy';
  const lbl = (id) => (byId.get(id) || {}).label || id;
  if (!Number.isFinite(p)) errors.push('set a price');
  if (forStart) {
    if (!buy.length) errors.push('nobody is buying — drag accounts into "Buying"');
    if (!sell.length) errors.push('nobody is selling — drag accounts into "Selling"');
  }
  const banks = bankSide === 'buy' ? buy : sell, ours = bankSide === 'buy' ? sell : buy;
  // THE rule (EVONY-RULES §4): selling under 50 or buying at 50+ is only for accounts ON
  // HOLIDAY — out of holiday it is a real loss. The truth is the console's live header.
  for (const id of banks) {
    const a = byId.get(id);
    if (!a) continue;
    const what = kind === 'gold' ? `buys at ${p} (50 or more)` : `sells at ${p} (under 50)`;
    if (a.holiday === true) continue;
    errors.push(a.holiday === false
      ? `${a.label} is NOT on holiday, and the ${bankSide === 'buy' ? 'Buying' : 'Selling'} side ${what} — only a holiday account may; for any other it gives the ${kind === 'gold' ? 'gold' : 'resource'} away for real`
      : `${a.label}'s holiday state is unknown (its console is not reporting) — the ${bankSide === 'buy' ? 'Buying' : 'Selling'} side ${what}, which only a holiday account may`);
  }
  for (const id of ours) {
    const a = byId.get(id);
    if (a && a.holiday === true) warnings.push(`${a.label} is on holiday but on OUR side (${oursSide === 'buy' ? 'buying' : 'selling'}) — whatever it takes in is put back at maintenance`);
  }
  for (const id of [...buy, ...sell]) {
    const a = byId.get(id);
    if (!a) continue;
    if (a.enabled === false) errors.push(`${a.label} is switched off in the Fleet tab — switching it on is the user's call`);
    else if (a.maintenance) errors.push(`${a.label} is in server maintenance — no start until it is over`);
    else if (!a.connected && !a.processDown) {
      (forStart ? errors : warnings).push(`${a.label} is not logged in (${a.reason || a.state || 'no header'}) — a restart now adds a login into whatever is holding it (a rate limit is made worse by one)`);
    }
  }
  // the control file's own SAFETY lines: a bank whose lord is not in `holi` has its runs
  // ended on its first loop; a lord in it that is not on holiday is not protected
  if (control && Array.isArray(control.holi)) {
    const holi = new Set(control.holi);
    for (const id of banks) {
      const a = byId.get(id);
      if (!a || a.holiday !== true) continue;
      if (!a.lord) { warnings.push(`${a.label}: its in-game name is not known yet, so the holi list cannot be checked for it`); continue; }
      if (!holi.has(a.lord)) {
        errors.push(`${a.label} (in-game "${a.lord}") is not in the control file's holi list — the SAFETY line would end its runs on the first loop. Use "Set holi list".`);
      }
    }
    const lordOf = new Map(accounts.filter((a) => a.lord).map((a) => [a.lord, a]));
    for (const name of holi) {
      const a = lordOf.get(name);
      if (a && a.holiday === false) warnings.push(`the holi list names "${name}" (${a.label}), which is NOT on holiday — the SAFETY line does not protect it`);
      if (!a && !accounts.some((x) => x.lord && x.lord.toLowerCase() === String(name).toLowerCase())) {
        warnings.push(`the holi list names "${name}", which no reporting console is logged in as`);
      }
    }
  }
  return { errors, warnings, kind, bankSide, oursSide, buy, sell, banks, ours: ours.slice(), labels: Object.fromEntries([...buy, ...sell].map((id) => [id, lbl(id)])) };
}

// -------------------------------------------------------------------- setup
function cleanSetup(raw) {
  const s = JSON.parse(JSON.stringify(DEFAULT_SETUP));
  if (!raw || typeof raw !== 'object') return s;
  if (raw.sides && typeof raw.sides === 'object') {
    for (const [id, v] of Object.entries(raw.sides)) if (v === 'buy' || v === 'sell') s.sides[id] = v;
  }
  const p = raw.play || {};
  if (RES.includes(p.res)) s.play.res = p.res;
  if (p.price !== undefined && Number.isFinite(Number(p.price))) s.play.price = Number(p.price);
  if (p.prevRes === 'auto' || p.prevRes === '' || RES.includes(p.prevRes)) s.play.prevRes = p.prevRes;
  for (const k of ['keepGold', 'keepRes', 'capGold']) if (p[k] !== undefined && Number.isFinite(parseAmount(p[k]))) s.play[k] = parseAmount(p[k]);
  if (p.caps) for (const r of RES) if (p.caps[r] !== undefined && Number.isFinite(parseAmount(p.caps[r]))) s.play.caps[r] = parseAmount(p.caps[r]);
  for (const k of ['cleanBefore', 'cleanAfter', 'ladder', 'watchdog']) if (raw[k] !== undefined) s[k] = !!raw[k];
  if (raw.delaySec !== undefined && Number.isFinite(Number(raw.delaySec))) s.delaySec = Math.max(0, Math.min(3600, Math.round(Number(raw.delaySec))));
  if (raw.gateMin !== undefined && raw.gateMin !== '' && Number.isFinite(Number(raw.gateMin))) s.gateMin = Math.max(0, Math.min(60, Number(raw.gateMin)));
  if (raw.ladderCfg && typeof raw.ladderCfg === 'object') s.ladderCfg = cleanLadder(raw.ladderCfg, s.ladderCfg);
  s.updatedAt = raw.updatedAt || null; s.updatedBy = raw.updatedBy || null;
  return s;
}
// The ladder's settings as the user typed them -> clean ones. Rungs are a list ("0.001 0.01
// 0.1" or an array), each a price the market box takes, sorted cheap -> dear, at least two.
// Throws on anything it can't use, so a bad save says why instead of quietly doing nothing.
function cleanLadder(raw, base = DEFAULT_SETUP.ladderCfg) {
  const out = JSON.parse(JSON.stringify(base));
  const rungs = (v, what) => {
    const list = (Array.isArray(v) ? v : String(v).split(/[\s,;/]+/)).filter((x) => String(x).trim() !== '').map(Number);
    if (list.some((n) => !Number.isFinite(n))) throw new Error(`the ${what} ladder must be prices, e.g. 0.001 0.01 0.1`);
    for (const n of list) priceText(n);
    const u = [...new Set(list.map((n) => +priceText(n)))].sort((a, b) => a - b);
    if (u.length < 2) throw new Error(`the ${what} ladder needs at least two rungs`);
    return u;
  };
  if (raw.res !== undefined) out.res = rungs(raw.res, 'resource');
  if (raw.gold !== undefined) out.gold = rungs(raw.gold, 'gold');
  const pct = (v, what) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`${what} must be a percentage 0-100`); return n; };
  if (raw.high !== undefined) out.high = pct(raw.high, 'the step-our-way share');
  if (raw.low !== undefined) out.low = pct(raw.low, 'the step-back share');
  if (!(out.low < out.high)) throw new Error('the ladder steps back under a LOWER share than it steps our way (e.g. 60 and 80)');
  if (raw.everyMin !== undefined) {
    const n = Number(raw.everyMin);
    if (!Number.isFinite(n) || n < 3 || n > 240) throw new Error('the ladder reads every 3 to 240 minutes');
    out.everyMin = n;
  }
  return out;
}
// the play's settings -> the control file change for them
function playChange(play, control) {
  const ch = { res: play.res, price: play.price, keepGold: play.keepGold, keepRes: play.keepRes, capGold: play.capGold, caps: { ...play.caps } };
  // prevRes "auto": the resource the file names now, when the play moves off it
  if (play.prevRes === 'auto') { if (control && control.res && control.res !== play.res) ch.prevRes = control.res; }
  else ch.prevRes = play.prevRes;
  return ch;
}

// Only what was sent: { price: 3 } changes the price and nothing else. prevRes "auto" (or
// left out) with a new res = the resource the file names now.
function partialChange(patch = {}, control = null) {
  const ch = {};
  if (patch.res !== undefined) ch.res = patch.res;
  if (patch.price !== undefined) ch.price = Number(patch.price);
  for (const k of ['keepGold', 'keepRes', 'capGold']) if (patch[k] !== undefined && patch[k] !== '') ch[k] = patch[k];
  if (patch.caps) for (const r of RES) if (patch.caps[r] !== undefined && patch.caps[r] !== '') (ch.caps = ch.caps || {})[r] = patch.caps[r];
  if (patch.prevRes !== undefined && patch.prevRes !== 'auto') ch.prevRes = patch.prevRes;
  else if (ch.res !== undefined && control && control.res && control.res !== ch.res) ch.prevRes = control.res;
  return ch;
}

// -------------------------------------------------------------------- the run
class Runner {
  // store: { get(k, d), set(k, v) }                     — the org's settings (the DB)
  // control: controlFile(...)                            — the play's single source
  // exec(args) -> Promise<{ ok, out }>                   — `node glitch-run.js <args>`
  // accounts() -> [{ id, label, enabled, holiday, lord, connected, state, reason,
  //                  processDown, maintenance, at }]     — the consoles' live headers
  // monitor: { events(id) }                              — trade-monitor.js
  // lastLineAt(id) -> ms                                 — lastScriptLineAt
  // `archive` is called with every saved run, so a finished one survives the next
  // Start: the settings keep only the CURRENT run, and without this the Glitch log
  // could never say what a past day's play actually was (glitch-log.js archiveRun).
  constructor({ store, control, exec, accounts, monitor, lastLineAt, archive = null, now = () => Date.now(), note = () => {} }) {
    Object.assign(this, { store, control, exec, accountsOf: accounts, monitor, lastLineAt, archive, now, noteOut: note });
    this.busy = false;
    // A stop (or a live edit's note) that comes in while a tick is awaiting a start is
    // held here and applied when that tick ends — the tick holds its own copy of the run
    // and would otherwise write over it.
    this.pendingStop = null;
    this.pendingEvents = [];
  }

  // Never saved yet: the play starts as the control file has it now.
  setup() {
    const saved = this.store.get(SETUP_KEY, null);
    if (saved) return cleanSetup(saved);
    const s = cleanSetup(null);
    try {
      const c = parseControl(this.control.read().text);
      if (RES.includes(c.res)) s.play.res = c.res;
      if (Number(c.price) > 0) s.play.price = Number(c.price);
      for (const k of ['keepGold', 'keepRes', 'capGold']) if (Number.isFinite(Number(c[k])) && c[k] !== null) s.play[k] = Number(c[k]);
      for (const r of RES) if (Number.isFinite(Number(c.caps[r])) && c.caps[r] !== null) s.play.caps[r] = Math.min(Number(c.caps[r]), r === 'food' ? FOOD_HARD : Infinity);
    } catch { /* no control file: the defaults */ }
    return s;
  }
  saveSetup(patch = {}, by = 'user') {
    const cur = this.setup();
    const merged = { ...cur, ...patch, play: { ...cur.play, ...(patch.play || {}), caps: { ...cur.play.caps, ...((patch.play || {}).caps || {}) } } };
    if (patch.sides) merged.sides = patch.sides;           // the whole assignment, as sent
    const s = cleanSetup({ ...merged, updatedAt: this.now(), updatedBy: by });
    for (const r of RES) if (r === 'food' && s.play.caps.food > FOOD_HARD) throw new Error('the food cap may not pass 950b (at 1t food a city resets to 0)');
    priceText(s.play.price);
    this.store.set(SETUP_KEY, s);
    return s;
  }
  run() { return this.store.get(RUN_KEY, null); }
  active() { const r = this.run(); return !!(r && ['starting', 'running', 'stopping'].includes(r.state)); }
  save(run) {
    if (this.pendingEvents.length) (run.events = run.events || []).push(...this.pendingEvents.splice(0));
    run.events = (run.events || []).slice(-300);
    this.store.set(RUN_KEY, run);
    // The archive must never be able to break a run: it is a record of what
    // happened, and the play matters more than the record of it.
    if (this.archive) { try { this.archive(run); } catch (e) { this.noteOut('trading: archiving the run failed — ' + e.message); } }
    return run;
  }
  say(run, m) { (run.events = run.events || []).push({ t: this.now(), m }); this.noteOut('trading: ' + m); }
  gate(id) { const g = this.store.get(GATE_KEY, {}) || {}; return Number(g[id]) || 0; }
  // The tab's own restart gate, in the setup (the user, 2026-09-22: "allow me to edit the gate
  // in the trading to x minutes where 0 minutes mean immediately"). The console's 10-minute
  // gate (script-console AUTORUN_GAP_MS) stays — it guards against crash loops and restarts
  // nobody meant; a start from here is meant, so clearGate() lifts it just before it.
  gateMs() { return this.setup().gateMin * 60000; }
  gateUntil(id) {
    const g = this.gate(id), ms = this.gateMs();
    if (!g) return 0;
    return ms >= GATE_MS ? g + ms + GATE_PAD : g + ms;
  }
  gateText() { const m = this.setup().gateMin; return m ? `${m}-minute` : 'no'; }
  // a deliberate start: date the console's last autorun start back past its 10 minutes, so
  // the console it is about to restart runs its scripts instead of skipping them
  clearGate(id) {
    const g = this.store.get(GATE_KEY, {}) || {}, last = Number(g[id]) || 0, now = this.now();
    if (!last || now - last >= GATE_MS + GATE_PAD) return false;
    this.store.set(GATE_KEY, { ...g, [id]: now - GATE_MS - 60000 });
    return true;
  }
  byId() { return new Map(this.accountsOf().map((a) => [a.id, a])); }

  view() {
    const setup = this.setup();
    let control = null, controlError = null;
    try { const c = this.control.read(); control = { ...parseControl(c.text), version: c.version }; } catch (e) { controlError = e.message; }
    const accounts = this.accountsOf().map((a) => ({ ...a, gateUntil: this.gateUntil(a.id), side: setup.sides[a.id] || null }));
    const check = checkPlay({ sides: setup.sides, accounts, price: setup.play.price, control, forStart: true });
    const run = this.run();
    return { setup, run, control, controlError, accounts, check, now: this.now(), stopStatus: this.stopStatus(run) };
  }

  // What a Stop is doing and when Start comes back (the user, 2026-09-22: "Start process is
  // still blurred out — add an expected time?"). The times are real, not guesses: the drain
  // ends between DRAIN_MIN and DRAIN_MAX after `end`, and "clean after" restarts each account
  // the moment its autorun gate opens (gateUntil), a few seconds apiece — so the stop is
  // done when the LAST pending account's gate opens. -> { step, text, eta } | null
  stopStatus(run) {
    if (!run || run.state !== 'stopping' || !run.stop) return null;
    const S = run.stop, now = this.now();
    if (S.step === 'end') return { step: 'end', text: 'writing `end` into the control file', eta: now + DRAIN_MAX };
    if (S.step === 'drain' || S.step === 'restore') {
      const eta = Math.max((S.endAt || now) + DRAIN_MIN, now);
      return { step: 'drain', text: 'waiting for every city to finish its last batch and end its run (20 s to 2½ min)', eta };
    }
    if (S.step === 'clean') {
      const ids = [...(run.buy || []), ...(run.sell || [])];
      if (!run.cleanAfter) return { step: 'clean', text: 'finishing', eta: now };
      const pending = ids.filter((id) => !(S.clean[id] && S.clean[id].done));
      const done = ids.length - pending.length;
      const last = Math.max(now, ...pending.map((id) => this.gateUntil(id) || now));
      const eta = last + pending.length * 3000;
      const waitingOn = pending.map((id) => `${run.labels[id] || id}${this.gateUntil(id) > now ? ' ' + hhmm(this.gateUntil(id)) : ''}`);
      return { step: 'clean', text: `cleaning reports: ${done} of ${ids.length} accounts restarted onto the clean`
        + (pending.length ? ` — waiting on each one's ${this.gateText()} restart gate: ${waitingOn.join(', ')}` : ''), eta };
    }
    return null;
  }

  // Put the play's settings (and/or the holi list) into the control file NOW — live for
  // every city within a second.
  applyLive(ch, expect) {
    const c = this.control.read();
    const next = applyControl(c.text, ch);
    const version = this.control.write(next, expect || c.version);
    const run = this.run();
    if (run && this.active()) {
      const m = `control file changed live: ${describe(ch)}`;
      if (this.busy) { this.pendingEvents.push({ t: this.now(), m }); this.noteOut('trading: ' + m); } else { this.say(run, m); this.save(run); }
    }
    return { version, control: parseControl(next) };
  }

  start(opts = {}) {
    if (this.active()) throw new Error(`a play is already ${this.run().state} — stop it first`);
    const setup = this.setup();
    const accounts = this.accountsOf();
    const c = this.control.read();
    const cur = parseControl(c.text);
    const check = checkPlay({ sides: setup.sides, accounts, price: setup.play.price, control: cur, forStart: true });
    if (check.errors.length) { const e = new Error(check.errors.join('\n')); e.check = check; throw e; }
    // ONE write: the play's values and the `end` taken out, together
    const ch = { ...playChange(setup.play, cur), stop: false };
    const text = applyControl(c.text, ch);
    const now = this.now();
    const run = {
      id: now.toString(36), state: 'starting', phase: 'snap', createdAt: now, by: opts.by || 'user',
      buy: check.buy, sell: check.sell, banks: check.banks, ours: check.ours, labels: check.labels,
      kind: check.kind, bankSide: check.bankSide, res: setup.play.res, price: Number(setup.play.price),
      buyScript: setup.cleanBefore ? SCRIPT.cleanBuy : SCRIPT.buy, sellScript: setup.cleanBefore ? SCRIPT.cleanSell : SCRIPT.sell,
      delayMs: setup.delaySec * 1000, cleanBefore: setup.cleanBefore, cleanAfter: setup.cleanAfter,
      ladder: setup.ladder, watchdog: setup.watchdog,
      started: {}, waiting: {}, sellAt: null, buyDoneAt: null, runningAt: null,
      watch: { lastRound: 0, restarted: {}, said: {}, holidayStrikes: {} },
      lad: { lastRead: now, lastChange: now, standDown: false },
      stop: null, events: [],
    };
    this.control.write(text, c.version);
    this.say(run, `start: ${check.kind === 'gold' ? 'GOLD play' : 'RESOURCE play'} ${setup.play.res} @ ${priceText(setup.play.price)} — `
      + `buying ${check.buy.map((id) => check.labels[id]).join(', ')} (${run.buyScript}); selling ${check.sell.map((id) => check.labels[id]).join(', ')} (${run.sellScript}), `
      + `${setup.delaySec}s after the buyers${cur.stopped ? ' · the `end` line was taken out of the control file' : ''}`);
    for (const w of check.warnings) this.say(run, 'warning: ' + w);
    return this.save(run);
  }

  // The Stop button. Mid-tick it is held and applied as soon as that tick is done.
  requestStop(o = {}) {
    if (this.busy) {
      this.pendingStop = { ...o };
      const run = this.run();
      return run ? { ...run, stopPending: true } : null;
    }
    return this.stopNow(o);
  }

  stopNow({ clean, by = 'user' } = {}) {
    let run = this.run();
    if (run && run.state === 'stopping') return run;
    if (!run || !this.active()) {
      // nothing started from here: still stop whatever the control file is running, for
      // the accounts in the setup (a play started by hand)
      const setup = this.setup();
      const ids = Object.keys(setup.sides);
      run = { id: this.now().toString(36), state: 'stopping', phase: null, createdAt: this.now(), by, buy: ids.filter((i) => setup.sides[i] === 'buy'),
        sell: ids.filter((i) => setup.sides[i] === 'sell'), labels: {}, started: {}, waiting: {}, events: [], watch: {}, lad: {} };
      for (const a of this.accountsOf()) if (ids.includes(a.id)) run.labels[a.id] = a.label;
      run.cleanAfter = clean === undefined ? setup.cleanAfter : !!clean;
    } else if (clean !== undefined) run.cleanAfter = !!clean;
    run.state = 'stopping';
    run.stop = { requestedAt: this.now(), by, step: 'end', endAt: null, endByUs: false, restoredAt: null, clean: {} };
    this.say(run, `stop asked (${by})${run.cleanAfter ? ' — reports cleaned after' : ''}`);
    return this.save(run);
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const run = this.run();
      if (!run) return;
      if (run.state === 'starting') await this.tickStart(run);
      else if (run.state === 'running') await this.tickRunning(run);
      else if (run.state === 'stopping') await this.tickStop(run);
    } catch (e) {
      const run = this.run();
      if (run) { this.say(run, 'error: ' + e.message); this.save(run); }
    } finally {
      this.busy = false;
      if (this.pendingStop) { const o = this.pendingStop; this.pendingStop = null; this.stopNow(o); }
    }
  }

  // start the accounts of one side whose autorun gate is clear; true once all are done
  async startSide(run, ids, flag, script) {
    const byId = this.byId();
    for (const id of ids) {
      if (run.started[id]) continue;
      if (this.pendingStop) return false;                    // a stop came in meanwhile
      const until = this.gateUntil(id);
      if (until > this.now()) {
        if (run.waiting[id] !== until) {
          run.waiting[id] = until;
          this.say(run, `${run.labels[id] || id} waits for its restart gate — its console last started its scripts at ${hhmm(this.gate(id))}, and the setup waits ${this.setup().gateMin} min after that; starting it at ${hhmm(until)}`);
          this.save(run);
        }
        continue;
      }
      const a = byId.get(id);
      if (a && !a.connected && !a.processDown) {
        if (run.waiting[id] !== 'login') {
          run.waiting[id] = 'login';
          this.say(run, `${run.labels[id] || id} is not logged in (${a.reason || a.state || '?'}) — waiting for it rather than adding a login`);
          this.save(run);
        }
        continue;
      }
      delete run.waiting[id];
      if (this.clearGate(id)) this.say(run, `${run.labels[id] || id}: its console restarted under 10 minutes ago — its autorun gate is lifted for this start`);
      const r = await this.exec(['start', `--${flag}`, id, `--${flag}-script`, script]);
      const ok = r.ok && /console up, pid \d+/.test(r.out || '');
      run.started[id] = { at: this.now(), ok, script, out: String(r.out || r.error || '').trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 300) };
      this.say(run, `${run.labels[id] || id}: ${ok ? `started on ${script}` : `start FAILED — ${run.started[id].out}`}`);
      this.save(run);
    }
    return ids.every((id) => run.started[id]);
  }

  async tickStart(run) {
    if (run.phase === 'snap') {
      const r = await this.exec(['snap', 'before', '--reset']);
      this.say(run, r.ok ? 'snapshot "before" taken (a new series)' : `snapshot "before" failed — ${String(r.out || r.error || '').slice(0, 200)} (carrying on)`);
      run.phase = 'buy';
      this.save(run);
    }
    if (run.phase === 'buy') {
      if (!await this.startSide(run, run.buy, 'buy', run.buyScript)) return;
      run.buyDoneAt = this.now();
      run.sellAt = run.buyDoneAt + run.delayMs;
      run.phase = 'delay';
      this.say(run, `every buyer is started — the sellers start at ${hhmm(run.sellAt)} (${Math.round(run.delayMs / 1000)}s head start)`);
      this.save(run);
    }
    if (run.phase === 'delay') {
      if (this.now() < run.sellAt) return;
      // the holiday check again, right before the side that needs it goes
      const check = checkPlay({ sides: Object.fromEntries([...run.buy.map((i) => [i, 'buy']), ...run.sell.map((i) => [i, 'sell'])]),
        accounts: this.accountsOf(), price: this.livePrice(run), forStart: false });
      const bad = check.errors.filter((e) => /holiday/i.test(e));
      if (bad.length) {
        this.say(run, `NOT starting the sellers: ${bad.join(' · ')} — stopping the play`);
        this.save(run);
        this.stopNow({ clean: false, by: 'safety' });
        return;
      }
      run.phase = 'sell';
      this.save(run);
    }
    if (run.phase === 'sell') {
      if (!await this.startSide(run, run.sell, 'sell', run.sellScript)) return;
      run.phase = 'done';
      run.state = 'running';
      run.runningAt = this.now();
      run.watch.lastRound = this.now();
      run.lad.lastRead = this.now();
      this.say(run, `the play is running${run.watchdog ? ' · the watchdog is on' : ''}${run.ladder ? ' · the price ladder is on' : ''}`);
      this.save(run);
    }
  }

  livePrice(run) {
    try { return Number(parseControl(this.control.read().text).price); } catch { return run.price; }
  }

  async tickRunning(run) {
    // SAFETY, every tick: a bank that has left holiday stops the play at once
    // (EVONY-RULES §4: stop BEFORE any holiday-side account leaves holiday). Two readings
    // of two different header samples, so one odd header does not stop everything.
    const byId = this.byId();
    for (const id of run.banks || []) {
      const a = byId.get(id);
      if (!a || !a.connected || !a.fresh) continue;
      const s = run.watch.holidayStrikes[id] || { n: 0, at: 0 };
      if (a.holiday === false) { if (a.at !== s.at) { s.n++; s.at = a.at; } } else { s.n = 0; }
      run.watch.holidayStrikes[id] = s;
      if (s.n >= 2) {
        this.say(run, `${run.labels[id] || id} is NO LONGER ON HOLIDAY — stopping the play now (a bank out of holiday gives it away for real)`);
        this.save(run);
        this.stopNow({ clean: false, by: 'safety' });
        return;
      }
    }
    if (run.watchdog && this.now() - run.watch.lastRound >= WATCH_MS) { run.watch.lastRound = this.now(); await this.watchdog(run); }
    // the ladder follows the setup LIVE: its switch, rungs, shares and interval (the user,
    // 2026-09-22: "allow me to configure my own ladder and turn it on/off")
    const S = this.setup();
    if (S.ladder !== !!run.ladder) { run.ladder = S.ladder; run.lad.lastRead = this.now(); this.say(run, `the price ladder is ${S.ladder ? 'ON' : 'off'}`); }
    if (run.ladder && this.now() - run.lad.lastRead >= S.ladderCfg.everyMin * 60000) { run.lad.lastRead = this.now(); this.ladder(run, S.ladderCfg); }
    this.save(run);
  }

  // play-watch.js's watchdog: put back a console that came up with no play script, or an
  // account that simply stopped placing — but never one sitting out on a cap, one whose
  // run ended on its first loop (out of the resource), one inside the autorun gate, or
  // one whose console is not logged in (a restart adds a login to a rate limit).
  async watchdog(run) {
    const now = this.now();
    const byId = this.byId();
    for (const [ids, flag, script] of [[run.buy, 'buy', SCRIPT.buy], [run.sell, 'sell', SCRIPT.sell]]) {
      for (const id of ids) {
        const lbl = run.labels[id] || id;
        let up = 0, order = 0, sitout = 0, fresh = 0;
        for (const e of this.monitor.events(id)) {
          if (e.kind === 'conn' && /(session supervisor started|refresh — logging in afresh)/.test(e.text)) up = Math.max(up, e.t);
          if (e.kind === 'order' && e.placed) order = Math.max(order, e.t);
          if (e.kind === 'sitout' && e.out) sitout = Math.max(sitout, e.t);
          if (e.kind === 'fresh') fresh = Math.max(fresh, e.t);
        }
        const since = (run.started[id] && run.started[id].at) || run.runningAt || 0;
        const scriptless = up && up > order && now - up >= SCRIPTLESS_MS;
        const quiet = now - Math.max(order, since) >= QUIET_MS;
        if (!scriptless && !quiet) continue;
        const once = (k, m) => { if (run.watch.said[id + k] !== true) { run.watch.said[id + k] = true; this.say(run, m); } };
        const a = byId.get(id);
        if (a && !a.connected) { once(':offline', `watchdog: ${lbl} is quiet but not logged in (${a.reason || a.state || '?'}) — left to its console's own reconnect, never restarted into a rate limit`); continue; }
        if (!scriptless && sitout > order) { once(':sitout', `watchdog: ${lbl} is sitting out on a cap, not stalled — left alone`); continue; }
        if (!scriptless && fresh > order) { once(':fresh', `watchdog: ${lbl} started and ended on its first loop — it is out of ${run.res} (or under its runway). A restart will not help; switch resource.`); continue; }
        if (now - (run.watch.restarted[id] || 0) < REWATCH_MS) continue;
        const g = this.gate(id);
        if (g && now - g < REWATCH_MS) continue;          // someone restarted it: inside the gate
        run.watch.restarted[id] = now;
        delete run.watch.said[id + ':fresh']; delete run.watch.said[id + ':sitout']; delete run.watch.said[id + ':offline'];
        this.say(run, `watchdog: ${lbl} — ${scriptless ? `console came up at ${hhmm(up)} with no script` : `nothing placed since ${order ? hhmm(order) : 'the start'}`} — putting it back on ${script}`);
        const r = await this.exec(['start', `--${flag}`, id, `--${flag}-script`, script]);
        if (!(r.ok && /console up, pid \d+/.test(r.out || ''))) this.say(run, `watchdog: restart of ${lbl} failed — ${String(r.out || r.error || '').trim().slice(-200)}`);
      }
    }
  }

  // res-ladder.js's rules: of the orders the banks placed, the share ours placed. Over 80%
  // steps the better way for us (cheaper in a resource play, dearer in a gold play), under
  // 60% the other. Never judged on a broken fleet, never on a price set by hand.
  ladder(run, cfg = this.setup().ladderCfg) {
    const now = this.now(), L = run.lad;
    const HIGH = cfg.high, LOW = cfg.low, EVERY = cfg.everyMin * 60000;
    let c;
    try { c = parseControl(this.control.read().text); } catch (e) { this.say(run, 'ladder: control file unreadable — ' + e.message); return; }
    // a resource switched live (Apply): follow it, judging from now — never stand down
    if (c.res !== run.res) { this.say(run, `ladder: the play is ${c.res} now (was ${run.res}) — judging it from here`); run.res = c.res; L.lastChange = now; return; }
    if (c.stopped) return;
    const from = Math.max(L.lastChange + LADDER_SETTLE, now - EVERY);
    // A CANCELLED BID IS NOT A FILL. Our buying side cancels and re-places its whole book to
    // keep its slots turning over, so the raw placed count ran 10-20x the real one (ours
    // 103,452 against the banks' 10,198 on 2026-09-27) and the ladder stepped cheaper every
    // round down to 0.001, where over half the banks' stock went to strangers. Net the
    // cancels off, as the Trading tab's Return does (trade-monitor.js). `alive` still counts
    // any account that sent orders: a busy recycler is alive even when it nets to nothing.
    const count = (ids) => {
      let placed = 0, alive = 0;
      for (const id of ids) {
        let n = 0, back = 0;
        for (const e of this.monitor.events(id)) {
          if (e.t < from || e.t >= now) continue;
          if (e.kind === 'order' && e.placed) n += e.placed;
          else if (e.kind === 'cancel' && e.n) back += e.n;
        }
        placed += Math.max(0, n - back); if (n) alive++;
      }
      return { placed, alive };
    };
    const b = count(run.banks), o = count(run.ours);
    const pct = b.placed ? Math.round(100 * o.placed / b.placed) : null;
    const needB = Math.min(3, run.banks.length), needO = Math.min(5, run.ours.length);
    if (pct === null) { this.say(run, `ladder: nothing traded ${hhmm(from)}–${hhmm(now)} — not judged`); return; }
    if (b.alive < needB || o.alive < needO) {
      this.say(run, `ladder: ${pct}% but only ${b.alive} of ${run.banks.length} banks and ${o.alive} of ${run.ours.length} of ours traded — not judged (fix the fleet first)`);
      return;
    }
    const mode = c.kind === 'gold' ? 'gold' : 'res';
    const rungs = cfg[mode];
    const i = rungs.findIndex((r) => Math.abs(r - Number(c.price)) < 1e-9);
    if (i < 0) { this.say(run, `ladder: ${pct}% — price ${c.price} is not one of ${rungs.join('/')} (set by hand), left alone`); return; }
    const better = mode === 'res' ? -1 : +1;          // cheaper is better for a resource, dearer for gold
    const step = pct > HIGH ? better : pct < LOW ? -better : 0;
    if (!step) { this.say(run, `ladder: ${pct}% at ${c.price} — holding`); return; }
    const j = i + step;
    if (j < 0 || j >= rungs.length) { this.say(run, `ladder: ${pct}% and ${c.price} is the end of the ladder — tell the user before going further`); return; }
    const cur = this.control.read();
    this.control.write(applyControl(cur.text, { price: rungs[j] }), cur.version);
    L.lastChange = now;
    this.say(run, `ladder: PRICE ${c.price} -> ${rungs[j]} (${pct}% ${pct > HIGH ? `over ${HIGH}` : `under ${LOW}`}%)`);
  }

  async tickStop(run) {
    const S = run.stop;
    const ids = [...(run.buy || []), ...(run.sell || [])];
    // the drain watches EVERY account, not only the play's: a play started by hand (or a
    // city somebody restarted onto a glitch script) must end before `end` comes out
    const drainIds = [...new Set([...ids, ...this.accountsOf().map((a) => a.id)])];
    if (S.step === 'end') {
      const c = this.control.read();
      if (parseControl(c.text).stopped) { S.endByUs = false; this.say(run, 'the control file already had `end` first — it stays as it was found'); }
      else { this.control.write(applyControl(c.text, { stop: true }), c.version); S.endByUs = true; this.say(run, '`end` written first in the control file — every city ends its run on its next loop'); }
      S.endAt = this.now();
      S.step = 'drain';
      this.save(run);
      return;
    }
    if (S.step === 'drain') {
      const now = this.now();
      if (now - S.endAt < DRAIN_MIN) return;
      const busy = drainIds.filter((id) => (this.lastLineAt(id) || 0) > now - DRAIN_QUIET);
      if (busy.length && now - S.endAt < DRAIN_MAX) return;
      if (busy.length) {
        this.say(run, `still logging glitch-loop lines ${Math.round((now - S.endAt) / 1000)}s after \`end\`: ${busy.map((id) => run.labels[id] || id).join(', ')} — \`end\` STAYS in the control file (take it out by hand, or Start again, once they are quiet)`);
        S.step = 'clean';
      } else S.step = 'restore';
      this.save(run);
    }
    if (S.step === 'restore') {
      if (S.endByUs) {
        const c = this.control.read();
        if (parseControl(c.text).stopped) this.control.write(applyControl(c.text, { stop: false }), c.version);
        this.say(run, 'every run has ended — the `end` line is out of the control file again');
      }
      S.restoredAt = this.now();
      S.step = 'clean';
      this.save(run);
    }
    if (S.step === 'clean') {
      if (run.cleanAfter) {
        const byId = this.byId();
        let pending = 0;
        for (const id of ids) {
          if (S.clean[id] && S.clean[id].done) continue;
          const lbl = run.labels[id] || id;
          const a = byId.get(id);
          const entry = S.clean[id] || (S.clean[id] = { since: this.now() });
          if (this.now() - entry.since > Math.max(CLEAN_WAIT_MAX, this.gateMs() + 5 * 60000)) { entry.done = true; entry.ok = false; this.say(run, `clean after: ${lbl} gave up waiting (${entry.why || 'gate'}) — clean it by hand`); continue; }
          if (a && !a.connected && !a.processDown) { pending++; if (entry.why !== 'login') { entry.why = 'login'; this.say(run, `clean after: ${lbl} is not logged in — waiting for it`); } continue; }
          const until = this.gateUntil(id);
          if (until > this.now()) { pending++; if (entry.why !== until) { entry.why = until; this.say(run, `clean after: ${lbl} waits for its restart gate until ${hhmm(until)}`); } continue; }
          this.clearGate(id);
          const r = await this.exec(['start', '--buy', id, '--buy-script', SCRIPT.clean]);
          entry.done = true; entry.at = this.now(); entry.ok = r.ok && /console up, pid \d+/.test(r.out || '');
          this.say(run, `clean after: ${lbl} ${entry.ok ? `restarted onto ${SCRIPT.clean} — its first city cleans the reports (the count shows under Trading results)` : 'FAILED — ' + String(r.out || r.error || '').trim().slice(-200)}`);
          this.save(run);
        }
        if (pending) { this.save(run); return; }
      }
      run.state = 'stopped';
      run.stoppedAt = this.now();
      S.step = 'done';
      this.say(run, 'the play is stopped');
      this.save(run);
    }
  }

  // After a Director restart: a run that was mid-start is not resumed by itself (it would
  // start sellers nobody is watching); running and stopping carry on.
  resume() {
    const run = this.run();
    if (run && run.state === 'starting') {
      run.state = 'interrupted';
      this.say(run, `the Director restarted during the start (phase ${run.phase}) — started so far: ${Object.keys(run.started).map((id) => run.labels[id] || id).join(', ') || 'none'}. Press Start again, or Stop.`);
      this.save(run);
    }
    return run;
  }
}

function describe(ch) {
  return Object.entries(ch).filter(([, v]) => v !== undefined).map(([k, v]) => (k === 'caps' ? 'caps ' + Object.entries(v).map(([r, x]) => `${r} ${fmtAmount(typeof x === 'number' ? x : parseAmount(x))}`).join('/')
    : k === 'holi' ? `holi ${v.join(', ')}` : `${k} ${typeof v === 'number' && v >= 1e6 ? fmtAmount(v) : v}`)).join(' · ');
}
const hhmm = (t) => new Date(t).toTimeString().slice(0, 8);

module.exports = {
  RES, FOOD_HARD, GATE_MS, GATE_PAD, SETUP_KEY, RUN_KEY, GATE_KEY, SCRIPT, RUNGS, LIVE_FRESH,
  parseAmount, fmtAmount, priceText, parseControl, applyControl, versionOf, writeAtomic, controlFile,
  lastScriptLineAt, checkPlay, cleanSetup, cleanLadder, playChange, partialChange, Runner,
};
