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

const { Engine, troopPlan, fitFromError } = require('./engine');

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
  console.log('\nwall orders are resized from the server own refusal\n');

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

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
