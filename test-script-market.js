'use strict';
// The market in scripts, offline: buy, sell, canceltrade, marketupdate,
// dumpresource, the price functions, the Market page's objects and the wiki's
// STS trading script. The Game is real (game.js's market helpers, their lanes,
// troopParams, the army bean); only game.req and newArmy are stubbed, and every
// line goes through script.parse + script.run.
const assert = require('assert');
const C = require('./constants');
const { Game } = require('./game');
const script = require('./script');
const M = require('./script-cmd-market');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const F = (x, y) => C.coordsToFieldId(x, y);
const RES = ['food', 'wood', 'stone', 'iron'];
const parseErr = (line) => { try { script.parseLine(line); } catch (e) { return e.message; } return null; };

// The book per resource, as trade.searchTrades answers it (MarketTradeBean
// {amount, price}); food's comes unsorted on purpose.
const BOOKS = () => ({
  food: { buyers: [{ price: 9.5, amount: 3e6 }, { price: 10, amount: 2e6 }, { price: 9, amount: 10e6 }],
    sellers: [{ price: 12.5, amount: 4e6 }, { price: 12, amount: 1e6 }] },
  wood: { buyers: [{ price: 20, amount: 1e6 }], sellers: [{ price: 21, amount: 1e6 }] },
  stone: { buyers: [{ price: 15.62, amount: 5e5 }], sellers: [{ price: 16, amount: 5e5 }] },
  iron: { buyers: [{ price: 30, amount: 1e6 }], sellers: [{ price: 31, amount: 1e6 }] },
});

// City 9 (id 1) and Fla (id 2). game.req answers the market and troop-param
// reads, and pushes what the server would (a new offer on the city's list, a
// cancelled one off it) unless pushes is false. replies[cmd] = queued answers.
function world({ books = BOOKS(), gold = 50e6, res = {}, trades = [], transit = [], carriage = 100,
  replies = {}, pushes = true, buildings = [], loadSkill = 0, at = [571, 648] } = {}) {
  const g = new Game();
  g.player = { playerInfo: { userName: 'Lord02' }, selfArmys: [], enemyArmys: [], friendArmys: [], items: [], buffs: [] };
  const r = { food: 5e6, wood: 5e6, stone: 5e6, iron: 5e6, ...res };
  const resource = (gl) => ({ gold: gl, food: { amount: r.food }, wood: { amount: r.wood }, stone: { amount: r.stone },
    iron: { amount: r.iron }, troopCostFood: 0, herosSalary: 0, complaint: 0 });
  const castle = { id: 1, name: '9', fieldId: F(at[0], at[1]), heros: [], troop: { carriage }, buildings,
    trades: trades.map((x) => ({ ...x })), transingTrades: transit.map((x) => ({ ...x })), resource: resource(gold) };
  const other = { id: 2, name: 'Fla', fieldId: F(484, 619), heros: [], troop: {}, buildings: [], trades: [], transingTrades: [], resource: resource(1e6) };
  g.castles = [castle, other];
  const sent = [];
  let nextId = 5000;
  const cityOf = (id) => g.castles.find((c) => g.castleId(c) === id);
  g.req = async (cmd, data) => {
    sent.push({ cmd, ...data, at: Date.now() });
    const queued = replies[cmd] && replies[cmd].length ? replies[cmd].shift() : undefined;
    if (queued instanceof Error) throw queued;
    switch (cmd) {
      case 'trade.searchTrades': return queued || { ok: 1, ...books[RES[data.resType]] };
      case 'trade.newTrade': {
        const rep = queued || { ok: 1 };
        if (rep.ok === 1 && pushes) {
          cityOf(data.castleId).trades.push({ id: nextId++, tradeType: data.tradeType, resType: data.resType, amount: data.amount, dealedAmount: 0, price: Number(data.price) });
        }
        return rep;
      }
      case 'trade.cancelTrade': {
        const rep = queued || { ok: 1 };
        if (rep.ok === 1 && pushes) { const c = cityOf(data.castleId); c.trades = c.trades.filter((x) => x.id !== data.tradeId); }
        return rep;
      }
      case 'army.getTroopParam': return queued || { ok: 1, loadSkillParam: loadSkill, marchSkillParam: 0 };
      default: throw new Error('unexpected request ' + cmd);
    }
  };
  g.newArmy = async (castleId, bean) => { sent.push({ cmd: 'army.newArmy', castleId, bean }); return { ok: 1 }; };
  const of = (cmd) => sent.filter((s) => s.cmd === cmd);
  return { g, sent, of, castle, other };
}

const BASE = { castle: '9', repeatGapMs: 0, tradeGapMs: 0, marketRetryMs: 5, marketSettleMs: 300 };
async function runIn(w, src, opts = {}) {
  const out = [];
  const list = script.parse(src, opts);
  const errs = list.filter((a) => a.cmd === 'error');
  if (errs.length && !opts.allowErrors) throw new Error('parse errors: ' + JSON.stringify(errs));
  const done = await script.run(w.g, list, (m) => out.push(m), { ...BASE, ...opts });
  return { done, out, text: out.join('\n') };
}
// the lines the script printed itself (echo), without the headers
const echoed = (r) => r.out.filter((l) => /^ {2}\S/.test(l)).map((l) => l.slice(2));

// ---------------------------------------------------------------------------
section('buy and sell: what each line means');

t("the wiki's own lines read as NEAT means them (Buy, Sell, Market, Kento11)", () => {
  const a = (l) => { const x = script.parseLine(l); return [x.cmd, x.resource, x.amount, x.price]; };
  assert.deepStrictEqual(a('buy food 10000 6'), ['buy', 'food', 10000, '6']);
  assert.deepStrictEqual(a('sell food 20000 8'), ['sell', 'food', 20000, '8']);
  assert.deepStrictEqual(a('4: sell food 1000 1'), ['sell', 'food', 1000, '1']);
  assert.deepStrictEqual(a('buy iron 1000 1'), ['buy', 'iron', 1000, '1']);
  assert.deepStrictEqual(a('buy food 9999999 5'), ['buy', 'food', 9999999, '5']);
});
t('resource numbers 0-3, lumber, k/m/b amounts and the @price keep working', () => {
  const a = (l) => { const x = script.parseLine(l); return [x.cmd, x.resource, x.amount, x.price]; };
  assert.deepStrictEqual(a('sell 2 12345 15.62'), ['sell', 'stone', 12345, '15.62']);
  assert.deepStrictEqual(a('buy 0 5m 22.5'), ['buy', 'food', 5e6, '22.5']);
  assert.deepStrictEqual(a('buy 3 1.5k 7'), ['buy', 'iron', 1500, '7']);
  assert.deepStrictEqual(a('sell 1 1b 7'.replace('1b', '20k')), ['sell', 'wood', 20000, '7']);
  assert.deepStrictEqual(a('buy lumber 1.5m @6'), ['buy', 'wood', 1.5e6, '6']);
  assert.deepStrictEqual(a('sell wood 1000 @0.55'), ['sell', 'wood', 1000, '0.55']);
  assert.deepStrictEqual(a('buy stone 99999999 @0.11'), ['buy', 'stone', 99999999, '0.11']);
  assert.deepStrictEqual(a('buy food 10,000 6'), ['buy', 'food', 10000, '6']);
});
t('prices are sent the way the price box takes them: a buy rounds down, a sell up', () => {
  assert.deepStrictEqual([script.parseLine('sell 2 1 15.623456').price, script.parseLine('buy 2 1 15.623456').price], ['15.63', '15.62']);
  assert.deepStrictEqual([script.parseLine('sell 0 1 0.0005').price, script.parseLine('buy 0 1 0.0015').price], ['0.001', '0.001']);
  assert.strictEqual(script.parseLine('sell 0 1 99.9999').price, '100');
  assert.strictEqual(script.parseLine('sell 0 1 15.62').asked, undefined, 'a price that fits is not marked');
  assert.strictEqual(script.parseLine('sell 0 1 15.625').asked, '15.625');
});
t('what is refused before the script runs says what to write', () => {
  assert.match(parseErr('buy food 1000'), /say the price too/);
  assert.match(parseErr('buy gold 1000 5'), /gold is not traded on the market/);
  assert.match(parseErr('sell sand 1000 5'), /"sand" is not a market resource/);
  assert.match(parseErr('sell 4 1000 5'), /"4" is not a market resource/);
  assert.match(parseErr('buy food 1b 5'), /more than one order takes \(99,999,999/);
  assert.match(parseErr('buy food 0 5'), /at least 1/);
  assert.match(parseErr('sell food 1000 151'), /at most 150/);
  assert.match(parseErr('sell food 1000 0'), /over 0/);
  assert.match(parseErr('buy food 1000 0.0004'), /under 0\.001/);
  assert.match(parseErr('buy food lots 5'), /not an amount/);
  assert.match(parseErr('buy food 1000 cheap'), /not a price/);
});

// ---------------------------------------------------------------------------
section('buy and sell: what gets sent');

t('buy food 10000 6 is trade.newTrade {castleId, resType 0, tradeType 0, amount, price "6"}', async () => {
  const w = world();
  const r = await runIn(w, 'buy food 10000 6');
  assert.deepStrictEqual(w.of('trade.newTrade').map(({ castleId, resType, tradeType, amount, price }) => ({ castleId, resType, tradeType, amount, price })),
    [{ castleId: 1, resType: 0, tradeType: 0, amount: 10000, price: '6' }]);
  assert.match(r.text, /buy 10,000 food @ 6 from 9 · 60,300 gold with the 0\.5% fee — placed/);
  assert.strictEqual(r.done, 1);
});
t('sell 2 12345 15.623456 offers stone at 15.63 and says why', async () => {
  const w = world();
  const r = await runIn(w, 'sell 2 12345 15.623456');
  const s = w.of('trade.newTrade')[0];
  assert.deepStrictEqual([s.resType, s.tradeType, s.amount, s.price], [2, 1, 12345, '15.63']);
  assert.match(r.text, /15\.623456 does not fit the market's 5-character price box: offered at 15\.63, never under the price given/);
});
t('a dry run says what would go out and sends nothing', async () => {
  const w = world();
  const r = await runIn(w, 'buy food 10000 6\nsell wood 5k @21', { dryRun: true });
  assert.strictEqual(w.of('trade.newTrade').length, 0);
  assert.strictEqual((r.text.match(/\[dry run\] not sent/g) || []).length, 2);
});
t('NEAT\'s -maxtrade start-up parameter: an order over it is not sent, one at it is', async () => {
  const w = world();
  const r = await runIn(w, 'sell food 1000 5\nsell food 500 5', { config: { maxtrade: '500' } });
  const sent = w.of('trade.newTrade');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].amount ?? (sent[0].data || {}).amount, 500);
  assert.match(r.text, /not sent — more than one order may be for \(-maxtrade 500\)/);
});
t('market writes are paced by tradeGapMs', async () => {
  const w = world();
  await runIn(w, 'buy food 1 6\nsell food 1 8', { tradeGapMs: 60 });
  const [a, b] = w.of('trade.newTrade');
  assert.ok(b.at - a.at >= 55, 'gap ' + (b.at - a.at));
});
t('x5 on a sell line places five orders at once; $result is how many were placed', async () => {
  const w = world();
  const r = await runIn(w, 'sell stone 1 140 x5\necho "n=" + $result + " e=" + $error');
  assert.strictEqual(w.of('trade.newTrade').length, 5);
  assert.ok(w.of('trade.newTrade').every((s) => s.amount === 1 && s.price === '140' && s.tradeType === 1));
  assert.match(r.text, /5 × sell 1 stone @ 140 from 9 · a 0\.7 gold fee \(0\.5%\) each — 5 of 5 placed/);
  assert.match(r.text, /n=5 e=(null|)$/m);
});
t('a batch that is partly refused says how many went and why the rest did not', async () => {
  const FULL = { ok: -38, errorMsg: '10 offers are allowed at level 10 Marketplace.' };
  const w = world({ replies: { 'trade.newTrade': [{ ok: 1 }, FULL, FULL, { ok: 1 }, FULL] } });
  const r = await runIn(w, 'buy food 1 6 *5\necho "n=" + $result + " e=" + $error');
  assert.match(r.text, /2 of 5 placed \(3 refused: FAILED \(ok=-38\) - 10 offers are allowed at level 10 Marketplace\. — marketplace full/);
  assert.match(r.text, /n=2 e=(null|)$/m, 'some went through: the line did its job');
});
t('a batch that is refused whole never ends the run, and says so once', async () => {
  const FULL = { ok: -38, errorMsg: '10 offers are allowed at level 10 Marketplace.' };
  const w = world({ replies: { 'trade.newTrade': Array.from({ length: 60 }, () => FULL) } });
  const r = await runIn(w, 'sell stone 1 140 x5\nrepeat 12\necho "after"');
  assert.strictEqual(w.of('trade.newTrade').length, 60);
  assert.doesNotMatch(r.text, /refused 10 times in a row/);
  assert.strictEqual((r.text.match(/none placed/g) || []).length, 1, 'the same refusal is said once');
  assert.match(r.text, /after$/m);
});
t('x21 is refused before the script runs; a dry run of x5 sends nothing', async () => {
  assert.match(parseErr('sell stone 1 140 x21'), /between x1 and x20/);
  const w = world();
  const r = await runIn(w, 'sell stone 1 140 x5', { dryRun: true });
  assert.strictEqual(w.of('trade.newTrade').length, 0);
  assert.match(r.text, /5 × sell 1 stone @ 140 from 9 · a 0\.7 gold fee \(0\.5%\) each when it is placed/);
});
t('a refusal sets $error, and a line that works clears it', async () => {
  const w = world({ replies: { 'trade.newTrade': [{ ok: -38, errorMsg: '10 offers are allowed at level 10 Marketplace.' }] } });
  const r = await runIn(w, 'buy food 1 6\necho "e1=" + $error\nbuy food 1 6\necho "e2=" + $error');
  assert.match(r.text, /marketplace full \(10 offers max\); the script carries on/);
  assert.match(r.text, /e1=FAILED \(ok=-38\) - 10 offers are allowed/);
  assert.match(r.text, /e2=(null|)$/m);
});

// ---------------------------------------------------------------------------
section('prices: BuyPrice, SellPrice, Price');

t('BuyPrice is the highest bid, SellPrice the cheapest offer (0-3 or a name)', async () => {
  const w = world();
  const r = await runIn(w, 'echo BuyPrice(0) SellPrice(0) BuyPrice(2) SellPrice(3) SellPrice("iron") buyprice(1)');
  assert.deepStrictEqual(echoed(r), ['10 12 15.62 31 31 20']);
});
t('amount and method: 0 is the price that fills it now, 1 the average; too thin is NaN', async () => {
  const w = world();
  const r = await runIn(w, [
    'echo BuyPrice(0, 1) BuyPrice(0, 2m) BuyPrice(0, 3m) BuyPrice(0, 3m, 1)',
    'echo SellPrice(0, 2m) SellPrice(0, 2m, 1) SellPrice(0, 5m, 0) SellPrice(0, 6m)',
    'echo BuyPrice(0, 100m) BuyPrice(0, 100m, 1)',
  ].join('\n'));
  assert.deepStrictEqual(echoed(r), ['10 10 9.5 9.83333333333', '12.5 12.25 12.5 NaN', 'NaN NaN']);
});
t('Price(res, q) runs from the best bid (0) to the best offer (1)', async () => {
  const w = world();
  const r = await runIn(w, 'aggr = 2%\necho Price(0, 0) Price(0, 1) Price(0, aggr) Price(0, 1 - aggr) Price("food", 50%)');
  assert.deepStrictEqual(echoed(r), ['10 12 10.04 11.96 11']);
});
t('an empty side is NaN, so a price test is false rather than a buy at any price', async () => {
  const b = BOOKS();
  b.stone = { buyers: [], sellers: [] };
  b.iron = { buyers: [{ price: 30, amount: 1 }], sellers: [] };
  const w = world({ books: b });
  const r = await runIn(w, 'echo BuyPrice(2) SellPrice(3) Price(3, 2%) Price(3, 0)\nifgoto SellPrice(2) <= 5 buy\necho "no buy"\nend\nlabel buy\nbuy stone 1000 5');
  assert.deepStrictEqual(echoed(r), ['NaN NaN NaN 30', 'no buy']);
  assert.strictEqual(w.of('trade.newTrade').length, 0);
});
t('m_context.buyPrice/sellPrice, city.buyPrice and cityManager.sellPrice(food) are the same prices', async () => {
  const w = world();
  const r = await runIn(w, [
    'echo m_context.buyPrice(0) m_context.sellPrice(0)',
    'echo "food costs"city.buyPrice(2)',
    'echo "–sellPrice food " + m_city.cityManager.sellPrice(food)',
    'echo m_city.cityManager.buyPrice()',
  ].join('\n'));
  assert.deepStrictEqual(echoed(r), ['10 12', 'food costs 15.62', '–sellPrice food 12', '10']);
});
t('a price function is a value: ask = m_context.buyPrice (Unsorted 2629, example 4)', async () => {
  const w = world();
  const r = await runIn(w, [
    'ask = m_context.buyPrice // note, buyPrice is a function!',
    'res = 0',
    'label resloop',
    'echo "Current " + ResourceNames[res] + " price is " + ask(res)',
    'res = res + 1',
    'if res < 4 goto resloop',
  ].join('\n'));
  assert.deepStrictEqual(echoed(r), ['Current Food price is 10', 'Current Wood price is 20', 'Current Stone price is 15.62', 'Current Iron price is 30']);
});
t('a resource nobody set, beside an amount, is an error that says to quote it', async () => {
  const w = world();
  const r = await runIn(w, 'x = BuyPrice(iron, 1m)\necho "e=" + $error');
  assert.match(r.text, /BuyPrice: which resource\? .*BuyPrice\("iron", 1m\)/);
});
t('one read per resource while it is fresh; read again once it is not', async () => {
  const w = world();
  await runIn(w, 'a = BuyPrice(0)\nb = SellPrice(0)\nc = Price(0, 2%)', { marketFreshMs: 60000 });
  assert.strictEqual(w.of('trade.searchTrades').length, 1);
  const w2 = world();
  await runIn(w2, 'a = BuyPrice(0)\nsleep 0.05\nb = SellPrice(0)', { marketFreshMs: 20 });
  assert.strictEqual(w2.of('trade.searchTrades').length, 2);
});
t('our own order makes that book stale: the next price reads it again', async () => {
  const w = world();
  await runIn(w, 'a = BuyPrice(0)\nsell food 1000 12\nb = BuyPrice(0)', { marketFreshMs: 60000 });
  assert.deepStrictEqual(w.of('trade.searchTrades').map((s) => s.resType), [0, 0]);
});
t('a failed read leaves the last known price', async () => {
  // the first answer is the book; the second read throws
  const w = world({ replies: { 'trade.searchTrades': [undefined, new Error('no reply to trade.searchTrades')] } });
  const r = await runIn(w, 'echo BuyPrice(1)\nsleep 0.05\necho BuyPrice(1)', { marketFreshMs: 20 });
  assert.deepStrictEqual(echoed(r), ['20', '20']);
  assert.strictEqual(w.of('trade.searchTrades').length, 2);
});

// ---------------------------------------------------------------------------
section('m_context.marketReady()');

t('it reads the four books itself and is then true', async () => {
  const w = world();
  const r = await runIn(w, 'label notready\nif !m_context.marketReady() goto notready\necho "ready"');
  assert.deepStrictEqual(echoed(r), ['ready']);
  assert.deepStrictEqual(w.of('trade.searchTrades').map((s) => s.resType), [0, 1, 2, 3]);
});
t('false after a relogin until the new connection has read all four', async () => {
  const w1 = world();
  const w2 = world({ replies: { 'trade.searchTrades': [new Error('no reply'), new Error('no reply'), new Error('no reply'), new Error('no reply')] } });
  let game = w1.g;
  const ctx = { get game() { return game; }, opts: { marketRetryMs: 5 } };
  const m = M.market(ctx);
  assert.strictEqual(await m.marketReady(), true);
  game = w2.g;                                        // the session logged in again
  assert.strictEqual(await m.marketReady(), false, 'the new connection has read nothing yet');
  assert.ok(Number.isNaN(await m.buyPrice(0)), 'no price is carried over from the old connection');
  const w3 = world();
  game = w3.g;
  assert.strictEqual(await m.marketReady(), true);
  assert.strictEqual(M.market(ctx), m, 'the same functions for one run');
});
t('while the market does not answer it waits a moment and says false (no spinning), and Stop ends the loop', async () => {
  const w = world();
  w.g.searchTrades = async () => { throw new Error('socket closed'); };
  const t0 = Date.now();
  const r = await runIn(w, 'label notready\nif !m_context.marketReady() goto notready\necho "ready"',
    { marketRetryMs: 40, shouldStop: () => Date.now() - t0 > 300 });
  assert.doesNotMatch(r.text, /ready\n/);
  assert.match(r.text, /stopped/);
});

// ---------------------------------------------------------------------------
section('the Market page: city.tradesArray and transingTradesArray');

t('every field the page names, with the names a push leaves out filled in', async () => {
  const w = world({
    trades: [{ id: 101, tradeType: 0, resType: 1, amount: 5000, dealedAmount: 1200, dealedTotal: 24000, price: 20 },
      { id: 102, tradeType: 1, resType: 3, amount: 700, dealedAmount: 0, price: 33.5, resourceName: 'Iron', tradeTypeName: 'Offer' }],
    transit: [{ id: 7, resType: 0, amount: 9000, price: 10, total: 90000, endTime: 1757800000000 }],
  });
  const r = await runIn(w, [
    'echo city.tradesArray.length',
    't = city.tradesArray[0]',
    'echo t.amount t.resType t.tradeType t.resourceName t.price t.id t.tradeTypeName t.dealedAmount t.dealedTotal',
    'echo m_city.cityManager.tradesArray[1].resourceName m_city.cityManager.tradesArray[1].tradeTypeName',
    'echo city.transingTradesArray.length',
    'p = city.transingTradesArray[0]',
    'echo p.amount p.endTime p.resourceName p.price p.total p.id p.resType',
  ].join('\n'));
  assert.deepStrictEqual(echoed(r), ['2', '5000 1 0 Lumber 20 101 Bid 1200 24000', 'Iron Offer', '1', '9000 1757800000000 Food 10 90000 7 0']);
});
t('the copies never reach the city: a script changing one changes nothing', async () => {
  const w = world({ trades: [{ id: 101, tradeType: 0, resType: 0, amount: 5000, price: 20 }] });
  await runIn(w, 't = city.tradesArray[0]\nt.price = 1');
  assert.strictEqual(w.castle.trades[0].price, 20);
});

// ---------------------------------------------------------------------------
section('canceltrade');

const OFFERS = () => [
  { id: 101, tradeType: 0, resType: 0, amount: 5000, dealedAmount: 0, price: 10 },
  { id: 102, tradeType: 1, resType: 3, amount: 700, dealedAmount: 200, price: 33 },
  { id: 103, tradeType: 1, resType: 0, amount: 1000, dealedAmount: 0, price: 12 },
];
t('canceltrade cancels every open offer of this city; $result is how many', async () => {
  const w = world({ trades: OFFERS() });
  const r = await runIn(w, 'canceltrade\necho "n=" + $result');
  assert.deepStrictEqual(w.of('trade.cancelTrade').map((s) => [s.castleId, s.tradeId]), [[1, 101], [1, 102], [1, 103]]);
  assert.strictEqual(w.castle.trades.length, 0);
  assert.match(r.text, /cancelled 3 of 3 offer\(s\) in 9 · about 393 gold in fees stays paid/);
  assert.match(r.text, /n=3/);
});
t('execute "canceltrade " + city.tradesArray[0].id cancels the oldest only', async () => {
  const w = world({ trades: OFFERS() });
  const r = await runIn(w, 'execute "canceltrade " + city.tradesArray[0].id\necho city.tradesArray.length');
  assert.deepStrictEqual(w.of('trade.cancelTrade').map((s) => s.tradeId), [101]);
  assert.deepStrictEqual(echoed(r).slice(-1), ['2'], 'the push is waited for, so the next line sees the list without it');
});
t('canceltrade buy | sell | <resource> | sell food pick among this city\'s offers', async () => {
  const pick = async (line) => { const w = world({ trades: OFFERS() }); await runIn(w, line); return w.of('trade.cancelTrade').map((s) => s.tradeId); };
  assert.deepStrictEqual(await pick('canceltrade buy'), [101]);
  assert.deepStrictEqual(await pick('canceltrade sell'), [102, 103]);
  assert.deepStrictEqual(await pick('canceltrade food'), [101, 103]);
  assert.deepStrictEqual(await pick('canceltrade sell food'), [103]);
  assert.deepStrictEqual(await pick('canceltrade all'), [101, 102, 103]);
  assert.deepStrictEqual(await pick('canceltrade 103 101'), [103, 101]);
  assert.match(parseErr('canceltrade soon'), /not a trade id, buy, sell or a resource/);
  assert.match(parseErr('canceltrade 101 food'), /not both/);
});
t('an id this city does not have is refused, naming its offers; one in another city is cancelled there', async () => {
  const w = world({ trades: OFFERS() });
  w.other.trades = [{ id: 900, tradeType: 0, resType: 2, amount: 10, price: 1 }];
  const r = await runIn(w, 'canceltrade 555\necho "e=" + $error\ncanceltrade 900');
  assert.match(r.text, /FAILED: 9 has no open offer 555 — its offers are 101, 102, 103/);
  assert.match(r.text, /e=9 has no open offer 555/);
  assert.deepStrictEqual(w.of('trade.cancelTrade').map((s) => [s.castleId, s.tradeId]), [[2, 900]]);
  assert.match(r.text, /cancelled 1 of 1 offer\(s\) in Fla/);
});
t('nothing to cancel is no error; a dry run lists what would go and sends nothing', async () => {
  const w = world();
  const r = await runIn(w, 'canceltrade\necho "n=" + $result + " e=" + $error');
  assert.match(r.text, /9 has no open offers to cancel/);
  assert.match(r.text, /n=0 e=(null|)$/m);
  const d = world({ trades: OFFERS() });
  const rd = await runIn(d, 'canceltrade sell', { dryRun: true });
  assert.strictEqual(d.of('trade.cancelTrade').length, 0);
  assert.match(rd.text, /cancel offer of 700 iron[\s\S]*cancel offer of 1,000 food[\s\S]*\[dry run\] not sent/);
});
t('a refused cancel sets $error; a missing push does not hang the line', async () => {
  const w = world({ trades: OFFERS(), replies: { 'trade.cancelTrade': [{ ok: -1, errorMsg: 'trade not found' }] } });
  const r = await runIn(w, 'canceltrade 101\necho "e=" + $error');
  assert.match(r.text, /none of the 1 offer\(s\) in 9 were cancelled: FAILED \(ok=-1\) - trade not found/);
  assert.match(r.text, /e=1 of 1 offer\(s\) not cancelled/);
  const slow = world({ trades: OFFERS(), pushes: false });
  const t0 = Date.now();
  await runIn(slow, 'canceltrade 101', { marketSettleMs: 150 });
  assert.ok(Date.now() - t0 < 1500);
});
t('BuildingFunctions: if city.tradesArray.length == city.getBuildingLevel(23) canceltrade', async () => {
  const w = world({ trades: OFFERS().slice(0, 2), buildings: [{ typeId: 23, level: 2, positionId: 5, status: 0 }] });
  await runIn(w, 'if city.tradesArray.length == city.getBuildingLevel(23) canceltrade');
  assert.deepStrictEqual(w.of('trade.cancelTrade').map((s) => s.tradeId), [101, 102]);
});

// ---------------------------------------------------------------------------
section('marketupdate');

t('marketupdate 0 | wood | 2 | iron reads that book now; none reads all four', async () => {
  const w = world();
  const r = await runIn(w, 'marketupdate 0\nmarketupdate wood\nmarketupdate 2\nmarketupdate iron\nmarketupdate');
  assert.deepStrictEqual(w.of('trade.searchTrades').map((s) => s.resType), [0, 1, 2, 3, 0, 1, 2, 3]);
  assert.match(r.text, /food: best bid 10 \(2,000,000\) · best offer 12 \(1,000,000\) · 3 bid and 2 offer prices shown/);
  assert.match(parseErr('marketupdate gold'), /gold is not traded/);
  assert.match(parseErr('marketupdate food wood'), /one resource/);
});
t('it reads even when fresh, and the prices after it use that read', async () => {
  const b = BOOKS();
  const w = world({ books: b });
  await runIn(w, 'a = BuyPrice(0)', { marketFreshMs: 60000 });
  b.food.buyers = [{ price: 11, amount: 5 }];
  const r = await runIn(w, 'marketupdate food\necho BuyPrice(0)', { marketFreshMs: 60000 });
  assert.deepStrictEqual(echoed(r).slice(-1), ['11']);
});
t('a failed read says so in $error', async () => {
  const w = world({ replies: { 'trade.searchTrades': [{ ok: -3, errorMsg: 'busy' }] } });
  const r = await runIn(w, 'marketupdate 3\necho "e=" + $error');
  assert.match(r.text, /iron: FAILED - the market did not answer for iron \(busy\)/);
  assert.match(r.text, /e=1 of 1 market read\(s\) failed/);
});

// ---------------------------------------------------------------------------
section('dumpresource');

const DUMP = 'dumpresource 111,222 f:11000,g:44000 f:3000,g:9000';
const NEAR = [110, 220];     // a quarter of an hour from 111,222 by transporter
t('the wiki line: once the thresholds hold, 3,000 food and 9,000 gold go by transporter to 111,222', async () => {
  const w = world({ gold: 50000, res: { food: 12000 }, carriage: 10, at: NEAR });
  const r = await runIn(w, DUMP + '\necho "r=" + $result');
  const m = w.of('army.newArmy');
  assert.strictEqual(m.length, 1, r.text);
  const { castleId, bean } = m[0];
  assert.strictEqual(castleId, 1);
  assert.strictEqual(bean.missionType, C.MISSION.transport);
  assert.strictEqual(bean.targetPoint, F(111, 222));
  assert.strictEqual(bean.troops.carriage, 3, '12,000 at 5,000 a transporter');
  assert.deepStrictEqual([bean.resource.food, bean.resource.gold, bean.resource.wood], [3000, 9000, 0]);
  assert.ok(!('heroId' in bean));
  assert.match(r.text, /11,000 food, 44,000 gold reached — sending 3,000 food, 9,000 gold: transport 111,222 t:3 food:3000,gold:9000/);
  assert.match(r.text, /r=12000/);
});
t('the load bonus (troop params) needs fewer transporters; a long march\'s food needs more', async () => {
  const w = world({ gold: 50000, res: { food: 12000 }, carriage: 10, loadSkill: 100, at: NEAR });
  await runIn(w, DUMP);
  assert.strictEqual(w.of('army.newArmy')[0].bean.troops.carriage, 2);
  // 56 hours from 571,648: each transporter carries 5,000 less about 1,123 food for the way
  const far = world({ gold: 50000, res: { food: 12000 }, carriage: 10 });
  const r = await runIn(far, DUMP);
  assert.strictEqual(far.of('army.newArmy')[0].bean.troops.carriage, 4, r.text);
  // without the city's troop params: base load, no food (never too few for deploy's own check)
  const blind = world({ gold: 50000, res: { food: 12000 }, carriage: 10, replies: { 'army.getTroopParam': [new Error('no reply'), new Error('no reply')] } });
  await runIn(blind, DUMP);
  assert.strictEqual(blind.of('army.newArmy')[0].bean.troops.carriage, 3);
});
t('under a threshold nothing is sent and $error says what is short', async () => {
  const w = world({ gold: 50000, res: { food: 10999 } });
  const r = await runIn(w, DUMP + '\necho "e=" + $error');
  assert.strictEqual(w.of('army.newArmy').length, 0);
  assert.match(r.text, /not yet — food 10,999 of 11,000; nothing sent/);
  assert.match(r.text, /e=not yet: food 10,999 of 11,000/);
});
t('too few transporters, or not enough to send, is a clear failure', async () => {
  const w = world({ gold: 50000, res: { food: 12000 }, carriage: 2, at: NEAR });
  const r = await runIn(w, DUMP);
  assert.match(r.text, /FAILED: carrying 12,000 takes 3 transporters \(4,99\d each after march food\), and 9 has 2/);
  const w2 = world({ gold: 50000, res: { food: 12000 } });
  const r2 = await runIn(w2, 'dumpresource 111,222 f:1000 f:20000');
  assert.match(r2.text, /FAILED: 9 holds 12,000 food, not 20,000/);
  assert.strictEqual(w.of('army.newArmy').length + w2.of('army.newArmy').length, 0);
});
t('a dry run shows the march and sends nothing; a city of yours by name works too', async () => {
  const w = world({ gold: 50000, res: { food: 12000 }, at: NEAR });
  const r = await runIn(w, DUMP + '\ndumpresource Fla f:1 w:4k', { dryRun: true });
  assert.strictEqual(w.of('army.newArmy').length, 0);
  assert.match(r.text, /transport -> \(111,222\) field \d+ from 9 · hero none · 3 Transporter/);
  assert.match(r.text, /transport -> Fla \(484,619\)[^\n]*· 2 Transporter/, '4,000 wood, and 60 hours of food for the way');
  assert.strictEqual((r.text.match(/\[dry run\] not sent/g) || []).length, 2);
});
t('what dumpresource refuses before the run', () => {
  assert.match(parseErr('dumpresource 111,222 f:11000'), /usage  dumpresource/);
  assert.match(parseErr('dumpresource 111,222 f:11000 x:5'), /the amounts to send — bad resource string/);
  assert.match(parseErr('dumpresource 111,222 f:0 f:0'), /nothing to send/);
  assert.deepStrictEqual(script.parseLine('dumpresource 111, 222 f:11k, g:44k f:3k').condition, { food: 11000, gold: 44000 });
});

// ---------------------------------------------------------------------------
section('the wiki\'s market examples, run');

t('Market page: ifgoto BuyPrice(2) >= 1 sellfood ... loop start', async () => {
  const w = world();
  const src = 'label start\n1: ifgoto BuyPrice(2) >= 1 sellfood\n2: sleep 50\n3: loop start\nlabel sellfood\n4: sell food 1000 1\n5: goto start';
  await runIn(w, src, { shouldStop: () => w.of('trade.newTrade').length >= 2 });
  assert.deepStrictEqual(w.of('trade.newTrade').map((s) => [s.resType, s.tradeType, s.amount, s.price]), [[0, 1, 1000, '1'], [0, 1, 1000, '1']]);
});
t('Market page: ifgoto SellPrice(2) >= 1 buyiron ... buy iron 1000 1', async () => {
  const w = world();
  const src = 'label start\n1: ifgoto SellPrice(2) >= 1 buyiron\n2: sleep 50\n3: loop start\nlabel buyiron\n4: buy iron 1000 1\n5: goto start';
  await runIn(w, src, { shouldStop: () => w.of('trade.newTrade').length >= 1 });
  assert.deepStrictEqual(w.of('trade.newTrade').map((s) => [s.resType, s.tradeType, s.amount, s.price]), [[3, 0, 1000, '1']]);
});
t('Kento11: ifgoto ( m_context.sellPrice(0) < 5 ) buyfood', async () => {
  const b = BOOKS();
  b.food.sellers = [{ price: 4.5, amount: 1e6 }];
  const w = world({ books: b });
  const src = '1: label checkfoodprice\n2: ifgoto ( m_context.sellPrice(0) < 5 ) buyfood\n3: loop\n4: label buyfood\n5: buy food 9999999 5\n6: goto checkfoodprice';
  await runIn(w, src, { shouldStop: () => w.of('trade.newTrade').length >= 1 });
  assert.deepStrictEqual(w.of('trade.newTrade').map((s) => [s.resType, s.tradeType, s.amount, s.price]), [[0, 0, 9999999, '5']]);
});

// ---------------------------------------------------------------------------
section('TradeScript: STS v0.10g (the wiki page, verbatim)');

const STS = `// STS v0.10g - Smart Trading Script (c) 2012-2013 NeatPortal.com
// WARNING: This script requires NEATBOT 2735+ to run
//
// The script tries to gain more resources by using spread between bid and ask prices
// Algorithm is simplified, but should work reasonably well under broad range of conditions
//
// Comment out if you want to disable auto start
label autorun
// uncomment the next line if you are using 2720-2734 build
// MAX_TRADE = 9999999

// ===== OPTIONAL CONFIGURATION PARAMETERS =====
// Extra resources to reserve (in addition to city's reserved resources)
//       food, wood, stone, iron, gold:
extra = [  1m,   1m,    1m,   1m,  100 ]

// How aggressive we want to be (lower number would increase trading gains at the cost of potentially slower trade execution)
aggr = 2%

// Only trade if we expect this much gain
gain = 2%

// ===== NOTHING TO CONFIGURE BELOW THIS LINE =====
delay = 10
config trade:0
comm = 0.5%
maxRes = 990B

label nextres
res = floor(random() * 4) // choose resource to trade randomly, helps with multiple trading running
resName = ResourceIntNames[res]

label check
if city.tradesArray.length > 8 execute "sleep " + delay
if city.tradesArray.length > 8 execute "canceltrade " + city.tradesArray[0].id
if city.tradesArray.length > 8 goto check

label notready
if !m_context.marketReady() goto notready
prices = [ Price(res, aggr), Price(res, 1 - aggr), Price(res, aggr) * (1 + comm), Price(res, 1 - aggr) * comm ]
resGold = city.reservedResource.gold + extra[4] + max(0, city.resource.gold - city.reservedResource.gold - extra[4]) * 0.8
canSell = (city.resource[resName].amount - city.reservedResource[resName] - extra[res]) * 0.8
sellLimit = (city.resource.gold - resGold) / prices[3]
if canSell > 0 if sellLimit >=1 if prices[1] - prices[3] < prices[2] * (1 + gain) goto nextres
if sellLimit < 1 sellLimit = min(max(1, (resGold - city.resource.gold) / prices[1] / 2), (city.resource.gold - 1) / prices[3]) // we are low on gold
sellVolume = floor(min(canSell, sellLimit, MAX_TRADE - max(0, floor(min(maxRes - city.resource[resName].amount, (city.resource.gold - resGold) / prices[2]))) / 3))
if sellVolume > 0 execute "sell " + res + " " + sellVolume + " " + prices[1]
buyVolume = floor(min(maxRes - city.resource[resName].amount, (city.resource.gold - resGold) / prices[2], MAX_TRADE))
if buyVolume > 0 execute "buy " + res + " " + buyVolume + " " + prices[0]
goto nextres`;

// config trade:0 is a goal line. script-cmd-goals.js takes it into the city's
// script goal layer (opts.goalLayers stands in for goallayers.js); before that
// module had a config command, run()'s applyGoalLine hook did. Both are stubbed.
function goalHook() {
  const lines = [];
  const goalLayers = {
    addScriptLine: (accountId, castleId, line) => { lines.push(line); return { layer: { base: 'saved', count: lines.length, src: lines.join('\n') } }; },
    getScriptLayer: () => null,
  };
  return { lines, opts: { goalLayers, applyGoalLine: (text) => { lines.push(text); return 'goal line taken (test)'; } } };
}
// Math.random for random(): the script picks its resource with it.
async function withRandom(values, f) {
  const orig = Math.random;
  let i = 0;
  Math.random = () => values[Math.min(i++, values.length - 1)];
  try { return await f(); } finally { Math.random = orig; }
}
// What the STS math asks for with bid/ask, gold and stock, done here in plain JS.
function stsOrders({ bid, ask, gold, stock }) {
  const p = (q) => Number((bid + q * (ask - bid)).toPrecision(12));
  const aggr = 0.02, comm = 0.005, extra = [1e6, 1e6, 1e6, 1e6, 100], maxRes = 990e9;
  const prices = [p(aggr), p(1 - aggr), p(aggr) * (1 + comm), p(1 - aggr) * comm];
  const resGold = 0 + extra[4] + Math.max(0, gold - 0 - extra[4]) * 0.8;
  const canSell = (stock - 0 - extra[0]) * 0.8;
  const sellLimit = (gold - resGold) / prices[3];
  const sellVolume = Math.floor(Math.min(canSell, sellLimit, M.MAX_TRADE - Math.max(0, Math.floor(Math.min(maxRes - stock, (gold - resGold) / prices[2]))) / 3));
  const buyVolume = Math.floor(Math.min(maxRes - stock, (gold - resGold) / prices[2], M.MAX_TRADE));
  return { sell: { amount: sellVolume, price: M.fitPrice(prices[1], 'up') }, buy: { amount: buyVolume, price: M.fitPrice(prices[0], 'down') } };
}

t('it parses as the console checks it: no errors, no warnings', () => {
  const list = script.parse(STS);
  assert.deepStrictEqual(list.filter((a) => a.cmd === 'error'), []);
  assert.deepStrictEqual(list.warnings, []);
  assert.deepStrictEqual(script.lineStatus(STS).errors, []);
  assert.ok(list.some((a) => a.cmd === 'label' && a.name === 'autorun'));
  assert.ok(list.some((a) => ['goal', 'config'].includes(a.cmd) && a.raw === 'config trade:0'), 'config trade:0 is a goal line');
});
t('it runs from autorun: trade goal off, the four books read, then a sell and a buy 2% inside the spread', async () => {
  const w = world();
  const h = goalHook();
  const r = await withRandom([0], () => runIn(w, STS, { ...h.opts, startLine: 'autorun', shouldStop: () => w.of('trade.newTrade').length >= 2 }));
  assert.deepStrictEqual(h.lines, ['config trade:0']);
  assert.deepStrictEqual(w.of('trade.searchTrades').slice(0, 4).map((s) => s.resType), [0, 1, 2, 3]);
  const want = stsOrders({ bid: 10, ask: 12, gold: 50e6, stock: 5e6 });
  const [sell, buy] = w.of('trade.newTrade');
  assert.deepStrictEqual([sell.resType, sell.tradeType, sell.amount, sell.price], [0, 1, want.sell.amount, want.sell.price], r.text);
  assert.deepStrictEqual([buy.resType, buy.tradeType, buy.amount, buy.price], [0, 0, want.buy.amount, want.buy.price], r.text);
  assert.deepStrictEqual([sell.price, buy.price], ['11.96', '10.04']);
  assert.ok(sell.amount === 3200000 && buy.amount > 0 && buy.amount <= M.MAX_TRADE, JSON.stringify([sell.amount, buy.amount]));
});
t('with nine offers open it waits, cancels the oldest, then trades (delay shortened for the test)', async () => {
  const trades = Array.from({ length: 9 }, (_, i) => ({ id: 101 + i, tradeType: 0, resType: 2, amount: 10, dealedAmount: 0, price: 1 }));
  const w = world({ trades });
  const h = goalHook();
  await withRandom([0.3], () => runIn(w, STS.replace('delay = 10', 'delay = 0.01'),
    { ...h.opts, shouldStop: () => w.of('trade.newTrade').length >= 1 }));
  assert.deepStrictEqual(w.of('trade.cancelTrade').map((s) => [s.castleId, s.tradeId]), [[1, 101]]);
  const first = w.sent.findIndex((s) => s.cmd === 'trade.newTrade');
  assert.ok(first > w.sent.findIndex((s) => s.cmd === 'trade.cancelTrade'), 'the cancel came before the next order');
  assert.strictEqual(w.of('trade.newTrade')[0].resType, 1, 'random() 0.3 picks wood');
});
t('a spread too thin for 2% after fees places nothing and keeps looking', async () => {
  const b = BOOKS();
  for (const k of RES) b[k] = { buyers: [{ price: 10, amount: 1e6 }], sellers: [{ price: 10.1, amount: 1e6 }] };
  const w = world({ books: b });
  const h = goalHook();
  const t0 = Date.now();
  const r = await withRandom([0.1, 0.4, 0.6, 0.9], () => runIn(w, STS, { ...h.opts, marketFreshMs: 20, shouldStop: () => Date.now() - t0 > 250 }));
  assert.strictEqual(w.of('trade.newTrade').length, 0, r.text.slice(-500));
  assert.ok(w.of('trade.searchTrades').length > 4, 'it read the market again as the books went stale');
});
t('an empty book on one side places nothing (NaN prices fail every test)', async () => {
  const b = BOOKS();
  for (const k of RES) b[k] = { buyers: [], sellers: [{ price: 10.1, amount: 1e6 }] };
  const w = world({ books: b });
  const h = goalHook();
  const t0 = Date.now();
  await withRandom([0], () => runIn(w, STS, { ...h.opts, shouldStop: () => Date.now() - t0 > 150 }));
  assert.strictEqual(w.of('trade.newTrade').length, 0);
});

// ---------------------------------------------------------------------------
section('the module on its own');

t('MAX_TRADE and ResourceIntNames; MAX_TRADE can be assigned (the STS line for old builds), ResourceIntNames not', async () => {
  const w = world();
  const r = await runIn(w, 'echo MAX_TRADE ResourceIntNames[1] city.resource[ResourceIntNames[2]].amount\nMAX_TRADE = 9999999\necho MAX_TRADE');
  assert.deepStrictEqual(echoed(r), ['99999999 wood 5000000', '9999999']);
  const r2 = await runIn(w, 'ResourceIntNames = 5', { allowErrors: true });
  assert.match(r2.text, /ResourceIntNames is a constant/);
});
t('tradeBean / transingTradeBean are plain copies with NEAT\'s names', () => {
  const src = { id: 5, tradeType: 1, resType: 2, amount: 10, price: 3, junk: { a: 1 } };
  const b = M.tradeBean(src);
  assert.deepStrictEqual(b, { amount: 10, dealedAmount: 0, dealedTotal: 0, id: 5, price: 3, resType: 2, resourceName: 'Stone', tradeType: 1, tradeTypeName: 'Offer' });
  b.price = 99;
  assert.strictEqual(src.price, 3);
  assert.deepStrictEqual(M.transingTradeBean({ id: 1, resType: 1, amount: 2, price: 3, total: 6, endTime: 9 }),
    { amount: 2, endTime: 9, id: 1, price: 3, resType: 1, resourceName: 'Lumber', total: 6 });
});
t('holidaysnipe still parses as before', () => {
  assert.strictEqual(script.parseLine('holidaysnipe stop').action, 'stop');
  assert.match(parseErr('holidaysnipe sideways'), /holidaysnipe: unexpected "sideways"/);
});
t('a dry run of holidaysnipe stop only says it would stop: the running sniper and its saved run are left alone', async () => {
  // holiday-snipe.js stands in: what the market module asks of it is recorded
  const key = require.resolve('./holiday-snipe');
  const real = require('./holiday-snipe');
  const asked = [];
  let lines = ['holidaysnipe: running — 3 scans, nothing bought yet'];
  require.cache[key].exports = { ...real, command: async (a, o) => { asked.push([a.action, !!o.dryRun]); return a.action === 'status' ? lines : ['holidaysnipe: stopped — nothing bought yet']; } };
  try {
    const w = world();
    const r = await runIn(w, 'holidaysnipe stop', { dryRun: true, session: { account: { id: 'a1' } } });
    assert.deepStrictEqual(asked, [['status', false]], 'only its status is read');
    assert.match(r.text, /holidaysnipe: running — 3 scans[\s\S]*\[dry run\] would stop it — left as it is/);
    lines = ['holidaysnipe: not running here, but a run is saved — it carries on when the console restarts; "holidaysnipe stop" forgets it'];
    const r2 = await runIn(w, 'holidaysnipe stop', { dryRun: true });
    assert.match(r2.text, /\[dry run\] would stop it \(and forget the saved run\) — left as it is/);
    assert.deepStrictEqual(asked.map((x) => x[0]), ['status', 'status']);
    // a live run still stops it
    const r3 = await runIn(w, 'holidaysnipe stop');
    assert.deepStrictEqual(asked[2], ['stop', false]);
    assert.match(r3.text, /stopped — nothing bought yet/);
  } finally { require.cache[key].exports = real; }
});

// ---------------------------------------------------------------------------
section('transitAmount, restingAmount, waitslot, tradepace (2026-09-22)');

// A buying city in the glitch: ~900 purchases in transit and ten offers, resources mixed.
function glitchWorld(seed = 7) {
  let x = seed;
  const rnd = (n) => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return (x >>> 8) % n; };
  const transit = [];
  for (let i = 0; i < 900; i++) transit.push({ id: 90000 + i, resType: rnd(4), amount: rnd(3) ? 99999999 : 1 + rnd(99999999), price: 0.001, endTime: 0, total: 0 });
  transit[3].amount = '12345';            // a push may carry text
  const trades = [];
  for (let i = 0; i < 10; i++) {
    trades.push({ id: 7000 + i, tradeType: (i >> 2) % 2, resType: i % 4, amount: 99999999, dealedAmount: rnd(99999999), price: 0.001 });
  }
  return world({ transit, trades });
}
// The control file's own loops (scripts/glitch-res-control.txt before 2026-09-22), then the built-ins.
const OLD_LOOPS = `inTransit = 0
j = 0
label transit
if j >= city.transingTradesArray.length goto transitdone
if city.transingTradesArray[j].resType == rt inTransit = inTransit + city.transingTradesArray[j].amount
j = j + 1
goto transit
label transitdone
resting = 0
k = 0
label rest_loop
if k >= city.tradesArray.length goto rest_done
if city.tradesArray[k].resType == rt && city.tradesArray[k].tradeType == 0 resting = resting + city.tradesArray[k].amount - city.tradesArray[k].dealedAmount
k = k + 1
goto rest_loop
label rest_done`;

t('the built-ins give exactly what the control file\'s loops add up, for every resource', async () => {
  for (const seed of [7, 11, 1234]) {
    const w = glitchWorld(seed);
    for (let rt = 0; rt < 4; rt++) {
      const r = await runIn(w, `rt = ${rt}\n${OLD_LOOPS}\necho "old " + inTransit + " " + resting\n`
        + 'echo "new " + city.transitAmount(rt) + " " + city.restingAmount(rt, 0)');
      const [o, n] = echoed(r);
      assert.strictEqual(n.replace('new', 'old'), o, `seed ${seed} rt ${rt}`);
      assert.ok(Number(o.split(" ")[1]) > 0 && Number(o.split(" ")[2]) > 0, "the check has something to add up: " + o);
    }
  }
});
t('names, types and the sums without a type', async () => {
  const w = world({
    transit: [{ id: 1, resType: 1, amount: 5 }, { id: 2, resType: 1, amount: 7 }, { id: 3, resType: 0, amount: 100 }],
    trades: [{ id: 4, tradeType: 0, resType: 2, amount: 10, dealedAmount: 3 }, { id: 5, tradeType: 1, resType: 2, amount: 20, dealedAmount: 5 }],
  });
  const r = await runIn(w, ['echo city.transitAmount(1) city.transitAmount("wood") city.transitAmount("lumber") city.transitAmount(0) city.transitAmount(3)',
    'echo city.restingAmount(2) city.restingAmount("stone", "buy") city.restingAmount(2, 1) city.restingAmount(2, "sell") city.restingAmount(1)',
    'x = city.transitAmount("gold")', 'echo $error'].join('\n'), { allowErrors: true });
  const e = echoed(r);
  assert.strictEqual(e[0], '12 12 12 100 0');
  assert.strictEqual(e[1], '22 7 15 15 0');
  assert.match(r.text, /transitAmount: gold is not a resource/);
});
t('a push that replaces the list is seen on the next read (the sums are kept per list)', async () => {
  const w = world({ transit: [{ id: 1, resType: 1, amount: 5 }] });
  const v = require('./script-objects').globals({ game: w.g, get castle() { return w.castle; } }).city;
  assert.strictEqual(v.transitAmount(1), 5);
  assert.strictEqual(v.transitAmount(1), 5);
  w.castle.transingTrades = [...w.castle.transingTrades, { id: 2, resType: 1, amount: 6 }];
  assert.strictEqual(v.transitAmount(1), 11);
  w.castle.transingTrades.push({ id: 3, resType: 1, amount: 1 });      // even one added in place
  assert.strictEqual(v.transitAmount(1), 12);
});

// a Game with a push stream, as a connected one has (game.c emits 'cmd')
function pushWorld(opts) {
  const w = world(opts);
  w.g.c = new (require('events'))();
  w.push = (castle, trades) => { castle.trades = trades; w.g.c.emit('cmd', 'server.TradesUpdate', { castleId: castle.id }); };
  return w;
}
const full = () => Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, tradeType: 0, resType: 1, amount: 1, dealedAmount: 0, price: 1 }));

t('waitslot parses seconds and an optional offer count, and refuses the rest', () => {
  const a = script.parseLine('waitslot 0.3');
  assert.deepStrictEqual([a.cmd, a.seconds, a.below], ['waitslot', 0.3, null]);
  assert.deepStrictEqual([script.parseLine('waitslot 2 10').below], [10]);
  assert.match(parseErr('waitslot'), /waitslot: how long at most/);
  assert.match(parseErr('waitslot soon'), /soon is not a number of seconds/);
  assert.match(parseErr('waitslot 1 many'), /many is not a count of offers/);
  assert.match(parseErr('tradepace'), /tradepace: the gap in seconds/);
  assert.deepStrictEqual(script.parseLine('tradepace 1').seconds, 1);
});
t('waitslot returns on the push that frees a slot, not after its time', async () => {
  const w = pushWorld({ trades: full() });
  setTimeout(() => w.push(w.castle, w.castle.trades.slice(1)), 60);
  const t0 = Date.now();
  const r = await runIn(w, 'waitslot 5\necho "got " + $result');
  const took = Date.now() - t0;
  assert.deepStrictEqual(echoed(r), ['got 1']);
  assert.ok(took >= 50 && took < 1000, `took ${took} ms`);
  assert.strictEqual(w.g.c.listenerCount('cmd'), 0, 'it stops listening when it returns');
});
t('waitslot with no push ends after its time with $result 0; with a count it returns at once when under it', async () => {
  const w = pushWorld({ trades: full() });
  let t0 = Date.now();
  const r = await runIn(w, 'waitslot 0.2\necho "got " + $result');
  assert.deepStrictEqual(echoed(r), ['got 0']);
  assert.ok(Date.now() - t0 >= 190, 'it waited its time');
  w.castle.trades = full().slice(0, 9);
  t0 = Date.now();
  const r2 = await runIn(w, 'waitslot 5 10\necho "got " + $result');
  assert.deepStrictEqual(echoed(r2), ['got 1']);
  assert.ok(Date.now() - t0 < 500);
  // a push that does not free a slot (an offer filled a little) keeps it waiting
  const w3 = pushWorld({ trades: full() });
  setTimeout(() => w3.push(w3.castle, w3.castle.trades.map((x) => ({ ...x }))), 30);
  const r3 = await runIn(w3, 'waitslot 0.25\necho "got " + $result');
  assert.deepStrictEqual(echoed(r3), ['got 0']);
});
t('waitslot without a push stream still sees the slot (it looks again every 100 ms), and Stop cuts it short', async () => {
  const w = world({ trades: full() });
  setTimeout(() => { w.castle.trades = w.castle.trades.slice(2); }, 50);
  const r = await runIn(w, 'waitslot 5\necho "got " + $result');
  assert.deepStrictEqual(echoed(r), ['got 1']);
  const w2 = pushWorld({ trades: full() });
  let stop = false;
  setTimeout(() => { stop = true; }, 80);
  const t0 = Date.now();
  await runIn(w2, 'waitslot 30\necho "after"', { shouldStop: () => stop });
  assert.ok(Date.now() - t0 < 1000, 'Stop ended the wait');
});
t('tradepace waits out only what is left of the gap since the last market write', async () => {
  const w = world();
  let t0 = Date.now();
  const r = await runIn(w, 'tradepace 1\necho "none " + $result');
  assert.deepStrictEqual(echoed(r), ['none 0']);
  assert.ok(Date.now() - t0 < 300, 'no write yet: no wait');
  t0 = Date.now();
  const r2 = await runIn(w, 'buy wood 1000 5\nsleep 0.2\ntradepace 0.5\necho "done"');
  const took = Date.now() - t0;
  assert.deepStrictEqual(echoed(r2).filter((l) => l === 'done'), ['done']);
  assert.ok(took >= 480 && took < 900, `took ${took} ms: the 0.5 s counts from the order, the sleep inside it`);
});

// ---------------------------------------------------------------------------
(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n + '\n'); continue; }
    try { await f(); console.log('  ok    ' + n); pass++; }
    catch (e) { console.log('  FAIL  ' + n + '\n        ' + String(e.message).split('\n').join('\n        ')); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
