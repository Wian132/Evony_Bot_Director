'use strict';
// Goal language parser.
//
// Goals are DECLARATIVE and order-independent (unlike scripts, which run line by line).
// Three kinds, per the NEAT wiki:
//   config     key:value pairs, comma-combinable on one line
//   policy     name + /switch:value  or  positional args, one per line
//   directive  name + args, one per line
// Singleton goals are last-wins on duplicates; `multi` goals stack in order.
const C = require('./constants');

const kv = (s) => {
  const i = s.indexOf(':');
  return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
};

// Rounding here used to silently break fractional config values — the wiki's own
// `config gate:0.1` became 0 (gate disabled) and `config hiding:0.5` became 1.
// Whole results stay integers; fractions are preserved.
const NUM = (s) => {
  const m = String(s).trim().match(/^([\d.]+)\s*([kmbd])?$/i);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9, d: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  const v = parseFloat(m[1]) * mult;
  if (!isFinite(v)) return null;
  // counts (troops, resources) want integers; sub-1 values are real settings
  return Number.isInteger(v) ? v : (v >= 1 ? Math.round(v * 1000) / 1000 : v);
};

// building abbreviations used by the `build` goal (wiki: Build, Abbreviations).
// NEAT's Town Hall is `t`; `th` stays for goals written before. `t` comes first
// because the console shows the last code listed for a building.
const BUILD_ABBR = {
  t: 'Town Hall',
  a: 'Academy', b: 'Barracks', be: 'Beacon Tower', c: 'Cottage', e: 'Embassy',
  fh: 'Feasting Hall', fo: 'Forge', f: 'Farm', s: 'Sawmill', q: 'Quarry',
  i: 'Ironmine', inn: 'Inn', rs: 'Relief Station', m: 'Marketplace',
  st: 'Stable', ws: 'Workshop', w: 'Walls', th: 'Town Hall', wh: 'Warehouse', r: 'Rally Spot',
};

// Research a build ?condition? may test (wiki: Research, Abbreviations). Inside a
// condition `st` is the Stable, so Stockpile is `sp` there (wiki: Research, Plan).
// A research line reads these too, and `st` as Stockpile (goal-research.js).
const TECH_ABBR = {
  ag: 'Agriculture', lu: 'Lumbering', mas: 'Masonry', mi: 'Mining', met: 'Metal Casting',
  in: 'Informatics', ms: 'Military Science', mt: 'Military Tradition', ir: 'Iron Working',
  lo: 'Logistics', com: 'Compass', ho: 'Horseback Riding', ar: 'Archery', sp: 'Stockpile',
  med: 'Medicine', con: 'Construction', en: 'Engineering', mac: 'Machinery', pr: 'Privateering',
};

// The types a city can have many of: "barracks/resource buildings/warehouses/
// cottages" (wiki: Build). Every other type stands once per city.
const MULTI_BUILDINGS = new Set([1, 2, 3, 4, 5, 6, 7]);

const slugOf = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// A building by NEAT code or full name: t, th, b, barrack, barracks, beacontower.
function buildingOf(code) {
  const k = String(code || '').toLowerCase();
  const name = BUILD_ABBR[k];
  return C.BUILDING_BY_CODE[name ? slugOf(name) : slugOf(k)] || null;
}

function techOf(code) {
  const k = String(code || '').toLowerCase();
  const name = TECH_ABBR[k];
  return C.TECH_BY_CODE[name ? slugOf(name) : slugOf(k)] || null;
}

// Full names with a space ("iron mine:10:5") would fall apart into two groups,
// since a space separates groups on a build line. Join the known ones first.
const TWO_WORDS = /\b(beacon|feasting|iron|rally|relief|town|metal|military|horseback)\s+(tower|hall|mine|spot|station|working|casting|science|tradition|riding)\b/gi;

// A level or quantity: a whole number, never NaN read as 0 (f:10:* once
// demolished every farm).
const whole = (s) => {
  const v = s === undefined ? null : NUM(s);
  return v !== null && Number.isInteger(v) && v >= 0 ? v : null;
};

// type:level[:quantity] -> { building, typeId, level, quantity, raw } or null.
// No quantity reads as 1: the wiki doesn't say more, and 1 is the reading that
// can never demolish anything.
function buildTarget(part, errs, where = '') {
  const bits = part.split(':');
  const def = buildingOf(bits[0]);
  if (!def) { errs.push(`unknown building "${bits[0]}"${where}`); return null; }
  if (bits.length < 2 || bits.length > 3) { errs.push(`"${part}" needs buildingType:level[:quantity]${where}`); return null; }
  const level = whole(bits[1]);
  const quantity = bits.length === 3 ? whole(bits[2]) : 1;
  if (level === null) { errs.push(`"${part}": level "${bits[1]}" is not a whole number${where}`); return null; }
  if (quantity === null) { errs.push(`"${part}": quantity "${bits[2]}" is not a whole number${where}`); return null; }
  if (level > 10) { errs.push(`"${part}": buildings go to level 10 at most${where}`); return null; }
  return { building: def.name, typeId: def.typeId, level, quantity, raw: part };
}

// ?w:10?  ?met:10,w:10?  ?i:4:0?  Every part must hold. A building part reads
// like a target and holds when that target is met (i:4:0: no iron mine at L4 or
// higher); a research part holds at that level or higher.
function buildCondition(src) {
  const terms = [], errors = [];
  for (const raw of String(src).split(',')) {
    const part = raw.trim();
    if (!part) { errors.push(`empty part in ?${src}?`); continue; }
    const bits = part.split(':');
    if (buildingOf(bits[0])) {
      const t = buildTarget(part, errors, ` in ?${src}?`);
      if (t) terms.push(t);
      continue;
    }
    const tech = techOf(bits[0]);
    if (!tech) { errors.push(`unknown building or research "${bits[0]}" in ?${src}?`); continue; }
    const level = bits.length === 2 ? whole(bits[1]) : null;
    if (level === null) { errors.push(`"${part}" in ?${src}? needs research:level`); continue; }
    terms.push({ tech: tech.typeId, name: tech.name, level, raw: part });
  }
  if (!terms.length && !errors.length) errors.push('empty ?condition?');
  return { terms, errors };
}

// One code per fortification, the one NEAT's FortificationGoal page uses. The
// console shows it beside each fortification (session.js). The parser reads
// every spelling in constants.js FORT_WORDS, not just these.
const FORT_ABBR = { tra: 'trap', ab: 'abatis', at: 'tower', r: 'logs', tre: 'rocks' };

const CONFIG_KEYS = new Set([
  'npc', 'buildnpc', 'comfort', 'hero', 'troop', 'trade', 'valley', 'hunting',
  'troopsusepopmax', 'troopsusereserved', 'troopqueuetime', 'troopidlequeuetime',
  'warrules', 'wartown', 'keepatthome', 'reservedbarrack', 'feastinghallspace',
  'troopincrement', 'attackgap', 'embassy', 'farmingcycle', 'troopslot',
  'trooptraineronly',
  // The rest of the 46 keys the NEAT wiki documents (CategoryConfigGoals and
  // each key's own page), so a pasted NEAT config line never reads as a typo.
  // The ones nothing acts on yet are in NOT_IMPLEMENTED.config below.
  'abandon', 'abandonflats', 'acquireflats', 'fortification', 'fortsusereserved',
  'plan', 'research', 'troopdelbadque', 'valleyfarming', 'valleymin', 'wallqueuetime',
]);
// config building:0 pauses construction; building:1 is implied by any build line (wiki: Build)
CONFIG_KEYS.add('building');

// The troop and wall settings, each with the kind of value it takes (wiki
// Troop, TroopQueueTime, TroopIdleQueueTime, TroopIncrement, TroopsUseReserved,
// TroopsUsePopMax, ReservedBarrack, TroopDelBadQue, FortificationGoal,
// FortsUseReserved, WallQueueTime). A value that cannot be read is an error and
// the setting stays at its default, rather than NUM turning "30m" into 30
// million hours or "abc" meaning something else.
//   hours / minutes  a plain number, fractions allowed (.5)
//   share            0 to 1, where 1 is 100% (wiki: "0.5 = 50%")
//   increment        0 off, a share below 1 (0.01 = 1% steps), 1 ratio mode,
//                    or a whole number of troops per step (500, 5k)
//   flag             0 or 1
const TROOP_CONFIG = {
  troopqueuetime: 'hours', troopidlequeuetime: 'minutes', wallqueuetime: 'hours',
  troopsusereserved: 'share', troopsusepopmax: 'share', fortsusereserved: 'share',
  troopincrement: 'increment', reservedbarrack: 'flag', troopdelbadque: 'flag', fortification: 'flag',
  // ours: 1 (the default) keeps the barracks for the traininghero (engine.js paceOf)
  trooptraineronly: 'flag',
};
// The troop line's own switches override the config for that line (wiki
// Troop). /slot is ours: minutes, as config troopslot; so is /traineronly,
// a flag, as config trooptraineronly.
const TROOP_SWITCHES = {
  queuetime: 'hours', idlequeuetime: 'minutes', usereserved: 'share', usepopmax: 'share',
  increment: 'increment', slot: 'minutes', traineronly: 'flag',
};
const PLAIN = /^(\d+(\.\d*)?|\.\d+)$/;
// { value } or { error }
function settingValue(kind, name, v) {
  const s = String(v == null ? '' : v).trim();
  const eg = { hours: `${name}:2 or ${name}:.5`, minutes: `${name}:30`, share: `${name}:0.5`, increment: `${name}:0.01, ${name}:1 or ${name}:500`, flag: `${name}:1` }[kind];
  if (kind === 'flag') return /^[01]$/.test(s) ? { value: Number(s) } : { error: `${name} is 0 (off) or 1 (on), not "${s}"` };
  if (kind === 'increment') {
    const x = NUM(s);
    if (x === null || (x > 1 && !Number.isInteger(x))) {
      return { error: `${name} is 0 (off), a share below 1 (0.01 = 1% steps), 1 (ratio mode) or a whole number of troops per step, e.g. ${eg} — not "${s}"` };
    }
    return { value: x };
  }
  if (!PLAIN.test(s)) return { error: `${name} is ${kind === 'share' ? 'a share from 0 to 1 (1 = 100%, 0.5 = 50%)' : `${kind} as a plain number`}, e.g. ${eg} — not "${s}"` };
  const x = parseFloat(s);
  if (kind === 'share' && x > 1) return { error: `${name} is a share from 0 to 1 (1 = 100%, 0.5 = 50%), not ${s}` };
  return { value: x };
}

// name -> { kind, multi, parse(args, raw) }
const GOALS = {
  config: {
    kind: 'config', multi: true,
    parse(args) {
      const out = {}, errs = [];
      for (const pair of args.join(' ').split(',')) {
        const t = pair.trim();
        if (!t) continue;
        if (/\s/.test(t)) { errs.push(`"${t}" has a space — config must be written key:value with no spaces`); continue; }
        const [k, v] = kv(t);
        if (v === null) { errs.push(`"${t}" is missing a value (expected key:value)`); continue; }
        if (!CONFIG_KEYS.has(k.toLowerCase())) errs.push(`unknown config key "${k}"`);
        // NUM reads "30m" as 30 million, which would silently mean "no cap"
        if (k.toLowerCase() === 'troopslot' && !/^\d+(\.\d+)?$/.test(v)) {
          errs.push(`troopslot is minutes per training batch as a plain number, e.g. troopslot:30`);
          continue;
        }
        if (k.toLowerCase() === 'building' && !/^[01]$/.test(v)) {
          errs.push('building is 0 (construction paused) or 1');
          continue;
        }
        // research:0 pauses research; research:1 is implied by a research line
        // and also has the build lines' research done (goal-research.js)
        if (k.toLowerCase() === 'research' && !/^[01]$/.test(v)) {
          errs.push('research is 0 (research paused) or 1');
          continue;
        }
        // plan:0 pauses the plan lines; plan:1 is the default (wiki Plan, goal-plan.js)
        if (k.toLowerCase() === 'plan' && !/^[01]$/.test(v)) {
          errs.push('plan is 0 (plan lines paused) or 1');
          continue;
        }
        const kind = TROOP_CONFIG[k.toLowerCase()];
        if (kind) {
          const got = settingValue(kind, k.toLowerCase(), v);
          if (got.error) { errs.push(got.error); continue; }
          out[k.toLowerCase()] = got.value;
          continue;
        }
        const value = NUM(v) ?? v;
        // A key a goal module reads through its own config parser (goal-war's
        // hiding, gate, wartown...) is checked by that parser now, so
        // `wartown:5` or `hiding:soon` is an error here and not a silent default.
        // A goal line that shares its name with a config key (valleyfarming:
        // the miles line, and config valleyfarming:<level>) checks the key
        // through its configParse.
        const own = GOALS[k.toLowerCase()];
        const check = own && k.toLowerCase() !== 'config' ? (own.kind === 'config' ? own.parse : own.configParse) : null;
        if (check) {
          for (const e of check(value).errors || []) errs.push(e);
        }
        out[k.toLowerCase()] = value;
      }
      if (out.troopqueuetime !== undefined && out.troopslot !== undefined) {
        errs.push('troopqueuetime (hours) and troopslot (minutes) both set the batch length: troopqueuetime is used, drop one');
      }
      return { values: out, errors: errs };
    },
  },

  // troop <type>:<amount>[,...] [/increment:n] [/queuetime:h] [/idlequeuetime:m]
  // [/usereserved:0-1] [/usepopmax:0-1] [/slot:m] — wiki Troop. Each switch
  // overrides its config key for this line only (engine.js troopSettings).
  // An unknown switch or a value that cannot be read is an error and is left
  // out, where it used to be accepted and ignored.
  troop: {
    kind: 'directive', multi: true,
    parse(args) {
      const errs = [], switches = {};
      const troops = {};
      for (const tok of args) {
        if (tok.startsWith('/')) {
          const [k, v] = kv(tok.slice(1));
          const key = k.toLowerCase(), kind = TROOP_SWITCHES[key];
          if (!kind) { errs.push(`unknown switch "/${k}" (known: ${Object.keys(TROOP_SWITCHES).map((s) => '/' + s).join(' ')})`); continue; }
          if (v === null || v === '') { errs.push(`/${key} needs a value, e.g. /${key}:${{ hours: '.5', minutes: '30', share: '0.5', increment: '0.1', flag: '1' }[kind]}`); continue; }
          const got = settingValue(kind, `/${key}`, v);
          if (got.error) { errs.push(got.error); continue; }
          switches[key] = got.value;
          continue;
        }
        for (const part of tok.split(',')) {
          if (!part.trim()) continue;
          const [code, amt] = kv(part.trim());
          const t = C.troopByWord(code);          // constants.js TROOP_WORDS
          if (!t) { errs.push(`unknown troop code "${code}"`); continue; }
          const n = NUM(amt);
          if (n === null) { errs.push(`bad amount "${amt}" for ${code}`); continue; }
          troops[t.key] = n;
        }
      }
      // switches alone would read as a stage that is always met
      if (!Object.keys(troops).length && !errs.length) errs.push('needs at least one troopType:amount, e.g. troop a:100k');
      if (switches.queuetime !== undefined && switches.slot !== undefined) {
        errs.push('/queuetime (hours) and /slot (minutes) both set the batch length: /queuetime is used, drop one');
      }
      return { troops, switches, errors: errs };
    },
  },

  fortification: {
    kind: 'directive', multi: true,
    parse(args) {
      const errs = [], forts = {};
      for (const tok of args) for (const part of tok.split(',')) {
        if (!part.trim()) continue;
        const [code, amt] = kv(part.trim());
        const w = C.fortByWord(code);             // constants.js FORT_WORDS
        if (!w) { errs.push(`unknown fortification "${code}"`); continue; }
        const n = NUM(amt);
        if (n === null) { errs.push(`bad amount "${amt}" for ${code}`); continue; }
        forts[w.code] = n;
      }
      if (!Object.keys(forts).length && !errs.length) errs.push('needs at least one type:quantity, e.g. fortification ab:5000');
      return { forts, errors: errs };
    },
  },

  // build <type>:<level>[:<qty>][,...] — a target, the NEAT way (engine.js
  // buildPlan says what each form means). Groups are separated by spaces and each
  // may carry its own ?condition?, before or after its targets:
  //   build ?w:10?q:0:0,ws:0:0 w:10
  build: {
    kind: 'directive', multi: true,
    parse(args) {
      const errs = [], targets = [], groups = [];
      const raw = args.join(' ').replace(TWO_WORDS, '$1$2')
        .replace(/\?[^?]*\?/g, (m) => m.replace(/\s+/g, ''));
      for (const text of raw.split(/\s+/)) {
        if (!text) continue;
        const m = text.match(/^(?:\?([^?]*)\?)?([^?]*)(?:\?([^?]*)\?)?$/);
        if (!m || !m[2]) {
          // "?w:10? q:0:0": whichever targets that condition was meant for, none
          // of them may run without it, so nothing on the line runs
          errs.push(`"${text}": a ?condition? goes right before or right after its targets, e.g. ?w:10?q:0:0 or q:0:0?w:10?; the whole line is left out`);
          return { targets: [], groups: [], condition: null, needsTech: false, errors: errs };
        }
        const conds = [m[1], m[3]].filter((c) => c !== undefined);
        let when = null;
        if (conds.length) {
          const c = buildCondition(conds.join(','));
          // never run a conditional target without its condition
          if (c.errors.length) { for (const e of c.errors) errs.push(`${e}; "${text}" is left out`); continue; }
          when = c.terms;
        }
        const group = { condition: conds.length ? conds.join(',') : null, when, targets: [] };
        for (const part of m[2].split(',')) {
          if (!part.trim()) continue;
          const t = buildTarget(part.trim(), errs);
          if (!t) continue;
          if ((t.typeId === C.TOWN_HALL || t.typeId === C.WALLS_TYPE) && t.quantity === 0) {
            errs.push(`"${t.raw}": the bot never demolishes or takes down the ${t.building}`);
            continue;
          }
          if (!MULTI_BUILDINGS.has(t.typeId) && t.level > 0 && t.quantity > 1) {
            errs.push(`"${t.raw}": a city has one ${t.building}, so this reads as quantity 1`);
            t.quantity = 1;
          }
          Object.assign(t, { when, condition: group.condition });
          group.targets.push(t);
          targets.push(t);
        }
        if (group.targets.length) groups.push(group);
      }
      // a bare "build" would read as a line that works (the editor paints it blue)
      if (!raw.trim()) errs.push('needs at least one buildingType:level[:quantity]');
      return {
        targets, groups, errors: errs,
        condition: (groups.find((g) => g.condition) || {}).condition || null,
        // the engine reads research levels only for a line that asks
        needsTech: groups.some((g) => (g.when || []).some((c) => c.tech)),
      };
    },
  },

  traininghero: {
    kind: 'directive', multi: true,   // one per city, but goals are stored per city
    parse(args) {
      const errs = [];
      if (!args.length) errs.push('needs a hero name');
      const [name, minStay, maxStay, npcHits] = args;
      return {
        hero: name,
        minStaySec: minStay !== undefined ? parseInt(minStay, 10) : 600,
        maxStaySec: maxStay !== undefined ? parseInt(maxStay, 10) : null,
        npcHits: npcHits !== undefined ? parseInt(npcHits, 10) : null,
        errors: errs,
      };
    },
  },

  // comfortpolicy, taxpolicy, production and warehousepolicy live in
  // goal-upkeep.js (NEAT's options, levies, the tax range).

  // defensepolicy [/switches] — NEAT's switches (wiki DefensePolicy), each with
  // the kind of value it takes. A value that cannot be read is an error and the
  // switch stays unset, rather than becoming NaN or 0 and meaning something else.
  defensepolicy: {
    kind: 'policy', multi: false,
    SWITCHES: {
      junktroop: 'troops',                        // attacks under this many troops are junk
      usetruce: 'loyalty', usespeech: 'loyalty',  // use the item at or below this loyalty
      usewarhorn: 'flag', useivoryhorn: 'flag', usecorselet: 'flag',
      useultracorselet: 'flag', usepenicillin: 'flag',
    },
    parse(args) {
      const errs = [], sw = {};
      const SW = GOALS.defensepolicy.SWITCHES;
      for (const tok of args) {
        if (!tok.startsWith('/')) { errs.push(`expected /switch:value, got "${tok}"`); continue; }
        const [k, v] = kv(tok.slice(1));
        const key = k.toLowerCase(), want = SW[key];
        if (!want) { errs.push(`unknown switch "/${k}" (known: ${Object.keys(SW).map((s) => '/' + s).join(' ')})`); continue; }
        // a bare on/off switch means on; "/usecorselet:" with nothing after is a slip
        if (v === null && want === 'flag') { sw[key] = 1; continue; }
        if (v === null || v === '') {
          errs.push(`/${key} needs a value, e.g. /${key}:${want === 'troops' ? '1000' : want === 'flag' ? '1' : '50'}`);
          continue;
        }
        const num = NUM(v);
        if (num === null) { errs.push(`/${key}:${v} — cannot read "${v}" as a number`); continue; }
        if (want === 'flag' && num !== 0 && num !== 1) { errs.push(`/${key} is 0 (off) or 1 (on), not ${v}`); continue; }
        if (want === 'loyalty' && num > 100) { errs.push(`/${key} is a loyalty from 0 to 100, not ${v}`); continue; }
        sw[key] = num;
      }
      return { switches: sw, errors: errs };
    },
  },

  // rallypolicy n:8 n:10:1 r:2 t:1 max:8 — how many rally slots goal marches
  // may hold, by kind (rally.js). requestresources/requesttroops live in
  // goal-transfer.js.
  rallypolicy: require('./rally').parser,
};

// ---- goal modules (upkeep, war, heroes, npc, valleys, transfers, market, reports, research,
// plan, schedule/processing) contribute their own parsers + config keys ----
for (const mod of ['./goal-upkeep', './goal-war', './goal-heroes', './goal-npc', './goal-buildnpc', './goal-valley', './goal-transfer', './goal-trade', './goal-reports', './goal-quests', './goal-research',
  './goal-plan', './processing']) {
  try {
    const m = require(mod);
    Object.assign(GOALS, m.parsers || {});
    for (const k of m.configKeys || []) CONFIG_KEYS.add(String(k).toLowerCase());
  } catch (e) {
    // a missing or broken module must not take the whole goal parser down
    console.error(`goal module ${mod} not loaded: ${e.message}`);
  }
}
// heroes/war read these but do not own them
for (const k of ['nomayor', 'feastinghallspace', 'hero', 'trainint', 'trainpol', 'fasthero']) CONFIG_KEYS.add(k);
// free finishes (speedups.js): config freespeedup:0 turns them off in a city
for (const k of require('./speedups').configKeys) CONFIG_KEYS.add(k);

// ---- accepted, but nothing acts on it yet ----
// These parse without an error, yet no plan does anything with them. The console's
// editor paints them red with the reason below, not blue: NEAT's editor did the
// same ("a valid line that just isn't added to the bot's list yet" shows red —
// wiki SyntaxHighlighting). THIS IS THE ONE LIST: a step that makes one of these
// work deletes its entry here, and the line turns blue.
// monitorarmy is deliberately absent: the NEAT wiki says it never did anything on
// NEAT or YAEB either, so a line that does nothing is working as documented.
const NOT_IMPLEMENTED = {
  // config <key>:<value> — no plan reads these keys. Every key the NEAT wiki
  // documents is accepted (CONFIG_KEYS), so a pasted NEAT file says here, line
  // by line, which of its switches do nothing yet.
  config: {
  },
  // goal lines whose plan only reports. (spamheroes left in Step 18: its
  // heroes are what the script's spamattack / loyaltyattack send, through
  // goal-heroes.spamHeroes, and its plan names them.)
  goals: {},
  // War settings written as a line of their own (`wartown 1`) used to parse into
  // the goal list, where no plan looks. Since Step 9 parseGoals reads such a line
  // as the config it means and says so on the line, so none is left here.
  bare: [],
};

// ---- NEAT's obsolete goals ----
// wiki Obsolete: "All of the following goals still function within the bot.
// They have been replaced by a more powerful or functional goal", and
// CapturedFireLimit: "the bot will automatically treat it as the
// keepcapturedheroes internally". Each is read as the goal that replaced it,
// and its line says so ("obsolete in NEAT — read as ..."): blue when the
// replacement works here, red ("does nothing yet") while it does not. `as` is
// the replacement's words, put in front of the line's own; `read(args)` gives
// the replacement line(s) and any errors instead; `idle()` says what still does
// nothing. npc10heroes keeps goal-npc's own parser, which reads it as
// npcheroes 10 already, and only gains the note.
const OBSOLETE = {
  // ballsused npc1s,npc2s,npc3s,npc4s,npc5s — the ballistas sent to levels 1 to 5,
  // in order (wiki Obsolete, SetBallsUsed): "phased out in lieu of the more
  // powerful NpcTroops goal", so each number is that level's npctroops line.
  // A 0 would send the transports alone into the camp: it is refused, and that
  // level keeps its default load.
  ballsused: {
    read(args) {
      const errors = [], lines = [];
      const nums = args.join(' ').split(/[\s,]+/).filter(Boolean);
      if (!nums.length) errors.push('needs the ballistas for levels 1 to 5, e.g. ballsused 25,50,170,250,500');
      if (nums.length > 5) errors.push(`${nums.length} numbers, but ballsused covers levels 1 to 5 — the rest are left out`);
      nums.slice(0, 5).forEach((s, i) => {
        const v = NUM(s);
        if (v === null || !Number.isInteger(v)) errors.push(`level ${i + 1}: "${s}" is not a whole number of ballistas`);
        else if (v === 0) errors.push(`level ${i + 1}: 0 ballistas would send the transports alone — that level keeps its default load`);
        else lines.push(`npctroops ${i + 1} b:${v}`);
      });
      return { lines, errors };
    },
  },
  // ExcludeList: "This single goal can replace NoAbandonFlats, NpcExcludeList,
  // and Npc10ExcludeList". Keeping flats is the flats goals' work.
  noabandonflats: { as: 'excludelist', idle: () => NOT_IMPLEMENTED.config.abandonflats || null },
  npcexcludelist: { as: 'excludelist' },
  npc10excludelist: { as: 'excludelist' },
  npc10heroes: { native: true, as: 'npcheroes 10' },
  // "npc10list npc1 npc2 ..." lists level-10 camps, which is NpcList's
  // "npclist [level] npc1 npc2 ..." (the wiki names NpcLimits as its successor,
  // but a list of camps is NpcList's)
  npc10list: { as: 'npclist 10' },
  npc10troops: { as: 'npctroops 10' },
  npc10limit: { as: 'npclimits 10' },
  npc10limits: { as: 'npclimits 10' },
  // "capturedfirelimit 100 will be treated as keepcapturedheroes any:level>=100"
  capturedfirelimit: {
    read(args) {
      const v = args.length === 1 ? NUM(args[0]) : null;
      if (v === null || !Number.isInteger(v)) return { lines: [], errors: ['needs one hero level, e.g. capturedfirelimit 100 (read as keepcapturedheroes any:level>=100)'] };
      return { lines: [`keepcapturedheroes any:level>=${v}`], errors: [] };
    },
  },
};

// What an obsolete line reads as: { lines, errors }.
function readObsolete(name, args) {
  const old = OBSOLETE[name];
  if (old.read) return old.read(args);
  return { lines: [`${old.as} ${args.join(' ')}`.trim()], errors: [] };
}
const obsoleteNote = (lines) => `obsolete in NEAT — read as ${lines.length ? lines.map((l) => `"${l}"`).join(', ') : 'nothing, until it is fixed'}`;

// What a line that reads fine comes to, if nothing acts on it. `seen` is the
// line's goal name, its tokens and, for config, the keys it set. A config line
// with one idle key among working ones is still flagged, naming the idle key and
// the keys that do work, so a key that does nothing is never hidden in a blue line.
// A goal's own parser may say its line does nothing yet (`lineIdle`, e.g. a
// processingpolicy naming only tasks nothing here runs).
function idleNote(seen) {
  if (seen.idle) return seen.idle;
  if (seen.name === 'config') {
    const idle = seen.keys.filter((k) => NOT_IMPLEMENTED.config[k]);
    if (!idle.length) return null;
    const rest = seen.keys.filter((k) => !NOT_IMPLEMENTED.config[k] && CONFIG_KEYS.has(k));
    const and = (l) => (l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}` : l[0]);
    return idle.map((k) => `${k} does nothing yet: ${NOT_IMPLEMENTED.config[k]}`).join('; ')
      + (rest.length ? ` (${and(rest)} on this line ${rest.length > 1 ? 'work' : 'works'})` : '');
  }
  if (NOT_IMPLEMENTED.goals[seen.name]) return `${seen.name} does nothing yet: ${NOT_IMPLEMENTED.goals[seen.name]}`;
  if (NOT_IMPLEMENTED.bare.includes(seen.name)) {
    return `${seen.name} is a config setting: as a line of its own it does nothing. Write it as  config ${seen.name}:${seen.args.join('') || '<value>'}`;
  }
  return null;
}

// The note on a line parseGoals read differently from how it was written (a
// bare war setting read as config, an obsolete NEAT goal read as its
// replacement). describe() lists these too.
const READ_AS = /^(read as "config |obsolete in NEAT)/;

// Each source line's standing, for the console editor's colours:
//   ok       the engine acts on it (msg may still say something, e.g. what it replaced)
//   error    it has an error, or a later line of the same one-per-city goal replaced it
//   idle     it reads fine but nothing acts on it yet (NOT_IMPLEMENTED)
//   comment  a // or # line          blank  nothing on it
// A line keeps whatever parsed on it even with an error (see parseGoals), but the
// editor still wants it fixed, so any error makes it red.
function lineStatus(src, errors, seen, dropped) {
  const notices = new Set(dropped.values());      // said on the line that was dropped
  const errs = new Map();
  for (const e of errors) {
    if (notices.has(e)) continue;
    if (!errs.has(e.line)) errs.set(e.line, []);
    errs.get(e.line).push(e.error);
  }
  const later = new Map([...dropped].map(([was, e]) => [e.line, was]));
  return src.map((raw, i) => {
    const n = i + 1, s = seen[i];
    if (!raw.trim()) return { n, status: 'blank', msg: null };
    const msgs = errs.get(n) || [];
    if (!s && !msgs.length) return { n, status: 'comment', msg: null };
    if (dropped.has(n)) msgs.push(`${s.name} is written again on line ${dropped.get(n).line}, and the later line wins, so this one does nothing`);
    const idle = s ? idleNote(s) : null;
    const note = s && s.note ? [s.note] : [];       // how the line was read, when that differs
    if (msgs.length) return { n, status: 'error', msg: [...msgs, ...(idle ? [idle] : []), ...note].join('; ') };
    if (idle) return { n, status: 'idle', msg: [idle, ...note].join('; ') };
    const said = [...(later.has(n) ? [`replaces line ${later.get(n)}`] : []), ...note];
    return { n, status: 'ok', msg: said.length ? said.join('; ') : null };
  });
}

function parseGoals(text) {
  const lines = String(text || '').split(/\r?\n/);
  const goals = [];      // ordered, as written
  const errors = [];
  const config = {};
  const seen = [];            // per line: what lineStatus needs to know about it
  const dropped = new Map();  // a replaced singleton's line -> the error that said so

  lines.forEach((raw, i) => {
    const line = raw.replace(/^\s*(\/\/|#).*$/, '').trim();
    if (!line) return;
    const tok = line.split(/\s+/);
    const name = tok[0].toLowerCase();

    // An obsolete NEAT goal (OBSOLETE above) is read as the goal that replaced
    // it: its goals are the replacement's, on this line, and the line says so.
    const old = Object.prototype.hasOwnProperty.call(OBSOLETE, name) ? OBSOLETE[name] : null;
    if (old && !old.native) {
      const said = (e) => errors.push({ line: i + 1, text: raw.trim(), error: `${name.toUpperCase()}: ${e}` });
      const r = readObsolete(name, tok.slice(1));
      r.errors.forEach(said);
      for (const text of r.lines) {
        const t2 = text.split(/\s+/);
        const d2 = GOALS[t2[0]];
        const p2 = d2.parse(t2.slice(1), text);
        (p2.errors || []).forEach(said);
        delete p2.errors; delete p2.lineNote; delete p2.lineIdle;
        goals.push({ name: t2[0], kind: d2.kind, line: i + 1, raw: line, obsolete: name, readAs: text, ...p2 });
      }
      const why = old.idle ? old.idle() : null;
      seen[i] = { name, args: tok.slice(1), keys: null, note: obsoleteNote(r.lines), idle: why ? `${name} does nothing yet: ${why}` : null };
      return;
    }

    // own names only: a line starting "constructor" or "__proto__" is no goal
    const def = Object.prototype.hasOwnProperty.call(GOALS, name) ? GOALS[name] : null;
    if (!def) { errors.push({ line: i + 1, text: raw.trim(), error: `unknown goal "${tok[0]}"` }); return; }

    // A config key written as its own line ("wartown 1", "hiding 5", "gate 3").
    // goal-war's config parsers sit in GOALS, so such a line used to parse with
    // no error and then do nothing, since every plan reads ctx.config. It is
    // read as the config line it was meant to be, and the line's note says so.
    if (def.kind === 'config' && name !== 'config') {
      const value = tok.slice(1).join(' ');
      if (!value) {
        // monitorarmy does nothing in NEAT or here, with or without a value
        if (def.parse().noop) { seen[i] = { name, args: [], keys: null }; return; }
        errors.push({ line: i + 1, text: raw.trim(), error: `${name} is a config key and needs a value — write it as config ${name}:<value>` });
        seen[i] = { name, args: [], keys: null };
        return;
      }
      const cfg = GOALS.config.parse([`${name}:${value}`]);
      for (const e of cfg.errors || []) errors.push({ line: i + 1, text: raw.trim(), error: `CONFIG: ${e}` });
      Object.assign(config, cfg.values);
      seen[i] = { name: 'config', args: [`${name}:${value}`], keys: Object.keys(cfg.values),
        note: `read as "config ${name}:${value}" — ${name} is a config key, so write it that way` };
      return;
    }

    const parsed = def.parse(tok.slice(1), line);
    for (const e of parsed.errors || []) errors.push({ line: i + 1, text: raw.trim(), error: `${name.toUpperCase()}: ${e}` });
    // what the goal's own parser says of its line for the editor: a note on a
    // line that works (lineNote), or that the line does nothing yet (lineIdle)
    const { lineNote = null, lineIdle = null } = parsed;
    delete parsed.errors; delete parsed.lineNote; delete parsed.lineIdle;
    seen[i] = { name, args: tok.slice(1), keys: name === 'config' ? Object.keys(parsed.values || {}) : null };
    const note = [lineNote, old && old.native ? obsoleteNote([`${old.as} ${tok.slice(1).join(' ')}`.trim()]) : null].filter(Boolean);
    if (note.length) seen[i].note = note.join('; ');
    if (lineIdle) seen[i].idle = lineIdle;

    if (name === 'config') { Object.assign(config, parsed.values); return; }   // merge, last wins

    if (!def.multi) {
      const prev = goals.findIndex((g) => g.name === name);
      if (prev >= 0) {
        errors.push({ line: i + 1, text: raw.trim(), error: `${name} appears more than once — the later one wins (line ${goals[prev].line} discarded)` });
        dropped.set(goals[prev].line, errors[errors.length - 1]);
        goals.splice(prev, 1);
      }
    }
    goals.push({ name, kind: def.kind, line: i + 1, raw: line, ...parsed });
  });

  return { config, goals, errors, lines: lineStatus(lines, errors, seen, dropped) };
}

function describe(parsed) {
  const out = [];
  for (const l of parsed.lines || []) {
    const said = String(l.msg || '').split('; ').find((m) => READ_AS.test(m));
    if (said) out.push(`note: line ${l.n} ${said}`);
  }
  const cfg = Object.entries(parsed.config);
  if (cfg.length) out.push(`config: ${cfg.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  const byName = {};
  for (const g of parsed.goals) (byName[g.name] = byName[g.name] || []).push(g);

  for (const [name, list] of Object.entries(byName)) {
    if (name === 'troop') {
      out.push(`troop: ${list.length} stage(s), built in order, dropping back if an earlier stage breaks`);
      list.forEach((g, i) => out.push(`   ${i + 1}. ${Object.entries(g.troops).map(([k, v]) => `${k} ${v.toLocaleString('en-US')}`).join(', ')}${Object.keys(g.switches).length ? '  [' + Object.entries(g.switches).map(([k, v]) => `/${k}:${v}`).join(' ') + ']' : ''}`));
    } else if (name === 'fortification') {
      out.push(`fortification: ${list.length} stage(s)`);
      list.forEach((g, i) => out.push(`   ${i + 1}. ${Object.entries(g.forts).map(([k, v]) => `${k} ${v.toLocaleString('en-US')}`).join(', ')}`));
    } else if (name === 'build') {
      const what = (t) => (t.level > 0 && t.quantity > 0 ? `${t.quantity} x ${t.building} to L${t.level}`
        : t.level === 0 && t.quantity > 0 ? `at most ${t.quantity} ${t.building}`
          : t.level === 0 ? `no ${t.building}` : `no ${t.building} at L${t.level} or higher`);
      out.push(`build: ${list.length} line(s), worked on in order, moving on while one waits for a free plot`);
      list.forEach((g, i) => out.push(`   ${i + 1}. ${(g.groups || []).map((gr) => gr.targets.map(what).join(', ')
        + (gr.condition ? ` (only when ${gr.condition})` : '')).join('; ') || '(nothing readable on this line)'}`));
    } else if (name === 'research') {
      out.push(`research: ${list.length} line(s), worked on in order, one research at a time in this city`);
      list.forEach((g, i) => out.push(`   ${i + 1}. ${(g.groups || []).map((gr) => gr.targets.map((t) => `${t.name} to L${t.level}`).join(', ')
        + (gr.condition ? ` (only when ${gr.condition})` : '')).join('; ') || '(nothing readable on this line)'}`));
    } else if (name === 'traininghero') {
      for (const g of list) out.push(`traininghero: ${g.hero} stays ${g.minStaySec}s min${g.maxStaySec ? `, ${g.maxStaySec}s max` : ''}${g.npcHits != null ? `, or after ${g.npcHits} npc hits` : ''}, then rotates to the next city`);
    } else if (['comfortpolicy', 'taxpolicy', 'production', 'warehousepolicy'].includes(name)) {
      for (const g of list) out.push(require('./goal-upkeep').describeGoal(g));
    } else if (name === 'defensepolicy') {
      for (const g of list) out.push(`defensepolicy: ${Object.entries(g.switches).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    } else if (name === 'requestresources' || name === 'requesttroops') {
      const { describeRequest } = require('./goal-transfer');
      for (const g of list) out.push(describeRequest(g));
    } else if (require('./goal-transfer').PUSH_GOALS[name]) {
      const { describePush } = require('./goal-transfer');
      for (const g of list) out.push(describePush(g));
    } else if (name === 'tradepolicy' || name === 'resourcelimits') {
      const { describeTrade } = require('./goal-trade');
      for (const g of list) out.push(describeTrade(g));
    } else if (name === 'plan') {
      out.push(...require('./goal-plan').describe(list));
    } else if (name === 'schedulepolicy' || name === 'processingpolicy') {
      for (const g of list) out.push(require('./processing').describeGoal(g));
    } else if (name === 'rallypolicy') {
      for (const g of list) {
        const parts = [...Object.entries(g.caps || {}).map(([k, v]) => `${k}:${v}`),
          ...Object.entries(g.levels || {}).map(([l, v]) => `n:${l}:${v}`), ...(g.max != null ? [`max:${g.max}`] : [])];
        out.push(`rallypolicy: ${parts.join(' ')}`);
      }
    } else {
      // an obsolete NEAT goal shows as what it was read as
      for (const g of list) out.push(`${name}: ${g.readAs || g.raw}`);
    }
  }
  return out;
}

module.exports = { parseGoals, describe, GOALS, BUILD_ABBR, TECH_ABBR, MULTI_BUILDINGS, buildingOf, FORT_ABBR, CONFIG_KEYS, NOT_IMPLEMENTED,
  // the research goal (goal-research.js) reads its lines the same way
  TWO_WORDS, buildCondition,
  // NEAT's obsolete goals and what each is read as (Step 19)
  OBSOLETE };
