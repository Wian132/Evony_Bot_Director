// What the holiday banks REALLY hold, after a fresh login.
//
// The user, 2026-09-26: "ensure youre not using old values for the holiday accounts, when
// you check in every 30min you can do a restart on the holidayed accounts to check how much
// is left actually coz the cached values are often wrong."
//
// They are right, and it is measured: at 16:20 Lord08's snapshot said 2,506b of iron and it
// was sitting there apparently stalled; three minutes later, the same account read 7b. Its
// orders had been filling the whole time. A busy account's cached figures lag the server
// badly (EVONY-RULES §4), and Lord08 is the busiest in the fleet.
//
// This reconnects each bank — a fresh login re-seeds the client's city data — waits for the
// Director to poll it, then prints what they hold. A reconnect is lighter than a console
// restart: the console process and its autorun script stay up, so there is no 10-minute
// autorun gate and no lost trading.
//
//   node bank-truth.js            reconnect, wait, print
//   node bank-truth.js --no-relog just print what is on record

const http = require('http');
const fs = require('fs');
const D = require('C:/EvonyTool/db');

// the banks by account id; their names come from the accounts table, never from the repo
const BANK_IDS = ['a4', 'a5', 'a8', 'a9', 'a11', 'a13', 'a14', 'a15', 'a16'];
const BANKS = Object.fromEntries(BANK_IDS.map((id) => [id, (D.all('SELECT label FROM accounts WHERE id = ?', id)[0] || {}).label || id]));
const RES = ['food', 'wood', 'stone', 'iron', 'gold'];
const T = 1e12;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sid() {
  const A = require('C:/EvonyTool/auth');
  const org = D.all('SELECT id FROM orgs LIMIT 1')[0];
  const u = D.all('SELECT id FROM users LIMIT 1')[0];
  const s = A.newSession(u.id, org.id, '127.0.0.1', 'bank-truth');
  return typeof s === 'string' ? s : (s.id || s.sid);
}

// the port a console is really on, from its own log header (ports move on every restart)
function portOf(id) {
  try {
    const log = fs.readFileSync('C:/EvonyTool/console-' + id + '.log', 'utf8');
    const m = [...log.matchAll(/port:\s*(\d+)/g)];
    return m.length ? m[m.length - 1][1] : null;
  } catch { return null; }
}

const post = (port, path, cookie) => new Promise((resolve) => {
  const req = http.request({ host: 'localhost', port, path, method: 'POST', headers: { Cookie: 'otto_sid=' + cookie, 'Content-Length': 2 }, timeout: 45000 },
    (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', () => resolve(0));
  req.on('timeout', () => { req.destroy(); resolve(0); });
  req.write('{}');
  req.end();
});

(async () => {
  const cookie = sid();
  const relog = !process.argv.includes('--no-relog');

  if (relog) {
    const at = Date.now();
    for (const id of Object.keys(BANKS)) {
      const p = portOf(id);
      if (p) await post(p, '/api/reconnect', cookie);
    }
    // wait for each bank's snapshot to be newer than the relog, so the numbers below are
    // from AFTER the fresh login and not the stale cache we were trying to escape
    for (let i = 0; i < 30; i++) {
      const stale = Object.keys(BANKS).filter((id) => {
        const r = D.all('SELECT at FROM account_latest WHERE accountId = ?', id)[0];
        return !r || r.at < at;
      });
      if (!stale.length) break;
      await sleep(10000);
    }
  }

  const tot = Object.fromEntries(RES.map((k) => [k, 0]));
  console.log(new Date().toLocaleTimeString() + (relog ? '  (after a fresh login)' : '  (from the cache)'));
  console.log('  bank           food     wood    stone     iron     gold      age');
  for (const [id, lbl] of Object.entries(BANKS)) {
    const r = D.all('SELECT json,at FROM account_latest WHERE accountId = ?', id)[0];
    if (!r) { console.log('  ' + lbl.padEnd(13) + ' no snapshot'); continue; }
    const t = JSON.parse(r.json).totals;
    if (!t) { console.log('  ' + lbl.padEnd(13) + ' no totals (a failed poll)'); continue; }
    for (const k of RES) tot[k] += t[k] || 0;
    console.log('  ' + lbl.padEnd(13) + RES.map((k) => (t[k] / T).toFixed(2).padStart(8)).join(' ')
      + '   ' + Math.round((Date.now() - r.at) / 1000) + 's');
  }
  console.log('  ' + 'TOTAL'.padEnd(13) + RES.map((k) => (tot[k] / T).toFixed(2).padStart(8)).join(' '));
})();
