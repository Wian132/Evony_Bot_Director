'use strict';
// FRIENDLY FIRE: find — and recall — every march of ours that is attacking one of our own
// cities.
//
// WHY THIS EXISTS. Capturing an NPC city turns it into OUR city while other accounts' waves
// are still in the air at it, and drainers and takers sit in DIFFERENT alliances, so those
// waves land as real enemy attacks on a city we just paid for. On 2026-09-27 that left 37
// inbound marches on two new cities for six hours and the user spotted them, not the bot.
// On 2026-09-28 a stale ownership read had me restart ten grinder cities onto a city we
// already owned.
//
// Nothing else in the fleet answers "what are we attacking, and is it ours?" — the account
// view truncates its march list at 15 lines, and the per-city view only knows its own city.
// This reads /api/marches on every console, which gives mission, direction and target x,y.
//
//   node friendly-fire.js              list every outgoing attack aimed at a fleet city
//   node friendly-fire.js --recall     ...and recall them
//   node friendly-fire.js --all        list every outgoing attack, ours or not
const http = require('http');
const fs = require('fs');
const D = require('./db');
const A = require('./auth');

const org = D.all('SELECT id FROM orgs LIMIT 1')[0];
const user = D.all('SELECT id FROM users LIMIT 1')[0];
const ses = A.newSession(user.id, org.id, '127.0.0.1', 'friendly-fire');
const SID = 'otto_sid=' + (typeof ses === 'string' ? ses : (ses.id || ses.sid));

const accounts = D.all('SELECT id, label FROM accounts ORDER BY id');
const portOf = (id) => {
  try {
    const L = fs.readFileSync(__dirname + '/console-' + id + '.log', 'utf8');
    const m = [...L.matchAll(/port:\s*(\d+)/g)];
    return m.length ? m[m.length - 1][1] : null;
  } catch { return null; }
};
const get = (port, path) => new Promise((res) => {
  http.get({ host: 'localhost', port, path, headers: { Cookie: SID }, timeout: 20000 },
    (r) => { let s = ''; r.on('data', (d) => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch { res(null); } }); })
    .on('error', () => res(null)).on('timeout', () => res(null));
});
const post = (port, path, body) => new Promise((res) => {
  const d = JSON.stringify(body);
  const q = http.request({ host: 'localhost', port, path, method: 'POST',
    headers: { Cookie: SID, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) }, timeout: 60000 },
    (r) => { let s = ''; r.on('data', (c) => s += c); r.on('end', () => { try { res(JSON.parse(s)); } catch { res({ raw: s.slice(0, 120) }); } }); });
  q.on('error', (e) => res({ err: e.message })); q.write(d); q.end();
});

(async () => {
  const wantRecall = process.argv.includes('--recall');
  const showAll = process.argv.includes('--all');

  // 1. every tile the fleet owns, across every account
  const ours = new Map();                       // "x,y" -> account label
  const live = [];
  for (const a of accounts) {
    const port = portOf(a.id);
    if (!port) continue;
    const s = await get(port, '/api/session');
    if (!s || !s.cities) continue;
    live.push({ id: a.id, port, lord: s.lord || a.label });
    for (const c of s.cities) ours.set(c.x + ',' + c.y, s.lord || a.label);
  }
  console.log(live.length + ' consoles up, ' + ours.size + ' fleet cities');

  // 2. every OUTGOING attack, and whether its target is one of those tiles
  const bad = [];
  for (const acc of live) {
    const m = await get(acc.port, '/api/marches');
    for (const x of ((m && m.outgoing) || [])) {
      if (String(x.mission || '').toLowerCase() !== 'attack') continue;
      if (String(x.direction || '') !== 'out') continue;      // "back" is already coming home
      const t = x.target || {};
      const key = t.x + ',' + t.y;
      const owner = ours.get(key);
      if (!owner && !showAll) continue;
      const mins = Math.round((Number(x.reachTime || 0) - Date.now()) / 60000);
      const row = { acct: acc.id, lord: acc.lord, port: acc.port, from: x.from, key, owner,
        hero: x.hero, troops: x.troopTotal, mins, armyId: x.armyId };
      if (owner) bad.push(row);
      console.log('  ' + (owner ? 'FRIENDLY FIRE ' : 'attack        ')
        + acc.lord + ' ' + String(x.from).padEnd(5) + ' -> ' + key.padEnd(9)
        + (owner ? '(' + owner + '!) ' : '') + String(x.troopTotal || '?').padStart(7) + ' troops, lands in ' + mins + 'm');
    }
  }

  if (!bad.length) { console.log('\nno friendly fire: nothing of ours is attacking a fleet city'); return; }
  console.log('\n' + bad.length + ' march(es) are attacking our own cities');
  if (!wantRecall) { console.log('run again with --recall to call them back'); return; }

  // 3. recall, one script per account, `recall x,y all` so every city of it is covered
  const byAcct = {};
  for (const b of bad) (byAcct[b.acct] = byAcct[b.acct] || { port: b.port, lord: b.lord, tiles: new Set() }).tiles.add(b.key);
  for (const id of Object.keys(byAcct)) {
    const g = byAcct[id];
    const s = await get(g.port, '/api/session');
    const first = ((s && s.cities) || [])[0];
    if (!first) continue;
    // a city running a script refuses a new one, so stop every city of this account first
    for (const c of s.cities) await post(g.port, '/api/script/stop', { city: String(c.id) });
    await new Promise((r) => setTimeout(r, 1000));
    const lines = [];
    for (const t of g.tiles) { lines.push('recall ' + t + ' all'); lines.push('echo "RECALL ' + t + ' -> " + $result'); }
    const r = await post(g.port, '/api/script', { src: lines.join('\n'), castle: first.id, runId: 'ff-' + Date.now() });
    console.log(g.lord + ': recall at ' + [...g.tiles].join(' ') + ' -> ' + (r && r.ok ? 'running' : JSON.stringify(r).slice(0, 90)));
  }
  console.log('\nre-run without --recall in a minute to confirm it is clear');
})().catch((e) => { console.error(e); process.exit(1); });
