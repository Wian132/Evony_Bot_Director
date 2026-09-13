'use strict';
// The holiday-dump sniper, against a fake market — no network. It runs on the
// real Game (so the market lanes are the real ones) and the real Session push
// handling, so what it reads back is exactly what the console would hold.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-snipe-')), 't.db');
const { EvonyClient } = require('./evony');
const { Game } = require('./game');
const { Session } = require('./session');
const HS = require('./holiday-snipe');
const script = require('./script');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 3000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(5); }
};

const B = 1e9, M = 1e6;
const RES = { 0: 'food', 1: 'wood', 2: 'stone', 3: 'iron' };
const NORMAL = () => ({ food: [{ price: 18, amount: 1e10 }], wood: [{ price: 21, amount: 1e10 }],
  stone: [{ price: 30, amount: 1e10 }], iron: [{ price: 40, amount: 1e10 }] });

// A market that behaves the way the sniper assumes the real one does: a buy
// takes price x amount + 0.5% up front, fills against sellers at or under its
// price, and what is left rests on the book as an offer. The owner hears about
// offers and gold only through TradesUpdate / ResourceUpdate pushes — and no
// reply says which command or resource it answers, only the command's name.
class FakeServer {
  constructor({ cities, sellers }) {
    this.book = { ...NORMAL(), ...sellers };
    this.gold = new Map(cities.map((c) => [c.id, c.gold]));
    this.minGold = new Map(this.gold);
    this.offers = new Map();            // id -> { castleId, bean, left, price }
    this.nextId = 5000;
    this.sent = [];
    this.bought = { food: 0, wood: 0, stone: 0, iron: 0 };
    this.refuse = null;                 // (payload) -> errorMsg | null
    this.lateOfferMs = 0;               // push a new offer this long after the reply
    this.lateGoldMs = 0;                // push gold this long after the reply
    for (const c of cities) for (const tr of c.trades || []) this.offers.set(tr.id, { castleId: c.id, bean: tr, left: tr.amount, price: tr.price });
  }

  handle(client, cmd, data) {
    this.sent.push({ cmd, data, at: Date.now() });
    const emit = (name, d) => client.emit('cmd', name, d, { cmd: name, data: d });
    const push = (name, d, ms = 0) => (ms ? setTimeout(() => emit(name, d), ms) : setImmediate(() => emit(name, d)));
    const reply = (d) => setImmediate(() => emit(cmd, d));
    const pushGold = (cid) => {
      this.minGold.set(cid, Math.min(this.minGold.get(cid), this.gold.get(cid)));
      push('server.ResourceUpdate', { castleId: cid, resource: { gold: this.gold.get(cid) } }, this.lateGoldMs);
    };

    if (cmd === 'trade.searchTrades') {
      const list = this.book[RES[data.resType]].filter((s) => s.amount > 0);
      return reply({ ok: 1, sellers: list.map((s) => ({ price: s.price, amount: s.amount })), buyers: [] });
    }
    if (cmd === 'trade.newTrade') {
      const cid = data.castleId, res = RES[data.resType], price = Number(data.price), amount = Number(data.amount);
      if ([...this.offers.values()].filter((o) => o.castleId === cid).length >= 10) return reply({ ok: -38, errorMsg: 'too many trades' });
      const why = this.refuse && this.refuse(data);
      if (why) return reply({ ok: -99, errorMsg: why });
      const cost = amount * price * 1.005;
      if (this.gold.get(cid) < cost) return reply({ ok: -1, errorMsg: 'not enough gold' });
      this.gold.set(cid, this.gold.get(cid) - cost);
      let left = amount;
      for (const s of this.book[res].slice().sort((a, b) => a.price - b.price)) {
        if (left <= 0 || s.price > price) break;
        if (s.ghost) continue;             // shown, but someone else already has it
        const take = Math.min(left, s.amount);
        s.amount -= take; left -= take; this.bought[res] += take;
      }
      pushGold(cid);
      if (left > 0) {
        const bean = { id: this.nextId++, tradeType: 0, resType: data.resType, amount, dealedAmount: amount - left, price, resourceName: res };
        this.offers.set(bean.id, { castleId: cid, bean, left, price });
        push('server.TradesUpdate', { castleId: cid, updateType: 0, tradeBean: bean }, this.lateOfferMs);
      }
      return reply({ ok: 1 });
    }
    if (cmd === 'trade.cancelTrade') {
      const o = this.offers.get(data.tradeId);
      if (!o || o.castleId !== data.castleId) return reply({ ok: -97, errorMsg: 'no such trade' });
      this.offers.delete(data.tradeId);
      // Seen live: a 1 @ 1 bid took 1.005 and a cancel gave back 1.000 — the fee stays.
      this.gold.set(o.castleId, this.gold.get(o.castleId) + o.left * o.price);
      pushGold(o.castleId);
      push('server.TradesUpdate', { castleId: o.castleId, updateType: 1, tradeBean: { id: o.bean.id } });
      return reply({ ok: 1 });
    }
    return reply({ ok: 1 });
  }

  count(cmd) { return this.sent.filter((s) => s.cmd === cmd).length; }
  orders() { return this.sent.filter((s) => s.cmd === 'trade.newTrade').map((s) => s.data); }
  ourOffers() { return [...this.offers.values()].filter((o) => o.bean.amount === HS.DEFAULTS.amount && o.bean.tradeType === 0 && !o.preexisting); }
}

class FakeClient extends EvonyClient {
  constructor(server) { super(); this.server = server; this.sock = { destroyed: false }; }
  send(cmd, data) { if (this.sock.destroyed) throw new Error('socket closed'); this.server.handle(this, cmd, data); }
  close() { this.sock.destroyed = true; }
}

// cities: [{ id, name, gold, trades? }]
function world({ cities, sellers = {} }) {
  const server = new FakeServer({ cities, sellers });
  for (const o of server.offers.values()) o.preexisting = true;
  const g = new Game();
  g.c = new FakeClient(server);
  g.castles = cities.map((c) => ({ id: c.id, name: c.name, resource: { gold: c.gold }, trades: (c.trades || []).map((x) => ({ ...x })) }));
  const s = new Session();
  s.account = { id: 'test', label: 'T' };
  const lines = [];
  s.note = (m, meta) => lines.push({ m: String(m), ...(meta || {}) });
  s.wire(g);
  s.game = g;
  const said = (re, city) => lines.filter((l) => re.test(l.m) && (city === undefined || l.city === city));
  return { server, g, s, lines, said };
}

const FAST = { scanMs: 5, settleMs: 20, cooldownMs: 300, retryMs: 20 };
async function runOnce(w, opts = {}) {
  const sn = new HS.Sniper(w.s, { ...FAST, once: true, ...opts });
  const out = sn.start();
  if (sn.running) await Promise.race([sn.done, sleep(8000).then(() => { throw new Error('the sniper never finished'); })]);
  return { sn, out };
}

// ---------------------------------------------------------------------------

section('the bid');

t('bids the ask + 0.01: 0.1 -> 0.11, 0.01 -> 0.02', () => {
  assert.strictEqual(HS.bidFor(0.1), '0.11');
  assert.strictEqual(HS.bidFor(0.01), '0.02');
  assert.strictEqual(HS.bidFor(0.5), '0.51');
});

t('0.99 bids a clean 1, and a three-decimal ask keeps its third decimal', () => {
  assert.strictEqual(HS.bidFor(0.99), '1');
  assert.strictEqual(HS.bidFor(0.005), '0.015');
});

t('never under the ask, and always short enough for the 5-character price box', () => {
  for (let i = 0; i < 5000; i++) {
    const ask = Math.round(Math.random() * 149000) / 1000 + 0.001;
    const bid = HS.bidFor(ask);
    assert.ok(bid.length <= 5, `${ask} -> "${bid}" is ${bid.length} characters`);
    assert.ok(Number(bid) >= ask + 0.01 - 1e-9, `${ask} -> ${bid} is under ask + step`);
  }
  assert.strictEqual(HS.bidFor(20.125), '20.14');
});

section('how many orders a city places');

const O = { orders: 10, amount: 99 * M, floor: 1 * B };
t('a rich city places all ten', () => {
  assert.strictEqual(HS.ordersFor({ gold: 5 * B }, O, 0.11).n, 10);
});

t('never so many that its gold drops under the 1b floor', () => {
  // 99m @ 0.51 + 0.5% = 50.74m an order; 1.2b leaves room for 3
  assert.strictEqual(HS.ordersFor({ gold: 1.2 * B }, O, 0.51).n, 3);
  for (let i = 0; i < 2000; i++) {
    const gold = Math.random() * 5 * B, price = Math.random() * 1.2;
    const p = HS.ordersFor({ gold }, O, price);
    assert.ok(p.n === 0 || gold - p.n * p.cost >= O.floor, `gold ${gold} price ${price} -> ${p.n} orders`);
  }
});

t('a city at or under the floor places none', () => {
  assert.strictEqual(HS.ordersFor({ gold: 0.9 * B }, O, 0.02).n, 0);
  assert.strictEqual(HS.ordersFor({ gold: 1 * B }, O, 0.02).n, 0);
});

t('no more than its free offer slots (10 per city)', () => {
  assert.strictEqual(HS.ordersFor({ gold: 50 * B, openOffers: 7 }, O, 0.11).n, 3);
  assert.strictEqual(HS.ordersFor({ gold: 50 * B, openOffers: 10 }, O, 0.11).n, 0);
});

section('the command line');

t('bare holidaysnipe starts with the defaults', () => {
  const a = HS.parseArgs([]);
  assert.strictEqual(a.action, 'start');
  assert.deepStrictEqual(a.opts, {});
  assert.strictEqual(HS.DEFAULTS.under, 1);
  assert.strictEqual(HS.DEFAULTS.step, 0.01);
  assert.strictEqual(HS.DEFAULTS.amount, 99 * M);
  assert.strictEqual(HS.DEFAULTS.orders, 10);
  assert.strictEqual(HS.DEFAULTS.floor, 1 * B);
});

t('settings, stop and status', () => {
  assert.strictEqual(HS.parseArgs(['stop']).action, 'stop');
  assert.strictEqual(HS.parseArgs(['status']).action, 'status');
  const a = HS.parseArgs(['dry', 'under:0.5', 'amount:50m', 'floor:2b', 'orders:5', 'scan:2']);
  assert.deepStrictEqual(a.opts, { dry: true, under: 0.5, amount: 50 * M, floor: 2 * B, orders: 5, scanMs: 2000 });
});

t('refuses what the market would refuse, and a scan fast enough to get throttled', () => {
  for (const bad of [['bogus'], ['amount:0'], ['amount:100m'], ['orders:11'], ['scan:0.1'], ['under:abc'], ['colour:red']]) {
    assert.throws(() => HS.parseArgs(bad), undefined, bad.join(' '));
  }
});

t('it is a script command', () => {
  const [a] = script.parse('holidaysnipe amount:1 once');
  assert.strictEqual(a.cmd, 'holidaysnipe');
  assert.strictEqual(a.action, 'start');
  assert.deepStrictEqual(a.opts, { amount: 1, once: true });
  assert.strictEqual(script.parse('holidaysnipe stop')[0].action, 'stop');
  assert.strictEqual(script.parse('holidaysnipe sideways')[0].cmd, 'error');
});

section('market replies cannot be told apart — the lanes');

t('the hazard is real: two searches in flight both take the first reply', async () => {
  const w = world({ cities: [{ id: 1, name: 'A', gold: 5 * B }] });
  const [food, wood] = await Promise.all([w.g.req('trade.searchTrades', { resType: 0 }), w.g.req('trade.searchTrades', { resType: 1 }).catch(() => null)]);
  assert.strictEqual(food.sellers[0].price, 18);
  assert.ok(!wood || wood.sellers[0].price === 18, 'expected wood to get food\'s answer without a lane');
});

t('through the lane, each search gets its own resource', async () => {
  const w = world({ cities: [{ id: 1, name: 'A', gold: 5 * B }] });
  const r = await Promise.all(['food', 'wood', 'stone', 'iron'].map((x) => w.g.searchTrades(x)));
  assert.deepStrictEqual(r.map((x) => x.sellers[0].price), [18, 21, 30, 40]);
});

section('the sniper against a market');

t('a normal market: it watches and buys nothing', async () => {
  const w = world({ cities: [{ id: 1, name: 'A', gold: 5 * B }] });
  const sn = new HS.Sniper(w.s, FAST);
  sn.start();
  await until(() => sn.stats.scans >= 5, 3000, 'five scans');
  sn.stop(); await sn.done;
  assert.strictEqual(w.server.count('trade.newTrade'), 0);
  assert.ok(w.said(/first look — food 18 · wood 21 · stone 30 · iron 40/).length);
});

t('a wood dump at 0.1: every city over the floor bids 0.11, ten 99m orders, ten more while they fill', async () => {
  const w = world({
    cities: [{ id: 1, name: 'A', gold: 5 * B }, { id: 2, name: 'B', gold: 0.8 * B }, { id: 3, name: 'C', gold: 1.2 * B }],
    sellers: { wood: [{ price: 0.1, amount: 2.5 * B }, { price: 1.5, amount: 1e12 }] },
  });
  const { sn } = await runOnce(w);
  const orders = w.server.orders();
  assert.ok(orders.every((o) => o.resType === 1 && o.tradeType === 0 && o.amount === 99 * M && o.price === '0.11'), 'every order: buy wood 99m @ 0.11');
  assert.ok(!orders.some((o) => o.castleId === 2), 'B is under the floor and must not trade');
  // round 1: A 10 + C 10, all filled; round 2: A 10 + C 8 (C nears its floor)
  assert.strictEqual(orders.length, 38);
  assert.strictEqual(sn.stats.rounds, 2);
  assert.strictEqual(w.server.bought.wood, 2.5 * B, 'bought the whole dump');
  assert.strictEqual(sn.stats.bought.wood, 2.5 * B, 'and counted it right');
  assert.strictEqual(w.server.ourOffers().length, 0, 'nothing of ours left on the book');
  assert.ok(w.server.minGold.get(3) >= 1 * B, `C went down to ${w.server.minGold.get(3)}`);
  assert.ok(w.server.minGold.get(1) >= 1 * B);
  assert.ok(w.said(/sitting out — gold 800m is not over the 1b floor/, 'B').length);
  assert.ok(w.said(/wood @ 0\.11 — 10 of 10 order\(s\) placed, bought 990m/, 'A').length);
});

t('the orders go out round-robin, so a short supply is shared between cities', async () => {
  const w = world({
    cities: [{ id: 1, name: 'A', gold: 50 * B }, { id: 3, name: 'C', gold: 50 * B }],
    sellers: { wood: [{ price: 0.1, amount: 4 * 99 * M }, { price: 1.5, amount: 1e12 }] },
  });
  await runOnce(w);
  assert.deepStrictEqual(w.server.orders().slice(0, 4).map((o) => o.castleId), [1, 3, 1, 3]);
  assert.ok(w.said(/bought 198m/, 'A').length && w.said(/bought 198m/, 'C').length, 'two orders each');
});

t('each round is bid at the fresh ask', async () => {
  const w = world({
    cities: [{ id: 1, name: 'A', gold: 50 * B }],
    sellers: { wood: [{ price: 0.1, amount: 990 * M }, { price: 0.3, amount: 500 * M }, { price: 1.5, amount: 1e12 }] },
  });
  const { sn } = await runOnce(w);
  assert.deepStrictEqual([...new Set(w.server.orders().map((o) => o.price))], ['0.11', '0.31']);
  assert.strictEqual(sn.stats.bought.wood, 1490 * M);
  assert.strictEqual(w.server.ourOffers().length, 0);
});

t('it stops at the floor however big the dump', async () => {
  const w = world({ cities: [{ id: 1, name: 'A', gold: 1.5 * B }], sellers: { wood: [{ price: 0.5, amount: 1e12 }] } });
  await runOnce(w);
  assert.strictEqual(w.server.count('trade.newTrade'), 9, '1.5b leaves room for nine 50.7m orders');
  assert.ok(w.server.minGold.get(1) >= 1 * B, `went down to ${w.server.minGold.get(1)}`);
  assert.ok(w.said(/sitting out — gold 1\.04b leaves no room over the floor/, 'A').length);
});

t('a gold push that comes late cannot walk a city under the floor', async () => {
  const w = world({ cities: [{ id: 1, name: 'A', gold: 1.5 * B }], sellers: { wood: [{ price: 0.5, amount: 1e12 }] } });
  w.server.lateGoldMs = 300;     // the second round is placed long before this lands
  await runOnce(w);
  assert.strictEqual(w.server.count('trade.newTrade'), 9);
  assert.ok(w.server.minGold.get(1) >= 1 * B, `went down to ${w.server.minGold.get(1)}`);
});

t('what did not fill is cancelled before the next round, so it has all ten slots again', async () => {
  const w = world({ cities: [{ id: 1, name: 'A', gold: 50 * B }], sellers: { wood: [{ price: 0.1, amount: 3 * 99 * M }, { price: 0.3, amount: 1e12 }] } });
  await runOnce(w, { rounds: 2 });
  const second = w.server.orders().filter((o) => o.price === '0.31');
  assert.strictEqual(second.length, 10, `the second round placed ${second.length}`);
});

t('offers the city already had keep their slots and are never touched', async () => {
  const mineBefore = [
    ...[1, 2, 3, 4, 5, 6].map((i) => ({ id: i, tradeType: 1, resType: 2, amount: 1000, dealedAmount: 0, price: 99 })),
    { id: 7, tradeType: 0, resType: 1, amount: 99 * M, dealedAmount: 0, price: 0.11 },   // looks exactly like one of ours
  ];
  const w = world({ cities: [{ id: 1, name: 'A', gold: 50 * B, trades: mineBefore }], sellers: { wood: [{ price: 0.1, amount: 1e12 }] } });
  await runOnce(w, { rounds: 2 });
  assert.strictEqual(w.server.count('trade.newTrade'), 6, '3 free slots, 2 rounds');
  assert.strictEqual(w.server.count('trade.cancelTrade'), 0);
  assert.deepStrictEqual([...w.server.offers.keys()].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
});

t('when nothing fills it cancels, and leaves that resource alone for the cooldown', async () => {
  const w = world({ cities: [{ id: 1, name: 'A', gold: 50 * B }], sellers: { wood: [{ price: 0.05, amount: 1e9, ghost: true }, { price: 1.5, amount: 1e12 }] } });
  const sn = new HS.Sniper(w.s, FAST);
  sn.start();
  await until(() => w.server.count('trade.newTrade') === 10, 3000, 'the first round');
  await sleep(150);
  assert.strictEqual(w.server.count('trade.newTrade'), 10, 'no second round inside the cooldown');
  assert.strictEqual(w.server.ourOffers().length, 0, 'the ten were cancelled');
  await until(() => w.server.count('trade.newTrade') === 20, 3000, 'a second try after the cooldown');
  sn.stop(); await sn.done;
  assert.strictEqual(w.server.ourOffers().length, 0);
  assert.ok(w.said(/nothing filled at 0\.06 — someone got there first/).length);
});

t('a cancel keeps the fee, so each empty round in a row waits twice as long, and says what it cost', async () => {
  const w = world({ cities: [{ id: 1, name: 'A', gold: 50 * B }], sellers: { wood: [{ price: 0.05, amount: 1e9, ghost: true }, { price: 1.5, amount: 1e12 }] } });
  const sn = new HS.Sniper(w.s, { ...FAST, cooldownMs: 100 });
  sn.start();
  const roundAt = (k) => { const o = w.server.sent.filter((s) => s.cmd === 'trade.newTrade'); return o[k * 10 - 1] && o[k * 10 - 1].at; };
  await until(() => roundAt(4), 5000, 'four rounds');
  sn.stop(); await sn.done;
  const gaps = [roundAt(2) - roundAt(1), roundAt(3) - roundAt(2), roundAt(4) - roundAt(3)];
  assert.ok(gaps[0] >= 100 && gaps[1] >= 200 && gaps[2] >= 400, 'gaps ' + gaps.join(', ') + 'ms');
  // ten 99m orders @ 0.06 cancelled whole: 0.5% of 59.4m each
  assert.ok(w.said(/The fee on the cancelled orders, about 297k gold, is not refunded/).length);
  assert.ok(Math.abs(sn.stats.fees - 4 * 297000) < 1, 'fees counted ' + sn.stats.fees);
});

t('a dry run reads the market and places nothing', async () => {
  const w = world({ cities: [{ id: 1, name: 'A', gold: 50 * B }], sellers: { wood: [{ price: 0.1, amount: 1e12 }] } });
  const { out } = await runOnce(w, { dry: true });
  assert.ok(/DRY RUN/.test(out[0]));
  assert.strictEqual(w.server.count('trade.newTrade') + w.server.count('trade.cancelTrade'), 0);
  assert.ok(w.said(/\[dry run\] would place 10 x 99m wood @ 0\.11/, 'A').length);
});

t('it will not start unless some city has more than the floor', async () => {
  const w = world({ cities: [{ id: 1, name: 'A', gold: 0.9 * B }, { id: 2, name: 'B', gold: 1 * B }] });
  const sn = new HS.Sniper(w.s, FAST);
  const out = sn.start();
  assert.strictEqual(sn.running, false);
  assert.ok(/not started — no city has more than 1b gold/.test(out[0]), out[0]);
  assert.strictEqual(w.server.sent.length, 0, 'not even a search');
});

t('refusals land on the city that was refused, though the replies carry no city', async () => {
  const w = world({ cities: [{ id: 1, name: 'A', gold: 50 * B }, { id: 2, name: 'B', gold: 50 * B }], sellers: { wood: [{ price: 0.1, amount: 1e12 }] } });
  w.server.refuse = (p) => (p.castleId === 2 ? 'B is refused' : null);
  await runOnce(w, { rounds: 1 });
  assert.ok(w.said(/10 of 10 order\(s\) placed, bought 990m ·/, 'A').length, 'A all through');
  assert.ok(w.said(/0 of 10 order\(s\) placed, bought 0, 10 refused: B is refused/, 'B').length, 'B all refused');
});

t('an offer pushed after its round was counted is still cancelled', async () => {
  const w = world({ cities: [{ id: 1, name: 'A', gold: 50 * B }], sellers: { wood: [{ price: 0.1, amount: 3 * 99 * M }, { price: 1.5, amount: 1e12 }] } });
  w.server.lateOfferMs = 80;    // well after settle (20ms)
  const sn = new HS.Sniper(w.s, FAST);
  sn.start();
  await until(() => w.server.count('trade.newTrade') >= 10, 3000, 'a round');
  await until(() => w.server.ourOffers().length === 0 && w.server.count('trade.cancelTrade') >= 7, 3000, 'the late offers to be swept');
  sn.stop(); await sn.done;
  assert.strictEqual(w.server.ourOffers().length, 0);
});

t('stop mid-dump: it stops placing and leaves nothing on the book', async () => {
  const w = world({ cities: [{ id: 1, name: 'A', gold: 500 * B }], sellers: { wood: [{ price: 0.1, amount: 1e15 }] } });
  const out = await HS.command({ action: 'start', opts: { ...FAST } }, { session: w.s });
  assert.ok(/started/.test(out[0]), out[0]);
  await until(() => w.server.count('trade.newTrade') >= 20, 3000, 'two rounds');
  const status = await HS.command({ action: 'status', opts: {} });
  assert.ok(/running for/.test(status[0]) && status.some((l) => /bought so far: .* wood/.test(l)), status.join('\n'));
  const stopped = await HS.command({ action: 'stop', opts: {} });
  assert.ok(/stopped — bought so far/.test(stopped[0]), stopped[0]);
  const n = w.server.count('trade.newTrade');
  await sleep(100);
  assert.strictEqual(w.server.count('trade.newTrade'), n, 'nothing placed after stop');
  assert.strictEqual(w.server.ourOffers().length, 0);
  assert.deepStrictEqual(await HS.command({ action: 'status', opts: {} }), ['holidaysnipe: not running']);
});

t('a second start is refused while one is running', async () => {
  const w = world({ cities: [{ id: 1, name: 'A', gold: 5 * B }] });
  await HS.command({ action: 'start', opts: { ...FAST } }, { session: w.s });
  const again = await HS.command({ action: 'start', opts: { ...FAST } }, { session: w.s });
  assert.ok(/already running/.test(again[0]), again[0]);
  await HS.command({ action: 'stop', opts: {} });
});

t('it follows the console onto a new socket after a reconnect', async () => {
  const w = world({ cities: [{ id: 1, name: 'A', gold: 5 * B }] });
  const sn = new HS.Sniper(w.s, FAST);
  sn.start();
  await until(() => sn.stats.scans >= 2);
  const g2 = new Game();
  g2.c = new FakeClient(w.server);
  g2.castles = w.g.castles;
  w.g.c.close();                 // the old socket is gone
  w.s.wire(g2); w.s.game = g2;
  const before = w.server.count('trade.searchTrades');
  await until(() => w.server.count('trade.searchTrades') >= before + 8, 3000, 'scans on the new socket');
  sn.stop(); await sn.done;
});

t('it stops if the console switches account', async () => {
  const w = world({ cities: [{ id: 1, name: 'A', gold: 5 * B }] });
  const sn = new HS.Sniper(w.s, FAST);
  sn.start();
  await until(() => sn.stats.scans >= 1);
  w.s.account = { id: 'other' };
  await Promise.race([sn.done, sleep(2000)]);
  assert.strictEqual(sn.running, false);
  assert.ok(w.said(/switched account — stopping/).length);
});

section('run from a script, the way the console runs it');

t('holidaysnipe in a loadout starts it and returns at once; holidaysnipe stop stops it', async () => {
  const w = world({ cities: [{ id: 1, name: 'A', gold: 5 * B }] });
  const out = [];
  await script.run(w.g, script.parse('// Holiday sniper\nholidaysnipe settle:0.02'), (m) => out.push(m), { session: w.s });
  assert.ok(out.some((l) => /holidaysnipe: started/.test(l)), out.join('\n'));
  await until(() => w.server.count('trade.searchTrades') >= 4, 3000, 'a scan');
  const out2 = [];
  await script.run(w.g, script.parse('holidaysnipe stop'), (m) => out2.push(m), { session: w.s });
  assert.ok(out2.some((l) => /holidaysnipe: stopped/.test(l)), out2.join('\n'));
});

t('outside the console there is no session to run on, and it says so', async () => {
  const w = world({ cities: [{ id: 1, name: 'A', gold: 5 * B }] });
  const out = [];
  await script.run(w.g, script.parse('holidaysnipe'), (m) => out.push(m), {});
  assert.ok(out.some((l) => /runs inside the console/.test(l)), out.join('\n'));
});

// ---------------------------------------------------------------------------

(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n + '\n'); continue; }
    try { await f(); console.log('  ok    ' + n); pass++; }
    catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(path.dirname(process.env.EVONY_DB), { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
