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
// cities share "default". These are Lord02's saved lines as
// migrate-goals-transfer.js rewrites them into NEAT's order (Step 9); the
// lines in this file were all converted with that same mapping.
const LORD02 = `requestresources any wood 2000000 200000 * 500000 /below:100000
requestresources any stone 50000000 10000000 * 5000000 /below:5000000
requestresources any iron 500000000 100000000 * 20000000 /below:50000000
requestresources any food 5000000000 1000000000 * 50000000 /below:500000000`;

function plan(here, castles, src, { selfArmys = [], own = {}, book = null, skills = null } = {}) {
  const game = fakeGame(castles, selfArmys);
  if (skills) Object.assign(game, skills);      // loadSkillParam / marchSkillParam, as read at login
  const parsed = parseGoals(src);
  assert.deepStrictEqual(parsed.errors, [], 'the goals should parse');
  const goalsOf = (c) => (own[c.name] !== undefined ? parseGoals(own[c.name]).goals : parsed.goals);
  const ctx = { castle: here, goals: parsed.goals, config: parsed.config, goalsOf, selfArmies: selfArmys };
  if (book) ctx.rally = book(game, goalsOf);
  return { plan: T.plans.transfer(ctx, {}, game), game };
}
const food = (a) => a.resources.food;
// What one carrier holds from `a` to `b` once the march's own food is on board
// (NewArmyWin.as: load x (1 + loadSkill/100), less twice its upkeep for each
// hour of the one-way march). The fake game reads no skills unless a test sets them.
const netHold = (a, b, kind = 'carriage', skill = 0) => {
  const ms = C.marchTimeMs(C.fieldIdToCoords(a.fieldId), C.fieldIdToCoords(b.fieldId), [kind], 0);
  return C.BY_KEY[kind].load * (1 + skill / 100) - C.BY_KEY[kind].food * 2 * ms / 3600000;
};
const holds = (units, a, b, kind, skill) => Math.floor(units * netHold(a, b, kind, skill));

(async () => {
  // ================================================================= parsing
  console.log('\nparsing\n');

  await t('the saved Lord02 lines read exactly as before', () => {
    const p = parseGoals(LORD02);
    assert.deepStrictEqual(p.errors, []);
    const f = p.goals.find((g) => g.type === 'food');
    assert.deepStrictEqual([f.target, f.local, f.remote, f.minBatch, f.maxBatch, f.below, f.slots], ['any', 5e9, 1e9, null, 50e6, 500e6, 1]);
  });

  await t('* for any amount, /slots, the t flag, and NEAT city lists', () => {
    const p = parseGoals('requestresources !HubCity|484,619 food 1b 100m * * t /below:* /slots:3');
    assert.deepStrictEqual(p.errors, []);
    const g = p.goals[0];
    assert.deepStrictEqual([g.target, g.local, g.remote, g.minBatch, g.maxBatch, g.carrier, g.below, g.slots],
      ['!HubCity|484,619', 1e9, 100e6, null, null, 'carriage', null, 3]);
    has(describe(p).join('\n'), 'food from !HubCity|484,619, while under 1,000,000,000, never past it, senders keep 100,000,000, any batch size, up to what one march carries, 3 missions at a time');
  });

  await t('mistakes are reported, not guessed at', () => {
    assert.match(parseGoals('requestresources any food 1m').errors[0].error, /localAmount and remoteAmount are required/);
    assert.match(parseGoals('requestresources any food 1m 2m 1m 1m dragons').errors[0].error, /unknown troop "dragons"/);
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
    // enough transports for the load and the march's own food
    assert.strictEqual(a.carriages, Math.ceil(55.5e6 / netHold(f.five, f.fla)));
    assert.deepStrictEqual([a.rally.kind, a.rally.pairLimit, a.rally.from.name], ['r', 1, '5']);
  });

  // ========================================================= /maxdist
  console.log('\n/maxdist: how far a line may reach\n');

  await t('/maxdist and its bare /50 form read the same, and a bad one is refused', () => {
    const p = parseGoals('requestresources any food 1b 100m * * /maxdist:50');
    assert.deepStrictEqual(p.errors, []);
    assert.strictEqual(p.goals[0].maxDist, 50);

    const q = parseGoals('requestresources any food 1b 100m * * /50');
    assert.deepStrictEqual(q.errors, []);
    assert.strictEqual(q.goals[0].maxDist, 50);
    has(describe(q).join('\n'), 'only from cities within 50 tiles');

    const r = parseGoals('requesttroops any archer 10k 1k /50');
    assert.deepStrictEqual([r.errors, r.goals[0].maxDist], [[], 50]);

    const k = parseGoals('keepresources any f:1b 50m /maxdist:12.5');
    assert.deepStrictEqual([k.errors, k.goals[0].maxDist], [[], 12.5]);
    has(describe(k).join('\n'), 'only to cities within 12.5 tiles');

    // a distance that can't be read is never guessed at: the line doesn't run
    for (const bad of ['/maxdist:far', '/maxdist', '/maxdist:0', '/maxdist:-5']) {
      assert.match(parseGoals(`requestresources any food 1b 100m ${bad}`).errors[0].error,
        /distance in tiles/, bad);
    }
    assert.match(parseGoals('sendresources any food 1b 100m /maxdist:50 /60').errors[0].error, /given twice/);
  });

  await t('a sender past /maxdist is passed over, and the note says how far it is', () => {
    // only 8 (59.2 tiles) and 9 (91.7) have food to spare; 5 sits on its keep
    const f = fleet({ five: { food: 1e9 }, eight: { food: 2e9 } });
    const line = 'requestresources any food 5b 1b * 50m /below:500m';
    let p = plan(f.fla, Object.values(f), line).plan;
    assert.strictEqual(p.actions[0].from.name, '8', p.note);

    p = plan(f.fla, Object.values(f), `${line} /maxdist:60`).plan;
    assert.strictEqual(p.actions[0].from.name, '8', p.note);

    p = plan(f.fla, Object.values(f), `${line} /50`).plan;
    assert.strictEqual(p.actions.length, 0, p.note);
    has(p.note, "8 is 59.2 tiles away, past this line's /maxdist:50");
  });

  await t('/maxdist holds for troops too', () => {
    const f = fleet({ nine: { troop: { carriage: 20000, archer: 50e3 } } });
    const line = 'requesttroops any archer 10k 0 * *';
    let p = plan(f.fla, Object.values(f), line).plan;
    assert.strictEqual(p.actions[0].from.name, '9', p.note);
    p = plan(f.fla, Object.values(f), `${line} /50`).plan;
    assert.strictEqual(p.actions.length, 0, p.note);
  });

  await t('a sender does not save a resource for a needier city its line cannot reach', () => {
    // 8 holds the food; Fla (2.2 tiles from 5) asks, and 5 is needier still —
    // but 5's own line only reaches 50 tiles, and 8 is 59.2 from Fla
    const f = fleet({ fla: { food: 100e6 }, five: { food: 0 }, eight: { food: 5e9 }, nine: { food: 1e9 } });
    const mine = 'requestresources any food 5b 1b * 50m /below:500m';
    let p = plan(f.fla, Object.values(f), mine, { own: { 5: mine } }).plan;
    assert.strictEqual(p.actions.length, 0, p.note);
    has(p.note, 'leaves its food for 5, which holds less');
    // the same line at 5, but it may not reach 8: 8 sends to Fla instead
    p = plan(f.fla, Object.values(f), mine, { own: { 5: `${mine} /maxdist:5` } }).plan;
    assert.strictEqual(p.actions[0].from.name, '8', p.note);
  });

  // ===================================================== what is on its way
  console.log('\nrequestresources: what is already coming\n');

  await t('a transport on its way in counts; one heading home does not', () => {
    const f = fleet();
    const going = march(f.nine, f.fla, C.MISSION.transport, { resource: { food: 450e6 } });
    let p = plan(f.fla, Object.values(f), 'requestresources any food 5b 1b * 50m /below:500m', { selfArmys: [going] }).plan;
    assert.strictEqual(p.actions.length, 0);
    has(p.note, 'nothing short');

    // ArmyBean still lists the load on the way back, but it has been delivered
    const back = { ...going, direction: 2 };
    p = plan(f.fla, Object.values(f), 'requestresources any food 5b 1b * 50m /below:500m', { selfArmys: [back] }).plan;
    assert.strictEqual(p.actions.length, 1);
  });

  await t('market purchases in transit count too', () => {
    const f = fleet({ fla: { transingTrades: [{ resType: 0, amount: 450e6 }] } });
    const p = plan(f.fla, Object.values(f), 'requestresources any food 5b 1b * 50m /below:500m').plan;
    assert.strictEqual(p.actions.length, 0);
  });

  await t('one mission at a time between two cities, going or coming back; /slots allows more', () => {
    const f = fleet();
    const out = march(f.five, f.fla, C.MISSION.transport, { direction: 2, resource: { stone: 1e6 } });
    let p = plan(f.fla, Object.values(f), 'requestresources any food 5b 1b * 50m /below:500m', { selfArmys: [out] }).plan;
    assert.strictEqual(p.actions.length, 0, '5 already has a transport out to Fla, and 8 is 57 tiles farther');
    has(p.note, 'waiting for 5 (2.2 tiles), its last one to here not back yet');

    p = plan(f.fla, Object.values(f), 'requestresources any food 5b 1b * 50m /below:500m /slots:2', { selfArmys: [out] }).plan;
    assert.strictEqual(p.actions[0].from.name, '5');
    assert.strictEqual(p.actions[0].rally.pairLimit, 2);
  });

  await t('a nearer city busy with this one is waited for only if it would be the one to send', () => {
    const f = fleet({ five: { food: 1.02e9 } });          // 5 could send only part
    const out = march(f.five, f.fla, C.MISSION.transport, { direction: 2 });
    const p = plan(f.fla, Object.values(f), 'requestresources any food 5b 1b * 50m /below:500m', { selfArmys: [out] }).plan;
    assert.strictEqual(p.actions[0].from.name, '8', '8 can send it all; 5 could not have');
  });

  // ========================================================== the sender
  console.log('\nrequestresources: what a sender may give\n');

  await t('a full rally spot, or the sender\'s rallypolicy, passes it to the next city', () => {
    const f = fleet({ five: { rally: 2 } });
    const elsewhere = { fieldId: C.coordsToFieldId(10, 10) };
    const busy = [march(f.five, elsewhere, C.MISSION.attack), march(f.five, elsewhere, C.MISSION.scout)];
    let p = plan(f.fla, Object.values(f), 'requestresources any food 5b 1b * 50m /below:500m', { selfArmys: busy }).plan;
    assert.strictEqual(p.actions[0].from.name, '8');

    const g = fleet();
    const one = [march(g.five, elsewhere, C.MISSION.transport)];
    p = plan(g.fla, Object.values(g), 'requestresources any food 5b 1b * 50m /below:500m', { selfArmys: one, own: { 5: 'rallypolicy r:1' } }).plan;
    assert.strictEqual(p.actions[0].from.name, '8');
  });

  await t('nobody able to send says why', () => {
    const f = fleet({ five: { rally: 1 } });
    const elsewhere = { fieldId: C.coordsToFieldId(10, 10) };
    const p = plan(f.fla, [f.fla, f.five], 'requestresources 5 food 5b 1b * 50m /below:500m',
      { selfArmys: [march(f.five, elsewhere, C.MISSION.attack)] }).plan;
    assert.strictEqual(p.actions.length, 0);
    has(p.note, 'no sender — 5 rally spot L1: 1/1 busy');
  });

  await t('a quarter of the sender\'s transports stay home for farming', () => {
    const f = fleet({ five: { troop: { carriage: 100 } } });
    const p = plan(f.fla, Object.values(f), 'requestresources 5 food 5b 1b * 50m /below:500m').plan;
    assert.strictEqual(food(p.actions[0]), holds(75, f.five, f.fla), '75 transports, less their own march food');
    assert.strictEqual(p.actions[0].carriages, 75);
  });

  await t('a sender is never taken below its own trigger (/below), so nothing ping-pongs', () => {
    const f = fleet({ five: { gold: 1.1e6 } });
    const line = 'requestresources 5 gold 2m 200k * 500k /below:1m';
    const p = plan(f.fla, Object.values(f), line).plan;          // 5 has the same line
    assert.strictEqual(p.actions[0].resources.gold, 100e3, 'only what is over its own 1m');
    const q = plan(f.fla, Object.values(f), line, { own: { 5: '' } }).plan;
    assert.strictEqual(q.actions[0].resources.gold, 500e3, 'without that line, only remoteAmount holds it');
  });

  await t('what a sender sent moments ago is not offered again', () => {
    const f = fleet({ five: { food: 1.1e9 } });
    const p = plan(f.fla, Object.values(f), 'requestresources 5 food 5b 1b * 50m /below:500m', {
      book: (game, goalsOf) => {
        const b = R.rallyBook({ game, goalsOf, pending: [] });
        b.record({ from: f.five, kind: 'r', missionType: C.MISSION.transport, targetFieldId: f.eight.fieldId, resources: { food: 80e6 }, troops: { carriage: 16000 } });
        return b;
      },
    }).plan;
    // 1.1b - 80m sent = 1.02b; over the 1b keep that is 20m. 4,000 carriages left, 3,000 usable.
    assert.strictEqual(food(p.actions[0]), holds(3000, f.five, f.fla), '3,000 transports, less their own march food');
  });

  // ============================================================ requesttroops
  console.log('\nrequesttroops\n');

  await t('the nearest city with the whole batch over its keep reinforces', async () => {
    const f = fleet({ fla: { troop: { archer: 20e3 } }, five: { troop: { archer: 30e3 } }, eight: { troop: { archer: 500e3, scouter: 90e3 } } });
    const { plan: p, game } = plan(f.fla, Object.values(f), 'requesttroops any archer 200k 10k * 50k /below:100k\nrequesttroops any scout 80k 10k * 40k /below:50k');
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
    const line = 'requesttroops any archer 200k 10k * 50k /below:100k';
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
    const ask = 'requestresources 5 food 5b 1b * 50m /below:500m';
    const { e, game } = engineFor([f.fla, other, f.five], { Fla: ask, X: ask, 5: 'rallypolicy r:1' });
    await e.tick();
    assert.strictEqual(game.sent.length, 1, `${game.sent.length} marches went`);
    assert.strictEqual(game.sent[0].castleId, f.five.castleId);
    assert.strictEqual(e.pendingMarches.length, 1, 'the send is held against 5 until the server lists it');
    // lowest first: X holds 10m to Fla's 100m, so the one march goes to X and Fla's
    // plan says it left the food for X (reports are keyed by castle id)
    has(e.lastReport[f.fla.castleId].transfer.note, 'no sender — 5 leaves its food for X, which holds less (10m)');
    has(e.lastReport[other.castleId].transfer.note, 'from 5');
  });

  await t('the next tick does not send again while the first is still on its way', async () => {
    const f = fleet();
    const { e, game } = engineFor([f.fla, f.five], { Fla: 'requestresources 5 food 5b 1b * 50m /below:500m /slots:1' });
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
    const { e, game } = engineFor([f.fla, f.five], { Fla: 'requestresources 5 food 5b 1b * 50m /below:500m', 5: 'rallypolicy max:8' }, busy);
    await e.tick();
    assert.strictEqual(game.sent.length, 0, 'a goal march took the 9th slot');
    has(e.lastReport[f.fla.castleId].transfer.note, 'rallypolicy max:8 (8 busy)');
  });

  // Plans are made before anything in the slice is sent, so the engine checks
  // again. Here the plan was made blind to 5's full rally spot.
  await t('the engine holds a march the plan thought had room', async () => {
    const f = fleet({ five: { rally: 1 } });
    const elsewhere = { fieldId: C.coordsToFieldId(10, 10) };
    const { e, game } = engineFor([f.fla, f.five], { Fla: 'requestresources 5 food 5b 1b * 50m /below:500m' },
      [march(f.five, elsewhere, C.MISSION.attack)]);
    const real = T.plans.transfer;
    T.plans.transfer = (ctx, st, g) => real({ ...ctx, rally: R.rallyBook({ game: g, armies: [] }) }, st, g);
    try { await e.tick(); } finally { T.plans.transfer = real; }
    assert.strictEqual(game.sent.length, 0, 'the transport went into a full rally spot');
    has(e.lastReport[f.fla.castleId].transfer.note, `held back: pull ${holds(10000, f.five, f.fla).toLocaleString('en-US')} food from 5 (2.2 tiles, 10,000 transports): rally spot L1: 1/1 busy`);
  });

  await t('traininghero waits for a rally slot before standing the mayor down', async () => {
    const otto = { id: 9, name: 'Otto', status: 1, power: 50, management: 50 };
    // the move is a reinforce march carrying one scout, so the city needs one:
    // with none the engine holds the hero rather than standing it down for a
    // march that cannot go (engine.js, the user 2026-09-22)
    const a = city('A', 100, 100, { rally: 1, heros: [otto], troop: { carriage: 20000, scouter: 10 } });
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

  // ============================================= troops a march may take
  console.log('\na march takes at most 10,000 troops per Rally Spot level\n');

  await t('the live case: a 1b request goes as 500m on 100,000 transports, not 199,974 (refused live)', () => {
    const f = fleet({ five: { troop: { carriage: 250e3 } } });
    const { plan: p } = plan(f.fla, Object.values(f), 'requestresources any food 1b 2b 100m 1b t');
    assert.strictEqual(p.actions.length, 1);
    const a = p.actions[0];
    assert.deepStrictEqual([a.from.name, food(a), a.carriages], ['5', holds(100e3, f.five, f.fla), 100e3]);
  });

  await t('a Rally Spot L3 sender sends at most 30,000 transports', () => {
    const f = fleet({ five: { troop: { carriage: 250e3 }, rally: 3 } });
    const { plan: p } = plan(f.fla, Object.values(f), 'requestresources any food 1b 2b 100m 1b t');
    assert.deepStrictEqual([food(p.actions[0]), p.actions[0].carriages], [holds(30e3, f.five, f.fla), 30e3]);
  });

  await t('lines one sender serves share its march limit, and the plan says the march is full', () => {
    const f = fleet({ five: { troop: { carriage: 250e3 }, wood: 5e9 } });
    const { plan: p } = plan(f.fla, Object.values(f), 'requestresources 5 food 1b 2b 100m 1b t\nrequestresources 5 wood 1b 2b 100m 1b t');
    assert.strictEqual(p.actions.length, 1);
    assert.deepStrictEqual([food(p.actions[0]), p.actions[0].resources.wood || 0, p.actions[0].carriages], [holds(100e3, f.five, f.fla), 0, 100e3]);
    has(p.note, "5's march here is full (100,000 troops, its Rally Spot's limit)");
  });

  await t('Logistics counts: at +100% load a 500m batch needs about half the transports', () => {
    const f = fleet({ five: { troop: { carriage: 250e3 } } });
    const { plan: p } = plan(f.fla, Object.values(f), 'requestresources any food 1b 2b 100m 500m t', { skills: { loadSkillParam: 100 } });
    const a = p.actions[0];
    assert.strictEqual(food(a), 500e6);
    assert.strictEqual(a.carriages, Math.ceil(500e6 / netHold(f.five, f.fla, 'carriage', 100)));
    assert.ok(a.carriages > 50e3 && a.carriages < 51e3, `${a.carriages} transports`);
  });

  await t('cavalry at +100% carry 200 each, less their march food: 10m fits one L10 march', () => {
    const f = fleet({ five: { troop: { lightCavalry: 200e3 } } });
    const { plan: p } = plan(f.fla, Object.values(f), 'requestresources 5 food 110m 20m c', { skills: { loadSkillParam: 100 }, own: { 5: '' } });
    const a = p.actions[0];
    assert.strictEqual(food(a), 10e6);
    assert.deepStrictEqual(a.troops, { lightCavalry: Math.ceil(10e6 / netHold(f.five, f.fla, 'lightCavalry', 100)) });
  });

  await t('scouts on a long trip eat their whole hold: nothing is sent, and the plan says why', () => {
    // 300 tiles: about 1.7 hours for scouts, and a scout eats 10 an hour of its 10 hold
    const f = fleet({ five: { troop: { scouter: 100e3 } } });
    const far = city('Far', 184, 619, { food: 3e9, troop: { scouter: 100e3 } });
    const { plan: p } = plan(f.fla, [...Object.values(f), far], 'requestresources Far food 110m 2m * 500k s', { skills: { loadSkillParam: 100 }, own: { Far: '' } });
    assert.ok(netHold(far, f.fla, 'scouter', 100) <= 0, 'the test needs a trip longer than a scout can feed itself on');
    assert.strictEqual(p.actions.length, 0);
    has(p.note, 'Far is too far for scouts to carry anything: they would eat it all on the way (300.0 tiles)');
    // two tiles away they carry nearly the whole 10
    const near = plan(f.fla, Object.values(f), 'requestresources 5 food 110m 2m * 500k s', { skills: { loadSkillParam: 100 }, own: { 5: '' } }).plan;
    assert.strictEqual(food(near.actions[0]), 0.5e6);
    assert.ok(netHold(f.five, f.fla, 'scouter', 100) > 9.8);
  });

  await t('requesttroops sends at most the limit in one march', () => {
    const f = fleet({ five: { troop: { archer: 300e3 } } });
    const { plan: p } = plan(f.fla, Object.values(f), 'requesttroops 5 archer 500k 0', { own: { 5: '' } });
    assert.deepStrictEqual(p.actions[0].troops, { archer: 100e3 });
  });

  await t('Game.newArmy refuses a march over the city\'s limit without sending it', async () => {
    const sent = [];
    const g = {
      castles: [city('Small', 10, 10, { rally: 2 }), city('NoList', 20, 20, { rally: null })],
      castleId: (c) => c.castleId,
      c: { send: (cmd, data) => sent.push(data), await: async () => ({ data: { ok: 1 } }) },
    };
    const [small, bare] = g.castles;
    let r = await Game.prototype.newArmy.call(g, small.castleId, { troops: { archer: 15e3, scouter: 5001 } });
    assert.strictEqual(r.ok, 0);
    has(r.errorMsg, 'a march from Small takes at most 20,000 troops (10,000 per Rally Spot level), not 20,001');
    assert.strictEqual(sent.length, 0);
    r = await Game.prototype.newArmy.call(g, small.castleId, { troops: { archer: 15e3, scouter: 5000 } });
    assert.deepStrictEqual([r.ok, sent.length], [1, 1]);
    // no Rally Spot in the list: the server judges it
    r = await Game.prototype.newArmy.call(g, bare.castleId, { troops: { archer: 500e3 } });
    assert.deepStrictEqual([r.ok, sent.length], [1, 2]);
    assert.strictEqual(R.marchTroopLimit(city('Top', 1, 1, { rally: 10 })), 100e3);
    assert.strictEqual(R.marchTroopLimit({ name: 'x' }), null);
  });

  await t('bigattack, /horde and both: a War Ensign adds 25%, the Horde banner takes 1,000,000', async () => {
    const sent = [];
    const top = city('Top', 30, 30, { rally: 10 }), low = city('Low', 40, 40, { rally: 2 });
    const g = { castles: [top, low], castleId: (c) => c.castleId,
      c: { send: (cmd, data) => sent.push(data), await: async () => ({ data: { ok: 1 } }) } };
    const go = (c, n, { big = false, horde = false } = {}) => Game.prototype.newArmy.call(g, c.castleId, { troops: { scouter: n }, useFlag: big, useItem: horde });
    assert.strictEqual((await go(top, 125e3, { big: true })).ok, 1, 'bigattack s:125k at Rally Spot L10');
    let r = await go(top, 125001, { big: true });
    has(r.errorMsg, 'takes at most 125,000 troops (10,000 per Rally Spot level, +25% with a War Ensign)');
    assert.strictEqual((await go(top, 1e6, { horde: true })).ok, 1, 'attack s:1m /horde');
    assert.strictEqual((await go(low, 1e6, { horde: true })).ok, 1, 'the Horde banner is not held to the Rally Spot here');
    assert.strictEqual((await go(top, 1.25e6, { big: true, horde: true })).ok, 1, 'bigscout s:1.25m /horde');
    r = await go(top, 1.25e6 + 1, { big: true, horde: true });
    has(r.errorMsg, 'takes at most 1,250,000 troops (with the Horde banner and a War Ensign)');
    r = await go(top, 100001);
    assert.strictEqual(r.ok, 0, 'no item, no more than 100,000');
    assert.strictEqual(sent.length, 4);
  });

  // The user, 2026-09-24: a haunted castle was applied and 125k waves were
  // still refused — by OUR guard, which could not see the buff.
  await t('a haunted castle adds 25% too, and /nolimit sends whatever the guard thinks', async () => {
    const sent = [];
    const plain = city('Plain', 30, 30, { rally: 10 });
    const spooky = city('Spooky', 31, 31, { rally: 10, buffs: [{ typeId: 'HauntedCastleBuf', endTime: Date.now() + 864e5 }] });
    const g = { castles: [plain, spooky], castleId: (c) => c.castleId, player: { buffs: [] },
      c: { send: (cmd, data) => sent.push(data), await: async () => ({ data: { ok: 1 } }) } };
    const go = (c, n, o = {}, call = {}) => Game.prototype.newArmy.call(g, c.castleId,
      { troops: { scouter: n }, useFlag: !!o.big, useItem: !!o.horde }, call);
    assert.strictEqual((await go(spooky, 125e3)).ok, 1, '125k from the haunted city, no War Ensign');
    assert.strictEqual((await go(spooky, 156250, { big: true })).ok, 1, 'a War Ensign on top: 156,250');
    let r = await go(spooky, 125001);
    has(r.errorMsg, 'takes at most 125,000 troops (10,000 per Rally Spot level, +25% for the haunted castle)');
    r = await go(plain, 125e3);
    assert.strictEqual(r.ok, 0, 'a city with no haunted castle is still held to 100,000');
    has(r.errorMsg, '/nolimit sends it anyway');
    // the account-wide buff counts for every city, as the client's buff bar has it
    g.player.buffs = [{ typeId: 'HauntedCastleAdvBuf' }];
    assert.strictEqual((await go(plain, 125e3)).ok, 1, 'the buff on the player, not the city');
    g.player.buffs = [];
    // and an expired one counts for nothing
    spooky.buffs = [{ typeId: 'HauntedCastleBuf', endTime: Date.now() - 1000 }];
    assert.strictEqual((await go(spooky, 125e3)).ok, 0, 'an expired haunted castle is no bonus');
    // /nolimit: never judged here at all
    assert.strictEqual((await go(plain, 900e3, {}, { noLimit: true })).ok, 1, '/nolimit goes to the server');
    assert.strictEqual(sent.length, 4, 'the three refusals never reached the wire');
  });

  // ============================================================ lowest first
  console.log('\nlowest first\n');
  const SPREAD = 'requestresources any gold 40000b 40000b 100m 1b t';
  const spread = () => ({
    rich: city('Rich', 300, 300, { gold: 60e12 }),
    poor: city('Poor', 301, 300, { gold: 100 }),
    mid: city('Mid', 302, 300, { gold: 20e12 }),
  });

  await t('a sender leaves its gold for the city that holds least', () => {
    const c = spread();
    const { plan: p } = plan(c.mid, [c.rich, c.poor, c.mid], SPREAD);
    assert.strictEqual((p.actions || []).length, 0, 'Mid gets nothing while Poor has less');
    has(p.note, 'Rich leaves its gold for Poor, which holds less (100)');
  });

  await t('the city that holds least is served', () => {
    const c = spread();
    const { plan: p } = plan(c.poor, [c.rich, c.poor, c.mid], SPREAD);
    assert.strictEqual(p.actions.length, 1, p.note);
    has(p.note, 'from Rich');
  });

  await t('a sender whose mission to the neediest is still out serves the next one', () => {
    const c = spread();
    const out = march(c.rich, c.poor, C.MISSION.transport);
    const { plan: p } = plan(c.mid, [c.rich, c.poor, c.mid], SPREAD, { selfArmys: [out] });
    assert.strictEqual(p.actions.length, 1, p.note);
    has(p.note, 'from Rich');
  });

  // ======================================================= one full march
  console.log('\nthe batch: as much as one march carries\n');
  const L10 = { loadSkillParam: 100 };           // Logistics 10, as army.getTroopParam answers it

  await t('* as maxBatch is one full march: 100,000 transports at Logistics 10 carry about 1b', () => {
    const f = fleet({ five: { troop: { carriage: 250e3 }, gold: 50e12 } });
    const { plan: p } = plan(f.fla, Object.values(f), 'requestresources any gold 20000b 1b 100m * t', { skills: L10 });
    assert.strictEqual(p.actions.length, 1, p.note);
    const a = p.actions[0];
    assert.deepStrictEqual([a.from.name, a.carriages, a.resources.gold], ['5', 100e3, holds(100e3, f.five, f.fla, 'carriage', 100)]);
    assert.ok(a.resources.gold > 999e6 && a.resources.gold <= 1e9, `${a.resources.gold} gold`);
    has(p.note, 'what one march carries');
  });

  await t('a maxBatch bigger than one march carries is one full march too', () => {
    const f = fleet({ five: { troop: { carriage: 250e3 }, gold: 50e12 } });
    const star = plan(f.fla, Object.values(f), 'requestresources any gold 20000b 1b 100m * t', { skills: L10 }).plan;
    const big = plan(f.fla, Object.values(f), 'requestresources any gold 20000b 1b 100m 5b t', { skills: L10 }).plan;
    assert.deepStrictEqual(big.actions[0].resources, star.actions[0].resources);
    assert.strictEqual(big.actions[0].carriages, 100e3);
  });

  await t('the old 500m lines were a cap of their own: 500m on about 50,000 transports', () => {
    const f = fleet({ five: { troop: { carriage: 250e3 }, gold: 50e12 } });
    const { plan: p } = plan(f.fla, Object.values(f), 'requestresources any gold 20000b 1b 100m 500m t', { skills: L10 });
    assert.strictEqual(p.actions[0].resources.gold, 500e6);
    assert.ok(p.actions[0].carriages < 51e3);
  });

  await t('the Logistics figure the city\'s own army.getTroopParam gave wins; with none, base load and the plan says so', () => {
    const f = fleet({ five: { troop: { carriage: 250e3 }, gold: 50e12 } });
    const line = 'requestresources any gold 20000b 1b 100m * t';
    // nothing read: base load, 500m on 100,000 — what was seen live on 2026-09-19
    let r = plan(f.fla, Object.values(f), line);
    assert.deepStrictEqual([r.plan.actions[0].carriages, r.plan.actions[0].resources.gold], [100e3, holds(100e3, f.five, f.fla)]);
    assert.ok(r.plan.actions[0].resources.gold < 500e6 + 1);
    has(r.plan.note, "5: its Logistics bonus isn't read yet");
    // the login read nothing (0), but Game.troopParams asked 5 with its castleId
    const cache = new Map([[f.five.castleId, { at: Date.now(), p: { loadSkill: 100, marchSkill: 0 } }]]);
    r = plan(f.fla, Object.values(f), line, { skills: { loadSkillParam: 0, _troopParams: cache } });
    assert.strictEqual(r.plan.actions[0].resources.gold, holds(100e3, f.five, f.fla, 'carriage', 100));
    assert.ok(!r.plan.note.includes("isn't read yet"), r.plan.note);
  });

  await t('a transport sent without the figure asks army.getTroopParam for the sending city, once', async () => {
    const f = fleet({ five: { troop: { carriage: 250e3 }, gold: 50e12 } });
    const { plan: p, game } = plan(f.fla, Object.values(f), 'requestresources any gold 20000b 1b 100m * t');
    const asked = [];
    game._troopParams = new Map();
    game.troopParams = async (cid) => { asked.push(cid); game._troopParams.set(cid, { at: Date.now(), p: { loadSkill: 100 } }); return { loadSkill: 100 }; };
    await T.executors.transport(game, f.five, p.actions[0]);
    await T.executors.transport(game, f.five, p.actions[0]);
    assert.deepStrictEqual(asked, [f.five.castleId], 'asked once, with the castleId');
    assert.strictEqual(game.sent.length, 2, 'both marches went');
    assert.strictEqual(T._internals.loadSkillOf(game, f.five), 100);
    // and the next pass loads the full march
    const ctx = { castle: f.fla, goals: parseGoals('requestresources any gold 20000b 1b 100m * t').goals, goalsOf: () => [] };
    const again = T.plans.transfer(ctx, {}, game);
    assert.strictEqual(again.actions[0].resources.gold, holds(100e3, f.five, f.fla, 'carriage', 100));
  });

  // ================================================================ /steps
  console.log('\n/steps: even the account out, the poorest first\n');
  const STEPS = 'requestresources any gold 20000b 20000b 100m * t /steps:1000b,10000b';
  const T12 = 1e12;
  // ten cities in a row, one tile apart; `gold` in trillions
  const row = (golds) => golds.map((g, i) => city(`C${i}`, 100 + i, 200, { gold: g * T12, troop: { carriage: 250e3 } }));

  await t('/steps parses, and says what it does', () => {
    const p = parseGoals(STEPS);
    assert.deepStrictEqual(p.errors, []);
    assert.deepStrictEqual([p.goals[0].steps, p.goals[0].local, p.goals[0].remote], [[1e12, 10e12], 20e12, 20e12]);
    const d = describe(p).join('\n');
    has(d, 'in steps, the poorest city first: 1,000,000,000,000, then 10,000,000,000,000, then 20,000,000,000,000');
    has(d, 'the richest free city sends');
    assert.match(parseGoals('requestresources any gold 20000b 20000b 100m * t /steps:10000b,1000b').errors[0].error, /must go up/);
    assert.match(parseGoals('requestresources any gold 20000b 20000b 100m * t /steps:1000b,20000b').errors[0].error, /under localAmount/);
    assert.match(parseGoals('requestresources any gold * 20000b 100m * t /steps:1000b').errors[0].error, /needs a localAmount/);
    assert.match(parseGoals('requestresources any gold 20000b 20000b /steps:1000b /below:5000b').errors[0].error, /use one of them/);
    assert.match(parseGoals('requestresources any gold 20000b 20000b /steps:1t').errors[0].error, /\/steps needs amounts/);
    assert.match(parseGoals('requesttroops any archer 20k 20k /steps:1k').errors[0].error, /unknown switch \/steps/);
    // the proposed spread layer parses clean
    const layer = ['requestresources any gold 20000b 20000b 100m * t /steps:1000b,10000b',
      ...['food', 'wood', 'stone', 'iron'].map((r) => `requestresources any ${r} 400b 400b 100m * t /steps:10b,100b`)].join('\n');
    assert.deepStrictEqual(parseGoals(layer).errors, []);
  });

  await t('the user\'s example: nine cities at 20-40t, one at 500m — only it receives, from the richest', () => {
    const cs = row([20, 22.5, 25, 27.5, 30, 32.5, 35, 37.5, 40, 0.0005]);
    const poor = cs[9];
    let sends = 0;
    for (const c of cs) {
      const { plan: p } = plan(c, cs, STEPS, { skills: L10 });
      if (c === poor) {
        assert.strictEqual(p.actions.length, 1, p.note);
        const a = p.actions[0];
        assert.strictEqual(a.from.name, 'C8', `the richest (40t) sends, not ${a.from.name}`);
        assert.ok(a.resources.gold > 999e6 && a.resources.gold <= 1e9, `a full march: ${a.resources.gold}`);
        has(p.note, 'gold 500m < 1000b (step 1000b of 20000b)');
      }
      sends += p.actions.length;
    }
    assert.strictEqual(sends, 1, 'nothing moves between the rich cities');
  });

  await t('the richest out on a mission to it is not waited for: the next richest sends', () => {
    const cs = row([20, 22.5, 25, 27.5, 30, 32.5, 35, 37.5, 40, 0.0005]);
    const out = march(cs[8], cs[9], C.MISSION.transport, { resource: { gold: 1e9 } });
    const { plan: p } = plan(cs[9], cs, STEPS, { skills: L10, selfArmys: [out] });
    assert.strictEqual(p.actions[0].from.name, 'C7', p.note);
    has(p.note, 'gold 500m + 1b coming < 1000b');
  });

  await t('a higher step waits while a city is still under a lower one', () => {
    // A 500m, B 5t, C 15t, D 40t: the 1t step first — B (under 10t) waits
    const cs = row([0.0005, 5, 15, 40]);
    const [A, B] = cs;
    const pb = plan(B, cs, STEPS, { skills: L10 }).plan;
    assert.strictEqual(pb.actions.length, 0, pb.note);
    has(pb.note, 'gold 5000b < 20000b: waiting — the 1000b step first (C0 holds 500m)');
    const pa = plan(A, cs, STEPS, { skills: L10 }).plan;
    assert.strictEqual(pa.actions[0].from.name, 'C3', 'from the richest');
    // A is at 1t (less than a minimum batch short counts as there): the 10t step
    cs[0].resource.gold = T12 - 50e6;
    const pb2 = plan(B, cs, STEPS, { skills: L10 }).plan;
    // B is under 10t now asking, but A holds less and D can serve A: lowest first
    has(pb2.note, 'leaves its gold for C0, which holds less');
    const pa2 = plan(A, cs, STEPS, { skills: L10 }).plan;
    has(pa2.note, '(step 10000b of 20000b)');
    assert.strictEqual(pa2.actions[0].from.name, 'C3');
  });

  await t('a sender is never taken below the step it gives at', () => {
    // P 2t asks at the 10t step; Q holds 10t + 500m, the only city over 10t
    const cs = row([2, 10.0005, 3]);
    const { plan: p } = plan(cs[0], cs, STEPS, { skills: L10 });
    assert.deepStrictEqual([p.actions[0].from.name, p.actions[0].resources.gold], ['C1', 500e6]);
    has(p.note, 'all it can spare');
    // with Q at exactly 10t there is nobody to give at 10t, and nothing above either
    cs[1].resource.gold = 10 * T12;
    const q = plan(cs[0], cs, STEPS, { skills: L10 }).plan;
    assert.strictEqual(q.actions.length, 0);
    has(q.note, 'nothing to even out — C0 holds 2000b, and no city holds over 10000b to give');
  });

  await t('at the top step, cities over 20t give only down to 20t, and nobody at 20t receives', () => {
    const cs = row([19, 20, 20.3, 40]);
    const p = plan(cs[0], cs, STEPS, { skills: L10 }).plan;
    assert.strictEqual(p.actions[0].from.name, 'C3', p.note);
    has(p.note, 'gold 19000b < 20000b:');
    for (const c of cs.slice(1)) assert.strictEqual(plan(c, cs, STEPS, { skills: L10 }).plan.actions.length, 0, `${c.name} received`);
    // only C2 is over 20t, by 300b: it gives at most that
    const cs2 = row([19.9, 20, 20.0003]);
    const p2 = plan(cs2[0], cs2, STEPS, { skills: L10 }).plan;
    assert.deepStrictEqual([p2.actions[0].from.name, p2.actions[0].resources.gold], ['C2', 300e6]);
  });

  await t('every city at the top: nothing moves at all', () => {
    const cs = row([20, 30, 40, 25]);
    for (const c of cs) {
      const { plan: p } = plan(c, cs, STEPS, { skills: L10 });
      assert.strictEqual(p.actions.length, 0);
      has(p.note, 'nothing short');
    }
  });

  await t('the resource steps work the same way: 10b, 100b, 400b', () => {
    const line = 'requestresources any wood 400b 400b 100m * t /steps:10b,100b';
    const cs = [city('W0', 100, 200, { wood: 2e9, troop: { carriage: 250e3 } }), city('W1', 101, 200, { wood: 50e9, troop: { carriage: 250e3 } }),
      city('W2', 102, 200, { wood: 900e9, troop: { carriage: 250e3 } })];
    const p0 = plan(cs[0], cs, line, { skills: L10 }).plan;
    assert.strictEqual(p0.actions[0].from.name, 'W2');
    has(p0.note, '(step 10b of 400b)');
    has(plan(cs[1], cs, line, { skills: L10 }).plan.note, 'waiting — the 10b step first (W0 holds 2b)');
  });

  await t('across resources the lowest step goes first: gold (listed first, in trillions) no longer starves iron', () => {
    // Lord08's New city on 2026-09-19: 5.9t gold (under the 10t step), 1.5b iron
    // (under the 10b step). One sender free, the other still out on a trip here.
    const LAYER = 'requestresources any gold 20000b 20000b 100m * t /steps:1000b,10000b\n'
      + 'requestresources any iron 400b 400b 100m * t /steps:10b,100b';
    const mk = () => [city('New', 100, 200, { gold: 5.9 * T12, iron: 1.5e9, troop: { carriage: 250e3 } }),
      city('D1', 101, 200, { gold: 30 * T12, iron: 700e9, troop: { carriage: 250e3 } }),
      city('D2', 102, 200, { gold: 40 * T12, iron: 750e9, troop: { carriage: 250e3 } })];
    let cs = mk();
    const out = march(cs[2], cs[0], C.MISSION.transport, { resource: { gold: 1e9 } });
    let p = plan(cs[0], cs, LAYER, { skills: L10, selfArmys: [out] }).plan;
    assert.strictEqual(p.actions.length, 1, p.note);
    assert.deepStrictEqual([p.actions[0].from.name, Object.keys(p.actions[0].resources)], ['D1', ['iron']], p.note);
    // the iron at its 100b step and gold at its 10t step: the emptier goes first
    cs = mk();
    cs[0].resource.iron.amount = 90e9;               // 90% of 100b; gold 5.9t is 59% of 10t
    p = plan(cs[0], cs, LAYER, { skills: L10, selfArmys: [march(cs[2], cs[0], C.MISSION.transport)] }).plan;
    assert.deepStrictEqual(Object.keys(p.actions[0].resources), ['gold'], p.note);
  });

  // ================================================ /maxdist on push lines
  console.log('\n/maxdist on keep and send lines\n');

  await t('a keep line passes over a receiver past /maxdist', () => {
    const here = city('H', 100, 200, { food: 5e9, troop: { carriage: 250e3 } });
    const near = city('N', 110, 200, { food: 0 });
    const far = city('F', 200, 200, { food: 0 });
    const game = fakeGame([here, near, far]);
    Object.assign(game, L10);
    const push = (src) => {
      const parsed = parseGoals(src);
      assert.deepStrictEqual(parsed.errors, []);
      return T.plans.push({ castle: here, goals: parsed.goals, config: parsed.config, goalsOf: () => [], selfArmies: [] }, {}, game);
    };
    let p = push('keepresources any f:1b');
    assert.deepStrictEqual(p.actions.map((a) => a.to.name), ['N', 'F'], p.note);

    p = push('keepresources any f:1b /50');
    assert.deepStrictEqual(p.actions.map((a) => a.to.name), ['N'], p.note);
    has(p.note, "F is 100.0 tiles away, past this line's /maxdist:50");

    // sendresources reads it the same way
    p = push('sendresources any food 1b * * * /maxdist:5');
    assert.strictEqual(p.actions.length, 0, p.note);
    has(p.note, "N is 10.0 tiles away, past this line's /maxdist:5");
  });

  // ============================================================== food cap
  console.log('\nfood never past 950b in a city\n');

  await t('a request never fills food past 950b, counting what is on its way', () => {
    const f = fleet({ fla: { food: 949.5e9 }, five: { troop: { carriage: 250e3 }, food: 3000e9 } });
    const line = 'requestresources 5 food 2000b 1b * * t';
    let p = plan(f.fla, Object.values(f), line, { skills: L10, own: { 5: '', 8: '', 9: '' } }).plan;
    assert.strictEqual(food(p.actions[0]), 500e6);
    // 900b home and 50b on its way: no room at all
    f.fla.resource.food.amount = 900e9;
    const coming = march(f.eight, f.fla, C.MISSION.transport, { resource: { food: 50e9 } });
    p = plan(f.fla, Object.values(f), line, { skills: L10, own: { 5: '', 8: '', 9: '' }, selfArmys: [coming] }).plan;
    assert.strictEqual(p.actions.length, 0);
    has(p.note, 'held — food never goes past 950b in a city (it resets to 0 at 1t)');
  });

  await t('the stepped food layer and the old 1b line together never pass 950b', () => {
    const src = 'requestresources any food 1b 2b 100m 500m t\nrequestresources any food 400b 400b 100m * t /steps:10b,100b';
    for (const have of [0, 5e9, 50e9, 399.9e9, 400e9, 949e9, 950e9, 1000e9]) {
      const cs = [city('F0', 100, 200, { food: have, troop: { carriage: 250e3 } }), city('F1', 101, 200, { food: 5000e9, troop: { carriage: 250e3 } })];
      const { plan: p } = plan(cs[0], cs, src, { skills: L10 });
      const got = p.actions.reduce((t2, a) => t2 + (a.resources.food || 0), 0);
      assert.ok(have + got <= Math.max(have, 950e9), `${have} + ${got} passes 950b`);
      if (have >= 400e9) assert.strictEqual(got, 0, `${have}: nothing more`);
      assert.ok(have + got <= Math.max(have, 400e9), `${have} + ${got} passes the 400b line`);
    }
  });

  await t('a keep/send line never fills a city of ours past 950b food either', () => {
    const here = city('H', 100, 200, { food: 1500e9, troop: { carriage: 250e3 } });
    const near = city('N', 101, 200, { food: 949.9e9 });
    const game = fakeGame([here, near]);
    Object.assign(game, L10);
    const parsed = parseGoals('keepresources any f:500b');
    const p = T.plans.push({ castle: here, goals: parsed.goals, config: parsed.config, goalsOf: () => [], selfArmies: [] }, {}, game);
    assert.strictEqual(p.actions.length, 1, p.note);
    assert.strictEqual(food(p.actions[0]), 100e6);
    near.resource.food.amount = 950e9;
    const q = T.plans.push({ castle: here, goals: parsed.goals, config: parsed.config, goalsOf: () => [], selfArmies: [] }, {}, game);
    assert.strictEqual(q.actions.length, 0, q.note);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(path.dirname(process.env.EVONY_DB), { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
