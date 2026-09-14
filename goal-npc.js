'use strict';
// NPC farming — the economic engine.
//
// What the NEAT wiki (guide.neatportal.com/wiki/Npc) says this has to do, and
// what is reproduced here:
//
//   * `config npc:<n>` turns it on. n is the LOWEST level you want farmed: the bot
//     starts with the highest level it can actually supply and works DOWN to n as
//     transports / ballistas / troops / heroes run short.
//   * Levels 1-5 march as ballistas + transports. Levels 6-10 march as archers +
//     "layers" + transports and additionally REQUIRE an `npclimits` line, plus an
//     `npctroops` line (the wiki lists no default troop load for 6-10).
//   * Safe ballista counts: L5 550, L4 350, L3 170, L2 50, L1 20.
//   * A hero whose ATTACK is under 50 forces the safe ballista count regardless of
//     `npctroops` / `config ballsused` — but `/safeballs` in `farmingpolicy` still
//     decides what "safe" means.
//   * One pass starts at the closest npc and works outward. The pass restarts on
//     the farming cycle: 1h under `config training:1` / `training10:1`, else
//     `/farmingcycle` in farmingpolicy, else `config farmingcycle:x`, else 8h.
//   * How many runs may be in the air at once comes from `npcteams` (default 10),
//     which counts farming teams — attacks — and not transports or
//     reinforcements (wiki NpcTeams). The rally spot's slots and `rallypolicy`
//     n: / n:<level>: / max: limit it further (rally.js).
//   * `config npclimit:<days>` stops farming once the city holds that many days of
//     food — unless `config training` is on, in which case it keeps going hourly
//     for the hero experience.
//
// Everything in `plans` is PURE: it reads the map cache, the castle bean and the
// per-city state object and returns action descriptors. Only `executors.npcAttack`
// ever talks to the server.
//
// Marked INFERRED below: anything not pinned to a wiki page or the decompiled
// client. Those are the parts worth checking against a live run.
const fs = require('fs');
const path = require('path');
const C = require('./constants');
const R = require('./rally');
const H = require('./goal-heroes');
const W = require('./goal-war');

const n = (x) => Number(x || 0);
const fmt = (x) => Math.round(n(x)).toLocaleString('en-US');
const kv =(s) => { const i = String(s).indexOf(':'); return i < 0 ? [String(s), null] : [String(s).slice(0, i), String(s).slice(i + 1)]; };

// same number grammar as goals.js: 5k / 1.5m / 400
const NUM = (s) => {
  const m = String(s == null ? '' : s).trim().match(/^([\d.]+)\s*([kmbd])?$/i);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9, d: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
};

// ---------------------------------------------------------------- the tables

// Wiki-verified. The number of ballistas that survives each level without losses.
const SAFE_BALLISTAS = { 1: 20, 2: 50, 3: 170, 4: 350, 5: 550 };

// INFERRED. Total resources a full clear of one camp hands back, used ONLY to
// size the transport escort. Over-estimating costs a few extra transports;
// under-estimating leaves resources on the ground. Override per level with
// `npctroops <level> ...,t:<n>` and this table is not consulted at all.
const NPC_LOOT = {
  1: 20e3, 2: 50e3, 3: 100e3, 4: 200e3, 5: 400e3,
  6: 500e3, 7: 600e3, 8: 800e3, 9: 1000e3, 10: 1200e3,
};

const DEFAULT_CYCLE_H = 8;        // wiki: "If nothing is set, then use 8-hour cycles"
const TRAINING_CYCLE_H = 1;       // wiki: "config training:1 ... farm every hour"
const DEFAULT_TEAMS = 10;         // wiki: NpcTeams default
const DEFAULT_RADIUS = 20;        // INFERRED: DistancePolicy's default is unread (wiki was down)
const HERO_ATTACK_FLOOR = 50;     // wiki: attack < 50 forces the safe ballista count
const MAX_NPC_LEVEL = 10;

// NEAT troop codes that differ from ours (mirrors the ALIAS map in goals.js).
const TROOP_ALIAS = {
  warr: 'w', cav: 'c', ram: 'r', trans: 't', arch: 'a', pike: 'p', sword: 'sw',
  scout: 's', phract: 'cata', worker: 'wo', ball: 'b', balls: 'b', cat: 'cp',
};

const troopDef = (code) => {
  const k = String(code || '').toLowerCase();
  return C.BY_CODE[k] || C.BY_CODE[TROOP_ALIAS[k]] || C.BY_KEY[k] || null;
};

function parseTroopSpec(text, errs) {
  const out = {};
  for (const part of String(text || '').split(',')) {
    const t = part.trim();
    if (!t) continue;
    const [code, amt] = kv(t);
    const def = troopDef(code);
    if (!def) { errs.push(`unknown troop code "${code}"`); continue; }
    const v = NUM(amt);
    if (v === null) { errs.push(`bad amount "${amt}" for ${code}`); continue; }
    out[def.key] = v;
  }
  return out;
}

// "5 ..." -> level 5; anything else leaves the args alone.
function takeLevel(args) {
  const m = String(args[0] == null ? '' : args[0]).match(/^([1-9]|10)$/);
  return m ? { level: Number(args.shift()), rest: args } : { level: null, rest: args };
}

function parseSwitches(args, errs, allowed) {
  const sw = {};
  for (const tok of args) {
    if (!String(tok).startsWith('/')) { errs.push(`expected /switch:value, got "${tok}"`); continue; }
    const [k, v] = kv(String(tok).slice(1));
    const key = k.toLowerCase();
    if (allowed && !allowed.has(key)) errs.push(`/${k} is not supported by this build (known: ${[...allowed].map((x) => '/' + x).join(' ')})`);
    sw[key] = v === null ? true : (NUM(v) ?? v);
  }
  return sw;
}

// "111,222" -> {x:111, y:222}
function parseCoord(tok, errs) {
  const m = String(tok).match(/^\(?\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)?$/);
  if (!m) { errs.push(`"${tok}" is not a coordinate (expected x,y)`); return null; }
  return { x: Number(m[1]), y: Number(m[2]) };
}

// ------------------------------------------------------------------ parsers

const parsers = {
  // npcheroes [level] <hero-string>       wiki: NpcHeroes (default: any)
  //   npcheroes !OTTO,any        every hero but OTTO, every level
  //   npcheroes 10 any           ...except npc10s, which any hero may hit
  npcheroes: {
    kind: 'directive', multi: true,
    parse(args) {
      const errs = [];
      const { level, rest } = takeLevel(args.slice());
      const spec = rest.join(' ').trim() || 'any';
      if (!rest.length) errs.push('needs a hero string (e.g. "any", a hero name, "!name,any" or "any:attack>100")');
      else errs.push(...H.parseHeroString(spec).errors);
      return { level, spec, errors: errs };
    },
  },

  // npctroops [level] <troops>            wiki: NpcTroops  e.g. npctroops 5 b:400,t:400
  npctroops: {
    kind: 'directive', multi: true,
    parse(args) {
      const errs = [];
      const { level, rest } = takeLevel(args.slice());
      const troops = parseTroopSpec(rest.join(''), errs);
      if (level === null) errs.push('no npc level given — this load will be used for every level');
      if (!Object.keys(troops).length) errs.push('no troops given (e.g. npctroops 5 b:550,t:100)');
      return { level, troops, errors: errs };
    },
  },

  // npclimits <level> <troops>            wiki: NpcLimits — required for levels 6-10.
  // "the minimum number of troops it must have in the city before it will farm another"
  npclimits: {
    kind: 'directive', multi: true,
    parse(args) {
      const errs = [];
      const { level, rest } = takeLevel(args.slice());
      const troops = parseTroopSpec(rest.join(''), errs);
      if (level === null) errs.push('needs an npc level (e.g. npclimits 10 a:390k,s:50k)');
      if (!Object.keys(troops).length) errs.push('needs the troops that must stay in the city');
      return { level, troops, errors: errs };
    },
  },

  // npcteams <n>                          wiki: NpcTeams (default 10)
  npcteams: {
    kind: 'directive', multi: false,
    parse(args) {
      const errs = [];
      const teams = NUM(args[0]);
      if (teams === null || teams < 1) errs.push('expected: npcteams <number of teams>');
      return { teams: teams === null ? DEFAULT_TEAMS : teams, errors: errs };
    },
  },

  // npclist [level] x,y x,y ...           wiki: NpcList — restrict to these camps only
  npclist: {
    kind: 'directive', multi: true,
    parse(args) {
      const errs = [];
      const { level, rest } = takeLevel(args.slice());
      const coords = rest.flatMap((t) => String(t).split(/\s+/)).map((t) => parseCoord(t, errs)).filter(Boolean);
      if (!coords.length) errs.push('needs at least one npc coordinate (e.g. npclist 5 111,222 111,333)');
      return { level, coords, errors: errs };
    },
  },

  // npcbounds <level> Xmin Xmax Ymin Ymax wiki: NpcBounds
  npcbounds: {
    kind: 'directive', multi: true,
    parse(args) {
      const errs = [];
      const { level, rest } = takeLevel(args.slice());
      const nums = rest.map((x) => NUM(x));
      if (nums.length !== 4 || nums.some((x) => x === null)) {
        errs.push('expected: npcbounds <level> <Xmin> <Xmax> <Ymin> <Ymax>');
        return { level, box: null, errors: errs };
      }
      const [xMin, xMax, yMin, yMax] = nums;
      return { level, box: { xMin: Math.min(xMin, xMax), xMax: Math.max(xMin, xMax), yMin: Math.min(yMin, yMax), yMax: Math.max(yMin, yMax) }, errors: errs };
    },
  },

  // farmingpolicy [level] /switch:value   wiki: FarmingPolicy
  // INFERRED switch set — the wiki page would not load. /farmingcycle and
  // /safeballs are named on the Npc page, the rest are convenience.
  farmingpolicy: {
    kind: 'policy', multi: true,
    parse(args) {
      const errs = [];
      const { level, rest } = takeLevel(args.slice());
      const sw = parseSwitches(rest, errs, new Set(['farmingcycle', 'safeballs', 'distance', 'teams']));
      return { level, switches: sw, errors: errs };
    },
  },

  // distancepolicy 20 | distancepolicy npc 20 | distancepolicy /npc:20 /valley:5
  // Only the npc radius is read here; other kinds are kept for whoever wants them.
  distancepolicy: {
    kind: 'policy', multi: false,
    parse(args) {
      const errs = [];
      const sw = {};
      let radius = null;
      const rest = [];
      for (const tok of args) {
        if (String(tok).startsWith('/')) { const [k, v] = kv(String(tok).slice(1)); sw[k.toLowerCase()] = v === null ? true : (NUM(v) ?? v); }
        else rest.push(tok);
      }
      if (rest.length === 1 && NUM(rest[0]) !== null) radius = NUM(rest[0]);
      else if (rest.length === 2 && NUM(rest[1]) !== null) sw[String(rest[0]).toLowerCase()] = NUM(rest[1]);
      else if (rest.length) errs.push('expected: distancepolicy <tiles>  |  distancepolicy <kind> <tiles>  |  distancepolicy /npc:<tiles>');
      if (radius === null && !Object.keys(sw).length) errs.push('no distance given');
      return { radius, switches: sw, errors: errs };
    },
  },

  // rallypolicy is a core goal now (rally.js): it caps transports and
  // reinforcements as well as npc teams.

  // excludelist x,y x,y | excludelist SomePlayer   wiki: ExcludeList
  excludelist: {
    kind: 'directive', multi: true,
    parse(args) {
      const errs = [], coords = [], names = [];
      for (const tok of args.flatMap((t) => String(t).split(/[\s]+/))) {
        if (!tok) continue;
        if (/^\(?\d{1,3}\s*,\s*\d{1,3}\)?$/.test(tok)) { const c = parseCoord(tok, errs); if (c) coords.push(c); }
        else names.push(tok.toLowerCase());
      }
      if (!coords.length && !names.length) errs.push('needs coordinates (x,y) or names to leave alone');
      return { coords, names, errors: errs };
    },
  },
};

// Config keys this module reads. goals.js keeps its own CONFIG_KEYS set and will
// warn "unknown config key" for these until they are merged in there.
const configKeys = ['npc', 'npclimit', 'ballsused', 'training', 'training10', 'farmingcycle', 'farmingcyclemin'];

// ------------------------------------------------------------- the map cache

let _cache = { version: -1, value: null };

// Reads the map cache (never writes it). `src` may be an already parsed cache
// object — the tests hand fixtures in that way — or a path to a legacy
// mapcache.json. With neither, it reads the SQLite store.
function loadNpcCache(src) {
  if (src && typeof src === 'object') return digestCache(src);
  if (typeof src === 'string') {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, '')); }
    catch { return { ok: false, reason: 'map cache unreadable', npcs: [], unleveled: 0 }; }
    return digestCache(raw);
  }
  const D = require('./db');
  if (!D.mapCache.count()) return { ok: false, reason: 'no map cache yet — scan the map first', npcs: [], unleveled: 0 };
  const v = D.mapCache.version();
  if (_cache.version === v && _cache.value) return _cache.value;
  const value = digestCache(D.mapCache.asJson());
  _cache = { version: v, value };
  return value;
}

// Only entries that are an npc AND carry a level are usable: a plain mapscan.js
// sweep stores castles without the terrain byte, so their level is unknown and we
// cannot pick a troop load for them.
function digestCache(raw) {
  const all = Object.values((raw && raw.castles) || {});
  const npcs = [];
  let unleveled = 0;
  for (const c of all) {
    if (!(c.npc === true || c.kind === 'npc')) continue;
    const level = Number(c.level);
    if (!Number.isFinite(level) || level < 1 || level > MAX_NPC_LEVEL) { unleveled++; continue; }
    const id = Number(c.id);
    const xy = Number.isFinite(c.x) && Number.isFinite(c.y) ? { x: Number(c.x), y: Number(c.y) } : C.fieldIdToCoords(id);
    npcs.push({ id, x: xy.x, y: xy.y, level, name: c.name || "Barbarian's city", seen: n(c.seen) });
  }
  return { ok: true, reason: null, npcs, unleveled, updatedAt: n(raw && raw.updatedAt) };
}

// ------------------------------------------------------------------ mechanics

// Client-verified (NewArmyWin.as:2853): a troop's carrying capacity is
// load * count * (1 + loadSkillParam/100). loadSkillParam is the Logistics
// research bonus the server hands back in army.getTroopParam.
const capacityOf = (troops, loadSkill) => Object.entries(troops)
  .reduce((s, [k, v]) => s + (C.BY_KEY[k] ? C.BY_KEY[k].load * n(v) * (1 + n(loadSkill) / 100) : 0), 0);

// Client-verified (NewArmyWin.as:2852 + :3102): marching food is foodRequest*2 per
// troop per hour of ONE-WAY march time — i.e. the round trip — and it is carried
// in the same hold as the loot (leftSpace = loads - portableFood). One helper for
// every goal that marches (C.marchFood), so hiding charges exactly the same.
const marchFoodOf = (troops, oneWayMs) => C.marchFood(troops, oneWayMs);

const oneWayMsTo = (from, to, troops, marchSkill) =>
  n(C.marchTimeMs(from, to, Object.keys(troops).filter((k) => n(troops[k]) > 0), n(marchSkill) || 100));

// Days of food left, at the current garrison's upkeep. `config npclimit:<days>`
// compares against this. INFERRED: population upkeep is ignored, troops dominate.
function foodDays(castle) {
  const res = castle.resource || {};
  const food = n(res.food && res.food.amount);
  let perHour = 0;
  for (const [k, v] of Object.entries(castle.troop || {})) if (C.BY_KEY[k]) perHour += n(v) * C.BY_KEY[k].food;
  if (perHour <= 0) return Infinity;
  return food / (perHour * 24);
}

// ------------------------------------------------------------ hero selection
// The full NEAT hero string (wiki HeroString), read by goal-heroes.js so every
// goal that names heroes agrees on what a string means:
//   any    Alexander    bob,fred    !OTTO,any    any:attack>100,level<80    a|b
// `roster` is the whole city, which is what best/worst measure against, so
// "any:attack=best" waits for the best hero rather than sending the runner-up.

// The attribute field ALREADY includes allocated points (HeroProperties.as reads
// h.power directly, never powerAdded) — same rule as Game.attrValue. Adding
// *Added here would inflate every hero and quietly defeat the under-50 rule.
const heroAttack = (h) => n(h.power);

function heroCandidates(pool, spec, roster) {
  const parsed = H.parseHeroString(spec || 'any');
  const everyone = roster && roster.length ? roster : pool;
  // strongest first: attack is what keeps losses off, and it is what the
  // under-50 rule keys on.
  return pool.filter((h) => H.matchHero(h, parsed, everyone))
    .sort((a, b) => heroAttack(b) - heroAttack(a));
}

// ------------------------------------------------------------- goal plumbing

const goalsNamed = (ctx, name) => (ctx.goals || []).filter((g) => g.name === name);
// a level-specific line wins; a line written without a level is the fallback
const forLevel = (list, level) => list.find((g) => g.level === level) || list.find((g) => g.level == null) || null;

// wiki HeroString: several npcheroes lines for one level are OR'd, as if joined
// with '|'. Lines for this level win; the lines written without a level cover
// every level that has none of its own.
function heroSpecFor(ctx, level) {
  const list = goalsNamed(ctx, 'npcheroes');
  const own = list.filter((g) => g.level === level);
  const use = own.length ? own : list.filter((g) => g.level == null);
  return use.length ? use.map((g) => g.spec).join('|') : 'any';
}

function radiusFor(ctx, level) {
  const fp = forLevel(goalsNamed(ctx, 'farmingpolicy'), level);
  if (fp && fp.switches && n(fp.switches.distance) > 0) return n(fp.switches.distance);
  const dp = goalsNamed(ctx, 'distancepolicy')[0];
  if (dp) {
    const sw = dp.switches || {};
    if (n(sw.npc) > 0) return n(sw.npc);
    if (n(dp.radius) > 0) return n(dp.radius);
    if (n(sw.all) > 0) return n(sw.all);
  }
  return DEFAULT_RADIUS;
}

// wiki Npc, in this order: training -> /farmingcycle -> config farmingcycle -> 8h
function cycleMsFor(ctx, level) {
  const cfg = ctx.config || {};
  const training = level >= MAX_NPC_LEVEL ? n(cfg.training10) >= 1 || n(cfg.training) >= 1 : n(cfg.training) >= 1;
  let hours;
  if (training) hours = TRAINING_CYCLE_H;
  else {
    const fp = forLevel(goalsNamed(ctx, 'farmingpolicy'), level);
    if (fp && fp.switches && n(fp.switches.farmingcycle) > 0) hours = n(fp.switches.farmingcycle);
    else if (n(cfg.farmingcycle) > 0) hours = n(cfg.farmingcycle);
    else hours = DEFAULT_CYCLE_H;
  }
  const ms = hours * 3600000;
  const floorMin = n(cfg.farmingcyclemin);   // INFERRED: FarmingCycleMin read as a minute floor
  return floorMin > 0 ? Math.max(ms, floorMin * 60000) : ms;
}

// How many farming teams may be out. The rally spot and rallypolicy are the
// rally book's to enforce (rally.js), across every kind of march.
function teamCapFor(ctx) {
  const teamsGoal = goalsNamed(ctx, 'npcteams')[0];
  const reasons = [];
  let teams = teamsGoal ? n(teamsGoal.teams) : DEFAULT_TEAMS;
  reasons.push(teamsGoal ? `npcteams ${teams}` : `npcteams ${teams} (default)`);

  const fp = forLevel(goalsNamed(ctx, 'farmingpolicy'), null);
  const fpTeams = fp && fp.switches ? n(fp.switches.teams) : 0;
  if (fpTeams > 0 && fpTeams < teams) { teams = fpTeams; reasons.push(`farmingpolicy /teams:${fpTeams}`); }
  return { teams: Math.max(0, teams), why: reasons.join(', ') };
}

// Marches this city currently has out, straight from the live army list. Only
// the attacks are farming teams; everything else still holds a rally slot, and
// the rally book counts those.
function liveMarches(game, castle, armies) {
  armies = armies || (game && game.player && game.player.selfArmys) || [];
  const fieldId = castle.fieldId;
  return armies
    .map((a) => a.raw || a)            // the engine's list wraps the ArmyBean
    .filter((a) => fieldId === undefined || Number(a.startFieldId) === Number(fieldId))
    .map((a) => ({
      target: Number(a.targetFieldId),
      missionType: Number(a.missionType),
      heroId: a.hero && a.hero.id,
      startedAt: n(a.startTime) || Date.now(),
      reachTime: n(a.reachTime),
    }));
}

// ------------------------------------------------------- targets for a level

function targetsFor(ctx, cache, home, level) {
  const list = goalsNamed(ctx, 'npclist').filter((g) => g.level === level || g.level == null);
  const bounds = goalsNamed(ctx, 'npcbounds').filter((g) => g.level === level || g.level == null).map((g) => g.box).filter(Boolean);
  const excl = goalsNamed(ctx, 'excludelist');
  const exclCoords = new Set(excl.flatMap((g) => (g.coords || []).map((c) => C.coordsToFieldId(c.x, c.y))));
  const exclNames = new Set(excl.flatMap((g) => g.names || []));
  const radius = radiusFor(ctx, level);

  let pool = cache.npcs.filter((t) => t.level === level);

  // npclist, when present for this level, is the whole world
  if (list.length) {
    const only = new Set(list.flatMap((g) => (g.coords || []).map((c) => C.coordsToFieldId(c.x, c.y))));
    pool = pool.filter((t) => only.has(t.id));
  }
  if (bounds.length) pool = pool.filter((t) => bounds.some((b) => t.x >= b.xMin && t.x <= b.xMax && t.y >= b.yMin && t.y <= b.yMax));
  if (exclCoords.size) pool = pool.filter((t) => !exclCoords.has(t.id));
  if (exclNames.size) pool = pool.filter((t) => !exclNames.has(String(t.name || '').toLowerCase()));

  return pool
    .map((t) => ({ ...t, dist: Math.hypot(t.x - home.x, t.y - home.y) }))
    .filter((t) => t.dist > 0 && t.dist <= radius)
    .sort((a, b) => a.dist - b.dist || a.id - b.id);
}

// ---------------------------------------------------------- the troop load

// What one run against this level should take with it.
//   hero attack >= 50 : npctroops / config ballsused / safe default, in that order
//   hero attack <  50 : the safe default is forced for ballistas (wiki), while the
//                       rest of an npctroops line still stands
// Transports are sized from the loot estimate unless npctroops names a number.
function troopLoadFor(ctx, level, hero, target, opts = {}) {
  const cfg = ctx.config || {};
  const custom = forLevel(goalsNamed(ctx, 'npctroops'), level);
  const fp = forLevel(goalsNamed(ctx, 'farmingpolicy'), level);
  const safeSwitch = fp && fp.switches ? n(fp.switches.safeballs) : 0;
  const safeBalls = safeSwitch > 0 ? safeSwitch : SAFE_BALLISTAS[level];
  const weakHero = hero ? heroAttack(hero) < HERO_ATTACK_FLOOR : false;

  const troops = {};
  let why = [];

  if (custom && Object.keys(custom.troops).length) {
    Object.assign(troops, custom.troops);
    why.push(`npctroops ${level}`);
  } else if (level <= 5) {
    troops.ballista = safeBalls;
    why.push(safeSwitch > 0 ? `/safeballs:${safeBalls}` : `safe default ${safeBalls} ballista`);
  } else {
    // wiki NpcTroops lists no default for 6-10: archers + layers are the player's call
    return { ok: false, reason: `level ${level} has no default troop load — add "npctroops ${level} ..."`, troops: null };
  }

  if (level <= 5) {
    if (weakHero) {
      if (troops.ballista !== safeBalls) why.push(`hero attack ${heroAttack(hero)} < ${HERO_ATTACK_FLOOR}, forced to ${safeBalls}`);
      troops.ballista = safeBalls;
    } else if (!(custom && custom.troops.ballista) && n(cfg.ballsused) > 0) {
      troops.ballista = n(cfg.ballsused);
      why = [`config ballsused:${n(cfg.ballsused)}`];
    }
  }

  // ---- transports: enough hold for the loot after the march food comes out
  const loadSkill = n(opts.loadSkill ?? 100);
  const marchSkill = n(opts.marchSkill ?? 100);
  const explicitTransports = custom && custom.troops.carriage !== undefined;
  const loot = n(opts.loot ?? NPC_LOOT[level]);

  const carriage = C.BY_KEY.carriage;
  const probe = { ...troops, carriage: n(troops.carriage) || 1 };
  const oneWayMs = target ? oneWayMsTo(opts.home || { x: 0, y: 0 }, target, probe, marchSkill) : 0;
  const hours = oneWayMs / 3600000;

  if (!explicitTransports && loot > 0) {
    const base = { ...troops }; delete base.carriage;
    const space = capacityOf(base, loadSkill) - marchFoodOf(base, oneWayMs);
    const perTransport = carriage.load * (1 + loadSkill / 100) - carriage.food * 2 * hours;
    if (perTransport <= 0) return { ok: false, reason: 'march is so long a transport eats more than it carries', troops: null };
    const need = Math.max(0, loot - space);
    troops.carriage = Math.max(1, Math.ceil(need / perTransport));
    why.push(`${troops.carriage} transport for ~${fmt(loot)} loot`);
  }

  for (const k of Object.keys(troops)) if (!n(troops[k])) delete troops[k];

  const capacity = capacityOf(troops, loadSkill);
  const food = marchFoodOf(troops, oneWayMs);
  return {
    ok: true, troops, why: why.join(', '), weakHero,
    oneWayMs, roundTripMs: oneWayMs * 2, capacity, marchFood: food, space: capacity - food, loot,
  };
}

// ----------------------------------------------------------------- the plan

function npcPlan(ctx, state, game) {
  // tolerate the older (ctx, game, state) ordering used by goalmods.js
  if (state && state.castles && Array.isArray(state.castles)) { const t = state; state = game; game = t; }
  game = game || (ctx && ctx.game) || null;
  state = state || {};
  ctx = ctx || {};

  const cfg = ctx.config || {};
  const lowest = n(cfg.npc);
  if (!lowest) return null;                      // goal not switched on

  // wiki WarTown: "No npc farming runs" from a war town (the console's War
  // Town Mode counts the same), and none inside wartownpolicy's hours.
  const war = W.lockdown(ctx);
  if (war.on) return { note: `npc:${lowest} — held: ${war.why}`, actions: [] };

  const castle = ctx.castle || {};
  const now = n(ctx.now) || Date.now();

  const st = (state.npc = state.npc || {});
  st.cycles = st.cycles || {};
  st.hits = st.hits || {};
  st.runs = (Array.isArray(st.runs) ? st.runs : []).filter((r) => n(r.doneAt) > now);
  // the hit log only matters for one cycle; a week is generous and keeps
  // enginestate.json from growing a key per camp ever farmed
  for (const [k, v] of Object.entries(st.hits)) if (now - n(v) > 7 * 86400000) delete st.hits[k];

  const cache = loadNpcCache(ctx.mapCache || ctx.mapCachePath);
  if (!cache.ok) return { note: `npc:${lowest} — ${cache.reason}`, actions: [] };
  if (!cache.npcs.length) {
    const hint = cache.unleveled ? `${cache.unleveled} npc tile(s) cached without a level — rescan so the terrain byte is captured` : 'the map cache holds no npc camps';
    return { note: `npc:${lowest} — ${hint}`, actions: [] };
  }

  const home = (game && game.castleXY && game.castleXY(castle)) ||
    (castle.fieldId !== undefined ? C.fieldIdToCoords(Number(castle.fieldId)) : null);
  if (!home) return { note: `npc:${lowest} — this city has no map position`, actions: [] };

  // ---- npclimit: stop once the pantry is full, unless we are farming for XP
  const limitDays = n(cfg.npclimit);
  const training = n(cfg.training) >= 1 || n(cfg.training10) >= 1;
  const days = foodDays(castle);
  if (limitDays > 0 && days >= limitDays && !training) {
    return { note: `npc:${lowest} — holding ${days === Infinity ? 'unlimited' : days.toFixed(1)} days of food (npclimit ${limitDays}), farming paused`, actions: [] };
  }

  // ---- how many runs may be in the air
  // npcteams counts farming teams (wiki NpcTeams): the attacks. Transports and
  // reinforcements are not teams, but they hold rally slots, and the rally book
  // counts every march against the rally spot and rallypolicy.
  const cap = teamCapFor(ctx);
  const live = liveMarches(game, castle, ctx.selfArmies);
  for (const m of live) if (m.missionType === C.MISSION.attack && m.target) st.hits[m.target] = Math.max(n(st.hits[m.target]), m.startedAt);
  const inFlight = Math.max(st.runs.length, live.filter((m) => m.missionType === C.MISSION.attack).length);
  const busyTargets = new Set([...live.map((m) => m.target), ...st.runs.map((r) => r.fieldId)]);
  const busyHeroes = new Set([...live.map((m) => m.heroId), ...st.runs.map((r) => r.heroId)].filter((x) => x != null));
  const book = ctx.rally || R.rallyBook({ game, armies: ctx.selfArmies, goalsOf: (c) => (c === castle ? ctx.goals : null) });
  let levels = null;
  const levelOf = (fieldId) => {
    if (!levels) levels = new Map(cache.npcs.map((t) => [t.id, t.level]));
    return levels.has(fieldId) ? levels.get(fieldId) : null;
  };
  const rally = book.room(castle, 'n');
  let slots = Math.min(cap.teams - inFlight, rally.room);
  if (slots <= 0) {
    const why = cap.teams - inFlight <= 0 ? `${inFlight}/${cap.teams} teams already out (${cap.why})` : `no rally slot — ${rally.why}`;
    return { note: `npc:${lowest} — ${why}`, actions: [] };
  }

  // ---- troops and heroes still at home, less what left moments ago
  const sent = book.committed(castle).troops;
  const avail = {};
  for (const [k, v] of Object.entries(castle.troop || {})) avail[k] = Math.max(0, n(v) - n(sent[k]));
  const plannedAt = {};
  // HeroConstants.as: 0 free, 1 chief/mayor, 2 guard, 3 marching, 4 captured,
  // 5 returning, 8 farming. Only a free hero may be given a new march.
  const idleHeroes = (castle.heros || []).filter((h) => (h.status === 0 || h.status === undefined) && !busyHeroes.has(h.id));
  // Heroes that stay home (wiki KeepAttHome, HomeHeroes): keepatthome's
  // defender is never sent, and homeheroes N leaves N of the heroes a level's
  // npcheroes allows at home — N of the whole hall with the default "any".
  // The mayor is not a free hero, so it never counts toward N.
  const kept = W.keepAttHome({ ...ctx, castle });
  const keepHome = H.farmableHeroes({ ...ctx, castle }).keepHome;

  const actions = [];
  const notes = [];
  const opts = {
    home,
    loadSkill: n(game && game.loadSkillParam) || 100,
    marchSkill: n(game && game.marchSkillParam) || 100,
  };
  let scanned = 0, outOfHeroes = false;

  // Highest level first, falling back down to `config npc:<lowest>` as supplies run
  // out — this is the "work its way down" behaviour from the wiki.
  for (let level = MAX_NPC_LEVEL; level >= lowest && slots > 0; level--) {
    const all = targetsFor(ctx, cache, home, level);
    if (!all.length) continue;
    scanned += all.length;

    // level 6-10 need an npclimits line at all, and enough troops to satisfy it
    const limits = goalsNamed(ctx, 'npclimits').find((g) => g.level === level);
    if (level >= 6 && !limits) { notes.push(`L${level}: ${all.length} target(s) skipped — needs "npclimits ${level} ..."`); continue; }

    const cycleMs = cycleMsFor(ctx, level);
    const cyc = (st.cycles[level] = st.cycles[level] || { startedAt: 0 });
    if (cyc.startedAt && now - cyc.startedAt >= cycleMs) cyc.startedAt = 0;   // a new pass is due
    const passStart = cyc.startedAt || now;

    const fresh = all.filter((t) => !busyTargets.has(t.id) && n(st.hits[t.id]) < passStart);
    if (!fresh.length) {
      const waitMs = Math.max(0, (cyc.startedAt || now) + cycleMs - now);
      notes.push(`L${level}: pass complete (${all.length} camp(s)), next in ${hms(waitMs)}`);
      continue;
    }

    let stop = null, tooFar = 0;
    for (const target of fresh) {
      if (slots <= 0) break;

      const spec = heroSpecFor(ctx, level);
      const free = idleHeroes.filter((h) => !busyHeroes.has(h.id));
      if (!free.length) { stop = 'no idle hero left'; outOfHeroes = true; break; }
      const allowed = heroCandidates(free, spec, castle.heros);
      if (keepHome && allowed.length && allowed.length <= keepHome) {
        stop = `homeheroes ${keepHome}: ${allowed.map((h) => h.name).join(', ')} stay${allowed.length === 1 ? 's' : ''} home`;
        break;
      }
      const hero = allowed.find((h) => !kept.reservedIds.has(h.id));
      if (!hero) {
        stop = allowed.length ? `${allowed[0].name} is the only idle hero for "${spec}" and keepatthome keeps it home` : `no idle hero matches "${spec}"`;
        break;
      }

      const load = troopLoadFor(ctx, level, hero, target, { ...opts, home });
      if (!load.ok) { stop = load.reason; break; }

      // a run that cannot get back inside one cycle can never sustain a pass
      if (load.roundTripMs > cycleMs) { tooFar++; continue; }

      const short = Object.entries(load.troops).find(([k, v]) => n(avail[k]) < v);
      if (short) { stop = `short ${C.BY_KEY[short[0]] ? C.BY_KEY[short[0]].name : short[0]} (need ${fmt(short[1])}, have ${fmt(avail[short[0]])})`; break; }

      // npclimits: the garrison that must stay behind
      if (limits) {
        const after = { ...avail };
        for (const [k, v] of Object.entries(load.troops)) after[k] = n(after[k]) - v;
        const broken = Object.entries(limits.troops).find(([k, v]) => n(after[k]) < n(v));
        if (broken) { stop = `npclimits ${level}: would leave ${fmt(n(avail[broken[0]]) - n(load.troops[broken[0]]))} ${C.BY_KEY[broken[0]] ? C.BY_KEY[broken[0]].name : broken[0]}, needs ${fmt(broken[1])}`; break; }
      }

      // rallypolicy n:<level>:<slots>
      const lr = book.room(castle, 'n', { level, levelOf, planned: { total: actions.length, kind: actions.length, level: n(plannedAt[level]) } });
      if (lr.room <= 0) { stop = lr.why; break; }

      for (const [k, v] of Object.entries(load.troops)) avail[k] -= v;
      busyHeroes.add(hero.id);
      busyTargets.add(target.id);
      if (!cyc.startedAt) cyc.startedAt = now;
      slots--;
      plannedAt[level] = n(plannedAt[level]) + 1;

      actions.push({
        kind: 'npcAttack',
        level, fieldId: target.id, target: { x: target.x, y: target.y },
        hero, heroId: hero.id, heroAttack: heroAttack(hero),
        troops: load.troops,
        oneWayMs: load.oneWayMs, roundTripMs: load.roundTripMs, cycleMs,
        why: load.why, distance: Math.round(target.dist * 10) / 10,
        label: `npc L${level} at ${target.x},${target.y} (${Math.round(target.dist * 10) / 10} tiles, ${hms(load.oneWayMs)} out) ` +
               `with ${hero.name} atk ${heroAttack(hero)} — ${troopText(load.troops)}`,
      });
      // hand the executor the state object, and the engine the rally slot it
      // takes, without either showing up in reports
      const a = actions[actions.length - 1];
      Object.defineProperty(a, 'state', { value: state, enumerable: false });
      Object.defineProperty(a, 'rally', {
        value: { from: castle, kind: 'n', level, levelOf, missionType: C.MISSION.attack, targetFieldId: target.id, troops: load.troops },
        enumerable: false,
      });
    }
    if (tooFar) notes.push(`L${level}: ${tooFar} camp(s) skipped — round trip longer than the ${hms(cycleMs)} cycle`);
    if (stop) notes.push(`L${level}: stopped — ${stop}`);
    if (outOfHeroes) break;      // nothing lower down can march either
  }

  const head = actions.length
    ? `npc:${lowest} — ${actions.length} run(s) ready, nearest ${actions[0].target.x},${actions[0].target.y} L${actions[0].level}`
    : `npc:${lowest} — nothing to send`;
  const tail = [`${inFlight}/${cap.teams} teams out (${cap.why})`];
  if (rally.why) tail.push(rally.why);
  if (scanned) tail.push(`${scanned} camp(s) in range`);
  if (cache.unleveled) tail.push(`${cache.unleveled} npc tile(s) have no level cached`);
  if (cache.updatedAt && now - cache.updatedAt > 12 * 3600000) tail.push(`map cache is ${hms(now - cache.updatedAt)} old`);
  if (limitDays > 0) tail.push(`food ${days === Infinity ? 'inf' : days.toFixed(1)}d / limit ${limitDays}d${training ? ', training on' : ''}`);

  return { note: [head, ...tail, ...notes].join(' | '), actions };
}

const troopText = (troops) => Object.entries(troops)
  .map(([k, v]) => `${fmt(v)} ${C.BY_KEY[k] ? C.BY_KEY[k].name : k}`).join(' + ');

function hms(ms) {
  const s = Math.max(0, Math.round(n(ms) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

// ------------------------------------------------------------- the executor

// Records a successful send so the cycle clock, the per-camp cooldown and the
// in-flight count all stay true. Called by the executor; safe to call twice.
function recordSend(state, action, result) {
  if (!state || !action || !result || result.ok !== 1) return;
  const st = (state.npc = state.npc || {});
  st.hits = st.hits || {};
  st.runs = Array.isArray(st.runs) ? st.runs : [];
  st.cycles = st.cycles || {};
  const now = Date.now();
  st.hits[action.fieldId] = now;
  st.runs.push({
    fieldId: action.fieldId, level: action.level, heroId: action.heroId,
    sentAt: now, doneAt: now + n(action.roundTripMs) + 60000, troops: action.troops,
  });
  const cyc = (st.cycles[action.level] = st.cycles[action.level] || { startedAt: 0 });
  if (!cyc.startedAt) cyc.startedAt = now;
  st.npcHits = n(st.npcHits) + 1;
  state.npcHits = n(state.npcHits) + 1;    // engine.js/traininghero count hits here
}

const executors = {
  // army.newArmy with missionType 5 (attack) — ArmyCommands.as / constants.MISSION
  async npcAttack(game, castle, action, state) {
    const bean = game.buildArmyBean({
      missionType: C.MISSION.attack,
      heroId: action.heroId,
      targetPoint: action.fieldId !== undefined ? action.fieldId : C.coordsToFieldId(action.target.x, action.target.y),
      troops: action.troops,
    });
    const res = await game.newArmy(game.castleId(castle), bean);
    recordSend(state || action.state, action, res);
    return res;
  },
};

module.exports = {
  parsers,
  plans: { npc: npcPlan },
  executors,
  configKeys,
  // exported for the tests and for tuning
  _internals: {
    SAFE_BALLISTAS, NPC_LOOT, DEFAULT_CYCLE_H, DEFAULT_TEAMS, DEFAULT_RADIUS, HERO_ATTACK_FLOOR,
    loadNpcCache, digestCache, troopLoadFor, targetsFor, cycleMsFor, teamCapFor,
    heroCandidates, heroSpecFor, heroAttack, foodDays, capacityOf, marchFoodOf, recordSend, troopText,
  },
};
