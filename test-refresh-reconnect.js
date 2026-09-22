'use strict';
// The page's Refresh button is F5 for the account: drop the socket, log in
// afresh now, whatever the backoff says. Offline: the game login is a stub, the
// database is a temp file, and nothing here goes near the live consoles.
//
//   node test-refresh-reconnect.js
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const EventEmitter = require('events');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-refresh-'));
process.env.EVONY_DB = path.join(TMP, 't.db');
delete process.env.ACCOUNT_ID;

const D = require('./db');
const AUTH = require('./auth');
const op = AUTH.register({ email: 'op@example.com', password: 'correct horse battery', orgName: 'Refresh Org' });
const ORG = D.org(op.org.id);
const A = ORG.accounts.upsert({ label: 'Alfa', server: 'ss0', email: 'a@example.com', password: 'x' });

// The game login, stubbed. The real socket's 'close' event comes a tick after
// close() is called, so this one does too.
let logins = 0, failNext = null;
const { Game } = require('./game');
Game.prototype.connect = async function () {
  logins++;
  if (failNext) { const e = failNext; failNext = null; throw e; }
  this.c = new EventEmitter();
  this.c.sock = { destroyed: false };
  this.c.close = () => {
    if (this.c.sock.destroyed) return;
    this.c.sock.destroyed = true;
    setImmediate(() => this.c.emit('log', 'socket closed'));
  };
  this.player = { playerInfo: { userName: 'alfa' }, castles: [] };
  this.castles = [];
};

const { Session } = require('./session');
const tests = [];
const t = (n, f) => tests.push([n, f]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fresh = () => { ORG.settings.set('kickHold:' + A.id, null); return new Session(A.id); };

t('a live socket is replaced by a fresh login', async () => {
  const S = fresh();
  await S.connect();
  const old = S.game, before = logins;
  await S.reconnect();
  assert.strictEqual(logins, before + 1, 'one new login');
  assert.notStrictEqual(S.game, old, 'a new game object');
  assert.ok(old.c.sock.destroyed, 'the old socket is closed');
  assert.ok(S.connected);
});

t('the old socket closing late does not mark the new one reconnecting', async () => {
  const S = fresh();
  await S.connect();
  await S.reconnect();
  await sleep(20);                              // let the old close event land
  assert.strictEqual(S.state, 'connected');
  assert.ok(!(S.nextTryAt > Date.now()), 'no retry was scheduled');
});

t('a real drop of the live socket still hands over to the supervisor', async () => {
  const S = fresh();
  await S.connect();
  S.game.close();
  await sleep(20);
  assert.strictEqual(S.state, 'reconnecting');
});

t('a disconnected session with a long backoff logs in at once', async () => {
  const S = fresh();
  S.attempt = 5; S.backoffMs = 300000; S.nextTryAt = Date.now() + 300000;
  await S.reconnect();
  assert.ok(S.connected);
  assert.strictEqual(S.attempt, 0);
  assert.strictEqual(S.nextTryAt, 0);
});

t('a kick hold is ended, as Connect ends it', async () => {
  const S = fresh();
  S.holdForKick('1.2.3.4');
  await assert.rejects(() => S.connect(), /another login took this account/);
  await S.reconnect();
  assert.ok(S.connected);
  assert.strictEqual(S.kickHold(), null);
});

t('a failed login is reported and the supervisor retries on the ladder', async () => {
  const S = fresh();
  await S.connect();
  failNext = Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' });
  await assert.rejects(() => S.reconnect(), /ETIMEDOUT/);
  assert.ok(!S.connected);
  assert.strictEqual(S.state, 'reconnecting');
  assert.match(S.disconnectReason, /ETIMEDOUT/);
  assert.ok(S.nextTryAt > Date.now(), 'a retry is scheduled');
});

t('switched off still wins', async () => {
  const S = fresh();
  ORG.accounts.upsert({ id: A.id, enabled: false });
  try {
    S._offReadAt = 0;
    await assert.rejects(() => S.reconnect(), /switched off in the Director/);
  } finally { ORG.accounts.upsert({ id: A.id, enabled: true }); }
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
