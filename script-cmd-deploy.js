'use strict';
// Marches for scripts (the command-module contract is at the top of script.js),
// and NEAT's background attacks, which deploy-loops.js runs.
//
//   attack 111,222 any a:1000                   at once, with the strongest idle attack hero
//   attack 111,222 any a:1000 @00:30:00         camp 30 minutes first (@ or a bare h:mm:ss / m:ss)
//   attack 111,222 any a:1000 s:100 @:18:20:20  land at 18:20:20 on this machine's clock
//                                               (timed-march.js lands it to the ms, checks the
//                                               server's stamp, and recalls and resends a miss)
//   attack 111,222 any s:125k /big              /big spends a War Ensign (25% more troops) — one you
//                                               hold: it is never bought for you
//   attack 111,222 any s:1m /horde              /horde ticks the march window's Horde box; both: 12.5x
//   attack 111,222 !Biggy,any:attack>180 c:99k,s:1k      any hero string (see below)
//   bigattack 111,222 any a:125000              = attack ... /big; also bigscout, bigtransport,
//                                               bigreinforce and bigdeploy
//   scout 111,222 ken s:100000 | scout 111,222 none s:25000
//   scout 111,222                               no hero, 1 scout (CompleteQuests' "Scout city")
//   transport 111,222 t:1000 f:999998           more than the troops can carry is refused (below)
//   reinforce 111,222 none t:100 f:10000 @:9:30 | reinforce 111,222 ken a:90000,w:10000
//   reinforce Fla                               a city of yours by name; no hero, 1 scout
//   reinforce "Home City" none a:500 wood:50k,food:20k
//   deploy <type> 111,222 none w:25000 f:100000 1:30:00
//     type: at atk attack | bu bld build buildcity construct (a build-city march) | re rei reinforce
//           | sc sct scout | tr transport
//   deploy bu 123,456 any wo:500 f:26k,l:26k,s:26k,i:12k,g:10k @:14:30:07.500
//   ... from <city>                             any march, from another city of yours
//
//   troops first, resources second: s: and w: are scouts and warriors in the first
//   list, stone and wood in the second (f w/l s i g, or full names). NEAT's troop
//   words work: arch:25000,warr:25000, cav:, ram:/br:, pult:, trans:, phract:.
//   Attack and scout need a hero word (a name, any, a hero string, or none) —
//   except a scout of bare coordinates (1 scout, no hero); reinforce and
//   transport go without one when none is named. Resources that
//   more than fill the troops' hold, less the march's food, are refused before
//   anything goes (NewArmyWin.sendArmy refuses the same); when the city's
//   Logistics cannot be read, it is sent with a warning and the server decides.
//
// Hero strings (NEAT's HeroString, goal-heroes.js grammar) wherever a line names a hero:
//   ken | bob,fred | !Biggy,any:attack>180 | any:attack=best | any:base>60,attack<300
//   bob,fred|any:attack>=60 | att*:attack>200 | att??int:base>=69 | none
//   fields attack|att politics|pol intel|int loyalty|loy level|lvl experience|exp points|pts
//   base|bse, compared with < > = != <> <= >= to a number (20k), another field, best or worst.
//   Only an idle hero of the city goes — never one that is out, the mayor or a prisoner,
//   and not one this script sent in the last minute. Named heroes go in the order
//   written; with `any`, an attack takes the strongest attack hero. best and worst
//   compare against every hero of the city. The string is checked when the script
//   loads; a bare number (100) is refused, as NEAT does.
//
//   recall 111,222                  every army of yours on its way to (or staying at) 111,222
//   recallall                       every army that left this city and is not on its way home
//   idrecall 100333040              that army
//   recallhero Fred | recallhero any:att=best      a hero of this city that is out (one per line)
//   waithero ken | waithero any:attack>=200        wait until one is in this city and free
//   waitherolost ken,henry          wait until one of them is no longer yours (captured)
//   travelinfo 111,222 cav:10,cata:10 [from <city>]   distance, attack and reinforce times,
//                                   what the troops carry, and what is left after march food
//   getspamhero [power|atk | management|pol | stratagem|int]   = hire best (the inn's best hero)
//   heroroute                       where the traininghero goes from each city
//   setballsused ...                NEAT's own wiki retired it: config ballsused:<n> in the goals
//
// Background attacks (deploy-loops.js). The line starts one and the script carries
// on; it keeps going after the script ends. The console's Stop ends the script,
// not these: the end... lines (or attackstatus to see them) do.
//   spamattack 111,222 c:500,s:500 10         10 waves, each with an idle SpamHero at 100 loyalty
//   loyaltyattack 111,222 s:100,c:5k | loyaltyattack 111,222 3000   a wave every 30 s until a
//                                   report shows loyalty 7 or lower (3000 = cavalry; default 500)
//   capture 111,222 s:100,c:5k | capture 111,222 3000               ... until the city is taken
//                                   both stop after 100 waves or 12 hours: /waves=N /hours=N change it
//   guardedattack 111,222 cav:99000,s:1000 10 a:500000 ab:1     an attack now, and 10 scouts timed
//                                   to land 15-30 s ahead of it; the attack is recalled if the
//                                   scouts die, bring no report, or see a:500000 OR ab:1 or more
//   setguard 111,222 a:60000,cav:50000 ab:100   the same watch over an attack and scout already sent
//   endspamattack | endloyaltyattack | endguardedattack [all]   this city's (all: every city's)
//   One of each kind per target and city: the same line again while it runs starts nothing
//   and says how to end it; a console runs 10 background attacks at most.
//   attackstatus                    the background attacks running
//   SpamHeroes are this city's spamheroes goal lines, or NEAT's default any:base<=69,level<50.
//
//   buildstatus                     build marches on the way, by landing second (city-build.js)
//   marchcheck                      the march formula against the server's times for every march out
const C = require('./constants');
const W = require('./script-words');
const H = require('./goal-heroes');
const { Game } = require('./game');

// deploy's march types: NEAT's Deploy (at bu re sc), BigDeploy (atk bld rei sct),
// our tr, and the full names.
const DEPLOY = {
  at: 'attack', atk: 'attack', attack: 'attack',
  bu: 'construct', bld: 'construct', build: 'construct', buildcity: 'construct', construct: 'construct',
  re: 'reinforce', rei: 'reinforce', reinforce: 'reinforce',
  sc: 'scout', sct: 'scout', scout: 'scout',
  tr: 'transport', transport: 'transport',
};
const BIG = { bigattack: 'attack', bigscout: 'scout', bigtransport: 'transport', bigreinforce: 'reinforce', bigdeploy: 'deploy' };

// NewArmyWin.onNewArmyResponse:1677-1681: a march with the useFlag box ticked
// used "player.troop.1.a", the War Ensign.
const ENSIGN = 'player.troop.1.a';

// A War Ensign that is not held is bought with cents when the march goes, so
// /big goes only while the loaded inventory shows one — less those this run
// used whose ItemUpdate push has not landed yet (script-cmd-city.js counts its
// items down the same way). -> the count that may be used, or null (not loaded).
function ensignsHeld(game) {
  const items = game.player && game.player.items;
  if (!Array.isArray(items)) return null;
  const it = items.find((x) => x && x.id === ENSIGN);
  return it ? Number(it.count) || 0 : 0;
}
function ensignsLeft(env, game) {
  const held = ensignsHeld(game);
  if (held === null) return null;
  const s = env.state.ensigns;
  if (s && s.at === held) return Math.max(0, held - s.used);   // no push since: count them off here
  if (s) delete env.state.ensigns;                             // a push landed: the list is right again
  return held;
}
// After a /big march went: `before` is the count seen before it was sent.
function usedEnsign(env, game, before) {
  const held = ensignsHeld(game);
  if (held === null || before === null || held !== before) return;   // the push already counted it
  const s = env.state.ensigns;
  if (s && s.at === held) s.used++; else env.state.ensigns = { at: held, used: 1 };
}

// timed-march.js keeps the game it is handed through its waits (to the ms of
// the send); this view reads the run's live Game on every use, so a reconnect
// during the wait sends on the new connection, as env.game does.
function liveGame(env) {
  return new Proxy({}, {
    get: (_, k) => { const g = env.game; const v = g[k]; return typeof v === 'function' ? v.bind(g) : v; },
    set: (_, k, v) => { env.game[k] = v; return true; },
    has: (_, k) => k in env.game,
  });
}

const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const p2 = (n) => String(n).padStart(2, '0');

// A march target given by name is one of your own cities, matched whole.
function ownCity(game, name) {
  const c = (game.castles || []).find((x) => String(x.name || '').toLowerCase() === String(name).toLowerCase());
  if (c) return c;
  throw new Error(`no city of yours is called "${name}" — yours are ${(game.castles || []).map((x) => x.name).join(', ')}.`
    + ' Give x,y for anywhere else, and put a name with spaces in quotes');
}

// "123,456" -> {x, y}; the map is 800 x 800 (constants.js MAP_W).
function coordsOf(t, what) {
  const m = String(t).match(/^(\d+),(\d+)$/);
  if (!m) return null;
  const x = +m[1], y = +m[2];
  if (x >= C.MAP_W || y >= C.MAP_W) throw new Error(`${what}: ${t} is off the map — x and y run 0-${C.MAP_W - 1}`);
  return { x, y };
}

// "123, 456" and "a:100, c:500" read the same as without the spaces.
const wordsOf = (line) => (String(line).replace(/\s*,\s*/g, ',').match(/"[^"]*"|\S+/g) || []).map((w) => w.replace(/^"(.*)"$/, '$1'));
const isList = (t) => /^[a-z]+:[\d.]+[kmb]?(,[a-z]+:[\d.]+[kmb]?)*$/i.test(t);
const codesOf = (t) => t.split(',').map((p) => p.split(':')[0].toLowerCase());
const allTroops = (t) => isList(t) && codesOf(t).every((c) => W.troopByWord(c));
const allRes = (t) => isList(t) && codesOf(t).every((c) => W.resourceByWord(c));
const allForts = (t) => isList(t) && codesOf(t).every((c) => W.fortByWord(c));
const isTime = (t) => t.startsWith('@') || /^\d+:\d{2}(:\d{2})?$/.test(t);

// "at:19000,ab:1" -> { tower: 19000, abatis: 1 } (WALLS codes)
function parseForts(s, what) {
  const out = {};
  for (const part of String(s).split(',')) {
    const m = part.trim().match(/^([a-z]+)\s*:\s*([\d.]+[kmb]?)$/i);
    const f = m && W.fortByWord(m[1]);
    if (!f) throw new Error(`${what}: "${part}" is not a fortification — at (arrow tower), ab (abatis), tre (trebuchet), tra (trap), r (rolling logs)`);
    out[f.code] = W.num(m[2]);
  }
  return out;
}

// ------------------------------------------------------------- hero strings

// goal-heroes reads base as attribute − *Added, and the live roster sends 0 for
// every *Added field, so there it comes out as the attribute itself (a level-40
// hero with 100 attack reads as base 100). Game.heroBase is what the roster
// supports: the top attribute less the point a level gave it, unspent points
// added back. Every other field is goal-heroes' own.
const fieldOf = (name) => (name === 'base' || name === 'bse' ? (h) => Game.heroBase(h) : H.FIELDS[name]);
function cmp(op, a, b) {
  switch (op) {
    case '>': return a > b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    case '=': return a === b;
    case '!=': return a !== b;
    default: return false;
  }
}
// goal-heroes' matchHero, with that base.
function altMatches(h, alt, pool) {
  if (alt.none) return false;
  const name = String(h.name || '');
  if (alt.excludes.some((e) => e.re.test(name))) return false;
  if (!alt.any && !alt.names.some((n) => n.re.test(name))) return false;
  for (const f of alt.filters) {
    const read = fieldOf(f.field);
    let right;
    if (f.rhs.kind === 'num') right = f.rhs.value;
    else if (f.rhs.kind === 'field') right = fieldOf(f.rhs.field)(h);
    else {
      const vals = pool.map(read).filter((v) => Number.isFinite(v));
      if (!vals.length) return false;
      right = f.rhs.kind === 'best' ? Math.max(...vals) : Math.min(...vals);
    }
    if (!cmp(f.op, read(h), right)) return false;
  }
  return true;
}
const parsedOf = (spec) => (spec && typeof spec === 'object' ? spec : H.parseHeroString(spec));
function heroMatches(h, spec, pool) {
  const p = parsedOf(spec);
  if (!p || p.errors.length || !p.alts.length) return false;
  return p.alts.some((a) => altMatches(h, a, pool && pool.length ? pool : [h]));
}

// A hero string on a script line, checked when the script loads.
function checkHeroString(spec, what) {
  const p = H.parseHeroString(spec);
  if (p.errors.length) throw new Error(`${what}: hero string "${spec}" — ${p.errors[0]}`);
  return p;
}

const statusOf = (h) => Number(h.status || 0);
// A prisoner we hold (status 4) is not ours to send, and it does not count for best/worst.
const oursOf = (castle) => (castle.heros || []).filter((h) => statusOf(h) !== H.STATUS.CAPTIVE);

// Heroes this console sent lately, per connection: the HeroUpdate saying they are
// away can come after the next line, or after a background wave. Scripts and
// deploy-loops.js both write here; env.sentHeroes is the run's own list.
const RECENT = new WeakMap();
const recentOf = (game) => { let m = RECENT.get(game); if (!m) { m = new Map(); RECENT.set(game, m); } return m; };
function markSent(game, heroId, sentHeroes) {
  if (heroId === undefined || heroId === null) return;
  recentOf(game).set(heroId, Date.now());
  if (sentHeroes) sentHeroes.set(heroId, Date.now());
}
function recentSkip(game, sentHeroes) {
  const skip = new Set();
  for (const m of [recentOf(game), sentHeroes || new Map()]) for (const [id, at] of m) if (Date.now() - at < 60000) skip.add(id);
  return skip;
}

// Named heroes in the order written; after them, with `any`, the strongest
// attack first on an attack, else the roster's order.
function rankHeroes(list, parsed, attackFirst) {
  const order = [];
  for (const alt of parsed.alts) for (const n of alt.names) order.push(n.re);
  const pos = (h) => { const i = order.findIndex((re) => re.test(String(h.name || ''))); return i < 0 ? order.length : i; };
  const att = (h) => Number(h.power || 0);
  return list.map((h, i) => ({ h, i }))
    .sort((a, b) => (pos(a.h) - pos(b.h)) || (attackFirst ? att(b.h) - att(a.h) : 0) || (a.i - b.i))
    .map((x) => x.h);
}

// The hero a march takes: idle, in this city, matching the string. null for
// none. Throws, saying who matched and why they cannot go, when no one can.
// keep: the hero of an earlier try of the same march, recalled and home again,
// whose status the server may not have pushed back to idle yet.
function pickHero(castle, spec, { skip = null, attackFirst = false, keep = null } = {}) {
  const parsed = parsedOf(spec);
  if (parsed.errors.length) throw new Error(`hero string "${parsed.src}" — ${parsed.errors[0]}`);
  if (parsed.isNone) return null;
  const roster = castle.heros || [];
  if (!roster.length) throw new Error(`no heroes in ${castle.name}`);
  const ours = oursOf(castle);
  const hits = ours.filter((h) => heroMatches(h, parsed, ours));
  const free = (h) => (keep !== null && h.id === keep && [0, 3, 5].includes(statusOf(h)))
    || (statusOf(h) === H.STATUS.IDLE && !(skip && skip.has(h.id)));
  const idle = hits.filter(free);
  if (idle.length) return rankHeroes(idle, parsed, attackFirst)[0];
  if (!hits.length) throw new Error(`no hero in ${castle.name} matches ${parsed.src}`);
  const why = hits.map((h) => `${h.name} ${statusOf(h) === H.STATUS.IDLE ? 'was sent by this script under a minute ago'
    : 'is ' + (H.STATUS_NAME[statusOf(h)] || 'busy')}`);
  throw new Error(`no idle hero in ${castle.name} matches ${parsed.src} — ${why.slice(0, 6).join(', ')}${why.length > 6 ? ', …' : ''}`);
}

// ----------------------------------------------------------------- marches

// <mission> <where> [hero] [troops] [resources] [time] [/big] [/horde] [from <city>]
//   where  x,y, or one of your cities by name ("Home City" in quotes)
//   hero   a hero string (a name, any, any:level<500,attack>400, !bob,any, ...) or none
//   time   @:14:30:07.500 lands then (timed-march.js); @0:30:00 or 0:30:00 camps that long
// `deploy <type> ...` is NEAT's general form of the same line; type bu is a
// build-city march. big* words and /big spend a War Ensign. Attack and scout
// need a hero word, a build needs troops. Reinforce and transport go without a
// hero if none is named, and a reinforce with no troop string sends 1 scout.
// (script-cmd-market.js's dumpresource calls this with a transport line.)
function parseMarch(word, line, tok) {
  word = String(word).toLowerCase();
  let big = !!BIG[word];
  const base = BIG[word] || word;
  const deploy = base === 'deploy';
  const words = wordsOf(line).slice(deploy ? 1 : 0);
  const type = deploy ? String(words[0] || '').toLowerCase() : null;
  const mission = deploy ? DEPLOY[type] : base;
  if (deploy && !mission) {
    throw new Error(`${word}: say the march type first — at (attack), bu (build city), re (reinforce), sc (scout), tr (transport)`
      + (word === 'bigdeploy' ? '; atk, bld, rei and sct too' : ''));
  }
  const name = deploy ? `${word} ${type}` : word;

  const where = words[1] || '';
  if (!where || /^(any|none)(:|$)/i.test(where) || isTime(where) || /^from$/i.test(where) || isList(where) || where.startsWith('/')) {
    throw new Error(`${name}: say where first — coords like 123,456, or one of your cities by name`);
  }
  const target = coordsOf(where, name);
  const targetCity = target ? null : where;
  if (mission === 'construct' && !target) throw new Error(`${name}: a build march goes to a flat's coordinates, like 123,456`);

  // No hero sends no heroId at all; see Game.buildArmyBean.
  let from = null, land = null, camp = null, hero, troops = null, resources = null, horde = false;
  for (let i = 2; i < words.length; i++) {
    const t = words[i];
    const lt = t.toLowerCase();
    if (lt === 'from') {
      from = words[++i];
      if (!from) throw new Error(`${name}: "from" needs a city name after it`);
      continue;
    }
    if (lt === '/big') { big = true; continue; }
    if (lt === '/horde') { horde = true; continue; }
    if (t.startsWith('/')) throw new Error(`${name}: "${t}" — the switches are /big (a War Ensign) and /horde`);
    if (isTime(t)) {
      if (land || camp !== null) throw new Error(`${name}: one time per march — @:hh:mm:ss to land then, or a camp time`);
      if (t.startsWith('@:')) land = W.parseLandTime(t); else camp = W.parseDuration(t);
      continue;
    }
    if (isList(t)) {
      // NEAT reads troops first and resources second, so in a later list
      // s: and w: are stone and wood, not scouts and warriors.
      if (troops === null && allTroops(t)) { troops = W.parseTroops(t); continue; }
      if (allRes(t)) { resources = { ...resources, ...W.parseResources(t) }; continue; }
      if (allTroops(t)) { troops = { ...troops, ...W.parseTroops(t) }; continue; }
      throw new Error(`${name}: "${t}" is neither a troop string nor a resource string`);
    }
    if (hero === undefined) {
      checkHeroString(t, name);
      hero = lt === 'none' ? null : t;
      continue;
    }
    throw new Error(`${name}: unexpected "${t}" — one hero per march${targetCity ? ', and a city name with spaces goes in quotes' : ''}`);
  }
  let troopsDefault = false;
  // `scout 111,222` alone (the CompleteQuests page's `scout {castle.coords}`, for
  // the "Scout city" quest): no hero and one scout, the smallest scouting march
  if (mission === 'scout' && hero === undefined && !troops) {
    hero = null;
    troops = { scouter: 1 };
    troopsDefault = true;
  }
  if ((mission === 'attack' || mission === 'scout') && hero === undefined) {
    throw new Error(`${name}: needs a hero — a name, any, a hero string like any:level<500,attack>400, or none to send it without one`);
  }
  if (!troops) {
    if (mission !== 'reinforce') throw new Error(`${name}: no troop string (e.g. a:1000,c:500${mission === 'construct' ? ', or wo:500 for a build' : ''})`);
    troops = { scouter: 1 };
    troopsDefault = true;
  }
  const out = { cmd: mission, target, targetCity, hero: hero || null, troops, troopsDefault, resources, land, camp, from };
  if (big) out.big = true;
  if (horde) out.horde = true;
  return out;
}

// What troops carry and eat (NewArmyWin.speedFood:2852-2853, :3102-3107,
// timeInPutChange:1716-1719): load x count x (1 + loadSkillParam/100) of hold,
// and foodRequest x 2 an hour on the march or in camp, carried in that same
// hold: leftSpace = loads - needFood - resources (carryResouce:3415).
const capacityOf = (troops, loadSkill) => Object.entries(troops)
  .reduce((s, [k, n]) => s + (C.BY_KEY[k] ? C.BY_KEY[k].load * Number(n || 0) * (1 + Number(loadSkill) / 100) : 0), 0);
const foodPerHour = (troops) => Object.entries(troops)
  .reduce((s, [k, n]) => s + (C.BY_KEY[k] ? C.BY_KEY[k].food * 2 * Number(n || 0) : 0), 0);
const troopTextOf = (troops) => Object.keys(troops).filter((k) => troops[k] > 0)
  .map((k) => `${fmt(troops[k])} ${(C.BY_KEY[k] || {}).name || k}`).join(', ');

// army.getTroopParam for the sending city (Game.troopParams, cached), or the
// login's values; known says whether it is the city's own answer.
async function paramsFor(game, castle) {
  try {
    const p = await game.troopParams(game.castleId(castle));
    if (p) return { ...p, known: true };
  } catch { /* fall through */ }
  const m = Number(game.marchSkillParam ?? 100);
  return { marchSkill: m, driveSkill: m, loadSkill: Number(game.loadSkillParam), relief: 0, known: false };
}

async function runMarch(a, env) {
  const game = env.game;
  const log = env.log;
  const dryRun = env.dryRun;
  const castle = game.castle(a.from ?? env.opts.castle);
  const from = game.castleXY(castle);
  const toCity = a.targetCity ? ownCity(game, a.targetCity) : null;
  const target = toCity ? game.castleXY(toCity) : a.target;
  if (!target) throw new Error(`cannot tell where ${toCity.name} is`);
  if (toCity && game.castleId(toCity) === game.castleId(castle)) throw new Error(`${toCity.name} is the city this march would leave from`);
  const targetPoint = C.coordsToFieldId(target.x, target.y);
  const troopKeys = Object.keys(a.troops).filter((k) => a.troops[k] > 0);
  const construct = a.cmd === 'construct';
  if (construct) for (const n of require('./city-build').preflight(game, targetPoint)) log('  ' + n);

  if (a.big) {
    const left = ensignsLeft(env, game);
    if (left === null) {
      throw new Error('/big spends a War Ensign, and the inventory has not loaded, so whether one is held cannot be checked — nothing was sent'
        + ' (the game buys a missing one with cents)');
    }
    if (left < 1) {
      throw new Error(`/big spends a War Ensign, and you hold none${ensignsHeld(game) > 0 ? ' this run has not used already' : ''} — nothing was sent.`
        + ' It is never bought for you: buyitem first');
    }
  }

  const troopText = troopTextOf(a.troops);
  const carried = Object.values(a.resources || {}).reduce((s2, v) => s2 + v, 0);
  if (carried > 0) {
    // Refused only when it cannot fit even at the fastest march (the Relief
    // Station, no camp): the client's own window would not let it through.
    const p = await paramsFor(game, castle);
    const ls = Number(p.loadSkill);
    if (p.known && Number.isFinite(ls) && from) {
      const ms = C.marchTimeMs(from, target, troopKeys, {
        marchSkill: p.marchSkill, driveSkill: p.driveSkill, relief: Number(p.relief) > 1 ? p.relief : 0,
        castleBuffs: castle.buffs, playerBuffs: game.player && game.player.buffs, now: game.now(),
      }) || 0;
      const hold = capacityOf(a.troops, ls);
      const food = Math.floor(foodPerHour(a.troops) * (ms + (a.camp || 0) * 1000) / 3600000);
      const room = Math.floor(hold - food);
      if (carried > room) {
        throw new Error(`${troopText} carry ${fmt(hold)} with this city's research, less ${fmt(food)} food for the march`
          + ` — room for ${fmt(Math.max(0, room))}, and this asks for ${fmt(carried)}. Nothing was sent (the game's march window refuses it too);`
          + ' travelinfo shows what troops carry');
      }
    } else {
      const load = troopKeys.reduce((s2, k) => s2 + a.troops[k] * ((C.BY_KEY[k] || {}).load || 0), 0);
      if (carried > load) log(`  note: ${troopText} carry about ${load.toLocaleString('en-US')} before research, and this asks for ${carried.toLocaleString('en-US')} — the server may refuse`);
    }
  }

  // Built for each send, so a march that is recalled and sent again can take
  // another idle hero (or the same one, home again). The live Game and city:
  // a timed march is built after its wait, which a reconnect may have crossed.
  let hero = null;
  const makeBean = (restTimeSec) => {
    const prev = hero;
    const g = env.game;
    const home = g === game ? castle : g.castle(a.from ?? env.opts.castle);
    hero = a.hero ? pickHero(home, a.hero, { skip: recentSkip(g, env.sentHeroes), attackFirst: a.cmd === 'attack', keep: prev ? prev.id : null }) : null;
    const bean = g.buildArmyBean({
      missionType: C.MISSION[a.cmd],
      heroId: hero ? hero.id : undefined,
      targetPoint,
      troops: a.troops,
      resources: a.resources || {},
      restTimeSec,
    });
    // NewArmyWin.sendArmy:2785-2786 — the War Ensign and Horde boxes
    if (a.big) bean.useFlag = true;
    if (a.horde) bean.useItem = true;
    log(`  ${construct ? 'build city' : a.cmd} -> ${toCity ? toCity.name + ' ' : ''}(${target.x},${target.y}) field ${targetPoint} from ${castle.name}`
      + ` · hero ${hero ? (hero.name || hero.id) : 'none'} · ${troopText}${a.troopsDefault ? ' (no troop string given)' : ''} · missionType ${bean.missionType}`
      + (a.big ? ' · War Ensign' : '') + (a.horde ? ' · Horde' : ''));
    return bean;
  };

  // Land at a moment: sent to the ms, checked against the server's stamp,
  // and recalled and resent if it misses (timed-march.js).
  if (a.land) {
    if (!from) throw new Error('cannot compute march time (castle coords unknown) — @: needs it');
    const live = liveGame(env);
    const ensigns = a.big ? ensignsHeld(game) : null;
    const res = await require('./timed-march').send({
      game: live, castle, construct, from, target, targetPoint, toCity, troopKeys,
      aimMs: W.nextOccurrence(a.land, game.now()), makeBean, log, stopped: env.stopped, dryRun,
    });
    if (res.sent && hero) markSent(env.game, hero.id, env.sentHeroes);
    if (res.sent && a.big) usedEnsign(env, env.game, ensigns);
    // a Stop during the wait ends the run where it is
    return { done: res.sent ? 1 : 0, ok: !!res.sent || dryRun, end: res.why === 'stopped' };
  }

  const march = from ? C.marchTimeMs(from, target, troopKeys, game.marchSkillParam) : null;
  const restTimeSec = a.camp || 0;
  if (march !== null) {
    log(`  march ${(march / 1000).toFixed(1)}s` + (restTimeSec
      ? `, camp ${require('./timed-march').dur(restTimeSec * 1000)} (lands when the camp is over)`
      : ' (no @: time, lands on arrival)'));
  }
  const bean = makeBean(restTimeSec);
  if (dryRun) { log('  [dry run] not sent'); return {}; }
  const gs = env.game;                 // the reads above may have crossed a reconnect
  const ensigns = a.big ? ensignsHeld(gs) : null;
  const r = await gs.newArmy(gs.castleId(castle), bean);
  log('  -> ' + env.say(r));
  if (r && r.ok === 1 && hero) markSent(gs, hero.id, env.sentHeroes);
  if (r && r.ok === 1 && a.big) usedEnsign(env, gs, ensigns);
  return { done: 1 };
}

const march = (usage, aliases) => ({
  usage,
  ...(aliases ? { aliases } : {}),
  parse: (args, { word, line, tok }) => parseMarch(word, line, tok),
  run: runMarch,
});

// ------------------------------------------------------------------ recalls

const armiesOf = (game) => (game.player && game.player.selfArmys) || [];
// ArmyConstants: direction 1 forward, 2 backward (on its way home), 3 staying.
const recallable = (a) => Number(a.direction) === 1 || Number(a.direction) === 3;
const homeOf = (game, a) => (game.castles || []).find((c) => Number(c.fieldId) === Number(a.startFieldId)) || null;
const MISSION_NAME = Object.fromEntries(Object.entries(C.MISSION).map(([k, v]) => [v, k === 'construct' ? 'build' : k]));
function armyText(game, a) {
  const home = homeOf(game, a);
  const to = C.fieldIdToCoords(Number(a.targetFieldId));
  return `army ${a.armyId} (${MISSION_NAME[Number(a.missionType)] || 'march'} from ${home ? home.name : '?'} to ${a.targetPosName || ''}(${to.x},${to.y})`
    + `${a.hero ? ', hero ' + a.hero : ''}${Number(a.direction) === 3 ? ', staying there' : ''})`;
}

// army.callBackArmy {castleId, armyId} (ArmyCommands.as:105-116), the castle
// being the one the army left from. Returns how many went through.
async function recallArmies(env, list) {
  const game = env.game;
  let n = 0;
  for (const a of list) {
    const home = homeOf(game, a);
    if (!home) { env.log(`  ${armyText(game, a)}: cannot tell which city it left from — not recalled`); continue; }
    if (env.dryRun) { env.log(`  recall ${armyText(game, a)} — [dry run] not sent`); continue; }
    let r;
    try { r = await game.recallArmy(game.castleId(home), a.armyId); } catch (e) { r = { ok: 0, errorMsg: e.message }; }
    env.log(`  recall ${armyText(game, a)} -> ${env.say(r)}`);
    if (r && r.ok === 1) n++;
  }
  return n;
}

// ------------------------------------------------------------------- heroes

// The city's goals ({ goals, config }), or null with no goal store (tests, a
// bare run): the spamheroes and traininghero lines live there. The goals
// branch's goallayers.runningGoals (the script's goal layer too) when it is
// here, else the saved goals.
function cityGoals(session, game, castle) {
  const store = session && session.org && session.org.goals;
  if (!store) return null;
  const acct = session.account && session.account.id;
  try {
    if (typeof store.layers === 'function') {
      let GL = null;
      try { GL = require('./goallayers'); } catch { GL = null; }
      if (GL && typeof GL.runningGoals === 'function') return GL.runningGoals(store, acct, game.castleId(castle), castle.name);
    }
    if (typeof store.own !== 'function') return null;
    const entry = store.own(acct, game.castleId(castle), castle.name, 'goal');
    if (!entry || !String(entry.src || '').trim()) return { goals: [], config: {} };
    return require('./goals').parseGoals(entry.src);
  } catch { return null; }
}

// The SpamHeroes free in this city now -> { heroes, text }. goal-heroes'
// spamHeroPool when the goals branch has it, so goals and scripts choose alike
// (it also keeps the traininghero and keepatthome's heroes home); else
// spamRules below.
function spamPool(session, game, castle, { loyal = false, skip = null } = {}) {
  const running = cityGoals(session, game, castle);
  if (typeof H.spamHeroPool === 'function') {
    const p = H.spamHeroPool(castle, running || { goals: [], config: {} }, { minLoyalty: loyal ? 100 : null });
    const held = (p.held || []).map((x) => `${x.hero.name} (${x.why})`);
    return { heroes: (p.heroes || []).filter((h) => !(skip && skip.has(h.id))),
      text: `${p.rule}${p.usingDefault ? ' (NEAT\'s default — this city has no spamheroes goal)' : ''}${held.length ? '; held back: ' + held.join(', ') : ''}` };
  }
  const { rules, text } = spamRules(session, game, castle, running);
  return { heroes: spamHeroes(castle, rules, { skip, loyal }), text };
}

// SpamHeroes (wiki): this city's spamheroes lines (a /reset line clears the
// ones above it), or NEAT's default any:base<=69,level<50.
function spamRules(session, game, castle, running) {
  const parsed = running === undefined ? cityGoals(session, game, castle) : running;
  const rules = [];
  for (const g of (parsed && parsed.goals) || []) {
    if (g.name !== 'spamheroes') continue;
    if (g.reset) { rules.length = 0; continue; }
    if (g.spec && !(g.spec.errors || []).length) rules.push(g.spec);
  }
  if (rules.length) return { rules, text: rules.map((r) => r.src).join(' | ') };
  return { rules: [H.parseHeroString(H.DEFAULT_SPAM)], text: `${H.DEFAULT_SPAM} (NEAT's default — this city has no spamheroes goal)` };
}
// The idle SpamHeroes, in roster order. SpamAttack (wiki) also wants 100 loyalty.
function spamHeroes(castle, rules, { skip = null, loyal = false } = {}) {
  const ours = oursOf(castle);
  return ours.filter((h) => statusOf(h) === H.STATUS.IDLE && !(skip && skip.has(h.id))
    && (!loyal || Number(h.loyalty || 0) >= 100) && rules.some((r) => heroMatches(h, r, ours)));
}
const spamHero = (castle, rules, opts) => spamHeroes(castle, rules, opts)[0] || null;

// Waiting on heroes: one look every heroPollMs (tests make it short).
const TIMING = { heroPollMs: 2000, lostGraceMs: 10000 };

// ---------------------------------------------------------- the background

const loops = () => require('./deploy-loops');
// "loyaltyattack 111,222 3000" is 3000 cavalry; nothing is 500 cavalry.
function loopTroops(word, t) {
  if (t === undefined) return { lightCavalry: 500 };
  if (/^[\d.]+[kmb]?$/i.test(t)) return { lightCavalry: W.num(t) };
  if (!allTroops(t)) throw new Error(`${word}: "${t}" is not a troop string (e.g. s:100,c:5k), or a number of cavalry`);
  return W.parseTroops(t);
}
// loyaltyattack / capture stop after 100 waves or 12 hours (deploy-loops.js
// LIMITS) unless the line says: /waves=N (1-10000), /hours=N (up to a week).
function loopCaps(word, words) {
  const caps = {};
  const rest = words.filter((w) => {
    const m = /^\/(waves|hours)=([\d.]+)$/i.exec(w);
    if (!m) {
      if (w.startsWith('/')) throw new Error(`${word}: "${w}" — the switches are /waves=N (100 by default) and /hours=N (12 by default)`);
      return true;
    }
    const v = Number(m[2]);
    if (m[1].toLowerCase() === 'waves') {
      if (!Number.isInteger(v) || v < 1 || v > 10000) throw new Error(`${word}: /waves= takes a whole number of waves from 1 to 10000`);
      caps.maxWaves = v;
    } else {
      if (!(v > 0 && v <= 168)) throw new Error(`${word}: /hours= takes hours from above 0 to 168 (a week)`);
      caps.maxHours = v;
    }
    return false;
  });
  return { words: rest, caps };
}
function loopTarget(word, words) {
  const t = coordsOf(words[1] || '', word);
  if (!t) throw new Error(`${word}: say where first — coords like 111,222`);
  return t;
}
const ends = (kind) => ({
  usage: `${kind} [all]`,
  parse(args) {
    const w = String(args || '').trim().toLowerCase();
    if (w && w !== 'all') throw new Error(`${kind}: nothing goes after it but "all" (every city's, not just this one's)`);
    return { cmd: kind, all: w === 'all' };
  },
  async run(a, env) {
    const r = await loops().end(kind, a, env);
    for (const l of r.lines) env.log('  ' + l);
    return { ok: true, result: r.stopped };
  },
});
const startLoop = async (a, env) => {
  const r = await loops().start(a, env);
  for (const l of r.lines) env.log('  ' + l);
  return { ok: r.ok, error: r.error, result: r.id, done: r.done || 0 };
};

// ----------------------------------------------------------------- commands

const commands = {
  attack: march('attack <x,y | city> <hero> <troops> [resources] [@:hh:mm:ss | camp] [/big] [/horde] [from <city>]'),
  scout: march('scout <x,y | city> <hero | none> <troops> [@:hh:mm:ss | camp] [/big] [from <city>]'),
  transport: march('transport <x,y | city> [hero] <troops> <resources> [@:hh:mm:ss | camp] [/big] [from <city>]'),
  reinforce: march('reinforce <x,y | city> [hero] [troops] [resources] [@:hh:mm:ss | camp] [/big] [from <city>]'),
  bigattack: march('bigattack <x,y> <hero> <troops> [...] — attack with a War Ensign'),
  bigscout: march('bigscout <x,y> <hero | none> s:<scouts> [...] — scout with a War Ensign'),
  bigtransport: march('bigtransport <x,y | city> t:<transports> <resources> [...] — transport with a War Ensign'),
  bigreinforce: march('bigreinforce <x,y | city> [hero] [troops] [resources] [...] — reinforce with a War Ensign'),
  // a build-city march: only `deploy bu` makes one
  construct: { run: runMarch },
  deploy: {
    usage: 'deploy <at|bu|re|sc|tr> <x,y | city> [hero] <troops> [resources] [@:hh:mm:ss | camp] [/big] [/horde] [from <city>]',
    parse: (args, { line, tok }) => parseMarch('deploy', line, tok),
  },
  bigdeploy: {
    usage: 'bigdeploy <atk|bld|rei|sct|tr> <x,y | city> [hero] <troops> [resources] [time] — deploy with a War Ensign',
    parse: (args, { line, tok }) => parseMarch('bigdeploy', line, tok),
  },

  recall: {
    usage: 'recall <x,y | city>',
    parse(args, { line }) {
      const words = wordsOf(line);
      if (words.length !== 2) throw new Error('recall: usage  recall 111,222   (or a city of yours by name, in quotes if it has spaces)');
      const target = coordsOf(words[1], 'recall');
      return { cmd: 'recall', target, targetCity: target ? null : words[1] };
    },
    async run(a, env) {
      const game = env.game;
      const target = a.targetCity ? game.castleXY(ownCity(game, a.targetCity)) : a.target;
      const fid = C.coordsToFieldId(target.x, target.y);
      const list = armiesOf(game).filter((x) => recallable(x) && Number(x.targetFieldId) === fid);
      if (!list.length) { env.log(`  no army of yours is on its way to ${target.x},${target.y} (or staying there)`); return { ok: true, result: 0 }; }
      const n = await recallArmies(env, list);
      return { result: n, done: env.dryRun ? 0 : list.length };
    },
  },
  recallall: {
    usage: 'recallall',
    parse(args) {
      if (String(args || '').trim()) throw new Error('recallall: nothing goes after it — it recalls every army that left this city');
      return { cmd: 'recallall' };
    },
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      const list = armiesOf(game).filter((x) => recallable(x) && Number(x.startFieldId) === Number(castle.fieldId));
      if (!list.length) { env.log(`  no army from ${castle.name} is out (on its way, or staying somewhere)`); return { ok: true, result: 0 }; }
      const n = await recallArmies(env, list);
      return { result: n, done: env.dryRun ? 0 : list.length };
    },
  },
  idrecall: {
    usage: 'idrecall <armyId>',
    parse(args) {
      // the wiki writes !ArmyId: MoinMoin's escape, not part of the syntax
      const t = String(args || '').trim().replace(/^!/, '');
      if (!/^\d+$/.test(t)) throw new Error('idrecall: give the army id, e.g. idrecall 100333040 (the Armies panel shows it)');
      return { cmd: 'idrecall', armyId: Number(t) };
    },
    async run(a, env) {
      const game = env.game;
      const hit = armiesOf(game).find((x) => Number(x.armyId) === a.armyId);
      if (!hit) throw new Error(`no army of yours has id ${a.armyId}`);
      if (!recallable(hit)) throw new Error(`${armyText(game, hit)} is already on its way home`);
      const n = await recallArmies(env, [hit]);
      return { result: n, done: env.dryRun ? 0 : 1 };
    },
  },
  recallhero: {
    usage: 'recallhero <hero string>',
    parse(args) {
      const t = String(args || '').trim().replace(/\s+/g, '');
      if (!t) throw new Error('recallhero: name the hero, or a hero string like any:att=best');
      const p = checkHeroString(t, 'recallhero');
      if (p.isNone) throw new Error('recallhero: "none" is no hero — name one');
      return { cmd: 'recallhero', hero: t };
    },
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      const ours = oursOf(castle);
      const hits = ours.filter((h) => heroMatches(h, a.hero, ours));
      if (!hits.length) throw new Error(`no hero in ${castle.name} matches ${a.hero}`);
      // The Feasting Hall offers its recall for a hero out marching (3) or
      // guarding (2): HerosMansion_inlineComponent8.as:115.
      const out = rankHeroes(hits.filter((h) => [2, 3].includes(statusOf(h))), H.parseHeroString(a.hero), false);
      if (!out.length) {
        throw new Error(`${hits.map((h) => `${h.name} is ${H.STATUS_NAME[statusOf(h)] || 'busy'}`).join(', ')} — only a hero out marching or camping comes back`);
      }
      const h = out[0];
      env.log(`  recall ${h.name} (${H.STATUS_NAME[statusOf(h)]}) to ${castle.name}`);
      if (env.dryRun) { env.log('  [dry run] not sent'); return { result: h.name }; }
      // hero.callBackHero {castleId, heroId} (HeroCommand.as:266-277)
      const r = await game.callBackHero(game.castleId(castle), h.id);
      env.log('  -> ' + env.say(r));
      return { result: h.name, done: 1 };
    },
  },

  waithero: {
    usage: 'waithero <hero string>',
    parse(args) {
      const t = String(args || '').trim().replace(/\s+/g, '');
      if (!t) throw new Error('waithero: name the hero, or a hero string like any:attack>=200');
      if (checkHeroString(t, 'waithero').isNone) throw new Error('waithero: "none" is no hero — name one');
      return { cmd: 'waithero', hero: t };
    },
    async run(a, env) {
      let said = false;
      for (;;) {
        env.follow();
        const castle = env.castle;
        const ours = oursOf(castle);
        const skip = recentSkip(env.game, env.sentHeroes);
        // in the city and free: idle, or the mayor (HeroConstants 0 and 1)
        const ready = rankHeroes(ours.filter((h) => [0, 1].includes(statusOf(h)) && !skip.has(h.id) && heroMatches(h, a.hero, ours)),
          H.parseHeroString(a.hero), false);
        if (ready.length) {
          env.log(`  ${ready[0].name} is in ${castle.name} and free${said ? '' : ' now'}`);
          return { ok: true, result: ready[0].name };
        }
        if (env.dryRun) { env.log(`  no hero in ${castle.name} matching ${a.hero} is free now — [dry run] not waiting`); return {}; }
        if (!said) { env.log(`  waiting for ${a.hero} to be in ${castle.name} and free...`); said = true; }
        if (env.stopped()) return { ok: false, error: 'stopped', end: true };
        await env.pause(TIMING.heroPollMs);
        if (env.stopped()) return { ok: false, error: 'stopped', end: true };
      }
    },
  },
  waitherolost: {
    usage: 'waitherolost <hero1,hero2,...>',
    parse(args) {
      const t = String(args || '').trim().replace(/\s+/g, '');
      if (!t) throw new Error('waitherolost: name the heroes, e.g. waitherolost ken,henry');
      if (checkHeroString(t, 'waitherolost').isNone) throw new Error('waitherolost: "none" is no hero — name them');
      return { cmd: 'waitherolost', heroes: t };
    },
    async run(a, env) {
      // Heroes of yours anywhere now (a hero moves between cities by reinforcing).
      const all = (g) => (g.castles || []).flatMap((c) => oursOf(c).map((h) => ({ h, c })));
      const watch = new Map();
      for (const { h, c } of all(env.game)) if (heroMatches(h, a.heroes, oursOf(c))) watch.set(h.id, h.name);
      if (!watch.size) throw new Error(`no hero of yours matches ${a.heroes}`);
      env.log(`  watching ${[...watch.values()].join(', ')}`);
      if (env.dryRun) { env.log('  [dry run] not waiting'); return {}; }
      // Gone from every roster for lostGraceMs on one connection: a march between
      // cities (delete here, add there) and a reconnect's hero pushes both pass.
      const gone = new Map();
      let game = env.game, since = Date.now();
      for (;;) {
        env.follow();
        if (env.game !== game) { game = env.game; since = Date.now(); gone.clear(); }
        const here = new Set(all(game).map((x) => x.h.id));
        for (const [id, name] of watch) {
          if (here.has(id)) { gone.delete(id); continue; }
          if (!gone.has(id)) gone.set(id, Date.now());
          if (Date.now() - gone.get(id) >= TIMING.lostGraceMs && Date.now() - since >= TIMING.lostGraceMs) {
            env.log(`  ${name} is no longer yours (captured — or dismissed)`);
            return { ok: true, result: name };
          }
        }
        if (env.stopped()) return { ok: false, error: 'stopped', end: true };
        await env.pause(TIMING.heroPollMs);
        if (env.stopped()) return { ok: false, error: 'stopped', end: true };
      }
    },
  },

  travelinfo: {
    usage: 'travelinfo <x,y | city> <troops> [from <city>]',
    parse(args, { line }) {
      const words = wordsOf(line);
      const where = words[1] || '';
      if (!where || isList(where)) throw new Error('travelinfo: usage  travelinfo 111,222 cav:10,cata:10');
      const target = coordsOf(where, 'travelinfo');
      let troops = null, from = null;
      for (let i = 2; i < words.length; i++) {
        if (words[i].toLowerCase() === 'from') { from = words[++i]; if (!from) throw new Error('travelinfo: "from" needs a city name after it'); continue; }
        if (troops === null && allTroops(words[i])) { troops = W.parseTroops(words[i]); continue; }
        throw new Error(`travelinfo: "${words[i]}" is not a troop string (e.g. cav:10,cata:10)`);
      }
      if (!troops) throw new Error('travelinfo: give the troops, e.g. travelinfo 111,222 cav:10,cata:10');
      return { cmd: 'travelinfo', target, targetCity: target ? null : where, troops, from };
    },
    async run(a, env) {
      const game = env.game;
      const castle = game.castle(a.from ?? env.opts.castle);
      const src = game.castleXY(castle);
      const target = a.targetCity ? game.castleXY(ownCity(game, a.targetCity)) : a.target;
      if (!src || !target) throw new Error('cannot tell where the cities are');
      const keys = Object.keys(a.troops).filter((k) => a.troops[k] > 0);
      const p = await paramsFor(game, castle);
      const opts = { marchSkill: p.marchSkill, driveSkill: p.driveSkill, castleBuffs: castle.buffs, playerBuffs: game.player && game.player.buffs, now: game.now() };
      const atk = C.marchTimeMs(src, target, keys, opts);
      const relief = Number(p.relief) > 1 ? Number(p.relief) : 0;
      const rei = C.marchTimeMs(src, target, keys, { ...opts, relief });
      if (atk === null) throw new Error('those troops do not march');
      const ls = Number.isFinite(Number(p.loadSkill)) ? Number(p.loadSkill) : 0;
      const hold = Math.floor(capacityOf(a.troops, ls));
      const perHour = foodPerHour(a.troops);
      const carryAtk = Math.floor(hold - perHour * atk / 3600000);
      const carryRei = Math.floor(hold - perHour * rei / 3600000);
      const dist = C.mapDistance(src, target);
      const t = (ms) => { const s = Math.round(ms / 1000); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h ? `${h}h:${p2(m)}m:${p2(s % 60)}` : `${m}m:${p2(s % 60)}`; };
      env.log(`  Distance to ${target.x},${target.y}: ${dist.toFixed(2)}miles (from ${castle.name})`);
      env.log(`  attack time: ${t(atk)}`);
      env.log(`  reinforce time: ${t(rei)}${relief ? ` (Relief Station x${relief})` : ''}`);
      env.log(`  carrying total/attack/reinforce: ${hold}/${carryAtk}/${carryRei}`);
      if (!p.known) env.log('  note: this city\'s march and load research could not be read — the login\'s values are used');
      const result = { distance: Math.round(dist * 100) / 100, attackSeconds: Math.round(atk / 1000), reinforceSeconds: Math.round(rei / 1000),
        carry: hold, carryAttack: carryAtk, carryReinforce: carryRei };
      Object.defineProperty(result, 'toString', { value: () => `${dist.toFixed(2)} miles, attack ${t(atk)}, reinforce ${t(rei)}, carrying ${hold}/${carryAtk}/${carryRei}` });
      return { ok: true, result };
    },
  },

  // NEAT's getspamhero is hire best under another word: script-cmd-hero.js's
  // hire runs it.
  getspamhero: {
    usage: 'getspamhero [power|atk | management|pol | stratagem|int]',
    parse(args) {
      const t = String(args || '').trim().toLowerCase();
      const attr = { '': '', power: 'attack', atk: 'attack', attack: 'attack', management: 'politics', pol: 'politics', politics: 'politics',
        stratagem: 'intel', int: 'intel', intel: 'intel' }[t];
      if (attr === undefined) throw new Error('getspamhero: the type is power|atk, management|pol or stratagem|int (or nothing: the best of any)');
      const tok = ['hire', 'best', ...(attr ? [attr] : [])];
      const hire = require('./script-cmd-hero').commands.hire;
      return hire.parse(tok.slice(1).join(' '), { word: 'hire', line: tok.join(' '), tok });
    },
  },

  heroroute: {
    usage: 'heroroute',
    parse(args) {
      if (String(args || '').trim()) throw new Error('heroroute: nothing goes after it');
      return { cmd: 'heroroute' };
    },
    async run(a, env) {
      const game = env.game;
      const castles = game.castles || [];
      const wanted = new Map();       // hero (lower case) -> { name, cities }
      let store = false;
      for (const c of castles) {
        const parsed = cityGoals(env.session, game, c);
        if (parsed) store = true;
        for (const g of ((parsed && parsed.goals) || []).filter((x) => x.name === 'traininghero' && x.hero)) {
          const k = String(g.hero).toLowerCase();
          if (!wanted.has(k)) wanted.set(k, { name: g.hero, cities: [] });
          wanted.get(k).cities.push(c);
        }
      }
      if (!store) throw new Error('heroroute reads the cities\' traininghero goals, which only the console has');
      if (!wanted.size) { env.log('  no city has a traininghero goal'); return { ok: true, result: [] }; }
      // goalmods.trainingHeroPlan: the cities that list the hero, in city order;
      // from each, the next one round; from any other city, the first of them.
      const route = [];
      for (const { name, cities } of wanted.values()) {
        const holder = castles.find((c) => (c.heros || []).some((h) => String(h.name || '').toLowerCase() === name.toLowerCase()));
        env.log(`  traininghero ${name}${holder ? ` (in ${holder.name} now)` : ' (not in any city yet)'}${cities.length < 2 ? ' — only one city lists it, so it stays' : ''}:`);
        for (const c of castles) {
          const i = cities.indexOf(c);
          const next = i < 0 ? cities[0] : cities[(i + 1) % cities.length];
          const line = `${c.name} -> ${next === c ? '(stays)' : next.name}${i < 0 ? ' (not in the rotation)' : ''}`;
          env.log('    ' + line);
          route.push(`${name}: ${line}`);
        }
      }
      return { ok: true, result: route };
    },
  },

  setballsused: {
    usage: 'setballsused <n,n,n,n,n>   (retired: config ballsused:<n> in the goals)',
    parse(args) {
      const t = String(args || '').trim();
      if (!/^\d+(,\d+)*$/.test(t.replace(/\s+/g, ''))) throw new Error('setballsused: usage  setballsused 20,50,130,200,400');
      return { cmd: 'setballsused', counts: t.replace(/\s+/g, '').split(',').map(Number) };
    },
    async run(a, env) {
      const msg = 'setballsused is retired (NEAT\'s wiki says so too) — put  config ballsused:<n>  in this city\'s goals'
        + ' (npctroops sets troops per NPC level). Nothing was changed';
      env.log('  ' + msg);
      return { ok: false, error: msg };
    },
  },

  spamattack: {
    usage: 'spamattack <x,y> <troops> <waves>',
    parse(args, { line }) {
      const words = wordsOf(line);
      const target = loopTarget('spamattack', words);
      if (!words[2] || !allTroops(words[2])) throw new Error('spamattack: usage  spamattack 111,222 c:500,s:500 10   (troops, then how many waves)');
      if (!/^\d+$/.test(words[3] || '') || !Number(words[3])) throw new Error('spamattack: say how many waves after the troops, e.g. spamattack 111,222 c:500,s:500 10');
      if (words.length > 4) throw new Error(`spamattack: unexpected "${words[4]}"`);
      return { cmd: 'spamattack', target, troops: W.parseTroops(words[2]), waves: Number(words[3]) };
    },
    run: startLoop,
  },
  loyaltyattack: {
    usage: 'loyaltyattack <x,y> [troops | cavalry] [/waves=100] [/hours=12]',
    parse(args, { line }) {
      const { words, caps } = loopCaps('loyaltyattack', wordsOf(line));
      const target = loopTarget('loyaltyattack', words);
      if (words.length > 3) throw new Error(`loyaltyattack: unexpected "${words[3]}"`);
      return { cmd: 'loyaltyattack', target, troops: loopTroops('loyaltyattack', words[2]), ...caps };
    },
    run: startLoop,
  },
  capture: {
    usage: 'capture <x,y> [troops | cavalry] [/waves=100] [/hours=12]',
    parse(args, { line }) {
      const { words, caps } = loopCaps('capture', wordsOf(line));
      const target = loopTarget('capture', words);
      if (words.length > 3) throw new Error(`capture: unexpected "${words[3]}"`);
      return { cmd: 'capture', target, troops: loopTroops('capture', words[2]), ...caps };
    },
    run: startLoop,
  },
  guardedattack: {
    usage: 'guardedattack <x,y> <troops> <scouts> <their troops> <their defenses>',
    parse(args, { line }) {
      const words = wordsOf(line);
      const target = loopTarget('guardedattack', words);
      const use = 'guardedattack: usage  guardedattack 111,222 cav:99000,s:1000 10 a:500000 ab:1'
        + '   (your troops, how many scouts, then the troops and the defenses that call it off)';
      if (!words[2] || !allTroops(words[2])) throw new Error(use);
      if (!/^\d+$/.test(words[3] || '') || !Number(words[3])) throw new Error(use);
      if (!words[4] || !allTroops(words[4]) || !words[5] || !allForts(words[5])) throw new Error(use);
      if (words.length > 6) throw new Error(`guardedattack: unexpected "${words[6]}"`);
      return { cmd: 'guardedattack', target, troops: W.parseTroops(words[2]), scouts: Number(words[3]),
        limits: { troops: W.parseTroops(words[4]), forts: parseForts(words[5], 'guardedattack') } };
    },
    run: startLoop,
  },
  setguard: {
    usage: 'setguard <x,y> <their troops> <their walls>',
    parse(args, { line }) {
      const words = wordsOf(line);
      const target = loopTarget('setguard', words);
      if (!words[2] || !allTroops(words[2])) throw new Error('setguard: usage  setguard 111,222 a:60000,cav:50000 ab:100   (the troops, then the walls, that call the attack off)');
      if (!words[3] || !allForts(words[3])) throw new Error('setguard: a wall condition is needed after the troops (NEAT\'s rule), e.g. ab:100 or at:5000,tre:2000');
      if (words.length > 4) throw new Error(`setguard: unexpected "${words[4]}"`);
      return { cmd: 'setguard', target, limits: { troops: W.parseTroops(words[2]), forts: parseForts(words[3], 'setguard') } };
    },
    run: startLoop,
  },
  endspamattack: ends('endspamattack'),
  endloyaltyattack: ends('endloyaltyattack'),
  endguardedattack: ends('endguardedattack'),
  attackstatus: {
    usage: 'attackstatus',
    parse(args) {
      if (String(args || '').trim()) throw new Error('attackstatus: nothing goes after it');
      return { cmd: 'attackstatus' };
    },
    async run(a, env) {
      const r = loops().status();
      for (const l of r.lines) env.log('  ' + l);
      return { ok: true, result: r.count };
    },
  },

  buildstatus: {
    usage: 'buildstatus',
    parse: () => ({ cmd: 'buildstatus' }),
    async run(a, env) {
      for (const l of require('./city-build').status(env.game)) env.log('  ' + l);
      return {};
    },
  },
  marchcheck: {
    usage: 'marchcheck',
    parse: () => ({ cmd: 'marchcheck' }),
    async run(a, env) {
      await require('./timed-march').check(env.game, env.log);
      return {};
    },
  },
};

module.exports = {
  commands, parseMarch, ownCity, DEPLOY, BIG, ENSIGN, TIMING,
  // for deploy-loops.js and the tests
  pickHero, heroMatches, checkHeroString, rankHeroes, spamPool, spamRules, spamHero, spamHeroes, cityGoals, oursOf,
  markSent, recentSkip, capacityOf, foodPerHour, troopTextOf, paramsFor, parseForts,
  armiesOf, recallable, homeOf, armyText,
};
