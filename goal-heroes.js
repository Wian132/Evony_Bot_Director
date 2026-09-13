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
// Two things the caller owns in the per-city state object:
//   state.lastFireAt      set to Date.now() after a fireHero succeeds — the fire
//                         cooldown is a no-op until something writes it
//   state.capturedHeroes  { heroId: true } for heroes taken from another player,
//                         which is what routes them to keepcapturedheroes; a
//                         prisoner still in the cell is status 4 and is spotted
//                         without it
//
// Sources (all read offline):
//   src/scripts/com/evony/client/action/HeroCommand.as    command + param names
//   src/scripts/com/evony/common/beans/HeroBean.as        hero fields
//   src/scripts/com/evony/common/constants/HeroConstants.as + view/module/herosMansion/HeroLabel.as
//                                                         status codes and their labels
//   src/scripts/view/module/herosMansion/HeroProperties.as  what hero.addPoint actually expects
//   http://guide.neatportal.com/wiki/{HeroString,KeepHeroes,...}

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
function baseOf(h, key) { return attrOf(h, key) - addedOf(h, key); }
// A hero's "base" with no attribute named is its best natural attribute.
function heroBase(h) { return Math.max(...ATTR_KEYS.map((k) => baseOf(h, k))); }
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

// wiki KeepHeroes / KeepCapturedHeroes defaults.
const DEFAULT_KEEP = 'any:level>=50|any:base>=69';
const DEFAULT_KEEP_CAPTURED = 'any:level>=200|any:base>=69';
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
// The client never carries a hero cap (no such field in CastleBean.as), so it is
// derived from the Feasting Hall level: one slot per level. That is INFERRED —
// when it cannot be worked out we simply refuse to free slots.
function feastingHall(ctx) {
  const castle = ctx.castle || {};
  const heroes = (castle.heros || []);
  let capacity = null, source = 'unknown';
  if (Number.isFinite(Number(castle.heroCapacity))) {
    capacity = Number(castle.heroCapacity); source = 'castle.heroCapacity';
  } else {
    const fh = (castle.buildings || []).find((b) => Number(b.typeId) === 27);   // 27 = Feasting Hall
    if (fh && Number(fh.level) > 0) { capacity = Number(fh.level); source = `feasting hall L${fh.level} (inferred: 1 slot per level)`; }
  }
  // wiki FeastingHallSpace: the wanted free slots, PLUS one always held for the
  // travelling traininghero.
  const wantFree = Math.max(0, num(ctx.config && ctx.config.feastinghallspace)) + 1;
  const used = heroes.length;
  const free = capacity === null ? null : Math.max(0, capacity - used);
  return {
    capacity, source, used, free, wantFree,
    short: free === null ? null : Math.max(0, wantFree - free),
    hireBudget: free === null ? 0 : Math.max(0, free - wantFree),
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
// Firing is IRREVERSIBLE -- a dismissed hero is gone for good, a Stone of
// Finding only brings back heroes that ran away. So the default is to fire only
// when a slot is actually needed, one per pass, and never when anything about
// the rules or the roster is unclear.
const FIRE_COOLDOWN_MS = 60e3;

function keepPlan(ctx, state = {}, game) {
  const goals = ctx.goals || [];
  const keepGoals = rulesFor(goals, 'keepheroes');
  const fireLimit = goals.find((g) => g.name === 'herofirelimit' && g.spec);
  const captGoals = rulesFor(goals, 'keepcapturedheroes');
  const hall = feastingHall(ctx);
  const policy = heroPolicy(ctx.config || {});
  const hasHeroGoal = keepGoals.length || captGoals.length || fireLimit ||
    (ctx.config && ctx.config.feastinghallspace !== undefined) || policy.switch !== null;
  if (!hasHeroGoal) return null;

  const keepSpecs = keepGoals.map((g) => g.spec);
  if (fireLimit) keepSpecs.push(fireLimit.spec);
  const usedDefaultKeep = !keepSpecs.length;
  if (usedDefaultKeep) keepSpecs.push(parseHeroString(DEFAULT_KEEP));
  const captSpecs = captGoals.map((g) => g.spec);
  const usedDefaultCapt = !captSpecs.length;
  if (usedDefaultCapt) captSpecs.push(parseHeroString(DEFAULT_KEEP_CAPTURED));

  const keepDesc = keepSpecs.map(describeHeroString).join(' | ') + (usedDefaultKeep ? ' (default)' : '');
  const heroes = (ctx.castle.heros || []);
  const protectedBy = (h) => {
    const specs = isCaptive(h, state) ? captSpecs : keepSpecs;
    const hit = specs.find((s) => matchHero(h, s, heroes));
    return hit ? describeHeroString(hit) : null;
  };

  // --- every reason we might refuse to fire, gathered before anything is chosen
  const blockers = [];
  const problems = rosterProblems(ctx.castle);
  if (problems.length) blockers.push(problems[0]);
  if (!policy.manage) blockers.push(policy.why);
  else if (!policy.mayFire) blockers.push(policy.why);
  // switches count even on a line that carries no rule ("keepheroes /max:2")
  const switches = Object.assign({}, ...goals.filter((g) => g.name === 'keepheroes').map((g) => g.switches || {}));
  const always = !!switches.always;
  const perPass = Math.max(1, num(switches.max) || 1);

  // who could go, worst first
  // FIREABLE already rules out status 4, so a hero we hold prisoner can never
  // land here; a captured hero we have since persuaded is idle like any other
  // and is judged against keepcapturedheroes instead (see protectedBy).
  const candidates = heroes
    .filter((h) => FIREABLE.has(num(h.status)))
    .filter((h) => !protectedBy(h));

  // config hero:XY -- set aside the best X politics and best Y intel heroes
  // first, then the worst ATTACK score of what is left is the one to go.
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
  const fireable = candidates
    .filter((h) => !reserved.has(h.id))
    .sort((a, b) => attrOf(a, 'power') - attrOf(b, 'power'));

  // never empty the city
  const wouldRemain = heroes.length - 1;
  if (wouldRemain < 1) blockers.push('this is the only hero in the city');

  // how many slots do we actually need?
  let want = 0, reason = '';
  if (always) { want = fireable.length; reason = 'keepheroes /always'; }
  else if (hall.short === null) {
    if (ctx.config && ctx.config.feastinghallspace !== undefined) blockers.push('feasting hall size unknown, cannot tell whether a slot is needed');
  } else if (hall.short > 0) { want = hall.short; reason = `feasting hall needs ${hall.short} more free slot(s)`; }

  const sinceFire = Date.now() - num(state.lastFireAt);
  if (want > 0 && state.lastFireAt && sinceFire < FIRE_COOLDOWN_MS) {
    blockers.push(`fired a hero ${Math.round(sinceFire / 1000)}s ago, waiting out the cooldown`);
  }

  const rosterLine = `${heroes.length} hero(es)` +
    (hall.capacity === null ? ', hall size unknown' : `, ${hall.free}/${hall.capacity} slot(s) free (want ${hall.wantFree})`);
  const keepLine = `keep: ${keepDesc}`;

  if (blockers.length) {
    return { note: `heroes: ${rosterLine} | ${keepLine} | not firing: ${blockers[0]}`, blockers, hall, actions: [] };
  }
  if (want <= 0) {
    return { note: `heroes: ${rosterLine} | ${keepLine} | ${fireable.length} fireable, none needs to go`, hall, fireable, actions: [] };
  }
  if (!fireable.length) {
    return { note: `heroes: ${rosterLine} | ${keepLine} | ${reason}, but every hero is protected or busy`, hall, actions: [] };
  }

  const take = Math.min(want, perPass, fireable.length, heroes.length - 1);
  const actions = fireable.slice(0, take).map((h) => ({
    kind: 'fireHero',
    heroId: h.id, heroName: h.name,
    heroStatus: num(h.status), heroLevel: num(h.level),
    attack: attrOf(h, 'power'), base: heroBase(h),
    reason,
    label: `FIRE ${h.name} (L${num(h.level)}, att ${attrOf(h, 'power')}, base ${heroBase(h)}, idle) — ${reason}; ` +
           `matches no keep rule [${keepDesc}] — irreversible`,
  }));
  return {
    note: `heroes: ${rosterLine} | ${keepLine} | ${reason} -> firing ${actions.length} of ${fireable.length} fireable`,
    hall, fireable, actions,
  };
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

function heroPointsPlan(ctx, state = {}) {
  const goals = rulesFor(ctx.goals, 'heropoints').filter((g) => g.stages && g.stages.length);
  if (!goals.length) return null;
  const heroes = (ctx.castle.heros || []);
  const problems = rosterProblems(ctx.castle);
  if (problems.length) return { note: `heropoints: waiting — ${problems[0]}`, actions: [] };

  const actions = [], notes = [];
  for (const h of heroes) {
    const points = num(h.remainPoint);
    if (points <= 0) continue;
    if (num(h.status) === STATUS.CAPTIVE) continue;           // a prisoner is not ours to build
    const rule = goals.find((g) => matchHero(h, g.spec, heroes));   // first match wins (wiki)
    if (!rule) continue;
    const { add, spent, stage, off } = allocateStages(h, rule.stages, points);
    if (off) { notes.push(`${h.name}: ${points} point(s) held (heropoints ${describeHeroString(rule.spec)} off)`); continue; }
    if (spent <= 0) continue;
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
      rule: describeHeroString(rule.spec), stage,
      label: `${h.name}: spend ${spent} point(s) — ${parts.join(', ')} [${describeHeroString(rule.spec)} ${stage}]`,
    });
  }
  const note = actions.length
    ? `heropoints: ${actions.length} hero(es) with points to spend`
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
// Reports hall occupancy and how many heroes may still be hired. It deliberately
// issues no fire actions -- keepPlan is the only thing here that fires.
function feastingHallPlan(ctx) {
  const cfg = ctx.config || {};
  if (cfg.feastinghallspace === undefined) return null;
  const hall = feastingHall(ctx);
  if (hall.capacity === null) {
    return { note: `feastinghallspace:${num(cfg.feastinghallspace)} — ${hall.used} hero(es), hall size unknown (no Feasting Hall in the building list), so no hiring and no firing`, hall, actions: [] };
  }
  const line = `feastinghallspace:${num(cfg.feastinghallspace)} — ${hall.used}/${hall.capacity} used, ${hall.free} free, want ${hall.wantFree} free (incl. 1 for traininghero)`;
  if (hall.short > 0) return { note: `${line} — ${hall.short} slot(s) short; keepheroes decides whether anyone may go`, hall, actions: [] };
  return { note: `${line} — may hire ${hall.hireBudget} more`, hall, actions: [] };
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
  // Re-checked here because a plan can be a tick old by the time it runs.
  fireHero: async (game, castle, a) => {
    const live = (castle.heros || []).find((h) => h.id === a.heroId);
    if (!live) throw new Error(`${a.heroName} is no longer in this city — not firing`);
    if (String(live.name) !== String(a.heroName)) throw new Error(`hero ${a.heroId} is now "${live.name}", not "${a.heroName}" — not firing`);
    if (!FIREABLE.has(num(live.status))) throw new Error(`${a.heroName} is ${STATUS_NAME[num(live.status)] || 'busy'} now — not firing`);
    return game.fireHero(game.castleId(castle), a.heroId);
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
  keepheroes: (ctx, state, game) => keepPlan(ctx, state || {}, game),
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
  heroPolicy, feastingHall, farmableHeroes, spamHeroes, npcCooldownMs, npcUsesTransports,
  isCaptive, rosterProblems, allocateStages, parseStages,
  DEFAULT_KEEP, DEFAULT_KEEP_CAPTURED, DEFAULT_SPAM, FIRE_COOLDOWN_MS,
};
