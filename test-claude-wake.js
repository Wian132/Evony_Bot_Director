'use strict';
// The junk rule in the warnings (attacks.js, session.js underAttackView and
// cities()) and the Claude waker (claude-wake.js), offline. Nothing logs in and
// no claude is run: the launcher is a fake that records what it was given.
//   EVONY_DB=/tmp/x.db node test-claude-wake.js
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

if (!process.env.EVONY_DB) process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-wake-')), 't.db');
if (path.resolve(process.env.EVONY_DB) === path.resolve(__dirname, 'evony.db')) throw new Error('refusing to run on the live evony.db');

const C = require('./constants');
const D = require('./db');
const A = require('./attacks');
const P = require('./claude-perms');
const WK = require('./claude-wake');
const { parseGoals } = require('./goals');
const { Session } = require('./session');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok    ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}
const section = (s) => console.log(`\n--- ${s} ---`);
// checks that need the event loop to have run (the real launcher's children)
const pending = [];

// ------------------------------------------------------------ fixtures
const NOW0 = 1789000000000;
let clock = NOW0;
const XY = { home: { x: 200, y: 300 }, fort: { x: 210, y: 305 } };
const city = (id, name, xy) => ({ id, name, fieldId: C.coordsToFieldId(xy.x, xy.y), hasEnemy: false, goOutForBattle: false,
  resource: { support: 88, food: { amount: 1e6, increaseRate: 1000 }, troopCostFood: 0 } });
let seq = 5000;
// an ArmyBean as the server sends it: counts are strings, "?" when unscouted
const army = (to, troop, { inMs = 300000, king = 'Raider', alliance = 'Foes', armyId } = {}) => ({
  armyId: armyId ?? seq++, missionType: C.MISSION.attack, direction: 1, king, alliance, hero: 'Brute',
  startPosName: 'Raider City', startFieldId: C.coordsToFieldId(150, 250), targetFieldId: to.fieldId,
  startTime: clock - 600000, reachTime: clock + inMs, troop,
});

// A Session over a stand-in game, each city's goals given as text.
function sessionOver(cities, armies, goalsByName = {}) {
  const s = new Session();
  s.note = () => {};
  s.game = {
    castles: cities, now: () => clock,
    castleId: (c) => c.id, castleXY: (c) => C.fieldIdToCoords(c.fieldId),
    player: { playerInfo: {}, enemyArmys: armies, selfArmys: [] },
  };
  s.engine = null;
  Object.defineProperty(s, 'connected', { value: true, configurable: true });
  s.goalsOf = (c) => (goalsByName[c.name] !== undefined ? parseGoals(goalsByName[c.name]) : { goals: [], config: {} });
  s.trainingHeroes = () => new Map();
  s.controls = () => ({ gate: 'auto', wartown: 'auto' });
  s.scriptLayer = () => null;
  return s;
}

// ================================================================ junk rule
section('attacks.js: one rule, per army');
t('the line is /junktroop, 1000 when unset, 0 kept as 0', () => {
  assert.strictEqual(A.junkLineOf(parseGoals('defensepolicy /junktroop:5000').goals), 5000);
  assert.strictEqual(A.junkLineOf(parseGoals('defensepolicy /usetruce:79').goals), 1000);
  assert.strictEqual(A.junkLineOf(parseGoals('defensepolicy /junktroop:0').goals), 0);
  assert.strictEqual(A.junkLineOf([]), 1000);
  assert.strictEqual(A.junkLineOf(null), 1000);
});
t('999 is junk and 1000 is real at the default line; unknown is real; /junktroop:0 makes 1 real', () => {
  assert.strictEqual(A.isRealAttack({ troop: { archer: '999' } }, 1000), false);
  assert.strictEqual(A.isRealAttack({ troop: { archer: '1000' } }, 1000), true);
  assert.strictEqual(A.isRealAttack({ troop: { archer: '?' } }, 1000), true);
  assert.strictEqual(A.isRealAttack({ troop: { archer: '10', pikemen: '?' } }, 1000), true, 'partly scouted counts as unknown');
  assert.strictEqual(A.isRealAttack({ troops: 10, known: false }, 1000), true, 'the engine\'s partial total');
  assert.strictEqual(A.isRealAttack({ troop: { archer: '1' } }, 0), true);
});

section('session.js: underAttackView and the city tabs follow the line');
t('999 troops against the default line: nothing at all, though the server flags the city', () => {
  const home = city(1, 'Home', XY.home);
  home.hasEnemy = true;                       // the server sets it for junk too
  const s = sessionOver([home], [army(home, { archer: '999' })]);
  const v = s.underAttackView();
  assert.deepStrictEqual(v, { on: false, at: NOW0, cities: [] });
  const c = s.cities()[0];
  assert.strictEqual(c.incoming, 0);
  assert.strictEqual(c.underAttack, false, 'c.hasEnemy alone must not light the tab');
  assert.strictEqual(c.junkIncoming, 1);
  assert.strictEqual(c.junkLine, 1000);
});
t('1000 troops: a real attack, with its key, size, attacker and landing time', () => {
  const home = city(1, 'Home', XY.home);
  const a = army(home, { archer: '600', pikemen: '400' }, { armyId: 42 });
  const s = sessionOver([home], [a]);
  const v = s.underAttackView();
  assert.strictEqual(v.on, true);
  assert.deepStrictEqual(v.cities[0].real, [{ key: '42', armyId: 42, troops: 1000, from: 'Raider City', fromFieldId: a.startFieldId,
    king: 'Raider', alliance: 'Foes', reachTime: NOW0 + 300000 }]);
  assert.strictEqual(v.cities[0].inbound, 1);
  assert.strictEqual(s.cities()[0].underAttack, true);
});
t('an unscouted army counts as real (troops null)', () => {
  const home = city(1, 'Home', XY.home);
  const s = sessionOver([home], [army(home, { archer: '?', cavalry: '?' })]);
  const v = s.underAttackView();
  assert.strictEqual(v.on, true);
  assert.strictEqual(v.cities[0].real[0].troops, null);
});
t('the line applies per attack: two armies of 600 are both junk at 1000', () => {
  const home = city(1, 'Home', XY.home);
  const s = sessionOver([home], [army(home, { archer: '600' }), army(home, { archer: '600' })]);
  assert.strictEqual(s.underAttackView().on, false);
  assert.strictEqual(s.cities()[0].junkIncoming, 2);
});
t('each city judges by its own /junktroop; /junktroop:0 makes everything count', () => {
  const home = city(1, 'Home', XY.home), fort = city(2, 'Fort', XY.fort);
  const s = sessionOver([home, fort], [army(home, { archer: '3000' }), army(fort, { archer: '5' })],
    { Home: 'defensepolicy /junktroop:5000', Fort: 'defensepolicy /junktroop:0' });
  const v = s.underAttackView();
  assert.deepStrictEqual(v.cities.map((c) => [c.name, c.inbound, c.junk, c.junkLine]), [['Fort', 1, 0, 0]]);
  const tabs = s.cities();
  assert.deepStrictEqual(tabs.map((c) => [c.name, c.underAttack, c.junkIncoming]), [['Home', false, 1], ['Fort', true, 0]]);
});
t('a junk wave landing leaves no "hit N min ago"; a real one does', () => {
  const home = city(1, 'Home', XY.home);
  const junk = army(home, { archer: '10' }, { inMs: 5000 });
  const real = army(home, { archer: '5000' }, { inMs: 6000 });
  const s = sessionOver([home], [junk, real]);
  assert.strictEqual(s.underAttackView().cities[0].inbound, 1);
  clock += 10000;
  s.game.player.enemyArmys = [];
  const v = s.underAttackView();
  assert.strictEqual(v.on, true);
  assert.strictEqual(v.cities[0].lastWaveAt, NOW0 + 6000, 'the REAL wave\'s landing');
  clock = NOW0;
  const s2 = sessionOver([home], [army(home, { archer: '10' }, { inMs: 5000 })]);
  s2.underAttackView();
  clock += 10000;
  s2.game.player.enemyArmys = [];
  assert.strictEqual(s2.underAttackView().on, false, 'a junk landing shows nothing');
  clock = NOW0;
});

// ================================================================ the waker
section('claude-wake.js');
const org = D.orgs.create('wake test ' + Date.now());
const ACC = { id: 'tw' + Date.now().toString(36), label: 'Lord02', server: 'ss71' };
D.org(org.id).accounts.upsert(ACC);
const reset = () => { D.settings.set(WK.K_SEEN, {}); D.settings.set(WK.K_LOG, []); D.settings.set(WK.K_CAP, 6); };

// finish: each run ends at once, so the one-Claude-per-account rule does not
// hold the next attack back
function fakeLaunch({ finish = false } = {}) {
  const calls = [];
  const fn = (cmd, done, timeoutMs) => {
    calls.push({ cmd, done, timeoutMs });
    if (finish) done({ code: 0, stdout: '{"result":"done"}' });
    return { pid: 4242 };
  };
  fn.calls = calls;
  return fn;
}
const makeWaker = (launch) => WK.create({ D, launch, now: () => clock, aliasOf: () => 'Lord02', env: { PATH: '', OTTO_CLAUDE_BIN: 'fake-claude', ANTHROPIC_API_KEY: 'sk-should-go', CLAUDECODE: '1', KEEP: 'me' } });
// underAttack as a console sends it, from real ArmyBeans through the real session code
function viewOf(armies, goals) {
  const home = city(1, 'Home', XY.home), fort = city(2, 'Fort', XY.fort);
  const byName = { Home: home, Fort: fort };
  const list = armies.map(([to, troop, o]) => army(byName[to], troop, o));
  return sessionOver([home, fort], list, goals || {}).underAttackView();
}

t('the global switch is off by default: a real attack wakes nobody and is not even noted', () => {
  reset();
  const L = fakeLaunch(); const w = makeWaker(L);
  assert.strictEqual(w.isOn(org.id), false);
  const did = w.observe({ orgId: org.id, account: ACC, underAttack: viewOf([['Home', { archer: '5000' }, { armyId: 1 }]]) });
  assert.deepStrictEqual(did, []);
  assert.strictEqual(L.calls.length, 0);
  assert.deepStrictEqual(D.settings.get(WK.K_SEEN, {}), {});
});
t('junk wakes nobody: 999 at the default line, 4999 at /junktroop:5000', () => {
  reset();
  const L = fakeLaunch(); const w = makeWaker(L);
  w.setOn(org.id, true);
  w.observe({ orgId: org.id, account: ACC, underAttack: viewOf([['Home', { archer: '999' }]]) });
  w.observe({ orgId: org.id, account: ACC, underAttack: viewOf([['Home', { archer: '4999' }]], { Home: 'defensepolicy /junktroop:5000' }) });
  assert.strictEqual(L.calls.length, 0);
});
t('1000 wakes, unknown size wakes, 1 troop wakes at /junktroop:0', () => {
  reset();
  const L = fakeLaunch({ finish: true }); const w = makeWaker(L);
  w.observe({ orgId: org.id, account: ACC, underAttack: viewOf([['Home', { archer: '1000' }, { armyId: 10, king: 'A1', alliance: '' }]]) });
  w.observe({ orgId: org.id, account: ACC, underAttack: viewOf([['Home', { archer: '?' }, { armyId: 11, king: 'A2', alliance: '' }]]) });
  w.observe({ orgId: org.id, account: ACC, underAttack: viewOf([['Fort', { archer: '1' }, { armyId: 12, king: 'A3', alliance: '' }]], { Fort: 'defensepolicy /junktroop:0' }) });
  assert.strictEqual(L.calls.length, 3);
});
t('one wake per attack: repeated polls and more waves of the same attacker wake once', () => {
  reset();
  const L = fakeLaunch({ finish: true }); const w = makeWaker(L);
  const v1 = viewOf([['Home', { archer: '5000' }, { armyId: 100 }]]);
  for (let i = 0; i < 5; i++) w.observe({ orgId: org.id, account: ACC, underAttack: v1 });
  assert.strictEqual(L.calls.length, 1);
  // the same alliance's next waves, on another city too, landing minutes later
  const v2 = viewOf([['Home', { archer: '5000' }, { armyId: 100 }], ['Home', { archer: '8000' }, { armyId: 101, inMs: 420000 }],
    ['Fort', { archer: '?' }, { armyId: 102, inMs: 360000, king: 'Other lord' }]]);
  const did = w.observe({ orgId: org.id, account: ACC, underAttack: v2 });
  assert.strictEqual(L.calls.length, 1, 'still one');
  assert.deepStrictEqual(did.map((d) => d.kind), ['same-attack']);
  // a different attacker is a different attack
  const v3 = viewOf([['Fort', { archer: '3000' }, { armyId: 103, alliance: 'Others', king: 'Stranger' }]]);
  w.observe({ orgId: org.id, account: ACC, underAttack: v3 });
  assert.strictEqual(L.calls.length, 2);
  // the first attacker again, but landing an hour after its last wave: a new attack
  const v4 = viewOf([['Home', { archer: '5000' }, { armyId: 104, inMs: 300000 + 3600000 }]]);
  w.observe({ orgId: org.id, account: ACC, underAttack: v4 });
  assert.strictEqual(L.calls.length, 3);
});
t('the dedupe survives a Director restart', () => {
  reset();
  const L1 = fakeLaunch(); const w1 = makeWaker(L1);
  const v = viewOf([['Home', { archer: '5000' }, { armyId: 200 }]]);
  w1.observe({ orgId: org.id, account: ACC, underAttack: v });
  assert.strictEqual(L1.calls.length, 1);
  const L2 = fakeLaunch(); const w2 = makeWaker(L2);        // a new process, the same database
  w2.observe({ orgId: org.id, account: ACC, underAttack: v });
  w2.observe({ orgId: org.id, account: ACC, underAttack: viewOf([['Home', { archer: '5000' }, { armyId: 201, inMs: 400000 }]]) });
  assert.strictEqual(L2.calls.length, 0);
  const log = w2.wakes(org.id);
  assert.strictEqual(log[0].status, 'lost', 'the run the old Director was waiting on is marked lost');
});
t('the hourly cap, fleet-wide: over it an attack is logged as capped and never woken', () => {
  reset();
  D.settings.set(WK.K_CAP, 2);
  const L = fakeLaunch(); const w = makeWaker(L);
  for (let i = 0; i < 4; i++) {
    const acc = { id: `${ACC.id}x${i}`, label: 'L' + i };
    w.observe({ orgId: org.id, account: acc, underAttack: viewOf([['Home', { archer: '5000' }, { armyId: 300 + i, alliance: 'F' + i }]]) });
    // each finished at once, so only the cap holds them back
    for (const c of L.calls.splice(0)) { c.done({ code: 0, stdout: '{"result":"ok"}' }); L.calls.done = (L.calls.done || 0) + 1; }
  }
  assert.strictEqual(L.calls.done, 2);
  const st = w.wakes(org.id).map((x) => x.status);
  assert.deepStrictEqual(st.sort(), ['capped', 'capped', 'done', 'done']);
  assert.strictEqual(w.wakesLastHour(), 2);
  clock += 3600001;                       // an hour on, there is room again
  w.observe({ orgId: org.id, account: ACC, underAttack: viewOf([['Home', { archer: '5000' }, { armyId: 399, alliance: 'Late' }]]) });
  assert.strictEqual(L.calls.length, 1);
  clock = NOW0;
});
t('a second attack while its account\'s Claude still runs is left to that run', () => {
  reset();
  const L = fakeLaunch(); const w = makeWaker(L);
  w.observe({ orgId: org.id, account: ACC, underAttack: viewOf([['Home', { archer: '5000' }, { armyId: 400, alliance: 'X' }]]) });
  const did = w.observe({ orgId: org.id, account: ACC, underAttack: viewOf([['Home', { archer: '5000' }, { armyId: 401, alliance: 'Y' }]]) });
  assert.strictEqual(L.calls.length, 1);
  assert.strictEqual(did[0].kind, 'joined');
});
t('turning the switch off stops wakes', () => {
  reset();
  const L = fakeLaunch(); const w = makeWaker(L);
  w.setOn(org.id, false);
  w.observe({ orgId: org.id, account: ACC, underAttack: viewOf([['Home', { archer: '5000' }, { armyId: 500 }]]) });
  assert.strictEqual(L.calls.length, 0);
  w.setOn(org.id, true);
  w.observe({ orgId: org.id, account: ACC, underAttack: viewOf([['Home', { archer: '5000' }, { armyId: 500 }]]) });
  assert.strictEqual(L.calls.length, 1, 'switched on during the attack, it wakes for it');
});
t('the launcher gets claude -p, the otto MCP server in auto scope, and nothing else', () => {
  reset();
  P.set(ACC.id, { gate: true, truce: true, holiday: false });
  const L = fakeLaunch(); const w = makeWaker(L);
  w.observe({ orgId: org.id, account: ACC, underAttack: viewOf([['Home', { archer: '5000' }, { armyId: 600, king: 'Brutus', alliance: 'Foes' }]]) });
  assert.strictEqual(L.calls.length, 1);
  const { cmd, timeoutMs } = L.calls[0];
  assert.strictEqual(cmd.cmd, 'fake-claude');
  assert.strictEqual(cmd.cwd, __dirname);
  assert.strictEqual(timeoutMs, WK.TIMEOUT_MS);
  const a = cmd.args;
  assert.strictEqual(a[0], '-p');
  const flag = (f) => a[a.indexOf(f) + 1];
  assert.ok(a.includes('--strict-mcp-config'));
  assert.strictEqual(flag('--tools'), '');
  assert.strictEqual(flag('--allowedTools'), 'mcp__otto');
  assert.strictEqual(flag('--permission-mode'), 'dontAsk');
  assert.strictEqual(flag('--output-format'), 'json');
  const mcp = JSON.parse(flag('--mcp-config'));
  assert.deepStrictEqual(Object.keys(mcp.mcpServers), ['otto']);
  assert.strictEqual(mcp.mcpServers.otto.command, process.execPath);
  assert.deepStrictEqual(mcp.mcpServers.otto.args, [path.join(__dirname, 'otto-mcp.js')]);
  assert.strictEqual(mcp.mcpServers.otto.env.OTTO_CLAUDE_MODE, 'auto');
  assert.strictEqual(mcp.mcpServers.otto.env.OTTO_WAKE_ACCOUNT, ACC.id);
  assert.strictEqual(cmd.env.ANTHROPIC_API_KEY, undefined, 'the Max login, not an API key');
  assert.strictEqual(cmd.env.CLAUDECODE, undefined);
  assert.strictEqual(cmd.env.KEEP, 'me');
  const prompt = a[1];
  for (const want of [ACC.id, 'Lord02', 'Brutus', 'Foes', 'Home', '5000 troops', 'loyalty 88', 'gate (Control gate)', 'truce (Use Truce Agreement)',
    'Not given:', 'holiday (Holiday account)', 'KEEP THINGS ALIVE', 'No counter-attacks', 'act tool', 'short report', 'server ', 'local ']) {
    assert.ok(prompt.includes(want), `the prompt lacks "${want}":\n${prompt}`);
  }
  // its end is filed: exit code and Claude's final answer
  L.calls[0].done({ code: 0, stdout: JSON.stringify({ type: 'result', result: 'Closed the gate at Home. Loyalty 88.' }) });
  const last = w.wakes(org.id)[0];
  assert.strictEqual(last.status, 'done');
  assert.strictEqual(last.exitCode, 0);
  assert.strictEqual(last.output, 'Closed the gate at Home. Loyalty 88.');
  assert.strictEqual(last.prompt, prompt);
  assert.strictEqual(last.pid, 4242);
});
t('every permission off still wakes, and says so in the prompt; a timeout is filed', () => {
  reset();
  P.set(ACC.id, Object.fromEntries(P.PERMS.map((p) => [p, false])));
  const L = fakeLaunch(); const w = makeWaker(L);
  w.observe({ orgId: org.id, account: ACC, underAttack: viewOf([['Home', { archer: '5000' }, { armyId: 700 }]]) });
  assert.strictEqual(L.calls.length, 1);
  assert.ok(L.calls[0].cmd.args[1].includes('THIS account: NONE'));
  L.calls[0].done({ code: null, timedOut: true, stdout: '' });
  assert.strictEqual(w.wakes(org.id)[0].status, 'timeout');
});
t('the real launcher runs a command, collects its output and kills it at the timeout', () => {
  // a node child standing in for claude: prints, and one that hangs
  let got = null, hung = null;
  WK.spawnLauncher({ cmd: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({result:"hi"}))'], env: process.env, cwd: __dirname }, (r) => { got = r; }, 20000);
  WK.spawnLauncher({ cmd: process.execPath, args: ['-e', 'setTimeout(()=>{}, 60000)'], env: process.env, cwd: __dirname }, (r) => { hung = r; }, 300);
  pending.push(() => {
    assert.ok(got, 'the quick child finished');
    assert.strictEqual(got.code, 0);
    assert.strictEqual(JSON.parse(got.stdout).result, 'hi');
    assert.ok(hung && hung.timedOut, 'the hanging child was killed at the timeout');
  });
});

setTimeout(() => {
  section('asynchronous checks');
  for (const f of pending) t('the real launcher: output and timeout', f);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}, 4000);
