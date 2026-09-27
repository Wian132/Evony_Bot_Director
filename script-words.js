'use strict';
// The words and small literals every script command reads: troop, fortification,
// resource, building and research words (NEAT's Abbreviations page plus the full
// names), k/m/b numbers, troop and resource strings, clock times and lengths of
// time. No game state and no other script module: every script-cmd-*.js may
// require this at the top without a require cycle through script.js.
//
//   troopByWord('arch') -> TROOPS entry        parseTroops('arch:25000,warr:25k')
//   fortByWord('tre')   -> WALLS entry         parseResources('f:26k,l:26k,g:10k')
//   resourceByWord('l') -> 'wood'              parseLandTime('@:14:30:07.500')
//   buildingByWord('house') -> BUILDINGS entry parseDuration('1:30:00') -> 5400
//   techByWord('met')   -> TECHS entry         num('1.5m') -> 1500000
//
// TROOP_WORDS, FORT_WORDS, RES_WORDS, troopByWord, fortByWord and resourceByWord
// mirror the goal-word tables on goals/09-neat-compat (constants.js), with the
// same names and meanings, so a later merge can point these at constants.js.
const C = require('./constants');

// NEAT's list is the wiki's Abbreviations page: warrior w, worker wo, scout s,
// pikemen p, swordsmen sw, archer a, cavalry c, cataphract cata, transport t,
// ballista b, battering ram ram/br/r, catapult cp/pult. The Troop page and
// NEAT's own !NewCityGoals.txt add warr, cav, phract, arch, trans; the rest are
// the full names and the protocol keys (TroopStrBean).
// Note cata is the CATAPHRACT; the catapult is cp, cat or pult.
const TROOP_WORDS = {
  peasants:     ['wo', 'work', 'worker', 'workers', 'peasant', 'peasants'],
  militia:      ['w', 'warr', 'warrior', 'warriors', 'militia'],
  scouter:      ['s', 'scout', 'scouts', 'scouter', 'scouters'],
  pikemen:      ['p', 'pike', 'pikes', 'pikeman', 'pikemen'],
  swordsmen:    ['sw', 'sword', 'swords', 'swordsman', 'swordsmen'],
  archer:       ['a', 'arch', 'archer', 'archers'],
  carriage:     ['t', 'trans', 'transport', 'transports', 'transporter', 'transporters', 'carriage', 'carriages'],
  lightCavalry: ['c', 'cav', 'cavs', 'cavalry', 'lightcavalry'],
  heavyCavalry: ['cata', 'phract', 'phracts', 'cataphract', 'cataphracts', 'heavycavalry'],
  ballista:     ['b', 'ball', 'balls', 'ballista', 'ballistas', 'ballistae'],
  batteringRam: ['r', 'br', 'ram', 'rams', 'batteringram', 'batteringrams'],
  catapult:     ['cp', 'cat', 'cats', 'pult', 'pults', 'catapult', 'catapults'],
};

// Fortifications, keyed by WALLS code. NEAT's goal codes are tra, ab, at, r and
// tre; its status line prints tr, rl and dt. NEAT's TREBUCHET is our Rock Fall,
// type 18 (the client shows "Rockfall" as "Defensive Trebuchet"). "r" is rolling
// logs HERE and a battering ram in a troop list, as in NEAT.
const FORT_WORDS = {
  trap:   ['tra', 'tr', 'trap', 'traps'],
  abatis: ['ab', 'abatis'],
  tower:  ['at', 'tower', 'towers', 'arrowtower', 'arrowtowers', 'archertower', 'archertowers'],
  logs:   ['r', 'rl', 'log', 'logs', 'rollinglog', 'rollinglogs'],
  rocks:  ['tre', 'treb', 'trebs', 'trebuchet', 'trebuchets', 'dt', 'defensivetrebuchet', 'defensivetrebuchets',
           'rf', 'rock', 'rocks', 'rockfall', 'rockfalls'],
};

// Resources (Abbreviations: gold g, food f, wood w, stone s, iron i; NEAT's own
// pages also say lumber).
const RES_WORDS = {
  food: ['f', 'food'], wood: ['w', 'wood', 'l', 'lumber'], stone: ['s', 'stone'],
  iron: ['i', 'iron'], gold: ['g', 'gold'],
};

// Buildings, keyed by constants.js BUILDING_BY_CODE (the name without spaces).
// Abbreviations: academy a, barrack b, beacon tower be, cottage c, embassy e,
// feasting hall fh, forge fo, farm f, sawmill s, quarry q, iron mine i, inn inn,
// market m, rally spot r, relief station rs, stable st, town hall t, wall w,
// warehouse wh, workshop ws. The Upgrade, Loop, Label and Gosub pages also write
// house, saw, iron and barrack.
const BUILDING_WORDS = {
  cottage:       ['c', 'cottage', 'cottages', 'house', 'houses'],
  barracks:      ['b', 'barrack', 'barracks', 'rax'],
  warehouse:     ['wh', 'warehouse', 'warehouses'],
  sawmill:       ['s', 'saw', 'saws', 'sawmill', 'sawmills', 'lumbermill'],
  quarry:        ['q', 'quarry', 'quarries', 'quary'],
  ironmine:      ['i', 'iron', 'ironmine', 'ironmines', 'mine', 'mines'],
  farm:          ['f', 'farm', 'farms'],
  stable:        ['st', 'stable', 'stables'],
  inn:           ['inn', 'tavern'],
  forge:         ['fo', 'forge'],
  marketplace:   ['m', 'market', 'marketplace'],
  reliefstation: ['rs', 'relief', 'reliefstation'],
  academy:       ['a', 'academy'],
  workshop:      ['ws', 'workshop'],
  feastinghall:  ['fh', 'feast', 'feastinghall'],
  embassy:       ['e', 'embassy'],
  rallyspot:     ['r', 'rally', 'rallyspot', 'rallypoint'],
  beacontower:   ['be', 'beacon', 'beacontower'],
  townhall:      ['t', 'th', 'townhall'],
  walls:         ['w', 'wall', 'walls'],
};

// Research, keyed by constants.js TECH_BY_CODE. Abbreviations: agriculture ag,
// lumbering lu, masonry mas, mining mi, metal casting met, informatics in,
// military science ms, military tradition mt, ironworking ir, logistics lo,
// compass com, horseback riding ho, archery ar, stockpile st or sp, medicine
// med, construction con, engineering en, machinery mac, privateering pr.
const TECH_WORDS = {
  agriculture:       ['ag', 'agri', 'agriculture'],
  lumbering:         ['lu', 'lumbering'],
  masonry:           ['mas', 'masonry'],
  mining:            ['mi', 'mining'],
  metalcasting:      ['met', 'metal', 'metalcasting'],
  informatics:       ['in', 'info', 'informatics'],
  militaryscience:   ['ms', 'militaryscience'],
  militarytradition: ['mt', 'militarytradition'],
  ironworking:       ['ir', 'ironworking'],
  logistics:         ['lo', 'logistics'],
  compass:           ['com', 'compass'],
  horsebackriding:   ['ho', 'horse', 'horseback', 'horsebackriding'],
  archery:           ['ar', 'archery'],
  stockpile:         ['st', 'sp', 'stockpile'],
  medicine:          ['med', 'medicine'],
  construction:      ['con', 'construction'],
  engineering:       ['en', 'eng', 'engineering'],
  machinery:         ['mac', 'machinery'],
  privateering:      ['pr', 'privateering'],
};

const wordKey = (s) => String(s == null ? '' : s).toLowerCase().replace(/[\s_-]+/g, '');
const invert = (words) => {
  const out = Object.create(null);
  for (const [key, list] of Object.entries(words)) for (const w of list) out[w] = key;
  return out;
};
const TROOP_KEY_BY_WORD = invert(TROOP_WORDS);
const FORT_CODE_BY_WORD = invert(FORT_WORDS);
const RES_KEY_BY_WORD = invert(RES_WORDS);
const BUILDING_CODE_BY_WORD = invert(BUILDING_WORDS);
const TECH_CODE_BY_WORD = invert(TECH_WORDS);
const lookupWord = (table, tok) => {
  const k = wordKey(tok);
  if (k in table) return table[k];
  // "archers", "ballistas": a plural of a word the table has. Short words are
  // left alone so "ws" or "cs" can never turn into a code by accident.
  const one = k.length >= 4 && k.endsWith('s') ? k.slice(0, -1) : null;
  return one && one in table ? table[one] : null;
};

// The TROOPS entry for a word, or null.
function troopByWord(tok) {
  const key = lookupWord(TROOP_KEY_BY_WORD, tok);
  return key ? C.BY_KEY[key] || null : null;
}
// The WALLS entry for a word, or null.
function fortByWord(tok) {
  const code = lookupWord(FORT_CODE_BY_WORD, tok);
  return code ? C.WALLS.find((w) => w.code === code) : null;
}
// 'food' | 'wood' | 'stone' | 'iron' | 'gold', or null.
const resourceByWord = (tok) => lookupWord(RES_KEY_BY_WORD, tok);
// The BUILDINGS entry for a word ("house", "saw", "b", "Feasting Hall"), or null.
function buildingByWord(tok) {
  const k = wordKey(tok).replace(/[^a-z]/g, '');
  if (C.BUILDING_BY_CODE[k]) return C.BUILDING_BY_CODE[k];
  const code = lookupWord(BUILDING_CODE_BY_WORD, k);
  return code ? C.BUILDING_BY_CODE[code] || null : null;
}
// The TECHS entry for a word ("met", "Metal Casting"), or null.
function techByWord(tok) {
  const k = wordKey(tok).replace(/[^a-z]/g, '');
  if (C.TECH_BY_CODE[k]) return C.TECH_BY_CODE[k];
  const code = lookupWord(TECH_CODE_BY_WORD, k);
  return code ? C.TECH_BY_CODE[code] || null : null;
}

// A count in a command argument: 5000, 5k, 1.5m, 2b.
const num = (s) => {
  const m = String(s).trim().match(/^([\d.]+)\s*([kmb])?$/i);
  if (!m) throw new Error('bad number: ' + s);
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
};

// "a:5k,c:500" or NEAT's words, "arch:25000,warr:25000" -> { archer: 5000, ... }
function parseTroops(s) {
  const troops = {};
  for (const part of String(s).split(',')) {
    const m = part.trim().match(/^([a-z]+)\s*:\s*([\d.]+[kmb]?)$/i);
    if (!m && /:\s*\*\s*$/.test(part)) throw new Error(`"${part.trim()}": * (fill) works on the resources of a march, not on troops`);
    if (!m) throw new Error('bad troop string: ' + part);
    const t = troopByWord(m[1]);
    if (!t) throw new Error('unknown troop code: ' + m[1]);
    troops[t.key] = num(m[2]);
  }
  return troops;
}

// `f:*` means "as much as the hold has room for". It is only allowed where the
// caller can work out what the room IS — a march, which knows the troops and the
// march time — so it is off unless opts.fill is set, and it comes back as
// Infinity for that caller to resolve (script-cmd-deploy.js fillHold).
function parseResources(s, opts = {}) {
  const out = {};
  for (const part of String(s).split(',')) {
    const m = part.trim().match(/^([a-z]+)\s*:\s*([\d.]+[kmb]?|\*)$/i);
    const key = m && resourceByWord(m[1]);
    if (!key) throw new Error('bad resource string: ' + part + ' (f w s i g, l for lumber, or food/wood/stone/iron/gold)');
    if (m[2] === '*') {
      if (!opts.fill) throw new Error(`"${part.trim()}": * (fill the hold) only works on a march — transport, reinforce, attack or deploy`);
      out[key] = Infinity;
    } else out[key] = num(m[2]);
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

module.exports = {
  TROOP_WORDS, FORT_WORDS, RES_WORDS, BUILDING_WORDS, TECH_WORDS,
  troopByWord, fortByWord, resourceByWord, buildingByWord, techByWord, wordKey,
  num, parseTroops, parseResources, parseLandTime, parseDuration, nextOccurrence,
};
