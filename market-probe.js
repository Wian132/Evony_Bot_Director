'use strict';
// How fast can ONE account's market go, and does the game server work on
// several orders at once or strictly one after another?
//
// The wire carries no request id: a reply is matched to its request only by
// command name and arrival order (evony.js await), which is why every market
// command queues in a single lane per account (game.js lane). Pipelining — many
// requests in flight, replies matched by POSITION — is what holidaysnipe's
// burst() already does. Whether it is worth doing for scripts depends on the
// server: if it overlaps the work, N in flight is ~N times faster; if it works
// through them one by one, we still save a network round-trip per order.
// This measures which, from wherever the console runs.
//
// Phases (each can be skipped):
//   reads   trade.searchTrades one at a time, then 10/20/40 in flight — a read
//           changes nothing, so it is safe to push hard. A burst that loses
//           replies stops the escalation: the server is ignoring us.
//   orders  real bids at a price nobody sells into (0.001), each one a
//           DIFFERENT amount (1, 2, 3 ...), so the order the server created them
//           in can be read back from the trade ids. One at a time, then all in
//           flight, then the cancels the same two ways. Never more orders than
//           the city has free offer slots, and only the probe's own orders are
//           ever cancelled — anything already on the city's list is left alone.
const C = require('./constants');

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const r0 = (x) => Math.round(x);
const sleep = (t) => new Promise((r) => setTimeout(r, t));

// holidaysnipe's burst, with the arrival time of every reply.
function burst(g, cmd, payloads, timeoutMs) {
  return new Promise((resolve) => {
    const replies = [], at = [];
    const t0 = process.hrtime.bigint();
    if (!payloads.length) return resolve({ replies, at, total: 0 });
    let timer = null;
    const finish = () => { clearTimeout(timer); g.c.off('cmd', onCmd); resolve({ replies, at, total: r0(ms(t0)) }); };
    const onCmd = (name, data) => {
      if (name !== cmd) return;
      replies.push(data || {});
      at.push(r0(ms(t0)));
      if (replies.length >= payloads.length) finish();
    };
    g.c.on('cmd', onCmd);
    timer = setTimeout(finish, timeoutMs);
    try { for (const p of payloads) g.c.send(cmd, p); } catch { finish(); }
  });
}

async function oneByOne(g, cmd, payloads) {
  const each = [], replies = [];
  const t0 = process.hrtime.bigint();
  for (const p of payloads) {
    const t = process.hrtime.bigint();
    try { replies.push(await g.req(cmd, p)); each.push(r0(ms(t))); } catch (e) { replies.push({ ok: 'noreply', errorMsg: e.message }); each.push(-1); }
  }
  return { total: r0(ms(t0)), each, replies };
}

const median = (a) => { const s = a.filter((x) => x >= 0).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
// The shape of a reply, without the 100 KB beans some carry.
function shapeOf(v, depth = 0) {
  if (v === null || v === undefined || typeof v !== 'object') return v;
  if (Array.isArray(v)) return depth > 1 ? `array[${v.length}]` : v.slice(0, 2).map((x) => shapeOf(x, depth + 1));
  if (depth > 1) return `{${Object.keys(v).slice(0, 12).join(',')}}`;
  return Object.fromEntries(Object.entries(v).slice(0, 20).map(([k, x]) => [k, shapeOf(x, depth + 1)]));
}

async function run(g, { city = null, resource = 'stone', reads = true, orders = 0, price = '0.001', log = () => {} } = {}) {
  const resType = C.TRADE_RES[resource];
  if (resType === undefined) throw new Error('resource must be food/wood/stone/iron');
  const c = city ? (g.castles || []).find((x) => String(g.castleId(x)) === String(city)) : g.castle();
  if (!c) throw new Error('no such city');
  const cid = g.castleId(c);
  const out = { at: new Date().toISOString(), city: cid, cityName: c.name, resource };

  // ------------------------------------------------------------------ reads
  if (reads) {
    const read = () => ({ resType });
    const seq = await g.lane('trade.searchTrades', () => oneByOne(g, 'trade.searchTrades', Array.from({ length: 10 }, read)));
    out.reads = { oneAtATime: { n: 10, total: seq.total, each: seq.each, median: median(seq.each) }, together: [] };
    log(`reads one at a time: 10 in ${seq.total}ms (median ${median(seq.each)}ms each)`);
    // what the book looks like right now — the cheapest offers and the best bids
    const book = seq.replies.slice().reverse().find((r) => r && (Array.isArray(r.sellers) || Array.isArray(r.buyers)));
    if (book) {
      const lv = (xs, asc) => (xs || []).map((x) => ({ price: Number(x.price), amount: Number(x.amount) }))
        .filter((x) => x.price > 0).sort((a, b) => (asc ? a.price - b.price : b.price - a.price));
      out.book = { asks: lv(book.sellers, true), bids: lv(book.buyers, false) };
      const fmt = (x) => `${(x.amount / 1e6).toFixed(1)}m @ ${x.price}`;
      log(`${resource} book — cheapest offers: ${out.book.asks.slice(0, 5).map(fmt).join(' | ') || 'none'}`);
      log(`${resource} book — best bids: ${out.book.bids.slice(0, 5).map(fmt).join(' | ') || 'none'}`);
    }
    for (const n of [10, 20, 40]) {
      await sleep(1500);
      const b = await g.lane('trade.searchTrades', () => burst(g, 'trade.searchTrades', Array.from({ length: n }, read), 20000 + n * 500));
      out.reads.together.push({ n, total: b.total, replies: b.replies.length, firstAt: b.at[0] ?? null, lastAt: b.at[b.at.length - 1] ?? null });
      log(`reads together: ${n} sent, ${b.replies.length} answered, first after ${b.at[0]}ms, last after ${b.at[b.at.length - 1]}ms`);
      if (b.replies.length < n) { out.reads.stoppedAt = n; log(`  the server stopped answering at ${n} in flight — not pushing further`); break; }
    }
  }

  // ----------------------------------------------------------------- orders
  if (orders > 0) {
    await sleep(1500);
    const cap = 10;              // "10 offers are allowed at level 10 Marketplace"; fewer is reported by the refusals
    const had = new Set((c.trades || []).map((t) => Number(t.id)));
    const free = Math.max(0, cap - had.size);
    const k = Math.min(orders, free);
    out.orders = { requested: orders, openBefore: had.size, perPhase: k };
    if (!k) { out.orders.skipped = `${c.name} has no free offer slot (${had.size} open)`; log(out.orders.skipped); return out; }
    const bid = (amount) => ({ castleId: cid, resType, tradeType: C.TRADE_TYPE.buy, amount, price: String(price) });
    const ours = () => (c.trades || []).filter((t) => !had.has(Number(t.id)));
    const settle = async (want) => { for (let i = 0; i < 40 && ours().length !== want; i++) await sleep(100); };
    const refusals = (rs) => [...new Set(rs.filter((x) => x && x.ok !== 1).map((x) => x.errorMsg || 'ok=' + x.ok))];
    // The PRODUCTION path when the game has one (game.js pipe): that is what the
    // scripts and the sniper send through, so that is what is worth timing.
    const hasPipe = typeof g.pipe === 'function';
    const one = async (cmd, list) => {
      if (!hasPipe) return g.lane(cmd, () => oneByOne(g, cmd, list));
      const each = [], replies = [];
      const t0 = process.hrtime.bigint();
      for (const d of list) {
        const t = process.hrtime.bigint();
        try { replies.push(await g.pipe(cmd, d, 20000)); each.push(r0(ms(t))); } catch (e) { replies.push({ ok: 'noreply', errorMsg: e.message }); each.push(-1); }
      }
      return { total: r0(ms(t0)), each, replies };
    };
    // all in flight, sent `gapMs` apart — 0 is one burst; more is the shape of
    // several cities' scripts each placing an order in its own moment
    const flight = async (cmd, list, gapMs = 0) => {
      if (!hasPipe) {
        const b = await g.lane(cmd, () => burst(g, cmd, list, 20000 + list.length * 500));
        return { total: b.total, replies: b.replies, at: b.at, each: [] };
      }
      const t0 = process.hrtime.bigint();
      const at = [], each = [], ps = [];
      for (const d of list) {
        const t = process.hrtime.bigint();
        ps.push(g.pipe(cmd, d, 20000).then((r) => r, (e) => ({ ok: 'noreply', errorMsg: e.message }))
          .then((r) => { at.push(r0(ms(t0))); each.push(r0(ms(t))); return r; }));
        if (gapMs) await sleep(gapMs);
      }
      const replies = await Promise.all(ps);
      return { total: r0(ms(t0)), replies, at: at.sort((x, y) => x - y), each };
    };
    const cancelAll = async (how) => {
      const list = ours().map((t) => ({ castleId: cid, tradeId: Number(t.id) }));
      if (!list.length) return { n: 0, total: 0, ok: 0 };
      const s = how === 'one' ? await one('trade.cancelTrade', list) : await flight('trade.cancelTrade', list);
      return { n: list.length, total: s.total, ok: s.replies.filter((x) => x && x.ok === 1).length, median: median(s.each) };
    };
    // Did the server make them in the order they were sent? Trade ids rise with
    // creation and every probe order has its own amount, so the ids say.
    const inSendOrder = () => {
      const made = ours().map((t) => ({ id: Number(t.id), amount: Number(t.amount) })).sort((x, y) => x.id - y.id);
      return { ok: made.length > 1 ? made.every((t, i) => i === 0 || t.amount > made[i - 1].amount) : null, made };
    };
    const sock = g.c && g.c.sock;
    const nagle = (on) => { if (sock && typeof sock.setNoDelay === 'function') sock.setNoDelay(!on); };

    try {
      // A: one at a time — amounts 1..k
      const seq = await one('trade.newTrade', Array.from({ length: k }, (_, i) => bid(i + 1)));
      out.orders.oneAtATime = { n: k, total: seq.total, each: seq.each, median: median(seq.each),
        placed: seq.replies.filter((x) => x && x.ok === 1).length, refused: refusals(seq.replies) };
      out.orders.replyShape = shapeOf(seq.replies.find((x) => x && x.ok === 1) || seq.replies[0]);
      log(`A orders one at a time: ${k} in ${seq.total}ms (median ${median(seq.each)}ms each), ${out.orders.oneAtATime.placed} placed`);
      await settle(out.orders.oneAtATime.placed);
      out.orders.cancelOneAtATime = await cancelAll('one');
      log(`  cancels one at a time: ${out.orders.cancelOneAtATime.ok}/${out.orders.cancelOneAtATime.n} in ${out.orders.cancelOneAtATime.total}ms`);
      await settle(0);
      await sleep(1000);

      // B: all in flight at once — amounts 101..
      const b = await flight('trade.newTrade', Array.from({ length: k }, (_, i) => bid(101 + i)));
      out.orders.together = { n: k, total: b.total, arrivals: b.at, placed: b.replies.filter((x) => x && x.ok === 1).length, refused: refusals(b.replies) };
      log(`B orders together: ${k} in ${b.total}ms, ${out.orders.together.placed} placed; arrivals ${b.at.join(', ')}ms`);
      await settle(out.orders.together.placed);
      const ob = inSendOrder();
      out.orders.createdInSendOrder = ob.ok;
      out.orders.created = ob.made;
      log(`  created in the order sent: ${ob.ok}`);
      out.orders.cancelTogether = await cancelAll('together');
      log(`  cancels together: ${out.orders.cancelTogether.ok}/${out.orders.cancelTogether.n} in ${out.orders.cancelTogether.total}ms`);
      await settle(0);

      if (hasPipe) {
        // C/D: sent 40 ms apart with nothing waiting on a reply — the way nine
        // cities' scripts actually trade — first with Nagle's algorithm ON (how
        // the socket was before 2026-09-18), then OFF (how it is now)
        for (const [label, on, base] of [['C staggered, Nagle ON ', true, 201], ['D staggered, Nagle OFF', false, 301]]) {
          await sleep(1000);
          nagle(on);
          const s = await flight('trade.newTrade', Array.from({ length: k }, (_, i) => bid(base + i)), 40);
          const key = on ? 'staggeredNagleOn' : 'staggeredNagleOff';
          out.orders[key] = { n: k, gapMs: 40, total: s.total, each: s.each, median: median(s.each),
            placed: s.replies.filter((x) => x && x.ok === 1).length, refused: refusals(s.replies) };
          log(`${label}: ${k} in ${s.total}ms, each took ${s.each.join(', ')}ms (median ${median(s.each)})`);
          await settle(out.orders[key].placed);
          out.orders[key].createdInSendOrder = inSendOrder().ok;
          await cancelAll('together');
          await settle(0);
        }
      }
    } finally {
      nagle(false);               // whatever happened, leave the socket the way production runs it

      // leave nothing behind
      await settle(0);
      let left = ours();
      for (let i = 0; i < 3 && left.length; i++) {
        await cancelAll('one');
        await settle(0);
        left = ours();
      }
      out.orders.leftBehind = left.map((t) => ({ id: Number(t.id), amount: Number(t.amount), price: t.price }));
      log(left.length ? `!! ${left.length} probe order(s) could not be cancelled: ${left.map((t) => t.id).join(', ')}` : 'every probe order was cancelled');
    }
  }
  return out;
}

module.exports = { run, burst, oneByOne };
