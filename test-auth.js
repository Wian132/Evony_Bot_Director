'use strict';
// Sign-in for OTTObot. These pages control live game accounts and the Director's
// editor shows their stored passwords, so each of these is a test that one
// customer's fleet stays shut to everyone else.
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

section('sessions belong to a user and an org');

const ORG = D.orgs.create('Test Fleet');
const USER = D.users.create({ email: 'a@x.com', passwordHash: A.hashPassword('pw') });
D.users.join(USER.id, ORG.id, 'owner');

t('a fresh session resolves to its user and org', () => {
  const sid = A.newSession(USER.id, ORG.id, '1.2.3.4', 'test');
  const r = A.resolveSession(sid);
  assert.strictEqual(r.user.id, USER.id);
  assert.strictEqual(r.org.id, ORG.id);
});

t('a made-up session id resolves to nothing', () => {
  assert.strictEqual(A.resolveSession('deadbeef'), null);
  assert.strictEqual(A.resolveSession(''), null);
  assert.strictEqual(A.resolveSession(null), null);
});

t('session ids are long and random', () => {
  const a = A.newSession(USER.id, ORG.id, '1.2.3.4', 't');
  const b = A.newSession(USER.id, ORG.id, '1.2.3.4', 't');
  assert.strictEqual(a.length, 64);
  assert.notStrictEqual(a, b);
});

t('signing out revokes only that session', () => {
  const a = A.newSession(USER.id, ORG.id, '1.1.1.1', 't');
  const b = A.newSession(USER.id, ORG.id, '2.2.2.2', 't');
  A.endSession(a);
  assert.strictEqual(A.resolveSession(a), null);
  assert.ok(A.resolveSession(b));
});

t('an expired session is rejected', () => {
  const sid = A.newSession(USER.id, ORG.id, '1.2.3.4', 't');
  D.run('UPDATE user_sessions SET expiresAt = ? WHERE sid = ?', Date.now() - 1000, sid);
  assert.strictEqual(A.resolveSession(sid), null);
});

t('revoking a user ends every one of their sessions', () => {
  const a = A.newSession(USER.id, ORG.id, '1.1.1.1', 't');
  const b = A.newSession(USER.id, ORG.id, '2.2.2.2', 't');
  A.revokeAll(USER.id);
  assert.strictEqual(A.resolveSession(a), null);
  assert.strictEqual(A.resolveSession(b), null);
});

section('cookie parsing');

t('the session cookie is read out of a normal header', () => {
  const c = A.cookiesOf({ headers: { cookie: 'a=1; otto_sid=abc123; theme=light' } });
  assert.strictEqual(c.otto_sid, 'abc123');
});

t('a missing or malformed cookie header is harmless', () => {
  assert.deepStrictEqual(A.cookiesOf({ headers: {} }), {});
  assert.strictEqual(A.cookiesOf({ headers: { cookie: ';;; =x; junk' } }).otto_sid, undefined);
});

section('register and sign in');

t('registering creates a user who owns a brand new org', () => {
  const r = A.register({ email: 'new@x.com', password: 'long-enough-pw', orgName: 'Newbie Fleet' });
  assert.ok(r.ok, r.error);
  assert.strictEqual(A.verifyPassword('long-enough-pw', r.user.passwordHash), true);
  assert.strictEqual(D.users.roleIn(r.user.id, r.org.id), 'owner');
  assert.strictEqual(r.org.name, 'Newbie Fleet');
});

t('a short password is refused', () => {
  assert.match(A.register({ email: 'x@y.com', password: 'short' }).error, /10 characters/);
});

t('a malformed email is refused', () => {
  for (const bad of ['notanemail', 'a@b', '', 'a b@c.com']) {
    assert.strictEqual(A.register({ email: bad, password: 'long-enough-pw' }).ok, false, 'accepted ' + bad);
  }
});

t('the same email cannot register twice', () => {
  assert.match(A.register({ email: 'new@x.com', password: 'long-enough-pw' }).error, /already registered/);
});

t('wrong password and unknown email give the SAME message', () => {
  const wrong = A.signIn({ email: 'new@x.com', password: 'nope' });
  const unknown = A.signIn({ email: 'nobody@nowhere.com', password: 'nope' });
  assert.strictEqual(wrong.ok, false);
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(wrong.error, unknown.error,
    'the form reveals whether an email is registered here');
});

t('signing in is case-insensitive on the email', () => {
  assert.strictEqual(A.signIn({ email: 'NEW@X.COM', password: 'long-enough-pw' }).ok, true);
});

t('a disabled user cannot sign in', () => {
  const u = D.users.byEmail('new@x.com');
  D.run('UPDATE users SET disabled = 1 WHERE id = ?', u.id);
  assert.strictEqual(A.signIn({ email: 'new@x.com', password: 'long-enough-pw' }).ok, false);
  D.run('UPDATE users SET disabled = 0 WHERE id = ?', u.id);
});

section('enabled state');

t('auth is on as soon as any user exists', () => {
  assert.strictEqual(A.isEnabled(), true);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
try { fs.rmSync(path.dirname(process.env.EVONY_DB), { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
