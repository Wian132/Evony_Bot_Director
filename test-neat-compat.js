'use strict';
// Pasted NEAT goal lines mean what the NEAT wiki says they mean (Step 9):
//   * requestresources / requesttroops in NEAT's order and semantics, and the
//     migration of lines saved in this tool's old order (proved line-for-line
//     against the old implementation, read out of git at b5620e9)
//   * one troop / fortification / resource word table for every goal parser
//   * k/m numbers in gatepolicy and hidingpolicy switches
//   * bare-line war config names ("wartown 1") read as config
//   * every config key the NEAT wiki documents is accepted
// No network, no login; the database is a throwaway file.
//
//   node test-neat-compat.js
const assert = require('assert');
const path = require('path'), os = require('os'), fs = require('fs');
const { execFileSync } = require('child_process');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-neat-')), 't.db');

const C = require('./constants');
const T = require('./goal-transfer');
const W = require('./goal-war');
const NPC = require('./goal-npc');
const G = require('./goals');
const { parseGoals, describe } = G;
const MIG = require('./migrate-goals-transfer');
const { Game } = require('./game');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok    ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
}
const has = (s, sub) => assert.ok(String(s).includes(sub), `"${s}" does not contain "${sub}"`);
const clean = (src) => {
  const p = parseGoals(src);
  assert.deepStrictEqual(p.errors, [], `${src}\n  should parse cleanly`);
  return p;
};

// ------------------------------------------------------------------ fixtures
// Lord02's cities where they are (the same fixture as test-transfer.js).
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
    sent: [],
    castleId: (c) => c.castleId,
    castleXY: (c) => C.fieldIdToCoords(c.fieldId),
    now: () => Date.now(),
    req: async () => ({ ok: 1 }),
    buildArmyBean: (o) => Game.prototype.buildArmyBean.call(g, o),
    newArmy: async (castleId, bean) => { g.sent.push({ castleId, bean }); return { ok: 1 }; },
  };
  return g;
}
const march = (from, to, missionType, extra = {}) => ({
  startFieldId: from.fieldId, targetFieldId: to.fieldId, missionType, direction: 1,
  startTime: Date.now() - 60000, troop: {}, resource: {}, ...extra,
});
function plan(here, castles, src, { selfArmys = [], own = {} } = {}) {
  const game = fakeGame(castles, selfArmys);
  const parsed = parseGoals(src);
  const goalsOf = (c) => (own[c.name] !== undefined ? parseGoals(own[c.name]).goals : parsed.goals);
  const ctx = { castle: here, goals: parsed.goals, config: parsed.config, goalsOf, selfArmies: selfArmys };
  return { plan: T.plans.transfer(ctx, {}, game), game, parsed };
}
const res = (a, k) => (a && a.resources ? a.resources[k] : undefined);
const req = (src) => clean(src).goals[0];

// The goal texts saved for Lord02 (account a2, live-goals.txt): four
// cities with all five lines, one more city likewise, and "default" with four.
const A2_CITY = `// requestresources <donor> <type> <min> <max> <batch> <keep>
//   pull when this city drops below <min>, top up toward <max>, at most
//   <batch> per run, and never take a donor below <keep>.
requestresources any gold 1000000 2000000 500000 200000
requestresources any wood 100000 2000000 500000 200000
requestresources any stone 5000000 50000000 5000000 10000000
requestresources any iron 50000000 500000000 20000000 100000000
requestresources any food 500000000 5000000000 50000000 1000000000
traininghero OTTO 30 60`;
const A2_DEFAULT = `// requestresources <donor> <type> <min> <max> <batch> <keep>
requestresources any wood 100000 2000000 500000 200000
requestresources any stone 5000000 50000000 5000000 10000000
requestresources any iron 50000000 500000000 20000000 100000000
requestresources any food 500000000 5000000000 50000000 1000000000`;
const A2_ROWS = { 100269294: A2_CITY, 86248876: A2_CITY, 86249877: A2_CITY, 86250106: A2_CITY, 86250719: A2_CITY, default: A2_DEFAULT };

// The implementation this step replaced, straight out of git, so "behaves as
// before" is checked against the real thing and not a copy of it.
const scratch = [];
function oldTransfer() {
  const src = execFileSync('git', ['show', 'b5620e9:goal-transfer.js'], { cwd: __dirname, encoding: 'utf8' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-old-transfer-'));
  scratch.push(dir);
  const file = path.join(dir, 'goal-transfer-b5620e9.js');
  fs.writeFileSync(file, src.replace(/require\('\.\/(constants|rally)'\)/g,
    (_, name) => `require(${JSON.stringify(path.join(__dirname, name))})`));
  return require(file);
}
// the old parser's goal objects, the way parseGoals built them
function oldGoals(OLD, src) {
  const out = [];
  String(src).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/^\s*(\/\/|#).*$/, '').trim();
    if (!line) return;
    const tok = line.split(/\s+/);
    const name = tok[0].toLowerCase();
    if (!OLD.parsers[name]) return;
    const parsed = OLD.parsers[name].parse(tok.slice(1));
    assert.deepStrictEqual(parsed.errors, [], `the old parser refused ${line}`);
    delete parsed.errors;
    out.push({ name, kind: 'directive', line: i + 1, raw: line, ...parsed });
  });
  return out;
}

(async () => {
  // ====================================================== the wiki's examples
  console.log('\nrequestresources / requesttroops: the wiki\'s own lines\n');

  await t('requestresources any food 100m 1b 50m 100m: local, remote, min and max batch', () => {
    const g = req('requestresources any food 100m 1b 50m 100m');
    assert.deepStrictEqual([g.target, g.type, g.local, g.remote, g.minBatch, g.maxBatch, g.carrier, g.slots, g.ok],
      ['any', 'food', 100e6, 1e9, 50e6, 100e6, 'carriage', 1, true]);
    assert.strictEqual(g.below, undefined, 'no /below: a plain NEAT line');
  });

  await t('requestresources !HubCity wood 25m 40m 5m * cavalry: * max batch, cavalry carries', () => {
    const g = req('requestresources !HubCity wood 25m 40m 5m * cavalry');
    assert.deepStrictEqual([g.target, g.type, g.local, g.remote, g.minBatch, g.maxBatch, g.carrier],
      ['!HubCity', 'wood', 25e6, 40e6, 5e6, null, 'lightCavalry']);
  });

  await t('requesttroops any archer 200k 300k 10k 100k and !WarCity scout 1m 10m 50k 100k', () => {
    const a = req('requesttroops any archer 200k 300k 10k 100k');
    assert.deepStrictEqual([a.troop, a.local, a.remote, a.minBatch, a.maxBatch], ['archer', 200e3, 300e3, 10e3, 100e3]);
    const s = req('requesttroops !WarCity scout 1m 10m 50k 100k');
    assert.deepStrictEqual([s.target, s.troop, s.local, s.remote, s.minBatch, s.maxBatch], ['!WarCity', 'scouter', 1e6, 10e6, 50e3, 100e3]);
  });

  await t('/slots=3 before the line or /slots:2 after it', () => {
    assert.strictEqual(req('requestresources /slots=3 any food 100m 1b 50m 100m').slots, 3);
    const g = req('requestresources any food 100m 1b 50m 100m /slots:2');
    assert.deepStrictEqual([g.slots, g.local, g.maxBatch], [2, 100e6, 100e6]);
  });

  await t('one batch number is the MAXIMUM batch, not the minimum', () => {
    const g = req('requestresources any food 100m 1b 50m');
    assert.deepStrictEqual([g.minBatch, g.maxBatch], [null, 50e6]);
    const r = req('requesttroops any archer 200k 300k 10k');
    assert.deepStrictEqual([r.minBatch, r.maxBatch], [null, 10e3]);
  });

  await t('the city, the type, localAmount and remoteAmount are required; the line then does not run', () => {
    const p = parseGoals('requestresources any food 100m');
    has(p.errors[0].error, 'localAmount and remoteAmount are required');
    assert.strictEqual(p.goals[0].ok, false);
    const f = fleet();
    const run = plan(f.fla, Object.values(f), 'requestresources any food 100m').plan;
    assert.strictEqual(run.actions.length, 0);
    has(run.note, 'line 1 not run — it has errors');
  });

  await t('mistakes are errors, never guesses: bad amounts, a bad carrier, too many batches, min over max', () => {
    const e = (src) => parseGoals(src).errors.map((x) => x.error).join(' | ');
    has(e('requestresources any food 100m lots'), 'remoteAmount "lots" is not an amount');
    has(e('requestresources any food 100m 1b 50m 100m dragons'), 'unknown troop "dragons"');
    has(e('requestresources any food 100m 1b 1m 2m 3m'), 'at most two');
    has(e('requestresources any food 100m 1b 100m 50m'), 'minBatch 100m is more than maxBatch 50m');
    has(e('requestresources any rubies 100m 1b'), 'unknown resource "rubies"');
    has(e('requesttroops any archer 200k 300k 10k 100k cavalry'), '"cavalry" is not an amount');
    has(e('requestresources any food 100m 1b /keep:5'), 'unknown switch /keep');
    has(e('requestresources any food 100m 1b /below:soon'), '/below needs an amount');
    for (const src of ['requestresources any food 100m lots', 'requestresources any food 100m 1b 100m 50m']) {
      assert.strictEqual(parseGoals(src).goals[0].ok, false, src);
    }
  });

  await t('several cities joined by |; the wiki\'s !Name is just Name (it cannot exclude)', () => {
    const f = fleet();
    // the wiki's own line: request food from WarCity|HubCity|FarmCity, scouts carry it
    const war = city('WarCity', 480, 610, { food: 500e6, troop: { scouter: 400000 } });
    const hub = city('HubCity', 470, 600, { food: 500e6 });
    const farm = city('FarmCity', 560, 700, { food: 500e6 });
    const p = plan(f.fla, [f.fla, war, hub, farm], 'requestresources !WarCity|!HubCity|!FarmCity food 10m 20m 1m 1m s', {
      own: { WarCity: '', HubCity: '', FarmCity: '' },
    }).plan;
    // Fla holds 100m: not under 10m, nothing asked
    assert.strictEqual(p.actions.length, 0);
    const low = fleet({ fla: { food: 5e6 } }).fla;
    const q = plan(low, [low, war, hub, farm], 'requestresources !WarCity|!HubCity|!FarmCity food 10m 20m 1m 1m s', {
      own: { WarCity: '', HubCity: '', FarmCity: '' },
    }).plan;
    assert.strictEqual(q.actions.length, 1);
    const a = q.actions[0];
    assert.strictEqual(a.from.name, 'WarCity', 'the nearest of the three that can send it all');
    assert.deepStrictEqual([res(a, 'food'), a.troops], [1e6, { scouter: 1e6 / 5 }], 'scouts carry 5 each');
    const pool = T._internals.sendersFor('!WarCity|!HubCity', [war, hub, farm, f.five], fakeGame([]));
    assert.deepStrictEqual(pool.map((c) => c.name), ['WarCity', 'HubCity']);
  });

  // ====================================================== the wiki's rules
  console.log('\nthe wiki\'s rules, one by one\n');

  const ANY_FOOD = 'requestresources any food 100m 1b 50m 100m';

  await t('"You must have BELOW this amount": at or over localAmount nothing is asked', () => {
    const f = fleet();
    assert.strictEqual(plan(f.fla, Object.values(f), ANY_FOOD).plan.actions.length, 0, 'Fla holds exactly 100m');
    has(plan(f.fla, Object.values(f), ANY_FOOD).plan.note, 'nothing short');
  });

  await t('"will not put the requesting city above the local amount": only the room under it is sent', () => {
    const f = fleet({ fla: { food: 70e6 } });
    const p = plan(f.fla, Object.values(f), 'requestresources any food 100m 1b').plan;
    assert.strictEqual(res(p.actions[0], 'food'), 30e6);
  });

  await t('no batch sizes: as much as keeps both amounts right', () => {
    const f = fleet({ fla: { food: 0 }, five: { food: 1.2e9, troop: { carriage: 30000 } } });
    const p = plan(f.fla, [f.fla, f.five], 'requestresources any food 100m 1b').plan;
    assert.strictEqual(res(p.actions[0], 'food'), 100e6, 'all the room there is; 5 has 200m over its 1b');
  });

  await t('a minimum batch that would overfill the city waits', () => {
    const f = fleet({ fla: { food: 60e6 } });           // room 40m, minimum 50m
    const p = plan(f.fla, Object.values(f), ANY_FOOD).plan;
    assert.strictEqual(p.actions.length, 0);
    has(p.note, 'waiting — only 40m fits under 100m, the minimum batch is 50m');
  });

  await t('critically low (50% or less of localAmount) ignores the minimum batch', () => {
    const f = fleet({ fla: { food: 50e6 } });           // exactly half: critical
    const p = plan(f.fla, Object.values(f), 'requestresources any food 100m 1b 60m 100m').plan;
    assert.strictEqual(res(p.actions[0], 'food'), 50e6, 'room is 50m, under the 60m minimum, sent anyway');
    has(p.note, '(critically low)');
    const g = fleet({ fla: { food: 50.1e6 } });         // just over half: waits
    assert.strictEqual(plan(g.fla, Object.values(g), 'requestresources any food 100m 1b 60m 100m').plan.actions.length, 0);
  });

  await t('"will not put the sending city below the remote amount", and a sender short of the minimum batch waits', () => {
    const f = fleet({ fla: { food: 60e6 } });
    const line = 'requestresources 5 food 100m 1b 20m 100m';
    // 5 holds 1.01b: 10m over its 1b keep, under the 20m minimum
    let p = plan(f.fla, [f.fla, { ...f.five, resource: { ...f.five.resource, food: { amount: 1.01e9 } } }], line).plan;
    assert.strictEqual(p.actions.length, 0);
    has(p.note, '5 can send 10m, under the 20m minimum batch');
    // at 1.05b it has 50m over; 40m fits here
    p = plan(f.fla, [f.fla, { ...f.five, resource: { ...f.five.resource, food: { amount: 1.05e9 } } }], line).plan;
    assert.strictEqual(res(p.actions[0], 'food'), 40e6);
    // critically low: the 10m it can spare goes
    const low = fleet({ fla: { food: 30e6 } });
    p = plan(low.fla, [low.fla, { ...low.five, resource: { ...low.five.resource, food: { amount: 1.01e9 } } }], line).plan;
    assert.strictEqual(res(p.actions[0], 'food'), 10e6);
  });

  await t('what is already on its way counts before anything is asked', () => {
    const f = fleet({ fla: { food: 40e6 } });
    const going = march(f.nine, f.fla, C.MISSION.transport, { resource: { food: 55e6 } });
    // 40m + 55m coming = 95m: only 5m of room, under the 50m minimum
    const p = plan(f.fla, Object.values(f), ANY_FOOD, { selfArmys: [going] }).plan;
    assert.strictEqual(p.actions.length, 0);
    has(p.note, 'food 40m + 55m coming < 100m: waiting');
  });

  await t('* for localAmount sends whatever the city holds; * for remoteAmount lets a sender give all it has', () => {
    const f = fleet({ fla: { food: 5e9 }, five: { food: 3e9, troop: { carriage: 30000 } } });
    const p = plan(f.fla, [f.fla, f.five], 'requestresources 5 food * 1b 10m 100m').plan;
    assert.strictEqual(res(p.actions[0], 'food'), 100e6, 'Fla holds 5b and still asks, up to maxBatch');
    const g = fleet({ fla: { food: 0 }, five: { food: 30e6, troop: { carriage: 20000 } } });
    const q = plan(g.fla, [g.fla, g.five], 'requestresources 5 food 100m *', { own: { 5: '' } }).plan;
    assert.strictEqual(res(q.actions[0], 'food'), 30e6, '5 keeps nothing back');
  });

  await t('one mission per sender and city unless /slots, as the wiki says', () => {
    const f = fleet({ fla: { food: 0 } });
    const out = march(f.five, f.fla, C.MISSION.transport, { direction: 2 });
    let p = plan(f.fla, Object.values(f), ANY_FOOD, { selfArmys: [out] }).plan;
    assert.strictEqual(p.actions.length, 0);
    has(p.note, 'waiting for 5');
    p = plan(f.fla, Object.values(f), `${ANY_FOOD} /slots:2`, { selfArmys: [out] }).plan;
    assert.deepStrictEqual([p.actions[0].from.name, p.actions[0].rally.pairLimit], ['5', 2]);
  });

  await t('another troop type carries: cavalry, with a quarter held back and its load of 100 each', async () => {
    const hub = city('HubCity', 486, 620, { wood: 100e6, troop: { carriage: 0, lightCavalry: 100000 } });
    const f = fleet({ fla: { wood: 0 } });
    const { plan: p, game } = plan(f.fla, [f.fla, hub], 'requestresources !HubCity wood 25m 40m 5m * cavalry', { own: { HubCity: '' } });
    const a = p.actions[0];
    // 100k cavalry, 2,000 stay home (a quarter, at most 2,000): 98k x 100 = 9.8m
    assert.deepStrictEqual([res(a, 'wood'), a.troops, a.carriages], [9.8e6, { lightCavalry: 98000 }, 0]);
    has(a.label, '98,000 Cavalry');
    await T.executors.transport(game, f.fla, a);
    assert.deepStrictEqual([game.sent[0].bean.troops.lightCavalry, game.sent[0].bean.troops.carriage, game.sent[0].bean.resource.wood],
      [98000, 0, 9.8e6]);
  });

  await t('two carriers from one sender still ride in one march', () => {
    const hub = city('HubCity', 486, 620, { wood: 100e6, food: 5e9, troop: { carriage: 100, lightCavalry: 1000 } });
    const f = fleet({ fla: { wood: 0, food: 0 } });
    const p = plan(f.fla, [f.fla, hub], 'requestresources HubCity food 100m 1b\nrequestresources HubCity wood 25m 40m * * cav', { own: { HubCity: '' } }).plan;
    assert.strictEqual(p.actions.length, 1);
    const a = p.actions[0];
    assert.deepStrictEqual(a.resources, { food: 75 * 5000, wood: 750 * 100 });
    assert.deepStrictEqual(a.troops, { carriage: 75, lightCavalry: 750 });
    assert.deepStrictEqual(a.rally.troops, a.troops);
  });

  await t('requesttroops any archer 200k 300k 10k 100k: batches, sender keep, critical', () => {
    const line = 'requesttroops any archer 200k 300k 10k 100k';
    const mk = (have, sender) => {
      const f = fleet({ fla: { troop: { archer: have } }, eight: { troop: { archer: sender } } });
      return plan(f.fla, [f.fla, f.eight], line).plan;
    };
    let p = mk(150e3, 500e3);
    assert.deepStrictEqual([p.actions[0].kind, p.actions[0].troops], ['reinforceTroops', { archer: 50e3 }]);
    p = mk(195e3, 500e3);                      // 5k of room, under the 10k minimum
    assert.strictEqual(p.actions.length, 0);
    has(p.note, 'waiting — only 5k fits under 200k');
    p = mk(90e3, 500e3);                       // max batch caps it
    assert.deepStrictEqual(p.actions[0].troops, { archer: 100e3 });
    p = mk(150e3, 305e3);                      // 8 keeps 300k: 5k spare, under the minimum
    assert.strictEqual(p.actions.length, 0);
    p = mk(99e3, 305e3);                       // critically low: the 5k goes
    assert.deepStrictEqual(p.actions[0].troops, { archer: 5e3 });
    p = mk(200e3, 900e3);                      // not below 200k: nothing
    assert.strictEqual(p.actions.length, 0);
  });

  // ============================================= /below keeps the old meaning
  console.log('\n/below: the old trigger as an OTTObot switch\n');

  await t('/below starts the request only under it, then fills to localAmount', () => {
    const line = 'requestresources any food 5b 1b * 50m /below:500m';
    let f = fleet({ fla: { food: 600e6 } });
    assert.strictEqual(plan(f.fla, Object.values(f), line).plan.actions.length, 0, 'over /below: nothing yet');
    f = fleet({ fla: { food: 100e6 } });
    const p = plan(f.fla, Object.values(f), line).plan;
    assert.strictEqual(res(p.actions[0], 'food'), 50e6);
    has(p.note, 'food 100m < 500m: 50m from 5');
    has(describe(clean(line)).join('\n'), 'starting only under 500,000,000');
  });

  await t('a sender is never taken below its own trigger (its /below, else its localAmount)', () => {
    const f = fleet({ five: { gold: 1.1e6 } });
    const line = 'requestresources 5 gold 2m 200k * 500k /below:1m';
    let p = plan(f.fla, Object.values(f), line).plan;              // 5 has the same line
    assert.strictEqual(p.actions[0].resources.gold, 100e3, 'only what is over its own 1m');
    p = plan(f.fla, Object.values(f), line, { own: { 5: 'requestresources 8 gold 1.05m 0' } }).plan;
    assert.strictEqual(p.actions[0].resources.gold, 50e3, 'a NEAT line on 5 triggers at its localAmount');
    p = plan(f.fla, Object.values(f), line, { own: { 5: 'requestresources 8 gold 5m 0 /below:*' } }).plan;
    assert.strictEqual(p.actions[0].resources.gold, 500e3, '/below:* is no level of its own: only remoteAmount holds');
  });

  // ============================================================ the migration
  console.log('\nmigrate-goals-transfer.js\n');

  await t('the mapping: <min> <max> <batch> <keep> -> <max> <keep> * <batch> /below:<min>', () => {
    const m = (s) => MIG.migrateLine(s).text;
    assert.strictEqual(m('requestresources any food 500m 5b 50m 1b'), 'requestresources any food 5b 1b * 50m /below:500m');
    assert.strictEqual(m('requesttroops any archer 100k 200k 50k 10k'), 'requesttroops any archer 200k 10k * 50k /below:100k');
    assert.strictEqual(m('requestresources !HubCity|484,619 food * 1b * 100m t /slots:3'),
      'requestresources !HubCity|484,619 food 1b 100m * * t /below:* /slots:3');
    assert.strictEqual(m('  RequestResources 5 gold 1m 2m 500k 200k /slots=2'), '  RequestResources 5 gold 2m 200k * 500k /below:1m /slots=2');
    assert.strictEqual(m('// requestresources <donor> <type> <min> <max> <batch> <keep>'),
      '// requestresources <donor> <type> <max> <keep> * <batch> /below:<min>');
    assert.strictEqual(m('# requesttroops any scout 1 2 3 4'), '# requesttroops any scout 2 4 * 3 /below:1');
  });

  await t('it leaves alone what is not an old-order line, and running it twice changes nothing', () => {
    const skip = (s) => MIG.migrateLine(s);
    for (const s of ['requestresources any food 100m 1b', 'requestresources any food 1m 2m 1m 1m cavalry',
      'requestresources any food 1m 2m 3m 4m /keep:1', 'requestresources any food 5b 1b * 50m /below:500m',
      '// requestresources are handy', 'troop a:1', '<p> requestresources any food 1 2 3 4']) {
      const r = skip(s);
      assert.strictEqual(r.changed, false, s);
      assert.strictEqual(r.text, s);
    }
    const once = MIG.migrateText(A2_CITY);
    const twice = MIG.migrateText(once.src);
    assert.deepStrictEqual(twice.changes, []);
    assert.strictEqual(twice.src, once.src);
    assert.strictEqual(MIG.migrateText('a\r\nrequesttroops any s 1 2 3 4\r\n').src, 'a\r\nrequesttroops any s 2 4 * 3 /below:1\r\n');
  });

  await t('the 29 live lines of account a2, before and after', () => {
    let n = 0;
    const after = {};
    for (const [key, src] of Object.entries(A2_ROWS)) {
      const r = MIG.migrateText(src);
      n += r.changes.filter((c) => !/^\/\//.test(c.before)).length;
      assert.deepStrictEqual(r.skipped, [], key);
      after[key] = r.src;
      clean(r.src);
    }
    assert.strictEqual(n, 29);
    assert.strictEqual(after.default.split('\n').filter((l) => l.startsWith('requestresources')).join('\n'), [
      'requestresources any wood 2000000 200000 * 500000 /below:100000',
      'requestresources any stone 50000000 10000000 * 5000000 /below:5000000',
      'requestresources any iron 500000000 100000000 * 20000000 /below:50000000',
      'requestresources any food 5000000000 1000000000 * 50000000 /below:500000000',
    ].join('\n'));
    has(after[100269294], 'requestresources any gold 2000000 200000 * 500000 /below:1000000');
    has(after[100269294], '// requestresources <donor> <type> <max> <keep> * <batch> /below:<min>');
  });

  await t('unmigrated, the old lines read NEAT\'s way: gold and wood refuse to run, the rest fill only to the old <min>', () => {
    const p = parseGoals(A2_CITY);
    assert.deepStrictEqual(p.errors.map((e) => e.text.split(' ')[2]), ['gold', 'wood'], 'minBatch over maxBatch: 500k > 200k');
    const by = Object.fromEntries(p.goals.filter((g) => g.name === 'requestresources').map((g) => [g.type, g]));
    assert.deepStrictEqual([by.gold.ok, by.wood.ok, by.stone.ok, by.iron.ok, by.food.ok], [false, false, true, true, true]);
    // old <min> <max> <batch> <keep> read as local remote minBatch maxBatch:
    // fill to the old min, senders keep the old max, batches old batch..keep
    assert.deepStrictEqual([by.food.local, by.food.remote, by.food.minBatch, by.food.maxBatch], [500e6, 5e9, 50e6, 1e9]);
    // iron: Fla fills to 50m (not 500m); 5 and 8 hold 300m, under the 500m a
    // sender now keeps (it was 100m), so 9 sends the 49m of room in one go
    const f = fleet({ fla: { iron: 1e6 } });
    const q = plan(f.fla, Object.values(f), 'requestresources any iron 50000000 500000000 20000000 100000000').plan;
    assert.deepStrictEqual([q.actions[0].from.name, res(q.actions[0], 'iron')], ['9', 49e6]);
  });

  await t('after the migration every line does exactly what it did before (old code from git, 600 random fleets)', () => {
    const OLD = oldTransfer();
    const TEXTS = [
      A2_CITY, A2_DEFAULT,
      'requestresources 5|8 food * 2b 100m 500m t /slots:2\nrequesttroops any archer 100k 200k 50k 10k\nrequesttroops any scout 50k 80k 40k *',
      'requestresources 484,619|9 wood 1m * 200k 0\nrequestresources any iron 50m 500m * *\nrequesttroops !8 cav 1k 5k 1k 0 /slots:2',
      'requestresources any food 500m 5b 50m 1b\nrequestresources any food 1b 3b 200m 2b',
    ];
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const amounts = (base) => pick([0, 0.2, 0.5, 0.99, 1, 1.01, 1.5, 3, 12]) * base;
    const view = (p) => (p ? {
      note: p.note,
      actions: p.actions.map((a) => ({
        kind: a.kind, from: a.from.name, to: a.to.name, resources: a.resources, troops: a.kind === 'transport' ? a.rally.troops : a.troops,
        carriages: a.carriages, pairLimit: a.rally.pairLimit, label: a.label,
      })),
    } : p);
    let compared = 0, acted = 0;
    for (let trial = 0; trial < 600; trial++) {
      const names = ['Fla', '9', '8', '5', 'X'];
      const at = [[484, 619], [571, 648], [489, 678], [485, 617], [480, 610]];
      const castles = names.map((name, i) => city(name, at[i][0], at[i][1], {
        food: amounts(1e9), wood: amounts(1e6), stone: amounts(20e6), iron: amounts(200e6), gold: amounts(1e6),
        troop: { carriage: pick([0, 3, 100, 1000, 20000, 60000]), archer: amounts(100e3), scouter: amounts(50e3), lightCavalry: amounts(3e3) },
        rally: pick([null, 1, 2, 10, 10]),
        ...(rnd() < 0.2 ? { transingTrades: [{ resType: pick([0, 1, 2, 3]), amount: amounts(50e6) }] } : {}),
      }));
      const armies = [];
      for (let k = Math.floor(rnd() * 4); k > 0; k--) {
        const a = pick(castles), b = pick(castles);
        armies.push(march(a, b, pick([C.MISSION.transport, C.MISSION.reinforce, C.MISSION.attack]), {
          direction: pick([1, 1, 2]), resource: { food: amounts(50e6), wood: amounts(1e6) }, troop: { archer: amounts(20e3) },
        }));
      }
      const textOf = Object.fromEntries(names.map((nm) => [nm, rnd() < 0.15 ? '' : pick(TEXTS)]));
      const here = pick(castles);
      const src = textOf[here.name] || pick(TEXTS);
      const migrated = Object.fromEntries(Object.entries(textOf).map(([k, v]) => [k, MIG.migrateText(v).src]));

      const oldCtx = {
        castle: here, goals: oldGoals(OLD, src), config: {}, selfArmies: armies,
        goalsOf: (c) => oldGoals(OLD, c === here ? src : textOf[c.name]),
      };
      const newSrc = MIG.migrateText(src).src;
      const newCtx = {
        castle: here, goals: clean(newSrc).goals, config: {}, selfArmies: armies,
        goalsOf: (c) => parseGoals(c === here ? newSrc : migrated[c.name]).goals,
      };
      const before = view(OLD.plans.transfer(oldCtx, {}, fakeGame(castles, armies)));
      const after = view(T.plans.transfer(newCtx, {}, fakeGame(castles, armies)));
      assert.deepStrictEqual(after, before, `trial ${trial}: ${here.name}\n${src}`);
      compared++;
      if (before && before.actions.length) acted++;
    }
    assert.ok(acted > 100, `only ${acted} of ${compared} trials sent anything — the fixtures are too quiet to prove much`);
    console.log(`        (${compared} fleets compared, ${acted} of them sending something)`);
  });

  await t('the migration script: dry run writes nothing, --apply writes and backs up (temp database)', () => {
    const D = require('./db');
    for (const [key, src] of Object.entries(A2_ROWS)) D.goals.set('a2', key, 'goal', src);
    D.goals.set('a1', 'default', 'goal', 'troop b:5k,t:5k\nfortification ab:5000');
    const log = [];
    const real = console.log;
    console.log = (s = '') => log.push(String(s));
    try { MIG.main([]); } finally { console.log = real; }
    assert.strictEqual(D.goals.find('a2', ['default']).src, A2_DEFAULT, 'a dry run changed the database');
    has(log.join('\n'), '29 goal line(s) to rewrite in 6 goal text(s), 0 left alone.');
    has(log.join('\n'), 'before: requestresources any food 500000000 5000000000 50000000 1000000000');
    has(log.join('\n'), 'after:  requestresources any food 5000000000 1000000000 * 50000000 /below:500000000');
    log.length = 0;
    console.log = (s = '') => log.push(String(s));
    try { MIG.main(['--apply', '--account', 'a2']); } finally { console.log = real; }
    has(D.goals.find('a2', ['86250719']).src, 'requestresources any iron 500000000 100000000 * 20000000 /below:50000000');
    assert.strictEqual(D.goals.find('a1', ['default']).src, 'troop b:5k,t:5k\nfortification ab:5000');
    const backup = log.join('\n').match(/backup of 6 row\(s\): (.+)$/m);
    assert.ok(backup, log.join('\n'));
    assert.strictEqual(JSON.parse(fs.readFileSync(backup[1], 'utf8')).length, 6);
    log.length = 0;
    console.log = (s = '') => log.push(String(s));
    try { MIG.main(['--apply']); } finally { console.log = real; }
    has(log.join('\n'), '0 goal line(s) to rewrite in 0 goal text(s), 0 left alone, 35 already in the new order.');
  });

  // ================================================================ aliases
  console.log('\none word table for every parser\n');

  await t('every troop word reads the same in troop, npctroops, npclimits, requesttroops and hidingpolicy /keep', () => {
    let n = 0;
    for (const [key, words] of Object.entries(C.TROOP_WORDS)) {
      for (const w of words) for (const spelt of [w, w.toUpperCase()]) {
        const p = clean(`troop ${spelt}:5\nnpctroops 5 ${spelt}:5\nnpclimits 6 ${spelt}:5\nrequesttroops any ${spelt} 1k 2k`);
        assert.deepStrictEqual(p.goals[0].troops, { [key]: 5 }, `troop ${spelt}`);
        assert.deepStrictEqual(p.goals[1].troops, { [key]: 5 }, `npctroops ${spelt}`);
        assert.deepStrictEqual(p.goals[2].troops, { [key]: 5 }, `npclimits ${spelt}`);
        assert.strictEqual(p.goals[3].troop, key, `requesttroops ${spelt}`);
        const h = W.parsers.hidingpolicy.parse([`/keep:${spelt}:5`]);
        assert.deepStrictEqual([h.keep, h.errors], [{ [key]: 5 }, []], `/keep ${spelt}`);
        n++;
      }
    }
    assert.ok(n >= 120, `${n} spellings`);
  });

  await t('NEAT\'s own troop lines: the wiki\'s Troop examples and !NewCityGoals.txt', () => {
    const p = clean([
      'troop a:100000,b:5000,t:5000,warr:15000,wo:5000,p:5000,sw:5000,s:5000,cav:1000,cata:1000,ram:5,cp:5',
      'troop a:1,warr:1,wo:1,p:1,sw:1,cav:1,cata:1,ram:1,cp:1,s:1',
      'troop ball:1,balls:2,pult:3,cat:4,phract:5,br:6,transporters:7,Workers:8,Pikemen:9,Catapults:10',
    ].join('\n'));
    assert.deepStrictEqual(p.goals[0].troops, {
      archer: 100000, ballista: 5000, carriage: 5000, militia: 15000, peasants: 5000, pikemen: 5000,
      swordsmen: 5000, scouter: 5000, lightCavalry: 1000, heavyCavalry: 1000, batteringRam: 5, catapult: 5,
    });
    assert.deepStrictEqual(p.goals[2].troops, {
      ballista: 2, catapult: 10, heavyCavalry: 5, batteringRam: 6, carriage: 7, peasants: 8, pikemen: 9,
    });
    assert.strictEqual(C.troopByWord('cata').key, 'heavyCavalry', 'cata is the cataphract');
    assert.strictEqual(C.troopByWord('cat').key, 'catapult', 'cat is the catapult');
    assert.strictEqual(C.troopByWord('ws'), null, 'short words never lose an s');
    has(parseGoals('troop zz:5').errors[0].error, 'unknown troop code "zz"');
  });

  await t('every fortification word, NEAT\'s examples, and trebuchet = Rock Fall (type 18)', () => {
    for (const [code, words] of Object.entries(C.FORT_WORDS)) {
      for (const w of words) {
        assert.deepStrictEqual(clean(`fortification ${w}:5`).goals[0].forts, { [code]: 5 }, w);
        assert.deepStrictEqual(clean(`fortification ${w.toUpperCase()}:5`).goals[0].forts, { [code]: 5 }, w);
      }
    }
    const p = clean([
      'fortification tra:1', 'fortification tra:1,ab:1,at:1', 'fortification tra:10,ab:10,at:10',
      'fortification tra:100,ab:100,at:100,tre:10', 'fortification tra:3000,ab:3000,at:15000,tre:200',
      'fortification trap:10,ab:10,at:1,r:10,rock:10',
    ].join('\n'));
    assert.deepStrictEqual(p.goals[4].forts, { trap: 3000, abatis: 3000, tower: 15000, rocks: 200 });
    assert.deepStrictEqual(p.goals[5].forts, { trap: 10, abatis: 10, tower: 1, logs: 10, rocks: 10 });
    assert.strictEqual(C.fortByWord('tre').typeId, 18);
    assert.strictEqual(C.fortByWord('trebuchet').beanKey, 'rockfall');
    assert.strictEqual(C.fortByWord('r').beanKey, 'rollingLogs', 'r is rolling logs in a fortification line');
    assert.strictEqual(C.troopByWord('r').key, 'batteringRam', 'and a ram in a troop line');
    has(parseGoals('fortification ro:5').errors[0].error, 'unknown fortification "ro"');
    assert.deepStrictEqual(G.FORT_ABBR, { tra: 'trap', ab: 'abatis', at: 'tower', r: 'logs', tre: 'rocks' });
  });

  await t('every resource word', () => {
    for (const [key, words] of Object.entries(C.RES_WORDS)) {
      for (const w of words) {
        assert.strictEqual(req(`requestresources any ${w} 1m 2m`).type, key, w);
        assert.strictEqual(req(`requestresources any ${w.toUpperCase()} 1m 2m`).type, key, w);
      }
    }
    assert.strictEqual(C.resourceByWord('lumber'), 'wood');
  });

  await t('no parser keeps its own alias list any more', () => {
    for (const f of ['goals.js', 'goal-npc.js', 'goal-transfer.js', 'goal-war.js']) {
      const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
      assert.ok(!/\b(TROOP_ALIAS|RES_WORD|ALIAS)\s*=/.test(src), `${f} still defines an alias table`);
    }
    assert.strictEqual(NPC.parsers.npctroops.parse(['5', 'phract:3']).troops.heavyCavalry, 3);
  });

  // ===================================================== k/m in the switches
  console.log('\nnumbers in gatepolicy and hidingpolicy switches\n');

  await t('gatepolicy: every number switch takes k/m and arrives as a number', () => {
    const r = W.parsers.gatepolicy.parse('0 0 0 0 0 /junk:5k /strongarchers:300k /weakarchers:100k /loyaltyattack:5k /defenceratio:5 /scoutratio:0.9 /mintoggle:30s'.split(' '));
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.switches, { junk: 5000, strongarchers: 300000, weakarchers: 100000, loyaltyattack: 5000, defenceratio: 5, scoutratio: 0.9, mintoggle: '30s' });
  });

  await t('gatepolicy: an unreadable number is an error and the default stands', () => {
    const r = W.parsers.gatepolicy.parse('0 0 0 0 0 /junk:lots /scoutratio:2 /strongarchers:3x /mintoggle:soon'.split(' '));
    assert.strictEqual(r.errors.length, 4, r.errors.join(' | '));
    assert.deepStrictEqual(r.switches, {});
  });

  // a wave as the server sends it (ArmyBean: string counts, epoch reachTime)
  const NOW = Date.now();
  const wave = (troop, inMs = 90000) => ({ armyId: 1, king: 'Raider', missionType: C.MISSION.attack, reachTime: NOW + inMs, troop });
  const warCtx = (over = {}) => {
    const castle = {
      castleId: 101, name: 'Home', fieldId: C.coordsToFieldId(200, 300), goOutForBattle: false,
      heros: [{ id: 7, name: 'Hider', status: 0, power: 120, management: 40 }],
      troop: { archer: 250000, pikemen: 10000, scouter: 500, lightCavalry: 2000 },
      resource: { food: { amount: 20e6 }, wood: { amount: 4e6 }, stone: { amount: 3e6 }, iron: { amount: 2e6 }, gold: 500000 },
      fortification: {}, buildings: [], ...(over.castle || {}),
    };
    const refuge = { castleId: 202, name: 'Refuge', fieldId: C.coordsToFieldId(210, 305), heros: [], troop: {}, resource: {} };
    const game = {
      now: () => NOW, marchSkillParam: 100, castles: [castle, refuge],
      castleId: (c) => c.castleId, castleXY: (c) => C.fieldIdToCoords(c.fieldId),
      buildArmyBean: Game.prototype.buildArmyBean,
    };
    return { game, castle, goals: over.goals || [], config: over.config || {}, fortifications: {}, incoming: over.incoming || [] };
  };

  await t('gatepolicy /junk:5k: a 3,000 wave is junk, a 6,000 wave is not (was: every known army was junk)', () => {
    const sw = W.parsers.gatepolicy.parse(['0', '0', '0', '0', '0', '/junk:5k']).switches;
    const { threatsOf } = W._internals;
    const ctx = warCtx({ incoming: [wave({ archer: '3000' }), { ...wave({ archer: '6000' }), armyId: 2 }] });
    const th = threatsOf(ctx, { junk: sw.junk });
    assert.deepStrictEqual([th.real.map((a) => a.armyId), th.junk], [[2], 1]);
  });

  await t('gatepolicy /strongarchers:200k: 250k archers meet a scout bomb in the field', () => {
    const sw = W.parsers.gatepolicy.parse(['0', '0', '0', '0', '0', '/strongarchers:200k']).switches;
    const choice = W._internals.gateBotChoice('scoutbomb', warCtx(), [], sw);
    assert.strictEqual(choice.open, true, choice.why);
    const dflt = W._internals.gateBotChoice('scoutbomb', warCtx(), [], {});
    assert.strictEqual(dflt.open, false, 'under the 300k default it stays shut');
  });

  await t('hidingpolicy: /keepres:100k, /junk:5k, /keep a:20k, /maxmarches, flags and durations', () => {
    const h = W.parsers.hidingpolicy.parse(['/keepres:100k', '/junk:5k', '/keep:a:20k,s:1.5k', '/maxmarches:5', '/recall:0', '/gold:1', '/margin:10', '/minlead:5s', '/horizon:2h', '/foodshare:0.5']);
    assert.deepStrictEqual(h.errors, []);
    assert.deepStrictEqual([h.keepRes, h.junk, h.keep, h.maxMarches, h.recall, h.sendGold, h.marginMs, h.minLeadMs, h.horizonMs, h.foodShare],
      [100000, 5000, { archer: 20000, scouter: 1500 }, 5, false, true, 600000, 5000, 7200000, 0.5]);
  });

  await t('hidingpolicy: unreadable values are errors and keep their defaults', () => {
    const h = W.parsers.hidingpolicy.parse(['/keepres:lots', '/junk:5x', '/recall:yes', '/maxrest:2m', '/margin:soon', '/foodshare:90', '/keep:a:many']);
    assert.strictEqual(h.errors.length, 7, h.errors.join(' | '));
    assert.deepStrictEqual([h.keepRes, h.junk, h.recall, h.maxRestMs, h.marginMs, h.foodShare, h.keep],
      [0, null, true, 8 * 3600000, 5 * 60000, 0.9, {}]);
  });

  await t('hiding with /keepres:100k hides resources over 100k (it used to hide none)', () => {
    const ctx = warCtx({
      config: { hiding: 2 }, goals: [{ name: 'hidingpolicy', ...W.parsers.hidingpolicy.parse(['/keepres:100k']) }],
      incoming: [wave({ archer: '200000' })],
    });
    const a = W.plans.hiding(ctx, {}).actions[0];
    const carried = Object.values(a.resources).reduce((s, v) => s + v, 0);
    assert.ok(carried > 0, 'nothing hidden');
    assert.ok(a.resources.iron <= 2e6 - 100e3, 'more than the iron over 100k');
  });

  await t('hiding with /junk:5k ignores a 3,000 poke and hides from a 6,000 wave', () => {
    const goals = [{ name: 'hidingpolicy', ...W.parsers.hidingpolicy.parse(['/junk:5k']) }];
    const poke = W.plans.hiding(warCtx({ config: { hiding: 2 }, goals, incoming: [wave({ archer: '3000' })] }), {});
    assert.strictEqual(poke.actions.length, 0, poke.note);
    const real = W.plans.hiding(warCtx({ config: { hiding: 2 }, goals, incoming: [wave({ archer: '6000' })] }), {});
    assert.strictEqual(real.actions.length, 1, real.note);
  });

  // ====================================================== bare-line war names
  console.log('\nbare-line war config names\n');

  await t('each war config name on its own line is read as config, and the line says so', () => {
    const lines = { hiding: '5', gate: '3', warrules: '2', wartown: '1', monitorarmy: '1', keepatthome: '1', attackgap: '6', defensecooldown: '30', nohealing: '1' };
    for (const [name, v] of Object.entries(lines)) {
      const p = parseGoals(`${name} ${v}`);
      const note = `read as "config ${name}:${v}" — ${name} is a config key, so write it that way`;
      assert.deepStrictEqual(p.errors, [], name);
      assert.deepStrictEqual([p.config, p.goals], [{ [name]: Number(v) }, []], name);
      // blue (or red, when the key itself does nothing yet), with the note on the line
      const idle = G.NOT_IMPLEMENTED.config[name];
      assert.deepStrictEqual(p.lines[0], idle
        ? { n: 1, status: 'idle', msg: `${name} does nothing yet: ${idle}; ${note}` }
        : { n: 1, status: 'ok', msg: note }, name);
      has(describe(p).join('\n'), `note: line 1 ${note}`);
    }
    assert.deepStrictEqual(parseGoals('monitorarmy').lines[0], { n: 1, status: 'ok', msg: null }, 'it does nothing in NEAT either');
  });

  await t('a bare "wartown 1" now locks the city down, as "config wartown:1" does', () => {
    const p = parseGoals('wartown 1');
    const plan = W.plans.wartown({ ...warCtx(), config: p.config }, {});
    assert.strictEqual(plan.lockdown, true, plan.note);
  });

  await t('its value is checked by its own parser, bare or in config', () => {
    has(parseGoals('wartown 5').errors[0].error, 'wartown must be 0 (off), 1');
    has(parseGoals('config wartown:5').errors[0].error, 'wartown must be 0 (off), 1');
    has(parseGoals('config hiding:soon').errors[0].error, 'cannot read "soon"');
    has(parseGoals('config hiding:2m').errors[0].error, 'typo');
    has(parseGoals('hiding').errors[0].error, 'hiding is a config key and needs a value');
    assert.deepStrictEqual(parseGoals('config hiding:30s,gate:0.1,wartown:2').errors, []);
  });

  // ============================================================ config keys
  console.log('\nconfig keys\n');

  const NEAT_KEYS = ['abandon', 'abandonflats', 'acquireflats', 'attackgap', 'building', 'buildnpc', 'comfort',
    'defensecooldown', 'embassy', 'farmingcycle', 'farmingcyclemin', 'fasthero', 'feastinghallspace', 'fortification',
    'fortsusereserved', 'gate', 'hero', 'hiding', 'hunting', 'keepatthome', 'monitorarmy', 'nohealing', 'nomayor', 'npc',
    'npclimit', 'plan', 'research', 'reservedbarrack', 'trade', 'trainint', 'trainpol', 'training', 'training10', 'troop',
    'troopdelbadque', 'troopidlequeuetime', 'troopincrement', 'troopqueuetime', 'troopsusepopmax', 'troopsusereserved',
    'valley', 'valleyfarming', 'valleymin', 'wallqueuetime', 'warrules', 'wartown'];

  await t('all 46 config keys the NEAT wiki documents are accepted', () => {
    assert.strictEqual(NEAT_KEYS.length, 46);
    const p = parseGoals(`config ${NEAT_KEYS.map((k) => `${k}:1`).join(',')}`);
    assert.deepStrictEqual(p.errors, []);
    assert.strictEqual(Object.keys(p.config).length, 46);
    for (const k of NEAT_KEYS) assert.ok(G.CONFIG_KEYS.has(k), k);
    has(parseGoals('config wibble:1').errors[0].error, 'unknown config key "wibble"');
  });

  await t('the ones not built yet are listed, with why, in NOT_IMPLEMENTED.config (the editor paints them red)', () => {
    const list = G.NOT_IMPLEMENTED.config;
    for (const [k, why] of Object.entries(list)) {
      assert.ok(G.CONFIG_KEYS.has(k), `${k} is listed but not accepted`);
      assert.ok(NEAT_KEYS.includes(k), `${k} is not a NEAT key`);
      assert.ok(typeof why === 'string' && why.length > 10, k);
    }
    // Step 17 built the troop and wall keys (fortification, fortsusereserved,
    // troopdelbadque, troopsusepopmax, wallqueuetime and the rest), so they left this list.
    for (const k of ['abandon', 'abandonflats', 'acquireflats', 'plan', 'valley', 'valleyfarming', 'valleymin']) {
      assert.ok(k in list, `${k} does nothing here yet and should be listed`);
      assert.strictEqual(parseGoals(`config ${k}:1`).lines[0].status, 'idle', k);
    }
    // trade: built in Step 14 (goal-trade.js); research: Step 16 (goal-research.js)
    for (const k of ['npc', 'buildnpc', 'comfort', 'hero', 'troop', 'hiding', 'gate', 'warrules', 'wartown', 'defensecooldown',
      'keepatthome', 'attackgap', 'building', 'feastinghallspace', 'nomayor', 'farmingcycle', 'farmingcyclemin', 'npclimit',
      'training', 'training10', 'monitorarmy', 'trade', 'research',
      'fortification', 'fortsusereserved', 'troopdelbadque', 'troopsusepopmax', 'troopsusereserved', 'troopqueuetime',
      'troopidlequeuetime', 'troopincrement', 'reservedbarrack', 'wallqueuetime']) {
      assert.ok(!(k in list), `${k} is implemented (or, for monitorarmy, a no-op in NEAT too)`);
    }
  });

  // ============================================== the live goals still parse
  console.log('\nthe saved goals\n');

  await t('account a2\'s goal texts parse cleanly once migrated', () => {
    const full = `config comfort:1,hero:1,troopsusepopmax:1,npc:5
comfortpolicy 15 16 popraise
defensepolicy /usetruce:79 /usespeech:2 /junktroop:5000 /usewarhorn:1 /usecorselet:1 /usepenicillin:1
build fh:1
build th:10,w:10,c:10:1,b:10:1,a:10:1,r:10:1,be:10:1,rs:10:1
build f:10:37
troop b:5k,t:5k
troop wo:10k,w:10k,s:10k,p:10k,sw:10k,a:10k,t:10k,c:10k,cata:10k,b:10k
troop a:100k,s:100k
fortification ab:5000
distancepolicy 15
npcteams 3
${A2_CITY}
npcheroes !OTTO,any
farmingpolicy 10 /distance:5
farmingpolicy 5 /distance:10`;
    const p = clean(MIG.migrateText(full).src);
    // every line blue: troopsusepopmax, the one config key that did nothing, works since Step 17
    assert.deepStrictEqual(p.lines.filter((l) => l.status !== 'ok' && l.status !== 'comment' && l.status !== 'blank')
      .map((l) => [l.n, l.status]), []);
    assert.strictEqual(p.goals.filter((g) => g.name === 'requestresources' && g.ok).length, 5);
    assert.deepStrictEqual(p.goals.find((g) => g.name === 'troop').troops, { ballista: 5000, carriage: 5000 });
    assert.deepStrictEqual(p.goals.find((g) => g.name === 'fortification').forts, { abatis: 5000 });
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  // Windows will not delete a database file that is still open
  const dbMod = require.cache[require.resolve('./db')];
  try { if (dbMod) dbMod.exports.db.close(); } catch {}
  for (const dir of [path.dirname(process.env.EVONY_DB), ...scratch]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  process.exit(fail ? 1 : 0);
})();
