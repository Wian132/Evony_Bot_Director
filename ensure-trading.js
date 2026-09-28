'use strict';
// MAKE SURE EVERY TRADING ACCOUNT IS ACTUALLY TRADING.
//
// A console restart is NOT the same as a pass running. `glitch-run.js start` restarts the
// console and relies on autorun, and **autorun refuses to run twice inside ten minutes**:
//
//   autorun: not started — it already started 7 minute(s) ago (16:08:57), and it waits
//   10 minutes between starts, so a console that keeps restarting does not run it again
//
// The console then sits there logged in, healthy, `autorun: on`, running NOTHING. It has
// cost a live pass three times on 2026-09-28 alone — once leaving all five banks idle while
// our side bid into an empty book, once leaving all 24 of our accounts idle, once at the
// wood switch. The Director shows "up"; only `scripts 0` gives it away.
//
// This checks every account and dispatches the script straight to each city of the ones that
// are idle, which needs no autorun and no restart.
//
//   node ensure-trading.js                     report only
//   node ensure-trading.js --fix               start the idle ones
//   node ensure-trading.js --fix --all         re-dispatch to every account, idle or not
const http = require('http');
const fs = require('fs');
const M = require('./otto-mcp.js');
const A = require('./auth');

const TOK = A.internalToken();
const call = (n, args) => M.TOOLS.find((x) => x.name === n).fn(args);

// who is on which side of the play right now
const BANKS = ['a2', 'a3', 'a17', 'a20', 'a21'];
const OURS = ['a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12', 'a13', 'a14', 'a15',
  'a16', 'a18', 'a19', 'a23', 'a24', 'a25', 'a26', 'a27', 'a28', 'a29', 'a30', 'a31'];

// A resource pass: the banks SELL cheap, we BUY. Swap these two for a gold pass.
const SELL_SCRIPT = __dirname + '/scripts/clean-then-sell.txt';
const BUY_SCRIPT = __dirname + '/scripts/cancel-clean-then-buy.txt';

const portOf = (id) => {
  try {
    const L = fs.readFileSync(__dirname + '/console-' + id + '.log', 'utf8');
    const m = [...L.matchAll(/port:\s*(\d+)/g)];
    return m.length ? m[m.length - 1][1] : null;
  } catch { return null; }
};
const get = (port, path) => new Promise((res) => {
  if (!port) return res(null);
  const q = http.get({ host: 'localhost', port, path, timeout: 15000, headers: { 'x-otto-internal': TOK } },
    (r) => { let s = ''; r.on('data', (d) => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch { res(null); } }); });
  q.on('error', () => res(null));
  q.on('timeout', () => { q.destroy(); res(null); });
});

(async () => {
  const fix = process.argv.includes('--fix');
  const all = process.argv.includes('--all');
  const sell = fs.readFileSync(SELL_SCRIPT, 'utf8');
  const buy = fs.readFileSync(BUY_SCRIPT, 'utf8');

  const idle = [];
  for (const id of [...BANKS, ...OURS]) {
    const port = portOf(id);
    const s = await get(port, '/api/session');
    if (!s || !s.cities) { console.log(id.padEnd(5) + 'not connected'); continue; }
    let running = 0;
    try {
      const runs = String(await call('script_runs', { account: id }));
      const m = /(\d+) running/.exec(runs);
      running = m ? Number(m[1]) : 0;
    } catch { /* treat as idle */ }
    const want = BANKS.includes(id) ? 'sell' : 'buy';
    console.log(id.padEnd(5) + String(s.lord || '').padEnd(13) + s.cities.length + ' cities · '
      + running + ' running' + (running ? '' : '   <- IDLE'));
    if (!running || all) idle.push({ id, port, cities: s.cities, want });
  }

  if (!idle.length) { console.log('\nevery account is trading'); return; }
  console.log('\n' + idle.length + ' account(s) not trading');
  if (!fix) { console.log('run again with --fix to start them'); return; }

  let started = 0, refused = 0;
  for (const a of idle) {
    const text = a.want === 'sell' ? sell : buy;
    let n = 0;
    for (const c of a.cities) {
      try { await call('script_stop', { account: a.id, city: String(c.id) }); } catch { /* idle */ }
      await new Promise((r) => setTimeout(r, 250));
      try {
        const r = String(await call('script', { account: a.id, city: String(c.id), text }));
        if (/started/.test(r) && !/NOT started/.test(r)) { n++; started++; } else refused++;
      } catch { refused++; }
    }
    console.log('  ' + a.id + ' (' + a.want + '): ' + n + '/' + a.cities.length + ' cities started');
  }
  console.log('\n' + started + ' cities started, ' + refused + ' refused');
})().catch((e) => { console.error(e); process.exit(1); });
