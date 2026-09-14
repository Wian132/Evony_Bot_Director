'use strict';
// requestresources / requesttroops — top a city up from your other cities.
//
//   requestresources <from> <type>  <min> <max> <batch> <keep> [t] [/slots:N]
//   requesttroops    <from> <troop> <min> <max> <batch> <keep>     [/slots:N]
//
//   <from>   any, a city name (!Name also works) or x,y — several joined by |
//   <min>    ask once this city holds less than this, counting what is on its way
//   <max>    never fill it past this
//   <batch>  at most this much per send
//   <keep>   never take a sending city below this
//   * in place of any of the four means "doesn't matter".
//
// The argument ORDER is this tool's, not NEAT's: the wiki's version reads
// <local> <remote> <minBatch> <maxBatch>. Saved goals are written in this order,
// so it stays, and requesttroops reads the same way as its sibling.
//
// Who sends, line by line (wiki: RequestResources, RequestTroops):
//   * what is already on its way here counts: our own transports and
//     reinforcements heading in, and market purchases in transit.
//   * the NEAREST city that can send the whole batch sends it — enough over
//     <keep>, enough spare transports, a free rally slot. When no city can send
//     it all, the one that can send the most does.
//   * one mission at a time between a sender and this city, going or coming
//     back, as NEAT does; /slots:N on a line allows more. While the city that
//     would be chosen is still busy with this one, the line waits for it
//     rather than calling on a city farther away.
//   * lines one sender serves ride in ONE march: food, wood and stone from the
//     same city is one transport and one rally slot, not three.
//   * a sender is never taken below its own <min> for the same thing either,
//     so two cities cannot hand the same resources back and forth.
//   * the SENDING city's rallypolicy r: / t: / max: and its rally spot are
//     honoured (rally.js).
const C = require('./constants');
const R = require('./rally');

const n = (x) => Number(x || 0);
const fmt = (x) => Math.round(n(x)).toLocaleString('en-US');
// 50000000 -> "50m", 1500 -> "1.5k"
const short = (x) => {
  const v = n(x), a = Math.abs(v);
  const cut = (d, s) => `${(v / d).toFixed(v % d === 0 ? 0 : 1).replace(/\.0$/, '')}${s}`;
  return a >= 1e9 ? cut(1e9, 'b') : a >= 1e6 ? cut(1e6, 'm') : a >= 1e3 ? cut(1e3, 'k') : fmt(v);
};

// same number grammar as goals.js: 5k / 1.5m / 1b
const NUM = (s) => {
  const m = String(s == null ? '' : s).trim().match(/^([\d.]+)\s*([kmbd])?$/i);
  if (!m) return null;
  const v = parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9, d: 1e9 }[(m[2] || '').toLowerCase()] || 1);
  return Number.isFinite(v) ? Math.round(v) : null;
};

const RES_KEYS = ['food', 'wood', 'stone', 'iron', 'gold'];
const RES_WORD = {
  food: 'food', f: 'food', wood: 'wood', lumber: 'wood', w: 'wood', l: 'wood',
  stone: 'stone', s: 'stone', iron: 'iron', i: 'iron', gold: 'gold', g: 'gold',
};

// NEAT troop names and codes, as goals.js and goal-npc.js read them
const TROOP_ALIAS = {
  warr: 'w', cav: 'c', ram: 'r', trans: 't', transport: 't', arch: 'a', pike: 'p', sword: 'sw',
  scout: 's', phract: 'cata', worker: 'wo', ball: 'b', balls: 'b', cat: 'cp',
};
const BY_LOWER_KEY = Object.fromEntries(C.TROOPS.map((t) => [t.key.toLowerCase(), t]));
const BY_NAME = Object.fromEntries(C.TROOPS.map((t) => [t.name.toLowerCase().replace(/\s+/g, ''), t]));
function troopDef(tok) {
  const k = String(tok || '').toLowerCase();
  const one = k.replace(/s$/, '');
  return C.BY_CODE[k] || C.BY_CODE[TROOP_ALIAS[k]] || C.BY_CODE[TROOP_ALIAS[one]]
    || BY_LOWER_KEY[k] || BY_LOWER_KEY[one] || BY_NAME[k] || BY_NAME[one] || null;
}
const TROOP_BY_TYPE = Object.fromEntries(C.TROOPS.map((t) => [t.typeId, t]));

// A transport carries its base load. Logistics research raises it, but the
// flat figure is what has gone through live, and the slack covers march food.
const LOAD = C.BY_KEY.carriage.load;
// Transports are shared with NPC farming, which rides on the same carriages:
// a transfer leaves a quarter of them home, never more than 2,000.
const reserveOf = (carriages) => Math.min(2000, Math.ceil(carriages * 0.25));

// ------------------------------------------------------------------- parsers

function parseRequest(args, troops) {
  const errs = [], sw = {}, rest = [];
  for (const tok of args) {
    const m = String(tok).match(/^\/([a-z]+)(?:[:=](.*))?$/i);
    if (m) { sw[m[1].toLowerCase()] = m[2] === undefined ? true : m[2]; continue; }
    rest.push(String(tok));
  }
  const usage = troops
    ? 'expected: requesttroops <from> <troop> <min> <max> <batch> <keep> [/slots:N]'
    : 'expected: requestresources <from> <type> <min> <max> <batch> <keep> [t] [/slots:N]';
  const [target, what, ...nums] = rest;
  const out = { target: target || null, flag: null, slots: 1 };

  if (!what) { errs.push(usage); return { ...out, amounts: [], errors: errs }; }
  if (troops) {
    const def = troopDef(what);
    if (!def) errs.push(`unknown troop "${what}"`);
    out.troop = def ? def.key : String(what).toLowerCase();
  } else {
    out.type = RES_WORD[String(what).toLowerCase()] || null;
    if (!out.type) { errs.push(`unknown resource "${what}" — food, wood, stone, iron or gold`); out.type = String(what).toLowerCase(); }
  }

  if (!troops && nums.length === 5) {
    out.flag = nums.pop();
    if (!/^(t|trans|transports?|transporters?)$/i.test(out.flag)) errs.push(`only transports carry resources here — drop "${out.flag}"`);
  }
  if (nums.length !== 4) errs.push(`${usage} — ${nums.length} amount(s) given, 4 needed (* for "doesn't matter")`);
  out.amounts = [0, 1, 2, 3].map((i) => {
    const t = nums[i];
    if (t === undefined || t === '*') return null;
    const v = NUM(t);
    if (v === null) errs.push(`"${t}" is not an amount (5m, 200k, 1b or *)`);
    return v;
  });

  for (const [k, v] of Object.entries(sw)) {
    if (k !== 'slots') { errs.push(`unknown switch /${k} — only /slots:N`); continue; }
    if (!/^\d+$/.test(String(v)) || Number(v) < 1) errs.push('/slots needs a whole number, 1 or more');
    else out.slots = Number(v);
  }
  return { ...out, errors: errs };
}

const parsers = {
  requestresources: { kind: 'directive', multi: true, parse: (args) => parseRequest(args, false) },
  requesttroops: { kind: 'directive', multi: true, parse: (args) => parseRequest(args, true) },
};

// ------------------------------------------------------------------- helpers

const resOf = (castle, key) => {
  const r = castle.resource || {};
  return key === 'gold' ? n(r.gold) : n(r[key] && r[key].amount);
};

// "any", "5", "!HubCity", "484,619", or several of those joined by |
function sendersFor(spec, others, game) {
  const parts = String(spec || 'any').split('|').map((s) => s.trim()).filter(Boolean);
  if (!parts.length || parts.some((p) => p.toLowerCase() === 'any')) return others;
  return others.filter((c) => parts.some((p) => {
    const xy = p.match(/^\(?(\d{1,3}),(\d{1,3})\)?$/);
    if (xy) { const at = game.castleXY(c); return !!at && at.x === +xy[1] && at.y === +xy[2]; }
    return String(c.name || '').toLowerCase() === p.replace(/^!/, '').toLowerCase();
  }));
}

// Resources on their way here: our transports still going forward, and market
// purchases in transit (TradeBean.resType 0 food, 1 wood, 2 stone, 3 iron).
function resourcesComing(here, book) {
  const out = Object.fromEntries(RES_KEYS.map((k) => [k, 0]));
  for (const m of book.arriving(here.fieldId, C.MISSION.transport)) {
    for (const k of RES_KEYS) out[k] += n(m.resources[k]);
  }
  const TR = { 0: 'food', 1: 'wood', 2: 'stone', 3: 'iron' };
  for (const t of here.transingTrades || []) {
    const k = TR[Number(t.resType)];
    if (k) out[k] += n(t.amount);
  }
  return out;
}

// Troops this city can count on: at home, out on marches that come back, being
// reinforced in from our other cities, and queued in the barracks. A
// reinforcement it sent away is gone for good and does not count.
function troopsHeld(here, book, training) {
  const out = {};
  const add = (k, v) => { out[k] = n(out[k]) + n(v); };
  for (const [k, v] of Object.entries(here.troop || {})) add(k, v);
  for (const m of book.marchesFrom(here)) {
    if (m.missionType === C.MISSION.reinforce && m.direction !== 2) continue;
    for (const [k, v] of Object.entries(m.troops || {})) add(k, v);
  }
  for (const m of book.arriving(here.fieldId, C.MISSION.reinforce)) {
    if (m.start === Number(here.fieldId)) continue;
    for (const [k, v] of Object.entries(m.troops || {})) add(k, v);
  }
  for (const b of (training && training.barracks) || []) {
    for (const it of b.items || []) { const t = TROOP_BY_TYPE[it.type]; if (t) add(t.key, it.num); }
  }
  return out;
}

const goalsNamed = (goals, name) => (goals || []).filter((g) => g.name === name);

// ---------------------------------------------------------------------- plan

function transferPlan(ctx, state, game) {
  game = game || ctx.game;
  const resRules = goalsNamed(ctx.goals, 'requestresources');
  const troopRules = goalsNamed(ctx.goals, 'requesttroops');
  if (!resRules.length && !troopRules.length) return null;

  const here = ctx.castle;
  const hereId = game.castleId(here);
  const others = (game.castles || []).filter((c) => game.castleId(c) !== hereId);
  const count = resRules.length + troopRules.length;
  if (!others.length) return { note: `requests: ${count} rule(s) idle — needs a second city to pull from`, actions: [] };

  const goalsOf = ctx.goalsOf || (() => null);
  const book = ctx.rally || R.rallyBook({ game, armies: ctx.selfArmies, goalsOf });
  const hereXY = game.castleXY(here);
  // wiki WarTown: a war town sends no resource or troop transports (NEAT holds
  // KeepResource/SendResource/KeepTroop/SendTroop there). The engine answers
  // for any city, its console War Town Mode included. This city being a war
  // town stops nothing here: what it asks for comes IN, which is what a city
  // at war needs, and NEAT does not hold its RequestResources/RequestTroops.
  const warTownOf = ctx.warTownOf || (() => 0);

  // What each possible sender has to give this pass, less what it sent
  // moments ago that its own counts may not show yet.
  const senders = new Map();
  const senderOf = (c) => {
    const cid = game.castleId(c);
    if (senders.has(cid)) return senders.get(cid);
    const sent = book.committed(c);
    const stock = {};
    for (const k of RES_KEYS) stock[k] = Math.max(0, resOf(c, k) - n(sent.resources[k]));
    const troops = {};
    for (const [k, v] of Object.entries(c.troop || {})) troops[k] = Math.max(0, n(v) - n(sent.troops[k]));
    const xy = game.castleXY(c);
    const s = {
      castle: c, dist: xy && hereXY ? Math.hypot(xy.x - hereXY.x, xy.y - hereXY.y) : Infinity,
      stock, troops, goals: goalsOf(c) || [], march: { r: null, t: null },
    };
    senders.set(cid, s);
    return s;
  };
  const plannedFrom = (s) => (s.march.r ? 1 : 0) + (s.march.t ? 1 : 0);

  // A sender's own <min> for the same thing: taking it under that would only
  // have it ask for the lot back.
  const ownMin = (s, goal, key, keyOf) => Math.max(0, ...goalsNamed(s.goals, goal)
    .filter((g) => keyOf(g) === key && g.amounts && g.amounts[0] != null).map((g) => g.amounts[0]));

  // One pass over one goal's lines. `spec` says what is being moved.
  function serve(rules, spec) {
    const lines = [];
    const planned = {};           // what earlier lines already have coming
    for (const g of rules) {
      const key = spec.keyOf(g);
      const [min, max, batch, keep] = g.amounts || [];
      const home = spec.have(key);
      const coming = spec.coming(key) + n(planned[key]);
      const have = home + coming;
      if (min != null && have >= min) continue;
      const want = Math.floor(Math.min((max == null ? Infinity : max) - have, batch == null ? Infinity : batch));
      if (!(want > 0)) continue;
      const head = `${spec.name(key)} ${short(home)}${coming ? ` + ${short(coming)} coming` : ''}${min != null ? ` < ${short(min)}` : ''}`;

      const cands = [], why = [];
      const pool = sendersFor(g.target, others, game);
      for (const c of pool) {
        const war = warTownOf(c);
        if (war) { why.push(`${c.name} is a war town (${war})`); continue; }
        const s = senderOf(c);
        let busy = 0;
        if (!s.march[spec.kind]) {
          // a new march: needs a free pair and a free rally slot at the sender.
          // A sender still busy with this city stays in the running — if it is
          // the one to send, the line waits for it rather than calling on a
          // city farther away.
          busy = book.between(c, here.fieldId, spec.mission) >= g.slots ? g.slots : 0;
          const r = busy ? null : book.room(c, spec.kind, { planned: { total: plannedFrom(s) } });
          if (r && r.room <= 0) { why.push(`${c.name} ${r.why}`); continue; }
        }
        const floor = Math.max(keep == null ? 0 : keep, ownMin(s, spec.goal, key, spec.keyOf));
        const spare = Math.floor(spec.stock(s, key) - floor);
        if (spare <= 0) { why.push(`${c.name} holds ${short(spec.stock(s, key))}, keeps ${short(floor)}`); continue; }
        const carry = spec.carry(s);
        if (carry <= 0) { why.push(`${c.name} has no spare transports`); continue; }
        cands.push({ s, busy, deliver: Math.min(want, spare, carry) });
      }
      // the nearest that can send it all; failing that, whoever can send most
      const full = cands.filter((x) => x.deliver >= want).sort((a, b) => a.s.dist - b.s.dist)[0];
      const best = full || cands.sort((a, b) => b.deliver - a.deliver || a.s.dist - b.s.dist)[0];
      if (!best) {
        lines.push(`${head}: ${pool.length ? `no sender — ${why.slice(0, 3).join('; ')}` : `no city matches "${g.target}"`}`);
        continue;
      }
      if (best.busy) {
        lines.push(`${head}: waiting for ${best.s.castle.name} (${best.s.dist.toFixed(1)} tiles), `
          + `${best.busy > 1 ? `all ${best.busy} of its missions` : 'its last one'} to here not back yet`);
        continue;
      }
      const s = best.s;
      const m = (s.march[spec.kind] = s.march[spec.kind] || { load: {}, slots: g.slots });
      m.load[key] = n(m.load[key]) + best.deliver;
      spec.take(s, key, best.deliver);
      planned[key] = n(planned[key]) + best.deliver;
      lines.push(`${head}: ${short(best.deliver)} from ${s.castle.name} (${s.dist.toFixed(1)} tiles${full ? '' : ', all it can spare'})`);
    }
    return lines;
  }

  const notes = [];

  if (resRules.length) {
    const coming = resourcesComing(here, book);
    const lines = serve(resRules, {
      goal: 'requestresources', kind: 'r', mission: C.MISSION.transport,
      keyOf: (g) => g.type, name: (k) => k,
      have: (k) => resOf(here, k),
      coming: (k) => n(coming[k]),
      stock: (s, k) => s.stock[k],
      take: (s, k, v) => { s.stock[k] -= v; },
      // what the sender's spare transports still hold, after this pass's load
      carry: (s) => {
        const have = n(s.troops.carriage);
        const loaded = s.march.r ? Object.values(s.march.r.load).reduce((a, b) => a + b, 0) : 0;
        return (have - reserveOf(have)) * LOAD - loaded;
      },
    });
    notes.push(`requestresources: ${lines.length ? lines.join('; ') : 'nothing short'}`);
  }
  // transports that go with this pass's resources are not there to be requested
  for (const s of senders.values()) {
    if (!s.march.r) continue;
    const total = Object.values(s.march.r.load).reduce((a, b) => a + b, 0);
    s.troops.carriage = Math.max(0, n(s.troops.carriage) - Math.ceil(total / LOAD));
  }

  if (troopRules.length) {
    // arrivals are already in what the city holds
    const held = troopsHeld(here, book, ctx.training);
    const lines = serve(troopRules, {
      goal: 'requesttroops', kind: 't', mission: C.MISSION.reinforce,
      keyOf: (g) => g.troop, name: (k) => (C.BY_KEY[k] ? C.BY_KEY[k].name : k),
      have: (k) => n(held[k]),
      coming: () => 0,
      stock: (s, k) => n(s.troops[k]),
      take: (s, k, v) => { s.troops[k] = n(s.troops[k]) - v; },
      carry: () => Infinity,
    });
    notes.push(`requesttroops: ${lines.length ? lines.join('; ') : 'nothing short'}`);
  }

  const actions = [];
  for (const s of [...senders.values()].sort((a, b) => a.dist - b.dist)) {
    const dist = s.dist.toFixed(1);
    if (s.march.r) {
      const resources = s.march.r.load;
      const total = Object.values(resources).reduce((a, b) => a + b, 0);
      const carriages = Math.ceil(total / LOAD);
      actions.push({
        kind: 'transport', from: s.castle, to: here, resources, carriages, distance: s.dist,
        rally: {
          from: s.castle, kind: 'r', missionType: C.MISSION.transport, targetFieldId: here.fieldId,
          pairLimit: s.march.r.slots, resources, troops: { carriage: carriages },
        },
        label: `pull ${Object.entries(resources).map(([k, v]) => `${fmt(v)} ${k}`).join(' + ')} from ${s.castle.name} `
          + `(${dist} tiles, ${fmt(carriages)} transports)`,
      });
    }
    if (s.march.t) {
      const troops = s.march.t.load;
      actions.push({
        kind: 'reinforceTroops', from: s.castle, to: here, troops, distance: s.dist,
        rally: {
          from: s.castle, kind: 't', missionType: C.MISSION.reinforce, targetFieldId: here.fieldId,
          pairLimit: s.march.t.slots, troops,
        },
        label: `pull ${Object.entries(troops).map(([k, v]) => `${fmt(v)} ${C.BY_KEY[k] ? C.BY_KEY[k].name : k}`).join(' + ')} `
          + `from ${s.castle.name} (${dist} tiles)`,
      });
    }
  }
  return { note: notes.join(' | '), actions };
}

// ----------------------------------------------------------------- executors

const executors = {
  // army.newArmy, missionType 1: the transports unload and come home
  async transport(game, castle, a) {
    const xy = game.castleXY(a.to);
    const bean = game.buildArmyBean({
      missionType: C.MISSION.transport, targetPoint: C.coordsToFieldId(xy.x, xy.y),
      troops: { carriage: a.carriages }, resources: a.resources,
    });
    return game.newArmy(game.castleId(a.from), bean);
  },
  // missionType 2 to our own city: the troops join its garrison and stay
  async reinforceTroops(game, castle, a) {
    const xy = game.castleXY(a.to);
    const bean = game.buildArmyBean({
      missionType: C.MISSION.reinforce, targetPoint: C.coordsToFieldId(xy.x, xy.y), troops: a.troops,
    });
    return game.newArmy(game.castleId(a.from), bean);
  },
};

module.exports = {
  parsers,
  plans: { transfer: transferPlan },
  executors,
  configKeys: [],
  _internals: { parseRequest, troopDef, sendersFor, resourcesComing, troopsHeld, reserveOf, LOAD, short },
};
