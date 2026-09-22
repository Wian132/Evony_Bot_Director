'use strict';
// A console that keeps trying to log in but never really comes in — either the
// login fails, or it lands and the server drops it again seconds later — closes
// the socket, moves its account to another proxy line and starts again (the user,
// 2026-09-22, after Lord02 spent five hours logging in every ten seconds).
// Offline: the game login is a stub, the database is a temp file, and nothing here
// goes near the live Director, the consoles or a real proxy.
//
//   node test-proxy-rotate.js
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const EventEmitter = require('events');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-rot-'));
process.env.EVONY_DB = path.join(TMP, 't.db');
delete process.env.ACCOUNT_ID;
delete process.env.KICK_HOLD_MIN;

const D = require('./db');
const AUTH = require('./auth');
const op = AUTH.register({ email: 'op@example.com', password: 'correct horse battery', orgName: 'Rotate Org' });
const ORG = D.org(op.org.id);
const PP = require('./proxy-pick');

const LINES = ['1.1.1.1:1000', '2.2.2.2:2000', '3.3.3.3:3000', '4.4.4.4:4000'];
ORG.settings.set('proxyText', LINES.join('\n'));

const A = ORG.accounts.upsert({ label: 'Alfa', server: 'ss0', email: 'a@example.com', password: 'x', proxy: LINES[0] });
const B = ORG.accounts.upsert({ label: 'Bravo', server: 'ss0', email: 'b@example.com', password: 'x', proxy: LINES[1] });

// The game login, stubbed. `mode` decides what a login does:
//   'ok'   in, and it stays in
//   'fail' the login throws, the way a dead proxy's does
//   'flap' in, then the server closes the socket a moment later
let mode = 'ok';
let logins = 0, lastProxy = null;
const { Game } = require('./game');
Game.prototype.connect = async function (server, email, password, proxy) {
  logins++;
  lastProxy = proxy ? proxy.raw : null;
  if (mode === 'fail') throw new Error('no reply to server.LoginResponse');
  this.proxy = proxy;
  this.c = new EventEmitter();
  this.c.sock = { destroyed: false };
  this.c.lastFrameAt = Date.now();          // so the supervisor does not call it idle
  this.c.close = () => { if (!this.c.sock.destroyed) { this.c.sock.destroyed = true; this.c.emit('log', 'socket closed'); } };
  this.player = { playerInfo: { userName: 'alfa' }, castles: [] };
  this.castles = [];
  if (mode === 'flap') setTimeout(() => { try { this.c.close(); } catch {} }, 30);
};

const { Session } = require('./session');
// the real waits are 10 minutes and 2 minutes; this test runs them in milliseconds
Session.ROTATE_AFTER_MS = 300;
Session.SETTLED_MS = 5000;
Session.ROTATE_MAX_MS = 2000;
Session.ROTATE_PAUSE_MS = 40;              // the real one rests a minute before the new line

const tests = [];
const t = (n, f) => tests.push([n, f]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, ms = 5000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    if (await f()) return;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(20);
  }
}
const said = (S, re) => S.log.some((l) => re.test(l.text || l.m || ''));
const proxyOf = (acc) => { const p = PP.forAccount(ORG, ORG.accounts.get(acc.id)); return p ? p.raw : null; };
function fresh(acc) {
  ORG.settings.set(PP.overrideKey(acc.id), null);
  ORG.settings.set(PP.avoidKey(acc.id), {});
  ORG.settings.set('kickHold:' + acc.id, null);
  ORG.accounts.upsert({ id: acc.id, enabled: true });
  const S = new Session(acc.id);
  S.checkMaintenance = async () => S.maint;      // no web call in a test
  S.portOpen = async () => false;                // and no real socket to a game server
  return S;
}

// ---- proxy-pick: the move itself ----

t('a move takes a free line, not the one it is on and not another account\'s', () => {
  ORG.settings.set(PP.overrideKey(A.id), null);
  ORG.settings.set(PP.avoidKey(A.id), {});
  assert.strictEqual(proxyOf(A), LINES[0], 'it starts on its pin');
  const p = PP.rotate(ORG, ORG.accounts.get(A.id), { why: 'a test' });
  assert.ok(p, 'it moved');
  assert.notStrictEqual(p.raw, LINES[0], 'off the line it was on');
  assert.notStrictEqual(p.raw, LINES[1], 'not onto Bravo\'s');
  assert.strictEqual(proxyOf(A), p.raw, 'and that is where it logs in from now');
  assert.strictEqual(ORG.accounts.get(A.id).proxy, LINES[0], 'the pin you chose is untouched');
});

t('a second move does not hand back the line it just left', () => {
  const first = proxyOf(A);
  const p = PP.rotate(ORG, ORG.accounts.get(A.id), { why: 'a test' });
  assert.ok(p, 'it moved again');
  assert.notStrictEqual(p.raw, first);
  assert.notStrictEqual(p.raw, LINES[0], 'nor the one before that');
  assert.notStrictEqual(p.raw, LINES[1], 'still not Bravo\'s');
});

t('it never takes a line another account is on — it stays where it is', () => {
  // only two lines in the world, and Bravo holds one of them
  ORG.settings.set('proxyText', [LINES[0], LINES[1]].join('\n'));
  ORG.settings.set(PP.overrideKey(A.id), null);
  ORG.settings.set(PP.avoidKey(A.id), {});
  const notes = [];
  const p = PP.rotate(ORG, ORG.accounts.get(A.id), { note: (m) => notes.push(m), why: 'a test' });
  assert.strictEqual(p, null, 'nothing free to move to');
  assert.ok(/no other proxy line is free/.test(notes.join(' ')), 'and it says so');
  assert.strictEqual(proxyOf(A), LINES[0], 'so it stays where it was — one proxy per account');
  ORG.settings.set('proxyText', LINES.join('\n'));
});

t('a moved account counts as pinned when the lines are shared out', () => {
  const moved = proxyOf(A);
  const C = ORG.accounts.upsert({ label: 'Charlie', server: 'ss0', email: 'c@example.com', password: 'x', proxy: 'random' });
  const assign = PP.assignAll(ORG, {});
  assert.strictEqual((assign.get(A.id) || {}).raw, moved, 'the move stands');
  assert.notStrictEqual((assign.get(C.id) || {}).raw, moved, 'and nobody is given it');
  ORG.accounts.remove(C.id);
});

t('a line that leaves the list ends the move', () => {
  const moved = proxyOf(A);
  ORG.settings.set('proxyText', LINES.filter((l) => l !== moved).join('\n'));
  assert.strictEqual(proxyOf(A), LINES[0], 'back on its own pin');
  ORG.settings.set('proxyText', LINES.join('\n'));
});

t('a line that fails its test ends the move', () => {
  ORG.settings.set(PP.overrideKey(A.id), null);
  ORG.settings.set(PP.avoidKey(A.id), {});
  const p = PP.rotate(ORG, ORG.accounts.get(A.id), { why: 'a test' });
  ORG.settings.set('proxyTests', { [p.raw]: { ok: false, at: Date.now() } });
  assert.strictEqual(proxyOf(A), LINES[0], 'back on its own pin');
  ORG.settings.set('proxyTests', {});
});

t('choosing a proxy yourself puts it back', () => {
  ORG.settings.set(PP.overrideKey(A.id), null);
  ORG.settings.set(PP.avoidKey(A.id), {});
  PP.rotate(ORG, ORG.accounts.get(A.id), { why: 'a test' });
  assert.notStrictEqual(proxyOf(A), LINES[0]);
  assert.ok(PP.clearOverride(ORG, A.id), 'there was a move to drop');
  assert.strictEqual(proxyOf(A), LINES[0]);
});

t('an account that logs in direct has nothing to move', () => {
  const dir = ORG.accounts.upsert({ label: 'Delta', server: 'ss0', email: 'd@example.com', password: 'x', proxy: '' });
  const notes = [];
  assert.strictEqual(PP.rotate(ORG, ORG.accounts.get(dir.id), { note: (m) => notes.push(m) }), null);
  assert.ok(/direct/.test(notes.join(' ')), 'and it says so');
  ORG.accounts.remove(dir.id);
});

// ---- the console: when it decides it is stuck ----

t('logins that keep failing move the account to another proxy', async () => {
  mode = 'fail';
  const S = fresh(A);
  const was = proxyOf(A);
  S.startSupervisor({ checkMs: 25 });
  try {
    await until(() => proxyOf(A) !== was, 5000, 'the proxy to change');
    assert.ok(said(S, /trying to log in without getting in — changing proxy/), 'it says why');
    assert.ok(said(S, /now logging in through/), 'and where it went');
    assert.strictEqual(S.troubleRotations >= 1, true);
    await until(() => lastProxy === proxyOf(A), 5000, 'the next login to go through the new line');
  } finally { S.stopSupervisor(); mode = 'ok'; }
});

t('a login that lands and is dropped again counts as never getting in', async () => {
  mode = 'flap';
  const S = fresh(A);
  const was = proxyOf(A);
  S.startSupervisor({ checkMs: 25 });
  try {
    await until(() => proxyOf(A) !== was, 5000, 'the proxy to change');
    assert.ok(said(S, /logging in and being dropped again — closing the socket and changing proxy/)
      || said(S, /trying to log in without getting in — changing proxy/), 'it says why');
  } finally { S.stopSupervisor(); mode = 'ok'; }
});

t('each move in the same spell waits longer than the last', async () => {
  mode = 'fail';
  const S = fresh(A);
  S.startSupervisor({ checkMs: 25 });
  try {
    await until(() => (S.troubleRotations || 0) >= 2, 6000, 'a second move');
    assert.ok(S.troubleWaitMs > Session.ROTATE_AFTER_MS, 'the wait grew');
    assert.ok(S.troubleWaitMs <= Session.ROTATE_MAX_MS, 'and is capped');
  } finally { S.stopSupervisor(); mode = 'ok'; }
});

t('a login that holds ends the spell, and nothing is moved', async () => {
  mode = 'ok';
  const S = fresh(A);
  Session.SETTLED_MS = 100;
  const was = proxyOf(A);
  S.startSupervisor({ checkMs: 25 });
  try {
    await until(() => S.connected, 3000, 'it to log in');
    await until(() => S.troubleSince === 0, 3000, 'the spell to end');
    await sleep(600);                       // twice ROTATE_AFTER_MS
    assert.strictEqual(proxyOf(A), was, 'it stayed where it was');
    assert.strictEqual(S.troubleRotations, 0);
  } finally { S.stopSupervisor(); Session.SETTLED_MS = 5000; }
});

t('a switched-off account is not stuck — it is off, and keeps its proxy', async () => {
  mode = 'fail';
  const S = fresh(A);
  const was = proxyOf(A);
  ORG.accounts.upsert({ id: A.id, enabled: false });
  S.startSupervisor({ checkMs: 25 });
  try {
    await until(() => S.state === 'off', 3000, 'it to go off');
    await sleep(600);
    assert.strictEqual(proxyOf(A), was, 'nothing moved');
    assert.strictEqual(S.troubleSince, 0);
  } finally { S.stopSupervisor(); ORG.accounts.upsert({ id: A.id, enabled: true }); mode = 'ok'; }
});

t('a kick hold is not stuck either — somebody else is playing it', async () => {
  mode = 'fail';
  const S = fresh(A);
  const was = proxyOf(A);
  S.holdForKick('9.9.9.9', { minutes: 30 });
  S.startSupervisor({ checkMs: 25 });
  try {
    await until(() => S.state === 'kicked', 3000, 'the hold to take');
    await sleep(600);
    assert.strictEqual(proxyOf(A), was, 'nothing moved');
    assert.strictEqual(S.troubleSince, 0);
  } finally { S.stopSupervisor(); S.clearKickHold(); mode = 'ok'; }
});

t('standing down for maintenance is not stuck — no proxy fixes a closed server', async () => {
  mode = 'fail';
  const S = fresh(A);
  const was = proxyOf(A);
  S.flagged = true; S.refreshMaintenance();  // paused: the server is down for everyone
  S.startSupervisor({ checkMs: 25 });
  try {
    await until(() => S.state === 'maintenance', 3000, 'it to pause');
    await sleep(600);
    assert.strictEqual(proxyOf(A), was, 'nothing moved');
    assert.strictEqual(S.troubleSince, 0);
  } finally { S.stopSupervisor(); S.flagged = false; S.refreshMaintenance(); mode = 'ok'; }
});

(async () => {
  let bad = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log('ok   ' + n); }
    catch (e) { bad++; console.log('FAIL ' + n + '\n     ' + e.message); }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(bad ? `\n${bad} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(bad ? 1 : 0);
})();
