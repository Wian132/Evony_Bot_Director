'use strict';
// `f:*` on a march — "fill the hold with this" (script-cmd-deploy.js fillHold,
// script-words.js parseResources). Offline: no game, no network.
//
// The room is the troops' load, less the food the march eats out of that same
// hold, less whatever the line names. Several stars share what is left, each
// capped by what the city actually holds — a star that asked for more than the
// city has would leave the march waiting for resources that never come.
const assert = require('assert');
const script = require('./script');
const D = require('./script-cmd-deploy');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const P = (line) => script.parseLine(line);
const parseErr = (line) => { try { script.parseLine(line); } catch (e) { return e.message; } return null; };

// a city holding these amounts; resource beans are {amount} like the server's
const city = (o) => ({ resource: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { amount: v }])) });
// 100k transporters at loadSkill 100 hold 5000 x 2 each = 1b
const HOLD = 100000 * 5000 * 2;
const fill = (line, store, hold = HOLD, food = 0) => {
  const a = P(line);
  D.fillHold(a, city(store), hold, food, () => {}, !!a.fullhold);
  return a.resources;
};

t('one star takes the whole hold', () => {
  assert.deepStrictEqual(fill('transport 1,2 t:100k f:*', { food: 5e9 }), { food: HOLD });
});

t('the star is capped by what the city actually holds', () => {
  assert.deepStrictEqual(fill('transport 1,2 t:100k f:*', { food: 250e6 }), { food: 250e6 });
});

t('named amounts come off first, the star takes the rest', () => {
  assert.deepStrictEqual(
    fill('transport 1,2 t:100k w:100m,s:100m,i:*', { wood: 5e9, stone: 5e9, iron: 5e9 }),
    { wood: 100e6, stone: 100e6, iron: HOLD - 200e6 });
});

t('the march food is set aside', () => {
  // 100k transporters eat 10 x 2 x 100k = 2m an hour; one hour of march
  assert.deepStrictEqual(fill('transport 1,2 t:100k f:*', { food: 5e9 }, HOLD, 2000000),
    { food: HOLD - 2000000 });
});

t('/fullhold sets nothing aside', () => {
  assert.deepStrictEqual(fill('transport 1,2 t:100k f:* /fullhold', { food: 5e9 }, HOLD, 2000000),
    { food: HOLD });
});

t('two stars split what is left', () => {
  assert.deepStrictEqual(fill('transport 1,2 t:100k f:*,i:*', { food: 5e9, iron: 5e9 }),
    { food: HOLD / 2, iron: HOLD / 2 });
});

t('a short star gives its room to the other one', () => {
  // food only 1m in the city: iron should take the other 999m
  const r = fill('transport 1,2 t:100k f:*,i:*', { food: 1e6, iron: 5e9 });
  assert.strictEqual(r.food, 1e6);
  assert.strictEqual(r.food + r.iron, HOLD);
});

t('stars never total more than the hold', () => {
  const r = fill('transport 1,2 t:100k f:*,w:*,s:*,i:*', { food: 5e9, wood: 5e9, stone: 5e9, iron: 5e9 });
  assert.strictEqual(Object.values(r).reduce((a, b) => a + b, 0), HOLD);
});

t('no hold, nothing carried', () => {
  assert.deepStrictEqual(fill('transport 1,2 t:100k f:*', { food: 5e9 }, 0), { food: 0 });
});

t('a city with nothing carries nothing, and does not wait for it', () => {
  assert.deepStrictEqual(fill('transport 1,2 t:100k f:*', { food: 0 }), { food: 0 });
});

t('the star is only for resources, not troops', () => {
  assert.match(parseErr('transport 1,2 cp:* f:1b'), /\* \(fill\) works on the resources of a march, not on troops/);
});

t('the star is only for a march', () => {
  assert.match(parseErr('dumpresource 1,2 f:11000 f:*'), /only works on a march/);
});

t('plain amounts still parse', () => {
  assert.deepStrictEqual(P('transport 1,2 t:100k f:1b').resources, { food: 1e9 });
});

// ---------------------------------------------------------------------------
(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log('  ok    ' + n); pass++; }
    catch (e) { console.log('  FAIL  ' + n + '\n        ' + String(e.message).split('\n').join('\n        ')); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
