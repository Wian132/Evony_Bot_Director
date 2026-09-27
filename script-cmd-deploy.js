'use strict';
// Marches for scripts (the command-module contract is at the top of script.js),
// and NEAT's background attacks, which deploy-loops.js runs.
//
//   attack 111,222 any a:1000                   at once, with the strongest idle attack hero
//   attack 111,222 any a:1000 @00:30:00         camp 30 minutes first (@ or a bare h:mm:ss / m:ss)
//   attack 111,222 any a:1000 s:100 @:18:20:20  land at 18:20:20 on this machine's clock
//                                               (timed-march.js lands it to the ms, checks the
//                                               server's stamp, and recalls and resends a miss)
//   attack 111,222 any c:50k @:10:10:10.500 /within=1s    timed waves: kept if it lands 10:10:09.500 to
//                                               11.500, else recalled and sent again (/tries=N, default 10)
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
//   recall 111,222                  this city's armies on their way to (or staying at) 111,222
//   recall 111,222 all              every city's, not just this one's
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
const isList = (t) => /^[a-z]+:([\d.]+[kmb]?|\*)(,[a-z]+:([\d.]+[kmb]?|\*))*$/i.test(t);
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

// Every field is goal-heroes' own, `base` included: since the goals build-out
// it reads Game.heroBase (the top attribute less the point a level gave it,
// unspent points added back), which is what the live roster supports — it sends
// 0 in every *Added field, so the old attribute − *Added read the whole
// attribute as the base.
const fieldOf = (name) => H.FIELDS[name];
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
  let nowait = false, waitMs = null, within = null, tries = null, nolimit = false, fullhold = false;
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
    // Our own troop-count guard, not the game's, and it cannot see every bonus
    // (a haunted castle's). /nolimit sends the march and lets the game answer.
    if (lt === '/nolimit') { nolimit = true; continue; }
    // /fullhold: fill f:* to the whole load, setting nothing aside for the march's
    // own food. The server does not enforce the food rule on an attack (EVONY-RULES
    // 5b), so whether it enforces it on a transport is worth finding out.
    if (lt === '/fullhold') { fullhold = true; continue; }
    // A march waits for what the city is short of (waitReady). /nowait sends it
    // at once and lets the server refuse it, as every march did before;
    // /wait=<time> waits that long and then fails.
    if (lt === '/nowait') { nowait = true; continue; }
    // A timed march's window (the user's timed waves): /within=500ms, /within=1s,
    // /within=1.5s or a bare /within=500 (ms). Landing further than that from the
    // @: moment, either side, gets it recalled and sent again (timed-march.js).
    if (lt.startsWith('/within=')) {
      const m = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(lt.slice(8));
      if (!m) throw new Error(`${name}: /within= takes a length like 500ms, 1s or 1.5s`);
      within = Math.round(Number(m[1]) * (m[2] === 's' ? 1000 : 1));
      if (!(within >= 1 && within <= 60000)) throw new Error(`${name}: /within= is 1ms to 60s`);
      continue;
    }
    if (lt.startsWith('/tries=')) {
      tries = Number(lt.slice(7));
      if (!Number.isInteger(tries) || tries < 1 || tries > 50) throw new Error(`${name}: /tries= is how many sends, 1 to 50`);
      continue;
    }
    if (lt.startsWith('/wait=')) {
      const v = t.slice(6);
      const secs = /^\d+$/.test(v) ? Number(v) : W.parseDuration(v, `${name}: /wait=`);
      if (secs === 0) nowait = true; else waitMs = secs * 1000;
      continue;
    }
    if (t.startsWith('/')) throw new Error(`${name}: "${t}" — the switches are /big (a War Ensign), /horde,`
      + ' /nolimit (send it whatever the troop guard thinks the city may take),'
      + ' /nowait (send now and let the server refuse it), /wait=<seconds | m:ss | h:mm:ss>,'
      + ' and with an @: landing time /within=<500ms | 1s> and /tries=<n>');
    if (isTime(t)) {
      if (land || camp !== null) throw new Error(`${name}: one time per march — @:hh:mm:ss to land then, or a camp time`);
      if (t.startsWith('@:')) land = W.parseLandTime(t); else camp = W.parseDuration(t);
      continue;
    }
    if (isList(t)) {
      // NEAT reads troops first and resources second, so in a later list
      // s: and w: are stone and wood, not scouts and warriors.
      if (troops === null && allTroops(t)) { troops = W.parseTroops(t); continue; }
      if (allRes(t)) { resources = { ...resources, ...W.parseResources(t, { fill: true }) }; continue; }
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
  if (nolimit) out.nolimit = true;
  if (fullhold) out.fullhold = true;
  if (nowait) out.nowait = true;
  if (waitMs) out.waitMs = waitMs;
  if ((within !== null || tries !== null) && !land) {
    throw new Error(`${name}: /within= and /tries= time a landing — give the moment too, e.g. @:10:10:10.500`);
  }
  if (within !== null) out.within = within;
  if (tries !== null) out.tries = tries;
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

// ------------------------------------------------- waiting for a march to be possible
//
// A march the city cannot make YET — its troops are still out, the resources
// are not in, every rally slot is busy, the hero has not come home — used to be
// sent anyway and refused by the server. Inside a `repeat` or a `goto` that
// became fail-iterate-fail at the speed of the server's no, and a hundred
// transports ran through in a second without one of them going. So a march now
// WAITS for what the city is short of, says in red what it is waiting for, and
// sends when it can. Stop ends the wait. `/nowait` sends at once and fails as
// before; `/wait=<time>` gives up after that long and fails.
//
// What it waits on is read from the pushes the server sends by itself —
// server.TroopUpdate, server.ResourceUpdate and server.SelfArmysUpdate, all
// applied in session.js — so the counts are live, not the login's snapshot.
// Marches this run has already sent that the server has not listed back yet
// count too (rally.js's pending book), so two sends in a row cannot both spend
// the same troops.
//
// Only what is KNOWN is waited on: a castle bean with no troop list, no
// resource bean or no building list is left to the server to judge, exactly as
// before. What can never come right on its own is NOT waited on and fails at
// once — a march over the Rally Spot's troop limit, a load bigger than the
// troops can carry, /big without a War Ensign, a hero string no hero of the
// city matches at all (that is what `waithero` is for).
// defaultMs: how long a march with no /wait= of its own waits. null is forever
// — the point of the whole thing — and the tests set it low so a wait that can
// never end finishes the suite instead of hanging it.
const WAIT = { pollMs: 5000, sayEveryMs: 60000, defaultMs: null };

// TroopStrBean counts come through as strings; "?" and a missing field are
// unknown, never 0 (goal-war.js count()).
function troopCount(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/[,\s]/g, '');
  return /^\d+$/.test(s) ? parseInt(s, 10) : null;
}

// One rally book per run, holding what this run has sent and the server has not
// listed back yet. Rebuilt on a reconnect (the book reads its Game through a
// closure), keeping that pending list. Scripts get the Rally Spot's own limit
// only: a rallypolicy holds back goals, never a line someone typed.
function bookOf(env) {
  const st = env.state;
  if (!st.rallyBook || st.rallyGame !== env.game) {
    st.rallyPending = st.rallyPending || [];
    st.rallyBook = require('./rally').rallyBook({ game: env.game, pending: st.rallyPending });
    st.rallyGame = env.game;
  }
  return st.rallyBook;
}
const missionKind = (cmd) => require('./rally').KIND_BY_MISSION[C.MISSION[cmd]] || 'other';

// What the city cannot supply for this march yet — [] when it can go now.
// Throws for anything waiting cannot fix.
function marchShort(a, env, castle) {
  const out = [];
  const book = bookOf(env);
  const owed = book.committed(castle);       // sent this run, not in the server's counts yet

  // Rally slots: a city may have as many marches out as its Rally Spot level,
  // going, camped or coming home (rally.js, EVONY-RULES.md).
  const slots = book.room(castle, missionKind(a.cmd));
  if (slots.capacity !== null && slots.room <= 0) out.push(slots.why || 'every rally slot is busy');

  // Troops at home.
  const have = castle.troop || {};
  for (const [k, want] of Object.entries(a.troops || {})) {
    if (!(Number(want) > 0)) continue;
    const got = troopCount(have[k]);
    if (got === null) continue;              // not listed: the server judges it
    const free = got - Number((owed.troops || {})[k] || 0);
    if (free < want) out.push(`${fmt(Math.max(0, free))} of ${fmt(want)} ${(C.BY_KEY[k] || {}).name || k} at home`);
  }

  // Resources in the store. Only what the march CARRIES is counted: whether the
  // food a march eats on the way comes out of the city as well as out of the
  // load is *unverified*, and waiting on food the game may not want would hang
  // a transport that asks for everything the city has.
  if (castle.resource) {
    const bank = require('./game').Game.bankOf;
    for (const [k, want] of Object.entries(a.resources || {})) {
      if (!(Number(want) > 0)) continue;
      const got = bank(castle.resource, k) - Number((owed.resources || {})[k] || 0);
      if (got < want) out.push(`${k} ${fmt(Math.max(0, got))} of ${fmt(want)}`);
    }
  }

  // The hero. Busy, out, or sent by this script a moment ago: it comes back, so
  // the march waits. No hero of the city matching at all, or a hero string that
  // cannot be read: waiting would never end, so it throws as it always did.
  if (a.hero) {
    try {
      pickHero(castle, a.hero, { skip: recentSkip(env.game, env.sentHeroes), attackFirst: a.cmd === 'attack' });
    } catch (e) {
      if (!/^no idle hero/.test(e.message)) throw e;
      out.push(e.message);
    }
  }
  return out;
}

// Wait until the city can make this march. -> { waited } | { stopped }
async function waitReady(a, env) {
  const look = () => marchShort(a, env, env.game.castle(a.from ?? env.opts.castle));
  if (a.nowait || env.dryRun) {
    // Not waiting, but still worth saying why the server is about to say no.
    const why = look();
    if (why.length) env.log(`  not yet: ${why.join('; ')} — /nowait, so it goes anyway`);
    return { waited: 0 };
  }
  const D = require('./timed-march').dur;
  const started = Date.now();
  const cap = a.waitMs ?? WAIT.defaultMs;
  const until = cap ? started + cap : null;
  let saidAt = 0, saidWhy = null;
  for (;;) {
    const why = look();
    if (!why.length) {
      if (saidWhy !== null) env.log(`  ready after ${D(Date.now() - started)}`);
      return { waited: Date.now() - started };
    }
    const text = why.join('; ');
    // Once for each new reason, and again every sayEveryMs while it holds, so a
    // long wait leaves a trail without filling the Output tab.
    if (text !== saidWhy || Date.now() - saidAt >= WAIT.sayEveryMs) {
      env.log(`  not yet: ${text} — waiting${until ? ` up to ${D(Math.max(0, until - Date.now()))} more` : ''}`);
      saidWhy = text; saidAt = Date.now();
    }
    if (until && Date.now() >= until) throw new Error(`still not ready after ${D(Date.now() - started)} — ${text}`);
    if (env.stopped()) return { stopped: true };
    await env.pause(Math.min(WAIT.pollMs, until ? Math.max(250, until - Date.now()) : WAIT.pollMs));
    if (env.stopped()) return { stopped: true };
  }
}

// A send the server took, remembered until it shows in the army list, so the
// next line of the same run does not count its troops or resources twice.
function recordSent(a, env, castle, targetPoint) {
  try {
    bookOf(env).record({
      from: castle, targetFieldId: targetPoint, missionType: C.MISSION[a.cmd],
      kind: missionKind(a.cmd), resources: a.resources || {}, troops: a.troops || {},
    });
  } catch { /* the book is a convenience, never a reason a march fails */ }
}

// `f:*` / `i:*` on a march: "fill the hold with this". Resolved here because only
// here are the troops, the march time and the city's store all known.
//
// The room is the load the troops carry, less the food the march eats out of that
// same hold (NewArmyWin: leftSpace = loads - needFood - resources), less whatever
// the line asks for by name. Several stars share what is left, each capped by what
// the city actually holds — a star that asked for more than the city has would
// otherwise leave the march waiting for resources that are never coming.
//
// Whether the server really reserves the march food is *unverified* (EVONY-RULES
// §5b: it does not enforce the food rule on an attack at all), so the reservation
// is kept but reported, and `/fullhold` sends the load with no food set aside.
function fillHold(a, castle, holdRaw, foodNeeded, log, fullHold) {
  const stars = Object.keys(a.resources || {}).filter((k) => a.resources[k] === Infinity);
  if (!stars.length) return;
  const bank = require('./game').Game.bankOf;
  const hold = Math.floor(holdRaw);
  const food = fullHold ? 0 : Math.floor(foodNeeded);
  const named = Object.values(a.resources).filter((v) => Number.isFinite(v)).reduce((t, v) => t + v, 0);
  let room = Math.max(0, hold - food - named);

  const have = Object.fromEntries(stars.map((k) => [k, castle.resource ? bank(castle.resource, k) : room]));
  const got = Object.fromEntries(stars.map((k) => [k, 0]));
  let open = [...stars];
  while (open.length && room > 0) {
    const share = Math.floor(room / open.length);
    if (share <= 0) { got[open[0]] += room; room = 0; break; }
    const next = [];
    for (const k of open) {
      const take = Math.min(share, have[k] - got[k]);
      got[k] += take; room -= take;
      if (have[k] - got[k] > 0) next.push(k);
    }
    if (next.length === open.length && next.every((k) => got[k] >= have[k])) break;
    if (!next.length) break;
    open = next;
  }
  for (const k of stars) a.resources[k] = got[k];
  log(`  fill: ${stars.map((k) => `${k} ${fmt(got[k])}${got[k] >= have[k] ? ' (all the city has)' : ''}`).join(', ')}`
    + ` · hold ${fmt(hold)}${named ? ` less ${fmt(named)} asked for by name` : ''}`
    + (food ? ` less ${fmt(food)} food for the march (/fullhold sends without it)` : ' · no food set aside (/fullhold)'));
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

  // `f:*` — fill the hold. Must run before the capacity check below and before
  // marchShort, both of which read a.resources as numbers.
  if (Object.values(a.resources || {}).some((v) => v === Infinity)) {
    const pf = await paramsFor(game, castle);
    const ms = from ? (C.marchTimeMs(from, target, troopKeys, {
      marchSkill: pf.marchSkill, driveSkill: pf.driveSkill, relief: Number(pf.relief) > 1 ? pf.relief : 0,
      castleBuffs: castle.buffs, playerBuffs: game.player && game.player.buffs, now: game.now(),
    }) || 0) : 0;
    const ls = pf.known && Number.isFinite(Number(pf.loadSkill)) ? Number(pf.loadSkill) : 0;
    fillHold(a, castle, capacityOf(a.troops, ls),
      foodPerHour(a.troops) * (ms + (a.camp || 0) * 1000) / 3600000, log, !!a.fullhold);
    if (!pf.known) log('  note: this city\'s load research could not be read, so the fill used none — travelinfo shows what troops carry');
  }

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

  // Everything above is a reason the march can NEVER go as written. What is
  // only missing for now — troops out, resources short, no rally slot, the hero
  // away — is waited for instead of being sent and refused (marchShort above).
  const held = await waitReady(a, env);
  if (held.stopped) return { ok: false, error: 'stopped while waiting for the march', end: true };

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
      tolMs: a.within ?? null, tries: a.tries ?? null,
    });
    if (res.sent && hero) markSent(env.game, hero.id, env.sentHeroes);
    if (res.sent && a.big) usedEnsign(env, env.game, ensigns);
    if (res.sent) recordSent(a, env, castle, targetPoint);
    // a Stop during the wait ends the run where it is
    return { done: res.sent ? 1 : 0, ok: !!res.sent || dryRun, end: res.why === 'stopped' };
  }

  // The city's own troop params and the Relief Station, as timed-march.js and
  // travelinfo use: the login's marchSkillParam alone read 0 and ignored
  // Horseback Riding, so this line said 6 h 6 m for Lord24's 48k cavalry 3 -> 5.
  // The relief is counted for our own cities and tiles only: asking the server
  // who owns any other tile would cost a request on every march.
  const tm = require('./timed-march');
  const pm = await paramsFor(game, castle);
  const buffs = { castleBuffs: castle.buffs, playerBuffs: game.player && game.player.buffs, now: game.now ? game.now() : Date.now() };
  const ours = !!toCity || construct || (game.castles || []).some((c) => Number(c.fieldId) === targetPoint
    || (c.fields || []).some((f) => Number(f.id) === targetPoint));
  const relief = ours && Number(pm.relief) > 1 ? Number(pm.relief) : 0;
  const march = from ? C.marchTimeMs(from, target, troopKeys, { marchSkill: pm.marchSkill, driveSkill: pm.driveSkill, relief, ...buffs }) : null;
  // The game shortens a camp by the same buffs as the march (Fleet Feet: two
  // charges make 16 h of camp 4 h 48 m — constants.js armyTimeFactor). Asking
  // for camp / factor gets the camp that was written.
  const factor = C.armyTimeFactor(buffs);
  const restTimeSec = a.camp ? (factor > 0 ? Math.ceil(a.camp / factor) : a.camp) : 0;
  if (march !== null) {
    log(`  march ${tm.dur(Math.floor(march / 1000) * 1000)}${relief ? ` (Relief Station x${relief})` : ''}` + (restTimeSec
      ? `, camp ${tm.dur(a.camp * 1000)}${restTimeSec !== a.camp ? ` (${tm.dur(restTimeSec * 1000)} asked for: the game counts camp x${factor.toFixed(2)}, as the march buffs do the march)` : ''}`
        + ` — lands about ${tm.clock(Date.now() + Math.floor(march / 1000) * 1000 + a.camp * 1000)}`
      : ' (no @: time, lands on arrival)'));
  }
  const bean = makeBean(restTimeSec);
  if (dryRun) { log('  [dry run] not sent'); return {}; }
  const gs = env.game;                 // the reads above may have crossed a reconnect
  const ensigns = a.big ? ensignsHeld(gs) : null;
  const r = await gs.newArmy(gs.castleId(castle), bean, { noLimit: !!a.nolimit });
  log('  -> ' + env.say(r));
  if (r && r.ok === 1 && hero) markSent(gs, hero.id, env.sentHeroes);
  if (r && r.ok === 1 && a.big) usedEnsign(env, gs, ensigns);
  if (r && r.ok === 1) recordSent(a, env, castle, targetPoint);
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
  transport: march('transport <x,y | city> [hero] <troops> <resources> [@:hh:mm:ss | camp] [/big] [/fullhold] [from <city>]'),
  reinforce: march('reinforce <x,y | city> [hero] [troops] [resources] [@:hh:mm:ss | camp] [/big] [/fullhold] [from <city>]'),
  bigattack: march('bigattack <x,y> <hero> <troops> [...] — attack with a War Ensign'),
  bigscout: march('bigscout <x,y> <hero | none> s:<scouts> [...] — scout with a War Ensign'),
  bigtransport: march('bigtransport <x,y | city> t:<transports> <resources> [...] — transport with a War Ensign'),
  bigreinforce: march('bigreinforce <x,y | city> [hero] [troops] [resources] [...] — reinforce with a War Ensign'),
  // a build-city march: only `deploy bu` makes one
  construct: { run: runMarch },
  deploy: {
    usage: 'deploy <at|bu|re|sc|tr> <x,y | city> [hero] <troops> [resources] [@:hh:mm:ss | camp] [/big] [/fullhold] [/horde] [from <city>]',
    parse: (args, { line, tok }) => parseMarch('deploy', line, tok),
  },
  bigdeploy: {
    usage: 'bigdeploy <atk|bld|rei|sct|tr> <x,y | city> [hero] <troops> [resources] [time] — deploy with a War Ensign',
    parse: (args, { line, tok }) => parseMarch('bigdeploy', line, tok),
  },

  recall: {
    // This city's armies only, as recallall is — a script run in all cities recalls
    // from each in turn, so the run covers the fleet without one city pulling back
    // another's waves. `recall 111,222 all` asks for every city's in one go.
    // (The user, 2026-09-23; ally-drain.txt had warned of the fleet-wide recall.)
    usage: 'recall <x,y | city> [all]',
    parse(args, { line }) {
      const words = wordsOf(line);
      const all = words.length === 3 && words[2].toLowerCase() === 'all';
      if (words.length !== 2 && !all) throw new Error("recall: usage  recall 111,222 [all]   (or a city of yours by name, in quotes if it has spaces; \"all\" recalls every city's, not just this one's)");
      const target = coordsOf(words[1], 'recall');
      return { cmd: 'recall', target, targetCity: target ? null : words[1], all };
    },
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      const target = a.targetCity ? game.castleXY(ownCity(game, a.targetCity)) : a.target;
      const fid = C.coordsToFieldId(target.x, target.y);
      const there = armiesOf(game).filter((x) => recallable(x) && Number(x.targetFieldId) === fid);
      const list = a.all ? there : there.filter((x) => Number(x.startFieldId) === Number(castle.fieldId));
      if (!list.length) {
        const others = there.length - list.length;
        env.log(`  no army from ${a.all ? 'any city of yours' : castle.name} is on its way to ${target.x},${target.y} (or staying there)`
          + (others ? ` — ${others} from other cities; "recall ${target.x},${target.y} all" calls those back too` : ''));
        return { ok: true, result: 0 };
      }
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
  markSent, recentSkip, capacityOf, foodPerHour, troopTextOf, paramsFor, parseForts, fillHold,
  armiesOf, recallable, homeOf, armyText,
  marchShort, waitReady, WAIT,
};
