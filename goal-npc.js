'use strict';
// NPC farming — the economic engine.
//
// What the NEAT wiki says this has to do (pages Npc, NpcList, NpcBounds,
// FarmingPolicy, DistancePolicy, FarmingCycle, FarmingCycleMin, SmartFarming,
// NpcLimit, NpcLimits, NpcTroops, NpcHeroes, NpcTeams, ExcludeList, Training,
// Training10, TrainInt, TrainPol, CategoryNpcGoals and the FAQ), and what is
// reproduced here:
//
//   * `config npc:<n>` turns it on. n is the LOWEST level you want farmed: the bot
//     starts with the highest level it can actually supply and works DOWN to n as
//     transports / ballistas / troops / heroes run short (10 = level 10 only).
//   * Which camps (CategoryNpcGoals, the first rule that is set wins): an npclist
//     for the level, else npcbounds, else farmingpolicy /mindistance-/maxdistance,
//     else distancepolicy's first number, else 10 miles. excludelist always
//     applies. Distances go the short way round: the map wraps at its edges.
//   * How often (CategoryNpcGoals): training:1/2 (levels 1-9) or training10:1
//     (level 10) every hour; else the level's farmingpolicy /farmingcycle, /cycle
//     or /maxcycle (and /mincycle); else config farmingcycle (and farmingcyclemin);
//     else 8.4 hours. A camp waits that long after it was hit. With a minimum
//     cycle (farmingcyclemin, /mincycle, or smartfarming 2/3) the next camp is the
//     one worth most per trip instead: what it has refilled over how far it is.
//   * Levels 1-5 march as ballistas + transports, and only with the research the
//     FAQ names: Military Tradition at the camp's level + 2, and Archery 8 with
//     Horseback Riding 5 or 6, Archery 9 with 8 or 9, or Archery 10.
//     Levels 6-10 need an npclimits line (troops that must be at home before a
//     run leaves) and an npctroops line (the wiki gives no default load for them).
//   * Safe ballista counts: L5 550, L4 350, L3 170, L2 50, L1 20. A hero whose
//     ATTACK is under 50 forces them, but `/safeballs` says what "safe" means.
//   * How many runs may be in the air at once comes from `npcteams` (default 10),
//     which counts farming teams — attacks — and not transports or
//     reinforcements (wiki NpcTeams). The rally spot's slots and `rallypolicy`
//     n: / n:<level>: / max: limit it further (rally.js).
//   * `config npclimit:<days>` stops farming once the city holds that many days of
//     food; training keeps levels 1-9 going hourly, training10 level 10.
//   * The farming history is forgotten after maintenance (the console tells the
//     engine when it came back from one).
//   * Heroes: npcheroes per level (a line with no level covers levels 1-5), intel
//     heroes only under config trainint:1, the city's best politics hero only
//     under config trainpol:1 (the mayor plan stands another hero in meanwhile).
//
// Everything in `plans` is PURE: it reads the map cache, the castle bean and the
// per-city state object and returns action descriptors. Only `executors.npcAttack`
// ever talks to the server. `scanPlan` decides which map blocks the console's
// background scan reads (session.js backgroundScan).
//
// Marked INFERRED below: anything not pinned to a wiki page or the decompiled
// client. Marked OUR CHOICE: where the wiki is silent and the conservative
// reading was taken. Those are the parts worth checking against a live run.
const fs = require('fs');
const path = require('path');
const C = require('./constants');
const R = require('./rally');
const H = require('./goal-heroes');
const W = require('./goal-war');
// processingpolicy (processing.js): npc farming is its task n, and the engine
// ranks these runs against the city's other missions by it
const P = require('./processing');
P.register('n', { kinds: ['npcAttack'] });

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

// Hours and miles are plain numbers that keep their fractions (wiki FarmingCycle:
// "farmingcycle:0.5 would be able to hit the npcs again after 30 minutes";
// DistancePolicy: "10.5 miles"). No k/m suffix: "30m" is not 30 minutes here.
// null when it cannot be read, never NaN.
const DEC = (s) => {
  const t = String(s == null ? '' : s).trim();
  return /^(\d+(\.\d+)?|\.\d+)$/.test(t) ? parseFloat(t) : null;
};
// A config value that has to be a positive number, or null.
const posNum = (v) => { const x = typeof v === 'number' ? v : DEC(v); return x !== null && Number.isFinite(x) && x > 0 ? x : null; };

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

// wiki FarmingCycle ("Default: config farmingcycle:8.4"), FarmingCycleMin, NpcLimit,
// SmartFarming and CategoryNpcGoals all say 8.4 hours; the Npc page's "8-hour
// cycles" is the older text.
const DEFAULT_CYCLE_H = 8.4;
const TRAINING_CYCLE_H = 1;       // wiki: "config training:1 ... farm every hour"
// wiki SmartFarming: "it will only hit a npc after it has been fully regenerated
// of resources, this takes 8.4 hours". What a camp holds is read off this.
const REGEN_H = 8.4;
// OUR CHOICE. smartfarming 2/3 with no minimum cycle anywhere: the wiki names
// none. An hour, the time a camp's troops take to refill (wiki SmartFarming), so
// no camp is hit again before its garrison is back.
const SMART_MIN_H = 1;
const DEFAULT_TEAMS = 10;         // wiki: NpcTeams default
// wiki DistancePolicy "Default: distancepolicy 10 10 10 10 10"; CategoryNpcGoals
// "If nothing is set to determine distance, then farm for a 10 mile radius".
const DEFAULT_RADIUS = 10;
const MAX_DISTANCE = 150;         // wiki DistancePolicy: "the maximum limit in miles is 150"
const HERO_ATTACK_FLOOR = 50;     // wiki: attack < 50 forces the safe ballista count
const MAX_NPC_LEVEL = 10;

// Troop codes and names: the one table every goal parser shares
// (constants.js TROOP_WORDS).
const troopDef = (code) => C.troopByWord(code);

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

// "111,222" -> {x:111, y:222}
function parseCoord(tok, errs) {
  const m = String(tok).match(/^\(?\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)?$/);
  if (!m) { errs.push(`"${tok}" is not a coordinate (expected x,y)`); return null; }
  return { x: Number(m[1]), y: Number(m[2]) };
}

// farmingpolicy switches (wiki FarmingPolicy; CategoryNpcGoals spells two of
// them /cyclemin and /cyclemax) -> what each one sets.
const FP_SWITCHES = {
  level: 'level',
  mindistance: 'minDistance', maxdistance: 'maxDistance',
  distance: 'maxDistance',                     // OTTObot's older spelling of /maxdistance
  farmingcycle: 'maxCycle', cycle: 'maxCycle', maxcycle: 'maxCycle', cyclemax: 'maxCycle',
  mincycle: 'minCycle', cyclemin: 'minCycle',
  safeballs: 'safeBalls',
  teams: 'teams',                              // OTTObot: can only lower npcteams
};
const FP_EXAMPLE = { level: '5', minDistance: '1', maxDistance: '7', maxCycle: '8.4', minCycle: '1', safeBalls: '600', teams: '3' };

// distancepolicy's five numbers, in the wiki's order (DistancePolicy): npc farming,
// npc building, medal or valley farming, valley acquisition, map scanning.
const DP_SLOTS = ['npc', 'build', 'valley', 'acquire', 'scan'];
// OTTObot's older spellings: "distancepolicy npc 9", "distancepolicy /npc:15".
const DP_KIND = {
  npc: 'npc', farm: 'npc', farming: 'npc',
  build: 'build', building: 'build', npcbuild: 'build',
  valley: 'valley', medal: 'valley', valleyfarming: 'valley',
  acquire: 'acquire', acquisition: 'acquire',
  scan: 'scan', map: 'scan', mapscan: 'scan',
  all: 'all',
};

// A distance in miles (tiles), checked: 150 at most (wiki DistancePolicy).
function milesOf(v, what, errs, { zero = false } = {}) {
  const d = DEC(v);
  if (d === null) { errs.push(`${what}: "${v}" is not a number of miles`); return null; }
  if (d === 0 && !zero) { errs.push(`${what}: a distance of 0 reaches nothing`); return null; }
  if (d > MAX_DISTANCE) { errs.push(`${what}: ${d} miles is past the ${MAX_DISTANCE}-mile limit, ${MAX_DISTANCE} is used`); return MAX_DISTANCE; }
  return d;
}

// ------------------------------------------------------------------ parsers

const parsers = {
  // npcheroes [level] <hero-string>       wiki: NpcHeroes (default: any)
  //   npcheroes !OTTO,any        every hero but OTTO, levels 1-5
  //   npcheroes 10 any           and any hero may hit npc10s
  // A line with no level is NEAT's older style and covers levels 1-5 only.
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

  // npc10heroes <hero-string>             wiki NpcHeroes: the older spelling of
  // "npcheroes 10 <hero-string>", read the same way.
  npc10heroes: {
    kind: 'directive', multi: true,
    parse(args) { return parsers.npcheroes.parse(['10', ...args]); },
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

  // npclimits [level] <troops>            wiki: NpcLimits — required for levels 6-10.
  // "the minimum number of troops it must have in the city before it will farm
  // another level 6-10 npc": counted at home BEFORE a run leaves (FAQ: "IN the
  // city (not total, but actually there and idle)"). The wiki writes the level as
  // optional: a line with none covers every level 6-10 that has none of its own.
  npclimits: {
    kind: 'directive', multi: true,
    parse(args) {
      const errs = [];
      const { level, rest } = takeLevel(args.slice());
      const troops = parseTroopSpec(rest.join(''), errs);
      if (!Object.keys(troops).length) errs.push('needs the troops that must be in the city (e.g. npclimits 10 a:390k,s:50k)');
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

  // npcbounds [level] Xmin Xmax Ymin Ymax wiki: NpcBounds
  // Five numbers carry a level first, four do not — never guessed from the size
  // of the first number. Reversed ends are swapped. A box may run over the map's
  // edge: an Xmax past 799 carries on from 0 (npcbounds 5 790 810 0 10 is x
  // 790-799 and 0-10), the same wrap the map itself has.
  npcbounds: {
    kind: 'directive', multi: true,
    parse(args) {
      const errs = [];
      const toks = args.flatMap((t) => String(t).split(/\s+/)).filter(Boolean);
      const usage = 'expected: npcbounds [level] <Xmin> <Xmax> <Ymin> <Ymax>';
      let level = null, nums = toks;
      if (toks.length === 5) {
        if (!/^([1-9]|10)$/.test(toks[0])) { errs.push(`"${toks[0]}" is not an npc level 1-10; ${usage}`); return { level, box: null, errors: errs }; }
        level = Number(toks[0]); nums = toks.slice(1);
      } else if (toks.length !== 4) { errs.push(usage); return { level, box: null, errors: errs }; }
      const v = nums.map((t) => (/^\d+$/.test(t) ? Number(t) : null));
      if (v.some((x) => x === null)) { errs.push(`${usage} (whole numbers)`); return { level, box: null, errors: errs }; }
      const [x1, x2, y1, y2] = v;
      const box = { xMin: Math.min(x1, x2), xMax: Math.max(x1, x2), yMin: Math.min(y1, y2), yMax: Math.max(y1, y2) };
      if (box.xMin >= C.MAP_W || box.yMin >= C.MAP_W) { errs.push(`the box starts off the map (coordinates run 0-${C.MAP_W - 1})`); return { level, box: null, errors: errs }; }
      return { level, box, errors: errs };
    },
  },

  // farmingpolicy [level] /switch:value   wiki: FarmingPolicy
  //   /level:#                  the level, as a switch (or written first)
  //   /mindistance /maxdistance miles from the city (/distance is our older /maxdistance)
  //   /farmingcycle /cycle /maxcycle (/cyclemax)   hours between hits on a camp
  //   /mincycle (/cyclemin)     smart selection, as config farmingcyclemin (levels 1-5)
  //   /safeballs                the safe ballista count for a hero under 50 attack
  //   /teams                    ours: lowers npcteams (a line with no level only)
  // Hours and miles keep their fractions (/farmingcycle:8.4). A line with no
  // level covers every level; one written for a level wins for that level.
  farmingpolicy: {
    kind: 'policy', multi: true,
    parse(args) {
      const errs = [];
      const { level: written, rest } = takeLevel(args.slice());
      const switches = {}, policy = {};
      for (const tok of rest) {
        const s = String(tok);
        if (!s.startsWith('/')) { errs.push(`expected /switch:value, got "${s}"`); continue; }
        const [k, v] = kv(s.slice(1));
        const key = k.toLowerCase();
        const what = FP_SWITCHES[key];
        if (!what) { errs.push(`/${k} is not supported by this build (known: ${Object.keys(FP_SWITCHES).map((x) => '/' + x).join(' ')})`); continue; }
        if (v === null || v === '') { errs.push(`/${key} needs a value, e.g. /${key}:${FP_EXAMPLE[what]}`); continue; }
        let val = null;
        if (what === 'level') {
          if (!/^([1-9]|10)$/.test(v)) { errs.push(`/level:${v} — an npc level is 1 to 10`); continue; }
          val = Number(v);
        } else if (what === 'minDistance' || what === 'maxDistance') {
          val = milesOf(v, `/${key}`, errs, { zero: what === 'minDistance' });
          if (val === null) continue;
        } else if (what === 'maxCycle' || what === 'minCycle') {
          val = DEC(v);
          if (val === null || val <= 0) { errs.push(`/${key}:${v} — needs a number of hours above 0, e.g. /${key}:${FP_EXAMPLE[what]}`); continue; }
        } else {
          val = NUM(v);
          if (val === null || val < 1) { errs.push(`/${key}:${v} — needs a whole number of 1 or more`); continue; }
        }
        policy[what] = val;
        switches[key] = val;
      }
      let level = written;
      if (policy.level != null) {
        if (written != null && written !== policy.level) errs.push(`level ${written} and /level:${policy.level} disagree — ${written} is used`);
        else level = policy.level;
      }
      delete policy.level;
      if (policy.minCycle != null && level != null && level > 5) {
        errs.push(`/mincycle only affects levels 1-5 (wiki FarmingCycleMin), so it does nothing for level ${level}`);
        delete policy.minCycle;
      }
      if (policy.minDistance != null && policy.maxDistance != null && policy.minDistance > policy.maxDistance) {
        errs.push(`/mindistance ${policy.minDistance} is past /maxdistance ${policy.maxDistance} — read the other way round`);
        [policy.minDistance, policy.maxDistance] = [policy.maxDistance, policy.minDistance];
      }
      if (!rest.length) errs.push('needs at least one /switch:value (e.g. farmingpolicy 5 /maxdistance:7 /cycle:8.4)');
      return { level, switches, policy, errors: errs };
    },
  },

  // distancepolicy <npc> [<build> [<valley> [<acquire> [<scan>]]]]   wiki: DistancePolicy
  //   distancepolicy 10 20 5 10 25   npc farming 10, npc building 20, medal/valley
  //                                  farming 5, valley acquisition 10, map scanning 25
  // Miles, fractions allowed, 150 at most. The older spellings still read:
  // "distancepolicy npc 9" and "distancepolicy /npc:15 /valley:5".
  distancepolicy: {
    kind: 'policy', multi: false,
    parse(args) {
      const errs = [];
      const switches = {}, nums = [];
      let pending = null;                         // "npc" waiting for its number
      for (const raw of args) {
        const tok = String(raw);
        if (tok.startsWith('/')) {
          const [k, v] = kv(tok.slice(1));
          const d = milesOf(v, `/${k}`, errs);
          if (d !== null) switches[k.toLowerCase()] = d;
          continue;
        }
        if (DEC(tok) !== null) {
          const d = milesOf(tok, pending ? pending : `distance ${nums.length + 1}`, errs);
          if (pending) { if (d !== null) switches[pending] = d; pending = null; } else nums.push(d);
          continue;
        }
        if (pending) errs.push(`"${pending}" needs a distance after it`);
        pending = tok.toLowerCase();
      }
      if (pending) errs.push(`"${pending}" needs a distance after it`);
      if (nums.length > DP_SLOTS.length) errs.push(`at most ${DP_SLOTS.length} distances (npc farming, npc building, medal/valley farming, valley acquisition, map scanning); the rest are left out`);
      const distances = {};
      nums.slice(0, DP_SLOTS.length).forEach((d, i) => { if (d !== null) distances[DP_SLOTS[i]] = d; });
      for (const [k, d] of Object.entries(switches)) {
        const slot = DP_KIND[k];
        if (!slot) { errs.push(`"${k}" is not a distance kind (known: ${Object.keys(DP_KIND).join(', ')})`); continue; }
        if (slot === 'all') { for (const s of DP_SLOTS) if (distances[s] === undefined) distances[s] = d; continue; }
        if (distances[slot] === undefined) distances[slot] = d;
      }
      if (!nums.length && !Object.keys(switches).length) errs.push('no distance given');
      return { radius: distances.npc ?? null, distances, switches, errors: errs };
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

// Config keys this module reads. goals.js merges them into its CONFIG_KEYS.
//   smartfarming  NEAT's Global Settings > General > Smart Farming (0-3), as a
//                 config key: put it in the Prepend goals for the whole account
//   mapscan       ours: the background map scan around this city (0 off, 1 on)
const configKeys = ['npc', 'npclimit', 'ballsused', 'training', 'training10', 'farmingcycle', 'farmingcyclemin',
  'smartfarming', 'mapscan', 'trainint', 'trainpol'];

// The config values this module reads, checked. goals.js keeps a value it cannot
// read as text, so `config farmingcycle:soon` would otherwise quietly mean the
// default: a farming key that is wrong holds farming, with a note that says so.
const CONFIG_RULES = {
  npc: { set: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], what: 'the lowest npc level to farm, 1 to 10 (0 is off)' },
  npclimit: { atLeast: 0, what: 'a number of days of food' },
  ballsused: { atLeast: 0, whole: true, what: 'a number of ballistas' },
  training: { set: [0, 1, 2], what: '0, 1 or 2' },
  training10: { set: [0, 1], what: '0 or 1' },
  farmingcycle: { above: 0, what: 'a number of hours, e.g. 8.4' },
  farmingcyclemin: { above: 0, what: 'a number of hours, e.g. 1' },
  smartfarming: { set: [0, 1, 2, 3], what: '0, 1, 2 or 3' },
  trainint: { set: [0, 1], what: '0 or 1' },
  trainpol: { set: [0, 1], what: '0 or 1' },
  mapscan: { set: [0, 1], what: '0 or 1' },
};
const FARMING_KEYS = Object.keys(CONFIG_RULES).filter((k) => k !== 'mapscan');

function configProblems(cfg, keys = Object.keys(CONFIG_RULES)) {
  const out = [];
  for (const k of keys) {
    const v = (cfg || {})[k];
    if (v === undefined || v === null || v === '') continue;
    const r = CONFIG_RULES[k];
    const x = typeof v === 'number' ? v : DEC(v);
    const ok = x !== null && Number.isFinite(x) && (r.set ? r.set.includes(x)
      : (r.above === undefined || x > r.above) && (r.atLeast === undefined || x >= r.atLeast) && (!r.whole || Number.isInteger(x)));
    if (!ok) out.push(`config ${k}:${v} is not ${r.what}`);
  }
  return out;
}

// The same checks when the goals are read: goals.js runs a config key's value
// through the config-kind parser of the module that reads it (Step 9), so
// `config farmingcycle:soon` or `smartfarming:5` is red in the editor, and a
// bare `farmingcycle 8.4` line reads as the config line it means. `value` is what
// goals.js made of it: a number when it could read one, the text otherwise.
for (const k of Object.keys(CONFIG_RULES)) {
  parsers[k] = {
    kind: 'config', multi: false,
    parse(value) {
      if (value === undefined || value === null || value === '') return { value: null, errors: [`${k} needs a value, ${CONFIG_RULES[k].what}`] };
      return { value, errors: configProblems({ [k]: value }, [k]).map((e) => e.replace(/^config /, '')) };
    },
  };
}

// ------------------------------------------------------------- the map cache

let _cache = { version: -1, value: null };

// Reads the map cache (never writes it). `src` may be an already parsed cache
// object — the tests hand fixtures in that way — or a path to a legacy
// mapcache.json. With neither, it reads the NPC rows of the SQLite store.
function loadNpcCache(src) {
  if (src && typeof src === 'object') return digestCache(src);
  if (typeof src === 'string') {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(src, 'utf8').replace(/^﻿/, '')); }
    catch { return { ok: false, reason: 'map cache unreadable', npcs: [], unleveled: 0 }; }
    return digestCache(raw);
  }
  const D = require('./db');
  const v = D.mapCache.version();
  if (_cache.version === v && _cache.value) return _cache.value;
  // only the npc rows: the table also holds every flat and valley the map scan
  // has read, and none of those matter here
  const rows = D.mapCache.npcs();
  if (!rows.length) {
    return { ok: false, reason: 'no npc camps in the map cache yet — the background map scan reads the blocks around each farming city (config mapscan)', npcs: [], unleveled: 0 };
  }
  const value = digestCache(rows);
  _cache = { version: v, value };
  return value;
}

// Only entries that are an npc AND carry a level are usable: a plain mapscan.js
// sweep stores castles without the terrain byte, so their level is unknown and we
// cannot pick a troop load for them. `raw` is a cache object ({castles}) or a
// list of cached tiles.
function digestCache(raw) {
  const all = Array.isArray(raw) ? raw : Object.values((raw && raw.castles) || {});
  const npcs = [];
  let unleveled = 0, newest = 0;
  for (const c of all) {
    if (!(c.npc === true || c.kind === 'npc')) continue;
    const level = Number(c.level);
    if (!Number.isFinite(level) || level < 1 || level > MAX_NPC_LEVEL) { unleveled++; continue; }
    const id = Number(c.id);
    const xy = Number.isFinite(c.x) && Number.isFinite(c.y) ? { x: Number(c.x), y: Number(c.y) } : C.fieldIdToCoords(id);
    npcs.push({ id, x: xy.x, y: xy.y, level, name: c.name || "Barbarian's city", seen: n(c.seen) });
    newest = Math.max(newest, n(c.seen));
  }
  return { ok: true, reason: null, npcs, unleveled, updatedAt: Array.isArray(raw) ? newest : n(raw && raw.updatedAt) };
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

// wiki Heroes: isAttackHero / isPoliticsHero / isIntelHero — "the hero's highest
// stat". OUR CHOICE on a tie: attack first, then politics, so a tie never takes a
// hero off the farming it already did.
function heroType(h) {
  const a = n(h.power), p = n(h.management), i = n(h.stratagem);
  if (a >= p && a >= i) return 'attack';
  return p >= i ? 'politics' : 'intel';
}

// wiki TrainPol: "the best politics hero of the town (i.e., the mayor)" — the
// politics hero with the best politics score (a prisoner we hold is not ours).
// The sitting mayor wins a tie, as in the mayor plan.
function bestPoliticsHero(heroes) {
  const pool = (heroes || []).filter((h) => Number(h.status) !== 4 && heroType(h) === 'politics');
  pool.sort((a, b) => (n(b.management) - n(a.management))
    || ((Number(b.status) === 1) - (Number(a.status) === 1)) || (n(a.id) - n(b.id)));
  return pool[0] || null;
}

// Does the mayor plan run here, so it can stand another hero in? Not under
// config hero:0 (hero management off) or nomayor:1 (goalmods.mayorPlan).
const mayorManaged = (cfg) => !(cfg.hero !== undefined && cfg.hero !== null && cfg.hero !== '' && Number(cfg.hero) === 0)
  && n(cfg.nomayor) !== 1;

// ------------------------------------------------------------- goal plumbing

const goalsNamed = (ctx, name) => (ctx.goals || []).filter((g) => g.name === name);
// a level-specific line wins; a line written without a level is the fallback
const forLevel = (list, level) => list.find((g) => g.level === level) || list.find((g) => g.level == null) || null;

// wiki HeroString: several npcheroes lines for one level are OR'd, as if joined
// with '|'. Lines for this level win. wiki NpcHeroes: a line with no level is
// "the older style ... for all npcs of level 1-5" (npc10heroes was level 10), so
// it covers 1-5 only; with nothing for a level, "any" (the default).
function heroSpecFor(ctx, level) {
  const list = [...goalsNamed(ctx, 'npcheroes'), ...goalsNamed(ctx, 'npc10heroes')];
  const own = list.filter((g) => g.level === level);
  if (own.length) return own.map((g) => g.spec).join('|');
  const old = level <= 5 ? list.filter((g) => g.level == null) : [];
  return old.length ? old.map((g) => g.spec).join('|') : 'any';
}

// Every farmingpolicy switch that applies to a level: the lines written for it
// over the lines written with no level (which cover every level). null: only the
// lines with no level.
function fpFor(ctx, level) {
  const list = goalsNamed(ctx, 'farmingpolicy');
  const out = {};
  for (const g of list) if (g.level == null) Object.assign(out, g.policy || {});
  if (level != null) for (const g of list) if (g.level === level) Object.assign(out, g.policy || {});
  return out;
}

// distancepolicy's five distances (only the ones written).
const dpFor = (ctx) => { const g = goalsNamed(ctx, 'distancepolicy').slice(-1)[0]; return (g && g.distances) || {}; };

// npclimits for a level: its own line, else (6-10) the line written with no level.
function limitsFor(ctx, level) {
  const list = goalsNamed(ctx, 'npclimits');
  return list.find((g) => g.level === level) || (level >= 6 ? list.find((g) => g.level == null) : null) || null;
}

// Which camps of a level may be farmed (wiki CategoryNpcGoals, "processed ... in
// the following order of priority", the first that is set wins):
//   1. an npclist for the level (or one with no level): only the listed camps
//   2. npcbounds: every camp inside the box(es)
//   3. farmingpolicy /mindistance and /maxdistance: that band of miles
//   4. distancepolicy's first number: that many miles
//   5. 10 miles
// A band missing one end takes the next rule's radius (or 0) for it.
function rangeFor(ctx, level) {
  const lists = goalsNamed(ctx, 'npclist').filter((g) => g.level === level || g.level == null);
  if (lists.length) {
    const ids = new Set(lists.flatMap((g) => (g.coords || []).map((c) => C.coordsToFieldId(c.x, c.y))));
    const listed = new Set(lists.filter((g) => g.level === level).flatMap((g) => (g.coords || []).map((c) => C.coordsToFieldId(c.x, c.y))));
    return { rule: 'npclist', ids, listed, min: 0, max: null, why: `npclist (${ids.size} camp${ids.size === 1 ? '' : 's'})` };
  }
  const boxes = goalsNamed(ctx, 'npcbounds').filter((g) => g.level === level || g.level == null).map((g) => g.box).filter(Boolean);
  if (boxes.length) return { rule: 'npcbounds', boxes, min: 0, max: null, why: 'npcbounds' };
  const fp = fpFor(ctx, level);
  const dp = dpFor(ctx);
  if (fp.minDistance != null || fp.maxDistance != null) {
    const max = fp.maxDistance ?? dp.npc ?? DEFAULT_RADIUS;
    const min = fp.minDistance || 0;
    return { rule: 'farmingpolicy', min, max, why: `${min ? `${min}-` : 'within '}${max} tiles (farmingpolicy)` };
  }
  if (dp.npc != null) return { rule: 'distancepolicy', min: 0, max: dp.npc, why: `within ${dp.npc} tiles (distancepolicy)` };
  return { rule: 'default', min: 0, max: DEFAULT_RADIUS, why: `within ${DEFAULT_RADIUS} tiles (default)` };
}

// How often a camp of this level may be hit (wiki CategoryNpcGoals, "Farming
// Frequency", the first that is set wins):
//   1. training:1/2 for levels 1-9, training10:1 for level 10: every hour
//      (wiki NpcLimit: "config training for level 1-9 npcs, or config training10
//      for npc10s")
//   2. the level's farmingpolicy /farmingcycle, /cycle, /maxcycle, /mincycle
//   3. config farmingcycle and farmingcyclemin (the minimum on levels 1-5 only)
//   4. 8.4 hours
// maxMs is the gap between hits; minMs, when set, turns on the smart choice
// (FarmingCycleMin, SmartFarming): any camp hit at least minMs ago may go, the
// one worth most per trip first. smartfarming 2/3 turns it on for levels 1-5.
function cycleFor(ctx, level) {
  const cfg = ctx.config || {};
  const H1 = 3600000;
  const low = level <= 5;
  const training = level >= MAX_NPC_LEVEL ? n(cfg.training10) >= 1 : n(cfg.training) >= 1;
  if (training) {
    return { maxMs: TRAINING_CYCLE_H * H1, minMs: null, smart: false, why: level >= MAX_NPC_LEVEL ? 'training10' : `training:${n(cfg.training)}` };
  }
  const fp = fpFor(ctx, level);
  let max, min, why;
  if (fp.maxCycle != null || (low && fp.minCycle != null)) {
    max = fp.maxCycle ?? posNum(cfg.farmingcycle) ?? DEFAULT_CYCLE_H;
    min = low ? fp.minCycle ?? null : null;
    why = 'farmingpolicy';
  } else if (posNum(cfg.farmingcycle) != null || (low && posNum(cfg.farmingcyclemin) != null)) {
    max = posNum(cfg.farmingcycle) ?? DEFAULT_CYCLE_H;
    min = low ? posNum(cfg.farmingcyclemin) : null;
    why = 'config';
  } else {
    max = DEFAULT_CYCLE_H; min = null; why = 'default';
  }
  if (low && min == null && [2, 3].includes(n(cfg.smartfarming))) { min = SMART_MIN_H; why += ', smartfarming'; }
  if (min != null && min > max) min = max;
  return { maxMs: max * H1, minMs: min == null ? null : min * H1, smart: min != null, why };
}

// kept for the tests and for tuning: the gap between hits on a camp
const cycleMsFor = (ctx, level) => cycleFor(ctx, level).maxMs;

const cycleText = (c) => (c.smart
  ? `smart, ${hms(c.minMs)} to ${hms(c.maxMs)} between hits (${c.why})`
  : `each hit every ${hms(c.maxMs)} (${c.why})`);

// How many farming teams may be out. The rally spot and rallypolicy are the
// rally book's to enforce (rally.js), across every kind of march.
function teamCapFor(ctx) {
  const teamsGoal = goalsNamed(ctx, 'npcteams')[0];
  const reasons = [];
  let teams = teamsGoal ? n(teamsGoal.teams) : DEFAULT_TEAMS;
  reasons.push(teamsGoal ? `npcteams ${teams}` : `npcteams ${teams} (default)`);

  const fpTeams = n(fpFor(ctx, null).teams);
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

// ------------------------------------------------------------ research gate

// C.TECHS: Military Tradition 9, Horseback Riding 13, Archery 14.
const TECH = { mt: 9, ho: 13, ar: 14 };

// wiki FAQ, "Why won't my bot farm npc5s?": "The bot needs a Military Tradition
// level 2+ higher than the npc level, so for a npc5 it needs MT7+. The bot also
// needs archery 8 + hbr 5/6, or archery 9 + hbr 8/9, or archery 10 + any hbr
// level." That is the ballista farming of levels 1-5 (level + 2 cannot be had
// past level 8). Read as written: Archery 8 with Horseback Riding 5 or 6,
// Archery 9 with 8 or 9, Archery 10 with any. Research is the account's, from
// tech.getResearchList (Engine.readTechs); unknown research farms none of it.
function researchCheck(techs, level) {
  if (level > 5) return { ok: true };
  const lv = techs && techs.levels;
  if (!lv) return { ok: false, unknown: true, why: `research levels unknown${techs && techs.error ? ` (${techs.error})` : ''} — levels 1-5 wait for them (wiki FAQ)` };
  const get = (id) => (lv[id] === undefined || lv[id] === null || lv[id] === '' ? null : n(lv[id]));
  const mt = get(TECH.mt), ho = get(TECH.ho), ar = get(TECH.ar);
  const missing = [[mt, 'Military Tradition'], [ho, 'Horseback Riding'], [ar, 'Archery']].filter(([v]) => v === null).map(([, s]) => s);
  if (missing.length) return { ok: false, unknown: true, why: `the research list has no ${missing.join(', ')} — levels 1-5 wait for it (wiki FAQ)` };
  if (mt < level + 2) return { ok: false, why: `Military Tradition ${mt}, level ${level} needs ${level + 2} (wiki FAQ)` };
  const pair = ar >= 10 || (ar === 9 && (ho === 8 || ho === 9)) || (ar === 8 && (ho === 5 || ho === 6));
  if (!pair) {
    return { ok: false, why: `Archery ${ar} with Horseback Riding ${ho} — NEAT farms 1-5 with Archery 8 and HBR 5 or 6, Archery 9 and HBR 8 or 9, or Archery 10 (wiki FAQ)` };
  }
  return { ok: true };
}
// Only a city that may farm levels 1-5 needs the research list read.
const needsResearch = (cfg) => { const lo = n((cfg || {}).npc); return lo >= 1 && lo <= 5; };

// ------------------------------------------------------- targets for a level

// The map wraps at its edges, and so does a box (npcbounds parser).
const inSpan = (v, lo, hi) => hi - lo >= C.MAP_W - 1 || ((((v - lo) % C.MAP_W) + C.MAP_W) % C.MAP_W) <= hi - lo;
const inBox = (t, b) => inSpan(t.x, b.xMin, b.xMax) && inSpan(t.y, b.yMin, b.yMax);

function targetsFor(ctx, cache, home, level, range = rangeFor(ctx, level)) {
  const excl = goalsNamed(ctx, 'excludelist');
  const exclCoords = new Set(excl.flatMap((g) => (g.coords || []).map((c) => C.coordsToFieldId(c.x, c.y))));
  const exclNames = new Set(excl.flatMap((g) => g.names || []));

  let pool = cache.npcs.filter((t) => t.level === level);
  if (range.rule === 'npclist') pool = pool.filter((t) => range.ids.has(t.id));
  else if (range.rule === 'npcbounds') pool = pool.filter((t) => range.boxes.some((b) => inBox(t, b)));
  // wiki ExcludeList: nothing is ever sent to these, whatever else is set
  if (exclCoords.size) pool = pool.filter((t) => !exclCoords.has(t.id));
  if (exclNames.size) pool = pool.filter((t) => !exclNames.has(String(t.name || '').toLowerCase()));

  const lo = range.min || 0, hi = range.max == null ? Infinity : range.max;
  // the short way round (C.mapDistance, NewArmyWin.countDistance), as marches go
  return pool
    .map((t) => ({ ...t, dist: C.mapDistance(home, t) }))
    .filter((t) => t.dist > 0 && t.dist >= lo && t.dist <= hi)
    .sort((a, b) => a.dist - b.dist || a.id - b.id);
}

// Listed camps (npclist for this level) the cache does not hold as camps of this
// level: conquered, never scanned, or listed under the wrong level.
function missingListed(cache, range, level) {
  if (range.rule !== 'npclist' || !range.listed || !range.listed.size) return 0;
  const have = new Set(cache.npcs.filter((t) => t.level === level).map((t) => t.id));
  return [...range.listed].filter((id) => !have.has(id)).length;
}

// ---------------------------------------------------------- the troop load

// What one run against this level should take with it.
//   hero attack >= 50 : npctroops / config ballsused / safe default, in that order
//   hero attack <  50 : the safe default is forced for ballistas (wiki), while the
//                       rest of an npctroops line still stands
// Transports are sized from the loot estimate unless npctroops names a number.
//   opts.loot          the loot expected (smartfarming 1/3 send only what refilled)
//   opts.noTransports  training:2 (wiki Training: "farm hourly, without
//                      transports"): none for the loot, only what the march food needs
function troopLoadFor(ctx, level, hero, target, opts = {}) {
  const cfg = ctx.config || {};
  const custom = forLevel(goalsNamed(ctx, 'npctroops'), level);
  const safeSwitch = n(fpFor(ctx, level).safeBalls);
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
    // wiki NpcTroops lists no numbers for 6-10 ("npctroops 6" ... left blank):
    // NEAT works them out itself, and a guess here would cost troops
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
  const noTransports = !!opts.noTransports;
  if (noTransports) delete troops.carriage;
  const loadSkill = n(opts.loadSkill ?? 100);
  const marchSkill = n(opts.marchSkill ?? 100);
  const explicitTransports = !noTransports && custom && custom.troops.carriage !== undefined;
  const loot = noTransports ? 0 : n(opts.loot ?? NPC_LOOT[level]);

  const carriage = C.BY_KEY.carriage;
  const probe = { ...troops, carriage: n(troops.carriage) || 1 };
  const oneWayMs = target ? oneWayMsTo(opts.home || { x: 0, y: 0 }, target, probe, marchSkill) : 0;
  const hours = oneWayMs / 3600000;

  if (!explicitTransports) {
    const base = { ...troops }; delete base.carriage;
    const space = capacityOf(base, loadSkill) - marchFoodOf(base, oneWayMs);
    const perTransport = carriage.load * (1 + loadSkill / 100) - carriage.food * 2 * hours;
    const need = Math.max(0, loot - space);
    if (loot > 0 || need > 0) {
      if (perTransport <= 0) return { ok: false, reason: 'march is so long a transport eats more than it carries', troops: null };
      troops.carriage = Math.max(loot > 0 ? 1 : 0, Math.ceil(need / perTransport));
      if (troops.carriage) why.push(loot > 0 ? `${troops.carriage} transport for ~${fmt(loot)} loot` : `${troops.carriage} transport for the march food`);
    }
  }
  if (noTransports) why.push('no transports for loot (training:2)');

  for (const k of Object.keys(troops)) if (!n(troops[k])) delete troops[k];

  const capacity = capacityOf(troops, loadSkill);
  const food = marchFoodOf(troops, oneWayMs);
  return {
    ok: true, troops, why: why.join(', '), weakHero,
    oneWayMs, roundTripMs: oneWayMs * 2, capacity, marchFood: food, space: capacity - food, loot,
  };
}

// ----------------------------------------------------------- farming history

// wiki Npc: "The bot will automatically detect maintenance and reset your
// farming cycle after it relogs" (NEAT's \resetfarminghistory does the same by
// hand; SmartFarming: it "will clear Smart Farming's 'memory'"). Every camp is
// fresh again; the runs still in the air are kept, they hold teams and heroes.
// Returns how many camps were forgotten.
function resetHistory(state, why = 'by hand', at = Date.now()) {
  const st = (state.npc = state.npc || {});
  const forgot = Object.keys(st.hits || {}).length;
  st.hits = {};
  delete st.cycles;                    // the old per-level pass clock
  st.historyResetAt = at;
  st.historyResetWhy = why;
  return forgot;
}

// ----------------------------------------------------------------- the plan

function npcPlan(ctx, state, game) {
  // tolerate the older (ctx, game, state) ordering used by goalmods.js
  if (state && state.castles && Array.isArray(state.castles)) { const t = state; state = game; game = t; }
  game = game || (ctx && ctx.game) || null;
  state = state || {};
  ctx = ctx || {};

  const cfg = ctx.config || {};
  if (cfg.npc === undefined || cfg.npc === null || cfg.npc === '' || cfg.npc === 0) return null;   // goal not switched on
  const lowest = n(cfg.npc);
  const bad = configProblems(cfg, FARMING_KEYS);
  if (bad.length) return { note: `npc:${cfg.npc} — held: ${bad.join('; ')}`, actions: [] };

  // wiki WarTown: "No npc farming runs" from a war town (the console's War
  // Town Mode counts the same), and none inside wartownpolicy's hours.
  const war = W.lockdown(ctx);
  if (war.on) return { note: `npc:${lowest} — held: ${war.why}`, actions: [] };
  // processingpolicy !n (or n:0, or inside a timed line's hours): no runs
  const pp = P.allowed(ctx, 'n');
  if (!pp.on) return { note: `npc:${lowest} — held: ${pp.why}`, actions: [] };

  const castle = ctx.castle || {};
  const now = n(ctx.now) || Date.now();
  const notes = [];

  const st = (state.npc = state.npc || {});
  st.hits = st.hits || {};
  st.runs = (Array.isArray(st.runs) ? st.runs : []).filter((r) => n(r.doneAt) > now);
  // the hit log only matters for one cycle; a week (or two cycles, if longer)
  // keeps enginestate.json from growing a key per camp ever farmed
  const keepMs = Math.max(7 * 86400000, 2 * (posNum(cfg.farmingcycle) || 0) * 3600000);
  for (const [k, v] of Object.entries(st.hits)) if (now - n(v) > keepMs) delete st.hits[k];

  // the console says when it came back from maintenance (session.js)
  if (n(ctx.maintEndedAt) > n(st.historyResetAt)) {
    const forgot = resetHistory(state, 'maintenance', n(ctx.maintEndedAt));
    notes.push(`farming history reset after maintenance (${forgot} camp(s) forgotten)`);
  }

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
  // (training carries levels 1-9 on, training10 level 10 — wiki NpcLimit)
  const limitDays = n(cfg.npclimit);
  const trainLow = n(cfg.training) >= 1, trainTen = n(cfg.training10) >= 1;
  const days = foodDays(castle);
  const pantryFull = limitDays > 0 && days >= limitDays;
  if (pantryFull && !trainLow && !trainTen) {
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
    return { note: [`npc:${lowest} — ${why}`, ...notes].join(' | '), actions: [] };
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

  // Who may farm at all, and who goes first (wiki TrainInt, TrainPol, NoMayor):
  //   intel heroes     not by default; config trainint:1 sends them before the
  //                    attack heroes
  //   the best politics hero (the mayor, or the one kept for it)
  //                    not by default; config trainpol:1 sends it first of all,
  //                    and nomayor:1 (no mayor kept) lets it farm like anyone
  //   other politics heroes farm like attack heroes ("keep the best of the 2
  //                    politics heroes home to act as mayor, and send the 2nd
  //                    one out to farm as if it were an attack hero")
  // A mayor cannot march. Under trainpol the best politics hero may leave the
  // office: the mayor plan, told which heroes are leaving, stands another hero in
  // (goalmods.mayorPlan) — so one other hero stays home this slice to be that
  // stand-in, and nothing goes where the mayor plan cannot run.
  const trainInt = n(cfg.trainint) === 1, trainPol = n(cfg.trainpol) === 1, noMayor = n(cfg.nomayor) === 1;
  const bestPol = bestPoliticsHero(castle.heros);
  let standIn = null;
  if (trainPol && bestPol && Number(bestPol.status) === 1 && !busyHeroes.has(bestPol.id)) {
    if (!mayorManaged(cfg)) {
      notes.push(`trainpol: ${bestPol.name} is mayor, and with config ${noMayor ? 'nomayor:1' : 'hero:0'} nothing stands another hero in`);
    } else {
      // the one the mayor plan would most likely want: the best politics at home
      standIn = idleHeroes.slice().sort((a, b) => (n(b.management) - n(a.management)) || (heroAttack(a) - heroAttack(b)))[0] || null;
      if (standIn) idleHeroes.unshift(bestPol);
      else notes.push(`trainpol: ${bestPol.name} stays mayor — no other hero is home to stand in`);
    }
  }
  const held = (h) => {
    if (standIn && h.id === standIn.id) return `${h.name} stays to stand in as mayor while ${bestPol.name} farms (trainpol)`;
    if (bestPol && h.id === bestPol.id && !trainPol && !noMayor) return `${h.name} is the best politics hero, kept home as mayor (config trainpol:1 lets it farm)`;
    if (heroType(h) === 'intel' && !trainInt) return `${h.name} is an intel hero (config trainint:1 lets it farm)`;
    return null;
  };
  const rank = (h) => (trainPol && bestPol && h.id === bestPol.id ? 0 : trainInt && heroType(h) === 'intel' ? 1 : 2);

  const actions = [];
  const opts = {
    home,
    loadSkill: n(game && game.loadSkillParam) || 100,
    marchSkill: n(game && game.marchSkillParam) || 100,
  };
  const smartMode = n(cfg.smartfarming);
  let scanned = 0, outOfHeroes = false;
  const since = (t) => { const h = n(st.hits[t.id]); return h ? now - h : Infinity; };

  // Highest level first, falling back down to `config npc:<lowest>` as supplies run
  // out — this is the "work its way down" behaviour from the wiki.
  for (let level = MAX_NPC_LEVEL; level >= lowest && slots > 0; level--) {
    const range = rangeFor(ctx, level);
    const all = targetsFor(ctx, cache, home, level, range);
    const lost = missingListed(cache, range, level);
    if (lost) notes.push(`L${level}: ${lost} npclist camp(s) are not level ${level} npcs in the map cache — left out`);
    if (!all.length) continue;
    scanned += all.length;

    if (pantryFull && !(level >= MAX_NPC_LEVEL ? trainTen : trainLow)) {
      notes.push(`L${level}: npclimit ${limitDays} reached and ${level >= MAX_NPC_LEVEL ? 'training10' : 'training'} is off`);
      continue;
    }

    // level 6-10 need an npclimits line at all, and enough troops to satisfy it
    const limits = limitsFor(ctx, level);
    if (level >= 6 && !limits) { notes.push(`L${level}: ${all.length} target(s) skipped — needs "npclimits ${level} ..."`); continue; }

    // levels 1-5: only with the research NEAT asks for
    const rc = researchCheck(ctx.techs, level);
    if (!rc.ok) { notes.push(`L${level}: ${all.length} camp(s) held — ${rc.why}`); continue; }

    const cyc = cycleFor(ctx, level);
    const gap = cyc.smart ? cyc.minMs : cyc.maxMs;
    // what a camp has refilled: full after REGEN_H (wiki SmartFarming); the smart
    // choice counts a camp as full once maxMs has passed, the most it waits
    const regen = (t) => Math.min(1, since(t) / (REGEN_H * 3600000));
    const worth = (t) => Math.min(1, since(t) / Math.min(REGEN_H * 3600000, cyc.maxMs));
    let fresh = all.filter((t) => !busyTargets.has(t.id) && since(t) >= gap);
    // smart: the camp worth most per trip first. Every run of a level takes the
    // same troops, so its trip is as long as its distance (wiki FarmingCycleMin:
    // "two npcs at 1 mile away with 50% ... one npc at 6 miles away with 100%")
    if (cyc.smart) fresh = fresh.sort((a, b) => (worth(b) / Math.max(b.dist, 0.5)) - (worth(a) / Math.max(a.dist, 0.5)) || a.dist - b.dist || a.id - b.id);
    notes.push(`L${level}: ${range.why}, ${cycleText(cyc)}`);
    if (!fresh.length) {
      const waits = all.filter((t) => !busyTargets.has(t.id)).map((t) => gap - since(t)).filter((x) => x > 0);
      notes.push(`L${level}: pass complete (${all.length} camp(s)), next in ${hms(waits.length ? Math.min(...waits) : 0)}`);
      continue;
    }

    let stop = null, tooFar = 0;
    for (const target of fresh) {
      if (slots <= 0) break;

      const spec = heroSpecFor(ctx, level);
      const free = idleHeroes.filter((h) => !busyHeroes.has(h.id));
      if (!free.length) { stop = 'no idle hero left'; outOfHeroes = true; break; }
      const farmers = free.filter((h) => !held(h));
      if (!farmers.length) { stop = `no hero may farm — ${free.map(held).join('; ')}`; outOfHeroes = true; break; }
      const allowed = heroCandidates(farmers, spec, castle.heros).sort((a, b) => rank(a) - rank(b));
      if (keepHome && allowed.length && allowed.length <= keepHome) {
        stop = `homeheroes ${keepHome}: ${allowed.map((h) => h.name).join(', ')} stay${allowed.length === 1 ? 's' : ''} home`;
        break;
      }
      const hero = allowed.find((h) => !kept.reservedIds.has(h.id));
      if (!hero) {
        stop = allowed.length ? `${allowed[0].name} is the only idle hero for "${spec}" and keepatthome keeps it home` : `no idle hero matches "${spec}"`;
        break;
      }

      // npclimits: the troops that must be in the city before a run leaves
      // (wiki NpcLimits "before it will begin or continue farming")
      if (limits) {
        const low = Object.entries(limits.troops).find(([k, v]) => n(avail[k]) < n(v));
        if (low) { stop = `npclimits ${level}: ${fmt(avail[low[0]])} ${C.BY_KEY[low[0]] ? C.BY_KEY[low[0]].name : low[0]} at home, needs ${fmt(low[1])} before a run leaves`; break; }
      }

      // smartfarming 1/3: "send only enough transports as would be needed to
      // collect all the resources ... it should have regenerated since you last
      // hit it" (wiki SmartFarming); training:2 sends none for loot (levels 1-9)
      const fill = regen(target);
      const load = troopLoadFor(ctx, level, hero, target, {
        ...opts, home,
        loot: smartMode === 1 || smartMode === 3 ? Math.round(NPC_LOOT[level] * fill) : undefined,
        noTransports: n(cfg.training) === 2 && level < MAX_NPC_LEVEL,
      });
      if (!load.ok) { stop = load.reason; break; }

      // a run that cannot get back inside one cycle can never sustain a pass
      if (load.roundTripMs > cyc.maxMs) { tooFar++; continue; }

      const short = Object.entries(load.troops).find(([k, v]) => n(avail[k]) < v);
      if (short) { stop = `short ${C.BY_KEY[short[0]] ? C.BY_KEY[short[0]].name : short[0]} (need ${fmt(short[1])}, have ${fmt(avail[short[0]])})`; break; }

      // rallypolicy n:<level>:<slots>
      const lr = book.room(castle, 'n', { level, levelOf, planned: { total: actions.length, kind: actions.length, level: n(plannedAt[level]) } });
      if (lr.room <= 0) { stop = lr.why; break; }

      for (const [k, v] of Object.entries(load.troops)) avail[k] -= v;
      busyHeroes.add(hero.id);
      busyTargets.add(target.id);
      slots--;
      plannedAt[level] = n(plannedAt[level]) + 1;

      const leavesOffice = Number(hero.status) === 1;
      const extra = [
        ...(cyc.smart ? [`~${Math.round(worth(target) * 100)}% worth`] : []),
        ...(leavesOffice ? ['leaves the mayor\'s office for it (trainpol)'] : []),
      ];
      actions.push({
        kind: 'npcAttack',
        level, fieldId: target.id, target: { x: target.x, y: target.y },
        hero, heroId: hero.id, heroAttack: heroAttack(hero),
        troops: load.troops,
        oneWayMs: load.oneWayMs, roundTripMs: load.roundTripMs, cycleMs: cyc.maxMs,
        why: load.why, distance: Math.round(target.dist * 10) / 10,
        ...(leavesOffice ? { leavesOffice: true } : {}),
        label: `npc L${level} at ${target.x},${target.y} (${Math.round(target.dist * 10) / 10} tiles, ${hms(load.oneWayMs)} out) ` +
               `with ${hero.name} atk ${heroAttack(hero)} — ${troopText(load.troops)}${extra.length ? ` (${extra.join(', ')})` : ''}`,
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
    if (tooFar) notes.push(`L${level}: ${tooFar} camp(s) skipped — round trip longer than the ${hms(cyc.maxMs)} cycle`);
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
  if (limitDays > 0) tail.push(`food ${days === Infinity ? 'inf' : days.toFixed(1)}d / limit ${limitDays}d${trainLow || trainTen ? ', training on' : ''}`);
  if (smartMode) tail.push(`smartfarming ${smartMode}`);
  const scanBad = configProblems(cfg, ['mapscan']);
  if (scanBad.length) tail.push(`${scanBad[0]} — the background map scan is off here`);

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

// ---------------------------------------------------- the background map scan
// NPC farming picks its camps from the shared map cache, and nothing used to
// fill that but someone browsing the Map tab or running mapscan.js (a second
// login, which kicks the console). The console now reads the blocks around each
// farming city on its own session (session.js backgroundScan): a few 20x20
// blocks per engine tick, each read again after a few hours, never during
// maintenance, and the NPC camps, flats and valleys they hold go into the cache.
// This is the part that decides WHICH blocks; the session only asks for them.
const SCAN = {
  BLOCK: 20,                  // the server answers 20x20 tiles at most (session.js MAP_BLOCK)
  PER_ROUND: 3,               // blocks asked for per engine tick (one tick a minute)
  REFRESH_MS: 4 * 3600000,    // a block is read again after this long
  RETRY_MS: 15 * 60000,       // one that got no answer is asked again after this
  MAX_PER_CITY: 400,          // a 150-mile radius is 208 blocks; a huge npcbounds box stops here
};
// What a scanned block leaves in the cache: every castle and camp, and the empty
// terrain — flats (buildnpc) and the six valley kinds (for the valley goals).
const SCAN_KEEP = new Set(['flat', 'forest', 'desert', 'hill', 'swamp', 'grassland', 'lake']);
const keepTile = (t) => !!(t && (t.userName || t.npc || SCAN_KEEP.has(t.kind)));

// The valley and flat goals (goal-valley.js) read the same cache, so a city
// that captures, farms or hunts valleys, or holds flats, is scanned too, as far
// as those goals reach. Required when asked: goal-valley requires this module.
const valleyArea = (ctx) => require('./goal-valley').scanArea(ctx);

// config mapscan:1 scans around the city, 0 never. Unset: cities that farm or
// build NPCs are scanned, since they need the camps and flats, and so are the
// cities with a valley goal. A value that is not 0 or 1 scans nothing (the npc
// plan's note says so).
function scanWanted(cfg, goals) {
  const v = (cfg || {}).mapscan;
  if (v !== undefined && v !== null && v !== '') return v === 1 || v === '1';
  return n(cfg.npc) >= 1 || n(cfg.buildnpc) >= 1 || !!valleyArea({ config: cfg || {}, goals: goals || [] });
}

// How far around a city the scan reads: distancepolicy's fifth number — NEAT's
// "map scanning and view distance", 10 by default like the others — or further
// if a farming rule reaches further (rangeFor, every level it can farm: 6-10 only
// with an npclimits line), or npc building's distance when it builds NPCs
// (distancepolicy's second number, else 10). npclist camps and npcbounds boxes
// add their own blocks, wherever they are.
function scanAreaFor(ctx) {
  const cfg = ctx.config || {};
  const dp = dpFor(ctx);
  let radius = dp.scan != null ? n(dp.scan) : DEFAULT_RADIUS;
  const points = [], boxes = [];
  const lowest = n(cfg.npc);
  if (lowest >= 1 && lowest <= MAX_NPC_LEVEL) {
    for (let level = lowest; level <= MAX_NPC_LEVEL; level++) {
      if (level >= 6 && !limitsFor(ctx, level)) continue;       // can never farm
      const r = rangeFor(ctx, level);
      if (r.rule === 'npclist') for (const id of r.ids) points.push(C.fieldIdToCoords(id));
      else if (r.rule === 'npcbounds') boxes.push(...r.boxes);
      else radius = Math.max(radius, n(r.max));
    }
  }
  if (n(cfg.buildnpc) >= 1) radius = Math.max(radius, n(dp.build) || DEFAULT_RADIUS);
  const valleys = valleyArea(ctx);
  if (valleys) { radius = Math.max(radius, n(valleys.radius)); points.push(...(valleys.points || [])); }
  return { radius: Math.min(radius, MAX_DISTANCE), points, boxes };
}

// The aligned blocks (origins, wrapped onto the map) an area covers, each with
// its distance from the city (to the nearest tile of the block), nearest first.
function blocksFor(home, area) {
  const B = SCAN.BLOCK, M = C.MAP_W;
  const wrap = (v) => ((Math.floor(v) % M) + M) % M;
  const out = new Map();
  const add = (bx, by, dist) => {
    const o = { x: wrap(bx), y: wrap(by) };
    const k = o.x + ',' + o.y;
    const had = out.get(k);
    if (!had || dist < had.dist) out.set(k, { ...o, dist });
  };
  const R = n(area.radius);
  if (R > 0) {
    // unwrapped block origins around the city; the wrap happens in add()
    for (let by = Math.floor((home.y - R) / B) * B; by <= home.y + R; by += B) {
      for (let bx = Math.floor((home.x - R) / B) * B; bx <= home.x + R; bx += B) {
        const dx = Math.max(bx - home.x, 0, home.x - (bx + B - 1));
        const dy = Math.max(by - home.y, 0, home.y - (by + B - 1));
        const d = Math.hypot(dx, dy);
        if (d <= R) add(bx, by, d);
      }
    }
  }
  for (const p of area.points || []) add(Math.floor(p.x / B) * B, Math.floor(p.y / B) * B, C.mapDistance(home, p));
  for (const b of area.boxes || []) {
    for (let by = Math.floor(b.yMin / B) * B; by <= b.yMax && out.size < 4 * SCAN.MAX_PER_CITY; by += B) {
      for (let bx = Math.floor(b.xMin / B) * B; bx <= b.xMax; bx += B) {
        add(bx, by, C.mapDistance(home, { x: wrap(bx + B / 2), y: wrap(by + B / 2) }));
      }
    }
  }
  return [...out.values()].sort((a, b) => a.dist - b.dist || a.y - b.y || a.x - b.x).slice(0, SCAN.MAX_PER_CITY);
}

// Which blocks to read this round.
//   cities   [{ name, xy: {x, y}, config, goals }]   every city with goals
//   seenOf   ({x, y}) => when that block was last read (ms; 0 = never)
// Blocks never read go first, then the nearest to a city, then the oldest; a
// block shared by two cities counts once. At most `perRound`.
function scanPlan({ cities = [], seenOf = () => 0, now = Date.now(), perRound = SCAN.PER_ROUND, refreshMs = SCAN.REFRESH_MS } = {}) {
  const want = new Map();
  const per = [];
  for (const c of cities) {
    const cfg = c.config || {};
    if (!c.xy || !scanWanted(cfg, c.goals)) continue;
    const area = scanAreaFor({ config: cfg, goals: c.goals || [] });
    const blocks = blocksFor(c.xy, area);
    per.push({ city: c.name, radius: area.radius, blocks: blocks.length });
    for (const b of blocks) {
      const k = b.x + ',' + b.y;
      const had = want.get(k);
      if (!had || b.dist < had.dist) want.set(k, { ...b, city: c.name });
    }
  }
  const due = [];
  for (const b of want.values()) {
    const at = n(seenOf({ x: b.x, y: b.y }));
    if (now - at >= refreshMs) due.push({ ...b, seenAt: at });
  }
  due.sort((a, b) => ((a.seenAt > 0) - (b.seenAt > 0)) || a.dist - b.dist || a.seenAt - b.seenAt);
  return {
    origins: due.slice(0, Math.max(0, perRound)).map((b) => ({ x: b.x, y: b.y, city: b.city })),
    due: due.length, wanted: want.size, cities: per,
  };
}

// ------------------------------------------------------------- the executor

// Records a successful send so the per-camp cooldown and the in-flight count
// stay true. Called by the executor; safe to call twice.
function recordSend(state, action, result) {
  if (!state || !action || !result || result.ok !== 1) return;
  const st = (state.npc = state.npc || {});
  st.hits = st.hits || {};
  st.runs = Array.isArray(st.runs) ? st.runs : [];
  const now = Date.now();
  st.hits[action.fieldId] = now;
  st.runs.push({
    fieldId: action.fieldId, level: action.level, heroId: action.heroId,
    sentAt: now, doneAt: now + n(action.roundTripMs) + 60000, troops: action.troops,
  });
  st.npcHits = n(st.npcHits) + 1;
  state.npcHits = n(state.npcHits) + 1;
  // and when, per hero: the traininghero rotation counts its hero's runs from
  // this city since it arrived (goalmods.trainingHeroPlan, the npchits exit)
  const who = action.hero && action.hero.name ? String(action.hero.name).toLowerCase() : null;
  if (who) {
    const hh = (state.heroHits = state.heroHits || {});
    hh[who] = (Array.isArray(hh[who]) ? hh[who] : []).concat(now).slice(-100);
  }
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
  // the engine asks before it reads research for this city (Engine.readTechs)
  needsResearch,
  // the console's background map scan (session.js backgroundScan)
  scanPlan, keepTile, SCAN,
  // NEAT's \resetfarminghistory, for whoever wants to offer it by hand
  resetHistory,
  // exported for the tests and for tuning
  _internals: {
    SAFE_BALLISTAS, NPC_LOOT, DEFAULT_CYCLE_H, DEFAULT_TEAMS, DEFAULT_RADIUS, HERO_ATTACK_FLOOR,
    REGEN_H, SMART_MIN_H, MAX_DISTANCE, TECH,
    loadNpcCache, digestCache, troopLoadFor, targetsFor, rangeFor, cycleFor, cycleMsFor, teamCapFor,
    heroCandidates, heroSpecFor, heroAttack, heroType, bestPoliticsHero, foodDays, capacityOf, marchFoodOf,
    recordSend, troopText, researchCheck, configProblems, fpFor, dpFor, limitsFor, inBox,
    scanWanted, scanAreaFor, blocksFor,
    // shared with the valley goals (goal-valley.js): the troop and coordinate
    // grammar of every farming line, and how a duration is written in a note
    parseTroopSpec, parseCoord, hms,
  },
};
