'use strict';
// claude-perms.js offline: the six switches default off, are kept per account
// on the owning org's settings, are seen by a SECOND process on the same
// database (the Director and a console), and permFor maps each command to the
// switch it needs — never letting a holiday be ended or renewed.
//   EVONY_DB=/tmp/x.db node test-claude-perms.js
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const cp = require('child_process');

// db.js opens EVONY_DB at require time: never the live evony.db
if (!process.env.EVONY_DB) process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-perms-')), 't.db');
if (path.resolve(process.env.EVONY_DB) === path.resolve(__dirname, 'evony.db')) throw new Error('refusing to run on the live evony.db');

const D = require('./db');
const P = require('./claude-perms');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok    ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
}
const section = (s) => console.log(`\n--- ${s} ---`);

// an org with one account, and one account in no org at all
const org = D.orgs.create('perms test ' + Date.now());
const A = 'tp' + Date.now().toString(36);
D.org(org.id).accounts.upsert({ id: A, label: 'Lord01', server: 'ss71' });
const LOOSE = 'tl' + Date.now().toString(36);

section('the contract');
t('six permissions, in the order and with the labels the user gave', () => {
  assert.deepStrictEqual(P.PERMS, ['gate', 'troops', 'teleport', 'truce', 'dreamtruce', 'holiday']);
  assert.deepStrictEqual(P.PERMS.map((k) => P.LABELS[k]), ['Control gate', 'Move troops in/out', 'Teleport city',
    'Use Truce Agreement', 'Use Dream Truce (item)', 'Holiday account']);
});
t('every switch is off for an account nobody has touched', () => {
  assert.deepStrictEqual(P.get(A), { gate: false, troops: false, teleport: false, truce: false, dreamtruce: false, holiday: false });
  for (const p of P.PERMS) assert.strictEqual(P.allowed(A, p), false);
  assert.strictEqual(P.allowed(A, 'nonsense'), false);
  assert.deepStrictEqual(P.get(null), P.get(A));
});

section('storage');
t('set merges a patch, ignores unknown keys, and allowed reads it', () => {
  P.set(A, { gate: true, bogus: true });
  assert.strictEqual(P.allowed(A, 'gate'), true);
  assert.strictEqual(P.allowed(A, 'troops'), false);
  P.set(A, { troops: true });
  assert.deepStrictEqual(P.get(A), { gate: true, troops: true, teleport: false, truce: false, dreamtruce: false, holiday: false });
  P.set(A, { gate: false });
  assert.strictEqual(P.allowed(A, 'gate'), false);
  assert.strictEqual(P.allowed(A, 'troops'), true);
});
t('it lives on the owning org\'s settings, keyed claudePerms:<id>', () => {
  const row = D.org(org.id).settings.get('claudePerms:' + A, null);
  assert.ok(row && row.troops === true && row.gate === false, JSON.stringify(row));
  assert.strictEqual(D.settings.get('claudePerms:' + A, null), null, 'not install-wide');
});
t('an account in no org is kept in the install-wide settings', () => {
  P.set(LOOSE, { holiday: true });
  assert.strictEqual(P.allowed(LOOSE, 'holiday'), true);
  assert.ok(D.settings.get('claudePerms:' + LOOSE, null).holiday);
});
t('a second process on the same database sees a change, and its change is seen here', () => {
  // the "console": another node process, its own db.js handle
  const code = `const P = require(${JSON.stringify(path.join(__dirname, 'claude-perms.js'))});
    const before = P.get(${JSON.stringify(A)});
    P.set(${JSON.stringify(A)}, { teleport: true });
    process.stdout.write(JSON.stringify(before));`;
  const out = cp.execFileSync(process.execPath, ['-e', code], { env: { ...process.env }, encoding: 'utf8' });
  const seen = JSON.parse(out);
  assert.strictEqual(seen.troops, true, 'the child saw what this process set');
  assert.strictEqual(P.allowed(A, 'teleport'), true, 'this process sees what the child set, with no cache in the way');
});

section('permFor');
const cases = [
  ['gate open', 'gate'], ['gate close', 'gate'], ['gate closed', 'gate'], ['gate auto', 'gate'], ['gate', null], ['gate sideways', null],
  ['recall 300,400', 'troops'], ['recallall', 'troops'], ['reinforce 12,34 a:1000', 'troops'],
  ['evacuatetown', 'troops'], ['dumptroop a:500', 'troops'],
  ['teleport 100,200', 'teleport'], ['teleport random', 'teleport'], ['warteleport 100,200', 'teleport'],
  ['truce', 'truce'], ['dreamtruce 10:20:00', 'dreamtruce'], ['dreamtruce /cancel', 'dreamtruce'],
  ['holiday 3 confirm', 'holiday'], ['holiday 2 confirm', 'holiday'], ['HOLIDAY 3 CONFIRM', 'holiday'],
  ['holiday /exit', null], ['holiday /exit confirm', null], ['holiday 3 /autoextend confirm', null],
  ['holiday 3', null], ['holiday confirm', null],
  ['command "holiday 3 confirm"', 'holiday'], ['command "holiday /exit"', null],
  ['attack 100,200', null], ['buyitem 1', null], ['release hero', null], ['abandontown', null], ['', null], [null, null],
];
for (const [cmd, want] of cases) {
  t(`${JSON.stringify(cmd)} -> ${want}`, () => assert.strictEqual(P.permFor(cmd), want));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
