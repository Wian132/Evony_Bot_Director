'use strict';
// Regression test for the bug that made npcteams, camp cooldowns and comfort
// timers all silently useless: focus() used to END with
//     this.state[key] = { lastFocus, troopStage }
// which REPLACED the per-city state object, throwing away everything the plans
// and executors had just written into it during the same slice.
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Point db.js at a throwaway file BEFORE requiring anything that opens it —
// otherwise this test writes a TestCity row into the live evony.db.
const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evony-test-')), 'test.db');
process.env.EVONY_DB = TMP;

const { Engine, troopPlan, cityMarches, fitFromError } = require('./engine');
const C = require('./constants');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok    ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
}

// A Game stub: one city, no network. Enough for focus() to run end to end.
function stubGame() {
  const castle = {
    id: 1, name: 'TestCity', fieldId: 100 * 800 + 100,
    resource: { food: { amount: 1e9 }, wood: { amount: 1e9 }, stone: { amount: 1e9 },
                iron: { amount: 1e9 }, gold: 1e9, curPopulation: 5000, maxPopulation: 10000 },
    troop: {}, fortification: {}, heros: [], buildings: [],
  };
  return {
    castles: [castle],
    player: { playerInfo: { userName: 'T' }, selfArmys: [], enemyArmys: [], items: [] },
    castle: () => castle,
    castleId: () => 1,
    castleXY: () => ({ x: 100, y: 100 }),
    now: () => Date.now(),
    req: async () => ({ ok: 1 }),
  };
}

(async () => {
  console.log('\nengine per-city state survives a focus slice\n');

  await t('focus() merges into the city state instead of replacing it', async () => {
    const g = stubGame();
    const e = new Engine(g, () => {});
    e.dryRun = true;
    e.state = {};
    // Pretend an earlier slice recorded npc runs and a comfort timestamp.
    e.state.TestCity = {
      npc: { runs: [{ fieldId: 5 }], hits: { 5: 1 }, cycles: { 5: { startedAt: 1 } } },
      lastComfort: 12345,
    };
    const before = e.state.TestCity;
    e.goalsFor = () => ({ goals: [], config: {} });

    await e.focus(g.castle());

    const after = e.state.TestCity;
    assert.strictEqual(after, before, 'the state object was replaced, not merged');
    assert.ok(after.npc, 'npc bookkeeping was discarded');
    assert.strictEqual(after.npc.runs.length, 1, 'npc.runs was discarded — npcteams would never count');
    assert.strictEqual(after.npc.hits[5], 1, 'npc.hits was discarded — camps would be re-hit every tick');
    assert.strictEqual(after.lastComfort, 12345, 'comfort timer was discarded — popraise would fire every tick');
    assert.ok(after.lastFocus > 0, 'lastFocus was not written');
  });

  await t('a city with no prior state still gets lastFocus and troopStage', async () => {
    const g = stubGame();
    const e = new Engine(g, () => {});
    e.dryRun = true;
    e.state = {};
    e.goalsFor = () => ({ goals: [], config: {} });
    await e.focus(g.castle());
    assert.ok(e.state.TestCity, 'no state row was created');
    assert.ok(e.state.TestCity.lastFocus > 0, 'lastFocus missing');
  });

  // ---------------------------------------------------------------- troopPlan
  console.log('\ntroopPlan shares one resource budget across orders\n');

  // Two troop types that both cost wood. Sizing each against the full untouched
  // pool means the first order drains the bank and the second is rejected
  // outright ("Insufficient resources. Required Lumber 139300") rather than
  // being trimmed to what is left.
  function ctxWith(woodAmount, want) {
    return {
      goals: [{ name: 'troop', troops: want || { militia: 10000, scouter: 10000 }, switches: {} }],
      config: {},
      castle: {
        troop: {},
        resource: {
          food: { amount: 1e12 }, wood: { amount: woodAmount },
          stone: { amount: 1e12 }, iron: { amount: 1e12 },
          curPopulation: 1e6, maxPopulation: 1e6, workPeople: 0, buildPeople: 0,
        },
      },
    };
  }

  await t('orders together never exceed the wood actually on hand', async () => {
    const woodOnHand = 100000;
    const plan = troopPlan(ctxWith(woodOnHand));
    assert.ok(plan && plan.orders && plan.orders.length, 'no orders produced');
    let spent = 0;
    for (const o of plan.orders) spent += o.num * (o.troop.cost.wood || 0);
    assert.ok(spent <= woodOnHand,
      `orders want ${spent} wood but only ${woodOnHand} is banked — the later order would be refused`);
  });

  await t('a lone order is still sized to the full pool', async () => {
    const plan = troopPlan(ctxWith(1e12, { militia: 500 }));
    const m = plan.orders.find((o) => o.troop.key === 'militia');
    assert.ok(m && m.num === 500, 'with plenty of everything the deficit should be filled exactly');
  });

  // ------------------------------------------------------------ fitFromError
  console.log('\norders are resized from the server own refusal\n');

  await t('fortified space: works out how many actually fit', async () => {
    // 3000 wanted, 2000 space free, 4000 more needed -> 6000 total -> a third fits
    assert.strictEqual(fitFromError(3000, 'Remaining fortified space is 2000, 4000 more is needed.', {}), 1000);
  });

  await t('no space at all means none fit', async () => {
    assert.strictEqual(fitFromError(3000, 'Remaining fortified space is 0, 6000 more is needed.', {}), 0);
  });

  await t('insufficient lumber scales to the wood on hand', async () => {
    const res = { wood: { amount: 69650 } };          // exactly half of 139300
    assert.strictEqual(fitFromError(1393, 'Insufficient resources. Required Lumber 139300.', res), 696);
  });

  await t('a refusal that is not about quantity is left alone', async () => {
    assert.strictEqual(fitFromError(100, 'Status of this hero is not Idle.', {}), null);
  });

  await t('insufficient idle population scales to the idle population', async () => {
    // 4,916 ballista need 24,580; 2,503 idle is enough for 500 of them
    const res = { curPopulation: 20000, workPeople: 15000, buildPeople: 2497 };
    assert.strictEqual(fitFromError(4916, 'Insufficient idle population, 24580 required.', res), 500);
  });

  // ------------------------------------------------------- troop batch sizing
  console.log('\ntroop batches: idle population, the queue, and time slots\n');

  const BALLISTA = 11, TRANSPORTER = 8;
  // The live city this was written against: a L10 barracks, 2,503 idle, and a
  // weak mayor at 742s per ballista (4,916 of them showed 42 days).
  function city({ goals, config = {}, troop = {}, items = [], barracks, unit, idle = 2503, error } = {}) {
    return {
      goals: (goals || [{ troops: { ballista: 5000 } }]).map((s) => ({ name: 'troop', switches: {}, ...s })),
      config,
      castle: {
        troop,
        resource: {
          food: { amount: 1e12 }, wood: { amount: 1e12 }, stone: { amount: 1e12 }, iron: { amount: 1e12 },
          curPopulation: 15000 + idle, maxPopulation: 60000, workPeople: 15000, buildPeople: 0,
        },
      },
      training: {
        barracks: barracks || [{ positionId: 4, capacity: 10, items }],
        unit: unit || { [BALLISTA]: { time: 742, allowed: true }, [TRANSPORTER]: { time: 250, allowed: true } },
        error,
      },
    };
  }

  await t('troopsusepopmax no longer orders past the idle population', async () => {
    const ctx = city({ config: { troopsusepopmax: 1, troopslot: 0 }, troop: { ballista: 84 } });
    const plan = troopPlan(ctx);
    assert.strictEqual(plan.orders.length, 1);
    assert.strictEqual(plan.orders[0].num, 500, 'sized against max population, the server refuses it whole');
  });

  await t('troops already in the queue count toward the target', async () => {
    const items = [
      { type: BALLISTA, num: 4916 }, { type: BALLISTA, num: 4916 },
      { type: TRANSPORTER, num: 5000 }, { type: TRANSPORTER, num: 5000 },
    ];
    const plan = troopPlan(city({ goals: [{ troops: { ballista: 5000, carriage: 5000 } }], troop: { ballista: 84 }, items }));
    assert.ok(plan.done, 'the queue already covers the stage, yet more was ordered');
    assert.match(plan.note, /19,832 in the barracks queue/);
  });

  await t('a covered stage lets the next one use the free slots', async () => {
    const items = [{ type: BALLISTA, num: 4916 }];
    const plan = troopPlan(city({
      goals: [{ troops: { ballista: 5000 } }, { troops: { carriage: 1000 } }],
      troop: { ballista: 84 }, items,
    }));
    assert.strictEqual(plan.stageIndex, 2);
    assert.strictEqual(plan.orders[0].troop.key, 'carriage');
  });

  // Lord02: b:5k,t:5k with 6,352 ballista owned, 1,650 of them out farming.
  // Counting only the 4,702 at home held the ladder on stage 1 for good.
  const HOME = 100 * 800 + 100, CAMP = 120 * 800 + 100;
  function marchingCity(selfArmies) {
    const ctx = city({
      goals: [{ troops: { ballista: 5000, carriage: 5000 } }, { troops: { ballista: 10000 } }],
      troop: { ballista: 4702, carriage: 10858 },
    });
    ctx.castle.fieldId = HOME;
    ctx.selfArmies = selfArmies;
    return ctx;
  }

  await t('troops out on a march from this city count toward the stage', async () => {
    // the engine's own list: the ArmyBean under raw, troop counts as strings
    const plan = troopPlan(marchingCity([
      { startFieldId: HOME, targetFieldId: CAMP, raw: { startFieldId: HOME, targetFieldId: CAMP, troop: { ballista: '1650', carriage: '114' } } },
    ]));
    assert.strictEqual(plan.stageIndex, 2, 'the farmed-out ballista were not counted');
    assert.strictEqual(plan.missing.ballista, 10000 - 4702 - 1650);
    assert.match(plan.note, /1,764 out on marches/);
  });

  await t('a bare ArmyBean list (the console) counts the same', async () => {
    const plan = troopPlan(marchingCity([{ startFieldId: HOME, targetFieldId: CAMP, troop: { ballista: 1650 } }]));
    assert.strictEqual(plan.stageIndex, 2);
  });

  await t('a march that left from another city is not counted here', async () => {
    const plan = troopPlan(marchingCity([{ startFieldId: CAMP, targetFieldId: HOME, troop: { ballista: 1650 } }]));
    assert.strictEqual(plan.stageIndex, 1);
    assert.strictEqual(plan.missing.ballista, 298);
  });

  // Lord02's Flat: 12,657 transporters bringing resources in read as Flat's
  // own, and the panel showed its t:5k goal met with none in the city.
  await t('a transport aimed here is not counted: its transporters go home', async () => {
    const plan = troopPlan(marchingCity([{ startFieldId: CAMP, targetFieldId: HOME, missionType: C.MISSION.transport,
      direction: 1, troop: { ballista: 1650 } }]));
    assert.strictEqual(plan.missing.ballista, 298);
  });

  await t('a reinforcement on its way in counts toward the stage', async () => {
    const plan = troopPlan(marchingCity([{ startFieldId: CAMP, targetFieldId: HOME, missionType: C.MISSION.reinforce,
      direction: 1, troop: { ballista: '1650' } }]));
    assert.strictEqual(plan.stageIndex, 2);
    assert.strictEqual(plan.missing.ballista, 10000 - 4702 - 1650);
    assert.match(plan.note, /1,650 reinforcing on the way in/);
  });

  await t('a reinforcement turned back to where it came from is not inward', async () => {
    const back ={ startFieldId: CAMP, targetFieldId: HOME, missionType: C.MISSION.reinforce, direction: 2, troop: { ballista: 1650 } };
    assert.deepStrictEqual(cityMarches(HOME, [back]), { outward: {}, inward: {} });
    assert.deepStrictEqual(cityMarches(CAMP, [back]).outward, { ballista: 1650 }, 'still its home city\'s');
  });

  await t('by default a batch is sized to train in about 30 minutes', async () => {
    const plan = troopPlan(city());
    // 1,800s / 742s per ballista = 2, although population allows 500
    assert.strictEqual(plan.orders[0].num, 2);
    assert.ok(plan.orders[0].secs <= 30 * 60, `batch takes ${plan.orders[0].secs}s`);
  });

  await t('the note maps out how long the shortfall takes at the current speed', async () => {
    const plan = troopPlan(city({ troop: { ballista: 84 } }));
    assert.match(plan.note, /ballista 4,916 \(~42d 5h\)/);    // 4,916 x 742s
  });

  await t('config troopslot sets the batch length, /slot overrides it per stage', async () => {
    assert.strictEqual(troopPlan(city({ config: { troopslot: 60 } })).orders[0].num, 4);        // 3,600 / 742
    assert.strictEqual(troopPlan(city({ config: { troopslot: 60 }, goals: [{ troops: { ballista: 5000 }, switches: { slot: 120 } }] })).orders[0].num, 9);
  });

  await t('troopslot:0 lifts the time cap', async () => {
    assert.strictEqual(troopPlan(city({ config: { troopslot: 0 } })).orders[0].num, 500);
  });

  await t('instant training (a strong enough mayor) is only held back by population', async () => {
    const plan = troopPlan(city({ unit: { [BALLISTA]: { time: 0, allowed: true } } }));
    assert.strictEqual(plan.orders[0].num, 500);
  });

  await t('a troop slower than the whole slot still trains one at a time', async () => {
    const plan = troopPlan(city({ unit: { [BALLISTA]: { time: 4000, allowed: true } } }));
    assert.strictEqual(plan.orders[0].num, 1);
  });

  await t('full barracks queues order nothing and say so', async () => {
    const items = Array.from({ length: 10 }, () => ({ type: TRANSPORTER, num: 1 }));
    const plan = troopPlan(city({ items }));
    assert.strictEqual(plan.orders.length, 0);
    assert.match(plan.note, /waiting on a free barracks queue slot/);
  });

  await t('each batch goes to the barracks with the most room', async () => {
    const plan = troopPlan(city({
      goals: [{ troops: { ballista: 5000, carriage: 5000 } }],
      barracks: [
        { positionId: 4, capacity: 10, items: Array.from({ length: 9 }, () => ({ type: TRANSPORTER, num: 1 })) },
        { positionId: 7, capacity: 5, items: [] },
      ],
    }));
    assert.deepStrictEqual(plan.orders.map((o) => o.positionId), [7, 7]);
  });

  await t('a troop the barracks cannot train yet is skipped, not ordered', async () => {
    const plan = troopPlan(city({
      goals: [{ troops: { catapult: 100, ballista: 5000 } }],
    }));
    assert.deepStrictEqual(plan.orders.map((o) => o.troop.key), ['ballista']);
    assert.match(plan.note, /not trainable here yet: Catapult/);
  });

  await t('no idle population says what it is waiting on', async () => {
    const plan = troopPlan(city({ idle: 3 }));
    assert.strictEqual(plan.orders.length, 0);
    assert.match(plan.note, /waiting on idle population \(3\)/);
  });

  await t('troopslot parses as minutes, and "30m" is refused rather than read as 30 million', async () => {
    const { parseGoals } = require('./goals');
    const ok = parseGoals('config troopslot:45');
    assert.strictEqual(ok.config.troopslot, 45);
    assert.strictEqual(ok.errors.length, 0);
    const bad = parseGoals('config troopslot:30m');
    assert.strictEqual(bad.config.troopslot, undefined);
    assert.match(bad.errors[0].error, /troopslot is minutes/);
  });

  await t('an unreadable barracks orders nothing rather than guess', async () => {
    const plan = troopPlan(city({ error: 'barracks queue unreadable (no reply)' }));
    assert.strictEqual(plan.orders.length, 0);
    assert.match(plan.note, /not training: barracks queue unreadable/);
  });

  // ------------------------------------------------- troop orders, end to end
  console.log('\ntroop orders through the engine\n');

  // A city whose server knows better than its snapshot: the plan sees 45,000
  // idle, the server has 2,503 and says so — and pushes the fresh resource.
  function troopGame({ unitTime = 0, mayorTime = null, heros = [] } = {}) {
    let serverIdle = 2503, time = unitTime;
    const castle = {
      id: 1, name: 'TrainCity', fieldId: 100 * 800 + 100,
      resource: {
        food: { amount: 1e12 }, wood: { amount: 1e12 }, stone: { amount: 1e12 }, iron: { amount: 1e12 },
        curPopulation: 60000, maxPopulation: 60000, workPeople: 15000, buildPeople: 0,
      },
      troop: {}, fortification: {}, heros, buildings: [{ typeId: 2, positionId: 4, level: 10 }],
    };
    const sent = [], reads = [];
    const game = {
      castles: [castle],
      player: { playerInfo: { userName: 'T' }, selfArmys: [], enemyArmys: [], items: [] },
      castle: () => castle,
      castleId: () => 1,
      castleXY: () => ({ x: 100, y: 100 }),
      now: () => Date.now(),
      req: async (cmd) => {
        reads.push(cmd);
        if (cmd === 'troop.getProduceQueue') return { ok: 1, allProduceQueue: [{ positionId: 4, allProduceQueue: [] }] };
        if (cmd === 'troop.getTroopProduceList') {
          return { ok: 1, troopList: [{ typeId: BALLISTA, permition: true, conditionBean: { time } }] };
        }
        return { ok: 1 };
      },
      dischargeChief: async () => ({ ok: 1 }),
      promoteToChief: async () => { if (mayorTime !== null) time = mayorTime; return { ok: 1 }; },
      produceTroop: async (_cid, type, num, pos) => {
        sent.push({ type, num, pos });
        if (num * 5 > serverIdle) {
          castle.resource = { ...castle.resource, curPopulation: 15000 + serverIdle };
          return { ok: -1, errorMsg: `Insufficient idle population, ${num * 5} required.` };
        }
        serverIdle -= num * 5;
        return { ok: 1 };
      },
    };
    return { game, castle, sent, reads };
  }

  await t('a refused batch is resent at what the population allows', async () => {
    const { game, castle, sent } = troopGame();
    const e = new Engine(game, () => {});
    e.dryRun = false;
    e.state = {};
    e.goalsFor = () => ({ goals: [{ name: 'troop', troops: { ballista: 5000 }, switches: {} }], config: { hero: 0 } });
    const r = await e.focus(castle);
    assert.deepStrictEqual(sent.map((s) => s.num), [5000, 500]);
    assert.ok(sent.every((s) => s.pos === 4), 'sent to the wrong barracks');
    assert.ok(r.acted.some((a) => /train 500 Ballista .*-> ok/.test(a)), r.acted.join(' | '));
  });

  await t('a new mayor re-reads the training speed before the batch is sized', async () => {
    const heros = [
      { id: 1, name: 'Pol', power: 50, management: 400, status: 1 },
      { id: 2, name: 'Atk', power: 900, management: 20, status: 0 },
    ];
    // 742s per ballista under the old mayor, 100s under the attack hero
    const { game, castle, sent, reads } = troopGame({ unitTime: 742, mayorTime: 100, heros });
    const e = new Engine(game, () => {});
    e.dryRun = false;
    e.state = {};
    e.goalsFor = () => ({ goals: [{ name: 'troop', troops: { ballista: 5000 }, switches: {} }], config: {} });
    await e.focus(castle);
    assert.strictEqual(reads.filter((c) => c === 'troop.getTroopProduceList').length, 2);
    assert.deepStrictEqual(sent.map((s) => s.num), [18], 'batch sized for the old mayor');   // 1,800 / 100
  });

  await t('training times are cached, but not across a mayor changed elsewhere', async () => {
    const heros = [{ id: 2, name: 'Atk', power: 900, management: 20, status: 1 }];
    const { game, castle, reads } = troopGame({ unitTime: 100, heros });
    const e = new Engine(game, () => {});
    const lists = () => reads.filter((c) => c === 'troop.getTroopProduceList').length;
    await e.readTraining(castle);
    await e.readTraining(castle);
    assert.strictEqual(lists(), 1, 'the per-unit times were re-read inside the cache window');
    heros.push({ id: 3, name: 'Other', power: 10, management: 10, status: 1 });
    heros[0].status = 0;                                   // swapped in-game, not by the engine
    await e.readTraining(castle);
    assert.strictEqual(lists(), 2, 'a different mayor kept the old times');
  });

  // ------------------------------------------------------------------ buildPlan
  console.log('\nbuild goals: open plots, one builder, upgrades when full\n');

  const { buildPlan, buildLabel, buildOutlook, fortPlan } = require('./engine');
  const { Game } = require('./game');
  const { parseGoals } = require('./goals');
  const goalsOf = (src) => parseGoals(src).goals;

  // Town Hall and Walls, then a field filled from plot 1001: farms, then sawmills.
  function field({ th = 10, walls = 3, farms = 0, farmLevel = 9, sawmills = 0, extra = [] } = {}) {
    const b = [
      { typeId: 31, name: 'Town Hall', positionId: -1, level: th, status: 0 },
      { typeId: 32, name: 'Walls', positionId: -2, level: walls, status: 0 },
    ];
    let p = 1001;
    for (let i = 0; i < farms; i++) b.push({ typeId: 7, name: 'Farm', positionId: p++, level: farmLevel, status: 0 });
    for (let i = 0; i < sawmills; i++) b.push({ typeId: 4, name: 'Sawmill', positionId: p++, level: 10, status: 0 });
    return { buildings: [...b, ...extra] };
  }

  await t('a full field upgrades instead of proposing farms it has no plot for', async () => {
    const plan = buildPlan({ goals: goalsOf('build f:10:37'), castle: field({ farms: 30, sawmills: 10 }) });
    assert.ok(!plan.actions.some((a) => a.kind === 'new'), 'proposed a new building with no plot open');
    assert.strictEqual(plan.actions.length, 30);
    assert.ok(plan.actions.every((a) => a.kind === 'upgrade' && a.def.name === 'Farm'));
    assert.match(plan.note, /no free field plot for 7 more Farm \(all 40 in use\)/);
  });

  await t('the Town Hall decides how many field plots are open', async () => {
    const castle = field({ th: 5, farms: 25 });          // 13 + 4 x 3 = 25 open
    const plan = buildPlan({ goals: goalsOf('build f:10:37'), castle });
    assert.ok(!plan.actions.some((a) => a.kind === 'new'), 'aimed a farm at a plot the Town Hall has not opened');
    assert.match(plan.note, /Town Hall L5 opens 25 of 40/);
    const g = new Game();
    assert.strictEqual(g.freeSlot(castle, true), null, 'plot 1026 opens at Town Hall L6');
    assert.deepStrictEqual(g.freeSlots(castle).outside, { free: 0, total: 25, used: 25 });
  });

  await t('new buildings go on open plots, one plot each', async () => {
    const plan = buildPlan({ goals: goalsOf('build f:10:37'), castle: field({ farms: 35, farmLevel: 10 }) });
    assert.deepStrictEqual(plan.actions.map((a) => [a.kind, a.positionId]), [['new', 1036], ['new', 1037]]);
  });

  await t('all 32 city plots count, 0 to 31', async () => {
    const extra = Array.from({ length: 31 }, (_, i) => ({ typeId: 1, name: 'Cottage', positionId: i, level: 10, status: 0 }));
    const plan = buildPlan({ goals: goalsOf('build c:10:33'), castle: field({ extra }) });
    assert.deepStrictEqual(plan.actions.map((a) => [a.kind, a.positionId]), [['new', 31]]);
    assert.match(plan.note, /no free city plot for 1 more Cottage \(all 32 in use\)/);
  });

  await t('nothing is proposed while the builder is busy, and the note says why', async () => {
    const castle = field({ farms: 30, sawmills: 10 });
    Object.assign(castle.buildings.find((b) => b.positionId === 1005), { status: 1, endTime: Date.now() + 23 * 60e3 + 30e3 });
    const plan = buildPlan({ goals: goalsOf('build f:10:37'), castle });
    assert.strictEqual(plan.actions.length, 0);
    assert.match(plan.note, /builder busy: building Farm \(pos 1005\) L9->L10, 23m left; next: upgrade Farm \(pos \d+\) L9->L10/);
    assert.ok(!/pos 1005\) L10->/.test(plan.note), 'named the farm already on its way to L10 as next');
  });

  await t('a finished demolition frees its plot', async () => {
    // pushed back as status 0, level 0 once it is down
    const castle = field({ farms: 39, farmLevel: 10, extra: [{ typeId: 4, name: 'Sawmill', positionId: 1040, level: 0, status: 0 }] });
    const plan = buildPlan({ goals: goalsOf('build f:10:40,s:0:0'), castle });
    assert.deepStrictEqual(plan.actions.map((a) => [a.kind, a.def.name, a.positionId]), [['new', 'Farm', 1040]]);
  });

  // castle.destructBuilding takes ONE level (DestrctChoiceWin.as, "拆除一级"),
  // so a sawmill coming down from L10 is back at L9 when the order ends.
  await t('a demolition takes one level: the same building comes down again next', async () => {
    const castle = field({ farms: 30, farmLevel: 10, extra: [
      { typeId: 4, name: 'Sawmill', positionId: 1031, level: 10, status: 2, endTime: Date.now() + 60e3 },
      { typeId: 4, name: 'Sawmill', positionId: 1032, level: 10, status: 0 },
    ] });
    const plan = buildPlan({ goals: goalsOf('build s:0:0'), castle });
    assert.strictEqual(plan.actions.length, 0, 'sent an order to a busy builder');
    assert.match(plan.note, /builder busy: demolishing Sawmill \(pos 1031\) L10->L9.*next: demolish Sawmill \(pos 1031\) L9->L8/);
  });

  await t('the last level of a demolition opens its plot for what comes next', async () => {
    const castle = field({ farms: 39, farmLevel: 10, extra: [
      { typeId: 4, name: 'Sawmill', positionId: 1040, level: 1, status: 2, endTime: Date.now() + 60e3 },
    ] });
    const plan = buildPlan({ goals: goalsOf('build f:10:40,s:0:0'), castle });
    assert.deepStrictEqual(plan.ranked.map((a) => [a.kind, a.def.name, a.positionId]), [['new', 'Farm', 1040]]);
    assert.match(plan.note, /demolishing Sawmill \(pos 1040\) L1->L0.*next: new Farm \(pos 1040\)/);
  });

  // Lord02's goals as written on 2026-09-13: keep one of each, farms on the rest.
  await t('spare sawmills, iron mines and quarries come down first, the weakest first', async () => {
    const mk = (typeId, name, positionId, level) => ({ typeId, name, positionId, level, status: 0 });
    const castle = field({ farms: 30, farmLevel: 10, extra: [
      mk(4, 'Sawmill', 1031, 10), mk(4, 'Sawmill', 1032, 7), mk(4, 'Sawmill', 1033, 9),
      mk(6, 'Ironmine', 1034, 10), mk(6, 'Ironmine', 1035, 10),
      mk(5, 'Quarry', 1036, 10), mk(5, 'Quarry', 1037, 3),
      mk(7, 'Farm', 1038, 4),
    ] });
    const plan = buildPlan({ goals: goalsOf('build s:0:1,i:0:1,q:0:1,f:0:37\nbuild f:10:37'), castle });
    assert.deepStrictEqual(plan.actions.filter((a) => a.kind === 'demolish').map((a) => a.positionId),
      [1032, 1033, 1034, 1037], 'wrong spares, or the strongest was not the one kept');
    assert.strictEqual(buildLabel(plan.actions[0]), 'demolish Sawmill (pos 1032) L7->L6');
    const firstOther = plan.actions.findIndex((a) => a.kind !== 'demolish');
    assert.strictEqual(firstOther, 4, 'something else was ranked ahead of a demolition');
    assert.strictEqual(plan.actions[firstOther].kind, 'new');
  });

  await t('the console\'s next build skips what the engine has backed off', async () => {
    const castle = field({ farms: 30, sawmills: 10 });
    const goals = goalsOf('build f:10:37');
    const clear = buildOutlook({ castle, goals });
    assert.match(clear.next, /^upgrade Farm \(pos 1001\) L9->L10/);
    assert.strictEqual(clear.wait, null);
    const cityState = { failures: { 'build:upgrade:7:1001': { n: 2, until: Date.now() + 600e3, msg: 'Insufficient resources' } } };
    const held = buildOutlook({ castle, goals, cityState });
    assert.match(held.next, /^upgrade Farm \(pos 1002\)/);
    assert.strictEqual(held.held.length, 1);
    assert.match(held.held[0], /pos 1001.*Insufficient resources/);
    Object.assign(castle.buildings.find((b) => b.positionId === 1005), { status: 1, endTime: Date.now() + 60e3 });
    assert.strictEqual(buildOutlook({ castle, goals }).wait, 'once the builder is free');
    assert.match(buildOutlook({ castle, goals: goalsOf('troop b:1') }).idle, /no build goals/);
    assert.match(buildOutlook({ castle: field({ farms: 37, farmLevel: 10 }), goals }).idle, /all build targets met/);
  });

  await t('the Walls a fortification goal needs go ahead of the farm upgrades', async () => {
    const plan = buildPlan({ goals: goalsOf('build f:10:37,w:5'), castle: field({ farms: 30, sawmills: 10 }) }, 4);
    assert.strictEqual(plan.actions[0].def.name, 'Walls');
    assert.strictEqual(plan.actions[0].why, 'fortified space');
    assert.strictEqual(plan.actions.filter((a) => a.def.name === 'Walls').length, 1, 'the Walls were queued twice');
  });

  await t('the Town Hall and the Walls are never built new or torn down', async () => {
    const plan = buildPlan({ goals: goalsOf('build th:0:0,w:0:2'), castle: field() });
    assert.strictEqual(plan.actions.length, 0);
  });

  // ------------------------------------------------------------------ fortPlan
  console.log('\nfortifications: the wall queue and fortified space\n');

  const walled = ({ goal = 'fortification ab:5000', level = 3, built = {}, queue = [] } = {}) => ({
    goals: goalsOf(goal), fortifications: built, walls: { level, queue },
  });

  await t('fortifications in the wall queue count toward the target', async () => {
    const plan = fortPlan(walled({ level: 10, built: { abatis: 1418 }, queue: [{ type: 15, num: 3582 }] }));
    assert.ok(plan.done, 'the queue already covers the goal, yet more was ordered');
    assert.match(plan.note, /3,582 in the wall queue/);
  });

  await t('an order is sized to the space left, and the Walls level for the goal is named', async () => {
    // Walls L3 hold 6,000. 2,000 abatis stand (4,000), so 1,000 more fit.
    const plan = fortPlan(walled({ built: { abatis: 2000 } }));
    assert.deepStrictEqual(plan.orders.map((o) => [o.wall.name, o.num]), [['Abatis', 1000]]);
    assert.strictEqual(plan.wallsFor, 4);                   // 5,000 abatis take 10,000
    assert.match(plan.note, /space 4,000\/6,000 at Walls L3; the stage needs 10,000 space: Walls L4/);
  });

  await t('full walls order nothing and wait on the space', async () => {
    const plan = fortPlan(walled({ built: { abatis: 2000 }, queue: [{ type: 15, num: 1000 }] }));
    assert.strictEqual(plan.orders.length, 0);
    assert.strictEqual(plan.wallsFor, 4);
    assert.match(plan.note, /waiting on fortified space/);
  });

  await t('a full wall queue orders nothing', async () => {
    const plan = fortPlan(walled({ queue: [1, 2, 3].map(() => ({ type: 14, num: 1 })) }));
    assert.strictEqual(plan.orders.length, 0);
    assert.match(plan.note, /waiting on a free wall queue slot \(3 at Walls L3\)/);
  });

  await t('a goal bigger than Walls L10 hold fills them and says so', async () => {
    const plan = fortPlan(walled({ goal: 'fortification ab:30000', level: 10 }));
    assert.strictEqual(plan.orders[0].num, 27500);          // 55,000 / 2
    assert.strictEqual(plan.wallsFor, 0, 'asked for Walls above L10');
    assert.match(plan.note, /more than Walls L10 hold/);
  });

  // ------------------------------------------------- construction, end to end
  console.log('\nconstruction through the engine\n');

  // Lord02's city "7": all 40 field plots taken, and Walls L3 full of abatis.
  function buildGame({ refuse = {} } = {}) {
    const castle = {
      id: 1, name: '7', fieldId: 100 * 800 + 100,
      resource: { food: { amount: 1e12 }, wood: { amount: 1e12 }, stone: { amount: 1e12 }, iron: { amount: 1e12 },
                  curPopulation: 1000, maxPopulation: 1000, workPeople: 0, buildPeople: 0 },
      troop: {}, fortification: { abatis: 2000 }, heros: [],
      ...field({ farms: 30, sawmills: 10 }),
    };
    const sent = [];
    const reply = (pos) => (refuse[pos] ? { ok: -1, errorMsg: refuse[pos] } : { ok: 1 });
    const game = {
      castles: [castle],
      player: { playerInfo: { userName: 'T' }, selfArmys: [], enemyArmys: [], items: [] },
      castle: () => castle,
      castleId: () => 1,
      castleXY: () => ({ x: 100, y: 100 }),
      now: () => Date.now(),
      req: async (cmd) => (cmd === 'fortifications.getProduceQueue'
        ? { ok: 1, allProduceQueue: [{ positionId: -2, allProduceQueue: [{ type: 15, num: 1000 }] }] }
        : { ok: 1 }),
      upgradeBuilding: async (_cid, pos) => { sent.push(['upgrade', pos]); return reply(pos); },
      newBuilding: async (_cid, pos, type) => { sent.push(['new', pos, type]); return reply(pos); },
      destructBuilding: async (_cid, pos) => { sent.push(['demolish', pos]); return reply(pos); },
      produceWall: async (_cid, type, num) => { sent.push(['wall', type, num]); return { ok: 1 }; },
    };
    const e = new Engine(game, () => {});
    e.dryRun = false;
    e.state = {};
    e.goalsFor = () => parseGoals('config hero:0\nbuild f:10:37\nfortification ab:5000');
    return { e, castle, sent };
  }

  await t('a full city with full walls sends one Walls upgrade and nothing doomed', async () => {
    const { e, castle, sent } = buildGame();
    const r = await e.focus(castle);
    assert.deepStrictEqual(sent, [['upgrade', -2]]);
    assert.ok(r.acted.every((a) => !/skipped|no free/.test(a)), r.acted.join(' | '));
    assert.match(r.build.note, /no free field plot for 7 more Farm/);
    assert.match(r.fort.note, /1,000 in the wall queue/);
  });

  await t('backed-off candidates cost nothing: the next one is still built', async () => {
    const { e, castle, sent } = buildGame();
    const hold = (msg) => ({ n: 3, until: Date.now() + 3600e3, msg });
    // Three held back: under the old engine these three skips used up the
    // whole slice and nothing was ever built.
    e.state['7'] = { failures: {
      'build:upgrade:32:-2': hold('Town Hall level too low'),
      'build:upgrade:7:1001': hold('Insufficient resources'),
      'build:upgrade:7:1002': hold('Insufficient resources'),
    } };
    const r = await e.focus(castle);
    assert.deepStrictEqual(sent, [['upgrade', 1003]]);
    assert.ok(r.acted.every((a) => !/skipped|Walls/.test(a)), 'a held-back candidate reached the activity log');
    assert.match(r.build.note, /held back: upgrade Walls \(pos -2\) L3->L4 for fortified space, Town Hall level too low/);
  });

  await t('"one building at a time" holds the builder, not the building', async () => {
    const { e, castle, sent } = buildGame({ refuse: { [-2]: 'One building allowed to be built at a time.' } });
    await e.focus(castle);
    assert.strictEqual(sent.length, 1);
    assert.ok(!(e.state['7'].failures || {})['build:upgrade:32:-2'], 'the Walls were backed off for the builder being busy');
    const r = await e.focus(castle);
    assert.strictEqual(sent.length, 1, 'asked the busy builder again straight away');
    assert.match(r.build.note, /the server says the builder is busy, asking again in \d+m/);
  });

  await t('one construction a slice, even when it is refused', async () => {
    const { e, castle, sent } = buildGame({ refuse: { [-2]: 'Insufficient resources. Required Lumber 139300.' } });
    await e.focus(castle);
    assert.deepStrictEqual(sent, [['upgrade', -2]]);
    assert.ok(e.state['7'].failures['build:upgrade:32:-2'], 'the refusal was not backed off');
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
