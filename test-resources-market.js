'use strict';
// Step 14: the push goals (keepresources, sendresources, keeptroops,
// sendtroops — goal-transfer.js pushPlan) and the market goals (config trade,
// tradepolicy, resourcelimits — goal-trade.js), each wiki rule against fake
// cities and a fake market book. No network, no login; the database is a
// throwaway file.
//
//   node test-resources-market.js
const assert = require('assert');
const path = require('path'), os = require('os'), fs = require('fs');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-resmarket-')), 't.db');

const C = require('./constants');
const R = require('./rally');
const T = require('./goal-transfer');
const TR = require('./goal-trade');
const HS = require('./holiday-snipe');
const G = require('./goals');
const { parseGoals, describe } = G;
const { Engine } = require('./engine');
const { Game } = require('./game');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok    ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); fail++; }
}
const has = (s, sub) => assert.ok(String(s).includes(sub), `"${s}" does not contain "${sub}"`);
const hasNotWaiting = (s) => assert.ok(!String(s).includes('has not reported'), `"${s}" still waits for a push`);
const clean = (src) => {
  const p = parseGoals(src);
  assert.deepStrictEqual(p.errors, [], `${src}\n  should parse cleanly`);
  return p;
};
const one = (src) => clean(src).goals[0];
const errOf = (src) => { const p = parseGoals(src); assert.ok(p.errors.length, `${src} should be an error`); return p.errors.map((e) => e.error).join(' | '); };

// ------------------------------------------------------------------ fixtures
// Lord02's cities where they are (the fixture test-transfer.js uses).
let nextId = 1;
function city(name, x, y, { food = 0, wood = 0, stone = 0, iron = 0, gold = 0, troop = {}, rally = 10, market = 10, ...over } = {}) {
  const buildings = [];
  if (rally !== null) buildings.push({ typeId: 29, level: rally, positionId: 5 });
  if (market) buildings.push({ typeId: 23, level: market, positionId: 6 });
  return {
    castleId: nextId++, name, fieldId: C.coordsToFieldId(x, y),
    resource: { food: { amount: food }, wood: { amount: wood }, stone: { amount: stone }, iron: { amount: iron }, gold },
    troop: { carriage: 20000, ...troop },
    buildings, heros: [], fortification: {}, trades: [], transingTrades: [], ...over,
  };
}
function fleet(over = {}) {
  return {
    fla: city('Fla', 484, 619, { food: 100e6, wood: 50e3, stone: 1e6, iron: 80e6, ...over.fla }),
    nine: city('9', 571, 648, { food: 20e9, wood: 50e6, stone: 900e6, iron: 3e9, ...over.nine }),
    eight: city('8', 489, 678, { food: 3e9, wood: 5e6, stone: 60e6, iron: 300e6, ...over.eight }),
    five: city('5', 485, 617, { food: 3e9, wood: 5e6, stone: 60e6, iron: 300e6, ...over.five }),
  };
}
function fakeGame(castles, selfArmys = []) {
  const g = {
    castles, player: { playerInfo: { userName: 'T' }, selfArmys, enemyArmys: [], items: [] },
    sent: [], discharged: [],
    castleId: (c) => c.castleId,
    castleXY: (c) => C.fieldIdToCoords(c.fieldId),
    now: () => Date.now(),
    req: async () => ({ ok: 1 }),
    buildArmyBean: (o) => Game.prototype.buildArmyBean.call(g, o),
    newArmy: async (castleId, bean) => { g.sent.push({ castleId, bean }); return { ok: 1 }; },
    dischargeChief: async (cid) => { g.discharged.push(cid); return { ok: 1 }; },
  };
  return g;
}
const march = (from, to, missionType, extra = {}) => ({
  startFieldId: from.fieldId, targetFieldId: to.fieldId, missionType, direction: 1,
  startTime: Date.now() - 60000, troop: {}, resource: {}, ...extra,
});

// One city's push plan. `own` gives other cities their own goal text.
function push(here, castles, src, { selfArmys = [], own = {}, warTownOf = null, book = null } = {}) {
  const game = fakeGame(castles, selfArmys);
  const parsed = clean(src);
  const goalsOf = (c) => (c === here ? parsed.goals : parseGoals(own[c.name] || '').goals);
  const ctx = { castle: here, goals: parsed.goals, config: parsed.config, goalsOf, selfArmies: selfArmys };
  if (warTownOf) ctx.warTownOf = warTownOf;
  if (book) ctx.rally = book(game, goalsOf);
  return { plan: T.plans.push(ctx, {}, game), game, ctx };
}
const res = (a, k) => (a && a.resources ? a.resources[k] : undefined);

// ---------------------------------------------------------------- the market
// A book per resource, our cities' offers and the fills, the way the server
// does it as far as it has been seen live: a buy is charged at its own bid
// plus 0.5% when placed, and fills against asks at or under it (cheapest
// first); a sell pays its 0.5% in gold and fills against bids at or over it;
// what does not fill rests as the city's offer. A cancel refunds what is left
// but not the fee.
let tradeId = 5000;
function marketGame(castles, books = {}, { selfArmys = [] } = {}) {
  const g = fakeGame(castles, selfArmys);
  g.book = {};
  for (const r of ['food', 'wood', 'stone', 'iron']) {
    const b = books[r] || { asks: [[20, 1e9]], bids: [[19, 1e9]] };
    g.book[r] = { asks: b.asks.map(([price, amount]) => ({ price, amount })), bids: b.bids.map(([price, amount]) => ({ price, amount })) };
  }
  g.time = 1.7e12;
  g.sleeps = [];
  g.writes = [];
  g.reads = [];
  g.noReply = false;
  g.tradeClock = { now: () => g.time, sleep: async (ms) => { g.sleeps.push(ms); g.time += ms; } };
  g.searchTrades = async (r) => {
    g.reads.push(r);
    const b = g.book[r];
    return { ok: 1, sellers: b.asks.map((l) => ({ ...l })), buyers: b.bids.map((l) => ({ ...l })) };
  };
  const byId = (cid) => castles.find((c) => c.castleId === cid);
  g.newTrade = async ({ castleId, resource, type, amount, price }) => {
    g.writes.push({ at: g.time, cmd: 'newTrade', castleId, resource, type, amount, price });
    if (g.noReply) throw new Error('no reply to trade.newTrade');
    if (g.onTrade) g.onTrade({ castleId, resource, type, amount, price });
    const c = byId(castleId);
    const cap = g.cap || 10;
    if ((c.trades || []).length >= cap) return { ok: -38, errorMsg: `${cap} offers are allowed at level ${cap} Marketplace.` };
    const p = Number(price), fee = amount * p * C.TRADE_COMMISSION;
    const b = g.book[resource];
    let left = amount;
    if (type === 'buy') {
      if (c.resource.gold < amount * p + fee) return { ok: 0, errorMsg: 'not enough gold' };
      c.resource.gold -= amount * p + fee;
      for (const l of b.asks) { if (l.price > p + 1e-9 || !left) continue; const take = Math.min(l.amount, left); l.amount -= take; left -= take; }
      b.asks = b.asks.filter((l) => l.amount > 0);
      if (amount - left > 0) c.transingTrades.push({ resType: C.TRADE_RES[resource], amount: amount - left });
    } else {
      if (c.resource[resource].amount < amount) return { ok: 0, errorMsg: 'not enough ' + resource };
      c.resource[resource].amount -= amount;
      c.resource.gold -= fee;
      for (const l of b.bids) { if (l.price < p - 1e-9 || !left) continue; const take = Math.min(l.amount, left); l.amount -= take; left -= take; c.resource.gold += take * p; }
      b.bids = b.bids.filter((l) => l.amount > 0);
    }
    if (left > 0) {
      c.trades.push({ id: tradeId++, tradeType: C.TRADE_TYPE[type], resType: C.TRADE_RES[resource], amount, dealedAmount: amount - left, price: p });
    }
    // server.ResourceUpdate, as the console's session applies it: a new object
    if (!g.noPush) c.resource = { ...c.resource };
    return { ok: 1 };
  };
  g.cancelTrade = async (castleId, id) => {
    g.writes.push({ at: g.time, cmd: 'cancelTrade', castleId, id });
    if (g.noReply) throw new Error('no reply to trade.cancelTrade');
    const c = byId(castleId);
    const i = c.trades.findIndex((x) => x.id === id);
    if (i < 0) return { ok: 0, errorMsg: 'no such trade' };
    const o = c.trades[i];
    const left = o.amount - o.dealedAmount;
    if (o.tradeType === C.TRADE_TYPE.buy) c.resource.gold += left * o.price;
    else c.resource[['food', 'wood', 'stone', 'iron'][o.resType]].amount += left;
    c.trades.splice(i, 1);
    if (!g.noPush) c.resource = { ...c.resource };
    return { ok: 1 };
  };
  return g;
}
// A city for the market tests: 100 heroes' worth of salary (10k/h) and
// 20k/h of troop upkeep, so a day is 240k gold and 480k food.
const mcity = (name, over = {}) => city(name, 100, 100, { food: 5e9, wood: 50e6, stone: 50e6, iron: 50e6, gold: 1e9, ...over,
  resource: undefined });
function trader(over = {}) {
  const c = mcity(over.name || 'M', over);
  c.resource = {
    food: { amount: over.food ?? 5e9 }, wood: { amount: over.wood ?? 50e6 }, stone: { amount: over.stone ?? 50e6 },
    iron: { amount: over.iron ?? 50e6 }, gold: over.gold ?? 1e9,
    herosSalary: over.salary === undefined ? 10000 : over.salary, troopCostFood: over.upkeep === undefined ? 20000 : over.upkeep,
  };
  return c;
}
// The trade plan for one city; `fresh` reads the books first, as the
// marketRead action would.
async function tplan(c, g, src, { state = {}, snipe = null, fresh = true } = {}) {
  const parsed = clean(src);
  if (fresh) await TR.executors.marketRead(g, c, {}, state);
  const ctx = { castle: c, goals: parsed.goals, config: parsed.config, accountId: 'a1', holidaySnipe: snipe };
  return TR.plans.trade(ctx, state, g);
}
const kinds = (p) => p.actions.map((a) => a.kind);
const act = (p, kind, r) => p.actions.find((a) => a.kind === kind && (!r || a.res === r));
async function run(g, c, a, state) { return TR.executors[a.kind](g, c, a, state); }

(async () => {
  // =============================================================== parsing
  console.log('\npush goals: parsing\n');

  await t('keepresources reads the wiki\'s own examples (keepresource singular too, /slots= first or last)', () => {
    let g = one('keepresource 111,222 f:1b 50m');
    assert.deepStrictEqual([g.name, g.target, g.keep, g.minBatch, g.carrier, g.slots], ['keepresource', '111,222', { food: 1e9 }, 50e6, 'carriage', 1]);
    g = one('keepresources !OtherCity w:20m,i:20m 5m');
    assert.deepStrictEqual([g.target, g.keep, g.minBatch], ['!OtherCity', { wood: 20e6, iron: 20e6 }, 5e6]);
    g = one('keepresource 111,222 f:250m');
    assert.deepStrictEqual([g.keep, g.minBatch], [{ food: 250e6 }, null]);
    assert.strictEqual(one('keepresources /slots=3 111,222 w:20m 5m').slots, 3);
    assert.strictEqual(one('keepresources 111,222 w:20m 5m /slots:2').slots, 2);
    g = one('keepresources 111,222 w:20m 5m cavalry');
    assert.deepStrictEqual([g.minBatch, g.carrier], [5e6, 'lightCavalry']);
    assert.deepStrictEqual(one('keepresources hubcity w:25m,i:25m,f:700m 10m').keep, { wood: 25e6, iron: 25e6, food: 700e6 });
  });

  await t('keepresources: a troop type needs the minimum batch written first (wiki: MUST), * is any size', () => {
    has(errOf('keepresources 111,222 w:20m cavalry'), 'the minimum batch must be written first');
    const g = one('keepresources 111,222 w:20m * cavalry');
    assert.deepStrictEqual([g.minBatch, g.carrier, g.ok], [null, 'lightCavalry', true]);
    const bad = parseGoals('keepresources 111,222 w:20m cavalry').goals[0];
    assert.strictEqual(bad.ok, false, 'the line with the mistake is not run');
  });

  await t('keep lines: mistakes are errors, never guessed at', () => {
    has(errOf('keepresources 111,222 rubies:5m'), 'unknown resource "rubies"');
    has(errOf('keepresources 111,222 w:*'), 'needs an amount to keep');
    has(errOf('keepresources 111,222 w'), 'needs an amount to keep');
    has(errOf('keepresources 111,222'), 'what to keep are required');
    has(errOf('keepresources 111,222 w:5m 1m 2m'), 'one minimum batch at most');
    has(errOf('keepresources 111,222 w:5m dragons'), 'unknown troop "dragons"');
    has(errOf('keepresources 111,222 w:5m /below:1m'), 'unknown switch /below');
    has(errOf('keeptroops 111,222 dragons:5k'), 'unknown troop "dragons"');
    has(errOf('keeptroops 111,222 a:5k cav'), '"cav" is not an amount');
  });

  await t('keeptroops reads the wiki example: five troop types and one increment', () => {
    const g = one('keeptroops !OtherCity w:100k,s:400k,p:100k,sw:200k,a:400k 10k');
    assert.deepStrictEqual(g.keep, { militia: 100e3, scouter: 400e3, pikemen: 100e3, swordsmen: 200e3, archer: 400e3 });
    assert.strictEqual(g.minBatch, 10e3);
    assert.strictEqual(g.carrier, undefined, 'troops carry themselves');
  });

  await t('sendresources / sendtroops read the wiki examples in NEAT\'s order', () => {
    let g = one('sendresources any food 1b 100m 50m 100m');
    assert.deepStrictEqual([g.target, g.type, g.local, g.remote, g.minBatch, g.maxBatch, g.carrier], ['any', 'food', 1e9, 100e6, 50e6, 100e6, 'carriage']);
    g = one('sendresources !TrebCity stone 30m 100m 5m * cavalry');
    assert.deepStrictEqual([g.local, g.remote, g.minBatch, g.maxBatch, g.carrier], [30e6, 100e6, 5e6, null, 'lightCavalry']);
    g = one('sendresources !WarCity|!HubCity|!FarmCity food 10m 20m 1m 1m s');
    assert.deepStrictEqual([g.target, g.carrier], ['!WarCity|!HubCity|!FarmCity', 'scouter']);
    assert.strictEqual(one('sendresources any food 1b 100m 50m').maxBatch, 50e6, 'one batch number is the MAXIMUM');
    g = one('sendtroops any ballista 10k 5k 500 5k');
    assert.deepStrictEqual([g.troop, g.local, g.remote, g.minBatch, g.maxBatch], ['ballista', 10e3, 5e3, 500, 5e3]);
    g = one('sendtroops !TrebCity scout 100k 2m 50k 100k');
    assert.deepStrictEqual([g.troop, g.local, g.remote], ['scouter', 100e3, 2e6]);
    has(errOf('sendresources any food 1b'), 'expected: sendresources <to>');
    has(errOf('sendresources any food 1b 1m /below:5m'), 'unknown switch /below — /slots:N');
    has(errOf('sendtroops any archer 1k 2k 1k 1k cavalry'), 'sendtroops moves the troops themselves');
  });

  await t('describe says what each push line means', () => {
    const out = describe(clean('keepresource 111,222 f:1b 50m\nsendresources any food 1b 100m 50m 100m\nkeeptroops 8 a:400k 10k\nsendtroops 8 scout 100k 2m 50k 100k /slots:2')).join('\n');
    has(out, 'keepresource: food over 1,000,000,000 to 111,222, at least 50,000,000 at a time');
    has(out, 'sendresources: food to any, while this city holds over 1,000,000,000, never below it, to a receiver under 100,000,000');
    has(out, 'keeptroops: Archer over 400,000 to 8, at least 10,000 at a time');
    has(out, 'sendtroops: Scout to 8');
    has(out, '2 missions at a time to each receiver');
  });

  // ============================================================ keepresources
  console.log('\nkeepresources\n');

  await t('keeps the amount and ships only the surplus', () => {
    const f = fleet();
    const { plan: p } = push(f.five, Object.values(f), 'keepresources 8 f:2.95b');
    assert.strictEqual(p.actions.length, 1);
    const a = p.actions[0];
    assert.deepStrictEqual([a.kind, a.from.name, a.to.name, res(a, 'food'), a.carriages], ['transport', '5', '8', 50e6, 10000]);
    assert.deepStrictEqual([a.rally.kind, a.rally.missionType, a.rally.targetFieldId, a.rally.pairLimit], ['r', C.MISSION.transport, f.eight.fieldId, 1]);
    has(p.note, 'keepresources: food 3b over 2.95b: 50m to 8');
  });

  await t('nothing over what it keeps: nothing sent', () => {
    const f = fleet();
    const { plan: p } = push(f.five, Object.values(f), 'keepresources 8 f:3b 1m');
    assert.deepStrictEqual(p.actions, []);
    has(p.note, 'keepresources: nothing over what this city keeps');
  });

  await t('the minimum batch waits until that much is over the kept amount', () => {
    let f = fleet({ five: { food: 2.98e9 } });
    let p = push(f.five, Object.values(f), 'keepresources 8 f:2.95b 50m').plan;
    assert.deepStrictEqual(p.actions, []);
    has(p.note, '8: only 30m is spare here, under the 50m minimum batch');
    f = fleet({ five: { food: 3.01e9 } });
    p = push(f.five, Object.values(f), 'keepresources 8 f:2.95b 50m').plan;
    assert.strictEqual(res(p.actions[0], 'food'), 60e6);
  });

  await t('no batch: any amount over the kept figure goes', () => {
    const f = fleet({ five: { food: 3e9 + 1 } });
    const p = push(f.five, Object.values(f), 'keepresources 8 f:3b').plan;
    assert.deepStrictEqual([res(p.actions[0], 'food'), p.actions[0].carriages], [1, 1]);
  });

  await t('as much as the transports carry, a quarter kept home; a minimum batch they cannot carry waits', () => {
    let f = fleet({ five: { troop: { carriage: 100 } } });
    let p = push(f.five, Object.values(f), 'keepresources 8 f:2.9b').plan;
    assert.deepStrictEqual([res(p.actions[0], 'food'), p.actions[0].carriages], [75 * 5000, 75]);
    f = fleet({ five: { troop: { carriage: 100 } } });
    p = push(f.five, Object.values(f), 'keepresources 8 f:2.9b 1m').plan;
    assert.deepStrictEqual(p.actions, []);
    has(p.note, 'the spare transports carry 375k, under the 1m minimum batch');
  });

  await t('every resource on the line rides in one march', () => {
    const f = fleet();
    const p = push(f.five, Object.values(f), 'keepresources 8 f:2.95b,i:290m,g:0 1m').plan;
    assert.strictEqual(p.actions.length, 1);
    assert.deepStrictEqual(p.actions[0].resources, { food: 50e6, iron: 10e6 });
    assert.strictEqual(p.actions[0].carriages, 12000);
  });

  await t('another troop type carries it when the line names one', () => {
    const f = fleet({ five: { troop: { lightCavalry: 10000 } } });
    const p = push(f.five, Object.values(f), 'keepresources 8 w:4m 100k cavalry').plan;
    const a = p.actions[0];
    // 10,000 cavalry, a quarter home but never more than 2,000: 8,000 x 100 = 800k
    assert.deepStrictEqual([res(a, 'wood'), a.troops], [800e3, { lightCavalry: 8000 }]);
    has(a.label, '8,000 Cavalry');
  });

  await t('to another account\'s city by coordinates: sent to that field', async () => {
    const f = fleet();
    const { plan: p, game } = push(f.five, Object.values(f), 'keepresource 300,300 f:2.95b 10m');
    const a = p.actions[0];
    assert.deepStrictEqual([a.to.fieldId, a.to.name, a.foreign, res(a, 'food'), a.rally.targetFieldId], [C.coordsToFieldId(300, 300), '300,300', true, 50e6, C.coordsToFieldId(300, 300)]);
    has(a.label, 'send 50,000,000 food to 300,300');
    const r = await T.executors.transport(game, f.five, a);
    assert.strictEqual(r.ok, 1);
    assert.deepStrictEqual([game.sent[0].castleId, game.sent[0].bean.missionType, game.sent[0].bean.targetPoint, game.sent[0].bean.resource.food, game.sent[0].bean.troops.carriage],
      [f.five.castleId, C.MISSION.transport, C.coordsToFieldId(300, 300), 50e6, 10000]);
    assert.strictEqual(game.sent[0].bean.heroId, undefined, 'no hero goes with it');
  });

  await t('coordinates that are one of our cities are that city', () => {
    const f = fleet();
    const p = push(f.five, Object.values(f), 'keepresources 489,678 f:2.95b').plan;
    assert.deepStrictEqual([p.actions[0].to.name, p.actions[0].foreign], ['8', false]);
  });

  await t('a name that is none of our cities, or this city itself, says so', () => {
    const f = fleet();
    let p = push(f.five, Object.values(f), 'keepresources Atlantis f:2.95b').plan;
    assert.deepStrictEqual(p.actions, []);
    has(p.note, 'no city of ours is named "Atlantis" (another account\'s city needs x,y)');
    p = push(f.five, Object.values(f), 'keepresources 5|485,617 f:2.95b').plan;
    has(p.note, '5 is this city');
  });

  await t('any: the nearest city takes it, but never past its own keep line (no ping-pong)', () => {
    const f = fleet();
    // 9 is far from the rest; 8 keeps 3b of its own, 5 keeps 3.05b, Fla has no line
    const own = { 8: 'keepresources any f:3b', 5: 'keepresources any f:3.05b' };
    const p = push(f.nine, Object.values(f), 'keepresources any f:19.91b', { own }).plan;
    const to = p.actions.map((a) => [a.to.name, res(a, 'food')]);
    assert.deepStrictEqual(to, [['5', 50e6], ['Fla', 40e6]], JSON.stringify(to));
  });

  await t('a city named outright is filled as the line says, whatever its own keep line (hub chains work)', () => {
    const f = fleet();
    const p = push(f.nine, Object.values(f), 'keepresources 8 f:19.91b', { own: { 8: 'keepresources any f:3b' } }).plan;
    assert.deepStrictEqual([p.actions[0].to.name, res(p.actions[0], 'food')], ['8', 90e6]);
  });

  await t('never below this city\'s own requestresources trigger for the same thing', () => {
    const f = fleet();
    const p = push(f.five, Object.values(f), 'keepresources 8 f:2b\nrequestresources any food 2.99b 1b').plan;
    assert.strictEqual(res(p.actions[0], 'food'), 10e6);
    has(p.note, 'food 3b over 2.99b');
  });

  // ============================================================ sendresources
  console.log('\nsendresources\n');

  await t('sends while the receiver is under remoteAmount, never past it; the sender keeps localAmount', () => {
    const f = fleet();
    let p = push(f.nine, Object.values(f), 'sendresources Fla food 19b 150m').plan;
    assert.deepStrictEqual([p.actions[0].to.name, res(p.actions[0], 'food')], ['Fla', 50e6]);
    p = push(f.nine, Object.values(f), 'sendresources Fla food 19b 100m').plan;
    assert.deepStrictEqual(p.actions, [], 'Fla holds 100m, not under 100m');
    p = push(f.nine, Object.values(f), 'sendresources Fla food 20b 150m').plan;
    assert.deepStrictEqual(p.actions, [], '9 holds 20b, not over 20b');
    p = push(f.nine, Object.values(f), 'sendresources Fla food 19.99b 150m').plan;
    assert.strictEqual(res(p.actions[0], 'food'), 10e6, 'never below localAmount');
  });

  await t('* for localAmount sends regardless of it; * for remoteAmount fills regardless', () => {
    const f = fleet({ five: { food: 30e6 } });
    let p = push(f.five, Object.values(f), 'sendresources 8 food * * * 10m').plan;
    assert.strictEqual(res(p.actions[0], 'food'), 10e6);
    p = push(f.five, Object.values(f), 'sendresources 8 food * 1b').plan;
    assert.deepStrictEqual(p.actions, [], '8 holds 3b, not under 1b');
  });

  await t('one batch number is the most per send; min and max together', () => {
    const f = fleet();
    let p = push(f.nine, Object.values(f), 'sendresources Fla food 19b 1b 20m').plan;
    assert.strictEqual(res(p.actions[0], 'food'), 20e6);
    p = push(f.nine, Object.values(f), 'sendresources Fla food 19b 1b 5m 20m').plan;
    assert.strictEqual(res(p.actions[0], 'food'), 20e6);
  });

  await t('any: every city under remoteAmount is served, nearest first, each its own march', () => {
    const f = fleet();
    const p = push(f.nine, Object.values(f), 'sendresources any wood 1m 10m').plan;
    const to = p.actions.map((a) => [a.to.name, res(a, 'wood')]);
    // 8 (87 tiles), 5 (91), Fla (92): 5m, 5m and 9.95m
    assert.deepStrictEqual(to, [['8', 5e6], ['5', 5e6], ['Fla', 9.95e6]]);
  });

  await t('several cities joined by |, NEAT\'s !Name spelling', () => {
    const f = fleet();
    const p = push(f.nine, Object.values(f), 'sendresources !Fla|!5 wood 1m 10m').plan;
    assert.deepStrictEqual(p.actions.map((a) => a.to.name), ['5', 'Fla']);
  });

  await t('a minimum batch waits, unless the receiver is critically low (50% of remoteAmount or less)', () => {
    let f = fleet({ fla: { food: 600e6 } });
    // (one batch number would be the MAXIMUM, so the minimum is written with a maximum)
    let p = push(f.nine, Object.values(f), 'sendresources Fla food 19b 1b 500m 1b').plan;
    assert.deepStrictEqual(p.actions, []);
    has(p.note, 'the spare transports carry 90m, under the 500m minimum batch');
    f = fleet({ fla: { food: 500e6 } });
    p = push(f.nine, Object.values(f), 'sendresources Fla food 19b 1b 500m 1b').plan;
    assert.strictEqual(res(p.actions[0], 'food'), 90e6);
    has(p.note, 'critically low');
  });

  await t('what is already on its way to the receiver counts: transports and market purchases', () => {
    const f = fleet({ fla: { transingTrades: [{ resType: 0, amount: 40e6 }] } });
    const going = march(f.eight, f.fla, C.MISSION.transport, { resource: { food: 10e6 } });
    let p = push(f.nine, Object.values(f), 'sendresources Fla food 19b 150m', { selfArmys: [going] }).plan;
    assert.deepStrictEqual(p.actions, []);
    p = push(f.nine, Object.values(f), 'sendresources Fla food 19b 160m', { selfArmys: [going] }).plan;
    assert.strictEqual(res(p.actions[0], 'food'), 10e6);
  });

  await t('another account\'s coordinates: its stock can\'t be read, so a remoteAmount waits and * sends', () => {
    const f = fleet();
    let p = push(f.nine, Object.values(f), 'sendresources 300,300 food 19b 100m').plan;
    assert.deepStrictEqual(p.actions, []);
    has(p.note, '300,300 is not one of this account\'s cities, so what it holds can\'t be read — write * as remoteAmount');
    p = push(f.nine, Object.values(f), 'sendresources 300,300 food 19.95b *').plan;
    assert.deepStrictEqual([p.actions[0].to.name, res(p.actions[0], 'food')], ['300,300', 50e6]);
  });

  await t('one mission at a time to each receiver, going or coming back; /slots:2 allows two', () => {
    const f = fleet();
    const back = march(f.nine, f.fla, C.MISSION.transport, { direction: 2 });
    let p = push(f.nine, Object.values(f), 'sendresources Fla food 19b 150m', { selfArmys: [back] }).plan;
    assert.deepStrictEqual(p.actions, []);
    has(p.note, 'Fla: the last mission to it not back yet');
    p = push(f.nine, Object.values(f), 'sendresources Fla food 19b 150m /slots:2', { selfArmys: [back] }).plan;
    assert.deepStrictEqual([p.actions.length, p.actions[0].rally.pairLimit], [1, 2]);
  });

  await t('with any, a receiver still busy is skipped and the next one below remoteAmount served', () => {
    const f = fleet();
    const busy = march(f.nine, f.eight, C.MISSION.transport, { direction: 2 });
    const p = push(f.nine, Object.values(f), 'sendresources any wood 1m 10m', { selfArmys: [busy] }).plan;
    assert.deepStrictEqual(p.actions.map((a) => a.to.name), ['5', 'Fla']);
  });

  await t('this city\'s rally spot and rallypolicy hold new marches', () => {
    const f = fleet({ nine: { rally: 2 } });
    const elsewhere = { fieldId: C.coordsToFieldId(10, 10) };
    let p = push(f.nine, Object.values(f), 'sendresources any wood 1m 10m', { selfArmys: [march(f.nine, elsewhere, C.MISSION.attack)] }).plan;
    assert.deepStrictEqual(p.actions.map((a) => a.to.name), ['8'], 'one slot left: one march');
    has(p.note, '5m to 8 (87.3 tiles); not to the rest — rally spot L2: 2/2 busy');
    const g = fleet();
    p = push(g.nine, Object.values(g), 'sendresources any wood 1m 10m\nrallypolicy r:2').plan;
    assert.deepStrictEqual(p.actions.map((a) => a.to.name), ['8', '5']);
    has(p.note, 'rallypolicy r:2');
  });

  await t('several lines to one receiver ride in one march and one rally slot', () => {
    const f = fleet();
    const p = push(f.nine, Object.values(f), 'sendresources 8 wood 1m 10m\nsendresources 8 stone 1m 100m\nkeepresources 8 i:2.99b', {}).plan;
    assert.strictEqual(p.actions.length, 1);
    assert.deepStrictEqual(p.actions[0].resources, { wood: 5e6, stone: 40e6, iron: 10e6 });
  });

  await t('what this city sent moments ago is not offered again', () => {
    const f = fleet();
    const p = push(f.five, Object.values(f), 'keepresources 8 f:2.95b', {
      book: (game, goalsOf) => {
        const b = R.rallyBook({ game, goalsOf, pending: [] });
        b.record({ from: f.five, kind: 'r', missionType: C.MISSION.transport, targetFieldId: f.fla.fieldId, resources: { food: 30e6 }, troops: { carriage: 6000 } });
        return b;
      },
    }).plan;
    // 3b - 30m sent = 2.97b: 20m over 2.95b
    assert.strictEqual(res(p.actions[0], 'food'), 20e6);
  });

  // ============================================================== war town
  console.log('\na war town never sends\n');

  await t('a war town sends nothing, whatever its push lines say', () => {
    const f = fleet();
    const src = 'keepresources 8 f:2.95b\nkeeptroops 8 a:1\nsendresources any wood 1m 10m';
    let p = push(f.five, Object.values(f), src, { warTownOf: (c) => (c === f.five ? 2 : 0) }).plan;
    assert.deepStrictEqual(p.actions, []);
    has(p.note, 'send: 3 line(s) held — this city is a war town (2), so nothing is sent from it');
    // without the engine, the city's own config
    p = push(f.five, Object.values(f), `config wartown:1\n${src}`).plan;
    assert.deepStrictEqual(p.actions, []);
    has(p.note, 'war town (1)');
  });

  await t('a war town may still be sent to', () => {
    const f = fleet();
    const p = push(f.five, Object.values(f), 'keepresources 8 f:2.95b', { warTownOf: (c) => (c === f.eight ? 1 : 0) }).plan;
    assert.strictEqual(p.actions[0].to.name, '8');
  });

  // ================================================================ troops
  console.log('\nkeeptroops / sendtroops\n');

  await t('keeptroops sends what is over each kept amount, in increments of at least the batch', async () => {
    const f = fleet({ five: { troop: { archer: 500e3, scouter: 405e3, militia: 50e3 } } });
    const { plan: p, game } = push(f.five, Object.values(f), 'keeptroops 8 a:400k,s:400k,w:100k 10k');
    assert.strictEqual(p.actions.length, 1);
    const a = p.actions[0];
    assert.deepStrictEqual([a.kind, a.to.name, a.troops], ['reinforceTroops', '8', { archer: 100e3 }]);
    has(p.note, 'Scout 405k over 400k: 8: only 5k is spare here, under the 10k minimum batch');
    await T.executors.reinforceTroops(game, f.five, a);
    assert.deepStrictEqual([game.sent[0].bean.missionType, game.sent[0].bean.targetPoint, game.sent[0].bean.troops.archer, game.sent[0].bean.heroId],
      [C.MISSION.reinforce, f.eight.fieldId, 100e3, undefined]);
  });

  await t('keeptroops counts only troops at home: the city never dips under the kept amount while farming', () => {
    const f = fleet({ five: { troop: { ballista: 5500 } } });
    const camp = { fieldId: C.coordsToFieldId(490, 620) };
    const p = push(f.five, Object.values(f), 'keeptroops 8 b:5k', { selfArmys: [march(f.five, camp, C.MISSION.attack, { troop: { ballista: 550 } })] }).plan;
    assert.deepStrictEqual(p.actions[0].troops, { ballista: 500 });
  });

  await t('sendtroops: to any city under remoteAmount, counting what it holds and what is on its way', () => {
    const f = fleet({ nine: { troop: { scouter: 500e3 } }, eight: { troop: { scouter: 90e3 } }, five: { troop: { scouter: 10e3 } }, fla: { troop: { scouter: 150e3 } } });
    const coming = march(f.eight, f.five, C.MISSION.reinforce, { troop: { scouter: 60e3 } });
    const p = push(f.nine, Object.values(f), 'sendtroops any scout 100k 100k', { selfArmys: [coming] }).plan;
    // 8 has 90k (10k short); 5 has 10k + 60k coming (30k short); Fla has plenty
    assert.deepStrictEqual(p.actions.map((a) => [a.to.name, a.troops.scouter]), [['8', 10e3], ['5', 30e3]]);
  });

  await t('sendtroops: a minimum batch waits unless the receiver is critically low', () => {
    let f = fleet({ nine: { troop: { archer: 500e3 } }, fla: { troop: { archer: 80e3 } } });
    let p = push(f.nine, Object.values(f), 'sendtroops Fla archer 100k 100k 50k 100k').plan;
    assert.deepStrictEqual(p.actions, []);
    has(p.note, 'Fla: only 20k fits under 100k there, under the 50k minimum batch');
    f = fleet({ nine: { troop: { archer: 500e3 } }, fla: { troop: { archer: 40e3 } } });
    p = push(f.nine, Object.values(f), 'sendtroops Fla archer 100k 100k 70k 100k').plan;
    assert.deepStrictEqual(p.actions[0].troops, { archer: 60e3 }, 'Fla holds 40k of 100k: under half, so 60k goes');
  });

  await t('sendtroops to another account\'s coordinates with * reinforces that field', async () => {
    const f = fleet({ nine: { troop: { archer: 500e3 } } });
    const { plan: p, game } = push(f.nine, Object.values(f), 'sendtroops 300,300 archer 450k * * 20k');
    const a = p.actions[0];
    assert.deepStrictEqual([a.kind, a.to.name, a.troops], ['reinforceTroops', '300,300', { archer: 20e3 }]);
    await T.executors.reinforceTroops(game, f.nine, a);
    assert.strictEqual(game.sent[0].bean.targetPoint, C.coordsToFieldId(300, 300));
  });

  await t('troops never go below this city\'s own requesttroops trigger', () => {
    const f = fleet({ five: { troop: { archer: 500e3 } } });
    const p = push(f.five, Object.values(f), 'keeptroops 8 a:100k\nrequesttroops any archer 450k 10k').plan;
    assert.deepStrictEqual(p.actions[0].troops, { archer: 50e3 });
  });

  await t('transports that carry this pass\'s resources are not also sent as troops', () => {
    const f = fleet();
    const p = push(f.five, Object.values(f), 'keepresources 8 f:2.95b\nkeeptroops 8 t:5000').plan;
    // 20,000 transports: 10,000 carry the food, 10,000 are home, 5,000 over the keep go
    const tr = p.actions.find((a) => a.kind === 'reinforceTroops');
    assert.deepStrictEqual(tr.troops, { carriage: 5000 });
  });

  // ================================================================ engine
  console.log('\nthe engine sends push marches through the rally book\n');

  function engineFor(castles, srcFor, selfArmys = []) {
    const game = fakeGame(castles, selfArmys);
    const e = new Engine(game, () => {});
    e.dryRun = false;
    e.state = {};
    e.goalsFor = (id, name) => parseGoals(`config hero:0\n${srcFor[name] || ''}`);
    return { e, game };
  }

  await t('a push is sent once; the next tick waits while it is on its way', async () => {
    const f = fleet();
    // 200m over the keep, 90m a march: the first march leaves 110m still over
    const { e, game } = engineFor([f.fla, f.five], { 5: 'keepresources Fla f:2.8b' });
    await e.tick();
    assert.strictEqual(game.sent.length, 1);
    assert.deepStrictEqual([game.sent[0].castleId, game.sent[0].bean.targetPoint, game.sent[0].bean.resource.food], [f.five.castleId, f.fla.fieldId, 90e6]);
    await e.tick();
    assert.strictEqual(game.sent.length, 1, 'sent again before the first was listed');
    has(e.lastReport[f.five.castleId].push.note, 'Fla: the last mission to it not back yet');
  });

  await t('the console\'s War Town Mode holds a push', async () => {
    const f = fleet();
    const { e, game } = engineFor([f.fla, f.five], { 5: 'keepresources Fla f:2.95b' });
    e.controlsFor = (c) => (c === f.five ? { wartown: 1 } : {});
    await e.tick();
    assert.strictEqual(game.sent.length, 0);
    has(e.lastReport[f.five.castleId].push.note, 'war town (1)');
  });

  await t('a push to another account runs through the engine too', async () => {
    const f = fleet();
    const { e, game } = engineFor([f.fla, f.five], { 5: 'keepresources 300,300 f:2.95b 10m' });
    await e.tick();
    assert.deepStrictEqual([game.sent.length, game.sent[0].bean.targetPoint], [1, C.coordsToFieldId(300, 300)]);
  });

  await t('the pull goals are untouched: a push line changes nothing in requestresources', () => {
    const f = fleet();
    const ctxOf = (src) => {
      const parsed = clean(src);
      return { castle: f.fla, goals: parsed.goals, config: parsed.config, goalsOf: () => parsed.goals, selfArmies: [] };
    };
    const pull = 'requestresources any food 5b 1b * 50m /below:500m';
    const a = T.plans.transfer(ctxOf(pull), {}, fakeGame(Object.values(f)));
    const b = T.plans.transfer(ctxOf(`${pull}\nkeepresources any f:1b\nsendtroops any archer 1 1`), {}, fakeGame(Object.values(f)));
    assert.deepStrictEqual(b.note, a.note);
    assert.deepStrictEqual(b.actions.map((x) => x.label), a.actions.map((x) => x.label));
    assert.strictEqual(T.plans.transfer(ctxOf('keepresources any f:1b'), {}, fakeGame(Object.values(f))), null);
  });

  // ============================================================ trade: parsing
  console.log('\nconfig trade, tradepolicy, resourcelimits: parsing\n');

  await t('config trade is 0 or 1, a bare "trade 1" is read as config, and the line is blue now', () => {
    assert.strictEqual(clean('config trade:1').config.trade, 1);
    assert.strictEqual(clean('config trade:0').config.trade, 0);
    has(errOf('config trade:2'), 'trade is 0 (off) or 1 (on)');
    const p = parseGoals('trade 1');
    assert.deepStrictEqual([p.config.trade, p.lines[0].status], [1, 'ok']);
    has(p.lines[0].msg, 'read as "config trade:1"');
    assert.ok(!('trade' in G.NOT_IMPLEMENTED.config), 'config trade is still on the not-implemented table');
    assert.deepStrictEqual(parseGoals('config trade:1').lines[0], { n: 1, status: 'ok', msg: null });
  });

  await t('tradepolicy reads the wiki\'s lines', () => {
    const p = clean(['tradepolicy /type:gold /min:50m', 'tradepolicy /type:food /min:2d /max:10b /batch:1m',
      'tradepolicy /type:wood /min:20m /max:30m /batch:500k /allowselltomin', 'tradepolicy /type:stone /min:500m /max:1b /batch:1m',
      'tradepolicy /type:iron /min:20m /max:30m /batch:500k', 'tradepolicy /type:food /min:2d /max:10b /batch:1m /donotautosellabovemax',
      'tradepolicy /type:lumber /min:10m', 'tradepolicy /type=gold /min=3d', 'tradepolicy /type:food /min:3d /max:20d'].join('\n'));
    const [gold, food, wood, stone, iron, food2, lumber, gold3, food3] = p.goals;
    assert.deepStrictEqual([gold.type, gold.set], ['gold', { min: 50e6 }]);
    assert.deepStrictEqual(food.set, { min: { days: 2 }, max: 10e9, batch: 1e6 });
    assert.deepStrictEqual(wood.set, { min: 20e6, max: 30e6, batch: 500e3, sellToMin: true });
    assert.deepStrictEqual([stone.type, iron.set.max], ['stone', 30e6]);
    assert.strictEqual(food2.set.keepAboveMax, true);
    assert.deepStrictEqual([lumber.type, gold3.set], ['wood', { min: { days: 3 } }]);
    assert.deepStrictEqual(food3.set, { min: { days: 3 }, max: { days: 20 } });
  });

  await t('tradepolicy mistakes are errors and the line is not used', () => {
    has(errOf('tradepolicy /min:20m'), 'needs /type');
    has(errOf('tradepolicy /type:rubies /min:1m'), '/type:rubies');
    has(errOf('tradepolicy /type:gold /min:5m /max:10m'), 'gold cannot have a /max');
    has(errOf('tradepolicy /type:wood /min:2d'), '"d" (days) is for gold and food minimums and food maximums only');
    has(errOf('tradepolicy /type:gold /min:1m /batch:1m'), 'gold is not traded itself');
    has(errOf('tradepolicy /type:wood /min:30m /max:20m'), '/min 30m is more than /max 20m');
    has(errOf('tradepolicy /type:wood /min:lots'), '/min:lots needs an amount');
    has(errOf('tradepolicy /type:wood /cheap:1'), 'unknown switch /cheap');
    has(errOf('tradepolicy wood 20m'), 'expected /switch:value');
    assert.strictEqual(parseGoals('tradepolicy /type:wood /min:lots').goals[0].ok, false);
  });

  await t('resourcelimits takes four amounts: food, lumber, stone, iron', () => {
    assert.deepStrictEqual(one('resourcelimits 2b 50m 2b 20m').limits, { food: 2e9, wood: 50e6, stone: 2e9, iron: 20e6 });
    has(errOf('resourcelimits 2b 50m 2b'), 'expected: resourcelimits <food> <lumber> <stone> <iron>');
    has(errOf('resourcelimits 2b 50m lots 20m'), 'stone "lots" is not an amount');
  });

  await t('settings: built-in values, resourcelimits, then tradepolicy lines after it change what they name', () => {
    const { policyOf } = TR._internals;
    let { pol } = policyOf([]);
    assert.deepStrictEqual([pol.food.min, pol.food.max, pol.wood.min, pol.wood.max, pol.gold.min], [{ days: 1 }, 990e9, 20e6, 7.2e12, null]);
    ({ pol } = policyOf(clean('resourcelimits 100b 20m 10b 50m\ntradepolicy /type:gold /min:500m\ntradepolicy /type:wood /batch:1m').goals));
    assert.deepStrictEqual([pol.food.min, pol.food.max, pol.wood.min, pol.wood.max, pol.wood.batch, pol.gold.min], [100e9, 100e9, 20e6, 20e6, 1e6, 500e6]);
    const r = policyOf(parseGoals('tradepolicy /type:wood /min:30m\ntradepolicy /type:wood /min:lots').goals);
    assert.deepStrictEqual([r.pol.wood.min, r.skipped], [30e6, ['tradepolicy line 2']]);
  });

  await t('describe says what the market lines mean', () => {
    const out = describe(clean('config trade:1\nresourcelimits 2b 50m 2b 20m\ntradepolicy /type:food /min:2d /max:10b /batch:1m\ntradepolicy /type:gold /min:3d')).join('\n');
    has(out, 'resourcelimits: keep food 2,000,000,000, wood 50,000,000');
    has(out, 'tradepolicy: food — at least 2 day(s) of troop upkeep, at most 10,000,000,000, in lots of 1,000,000 or more');
    has(out, 'tradepolicy: gold (the floor no bid goes under) — at least 3 day(s) of hero salary');
  });

  // ============================================================== trade: plan
  console.log('\ntradepolicy: what a pass decides\n');

  await t('without config trade:1 nothing trades, and tradepolicy lines say they wait', async () => {
    const c = trader(); const g = marketGame([c]);
    assert.strictEqual(await tplan(c, g, ''), null);
    const p = await tplan(c, g, 'tradepolicy /type:wood /min:100m');
    assert.deepStrictEqual(p.actions, []);
    has(p.note, 'wait for config trade:1');
    assert.strictEqual((await tplan(c, g, 'config trade:0\ntradepolicy /type:wood /min:100m')).actions.length, 0);
  });

  await t('no Marketplace: nothing to trade with', async () => {
    const c = trader(); c.buildings = c.buildings.filter((b) => b.typeId !== 23);
    const p = await tplan(c, marketGame([c]), 'config trade:1');
    has(p.note, 'no Marketplace in this city');
  });

  await t('no prices yet: the pass reads the market first, and the read fills every book', async () => {
    const c = trader({ wood: 5e6 }); const g = marketGame([c]);
    const p = await tplan(c, g, 'config trade:1', { fresh: false });
    assert.deepStrictEqual(kinds(p), ['marketRead']);
    has(p.note, 'reading the market prices first');
    assert.deepStrictEqual(await run(g, c, p.actions[0], {}), { ok: 1 });
    assert.deepStrictEqual(g.reads, ['food', 'wood', 'stone', 'iron']);
    const q = await tplan(c, g, 'config trade:1', { fresh: false });
    assert.deepStrictEqual(kinds(q), ['marketBuy'], 'the next pass trades on what was read');
  });

  await t('prices someone else read (game.marketBook) are used too', async () => {
    const c = trader({ wood: 5e6 }); const g = marketGame([c]);
    g.marketBook = (r) => ({ at: g.time, sellers: g.book[r].asks, buyers: g.book[r].bids });
    const p = await tplan(c, g, 'config trade:1', { fresh: false });
    assert.deepStrictEqual(kinds(p), ['marketBuy']);
  });

  await t('the built-in values: wood under 20m is bought with the gold over a day of salary', async () => {
    const c = trader({ wood: 5e6 }); const g = marketGame([c]);
    const p = await tplan(c, g, 'config trade:1');
    const a = act(p, 'marketBuy', 'wood');
    assert.deepStrictEqual([a.amount, a.goldFloor, a.minTotal, a.funding], [15e6, 240e3, 100e3, 'gold']);
    has(p.note, 'gold 1b (floor 240k)');
  });

  await t('the gold floor: a bid never takes gold under /min, the 0.5% fee included', async () => {
    const c = trader({ wood: 5e6, gold: 1e9 }); const g = marketGame([c], { wood: { asks: [[20, 1e9]], bids: [[19, 1e9]] } });
    const state = {};
    const p = await tplan(c, g, 'config trade:1\ntradepolicy /type:gold /min:900m', { state });
    const a = act(p, 'marketBuy', 'wood');
    assert.strictEqual(a.amount, Math.floor(100e6 / (20 * 1.005)));
    await run(g, c, a, state);
    assert.ok(c.resource.gold >= 900e6, `gold went to ${c.resource.gold}`);
    assert.strictEqual(g.writes[0].amount, 4975124);
  });

  await t('what is short but under the batch waits', async () => {
    const c = trader({ wood: 19.95e6 }); const g = marketGame([c]);
    const p = await tplan(c, g, 'config trade:1\ntradepolicy /type:wood /min:20m /batch:100k');
    assert.deepStrictEqual(kinds(p), []);
    has(p.note, 'wood 19.95m < 20m min: waiting — 50k short, under the 100k batch');
  });

  await t('days: food /min:2d is two days of troop upkeep, gold /min:3d three days of hero salary', async () => {
    const c = trader({ food: 500e3, gold: 1e9 }); const g = marketGame([c]);
    const p = await tplan(c, g, 'config trade:1\ntradepolicy /type:food /min:2d\ntradepolicy /type:gold /min:3d');
    const a = act(p, 'marketBuy', 'food');
    assert.deepStrictEqual([a.amount, a.goldFloor], [2 * 24 * 20000 - 500e3, 3 * 24 * 10000]);
  });

  await t('a /min that counts out over its /max reads the /max as the /min, so nothing is bought to be sold back', async () => {
    // food /min:2d = 960k with 20k/h upkeep, over /max:500k
    const c = trader({ food: 700e3 }); const g = marketGame([c]);
    const p = await tplan(c, g, 'config trade:1\ntradepolicy /type:food /min:2d /max:500k /batch:1k');
    has(p.note, 'food: /min 960k is over /max 500k — /max read as 960k');
    assert.deepStrictEqual(p.actions.map((a) => [a.kind, a.res]), [['marketBuy', 'food']]);
    assert.strictEqual(act(p, 'marketSell'), undefined);
  });

  await t('old prices plan nothing: they are read again first', async () => {
    const c = trader({ wood: 5e6 }); const g = marketGame([c]);
    await TR.executors.marketRead(g, c, {}, {});
    g.time += TR._internals.BOOK_TTL_MS + 1;
    const p = await tplan(c, g, 'config trade:1', { fresh: false });
    assert.deepStrictEqual(kinds(p), ['marketRead']);
    has(p.note, 'wood 5m < 20m min: waiting for fresh wood prices');
  });

  await t('what our transports are bringing counts too: a city that also requests wood does not buy it', async () => {
    const c = trader({ wood: 5e6 });
    const hub = city('Hub', 110, 100);
    const going = march(hub, c, C.MISSION.transport, { resource: { wood: 15e6 } });
    const g = marketGame([c, hub], {}, { selfArmys: [going] });
    const p = await tplan(c, g, 'config trade:1');
    assert.strictEqual(act(p, 'marketBuy', 'wood'), undefined, p.note);
    // on its way home it has delivered: then it is bought
    going.direction = 2;
    assert.ok(act(await tplan(c, g, 'config trade:1'), 'marketBuy', 'wood'));
  });

  await t('hero salary unknown: the gold floor can\'t be worked out, so nothing is bought', async () => {
    const c = trader({ wood: 5e6, salary: null }); const g = marketGame([c]);
    const p = await tplan(c, g, 'config trade:1');
    assert.deepStrictEqual(kinds(p), []);
    has(p.note, 'hero salary unknown');
  });

  await t('no spare gold: what another resource holds over /max is sold to buy what is short', async () => {
    const c = trader({ wood: 5e6, food: 3e9, gold: 1e6 }); const g = marketGame([c]);
    const p = await tplan(c, g, 'config trade:1\ntradepolicy /type:gold /min:1m\ntradepolicy /type:food /min:0 /max:1b');
    const s = act(p, 'marketSell', 'food');
    assert.ok(s, p.note);
    // 15m wood at 20 (+0.5%) = 301.5m gold; food sells at 19 less 0.5%
    assert.strictEqual(s.amount, Math.ceil(15e6 * 20 * 1.005 / (19 * 0.995)));
    assert.strictEqual(s.keep, 1e9, 'never below its /max');
    assert.strictEqual(act(p, 'marketBuy'), undefined);
  });

  await t('/allowselltomin: nothing over /max and no gold to spare — others are sold down to their /min', async () => {
    const c = trader({ wood: 5e6, stone: 900e6, gold: 1e6 }); const g = marketGame([c]);
    const base = 'config trade:1\ntradepolicy /type:gold /min:1m\ntradepolicy /type:stone /min:500m /max:1b';
    let p = await tplan(c, g, `${base}\ntradepolicy /type:wood /min:20m`);
    assert.deepStrictEqual(kinds(p), []);
    has(p.note, 'wood 5m < 20m min: waiting — no gold over the 1m floor and nothing over /max to sell (/allowselltomin would sell others down to their /min)');
    p = await tplan(c, g, `${base}\ntradepolicy /type:wood /min:20m /allowselltomin`);
    const s = act(p, 'marketSell');
    assert.ok(s, p.note);
    assert.ok(['stone', 'food', 'iron'].includes(s.res));
    assert.ok(s.keep >= (s.res === 'stone' ? 500e6 : 0), 'never below that resource\'s /min');
  });

  await t('stage 3: what is over /max is sold, and what that brings in buys the ones under /max, in proportion', async () => {
    const c = trader({ food: 12e9, wood: 20e6, iron: 25e6, stone: 1e9 }); const g = marketGame([c]);
    const src = 'config trade:1\ntradepolicy /type:food /min:1b /max:10b /batch:1m\ntradepolicy /type:wood /min:10m /max:30m\n'
      + 'tradepolicy /type:iron /min:10m /max:30m\ntradepolicy /type:stone /min:500m /max:1b';
    const state = {};
    const p = await tplan(c, g, src, { state });
    assert.deepStrictEqual(kinds(p), ['marketSell', 'marketBuy'], p.note);
    const s = act(p, 'marketSell', 'food');
    assert.deepStrictEqual([s.amount, s.proceeds], [2e9, true]);
    // wood is 10m under, iron 5m: two thirds of the money to wood — the first
    // buy this pass is wood (the other waits for the next pass)
    const b = act(p, 'marketBuy');
    assert.deepStrictEqual([b.res, b.funding], ['wood', 'proceeds']);
    assert.strictEqual(b.amount, 10e6);
    // run them: the sale's gold pays the buy, and no more than it brought in
    assert.strictEqual((await run(g, c, s, state)).ok, 1);
    assert.ok(state.trade.proceeds.gold > 0);
    const had = state.trade.proceeds.gold;
    assert.strictEqual((await run(g, c, b, state)).ok, 1);
    assert.ok(state.trade.proceeds.gold < had, 'the buy spent from the proceeds');
    // the next pass buys iron with what is left of them
    const q = await tplan(c, g, src, { state });
    assert.ok(act(q, 'marketBuy', 'iron'), q.note);
  });

  await t('stage 3 spends no gold of its own: nothing over /max means nothing bought toward /max', async () => {
    const c = trader({ food: 5e9, wood: 20e6, gold: 50e9 }); const g = marketGame([c]);
    const p = await tplan(c, g, 'config trade:1\ntradepolicy /type:wood /min:10m /max:30m');
    assert.deepStrictEqual(kinds(p), []);
    has(p.note, 'all within tradepolicy');
  });

  await t('every resource at /max: the excess is sold and the gold kept — unless /donotautosellabovemax', async () => {
    const c = trader({ food: 12e9, wood: 30e6, stone: 1e9, iron: 30e6 }); const g = marketGame([c]);
    const src = 'config trade:1\ntradepolicy /type:wood /max:30m\ntradepolicy /type:stone /max:1b\ntradepolicy /type:iron /max:30m\n';
    let p = await tplan(c, g, `${src}tradepolicy /type:food /max:10b`);
    const s = act(p, 'marketSell', 'food');
    assert.deepStrictEqual([s.amount, s.proceeds], [2e9, false]);
    assert.strictEqual(act(p, 'marketBuy'), undefined, 'the gold is hoarded');
    p = await tplan(c, g, `${src}tradepolicy /type:food /max:10b /donotautosellabovemax`);
    assert.deepStrictEqual(kinds(p), []);
    has(p.note, 'food over its 10b max is kept (/donotautosellabovemax)');
    // ...but with another resource under /max it still sells
    c.resource.iron.amount = 20e6;
    p = await tplan(c, g, `${src}tradepolicy /type:food /max:10b /donotautosellabovemax`);
    assert.ok(act(p, 'marketSell', 'food'), p.note);
  });

  await t('emergency: gold under a day of salary sells resources, ignoring /min and /batch', async () => {
    const c = trader({ gold: 100e3, wood: 50e6 }); const g = marketGame([c]);
    const p = await tplan(c, g, 'config trade:1\ntradepolicy /type:wood /min:100m /batch:10m');
    has(p.note, 'EMERGENCY: gold 100k is under a day of hero salary (240k)');
    const s = act(p, 'marketSell');
    assert.ok(s && s.emergency, p.note);
    assert.strictEqual(s.minTotal, 1, 'the batch is set aside');
    assert.ok(s.amount * 19 * 0.995 >= 25 * 10000 - 100e3, 'enough to get back over a day of salary');
  });

  await t('emergency: food under 30 minutes of upkeep is bought, ignoring the gold floor', async () => {
    const c = trader({ food: 5000, gold: 300e3 }); const g = marketGame([c]);
    const p = await tplan(c, g, 'config trade:1\ntradepolicy /type:gold /min:1b');
    has(p.note, 'food 5k is under 30 minutes of troop upkeep');
    const b = act(p, 'marketBuy', 'food');
    // an hour of upkeep is 20k, 15k short: as much of it as all the gold buys (the 1b floor set aside)
    assert.deepStrictEqual([b.amount, b.goldFloor, b.emergency], [Math.floor(300e3 / (20 * 1.005)), 0, true]);
  });

  // ========================================================= trade: executors
  console.log('\ntradepolicy: placing orders\n');

  await t('a buy takes each ask level at its own price (you are charged your bid), within 10% of the best', async () => {
    const c = trader({ wood: 5e6 });
    const g = marketGame([c], { wood: { asks: [[15, 3e6], [15.5, 20e6], [30, 50e6]], bids: [[14, 1e9]] } });
    const state = {};
    const p = await tplan(c, g, 'config trade:1', { state });
    const a = act(p, 'marketBuy', 'wood');
    assert.strictEqual((await run(g, c, a, state)).ok, 1);
    assert.deepStrictEqual(g.writes.map((w) => [w.type, w.amount, w.price]), [['buy', 3e6, '15'], ['buy', 12e6, '15.5']]);
    has(a.label, 'bid 3m @ 15, 12m @ 15.5');
    assert.strictEqual(c.transingTrades.reduce((s, x) => s + x.amount, 0), 15e6, 'all of it bought');
  });

  await t('a buy never pays past twice the best bid; a sell never takes under half the best ask', async () => {
    const { levelsFor } = TR._internals;
    const book = { asks: [{ price: 50, amount: 1e9 }], bids: [{ price: 20, amount: 1e9 }] };
    assert.deepStrictEqual(levelsFor(book, 'buy', 0.1, false).levels, []);
    has(levelsFor(book, 'buy', 0.1, false).why, 'over 2x the best bid 20');
    const junk = { asks: [{ price: 20, amount: 1e9 }], bids: [{ price: 0.11, amount: 1e9 }] };
    assert.deepStrictEqual(levelsFor(junk, 'sell', 0.1, false).levels, []);
    has(levelsFor(junk, 'sell', 0.1, false).why, 'under 1/2 of the cheapest ask 20');
    // an emergency accepts more
    assert.strictEqual(levelsFor({ asks: [{ price: 50, amount: 1 }], bids: [{ price: 20, amount: 1 }] }, 'buy', 0.5, true).levels.length, 1);
  });

  await t('a sell goes into the bids at their own price, keeps what the plan keeps, and pays its fee in gold', async () => {
    const c = trader({ food: 12e9 });
    const g = marketGame([c], { food: { asks: [[20, 1e9]], bids: [[19, 1.5e9], [18.5, 1e9], [10, 5e9]] } });
    const a = { kind: 'marketSell', res: 'food', amount: 2e9, keep: 10e9, minTotal: 1e6, band: 0.1, label: 'sell 2,000,000,000 food' };
    const gold0 = c.resource.gold;
    assert.strictEqual((await run(g, c, a, {})).ok, 1);
    // 99,999,999 per order at most: the first level takes one full order
    assert.deepStrictEqual(g.writes.map((w) => [w.type, w.amount, w.price]), [['sell', 99999999, '19'], ['sell', 99999999, '18.5']]);
    assert.ok(c.resource.food.amount >= 10e9);
    assert.ok(c.resource.gold > gold0);
  });

  await t('the batch holds a small trade back at the order too', async () => {
    const c = trader({ wood: 5e6 });
    const g = marketGame([c], { wood: { asks: [[20, 50e3]], bids: [[19, 1e9]] } });
    const r = await run(g, c, { kind: 'marketBuy', res: 'wood', amount: 15e6, minTotal: 100e3, band: 0.1, goldFloor: 0, funding: 'gold', label: 'x' }, {});
    assert.strictEqual(r.ok, 0);
    has(r.errorMsg, 'only 50k can be bought within the price limits, under the 100k batch');
    assert.strictEqual(g.writes.length, 0);
  });

  await t('pacing: market writes 1.2 s apart; no answer doubles the gap and holds the city', async () => {
    const c = trader({ wood: 5e6 });
    const g = marketGame([c], { wood: { asks: [[15, 3e6], [15.5, 20e6]], bids: [[14, 1e9]] } });
    const state = {};
    await run(g, c, { kind: 'marketBuy', res: 'wood', amount: 15e6, minTotal: 1, band: 0.1, goldFloor: 0, funding: 'gold', label: 'x' }, state);
    assert.strictEqual(g.writes[1].at - g.writes[0].at, 1200);
    g.noReply = true;
    const r = await run(g, c, { kind: 'marketBuy', res: 'wood', amount: 1e6, minTotal: 1, band: 0.1, goldFloor: 0, funding: 'gold', label: 'x' }, state);
    assert.strictEqual(r.ok, 0);
    has(r.errorMsg, 'no answer');
    assert.ok(state.trade.holdUntil > g.time, 'the city holds');
    const p = await tplan(c, g, 'config trade:1', { state, fresh: false });
    has(p.note, 'trade: holding — the market did not answer');
    assert.deepStrictEqual(p.actions, []);
    g.noReply = false;
    g.time = state.trade.holdUntil + 1;
    const before = g.writes.length;
    await run(g, c, { kind: 'marketBuy', res: 'wood', amount: 1e6, minTotal: 1, band: 0.1, goldFloor: 0, funding: 'gold', label: 'x' }, state);
    const w = g.writes.slice(before - 1);
    assert.ok(w[1].at - w[0].at >= 2400, `the gap after a miss was ${w[1].at - w[0].at} ms`);
  });

  await t('-38, the marketplace is full: it stops, learns how many it holds, and waits for a slot', async () => {
    const c = trader({ wood: 5e6 });
    c.buildings.find((b) => b.typeId === 23).level = 10;
    const g = marketGame([c], { wood: { asks: [[15, 3e6], [15.5, 20e6]], bids: [[14, 1e9]] } });
    g.cap = 4;
    for (let i = 0; i < 4; i++) c.trades.push({ id: 900 + i, tradeType: 1, resType: 0, amount: 1, dealedAmount: 0, price: 99 });
    const r = await run(g, c, { kind: 'marketBuy', res: 'wood', amount: 15e6, minTotal: 1, band: 0.1, goldFloor: 0, funding: 'gold', label: 'x' }, {});
    assert.strictEqual(r.ok, 0);
    has(r.errorMsg, 'the marketplace is full (4 offers are allowed at level 4 Marketplace.)');
    assert.strictEqual(g.writes.length, 1, 'no second order after the refusal');
    assert.strictEqual(TR._internals.capOf(g, c), 4);
    const p = await tplan(c, g, 'config trade:1');
    assert.deepStrictEqual(kinds(p), []);
    has(p.note, 'waiting — all 4 market offers of this city are in use');
  });

  await t('what rests on the book is ours: it counts as coming, and no second buy goes in while it rests', async () => {
    const c = trader({ wood: 5e6 });
    // 15m for sale at 15 when we look; someone takes 10m of it before our bid
    // lands, so it fills 5m and 10m rests
    const g = marketGame([c], { wood: { asks: [[15, 15e6]], bids: [[14, 1e9]] } });
    g.onTrade = () => { g.book.wood.asks[0].amount = 5e6; g.onTrade = null; };
    const state = {};
    await run(g, c, { kind: 'marketBuy', res: 'wood', amount: 15e6, minTotal: 1, band: 0.1, goldFloor: 0, funding: 'gold', label: 'x' }, state);
    assert.strictEqual(c.trades.length, 1);
    g.book.wood.asks = [{ price: 15, amount: 1e9 }];
    const p = await tplan(c, g, 'config trade:1', { state });
    assert.strictEqual(act(p, 'marketBuy', 'wood'), undefined, p.note);
    // 5m + 5m in transit + 10m resting = 20m: not short any more
    has(p.note, 'wood 20m');
  });

  await t('our offers are cancelled after 20 minutes (the fee is lost, and the log says so); nobody else\'s ever', async () => {
    const c = trader({ wood: 5e6 });
    const g = marketGame([c], { wood: { asks: [[15, 15e6]], bids: [[14, 1e9]] } });
    g.onTrade = () => { g.book.wood.asks[0].amount = 5e6; g.onTrade = null; };
    const state = {};
    await run(g, c, { kind: 'marketBuy', res: 'wood', amount: 15e6, minTotal: 1, band: 0.1, goldFloor: 0, funding: 'gold', label: 'x' }, state);
    c.trades.push({ id: 777, tradeType: 0, resType: 1, amount: 99e6, dealedAmount: 0, price: 0.11 });   // someone else's
    let p = await tplan(c, g, 'config trade:1', { state });
    assert.ok(!kinds(p).includes('marketCancel'), 'not stale yet');
    g.time += TR._internals.STALE_MS;
    p = await tplan(c, g, 'config trade:1', { state });
    const x = act(p, 'marketCancel');
    assert.ok(x, p.note);
    assert.strictEqual(p.actions.filter((a) => a.kind === 'marketCancel').length, 1, 'only ours');
    has(x.label, 'cancel our buy offer of 10,000,000 wood @ 15 — on the book 20 min (its fee, about 750,000 gold, is not refunded)');
    const gold0 = c.resource.gold;
    assert.strictEqual((await run(g, c, x, state)).ok, 1);
    assert.strictEqual(c.resource.gold - gold0, 10e6 * 15, 'the order is refunded, the fee is not');
    assert.deepStrictEqual(c.trades.map((o) => o.id), [777]);
    const r = await run(g, c, { kind: 'marketCancel', tradeId: 777, label: 'x' }, state);
    assert.strictEqual(r.ok, 0);
    has(r.errorMsg, 'not one of our offers');
  });

  await t('no resource push since our last order (goalsd applies none): the next pass waits, never buys twice', async () => {
    const c = trader({ wood: 5e6 });
    const g = marketGame([c], { wood: { asks: [[15, 50e6]], bids: [[14, 1e9]] } });
    g.noPush = true;
    const state = {};
    const gold0 = c.resource.gold;
    let p = await tplan(c, g, 'config trade:1', { state });
    await run(g, c, act(p, 'marketBuy', 'wood'), state);
    // nothing pushed: the city still shows the gold it had, and no purchase in transit
    c.resource.gold = gold0;
    c.transingTrades.length = 0;
    const before = g.writes.length;
    p = await tplan(c, g, 'config trade:1', { state });
    assert.deepStrictEqual(kinds(p), []);
    has(p.note, 'waiting — the server has not reported this city\'s resources since our last order');
    // a second order in the same slice goes by our own sums (1b less the 226m
    // just bid is under an 800m floor), not by the old 1b
    const r = await run(g, c, { kind: 'marketBuy', res: 'wood', amount: 10e6, minTotal: 1, band: 0.1, goldFloor: 800e6, funding: 'gold', label: 'x' }, state);
    assert.strictEqual(r.ok, 0, r.errorMsg);
    assert.strictEqual(g.writes.length, before, 'bid again on figures from before the first buy');
    // the push comes: trading carries on
    g.noPush = false;
    c.resource = { ...c.resource };
    p = await tplan(c, g, 'config trade:1', { state });
    hasNotWaiting(p.note);
  });

  await t('order count: two trades a pass at most, and no more than two of our own offers resting', async () => {
    const c = trader({ wood: 5e6, stone: 5e6, iron: 5e6 }); const g = marketGame([c]);
    const p = await tplan(c, g, 'config trade:1');
    assert.strictEqual(p.actions.filter((a) => a.kind === 'marketBuy').length, TR._internals.TRADES_PER_PASS);
    has(p.note, ': next pass');
    const state = { trade: { orders: [], pending: [] } };
    for (const [id, r] of [[1, 1], [2, 2]]) {
      c.trades.push({ id, tradeType: 0, resType: r, amount: 1e6, dealedAmount: 0, price: 1 });
      state.trade.orders.push({ id, res: ['food', 'wood', 'stone'][r], side: 'buy', amount: 1e6, price: 1, at: g.time });
    }
    const q = await tplan(c, g, 'config trade:1', { state });
    assert.deepStrictEqual(kinds(q), [], q.note);
    has(q.note, 'waiting — our buy offer for wood is still on the book');
    has(q.note, 'waiting — 2 of our own offers are still on the book');
  });

  // ========================================================= holidaysnipe
  console.log('\nholidaysnipe and the market goals\n');

  await t('a resource holidaysnipe is buying a dump of is left to it, in every city', async () => {
    const c = trader({ wood: 5e6, iron: 5e6 }); const g = marketGame([c]);
    const snipe = { dry: false, buying: new Set(['wood']), cities: new Set(), listed: new Set() };
    const p = await tplan(c, g, 'config trade:1', { snipe });
    assert.deepStrictEqual(p.actions.filter((a) => a.kind === 'marketBuy').map((a) => a.res), ['iron']);
    has(p.note, 'wood: holidaysnipe is buying a dump of it — left to it');
  });

  await t('a city with holidaysnipe\'s buy orders open is left alone', async () => {
    const c = trader({ wood: 5e6 }); const g = marketGame([c]);
    const p = await tplan(c, g, 'config trade:1', { snipe: { dry: false, buying: new Set(), cities: new Set([c.castleId]), listed: new Set() } });
    assert.deepStrictEqual(kinds(p), []);
    has(p.note, 'holidaysnipe has buy orders open in this city');
  });

  await t('a resource holidaysnipe lists for sale in a city is not sold there too', async () => {
    const c = trader({ food: 12e9, wood: 30e6, stone: 1e9, iron: 30e6 }); const g = marketGame([c]);
    const src = 'config trade:1\ntradepolicy /type:food /max:10b\ntradepolicy /type:wood /max:30m\ntradepolicy /type:stone /max:1b\ntradepolicy /type:iron /max:30m';
    const p = await tplan(c, g, src, { snipe: { dry: false, buying: new Set(), cities: new Set(), listed: new Set([`${c.castleId}:food`]) } });
    assert.strictEqual(act(p, 'marketSell', 'food'), undefined);
    has(p.note, 'food: holidaysnipe keeps a sell offer listed here — not selling it too');
  });

  await t('a dry holidaysnipe run claims nothing', async () => {
    const c = trader({ wood: 5e6 }); const g = marketGame([c]);
    const p = await tplan(c, g, 'config trade:1', { snipe: { dry: true, buying: new Set(['wood']), cities: new Set([c.castleId]), listed: new Set() } });
    assert.ok(act(p, 'marketBuy', 'wood'), p.note);
  });

  await t('Sniper.claims: its dump, the cities with its buy orders, its listings; nothing when not running', () => {
    const c = trader({}); const other = trader({ name: 'N' });
    const g = marketGame([c, other]);
    const session = { account: { id: 'a1' }, note() {} };
    const s = new HS.Sniper(session, { amount: 99e6 });
    s.buying.add('stone');
    s.used.food = new Set(['0.11']);
    c.trades.push({ id: 1, tradeType: 0, resType: 0, amount: 99e6, dealedAmount: 0, price: 0.11 });
    other.trades.push({ id: 2, tradeType: 0, resType: 0, amount: 5e6, dealedAmount: 0, price: 0.11 });   // not its size: not its
    s.listings.set(`${other.castleId}:9`, { cid: other.castleId, id: 9, res: 'iron' });
    const cl = s.claims(g);
    assert.deepStrictEqual([[...cl.buying], [...cl.cities], [...cl.listed], cl.dry], [['stone'], [c.castleId], [`${other.castleId}:iron`], false]);
    const dry = new HS.Sniper(session, { dry: true }).claims(g);
    assert.deepStrictEqual([dry.dry, dry.cities.size, dry.buying.size], [true, 0, 0]);
    assert.strictEqual(HS.claims('a1', g), null, 'no run in this process');
  });

  // =============================================================== engine
  console.log('\nthe engine runs the market goals\n');

  await t('an engine tick reads the prices, then buys what is short; our orders go through the executors', async () => {
    const c = trader({ wood: 5e6 });
    const g = marketGame([c], { wood: { asks: [[15, 3e6], [15.5, 20e6]], bids: [[14, 1e9]] } });
    const e = new Engine(g, () => {});
    e.dryRun = false;
    e.state = {};
    e.goalsFor = () => parseGoals('config hero:0,trade:1');
    await e.tick();
    assert.strictEqual(g.writes.length, 0, 'the first pass only reads the prices');
    has(e.lastReport[c.castleId].acted.join('\n'), 'read the market prices (food, wood, stone, iron) -> ok');
    await e.tick();
    const rep = e.lastReport[c.castleId];
    has(rep.acted.join('\n'), 'buy 15,000,000 wood');
    has(rep.acted.join('\n'), 'bid 3m @ 15, 12m @ 15.5 -> ok');
    assert.deepStrictEqual(g.writes.map((w) => w.amount), [3e6, 12e6]);
    // both filled: nothing rests, and what was placed is looked for no longer than 5 minutes
    const st = e.state[String(c.castleId)].trade;
    assert.deepStrictEqual([st.orders.length, st.pending.length], [0, 2]);
    g.time += TR._internals.PENDING_MS;
    TR._internals.reconcile(c, st, g.time);
    assert.deepStrictEqual([st.orders.length, st.pending.length], [0, 0]);
  });

  await t('a dry engine plans the trades and places nothing', async () => {
    const c = trader({ wood: 5e6 }); const g = marketGame([c]);
    await TR.executors.marketRead(g, c, {}, {});
    const e = new Engine(g, () => {});
    e.dryRun = true;
    e.state = {};
    e.goalsFor = () => parseGoals('config hero:0,trade:1');
    await e.tick();
    has(e.lastReport[c.castleId].acted.join('\n'), '[plan] buy 15,000,000 wood');
    assert.strictEqual(g.writes.length, 0);
  });

  // ========================================================= the live goals
  console.log('\nthe live goals\n');

  await t('the saved goals parse as before and none of them pushes or trades', () => {
    const live = fs.readFileSync(path.join(__dirname, 'test-goal-lines.js'), 'utf8');
    assert.ok(live.includes('requestresources any'), 'the live fixtures are where they were');
    const src = `config comfort:1,hero:1,troopsusepopmax:1,npc:5
requestresources any wood 2000000 200000 * 500000 /below:100000
requestresources any food 5000000000 1000000000 * 50000000 /below:500000000
traininghero OTTO 30 60
npcheroes !OTTO,any`;
    const p = clean(src);
    const f = fleet();
    const ctx = { castle: f.fla, goals: p.goals, config: p.config, goalsOf: () => p.goals, selfArmies: [] };
    assert.strictEqual(T.plans.push(ctx, {}, fakeGame(Object.values(f))), null);
    assert.strictEqual(TR.plans.trade(ctx, {}, marketGame(Object.values(f))), null);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(path.dirname(process.env.EVONY_DB), { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
