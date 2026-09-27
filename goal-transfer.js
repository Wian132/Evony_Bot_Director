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
//                   * (or more than one march can take) is as much as ONE
//                   march carries: the Rally Spot's troop limit (10,000 a
//                   level) x each carrier's hold at the account's Logistics,
//                   less the march's own food — about 1b on 100,000
//                   transports at Logistics 10 over a short trip.
//   troopType       what carries the resources (default transports), e.g.
//                   `requestresources HubCity wood 25m 40m 5m * cavalry`.
//   * in place of any amount means "doesn't matter". Up to the two amounts the
//   line needs, then the batches, then the carrier.
//
// OTTObot's own switches:
//   /below:<amount>  only START a request once the city holds less than this;
//                    it then still fills to localAmount. Lines saved in this
//                    tool's old order (<min> <max> <batch> <keep>) became
//                    `<max> <keep> * <batch> /below:<min>` (migrate-goals-transfer.js),
//                    which does exactly what they did before.
//   /maxdist:<tiles> never reach farther than this: a request line passes over
//                    a sender more than <tiles> away, a keep/send line a
//                    receiver, and the note says which and how far. `/50` on
//                    its own is the same as /maxdist:50 (the user, 2026-09-25).
//                    The distance is the one the notes already print, this
//                    city's x,y to the other's.
//   /steps:<a>,<b>   (requestresources) even the account out in steps, the
//                    poorest first (the user, 2026-09-19). The steps and then
//                    localAmount are the levels, lowest first. At each level L
//                    a city under L asks, cities over L send, never below L,
//                    and no city is filled past L. A level waits while any city
//                    with the same line is still under a lower level that some
//                    city could still fill. At the last level remoteAmount is
//                    the senders' floor as usual, so cities at the top neither
//                    receive nor hand gold round among themselves. The richest
//                    free sender sends; one out on a mission is not waited for.
//   Food never goes past 950b in a city, counting what is on its way: a
//   city's food resets to 0 at 1t (EVONY-RULES.md §3). No line fills past it.
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
// processingpolicy (processing.js): a resource transport is task r
// (sendresources), a troop reinforcement task t (sendtroops) — pushed from this
// city or pulled from it by another city's request: the march leaves this city,
// so it is this city's policy and points
const PROC = require('./processing');
PROC.register('r', { kinds: ['transport'] });
PROC.register('t', { kinds: ['reinforceTroops'] });

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
// "transports", "scouts", "cavalry": a carrier name as a plural
const many = (w) => (/s$|cavalry$/i.test(w) ? w.toLowerCase() : `${w.toLowerCase()}s`);

// A carrier's hold, the way the client counts it (NewArmyWin.as:2853): its
// load x (1 + loadSkillParam/100). loadSkillParam is the account's Logistics
// bonus (+100 at Logistics 10, so a transport holds 10,000 and a cavalry 200).
// The client asks army.getTroopParam WITH the sending city's castleId each
// time its march window opens (NewArmyWin.as:1616); Game.troopParams asks the
// same way and keeps the answer per city, and that is read first. Then what
// the login read (Game.loadSkillParam, asked without a castleId). When neither
// is known, the base load — half the real hold at Logistics 10, which is how
// 100,000 transports ended up carrying 500m (2026-09-19); the transport
// executor then asks for the city's figure, so the next pass has it.
// The food a march carries for itself comes out of the same hold (sizeMarch).
const LOAD = C.BY_KEY.carriage.load;
const FOOD_CAP = 950e9;      // a city's food resets to 0 at 1t: never fill past this
const loadSkillOf = (game, castle) => {
  const cache = game && game._troopParams;
  if (castle && cache && typeof cache.get === 'function' && typeof game.castleId === 'function') {
    const hit = cache.get(game.castleId(castle));
    const v = Number(hit && hit.p && hit.p.loadSkill);
    if (Number.isFinite(v) && v > 0) return v;
  }
  const v = Number(game && game.loadSkillParam);
  return Number.isFinite(v) && v > 0 ? v : 0;
};
const loadOf = (key, skill = 0) => (C.BY_KEY[key] || C.BY_KEY.carriage).load * (1 + n(skill) / 100);
// Transports are shared with NPC farming, which rides on the same carriages:
// a transfer leaves a quarter of them home, never more than 2,000. Another
// carrier (troopType) is held back the same way. The wiki says nothing on
// this; holding some back only ever sends less.
const reserveOf = (carriages) => Math.min(2000, Math.ceil(carriages * 0.25));

// A march takes at most 10,000 troops per Rally Spot level of the SENDING
// city, every kind together, and never more than 100,000 ("Troops dispatch
// limit reached 100000"; rally.js marchTroopLimit): at L10, 100,000 transports
// carry 1b at Logistics 10 (500m at base load). A city with no Rally Spot in its list, or no list, gets the
// 100,000 and the server judges it (the rally book holds goal marches from a
// city with no Rally Spot anyway).
const limitOf = (castle) => R.marchTroopLimit(castle) || C.MARCH_TROOP_MAX;
// What one carrier of kind `k` really holds on a trip from `fromXY` to `toXY`
// in a march of `kinds` (plus k): its hold, load x (1 + loadSkill/100), less the
// food it carries for itself — twice its upkeep for every hour of the one-way
// march, at the speed of the march's slowest troop (NewArmyWin.as:2852-2853,
// :3102, :1719). 0 or less when the trip eats it all: scouts hold 10 at
// Logistics 10 and eat 10 an hour. The march skill is the account's; no Relief
// Station is counted, the slower reading, so the food is never under-counted.
// `from` is the sending castle, for its own Logistics reading (loadSkillOf).
function netHold(k, fromXY, toXY, kinds, game, from = null) {
  const all = [...new Set([...(kinds || []), k])];
  const ms = fromXY && toXY ? n(C.marchTimeMs(fromXY, toXY, all, n(game && game.marchSkillParam))) : 0;
  return loadOf(k, loadSkillOf(game, from)) - (C.BY_KEY[k] ? C.BY_KEY[k].food : 0) * 2 * ms / 3600000;
}

// Carriers of each kind a transport march takes for what it carries, at
// `netOf(kind)` a carrier.
const unitsOf = (carried, netOf) => Object.fromEntries(Object.entries(carried || {})
  .map(([k, v]) => { const per = netOf(k); return [k, per > 0 ? Math.ceil(n(v) / per) : 0]; }));

// What a march planned this pass from `castle` still has room for: resources
// on carrier `k` for a transport (m.carried is resources per carrier kind, and
// `netOf(kind)` what one carrier holds on this trip), troops for a
// reinforcement (m.load is troops per kind). No march yet has the whole limit.
function marchRoom(castle, m, k, netOf = (kk) => loadOf(kk)) {
  const limit = limitOf(castle);
  if (k) {
    const on = m ? Object.values(unitsOf(m.carried, netOf)).reduce((t, v) => t + v, 0) : 0;
    return Math.max(0, limit - on) * Math.max(0, netOf(k));
  }
  const on = m ? Object.values(m.load).reduce((t, v) => t + n(v), 0) : 0;
  return Math.max(0, limit - on);
}

// One transport march, sized the way the client checks it: the carriers' hold
// less the food the march carries for itself (netHold) must take the
// resources. The plan already loads each line at netHold for the march as it
// stood; this is the final count, with every troop of the march known. It only
// cuts a load when a slower carrier joined a march already loaded, since that
// slows the lot and every carrier then eats more on the way.
//   parts   what the lines loaded, [{res, carrier, amount}]
//   free    the carriers of each kind this march may take
//   limit   the troops one march may take (rally.js marchTroopLimit)
// Returns { troops, resources, trimmed }: what does not fit stays home.
function sizeMarch({ parts, free, limit, fromXY, toXY, game, from = null }) {
  const kinds = [...new Set(parts.filter((p) => p.amount > 0).map((p) => p.carrier))];
  const net = {}, sum = {}, units = {};
  for (const k of kinds) {
    net[k] = netHold(k, fromXY, toXY, kinds, game, from);
    sum[k] = parts.filter((p) => p.carrier === k).reduce((t, p) => t + p.amount, 0);
    units[k] = net[k] > 0 ? Math.min(Math.ceil(sum[k] / net[k]), Math.max(0, Math.floor(n(free[k])))) : 0;
  }
  const total = Object.values(units).reduce((t, v) => t + v, 0);
  if (total > limit) for (const k of kinds) units[k] = Math.floor(units[k] * limit / total);
  const troops = {}, resources = {};
  let trimmed = false;
  for (const k of kinds) {
    const hold = net[k] > 0 ? Math.floor(units[k] * net[k]) : 0;
    const scale = sum[k] > hold ? hold / sum[k] : 1;
    if (scale < 1) trimmed = true;
    let used = 0;
    const mine = parts.filter((x) => x.carrier === k);
    mine.forEach((p, i) => {
      // the last takes exactly the room left, so rounding loses nothing
      const v = i === mine.length - 1 ? Math.min(p.amount, hold - used) : Math.floor(p.amount * scale);
      if (v > 0) { resources[p.res] = n(resources[p.res]) + v; used += v; }
    });
    if (used > 0) troops[k] = Math.min(units[k], Math.ceil(used / net[k]));
  }
  return { troops, resources, trimmed };
}

// "12,000 transports" or "12,000 transports + 500 Scout"
const carriersText = (troops) => {
  const carriages = n(troops.carriage);
  return Object.keys(troops).length === 1 && carriages ? `${fmt(carriages)} transports`
    : Object.entries(troops).map(([k, v]) => `${fmt(v)} ${k === 'carriage' ? 'transports' : troopName(k)}`).join(' + ');
};

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

// A switch on a transfer line: /slots:3, /below=5m, /steps:1b,2b — or /50, the
// bare form of /maxdist:50. Returns [name, value] (value true when the switch
// is written alone), or null when the token is not a switch at all.
function switchTok(tok) {
  const s = String(tok);
  const d = s.match(/^\/(\d+(?:\.\d+)?)$/);
  if (d) return ['maxdist', d[1]];
  const m = s.match(/^\/([a-z]+)(?:[:=](.*))?$/i);
  return m ? [m[1].toLowerCase(), m[2] === undefined ? true : m[2]] : null;
}

// How far apart two places are on the map: the distance the notes print.
const distOf = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Infinity);
// "12.4 tiles", or a city the game has not placed yet
const tiles = (d) => (Number.isFinite(d) ? `${d.toFixed(1)} tiles` : 'an unknown distance');

// /maxdist:<tiles> (or the bare /50): how far this line may reach. A distance
// that cannot be read is an error and the line does not run — reading it as
// "no limit" is the one wrong guess that sends a march across the map.
function readDist(v, errs) {
  const d = v === true ? NaN : Number(v);
  if (!(d > 0)) {
    errs.push(`/maxdist needs a distance in tiles, more than 0 — e.g. /maxdist:50, or just /50`);
    return null;
  }
  return d;
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
    const m = switchTok(tok);
    if (m) {
      if (push) noteSwitch(sw, m[0], errs);
      sw[m[0]] = m[1];
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
    target: target || null, local: null, remote: null, minBatch: null, maxBatch: null, slots: 1, maxDist: null,
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
    } else if (k === 'maxdist') {
      // OTTObot's: never reach farther than this many tiles, either way round
      out.maxDist = readDist(v, errs);
    } else if (k === 'below' && !push) {
      // OTTObot's: start asking only under this. * is "doesn't matter".
      if (v === '*') out.below = null;
      else if (v === true || NUM(v) === null) errs.push(`/below needs an amount (${AMOUNT_HELP}), e.g. /below:5m`);
      else out.below = NUM(v);
    } else if (k === 'steps' && !push && !troops) {
      // OTTObot's: even the account out level by level, the poorest first
      const parts = v === true ? [] : String(v).split(',').map((s) => s.trim());
      const vals = parts.map((s) => (s === '*' ? null : NUM(s)));
      if (!parts.length || parts.some((s) => !s) || vals.some((x) => x === null || !(x > 0))) {
        errs.push(`/steps needs amounts joined by commas (5m, 200k, 1b — not *), e.g. /steps:1000b,10000b`);
      } else if (vals.some((x, i) => i > 0 && x <= vals[i - 1])) {
        errs.push('/steps must go up: each step more than the one before');
      } else {
        out.steps = vals;
      }
    } else {
      errs.push(`unknown switch /${k} — ${push ? '/slots:N or /maxdist:<tiles>' : troops ? '/slots:N, /below:<amount> or /maxdist:<tiles>' : '/slots:N, /below:<amount>, /maxdist:<tiles> or /steps:<amount>,<amount>'}`);
    }
  }
  if (out.steps) {
    // the last level is localAmount, where the line fills to
    if (out.local == null) errs.push('/steps needs a localAmount: the steps lead up to it, the last level');
    else if (out.steps[out.steps.length - 1] >= out.local) errs.push(`/steps must all be under localAmount ${short(out.local)}, the last level`);
    if (out.below !== undefined) errs.push('/steps and /below together: the steps already say when the city asks — use one of them');
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
    const m = switchTok(tok);
    if (m) {
      noteSwitch(sw, m[0], errs);
      sw[m[0]] = m[1];
      continue;
    }
    rest.push(String(tok));
  }
  const usage = troops
    ? 'expected: keeptroops <to> <troop:amount[,troop:amount]> [minBatch] [/slots:N]'
    : 'expected: keepresources <to> <res:amount[,res:amount]> [minBatch] [troopType] [/slots:N]';
  const [target, list, ...tail] = rest;
  const out = { target: target || null, keep: {}, minBatch: null, slots: 1, maxDist: null, ...(troops ? {} : { carrier: 'carriage' }) };
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
    } else if (k === 'maxdist') {
      out.maxDist = readDist(v, errs);
    } else {
      errs.push(`unknown switch /${k} — /slots:N or /maxdist:<tiles>`);
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
  if (g.steps) {
    bits.push(`in steps, the poorest city first: ${[...g.steps, g.local].map(amt).join(', then ')}`
      + ' — at each level cities under it take from cities over it, never below it,'
      + ' and a level waits while a city is still under a lower one that another city can fill;'
      + ' the richest free city sends');
  }
  bits.push(`senders keep ${amt(g.remote)}${g.steps ? ' at the last level' : ''}`);
  const lowNote = g.local != null ? ` (less once under half of ${amt(g.local)})` : '';
  if (g.minBatch == null && g.maxBatch == null) bits.push('any batch size, up to what one march carries');
  else if (g.minBatch == null) bits.push(`at most ${amt(g.maxBatch)} per send`);
  else if (g.maxBatch == null) bits.push(`at least ${amt(g.minBatch)} per send, up to what one march carries${lowNote}`);
  else bits.push(`${amt(g.minBatch)} to ${amt(g.maxBatch)} per send${lowNote}`);
  if (g.carrier && g.carrier !== 'carriage') bits.push(`carried by ${troopName(g.carrier)}`);
  if (g.maxDist != null) bits.push(`only from cities within ${g.maxDist} tiles`);
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
  if (g.maxDist != null) bits.push(`only to cities within ${g.maxDist} tiles`);
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
  // what one carrier of kind k holds from sender s to here, in the march s has
  // planned so far (netHold: its hold less its own march food)
  const netFrom = (s, k) => netHold(k, game.castleXY(s.castle), hereXY, Object.keys(s.march.r ? s.march.r.carried : {}), game, s.castle);
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
      castle: c, dist: distOf(xy, hereXY),
      stock, troops, troops0: { ...troops }, goals: goalsOf(c) || [], march: { r: null, t: null },
    };
    senders.set(cid, s);
    return s;
  };
  const plannedFrom = (s) => (s.march.r ? 1 : 0) + (s.march.t ? 1 : 0);

  // The level at which a sender's own line for the same thing would start
  // asking for more: its /below, else its localAmount (* = none). Taking it
  // under that would only have it ask for the lot back. A /steps line is left
  // out: at each level it takes only from cities over that level and never
  // takes them under it, so nothing it moves can come back (a stepped line
  // counted here would keep every city under its top level from sending).
  const floorOf = (goals, goal, key, keyOf) => Math.max(0, ...goalsNamed(goals, goal)
    .filter((g) => keyOf(g) === key && !g.steps).map(triggerOf).filter((v) => v != null));
  const ownFloor = (s, goal, key, keyOf) => floorOf(s.goals, goal, key, keyOf);

  // ---- /steps: which level a stepped line works at this pass, the same for
  // every city that has the line. The lowest level L at which some city with
  // the line is short (under L by a minimum batch, or at half of L or less) and
  // some other city holds more than L, over its own floor, by a minimum batch.
  // Nobody short anywhere: null (every city is at the top). Short cities but no
  // city over the level to fill them: { level: null } — then no city is over
  // any higher level either, so nothing can move.
  const linesAt = (c) => (game.castleId(c) === hereId ? ctx.goals : goalsOf(c)) || [];
  const comingAt = new Map();
  const haveAt = (c, k) => {
    const id = game.castleId(c);
    if (!comingAt.has(id)) comingAt.set(id, resourcesComing(c, book));
    return resOf(c, k) + n(comingAt.get(id)[k]);
  };
  const stockAt = (c, k) => Math.max(0, resOf(c, k) - n(book.committed(c).resources[k]));
  const ladderOf = (g) => [...g.steps, g.local];
  const stepCache = new Map();
  function stepFor(g, k) {
    const ladder = ladderOf(g), sig = `${k}:${ladder.join(',')}`;
    if (stepCache.has(sig)) return stepCache.get(sig);
    const min = Math.max(1, n(g.minBatch));
    const all = game.castles || [];
    const askers = all.filter((c) => goalsNamed(linesAt(c), 'requestresources')
      .some((x) => x.ok !== false && x.type === k && x.steps && ladderOf(x).join(',') === ladder.join(',')));
    let out = null;
    for (const L of ladder) {
      const low = askers.map((c) => ({ c, have: haveAt(c, k) }))
        .filter(({ have }) => have < L && (L - have >= min || have <= L / 2))
        .sort((a, b) => a.have - b.have)[0];
      if (!low) continue;
      const donor = all.some((c) => c !== low.c && !warTownOf(c)
        // /maxdist: a city too far to reach the short one is no donor for it
        && (g.maxDist == null || distOf(game.castleXY(c), game.castleXY(low.c)) <= g.maxDist)
        && stockAt(c, k) - Math.max(L, floorOf(linesAt(c), 'requestresources', k, (x) => x.type)) >= min);
      out = { level: donor ? L : null, at: L, top: L === g.local, short: low.c.name, shortHave: low.have };
      break;
    }
    stepCache.set(sig, out);
    return out;
  }
  // The levels a line works at this pass: { local, remote, below }. A stepped
  // line works at its step (null: nothing to do this pass, `why` says why).
  function levelsFor(g, key, have, spec) {
    if (!g.steps || spec.kind !== 'r') return { local: g.local, remote: g.remote, below: g.below };
    const st = stepFor(g, key);
    if (!st) return { why: null };                                   // everyone at the top
    if (st.level == null) {
      return { why: have < g.local ? `nothing to even out — ${st.short} holds ${short(st.shortHave)}, and no city holds over ${short(st.at)} to give` : null };
    }
    if (have >= st.level) {
      return { why: have < g.local ? `waiting — the ${short(st.level)} step first (${st.short} holds ${short(st.shortHave)})` : null };
    }
    return { local: st.level, remote: st.top ? g.remote : st.level, below: undefined, step: st.level };
  }

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
      // the levels this pass: the line's own, or its step (/steps)
      const lv = levelsFor(g, key, have, spec);
      const headOf = (to) => `${spec.name(key)} ${short(home)}${coming ? ` + ${short(coming)} coming` : ''}${to != null ? ` < ${short(to)}` : ''}`;
      if (lv.why !== undefined) { if (lv.why) lines.push(`${headOf(g.local)}: ${lv.why}`); continue; }
      // wiki: "You must have BELOW this amount in order to have a request sent"
      if (lv.local != null && have >= lv.local) continue;
      if (lv.below != null && have >= lv.below) continue;        // /below: not yet
      // never past localAmount, and no more than maxBatch at a time. No maxBatch
      // (*), or one bigger than a march takes, is one full march: `carry` below.
      let want = Math.floor(Math.min(lv.local == null ? Infinity : lv.local - have, g.maxBatch == null ? Infinity : g.maxBatch));
      // Food never past 950b in a city, counting what is on its way: it resets
      // to 0 at 1t (EVONY-RULES.md §3). Whatever a line says.
      if (spec.kind === 'r' && key === 'food' && want > FOOD_CAP - have) {
        want = Math.floor(FOOD_CAP - have);
        if (!(want > 0)) { lines.push(`${headOf(lv.local)}: held — food never goes past ${short(FOOD_CAP)} in a city (it resets to 0 at 1t)`); continue; }
      }
      if (!(want > 0)) continue;
      // wiki: 50% or less of what the city should hold is critically low, and
      // then the minimum batch no longer holds a smaller send back
      const critical = lv.local != null && have <= lv.local / 2;
      const minBatch = g.minBatch != null && !critical ? g.minBatch : 0;
      const trigger = lv.below !== undefined ? lv.below : lv.local;
      const head = `${headOf(trigger)}${lv.step != null && lv.step !== g.local ? ` (step ${short(lv.step)} of ${short(g.local)})` : ''}`
        + `${critical && g.minBatch != null ? ' (critically low)' : ''}`;
      // wiki: a minimum batch that would put this city over localAmount waits
      if (minBatch > want) {
        const fillTo = Math.min(lv.local == null ? Infinity : lv.local, spec.kind === 'r' && key === 'food' ? FOOD_CAP : Infinity);
        lines.push(`${head}: waiting — only ${short(want)} fits under ${short(fillTo)}, the minimum batch is ${short(minBatch)}`);
        continue;
      }

      const cands = [], why = [];
      const pool = sendersFor(g.target, others, game);
      for (const c of pool) {
        const war = warTownOf(c);
        if (war) { why.push(`${c.name} is a war town (${war})`); continue; }
        // the sender's own processingpolicy: sendresources (r) / sendtroops (t)
        const pp = PROC.allowed({ goals: goalsOf(c) || [], game }, spec.kind);
        if (!pp.on) { why.push(`${c.name}: ${pp.why}`); continue; }
        const s = senderOf(c);
        // /maxdist: a city farther than the line allows never sends
        if (g.maxDist != null && !(s.dist <= g.maxDist)) {
          why.push(`${c.name} is ${tiles(s.dist)} away, past this line's /maxdist:${g.maxDist}`);
          continue;
        }
        let busy = 0;
        if (!s.march[spec.kind]) {
          // a new march: needs a free pair and a free rally slot at the sender.
          // A sender still busy with this city stays in the running — if it is
          // the one to send, the line waits for it rather than calling on a
          // city farther away.
          busy = book.between(c, here.fieldId, spec.mission) >= g.slots ? g.slots : 0;
          // a stepped line doesn't wait: the next richest city sends instead
          if (busy && lv.step != null) { why.push(`${c.name}'s last mission here is not back yet`); continue; }
          const r = busy ? null : book.room(c, spec.kind, { planned: { total: plannedFrom(s) } });
          if (r && r.room <= 0) { why.push(`${c.name} ${r.why}`); continue; }
        }
        // wiki: "The bot will not put the sending city below the remote amount"
        const floor = Math.max(lv.remote == null ? 0 : lv.remote, ownFloor(s, spec.goal, key, spec.keyOf));
        const spare = Math.floor(spec.stock(s, key) - floor);
        if (spare <= 0) { why.push(`${c.name} holds ${short(spec.stock(s, key))}, keeps ${short(floor)}`); continue; }
        const carry = spec.carry(s, g);
        if (carry <= 0) {
          const k = spec.kind === 'r' ? (g.carrier || 'carriage') : null;
          const starved = k && netFrom(s, k) <= 0;
          const full = !starved && s.march[spec.kind] && marchRoom(c, s.march[spec.kind], k, (kk) => netFrom(s, kk)) <= 0;
          why.push(starved ? `${c.name} is too far for ${many(spec.carrierName(g))} to carry anything: they would eat it all on the way (${s.dist.toFixed(1)} tiles)`
            : full ? `${c.name}'s march here is full (${fmt(limitOf(c))} troops, its Rally Spot's limit)` : `${c.name} has no spare ${spec.carrierName(g)}`);
          continue;
        }
        const deliver = Math.min(want, spare, carry);
        // wiki: a minimum batch that would put the sender under remoteAmount waits
        if (deliver < minBatch) {
          why.push(`${c.name} can send ${short(deliver)}, under the ${short(minBatch)} minimum batch`);
          continue;
        }
        // Lowest first (the user, 2026-09-18): a sender leaves this for another of
        // our cities that holds LESS of it, is asking for it, and that it could
        // send to right now. A sender that can't serve the needier city (a mission
        // to it still out, too far, nothing over that line's floor) doesn't wait.
        const nd = spec.needier ? spec.needier(s, key, have) : null;
        if (nd) { why.push(`${c.name} leaves its ${spec.name(key)} for ${nd.name}, which holds less (${short(nd.have)})`); continue; }
        cands.push({ s, busy, deliver, stock: spec.stock(s, key), spare });
      }
      // the nearest that can send it all; failing that, whoever can send most.
      // A stepped line takes from the richest (the user, 2026-09-19): evening
      // out, the city with the most gives first — the richest of those that
      // can send it all, else of those that can send within 10% of the most
      // any can (a march's own food differs a little with the distance).
      let full, best;
      if (lv.step != null) {
        const most = Math.max(0, ...cands.map((x) => x.deliver));
        const able = cands.filter((x) => x.deliver >= want);
        full = able.length ? able[0] : null;
        best = (able.length ? able : cands.filter((x) => x.deliver >= most * 0.9))
          .sort((a, b) => b.stock - a.stock || a.s.dist - b.s.dist)[0];
      } else {
        full = cands.filter((x) => x.deliver >= want).sort((a, b) => a.s.dist - b.s.dist)[0];
        best = full || cands.sort((a, b) => b.deliver - a.deliver || a.s.dist - b.s.dist)[0];
      }
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
      const m = (s.march[spec.kind] = s.march[spec.kind] || { load: {}, carried: {}, parts: [], slots: g.slots });
      m.load[key] = n(m.load[key]) + best.deliver;
      if (spec.carrierOf) {
        const ck = spec.carrierOf(g);
        m.carried[ck] = n(m.carried[ck]) + best.deliver;
        m.parts.push({ res: key, carrier: ck, amount: best.deliver });
      }
      spec.take(s, key, best.deliver);
      planned[key] = n(planned[key]) + best.deliver;
      const why2 = best.deliver >= want ? '' : best.deliver >= best.spare ? ', all it can spare' : ', what one march carries';
      lines.push(`${head}: ${short(best.deliver)} from ${s.castle.name} (${s.dist.toFixed(1)} tiles${why2})`);
    }
    return lines;
  }

  const notes = [];

  if (resRules.length) {
    const coming = resourcesComing(here, book);
    // Stepped lines go poorest first ACROSS resources too (2026-09-19): each
    // sender makes one trip to this city at a time, so the line served first
    // takes every sender that comes free, and in line order gold (first, and in
    // trillions) left iron (last) nothing. So the lowest step goes first, then
    // the emptiest (what the city holds / its step); lines without /steps keep
    // their place, ahead of them.
    const rankOf = (g) => {
      if (!g.steps || g.ok === false) return null;
      const st = stepFor(g, g.type);
      if (!st || st.level == null) return [Infinity, 1];
      return [ladderOf(g).indexOf(st.level), (resOf(here, g.type) + n(coming[g.type])) / st.level];
    };
    const ranked = resRules.map((g, i) => ({ g, i, r: rankOf(g) }));
    const ordered = [...ranked.filter((x) => !x.r), ...ranked.filter((x) => x.r)
      .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.i - b.i)].map((x) => x.g);
    const lines = serve(ordered, {
      goal: 'requestresources', kind: 'r', mission: C.MISSION.transport,
      keyOf: (g) => g.type, name: (k) => k,
      have: (k) => resOf(here, k),
      coming: (k) => n(coming[k]),
      stock: (s, k) => s.stock[k],
      take: (s, k, v) => { s.stock[k] -= v; },
      // another city of ours needier than this one, for this sender (see serve)
      needier: (s, k, haveHere) => {
        if (!ctx.goalsOf) return null;
        const sXY = game.castleXY(s.castle);
        // a stepped line asks at its step this pass, and its senders keep that step
        const levels = (g) => {
          if (!g.steps) return { trig: triggerOf(g), remote: g.remote };
          const st = stepFor(g, k);
          return st && st.level != null ? { trig: st.level, remote: st.top ? g.remote : st.level } : { trig: null };
        };
        for (const o of others) {
          if (o === s.castle) continue;
          const oHave = haveAt(o, k);
          if (!(oHave < haveHere)) continue;
          const lines = goalsNamed(goalsOf(o) || [], 'requestresources').filter((g) => g.type === k && g.ok !== false
            && levels(g).trig != null && oHave < levels(g).trig && sendersFor(g.target, [s.castle], game).length);
          if (!lines.length) continue;
          const ok = lines.some((g) => {
            if (book.between(s.castle, o.fieldId, C.MISSION.transport) >= (g.slots || 1)) return false;
            // its line would not reach this sender either, so nothing is left for it
            if (g.maxDist != null && !(distOf(sXY, game.castleXY(o)) <= g.maxDist)) return false;
            if (netHold(g.carrier || 'carriage', sXY, game.castleXY(o), [], game, s.castle) <= 0) return false;
            const r = levels(g).remote;
            const floor = Math.max(r == null ? 0 : r, ownFloor(s, 'requestresources', k, (x) => x.type));
            return s.stock[k] - floor > 0;
          });
          if (ok) return { name: o.name, have: oHave };
        }
        return null;
      },
      // transports unless the line names another troopType
      carrierOf: (g) => g.carrier || 'carriage',
      carrierName: (g) => (!g.carrier || g.carrier === 'carriage' ? 'transports' : troopName(g.carrier)),
      // what the sender's spare carriers of this line's kind still hold on the
      // trip here, their own march food taken off, after what this pass has
      // loaded on them already
      carry: (s, g) => {
        const k = g.carrier || 'carriage';
        const net = netFrom(s, k);
        if (net <= 0) return 0;
        const have = n(s.troops[k]);
        const loaded = s.march.r ? n(s.march.r.carried[k]) : 0;
        return Math.min((have - reserveOf(have)) * net - loaded, marchRoom(s.castle, s.march.r, k, (kk) => netFrom(s, kk)));
      },
    });
    notes.push(`requestresources: ${lines.length ? lines.join('; ') : 'nothing short'}`);
  }
  // carriers that go with this pass's resources are not there to be requested
  for (const s of senders.values()) {
    if (!s.march.r) continue;
    for (const [k, units] of Object.entries(unitsOf(s.march.r.carried, (kk) => netFrom(s, kk)))) {
      s.troops[k] = Math.max(0, n(s.troops[k]) - units);
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
      carry: (s) => marchRoom(s.castle, s.march.t),
    });
    notes.push(`requesttroops:${lines.length ? lines.join('; ') : 'nothing short'}`);
  }

  const actions = [];
  for (const s of [...senders.values()].sort((a, b) => a.dist - b.dist)) {
    const dist = s.dist.toFixed(1);
    if (s.march.r) {
      // the carriers the plan loaded, and any spare left once the pass is done
      // (a quarter still stays home), for the march's own food
      const free = {};
      for (const [k, units] of Object.entries(unitsOf(s.march.r.carried, (kk) => netFrom(s, kk)))) {
        free[k] = units + Math.max(0, n(s.troops[k]) - reserveOf(n(s.troops0[k])));
      }
      const sized = sizeMarch({ parts: s.march.r.parts, free, limit: limitOf(s.castle), fromXY: game.castleXY(s.castle), toXY: hereXY, game, from: s.castle });
      const { troops, resources } = sized;
      if (!Object.keys(resources).length) {
        notes.push(`${s.castle.name}: nothing left to carry once the march's own food is on board (${dist} tiles)`);
      } else {
        // the hold was counted at base load: say so, it halves what a march takes
        if (!loadSkillOf(game, s.castle)) {
          notes.push(`${s.castle.name}: its Logistics bonus isn't read yet — carriers counted at their base load (a transport ${fmt(LOAD)}), so this march takes less than it could; the send asks the server for it`);
        }
        if (sized.trimmed) {
          notes.push(`${s.castle.name}: cut to ${Object.entries(resources).map(([k, v]) => `${short(v)} ${k}`).join(' + ')}, what ${carriersText(troops)} hold with the march's own food on board`);
        }
        const carriages = n(troops.carriage);
        const carriers = carriersText(troops);
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
  const dist = (xy) => distOf(xy, hereXY);
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
      maxDist: g.maxDist,
    }));
  }
  return [{ g, key: PUSH_GOALS[g.name] === 't' ? g.troop : g.type, local: g.local, remote: g.remote,
    minBatch: g.minBatch, maxBatch: g.maxBatch, carrier: g.carrier, slots: g.slots, maxDist: g.maxDist }];
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
  const home0 = { ...home };
  const hereXY = game.castleXY(here);
  const xyOf = (recv) => (recv.castle ? game.castleXY(recv.castle) : C.fieldIdToCoords(recv.fieldId));
  // what one carrier of kind k holds on the trip to recv, in the march planned
  // there so far (netHold: its hold less its own march food)
  const netTo = (recv, m, k) => netHold(k, hereXY, xyOf(recv), Object.keys(m ? m.carried : {}), game, here);
  // carriers of kind k the transports planned so far take, to every receiver
  const unitsUsed = (k) => [...marches.values()]
    .reduce((t, x) => t + (x.r ? n(unitsOf(x.r.carried, (kk) => netTo(x.recv, x.r, kk))[k]) : 0), 0);

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
        // /maxdist: a receiver farther than the line allows is passed over
        if (item.maxDist != null && !(recv.dist <= item.maxDist)) {
          why.push(`${recv.name} is ${tiles(recv.dist)} away, past this line's /maxdist:${item.maxDist}`);
          continue;
        }
        // Another account's city: what it holds cannot be read, so a line that
        // must not fill it past remoteAmount cannot send there.
        if (recv.foreign && item.remote != null) {
          why.push(`${recv.name} is not one of this account's cities, so what it holds can't be read — write * as remoteAmount to send there regardless`);
          continue;
        }
        let cap = item.remote == null ? Infinity : item.remote;
        if (recv.byAny) cap = Math.min(cap, receiverCeiling(goalsOf(recv.castle), key, spec.kind === 't'));
        // food never past 950b in a city of ours (it resets to 0 at 1t), whatever the line says
        if (res && key === 'food' && !recv.foreign) cap = Math.min(cap, FOOD_CAP);
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
        const carry = spec.carry(item, m && m[spec.kind], recv);
        if (carry <= 0) {
          const k = spec.kind === 'r' ? (item.carrier || 'carriage') : null;
          // too far for this carrier to feed itself and carry anything: a nearer receiver may still get some
          if (k && netTo(recv, m && m.r, k) <= 0) {
            why.push(`${recv.name} is too far for ${many(spec.carrierName(item))} to carry anything: they would eat it all on the way (${recv.dist.toFixed(1)} tiles)`);
            continue;
          }
          // a march this pass has filled: the next receiver gets its own
          if (m && m[spec.kind] && marchRoom(here, m[spec.kind], k, (kk) => netTo(recv, m[spec.kind], kk)) <= 0) {
            why.push(`${recv.name}: the march there is full (${fmt(limitOf(here))} troops, this city's Rally Spot limit)`);
            continue;
          }
          why.push(`no spare ${spec.carrierName(item)}`);
          break;
        }
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
        if (!m[spec.kind]) { m[spec.kind] = { load: {}, carried: {}, parts: [], slots: item.slots }; planned[spec.kind]++; }
        m[spec.kind].load[key] = n(m[spec.kind].load[key]) + deliver;
        if (spec.carrierOf) {
          const ck = spec.carrierOf(item);
          m[spec.kind].carried[ck] = n(m[spec.kind].carried[ck]) + deliver;
          m[spec.kind].parts.push({ res: key, carrier: ck, amount: deliver });
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

  // processingpolicy: sendresources (r) and sendtroops (t) off here send nothing
  const offer = { r: PROC.allowed(ctx.game ? ctx : { ...ctx, game }, 'r'), t: PROC.allowed(ctx.game ? ctx : { ...ctx, game }, 't') };
  for (const [nm, lines] of byName('r')) {
    if (!offer.r.on) { notes.push(`${nm}: held — ${offer.r.why}`); continue; }
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
      // what the spare carriers of this line's kind hold on the trip to recv,
      // their own march food taken off: the carriers no march has taken yet,
      // and the room left in the part-filled last one of this march
      carry: (item, m, recv) => {
        const k = item.carrier || 'carriage';
        const net = netTo(recv, m, k);
        if (net <= 0) return 0;
        const have = n(home[k]);
        const free = Math.max(0, have - reserveOf(have) - unitsUsed(k));
        const slack = m ? n(unitsOf(m.carried, (kk) => netTo(recv, m, kk))[k]) * net - n(m.carried[k]) : 0;
        return Math.min(free * net + Math.max(0, slack), marchRoom(here, m, k, (kk) => netTo(recv, m, kk)));
      },
    });
    notes.push(`${nm}: ${said.length ? said.join('; ') : 'nothing over what this city keeps'}`);
  }
  // carriers that go with this pass's resources are not there to be sent
  for (const k of Object.keys(loaded)) home[k] = Math.max(0, n(home[k]) - unitsUsed(k));

  for (const [nm, lines] of byName('t')) {
    if (!offer.t.on) { notes.push(`${nm}: held — ${offer.t.why}`); continue; }
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
      carry: (item, m) => marchRoom(here, m),
    });
    notes.push(`${nm}:${said.length ? said.join('; ') : 'nothing over what this city keeps'}`);
  }

  const actions = [];
  // carriers still free once every line has loaded (a quarter stays home),
  // shared by the marches for the food each carries for itself
  const pool = {};
  for (const k of Object.keys(loaded)) pool[k] = Math.max(0, n(home[k]) - reserveOf(n(home0[k])));
  for (const { recv, r, t } of [...marches.values()].sort((a, b) => a.recv.dist - b.recv.dist)) {
    const to = recv.castle || { fieldId: recv.fieldId, name: recv.name };
    const dist = recv.dist.toFixed(1);
    if (r) {
      const free = {};
      const plannedUnits = unitsOf(r.carried, (kk) => netTo(recv, r, kk));
      for (const k of Object.keys(r.carried)) free[k] = n(plannedUnits[k]) + n(pool[k]);
      const sized = sizeMarch({ parts: r.parts, free, limit: limitOf(here), fromXY: hereXY, toXY: xyOf(recv), game, from: here });
      const { troops, resources } = sized;
      for (const [k, v] of Object.entries(troops)) pool[k] = Math.max(0, n(pool[k]) - Math.max(0, v - n(plannedUnits[k])));
      if (!Object.keys(resources).length) {
        notes.push(`${recv.name}: nothing left to carry once the march's own food is on board (${dist} tiles)`);
      } else {
        if (sized.trimmed) {
          notes.push(`${recv.name}: cut to ${Object.entries(resources).map(([k, v]) => `${short2(v)} ${k}`).join(' + ')}, what ${carriersText(troops)} hold with the march's own food on board`);
        }
        const carriages = n(troops.carriage);
        const carriers = carriersText(troops);
        actions.push({
          kind: 'transport', from: here, to, resources, carriages, troops, distance: recv.dist, foreign: recv.foreign,
          rally: {
            from: here, kind: 'r', missionType: C.MISSION.transport, targetFieldId: recv.fieldId,
            pairLimit: r.slots, resources, troops,
          },
          label: `send ${Object.entries(resources).map(([k, v]) => `${fmt(v)} ${k}`).join(' + ')} to ${recv.name} (${dist} tiles, ${carriers})`,
        });
      }
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
    // The plan had no Logistics figure for this city (loadSkillOf) and counted
    // base loads. Ask for it the way the client does, with the castleId
    // (Game.troopParams keeps it per city), so the next pass loads full
    // marches. This march goes as planned: it fits either way.
    if (a.from && !loadSkillOf(game, a.from) && typeof game.troopParams === 'function') {
      try { await game.troopParams(game.castleId(a.from)); } catch { /* the next send asks again */ }
    }
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
    resourcesComing, troopsHeld, reserveOf, triggerOf, LOAD, short, sizeMarch, loadOf, loadSkillOf, netHold, FOOD_CAP },
};
