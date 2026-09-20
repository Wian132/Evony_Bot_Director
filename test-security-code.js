'use strict';
// The account's SECURITY CODE (security.js) and the `allowabandon` adoption
// that lets abandontown give up a city the bot did not build.
//
// Everything here is offline: a throwaway database and a stub game. Nothing in
// this file may log in, and the code under test must never put a security code
// in a log line — that is asserted, not assumed.
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evony-sec-')), 'test.db');
process.env.OTTO_ALLOW_ABANDON_TOWN = '1';

const D = require('./db');
const SEC = require('./security');
const { Game } = require('./game');
const CITY = require('./script-cmd-city');
const ACCOUNT = require('./script-cmd-account');

let pass = 0, failed = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const ACC = 'a1';
const CODE = 'sw0rdf1sh';
const HOME = 100 * 800 + 100;
const FLAT = 105 * 800 + 105;

// A Game with a scripted server behind it: `answers` maps a command to a
// function of (data, callNumber) so a test can say "-200 the first time".
function stubGame(answers = {}) {
  const g = new Game(() => {});
  const sent = [];
  const counts = {};
  g.req = async (cmd, data) => {
    sent.push({ cmd, data });
    counts[cmd] = (counts[cmd] || 0) + 1;
    const a = answers[cmd];
    if (typeof a === 'function') return a(data, counts[cmd]);
    if (a !== undefined) return a;
    return { ok: 1 };
  };
  g.sent = sent;
  return g;
}

// ------------------------------------------------------- the protocol itself

t('the five protected options are the game\'s own, by bit', () => {
  assert.deepStrictEqual(SEC.OPTIONS.map((o) => [o.bit, o.label]), [
    [1, 'Restart game'],            // RestartGameWin.as:360
    [2, 'Abandon cities'],          // GiveupCastle.as:328
    [4, 'Dismiss armies'],          // SWDisband.as:368
    [8, 'Dismiss heroes'],          // HeroProperties.as:2011
    [16, 'Adjust tax rate'],        // AdjustmentCess.as:474
  ], 'SetSecurity.as:638-661 composes exactly this bitmask');
  assert.strictEqual(SEC.ALL, 31, 'the client\'s "Unlock All Operation" sends 31');
  assert.strictEqual(SEC.NEED_CODE, -200, 'ErrorCode.NEED_SECURITY_CODE_ERROR');
});

t('describeMask names what a protect option covers', () => {
  assert.strictEqual(SEC.describeMask(0), 'nothing');
  assert.strictEqual(SEC.describeMask(2), 'Abandon cities');
  assert.strictEqual(SEC.describeMask(3), 'Restart game, Abandon cities');
  assert.strictEqual(SEC.describeMask(31), 'Restart game, Abandon cities, Dismiss armies, Dismiss heroes, Adjust tax rate');
});

t('releasing a hero is NOT protected — only firing one is', () => {
  assert.ok(SEC.isProtectedCmd('hero.fireHero'));
  assert.ok(!SEC.isProtectedCmd('hero.releaseHero'), 'the client has no -200 branch on a release');
  assert.ok(!SEC.isProtectedCmd('castle.destructBuilding'), 'demolishing is not one of the five');
  assert.ok(!SEC.isProtectedCmd('fortifications.destructWallProtect'));
});

t('a command that is not refused is sent once, with no code on it', async () => {
  const g = stubGame();
  g.setSecurityCode(CODE);
  const r = await g.disbandTroop(7, 11, 100);
  assert.strictEqual(r.ok, 1);
  assert.deepStrictEqual(g.sent.map((x) => x.cmd), ['troop.disbandTroop'],
    'no auth, no unlock: an unprotected account must not pay for extra round trips');
  assert.ok(!JSON.stringify(g.sent).includes(CODE), 'the code never goes out unasked');
});

t('-200 authenticates, unlocks that one bit, and sends it again', async () => {
  const g = stubGame({
    'city.giveupCastle': (d, nth) => (nth === 1 ? { ok: -200, errorMsg: 'security code' } : { ok: 1 }),
  });
  g.setSecurityCode(CODE);
  const r = await g.giveUpCastle(4242, 'deadbeef');
  assert.strictEqual(r.ok, 1, 'the retry goes through');
  assert.deepStrictEqual(g.sent.map((x) => x.cmd), [
    'city.giveupCastle', 'common.authSecurityCode', 'common.setUnlockOption', 'city.giveupCastle',
  ], 'the client\'s own order: send, auth, unlock, send again');
  assert.deepStrictEqual(g.sent[1].data, { code: CODE });
  assert.deepStrictEqual(g.sent[2].data, { option: 2 }, 'only "Abandon cities" is unlocked, not all 31');
  assert.deepStrictEqual(g.sent[3].data, { password: 'deadbeef', castleId: 4242 },
    'the retry is the SAME command, unchanged — no code is added to it');
});

t('the code is authenticated once a session, then only unlocked', async () => {
  const g = stubGame({
    'city.giveupCastle': (d, nth) => (nth === 1 ? { ok: -200 } : { ok: 1 }),
    'hero.fireHero': (d, nth) => (nth === 1 ? { ok: -200 } : { ok: 1 }),
  });
  g.setSecurityCode(CODE);
  await g.giveUpCastle(1, 'h');
  await g.fireHero(2, 3);
  const auths = g.sent.filter((x) => x.cmd === 'common.authSecurityCode');
  assert.strictEqual(auths.length, 1, 'Context.bLoginSecurityCode is set once and stays set');
  assert.deepStrictEqual(g.sent.filter((x) => x.cmd === 'common.setUnlockOption').map((x) => x.data.option),
    [2, 8], 'each operation is unlocked as it is first refused');
});

t('a wrong code leaves the -200 standing — nothing is retried', async () => {
  const g = stubGame({
    'city.giveupCastle': { ok: -200 },
    'common.authSecurityCode': { ok: 0, errorMsg: 'wrong code' },
  });
  g.setSecurityCode('nope');
  const r = await g.giveUpCastle(9, 'h');
  assert.strictEqual(r.ok, -200, 'the caller sees the refusal, never a false success');
  assert.match(r.securityCode, /refused the security code/);
  assert.strictEqual(g.sent.filter((x) => x.cmd === 'city.giveupCastle').length, 1, 'it is not sent again');
});

t('no stored code: the -200 stands and says what to do', async () => {
  const g = stubGame({ 'troop.disbandTroop': { ok: -200 } });
  const r = await g.disbandTroop(1, 2, 3);
  assert.strictEqual(r.ok, -200);
  assert.match(r.securityCode, /securitycode set/);
  assert.deepStrictEqual(g.sent.map((x) => x.cmd), ['troop.disbandTroop'], 'nothing is sent without a code');
});

t('a second -200 is not hammered — it is sent twice at most', async () => {
  const g = stubGame({ 'hero.fireHero': { ok: -200 } });   // refuses every time
  g.setSecurityCode(CODE);
  const r = await g.fireHero(1, 2);
  assert.strictEqual(r.ok, -200);
  assert.strictEqual(g.sent.filter((x) => x.cmd === 'hero.fireHero').length, 2);
});

t('the unlock dies with the Game, as it does at logout', async () => {
  const g = stubGame({ 'interior.modifyTaxRate': (d, nth) => (nth === 1 ? { ok: -200 } : { ok: 1 }) });
  g.setSecurityCode(CODE);
  await g.setTax(1, 20);
  assert.ok(g._secAuthed);
  const fresh = stubGame();
  assert.strictEqual(fresh._secAuthed, false, 'a reconnect starts locked again');
  assert.strictEqual(fresh._secUnlocked, 0);
});

t('the code is not enumerable, so it cannot fall into a log or a dump', () => {
  const g = stubGame();
  g.setSecurityCode(CODE);
  assert.ok(!Object.keys(g).includes('_secCode'));
  assert.ok(!JSON.stringify(g).includes(CODE), 'JSON.stringify(game) must never carry it');
  assert.ok(!require('util').inspect(g).includes(CODE));
});

t('a function code is read at the moment it is wanted, not cached', async () => {
  let stored = 'old';
  const g = stubGame({ 'city.giveupCastle': (d, nth) => (nth === 1 ? { ok: -200 } : { ok: 1 }) });
  g.setSecurityCode(() => stored);
  stored = 'new';                                   // changed in the Director after login
  await g.giveUpCastle(1, 'h');
  assert.deepStrictEqual(g.sent[1].data, { code: 'new' }, 'no reconnect is needed for a code change');
});

t('readProtection reports what the game says, not what we guess', async () => {
  const g = stubGame({ 'common.getProtectOption': { ok: 1, option: 2 | 8 } });
  g.player = { isSetSecurityCode: true };
  const p = await SEC.readProtection(g);
  assert.strictEqual(p.isSet, true);
  assert.strictEqual(p.option, 10);
  assert.deepStrictEqual(p.protects.map((o) => o.label), ['Abandon cities', 'Dismiss heroes']);
});

// --------------------------------------------------- allowabandon / adoption

function world() {
  D.run('DELETE FROM city_registry');
  D.accounts.upsert({ id: ACC, label: 'Lord14', email: 't@t', password: 'pw' });
  const mk = (fieldId, id, name) => ({
    id, fieldId, name,
    resource: { food: { amount: 0 }, wood: { amount: 0 }, stone: { amount: 0 }, iron: { amount: 0 }, gold: 0 },
    troop: {}, heros: [], fortification: {},
  });
  const home = mk(HOME, 1, 'Home');
  const flat = mk(FLAT, 100307084, 'Flat');
  D.registry.reconcile(ACC, [
    { fieldId: HOME, castleId: home.id, name: home.name, x: 100, y: 100 },
    { fieldId: FLAT, castleId: flat.id, name: flat.name, x: 105, y: 105 },
  ]);
  const lines = [];
  const game = stubGame();
  Object.assign(game, {
    castles: [home, flat],
    castleId: (c) => c.id,
    castleXY: (c) => ({ x: Math.floor(c.fieldId / 800), y: c.fieldId % 800 }),
    player: { selfArmys: [] },
  });
  game.c = { passwordHash: () => 'deadbeef' };
  const env = {
    game, cid: home.id, castle: home, dryRun: false, log: (m) => lines.push(m),
    say: (r) => JSON.stringify(r), verdict: (r) => JSON.stringify(r),
    // The console's org handle, as a session hands it to a command.
    session: { account: { id: ACC }, org: { registry: D.registry, accounts: D.accounts } },
    opts: {},
  };
  return { game, env, lines, home, flat };
}

const run = (mod, name, args, env) => {
  const c = mod.commands[name];
  return c.run(c.parse(args, { word: name, tok: String(args).split(/\s+/) }), env);
};

t('a city the bot did not build is refused by abandontown', async () => {
  const w = world();
  await run(CITY, 'abandontown', '105,105 confirm', w.env);
  assert.match(w.lines.join('\n'), /registry records Flat as a real city/);
  assert.strictEqual(w.game.sent.filter((x) => x.cmd === 'city.giveupCastle').length, 0,
    'nothing is sent for a city the registry protects');
});

t('allowabandon adopts it, and then abandontown gives it up', async () => {
  const w = world();
  await run(CITY, 'allowabandon', '105,105 confirm', w.env);
  const row = D.registry.get(ACC, FLAT);
  assert.strictEqual(row.origin, 'adopted');
  assert.strictEqual(row.abandonable, true);
  assert.strictEqual(Number(row.castleId), 100307084);
  assert.match(row.notes, /allowabandon/);

  await run(CITY, 'abandontown', '105,105 confirm', w.env);
  const giveup = w.game.sent.filter((x) => x.cmd === 'city.giveupCastle');
  assert.strictEqual(giveup.length, 1);
  assert.deepStrictEqual(giveup[0].data, { password: 'deadbeef', castleId: 100307084 });
  assert.strictEqual(D.registry.get(ACC, FLAT).state, 'abandoned');
});

t('allowabandon without confirm refuses, and off puts it back', async () => {
  const w = world();
  assert.throws(() => CITY.commands.allowabandon.parse('105,105'), /end the line with the word confirm/);
  await run(CITY, 'allowabandon', '105,105 confirm', w.env);
  assert.strictEqual(D.registry.get(ACC, FLAT).abandonable, true);
  await run(CITY, 'allowabandon', '105,105 confirm off', w.env);
  const row = D.registry.get(ACC, FLAT);
  assert.strictEqual(row.abandonable, false);
  assert.strictEqual(row.state, 'protected');
});

t('the goal engine still cannot abandon an adopted city', () => {
  const w = world();
  D.registry.adopt(ACC, FLAT, 100307084, 'Flat', 'by hand');
  const { canAbandon } = require('./goal-buildnpc')._internals;
  const v = canAbandon({ accountId: ACC, game: w.game, castle: w.flat });
  assert.strictEqual(v.ok, false, 'buildnpc demands origin==="buildnpc" — adoption is for a person only');
  assert.match(v.why, /origin "adopted"/);
});

t('adopting cannot steal a tile buildnpc is working on', () => {
  world();
  D.registry.claimFlat(ACC, FLAT + 1, { x: 105, y: 106 });
  const r = D.registry.adopt(ACC, FLAT + 1, 555, 'X', 'by hand');
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /buildnpc owns this tile/);
});

t('adopting the wrong castle on a tile is refused', () => {
  world();
  const r = D.registry.adopt(ACC, FLAT, 999999, 'Flat', 'by hand');
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /not 999999/);
});

t('an adopted city survives a reconcile, and loses it on a teleport', () => {
  world();
  D.registry.adopt(ACC, FLAT, 100307084, 'Flat', 'by hand');
  D.registry.reconcile(ACC, [
    { fieldId: HOME, castleId: 1, name: 'Home', x: 100, y: 100 },
    { fieldId: FLAT, castleId: 100307084, name: 'Flat', x: 105, y: 105 },
  ]);
  assert.strictEqual(D.registry.get(ACC, FLAT).abandonable, true, 'a login must not undo the adoption');
  D.registry.reconcile(ACC, [
    { fieldId: HOME, castleId: 1, name: 'Home', x: 100, y: 100 },
    { fieldId: FLAT + 800, castleId: 100307084, name: 'Flat', x: 106, y: 105 },
  ]);
  assert.strictEqual(D.registry.get(ACC, FLAT + 800).abandonable, false,
    'a city that moved is no longer obviously throwaway — fail closed');
});

// ------------------------------------------------------ the securitycode command

t('securitycode set stores the code and never logs it', async () => {
  const w = world();
  await run(ACCOUNT, 'securitycode', 'set ' + CODE, w.env);
  assert.strictEqual(D.accounts.get(ACC).securityCode, CODE);
  assert.ok(!w.lines.join('\n').includes(CODE), 'the code must never reach the log');
  await run(ACCOUNT, 'securitycode', 'clear', w.env);
  assert.strictEqual(D.accounts.get(ACC).securityCode, null);
});

t('securitycode reports what the game protects', async () => {
  const w = world();
  w.game.player = { isSetSecurityCode: true };
  w.game.req = async (cmd) => (cmd === 'common.getProtectOption' ? { ok: 1, option: 2 } : { ok: 1 });
  await run(ACCOUNT, 'securitycode', '', w.env);
  const out = w.lines.join('\n');
  assert.match(out, /HAS security code set in the game/);
  assert.match(out, /it protects: Abandon cities/);
  assert.match(out, /\[x\] Abandon cities/);
  assert.match(out, /\[ \] Dismiss heroes/);
  assert.match(out, /has NO code stored/);
});

t('an upsert that says nothing about the code leaves it alone', () => {
  world();
  D.accounts.upsert({ id: ACC, securityCode: CODE });
  D.accounts.upsert({ id: ACC, label: 'renamed' });
  assert.strictEqual(D.accounts.get(ACC).securityCode, CODE,
    'saving an account from a page that has no such field must not wipe the code');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
  }
  console.log(`\n${pass} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
