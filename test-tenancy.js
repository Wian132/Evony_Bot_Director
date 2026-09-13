'use strict';
// Tenant isolation.
//
// The accounts table holds other people's game logins in plain text. Every test
// here is a test that one customer cannot reach another's, including by
// guessing or replaying an account id.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-ten-')), 't.db');
const D = require('./db');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log('  ok    ' + n); pass++; }
  catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message); fail++; } };
const section = (s) => console.log('\n' + s + '\n');
const throws = (fn, re, msg) => assert.throws(fn, (e) => re.test(e.message), msg);

// two tenants
const A = D.orgs.create('Acme Raiders');
const B = D.orgs.create('Rival Guild');
const a = D.org(A.id);
const b = D.org(B.id);

const aAcc = a.accounts.upsert({ label: 'AcmeMain', email: 'acme@x.com', password: 'acme-secret' });
const bAcc = b.accounts.upsert({ label: 'RivalMain', email: 'rival@x.com', password: 'rival-secret' });

section('accounts');

t('each org sees only its own', () => {
  assert.deepStrictEqual(a.accounts.all().map((x) => x.label), ['AcmeMain']);
  assert.deepStrictEqual(b.accounts.all().map((x) => x.label), ['RivalMain']);
});

t('a known id from another org does not resolve', () => {
  assert.strictEqual(a.accounts.get(bAcc.id), null);
  assert.strictEqual(b.accounts.get(aAcc.id), null);
});

t('and neither does their email', () => {
  assert.strictEqual(a.accounts.byEmail('rival@x.com'), null);
  assert.strictEqual(b.accounts.byEmail('acme@x.com'), null);
});

t('ids are unique across orgs, so one cannot shadow another', () => {
  assert.notStrictEqual(aAcc.id, bAcc.id);
});

t('upserting onto another org\'s id is refused, not silently reassigned', () => {
  throws(() => a.accounts.upsert({ id: bAcc.id, label: 'stolen' }), /another organization/);
  assert.strictEqual(b.accounts.get(bAcc.id).label, 'RivalMain', 'the row was modified anyway');
});

t('deleting another org\'s account is refused', () => {
  throws(() => a.accounts.remove(bAcc.id), /does not belong/);
  assert.ok(b.accounts.get(bAcc.id), 'it was deleted anyway');
});

t('passwords never appear in the other org\'s view', () => {
  const seen = JSON.stringify(a.accounts.all());
  assert.ok(!seen.includes('rival-secret'));
});

section('everything reached by account id');

t('goals', () => {
  a.goals.set(aAcc.id, 'default', 'goal', 'troop b:5k');
  b.goals.set(bAcc.id, 'default', 'goal', 'troop a:9k');
  assert.match(a.goals.find(aAcc.id, ['default']).src, /b:5k/);
  assert.strictEqual(a.goals.find(bAcc.id, ['default']), null, 'read across orgs');
  throws(() => a.goals.set(bAcc.id, 'default', 'goal', 'pwned'), /does not belong/);
  assert.match(b.goals.find(bAcc.id, ['default']).src, /a:9k/, 'it was overwritten');
});

t('goal listing does not include the other org', () => {
  assert.deepStrictEqual(a.goals.list('goal').map((g) => g.accountId), [aAcc.id]);
});

t('snapshots', () => {
  a.snapshots.add(aAcc.id, { at: Date.now(), ok: true, prestige: 111 });
  b.snapshots.add(bAcc.id, { at: Date.now(), ok: true, prestige: 222 });
  assert.strictEqual(a.snapshots.latest(aAcc.id).prestige, 111);
  assert.strictEqual(a.snapshots.latest(bAcc.id), null, 'read across orgs');
  assert.deepStrictEqual(a.snapshots.series(bAcc.id, 0, 'prestige'), []);
  throws(() => a.snapshots.add(bAcc.id, { at: Date.now(), ok: true }), /does not belong/);
});

t('engine state', () => {
  a.engineState.save({ '9': { secret: 'acme' } }, aAcc.id);
  b.engineState.save({ '9': { secret: 'rival' } }, bAcc.id);
  assert.strictEqual(a.engineState.load(aAcc.id)['9'].secret, 'acme');
  assert.deepStrictEqual(a.engineState.load(bAcc.id), {}, 'read across orgs');
  throws(() => a.engineState.save({ x: 1 }, bAcc.id), /does not belong/);
});

t('the city registry — where abandoning lives', () => {
  b.registry.reconcile(bAcc.id, [{ fieldId: 5000, castleId: 1, name: 'RivalCity' }]);
  assert.strictEqual(a.registry.get(bAcc.id, 5000), null, 'read across orgs');
  assert.deepStrictEqual(a.registry.all(bAcc.id), []);
  throws(() => a.registry.claimFlat(bAcc.id, 5000, {}), /does not belong/);
  throws(() => a.registry.markAbandoned(bAcc.id, 5000), /does not belong/);
});

section('settings and uptime');

t('settings with the same key are independent', () => {
  a.settings.set('proxyText', 'acme-proxies');
  b.settings.set('proxyText', 'rival-proxies');
  assert.strictEqual(a.settings.get('proxyText'), 'acme-proxies');
  assert.strictEqual(b.settings.get('proxyText'), 'rival-proxies');
});

t('uptime rows do not cross', () => {
  a.uptime.add({ probe: 'p', reachable: true, up: true, accountId: aAcc.id });
  b.uptime.add({ probe: 'p', reachable: true, up: false, accountId: bAcc.id });
  assert.strictEqual(a.uptime.series(0).length, 1);
  assert.strictEqual(a.uptime.series(0)[0].up, 1);
  assert.strictEqual(b.uptime.series(0)[0].up, 0);
});

t('watchlist prestige does not cross', () => {
  a.players.record('SomeLord', 100);
  assert.strictEqual(b.players.latest('SomeLord'), null);
});

section('org() cannot be bypassed');

t('org() without an id throws rather than returning everything', () => {
  throws(() => D.org(null), /organization id is required/);
  throws(() => D.org(''), /organization id is required/);
});

section('users, orgs and sessions');

t('a user belongs to the orgs it joined, and no others', () => {
  const u = D.users.create({ email: 'Wian@Example.com', passwordHash: 'x' });
  D.users.join(u.id, A.id, 'owner');
  assert.deepStrictEqual(D.users.orgsOf(u.id).map((o) => o.id), [A.id]);
  assert.strictEqual(D.users.roleIn(u.id, A.id), 'owner');
  assert.strictEqual(D.users.roleIn(u.id, B.id), null);
});

t('email lookup is case-insensitive', () => {
  assert.ok(D.users.byEmail('wian@example.com'));
  assert.ok(D.users.byEmail('WIAN@EXAMPLE.COM'));
});

t('a session resolves to its user and org', () => {
  const u = D.users.byEmail('wian@example.com');
  const sid = D.sessions.create(u.id, A.id, '1.2.3.4', 'test');
  const r = D.sessions.resolve(sid);
  assert.strictEqual(r.user.id, u.id);
  assert.strictEqual(r.org.id, A.id);
  assert.strictEqual(r.role, 'owner');
});

t('a session pointing at an org the user is NOT in yields no org', () => {
  const u = D.users.byEmail('wian@example.com');
  const sid = D.sessions.create(u.id, B.id, '1.2.3.4', 'test');   // never joined B
  const r = D.sessions.resolve(sid);
  assert.strictEqual(r.org, null, 'it handed over an org the user does not belong to');
  assert.strictEqual(r.role, null);
});

t('an unknown or ended session resolves to nothing', () => {
  assert.strictEqual(D.sessions.resolve('nope'), null);
  const u = D.users.byEmail('wian@example.com');
  const sid = D.sessions.create(u.id, A.id, '1.2.3.4', 't');
  D.sessions.end(sid);
  assert.strictEqual(D.sessions.resolve(sid), null);
});

t('a disabled user cannot resolve a live session', () => {
  const u = D.users.create({ email: 'gone@x.com', passwordHash: 'x' });
  D.users.join(u.id, A.id);
  const sid = D.sessions.create(u.id, A.id, '1.2.3.4', 't');
  assert.ok(D.sessions.resolve(sid));
  D.run('UPDATE users SET disabled = 1 WHERE id = ?', u.id);
  assert.strictEqual(D.sessions.resolve(sid), null);
});

t('org slugs are unique even with the same name', () => {
  const x = D.orgs.create('Acme Raiders');
  assert.notStrictEqual(x.slug, A.slug);
});

section('world data stays shared');

t('the map cache is not partitioned — it describes the world, not a tenant', () => {
  D.mapCache.upsertMany([{ id: 123, x: 1, y: 2, kind: 'flat', type: 10, level: 5 }]);
  assert.strictEqual(D.mapCache.count(), 1);
  assert.strictEqual(D.mapCache.flats().length, 1, 'both tenants should see the same world');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
try { fs.rmSync(path.dirname(process.env.EVONY_DB), { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
