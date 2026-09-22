'use strict';
// The session's heartbeat must prove the server still answers us without cycling a
// socket that is merely busy. The server takes an account's commands about one at a
// time, so a heartbeat queued behind a burst of market orders can wait a long time;
// on 2026-09-18 that dropped Lord06 again and again. Offline: the game login is a stub,
// the database is a temp file, and nothing here goes near the live Director or the
// consoles.
//
//   node test-heartbeat.js
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const EventEmitter = require('events');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-beat-'));
process.env.EVONY_DB = path.join(TMP, 't.db');
delete process.env.ACCOUNT_ID;

const D = require('./db');
const AUTH = require('./auth');
const op = AUTH.register({ email: 'op@example.com', password: 'correct horse battery', orgName: 'Beat Org' });
const ORG = D.org(op.org.id);
const A = ORG.accounts.upsert({ label: 'Alfa', server: 'ss0', email: 'a@example.com', password: 'x' });

// The game login, stubbed: a socket that looks live, keeps receiving frames (so the
// idle rule stays out of it), and closes the way the real one does.
const { Game } = require('./game');
const realConnect = Game.prototype.connect;
let pings = 0, pingReply = 'ok';
Game.prototype.connect = async function () {
  this.c = new EventEmitter();
  this.c.sock = { destroyed: false };
  this.c.lastFrameAt = Date.now();
  this.c.close = () => { if (!this.c.sock.destroyed) { this.c.sock.destroyed = true; this.c.emit('log', 'socket closed'); } };
  this.player = { playerInfo: { userName: 'alfa' }, castles: [] };
  this.castles = [];
};
Game.prototype.ping = async function (ms) {
  pings++;
  this.c.lastFrameAt = Date.now();
  if (pingReply === 'ok') return true;
  await new Promise((r) => setTimeout(r, Math.min(ms, 60)));
  throw new Error('no reply to common.getPlayerInfoByName');
};

const { Session } = require('./session');
const tests = [];
const t = (n, f) => tests.push([n, f]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const said = (S, re) => S.log.some((l) => re.test(l.m || ''));
const OPTS = { checkMs: 20, heartbeatMs: 100, pingMs: 60, idleLimitMs: 1e9 };
async function running(fn) {
  const S = new Session(A.id);
  await S.connect();
  const keepFresh = setInterval(() => { if (S.game && S.game.c) S.game.c.lastFrameAt = Date.now(); }, 20);
  S.startSupervisor(OPTS);
  try { await fn(S); } finally { clearInterval(S._supervisor); clearInterval(keepFresh); }
}

t('while the server keeps answering our commands, no heartbeat is sent', async () => {
  pings = 0; pingReply = 'fail';
  await running(async (S) => {
    const c = S.game.c;
    const answering = setInterval(() => { c.lastReplyAt = Date.now(); }, 30);
    try { await sleep(450); } finally { clearInterval(answering); }
    assert.strictEqual(pings, 0, 'no heartbeat queued behind the work');
    assert.ok(S.connected, 'the socket is kept');
  });
});

t('a slow heartbeat on a server still answering other commands keeps the socket', async () => {
  pings = 0; pingReply = 'fail';
  await running(async (S) => {
    const c = S.game.c;
    // our other commands are answered only WHILE the heartbeat waits
    const orig = S.game.ping;
    S.game.ping = async function (ms) { setTimeout(() => { c.lastReplyAt = Date.now(); }, 20); return orig.call(this, ms); };
    await sleep(300);
    assert.ok(pings >= 1, 'a heartbeat was sent');
    assert.ok(S.connected, 'the socket is kept');
    assert.ok(said(S, /heartbeat slow .* still answering — keeping the socket/), 'and it said so');
  });
});

t('a heartbeat with no answer to anything closes the socket, and says WE closed it', async () => {
  pings = 0; pingReply = 'fail';
  await running(async (S) => {
    await sleep(300);
    assert.ok(pings >= 1);
    assert.ok(said(S, /heartbeat failed \(no reply in 0s, 0 market writes in flight\) — cycling the socket/), 'the note names the wait and the queue');
    assert.match(String(S.disconnectReason), /no reply to the heartbeat .* we closed the socket/);
  });
});

t('an answered heartbeat keeps the socket', async () => {
  pings = 0; pingReply = 'ok';
  await running(async (S) => {
    await sleep(300);
    assert.ok(pings >= 1);
    assert.ok(S.connected);
  });
});

t('connection notes go to the console output, stamped; other notes do not', async () => {
  const S = new Session(A.id);
  const out = [];
  const log = console.log;
  console.log = (m) => out.push(String(m));
  try {
    S.note('socket closed — supervisor will reconnect');
    S.note('heartbeat failed (no reply in 30s, 20 market writes in flight) — cycling the socket');
    S.note('refresh — logging in afresh');
    S.note('autorun: glitch-res-sell.txt started in 3');
  } finally { console.log = log; }
  assert.strictEqual(out.length, 3, out.join(' | '));
  assert.ok(out.every((l) => /^\[conn\] \d\d:\d\d:\d\d\.\d{3} /.test(l)), out[0]);
});

t('three unanswered commands are noted with the market queue at that moment', async () => {
  const S = new Session(A.id);
  const g = await S.connect();
  g.pipeInFlight = () => 20;
  g.pipeQueued = () => 70;
  g.c.emit('log', 'THREE commands in a row went unanswered while the socket is open — the server is ignoring this account (rate limit). Back off and let it settle.');
  assert.ok(said(S, /three commands in a row unanswered .* \(20 market writes in flight, 70 waiting\)/));
});

t('a login that fails closes its socket — none is left open to be logged in later', async () => {
  for (const why of ['no reply to server.LoginResponse/login/server.ErrorResponse', 'login refused (ok=-5)']) {
    const g = new Game(() => {});
    let closed = 0;
    g._connect = async function () {
      this.c = { close: () => { closed++; } };      // the socket is open by now
      throw new Error(why);
    };
    await assert.rejects(() => realConnect.call(g, 'ss0', 'a@example.com', 'x'), new RegExp(why.slice(0, 20).replace(/[()]/g, '.')));
    assert.strictEqual(closed, 1, `closed after: ${why}`);
  }
  // and a login that works keeps its socket
  const g = new Game(() => {});
  let closed = 0;
  g._connect = async function () { this.c = { close: () => { closed++; } }; };
  await realConnect.call(g, 'ss0', 'a@example.com', 'x');
  assert.strictEqual(closed, 0);
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log('  ok    ' + n); pass++; } catch (e) { console.log('  FAIL  ' + n + '\n        ' + String(e.message).split('\n').slice(0, 6).join('\n        ')); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
