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

// building abbreviations used by the `build` goal (wiki: Build)
const BUILD_ABBR = {
  a: 'Academy', b: 'Barracks', be: 'Beacon Tower', c: 'Cottage', e: 'Embassy',
  fh: 'Feasting Hall', fo: 'Forge', f: 'Farm', s: 'Sawmill', q: 'Quarry',
  i: 'Ironmine', inn: 'Inn', rs: 'Relief Station', m: 'Marketplace',
  st: 'Stable', ws: 'Workshop', w: 'Walls', th: 'Town Hall', wh: 'Warehouse', r: 'Rally Spot',
};

// fortification abbreviations used by the `fortification` goal
const FORT_ABBR = { ab: 'abatis', tra: 'trap', at: 'tower', rl: 'logs', rf: 'rocks' };

const CONFIG_KEYS = new Set([
  'npc', 'buildnpc', 'comfort', 'hero', 'troop', 'trade', 'valley', 'hunting',
  'troopsusepopmax', 'troopsusereserved', 'troopqueuetime', 'troopidlequeuetime',
  'warrules', 'wartown', 'keepatthome', 'reservedbarrack', 'feastinghallspace',
  'troopincrement', 'attackgap', 'embassy', 'farmingcycle', 'troopslot',
]);

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
        out[k.toLowerCase()] = NUM(v) ?? v;
      }
      return { values: out, errors: errs };
    },
  },

  troop: {
    kind: 'directive', multi: true,
    parse(args) {
      const errs = [], switches = {};
      const troops = {};
      for (const tok of args) {
        if (tok.startsWith('/')) {
          const [k, v] = kv(tok.slice(1));
          switches[k.toLowerCase()] = v === null ? true : (parseFloat(v) || 0);
          continue;
        }
        for (const part of tok.split(',')) {
          if (!part.trim()) continue;
          const [code, amt] = kv(part.trim());
          const t = C.BY_CODE[code.toLowerCase()] || ALIAS[code.toLowerCase()];
          if (!t) { errs.push(`unknown troop code "${code}"`); continue; }
          const n = NUM(amt);
          if (n === null) { errs.push(`bad amount "${amt}" for ${code}`); continue; }
          troops[t.key] = n;
        }
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
        const key = FORT_ABBR[code.toLowerCase()] || code.toLowerCase();
        const w = C.WALL_BY_CODE[key];
        if (!w) { errs.push(`unknown fortification "${code}"`); continue; }
        const n = NUM(amt);
        if (n === null) { errs.push(`bad amount "${amt}" for ${code}`); continue; }
        forts[w.code] = n;
      }
      return { forts, errors: errs };
    },
  },

  build: {
    kind: 'directive', multi: true,
    parse(args) {
      const errs = [], targets = [];
      const raw = args.join(' ');
      const condition = (raw.match(/\?([^?]+)\?/) || [])[1] || null;
      for (const part of raw.replace(/\?[^?]+\?/g, '').split(',')) {
        const t = part.trim();
        if (!t) continue;
        const bits = t.split(':');
        const name = BUILD_ABBR[bits[0].toLowerCase()];
        if (!name) { errs.push(`unknown building "${bits[0]}"`); continue; }
        const level = parseInt(bits[1], 10);
        if (Number.isNaN(level)) { errs.push(`"${t}" needs a level (buildingType:level[:quantity])`); continue; }
        targets.push({ building: name, level, quantity: bits[2] !== undefined ? parseInt(bits[2], 10) : 1 });
      }
      return { targets, condition, errors: errs };
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

  comfortpolicy: {
    kind: 'policy', multi: false,
    parse(args) {
      const errs = [];
      const min = parseInt(args[0], 10), max = parseInt(args[1], 10);
      const mode = args[2] || null;
      if (Number.isNaN(min) || Number.isNaN(max)) errs.push('expected: comfortpolicy <minMinutes> <maxMinutes> <mode>');
      return { everyMinMin: min, everyMaxMin: max, mode, errors: errs };
    },
  },

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

// ---- goal modules (war, heroes, npc, transfers) contribute their own parsers + config keys ----
for (const mod of ['./goal-war', './goal-heroes', './goal-npc', './goal-buildnpc', './goal-transfer']) {
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

// a few troop aliases NEAT accepts that differ from our codes
const ALIAS = {
  warr: C.BY_CODE.w, cav: C.BY_CODE.c, ram: C.BY_CODE.r, trans: C.BY_CODE.t,
  arch: C.BY_CODE.a, pike: C.BY_CODE.p, sword: C.BY_CODE.sw, scout: C.BY_CODE.s,
  phract: C.BY_CODE.cata, worker: C.BY_CODE.wo,
};

// ---- accepted, but nothing acts on it yet ----
// These parse without an error, yet no plan does anything with them. The console's
// editor paints them red with the reason below, not blue: NEAT's editor did the
// same ("a valid line that just isn't added to the bot's list yet" shows red —
// wiki SyntaxHighlighting). THIS IS THE ONE LIST: a step that makes one of these
// work deletes its entry here, and the line turns blue.
// monitorarmy is deliberately absent: the NEAT wiki says it never did anything on
// NEAT or YAEB either, so a line that does nothing is working as documented.
const NOT_IMPLEMENTED = {
  // config <key>:<value> — no plan reads these keys
  config: {
    trade: 'no goal trades on the market yet (the buy and sell script lines do)',
    valley: 'no goal captures or farms valleys yet',
    hunting: 'no goal hunts medals yet',
    troopsusepopmax: 'training uses idle population only, so nothing reads this key',
    troopsusereserved: 'nothing reads this key yet',
    troopqueuetime: 'nothing reads this key yet (a batch is sized by config troopslot or troop /slot)',
    troopidlequeuetime: 'nothing reads this key yet',
    reservedbarrack: 'nothing reads this key yet',
    troopincrement: 'nothing reads this key yet',
    embassy: 'nothing reads this key yet',
    trainint: 'nothing reads this key yet',
    trainpol: 'nothing reads this key yet',
    fasthero: 'no goal hires heroes yet, so nothing reads this key',
    keepatthome: 'it only reports, and NPC farming and hiding still take any idle hero',
    attackgap: 'it only reports, and nothing spaces attacks by it yet',
    nohealing: 'the bot does not heal troops at all yet, so there is nothing to switch off',
  },
  // goal lines whose plan only reports
  goals: {
    homeheroes: 'it only reports, and NPC farming still picks from every idle hero',
    spamheroes: 'it only reports, and no spam or loyalty-attack goal uses these heroes yet',
  },
  // War settings are config keys. Written as a line of their own (`wartown 1`) they
  // parse into the goal list, where no plan looks; every plan reads ctx.config.
  bare: ['hiding', 'gate', 'warrules', 'wartown', 'keepatthome', 'attackgap', 'defensecooldown', 'nohealing'],
};

// What a line that reads fine comes to, if nothing acts on it. `seen` is the
// line's goal name, its tokens and, for config, the keys it set. A config line
// with one idle key among working ones is still flagged, naming the idle key and
// the keys that do work, so a key that does nothing is never hidden in a blue line.
function idleNote(seen) {
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
    if (msgs.length) return { n, status: 'error', msg: [...msgs, ...(idle ? [idle] : [])].join('; ') };
    if (idle) return { n, status: 'idle', msg: idle };
    return { n, status: 'ok', msg: later.has(n) ? `replaces line ${later.get(n)}` : null };
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
    const def = GOALS[name];
    if (!def) { errors.push({ line: i + 1, text: raw.trim(), error: `unknown goal "${tok[0]}"` }); return; }

    const parsed = def.parse(tok.slice(1), line);
    for (const e of parsed.errors || []) errors.push({ line: i + 1, text: raw.trim(), error: `${name.toUpperCase()}: ${e}` });
    delete parsed.errors;
    seen[i] = { name, args: tok.slice(1), keys: name === 'config' ? Object.keys(parsed.values || {}) : null };

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
      for (const g of list) out.push(`build: ${g.targets.map((t) => `${t.quantity} x ${t.building} to L${t.level}`).join(', ')}${g.condition ? ` (only when ${g.condition})` : ''}`);
    } else if (name === 'traininghero') {
      for (const g of list) out.push(`traininghero: ${g.hero} stays ${g.minStaySec}s min${g.maxStaySec ? `, ${g.maxStaySec}s max` : ''}${g.npcHits != null ? `, or after ${g.npcHits} npc hits` : ''}, then rotates to the next city`);
    } else if (name === 'comfortpolicy') {
      for (const g of list) out.push(`comfortpolicy: ${g.mode} every ${g.everyMinMin}-${g.everyMaxMin} min`);
    } else if (name === 'defensepolicy') {
      for (const g of list) out.push(`defensepolicy: ${Object.entries(g.switches).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    } else if (name === 'requestresources' || name === 'requesttroops') {
      const amt = (v) => (v == null ? '*' : v.toLocaleString('en-US'));
      for (const g of list) {
        const [min, max, batch, keep] = g.amounts || [];
        out.push(`${name}: ${g.type || g.troop} from ${g.target} when under ${amt(min)}, up to ${amt(max)}, `
          + `${amt(batch)} per send, senders keep ${amt(keep)}${g.slots > 1 ? `, ${g.slots} missions at a time` : ''}`);
      }
    } else if (name === 'rallypolicy') {
      for (const g of list) {
        const parts = [...Object.entries(g.caps || {}).map(([k, v]) => `${k}:${v}`),
          ...Object.entries(g.levels || {}).map(([l, v]) => `n:${l}:${v}`), ...(g.max != null ? [`max:${g.max}`] : [])];
        out.push(`rallypolicy: ${parts.join(' ')}`);
      }
    } else {
      for (const g of list) out.push(`${name}: ${g.raw}`);
    }
  }
  return out;
}

module.exports = { parseGoals, describe, GOALS, BUILD_ABBR, FORT_ABBR, CONFIG_KEYS, NOT_IMPLEMENTED };
