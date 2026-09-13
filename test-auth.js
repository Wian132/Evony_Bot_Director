'use strict';
// The login gate. These pages control live accounts and the Director's editor
// shows stored passwords, so each of these is a test that the fleet stays shut.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-auth-')), 't.db');
const A = require('./auth');
const D = require('./db');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log('  ok    ' + n); pass++; }
  catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message); fail++; } };
const section = (s) => console.log('\n' + s + '\n');

section('password storage');

t('the password is never stored in plain text', () => {
  const h = A.hashPassword('hunter2');
  assert.ok(!h.includes('hunter2'));
  assert.ok(h.startsWith('scrypt$'));
});

t('the right password verifies', () => {
  assert.strictEqual(A.verifyPassword('hunter2', A.hashPassword('hunter2')), true);
});

t('a wrong password does not', () => {
  const h = A.hashPassword('hunter2');
  assert.strictEqual(A.verifyPassword('hunter3', h), false);
  assert.strictEqual(A.verifyPassword('', h), false);
  assert.strictEqual(A.verifyPassword('HUNTER2', h), false);
});

t('the same password hashes differently every time (unique salt)', () => {
  assert.notStrictEqual(A.hashPassword('same'), A.hashPassword('same'));
});

t('garbage stored values are refused, not crashed on', () => {
  for (const bad of [null, undefined, '', 'plain', 'scrypt$', 'md5$a$b', 'scrypt$salt']) {
    assert.strictEqual(A.verifyPassword('x', bad), false, 'accepted ' + JSON.stringify(bad));
  }
});

section('sessions');

t('a fresh session is valid and a made-up one is not', () => {
  const sid = A.newSession('1.2.3.4', 'test');
  assert.strictEqual(A.validSession(sid), true);
  assert.strictEqual(A.validSession('deadbeef'), false);
  assert.strictEqual(A.validSession(''), false);
  assert.strictEqual(A.validSession(null), false);
});

t('session ids are long and random', () => {
  const a = A.newSession('1.2.3.4', 't'), b = A.newSession('1.2.3.4', 't');
  assert.strictEqual(a.length, 64);
  assert.notStrictEqual(a, b);
});

t('signing out revokes only that session', () => {
  const a = A.newSession('1.1.1.1', 't'), b = A.newSession('2.2.2.2', 't');
  A.endSession(a);
  assert.strictEqual(A.validSession(a), false);
  assert.strictEqual(A.validSession(b), true);
});

t('an expired session is rejected', () => {
  const sid = A.newSession('1.2.3.4', 't');
  const all = D.settings.get('authSessions', {});
  all[sid].expires = Date.now() - 1000;
  D.settings.set('authSessions', all);
  assert.strictEqual(A.validSession(sid), false);
});

t('revokeAll clears everything', () => {
  A.newSession('1.1.1.1', 't');
  const sid = A.newSession('2.2.2.2', 't');
  A.revokeAll();
  assert.strictEqual(A.validSession(sid), false);
});

section('cookie parsing');

t('the session cookie is read out of a normal header', () => {
  const c = A.cookiesOf({ headers: { cookie: 'a=1; evony_sid=abc123; theme=light' } });
  assert.strictEqual(c.evony_sid, 'abc123');
});

t('a missing or malformed cookie header is harmless', () => {
  assert.deepStrictEqual(A.cookiesOf({ headers: {} }), {});
  assert.strictEqual(A.cookiesOf({ headers: { cookie: ';;; =x; junk' } }).evony_sid, undefined);
});

section('enabled state');

t('auth is off until a password is set', () => {
  D.settings.set('authHash', null);
  assert.strictEqual(A.isEnabled(), false);
  D.settings.set('authHash', A.hashPassword('pw'));
  assert.strictEqual(A.isEnabled(), true);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
try { fs.rmSync(path.dirname(process.env.EVONY_DB), { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
