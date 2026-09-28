'use strict';
// TOP EVERY CITY UP TO 1b STONE from the gambling chests, then report what is left.
//
// The user, 2026-09-28: "theres an item that gives 100m stone, I want you to use that item a
// few times in each city (like 10 times per city if the account has enough of them) so each
// town has 1b stone ... so these new accounts can sell all their stone".
//
// The item is `player.box.gambling.stone.10000000`. Its id says 10,000,000 but it gives
// **100,000,000** — measured 2026-09-28: a28's 700,128 went 5.0m -> 105.0m on one box, and
// the held count fell 101 -> 99 over two uses. The resource lands in the city the script
// runs in, so it must be spent city by city.
//
// The gain is NOT visible immediately: a `state` read right after the use still showed the
// old figure. Re-read after a few seconds before concluding anything failed.
//
//   node stone-topup.js            what each city needs, spend nothing
//   node stone-topup.js --go       actually use the boxes
const http = require('http');
const fs = require('fs');
const M = require('./otto-mcp.js');
const A = require('./auth');

const TOK = A.internalToken();
// /api/items (like /api/chat) REFUSES the internal token and answers
// {ok:false,error:'not signed in'} — which parses fine and silently reads as zero items held.
// So these reads use a real Director session cookie.
const D = require('./db');
const _org = D.all('SELECT id FROM orgs LIMIT 1')[0];
const _usr = D.all('SELECT id FROM users LIMIT 1')[0];
const _s = A.newSession(_usr.id, _org.id, '127.0.0.1', 'stone-topup');
const COOKIE = 'otto_sid=' + (typeof _s === 'string' ? _s : (_s.id || _s.sid));
const call = (n, args) => M.TOOLS.find((x) => x.name === n).fn(args);

const ACCOUNTS = ['a26', 'a27', 'a28', 'a29', 'a30', 'a31'];
const ITEM = 'player.box.gambling.stone.10000000';
const PER_BOX = 100e6;
const WANT = 1e9;

const U = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
const num = (s) => { const m = /^([0-9.]+)([kmbt]?)$/.exec(s); return m ? parseFloat(m[1]) * (U[m[2]] || 1) : 0; };
const B = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'b' : (n / 1e6).toFixed(0) + 'm');

const portOf = (id) => {
  const L = fs.readFileSync(__dirname + '/console-' + id + '.log', 'utf8');
  const m = [...L.matchAll(/port:\s*(\d+)/g)];
  return m.length ? m[m.length - 1][1] : null;
};
const get = (port, path) => new Promise((res) => {
  http.get({ host: 'localhost', port, path, headers: { 'x-otto-internal': TOK, Cookie: COOKIE }, timeout: 25000 },
    (r) => { let s = ''; r.on('data', (d) => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch { res(null); } }); })
    .on('error', () => res(null)).on('timeout', () => res(null));
});

// A city's stone, from the PER-CITY state read. The account-level city listing both lags and
// truncates, so the city list itself comes from /api/session (EVONY-RULES: that is the
// authority for what an account owns).
async function stoneOf(acct, city) {
  const s = String(await call('state', { account: acct, city })).split('\n');
  const m = /stone ([0-9.]+[kmbt]?)/.exec(s.find((l) => /^res:/.test(l)) || '');
  return m ? num(m[1]) : null;
}

(async () => {
  const go = process.argv.includes('--go');
  let totalBoxes = 0;
  const plan = [];

  for (const a of ACCOUNTS) {
    const port = portOf(a);
    if (!port) { console.log(a + ': no console'); continue; }
    const s = await get(port, '/api/session');
    const items = await get(port, '/api/items');
    const box = ((items && items.items) || []).find((i) => i.id === ITEM);
    let held = box ? Number(box.count || box.num || box.held || 0) : 0;
    const rows = [];
    for (const c of ((s && s.cities) || [])) {
      const have = await stoneOf(a, String(c.id));
      if (have === null) continue;
      let need = Math.max(0, Math.ceil((WANT - have) / PER_BOX));
      rows.push({ id: String(c.id), name: c.name, xy: c.x + ',' + c.y, have, need });
    }
    const wanted = rows.reduce((n, r) => n + r.need, 0);
    console.log(a + ' ' + String((s && s.lord) || '').padEnd(12) + rows.length + ' cities · holds ' + held
      + ' boxes · needs ' + wanted + (wanted > held ? '  *** SHORT ' + (wanted - held) + ' ***' : ''));
    for (const r of rows) if (r.need) console.log('     ' + r.xy.padEnd(9) + B(r.have).padStart(7) + ' -> ' + r.need + ' boxes');
    totalBoxes += Math.min(wanted, held);
    plan.push({ acct: a, port, held, rows });
  }
  console.log('\ntotal boxes to spend: ' + totalBoxes);
  if (!go) { console.log('run again with --go to spend them'); return; }

  for (const p of plan) {
    let left = p.held;
    for (const r of p.rows) {
      if (!r.need) continue;
      const n = Math.min(r.need, left);
      if (n <= 0) { console.log('  ' + p.acct + ' ' + r.xy + ': out of boxes'); continue; }
      try { await call('script_stop', { account: p.acct, city: r.id }); } catch { /* idle */ }
      await new Promise((x) => setTimeout(x, 300));
      const out = String(await call('script', { account: p.acct, city: r.id,
        text: `useitem /count=${n} ${ITEM}` }));
      const ok = /started/.test(out) && !/NOT started/.test(out);
      if (ok) left -= n;
      console.log('  ' + p.acct + ' ' + r.xy.padEnd(9) + n + ' boxes ' + (ok ? 'sent' : 'REFUSED ' + out.slice(0, 80)));
      await new Promise((x) => setTimeout(x, 700));
    }
  }
  console.log('\nboxes spent; re-run without --go in a minute to confirm every city is at 1b');
})().catch((e) => { console.error(e); process.exit(1); });
