'use strict';
// game.js pipe: market writes go out the moment they are asked for, and each
// reply goes to the oldest request still waiting. Offline, against a pretend
// connection whose server answers in the order it was asked — which is what the
// real one was measured to do (market-probe.js, 2026-09-18).
const assert = require('assert');
const { EventEmitter } = require('events');
const { Game } = require('./game');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// rtt: the round trip; answer(data, i) -> the reply for the i-th request, or
// undefined to never answer it (a lost reply)
function wire({ rtt = 30, answer = () => ({ ok: 1 }) } = {}) {
  const c = new EventEmitter();
  c.pipelines = true;             // like evony.js: every reply arrives as a 'cmd' event
  const sent = [];
  let i = 0;
  c.missedReplies = 0;
  c.noteReply = () => { c.missedReplies = 0; };
  c.noteTimeout = () => { c.missedReplies++; };
  c.send = (cmd, data) => {
    if (c.closed) throw new Error('socket closed');
    const n = i++;
    sent.push({ cmd, data, at: Date.now() });
    const r = answer(data, n);
    if (r !== undefined) setTimeout(() => c.emit('cmd', cmd, { ...r, echo: data.tag }), rtt);
  };
  const g = new Game(() => {});
  g.c = c;
  return { g, c, sent };
}

t('each reply goes to its own request, in the order they were sent', async () => {
  const w = wire({ answer: (d) => ({ ok: d.tag % 2 ? 1 : -38 }) });
  const rs = await Promise.all([1, 2, 3, 4, 5].map((tag) => w.g.pipe('trade.newTrade', { tag })));
  assert.deepStrictEqual(rs.map((r) => r.echo), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(rs.map((r) => r.ok), [1, -38, 1, -38, 1]);
});

t('requests go out at once — none waits for another\'s reply', async () => {
  const w = wire({ rtt: 80 });
  const t0 = Date.now();
  await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9].map((tag) => w.g.pipe('trade.newTrade', { tag })));
  const took = Date.now() - t0;
  assert.ok(took < 80 * 2, `nine requests took ${took}ms — one round trip, not nine`);
  assert.ok(w.sent[8].at - w.sent[0].at < 20, 'all nine were on the wire together');
});

t('two cities placing at different moments never queue behind each other', async () => {
  const w = wire({ rtt: 60 });
  const t0 = Date.now();
  const a = w.g.pipe('trade.newTrade', { tag: 1 });
  await sleep(10);
  const b = w.g.pipe('trade.newTrade', { tag: 2 });
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepStrictEqual([ra.echo, rb.echo], [1, 2]);
  assert.ok(Date.now() - t0 < 60 + 10 + 40, 'the second did not wait a round trip for the first');
});

t('pipeMany: one reply per request, in order; a lost one comes back as noreply', async () => {
  const w = wire({ rtt: 10, answer: (d) => (d.tag === 3 ? undefined : { ok: 1 }) });
  const rs = await w.g.pipeMany('trade.newTrade', [1, 2, 3].map((tag) => ({ tag })), 150);
  assert.deepStrictEqual(rs.map((r) => r.ok), [1, 1, 'noreply']);
});

t('a lost reply: the oldest times out, nothing new is sent until the pipe drains, then it starts clean', async () => {
  // request 0's reply never comes; 1 and 2 are answered
  const w = wire({ rtt: 20, answer: (d, n) => (n === 0 ? undefined : { ok: 1 }) });
  const p0 = w.g.pipe('trade.newTrade', { tag: 'lost' }, 120);
  const p1 = w.g.pipe('trade.newTrade', { tag: 'b' }, 120);
  const p2 = w.g.pipe('trade.newTrade', { tag: 'c' }, 120);
  // THE COST, stated plainly: with one reply missing, the replies that do come
  // land one request early — 'b' answers the lost request and 'c' answers 'b' —
  // and the newest request is the one that times out. Nothing tells them apart
  // on the wire. The pipe cannot prevent that; what it does is stop sending new
  // work into a pipe that is off by one, so the damage ends with what was
  // already in flight (for market orders: which line's log says placed).
  const [s0, s1, s2] = await Promise.allSettled([p0, p1, p2]);
  assert.strictEqual(s0.value && s0.value.echo, 'b', 'the lost request took the next reply');
  assert.strictEqual(s1.value && s1.value.echo, 'c');
  assert.strictEqual(s2.status, 'rejected', 'the newest one is left without a reply');
  assert.strictEqual(w.c.missedReplies, 1, 'the rate-limit counter saw it');
  // after the drain, a new request is matched to its own reply again
  const fresh = await w.g.pipe('trade.newTrade', { tag: 'fresh' }, 500);
  assert.strictEqual(fresh.echo, 'fresh', 'the pipe starts clean after draining');
});

t('while draining, new requests are held back and sent once it is empty', async () => {
  const w = wire({ rtt: 20, answer: (d) => (d.tag === 'lost' ? undefined : { ok: 1 }) });
  const lost = w.g.pipe('trade.newTrade', { tag: 'lost' }, 60).catch((e) => e.message);
  await sleep(90);                       // it has timed out: the pipe is draining (nothing else in flight → drains at once)
  assert.match(await lost, /no reply to trade\.newTrade/);
  const late = await w.g.pipe('trade.newTrade', { tag: 'late' }, 500);
  assert.strictEqual(late.echo, 'late');
});

t('a request held during a drain goes out after the in-flight ones are done', async () => {
  // 0 is lost, 1 is slow but answered: while 1 is still owed, a new request waits
  let n = 0;
  const c = new EventEmitter();
  c.pipelines = true;             // like evony.js: every reply arrives as a 'cmd' event
  c.send = (cmd, data) => {
    const i = n++;
    if (i === 0) return;                                              // lost
    const delay = i === 1 ? 200 : 20;
    setTimeout(() => c.emit('cmd', cmd, { ok: 1, echo: data.tag }), delay);
  };
  const g = new Game(() => {});
  g.c = c;
  const p0 = g.pipe('trade.newTrade', { tag: 0 }, 50).catch((e) => 'timeout');
  const p1 = g.pipe('trade.newTrade', { tag: 1 }, 1000);
  assert.strictEqual(await p0, 'timeout');
  const sentBefore = n;
  const p2 = g.pipe('trade.newTrade', { tag: 2 }, 1000);          // asked while draining
  assert.strictEqual(n, sentBefore, 'held back, not sent into a pipe that may be off by one');
  const r1 = await p1;
  const r2 = await p2;
  assert.strictEqual(r1.echo, 1);
  assert.strictEqual(r2.echo, 2, 'sent after the drain and matched to its own reply');
});

t('a closed socket fails the request at once and leaves nothing owed', async () => {
  const w = wire();
  w.c.closed = true;
  await assert.rejects(w.g.pipe('trade.newTrade', { tag: 1 }), /socket closed/);
  w.c.closed = false;
  const r = await w.g.pipe('trade.newTrade', { tag: 2 });
  assert.strictEqual(r.echo, 2, 'the failed send did not take a reply slot');
});

t('replies to OTHER commands are never taken', async () => {
  const w = wire({ rtt: 20 });
  const p = w.g.pipe('trade.newTrade', { tag: 1 });
  w.c.emit('cmd', 'trade.searchTrades', { ok: 1, echo: 'not mine' });
  assert.strictEqual((await p).echo, 1);
});

t('newTrade and cancelTrade go through the pipe', async () => {
  const w = wire({ rtt: 10 });
  const r = await w.g.newTrade({ castleId: 1, resource: 'stone', type: 'sell', amount: 5, price: 140 });
  assert.strictEqual(r.ok, 1);
  await w.g.cancelTrade(1, 99);
  assert.deepStrictEqual(w.sent.map((s) => s.cmd), ['trade.newTrade', 'trade.cancelTrade']);
  assert.strictEqual(w.sent[0].data.price, '140', 'price is still a string on the wire');
});

// ---- the in-flight limit (Game.PIPE_LIMIT, 20) --------------------------------------
// A server that answers one at a time, like the real one does an account's commands.
function serialWire(perMs) {
  const w = wire({ answer: () => undefined });
  let most = 0, working = false;
  const queue = [];
  const next = () => {
    if (!queue.length) { working = false; return; }
    working = true;
    setTimeout(() => { const [cmd, tag] = queue.shift(); w.c.emit('cmd', cmd, { ok: 1, echo: tag }); next(); }, perMs);
  };
  const send = w.c.send;
  w.c.send = (cmd, data) => {
    send(cmd, data);
    most = Math.max(most, w.g.pipeInFlight() + 1);
    queue.push([cmd, data.tag]);
    if (!working) next();
  };
  return { ...w, most: () => most };
}

t('never more than 20 writes in flight on an account; the rest wait and go in order', async () => {
  assert.strictEqual(Game.PIPE_LIMIT, 20);
  const w = serialWire(2);
  const tags = Array.from({ length: 90 }, (_, i) => i + 1);
  const rs = await Promise.all(tags.map((tag) => w.g.pipe(tag % 3 ? 'trade.newTrade' : 'trade.cancelTrade', { tag })));
  assert.deepStrictEqual(rs.map((r) => r.echo), tags, 'every reply to its own request');
  assert.deepStrictEqual(w.sent.map((s) => s.data.tag), tags, 'sent in the order asked');
  assert.ok(w.most() <= 20, `at most 20 in flight, saw ${w.most()}`);
  assert.strictEqual(w.g.pipeInFlight(), 0);
  assert.strictEqual(w.g.pipeQueued(), 0);
});

t('a write that waits its turn starts its timeout only when it is sent', async () => {
  // 60 writes answered one at a time (~16 ms each on Windows timers): each is answered
  // within ~320 ms (20 ahead of it) of being SENT, but the last ~960 ms after it was
  // asked for — past its 600 ms
  const w = serialWire(10);
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => w.g.pipe('trade.newTrade', { tag: i }, 600)));
  assert.ok(Date.now() - t0 > 600, 'the last one waited longer than its timeout in all');
  assert.strictEqual(rs.filter((r) => r.ok === 1).length, 60, 'none timed out while waiting its turn');
});

t('a write still waiting when the socket closes is refused, not left hanging', async () => {
  const w = wire({ answer: () => undefined });
  const ps = Array.from({ length: 25 }, (_, i) => w.g.pipe('trade.newTrade', { tag: i }, 5000).then(() => 'ok', (e) => e.message));
  await sleep(10);
  assert.strictEqual(w.g.pipeQueued(), 5);
  w.c.emit('log', 'socket closed');
  const waiting = await Promise.all(ps.slice(20));
  assert.ok(waiting.every((m) => /closed before it was sent/.test(m)), waiting[0]);
});

t('a lost reply under the limit: the pipe drains, then everything still goes out and is answered', async () => {
  const w = wire({ rtt: 5, answer: (d, i) => (i === 3 ? undefined : { ok: 1 }) });
  const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => w.g.pipe('trade.newTrade', { tag: i }, 100).catch((e) => ({ lost: e.message }))));
  assert.strictEqual(rs.filter((r) => r.lost).length, 1, 'only the one reply that never came');
  assert.strictEqual(w.sent.length, 30, 'all thirty were sent');
  assert.strictEqual(w.g.pipeQueued(), 0);
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log('  ok    ' + n); pass++; } catch (e) { console.log('  FAIL  ' + n + '\n        ' + String(e.message).split('\n').slice(0, 6).join('\n        ')); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
