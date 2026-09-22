'use strict';
// Holiday-dump sniper, and the seller that turns what it buys back into gold.
// A script command, not a goal — nothing happens until a loadout runs it. Then
// it runs until "holidaysnipe stop", and a console restart does not end it: the
// console picks it up again when it comes back (resume, called from server.js).
//
//   holidaysnipe                  buy dumps and sell at 10+, with the defaults
//   holidaysnipe dry              watch, and say what it would do
//   holidaysnipe clear            start by cancelling the cities' own cheap buy
//                                 offers (at or under max), which fill the slots
//   holidaysnipe status           what it is doing
//   holidaysnipe stop             stop: its buy offers are cancelled, its sell
//                                 offers stay listed
//
//   holidaysnipe under:1 max:0.11 amount:99m orders:10 floor:1b sellat:10 keep:1b list:1 scan:1
//
// Why: an account in holiday mode can sell hundreds of billions of a resource
// for next to nothing through the day and is reset at the next maintenance —
// whoever bought it keeps it. So when food, wood, stone or iron is offered
// under 1 gold, every city with gold over the 1b floor bids a hair over the
// best ask — 0.001 -> 0.002, 0.01 -> 0.02, 0.1 -> 0.11, and never more than
// 0.11 — ten 99m orders each, all cities at once, and ten more while they fill.
//
// Then the other half: selling at the normal price. Whenever a buyer bids 10 or
// more, the cities sell into that bid whatever they hold over 1b of each
// resource. While nobody bids that much but sellers ask 10 or more, each city
// keeps one offer listed a hair under the cheapest of them (never under 10), so
// the next buyer takes ours first. The gold that brings in is the stockpile.
//
// It runs inside the console on the console's own session — a second login
// would kick it. What it does goes to the Log tab.
const C = require('./constants');

const RESOURCES = ['food', 'wood', 'stone', 'iron'];
const RES_NAME = { 0: 'food', 1: 'wood', 2: 'stone', 3: 'iron' };
const MAX_OFFERS = 10;          // open offers per city at a level 10 Marketplace; one more is refused with -38
const MAX_AMOUNT = 99999999;    // NewTradeWin: the amount box takes 8 digits
const MAX_PRICE = 150;          // NewTradeWin.onPriceChange caps the price there
const MAX_COOLDOWN = 600000;    // the longest a resource is left alone after empty rounds
const MIN_SELL = 1_000_000;     // a smaller lot is not worth a market slot
const QUIET_MS = 600000;        // a "nothing to do about it" line is said at most this often
const BUY = C.TRADE_TYPE.buy;
const SELL = C.TRADE_TYPE.sell;
const FEE = C.TRADE_COMMISSION;
const STATE_KEY = 'holidaysnipe:';   // + account id: the run a console restart picks up again

const DEFAULTS = {
  under: 1,               // a best ask strictly below this is a dump
  max: 0.11,              // never bid more than this, however the dump is priced
  step: 0,                // 0: by the size of the ask (bidFor); or a fixed amount over it
  amount: 99_000_000,     // per order, buying and selling
  orders: 10,             // buy orders per city, per round
  floor: 1_000_000_000,   // buying never takes a city's gold below this
  sellAt: 10,             // sell when a buyer bids this or more; 0 = never sell
  keep: 1_000_000_000,    // what each city keeps of each resource, whatever the price
  list: 1,                // sell offers a city leaves listed while nobody bids sellAt
  scanMs: 1000,           // pause between full scans while nothing is cheap
  settleMs: 1000,         // after a round, time for the fills to be pushed to us
  cooldownMs: 30000,      // after a round where nothing filled, leave that resource this long —
                          // twice as long each time it happens again, up to MAX_COOLDOWN
  retryMs: 10000,         // after a failed read; six times this if the server is ignoring us
  rounds: 0,              // most rounds per dump; 0 = for as long as they fill
  dry: false,             // read the market, place nothing
  once: false,            // stop after the first dump — for testing
  clear: false,           // at the start, cancel the cities' own buy offers at or under max
};

const USAGE = 'usage: holidaysnipe [stop|status] [dry] [clear] [under:1] [max:0.11] [step:auto] [amount:99m] '
  + '[orders:10] [floor:1b] [sellat:10] [keep:1b] [list:1] [scan:1] [settle:1] [cooldown:30] [rounds:0]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 990m, 3.91b — log lines are read at a glance.
function fmt(n) {
  const v = Number(n) || 0, a = Math.abs(v);
  if (a >= 1e9) return +(v / 1e9).toFixed(2) + 'b';
  if (a >= 1e6) return +(v / 1e6).toFixed(1) + 'm';
  if (a >= 1e3) return +(v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v * 1000) / 1000);
}

// "99m", "1.5b", "0.01", "10"
function numberOf(s) {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?|\.\d+)([kmb])?$/i);
  if (!m) return NaN;
  return parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1);
}

function parseArgs(tokens) {
  let action = 'start';
  const opts = {};
  for (const raw of tokens) {
    const t = String(raw).toLowerCase();
    if (t === 'start' || t === 'stop' || t === 'status') { action = t; continue; }
    if (t === 'dry' || t === 'once' || t === 'clear') { opts[t] = true; continue; }
    const m = t.match(/^([a-z]+):(.+)$/);
    if (!m) throw new Error(`holidaysnipe: unexpected "${raw}" — ${USAGE}`);
    if (m[1] === 'step' && m[2] === 'auto') { opts.step = 0; continue; }
    const n = numberOf(m[2]);
    if (!Number.isFinite(n)) throw new Error(`holidaysnipe: ${m[1]} needs a number, got "${m[2]}"`);
    switch (m[1]) {
      case 'under': opts.under = n; break;
      case 'max': opts.max = n; break;
      case 'step': opts.step = n; break;
      case 'amount': opts.amount = Math.round(n); break;
      case 'orders': opts.orders = Math.round(n); break;
      case 'floor': opts.floor = Math.round(n); break;
      case 'sellat': opts.sellAt = n; break;
      case 'keep': opts.keep = Math.round(n); break;
      case 'list': opts.list = Math.round(n); break;
      case 'scan': opts.scanMs = Math.round(n * 1000); break;          // seconds
      case 'settle': opts.settleMs = Math.round(n * 1000); break;
      case 'cooldown': opts.cooldownMs = Math.round(n * 1000); break;
      case 'rounds': opts.rounds = Math.round(n); break;
      default: throw new Error(`holidaysnipe: unknown setting "${m[1]}" — ${USAGE}`);
    }
  }
  const o = { ...DEFAULTS, ...opts };
  if (o.amount < 1 || o.amount > MAX_AMOUNT) throw new Error(`holidaysnipe: amount must be 1 to ${MAX_AMOUNT} (the market's limit per order)`);
  if (o.orders < 1 || o.orders > MAX_OFFERS) throw new Error(`holidaysnipe: orders must be 1 to ${MAX_OFFERS} (a city holds at most ${MAX_OFFERS} offers)`);
  if (!(o.under > 0)) throw new Error('holidaysnipe: under must be over 0');
  if (!(o.max > 0) || o.max > MAX_PRICE) throw new Error(`holidaysnipe: max must be over 0 and at most ${MAX_PRICE}`);
  if (o.sellAt && (o.sellAt <= o.max || o.sellAt > MAX_PRICE)) {
    throw new Error(`holidaysnipe: sellat must be over the ${o.max} max bid and at most ${MAX_PRICE} (sellat:0 turns selling off)`);
  }
  if (o.list < 0 || o.list > MAX_OFFERS) throw new Error(`holidaysnipe: list must be 0 to ${MAX_OFFERS}`);
  if (o.scanMs < 250) throw new Error('holidaysnipe: scan must be at least 0.25 seconds — faster only gets the account ignored');
  return { action, opts };
}

// A price the way the market's price box takes it: at most 5 characters
// (NewTradeWin), as many decimals as fit, rounded the safe way — up for a bid,
// so it never lands under the ask; down for a sell, so it never lands over
// the bid it is meant to meet.
function priceText(p, dir) {
  const round = dir === 'up' ? (x) => Math.ceil(x - 1e-7) : (x) => Math.floor(x + 1e-7);
  for (const d of [3, 2, 1, 0]) {
    const f = 10 ** d;
    const s = String(Number((round(p * f) / f).toFixed(d)));
    if (s.length <= 5) return s;
  }
  return String(round(p));
}

// Our bid on a dump: a hair over the best ask, the hair sized to the ask —
// 0.001 -> 0.002, 0.01 -> 0.02, 0.1 -> 0.11 — and never over max. An ask just
// under max is bid at max itself; one over it is not bid at all (null).
function bidFor(ask, { step = DEFAULTS.step, max = DEFAULTS.max } = {}) {
  const a = Number(ask);
  if (!(a > 0) || a > max + 1e-9) return null;
  const want = Math.min(a + (step > 0 ? step : a < 0.01 ? 0.001 : 0.01), max);
  return priceText(want, 'up');
}

// Selling into a buyer: at their own bid, rounded down to fit the box.
const sellPriceFor = (bid) => priceText(Number(bid), 'down');

// Listing while nobody bids sellAt: a hair under the cheapest other seller, so
// ours is the one the next buyer takes, but never under sellAt.
function listPriceFor(ask, sellAt) {
  const s = priceText(Math.max(Number(sellAt), Number(ask) - 0.01), 'down');
  return Number(s) < sellAt ? priceText(sellAt, 'up') : s;
}

// How many orders a city places this round: what was asked for, no more than
// its free offer slots, and never so many that its gold would drop under the
// floor. A buy takes price x amount plus the 0.5% commission when it is placed
// (NewTradeWin.calcCommission: gold >= total + commission).
function ordersFor({ gold, openOffers = 0, cap = MAX_OFFERS }, { orders, amount, floor }, price) {
  const cost = amount * Number(price) * (1 + FEE);
  const slots = Math.max(0, cap - openOffers);
  const affordable = cost > 0 ? Math.max(0, Math.floor((gold - floor) / cost)) : 0;
  return { n: Math.min(orders, slots, affordable), cost, slots, affordable };
}

const samePrice = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;

// Send them all at once and collect the replies in the order they were sent.
// A CommandResponse carries no id, so order is the only way to tell whose reply
// is whose — the caller holds the command's lane, so nobody else's is mixed in.
// A batch of market WRITES, one reply per request in the same order, null where
// none came. They go through the game's pipe (game.js pipe) whenever it has one:
// every trade.newTrade / trade.cancelTrade sender must, or a raw listener here and
// the pipe would each take replies meant for the other. burst() below is the old
// way, kept for a Game without a pipe.
async function writeBatch(g, cmd, list) {
  const t = 15000 + list.length * 200;
  if (typeof g.pipeMany === 'function') {
    const r = await g.pipeMany(cmd, list, t);
    return r.map((x) => (x && x.ok === 'noreply' ? null : x));
  }
  const r = await g.lane(cmd, () => burst(g, cmd, list, t));
  return list.map((_, i) => (i < r.length ? r[i] : null));
}

function burst(g, cmd, payloads, timeoutMs) {
  return new Promise((resolve) => {
    const replies = [];
    if (!payloads.length) return resolve(replies);
    let timer = null;
    const finish = () => { clearTimeout(timer); g.c.off('cmd', onCmd); resolve(replies); };
    const onCmd = (name, data) => {
      if (name !== cmd) return;
      replies.push(data || {});
      if (replies.length >= payloads.length) finish();
    };
    g.c.on('cmd', onCmd);
    timer = setTimeout(finish, timeoutMs);
    try { for (const p of payloads) g.c.send(cmd, p); } catch { finish(); }
  });
}

// Where a run is kept so a console restart can pick it up again: the account's
// own settings, one row per account.
function storeFor(session) {
  const acct = session && session.account && session.account.id;
  const s = acct && typeof session.settings === 'function' ? session.settings() : null;
  return {
    load: () => { try { return s ? s.get(STATE_KEY + acct, null) : null; } catch { return null; } },
    save: (v) => { try { if (s) s.set(STATE_KEY + acct, v); } catch {} },
  };
}

class Sniper {
  constructor(session, opts = {}, { store = null, saved = null } = {}) {
    this.session = session;
    this.given = { ...opts };       // what was asked for; a restart re-reads the defaults
    this.o = { ...DEFAULTS, ...opts };
    this.running = false;
    this.accountId = session.account ? session.account.id : null;
    this.store = store || storeFor(session);
    this.saved = saved;             // what a restart left behind, when this is the pick-up
    this.resumed = false;
    this.ready = false;             // setup() done
    this.books = {};                // resource -> { asks, bids } from the last read
    this.asksAt = 0;
    this.cool = {};                 // resource -> no new buy round before this time
    this.buying = new Set();        // resources a dump is being bought of right now (claims)
    this.misses = {};               // resource -> buy rounds in a row where nothing filled
    this.sellCool = {};             // resource -> no selling into buyers before this time
    this.sellMisses = {};
    this.listCool = new Map();      // castleId -> no new listing before this time (after a refusal)
    this.est = new Map();           // castleId -> { at, gold, res } our own sums after a burst
    this.pushedAt = new Map();      // castleId -> when the server last pushed its resources
    this.sidelined = new Map();     // castleId -> why it sat out (said once, not every round)
    this.cap = new Map();           // castleId -> offers its Marketplace allows, once a refusal has said
    this.used = {};                 // resource -> Set of bids we have placed
    this.preexisting = new Set();   // `${castleId}:${tradeId}` open before we started
    this.cancelled = new Set();     // offers we have already cancelled
    this.listings = new Map();      // `${castleId}:${tradeId}` -> our sell offer on the book
    this.recentSells = [];          // sells placed lately, so one pushed after its round is still known
    this.quiet = new Map();         // line key -> when it was last said
    this.startGold = {};            // castleId -> gold when the run began, for status
    this.stats = { since: 0, scans: 0, dumps: 0, rounds: 0, orders: 0, refused: 0,
      bought: {}, spent: 0, fees: 0, sold: {}, earned: 0, sellFees: 0 };
    this.done = Promise.resolve();
    if (saved) {
      Object.assign(this.stats, saved.stats || {}, { scans: 0 });
      this.stats.since = saved.since || Date.now();
      this.startGold = { ...(saved.startGold || {}) };
    }
  }

  say(m, city = null, kind = 'act') { this.session.note('holidaysnipe: ' + m, { city, kind }); }

  // For lines that would otherwise repeat every scan: once per QUIET_MS a key.
  quietly(key, m, city = null, kind = 'act') {
    if (Date.now() - (this.quiet.get(key) || 0) < QUIET_MS) return;
    this.quiet.set(key, Date.now());
    this.say(m, city, kind);
  }

  // The live game, or null while the console reconnects or sits out maintenance.
  // A reconnect is a new Game, so this is read fresh every time, never kept.
  get game() {
    const s = this.session;
    if (!s.connected || !s.game) return null;
    if (this.watched !== s.game) this.watch(s.game);
    return s.game;
  }

  watch(g) {
    this.unwatch();
    this.watched = g;
    this._onCmd = (cmd, data) => {
      if (cmd === 'server.ResourceUpdate' && data) this.pushedAt.set(data.castleId, Date.now());
    };
    g.c.on('cmd', this._onCmd);
  }

  unwatch() {
    if (this.watched && this._onCmd) this.watched.c.off('cmd', this._onCmd);
    this.watched = null;
  }

  // Our own sums after a burst, until the server's push catches up with them.
  // A later burst before that push builds on them rather than on the push.
  estimate(g, c, { gold, res = {} }) {
    const cid = g.castleId(c), prev = this.est.get(cid);
    const live = prev && !((this.pushedAt.get(cid) || 0) > prev.at) ? prev : null;
    this.est.set(cid, { at: Date.now(), gold: gold ?? (live ? live.gold : undefined), res: { ...(live ? live.res : {}), ...res } });
  }

  ahead(g, c) {
    const cid = g.castleId(c), e = this.est.get(cid);
    return e && !((this.pushedAt.get(cid) || 0) > e.at) ? e : null;
  }

  // Gold as far as we can tell. The push comes a little after the orders that
  // caused it; until it lands, go by our own sums, so a late push can never make
  // a city look richer than it is and walk it under the floor.
  goldOf(g, c) {
    const pushed = Number((c.resource && c.resource.gold) || 0);
    const e = this.ahead(g, c);
    return e && e.gold !== undefined ? Math.min(pushed, e.gold) : pushed;
  }

  // The same for a resource: never sell the same food twice.
  resOf(g, c, res) {
    const r = c.resource && c.resource[res];
    const pushed = Number((r && r.amount) || 0);
    const e = this.ahead(g, c);
    return e && e.res[res] !== undefined ? Math.min(pushed, e.res[res]) : pushed;
  }

  capOf(cid) { return this.cap.get(cid) || MAX_OFFERS; }

  // "10 offers are allowed at level 10 Marketplace." — a smaller Marketplace
  // allows fewer, and the refusal is the only place that says how many.
  learnCap(cid, msg) {
    const m = String(msg || '').match(/(\d+) offers are allowed/i);
    if (m) this.cap.set(cid, Number(m[1]));
  }

  listingsIn(cid) { let n = 0; for (const l of this.listings.values()) if (l.cid === cid) n++; return n; }

  isOurs(g, c, t, res) {
    return Number(t.tradeType) === BUY
      && Number(t.resType) === C.TRADE_RES[res]
      && Number(t.amount) === this.o.amount
      && !this.preexisting.has(`${g.castleId(c)}:${t.id}`)
      && [...(this.used[res] || [])].some((b) => samePrice(t.price, b));
  }

  plan() {
    const o = this.o;
    const buy = `anything under ${o.under} is bid a hair over the ask, never over ${o.max}; `
      + `${o.orders} x ${fmt(o.amount)} per city, never below ${fmt(o.floor)} gold`;
    if (!o.sellAt) return buy + '; selling off';
    return `${buy}; sells into any buyer at ${o.sellAt}+, keeping ${fmt(o.keep)} of each`
      + (o.list ? `, and lists ${o.list} offer(s) per city while nobody bids that` : '');
  }

  start({ resumed = false } = {}) {
    const o = this.o;
    this.resumed = resumed;
    const mode = o.dry ? ' (DRY RUN — it will not place anything)' : '';
    let lines = [];
    if (!resumed) {
      const g = this.game;
      if (!g) return ['holidaysnipe: not connected — run it again once the console is online'];
      const rich = g.castles.filter((c) => this.goldOf(g, c) > o.floor);
      const golds = g.castles.map((c) => `${c.name} ${fmt(this.goldOf(g, c))}`).join(', ');
      if (!rich.length && !o.sellAt) {
        this.unwatch();
        return [`holidaysnipe: not started — no city has more than ${fmt(o.floor)} gold, and that is what it needs before it will trade`,
          `  gold: ${golds}`];
      }
      const full = g.castles.filter((c) => (c.trades || []).length >= this.capOf(g.castleId(c)));
      lines = [
        `holidaysnipe: started${mode}`,
        `  buying: food, wood, stone or iron offered under ${o.under} is bid a hair over the ask`
          + (o.step ? ` (+${o.step})` : ' (0.001 -> 0.002, 0.01 -> 0.02, 0.1 -> 0.11)') + `, never over ${o.max}`,
        `  ${o.orders} x ${fmt(o.amount)} per city per round, all cities at once, and ${o.orders} more for as long as they fill`,
        rich.length
          ? `  a city never goes below ${fmt(o.floor)} gold — ${rich.length} of ${g.castles.length} are over it now: `
            + rich.map((c) => `${c.name} ${fmt(this.goldOf(g, c))}`).join(', ')
          : `  no city has more than ${fmt(o.floor)} gold, so it will not buy until one does — gold: ${golds}`,
        o.sellAt
          ? `  selling: when a buyer bids ${o.sellAt} or more, cities sell into it what they hold over ${fmt(o.keep)} of each resource`
            + (o.list ? `; while nobody does but sellers ask ${o.sellAt}+, each city keeps ${o.list} offer(s) listed just under the cheapest of them` : '')
          : '  selling: off',
      ];
      if (full.length && !o.clear) {
        lines.push(`  ${full.length === 1 ? '1 city has' : `${full.length} cities have`} every market slot taken by offers it already had `
          + `(${full.map((c) => `${c.name} ${(c.trades || []).length}`).join(', ')}) — nothing can be placed there until some go; `
          + '"holidaysnipe clear" cancels their cheap buy offers first');
      }
      lines.push('  it keeps running after this script ends, and after a console restart; its lines go to the Log tab. "holidaysnipe stop" stops it.');
    }
    this.running = true;
    if (!this.stats.since) this.stats.since = Date.now();
    this.persist();
    this.say(resumed ? `picked up again after a console restart — ${this.plan()}` : `started${mode} — ${this.plan()}`, null, 'sys');
    this.done = this.loop()
      .catch((e) => this.say('stopped on an error — ' + e.message, null, 'sys'))
      .finally(() => { this.running = false; this.unwatch(); });
    return lines;
  }

  stop() {
    this.running = false;
    if (this._wake) this._wake();
  }

  // What a restart needs to carry on: the settings, the totals, and which sell
  // offers on the book are ours. A dry run or a test run is not carried on.
  persist() {
    if (this.forgotten || this.o.dry || this.o.once) return;
    const { dry, once, clear, ...opts } = this.given;
    this.store.save({ v: 1, opts, since: this.stats.since, stats: this.stats, startGold: this.startGold,
      listings: [...this.listings.values()], savedAt: Date.now() });
  }

  forget() { this.forgotten = true; this.store.save(null); }

  // A sleep that stop() cuts short.
  nap(ms) {
    return new Promise((r) => {
      const t = setTimeout(r, ms);
      this._wake = () => { clearTimeout(t); r(); };
    });
  }

  async loop() {
    let lastBeat = Date.now();
    while (this.running) {
      if ((this.session.account ? this.session.account.id : null) !== this.accountId) {
        this.say('the console switched account — stopping', null, 'sys');
        break;
      }
      const g = this.game;
      if (!g) { await this.nap(2000); continue; }       // reconnecting, or maintenance
      try {
        if (!this.ready) await this.setup(g);
        // Anything of ours still on the book goes before anything new is placed:
        // an offer pushed after its round was counted, or a round a dropped
        // socket cut short. Reading the book is local, so this costs nothing
        // unless there is something to cancel.
        if (!this.o.dry) for (const res of RESOURCES) await this.sweep(g, res);
        await this.trackListings(g);

        for (const res of RESOURCES) { if (this.running) await this.book(g, res); }
        if (!this.stats.scans++) this.say('first look — ' + this.marketText(), null, 'sys');

        const dumps = await this.buySide(g);
        if (dumps && this.o.once) { this.say('done (once) — stopping', null, 'sys'); break; }
        if (this.o.sellAt && this.running) await this.sellSide(g);

        if (!g.castles.some((c) => this.goldOf(g, c) > this.o.floor)) {
          if (!this.o.sellAt) {
            this.say(`every city is down to the ${fmt(this.o.floor)} gold floor — stopping`, null, 'sys');
            break;
          }
          this.quietly('floor', `every city is at or under the ${fmt(this.o.floor)} gold floor — not buying until one is over it again; still selling`, null, 'sys');
        }
        if (Date.now() - lastBeat > 300000) {
          lastBeat = Date.now();
          this.say(`watching — ${this.marketText()} · ${this.stats.scans} scans`, null, 'plan');
          this.persist();
        }
      } catch (e) {
        const ignored = g.c && g.c.missedReplies >= 3;
        const wait = ignored ? this.o.retryMs * 6 : this.o.retryMs;
        this.say(`${e.message} — ${ignored ? 'the server is ignoring us, backing off' : 'trying again'} in ${Math.round(wait / 1000)}s`, null, 'sys');
        await this.nap(wait);
        continue;
      }
      await this.nap(this.o.scanMs);
    }
    // On the way out, whatever the last round left behind. Our sell offers stay
    // listed: they are at a price we want, and a cancel would lose the fee.
    const g = this.game;
    if (g && !this.o.dry) {
      await sleep(this.o.settleMs);
      for (const res of RESOURCES) await this.sweep(g, res).catch(() => {});
    }
    this.persist();
  }

  // Once a run, at the first look at a connected game: which offers were there
  // already (never touched), and what a restart left behind.
  async setup(g) {
    const o = this.o;
    const saved = new Map(((this.saved && this.saved.listings) || []).map((l) => [`${l.cid}:${l.id}`, l]));
    const leftovers = [], clears = [];
    let clearFees = 0, dryClears = 0;
    for (const c of g.castles) {
      const cid = g.castleId(c);
      if (this.startGold[cid] === undefined) this.startGold[cid] = this.goldOf(g, c);
      for (const t of c.trades || []) {
        const key = `${cid}:${t.id}`, type = Number(t.tradeType), price = Number(t.price);
        if (type === SELL && saved.has(key)) {
          this.listings.set(key, { ...saved.get(key), dealt: Number(t.dealedAmount || 0) });
        } else if (this.resumed && type === BUY && Number(t.amount) === o.amount && price <= o.max + 1e-9) {
          leftovers.push({ castleId: cid, tradeId: t.id });    // ours: the restart cut its round short
        } else if (o.clear && type === BUY && price <= o.max + 1e-9 && !o.dry) {
          clears.push({ castleId: cid, tradeId: t.id });
          clearFees += Math.max(0, Number(t.amount) - Number(t.dealedAmount || 0)) * price * FEE;
        } else {
          if (o.clear && type === BUY && price <= o.max + 1e-9) dryClears++;
          this.preexisting.add(key);
        }
      }
    }
    // Listed before the restart and gone now: bought while the console was down.
    for (const [key, l] of saved) if (!this.listings.has(key)) this.closed(g, l, ' while the console was down');
    if (leftovers.length) {
      const n = await this.cancel(g, leftovers);
      this.say(`cancelled ${n} of ${leftovers.length} buy offer(s) of its own that the restart left on the book`);
    }
    if (clears.length) {
      const n = await this.cancel(g, clears);
      this.say(`clear: cancelled ${n} of ${clears.length} cheap buy offer(s) the cities already had, freeing their market slots `
        + `(about ${fmt(clearFees)} gold of fees on them is not refunded)`, null, 'sys');
    }
    if (dryClears) this.say(`[dry run] clear would cancel ${dryClears} cheap buy offer(s) the cities already have`);
    this.ready = true;
    this.persist();
  }

  // One read of a resource's market: the cheapest sellers and the dearest
  // buyers. Our own offers are in there too — the book does not say whose is
  // whose — so a caller that cares takes them out (othersOnly).
  async book(g, res) {
    const d = await g.searchTrades(res);
    const levels = (xs) => (xs || []).map((x) => ({ price: Number(x.price), amount: Number(x.amount) }))
      .filter((x) => x.amount > 0 && x.price > 0);
    const b = {
      asks: levels(d && d.sellers).sort((x, y) => x.price - y.price),
      bids: levels(d && d.buyers).sort((x, y) => y.price - x.price),
    };
    this.books[res] = b;
    this.asksAt = Date.now();
    return b;
  }

  async bestAsk(g, res) {
    const b = await this.book(g, res);
    return b.asks.length ? b.asks[0].price : null;
  }

  // The book without our own offers: every city's, including ones it had
  // before we started — selling into our own bid only pays the fee twice.
  othersOnly(g, levels, type, res) {
    const mine = new Map();
    for (const c of g.castles) {
      for (const t of c.trades || []) {
        if (Number(t.tradeType) !== type || Number(t.resType) !== C.TRADE_RES[res]) continue;
        const k = Number(t.price).toFixed(3);
        mine.set(k, (mine.get(k) || 0) + Math.max(0, Number(t.amount) - Number(t.dealedAmount || 0)));
      }
    }
    return levels.map((l) => ({ ...l, amount: l.amount - (mine.get(l.price.toFixed(3)) || 0) })).filter((l) => l.amount > 0);
  }

  marketText() {
    const px = (side) => RESOURCES.map((r) => {
      const l = this.books[r] && this.books[r][side][0];
      return `${r} ${l ? +l.price.toFixed(3) : '—'}`;
    }).join(' · ');
    return `asks ${px('asks')} | bids ${px('bids')}`;
  }

  // ---- buying ----

  async buySide(g) {
    const o = this.o, hot = [];
    for (const res of RESOURCES) {
      const b = this.books[res];
      const ask = b && b.asks.length ? b.asks[0].price : null;
      if (ask === null || !(ask < o.under) || (this.cool[res] || 0) > Date.now()) continue;
      if (bidFor(ask, o) === null) {
        this.quietly(`dear:${res}`, `${res} is offered at ${ask} — under ${o.under}, but over the ${o.max} most it pays; leaving it`);
        continue;
      }
      hot.push({ res, ask });
    }
    // Cheapest first: that is where the gold buys the most.
    hot.sort((a, b) => a.ask - b.ask);
    for (const h of hot) { if (this.running) await this.dump(g, h.res, h.ask); }
    return hot.length;
  }

  // One resource offered under the trigger: bid in every city that can, and bid
  // again at the fresh price for as long as the orders go through.
  async dump(g, res, ask) {
    const o = this.o;
    this.stats.dumps++;
    this.say(`${res.toUpperCase()} is being sold at ${ask} — under ${o.under}. ${o.dry ? 'Dry run, placing nothing.' : `Buying at ${bidFor(ask, o)}.`}`);
    let price = ask, rounds = 0, bought = 0, spent = 0;
    this.buying.add(res);
    try {
      while (this.running) {
        const bid = bidFor(price, o);
        if (bid === null) { this.say(`${res} is at ${price} now, over the ${o.max} most it pays — done`); break; }
        (this.used[res] = this.used[res] || new Set()).add(bid);
        const r = await this.round(g, res, bid);
        const cost = r.filled * Number(bid) * (1 + FEE);
        rounds++;
        bought += r.filled;
        spent += cost;
        // Per round, not per dump: a big dump runs for minutes, and status
        // should say what is in hand while it does.
        this.stats.bought[res] = (this.stats.bought[res] || 0) + r.filled;
        this.stats.spent += cost;
        this.stats.fees += r.lostFees;
        if (!r.placed) {
          // Nobody could bid, or every order was refused.
          this.cool[res] = Date.now() + o.cooldownMs;
          break;
        }
        if (!r.filled) {
          // Nothing filled: someone else got there first, or that price cannot
          // be bought. A cancel keeps the 0.5% fee (seen live: a 1 @ 1 bid
          // cost 1.005 and got 1.000 back), so every empty round costs gold —
          // back off twice as long each time, until something fills again.
          const misses = this.misses[res] = (this.misses[res] || 0) + 1;
          const wait = Math.min(o.cooldownMs * 2 ** (misses - 1), MAX_COOLDOWN);
          this.cool[res] = Date.now() + wait;
          this.say(`nothing filled at ${bid} — someone got there first. The fee on the cancelled orders, `
            + `about ${fmt(r.lostFees)} gold, is not refunded. Leaving ${res} for ${Math.round(wait / 1000)}s.`);
          break;
        }
        this.misses[res] = 0;
        if (o.rounds && rounds >= o.rounds) { this.say(`${rounds} round(s), as asked — done with ${res}`); break; }
        // They went through: look again, and go again while it is still cheap.
        const next = await this.bestAsk(g, res);
        if (next === null || next >= o.under) { this.say(`${res} is back at ${next ?? 'no offers'} — done`); break; }
        price = next;
      }
    } finally {
      if (!o.dry) { await sleep(o.settleMs); await this.sweep(g, res).catch(() => {}); }
      this.buying.delete(res);
    }
    if (!o.dry) {
      this.say(`${res.toUpperCase()} — bought ${fmt(bought)} in ${rounds} round(s), about ${fmt(spent)} gold`
        + ` (${this.summary()})`, null, 'act');
      this.persist();
    }
  }

  // One round: every city that can places its orders at once, then we look at
  // what went through and cancel what did not.
  async round(g, res, bid) {
    const o = this.o, price = Number(bid);
    const cities = [];
    for (const c of g.castles) {
      const cid = g.castleId(c);
      const gold = this.goldOf(g, c);
      const p = ordersFor({ gold, openOffers: (c.trades || []).length, cap: this.capOf(cid) }, o, price);
      if (p.n > 0) {
        this.sidelined.delete(cid);
        cities.push({ c, cid, gold, n: p.n, cost: p.cost, ok: 0, refused: [], had: new Set((c.trades || []).map((t) => t.id)) });
        continue;
      }
      const why = gold <= o.floor ? `gold ${fmt(gold)} is not over the ${fmt(o.floor)} floor`
        : !p.slots ? `all ${this.capOf(cid)} of its market offers are in use`
        : `gold ${fmt(gold)} leaves no room over the floor for one ${fmt(p.cost)} order`;
      if (this.sidelined.get(cid) !== why) { this.sidelined.set(cid, why); this.say(`sitting out — ${why}`, c.name); }
    }
    if (!cities.length) {
      if (this.nobody !== `${res}@${bid}`) { this.nobody = `${res}@${bid}`; this.say(`no city can buy ${res} at ${bid} right now`); }
      return { placed: 0, filled: 0, lostFees: 0 };
    }
    this.nobody = null;

    if (o.dry) {
      for (const x of cities) this.say(`[dry run] would place ${x.n} x ${fmt(o.amount)} ${res} @ ${bid} (${fmt(x.n * x.cost)} gold of ${fmt(x.gold)})`, x.c.name);
      return { placed: 0, filled: 0, lostFees: 0 };
    }

    // Round-robin: if the cheap supply runs out part way through the burst, each
    // city has had a share of it, rather than the first city taking the lot.
    const payloads = [], owner = [];
    for (let i = 0; i < o.orders; i++) {
      for (const x of cities) {
        if (i >= x.n) continue;
        payloads.push({ castleId: x.cid, resType: C.TRADE_RES[res], tradeType: BUY, amount: o.amount, price: bid });
        owner.push(x);
      }
    }
    const replies = await writeBatch(g, 'trade.newTrade', payloads);
    replies.forEach((r, i) => {
      if (!r) return;                 // no answer: counted as unanswered below
      if (r.ok === 1) owner[i].ok++;
      else { owner[i].refused.push(r.errorMsg || `ok=${r.ok}`); this.learnCap(owner[i].cid, r.errorMsg); }
    });
    const unanswered = replies.filter((r) => !r).length;
    for (const x of cities) this.estimate(g, x.c, { gold: x.gold - x.ok * x.cost });
    this.stats.rounds++;
    this.stats.orders += payloads.length;
    this.stats.refused += cities.reduce((n, x) => n + x.refused.length, 0);

    // What did not go through is still on the book as one of our offers.
    await sleep(o.settleMs);
    let filled = 0, placed = 0, unfilled = 0;
    const cancels = [];
    for (const x of cities) {
      const open = (x.c.trades || []).filter((t) => !x.had.has(t.id) && Number(t.tradeType) === BUY
        && Number(t.resType) === C.TRADE_RES[res] && Number(t.amount) === o.amount && samePrice(t.price, bid));
      const left = open.reduce((n, t) => n + Math.max(0, Number(t.amount) - Number(t.dealedAmount || 0)), 0);
      x.filled = Math.max(0, x.ok * o.amount - left);
      x.open = open.length;
      filled += x.filled;
      placed += x.ok;
      unfilled += left;
      for (const t of open) cancels.push({ castleId: x.cid, tradeId: t.id });
    }
    const cancelledOk = await this.cancel(g, cancels);

    for (const x of cities) {
      const parts = [`${x.ok} of ${x.n} order(s) placed, bought ${fmt(x.filled)}`];
      if (x.open) parts.push(`${x.open} did not fill and ${x.open === 1 ? 'was' : 'were'} cancelled`);
      if (x.refused.length) parts.push(`${x.refused.length} refused: ${[...new Set(x.refused)].join('; ')}`);
      this.say(`${res} @ ${bid} — ${parts.join(', ')} · gold ${fmt(this.goldOf(g, x.c))}`, x.c.name);
    }
    if (cancels.length && cancelledOk < cancels.length) {
      this.say(`${cancels.length - cancelledOk} of ${cancels.length} cancel(s) were not confirmed — they will be tried again at the end of this dump`);
    }
    if (unanswered) {
      this.say(`${unanswered} of ${payloads.length} order(s) got no answer — the server may be throttling market writes`, null, 'sys');
    }
    // The fee was taken on the whole order when it was placed; cancelling the
    // part that did not fill does not give it back.
    return { placed, filled, lostFees: unfilled * price * FEE };
  }

  // Cancel a batch of our offers; returns how many the server confirmed.
  async cancel(g, list) {
    if (!list.length) return 0;
    const replies = await writeBatch(g, 'trade.cancelTrade', list);
    let ok = 0;
    replies.forEach((r, i) => { if (r && r.ok === 1) { ok++; this.cancelled.add(`${list[i].castleId}:${list[i].tradeId}`); } });
    return ok;
  }

  // Any buy offer of ours for this resource still on the book: a fill pushed
  // after its round was counted, a cancel that did not take, or a round cut
  // short by a reconnect or by stop.
  async sweep(g, res) {
    const list = [];
    for (const c of g.castles) {
      for (const t of c.trades || []) {
        const key = `${g.castleId(c)}:${t.id}`;
        if (!this.cancelled.has(key) && this.isOurs(g, c, t, res)) list.push({ castleId: g.castleId(c), tradeId: t.id });
      }
    }
    if (!list.length) return 0;
    const n = await this.cancel(g, list);
    this.say(`cancelled ${n} of ${list.length} leftover ${res} offer(s)`);
    return n;
  }

  // ---- selling ----

  async sellSide(g) {
    const o = this.o, toList = [];
    for (const res of RESOURCES) {
      if (!this.running) return;
      const b = this.books[res];
      if (!b) continue;
      const bids = this.othersOnly(g, b.bids, BUY, res).filter((l) => l.price >= o.sellAt);
      if (bids.length) {
        if (!((this.sellCool[res] || 0) > Date.now())) await this.sellInto(g, res, bids);
        continue;
      }
      if (!o.list) continue;
      const asks = this.othersOnly(g, b.asks, SELL, res);
      if (asks.length && asks[0].price >= o.sellAt) toList.push({ res, ask: asks[0].price });
    }
    // Dearest first: a city lists only `list` offers, so give them the best price.
    toList.sort((a, b) => b.ask - a.ask);
    for (const l of toList) { if (this.running) await this.listFor(g, l.res, l.ask); }
  }

  // Cities that can sell this resource now: some to spare over `keep`, a free
  // market slot, and gold for the 0.5% commission a sell takes when it is
  // placed (NewTradeWin.calcCommission: gold >= commission).
  sellers(g, res) {
    const o = this.o, out = [];
    for (const c of g.castles) {
      const cid = g.castleId(c);
      const res0 = this.resOf(g, c, res), gold0 = this.goldOf(g, c);
      const surplus = Math.floor(res0 - o.keep);
      const slots = this.capOf(cid) - (c.trades || []).length;
      if (surplus < MIN_SELL || slots <= 0) continue;
      out.push({ c, cid, res0, gold0, gold: gold0, surplus, slots, had: new Set((c.trades || []).map((t) => t.id)) });
    }
    return out;
  }

  // Buyers are paying sellAt or more: sell them what the cities can spare, each
  // bid at its own price and no more than it wants, so nothing is left over on
  // the book unless someone else got to the bid first.
  async sellInto(g, res, bids) {
    const o = this.o;
    const cities = this.sellers(g, res);
    if (!cities.length) {
      this.quietly(`nosell:${res}`, `buyers are paying ${bids[0].price} for ${res}, but no city has over ${fmt(o.keep)} of it to spare and a free market slot`);
      return;
    }
    const plan = [];
    for (const b of bids) {
      const price = sellPriceFor(b.price);
      if (Number(price) < o.sellAt) continue;
      let want = b.amount, moved = true;
      while (want >= MIN_SELL && moved) {
        moved = false;
        for (const x of cities) {      // round-robin: a bid too small for everyone is shared
          const amt = Math.min(o.amount, want, x.surplus);
          if (amt < MIN_SELL || x.slots <= 0 || x.gold < amt * Number(price) * FEE) continue;
          plan.push({ x, amt, price });
          x.slots--; x.surplus -= amt; x.gold -= amt * Number(price) * FEE; want -= amt; moved = true;
          if (want < MIN_SELL) break;
        }
      }
    }
    if (!plan.length) return;
    const top = bids[0].price, low = bids[bids.length - 1].price;
    if (!o.dry) this.say(`${res.toUpperCase()}: buyers are paying ${top}${low !== top ? ` down to ${low}` : ''} — selling`);
    const r = await this.placeSells(g, res, plan, 'bid');
    if (o.dry) { this.sellCool[res] = Date.now() + o.cooldownMs; return; }
    if (r.sold) { this.sellMisses[res] = 0; return; }
    // Someone else sold into it first, or the bid was never really there. A
    // sell's fee is on its whole value, so back off as the buy side does.
    const misses = this.sellMisses[res] = (this.sellMisses[res] || 0) + 1;
    const wait = Math.min(o.cooldownMs * 2 ** (misses - 1), MAX_COOLDOWN);
    this.sellCool[res] = Date.now() + wait;
    this.say(`nothing sold into the ${res} buyers — leaving them for ${Math.round(wait / 1000)}s`);
  }

  // Nobody bids sellAt, but sellers ask it: keep an offer listed a hair under
  // the cheapest of them, `list` per city, so the next buyer takes ours.
  async listFor(g, res, ask) {
    const o = this.o, price = listPriceFor(ask, o.sellAt), plan = [];
    for (const x of this.sellers(g, res)) {
      if (this.listingsIn(x.cid) >= o.list || (this.listCool.get(x.cid) || 0) > Date.now()) continue;
      const amt = Math.min(o.amount, x.surplus);
      if (x.gold < amt * Number(price) * FEE) continue;
      plan.push({ x, amt, price });
    }
    if (!plan.length) return;
    await this.placeSells(g, res, plan, 'list');
    for (const p of plan) if (p.x.refused && p.x.refused.length) this.listCool.set(p.x.cid, Date.now() + o.cooldownMs);
  }

  // Place a batch of sells at once and see what went through. What is left on
  // the book stays listed while its city has room under `list` — it is at a
  // price we want — and is cancelled otherwise. `how`: 'bid' or 'list'.
  async placeSells(g, res, plan, how) {
    const o = this.o;
    const cities = [...new Set(plan.map((p) => p.x))];
    if (o.dry) {
      for (const x of cities) {
        const mine = plan.filter((p) => p.x === x);
        const total = mine.reduce((n, p) => n + p.amt, 0);
        const prices = [...new Set(mine.map((p) => p.price))].join('/');
        this.quietly(`dry:${how}:${x.cid}:${res}:${prices}`,
          `[dry run] would ${how === 'list' ? 'list' : 'sell into buyers'} ${fmt(total)} ${res} @ ${prices} `
          + `(${mine.length} order(s), about ${fmt(mine.reduce((n, p) => n + p.amt * Number(p.price), 0))} gold)`, x.c.name);
      }
      return { placed: 0, sold: 0 };
    }
    const payloads = plan.map((p) => ({ castleId: p.x.cid, resType: C.TRADE_RES[res], tradeType: SELL, amount: p.amt, price: p.price }));
    const replies = await writeBatch(g, 'trade.newTrade', payloads);
    for (const x of cities) Object.assign(x, { ok: 0, placed: 0, value: 0, fees: 0, refused: [] });
    replies.forEach((r, i) => {
      if (!r) return;                 // no answer: counted as unanswered below
      const p = plan[i], x = p.x;
      if (r.ok === 1) {
        x.ok++; x.placed += p.amt; x.value += p.amt * Number(p.price); x.fees += p.amt * Number(p.price) * FEE;
        this.recentSells.push({ cid: x.cid, res, price: Number(p.price), amount: p.amt, at: Date.now() });
      } else {
        x.refused.push(r.errorMsg || `ok=${r.ok}`);
        this.learnCap(x.cid, r.errorMsg);
      }
    });
    const unanswered = replies.filter((r) => !r).length;
    for (const x of cities) this.estimate(g, x.c, { gold: x.gold0 - x.fees, res: { [res]: x.res0 - x.placed } });
    this.stats.orders += payloads.length;
    this.stats.refused += cities.reduce((n, x) => n + x.refused.length, 0);
    this.stats.sellFees += cities.reduce((n, x) => n + x.fees, 0);

    await sleep(o.settleMs);
    let sold = 0, placed = 0;
    const cancels = [];
    for (const x of cities) {
      const open = (x.c.trades || []).filter((t) => !x.had.has(t.id) && Number(t.tradeType) === SELL
        && Number(t.resType) === C.TRADE_RES[res] && !this.listings.has(`${x.cid}:${t.id}`));
      let left = 0, leftValue = 0, room = o.list - this.listingsIn(x.cid);
      Object.assign(x, { listed: 0, listedAmt: 0, dropped: 0, lostFee: 0 });
      for (const t of open) {
        const dealt = Number(t.dealedAmount || 0), l = Math.max(0, Number(t.amount) - dealt), tp = Number(t.price);
        left += l; leftValue += l * tp;
        const i = this.recentSells.findIndex((s) => s.cid === x.cid && s.res === res && samePrice(s.price, tp) && s.amount === Number(t.amount));
        if (i >= 0) this.recentSells.splice(i, 1);
        if (room > 0) {
          this.listings.set(`${x.cid}:${t.id}`, { cid: x.cid, id: t.id, res, price: tp, amount: Number(t.amount), dealt, counted: dealt });
          room--; x.listed++; x.listedAmt += l;
        } else {
          cancels.push({ castleId: x.cid, tradeId: t.id });
          x.dropped++; x.lostFee += l * tp * FEE;
        }
      }
      x.sold = Math.max(0, x.placed - left);
      x.earned = Math.max(0, x.value - leftValue);
      sold += x.sold; placed += x.ok;
      this.stats.sold[res] = (this.stats.sold[res] || 0) + x.sold;
      this.stats.earned += x.earned;
    }
    const cancelledOk = await this.cancel(g, cancels);
    this.stats.fees += cities.reduce((n, x) => n + x.lostFee, 0);

    for (const x of cities) {
      const at = [...new Set(plan.filter((p) => p.x === x).map((p) => p.price))].join('/');
      const parts = [];
      if (x.sold) parts.push(`sold ${fmt(x.sold)} for about ${fmt(x.earned)} gold`);
      if (x.listed) parts.push(how === 'list' ? `listed ${fmt(x.listedAmt)}` : `${fmt(x.listedAmt)} did not sell and stays listed`);
      if (x.dropped) parts.push(`${x.dropped} did not sell and ${x.dropped === 1 ? 'was' : 'were'} cancelled (fee about ${fmt(x.lostFee)} not refunded)`);
      if (x.refused.length) parts.push(`${x.refused.length} refused: ${[...new Set(x.refused)].join('; ')}`);
      if (!parts.length) parts.push('nothing placed');
      this.say(`${res} @ ${at} — ${parts.join(', ')}`, x.c.name);
    }
    if (cancels.length && cancelledOk < cancels.length) {
      this.say(`${cancels.length - cancelledOk} of ${cancels.length} sell cancel(s) were not confirmed`);
    }
    if (unanswered) {
      this.say(`${unanswered} of ${payloads.length} sell order(s) got no answer — the server may be throttling market writes`, null, 'sys');
    }
    this.persist();
    return { placed, sold };
  }

  // Our sell offers on the book: follow their fills, notice the ones that have
  // gone, and own one whose push came after its round was counted.
  async trackListings(g) {
    const o = this.o, now = Date.now(), cancels = [];
    let changed = false;
    this.recentSells = this.recentSells.filter((s) => now - s.at < 300000);
    for (const c of g.castles) {
      const cid = g.castleId(c);
      for (const t of c.trades || []) {
        if (Number(t.tradeType) !== SELL) continue;
        const key = `${cid}:${t.id}`;
        const l = this.listings.get(key);
        if (l) { l.dealt = Number(t.dealedAmount || 0); continue; }
        if (this.preexisting.has(key) || this.cancelled.has(key)) continue;
        const res = RES_NAME[Number(t.resType)];
        const i = this.recentSells.findIndex((s) => s.cid === cid && s.res === res && samePrice(s.price, t.price) && s.amount === Number(t.amount));
        if (i < 0) continue;
        this.recentSells.splice(i, 1);
        // Counted as sold in full when its round found nothing left: take the
        // part still on the book back off.
        const dealt = Number(t.dealedAmount || 0), left = Number(t.amount) - dealt;
        this.stats.sold[res] = Math.max(0, (this.stats.sold[res] || 0) - left);
        this.stats.earned = Math.max(0, this.stats.earned - left * Number(t.price));
        if (this.listingsIn(cid) < o.list) {
          this.listings.set(key, { cid, id: t.id, res, price: Number(t.price), amount: Number(t.amount), dealt, counted: dealt });
        } else {
          cancels.push({ castleId: cid, tradeId: t.id });
          this.stats.fees += left * Number(t.price) * FEE;
        }
        changed = true;
      }
    }
    for (const [key, l] of this.listings) {
      const c = g.castles.find((x) => g.castleId(x) === l.cid);
      if (c && (c.trades || []).some((t) => String(t.id) === String(l.id))) continue;
      this.listings.delete(key);
      this.closed(g, l);
      changed = true;
    }
    if (cancels.length && !o.dry) await this.cancel(g, cancels);
    if (changed) this.persist();
  }

  // One of our sell offers has gone from the book. Nothing here cancels a
  // listed offer, so it is counted as sold — though one cancelled by hand in
  // the Market tab would look the same.
  closed(g, l, when = '') {
    const n = Math.max(0, Number(l.amount) - Number(l.counted || 0));
    this.stats.sold[l.res] = (this.stats.sold[l.res] || 0) + n;
    this.stats.earned += n * Number(l.price);
    const c = g && g.castles.find((x) => g.castleId(x) === l.cid);
    this.say(`${l.res} offer of ${fmt(l.amount)} @ ${l.price} has gone from the book${when} — counted as sold, about ${fmt(n * Number(l.price))} gold`, c ? c.name : null);
  }

  // What this run is working on, for the market goals (goal-trade.js), which
  // keep out of its way: the resources it is buying a dump of right now, the
  // cities with its buy orders open, and each city/resource it keeps a sell
  // offer listed for. A dry run places nothing and claims nothing.
  claims(g) {
    const cities = new Set(), listed = new Set();
    if (!this.o.dry) {
      for (const l of this.listings.values()) listed.add(`${l.cid}:${l.res}`);
      for (const c of (g && g.castles) || []) {
        if ((c.trades || []).some((t) => RESOURCES.some((res) => this.isOurs(g, c, t, res)))) cities.add(g.castleId(c));
      }
    }
    return {
      dry: !!this.o.dry, buying: new Set(this.o.dry ? [] : this.buying), cities, listed,
      floor: this.o.floor, keep: this.o.keep, sellAt: this.o.sellAt,
    };
  }

  summary() {
    const list = (m) => Object.entries(m || {}).filter(([, v]) => v > 0).map(([k, v]) => `${fmt(v)} ${k}`).join(', ');
    const b = list(this.stats.bought), s = list(this.stats.sold);
    return (b ? `bought so far: ${b}` : 'nothing bought yet') + (s ? `; sold ${s} for about ${fmt(this.stats.earned)} gold` : '');
  }

  statusLines() {
    const o = this.o, g = this.game;
    const mins = Math.round((Date.now() - this.stats.since) / 60000);
    const out = [
      `holidaysnipe: running for ${mins} min${o.dry ? ' — DRY RUN' : ''}${this.resumed ? ' (picked up again after a console restart)' : ''}`,
      `  ${this.plan()}; scan every ${o.scanMs / 1000}s`,
      `  last look (${Math.round((Date.now() - this.asksAt) / 1000)}s ago): ${this.marketText()}`,
      `  ${this.stats.scans} scans · ${this.stats.dumps} dump(s) · ${this.stats.rounds} round(s) · ${this.stats.orders} order(s), ${this.stats.refused} refused`,
      `  ${this.summary()}${this.stats.spent ? `; spent about ${fmt(this.stats.spent)} gold buying` : ''}`
        + (this.stats.fees ? ` · fees lost on cancelled orders about ${fmt(this.stats.fees)}` : ''),
    ];
    if (this.listings.size) {
      out.push(`  listed now: ${[...this.listings.values()].map((l) => {
        const c = g && g.castles.find((x) => g.castleId(x) === l.cid);
        return `${c ? c.name : l.cid} ${fmt(l.amount - (l.dealt || 0))} ${l.res} @ ${l.price}`;
      }).join(', ')}`);
    }
    if (g) {
      out.push('  gold: ' + g.castles.map((c) => {
        const now = this.goldOf(g, c), was = this.startGold[g.castleId(c)];
        const d = was === undefined ? 0 : now - was;
        return `${c.name} ${fmt(now)}${Math.abs(d) >= 1e6 ? ` (${d > 0 ? '+' : ''}${fmt(d)})` : ''}`;
      }).join(', '));
    } else out.push('  not connected right now — it carries on once the console is back');
    return out;
  }
}

// One sniper per console: a console is one account.
let current = null;

// The script command. Returns the lines for the script's output.
async function command({ action, opts }, { session, dryRun = false, store = null } = {}) {
  const kept = store || (session ? storeFor(session) : null);
  if (action === 'status') {
    if (current && current.running) return current.statusLines();
    return kept && kept.load()
      ? ['holidaysnipe: not running here, but a run is saved — it carries on when the console restarts; "holidaysnipe stop" forgets it']
      : ['holidaysnipe: not running'];
  }
  if (action === 'stop') {
    if (!current || !current.running) {
      if (kept && kept.load()) { kept.save(null); return ['holidaysnipe: not running — forgot the saved run, so a restart will not pick it up again']; }
      return ['holidaysnipe: not running'];
    }
    current.stop();
    await Promise.race([current.done, sleep(30000)]);
    current.forget();
    const lines = [`holidaysnipe: stopped — ${current.summary()}`];
    const n = current.listings.size;
    if (n) lines.push(`  its ${n} sell offer(s) stay listed — cancel them in the Market tab if you want the slots back (the 0.5% fee is not refunded)`);
    return lines;
  }
  if (!session || typeof session.note !== 'function') {
    return ['holidaysnipe: it runs inside the console — run it from a loadout there'];
  }
  if (current && current.running) {
    return [`holidaysnipe: already running (${current.summary()}) — "holidaysnipe stop" first to change its settings`];
  }
  const s = new Sniper(session, { ...opts, dry: !!(opts.dry || dryRun) }, { store });
  const lines = s.start();
  if (s.running) current = s;
  return lines;
}

// A console starting up: carry on with the run that was going when it went
// down. The run waits for the console to log in; nothing else is needed.
function resume(session, { store = null } = {}) {
  if (current && current.running) return null;
  const kept = store || storeFor(session);
  const saved = kept.load();
  if (!saved || !saved.opts) return null;
  const s = new Sniper(session, saved.opts, { store: kept, saved });
  s.start({ resumed: true });
  current = s;
  return s;
}

// The running sniper's claims (Sniper.claims) when one runs for this account
// in this process, else null. goal-trade.js asks before it trades.
function claims(accountId, g) {
  if (!current || !current.running) return null;
  if (accountId != null && current.accountId != null && String(current.accountId) !== String(accountId)) return null;
  return current.claims(g);
}

module.exports = { command, resume, claims, parseArgs, bidFor, sellPriceFor, listPriceFor, ordersFor, priceText, Sniper,
  DEFAULTS, MAX_OFFERS, MAX_AMOUNT, USAGE,
  // the pipeline itself, so a timing probe measures exactly what the sniper does
  burst };
