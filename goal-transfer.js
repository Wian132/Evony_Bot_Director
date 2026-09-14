'use strict';
// requestresources / requesttroops — top a city up from your other cities.
// NEAT's syntax and NEAT's meaning (wiki: RequestResources, RequestTroops, and
// SendResources/SendTroops, which they mirror):
//
//   requestresources <from> <type>  <localAmount> <remoteAmount> [minBatch] [maxBatch] [troopType] [/slots:N]
//   requesttroops    <from> <troop> <localAmount> <remoteAmount> [minBatch] [maxBatch]             [/slots:N]
//
//   <from>          any, a city name or x,y of your own cities — several joined
//                   by |. The wiki writes names as !HubCity: that "!" is only
//                   its markup (MoinMoin's no-link mark), and the wiki says a
//                   city cannot be excluded with !name, so !Name means Name.
//   localAmount     ask only while this city holds LESS than this, counting
//                   what is already on its way, and never fill it past it.
//   remoteAmount    never take a sending city below this.
//   minBatch        do not send less than this; wait until a batch this big
//                   fits under localAmount and over remoteAmount. Ignored when
//                   the city is critically low: 50% of localAmount or less. (The
//                   page says "of the remoteAmount": its text is SendResources',
//                   where that is the RECEIVING city's amount, i.e. ours here.)
//   maxBatch        at most this much per send. ONE batch number is maxBatch.
//   troopType       what carries the resources (default transports), e.g.
//                   `requestresources HubCity wood 25m 40m 5m * cavalry`.
//   * in place of any amount means "doesn't matter". Up to the two amounts the
//   line needs, then the batches, then the carrier.
//
// OTTObot's own switch, for a trigger below the fill level:
//   /below:<amount>  only START a request once the city holds less than this;
//                    it then still fills to localAmount. Lines saved in this
//                    tool's old order (<min> <max> <batch> <keep>) became
//                    `<max> <keep> * <batch> /below:<min>` (migrate-goals-transfer.js),
//                    which does exactly what they did before.
//
// Who sends, line by line:
//   * what is already on its way here counts: our own transports and
//     reinforcements heading in, and market purchases in transit (wiki: "takes
//     into account resources that will be arriving before the transport
//     could"). All of it counts, even what would land after our send: that
//     only ever asks for less.
//   * the NEAREST city that can send the whole batch sends it — enough over
//     remoteAmount, enough spare carriers, a free rally slot. When no city can
//     send it all, the one that can send the most does.
//   * one mission at a time between a sender and this city, going or coming
//     back, as NEAT does; /slots:N on a line allows more. While the city that
//     would be chosen is still busy with this one, the line waits for it
//     rather than calling on a city farther away.
//   * lines one sender serves ride in ONE march: food, wood and stone from the
//     same city is one march and one rally slot, not three.
//   * a quarter of the sender's carriers (at most 2,000) stay home: NPC farming
//     rides on the same transports.
//   * a sender is never taken below the level at which its own line for the
//     same thing would ask for more (its /below, else its localAmount), so two
//     cities cannot hand the same resources back and forth. The wiki is silent
//     on this; it only ever sends less than NEAT's rule alone would.
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

// Troop and resource words: the one table every goal parser shares
// (constants.js TROOP_WORDS / RES_WORDS).
const troopDef = (tok) => C.troopByWord(tok);
const TROOP_BY_TYPE = Object.fromEntries(C.TROOPS.map((t) => [t.typeId, t]));
const troopName = (k) => (C.BY_KEY[k] ? C.BY_KEY[k].name : k);

// A carrier holds its base load (constants.js TROOPS). Logistics research
// raises it, but the flat figure is what has gone through live with
// transports, and the slack covers march food.
const LOAD = C.BY_KEY.carriage.load;
const loadOf = (key) => (C.BY_KEY[key] || C.BY_KEY.carriage).load;
// Transports are shared with NPC farming, which rides on the same carriages:
// a transfer leaves a quarter of them home, never more than 2,000. Another
// carrier (troopType) is held back the same way. The wiki says nothing on
// this; holding some back only ever sends less.
const reserveOf = (carriages) => Math.min(2000, Math.ceil(carriages * 0.25));

// ------------------------------------------------------------------- parsers

const AMOUNT_HELP = '5m, 200k, 1b, or * for "doesn\'t matter"';
const isAmount = (t) => t === '*' || NUM(t) !== null;

function parseRequest(args, troops) {
  const errs = [], sw = {}, rest = [];
  for (const tok of args) {
    const m = String(tok).match(/^\/([a-z]+)(?:[:=](.*))?$/i);
    if (m) { sw[m[1].toLowerCase()] = m[2] === undefined ? true : m[2]; continue; }
    rest.push(String(tok));
  }
  const usage = troops
    ? 'expected: requesttroops <from> <troop> <localAmount> <remoteAmount> [minBatch] [maxBatch] [/slots:N]'
    : 'expected: requestresources <from> <type> <localAmount> <remoteAmount> [minBatch] [maxBatch] [troopType] [/slots:N]';
  const [target, what, ...tail] = rest;
  const out = {
    target: target || null, local: null, remote: null, minBatch: null, maxBatch: null, slots: 1,
    ...(troops ? {} : { carrier: 'carriage' }),
  };
  // An amount, or null for *. A word that is not an amount is an error, and
  // the line is then marked not to run (ok:false): reading it as * would mean
  // "no limit", which is the one wrong guess that drains a city.
  const amount = (t, label) => {
    if (t === '*') return null;
    const v = NUM(t);
    if (v === null) errs.push(`${label} "${t}" is not an amount (${AMOUNT_HELP})`);
    return v;
  };

  if (troops) {
    const def = what === undefined ? null : troopDef(what);
    if (what !== undefined && !def) errs.push(`unknown troop "${what}"`);
    out.troop = def ? def.key : String(what || '').toLowerCase();
  } else {
    out.type = what === undefined ? null : C.resourceByWord(what);
    if (what !== undefined && !out.type) errs.push(`unknown resource "${what}" — food, wood, stone, iron or gold`);
    if (!out.type) out.type = String(what || '').toLowerCase();
  }

  // wiki: "The city to request from, resource type, local amount, and remote
  // amount are required."
  if (tail.length < 2) {
    errs.push(`${usage} — the city, the ${troops ? 'troop' : 'resource'}, localAmount and remoteAmount are required`);
  }
  const [localTok, remoteTok, ...more] = tail;
  if (localTok !== undefined) out.local = amount(localTok, 'localAmount');
  if (remoteTok !== undefined) out.remote = amount(remoteTok, 'remoteAmount');

  // Then up to two batch sizes and, for resources, the troop that carries them.
  if (!troops && more.length && !isAmount(more[more.length - 1])) {
    const tok = more.pop();
    const def = troopDef(tok);
    if (!def) errs.push(`unknown troop "${tok}" to carry the resources (transports by default, or e.g. cavalry)`);
    else out.carrier = def.key;
  }
  const words = more.filter((tok) => !isAmount(tok));
  if (words.length) {
    for (const w of words) {
      errs.push(`"${w}" is not an amount (${AMOUNT_HELP})`
        + `${troops && troopDef(w) ? ' — requesttroops moves the troops themselves and takes no troopType' : ''}`);
    }
  } else if (more.length > 2) {
    errs.push(`${usage} — ${more.length} batch sizes given, at most two (minBatch maxBatch)`);
  } else if (more.length === 1) {
    out.maxBatch = amount(more[0], 'maxBatch');   // wiki: a single batch number is the MAXIMUM
  } else if (more.length === 2) {
    out.minBatch = amount(more[0], 'minBatch');
    out.maxBatch = amount(more[1], 'maxBatch');
  }
  if (out.minBatch != null && out.maxBatch != null && out.minBatch > out.maxBatch) {
    errs.push(`minBatch ${short(out.minBatch)} is more than maxBatch ${short(out.maxBatch)}`);
  }

  for (const [k, v] of Object.entries(sw)) {
    if (k === 'slots') {
      if (!/^\d+$/.test(String(v)) || Number(v) < 1) errs.push('/slots needs a whole number, 1 or more');
      else out.slots = Number(v);
    } else if (k === 'below') {
      // OTTObot's: start asking only under this. * is "doesn't matter".
      if (v === '*') out.below = null;
      else if (v === true || NUM(v) === null) errs.push(`/below needs an amount (${AMOUNT_HELP}), e.g. /below:5m`);
      else out.below = NUM(v);
    } else {
      errs.push(`unknown switch /${k} — /slots:N or /below:<amount>`);
    }
  }
  return { ...out, ok: errs.length === 0, errors: errs };
}

const parsers = {
  requestresources: { kind: 'directive', multi: true, parse: (args) => parseRequest(args, false) },
  requesttroops: { kind: 'directive', multi: true, parse: (args) => parseRequest(args, true) },
};

// One line for the editor's "what these goals mean" list (goals.js describe).
function describeRequest(g) {
  const amt = (v) => (v == null ? '*' : Number(v).toLocaleString('en-US'));
  const what = g.name === 'requesttroops' ? troopName(g.troop) : g.type;
  const bits = [g.local == null ? 'whatever this city holds' : `while under ${amt(g.local)}, never past it`];
  if (g.below != null) bits.push(`starting only under ${amt(g.below)}`);
  bits.push(`senders keep ${amt(g.remote)}`);
  const lowNote = g.local != null ? ` (less once under half of ${amt(g.local)})` : '';
  if (g.minBatch == null && g.maxBatch == null) bits.push('any batch size');
  else if (g.minBatch == null) bits.push(`at most ${amt(g.maxBatch)} per send`);
  else if (g.maxBatch == null) bits.push(`at least ${amt(g.minBatch)} per send${lowNote}`);
  else bits.push(`${amt(g.minBatch)} to ${amt(g.maxBatch)} per send${lowNote}`);
  if (g.carrier && g.carrier !== 'carriage') bits.push(`carried by ${troopName(g.carrier)}`);
  if (g.slots > 1) bits.push(`${g.slots} missions at a time`);
  return `${g.name || 'request'}: ${what} from ${g.target}, ${bits.join(', ')}${g.ok === false ? ' — NOT RUN, the line has errors' : ''}`;
}

// ------------------------------------------------------------------- helpers

const resOf = (castle, key) => {
  const r = castle.resource || {};
  return key === 'gold' ? n(r.gold) : n(r[key] && r[key].amount);
};

// "any", "5", "!HubCity", "484,619", or several of those joined by |. A leading
// ! is dropped: on the wiki it is markup that stops a CamelCase name becoming a
// page link, and the wiki says outright that !name excludes nothing.
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

// Where a line starts asking: its /below when it has one (/below:* = no level
// of its own), else its localAmount.
const triggerOf = (g) => (g.below !== undefined ? g.below : g.local);

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

  // The level at which a sender's own line for the same thing would start
  // asking for more: its /below, else its localAmount (* = none). Taking it
  // under that would only have it ask for the lot back.
  const ownFloor = (s, goal, key, keyOf) => Math.max(0, ...goalsNamed(s.goals, goal)
    .filter((g) => keyOf(g) === key).map(triggerOf).filter((v) => v != null));

  // One pass over one goal's lines. `spec` says what is being moved.
  function serve(rules, spec) {
    const lines = [];
    const planned = {};           // what earlier lines already have coming
    for (const g of rules) {
      const key = spec.keyOf(g);
      // A line with a mistake in it could only be guessed at, and a guess about
      // amounts is how a city gets drained. It does nothing until it is fixed.
      if (g.ok === false) { lines.push(`line ${g.line || '?'} not run — it has errors`); continue; }
      const home = spec.have(key);
      const coming = spec.coming(key) + n(planned[key]);
      const have = home + coming;
      // wiki: "You must have BELOW this amount in order to have a request sent"
      if (g.local != null && have >= g.local) continue;
      if (g.below != null && have >= g.below) continue;        // /below: not yet
      // never past localAmount, and no more than maxBatch at a time
      const want = Math.floor(Math.min(g.local == null ? Infinity : g.local - have, g.maxBatch == null ? Infinity : g.maxBatch));
      if (!(want > 0)) continue;
      // wiki: 50% or less of what the city should hold is critically low, and
      // then the minimum batch no longer holds a smaller send back
      const critical = g.local != null && have <= g.local / 2;
      const minBatch = g.minBatch != null && !critical ? g.minBatch : 0;
      const trigger = triggerOf(g);
      const head = `${spec.name(key)} ${short(home)}${coming ? ` + ${short(coming)} coming` : ''}${trigger != null ? ` < ${short(trigger)}` : ''}`
        + `${critical && g.minBatch != null ? ' (critically low)' : ''}`;
      // wiki: a minimum batch that would put this city over localAmount waits
      if (minBatch > want) {
        lines.push(`${head}: waiting — only ${short(want)} fits under ${short(g.local)}, the minimum batch is ${short(minBatch)}`);
        continue;
      }

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
        // wiki: "The bot will not put the sending city below the remote amount"
        const floor = Math.max(g.remote == null ? 0 : g.remote, ownFloor(s, spec.goal, key, spec.keyOf));
        const spare = Math.floor(spec.stock(s, key) - floor);
        if (spare <= 0) { why.push(`${c.name} holds ${short(spec.stock(s, key))}, keeps ${short(floor)}`); continue; }
        const carry = spec.carry(s, g);
        if (carry <= 0) { why.push(`${c.name} has no spare ${spec.carrierName(g)}`); continue; }
        const deliver = Math.min(want, spare, carry);
        // wiki: a minimum batch that would put the sender under remoteAmount waits
        if (deliver < minBatch) {
          why.push(`${c.name} can send ${short(deliver)}, under the ${short(minBatch)} minimum batch`);
          continue;
        }
        cands.push({ s, busy, deliver });
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
      const m = (s.march[spec.kind] = s.march[spec.kind] || { load: {}, carried: {}, slots: g.slots });
      m.load[key] = n(m.load[key]) + best.deliver;
      if (spec.carrierOf) { const ck = spec.carrierOf(g); m.carried[ck] = n(m.carried[ck]) + best.deliver; }
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
      // transports unless the line names another troopType
      carrierOf: (g) => g.carrier || 'carriage',
      carrierName: (g) => (!g.carrier || g.carrier === 'carriage' ? 'transports' : troopName(g.carrier)),
      // what the sender's spare carriers of this line's kind still hold, after
      // what this pass has loaded on them already
      carry: (s, g) => {
        const k = g.carrier || 'carriage';
        const have = n(s.troops[k]);
        const loaded = s.march.r ? n(s.march.r.carried[k]) : 0;
        return (have - reserveOf(have)) * loadOf(k) - loaded;
      },
    });
    notes.push(`requestresources: ${lines.length ? lines.join('; ') : 'nothing short'}`);
  }
  // carriers that go with this pass's resources are not there to be requested
  for (const s of senders.values()) {
    if (!s.march.r) continue;
    for (const [k, amount] of Object.entries(s.march.r.carried)) {
      s.troops[k] = Math.max(0, n(s.troops[k]) - Math.ceil(amount / loadOf(k)));
    }
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
      carrierName: () => 'troops',
      carry: () => Infinity,
    });
    notes.push(`requesttroops: ${lines.length ? lines.join('; ') : 'nothing short'}`);
  }

  const actions = [];
  for (const s of [...senders.values()].sort((a, b) => a.dist - b.dist)) {
    const dist = s.dist.toFixed(1);
    if (s.march.r) {
      const resources = s.march.r.load;
      // each carrier kind takes what its lines loaded, a whole unit at a time
      const troops = {};
      for (const [k, amount] of Object.entries(s.march.r.carried)) {
        if (amount > 0) troops[k] = Math.ceil(amount / loadOf(k));
      }
      const carriages = n(troops.carriage);
      const carriers = Object.keys(troops).length === 1 && carriages
        ? `${fmt(carriages)} transports`
        : Object.entries(troops).map(([k, v]) => `${fmt(v)} ${k === 'carriage' ? 'transports' : troopName(k)}`).join(' + ');
      actions.push({
        kind: 'transport', from: s.castle, to: here, resources, carriages, troops, distance: s.dist,
        rally: {
          from: s.castle, kind: 'r', missionType: C.MISSION.transport, targetFieldId: here.fieldId,
          pairLimit: s.march.r.slots, resources, troops,
        },
        label: `pull ${Object.entries(resources).map(([k, v]) => `${fmt(v)} ${k}`).join(' + ')} from ${s.castle.name} `
          + `(${dist} tiles, ${carriers})`,
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
  // army.newArmy, missionType 1: the carriers unload and come home. Every troop
  // in a march carries its load (NewArmyWin.as:2849-3003 adds each type's
  // load x (1 + loadSkillParam/100)), so another troopType just rides in `troops`.
  async transport(game, castle, a) {
    const xy = game.castleXY(a.to);
    const bean = game.buildArmyBean({
      missionType: C.MISSION.transport, targetPoint: C.coordsToFieldId(xy.x, xy.y),
      troops: a.troops || { carriage: a.carriages }, resources: a.resources,
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
  describeRequest,
  _internals: { parseRequest, troopDef, sendersFor, resourcesComing, troopsHeld, reserveOf, triggerOf, LOAD, short },
};
