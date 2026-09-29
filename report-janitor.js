'use strict';
// KEEP THE TRADE REPORTS DOWN WHILE THE PLAY RUNS.
//
// The user, 2026-09-29: "can you run the cleanreports in parallel with trading? so the reports
// never pile up? that would be awesome!"
//
// WHY. Trade reports halve an account's market order rate as they accumulate - verified with a
// control on 2026-09-28 (cleaned banks went from ~60 to ~110 batches a minute while an
// untouched control kept sagging), and watched live on 2026-09-29, where one bank fell
// 401 -> 174 -> 136 -> 112 -> 91 batches a minute over 40 minutes while its RETURN held at
// 88-97%. Volume decays; capture does not. Cleaning at each switch is too late: a long pass is
// exactly where the reports pile up.
//
// HOW. Every INTERVAL minutes, each account hands ONE of its cities to a clean and gets it
// straight back: the city runs `cleanreports trade` and then falls through to the trading
// script, so it rejoins the play by itself. The city is rotated, so no single city carries the
// cost, and an account is never fully out of the play - its other nine cities keep trading
// throughout.
//
// SAFETY. `cleanreports trade` ONLY. Army and other reports silence the whole account for a
// couple of minutes (EVONY-RULES §7), which is fine between passes and not fine during one.
// The side is read from the Director's live run, so this follows the play when it flips
// between a gold pass (banks buy) and a resource pass (banks sell).
//
//   node report-janitor.js [intervalMinutes]     default 12
const http = require('http');
const fs = require('fs');
const path = require('path');
const M = require('./otto-mcp.js');
const D = require('./db');
const A = require('./auth');

const mcp = (n, a) => M.TOOLS.find((x) => x.name === n).fn(a);
const org = D.all('SELECT id FROM orgs LIMIT 1')[0];
const usr = D.all('SELECT id FROM users LIMIT 1')[0];
const ses = A.newSession(usr.id, org.id, '127.0.0.1', 'janitor');
const COOKIE = 'otto_sid=' + (typeof ses === 'string' ? ses : (ses.id || ses.sid));

const INTERVAL_MIN = Number(process.argv[2] || 12);
const DIR = path.join(__dirname, 'scripts');
const stamp = () => new Date().toTimeString().slice(0, 8);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The scripts the janitor hands a city: clean, then rejoin the play. No `canceltrade` - unlike
// clean-then-*.txt this keeps the city's resting orders, because a cancelled order's 0.5% fee
// is NOT refunded and this runs every few minutes.
function ensureScripts() {
  for (const side of ['buy', 'sell']) {
    const p = path.join(DIR, `clean-inline-${side}.txt`);
    fs.writeFileSync(p, [
      `// Written by report-janitor.js. Clean this city's trade reports, then rejoin the play.`,
      `// Trade reports are safe to clear beside live trading; army and other are NOT (they`,
      `// silence the account for minutes) - so only \`trade\` here.`,
      'cleanreports trade',
      `call "glitch-res-${side}.txt"`,
    ].join('\n'));
  }
}

const get = (p) => new Promise((res, rej) => {
  const q = http.request({ host: '127.0.0.1', port: 8712, path: p, method: 'GET', timeout: 30000,
    headers: { Cookie: COOKIE } }, (r) => { let s = ''; r.on('data', (c) => s += c); r.on('end', () => { try { res(JSON.parse(s)); } catch { res({}); } }); });
  q.on('error', rej); q.on('timeout', () => { q.destroy(); rej(new Error('timeout')); }); q.end();
});

// Who is buying and who is selling RIGHT NOW, from the Director's run.
async function sidesNow() {
  const r = (await get('/api/trading/setup')).run;
  if (!r || !['starting', 'running'].includes(r.state)) return null;
  return { buy: r.buy || [], sell: r.sell || [], res: r.res, price: r.price };
}

const turn = {};                       // account -> which city index to hand over next

(async () => {
  ensureScripts();
  console.log(stamp() + '  janitor up: one city per account every ' + INTERVAL_MIN + ' min, `cleanreports trade` then straight back into the play');
  for (;;) {
    let sides = null;
    try { sides = await sidesNow(); } catch { /* Director busy */ }
    if (!sides) {
      console.log(stamp() + '  no play running - idling');
      await wait(INTERVAL_MIN * 60000);
      continue;
    }
    const jobs = [
      ...sides.buy.map((a) => [a, 'buy']),
      ...sides.sell.map((a) => [a, 'sell']),
    ];
    let done = 0, skipped = 0;
    await Promise.all(jobs.map(async ([acct, side]) => {
      let cities = [];
      try {
        const s = String(await mcp('state', { account: acct }));
        cities = [...s.matchAll(/^  \S.*?\((\d+)\) \d+,\d+ t/gm)].map((m) => m[1]);
      } catch { skipped++; return; }
      if (!cities.length) { skipped++; return; }
      const i = (turn[acct] = (turn[acct] || 0) % cities.length);
      turn[acct] = (i + 1) % cities.length;          // rotate, so no city carries it twice running
      const city = cities[i];
      const text = fs.readFileSync(path.join(DIR, `clean-inline-${side}.txt`), 'utf8');
      try { await mcp('script_stop', { account: acct, city }); } catch { /* idle */ }
      await wait(800);
      try {
        const r = String(await mcp('script', { account: acct, city, text }));
        if (/started/.test(r) && !/NOT started/.test(r)) done++; else skipped++;
      } catch { skipped++; }
    }));
    console.log(stamp() + '  ' + sides.res + ' @ ' + sides.price + ': cleaned a city on ' + done + ' account(s)'
      + (skipped ? ', ' + skipped + ' skipped' : ''));
    await wait(INTERVAL_MIN * 60000);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
