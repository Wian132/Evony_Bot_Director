'use strict';
// Valleys and flats — NEAT's valley goals.
//
// What the NEAT wiki says (pages Valley, ValleyMin, ValleyFarming,
// SafeValleyFarming, ValleyHeroes, ValleyLimit, ValleyTroops, Hunting,
// HuntingPos, HuntingType, AcquireFlats, AbandonFlats, Abandon, DistancePolicy,
// ExcludeList, NpcTeams, RallyPolicy, CategoryValleyGoals), and how it is done:
//
//   config valley:<n>         capture valleys of the city's main resource — forests
//                             for lumber, hills for iron, deserts for stone, lakes
//                             for food — of level n. With config valleymin:<m>
//                             any level m..n, highest first, and once the slots
//                             are full the lowest valley is let go for a better one
//   config valleyfarming:<n>  keep attacking level-n valleys for resources:
//     valleyfarming <forest> <desert> <hill> <swamp> <grassland> <lake>
//                             miles per type (0 = not that type); without it the
//                             city's own type within distancepolicy's 3rd number
//   safevalleyfarm <l>[,<l>]  scout valleys of those levels and hit, at most once
//                             an hour, those the wiki's three rules say are safe
//   config hunting:<0-10>     medals by catch and release: take a valley, let it
//                             go before the next wave lands. huntingpos x,y and
//                             huntingtype <type> say where
//   config acquireflats:1|2   capture flats within npc-building distance, hold them
//   config abandonflats:1     let held flats below the build level go at the
//                             maintenance warning, so they level up for buildnpc
//   config abandon:1          strip a city you mean to give away: its troops,
//                             walls and queues go, the tax goes up and levies
//                             drain its loyalty
//   valleyheroes / valleylimit / valleytroops    who goes, what must stay home,
//                             what goes (each one its wiki page's defaults)
//
// Game facts this relies on:
//   * a valley or flat is taken by an attack (army.newArmy, missionType 5 —
//     ARMY_MISSION_OCCUPY, constants.MISSION.attack) that wins while the city has
//     a field slot free. The server then pushes server.CastleFieldUpdate and the
//     field is in castle.fields (session.js).
//   * a city holds as many valleys and flats as its Town Hall level: Evony's
//     rule, which NEAT's Field page mirrors ("valley slot ... between 0-9"). The
//     server enforces it and the client never checks it, so it is UNVERIFIED
//     here; a capture that finds no slot simply does not take the tile.
//   * field.giveUpField {fieldId} lets one go (game.giveUpField).
//   * the client offers Attack on a tile only when field.getOtherFieldInfo says
//     canOccupy, and Scout only on canScout (FieldInfoWin.as:1127, :1590); the
//     answer's userName is whoever holds it. Both are read right before every
//     march, so an out-of-date map cache never sends an army at a player's valley.
//
// Conservative throughout (OUR CHOICE where the wiki is silent): each goal is off
// unless its line is written; nothing marches out of a war town or while the
// city is under attack; a tile the map scan read more than a few hours ago, or
// before the last maintenance (which levels every free valley and flat up), is
// never a target; a valley is let go only for the reasons the wiki gives, and is
// checked as still ours right before it goes. Plans are pure; only the
// executors talk to the server.
const C = require('./constants');
const D = require('./db');
const R = require('./rally');
const H = require('./goal-heroes');
const W = require('./goal-war');
const NPC = require('./goal-npc');
const MB = require('./mailbox');
// processingpolicy (processing.js): a valley march's task is what it is for —
// valley acquisition (config valley) a, valley farming v, safe valley farming s
// (its scouting too), medal hunting m, and a flat taken for npc building
// (acquireflats, buildnpc's own capture) b, as rallypolicy counts it
const PROC = require('./processing');
const TASK_OF = { capture: 'a', farm: 'v', safe: 's', hunt: 'm', flat: 'b', build: 'b' };
const taskIs = (code) => (a) => a.kind === 'valleyAttack' && TASK_OF[a.purpose] === code;
for (const code of ['a', 'v', 'm', 'b']) PROC.register(code, { match: taskIs(code) });
PROC.register('s', { kinds: ['valleyScout'], match: taskIs('s') });

const NI = NPC._internals;
const n = (x) => Number(x || 0);
const fmt = (x) => Math.round(n(x)).toLocaleString('en-US');
const kv = (s) => { const i = String(s).indexOf(':'); return i < 0 ? [String(s), null] : [String(s).slice(0, i), String(s).slice(i + 1)]; };
const H1 = 3600000;

// A plain number that keeps its fraction ("10.5 miles"), or null — never NaN.
const DEC = (s) => {
  const t = String(s == null ? '' : s).trim();
  return /^(\d+(\.\d+)?|\.\d+)$/.test(t) ? parseFloat(t) : null;
};
// A whole-number switch value as goals.js left it (a number, or the text it
// could not read), or null.
const whole = (v) => {
  const x = typeof v === 'number' ? v : DEC(v);
  return x !== null && Number.isInteger(x) ? x : null;
};
const isSet = (v) => v !== undefined && v !== null && v !== '';

// ---------------------------------------------------------------- the tables

// wiki FieldTypes (constants.FIELD_TYPES): the six valleys and the flat.
const VALLEY_KINDS = ['forest', 'desert', 'hill', 'swamp', 'grassland', 'lake'];
const TYPE_ID = { forest: 1, desert: 2, hill: 3, swamp: 4, grassland: 5, lake: 6, flat: 10 };
const KIND_OF_TYPE = Object.fromEntries(Object.entries(TYPE_ID).map(([k, v]) => [v, k]));
// wiki ValleyTroops "Valley Types" (HuntingType lists the full words).
const TYPE_WORDS = {
  forest: 'forest', fo: 'forest', desert: 'desert', d: 'desert', hill: 'hill', h: 'hill',
  swamp: 'swamp', s: 'swamp', grassland: 'grassland', grass: 'grassland', g: 'grassland',
  lake: 'lake', l: 'lake', flat: 'flat', fl: 'flat',
};
function typeOfWord(w) {
  const k = String(w || '').toLowerCase();
  if (TYPE_WORDS[k]) return TYPE_WORDS[k];
  return k.length >= 4 && k.endsWith('s') ? TYPE_WORDS[k.slice(0, -1)] || null : null;   // "forests"
}

// wiki Valley: "forests for cities with a higher production of lumber, hills for
// ... iron, deserts for ... stone, and lakes for ... food". NEAT's
// city.resourceFieldType (wiki City) says the type comes from the resource
// fields built: Sawmill 4, Quarry 5, Ironmine 6, Farm 7 (constants.BUILDINGS).
const RESOURCE_OF_FIELD = { 4: 'wood', 5: 'stone', 6: 'iron', 7: 'food' };
const VALLEY_FOR = { wood: 'forest', iron: 'hill', stone: 'desert', food: 'lake' };
const RESOURCE_WORD = { wood: 'lumber', iron: 'iron', stone: 'stone', food: 'food' };

// wiki ValleyTroops, "Default Valley Troops": capturing valleys and flats (for
// holding, npc building and valley acquisition). From level 4 one scout, pike
// and sword go along, and one cavalry from level 5.
const CAPTURE_TROOPS = { 1: { archer: 50 }, 2: { archer: 100 }, 3: { archer: 200 } };
for (const [lvl, w, a] of [[4, 1200, 400], [5, 2400, 800], [6, 4800, 1600], [7, 9600, 3200], [8, 19200, 6400], [9, 38400, 12800], [10, 60000, 19990]]) {
  CAPTURE_TROOPS[lvl] = { militia: w, scouter: 1, pikemen: 1, swordsmen: 1, ...(lvl >= 5 ? { lightCavalry: 1 } : {}), archer: a };
}
// wiki Hunting, "The default troops used to medal hunt and valley farm". The
// ValleyFarming page (and ValleyTroops' copy) has the same table with one scout
// from level 4; each goal takes its own page's table.
const HUNT_TROOPS = { 1: { archer: 50 }, 2: { archer: 100 }, 3: { archer: 200 } };
for (const [lvl, a, b] of [[4, 400, 0], [5, 1000, 0], [6, 2000, 0], [7, 5000, 0], [8, 10000, 1], [9, 20000, 1000], [10, 25000, 2000]]) {
  HUNT_TROOPS[lvl] = { militia: 1, pikemen: 1, swordsmen: 1, ...(lvl >= 5 ? { lightCavalry: 1 } : {}), archer: a, ...(b ? { ballista: b } : {}) };
}
const FARM_TROOPS = {};
for (const [lvl, t] of Object.entries(HUNT_TROOPS)) FARM_TROOPS[lvl] = Number(lvl) >= 4 ? { ...t, scouter: 1 } : { ...t };
// wiki SafeValleyFarming: "The following quantities of archers for each valley level".
const SAFE_ARCHERS = { 1: 50, 2: 100, 3: 200, 4: 500, 5: 1000, 6: 2000, 7: 4000, 8: 8000, 9: 15000, 10: 30000 };
// INFERRED: the wiki says safe farming scouts every valley, not with how many
// scouts. A hundred per valley level; scouts that are beaten just mean the
// valley is not farmed.
const SAFE_SCOUTS = (level) => 100 * level;
// wiki Hunting switch: 1 L2-3, 2 L4-6, 3 L7-9, 4 L9-10, 5 L10, 6-10 that level.
const HUNT_LEVELS = { 1: [2, 3], 2: [4, 5, 6], 3: [7, 8, 9], 4: [9, 10], 5: [10], 6: [6], 7: [7], 8: [8], 9: [9], 10: [10] };
// wiki BuildNpc switch: which npc levels to build (20: every flat).
const BUILD_CODES = { 1: [1], 2: [2], 3: [3], 4: [4], 5: [5], 10: [10], 15: [5, 10], 20: 'all' };

const DEFAULT_RADIUS = 10;             // wiki DistancePolicy "Default: distancepolicy 10 10 10 10 10"
const MAX_DISTANCE = 150;              // wiki DistancePolicy: "the maximum limit in miles is 150"
// OUR CHOICE: the background map scan reads each block again after 4 h
// (goal-npc SCAN), so a tile read more than 5 h ago waits for its next read.
const FRESH_MS = 5 * H1;
const FARM_GAP_MS = H1;                // wiki SafeValleyFarming "at most once per hour"; valley farming the same (OUR CHOICE)
const HUNT_GAP_MS = 3 * 60000;         // OUR CHOICE: hunting waves land 3 min apart, so a one-a-minute tick can let the valley go between them
const MARCH_KEEP_MS = 48 * H1;         // how long a sent march is remembered
const PENDING_MS = 3 * 60000;          // sent, not listed by the server yet (rally.js PENDING_TTL)
const HERO_PUSH_MS = 2 * 60000;        // a hero just sent, before its HeroUpdate marks it away
const RELEASE_WINDOW_MS = 3 * 60000;   // abandonflats: the last minutes before the maintenance stand-down
const REPORT_WAIT_MS = 15 * 60000;     // safevalleyfarm: a scout report not in by then is not coming
const REPORT_READ_GAP_MS = 2 * 60000;  // ...and the report list is read at most this often
const LEVY_GAP_MS = 15 * 60000;        // config abandon: one levy every 15 minutes (OUR CHOICE)
// A tile the game said, when asked before a march, is not free (someone holds
// it, or it offers no attack) is left alone this long, so the nearest such tile
// does not hold a goal up for ever; one whose holder could not be read, less.
const BLOCK_MS = 6 * H1;
const BLOCK_READ_MS = 15 * 60000;

// ------------------------------------------------------------- config values

const LEVELS_0_10 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const CONFIG_RULES = {
  valley: { set: LEVELS_0_10, what: 'the valley level to capture, 1 to 10 (0 is off)' },
  valleymin: { set: LEVELS_0_10, what: 'the lowest valley level to capture, 1 to 10 (used with config valley)' },
  valleyfarming: { set: LEVELS_0_10, what: 'the valley level to farm, 1 to 10 (0 is off)' },
  hunting: { set: LEVELS_0_10, what: 'a hunting switch 0 to 10 (wiki Hunting: 1 = levels 2-3 ... 10 = level 10)' },
  acquireflats: { set: [0, 1, 2], what: '0 (off), 1 (on) or 2 (on, even with no open city slot)' },
  abandonflats: { set: [0, 1], what: '0 (off) or 1 (on)' },
  abandon: { set: [0, 1], what: '0 (off) or 1 (on) — to give up one valley, use the Abandon button in the Valleys tab' },
};

function configProblems(cfg, keys = Object.keys(CONFIG_RULES)) {
  const out = [];
  for (const k of keys) {
    const v = (cfg || {})[k];
    if (!isSet(v)) continue;
    const x = whole(v);
    if (x === null || !CONFIG_RULES[k].set.includes(x)) out.push(`config ${k}:${v} is not ${CONFIG_RULES[k].what}`);
  }
  return out;
}
// A config switch that reads; 0 when off, unset or unreadable (the plan says which).
const lv = (v) => { const x = whole(v); return x !== null && x > 0 ? x : 0; };

// ------------------------------------------------------------------ parsers

function milesOf(v, what, errs) {
  const d = DEC(v);
  if (d === null) { errs.push(`${what}: "${v}" is not a number of miles`); return null; }
  if (d > MAX_DISTANCE) { errs.push(`${what}: ${d} miles is past the ${MAX_DISTANCE}-mile limit, ${MAX_DISTANCE} is used`); return MAX_DISTANCE; }
  return d;
}

const parsers = {};

// The config keys, checked as the goals are read (goals.js runs a key's value
// through its config-kind parser), and a bare "hunting 5" line reads as the
// config line it means. `value` is what goals.js made of it.
for (const k of ['valley', 'valleymin', 'hunting', 'acquireflats', 'abandonflats', 'abandon']) {
  parsers[k] = {
    kind: 'config', multi: false,
    parse(value) {
      if (!isSet(value)) return { value: null, errors: [`${k} needs a value, ${CONFIG_RULES[k].what}`] };
      return { value, errors: configProblems({ [k]: value }, [k]).map((e) => e.replace(/^config /, '')) };
    },
  };
}

// valleyfarming <forest> <desert> <hill> <swamp> <grassland> <lake>   wiki ValleyFarming
//   valleyfarming 5 0 5 0 0 0     forests and hills to 5 miles, nothing else
// The same word is a config key (config valleyfarming:10, the level to farm):
// goals.js checks that value through configParse, so it is red when it will not read.
const MILES_ORDER = ['forest', 'desert', 'hill', 'swamp', 'grassland', 'lake'];
parsers.valleyfarming = {
  kind: 'directive', multi: false,
  parse(args) {
    const errs = [];
    const toks = args.flatMap((t) => String(t).split(/[\s,]+/)).filter(Boolean);
    if (toks.length !== MILES_ORDER.length) {
      errs.push(`valleyfarming takes six distances — forest, desert, hill, swamp, grassland, lake miles, e.g. valleyfarming 5 0 5 0 0 0 (0 leaves a type out); the level to farm is config valleyfarming:<level>`);
      return { miles: null, errors: errs };
    }
    const miles = {};
    toks.forEach((t, i) => { const d = milesOf(t, MILES_ORDER[i], errs); if (d !== null) miles[MILES_ORDER[i]] = d; });
    if (Object.keys(miles).length !== MILES_ORDER.length) return { miles: null, errors: errs };
    return { miles, errors: errs };
  },
  configParse(value) {
    return { errors: configProblems({ valleyfarming: value }, ['valleyfarming']).map((e) => e.replace(/^config /, '')) };
  },
};

// valleyheroes <hero-string> | valleyheroes /reset          wiki ValleyHeroes
//   valleyheroes AttackDude,ValleyGuy          only those two
//   valleyheroes !trainingheroname,any:attack>60
// Several lines are OR'd, as npcheroes lines are; /reset forgets the lines above.
parsers.valleyheroes = {
  kind: 'directive', multi: true,
  parse(args) {
    const errs = [];
    const words = [];
    let reset = false;
    for (const tok of args) {
      if (/^\/reset$/i.test(tok)) { reset = true; continue; }
      if (String(tok).startsWith('/')) { errs.push(`unknown switch "${tok}" (only /reset)`); continue; }
      words.push(tok);
    }
    if (reset) return { reset: true, spec: null, errors: errs };
    if (!words.length) { errs.push('needs a hero string (e.g. any:attack>60, or a hero name) or /reset'); return { reset: false, spec: null, errors: errs }; }
    const spec = H.parseHeroString(words.join(''));
    errs.push(...spec.errors);
    return { reset: false, spec, errors: errs };
  },
};

// valleylimit <troops>     wiki ValleyLimit: "the minimum number of troops it must
// have in the city before it will attack another valley", e.g. valleylimit w:100k,a:50k
parsers.valleylimit = {
  kind: 'directive', multi: false,
  parse(args) {
    const errs = [];
    const troops = NI.parseTroopSpec(args.join(''), errs);
    if (!Object.keys(troops).length) errs.push('needs the troops that must stay in the city, e.g. valleylimit w:100k,a:50k');
    return { troops, errors: errs };
  },
};

// valleytroops [/type:<type>] [/level:#] [<level>] <troops>     wiki ValleyTroops
//   valleytroops 10 a:19990,sw:1,p:1,s:1,w:60000
//   valleytroops /level:10 /type:forest s:100000
parsers.valleytroops = {
  kind: 'directive', multi: true,
  parse(args) {
    const errs = [];
    let level = null, type = null, written = null;
    const rest = [];
    for (const raw of args) {
      const tok = String(raw);
      if (tok.startsWith('/')) {
        const [k, v] = kv(tok.slice(1));
        const key = k.toLowerCase();
        if (key === 'level') {
          if (!/^([1-9]|10)$/.test(String(v))) { errs.push(`/level:${v} — a valley level is 1 to 10`); continue; }
          level = Number(v);
        } else if (key === 'type') {
          const t = typeOfWord(v);
          if (!t) { errs.push(`/type:${v} — the types are forest (fo), desert (d), hill (h), swamp (s), grassland (g), lake (l) and flat (fl)`); continue; }
          type = t;
        } else errs.push(`unknown switch "/${k}" (known: /level /type)`);
        continue;
      }
      rest.push(tok);
    }
    if (rest.length > 1 && /^([1-9]|10)$/.test(rest[0])) written = Number(rest.shift());
    if (written !== null) {
      if (level !== null && level !== written) errs.push(`level ${written} and /level:${level} disagree — ${written} is used`);
      level = written;
    }
    const troops = NI.parseTroopSpec(rest.join(''), errs);
    if (!Object.keys(troops).length) errs.push('no troops given, e.g. valleytroops 4 s:10000');
    return { level, type, troops, errors: errs };
  },
};

// safevalleyfarm <level>[,<level>...] | safevalleyfarm off    wiki SafeValleyFarming
const safeParser = {
  kind: 'directive', multi: false,
  parse(args) {
    const errs = [];
    const toks = args.flatMap((t) => String(t).split(/[\s,]+/)).filter(Boolean);
    if (toks.length === 1 && /^off$/i.test(toks[0])) return { off: true, levels: [], errors: errs };
    const levels = [];
    for (const t of toks) {
      if (!/^([1-9]|10)$/.test(t)) { errs.push(`"${t}" is not a valley level 1 to 10`); continue; }
      if (!levels.includes(Number(t))) levels.push(Number(t));
    }
    if (!toks.length) errs.push('needs the valley levels to farm, e.g. safevalleyfarm 9,10 (or safevalleyfarm off)');
    return { off: false, levels: levels.sort((a, b) => a - b), errors: errs };
  },
};
parsers.safevalleyfarm = safeParser;
parsers.safevalleyfarming = safeParser;       // the page's own name, read the same

// huntingpos x,y       wiki HuntingPos: medal hunt only at these coordinates
parsers.huntingpos = {
  kind: 'directive', multi: false,
  parse(args) {
    const errs = [];
    const toks = args.flatMap((t) => String(t).split(/\s+/)).filter(Boolean);
    if (toks.length !== 1) { errs.push('needs one coordinate, e.g. huntingpos 111,222'); return { coord: null, errors: errs }; }
    const coord = NI.parseCoord(toks[0], errs);
    if (coord && (coord.x >= C.MAP_W || coord.y >= C.MAP_W)) { errs.push(`${toks[0]} is off the map (coordinates run 0-${C.MAP_W - 1})`); return { coord: null, errors: errs }; }
    return { coord, errors: errs };
  },
};

// huntingtype <type>   wiki HuntingType: forest, hill, desert, lake, swamp, grassland or flat
parsers.huntingtype = {
  kind: 'directive', multi: false,
  parse(args) {
    const errs = [];
    const t = args.length === 1 ? typeOfWord(args[0]) : null;
    if (!t) errs.push('needs one valley type: forest, hill, desert, lake, swamp, grassland or flat');
    return { kind: t, errors: errs };
  },
};

// goals.js merges these into its CONFIG_KEYS (they are NEAT's, so already there)
const configKeys = Object.keys(CONFIG_RULES);

// ------------------------------------------------------------ goal plumbing

const goalsNamed = (ctx, ...names) => (ctx.goals || []).filter((g) => names.includes(g.name));
const lastGoal = (ctx, ...names) => goalsNamed(ctx, ...names).slice(-1)[0] || null;
const nowOf = (ctx) => n(ctx && ctx.now) || Date.now();
const safeGoal = (ctx) => { const g = lastGoal(ctx, 'safevalleyfarm', 'safevalleyfarming'); return g && !g.off && g.levels && g.levels.length ? g : null; };
const milesGoal = (ctx) => { const g = lastGoal(ctx, 'valleyfarming'); return g && g.miles ? g : null; };
const huntingOn = (cfg) => lv((cfg || {}).hunting) > 0 && !configProblems(cfg, ['hunting']).length;

function homeOf(game, castle) {
  return (game && game.castleXY && castle && game.castleXY(castle))
    || (castle && castle.fieldId !== undefined ? C.fieldIdToCoords(Number(castle.fieldId)) : null);
}

// wiki ExcludeList: nothing is sent to these coordinates — "valley acquisition
// runs, valley farming runs, npc building missions, or flat acquisition runs".
function excludedIds(ctx) {
  return new Set(goalsNamed(ctx, 'excludelist').flatMap((g) => (g.coords || []).map((c) => C.coordsToFieldId(c.x, c.y))));
}

// The city's main resource, from its resource fields (wiki City resourceFieldType).
function cityResource(castle) {
  if (!castle || !Array.isArray(castle.buildings)) return null;
  const sum = { wood: 0, iron: 0, stone: 0, food: 0 };
  for (const b of castle.buildings) {
    const r = RESOURCE_OF_FIELD[Number(b.typeId)];
    if (r && !(n(b.status) === 0 && n(b.level) === 0)) sum[r] += n(b.level);
  }
  // a tie goes the way the wiki lists them: lumber, iron, stone, food
  const best = Object.keys(sum).reduce((a, b) => (sum[b] > sum[a] ? b : a), 'wood');
  if (!sum[best]) return null;
  return { resource: best, kind: VALLEY_FOR[best], why: `${RESOURCE_WORD[best]} fields ${sum[best]} levels`, levels: sum };
}

// Field slots: the Town Hall's level (see the header). null when unknown.
function fieldCap(castle) {
  if (!castle || !Array.isArray(castle.buildings)) return null;
  const th = castle.buildings.filter((b) => Number(b.typeId) === C.TOWN_HALL && !(n(b.status) === 0 && n(b.level) === 0));
  return th.length ? Math.min(10, Math.max(...th.map((b) => n(b.level)))) : null;
}

// What this city holds (FieldBean: id, type, level, name).
function heldFields(castle) {
  return ((castle && castle.fields) || []).map((f) => {
    const id = Number(f.id), type = Number(f.type);
    const xy = C.fieldIdToCoords(id);
    return { id, type, kind: KIND_OF_TYPE[type] || 'unknown', level: n(f.level), x: xy.x, y: xy.y };
  });
}

// ----------------------------------------------------------- the map cache

const TILE_KINDS = [...VALLEY_KINDS, 'flat'];
let _tiles = { version: -1, value: null };

// The free valleys and flats the map cache holds, and every such tile by id.
// Only the columns: the table can hold every tile the background scan read.
// `ctx.mapTiles` (a list of tiles) stands in for the database in the tests.
function loadTiles(ctx) {
  if (ctx && Array.isArray(ctx.mapTiles)) return digestTiles(ctx.mapTiles);
  let v;
  try { v = D.mapCache.version(); } catch { v = -2; }
  if (_tiles.version === v && _tiles.value) return _tiles.value;
  let rows = [];
  try {
    rows = D.all(`SELECT id, x, y, kind, level, userName, npc, seen FROM map_cache
      WHERE kind IN ('forest','desert','hill','swamp','grassland','lake','flat')`);
  } catch { rows = []; }
  const value = digestTiles(rows);
  _tiles = { version: v, value };
  return value;
}

function digestTiles(rows) {
  const byId = new Map(), valleys = [], flats = [];
  for (const r of rows || []) {
    const kind = String((r && r.kind) || '');
    if (!TILE_KINDS.includes(kind)) continue;
    const id = Number(r.id);
    if (!Number.isFinite(id)) continue;
    const xy = r.x !== null && r.x !== undefined && r.y !== null && r.y !== undefined ? { x: Number(r.x), y: Number(r.y) } : C.fieldIdToCoords(id);
    const t = {
      id, x: xy.x, y: xy.y, kind, level: Number(r.level),
      owner: r.userName ? String(r.userName) : null, npc: r.npc === true || Number(r.npc) === 1, seen: n(r.seen),
    };
    byId.set(id, t);
    if (t.owner || t.npc) continue;                                             // somebody's: never a target
    if (!Number.isInteger(t.level) || t.level < 1 || t.level > 10) continue;    // no level, no load to size
    (kind === 'flat' ? flats : valleys).push(t);
  }
  return { byId, valleys, flats };
}

// A tile is only as good as its last read: older than FRESH_MS, or read before
// the console last came back from maintenance (every free valley and flat is a
// level up since), and it waits for the map scan.
const freshSince = (ctx) => Math.max(nowOf(ctx) - FRESH_MS, n(ctx.maintEndedAt));

// The tiles a goal may march on: of these kinds and levels, inside `reach`
// (miles by kind), not excluded, not ours, not already marched on. Nearest
// first unless `order` says otherwise. `stale` counts those that only miss a
// fresh read.
function targetsIn(ctx, list, home, { kinds, levels = null, reach, skip = new Set(), minDist = 0 }) {
  const excl = excludedIds(ctx);
  const since = freshSince(ctx);
  const out = [];
  let stale = 0, excluded = 0;
  for (const t of list) {
    if (!kinds.includes(t.kind)) continue;
    if (levels && !levels.includes(t.level)) continue;
    const max = typeof reach === 'number' ? reach : reach[t.kind];
    if (!(max > 0)) continue;
    const dist = C.mapDistance(home, t);
    if (dist <= 0 || dist > max || dist < minDist) continue;
    if (excl.has(t.id)) { excluded++; continue; }
    if (skip.has(t.id)) continue;
    if (t.seen < since) { stale++; continue; }
    out.push({ ...t, dist });
  }
  out.sort((a, b) => a.dist - b.dist || a.id - b.id);
  return { list: out, stale, excluded };
}

// ------------------------------------------------------ marches and slots

// The valley goals' own record of what they sent, per city:
//   state.valley.marches[fieldId] = { kind, purpose, capture, at, level, type, heroId }
// kind is the rallypolicy letter (v valleys, m medal hunting, b npc building and
// flats). The server lists every attack the same way, so this record is how a
// march out on a valley is told from one on a camp.
function vstate(state, now = Date.now()) {
  const st = (state.valley = state.valley || {});
  st.marches = st.marches && typeof st.marches === 'object' ? st.marches : {};
  for (const [id, r] of Object.entries(st.marches)) if (now - n(r && r.at) > MARCH_KEEP_MS) delete st.marches[id];
  st.farmed = st.farmed || {};
  for (const [id, at] of Object.entries(st.farmed)) if (now - n(at) > MARCH_KEEP_MS) delete st.farmed[id];
  return st;
}

function recordMarch(state, fieldId, rec) {
  const st = vstate(state);
  st.marches[fieldId] = { ...rec, at: rec.at || Date.now() };
  return st.marches[fieldId];
}

// Tiles the game turned a march down on, still resting (see BLOCK_MS).
function blockedIds(st, now) {
  const out = new Set();
  for (const [id, b] of Object.entries(st.blocked || {})) {
    if (now - n(b && b.at) < n(b && b.ms)) out.add(Number(id));
    else delete st.blocked[id];
  }
  return out;
}
function noteBlocked(st, fieldId, why, ms) {
  st.blocked = st.blocked || {};
  st.blocked[fieldId] = { at: Date.now(), why, ms };
}

// The rally book for this slice (the engine hands one over; the tests may not).
function bookOf(ctx, castle) {
  if (ctx.rally) return ctx.rally;
  if (!ctx._valleyBook) {
    ctx._valleyBook = R.rallyBook({ game: ctx.game, armies: ctx.selfArmies || null, goalsOf: (c) => (c === castle ? ctx.goals : null) });
  }
  return ctx._valleyBook;
}

// Attacks from this city still heading out to a valley or flat that may take
// it: the ones sent to capture, any other attack on a free field tile (one sent
// by hand may take a slot too), and what was sent moments ago and is not listed
// yet. Farming hits go with the slots full and take nothing.
function capturesOut(list, st, tiles, now) {
  const out = new Set();
  for (const m of list) {
    if (m.missionType !== C.MISSION.attack || m.direction !== 1) continue;
    const rec = st.marches[m.target];
    if (rec) { if (rec.capture) out.add(m.target); continue; }
    if (tiles.byId.has(m.target)) out.add(m.target);
  }
  for (const [id, rec] of Object.entries(st.marches)) {
    if (rec && rec.capture && now - n(rec.at) < PENDING_MS) out.add(Number(id));
  }
  return out;
}

// cap, what is held, the captures on their way, and what is left free.
function slotsOf(ctx, castle, st, tiles) {
  const cap = fieldCap(castle);
  const held = heldFields(castle);
  const flying = capturesOut(bookOf(ctx, castle).marchesFrom(castle), st, tiles, nowOf(ctx));
  for (const h of held) flying.delete(h.id);          // landed and taken
  return { cap, held, flying, free: cap === null ? null : cap - held.length - flying.size };
}

// The same count for an executor, right before it sends: the live army list
// as the console keeps it, and whatever this slice has sent so far.
function slotsNow(game, castle, state, tiles = loadTiles({})) {
  const st = vstate(state);
  const ctx = { game, selfArmies: (game && game.player && game.player.selfArmys) || [], goals: [] };
  return slotsOf(ctx, castle, st, tiles);
}

// Tiles one of our cities is already marching on (going out), the ones we
// hold, and (with this city's valley state) the ones the game turned down lately.
function busyTargets(ctx, castle, st = null) {
  const out = st ? blockedIds(st, nowOf(ctx)) : new Set();
  const book = bookOf(ctx, castle);
  const game = ctx.game;
  const cities = (game && game.castles && game.castles.length ? game.castles : [castle]);
  for (const c of cities) {
    for (const m of book.marchesFrom(c)) if (m.direction === 1 && (m.missionType === C.MISSION.attack || m.missionType === C.MISSION.scout)) out.add(m.target);
    for (const f of heldFields(c)) out.add(f.id);
  }
  return out;
}

// How many more marches of this rallypolicy kind may start: the rally spot and
// max: through the rally book, and the kind's own cap counted here, since the
// server lists a valley attack just like an npc one (rally.js kindOf).
function rallyFor(ctx, castle, kind, st) {
  const book = bookOf(ctx, castle);
  const base = book.room(castle, kind);
  const cap = book.policy(castle).caps[kind];
  if (cap === undefined) return base;
  const out = book.marchesFrom(castle).filter((m) => m.kind === kind || (!m.kind && st.marches[m.target] && st.marches[m.target].kind === kind)).length;
  const left = cap - out;
  return left < base.room ? { room: Math.max(0, left), why: `rallypolicy ${kind}:${cap} (${out} ${R.KIND_NAME[kind] || kind} out)` } : base;
}

// wiki NpcTeams: "This will count npc farmers, valley farmers, valley
// acquisition, etc., teams" — every attack out of the city.
function teamsFull(ctx, castle) {
  const cap = NI.teamCapFor(ctx);
  const out = bookOf(ctx, castle).marchesFrom(castle).filter((m) => m.missionType === C.MISSION.attack).length;
  return out >= cap.teams ? `${out}/${cap.teams} teams out (${cap.why})` : null;
}

// Troops at home, less what left this slice and is not counted off yet.
function homeTroops(ctx, castle) {
  const sent = bookOf(ctx, castle).committed(castle).troops;
  const out = {};
  for (const [k, v] of Object.entries((castle && castle.troop) || {})) out[k] = Math.max(0, n(v) - n(sent[k]));
  return out;
}

const troopName = (k) => (C.BY_KEY[k] ? C.BY_KEY[k].name : k);
const troopText = (troops) => Object.entries(troops).filter(([, v]) => n(v) > 0).map(([k, v]) => `${fmt(v)} ${troopName(k)}`).join(' + ');

// wiki ValleyLimit: the troops that must be in the city before a valley attack leaves.
function limitShort(ctx, avail) {
  const g = lastGoal(ctx, 'valleylimit');
  if (!g || !g.troops) return null;
  const low = Object.entries(g.troops).find(([k, v]) => n(avail[k]) < n(v));
  return low ? `valleylimit: ${fmt(avail[low[0]])} ${troopName(low[0])} at home, needs ${fmt(low[1])} before a valley attack leaves` : null;
}

// The troops for one tile (wiki ValleyTroops): the most specific line wins —
// level and type, then type alone, then level alone, then a line with neither
// — and a later line wins a tie; otherwise the goal's own wiki default.
function troopsFor(ctx, level, kind, table) {
  const lines = goalsNamed(ctx, 'valleytroops').filter((g) => g.troops && Object.keys(g.troops).length);
  const rank = (g) => (g.level === level && g.type === kind ? 4 : g.level == null && g.type === kind ? 3
    : g.level === level && g.type == null ? 2 : g.level == null && g.type == null ? 1 : 0);
  let best = null, top = 0;
  for (const g of lines) { const r = rank(g); if (r > 0 && r >= top) { best = g; top = r; } }
  if (best) return { troops: { ...best.troops }, why: `valleytroops${best.level != null ? ` ${best.level}` : ''}${best.type ? ` /type:${best.type}` : ''}` };
  const t = table[level];
  return t ? { troops: { ...t }, why: 'the wiki\'s default' } : null;
}

// wiki ValleyHeroes: the lines OR'd; /reset forgets those above it. A line that
// does not read holds every valley march rather than let any hero go.
function heroSpec(ctx) {
  const rules = [];
  for (const g of goalsNamed(ctx, 'valleyheroes')) {
    if (g.reset) { rules.length = 0; continue; }
    if (!g.spec || (g.spec.errors && g.spec.errors.length)) return { spec: null, error: `valleyheroes on line ${g.line} does not read, so no hero is sent` };
    rules.push(g.spec.src);
  }
  return { spec: rules.length ? rules.join('|') : 'any', error: null };
}

// The hero for one march: idle, allowed by valleyheroes, strongest attack first;
// never keepatthome's defender, and homeheroes N leaves N of them home.
function pickHero(ctx, castle, st, busy = new Set()) {
  const hs = heroSpec(ctx);
  if (hs.error) return { hero: null, why: hs.error };
  const now = nowOf(ctx);
  const recent = new Set(Object.values(st.marches).filter((r) => r && r.heroId != null && now - n(r.at) < HERO_PUSH_MS).map((r) => r.heroId));
  const idle = ((castle && castle.heros) || []).filter((h) => (h.status === 0 || h.status === undefined) && !busy.has(h.id) && !recent.has(h.id));
  if (!idle.length) return { hero: null, why: 'no idle hero' };
  const allowed = NI.heroCandidates(idle, hs.spec, castle.heros);
  const keepHome = H.farmableHeroes({ ...ctx, castle }).keepHome;
  if (keepHome && allowed.length && allowed.length <= keepHome) {
    return { hero: null, why: `homeheroes ${keepHome}: ${allowed.map((h) => h.name).join(', ')} stay${allowed.length === 1 ? 's' : ''} home` };
  }
  const kept = W.keepAttHome({ ...ctx, castle }).reservedIds;
  const hero = allowed.find((h) => !kept.has(h.id));
  if (!hero) {
    return { hero: null, why: allowed.length ? `${allowed[0].name} is the only idle hero for "${hs.spec}" and keepatthome keeps it home` : `no idle hero matches valleyheroes "${hs.spec}"` };
  }
  return { hero, why: null };
}

// Marching food, the way the client charges it (constants.marchFood): the city
// must have it, and the army carries it in its own hold. `keep` is the day of
// the troops' upkeep the troop and wall goals keep in the granary (ctx.foodDay,
// Engine.focus; wiki TroopsUseReserved): a valley march leaves it there too.
function marchOf(game, home, target, troops, castle, keep = 0) {
  const keys = Object.keys(troops).filter((k) => n(troops[k]) > 0);
  const oneWayMs = n(C.marchTimeMs(home, target, keys, n(game && game.marchSkillParam) || 100));
  const food = C.marchFood(troops, oneWayMs);
  const hold = NI.capacityOf(troops, n(game && game.loadSkillParam) || 100);
  const have = n(castle && castle.resource && castle.resource.food && castle.resource.food.amount);
  if (food > have - n(keep)) {
    return { ok: false, why: `the march needs ${fmt(food)} food and the city has ${fmt(have)}${n(keep) ? `, keeping ${fmt(keep)} for a day of its troops' upkeep` : ''}` };
  }
  if (food > hold) return { ok: false, why: `the march eats ${fmt(food)} food, more than the troops can carry (${fmt(hold)})` };
  return { ok: true, oneWayMs, food };
}

// What stops every valley march out of this city: War Town (wiki WarTown: its
// lockdown holds npc and valley attacks) and, OUR CHOICE, a real attack on its
// way in or just landed (goal-war underAttack).
function holdAll(ctx, state) {
  const war = W.lockdown(ctx);
  if (war.on) return war.why;
  const ua = W.underAttack(ctx, state || {});
  if (ua.on) return `the city is under attack${ua.inbound ? ` (${ua.inbound} wave(s) inbound)` : ''} — no valley march leaves until it is over`;
  return null;
}

const where = (t) => `${t.x},${t.y}`;
const kindWord = (k) => (k === 'flat' ? 'flat' : k);

// One attack on a tile, checked end to end, or why it cannot go now.
//   purpose    capture | farm | hunt | flat | build | safe
//   capture    it is meant to take the tile (needs a free slot when it lands)
//   needFull   it must NOT take the tile (every slot full when it leaves)
//   rallyKind  v, m or b
//   troops     a fixed load (safe farming), else valleytroops / the table
function planAttack({ ctx, state, game, castle, home, st, target, purpose, capture = false, needFull = false,
  rallyKind, table, troops = null, release = null, reserve = 0, busyHeroes = new Set(), tag = '' }) {
  // processingpolicy: this march's task turned off (processing.js) sends none
  const pp = TASK_OF[purpose] ? PROC.allowed(ctx, TASK_OF[purpose]) : null;
  if (pp && !pp.on) return { why: pp.why };
  const load = troops ? { troops, why: 'the wiki\'s safe load' } : troopsFor(ctx, target.level, target.kind, table);
  if (!load) return { why: `no troop load for a level ${target.level} ${kindWord(target.kind)}` };
  const avail = homeTroops(ctx, castle);
  const limit = limitShort(ctx, avail);
  if (limit) return { why: limit };
  const short = Object.entries(load.troops).find(([k, v]) => n(avail[k]) < n(v));
  if (short) return { why: `short of ${troopName(short[0])} for ${load.why} (need ${fmt(short[1])}, have ${fmt(avail[short[0]])})` };
  const rally = rallyFor(ctx, castle, rallyKind, st);
  if (rally.room <= 0) return { why: `no rally slot — ${rally.why}` };
  const teams = teamsFull(ctx, castle);
  if (teams) return { why: teams };
  const pick = pickHero(ctx, castle, st, busyHeroes);
  if (!pick.hero) return { why: pick.why };
  const march = marchOf(game, home, target, load.troops, castle, ctx.foodDay);
  if (!march.ok) return { why: march.why };
  const hero = pick.hero;
  const dist = Math.round(n(target.dist) * 10) / 10;
  const verb = { capture: 'capture', flat: 'capture', build: 'capture', hunt: 'hunt medals at', farm: 'farm', safe: 'safe-farm' }[purpose] || purpose;
  const action = {
    kind: 'valleyAttack', purpose, capture, needFull,
    fieldId: target.id, target: { x: target.x, y: target.y }, level: target.level, type: target.kind,
    heroId: hero.id, hero: hero.name, troops: load.troops, oneWayMs: march.oneWayMs, distance: dist,
    rallyKind, reserve,
    ...(release ? { release: { fieldId: release.id, level: release.level, type: release.kind, x: release.x, y: release.y } } : {}),
    label: `${tag}${verb} L${target.level} ${kindWord(target.kind)} at ${where(target)} (${dist} tiles, ${NI.hms(march.oneWayMs)} out) `
      + `with ${hero.name} atk ${n(hero.power)} — ${troopText(load.troops)} (${load.why})`
      + (release ? `; then let go of the L${release.level} ${release.kind} at ${where(release)}` : ''),
  };
  Object.defineProperty(action, 'state', { value: state, enumerable: false });
  Object.defineProperty(action, 'rally', {
    value: { from: castle, kind: rallyKind, missionType: C.MISSION.attack, targetFieldId: target.id, troops: load.troops },
    enumerable: false,
  });
  return { action };
}

// The lowest valley held (never a flat): the one the wiki lets go for a better
// one. On a tie, one not of the wanted type goes first, then the farthest.
function worstValley(held, wantKind, home, keep = new Set()) {
  return held.filter((f) => VALLEY_KINDS.includes(f.kind) && !keep.has(f.id))
    .sort((a, b) => a.level - b.level || ((a.kind === wantKind) - (b.kind === wantKind))
      || C.mapDistance(home, b) - C.mapDistance(home, a) || a.id - b.id)[0] || null;
}

const levelsText = (levels) => (levels.length === 1 ? `L${levels[0]}` : `L${levels[levels.length - 1]}-${levels[0]}`);

// ============================================================ config valley

function valleyPlan(ctx, state, game) {
  const cfg = ctx.config || {};
  if (!isSet(cfg.valley) && !isSet(cfg.valleymin)) return null;
  const bad = configProblems(cfg, ['valley', 'valleymin']);
  if (bad.length) return { note: `valley — held: ${bad.join('; ')}`, actions: [] };
  const top = lv(cfg.valley);
  const min = lv(cfg.valleymin) || null;
  if (!top) return min ? { note: `valleymin:${min} — it needs config valley:<level> as the highest level to capture (wiki ValleyMin)`, actions: [] } : null;
  if (min && min > top) return { note: `valley:${top} — held: config valleymin:${min} is above config valley:${top} (valley is the highest level, valleymin the lowest)`, actions: [] };
  // wiki Valley and ValleyMin: valley alone is the level to capture; with
  // valleymin it is the highest, and the lower ones fill the slots down to valleymin
  const levels = [];
  for (let l = top; l >= (min || top); l--) levels.push(l);
  const head = `valley:${top}${min ? ` valleymin:${min}` : ''}`;
  const held = (why) => ({ note: `${head} — ${why}`, actions: [] });

  const castle = ctx.castle || {};
  const st = vstate(state, nowOf(ctx));
  const hold = holdAll(ctx, state);
  if (hold) return held(`held: ${hold}`);
  const home = homeOf(game, castle);
  if (!home) return held('this city has no map position');
  const want = cityResource(castle);
  if (!want) return held('no resource fields yet to choose a valley type from (wiki Valley: forests for lumber, hills for iron, deserts for stone, lakes for food)');
  const tiles = loadTiles(ctx);
  const slots = slotsOf(ctx, castle, st, tiles);
  if (slots.cap === null) return held('the Town Hall level is not known, so neither are the valley slots');
  const reserve = huntingOn(cfg) ? 1 : 0;           // config hunting keeps a slot to hunt with
  const dp = NI.dpFor(ctx);
  const radius = Math.min(dp.acquire ?? DEFAULT_RADIUS, MAX_DISTANCE);
  const pool = targetsIn(ctx, tiles.valleys, home, { kinds: [want.kind], levels, reach: radius, skip: busyTargets(ctx, castle, st) });
  pool.list.sort((a, b) => b.level - a.level || a.dist - b.dist || a.id - b.id);   // highest first (wiki ValleyMin)

  const notes = [
    `${want.kind}s for ${RESOURCE_WORD[want.resource]} (${want.why}), ${levelsText(levels)} within ${radius} tiles${dp.acquire != null ? ' (distancepolicy)' : ''}`,
    `${slots.held.length}/${slots.cap} slots held${slots.flying.size ? `, ${slots.flying.size} capture(s) on the way` : ''}${reserve ? ', one kept for hunting' : ''}`,
    `${pool.list.length} free in range${pool.stale ? `, ${pool.stale} waiting for a fresh map read` : ''}`,
  ];
  let target = null, release = null;
  const free = slots.free - reserve;
  if (free > 0) {
    target = pool.list[0] || null;
    if (!target) return { note: [`${head} — nothing to capture: no free ${levelsText(levels)} ${want.kind} in range`, ...notes.slice(1)].join(' | '), actions: [] };
  } else {
    // wiki Valley/ValleyMin: "any time a valley becomes available of a higher
    // level (up to this maximum), the bot will drop the lowest level valley to
    // upgrade to the higher one" — only with valleymin, one swap at a time
    if (!min) return { note: [`${head} — every slot is taken`, ...notes.slice(1)].join(' | '), actions: [] };
    if (slots.flying.size) return { note: [`${head} — a capture is on its way; the next swap waits for it`, ...notes.slice(1)].join(' | '), actions: [] };
    const keep = new Set(st.hunt && st.hunt.target ? [st.hunt.target] : []);
    const worst = worstValley(slots.held, want.kind, home, keep);
    const best = pool.list[0];
    if (!best || !worst || best.level <= worst.level) {
      return { note: [`${head} — slots full${worst ? `, lowest held L${worst.level}` : ''}; no better ${want.kind} in range to swap for`, ...notes.slice(1)].join(' | '), actions: [] };
    }
    target = best;
    release = worst;
  }
  const r = planAttack({ ctx, state, game, castle, home, st, target, purpose: 'capture', capture: true, rallyKind: 'v', table: CAPTURE_TROOPS, release, reserve });
  if (!r.action) return { note: [`${head} — waiting to capture L${target.level} ${target.kind} at ${where(target)}: ${r.why}`, ...notes].join(' | '), actions: [] };
  return { note: [`${head} — ${r.action.label}`, ...notes].join(' | '), actions: [r.action] };
}

// ==================================================== config valleyfarming

// Miles per valley type: the valleyfarming line, or the city's own type within
// distancepolicy's third number (wiki ValleyFarming).
function farmReach(ctx, castle, allKinds = false) {
  const g = milesGoal(ctx);
  if (g) return { reach: { ...g.miles }, why: 'the valleyfarming miles' };
  const dp = NI.dpFor(ctx);
  const r = Math.min(dp.valley ?? DEFAULT_RADIUS, MAX_DISTANCE);
  if (allKinds) return { reach: Object.fromEntries(VALLEY_KINDS.map((k) => [k, r])), why: `every valley type within ${r} tiles${dp.valley != null ? ' (distancepolicy)' : ''}` };
  const want = cityResource(castle);
  if (!want) return { reach: null, why: 'no resource fields to choose a valley type from, and no valleyfarming miles line' };
  return { reach: { [want.kind]: r }, why: `${want.kind}s (the city's ${RESOURCE_WORD[want.resource]}) within ${r} tiles${dp.valley != null ? ' (distancepolicy)' : ''}` };
}

// Every slot taken: an attack that wins then takes nothing, only the loot
// (wiki SafeValleyFarming "You do not want to capture valleys"; LumberFarming
// "Must have full valley slots").
function slotsFull(slots) {
  return slots.cap !== null && slots.held.length >= slots.cap;
}

function valleyFarmingPlan(ctx, state, game) {
  const cfg = ctx.config || {};
  if (!isSet(cfg.valleyfarming)) {
    if (milesGoal(ctx) && !safeGoal(ctx)) return { note: 'valleyfarming miles — they apply once config valleyfarming:<level> (or safevalleyfarm) is set', actions: [] };
    return null;
  }
  const bad = configProblems(cfg, ['valleyfarming']);
  if (bad.length) return { note: `valleyfarming — held: ${bad.join('; ')}`, actions: [] };
  const level = lv(cfg.valleyfarming);
  if (!level) return null;
  const head = `valleyfarming:${level}`;
  const held = (why) => ({ note: `${head} — ${why}`, actions: [] });
  const castle = ctx.castle || {};
  const now = nowOf(ctx);
  const st = vstate(state, now);
  const hold = holdAll(ctx, state);
  if (hold) return held(`held: ${hold}`);
  const home = homeOf(game, castle);
  if (!home) return held('this city has no map position');
  const tiles = loadTiles(ctx);
  const slots = slotsOf(ctx, castle, st, tiles);
  if (slots.cap === null) return held('the Town Hall level is not known, so neither are the valley slots');
  if (!slotsFull(slots)) {
    return held(`held: ${slots.held.length}/${slots.cap} valley slots taken — a win with a slot free would capture the valley, so fill the slots first (wiki SafeValleyFarming)`);
  }
  const fr = farmReach(ctx, castle);
  if (!fr.reach) return held(fr.why);
  const kinds = Object.keys(fr.reach).filter((k) => fr.reach[k] > 0);
  if (!kinds.length) return held('the valleyfarming miles leave every type out');
  const pool = targetsIn(ctx, tiles.valleys, home, { kinds, levels: [level], reach: fr.reach, skip: busyTargets(ctx, castle, st) });
  const since = (t) => now - n(st.farmed[t.id]);
  const due = pool.list.filter((t) => since(t) >= FARM_GAP_MS);
  const notes = [`L${level} ${fr.why}`, `${pool.list.length} in range${pool.stale ? `, ${pool.stale} waiting for a fresh map read` : ''}`];
  if (!due.length) {
    const waits = pool.list.map((t) => FARM_GAP_MS - since(t)).filter((x) => x > 0);
    return { note: [`${head} — nothing due${waits.length ? `, next in ${NI.hms(Math.min(...waits))}` : ''}`, ...notes].join(' | '), actions: [] };
  }
  const target = due[0];
  const r = planAttack({ ctx, state, game, castle, home, st, target, purpose: 'farm', needFull: true, rallyKind: 'v', table: FARM_TROOPS });
  if (!r.action) return { note: [`${head} — waiting to farm ${where(target)}: ${r.why}`, ...notes].join(' | '), actions: [] };
  return { note: [`${head} — ${r.action.label}`, ...notes].join(' | '), actions: [r.action] };
}

// ================================================ safevalleyfarm (NEAT's own)

// wiki SafeValleyFarming: "On every reconnection, safe farming is returned to a
// clear state and scouting restarts with a fresh list of valleys", and a change
// of levels resets the list. A new login is a new Game, so the list lives with
// the Game it was made under.
const SAFE_MEMORY = new WeakMap();
function safeMemory(game, castle, levels) {
  const key = String(game && game.castleId ? game.castleId(castle) : castle.castleId);
  const holder = game && typeof game === 'object' ? game : safeMemory;
  let m = SAFE_MEMORY.get(holder);
  if (!m) SAFE_MEMORY.set(holder, (m = new Map()));
  const sig = levels.join(',');
  let mem = m.get(key);
  if (!mem || mem.sig !== sig) { mem = { sig, valleys: {}, readAt: 0 }; m.set(key, mem); }
  return mem;
}

// wiki SafeValleyFarming's three rules, on what the scouts saw (troop key -> count):
//   only archers                        1 scout + as many cavalry as archers
//   no cavalry and no archers           archers by the valley's level
//   cavalry, no archers, up to 2 layers those archers + 1 ballista, 1 pike, 1 sword
// A "layer" is read as any other troop type there. Anything else is not safe.
function safeLoad(level, garrison) {
  if (!garrison) return null;
  const a = n(garrison.archer), c = n(garrison.lightCavalry);
  const others = Object.entries(garrison).filter(([k, v]) => n(v) > 0 && k !== 'archer' && k !== 'lightCavalry');
  if (a > 0 && c === 0 && !others.length) return { troops: { scouter: 1, lightCavalry: a }, rule: 'only archers there' };
  if (a === 0 && c === 0) return { troops: { archer: SAFE_ARCHERS[level] }, rule: 'no cavalry and no archers there' };
  if (a === 0 && c > 0 && others.length <= 2) {
    return { troops: { archer: SAFE_ARCHERS[level], ballista: 1, pikemen: 1, swordsmen: 1 }, rule: `cavalry and ${others.length} layer(s), no archers` };
  }
  return null;
}

const TROOP_BY_TYPE = Object.fromEntries(C.TROOPS.map((t) => [t.typeId, t.key]));
const listOf = (v) => (v === null || v === undefined || v === '' ? [] : Array.isArray(v) ? v : [v]);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A report's XML (report.markAsRead's `content`) as safe farming needs it:
//   { scout: false }                                     not a scout report
//   { scout: true, success: false, why }                  the scouts did not get back
//   { scout: true, success: true, garrison | null, why }  what they saw (null: unreadable)
// The troops are ScoutInfo's <troops><troopStrType typeId count/> (mailbox.js
// scout()); a count that is not a plain number means the garrison is unknown.
function readScout(content) {
  let root = null;
  try { root = MB.parseXml(String(content == null ? '' : content)); } catch { root = null; }
  const data = isObj(root) && isObj(root.reportData) ? root.reportData : null;
  if (!data || !Object.prototype.hasOwnProperty.call(data, 'scoutReport')) return { scout: false };
  const o = isObj(data.scoutReport) ? data.scoutReport : {};
  const ok = o.isSuccess === true || String(o.isSuccess).toLowerCase() === 'true';
  if (!ok) return { scout: true, success: false, why: 'the scouts did not get through' };
  const info = isObj(o.scoutInfo) ? o.scoutInfo : null;
  if (!info || !Object.prototype.hasOwnProperty.call(info, 'troops')) return { scout: true, success: true, garrison: null, why: 'the report shows no troop list (Informatics too low?)' };
  const garrison = {};
  for (const u of listOf(isObj(info.troops) ? info.troops.troopStrType : null)) {
    if (!isObj(u)) continue;
    const key = TROOP_BY_TYPE[Number(u.typeId)];
    const count = typeof u.count === 'number' ? u.count : /^\d+$/.test(String(u.count == null ? '' : u.count).trim()) ? Number(u.count) : null;
    if (!key || count === null) return { scout: true, success: true, garrison: null, why: `the count "${u.count}" for troop type ${u.typeId} is not a number` };
    garrison[key] = n(garrison[key]) + count;
  }
  return { scout: true, success: true, garrison, why: null };
}

function safeFarmPlan(ctx, state, game) {
  const g = safeGoal(ctx);
  if (!g) return null;
  const cfg = ctx.config || {};
  const head = `safevalleyfarm ${g.levels.join(',')}`;
  const held = (why) => ({ note: `${head} — ${why}`, actions: [] });
  // wiki: "Safe valley farming cannot be used at the same time as config hunting
  // and will not perform any operations"
  if (huntingOn(cfg)) return held('does nothing while config hunting is on (wiki SafeValleyFarming)');
  const castle = ctx.castle || {};
  const now = nowOf(ctx);
  const st = vstate(state, now);
  const hold = holdAll(ctx, state);
  if (hold) return held(`held: ${hold}`);
  const home = homeOf(game, castle);
  if (!home) return held('this city has no map position');
  const tiles = loadTiles(ctx);
  const slots = slotsOf(ctx, castle, st, tiles);
  if (slots.cap === null) return held('the Town Hall level is not known, so neither are the valley slots');
  if (!slotsFull(slots)) return held(`held: ${slots.held.length}/${slots.cap} valley slots taken — fill them first; safe farming must never capture (wiki SafeValleyFarming)`);
  const fr = farmReach(ctx, castle, true);
  const kinds = Object.keys(fr.reach).filter((k) => fr.reach[k] > 0);
  const busy = busyTargets(ctx, castle, st);
  const pool = targetsIn(ctx, tiles.valleys, home, { kinds, levels: g.levels, reach: fr.reach });
  const mem = safeMemory(game, castle, g.levels);
  const V = mem.valleys;
  const notes = [`${fr.why}`, `${pool.list.length} valley(s) in range${pool.stale ? `, ${pool.stale} waiting for a fresh map read` : ''}`];

  const stats = { safe: 0, unsafe: 0, scouting: 0 };
  for (const v of Object.values(V)) { if (v.stage === 'safe') stats.safe++; else if (v.stage === 'scouting') stats.scouting++; else stats.unsafe++; }
  notes.push(`${stats.safe} safe, ${stats.unsafe} not, ${stats.scouting} being scouted`);
  const actions = [];

  // 1. a safe valley that is due: hit it (at most once an hour)
  const inRange = new Map(pool.list.map((t) => [t.id, t]));
  const due = Object.entries(V).filter(([id, v]) => v.stage === 'safe' && inRange.has(Number(id)) && !busy.has(Number(id))
    && now - n(st.farmed[id]) >= FARM_GAP_MS).map(([id, v]) => ({ t: inRange.get(Number(id)), v }))
    .sort((a, b) => a.t.dist - b.t.dist);
  if (due.length) {
    const { t, v } = due[0];
    const r = planAttack({ ctx, state, game, castle, home, st, target: t, purpose: 'safe', needFull: true, rallyKind: 'v', troops: v.troops, tag: `(${v.rule}) ` });
    if (r.action) actions.push(r.action);
    else notes.unshift(`waiting to farm ${where(t)}: ${r.why}`);
  }

  // 2. scouts that are home (or should be): read what they found — alongside
  // a hit, as it sends nothing
  const outbound = new Set(bookOf(ctx, castle).marchesFrom(castle).filter((m) => m.direction === 1).map((m) => m.target));
  const pending = Object.entries(V).filter(([id, v]) => v.stage === 'scouting' && !outbound.has(Number(id)))
    .map(([id, v]) => ({ fieldId: Number(id), x: v.x, y: v.y, sentAt: v.sentAt, level: v.level }));
  if (pending.length && now - n(mem.readAt) >= REPORT_READ_GAP_MS) {
    const action = { kind: 'scoutReports', pending, label: `read the scout report(s) for ${pending.map((p) => `${p.x},${p.y}`).join(' ')}` };
    Object.defineProperty(action, 'memory', { value: mem, enumerable: false });
    actions.push(action);
  }
  if (actions.length) return { note: [`${head} — ${actions.map((a) => a.label).join('; ')}`, ...notes].join(' | '), actions };

  // 3. scout the nearest valley not scouted yet (no hero goes with scouts)
  const fresh = pool.list.find((t) => !V[t.id] && !busy.has(t.id));
  if (!fresh) return { note: [`${head} — ${due.length ? 'waiting' : stats.scouting ? 'waiting for the scouts' : 'every valley in range is scouted'}`, ...notes].join(' | '), actions: [] };
  const troops = { scouter: SAFE_SCOUTS(fresh.level) };
  const pp = PROC.allowed(ctx, 's');
  if (!pp.on) return { note: [`${head} — waiting to scout ${where(fresh)}: ${pp.why}`, ...notes].join(' | '), actions: [] };
  const avail = homeTroops(ctx, castle);
  if (n(avail.scouter) < troops.scouter) return { note: [`${head} — waiting to scout ${where(fresh)}: short of scouts (need ${fmt(troops.scouter)}, have ${fmt(avail.scouter)})`, ...notes].join(' | '), actions: [] };
  const rally = rallyFor(ctx, castle, 'v', st);
  if (rally.room <= 0) return { note: [`${head} — waiting to scout ${where(fresh)}: no rally slot — ${rally.why}`, ...notes].join(' | '), actions: [] };
  const march = marchOf(game, home, fresh, troops, castle, ctx.foodDay);
  if (!march.ok) return { note: [`${head} — waiting to scout ${where(fresh)}: ${march.why}`, ...notes].join(' | '), actions: [] };
  const action = {
    kind: 'valleyScout', fieldId: fresh.id, target: { x: fresh.x, y: fresh.y }, level: fresh.level, type: fresh.kind, troops,
    label: `scout L${fresh.level} ${fresh.kind} at ${where(fresh)} (${Math.round(fresh.dist * 10) / 10} tiles) with ${fmt(troops.scouter)} scouts`,
  };
  Object.defineProperty(action, 'memory', { value: mem, enumerable: false });
  Object.defineProperty(action, 'state', { value: state, enumerable: false });
  Object.defineProperty(action, 'rally', { value: { from: castle, kind: 'v', missionType: C.MISSION.scout, targetFieldId: fresh.id, troops }, enumerable: false });
  return { note: [`${head} — ${action.label}`, ...notes].join(' | '), actions: [action] };
}

// ============================================================ config hunting

function huntingPlan(ctx, state, game) {
  const cfg = ctx.config || {};
  if (!isSet(cfg.hunting)) {
    const stray = lastGoal(ctx, 'huntingpos', 'huntingtype');
    return stray ? { note: `${stray.name} — it steers config hunting, which is not on`, actions: [] } : null;
  }
  const bad = configProblems(cfg, ['hunting']);
  if (bad.length) return { note: `hunting — held: ${bad.join('; ')}`, actions: [] };
  const code = lv(cfg.hunting);
  if (!code) return null;
  const levels = HUNT_LEVELS[code];
  const pos = lastGoal(ctx, 'huntingpos');
  const typ = lastGoal(ctx, 'huntingtype');
  const head = `hunting:${code} (${levelsText(levels.slice().reverse())})`;
  const held = (why) => ({ note: `${head} — ${why}`, actions: [] });
  const castle = ctx.castle || {};
  const now = nowOf(ctx);
  const st = vstate(state, now);
  const hunt = (st.hunt = st.hunt || {});
  const home = homeOf(game, castle);
  if (!home) return held('this city has no map position');
  const tiles = loadTiles(ctx);
  const slots = slotsOf(ctx, castle, st, tiles);

  // 1. catch and release (wiki Hunting): a valley a hunting wave took is let go
  // at once, so the next wave meets its troops again. Only one this goal
  // attacked, and still ours.
  const caught = slots.held.filter((f) => st.marches[f.id] && st.marches[f.id].purpose === 'hunt' && VALLEY_KINDS.concat('flat').includes(f.kind));
  if (caught.length) {
    const action = {
      kind: 'releaseFields', purpose: 'hunt',
      fields: caught.map((f) => ({ fieldId: f.id, level: f.level, type: f.kind, x: f.x, y: f.y, why: 'caught by a hunting wave' })),
      label: `let go of ${caught.map((f) => `the L${f.level} ${f.kind} at ${where(f)}`).join(', ')} (caught by a hunting wave, released for the next one)`,
    };
    Object.defineProperty(action, 'state', { value: state, enumerable: false });
    return { note: `${head} — ${action.label}`, actions: [action] };
  }

  const hold = holdAll(ctx, state);
  if (hold) return held(`held: ${hold}`);
  if (slots.cap === null) return held('the Town Hall level is not known, so neither are the valley slots');

  // 2. the valley to hunt at: huntingpos, else the one already hunted while it
  // still fits, else the nearest of the right level (and huntingtype's kind)
  const dp = NI.dpFor(ctx);
  const radius = Math.min(dp.valley ?? DEFAULT_RADIUS, MAX_DISTANCE);
  const kinds = typ && typ.kind ? [typ.kind] : VALLEY_KINDS;
  const ours = new Set();
  for (const c of (game && game.castles) || [castle]) for (const f of heldFields(c)) ours.add(f.id);
  const blocked = blockedIds(st, now);
  let target = null;
  if (pos && pos.coord) {
    const id = C.coordsToFieldId(pos.coord.x, pos.coord.y);
    const at = `huntingpos ${pos.coord.x},${pos.coord.y}`;
    if (ours.has(id)) return held(`${at} is one of our own fields; hunting there needs it let go first — do that by hand`);
    if (blocked.has(id)) return held(`${at}: ${st.blocked[id].why} — asked again in ${NI.hms(n(st.blocked[id].ms) - (now - n(st.blocked[id].at)))}`);
    const t = tiles.byId.get(id);
    if (!t || t.owner || t.npc) return held(`${at} is not a free valley in the map cache — nothing is sent there`);
    if (!Number.isInteger(t.level) || t.level < 1) return held(`${at}: its level is not known`);
    if (t.seen < freshSince(ctx)) return held(`${at} waits for a fresh map read`);
    if (excludedIds(ctx).has(id)) return held(`${at} is on the excludelist`);
    target = { ...t, dist: C.mapDistance(home, t) };
  } else {
    const pool = targetsIn(ctx, typ && typ.kind === 'flat' ? tiles.flats : tiles.valleys, home, { kinds, levels, reach: radius, skip: new Set([...ours, ...blocked]) });
    target = (hunt.target && pool.list.find((t) => t.id === hunt.target)) || pool.list[0] || null;
    if (!target) {
      return held(`no free ${levelsText(levels.slice().reverse())} ${typ && typ.kind ? typ.kind : 'valley'} within ${radius} tiles${pool.stale ? ` (${pool.stale} waiting for a fresh map read)` : ''}`);
    }
  }
  hunt.target = target.id;
  const notes = [`at ${where(target)} L${target.level} ${target.kind}${pos ? ' (huntingpos)' : ''}`, `${slots.held.length}/${slots.cap} slots held`];

  // 3. a free slot to catch it in — our own waves on it hold one already. The
  // wiki lets hunting "abandon 1 or more of your valleys to free up slots to
  // hunt with": the lowest valley goes once the wave is on its way.
  let release = null;
  const free = slots.free + (slots.flying.has(target.id) ? 1 : 0);
  if (free <= 0) {
    const worst = worstValley(slots.held, null, home, new Set([target.id]));
    if (!worst) return { note: [`${head} — no free slot, and no valley to let go for one (flats are left alone)`, ...notes].join(' | '), actions: [] };
    release = worst;
  }
  const r = planAttack({ ctx, state, game, castle, home, st, target, purpose: 'hunt', capture: true, rallyKind: 'm', table: HUNT_TROOPS, release });
  if (!r.action) return { note: [`${head} — waiting: ${r.why}`, ...notes].join(' | '), actions: [] };

  // 4. waves land HUNT_GAP_MS apart, so the one before can be let go first
  const lands = now + n(r.action.oneWayMs);
  const waves = (ctx.selfArmies || (game && game.player && game.player.selfArmys) || [])
    .map((a) => a.raw || a)
    .filter((b) => Number(b.targetFieldId) === target.id && Number(b.missionType) === C.MISSION.attack && (Number(b.direction) || 1) === 1)
    .map((b) => n(b.reachTime));
  const last = st.marches[target.id];
  if (last && last.purpose === 'hunt' && now - n(last.at) < PENDING_MS && n(last.landsAt)) waves.push(n(last.landsAt));
  const clash = waves.find((t) => t > 0 && Math.abs(t - lands) < HUNT_GAP_MS);
  if (clash) {
    return { note: [`${head} — waiting: a wave lands ${NI.hms(Math.max(0, clash - now))} from now, and waves land ${NI.hms(HUNT_GAP_MS)} apart so the valley can be let go between them`, ...notes].join(' | '), actions: [] };
  }
  return { note: [`${head} — ${r.action.label}`, ...notes].join(' | '), actions: [r.action] };
}

// ===================================================== flats: acquire, abandon

// wiki BuildNpc: the npc levels config buildnpc asks for.
//   { on: false }  off (0 or unset)       { on: false, bad }  a value it does not know
//   { on: true, all: true }  buildnpc:20  { on: true, levels: [...] }
function buildWanted(cfg) {
  const v = (cfg || {}).buildnpc;
  if (!isSet(v)) return { on: false };
  const x = whole(v);
  if (x === 0) return { on: false };
  const code = x !== null ? BUILD_CODES[x] : undefined;
  if (!code) return { on: false, bad: `config buildnpc:${v} is not 0, 1-5, 10, 15 or 20 (wiki BuildNpc)` };
  return code === 'all' ? { on: true, all: true, levels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } : { on: true, all: false, levels: code };
}

// How far out npcs are built at one level (wiki NpcBuildPolicy, DistancePolicy):
// the last npcbuildpolicy line that covers the level, else distancepolicy's
// second number, else buildnpcpolicy /distance (OTTObot's older switch), else 10.
function buildBand(ctx, level) {
  const bands = goalsNamed(ctx, 'npcbuildpolicy').filter((g) => Array.isArray(g.levels) ? g.levels.includes(level) : g.level === level);
  const b = bands.slice(-1)[0];
  if (b && b.to != null) return { min: n(b.from), max: Math.min(n(b.to), MAX_DISTANCE), why: `npcbuildpolicy ${n(b.from)}-${n(b.to)}` };
  const dp = NI.dpFor(ctx);
  if (dp.build != null) return { min: 0, max: Math.min(dp.build, MAX_DISTANCE), why: `within ${dp.build} (distancepolicy)` };
  const old = lastGoal(ctx, 'buildnpcpolicy');
  if (old && old.switches && old.switches.distance != null) return { min: 0, max: Math.min(n(old.switches.distance), MAX_DISTANCE), why: `within ${n(old.switches.distance)} (buildnpcpolicy /distance)` };
  return { min: 0, max: DEFAULT_RADIUS, why: `within ${DEFAULT_RADIUS} (default)` };
}

// The farthest any npc building reaches (the map scan reads that far).
function buildReach(ctx) {
  let r = 0;
  for (let l = 1; l <= 10; l++) r = Math.max(r, buildBand(ctx, l).max);
  return r;
}

// The upcoming maintenance, as the console planned its stand-down
// (session.js noteAnnouncement / planMaintenance; the plan is kept per account
// in the org's settings). A script's logout is not maintenance: flats level up
// only at the real one. `ctx.maintPlan` stands in for it in the tests.
function maintenanceAhead(ctx) {
  if (ctx.maintPlan !== undefined) return ctx.maintPlan;
  if (!ctx.accountId) return null;
  try {
    const acc = D.accounts.get(ctx.accountId);
    if (!acc || !acc.orgId) return null;
    const p = D.org(acc.orgId).settings.get('maintPlan:' + ctx.accountId, null);
    return p && p.source !== 'logout' && n(p.startsAt) ? p : null;
  } catch { return null; }
}

// In the minutes before the stand-down: abandonflats lets flats go now, and
// acquireflats takes none back until the server is up again.
function inReleaseWindow(ctx, now) {
  const m = maintenanceAhead(ctx);
  if (!m) return false;
  const pauseAt = n(m.pauseAt) || n(m.startsAt);
  return now >= pauseAt - RELEASE_WINDOW_MS && now < (n(m.resumeAt) || n(m.startsAt) + H1);
}

function flatsPlan(ctx, state, game) {
  const cfg = ctx.config || {};
  if (!isSet(cfg.acquireflats) && !isSet(cfg.abandonflats)) return null;
  const bad = configProblems(cfg, ['acquireflats', 'abandonflats']);
  if (bad.length) return { note: `flats — held: ${bad.join('; ')}`, actions: [] };
  const acquire = lv(cfg.acquireflats), release = lv(cfg.abandonflats);
  if (!acquire && !release) return null;
  const castle = ctx.castle || {};
  const now = nowOf(ctx);
  const st = vstate(state, now);
  const notes = [];
  const actions = [];
  const want = buildWanted(cfg);
  const flatsHeld = heldFields(castle).filter((f) => f.kind === 'flat');
  const window = inReleaseWindow(ctx, now);

  // ---- abandonflats (wiki AbandonFlats): during the maintenance warning, let go
  // every held flat that is not at a level buildnpc builds on, so it levels up
  // over maintenance (acquireflats takes it back afterwards)
  if (release) {
    if (want.bad) notes.push(`abandonflats: held — ${want.bad}`);
    else if (!want.on) notes.push('abandonflats: config buildnpc says which levels to build; without it no flat is let go');
    else if (want.all) notes.push('abandonflats: buildnpc:20 builds on every flat, so none is let go');
    else {
      // wiki ExcludeList "can replace NoAbandonFlats": a flat on the excludelist
      // (NEAT's older noabandonflats reads as one, goals.js) is never let go
      const excl = excludedIds(ctx);
      const kept = flatsHeld.filter((f) => !want.levels.includes(f.level) && excl.has(f.id));
      if (kept.length) notes.push(`abandonflats: ${kept.map((f) => where(f)).join(', ')} on the excludelist, kept`);
      const drop = flatsHeld.filter((f) => !want.levels.includes(f.level) && !excl.has(f.id));
      if (!drop.length) notes.push(`abandonflats: ${flatsHeld.length} flat(s) held, ${kept.length ? 'the rest' : 'all'} at a level to build on`);
      else if (!window) notes.push(`abandonflats: ${drop.length} flat(s) below or above L${want.levels.join('/')} go at the next maintenance warning`);
      else {
        const action = {
          kind: 'releaseFields', purpose: 'abandonflats', levels: want.levels,
          fields: drop.map((f) => ({ fieldId: f.id, level: f.level, type: f.kind, x: f.x, y: f.y, why: `L${f.level}, buildnpc builds L${want.levels.join('/')}` })),
          label: `maintenance is near: let go of ${drop.length} flat(s) not at L${want.levels.join('/')} so they level up (${drop.map((f) => `${where(f)} L${f.level}`).join(', ')})`,
        };
        Object.defineProperty(action, 'state', { value: state, enumerable: false });
        actions.push(action);
      }
    }
  }

  // ---- acquireflats (wiki AcquireFlats): capture flats within npc-building
  // distance and hold them. 1 needs an open city slot, 2 goes anyway. Free
  // slots only: this never lets a valley go for a flat (OUR CHOICE; the wiki
  // warns flats take the slots valleys would have).
  if (acquire && !actions.length) {
    const hold = holdAll(ctx, state);
    const home = homeOf(game, castle);
    const tiles = loadTiles(ctx);
    const slots = slotsOf(ctx, castle, st, tiles);
    const title = require('./city-build').titleSlots(game || { castles: [castle] });
    const reserve = huntingOn(cfg) ? 1 : 0;
    const top = want.on && !want.all ? Math.max(...want.levels) : 10;
    if (hold) notes.push(`acquireflats: held — ${hold}`);
    else if (!home) notes.push('acquireflats: this city has no map position');
    else if (slots.cap === null) notes.push('acquireflats: the Town Hall level is not known, so neither are the slots');
    else if (window) notes.push('acquireflats: maintenance is near — flats are let go now and taken back after it');
    else if (acquire === 1 && title.title === null) notes.push('acquireflats:1 — the account\'s title is not known, so neither is an open city slot');
    else if (acquire === 1 && title.open < 1) notes.push(`acquireflats:1 — no open city slot (title allows ${title.max}, ${title.cities} cities); acquireflats:2 captures anyway`);
    else if (slots.free - reserve <= 0) {
      notes.push(`acquireflats: no free slot — ${slots.held.length}/${slots.cap} held${slots.flying.size ? `, ${slots.flying.size} capture(s) on the way` : ''}${reserve ? ', one kept for hunting' : ''}`);
    }
    else {
      const skip = busyTargets(ctx, castle, st);
      for (const r of claimedFlats(ctx)) skip.add(r);
      // A flat is worth holding where an npc of a level it can still grow to
      // would be built (npcbuildpolicy per level): with buildnpc's levels, the
      // bands of those at or above it; with none (or buildnpc:20), its own.
      const grows = want.on && !want.all ? want.levels : null;
      const fits = (t) => (grows ? grows.filter((L) => L >= t.level) : [t.level])
        .some((L) => { const b = buildBand(ctx, L); return t.dist >= b.min && t.dist <= b.max; });
      const pool = targetsIn(ctx, tiles.flats, home, { kinds: ['flat'], levels: Array.from({ length: top }, (_, i) => i + 1), reach: buildReach(ctx), skip });
      const cands = pool.list.filter(fits);
      const stale = pool.stale;
      cands.sort((a, b) => a.dist - b.dist || b.level - a.level || a.id - b.id);
      const target = cands[0];
      if (!target) notes.push(`acquireflats: no free flat${want.on && !want.all ? ` up to L${top}` : ''} within npc-building distance${stale ? ` (${stale} waiting for a fresh map read)` : ''}`);
      else {
        const r = planAttack({ ctx, state, game, castle, home, st, target, purpose: 'flat', capture: true, rallyKind: 'b', table: CAPTURE_TROOPS, reserve });
        if (r.action) actions.push(r.action);
        else notes.push(`acquireflats: waiting to capture ${where(target)} L${target.level}: ${r.why}`);
      }
      notes.push(`acquireflats: ${flatsHeld.length} flat(s) held, ${slots.held.length}/${slots.cap} slots`);
    }
  }
  const head = actions.length ? `flats — ${actions[0].label}` : 'flats — nothing to do';
  return { note: [head, ...notes].join(' | '), actions };
}

// Flats buildnpc has claimed (its registry), which acquireflats leaves alone.
function claimedFlats(ctx) {
  if (!ctx.accountId) return [];
  try { return D.registry.all(ctx.accountId).filter((r) => r.state === 'pending-build').map((r) => Number(r.fieldId)); } catch { return []; }
}

// ============================================================ config abandon

// wiki Abandon: "The bot will destroy all troops, wall defenses, and queues in
// the city and will lower loyalty by levying and adjusting the tax rate upwards.
// The bot will not perform comforting actions ... It will not automatically
// abandon the city once it reaches 0 loyalty."
//
// OUR CHOICE, as this destroys for good: it waits while anything else in the
// city would rebuild what it takes down or fight the loyalty drain — troop
// lines (unless config troop:0), fortification lines (unless config
// fortification:0), taxpolicy or comfortpolicy, or comfort not written as
// config comfort:0 (it is on unless 0) — and it never runs in the account's
// only city. With no troop line training, the troop goal's batches, its
// reserved barracks and its bad-queue cancels (engine troopPlan) do nothing
// here, and with no wall line neither do the wall batches or the emergency
// walls (fortPlan). "Queues" are read as the troop and wall queues.
function abandonState(state) {
  const v = (state.valley = state.valley || {});
  return (v.abandon = v.abandon || {});
}

function abandonPlan(ctx, state, game) {
  const cfg = ctx.config || {};
  if (!isSet(cfg.abandon)) return null;
  const bad = configProblems(cfg, ['abandon']);
  if (bad.length) return { note: `abandon — held: ${bad.join('; ')}`, actions: [] };
  if (!lv(cfg.abandon)) return null;
  const castle = ctx.castle || {};
  const now = nowOf(ctx);
  const head = 'abandon:1';
  const held = (why) => ({ note: `${head} — ${why}`, actions: [] });
  const cities = (game && game.castles) || [];
  if (cities.length <= 1) return held('this is the account\'s only city — nothing is destroyed');
  const blockers = [];
  const off = (k) => isSet(cfg[k]) && whole(cfg[k]) === 0;
  if (goalsNamed(ctx, 'troop').length && !off('troop')) blockers.push('the troop lines (or write config troop:0)');
  if (goalsNamed(ctx, 'fortification').length && !off('fortification')) blockers.push('the fortification lines (or write config fortification:0)');
  for (const name of ['taxpolicy', 'comfortpolicy']) if (goalsNamed(ctx, name).length) blockers.push(`the ${name} line`);
  if (!off('comfort')) blockers.push('comfort (write config comfort:0)');
  if (blockers.length) {
    return held(`waiting: first take off ${blockers.join(', ')} — they would rebuild what this takes down, or comfort the loyalty back up. Run EvacuateTown and move the heroes out before you set this (wiki Abandon)`);
  }
  const ab = abandonState(state);
  const cid = game && game.castleId ? game.castleId(castle) : castle.castleId;
  const res = castle.resource || {};
  const troops = Object.entries(castle.troop || {}).filter(([k, v]) => C.BY_KEY[k] && n(v) > 0);
  const walls = C.WALLS.map((w) => [w, n((castle.fortification || {})[w.beanKey])]).filter(([, v]) => v > 0);
  const heroes = (castle.heros || []).length;
  const loyalty = n(res.support);
  const notes = [`${troops.reduce((s, [, v]) => s + n(v), 0).toLocaleString('en-US')} troops, ${walls.reduce((s, [, v]) => s + v, 0).toLocaleString('en-US')} fortifications, tax ${n(res.texRate)}%, loyalty ${loyalty}`];
  if (heroes) notes.push(`${heroes} hero(es) still here — move them out before the city is abandoned`);
  let step = null;
  if (!ab.queuesAt || now - n(ab.queuesAt) > H1) step = { step: 'queues', label: 'cancel every troop and wall batch in the queues' };
  else if (troops.length) step = { step: 'troops', troops: Object.fromEntries(troops), label: `disband ${troopText(Object.fromEntries(troops))}` };
  else if (walls.length) step = { step: 'walls', walls: walls.map(([w, v]) => ({ typeId: w.typeId, name: w.name, num: v })), label: `destroy ${walls.map(([w, v]) => `${fmt(v)} ${w.name}`).join(', ')}` };
  else if (n(res.texRate) < 100) step = { step: 'tax', label: `raise the tax from ${n(res.texRate)}% to 100%` };
  else if (loyalty > 0 && now - n(ab.levyAt) >= LEVY_GAP_MS) step = { step: 'levy', label: 'levy gold (-20 loyalty)' };
  if (!step) return held([loyalty > 0 ? `stripped; the next levy in ${NI.hms(LEVY_GAP_MS - (now - n(ab.levyAt)))}` : 'stripped, loyalty 0 — abandon the city by hand when you are ready', ...notes].join(' | '));
  const action = { kind: 'abandonStep', castleId: cid, ...step, label: `abandon: ${step.label}` };
  Object.defineProperty(action, 'state', { value: state, enumerable: false });
  return { note: [`${head} — ${action.label}`, ...notes].join(' | '), actions: [action] };
}

// ================================================ the background map scan

// How far the valley goals want the map read around a city, or null when none
// of them is on (goal-npc scanAreaFor/scanWanted).
function scanArea(ctx) {
  const cfg = (ctx && ctx.config) || {};
  const dp = NI.dpFor(ctx);
  let radius = 0;
  const points = [];
  if (lv(cfg.valley) > 0) radius = Math.max(radius, dp.acquire ?? DEFAULT_RADIUS);
  if (lv(cfg.valleyfarming) > 0 || safeGoal(ctx)) {
    const m = milesGoal(ctx);
    radius = Math.max(radius, m ? Math.max(...Object.values(m.miles)) : dp.valley ?? DEFAULT_RADIUS);
  }
  if (lv(cfg.hunting) > 0) {
    radius = Math.max(radius, dp.valley ?? DEFAULT_RADIUS);
    const pos = lastGoal(ctx, 'huntingpos');
    if (pos && pos.coord) points.push({ x: pos.coord.x, y: pos.coord.y });
  }
  // npc building reaches as far as its farthest npcbuildpolicy band
  if (lv(cfg.acquireflats) > 0 || buildWanted(cfg).on) radius = Math.max(radius, buildReach(ctx));
  if (!radius && !points.length) return null;
  return { radius: Math.min(radius, MAX_DISTANCE), points };
}

// ============================================================== executors

// Who holds the tile and whether the client would offer the march, read now.
//   need   'canOccupy' for an attack, 'canScout' for scouts
async function tileCheck(game, fieldId, need = 'canOccupy') {
  let r;
  try { r = typeof game.fieldInfo === 'function' ? await game.fieldInfo(fieldId) : await game.req('field.getOtherFieldInfo', { fieldId }, 8000); }
  catch (e) { return { ok: false, transient: true, why: `could not read who holds it (${e.message})` }; }
  if (!r || r.ok !== 1 || !r.bean) return { ok: false, transient: true, why: `could not read who holds it (${(r && r.errorMsg) || 'no answer'})` };
  const who = r.bean.userName;
  if (isSet(who)) return { ok: false, why: `it belongs to ${who} now` };
  const flag = r.bean[need];
  if (!(flag === true || flag === 1 || flag === 'true')) return { ok: false, why: `the game does not offer ${need === 'canScout' ? 'scouting' : 'an attack'} there (${need} is not set)` };
  return { ok: true };
}

// Let fields go, each checked as this city's and still what the plan saw.
async function releaseFields(game, castle, action, state) {
  const st = vstate(state || action.state || {});
  const done = [], refused = [];
  for (const f of action.fields || []) {
    const now = heldFields(castle).find((x) => x.id === Number(f.fieldId));
    if (!now) { refused.push(`${f.x},${f.y}: not held by this city any more`); continue; }
    if (f.type && now.kind !== f.type) { refused.push(`${f.x},${f.y}: it is a ${now.kind} now, not a ${f.type}`); continue; }
    if (action.purpose === 'abandonflats' && (now.kind !== 'flat' || (action.levels || []).includes(now.level))) { refused.push(`${f.x},${f.y}: L${now.level} ${now.kind} is not one to let go`); continue; }
    if (action.purpose === 'hunt' && !(st.marches[now.id] && st.marches[now.id].purpose === 'hunt')) { refused.push(`${f.x},${f.y}: not a hunting catch`); continue; }
    // making room (a valleymin swap, a hunting slot) only ever lets a valley go, never a flat
    if (action.purpose === 'room' && !VALLEY_KINDS.includes(now.kind)) { refused.push(`${f.x},${f.y}: a ${now.kind} is never let go to make room`); continue; }
    let r;
    try { r = typeof game.giveUpField === 'function' ? await game.giveUpField(now.id) : await game.req('field.giveUpField', { fieldId: now.id }); }
    catch (e) { refused.push(`${f.x},${f.y}: ${e.message}`); continue; }
    if (r && r.ok === 1) {
      done.push(`${f.x},${f.y}`);
      if (st.marches[now.id]) st.marches[now.id].releasedAt = Date.now();
      st.released = st.released || {};
      st.released[now.id] = { at: Date.now(), why: f.why || action.purpose };
    } else refused.push(`${f.x},${f.y}: ${(r && r.errorMsg) || 'refused'}`);
  }
  if (!done.length) return { ok: 0, errorMsg: refused.join('; ') || 'nothing to let go' };
  return { ok: 1, released: done, refused };
}

const executors = {
  // army.newArmy with missionType 5 on a valley or flat, after the game has
  // said, just now, that it is free and attackable; a capture only into a free
  // slot, a farming hit only with none free.
  async valleyAttack(game, castle, action, state) {
    state = state || action.state || {};
    const st = vstate(state);
    // plans are made before anything in the slice is sent: npc farming's run
    // (goal-npc recordSend) or another valley march may have taken this hero
    // moments ago, before the server's hero push says so
    const npcRun = ((state.npc && state.npc.runs) || []).some((r) => r && r.heroId === action.heroId && Date.now() - n(r.sentAt) < HERO_PUSH_MS);
    const valleyRun = Object.values(st.marches).some((r) => r && r.heroId === action.heroId && Date.now() - n(r.at) < HERO_PUSH_MS);
    if (npcRun || valleyRun) {
      return { ok: 0, errorMsg: `not sent: ${action.hero || 'the hero'} has just left on ${npcRun ? 'an npc run' : 'another valley march'} — another hero goes next slice` };
    }
    const who = await tileCheck(game, action.fieldId, 'canOccupy');
    if (!who.ok) {
      noteBlocked(st, action.fieldId, who.why, who.transient ? BLOCK_READ_MS : BLOCK_MS);
      return { ok: 0, errorMsg: `not sent: ${who.why}` };
    }
    const slots = slotsNow(game, castle, state);
    if (action.capture) {
      // a wave of ours already on its way to the same tile holds its slot
      const room = slots.free === null ? null
        : slots.free - n(action.reserve) + (action.release ? 1 : 0) + (slots.flying.has(Number(action.fieldId)) ? 1 : 0);
      if (room === null || room <= 0) return { ok: 0, errorMsg: 'not sent: no free valley slot now' };
      if (action.release && !heldFields(castle).some((f) => f.id === action.release.fieldId)) return { ok: 0, errorMsg: 'not sent: the valley it was to replace is no longer held' };
    }
    if (action.needFull && !slotsFull(slots)) return { ok: 0, errorMsg: 'not sent: a valley slot is free, so the attack would capture the valley' };
    const bean = game.buildArmyBean({ missionType: C.MISSION.attack, heroId: action.heroId, targetPoint: action.fieldId, troops: action.troops });
    const res = await game.newArmy(game.castleId(castle), bean);
    if (!res || res.ok !== 1) return res || { ok: 0, errorMsg: 'no answer' };
    const at = Date.now();
    recordMarch(state, action.fieldId, {
      kind: action.rallyKind, purpose: action.purpose, capture: !!action.capture, at, level: action.level, type: action.type,
      heroId: action.heroId, landsAt: at + n(action.oneWayMs),
    });
    if (action.purpose === 'farm' || action.purpose === 'safe') st.farmed[action.fieldId] = at;
    if (action.release) {
      // the swap's other half, now the attack is on its way (wiki Valley: drop
      // the lowest valley; wiki Hunting: abandon valleys to free a slot)
      const rel = await releaseFields(game, castle, { purpose: 'room', fields: [{ ...action.release, why: `making room for ${action.target.x},${action.target.y}` }] }, state);
      if (rel.ok !== 1) st.releaseError = { at, fieldId: action.release.fieldId, why: rel.errorMsg };
    }
    return res;
  },

  // Scouts (missionType 3) on a valley for safe farming. No hero.
  async valleyScout(game, castle, action) {
    const mem = action.memory;
    const who = await tileCheck(game, action.fieldId, 'canScout');
    if (!who.ok) {
      if (mem) mem.valleys[action.fieldId] = { stage: 'skip', why: who.why, at: Date.now(), x: action.target.x, y: action.target.y, level: action.level };
      return { ok: 0, errorMsg: `not sent: ${who.why}` };
    }
    const bean = game.buildArmyBean({ missionType: C.MISSION.scout, targetPoint: action.fieldId, troops: action.troops });
    const res = await game.newArmy(game.castleId(castle), bean);
    if (res && res.ok === 1 && mem) {
      mem.valleys[action.fieldId] = { stage: 'scouting', sentAt: Date.now(), x: action.target.x, y: action.target.y, level: action.level, type: action.type };
    }
    return res;
  },

  // The scouts are home: find their reports (report.receiveReportList, then
  // report.markAsRead to open one — it is marked read, as opening it in the
  // game would) and judge each valley by the wiki's rules.
  async scoutReports(game, castle, action) {
    const mem = action.memory;
    if (mem) mem.readAt = Date.now();
    const list = await game.reportList('army', 1, 30);
    if (!list || list.ok !== 1) return { ok: 0, errorMsg: `report list unreadable (${(list && list.errorMsg) || 'no answer'})` };
    const rows = list.reports || [];
    const ms = (t) => { const x = n(t); return x > 0 && x < 1e12 ? x * 1000 : x; };
    let reads = 0;
    const said = [];
    for (const p of action.pending || []) {
      const v = mem && mem.valleys[p.fieldId];
      if (!v) continue;
      const mine = rows.filter((r) => {
        const m = String(r.targetPos == null ? '' : r.targetPos).match(/(\d{1,3})\s*,\s*(\d{1,3})/);
        return m && Number(m[1]) === p.x && Number(m[2]) === p.y && ms(r.eventTime) >= n(p.sentAt) - 60000;
      }).sort((a, b) => ms(b.eventTime) - ms(a.eventTime));
      let judged = false;
      for (const row of mine) {
        if (reads >= 3) break;
        reads++;
        const d = await game.readReport(row.id);
        const got = readScout(d && d.report && d.report.content);
        if (!got.scout) continue;
        judged = true;
        if (!got.success) Object.assign(v, { stage: 'unsafe', why: got.why });
        else if (!got.garrison) Object.assign(v, { stage: 'unsafe', why: got.why });
        else {
          const load = safeLoad(p.level, got.garrison);
          Object.assign(v, load ? { stage: 'safe', troops: load.troops, rule: load.rule, garrison: got.garrison }
            : { stage: 'unsafe', why: `not safe by the wiki's rules (${troopText(got.garrison) || 'no troops'})`, garrison: got.garrison });
        }
        said.push(`${p.x},${p.y} ${v.stage}`);
        break;
      }
      if (!judged && Date.now() - n(p.sentAt) > REPORT_WAIT_MS) { Object.assign(v, { stage: 'unsafe', why: 'no scout report came back' }); said.push(`${p.x},${p.y} no report`); }
    }
    return { ok: 1, judged: said };
  },

  releaseFields,

  // config abandon, one step a slice (abandonPlan says which).
  async abandonStep(game, castle, action, state) {
    const ab = abandonState(state || action.state || {});
    const cid = action.castleId;
    if (action.step === 'queues') {
      const out = [];
      const tq = await game.req('troop.getProduceQueue', { castleId: cid });
      if (tq && tq.ok === 1) {
        for (const bq of tq.allProduceQueue || []) for (const p of bq.allProduceQueue || []) {
          const r = await game.cancelTroop(cid, bq.positionId, p.queueId);
          out.push(r && r.ok === 1);
        }
      }
      const wq = await game.req('fortifications.getProduceQueue', { castleId: cid });
      if (wq && wq.ok === 1) {
        for (const bq of wq.allProduceQueue || []) for (const p of bq.allProduceQueue || []) {
          const r = await game.cancelWall(cid, p.queueId);
          out.push(r && r.ok === 1);
        }
      }
      if (!(tq && tq.ok === 1) || !(wq && wq.ok === 1)) return { ok: 0, errorMsg: 'a queue could not be read' };
      ab.queuesAt = Date.now();
      return { ok: 1, cancelled: out.filter(Boolean).length };
    }
    if (action.step === 'troops') {
      let last = { ok: 1 };
      for (const [k, v] of Object.entries(action.troops || {})) {
        const t = C.BY_KEY[k];
        const have = n((castle.troop || {})[k]);
        const num = Math.min(n(v), have);
        if (!t || num <= 0) continue;
        last = await game.disbandTroop(cid, t.typeId, num);
        if (!last || last.ok !== 1) return last || { ok: 0, errorMsg: 'no answer' };
      }
      return last;
    }
    if (action.step === 'walls') {
      let last = { ok: 1 };
      for (const w of action.walls || []) {
        last = await game.destructWall(cid, w.typeId, w.num);
        if (!last || last.ok !== 1) return last || { ok: 0, errorMsg: 'no answer' };
      }
      return last;
    }
    if (action.step === 'tax') return game.setTax(cid, 100);
    if (action.step === 'levy') {
      const r = await game.levy(cid, 1);
      if (r && r.ok === 1) ab.levyAt = Date.now();
      return r;
    }
    return { ok: 0, errorMsg: `unknown step ${action.step}` };
  },
};

module.exports = {
  parsers,
  plans: {
    valley: valleyPlan, valleyfarming: valleyFarmingPlan, safevalleyfarm: safeFarmPlan,
    hunting: huntingPlan, flats: flatsPlan, abandon: abandonPlan,
  },
  executors,
  configKeys,
  // the map scan (goal-npc) and buildnpc (goal-buildnpc) use these
  scanArea, buildWanted, buildBand, buildReach,
  loadTiles, targetsIn, slotsOf, slotsNow, tileCheck, planAttack, recordMarch, vstate,
  homeOf, holdAll, excludedIds, freshSince, heldFields, fieldCap, busyTargets,
  CAPTURE_TROOPS,
  _internals: {
    CONFIG_RULES, CAPTURE_TROOPS, HUNT_TROOPS, FARM_TROOPS, SAFE_ARCHERS, SAFE_SCOUTS, HUNT_LEVELS, BUILD_CODES,
    VALLEY_KINDS, TYPE_WORDS, FRESH_MS, FARM_GAP_MS, HUNT_GAP_MS, PENDING_MS, RELEASE_WINDOW_MS, LEVY_GAP_MS,
    configProblems, typeOfWord, cityResource, fieldCap, heldFields, digestTiles, capturesOut, troopsFor, heroSpec,
    pickHero, rallyFor, limitShort, worstValley, safeLoad, readScout, safeMemory, farmReach, maintenanceAhead,
    inReleaseWindow, claimedFlats, releaseFields,
  },
};
