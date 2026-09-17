'use strict';
// Goal lines in scripts (script-cmd-goals.js), offline, through the real VM
// (script.parse + script.run) against a real Game. The goal layer is a fake
// handed in as run()'s goalLayers: it records every call and answers in
// goallayers.js's shape ({ errors, lines, layer } | { error }), reading lines with
// this branch's goals.js. The real goallayers.js lives on goals/integration.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
// `get` reads the console's scripts folder first: one with no NewCityGoals.txt
process.env.EVONY_SCRIPTS_DIR = path.join(__dirname, 'no-such-folder-test-script-goals');
const C = require('./constants');
const { Game } = require('./game');
const script = require('./script');
const G = require('./goals');
const goalsCmd = require('./script-cmd-goals');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const F = (x, y) => C.coordsToFieldId(x, y);
const parseErr = (line) => { try { script.parseLine(line); } catch (e) { return e.message; } return null; };

// Home (id 1) has a town hall and a cottage; New (id 3) only its town hall.
function world() {
  const g = new Game();
  g.player = { playerInfo: { userName: 'Tester' } };
  const th = { typeId: 31, positionId: -1, level: 1, status: 0 };
  g.castles = [
    { id: 1, name: 'Home', fieldId: F(100, 100), heros: [], buildings: [th, { typeId: 1, positionId: 0, level: 1, status: 0 }] },
    { id: 2, name: 'Fla', fieldId: F(110, 100), heros: [], buildings: [th] },
    { id: 3, name: 'New', fieldId: F(120, 100), heros: [], buildings: [th] },
  ];
  return { g };
}

// The goal layer, recording. over.<fn>(...) may answer instead (return undefined to
// fall through); over.sets / over.cities are the texts loadgoals finds.
function fakeLayers(over = {}) {
  const calls = [];
  const layers = new Map();
  const key = (a, c) => `${a || ''}|${c}`;
  const setsSomething = (line) => { const p = G.parseGoals(line); return p.goals.length > 0 || Object.keys(p.config).length > 0; };
  const getScriptLayer = (a, c) => {
    const l = layers.get(key(a, c));
    return l ? { src: l.lines.join('\n'), setAt: 1, changedAt: 1, base: l.base, loaded: l.loaded, loadedSrc: l.loadedSrc, count: l.lines.length } : null;
  };
  const answer = (a, c, text, extra = {}) => {
    const p = G.parseGoals(text);
    const added = setsSomething(text);
    return { errors: p.errors.map((e) => ({ ...e, source: 'script', where: added ? 'script line 1' : 'script, not added' })),
      lines: p.lines || [], layer: getScriptLayer(a, c), ...extra };
  };
  const GL = {
    calls,
    SCRIPT_MAX_LINES: over.max || 1000,
    addScriptLine(a, c, line) {
      calls.push(['addScriptLine', a, c, line]);
      const o = over.addScriptLine && over.addScriptLine(a, c, line, calls);
      if (o) return o;
      if (setsSomething(line)) {
        const l = layers.get(key(a, c)) || { base: 'saved', loaded: null, loadedSrc: null, lines: [] };
        l.lines.push(line);
        layers.set(key(a, c), l);
      }
      return answer(a, c, line);
    },
    setScriptLayer(a, c, src) { calls.push(['setScriptLayer', a, c, src]); return answer(a, c, src); },
    loadScriptGoals(a, c, which) {
      calls.push(['loadScriptGoals', a, c, which]);
      const w = String(which ?? '').trim();
      if (w === '' || w === '0') return { errors: [], lines: [], layer: null, cleared: layers.delete(key(a, c)), loaded: 'the saved goals' };
      const text = /^\d$/.test(w) ? (over.sets || {})[w] : (over.cities || {})[w];
      if (!text) return { error: /^\d$/.test(w) ? `goal set ${w} is empty — write it in the console's goal editor (Goal set ${w})` : `loadgoals ${w}: not a goal set (1 to 9) nor one of this account's cities` };
      const label = /^\d$/.test(w) ? `goal set ${w}` : `the goals of ${w}`;
      layers.set(key(a, c), { base: 'loaded', loaded: label, loadedSrc: text, lines: [] });
      const p = G.parseGoals(text);
      return { errors: p.errors.map((e) => ({ ...e, source: 'loaded', where: `${label} line ${e.line}` })), lines: p.lines || [],
        layer: getScriptLayer(a, c), loaded: label };
    },
    resetScriptGoals(a, c) {
      calls.push(['resetScriptGoals', a, c]);
      layers.set(key(a, c), { base: 'reset', loaded: null, loadedSrc: null, lines: [] });
      return { errors: [], lines: [], layer: getScriptLayer(a, c) };
    },
    clearScriptLayer(a, c) { calls.push(['clearScriptLayer', a, c]); return layers.delete(key(a, c)); },
    getScriptLayer,
  };
  return GL;
}

// Commands the NEAT examples use that are not this module's: `get` reads a goal
// file through goalFile (as info's get does when no such file is on disk),
// the rest only record.
function helpers(calls) {
  const rec = (name) => ({
    usage: name + ' <anything>',
    parse: (args) => ({ cmd: name, args }),
    async run(a) { calls.push(`${name} ${a.args}`.trim()); return { done: 1 }; },
  });
  return {
    commands: {
      get: {
        usage: 'get "<file>"',
        parse: (args) => ({ cmd: 'get', name: args.trim().replace(/^"(.*)"$/, '$1') }),
        async run(a, env) {
          calls.push('get ' + a.name);
          const text = goalsCmd.goalFile(a.name, env);
          if (text === null) return { ok: false, error: `no file ${a.name}` };
          return { ok: true, result: text };
        },
      },
      create: rec('create'), walldefense: rec('walldefense'), setmayorbyname: rec('setmayorbyname'),
    },
  };
}

// A session whose organization holds the account's goal rows (tenancy's goals).
const sessionWith = (rows = {}, id = 7) => ({
  account: { id },
  org: { goals: { find: (acct, keys, kind) => (kind === 'goal' && rows.default ? { src: rows.default, cityKey: 'default', accountId: acct } : null) } },
});

async function runIn(src, { GL = fakeLayers(), modules = [], castle = 'Home', ...opts } = {}) {
  const w = world();
  const out = [];
  const view = script.parse(src, modules.length ? { modules } : {});
  const errs = view.filter((a) => a.cmd === 'error');
  if (errs.length) throw new Error('parse errors: ' + errs.map((e) => `line ${e.line}: ${e.error}`).join('; '));
  const done = await script.run(w.g, view, (m) => out.push(m),
    { castle, repeatGapMs: 0, session: { account: { id: 7 } }, goalLayers: GL, ...opts });
  return { done, out, text: out.join('\n'), GL };
}
const adds = (GL) => GL.calls.filter((c) => c[0] === 'addScriptLine').map((c) => c[3]);
const printed = (r, tag) => r.out.filter((l) => l.startsWith('  ' + tag)).map((l) => l.slice(2 + tag.length).trim());

// ---------------------------------------------------------------------------
section('the wiki pages\' usage and example lines parse');

t('Goal: goal config npc:5 | goal research ar:4,ms:5', () => {
  assert.deepStrictEqual(script.parseLine('goal config npc:5'), { cmd: 'goal', text: 'config npc:5', via: 'goal' });
  // no research goal yet on this side: let through, the goal layer answers when it runs
  assert.deepStrictEqual(script.parseLine('goal research ar:4,ms:5'), { cmd: 'goal', text: 'research ar:4,ms:5', via: 'goal' });
});
t('Goal: "config npc:5 as a script line would work" — any goal line on its own', () => {
  assert.deepStrictEqual(script.parseLine('config npc:5'), { cmd: 'config', text: 'config npc:5', via: 'config' });
  for (const l of ['troop a:5000', 'fortification ab:1k,at:500', 'comfortpolicy 15 16 popraise', 'traininghero Bob 120 180 0', 'hiding 2']) {
    assert.deepStrictEqual(script.parseLine(l), { cmd: 'goal', text: l, via: 'line' }, l);
  }
});
t('Config: config wartown:0, and several switches on one line', () => {
  assert.deepStrictEqual(script.parseLine('config wartown:0'), { cmd: 'config', text: 'config wartown:0', via: 'config' });
  assert.strictEqual(script.parseLine('config npc:5,comfort:1, buildnpc:5').text, 'config npc:5,comfort:1, buildnpc:5');
});
t('LoadGoals: loadgoals | loadgoals 3, and a city by name or castle id', () => {
  assert.deepStrictEqual(script.parseLine('loadgoals'), { cmd: 'loadgoals', which: '' });
  assert.deepStrictEqual(script.parseLine('loadgoals 3'), { cmd: 'loadgoals', which: '3' });
  assert.deepStrictEqual(script.parseLine('loadgoals 0'), { cmd: 'loadgoals', which: '0' });
  assert.deepStrictEqual(script.parseLine('loadgoals "Home City"'), { cmd: 'loadgoals', which: 'Home City' });
  assert.deepStrictEqual(script.parseLine('loadgoals 123456'), { cmd: 'loadgoals', which: '123456' });
});
t('LoadGoals: the trebbing session example parses whole', () => {
  const src = [
    '//Trebbing Session', 'gosub TrebSession', '', 'label BeginHere',
    'ifgoto ( m_city.cityManager.resource.stone.amount < 5b ) OuttaStone',
    'ifgoto ( m_city.cityManager.fortification.rockfall < 10500 ) Rebuildwall', 'goto BeginHere', '',
    'label Rebuildwall', 'setmayorbyname Queen', 'walldefense tre 11k build', 'sleep 15', 'goto BeginHere', '',
    'label OuttaStone', 'echo "Getting Low On Stone!"', 'loadgoals 0', 'stop', '',
    'label TrebSession', 'loadgoals 1', 'walldefense tra 50000 demo', 'walldefense ab 50000 demo',
    'walldefense at 50000 demo', 'walldefense r 50000 demo', 'walldefense tre 50000 demo', 'gosub BeginHere',
  ].join('\n');
  const view = script.parse(src, { modules: [helpers([])] });
  // its subroutines never return (the script ends at stop): a warning, no error
  assert.deepStrictEqual(view.filter((a) => a.cmd === 'error'), []);
  assert.deepStrictEqual(view.filter((a) => a.cmd === 'loadgoals').map((a) => [a.line, a.which]), [[17, '0'], [21, '1']]);
});
t('ResetGoals: resetgoals', () => {
  assert.deepStrictEqual(script.parseLine('resetgoals'), { cmd: 'resetgoals' });
});
t('BuildingGoals: buildinggoals st:0:0,b:9:12 is the build goal line', () => {
  assert.deepStrictEqual(script.parseLine('buildinggoals st:0:0,b:9:12'), { cmd: 'buildinggoals', text: 'build st:0:0,b:9:12', via: 'buildinggoals' });
});
t('TechGoals: techgoals ar:10,ho:10,mt:9 is the research goal line', () => {
  assert.deepStrictEqual(script.parseLine('techgoals ar:10,ho:10,mt:9'), { cmd: 'techgoals', text: 'research ar:10,ho:10,mt:9', via: 'techgoals' });
});
t('NewCityScript: the default script parses whole', () => {
  const view = script.parse(NEW_CITY_SCRIPT, { modules: [helpers([])] });
  assert.deepStrictEqual(view.filter((a) => a.cmd === 'error'), []);
  const last = view.find((a) => a.line === 10);
  assert.deepStrictEqual([last.cmd, last.then], ['if', { cmd: 'goal', expr: '$result', via: 'goal' }]);
});

section('what is a goal line, and what is not');

t('goal <expression>: its text is read when the line runs', () => {
  assert.deepStrictEqual(script.parseLine('goal $result'), { cmd: 'goal', expr: '$result', via: 'goal' });
  assert.deepStrictEqual(script.parseLine('goal "config npc:" + lvl'), { cmd: 'goal', expr: '"config npc:" + lvl', via: 'goal' });
});
t('a script command keeps its word: build cottage and research archery are not goals', () => {
  assert.strictEqual(script.parseLine('build cottage').cmd, 'build');
  assert.strictEqual(script.parseLine('research archery').cmd, 'research');
  assert.strictEqual(script.parseLine('goal build c:10:9').text, 'build c:10:9', 'goal says it is the goal');
});
t('build c:10:9, build ?w:10?q:0:0,ws:0:0 and research lo:5 are NEAT\'s goals (city routes them here)', async () => {
  for (const l of ['build c:10:9', 'build ?w:10?q:0:0,ws:0:0', 'build b:9:15', 'research lo:5,ho:5,com:4', 'research ?a:10?pr:10']) {
    const a = script.parseLine(l);
    assert.deepStrictEqual([a.cmd, a.text], ['goal', l], l);
  }
  assert.strictEqual(script.parseLine('build cottage').cmd, 'build');
  assert.strictEqual(script.parseLine('research archery').cmd, 'research');
  const r = await runIn('build b:9:15\nresearch lo:5\nif $error echo "ERR " + $error');
  assert.deepStrictEqual(adds(r.GL), ['build b:9:15', 'research lo:5']);
  // the research goal is OTTObot's own since the goals build-out: no refusal any more
  assert.deepStrictEqual(printed(r, 'ERR'), [], r.text);
});
t('a mistyped command is still an unknown command, not a goal', () => {
  assert.match(parseErr('atack 1,2 any a:1'), /unknown command: atack/);
  assert.match(parseErr('confg npc:5'), /unknown command: confg/);
  assert.match(parseErr('troops a:5'), /unknown command: troops/);
});
t('a NEAT goal OTTObot has no goal for, or a config switch written as a line, says so', () => {
  // the goals build-out brought processingpolicy, valleytroops, npc and buildnpc:
  // they are goal lines now, and a bare config key is read as its config line
  for (const l of ['processingpolicy t b r a s v n', 'valleytroops s:50k', 'npc 5', 'buildnpc 5']) {
    assert.strictEqual(script.parseLine(l).cmd, 'goal', l);
  }
  // the ones it still has no goal for
  assert.match(parseErr('capturedfirelimit 5'), /^capturedfirelimit is a NEAT goal OTTObot has no goal for yet/);
  assert.match(parseErr('nomayor 1'), /^nomayor is a config switch, not a line of its own — write {2}config nomayor:1$/);
  assert.match(parseErr('feastinghallspace 2'), /write {2}config feastinghallspace:2$/);
  // comfort is also NEAT's comfort command (city's module), which wins: never a goal
  assert.strictEqual(script.parseLine('comfort 1').cmd, 'comfort', 'comfort is NEAT\'s comfort command, never a goal');
});
t('comfort pray never reaches the goal layer, even where goals.js reads comfort as a config line', async () => {
  // the goals branch reads a bare config key as config (comfort pray -> config comfort:pray)
  const had = Object.prototype.hasOwnProperty.call(G.GOALS, 'comfort');
  if (!had) G.GOALS.comfort = { kind: 'config', multi: true, parse: () => ({ errors: [] }) };
  try {
    for (const l of ['comfort pray', 'levy 1', 'abandon', 'production 0 0 0 0']) {
      assert.strictEqual(goalsCmd.goalLines.parse(l), null, l);
      const a = script.parse(l)[0];
      assert.notStrictEqual(a.cmd, 'goal', l);
      if (a.cmd === 'error') assert.doesNotMatch(a.error, /goal|config switch/, l);
    }
    const GL = fakeLayers();
    const w = world();
    const view = script.parse('comfort pray\necho "after"');
    await script.run(w.g, view, () => {}, { castle: 'Home', goalLayers: GL });
    assert.deepStrictEqual(GL.calls, []);
  } finally { if (!had) delete G.GOALS.comfort; }
});
t('nothing is read as a goal while a command module failed to load, nor a word the registry has', () => {
  assert.strictEqual(goalsCmd.goalLines.parse('troop a:1', { failed: [{ file: 'script-cmd-city.js', error: 'boom' }] }), null);
  assert.strictEqual(goalsCmd.goalLines.parse('troop a:1', { words: new Map([['troop', {}]]) }), null);
  assert.deepStrictEqual(goalsCmd.goalLines.parse('troop a:1', { words: new Map(), failed: [] }), { cmd: 'goal', text: 'troop a:1', via: 'line' });
});
t('expressions and assignments stay what they are', () => {
  assert.strictEqual(script.parseLine('hiding = 5').cmd, 'assign');
  assert.strictEqual(script.parseLine('Config.autoUseItems([1])').cmd, 'expr');
});
t('a goal line the goals cannot read refuses the script, saying why', () => {
  assert.match(parseErr('config foo:1'), /^config: unknown config key "foo"/);
  assert.match(parseErr('troop a:5k,zz:1'), /^goal line: TROOP: unknown troop code "zz"/);
  assert.match(parseErr('buildinggoals zz:1'), /^buildinggoals: unknown building "zz"/);
  assert.match(parseErr('goal troop a:5k,zz:1'), /^goal: TROOP: unknown troop code "zz"/);
  assert.match(parseErr('goal create cottage'), /goal: "create" is not a goal — write a goal line after it/);
  const view = script.parse('echo "a"\nconfig foo:1');
  assert.deepStrictEqual(view.filter((a) => a.cmd === 'error').map((a) => a.line), [2]);
});
t('bare words give their usage', () => {
  assert.match(parseErr('goal'), /goal: usage {2}goal <goal line>/);
  assert.match(parseErr('config'), /config: usage {2}config <key>:<value>/);
  assert.match(parseErr('buildinggoals'), /buildinggoals: usage/);
  assert.match(parseErr('techgoals'), /techgoals: usage/);
  assert.match(parseErr('resetgoals now'), /resetgoals: nothing goes after it/);
});
t('the editor colours goal lines like any other', () => {
  const s = script.lineStatus('config npc:5\nconfig foo:1\ntroop a:1\n// note\n');
  assert.deepStrictEqual(s.lines.map((l) => l.status), ['ok', 'error', 'ok', 'comment', 'blank']);
});
t('goalAction, for another module\'s parse (city\'s build c:10:9)', () => {
  assert.deepStrictEqual(goalsCmd.goalAction('build c:10:9', 'build'), { cmd: 'goal', text: 'build c:10:9', via: 'build' });
  assert.throws(() => goalsCmd.goalAction('build zz:1', 'build'), /^Error: build: unknown building "zz"/);
});

section('each command, against the goal layer');

t('config npc:5 adds the line to this account\'s layer for the run\'s city', async () => {
  const r = await runIn('config npc:5\nif !$error echo "OK"\necho "count " + $result.count + " base " + $result.base');
  assert.deepStrictEqual(r.GL.calls, [['addScriptLine', 7, 1, 'config npc:5']]);
  assert.match(r.text, /line 1: config npc:5\n {2}-> ok — 1 script goal line on top of the saved goals/);
  assert.match(r.text, /\n {2}OK\n/);
  assert.match(r.text, /count 1 base saved/);
  assert.strictEqual(r.done, 0, 'nothing went to the server');
});
t('the city is the run\'s; the account is opts.accountId, else the session\'s, else none', async () => {
  let r = await runIn('config npc:5', { castle: 'Fla' });
  assert.deepStrictEqual(r.GL.calls[0].slice(1, 3), [7, 2]);
  r = await runIn('config npc:5', { accountId: 9 });
  assert.deepStrictEqual(r.GL.calls[0].slice(1, 3), [9, 1]);
  r = await runIn('config npc:5', { session: undefined });
  assert.deepStrictEqual(r.GL.calls[0].slice(1, 3), [null, 1]);
});
t('goal <line>, a bare goal line and buildinggoals all add a line', async () => {
  const r = await runIn('goal config npc:5\ntroop a:5000\nbuildinggoals st:0:0,b:9:12\ngoal build c:10:9\nfortification ab:1k');
  assert.deepStrictEqual(adds(r.GL), ['config npc:5', 'troop a:5000', 'build st:0:0,b:9:12', 'build c:10:9', 'fortification ab:1k']);
  assert.match(r.text, /-> ok — 5 script goal lines on top of the saved goals/);
  assert.doesNotMatch(r.text, /FAILED/);
});
t('a line the goal layer could not use is an error, not silence', async () => {
  // no goal word at all (plan is a goal since the goals build-out), so the layer
  // takes nothing from it
  const r = await runIn('goal $t\nif $error echo "ERR " + $error\necho "count " + $result.count', { globals: { $t: 'nosuchgoal x' } });
  assert.deepStrictEqual(adds(r.GL), ['nosuchgoal x']);
  assert.match(r.text, /-> FAILED - unknown goal "nosuchgoal" \(not added\)/);
  assert.deepStrictEqual(printed(r, 'ERR'), ['unknown goal "nosuchgoal" (not added)']);
  assert.deepStrictEqual(printed(r, 'count'), ['0']);
});
t('goal research ...: the research goal takes it (the goals build-out)', async () => {
  const r = await runIn('goal research ar:4,ms:5\nif $error echo "ERR " + $error');
  assert.deepStrictEqual(adds(r.GL), ['research ar:4,ms:5']);
  assert.match(r.text, /-> ok — 1 script goal line on top of the saved goals/);
  assert.deepStrictEqual(printed(r, 'ERR'), []);
  // a research line the goals cannot read still refuses the script at load time
  assert.match(parseErr('goal research nosuchtech:4'), /^goal: RESEARCH: unknown research "nosuchtech"/);
});
t('techgoals is goal research ... (NEAT deprecated it)', async () => {
  const r = await runIn('techgoals ar:10,ho:10,mt:9\nif $error echo "ERR " + $error');
  assert.deepStrictEqual(adds(r.GL), ['research ar:10,ho:10,mt:9']);
  assert.deepStrictEqual(printed(r, 'ERR'), [], r.text);
  assert.match(r.text, /-> ok — 1 script goal line on top of the saved goals/);
});
t('an error on a line that still set something: $error, and the line counts', async () => {
  const GL = fakeLayers({
    addScriptLine: () => ({ errors: [{ line: 1, text: 'config npc:5,foo:1', error: 'CONFIG: unknown config key "foo"', source: 'script', where: 'script line 1' }],
      lines: [], layer: { src: 'config npc:5', base: 'saved', loaded: null, count: 1 } }),
  });
  const r = await runIn('goal $t\nif $error echo "ERR " + $error\necho "count " + $result.count', { GL, globals: { $t: 'config npc:5,foo:1' } });
  assert.deepStrictEqual(printed(r, 'ERR'), ['CONFIG: unknown config key "foo"']);
  assert.deepStrictEqual(printed(r, 'count'), ['1']);
});
t('lines that read but do nothing yet are noted', async () => {
  const GL = fakeLayers({
    addScriptLine: (a, c, line) => ({ errors: [], lines: [{ n: 1, status: 'idle', msg: 'trade does nothing yet: no goal trades on the market yet' }],
      layer: { src: line, base: 'saved', loaded: null, count: 1 } }),
  });
  const r = await runIn('config trade:1', { GL });
  assert.match(r.text, /\n {2}note: trade does nothing yet: no goal trades on the market yet\n {2}-> ok/);
  const GL2 = fakeLayers({
    addScriptLine: (a, c, line) => ({ errors: [], lines: [{ n: 1, status: 'ok', msg: 'read as "config hiding:2" — hiding is a config key, so write it that way' }],
      layer: { src: line, base: 'saved', loaded: null, count: 1 } }),
  });
  const r2 = await runIn('hiding 2', { GL: GL2 });
  assert.match(r2.text, /\n {2}note: read as "config hiding:2" — hiding is a config key, so write it that way\n {2}-> ok/);
});
t('loadgoals N loads a goal set; loadgoals and loadgoals 0 end the layer', async () => {
  const GL = fakeLayers({ sets: { 1: 'config npc:0\nconfig hero:0' } });
  const r = await runIn('loadgoals 1\necho $result\necho "base " + $result.base\nconfig npc:5\nloadgoals\necho "cleared " + $result.cleared\nloadgoals 0\necho "cleared " + $result.cleared', { GL });
  assert.deepStrictEqual(GL.calls.map((c) => [c[0], c[3]]), [['loadScriptGoals', '1'], ['addScriptLine', 'config npc:5'], ['loadScriptGoals', ''], ['loadScriptGoals', '0']]);
  assert.match(r.text, /line 1: loadgoals 1\n {2}-> ok — running goal set 1 in place of the saved goals\n/);
  assert.match(r.text, /\n {2}running goal set 1 in place of the saved goals\n.*\n {2}base loaded\n/, 'echo $result prints the summary');
  assert.match(r.text, /-> ok — running goal set 1 in place of the saved goals, with 1 script goal line on top/);
  assert.match(r.text, /-> ok — the script goals are gone: the city runs its saved goals again\n.*\n {2}cleared true/);
  assert.match(r.text, /-> ok — there were no script goals: the city runs its saved goals\n.*\n {2}cleared false/);
});
t('loadgoals of a city by name; a set that is not there is $error', async () => {
  const GL = fakeLayers({ cities: { 'Home City': 'troop a:1' } });
  const r = await runIn('loadgoals "Home City"\nloadgoals 5\nif $error echo "ERR " + $error', { GL });
  assert.deepStrictEqual(GL.calls.map((c) => c[3]), ['Home City', '5']);
  assert.match(r.text, /-> ok — running the goals of Home City in place of the saved goals/);
  assert.deepStrictEqual(printed(r, 'ERR'), ['goal set 5 is empty — write it in the console\'s goal editor (Goal set 5)']);
});
t('a loaded set with lines the goals cannot read says where', async () => {
  const GL = fakeLayers({ sets: { 2: 'config npc:5\nconfig foo:1' } });
  const r = await runIn('loadgoals 2\nif $error echo "ERR " + $error', { GL });
  assert.deepStrictEqual(printed(r, 'ERR'), ['goal set 2 line 2: CONFIG: unknown config key "foo"']);
  assert.match(r.text, /-> loaded, with lines the goals cannot use — running goal set 2 in place/);
});
t('resetgoals resets (it does not clear back to the saved goals)', async () => {
  const r = await runIn('resetgoals\necho "base " + $result.base\nconfig npc:5\necho $result');
  assert.deepStrictEqual(r.GL.calls.map((c) => c[0]), ['resetScriptGoals', 'addScriptLine']);
  assert.match(r.text, /base reset/);
  assert.match(r.text, /\n {2}goals reset: only the 1 script goal line set since run$/m);
});
t('goal $result: every goal line of a text, one at a time, comments and blanks left out', async () => {
  const text = 'config comfort:1\n\n// config trade:1\n# a note\nbuild c:1\n   troop a:1   \n';
  const r = await runIn('goal $t', { globals: { $t: text } });
  assert.deepStrictEqual(adds(r.GL), ['config comfort:1', 'build c:1', 'troop a:1']);
  assert.match(r.text, /\n {2}\+ config comfort:1\n {2}\+ build c:1\n {2}\+ troop a:1\n {2}-> ok — 3 script goal lines/);
});
t('goal of a list: one line per item; of an empty text: nothing, and no error', async () => {
  let r = await runIn('g = ["config npc:5", "troop a:1"]\ngoal g');
  assert.deepStrictEqual(adds(r.GL), ['config npc:5', 'troop a:1']);
  r = await runIn('t = "// only a comment"\ngoal t\nif !$error echo "OK"');
  assert.deepStrictEqual(r.GL.calls, []);
  assert.match(r.text, /nothing to set — no goal lines in it\n.*\n {2}OK/);
});
t('goal of something undefined fails, and the script goes on', async () => {
  const r = await runIn('goal nothingHere\nif $error echo "ERR " + $error\necho "after"');
  assert.deepStrictEqual(r.GL.calls, []);
  assert.match(printed(r, 'ERR')[0], /goal nothingHere: that is undefined, so there are no goal lines in it/);
  assert.match(r.text, /\n {2}after$/);
});
t('one bad line among many: the rest still go in, $error names it', async () => {
  const r = await runIn('goal $t\nif $error echo "ERR " + $error', { globals: { $t: 'config npc:5\nfoo bar\ntroop a:1' } });
  assert.deepStrictEqual(adds(r.GL), ['config npc:5', 'foo bar', 'troop a:1']);
  assert.match(r.text, /\n {2}\+ foo bar\n {4}FAILED - unknown goal "foo" \(not added\)\n/);
  assert.deepStrictEqual(printed(r, 'ERR'), ['"foo bar": unknown goal "foo" (not added)']);
  assert.match(r.text, /\n {2}2 script goal lines on top of the saved goals\n/);
});
t('a full layer stops the lines after it', async () => {
  const GL = fakeLayers({ addScriptLine: (a, c, line, calls) => (calls.length === 2 ? { errors: [], lines: [], error: 'the script goal layer holds 1000 lines at most' } : undefined) });
  const r = await runIn('goal $t\nif $error echo "ERR " + $error', { GL, globals: { $t: 'config npc:5\ntroop a:1\nbuild c:1' } });
  assert.deepStrictEqual(adds(GL), ['config npc:5', 'troop a:1']);
  assert.deepStrictEqual(printed(r, 'ERR'), ['"troop a:1": the script goal layer holds 1000 lines at most']);
});
t('more lines than the layer holds: refused before any goes in', async () => {
  const GL = fakeLayers({ max: 2 });
  const r = await runIn('goal $t\nif $error echo "ERR " + $error', { GL, globals: { $t: 'config npc:5\ntroop a:1\nbuild c:1' } });
  assert.deepStrictEqual(GL.calls, []);
  assert.deepStrictEqual(printed(r, 'ERR'), ['3 goal lines — the script goal layer holds 2 at most']);
});
t('{expr}, %vars%, execute and if reach goal lines too', async () => {
  const r = await runIn([
    'n = 7', 'troop a:{n}', 'lvl = 5', 'config npc:{lvl}', 'set h 3', 'config hero:%h%', 'goal "config buildnpc:" + lvl',
    'execute "config comfort:" + 1', 'if n == 7 fortification ab:{n}', 'if n == 8 troop a:1',
  ].join('\n'));
  assert.deepStrictEqual(adds(r.GL), ['troop a:7', 'config npc:5', 'config hero:3', 'config buildnpc:5', 'config comfort:1', 'fortification ab:7']);
});
t('repeat runs a goal line again', async () => {
  const r = await runIn('config npc:5\nrepeat 2');
  assert.deepStrictEqual(adds(r.GL), ['config npc:5', 'config npc:5']);
});
t('a goal layer that throws: FAILED, $error, the script goes on', async () => {
  const GL = fakeLayers({ addScriptLine: () => { throw new Error('boom'); } });
  const r = await runIn('config npc:5\nif $error echo "ERR " + $error\necho "after"', { GL });
  assert.deepStrictEqual(printed(r, 'ERR'), ['boom']);
  assert.match(r.text, /\n {2}after$/);
});

section('dry run');

t('a dry run says what it would set and touches no goal', async () => {
  const r = await runIn('config npc:5\ngoal $t\nloadgoals 1\nloadgoals 0\nresetgoals\nbuildinggoals c:10:9', { dryRun: true, globals: { $t: 'troop a:1\nbuild c:1' } });
  assert.deepStrictEqual(r.GL.calls, []);
  assert.match(r.text, /line 1: config npc:5\n {2}\[dry run\] would add to this city's script goals: config npc:5\n {2}\[dry run\] not set/);
  assert.match(r.text, /would add to this city's script goals: troop a:1\n {2}\[dry run\] would add to this city's script goals: build c:1/);
  assert.match(r.text, /\[dry run\] would load goal set 1 in place of this city's goals/);
  assert.match(r.text, /\[dry run\] would end this city's script goals/);
  assert.match(r.text, /\[dry run\] would stop every goal in this city/);
  assert.match(r.text, /would add to this city's script goals: build c:10:9/);
  assert.strictEqual(r.done, 0);
});

section('without the goals update');

const MISSING = /goal lines in scripts need the goals update \(goals\/integration\)/;
t('every goal command fails clearly, sets $error, and the script goes on', async () => {
  const src = ['config npc:5', 'if $error echo "E1 " + $error', 'troop a:1', 'if $error echo "E2 " + $error', 'loadgoals 1',
    'if $error echo "E3 " + $error', 'resetgoals', 'if $error echo "E4 " + $error', 'goal $t', 'if $error echo "E5 " + $error', 'echo "still here"'].join('\n');
  const r = await runIn(src, { GL: false, globals: { $t: 'config npc:5' } });
  for (const tag of ['E1', 'E2', 'E3', 'E4', 'E5']) assert.match(printed(r, tag)[0] || '', MISSING, `${tag}\n${r.text}`);
  assert.match(r.text, /line 1: config npc:5\n {2}FAILED: goal lines in scripts need the goals update/);
  assert.match(r.text, /\n {2}still here$/);
});
t('and in a dry run too (it could not run for real)', async () => {
  const r = await runIn('config npc:5\nif $error echo "ERR " + $error', { GL: false, dryRun: true });
  assert.match(printed(r, 'ERR')[0], MISSING);
});
t('with no goallayers.js on this branch, the lazy require gives the same message', async () => {
  if (fs.existsSync(path.join(__dirname, 'goallayers.js'))) return;    // the goals update is in: nothing to check
  const r = await runIn('config npc:5\nif $error echo "ERR " + $error', { goalLayers: undefined });
  assert.match(printed(r, 'ERR')[0], MISSING);
});
t('a goal layer without the function a command needs says which', async () => {
  const r = await runIn('loadgoals 1\nif $error echo "ERR " + $error', { GL: { addScriptLine() {} } });
  assert.match(printed(r, 'ERR')[0], /need the goals update \(goals\/integration\) — this goallayers.js has no loadScriptGoals\(\)/);
});

section('NewCityScript, end to end');

// wiki NewCityScript: NEAT's default !NewCityScript.txt, word for word
const NEW_CITY_SCRIPT = [
  '// DO NOT DELETE!',
  '// This script is called for any new city that was built or captured',
  '',
  '// If there is only town hall, try to build 1 cottage',
  '// to make sure city is not abandoned on restart',
  'if city.buildings.length < 2 create cottage',
  '',
  '// Set some temporary goals',
  '@get "NewCityGoals.txt"',
  'if $error == null goal $result',
].join('\n');
// wiki NewCityGoals: NEAT's default !NewCityGoals.txt
const NEW_CITY_GOALS = 'config comfort:1,gate:1\n\n// config trade:1\n\nbuild c:1\n\ntroop a:1,warr:1,wo:1,p:1,sw:1,cav:1,cata:1,ram:1,cp:1,s:1\n\nfortification trap:10,ab:10,at:1,r:10,rock:10\n';

t('a city with a cottage: no create; the template\'s goal lines go into its layer', async () => {
  const calls = [];
  const r = await runIn(NEW_CITY_SCRIPT, { modules: [helpers(calls)], session: sessionWith({ default: NEW_CITY_GOALS }) });
  assert.deepStrictEqual(calls, ['get NewCityGoals.txt']);
  assert.deepStrictEqual(r.GL.calls.map((c) => c.slice(0, 3)), Array(4).fill(['addScriptLine', 7, 1]));
  assert.deepStrictEqual(adds(r.GL), ['config comfort:1,gate:1', 'build c:1', 'troop a:1,warr:1,wo:1,p:1,sw:1,cav:1,cata:1,ram:1,cp:1,s:1',
    'fortification trap:10,ab:10,at:1,r:10,rock:10']);
});
t('a city with only its town hall: create cottage first', async () => {
  const calls = [];
  const r = await runIn(NEW_CITY_SCRIPT, { castle: 'New', modules: [helpers(calls)], session: sessionWith({ default: 'config npc:5' }) });
  assert.deepStrictEqual(calls, ['create cottage', 'get NewCityGoals.txt']);
  assert.deepStrictEqual(r.GL.calls, [['addScriptLine', 7, 3, 'config npc:5']]);
});
t('through the real get (script-cmd-info.js), with only create stood in', async () => {
  const calls = [];
  const create = { commands: { create: helpers(calls).commands.create } };
  const r = await runIn(NEW_CITY_SCRIPT, { modules: [create], session: sessionWith({ default: NEW_CITY_GOALS }) });
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(adds(r.GL), ['config comfort:1,gate:1', 'build c:1', 'troop a:1,warr:1,wo:1,p:1,sw:1,cav:1,cata:1,ram:1,cp:1,s:1',
    'fortification trap:10,ab:10,at:1,r:10,rock:10'], r.text);
});
t('an account with no template: get finds an empty file and nothing is set', async () => {
  const calls = [];
  const r = await runIn(NEW_CITY_SCRIPT, { modules: [helpers(calls)], session: sessionWith({}) });
  assert.deepStrictEqual(r.GL.calls, []);
  assert.match(r.text, /nothing to set — no goal lines in it/);
});

section('goalFile (what get reads for NEAT\'s goal files)');

t('NewCityGoals.txt is the account\'s new-city template; other names are not goal files', () => {
  const env = { session: sessionWith({ default: 'config npc:5' }), opts: { goalLayers: false } };
  for (const n of ['NewCityGoals.txt', 'newcitygoals.TXT', '!NewCityGoals.txt', 'NewCityGoals', 'C:\\bot\\NewCityGoals.txt']) assert.strictEqual(goalsCmd.goalFile(n, env), 'config npc:5', n);
  assert.strictEqual(goalsCmd.goalFile('PrependGoals.txt', env), '', 'no prepend goals before the goals update');
  assert.strictEqual(goalsCmd.goalFile('AppendGoals.txt', env), '');
  assert.strictEqual(goalsCmd.goalFile('farm.txt', env), null);
  assert.strictEqual(goalsCmd.goalFile('NewCityGoals.txt', { session: sessionWith({}), opts: { goalLayers: false } }), '');
});
t('with the goals update it reads the account-wide texts through goallayers.readText', () => {
  const seen = [];
  const GL = { readText: (api, acct, which) => { seen.push([acct, which]); return which === 'append' ? { src: 'troop a:1', exists: true } : { src: 'x', exists: false, suggested: 'y' }; } };
  const env = { session: { account: { id: 7 }, org: { goals: { exact() {}, find() {} } } }, opts: { goalLayers: GL } };
  assert.strictEqual(goalsCmd.goalFile('AppendGoals.txt', env), 'troop a:1');
  assert.strictEqual(goalsCmd.goalFile('PrependGoals.txt', env), '', 'no row: nothing, not the suggestion');
  assert.deepStrictEqual(seen, [[7, 'append'], [7, 'prepend']]);
});

// ---------------------------------------------------------------------------
(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n + '\n'); continue; }
    try { await f(); console.log('  ok    ' + n); pass++; }
    catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message.split('\n').join('\n        ')); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
