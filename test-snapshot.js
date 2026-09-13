'use strict';
// Offline tests for snapshot.js — hand-made player beans, no network.
//   node test-snapshot.js
const assert = require('assert');
const C = require('./constants');
const { incomingArmies } = require('./snapshot');

const tests = [];
const t = (n, f) => tests.push([n, f]);

const F = (x, y) => C.coordsToFieldId(x, y);
const FLAT = F(484, 619), NINE = F(571, 648), NPC = F(485, 618), ENEMY = F(300, 300);
const game = (player) => ({
  castles: [{ fieldId: FLAT, name: 'Flat' }, { fieldId: NINE, name: '9' }],
  player: { selfArmys: [], enemyArmys: [], friendArmys: [], ...player },
});
const army = (o) => ({ missionType: C.MISSION.reinforce, direction: 1, troop: { ballista: '1650' }, reachTime: 1, ...o });

// Lord02, 2026-09-13: reinforcements on the road to Flat and the tab said
// "Nothing inbound" — they are in selfArmys, and only the other two lists were read.
t('our own reinforcement to another of our cities is inbound', () => {
  const inc = incomingArmies(game({ selfArmys: [army({ startFieldId: NINE, targetFieldId: FLAT, startPosName: '9' })] }));
  assert.strictEqual(inc.length, 1);
  assert.deepStrictEqual([inc[0].mission, inc[0].myCity, inc[0].from, inc[0].troopTotal], ['reinforce', 'Flat', '9', 1650]);
  assert.deepStrictEqual([inc[0].own, inc[0].hostile], [true, false]);
});

t('our own transport to another of our cities is inbound, with its load', () => {
  const inc = incomingArmies(game({ selfArmys: [army({ missionType: C.MISSION.transport, startFieldId: NINE, targetFieldId: FLAT,
    resource: { food: 50000, wood: 0 } })] }));
  assert.deepStrictEqual([inc.length, inc[0].mission, inc[0].resources], [1, 'transport', { food: 50000 }]);
});

t('a march going home, or out to someone else\'s tile, is not inbound', () => {
  const inc = incomingArmies(game({ selfArmys: [
    army({ startFieldId: NINE, targetFieldId: FLAT, direction: 2 }),            // turned back to 9
    army({ startFieldId: FLAT, targetFieldId: NPC, missionType: C.MISSION.attack }),   // farming
    army({ startFieldId: FLAT, targetFieldId: NPC, missionType: C.MISSION.attack, direction: 2 }),
  ] }));
  assert.deepStrictEqual(inc, []);
});

t('attacks, allies\' reinforcements and our own all show, each marked', () => {
  const inc = incomingArmies(game({
    enemyArmys: [army({ missionType: C.MISSION.attack, startFieldId: ENEMY, targetFieldId: FLAT, troop: { archer: '?' } })],
    friendArmys: [army({ startFieldId: ENEMY, targetFieldId: NINE, king: 'Ally' })],
    selfArmys: [army({ startFieldId: NINE, targetFieldId: FLAT })],
  }));
  assert.deepStrictEqual(inc.map((a) => [a.mission, a.hostile, a.own]),
    [['attack', true, false], ['reinforce', false, false], ['reinforce', false, true]]);
  assert.strictEqual(inc[0].scouted, false, 'an unscouted attack keeps its "?"');
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { fn(); pass++; console.log(`  ok    ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
