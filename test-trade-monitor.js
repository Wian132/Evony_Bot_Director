'use strict';
// trade-monitor.js: the Director's Trading tab, read off console logs. Offline — the
// logs are written to a temp dir; nothing here reads the live ones.
//
//   node test-trade-monitor.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const TM = require('./trade-monitor');

const tests = [];
const t = (n, f) => tests.push([n, f]);

// the lines as the consoles write them (2026-09-18)
const L = {
  many: '[autorun 7] 13:42:45.820 line 18: sell iron 99999999 1 x10 · 10 × sell 99,999,999 iron @ 1 from 2 · a 500,000 gold fee (0.5%) each — 10 of 10 placed · 220 refused since the last one placed',
  some: '[autorun 4] 14:40:35.022 line 18: sell iron 99999999 1 x10 · 10 × sell 99,999,999 iron @ 1 from 4 · a 500,000 gold fee (0.5%) each — 5 of 10 placed (5 refused: no reply to trade.newTrade; no reply to trade.newTrade (server is',
  none: '[autorun 1] 14:40:08.254 line 18: sell iron 99999999 1 x10 · 10 × sell 99,999,999 iron @ 1 from 1 -> none placed: no reply to trade.newTrade (the connection closed before it was sent); the script carries on (10 refused so far)',
  one: '[autorun 3] 13:49:00.871 line 18: sell iron 99999999 0.5 x1 · sell 99,999,999 iron @ 0.5 from 3 · a 250,000 gold fee (0.5%) — placed',
  fresh: '[autorun 10] 12:16:32.561 line 10: echo "FRESHSTART " + side + " food " + city.resource.food.amount + " wood " + city.resource.wood.amount + " stone " + city.resource.stone.amount + " iron " + city.resource.iron.amount · FRESHSTART sell food 714021725818.2557 wood 435294887718.18176 stone 4500650.091674805 iron 314107126.89335585',
  sitout: '[autorun 6] 16:58:16.437 line 15: if sitout == 1 && sat != 1 echo "SITOUT " + side + " " + res + " — over the cap, sitting out" · SITOUT buy food — over the cap, sitting out',
  back: '[autorun main] 16:58:17.540 line 16: if sitout != 1 && sat == 1 echo "SITOUT over — trading again" · SITOUT over — trading again',
  conn: '[conn] 14:40:34.417 three commands in a row unanswered — ignoring this account? (18 market writes in flight, 10 waiting)',
  sleep: '[autorun 7] 13:42:56.371 line 25: sleep 0.3',
};

t('each kind of line reads as what it is', () => {
  const P = TM.parseLine;
  assert.deepStrictEqual(P(L.many), { kind: 'order', tod: P(L.many).tod, city: '7', side: 'sell', res: 'iron', price: '1', placed: 10, refused: 0 });
  assert.strictEqual(P(L.many).tod, ((13 * 60 + 42) * 60 + 45) * 1000 + 820);
  assert.deepStrictEqual([P(L.some).placed, P(L.some).refused], [5, 5]);
  assert.deepStrictEqual([P(L.none).placed, P(L.none).refused], [0, 10]);
  assert.deepStrictEqual([P(L.one).placed, P(L.one).price, P(L.one).city], [1, '0.5', '3']);
  const f = P(L.fresh);
  assert.strictEqual(f.kind, 'fresh');
  assert.strictEqual(Math.round(f.res.food / 1e9), 714);
  assert.deepStrictEqual([P(L.sitout).kind, P(L.sitout).out, P(L.sitout).res, P(L.sitout).city], ['sitout', true, 'food', '6']);
  assert.deepStrictEqual([P(L.back).out, P(L.back).city], [false, 'main']);
  assert.strictEqual(P(L.conn).kind, 'conn');
  assert.strictEqual(P(L.sleep), null);
});

t('a tail read dates the lines back from now, across midnight', () => {
  const now = new Date(2026, 8, 18, 0, 10).getTime();            // 00:10
  const evs = [{ tod: (23 * 60 + 50) * 60000 }, { tod: (23 * 60 + 59) * 60000 }, { tod: 5 * 60000 }];
  TM.dateBackwards(evs, now);
  assert.strictEqual(new Date(evs[2].t).getDate(), 18);
  assert.strictEqual(new Date(evs[0].t).getDate(), 17, 'the lines before midnight are the day before');
  const e = TM.dateForward({ tod: (23 * 60 + 58) * 60000 }, now);
  assert.strictEqual(new Date(e.t).getDate(), 17, 'a line that would be in the future is yesterday\'s');
});

function world(lines, hhmm = [17, 30]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-tm-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'scripts', 'glitch-res-control.txt'),
    'res = "food"\nprice = 0.5\nprevRes = "iron"\nplay = "auto"\ncapRes = 400000000000\ncapGold = 40000000000000\nfoodCap = 950000000000\n');
  for (const [id, ls] of Object.entries(lines)) fs.writeFileSync(path.join(dir, `console-${id}.log`), ls.join('\n') + '\n');
  const now = new Date(2026, 8, 18, hhmm[0], hhmm[1]).getTime();
  return { dir, mon: new TM.Monitor({ dir, now: () => now }), now };
}
// 'canceltrade buy' takes this city's own resting bids back off the book: not a fill.
const cancelled = (hms, city, n) =>
  `[autorun ${city}] ${hms}.000 line 53: canceltrade buy · cancelled ${n} of ${n} offer(s) in ${city}`;
const noBids = (hms, city) =>
  `[autorun ${city}] ${hms}.000 line 53: canceltrade buy · ${city} has no open bids to cancel`;

const at = (hms, city, side, res, price, n) =>
  `[autorun ${city}] ${hms}.000 line 24: ${side} ${res} 99999999 ${price} x${n} · ${n} × ${side} 99,999,999 ${res} @ ${price} from ${city} · a fee — ${n} of ${n} placed`;

t('the report: return per bucket and reading, the play totals, each account', () => {
  const { dir, mon } = world({
    h1: [at('17:05:10', '1', 'sell', 'iron', '1', 10), at('17:21:00', '1', 'sell', 'food', '0.5', 10), at('17:22:00', '2', 'sell', 'food', '0.5', 10),
      L.fresh.replace('12:16:32', '17:08:40')],
    o1: [at('17:21:30', '3', 'buy', 'food', '0.5', 10), at('17:28:00', '3', 'buy', 'food', '0.5', 5), L.sitout.replace('16:58:16', '17:20:00')],
  });
  const r = TM.report(mon, [{ id: 'h1', label: 'Lord06', holiday: true }, { id: 'o1', label: 'Lord04', holiday: false }], { minutes: 30, dir });
  assert.strictEqual(r.control.res, 'food');
  assert.strictEqual(r.control.kind, 'res');
  const b = r.buckets.find((x) => new Date(x.t).getMinutes() === 20);
  assert.deepStrictEqual([b.hol, b.ours, b.pct], [20, 10, 50]);
  assert.deepStrictEqual(r.total && [r.total.res, r.total.hol, r.total.ours, r.total.pct], ['food', 20, 15, 75], 'the iron before the switch is not food');
  const h = r.accounts.find((a) => a.id === 'h1');
  assert.deepStrictEqual([h.side, h.placed10, h.active, h.freshCities], ['sell', 20, 2, 1]);
  assert.strictEqual(Math.round(h.fresh.food / 1e9), 714);
  const o = r.accounts.find((a) => a.id === 'o1');
  assert.deepStrictEqual(o.sitting.map((s) => [s.city, s.res]), [['6', 'food']]);
  const rd = r.readings.find((x) => new Date(x.t).getMinutes() === 20);
  assert.deepStrictEqual([rd.hol, rd.ours, rd.pct], [20, 15, 75]);
});

// The user, 2026-09-24: 'are we buying someone elses stone?' — the tab said ours bought
// 235.98t against 66.20t the banks had sold, and a return of 1072%. Our buying side
// recycles its slots, so most of that was the same bids placed over and over.
t('a cancelled bid is not a fill: our side counts placed MINUS cancelled', () => {
  const { dir, mon } = world({
    h1: [at('17:21:00', '1', 'sell', 'food', '0.5', 10)],
    o1: [at('17:21:30', '3', 'buy', 'food', '0.5', 10), cancelled('17:22:00', '3', 8),
      at('17:23:00', '3', 'buy', 'food', '0.5', 10), noBids('17:23:30', '4')],
  });
  const who = [{ id: 'h1', label: 'Lord06', holiday: true }, { id: 'o1', label: 'Lord04', holiday: false }];
  const r = TM.report(mon, who, { minutes: 30, dir });
  // ours: 10 + 10 placed, 8 taken back = 12 traded, against the bank's 10
  assert.deepStrictEqual([r.total.hol, r.total.ours, r.total.pct], [10, 12, 120], 'placed less cancelled');
  const b = r.buckets.find((x) => new Date(x.t).getMinutes() === 20);
  assert.deepStrictEqual([b.hol, b.ours], [10, 12], 'the buckets too');
  const rd = r.readings.find((x) => new Date(x.t).getMinutes() === 20);
  assert.deepStrictEqual([rd.hol, rd.ours], [10, 12], 'and the 10-minute readings');
  const o = r.accounts.find((a) => a.id === 'o1');
  assert.strictEqual(o.placed10, 20, 'the per-minute activity still counts every order sent');
  assert.strictEqual(o.cancelled10, 8, 'and says how many were taken back');
});

t('a side that cancels more than it placed reads as nothing, never as a negative', () => {
  const { dir, mon } = world({
    h1: [at('17:21:00', '1', 'sell', 'food', '0.5', 10)],
    o1: [at('17:21:30', '3', 'buy', 'food', '0.5', 4), cancelled('17:22:00', '3', 9)],
  });
  const r = TM.report(mon, [{ id: 'h1', label: 'A', holiday: true }, { id: 'o1', label: 'B', holiday: false }], { minutes: 30, dir });
  assert.strictEqual(r.total.ours, 0);
  assert.strictEqual(r.buckets.find((x) => new Date(x.t).getMinutes() === 20).ours, 0);
});

t('what a log gains later is read on the next call, and only that', () => {
  const { dir, mon } = world({ o1: [at('17:21:30', '3', 'buy', 'food', '0.5', 10)] });
  assert.strictEqual(mon.events('o1').length, 1);
  fs.appendFileSync(path.join(dir, 'console-o1.log'), at('17:29:00', '4', 'buy', 'food', '0.5', 3) + '\n' + '[autorun 4] 17:29:01.000 line 24: sel');
  const evs = mon.events('o1');
  assert.strictEqual(evs.length, 2, 'the half-written line waits');
  fs.appendFileSync(path.join(dir, 'console-o1.log'), 'l food 99999999 0.5 x1 · sell 99,999,999 food @ 0.5 from 4 · fee — placed\n');
  assert.strictEqual(mon.events('o1').length, 3, 'and is read once it is finished');
});

t('a stopped play (end on the first line) is reported as stopped', () => {
  const { dir } = world({});
  fs.writeFileSync(path.join(dir, 'scripts', 'glitch-res-control.txt'), 'end\nres = "food"\nprice = 1\n');
  assert.strictEqual(TM.readControl(dir).stopped, true);
  assert.strictEqual(TM.readControl(dir).price, 1);
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log('  ok    ' + n); pass++; } catch (e) { console.log('  FAIL  ' + n + '\n        ' + String(e.message).split('\n').slice(0, 8).join('\n        ')); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
