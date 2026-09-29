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
      // A `state` call on an account trading flat out often times out, and an account skipped
      // here keeps its reports and stays slow: on 2026-09-29 a3 was skipped once and sat at
      // ~70 batches a minute while a8 and a18, cleaned in the same round, ran at ~300. So
      // retry rather than shrug.
      let cities = [];
      for (let t = 0; t < 3 && !cities.length; t++) {
        if (t) await wait(4000);
        try {
          const s = String(await mcp('state', { account: acct }));
          cities = [...s.matchAll(/^  \S.*?\((\d+)\) \d+,\d+ t/gm)].map((m) => m[1]);
        } catch { /* busy - try again */ }
      }
      if (!cities.length) { skipped++; return; }
      // NEVER TOUCH A CITY RUNNING A HAND-STARTED SCRIPT. script_runs marks a run either
      // "(autorun <file>)" — the play, ours to manage — or "(console)", which is the user or
      // another session working in that city. On 2026-09-29 the user had four of Lord13's
      // cities running a 100-round `transport … s:*` into Lord26's new towns; handing one of
      // those to a clean would have killed the run and it would have looked like it simply
      // stopped. The play's own cities are plentiful, so skipping a busy one costs nothing.
      let manual = new Set();
      try {
        const runs = String(await mcp('script_runs', { account: acct }));
        for (const line of runs.split('\n')) {
          const m = /^\s*(\d+)\s+\S+\s+since\b.*\(console\)/.exec(line);
          if (m) manual.add(m[1]);
        }
      } catch { /* if we cannot tell, fall through and pick by rotation */ }
      const free = cities.filter((c) => !manual.has(c));
      if (!free.length) { skipped++; return; }        // every city is busy by hand - leave it
      const i = (turn[acct] = (turn[acct] || 0) % free.length);
      turn[acct] = (i + 1) % free.length;            // rotate, so no city carries it twice running
      const city = free[i];
      const text = fs.readFileSync(path.join(DIR, `clean-inline-${side}.txt`), 'utf8');
      let ok = false;
      for (let t = 0; t < 3 && !ok; t++) {
        try { await mcp('script_stop', { account: acct, city }); } catch { /* idle */ }
        await wait(900 + t * 1200);                  // a stop needs a moment before the start
        try {
          const r = String(await mcp('script', { account: acct, city, text }));
          ok = /started/.test(r) && !/NOT started/.test(r);
        } catch { /* busy - try again */ }
      }
      if (ok) done++; else skipped++;
    }));
    console.log(stamp() + '  ' + sides.res + ' @ ' + sides.price + ': cleaned a city on ' + done + ' account(s)'
      + (skipped ? ', ' + skipped + ' skipped' : ''));
    await wait(INTERVAL_MIN * 60000);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
