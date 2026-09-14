'use strict';
// NEAT-style script parser + executor.
//
//   attack 123,456 any:level<500,attack>400 a:99k,c:500,cata:500 @07:00:00.500
//   scout 500,500 any s:1
//   transport 123,456 any t:1000 wood:100000
//   reinforce 123,456 any a:5000
//   reinforce Fla                          (a city of yours by name; no hero, 1 scout)
//   reinforce "Home City" none a:500 wood:50k,food:20k
//   deploy bu 123,456 any wo:500 f:26k,l:26k,s:26k,i:12k,g:10k @:14:30:07.500
//                                          (NEAT: at attack, bu build city, re reinforce, sc scout, tr transport)
//     troops come first, resources second: s: and w: are scouts and warriors in
//     the first list, stone and wood in the second (f w/l s i g, or full names)
//     @:14:30:07.500   land then, on this machine's clock (timed-march.js lands it,
//                      checks the server's stamp, and recalls and resends a miss)
//     @0:30:00 / 0:30:00   camp that long (NEAT)
//   buildstatus                            (build marches on the way, by landing second; city-build.js)
//   marchcheck                             (the march formula against the server's times for every march out)
//   set target 111,222   then %target%     (NEAT's replacement variables)
//   logout now @:14:35 | logout now 1:05:00   (off the game until then; logout.js)
//   sell wood 1000 @0.55
//   buy food 1000 @1.2
//   repeat 10 | repeat                     (the line above 10 more times, failed goes too | until it fails or Stop)
//   cleanreports trade
//   holidaysnipe [dry] | holidaysnipe stop | holidaysnipe status   (holiday-snipe.js)
//   teleport 123,456 | teleport thuringia | teleport random | warteleport 123,456   (teleport.js)
//   lostheroes | recover <hero> [to <city>]   (stone-of-finding.js)
//   renamehero <hero> <new name> [anyway]   (rename-hero.js)
//   waterhero <hero> [/heropoints="pol:300 att"]   (water-hero.js: Holy Water, then re-spend the points)
//   canceltroopqueues [n] | cancelfortifications [n]   (queue-cancel.js)
//   sleep 5 | sleep 1:30 | sleep 1:00:00 | sleep @:14:15
//   echo hello
//
// from <castle> may be appended to any march:  attack 1,2 any a:100 from MyCity
const C = require('./constants');
const { Game } = require('./game');

// attack = power, politics = management, intel = stratagem
const ATTR = Game.ATTR;

const num = (s) => {
  const m = String(s).trim().match(/^([\d.]+)\s*([kmb])?$/i);
  if (!m) throw new Error('bad number: ' + s);
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
};

function parseTroops(s) {
  const troops = {};
  for (const part of s.split(',')) {
    const m = part.trim().match(/^([a-z]+)\s*:\s*([\d.]+[kmb]?)$/i);
    if (!m) throw new Error('bad troop string: ' + part);
    const t = C.BY_CODE[m[1].toLowerCase()];
    if (!t) throw new Error('unknown troop code: ' + m[1]);
    troops[t.key] = num(m[2]);
  }
  return troops;
}

// deploy's march types (NEAT's Deploy, plus the full names).
const DEPLOY = {
  at: 'attack', attack: 'attack', bu: 'construct', build: 'construct', buildcity: 'construct', construct: 'construct',
  re: 'reinforce', reinforce: 'reinforce', sc: 'scout', scout: 'scout', tr: 'transport', transport: 'transport',
};

// NEAT's resource codes f w s i g (Abbreviations), l for lumber, or the names.
const RES_CODE = {
  f: 'food', food: 'food', w: 'wood', l: 'wood', wood: 'wood', lumber: 'wood',
  s: 'stone', stone: 'stone', i: 'iron', iron: 'iron', g: 'gold', gold: 'gold',
};

function parseResources(s) {
  const out = {};
  for (const part of s.split(',')) {
    const m = part.trim().match(/^([a-z]+)\s*:\s*([\d.]+[kmb]?)$/i);
    const key = m && RES_CODE[m[1].toLowerCase()];
    if (!key) throw new Error('bad resource string: ' + part + ' (f w s i g, l for lumber, or food/wood/stone/iron/gold)');
    out[key] = num(m[2]);
  }
  return out;
}

// A clock time: "@:14:30", "@:14:30:07", "@:14:30:07.500" (NEAT: "local time
// when prefaced with @:", 24-hour). The seconds may carry a fraction, so .04 is
// 40 ms and .5 is 500 ms. One digit will do for any part: `set timem 5` then
// @:%timeh%:%timem% reads 14:05.
function parseLandTime(s) {
  const m = String(s).replace(/^@:?/, '').match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:[.:](\d{1,3}))?)?$/);
  if (!m || +m[1] > 23 || +m[2] > 59 || (m[3] !== undefined && +m[3] > 59)) {
    throw new Error('bad time: ' + s + ' (24-hour clock, e.g. @:14:30:07.500)');
  }
  return { h: +m[1], m: +m[2], s: +(m[3] || 0), ms: m[4] ? +String(m[4]).padEnd(3, '0') : 0 };
}

// A length of time in whole seconds: "1:30" is m:ss, "1:30:00" h:mm:ss. NEAT
// writes a march's camp time this way, with or without an @ in front.
function parseDuration(s, what = 'camp time') {
  const t = String(s).replace(/^@/, '');
  const m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (m) return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  if (/\.\d/.test(t)) throw new Error(`${what} is whole seconds; for a landing time put a colon after the @: @:${t}`);
  throw new Error(`bad ${what}: ${s} (h:mm:ss or m:ss)`);
}

// next occurrence of that wall-clock time, on the server clock
function nextOccurrence(t, serverNow) {
  const d = new Date(serverNow);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.h, t.m, t.s, t.ms).getTime();
  return target <= serverNow ? target + 86400000 : target;
}

function parseLine(raw) {
  const line = raw.replace(/\/\/.*$/, '').trim();
  if (!line) return null;

  const tok = line.split(/\s+/);
  const cmd = tok[0].toLowerCase();

  // sleep 15 | sleep 1:43 | sleep 4:22:32 | sleep @:14:15:00   (NEAT's Sleep)
  if (cmd === 'sleep') {
    if (String(tok[1] || '').startsWith('@:')) return { cmd, until: parseLandTime(tok[1]) };
    if (/:/.test(tok[1] || '')) return { cmd, seconds: parseDuration(tok[1], 'sleep time') };
    return { cmd, seconds: parseFloat(tok[1]) };
  }
  if (cmd === 'buildstatus' || cmd === 'marchcheck') return { cmd };
  if (cmd === 'logout') return { cmd, ...require('./logout').parseArgs(tok.slice(1)) };
  if (cmd === 'echo') return { cmd, text: line.slice(5) };
  if (cmd === 'cleanreports') return { cmd, type: (tok[1] || 'trade').toLowerCase() };
  // A bare `repeat` has no count: it runs the line above until that fails or
  // the run is stopped (see expand and run).
  if (cmd === 'repeat') {
    if (tok[1] === undefined) return { cmd, times: null };
    if (!/^\d+$/.test(tok[1])) throw new Error('repeat: give a count (repeat 10), or none to repeat until it fails or you press Stop');
    return { cmd, times: Math.max(1, parseInt(tok[1], 10)) };
  }
  if (cmd === 'loop') return { cmd, times: Math.max(1, parseInt(tok[1] || '1', 10)) };
  if (cmd === 'endloop') return { cmd };

  // wall abatis 1000     (aliases: trap, abatis, tower, logs, rocks)
  if (cmd === 'wall' || cmd === 'walls') {
    const w = C.WALL_BY_CODE[(tok[1] || '').toLowerCase()];
    if (!w) throw new Error('wall: type must be one of ' + C.WALLS.map((x) => x.code).join('/'));
    return { cmd: 'wall', wall: w, amount: num(tok[2] || '1') };
  }

  // NEAT's canceltroopqueues / cancelfortifications [n]: leave n batches, cancel
  // the rest. See queue-cancel.js.
  const QC = require('./queue-cancel');
  if (QC.COMMANDS[cmd]) return { cmd: 'cancelqueue', ...QC.parseArgs(cmd, tok.slice(1)) };

  // train a 10k   (troops)
  if (cmd === 'train') {
    const t = C.BY_CODE[(tok[1] || '').toLowerCase()];
    if (!t) throw new Error('train: unknown troop code ' + tok[1]);
    return { cmd: 'train', troop: t, amount: num(tok[2] || '1') };
  }

  // production 0 0 0 0   (food wood stone iron, percentages)
  // zeroing them frees all field labour back into idle population
  if (cmd === 'production' || cmd === 'produce') {
    const nums = tok.slice(1).map((x) => parseInt(x, 10));
    if (nums.length !== 4 || nums.some((x) => Number.isNaN(x) || x < 0 || x > 100)) {
      throw new Error('production: usage  production <food> <wood> <stone> <iron>   (0-100 each)');
    }
    return { cmd: 'production', rates: { food: nums[0], wood: nums[1], stone: nums[2], iron: nums[3] } };
  }
  if (cmd === 'tax') {
    const v = parseInt(tok[1], 10);
    if (Number.isNaN(v) || v < 0 || v > 100) throw new Error('tax: usage  tax <0-100>');
    return { cmd: 'tax', rate: v };
  }

  // ---- items ----
  if (cmd === 'buyitem') {
    if (!tok[1]) throw new Error('buyitem: usage  buyitem <itemId> [amount]');
    return { cmd: 'buyitem', itemId: tok[1], amount: parseInt(tok[2] || '1', 10) };
  }
  if (cmd === 'useitem') {
    if (!tok[1]) throw new Error('useitem: usage  useitem <itemId> [num]');
    // The client never spends these through shop.useGoods; each has its own move command.
    if (require('./teleport').ITEM_IDS.has(tok[1])) {
      throw new Error(`useitem: ${tok[1]} is a teleporter — use  teleport <x,y>  |  teleport <state>  |  teleport random  |  warteleport <x,y>`);
    }
    if (tok[1] === require('./stone-of-finding').ITEM_ID) {
      throw new Error('useitem: the Stone of Finding is spent by  recover <hero>  — run  lostheroes  to see who it can bring back');
    }
    if (tok[1] === require('./water-hero').ITEM_ID) {
      throw new Error('useitem: Holy Water is spent on a hero by  waterhero <hero> [/heropoints="att"]');
    }
    return { cmd: 'useitem', itemId: tok[1], amount: parseInt(tok[2] || '1', 10) };
  }
  // useheroitem OTTO excalibur repeat 5    (NEAT spelling)
  // useheroitem OTTO excalibur 5           (same thing)
  // useheroitem OTTO hero.power.1          (ids always work)
  if (cmd === 'useheroitem' || cmd === 'heroitem') {
    const HI = require('./heroitems');
    if (!tok[1] || !tok[2]) {
      throw new Error('useheroitem: usage  useheroitem <hero> <item> [repeat <n>]  |  items: '
        + Object.values(HI.ALL).map((d) => d.names[0]).join(', '));
    }
    const rest = tok.slice(2);
    let times = 1;
    const ri = rest.findIndex((t) => String(t).toLowerCase() === 'repeat');
    if (ri !== -1) { times = parseInt(rest[ri + 1] || '1', 10) || 1; rest.splice(ri, 2); }
    else if (/^\d+$/.test(rest[rest.length - 1] || '')) times = parseInt(rest.pop(), 10) || 1;
    const word = rest.join('');
    const itemId = HI.resolveItem(word);
    if (!itemId) {
      throw new Error(`useheroitem: unknown item "${rest.join(' ')}". Known: `
        + Object.values(HI.ALL).map((d) => d.names[0]).join(', ')
        + ' — or give the raw id, e.g. hero.power.1');
    }
    if (times < 1 || times > 500) throw new Error('useheroitem: repeat must be between 1 and 500');
    // The client resets through hero.resetPoint, never hero.useItem.
    if (itemId === require('./water-hero').ITEM_ID) {
      if (times !== 1) throw new Error('useheroitem: Holy Water resets a hero once — a second one only costs more. Use  waterhero <hero>');
      return { cmd: 'waterhero', ...require('./water-hero').parseArgs(tok[1]) };
    }
    return { cmd: 'useheroitem', heroName: tok[1], itemId, times };
  }
  if (cmd === 'heroitems') return { cmd: 'heroitems' };

  if (cmd === 'packages' || cmd === 'inventory') return { cmd: 'packages' };
  // The Stone of Finding's restore window; see stone-of-finding.js.
  if (cmd === 'lostheroes') return { cmd: 'lostheroes' };
  if (cmd === 'recover') return { cmd, ...require('./stone-of-finding').parseArgs(tok.slice(1)) };
  if (cmd === 'find') {
    if (!tok[1]) throw new Error('find: usage  find <player name>');
    return { cmd: 'find', query: tok.slice(1).join(' ') };
  }

  // ---- hero management ----
  if (cmd === 'heroes' || cmd === 'herolist') return { cmd: 'heroes' };
  if (cmd === 'inn' || cmd === 'tavern') return { cmd: 'inn' };
  if (cmd === 'innrefresh' || cmd === 'refreshinn') return { cmd: 'innrefresh' };
  if (cmd === 'hire') {
    if (!tok[1]) throw new Error('hire: give a hero name, or "best" / "best politics"');
    if (tok[1].toLowerCase() === 'best') {
      const attr = tok[2] ? ATTR[(tok[2] || '').toLowerCase()] : null;
      if (tok[2] && !attr) throw new Error('hire best: attribute must be attack/politics/intel');
      return { cmd: 'hire', best: true, attr };
    }
    return { cmd: 'hire', name: tok.slice(1).join(' ') };
  }
  if (cmd === 'fire' || cmd === 'release') {
    if (!tok[1]) throw new Error(`${cmd}: give a hero name`);
    return { cmd, name: tok.slice(1).join(' ') };
  }
  if (cmd === 'mayor' || cmd === 'appoint') {
    if (!tok[1]) throw new Error('mayor: give a hero name');
    return { cmd: 'mayor', name: tok.slice(1).join(' ') };
  }
  if (cmd === 'unmayor' || cmd === 'unappoint' || cmd === 'dischargemayor') return { cmd: 'unmayor' };
  // Finds the hero in whichever city it is; see rename-hero.js.
  if (cmd === 'renamehero') return { cmd, ...require('./rename-hero').parseArgs(tok.slice(1)) };
  // Holy Water; the rest of the line goes whole, as /heropoints="..." may hold spaces.
  if (cmd === 'waterhero') return { cmd, ...require('./water-hero').parseArgs(line.slice(tok[0].length)) };
  if (cmd === 'levelup') {
    if (!tok[1]) throw new Error('levelup: give a hero name (or "all")');
    const last = (tok[tok.length - 1] || '').toLowerCase();
    let attr = null, nameToks = tok.slice(1);
    if (ATTR[last] || last === 'auto') { attr = last === 'auto' ? null : ATTR[last]; nameToks = tok.slice(1, -1); }
    return { cmd: 'levelup', name: nameToks.join(' '), attr };
  }
  if (cmd === 'addpoint' || cmd === 'addpoints') {
    const attr = ATTR[(tok[tok.length - 2] || '').toLowerCase()];
    const n = parseInt(tok[tok.length - 1], 10);
    if (!attr || Number.isNaN(n)) throw new Error('addpoint: usage  addpoint <hero> <attack|politics|intel> <n>');
    return { cmd: 'addpoint', name: tok.slice(1, -2).join(' '), attr, amount: n };
  }

  // buildcity 123,456   -- turn an owned flat into a new city
  if (cmd === 'buildcity' || cmd === 'newcity') {
    const m = (tok[1] || '').match(/^(\d+)\s*,\s*(\d+)$/);
    if (!m) throw new Error('buildcity: expected coords like 123,456');
    return { cmd: 'buildcity', target: { x: +m[1], y: +m[2] } };
  }

  // build cottage [at 12]   (buildings; troops are `train`)
  if (cmd === 'build') {
    const key = (tok[1] || '').toLowerCase().replace(/[^a-z]/g, '');
    const b = C.BUILDING_BY_CODE[key];
    if (!b) throw new Error('build: unknown building "' + tok[1] + '" (try cottage, academy, feastinghall, barracks…)');
    let at = null;
    const ai = tok.findIndex((t) => t.toLowerCase() === 'at');
    if (ai > 0) at = parseInt(tok[ai + 1], 10);
    return { cmd: 'build', building: b, at };
  }

  // upgrade academy [at 12]
  if (cmd === 'upgrade') {
    const key = (tok[1] || '').toLowerCase().replace(/[^a-z]/g, '');
    const b = C.BUILDING_BY_CODE[key];
    if (!b) throw new Error('upgrade: unknown building "' + tok[1] + '"');
    let at = null;
    const ai = tok.findIndex((t) => t.toLowerCase() === 'at');
    if (ai > 0) at = parseInt(tok[ai + 1], 10);
    return { cmd: 'upgrade', building: b, at };
  }

  // research archery
  if (cmd === 'research') {
    const key = tok.slice(1).join('').toLowerCase().replace(/[^a-z]/g, '');
    const t = C.TECH_BY_CODE[key];
    if (!t) throw new Error('research: unknown tech "' + tok.slice(1).join(' ') + '"');
    return { cmd: 'research', tech: t };
  }

  // Starts a background market sniper and returns at once; see holiday-snipe.js.
  if (cmd === 'holidaysnipe') return { cmd, ...require('./holiday-snipe').parseArgs(tok.slice(1)) };

  // Coordinates spend an Advanced Teleporter, a state name or `random` a City
  // Teleporter, and warteleport a War Teleporter; see teleport.js.
  if (cmd === 'teleport' || cmd === 'warteleport') return { cmd: 'teleport', ...require('./teleport').parseArgs(cmd, tok.slice(1)) };

  if (cmd === 'sell' || cmd === 'buy') {
    // sell wood 1000 @0.55
    const priceTok = tok.find((t) => t.startsWith('@'));
    if (!priceTok) throw new Error(`${cmd}: missing @price`);
    return { cmd, resource: tok[1].toLowerCase(), amount: num(tok[2]), price: priceTok.slice(1) };
  }

  // <mission> <where> [hero] [troops] [resources] [time] [from <city>]
  //   where  x,y, or one of your cities by name ("Home City" in quotes)
  //   hero   a name, any, any:level<500,attack>400 — or none, or left out
  //   time   @:14:30:07.500 lands then (timed-march.js); @0:30:00 or 0:30:00 camps that long
  // `deploy <type> ...` is NEAT's general form of the same line; type bu is a
  // build-city march. Attack and scout need a hero and troops, a build needs
  // troops. Reinforce and transport go without a hero if none is named, and a
  // reinforce with no troop string sends 1 scout.
  const deploy = cmd === 'deploy';
  const mission = deploy ? DEPLOY[(tok[1] || '').toLowerCase()] : cmd;
  if (deploy && !mission) {
    throw new Error('deploy: say the march type first — at (attack), bu (build city), re (reinforce), sc (scout), tr (transport)');
  }
  if (deploy || ['attack', 'scout', 'transport', 'reinforce'].includes(cmd)) {
    const name = deploy ? `deploy ${tok[1].toLowerCase()}` : cmd;
    // "123, 456" and "a:100, c:500" read the same as without the spaces
    const words = (line.replace(/\s*,\s*/g, ',').match(/"[^"]*"|\S+/g) || [])
      .map((w) => w.replace(/^"(.*)"$/, '$1')).slice(deploy ? 1 : 0);
    const isList = (t) => /^[a-z]+:[\d.]+[kmb]?(,[a-z]+:[\d.]+[kmb]?)*$/i.test(t);
    const codes = (t) => t.split(',').map((p) => p.split(':')[0].toLowerCase());
    const allTroops = (t) => isList(t) && codes(t).every((c) => C.BY_CODE[c]);
    const allRes = (t) => isList(t) && codes(t).every((c) => RES_CODE[c]);
    const isTime = (t) => t.startsWith('@') || /^\d+:\d{2}(:\d{2})?$/.test(t);

    const where = words[1] || '';
    if (!where || /^(any|none)(:|$)/i.test(where) || isTime(where) || /^from$/i.test(where) || isList(where)) {
      throw new Error(`${name}: say where first — coords like 123,456, or one of your cities by name`);
    }
    const coords = where.match(/^(\d+),(\d+)$/);
    const target = coords ? { x: +coords[1], y: +coords[2] } : null;
    const targetCity = coords ? null : where;
    if (mission === 'construct' && !coords) throw new Error(`${name}: a build march goes to a flat's coordinates, like 123,456`);

    // No hero sends no heroId at all; see Game.buildArmyBean.
    let from = null, land = null, camp = null, hero, troops = null, resources = null;
    for (let i = 2; i < words.length; i++) {
      const t = words[i];
      if (t.toLowerCase() === 'from') {
        from = words[++i];
        if (!from) throw new Error(`${name}: "from" needs a city name after it`);
        continue;
      }
      if (isTime(t)) {
        if (land || camp !== null) throw new Error(`${name}: one time per march — @:hh:mm:ss to land then, or a camp time`);
        if (t.startsWith('@:')) land = parseLandTime(t); else camp = parseDuration(t);
        continue;
      }
      if (isList(t)) {
        // NEAT reads troops first and resources second, so in a later list
        // s: and w: are stone and wood, not scouts and warriors.
        if (troops === null && allTroops(t)) { troops = parseTroops(t); continue; }
        if (allRes(t)) { resources = { ...resources, ...parseResources(t) }; continue; }
        if (allTroops(t)) { troops = { ...troops, ...parseTroops(t) }; continue; }
        throw new Error(`${name}: "${t}" is neither a troop string nor a resource string`);
      }
      if (hero === undefined) { hero = t.toLowerCase() === 'none' ? null : t; continue; }
      throw new Error(`${name}: unexpected "${t}" — one hero per march${targetCity ? ', and a city name with spaces goes in quotes' : ''}`);
    }
    if ((mission === 'attack' || mission === 'scout') && !hero) {
      throw new Error(`${name}: needs a hero — a name, any, or any:level<500,attack>400`);
    }
    let troopsDefault = false;
    if (!troops) {
      if (mission !== 'reinforce') throw new Error(`${name}: no troop string (e.g. a:1000,c:500${mission === 'construct' ? ', or wo:500 for a build' : ''})`);
      troops = { scouter: 1 };
      troopsDefault = true;
    }
    return { cmd: mission, target, targetCity, hero: hero || null, troops, troopsDefault, resources, land, camp, from };
  }

  throw new Error('unknown command: ' + cmd);
}

// Expands `repeat N` (NEAT-style: run the previous action N more times) and
// `loop N` ... `endloop` blocks into a flat action list. A bare `repeat` cannot
// be flattened, so it leaves a `forever` marker after its action for run().
function expand(raw) {
  const out = [];
  const stack = [];
  for (const a of raw) {
    if (a.cmd === 'loop') { stack.push({ times: a.times, body: [], line: a.line }); continue; }
    if (a.cmd === 'endloop') {
      const blk = stack.pop();
      if (!blk) { out.push({ cmd: 'error', line: a.line, raw: a.raw, error: 'endloop without loop' }); continue; }
      const expanded = [];
      for (let i = 0; i < blk.times; i++) expanded.push(...blk.body.map((x) => ({ ...x })));
      (stack.length ? stack[stack.length - 1].body : out).push(...expanded);
      continue;
    }
    const sink = stack.length ? stack[stack.length - 1].body : out;
    if (a.cmd === 'repeat') {
      const prev = sink[sink.length - 1];
      if (!prev) { sink.push({ cmd: 'error', line: a.line, raw: a.raw, error: 'repeat with no previous action' }); continue; }
      if (prev.cmd === 'forever') { sink.push({ cmd: 'error', line: a.line, raw: a.raw, error: 'the repeat above never ends, so there is nothing after it to repeat' }); continue; }
      if (a.times === null) { sink.push({ cmd: 'forever', action: prev, line: a.line, raw: a.raw }); continue; }
      for (let i = 0; i < a.times; i++) sink.push({ ...prev, round: i + 1, of: a.times });
      continue;
    }
    sink.push(a);
  }
  for (const blk of stack) out.push({ cmd: 'error', line: blk.line, raw: 'loop', error: 'loop without endloop' });
  return out;
}

// opts.check: parse to find the errors only (the editor's colours). Counts over 2
// in `repeat N` / `loop N` are read as 2 — expanding `repeat 100000000` on every
// pause in typing would hang the console, and 2 already raises every error the
// full count would: they are about the lines themselves, and what follows a
// logout is the same from the second pass on.
function parse(text, opts = {}) {
  const raw = [];
  // NEAT's replacement variables: `set target 111,222`, then %target% in any
  // later line reads 111,222. Plain text, swapped in before the line is read.
  const vars = new Map();
  text.split(/\r?\n/).forEach((given, i) => {
    let line = given;
    try {
      line = given.replace(/%([a-z_][a-z0-9_]*)%/gi, (_, name) => {
        const v = vars.get(name.toLowerCase());
        if (v === undefined) throw new Error(`%${name}% is not set — put  set ${name} <value>  above this line`);
        return v;
      });
      const bare = line.replace(/\/\/.*$/, '').trim();
      if (/^set(\s|$)/i.test(bare)) {
        const m = bare.match(/^set\s+([a-z_][a-z0-9_]*)\s+(.+)$/i);
        if (!m) throw new Error('set: usage  set <name> <value>   and then %name% in the lines below');
        vars.set(m[1].toLowerCase(), m[2].trim());
        return;
      }
      const a = parseLine(line);
      if (a) raw.push({ ...a, line: i + 1, raw: line.trim() });
    } catch (e) { raw.push({ cmd: 'error', line: i + 1, raw: line.trim(), error: e.message }); }
  });
  const few = (a) => ((a.cmd === 'repeat' || a.cmd === 'loop') && a.times > 2 ? { ...a, times: 2 } : a);
  const out = expand(opts.check ? raw.map(few) : raw);
  // After a logout there is no game to run anything against (logout.js).
  const lo = out.findIndex((a) => a.cmd === 'logout');
  const after = lo === -1 ? null : out.slice(lo + 1).find((a) => a.cmd !== 'error');
  if (after) out.push({ cmd: 'error', line: after.line, raw: after.raw, error: 'nothing can run after logout — the console is off the game from then on' });
  return out;
}

// Each line's standing for the console editor's colours, in the shape goals.js
// gives goals ({ n, status: ok|error|comment|blank, msg }), plus the errors as
// Apply lists them. Only // is a comment in a script.
function lineStatus(text) {
  const errs = new Map();
  for (const a of parse(String(text || ''), { check: true })) {
    if (a.cmd !== 'error') continue;
    if (!errs.has(a.line)) errs.set(a.line, new Set());
    errs.get(a.line).add(a.error);
  }
  const lines = String(text || '').split(/\r?\n/).map((given, i) => {
    const n = i + 1;
    if (errs.has(n)) return { n, status: 'error', msg: [...errs.get(n)].join('; ') };
    if (!given.trim()) return { n, status: 'blank', msg: null };
    if (!given.replace(/\/\/.*$/, '').trim()) return { n, status: 'comment', msg: null };
    return { n, status: 'ok', msg: null };
  });
  const errors = [...errs].flatMap(([line, set]) => [...set].map((error) => ({ line, error })));
  return { lines, errors };
}

// ---------------------------------------------------------------- executor

// The server sends a human-readable errorMsg on failure -- always show it.
const verdict = (r) => {
  if (!r) return 'no response';
  if (r.ok === 1) return 'ok';
  return `FAILED (ok=${r.ok})` + (r.errorMsg ? ` - ${r.errorMsg}` : ` ${JSON.stringify(r)}`);
};

// A march target given by name is one of your own cities, matched whole.
function ownCity(game, name) {
  const c = (game.castles || []).find((x) => String(x.name || '').toLowerCase() === String(name).toLowerCase());
  if (c) return c;
  throw new Error(`no city of yours is called "${name}" — yours are ${(game.castles || []).map((x) => x.name).join(', ')}.`
    + ' Give x,y for anywhere else, and put a name with spaces in quotes');
}

// opts.shouldStop() is polled between lines and during waits; once it says yes
// the run ends where it is. It is the only way an endless `repeat` ends while
// its line keeps going through.
async function run(game, actions, log, opts = {}) {
  const dryRun = !!opts.dryRun;
  const stopped = () => !!(opts.shouldStop && opts.shouldStop());
  const pause = async (ms) => {
    const end = Date.now() + ms;
    while (!stopped() && Date.now() < end) await new Promise((r) => setTimeout(r, Math.min(250, end - Date.now())));
  };
  let done = 0;
  let lastTradeAt = 0, tradeMisses = 0;
  const sentHeroes = new Map();         // hero id -> when this run sent it

  // `done` counts replies, refusals included, so a refusal is caught here:
  // every server reply goes through say().
  let refused = false;
  const say = (r) => { if (!r || r.ok !== 1) refused = true; return verdict(r); };
  // After a reconnect the session holds a new Game, and the one this run began
  // with talks to a closed socket. Take the session's while it is the same
  // player: the console can switch accounts under a running script.
  const who = (g) => ((g && g.player && g.player.playerInfo) || {}).userName;
  const follow = () => {
    const s = opts.session;
    if (s && s.connected && s.game && s.game !== game && who(s.game) && who(s.game) === who(game)) game = s.game;
  };

  // A `forever` marker puts its action back in front of itself for as long as
  // the last go went through: counted, not refused, and no exception.
  const queue = actions.slice();
  let prev = null, doneBefore = 0;
  while (queue.length) {
    const wentThrough = !!prev && !refused && (done > doneBefore || prev.cmd === 'echo' || prev.cmd === 'sleep');
    refused = false; doneBefore = done;
    if (stopped()) { log('stopped — the rest of the script was not run'); break; }
    follow();
    const a = queue.shift();
    prev = a;
    if (a.cmd === 'forever') {
      const n = a.action.line;
      if (dryRun) { log(`line ${a.line}: repeat — [dry run] would run line ${n} again until it fails or you press Stop`); continue; }
      if (!wentThrough) { log(`line ${a.line}: repeat ends — line ${n} did not go through`); continue; }
      // A line that never waits on the server (echo) would otherwise spin here
      // without yielding, and Stop could never get through.
      await new Promise((r) => setImmediate(r));
      await pause(opts.repeatGapMs ?? 200);
      const round = (a.round || 0) + 1;
      queue.unshift({ ...a.action, round, of: null }, { ...a, round });
      continue;
    }
    if (a.cmd === 'error') { log(`line ${a.line}: PARSE ERROR — ${a.error}`); continue; }
    log(`line ${a.line}: ${a.raw}${a.round ? ` (repeat ${a.round}${a.of ? ' of ' + a.of : ', until it fails or Stop'})` : ''}`);

    try {
      if (a.cmd === 'echo') { log('  ' + a.text); continue; }
      if (a.cmd === 'sleep') {
        if (a.until) {
          const at = nextOccurrence(a.until, game.now());
          log(`  until ${new Date(at).toLocaleTimeString()} on this machine's clock`);
          await pause(at - game.now());
        } else await pause(a.seconds * 1000);
        continue;
      }

      if (a.cmd === 'buildstatus') {
        for (const l of require('./city-build').status(game)) log('  ' + l);
        continue;
      }
      if (a.cmd === 'marchcheck') { await require('./timed-march').check(game, log); continue; }

      // Ends the run: from here the console is off the game (logout.js).
      if (a.cmd === 'logout') {
        const out = await require('./logout').run(game, a, {
          session: opts.session, log, dryRun, stopped, otherScripts: opts.otherScripts, atLogout: opts.atLogout,
        });
        if (out) { done++; break; }
        continue;
      }

      if (a.cmd === 'cleanreports') {
        if (dryRun) { log('  [dry run] would delete all ' + a.type + ' reports'); continue; }
        const n = await game.cleanReports(a.type);
        log(`  removed ${n} ${a.type} report(s)`);
        done++; continue;
      }

      // It needs the console's session, not just this run's game: it outlives
      // the run, follows reconnects, and writes to the Log tab.
      if (a.cmd === 'holidaysnipe') {
        const lines = await require('./holiday-snipe').command(a, { session: opts.session, dryRun });
        for (const l of lines) log('  ' + l);
        done++; continue;
      }

      if (a.cmd === 'production') {
        const castle = game.castle(opts.castle);
        const r0 = castle.resource || {};
        const busy = ['food', 'wood', 'stone', 'iron'].reduce((s2, k) => s2 + Number((r0[k] && r0[k].workPeople) || 0), 0);
        log(`  set production food ${a.rates.food}% wood ${a.rates.wood}% stone ${a.rates.stone}% iron ${a.rates.iron}% (currently ${busy.toLocaleString('en-US')} on fields)`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.setProduction(game.castleId(castle), a.rates);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'tax') {
        const castle = game.castle(opts.castle);
        log(`  set tax rate to ${a.rate}%`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.setTax(game.castleId(castle), a.rate);
        log('  -> ' + say(r));
        done++; continue;
      }

      // ---- items ----
      if (a.cmd === 'buyitem') {
        log(`  buy ${a.amount} x ${a.itemId} from the shop (costs cents)`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.buyItem(a.itemId, a.amount);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'useitem') {
        const castle = game.castle(opts.castle);
        log(`  use ${a.amount} x ${a.itemId} in ${castle.name}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.useItem(game.castleId(castle), a.itemId, a.amount);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'useheroitem') {
        const HI = require('./heroitems');
        log(`  ${a.heroName} <- ${a.times} x ${HI.describeItem(a.itemId)}`);
        if (dryRun) { log('  [dry run] nothing sent'); done++; continue; }
        const r = await HI.useOnHero(game, { heroName: a.heroName, itemId: a.itemId, times: a.times, log });
        if (!r.ok && !r.used) { log('  ' + r.error); continue; }
        const d = (k) => (r.after[k] - r.before[k]);
        const moved = ['power', 'management', 'stratagem', 'experience']
          .filter((k) => d(k) !== 0)
          .map((k) => `${k} ${r.before[k]} -> ${r.after[k]} (+${d(k)})`);
        const spent = r.heldBefore !== undefined && r.heldAfter !== undefined
          ? `, ${r.heldBefore} -> ${r.heldAfter} left` : '';
        log(`  used ${r.used} on ${r.hero} in ${r.castle}${spent}`
          + (moved.length
            ? ' — ' + moved.join(', ')
            : ' — the server accepted and consumed it, but reports no change to the'
              + ' hero attributes it sends us'));
        if (r.error) log('  ' + r.error);
        done++;
        continue;
      }

      if (a.cmd === 'heroitems') {
        const HI = require('./heroitems');
        const rows = HI.heldHeroItems(game);
        if (!rows.length) { log('  no hero items in the inventory'); done++; continue; }
        log('  hero items held:');
        for (const r of rows) log(`    ${String(r.count).padStart(6)}  ${r.label.padEnd(30)} ${r.id}`);
        log('  use any of them with:  useheroitem <hero> <name or id> repeat <n>');
        done++;
        continue;
      }

      if (a.cmd === 'packages') {
        const castle = game.castle(opts.castle);
        const d = await game.packageList(game.castleId(castle));
        const ps = d.packages || [];
        if (!ps.length) { log('  no packages'); continue; }
        for (const p of ps.slice(0, 25)) log(`  [${p.id}] ${p.packageName} (status ${p.status}, ${(p.itemList || []).length} item(s))`);
        if (ps.length > 25) log(`  … and ${ps.length - 25} more`);
        continue;
      }

      if (a.cmd === 'lostheroes' || a.cmd === 'recover') {
        const ok = await require('./stone-of-finding').run(game, a, { castle: opts.castle, dryRun, log });
        if (ok && a.cmd === 'recover') done++;
        continue;
      }

      if (a.cmd === 'find') {
        const D = require('./db');
        const total = D.mapCache.count();
        if (!total) { log('  no map cache yet — run:  node mapscan.js'); continue; }
        const hits = D.mapCache.search(a.query, 500);
        log(`  cache holds ${total.toLocaleString('en-US')} castles (${Math.round((Date.now() - D.mapCache.updatedAt()) / 60000)} min old)`);
        if (!hits.length) { log('  no match'); continue; }
        for (const h of hits.slice(0, 20)) {
          const xy = C.fieldIdToCoords(Number(h.id));
          log(`  ${String(h.userName).padEnd(16)} ${String(h.name || '').padEnd(18)} ${xy.x},${xy.y}  ${h.allianceName || '-'}  pres ${Number(h.prestige || 0).toLocaleString('en-US')}`);
        }
        continue;
      }

      // ---- hero management ----
      if (a.cmd === 'heroes') {
        const castle = game.castle(opts.castle);
        const hs = castle.heros || [];
        if (!hs.length) { log('  no heroes in this city'); continue; }
        for (const h of hs) {
          const dom = Game.dominant(h);
          log(`  ${String(h.name).padEnd(14)} L${String(h.level).padEnd(4)} atk ${String(Game.attrValue(h, 'power')).padStart(4)}  pol ${String(Game.attrValue(h, 'management')).padStart(4)}  int ${String(Game.attrValue(h, 'stratagem')).padStart(4)}  loyalty ${h.loyalty ?? '?'}  unspent ${h.remainPoint || 0}  [${dom === 'power' ? 'attack' : dom === 'management' ? 'politics' : 'intel'} hero]`);
        }
        continue;
      }

      if (a.cmd === 'inn' || a.cmd === 'innrefresh') {
        const castle = game.castle(opts.castle);
        const cid = game.castleId(castle);
        if (a.cmd === 'innrefresh') {
          if (dryRun) { log('  [dry run] would refresh the inn'); continue; }
          const rr = await game.refreshTavern(cid);
          log('  refresh -> ' + say(rr));
          done++;
        }
        const d = await game.tavernList(cid);
        const list = d.heros || [];
        if (!list.length) { log('  inn is empty'); continue; }
        for (const h of list) {
          const dom = Game.dominant(h);
          log(`  ${String(h.name).padEnd(14)} L${String(h.level).padEnd(4)} atk ${String(Game.attrValue(h, 'power')).padStart(4)}  pol ${String(Game.attrValue(h, 'management')).padStart(4)}  int ${String(Game.attrValue(h, 'stratagem')).padStart(4)}  [${dom === 'power' ? 'attack' : dom === 'management' ? 'politics' : 'intel'}]`);
        }
        continue;
      }

      if (a.cmd === 'hire') {
        const castle = game.castle(opts.castle);
        const cid = game.castleId(castle);
        let name = a.name;
        if (a.best) {
          const d = await game.tavernList(cid);
          const list = d.heros || [];
          if (!list.length) { log('  inn is empty, nothing to hire'); continue; }
          const key = a.attr || null;
          const scored = list.map((h) => ({ h, v: key ? Game.attrValue(h, key) : Math.max(Game.attrValue(h, 'power'), Game.attrValue(h, 'management'), Game.attrValue(h, 'stratagem')) }));
          scored.sort((x, y) => y.v - x.v);
          name = scored[0].h.name;
          log(`  best${a.attr ? ' ' + a.attr : ''} in the inn: ${name} (${scored[0].v})`);
        }
        log(`  hire ${name}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.hireHero(cid, name);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'fire' || a.cmd === 'release') {
        const castle = game.castle(opts.castle);
        const h = game.findHero(castle, a.name);
        if (!h) { log(`  no hero named "${a.name}" in ${castle.name}`); continue; }
        log(`  ${a.cmd} ${h.name} (id ${h.id}, L${h.level})`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = a.cmd === 'fire' ? await game.fireHero(game.castleId(castle), h.id)
                                   : await game.releaseHero(game.castleId(castle), h.id);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'mayor') {
        const castle = game.castle(opts.castle);
        const h = game.findHero(castle, a.name);
        if (!h) { log(`  no hero named "${a.name}"`); continue; }
        log(`  appoint ${h.name} as mayor of ${castle.name}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.promoteToChief(game.castleId(castle), h.id);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'renamehero') {
        if (await require('./rename-hero').run(game, a, { dryRun, log })) done++;
        continue;
      }

      if (a.cmd === 'waterhero') {
        if (await require('./water-hero').run(game, a, { dryRun, log })) done++;
        continue;
      }

      if (a.cmd === 'unmayor') {
        const castle = game.castle(opts.castle);
        log(`  remove the mayor of ${castle.name}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.dischargeChief(game.castleId(castle));
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'levelup') {
        const castle = game.castle(opts.castle);
        const cid = game.castleId(castle);
        const targets = a.name.toLowerCase() === 'all' ? (castle.heros || []) : [game.findHero(castle, a.name)].filter(Boolean);
        if (!targets.length) { log(`  no hero named "${a.name}"`); continue; }

        for (const h of targets) {
          const dom = a.attr || Game.dominant(h);
          const label = dom === 'power' ? 'attack' : dom === 'management' ? 'politics' : 'intel';
          log(`  ${h.name} L${h.level} -> level up, points go to ${label}${a.attr ? '' : ' (dominant)'}`);
          if (dryRun) { log('  [dry run] not sent'); continue; }

          const r = await game.levelUpHero(cid, h.id);
          log('    levelUp -> ' + say(r));
          if (r.ok !== 1) continue;

          const fresh = (await game.heroAfter(castle, h.id)) || h;
          const pts = Number(fresh.remainPoint || 0);
          if (pts <= 0) { log('    no unspent points to assign'); done++; continue; }
          const alloc = { management: 0, power: 0, stratagem: 0 };
          alloc[dom] = pts;
          const ar = await game.addPoint(cid, fresh, alloc);   // increments; game.js converts to totals
          log(`    +${pts} ${label} -> ` + say(ar));
          done++;
        }
        continue;
      }

      if (a.cmd === 'addpoint') {
        const castle = game.castle(opts.castle);
        const h = game.findHero(castle, a.name);
        if (!h) { log(`  no hero named "${a.name}"`); continue; }
        const label = a.attr === 'power' ? 'attack' : a.attr === 'management' ? 'politics' : 'intel';
        log(`  ${h.name}: +${a.amount} ${label} (unspent ${h.remainPoint || 0})`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const alloc = { management: 0, power: 0, stratagem: 0 };
        alloc[a.attr] = a.amount;
        const r = await game.addPoint(game.castleId(castle), h, alloc);   // increments; game.js converts to totals
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'buildcity') {
        const castle = game.castle(opts.castle);
        const fieldId = C.coordsToFieldId(a.target.x, a.target.y);
        log(`  found city on flat ${a.target.x},${a.target.y} (field ${fieldId}) from ${castle.name}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.constructCastle(game.castleId(castle), fieldId, false);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'teleport') {
        const moved = await require('./teleport').run(game, a, { castle: opts.castle, session: opts.session, dryRun, log });
        if (moved) done++;
        continue;
      }

      if (a.cmd === 'build') {
        const castle = game.castle(opts.castle);
        const cid = game.castleId(castle);

        // explain prerequisites BEFORE spending a round trip on a doomed build
        const cond = await game.buildConditions(cid, a.building.typeId).catch(() => null);
        const missing = game.unmet(cond);
        if (cond) log(`  ${a.building.name}: costs ${['wood', 'stone', 'iron', 'food'].map((k) => `${k} ${(cond[k] || 0).toLocaleString('en-US')}`).join(', ')}, ${cond.time}s`);
        if (missing.length) {
          log(`  BLOCKED - needs ${missing.map((m) => m.text).join('; ')}`);
          if (opts.autoReq) {
            for (const m of missing.filter((x) => x.kind === 'building')) {
              const spot = game.findBuildings(castle, m.typeId)[0];
              if (!spot) { log(`    cannot auto-fix: no ${(C.BUILDING_BY_ID[m.typeId] || {}).name} in this city to upgrade`); continue; }
              if (dryRun) { log(`    [dry run] would upgrade ${(C.BUILDING_BY_ID[m.typeId] || {}).name} at pos ${spot.positionId}`); continue; }
              const ur = await game.upgradeBuilding(cid, spot.positionId);
              log(`    queued upgrade of ${(C.BUILDING_BY_ID[m.typeId] || {}).name} (pos ${spot.positionId}) -> ${say(ur)}`);
            }
            log('    prerequisite queued - re-run this line once it finishes');
          }
          continue;
        }

        const pos = a.at ?? game.freeSlot(castle, !!a.building.outside);
        if (pos === null || pos === undefined || Number.isNaN(pos)) { log(`  no free ${a.building.outside ? 'field' : 'city'} slot - specify one with "at N"`); continue; }
        log(`  build ${a.building.name} (type ${a.building.typeId}) at position ${pos}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.newBuilding(cid, pos, a.building.typeId);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'upgrade') {
        const castle = game.castle(opts.castle);
        const cid = game.castleId(castle);
        const spots = game.findBuildings(castle, a.building.typeId);
        if (!spots.length) { log(`  no ${a.building.name} in ${castle.name}`); continue; }
        const spot = a.at != null ? spots.find((s) => s.positionId === a.at) || { positionId: a.at } : spots.sort((x, y) => (x.level || 0) - (y.level || 0))[0];

        const chk = await game.checkUpgrade(cid, spot.positionId).catch(() => null);
        if (chk && chk.ok !== 1) { log(`  BLOCKED - ${say(chk)}`); continue; }
        const missing = game.unmet(chk && (chk.conditionBean || chk.condition));
        if (missing.length) {
          log(`  BLOCKED - needs ${missing.map((m) => m.text).join('; ')}`);
          if (!opts.autoReq) continue;
          for (const m of missing.filter((x) => x.kind === 'building')) {
            const s2 = game.findBuildings(castle, m.typeId)[0];
            if (!s2) { log('    cannot auto-fix: prerequisite building not present'); continue; }
            if (dryRun) { log(`    [dry run] would upgrade ${(C.BUILDING_BY_ID[m.typeId] || {}).name}`); continue; }
            const ur = await game.upgradeBuilding(cid, s2.positionId);
            log(`    queued upgrade of ${(C.BUILDING_BY_ID[m.typeId] || {}).name} -> ${say(ur)}`);
          }
          continue;
        }

        log(`  upgrade ${a.building.name} at position ${spot.positionId} (level ${spot.level ?? '?'})`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.upgradeBuilding(cid, spot.positionId);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'research') {
        const castle = game.castle(opts.castle);
        const cid = game.castleId(castle);
        const list = await game.researchList(cid).catch(() => null);
        const beans = (list && (list.acailableResearchBeans || list.availableResearchBeans)) || [];
        const bean = beans.find((b) => b.typeId === a.tech.typeId);
        if (bean) log(`  ${a.tech.name}: level ${bean.level}/${bean.avalevel}${bean.upgradeing ? ' (already researching)' : ''}`);
        log(`  research ${a.tech.name} (tech ${a.tech.typeId}) in ${castle.name}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.research(cid, a.tech.typeId);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'cancelqueue') {
        const n = await require('./queue-cancel').run(game, a, { castle: opts.castle, session: opts.session, dryRun, log });
        if (n) done++;
        continue;
      }

      if (a.cmd === 'wall') {
        const castle = game.castle(opts.castle);
        log(`  build ${a.amount.toLocaleString('en-US')} x ${a.wall.name} (type ${a.wall.typeId}) in ${castle.name}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.produceWall(game.castleId(castle), a.wall.typeId, a.amount);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'train') {
        const castle = game.castle(opts.castle);
        log(`  train ${a.amount.toLocaleString('en-US')} x ${a.troop.name} (type ${a.troop.typeId}) in ${castle.name}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.produceTroop(game.castleId(castle), a.troop.typeId, a.amount);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'sell' || a.cmd === 'buy') {
        const castle = game.castle(opts.castle);
        log(`  ${a.cmd} ${a.amount.toLocaleString()} ${a.resource} @ ${a.price} from ${castle.name || game.castleId(castle)}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }

        // A refused or unanswered order costs only its own go: the lines after
        // it, and every round of a `repeat N`, still run. Market writes are
        // paced, and each unanswered one in a row doubles the gap, up to a
        // minute, rather than hammering a server that has stopped answering.
        const gapAfter = (misses) => Math.min(60000, Number(opts.tradeGapMs ?? 1200) * 2 ** misses);
        if (lastTradeAt) {
          const wait = gapAfter(tradeMisses) - (Date.now() - lastTradeAt);
          if (wait > 0) await pause(wait);
          if (stopped()) { log('  stopped before it was sent'); break; }
          follow();   // the session may have reconnected during a long wait
        }
        lastTradeAt = Date.now();

        let r;
        try {
          r = await game.newTrade({ castleId: game.castleId(castle), resource: a.resource, type: a.cmd, amount: a.amount, price: a.price });
        } catch (e) {
          tradeMisses++;
          log(`  -> ${e.message} — carrying on, the next order waits ${Math.round(gapAfter(tradeMisses) / 1000)}s`);
          continue;
        }
        tradeMisses = 0;
        log('  -> ' + say(r));
        if (r.ok === -38) log('  marketplace full (10 offers max) — this one is skipped, the script carries on');
        done++; continue;
      }

      // ---- marches ----
      const castle = game.castle(a.from ?? opts.castle);
      const from = game.castleXY(castle);
      const toCity = a.targetCity ? ownCity(game, a.targetCity) : null;
      const target = toCity ? game.castleXY(toCity) : a.target;
      if (!target) throw new Error(`cannot tell where ${toCity.name} is`);
      if (toCity && game.castleId(toCity) === game.castleId(castle)) throw new Error(`${toCity.name} is the city this march would leave from`);
      const targetPoint = C.coordsToFieldId(target.x, target.y);
      const troopKeys = Object.keys(a.troops).filter((k) => a.troops[k] > 0);
      const construct = a.cmd === 'construct';
      if (construct) for (const n of require('./city-build').preflight(game, targetPoint)) log('  ' + n);

      const troopText = troopKeys.map((k) => `${a.troops[k].toLocaleString('en-US')} ${(C.BY_KEY[k] || {}).name || k}`).join(', ');
      // Base load only: research raises it, so this warns rather than refuses.
      const carried = Object.values(a.resources || {}).reduce((s2, v) => s2 + v, 0);
      const load = troopKeys.reduce((s2, k) => s2 + a.troops[k] * ((C.BY_KEY[k] || {}).load || 0), 0);
      if (carried > load) log(`  note: ${troopText} carry about ${load.toLocaleString('en-US')} before research, and this asks for ${carried.toLocaleString('en-US')} — the server may refuse`);

      // Built for each send, so a march that is recalled and sent again can take
      // another idle hero. An `any` skips the heroes this run sent in the last
      // minute: the HeroUpdate saying they are away can come after the next line.
      let hero = null;
      const makeBean = (restTimeSec) => {
        const skip = new Set([...sentHeroes].filter(([, at]) => Date.now() - at < 60000).map(([id]) => id));
        hero = a.hero ? game.pickHero(castle, a.hero, skip) : null;
        const bean = game.buildArmyBean({
          missionType: C.MISSION[a.cmd],
          heroId: hero ? hero.id : undefined,
          targetPoint,
          troops: a.troops,
          resources: a.resources || {},
          restTimeSec,
        });
        log(`  ${construct ? 'build city' : a.cmd} -> ${toCity ? toCity.name + ' ' : ''}(${target.x},${target.y}) field ${targetPoint} from ${castle.name}`
          + ` · hero ${hero ? (hero.name || hero.id) : 'none'} · ${troopText}${a.troopsDefault ? ' (no troop string given)' : ''} · missionType ${bean.missionType}`);
        return bean;
      };

      // Land at a moment: sent to the ms, checked against the server's stamp,
      // and recalled and resent if it misses (timed-march.js).
      if (a.land) {
        if (!from) throw new Error('cannot compute march time (castle coords unknown) — @: needs it');
        const res = await require('./timed-march').send({
          game, castle, construct, from, target, targetPoint, toCity, troopKeys,
          aimMs: nextOccurrence(a.land, game.now()), makeBean, log, stopped, dryRun,
        });
        if (res.sent) { done++; if (hero) sentHeroes.set(hero.id, Date.now()); } else if (!dryRun) refused = true;
        if (res.why === 'stopped') break;
        continue;
      }

      const march = from ? C.marchTimeMs(from, target, troopKeys, game.marchSkillParam) : null;
      const restTimeSec = a.camp || 0;
      if (march !== null) {
        log(`  march ${(march / 1000).toFixed(1)}s` + (restTimeSec
          ? `, camp ${require('./timed-march').dur(restTimeSec * 1000)} (lands when the camp is over)`
          : ' (no @: time, lands on arrival)'));
      }
      const bean = makeBean(restTimeSec);
      if (dryRun) { log('  [dry run] not sent'); continue; }
      const r = await game.newArmy(game.castleId(castle), bean);
      log('  -> ' + say(r));
      if (r && r.ok === 1 && hero) sentHeroes.set(hero.id, Date.now());
      done++;
    } catch (e) {
      log(`  FAILED: ${e.message}`);
      if (opts.stopOnError) break;
    }
  }
  return done;
}

module.exports = { parse, parseLine, lineStatus, run, parseTroops, parseResources, parseLandTime, parseDuration, nextOccurrence };
