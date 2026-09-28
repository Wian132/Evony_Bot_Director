'use strict';
// NPC 10 CAPTURE DRIVER — 2026-09-28.
//
// Built after a run of failures on 2026-09-27/28 in which the machinery was rebuilt from
// scratch each time and each rebuild lost a different lesson. This file is the one place
// the method lives. The method is the user's:
//
//   1. KILL      3 big waves, a hero with attack > 500, cata 90k + 5k cavalry + 5k scouts.
//                A town has 8-9 heroes; wave 1 kills the troops. Lag makes waves stick, so
//                send three, not one.
//   2. LOYALTY   many scrappy waves, any hero under level 1800, to grind the abatis and the
//                loyalty down. `getspamhero` before each, because HEROES are the binding
//                constraint, not troops.
//   3. TAKE      the capturing account's own city attacks until the camp falls to it.
//
// FACTS THIS FILE ENCODES (each one cost a failed run):
//   - A march is capped at 10,000 x Rally Spot level = 100,000. 90k+5k+5k is exactly the cap.
//   - Waves per city = rally spot level, so ~10 in the air per city.
//   - Never a hero over level 1800 (the user's rule of thumb).
//   - A truce is ACCOUNT-WIDE: an account with `defensepolicy /usetruce:79` in its goals
//     cannot attack from ANY city (ok=-83). Capturers run the no-truce prepend.
//   - One city runs ONE script. A city that is busy REFUSES the new one, which on 2026-09-28
//     silently left 5 of 6 targets with no capturer. So: stop before every dispatch.
//   - One account per target. Two accounts taking one camp attack each other.
//   - Each capture must come from a DISTINCT city of the owning account.
//   - Draining is FREE (user, 2026-09-28: "you can overkill a city with 10000 extra waves").
//     A tile that reads as a Flat is one a city TELEPORTED OFF, not one we over-drained.
//     So there is no window to miss and no reason to hold takers back.
//   - RECALL ON CAPTURE. The moment a camp becomes ours, every wave still in the air at it
//     lands on our own city as a REAL enemy attack, because drainers and takers sit in
//     different alliances. On 2026-09-28 that left 37 friendly marches inbound and the user
//     found them, not the bot. The watcher below is the fix.
//
//   node npc-drive.js plan          print the assignment and send nothing
//   node npc-drive.js kill          phase 1: the killing waves
//   node npc-drive.js grind         phase 2: loyalty loops + capture loops
//   node npc-drive.js watch         phase 3: poll for captures, then stop + recall
//   node npc-drive.js status        where every target stands
//   node npc-drive.js stopall       stop every script this drive started, and recall
'use strict';
const fs = require('fs');
const M = require('./otto-mcp.js');
const D = require('./db');

const TOOL = (n) => M.TOOLS.find((x) => x.name === n);
const call = (n, args) => TOOL(n).fn(args);

const PLAN_FILE = __dirname + '/npc-drive-plan.json';

// ---------------------------------------------------------------------------- the fleet
const DRAINERS = ['a6', 'a7', 'a16'];
// How many cities each capturing account still has room for. The Director's Cities column
// minus 10. Accounts the USER is handling are simply absent.
const WANT = { a28: 4, a29: 3, a27: 2 };
// Tiles the user has taken for themselves - never target these.
const RESERVED = ['716,129', '694,130'];

const HUB = [704, 119];          // the fleet's cluster - captures are wanted near it
const MAX_DRAIN_MILES = 26;      // a drainer further out than this is not worth the march
// Cataphracts ONLY, at exactly the 100,000 march cap.
//
// The user's spec was cata:90000,c:5000,s:5000, and on 2026-09-28 the killer city for
// 706,127 sat for 18 minutes printing `not yet: 3,648 of 5,000 Cavalry at home — waiting`:
// an attack whose troop spec cannot be filled does NOT fail, it WAITS, and it holds the
// city's one script slot while it waits. The 5k cavalry and 5k scouts add nothing to a
// killing wave that is 90k cataphracts, so they are dropped rather than risk the stall.
const KILL_TROOPS = 'cata:100000';
const KILL_HERO = 'any:attack>500,level<1800';
// ONE troop type, so a wave can never stall waiting for a type the city is short of, and
// deliberately modest: a winning wave drops loyalty by 4 WHATEVER its size (Loyalty Trend:
// -4), so the number of waves is what matters, not their weight. The binding constraints are
// heroes and the 10 rally slots, not troops. The user, 2026-09-28: "you need to do 30-40
// waves atleast per npc10 before the capturers come through, more is better than less".
const LOYAL_TROOPS = 'cata:20000';
const LOYAL_HERO = 'any:level<1800';
// ARCHERS, not cavalry. The capturing accounts are young and hold ~180,000 archers and
// ~120,000 scouts per city but often under 1,000 LIGHT CAVALRY - so `c:1500,s:1500` ran the
// cavalry dry after a handful of waves and every capture loop then sat printing
// `not yet: 729 of 1,500 Cavalry at home - waiting`. On 2026-09-28 that left 717,117 sitting
// at ZERO loyalty with no wave able to convert it while its loyalty crept back up.
// a:5000,s:1000 is ~27 waves per city from stock every one of them has.
const TAKE_TROOPS = 'a:10000,s:10000';   // the user, 2026-09-28: "fast-ish and strong enough"
const TAKE_HERO = 'any:level<1800';

const euc = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);

// ---------------------------------------------------------------------------- reading the fleet
// state() gives a city's troops and its heroes' LEVEL and STATUS, but not their ATTACK -
// and attack is the one number the killing wave's filter selects on. So the roster comes
// from the console's debug endpoint instead. Note `roster=1` DROPS the troop object, so
// the two reads cannot be combined (EVONY-RULES.md).
const http = require('http');
const A = require('./auth');
const TOK = A.internalToken();
const portOf = (id) => {
  const L = fs.readFileSync(__dirname + '/console-' + id + '.log', 'utf8');
  const m = [...L.matchAll(/port:\s*(\d+)/g)];
  return m.length ? m[m.length - 1][1] : null;
};
const getJSON = (port, path) => new Promise((res) => {
  http.get({ host: 'localhost', port, path, headers: { 'x-otto-internal': TOK }, timeout: 25000 },
    (r) => { let s = ''; r.on('data', (d) => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch { res(null); } }); })
    .on('error', () => res(null)).on('timeout', () => res(null));
});

async function survey() {
  const drain = [], take = {};
  for (const id of DRAINERS) {
    const port = portOf(id);
    if (!port) continue;
    const s = await getJSON(port, '/api/session');
    if (!s) continue;
    for (const c of (s.cities || [])) {
      const q = await getJSON(port, '/api/debug/city?id=' + c.id);
      const r = await getJSON(port, '/api/debug/city?roster=1&id=' + c.id);
      const t = (q && q.castle && q.castle.troop) || {};
      const hs = (r && (r.heroes || r.roster)) || [];
      const idle = hs.filter((h) => Number(h.status || 0) === 0 && Number(h.level || 0) < 1800);
      drain.push({
        acct: id, lord: s.lord, id: String(c.id), name: c.name, xy: [c.x, c.y],
        cata: Number(t.heavyCavalry || 0), cav: Number(t.lightCavalry || 0), scout: Number(t.scouter || 0),
        idle: idle.length,
        big: idle.filter((h) => Number(h.att || h.attack || 0) > 500).length,
        bestAtt: idle.reduce((m, h) => Math.max(m, Number(h.att || h.attack || 0)), 0),
      });
    }
  }
  for (const id of Object.keys(WANT)) {
    const port = portOf(id);
    if (!port) continue;
    const s = await getJSON(port, '/api/session');
    if (!s) continue;
    const cities = [];
    for (const c of (s.cities || [])) {
      const q = await getJSON(port, '/api/debug/city?id=' + c.id);
      const t = (q && q.castle && q.castle.troop) || {};
      cities.push({ id: String(c.id), name: c.name, xy: [c.x, c.y],
        cav: Number(t.lightCavalry || 0), scout: Number(t.scouter || 0) });
    }
    take[id] = { acct: id, lord: s.lord, cities };
  }
  return { drain, take };
}

// ---------------------------------------------------------------------------- targets
function ourTiles() {
  const rows = D.all("SELECT x,y FROM map_cache WHERE mine=1 OR kind='player'");
  return new Set(rows.map((r) => r.x + ',' + r.y));
}
function npc10s() {
  return D.all('SELECT x,y FROM map_cache WHERE npc=1 AND level=10').map((r) => [r.x, r.y]);
}

// Choose targets by DRAIN COVERAGE first, not by how near a capturer sits.
//
// The first cut of this picked whatever NPC10 lay 1 mile from a capturer city, and two of
// the nine came out with no killing city within range at all - the drainers are clustered
// around 698-712 x 103-120 and those targets were 25+ miles south of them. A capture march
// being long costs only time (the taker loops until the camp falls); a drain that cannot
// reach costs the whole target. So coverage wins.
function buildPlan(sv) {
  // `npc=1` should already exclude anything owned, but a stale sweep has had us attack a
  // tile that was ours: belt and braces.
  const ours = ourTiles();
  const free = npc10s().filter((t) => !RESERVED.includes(t.join(',')) && !ours.has(t.join(',')));
  const killers = sv.drain.filter((w) => w.cata >= 300000 && w.big >= 1);

  // Score every candidate: how many killer cities and how many loyalty cities can reach it.
  const scored = free.map((t) => ({
    t, key: t.join(','),
    killers: killers.filter((w) => euc(w.xy, t) <= MAX_DRAIN_MILES).length,
    loyal: sv.drain.filter((w) => w.idle > 0 && euc(w.xy, t) <= MAX_DRAIN_MILES).length,
  })).filter((s) => s.killers > 0 && s.loyal > 0)
    // Among targets the drain can actually reach, take the ones nearest the hub. Sorting by
    // raw coverage instead pulled the choice into the middle of the drain cluster and put
    // targets 30 miles from their capturer and well outside the hub.
    .sort((a, b) => euc(a.t, HUB) - euc(b.t, HUB));

  // Walk the best-covered targets, giving each one a distinct killer city and a distinct
  // capturer city, until every account's quota is filled.
  const left = { ...WANT };
  const killUsed = new Set(), cityUsed = new Set();
  const plan = [];
  for (const s of scored) {
    if (!Object.values(left).some((n) => n > 0)) break;
    const kill = killers
      .filter((w) => !killUsed.has(w.id) && euc(w.xy, s.t) <= MAX_DRAIN_MILES)
      .sort((a, b) => euc(a.xy, s.t) - euc(b.xy, s.t))[0];
    if (!kill) continue;
    // the nearest free capturer city belonging to an account that still wants a town
    let best = null;
    for (const acct of Object.keys(WANT)) {
      if (!left[acct] || !sv.take[acct]) continue;
      for (const c of sv.take[acct].cities) {
        // a city captured minutes ago has no troops - it cannot be a capturer
        if (cityUsed.has(c.id) || c.cav < 2000 || c.scout < 2000) continue;
        const d = euc(c.xy, s.t);
        if (!best || d < best.d) best = { acct, c, d };
      }
    }
    if (!best) continue;
    killUsed.add(kill.id); cityUsed.add(best.c.id); left[best.acct]--;
    plan.push({ target: s.key, t: s.t, acct: best.acct, lord: sv.take[best.acct].lord,
      takeCity: best.c.id, takeName: best.c.name, takeXY: best.c.xy,
      takeDist: Math.round(best.d * 10) / 10,
      kill: { acct: kill.acct, id: kill.id, name: kill.name, xy: kill.xy, bestAtt: kill.bestAtt,
        dist: Math.round(euc(kill.xy, s.t) * 10) / 10 } });
  }

  // Loyalty cities: every drainer with an idle hero goes to the target it can reach that
  // has the FEWEST so far, so the grind is spread evenly instead of piling on the first.
  // A city short of any one troop type refuses the wave, so require stock for ~3 rounds of
  // cata:20000,c:10000,s:20000 before counting a city as a grinder.
  const canGrind = (w) => w.cata >= 400000;   // ~20 waves of cata:20000, the only type used
  for (const w of sv.drain.filter((x) => !killUsed.has(x.id) && x.idle > 0 && canGrind(x))) {
    const inRange = plan.filter((j) => euc(w.xy, j.t) <= MAX_DRAIN_MILES);
    if (!inRange.length) continue;
    const job = inRange.sort((a, b) => (a.loyal || []).length - (b.loyal || []).length)[0];
    (job.loyal = job.loyal || []).push({ acct: w.acct, id: w.id, name: w.name, xy: w.xy,
      idle: w.idle, dist: Math.round(euc(w.xy, job.t) * 10) / 10 });
  }
  return plan;
}

// ---------------------------------------------------------------------------- dispatch
// A city runs one script. A busy city REFUSES a new one - and a silent refusal is how five
// targets lost their capturer. Always stop, then start, then report what actually took.
async function fire(acct, city, text, what) {
  try { await call('script_stop', { account: acct, city }); } catch { /* nothing was running */ }
  await new Promise((r) => setTimeout(r, 350));
  try {
    const out = String(await call('script', { account: acct, city, text }));
    // Match on the words the SERVER uses to refuse, not on any "error" in the string: the
    // script tool's own reply suggests `types="script_finished,script_error"`, and a naive
    // /error/i test reported all nine killing waves as failed when every one had started.
    const ok = /started/.test(out) && !/REFUSED|already running|not found/i.test(out);
    const parsed = /parsed (\d+) action/.exec(out);
    if (!ok || (parsed && Number(parsed[1]) === 0)) {
      console.log('   REFUSED ' + what + ': ' + out.replace(/\n/g, ' | ').slice(0, 150));
      return false;
    }
    return true;
  } catch (e) {
    console.log('   ERROR ' + what + ': ' + e.message.slice(0, 150));
    return false;
  }
}

function killScript(tg) {
  const L = [];
  for (let i = 1; i <= 3; i++) {
    L.push(`attack ${tg} ${KILL_HERO} ${KILL_TROOPS}`);
    L.push(`echo "KILL ${i} ${tg} -> " + $error`);
  }
  return L.join('\n');
}
// `repeat N` repeats THE LAST LINE THAT RAN, until it has run N times in all. There is no
// block form and no `endrepeat` — a `repeat 40 … endrepeat` wrapper parses as three stray
// lines and sends nothing, which on 2026-09-28 left 23 "dispatched" scripts doing nothing
// at all while reporting success. So the shape is: hire a hero, send a wave, repeat THAT
// wave; and a few such groups back to back.
//
// Repeating the attack line is also what makes the grind keep pace: an attack whose hero is
// still out resends the moment one is home (EVONY-RULES, attack repeat speed). `getspamhero`
// (= hire best) refills the feasting hall between groups, guarded by checkFeastingHallSpace
// so the training hero always keeps a slot to move through (the user, 2026-09-28).
function wavesScript(tg, troops, hero, tag, rounds) {
  const per = 10;                                  // a city holds ~10 marches (rally spot 10)
  const groups = Math.max(1, Math.ceil(Number(rounds || 40) / per));
  const L = [];
  for (let g = 0; g < groups; g++) {
    L.push('if city.checkFeastingHallSpace getspamhero');
    L.push(`attack ${tg} ${hero} ${troops}`);
    L.push(`repeat ${per}`);
  }
  L.push(`echo "${tag} ${tg} done -> " + $error`);
  return L.join('\n');
}
const loyalScript = (tg, rounds) => wavesScript(tg, LOYAL_TROOPS, LOYAL_HERO, 'LOYAL', rounds);
const takeScript = (tg, rounds) => wavesScript(tg, TAKE_TROOPS, TAKE_HERO, 'TAKE', rounds);

// ---------------------------------------------------------------------------- commands
async function cmdPlan() {
  const sv = await survey();
  const plan = buildPlan(sv);
  fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 1));
  console.log('drainer cities surveyed: ' + sv.drain.length);
  const noBig = sv.drain.filter((w) => w.big === 0);
  if (noBig.length) console.log('  (' + noBig.length + ' have NO idle hero over 500 attack: '
    + noBig.map((w) => w.acct + ' ' + w.name).join(', ') + ')');
  console.log('');
  for (const j of plan) {
    console.log(j.target.padEnd(9) + ' -> ' + j.lord + ' ' + j.takeName + ' @' + j.takeXY.join(',')
      + ' (' + j.takeDist + 'mi)');
    console.log('    kill  ' + (j.kill ? j.kill.acct + ' ' + j.kill.name + ' @' + j.kill.xy.join(',')
      + ' best hero ' + j.kill.bestAtt + ' att, ' + j.kill.dist + 'mi' : '*** NO KILLER ***'));
    console.log('    loyal ' + (j.loyal || []).length + ' cities, '
      + (j.loyal || []).reduce((n, w) => n + w.idle, 0) + ' idle heroes');
  }
  const bad = plan.filter((j) => !j.kill);
  if (bad.length) console.log('\nWARNING: ' + bad.length + ' target(s) have no killer city.');
  console.log('\nplan written to ' + PLAN_FILE);
  return plan;
}

async function cmdKill() {
  const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
  let ok = 0;
  for (const j of plan) {
    if (!j.kill) { console.log(j.target + ': no killer, skipped'); continue; }
    const good = await fire(j.kill.acct, j.kill.id, killScript(j.target), 'kill ' + j.target);
    console.log(j.target + ' kill <- ' + j.kill.acct + ' ' + j.kill.name + (good ? '  sent' : '  FAILED'));
    if (good) ok++;
  }
  console.log('\n' + ok + '/' + plan.filter((j) => j.kill).length + ' killing scripts running');
}

async function cmdGrind(rounds) {
  const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
  const R = Number(rounds || 40);
  let sent = 0, failed = 0;
  for (const j of plan) {
    for (const w of (j.loyal || [])) {
      (await fire(w.acct, w.id, loyalScript(j.target, R), 'loyal ' + j.target + ' ' + w.name)) ? sent++ : failed++;
    }
    (await fire(j.acct, j.takeCity, takeScript(j.target, R), 'take ' + j.target)) ? sent++ : failed++;
    console.log(j.target + ': ' + (j.loyal || []).length + ' loyalty cities + 1 capturer dispatched');
  }
  console.log('\n' + sent + ' scripts dispatched, ' + failed + ' refused');

  // "Dispatched" is not "attacking". A malformed script is accepted, runs, sends nothing and
  // reports success - that is exactly how 23 cities sat idle on 2026-09-28 while the run log
  // said everything was fine. So go back and look for a wave actually leaving each city.
  console.log('\nverifying waves are leaving...');
  await new Promise((r) => setTimeout(r, 10000));
  let live = 0, dead = [];
  for (const j of plan) {
    for (const w of [...(j.loyal || []), { acct: j.acct, id: j.takeCity, name: j.takeName + ' (taker)' }]) {
      const o = String(await call('script_runs', { account: w.acct, city: w.id }));
      if (/attack -> |-> ok/.test(o)) live++;
      else dead.push(j.target + ' ' + w.acct + ' ' + w.name);
    }
  }
  console.log(live + ' cities confirmed sending waves');
  if (dead.length) console.log('NOT SENDING: ' + dead.join(' | '));
}

// Who owns each target now, straight from the capturing account's own city list - the
// cheapest signal that does not depend on a map sweep's freshness.
async function owners() {
  const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
  const mine = {};
  for (const acct of new Set(plan.map((j) => j.acct))) {
    const port = portOf(acct);
    const s = port ? await getJSON(port, '/api/session') : null;
    for (const c of ((s && s.cities) || [])) mine[c.x + ',' + c.y] = acct;
  }
  return { plan, mine };
}

// ---------------------------------------------------------------------------- loyalty
// HOW LOYALTY IS KNOWN (deploy-loops.js:39): a BATTLE report gives only the loyalty
// CHANGE (民心变化). Only a SCOUT report gives the level. So to watch a camp come down we
// scout it and read `Info: Loyalty: N` out of the report.
//
// The scouting is done from a QUIET account, not from one in the drive: an account that is
// attacking writes hundreds of reports a minute and the scout report is off page 1 of
// \quickarmyreport before it can be read.
const SCOUT_ACCTS = ['a23', 'a24', 'a25'];

// ...but there is a far better source, and it costs nothing (the user, 2026-09-28):
// the SYSTEM chat channel. Every wave that fails to conquer writes a line like
//
//   <02:57:21> Defeat Barbarian's city(717,117), Prestige: 0. Hero Queen gains experience
//   14404. Troops Casualty: 148. Conquered unsuccessfully, The Loyalty of this city is 2.
//   Loyalty Trend: -4.
//
// - absolute loyalty, live, for every target we are hitting, with no scout and no march.
// When the loyalty reaches 0 the wording changes to "You need further promotion of you
// Title" (the attacker cannot hold another city) - which is the signal that the camp is
// ready and only the capturer's wave is missing.
//
// NOTE: /api/chat will NOT take the internal token ("not signed in") - it needs a real
// Director session cookie.
const CHAT_ACCTS = ['a6', 'a7', 'a16', 'a27', 'a28', 'a29'];
const AUTH = require('./auth');
function sessionCookie() {
  const org = D.all('SELECT id FROM orgs LIMIT 1')[0];
  const u = D.all('SELECT id FROM users LIMIT 1')[0];
  const s = AUTH.newSession(u.id, org.id, '127.0.0.1', 'npc-drive');
  return 'otto_sid=' + (typeof s === 'string' ? s : (s.id || s.sid));
}
const getChat = (port, cookie, ch) => new Promise((res) => {
  http.get({ host: 'localhost', port, path: '/api/chat?channel=' + ch, headers: { Cookie: cookie }, timeout: 20000 },
    (r) => { let s = ''; r.on('data', (d) => s += d); r.on('end', () => { try { res(JSON.parse(s).lines || []); } catch { res([]); } }); })
    .on('error', () => res([])).on('timeout', () => res([]));
});

// The newest loyalty reading for every camp anyone in the fleet is hitting.
async function loyaltyFromChat() {
  const cookie = sessionCookie();
  const seen = {};
  for (const a of CHAT_ACCTS) {
    const port = portOf(a);
    if (!port) continue;
    for (const line of await getChat(port, cookie, 'system')) {
      const txt = String(line.msg || '');
      const where = /Barbarian's city\((\d+),(\d+)\)/.exec(txt);
      if (!where) continue;
      const key = where[1] + ',' + where[2];
      const at = Number(line.t || 0);
      const lvl = /Loyalty of this city is (\d+)/.exec(txt);
      // "You need further promotion of you Title" = it reached 0 and this account cannot hold it
      const zero = /further promotion/.test(txt);
      if (!lvl && !zero) continue;
      const rec = { loyalty: lvl ? Number(lvl[1]) : 0, at, by: a, zero };
      if (!seen[key] || rec.at >= seen[key].at) seen[key] = rec;
    }
  }
  return seen;
}

async function cmdLoyalty() {
  const { plan, mine } = await owners();
  const loy = await loyaltyFromChat();
  const age = (t) => t ? Math.round((Date.now() - t) / 1000) + "s ago" : "";
  let got = 0, ready = 0;
  for (const j of plan) {
    if (mine[j.target] === j.acct) { got++; console.log(j.target.padEnd(9) + "CAPTURED by " + j.lord); continue; }
    const f = loy[j.target];
    if (!f) { console.log(j.target.padEnd(9) + "  ?  no wave has reported yet   (taker " + j.lord + ")"); continue; }
    if (f.loyalty === 0) ready++;
    console.log(j.target.padEnd(9) + String(f.loyalty).padStart(3) + " loyalty"
      + (f.zero ? "  AT ZERO - waiting on " + j.lord + "s wave" : "") + "   " + age(f.at));
  }
  // camps the fleet is hitting that are not in the plan at all
  for (const k of Object.keys(loy)) {
    if (plan.some((j) => j.target === k)) continue;
    console.log(k.padEnd(9) + String(loy[k].loyalty).padStart(3) + " loyalty   (not in this plan)");
  }
  console.log("");
  console.log(got + "/" + plan.length + " captured, " + ready + " at zero loyalty waiting for a capturer");
}

// Keep the targets we are already grinding, but re-spread EVERY usable drainer city over
// the ones still open and send a deep stack of waves. Called when targets fall (their
// grinders are freed) or when the wave count per camp is simply too low: a camp needs
// 30-40 landed waves, and one city can only hold 10 marches at a time.
async function cmdRearm(rounds) {
  const { plan, mine } = await owners();
  const open = plan.filter((j) => mine[j.target] !== j.acct);
  if (!open.length) { console.log("every target is captured"); return; }
  const sv = await survey();
  const canGrind = (w) => w.cata >= 400000;
  for (const j of open) j.loyal = [];
  for (const w of sv.drain.filter(canGrind)) {
    const inRange = open.filter((j) => euc(w.xy, j.t) <= MAX_DRAIN_MILES);
    if (!inRange.length) continue;
    const job = inRange.sort((a, b) => a.loyal.length - b.loyal.length)[0];
    job.loyal.push({ acct: w.acct, id: w.id, name: w.name, xy: w.xy, idle: w.idle });
  }
  const R = Number(rounds || 60);
  let sent = 0;
  for (const j of open) {
    for (const w of j.loyal) {
      if (await fire(w.acct, w.id, loyalScript(j.target, R), "loyal " + j.target)) sent++;
    }
    console.log(j.target.padEnd(9) + j.loyal.length + " grinder cities x " + R + " waves");
  }
  // keep the new assignment so the watcher stands the right cities down on capture
  const merged = plan.map((p) => { const o = open.find((x) => x.target === p.target); return o || p; });
  fs.writeFileSync(PLAN_FILE, JSON.stringify(merged, null, 1));
  console.log("");
  console.log(sent + " grinder scripts running over " + open.length + " open targets");
}

async function cmdStatus() {
  const { plan, mine } = await owners();
  let got = 0;
  for (const j of plan) {
    const ours = mine[j.target] === j.acct;
    if (ours) got++;
    console.log(j.target.padEnd(9) + (ours ? 'CAPTURED by ' + j.lord : 'still open  (' + j.lord + ' is taking it)'));
  }
  console.log('\n' + got + '/' + plan.length + ' captured');
}

// Everything that fired at a target has to be stopped AND recalled the moment it is ours,
// or its own waves land on it as enemy attacks.
async function standDown(job) {
  const cities = [...(job.loyal || []), ...(job.kill ? [job.kill] : [])];
  for (const w of cities) {
    try { await call('script_stop', { account: w.acct, city: w.id }); } catch {}
    await fire(w.acct, w.id, `recall ${job.target}\necho "RECALL ${job.target} -> " + $result`,
      'recall ' + job.target + ' ' + w.name);
  }
  try { await call('script_stop', { account: job.acct, city: job.takeCity }); } catch {}
  console.log('  stood down ' + cities.length + ' drainer cities and the capturer');
}

async function cmdWatch(minutes) {
  const until = Date.now() + Number(minutes || 60) * 60000;
  const done = new Set();
  while (Date.now() < until) {
    const { plan, mine } = await owners();
    for (const j of plan) {
      if (done.has(j.target)) continue;
      if (mine[j.target] !== j.acct) continue;
      // CONFIRM BEFORE STANDING DOWN. On 2026-09-28 the account city list reported 692,125
      // as a28's for one poll, the watcher stood seven grinders down on the strength of it,
      // and the tile was still `npc=1, level=10` — the whole grind had been thrown away on a
      // single bad read. A capture must survive a second look 20 s later AND the map must
      // agree the tile is no longer an NPC.
      await new Promise((r) => setTimeout(r, 20000));
      const again = await owners();
      const stillOurs = again.mine[j.target] === j.acct;
      const row = D.all('SELECT npc FROM map_cache WHERE x=? AND y=?', j.t[0], j.t[1])[0];
      const mapSaysNpc = row && Number(row.npc) === 1;
      if (!stillOurs) {
        console.log(new Date().toTimeString().slice(0, 8) + '  (false alarm on ' + j.target + ' — not ours on re-read)');
        continue;
      }
      if (mapSaysNpc) console.log('  note: map_cache still calls ' + j.target + ' an NPC (stale sweep?) — trusting the city list');
      done.add(j.target);
      console.log(new Date().toTimeString().slice(0, 8) + '  CAPTURED ' + j.target + ' by ' + j.lord);
      await standDown(j);
    }
    if (done.size >= plan.length) { console.log('all targets captured'); return; }
    await new Promise((r) => setTimeout(r, 30000));
  }
  console.log('watch window closed; ' + done.size + ' captured this window');
}

async function cmdStopAll() {
  const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
  for (const j of plan) { console.log(j.target + ':'); await standDown(j); }
}

const [, , cmd, arg] = process.argv;
(async () => {
  if (cmd === 'plan') await cmdPlan();
  else if (cmd === 'kill') await cmdKill();
  else if (cmd === 'grind') await cmdGrind(arg);
  else if (cmd === 'watch') await cmdWatch(arg);
  else if (cmd === 'status') await cmdStatus();
  else if (cmd === 'loyalty') await cmdLoyalty(arg);
  else if (cmd === 'rearm') await cmdRearm(arg);
  else if (cmd === 'stopall') await cmdStopAll();
  else console.log('usage: node npc-drive.js loyalty [wait s]|plan|kill|grind [rounds]|watch [minutes]|status|stopall');
})().catch((e) => { console.error(e); process.exit(1); });
