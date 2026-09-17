'use strict';
// The script language itself, offline: expressions (script-expr.js), control
// flow and variables (script.js), and the NEAT wiki's own examples. Commands are
// either the real ones against a real Game whose network calls are stubbed, or a
// recording fake module handed in through parse's `modules` option.
const assert = require('assert');
const C = require('./constants');
const { Game } = require('./game');
const script = require('./script');
const E = require('./script-expr');
const W = require('./script-words');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const F = (x, y) => C.coordsToFieldId(x, y);

function world({ trainReplies = [] } = {}) {
  const g = new Game();
  g.player = { playerInfo: { userName: 'Tester' } };
  g.castles = [
    { id: 1, name: 'Home', fieldId: F(100, 100), heros: [{ id: 11, name: 'Bubba', status: 0, level: 50 }] },
    { id: 2, name: 'Fla', fieldId: F(110, 100), heros: [] },
  ];
  const sent = [];
  let n = 0;
  g.produceTroop = async (castleId, type, amount) => {
    sent.push({ cmd: 'train', castleId, type, amount });
    const r = trainReplies[n++];
    if (r instanceof Error) throw r;
    return r || { ok: 1 };
  };
  g.newArmy = async (castleId, bean) => { sent.push({ cmd: 'newArmy', castleId, bean }); return { ok: 1 }; };
  return { g, sent };
}

// A module whose commands only record what they were asked, NEAT-style words
// the real modules do not all have yet (whisper, walldefense, train arch:250 Bubba).
function recorder(replies = {}) {
  const calls = [];
  const mk = (name) => ({
    usage: name + ' <anything>',
    parse: (args) => ({ cmd: name, args }),
    async run(a, env) {
      calls.push(`${name} ${a.args}`.trim());
      const r = (replies[name] && replies[name](a, calls)) || { ok: 1 };
      env.log('  -> ' + env.say(r));
      return { done: 1 };
    },
  });
  const commands = {};
  for (const n of ['attack', 'train', 'upgrade', 'whisper', 'useitem', 'walldefense', 'scout', 'poke']) commands[n] = mk(n);
  const inline = {
    who: {
      async run(args, env) {
        if (args === 'nobody') return { ok: false, error: 'no such player' };
        env.log(`  ${args}: 1 city`);
        return { result: `${args},prestige 5,cities 1` };
      },
    },
  };
  return { calls, mod: { commands, inline } };
}

const echoes = (out) => out.filter((l) => /^ {2}/.test(l) && !/^ {2}->/.test(l)).map((l) => l.slice(2));

async function runSrc(src, { globals, modules, parseOpts = {}, allowErrors = false, w = world(), ...opts } = {}) {
  const acts = script.parse(src, { modules, ...parseOpts });
  const errs = acts.filter((a) => a.cmd === 'error');
  if (errs.length && !allowErrors) throw new Error('refused: ' + errs.map((e) => `line ${e.line}: ${e.error}`).join('; '));
  const out = [];
  const done = await script.run(w.g, acts, (m) => out.push(m), { castle: 'Home', repeatGapMs: 0, globals, ...opts });
  return { done, out, text: out.join('\n'), echoed: echoes(out), w };
}
const errsOf = (src, opts) => script.parse(src, opts).filter((a) => a.cmd === 'error').map((a) => a.error);

// An expression evaluated on its own.
const S = () => new E.Scope({ vars: new Map(), layers: [{ min: Math.min, max: Math.max, floor: Math.floor }, E.builtins()] });
async function ev(src, scope = S()) { return E.evaluate(E.parseStatement(src), scope); }

// ---------------------------------------------------------------------------
section('expressions: operators and precedence (NEAT Operators page)');

t('arithmetic, MOD, shifts and bitwise', async () => {
  assert.strictEqual(await ev('1 + 2 * 3'), 7);
  assert.strictEqual(await ev('(1 + 2) * 3'), 9);
  assert.strictEqual(await ev('10 MOD 3'), 1);
  assert.strictEqual(await ev('10 mod 4'), 2);
  assert.strictEqual(await ev('7 / 2'), 3.5);
  assert.strictEqual(await ev('1 << 4'), 16);
  assert.strictEqual(await ev('256 >> 2'), 64);
  assert.strictEqual(await ev('5 & 3 | 8'), 9);
  assert.strictEqual(await ev('6 ^ 3'), 5);
  assert.strictEqual(await ev('2 + 3 * 4 - 6 / 2'), 11);
  assert.strictEqual(await ev('-2 * -3'), 6);
  assert.strictEqual(await ev('+"5" + 1'), 6);
});
t('comparisons, <> and a lone = inside an expression', async () => {
  assert.strictEqual(await ev('2 <> 3'), true);
  assert.strictEqual(await ev('2 != 2'), false);
  assert.strictEqual(await ev('3 >= 3 && 2 <= 1'), false);
  assert.strictEqual(await ev('"1" == 1'), true, 'NEAT compares loosely');
  assert.strictEqual(await ev('"1" === 1'), false);
  assert.strictEqual(await ev('1 = 1'), true, 'if $result... = 1 compares');
  assert.strictEqual(await ev('"3167" < "3200"'), true, 'the BuildVersion guard compares text');
});
t('&& || and or ! short-circuit and return their operands', async () => {
  assert.strictEqual(await ev('true and false or true'), true);
  assert.strictEqual(await ev('0 || "x"'), 'x');
  assert.strictEqual(await ev('"a" && "b"'), 'b');
  assert.strictEqual(await ev('!"text"'), false);
  assert.strictEqual(await ev('!0'), true);
  const s = S();
  await ev('hits = 0', s);
  await ev('false && (hits += 1)', s);
  await ev('true || (hits += 1)', s);
  assert.strictEqual(s.vars.get('hits'), 0);
});
t('ternary, is and in', async () => {
  assert.strictEqual(await ev('true ? "is" : "is not"'), 'is');
  assert.strictEqual(await ev('1 > 2 ? "a" : 2 > 1 ? "b" : "c"'), 'b');
  assert.strictEqual(await ev('"abc" is String'), true);
  assert.strictEqual(await ev('5 is Number'), true);
  assert.strictEqual(await ev('[1] is Array'), true);
  assert.strictEqual(await ev('{} is Array'), false);
  assert.strictEqual(await ev('"a" in {a: 1}'), true);
  assert.strictEqual(await ev('2 in [5, 6, 7]'), true);
  assert.strictEqual(await ev('"toString" in {}'), false, 'nothing from Object.prototype');
});
t('NEAT number literals: k m b and %', async () => {
  assert.strictEqual(await ev('20k'), 20000);
  assert.strictEqual(await ev('1.5m'), 1500000);
  assert.strictEqual(await ev('2b'), 2e9);
  assert.strictEqual(await ev('1.1m'), 1100000);
  assert.strictEqual(await ev('2%'), 0.02);
  assert.strictEqual(await ev('50% * 10'), 5);
  assert.strictEqual(await ev('0x1f + 1e3'), 1031);
  assert.ok(Number.isNaN(await ev('NaN + 2')));
  assert.strictEqual(await ev('2 / 0'), Infinity);
  assert.strictEqual(await ev('null'), null);
});
t('(a + b) (c - 1) multiplies, as the NEAT changelog shows', async () => {
  const s = S();
  await ev('a = 2', s); await ev('b = 3', s); await ev('c = 6', s);
  assert.strictEqual(await ev('d = (a + b) (c - 1)', s), 25);
});

section('expressions: strings, arrays, objects, regex');

t('strings: escapes, {expr} filling, single quotes, literal braces', async () => {
  const s = S();
  await ev('x = 41', s);
  assert.strictEqual(await ev('"a\\tb\\nc"', s), 'a\tb\nc');
  assert.strictEqual(await ev('"x is {x + 1}!"', s), 'x is 42!');
  assert.strictEqual(await ev("'x is {x}'", s), 'x is {x}', 'no filling in single quotes');
  assert.strictEqual(await ev('"\\{ not filled \\}"', s), '{ not filled }');
  assert.strictEqual(await ev('"{ lord:$1, position:$2 }"', s), '{ lord:$1, position:$2 }', 'not an expression: stays as written');
  assert.strictEqual(await ev('"{"', s), '{');
  assert.strictEqual(await ev('"names: {["a","b"].join(", ")}"', s), 'names: a, b', 'quotes inside a filling');
  assert.strictEqual(await ev('"it\'s"', s), "it's");
});
t('string methods (NEAT Strings page examples)', async () => {
  assert.strictEqual(await ev('"hello".charAt(4)'), 'o');
  assert.strictEqual(await ev('"hello".charCodeAt(4)'), 111);
  assert.strictEqual(await ev('"oompa".concat("loompa", " ", "dance")'), 'oompaloompa dance');
  assert.strictEqual(await ev('"this is a test string.".indexOf("test")'), 10);
  assert.strictEqual(await ev('"this is another test string.".lastIndexOf("test")'), 16);
  assert.strictEqual(E.toStr(await ev('"This is just a simple test string.".match(/is/g)')), 'is,is');
  assert.strictEqual(await ev('"yet another test string".replace("test", "dull test")'), 'yet another dull test string');
  assert.strictEqual(await ev('"yet another test string".search("another")'), 4);
  assert.strictEqual(await ev('"Hello World!".slice(1,5)'), 'ello');
  assert.strictEqual(await ev('"746,34".split(",")[1]'), '34');
  assert.strictEqual(await ev('"Hello World!".substr(1,4)'), 'ello');
  assert.strictEqual(await ev('"Hello World!".substring(1,4)'), 'ell');
  assert.strictEqual(await ev('"tHIs Is".toLowerCase() + "x".toUpperCase()'), 'this isX');
  assert.strictEqual(await ev('"abc".length'), 3);
});
t('arrays (NEAT Arrays page examples)', async () => {
  const s = S();
  await ev('myArray = ["a","b","c","d"]', s);
  assert.strictEqual(await ev('myArray.push("e")', s), 5);
  assert.strictEqual(await ev('"myArray = " + myArray', s), 'myArray = a,b,c,d,e');
  assert.strictEqual(await ev('myArray.pop()', s), 'e');
  assert.strictEqual(await ev('myArray.unshift("_")', s), 5);
  assert.strictEqual(await ev('myArray.shift()', s), '_');
  assert.strictEqual(E.toStr(await ev('["Jordan","alex"].concat(["Emma"], ["Luke"])')), 'Jordan,alex,Emma,Luke');
  assert.strictEqual(E.toStr(await ev('["b", "a", "d", "c"].sort()')), 'a,b,c,d');
  assert.strictEqual(await ev('["a", "b"].join()'), 'a,b');
  assert.strictEqual(await ev('["google", "yahoo", "DuckDuckGo", "Bing", "DuckDuckGo"].lastIndexOf("DuckDuckGo")'), 4);
  assert.strictEqual(E.toStr(await ev('["1","2","3"].reverse()')), '3,2,1');
  assert.strictEqual(E.toStr(await ev('["Safari", "IE", "FireFox", "Chrome"].splice(2, 2)')), 'FireFox,Chrome');
  assert.strictEqual(E.toStr(await ev('["IE", "Chrome", "FireFox", "Safari"].slice(1, 3)')), 'Chrome,FireFox');
  assert.strictEqual(await ev('["bob",["count",1,2,3],["letters","a"]][1][0]'), 'count');
  assert.strictEqual(await ev('[ {a:1},{b:2} ][1].b'), 2);
  assert.strictEqual(E.toStr(await ev('[[1, 2], 3]')), '1,2,3');
});
t('objects: literals, nesting, and [object Object] as NEAT prints it', async () => {
  const s = S();
  await ev('PlayerDetails = {Owner:"NEAT", Group:1, "two words": {deep: [7]}}', s);
  assert.strictEqual(await ev('"Player {PlayerDetails.Owner} is in group {PlayerDetails.Group}"', s), 'Player NEAT is in group 1');
  assert.strictEqual(await ev('PlayerDetails["two words"].deep[0]', s), 7);
  assert.strictEqual(E.toStr(await ev('PlayerDetails', s)), '[object Object]');
  await ev('PlayerDetails.Group = 2', s);
  await ev('PlayerDetails["x"] = [1]', s);
  await ev('PlayerDetails.x[0] += 4', s);
  assert.deepStrictEqual([s.vars.get('PlayerDetails').Group, s.vars.get('PlayerDetails').x[0]], [2, 5]);
});
t('regex literals, and SortingMemberList\'s replace into object text', async () => {
  const s = S();
  s.specials.set('$result', 'header\n"Bob","Leader","100"\n"Ann","Member","250"');
  const text = await ev('"members = [ " + $result.replace(/^"(.*?)","(.*?)","(.*?)"$/gm, "\\{ lord:\\"$1\\", position:\\"$2\\", prestige:$3 \\}").split("\\n").splice(1).join(",\\n") + " ]"', s);
  assert.match(text, /^members = \[ \{ lord:"Bob", position:"Leader", prestige:100 \},\n\{ lord:"Ann"/);
  await ev(text, s);
  assert.strictEqual(await ev('members.sortOn("prestige", 18)[0].lord', s), 'Ann', '18 = descending, numeric');
  assert.strictEqual(await ev('/b+/i.test("aBBc")'), true);
  assert.strictEqual(await ev('10 / 2 / 5'), 1, 'a slash after a value divides');
});

section('expressions: functions and CreateFunction');

t('CreateFunction with forEach, map, filter, some, every, reduce and sort', async () => {
  const s = S();
  await ev('Arr = [1,2,3,4]', s);
  await ev('Arr2 = []', s);
  await ev('MyFunction = CreateFunction("currentValue,Index,Array","Arr2.push(currentValue)")', s);
  await ev('Arr.forEach(MyFunction)', s);
  assert.strictEqual(await ev('"the old array is {Arr}, the new array after processing is: {Arr2}"', s),
    'the old array is 1,2,3,4, the new array after processing is: 1,2,3,4');
  await ev('lessthan10 = CreateFunction("x,ind,arr", "x < 10")', s);
  await ev('arr = [ 20, 5, 10, 11, 7, 3.4, 21, 1, 7, 9 ]', s);
  assert.strictEqual(await ev('arr.some(lessthan10)', s), true);
  assert.strictEqual(E.toStr(await ev('arr.filter(lessthan10)', s)), '5,7,3.4,1,7,9');
  assert.strictEqual(await ev('arr.every(lessthan10)', s), false);
  assert.strictEqual(E.toStr(await ev('arr.map(CreateFunction("v", "v * 2")).slice(0, 2)', s)), '40,10');
  assert.strictEqual(await ev('arr.reduce(CreateFunction("a,v", "a + v"), 0)', s), 94.4);
  assert.strictEqual(E.toStr(await ev('arr.sort(CreateFunction("a,b", "b - a")).slice(0, 3)', s)), '21,20,11');
  assert.strictEqual(await ev('arr.find(CreateFunction("v", "v < 5"))', s), 3.4);
  assert.strictEqual(await ev('arr.findIndex(CreateFunction("v", "v == 20"))', s), 1);
});
t('a CreateFunction body may assign: total += x (CreateFunction page)', async () => {
  const s = S();
  s.layers.unshift({ cities: [{ cityManager: { troop: { archer: 10 } } }, { cityManager: { troop: { archer: 32 } } }] });
  await ev('addTotal = CreateFunction("x,ind,arr", "total+=x")', s);
  await ev('getArchers = CreateFunction("city,ind,arr", "city.cityManager.troop.archer")', s);
  await ev('total = 0', s);
  await ev('cities.map(getArchers).forEach(addTotal)', s);
  assert.strictEqual(await ev('"Total (idle) archers in all cities is: {total}."', s), 'Total (idle) archers in all cities is: 42.');
  await ev('t = 0', s);
  await ev('[1,2].forEach(CreateFunction("v", "false || t += v"))', s);
  assert.strictEqual(s.vars.get('t'), 3, 'an assignment at the end of an || chain');
});
t('async globals, Promise getters and a plain JS comparator in sort', async () => {
  const s = S();
  s.layers.unshift({
    later: async (v) => { await new Promise((r) => setTimeout(r, 5)); return v * 2; },
    get slow() { return Promise.resolve({ n: 7 }); },
    byN: (a, b) => a.n - b.n,
  });
  assert.strictEqual(await ev('later(21)', s), 42);
  assert.strictEqual(await ev('slow.n + 1', s), 8);
  assert.strictEqual(E.toStr(await ev('[{n:3},{n:1},{n:2}].sort(byN).map(CreateFunction("o","o.n"))', s)), '1,2,3');
  assert.strictEqual(await ev('[1,2,3].filter(CreateFunction("v", "later(v) > 2")).length', s), 2);
});
t('rawArgs: NEAT\'s unquoted hero strings reach a function that asks for them', async () => {
  const s = S();
  const IsHeroInCastle = (spec) => `asked for ${spec}`;
  IsHeroInCastle.rawArgs = true;
  const plain = (x) => x;
  s.layers.unshift({ IsHeroInCastle, heros: IsHeroInCastle, plain });
  assert.strictEqual(await ev('IsHeroInCastle(any:att>200)', s), 'asked for any:att>200');
  assert.strictEqual(await ev('heros(Queen)', s), 'asked for Queen', 'a bare name nothing defines');
  await ev('Queen = "Bob"', s);
  assert.strictEqual(await ev('heros(Queen)', s), 'asked for Bob', 'a defined name is its value');
  await assert.rejects(ev('plain(any:att>200)', s), /not an expression — put text in quotes/);
  assert.throws(() => E.parseExpression('plain("a" b)'), /unexpected/);
});

section('expressions: the sandbox and its errors');

t('__proto__, prototype and constructor are never reached', async () => {
  for (const src of ['x.__proto__', '"a".constructor', '[].constructor', 'CreateFunction.constructor', 'f.prototype']) {
    await assert.rejects(ev(src), /cannot be (read|used)/, src);
  }
  await assert.rejects(ev('"a"["constructor"]'), /cannot be read/);
  await assert.rejects(ev('[]["__proto__"]'), /cannot be read/);
  assert.throws(() => E.parseExpression('{__proto__: 1}'), /cannot be a key/);
  assert.strictEqual(await ev('CreateFunction.call'), undefined, 'Function.prototype stays out of reach');
  await assert.rejects(ev('o = {}; o'), /unexpected/);
});
t('a script-made object cannot become thenable, and a game-made one cannot be changed', async () => {
  const s = S();
  await ev('o = {}', s);
  await assert.rejects(ev('o.then = CreateFunction("a,b", "1")', s), /cannot be set/);
  assert.throws(() => E.parseExpression('{then: 1}'), /cannot be a key/);
  class Bean { constructor() { this.archer = 5; } }
  s.layers.unshift({ get city() { return new Bean(); } });
  assert.strictEqual(await ev('city.archer', s), 5);
  await assert.rejects(ev('city.archer = 9', s), /cannot be changed/);
});
t('constants a provider marks read-only cannot be assigned (exact case)', async () => {
  const s = new E.Scope({ layers: [{ BuildVersion: '3200', E: Math.E }], readOnly: new Set(['BuildVersion', 'E']) });
  await assert.rejects(ev('BuildVersion = ""', s), /BuildVersion is a constant/);
  await ev('e = 5', s);
  assert.strictEqual(s.vars.get('e'), 5, 'e is not E');
});
t('parse errors say where', () => {
  assert.throws(() => E.parseExpression('1 +'), /the expression ends too soon \(column 4\)/);
  assert.throws(() => E.parseExpression('(1 + 2'), /column/);
  assert.throws(() => E.parseExpression('"open'), /no closing "/);
  assert.throws(() => E.parseExpression('a b'), /unexpected "b" \(column 3\)/);
  assert.match(errsOf('x = (1 +')[0], /^assignment: the expression ends too soon \(column 9\)/);
  assert.match(errsOf('if (1 + ) goto a\nlabel a')[0], /^if: unexpected "\)" \(column 9\)/);
});
t('run-time errors name the part that failed', async () => {
  await assert.rejects(ev('castle.coords'), /castle is undefined, so it has no \.coords/);
  await assert.rejects(ev('nosuch(1)'), /nosuch is not a function \(nothing by that name is defined\)/);
  await assert.rejects(ev('[1].forEach(5)'), /forEach needs a function/);
});

// ---------------------------------------------------------------------------
section('control flow');

t('goto jumps both ways; label names ignore case', async () => {
  const r = await runSrc('i = 0\nlabel Top\ni++\nif i < 3 goto top\necho "i is " + i\ngoto END\necho "skipped"\nlabel end');
  assert.deepStrictEqual(r.echoed, ['i is 3']);
});
t('gosub and return, nested two deep (the IfGosub shape)', async () => {
  const r = await runSrc('gosub a\necho "back"\nend\nlabel a\necho "in a"\ngosub b\necho "a again"\nreturn\nlabel b\necho "in b"\nreturn');
  assert.deepStrictEqual(r.echoed, ['in a', 'in b', 'a again', 'back']);
});
t('gosubreturn is return; a top-level return ends the script (AutoRunScript)', async () => {
  const r = await runSrc('gosub s\nif city.timeSlot != 0 return\necho "only the first city"\nend\nlabel s\necho "sub"\ngosubreturn',
    { globals: { city: { timeSlot: 1 } } });
  assert.deepStrictEqual(r.echoed, ['sub']);
});
t('if: brackets optional, nested, && and ||, and any line after it', async () => {
  const r = await runSrc([
    'a = 1', 'b = 1',
    'if (a == 1) if (b == 1) echo "Both a and b are equal to 1"',
    'if a == 1 && b == 2 echo "no"',
    'if a == 2 or b == 1 echo "or works"',
    'if $error goto bad',
    'if a item = "set by if"',
    'echo item',
    'if 10 > 11 goto bad',
    'end',
    'label bad', 'echo "bad"',
  ].join('\n'));
  assert.deepStrictEqual(r.echoed, ['Both a and b are equal to 1', 'or works', 'set by if']);
});
t('ifgoto and ifgosub, with or without spaces and brackets', async () => {
  const r = await runSrc('i = 0\ncount = 2\nlabel loop1\nifgoto i>=count done\ni = i + 1\nifgosub ( i == 1 ) one\ngoto loop1\nlabel done\necho "i=" + i\nend\nlabel one\necho "one"\nreturn');
  assert.deepStrictEqual(r.echoed, ['one', 'i=2']);
});
t('end, and exit (which never closes the console)', async () => {
  const r = await runSrc('echo "a"\nend\necho "b"');
  assert.deepStrictEqual(r.echoed, ['a']);
  const x = await runSrc('echo "a"\nexit\necho "b"');
  assert.deepStrictEqual(x.echoed, ['a']);
  assert.match(x.text, /exit — the script ends here \(the console stays on\)/);
});
t('die ends the run with its message in $error', async () => {
  const seen = {};
  const r = await runSrc('echo "a"\ndie "Oh uh! Seems we had an error"\necho "b"',
    { globals: { spy: seen } });
  assert.deepStrictEqual(r.echoed, ['a']);
  assert.match(r.text, /line 2: die — Oh uh! Seems we had an error/);
});
t('stop without a resume hook ends the script, and says so', async () => {
  const r = await runSrc('echo "a"\nstop\necho "b"');
  assert.deepStrictEqual(r.echoed, ['a']);
  assert.match(r.text, /line 2: stop — this run cannot be paused and resumed, so the script ends here/);
});
t('stop with a pause hook waits for it, then carries on (or ends on false)', async () => {
  let asked = null;
  const r = await runSrc('echo "a"\nstop\necho "b"', {
    onPause: (info) => { asked = info; return new Promise((res) => setTimeout(() => res(true), 40)); },
  });
  assert.deepStrictEqual(r.echoed, ['a', 'resumed', 'b']);
  assert.deepStrictEqual(asked, { line: 2, next: 3 });
  const no = await runSrc('stop\necho "b"', { onPause: async () => false });
  assert.deepStrictEqual(no.echoed, ['not resumed — the script ends here']);
  let stop = false;
  setTimeout(() => { stop = true; }, 60);
  const t0 = Date.now();
  const st = await runSrc('stop\necho "b"', { onPause: () => new Promise(() => {}), shouldStop: () => stop });
  assert.ok(Date.now() - t0 < 1500, 'Stop ends a pause');
  assert.match(st.text, /stopped — the rest of the script was not run/);
});
t('startLine: a line number (the Run box) or a label (autorun)', async () => {
  const src = 'echo "1"\necho "2"\nlabel autorun\necho "4"';
  assert.deepStrictEqual((await runSrc(src, { startLine: 2 })).echoed, ['2', '4']);
  assert.deepStrictEqual((await runSrc(src, { startLine: 'autorun' })).echoed, ['4']);
  const past = await runSrc(src, { startLine: 99 });
  assert.deepStrictEqual(past.echoed, ['1', '2', '4']);
  assert.match(past.text, /line 99 is past the end of the script — starting at line 1/);
});

section('control flow: loop and repeat');

t('loop N runs the whole script N times in all; loop label N a section', async () => {
  assert.deepStrictEqual((await runSrc('echo "x"\nloop 3')).echoed, ['x', 'x', 'x']);
  assert.deepStrictEqual((await runSrc('echo "a"\nlabel s\necho "b"\nloop s 3')).echoed, ['a', 'b', 'b', 'b']);
  assert.deepStrictEqual((await runSrc('echo "a"\nlabel s\necho "b"\nloop 2 s\necho "c"')).echoed, ['a', 'b', 'b', 'c']);
});
t('a loop inside a loop starts counting again each time round', async () => {
  const r = await runSrc('label outer\necho "o"\nlabel inner\necho "i"\nloop inner 2\nloop outer 2');
  assert.deepStrictEqual(r.echoed, ['o', 'i', 'i', 'o', 'i', 'i']);
});
t('loop and loop 0 go on until Stop; a dry run does not go round', async () => {
  let n = 0;
  const r = await runSrc('echo "x"\nloop', { shouldStop: () => ++n > 40 });
  assert.ok(r.echoed.length > 2);
  assert.match(r.text, /stopped/);
  const d = await runSrc('echo "x"\nloop 0', { dryRun: true });
  assert.deepStrictEqual(d.echoed, ['x']);
  assert.match(d.text, /loop — \[dry run\] would go back to the top/);
});
t('OTTObot\'s loop N ... endloop block still works, nested too', async () => {
  const w = world();
  const r = await runSrc('loop 2\n  train a 1\n  loop 2\n    echo "in"\n  endloop\nendloop\necho "after"', { w });
  assert.strictEqual(w.sent.length, 2);
  assert.deepStrictEqual(r.echoed.filter((l) => !/^train/.test(l)), ['in', 'in', 'in', 'in', 'after']);
});
t('repeat runs the last line that ran again, even one an if or execute ran', async () => {
  const rec = recorder();
  await runSrc('x = 1\nif x poke once\nrepeat 3\nexecute "poke built"\nrepeat 2\npoke last\nrepeat 1', { modules: [rec.mod] });
  // repeat N: N runs in all, the one above included (repeat 1 adds none)
  assert.deepStrictEqual(rec.calls, ['poke once', 'poke once', 'poke once', 'poke built', 'poke built', 'poke last']);
});
t('repeat 0 and a bare repeat go until the line fails', async () => {
  const w = world({ trainReplies: [{ ok: 1 }, { ok: 1 }, { ok: -5, errorMsg: 'no food' }] });
  const r = await runSrc('train a 1\nrepeat 0\necho "after"', { w });
  assert.strictEqual(w.sent.length, 3);
  assert.match(r.text, /repeat ends — line 1 did not go through/);
});
t('execute "repeat N" repeats the line the execute before it built (NEAT Call page idiom)', async () => {
  const rec = recorder();
  const items = { 'player.box.1': 3 };
  const r = await runSrc([
    'item = "player.box.1"',
    'numberOfItems = ItemCount(item)',
    'echo "I have "+numberOfItems+" "+item',
    'if numberOfItems execute "useitem " + item',
    'if numberOfItems execute "repeat " + min(numberOfItems, 5)',
  ].join('\n'), { modules: [rec.mod], globals: { ItemCount: (id) => items[id] || 0, min: Math.min } });
  assert.strictEqual(r.echoed[0], 'I have 3 player.box.1');
  // one useitem, then repeat 3: three in all, every item held
  assert.deepStrictEqual(rec.calls, ['useitem player.box.1', 'useitem player.box.1', 'useitem player.box.1']);
});

section('variables');

t('assignment forms: = += -= *= /= %= ++ -- and member/index', async () => {
  const r = await runSrc('a = 10\na += 5\na -= 3\na *= 2\na /= 4\nb = 7\nb %= 4\nc = 1\nc++\nc++\nc--\nl = [1, {v: 2}]\nl[0] = "x"\nl[1].v += 1\necho a b c l[0] l[1].v');
  assert.deepStrictEqual(r.echoed, ['6 3 2 x 3']);
});
t('%var% is swapped in when its line runs, so it can change in a loop', async () => {
  const r = await runSrc('count = 0\nset n 1\nlabel top\necho "pass %n%"\ncount += 1\nexecute "set n " + (count + 1)\nif count < 3 goto top');
  assert.deepStrictEqual(r.echoed, ['pass 1', 'pass 2', 'pass 3']);
});
t('%var% falls back to a true variable; one set nowhere is refused before the run', async () => {
  const r = await runSrc('target = "111,222"\necho "%target%"\necho %TARGET%');
  assert.deepStrictEqual(r.echoed, ['111,222', '111,222']);
  assert.match(errsOf('echo %nope%')[0], /%nope% is not set — put {2}set nope <value> {2}above this line/);
  assert.deepStrictEqual(errsOf('// %nope% in a comment is fine\necho "x" // %nope%'), []);
});
t('%var% in a march line (the tutorial\'s set target 111,222)', async () => {
  const acts = script.parse('set target 111,222\nattack %target% Bubba s:100k');
  assert.deepStrictEqual(acts[0].target, { x: 111, y: 222 });
  assert.strictEqual(acts[0].raw, 'attack 111,222 Bubba s:100k');
});
t('$result and $error after every command, a refused reply included', async () => {
  const w = world({ trainReplies: [{ ok: -5, errorMsg: 'not enough food' }, { ok: 1 }] });
  const r = await runSrc([
    'echo "before: " + $error',
    'train a 1',
    'if $error echo "failed: " + $error',
    'train a 1',
    // NEAT's NewCityScript tests `$error == null` after a command that worked
    'if $error == null echo "worked, and it said: " + $result.split("\\n")[0]',
    'if !$error echo "and !$error agrees"',
  ].join('\n'), { w });
  assert.deepStrictEqual(r.echoed.filter((l) => /^(before|failed|worked|and)/.test(l)), [
    'before: null', 'failed: FAILED (ok=-5) - not enough food',
    'worked, and it said: train 1 x Archer (type 7) in Home', 'and !$error agrees']);
});
t('@ silences a line, its output and its failure, but $error still tells', async () => {
  const w = world({ trainReplies: [{ ok: -5, errorMsg: 'no food' }] });
  const r = await runSrc('@train a 1\n@echo "quiet"\necho "err=" + $error', { w });
  assert.strictEqual(w.sent.length, 1);
  assert.deepStrictEqual(r.out, ['line 3: echo "err=" + $error', '  err=FAILED (ok=-5) - no food']);
});
t('comments: // and # at the start, // after code, never inside quotes', async () => {
  const r = await runSrc('# a comment\n// another\necho "http://example.com" // trailing\necho it\'s fine // note');
  assert.deepStrictEqual(r.echoed, ['http://example.com', "it's fine"]);
});

section('echo and print');

t('echo is an expression list; bare words and non-expressions print as written', async () => {
  const r = await runSrc('echo after\necho hello world\necho 14:30\necho Buddy I don\'t have enough scouts, I\'m not sending!\nx = 3\necho "x" x (x + 1) "end"\necho "a\\nb"');
  assert.deepStrictEqual(r.echoed, ['after', 'hello world', '14:30', "Buddy I don't have enough scouts, I'm not sending!", 'x 3 4 end', 'a', 'b']);
});
t('print is plain text with %vars% only (NEAT Print page)', async () => {
  const r = await runSrc('set blurb Testing\nprint %blurb%\nblurb = "x"\nprint blurb\nprint 1 + 1');
  assert.deepStrictEqual(r.echoed, ['Testing', 'blurb', '1 + 1']);
});

section('execute, call, command, functions');

t('execute builds a goto (NEAT Execute page)', async () => {
  const r = await runSrc('execute "goto city" + city.timeSlot\nlabel city1\necho "one"\nend\nlabel city2\necho "two"\nend',
    { globals: { city: { timeSlot: 2 } } });
  assert.deepStrictEqual(r.echoed, ['two']);
});
t('a line execute builds that cannot run sets $error, and the script goes on', async () => {
  const r = await runSrc('execute "goto nowhere"\necho "e1=" + $error\nexecute "frobnicate 5"\necho "e2=" + $error');
  assert.deepStrictEqual(r.echoed.filter((l) => /^e\d/.test(l)), ['e1=there is no label "nowhere"', 'e2=unknown command: frobnicate']);
  assert.match(r.text, /line 1: goto nowhere\n {2}FAILED: there is no label "nowhere"/);
  const stopping = await runSrc('execute "goto nowhere"\necho "not reached"', { stopOnError: true });
  assert.deepStrictEqual(stopping.echoed.filter((l) => /reached/.test(l)), []);
});
t('call runs another script with the caller\'s true variables, not its %vars%', async () => {
  const scripts = {
    UseItems: 'echo "in " + who\nwho = "changed"\nreturn 7\necho "not here"',
    Percent: 'echo "%x%"',
    TrueVar: 'echo "%who%"',
  };
  const loadScript = async (name) => scripts[name] ?? null;
  const r = await runSrc('who = "caller"\nset x 5\ncall "UseItems"\necho "back: " + who + " " + $result + " %x%"', { loadScript });
  assert.deepStrictEqual(r.echoed, ['in caller', 'back: changed 7 5']);
  const p = await runSrc('set x 5\ncall "Percent"\necho $error', { loadScript });
  assert.match(p.echoed.slice(-1)[0], /^Percent line 1: %x% is not set/, 'the callee does not see the caller\'s set');
  const tv = await runSrc('who = "me"\ncall TrueVar', { loadScript });
  assert.deepStrictEqual(tv.echoed, ['me'], 'a true variable does reach %who%');
});
t('call: an unknown script and a missing hook are clear errors', async () => {
  const r = await runSrc('call "Nope"\necho $error', { loadScript: async () => null });
  assert.deepStrictEqual(r.echoed.slice(-1), ['there is no script "Nope" to call']);
  const h = await runSrc('call farm\necho $error');
  assert.match(h.echoed.slice(-1)[0], /this run cannot load other scripts/);
  const bad = await runSrc('call x\necho $error', { loadScript: async () => 'frob 1' });
  assert.match(bad.echoed.slice(-1)[0], /^x line 1: unknown command: frob/);
});
t('command runs an in-line command: output in $result, failure in $error', async () => {
  const rec = recorder();
  const r = await runSrc('var = "SomeDude"\ncommand "who " + var\necho $result.split(",")[2]\n@command "who nobody"\necho "e=" + $error\ncommand "nosuch"\necho "e=" + $error',
    { modules: [rec.mod] });
  assert.deepStrictEqual(r.echoed.filter((l) => /^(cities|e=)/.test(l)), ['cities 1', 'e=no such player', r.echoed.find((l) => /^e=there is no in-line command/.test(l))]);
});
t('function blocks, callfunc, return values and calls from expressions', async () => {
  const r = await runSrc([
    'callfunc greet("Bob")',
    'echo "got " + $result',
    'echo "twice: " + double(21)',
    'echo "fact: " + fact(5)',
    'echo "a is still " + a',
    'end',
    'function greet(name)',
    '  echo "hello " + name',
    '  return "hi " + name',
    'function double(a)',
    '  return a * 2',
    'function fact(n)',
    '  if n <= 1 return 1',
    '  return n * fact(n - 1)',
  ].join('\n'));
  assert.deepStrictEqual(r.echoed, ['hello Bob', 'got hi Bob', 'twice: 42', 'fact: 120', 'a is still undefined']);
});
t('env.evaluate, env.echoText and ctx.evaluate read the line\'s own scope (a function\'s arguments)', async () => {
  const heard = [];
  const mod = { commands: { shout: {
    parse: (args) => ({ args }),
    async run(a, env) { heard.push(await env.echoText(a.args), await env.evaluate(a.args), await env.ctx.evaluate('msg')); return {}; },
  } } };
  await runSrc('callfunc alert("fire")\nend\nfunction alert(msg)\n  shout msg + "!"\n  return', { modules: [mod] });
  assert.deepStrictEqual(heard, ['fire!', 'fire!', 'fire']);
});
t('a function at the top is skipped by the flow; endfunction closes a body', async () => {
  const r = await runSrc('function f(x)\n  echo "in f " + x\nendfunction\necho "start"\ncallfunc f(1)\necho "end"');
  assert.deepStrictEqual(r.echoed, ['start', 'in f 1', 'end']);
});
t('CompleteQuests\' function example with CreateFunction, filter, a JS comparator and execute', async () => {
  const rec = recorder();
  const castles = [
    { coords: '105,105', canScout: true, d: 7 }, { coords: '101,101', canScout: false, d: 1 }, { coords: '103,103', canScout: true, d: 3 },
  ];
  const r = await runSrc([
    'canScout = CreateFunction("v,i,a","v.canScout")',
    'targets = ["Scout city"]',
    'if targets.indexOf("Scout city") >= 0 callfunc scout_city()',
    'end',
    'function scout_city()',
    '  dist = 10',
    '  castle = CastlesInRectangle(city.x - dist, city.y - dist, city.x + dist, city.y + dist).filter(canScout).sort(city.compareByDistanceToCastle)[0]',
    '  if castle execute "scout {castle.coords}"',
    '  return',
  ].join('\n'), {
    modules: [rec.mod],
    globals: { city: { x: 100, y: 100, compareByDistanceToCastle: (a, b) => a.d - b.d }, CastlesInRectangle: () => castles.slice() },
  });
  assert.deepStrictEqual(rec.calls, ['scout 103,103'], r.text);
});

section('load-time refusals and the editor\'s line colours');

t('what can be known before running is refused', () => {
  assert.match(errsOf('goto nowhere')[0], /goto: there is no label "nowhere"/);
  // a subroutine that never returns only warns: NEAT runs them (LoadGoals page)
  assert.deepStrictEqual(errsOf('gosub sub\nend\nlabel sub\necho "x"'), []);
  assert.match(script.lineStatus('gosub sub\nend\nlabel sub\necho "x"').lines[0].msg, /gosub sub: there is no return after label sub/);
  assert.match(errsOf('frobnicate 5')[0], /unknown command: frobnicate/);
  assert.match(errsOf('callfunc nope()')[0], /there is no function nope/);
  assert.match(errsOf('label a\nlabel A')[0], /label A is already on line 1/);
  assert.match(errsOf('endloop')[0], /endloop without loop/);
  assert.match(errsOf('loop nolabel')[0], /loop: there is no label "nolabel"/);
  assert.match(errsOf('if x')[0], /if: say what to do when it is true/);
  assert.match(errsOf('echo "x"\nlogout now 1:05:00\necho "late"')[0], /nothing can run after logout/);
  assert.deepStrictEqual(errsOf('if x logout now 1:05:00\necho "fine"'), [], 'a logout that may not happen');
  assert.deepStrictEqual(errsOf('label a\necho "x"\ngoto a'), []);
});
t('a jump cannot cross a function\'s edge', () => {
  assert.match(errsOf('function f()\n  goto out\nendfunction\nlabel out')[0], /the label is outside the function/);
  assert.match(errsOf('goto inside\nfunction f()\n  label inside')[0], /the label is inside function f/);
});
t('lineStatus: the goals branch\'s shape, with # comments and warnings', () => {
  const s = script.lineStatus('echo "a"\n\n// note\n# note\ngoto nowhere\nif undefinedThing echo "x"');
  assert.deepStrictEqual(s.lines.map((l) => l.status), ['ok', 'blank', 'comment', 'comment', 'error', 'ok']);
  assert.match(s.lines[4].msg, /no label "nowhere"/);
  assert.deepStrictEqual(s.errors, [{ line: 5, error: 'goto: there is no label "nowhere"' }]);
  assert.match(s.lines[5].msg, /"undefinedThing" is never set in this script/);
});
t('parse keeps its old shapes: actions for commands, set lines unlisted', () => {
  const acts = script.parse('set t 1,2\ntrain a 10k\nx = 1\nlabel a\nsleep rnd:5:10\nrepeat 3');
  assert.deepStrictEqual(acts.map((a) => a.cmd), ['train', 'assign', 'label', 'sleep', 'repeat']);
  assert.strictEqual(acts[0].amount, 10000);
  assert.deepStrictEqual(acts[3].rnd, [5, 10]);
  assert.deepStrictEqual(script.parseLine('sleep rnd:15').rnd, [0, 15]);
  assert.match((() => { try { script.parseLine('sleep rnd:9:2'); } catch (e) { return e.message; } return ''; })(), /cannot be smaller/);
});
t('goal lines go to run()\'s hooks first, then to a module\'s goalLines', async () => {
  assert.match(errsOf('zzgoal 5')[0], /unknown command: zzgoal/);
  const applied = [];
  const parseOpts = { parseGoalLine: (text) => (/^zzgoal\s/.test(text) ? { goal: text } : null) };
  assert.deepStrictEqual(errsOf('zzgoal 5', parseOpts), []);
  assert.match(errsOf('bogus 5', parseOpts)[0], /unknown command: bogus/);
  const r = await runSrc('zzgoal 5\necho "e=" + $error', { parseOpts, applyGoalLine: async (text, g) => { applied.push([text, g]); return 'goal set'; } });
  assert.deepStrictEqual(applied, [['zzgoal 5', { goal: 'zzgoal 5' }]]);
  assert.deepStrictEqual(r.echoed, ['goal set', 'e=null']);
  // a module's goalLines take a line no command claims
  const ran = [];
  const mod = { commands: {}, goalLines: {
    parse: (text) => (/^yygoal\b/.test(text) ? { text } : null),
    async run(a, env) { ran.push(a.text); env.log('  layered'); return { result: 'layer' }; },
  } };
  const m = await runSrc('yygoal a:5\necho $result', { modules: [mod] });
  assert.deepStrictEqual([ran, m.echoed], [['yygoal a:5'], ['layered', 'layer']]);
});

section('Stop and the event loop');

t('a tight goto loop does not starve the event loop, and Stop ends it', async () => {
  let stop = false;
  setTimeout(() => { stop = true; }, 60);
  const t0 = Date.now();
  const r = await runSrc('n = 0\nlabel a\nn++\ngoto a', { shouldStop: () => stop, globals: {} });
  assert.ok(Date.now() - t0 < 2000);
  assert.match(r.text, /stopped — the rest of the script was not run/);
});
t('Stop reaches a function running in a loop too', async () => {
  let stop = false;
  setTimeout(() => { stop = true; }, 60);
  const r = await runSrc('callfunc spin()\nend\nfunction spin()\n  label s\n  goto s', { shouldStop: () => stop });
  assert.match(r.text, /stopped/);
});

// ---------------------------------------------------------------------------
section('the NEAT wiki\'s examples, end to end');

t('Operators page: math, comparison, assignment, strings, ternary', async () => {
  assert.deepStrictEqual((await runSrc('// Math!\nmyVar=2\necho 10 * myVar')).echoed, ['20']);
  assert.deepStrictEqual((await runSrc('// Testing two numbers using comparison\nifgoto (1 != 2) doesnot\necho "They are equal!"\nend\n\nlabel doesnot\necho "They are not equal!"\nend')).echoed, ['They are not equal!']);
  assert.deepStrictEqual((await runSrc('//Setting a variable called myVar and giving it a value of 1.\nmyVar=1\necho "My variable is " + myVar')).echoed, ['My variable is 1']);
  assert.deepStrictEqual((await runSrc('myVar="Hello"\nmyVar2=" there!"\necho myVar + myVar2')).echoed, ['Hello there!']);
  assert.deepStrictEqual((await runSrc('var = true\necho "var " + (var == true ? "is" : "is not") + " true"')).echoed, ['var is true']);
});
t('Echo page: quotes, %var%, true variables, math, and joining', async () => {
  const globals = { city: { coords: '123,456', troop: { lightCavalry: 60000 } } };
  const r = await runSrc([
    'echo "This is a line that will show up in the log file"',
    'set blurb Testing', 'echo "%blurb%"',
    'blurb = "Testing"', 'echo blurb',
    'math = 1 + 1', 'echo math', 'echo 1 + 1', 'echo "1 + 1"',
    'echo "My city is located at " + city.coords',
    'cavs = city.troop.lightCavalry', 'phracts = 9858',
    'echo "My city at " + city.coords + " has " + (cavs + phracts) "horses in it."',
  ].join('\n'), { globals });
  assert.deepStrictEqual(r.echoed, ['This is a line that will show up in the log file', 'Testing', 'Testing', '2', '2', '1 + 1',
    'My city is located at 123,456', 'My city at 123,456 has 69858 horses in it.']);
});
t('Goto page: two labels in an endless loop, printed as the wiki shows', async () => {
  let n = 0;
  const out = [];
  const acts = script.parse([
    'label firstLabel', '1: echo "This is label 1\'s stuff"', '2: goto thirdLabel',
    'label secondLabel', '3: echo "This is label 2\'s stuff"', '4: repeat 2',
    'label thirdLabel', '5: echo "This is label 3\'s stuff"', '6: goto secondLabel',
  ].join('\n'));
  await script.run(world().g, acts, (m) => { out.push(m); if (/^ {2}This is/.test(m)) n++; },
    { castle: 'Home', repeatGapMs: 0, shouldStop: () => n >= 11 });
  // label 2 twice a round: repeat 2 is two runs in all
  assert.deepStrictEqual(echoes(out).map((l) => l.match(/label (\d)/)[1]), ['1', '3', '2', '2', '3', '2', '2', '3', '2', '2', '3']);
});
t('Gosub page: three subroutines, then sleep and loop 0', async () => {
  const rec = recorder();
  await runSrc([
    'gosub medalfarm', 'gosub trainarch', 'gosub upgradecot', 'sleep 30', 'loop 0',
    'label medalfarm', 'attack 123,300 !Bubba,!Xavier,any t:400,b:400', 'return',
    'label upgradecot', 'upgrade house', 'repeat 2', 'return',
    'label trainarch', 'train arch:2500 Hero', 'return',
  ].join('\n'), { modules: [rec.mod], shouldStop: () => rec.calls.length >= 4 });
  // "upgrade the cottage twice": upgrade house, repeat 2
  assert.deepStrictEqual(rec.calls, ['attack 123,300 !Bubba,!Xavier,any t:400,b:400', 'train arch:2500 Hero', 'upgrade house', 'upgrade house']);
});
t('Loop page: loop 5, and loop 5 cotupgrade', async () => {
  const rec = recorder();
  await runSrc('      upgrade farm\n      upgrade saw\n      upgrade iron\n      loop 5', { modules: [rec.mod] });
  assert.strictEqual(rec.calls.length, 15);
  const rec2 = recorder();
  await runSrc('upgrade farm\nupgrade saw\nupgrade iron\nlabel cotupgrade\nupgrade cottage\nloop 5 cotupgrade', { modules: [rec2.mod] });
  assert.deepStrictEqual(rec2.calls, ['upgrade farm', 'upgrade saw', 'upgrade iron', ...Array(5).fill('upgrade cottage')]);
});
t('Label page: three attacks, then loop upgrade 5', async () => {
  const rec = recorder();
  await runSrc('attack 360,843 any t:400,b:400\nattack 344,567 any t:400,b:400\nattack 400,543 any t:400,b:400\nlabel upgrade\nupgrade barrack\nloop upgrade 5', { modules: [rec.mod] });
  assert.deepStrictEqual(rec.calls.map((c) => c.split(' ')[0]), ['attack', 'attack', 'attack', 'upgrade', 'upgrade', 'upgrade', 'upgrade', 'upgrade']);
});
t('IfGoto page: m_context.Player.playerInfo.sex picks the label', async () => {
  const src = [
    '1: ifgoto ( m_context.Player.playerInfo.sex == 1 ) imaGirl',
    '2: ifgoto ( m_context.Player.playerInfo.sex == 0 ) imaGuy',
    '3: goto imNotSure',
    '4: label imaGirl', '5: echo "Girls rule and guys drool!"', '6: stop',
    '7: label imaGuy', '8: echo "Ugh, I don\'t care, just fetch me a beer!"', '9: stop',
    '10: label imNotSure', '11: echo "er? I shouldn\'t be here, I think the surgery went wrong!"', '12: stop',
  ].join('\n');
  const r = await runSrc(src, { globals: { m_context: { Player: { playerInfo: { sex: 0 } } } } });
  assert.deepStrictEqual(r.echoed, ["Ugh, I don't care, just fetch me a beer!"]);
  const x = await runSrc(src, { globals: { m_context: { Player: { playerInfo: { sex: 7 } } } } });
  assert.deepStrictEqual(x.echoed, ["er? I shouldn't be here, I think the surgery went wrong!"]);
});
t('IfGosub page: checks, nested subroutines, repeat 4, then sleep rnd and loop 0', async () => {
  const rec = recorder();
  const res = (amount) => ({ amount });
  await runSrc([
    'ifgosub ( m_city.cityManager.resource.stone.amount > 250000 ) CheckATT',
    'ifgosub ( m_city.cityManager.resource.iron.amount > 150000 ) CheckTrain',
    'sleep rnd:3000', 'loop 0', '//',
    'label CheckTrain', 'ifgosub ( m_city.cityManager.resource.wood.amount > 150000 ) TrainTroops', 'return', '//',
    'label CheckATT', 'ifgosub ( m_city.cityManager.resource.wood.amount > 250000 ) UpATT', 'return', '//',
    'label TrainTroops', 'train arch:250 Bubba', 'repeat 4', 'return', '//',
    'label UpATT', 'walldefense archertowers 250', 'return',
  ].join('\n'), {
    modules: [rec.mod],
    globals: { m_city: { cityManager: { resource: { stone: res(300000), iron: res(200000), wood: res(300000) } } } },
    shouldStop: () => rec.calls.length >= 5,
  });
  // "queue 250 archers with hero Bubba, 4 times"
  assert.deepStrictEqual(rec.calls, ['walldefense archertowers 250', ...Array(4).fill('train arch:250 Bubba')]);
});
t('Scr1ptingForDummies: the whole tutorial script, both ways the check can go', async () => {
  const at10 = new Date(); at10.setHours(10, 0, 0, 0);
  const tutorial = [
    '// First let\'s wait till it\'s 10AM before we check or do anything',
    '1: sleep @:10:00:00',
    '',
    '// This line is checking to see if you have 1mil+ scouts and if so goes to label scoutem',
    '2: ifgoto ( city.troop.scouter >= 1m ) scoutem',
    '// If you didn\'t go to label scoutem, then this next line will run instead',
    '3: goto warnbuddy',
    '',
    '// Here is label scoutem, you\'ll go here if you have 1mil+ scouts',
    '4: label scoutem',
    '5: attack %target% any,!Goliath s:100k',
    '6: repeat 8',
    '7: stop',
    '',
    '// Here is label warnbuddy, you\'ll go here if you don\'t have 1mil+ scouts',
    '8: label warnbuddy',
    '9: whisper Buddy I don\'t have enough scouts, I\'m not sending the attacks!',
  ].join('\n');
  const src = 'set target 111,222\n' + tutorial;
  // a clock 150 ms before ten, so the sleep is short
  const clockAt = (w) => { w.g.serverOffset = at10.getTime() - 150 - Date.now(); return w; };
  // "attack it 8 times": attack, repeat 8
  for (const [scouts, expect] of [[1.2e6, [...Array(8).fill('attack 111,222 any,!Goliath s:100k')]],
    [500000, ['whisper Buddy I don\'t have enough scouts, I\'m not sending the attacks!']]]) {
    const rec = recorder();
    const t0 = Date.now();
    const r = await runSrc(src, { modules: [rec.mod], w: clockAt(world()), globals: { city: { troop: { scouter: scouts } } } });
    assert.ok(Date.now() - t0 < 3000, 'slept only until ten');
    assert.deepStrictEqual(rec.calls, expect, r.text);
  }
  // the real commands read the whole tutorial too: deploy's attack with its hero
  // string, and social's whisper (the runs above use the recording fakes)
  const real = script.parse(src);
  assert.deepStrictEqual(real.filter((a) => a.cmd === 'error').map((a) => a.error), []);
  assert.deepStrictEqual(real.find((a) => a.cmd === 'attack').target, { x: 111, y: 222 });
  assert.strictEqual(real.find((a) => a.cmd === 'whisper').to, 'Buddy');
});
t('Scr1ptingForDummies: attack any,!Goliath + repeat 8 sends 8 marches with the real command', async () => {
  const w = world();
  const heros = w.g.castles[0].heros;
  for (let i = 1; i <= 8; i++) heros.push({ id: 100 + i, name: 'H' + i, status: 0, level: 10 });
  heros.push({ id: 99, name: 'Goliath', status: 0, level: 900, power: 999 });
  const r = await runSrc('attack 111,222 any,!Goliath s:100\nrepeat 8', { w });
  const sends = w.sent.filter((s) => s.cmd === 'newArmy');
  assert.strictEqual(sends.length, 8, r.text);
  assert.ok(sends.every((s) => s.bean.heroId !== 99), 'never Goliath');
  assert.strictEqual(r.done, 8);
  assert.match(r.text, /\(run 8 of 8\)/);
});
t('Arrays and JSON pages in a script', async () => {
  const r = await runSrc([
    'browser = ["Safari", "IE", "FireFox", "Chrome"]', 'echo browser[0]',
    'thejson = {this:"that"}', 'echo thejson', 'echo thejson.this',
    'array = ["bob",["count",1,2,3],["letters","a","b","c"],"bill"]',
    'echo array[1][0]+" The amount of "+array[2][0]"in this array."',
    'echo array[0]+" & "+array[3]+" have been added to the main array also."',
  ].join('\n'));
  assert.deepStrictEqual(r.echoed, ['Safari', '[object Object]', 'that', 'count The amount of letters in this array.', 'bob & bill have been added to the main array also.']);
});

section('troop words (script-words.js)');

t('NEAT troop words in troop strings: arch:25000,warr:25000 and a:5k', () => {
  assert.deepStrictEqual(W.parseTroops('arch:25000,warr:25000,t:1000'), { archer: 25000, militia: 25000, carriage: 1000 });
  assert.deepStrictEqual(W.parseTroops('a:5k,cata:1,cp:2,pult:3,ram:4'), { archer: 5000, heavyCavalry: 1, catapult: 3, batteringRam: 4 });
  assert.deepStrictEqual(script.parseTroops('Archers:10'), { archer: 10 });
  assert.throws(() => W.parseTroops('zz:5'), /unknown troop code: zz/);
  assert.deepStrictEqual(script.parseLine('attack 245,325 Bubba arch:25000,warr:25000,t:1000').troops, { archer: 25000, militia: 25000, carriage: 1000 });
});
t('building, fortification, research and resource words', () => {
  assert.strictEqual(W.buildingByWord('house').name, 'Cottage');
  assert.strictEqual(W.buildingByWord('saw').name, 'Sawmill');
  assert.strictEqual(W.buildingByWord('barrack').name, 'Barracks');
  assert.strictEqual(W.buildingByWord('iron').name, 'Ironmine');
  assert.strictEqual(W.buildingByWord('Feasting Hall').name, 'Feasting Hall');
  assert.strictEqual(W.fortByWord('tre').name, 'Rock Fall');
  assert.strictEqual(W.fortByWord('r').name, 'Rolling Logs');
  assert.strictEqual(W.techByWord('met').name, 'Metal Casting');
  assert.strictEqual(W.resourceByWord('lumber'), 'wood');
  assert.strictEqual(script.parseLine('upgrade house').building.name, 'Cottage');
  assert.strictEqual(script.parseLine('research met').tech.name, 'Metal Casting');
  assert.strictEqual(script.parseLine('train arch 2500').troop.key, 'archer');
});

// ---------------------------------------------------------------------------
(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n + '\n'); continue; }
    try { await f(); console.log('  ok    ' + n); pass++; }
    catch (e) { console.log('  FAIL  ' + n + '\n        ' + String(e.message).split('\n').join('\n        ')); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
