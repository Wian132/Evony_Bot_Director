'use strict';
// Prepend / Append goals kept in files (goalfiles.js, the Director's ✎ dialog).
//
//   * a path must be a full path to a .txt file; blank clears it
//   * a sync saves the file's text as the account's prepend/append goals, only
//     when it differs, and says so with the line and error counts
//   * a console edit is put back from the file; a missing file leaves the
//     goals alone and is said once
//   * clearing the path stops the copying and keeps the goals
//   * another organization's account is never written
//   * the Browse listing shows folders and .txt files only
// Offline: a temp database and temp files, no socket.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-goalfiles-'));
process.env.EVONY_DB = path.join(TMP, 't.db');

const D = require('./db');
const GF = require('./goalfiles');
const GL = require('./goallayers');

let pass = 0, fail = 0;
const t = (n, f) => {
  try { f(); pass++; console.log('  ok    ' + n); } catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); }
};
const has = (s, sub) => assert.ok(String(s).includes(sub), `"${s}" does not contain "${sub}"`);

const org = D.org(D.orgs.create('Acme').id);
const other = D.org(D.orgs.create('Rival').id);
const acc = org.accounts.upsert({ label: 'Lord04', email: 'g@x.com', password: 'x' });
const rivalAcc = other.accounts.upsert({ label: 'Rival', email: 'r@x.com', password: 'x' });
const PRE = path.join(TMP, 'prepend-goals.txt');
const APP = path.join(TMP, 'append goals.txt');
const logs = [];
const note = (m) => logs.push(m);
const seen = new Map();
const sync = () => GF.syncAccount(org, acc, { note, seen });

console.log('goal files');

t('a path must be a full path to a .txt file; blank or quoted is fine', () => {
  assert.throws(() => GF.checkPath('prepend.txt'), /not a full path/);
  assert.throws(() => GF.checkPath(path.join(TMP, 'x.js')), /not a \.txt file/);
  assert.strictEqual(GF.checkPath('  '), '');
  assert.strictEqual(GF.checkPath(`"${PRE}"`), path.normalize(PRE));
  assert.throws(() => GF.setFile(org, acc.id, 'template', PRE), /no goal file called/);
});

t('no file set: nothing happens', () => {
  assert.deepStrictEqual(sync(), []);
  assert.strictEqual(org.goals.exact(acc.id, 'prepend', 'goal'), null);
});

t('a file is saved as the prepend goals, with its line count, and read by the engine\'s layers', () => {
  fs.writeFileSync(PRE, '﻿// builders\r\nconfig comfort:1,hero:1\r\ntroop b:20k\r\n');
  GF.setFile(org, acc.id, 'prepend', PRE);
  const r = sync();
  assert.deepStrictEqual(r, [{ which: 'prepend', file: PRE, synced: true, lines: 2, errors: 0 }]);
  assert.strictEqual(org.goals.exact(acc.id, 'prepend', 'goal').src, '// builders\r\nconfig comfort:1,hero:1\r\ntroop b:20k\r\n');
  has(logs.pop(), `Lord04: prepend goals set from ${PRE} — 2 line(s)`);
  const l = org.goals.layers(acc.id, 1, 'One');
  assert.deepStrictEqual(GL.parseLayered(l).config, { comfort: 1, hero: 1 });
});

t('an unchanged file is not saved again', () => {
  const at = org.goals.exact(acc.id, 'prepend', 'goal').savedAt;
  assert.deepStrictEqual(sync(), [{ which: 'prepend', file: PRE, synced: false }]);
  assert.strictEqual(org.goals.exact(acc.id, 'prepend', 'goal').savedAt, at);
  assert.strictEqual(logs.length, 0);
});

t('a changed file is copied in, and its errors are counted and named', () => {
  fs.writeFileSync(PRE, 'config comfort:1\nbogus 1\n');
  const r = sync();
  assert.strictEqual(r[0].synced, true);
  assert.strictEqual(r[0].errors, 1);
  has(logs.pop(), '1 with an error, skipped until fixed (prepend line 2: unknown goal "bogus")');
  assert.strictEqual(org.goals.exact(acc.id, 'prepend', 'goal').src, 'config comfort:1\nbogus 1\n');
});

t('a console edit is put back from the file', () => {
  GL.saveText(org.goals, acc.id, { which: 'prepend', src: 'troop s:1', save: true });
  assert.strictEqual(sync()[0].synced, true);
  assert.strictEqual(org.goals.exact(acc.id, 'prepend', 'goal').src, 'config comfort:1\nbogus 1\n');
  logs.length = 0;
});

t('append has its own file, a path with a space in it', () => {
  fs.writeFileSync(APP, 'troop s:5\n');
  GF.setFile(org, acc.id, 'append', APP);
  const r = sync();
  assert.deepStrictEqual(r.map((x) => `${x.which}:${x.synced}`), ['prepend:false', 'append:true']);
  assert.strictEqual(org.goals.exact(acc.id, 'append', 'goal').src, 'troop s:5\n');
  logs.length = 0;
});

t('a missing file keeps the saved goals and is said once', () => {
  fs.unlinkSync(APP);
  let r = sync();
  assert.strictEqual(r[1].why, 'the file is not there');
  assert.strictEqual(org.goals.exact(acc.id, 'append', 'goal').src, 'troop s:5\n');
  assert.strictEqual(logs.length, 1);
  has(logs[0], 'append goals file');
  has(logs[0], 'its saved append goals are left as they are');
  r = sync();
  assert.strictEqual(logs.length, 1, 'the same problem was logged twice');
  fs.writeFileSync(APP, 'troop s:6\n');
  sync();
  assert.strictEqual(org.goals.exact(acc.id, 'append', 'goal').src, 'troop s:6\n');
  logs.length = 0;
});

t('an empty file empties the text', () => {
  fs.writeFileSync(APP, '   \n');
  assert.strictEqual(sync()[1].synced, true);
  assert.strictEqual(org.goals.exact(acc.id, 'append', 'goal').src, '');
  assert.strictEqual(sync()[1].synced, false, 'an empty file was saved again every check');
  logs.length = 0;
});

t('clearing the path stops the copying and keeps the goals', () => {
  GF.setFile(org, acc.id, 'append', '');
  assert.strictEqual(GF.fileOf(org, acc.id, 'append'), null);
  fs.writeFileSync(APP, 'troop s:99\n');
  assert.deepStrictEqual(sync().map((x) => x.which), ['prepend']);
  assert.strictEqual(org.goals.exact(acc.id, 'append', 'goal').src, '');
});

t('syncAll covers every organization, each writing only its own accounts', () => {
  const RF = path.join(TMP, 'rival.txt');
  fs.writeFileSync(RF, 'troop c:1\n');
  GF.setFile(other, rivalAcc.id, 'prepend', RF);
  fs.writeFileSync(PRE, 'troop b:1\n');
  GF.syncAll([org, other], { note, seen });
  assert.strictEqual(org.goals.exact(acc.id, 'prepend', 'goal').src, 'troop b:1\n');
  assert.strictEqual(other.goals.exact(rivalAcc.id, 'prepend', 'goal').src, 'troop c:1\n');
  assert.strictEqual(org.goals.exact(rivalAcc.id, 'prepend', 'goal'), null, 'one organization read another\'s account');
});

t('Browse lists folders and .txt files only, with the way up', () => {
  fs.mkdirSync(path.join(TMP, 'sub'));
  fs.writeFileSync(path.join(TMP, 'notes.md'), 'x');
  const r = GF.browse(TMP);
  assert.ok(r.ok);
  assert.strictEqual(r.dir, path.resolve(TMP));
  assert.deepStrictEqual(r.dirs, ['sub']);
  assert.deepStrictEqual(r.files, ['append goals.txt', 'prepend-goals.txt', 'rival.txt']);
  assert.strictEqual(r.parent, path.dirname(path.resolve(TMP)));
  assert.ok(r.roots.length >= 1);
  assert.strictEqual(GF.browse(path.join(TMP, 'nope')).ok, false);
  assert.strictEqual(GF.browse('').dir, __dirname);
  if (process.platform === 'win32') assert.strictEqual(GF.browse(TMP.slice(0, 2)).dir, TMP.slice(0, 2).toUpperCase() + '\\');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
