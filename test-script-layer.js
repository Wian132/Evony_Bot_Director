'use strict';
// The script goal layer: goal lines a script runs (NEAT's `config npc:5`,
// `goal <line>`, `loadgoals [n]`, `resetgoals`; wiki Goal, Config, LoadGoals,
// ResetGoals) change the goals a city is RUNNING, in memory, never the saved ones.
//
//   * the layer runs after prepend + city + append: a script's config key or
//     one-per-city goal wins, its troop/build/fortification lines stack last
//   * loadgoals N runs goal set N in place of all of them; loadgoals / loadgoals 0
//     goes back to the saved goals; resetgoals leaves nothing running
//   * errors say "script line N"; the engine's plan says a layer is active
//   * a restart (a fresh module) has no layer; the console's views see it
// Offline: a temp database, a fake game, no socket.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-scriptlayer-')), 't.db');

const D = require('./db');
const C = require('./constants');
const GL = require('./goallayers');
const { parseGoals } = require('./goals');
const { Engine } = require('./engine');
const { Session } = require('./session');

let pass = 0, fail = 0;
const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const has = (s, sub) => assert.ok(String(s).includes(sub), `"${s}" does not contain "${sub}"`);
const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);

const ORG = D.orgs.create('Acme Raiders');
const a = D.org(ORG.id);
let seq = 0;
const acct = () => a.accounts.upsert({ label: `A${++seq}`, email: `a${seq}@x.com`, password: 'x' }).id;

const castle = (id, name, x = 300, y = 300, over = {}) => ({
  id, name, fieldId: C.coordsToFieldId(x, y),
  resource: { food: { amount: 1e6 }, wood: { amount: 1e6 }, stone: { amount: 1e6 }, iron: { amount: 1e6 }, gold: 1e6,
    curPopulation: 100, maxPopulation: 1000 },
  buildings: [], heros: [], troop: {}, fortification: {}, ...over,
});
const fakeGame = (castles) => ({
  castles, player: { playerInfo: { userName: 'T' }, selfArmys: [], enemyArmys: [], items: [] },
  castleId: (c) => c.castleId ?? c.id, castleXY: (c) => C.fieldIdToCoords(c.fieldId),
  castle: () => castles[0], now: () => Date.now(), req: async () => ({ ok: 1 }),
});
const running = (id, cid, name = 'X') => GL.runningGoals(D.goals, id, cid, name);
const raws = (p) => (p ? p.goals.map((g) => `${g.source}:${g.raw}`) : null);

// ---------------------------------------------------------------------------
section('setting, adding, reading and clearing a city\'s script layer');

t('setScriptLayer replaces the layer and answers parseGoals-style', () => {
  const id = acct();
  let r = GL.setScriptLayer(id, 11, 'config npc:5\n// a comment\n\ntroop a:1k');
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.lines.map((l) => l.status), ['ok', 'comment', 'blank', 'ok']);
  let L = GL.getScriptLayer(id, 11);
  assert.strictEqual(L.src, 'config npc:5\ntroop a:1k', 'comments and blank lines are not kept');
  assert.strictEqual(L.base, 'saved');
  assert.strictEqual(L.count, 2);
  assert.ok(Math.abs(L.setAt - Date.now()) < 5000);
  r = GL.setScriptLayer(id, 11, 'troop s:5');
  assert.strictEqual(GL.getScriptLayer(id, 11).src, 'troop s:5', 'set did not replace');
});

t('addScriptLine appends one line, or the lines of a multi-line `goal $result`', () => {
  const id = acct();
  GL.addScriptLine(id, 12, 'troop a:1k');
  GL.addScriptLine(id, 12, 'build c:1\r\nfortification ab:10');
  assert.strictEqual(GL.getScriptLayer(id, 12).src, 'troop a:1k\nbuild c:1\nfortification ab:10');
  const r = GL.addScriptLine(id, 12, '   ');
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(GL.getScriptLayer(id, 12).count, 3, 'a blank line was added');
});

t('errors keep their line in the text given and say "script line N" in the layer', () => {
  const id = acct();
  GL.addScriptLine(id, 13, 'troop a:1k');
  GL.addScriptLine(id, 13, 'config npc:5');
  const r = GL.addScriptLine(id, 13, 'troop zz:5');
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(r.errors[0].line, 1);
  assert.strictEqual(r.errors[0].where, 'script line 3');
  assert.strictEqual(r.errors[0].source, 'script');
  has(r.errors[0].error, 'unknown troop code "zz"');
  const s = GL.setScriptLayer(id, 13, 'config npc:1\ntroop qq:1');
  assert.deepStrictEqual(s.errors.map((e) => `${e.where}: ${e.error}`), ['script line 2: TROOP: unknown troop code "qq"']);
});

t('a line that sets nothing (not a goal, or config with no good pair) is reported and left out', () => {
  const id = acct();
  GL.addScriptLine(id, 10, 'config npc:1');
  let r = GL.addScriptLine(id, 10, 'bogus 2');
  assert.deepStrictEqual(r.errors.map((e) => `${e.where}: ${e.error}`), ['script, not added: unknown goal "bogus"']);
  r = GL.addScriptLine(id, 10, 'config nokey');
  assert.strictEqual(r.errors[0].where, 'script, not added');
  r = GL.addScriptLine(id, 10, 'config comfort:1,nokey');
  assert.strictEqual(r.errors[0].where, 'script line 2', 'a line with one good key is kept');
  assert.strictEqual(GL.getScriptLayer(id, 10).src, 'config npc:1\nconfig comfort:1,nokey');
});

t('the layer belongs to one account and one city', () => {
  const id = acct(), other = acct();
  GL.setScriptLayer(id, 14, 'config npc:5');
  assert.strictEqual(GL.getScriptLayer(id, 15), null);
  assert.strictEqual(GL.getScriptLayer(other, 14), null);
  assert.strictEqual(GL.getScriptLayer(id, '14').src, 'config npc:5', 'a castle id as text is the same city');
});

t('clearScriptLayer drops it and says whether there was one', () => {
  const id = acct();
  GL.setScriptLayer(id, 16, 'config npc:5');
  assert.strictEqual(GL.clearScriptLayer(id, 16), true);
  assert.strictEqual(GL.getScriptLayer(id, 16), null);
  assert.strictEqual(GL.clearScriptLayer(id, 16), false);
});

t('a restart has no layer: it lives in the console\'s memory only', () => {
  const id = acct();
  GL.setScriptLayer(id, 17, 'config npc:5');
  const key = require.resolve('./goallayers'), loaded = require.cache[key];
  delete require.cache[key];
  const fresh = require('./goallayers');           // what a restarted console loads
  require.cache[key] = loaded;                      // the rest of these tests keep this one
  assert.strictEqual(fresh.getScriptLayer(id, 17), null);
  assert.ok(!D.goals.list('goal').some((r) => r.src.includes('npc:5')), 'the layer was written to the database');
  assert.strictEqual(GL.getScriptLayer(id, 17).src, 'config npc:5');
});

t('a key set again drops out of the earlier config line; a loop does not grow the layer', () => {
  const id = acct();
  GL.addScriptLine(id, 18, 'config npc:5,comfort:1');
  for (let i = 0; i < 50; i++) { GL.addScriptLine(id, 18, 'config npc:0'); GL.addScriptLine(id, 18, 'config npc:5'); }
  assert.strictEqual(GL.getScriptLayer(id, 18).src, 'config comfort:1\nconfig npc:5');
  GL.addScriptLine(id, 18, 'comfortpolicy 10 20 popraise');
  GL.addScriptLine(id, 18, 'comfortpolicy 15 16 popraise');
  assert.strictEqual(GL.getScriptLayer(id, 18).src, 'config comfort:1\nconfig npc:5\ncomfortpolicy 15 16 popraise');
  GL.addScriptLine(id, 18, 'troop a:1');
  GL.addScriptLine(id, 18, 'troop a:1');
  assert.strictEqual(GL.getScriptLayer(id, 18).count, 4, 'the same line twice running was kept twice');
});

t('a bare war setting (hiding 2, read as config) is compacted like a config line', () => {
  const id = acct();
  for (let i = 0; i < 20; i++) { GL.addScriptLine(id, 9, 'hiding 2'); GL.addScriptLine(id, 9, 'hiding 0'); }
  assert.strictEqual(GL.getScriptLayer(id, 9).src, 'hiding 0');
  GL.addScriptLine(id, 9, 'config hiding:1,npc:5');
  assert.strictEqual(GL.getScriptLayer(id, 9).src, 'config hiding:1,npc:5');
  assert.deepStrictEqual(running(id, 9).config, { hiding: 1, npc: 5 });
});

t('script lines get the same per-line standing as a city\'s goals (the editor\'s colours)', () => {
  const id = acct();
  // Step 14 built config trade and Step 20 config valley, and once every step
  // is in no config key is left doing nothing: so valley is put on the
  // NOT_IMPLEMENTED table for this test and taken off again
  const { NOT_IMPLEMENTED } = require('./goals');
  const had = NOT_IMPLEMENTED.config.valley;
  NOT_IMPLEMENTED.config.valley = 'a reason put here by this test only';
  try {
    const text = '// from a script\nconfig valley:1,npc:5\nhiding 2\ntroop zz:1\nbogus 3\n\ntroop a:1k';
    const r = GL.addScriptLine(id, 8, text);
    assert.deepStrictEqual(r.lines, parseGoals(text).lines, 'the answer differs from what /api/goals gives this text');
    assert.deepStrictEqual(r.lines.map((l) => l.status), ['comment', 'idle', 'ok', 'error', 'error', 'blank', 'ok']);
    has(r.lines[1].msg, 'valley does nothing yet');
    has(r.lines[2].msg, 'read as "config hiding:2"');
    assert.deepStrictEqual(GL.setScriptLayer(id, 8, text).lines, parseGoals(text).lines);
    D.goals.set(id, 'set4', 'goal', text);
    assert.deepStrictEqual(GL.loadScriptGoals(id, 8, 4).lines, parseGoals(text).lines);
  } finally {
    if (had === undefined) delete NOT_IMPLEMENTED.config.valley; else NOT_IMPLEMENTED.config.valley = had;
  }
});

t('the layer holds 1000 lines at most', () => {
  const id = acct();
  GL.setScriptLayer(id, 19, Array.from({ length: GL.SCRIPT_MAX_LINES }, (_, i) => `troop a:${i + 1}`).join('\n'));
  const r = GL.addScriptLine(id, 19, 'troop s:1');
  has(r.error, '1000 lines at most');
  assert.strictEqual(GL.getScriptLayer(id, 19).count, GL.SCRIPT_MAX_LINES);
});

// ---------------------------------------------------------------------------
section('the running goals: prepend, the city, append, then the script');

t('a script\'s lines run last: config keys and singletons win, troop lines stack after', () => {
  const id = acct();
  D.goals.set(id, 'prepend', 'goal', 'config comfort:1\ntroop w:1');
  D.goals.set(id, '21', 'goal', 'config npc:5,hero:1\ncomfortpolicy 15 16 popraise\ntroop p:2');
  D.goals.set(id, 'append', 'goal', 'troop s:3');
  GL.setScriptLayer(id, 21, 'config npc:0\ncomfortpolicy 30 40 popraise\ntroop a:4');
  const p = running(id, 21);
  assert.deepStrictEqual(p.config, { comfort: 1, npc: 0, hero: 1 }, 'the script\'s npc:0 did not win');
  assert.deepStrictEqual(raws(p), ['city:troop p:2', 'prepend:troop w:1', 'append:troop s:3',
    'script:comfortpolicy 30 40 popraise', 'script:troop a:4']);
  assert.deepStrictEqual(p.errors, [], 'overriding a saved line is not an error');
});

t('when the layer is cleared the saved goals win again', () => {
  const id = acct();
  D.goals.set(id, '22', 'goal', 'config npc:5');
  GL.addScriptLine(id, 22, 'config npc:0');
  assert.strictEqual(running(id, 22).config.npc, 0);
  GL.clearScriptLayer(id, 22);
  assert.strictEqual(running(id, 22).config.npc, 5);
});

t('a script can give goals to a city that has none', () => {
  const id = acct();
  assert.strictEqual(running(id, 23), null);
  GL.addScriptLine(id, 23, 'troop a:10');
  assert.deepStrictEqual(raws(running(id, 23)), ['script:troop a:10']);
});

t('a broken script line is reported where it stands, "script line N"', () => {
  const id = acct();
  D.goals.set(id, '24', 'goal', 'troop w:1');
  GL.setScriptLayer(id, 24, 'config npc:0\ntroop qq:1');
  const p = running(id, 24);
  assert.deepStrictEqual(p.errors.map((e) => e.where), ['script line 2']);
  const note = GL.scriptNote(GL.getScriptLayer(id, 24), p);
  has(note, 'script layer active (2 lines, set by a script at');
  has(note, '1 line(s) not understood — script line 2: TROOP: unknown troop code "qq"');
});

// ---------------------------------------------------------------------------
section('loadgoals and resetgoals');

t('loadgoals N runs goal set N in place of the saved and global goals; later lines stack on it', () => {
  const id = acct();
  D.goals.set(id, 'prepend', 'goal', 'troop w:1');
  D.goals.set(id, '31', 'goal', 'config npc:5\ntroop p:2');
  D.goals.set(id, 'append', 'goal', 'config npc:5');
  D.goals.set(id, 'set1', 'goal', '// treb mode\nconfig npc:0\nfortification ab:100');
  const r = GL.loadScriptGoals(id, 31, 1);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.loaded, 'goal set 1');
  assert.deepStrictEqual(r.lines.map((l) => l.status), ['comment', 'ok', 'ok']);
  let p = running(id, 31);
  assert.deepStrictEqual(p.config, { npc: 0 }, 'the append\'s npc:5 still ran');
  assert.deepStrictEqual(raws(p), ['loaded:fortification ab:100']);
  GL.addScriptLine(id, 31, 'troop a:9');
  p = running(id, 31);
  assert.deepStrictEqual(raws(p), ['loaded:fortification ab:100', 'script:troop a:9']);
  const L = GL.getScriptLayer(id, 31);
  assert.strictEqual(L.base, 'loaded');
  has(GL.scriptNote(L), `script layer active: goal set 1 loaded by a script at ${hhmm(L.setAt)}, 1 line added`);
});

t('the set is copied when it is loaded, as NEAT reads it into memory', () => {
  const id = acct();
  D.goals.set(id, 'set2', 'goal', 'config npc:0');
  GL.loadScriptGoals(id, 32, '2');
  D.goals.set(id, 'set2', 'goal', 'config npc:9');
  assert.strictEqual(running(id, 32).config.npc, 0);
});

t('bare loadgoals, or loadgoals 0, goes back to the saved goals', () => {
  const id = acct();
  D.goals.set(id, '33', 'goal', 'config npc:5');
  D.goals.set(id, 'set1', 'goal', 'config npc:0');
  GL.loadScriptGoals(id, 33, 1);
  assert.strictEqual(running(id, 33).config.npc, 0);
  let r = GL.loadScriptGoals(id, 33);
  assert.strictEqual(r.cleared, true);
  assert.strictEqual(GL.getScriptLayer(id, 33), null);
  GL.addScriptLine(id, 33, 'config npc:1');
  r = GL.loadScriptGoals(id, 33, 0);
  assert.strictEqual(r.cleared, true);
  assert.strictEqual(running(id, 33).config.npc, 5);
});

t('an empty goal set is an error and the layer is left as it was', () => {
  const id = acct();
  GL.addScriptLine(id, 34, 'config npc:3');
  const r = GL.loadScriptGoals(id, 34, 7);
  has(r.error, 'goal set 7 is empty');
  assert.strictEqual(GL.getScriptLayer(id, 34).src, 'config npc:3');
});

t('loadgoals <city> runs another city\'s saved goals here, by name or castle id', () => {
  const id = acct();
  D.registry.reconcile(id, [{ fieldId: 5001, castleId: 351, name: 'Hub' }, { fieldId: 5002, castleId: 352, name: 'Farm' }]);
  D.goals.set(id, '351', 'goal', 'config npc:10\ntroop b:5k');
  let r = GL.loadScriptGoals(id, 352, 'hub');
  assert.strictEqual(r.loaded, 'the goals of Hub');
  assert.deepStrictEqual(raws(running(id, 352)), ['loaded:troop b:5k']);
  r = GL.loadScriptGoals(id, 352, '351');
  assert.strictEqual(r.loaded, 'the goals of city 351');
  has(GL.loadScriptGoals(id, 352, 'Nowhere').error, 'not a goal set (1 to 9) nor one of this account\'s cities');
  has(GL.loadScriptGoals(id, 351, 'Farm').error, 'Farm has no saved goals to load');
});

t('resetgoals: nothing runs until the script sets goals again', async () => {
  const id = acct();
  D.goals.set(id, 'prepend', 'goal', 'troop w:1');
  D.goals.set(id, '36', 'goal', 'config npc:5\ntroop p:2');
  GL.resetScriptGoals(id, 36);
  assert.strictEqual(running(id, 36), null, 'the saved goals still ran after resetgoals');
  const g = fakeGame([castle(36, 'Reset')]);
  const e = new Engine(g, () => {}, id);
  e.dryRun = true;
  const r = await e.focus(g.castles[0]);
  assert.match(r.note, /^no goals set — script layer active: goals reset by a script at \d\d:\d\d, nothing set since$/);
  GL.addScriptLine(id, 36, 'config npc:1');
  assert.deepStrictEqual(running(id, 36).config, { npc: 1 });
  has(GL.scriptNote(GL.getScriptLayer(id, 36)), 'goals reset by a script at');
  has(GL.scriptNote(GL.getScriptLayer(id, 36)), '1 line set since');
});

t('setScriptLayer after a reset or a load starts over on the saved goals', () => {
  const id = acct();
  D.goals.set(id, '37', 'goal', 'troop p:2');
  GL.resetScriptGoals(id, 37);
  GL.setScriptLayer(id, 37, 'troop a:1');
  assert.deepStrictEqual(raws(running(id, 37)), ['city:troop p:2', 'script:troop a:1']);
});

// ---------------------------------------------------------------------------
section('the engine and the console see it');

t('the engine plans with the layer and its plan says the layer is active', async () => {
  const id = acct();
  D.goals.set(id, '41', 'goal', 'config hero:0,npc:5');
  const g = fakeGame([castle(41, 'Engine')]);
  const e = new Engine(g, () => {}, id);
  e.dryRun = true;
  let r = await e.focus(g.castles[0]);
  assert.strictEqual(r.script, undefined, 'a plan note with no layer');
  GL.setScriptLayer(id, 41, 'config npc:0\nbuild c:1');
  assert.strictEqual(e.goalsFor(41, 'Engine').config.npc, 0);
  r = await e.focus(g.castles[0]);
  const L = GL.getScriptLayer(id, 41);
  assert.strictEqual(r.script.note, `script layer active (2 lines, set by a script at ${hhmm(L.setAt)})`);
  assert.ok(r.build, 'the script\'s build line was not planned');
});

t('the war-only pass reads the layer too', async () => {
  const id = acct();
  D.goals.set(id, '42', 'goal', 'config hero:0');
  const g = fakeGame([castle(42, 'War', 300, 300), castle(43, 'Refuge', 320, 300)]);
  const e = new Engine(g, () => {}, id);
  e.dryRun = true;
  GL.addScriptLine(id, 42, 'config hiding:2');
  await e.tick({ urgent: true });
  assert.strictEqual(e.goalsSeen[42] && e.goalsSeen[42].config.hiding, 2, 'the war pass did not see the script\'s hiding:2');
});

t('the console\'s views and city list see it', () => {
  const id = acct();
  const s = new Session(id);
  s.note = () => {};
  const c = castle(44, 'Viewed', 300, 300, { buildings: [{ typeId: C.TOWN_HALL, positionId: -1, level: 5, status: 0 }] });
  s.game = fakeGame([c]);
  D.goals.set(id, '44', 'goal', 'config hero:0');
  assert.strictEqual(s.cities()[0].script, null);
  GL.setScriptLayer(id, 44, 'troop a:500\nbuild c:1');
  const L = s.cities()[0].script;
  assert.deepStrictEqual({ count: L.count, base: L.base, loaded: L.loaded }, { count: 2, base: 'saved', loaded: null });
  const stage = s.activeTroopStage(c);
  assert.ok(stage && stage.targets, 'the troop stage view did not see the script\'s troop line');
  const o = s.buildOutlook(c);
  assert.ok(o && o.next && /Cottage/.test(o.next), `the build outlook did not see the script's build line: ${JSON.stringify(o)}`);
});

// ---------------------------------------------------------------------------
section('goal sets in the console');

t('goal sets 1 to 9 are account texts the editor reads and saves', () => {
  const id = acct();
  const r = GL.saveText(a.goals, id, { which: 'set3', src: 'config npc:0\nbogus', save: true });
  assert.deepStrictEqual(r.errors.map((e) => e.where), ['goal set 3 line 2']);
  has(r.note, 'loadgoals 3');
  assert.strictEqual(GL.readText(a.goals, id, 'set3').src, 'config npc:0\nbogus');
  assert.throws(() => GL.readText(a.goals, id, 'set10'), /set1 to set9/);
});

t('a city called "set1" is not seeded from goal set 1', () => {
  const id = acct();
  D.goals.set(id, 'set1', 'goal', 'troop b:1');
  assert.strictEqual(D.goals.own(id, 51, 'set1'), null);
});

t('with no layer the running goals are the saved ones, unchanged', () => {
  const id = acct();
  D.goals.set(id, '52', 'goal', 'config npc:5\ntroop a:1k\ncomfortpolicy 15 16 popraise');
  const plain = parseGoals('config npc:5\ntroop a:1k\ncomfortpolicy 15 16 popraise');
  const p = running(id, 52);
  assert.deepStrictEqual(p.config, plain.config);
  assert.deepStrictEqual(p.goals.map(({ source, ...x }) => x), plain.goals);
});

// ---------------------------------------------------------------------------

(async () => {
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n + '\n'); continue; }
    try { await f(); console.log('  ok    ' + n); pass++; }
    catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(path.dirname(process.env.EVONY_DB), { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
