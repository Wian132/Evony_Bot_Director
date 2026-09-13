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
  'troopincrement', 'attackgap', 'embassy', 'farmingcycle',
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

  defensepolicy: {
    kind: 'policy', multi: false,
    parse(args) {
      const errs = [], sw = {};
      for (const tok of args) {
        if (!tok.startsWith('/')) { errs.push(`expected /switch:value, got "${tok}"`); continue; }
        const [k, v] = kv(tok.slice(1));
        sw[k.toLowerCase()] = v === null ? true : (NUM(v) ?? v);
      }
      return { switches: sw, errors: errs };
    },
  },

  requestresources: {
    kind: 'directive', multi: true,
    parse(args) {
      const errs = [];
      const [target, type, ...rest] = args;
      const flag = rest.length && /^[a-z]$/i.test(rest[rest.length - 1]) ? rest.pop() : null;
      const amounts = rest.map(NUM);
      if (!type) errs.push('expected: requestresources <target> <type> <min> <max> <batch> <keep> [flag]');
      if (amounts.some((a) => a === null)) errs.push('one of the amounts could not be read');
      return { target, type, amounts, flag, errors: errs };
    },
  },
};

// ---- goal modules (war, heroes, npc) contribute their own parsers + config keys ----
for (const mod of ['./goal-war', './goal-heroes', './goal-npc', './goal-buildnpc']) {
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

function parseGoals(text) {
  const lines = String(text || '').split(/\r?\n/);
  const goals = [];      // ordered, as written
  const errors = [];
  const config = {};

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

    if (name === 'config') { Object.assign(config, parsed.values); return; }   // merge, last wins

    if (!def.multi) {
      const prev = goals.findIndex((g) => g.name === name);
      if (prev >= 0) {
        errors.push({ line: i + 1, text: raw.trim(), error: `${name} appears more than once — the later one wins (line ${goals[prev].line} discarded)` });
        goals.splice(prev, 1);
      }
    }
    goals.push({ name, kind: def.kind, line: i + 1, raw: line, ...parsed });
  });

  return { config, goals, errors };
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
    } else if (name === 'requestresources') {
      for (const g of list) out.push(`requestresources: ${g.type} from ${g.target} [${g.amounts.map((n) => n.toLocaleString('en-US')).join(' / ')}]${g.flag ? ' ' + g.flag : ''}`);
    } else {
      for (const g of list) out.push(`${name}: ${g.raw}`);
    }
  }
  return out;
}

module.exports = { parseGoals, describe, GOALS, BUILD_ABBR, FORT_ABBR, CONFIG_KEYS };
