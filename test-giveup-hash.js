'use strict';
// city.giveupCastle takes the account password as SHA1.hash of the text, the
// way the client's abandon window sends it (GiveupCastle.as:417). The plain
// text must never go on the wire: the socket is unencrypted and may run
// through a proxy. Offline: a throwaway database and a stub game only.
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const assert = require('assert');

process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evony-giveup-')), 'test.db');

const D = require('./db');
const B = require('./goal-buildnpc');
const { passwordHash } = require('./evony');

let pass = 0, fail = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const ACC = 'a1';
const PASSWORD = 'correct horse battery';
const HOME_FIELD = 100 * 800 + 100;
const BUILT_FIELD = 105 * 800 + 105;

const city = (fieldId) => ({
  id: fieldId, fieldId, name: 'C' + fieldId,
  resource: { food: { amount: 0 }, wood: { amount: 0 }, stone: { amount: 0 }, iron: { amount: 0 }, gold: 0 },
  troop: {}, heros: [], fortification: {},
});

// A home city, a second city, and a freshly founded buildnpc city in the registry.
function setup() {
  D.run('DELETE FROM city_registry');
  D.accounts.upsert({ id: ACC, label: 'T', email: 't@t', password: PASSWORD });
  const home = city(HOME_FIELD), extra = city(HOME_FIELD + 1), built = city(BUILT_FIELD);
  const sent = [];
  const game = {
    castles: [home, extra, built],
    castleId: (c) => c.id,
    castleXY: (c) => ({ x: Math.floor(c.fieldId / 800), y: c.fieldId % 800 }),
    player: { selfArmys: [] },
    req: async (cmd, data) => { sent.push({ cmd, data }); return { ok: 1 }; },
  };
  // The real giveUpCastle, not a copy of it: it goes through reqProtected, so
  // this test also proves the security-code wrapper does not mangle the hash.
  const { Game } = require('./game');
  game.giveUpCastle = Game.prototype.giveUpCastle.bind(game);
  game.reqProtected = Game.prototype.reqProtected.bind(game);
  game.securityCode = () => null;
  game.log = () => {};
  D.registry.reconcile(ACC, [
    { fieldId: HOME_FIELD, castleId: home.id, name: home.name },
    { fieldId: HOME_FIELD + 1, castleId: extra.id, name: extra.name },
  ]);
  D.registry.claimFlat(ACC, BUILT_FIELD, { x: 105, y: 105 });
  D.registry.markBuilt(ACC, BUILT_FIELD, built.id, built.name);
  D.run('UPDATE city_registry SET builtAt = ? WHERE accountId = ? AND fieldId = ?', Date.now() - 30 * 60000, ACC, BUILT_FIELD);
  return { game, home, built, sent };
}

t('passwordHash is SHA1 lowercase hex of the UTF-8 text, as the client does', () => {
  assert.strictEqual(passwordHash(PASSWORD), crypto.createHash('sha1').update(PASSWORD, 'utf8').digest('hex'));
  assert.match(passwordHash(PASSWORD), /^[0-9a-f]{40}$/);
});

t('abandonCity sends the SHA1 of the stored password, never the plain text', async () => {
  const { game, home, built, sent } = setup();
  const res = await B.executors.abandonCity(game, home, { castleId: built.id, fieldId: BUILT_FIELD }, { accountId: ACC, buildnpc: {} });
  assert.strictEqual(res.ok, 1, 'the guard should have let this registered buildnpc city go: ' + JSON.stringify(res));
  const giveup = sent.filter((m) => m.cmd === 'city.giveupCastle');
  assert.strictEqual(giveup.length, 1);
  assert.strictEqual(giveup[0].data.password, passwordHash(PASSWORD));
  assert.strictEqual(giveup[0].data.castleId, built.id);
  assert.ok(!JSON.stringify(sent).includes(PASSWORD), 'the plain password must not appear in anything sent');
});

t('a refused guard sends nothing at all (the hash is only computed for a real send)', async () => {
  const { game, home, sent } = setup();
  const res = await B.executors.abandonCity(game, home, { castleId: home.id, fieldId: HOME_FIELD }, { accountId: ACC, buildnpc: {} });
  assert.notStrictEqual(res.ok, 1);
  assert.strictEqual(sent.length, 0);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok    ' + name); pass++; }
    catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
