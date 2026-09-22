'use strict';
// Hero policy goals, NEAT-compatible.
//
//   keepheroes / keepcapturedheroes / herofirelimit ... which heroes may never be fired
//   heropoints .............................. standing rule for spending level-up points
//   nolevelheroes ........................... which heroes must not be levelled
//   homeheroes .............................. how many heroes stay home when farming
//   spamheroes .............................. which heroes may be used for spam/loyalty hits
//                                             (spamHeroes(castle, running) for the script's
//                                             spamattack / loyaltyattack / capture)
//   config feastinghallspace ................ how many hero slots stay free
//   config fasthero ......................... hire from the inn to the config hero makeup
//   config hero:1+ .......................... also rewards heroes below 100 loyalty with gold
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
//                         (and its offers: the hiring step reads on this clock)
//   state.lastHire        { at, name, idsBefore } a hire not yet on the roster
//   state.rewards         { heroId: { at, loyalty, ok, msg } } the last gold reward
//                         each hero got, and whether the server took it
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
  // config fasthero:<base>   (wiki FastHero; hirePlan reads it). goals.js checks
  // a config key's value through its module's config parser, so a base that is
  // not a number 0 or more is an error in the editor, not hiring left off
  // without a word. `value` is what goals.js made of it: a number when NUM could
  // read it, the text otherwise.
  fasthero: {
    kind: 'config', multi: false,
    parse(value) {
      const errors = [];
      const n = typeof value === 'number' ? value : NaN;
      if (!Number.isFinite(n) || n < 0) {
        errors.push(`fasthero is the hero base to hire at, a number 0 (off) or more — e.g. fasthero:65, or 120+ to judge attack + intel - level; got "${value === undefined ? '' : value}"`);
      }
      return { base: Number.isFinite(n) && n >= 0 ? n : null, errors };
    },
  },

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

  // keepherobuff <hero> <excalibur|wealth|artofwar> [/below:<n>]   (OTTObot's own)
  //   Keeps a 7-day attribute item on a hero: when none is running on it, the
  //   city holding the hero uses one — only while the hero's own attribute
  //   (before the buff) is under n, when /below is given. E.g. an attack hero
  //   short of insta catapult (1526): keepherobuff OTTO excalibur /below:1526
  keepherobuff: {
    kind: 'directive', multi: true,
    parse(args) {
      const HI = require('./heroitems');
      const errors = [];
      const words = [], sw = {};
      for (const t of args) {
        const m = /^\/([a-z]+)(?::(.*))?$/i.exec(t);
        if (m) sw[m[1].toLowerCase()] = m[2] === undefined ? true : m[2];
        else words.push(t);
      }
      const [hero, ...item] = words;
      const itemId = item.length ? HI.resolveItem(item.join('')) : null;
      if (!hero || !item.length) errors.push('expected: keepherobuff <hero> <excalibur|wealth|artofwar> [/below:<n>]');
      else if (!itemId || !HI.ATTRIBUTE_ITEMS[itemId]) errors.push(`"${item.join(' ')}" is not one of the timed hero items — excalibur, wealth (The Wealth of Nations) or artofwar (The Art of War)`);
      let below = null;
      if (sw.below !== undefined) {
        below = /^\d+$/.test(String(sw.below)) ? Number(sw.below) : null;
        if (!below) errors.push(`/below:${sw.below === true ? '' : sw.below} — the attribute a hero must be under, e.g. /below:1526`);
      }
      for (const k of Object.keys(sw)) if (k !== 'below') errors.push(`/${k} is not a keepherobuff switch — only /below:<n>`);
      return { hero: hero || null, itemId: HI.ATTRIBUTE_ITEMS[itemId] ? itemId : null, below, errors };
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
// 1 and up level heroes, spend their points and reward them (rewardPlan); XY
// also fires for room, and hires when config fasthero is set (hirePlan).
function heroPolicy(config = {}) {
  const raw = config.hero;
  if (raw === undefined || raw === null || raw === '') {
    return { switch: null, manage: false, mayFire: false, keepPol: 0, keepInt: 0, why: 'config hero not set (defaults to 0 = hero management off)' };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { switch: raw, manage: false, mayFire: false, keepPol: 0, keepInt: 0, why: `config hero:${raw} not understood` };
  if (n === 0) return { switch: 0, manage: false, mayFire: false, keepPol: 0, keepInt: 0, why: 'config hero:0 — hero management off' };
  if (n === 1) return { switch: 1, manage: true, mayFire: false, keepPol: 0, keepInt: 0, why: 'config hero:1 — level & reward only, never fire or hire' };
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
  // TrainingHero. NEAT's city.checkFeastingHallSpace "counts one spot in Hall for
  // Training Hero if not in that town" (wiki City), so that slot is held while a
  // training hero on this city's round is in another city (trainingSlot) — not
  // while it is here, sitting in its own slot, and not when none comes here.
  // It is where HIRING stops; it is never a reason to fire (wiki: "the bot does
  // not automatically hire heroes just because this goal is set"; it fires only
  // when a task needs a slot).
  const training = trainingSlot(ctx);
  const spaces = Math.max(0, num(ctx.config && ctx.config.feastinghallspace));
  const wantFree = spaces + training.reserve;
  const used = heroes.length;
  const free = capacity === null ? null : Math.max(0, capacity - used);
  return {
    capacity, source, used, free, wantFree, spaces, training,
    short: free === null ? null : Math.max(0, wantFree - free),
    hireBudget: free === null ? 0 : Math.max(0, free - wantFree),
    // when the server's count was read, and whether that is recent enough to
    // fire on
    readAt: seen ? seen.at : null,
    fresh: !!seen && Date.now() - seen.at < HALL_READ_MS,
  };
}

// The slot held for a training hero: 1 while one this city lists is due here
// from another city (trainingHeroesDue), else 0.
function trainingSlot(ctx) {
  const due = trainingHeroesDue(ctx);
  return due.length ? { reserve: 1, hero: due[0].hero, from: due[0].from } : { reserve: 0, hero: null, from: null };
}

// "feastinghallspace 2 + 1 for traininghero OTTO (now in F1)" — what the kept
// slots are for, for the notes.
function keptText(hall) {
  const t = hall.training || { reserve: 0 };
  return `feastinghallspace ${hall.spaces || 0}` + (t.reserve ? ` + 1 for traininghero ${t.hero} (now in ${t.from})` : '');
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

// The heroes SpamAttack, LoyaltyAttack and Capture may send from a city (wiki
// SpamHeroes, SpamAttack, LoyaltyAttack): the idle heroes the city's
// spamheroes lines allow, or with none, NEAT's default any:base<=69,level<50.
// The lines add up in order and `spamheroes /reset` clears every line before
// it (rulesFor): a reset a script sets lands in the city's script goal layer
// (goallayers.addScriptLine), after the saved goals, so it clears those too
// until the layer is cleared or the console restarts, as the wiki says a
// script's /reset does.
//
//   spamHeroes(castle, running, opts) -> [hero, ...] in roster order
//     castle   the city's CastleBean (castle.heros)
//     running  the goals the city runs now: what goallayers.runningGoals or
//              Engine.goalsFor returns ({ goals, config }), or just the goals
//              array (config then reads as none); null means no goals at all
//     opts.minLoyalty  only heroes at this loyalty or more (SpamAttack sends
//              only heroes at 100, wiki SpamAttack)
//   spamHeroes(ctx) — the plans' form, { castle, goals, config }.
//
// Only idle heroes (status 0): never the mayor, nor a hero out or captive.
// Our own caution, where the wiki says nothing: the city's traininghero, and
// the hero config keepatthome keeps home for defence, are never spam heroes,
// whatever the lines say. spamHeroPool says which were held back and why.
function spamHeroPool(castle, running, { minLoyalty = null } = {}) {
  if (castle && castle.castle && running === undefined) { running = castle; castle = castle.castle; }
  const goals = Array.isArray(running) ? running : ((running && running.goals) || []);
  const config = (running && !Array.isArray(running) && running.config) || {};
  const lines = goals.filter((g) => g.name === 'spamheroes');
  const rules = rulesFor(goals, 'spamheroes');
  const usingDefault = !rules.length;
  const specs = usingDefault ? [parseHeroString(DEFAULT_SPAM)] : rules.map((r) => r.spec);
  const idle = ((castle && castle.heros) || []).filter((h) => num(h.status) === STATUS.IDLE);
  const allowed = idle.filter((h) => specs.some((s) => matchHero(h, s, idle)));
  const trainee = new Set(goals.filter((g) => g.name === 'traininghero' && g.hero).map((g) => String(g.hero).toLowerCase()));
  const kept = require('./goal-war').keepAttHome({ castle, goals, config }).reservedIds;
  const held = [], heroes = [];
  for (const h of allowed) {
    const why = trainee.has(String(h.name || '').toLowerCase()) ? 'the traininghero'
      : kept.has(h.id) ? 'kept home by keepatthome'
        : minLoyalty !== null && num(h.loyalty) < minLoyalty ? `loyalty ${num(h.loyalty)} (under ${minLoyalty})` : null;
    if (why) held.push({ hero: h, why }); else heroes.push(h);
  }
  return {
    heroes, held, usingDefault, reset: lines.some((g) => g.reset), lines: lines.length,
    rule: usingDefault ? DEFAULT_SPAM : rules.map((r) => describeHeroString(r.spec)).join(' | '),
  };
}
function spamHeroes(castle, running, opts) { return spamHeroPool(castle, running, opts).heroes; }

// config training / training10 (wiki): NPC farming drops from every 8.4h to 1h.
// The NPC plan's own rule (goal-npc cycleFor: training for levels 1-9,
// training10 for 10, then farmingpolicy, config farmingcycle, 8.4h), so this
// note never says something the farming does not do. Required here, not at the
// top: goal-npc requires this module.
function npcCooldownMs(ctx, npcLevel) {
  return require('./goal-npc')._internals.cycleFor(ctx, Number(npcLevel)).maxMs;
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
  const usedDefaultCapt = !captGoals.length;
  return {
    keepGoals, captGoals, fireLimit, protectedBy,
    // the captured-hero side on its own, for captivesPlan: which prisoners this
    // city keeps, and whether the line is ours or NEAT's default
    captSpecs, usedDefaultCapt,
    captProtectedBy: (h) => {
      const hit = captSpecs.find((sp) => matchHero(h, sp, heroes));
      return hit ? describeHeroString(hit) : null;
    },
    captDesc: captSpecs.map(describeHeroString).join(' | ') + (usedDefaultCapt ? ' (default)' : ''),
    keepDesc: keepSpecs.map(describeHeroString).join(' | ') + (usedDefaultKeep ? ' (default)' : ''),
  };
}

// keepheroes switches count even on a line that carries no rule ("keepheroes /max:2").
//
//   /always          fire whatever no keep rule protects, every pass
//   /max:<n>         how many may go in one pass (default 1)
//   /firebelow:<n>   OTTObot's own: when a task needs a slot and no prisoner can
//                    free one, an IDLE hero under level n that no keep rule
//                    protects may be dismissed even under config hero:1. Off
//                    unless the switch is written, because config hero:1 means
//                    "level & reward only, never fire" on most of this fleet and
//                    a dismissed hero is gone for good.
function keepSwitches(goals) {
  const sw = Object.assign({}, ...(goals || []).filter((g) => g.name === 'keepheroes').map((g) => g.switches || {}));
  const below = Number(sw.firebelow);
  return {
    always: !!sw.always,
    perPass: Math.max(1, num(sw.max) || 1),
    fireBelow: Number.isFinite(below) && below > 0 ? below : null,
  };
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

// The training heroes on a ROUND — named by two or more cities, so they are
// only ever passing through any one of them. A hero parked in the single city
// that wants it is that city's own hero and is not counted here.
function rotatingTrainingNames(ctx) {
  const out = new Set();
  const game = ctx.game;
  if (!game || !Array.isArray(game.castles) || typeof ctx.goalsOf !== 'function') return out;
  const count = new Map();
  for (const c of game.castles) {
    const seen = new Set();
    for (const g of ctx.goalsOf(c) || []) {
      if (g.name !== 'traininghero' || !g.hero) continue;
      const k = String(g.hero).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      count.set(k, (count.get(k) || 0) + 1);
    }
  }
  for (const [k, n] of count) if (n >= 2) out.add(k);
  return out;
}

// The heroes this city can call its own: not a prisoner (someone else's), and
// not a training hero that is only passing through on its round. A city whose
// whole roster is one visiting trainer is as good as empty — and it is how the
// trainer gets stuck, because it must take the mayor's office and then be stood
// down again to leave (the user, 2026-09-22).
// rotatingTrainingNames reads every city's goals, and ownHeroesHere is asked
// once per city per tick (here and from goalmods.mayorPlan) — ten cities would
// be a hundred goal reads a tick. It is not cached, because a cache a goal edit
// does not clear is worse than the reads: instead, a city holding more than this
// many heroes that are not prisoners is answered without asking at all. An
// account has ONE training hero, so such a city certainly has one of its own.
const OWN_HEROES_SHORTCUT = 3;

function ownHeroesHere(ctx) {
  const free = ((ctx.castle && ctx.castle.heros) || []).filter((h) => num(h.status) !== STATUS.CAPTIVE);
  if (free.length > OWN_HEROES_SHORTCUT) return free;
  const rotating = rotatingTrainingNames(ctx);
  return free.filter((h) => !rotating.has(String(h.name || '').toLowerCase()));
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
// For a hire (the hiring step): `extra` are inn offers counted as if already
// here when the best politics and intel heroes are set aside, so a better
// politics offer frees the weak politics hero it would replace; `eligible`
// narrows who may go (fasthero: only heroes below its bar).
function fireOrder(ctx, state, policy, rules, { extra = [], eligible = null, below = null } = {}) {
  const heroes = ((ctx.castle && ctx.castle.heros) || []);
  const trainees = trainingHeroNames(ctx);
  const reserved = new Set();
  const reserveBest = (attr, count) => {
    heroes.concat(extra)
      .filter((h) => !reserved.has(h))
      .sort((a, b) => attrOf(b, attr) - attrOf(a, attr))
      .slice(0, Math.max(0, count))
      .forEach((h) => reserved.add(h));
  };
  reserveBest('management', policy.keepPol);
  reserveBest('stratagem', policy.keepInt);
  return heroes
    .filter((h) => FIREABLE.has(num(h.status)))
    .filter((h) => !trainees.has(String(h.name || '').toLowerCase()))
    .filter((h) => !rules.protectedBy(h))
    .filter((h) => !reserved.has(h))
    .filter((h) => !eligible || eligible(h))
    // keepheroes /firebelow:<n>, the only route to a dismissal under config
    // hero:1 — and a hard level cap on top of every other rule
    .filter((h) => below === null || num(h.level) < below)
    .sort((a, b) => attrOf(a, 'power') - attrOf(b, 'power'));
}

// Everything that stops a fire, whatever it is for. `sw` are the keepheroes
// switches: /firebelow:<n> is the one thing that lets a dismissal through where
// config hero would otherwise forbid it, and even then only for an idle hero
// under level n that no keep rule protects (fireOrder's `below`).
function fireBlockers(ctx, state, policy, sw = {}) {
  const blockers = [];
  const problems = rosterProblems(ctx.castle);
  if (problems.length) blockers.push(problems[0]);
  if (!policy.mayFire && !sw.fireBelow) blockers.push(policy.why);
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

// Prisoners take hall slots too. Whether an unprotected one goes is
// captivesPlan's business, not this one's — here it only says who is in the
// cell, and points at the line that would free the slot.
function prisonerNote(ctx) {
  const p = ((ctx.castle && ctx.castle.heros) || []).filter((h) => num(h.status) === STATUS.CAPTIVE);
  if (!p.length) return '';
  const hasLine = (ctx.goals || []).some((g) => g.name === 'keepcapturedheroes' && g.spec);
  return `; ${p.length} prisoner(s) hold slots (${p.map((h) => h.name).join(', ')})`
    + (hasLine ? ' — keepcapturedheroes decides which of them go' : ' — no keepcapturedheroes line here, so none is released by itself (release <name> by hand)');
}

// ------------------------------------------------------- moving a hero out
// A city holding ten heroes of our OWN has no slot for the training hero, and
// no prisoner to release. Rather than dismiss one, the weakest idle hero is
// marched to another city of this account that has room — a reinforce march
// with one scout, the same move the traininghero rotation makes, and nothing
// is lost. (The user, 2026-09-22: "you can move heroes to a city with <9
// heroes".)
//
// A move target keeps a slot spare after the arrival, so the blockage is not
// simply pushed next door: under 9 heroes AND a free slot in its own hall.
const MOVE_TARGET_MAX_HEROES = 9;
const MOVE_COOLDOWN_MS = 5 * 60e3;

// A city's free hall slots without a full ctx: the inn's reading if there is
// one, else one slot per Feasting Hall level. Null when neither is known.
function hallFreeOf(game, castle) {
  const heroes = ((castle && castle.heros) || []).length;
  const seen = hallSeen(game, castle);
  if (seen) return Math.max(0, Number(seen.capacity) - heroes);
  const fh = ((castle && castle.buildings) || []).find((b) => Number(b.typeId) === 27);
  if (fh && Number(fh.level) > 0) return Math.max(0, Number(fh.level) - heroes);
  return null;
}

// Who may be marched out, worst attack first: idle heroes only, never a
// training hero, and never one of the best politics / intel heroes config hero
// wants kept here. Keep rules are about FIRING, so they do not hold a hero back
// from a move — it stays ours either way.
function moveOutOrder(ctx, policy) {
  const heroes = ((ctx.castle && ctx.castle.heros) || []);
  const trainees = trainingHeroNames(ctx);
  const reserved = new Set();
  const reserveBest = (attr, count) => {
    heroes.filter((h) => !reserved.has(h))
      .sort((a, b) => attrOf(b, attr) - attrOf(a, attr))
      .slice(0, Math.max(0, count))
      .forEach((h) => reserved.add(h));
  };
  reserveBest('management', policy.keepPol);
  reserveBest('stratagem', policy.keepInt);
  return heroes
    .filter((h) => FIREABLE.has(num(h.status)))
    .filter((h) => !trainees.has(String(h.name || '').toLowerCase()))
    .filter((h) => !reserved.has(h))
    .sort((a, b) => attrOf(a, 'power') - attrOf(b, 'power'));
}

// The nearest city of this account with room for one more hero, or null.
function moveTarget(ctx) {
  const game = ctx.game, here = ctx.castle;
  if (!game || !Array.isArray(game.castles) || !here || typeof game.castleXY !== 'function') return null;
  const mine = game.castleXY(here) || {};
  const idOf = (c) => (typeof game.castleId === 'function' ? game.castleId(c) : (c.castleId ?? c.id));
  const dist = (c) => {
    const xy = game.castleXY(c) || {};
    return Math.hypot(num(xy.x) - num(mine.x), num(xy.y) - num(mine.y));
  };
  return game.castles
    .filter((c) => idOf(c) !== idOf(here))
    .filter((c) => Array.isArray(c.heros) && c.heros.length < MOVE_TARGET_MAX_HEROES)
    .filter((c) => { const f = hallFreeOf(game, c); return f !== null && f >= 1; })
    .sort((a, b) => dist(a) - dist(b))[0] || null;
}

// A march needs troops, and this one carries a single scout. A city with none
// cannot send anyone anywhere — which is exactly how a training hero ends up
// stuck in a city it can never leave.
function scoutsIn(castle) { return num((castle && castle.troop && castle.troop.scouter) || 0); }

// Free a slot by marching the weakest idle hero to another of our cities.
// Returns a plan-shaped { note, actions } or null when no move is possible.
function moveOutPlan(ctx, state, policy, reason) {
  const hol = holidayHold(ctx);
  if (hol) return { why: hol };
  const since = Date.now() - num(state.lastHeroMoveAt);
  if (state.lastHeroMoveAt && since < MOVE_COOLDOWN_MS) return { why: `a hero was marched out ${Math.round(since / 60000)} min ago, waiting out the cooldown` };
  const order = moveOutOrder(ctx, policy);
  if (!order.length) return { why: 'no idle hero here may be moved (all away, the mayor, prisoners, the training hero or kept by config hero)' };
  if (scoutsIn(ctx.castle) < 1) return { why: 'no scout in this city to carry the march, so no hero can leave' };
  const to = moveTarget(ctx);
  if (!to) return { why: `no other city of this account has room (under ${MOVE_TARGET_MAX_HEROES} heroes and a free hall slot)` };
  const h = order[0];
  const C = require('./constants');
  const xy = ctx.game.castleXY(to) || {};
  return {
    hero: h,
    to,
    actions: [{
      kind: 'moveHeroOut',
      heroId: h.id, heroName: h.name, from: ctx.castle, to,
      rally: { from: ctx.castle, kind: 't', missionType: C.MISSION.reinforce,
        targetFieldId: C.coordsToFieldId(num(xy.x), num(xy.y)), troops: { scouter: 1 } },
      label: `move ${h.name} (L${num(h.level)}, att ${attrOf(h, 'power')}, idle) to ${to.name} — ${reason}`,
    }],
  };
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
// the NEAT rule (fireOrder) only once the hall is short. The hiring step also
// passes `extra` and `eligible` (see fireOrder) and `eligibleWhy`, what the note
// says of heroes `eligible` turned away.
function makeRoom(ctx, state = {}, { need = 1, reason = 'a hero needs a slot', extra = [], eligible = null, eligibleWhy = '' } = {}) {
  const policy = heroPolicy(ctx.config || {});
  const heroes = ((ctx.castle && ctx.castle.heros) || []);
  const hall = feastingHall(ctx);
  const say = (s) => `${reason}: ${s}`;
  const freeLine = hall.free === null ? 'hall size unknown' : `${hall.free} slot(s) free`;
  const full = hall.free !== null && hall.free < need;
  const problems = rosterProblems(ctx.castle);
  if (problems.length) return { note: say(`waiting — ${problems[0]}`), blockers: [problems[0]], hall, actions: [] };
  const sw = keepSwitches(ctx.goals);
  const rules = keepRules(ctx, state);

  // A full city is freed in the order that costs least, and only the LAST of
  // the three actually loses a hero:
  //
  //   1. a prisoner the keepcapturedheroes line does not keep. captivesPlan
  //      asks for that itself, earlier in the same pass, so here it is only
  //      reported — nothing else is done while a slot is already coming free;
  //   2. a MOVE: the weakest idle hero marched to another city of ours that has
  //      room (moveOutPlan). Nothing is lost, and it works under config hero:1,
  //      which is what most of this fleet runs;
  //   3. a dismissal, by the NEAT rule — which needs config hero:XY, or
  //      keepheroes /firebelow:<n> for a hero under that level.
  //
  // The first two do not depend on config hero, so they are tried BEFORE the
  // "nobody may be fired" answer: under hero:1 the old code stopped here and a
  // town of ten heroes stayed blocked for good.
  if (full && prisonersHere(ctx).length && !rules.usedDefaultCapt) {
    const freeable = prisonersHere(ctx).filter((h) => !rules.captProtectedBy(h));
    if (freeable.length) {
      return { note: say(`the hall is full (${freeLine}) — a prisoner is on its way out (${freeable.map((h) => h.name).join(', ')}), which frees the slot`), hall, actions: [] };
    }
  }
  let moveWhy = '';
  if (full) {
    const move = moveOutPlan(ctx, state, policy, reason);
    if (move && move.actions) {
      return { note: say(`the hall is full (${freeLine}) -> ${move.actions[0].label}, rather than dismissing anyone${prisonerNote(ctx)}`), hall, actions: move.actions };
    }
    moveWhy = move && move.why ? `; no move out either: ${move.why}` : '';
  }

  if (!policy.mayFire && !sw.fireBelow) {
    // nobody may be fired, so the hall's exact size would change nothing: no read
    return {
      note: say(full ? `the hall is full (${freeLine}), and ${policy.why}${moveWhy}${prisonerNote(ctx)}` : freeLine),
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

  const at = `the hall is full (${hall.used}/${hall.capacity}, ${hall.source})`;

  const blockers = fireBlockers(ctx, state, policy, sw);
  if (blockers.length) return { note: say(`${at}, not firing: ${blockers[0]}${moveWhy}${prisonerNote(ctx)}`), blockers, hall, actions: [] };
  const fireable = fireOrder(ctx, state, policy, rules, { extra, eligible, below: policy.mayFire ? null : sw.fireBelow });
  if (!fireable.length) return { note: say(`${at}, but every hero is protected or busy${eligibleWhy ? ` or ${eligibleWhy}` : ''}${moveWhy}${prisonerNote(ctx)}`), hall, fireable, actions: [] };
  const take = Math.min(short, sw.perPass, fireable.length, heroes.length - 1);
  const actions = fireActions(fireable.slice(0, take), reason, rules.keepDesc);
  return { note: say(`${at} -> firing ${actions.length} of ${fireable.length} fireable${moveWhy}${prisonerNote(ctx)}`), hall, fireable, actions };
}

// The prisoners sitting in this city.
function prisonersHere(ctx) {
  return ((ctx.castle && ctx.castle.heros) || []).filter((h) => num(h.status) === STATUS.CAPTIVE);
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
  const line = `feastinghallspace:${num(cfg.feastinghallspace)} — ${hall.used}/${hall.capacity} used, ${hall.free} free, want ${hall.wantFree} free (${keptText(hall)}; ${hall.source})`;
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
// RELEASING. A prisoner holds a Feasting Hall slot (EVONY-RULES.md section 5: a
// full hall cannot capture, and the training hero cannot walk into a city with
// no free slot). Taking a valley off a real player drops their level-2 or
// level-20 hero into our cell, where it is worth nothing and blocks the round —
// and nobody walks 210 cities a day looking for it (the user, 2026-09-22).
//
// So: with a `keepcapturedheroes` line set, the prisoners it does NOT protect
// are released. That is OTTObot's own reading of the goal — NEAT's version only
// protects — and it is why the line has to be written before anything goes:
// with no line at all nothing is ever released, exactly as before.
//
//   keepcapturedheroes any:level>600|any:base>145
//     keep a prisoner past level 600, or with a base over 145; release the rest.
//
// A release CANNOT be taken back, and releasing a hero of your OWN other account
// from the captor's side loses it for good (EVONY-RULES.md section 5; the owner
// uses a Stone of Finding instead). Everything below exists to make that
// impossible:
//
//   * the fleet register (db.fleetHeroes) remembers every hero every one of our
//     accounts has ever held. A captured hero leaves its owner's roster the
//     moment it is taken, so a live roster cannot answer "was this ours?" — only
//     the remembered row can. A prisoner whose ID is on the register is NEVER
//     released, whatever the keep rule says;
//   * nor is one whose NAME any hero of ours has ever carried;
//   * nothing is released at all while the register is incomplete — an account
//     that has not reported its heroes lately could be this prisoner's owner;
//   * OTTO_NO_RELEASE=1 stops every release fleet-wide;
//   * one release per pass, on a cooldown, never off a half-loaded roster;
//   * the executor re-checks the live hero BY ID: same id, same name, still a
//     prisoner. Never by name — one city can hold two heroes with the same name
//     (the user, 2026-09-22), and the wrong one must never go.
const RELEASE_COOLDOWN_MS = 60e3;
// How recently every account must have reported its heroes for the register to
// count as complete. A console snapshots every few minutes, so a day is slack.
const REGISTER_STALE_MS = 24 * 3600e3;

// The fleet register, or a stand-in a test passes as ctx.fleet:
//   { has(id) -> row|null, named(name) -> [row], coverage() -> {ok, why} }
function fleetRegister(ctx) {
  if (ctx && ctx.fleet) return ctx.fleet;
  let D = null;
  try { D = require('./db'); } catch { D = null; }
  if (!D || !D.fleetHeroes) {
    // `ok: false` matters: has() returning null here would read as "not one of
    // ours" and let a release through with nothing guarding it. Every caller
    // refuses on !ok instead.
    return { ok: false, has: () => null, named: () => [], coverage: () => ({ ok: false, why: 'the fleet hero register is not available' }) };
  }
  return {
    ok: true,
    has: (id) => D.fleetHeroes.get(id),
    named: (name) => D.fleetHeroes.byName(name),
    coverage: () => registerCoverage(D),
  };
}

// Has every account that is switched on reported its heroes recently? Until it
// has, a prisoner of ours could look like a stranger, so nothing is released.
function registerCoverage(D) {
  let accounts;
  try { accounts = D.accounts.all().filter((a) => a.enabled !== false && a.email); }
  catch (e) { return { ok: false, why: `the fleet account list could not be read (${e.message})` }; }
  if (!accounts.length) return { ok: false, why: 'no accounts are switched on, so the fleet hero register cannot be complete' };
  const seen = new Map((D.fleetHeroes.coverage() || []).map((r) => [r.accountId, r]));
  const cut = Date.now() - REGISTER_STALE_MS;
  const missing = accounts.filter((a) => { const r = seen.get(a.id); return !r || num(r.at) < cut; });
  if (missing.length) {
    const who = missing.slice(0, 4).map((a) => a.label || a.id).join(', ');
    return {
      ok: false,
      why: `the fleet hero register is not complete yet — ${missing.length} account(s) have not reported their heroes in the last `
        + `${Math.round(REGISTER_STALE_MS / 3600e3)}h (${who}${missing.length > 4 ? ', and more' : ''})`,
    };
  }
  return { ok: true, why: `${accounts.length} accounts on the register` };
}

// Why this prisoner may not be released, or null. Order matters: the register
// checks come before anything a goal line could overrule.
function releaseRefusal(h, reg, rules) {
  if (process.env.OTTO_NO_RELEASE === '1') return 'OTTO_NO_RELEASE=1 is set';
  if (h.id === undefined || h.id === null) return `${h.name} has no hero id`;
  const own = reg.has(h.id);
  if (own) {
    return `${h.name} (id ${h.id}) is OUR OWN hero — last seen on ${own.accountId} — releasing it here would lose it; `
      + 'the owner brings it home with a Stone of Finding (lostheroes, then recover)';
  }
  const named = reg.named(h.name) || [];
  if (named.length) return `a hero of ours has carried the name "${h.name}" (${named.map((r) => r.accountId).join(', ')}) — not released, in case this is it`;
  const keeps = rules.captProtectedBy(h);
  if (keeps) return `keepcapturedheroes [${keeps}] keeps it`;
  return null;
}

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

  const who = prisoners.map((h) => `${h.name} L${num(h.level)}`).join(', ');
  const rules = keepRules(ctx, state);
  const head = `prisoners: ${who}`;
  const done = (why) => ({ note: `${head} — held: ${why}`, prisoners, actions: [] });

  // With no keepcapturedheroes line the goal is not in use here: hold everyone,
  // as this bot always did. The line is the opt-in.
  if (rules.usedDefaultCapt) return done('no keepcapturedheroes line here, so none is released by itself (release <name> by hand)');

  // A roster that has not fully arrived — a console that has just logged in
  // reports a SHORT hero list — is no basis for an irreversible act.
  const problems = rosterProblems(castle);
  if (problems.length) return done(problems[0]);

  const since = Date.now() - num(state.lastReleaseAt);
  if (state.lastReleaseAt && since < RELEASE_COOLDOWN_MS) {
    return done(`released one ${Math.round(since / 1000)}s ago, waiting out the cooldown`);
  }

  const hol = holidayHold(ctx);
  if (hol) return done(hol);

  const reg = fleetRegister(ctx);
  const cover = reg.coverage();
  if (!cover.ok) return done(cover.why);

  const refusals = [], goes = [];
  for (const h of prisoners) {
    const why = releaseRefusal(h, reg, rules);
    if (why) refusals.push(`${h.name}: ${why}`);
    else goes.push(h);
  }
  const held = refusals.length ? ` | held: ${refusals.join('; ')}` : '';
  if (!goes.length) return { note: `${head} — keep: ${rules.captDesc}${held}`, prisoners, actions: [] };

  // Worst first, one a pass: a release is irreversible, so the roster is read
  // again between them.
  goes.sort((a, b) => num(a.level) - num(b.level));
  const h = goes[0];
  return {
    note: `${head} — keep: ${rules.captDesc} | releasing ${goes.length === 1 ? '' : `1 of ${goes.length}: `}${h.name}${held}`,
    prisoners,
    actions: [{
      kind: 'releaseHero',
      heroId: h.id, heroName: h.name, heroLevel: num(h.level), base: heroBase(h),
      keepDesc: rules.captDesc,
      label: `RELEASE prisoner ${h.name} (L${num(h.level)}, base ${heroBase(h)}) — matches no keepcapturedheroes rule `
        + `[${rules.captDesc}], and is not a hero of ours; frees its hall slot — irreversible`,
    }],
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

// Nothing to send: the note says which heroes a spamattack, loyaltyattack or
// capture from this city would use (spamHeroPool), so the rule can be checked
// before a script leans on it.
function spamHeroesPlan(ctx) {
  const p = spamHeroPool(ctx);
  if (!p.lines) return null;
  const names = (list) => (list.length > 8 ? `${list.slice(0, 8).join(', ')} (+${list.length - 8} more)` : list.join(', '));
  const rule = p.usingDefault ? `${p.reset ? 'reset, so NEAT\'s default ' : 'default '}${p.rule}` : p.rule;
  const held = p.held.length ? `; not used: ${p.held.map((x) => `${x.hero.name} (${x.why})`).join(', ')}` : '';
  return {
    note: `spamheroes ${rule}: ${p.heroes.length ? `spam heroes here: ${names(p.heroes.map((h) => h.name))}` : 'no idle hero here fits'}${held}`,
    heroes: p.heroes, actions: [],
  };
}

// ------------------------------------------------------------------ hiring
// config fasthero:<base>   wiki: FastHero, with Hero and FeastingHallSpace.
//
// "with config hero:10 set, you want the bot to keep 1 politics hero and the
// rest attack heroes. With config fasthero:65 set, the bot will attempt to hire
// & fire until it has found 1 65+ base politics hero and the rest 65+ base
// attack heroes." Per city, one hire a pass at most:
//   - only with config hero:10 or higher, and with over 1,000,000 gold left in
//     the city once the hire's own level x 1000 is paid (Game.hireCost);
//   - the inn is read on the hall's clock (at most every HALL_READ_MS per city,
//     shared with makeRoom), and only when a hire could follow;
//   - the offer hired is the best one the makeup wants — a politics hero while
//     fewer than X good ones are here, an intel hero while fewer than Y, else an
//     attack hero — with a base of at least fasthero: highest base first, then
//     the cheapest. Offers are judged by Game.heroBase, the formula the roster
//     is judged by, so a hire never lands below the bar;
//   - hiring stops at the hall's kept slots: feastinghallspace, plus one while a
//     training hero is on its way here (feastingHall);
//   - with the hall at that limit, one idle hero below the bar that no keep rule
//     protects is fired for a qualifying offer (makeRoom: the X best politics and
//     Y best intel heroes, the offer counted among them, are set aside and the
//     worst attack goes — never the mayor, a hero away, a prisoner or a training
//     hero), and the offer is hired on the next pass, into the slot the fire made.
// At 120 or more a hero is judged on attack + intel - level (wiki: 65 attack and
// 65 intel at level 10 is 120; unspent points count, as in Game.heroBase), and
// an intel-led hero fills an attack slot. NEAT then fires from "all available
// heroes", which takes in the mayor; this bot never fires the mayor, so it
// fires from the idle heroes there too.
//
// Left out on purpose: refreshing the inn — a refresh spends a Hero Hunting or
// game coins (Tavern.as:473-528), and the FastHero page names no refresh (it
// advises a level-1 inn, to keep hires cheap), so new offers come only as the
// inn changes its list; an offer that asks for an item (a medal or jewellery,
// HireHero.as:744-747) — a hire spends no items unasked; and hiring a hero
// below the bar only to fire it again, which the wiki's "hire & fire" may mean
// NEAT does, but which spends gold on a hero known to be unwanted.
const FAST_GOLD_FLOOR = 1e6;
const HIRE_CONFIRM_MS = 10 * 60e3;
const ROLE_WORD = { management: 'politics', stratagem: 'intel', power: 'attack' };

const fmt = (x) => Math.round(num(x)).toLocaleString('en-US');
const ago = (ms) => (ms < 90e3 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.round(ms / 60000)} min`);

// config fasthero:<base>, read; null when it is not set.
function fastHeroMode(config = {}) {
  const raw = config.fasthero;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { base: null, bad: true, why: `config fasthero:${raw} is not a number — no hiring` };
  if (n === 0) return { base: 0, off: true, why: 'config fasthero:0 — automatic hiring off' };
  return { base: n, combined: n >= 120, word: n >= 120 ? 'attack + intel - level' : 'base' };
}

// What fasthero judges a hero, or an inn offer, by.
function fastScore(h, mode) {
  if (mode && mode.combined) return attrOf(h, 'power') + attrOf(h, 'stratagem') - num(h.level) + num(h.remainPoint);
  return heroBase(h);
}

// This city's inn offers as last read (Game.noteInn), or null.
function innSeen(game, castle) {
  if (!game || !game.innSeen || !castle) return null;
  const id = typeof game.castleId === 'function' ? game.castleId(castle) : (castle.castleId ?? castle.id);
  const s = game.innSeen[id];
  return s && Array.isArray(s.offers) ? s : null;
}

// The good heroes here by role (the top attribute), and what the makeup still
// wants. A prisoner is not ours, and a training hero is only passing through.
function makeupOf(ctx, mode, policy) {
  const trainees = trainingHeroNames(ctx);
  const have = { management: 0, stratagem: 0, power: 0 };
  for (const h of ((ctx.castle && ctx.castle.heros) || [])) {
    if (num(h.status) === STATUS.CAPTIVE || trainees.has(String(h.name || '').toLowerCase())) continue;
    if (fastScore(h, mode) >= mode.base) have[dominant(h)]++;
  }
  return {
    have,
    need: {
      management: Math.max(0, policy.keepPol - have.management),
      stratagem: Math.max(0, policy.keepInt - have.stratagem),
    },
  };
}

// Politics and intel heroes up to the makeup; the rest is attack (at 120+,
// attack or intel: the combined score is the point there).
function roleWanted(role, makeup, mode) {
  if (role === 'management') return makeup.need.management > 0;
  if (role === 'stratagem') return !!mode.combined || makeup.need.stratagem > 0;
  return true;
}

// The offers worth hiring, best first — a wanted politics hero, then intel,
// then the rest, each by score and then cost — and why the others are not.
function judgeOffers(offers, { mode, makeup, gold }) {
  const ok = [], passed = [];
  for (const o of offers || []) {
    if (!o || typeof o.name !== 'string' || !o.name || !Number.isFinite(Number(o.level))) continue;
    const role = dominant(o), score = fastScore(o, mode), cost = Game.hireCost(o);
    const who = `${o.name} (${ROLE_WORD[role]}, ${mode.word} ${score}, L${num(o.level)})`;
    if (score < mode.base) { passed.push(`${who} is below ${mode.base}`); continue; }
    if (!roleWanted(role, makeup, mode)) { passed.push(`${who}: no more ${ROLE_WORD[role]} heroes wanted`); continue; }
    if (num(o.itemAmount) > 0) { passed.push(`${who} asks for ${num(o.itemAmount)} x ${o.itemId} — a hire spends no items`); continue; }
    if (!(gold - cost > FAST_GOLD_FLOOR)) { passed.push(`${who} costs ${fmt(cost)} gold, leaving ${fmt(gold - cost)}`); continue; }
    ok.push({ o, role, score, cost, who });
  }
  const rank = (x) => (x.role === 'management' ? 0 : x.role === 'stratagem' && !mode.combined ? 1 : 2);
  ok.sort((a, b) => rank(a) - rank(b) || b.score - a.score || a.cost - b.cost);
  return { ok, passed };
}

// A hire arrives on the roster by a server.HeroUpdate push. Until it has, the
// hall's count is a slot out, so nothing more is hired; one that never shows in
// HIRE_CONFIRM_MS is let go, and the inn is read afresh before the next hire.
function hireConfirm(state, heroes) {
  const h = state.lastHire;
  if (!h) return {};
  const before = new Set((h.idsBefore || []).map(String));
  const since = Date.now() - num(h.at);
  if (heroes.some((x) => String(x.name) === String(h.name) && !before.has(String(x.id)))) {
    delete state.lastHire;
    return { note: `${h.name}, hired ${ago(since)} ago, is on the roster` };
  }
  if (since < HIRE_CONFIRM_MS) return { wait: `hired ${h.name} ${ago(since)} ago — waiting for it on the roster before another hire` };
  delete state.lastHire;
  state.hireUnconfirmedAt = Date.now();
  return { note: `${h.name}, hired ${ago(since)} ago, never showed on the roster — the inn is read afresh before another hire` };
}

const innReadAction = (ctx) => ({
  kind: 'readHall',
  label: `read ${(ctx.castle && ctx.castle.name) || 'this city'}'s inn: its offers and free hero slots (fasthero)`,
});

function hirePlan(ctx, state = {}) {
  const cfg = ctx.config || {};
  const mode = fastHeroMode(cfg);
  if (!mode) return null;
  if (mode.bad || mode.off) return { note: mode.why, actions: [] };
  const head = `fasthero:${mode.base}${mode.combined ? ' (attack + intel - level)' : ''}`;
  const policy = heroPolicy(cfg);
  if (!policy.mayFire) return { note: `${head}: hires only with config hero:10 or higher — ${policy.why}`, actions: [] };
  const castle = ctx.castle || {};
  const heroes = castle.heros || [];
  const problems = rosterProblems(castle);
  if (problems.length) return { note: `${head}: waiting — ${problems[0]}`, actions: [] };

  const confirm = hireConfirm(state, heroes);
  if (confirm.wait) return { note: `${head}: ${confirm.wait}`, actions: [] };
  const bits = confirm.note ? [confirm.note] : [];
  const say = (s) => `${head}: ${bits.concat(s).join(' | ')}`;

  // wiki FastHero: "You must also have over 1 million gold in your city."
  const gold = Number(castle.resource && castle.resource.gold);
  if (!Number.isFinite(gold)) return { note: say('the city\'s gold is not known yet'), actions: [] };
  if (gold <= FAST_GOLD_FLOOR) return { note: say(`${fmt(gold)} gold here — it hires only with over ${fmt(FAST_GOLD_FLOOR)} in the city`), actions: [] };

  const hall = feastingHall(ctx);
  const room = hall.free === null ? null : hall.free - hall.wantFree;
  if (hall.free !== null) bits.push(`hall ${hall.used}/${hall.capacity}, ${hall.free} free, keeping ${hall.wantFree} (${keptText(hall)})`);
  if (room !== null && room < 0) return { note: say(`${-room} slot(s) short of that — no hiring`), hall, actions: [] };

  const makeup = makeupOf(ctx, mode, policy);
  bits.push(`${mode.word} ${mode.base}+ here: ${makeup.have.management} pol, ${makeup.have.stratagem} int, ${makeup.have.power} att ` +
    `(config hero:${policy.switch} keeps ${policy.keepPol} pol + ${policy.keepInt} int, rest attack)`);

  // At the limit only a swap brings a better hero in, so the inn is worth a
  // read only when some hero below the bar would be free to go.
  const below = (h) => fastScore(h, mode) < mode.base;
  if (room === 0) {
    if (keepSwitches(ctx.goals).always) return { note: say('full to its limit; keepheroes /always does the firing here, so fasthero hires only into a free slot'), hall, actions: [] };
    const blockers = fireBlockers(ctx, state, policy);
    if (blockers.length) return { note: say(`full to its limit, and no room can be made: ${blockers[0]}`), hall, actions: [] };
    const rules = keepRules(ctx, state);
    const trainees = trainingHeroNames(ctx);
    const junk = heroes.filter((h) => FIREABLE.has(num(h.status)) && below(h) && !rules.protectedBy(h) && !trainees.has(String(h.name || '').toLowerCase()));
    if (!junk.length) return { note: say(`full to its limit, and no idle hero below ${mode.base} may go (keep: ${rules.keepDesc})`), hall, actions: [] };
  }

  // The offers, on the hall's clock: one read every HALL_READ_MS at most.
  const inn = innSeen(ctx.game, castle);
  const innAge = inn ? Date.now() - inn.at : null;
  const fresh = !!inn && innAge < HALL_READ_MS && !(state.hireUnconfirmedAt && inn.at < state.hireUnconfirmedAt);
  if (fresh && state.hireUnconfirmedAt) delete state.hireUnconfirmedAt;       // read afresh since: done with
  if (!fresh || hall.free === null) {
    if (mayReadHall(state)) {
      return { note: say(`reading the inn for its offers${hall.free === null ? ' and the hall\'s size' : ''}`), hall, actions: [innReadAction(ctx)] };
    }
    const next = ago(Math.max(0, HALL_READ_MS - (Date.now() - num(state.hallReadAt))));
    if (hall.free === null) return { note: say(`hall size unknown, so no hiring — the inn is asked again in ${next}`), hall, actions: [] };
    return { note: say(`${inn ? `the offers are ${ago(innAge)} old` : 'the inn has not answered'} — it is read again in ${next}`), hall, actions: [] };
  }

  const { ok, passed } = judgeOffers(inn.offers, { mode, makeup, gold });
  const innLine = `inn read ${ago(innAge)} ago, ${inn.offers.length} offer(s)`;
  if (!ok.length) {
    const why = passed.length ? `: ${passed.slice(0, 3).join('; ')}${passed.length > 3 ? ` (+${passed.length - 3} more)` : ''}` : '';
    return { note: say(`${innLine}, none to hire${why}`), hall, actions: [] };
  }
  const pick = ok[0];
  const hire = {
    kind: 'hireHero', heroName: pick.o.name, level: num(pick.o.level), cost: pick.cost, role: pick.role, score: pick.score,
    label: `hire ${pick.who} from the inn for ${fmt(pick.cost)} gold — fasthero:${mode.base}, config hero:${policy.switch}`,
  };
  if (room >= 1) return { note: say(`${innLine} -> hiring ${pick.o.name}`), hall, offer: pick, actions: [hire] };

  // Full to the limit: one hero below the bar goes now; the offer comes in on
  // the next pass, into the slot that leaves.
  const made = makeRoom(ctx, state, {
    need: hall.wantFree + 1,
    reason: `fasthero: room for ${pick.who}`,
    extra: [pick.o], eligible: below, eligibleWhy: `already at ${mode.base} or more`,
  });
  return { note: say(`${innLine} | ${made.note}`), hall, offer: pick, fireable: made.fireable, actions: made.actions };
}

// -------------------------------------------------------------- empty city
// A city with NO hero at all is broken, whatever config hero says: nothing is
// mayor, so production and building run at the bare rate; no troops train,
// because the training hero trains under a mayor; nobody defends; and the city
// cannot even send the one-scout march that would fetch a hero, because a march
// needs a hero to lead it. It is also how the training hero gets stuck — it
// arrives, becomes the only hero, takes the mayor's office, and the rotation
// then has to stand it down and march it out of a city that may have nothing
// to march with (the user, 2026-09-22).
//
// So an empty city fills itself, ahead of every other hero goal and without
// waiting for config fasthero:
//
//   1. a hero BOX, best first — Ardee's Sigil of Recruitment (a level 5-9 hero
//      with one attribute around 115-130), then a Crystal of Attunement (level
//      51-70, one attribute 100-117). `shop.useGoods` with this city's castleId
//      puts the new hero straight into THIS city (EVONY-RULES.md section 5);
//   2. failing that, the inn — the best offer the city can pay for, with no
//      base bar, because any hero beats none.
//
// Guards. Right after a login the inventory has not arrived and EVERY item
// counts as not held (EVONY-RULES.md section 5), so a box is only ruled out
// once the item list has actually loaded. One box per city per EMPTY_HOLD_MS,
// and the city is left alone while a box or a hire is still unaccounted for, so
// a slow HeroUpdate never costs a second box. config hero:0 switches the whole
// thing off, like every other hero goal.
const HERO_BOXES = [
  { id: 'player.box.hero.f', name: "Ardee's Sigil of Recruitment", says: 'a level 5-9 hero, one attribute ~115-130' },
  { id: 'player.box.hero.e', name: 'Crystal of Attunement', says: 'a level 51-70 hero, one attribute ~100-117' },
];
const EMPTY_HOLD_MS = 10 * 60e3;
// How long a city must have looked empty before anything is spent on it.
//
// A console that has just logged in LIES about heroes (EVONY-RULES.md section
// 5, seen 2026-09-22: a city holding 9 reported 2, and an account holding 374
// Excaliburs printed an empty bag). The hero list arrives in server.HeroUpdate
// pushes, so "no heroes" and "the list has not come yet" look exactly alike —
// and acting on the second would open a hero box into a city that is actually
// full. Every other guard in this module is about the roster being MALFORMED;
// this one is about it being SHORT, which no field check can catch.
//
// So the city has to look empty on two passes at least this far apart. An
// honestly empty city waits a few minutes longer; a city whose list was merely
// late is never touched.
const EMPTY_SETTLE_MS = 10 * 60e3;

// An account on holiday is being held still ON PURPOSE: the goals are emptied
// before it goes (the evony-holiday-prep skill) so nothing queues troops,
// fortifications, transports or market offers while it sits there, and a
// holiday pauses everything in the game besides (EVONY-RULES.md section 5).
// Spending a hero box, hiring, or marching a hero between its cities would all
// go against that, so the two goals here that SPEND something sit out a
// holiday. Nothing else in this module acts by itself.
function holidayHold(ctx) {
  const g = ctx && ctx.game;
  if (!g) return null;
  let kind = null;
  try { const p = require('./buffs').protectionOf(g); kind = p && p.kind; }
  catch { kind = null; }
  if (kind !== 'holiday' && !(g.player && g.player.furlough)) return null;
  return 'this account is on holiday — it is being held still on purpose, so nothing is bought, hired or marched for it';
}

// How many of `itemId` the account holds: a number, or null while the
// inventory has never loaded (which is NOT the same as none).
function itemsHeld(game, itemId) {
  const items = game && game.player && game.player.items;
  if (!Array.isArray(items) || !items.length) return null;
  return Number((items.find((i) => i.id === itemId) || {}).count || 0);
}

function emptyCityPlan(ctx, state = {}) {
  const castle = ctx.castle || {};
  const heroes = castle.heros;
  // The list must have ARRIVED. `undefined` is a console that has not been told
  // yet, and acting on that would open boxes into a city that is actually full.
  if (!Array.isArray(heroes)) return null;
  const own = ownHeroesHere(ctx);
  if (own.length) { delete state.emptySince; return null; }
  const policy = heroPolicy(ctx.config || {});
  const what = heroes.length
    ? `no hero of its own in ${castle.name || 'this city'} — only ${heroes.map((h) => h.name).join(', ')}, passing through or held`
    : `no heroes in ${castle.name || 'this city'}`;
  if (policy.switch === 0) return { note: `${what} — config hero:0, so nothing is hired for it`, actions: [] };
  const hol = holidayHold(ctx);
  if (hol) return { note: `${what} — ${hol}`, actions: [] };

  // It has to STAY empty: a hero list that simply had not arrived looks exactly
  // like an empty city, and a box opened on that is a box wasted.
  if (!state.emptySince) state.emptySince = Date.now();
  const settled = Date.now() - num(state.emptySince);
  if (settled < EMPTY_SETTLE_MS) {
    return {
      note: `${what} — waiting ${Math.ceil((EMPTY_SETTLE_MS - settled) / 60000)} more min to be sure the hero list really arrived `
        + '(a console that has just logged in reports a short one)',
      actions: [],
    };
  }

  const head = `${what} — nothing of its own is mayor, nothing trains, and a training hero that lands here gets stuck`;
  const since = Date.now() - num(state.emptyActedAt);
  if (state.emptyActedAt && since < EMPTY_HOLD_MS) {
    return { note: `${head}; ${state.emptyActedWhat || 'a hero'} was sent for ${Math.round(since / 60000)} min ago — waiting for it on the roster`, actions: [] };
  }

  // 1. a hero box, best first
  const held = HERO_BOXES.map((b) => ({ ...b, n: itemsHeld(ctx.game, b.id) }));
  const loaded = held.some((b) => b.n !== null);
  const box = held.find((b) => (b.n || 0) > 0);
  if (box) {
    return {
      note: `${head} -> opening a ${box.name} here (${box.n} held; ${box.says})`,
      actions: [{
        kind: 'openHeroBox', itemId: box.id, itemName: box.name, held: box.n, heroesThen: heroes.length,
        label: `use a ${box.name} in ${castle.name || 'this city'} — it has no heroes at all`,
      }],
    };
  }
  const boxLine = loaded
    ? `no hero boxes held (${held.map((b) => `${b.name}: ${b.n}`).join(', ')})`
    : 'the inventory has not loaded yet, so whether a hero box is held is not known';

  // 2. the inn. Any hero beats none, so there is no base bar here — but the
  // city still has to be able to pay, and the offers have to be fresh.
  const gold = Number(castle.resource && castle.resource.gold);
  const inn = innSeen(ctx.game, castle);
  const fresh = !!inn && Date.now() - inn.at < HALL_READ_MS;
  if (!fresh) {
    if (!mayReadHall(state)) return { note: `${head}; ${boxLine}; the inn was read too recently to ask again`, actions: [] };
    return { note: `${head}; ${boxLine} -> reading the inn for a hero to hire`, actions: [innReadAction(ctx)] };
  }
  const offers = (inn.offers || []).slice().sort((a, b) => heroBase(b) - heroBase(a));
  const canPay = offers.filter((o) => Number.isFinite(gold) && gold > Game.hireCost(o));
  if (!offers.length) return { note: `${head}; ${boxLine}; the inn has no offers`, actions: [] };
  if (!canPay.length) {
    return { note: `${head}; ${boxLine}; ${fmt(gold)} gold here — too little for any of the ${offers.length} offer(s) (cheapest ${fmt(Math.min(...offers.map((o) => Game.hireCost(o))))})`, actions: [] };
  }
  const pick = canPay[0];
  return {
    note: `${head}; ${boxLine} -> hiring ${pick.name} (L${num(pick.level)}, base ${heroBase(pick)}) from the inn for ${fmt(Game.hireCost(pick))} gold`,
    actions: [{
      kind: 'hireFirstHero', heroName: pick.name, level: num(pick.level), cost: Game.hireCost(pick), heroesThen: heroes.length,
      label: `hire ${pick.name} (L${num(pick.level)}, base ${heroBase(pick)}) for ${fmt(Game.hireCost(pick))} gold — ${castle.name || 'this city'} has no heroes at all`,
    }],
  };
}

// ----------------------------------------------------------------- rewards
// config hero:1 and up. wiki Hero: "1 - Level up & reward heroes only"; wiki
// RewardHeroes: "Finds and rewards all heroes with loyalty below 100, using
// gold." A gold reward (hero.awardGold, the Reward window's gold choice,
// AwardHero.as:647) costs the hero's level x 100 (AwardHero.as:693). Per pass:
//   - the hero with the lowest loyalty first (then the higher level) the city
//     can pay for while keeping a day of hero salaries back — the server's
//     herosSalary an hour, or level x 20 a hero (HireHero.as:598) — so a
//     reward never brings on the gold shortage that costs loyalty;
//   - REWARDS_PER_PASS at most, as each is one of the slice's few actions;
//   - never a prisoner (not ours), never a hero whose loyalty is not known;
//   - a reward the server refused is not asked again for REWARD_HOLD_MS, and
//     one whose new loyalty has not shown on the roster (its HeroUpdate push) is
//     waited on, for up to that long.
// The wiki's rewards are gold, so medals (hero.useItem with hero.loyalty.N) are
// never used here; useheroitem <hero> <medal> gives one by hand.
const REWARDS_PER_PASS = 1;
const REWARD_RESERVE_HOURS = 24;
const REWARD_HOLD_MS = 60 * 60e3;
const REWARD_CONFIRM_MS = 10 * 60e3;

const loyaltyOf = (h) => (h && h.loyalty !== undefined && h.loyalty !== null && h.loyalty !== '' && Number.isFinite(Number(h.loyalty)) ? Number(h.loyalty) : null);

// Gold a city keeps back from rewards: a day of its heroes' salaries.
function salaryReserve(castle) {
  const res = (castle && castle.resource) || {};
  const pushed = Number(res.herosSalary);
  const own = ((castle && castle.heros) || []).filter((h) => num(h.status) !== STATUS.CAPTIVE);
  const perHour = Number.isFinite(pushed) && pushed > 0 ? pushed : own.reduce((s, h) => s + Game.heroSalary(h), 0);
  return { perHour, reserve: perHour * REWARD_RESERVE_HOURS };
}

function rewardPlan(ctx, state = {}) {
  const policy = heroPolicy(ctx.config || {});
  if (!policy.manage) return null;
  const castle = ctx.castle || {};
  const heroes = castle.heros || [];
  if (rosterProblems(castle).length) return null;
  // forget heroes that left, and records past their hold
  const rec = state.rewards && typeof state.rewards === 'object' ? state.rewards : {};
  const here = new Set(heroes.map((h) => String(h.id)));
  for (const id of Object.keys(rec)) {
    if (!here.has(String(id)) || Date.now() - num(rec[id] && rec[id].at) >= REWARD_HOLD_MS) delete rec[id];
  }
  if (Object.keys(rec).length) state.rewards = rec; else delete state.rewards;

  const low = heroes
    .filter((h) => num(h.status) !== STATUS.CAPTIVE && loyaltyOf(h) !== null && loyaltyOf(h) < 100)
    .sort((a, b) => loyaltyOf(a) - loyaltyOf(b) || num(b.level) - num(a.level));
  if (!low.length) return null;
  const head = `rewards: ${low.length} hero(es) below 100 loyalty (${low.map((h) => `${h.name} ${loyaltyOf(h)}`).join(', ')})`;
  const gold = Number(castle.resource && castle.resource.gold);
  if (!Number.isFinite(gold)) return { note: `${head} — the city's gold is not known yet`, actions: [] };
  const { reserve } = salaryReserve(castle);

  const actions = [], held = [], poor = [];
  let spend = 0;
  for (const h of low) {
    const r = rec[h.id];
    const since = r ? Date.now() - num(r.at) : 0;
    if (r && !r.ok) { held.push(`${h.name}: refused ${ago(since)} ago (${r.msg || 'no reason given'})`); continue; }
    if (r && loyaltyOf(h) <= num(r.loyalty)) {
      held.push(since < REWARD_CONFIRM_MS ? `${h.name}: rewarded ${ago(since)} ago, waiting for its loyalty to show`
        : `${h.name}: rewarded ${ago(since)} ago and its loyalty never rose — held for an hour`);
      continue;
    }
    if (actions.length >= REWARDS_PER_PASS) continue;
    const cost = Game.awardCost(h);
    if (gold - spend - cost < reserve) { poor.push(`${h.name} (${fmt(cost)})`); continue; }
    spend += cost;
    actions.push({
      kind: 'awardGold', heroId: h.id, heroName: h.name, loyalty: loyaltyOf(h), cost, reserve,
      label: `reward ${h.name} (L${num(h.level)}, loyalty ${loyaltyOf(h)}) with ${fmt(cost)} gold`,
    });
  }
  const parts = [head];
  if (actions.length) parts.push(`rewarding ${actions.map((a) => a.heroName).join(', ')} for ${fmt(spend)} gold`);
  if (poor.length) parts.push(`too little gold for ${poor.join(', ')}: ${fmt(gold)} here, ${fmt(reserve)} kept for a day of hero salaries`);
  if (held.length) parts.push(`held: ${held.join('; ')}`);
  return { note: parts.join(' — '), actions };
}

// ---------------------------------------------------------------- keepherobuff
// A 7-day attribute item (Excalibur, The Wealth of Nations, The Art of War) kept
// on a hero. The item sets a timed buff — {attr}BuffAdded as a percent, and an
// entry in the hero's `buffs` with its endTime — and never moves the base
// attribute, so the base is what /below compares. Only the city holding the
// hero acts, and only when no such buff is running: what a second one does to a
// running buff (extend it, or waste it) is not known, so none is ever stacked.
// One use a pass; after a use the next waits HEROBUFF_CONFIRM_MS for the buff to
// show on the hero, and a refusal holds that hero for HEROBUFF_HOLD_MS.
const HEROBUFF_CONFIRM_MS = 10 * 60e3;
const HEROBUFF_HOLD_MS = 60 * 60e3;
const daysLeft = (ms) => (ms >= 86400e3 ? `${Math.floor(ms / 86400e3)}d ${Math.floor((ms % 86400e3) / 3600e3)}h`
  : ms >= 3600e3 ? `${Math.floor(ms / 3600e3)}h ${Math.floor((ms % 3600e3) / 60e3)}m` : `${Math.max(1, Math.round(ms / 60e3))} min`);

// The timed buff an attribute item leaves on a hero, if one is running:
// { msLeft } | null. msLeft is null when only the percentage shows it.
function heroBuffOn(h, attr, label, now = Date.now()) {
  const pct = num(h && h[attr + 'BuffAdded']);
  const kind = { power: /power|attack|excalibur/i, management: /management|politic|wealth/i, stratagem: /stratagem|intel|art of war/i }[attr];
  const ends = ((h && h.buffs) || [])
    .filter((b) => b && (kind.test(String(b.typeId || '')) || kind.test(String(b.descName || '')) || String(b.descName || '') === label))
    .map((b) => num(b.endTime)).filter((t) => t > now);
  if (ends.length) return { msLeft: Math.max(...ends) - now };
  return pct > 0 ? { msLeft: null } : null;
}

function heroBuffPlan(ctx, state = {}, game = null) {
  const lines = (ctx.goals || []).filter((x) => x.name === 'keepherobuff' && x.hero && x.itemId);
  if (!lines.length) return null;
  const HI = require('./heroitems');
  const castle = ctx.castle || {};
  const heroes = castle.heros || [];
  const now = Date.now();
  const rec = state.heroBuffs && typeof state.heroBuffs === 'object' ? state.heroBuffs : {};
  for (const id of Object.keys(rec)) if (now - num(rec[id] && rec[id].at) >= HEROBUFF_HOLD_MS) delete rec[id];
  const notes = [], actions = [];
  for (const line of lines) {
    const def = HI.ATTRIBUTE_ITEMS[line.itemId];
    const mine = heroes.filter((h) => String(h.name || '').toLowerCase() === String(line.hero).toLowerCase());
    if (!mine.length) continue;                              // another city's hero: that city keeps it
    for (const h of mine) {
      const who = `${h.name} (L${num(h.level)}, ${def.attr === 'power' ? 'attack' : def.attr === 'management' ? 'politics' : 'intel'} ${fmt(h[def.attr])})`;
      if (num(h.status) === STATUS.CAPTIVE) { notes.push(`${who}: a prisoner — no ${def.label}`); continue; }
      const on = heroBuffOn(h, def.attr, def.label, now);
      if (on) { notes.push(`${who}: ${def.label} on${on.msLeft !== null ? `, ${daysLeft(on.msLeft)} left` : ''}`); delete rec[h.id]; continue; }
      if (line.below && num(h[def.attr]) >= line.below) { notes.push(`${who}: at or over ${fmt(line.below)} without it — none used`); continue; }
      const r = rec[h.id];
      if (r && !r.ok) { notes.push(`${who}: ${def.label} refused ${ago(now - num(r.at))} ago (${r.msg || 'no reason given'}) — held for an hour`); continue; }
      if (r && r.ok && now - num(r.at) < HEROBUFF_CONFIRM_MS) { notes.push(`${who}: ${def.label} used ${ago(now - num(r.at))} ago, waiting for it to show`); continue; }
      const held = game ? HI.countOf(game, line.itemId) : 0;
      if (!held) { notes.push(`${who}: no ${def.label} left to use`); continue; }
      if (actions.length) { notes.push(`${who}: next pass`); continue; }
      actions.push({ kind: 'heroBuff', heroId: h.id, heroName: h.name, itemId: line.itemId, attr: def.attr, itemLabel: def.label,
        label: `${def.label} on ${who}, ${held} held` });
    }
  }
  if (Object.keys(rec).length) state.heroBuffs = rec; else delete state.heroBuffs;
  if (!notes.length && !actions.length) return null;
  return { note: `keepherobuff: ${[...notes, ...actions.map((a) => a.label)].join('; ')}`, actions };
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

  // hero.releaseHero {castleId, heroId} — a prisoner goes free, for good.
  //
  // Everything is checked AGAIN here against the live roster, because the plan
  // that chose this hero was built earlier in the slice: the same id, still
  // carrying the same name, still a prisoner. By ID, never by name — one city
  // can hold two heroes with the same name and the wrong one must never go.
  // The fleet register is asked once more too: a snapshot may have landed since
  // the plan ran and turned this prisoner into a hero of ours.
  releaseHero: async (game, castle, a, state) => {
    if (process.env.OTTO_NO_RELEASE === '1') throw new Error('OTTO_NO_RELEASE=1 is set — not releasing');
    const live = (castle.heros || []).find((h) => String(h.id) === String(a.heroId));
    if (!live) throw new Error(`${a.heroName} is no longer in this city — not releasing`);
    if (String(live.name) !== String(a.heroName)) throw new Error(`hero ${a.heroId} is now "${live.name}", not "${a.heroName}" — not releasing`);
    if (num(live.status) !== STATUS.CAPTIVE) throw new Error(`${a.heroName} is ${STATUS_NAME[num(live.status)] || 'busy'} now, not a prisoner — not releasing`);
    const reg = fleetRegister({});
    if (reg.ok === false) throw new Error('the fleet hero register cannot be read, so whether this is one of our heroes is unknown — not releasing');
    const own = reg.has(a.heroId);
    if (own) throw new Error(`${a.heroName} (id ${a.heroId}) is one of OUR heroes (${own.accountId}) — not releasing; the owner uses a Stone of Finding`);
    const r = await game.releaseHero(game.castleId(castle), a.heroId);
    if (r && r.ok === 1 && state) {
      state.lastReleaseAt = Date.now();
      if (state.capturedHeroes && typeof state.capturedHeroes === 'object') delete state.capturedHeroes[a.heroId];
    }
    return r;
  },

  // hero.getHerosListFromTavern(castleId) — only a read: Game.tavernList notes
  // the reply's posCount, which feastingHall uses from then on. The attempt is
  // stamped first, so a reply without posCount is not asked again for
  // HALL_READ_MS.
  // The hiring step reads through here too (Game.tavernList also notes the
  // offers), and when it and makeRoom both ask in one slice, one read does.
  readHall: async (game, castle, a, state) => {
    if (state && state.hallReadAt && Date.now() - num(state.hallReadAt) < 5e3) return { ok: 1, again: true };
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

  // hero.hireHero(castleId, heroName), as HireHero.as:526 sends it. The gold
  // floor is checked again (the plan can be a tick old). A hire that goes
  // through leaves the inn's list, as in the client, and the next one waits for
  // its HeroUpdate (hireConfirm). A refusal drops the offers read, so the inn is
  // read afresh — on its clock — before another try.
  hireHero: async (game, castle, a, state) => {
    const cid = game.castleId(castle);
    const gold = Number(castle.resource && castle.resource.gold);
    if (!(gold - num(a.cost) > FAST_GOLD_FLOOR)) throw new Error(`the city has ${fmt(gold)} gold now — not hiring ${a.heroName} below the ${fmt(FAST_GOLD_FLOOR)} floor`);
    const idsBefore = (castle.heros || []).map((h) => h.id);
    const r = (await game.hireHero(cid, a.heroName)) || { ok: 0, errorMsg: 'no reply from the server' };
    const inn = game.innSeen && game.innSeen[cid];
    if (r.ok === 1) {
      if (inn && Array.isArray(inn.offers)) inn.offers = inn.offers.filter((o) => String(o.name) !== String(a.heroName));
      if (state) state.lastHire = { at: Date.now(), name: a.heroName, idsBefore };
    } else if (inn) delete game.innSeen[cid];
    return r;
  },

  // hero.awardGold(castleId, heroId), level x 100 gold (AwardHero.as:647, 693).
  // Re-checked: still here, not a prisoner, still below 100, and the gold still
  // covers it with the salary reserve kept. The outcome is recorded either way:
  // rewardPlan holds a refused one back and waits for the new loyalty to show.
  awardGold: async (game, castle, a, state) => {
    const live = (castle.heros || []).find((h) => h.id === a.heroId);
    if (!live) throw new Error(`${a.heroName} is no longer in this city — not rewarding`);
    if (num(live.status) === STATUS.CAPTIVE) throw new Error(`${a.heroName} is a prisoner — not rewarding`);
    const loyalty = loyaltyOf(live);
    if (loyalty === null || loyalty >= 100) throw new Error(`${a.heroName} is at loyalty ${live.loyalty} now — not rewarding`);
    const gold = Number(castle.resource && castle.resource.gold);
    const cost = Game.awardCost(live);
    if (!(gold - cost >= num(a.reserve))) throw new Error(`the city has ${fmt(gold)} gold now — rewarding ${a.heroName} would dip into the ${fmt(a.reserve)} kept for salaries`);
    const r = (await game.awardGold(game.castleId(castle), a.heroId)) || { ok: 0, errorMsg: 'no reply from the server' };
    if (state) {
      const rec = (state.rewards = state.rewards && typeof state.rewards === 'object' ? state.rewards : {});
      rec[a.heroId] = { at: Date.now(), loyalty, ok: r.ok === 1 };
      if (r.ok !== 1) rec[a.heroId].msg = r.errorMsg || `ok=${r.ok}`;
    }
    return r;
  },

  // hero.useItem {castleId, heroId, itemId} (heroitems.useOnHero), once.
  // Re-checked: still here, still named so, not a prisoner, no buff running.
  // Recorded either way: heroBuffPlan waits for the buff to show, or holds a refusal.
  heroBuff: async (game, castle, a, state) => {
    const live = (castle.heros || []).find((h) => String(h.id) === String(a.heroId));
    if (!live) throw new Error(`${a.heroName} is no longer in this city — no ${a.itemLabel}`);
    if (String(live.name) !== String(a.heroName)) throw new Error(`hero ${a.heroId} is now "${live.name}" — no ${a.itemLabel}`);
    if (num(live.status) === STATUS.CAPTIVE) throw new Error(`${a.heroName} is a prisoner — no ${a.itemLabel}`);
    if (heroBuffOn(live, a.attr, a.itemLabel)) return { ok: 1, already: true };
    const r = await require('./heroitems').useOnHero(game, { heroId: a.heroId, castleId: game.castleId(castle), itemId: a.itemId, times: 1 });
    if (state) {
      const rec = (state.heroBuffs = state.heroBuffs && typeof state.heroBuffs === 'object' ? state.heroBuffs : {});
      rec[a.heroId] = { at: Date.now(), ok: !!(r.ok && r.used) };
      if (!(r.ok && r.used)) rec[a.heroId].msg = r.error || 'not used';
    }
    return r.ok && r.used ? { ok: 1 } : { ok: 0, errorMsg: r.error || 'not used' };
  },

  // hero.levelUp(castleId, heroId)
  levelUp: async (game, castle, a) => game.levelUpHero(game.castleId(castle), a.heroId),

  // A reinforce march carrying the hero and one scout to another city of ours,
  // to free a hall slot without dismissing anybody (moveOutPlan). The same
  // shape the traininghero rotation uses: a mayor cannot march, so it is stood
  // down first. Re-checked live by ID, because the plan ran earlier in the
  // slice: same id, same name, still at home.
  moveHeroOut: async (game, castle, a, state) => {
    const C2 = require('./constants');
    const live = (castle.heros || []).find((h) => String(h.id) === String(a.heroId));
    if (!live) throw new Error(`${a.heroName} is no longer in this city — not moving`);
    if (String(live.name) !== String(a.heroName)) throw new Error(`hero ${a.heroId} is now "${live.name}" — not moving`);
    const st = num(live.status);
    if (st !== STATUS.IDLE && st !== STATUS.MAYOR) throw new Error(`${a.heroName} is ${STATUS_NAME[st] || 'busy'} now — not moving`);
    if (scoutsIn(castle) < 1) throw new Error('no scout left in this city to carry the march');
    if (st === STATUS.MAYOR) await game.dischargeChief(game.castleId(castle));
    const xy = game.castleXY(a.to) || {};
    const bean = game.buildArmyBean({
      missionType: C2.MISSION.reinforce, heroId: a.heroId,
      targetPoint: C2.coordsToFieldId(num(xy.x), num(xy.y)), troops: { scouter: 1 },
    });
    const r = await game.newArmy(game.castleId(castle), bean);
    if (r && r.ok === 1 && state) state.lastHeroMoveAt = Date.now();
    return r;
  },

  // shop.useGoods {castleId, itemId, num:1} — a hero box opened IN this city
  // puts the hero it gives straight into this city (EVONY-RULES.md section 5).
  // Only ever for a city that still has no heroes at all when the action runs:
  // one arrived between the plan and here, and the box is not spent.
  openHeroBox: async (game, castle, a, state) => {
    if ((castle.heros || []).length > num(a.heroesThen)) throw new Error(`${castle.name} has another hero now — keeping the ${a.itemName}`);
    const have = itemsHeld(game, a.itemId);
    if (have !== null && have < 1) throw new Error(`no ${a.itemName} held any more`);
    const r = await game.useItem(game.castleId(castle), a.itemId, 1);
    if (r && r.ok === 1 && state) { state.emptyActedAt = Date.now(); state.emptyActedWhat = `a ${a.itemName}`; }
    return r;
  },

  // hero.hireHero for a city with no heroes at all — the same call the fasthero
  // step makes, but with its own record so the empty-city plan waits for the
  // hero to show before spending again.
  hireFirstHero: async (game, castle, a, state) => {
    if ((castle.heros || []).length > num(a.heroesThen)) throw new Error(`${castle.name} has another hero now — not hiring ${a.heroName}`);
    const gold = Number(castle.resource && castle.resource.gold);
    if (Number.isFinite(gold) && gold <= num(a.cost)) throw new Error(`${castle.name} has ${fmt(gold)} gold now — too little for ${a.heroName}`);
    const r = await game.hireHero(game.castleId(castle), a.heroName);
    if (r && r.ok === 1 && state) { state.emptyActedAt = Date.now(); state.emptyActedWhat = a.heroName; }
    return r;
  },

  // hero.dischargeChief(castleId) / hero.promoteToChief(castleId, heroId)
  dischargeChief: async (game, castle) => game.dischargeChief(game.castleId(castle)),
  promoteToChief: async (game, castle, a) => game.promoteToChief(game.castleId(castle), a.heroId),
};

const plans = {
  // A city with no heroes at all comes first: nothing is mayor, nothing trains,
  // and the training hero gets stuck there when it arrives.
  emptycity: (ctx, state) => emptyCityPlan(ctx, state || {}),
  // captives next: it records prisoners before keepheroes judges anyone
  captives: (ctx, state) => captivesPlan(ctx, state || {}),
  keepheroes: (ctx, state) => keepPlan(ctx, state || {}),
  heropoints: (ctx, state) => heroPointsPlan(ctx, state || {}),
  nolevelheroes: (ctx) => noLevelPlan(ctx),
  feastinghallspace: (ctx) => feastingHallPlan(ctx),
  nomayor: (ctx) => noMayorPlan(ctx),
  homeheroes: (ctx) => homeHeroesPlan(ctx),
  spamheroes: (ctx) => spamHeroesPlan(ctx),
  training: (ctx) => trainingPlan(ctx),
  herobuff: (ctx, state, game) => heroBuffPlan(ctx, state || {}, game),
  // last: a hire or a reward is the least urgent use of a slice's few actions
  fasthero: (ctx, state) => hirePlan(ctx, state || {}),
  rewards: (ctx, state) => rewardPlan(ctx, state || {}),
};

module.exports = {
  parsers, plans, executors,
  // reusable pieces for other goals
  parseHeroString, matchHero, matchHeroes, describeHeroString,
  attrOf, addedOf, baseOf, heroBase, dominant,
  STATUS, STATUS_NAME, FIREABLE, ATTR, FIELDS,
  heroPolicy, feastingHall, hallSeen, farmableHeroes, spamHeroes, spamHeroPool, npcCooldownMs, npcUsesTransports,
  isCaptive, rosterProblems, allocateStages, parseStages,
  // captured heroes: the keepcapturedheroes line releases what it does not keep
  captivesPlan, fleetRegister, registerCoverage, releaseRefusal, RELEASE_COOLDOWN_MS, REGISTER_STALE_MS,
  // for the hiring step and the traininghero move: free a slot by the NEAT rule
  makeRoom, fireOrder, keepRules, keepSwitches, trainingHeroesDue, trainingHeroNames, trainingSlot,
  // freeing a full hall without dismissing anyone
  moveOutPlan, moveOutOrder, moveTarget, hallFreeOf, scoutsIn, prisonersHere,
  MOVE_TARGET_MAX_HEROES, MOVE_COOLDOWN_MS,
  // hiring (config fasthero) and rewards (config hero:1+)
  heroBuffPlan, heroBuffOn, HEROBUFF_CONFIRM_MS, HEROBUFF_HOLD_MS,
  hirePlan, rewardPlan, fastHeroMode, fastScore, innSeen, makeupOf, judgeOffers, salaryReserve,
  // a city with no heroes at all fills itself: a hero box, else the inn
  emptyCityPlan, itemsHeld, HERO_BOXES, EMPTY_HOLD_MS, EMPTY_SETTLE_MS, ownHeroesHere, rotatingTrainingNames, holidayHold,
  OWN_HEROES_SHORTCUT,
  DEFAULT_KEEP, DEFAULT_KEEP_CAPTURED, DEFAULT_SPAM, FIRE_COOLDOWN_MS, HALL_READ_MS,
  FAST_GOLD_FLOOR, HIRE_CONFIRM_MS, REWARDS_PER_PASS, REWARD_RESERVE_HOURS, REWARD_HOLD_MS, REWARD_CONFIRM_MS,
};
