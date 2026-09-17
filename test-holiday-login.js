'use strict';
// What a login reply means (Game.loginOutcome), offline. An account on HOLIDAY
// is answered with ok=-100 and the whole account with it; NEAT logs in anyway
// and so do we, without ending the holiday. Everything else must refuse with a
// SHORT message: the reply carries the entire player bean (100 KB+), and it
// used to end up in the log, /api/session and the Director's tooltip.
const assert = require('assert');
const { Game } = require('./game');

const tests = [];
const t = (n, f) => tests.push([n, f]);

// Lord03's real reply, trimmed: ok=-100, msg "<hours>,<minutes>,<n>", and a
// player carrying every castle.
const holidayReply = () => ({
  ok: -100,
  msg: '9,37,149183',
  errorMsg: '9,37,149183',
  packageId: 0,
  player: {
    playerInfo: { userName: 'Lord03', id: 544860379 },
    buffs: [{ descName: '', endTime: 1789708298421, typeId: 'FurloughBuff' }],
    castles: Array.from({ length: 10 }, (_, i) => ({ fieldId: 92700 + i, name: 'City' + i, heros: [] })),
    currentTime: Date.now(),
  },
});

t('ok=1 is a plain login', () => {
  assert.deepStrictEqual(Game.loginOutcome({ ok: 1, player: {} }), { ok: true });
});

t('ok=-100 is a login too, with the holiday noted and never ended', () => {
  const out = Game.loginOutcome(holidayReply());
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.error, undefined, 'a holiday login must not be an error');
  assert.deepStrictEqual(out.holiday, { hours: 9, minutes: 37, text: '9h37m' });
});

t('the holiday minutes are padded, and a missing msg still logs in', () => {
  assert.strictEqual(Game.loginOutcome({ ok: -100, msg: '3,5,1' }).holiday.text, '3h05m');
  assert.deepStrictEqual(Game.loginOutcome({ ok: -100 }).holiday, { hours: 0, minutes: 0, text: '0h00m' });
});

t('a real refusal is short, and never carries the player', () => {
  const big = { ok: -7, errorMsg: 'Wrong password.', player: { junk: 'x'.repeat(200000) } };
  const out = Game.loginOutcome(big);
  assert.strictEqual(out.ok, undefined);
  assert.strictEqual(out.error, 'login failed: ok=-7 — Wrong password.');
  assert.ok(out.error.length < 200, 'the message stays short');
  assert.ok(!out.error.includes('xxxx'), 'the payload is not in the message');
});

t('the codes the game client names are named here too', () => {
  assert.match(Game.loginOutcome({ ok: -5, captcha: 'x' }).error, /captcha \(ok=-5\)/);
  assert.match(Game.loginOutcome({ ok: 2 }).error, /no lord on this account yet \(ok=2\)/);
  assert.match(Game.loginOutcome(null).error, /^login failed: no reply$/);
  assert.match(Game.loginOutcome({ ok: -1, msg: 'server busy' }).error, /ok=-1 — server busy/);
});

t('a Game starts with no holiday, and connect() would set it from the reply', () => {
  const g = new Game();
  assert.strictEqual(g.holiday, null);
  // what connect() does with the outcome, without a socket
  const out = Game.loginOutcome(holidayReply());
  g.player = holidayReply().player;
  g.castles = g.player.castles;
  g.holiday = out.holiday || null;
  assert.strictEqual(g.castles.length, 10, 'every castle is there while on holiday');
  assert.strictEqual(g.holiday.text, '9h37m');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ok    ' + name); }
    catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + String((e && e.message) || e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
