'use strict';
// The market glitch, from the command line (see EVONY-RULES.md §4 and the evony-glitch
// skill). Three things every run needs:
//
//   node glitch-run.js start --buy a4,a5,a8,a9 --buy-script glitch-res-buy.txt
//                            --sell a6,a7,a3 --sell-script glitch-res-sell.txt
//       Restarts each listed account's console with that script on autorun
//       (AUTOSCRIPTS=1 RUNSCRIPT=<file>), the BUY side first so its bids are on the book
//       before the selling starts, a moment apart (two consoles started in one breath
//       once locked the database). Every city of the account runs the script after login.
//       A restart kills whatever that console was running.
//   node glitch-run.js snap "<label>" [--reset]
//       Records gold and each resource of every account from the Director's snapshots
//       (a few minutes old; a busy holiday account's can be stale) and prints the change
//       since the first snapshot of the series. --reset starts a new series.
//   node glitch-run.js flow [hh:mm:ss]
//       Orders placed per account since that time (default: two minutes ago), from the
//       consoles' stamped logs — the live picture between snapshots.
//   node glitch-run.js ledger --holiday a3,a6,a7 --ours a4,a5,a8,a9
//                             [--from 08:30] [--to 23:59] [--bucket 5] [--record "note"]
//       The RETURN per time bucket, from the logs: of the orders the holiday side placed,
//       the share our side matched (their opposite orders of the same resource). The
//       holiday side buying = a gold glitch, selling = a resource glitch. --record appends
//       the rows to glitch-ledger.csv (a bucket already there is not added twice) — the
//       long record for finding patterns in how the other traders behave. See
//       GLITCH-LEDGER.md.
//
// It never logs in to the game itself: consoles do, each through its own proxy.
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { execSync } = require('child_process');

const SERIES = path.join(os.tmpdir(), 'otto-glitch-snaps.json');
const RES = ['food', 'wood', 'stone', 'iron'];

function args() {
  const a = process.argv.slice(2), out = { _: [] };
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) { const k = a[i].slice(2); const v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true; out[k] = v; } else out._.push(a[i]);
  }
  return out;
}
function orgs() {
  const D = require('./db');
  require('./auth').configure();
  return D.orgs.all().map((o) => D.org(o.id));
}
const orgOf = (id) => orgs().find((o) => o.accounts.get(id)) || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portFree = (port) => new Promise((res) => {
  const s = net.connect(port, '127.0.0.1');
  s.on('connect', () => { s.destroy(); res(false); });
  s.on('error', () => res(true));
  setTimeout(() => { s.destroy(); res(true); }, 1500);
});
function pidOn(port) {
  for (const l of execSync('netstat -ano -p TCP').toString().split(/\r?\n/)) {
    const m = l.match(/^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (m && Number(m[1]) === port) return Number(m[2]);
  }
  return 0;
}

async function start(o) {
  const BC = require('./botctl');
  const side = (ids, file) => String(ids || '').split(',').filter(Boolean).map((id) => [id.trim(), file]);
  const plan = [...side(o.buy, o['buy-script']), ...side(o.sell, o['sell-script'])];
  if (!plan.length) throw new Error('say which accounts: --buy a4,a5 --buy-script <file> --sell a6 --sell-script <file>');
  for (const [, file] of plan) {
    if (!file) throw new Error('each side needs its script: --buy-script / --sell-script');
    if (!fs.existsSync(path.join(__dirname, 'scripts', file))) throw new Error(`there is no scripts/${file}`);
  }
  for (const [id, file] of plan) {
    const org = orgOf(id);
    const acc = org && org.accounts.get(id);
    if (!acc) { console.log(`${id}: no such account — skipped`); continue; }
    if (acc.enabled === false) { console.log(`${acc.label}: switched OFF in the Director — skipped (switching it on is the user's call)`); continue; }
    const rec = (BC.bots(org) || {})[id] || {};
    const port = rec.port || null;
    if (!port) { console.log(`${acc.label}: no console on record — start it once with botctl first`); continue; }
    for (const k of ['OTTO_MAINT_SCOUT', 'OTTO_MAINT_MONITOR', 'OTTO_MAINT_FOLLOW', 'OTTO_PROBE_AT_START', 'OTTO_PROBE']) delete process.env[k];
    process.env.AUTOSCRIPTS = '1';
    process.env.RUNSCRIPT = file;
    const pid = pidOn(port);
    if (pid) { try { process.kill(pid); } catch { /* gone already */ } }
    for (let i = 0; i < 20 && !(await portFree(port)); i++) await sleep(250);
    const r = await BC.start(org, acc, { port, note: () => {} });
    console.log(`${new Date().toTimeString().slice(0, 8)} ${acc.label.padEnd(12)} ${file.padEnd(22)} ${r.ok ? 'console up, pid ' + r.pid : 'FAILED ' + r.error}`);
    await sleep(1500);
  }
  console.log('each city starts its script once the console is logged in — watch it with: node glitch-run.js flow');
}

function snap(o) {
  const label = o._[1] || new Date().toTimeString().slice(0, 8);
  const all = !o.reset && fs.existsSync(SERIES) ? JSON.parse(fs.readFileSync(SERIES, 'utf8')) : [];
  const cur = { label, at: Date.now(), acc: {} };
  for (const org of orgs()) {
    for (const a of org.accounts.all()) {
      const s = org.snapshots.latest(a.id);
      if (!s || !s.totals) continue;
      cur.acc[a.id] = { label: a.label, at: s.at, gold: s.totals.gold, ...Object.fromEntries(RES.map((r) => [r, s.totals[r]])) };
    }
  }
  all.push(cur);
  fs.writeFileSync(SERIES, JSON.stringify(all, null, 1));
  const first = all[0];
  const t = (x) => (x / 1e12).toFixed(3) + 't';
  const d = (x) => `${x >= 0 ? '+' : ''}${(x / 1e9).toFixed(1)}b`;
  console.log(`${label} (${all.length} in this series, first: ${first.label})`);
  for (const [id, a] of Object.entries(cur.acc)) {
    const b = first.acc[id] || a;
    const moved = ['gold', ...RES].filter((k) => Math.abs(a[k] - b[k]) >= 1e9).map((k) => `${k} ${d(a[k] - b[k])}`).join(', ');
    console.log(`  ${String(a.label).padEnd(12)} gold ${t(a.gold)}  stone ${t(a.stone)}  wood ${t(a.wood)}  food ${t(a.food)}  iron ${t(a.iron)}  ${moved ? '· since first: ' + moved : ''}  (snapshot ${new Date(a.at).toTimeString().slice(0, 8)})`);
  }
}

function flow(o) {
  const since = o._[1] || new Date(Date.now() - 120000).toTimeString().slice(0, 8);
  for (const org of orgs()) {
    for (const a of org.accounts.all()) {
      const f = path.join(__dirname, `console-${a.id}.log`);
      if (!fs.existsSync(f)) continue;
      let placed = 0, sent = 0, full = 0;
      const why = new Map(), cities = new Set();
      for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
        const tm = /\] (\d\d:\d\d:\d\d)\.\d{3} /.exec(l);
        if (!tm || tm[1] < since) continue;
        const c = /^\[autorun ([^\]]+)\]/.exec(l);
        if (c) cities.add(c[1]);
        const m = /(\d+) × (?:sell|buy) .*— (\d+) of (\d+) placed/.exec(l);
        if (m) { placed += +m[2]; sent += +m[3]; continue; }
        if (/(?:sell|buy) [\d,]+ \w+ @ [\d.]+ from .* — placed/.test(l)) { placed++; sent++; continue; }
        const n = /none placed: (.*?);/.exec(l);
        if (n) why.set(n[1].slice(0, 60), (why.get(n[1].slice(0, 60)) || 0) + 1);
        if (/: sleep 0\.3$/.test(l)) full++;
      }
      if (!sent && !full && !why.size) continue;
      console.log(`${String(a.label).padEnd(12)} placed ${String(placed).padStart(5)} of ${String(sent).padStart(5)} · ${cities.size} cities running · ${full} waits on a full city`
        + (why.size ? ` · refused: ${[...why].map(([k, v]) => `${v}× ${k}`).join(' | ')}` : ''));
    }
  }
  console.log(`since ${since}`);
}

// One order line of a console log -> { t: 'hh:mm:ss', side, res, price, placed } | null.
// Batches read "10 × sell 99,999,999 stone @ 150 from X · … — 7 of 10 placed"; single
// orders "sell 99,999,999 stone @ 100 from X · … — placed".
function orderLine(l) {
  const t = /\] (\d\d:\d\d:\d\d)\.\d{3} line \d+: /.exec(l);
  if (!t) return null;
  let m = /· (\d+) × (buy|sell) [\d,]+ (\w+) @ ([\d.]+) from .*— (\d+) of \d+ placed/.exec(l);
  if (m) return { t: t[1], side: m[2], res: m[3], price: Number(m[4]), placed: Number(m[5]) };
  m = /· (buy|sell) [\d,]+ (\w+) @ ([\d.]+) from .*— placed/.exec(l);
  if (m) return { t: t[1], side: m[1], res: m[2], price: Number(m[3]), placed: 1 };
  return null;
}
const secs = (hms) => { const [h, m, s] = hms.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };
const hms = (x) => [Math.floor(x / 3600), Math.floor(x / 60) % 60, x % 60].map((v) => String(v).padStart(2, '0')).join(':');

const LEDGER = path.join(__dirname, 'glitch-ledger.csv');
const COLS = ['date', 'weekday', 'from', 'to', 'play', 'resource', 'holiday_price', 'our_price', 'holiday_orders', 'our_orders',
  'return_pct', 'min_after_maint', 'note'];

function ledger(o) {
  const ids = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  const hol = ids(o.holiday), ours = ids(o.ours);
  if (!hol.length || !ours.length) throw new Error('say which accounts: --holiday a3,a6,a7 --ours a4,a5,a8,a9');
  const from = secs(o.from || '00:00:00'.slice(0, 8)), to = secs(o.to || '23:59:59');
  const size = Math.max(1, Number(o.bucket) || 5) * 60;
  const b = new Map();                        // bucket start -> { hol: {side,res,price,n}, ours }
  const add = (who, e) => {
    const s = secs(e.t);
    if (s < from || s >= to) return;
    const k = Math.floor(s / size) * size;
    if (!b.has(k)) b.set(k, { hol: new Map(), ours: new Map() });
    const key = `${e.side}|${e.res}`;
    const cur = b.get(k)[who].get(key) || { side: e.side, res: e.res, n: 0, prices: new Set() };
    cur.n += e.placed; cur.prices.add(e.price);
    b.get(k)[who].set(key, cur);
  };
  for (const [who, list] of [['hol', hol], ['ours', ours]]) {
    for (const id of list) {
      const f = path.join(__dirname, `console-${id}.log`);
      if (!fs.existsSync(f)) continue;
      for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) { const e = orderLine(l); if (e) add(who, e); }
    }
  }
  // minutes after today's maintenance ended (the monitor's signal), negative before it
  let maintEnd = 0;
  try { for (const org of orgs()) maintEnd = Math.max(maintEnd, Number(org.settings.get('maintOver:ss71', 0)) || 0); } catch { /* none */ }
  const today = new Date();
  const date = today.toISOString().slice(0, 10), weekday = today.toLocaleDateString('en-GB', { weekday: 'short' });
  const endSec = maintEnd && new Date(maintEnd).toDateString() === today.toDateString()
    ? (new Date(maintEnd).getHours() * 3600 + new Date(maintEnd).getMinutes() * 60 + new Date(maintEnd).getSeconds()) : null;
  const rows = [];
  for (const k of [...b.keys()].sort((x, y) => x - y)) {
    const { hol: h, ours: u } = b.get(k);
    for (const e of h.values()) {
      const opp = u.get(`${e.side === 'buy' ? 'sell' : 'buy'}|${e.res}`);
      const n2 = opp ? opp.n : 0;
      rows.push({
        date, weekday, from: hms(k), to: hms(k + size),
        play: e.side === 'buy' ? `gold through ${e.res}` : `${e.res}`, resource: e.res,
        holiday_price: [...e.prices].join('/'), our_price: opp ? [...opp.prices].join('/') : '',
        holiday_orders: e.n, our_orders: n2, return_pct: e.n ? Math.round(100 * n2 / e.n) : '',
        min_after_maint: endSec === null ? '' : Math.round((k - endSec) / 60), note: o.record && o.record !== true ? o.record : '',
      });
    }
  }
  for (const r of rows) {
    console.log(`${r.from}-${r.to}  ${r.play.padEnd(20)} holiday @${String(r.holiday_price).padEnd(7)} ${String(r.holiday_orders).padStart(5)}  ours @${String(r.our_price).padEnd(7)} ${String(r.our_orders).padStart(5)}  return ${String(r.return_pct).padStart(3)}%  ${r.min_after_maint === '' ? '' : `(${r.min_after_maint >= 0 ? '+' : ''}${r.min_after_maint} min vs maintenance end)`}`);
  }
  if (o.record) {
    const have = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter(Boolean) : [COLS.join(',')];
    const seen = new Set(have.slice(1).map((l) => l.split(',').slice(0, 5).join(',')));
    const csv = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    let added = 0;
    for (const r of rows) {
      const key = [r.date, r.weekday, r.from, r.to, r.play].join(',');
      if (seen.has(key)) continue;
      have.push(COLS.map((c) => csv(r[c])).join(','));
      added++;
    }
    fs.writeFileSync(LEDGER, have.join('\n') + '\n');
    console.log(`${added} row(s) added to glitch-ledger.csv (${rows.length - added} already there)`);
  }
}

(async () => {
  const o = args();
  try {
    if (o._[0] === 'start') await start(o);
    else if (o._[0] === 'snap') snap(o);
    else if (o._[0] === 'flow') flow(o);
    else if (o._[0] === 'ledger') ledger(o);
    else console.log('usage: node glitch-run.js start --buy <ids> --buy-script <file> --sell <ids> --sell-script <file> | snap "<label>" [--reset] | flow [hh:mm:ss] | ledger --holiday <ids> --ours <ids> [--from hh:mm] [--to hh:mm] [--bucket min] [--record "note"]');
  } catch (e) { console.error('glitch-run: ' + e.message); process.exit(1); }
})();
