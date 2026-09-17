'use strict';
// What an account is under (buffs.js), offline. A protection never reaches the
// castle's `status` field — a lord on holiday still reports status 0 on every
// city — so the console reads it from the player's buffs.
const assert = require('assert');
const B = require('./buffs');
const { Game } = require('./game');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const NOW = 1758000000000;

// A Game with buffs, at a fixed server clock.
function world({ player = [], city = [], holiday = null } = {}) {
  const g = new Game();
  g.now = () => NOW;
  g.player = { playerInfo: { userName: 'Lord03' }, buffs: player };
  g.castles = [{ id: 98733267, name: '10', buffs: city }];
  g.holiday = holiday;
  return g;
}
const buff = (typeId, minsLeft, descName = '') => ({ typeId, descName, endTime: NOW + minsLeft * 60000 });

t('holiday mode is named even though the game sends no description', () => {
  const g = world({ player: [buff('FurloughBuff', 569)] });     // Lord03's real shape
  const b = B.active(g);
  assert.strictEqual(b.player.length, 1);
  assert.strictEqual(b.player[0].name, 'Holiday mode');
  assert.strictEqual(b.player[0].text, 'Holiday mode', 'an empty descName falls back to the name');
  assert.strictEqual(b.player[0].left, '9h29m');
  assert.deepStrictEqual(b.protection, {
    kind: 'holiday', label: 'Holiday mode', type: 'FurloughBuff', msLeft: 569 * 60000, left: '9h29m', text: 'Holiday mode',
  });
});

t("the game's own sentence wins when it sends one", () => {
  const g = world({ player: [buff('ReduceArmyActionBuff', 55, 'Troop marching time is reduced by 35%')] });
  const [b] = B.active(g).player;
  assert.strictEqual(b.text, 'Troop marching time is reduced by 35%');
  assert.strictEqual(b.name, 'Faster marches');
  assert.strictEqual(b.left, '55m00s');
});

t('every protection is recognised, strongest first', () => {
  const kinds = (types) => (B.protectionOf(world({ player: types.map((x) => buff(x, 60)) })) || {}).kind;
  assert.strictEqual(kinds(['TruceAgreementBuff']), 'truce');
  assert.strictEqual(kinds(['DreamTruceBuff']), 'dreamtruce');
  assert.strictEqual(kinds(['PlayerPeaceBuff']), 'peace');
  assert.strictEqual(kinds(['PlayerPeaceUniteServerBuff']), 'peace');
  assert.strictEqual(kinds(['TruceAgreementBuff', 'FurloughBuff']), 'holiday', 'holiday outranks a truce');
  assert.strictEqual(kinds(['StopTroopsUpkeepBuff']), undefined, 'an ordinary buff is no protection');
  assert.strictEqual(B.protectionOf(world()), null);
});

t("the login's own answer counts before the buff list arrives", () => {
  const g = world({ holiday: { hours: 9, minutes: 29, text: '9h29m' } });
  g.player.buffs = [];
  assert.strictEqual(B.protectionOf(g).kind, 'holiday');
  assert.strictEqual(B.protectionOf(g).left, '9h29m');
});

t('city buffs are kept apart from the account\'s, and expired ones are dropped', () => {
  const g = world({ player: [buff('DoubleResourceBuff', 30)], city: [buff('ForceopenclosegateBuff', 10), buff('KeepSilenceBuff', -5)] });
  const b = B.active(g);
  assert.deepStrictEqual(b.player.map((x) => x.name), ['Double resources']);
  assert.deepStrictEqual(b.cities['98733267'].map((x) => x.name), ['Gates forced'], 'the expired one is gone');
});

t('an unknown buff still reads as words, not as a typeId', () => {
  assert.strictEqual(B.nameOf('SomeNewFancyBuff'), 'Some New Fancy');
  assert.strictEqual(B.nameOf('ReduceTroopsUpkeepBuff2'), 'Reduced troop upkeep');
});

t('remaining time reads the way the game writes it', () => {
  assert.strictEqual(B.leftText(569 * 60000), '9h29m');
  assert.strictEqual(B.leftText(55 * 60000 + 29000), '55m29s');
  assert.strictEqual(B.leftText(4 * 86400000 + 3 * 3600000), '4d 3h');
  assert.strictEqual(B.leftText(0), 'expired');
  assert.strictEqual(B.leftText(null), 'expired');
});

t('the server clock is what is counted against, not this machine\'s', () => {
  const g = world({ player: [buff('FurloughBuff', 60)] });
  g.now = () => NOW + 30 * 60000;        // half an hour later on the server
  assert.strictEqual(B.active(g).player[0].left, '30m00s');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ok    ' + name); }
    catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + String((e && e.message) || e).split('\n').slice(0, 5).join('\n        ')); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
