'use strict';
// The market for scripts: orders, cancels, prices (the command-module contract
// is at the top of script.js).
//
//   buy food 10000 6              NEAT's Buy: resource, amount, price — a bid for 10,000 food at 6
//   sell food 20000 8             NEAT's Sell: an offer of 20,000 food at 8
//   sell 2 12345 15.62            a resource by number, 0-3 = food wood stone iron (the STS
//                                 script's  execute "sell " + res + " " + amount + " " + price)
//   buy food 5m 22.5 | sell wood 1000 @0.55 | buy lumber 1.5m @6
//                                 k/m/b amounts; OTTObot's @price and lumber (= wood) work too
//     The price goes out the way the market's price box takes it (NewTradeWin: at most 5
//     characters, at most 150): a buy is rounded down and a sell up, so an order never pays
//     more or takes less than the price the line gives. One order is at most 99,999,999.
//   canceltrade                   every open offer of this city (CancelTrade.txt)
//   canceltrade 123456            that offer:  execute "canceltrade " + city.tradesArray[0].id
//   canceltrade buy | sell | food | sell iron    (OTTObot) this city's bids, offers, or one
//                                 resource's; a bare number is always a trade id, never a resource
//   marketupdate 0 | marketupdate wood | marketupdate      read that book now (none or all: all four)
//   dumpresource 111,222 f:11000,g:44000 f:3000,g:9000
//                                 once this city holds 11,000 food and 44,000 gold, transport 3,000
//                                 food and 9,000 gold to 111,222 (DumpResource.txt) with as many
//                                 transporters as the load needs; not yet -> $error says what is short
//   holidaysnipe [dry] | holidaysnipe stop | holidaysnipe status     (holiday-snipe.js)
//
// Globals (functions(ctx); script-objects.js hands the same functions out as
// m_context.buyPrice/sellPrice/marketReady() and city.buyPrice/sellPrice):
//   BuyPrice(res[, amount[, method]])   the highest bid, what a sell gets now   res 0-3 or a name
//   SellPrice(res[, amount[, method]])  the cheapest offer, what a buy pays now
//       NEAT build 2635: amount (default 1) and method 0 "now" (default) = the price that fills
//       `amount` at once, walking the book to the last price it needs; 1 "average" = the average
//       price over those levels. NaN when the book shows less than that, or nothing at all.
//   Price(res, q)                       q of the way from the best bid (0) to the best offer (1);
//       DERIVED from the wiki's STS trader, the only place Price appears: it bids at
//       Price(res, 2%) and offers at Price(res, 1 - 2%) — "2% inside the book".
//   m_context.marketReady()             false after a (re)login until all four books have been read
//       (Unsorted 2603); here it reads the ones that are not fresh itself, since nothing else in
//       OTTObot polls the market, and after a failed read it waits a moment before saying false,
//       so `if !m_context.marketReady() goto notready` does not spin.
//   MAX_TRADE                           99,999,999: the most one order takes (NEAT 2735+; assignable,
//                                       as the STS script's line for older builds does)
//   ResourceIntNames                    ["food", "wood", "stone", "iron"]: city.resource[ResourceIntNames[res]]
//
// Prices come from trade.searchTrades (the book's best 'buyers' and 'sellers'),
// read per resource on demand, kept per connection for 15 s (opts.marketFreshMs)
// and read again after that; a failed read leaves the last known prices. The
// book shows our own offers too, as the market window does. Reads happen in a
// dry run as well: only orders, cancels and marches are held back.
//
// Market writes are paced: a run waits tradeGapMs (1.2 s) between them, and each
// unanswered one in a row doubles that, up to a minute.
const C = require('./constants');
const W = require('./script-words');

const RESOURCES = ['food', 'wood', 'stone', 'iron'];         // TradeConstants RES_TYPE_* 0-3
const RES_TITLE = ['Food', 'Lumber', 'Stone', 'Iron'];       // Market.txt: tradesArray[x].resourceName
const FEE = C.TRADE_COMMISSION;                              // TradeConstants.MARKET_TRADE_COMMISSION 0.005
const MAX_TRADE = 99999999;      // NewTradeWin.as:332 amountInput maxChars 8, onMaxAmount 99999999 (holiday-snipe.js MAX_AMOUNT)
const MAX_PRICE = 150;           // NewTradeWin.as:605-613 onPriceChange caps the price box there
const PRICE_CHARS = 5;           // NewTradeWin.as:382-383 priceInout: restrict "0-9.", maxChars 5
const FRESH_MS = 15000;          // a book older than this is read again before a price is given
const RETRY_MS = 5000;           // after a failed read, that resource is not asked again for this long
const NOT_READY_MS = 2000;       // marketReady() waits this long before it says false
const SETTLE_MS = 2000;          // after a cancel, how long to wait for the server's TradesUpdate push

const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const amt = (n) => Math.round(n).toLocaleString('en-US');
const gold = (n) => (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0 });

// A script value as a number: strings may carry k/m/b or % (20k, 2%).
function toNum(v) {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'object' && typeof v.valueOf === 'function') { const p = v.valueOf(); if (typeof p === 'number') return p; }
  const m = String(v).trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+))\s*([kmb%])?$/i);
  if (!m) return Number(v);
  const k = (m[2] || '').toLowerCase();
  return Number(m[1]) * (k === '%' ? 0.01 : k === 'k' ? 1e3 : k === 'm' ? 1e6 : k === 'b' ? 1e9 : 1);
}

// ------------------------------------------------------------------- words

// A market resource: 0-3, or a word (food, wood, lumber, stone, iron, f w l s i).
function tradeRes(tok, word) {
  const t = String(tok == null ? '' : tok).trim();
  if (/^[0-3]$/.test(t)) return RESOURCES[+t];
  const k = t && W.resourceByWord(t);
  if (k === 'gold') throw new Error(`${word}: gold is not traded on the market — food, wood (lumber), stone or iron, or 0-3`);
  if (!k) throw new Error(`${word}: "${t}" is not a market resource — food, wood (lumber), stone or iron, or 0-3`);
  return k;
}

function tradeAmount(tok, word) {
  const t = String(tok).replace(/^(\d{1,3})((?:,\d{3})+)$/, (_, a, b) => a + b.replace(/,/g, ''));   // 10,000
  let n;
  try { n = W.num(t); } catch { throw new Error(`${word}: "${tok}" is not an amount — 10000, 20k or 1.5m`); }
  if (!(n >= 1)) throw new Error(`${word}: the amount must be at least 1`);
  if (n > MAX_TRADE) {
    throw new Error(`${word}: ${amt(n)} is more than one order takes (${amt(MAX_TRADE)}, the market's 8-digit box) — split it over several orders`);
  }
  return n;
}

// The price box's rule: as many decimals as fit in 5 characters, rounded the
// way the order means it — down for a buy, up for a sell. The same rule as
// holiday-snipe.js's priceText (which it keeps to itself).
function fitPrice(p, dir) {
  const round = dir === 'up' ? (x) => Math.ceil(x - 1e-7) : (x) => Math.floor(x + 1e-7);
  for (const d of [3, 2, 1, 0]) {
    const f = 10 ** d;
    const s = String(Number((round(p * f) / f).toFixed(d)));
    if (s.length <= PRICE_CHARS) return s;
  }
  return String(round(p));
}

// -> { price: text sent, asked: the text given when it had to be rounded }
function tradePrice(tok, word) {
  const text = String(tok).replace(/^@/, '');
  if (!/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
    throw new Error(`${word}: "${tok}" is not a price — e.g. ${word} food 20000 8 (or @8)`);
  }
  const p = Number(text);
  if (!(p > 0)) throw new Error(`${word}: the price must be over 0`);
  if (p > MAX_PRICE) throw new Error(`${word}: the market takes a price of at most ${MAX_PRICE}`);
  const price = fitPrice(p, word === 'buy' ? 'down' : 'up');
  if (!(Number(price) > 0)) throw new Error(`${word}: ${text} is under 0.001, the smallest price the market takes`);
  return Number(price) === p ? { price } : { price, asked: text };
}

// buy|sell <resource> <amount> <price>, the price with or without an @.
function parseTrade(word, tok) {
  const args = tok.slice(1).filter(Boolean);
  const usage = `usage  ${word} <food|wood|stone|iron|0-3> <amount> <price>   e.g. ${word} food 10000 6`;
  if (args.length !== 3) {
    throw new Error(args.length === 2 && !args.some((t) => t.startsWith('@')) ? `${word}: say the price too — ${usage}` : `${word}: ${usage}`);
  }
  const at = args.findIndex((t) => t.startsWith('@'));
  const priceTok = at >= 0 ? args[at] : args[2];
  const rest = at >= 0 ? args.filter((_, i) => i !== at) : args.slice(0, 2);
  return { cmd: word, resource: tradeRes(rest[0], word), amount: tradeAmount(rest[1], word), ...tradePrice(priceTok, word) };
}

// ------------------------------------------------------------------ the book

// Per connection, so a new Game (a relogin) starts with nothing: marketReady()
// is false again until the books have been read on it.
const BOOKS = new WeakMap();   // Game -> { books: {res: {bids, asks, at}}, reading: {}, failedAt: {} }
function cacheOf(g) {
  let c = BOOKS.get(g);
  if (!c) BOOKS.set(g, (c = { books: {}, reading: {}, failedAt: {} }));
  return c;
}
const freshMs = (opts) => (opts && Number.isFinite(Number(opts.marketFreshMs)) ? Number(opts.marketFreshMs) : FRESH_MS);

// One read: trade.searchTrades {resType} (TradeCommands.as:87-97, through
// game.searchTrades and its lane) -> SearchTradesResponse {buyers, sellers} of
// MarketTradeBean {amount, price}. Two callers asking at once share the read.
function readBook(g, res) {
  const c = cacheOf(g);
  if (c.reading[res]) return c.reading[res];
  const p = (async () => {
    const d = await g.searchTrades(res);
    if (!d || (d.ok !== undefined && Number(d.ok) !== 1)) {
      throw new Error(`the market did not answer for ${res}${d && d.errorMsg ? ` (${d.errorMsg})` : ''}`);
    }
    const levels = (xs) => (xs || []).map((x) => ({ price: Number(x.price), amount: Number(x.amount) }))
      .filter((x) => x.amount > 0 && x.price > 0);
    const b = { bids: levels(d.buyers).sort((x, y) => y.price - x.price), asks: levels(d.sellers).sort((x, y) => x.price - y.price), at: Date.now() };
    c.books[res] = b;
    delete c.failedAt[res];
    return b;
  })().catch((e) => { c.failedAt[res] = Date.now(); throw e; })
    .finally(() => { if (c.reading[res] === p) delete c.reading[res]; });
  c.reading[res] = p;
  return p;
}

// The book for a price: the one in hand while fresh, else read again; the last
// known one when that read fails (NEAT: "the last known bid").
async function bookFor(g, res, opts) {
  if (!g) return null;
  const c = cacheOf(g);
  const b = c.books[res];
  if (b && Date.now() - b.at < freshMs(opts)) return b;
  if (c.failedAt[res] && Date.now() - c.failedAt[res] < RETRY_MS) return b || null;
  try { return await readBook(g, res); } catch { return b || null; }
}

// Our own order or cancel changed that book: read it again before the next price.
function forgetBook(g, res) {
  const b = g && BOOKS.has(g) && cacheOf(g).books[res];
  if (b) b.at = 0;
}

// One side of the book for `amount`: the last price it reaches (method 0) or
// the average over the levels it takes (1). NaN when the side holds less.
function walk(levels, amount, method) {
  let left = amount, cost = 0, last = NaN;
  for (const l of levels) {
    const take = Math.min(left, l.amount);
    cost += take * l.price;
    left -= take;
    last = l.price;
    if (left <= 0) break;
  }
  if (left > 0) return NaN;
  return method === 1 ? Number((cost / amount).toPrecision(12)) : last;
}

const bookText = (b) => {
  const side = (xs, what) => (xs.length ? `best ${what} ${xs[0].price} (${amt(xs[0].amount)})` : `no ${what}s`);
  const vol = (xs) => amt(xs.reduce((s, x) => s + x.amount, 0));
  return `${side(b.bids, 'bid')} · ${side(b.asks, 'offer')} · ${b.bids.length} bid and ${b.asks.length} offer prices shown, `
    + `${vol(b.bids)} wanted and ${vol(b.asks)} offered`;
};

// ------------------------------------------------------------ the functions

// A price function's resource: 0-3 or a name; none at all is food, as NEAT's
// References page reads cityManager.buyPrice().
function resArg(args, fn) {
  if (!args.length) return 'food';
  const v = args[0];
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3) return RESOURCES[v];
  if (typeof v === 'string' && v.trim()) {
    const t = v.trim();
    if (/^[0-3]$/.test(t)) return RESOURCES[+t];
    const k = W.resourceByWord(t);
    if (k && k !== 'gold') return k;
  }
  const shown = v === undefined ? 'nothing (a name nobody set?)' : typeof v === 'string' ? `"${v}"` : String(v);
  throw new Error(`${fn}: which resource? 0-3 (food wood stone iron) or a name — got ${shown}; `
    + `with more than one value a name goes in quotes: ${fn}("iron", 1m)`);
}

// ctx is the run's (DESIGN.md): ctx.game is the current connection.
function makeMarket(ctx) {
  const opts = (ctx && ctx.opts) || {};
  const game = () => (ctx ? ctx.game : null);
  const side = (which, fn) => {
    const f = async (...args) => {
      const res = resArg(args, fn);
      const n = args.length > 1 ? toNum(args[1]) : 1;
      const amount = n > 0 ? n : 1;
      const method = args.length > 2 && toNum(args[2]) === 1 ? 1 : 0;
      const b = await bookFor(game(), res, opts);
      return b ? walk(b[which], amount, method) : NaN;
    };
    f.rawArgs = true;          // sellPrice(food): an unquoted name comes as text
    return f;
  };
  const buyPrice = side('bids', 'BuyPrice');
  const sellPrice = side('asks', 'SellPrice');
  const price = async (...args) => {
    const res = resArg(args, 'Price');
    const q = toNum(args[1]);
    if (args.length < 2 || !Number.isFinite(q)) {
      throw new Error('Price: say how far from the best bid (0) to the best offer (1) — e.g. Price(0, 2%) or Price(0, 1 - 2%)');
    }
    const b = await bookFor(game(), res, opts);
    const bid = b && b.bids.length ? b.bids[0].price : NaN;
    const ask = b && b.asks.length ? b.asks[0].price : NaN;
    if (q === 0) return bid;
    if (q === 1) return ask;
    return Number((bid + q * (ask - bid)).toPrecision(12));    // NaN when a side is empty
  };
  const marketReady = async () => {
    const g = game();
    const fresh = freshMs(opts);
    const isFresh = (r) => { const b = g && cacheOf(g).books[r]; return !!b && Date.now() - b.at < fresh; };
    if (g) {
      for (const r of RESOURCES) {
        await bookFor(g, r, opts);
        if (!isFresh(r)) break;         // the market is not answering: no need to sit through the others too
      }
    }
    if (RESOURCES.every(isFresh)) return true;
    const until = Date.now() + (Number.isFinite(Number(opts.marketRetryMs)) ? Number(opts.marketRetryMs) : NOT_READY_MS);
    while (Date.now() < until && !(opts.shouldStop && opts.shouldStop())) {
      await new Promise((r) => setTimeout(r, Math.min(100, Math.max(1, until - Date.now()))));
    }
    return false;
  };
  return Object.freeze({ buyPrice, sellPrice, price, marketReady });
}

const MARKETS = new WeakMap();
// The price functions for a run's ctx (script-objects.js reads them for
// m_context and city). The same function values every time for one ctx.
function market(ctx) {
  if (!ctx || typeof ctx !== 'object') return makeMarket(null);
  let m = MARKETS.get(ctx);
  if (!m) MARKETS.set(ctx, (m = makeMarket(ctx)));
  return m;
}

// NEAT's TradeBean, a plain copy: the TradesUpdate push leaves out the names.
function tradeBean(t) {
  const s = t && typeof t === 'object' ? t : {};
  const type = num(s.tradeType), res = num(s.resType);
  return {
    amount: num(s.amount), dealedAmount: num(s.dealedAmount), dealedTotal: num(s.dealedTotal), id: num(s.id),
    price: num(s.price), resType: res,
    resourceName: typeof s.resourceName === 'string' && s.resourceName ? s.resourceName : RES_TITLE[res] || '',
    tradeType: type,
    tradeTypeName: typeof s.tradeTypeName === 'string' && s.tradeTypeName ? s.tradeTypeName : type === 0 ? 'Bid' : 'Offer',   // TradeConstants: 0 buy, 1 sell
  };
}
// TransingTradeBean: a purchase on its way here.
function transingTradeBean(t) {
  const s = t && typeof t === 'object' ? t : {};
  const res = num(s.resType);
  return {
    amount: num(s.amount), endTime: num(s.endTime), id: num(s.id), price: num(s.price), resType: res,
    resourceName: typeof s.resourceName === 'string' && s.resourceName ? s.resourceName : RES_TITLE[res] || '',
    total: num(s.total),
  };
}

// ------------------------------------------------------------ market writes

// Wait out the run's gap, then send. -> { r } | { error, nextWait } | { stopped }
// A refused or unanswered write costs only its own go: the lines after it, and
// every round of a `repeat N`, still run. Each unanswered one in a row doubles
// the gap, up to a minute, rather than hammering a server that stopped answering.
async function paced(env, send) {
  const st = env.state;                        // this run's pacing, kept across lines
  st.lastTradeAt = st.lastTradeAt || 0;
  st.tradeMisses = st.tradeMisses || 0;
  const gapAfter = (misses) => Math.min(60000, Number(env.opts.tradeGapMs ?? 1200) * 2 ** misses);
  if (st.lastTradeAt) {
    const wait = gapAfter(st.tradeMisses) - (Date.now() - st.lastTradeAt);
    if (wait > 0) await env.pause(wait);
    if (env.stopped()) return { stopped: true };
    env.follow();   // the session may have reconnected during a long wait
  }
  st.lastTradeAt = Date.now();
  try {
    const r = await send(env.game);
    st.tradeMisses = 0;
    return { r };
  } catch (e) {
    st.tradeMisses++;
    return { error: e, nextWait: gapAfter(st.tradeMisses) };
  }
}

async function runTrade(a, env) {
  const castle = env.castle;
  const price = Number(a.price);
  const fee = a.amount * price * FEE;
  // NewTradeWin.as:643-663 calcCommission: a buy needs price x amount + 0.5% in gold, a sell the 0.5%
  const money = a.cmd === 'buy' ? `${gold(a.amount * price + fee)} gold with the 0.5% fee`
    : `a ${gold(fee)} gold fee (0.5%) when it is placed`;
  env.log(`  ${a.cmd} ${amt(a.amount)} ${a.resource} @ ${a.price} from ${castle.name || env.cid} · ${money}`);
  if (a.asked) {
    env.log(`  ${a.asked} does not fit the market's 5-character price box: ${a.cmd === 'buy' ? 'bid at' : 'offered at'} ${a.price}, `
      + `${a.cmd === 'buy' ? 'never over' : 'never under'} the price given`);
  }
  if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }

  // trade.newTrade {castleId, resType, tradeType, amount, price: String} (TradeCommands.as:44-58, game.newTrade)
  const w = await paced(env, (g) => g.newTrade({ castleId: g.castleId(env.castle), resource: a.resource, type: a.cmd, amount: a.amount, price: a.price }));
  if (w.stopped) { env.log('  stopped before it was sent'); return { ok: false, error: 'stopped', end: true }; }
  if (w.error) {
    env.log(`  -> ${w.error.message} — carrying on, the next order waits ${Math.round(w.nextWait / 1000)}s`);
    return { ok: false, error: w.error.message };
  }
  const r = w.r;
  forgetBook(env.game, a.resource);
  env.log('  -> ' + env.say(r));
  if (r && r.ok === -38) env.log('  marketplace full (10 offers max) — this one is skipped, the script carries on');
  return { done: 1 };
}

// ------------------------------------------------------------------ cancels

const left = (t) => Math.max(0, num(t.amount) - num(t.dealedAmount));
function offerText(t) {
  const res = RESOURCES[num(t.resType)] || 'resource ' + t.resType;
  const dealt = num(t.dealedAmount);
  return `${num(t.tradeType) === 0 ? 'bid for' : 'offer of'} ${amt(num(t.amount))} ${res} @ ${t.price}${dealt ? ` (${amt(dealt)} filled)` : ''}`;
}

function parseCancel(tok) {
  const a = { cmd: 'canceltrade', ids: [], type: null, resource: null };
  for (const w of tok.slice(1).join(' ').split(/[\s,]+/).filter(Boolean)) {
    const t = w.toLowerCase();
    if (/^\d+$/.test(t)) { a.ids.push(Number(t)); continue; }
    if (t === 'all') continue;
    if (['buy', 'buys', 'bid', 'bids'].includes(t)) { a.type = 'buy'; continue; }
    if (['sell', 'sells', 'offer', 'offers'].includes(t)) { a.type = 'sell'; continue; }
    const k = W.resourceByWord(t);
    if (k && k !== 'gold') { a.resource = k; continue; }
    throw new Error(`canceltrade: "${w}" is not a trade id, buy, sell or a resource — canceltrade alone cancels every offer of this city`);
  }
  if (a.ids.length && (a.type || a.resource)) throw new Error('canceltrade: give trade ids, or buy/sell and a resource — not both');
  return a;
}

// A trade id is the server's: look for it in this city first, then the others.
function findOffer(g, here, id) {
  const inCity = (c) => (c.trades || []).find((t) => Number(t.id) === id);
  const t = inCity(here);
  if (t) return { c: here, t };
  for (const c of g.castles || []) { const x = inCity(c); if (x) return { c, t: x }; }
  return null;
}

// After an ok, the server pushes a TradesUpdate that takes the offer off the
// city's list; wait for it (briefly), so city.tradesArray on the next line is right.
async function settle(env, gone) {
  const until = Date.now() + Number(env.opts.marketSettleMs ?? SETTLE_MS);
  const still = () => {
    const g = env.game;
    return gone.some(({ cid, id }) => {
      const c = (g.castles || []).find((x) => g.castleId(x) === cid);
      return c && (c.trades || []).some((t) => Number(t.id) === id);
    });
  };
  while (still() && Date.now() < until && !env.stopped()) await env.pause(50);
}

async function runCancel(a, env) {
  const g = env.game, here = env.castle;
  const picked = [];
  if (a.ids.length) {
    const missing = [];
    for (const id of a.ids) { const hit = findOffer(g, here, id); if (hit) picked.push(hit); else missing.push(id); }
    if (missing.length) {
      const own = (here.trades || []).map((t) => t.id);
      const msg = `${here.name} has no open offer ${missing.join(', ')}${own.length ? ` — its offers are ${own.join(', ')}` : ' — it has no open offers'}`;
      if (!picked.length) throw new Error(msg);
      env.log('  ' + msg);
    }
  } else {
    for (const t of here.trades || []) {
      if (a.type && num(t.tradeType) !== C.TRADE_TYPE[a.type]) continue;
      if (a.resource && num(t.resType) !== C.TRADE_RES[a.resource]) continue;
      picked.push({ c: here, t });
    }
    if (!picked.length) {
      env.log(`  ${here.name} has no open ${a.type === 'buy' ? 'bids' : 'offers'}${a.resource ? ` for ${a.resource}` : ''} to cancel`);
      return { ok: true, result: 0 };
    }
  }
  let fees = 0;
  for (const { c, t } of picked) {
    env.log(`  cancel ${offerText(t)} · id ${t.id}${c !== here ? ` · in ${c.name}` : ''}`);
    fees += left(t) * num(t.price) * FEE;
  }
  env.log(`  a cancel gives back what did not fill, not the 0.5% fee paid when it was placed (about ${gold(fees)} gold here)`);
  if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }

  let ok = 0, done = 0;
  const gone = [];
  for (const { c, t } of picked) {
    // trade.cancelTrade {castleId, tradeId} (TradeCommands.as:60-71, game.cancelTrade)
    const w = await paced(env, (g2) => g2.cancelTrade(g2.castleId(c), t.id));
    if (w.stopped) {
      env.log('  stopped before the rest were sent');
      return { ok: false, error: 'stopped', end: true, done, result: ok };
    }
    if (w.error) { env.log(`  -> ${t.id}: ${w.error.message}`); continue; }
    done++;
    env.log(`  -> ${t.id}: ${env.say(w.r)}`);
    if (w.r && w.r.ok === 1) {
      ok++;
      gone.push({ cid: g.castleId(c), id: Number(t.id) });
      forgetBook(env.game, RESOURCES[num(t.resType)]);
    }
  }
  if (gone.length) await settle(env, gone);
  const all = ok === picked.length;
  return { done, result: ok, ok: all, ...(all ? {} : { error: `${picked.length - ok} of ${picked.length} offer(s) not cancelled` }) };
}

// ---------------------------------------------------------- dumpresource

function parseDump(line) {
  const usage = 'usage  dumpresource <x,y | city> <when> <send>   e.g. dumpresource 111,222 f:11000,g:44000 f:3000,g:9000';
  // "111, 222" and "f:1k, g:2k" read as without the spaces, as in the marches
  const words = (line.replace(/\s*,\s*/g, ',').match(/"[^"]*"|\S+/g) || []).map((w) => w.replace(/^"(.*)"$/, '$1')).slice(1);
  if (words.length !== 3) throw new Error('dumpresource: ' + usage);
  const [where, when, what] = words;
  const coords = where.match(/^(\d+),(\d+)$/);
  const read = (s, name) => {
    try { return W.parseResources(s); } catch (e) { throw new Error(`dumpresource: the ${name} — ${e.message}`); }
  };
  const condition = read(when, 'amounts to wait for');
  const resources = read(what, 'amounts to send');
  if (!Object.values(resources).some((v) => v > 0)) throw new Error('dumpresource: nothing to send — ' + usage);
  return {
    cmd: 'dumpresource',
    target: coords ? { x: +coords[1], y: +coords[2] } : null,
    targetCity: coords ? null : where.replace(/^!/, ''),       // !OtherCity, as the goals write a city
    condition, resources,
  };
}

async function runDump(a, env) {
  const g = env.game, castle = env.castle;
  const r = castle.resource || {};
  const have = (k) => (k === 'gold' ? num(r.gold) : num(r[k] && typeof r[k] === 'object' ? r[k].amount : r[k]));
  const text = (o) => Object.entries(o).map(([k, v]) => `${amt(v)} ${k}`).join(', ');
  const short = Object.entries(a.condition).filter(([k, v]) => have(k) < v);
  if (short.length) {
    const why = short.map(([k, v]) => `${k} ${amt(have(k))} of ${amt(v)}`).join(', ');
    env.log(`  not yet — ${why}; nothing sent`);
    return { ok: false, error: `not yet: ${why}`, result: 0 };
  }
  const lack = Object.entries(a.resources).filter(([k, v]) => have(k) < v);
  if (lack.length) {
    throw new Error(`${castle.name} holds ${lack.map(([k, v]) => `${amt(have(k))} ${k}, not ${amt(v)}`).join('; ')} — it cannot send that`);
  }
  // The march is the transport command's (script-cmd-deploy.js): target, the
  // hold check, dry run, newArmy. Here: how many transporters the load needs.
  const D = require('./script-cmd-deploy');
  const total = Object.values(a.resources).reduce((s, v) => s + v, 0);
  const toCity = a.targetCity ? D.ownCity(g, a.targetCity) : null;
  const from = g.castleXY(castle), to = toCity ? g.castleXY(toCity) : a.target;
  // NewArmyWin: hold = load x count x (1 + loadSkillParam/100) (:2853), less
  // foodRequest x 2 an hour of march food carried in it (carryResouce:3415) —
  // the same sums transport.run checks, with the city's troop params. Without
  // them: base load, which can only ask for more transporters, never too few.
  let p = { known: false };
  try { if (typeof D.paramsFor === 'function') p = await D.paramsFor(g, castle); } catch { /* base load */ }
  const known = !!p.known && Number.isFinite(Number(p.loadSkill));
  const ls = known ? Number(p.loadSkill) : 0;
  const ms = known && from && to ? (C.marchTimeMs(from, to, ['carriage'], {
    marchSkill: p.marchSkill, driveSkill: p.driveSkill, relief: Number(p.relief) > 1 ? p.relief : 0,
    castleBuffs: castle.buffs, playerBuffs: g.player && g.player.buffs, now: g.now(),
  }) || 0) : 0;
  const T = C.BY_KEY.carriage;
  const room = (n) => n * T.load * (1 + ls / 100) - Math.floor(n * T.food * 2 * ms / 3600000);
  const each = T.load * (1 + ls / 100) - T.food * 2 * ms / 3600000;
  if (!(each > 0)) throw new Error(`a transporter eats more food on the way to ${to ? `${to.x},${to.y}` : 'there'} than it carries — too far to send by transporter`);
  let need = Math.max(1, Math.ceil(total / each));
  while (room(need) < total) need++;
  const got = num((castle.troop || {}).carriage);
  if (got < need) {
    throw new Error(`carrying ${amt(total)} takes ${amt(need)} transporters (${amt(Math.floor(each))} each${ms ? ' after march food' : ''}), and ${castle.name} has ${amt(got)}`);
  }
  const where = a.target ? `${a.target.x},${a.target.y}` : `"${a.targetCity}"`;
  const resText = Object.entries(a.resources).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(',');
  const line = `transport ${where} t:${need} ${resText}`;
  env.log(`  ${text(a.condition)} reached — sending ${text(a.resources)}: ${line}`);
  const action = D.parseMarch('transport', line, line.split(/\s+/));
  const res = (await D.commands.transport.run({ ...action, line: a.line, raw: a.raw }, env)) || {};
  const sent = !env.dryRun && !env.refused() && res.ok !== false;
  return { ...res, result: sent ? total : 0 };
}

// ------------------------------------------------------------------ commands

const trade = (word) => ({
  usage: `${word} <food|wood|stone|iron|0-3> <amount> <price>   (or @price)`,
  parse: (args, { tok }) => parseTrade(word, tok),
  run: runTrade,
});

const commands = {
  buy: trade('buy'),
  sell: trade('sell'),

  canceltrade: {
    usage: 'canceltrade [tradeId ... | buy | sell | food | wood | stone | iron]',
    parse: (args, { tok }) => parseCancel(tok),
    run: runCancel,
  },

  marketupdate: {
    usage: 'marketupdate <0-3 | food | wood | stone | iron>   (none or all: all four)',
    parse(args, { tok }) {
      const w = tok.slice(1).filter(Boolean);
      if (!w.length || (w.length === 1 && w[0].toLowerCase() === 'all')) return { cmd: 'marketupdate', resources: RESOURCES.slice() };
      if (w.length > 1) throw new Error('marketupdate: one resource — marketupdate 0, marketupdate wood — or none for all four');
      return { cmd: 'marketupdate', resources: [tradeRes(w[0], 'marketupdate')] };
    },
    async run(a, env) {
      let bad = 0;
      for (const res of a.resources) {
        try {
          const b = await readBook(env.game, res);
          env.log(`  ${res}: ${bookText(b)}`);
        } catch (e) {
          bad++;
          env.log(`  ${res}: FAILED - ${e.message}`);
        }
      }
      return bad ? { ok: false, error: `${bad} of ${a.resources.length} market read(s) failed` } : {};
    },
  },

  dumpresource: {
    usage: 'dumpresource <x,y | city> <when> <send>   e.g. dumpresource 111,222 f:11000,g:44000 f:3000,g:9000',
    parse: (args, { line }) => parseDump(line),
    run: runDump,
  },

  // Starts a background market sniper and returns at once; see holiday-snipe.js.
  // It needs the console's session, not just this run's game: it outlives
  // the run, follows reconnects, and writes to the Log tab.
  holidaysnipe: {
    usage: 'holidaysnipe [dry] | holidaysnipe stop | holidaysnipe status',
    parse: (args, { tok }) => ({ cmd: 'holidaysnipe', ...require('./holiday-snipe').parseArgs(tok.slice(1)) }),
    async run(a, env) {
      const HS = require('./holiday-snipe');
      if (env.dryRun && a.action === 'stop') {
        // a dry run changes nothing: the sniper (and its saved run) are left as they are
        const st = await HS.command({ action: 'status', opts: {} }, { session: env.session });
        for (const l of st) env.log('  ' + l);
        env.log(`  [dry run] would stop it${/not running here, but a run is saved/.test(st.join(' ')) ? ' (and forget the saved run)' : ''} — left as it is`);
        return {};
      }
      const lines = await HS.command(a, { session: env.session, dryRun: env.dryRun });
      for (const l of lines) env.log('  ' + l);
      return { done: 1 };
    },
  },
};

function functions(ctx) {
  const m = market(ctx);
  return {
    BuyPrice: m.buyPrice,
    SellPrice: m.sellPrice,
    Price: m.price,
    MAX_TRADE,
    ResourceIntNames: Object.freeze(RESOURCES.slice()),
  };
}

module.exports = {
  commands, functions, readOnly: ['ResourceIntNames'],
  market, tradeBean, transingTradeBean,
  // for tests and other modules
  fitPrice, walk, parseTrade, MAX_TRADE, MAX_PRICE, RESOURCES,
};
