'use strict';
// When somebody else logs in to an account a console is playing, the server
// kicks the console. That person wants to play it, so the console leaves the
// account alone for KICK_HOLD_MS (30 minutes) before logging back in. Offline:
// the game login is a stub, the database is a temp file, and nothing here goes
// near the live Director or the consoles.
//
//   node test-kick-hold.js
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const EventEmitter = require('events');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-kick-'));
process.env.EVONY_DB = path.join(TMP, 't.db');
delete process.env.ACCOUNT_ID;
delete process.env.KICK_HOLD_MIN;

const D = require('./db');
const AUTH = require('./auth');
const op = AUTH.register({ email: 'op@example.com', password: 'correct horse battery', orgName: 'Kick Org' });
const ORG = D.org(op.org.id);
const A = ORG.accounts.upsert({ label: 'Alfa', server: 'ss0', email: 'a@example.com', password: 'x' });

// The game login, stubbed: a socket that looks live to Session.connected, and
// closes the way the real one does (a 'socket closed' log line).
let logins = 0;
const { Game } = require('./game');
let slowLogin = 0;                        // ms a stubbed login takes, for the in-flight test
Game.prototype.connect = async function () {
  logins++;
  if (slowLogin) await new Promise((r) => setTimeout(r, slowLogin));
  this.c = new EventEmitter();
  this.c.sock = { destroyed: false };
  this.c.lastFrameAt = Date.now();          // so the supervisor does not call the socket idle
  this.c.close = () => { if (!this.c.sock.destroyed) { this.c.sock.destroyed = true; this.c.emit('log', 'socket closed'); } };
  this.player = { playerInfo: { userName: 'alfa' }, castles: [] };
  this.castles = [];
};

const { Session } = require('./session');
const tests = [];
const t = (n, f) => tests.push([n, f]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, ms = 5000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    if (await f()) return;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(30);
  }
}
const said = (S, re) => S.log.some((l) => re.test(l.text || l.m || ''));
const freshSession = () => {
  ORG.settings.set('kickHold:' + A.id, null);
  return new Session(A.id);
};

t('the hold is 30 minutes', () => {
  assert.strictEqual(Session.KICK_HOLD_MS, 30 * 60000);
});

for (const cmd of ['server.KickedOut', 'gameClient.kickout']) {
  t(`${cmd} starts the hold, closes the socket and refuses every login`, async () => {
    const S = freshSession();
    await S.connect();
    assert.ok(S.connected, 'logged in');
    const before = Date.now();
    S.game.c.emit('cmd', cmd, { ip: '1.2.3.4' });
    assert.ok(!S.connected, 'the socket is closed');
    assert.strictEqual(S.state, 'kicked');
    const h = S.kickHold();
    assert.ok(h, 'a hold is on');
    assert.ok(h.until - before >= 30 * 60000 - 50 && h.until - before <= 30 * 60000 + 1000, 'for 30 minutes');
    assert.strictEqual(h.ip, '1.2.3.4');
    assert.ok(S.nextTryAt >= h.until, 'the next try is not before the hold ends');
    assert.match(S.disconnectReason, /another user logged into this account \(the game says so itself\) from 1\.2\.3\.4/);
    const n = logins;
    await assert.rejects(() => S.connect(), /another login took this account/);
    assert.strictEqual(logins, n, 'no login was spent');
  });
}

t('the supervisor waits the hold out instead of reconnecting in 2 seconds', async () => {
  const S = freshSession();
  await S.connect();
  S.game.c.emit('cmd', 'server.KickedOut', {});
  const n = logins;
  S.startSupervisor({ checkMs: 40 });
  try {
    await sleep(400);
    assert.strictEqual(logins, n, 'no login during the hold');
    assert.strictEqual(S.state, 'kicked');
    assert.ok(S.header().retryInSec > 29 * 60, 'the page is told when it comes back: ' + S.header().retryInSec);
  } finally { clearInterval(S._supervisor); }
});

t('once the hold runs out the supervisor logs back in', async () => {
  const S = freshSession();
  await S.connect();
  S.game.c.emit('cmd', 'server.KickedOut', {});
  const n = logins;
  S.startSupervisor({ checkMs: 40 });
  try {
    await sleep(150);
    assert.strictEqual(S.state, 'kicked', 'waiting the hold out');
    // Wind the clock on: the hold as it would read 30 minutes later.
    const h = S.kickHold();
    ORG.settings.set('kickHold:' + A.id, { ...h, at: h.at - 30 * 60000, until: Date.now() - 1 });
    S._kickReadAt = 0;
    await until(() => S.connected, 3000, 'the login after the hold');
    assert.strictEqual(logins, n + 1, 'one login');
    assert.ok(said(S, /the kick hold is over — logging back in/), 'and said so');
  } finally { clearInterval(S._supervisor); }
});

t('the hold survives a console restart', async () => {
  const S = freshSession();
  await S.connect();
  S.game.c.emit('cmd', 'gameClient.kickout', {});
  const again = new Session(A.id);
  assert.ok(again.kickHold(), 'a new console sees the hold');
  await assert.rejects(() => again.connect(), /another login took this account/);
});

t('Connect ends the hold early', async () => {
  const S = freshSession();
  await S.connect();
  S.game.c.emit('cmd', 'server.KickedOut', {});
  S.clearKickHold();
  assert.strictEqual(S.kickHold(), null);
  assert.strictEqual(ORG.settings.get('kickHold:' + A.id, null), null, 'and it is gone from the database');
  await S.connect();
  assert.ok(S.connected, 'logged back in');
});

t('an ordinary socket drop (no kick) still reconnects quickly', async () => {
  const S = freshSession();
  await S.connect();
  const before = Date.now();
  S.game.c.close();
  assert.strictEqual(S.kickHold(), null, 'no hold');
  assert.strictEqual(S.state, 'reconnecting');
  assert.ok(S.nextTryAt - before < 5000, 'the quick first retry');
});

t('a kick on a socket we have already replaced starts no hold', async () => {
  const S = freshSession();
  await S.connect();
  const old = S.game;
  S.game = null;
  await S.connect();
  old.c.emit('cmd', 'server.KickedOut', {});
  assert.strictEqual(S.kickHold(), null);
  assert.ok(S.connected, 'the live socket is left alone');
});

t('switched off still outranks a hold that has run out', async () => {
  const S = freshSession();
  ORG.accounts.upsert({ id: A.id, enabled: false });
  try {
    S._offReadAt = 0;
    await assert.rejects(() => S.connect(), /switched off in the Director/);
  } finally { ORG.accounts.upsert({ id: A.id, enabled: true }); }
});

// ---- the per-account "after a kick" minutes (2026-09-22) ----------------------------
// Real kicks (NEAT's logins) arrive as a bare close by the server: no kick message.
const setMin = (v) => ORG.settings.set('kickHoldMin:' + A.id, v);
const serverClose = (S, { byUs = false, hadError = false } = {}) => {
  S.game.c.closedByUs = byUs; S.game.c.closedHadError = hadError;
  S.game.c.sock.destroyed = true; S.game.c.emit('log', 'socket closed');
};

t('with "after a kick" set, a close by the server holds for those minutes', async () => {
  setMin(7);
  try {
    const S = freshSession(); S._khmReadAt = 0;
    await S.connect();
    const before = Date.now();
    serverClose(S);
    const h = S.kickHold();
    assert.ok(h, 'a hold is on');
    assert.strictEqual(h.source, 'close');
    assert.ok(h.until - before >= 7 * 60000 - 50 && h.until - before <= 7 * 60000 + 1000, 'for 7 minutes');
    assert.strictEqual(S.state, 'kicked');
    assert.match(S.disconnectReason, /the server closed the connection \(another login/);
    assert.ok(said(S, /socket closed by the server — the last it sent/), 'the close says who ended it');
    const n = logins;
    await assert.rejects(() => S.connect(), /staying out until/);
    assert.strictEqual(logins, n, 'no login was spent');
  } finally { setMin(null); }
});

t('a close WE made, or one a socket error explains, is not a kick', async () => {
  setMin(7);
  try {
    for (const how of [{ byUs: true }, { hadError: true }]) {
      const S = freshSession(); S._khmReadAt = 0;
      await S.connect();
      serverClose(S, how);
      assert.strictEqual(S.kickHold(), null, JSON.stringify(how));
      assert.strictEqual(S.state, 'reconnecting');
    }
  } finally { setMin(null); }
});

t('not set, or 0: a server close reconnects straight away, as before', async () => {
  for (const v of [null, 0]) {
    setMin(v);
    const S = freshSession(); S._khmReadAt = 0;
    await S.connect();
    serverClose(S);
    assert.strictEqual(S.kickHold(), null, 'no hold for ' + v);
    assert.strictEqual(S.state, 'reconnecting');
  }
  setMin(null);
});

t('0 also means an explicit kick message comes straight back', async () => {
  setMin(0);
  try {
    const S = freshSession(); S._khmReadAt = 0;
    await S.connect();
    S.game.c.emit('cmd', 'server.KickedOut', { ip: '1.2.3.4' });
    assert.strictEqual(S.kickHold(), null);
    assert.ok(said(S, /set to come straight back/));
  } finally { setMin(null); }
});

t('an explicit kick with minutes set holds for those minutes, not 30', async () => {
  setMin(300);
  try {
    const S = freshSession(); S._khmReadAt = 0;
    await S.connect();
    const before = Date.now();
    S.game.c.emit('cmd', 'server.KickedOut', {});
    const h = S.kickHold();
    assert.ok(h.until - before >= 300 * 60000 - 50 && h.until - before <= 300 * 60000 + 1000);
  } finally { setMin(null); }
});

// ---- server.ConnectionLost is the game's "another user has logged into your account" ----
// (proved live on Lord02, 2026-09-22: every drop ended in it, and NEAT on the other
// side logged that very sentence at the same second)

t('server.ConnectionLost is a kick: it holds, closes the socket and says so plainly', async () => {
  const S = freshSession();
  await S.connect();
  S.game.c.emit('cmd', 'server.ConnectionLost', {});
  assert.ok(!S.connected, 'the socket is closed');
  assert.strictEqual(S.state, 'kicked');
  assert.ok(S.kickHold(), 'a hold is on');
  assert.ok(said(S, /ANOTHER USER HAS LOGGED INTO THIS ACCOUNT/), 'the log says it in as many words');
  assert.ok(S.lastKick() && S.lastKick().cmd === 'server.ConnectionLost', 'and it is remembered for the page');
  ORG.settings.set('kickHold:' + A.id, null);
  ORG.settings.set('lastKick:' + A.id, null);
});

t('with no minutes set it is the fleet default, 30 minutes — as NEAT pauses', async () => {
  const S = freshSession();
  await S.connect();
  const before = Date.now();
  S.game.c.emit('cmd', 'server.ConnectionLost', {});
  const h = S.kickHold();
  assert.ok(h.until - before >= 30 * 60000 - 100 && h.until - before <= 30 * 60000 + 1000, '30 minutes');
  ORG.settings.set('kickHold:' + A.id, null);
});

t('a ConnectionLost while the server is going down is maintenance, not a kick', async () => {
  const S = freshSession();
  await S.connect();
  S.flagged = true; S.refreshMaintenance();
  try {
    S.game.c.emit('cmd', 'server.ConnectionLost', {});
    assert.strictEqual(S.kickHold(), null, 'no hold — the server is down for everyone');
  } finally { S.flagged = false; S.refreshMaintenance(); ORG.settings.set('kickHold:' + A.id, null); }
});

t('the header carries it, so a page can show it', async () => {
  const S = freshSession();
  await S.connect();
  S.game.c.emit('cmd', 'server.ConnectionLost', { ip: '5.6.7.8' });
  const h = S.header();
  assert.ok(h.kick && h.kick.until > Date.now(), 'the hold running now');
  assert.strictEqual(h.lastKick.ip, '5.6.7.8', 'who took it');
  assert.ok(h.kickStep >= 0 && 'kickHoldMin' in h, 'and where the ladder stands');
  ORG.settings.set('kickHold:' + A.id, null);
  ORG.settings.set('lastKick:' + A.id, null);
});

t('a login already on the wire when the hold starts hangs up instead of landing', async () => {
  const S = freshSession();
  slowLogin = 120;                       // the login takes a moment, as a real one does
  try {
    const p = S.connect();
    await sleep(20);
    S.holdForKick('9.9.9.9', { minutes: 30 });   // kicked while it is in flight
    await assert.rejects(() => p, /another user took this account while we were logging in/);
    assert.ok(!S.connected, 'it hung up rather than play on');
    assert.ok(said(S, /hanging up and leaving the account alone/));
  } finally { slowLogin = 0; ORG.settings.set('kickHold:' + A.id, null); }
});

// ---- the hold grows while the account goes on being refused ----
// (the user, 2026-09-22: "5min then 10min if still refused 15min then 20 etc")

const stepOf = () => Number(ORG.settings.get('kickHoldStep:' + A.id, 0)) || 0;
const setStep = (n) => ORG.settings.set('kickHoldStep:' + A.id, n);

t('each refusal in a row adds another step: 5, 10, 15, 20', async () => {
  setMin(5); setStep(0);
  try {
    for (const want of [5, 10, 15, 20]) {
      const S = freshSession(); S._khmReadAt = 0;
      await S.connect();
      const before = Date.now();
      S.game.c.emit('cmd', 'server.KickedOut', {});
      const h = S.kickHold();
      assert.strictEqual(h.minutes, want, `hold ${want} min`);
      assert.ok(h.until - before >= want * 60000 - 100 && h.until - before <= want * 60000 + 1000, 'and it really waits that long');
      ORG.settings.set('kickHold:' + A.id, null);        // let the next one through
    }
  } finally { setMin(null); setStep(0); }
});

t('a login that holds puts it back to one step', async () => {
  setMin(5); setStep(3);
  const was = Session.SETTLED_MS;
  Session.SETTLED_MS = 60;
  try {
    const S = freshSession(); S._khmReadAt = 0;
    S.checkMaintenance = async () => S.maint;
    S.portOpen = async () => false;
    S.startSupervisor({ checkMs: 25 });
    await until(() => stepOf() === 0, 4000, 'the ladder to reset');
    S.stopSupervisor();
    const S2 = freshSession(); S2._khmReadAt = 0;
    await S2.connect();
    S2.game.c.emit('cmd', 'server.KickedOut', {});
    assert.strictEqual(S2.kickHold().minutes, 5, 'the next hold is one step again');
  } finally { Session.SETTLED_MS = was; setMin(null); setStep(0); }
});

t('the ladder is capped, but never below the minutes you asked for', async () => {
  setMin(5); setStep(100);
  try {
    const S = freshSession(); S._khmReadAt = 0;
    await S.connect();
    S.game.c.emit('cmd', 'server.KickedOut', {});
    assert.strictEqual(S.kickHold().minutes, Session.KICK_HOLD_MAX_MIN, 'capped at an hour');
  } finally { setMin(null); setStep(0); }
});

t('0 still means straight back, and no ladder is started', async () => {
  setMin(0); setStep(0);
  try {
    const S = freshSession(); S._khmReadAt = 0;
    await S.connect();
    S.game.c.emit('cmd', 'server.KickedOut', {});
    assert.strictEqual(S.kickHold(), null, 'no hold');
    assert.strictEqual(stepOf(), 0, 'and no step');
  } finally { setMin(null); }
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log('  ok    ' + n); pass++; }
    catch (e) { console.log('  FAIL  ' + n + '\n        ' + String((e && e.stack) || e).split('\n').slice(0, 6).join('\n        ')); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
