'use strict';
// requestresources / requesttroops (goal-transfer.js) and the rally slots every
// goal march shares (rally.js). No network; the database is a throwaway file.
//
//   node test-transfer.js
const assert = require('assert');
const path = require('path'), os = require('os'), fs = require('fs');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-transfer-')), 't.db');

const C = require('./constants');
const R = require('./rally');
const T = require('./goal-transfer');
const { parseGoals, describe } = require('./goals');
const { Engine } = require('./engine');
const { Game } = require('./game');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok    ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
}
const has = (s, sub) => assert.ok(String(s).includes(sub), `"${s}" does not contain "${sub}"`);

// ------------------------------------------------------------------ fixtures
// Lord02's cities, where they really are. Fla sits two tiles from 5 and
// ninety from 9 — the case the old "most to spare wins" rule got wrong.
let nextId = 1;
function city(name, x, y, { food = 0, wood = 0, stone = 0, iron = 0, gold = 0, troop = {}, rally = 10, ...over } = {}) {
  return {
    castleId: nextId++, name, fieldId: C.coordsToFieldId(x, y),
    resource: { food: { amount: food }, wood: { amount: wood }, stone: { amount: stone }, iron: { amount: iron }, gold },
    troop: { carriage: 20000, ...troop },
    buildings: rally === null ? [] : [{ typeId: 29, level: rally, positionId: 5 }],
    heros: [], fortification: {}, ...over,
  };
}

// Listed farthest first, so "the first city that qualifies" is never the
// nearest by accident.
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

// A march of ours, as ArmyBean has it. direction 1 out, 2 back.
const march = (from, to, missionType, extra = {}) => ({
  startFieldId: from.fieldId, targetFieldId: to.fieldId, missionType, direction: 1,
  startTime: Date.now() - 60000, troop: {}, resource: {}, ...extra,
});

// Everyone shares one goal file unless a city is given its own, as Lord02's
// cities share "default".
const LORD02 = `requestresources any wood 100000 2000000 500000 200000
requestresources any stone 5000000 50000000 5000000 10000000
requestresources any iron 50000000 500000000 20000000 100000000
requestresources any food 500000000 5000000000 50000000 1000000000`;

function plan(here, castles, src, { selfArmys = [], own = {}, book = null } = {}) {
  const game = fakeGame(castles, selfArmys);
  const parsed = parseGoals(src);
  assert.deepStrictEqual(parsed.errors, [], 'the goals should parse');
  const goalsOf = (c) => (own[c.name] !== undefined ? parseGoals(own[c.name]).goals : parsed.goals);
  const ctx = { castle: here, goals: parsed.goals, config: parsed.config, goalsOf, selfArmies: selfArmys };
  if (book) ctx.rally = book(game, goalsOf);
  return { plan: T.plans.transfer(ctx, {}, game), game };
}
const food = (a) => a.resources.food;

(async () => {
  // ================================================================= parsing
  console.log('\nparsing\n');

  await t('the saved Lord02 lines read exactly as before', () => {
    const p = parseGoals(LORD02);
    assert.deepStrictEqual(p.errors, []);
    const f = p.goals.find((g) => g.type === 'food');
    assert.deepStrictEqual([f.target, f.amounts, f.slots], ['any', [500e6, 5e9, 50e6, 1e9], 1]);
  });

  await t('* for any amount, /slots, the t flag, and NEAT city lists', () => {
    const p = parseGoals('requestresources !HubCity|484,619 food * 1b * 100m t /slots:3');
    assert.deepStrictEqual(p.errors, []);
    const g = p.goals[0];
    assert.deepStrictEqual([g.target, g.amounts, g.flag, g.slots], ['!HubCity|484,619', [null, 1e9, null, 100e6], 't', 3]);
    has(describe(p).join('\n'), 'food from !HubCity|484,619 when under *, up to 1,000,000,000, * per send, senders keep 100,000,000, 3 missions at a time');
  });

  await t('mistakes are reported, not guessed at', () => {
    assert.match(parseGoals('requestresources any food 1m 2m').errors[0].error, /4 needed/);
    assert.match(parseGoals('requestresources any food 1m 2m 1m 1m cavalry').errors[0].error, /only transports/);
    assert.match(parseGoals('requestresources any rubies 1m 2m 1m 1m').errors[0].error, /unknown resource/);
    assert.match(parseGoals('requestresources any food 1m 2m lots 1m').errors[0].error, /not an amount/);
    assert.match(parseGoals('requesttroops any dragons 1k 2k 1k 1k').errors[0].error, /unknown troop/);
  });

  await t('requesttroops takes NEAT troop names and codes', () => {
    const p = parseGoals(['archer', 'scouts', 'cavalry', 'b', 't', 'pikemen', 'Catapults']
      .map((x) => `requesttroops any ${x} 1k 2k 1k 1k`).join('\n'));
    assert.deepStrictEqual(p.errors, []);
    assert.deepStrictEqual(p.goals.map((g) => g.troop), ['archer', 'scouter', 'lightCavalry', 'ballista', 'carriage', 'pikemen', 'catapult']);
  });

  await t('rallypolicy is a core goal with the NEAT spelling', () => {
    const p = parseGoals('rallypolicy n:10:1 n:8 m:1 r:2 t:1 max:8');
    assert.deepStrictEqual(p.errors, []);
    assert.deepStrictEqual([p.goals[0].caps, p.goals[0].levels, p.goals[0].max], [{ n: 8, m: 1, r: 2, t: 1 }, { 10: 1 }, 8]);
    assert.match(parseGoals('rallypolicy x:3').errors[0].error, /unknown rally type/);
    assert.match(parseGoals('rallypolicy r:two').errors[0].error, /whole number/);
  });

  // ========================================================= who sends it
  console.log('\nrequestresources: who sends\n');

  await t('the nearest city that can send it all sends it, not the one with the most', () => {
    const f = fleet();
    const { plan: p } = plan(f.fla, Object.values(f), LORD02);
    const a = p.actions.find((x) => food(x));
    assert.strictEqual(a.from.name, '5', `sent from ${a.from.name}`);
    assert.strictEqual(food(a), 50e6);
    has(p.note, 'food 100m < 500m: 50m from 5 (2.2 tiles)');
  });

  await t('a nearer city that can send only part loses to one that can send it all', () => {
    const f = fleet({ five: { food: 1.02e9 } });      // 20m over its 1b keep
    const { plan: p } = plan(f.fla, Object.values(f), LORD02);
    assert.strictEqual(p.actions.find((x) => food(x)).from.name, '8');
  });

  await t('when nobody can send it all, whoever can send the most does', () => {
    const f = fleet({ five: { food: 1.02e9 }, eight: { food: 1.03e9 }, nine: { food: 1.01e9 } });
    const { plan: p } = plan(f.fla, Object.values(f), LORD02);
    const a = p.actions.find((x) => food(x));
    assert.deepStrictEqual([a.from.name, food(a)], ['8', 30e6]);
    has(p.note, 'all it can spare');
  });

  await t('every line one city serves rides in one march', () => {
    const f = fleet();
    const { plan: p } = plan(f.fla, Object.values(f), LORD02);
    assert.strictEqual(p.actions.length, 1, p.actions.map((x) => x.label).join(' / '));
    const a = p.actions[0];
    assert.deepStrictEqual(a.resources, { wood: 500e3, stone: 5e6, food: 50e6 });
    assert.strictEqual(a.carriages, Math.ceil(55.5e6 / 5000));
    assert.deepStrictEqual([a.rally.kind, a.rally.pairLimit, a.rally.from.name], ['r', 1, '5']);
  });

  // ===================================================== what is on its way
  console.log('\nrequestresources: what is already coming\n');

  await t('a transport on its way in counts; one heading home does not', () => {
    const f = fleet();
    const going = march(f.nine, f.fla, C.MISSION.transport, { resource: { food: 450e6 } });
    let p = plan(f.fla, Object.values(f), 'requestresources any food 500m 5b 50m 1b', { selfArmys: [going] }).plan;
    assert.strictEqual(p.actions.length, 0);
    has(p.note, 'nothing short');

    // ArmyBean still lists the load on the way back, but it has been delivered
    const back = { ...going, direction: 2 };
    p = plan(f.fla, Object.values(f), 'requestresources any food 500m 5b 50m 1b', { selfArmys: [back] }).plan;
    assert.strictEqual(p.actions.length, 1);
  });

  await t('market purchases in transit count too', () => {
    const f = fleet({ fla: { transingTrades: [{ resType: 0, amount: 450e6 }] } });
    const p = plan(f.fla, Object.values(f), 'requestresources any food 500m 5b 50m 1b').plan;
    assert.strictEqual(p.actions.length, 0);
  });

  await t('one mission at a time between two cities, going or coming back; /slots allows more', () => {
    const f = fleet();
    const out = march(f.five, f.fla, C.MISSION.transport, { direction: 2, resource: { stone: 1e6 } });
    let p = plan(f.fla, Object.values(f), 'requestresources any food 500m 5b 50m 1b', { selfArmys: [out] }).plan;
    assert.strictEqual(p.actions.length, 0, '5 already has a transport out to Fla, and 8 is 57 tiles farther');
    has(p.note, 'waiting for 5 (2.2 tiles), its last one to here not back yet');

    p = plan(f.fla, Object.values(f), 'requestresources any food 500m 5b 50m 1b /slots:2', { selfArmys: [out] }).plan;
    assert.strictEqual(p.actions[0].from.name, '5');
    assert.strictEqual(p.actions[0].rally.pairLimit, 2);
  });

  await t('a nearer city busy with this one is waited for only if it would be the one to send', () => {
    const f = fleet({ five: { food: 1.02e9 } });          // 5 could send only part
    const out = march(f.five, f.fla, C.MISSION.transport, { direction: 2 });
    const p = plan(f.fla, Object.values(f), 'requestresources any food 500m 5b 50m 1b', { selfArmys: [out] }).plan;
    assert.strictEqual(p.actions[0].from.name, '8', '8 can send it all; 5 could not have');
  });

  // ========================================================== the sender
  console.log('\nrequestresources: what a sender may give\n');

  await t('a full rally spot, or the sender\'s rallypolicy, passes it to the next city', () => {
    const f = fleet({ five: { rally: 2 } });
    const elsewhere = { fieldId: C.coordsToFieldId(10, 10) };
    const busy = [march(f.five, elsewhere, C.MISSION.attack), march(f.five, elsewhere, C.MISSION.scout)];
    let p = plan(f.fla, Object.values(f), 'requestresources any food 500m 5b 50m 1b', { selfArmys: busy }).plan;
    assert.strictEqual(p.actions[0].from.name, '8');

    const g = fleet();
    const one = [march(g.five, elsewhere, C.MISSION.transport)];
    p = plan(g.fla, Object.values(g), 'requestresources any food 500m 5b 50m 1b', { selfArmys: one, own: { 5: 'rallypolicy r:1' } }).plan;
    assert.strictEqual(p.actions[0].from.name, '8');
  });

  await t('nobody able to send says why', () => {
    const f = fleet({ five: { rally: 1 } });
    const elsewhere = { fieldId: C.coordsToFieldId(10, 10) };
    const p = plan(f.fla, [f.fla, f.five], 'requestresources 5 food 500m 5b 50m 1b',
      { selfArmys: [march(f.five, elsewhere, C.MISSION.attack)] }).plan;
    assert.strictEqual(p.actions.length, 0);
    has(p.note, 'no sender — 5 rally spot L1: 1/1 busy');
  });

  await t('a quarter of the sender\'s transports stay home for farming', () => {
    const f = fleet({ five: { troop: { carriage: 100 } } });
    const p = plan(f.fla, Object.values(f), 'requestresources 5 food 500m 5b 50m 1b').plan;
    assert.strictEqual(food(p.actions[0]), 75 * 5000);
    assert.strictEqual(p.actions[0].carriages, 75);
  });

  await t('a sender is never taken below its own <min>, so nothing ping-pongs', () => {
    const f = fleet({ five: { gold: 1.1e6 } });
    const line = 'requestresources 5 gold 1m 2m 500k 200k';
    const p = plan(f.fla, Object.values(f), line).plan;          // 5 has the same line
    assert.strictEqual(p.actions[0].resources.gold, 100e3, 'only what is over its own 1m');
    const q = plan(f.fla, Object.values(f), line, { own: { 5: '' } }).plan;
    assert.strictEqual(q.actions[0].resources.gold, 500e3, 'without that line, only <keep> holds it');
  });

  await t('what a sender sent moments ago is not offered again', () => {
    const f = fleet({ five: { food: 1.1e9 } });
    const p = plan(f.fla, Object.values(f), 'requestresources 5 food 500m 5b 50m 1b', {
      book: (game, goalsOf) => {
        const b = R.rallyBook({ game, goalsOf, pending: [] });
        b.record({ from: f.five, kind: 'r', missionType: C.MISSION.transport, targetFieldId: f.eight.fieldId, resources: { food: 80e6 }, troops: { carriage: 16000 } });
        return b;
      },
    }).plan;
    // 1.1b - 80m sent = 1.02b; over the 1b keep that is 20m. 4,000 carriages left, 3,000 usable.
    assert.strictEqual(food(p.actions[0]), 15e6);
  });

  // ============================================================ requesttroops
  console.log('\nrequesttroops\n');

  await t('the nearest city with the whole batch over its keep reinforces', async () => {
    const f = fleet({ fla: { troop: { archer: 20e3 } }, five: { troop: { archer: 30e3 } }, eight: { troop: { archer: 500e3, scouter: 90e3 } } });
    const { plan: p, game } = plan(f.fla, Object.values(f), 'requesttroops any archer 100k 200k 50k 10k\nrequesttroops any scout 50k 80k 40k 10k');
    assert.strictEqual(p.actions.length, 1, 'archers and scouts from 8 ride together');
    const a = p.actions[0];
    assert.deepStrictEqual([a.kind, a.from.name, a.troops], ['reinforceTroops', '8', { archer: 50e3, scouter: 40e3 }]);
    assert.strictEqual(a.rally.kind, 't');
    const r = await T.executors.reinforceTroops(game, f.fla, a);
    assert.strictEqual(r.ok, 1);
    assert.deepStrictEqual([game.sent[0].castleId, game.sent[0].bean.missionType, game.sent[0].bean.targetPoint, game.sent[0].bean.troops.archer],
      [f.eight.castleId, C.MISSION.reinforce, f.fla.fieldId, 50e3]);
    assert.strictEqual(game.sent[0].bean.heroId, undefined, 'no hero goes with it');
  });

  await t('troops out that come back count, troops sent away to stay do not', () => {
    const f = fleet({ fla: { troop: { archer: 60e3 } }, eight: { troop: { archer: 500e3 } } });
    const camp = { fieldId: C.coordsToFieldId(490, 620) };
    const line = 'requesttroops any archer 100k 200k 50k 10k';
    // 60k home + 50k out attacking = 110k: not short
    let p = plan(f.fla, Object.values(f), line, { selfArmys: [march(f.fla, camp, C.MISSION.attack, { troop: { archer: 50e3 } })] }).plan;
    assert.strictEqual(p.actions.length, 0);
    // the same 50k reinforcing someone else are gone: short
    p = plan(f.fla, Object.values(f), line, { selfArmys: [march(f.fla, camp, C.MISSION.reinforce, { troop: { archer: 50e3 } })] }).plan;
    assert.strictEqual(p.actions.length, 1);
    // 50k on their way in from 9: not short
    p = plan(f.fla, Object.values(f), line, { selfArmys: [march(f.nine, f.fla, C.MISSION.reinforce, { troop: { archer: 50e3 } })] }).plan;
    assert.strictEqual(p.actions.length, 0);
  });

  // ================================================================ the engine
  console.log('\nthe engine holds marches to the rally spot\n');

  function engineFor(castles, srcFor, selfArmys = []) {
    const game = fakeGame(castles, selfArmys);
    const e = new Engine(game, () => {});
    e.dryRun = false;
    e.state = {};
    e.goalsFor = (id, name) => parseGoals(`config hero:0\n${srcFor[name] || ''}`);
    return { e, game };
  }

  await t('two cities asking one sender in the same tick: rallypolicy r:1 lets one march go', async () => {
    const f = fleet();
    const other = city('X', 480, 610, { food: 10e6 });
    const ask = 'requestresources 5 food 500m 5b 50m 1b';
    const { e, game } = engineFor([f.fla, other, f.five], { Fla: ask, X: ask, 5: 'rallypolicy r:1' });
    await e.tick();
    assert.strictEqual(game.sent.length, 1, `${game.sent.length} marches went`);
    assert.strictEqual(game.sent[0].castleId, f.five.castleId);
    assert.strictEqual(e.pendingMarches.length, 1, 'the send is held against 5 until the server lists it');
    has(e.lastReport[other.castleId].transfer.note, 'no sender — 5 rallypolicy r:1 (1 resource transport out)');   // reports are keyed by castle id
  });

  await t('the next tick does not send again while the first is still on its way', async () => {
    const f = fleet();
    const { e, game } = engineFor([f.fla, f.five], { Fla: 'requestresources 5 food 500m 5b 50m 1b /slots:1' });
    await e.tick();
    assert.strictEqual(game.sent.length, 1);
    // the server has not listed it yet: the book still has it
    await e.tick();
    assert.strictEqual(game.sent.length, 1, 'sent a second transport before the first was listed');
    // now it is listed, going out with its load
    game.player.selfArmys.push(march(f.five, f.fla, C.MISSION.transport, { startTime: Date.now(), resource: { food: 50e6 } }));
    await e.tick();
    assert.strictEqual(game.sent.length, 1, 'sent a second transport while the first was on its way');
    assert.strictEqual(e.pendingMarches.length, 0, 'the listed march replaced the pending one');
  });

  await t('rallypolicy max: keeps slots free for scripts and manual marches', async () => {
    const f = fleet({ five: { rally: 10 } });
    const elsewhere = { fieldId: C.coordsToFieldId(10, 10) };
    const busy = Array.from({ length: 8 }, () => march(f.five, elsewhere, C.MISSION.attack));
    const { e, game } = engineFor([f.fla, f.five], { Fla: 'requestresources 5 food 500m 5b 50m 1b', 5: 'rallypolicy max:8' }, busy);
    await e.tick();
    assert.strictEqual(game.sent.length, 0, 'a goal march took the 9th slot');
    has(e.lastReport[f.fla.castleId].transfer.note, 'rallypolicy max:8 (8 busy)');
  });

  // Plans are made before anything in the slice is sent, so the engine checks
  // again. Here the plan was made blind to 5's full rally spot.
  await t('the engine holds a march the plan thought had room', async () => {
    const f = fleet({ five: { rally: 1 } });
    const elsewhere = { fieldId: C.coordsToFieldId(10, 10) };
    const { e, game } = engineFor([f.fla, f.five], { Fla: 'requestresources 5 food 500m 5b 50m 1b' },
      [march(f.five, elsewhere, C.MISSION.attack)]);
    const real = T.plans.transfer;
    T.plans.transfer = (ctx, st, g) => real({ ...ctx, rally: R.rallyBook({ game: g, armies: [] }) }, st, g);
    try { await e.tick(); } finally { T.plans.transfer = real; }
    assert.strictEqual(game.sent.length, 0, 'the transport went into a full rally spot');
    has(e.lastReport[f.fla.castleId].transfer.note, 'held back: pull 50,000,000 food from 5 (2.2 tiles, 10,000 transports): rally spot L1: 1/1 busy');
  });

  await t('traininghero waits for a rally slot before standing the mayor down', async () => {
    const otto = { id: 9, name: 'Otto', status: 1, power: 50, management: 50 };
    const a = city('A', 100, 100, { rally: 1, heros: [otto] });
    const b = city('B', 110, 100);
    const elsewhere = { fieldId: C.coordsToFieldId(10, 10) };
    const { e, game } = engineFor([a, b], { A: 'traininghero otto 0', B: 'traininghero otto 0' }, [march(a, elsewhere, C.MISSION.attack)]);
    await e.tick();
    assert.deepStrictEqual([game.discharged.length, game.sent.length], [0, 0]);
    game.player.selfArmys.length = 0;              // the attack came home
    await e.tick();
    assert.deepStrictEqual([game.discharged.length, game.sent.length], [1, 1]);
    assert.strictEqual(game.sent[0].bean.missionType, C.MISSION.reinforce);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(path.dirname(process.env.EVONY_DB), { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
