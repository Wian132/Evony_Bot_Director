'use strict';
// market-probe.js offline, against a pretend game server: a round-trip delay,
// work done ONE REQUEST AT A TIME (the pessimistic case), a 10-offer cap, and a
// trade list it pushes back the way server.TradesUpdate does. What matters most:
// the probe never leaves an order behind and never touches an order it did not
// place.
const assert = require('assert');
const { EventEmitter } = require('events');
const P = require('./market-probe');
const { Game } = require('./game');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function world({ rtt = 20, work = 5, open = [], pipe = true } = {}) {
  const city = { id: 7, name: 'Nine', trades: open.map((x) => ({ ...x })) };
  const c = new EventEmitter();
  c.pipelines = true;             // like evony.js: every reply arrives as a 'cmd' event
  let busyUntil = 0, nextId = 5000;
  const sent = [];
  c.send = (cmd, data) => {
    sent.push({ cmd, data });
    // half the round trip there, the work (one request at a time), half back
    const arrive = Date.now() + rtt / 2;
    const start = Math.max(arrive, busyUntil);
    busyUntil = start + work;
    setTimeout(() => {
      let reply = { ok: 1 };
      if (cmd === 'trade.newTrade') {
        if (city.trades.length >= 10) reply = { ok: -38, errorMsg: '10 offers are allowed at level 10 Marketplace.' };
        else city.trades.push({ id: nextId++, amount: data.amount, price: data.price, tradeType: data.tradeType, resType: data.resType });
      }
      if (cmd === 'trade.cancelTrade') {
        const before = city.trades.length;
        city.trades = city.trades.filter((x) => Number(x.id) !== Number(data.tradeId));
        if (city.trades.length === before) reply = { ok: -1, errorMsg: 'trade not found' };
      }
      c.emit('cmd', cmd, reply);
    }, busyUntil - Date.now() + rtt / 2);
  };
  // the connection's own wait for a reply, as evony.js has it — so the Game below
  // runs its REAL req, lane and pipe, and the probe times the path production uses
  c.await = (cmds, ms = 20000) => new Promise((resolve, reject) => {
    const want = [].concat(cmds);
    const timer = setTimeout(() => { c.off('cmd', h); reject(new Error('no reply to ' + want.join('/'))); }, ms);
    const h = (name, data) => { if (!want.includes(name)) return; clearTimeout(timer); c.off('cmd', h); resolve({ cmd: name, data }); };
    c.on('cmd', h);
  });
  const g = new Game(() => {});
  g.c = c;
  g.castles = [city];
  // a Game from before the pipe: the probe falls back to the lane and a burst
  if (!pipe) { g.pipe = undefined; g.pipeMany = undefined; }
  return { g, city, sent };
}

t('reads: one at a time, then 10/20/40 in flight, every reply counted', async () => {
  const w = world();
  const out = await P.run(w.g, { reads: true, orders: 0 });
  assert.strictEqual(out.reads.oneAtATime.n, 10);
  assert.deepStrictEqual(out.reads.together.map((x) => [x.n, x.replies]), [[10, 10], [20, 20], [40, 40]]);
  // in flight together, ten cost about one round trip plus ten lots of work, not ten round trips
  assert.ok(out.reads.together[0].total < out.reads.oneAtATime.total, JSON.stringify(out.reads));
});

t('orders: placed and cancelled both ways, created in the order sent, NOTHING left behind', async () => {
  const w = world();
  const out = await P.run(w.g, { reads: false, orders: 5 });
  assert.strictEqual(out.orders.perPhase, 5);
  assert.strictEqual(out.orders.oneAtATime.placed, 5);
  assert.strictEqual(out.orders.together.placed, 5);
  assert.strictEqual(out.orders.createdInSendOrder, true);
  assert.deepStrictEqual(out.orders.created.map((x) => x.amount), [101, 102, 103, 104, 105]);
  assert.strictEqual(out.orders.cancelOneAtATime.ok, 5);
  assert.strictEqual(out.orders.cancelTogether.ok, 5);
  assert.deepStrictEqual(out.orders.leftBehind, []);
  assert.strictEqual(w.city.trades.length, 0);
});

t('through the pipe: the staggered phases run with Nagle on and off, and still leave nothing', async () => {
  const w = world();
  let nodelay = null;
  w.g.c.sock = { setNoDelay: (v) => { nodelay = v; } };
  const out = await P.run(w.g, { reads: false, orders: 4 });
  for (const k of ['staggeredNagleOn', 'staggeredNagleOff']) {
    assert.strictEqual(out.orders[k].placed, 4, k);
    assert.strictEqual(out.orders[k].createdInSendOrder, true, k);
  }
  assert.strictEqual(nodelay, true, 'the socket is left with Nagle OFF, the way production runs it');
  assert.deepStrictEqual(out.orders.leftBehind, []);
  assert.strictEqual(w.city.trades.length, 0);
});

t('a game without a pipe still gets timed, the old way', async () => {
  const w = world({ pipe: false });
  const out = await P.run(w.g, { reads: false, orders: 3 });
  assert.strictEqual(out.orders.together.placed, 3);
  assert.strictEqual(out.orders.staggeredNagleOn, undefined, 'staggering needs the pipe');
  assert.deepStrictEqual(out.orders.leftBehind, []);
});

t('an order that was already on the city is never cancelled, and caps how many it places', async () => {
  const mine = [{ id: 1, amount: 99999999, price: 150, tradeType: 1, resType: 1 },
    { id: 2, amount: 5, price: 7, tradeType: 0, resType: 0 }];
  const w = world({ open: mine.slice() });
  const out = await P.run(w.g, { reads: false, orders: 10 });
  assert.strictEqual(out.orders.openBefore, 2);
  assert.strictEqual(out.orders.perPhase, 8, 'ten slots, two taken');
  assert.deepStrictEqual(w.city.trades.map((x) => x.id), [1, 2], 'the city\'s own two are still there, and only they are');
  const cancelled = w.sent.filter((s) => s.cmd === 'trade.cancelTrade').map((s) => s.data.tradeId);
  assert.ok(!cancelled.includes(1) && !cancelled.includes(2), 'never sent a cancel for them');
});

t('a full city places nothing and says why', async () => {
  const full = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, amount: 1, price: 1, tradeType: 0, resType: 2 }));
  const w = world({ open: full });
  const out = await P.run(w.g, { reads: false, orders: 5 });
  assert.match(out.orders.skipped, /no free offer slot/);
  assert.strictEqual(w.sent.filter((s) => s.cmd === 'trade.newTrade').length, 0);
});

t('a server that stops answering stops the read escalation', async () => {
  const w = world();
  const real = w.g.c.send;
  let n = 0;
  w.g.c.send = (cmd, data) => { if (++n > 25) return; real(cmd, data); };   // goes silent part way through
  const out = await P.run(w.g, { reads: true, orders: 0 });
  assert.ok(out.reads.stoppedAt, JSON.stringify(out.reads.together));
  assert.ok(out.reads.together.length < 3, 'did not go on to 40');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log('  ok    ' + n); pass++; } catch (e) { console.log('  FAIL  ' + n + '\n        ' + String(e.message).split('\n').slice(0, 6).join('\n        ')); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
