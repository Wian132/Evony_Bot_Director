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
//
// The PUSH goals (wiki: KeepResources, SendResources, KeepTroops, SendTroops)
// are written in the SENDING city and are planned in its own slice (pushPlan):
//
//   keepresources <to> <res:amt[,res:amt]> [minBatch] [troopType] [/slots:N]
//   sendresources <to> <type>  <localAmount> <remoteAmount> [minBatch] [maxBatch] [troopType] [/slots:N]
//   keeptroops    <to> <troop:amt[,troop:amt]> [minBatch] [/slots:N]
//   sendtroops    <to> <troop> <localAmount> <remoteAmount> [minBatch] [maxBatch] [/slots:N]
//
//   <to>            any (our other cities), a city name, or x,y — several
//                   joined by |. x,y may be ANOTHER account's city: its stock
//                   cannot be read, so a line with a remoteAmount waits there
//                   and says why (write * to send regardless). keep* lines have
//                   no remoteAmount, which is why the wiki's cross-account
//                   examples are keepresources.
//   localAmount     never take THIS city below it; it must hold more to send.
//   remoteAmount    never fill the receiver past it; it must hold less.
//   keep lines      keepresources 111,222 f:1b 50m is sendresources with
//                   localAmount 1b, remoteAmount * and minBatch 50m, one per
//                   resource or troop listed. With a troopType the minimum
//                   batch must be written (wiki: "MUST be included").
//   batches, *, the carrier and /slots read as they do for requestresources;
//   a receiver at 50% of remoteAmount or less is critically low and the
//   minimum batch no longer holds a smaller send back.
//
// Who receives, line by line:
//   * receivers are served nearest first. With `any` every other city of ours
//     may receive, and one is never filled past the level at which its own
//     keep/send line for the same thing would push it on again (so two cities
//     cannot hand the same food back and forth); a city named outright is
//     filled as the line says, so hub chains work.
//   * one mission at a time from this city to each receiver, going or coming
//     back (/slots:N allows more); a receiver still busy is skipped, the next
//     one below its remoteAmount is served.
//   * what is already on its way to a receiver of ours counts, market
//     purchases in transit included.
//   * this city is never taken below the level at which its own
//     requestresources/requesttroops line for the same thing would ask for
//     more (the same guard as above, the other way round).
//   * a war town sends nothing (wiki WarTown: KeepResource, SendResource,
//     KeepTroop and SendTroop are held there).
//   * what the upkeep goals need stays (goal-upkeep.upkeepFloor): gold never
//     goes under the day of hero salary the rewards, the tax and the cure keep
//     back, nor food under what the next comfort costs while comfort is on —
//     floors, so a line that keeps more already keeps them. And the next
//     construction's cost (Engine.resolveBuild) is never shipped out of this
//     city: it counts as spent, on top of whatever the line keeps.
//   * what this city holds is what is AT HOME: troops out farming do not count
//     towards what a keep line keeps, so the city never dips under it while
//     they are out (a requestresources sender is read the same way). The wiki
//     is silent; this only ever sends less.
//   * a quarter of the carriers (at most 2,000) stay home, as for requests.
const C = require('./constants');
const R = require('./rally');
const U = require('./goal-upkeep');

const n = (x) => Number(x || 0);
const fmt = (x) => Math.round(n(x)).toLocaleString('en-US');
// 50000000 -> "50m", 1500 -> "1.5k"
const short = (x) => {
  const v = n(x), a = Math.abs(v);
  const cut = (d, s) => `${(v / d).toFixed(v % d === 0 ? 0 : 1).replace(/\.0$/, '')}${s}`;
  return a >= 1e9 ? cut(1e9, 'b') : a >= 1e6 ? cut(1e6, 'm') : a >= 1e3 ? cut(1e3, 'k') : fmt(v);
};

// The push notes keep two decimals, so a keep of 2.95b does not read as 3b
// (the request notes keep their one decimal, as before).
const short2 = (x) => {
  const v = n(x), a = Math.abs(v);
  if (!Number.isFinite(v)) return 'no limit';
  const cut = (d, s) => `${+(v / d).toFixed(2)}${s}`;
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

// A push line's destination, checked when the line is read: any, a city name
// (!Name = Name) or x,y on the 800 x 800 map (C.MAP_W; 0-799 each way),
// several joined by |. A name may be all digits — Lord02's cities are
// "5", "8" and "9" — so only a part with a comma in it, made of nothing but
// digits, is taken for coordinates, and must then be x,y on the map. Names
// cannot be checked until the cities are known; the plan says when one
// matches none.
function checkTarget(target, errs) {
  if (!target) return;
  const parts = String(target).split('|');
  if (parts.some((p) => !p.trim())) errs.push(`"${target}" has an empty place between its | marks`);
  for (const p of parts.map((s) => s.trim()).filter(Boolean)) {
    if (!p.includes(',') || !/^[\d,()-]+$/.test(p)) continue;        // any, or a name
    const xy = p.match(/^\(?(\d+),(\d+)\)?$/);
    if (!xy) errs.push(`"${p}" is not x,y — write the coordinates as 111,222`);
    else if (Number(xy[1]) >= C.MAP_W || Number(xy[2]) >= C.MAP_W) errs.push(`${p} is off the map — x and y run from 0 to ${C.MAP_W - 1}`);
  }
}

// A switch given twice on one push line: which value was meant can only be
// guessed, so it is an error.
function noteSwitch(sw, k, errs) {
  if (sw[k] !== undefined) errs.push(`/${k} is given twice on the line`);
}

// `push` reads sendresources / sendtroops: the same fields, but the city is
// where they go (<to>), and /below (a trigger for asking) has no meaning.
function parseRequest(args, troops, { push = false } = {}) {
  const errs = [], sw = {}, rest = [];
  for (const tok of args) {
    const m = String(tok).match(/^\/([a-z]+)(?:[:=](.*))?$/i);
    if (m) {
      if (push) noteSwitch(sw, m[1].toLowerCase(), errs);
      sw[m[1].toLowerCase()] = m[2] === undefined ? true : m[2];
      continue;
    }
    rest.push(String(tok));
  }
  const verb = push ? 'send' : 'request';
  const city = push ? '<to>' : '<from>';
  const usage = troops
    ? `expected: ${verb}troops ${city} <troop> <localAmount> <remoteAmount> [minBatch] [maxBatch] [/slots:N]`
    : `expected: ${verb}resources ${city} <type> <localAmount> <remoteAmount> [minBatch] [maxBatch] [troopType] [/slots:N]`;
  const [target, what, ...tail] = rest;
  const out = {
    target: target || null, local: null, remote: null, minBatch: null, maxBatch: null, slots: 1,
    ...(troops ? {} : { carrier: 'carriage' }),
  };
  if (push) checkTarget(target, errs);
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
        + `${troops && troopDef(w) ? ` — ${verb}troops moves the troops themselves and takes no troopType` : ''}`);
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
    } else if (k === 'below' && !push) {
      // OTTObot's: start asking only under this. * is "doesn't matter".
      if (v === '*') out.below = null;
      else if (v === true || NUM(v) === null) errs.push(`/below needs an amount (${AMOUNT_HELP}), e.g. /below:5m`);
      else out.below = NUM(v);
    } else {
      errs.push(`unknown switch /${k} — ${push ? '/slots:N' : '/slots:N or /below:<amount>'}`);
    }
  }
  return { ...out, ok: errs.length === 0, errors: errs };
}

// keepresources <to> <res:amt[,res:amt]> [minBatch] [troopType] [/slots:N]
// keeptroops    <to> <troop:amt[,troop:amt]> [minBatch] [/slots:N]
// (wiki KeepResources, KeepTroops). `keep` maps each resource or troop to the
// amount this city keeps; everything over it goes.
function parseKeep(args, troops) {
  const errs = [], sw = {}, rest = [];
  for (const tok of args) {
    const m = String(tok).match(/^\/([a-z]+)(?:[:=](.*))?$/i);
    if (m) {
      noteSwitch(sw, m[1].toLowerCase(), errs);
      sw[m[1].toLowerCase()] = m[2] === undefined ? true : m[2];
      continue;
    }
    rest.push(String(tok));
  }
  const usage = troops
    ? 'expected: keeptroops <to> <troop:amount[,troop:amount]> [minBatch] [/slots:N]'
    : 'expected: keepresources <to> <res:amount[,res:amount]> [minBatch] [troopType] [/slots:N]';
  const [target, list, ...tail] = rest;
  const out = { target: target || null, keep: {}, minBatch: null, slots: 1, ...(troops ? {} : { carrier: 'carriage' }) };
  if (!target || !list) errs.push(`${usage} — the city to send to and what to keep are required`);
  checkTarget(target, errs);

  for (const part of String(list || '').split(',')) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf(':');
    const code = i < 0 ? p : p.slice(0, i), amt = i < 0 ? null : p.slice(i + 1);
    const key = troops ? (troopDef(code) || {}).key : C.resourceByWord(code);
    if (!key) {
      errs.push(troops ? `unknown troop "${code}"` : `unknown resource "${code}" — f, w, s, i or g (food, wood, stone, iron, gold)`);
      continue;
    }
    // "*" would mean keep nothing and send it all: that is a guess worth refusing
    const v = amt === null ? null : NUM(amt);
    if (v === null) { errs.push(`"${p}" needs an amount to keep, e.g. ${code}:20m`); continue; }
    // two amounts for one thing: which was meant can only be guessed
    if (out.keep[key] !== undefined) { errs.push(`${troops ? troopName(key) : key} is listed twice in "${list}"`); continue; }
    out.keep[key] = v;
  }
  if (list && !Object.keys(out.keep).length && !errs.length) errs.push(`${usage} — nothing to keep in "${list}"`);

  // Then the minimum batch and, for resources, the troop that carries them.
  const more = [...tail];
  if (!troops && more.length && !isAmount(more[more.length - 1])) {
    const tok = more.pop();
    const def = troopDef(tok);
    if (!def) errs.push(`unknown troop "${tok}" to carry the resources (transports by default, or e.g. cavalry)`);
    else out.carrier = def.key;
    // wiki KeepResources: "If specifying a troop type, the minimum batch MUST be included."
    if (def && !more.length) {
      errs.push(`with a troop type (${tok}) the minimum batch must be written first, e.g. keepresources ${target || '<to>'} ${list || '<res:amount>'} 5m ${tok} (* for any size)`);
    }
  }
  const words = more.filter((tok) => !isAmount(tok));
  if (words.length) {
    for (const w of words) errs.push(`"${w}" is not an amount (${AMOUNT_HELP})`);
  } else if (more.length > 1) {
    errs.push(`${usage} — one minimum batch at most, ${more.length} numbers given`);
  } else if (more.length === 1 && more[0] !== '*') {
    out.minBatch = NUM(more[0]);
  }

  for (const [k, v] of Object.entries(sw)) {
    if (k === 'slots') {
      if (!/^\d+$/.test(String(v)) || Number(v) < 1) errs.push('/slots needs a whole number, 1 or more');
      else out.slots = Number(v);
    } else {
      errs.push(`unknown switch /${k} — /slots:N`);
    }
  }
  return { ...out, ok: errs.length === 0, errors: errs };
}

const parsers = {
  requestresources: { kind: 'directive', multi: true, parse: (args) => parseRequest(args, false) },
  requesttroops: { kind: 'directive', multi: true, parse: (args) => parseRequest(args, true) },
  sendresources: { kind: 'directive', multi: true, parse: (args) => parseRequest(args, false, { push: true }) },
  sendtroops: { kind: 'directive', multi: true, parse: (args) => parseRequest(args, true, { push: true }) },
  keepresources: { kind: 'directive', multi: true, parse: (args) => parseKeep(args, false) },
  // the wiki's own examples write it singular
  keepresource: { kind: 'directive', multi: true, parse: (args) => parseKeep(args, false) },
  keeptroops: { kind: 'directive', multi: true, parse: (args) => parseKeep(args, true) },
};

// Which kind of march each push goal makes: r resources, t troops.
const PUSH_GOALS = { keepresources: 'r', keepresource: 'r', sendresources: 'r', keeptroops: 't', sendtroops: 't' };

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

// The same for the push goals (keepresources, sendresources, keeptroops, sendtroops).
function describePush(g) {
  const amt = (v) => (v == null ? '*' : Number(v).toLocaleString('en-US'));
  const troops = PUSH_GOALS[g.name] === 't';
  const nameOf = (k) => (troops ? troopName(k) : k);
  const bits = [];
  let what;
  if (g.keep) {
    what = Object.entries(g.keep).map(([k, v]) => `${nameOf(k)} over ${amt(v)}`).join(', ');
    bits.push(g.minBatch == null ? 'any amount' : `at least ${amt(g.minBatch)} at a time`);
  } else {
    what = nameOf(troops ? g.troop : g.type);
    bits.push(g.local == null ? 'whatever this city holds' : `while this city holds over ${amt(g.local)}, never below it`);
    bits.push(g.remote == null ? 'however much the receiver holds' : `to a receiver under ${amt(g.remote)}, never past it`);
    const lowNote = g.remote != null ? ` (less once it is under half of ${amt(g.remote)})` : '';
    if (g.minBatch == null && g.maxBatch == null) bits.push('any batch size');
    else if (g.minBatch == null) bits.push(`at most ${amt(g.maxBatch)} per send`);
    else if (g.maxBatch == null) bits.push(`at least ${amt(g.minBatch)} per send${lowNote}`);
    else bits.push(`${amt(g.minBatch)} to ${amt(g.maxBatch)} per send${lowNote}`);
  }
  if (g.carrier && g.carrier !== 'carriage') bits.push(`carried by ${troopName(g.carrier)}`);
  if (g.slots > 1) bits.push(`${g.slots} missions at a time to each receiver`);
  return `${g.name}: ${what} to ${g.target}, ${bits.join(', ')}${g.ok === false ? ' — NOT RUN, the line has errors' : ''}`;
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

// ----------------------------------------------------------------- push plan

// Where a push line sends: "any" (our other cities), "Name" or "!Name", "x,y",
// several joined by |. An x,y that is none of our cities is another account's
// field; it can be sent to, but its stock cannot be read. `byAny` marks a
// city only `any` picked (receiverCeiling applies to it). Nearest first.
function receiversFor(spec, here, others, game) {
  const hereXY = game.castleXY(here);
  const dist = (xy) => (xy && hereXY ? Math.hypot(xy.x - hereXY.x, xy.y - hereXY.y) : Infinity);
  const byField = new Map(), unknown = [];
  const add = (r) => {
    const had = byField.get(r.fieldId);
    if (had) { had.byAny = had.byAny && r.byAny; return; }     // named outright wins over `any`
    byField.set(r.fieldId, r);
  };
  const own = (c, byAny) => ({
    castle: c, fieldId: Number(c.fieldId), name: c.name || String(game.castleId(c)), foreign: false, byAny,
    dist: dist(game.castleXY(c)),
  });
  for (const p of String(spec || '').split('|').map((s) => s.trim()).filter(Boolean)) {
    if (p.toLowerCase() === 'any') { for (const c of others) add(own(c, true)); continue; }
    const xy = p.match(/^\(?(\d{1,3}),(\d{1,3})\)?$/);
    if (xy) {
      const x = +xy[1], y = +xy[2];
      const at = hereXY && hereXY.x === x && hereXY.y === y;
      if (at) { unknown.push(`${p} is this city`); continue; }
      const c = others.find((o) => { const o2 = game.castleXY(o); return !!o2 && o2.x === x && o2.y === y; });
      add(c ? own(c, false) : { castle: null, fieldId: C.coordsToFieldId(x, y), name: `${x},${y}`, foreign: true, byAny: false, dist: dist({ x, y }) });
      continue;
    }
    const name = p.replace(/^!/, '').toLowerCase();
    const c = others.find((o) => String(o.name || '').toLowerCase() === name);
    if (c) add(own(c, false));
    else if (String(here.name || '').toLowerCase() === name) unknown.push(`${p} is this city`);
    else unknown.push(`no city of ours is named "${p.replace(/^!/, '')}" (another account's city needs x,y)`);
  }
  return { list: [...byField.values()].sort((a, b) => a.dist - b.dist), unknown };
}

// A city `any` picked is never filled past the level at which its own keep or
// send line for the same thing would push it on again: its keep amount, or its
// sendresources/sendtroops localAmount. Otherwise two cities keeping 1b food
// each would hand the same food back and forth. Infinity when it has none.
function receiverCeiling(goals, key, troops) {
  let cap = Infinity;
  for (const g of goals || []) {
    if (g.ok === false || !PUSH_GOALS[g.name] || (PUSH_GOALS[g.name] === 't') !== troops) continue;
    if (g.keep) { if (g.keep[key] != null) cap = Math.min(cap, g.keep[key]); continue; }
    if ((troops ? g.troop : g.type) === key && g.local != null) cap = Math.min(cap, g.local);
  }
  return cap;
}

// A push line as one item per thing it moves: keep lines are sendresources /
// sendtroops with remoteAmount * and no maxBatch, one per resource or troop.
function pushItems(g) {
  if (g.keep) {
    return Object.entries(g.keep).map(([key, kept]) => ({
      g, key, local: kept, remote: null, minBatch: g.minBatch, maxBatch: null, carrier: g.carrier, slots: g.slots,
    }));
  }
  return [{ g, key: PUSH_GOALS[g.name] === 't' ? g.troop : g.type, local: g.local, remote: g.remote,
    minBatch: g.minBatch, maxBatch: g.maxBatch, carrier: g.carrier, slots: g.slots }];
}

function pushPlan(ctx, state, game) {
  game = game || ctx.game;
  const all = (ctx.goals || []).filter((g) => PUSH_GOALS[g.name]);
  if (!all.length) return null;
  const here = ctx.castle;
  const hereId = game.castleId(here);

  // wiki WarTown: a war town holds its KeepResource, SendResource, KeepTroop
  // and SendTroop goals. The engine answers for any city (its console War Town
  // Mode included); without the engine, the city's own config and wartownpolicy.
  const war = ctx.warTownOf ? ctx.warTownOf(here) : require('./goal-war').isWarTown(ctx);
  if (war) {
    return { note: `send: ${all.length} line(s) held — this city is a war town (${war}), so nothing is sent from it`, actions: [] };
  }

  const others = (game.castles || []).filter((c) => game.castleId(c) !== hereId);
  const goalsOf = ctx.goalsOf || (() => null);
  const book = ctx.rally || R.rallyBook({ game, armies: ctx.selfArmies, goalsOf });

  // What this city has to give, less what it sent moments ago that its own
  // counts may not show yet.
  const sent = book.committed(here);
  const stock = {};
  for (const k of RES_KEYS) stock[k] = Math.max(0, resOf(here, k) - n(sent.resources[k]));
  const home = {};
  for (const [k, v] of Object.entries(here.troop || {})) home[k] = Math.max(0, n(v) - n(sent.troops[k]));

  // Never below the level at which this city's own request line for the same
  // thing would ask for it back (its /below, else its localAmount).
  const ownFloor = (goal, key, keyOf) => Math.max(0, ...goalsNamed(ctx.goals, goal)
    .filter((g) => g.ok !== false && keyOf(g) === key).map(triggerOf).filter((v) => v != null));
  // What the other goals keep, kept here too. The upkeep goals' floors
  // (goal-upkeep.upkeepFloor): gold never under the day of hero salary the
  // rewards, the tax and the cure keep back (goal-heroes.salaryReserve), food
  // never under what the next comfort costs. The next construction's cost
  // (ctx.buildReserve, Engine.resolveBuild) is never shipped out of the bank
  // it waits in — it counts as spent, as the troop batches and the upkeep goals
  // count it.
  const up = U.upkeepFloor(ctx.game ? ctx : { ...ctx, game });
  const upkeepKeep = (k) => n(k === 'gold' || k === 'food' ? up[k] : 0);
  const build = ctx.buildReserve || null;
  const buildKeep = (k) => Math.max(0, n(build && build[k]));
  // " (kept: ...)" for a note: the upkeep floor only where it is what sets
  // the floor (a line keeping more keeps it already), the construction always
  const keptBy = (key, upkeepSets) => {
    const bits = [];
    if (upkeepSets) bits.push(`${short2(upkeepKeep(key))} for ${up.text[key]}`);
    if (buildKeep(key)) bits.push(`${short2(buildKeep(key))} for ${(build && build.label) || 'the next construction'}`);
    return bits.length ? ` (kept: ${bits.join(', ')})` : '';
  };

  const marches = new Map();            // receiver fieldId -> { recv, r, t }
  const planned = { r: 0, t: 0 };       // new marches this pass, by kind
  const plannedTo = { r: new Map(), t: new Map() };   // fieldId -> { key: amount } this pass
  const loaded = {};                    // carrier -> amount loaded on it this pass
  const coming = new Map(), held = new Map();

  function serve(items, spec) {
    const out = [];
    for (const item of items) {
      const { g, key } = item;
      if (g.ok === false) { out.push(`line ${g.line || '?'} not run — it has errors`); continue; }
      // resources: never under the upkeep floor, and the construction's share on top
      const res = spec.kind === 'r';
      const base = Math.max(item.local == null ? 0 : item.local, ownFloor(spec.request, key, spec.keyOf));
      const upk = res ? upkeepKeep(key) : 0;
      const floor = Math.max(base, upk) + (res ? buildKeep(key) : 0);
      let spare = Math.floor(spec.spare(key, floor));
      // wiki: "You must have OVER this amount in order to send some"
      if (spare <= 0) continue;
      const head = `${spec.name(key)} ${short2(spec.stock(key))} over ${short2(floor)}${res ? keptBy(key, upk > base) : ''}`;
      const { list, unknown } = receiversFor(g.target, here, others, game);
      const why = [...unknown], sentTo = [];
      for (const recv of list) {
        if (spare <= 0) break;
        // Another account's city: what it holds cannot be read, so a line that
        // must not fill it past remoteAmount cannot send there.
        if (recv.foreign && item.remote != null) {
          why.push(`${recv.name} is not one of this account's cities, so what it holds can't be read — write * as remoteAmount to send there regardless`);
          continue;
        }
        let cap = item.remote == null ? Infinity : item.remote;
        if (recv.byAny) cap = Math.min(cap, receiverCeiling(goalsOf(recv.castle), key, spec.kind === 't'));
        const have = recv.foreign ? 0 : spec.haveAt(recv, key) + n((plannedTo[spec.kind].get(recv.fieldId) || {})[key]);
        // wiki: "It must have BELOW this amount in order to send some"
        if (have >= cap) continue;
        const want = Math.min(cap - have, item.maxBatch == null ? Infinity : item.maxBatch);
        // wiki: 50% or less of the remoteAmount is critically low, and then the
        // minimum batch no longer holds a smaller send back
        const critical = item.remote != null && !recv.foreign && have <= item.remote / 2;
        const minBatch = item.minBatch != null && !critical ? item.minBatch : 0;
        let m = marches.get(recv.fieldId);
        if (!m || !m[spec.kind]) {
          // a new march: one mission at a time to each receiver, going or
          // coming back (/slots), and a free rally slot in this city. A line
          // that rides a march already planned this pass needs neither.
          const busy = book.between(here, recv.fieldId, spec.mission);
          if (busy >= item.slots) {
            why.push(`${recv.name}: ${busy > 1 ? `all ${busy} missions` : 'the last mission'} to it not back yet`);
            continue;
          }
          const r = book.room(here, spec.kind, { planned: { total: planned.r + planned.t, kind: planned[spec.kind] } });
          if (r.room <= 0) { if (!why.includes(r.why)) why.push(r.why); continue; }
        }
        const carry = spec.carry(item);
        if (carry <= 0) { why.push(`no spare ${spec.carrierName(item)}`); break; }
        const deliver = Math.floor(Math.min(want, spare, carry));
        // wiki: a minimum batch that would put this city under localAmount, or
        // the receiver over remoteAmount, waits
        if (deliver < minBatch || deliver <= 0) {
          const limit = deliver >= want ? `only ${short2(want)} fits under ${short2(cap)} there`
            : deliver >= spare ? `only ${short2(spare)} is spare here` : `the spare ${spec.carrierName(item)} carry ${short2(carry)}`;
          why.push(`${recv.name}: ${limit}, under the ${short2(minBatch)} minimum batch`);
          continue;
        }
        if (!m) { m = { recv, r: null, t: null }; marches.set(recv.fieldId, m); }
        if (!m[spec.kind]) { m[spec.kind] = { load: {}, carried: {}, slots: item.slots }; planned[spec.kind]++; }
        m[spec.kind].load[key] = n(m[spec.kind].load[key]) + deliver;
        if (spec.carrierOf) {
          const ck = spec.carrierOf(item);
          m[spec.kind].carried[ck] = n(m[spec.kind].carried[ck]) + deliver;
          loaded[ck] = n(loaded[ck]) + deliver;
        }
        spec.take(key, deliver);
        spare -= deliver;
        const pt = plannedTo[spec.kind].get(recv.fieldId) || {};
        pt[key] = n(pt[key]) + deliver;
        plannedTo[spec.kind].set(recv.fieldId, pt);
        sentTo.push(`${short2(deliver)} to ${recv.name} (${recv.dist.toFixed(1)} tiles${critical && item.minBatch != null ? ', critically low' : ''})`);
      }
      if (sentTo.length) out.push(`${head}: ${sentTo.join(', ')}${why.length ? `; not to the rest — ${why.slice(0, 2).join('; ')}` : ''}`);
      else if (!list.length && !why.length) out.push(`${head}: no city matches "${g.target}"`);
      else out.push(`${head}: ${why.length ? why.slice(0, 3).join('; ') : 'every receiver holds enough'}`);
    }
    return out;
  }

  const notes = [];
  const byName = (kind) => {
    const groups = new Map();
    for (const g of all) {
      if (PUSH_GOALS[g.name] !== kind) continue;
      const nm = g.name === 'keepresource' ? 'keepresources' : g.name;
      if (!groups.has(nm)) groups.set(nm, []);
      groups.get(nm).push(g);
    }
    return groups;
  };

  for (const [nm, lines] of byName('r')) {
    const said = serve(lines.flatMap(pushItems), {
      kind: 'r', mission: C.MISSION.transport, request: 'requestresources', keyOf: (g) => g.type, name: (k) => k,
      stock: (k) => stock[k],
      spare: (k, floor) => stock[k] - floor,
      take: (k, v) => { stock[k] -= v; },
      haveAt: (recv, k) => {
        if (!coming.has(recv.fieldId)) coming.set(recv.fieldId, resourcesComing(recv.castle, book));
        return resOf(recv.castle, k) + n(coming.get(recv.fieldId)[k]);
      },
      carrierOf: (item) => item.carrier || 'carriage',
      carrierName: (item) => (!item.carrier || item.carrier === 'carriage' ? 'transports' : troopName(item.carrier)),
      carry: (item) => {
        const k = item.carrier || 'carriage';
        const have = n(home[k]);
        return (have - reserveOf(have)) * loadOf(k) - n(loaded[k]);
      },
    });
    notes.push(`${nm}: ${said.length ? said.join('; ') : 'nothing over what this city keeps'}`);
  }
  // carriers that go with this pass's resources are not there to be sent
  for (const [k, amount] of Object.entries(loaded)) home[k] = Math.max(0, n(home[k]) - Math.ceil(amount / loadOf(k)));

  for (const [nm, lines] of byName('t')) {
    const said = serve(lines.flatMap(pushItems), {
      kind: 't', mission: C.MISSION.reinforce, request: 'requesttroops', keyOf: (g) => g.troop, name: troopName,
      stock: (k) => n(home[k]),
      spare: (k, floor) => n(home[k]) - floor,
      take: (k, v) => { home[k] = n(home[k]) - v; },
      haveAt: (recv, k) => {
        if (!held.has(recv.fieldId)) held.set(recv.fieldId, troopsHeld(recv.castle, book, null));
        return n(held.get(recv.fieldId)[k]);
      },
      carrierName: () => 'troops',
      carry: () => Infinity,
    });
    notes.push(`${nm}: ${said.length ? said.join('; ') : 'nothing over what this city keeps'}`);
  }

  const actions = [];
  for (const { recv, r, t } of [...marches.values()].sort((a, b) => a.recv.dist - b.recv.dist)) {
    const to = recv.castle || { fieldId: recv.fieldId, name: recv.name };
    const dist = recv.dist.toFixed(1);
    if (r) {
      const troops = {};
      for (const [k, amount] of Object.entries(r.carried)) if (amount > 0) troops[k] = Math.ceil(amount / loadOf(k));
      const carriages = n(troops.carriage);
      const carriers = Object.keys(troops).length === 1 && carriages
        ? `${fmt(carriages)} transports`
        : Object.entries(troops).map(([k, v]) => `${fmt(v)} ${k === 'carriage' ? 'transports' : troopName(k)}`).join(' + ');
      actions.push({
        kind: 'transport', from: here, to, resources: r.load, carriages, troops, distance: recv.dist, foreign: recv.foreign,
        rally: {
          from: here, kind: 'r', missionType: C.MISSION.transport, targetFieldId: recv.fieldId,
          pairLimit: r.slots, resources: r.load, troops,
        },
        label: `send ${Object.entries(r.load).map(([k, v]) => `${fmt(v)} ${k}`).join(' + ')} to ${recv.name} (${dist} tiles, ${carriers})`,
      });
    }
    if (t) {
      actions.push({
        kind: 'reinforceTroops', from: here, to, troops: t.load, distance: recv.dist, foreign: recv.foreign,
        rally: {
          from: here, kind: 't', missionType: C.MISSION.reinforce, targetFieldId: recv.fieldId,
          pairLimit: t.slots, troops: t.load,
        },
        label: `send ${Object.entries(t.load).map(([k, v]) => `${fmt(v)} ${troopName(k)}`).join(' + ')} to ${recv.name} (${dist} tiles)`,
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
  // `a.to` is one of our castles, or { fieldId } for another account's city
  // (a push to x,y); either way the target is its field.
  async transport(game, castle, a) {
    const xy = game.castleXY(a.to);
    const bean = game.buildArmyBean({
      missionType: C.MISSION.transport, targetPoint: C.coordsToFieldId(xy.x, xy.y),
      troops: a.troops || { carriage: a.carriages }, resources: a.resources,
    });
    return game.newArmy(game.castleId(a.from), bean);
  },
  // missionType 2 to a city: the troops join its garrison and stay (in
  // another account's city they are its reinforcements until sent home)
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
  plans: { transfer: transferPlan, push: pushPlan },
  executors,
  configKeys: [],
  describeRequest,
  describePush,
  PUSH_GOALS,
  _internals: { parseRequest, parseKeep, troopDef, sendersFor, receiversFor, receiverCeiling, pushItems,
    resourcesComing, troopsHeld, reserveOf, triggerOf, LOAD, short },
};
