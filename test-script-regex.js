'use strict';
// Script regexes run in script-regex.js's worker with a time limit, offline. A
// runaway pattern must fail its own line and leave the console's event loop
// running; ordinary matching must behave exactly like JavaScript's.
const assert = require('assert');
const C = require('./constants');
const { Game } = require('./game');
const script = require('./script');
const E = require('./script-expr');
const R = require('./script-regex');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);

const S = () => new E.Scope({ vars: new Map(), layers: [E.builtins()] });
async function ev(src, scope = S()) { return E.evaluate(E.parseStatement(src), scope); }

function world() {
  const g = new Game();
  g.player = { playerInfo: { userName: 'Tester' } };
  g.castles = [{ id: 1, name: 'Home', fieldId: C.coordsToFieldId(100, 100), heros: [] }];
  return g;
}
async function runSrc(src) {
  const acts = script.parse(src);
  const errs = acts.filter((a) => a.cmd === 'error');
  if (errs.length) throw new Error('refused: ' + errs.map((e) => e.error).join('; '));
  const out = [];
  await script.run(world(), acts, (m) => out.push(m), { castle: 'Home', repeatGapMs: 0 });
  return out.map((l) => l.replace(/^ {2}/, ''));
}

// The longest gap between ticks of a 20 ms timer while fn runs: how long the
// console's event loop was blocked.
async function blockedFor(fn) {
  let last = Date.now(), worst = 0;
  const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 20);
  try { return { value: await fn(), worst: () => worst }; } finally { clearInterval(timer); }
}

const EVIL = '"' + 'a'.repeat(34) + '!"';

// ---------------------------------------------------------------------------
section('a runaway regex fails its line and never blocks the console');

t('match with nested repeats: the line fails, the event loop keeps ticking', async () => {
  const at = Date.now();
  const r = await blockedFor(() => runSrc([
    `y = ${EVIL}.match(/^(a+)+$/)`,
    'echo "after: " + $error',
    'echo "still going"',
  ].join('\n')));
  const took = Date.now() - at;
  assert.ok(took >= R.LIMIT_MS - 50 && took < R.LIMIT_MS + 3000, `took ${took} ms`);
  assert.ok(r.worst() < 400, `the event loop was blocked for ${r.worst()} ms`);
  assert.ok(r.value.some((l) => /after: .*ran for over 2 s and was stopped/.test(l)), r.value.join('\n'));
  assert.ok(r.value.includes('still going'));
});

t('text JavaScript turns into a regex (search, match) is limited too', async () => {
  for (const expr of [`${EVIL}.search("^(a+)+$")`, `${EVIL}.match("^(a+)+$")`]) {
    await assert.rejects(ev(expr), /ran for over/);
  }
});

t('test, exec, replace, split and a callback replace are limited too', async () => {
  for (const expr of [
    `/^(a+)+$/.test(${EVIL})`, `/^(a+)+$/.exec(${EVIL})`, `${EVIL}.replace(/^(a+)+$/, "x")`,
    `${EVIL}.split(/^(a+)+$/)`, `${EVIL}.replace(/^(a+)+$/, CreateFunction("m", "m"))`,
  ]) {
    await assert.rejects(ev(expr), /ran for over/, expr);
  }
});

t('after a runaway, the next regex gets a fresh worker and works', async () => {
  await assert.rejects(ev(`${EVIL}.match(/^(a+)+$/)`), /ran for over/);
  assert.strictEqual(await ev('"abc".search(/c/)'), 2);
});

t('regexes from two runs queue: a runaway one delays, never fails, the other', async () => {
  const slow = ev(`${EVIL}.match(/^(a+)+$/)`).then(() => 'matched', (e) => e.message);
  const fast = ev('"x1y22".match(/\\d+/g)');
  assert.deepStrictEqual(await fast, ['1', '22']);
  assert.match(await slow, /ran for over/);
});

t('text over a million characters is refused before it reaches the worker', async () => {
  await assert.rejects(ev('"a".repeat(1000001).match(/a/)'), /at most 1,000,000 characters/);
});

// ---------------------------------------------------------------------------
section('ordinary regexes still behave like JavaScript');

t('match: first match with index and groups, or every match with g', async () => {
  const m = await ev('"Bob (123,456)".match(/\\((\\d+),(?<y>\\d+)\\)/)');
  assert.deepStrictEqual([...m], ['(123,456)', '123', '456']);
  assert.strictEqual(m.index, 4);
  assert.strictEqual(m.groups.y, '456');
  assert.deepStrictEqual(await ev('"a1b22c333".match(/\\d+/g)'), ['1', '22', '333']);
  assert.strictEqual(await ev('"abc".match(/z/)'), null);
  assert.deepStrictEqual([...await ev('"a.b".match(".")')], ['a']);          // text is a regex here, as in JS
});

t('matchAll needs g; text becomes a global regex', async () => {
  const all = await ev('"k1 k22".matchAll(/k(\\d+)/g)');
  assert.deepStrictEqual(all.map((m) => m[1]), ['1', '22']);
  assert.deepStrictEqual(all.map((m) => m.index), [0, 3]);
  assert.strictEqual((await ev('"aXa".matchAll("a")')).length, 2);
  await assert.rejects(ev('"k1".matchAll(/k/)'), /needs a regular expression with the g flag/);
});

t('replace and replaceAll with $1, with text, and with a script callback', async () => {
  assert.strictEqual(await ev('"John Smith".replace(/(\\w+)\\s(\\w+)/, "$2, $1")'), 'Smith, John');
  assert.strictEqual(await ev('"a.b.c".replace(".", "-")'), 'a-b.c');            // text is literal in replace
  assert.strictEqual(await ev('"a.b.c".replaceAll(".", "-")'), 'a-b-c');
  assert.strictEqual(await ev('"a1b2".replaceAll(/\\d/g, "#")'), 'a#b#');
  assert.strictEqual(await ev('"a1b22".replace(/\\d+/g, CreateFunction("m", "\\"<\\" + m + \\">\\""))'), 'a<1>b<22>');
  await assert.rejects(ev('"a1".replaceAll(/\\d/, "#")'), /needs a regular expression with the g flag/);
});

t('split with a regex and a limit, and with text', async () => {
  assert.deepStrictEqual(await ev('"a, b;c".split(/[,;]\\s*/)'), ['a', 'b', 'c']);
  assert.deepStrictEqual(await ev('"a, b;c".split(/[,;]\\s*/, 2)'), ['a', 'b']);
  assert.deepStrictEqual(await ev('"1,2,3".split(",")'), ['1', '2', '3']);
  assert.deepStrictEqual(await ev('"abc".split()'), ['abc']);
});

t('search, test and exec, with lastIndex moving on a g regex', async () => {
  assert.strictEqual(await ev('"hello".search("l+")'), 2);
  const scope = S();
  await ev('re = /o/g', scope);
  assert.strictEqual(await ev('re.test("foo")', scope), true);
  assert.strictEqual(await ev('re.lastIndex', scope), 2);
  assert.strictEqual(await ev('re.exec("foo")[0]', scope), 'o');
  assert.strictEqual(await ev('re.lastIndex', scope), 3);
  assert.strictEqual(await ev('re.exec("foo")', scope), null);
  assert.strictEqual(await ev('re.lastIndex', scope), 0);
});

t("SortingMemberList's regex replace over many lines", async () => {
  const text = '"Bob [R4] 1,234\\nAnn [R5] 99"';
  const out = await ev(`${text}.replace(/^(\\w+) \\[R(\\d)\\] ([\\d,]+)$/gm, "{ lord:\\"$1\\", rank:$2 }")`);
  assert.strictEqual(out, '{ lord:"Bob", rank:4 }\n{ lord:"Ann", rank:5 }');
});

// ---------------------------------------------------------------------------
(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    if (!fn) { console.log('\n' + name); continue; }
    try { await fn(); pass++; console.log('  ok    ' + name); } catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n        ')); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
