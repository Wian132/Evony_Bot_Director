'use strict';
// The Script tab's "Quick…" dropdown (quick-scripts.js).
//
//   * a manifest line is  Label | file | all ; # is a comment, blanks are skipped
//   * {side} becomes buy or sell, and the entry is left out when the side is unknown
//   * an entry whose script is missing, or that names a path or a non-.txt, is left out
//   * the side comes from the Trading tab's saved setup, and only buy/sell count
// Offline: temp files and a temp database, no socket, no game.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-quick-'));
process.env.EVONY_DB = path.join(TMP, 't.db');
const D = require('./db');
const QS = require('./quick-scripts');

let pass = 0, fail = 0;
const t = (n, f) => {
  try { f(); pass++; console.log('  ok    ' + n); } catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); }
};

const DIR = path.join(TMP, 'scripts');
fs.mkdirSync(DIR);
for (const f of ['glitch-res-buy.txt', 'glitch-res-sell.txt', 'cancel-then-sell.txt']) fs.writeFileSync(path.join(DIR, f), '// x');
fs.mkdirSync(path.join(DIR, 'afolder.txt'));
const write = (lines) => fs.writeFileSync(path.join(DIR, QS.FILE), lines.join('\n'));

console.log('quick scripts');

t('labels, files and the all flag; comments and blank lines are skipped', () => {
  write(['# a comment', '', 'Turn trading back on | glitch-res-buy.txt | all',
    'Cancel then sell | cancel-then-sell.txt', '   ', '# another']);
  assert.deepStrictEqual(QS.list({ dir: DIR }), [
    { label: 'Turn trading back on', file: 'glitch-res-buy.txt', all: true },
    { label: 'Cancel then sell', file: 'cancel-then-sell.txt', all: false },
  ]);
});

t('{side} becomes the account side, and is left out when the side is unknown', () => {
  write(['Back on | glitch-res-{side}.txt | all']);
  assert.deepStrictEqual(QS.list({ dir: DIR, side: 'sell' }),
    [{ label: 'Back on', file: 'glitch-res-sell.txt', all: true }]);
  assert.deepStrictEqual(QS.list({ dir: DIR, side: 'buy' }),
    [{ label: 'Back on', file: 'glitch-res-buy.txt', all: true }]);
  assert.deepStrictEqual(QS.list({ dir: DIR }), [], 'no side, no entry — never a guess');
});

t('an entry that could not run is left out, not shown broken', () => {
  write(['Missing | not-there.txt | all',
    'A path | sub/glitch-res-buy.txt | all',
    'A backslash | sub' + String.fromCharCode(92) + 'glitch-res-buy.txt',
    'A folder | afolder.txt',
    'Not a script | glitch-res-buy.doc',
    'No file |',
    '| glitch-res-buy.txt',
    'Fine | glitch-res-buy.txt']);
  assert.deepStrictEqual(QS.list({ dir: DIR }), [{ label: 'Fine', file: 'glitch-res-buy.txt', all: false }]);
});

t('no manifest at all is an empty list, not a throw', () => {
  assert.deepStrictEqual(QS.list({ dir: path.join(TMP, 'nope') }), []);
  assert.deepStrictEqual(QS.list({ dir: DIR, file: 'no-such.txt' }), []);
});

t('the side comes from the Trading tab setup, and only buy or sell count', () => {
  const org = D.org(D.orgs.create('Acme').id);
  const acc = org.accounts.upsert({ label: 'Lord04', email: 'g@x.com', password: 'x' });
  assert.strictEqual(QS.sideOf(org, acc.id), null, 'no setup yet');
  org.settings.set('tradingSetup', { sides: { [acc.id]: 'sell', a99: 'buy' } });
  assert.strictEqual(QS.sideOf(org, acc.id), 'sell');
  assert.strictEqual(QS.sideOf(org, 'a99'), 'buy');
  assert.strictEqual(QS.sideOf(org, 'a100'), null, 'an account not in the setup');
  org.settings.set('tradingSetup', { sides: { [acc.id]: 'both' } });
  assert.strictEqual(QS.sideOf(org, acc.id), null, 'anything but buy/sell is not a side');
  assert.strictEqual(QS.sideOf(null, acc.id), null);
  assert.strictEqual(QS.sideOf(org, null), null);
});

t('the real manifest in scripts/ parses, and every entry it offers exists', () => {
  const real = path.join(__dirname, 'scripts');
  for (const side of [null, 'buy', 'sell']) {
    for (const e of QS.list({ dir: real, side })) {
      assert.ok(fs.statSync(path.join(real, e.file)).isFile(), `${e.label} -> ${e.file}`);
      assert.ok(e.label && typeof e.all === 'boolean');
    }
  }
  const withSide = QS.list({ dir: real, side: 'buy' });
  assert.ok(withSide.some((e) => /turn trading back on/i.test(e.label)), 'the entry the user asked for is there');
  assert.ok(withSide.length > QS.list({ dir: real }).length, 'knowing the side offers one more');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
