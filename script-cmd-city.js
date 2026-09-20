'use strict';
// City and troop commands for scripts (the command-module contract is at the top
// of script.js). NEAT's words and forms (guide.neatportal.com, ScriptCity and
// ScriptTroop), and OTTObot's older forms beside them.
//
// ------------------------------------------------------------------ buildings
//   create <type> [plot | @plot] [/speedup=<items>] [/nowait]
//                            a new building on a free plot, or that one (create a 0, create embassy 2)
//   build <type> [at <plot>] OTTObot's: the same, sent at once with no waiting (a job of
//                            5 minutes or less still gets the free speed-up).
//                            build c:10:9 and build ?w:10?q:0:0 are NEAT's build GOAL (script-cmd-goals.js)
//   upgrade <type> [policy] [at <plot>] [/speedup=<items>] [/nowait]
//                            the lowest-level one, never past level 9 without a policy
//   upgrade                  NEAT's bare form: the lowest building or field of any type
//                            below 9 whose prerequisites are met (upgrade + repeat = all to 9)
//   demo <type | any> [policy] [@plot] [/dynamite] [/speedup=<items>] [/nowait]
//                            one level down; a level-10 building only with level10 or highestlevel 10
//   demosite [/dynamite] <plot>        one level off whatever stands there, any level
//                            (never the Town Hall or the Walls, plots -1 and -2: the client has
//                            no Destruct for them, BuildingInfoWin.as:1324-1330)
//   cancelbuilding [@plot]             the construction under way (castle.cancleBuildCommand)
//   buildingspeedup [@plot] <item[,item]>   researchspeedup <item[,item]>
//     types      NEAT's words: a b be c e fh fo f s q i inn m r rs st t w wh ws, the names
//                (iron mine, feasting hall ...) and house, saw, iron, barrack
//     policies   levelX (le X): one at level X — level9 or level10 takes a level-9 one to 10,
//                spending a Michelangelo's Script | lowestlevel[ X] (lo): the lowest, below X
//                | highestlevel[ X] (hi): the highest, below X (upgrade: 10 by default, so it
//                may spend a Script; demo: at or below X, 9 by default)
//     waiting    create/upgrade/demo/demosite wait while the builder is busy, while
//                resources come in (when they are coming), and for the job to finish;
//                /nowait skips only that last wait. Stop ends any wait.
//     speed-ups  /speedup="Ultimate Guidelines,Beginner Guidelines" applies held items in
//                order until the job is done. An item (and /dynamite's Dynamite) goes out
//                only while the loaded inventory shows one: the game BUYS a missing one
//                with cents, so none is ever sent unseen. A job the game finishes free
//                (preset time 5 minutes or less) gets the free speed-up by itself.
//                Items: Beginner, Primary, Intermediate, Senior, Master, Ultimate Guidelines,
//                their ids (consume.2.a ...), and free (only for a job the game finishes free).
//                coins: see ALLOW_COINS_SPEEDUP.
// ------------------------------------------------------------------ research
//   startresearch <tech | quickest | cheapest | dearest> [/nowait] [/speedup=<items>]
//   research <tech>          OTTObot's: sent at once. research lo:5 is NEAT's research GOAL
//   cancelresearch | checkresearch ($result: the techs that can start now)
//     techs      ag lu mas mi met in ms mt ir lo com ho ar st/sp med con en mac pr, or the names
// ------------------------------------------------------------------ walls
//   walldefense <type> [qty] [build | demo | keep]          (bare: build 1 trap)
//   walldefense [build | demo | keep | /build | /demo | /keep] tra:1k,ab:1k,at:5k,r:10,tre:0
//   wall abatis 1000         OTTObot's: build (trap abatis tower logs rocks, or tra ab at r tre)
// ------------------------------------------------------------------ troops
//   train a:5000 [hero] [barracks plot | all | idle] [minimum]   one type; as many as res and
//                            idle population allow; hero any | atk | a name is mayor for the order
//                            and the old mayor comes back after; train help
//   train a 10k              OTTObot's: exactly that many, into the first barracks
//   disband w:25k | disband /keep w:25k     /keep counts troops out on marches as kept
//   dumptroop <x,y> <when> <send>           reinforce with <send> once the city holds <when>
//   healtroops               the whole medic camp, for city gold
//   canceltroopqueues [n] | cancelfortifications [n]   (queue-cancel.js)
// ------------------------------------------------------------------ the city
//   production <food> <wood> <stone> <iron>   tax <0-100> | settaxrate <0-100>
//   comfort <1-4 | relief | pray | bless | popraise>    levy <1-5 | gold | food | wood | stone | iron>
//   renamecity <name> [picture 1-4]      10 letters at most (the game's limit); "a name" in quotes
//   setfocus [cycles]        accepted and does nothing: the goals visit every city every tick
// ------------------------------------------------------------------ valleys, towns, moving
//   abandon <x,y>            give up a valley or flat of yours ($error set if it did not go)
//   abandontown <x,y | city> confirm [anyway]
//                            gives the city up for good; `confirm` is required, and
//                            `anyway` too while heroes, troops or marches would be lost.
//                            Off unless the console starts with OTTO_ALLOW_ABANDON_TOWN=1;
//                            never the last city, never one the city registry protects
//                            (only buildnpc's throwaways); signed with the login's password
//                            hash, so it needs the goals update
//   evacuatetown <x,y> confirm   every troop, and all they can carry, reinforce x,y
//   endevacuate [x,y]        recall the evacuation march(es)
//   buildcity <x,y> [hero] [troops]   (also newcity) capture the flat first if it is not
//                            yours (ValleyTroops defaults by its level), then found the city
//   cancelbuildcity [x,y]    stop a buildcity still waiting on its capture
//   teleport <x,y> | teleport <state> | teleport random | warteleport <x,y>   [from <city>]
//                            (teleport.js; a held Pioneer Express Teleport goes first for x,y)
//   autoteleport [<state> | random] [all confirm] [/tries=5] [/every=5:00] [/norecall]
//                            NEAT's AutoTeleporter: recall the city's armies, wait for them,
//                            teleport, retry; no state = the -teleport start-up parameter;
//                            all (every city) takes confirm
//
// run() opts read here (tests): cityPollMs cityGraceMs cityRecheckMs cityPlotWaitMs cityPushWaitMs
const C = require('./constants');
const W = require('./script-words');

// Speeding a job up with coins (itemId coins.speed, the "Instant Finish") spends
// cents, and scripts spend cents only through buyitem (DESIGN rule 5). Off:
// /speedup=coins, buildingspeedup coins and researchspeedup coins are refused
// when the script loads. On: `coins` written out is taken; the price is read
// first (castle.getCoinsNeed / tech.getCoinsNeed) and logged, and a dry run
// shows it and spends nothing.
const ALLOW_COINS_SPEEDUP = false;
// abandontown gives a city up for good. confirm and anyway keep it from being a
// typo, but a script can also come from get, call or execute, so the console's
// operator has to switch it on too: start the console with
// OTTO_ALLOW_ABANDON_TOWN=1. Nothing a script writes can switch it on.
const settings = { allowCoins: ALLOW_COINS_SPEEDUP, allowAbandonTown: process.env.OTTO_ALLOW_ABANDON_TOWN === '1' };   // tests flip them

// ------------------------------------------------------------------ small helpers

const n = (x) => Number(x || 0);
const fmt = (v) => Math.round(n(v)).toLocaleString('en-US');
const lc = (s) => String(s == null ? '' : s).toLowerCase();
const tokens = (args) => String(args || '').split(/\s+/).filter(Boolean);
const isNum = (s) => /^\d+(\.\d+)?[kmb]?$/i.test(String(s || ''));

// 90 -> "1m 30s", 5400 -> "1h 30m"
function dur(sec) {
  const s = Math.max(0, Math.round(n(sec)));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

// The words of a line. "Home City" stays one word, and so does
// /speedup="Ultimate Guidelines,coins"; the quotes go.
function words(text) {
  const out = [];
  let cur = '', open = false, any = false;
  for (const ch of String(text || '')) {
    if (open) { if (ch === '"') open = false; else cur += ch; continue; }
    if (ch === '"') { open = true; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (open) throw new Error('a quote is not closed');
  if (cur || any) out.push(cur);
  return out;
}

// /nowait /dynamite /speedup=<items> ... out of the words, wherever they are.
function takeSwitches(ws, allowed, cmd) {
  const sw = {}, rest = [];
  for (const w of ws) {
    const m = /^\/([a-z]+)(?:[=:](.*))?$/i.exec(w);
    if (!m) { rest.push(w); continue; }
    const k = m[1].toLowerCase();
    if (!allowed.includes(k)) {
      throw new Error(`${cmd}: unknown switch /${m[1]} — ${allowed.length ? 'it takes ' + allowed.map((a) => '/' + a).join(' ') : 'it takes none'}`);
    }
    sw[k] = m[2] === undefined ? true : m[2];
  }
  return { sw, rest };
}

// 123,456 | 123, 456 as one or two words
function coordsIn(ws, i, cmd) {
  let t = String(ws[i] || '');
  let used = 1;
  if (/^\d+,$/.test(t) && /^\d+$/.test(String(ws[i + 1] || ''))) { t += ws[i + 1]; used = 2; }
  const m = t.replace(/^!/, '').match(/^(\d+)\s*,\s*(\d+)$/);
  if (!m) return null;
  const xy = { x: +m[1], y: +m[2] };
  if (xy.x >= C.MAP_W || xy.y >= C.MAP_W) throw new Error(`${cmd}: ${xy.x},${xy.y} is off the map (0-${C.MAP_W - 1})`);
  return { xy, used };
}
const at = (xy) => `${xy.x},${xy.y}`;

// The wiki writes !OtherCity and !lowestlevel: MoinMoin's escape, not the syntax.
const unbang = (w) => String(w).replace(/^!(?=[A-Za-z])/, '');

function fail(env, why) {
  env.log('  ' + why);
  return { ok: false, error: why };
}

// How many of an item the account holds, or null when the inventory was never
// loaded.
function heldCount(game, itemId) {
  const items = game.player && game.player.items;
  if (!Array.isArray(items)) return null;
  const it = items.find((i) => i.id === itemId);
  return it ? n(it.count) : 0;
}

// A speed-up or Dynamite that is NOT held is bought with cents when it is sent:
// the client sends castle.speedUpBuildCommand for an item it lacks and then
// reports the purchase (BuildingInfoWin.onSpeedUpItemSelected :1215-1224), and
// its Dynamite path goes ahead on cents alone (DestrctChoiceWin.buyAndUse
// :405-418 with UIUtil.checkItem :423-446). So such an item goes out only while
// the loaded inventory shows one — less those this run used whose ItemUpdate
// push has not landed yet. -> the count that may be used, or null (not loaded).
function itemLeft(env, itemId) {
  const held = heldCount(env.game, itemId);
  if (held === null) return null;
  const spent = (env.state.spent = env.state.spent || new Map());
  const s = spent.get(itemId);
  if (s && held === s.at) return Math.max(0, s.at - s.used);   // no push since: count them off here
  if (s) spent.delete(itemId);                                 // a push landed: the list is right again
  return held;
}
// null when an item may go out, else why not
function notHeld(env, itemId, name) {
  const left = itemLeft(env, itemId);
  if (left === null) return `the inventory is not loaded, so whether a ${name} is held cannot be checked — not sent (the game buys a missing one with cents)`;
  if (left < 1) return `no ${name} held (${itemId}) — not sent: it is never bought`;
  return null;
}
// After the server took one: `before` is the count seen before sending.
function usedItem(env, itemId, before) {
  const held = heldCount(env.game, itemId);
  if (held === null || before === null || held !== before) return;   // the push already counted it
  const spent = (env.state.spent = env.state.spent || new Map());
  const s = spent.get(itemId);
  if (s && s.at === held) s.used++; else spent.set(itemId, { at: held, used: 1 });
}

// Cached object reads (script-objects.js) that a command has just changed.
function forget(game, prefix) {
  try { require('./script-objects').forget(game, prefix); } catch { /* not loaded */ }
}

// The timings every wait here uses; run() opts shrink them in the tests.
const T = (env) => {
  const o = env.opts || {};
  return {
    poll: o.cityPollMs ?? 1000,          // how often a wait looks again
    grace: o.cityGraceMs ?? 60000,       // past a job's end with no word of it: done
    recheck: o.cityRecheckMs ?? 30000,   // resources and plots
    plotWait: o.cityPlotWaitMs ?? 600000,
    push: o.cityPushWaitMs ?? 15000,     // for a push that should follow a reply
  };
};

// ------------------------------------------------------------------ the tables

// Speed-up items (ItemManager.speedItemArray; names from the item catalogue).
const SPEEDUPS = [
  { id: 'consume.2.a', name: 'Beginner Guidelines' },       // 15 minutes
  { id: 'consume.2.b', name: 'Primary Guidelines' },        // 1 hour
  { id: 'consume.2.b.1', name: 'Intermediate Guidelines' }, // 2.5 hours
  { id: 'consume.2.c', name: 'Senior Guidelines' },         // 8 hours
  { id: 'consume.2.c.1', name: 'Master Guidelines' },       // 10-30 hours
  { id: 'consume.2.d', name: 'Ultimate Guidelines' },       // 30%
];
const FREE_ITEM = 'free.speed';              // CommonConstants.FREE_SPEED_ITEM_ID (CommonConstants.as:61)
const COINS_ITEM = 'coins.speed';            // CommonConstants.COINS_SPEED_ITEM_ID (CommonConstants.as:113)
const DYNAMITE = 'player.destroy.1.a';       // CommonConstants.DESTROY_BUILDING_ITEM_IMMEDIATELY (:63)
const SCRIPT_ITEM = 'consume.blueprint.1';   // Michelangelo's Script, spent by an upgrade 9 -> 10
const PIONEER = 'player.move.castle.1.b';    // CityConstants.PIONEER_EXPRESS_TELEPORT (CityConstants.as:27)
const CITY_TELEPORTER = 'consume.move.1';
const ITEM_NAMES = { [SCRIPT_ITEM]: "Michelangelo's Script", [DYNAMITE]: 'Dynamite', [PIONEER]: 'Pioneer Express Teleport' };

// The jobs the game finishes free: preset (base) time of 300 s or less
// (CommonConstants.FREE_SPEED_TIME_LIMIT; SpeedUpCheckOut.as), by the level the
// job starts from. The table is constants.js's, from the client's own.
const FREE = C.FREE_SPEED;
function freePreset(kind, typeId, level) {
  const row = (kind === 'research' ? FREE.research : FREE.building)[n(typeId)];
  const s = row && row[n(level)];
  return s > 0 && s <= FREE.limitSec ? s : null;
}

// ValleyTroops' defaults for capturing a flat, by its level (wiki ValleyTroops).
const VALLEY_TROOPS = {
  1: { archer: 50 }, 2: { archer: 100 }, 3: { archer: 200 },
  4: { militia: 1200, scouter: 1, pikemen: 1, swordsmen: 1, archer: 400 },
  5: { militia: 2400, scouter: 1, pikemen: 1, swordsmen: 1, lightCavalry: 1, archer: 800 },
  6: { militia: 4800, scouter: 1, pikemen: 1, swordsmen: 1, lightCavalry: 1, archer: 1600 },
  7: { militia: 9600, scouter: 1, pikemen: 1, swordsmen: 1, lightCavalry: 1, archer: 3200 },
  8: { militia: 19200, scouter: 1, pikemen: 1, swordsmen: 1, lightCavalry: 1, archer: 6400 },
  9: { militia: 38400, scouter: 1, pikemen: 1, swordsmen: 1, lightCavalry: 1, archer: 12800 },
  10: { militia: 60000, scouter: 1, pikemen: 1, swordsmen: 1, lightCavalry: 1, archer: 19990 },
};

const troopText = (troops) => Object.entries(troops).filter(([, v]) => n(v) > 0)
  .map(([k, v]) => `${fmt(v)} ${(C.BY_KEY[k] || {}).name || k}`).join(', ') || 'no troops';
const RES_ORDER = ['food', 'wood', 'stone', 'iron'];
const amountOf = (res, k) => (k === 'gold' ? n(res && res.gold) : n(res && res[k] && typeof res[k] === 'object' ? res[k].amount : res && res[k]));

// ------------------------------------------------------------------ speed-ups

function speedupItem(word, cmd) {
  const raw = String(word || '').trim();
  const k = lc(raw).replace(/[^a-z0-9.]/g, '');
  if (!k) throw new Error(`${cmd}: which speed-up? ${SPEEDUPS.map((s) => s.name).join(', ')}, or free`);
  if (k === 'coins' || k === 'coin' || k === COINS_ITEM) {
    if (!settings.allowCoins) {
      throw new Error(`${cmd}: coins would spend cents (the Instant Finish) — scripts spend cents only through buyitem; `
        + `name a speed-up item you hold instead (${SPEEDUPS.map((s) => s.name).join(', ')})`);
    }
    return { kind: 'coins', id: COINS_ITEM, name: 'coins' };
  }
  if (k === 'free' || k === FREE_ITEM) return { kind: 'free', id: FREE_ITEM, name: 'the free speed-up' };
  const hit = SPEEDUPS.find((s) => s.id === k || lc(s.name).replace(/[^a-z]/g, '') === k || lc(s.name).split(' ')[0] === k);
  if (!hit) throw new Error(`${cmd}: unknown speed-up "${raw}" — ${SPEEDUPS.map((s) => s.name).join(', ')}, their ids (consume.2.a ...), or free`);
  return { kind: 'item', id: hit.id, name: hit.name };
}
function speedupList(text, cmd) {
  if (text === true || !String(text).trim()) throw new Error(`${cmd}: /speedup needs the items: /speedup="Senior Guidelines" or /speedup=consume.2.a,consume.2.b`);
  return String(text).split(',').map((s) => s.trim()).filter(Boolean).map((w) => speedupItem(w, cmd));
}

// castle.speedUpBuildCommand {castleId, positionId, itemId} (CastleCommands.as:175-187)
// and tech.speedUpResearch {castleId, itemId} (TechCommand.as:84-95), through
// game.js's own wrappers where the goals update has them.
const speedBuild = (game, cid, pos, itemId) => (typeof game.speedUpBuild === 'function'
  ? game.speedUpBuild(cid, pos, itemId)
  : game.req('castle.speedUpBuildCommand', { castleId: cid, positionId: pos, itemId }));
const speedResearch = (game, cid, itemId) => (typeof game.speedUpResearch === 'function'
  ? game.speedUpResearch(cid, itemId)
  : game.req('tech.speedUpResearch', { castleId: cid, itemId }));

// Is a building job over? Its plot shows no upgrade or demolition under way.
const buildingIdle = (castle, pos) => { const b = beanAt(castle, pos); return !b || (n(b.status) !== 1 && n(b.status) !== 2); };

// Apply the listed speed-ups to a running job, in order, until it is done.
//   job: { kind: 'building' | 'research', pos, label }
//   main: true when speeding up is what the line is for (a refusal fails it)
async function applySpeedups(env, job, list, main = false) {
  const show = main ? env.say : env.verdict;
  let used = 0;
  job.skipped = [];
  for (const it of list) {
    if (env.stopped()) break;
    const game = env.game;            // each item after a settle: it follows a reconnect
    const cid = env.cid;
    if (job.finished || (job.kind === 'building' && !env.dryRun && buildingIdle(env.castle, job.pos))) {
      env.log(`  ${job.label} is finished — ${it.name} not needed`);
      break;
    }
    let before = null;
    if (it.kind === 'item') {
      const why = notHeld(env, it.id, it.name);
      if (why) { env.log(`  ${why}`); job.skipped.push(why); continue; }
      before = heldCount(game, it.id);
    }
    // the client sends free.speed only for a job of 5 minutes' preset time or less,
    // never a demolition (BuildingInfoWin.onSpeedUp :984-1000; SpeedUpCheckOut)
    if (it.kind === 'free' && !job.preset) {
      const why = `the free speed-up is only for a job of ${dur(FREE.limitSec)} or less (not a demolition) — not sent`;
      env.log(`  ${why}`); job.skipped.push(why); continue;
    }
    if (it.kind === 'coins') {
      if (!settings.allowCoins) throw new Error('coins would spend cents — scripts spend cents only through buyitem');
      // castle.getCoinsNeed {castleId, positionId} (CastleCommands.as:64-75),
      // tech.getCoinsNeed {castleId} (TechCommand.as:30-40) -> {coinsNeed}
      const p = job.kind === 'research'
        ? await game.req('tech.getCoinsNeed', { castleId: cid })
        : await game.req('castle.getCoinsNeed', { castleId: cid, positionId: job.pos });
      if (!p || p.ok !== 1) { env.log(`  could not read what coins would cost (${env.verdict(p)}) — nothing spent`); continue; }
      env.log(`  finishing ${job.label} with coins spends ${fmt(p.coinsNeed)} cents`);
    }
    if (env.dryRun) { env.log(`  speed up ${job.label} with ${it.name} — [dry run] not sent`); continue; }
    const r = job.kind === 'research' ? await speedResearch(game, cid, it.id) : await speedBuild(game, cid, job.pos, it.id);
    env.log(`  speed up ${job.label} with ${it.name} -> ${show(r)}`);
    if (r && r.ok === 1) {
      used++;
      if (it.kind === 'item') usedItem(env, it.id, before);
      if (job.kind === 'research' && r.tech && typeof r.tech === 'object') {
        job.tech = r.tech;
        if (!r.tech.upgradeing) job.finished = true;
      }
    }
    if (job.kind === 'building') await settle(env, () => buildingIdle(env.castle, job.pos));
  }
  return used;
}

// A moment for the push that follows a reply.
async function settle(env, done) {
  const t = T(env);
  const until = Date.now() + Math.min(t.push, 3000);
  while (!done() && Date.now() < until && !env.stopped()) await env.pause(Math.min(t.poll, 200));
}

// The free speed-up, when the game gives one to this job.
async function freeFinish(env, job, preset) {
  if (!preset) return false;
  if (env.dryRun) { env.log(`  its preset time is ${dur(preset)}: the free speed-up would finish it — [dry run] not sent`); return false; }
  const game = env.game;
  let r;
  try {
    r = job.kind === 'research' ? await speedResearch(game, env.cid, FREE_ITEM) : await speedBuild(game, env.cid, job.pos, FREE_ITEM);
  } catch (e) { r = { ok: 0, errorMsg: e.message }; }
  env.log(`  free speed-up (preset time ${dur(preset)}) -> ${env.verdict(r)}`);
  if (r && r.ok === 1) {
    if (job.kind === 'research') job.finished = true;
    else await settle(env, () => buildingIdle(env.castle, job.pos));
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ buildings: reading

const standing = (castle) => ((castle && castle.buildings) || []).filter((b) => !(n(b.status) === 0 && n(b.level) === 0));
const beanAt = (castle, pos) => standing(castle).find((b) => Number(b.positionId) === Number(pos)) || null;
const bName = (b) => (C.BUILDING_BY_ID[n(b.typeId)] || {}).name || b.name || `type ${b.typeId}`;
const bLabel = (b) => `${bName(b)} on plot ${b.positionId} (level ${n(b.level)})`;
function jobText(b) {
  const l = n(b.level);
  return `${bName(b)} on plot ${b.positionId}, ${n(b.status) === 2 ? `demolishing L${l}->L${l - 1}` : `L${l}->L${l + 1}`}`;
}
const BARRACKS = 2;

// Under construction: status 1 upgrading or 2 demolishing (BuildingConstants).
// One whose end is well past had its completion push missed and is done.
function busyWith(game, castle, graceMs) {
  const now = game.now();
  return standing(castle).find((b) => (n(b.status) === 1 || n(b.status) === 2)
    && !(n(b.endTime) > 0 && n(b.endTime) < now - graceMs)) || null;
}

// What a condition bean says is missing: buildings, techs and items. A tech
// names its type `id`, not typeId (ConditionDependTechBean), and an item its
// id and count (ConditionDependItemBean) — a level-9 upgrade's Script.
function unmetOf(cond, game = null) {
  if (!cond) return [];
  const out = [];
  for (const b of cond.buildings || []) {
    if (b.successFlag) continue;
    const name = (C.BUILDING_BY_ID[n(b.typeId)] || {}).name || `building ${b.typeId}`;
    out.push({ kind: 'building', typeId: n(b.typeId), need: n(b.level), have: n(b.curLevel), text: `${name} level ${b.level} (you have ${n(b.curLevel)})` });
  }
  for (const t of cond.techs || []) {
    if (t.successFlag) continue;
    const id = n(t.id ?? t.typeId);
    const name = (C.TECH_BY_ID[id] || {}).name || `tech ${id}`;
    out.push({ kind: 'tech', typeId: id, need: n(t.level), have: n(t.curLevel), text: `${name} level ${t.level} (you have ${n(t.curLevel)})` });
  }
  // an item (a level-10 upgrade's Script): the inventory decides when it is
  // loaded, the bean's own flag when not (the bean can be older than a push)
  for (const it of cond.items || []) {
    const need = n(it.num) || 1;
    const held = game ? heldCount(game, it.id) : null;
    const have = held === null ? n(it.curNum) : held;
    if (held === null ? it.successFlag : held >= need) continue;
    out.push({ kind: 'item', id: it.id, need, have, text: `${ITEM_NAMES[it.id] || it.id} x${need} (you have ${fmt(have)})` });
  }
  return out;
}

// What the city is short of for a condition bean (UIUtil.isResourceConditionMatch):
// [{k, need, have, rate per hour, max}]. Idle population (curPopulation less
// the workers on fields and building, as SWEnlist counts it) comes in on its
// own schedule, so it never waits: rate 0.
const idlePop = (res) => Math.max(0, n(res.curPopulation) - n(res.workPeople) - n(res.buildPeople));
function shortfall(cond, res) {
  if (!cond || !res || typeof res !== 'object') return [];
  const out = [];
  for (const k of [...RES_ORDER, 'gold']) {
    const need = n(cond[k]);
    if (need <= 0) continue;
    const have = amountOf(res, k);
    if (have >= need) continue;
    const bean = res[k] && typeof res[k] === 'object' ? res[k] : {};
    const rate = k === 'gold' ? 0 : n(bean.increaseRate) - (k === 'food' ? n(res.troopCostFood) : 0);
    out.push({ k, need, have, rate, max: n(bean.max) });
  }
  if (n(cond.population) > 0 && res.curPopulation !== undefined && idlePop(res) < n(cond.population)) {
    out.push({ k: 'idle population', need: n(cond.population), have: idlePop(res), rate: 0, max: 0 });
  }
  return out;
}
const shortText = (s) => s.map((x) => `${x.k} ${fmt(x.need)} (have ${fmt(x.have)})`).join(', ');

// ------------------------------------------------------------------ buildings: waiting

// NEAT's create "will first check to see if another construction is underway
// and automatically sleep until that construction is done". -> 'free' | 'stopped'
async function waitBuilder(env) {
  const t = T(env);
  let job = busyWith(env.game, env.castle, t.grace);
  if (!job) return 'free';
  const left = () => Math.max(0, n(job.endTime) - env.game.now());
  if (env.dryRun) { env.log(`  the builder is busy (${jobText(job)}, ${dur(left() / 1000)} left) — [dry run] would wait for it`); return 'free'; }
  env.log(`  the builder is busy (${jobText(job)}, ${dur(left() / 1000)} left) — waiting for it (Stop ends the wait)`);
  let until = Date.now() + left() + t.grace;
  for (;;) {
    if (env.stopped()) return 'stopped';
    await env.pause(Math.max(1, Math.min(t.poll, until - Date.now())));
    if (env.stopped()) return 'stopped';
    const now = busyWith(env.game, env.castle, t.grace);
    if (!now) return 'free';
    if (now !== job && (n(now.positionId) !== n(job.positionId) || n(now.startTime) !== n(job.startTime))) {
      job = now;
      env.log(`  ... then ${jobText(job)}, ${dur(left() / 1000)} left`);
      until = Date.now() + left() + t.grace;
    } else job = now;
    if (Date.now() >= until) { env.log('  no word that it finished — trying anyway'); return 'free'; }
  }
}

// Short of resources: wait for them while they are coming in (NEAT's create
// "checks for resources, and if none are present, will sleep until they are").
// -> 'ok' | 'stopped' | { fail }
async function waitResources(env, cond) {
  const t = T(env);
  const res0 = env.castle.resource;
  if (!res0 || typeof res0 !== 'object') return 'ok';        // unknown: the server judges
  let short = shortfall(cond, res0);
  if (!short.length) return 'ok';
  const never = short.find((x) => x.k === 'gold' || x.rate <= 0 || (x.max > 0 && x.need > x.max));
  if (never) {
    const why = never.k === 'gold' ? '' : never.max > 0 && never.need > never.max
      ? ` — more ${never.k} than the city can hold (${fmt(never.max)})` : ` — and ${never.k} is not going up`;
    return { fail: `short of ${shortText(short)}${why}` };
  }
  const eta = Math.max(...short.map((x) => ((x.need - x.have) / x.rate) * 3600));
  if (env.dryRun) { env.log(`  short of ${shortText(short)} — [dry run] would wait about ${dur(eta)} for it`); return 'ok'; }
  env.log(`  short of ${shortText(short)} — waiting about ${dur(eta)} for it (Stop ends the wait)`);
  const until = Date.now() + eta * 1000;
  for (;;) {
    await env.pause(Math.max(1, Math.min(t.recheck, until - Date.now())));
    if (env.stopped()) return 'stopped';
    short = shortfall(cond, env.castle.resource);
    if (!short.length) return 'ok';
    if (Date.now() >= until) { env.log('  it should be there by now — trying'); return 'ok'; }
  }
}

// After the server said yes: wait for the job on that plot to finish, from the
// pushes (server.BuildComplate, which session.js applies to the castle).
//   from: the level before; dir: 'up' | 'down'; timeSec: the job's time, if known
async function waitDone(env, pos, { from, dir, timeSec }) {
  const t = T(env);
  const start = Date.now();
  let seen = false, until = timeSec ? start + timeSec * 1000 + t.grace : start + t.push;
  const landed = (b) => (dir === 'up' ? !!b && n(b.status) === 0 && n(b.level) > from : !b || (n(b.status) === 0 && n(b.level) < from));
  let told = false;
  for (;;) {
    const b = beanAt(env.castle, pos);
    const s = b ? n(b.status) : 0;
    if (b && (s === 1 || s === 2)) {
      seen = true;
      if (n(b.endTime) > 0) until = Date.now() + Math.max(0, n(b.endTime) - env.game.now()) + t.grace;
      if (!told) { env.log(`  waiting for it to finish (${dur(Math.max(0, n(b.endTime) - env.game.now()) / 1000)}; /nowait skips this)`); told = true; }
    } else if (landed(b)) return 'done';
    else if (seen) return 'done';
    if (Date.now() >= until) {
      env.log(seen ? '  no word that it finished — carrying on' : '  saw no sign of the job on that plot — carrying on');
      return 'timeout';
    }
    if (env.stopped()) return 'stopped';
    await env.pause(Math.max(1, Math.min(t.poll, until - Date.now())));
    if (env.stopped()) return 'stopped';
  }
}

// ------------------------------------------------------------------ buildings: parsing

// levelX | le X | lowestlevel[X] | lo [X] | highestlevel[X] | hi [X]
const POLICY = { level: 'level', le: 'level', lowestlevel: 'lowest', lowest: 'lowest', lo: 'lowest', highestlevel: 'highest', highest: 'highest', hi: 'highest' };
const isPolicyWord = (w) => { const m = /^([a-z]+?)(\d+)?$/i.exec(unbang(w || '')); return !!(m && POLICY[m[1].toLowerCase()]); };

// A building word, one or two words long ("iron mine", "feasting hall"). The
// second word joins only when the two read as one building and it is not a
// policy (upgrade c lo), `any` or `at`.
function buildingIn(ws, i) {
  // feasting_hall and Feasting-Hall read as before (the old build dropped such marks)
  const a = unbang(ws[i] || '').replace(/[_-]/g, ''), b = String(ws[i + 1] || '').replace(/[_-]/g, '');
  if (/^[a-z]+$/i.test(a) && /^[a-z]+$/i.test(b) && !isPolicyWord(b) && !['any', 'at'].includes(lc(b))) {
    const two = W.buildingByWord(a + b);
    if (two) return { b: two, used: 2 };
  }
  const one = /^[a-z]+$/i.test(a) ? W.buildingByWord(a) : null;
  return one ? { b: one, used: 1 } : null;
}
function policyIn(ws, i, cmd) {
  const m = /^([a-z]+?)(\d+)?$/i.exec(unbang(ws[i] || ''));
  const kind = m && POLICY[m[1].toLowerCase()];
  if (!kind) return null;
  let level = m[2] ? +m[2] : null, used = 1;
  if (level === null && /^\d+$/.test(String(ws[i + 1] || ''))) { level = +ws[i + 1]; used = 2; }
  if (kind === 'level' && level === null) throw new Error(`${cmd}: level needs the level with it — level9, or le 9`);
  if (level !== null && (level < 1 || level > 10)) throw new Error(`${cmd}: ${ws[i]}${used === 2 ? ' ' + ws[i + 1] : ''} — levels are 1 to 10`);
  return { policy: { kind, level }, used };
}

// @20 | at 20 (| a bare 20 when `bare`)
function plotIn(ws, i, bare) {
  const w = String(ws[i] || '');
  let m = /^@(-?\d+)$/.exec(w);
  if (m) return { pos: +m[1], used: 1 };
  if (lc(w) === 'at' && /^-?\d+$/.test(String(ws[i + 1] || ''))) return { pos: +ws[i + 1], used: 2 };
  if (lc(w) === '@' && /^-?\d+$/.test(String(ws[i + 1] || ''))) return { pos: +ws[i + 1], used: 2 };
  m = bare ? /^-?\d+$/.exec(w) : null;
  if (m) return { pos: +w, used: 1 };
  return null;
}

// NEAT's `build c:10:9` and `research lo:5` are goal lines: script-cmd-goals.js
// takes them (it checks the goal at load time).
function goalLine(word, args) {
  let G = null;
  try { G = require('./script-cmd-goals'); } catch { G = null; }
  const text = `${word} ${String(args || '').trim()}`;
  if (!G || typeof G.goalAction !== 'function') {
    throw new Error(`${word}: "${text}" is NEAT's ${word} goal, and goal lines need script-cmd-goals.js, which did not load`);
  }
  return G.goalAction(text, word);
}
const looksLikeGoal = (ws) => ws.some((w) => !w.startsWith('/') && (w.includes(':') || w.startsWith('?')));

// The Town Hall (type 31, plot -1) and the Walls (type 32, plot -2) are never
// demolished: the client has no Destruct button for either
// (BuildingInfoWin.as:1324-1330), and a city without its Town Hall is lost.
const FIXED_TYPE = { [C.TOWN_HALL]: 'the Town Hall', [C.WALLS_TYPE]: 'the Walls' };
const FIXED_PLOT = { [-1]: 'the Town Hall', [-2]: 'the Walls' };
const isFixed = (b) => !!(b && (FIXED_TYPE[n(b.typeId)] || FIXED_PLOT[n(b.positionId)]));
const neverDemolished = (cmd, what, pos) => `${cmd}: ${what}${pos !== null ? ` (plot ${pos})` : ''} ${what === 'the Walls' ? 'are' : 'is'}`
  + ' never demolished — the game has no Destruct for it, and a script will not send one';

// create / build / upgrade / demo / demosite -> { building, at, policy, any, speedup, nowait, dynamite }
function parseConstruction(word, args) {
  const cmd = word;
  const allowed = { create: ['speedup', 'nowait'], build: ['speedup', 'nowait'], upgrade: ['speedup', 'nowait'],
    demo: ['dynamite', 'speedup', 'nowait'], demosite: ['dynamite', 'speedup', 'nowait'] }[cmd];
  const { sw, rest } = takeSwitches(words(args), allowed, cmd);
  // each word keeps its own cmd (build runs create's code, demosite demo's)
  const out = { cmd, at: null, policy: null };
  if (cmd === 'build') out.quick = true;
  if (sw.speedup !== undefined) out.speedup = speedupList(sw.speedup, cmd);
  if (sw.nowait) out.nowait = true;
  if (sw.dynamite) out.dynamite = true;

  if (cmd === 'demosite') {
    if (rest.length !== 1 || !/^-?\d+$/.test(rest[0].replace(/^@/, ''))) throw new Error('demosite: usage  demosite [/dynamite] <plot>   e.g. demosite 36');
    const pos = +rest[0].replace(/^@/, '');
    if (FIXED_PLOT[pos]) throw new Error(neverDemolished('demosite', FIXED_PLOT[pos], pos));
    return { ...out, any: true, anyLevel: true, at: pos };
  }
  const usage = {
    create: 'create <type> [plot]   e.g. create cottage, create a 0, create embassy 2',
    build: 'build <type> [at <plot>]   e.g. build cottage at 12',
    upgrade: 'upgrade <type> [level9 | lowestlevel 5 | highestlevel] [at <plot>]   e.g. upgrade iron',
    demo: 'demo <type | any> [level10 | lowestlevel | highestlevel] [@plot]   e.g. demo cottage, demo any @15',
  }[cmd];
  // NEAT's bare `upgrade` (the Loop and Repeat pages: `upgrade` + `repeat` takes
  // every building and field to level 9): the lowest one the city can upgrade now
  if (cmd === 'upgrade' && !rest.length) return { ...out, any: true };
  if (!rest.length) throw new Error(`${cmd}: usage  ${usage}`);
  let i = 0;
  if (cmd === 'demo' && lc(rest[0]) === 'any') { out.any = true; i = 1; }
  else {
    const hit = buildingIn(rest, 0);
    if (!hit) throw new Error(`${cmd}: unknown building "${rest[0]}" — NEAT's a b be c e fh fo f s q i inn m r rs st t w wh ws, or names like cottage, barrack, iron mine`);
    out.building = hit.b;
    i = hit.used;
  }
  while (i < rest.length) {
    const p = plotIn(rest, i, cmd === 'create');
    if (p) {
      if (out.at !== null) throw new Error(`${cmd}: one plot per line`);
      out.at = p.pos; i += p.used; continue;
    }
    if (cmd === 'upgrade' || cmd === 'demo') {
      const q = policyIn(rest, i, cmd);
      if (q) {
        if (out.policy) throw new Error(`${cmd}: one level policy per line`);
        out.policy = q.policy; i += q.used; continue;
      }
    }
    throw new Error(`${cmd}: unexpected "${rest[i]}" — usage  ${usage}`);
  }
  if (out.any && out.at === null) throw new Error('demo any: say which plot — demo any @15');
  if (cmd === 'demo') {
    if (out.building && FIXED_TYPE[out.building.typeId]) throw new Error(neverDemolished('demo', FIXED_TYPE[out.building.typeId], null));
    if (out.at !== null && FIXED_PLOT[out.at]) throw new Error(neverDemolished('demo', FIXED_PLOT[out.at], out.at));
  }
  if (cmd === 'create' && out.building && (out.building.typeId === C.TOWN_HALL || out.building.typeId === C.WALLS_TYPE) && out.at !== null) {
    throw new Error(`create: the ${out.building.name} has its own place — write create ${lc(out.building.name).replace(/ /g, '')}`);
  }
  return out;
}

// ------------------------------------------------------------------ buildings: running

// Before a doomed build or upgrade: with autoReq, queue what it is missing.
async function fixPrereqs(env, castle, cid, missing, kind) {
  const game = env.game;
  for (const m of missing.filter((x) => x.kind === 'building')) {
    const name = (C.BUILDING_BY_ID[m.typeId] || {}).name;
    const spot = game.findBuildings(castle, m.typeId)[0];
    if (kind === 'build') {
      if (!spot) { env.log(`    cannot auto-fix: no ${name} in this city to upgrade`); continue; }
      if (env.dryRun) { env.log(`    [dry run] would upgrade ${name} at pos ${spot.positionId}`); continue; }
      const ur = await game.upgradeBuilding(cid, spot.positionId);
      env.log(`    queued upgrade of ${name} (pos ${spot.positionId}) -> ${env.say(ur)}`);
    } else {
      if (!spot) { env.log('    cannot auto-fix: prerequisite building not present'); continue; }
      if (env.dryRun) { env.log(`    [dry run] would upgrade ${name}`); continue; }
      const ur = await game.upgradeBuilding(cid, spot.positionId);
      env.log(`    queued upgrade of ${name} -> ${env.say(ur)}`);
    }
  }
}

const stoppedOut = () => ({ ok: false, error: 'stopped', end: true });

// After a job has started: its free speed-up, the listed speed-ups, and the
// wait for it to end.
async function afterStart(env, a, job, { from, dir, timeSec, preset }) {
  job.preset = preset || null;
  if (preset) await freeFinish(env, job, preset);
  if (a.speedup && a.speedup.length) await applySpeedups(env, job, a.speedup);
  if (a.quick || a.nowait || env.dryRun) return 'sent';
  return waitDone(env, job.pos, { from, dir, timeSec });
}

// create (and OTTObot's build): a new building. env.game is read again after
// every wait: a reconnect during one leaves the Game read before it closed.
async function runCreate(a, env) {
  const def = a.building;
  const fixed = def.typeId === C.TOWN_HALL ? -1 : def.typeId === C.WALLS_TYPE ? -2 : null;
  if (fixed !== null) {
    const there = beanAt(env.castle, fixed);
    if (there) return fail(env, `the ${def.name} already stands (level ${n(there.level)}) — upgrade ${lc(def.name).replace(/ /g, '')}`);
  }
  if (!a.quick && (await waitBuilder(env)) === 'stopped') return stoppedOut();

  const game = env.game;
  const castle = env.castle;
  const cid = env.cid;
  // explain prerequisites BEFORE spending a round trip on a doomed build
  const cond = await game.buildConditions(cid, def.typeId).catch(() => null);   // castle.getAvailableBuildingBean (CastleCommands.as:116-127)
  if (cond) env.log(`  ${def.name}: costs ${['wood', 'stone', 'iron', 'food'].map((k) => `${k} ${fmt(cond[k])}`).join(', ')}, ${cond.time}s`);
  const missing = unmetOf(cond, game);
  if (missing.length) {
    const why = `BLOCKED - needs ${missing.map((m) => m.text).join('; ')}`;
    env.log('  ' + why);
    if (env.opts.autoReq) {
      await fixPrereqs(env, castle, cid, missing, 'build');
      env.log('    prerequisite queued - re-run this line once it finishes');
    }
    return { ok: false, error: why };
  }
  if (!a.quick) {
    const w = await waitResources(env, cond);
    if (w === 'stopped') return stoppedOut();
    if (w && w.fail) return fail(env, w.fail);
  }

  let pos = fixed ?? a.at;
  if (pos !== null && pos !== undefined && fixed === null) {
    const there = beanAt(env.castle, pos);
    if (there) return fail(env, `plot ${pos} is taken: ${bLabel(there)}`);
  }
  if (pos === null || pos === undefined) {
    pos = env.game.freeSlot(env.castle, !!def.outside);
    if ((pos === null || pos === undefined) && !a.quick && !env.dryRun) {
      const t = T(env);
      env.log(`  no free ${def.outside ? 'field' : 'city'} plot — looking again every ${dur(t.recheck / 1000)} for ${dur(t.plotWait / 1000)} (Stop ends the wait)`);
      const until = Date.now() + t.plotWait;
      while ((pos === null || pos === undefined) && Date.now() < until) {
        await env.pause(Math.max(1, Math.min(t.recheck, until - Date.now())));
        if (env.stopped()) return stoppedOut();
        pos = env.game.freeSlot(env.castle, !!def.outside);
      }
    }
    if (pos === null || pos === undefined) {
      return fail(env, `no free ${def.outside ? 'field' : 'city'} plot${a.quick ? ' - specify one with "at N"' : ''}`);
    }
  }
  env.log(`  build ${def.name} (type ${def.typeId}) at position ${pos}`);
  if (env.dryRun) {
    await afterStart(env, a, { kind: 'building', pos, label: `${def.name} on plot ${pos}` }, { preset: freePreset('building', def.typeId, 0) });
    env.log('  [dry run] not sent');
    return {};
  }
  const r = await env.game.newBuilding(env.cid, pos, def.typeId);    // castle.newBuilding (CastleCommands.as:241-253)
  env.log('  -> ' + env.say(r));
  if (!r || r.ok !== 1) return { done: 1 };
  const how = await afterStart(env, a, { kind: 'building', pos, label: `${def.name} on plot ${pos}` },
    { from: 0, dir: 'up', timeSec: cond && n(cond.time), preset: freePreset('building', def.typeId, 0) });
  // create: $result is the plot; OTTObot's build keeps what it logged
  return { done: 1, ok: true, ...(a.quick ? {} : { result: pos }), end: how === 'stopped' };
}

// Which building an upgrade takes. -> { spot } | { why }. busyOk: before the
// wait for the builder, a building under way counts (its job ends first).
function pickUpgrade(castle, a, busyOk = false) {
  const def = a.building;
  const all = standing(castle).filter((b) => n(b.typeId) === def.typeId);
  if (!all.length) return { why: `no ${def.name} in ${castle.name}` };
  if (a.at !== null) {
    const b = all.find((x) => n(x.positionId) === a.at);
    if (!b) return { why: `no ${def.name} on plot ${a.at} in ${castle.name}` };
    return { spot: b };
  }
  const idle = busyOk ? all : all.filter((b) => n(b.status) !== 1 && n(b.status) !== 2);
  const p = a.policy;
  let list, top;
  if (!p) { top = 9; list = idle.filter((b) => n(b.level) < 9).sort((x, y) => n(x.level) - n(y.level)); }
  else if (p.kind === 'level') {
    const at = p.level >= 10 ? 9 : p.level;
    top = 10;
    list = idle.filter((b) => n(b.level) === at);
  } else if (p.kind === 'lowest') {
    top = Math.min(p.level ?? 9, 9);
    list = idle.filter((b) => n(b.level) < top).sort((x, y) => n(x.level) - n(y.level));
  } else {
    top = p.level ?? 10;
    list = idle.filter((b) => n(b.level) < top).sort((x, y) => n(y.level) - n(x.level));
  }
  if (list.length) return { spot: list[0] };
  const levels = all.map((b) => n(b.level)).sort((x, y) => x - y).join(', ');
  if (!p) {
    return { why: `every ${def.name} is at level 9 or higher (${levels}) — upgrade ${lc(def.name).replace(/ /g, '')} level9 takes one to 10 with a Michelangelo's Script` };
  }
  if (p.kind === 'level') return { why: `no ${def.name} at level ${p.level >= 10 ? 9 : p.level} to upgrade (levels ${levels})` };
  return { why: `no ${def.name} below level ${top} to upgrade (levels ${levels})` };
}

// Level 9 -> 10 spends a Michelangelo's Script: only with a policy that asks for
// it (NEAT: "you must specify level9"; highestlevel and level10 do too), and
// with one held — never bought. -> null, or why not.
function tenWhy(env, spot, a) {
  if (n(spot.level) < 9) return null;
  if (n(spot.level) >= 10) return `${bLabel(spot)} is at the top level`;
  const p = a.policy;
  if (!(p && (p.kind === 'highest' || (p.kind === 'level' && p.level >= 9)))) {
    return `${bLabel(spot)} would go to 10, which spends a Michelangelo's Script — write level9, level10 or highestlevel on the line to allow it`;
  }
  if (heldCount(env.game, SCRIPT_ITEM) === 0) return `${bLabel(spot)} needs a Michelangelo's Script (${SCRIPT_ITEM}) to reach 10 — none held, and it is never bought`;
  return null;
}

// Bare `upgrade`: any building or field below level 9, lowest first, whose
// prerequisites are met (castle.checkOutUpgrade, at most UPGRADE_ANY_CHECKS of
// them); that one then goes through the named upgrade below.
const UPGRADE_ANY_CHECKS = 8;
async function runUpgradeAny(a, env) {
  const below = (busyOk) => standing(env.castle)
    .filter((b) => n(b.level) < 9 && (busyOk || (n(b.status) !== 1 && n(b.status) !== 2)))
    .sort((x, y) => n(x.level) - n(y.level) || n(x.positionId) - n(y.positionId));
  if (!below(true).length) return fail(env, `every building in ${env.castle.name} is at level 9 or higher — name one with level9 to take it to 10`);
  if ((await waitBuilder(env)) === 'stopped') return stoppedOut();
  const game = env.game;
  let checked = 0;
  for (const spot of below(false)) {
    if (checked >= UPGRADE_ANY_CHECKS) break;
    checked++;
    const chk = await game.checkUpgrade(env.cid, spot.positionId).catch(() => null);   // castle.checkOutUpgrade (CastleCommands.as:103-114)
    if (chk && chk.ok !== 1) continue;
    if (unmetOf(chk && (chk.conditionBean || chk.condition), game).length) continue;
    const def = C.BUILDING_BY_ID[n(spot.typeId)] || { typeId: n(spot.typeId), name: bName(spot) };
    return runUpgrade({ ...a, any: false, building: def, at: n(spot.positionId) }, env);
  }
  return fail(env, `nothing in ${env.castle.name} can be upgraded now — the ${checked} lowest building(s) below level 9 lack a building or tech they need`);
}

async function runUpgrade(a, env) {
  if (a.any) return runUpgradeAny(a, env);
  // before waiting on the builder: is there anything this line may upgrade?
  let pick = pickUpgrade(env.castle, a, true);
  if (pick.why) return fail(env, pick.why);
  let why = tenWhy(env, pick.spot, a);
  if (why) return fail(env, why);
  if ((await waitBuilder(env)) === 'stopped') return stoppedOut();
  // the wait may have changed things: pick again, from those not under way
  pick = pickUpgrade(env.castle, a);
  if (pick.why) return fail(env, pick.why);
  const spot = pick.spot;
  why = tenWhy(env, spot, a);
  if (why) return fail(env, why);
  const game = env.game;              // read after the wait: it follows a reconnect
  const castle = env.castle;
  const cid = env.cid;

  const chk = await game.checkUpgrade(cid, spot.positionId).catch(() => null);   // castle.checkOutUpgrade (CastleCommands.as:103-114)
  if (chk && chk.ok !== 1) { const why2 = `BLOCKED - ${env.say(chk)}`; env.log('  ' + why2); return { ok: false, error: why2 }; }
  const cond = chk && (chk.conditionBean || chk.condition);
  if (n(spot.level) === 9) {
    // the inventory decides when it is loaded; when not, the check-out must list the Script as there
    const held = heldCount(game, SCRIPT_ITEM);
    const listed = cond && (cond.items || []).find((it) => it && it.id === SCRIPT_ITEM);
    if (held === null && !(listed && listed.successFlag)) {
      return fail(env, `${bLabel(spot)} -> 10 spends a Michelangelo's Script, and neither the inventory nor the game's check says one is held — not sent`);
    }
    env.log(`  ${bLabel(spot)} -> 10 spends a Michelangelo's Script${held === null ? '' : ` (${fmt(held)} held)`}`);
  }
  const missing = unmetOf(cond, game);
  if (missing.length) {
    const why = `BLOCKED - needs ${missing.map((m) => m.text).join('; ')}`;
    env.log('  ' + why);
    if (env.opts.autoReq) await fixPrereqs(env, castle, cid, missing, 'upgrade');
    return { ok: false, error: why };
  }
  const w = await waitResources(env, cond);
  if (w === 'stopped') return stoppedOut();
  if (w && w.fail) return fail(env, w.fail);

  const from = n(spot.level);
  env.log(`  upgrade ${a.building.name} at position ${spot.positionId} (level ${spot.level ?? '?'})`);
  const job = { kind: 'building', pos: n(spot.positionId), label: `${a.building.name} on plot ${spot.positionId}` };
  const preset = freePreset('building', a.building.typeId, from);
  if (env.dryRun) { await afterStart(env, a, job, { preset }); env.log('  [dry run] not sent'); return {}; }
  const r = await env.game.upgradeBuilding(env.cid, spot.positionId);  // castle.upgradeBuilding (CastleCommands.as:215-226)
  env.log('  -> ' + env.say(r));
  if (!r || r.ok !== 1) return { done: 1 };
  const how = await afterStart(env, a, job, { from, dir: 'up', timeSec: cond && n(cond.time), preset });
  return { done: 1, ok: true, end: how === 'stopped' };          // $result: what it logged, as before
}

// Which building a demolition takes. -> { spot } | { why }. busyOk as pickUpgrade.
function pickDemo(castle, a, busyOk = false) {
  const tall = (b) => n(b.level) >= 10;
  const allowTen = a.anyLevel || (a.policy && a.policy.level === 10);
  // with or without /dynamite, however the action was made
  if (a.building && FIXED_TYPE[n(a.building.typeId)]) return { why: neverDemolished('demo', FIXED_TYPE[n(a.building.typeId)], null) };
  if (a.at !== null && a.at !== undefined && FIXED_PLOT[n(a.at)]) return { why: neverDemolished('demo', FIXED_PLOT[n(a.at)], n(a.at)) };
  if (a.at !== null) {
    const b = beanAt(castle, a.at);
    if (!b) return { why: `nothing stands on plot ${a.at} in ${castle.name}` };
    if (isFixed(b)) return { why: neverDemolished('demo', FIXED_TYPE[n(b.typeId)] || FIXED_PLOT[n(b.positionId)], n(b.positionId)) };
    if (!a.any && n(b.typeId) !== a.building.typeId) return { why: `plot ${a.at} holds ${bLabel(b)}, not a ${a.building.name} — demo any @${a.at} takes whatever is there` };
    if (tall(b) && !allowTen) return { why: `${bLabel(b)} is level 10 — only demo ... level10 or highestlevel 10 takes a level-10 building down` };
    return { spot: b };
  }
  const def = a.building;
  const all = standing(castle).filter((b) => n(b.typeId) === def.typeId);
  if (!all.length) return { why: `no ${def.name} in ${castle.name}` };
  const idle = busyOk ? all : all.filter((b) => n(b.status) !== 1 && n(b.status) !== 2);
  const p = a.policy;
  let list;
  if (!p) list = idle.filter((b) => !tall(b)).sort((x, y) => n(x.level) - n(y.level));
  else if (p.kind === 'level') list = idle.filter((b) => n(b.level) === p.level);
  else {
    const top = p.level ?? 9;
    list = idle.filter((b) => n(b.level) <= top).sort((x, y) => (p.kind === 'lowest' ? n(x.level) - n(y.level) : n(y.level) - n(x.level)));
  }
  if (list.length) return { spot: list[0] };
  const levels = all.map((b) => n(b.level)).sort((x, y) => x - y).join(', ');
  if (!p && all.every(tall)) return { why: `every ${def.name} is level 10 — only level10 or highestlevel 10 takes one down` };
  return { why: `no ${def.name} fits (levels ${levels})` };
}

async function runDemo(a, env) {
  let pick = pickDemo(env.castle, a, true);
  if (pick.why) return fail(env, pick.why);
  const dynamiteWhy = () => {
    const why = notHeld(env, DYNAMITE, 'Dynamite');
    return why ? `${why}; without /dynamite one level comes down` : null;
  };
  if (a.dynamite && dynamiteWhy()) return fail(env, dynamiteWhy());
  if ((await waitBuilder(env)) === 'stopped') return stoppedOut();
  pick = pickDemo(env.castle, a);
  if (pick.why) return fail(env, pick.why);
  if (!env.dryRun && (n(pick.spot.status) === 1 || n(pick.spot.status) === 2)) return fail(env, `${bLabel(pick.spot)} is under construction`);
  if (a.dynamite && dynamiteWhy()) return fail(env, dynamiteWhy());
  const spot = pick.spot;
  const game = env.game;              // read after the wait: it follows a reconnect
  const cid = env.cid;
  const from = n(spot.level);
  const pos = n(spot.positionId);
  env.log(`  demolish ${bLabel(spot)}: ${a.dynamite ? 'all of it, with Dynamite' : `one level, to ${from - 1}`}`);
  const job = { kind: 'building', pos, label: `${bName(spot)} on plot ${pos}` };
  if (env.dryRun) {
    if (a.dynamite) env.log(`  then Dynamite (${DYNAMITE}) finishes it — [dry run] not sent`);
    if (a.speedup) await applySpeedups(env, job, a.speedup);
    env.log('  [dry run] not sent');
    return {};
  }
  const r = await game.destructBuilding(cid, pos);                      // castle.destructBuilding (CastleCommands.as:77-88)
  env.log('  -> ' + env.say(r));
  if (!r || r.ok !== 1) return { done: 1 };
  if (a.dynamite) {
    // DestrctChoiceWin.canDestruc (:478-488): the order, then Dynamite finishes it
    // with castle.speedUpBuildCommand (CastleCommands.as:175-187)
    const before = heldCount(game, DYNAMITE);
    const d = await speedBuild(game, cid, pos, DYNAMITE);
    env.log(`  Dynamite -> ${env.say(d)}`);
    if (d && d.ok === 1) {
      usedItem(env, DYNAMITE, before);
      await settle(env, () => buildingIdle(env.castle, pos));
    }
  }
  if (a.speedup && a.speedup.length) await applySpeedups(env, job, a.speedup);
  let how = 'sent';
  if (!a.nowait) how = await waitDone(env, pos, { from, dir: 'down', timeSec: null });
  return { done: 1, ok: !env.refused(), result: pos, end: how === 'stopped' };
}

// ------------------------------------------------------------------ research

async function researchBeans(env) {
  const r = await env.game.researchList(env.cid);                      // tech.getResearchList (TechCommand.as:42-52)
  if (typeof env.game.noteResearchList === 'function') { try { env.game.noteResearchList(env.cid, r); } catch { /* */ } }
  return { r, beans: (r && (r.acailableResearchBeans || r.availableResearchBeans)) || [] };   // sic, the server's spelling
}
const techName = (b) => (C.TECH_BY_ID[n(b.typeId)] || {}).name || b.name || `tech ${b.typeId}`;
const cityName = (game, cid) => { const c = (game.castles || []).find((x) => n(game.castleId(x)) === n(cid)); return c ? c.name : `city ${cid}`; };
// The tech this city is researching. The list marks one being researched with
// the city doing it (AvailableResearchListBean.castleId).
const runningHere = (beans, cid) => beans.find((b) => b.upgradeing && (b.castleId === undefined || b.castleId === null || n(b.castleId) === n(cid))) || null;
// What the client needs before its Research button lights (TechItemUI.onConditionTime):
// permition, every building/tech/item condition, and the resources.
function researchable(b, res, game) {
  if (!b || !b.permition || b.upgradeing) return false;
  if (b.avalevel !== undefined && n(b.level) >= n(b.avalevel)) return false;
  if (unmetOf(b.conditionBean, game).length) return false;
  return !shortfall(b.conditionBean, res).length;
}
const costOf = (cond) => ['food', 'wood', 'stone', 'iron', 'gold'].reduce((s, k) => s + n(cond && cond[k]), 0);

// Until the city's research ends: its server.ResearchCompleteUpdate push
// {castleId} (ResearchCompleteUpdate.as), or its end time.
async function waitResearch(env, bean, what = 'it') {
  const t = T(env);
  const game = env.game;
  const cid = env.cid;
  let done = false;
  const on = (cmd, data) => { if (cmd === 'server.ResearchCompleteUpdate' && data && n(data.castleId) === n(cid)) done = true; };
  const c = game.c;
  if (c && typeof c.on === 'function') c.on('cmd', on);
  try {
    const left = n(bean && bean.endTime) > 0 ? Math.max(0, n(bean.endTime) - game.now()) : null;
    const until = Date.now() + (left === null ? t.push : left + t.grace);
    if (left !== null) env.log(`  waiting for ${what} to finish (${dur(left / 1000)})`);
    while (!done && Date.now() < until) {
      if (env.stopped()) return 'stopped';
      await env.pause(Math.max(1, Math.min(t.poll, until - Date.now())));
      if (env.stopped()) return 'stopped';
    }
    return done ? 'done' : 'timeout';
  } finally { if (c && typeof c.off === 'function') c.off('cmd', on); }
}

function parseResearchTech(word, rest) {
  const text = rest.join(' ');
  const pick = lc(rest.join(''));
  if (['quickest', 'cheapest', 'dearest'].includes(pick)) return { pick };
  const t = W.techByWord(pick.replace(/[^a-z]/g, ''));
  if (!t) {
    throw new Error(`${word}: unknown tech "${text}" — NEAT's ag lu mas mi met in ms mt ir lo com ho ar st med con en mac pr, the names`
      + `${word === 'startresearch' ? ', or quickest, cheapest, dearest' : ''}`);
  }
  return { tech: t };
}

async function runStartResearch(a, env) {
  let game = env.game;
  let { beans } = await researchBeans(env);
  if (!beans.length) return fail(env, `no research list for ${env.castle.name} — is there an Academy?`);
  // one research at a time in a city: wait for the one running
  let cur = runningHere(beans, env.cid);
  if (cur) {
    if (a.tech && n(cur.typeId) === a.tech.typeId && n(cur.castleId || env.cid) === n(env.cid)) {
      return fail(env, `${env.castle.name} is already researching ${techName(cur)}`);
    }
    if (env.dryRun) env.log(`  ${env.castle.name} is researching ${techName(cur)} — [dry run] would wait for it`);
    else {
      const w = await waitResearch(env, cur, `${techName(cur)} (running)`);
      if (w === 'stopped') return stoppedOut();
      game = env.game;                // read after the wait: it follows a reconnect
      forget(game, 'research:');
      ({ beans } = await researchBeans(env));
      cur = runningHere(beans, env.cid);
      if (cur) return fail(env, `${env.castle.name} is still researching ${techName(cur)}`);
    }
  }
  const res = env.castle.resource;
  let bean;
  if (a.pick) {
    const ok = beans.filter((b) => researchable(b, res, game));
    if (!ok.length) return fail(env, `nothing can be researched in ${env.castle.name} right now (checkresearch lists what can)`);
    const key = a.pick === 'quickest' ? (b) => n(b.conditionBean && b.conditionBean.time) : (b) => costOf(b.conditionBean);
    ok.sort((x, y) => (a.pick === 'dearest' ? key(y) - key(x) : key(x) - key(y)));
    bean = ok[0];
    env.log(`  ${a.pick}: ${techName(bean)} ${n(bean.level)} -> ${n(bean.level) + 1}`);
  } else {
    bean = beans.find((b) => n(b.typeId) === a.tech.typeId);
    if (!bean) return fail(env, `${a.tech.name} is not on ${env.castle.name}'s research list`);
    if (bean.upgradeing) return fail(env, `${a.tech.name} is being researched in ${cityName(game, bean.castleId)}`);
    if (bean.avalevel !== undefined && n(bean.level) >= n(bean.avalevel)) {
      return fail(env, `${a.tech.name} is at level ${n(bean.level)}, the most the Academy allows now (${n(bean.avalevel)})`);
    }
    const missing = unmetOf(bean.conditionBean, game);
    if (missing.length) return fail(env, `BLOCKED - ${a.tech.name} needs ${missing.map((m) => m.text).join('; ')}`);
    if (bean.permition === false) return fail(env, `${a.tech.name} cannot be researched in ${env.castle.name} yet`);
    const w = await waitResources(env, bean.conditionBean);
    if (w === 'stopped') return stoppedOut();
    if (w && w.fail) return fail(env, w.fail);
  }
  const name = techName(bean);
  const from = n(bean.level);
  env.log(`  research ${name} ${from} -> ${from + 1} (tech ${bean.typeId}) in ${env.castle.name}`);
  const preset = freePreset('research', bean.typeId, from);
  const job = { kind: 'research', label: `${name} research`, preset };
  if (env.dryRun) { await freeFinish(env, job, preset); if (a.speedup) await applySpeedups(env, job, a.speedup); env.log('  [dry run] not sent'); return {}; }
  game = env.game;                    // after waitResources
  const r = await game.research(env.cid, n(bean.typeId));               // tech.research (TechCommand.as:54-65)
  env.log('  -> ' + env.say(r));
  forget(game, 'research:');
  if (!r || r.ok !== 1) return { done: 1 };
  await freeFinish(env, job, preset);
  if (a.speedup && a.speedup.length) await applySpeedups(env, job, a.speedup);
  let how = 'sent';
  if (!a.nowait && !job.finished) {
    // the newest end time: a speed-up's reply (ResearchResponse.tech), else the research reply's
    let tech = job.tech || (r.tech && typeof r.tech === 'object' ? r.tech : null);
    if (!tech || !n(tech.endTime)) { const again = await researchBeans(env); tech = runningHere(again.beans, env.cid); }
    if (tech) how = await waitResearch(env, tech, `${name}`);
    forget(env.game, 'research:');
  }
  return { done: 1, ok: true, result: name, end: how === 'stopped' };
}

// ------------------------------------------------------------------ troops

function parseTrain(args, tok) {
  const ws = words(args);
  if (!ws.length) throw new Error('train: usage  train a:5000 [hero] [barracks | all | idle] [minimum]   or  train a 5000');
  if (lc(ws[0]) === 'help' && ws.length === 1) return { cmd: 'train', help: true };
  if (ws[0].includes(':')) {
    const troops = W.parseTroops(ws[0]);
    const keys = Object.keys(troops);
    if (keys.length !== 1) throw new Error('train: troop types cannot be combined — one train line per type (train a:5000, then train w:25k)');
    const troop = C.BY_KEY[keys[0]];
    const amount = troops[keys[0]];
    const rest = ws.slice(1);
    let i = 0, hero = null, barracks = 'all', min = null;
    const isBar = (w) => ['all', 'idle'].includes(lc(w)) || /^\d+$/.test(String(w));
    if (rest[i] !== undefined && !isBar(rest[i]) && !isNum(rest[i])) hero = rest[i++];
    if (rest[i] !== undefined && isBar(rest[i])) {
      const w = lc(rest[i++]);
      if (w === 'all' || w === 'idle') barracks = w;
      else {
        const pos = +w;
        if (pos < 0 || pos > C.SLOTS.insideTo) {
          throw new Error(`train: ${w} is no barracks plot (0-${C.SLOTS.insideTo}) — to give a minimum, name the barracks first: train ${ws[0]} ${hero || 'any'} all ${w}`);
        }
        barracks = pos;
      }
    }
    if (rest[i] !== undefined && isNum(rest[i])) min = W.num(rest[i++]);
    if (i < rest.length) throw new Error(`train: unexpected "${rest[i]}" — usage  train a:5000 [hero] [barracks | all | idle] [minimum]`);
    if (min !== null && min > amount) throw new Error(`train: the minimum (${fmt(min)}) is more than the ${fmt(amount)} asked for`);
    return { cmd: 'train', neat: true, troop, amount, hero, barracks, min };
  }
  const t = C.BY_CODE[lc(tok[1])] || W.troopByWord(tok[1] || '');
  if (!t) throw new Error('train: unknown troop code ' + tok[1]);
  if (tok.length > 3) throw new Error(`train: ${tok[1]} ${tok[2]} takes nothing more — for a hero or barracks write NEAT's form: train ${t.code}:${tok[2]} atk idle`);
  return { cmd: 'train', troop: t, amount: W.num(tok[2] || '1') };
}

// How many of a troop the city can pay for and staff now (the enlist screen's
// checks, SWEnlist.troopEnlist). null when the city's resources are not known.
function trainable(castle, t) {
  const res = castle.resource;
  if (!res || typeof res !== 'object') return null;
  const idle = Math.max(0, n(res.curPopulation) - n(res.workPeople) - n(res.buildPeople));
  const byPop = t.pop > 0 ? Math.floor(idle / t.pop) : Infinity;
  let byRes = Infinity, tight = null;
  for (const k of RES_ORDER) {
    const c = n(t.cost && t.cost[k]);
    if (!c) continue;
    const m = Math.floor(amountOf(res, k) / c);
    if (m < byRes) { byRes = m; tight = k; }
  }
  const max = Math.max(0, Math.min(byPop, byRes));
  const why = byPop <= byRes ? `idle population ${fmt(idle)}` : `${tight} ${fmt(amountOf(res, tight))}`;
  return { max, why };
}

// The hero a train line names, as mayor while the order goes in. -> { hero, from } | null
function mayorFor(castle, spec) {
  if (!spec) return null;
  const heros = castle.heros || [];
  const mayor = heros.find((h) => n(h.status) === 1) || null;
  const home = heros.filter((h) => n(h.status) === 0 || n(h.status) === 1);
  let want;
  const s = lc(spec);
  if (s === 'any') {
    if (mayor) return null;
    want = heros.find((h) => n(h.status) === 0);
    if (!want) return null;
  } else if (s === 'atk') {
    want = home.slice().sort((x, y) => n(y.power) - n(x.power))[0];
    if (!want) throw new Error(`no hero in ${castle.name} to be mayor (atk)`);
  } else {
    want = heros.find((h) => lc(h.name) === s);
    if (!want) throw new Error(`no hero named "${spec}" in ${castle.name}`);
    if (!home.includes(want)) throw new Error(`${want.name} is not in ${castle.name} right now`);
  }
  if (mayor && want.id === mayor.id) return null;
  return { hero: want, from: mayor };
}

// hero.promoteToChief {castleId, heroId} (HeroCommand.as:127-137) goes straight
// over a sitting mayor, as the client does (CastleChief.onHireChief :377-390);
// hero.dischargeChief {castleId} (HeroCommand.as:104-113) only when the city had
// no mayor to put back.
async function appointMayor(env, h, why) {
  let r;
  try { r = await env.game.promoteToChief(env.cid, h.id); } catch (e) { r = { ok: 0, errorMsg: e.message }; }
  env.log(`  appoint ${h.name} as mayor${why} -> ${env.verdict(r)}`);
  return !!(r && r.ok === 1);
}
async function restoreMayor(env, swap) {
  if (swap.from) { await appointMayor(env, swap.from, ' again'); return; }
  let r;
  try { r = await env.game.dischargeChief(env.cid); } catch (e) { r = { ok: 0, errorMsg: e.message }; }
  env.log(`  ${swap.hero.name} steps down (the city had no mayor) -> ${env.verdict(r)}`);
}

async function runTrain(a, env) {
  const game = env.game;
  const castle = env.castle;
  if (a.help) {
    for (const l of [
      'train a:5000                  5,000 archers across all barracks, as many as res and idle population allow',
      'train w:25000 atk             with the best attack hero as mayor for the order (the old mayor comes back after)',
      'train a:999999 ace idle 20000 idle barracks only, Ace as mayor, at least 20,000 or nothing',
      'train w:25000 atk 18 25000    the barracks on plot 18, all 25,000 or nothing',
      'train a 10k                   OTTObot\'s form: exactly 10,000, into the first barracks',
    ]) env.log('  ' + l);
    return { ok: true, result: 'help' };
  }
  const t = a.troop;
  if (!a.neat) {
    env.log(`  train ${fmt(a.amount)} x ${t.name} (type ${t.typeId}) in ${castle.name}`);
    if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
    // a real barracks plot where the city lists its buildings (the old default, 4, otherwise)
    const bar = standing(castle).filter((b) => n(b.typeId) === BARRACKS).sort((x, y) => n(x.positionId) - n(y.positionId))[0];
    const r = await game.produceTroop(env.cid, t.typeId, a.amount, bar ? n(bar.positionId) : undefined);
    env.log('  -> ' + env.say(r));
    forget(game, 'troopq:');
    return { done: 1 };             // $result: what it logged, as it always was
  }

  const known = Array.isArray(castle.buildings);
  const bars = standing(castle).filter((b) => n(b.typeId) === BARRACKS);
  if (known && !bars.length) return fail(env, `no barracks in ${castle.name}`);
  if (typeof a.barracks === 'number' && known && !bars.some((b) => n(b.positionId) === a.barracks)) {
    return fail(env, `no barracks on plot ${a.barracks} in ${castle.name} — its barracks are on ${bars.map((b) => b.positionId).sort((x, y) => x - y).join(', ')}`);
  }
  let num = a.amount;
  const fit = trainable(castle, t);
  if (fit && fit.max < num) {
    if (a.min !== null && fit.max < a.min) return fail(env, `only ${fmt(fit.max)} ${t.name} fit (${fit.why}), fewer than the minimum ${fmt(a.min)} — nothing queued`);
    if (fit.max <= 0) return fail(env, `no ${t.name} fit (${fit.why})`);
    env.log(`  only ${fmt(fit.max)} of the ${fmt(num)} fit (${fit.why}) — training those`);
    num = fit.max;
  }
  const cid = env.cid;
  if (a.barracks === 'idle') {
    // SWEnlist.change_toIdle asks first (troop.checkIdleBarrack, TroopCommands.as:59-70)
    const chk = await game.req('troop.checkIdleBarrack', { castleId: cid, troopType: t.typeId });
    if (!chk || chk.ok !== 1) return fail(env, `no idle barracks in ${castle.name} for ${t.name}${chk && chk.errorMsg ? ' (' + chk.errorMsg + ')' : ''}`);
  }
  let swap;
  try { swap = mayorFor(castle, a.hero); } catch (e) { return fail(env, e.message); }
  // Barrack.doProduce (:789-805): every barracks is plot 0 shared, idle adds toIdle
  const share = a.barracks === 'all' || a.barracks === 'idle';
  const where = a.barracks === 'all' ? 'all barracks' : a.barracks === 'idle' ? 'idle barracks' : `the barracks on plot ${a.barracks}`;
  env.log(`  train ${fmt(num)} x ${t.name} (type ${t.typeId}) in ${where} of ${castle.name}${swap ? `, ${swap.hero.name} as mayor` : ''}`);
  if (env.dryRun) {
    if (swap) env.log(`  ${swap.hero.name} would be mayor for the order, then ${swap.from ? `${swap.from.name} mayor again` : 'step down (the city has no mayor)'}`);
    env.log('  [dry run] not sent');
    return {};
  }
  let r;
  // the old mayor comes back only if the swap took (else he never left)
  const appointed = swap ? await appointMayor(env, swap.hero, ' for the order') : false;
  if (swap && !appointed) env.log(`  training under the mayor there is${swap.from ? ` (${swap.from.name})` : ''}`);
  try {
    r = await game.req('troop.produceTroop', {                          // TroopCommands.as:86-101
      castleId: cid, positionId: share ? 0 : a.barracks, troopType: t.typeId, num, isShare: share, toIdle: a.barracks === 'idle',
    });
    env.log('  -> ' + env.say(r));
  } finally {
    if (appointed) await restoreMayor(env, swap);
    forget(game, 'troopq:');
  }
  return { done: 1 + (swap ? 1 : 0) + (appointed ? 1 : 0), result: r && r.ok === 1 ? num : 0 };
}

// A city's troops out on marches: every march that left from it, going,
// staying or coming home (engine.cityMarches' outward list).
function troopsOut(game, castle) {
  const out = {};
  for (const x of (game.player && game.player.selfArmys) || []) {
    const bean = x.raw || x;
    if (n(bean.startFieldId) !== n(castle.fieldId)) continue;
    for (const [k, v] of Object.entries(bean.troop || bean.troops || {})) {
      if (Number.isFinite(Number(v)) && Number(v) > 0) out[k] = (out[k] || 0) + Number(v);
    }
  }
  return out;
}

function troopList(ws, cmd) {
  const text = ws.join(',').replace(/,+/g, ',').replace(/^,|,$/g, '');
  if (!text) throw new Error(`${cmd}: which troops? e.g. w:25k,a:10k`);
  return W.parseTroops(text);
}

async function runDisband(a, env) {
  const game = env.game;
  const castle = env.castle;
  const home = castle.troop || {};
  const out = a.keep ? troopsOut(game, castle) : {};
  const plan = [];
  for (const [k, want] of Object.entries(a.troops)) {
    const t = C.BY_KEY[k];
    const have = n(home[k]);
    let drop;
    if (a.keep) {
      const total = have + n(out[k]);
      drop = Math.max(0, Math.min(have, total - want));
      env.log(`  keep ${fmt(want)} ${t.name}: ${fmt(have)} at home${n(out[k]) ? ` + ${fmt(out[k])} out on marches` : ''} = ${fmt(total)} -> disband ${fmt(drop)}`);
    } else {
      drop = Math.min(want, have);
      env.log(`  disband ${fmt(drop)} ${t.name}${drop < want ? ` (only ${fmt(have)} at home, of the ${fmt(want)} asked)` : ''}`);
    }
    if (drop > 0) plan.push({ t, drop });
  }
  if (!plan.length) { env.log('  nothing to disband'); return { ok: true, result: 0 }; }
  if (env.dryRun) { env.log(`  [dry run] not sent — ${plan.map((p) => `${fmt(p.drop)} ${p.t.name}`).join(', ')} would be dismissed for good`); return {}; }
  let total = 0, done = 0;
  for (const p of plan) {
    const r = await game.disbandTroop(env.cid, p.t.typeId, p.drop);   // TroopCommands.as:72-84; "Dismiss armies" may want the security code
    done++;
    env.log(`  disband ${fmt(p.drop)} ${p.t.name} -> ${env.say(r)}`);
    if (r && r.ok === 1) total += p.drop;
  }
  forget(game, 'troopq:');
  return { done, result: total };
}

async function runDumpTroop(a, env) {
  const game = env.game;
  const castle = env.castle;
  const home = castle.troop || {};
  const fid = C.coordsToFieldId(a.target.x, a.target.y);
  if (n(castle.fieldId) === fid) return fail(env, `${at(a.target)} is ${castle.name} itself`);
  const short = Object.entries(a.when).filter(([k, v]) => n(home[k]) < v);
  if (short.length) {
    return fail(env, `not yet: ${short.map(([k, v]) => `${fmt(home[k])} of ${fmt(v)} ${C.BY_KEY[k].name}`).join(', ')} — nothing sent`);
  }
  const lack = Object.entries(a.send).filter(([k, v]) => n(home[k]) < v);
  if (lack.length) return fail(env, `${castle.name} holds only ${lack.map(([k]) => `${fmt(home[k])} ${C.BY_KEY[k].name}`).join(', ')} — nothing sent`);
  const bean = game.buildArmyBean({ missionType: C.MISSION.reinforce, targetPoint: fid, troops: a.send });
  env.log(`  ${castle.name} holds ${Object.keys(a.when).map((k) => `${fmt(home[k])} ${C.BY_KEY[k].name}`).join(', ')}: reinforce ${at(a.target)} with ${troopText(a.send)} (no hero)`);
  if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
  const r = await game.newArmy(env.cid, bean);                         // army.newArmy (ArmyCommands.as:92-103)
  env.log('  -> ' + env.say(r));
  const sent = Object.values(a.send).reduce((s, v) => s + v, 0);
  return { done: 1, result: r && r.ok === 1 ? sent : 0 };
}

// The medic camp comes as a server.InjuredTroopUpdate push {castleId, goldNeed,
// troop} after army.getInjuredTroop (ArmyCommands.as:118-128; HospitalWin.as:228-252).
async function readCamp(env) {
  const game = env.game;
  const cid = env.cid;
  const t = T(env);
  const wait = Math.min(t.push, 3000);
  if (typeof game.readInjured === 'function') {
    const r = await game.readInjured(cid, wait);
    if (!r || r.ok !== 1) return { error: env.verdict(r) };
    return { camp: r.camp || null };
  }
  let camp = null;
  const on = (cmd, data) => { if (cmd === 'server.InjuredTroopUpdate' && data && n(data.castleId) === n(cid)) camp = data; };
  const c = game.c;
  if (c && typeof c.on === 'function') c.on('cmd', on);
  try {
    const r = await game.req('army.getInjuredTroop', { castleId: cid });
    if (!r || r.ok !== 1) return { error: env.verdict(r) };
    if (!camp && r.troop && typeof r.troop === 'object') camp = { ...r, castleId: cid };
    const until = Date.now() + wait;
    while (!camp && Date.now() < until) await env.pause(Math.min(100, t.poll));
  } finally { if (c && typeof c.off === 'function') c.off('cmd', on); }
  if (!camp) return { camp: null };
  const troop = camp.troop && typeof camp.troop === 'object' ? camp.troop : {};
  const total = Object.values(troop).reduce((s, v) => s + (Number(v) > 0 ? Number(v) : 0), 0);
  return { camp: { goldNeed: n(camp.goldNeed), troop, total } };
}

async function runHeal(a, env) {
  const game = env.game;
  const castle = env.castle;
  const { camp, error } = await readCamp(env);
  if (error) return fail(env, `could not read the medic camp: ${error}`);
  if (camp) {
    if (!camp.total) { env.log(`  no wounded troops in ${castle.name}`); return { ok: true, result: 0 }; }
    const gold = amountOf(castle.resource, 'gold');
    env.log(`  heal ${troopText(camp.troop)} for ${fmt(camp.goldNeed)} gold`);
    // HospitalWin.cureStart (:490-504): only with the gold for it
    if (castle.resource && camp.goldNeed > gold) return fail(env, `healing needs ${fmt(camp.goldNeed)} gold and ${castle.name} has ${fmt(gold)}`);
  } else env.log('  the camp did not say what it holds — asking the server to heal whatever is there');
  if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
  const r = typeof game.cureInjured === 'function' ? await game.cureInjured(env.cid)
    : await game.req('army.cureInjuredTroop', { castleId: env.cid });  // ArmyCommands.as:174-184
  env.log('  -> ' + env.say(r));
  return { done: 1, result: r && r.ok === 1 ? (camp ? camp.total : null) : 0 };
}

// ------------------------------------------------------------------ walls

const WALL_ACTIONS = { build: 'build', produce: 'build', demo: 'demo', destruct: 'demo', demolish: 'demo', keep: 'keep' };

function parseWallDefense(args) {
  const usage = 'walldefense <type> [qty] [build | demo | keep]  or  walldefense [demo | keep] tra:1k,ab:1k,at:5k,r:10,tre:0';
  let action = null;
  const items = [];
  const setAction = (a, w) => {
    if (action && action !== a) throw new Error(`walldefense: one action per line ("${w}" after ${action}) — ${usage}`);
    action = a;
  };
  const ws = words(args).map(unbang);
  // walldefense builds and demolishes the defenses ON the Walls; the Walls and
  // the Town Hall themselves are never demolished (see FIXED_TYPE)
  const fixedWord = (w) => { const b = /^[a-z_-]+$/i.test(w) && !W.fortByWord(w) ? W.buildingByWord(w) : null; return b && FIXED_TYPE[b.typeId]; };
  for (const w of ws) {
    for (const part of String(w).replace(/^\//, '').split(',')) {
      const what = fixedWord(part.split(':')[0]);
      if (what) throw new Error(`walldefense: ${what} ${what === 'the Walls' ? 'are' : 'is'} never demolished — walldefense builds or demolishes the defenses on the Walls: tra (trap), ab (abatis), at (archer tower), r (rolling logs), tre (trebuchet)`);
    }
  }
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    const act = WALL_ACTIONS[lc(w).replace(/^\//, '')];
    if (act && (lc(w).startsWith('/') || !W.fortByWord(w))) { setAction(act, w); continue; }
    if (w.startsWith('/')) throw new Error(`walldefense: unknown switch ${w} — /build, /demo or /keep`);
    if (w.includes(':')) {
      for (const part of w.split(',').filter(Boolean)) {
        const m = part.match(/^([a-z]+)\s*:\s*([\d.]+[kmb]?)$/i);
        const f = m && W.fortByWord(m[1]);
        if (!f) throw new Error(`walldefense: "${part}" — types are tra (trap), ab (abatis), at (archer tower), r (rolling logs), tre (trebuchet)`);
        items.push({ wall: f, qty: W.num(m[2]) });
      }
      continue;
    }
    const f = W.fortByWord(w);
    if (!f) throw new Error(`walldefense: unexpected "${w}" — ${usage}`);
    let qty = null;
    if (isNum(ws[i + 1])) qty = W.num(ws[++i]);
    items.push({ wall: f, qty });
  }
  if (!items.length) items.push({ wall: C.WALLS.find((x) => x.code === 'trap'), qty: null });
  action = action || 'build';
  for (const it of items) if (it.qty === null) it.qty = 1;
  return { cmd: 'walldefense', action, items: items.map((it) => ({ wall: it.wall, qty: it.qty })) };
}

async function runWallDefense(a, env) {
  const game = env.game;
  const castle = env.castle;
  const cid = env.cid;
  const have = castle.fortification && typeof castle.fortification === 'object' ? castle.fortification : null;
  const plan = [];
  for (const it of a.items) {
    const w = it.wall;
    const built = have ? n(have[w.beanKey]) : null;
    if (a.action === 'build') { plan.push({ w, num: it.qty, text: `build ${fmt(it.qty)} x ${w.name} (type ${w.typeId})` }); continue; }
    if (a.action === 'keep') {
      if (built === null) { env.log(`  ${w.name}: how many stand is not known — nothing demolished`); continue; }
      const drop = Math.max(0, built - it.qty);
      env.log(`  keep ${fmt(it.qty)} ${w.name}: ${fmt(built)} stand -> demolish ${fmt(drop)}`);
      if (drop > 0) plan.push({ w, num: drop, demo: true, text: `demolish ${fmt(drop)} x ${w.name}` });
      continue;
    }
    const num = built === null ? it.qty : Math.min(it.qty, built);
    if (num <= 0) { env.log(`  no ${w.name} stands to demolish`); continue; }
    plan.push({ w, num, demo: true, text: `demolish ${fmt(num)} x ${w.name}${num < it.qty ? ` (only ${fmt(built)} stand)` : ''}` });
  }
  if (!plan.length) { env.log('  nothing to do'); return { ok: true, result: 0 }; }
  for (const p of plan) env.log(`  ${p.text} in ${castle.name}`);
  if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
  let total = 0, done = 0;
  for (const p of plan) {
    const r = p.demo
      ? await game.req('fortifications.destructWallProtect', { castleId: cid, typeId: p.w.typeId, num: p.num })   // FortificationsCommands.as:70-79
      : await game.produceWall(cid, p.w.typeId, p.num);                 // fortifications.produceWallProtect (FortificationsCommands.as:43-52)
    done++;
    env.log(`  ${p.demo ? 'demolish' : 'build'} ${p.w.name} -> ${env.say(r)}`);
    if (r && r.ok === 1) total += p.num;
  }
  forget(game, 'wallq:');
  return { done, result: total };
}

// ------------------------------------------------------------------ the city

// interior.pacifyPeople / interior.taxation types, by NEAT's words. The goals
// update's goal-upkeep.js has the same tables (comfortTypeOf, levyTypeOf); this
// module uses them when they are there and the same words otherwise.
const UPKEEP_WORDS = {
  gold: 'gold', go: 'gold', stone: 'stone', st: 'stone', iron: 'iron', ir: 'iron', food: 'food', fo: 'food',
  wood: 'wood', lumber: 'wood', wo: 'wood', lu: 'wood',
  popraise: 'popraise', po: 'popraise', bless: 'bless', bl: 'bless', pray: 'pray', pr: 'pray', relief: 'relief', dr: 'relief',
  sacrifice: 'bless',
};
const PACIFY = { relief: 1, pray: 2, bless: 3, popraise: 4 };   // PacifyPeopleView.as:58-71; constants.js PACIFY (3 = sacrifice)
const LEVY = { gold: 1, food: 2, wood: 3, stone: 4, iron: 5 };  // CollectionMaterialsView.as:398-414
const LEVY_SHARE = { gold: 0.1, food: 1, wood: 1, stone: 0.5, iron: 0.4 };   // of the population (:486-499)
let UPKEEP;                                                     // looked for once
function upkeep() {
  if (UPKEEP === undefined) { try { UPKEEP = require('./goal-upkeep'); } catch { UPKEEP = null; } }
  return UPKEEP;
}
function comfortTypeOf(word) {
  const U = upkeep();
  if (U && typeof U.comfortTypeOf === 'function') return U.comfortTypeOf(word);
  const w = lc(word);
  const type = { 1: 'relief', 2: 'pray', 3: 'bless', 4: 'popraise' }[w] || UPKEEP_WORDS[w];
  return type && PACIFY[type] ? { type, typeId: PACIFY[type] } : null;
}
function levyTypeOf(word) {
  const U = upkeep();
  if (U && typeof U.levyTypeOf === 'function') return U.levyTypeOf(word);
  const w = lc(word);
  const type = { 1: 'gold', 2: 'food', 3: 'wood', 4: 'stone', 5: 'iron' }[w] || UPKEEP_WORDS[w];
  return type && LEVY[type] ? { type, typeId: LEVY[type] } : null;
}

const percent = (s) => {
  const m = /^(\d+)%?$/.exec(String(s || ''));
  return m ? +m[1] : NaN;
};

const LOGOS = [1, 2, 3, 4].map((i) => `images/icon/cityLogo/citylogo_0${i}.png`);   // CityLogoEumDefine.as

// ------------------------------------------------------------------ valleys and towns

const fieldHolder = (game, fid) => {
  for (const c of game.castles || []) {
    const f = (c.fields || []).find((v) => n(v.id) === n(fid));
    if (f) return { castle: c, field: f };
  }
  return null;
};

function cityByRef(game, ref) {
  if (ref.xy) {
    const fid = C.coordsToFieldId(ref.xy.x, ref.xy.y);
    return (game.castles || []).find((c) => n(c.fieldId) === fid) || null;
  }
  const find = (name) => (game.castles || []).find((c) => lc(c.name) === lc(name)) || null;
  return find(ref.name) || (/^!/.test(ref.name) ? find(ref.name.slice(1)) : null);
}
const refText = (ref) => (ref.xy ? at(ref.xy) : /\s/.test(ref.name) ? `"${ref.name}"` : ref.name);

// The console's city registry (db.js city_registry, read through the session's
// org) is default-deny: only a city buildnpc built on a flat it claimed is
// abandonable; every city it found (pre-existing, appeared) is protected. A
// script gives up only what the registry would. -> null, or why not. A run
// with no registry (tests, a bare run) has only the other guards.
function registryWhy(env, game, city) {
  const s = env.session;
  const reg = s && s.org && s.org.registry;
  const acct = s && s.account && s.account.id;
  if (!reg || !acct || typeof reg.get !== 'function') return null;
  let row;
  try {
    row = reg.get(acct, n(city.fieldId)) || (typeof reg.byCastleId === 'function' ? reg.byCastleId(acct, n(game.castleId(city))) : null);
  } catch (e) { return `the city registry could not be read (${e.message}), so ${city.name} is not given up`; }
  if (!row) return `the city registry has no record of ${city.name} yet, so nothing says it is a throwaway — not given up`;
  if (!row.abandonable) {
    return `the city registry records ${city.name} as a real city (${row.origin || '?'}, ${row.state || '?'}) — a script never gives one up;`
      + ' only a city buildnpc built stays abandonable';
  }
  if (row.castleId !== null && row.castleId !== undefined && n(row.castleId) !== n(game.castleId(city))) {
    return `the city registry's entry for ${city.name}'s tile is another city (castle ${row.castleId}) — not given up`;
  }
  return null;
}

function parseTownRef(word, ws) {
  if (!ws.length) return null;
  const c = coordsIn(ws, 0, word);
  if (c) return { ref: { xy: c.xy }, used: c.used };
  return { ref: { name: ws[0] }, used: 1 };
}

// Armies that left from a city and can be called back: going (1) or staying (3).
const armiesFrom = (game, castle) => ((game.player && game.player.selfArmys) || [])
  .filter((x) => n((x.raw || x).startFieldId) === n(castle.fieldId)).map((x) => x.raw || x);
const recallable = (x) => n(x.direction) === 1 || n(x.direction) === 3;

// army.callBackArmy {castleId, armyId} (ArmyCommands.as:105-116)
async function recallAll(env, castle, list) {
  const game = env.game;
  let k = 0;
  for (const x of list) {
    const to = C.fieldIdToCoords(n(x.targetFieldId));
    if (env.dryRun) { env.log(`  recall army ${x.armyId} (to ${at(to)}) — [dry run] not sent`); continue; }
    let r;
    try { r = await game.recallArmy(game.castleId(castle), x.armyId); } catch (e) { r = { ok: 0, errorMsg: e.message }; }
    env.log(`  recall army ${x.armyId} (to ${at(to)}) -> ${env.verdict(r)}`);
    if (r && r.ok === 1) k++;
  }
  return k;
}

// ------------------------------------------------------------------ city builds and their captures

// buildcity lines still waiting on a capture, per account: cancelbuildcity
// reaches them from any run.
const PENDING = new Map();
const accountKey = (game) => String(((game.player && game.player.playerInfo) || {}).userName || '');

// One live tile, through the console's map reader. Never logs in to do it.
async function readTile(session, xy) {
  if (!session || typeof session.scanArea !== 'function' || !session.connected) return null;
  try {
    const r = await session.scanArea(xy.x, xy.y, 0, { fresh: true });
    return ((r && r.tiles) || []).find((t) => t.x === xy.x && t.y === xy.y) || null;
  } catch { return null; }
}

// FieldInfoWin.isFitCondition (:1308-1315): the city sending the build holds
// 10,000 each of food, wood, stone, iron and gold, and 250 workers.
function foundingShort(castle) {
  const res = castle.resource;
  const out = [];
  if (res && typeof res === 'object') {
    for (const k of [...RES_ORDER, 'gold']) if (amountOf(res, k) < 10000) out.push(`${k} ${fmt(amountOf(res, k))} of 10,000`);
  }
  const troop = castle.troop;
  if (troop && typeof troop === 'object' && n(troop.peasants) < 250) out.push(`workers ${fmt(troop.peasants)} of 250`);
  return out;
}

async function runBuildCity(a, env) {
  let game = env.game;
  let castle = env.castle;
  const fid = C.coordsToFieldId(a.target.x, a.target.y);
  const where = at(a.target);
  if ((game.castles || []).some((c) => n(c.fieldId) === fid)) return fail(env, `${where} is already one of your cities`);

  if (!fieldHolder(game, fid)) {
    // NEAT's buildcity captures the flat first, with ValleyTroops (defaults by level)
    const tile = await readTile(env.session, a.target);
    game = env.game;                  // the map read waited: it follows a reconnect
    castle = env.castle;
    if (tile && tile.kind && tile.kind !== 'flat') return fail(env, `${where} is ${tile.kind === 'npc' ? 'an NPC camp' : tile.typeName || tile.kind} — a city goes on a flat`);
    if (tile && (tile.userName || tile.npc)) return fail(env, `${where} is held by ${tile.userName || 'someone'} — not a free flat`);
    const level = tile && n(tile.level) ? n(tile.level) : null;
    const troops = a.troops || (level ? VALLEY_TROOPS[Math.min(10, level)] : null);
    if (!troops) return fail(env, `could not read ${where}'s level to size the capture — give the troops: buildcity ${where} any a:200`);
    const home = castle.troop || {};
    const lack = Object.entries(troops).filter(([k, v]) => home && castle.troop && n(home[k]) < v);
    if (lack.length) return fail(env, `capturing ${where}${level ? ` (level ${level})` : ''} takes ${troopText(troops)}; ${castle.name} has ${lack.map(([k]) => `${fmt(home[k])} ${C.BY_KEY[k].name}`).join(', ')}`);
    let hero;
    try {
      const skip = new Set([...env.sentHeroes].filter(([, t]) => Date.now() - t < 60000).map(([id]) => id));
      hero = game.pickHero(castle, a.hero || 'any', skip);
    } catch (e) { return fail(env, `capture ${where}: ${e.message}`); }
    // pickHero falls back to a busy hero when none is free, and takes a named one as it is
    if (n(hero.status) !== 0 || (env.sentHeroes.has(hero.id) && Date.now() - env.sentHeroes.get(hero.id) < 60000)) {
      return fail(env, `capture ${where}: ${a.hero ? `${hero.name} is not` : 'no hero is'} free in ${castle.name} to lead it`);
    }
    const from = game.castleXY(castle);
    const ms = from ? C.marchTimeMs(from, a.target, Object.keys(troops), game.marchSkillParam) : null;
    env.log(`  ${where} is not yours yet: capture it first${level ? ` (flat level ${level})` : ''} — attack with ${hero.name} and ${troopText(troops)}${ms !== null ? `, march ${dur(ms / 1000)}` : ''}`);
    if (env.dryRun) { env.log(`  then found the city on it — [dry run] not sent`); return {}; }
    const bean = game.buildArmyBean({ missionType: C.MISSION.attack, heroId: hero.id, targetPoint: fid, troops });
    const r = await game.newArmy(env.cid, bean);                         // army.newArmy (ArmyCommands.as:92-103)
    env.log('  -> ' + env.say(r));
    if (!r || r.ok !== 1) return { done: 1 };
    env.sentHeroes.set(hero.id, Date.now());
    // wait for the flat to be ours (server.CastleFieldUpdate, applied by session.js)
    const key = `${accountKey(game)}:${fid}`;
    const entry = { fid, where, city: castle.name, castleId: env.cid, cancelled: false };
    PENDING.set(key, entry);
    const t = T(env);
    const until = Date.now() + (ms || 0) + t.grace;
    env.log(`  waiting for the capture (cancelbuildcity ${where} stops this; Stop too)`);
    try {
      for (;;) {
        if (fieldHolder(env.game, fid)) break;
        if (entry.cancelled) return fail(env, `the city build at ${where} was cancelled`);
        if (env.stopped()) return stoppedOut();
        if (Date.now() >= until) return fail(env, `${where} did not become yours — the capture failed or has not landed; nothing built`);
        await env.pause(Math.max(1, Math.min(t.poll, until - Date.now())));
      }
    } finally { if (PENDING.get(key) === entry) PENDING.delete(key); }
    env.log(`  ${where} is yours`);
  }
  try {
    for (const note of require('./city-build').preflight(env.game, fid)) env.log('  ' + note);
  } catch (e) { return fail(env, e.message); }
  const short = foundingShort(env.castle);
  if (short.length) return fail(env, `founding a city from ${env.castle.name} takes 10,000 each of food, wood, stone, iron and gold and 250 workers — short: ${short.join(', ')}`);
  env.log(`  found city on flat ${where} (field ${fid}) from ${env.castle.name}`);
  if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
  const r = await env.game.constructCastle(env.cid, fid, false);        // city.constructCastle (CityCommands.as:147-158)
  env.log('  -> ' + env.say(r));
  return { done: 1 };             // $result: what it logged, as before
}

// ------------------------------------------------------------------ teleports

// A held Pioneer Express Teleport goes before an Advanced Teleporter (wiki
// Teleport): city.uniteAdvMoveCastle {castleId, targetId} (CityCommands.as:109-117,
// DesignatedMoveCityWin.changeZone :405-416).
async function runPioneer(a, env) {
  const TP = require('./teleport');
  const game = env.game;
  const castle = game.castle(a.from ?? env.opts.castle);
  const castleId = game.castleId(castle);
  const targetField = C.coordsToFieldId(a.target.x, a.target.y);
  const own = (game.castles || []).find((c) => n(c.fieldId) === targetField);
  if (own) { env.log(`  ${at(a.target)} is your own city ${own.name} — nothing sent`); return { ok: env.dryRun, done: 0 }; }
  const v = TP.judge('adv', await readTile(env.session, a.target), a.target);
  env.log('  ' + v.text + (v.refuse ? ' — nothing sent' : ''));
  if (v.refuse) return { ok: false, error: v.text };
  const here = game.castleXY(castle);
  env.log(`  Pioneer Express Teleport: ${castle.name}${here ? ` ${at(here)}` : ''} -> ${at(a.target)} (${C.zoneOf(a.target.x, a.target.y)}), `
    + `${fmt(heldCount(game, PIONEER))} held (it goes before an Advanced Teleporter)`);
  if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
  const r = await game.req('city.uniteAdvMoveCastle', { castleId, targetId: targetField });
  if (!r || r.ok !== 1) {
    const hint = r && TP.HINTS[r.ok];
    env.log(`  -> ${env.say(r)}${hint ? ' — ' + hint : ''}`);
    return { done: 1 };
  }
  castle.fieldId = targetField;
  const s = env.session;
  if (s && s.org && s.account && s.account.id) {
    try { s.org.registry.markMoved(s.account.id, castleId); } catch (e) { env.log('  city registry: ' + e.message); }
    if (typeof s.reconcileRegistry === 'function') s.reconcileRegistry(game);
  }
  env.log(`  -> ok — ${castle.name} is now at ${at(a.target)} (${C.zoneOf(a.target.x, a.target.y)})`);
  return { done: 1 };             // $result as teleport's other paths: what it logged
}

const zoneKey = (s) => lc(s).replace(/[^a-z]/g, '');
const ZONE_BY_KEY = new Map(C.ZONES.map((z) => [zoneKey(z), z]));

// Wait until none of a city's armies are out (the selfArmys push, applied by session.js).
async function waitArmiesHome(env, castle) {
  const t = T(env);
  const game = () => env.game;
  let list = armiesFrom(game(), castle);
  if (!list.length) return 'home';
  const reach = Math.max(0, ...list.map((x) => n(x.reachTime)));
  const left = reach > 0 ? Math.max(0, reach - game().now()) : 0;
  env.log(`  ${list.length} arm${list.length === 1 ? 'y' : 'ies'} still out — waiting${left ? ` about ${dur(left / 1000)}` : ''} for them (Stop ends the wait)`);
  const until = Date.now() + left + t.grace;
  for (;;) {
    await env.pause(Math.max(1, Math.min(t.poll, until - Date.now())));
    if (env.stopped()) return 'stopped';
    list = armiesFrom(game(), castle);
    if (!list.length) return 'home';
    if (Date.now() >= until) { env.log(`  ${list.length} arm${list.length === 1 ? 'y is' : 'ies are'} still out — teleporting anyway (the server refuses with -77 if they block it)`); return 'late'; }
  }
}

async function runAutoTeleport(a, env) {
  const TP = require('./teleport');
  let zone = a.zone;
  if (!zone && !a.random) {
    let v;
    try { v = await env.ctx.evaluate('Config.teleport'); } catch { v = undefined; }
    if (v === undefined || v === null || v === '') return fail(env, 'autoteleport: which state? (autoteleport tuscany, autoteleport random, or start the console with -teleport <state>)');
    if (zoneKey(v) === 'random') a = { ...a, random: true };
    else {
      zone = ZONE_BY_KEY.get(zoneKey(v));
      if (!zone) return fail(env, `the -teleport start-up parameter says "${v}", which is no state — ${C.ZONES.join(', ')}`);
    }
  }
  const game = env.game;
  const cities = a.all ? (game.castles || []).slice() : [env.castle];
  // a loop of tries spends only what the inventory shows (teleport.js checks again)
  const teleporters = () => TP.heldCount(env.game, CITY_TELEPORTER);
  let moved = 0, already = 0, failed = 0;
  for (const city of cities) {
    const xy = game.castleXY(city);
    const inZone = xy ? C.zoneOf(xy.x, xy.y) : null;
    if (zone && inZone === zone) { env.log(`  ${city.name} is in ${zone} already`); already++; continue; }
    env.log(`  ${city.name}${inZone ? ` (${inZone})` : ''} -> ${zone || 'a random state'}`);
    if (teleporters() === null) { env.log('  the inventory is not loaded, so whether a City Teleporter is held cannot be checked — nothing sent'); failed++; break; }
    if (teleporters() < 1) { env.log(`  no City Teleporter in the inventory (${CITY_TELEPORTER}) — nothing sent`); failed++; break; }
    if (!a.norecall) {
      const out = armiesFrom(env.game, city).filter(recallable);
      if (out.length) await recallAll(env, city, out);
      if (!env.dryRun) {
        const w = await waitArmiesHome(env, city);
        if (w === 'stopped') return stoppedOut();
      } else if (armiesFrom(env.game, city).length) env.log('  [dry run] would wait for its armies to come home');
    }
    let ok = false;
    for (let i = 1; i <= a.tries; i++) {
      if (env.stopped()) return stoppedOut();
      ok = await TP.run(env.game, { kind: 'state', zone: zone || null, from: null },
        { castle: env.game.castleId(city), session: env.session, dryRun: env.dryRun, log: env.log });
      if (ok || env.dryRun) break;
      if (!(teleporters() >= 1)) break;
      if (i < a.tries) {
        env.log(`  could not teleport ${city.name} (try ${i} of ${a.tries}) — trying again in ${dur(a.every)}`);
        await env.pause(a.every * 1000);
      }
    }
    if (ok) moved++;
    else if (!env.dryRun) { failed++; env.log(`  could not teleport ${city.name} to ${zone || 'a random state'}`); }
  }
  if (env.dryRun) return {};
  if (zone && cities.length > 1 && !failed) env.log(`  every city is in ${zone} now`);
  const summary = `${moved} moved, ${already} already there${failed ? `, ${failed} not moved` : ''}`;
  env.log(`  ${summary}`);
  const here = env.game.castleXY(env.castle);
  return { done: moved, ok: !failed, error: failed ? `${failed} cit${failed === 1 ? 'y' : 'ies'} not moved` : undefined, result: here ? at(here) : summary };
}

// ------------------------------------------------------------------ the commands

const construction = (word, usage, run) => ({ usage, parse: (args) => parseConstruction(word, args), run });

const commands = {
  create: construction('create', 'create <type> [plot] [/speedup=<items>] [/nowait]', runCreate),

  build: {
    usage: 'build <building> [at <plot>]   (build c:10:9 is the build goal)',
    parse(args) {
      if (looksLikeGoal(words(args))) return goalLine('build', args);
      return parseConstruction('build', args);
    },
  },

  upgrade: construction('upgrade', 'upgrade <type> [levelX | lowestlevel [X] | highestlevel [X]] [at <plot>] [/speedup=<items>] [/nowait]   (bare upgrade: any building below 9)', runUpgrade),
  demo: {
    ...construction('demo', 'demo <type | any> [levelX | lowestlevel [X] | highestlevel [X]] [@plot] [/dynamite] [/speedup=<items>] [/nowait]', runDemo),
    words: ['demo', 'demolish'],
  },
  demosite: { usage: 'demosite [/dynamite] <plot>', parse: (args) => parseConstruction('demosite', args) },

  cancelbuilding: {
    usage: 'cancelbuilding [@plot]',
    parse(args) {
      const ws = words(args);
      if (!ws.length) return { cmd: 'cancelbuilding', at: null };
      const p = plotIn(ws, 0, true);
      if (!p || p.used !== ws.length) throw new Error('cancelbuilding: usage  cancelbuilding   (or cancelbuilding @20 for one plot)');
      return { cmd: 'cancelbuilding', at: p.pos };
    },
    async run(a, env) {
      const t = T(env);
      const castle = env.castle;
      const job = a.at !== null ? beanAt(castle, a.at) : busyWith(env.game, castle, t.grace);
      if (!job || (n(job.status) !== 1 && n(job.status) !== 2)) {
        env.log(`  nothing is under construction${a.at !== null ? ` on plot ${a.at}` : ''} in ${castle.name}`);
        return { ok: true, result: 0 };
      }
      env.log(`  cancel ${jobText(job)} in ${castle.name}`);
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      const r = await env.game.req('castle.cancleBuildCommand', { castleId: env.cid, positionId: n(job.positionId) });   // CastleCommands.as:202-213 (the game's spelling)
      env.log('  -> ' + env.say(r));
      return { done: 1, result: n(job.positionId) };
    },
  },

  buildingspeedup: {
    usage: 'buildingspeedup [@plot] <item[,item]>   e.g. buildingspeedup Senior Guidelines',
    parse(args) {
      const ws = words(args);
      let pos = null;
      const p = ws.length ? plotIn(ws, 0, false) : null;
      if (p) { pos = p.pos; ws.splice(0, p.used); }
      if (!ws.length) throw new Error('buildingspeedup: which item? e.g. buildingspeedup Senior Guidelines');
      return { cmd: 'buildingspeedup', at: pos, items: speedupList(ws.join(' '), 'buildingspeedup') };
    },
    async run(a, env) {
      const t = T(env);
      const castle = env.castle;
      const job = a.at !== null ? beanAt(castle, a.at) : busyWith(env.game, castle, t.grace);
      if (!job || (n(job.status) !== 1 && n(job.status) !== 2)) return fail(env, `nothing is under construction${a.at !== null ? ` on plot ${a.at}` : ''} in ${castle.name}`);
      const left = Math.max(0, n(job.endTime) - env.game.now());
      env.log(`  ${jobText(job)}, ${dur(left / 1000)} left`);
      const sj = { kind: 'building', pos: n(job.positionId), label: `${bName(job)} on plot ${job.positionId}`,
        preset: n(job.status) === 1 ? freePreset('building', job.typeId, job.level) : null };
      const used = await applySpeedups(env, sj, a.items, true);
      if (env.dryRun) return {};
      return { done: used, ok: used > 0 && !env.refused(), error: used ? undefined : sj.skipped.join('; ') || 'no speed-up was used', result: used };
    },
  },

  // NEAT's startresearch; OTTObot's research sends at once.
  startresearch: {
    usage: 'startresearch <tech | quickest | cheapest | dearest> [/nowait] [/speedup=<items>]',
    parse(args) {
      const { sw, rest } = takeSwitches(words(args), ['nowait', 'speedup'], 'startresearch');
      if (!rest.length) throw new Error('startresearch: usage  startresearch <tech | quickest | cheapest | dearest> [/nowait]   e.g. startresearch compass');
      return { cmd: 'startresearch', ...parseResearchTech('startresearch', rest), nowait: !!sw.nowait,
        ...(sw.speedup !== undefined ? { speedup: speedupList(sw.speedup, 'startresearch') } : {}) };
    },
    run: runStartResearch,
  },

  research: {
    usage: 'research <tech>   (research lo:5 is the research goal)',
    parse(args, { tok }) {
      const ws = words(args);
      if (looksLikeGoal(ws)) return goalLine('research', args);
      const t = W.techByWord(tok.slice(1).join('').toLowerCase().replace(/[^a-z]/g, ''));
      if (!t) throw new Error('research: unknown tech "' + tok.slice(1).join(' ') + '"');
      return { cmd: 'research', tech: t };
    },
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      const cid = game.castleId(castle);
      const list = await game.researchList(cid).catch(() => null);
      const beans = (list && (list.acailableResearchBeans || list.availableResearchBeans)) || [];
      const bean = beans.find((b) => b.typeId === a.tech.typeId);
      if (bean) env.log(`  ${a.tech.name}: level ${bean.level}/${bean.avalevel}${bean.upgradeing ? ' (already researching)' : ''}`);
      env.log(`  research ${a.tech.name} (tech ${a.tech.typeId}) in ${castle.name}`);
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      const r = await game.research(cid, a.tech.typeId);
      env.log('  -> ' + env.say(r));
      forget(game, 'research:');
      return { done: 1 };
    },
  },

  cancelresearch: {
    usage: 'cancelresearch',
    parse(args) {
      if (String(args || '').trim()) throw new Error('cancelresearch: nothing goes after it — it cancels the research under way in this city');
      return { cmd: 'cancelresearch' };
    },
    async run(a, env) {
      const { beans } = await researchBeans(env);
      const cur = runningHere(beans, env.cid);
      if (!cur) { env.log(`  nothing is being researched in ${env.castle.name}`); return { ok: true, result: 0 }; }
      env.log(`  cancel ${techName(cur)} ${n(cur.level)} -> ${n(cur.level) + 1} in ${env.castle.name}`);
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      const r = await env.game.req('tech.cancelResearch', { castleId: env.cid });   // TechCommand.as:72-82
      env.log('  -> ' + env.say(r));
      forget(env.game, 'research:');
      if (typeof env.game.noteResearch === 'function' && r && r.ok === 1) { try { env.game.noteResearch(env.cid, null); } catch { /* */ } }
      return { done: 1, result: techName(cur) };
    },
  },

  checkresearch: {
    usage: 'checkresearch   ($result: the techs this city can start now)',
    parse(args) {
      if (String(args || '').trim()) throw new Error('checkresearch: nothing goes after it');
      return { cmd: 'checkresearch' };
    },
    async run(a, env) {
      const { beans } = await researchBeans(env);
      if (!beans.length) return fail(env, `no research list for ${env.castle.name} — is there an Academy?`);
      const cur = runningHere(beans, env.cid);
      if (cur) env.log(`  researching now: ${techName(cur)} ${n(cur.level)} -> ${n(cur.level) + 1}`);
      const res = env.castle.resource;
      const ok = beans.filter((b) => researchable(b, res, env.game));
      if (!ok.length) env.log(`  nothing can be started in ${env.castle.name} right now`);
      for (const b of ok) {
        const c = b.conditionBean || {};
        env.log(`  ${techName(b)} ${n(b.level)} -> ${n(b.level) + 1}: ${dur(c.time)}, ${['food', 'wood', 'stone', 'iron', 'gold'].filter((k) => n(c[k])).map((k) => `${k} ${fmt(c[k])}`).join(', ') || 'free'}`);
      }
      return { ok: true, result: ok.map(techName) };
    },
  },

  researchspeedup: {
    usage: 'researchspeedup <item[,item]>   e.g. researchspeedup Senior Guidelines',
    parse(args) {
      if (!String(args || '').trim()) throw new Error('researchspeedup: which item? e.g. researchspeedup Senior Guidelines');
      return { cmd: 'researchspeedup', items: speedupList(words(args).join(' '), 'researchspeedup') };
    },
    async run(a, env) {
      const { beans } = await researchBeans(env);
      const cur = runningHere(beans, env.cid);
      if (!cur) return fail(env, `nothing is being researched in ${env.castle.name}`);
      env.log(`  ${techName(cur)} ${n(cur.level)} -> ${n(cur.level) + 1}${n(cur.endTime) ? `, ${dur(Math.max(0, n(cur.endTime) - env.game.now()) / 1000)} left` : ''}`);
      const sj = { kind: 'research', label: `${techName(cur)} research`, preset: freePreset('research', cur.typeId, cur.level) };
      const used = await applySpeedups(env, sj, a.items, true);
      forget(env.game, 'research:');
      if (env.dryRun) return {};
      return { done: used, ok: used > 0 && !env.refused(), error: used ? undefined : sj.skipped.join('; ') || 'no speed-up was used', result: used };
    },
  },

  walldefense: {
    usage: 'walldefense <type> [qty] [build | demo | keep]   or  walldefense [/demo | /keep] tra:1k,ab:1k,at:5k',
    parse: (args) => parseWallDefense(args),
    run: runWallDefense,
  },

  // wall abatis 1000     (trap, abatis, tower, logs, rocks, or NEAT's tra ab at r tre)
  wall: {
    aliases: ['walls'],
    usage: 'wall <trap|abatis|tower|logs|rocks> <amount>',
    parse(args, { tok }) {
      const w = C.WALL_BY_CODE[(tok[1] || '').toLowerCase()] || W.fortByWord(tok[1] || '');
      if (!w) throw new Error('wall: type must be one of ' + C.WALLS.map((x) => x.code).join('/'));
      return { cmd: 'wall', wall: w, amount: W.num(tok[2] || '1') };
    },
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      env.log(`  build ${a.amount.toLocaleString('en-US')} x ${a.wall.name} (type ${a.wall.typeId}) in ${castle.name}`);
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      const r = await game.produceWall(game.castleId(castle), a.wall.typeId, a.amount);
      env.log('  -> ' + env.say(r));
      forget(game, 'wallq:');
      return { done: 1 };
    },
  },

  // train a:5000 [hero] [barracks] [min]  (NEAT)  |  train a 10k  (OTTObot)
  train: {
    usage: 'train <type:qty> [hero] [barracks plot | all | idle] [minimum]   or  train <troop> <amount>',
    parse: (args, { tok }) => parseTrain(args, tok),
    run: runTrain,
  },

  disband: {
    usage: 'disband <troops>  |  disband /keep <troops>   e.g. disband w:25k',
    parse(args) {
      const ws = words(args);
      let keep = false;
      const rest = ws.filter((w) => { if (/^\/?keep$/i.test(w)) { keep = true; return false; } return true; });
      if (rest.some((w) => w.startsWith('/'))) throw new Error('disband: the only switch is /keep');
      return { cmd: 'disband', keep, troops: troopList(rest, 'disband') };
    },
    run: runDisband,
  },

  dumptroop: {
    usage: 'dumptroop <x,y> <when troops> <send troops>   e.g. dumptroop 111,222 a:99000,s:50000 a:20000,s:15000',
    parse(args) {
      const ws = words(args);
      const c = coordsIn(ws, 0, 'dumptroop');
      if (!c) throw new Error('dumptroop: usage  dumptroop 111,222 <at least these> <send these>   e.g. dumptroop 111,222 a:99000,s:50000 a:20000,s:15000');
      const rest = ws.slice(c.used);
      if (rest.length !== 2) throw new Error('dumptroop: give two troop strings — what the city must hold, then what to send');
      return { cmd: 'dumptroop', target: c.xy, when: W.parseTroops(rest[0]), send: W.parseTroops(rest[1]) };
    },
    run: runDumpTroop,
  },

  healtroops: {
    usage: 'healtroops',
    parse(args) {
      if (String(args || '').trim()) throw new Error('healtroops: nothing goes after it — it heals the whole medic camp');
      return { cmd: 'healtroops' };
    },
    run: runHeal,
  },

  // production 0 0 0 0   (food wood stone iron, percentages)
  // zeroing them frees all field labour back into idle population
  production: {
    aliases: ['produce'],
    usage: 'production <food> <wood> <stone> <iron>',
    parse(args, { tok }) {
      const nums = tok.slice(1).map(percent);
      if (nums.length !== 4 || nums.some((x) => Number.isNaN(x) || x < 0 || x > 100)) {
        throw new Error('production: usage  production <food> <wood> <stone> <iron>   (0-100 each)');
      }
      return { cmd: 'production', rates: { food: nums[0], wood: nums[1], stone: nums[2], iron: nums[3] } };
    },
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      const r0 = castle.resource || {};
      const busy = ['food', 'wood', 'stone', 'iron'].reduce((s2, k) => s2 + Number((r0[k] && r0[k].workPeople) || 0), 0);
      env.log(`  set production food ${a.rates.food}% wood ${a.rates.wood}% stone ${a.rates.stone}% iron ${a.rates.iron}% (currently ${busy.toLocaleString('en-US')} on fields)`);
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      const r = await game.setProduction(game.castleId(castle), a.rates);
      env.log('  -> ' + env.say(r));
      forget(game, 'prod:');
      return { done: 1 };
    },
  },

  tax: {
    aliases: ['settaxrate'],
    usage: 'tax <0-100>  (settaxrate)',
    parse(args, { word, tok }) {
      const v = percent(tok[1]);
      if (Number.isNaN(v) || v < 0 || v > 100 || tok.length > 2) throw new Error(`${word}: usage  ${word} <0-100>`);
      return { cmd: 'tax', rate: v };
    },
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      const now = castle.resource && castle.resource.texRate;   // sic, CastleResourceBean
      env.log(`  set tax rate to ${a.rate}%${now !== undefined && now !== null ? ` (now ${now}%)` : ''}`);
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      const r = await game.setTax(game.castleId(castle), a.rate);      // interior.modifyTaxRate (InteriorCommands.as:28-39)
      env.log('  -> ' + env.say(r));
      return { done: 1 };
    },
  },

  comfort: {
    usage: 'comfort <1-4 | relief | pray | bless | popraise>',
    parse(args) {
      const ws = words(args);
      const c = ws.length === 1 ? comfortTypeOf(ws[0]) : null;
      if (!c) throw new Error('comfort: usage  comfort <1-4 | relief | pray | bless | popraise>   (1 relief, 2 pray, 3 bless, 4 popraise)');
      return { cmd: 'comfort', type: c.type, typeId: c.typeId };
    },
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      const res = castle.resource || {};
      env.log(`  comfort: ${a.type} in ${castle.name}${res.support !== undefined ? ` (loyalty ${n(res.support)}, grievance ${n(res.complaint)})` : ''}`);
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      const r = typeof game.pacify === 'function' ? await game.pacify(env.cid, a.typeId)
        : await game.req('interior.pacifyPeople', { castleId: env.cid, typeId: a.typeId });   // InteriorCommands.as:87-98
      env.log('  -> ' + env.say(r));
      return { done: 1 };
    },
  },

  levy: {
    usage: 'levy <1-5 | gold | food | wood | stone | iron>',
    parse(args) {
      const ws = words(args);
      const l = ws.length === 1 ? levyTypeOf(ws[0]) : null;
      if (!l) throw new Error('levy: usage  levy <1-5 | gold | food | wood | stone | iron>   (1 gold, 2 food, 3 wood, 4 stone, 5 iron)');
      return { cmd: 'levy', type: l.type, typeId: l.typeId };
    },
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      const res = castle.resource || {};
      const pop = n(res.curPopulation);
      env.log(`  levy ${a.type} in ${castle.name}${pop ? `: about ${fmt(pop * LEVY_SHARE[a.type])}` : ''}, for 20 loyalty${res.support !== undefined ? ` (loyalty ${n(res.support)})` : ''}`);
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      const r = typeof game.levy === 'function' ? await game.levy(env.cid, a.typeId)
        : await game.req('interior.taxation', { castleId: env.cid, typeId: a.typeId });       // InteriorCommands.as:41-52
      env.log('  -> ' + env.say(r));
      return { done: 1 };
    },
  },

  // NEAT's setfocus [cycles] gives the city the bot's next task cycle(s). The
  // goals visit every city every tick here, so no city waits for a turn: the
  // line is accepted, so NEAT scripts that hold it still load, and does nothing.
  setfocus: {
    usage: 'setfocus [cycles]   (nothing to do: every city gets every tick)',
    parse(args) {
      const t = String(args || '').trim();
      if (t && !/^\d+$/.test(t)) throw new Error('setfocus: usage  setfocus [cycles]   e.g. setfocus 5');
      return { cmd: 'setfocus', cycles: t ? +t : 1 };
    },
    async run(a, env) {
      env.log(`  nothing to do — the goals visit every city every tick, so ${env.castle.name} needs no turn of its own (NEAT's setfocus)`);
      return { ok: true };
    },
  },

  renamecity: {
    usage: 'renamecity <new name> [picture 1-4]   (a name with spaces in quotes; 10 letters at most)',
    parse(args) {
      const ws = words(args);
      if (!ws.length || ws.length > 2) throw new Error('renamecity: usage  renamecity <new name> [picture 1-4]   — a name with spaces goes in quotes');
      let pic = null;
      if (ws.length === 2) {
        if (!/^[1-4]$/.test(ws[1])) throw new Error(`renamecity: the picture is 1, 2, 3 or 4, not "${ws[1]}" — a name with spaces goes in quotes`);
        pic = +ws[1];
      }
      const name = unbang(ws[0].trim());          // the wiki's !BottingRulz: MoinMoin's escape
      if (!name) throw new Error('renamecity: the new name is empty');
      // the length is judged when it runs, so the wiki's own 11-letter example still loads
      return { cmd: 'renamecity', name, picture: pic };
    },
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      const old = castle.name;
      // ModifyCastleNameView.submitHandle (:744-760): 10 characters at most
      if (a.name.length > 10) return fail(env, `${a.name} is ${a.name.length} letters — the game's rename window takes 10 at most; not sent`);
      // the console and scripts find cities by name: two of one name would be one too many
      const twin = (game.castles || []).find((c) => c !== castle && lc(c.name) === lc(a.name));
      if (twin) return fail(env, `another of your cities is called ${twin.name} already — pick another name`);
      const logUrl = a.picture ? LOGOS[a.picture - 1] : castle.logUrl || LOGOS[0];   // ModifyCastleNameView.submitHandle :744-760
      env.log(`  rename ${old} to ${a.name}${a.picture ? `, picture ${a.picture}` : ''}`);
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      const r = await game.req('city.modifyCastleName', { castleId: env.cid, name: a.name, logUrl });   // CityCommands.as:192-201
      env.log('  -> ' + env.say(r));
      if (r && r.ok === 1) {
        castle.name = a.name;
        castle.logUrl = logUrl;
        // a run that named its city by the old name keeps finding it
        if (env.opts && lc(env.opts.castle) === lc(old)) env.opts.castle = game.castleId(castle);
        env.log('  (the goal engine keys its timers and backoffs by city name: this city\'s start over)');
      }
      return { done: 1, result: r && r.ok === 1 ? a.name : old };
    },
  },

  abandon: {
    usage: 'abandon <x,y>   (a valley or flat of yours)',
    parse(args) {
      const ws = words(args);
      const c = coordsIn(ws, 0, 'abandon');
      if (!c || c.used !== ws.length) throw new Error('abandon: usage  abandon 111,222   — gives up that valley or flat of yours');
      return { cmd: 'abandon', target: c.xy };
    },
    async run(a, env) {
      const game = env.game;
      const fid = C.coordsToFieldId(a.target.x, a.target.y);
      const where = at(a.target);
      const city = (game.castles || []).find((c) => n(c.fieldId) === fid);
      if (city) return fail(env, `${where} is your city ${city.name}, not a valley — abandontown ${where} confirm gives a city up`);
      const held = fieldHolder(game, fid);
      if (!held) return fail(env, `${where} is not a valley of yours`);
      const t = C.FIELD_TYPES[n(held.field.type)] || {};
      env.log(`  abandon ${t.name || 'field'} L${n(held.field.level)} at ${where} (held by ${held.castle.name})`);
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      const r = await game.req('field.giveUpField', { fieldId: fid });  // FieldCommand.as:25-35
      env.log('  -> ' + env.say(r));
      if (r && r.ok === 1) {
        // the server.CastleFieldUpdate push does the same; city.fields must not wait for it
        held.castle.fields = (held.castle.fields || []).filter((f) => n(f.id) !== fid);
      }
      return { done: 1, result: where };
    },
  },

  abandontown: {
    usage: 'abandontown <x,y | city> confirm [anyway]   — gives the city up for good (off unless the console starts with OTTO_ALLOW_ABANDON_TOWN=1)',
    parse(args) {
      if (!settings.allowAbandonTown) {
        throw new Error('abandontown is off in this console: it gives a city up for good, so it runs only when the console'
          + ' is started with OTTO_ALLOW_ABANDON_TOWN=1');
      }
      const ws = words(args);
      let confirm = false, anyway = false;
      while (ws.length && ['confirm', 'anyway'].includes(lc(ws[ws.length - 1]))) {
        if (lc(ws.pop()) === 'confirm') confirm = true; else anyway = true;
      }
      const p = parseTownRef('abandontown', ws);
      if (!p || p.used !== ws.length) throw new Error('abandontown: usage  abandontown <x,y | city> confirm   — a city name with spaces goes in quotes');
      if (!confirm) {
        throw new Error(`abandontown: this gives ${refText(p.ref)} up for good — heroes and troops in it or marching from it are lost. `
          + `To do it, end the line with the word confirm: abandontown ${refText(p.ref)} confirm`);
      }
      return { cmd: 'abandontown', ref: p.ref, anyway };
    },
    async run(a, env) {
      const game = env.game;
      const city = cityByRef(game, a.ref);
      if (!city) return fail(env, `no city of yours is ${a.ref.xy ? 'at ' + at(a.ref.xy) : `called "${a.ref.name}"`} — yours are ${(game.castles || []).map((c) => c.name).join(', ')}`);
      if ((game.castles || []).length <= 1) return fail(env, `${city.name} is your only city — it cannot be given up`);
      const xy = game.castleXY(city);
      const heroes = (city.heros || []).filter((h) => [0, 1, 2].includes(n(h.status)));
      const troops = Object.values(city.troop || {}).reduce((s, v) => s + (Number(v) > 0 ? Number(v) : 0), 0);
      const out = armiesFrom(game, city);
      const lost = [];
      if (heroes.length) lost.push(`${heroes.length} hero${heroes.length === 1 ? '' : 'es'} (${heroes.map((h) => h.name).join(', ')})`);
      if (troops) lost.push(`${fmt(troops)} troops`);
      if (out.length) lost.push(`${out.length} march${out.length === 1 ? '' : 'es'} out`);
      if (lost.length && !a.anyway) {
        return fail(env, `${city.name} still has ${lost.join(', ')} — they would be lost. Evacuate it first (evacuatetown x,y confirm), `
          + `move the heroes out and wait for the marches; or add the word anyway: abandontown ${refText(a.ref)} confirm anyway`);
      }
      const kept = registryWhy(env, game, city);
      if (kept) return fail(env, kept);
      // The client sends SHA1 of the password (GiveupCastle.as:417), which only
      // the goals update's login keeps (evony.js passwordHash); the plain
      // password is never sent, and the hash is never logged.
      if (!(game.c && typeof game.c.passwordHash === 'function')) {
        return fail(env, 'abandontown needs the goals update (goals/integration) — the game asks for the account password (its SHA1)'
          + ' to give a city up, and only that build keeps the login\'s hash');
      }
      env.log(`  give up ${city.name}${xy ? ` (${at(xy)})` : ''} for good${lost.length ? ', losing ' + lost.join(', ') : ''}`);
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      const password = game.c.passwordHash();
      if (!password) return fail(env, 'this session never logged in with a password, so it cannot confirm giving a city up — nothing sent');
      const cid = game.castleId(city);
      const ownCity = n(cid) === n(env.cid);           // asked first: once it is gone, the run's city is too
      // reqProtected: the game answers -200 when this account's security code
      // protects "Abandon cities" (bit 2). Nothing is given up on a -200 —
      // it unlocks with the stored code and sends it once more.
      const r = await game.giveUpCastle(cid, password);   // CityCommands.as:42-50, GiveupCastle.as:417
      env.log('  -> ' + env.say(r));
      // as goal-buildnpc does after its own abandon: the registry's row is handed back
      const s = env.session;
      if (r && r.ok === 1 && s && s.org && s.org.registry && s.account && s.account.id && typeof s.org.registry.markAbandoned === 'function') {
        try { s.org.registry.markAbandoned(s.account.id, n(city.fieldId)); } catch (e) { env.log('  city registry: ' + e.message); }
      }
      if (r && r.ok === 1 && ownCity) env.log('  that was the city this script runs in — the run ends here');
      return { done: 1, result: r && r.ok === 1 ? city.name : null, end: !!(r && r.ok === 1 && ownCity) };
    },
  },

  // Let a city the bot did NOT build be given up by hand.
  //
  // abandontown is default-deny: the city registry only ever marks a city
  // abandonable when buildnpc itself claimed the flat and built on it, so a city
  // founded by anything else (NEAT's npcbuild, the game's own client) can never
  // be let go — which is the right default, and wrong for exactly one case: a
  // throwaway flat-city that arrived from somewhere else.
  //
  // This is that case, and it is deliberately a SEPARATE command a person types,
  // naming the city. It only moves the registry row; abandontown still wants
  // OTTO_ALLOW_ABANDON_TOWN=1, `confirm`, an evacuated city and the account
  // password. The goal engine is unaffected: goal-buildnpc's canAbandon demands
  // origin==='buildnpc', and an adopted city is origin='adopted'.
  allowabandon: {
    usage: 'allowabandon <x,y | city> confirm [off]   — lets abandontown give up a city the bot did not build',
    parse(args) {
      const ws = words(args);
      let confirm = false, off = false;
      while (ws.length && ['confirm', 'off'].includes(lc(ws[ws.length - 1]))) {
        if (lc(ws.pop()) === 'confirm') confirm = true; else off = true;
      }
      const p = parseTownRef('allowabandon', ws);
      if (!p || p.used !== ws.length) throw new Error('allowabandon: usage  allowabandon <x,y | city> confirm   — a city name with spaces goes in quotes');
      if (!confirm) {
        throw new Error(`allowabandon: this marks ${refText(p.ref)} as a city abandontown may give up for good. `
          + `To do it, end the line with the word confirm: allowabandon ${refText(p.ref)} confirm`);
      }
      return { cmd: 'allowabandon', ref: p.ref, off };
    },
    async run(a, env) {
      const game = env.game;
      const city = cityByRef(game, a.ref);
      if (!city) return fail(env, `no city of yours is ${a.ref.xy ? 'at ' + at(a.ref.xy) : `called "${a.ref.name}"`} — yours are ${(game.castles || []).map((c) => c.name).join(', ')}`);
      const s = env.session;
      const reg = s && s.org && s.org.registry;
      const acct = s && s.account && s.account.id;
      if (!reg || !acct) return fail(env, 'allowabandon needs a console bound to an account — the city registry is per account');
      const fieldId = n(city.fieldId);
      const cid = n(game.castleId(city));
      const xy = game.castleXY(city);
      const where = `${city.name}${xy ? ` (${at(xy)})` : ''}`;
      if (a.off) {
        if (env.dryRun) { env.log(`  [dry run] ${where} would go back to protected`); return {}; }
        const r = reg.unadopt(acct, fieldId);
        if (!r.ok) return fail(env, `${where}: ${r.why}`);
        env.log(`  ${where} is protected again — abandontown will refuse it`);
        return { done: 1, result: city.name };
      }
      env.log(`  mark ${where} as a city abandontown may give up for good (castle ${cid})`);
      if (env.dryRun) { env.log('  [dry run] the registry was not changed'); return {}; }
      const r = reg.adopt(acct, fieldId, cid, city.name, `adopted by allowabandon at ${new Date().toISOString()}`);
      if (!r.ok) return fail(env, `${where}: ${r.why}`);
      env.log(`  done — now:  abandontown ${xy ? at(xy) : city.name} confirm`
        + (settings.allowAbandonTown ? '' : '   (this console has no OTTO_ALLOW_ABANDON_TOWN=1, so abandontown is still off in it)'));
      return { done: 1, result: city.name };
    },
  },

  evacuatetown: {
    usage: 'evacuatetown <x,y> confirm   — every troop, and all they can carry, reinforce x,y',
    parse(args) {
      const ws = words(args);
      const confirm = ws.length > 0 && lc(ws[ws.length - 1]) === 'confirm';
      if (confirm) ws.pop();
      const c = coordsIn(ws, 0, 'evacuatetown');
      if (!c || c.used !== ws.length) throw new Error('evacuatetown: usage  evacuatetown 111,222 confirm');
      if (!confirm) {
        throw new Error(`evacuatetown: this sends every troop in the city, with all the resources they can carry, to ${at(c.xy)} `
          + `(heroes stay). To do it, end the line with the word confirm: evacuatetown ${at(c.xy)} confirm`);
      }
      return { cmd: 'evacuatetown', target: c.xy };
    },
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      const fid = C.coordsToFieldId(a.target.x, a.target.y);
      if (n(castle.fieldId) === fid) return fail(env, `${at(a.target)} is ${castle.name} itself`);
      const troops = {};
      for (const [k, v] of Object.entries(castle.troop || {})) if (C.BY_KEY[k] && n(v) > 0) troops[k] = n(v);
      const keys = Object.keys(troops);
      if (!keys.length) return fail(env, `no troops in ${castle.name} to evacuate`);
      let p;
      try { p = await game.troopParams(env.cid); } catch { p = { marchSkill: n(game.marchSkillParam ?? 100), loadSkill: n(game.loadSkillParam) }; }
      const from = game.castleXY(castle);
      // without the Relief Station's speed: the longer march keeps more food back
      const ms = from ? C.marchTimeMs(from, a.target, keys, { marchSkill: p.marchSkill, driveSkill: p.driveSkill }) : null;
      // NewArmyWin.speedFood: each troop eats its food x 2 an hour of the march,
      // from the army's own hold; load is load x count x (1 + loadSkill/100)
      const perHour = keys.reduce((s, k) => s + C.BY_KEY[k].food * 2 * troops[k], 0);
      const needFood = ms ? Math.ceil((perHour * ms) / 3600000) : 0;
      const load = Math.floor(keys.reduce((s, k) => s + C.BY_KEY[k].load * troops[k], 0) * (1 + n(p.loadSkill) / 100));
      let space = Math.max(0, load - needFood);
      const res = castle.resource || {};
      const carry = {};
      for (const k of ['gold', ...RES_ORDER]) {
        let have = amountOf(res, k);
        if (k === 'food') have = Math.max(0, have - needFood);
        const take = Math.min(space, Math.floor(have));
        if (take > 0) { carry[k] = take; space -= take; }
      }
      // NewArmyWin.sendArmy (:2794-2805) refuses both: food the city lacks, and a hold too small for it
      if (ms !== null && amountOf(res, 'food') < needFood) return fail(env, `the march eats ${fmt(needFood)} food and ${castle.name} has ${fmt(amountOf(res, 'food'))}`);
      if (needFood > load) return fail(env, `the march eats ${fmt(needFood)} food, more than these troops carry (${fmt(load)}) — the game refuses it; send them in parts with reinforce`);
      const resText = Object.entries(carry).map(([k, v]) => `${k} ${fmt(v)}`).join(', ') || 'no resources';
      env.log(`  evacuate ${castle.name}: ${troopText(troops)} with ${resText} to ${at(a.target)} — reinforce, no hero (heroes stay)`
        + `${ms !== null ? `; march ${dur(ms / 1000)}, eats ${fmt(needFood)} food` : ''}`);
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      const bean = game.buildArmyBean({ missionType: C.MISSION.reinforce, targetPoint: fid, troops, resources: carry });
      const r = await game.newArmy(env.cid, bean);                       // army.newArmy (ArmyCommands.as:92-103)
      env.log('  -> ' + env.say(r));
      if (r && r.ok === 1) (env.state.evacuations = env.state.evacuations || []).push({ castleId: env.cid, fid });
      return { done: 1, result: r && r.ok === 1 ? Object.values(troops).reduce((s, v) => s + v, 0) : 0 };
    },
  },

  endevacuate: {
    usage: 'endevacuate [x,y]   — recalls the evacuation march(es) from this city',
    parse(args) {
      const ws = words(args);
      if (!ws.length) return { cmd: 'endevacuate', target: null };
      const c = coordsIn(ws, 0, 'endevacuate');
      if (!c || c.used !== ws.length) throw new Error('endevacuate: usage  endevacuate [x,y]');
      return { cmd: 'endevacuate', target: c.xy };
    },
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      const fids = a.target ? [C.coordsToFieldId(a.target.x, a.target.y)]
        : (env.state.evacuations || []).filter((e) => n(e.castleId) === n(env.cid)).map((e) => e.fid);
      if (!fids.length) return fail(env, 'endevacuate: which evacuation? — endevacuate x,y (this run sent none from this city)');
      const list = armiesFrom(game, castle).filter((x) => n(x.direction) === 1 && n(x.missionType) === C.MISSION.reinforce && fids.includes(n(x.targetFieldId)));
      if (!list.length) { env.log('  no evacuation march of this city is still on its way'); return { ok: true, result: 0 }; }
      const k = await recallAll(env, castle, list);
      return { done: env.dryRun ? 0 : list.length, result: k };
    },
  },

  // buildcity 123,456   -- capture the flat if need be, then found a city on it
  buildcity: {
    aliases: ['newcity'],
    usage: 'buildcity <x,y> [hero] [troops]',
    parse(args, { word }) {
      const ws = words(args);
      const c = coordsIn(ws, 0, word);
      if (!c) throw new Error(`${word}: expected coords like 123,456`);
      let hero = null, troops = null;
      for (const w of ws.slice(c.used)) {
        if (w.includes(':')) { if (troops) throw new Error(`${word}: one troop string`); troops = W.parseTroops(w); continue; }
        if (hero) throw new Error(`${word}: unexpected "${w}" — usage  ${word} <x,y> [hero] [troops]`);
        hero = w;
      }
      return { cmd: 'buildcity', target: c.xy, hero, troops };
    },
    run: runBuildCity,
  },

  cancelbuildcity: {
    usage: 'cancelbuildcity [x,y]',
    parse(args) {
      const ws = words(args);
      if (!ws.length) return { cmd: 'cancelbuildcity', target: null };
      const c = coordsIn(ws, 0, 'cancelbuildcity');
      if (!c || c.used !== ws.length) throw new Error('cancelbuildcity: usage  cancelbuildcity [x,y]');
      return { cmd: 'cancelbuildcity', target: c.xy };
    },
    async run(a, env) {
      const game = env.game;
      const who = accountKey(game);
      const fid = a.target ? C.coordsToFieldId(a.target.x, a.target.y) : null;
      const hits = [...PENDING.entries()].filter(([k, e]) => k.startsWith(who + ':') && (fid === null || e.fid === fid));
      if (!hits.length) { env.log(`  no city build is waiting${a.target ? ` at ${at(a.target)}` : ''}`); return { ok: true, result: 0 }; }
      let k = 0;
      for (const [key, e] of hits) {
        env.log(`  cancel the city build at ${e.where} (from ${e.city})`);
        const home = (game.castles || []).find((c) => n(game.castleId(c)) === n(e.castleId));
        const marching = home ? armiesFrom(game, home).filter((x) => n(x.direction) === 1 && n(x.targetFieldId) === e.fid) : [];
        if (env.dryRun) { env.log(`  [dry run] not cancelled${marching.length ? ', its capture march not recalled' : ''}`); continue; }
        e.cancelled = true;
        PENDING.delete(key);
        k++;
        if (marching.length) await recallAll(env, home, marching);
      }
      return { ok: true, result: k, done: env.dryRun ? 0 : k };
    },
  },

  // Coordinates spend an Advanced Teleporter (a Pioneer Express Teleport first,
  // when held), a state name or `random` a City Teleporter, and warteleport a
  // War Teleporter; see teleport.js.
  teleport: {
    aliases: ['warteleport'],
    usage: 'teleport <x,y> | teleport <state> | teleport random | warteleport <x,y>   [from <city>]',
    parse(args, { word, tok }) {
      return { cmd: 'teleport', ...require('./teleport').parseArgs(word, tok.slice(1)) };
    },
    async run(a, env) {
      if (a.kind === 'adv' && n(heldCount(env.game, PIONEER)) > 0) return runPioneer(a, env);
      const moved = await require('./teleport').run(env.game, a, { castle: env.opts.castle, session: env.session, dryRun: env.dryRun, log: env.log });
      return { done: moved ? 1 : 0, ok: !!moved || env.dryRun };
    },
  },

  autoteleport: {
    usage: 'autoteleport [<state> | random] [all confirm] [/tries=5] [/every=5:00] [/norecall]',
    parse(args) {
      const { sw, rest } = takeSwitches(words(args), ['tries', 'every', 'norecall'], 'autoteleport');
      let all = false, confirm = false;
      const left = rest.filter((w) => {
        if (lc(w) === 'all') { all = true; return false; }
        if (lc(w) === 'confirm') { confirm = true; return false; }
        return true;
      });
      // every city recalls its armies and spends a City Teleporter: not one typo away
      if (all && !confirm) {
        throw new Error(`autoteleport: "all" recalls every city's armies and spends a City Teleporter on each city not there yet — `
          + `end the line with confirm to mean it: autoteleport ${left.join(' ') || 'tuscany'} all confirm`);
      }
      if (confirm && !all) throw new Error('autoteleport: confirm goes with all (autoteleport tuscany all confirm) — one city needs no confirm');
      let zone = null, random = false;
      if (left.length) {
        const k = zoneKey(left.join(''));
        if (k === 'random') random = true;
        else {
          zone = ZONE_BY_KEY.get(k);
          if (!zone) throw new Error(`autoteleport: "${left.join(' ')}" is no state — ${C.ZONES.join(', ')}, or random`);
        }
      }
      const tries = sw.tries === undefined ? 5 : parseInt(sw.tries, 10);
      if (!(tries >= 1 && tries <= 50)) throw new Error('autoteleport: /tries=<1-50>');
      let every = 300;
      if (sw.every !== undefined) {
        const e = String(sw.every);
        every = /:/.test(e) ? W.parseDuration(e, 'autoteleport /every') : parseFloat(e);
        if (!(every >= 0)) throw new Error('autoteleport: /every=5:00 (m:ss) or seconds');
      }
      return { cmd: 'autoteleport', zone, random, all, tries, every, norecall: !!sw.norecall };
    },
    run: runAutoTeleport,
  },

  // NEAT's canceltroopqueues / cancelfortifications [n]: leave n batches, cancel
  // the rest. See queue-cancel.js.
  cancelqueue: {
    words: Object.keys(require('./queue-cancel').COMMANDS),
    usage: 'canceltroopqueues [n] | cancelfortifications [n]',
    parse(args, { word, tok }) {
      return { cmd: 'cancelqueue', ...require('./queue-cancel').parseArgs(word, tok.slice(1)) };
    },
    async run(a, env) {
      const n2 = await require('./queue-cancel').run(env.game, a, { castle: env.opts.castle, session: env.session, dryRun: env.dryRun, log: env.log });
      forget(env.game, a.kind === 'wall' ? 'wallq:' : 'troopq:');
      return { done: n2 ? 1 : 0 };
    },
  },
};

// build and demosite parse into create and demo
commands.build.run = runCreate;
commands.demosite.run = runDemo;

module.exports = {
  commands, tokens,
  // for tests and other modules
  settings, words, speedupItem, parseConstruction, parseTrain, parseWallDefense, comfortTypeOf, levyTypeOf,
  unmetOf, freePreset, VALLEY_TROOPS, PENDING,
};
