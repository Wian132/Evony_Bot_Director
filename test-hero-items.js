'use strict';
// Hero items (heroitems.js), offline: what the console's + window offers, and
// which hero an item lands on when two cities hold the same name. No network —
// the game here is a hand-made object with a fake `req`.
const assert = require('assert');
const HI = require('./heroitems');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);

// Just enough Game for heroitems.js: castles with heroes, an inventory, and a
// req that records what was sent.
function world(cities, items = {}) {
  const sent = [];
  const g = {
    sent,
    player: { items: Object.entries(items).map(([id, count]) => ({ id, count })) },
    castles: cities.map((c, i) => ({ id: 1000 + i, name: c.name, heros: c.heros })),
    castleId: (c) => c.id,
    req: async (cmd, data) => { sent.push({ cmd, data }); return { ok: 1 }; },
    heroAfter: async () => null,
  };
  return g;
}
const hero = (id, name, o = {}) => Object.assign({ id, name, level: 10, status: 0, power: 50, management: 20, stratagem: 20 }, o);

section('the names the catalogue gives them');

t('the three attribute items are named as the client names them', () => {
  assert.strictEqual(HI.ALL['hero.power.1'].label, 'Excalibur');
  assert.strictEqual(HI.ALL['hero.management.1'].label, 'The Wealth of Nations');
  assert.strictEqual(HI.ALL['hero.intelligence.1'].label, 'The Art of War');
});

t('each one is found by its short name as well as its id', () => {
  assert.strictEqual(HI.resolveItem('excal'), 'hero.power.1');
  assert.strictEqual(HI.resolveItem('The Wealth of Nations'), 'hero.management.1');
  assert.strictEqual(HI.resolveItem('art of war'), 'hero.intelligence.1');
  assert.strictEqual(HI.resolveItem('aow'), 'hero.intelligence.1');
  assert.strictEqual(HI.resolveItem('hero.intelligence.1'), 'hero.intelligence.1');
});

section('what the + window offers');

t('the three attribute items are always offered, even with none held', () => {
  const rows = HI.heroItemChoices(world([{ name: '10', heros: [hero(1, 'OTTO')] }]));
  assert.deepStrictEqual(rows.map((r) => r.id), ['hero.power.1', 'hero.management.1', 'hero.intelligence.1']);
  assert.deepStrictEqual(rows.map((r) => r.count), [0, 0, 0]);
  assert.match(rows[0].effect, /\+25% attack/);
});

t('the counts held are the counts shown', () => {
  const g = world([{ name: '10', heros: [hero(1, 'OTTO')] }], { 'hero.power.1': 7, 'hero.intelligence.1': 2 });
  const rows = HI.heroItemChoices(g);
  assert.deepStrictEqual(rows.map((r) => [r.label, r.count]),
    [['Excalibur', 7], ['The Wealth of Nations', 0], ['The Art of War', 2]]);
});

t('other hero items held come after, Holy Water left out (the hero row resets)', () => {
  const g = world([{ name: '10', heros: [hero(1, 'OTTO')] }],
    { 'hero.power.1': 1, 'hero.reset.1': 9, 'hero.loyalty.9': 3, 'player.experience.1.c': 4 });
  const rows = HI.heroItemChoices(g);
  const ids = rows.map((r) => r.id);
  assert.deepStrictEqual(ids.slice(0, 3), ['hero.power.1', 'hero.management.1', 'hero.intelligence.1']);
  assert.ok(!ids.includes('hero.reset.1'), 'Holy Water does not go through hero.useItem');
  assert.ok(ids.includes('hero.loyalty.9') && ids.includes('player.experience.1.c'), ids.join(','));
  // a medal ALL does not name is named from the item catalogue
  assert.strictEqual(rows.find((r) => r.id === 'hero.loyalty.9').label, 'Nation Medal');
  assert.strictEqual(rows.find((r) => r.id === 'player.experience.1.c').label, 'On War');
});

section('which hero it lands on');

t('with a castleId, the hero in THAT city gets it', async () => {
  const g = world([
    { name: '10', heros: [hero(1, 'Twin')] },
    { name: '20', heros: [hero(2, 'Twin')] },
  ], { 'hero.power.1': 5 });
  const r = await HI.useOnHero(g, { heroName: 'Twin', castleId: 1001, itemId: 'hero.power.1', times: 1 });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.castle, '20');
  assert.deepStrictEqual(g.sent.map((s) => [s.cmd, s.data.castleId, s.data.heroId]), [['hero.useItem', 1001, 2]]);
});

t('a heroId picks the hero outright', async () => {
  const g = world([{ name: '10', heros: [hero(1, 'Twin'), hero(2, 'Twin')] }], { 'hero.power.1': 5 });
  const r = await HI.useOnHero(g, { heroName: 'Twin', heroId: 2, castleId: 1000, itemId: 'hero.power.1', times: 1 });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(g.sent[0].data.heroId, 2);
});

t('without a castleId it still takes the first city holding the name (the script line)', async () => {
  const g = world([
    { name: '10', heros: [hero(1, 'Twin')] },
    { name: '20', heros: [hero(2, 'Twin')] },
  ], { 'hero.power.1': 5 });
  const r = await HI.useOnHero(g, { heroName: 'Twin', itemId: 'hero.power.1', times: 1 });
  assert.strictEqual(r.castle, '10');
});

t('a name that is not in the named city says which city, not "any city"', async () => {
  const g = world([
    { name: '10', heros: [hero(1, 'OTTO')] },
    { name: '20', heros: [hero(2, 'Ken')] },
  ], { 'hero.power.1': 5 });
  const r = await HI.useOnHero(g, { heroName: 'Ken', castleId: 1000, itemId: 'hero.power.1', times: 1 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no hero called "Ken" in 10/);
  assert.strictEqual(g.sent.length, 0, 'nothing sent');
});

section('what it refuses to send');

t('more than are held: it uses what there is and says so', async () => {
  const g = world([{ name: '10', heros: [hero(1, 'OTTO')] }], { 'hero.power.1': 2 });
  const said = [];
  const r = await HI.useOnHero(g, { heroName: 'OTTO', castleId: 1000, itemId: 'hero.power.1', times: 5, log: (m) => said.push(m) });
  assert.strictEqual(r.used, 2);
  assert.strictEqual(g.sent.length, 2);
  assert.match(said.join('\n'), /only 2 Excalibur/);
});

t('none held: nothing is sent', async () => {
  const g = world([{ name: '10', heros: [hero(1, 'OTTO')] }]);
  const r = await HI.useOnHero(g, { heroName: 'OTTO', castleId: 1000, itemId: 'hero.power.1', times: 1 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no Excalibur/);
  assert.strictEqual(g.sent.length, 0);
});

t('Holy Water is turned away: it is hero.resetPoint, not hero.useItem', async () => {
  const g = world([{ name: '10', heros: [hero(1, 'OTTO')] }], { 'hero.reset.1': 9 });
  const r = await HI.useOnHero(g, { heroName: 'OTTO', castleId: 1000, itemId: 'hero.reset.1', times: 1 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /waterhero OTTO/);
  assert.strictEqual(g.sent.length, 0);
});

t('a refusal stops the run there rather than repeating it', async () => {
  const g = world([{ name: '10', heros: [hero(1, 'OTTO')] }], { 'hero.power.1': 9 });
  let n = 0;
  g.req = async (cmd, data) => {
    g.sent.push({ cmd, data });
    return ++n === 2 ? { ok: 0, errorMsg: 'no' } : { ok: 1 };
  };
  const r = await HI.useOnHero(g, { heroName: 'OTTO', castleId: 1000, itemId: 'hero.power.1', times: 5 });
  assert.strictEqual(r.used, 1);
  assert.strictEqual(g.sent.length, 2, 'stopped at the refusal');
  assert.match(r.error, /no/);
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    if (!fn) { console.log(`\n${name}\n`); continue; }
    try { await fn(); pass++; console.log(`  ok    ${name}`); }
    catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
