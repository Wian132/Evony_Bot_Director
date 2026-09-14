'use strict';
// Hero policy goals, NEAT-compatible.
//
//   keepheroes / keepcapturedheroes / herofirelimit ... which heroes may never be fired
//   heropoints .............................. standing rule for spending level-up points
//   nolevelheroes ........................... which heroes must not be levelled
//   homeheroes .............................. how many heroes stay home when farming
//   spamheroes .............................. which heroes may be used for spam/loyalty hits
//   config feastinghallspace ................ how many hero slots stay free
//   config nomayor / hero / training / training10
//
// Wiring (one line each, in the files that own them):
//   goals.js   Object.assign(GOALS, require('./goal-heroes').parsers)
//   engine.js  const H = require('./goal-heroes');
//              report.heroes = H.plans.keepheroes(ctx, cityState, g);   // etc.
//              await H.executors[a.kind](g, castle, a);
//
// Everything above `executors` is PURE: plans read the roster we already have and
// return action descriptors. Nothing here opens a connection.
//
// What this module keeps in the per-city state object:
//   state.lastFireAt      set by the fireHero executor when a fire goes through;
//                         the fire cooldown reads it
//   state.capturedHeroes  { heroId: { name, level, at } } for heroes seen held
//                         prisoner here (the captives plan writes it), which is
//                         what routes a persuaded one to keepcapturedheroes; a
//                         prisoner still in the cell is status 4 and is spotted
//                         without it
//   state.hallReadAt      when the inn was last asked for the hall's free slots
//
// Sources (all read offline):
//   src/scripts/com/evony/client/action/HeroCommand.as    command + param names
//   src/scripts/com/evony/common/beans/HeroBean.as        hero fields
//   src/scripts/com/evony/common/constants/HeroConstants.as + view/module/herosMansion/HeroLabel.as
//                                                         status codes and their labels
//   src/scripts/view/module/herosMansion/HeroProperties.as  what hero.addPoint actually expects
//   http://guide.neatportal.com/wiki/{HeroString,KeepHeroes,...}

const { Game } = require('./game');

const num = (x) => Number(x || 0);

// --------------------------------------------------------------- hero status
// HeroConstants.as, labelled in HeroLabel.as:
//   0 空闲 idle   1 城守 mayor (chief)   2 驻守 garrisoned (reinforcing)
//   3 出征 marching   4 俘虏 captive (a hero WE hold prisoner)   5 army returning
//   8 farming (HeroLabel.as prints "Farming"; Heros.as renders it as marching)
const STATUS = { IDLE: 0, MAYOR: 1, GARRISON: 2, MARCHING: 3, CAPTIVE: 4, RETURNING: 5, FARMING: 8 };
const STATUS_NAME = {
  0: 'idle', 1: 'mayor', 2: 'garrisoned', 3: 'marching', 4: 'captive', 5: 'returning', 8: 'farming',
};
// The ONLY status we are ever willing to fire from. Everything else is either
// committed (mayor/garrison/march) or not really ours (captive).
const FIREABLE = new Set([STATUS.IDLE]);

// ------------------------------------------------------------- hero attributes
// power = Attack, management = Politics, stratagem = Intelligence (HeroBean.as).
const ATTR = {
  attack: 'power', att: 'power', atk: 'power', power: 'power',
  politics: 'management', pol: 'management', management: 'management',
  intel: 'stratagem', int: 'stratagem', stratagem: 'stratagem',
};
const ATTR_KEYS = ['power', 'management', 'stratagem'];
const ATTR_LABEL = { power: 'att', management: 'pol', stratagem: 'int' };

// HeroProperties.as:1609-1611 fills the attribute boxes straight from
// heroMes.power / .management / .stratagem, and :874-880 bumps that same number
// by 1 for every point the player spends -- so h.power is the CURRENT TOTAL and
// h.powerAdded is the slice of it that came from spent points. That makes
//   base = power - powerAdded
// which is what NEAT calls a hero's base. (The client itself never reads the
// *Added fields, so this is inference from how the total is displayed and sent.
// If a live roster ever shows otherwise, flip ATTR_INCLUDES_ADDED.)
const ATTR_INCLUDES_ADDED = true;

function attrOf(h, key) {
  const k = ATTR[String(key).toLowerCase()] || key;
  return ATTR_INCLUDES_ADDED ? num(h[k]) : num(h[k]) + num(h[k + 'Added']);
}
function addedOf(h, key) {
  const k = ATTR[String(key).toLowerCase()] || key;
  return num(h[k + 'Added']);
}
// Per attribute, from the *Added fields. Only an inn offer fills those (NEAT's
// Heroes page: "usable only with innHeroes"); the live roster sends 0 in every
// one, so for a hired hero this is just the attribute.
function baseOf(h, key) { return attrOf(h, key) - addedOf(h, key); }
// A hero's "base" — `base` in a hero string, the keep and spam defaults — is
// Game.heroBase, the one formula the console shows too: the top attribute less
// the one point per level that levelling gave it, plus any still unspent.
// It used to be the best attribute less its *Added, which on the live roster is
// the whole attribute, so `any:base>=69` protected nearly every hero past L20.
function heroBase(h) { return Game.heroBase(h); }
function dominant(h) {
  return ATTR_KEYS.slice().sort((a, b) => attrOf(h, b) - attrOf(h, a))[0];
}

// ============================================================================
// Hero strings.   wiki: HeroString
//
//   spec        := alternative ( '|' alternative )*
//   alternative := nameList [ ':' filterList ]
//   nameList    := ( name | '!' name | 'any' | 'none' ) ( ',' ... )*
//   filterList  := field op value ( ',' ... )*
//
// Alternatives are OR'd. Inside one alternative the name list is OR'd, every
// '!name' vetoes, and the filters are AND'd. Names are case-insensitive and may
// use '*' (any run of characters) and '?' (one character).
//
//   any                              every hero
//   any:level>=100                   heroes at level 100+
//   !bob,any:base>=65                any 65+ base hero except bob
//   bob,fred,joe|any:attack>=60      those three, OR anything with 60+ attack
//   any:attack=best                  the single best attack hero in the city
//   any:attack>politics              heroes whose attack beats their politics
//   none                             no hero at all
// ============================================================================

// field -> reader.  wiki lists exactly these, with these abbreviations.
const FIELDS = {
  attack: (h) => attrOf(h, 'power'), att: (h) => attrOf(h, 'power'),
  politics: (h) => attrOf(h, 'management'), pol: (h) => attrOf(h, 'management'),
  intel: (h) => attrOf(h, 'stratagem'), int: (h) => attrOf(h, 'stratagem'),
  loyalty: (h) => num(h.loyalty), loy: (h) => num(h.loyalty),
  level: (h) => num(h.level), lvl: (h) => num(h.level),
  experience: (h) => num(h.experience), exp: (h) => num(h.experience),
  points: (h) => num(h.remainPoint), pts: (h) => num(h.remainPoint),
  base: heroBase, bse: heroBase,
};

const OPS = ['>=', '<=', '!=', '<>', '>', '<', '='];

function globToRe(pat) {
  // '*' -> any run (including none) and '?' -> one character. The wiki calls '*'
  // "1 or more", but matching MORE names in a keep-list is the safe direction.
  const esc = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + esc.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}

function parseFilter(raw, errors) {
  const t = raw.trim();
  if (!t) return null;
  let op = null, at = -1;
  for (const o of OPS) {
    const i = t.indexOf(o);
    if (i > 0 && (at < 0 || i < at || (i === at && o.length > op.length))) { op = o; at = i; }
  }
  if (!op) { errors.push(`filter "${t}" has no comparison (expected e.g. level>=100)`); return null; }
  const field = t.slice(0, at).trim().toLowerCase();
  const rhsRaw = t.slice(at + op.length).trim().toLowerCase();
  if (!FIELDS[field]) { errors.push(`unknown hero field "${field}" in "${t}"`); return null; }
  if (!rhsRaw) { errors.push(`filter "${t}" is missing a value`); return null; }

  let rhs;
  if (rhsRaw === 'best' || rhsRaw === 'worst') rhs = { kind: rhsRaw };
  else if (FIELDS[rhsRaw]) rhs = { kind: 'field', field: rhsRaw };
  else if (/^-?\d+(\.\d+)?[kmb]?$/.test(rhsRaw)) {
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[rhsRaw.slice(-1)] || 1;
    rhs = { kind: 'num', value: parseFloat(rhsRaw) * mult };
  } else { errors.push(`cannot read "${rhsRaw}" in filter "${t}" (want a number, another field, best or worst)`); return null; }

  return { field, op: op === '<>' ? '!=' : op, rhs, raw: t };
}

function parseAlternative(raw, errors) {
  const alt = { names: [], excludes: [], any: false, none: false, filters: [], raw };
  const cut = raw.indexOf(':');
  const namePart = cut < 0 ? raw : raw.slice(0, cut);
  const filterPart = cut < 0 ? '' : raw.slice(cut + 1);

  for (const item of namePart.split(',')) {
    const t = item.trim();
    if (!t) continue;
    if (t.startsWith('!')) {
      const nm = t.slice(1).trim();
      if (!nm) { errors.push('"!" with no hero name after it'); continue; }
      alt.excludes.push({ pattern: nm, re: globToRe(nm) });
    } else if (t.toLowerCase() === 'any') alt.any = true;
    else if (t.toLowerCase() === 'none') alt.none = true;
    else alt.names.push({ pattern: t, re: globToRe(t) });
  }
  for (const f of filterPart.split(',')) {
    const parsed = parseFilter(f, errors);
    if (parsed) alt.filters.push(parsed);
  }
  // "!bob" on its own reads as "anything except bob".
  if (!alt.any && !alt.none && !alt.names.length && alt.excludes.length) alt.any = true;
  // "any:level>=50" with nothing else is fine; a bare filter list is too.
  if (!alt.any && !alt.none && !alt.names.length && alt.filters.length) alt.any = true;
  if (!alt.any && !alt.none && !alt.names.length && !alt.filters.length) errors.push(`"${raw}" selects nothing`);
  return alt;
}

// parseHeroString('any:level>=100|bob') -> { src, alts, errors, isNone }
function parseHeroString(src) {
  const text = String(src == null ? '' : src).replace(/\s+/g, '');
  const errors = [];
  const out = { src: text, alts: [], errors, isNone: false };
  if (!text) { errors.push('empty hero string'); return out; }
  // wiki: a hero string may not be a single bare number -- it is the trap people
  // fall into when swapping "herofirelimit 100" for "keepheroes 100", and it
  // would quietly stop protecting anything.
  if (/^\d+$/.test(text)) {
    errors.push(`"${text}" is just a number — write it as a filter, e.g. any:level>=${text}`);
    return out;
  }
  for (const part of text.split('|')) {
    if (!part) continue;
    out.alts.push(parseAlternative(part, errors));
  }
  out.isNone = out.alts.length > 0 && out.alts.every((a) => a.none);
  return out;
}

// best/worst are relative to the pool the string is evaluated against.
function extremes(pool, field) {
  const vals = pool.map((h) => FIELDS[field](h)).filter((v) => Number.isFinite(v));
  return vals.length ? { best: Math.max(...vals), worst: Math.min(...vals) } : { best: null, worst: null };
}

function compare(op, a, b) {
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

function altMatches(hero, alt, pool) {
  if (alt.none) return false;
  const name = String(hero.name || '');
  if (alt.excludes.some((e) => e.re.test(name))) return false;
  if (!alt.any && !alt.names.some((nm) => nm.re.test(name))) return false;
  for (const f of alt.filters) {
    const left = FIELDS[f.field](hero);
    let right;
    if (f.rhs.kind === 'num') right = f.rhs.value;
    else if (f.rhs.kind === 'field') right = FIELDS[f.rhs.field](hero);
    else {
      const ex = extremes(pool, f.field);
      right = f.rhs.kind === 'best' ? ex.best : ex.worst;
      if (right === null) return false;
    }
    if (!compare(f.op, left, right)) return false;
  }
  return true;
}

// matchHero(hero, spec, pool) -- spec is a string or a parsed hero string.
// `pool` only matters for best/worst; it defaults to the single hero.
function matchHero(hero, spec, pool) {
  const parsed = typeof spec === 'string' ? parseHeroString(spec) : spec;
  if (!parsed || !parsed.alts || !parsed.alts.length) return false;
  if (parsed.errors && parsed.errors.length) return false;   // a broken rule matches nothing
  const p = pool && pool.length ? pool : [hero];
  return parsed.alts.some((a) => altMatches(hero, a, p));
}

// matchHeroes(pool, spec) -> the heroes in pool the string selects.
function matchHeroes(pool, spec) {
  const parsed = typeof spec === 'string' ? parseHeroString(spec) : spec;
  return (pool || []).filter((h) => matchHero(h, parsed, pool));
}

function describeHeroString(parsed) {
  const p = typeof parsed === 'string' ? parseHeroString(parsed) : parsed;
  return p.src;
}

// ============================================================================
// Parsers
// ============================================================================

// Shared shape for every goal whose only argument is a hero string.
// Supports "/reset" (wiki: clears the rules collected so far) and extra
// /switches, which only keepheroes currently uses.
function heroStringGoal(name) {
  return {
    kind: 'directive', multi: true,
    parse(args) {
      const errors = [], switches = {};
      const words = [];
      for (const tok of args) {
        if (tok.startsWith('/')) {
          const i = tok.indexOf(':');
          const k = (i < 0 ? tok.slice(1) : tok.slice(1, i)).toLowerCase();
          const v = i < 0 ? true : tok.slice(i + 1);
          switches[k] = v === true ? true : (/^\d+$/.test(v) ? parseInt(v, 10) : v);
          continue;
        }
        words.push(tok);
      }
      if (switches.reset) return { reset: true, spec: null, switches, errors };
      // "keepheroes /max:2" sets a switch without adding a rule, which is fine.
      if (!words.length) {
        if (!Object.keys(switches).length) errors.push(`${name} needs a hero string (e.g. any:level>=100) or /reset`);
        return { reset: false, spec: null, switches, errors };
      }
      const spec = parseHeroString(words.join(''));
      for (const e of spec.errors) errors.push(e);
      return { reset: false, spec, switches, errors };
    },
  };
}

const parsers = {
  // keepheroes <hero-string> [/always] [/max:<n>] [/reset]
  //   Heroes matching the string are never fired. /always lets the bot fire
  //   everything that does NOT match (default: only fire to free a slot).
  keepheroes: heroStringGoal('keepheroes'),

  // keepcapturedheroes <hero-string> [/reset]
  keepcapturedheroes: heroStringGoal('keepcapturedheroes'),

  // nolevelheroes <hero-string> [/reset]
  nolevelheroes: heroStringGoal('nolevelheroes'),

  // spamheroes <hero-string> [/reset]
  spamheroes: heroStringGoal('spamheroes'),

  // herofirelimit <level>   (deprecated by NEAT: read as keepheroes any:level>=N)
  herofirelimit: {
    kind: 'directive', multi: false,
    parse(args) {
      const errors = [];
      const lvl = parseInt(args[0], 10);
      if (!Number.isFinite(lvl) || lvl <= 0) {
        errors.push('expected: herofirelimit <level>');
        return { level: null, spec: null, errors };
      }
      return {
        level: lvl, spec: parseHeroString(`any:level>=${lvl}`),
        deprecated: `herofirelimit ${lvl} is read as keepheroes any:level>=${lvl}`,
        errors,
      };
    },
  },

  // homeheroes <amount>
  homeheroes: {
    kind: 'directive', multi: false,
    parse(args) {
      const errors = [];
      const n = parseInt(args[0], 10);
      if (!Number.isFinite(n) || n < 0) errors.push('expected: homeheroes <amount>');
      return { amount: Number.isFinite(n) ? n : 0, errors };
    },
  },

  // heropoints <hero-string> <stage> [<stage> ...]   |   heropoints /reset
  //   stage := target[:cap] (,target[:cap])*   target := att|pol|int|off|none
  //   cap   := number | '*' (everything) | 'any' (nothing)
  //   e.g.  heropoints billybob att:50 att:100,int:850 att
  heropoints: {
    kind: 'directive', multi: true,
    parse(args) {
      const errors = [];
      if (args.some((a) => a.toLowerCase() === '/reset')) return { reset: true, spec: null, stages: [], errors };
      const [who, ...rest] = args;
      if (!who) { errors.push('expected: heropoints <hero-name-or-string> <target> [<target> ...]'); return { reset: false, spec: null, stages: [], errors }; }
      const spec = parseHeroString(who);
      for (const e of spec.errors) errors.push(e);
      if (!rest.length) errors.push('heropoints needs at least one target, e.g. att:500 or int or off');
      const { stages, errors: stageErrors } = parseStages(rest);
      return { reset: false, spec, stages, errors: errors.concat(stageErrors) };
    },
  },
};

// The targets of a heropoints line, one stage per word. waterhero's
// /heropoints="..." switch is the same list (wiki: WaterHero).
function parseStages(words) {
  const errors = [], stages = [];
  for (const stageRaw of words) {
    const targets = [];
    let off = false;
    for (const part of stageRaw.split(',')) {
      const t = part.trim();
      if (!t) continue;
      const [nameRaw, capRaw] = t.split(':');
      const nm = nameRaw.toLowerCase();
      if (nm === 'off' || nm === 'none') { off = true; continue; }
      const attr = ATTR[nm];
      if (!attr) { errors.push(`unknown heropoints target "${nameRaw}" (use attack/politics/intel/off)`); continue; }
      let cap;
      if (capRaw === undefined || capRaw === '*') cap = Infinity;      // "int" == "int:*"
      else if (capRaw.toLowerCase() === 'any') cap = 0;                // "pol:any" == don't
      else {
        cap = parseInt(capRaw, 10);
        if (!Number.isFinite(cap) || cap < 0) { errors.push(`bad heropoints cap "${t}"`); continue; }
      }
      targets.push({ attr, cap, raw: t });
    }
    if (off) stages.push({ off: true, targets: [], raw: stageRaw });
    else if (targets.length) stages.push({ off: false, targets, raw: stageRaw });
  }
  return { stages, errors };
}

// ============================================================================
// Reading the goal list
// ============================================================================

// Collect one hero-string goal's rules in order, honouring /reset.
function rulesFor(goals, name) {
  const out = [];
  for (const g of goals || []) {
    if (g.name !== name) continue;
    if (g.reset) { out.length = 0; continue; }
    if (g.spec && !(g.spec.errors && g.spec.errors.length)) out.push(g);
  }
  return out;
}

// wiki KeepHeroes / KeepCapturedHeroes defaults (note the captured one is base>69,
// strictly more, where keepheroes keeps base>=69).
const DEFAULT_KEEP = 'any:level>=50|any:base>=69';
const DEFAULT_KEEP_CAPTURED = 'any:level>=200|any:base>69';
const DEFAULT_SPAM = 'any:base<=69,level<50';

// config hero:<switch>   wiki: Hero
//   0 off, 1 level & reward only, XY = keep X politics + Y intel, rest attack.
function heroPolicy(config = {}) {
  const raw = config.hero;
  if (raw === undefined || raw === null || raw === '') {
    return { switch: null, manage: false, mayFire: false, keepPol: 0, keepInt: 0, why: 'config hero not set (defaults to 0 = hero management off)' };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { switch: raw, manage: false, mayFire: false, keepPol: 0, keepInt: 0, why: `config hero:${raw} not understood` };
  if (n === 0) return { switch: 0, manage: false, mayFire: false, keepPol: 0, keepInt: 0, why: 'config hero:0 — hero management off' };
  if (n === 1) return { switch: 1, manage: true, mayFire: false, keepPol: 0, keepInt: 0, why: 'config hero:1 — level & reward only, never fire' };
  if (n >= 10 && n <= 99) return { switch: n, manage: true, mayFire: true, keepPol: Math.floor(n / 10), keepInt: n % 10, why: `config hero:${n} — keep ${Math.floor(n / 10)} politics + ${n % 10} intel, rest attack` };
  return { switch: n, manage: true, mayFire: false, keepPol: 0, keepInt: 0, why: `config hero:${n} is not one of 0/1/10..22 — treating it as level-only` };
}

// A hero we hold prisoner (status 4), or one the caller has recorded as captured.
function isCaptive(h, state) {
  if (num(h.status) === STATUS.CAPTIVE) return true;
  const set = state && state.capturedHeroes;
  return !!(set && (Array.isArray(set) ? set.includes(h.id) : set[h.id]));
}

// Refuse to act on a roster that does not look fully loaded. Heroes arrive by
// server.HeroUpdate pushes, so an empty or half-built list is a real possibility
// and firing off one is unrecoverable.
function rosterProblems(castle) {
  const problems = [];
  const heroes = castle && castle.heros;
  if (!Array.isArray(heroes)) return ['hero list has not arrived yet'];
  if (!heroes.length) return ['no heroes in this city'];
  for (const h of heroes) {
    if (h.id === undefined || h.id === null) { problems.push('a hero has no id'); break; }
    if (typeof h.name !== 'string' || !h.name) { problems.push(`hero ${h.id} has no name`); break; }
    if (!Number.isFinite(Number(h.level))) { problems.push(`hero ${h.name} has no level`); break; }
    if (h.status === undefined || h.status === null) { problems.push(`hero ${h.name} has no status`); break; }
  }
  return problems;
}

// --------------------------------------------------------- feasting hall size
// The castle carries no hero cap (no such field in CastleBean.as), but the inn's
// reply does say how many slots are free: posCount (HeroListResponse.as:18,44-46;
// Tavern.as:586-591 keeps it for the hire window's free-slot line). Game.noteHall
// records it per city with the roster size at that moment, so the hall's size is
// posCount plus the heroes then, and free = size - heroes now. A reading is
// only asked for when a goal needs it, at most every HALL_READ_MS (makeRoom).
// With no reading the size is INFERRED, as before, as one slot per Feasting
// Hall level; when even that cannot be worked out, nothing is fired for room.
const HALL_READ_MS = 10 * 60e3;

// This city's last posCount reading, or null — also when the Feasting Hall has
// changed level since, as the hall's size changed with it.
function hallSeen(game, castle) {
  if (!game || !game.hallSeen || !castle) return null;
  const id = typeof game.castleId === 'function' ? game.castleId(castle) : (castle.castleId ?? castle.id);
  const s = game.hallSeen[id];
  if (!s || !Number.isFinite(Number(s.capacity))) return null;
  const fh = (castle.buildings || []).find((b) => Number(b.typeId) === 27);
  if (s.fhLevel !== null && s.fhLevel !== undefined && fh && Number(fh.level) !== Number(s.fhLevel)) return null;
  return s;
}

function feastingHall(ctx) {
  const castle = ctx.castle || {};
  const heroes = (castle.heros || []);
  const seen = hallSeen(ctx.game, castle);
  let capacity = null, source = 'unknown';
  if (castle.heroCapacity !== undefined && castle.heroCapacity !== null && Number.isFinite(Number(castle.heroCapacity))) {
    capacity = Number(castle.heroCapacity); source = 'castle.heroCapacity';
  } else if (seen) {
    capacity = Number(seen.capacity);
    source = `the inn: ${seen.posCount} free with ${seen.heroes} hero(es), ${Math.round((Date.now() - seen.at) / 60000)} min ago`;
  } else {
    const fh = (castle.buildings || []).find((b) => Number(b.typeId) === 27);   // 27 = Feasting Hall
    if (fh && Number(fh.level) > 0) { capacity = Number(fh.level); source = `feasting hall L${fh.level} (inferred: 1 slot per level)`; }
  }
  // wiki FeastingHallSpace: the wanted free slots, PLUS one the bot holds for the
  // TrainingHero "regardless of this goal". It is where HIRING stops; it is never
  // a reason to fire (wiki: "the bot does not automatically hire heroes just
  // because this goal is set"; it fires only when a task needs a slot).
  const wantFree = Math.max(0, num(ctx.config && ctx.config.feastinghallspace)) + 1;
  const used = heroes.length;
  const free = capacity === null ? null : Math.max(0, capacity - used);
  return {
    capacity, source, used, free, wantFree,
    short: free === null ? null : Math.max(0, wantFree - free),
    hireBudget: free === null ? 0 : Math.max(0, free - wantFree),
    // when the server's count was read, and whether that is recent enough to
    // fire on
    readAt: seen ? seen.at : null,
    fresh: !!seen && Date.now() - seen.at < HALL_READ_MS,
  };
}

// ============================================================================
// Plans
// ============================================================================

// How many heroes may leave to farm, given `homeheroes`. The mayor does not
// count towards the number kept home (wiki: HomeHeroes).
function farmableHeroes(ctx) {
  const goal = (ctx.goals || []).find((g) => g.name === 'homeheroes');
  const heroes = (ctx.castle.heros || []);
  const idle = heroes.filter((h) => num(h.status) === STATUS.IDLE);
  if (!goal) return { keepHome: 0, home: [], free: idle };
  const keepHome = Math.max(0, num(goal.amount));
  // Hold the WORST attack heroes back so the best ones keep farming.
  const ranked = idle.slice().sort((a, b) => attrOf(a, 'power') - attrOf(b, 'power'));
  const home = ranked.slice(0, keepHome);
  const homeIds = new Set(home.map((h) => h.id));
  return { keepHome, home, free: idle.filter((h) => !homeIds.has(h.id)) };
}

// The heroes a spam/loyalty attack may use (wiki: SpamHeroes).
function spamHeroes(ctx) {
  const rules = rulesFor(ctx.goals, 'spamheroes');
  const pool = (ctx.castle.heros || []).filter((h) => num(h.status) === STATUS.IDLE);
  const specs = rules.length ? rules.map((r) => r.spec) : [parseHeroString(DEFAULT_SPAM)];
  return pool.filter((h) => specs.some((s) => matchHero(h, s, pool)));
}

// config training / training10 (wiki): NPC farming drops from every 8h to 1h.
function npcCooldownMs(ctx, npcLevel) {
  const cfg = ctx.config || {};
  const EIGHT = 8 * 3600e3, ONE = 3600e3;
  if (Number(npcLevel) === 10) return num(cfg.training10) === 1 ? ONE : EIGHT;
  const t = num(cfg.training);
  return (t === 1 || t === 2) ? ONE : EIGHT;
}
// config training:2 means "farm hourly, but send no transports".
function npcUsesTransports(ctx) { return num((ctx.config || {}).training) !== 2; }

// ------------------------------------------------------------------ firing
// keepheroes / keepcapturedheroes / herofirelimit all land here, because they
// answer one question between them: which hero, if any, may be dismissed.
//
// Treat firing as IRREVERSIBLE: whether a Stone of Finding brings a dismissed
// hero back is unverified. NEAT fires only when a task needs a slot — the
// TrainingHero arriving, or a hire (wiki Hero, FastHero) — and config
// feastinghallspace is only where hiring stops (wiki FeastingHallSpace), never
// a reason to fire. So a hero is dismissed only
//   - with keepheroes /always (ours: fire whatever no keep rule protects), or
//   - through makeRoom(), for a training hero on its way here or a hire;
// one per pass (/max:n raises it), never the last hero, never off a
// half-loaded roster, and never within FIRE_COOLDOWN_MS of the last one.
const FIRE_COOLDOWN_MS = 60e3;

// The keep rules in force, and which one (if any) protects a hero. A prisoner
// (status 4), or a hero recorded as taken from another player, is judged by
// keepcapturedheroes; everyone else by keepheroes / herofirelimit.
function keepRules(ctx, state = {}) {
  const goals = ctx.goals || [];
  const keepGoals = rulesFor(goals, 'keepheroes');
  const fireLimit = goals.find((g) => g.name === 'herofirelimit' && g.spec);
  const captGoals = rulesFor(goals, 'keepcapturedheroes');
  const keepSpecs = keepGoals.map((g) => g.spec);
  if (fireLimit) keepSpecs.push(fireLimit.spec);
  const usedDefaultKeep = !keepSpecs.length;
  if (usedDefaultKeep) keepSpecs.push(parseHeroString(DEFAULT_KEEP));
  const captSpecs = captGoals.map((g) => g.spec);
  if (!captSpecs.length) captSpecs.push(parseHeroString(DEFAULT_KEEP_CAPTURED));
  const heroes = ((ctx.castle && ctx.castle.heros) || []);
  const protectedBy = (h) => {
    const specs = isCaptive(h, state) ? captSpecs : keepSpecs;
    const hit = specs.find((s) => matchHero(h, s, heroes));
    return hit ? describeHeroString(hit) : null;
  };
  return {
    keepGoals, captGoals, fireLimit, protectedBy,
    keepDesc: keepSpecs.map(describeHeroString).join(' | ') + (usedDefaultKeep ? ' (default)' : ''),
  };
}

// keepheroes switches count even on a line that carries no rule ("keepheroes /max:2").
function keepSwitches(goals) {
  const sw = Object.assign({}, ...(goals || []).filter((g) => g.name === 'keepheroes').map((g) => g.switches || {}));
  return { always: !!sw.always, perPass: Math.max(1, num(sw.max) || 1) };
}

// Every hero a traininghero line names, in this city's goals or any other
// city's. Such a hero is never fired, wherever it happens to be.
function trainingHeroNames(ctx) {
  const names = new Set();
  const add = (goals) => {
    for (const g of goals || []) if (g.name === 'traininghero' && g.hero) names.add(String(g.hero).toLowerCase());
  };
  add(ctx.goals);
  const game = ctx.game;
  if (game && Array.isArray(game.castles) && typeof ctx.goalsOf === 'function') {
    for (const c of game.castles) add(ctx.goalsOf(c));
  }
  return names;
}

// The training heroes this city lists that are in another city and will come
// here on their round. The rotation (goalmods.trainingHeroPlan) moves a hero
// only between two or more cities that list it, so a hero parked in the only
// city that wants it is not coming.
function trainingHeroesDue(ctx) {
  const game = ctx.game;
  const here = ctx.castle;
  if (!game || !Array.isArray(game.castles) || typeof ctx.goalsOf !== 'function' || !here) return [];
  const idOf = (c) => (typeof game.castleId === 'function' ? game.castleId(c) : (c.castleId ?? c.id));
  const lists = (c, key) => (ctx.goalsOf(c) || []).some((x) => x.name === 'traininghero' && String(x.hero).toLowerCase() === key);
  const out = [];
  for (const g of (ctx.goals || []).filter((x) => x.name === 'traininghero' && x.hero)) {
    const key = String(g.hero).toLowerCase();
    if (game.castles.filter((c) => lists(c, key)).length < 2) continue;
    const holder = game.castles.find((c) => (c.heros || []).some((h) => String(h.name || '').toLowerCase() === key));
    if (!holder || idOf(holder) === idOf(here)) continue;
    out.push({ hero: g.hero, from: holder.name || String(idOf(holder)) });
  }
  return out;
}

// Who may go, worst first. wiki Hero: with config hero:XY it will "disregard the
// [X] best politics heroes, and then fire one of the remaining heroes with the
// worst attack score". Only idle heroes (FIREABLE) — never the mayor, anyone
// away or a prisoner — and never a training hero. A captured hero we have since
// persuaded is idle like any other and is judged by keepcapturedheroes.
function fireOrder(ctx, state, policy, rules) {
  const heroes = ((ctx.castle && ctx.castle.heros) || []);
  const trainees = trainingHeroNames(ctx);
  const reserved = new Set();
  const reserveBest = (attr, count) => {
    heroes.slice()
      .filter((h) => !reserved.has(h.id))
      .sort((a, b) => attrOf(b, attr) - attrOf(a, attr))
      .slice(0, Math.max(0, count))
      .forEach((h) => reserved.add(h.id));
  };
  reserveBest('management', policy.keepPol);
  reserveBest('stratagem', policy.keepInt);
  return heroes
    .filter((h) => FIREABLE.has(num(h.status)))
    .filter((h) => !trainees.has(String(h.name || '').toLowerCase()))
    .filter((h) => !rules.protectedBy(h))
    .filter((h) => !reserved.has(h.id))
    .sort((a, b) => attrOf(a, 'power') - attrOf(b, 'power'));
}

// Everything that stops a fire, whatever it is for.
function fireBlockers(ctx, state, policy) {
  const blockers = [];
  const problems = rosterProblems(ctx.castle);
  if (problems.length) blockers.push(problems[0]);
  if (!policy.mayFire) blockers.push(policy.why);
  if (((ctx.castle && ctx.castle.heros) || []).length - 1 < 1) blockers.push('this is the only hero in the city');
  const sinceFire = Date.now() - num(state.lastFireAt);
  if (state.lastFireAt && sinceFire < FIRE_COOLDOWN_MS) {
    blockers.push(`fired a hero ${Math.round(sinceFire / 1000)}s ago, waiting out the cooldown`);
  }
  return blockers;
}

function fireActions(list, reason, keepDesc) {
  return list.map((h) => ({
    kind: 'fireHero',
    heroId: h.id, heroName: h.name,
    heroStatus: num(h.status), heroLevel: num(h.level),
    attack: attrOf(h, 'power'), base: heroBase(h),
    reason,
    label: `FIRE ${h.name} (L${num(h.level)}, att ${attrOf(h, 'power')}, base ${heroBase(h)}, idle) — ${reason}; ` +
           `matches no keep rule [${keepDesc}] — irreversible`,
  }));
}

// Prisoners take hall slots too. NEAT would dismiss an unprotected one to make
// room; this bot never does (see captivesPlan), so it only says who is there.
function prisonerNote(ctx) {
  const p = ((ctx.castle && ctx.castle.heros) || []).filter((h) => num(h.status) === STATUS.CAPTIVE);
  if (!p.length) return '';
  return `; ${p.length} prisoner(s) hold slots (${p.map((h) => h.name).join(', ')}) — never released automatically, use  release <name>  by hand`;
}

const mayReadHall = (state) => Date.now() - num(state && state.hallReadAt) >= HALL_READ_MS;
const readHallAction = (ctx, why) => ({
  kind: 'readHall',
  label: `read ${(ctx.castle && ctx.castle.name) || 'this city'}'s free hero slots from the inn (${why})`,
});

// makeRoom(ctx, state, { need, reason }) — for a task that needs `need` free
// slots in this city's Feasting Hall: a training hero on its way here (keepPlan
// calls it), or a hire (for the hiring step). Returns a plan, { note, actions,
// hall, blockers?, fireable? }. It asks the inn for the hall's free slots when
// they have never been read here, and again before a fire when the reading is
// older than HALL_READ_MS — never more often than that per city — and fires by
// the NEAT rule (fireOrder) only once the hall is short.
function makeRoom(ctx, state = {}, { need = 1, reason = 'a hero needs a slot' } = {}) {
  const policy = heroPolicy(ctx.config || {});
  const heroes = ((ctx.castle && ctx.castle.heros) || []);
  const hall = feastingHall(ctx);
  const say = (s) => `${reason}: ${s}`;
  const freeLine = hall.free === null ? 'hall size unknown' : `${hall.free} slot(s) free`;
  const full = hall.free !== null && hall.free < need;
  const problems = rosterProblems(ctx.castle);
  if (problems.length) return { note: say(`waiting — ${problems[0]}`), blockers: [problems[0]], hall, actions: [] };
  if (!policy.mayFire) {
    // nobody may be fired, so the hall's exact size would change nothing: no read
    return {
      note: say(full ? `the hall is full (${freeLine}), and ${policy.why}${prisonerNote(ctx)}` : freeLine),
      blockers: full ? [policy.why] : [], hall, actions: [],
    };
  }
  const read = (why) => ({ note: say(`${freeLine} (${hall.source}) — asking the inn first, ${why}`), hall, actions: [readHallAction(ctx, reason)] });
  if (!hall.readAt && mayReadHall(state)) return read('as the server knows the hall\'s size');
  if (hall.free === null) return { note: say('hall size unknown, so nothing is fired for room'), blockers: ['feasting hall size unknown'], hall, actions: [] };
  const short = Math.max(0, need - hall.free);
  if (short <= 0) return { note: say(freeLine), hall, actions: [] };
  // a fire cannot be taken back: rest it on a recent count
  if (!hall.fresh && mayReadHall(state)) return read('to be sure it is full before firing');

  const rules = keepRules(ctx, state);
  const at = `the hall is full (${hall.used}/${hall.capacity}, ${hall.source})`;
  const blockers = fireBlockers(ctx, state, policy);
  if (blockers.length) return { note: say(`${at}, not firing: ${blockers[0]}${prisonerNote(ctx)}`), blockers, hall, actions: [] };
  const fireable = fireOrder(ctx, state, policy, rules);
  if (!fireable.length) return { note: say(`${at}, but every hero is protected or busy${prisonerNote(ctx)}`), hall, fireable, actions: [] };
  const take = Math.min(short, keepSwitches(ctx.goals).perPass, fireable.length, heroes.length - 1);
  const actions = fireActions(fireable.slice(0, take), reason, rules.keepDesc);
  return { note: say(`${at} -> firing ${actions.length} of ${fireable.length} fireable${prisonerNote(ctx)}`), hall, fireable, actions };
}

function keepPlan(ctx, state = {}) {
  const goals = ctx.goals || [];
  const policy = heroPolicy(ctx.config || {});
  const rules = keepRules(ctx, state);
  const hasHeroGoal = rules.keepGoals.length || rules.captGoals.length || rules.fireLimit ||
    (ctx.config && ctx.config.feastinghallspace !== undefined) || policy.switch !== null;
  if (!hasHeroGoal) return null;

  const heroes = (ctx.castle.heros || []);
  const hall = feastingHall(ctx);
  const rosterLine = `${heroes.length} hero(es)` +
    (hall.capacity === null ? ', hall size unknown' : `, ${hall.free}/${hall.capacity} slot(s) free (want ${hall.wantFree})`);
  const head = `heroes: ${rosterLine} | keep: ${rules.keepDesc}`;
  const sw = keepSwitches(goals);

  // keepheroes /always: whatever no rule protects goes, a pass at a time
  if (sw.always) {
    const blockers = fireBlockers(ctx, state, policy);
    if (blockers.length) return { note: `${head} | not firing: ${blockers[0]}`, blockers, hall, actions: [] };
    const fireable = fireOrder(ctx, state, policy, rules);
    if (!fireable.length) return { note: `${head} | keepheroes /always, but every hero is protected or busy`, hall, fireable, actions: [] };
    const take = Math.min(fireable.length, sw.perPass, heroes.length - 1);
    const actions = fireActions(fireable.slice(0, take), 'keepheroes /always', rules.keepDesc);
    return { note: `${head} | keepheroes /always -> firing ${actions.length} of ${fireable.length} fireable`, hall, fireable, actions };
  }

  // A training hero on its round needs a slot here. wiki FeastingHallSpace: one
  // space "is reserved by the bot for the TrainingHero"; wiki Hero: when a task
  // "for example TrainingHero movement ... need[s] a space opened up in the
  // feasting hall", config hero decides who is fired.
  const due = trainingHeroesDue(ctx);
  if (due.length) {
    const room = makeRoom(ctx, state, { need: 1, reason: `room for traininghero ${due[0].hero} (now in ${due[0].from})` });
    return { ...room, note: `${head} | ${room.note}` };
  }

  // Nothing needs a slot, and a short feastinghallspace is no reason to fire.
  if (!policy.mayFire) return { note: `${head} | not firing: ${policy.why}`, hall, actions: [] };
  const problems = rosterProblems(ctx.castle);
  if (problems.length) return { note: `${head} | not firing: ${problems[0]}`, hall, actions: [] };
  const fireable = fireOrder(ctx, state, policy, rules);
  return { note: `${head} | ${fireable.length} fireable, none needs to go (fired only to make room, or with /always)`, hall, fireable, actions: [] };
}

// ------------------------------------------------------------- hero points
// heropoints <hero-string> <stage> [<stage>...]  -- first matching goal wins.
function allocateStages(hero, stages, points) {
  const add = { power: 0, management: 0, stratagem: 0 };
  let left = points;
  const current = (k) => attrOf(hero, k) + add[k];

  const stageList = stages.slice();
  // wiki: with no trailing "att:*", whatever is left goes to the highest stat —
  // the highest once the stages are met ("att:100,int:850" leaves intel on top),
  // so it is picked when reached. A whole Holy Water refund goes through here in
  // one pass, and the hero's stat before it would be the wrong one.
  const last = stageList[stageList.length - 1];
  const openEnded = last && !last.off && last.targets.some((t) => t.cap === Infinity);
  if (!openEnded) stageList.push({ off: false, highest: true, targets: [], raw: '(default: highest stat)' });

  let usedStage = null;
  for (const stage of stageList) {
    if (left <= 0) break;
    if (stage.off) return { add, spent: 0, stage: stage.raw, off: true };
    if (stage.highest) {
      const top = ATTR_KEYS.slice().sort((a, b) => current(b) - current(a))[0];
      stage.targets = [{ attr: top, cap: Infinity, raw: 'highest stat' }];
    }
    const open = stage.targets
      .map((t) => ({ t, deficit: t.cap === Infinity ? Infinity : Math.max(0, t.cap - current(t.attr)) }))
      .filter((x) => x.deficit > 0);
    if (!open.length) continue;                 // stage already satisfied, try the next
    usedStage = usedStage || stage.raw;

    const infinite = open.filter((x) => x.deficit === Infinity);
    if (infinite.length) {
      // everything remaining, split evenly between the open-ended targets
      let rest = left;
      infinite.forEach((x, i) => {
        const share = Math.floor(rest / infinite.length) + (i < rest % infinite.length ? 1 : 0);
        add[x.t.attr] += share;
      });
      left = 0;
      break;
    }
    // ratio-based: split this stage's points in proportion to what each target
    // still needs, capped at the deficit; anything over spills to the next stage.
    const total = open.reduce((s, x) => s + x.deficit, 0);
    const give = Math.min(left, total);
    let handed = 0;
    const shares = open.map((x) => ({ x, exact: (x.deficit / total) * give }));
    for (const s of shares) { s.n = Math.min(s.x.deficit, Math.floor(s.exact)); handed += s.n; }
    shares.sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)));
    for (const s of shares) {
      if (handed >= give) break;
      if (s.n < s.x.deficit) { s.n++; handed++; }
    }
    for (const s of shares) add[s.x.t.attr] += s.n;
    left -= handed;
  }
  return { add, spent: points - left, stage: usedStage, off: false };
}

// With config hero:1 or higher, a hero no heropoints line matches still has its
// points spent: all of them on its highest stat. wiki UpLevelHeroes: each hero
// is levelled "and its best attribute is increased", which needs config hero
// 1+; wiki HeroPoints: with no open-ended stage the rest goes "into the highest
// stat". Under hero:0 only a written rule spends anything, as before. A hero
// held by nolevelheroes is left to its owner (the wiki's own example keeps an
// intel hero's points back for later) — our reading; the wiki does not say.
function heroPointsPlan(ctx, state = {}) {
  const goals = rulesFor(ctx.goals, 'heropoints').filter((g) => g.stages && g.stages.length);
  const byDefault = heroPolicy(ctx.config || {}).manage;
  if (!goals.length && !byDefault) return null;
  const heroes = (ctx.castle.heros || []);
  const problems = rosterProblems(ctx.castle);
  if (problems.length) return goals.length ? { note: `heropoints: waiting — ${problems[0]}`, actions: [] } : null;
  const noLevel = rulesFor(ctx.goals, 'nolevelheroes');

  const actions = [], notes = [];
  let defaults = 0;
  for (const h of heroes) {
    const points = num(h.remainPoint);
    if (points <= 0) continue;
    if (num(h.status) === STATUS.CAPTIVE) continue;           // a prisoner is not ours to build
    const rule = goals.find((g) => matchHero(h, g.spec, heroes));   // first match wins (wiki)
    if (!rule && (!byDefault || noLevel.some((r) => matchHero(h, r.spec, heroes)))) continue;
    const { add, spent, stage, off } = allocateStages(h, rule ? rule.stages : [], points);
    if (off) { notes.push(`${h.name}: ${points} point(s) held (heropoints ${describeHeroString(rule.spec)} off)`); continue; }
    if (spent <= 0) continue;
    if (!rule) defaults++;
    const ruleText = rule ? describeHeroString(rule.spec) : `no heropoints rule, config hero:${(ctx.config || {}).hero}`;
    const parts = ATTR_KEYS.filter((k) => add[k] > 0).map((k) => `${ATTR_LABEL[k]} +${add[k]}`);
    actions.push({
      kind: 'addPoint',
      heroId: h.id, heroName: h.name, points: spent, add,
      // advisory only, for the report: game.addPoint recomputes the totals from the
      // live hero when the action is executed.
      totals: {
        management: attrOf(h, 'management') + add.management,
        power: attrOf(h, 'power') + add.power,
        stratagem: attrOf(h, 'stratagem') + add.stratagem,
      },
      rule: rule ? describeHeroString(rule.spec) : null, stage,
      label: `${h.name}: spend ${spent} point(s) — ${parts.join(', ')} [${ruleText} ${stage}]`,
    });
  }
  if (!goals.length && !actions.length) return null;         // the default alone, nothing to do: no note
  const note = actions.length
    ? `heropoints: ${actions.length} hero(es) with points to spend${defaults ? ` (${defaults} on the highest stat, by default)` : ''}`
    : `heropoints: ${goals.length} rule(s), nothing to spend${notes.length ? ' — ' + notes.join('; ') : ''}`;
  return { note, actions };
}

// --------------------------------------------------------------- levelling
// nolevelheroes protects heroes from being levelled; everything else with the
// experience for it gets levelled (only while config hero >= 1, as in NEAT).
function noLevelPlan(ctx) {
  const rules = rulesFor(ctx.goals, 'nolevelheroes');
  const policy = heroPolicy(ctx.config || {});
  if (!rules.length && !policy.manage) return null;
  const heroes = (ctx.castle.heros || []);
  const problems = rosterProblems(ctx.castle);
  if (problems.length) return { note: `levelling: waiting — ${problems[0]}`, actions: [] };
  const held = heroes.filter((h) => rules.some((r) => matchHero(h, r.spec, heroes)));
  const heldIds = new Set(held.map((h) => h.id));
  const heldLine = held.length ? `holding ${held.map((h) => h.name).join(', ')} at level` : 'no hero held back';

  if (!policy.manage) return { note: `levelling: ${heldLine} (config hero:0, nothing levels anyway)`, actions: [] };

  const ready = heroes.filter((h) => !heldIds.has(h.id))
    .filter((h) => num(h.status) !== STATUS.CAPTIVE)
    .filter((h) => num(h.upgradeExp) > 0 && num(h.experience) >= num(h.upgradeExp));
  const actions = ready.slice(0, 2).map((h) => ({
    kind: 'levelUp', heroId: h.id, heroName: h.name,
    label: `level up ${h.name} (L${num(h.level)}, exp ${num(h.experience)}/${num(h.upgradeExp)})`,
  }));
  return { note: `levelling: ${heldLine}; ${ready.length} hero(es) ready`, actions };
}

// ------------------------------------------------------------------- mayor
// config nomayor:1 -- no mayor is to be appointed, so the politics hero is free
// to march. Standing down is cheap and fully reversible.
function noMayorPlan(ctx) {
  const cfg = ctx.config || {};
  if (num(cfg.nomayor) !== 1) return null;
  const heroes = (ctx.castle.heros || []);
  const chief = heroes.find((h) => num(h.status) === STATUS.MAYOR || num(h.status) === STATUS.GARRISON);
  if (!chief) return { note: 'nomayor:1 — no mayor appointed, as wanted', actions: [] };
  if (num(chief.status) !== STATUS.MAYOR) return { note: `nomayor:1 — ${chief.name} is garrisoned, not mayor; leaving it alone`, actions: [] };
  return {
    note: `nomayor:1 — standing ${chief.name} down as mayor`,
    actions: [{ kind: 'dischargeChief', heroId: chief.id, heroName: chief.name, label: `discharge ${chief.name} as mayor (config nomayor:1)` }],
  };
}

// --------------------------------------------------------- feasting hall room
// Reports hall occupancy and how many heroes may still be hired. It issues no
// actions: feastinghallspace is where hiring stops (wiki FeastingHallSpace), and
// nothing is ever fired to hold slots empty.
function feastingHallPlan(ctx) {
  const cfg = ctx.config || {};
  if (cfg.feastinghallspace === undefined) return null;
  const hall = feastingHall(ctx);
  if (hall.capacity === null) {
    return { note: `feastinghallspace:${num(cfg.feastinghallspace)} — ${hall.used} hero(es), hall size unknown (no Feasting Hall in the building list, and the inn not read), so no hiring`, hall, actions: [] };
  }
  const line = `feastinghallspace:${num(cfg.feastinghallspace)} — ${hall.used}/${hall.capacity} used, ${hall.free} free, want ${hall.wantFree} free (incl. 1 for traininghero; ${hall.source})`;
  if (hall.short > 0) return { note: `${line} — ${hall.short} slot(s) short of it: no hiring, and nobody is fired for it`, hall, actions: [] };
  return { note: `${line} — may hire ${hall.hireBudget} more`, hall, actions: [] };
}

// ---------------------------------------------------------------- prisoners
// Prisoners we hold (status 4) are written into state.capturedHeroes, so that one
// we later persuade — idle and ours, but taken from another player — is judged
// by keepcapturedheroes rather than keepheroes (wiki KeepCapturedHeroes). That
// assumes persuasion keeps the hero's id (unverified). Records of heroes no
// longer in the city are dropped once the roster looks whole.
//
// NEAT also treats a prisoner as a fire candidate when a slot is needed. This
// bot never dismisses one by itself: the prisoner may be a hero of your own
// other account, and releasing it from the captor's side loses it (a Stone of
// Finding on the owner's side brings it home instead). `release <name>` does it
// by hand, and refuses anyone who is not a prisoner.
function captivesPlan(ctx, state = {}) {
  const castle = ctx.castle || {};
  const heroes = castle.heros || [];
  const prisoners = heroes.filter((h) => num(h.status) === STATUS.CAPTIVE);
  let set = state.capturedHeroes;
  if (Array.isArray(set)) set = Object.fromEntries(set.map((id) => [id, true]));
  if (prisoners.length) {
    set = set || {};
    for (const h of prisoners) {
      if (h.id === undefined || h.id === null) continue;
      const was = set[h.id] && typeof set[h.id] === 'object' ? set[h.id] : {};
      set[h.id] = { name: h.name, level: num(h.level), at: was.at || Date.now() };
    }
  }
  if (set && !rosterProblems(castle).length) {
    const here = new Set(heroes.map((h) => String(h.id)));
    for (const id of Object.keys(set)) if (!here.has(String(id))) delete set[id];
  }
  if (set) state.capturedHeroes = set;
  if (!prisoners.length) return null;
  return {
    note: `prisoners: ${prisoners.map((h) => `${h.name} L${num(h.level)}`).join(', ')} — held, never released automatically (release <name> by hand)`,
    prisoners, actions: [],
  };
}

// config training / training10 -- reported so the npc goal can pick it up.
function trainingPlan(ctx) {
  const cfg = ctx.config || {};
  if (cfg.training === undefined && cfg.training10 === undefined) return null;
  const bits = [];
  if (cfg.training !== undefined) bits.push(`npc every ${npcCooldownMs(ctx, 5) / 3600e3}h${npcUsesTransports(ctx) ? '' : ', no transports'}`);
  if (cfg.training10 !== undefined) bits.push(`npc10 every ${npcCooldownMs(ctx, 10) / 3600e3}h`);
  return { note: `training: ${bits.join(', ')}`, actions: [] };
}

function homeHeroesPlan(ctx) {
  const goal = (ctx.goals || []).find((g) => g.name === 'homeheroes');
  if (!goal) return null;
  const { keepHome, home, free } = farmableHeroes(ctx);
  return {
    note: `homeheroes ${keepHome}: keeping ${home.map((h) => h.name).join(', ') || 'nobody'} home, ${free.length} hero(es) free to farm`,
    home, free, actions: [],
  };
}

function spamHeroesPlan(ctx) {
  const rules = rulesFor(ctx.goals, 'spamheroes');
  if (!rules.length) return null;
  const usable = spamHeroes(ctx);
  return {
    note: `spamheroes ${rules.map((r) => describeHeroString(r.spec)).join(' | ')}: ${usable.length} idle hero(es) usable`,
    heroes: usable, actions: [],
  };
}

// ============================================================================
// Executors -- the only place that talks to the game.
// ============================================================================
const executors = {
  // hero.fireHero(castleId, heroId)  -- HeroCommand.as:fireHero
  // Re-checked here because a plan can be a tick old by the time it runs. The
  // engine hands over the city's state (engine.js generic executor loop), and a
  // fire that went through starts the cooldown the plans read.
  fireHero: async (game, castle, a, state) => {
    const live = (castle.heros || []).find((h) => h.id === a.heroId);
    if (!live) throw new Error(`${a.heroName} is no longer in this city — not firing`);
    if (String(live.name) !== String(a.heroName)) throw new Error(`hero ${a.heroId} is now "${live.name}", not "${a.heroName}" — not firing`);
    if (!FIREABLE.has(num(live.status))) throw new Error(`${a.heroName} is ${STATUS_NAME[num(live.status)] || 'busy'} now — not firing`);
    const r = await game.fireHero(game.castleId(castle), a.heroId);
    if (r && r.ok === 1 && state) state.lastFireAt = Date.now();
    return r;
  },

  // hero.getHerosListFromTavern(castleId) — only a read: Game.tavernList notes
  // the reply's posCount, which feastingHall uses from then on. The attempt is
  // stamped first, so a reply without posCount is not asked again for
  // HALL_READ_MS.
  readHall: async (game, castle, a, state) => {
    if (state) state.hallReadAt = Date.now();
    const r = await game.tavernList(game.castleId(castle));
    if (!r || r.ok !== 1) return r || { ok: 0, errorMsg: 'no reply from the inn' };
    if (r.posCount === undefined || r.posCount === null) return { ok: 0, errorMsg: 'the inn\'s reply carried no free-slot count — the hall size stays inferred' };
    return { ok: 1, posCount: r.posCount };
  },

  // game.addPoint(castleId, heroObject, increments) -- it converts to the absolute
  // totals the wire expects and throws if handed a bare id, so this passes the live
  // hero and the increments and never does the arithmetic itself.
  // Why totals: HeroProperties.as:1846 sends int(heroInterior.text),
  // int(heroPower.text), int(heroWisdom.text) -- those boxes start at the hero's
  // CURRENT attribute (:1609-1611) and are bumped by 1 per point spent (:874-880).
  addPoint: async (game, castle, a) => {
    const live = (castle.heros || []).find((h) => h.id === a.heroId);
    if (!live) throw new Error(`${a.heroName} is no longer in this city`);
    const available = num(live.remainPoint);
    if (available <= 0) throw new Error(`${a.heroName} has no points left to spend`);
    const scale = Math.min(1, available / a.points);
    const add = {
      management: Math.floor(a.add.management * scale),
      power: Math.floor(a.add.power * scale),
      stratagem: Math.floor(a.add.stratagem * scale),
    };
    // game.addPoint owns the increment -> absolute-total conversion (one source of
    // truth), so hand it the live hero and the increments we want spent.
    return game.addPoint(game.castleId(castle), live, add);
  },

  // hero.levelUp(castleId, heroId)
  levelUp: async (game, castle, a) => game.levelUpHero(game.castleId(castle), a.heroId),

  // hero.dischargeChief(castleId) / hero.promoteToChief(castleId, heroId)
  dischargeChief: async (game, castle) => game.dischargeChief(game.castleId(castle)),
  promoteToChief: async (game, castle, a) => game.promoteToChief(game.castleId(castle), a.heroId),
};

const plans = {
  // captives first: it records prisoners before keepheroes judges anyone
  captives: (ctx, state) => captivesPlan(ctx, state || {}),
  keepheroes: (ctx, state) => keepPlan(ctx, state || {}),
  heropoints: (ctx, state) => heroPointsPlan(ctx, state || {}),
  nolevelheroes: (ctx) => noLevelPlan(ctx),
  feastinghallspace: (ctx) => feastingHallPlan(ctx),
  nomayor: (ctx) => noMayorPlan(ctx),
  homeheroes: (ctx) => homeHeroesPlan(ctx),
  spamheroes: (ctx) => spamHeroesPlan(ctx),
  training: (ctx) => trainingPlan(ctx),
};

module.exports = {
  parsers, plans, executors,
  // reusable pieces for other goals
  parseHeroString, matchHero, matchHeroes, describeHeroString,
  attrOf, addedOf, baseOf, heroBase, dominant,
  STATUS, STATUS_NAME, FIREABLE, ATTR, FIELDS,
  heroPolicy, feastingHall, hallSeen, farmableHeroes, spamHeroes, npcCooldownMs, npcUsesTransports,
  isCaptive, rosterProblems, allocateStages, parseStages,
  // for the hiring step and the traininghero move: free a slot by the NEAT rule
  makeRoom, fireOrder, keepRules, trainingHeroesDue, trainingHeroNames,
  DEFAULT_KEEP, DEFAULT_KEEP_CAPTURED, DEFAULT_SPAM, FIRE_COOLDOWN_MS, HALL_READ_MS,
};
