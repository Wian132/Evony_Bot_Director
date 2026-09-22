'use strict';
// Step 17: troop and wall goals at NEAT parity (wiki Troop, TroopQueueTime,
// TroopIdleQueueTime, TroopIncrement, ReservedBarrack, TroopsUseReserved,
// TroopsUsePopMax, TroopDelBadQue, FortificationGoal, FortsUseReserved,
// WallQueueTime; FAQ "Bot is training troops with the wrong hero").
//
// Offline: troopPlan / fortPlan on made-up cities, and the engine end to end
// on a stand-in game that answers the barracks, wall and production reads.
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// db.js opens EVONY_DB when first required: point it at a throwaway file
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'evony-troop17-'));
if (!process.env.EVONY_DB) process.env.EVONY_DB = path.join(TMP, 'test.db');

const C = require('./constants');
const G = require('./goals');
const { parseGoals } = G;
const E = require('./engine');
const { Engine, troopPlan, fortPlan, buildPlan, troopSettings, upkeepPerHour, trainerOf, TROOP_ORDERS } = E;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok    ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message.split('\n').join('\n        ')); fail++; }
}
const has = (s, re) => assert.match(String(s), re instanceof RegExp ? re : new RegExp(re.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

const TY = { worker: 2, warrior: 3, scout: 4, pike: 5, sword: 6, archer: 7, trans: 8, cav: 9, cata: 10, ballista: 11 };
const WALL = { trap: 14, abatis: 15, tower: 16, logs: 17, rocks: 18 };
const BIG = 1e12;
const HOME = 100 * 800 + 100;
// seconds per unit under the mayor the read was made with
const UNIT = {
  2: { time: 10, allowed: true }, 3: { time: 5, allowed: true }, 4: { time: 20, allowed: true },
  5: { time: 30, allowed: true }, 6: { time: 45, allowed: true }, 7: { time: 60, allowed: true },
  8: { time: 200, allowed: true }, 9: { time: 100, allowed: true }, 10: { time: 300, allowed: true },
  11: { time: 600, allowed: true },
};
const bar = (positionId, capacity, items = []) => ({ positionId, capacity, items });

// A city for troopPlan. `src` is goal text; bank/pop/upkeep the castle bean.
function city({ src = 'troop a:100k', config = {}, troop = {}, heros = [], bars = [bar(4, 10)], unit = UNIT,
  bank = {}, pop = {}, upkeep, extra = {} } = {}) {
  const parsed = parseGoals(src);
  assert.deepStrictEqual(parsed.errors, [], src);
  return {
    goals: parsed.goals,
    config: { ...parsed.config, ...config },
    castle: {
      troop, heros, fieldId: HOME,
      resource: {
        food: { amount: bank.food ?? BIG }, wood: { amount: bank.wood ?? BIG },
        stone: { amount: bank.stone ?? BIG }, iron: { amount: bank.iron ?? BIG },
        curPopulation: pop.cur ?? 1e6, maxPopulation: pop.cur ?? 1e6, workPeople: pop.work ?? 0, buildPeople: pop.build ?? 0,
        ...(upkeep !== undefined ? { troopCostFood: upkeep } : {}),
      },
    },
    training: bars === null ? undefined : { barracks: bars, unit },
    ...extra,
  };
}
const orders = (plan) => plan.orders.map((o) => [o.troop.key, o.num, o.positionId]);

// ---------------------------------------------------------------- stand-in game
// One city (id 1) with L10 barracks on plots 4.. and Walls L10. Every command is
// logged in `calls` as [cmd, ...args] in the order it was sent.
function world({ heros = [], barracks = 1, level = 10, queues = {}, times = { [TY.archer]: 60, [TY.ballista]: 100 },
  pop = { cur: 20000, work: 15000 }, upkeep, rates = { 1: 80, 2: 70, 3: 60, 4: 50 }, refuse = {},
  forts = {}, wallQueue = [], enemy = [], others = [], permition = true, needs = {} } = {}) {
  const castle = {
    id: 1, name: 'Home', fieldId: HOME,
    resource: {
      food: { amount: BIG }, wood: { amount: BIG }, stone: { amount: BIG }, iron: { amount: BIG }, gold: BIG,
      curPopulation: pop.cur, maxPopulation: pop.cur, workPeople: pop.work, buildPeople: 0,
      ...(upkeep !== undefined ? { troopCostFood: upkeep } : {}),
    },
    troop: {}, fortification: forts, heros,
    buildings: [
      { typeId: 31, positionId: -1, level: 10, status: 0 },
      { typeId: 32, positionId: -2, level: 10, status: 0 },
      ...Array.from({ length: barracks }, (_, i) => ({ typeId: 2, positionId: 4 + i, level, status: 0 })),
    ],
  };
  const calls = [];
  let idle = pop.cur - pop.work;
  const production = { ...rates };
  const game = {
    castles: [castle, ...others],
    player: { playerInfo: { userName: 'T', prestige: 0, castleCount: 1 }, selfArmys: [], enemyArmys: enemy, items: [] },
    castle: () => castle,
    castleId: (c) => (c ? c.id : 1),
    castleXY: () => ({ x: 100, y: 100 }),
    now: () => Date.now(),
    req: async (cmd, data) => {
      if (cmd === 'troop.getProduceQueue') {
        return { ok: 1, allProduceQueue: Array.from({ length: barracks }, (_, i) => ({ positionId: 4 + i, allProduceQueue: queues[4 + i] || [] })) };
      }
      if (cmd === 'troop.getTroopProduceList') {
        // the server's own shape: permition beside a conditionBean whose
        // buildings say what is met (needs: typeId -> a Barracks level not met)
        return { ok: 1, troopList: Object.entries(times).map(([typeId, time]) => ({ typeId: Number(typeId), permition,
          conditionBean: { time, buildings: [{ typeId: 2, level: needs[typeId] || 1, successFlag: !needs[typeId] }] } })) };
      }
      if (cmd === 'fortifications.getProduceQueue') { calls.push([cmd]); return { ok: 1, allProduceQueue: [{ positionId: -2, allProduceQueue: wallQueue }] }; }
      if (cmd === 'fortifications.getFortificationsProduceList') {
        calls.push(['fortlist']);
        return { ok: 1, fortList: C.WALLS.map((w) => ({ typeId: w.typeId, permition: true, conditionBean: { food: 10, wood: 10, stone: 10, iron: 10, time: 60 } })) };
      }
      if (cmd === 'interior.getResourceProduceData') {
        calls.push([cmd]);
        if (refuse.read) return { ok: -1, errorMsg: 'no' };
        return { ok: 1, resourceProduceDataBean: Object.entries(production).map(([typeid, commenceRate]) => ({ typeid: Number(typeid), commenceRate, maxLabour: 5000 })) };
      }
      if (cmd === 'interior.modifyCommenceRate') {
        calls.push([cmd, data.foodrate, data.woodrate, data.stonerate, data.ironrate]);
        const restoring = data.foodrate !== 0 || data.woodrate !== 0;
        if (restoring && refuse.restore && refuse.restore-- > 0) return { ok: -1, errorMsg: 'busy' };
        Object.assign(production, { 1: data.foodrate, 2: data.woodrate, 3: data.stonerate, 4: data.ironrate });
        // at 0 every field worker is idle
        idle = restoring ? pop.cur - pop.work : pop.cur;
        castle.resource = { ...castle.resource, workPeople: restoring ? pop.work : 0 };
        return { ok: 1 };
      }
      return { ok: 1 };
    },
    promoteToChief: async (_cid, id) => { calls.push(['promote', id]); return { ok: 1 }; },
    dischargeChief: async () => ({ ok: 1 }),
    produceTroop: async (_cid, type, num, pos) => {
      calls.push(['train', type, num, pos]);
      const need = num * C.TROOPS.find((x) => x.typeId === type).pop;
      if (need > idle) return { ok: -1, errorMsg: `Insufficient idle population, ${need} required.` };
      idle -= need;
      return { ok: 1 };
    },
    produceWall: async (_cid, type, num) => { calls.push(['wall', type, num]); return { ok: 1 }; },
    cancelTroop: async (_cid, pos, queueId) => { calls.push(['cancel', pos, queueId]); return { ok: 1 }; },
  };
  const e = new Engine(game, () => {});
  e.dryRun = false;
  e.state = {};
  const goals = (src) => { e.goalsFor = (id) => (id === 1 ? parseGoals(src) : null); };
  const state = () => e.state['1'] || {};
  return { game, castle, calls, e, goals, state, production };
}
const trains = (calls) => calls.filter((c) => c[0] === 'train');

(async () => {
  // ============================================================ the settings
  console.log('\nsettings: the line\'s switch, then config, then NEAT\'s default\n');

  await t('defaults (wiki Troop): 30-minute batches, idle queue 0, increment 0, usereserved 0, usepopmax 0', async () => {
    const s = troopSettings({ switches: {} }, {});
    assert.deepStrictEqual(s, { slotSec: 1800, slotFrom: null, increment: 0, ratio: false, idleMin: 0,
      useReserved: 0, usePopMax: 0, reservedBarrack: false, delBadQue: false, trainerOnly: true });
  });

  await t('queue time: /queuetime (hours) > /slot (minutes) > config troopqueuetime (hours) > config troopslot (minutes)', async () => {
    assert.strictEqual(troopSettings({ switches: {} }, { troopqueuetime: 2 }).slotSec, 7200);
    assert.strictEqual(troopSettings({ switches: { queuetime: 0.5 } }, { troopqueuetime: 2 }).slotSec, 1800);
    assert.strictEqual(troopSettings({ switches: { slot: 45 } }, { troopqueuetime: 2 }).slotSec, 2700);
    assert.strictEqual(troopSettings({ switches: {} }, { troopslot: 60 }).slotSec, 3600);
    assert.strictEqual(troopSettings({ switches: {} }, { troopqueuetime: 1, troopslot: 60 }).slotSec, 3600);
    assert.strictEqual(troopSettings({ switches: {} }, { troopqueuetime: 0 }).slotSec, 0, '0 lifts the cap');
  });

  await t('ratio mode (troopincrement:1) turns the idle queue on at 1 minute; config or /idlequeuetime override it', async () => {
    assert.strictEqual(troopSettings({ switches: {} }, { troopincrement: 1 }).idleMin, 1);
    assert.strictEqual(troopSettings({ switches: {} }, { troopincrement: 1, troopidlequeuetime: 0 }).idleMin, 0);
    assert.strictEqual(troopSettings({ switches: { idlequeuetime: 5 } }, { troopincrement: 1, troopidlequeuetime: 0 }).idleMin, 5);
    assert.strictEqual(troopSettings({ switches: {} }, { troopincrement: 0.01 }).idleMin, 0, 'not in increment mode');
  });

  await t('each line switch overrides its config key for that line alone', async () => {
    const cfg = { troopsusereserved: 0.5, troopsusepopmax: 1, troopincrement: 500 };
    const own = troopSettings({ switches: { usereserved: 0, usepopmax: 0.25, increment: 0.1 } }, cfg);
    assert.deepStrictEqual([own.useReserved, own.usePopMax, own.increment], [0, 0.25, 0.1]);
    const plain = troopSettings({ switches: {} }, cfg);
    assert.deepStrictEqual([plain.useReserved, plain.usePopMax, plain.increment], [0.5, 1, 500]);
  });

  // ============================================================== parsing
  console.log('\nthe goal lines read the NEAT way, and bad values show red\n');

  await t('the Troop page\'s own examples read, switch values and all', async () => {
    const p = parseGoals('troop /increment:0.1 /queuetime:.5 b:5k,t:5k\ntroop /usereserved:0 /usepopmax:1 a:100k\ntroop /queuetime:.5 /usereserved:0 w:100\ntroop /idlequeuetime:5 p:1,sw:1,cav:1,w:1');
    assert.deepStrictEqual(p.errors, []);
    assert.deepStrictEqual(p.goals.map((g) => g.switches), [
      { increment: 0.1, queuetime: 0.5 }, { usereserved: 0, usepopmax: 1 }, { queuetime: 0.5, usereserved: 0 }, { idlequeuetime: 5 }]);
    assert.deepStrictEqual(p.goals[0].troops, { ballista: 5000, carriage: 5000 });
    assert.ok(p.lines.every((l) => l.status === 'ok'), JSON.stringify(p.lines));
  });

  await t('a switch value that cannot be read is an error and is left out (the line shows red)', async () => {
    for (const [src, re] of [
      ['troop /usepopmax:2 a:1', /usepopmax is a share from 0 to 1/],
      ['troop /usereserved:50% a:1', /usereserved is a share from 0 to 1/],
      ['troop /queuetime:30m a:1', /queuetime is hours as a plain number/],
      ['troop /idlequeuetime:soon a:1', /idlequeuetime is minutes as a plain number/],
      ['troop /increment:1.5 a:1', /increment is 0 \(off\), a share below 1/],
      ['troop /increment:abc a:1', /increment is 0 \(off\)/],
      ['troop /usepopmax a:1', /\/usepopmax needs a value/],
      ['troop /wibble:1 a:1', /unknown switch "\/wibble"/],
    ]) {
      const p = parseGoals(src);
      assert.strictEqual(p.errors.length, 1, src);
      has(p.errors[0].error, re);
      assert.strictEqual(p.lines[0].status, 'error', src);
      assert.deepStrictEqual(p.goals[0].troops, { archer: 1 }, 'the troops still read');
      assert.deepStrictEqual(Object.keys(p.goals[0].switches), [], 'the bad switch is not kept');
    }
  });

  await t('/queuetime and /slot together, or troopqueuetime and troopslot together, say which is used', async () => {
    has(parseGoals('troop /queuetime:1 /slot:30 a:1').errors[0].error, '/queuetime is used');
    has(parseGoals('config troopqueuetime:1,troopslot:30').errors[0].error, 'troopqueuetime is used');
  });

  await t('every troop and wall config key reads, with its value checked, and the line is blue', async () => {
    const p = parseGoals('config troopqueuetime:2,troopidlequeuetime:5,troopincrement:0.01,troopsusereserved:0.5,troopsusepopmax:1,reservedbarrack:1,troopdelbadque:1,fortification:0,fortsusereserved:0.5,wallqueuetime:.5');
    assert.deepStrictEqual(p.errors, []);
    assert.deepStrictEqual(p.config, { troopqueuetime: 2, troopidlequeuetime: 5, troopincrement: 0.01, troopsusereserved: 0.5,
      troopsusepopmax: 1, reservedbarrack: 1, troopdelbadque: 1, fortification: 0, fortsusereserved: 0.5, wallqueuetime: 0.5 });
    assert.deepStrictEqual(p.lines[0], { n: 1, status: 'ok', msg: null });
    assert.deepStrictEqual(parseGoals('config troopincrement:500,troopincrement:5k').config, { troopincrement: 5000 });
  });

  await t('a bad config value is an error, and the key keeps its default', async () => {
    for (const [pair, re] of [
      ['troopsusepopmax:5', /troopsusepopmax is a share from 0 to 1/], ['fortsusereserved:-1', /fortsusereserved is a share/],
      ['reservedbarrack:2', /reservedbarrack is 0 \(off\) or 1 \(on\)/], ['fortification:yes', /fortification is 0 \(off\) or 1/],
      ['troopdelbadque:on', /troopdelbadque is 0/], ['wallqueuetime:1h', /wallqueuetime is hours/],
      ['troopqueuetime:30m', /troopqueuetime is hours/], ['troopincrement:2.5', /troopincrement is 0 \(off\)/],
    ]) {
      const p = parseGoals(`config ${pair}`);
      has(p.errors[0].error, re);
      assert.deepStrictEqual(p.config, {}, pair);
      assert.strictEqual(p.lines[0].status, 'error', pair);
    }
  });

  await t('none of the troop or wall keys is on the "does nothing yet" list any more', async () => {
    for (const k of ['troopsusepopmax', 'troopsusereserved', 'troopqueuetime', 'troopidlequeuetime', 'reservedbarrack',
      'troopincrement', 'troopdelbadque', 'fortification', 'fortsusereserved', 'wallqueuetime']) {
      assert.ok(!(k in G.NOT_IMPLEMENTED.config), k);
      assert.ok(G.CONFIG_KEYS.has(k), k);
    }
  });

  await t('a troop or fortification line with nothing to build is an error, not a stage always met', async () => {
    has(parseGoals('troop /usepopmax:1').errors[0].error, 'needs at least one troopType:amount');
    has(parseGoals('fortification').errors[0].error, 'needs at least one type:quantity');
  });

  // ============================================================ increments
  console.log('\nTroopIncrement: left to right, in steps, or by ratio\n');

  await t('increment 0 (the default): each type in full before the next, filling the free slots', async () => {
    // 5 s warriors in 30-minute batches: 360 a batch; scouts 20 s: 90
    const plan = troopPlan(city({ src: 'troop w:500,s:500', bars: [bar(4, 3)] }));
    assert.deepStrictEqual(orders(plan), [['militia', 360, 4], ['militia', 140, 4], ['scouter', 90, 4]]);
  });

  await t('a share (0.01): 1% of each type in turn, round and round the line', async () => {
    const plan = troopPlan(city({ src: 'config troopincrement:0.01,troopslot:0\ntroop w:100k,s:100k,p:100k', bars: [bar(4, 5)] }));
    assert.deepStrictEqual(orders(plan).map(([k, v]) => [k, v]),
      [['militia', 1000], ['scouter', 1000], ['pikemen', 1000], ['militia', 1000], ['scouter', 1000]]);
    has(plan.note, '1% of each type in turn (increment)');
  });

  await t('a whole number (500): that many of each type in turn, until the line is met', async () => {
    const plan = troopPlan(city({ src: 'config troopslot:0\ntroop /increment:500 w:1000,s:600', bars: [bar(4, 5)] }));
    assert.deepStrictEqual(orders(plan).map(([k, v]) => [k, v]), [['militia', 500], ['scouter', 500], ['militia', 500], ['scouter', 100]]);
  });

  await t('a step still keeps to the queue time', async () => {
    const plan = troopPlan(city({ src: 'config troopincrement:0.01\ntroop w:100k,s:100k', bars: [bar(4, 2)] }));
    assert.deepStrictEqual(orders(plan).map(([k, v]) => [k, v]), [['militia', 360], ['scouter', 90]]);
  });

  await t('ratio mode, the wiki\'s example: w:2.5m,a:1m with 50k of each builds warriors to 125k first, then both', async () => {
    const plan = troopPlan(city({ src: 'config troopincrement:1,troopslot:0\ntroop w:2.5m,a:1m', troop: { militia: 50000, archer: 50000 }, bars: [bar(4, 3)] }));
    // 125k warriors is 5%, as the archers are; then a 1% step each, warriors first
    assert.deepStrictEqual(orders(plan).map(([k, v]) => [k, v]), [['militia', 75000], ['militia', 25000], ['archer', 10000]]);
    has(plan.note, 'ratio mode (troopincrement 1)');
  });

  await t('ratio mode rebuilds a lost type first: cavalry at 10% catches up to the 50% the others hold', async () => {
    const plan = troopPlan(city({ src: 'config troopincrement:1,troopslot:0\ntroop a:500k,s:400k,c:10k',
      troop: { archer: 250000, scouter: 200000, lightCavalry: 1000 }, bars: [bar(4, 1)] }));
    assert.deepStrictEqual(orders(plan).map(([k, v]) => [k, v]), [['lightCavalry', 4000]]);
  });

  // ============================================================ queue time
  console.log('\nTroopQueueTime: the batch length, alongside troopslot and /slot\n');

  await t('config troopqueuetime:2 makes 2-hour batches; /queuetime:.5 half an hour; 0 no cap', async () => {
    const one = (src) => troopPlan(city({ src, bars: [bar(4, 1)] })).orders[0].num;
    assert.strictEqual(one('troop a:100k'), 30);                                   // 1,800 / 60
    assert.strictEqual(one('config troopqueuetime:2\ntroop a:100k'), 120);
    assert.strictEqual(one('config troopqueuetime:2\ntroop /queuetime:.5 a:100k'), 30);
    assert.strictEqual(one('config troopslot:10\ntroop a:100k'), 10);
    assert.strictEqual(one('config troopqueuetime:0\ntroop a:100k'), 100000);
  });

  // ============================================================ food reserve
  console.log('\nTroopsUseReserved: a day of food stays for the troops\' upkeep\n');

  // 1,000,000 food, 10,000 an hour of upkeep: 240,000 is a day. An archer costs
  // 300 food and eats 9 an hour, so it keeps 216 more back.
  const fed = (src, extra = {}) => troopPlan(city({ src: `config troopslot:0\n${src}`, bars: [bar(4, 1)],
    bank: { food: 1e6, ...(extra.bank || {}) }, upkeep: 10000, ...extra }));

  await t('by default a day of upkeep is kept, the new troops\' own included', async () => {
    assert.strictEqual(fed('troop a:100k').orders[0].num, 1472);                 // 760,000 / 516
  });

  await t('/usereserved:0.5 keeps half a day; config troopsusereserved:1 keeps none', async () => {
    assert.strictEqual(fed('troop /usereserved:0.5 a:100k').orders[0].num, 2156); // 880,000 / 408
    assert.strictEqual(fed('config troopsusereserved:1\ntroop a:100k').orders[0].num, 3333);
    assert.strictEqual(fed('config troopsusereserved:1\ntroop /usereserved:0 a:100k').orders[0].num, 1472, 'the line wins');
  });

  await t('under a day of food nothing trains, and the note says why', async () => {
    const plan = fed('troop a:100k', { bank: { food: 200000 } });
    assert.deepStrictEqual(plan.orders, []);
    has(plan.note, "waiting on food (240,000 is kept for a day of the troops' upkeep)");
  });

  await t('the next construction\'s cost is kept on top of the day of food', async () => {
    const plan = fed('troop a:100k', { extra: { buildReserve: { food: 100000, label: 'upgrade Farm (pos 1001) L9->L10' } } });
    assert.strictEqual(plan.orders[0].num, 1279);                                  // 660,000 / 516
    has(plan.note, 'leaving 100k food in the bank for upgrade Farm');
  });

  await t('comfort keeps the troops\' day of food too (Step 13\'s comfort, through ctx.foodDay)', async () => {
    const w = world({ upkeep: 5000 });                                             // a day is 120,000 food
    w.game.player.playerInfo.prestige = 1e6;                                       // a prayer: 100,000 food
    w.castle.usePACIFY_SUCCOUR_OR_PACIFY_PRAY = 1;
    Object.assign(w.castle.resource, { food: { amount: 150000 }, support: 50, complaint: 0, texRate: 0 });
    w.goals('config hero:0');
    const r = await w.e.focus(w.castle);
    has(r.comfort.note, "praying needs 100,000 food (has 150,000, 120,000 of it kept for a day of the troops' upkeep)");
    assert.ok(!r.acted.some((a) => /^comfort: praying/.test(a)), r.acted.join(' | '));
    w.castle.resource.food = { amount: 300000 };
    const r2 = await w.e.focus(w.castle);
    assert.ok(r2.acted.some((a) => /^comfort: praying/.test(a)), r2.acted.join(' | '));
  });

  await t('upkeep: the server\'s troopCostFood, else the troops at home; the barracks queue adds its own', async () => {
    const queued = [bar(4, 10, [{ type: TY.archer, num: 1000 }])];
    assert.strictEqual(upkeepPerHour(city({ troop: { archer: 1000 }, bars: queued })), 18000);
    assert.strictEqual(upkeepPerHour(city({ troop: { archer: 1000 }, bars: queued, upkeep: 5000 })), 14000);
    assert.strictEqual(upkeepPerHour(city({})), 0);
  });

  // ============================================================ population
  console.log('\nTroopsUsePopMax: field workers freed for training\n');

  await t('by default only idle population trains', async () => {
    const plan = troopPlan(city({ src: 'config troopslot:0\ntroop a:100k', bars: [bar(4, 1)], pop: { cur: 20000, work: 15000 } }));
    assert.strictEqual(plan.orders[0].num, 2500);
    assert.strictEqual(plan.popmax, null);
  });

  await t('usepopmax:0.5 lets training take half the population, and says how many workers to free', async () => {
    const plan = troopPlan(city({ src: 'config troopslot:0,troopsusepopmax:0.5\ntroop a:100k', bars: [bar(4, 1)], pop: { cur: 20000, work: 15000 } }));
    assert.strictEqual(plan.orders[0].num, 5000);
    assert.deepStrictEqual(plan.popmax, { workers: 5000, share: 0.5 });
    has(plan.note, 'frees 5,000 workers from the fields for these (usepopmax 0.5)');
  });

  await t('/usepopmax:1 on the line beats config troopsusepopmax:0; builders are never taken', async () => {
    const plan = troopPlan(city({ src: 'config troopslot:0,troopsusepopmax:0\ntroop /usepopmax:1 a:100k', bars: [bar(4, 1)],
      pop: { cur: 20000, work: 15000, build: 1000 } }));
    assert.strictEqual(plan.orders[0].num, 9500);                                 // (20,000 - 1,000) / 2
    assert.deepStrictEqual(plan.popmax, { workers: 19000 - 4000, share: 1 });
  });

  await t('through the engine: production is read, set to 0, the batch goes, and the rates go back', async () => {
    const w = world({ pop: { cur: 20000, work: 15000 } });
    w.goals('config hero:0,troopsusepopmax:1,troopslot:0\ntroop a:10k');
    const r = await w.e.focus(w.castle);
    assert.deepStrictEqual(w.calls.filter((c) => c[0] !== 'fortifications.getProduceQueue'), [
      ['interior.getResourceProduceData'],
      ['interior.modifyCommenceRate', 0, 0, 0, 0],
      ['train', TY.archer, 10000, 4],
      ['interior.modifyCommenceRate', 80, 70, 60, 50],
    ]);
    assert.strictEqual(w.state().troopGoal.restore, undefined, 'nothing left to put back');
    assert.ok(r.acted.some((a) => /^lower production to free 15,000 workers .* -> ok$/.test(a)), r.acted.join(' | '));
    assert.ok(r.acted.some((a) => /^production back to food 80%, wood 70%, stone 60%, iron 50% -> ok$/.test(a)), r.acted.join(' | '));
  });

  await t('rates that cannot be read: production is left alone and the batch is cut to the idle population', async () => {
    const w = world({ pop: { cur: 20000, work: 15000 }, refuse: { read: true } });
    w.goals('config hero:0,troopsusepopmax:1,troopslot:0\ntroop a:10k');
    await w.e.focus(w.castle);
    assert.deepStrictEqual(w.calls.filter((c) => c[0] === 'interior.modifyCommenceRate'), []);
    assert.deepStrictEqual(trains(w.calls).map((c) => c[2]), [10000, 2500]);
  });

  await t('a refused put-back is kept, and the next slice puts production back first', async () => {
    const w = world({ pop: { cur: 20000, work: 15000 }, refuse: { restore: 1 } });
    w.goals('config hero:0,troopsusepopmax:1,troopslot:0\ntroop a:10k');
    await w.e.focus(w.castle);
    assert.deepStrictEqual(w.state().troopGoal.restore && [w.state().troopGoal.restore.food, w.state().troopGoal.restore.iron], [80, 50]);
    w.calls.length = 0;
    await w.e.focus(w.castle);
    assert.deepStrictEqual(w.calls[0], ['interior.modifyCommenceRate', 80, 70, 60, 50]);
    assert.strictEqual(w.state().troopGoal.restore, undefined);
  });

  await t('a dry run only says what it would do', async () => {
    const w = world({ pop: { cur: 20000, work: 15000 } });
    w.e.dryRun = true;
    w.goals('config hero:0,troopsusepopmax:1,troopslot:0\ntroop a:10k');
    const r = await w.e.focus(w.castle);
    assert.deepStrictEqual(w.calls.filter((c) => c[0] === 'interior.modifyCommenceRate' || c[0] === 'train'), []);
    assert.ok(r.acted.includes('[plan] lower production to free 15,000 workers for training (usepopmax 1), then put it back'), r.acted.join(' | '));
    assert.ok(r.acted.includes('[plan] train 10,000 Archer (~6d 22h)'), r.acted.join(' | '));
  });

  // ============================================================ reserved barracks
  console.log('\nReservedBarrack: one barracks kept free, for stage 1 under attack\n');

  const three = () => [bar(4, 10, [{ type: TY.archer, num: 1 }]), bar(5, 5), bar(6, 8)];

  await t('config reservedbarrack:1 keeps the highest empty barracks free', async () => {
    const plan = troopPlan(city({ src: 'config reservedbarrack:1\ntroop a:100k', bars: three() }));
    assert.ok(plan.orders.length && plan.orders.every((o) => o.positionId !== 6), JSON.stringify(orders(plan)));
    assert.strictEqual(plan.orders.length, 9 + 5);
    has(plan.note, 'the barracks on plot 6 is kept free (reservedbarrack)');
  });

  await t('under attack it trains the first line\'s shortfall', async () => {
    const plan = troopPlan(city({ src: 'config reservedbarrack:1\ntroop a:100k\ntroop s:100k', bars: three(),
      extra: { underAttack: { on: true, inbound: 1, key: 'id:1' } } }));
    assert.ok(plan.orders.some((o) => o.positionId === 6));
    has(plan.note, 'under attack: the reserved barracks (plot 6) trains stage 1 too');
  });

  await t('under attack with the first line met, it stays free', async () => {
    const plan = troopPlan(city({ src: 'config reservedbarrack:1\ntroop a:10\ntroop s:100k', troop: { archer: 10 }, bars: three(),
      extra: { underAttack: { on: true, inbound: 1, key: 'id:1' } } }));
    assert.strictEqual(plan.stageIndex, 2);
    assert.ok(plan.orders.every((o) => o.positionId !== 6));
    has(plan.note, 'kept free (reservedbarrack); under attack, but stage 1 is complete');
  });

  await t('through the engine: a real wave inbound opens the reserved barracks to stage 1; a junk one does not', async () => {
    const run = async (enemy) => {
      const w = world({ barracks: 2, enemy });
      w.goals('config hero:0,reservedbarrack:1\ntroop a:100k');
      await w.e.focus(w.castle);
      return [...new Set(trains(w.calls).map((c) => c[3]))].sort();
    };
    // two empty L10 barracks: the one on the lower plot, 4, is kept
    assert.deepStrictEqual(await run([]), [5], 'plot 4 is kept free');
    // a 6,000-archer wave landing in 10 minutes, and a 10-archer poke
    assert.deepStrictEqual(await run([{ armyId: 1, targetFieldId: HOME, direction: 1, reachTime: Date.now() + 600e3, troop: { archer: '6000' } }]), [4, 5]);
    assert.deepStrictEqual(await run([{ armyId: 1, targetFieldId: HOME, direction: 1, reachTime: Date.now() + 600e3, troop: { archer: '10' } }]), [5]);
  });

  await t('a city with one barracks keeps it free and trains nothing outside an attack', async () => {
    const plan = troopPlan(city({ src: 'config reservedbarrack:1\ntroop a:100k' }));
    assert.deepStrictEqual(plan.orders, []);
    has(plan.note, 'waiting on a free barracks queue slot');
    has(plan.note, 'the barracks on plot 4 is kept free');
  });

  // ============================================================ idle queue
  console.log('\nTroopIdleQueueTime: while the traininghero is away, with config trooptraineronly:0\n');

  const bob = { id: 1, name: 'Bob', power: 100, status: 1 };
  const otto = { id: 9, name: 'OTTO', power: 500, status: 0 };
  // Bob, the mayor here, trains ballista in 300 s and warriors in 5 s; OTTO
  // trained them here in 250 s and 5 s
  const away = ({ src = 'troop b:1000', config = {}, times = { 11: 250, 3: 5 }, bars = [bar(4, 10, [{ type: TY.archer, num: 1 }]), bar(5, 10), bar(6, 10)], heros = [bob], hero = otto,
    unit = { ...UNIT, 11: { time: 300, allowed: true } } } = {}) =>
    troopPlan(city({ src: `traininghero OTTO\n${src}`, config, heros, bars, unit,
      extra: { trainer: { name: 'OTTO', hero, present: false, times: times ? { at: Date.now(), unit: times } : null } } }));
  // NEAT's rule (wiki TroopIdleQueueTime) is what config trooptraineronly:0 asks for
  const neat = (o = {}) => away({ ...o, config: { trooptraineronly: 0, ...(o.config || {}) } });

  await t('with troopidlequeuetime 0 (the default) a type the hero here trains slower waits for the traininghero', async () => {
    const plan = neat({ src: 'troop b:1000,w:1000' });
    assert.ok(plan.orders.length && plan.orders.every((o) => o.troop.key === 'militia'), JSON.stringify(orders(plan)));
    has(plan.note, 'traininghero OTTO is away, waiting for it: Ballista (troopidlequeuetime 0)');
  });

  await t('a type the hero here trains as fast goes in full batches, anywhere', async () => {
    const plan = neat({ src: 'troop w:100k' });
    assert.strictEqual(plan.orders.length, Math.min(9 + 10 + 10, TROOP_ORDERS));
    assert.ok(plan.orders.every((o) => !o.idle && o.num === 360));
  });

  await t('troopidlequeuetime:5: small batches, only in idle barracks, no more than 5 minutes over the traininghero', async () => {
    const plan = neat({ config: { troopidlequeuetime: 5 } });
    // 300 s here, 250 s with OTTO: 6 ballista take 5 minutes longer
    assert.deepStrictEqual(orders(plan), [['ballista', 6, 5], ['ballista', 6, 6]]);
    assert.ok(plan.orders.every((o) => o.idle));
    has(plan.note, 'OTTO is away: 2 small batch(es) in idle barracks with Bob (troopidlequeuetime 5 min)');
  });

  await t('ratio mode queues idle batches of 1 minute over by default', async () => {
    const plan = neat({ config: { troopincrement: 1 } });
    assert.deepStrictEqual(orders(plan), [['ballista', 1, 5], ['ballista', 1, 6]]);
  });

  await t('the traininghero\'s speed here not known yet: a hero with its attack trains, a weaker one waits', async () => {
    has(neat({ times: null }).note, 'waiting for it: Ballista (its speed here is not known yet)');
    const strong = neat({ times: null, heros: [{ ...bob, power: 600 }] });
    assert.ok(strong.orders.length && strong.orders.every((o) => !o.idle));
  });

  await t('the traininghero at home, or in none of our cities: training as usual', async () => {
    const home = troopPlan(city({ src: 'troop b:1000', heros: [bob], unit: { ...UNIT, 11: { time: 300, allowed: true } },
      extra: { trainer: { name: 'OTTO', hero: otto, present: true, times: null } } }));
    assert.ok(home.orders.length && home.orders.every((o) => !o.idle));
    assert.ok(away({ hero: null }).orders.length, 'a name that is nowhere cannot be waited for');
    assert.ok(neat({ hero: null }).orders.length, 'the same under the NEAT rule');
  });

  await t('through the engine: the city remembers how fast each mayor trained, and the traininghero is known by it', async () => {
    const w = world({ heros: [{ ...otto, status: 1 }], times: { [TY.ballista]: 100 } });
    w.goals('config hero:0\ntraininghero OTTO\ntroop b:10');
    await w.e.focus(w.castle);
    assert.strictEqual(w.state().troopGoal.times.otto.unit[TY.ballista], 100);
    // OTTO leaves for another city; Bob, slower, is mayor here
    const other = { id: 2, name: 'Other', heros: [{ ...otto, status: 0 }] };
    w.game.castles.push(other);
    w.castle.heros = [bob];
    const tr = trainerOf(w.game, w.castle, parseGoals('traininghero OTTO').goals, w.state());
    assert.deepStrictEqual([tr.present, tr.hero.name, tr.times.unit[TY.ballista]], [false, 'OTTO', 100]);
  });

  // =================================================== the barracks are the trainer's
  console.log('\nOURS: with a traininghero named, only it fills the barracks (trooptraineronly)\n');

  await t('a type the hero here does not build instantly waits for the traininghero, however fast it is', async () => {
    // Bob trains warriors in 5 s, exactly as OTTO did here: NEAT would fill
    // every slot with them, and OTTO would come round to a full barracks
    const plan = away({ src: 'troop w:100k' });
    assert.deepStrictEqual(plan.orders, [], JSON.stringify(orders(plan)));
    has(plan.note, 'traininghero OTTO is away, waiting for it: Warrior (Bob does not build them instantly)');
  });

  await t('a type it DOES build instantly goes in, whole, and leaves the slot free', async () => {
    const unit = { ...UNIT, 3: { time: 0.5, allowed: true }, 11: { time: 300, allowed: true } };
    const plan = away({ src: 'troop w:100k', unit });
    assert.deepStrictEqual(orders(plan), [['militia', 100000, 5]], 'one batch of the lot, in the barracks with the most room');
  });

  await t('instant types go in while the slow ones wait: the slots are left for the traininghero', async () => {
    const unit = { ...UNIT, 3: { time: 0.5, allowed: true }, 11: { time: 300, allowed: true } };
    const plan = away({ src: 'troop b:1000,w:1000', unit });
    assert.deepStrictEqual(orders(plan), [['militia', 1000, 5]]);
    has(plan.note, 'waiting for it: Ballista (Bob does not build them instantly)');
  });

  await t('troopidlequeuetime does not open the barracks any more; /traineronly:0 does', async () => {
    assert.deepStrictEqual(away({ config: { troopidlequeuetime: 5 } }).orders, [], 'small idle batches are off');
    assert.deepStrictEqual(away({ config: { troopincrement: 1 } }).orders, [], 'ratio mode too');
    assert.ok(away({ src: 'troop /traineronly:0 b:1000' }).orders.length === 0, 'still slower than OTTO: waits');
    assert.ok(away({ src: 'troop /traineronly:0 w:100k' }).orders.length, 'as fast as OTTO: NEAT trains in full');
  });

  await t('a hero never mayor here and as strong as the traininghero is let through once, to be measured', async () => {
    const idleHero = (power) => [{ id: 1, name: 'Bob', power, status: 0 }];
    assert.ok(away({ heros: idleHero(600) }).orders.length, 'as much attack as OTTO: trains, and the read measures it');
    assert.deepStrictEqual(away({ heros: idleHero(100) }).orders, [], 'weaker: waits');
    // once it has been mayor here, what it actually took decides
    has(away({ heros: [{ id: 1, name: 'Bob', power: 600, status: 1 }] }).note, 'Bob does not build them instantly');
  });

  await t('no traininghero, or one at home: nothing changes', async () => {
    const plain = troopPlan(city({ src: 'troop b:1000', heros: [bob], unit: { ...UNIT, 11: { time: 300, allowed: true } } }));
    assert.ok(plain.orders.length, 'no traininghero line: any hero trains');
    assert.ok(away({ hero: otto, src: 'troop b:1000' }).orders.length === 0);
  });

  await t('the switch reads, and a line switch beats the config', async () => {
    assert.strictEqual(troopSettings({ switches: {} }, {}).trainerOnly, true, 'on by default');
    assert.strictEqual(troopSettings({ switches: {} }, { trooptraineronly: 0 }).trainerOnly, false);
    assert.strictEqual(troopSettings({ switches: { traineronly: 1 } }, { trooptraineronly: 0 }).trainerOnly, true);
    assert.strictEqual(troopSettings({ switches: { traineronly: 0 } }, {}).trainerOnly, false);
    const p = parseGoals('config trooptraineronly:0\ntroop /traineronly:1 a:1');
    assert.deepStrictEqual(p.errors, []);
    assert.deepStrictEqual([p.config.trooptraineronly, p.goals[0].switches], [0, { traineronly: 1 }]);
    has(parseGoals('troop /traineronly:2 a:1').errors[0].error, '/traineronly is 0 (off) or 1 (on)');
    has(parseGoals('config trooptraineronly:soon').errors[0].error, 'trooptraineronly is 0 (off) or 1 (on)');
  });

  // ============================================================ bad queues
  console.log('\nTroopDelBadQue: a batch queued far too slow is cancelled\n');

  const queue = () => [
    bar(4, 10, [
      { type: TY.ballista, num: 10, queueId: 1, costTime: 99999 },       // in training: never
      { type: TY.ballista, num: 10, queueId: 2, costTime: 12000 },       // 1,200 s each, 600 s now
      { type: TY.ballista, num: 10, queueId: 3, costTime: 6000 },        // right
    ]),
    bar(5, 10, [
      { type: TY.warrior, num: 10, queueId: 6, costTime: 50 },
      { type: TY.warrior, num: 1000, queueId: 7, costTime: 20000 },      // 20 s each, 5 s now
    ]),
  ];
  const badPlan = ({ config = { troopdelbadque: 1 }, heros = [bob], bars = queue(), memory = null } = {}) =>
    troopPlan(city({ src: 'troop b:100k,w:100k', config, heros, bars, extra: memory ? { troopMemory: memory } : {} }));

  await t('off by default', async () => {
    assert.strictEqual(badPlan({ config: {} }).cancel, null);
  });

  await t('the slowest waiting batch is cancelled, one a slice; the one in training never', async () => {
    const plan = badPlan();
    assert.deepStrictEqual([plan.cancel.positionId, plan.cancel.queueId, plan.cancel.type], [5, 7, TY.warrior]);
    has(plan.note, 'cancel a slow batch: 1,000 Warrior in the barracks on plot 5 (5h 33m queued, 1h 23m with Bob)');
  });

  await t('a type cancelled in the last hour is left alone, so the next worst goes', async () => {
    const plan = badPlan({ memory: { times: {}, badHold: { [TY.warrior]: Date.now() + 60e3 } } });
    assert.deepStrictEqual([plan.cancel.positionId, plan.cancel.queueId], [4, 2]);
  });

  await t('a little slow is not bad: the slack, and troopidlequeuetime, cover it (idle queues are never cancelled)', async () => {
    const small = [bar(4, 10, [{ type: TY.ballista, num: 1, queueId: 1, costTime: 600 }, { type: TY.ballista, num: 1, queueId: 2, costTime: 900 }])];
    assert.strictEqual(badPlan({ bars: small }).cancel, null, '1.5x, but only 5 minutes more');
    const idle = [bar(4, 10, [{ type: TY.ballista, num: 1, queueId: 1, costTime: 600 }, { type: TY.ballista, num: 2, queueId: 2, costTime: 1900 }])];
    assert.ok(badPlan({ bars: idle }).cancel, '700 s over');
    assert.strictEqual(badPlan({ bars: idle, config: { troopdelbadque: 1, troopidlequeuetime: 15 } }).cancel, null, 'within the idle queue\'s 15 minutes');
  });

  await t('only while the city\'s training hero is mayor: then a new batch is really faster', async () => {
    const plan = badPlan({ heros: [{ id: 1, name: 'Pol', power: 10, status: 1 }, { id: 2, name: 'Atk', power: 900, status: 0 }] });
    assert.strictEqual(plan.cancel, null);
    has(plan.note, 'troopdelbadque: slow batches are looked for while Atk is mayor');
  });

  await t('through the engine: the cancel goes before the batches, and the type is held for an hour', async () => {
    const w = world({ heros: [bob], times: { [TY.ballista]: 100 },
      queues: { 4: [{ type: TY.ballista, num: 10, queueId: 1, costTime: 1000 }, { type: TY.ballista, num: 10, queueId: 2, costTime: 9000 }] } });
    w.goals('config hero:0,troopdelbadque:1\ntroop b:1000');
    const r = await w.e.focus(w.castle);
    assert.deepStrictEqual(w.calls[0], ['cancel', 4, 2]);
    assert.ok(trains(w.calls).length > 0, 'the batches still go');
    assert.ok(w.state().troopGoal.badHold[TY.ballista] > Date.now() + 59 * 60e3);
    assert.ok(r.acted.some((a) => /^cancel a slow batch: 10 Ballista .* -> ok, queued again with the right hero next slice$/.test(a)), r.acted.join(' | '));
  });

  // ============================================================ the allowance
  console.log('\ntraining has its own allowance each slice\n');

  await t(`at most ${TROOP_ORDERS} batches a slice, and the note says more come next slice`, async () => {
    const plan = troopPlan(city({ src: 'troop w:1m', bars: [bar(4, 10), bar(5, 10), bar(6, 10)] }));
    assert.strictEqual(plan.orders.length, TROOP_ORDERS);
    has(plan.note, `${TROOP_ORDERS} batches a slice, more next slice`);
  });

  await t('troop batches are no longer held back by the three shared actions (wall batches still are)', async () => {
    const w = world({ barracks: 2 });
    w.e.maxActionsPerSlice = 0;
    w.goals('config hero:0\ntroop a:100k\nfortification ab:10');
    await w.e.focus(w.castle);
    assert.strictEqual(trains(w.calls).length, TROOP_ORDERS);
    assert.deepStrictEqual(w.calls.filter((c) => c[0] === 'wall'), []);
  });

  // ============================================================ fortifications
  console.log('\nfortifications: config fortification:0, WallQueueTime, FortsUseReserved\n');

  const walls = ({ src = 'fortification ab:5000', level = 10, queue = [], built = {}, costs, bank = {}, upkeep, extra = {} } = {}) => {
    const parsed = parseGoals(src);
    return {
      goals: parsed.goals, config: parsed.config, fortifications: built, walls: { level, queue },
      castle: { troop: {}, resource: { food: { amount: bank.food ?? BIG }, wood: { amount: bank.wood ?? BIG }, stone: { amount: BIG }, iron: { amount: BIG },
        ...(upkeep !== undefined ? { troopCostFood: upkeep } : {}) } },
      ...(costs ? { fortCosts: costs } : {}),
      ...extra,
    };
  };
  const ABATIS = { [WALL.abatis]: { food: 100, wood: 1200, stone: 0, iron: 150, time: 60 } };

  await t('config fortification:0 pauses wall building: no orders, no Walls for space, nothing read', async () => {
    const plan = fortPlan(walls({ src: 'config fortification:0\nfortification ab:5000', level: 3 }));
    assert.deepStrictEqual([plan.paused, plan.orders, plan.wallsFor], [true, [], 0]);
    has(plan.note, 'fortification building paused by config fortification:0');
    const w = world();
    w.goals('config hero:0,fortification:0\nfortification ab:10');
    await w.e.focus(w.castle);
    assert.deepStrictEqual(w.calls, [], 'the wall queue was read or a batch sent');
  });

  await t('config fortification:0 also stops the first Walls the fortification goal would build; a w: line still builds them', async () => {
    const castle = { buildings: [{ typeId: 31, positionId: -1, level: 10, status: 0 }] };     // no Walls
    const plan = (src) => { const p = parseGoals(src); return buildPlan({ goals: p.goals, config: p.config, castle }); };
    assert.deepStrictEqual(plan('fortification ab:10').ranked.map((a) => [a.kind, a.def.name]), [['new', 'Walls']]);
    assert.strictEqual(plan('config fortification:0\nfortification ab:10'), null);
    assert.deepStrictEqual(plan('config fortification:0\nfortification ab:10\nbuild w:1').ranked.map((a) => [a.kind, a.def.name]), [['new', 'Walls']]);
  });

  await t('wallqueuetime: 15-minute batches by default, the hours set, 0 no cap; with no time read the space decides', async () => {
    const one = (src, costs = ABATIS) => fortPlan(walls({ src, costs })).orders[0].num;
    assert.strictEqual(one('fortification ab:5000'), 15);                       // 900 s / 60 s
    assert.strictEqual(one('config wallqueuetime:1\nfortification ab:5000'), 60);
    assert.strictEqual(one('config wallqueuetime:0\nfortification ab:5000'), 5000);
    assert.strictEqual(one('fortification ab:5000', { [WALL.abatis]: { food: 1, wood: 1 } }), 5000);
    has(fortPlan(walls({ costs: ABATIS })).note, 'batches of 15m (the 15-minute default)');
  });

  await t('fortsusereserved: a day of the troops\' upkeep stays; 1 lets walls spend it', async () => {
    const plan = (src, bank) => fortPlan(walls({ src: `config wallqueuetime:0\n${src}`, costs: ABATIS, bank, upkeep: 1000 }));
    assert.strictEqual(plan('fortification ab:5000', { food: 100000 }).orders[0].num, 760);    // (100,000 - 24,000) / 100
    assert.strictEqual(plan('config fortsusereserved:0.5\nfortification ab:5000', { food: 100000 }).orders[0].num, 880);
    assert.strictEqual(plan('config fortsusereserved:1\nfortification ab:5000', { food: 100000 }).orders[0].num, 1000);
    const none = plan('fortification ab:5000', { food: 20000 });
    assert.deepStrictEqual(none.orders, []);
    has(none.note, "waiting on food (24,000 is kept for a day of the troops' upkeep)");
  });

  await t('through the engine: the fortification list is read for wall batches, once in ten minutes', async () => {
    const w = world({ forts: { abatis: 100 } });
    w.goals('config hero:0\nfortification ab:5000');
    await w.e.focus(w.castle);
    await w.e.focus(w.castle);
    assert.strictEqual(w.calls.filter((c) => c[0] === 'fortlist').length, 1);
    // 60 s an abatis here: 15 of them to a 15-minute batch
    assert.deepStrictEqual(w.calls.filter((c) => c[0] === 'wall'), [['wall', WALL.abatis, 15], ['wall', WALL.abatis, 15]]);
  });

  await t('costs not read: the client\'s table stands in for the day of food; with a construction waiting, nothing goes', async () => {
    const plan = fortPlan(walls({ src: 'config wallqueuetime:0\nfortification ab:5000', bank: { food: 100000 }, upkeep: 1000 }));
    assert.strictEqual(plan.orders[0].num, 760);                                  // abatis: 100 food
    const kept = fortPlan(walls({ bank: { food: 100000 }, upkeep: 1000, extra: { buildReserve: { wood: 5000, label: 'x' } } }));
    assert.deepStrictEqual(kept.orders, []);
    has(kept.note, 'waiting on the fortification costs (unread), with 5,000 wood kept for x');
  });

  // ============================================================ the emergency
  console.log('\nFortificationGoal: 1 of each on the first line, under attack\n');

  const attack = (key = 'id:5') => ({ underAttack: { on: true, inbound: 1, key } });

  await t('under attack: 1 of each on the first line, first, met or not; the ladder gets what is left', async () => {
    const plan = fortPlan(walls({ src: 'fortification tra:10,ab:10\nfortification ab:5000', built: { trap: 10, abatis: 10 },
      level: 3, queue: [{ type: WALL.abatis, num: 5 }], costs: ABATIS, extra: attack() }));
    assert.deepStrictEqual(plan.emergency.map((o) => [o.wall.name, o.num, o.key]), [['Trap', 1, 'id:5'], ['Abatis', 1, 'id:5']]);
    assert.deepStrictEqual(plan.orders, [], 'the last free slot went to the emergency');
    has(plan.note, 'under attack: 1 of each on the first fortification line, first — Trap, Abatis now');
    has(plan.note, 'waiting on a free wall queue slot (3 at Walls L3)');
  });

  await t('once an attack: what is done is not asked again; a new attack asks again', async () => {
    const src = 'fortification tra:1,ab:1';
    const done = { key: 'id:5', done: [WALL.trap, WALL.abatis] };
    const same = fortPlan(walls({ src, built: { trap: 1, abatis: 1 }, extra: { ...attack(), fortEmergency: done } }));
    assert.deepStrictEqual([same.done, same.emergency], [true, []]);
    has(same.note, '— done for this attack');
    const next = fortPlan(walls({ src, built: { trap: 1, abatis: 1 }, extra: { ...attack('id:6'), fortEmergency: done } }));
    assert.strictEqual(next.emergency.length, 2);
  });

  await t('the emergency needs a wall queue slot and the space; without, it says so and waits', async () => {
    const full = fortPlan(walls({ src: 'fortification tra:1', level: 1, queue: [{ type: WALL.abatis, num: 1 }], extra: attack() }));
    assert.deepStrictEqual(full.emergency, []);
    has(full.note, 'not yet: Trap (no free wall queue slot)');
    const cramped = fortPlan(walls({ src: 'fortification tre:1', level: 1, built: { abatis: 499 }, extra: attack() }));
    has(cramped.note, 'not yet: Rock Fall (no fortified space)');
  });

  await t('no emergency while nothing real is inbound, or with fortification:0', async () => {
    assert.deepStrictEqual(fortPlan(walls({ src: 'fortification tra:1', extra: { underAttack: { on: true, inbound: 0, key: null } } })).emergency, []);
    assert.deepStrictEqual(fortPlan(walls({ src: 'config fortification:0\nfortification tra:1', extra: attack() })).emergency, []);
  });

  // an inbound wave: 6,000 archers landing in 10 minutes
  const wave = (troops = '6000', armyId = 77) => ({ armyId, targetFieldId: HOME, startFieldId: 1, direction: 1, missionType: 1,
    reachTime: Date.now() + 600e3, startPosName: 'Foe', troop: { archer: troops } });

  await t('through the engine: an inbound attack gets 1 trap and 1 abatis ahead of everything else, once', async () => {
    const w = world({ forts: { trap: 1, abatis: 1 }, enemy: [wave()] });
    w.goals('config hero:0,troopslot:0\nfortification tra:1,ab:1\ntroop a:10');
    const r = await w.e.focus(w.castle);
    const sent = w.calls.filter((c) => c[0] === 'wall' || c[0] === 'train');
    assert.deepStrictEqual(sent, [['wall', WALL.trap, 1], ['wall', WALL.abatis, 1], ['train', TY.archer, 10, 4]]);
    assert.ok(r.acted.includes('emergency: build 1 Trap (under attack) -> ok'), r.acted.join(' | '));
    w.calls.length = 0;
    await w.e.focus(w.castle);
    assert.deepStrictEqual(w.calls.filter((c) => c[0] === 'wall'), [], 'the same attack asked again');
  });

  await t('through the engine: a junk wave (under defensepolicy /junktroop) is no attack', async () => {
    const w = world({ forts: { trap: 1 }, enemy: [wave('10')] });
    w.goals('config hero:0\nfortification tra:1');
    await w.e.focus(w.castle);
    assert.deepStrictEqual(w.calls, [], 'the walls were read or built for a junk wave');
  });

  // ============================================================ the live lines
  console.log('\nthe live goals (accounts a1 and a2)\n');

  const LORD22 = `// Lord22 build-up
config comfort:1,hero:1,troopsusepopmax:1
comfortpolicy 15 16 popraise
defensepolicy /usetruce:79 /usespeech:2 /junktroop:5000 /usewarhorn:1 /usecorselet:1 /usepenicillin:1
build f:10:37,s:0:0,i:0:0,q:0:0
// troop ladder: ballista+transports first, then a broad base, then archers/scouts
troop b:5k,t:5k
troop wo:10k,w:10k,s:10k,p:10k,sw:10k,a:10k,t:10k,c:10k,cata:10k,b:10k
troop a:100k,s:100k

fortification ab:5000
`;

  await t('Lord22\'s goals read clean, and every goal line is blue now (troopsusepopmax works)', async () => {
    const p = parseGoals(LORD22);
    assert.deepStrictEqual(p.errors, []);
    assert.ok(p.lines.every((l) => ['ok', 'comment', 'blank'].includes(l.status)), JSON.stringify(p.lines.filter((l) => l.status !== 'ok')));
    const s = troopSettings(p.goals.find((g) => g.name === 'troop'), p.config);
    assert.deepStrictEqual([s.slotSec, s.increment, s.idleMin, s.useReserved, s.usePopMax], [1800, 0, 0, 0, 1]);
  });

  // the live pattern: 2,503 idle of 17,503, a L10 barracks, a 742 s ballista
  const live = (troop, bars = [bar(4, 10)]) => troopPlan(city({ src: LORD22, troop, bars, pop: { cur: 17503, work: 15000 },
    unit: { ...UNIT, 11: { time: 742, allowed: true }, 8: { time: 250, allowed: true } } }));

  await t('troop b:5k,t:5k: ballista first, filling the barracks, the transporters after', async () => {
    const plan = live({ ballista: 4702, carriage: 1000 });
    assert.strictEqual(plan.stageIndex, 1);
    assert.deepStrictEqual(orders(plan).slice(0, 2), [['ballista', 2, 4], ['ballista', 2, 4]]);
    assert.strictEqual(plan.orders.length, 10);
    assert.ok(plan.orders.every((o) => o.troop.key === 'ballista'));
  });

  await t('troop wo:10k,...: workers first; past the 2,503 idle, troopsusepopmax:1 frees field workers', async () => {
    const plan = live({ ballista: 5000, carriage: 5000 });
    assert.strictEqual(plan.stageIndex, 2);
    // 10 s workers: 180 a batch, ten batches = 1,800 people, within the idle
    assert.deepStrictEqual(orders(plan).map(([k, v]) => [k, v]), Array(10).fill(['peasants', 180]));
    assert.strictEqual(plan.popmax, null);
    const bigger = live({ ballista: 5000, carriage: 5000 }, [bar(4, 10), bar(5, 10)]);
    assert.deepStrictEqual(bigger.popmax, { workers: 20 * 180 - 2503, share: 1 });
  });

  await t('troop a:100k,s:100k: the archers fill the barracks before any scout', async () => {
    const all10 = { peasants: 10000, militia: 10000, scouter: 10000, pikemen: 10000, swordsmen: 10000, archer: 10000,
      carriage: 10000, lightCavalry: 10000, heavyCavalry: 10000, ballista: 10000 };
    const plan = live(all10);
    assert.strictEqual(plan.stageIndex, 3);
    assert.ok(plan.orders.every((o) => o.troop.key === 'archer' && o.num === 30), JSON.stringify(orders(plan)));
  });

  await t('fortification ab:5000: 15-minute batches of abatis once the costs and times are read', async () => {
    const p = parseGoals(LORD22);
    const plan = fortPlan({ goals: p.goals, config: p.config, fortifications: { abatis: 1418 }, walls: { level: 10, queue: [] },
      castle: { troop: {}, resource: { food: { amount: BIG }, wood: { amount: BIG }, stone: { amount: BIG }, iron: { amount: BIG } } },
      fortCosts: ABATIS });
    assert.deepStrictEqual(plan.orders.map((o) => [o.wall.name, o.num]), [['Abatis', 15]]);
  });

  // ============================================ found live, 2026-09-19
  console.log('\nfound live on Lord02, 2026-09-19: nothing trained on any account\n');

  await t('the server sends permition false for every type: the conditionBean decides, as the Enlist button does', async () => {
    const w = world({ permition: false });
    w.goals('config hero:0\ntroop a:1000');
    const r = await w.e.focus(w.castle);
    assert.ok(trains(w.calls).length > 0, r.troop.note);
    assert.ok(!/not trainable/.test(r.troop.note), r.troop.note);
  });

  await t('a type whose conditionBean has a building not met waits, and the note names it', async () => {
    const w = world({ permition: false, needs: { [TY.ballista]: 9 } });
    w.goals('config hero:0\ntroop b:100,a:100');
    const r = await w.e.focus(w.castle);
    has(r.troop.note, 'not trainable here yet: Ballista (needs Barracks 9)');
    assert.ok(trains(w.calls).length && trains(w.calls).every((c) => c[1] === TY.archer), JSON.stringify(trains(w.calls)));
  });

  await t('default 30-minute batches: an L10 barracks training one batch takes 9 more of 30 minutes each', async () => {
    const plan = troopPlan(city({ src: 'troop a:100k', bars: [bar(4, 10, [{ type: TY.archer, num: 500 }])] }));
    assert.deepStrictEqual(orders(plan), Array.from({ length: 9 }, () => ['archer', 30, 4]));
    assert.ok(plan.orders.every((o) => o.secs === 1800));
  });

  await t('an insta hero (under a second a troop) takes the whole population in ONE batch, not 30 minutes of them', async () => {
    const unit = { ...UNIT, [TY.archer]: { time: 0.62, allowed: true } };
    const plan = troopPlan(city({ src: 'troop a:100k', unit, pop: { cur: 1e6 } }));
    assert.deepStrictEqual(orders(plan), [['archer', 100000, 4]]);
    // population is the limit then, not the clock
    const small = troopPlan(city({ src: 'troop a:100k', unit, pop: { cur: 40000 } }));
    assert.deepStrictEqual(orders(small), [['archer', 40000 / C.BY_KEY.archer.pop, 4]]);
  });

  await t('instant batches leave their slot free: the slow type after them still fills all 10', async () => {
    const unit = { ...UNIT, [TY.archer]: { time: 0.5, allowed: true }, [TY.cav]: { time: 0.9, allowed: true } };
    const plan = troopPlan(city({ src: 'troop a:8000,c:9000,cata:20000', unit }));
    const o = orders(plan);
    assert.deepStrictEqual(o.slice(0, 2), [['archer', 8000, 4], ['lightCavalry', 9000, 4]]);
    assert.deepStrictEqual(o.slice(2), Array.from({ length: 10 }, () => ['heavyCavalry', 6, 4]), JSON.stringify(o));
  });

  await t('a troop at exactly 1 s is not instant: 1,800 a batch', async () => {
    const unit = { ...UNIT, [TY.archer]: { time: 1, allowed: true } };
    const plan = troopPlan(city({ src: 'troop a:5000', unit }));
    assert.deepStrictEqual(orders(plan).map((o) => o[1]), [1800, 1800, 1400]);
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows can hold the db file open */ }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
