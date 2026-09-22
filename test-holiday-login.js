'use strict';
// What a login reply means (Game.loginOutcome), offline. An account on HOLIDAY
// is answered with ok=-100 and the whole account with it; NEAT logs in anyway
// and so do we, without ending the holiday. Everything else must refuse with a
// SHORT message: the reply carries the entire player bean (100 KB+), and it
// used to end up in the log, /api/session and the Director's tooltip.
const assert = require('assert');
const os = require('os'), path = require('path'), fs = require('fs');
// session.js opens the database as it loads, so point it at a throwaway one
// before requiring it — this suite must never touch the real evony.db.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-holiday-'));
process.env.EVONY_DB = path.join(TMP, 'test.db');
const { Game } = require('./game');
const { Session } = require('./session');

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

// A Session with no game server, no database and no console behind it: just the
// few fields holidayRun reads, so the counting can be tested on its own.
function fake({ holiday = null, connected = true, store = {} } = {}) {
  const f = {
    account: { id: 'a6' }, connected, store, note() {},
    game: { holiday, player: { buffs: [] }, castles: [] },
    settings: () => ({
      get: (k, d) => (k in store ? store[k] : d),
      set: (k, v) => { store[k] = v; },
    }),
  };
  f.holidayRun = Session.prototype.holidayRun.bind(f);
  f.holidayRunView = Session.prototype.holidayRunView.bind(f);
  f.noteMaintenanceEnded = Session.prototype.noteMaintenanceEnded.bind(f);
  return f;
}
const HOL = { hours: 9, minutes: 37, text: '9h37m' };

t('a holidayed account is not market-glitch ready until a maintenance has passed', () => {
  const f = fake({ holiday: HOL });
  const first = f.holidayRunView();
  assert.strictEqual(first.maints, 0);
  assert.strictEqual(first.ready, false, 'just gone on holiday: nothing to put its resources back to yet');
  assert.ok(first.since > 0);
  // asking again does not restart the clock
  const again = f.holidayRunView();
  assert.strictEqual(again.since, first.since);
  assert.strictEqual(again.maints, 0);
});

t('a maintenance that ends while it is on holiday counts once, and then it is ready', () => {
  const f = fake({ holiday: HOL });
  f.holidayRun();                        // first sighting
  f.noteMaintenanceEnded();
  assert.strictEqual(f.holidayRunView().maints, 1);
  assert.strictEqual(f.holidayRunView().ready, true);
  // every way back after the same maintenance says so: it still counts once
  f.noteMaintenanceEnded();
  f.holidayRun();
  assert.strictEqual(f.holidayRunView().maints, 1, 'one maintenance a day');
  // the next day's does count
  f.store['maintEnded:a6'] = { day: '2099-01-01', at: Date.now() };
  assert.strictEqual(f.holidayRunView().maints, 2, 'they add up');
});

t('a maintenance noted before the holiday was seen is applied once it is (the console did not know yet)', () => {
  const f = fake({ holiday: null });
  f.store['maintEnded:a6'] = { day: '2099-01-02', at: Date.now() };
  assert.strictEqual(f.holidayRunView(), null, 'not on holiday as far as it knows');
  f.game.holiday = HOL;                  // the login says holiday
  assert.strictEqual(f.holidayRunView().maints, 1);
});

t('the count survives a console restart, and is dropped when the holiday ends', () => {
  const store = {};
  const one = fake({ holiday: HOL, store });
  one.holidayRun();
  one.noteMaintenanceEnded();
  // a new console for the same account reads the same settings
  const two = fake({ holiday: HOL, store });
  assert.strictEqual(two.holidayRunView().maints, 1, 'a restart keeps the count');
  const over = fake({ holiday: null, store });
  assert.strictEqual(over.holidayRunView(), null, 'no holiday, nothing to show');
  assert.strictEqual(store['holidayRun:a6'], null, 'and the count is dropped');
});

t('an offline console does not throw the count away — it just cannot see', () => {
  const store = {};
  fake({ holiday: HOL, store }).noteMaintenanceEnded();
  const off = fake({ holiday: null, connected: false, store });
  const v = off.holidayRunView();
  assert.ok(v && v.maints === 1, 'still counted while offline');
  assert.ok(store['holidayRun:a6'], 'nothing was cleared');
});

t('the FurloughBuff counts as holiday even before the login reply is in', () => {
  const f = fake({ holiday: null });
  f.game.player.buffs = [{ typeId: 'FurloughBuff', descName: '', endTime: Date.now() + 36e5 }];
  const v = f.holidayRunView();
  assert.ok(v && v.since > 0, 'the buff alone is enough to start counting');
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
