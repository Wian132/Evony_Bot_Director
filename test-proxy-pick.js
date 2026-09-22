'use strict';
// Random proxies (proxy-pick.js), offline against a throwaway database: a new
// account is "random" by default; its pick is a free line, kept between calls,
// never a failed line while another is left, never another account's; it is
// picked again when its line fails, leaves the list or is pinned by another
// account; pinned and direct accounts are left as they are.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-ppick-'));
process.env.EVONY_DB = path.join(TMP, 't.db');

const D = require('./db');
const AUTH = require('./auth');
const PP = require('./proxy-pick');
const op = AUTH.register({ email: 'op@example.com', password: 'correct horse battery', orgName: 'Proxy Org' });
const ORG = D.org(op.org.id);

const LINES = ['10.0.0.1:1001', '10.0.0.2:1002', '10.0.0.3:1003', '10.0.0.4:1004'];
const raw = (i) => LINES[i];
const setList = (lines) => ORG.settings.set('proxyText', lines.join('\n'));
const setTests = (t) => ORG.settings.set('proxyTests', t);
const pickOf = (id) => ORG.settings.get(PP.pickKey(id), null);
// a fixed "random" so each test knows what it will get: always the first choice
const first = () => 0;
const last = () => 0.9999;

const tests = [];
const t = (n, f) => tests.push([n, f]);

setList(LINES);
setTests({});

t('a new account is random by default; an explicit proxy or direct is kept', () => {
  const a = ORG.accounts.upsert({ label: 'A', server: 'ss0' });
  assert.strictEqual(a.proxy, 'random');
  const b = ORG.accounts.upsert({ label: 'B', server: 'ss0', proxy: '' });
  assert.strictEqual(b.proxy, '', 'direct asked for is direct');
  const c = ORG.accounts.upsert({ label: 'C', server: 'ss0', proxy: raw(3) });
  assert.strictEqual(c.proxy, raw(3));
  // an edit that says nothing about the proxy leaves it alone
  assert.strictEqual(ORG.accounts.upsert({ id: b.id, notes: 'x' }).proxy, '');
});

t('random picks a free line, pinned keeps its own, direct gets none', () => {
  const [a, b, c] = ORG.accounts.all();
  const m = PP.assignAll(ORG, { rand: last });
  assert.strictEqual(m.get(b.id), null, 'direct');
  assert.strictEqual(m.get(c.id).raw, raw(3), 'pinned');
  const got = m.get(a.id).raw;
  assert.notStrictEqual(got, raw(3), 'never the pinned account\'s line');
  assert.strictEqual(pickOf(a.id), got, 'the pick is kept');
});

t('the pick is sticky: the same line on every call, whatever the dice say', () => {
  const [a] = ORG.accounts.all();
  const was = pickOf(a.id);
  for (const r of [first, last, Math.random]) assert.strictEqual(PP.assignAll(ORG, { rand: r }).get(a.id).raw, was);
  assert.strictEqual(PP.forAccount(ORG, ORG.accounts.get(a.id)).raw, was, 'forAccount agrees');
});

t('two random accounts never share a line', () => {
  const d = ORG.accounts.upsert({ label: 'D', server: 'ss0' });
  const e = ORG.accounts.upsert({ label: 'E', server: 'ss0' });
  const m = PP.assignAll(ORG, { rand: first });
  const used = ['A', 'C', 'D', 'E'].map((l) => m.get(ORG.accounts.all().find((x) => x.label === l).id).raw);
  assert.strictEqual(new Set(used).size, 4, used.join(' '));
  ORG.accounts.remove(d.id); ORG.settings.set(PP.pickKey(d.id), null);
  ORG.accounts.remove(e.id); ORG.settings.set(PP.pickKey(e.id), null);
});

t('a line that failed its test is not picked while another is left', () => {
  const [a] = ORG.accounts.all();
  ORG.settings.set(PP.pickKey(a.id), null);
  const bad = {};
  for (const l of LINES) bad[l] = { ok: false, why: 'dead' };
  bad[raw(1)] = { ok: true, ms: 250 };
  setTests(bad);
  for (let i = 0; i < 5; i++) {
    ORG.settings.set(PP.pickKey(a.id), null);
    assert.strictEqual(PP.assignAll(ORG, { rand: Math.random }).get(a.id).raw, raw(1));
  }
});

t('a passed line is preferred over an untested one', () => {
  const [a] = ORG.accounts.all();
  setTests({ [raw(2)]: { ok: true, ms: 200 } });
  ORG.settings.set(PP.pickKey(a.id), null);
  assert.strictEqual(PP.assignAll(ORG, { rand: last }).get(a.id).raw, raw(2));
});

t('a pick that fails its test is replaced, and the log says why', () => {
  const [a] = ORG.accounts.all();
  const notes = [];
  setTests({ [raw(2)]: { ok: false, why: 'host unreachable' } });
  const got = PP.assignAll(ORG, { rand: first, note: (m) => notes.push(m) }).get(a.id).raw;
  assert.notStrictEqual(got, raw(2));
  assert.strictEqual(pickOf(a.id), got);
  assert.strictEqual(notes.length, 1, notes.join(' | '));
  assert.match(notes[0], /in place of socks5:\/\/10\.0\.0\.3:1003 \(it failed its last test\)/);
  // nothing changed on the next call: nothing said
  PP.assignAll(ORG, { note: (m) => notes.push(m) });
  assert.strictEqual(notes.length, 1, 'quiet when the pick stands');
  setTests({});
});

t('a pick that leaves the list is replaced', () => {
  const [a] = ORG.accounts.all();
  const was = pickOf(a.id);
  setList(LINES.filter((l) => l !== was));
  const got = PP.assignAll(ORG, { rand: first }).get(a.id).raw;
  assert.notStrictEqual(got, was);
  assert.ok(LINES.includes(got));
  setList(LINES);
});

t('an account pinned onto a random account\'s line takes it; the random one moves', () => {
  const [a, b] = ORG.accounts.all();
  const was = pickOf(a.id);
  ORG.accounts.upsert({ id: b.id, proxy: was });
  const m = PP.assignAll(ORG, { rand: first });
  assert.strictEqual(m.get(b.id).raw, was, 'the pin wins');
  assert.notStrictEqual(m.get(a.id).raw, was, 'the random account moved off it');
  ORG.accounts.upsert({ id: b.id, proxy: '' });
});

t('two random accounts left on one line (a race): the later one moves', () => {
  const [a] = ORG.accounts.all();
  const f = ORG.accounts.upsert({ label: 'F', server: 'ss0' });
  ORG.settings.set(PP.pickKey(f.id), pickOf(a.id));
  const keep = pickOf(a.id);
  const m = PP.assignAll(ORG, { rand: first });
  assert.strictEqual(m.get(a.id).raw, keep, 'the earlier account keeps it');
  assert.notStrictEqual(m.get(f.id).raw, keep);
  ORG.accounts.remove(f.id); ORG.settings.set(PP.pickKey(f.id), null);
});

t('with no free line left, the least-used working one is shared', () => {
  setList([raw(0), raw(1)]);
  const extra = [1, 2, 3].map((i) => ORG.accounts.upsert({ label: 'X' + i, server: 'ss0' }));
  const m = PP.assignAll(ORG, { rand: first });
  const counts = {};
  for (const a of ORG.accounts.all()) { const p = m.get(a.id); if (p) counts[p.raw] = (counts[p.raw] || 0) + 1; }
  // C is pinned to raw(3), outside this list, and counts for none of these two
  const onList = [raw(0), raw(1)].map((r) => counts[r] || 0);
  assert.ok(Math.abs(onList[0] - onList[1]) <= 1, JSON.stringify(counts));
  for (const x of extra) { ORG.accounts.remove(x.id); ORG.settings.set(PP.pickKey(x.id), null); }
  setList(LINES);
});

t('an empty list: random logs in direct, and says so once', () => {
  const [a] = ORG.accounts.all();
  setList([]);
  const notes = [];
  assert.strictEqual(PP.assignAll(ORG, { note: (m) => notes.push(m) }).get(a.id), null);
  PP.assignAll(ORG, { note: (m) => notes.push(m) });
  assert.strictEqual(notes.length, 1, notes.join(' | '));
  assert.match(notes[0], /list is empty — it logs in direct/);
  setList(LINES);
});

t('forAccount: pinned and direct need no org; random without one is direct', () => {
  assert.strictEqual(PP.forAccount(null, { id: 'z', proxy: raw(0) }).raw, raw(0));
  assert.strictEqual(PP.forAccount(null, { id: 'z', proxy: '' }), null);
  assert.strictEqual(PP.forAccount(null, { id: 'z', proxy: 'random' }), null);
  assert.strictEqual(PP.isRandom(' Random '), true);
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log('  ok    ' + n); pass++; } catch (e) { console.log('  FAIL  ' + n + '\n        ' + String(e.message).split('\n').slice(0, 8).join('\n        ')); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
