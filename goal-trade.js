'use strict';
// config trade / tradepolicy / resourcelimits — buy and sell on the market to
// keep a city's resources where its goals say (wiki: Trade, TradePolicy,
// ResourceLimits).
//
//   config trade:1
//   tradepolicy /type:<res> /min:<amount|Nd> /max:<amount|Nd> /batch:<amount> [/allowselltomin] [/donotautosellabovemax]
//   resourcelimits <food> <lumber> <stone> <iron>
//
// What each setting means (wiki TradePolicy):
//   /min    buy up to this. `Nd` = N days: of troop food upkeep for food, of
//           hero salary for gold (gold and food minimums, food maximums only).
//   /max    sell what is over this. Gold has no /max.
//   /batch  the smallest lot worth trading: wait until a trade this big fits
//           (100k when not given; the wiki has no default). One order is
//           never more than 99,999,999 (the client's amount box, NEAT's
//           -maxtrade default).
//   /allowselltomin      with nothing over /max to sell and no gold to spare,
//           sell other resources down to THEIR /min to buy this one (the
//           switch sits on the line of the resource that is short; the wiki's
//           example puts it on wood and iron, the ones usually short).
//   /donotautosellabovemax   while EVERY resource is at /max, keep what is
//           over it rather than selling it for gold. It still sells when some
//           other resource is under its /max.
// Gold's /min is the floor: no bid ever takes the city's gold under it.
//
// The stages, in the wiki's order, each pass:
//   emergency  gold under a day of hero salary, or food under 30 minutes of
//              upkeep: every /min and /batch is ignored, resources are sold
//              for the gold (and gold spent on the food) to get out of it.
//   1          gold under its /min: sell what is over /max for gold.
//   2          a resource under its /min: spend the gold over the floor on it;
//              failing that sell what others hold over /max; failing both,
//              with /allowselltomin, sell others down to their /min.
//   3          nothing under /min: sell what is over /max, and with what that
//              brings in buy the resources still under /max, in proportion to
//              how far under they are. Gold over the floor is NOT spent here —
//              the wiki spends it only on what is under /min — and when every
//              resource is at /max the gold is hoarded.
// A resource with no line keeps the built-in values (wiki: "you cannot turn
// off trading for a particular resource"): food up to a day of upkeep and at
// most 990b, wood/stone/iron 20m up to 7.2 trillion; gold's floor is a day of
// hero salary. A floor in days is never less than 100k. The wiki gives the
// food and wood/stone/iron maximums and the 20m ("I believe"); the day of
// food, the day of salary (NEAT's own emergency line, so no bid ever makes
// one) and the 100k are this bot's choice. resourcelimits sets each of the
// four to min = max = its amount and gold's floor to a day of salary ("a very
// low internal gold TradePolicy"); tradepolicy lines after it change the
// switches they name for their resource, later lines winning.
// Prices come from the book as it stands; an order is never guessed at a
// price nobody offers.
//
// How an order is placed — facts learned live (holiday-snipe.js):
//   * a bid is charged at the BID price plus 0.5%, not the seller's ask, and a
//     cancel refunds the order but keeps the 0.5% fee. So buys and sells only
//     ever take what the book already offers, one order per price level at
//     that level's own price (never one order at the dearest level), within
//     10% of the best price and never at more than twice the other side's
//     best (a thin or broken book is left alone). Orders are rounded the safe
//     way to fit the 5-character price box.
//   * a Marketplace holds a limited number of open offers (10 at level 10;
//     one more is refused with -38 and says how many are allowed).
//   * market writes are paced 1.2 s apart, and each write that gets no answer
//     doubles the gap (at most a minute) and holds the city's trading for a
//     while, as the buy/sell script lines do.
// What rests on the book because someone took the level first is ours; it is
// counted as coming (a buy) or gone (a sell) and cancelled after 20 minutes
// (its fee is lost, and the note says so). Nothing else is ever cancelled.
// Purchases in transit and our own transports heading to the city count as
// coming too, so a city that also requests resources never buys what a
// transport is bringing.
//
// holidaysnipe (holiday-snipe.js) runs on the same market: while it is buying
// a dump of a resource nobody trades that resource here, a city with its buy
// orders open is left alone, and a resource it keeps a sell offer listed for
// in a city is not sold there.
const C = require('./constants');
const R = require('./rally');
const HS = require('./holiday-snipe');

const RESOURCES = ['food', 'wood', 'stone', 'iron'];
const RES_BY_TYPE = { 0: 'food', 1: 'wood', 2: 'stone', 3: 'iron' };
const BUY = C.TRADE_TYPE.buy, SELL = C.TRADE_TYPE.sell;
const TYPE = { buy: BUY, sell: SELL };
const FEE = C.TRADE_COMMISSION;          // 0.5%, in gold, when an order is placed (NewTradeWin.calcCommission)
const MAX_ORDER = 99999999;              // NewTradeWin's 8-digit amount box; NEAT's -maxtrade default
const MARKETPLACE = 23;                  // constants.js BUILDINGS
const MAX_OFFERS = 10;                   // at a level 10 Marketplace

const WRITE_GAP_MS = 1200;               // between market writes (script.js buy/sell)
const MAX_GAP_MS = 60000;
const STALE_MS = 20 * 60e3;              // one of our offers resting this long is cancelled
const PENDING_MS = 5 * 60e3;             // a placed order whose push has not come yet is looked for this long
const BOOK_TTL_MS = 5 * 60e3;            // prices older than this are read again before a plan leans on them
const PROCEEDS_MS = 60 * 60e3;           // gold from selling what was over /max, spent on what is under it
const PRICE_BAND = 0.10;                 // walk the book at most 10% past its best price
const EMERGENCY_BAND = 0.5;
const SPREAD = 2;                        // never buy over 2x the best bid, never sell under half the best ask
const EMERGENCY_SPREAD = 4;
const OWN_RESTING_MAX = 2;               // our own offers on the book at once, per city
const TRADES_PER_PASS = 2;
const ORDERS_PER_TRADE = 2;              // price levels one buy or sell walks
const CANCELS_PER_PASS = 2;
const DEFAULT_BATCH = 100000;
const GOLD_FLOOR_ATLEAST = 100000;

const n = (x) => Number(x || 0);
const fmt = (x) => Math.round(n(x)).toLocaleString('en-US');
// 19950000 -> "19.95m", 7.2e12 -> "7.2t"
const short = (x) => {
  const v = n(x), a = Math.abs(v);
  if (!Number.isFinite(v)) return 'no limit';
  const cut = (d, s) => `${+(v / d).toFixed(2)}${s}`;
  return a >= 1e12 ? cut(1e12, 't') : a >= 1e9 ? cut(1e9, 'b') : a >= 1e6 ? cut(1e6, 'm') : a >= 1e3 ? cut(1e3, 'k') : fmt(v);
};
const px = (p) => String(+Number(p).toFixed(3));

// The goals number grammar (5k, 1.5m, 1b). "d" is days here, so it is not read
// as a number suffix.
const NUM = (s) => {
  const m = String(s == null ? '' : s).trim().match(/^([\d.]+)\s*([kmb])?$/i);
  if (!m) return null;
  const v = parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1);
  return Number.isFinite(v) ? Math.round(v) : null;
};
// "2d" -> { days: 2 }, "20m" -> 20000000, anything else null
const amountOrDays = (s) => {
  const d = String(s == null ? '' : s).trim().match(/^(\d+(?:\.\d+)?)d$/i);
  return d ? { days: parseFloat(d[1]) } : NUM(s);
};
const daysText = (v) => (v && typeof v === 'object' ? `${v.days}d` : short(v));

// ------------------------------------------------------------------- parsers

function parseTradePolicy(args) {
  const errs = [], sw = {};
  for (const tok of args) {
    const m = String(tok).match(/^\/([a-z]+)(?:[:=](.*))?$/i);
    if (!m) { errs.push(`expected /switch:value, got "${tok}"`); continue; }
    sw[m[1].toLowerCase()] = m[2] === undefined ? true : m[2];
  }
  const known = ['type', 'min', 'max', 'batch', 'allowselltomin', 'donotautosellabovemax'];
  for (const k of Object.keys(sw)) {
    if (!known.includes(k)) errs.push(`unknown switch /${k} — ${known.map((x) => '/' + x).join(' ')}`);
  }
  const out = { type: null, set: {} };
  if (sw.type === undefined || sw.type === true) errs.push('needs /type:<food|wood|stone|iron|gold>');
  else {
    out.type = C.resourceByWord(sw.type);
    if (!out.type) errs.push(`/type:${sw.type} — food, wood (lumber), stone, iron or gold`);
  }
  const t = out.type;
  const gold = t === 'gold';
  if (gold && sw.max !== undefined) errs.push('gold cannot have a /max (wiki TradePolicy)');
  for (const k of ['min', 'max']) {
    if (sw[k] === undefined || (gold && k === 'max')) continue;
    const v = sw[k] === true ? null : amountOrDays(sw[k]);
    if (v === null) { errs.push(`/${k}${sw[k] === true ? '' : ':' + sw[k]} needs an amount, e.g. /${k}:20m${t === 'food' || (gold && k === 'min') ? ` or /${k}:2d` : ''}`); continue; }
    // wiki: "d" for "gold and food minimums and food maximums"
    if (typeof v === 'object' && !(t === 'food' || (gold && k === 'min'))) {
      errs.push(`/${k}:${sw[k]} — "d" (days) is for gold and food minimums and food maximums only`);
      continue;
    }
    out.set[k] = v;
  }
  if (sw.batch !== undefined) {
    const v = sw.batch === true ? null : NUM(sw.batch);
    if (gold) errs.push('gold is not traded itself, so /batch means nothing on a gold line');
    else if (v === null || v < 1) errs.push(`/batch needs an amount, e.g. /batch:500k`);
    else out.set.batch = v;
  }
  for (const [k, field] of [['allowselltomin', 'sellToMin'], ['donotautosellabovemax', 'keepAboveMax']]) {
    if (sw[k] === undefined) continue;
    const v = sw[k] === true ? 1 : NUM(sw[k]);
    if (gold) errs.push(`gold is not bought or sold itself, so /${k} means nothing on a gold line`);
    else if (v !== 0 && v !== 1) errs.push(`/${k} is on its own, or 0/1 — got "${sw[k]}"`);
    else out.set[field] = v === 1;
  }
  const lo = out.set.min, hi = out.set.max;
  if (lo != null && hi != null && typeof lo === typeof hi) {
    const a = typeof lo === 'object' ? lo.days : lo, b = typeof hi === 'object' ? hi.days : hi;
    if (a > b) errs.push(`/min ${daysText(lo)} is more than /max ${daysText(hi)}`);
  }
  return { ...out, ok: errs.length === 0, errors: errs };
}

function parseResourceLimits(args) {
  const errs = [], limits = {};
  const toks = args.map(String).filter(Boolean);
  if (toks.length !== 4) errs.push('expected: resourcelimits <food> <lumber> <stone> <iron>, e.g. resourcelimits 2b 50m 2b 20m');
  RESOURCES.forEach((r, i) => {
    if (toks[i] === undefined) return;
    const v = NUM(toks[i]);
    if (v === null) errs.push(`${r} "${toks[i]}" is not an amount (5m, 200k, 1b)`);
    else limits[r] = v;
  });
  return { limits, ok: errs.length === 0, errors: errs };
}

const parsers = {
  // config trade:0|1 (wiki Trade). Checked here so `config trade:5` is an
  // error, and a bare `trade 1` line is read as the config it means.
  trade: {
    kind: 'config', multi: false,
    parse(value) {
      const s = value === undefined || value === null ? '' : String(value).trim();
      const errs = [];
      if (!/^[01]$/.test(s)) errs.push(`trade is 0 (off) or 1 (on), got "${value === undefined ? '' : value}"`);
      return { on: s === '1', errors: errs };
    },
  },
  tradepolicy: { kind: 'policy', multi: true, parse: parseTradePolicy },
  resourcelimits: { kind: 'policy', multi: false, parse: parseResourceLimits },
};

function describeTrade(g) {
  const bad = g.ok === false ? ' — NOT USED, the line has errors' : '';
  if (g.name === 'resourcelimits') {
    return `resourcelimits: keep ${RESOURCES.map((r) => `${r} ${fmt(g.limits[r])}`).join(', ')} — bought when under, `
      + `sold when over, with config trade:1; gold's floor a day of hero salary${bad}`;
  }
  const s = g.set || {};
  const bits = [];
  if (s.min != null) bits.push(`at least ${typeof s.min === 'object' ? `${s.min.days} day(s) of ${g.type === 'gold' ? 'hero salary' : 'troop upkeep'}` : fmt(s.min)}`);
  if (s.max != null) bits.push(`at most ${typeof s.max === 'object' ? `${s.max.days} day(s) of troop upkeep` : fmt(s.max)}`);
  if (s.batch != null) bits.push(`in lots of ${fmt(s.batch)} or more`);
  if (s.sellToMin) bits.push('may sell other resources down to their /min to buy it');
  if (s.keepAboveMax) bits.push('kept over /max while every resource is at /max');
  return `tradepolicy: ${g.type || '?'}${g.type === 'gold' ? ' (the floor no bid goes under)' : ''} — ${bits.join(', ') || 'the built-in values'}${bad}`;
}

// ---------------------------------------------------------------- settings

// Each resource's settings as the goal lines leave them: built-in values,
// then every resourcelimits and tradepolicy line in order.
function policyOf(goals) {
  const base = (min, max) => ({ min, max, batch: DEFAULT_BATCH, sellToMin: false, keepAboveMax: false, from: 'built-in' });
  const pol = {
    food: base({ days: 1 }, 990e9),
    wood: base(20e6, 7.2e12), stone: base(20e6, 7.2e12), iron: base(20e6, 7.2e12),
    gold: { min: null, from: 'built-in' },           // null: a day of salary, never under 100k
  };
  const skipped = [];
  for (const g of goals || []) {
    if (g.name !== 'resourcelimits' && g.name !== 'tradepolicy') continue;
    if (g.ok === false) { skipped.push(`${g.name} line ${g.line || '?'}`); continue; }
    if (g.name === 'resourcelimits') {
      for (const r of RESOURCES) Object.assign(pol[r], { min: g.limits[r], max: g.limits[r], from: `resourcelimits line ${g.line || '?'}` });
      Object.assign(pol.gold, { min: { days: 1 }, from: `resourcelimits line ${g.line || '?'}` });
    } else if (pol[g.type]) {
      Object.assign(pol[g.type], g.set, { from: `tradepolicy line ${g.line || '?'}` });
    }
  }
  return { pol, skipped };
}

// Days into amounts. perHour null: not known (the resource bean lacks it).
function resolve(v, perHour) {
  if (v == null) return null;
  if (typeof v !== 'object') return v;
  return perHour == null ? null : Math.round(v.days * 24 * perHour);
}

// -------------------------------------------------------------- the market

// What goal-trade keeps per connection: the pacing, and each city's offer
// limit once a refusal has said it.
function marketOf(game) {
  if (!game._goalMarket) game._goalMarket = { writeAt: 0, misses: 0, cap: new Map(), books: {}, est: new Map() };
  return game._goalMarket;
}

// After our orders, a city's figures are old until the server pushes its
// resources again (server.ResourceUpdate; the console's session puts a NEW
// resource object on the castle each time). Until then: the gold as our own
// sums have it, never more than the old figure says, and no new plan at all —
// otherwise the same shortfall would be bought again on figures from before
// the last buy. (goalsd's bare Game applies no such pushes, so there the
// market goals stop after one round of orders, which is the safe way to fail.)
const stale = (game, castle) => {
  const e = marketOf(game).est.get(game.castleId(castle));
  return e && castle.resource === e.res ? e : null;
};
const goldOf = (game, castle) => {
  const pushed = n(castle.resource && castle.resource.gold);
  const e = stale(game, castle);
  return e ? Math.min(pushed, e.gold) : pushed;
};
const clockOf = (game) => game.tradeClock || { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

// The book of one resource as the last read left it — ours or anyone's
// (game.marketBook) — asks cheapest first, bids dearest first.
function bookOf(game, res) {
  const mine = marketOf(game).books[res] || null;
  const theirs = typeof game.marketBook === 'function' ? game.marketBook(res) : null;
  const raw = [mine, theirs].filter(Boolean).sort((a, b) => n(b.at) - n(a.at))[0];
  if (!raw) return null;
  const levels = (xs) => (xs || []).map((x) => ({ price: Number(x.price), amount: n(x.amount) })).filter((x) => x.amount > 0 && x.price > 0);
  return {
    at: n(raw.at),
    asks: levels(raw.sellers).sort((a, b) => a.price - b.price),
    bids: levels(raw.buyers).sort((a, b) => b.price - a.price),
  };
}

async function readBook(game, res) {
  const d = await game.searchTrades(res);
  if (!d || (d.ok !== undefined && d.ok !== 1)) throw new Error((d && d.errorMsg) || `no ${res} prices`);
  marketOf(game).books[res] = { at: clockOf(game).now(), sellers: d.sellers || [], buyers: d.buyers || [] };
  return bookOf(game, res);
}

// How many offers this city's Marketplace holds: what a refusal said, else
// its level (10 at level 10 is known live; a smaller one allows fewer), 0
// with no Marketplace at all.
function capOf(game, castle) {
  const learned = marketOf(game).cap.get(game.castleId(castle));
  if (learned) return learned;
  const list = castle.buildings;
  if (!Array.isArray(list)) return MAX_OFFERS;
  const lvl = list.filter((b) => Number(b.typeId) === MARKETPLACE && !(n(b.status) === 0 && n(b.level) === 0))
    .reduce((m, b) => Math.max(m, n(b.level)), 0);
  return Math.min(MAX_OFFERS, lvl);
}

// "10 offers are allowed at level 10 Marketplace."
function learnCap(game, castle, msg) {
  const m = String(msg || '').match(/(\d+) offers? (?:are|is) allowed/i);
  if (m) marketOf(game).cap.set(game.castleId(castle), Number(m[1]));
}

// Market writes wait their turn: WRITE_GAP_MS after the last, doubled for each
// write in a row that got no answer.
async function pace(game) {
  const m = marketOf(game), clock = clockOf(game);
  const gap = Math.min(MAX_GAP_MS, WRITE_GAP_MS * 2 ** m.misses);
  const wait = m.writeAt + gap - clock.now();
  if (wait > 0) await clock.sleep(wait);
  m.writeAt = clock.now();
}

// A write with no answer: the next waits longer, and the city stops trading for
// a while (a minute, doubling, at most half an hour).
function noteMiss(game, st) {
  const m = marketOf(game);
  m.misses = Math.min(m.misses + 1, 6);
  st.holdUntil = clockOf(game).now() + Math.min(30 * 60e3, 60e3 * 2 ** (m.misses - 1));
}

// ----------------------------------------------------------- our own offers

const tradeState = (cityState) => (cityState.trade = cityState.trade || { orders: [], pending: [] });

// Our offers on the book: orders placed and seen there (by id), and orders
// placed whose TradesUpdate has not come yet, matched on type, resource,
// amount and price with an id that was not there before. One no longer on the
// book filled or was cancelled. Mutates `st`; the plan hands it a copy.
function reconcile(castle, st, now) {
  const book = castle.trades || [];
  const ids = new Set(book.map((t) => String(t.id)));
  st.orders = (st.orders || []).filter((o) => ids.has(String(o.id)));
  const taken = new Set(st.orders.map((o) => String(o.id)));
  const keep = [];
  for (const p of st.pending || []) {
    const t = book.find((x) => !taken.has(String(x.id)) && !(p.had || []).includes(String(x.id))
      && Number(x.tradeType) === TYPE[p.side] && Number(x.resType) === C.TRADE_RES[p.res]
      && n(x.amount) === p.amount && Math.abs(Number(x.price) - p.price) < 1e-6);
    if (t) {
      st.orders.push({ id: t.id, res: p.res, side: p.side, amount: p.amount, price: p.price, at: p.at, proceeds: !!p.proceeds });
      taken.add(String(t.id));
    } else if (now - p.at < PENDING_MS) keep.push(p);
  }
  st.pending = keep;
  if (st.proceeds && now - n(st.proceeds.at) > PROCEEDS_MS) st.proceeds = null;
  return st;
}

// What is still to fill of an offer on the book.
const leftOf = (castle, o) => {
  const t = (castle.trades || []).find((x) => String(x.id) === String(o.id));
  return t ? Math.max(0, n(t.amount) - n(t.dealedAmount)) : 0;
};

// ---------------------------------------------------------------- decide

// The trades one pass wants, in the wiki's stages. Pure: `s` is a snapshot
//   have     food..iron held, counting purchases in transit and our own resting buys
//   gold     gold held;  goldMin its floor (resolved)
//   pol      each resource { min, max, batch, sellToMin, keepAboveMax } (resolved)
//   price    each resource { ask, bid } from the book (null when not known)
//   salary   hero salary per hour; upkeep troop food per hour (null unknown)
//   proceeds gold from selling what was over /max, not spent yet
// -> { emergency, trades: [{ res, side, amount, prio, why, ... }], notes }
function decide(s) {
  const out = { emergency: null, trades: [], notes: [] };
  const P = (r) => s.price[r] || {};
  const unitBuy = (r) => P(r).ask * (1 + FEE);
  const unitSell = (r) => P(r).bid * (1 - FEE);
  const excess = (r) => Math.max(0, s.have[r] - s.pol[r].max);
  const selling = {};                          // amount this pass already sells of each
  const sell = (t) => { selling[t.res] = n(selling[t.res]) + t.amount; out.trades.push({ side: 'sell', ...t }); };
  const buy = (t) => out.trades.push({ side: 'buy', ...t });

  // Sell `gold` worth from `pool` (resources in the order given), never taking
  // one below its floor(r). Returns the gold still not covered.
  const raise = (gold, pool, floor, base, { minLot = true } = {}) => {
    for (const r of pool) {
      if (gold <= 0) break;
      if (!(P(r).bid > 0)) continue;
      const avail = Math.floor(s.have[r] - floor(r) - n(selling[r]));
      const amount = Math.min(avail, Math.ceil(gold / unitSell(r)));
      if (amount <= 0 || (minLot && amount < s.pol[r].batch)) continue;
      sell({ ...base, res: r, amount, keep: floor(r) });
      gold -= amount * unitSell(r);
    }
    return gold;
  };
  const byValue = (list, of) => [...list].sort((a, b) => of(b) * n(P(b).bid) - of(a) * n(P(a).bid));

  // ---- emergency: all /min and /batch settings are ignored
  const goldEm = s.salary > 0 && s.gold < 24 * s.salary;
  const foodEm = s.upkeep > 0 && s.have.food < 0.5 * s.upkeep;
  if (goldEm || foodEm) {
    out.emergency = [goldEm && `gold ${short(s.gold)} is under a day of hero salary (${short(24 * s.salary)})`,
      foodEm && `food ${short(s.have.food)} is under 30 minutes of troop upkeep (${short(0.5 * s.upkeep)})`].filter(Boolean).join(' and ');
    let goldNeed = goldEm ? Math.ceil(25 * s.salary - s.gold) : 0;     // back over a day's salary, an hour spare
    if (foodEm && P('food').ask > 0) {
      const want = Math.ceil(s.upkeep - s.have.food);                  // up to an hour of upkeep
      const affordable = Math.floor(Math.max(0, s.gold) / unitBuy('food'));
      if (affordable > 0) buy({ res: 'food', amount: Math.min(want, affordable), prio: 0, emergency: true, goldFloor: 0, funding: 'gold', why: 'emergency: food for the troops' });
      if (affordable < want) goldNeed += (want - affordable) * unitBuy('food');
    }
    if (goldNeed > 0) {
      const pool = RESOURCES.filter((r) => !(foodEm && r === 'food'));
      // what is over its /min goes first, then down to nothing ("as low as necessary")
      let left = raise(goldNeed, byValue(pool, (r) => s.have[r] - s.pol[r].min), (r) => Math.min(s.have[r], s.pol[r].min),
        { prio: 1, emergency: true, why: 'emergency: gold' }, { minLot: false });
      if (left > 0) left = raise(left, byValue(pool, (r) => s.have[r]), () => 0, { prio: 1, emergency: true, why: 'emergency: gold' }, { minLot: false });
      if (left > 0) out.notes.push(`about ${short(left)} gold of the emergency can't be raised from the book`);
    }
    return out;
  }

  const spare0 = Math.max(0, s.gold - s.goldMin);
  let spare = spare0;
  const anyExcess = RESOURCES.some((r) => excess(r) >= s.pol[r].batch && P(r).bid > 0);

  // ---- 1: gold under its floor — sell what is over /max for it
  if (s.gold < s.goldMin && Number.isFinite(s.goldMin)) {
    const left = raise(s.goldMin - s.gold, byValue(RESOURCES, excess), (r) => s.pol[r].max, { prio: 2, why: `gold under its ${short(s.goldMin)} floor` });
    if (left > 0 && left >= s.goldMin - s.gold) out.notes.push(`gold ${short(s.gold)} is under its ${short(s.goldMin)} floor — nothing over /max to sell for it`);
  }

  // ---- 2: under /min
  const shortList = RESOURCES.filter((r) => s.pol[r].min != null && s.have[r] < s.pol[r].min)
    .map((r) => ({ r, need: Math.ceil(s.pol[r].min - s.have[r]) }))
    .sort((a, b) => b.need / Math.max(1, s.pol[b.r].min) - a.need / Math.max(1, s.pol[a.r].min));
  for (const { r, need } of shortList) {
    const head = `${r} ${short(s.have[r])} < ${short(s.pol[r].min)} min`;
    // wiki: "the bot has to wait until it can buy or sell at least" the batch
    if (need < s.pol[r].batch) { out.notes.push(`${head}: waiting — ${short(need)} short, under the ${short(s.pol[r].batch)} batch`); continue; }
    if (!s.price[r]) { out.notes.push(`${head}: waiting for fresh ${r} prices`); continue; }
    if (!(P(r).ask > 0)) { out.notes.push(`${head}: nobody is selling ${r}`); continue; }
    const fromGold = Math.min(need, Math.floor(spare / unitBuy(r)));
    let rest = need;
    if (fromGold >= s.pol[r].batch) {
      buy({ res: r, amount: fromGold, prio: 3, goldFloor: s.goldMin, funding: 'gold', why: `${head}, with gold over the ${short(s.goldMin)} floor` });
      spare -= fromGold * unitBuy(r);
      rest -= fromGold;
    }
    if (rest < s.pol[r].batch) continue;
    // what others hold over /max is sold for it (bought with next pass's gold)
    let gold = raise(rest * unitBuy(r), byValue(RESOURCES.filter((o) => o !== r), excess), (o) => s.pol[o].max,
      { prio: 4, why: `to buy ${r} (${head})` });
    // wiki: only "if there is nothing extra to sell and no gold to spare"
    if (gold > 0 && s.pol[r].sellToMin && !anyExcess && fromGold < s.pol[r].batch) {
      gold = raise(gold, byValue(RESOURCES.filter((o) => o !== r), (o) => s.have[o] - s.pol[o].min),
        (o) => Math.max(0, n(s.pol[o].min)), { prio: 4, why: `/allowselltomin, to buy ${r}` });
    }
    if (gold >= rest * unitBuy(r)) {
      out.notes.push(`${head}: waiting — no gold over the ${short(s.goldMin)} floor and nothing over /max to sell`
        + (s.pol[r].sellToMin ? '' : ' (/allowselltomin would sell others down to their /min)'));
    }
  }

  // ---- 3: nothing under /min — sell what is over /max, buy what is under it
  if (!shortList.length) {
    const overs = RESOURCES.filter((r) => excess(r) >= s.pol[r].batch && P(r).bid > 0);
    const unders = RESOURCES.filter((r) => s.have[r] < s.pol[r].max);
    if (unders.length) {
      // not everything is at /max: what is over is sold, whatever the switch says
      for (const r of overs) sell({ res: r, amount: Math.floor(excess(r) - n(selling[r])), keep: s.pol[r].max, prio: 5, proceeds: true, why: `${r} over its ${short(s.pol[r].max)} max` });
      const expected = overs.reduce((sum, r) => sum + excess(r) * unitSell(r), 0);
      const pot = Math.min(n(s.proceeds) + expected, spare);
      const buyable = unders.filter((r) => P(r).ask > 0);
      const value = (r) => (Math.min(s.pol[r].max, 7.2e12) - s.have[r]) * unitBuy(r);
      const total = buyable.reduce((sum, r) => sum + value(r), 0);
      if (pot > 0 && total > 0) {
        for (const r of buyable) {
          const budget = pot * value(r) / total;
          const amount = Math.min(Math.floor(s.pol[r].max - s.have[r]), Math.floor(budget / unitBuy(r)));
          if (amount >= s.pol[r].batch) {
            buy({ res: r, amount, budget, prio: 6, goldFloor: s.goldMin, funding: 'proceeds', why: `${r} under its ${short(s.pol[r].max)} max, with what selling the excess brought in` });
          }
        }
      }
    } else {
      // everything is at /max: sell what goes over and hoard the gold
      for (const r of overs) {
        if (s.pol[r].keepAboveMax) { out.notes.push(`${r} over its ${short(s.pol[r].max)} max is kept (/donotautosellabovemax)`); continue; }
        sell({ res: r, amount: Math.floor(excess(r)), keep: s.pol[r].max, prio: 5, why: `${r} over its ${short(s.pol[r].max)} max (every resource is at /max: the gold is kept)` });
      }
    }
  }
  out.trades.sort((a, b) => a.prio - b.prio);
  return out;
}

// ---------------------------------------------------------------------- plan

function tradePlan(ctx, cityState, game) {
  game = game || ctx.game;
  const cfg = parsers.trade.parse(ctx.config && ctx.config.trade);
  const lines = (ctx.goals || []).filter((g) => g.name === 'tradepolicy' || g.name === 'resourcelimits');
  if (!cfg.on) {
    return lines.length ? { note: `trade: ${lines.length} tradepolicy/resourcelimits line(s) wait for config trade:1`, actions: [] } : null;
  }
  const here = ctx.castle;
  const cid = game.castleId(here);
  const clock = clockOf(game);
  const now = clock.now();
  // a copy: the plan only looks (the executors keep the books)
  const st = reconcile(here, JSON.parse(JSON.stringify((cityState && cityState.trade) || { orders: [], pending: [] })), now);
  const notes = [];
  const actions = [];

  if (n(st.holdUntil) > now) {
    return { note: `trade: holding — the market did not answer; trying again in ${Math.ceil((st.holdUntil - now) / 1000)}s`, actions: [] };
  }
  if (game.c && game.c.missedReplies >= 3) return { note: 'trade: holding — the server is not answering', actions: [] };
  const cap = capOf(game, here);
  if (!cap) return { note: 'trade: no Marketplace in this city — nothing to trade with', actions: [] };

  const { pol, skipped } = policyOf(ctx.goals);
  for (const k of skipped) notes.push(`${k} not used — it has errors`);

  // our offers: stale ones go (their fee is lost either way; the slot and the
  // gold or resources come back)
  const mine = st.orders.map((o) => ({ ...o, left: leftOf(here, o) }));
  for (const o of mine.filter((x) => now - x.at >= STALE_MS).slice(0, CANCELS_PER_PASS)) {
    actions.push({
      kind: 'marketCancel', tradeId: o.id, res: o.res, side: o.side,
      label: `cancel our ${o.side} offer of ${fmt(o.left)} ${o.res} @ ${px(o.price)} — on the book ${Math.round((now - o.at) / 60000)} min `
        + `(its fee, about ${fmt(o.left * o.price * FEE)} gold, is not refunded)`,
    });
  }
  const cancelling = new Set(actions.map((a) => String(a.tradeId)));
  const resting = mine.filter((o) => !cancelling.has(String(o.id)));

  // our last orders are not in this city's figures yet: nothing new on them
  if (stale(game, here)) {
    notes.push('waiting — the server has not reported this city\'s resources since our last order, so its figures are old');
    return { note: `trade: ${notes.join('; ')}`, actions };
  }

  // holidaysnipe first: never trade what it is working on
  const claims = ctx.holidaySnipe !== undefined ? ctx.holidaySnipe : HS.claims(ctx.accountId, game);
  if (claims && !claims.dry && claims.cities && claims.cities.has(cid)) {
    notes.push('holidaysnipe has buy orders open in this city — the market goals wait for it');
    return { note: `trade: ${notes.join('; ')}`, actions };
  }

  // prices: read them when the last look is old
  const books = {};
  for (const r of RESOURCES) books[r] = bookOf(game, r);
  if (RESOURCES.some((r) => !books[r] || now - books[r].at > BOOK_TTL_MS)) {
    actions.push({ kind: 'marketRead', label: 'read the market prices (food, wood, stone, iron)' });
    if (RESOURCES.every((r) => !books[r])) {
      notes.push('reading the market prices first');
      return { note: `trade: ${notes.join('; ')}`, actions };
    }
  }

  // what the city holds, counting what is on its way to it: purchases in
  // transit, our own resting bids, and our transports heading here (a city
  // that also requests resources does not buy what a transport is bringing)
  const res = here.resource || {};
  const have = {};
  for (const r of RESOURCES) have[r] = n(res[r] && res[r].amount);
  for (const t of here.transingTrades || []) { const r = RES_BY_TYPE[Number(t.resType)]; if (r) have[r] += n(t.amount); }
  for (const o of resting) if (o.side === 'buy') have[o.res] += o.left;
  const book = ctx.rally || R.rallyBook({ game, armies: ctx.selfArmies || null });
  for (const m of book.arriving(here.fieldId, C.MISSION.transport)) {
    for (const r of RESOURCES) have[r] += n(m.resources && m.resources[r]);
  }
  const gold = n(res.gold);
  const salary = res.herosSalary === undefined || res.herosSalary === null ? null : n(res.herosSalary);
  const upkeep = res.troopCostFood === undefined || res.troopCostFood === null ? null : n(res.troopCostFood);

  // settings as amounts
  const resolved = {};
  for (const r of RESOURCES) {
    const p = pol[r];
    const min = resolve(p.min, upkeep), max = resolve(p.max, upkeep);
    resolved[r] = { ...p, min: min === null ? 0 : min, max: max === null ? Infinity : max };
    if ((min === null && p.min != null) || (max === null && p.max != null)) notes.push(`${r}: troop upkeep unknown, so its days can't be worked out`);
    // /min:2d over /max:500m once the days are counted would buy it up and sell
    // it straight back, a fee each way: /max is read as /min
    if (resolved[r].min > resolved[r].max) {
      notes.push(`${r}: /min ${short(resolved[r].min)} is over /max ${short(resolved[r].max)} — /max read as ${short(resolved[r].min)}`);
      resolved[r].max = resolved[r].min;
    }
  }
  // The gold floor: an amount as written; days of salary (the built-in value is
  // one day) never under 100k, so a city with next to no heroes still keeps
  // gold for its building and research.
  const days = pol.gold.min == null ? { days: 1 } : pol.gold.min;
  let goldMin = typeof days === 'object' ? resolve(days, salary) : days;
  if (goldMin !== null && typeof days === 'object') goldMin = Math.max(GOLD_FLOOR_ATLEAST, goldMin);
  if (goldMin === null) {
    notes.push('hero salary unknown, so the gold floor can\'t be worked out — not buying');
    goldMin = Infinity;
  }
  // Only fresh prices plan a trade: a resource whose book is old waits for the
  // read this pass makes (each order reads its own book again anyway).
  const price = {};
  for (const r of RESOURCES) {
    const b = books[r];
    price[r] = b && now - b.at <= BOOK_TTL_MS
      ? { ask: b.asks.length ? b.asks[0].price : null, bid: b.bids.length ? b.bids[0].price : null } : null;
  }
  const proceeds = st.proceeds ? n(st.proceeds.gold) : 0;

  const d = decide({ have, gold, goldMin, pol: resolved, price, salary: salary || 0, upkeep: upkeep || 0, proceeds });
  if (d.emergency) notes.push(`EMERGENCY: ${d.emergency} — every /min and /batch is set aside`);
  notes.push(...d.notes);

  // what the market lets us do this pass
  let free = cap - (here.trades || []).length + cancelling.size;
  const ownLeft = OWN_RESTING_MAX - resting.length;
  let placed = 0;
  const said = new Set();
  const once = (m) => { if (!said.has(m)) { said.add(m); notes.push(m); } };
  for (const t of d.trades) {
    const what = `${t.side} ${short(t.amount)} ${t.res}`;
    if (claims && !claims.dry && claims.buying && claims.buying.has(t.res)) { once(`${t.res}: holidaysnipe is buying a dump of it — left to it`); continue; }
    if (claims && !claims.dry && t.side === 'sell' && claims.listed && claims.listed.has(`${cid}:${t.res}`)) {
      once(`${t.res}: holidaysnipe keeps a sell offer listed here — not selling it too`);
      continue;
    }
    if (resting.some((o) => o.res === t.res && o.side === t.side)) { once(`${what}: waiting — our ${t.side} offer for ${t.res} is still on the book`); continue; }
    if (placed >= TRADES_PER_PASS) { once(`${what}: next pass`); continue; }
    if (free <= 0) { once(`${what}: waiting — all ${cap} market offers of this city are in use`); continue; }
    if (placed >= ownLeft) { once(`${what}: waiting — ${resting.length} of our own offers are still on the book`); continue; }
    placed++;
    free--;
    const band = t.emergency ? EMERGENCY_BAND : PRICE_BAND;
    const minTotal = t.emergency ? 1 : resolved[t.res].batch;
    if (t.side === 'buy') {
      actions.push({
        kind: 'marketBuy', res: t.res, amount: t.amount, minTotal, band, emergency: !!t.emergency,
        goldFloor: t.goldFloor === undefined ? goldMin : t.goldFloor,
        funding: t.funding || 'gold', budget: t.budget === undefined ? null : t.budget,
        label: `buy ${fmt(t.amount)} ${t.res} (${t.why})`,
      });
    } else {
      actions.push({
        kind: 'marketSell', res: t.res, amount: t.amount, minTotal, band, emergency: !!t.emergency,
        keep: n(t.keep), proceeds: !!t.proceeds,
        label: `sell ${fmt(t.amount)} ${t.res} (${t.why})`,
      });
    }
  }

  const stock = `gold ${short(gold)} (floor ${short(goldMin)})`;
  const levels = RESOURCES.map((r) => `${r} ${short(have[r])}`).join(', ');
  if (!actions.length && !notes.length) notes.push(`all within tradepolicy — ${levels}`);
  return { note: `trade: ${stock}; ${notes.join('; ')}`, actions };
}

// ----------------------------------------------------------------- executors

// The price levels one trade takes: the best and the next ones within the
// band, never past twice (four times in an emergency) the other side's best.
function levelsFor(book, side, band, emergency) {
  const spread = emergency ? EMERGENCY_SPREAD : SPREAD;
  if (side === 'buy') {
    if (!book.asks.length) return { levels: [], why: 'nobody is selling' };
    const best = book.asks[0].price;
    const bid = book.bids.length ? book.bids[0].price : null;
    const cap = Math.min(best * (1 + band), bid ? bid * spread : Infinity);
    const levels = book.asks.filter((l) => l.price <= cap + 1e-9);
    return { levels, why: levels.length ? null : `the cheapest seller asks ${px(best)}, over ${spread}x the best bid ${px(bid)}` };
  }
  if (!book.bids.length) return { levels: [], why: 'nobody is buying' };
  const best = book.bids[0].price;
  const ask = book.asks.length ? book.asks[0].price : null;
  const floor = Math.max(best * (1 - band), ask ? ask / spread : 0);
  const levels = book.bids.filter((l) => l.price >= floor - 1e-9);
  return { levels, why: levels.length ? null : `the best buyer bids ${px(best)}, under 1/${spread} of the cheapest ask ${px(ask)}` };
}

// Place one buy or sell: orders at the book's own price levels, paced, each
// followed by our bookkeeping. Returns { ok, errorMsg } for the engine's log,
// and adds what went through to the action's label.
async function placeTrade(game, castle, a, cityState, side) {
  const st = tradeState(cityState);
  const clock = clockOf(game);
  reconcile(castle, st, clock.now());
  const cid = game.castleId(castle);
  let book;
  try { book = await readBook(game, a.res); }
  catch (e) { noteMiss(game, st); return { ok: 0, errorMsg: `${a.res} prices unreadable (${e.message}) — the market goals hold for a while` }; }

  const { levels, why } = levelsFor(book, side, a.band, a.emergency);
  if (!levels.length) return { ok: 0, errorMsg: `waiting — ${why}` };
  const res = castle.resource || {};
  const gold0 = goldOf(game, castle);
  let gold = gold0;
  const orders = [];
  let left = a.amount;
  if (side === 'buy') {
    // never under the gold floor, bid and fee included; a buy paid for by
    // selling the excess spends only what that brought in
    let money = gold - n(a.goldFloor);
    if (a.funding === 'proceeds') money = Math.min(money, st.proceeds ? n(st.proceeds.gold) : 0, a.budget == null ? Infinity : a.budget);
    for (const l of levels.slice(0, ORDERS_PER_TRADE)) {
      const price = HS.priceText(l.price, 'up');
      const unit = Number(price) * (1 + FEE);
      const amount = Math.floor(Math.min(l.amount, left, MAX_ORDER, money / unit));
      if (amount <= 0) break;
      orders.push({ price, amount });
      left -= amount; money -= amount * unit;
    }
  } else {
    // never below what the plan keeps of it, and the fee is paid in gold
    const held = n(res[a.res] && res[a.res].amount);
    left = Math.min(left, Math.floor(held - n(a.keep)));
    for (const l of levels.slice(0, ORDERS_PER_TRADE)) {
      const price = HS.priceText(l.price, 'down');
      const amount = Math.floor(Math.min(l.amount, left, MAX_ORDER, gold / (Number(price) * FEE)));
      if (amount <= 0) break;
      orders.push({ price, amount });
      left -= amount; gold -= amount * Number(price) * FEE;
    }
  }
  const total = orders.reduce((s, o) => s + o.amount, 0);
  if (total <= 0 || total < n(a.minTotal)) {
    return { ok: 0, errorMsg: `waiting — only ${short(total)} ${side === 'buy' ? 'can be bought' : 'can be sold'} within the price limits, under the ${short(a.minTotal)} batch` };
  }
  const room = capOf(game, castle) - (castle.trades || []).length;
  if (room <= 0) return { ok: 0, errorMsg: 'waiting — every market offer of this city is in use' };

  const done = [], refused = [];
  let spent = 0, fees = 0, lastRes = null;
  for (const o of orders.slice(0, room)) {
    await pace(game);
    const had = (castle.trades || []).map((t) => String(t.id));
    // the figures as they stood when this order went: a push after it replaces them
    const resBefore = castle.resource;
    let r;
    try {
      r = await game.newTrade({ castleId: cid, resource: a.res, type: side, amount: o.amount, price: o.price });
    } catch (e) {
      noteMiss(game, st);
      refused.push(`no answer (${e.message}) — the market goals hold for a while`);
      break;
    }
    marketOf(game).misses = 0;
    if (!r || r.ok !== 1) {
      learnCap(game, castle, r && r.errorMsg);
      refused.push(r && r.ok === -38 ? `the marketplace is full${r.errorMsg ? ` (${r.errorMsg})` : ''}` : ((r && r.errorMsg) || `ok=${r && r.ok}`));
      break;
    }
    const p = Number(o.price);
    lastRes = resBefore;
    st.pending.push({ res: a.res, side, amount: o.amount, price: p, at: clock.now(), had, proceeds: side === 'sell' && !!a.proceeds });
    done.push(`${short(o.amount)} @ ${o.price}`);
    if (side === 'buy') spent += o.amount * p * (1 + FEE);
    else fees += o.amount * p * FEE;
    if (side === 'sell' && a.proceeds) {
      // gold the sale brings in, for the buys it pays for (stage 3)
      const was = st.proceeds && clock.now() - n(st.proceeds.at) <= PROCEEDS_MS ? n(st.proceeds.gold) : 0;
      st.proceeds = { gold: was + o.amount * p * (1 - FEE), at: clock.now() };
    }
  }
  if (side === 'buy' && a.funding === 'proceeds' && st.proceeds) {
    st.proceeds.gold = Math.max(0, n(st.proceeds.gold) - spent);
  }
  // what the gold is now by our own sums, until the server says (see stale):
  // old while the castle still holds the figures from before our last order
  if (done.length) marketOf(game).est.set(cid, { res: lastRes, gold: gold0 - spent - fees, at: clock.now() });
  if (done.length) a.label = `${a.label} — ${side === 'buy' ? 'bid' : 'offered'} ${done.join(', ')}${refused.length ? `; then refused: ${refused[0]}` : ''}`;
  return done.length ? { ok: 1 } : { ok: 0, errorMsg: refused[0] || 'nothing placed' };
}

const executors = {
  // Read all four books (market reads are not paced: they place nothing).
  async marketRead(game, castle, a, cityState) {
    for (const r of RESOURCES) {
      try { await readBook(game, r); }
      catch (e) { noteMiss(game, tradeState(cityState)); return { ok: 0, errorMsg: `${r} prices unreadable (${e.message})` }; }
    }
    return { ok: 1 };
  },
  marketBuy: (game, castle, a, cityState) => placeTrade(game, castle, a, cityState, 'buy'),
  marketSell: (game, castle, a, cityState) => placeTrade(game, castle, a, cityState, 'sell'),
  // Only an offer we placed, and only while it is still on the book.
  async marketCancel(game, castle, a, cityState) {
    const st = tradeState(cityState);
    const clock = clockOf(game);
    reconcile(castle, st, clock.now());
    const o = st.orders.find((x) => String(x.id) === String(a.tradeId));
    if (!o) return { ok: 0, errorMsg: 'not one of our offers on the book any more' };
    const left = leftOf(castle, o);
    await pace(game);
    let r;
    try { r = await game.cancelTrade(game.castleId(castle), o.id); }
    catch (e) { noteMiss(game, st); return { ok: 0, errorMsg: `no answer (${e.message})` }; }
    marketOf(game).misses = 0;
    if (!r || r.ok !== 1) return { ok: 0, errorMsg: (r && r.errorMsg) || `ok=${r && r.ok}` };
    st.orders = st.orders.filter((x) => x !== o);
    // a sell that paid for stage-3 buys and did not sell brings nothing in
    if (o.proceeds && st.proceeds) st.proceeds.gold = Math.max(0, n(st.proceeds.gold) - left * o.price * (1 - FEE));
    return { ok: 1 };
  },
};

module.exports = {
  parsers,
  plans: { trade: tradePlan },
  executors,
  configKeys: ['trade'],
  describeTrade,
  _internals: {
    parseTradePolicy, parseResourceLimits, policyOf, resolve, decide, reconcile, levelsFor, bookOf, capOf,
    marketOf, pace, RESOURCES, WRITE_GAP_MS, STALE_MS, PENDING_MS, BOOK_TTL_MS, MAX_ORDER, TRADES_PER_PASS,
    ORDERS_PER_TRADE, OWN_RESTING_MAX, DEFAULT_BATCH,
  },
};
