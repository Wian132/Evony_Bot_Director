'use strict';
// Step 18: config embassy, reportstokeep, spamheroes as the heroes the
// script's spam attacks use, and live castle buffs (server.CastleBuffUpdate).
// Offline: fixture objects, a throwaway database, and game clients whose
// send/await are captured. Nothing here connects, logs in or sends a byte.
//
//   node test-misc-goals.js
const assert = require('assert');
const path = require('path'), os = require('os'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-misc-goals-'));
if (!process.env.EVONY_DB) process.env.EVONY_DB = path.join(TMP, 't.db');

// Nothing may open a connection. Game.connect runs once below over a client
// whose network calls are stubbed; game.js takes getServerConfig when it
// loads, so that stub goes in before anything requires game.js.
const net = require('net'), tls = require('tls'), http = require('http'), https = require('https');
const refuse = (what) => () => { throw new Error(`${what} is blocked in this test — it must not open a connection`); };
net.connect = net.createConnection = refuse('net.connect');
tls.connect = refuse('tls.connect');
http.get = http.request = refuse('http.request');
https.get = https.request = refuse('https.request');
globalThis.fetch = refuse('fetch');
const EV = require('./evony');
EV.getServerConfig = async () => ({ host: 'offline.invalid', port: 1, state: 'test' });

const C = require('./constants');
const G = require('./goals');
const { parseGoals } = G;
const W = require('./goal-war');
const H = require('./goal-heroes');
const RP = require('./goal-reports');
const L = require('./goallayers');
const D = require('./db');
const { Game } = require('./game');
const { Engine } = require('./engine');
const { EvonyClient } = EV;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok    ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n        ') : e)); fail++; }
}
const section = (s) => console.log(`\n--- ${s} ---`);
const has = (s, sub) => assert.ok(String(s).includes(sub), `"${s}" does not contain "${sub}"`);

const MIN = 60000;
let NOW = Date.UTC(2026, 8, 14, 8, 0, 0);

// ------------------------------------------------------------------ fixtures
const EMBASSY = { typeId: 28, level: 3, positionId: 9 };
const home = (over = {}) => ({
  castleId: 11, id: 11, name: 'Home', fieldId: C.coordsToFieldId(100, 100),
  resource: { support: 100, food: { amount: 1e9 } }, troop: { archer: 100000 }, fortification: {},
  heros: [], buildings: [EMBASSY], allowAlliance: false, goOutForBattle: false, ...over,
});
function fakeGame(castles) {
  const g = {
    castles, reqs: [],
    now: () => NOW,
    castleId: (c) => c.castleId,
    castleXY: (c) => C.fieldIdToCoords(c.fieldId),
    req: async (cmd, data) => { g.reqs.push([cmd, data]); return g.reply ? g.reply(cmd, data) : { ok: 1 }; },
  };
  return g;
}
function ctxFor(castle, src, over = {}) {
  const p = parseGoals(src);
  assert.deepStrictEqual(p.errors, [], `the goals should parse: ${src}`);
  const game = over.game || fakeGame([castle, ...(over.others || [])]);
  return { game, castle, goals: p.goals, config: p.config, controls: {}, incoming: over.incoming || [], selfArmies: [], fortifications: {}, ...(over.ctx || {}) };
}
// an inbound enemy wave as the engine hands it over: string counts, absolute reachTime
let waveId = 900;
const wave = (inMs, archers = '20000') => ({ armyId: waveId++, king: 'Raider', startPosName: '150,150', missionType: C.MISSION.attack, reachTime: NOW + inMs, troop: { archer: archers } });

// A real Game over a real EvonyClient whose socket calls are captured.
function wireGame({ replies = {}, castles = [home()] } = {}) {
  const sent = [];
  const c = new EvonyClient();
  c.send = (cmd, data) => { sent.push({ cmd, data }); };
  c.await = async (cmds) => {
    const cmd = cmds[0];
    const last = [...sent].reverse().find((s) => s.cmd === cmd);
    const r = typeof replies[cmd] === 'function' ? replies[cmd](last && last.data) : replies[cmd];
    if (r === 'timeout') throw new Error('no reply to ' + cmd);
    return { cmd, data: r || { ok: 1 } };
  };
  const g = new Game(() => {});
  g.c = c;
  g.castles = castles;
  g.player = { playerInfo: { userName: 'Lord' }, items: [], buffs: [], selfArmys: [], enemyArmys: [] };
  return { g, c, sent };
}
function engineFor(g, textFor) {
  const e = new Engine(g, () => {});
  e.dryRun = false;
  e.state = {};
  e.goalsFor = (id) => { const src = typeof textFor === 'function' ? textFor(id) : textFor; return src ? parseGoals(src) : null; };
  return e;
}
const cmds = (sent, re) => sent.filter((s) => re.test(s.cmd));

// The live goal texts (scratchpad live-goals.txt, as test-goal-lines.js keeps
// them): none mentions embassy, reportstokeep or spamheroes.
const LIVE_LORD22 = [
  'config comfort:1,hero:1,troopsusepopmax:1', 'comfortpolicy 15 16 popraise',
  'defensepolicy /usetruce:79 /usespeech:2 /junktroop:5000 /usewarhorn:1 /usecorselet:1 /usepenicillin:1',
  'build f:10:37,s:0:0,i:0:0,q:0:0', 'troop b:5k,t:5k', 'troop a:100k,s:100k', 'fortification ab:5000',
].join('\n');
const LIVE_LORD02 = [
  'config comfort:1,hero:1,troopsusepopmax:1,npc:5', 'comfortpolicy 15 16 popraise',
  'defensepolicy /usetruce:79 /usespeech:2 /junktroop:5000 /usewarhorn:1 /usecorselet:1 /usepenicillin:1',
  'build fh:1', 'build f:10:37', 'troop b:5k,t:5k', 'fortification ab:5000', 'distancepolicy 15', 'npcteams 3',
  'requestresources any wood 2000000 200000 * 500000 /below:100000', 'traininghero OTTO 30 60', 'npcheroes !OTTO,any',
  'farmingpolicy 10 /distance:5', 'farmingpolicy 5 /distance:10',
].join('\n');

(async () => {
  // =============================================================== embassy
  section('config embassy: parsing');

  await t('0, 1 and 2 are read; the key is off the "does nothing yet" table, so the line is blue', async () => {
    for (const v of [0, 1, 2]) {
      const p = parseGoals(`config embassy:${v}`);
      assert.deepStrictEqual([p.errors, p.config], [[], { embassy: v }]);
      assert.deepStrictEqual(p.lines[0], { n: 1, status: 'ok', msg: null });
      assert.strictEqual(W.parsers.embassy.parse(v).mode, v);
    }
    assert.ok(!('embassy' in G.NOT_IMPLEMENTED.config));
    assert.ok(W.configKeys.includes('embassy'));
  });

  await t('any other value is an error (and the box is then left alone)', async () => {
    for (const v of ['3', 'open', '1.5', '-1', '']) {
      const p = parseGoals(`config embassy:${v}`);
      assert.strictEqual(p.errors.length, 1, v);
      has(p.errors[0].error, 'embassy must be 0 (always closed), 1 (always open) or 2 (open while under attack)');
    }
    const plan = W.plans.embassy({ ...ctxFor(home({ allowAlliance: false }), ''), config: { embassy: 'open' } }, {});
    assert.deepStrictEqual(plan.actions, []);
    has(plan.note, 'the box is left as it is');
  });

  await t('written as a line of its own it is read as the config it means', async () => {
    const p = parseGoals('embassy 2');
    assert.deepStrictEqual([p.errors, p.config], [[], { embassy: 2 }]);
    has(p.lines[0].msg, 'read as "config embassy:2"');
  });

  await t('describe says what each mode does', async () => {
    const d = (v) => W.describe(parseGoals(`config embassy:${v}`)).find((l) => l.startsWith('embassy:'));
    has(d(1), 'always allowed');
    has(d(0), 'never allowed');
    has(d(2), 'only while under attack and for config defensecooldown after');
  });

  section('config embassy: when the box is set');

  await t('a city whose goals never mention embassy is left alone, whatever its box says (NEAT default 1 not applied)', async () => {
    for (const src of ['', 'troop a:1k', LIVE_LORD22, LIVE_LORD02]) {
      const c = home({ allowAlliance: false });
      assert.strictEqual(W.plans.embassy(ctxFor(c, src, { incoming: [wave(5 * MIN)] }), {}), null, src);
    }
  });

  await t('1 opens a closed box, and says so; an open box is left', async () => {
    const p = W.plans.embassy(ctxFor(home({ allowAlliance: false }), 'config embassy:1'), {});
    assert.deepStrictEqual(p.actions.map((a) => [a.kind, a.allow]), [['setEmbassy', true]]);
    has(p.note, 'embassy 1 (always open)');
    has(p.note, 'the box is closed — setting it open');
    const q = W.plans.embassy(ctxFor(home({ allowAlliance: true }), 'config embassy:1'), {});
    assert.deepStrictEqual(q.actions, []);
    has(q.note, 'the box is already open');
  });

  await t('0 closes an open box; a closed box is left', async () => {
    const p = W.plans.embassy(ctxFor(home({ allowAlliance: true }), 'config embassy:0'), {});
    assert.deepStrictEqual(p.actions.map((a) => a.allow), [false]);
    assert.deepStrictEqual(W.plans.embassy(ctxFor(home({ allowAlliance: false }), 'config embassy:0'), {}).actions, []);
  });

  await t('a box the castle does not report is set once to what is wanted', async () => {
    const c = home();
    delete c.allowAlliance;
    const p = W.plans.embassy(ctxFor(c, 'config embassy:1'), {});
    assert.deepStrictEqual(p.actions.map((a) => a.allow), [true]);
    has(p.note, 'not reported');
  });

  await t('no Embassy in the city (or one still at level 0): nothing to set', async () => {
    for (const buildings of [[], [{ typeId: 28, level: 0, positionId: 9, status: 1 }]]) {
      const p = W.plans.embassy(ctxFor(home({ buildings, allowAlliance: false }), 'config embassy:1'), {});
      assert.deepStrictEqual(p.actions, []);
      has(p.note, 'this city has no Embassy');
    }
  });

  await t('2: closed while quiet, opened for a real attack, open through defensecooldown, closed after it', async () => {
    const c = home({ allowAlliance: false });
    const state = {};
    const game = fakeGame([c]);
    const plan = (incoming) => W.plans.embassy(ctxFor(c, 'config embassy:2,defensecooldown:30', { game, incoming }), state, game);
    let p = plan([]);
    assert.deepStrictEqual(p.actions, [], p.note);
    has(p.note, 'not under attack');
    // a real wave inbound
    const w = wave(5 * MIN);
    p = plan([w]);
    assert.deepStrictEqual(p.actions.map((a) => a.allow), [true], p.note);
    has(p.note, 'under attack, 1 real wave(s) inbound');
    await W.executors.setEmbassy(game, c, p.actions[0], state);
    assert.strictEqual(c.allowAlliance, true);
    assert.deepStrictEqual(game.reqs, [['army.setAllowAllianceArmy', { castleId: 11, isAllow: true }]]);
    // it lands, and the push no longer lists it: still under attack for the cooldown
    NOW += 6 * MIN;
    p = plan([]);
    assert.deepStrictEqual(p.actions, [], p.note);
    has(p.note, 'under attack for another');
    has(p.note, 'the box is already open');
    // 30 minutes after it landed the window has closed
    NOW += 30 * MIN;
    p = plan([]);
    assert.deepStrictEqual(p.actions.map((a) => a.allow), [false], p.note);
    has(p.note, 'not under attack');
  });

  await t('2: a junk wave (under defensepolicy /junktroop) does not open it', async () => {
    const c = home({ allowAlliance: false });
    const p = W.plans.embassy(ctxFor(c, 'config embassy:2\ndefensepolicy /junktroop:5000', { incoming: [wave(5 * MIN, '3000')] }), {});
    assert.deepStrictEqual(p.actions, [], p.note);
    const q = W.plans.embassy(ctxFor(c, 'config embassy:2\ndefensepolicy /junktroop:5000', { incoming: [wave(5 * MIN, '6000')] }), {});
    assert.deepStrictEqual(q.actions.map((a) => a.allow), [true]);
  });

  await t('a refusal is stamped: the plan waits 5 minutes, then asks again', async () => {
    const c = home({ allowAlliance: false });
    const state = {};
    const game = fakeGame([c]);
    game.reply = () => ({ ok: -1, errorMsg: 'not now' });
    const ctx = () => ctxFor(c, 'config embassy:1', { game });
    const p = W.plans.embassy(ctx(), state, game);
    const r = await W.executors.setEmbassy(game, c, p.actions[0], state);
    assert.strictEqual(r.ok, -1);
    assert.strictEqual(c.allowAlliance, false, 'a refusal changes nothing locally');
    assert.deepStrictEqual([state.war.embassy.ok, state.war.embassy.want, state.war.embassy.error], [false, true, 'not now']);
    NOW += 2 * MIN;
    const held = W.plans.embassy(ctx(), state, game);
    assert.deepStrictEqual(held.actions, []);
    has(held.note, 'was refused (not now)');
    has(held.note, 'trying again in');
    NOW += 4 * MIN;
    assert.deepStrictEqual(W.plans.embassy(ctx(), state, game).actions.map((a) => a.allow), [true]);
  });

  await t('game.setAllowAlliance sends army.setAllowAllianceArmy {castleId, isAllow}, as Embassy.as does', async () => {
    const { g, sent } = wireGame();
    await g.setAllowAlliance(11, 1);
    await g.setAllowAlliance(11, false);
    assert.deepStrictEqual(sent.map((s) => [s.cmd, s.data]),
      [['army.setAllowAllianceArmy', { castleId: 11, isAllow: true }], ['army.setAllowAllianceArmy', { castleId: 11, isAllow: false }]]);
  });

  section('config embassy: through the engine');

  await t('embassy:2 and a hostile push: the engine opens the box in the next slice', async () => {
    const { g, c, sent } = wireGame({ castles: [home({ allowAlliance: false })] });
    const e = engineFor(g, 'config embassy:2');
    c.emit('cmd', 'server.EnemyArmysUpdate', { armys: [{ ...wave(10 * MIN), reachTime: Date.now() + 10 * MIN, direction: 1, targetFieldId: g.castles[0].fieldId }] });
    const r = await e.focus(g.castles[0]);
    assert.deepStrictEqual(cmds(sent, /setAllowAlliance/).map((s) => s.data), [{ castleId: 11, isAllow: true }], r.acted.join(' | '));
    assert.strictEqual(g.castles[0].allowAlliance, true);
    assert.ok(r.acted.some((a) => /open the embassy to alliance troops \(config embassy:2\) -> ok/.test(a)), r.acted.join(' | '));
    // and nothing more while it stays open
    await e.focus(g.castles[0]);
    assert.strictEqual(cmds(sent, /setAllowAlliance/).length, 1);
  });

  await t('the live goals, a hostile wave and a closed box: nothing about the embassy is sent', async () => {
    for (const src of [LIVE_LORD22, LIVE_LORD02]) {
      const { g, c, sent } = wireGame({ castles: [home({ allowAlliance: false })] });
      const e = engineFor(g, src);
      c.emit('cmd', 'server.EnemyArmysUpdate', { armys: [{ ...wave(10 * MIN), reachTime: Date.now() + 10 * MIN, direction: 1, targetFieldId: g.castles[0].fieldId }] });
      await e.focus(g.castles[0]);
      assert.deepStrictEqual(cmds(sent, /setAllowAlliance|^report\./), []);
    }
  });

  await t('a dry run plans it and sends nothing', async () => {
    const { g, sent } = wireGame({ castles: [home({ allowAlliance: false })] });
    const e = engineFor(g, 'config embassy:1');
    e.dryRun = true;
    const r = await e.focus(g.castles[0]);
    assert.deepStrictEqual(cmds(sent, /setAllowAlliance/), []);
    assert.ok(r.acted.some((a) => /^\[plan\] open the embassy/.test(a)), r.acted.join(' | '));
  });

  // ========================================================= reportstokeep
  section('reportstokeep: parsing');

  const LINE = 'reportstokeep 1 a:500 b:1 a:3800 a:6000';
  const rules = (src = LINE) => parseGoals(src).goals.find((x) => x.name === 'reportstokeep');

  await t('the wiki example: treasure on, valley 500 archers, npc5 1 ballista, npc10 under 3,800 or over 6,000 archers', async () => {
    const p = parseGoals(LINE);
    assert.deepStrictEqual(p.errors, []);
    assert.deepStrictEqual(p.lines[0], { n: 1, status: 'ok', msg: null });
    const g = p.goals[0];
    assert.strictEqual(g.treasure, true);
    assert.strictEqual(g.valid, true);
    assert.deepStrictEqual([g.valley.typeId, g.valley.count], [7, 500]);
    assert.deepStrictEqual([g.npc5.typeId, g.npc5.count], [11, 1]);
    assert.deepStrictEqual([g.npc10low.typeId, g.npc10low.count, g.npc10high.count], [7, 3800, 6000]);
  });

  await t('numbers take k, the troop any goals word, and 0 is allowed; the treasure switch may be 0', async () => {
    const g = rules('reportstokeep 0 archer:0.5k ballista:0 arch:3.8k a:6k');
    assert.strictEqual(g.valid, true);
    assert.deepStrictEqual([g.treasure, g.valley.count, g.npc5.count, g.npc10low.count, g.npc10high.count], [false, 500, 0, 3800, 6000]);
  });

  await t('anything it cannot read is an error, and such a line opens and deletes nothing', async () => {
    for (const [src, want] of [
      ['reportstokeep 1 a:500', 'expected: reportstokeep'],
      ['reportstokeep', 'expected: reportstokeep'],
      ['reportstokeep 2 a:1 b:1 a:1 a:1', 'the treasure switch is 0'],
      ['reportstokeep 1 zz:5 b:1 a:1 a:1', 'unknown troop "zz"'],
      ['reportstokeep 1 a:lots b:1 a:1 a:1', 'is not a whole number'],
      ['reportstokeep 1 a:1.5 b:1 a:1 a:1', 'is not a whole number'],
      ['reportstokeep 1 a b:1 a:1 a:1', 'should be troop:count'],
    ]) {
      const p = parseGoals(src);
      assert.ok(p.errors.length, src);
      has(p.errors.map((e) => e.error).join(' | '), want);
      assert.strictEqual(p.lines[0].status, 'error', src);
      const plan = RP.plans.reportstokeep(ctxFor(home(), '', { ctx: { goals: p.goals } }), {});
      assert.deepStrictEqual(plan.actions, [], src);
      has(plan.note, 'the line has an error');
    }
  });

  await t('one per city: written twice, the later line wins', async () => {
    const p = parseGoals(`${LINE}\nreportstokeep 0 a:1 b:1 a:1 a:1`);
    assert.deepStrictEqual(p.goals.filter((x) => x.name === 'reportstokeep').map((x) => x.line), [2]);
    assert.strictEqual(p.lines[0].status, 'error');
  });

  section('reportstokeep: which reports are kept (decoded report fixtures)');

  const XML = {
    battle: ({ lost = {}, win = true, treasure = false, captured = false, isAttack = true } = {}) =>
      `<reportData><battleReport isAttack="${isAttack}" isAttackSuccess="${win}" round="3"${treasure ? ' attackWinnerItems="player.box.gambling.3=1"' : ''}>`
      + `<attackTroop king="Me" heroName="Moore" heroLevel="50">${Object.entries(lost).map(([id, k]) => `<troopUnit typeId="${id}" count="${k + 1000}" lose="${k}"/>`).join('')}</attackTroop>`
      + '<defendTroop><troopUnit typeId="3" count="100" lose="100"/></defendTroop>'
      + (captured ? '<backTroop isBack="true"><troops heroName="Moore" heroLevel="50" isHeroBeSeized="true"><troopInfo typeId="7" preCount="5" remain="0" injured="0"/></troops></backTroop>' : '')
      + '</battleReport></reportData>',
    back: (type = 5) => `<reportData><troopMovement type="${type}" isBack="true"><troops typeId="11" count="550"/><resource food="1000"/></troopMovement></reportData>`,
    arrive: '<reportData><troopMovement type="5" isBack="false"><troops typeId="11" count="550"/></troopMovement></reportData>',
    scout: '<reportData><scoutReport isAttack="true" isFound="true" isSuccess="true"/></reportData>',
    text: 'something this console cannot decode',
  };
  const A = 7, B = 11;
  const npc = (level) => ({ kind: 'npc', level, where: '103,100' });
  const valley = { kind: 'valley', level: 5, where: '107,100' };
  const verdict = (target, xml, r = rules()) => RP._internals.judge(r, target, RP._internals.readContent(xml, {}));

  await t('valley: kept at 500 archers lost or more, deleted under it; a:0 keeps every valley report', async () => {
    assert.deepStrictEqual(verdict(valley, XML.battle({ lost: { [A]: 600 } })).keep, true);
    assert.deepStrictEqual(verdict(valley, XML.battle({ lost: { [A]: 500 } })).keep, true);
    const d = verdict(valley, XML.battle({ lost: { [A]: 100, [B]: 900 } }));
    assert.strictEqual(d.keep, false);
    has(d.why, 'valley 107,100: 100 archers lost < 500');
    assert.strictEqual(verdict(valley, XML.battle({ lost: {} }), rules('reportstokeep 1 a:0 b:1 a:3800 a:6000')).keep, true);
  });

  await t('npc5: kept when a ballista was lost, deleted when none was', async () => {
    assert.strictEqual(verdict(npc(5), XML.battle({ lost: { [B]: 1 } })).keep, true);
    const d = verdict(npc(5), XML.battle({ lost: { [A]: 5000 } }));
    assert.strictEqual(d.keep, false);
    has(d.why, 'npc5 103,100: 0 ballistas lost < 1');
    assert.strictEqual(verdict(npc(5), XML.battle({ lost: {} }), rules('reportstokeep 1 a:500 b:0 a:3800 a:6000')).keep, true);
  });

  await t('npc10: kept under 3,800 or over 6,000 archers lost, deleted in between; a 0 keeps every npc10 report', async () => {
    assert.strictEqual(verdict(npc(10), XML.battle({ lost: { [A]: 3000 } })).keep, true);
    assert.strictEqual(verdict(npc(10), XML.battle({ lost: { [A]: 7000 } })).keep, true);
    for (const k of [3800, 5000, 6000]) assert.strictEqual(verdict(npc(10), XML.battle({ lost: { [A]: k } })).keep, false, String(k));
    has(verdict(npc(10), XML.battle({ lost: { [A]: 5000 } })).why, 'between 3,800 and 6,000');
    assert.strictEqual(verdict(npc(10), XML.battle({ lost: { [A]: 5000 } }), rules('reportstokeep 1 a:500 b:1 a:0 a:0')).keep, true);
  });

  await t('other npc levels have no rule that keeps them: deleted; a camp with no level in the map cache: kept', async () => {
    for (const lv of [1, 4, 6, 7, 9]) assert.strictEqual(verdict(npc(lv), XML.battle({ lost: { [A]: 10 } })).keep, false, `npc${lv}`);
    const u = verdict(npc(null), XML.battle({ lost: { [A]: 10 } }));
    assert.strictEqual(u.keep, true);
    has(u.why, 'no level');
  });

  await t('treasure acquired keeps it when the switch is 1, and not when it is 0', async () => {
    const xml = XML.battle({ lost: { [A]: 10 }, treasure: true });
    const k = verdict(npc(7), xml);
    assert.strictEqual(k.keep, true);
    has(k.why, 'treasure acquired');
    assert.strictEqual(verdict(npc(7), xml, rules('reportstokeep 0 a:500 b:1 a:3800 a:6000')).keep, false);
  });

  await t('a failed attack and a captured hero are always kept (our caution)', async () => {
    has(verdict(npc(7), XML.battle({ lost: { [A]: 10 }, win: false })).why, 'the attack failed');
    has(verdict(npc(5), XML.battle({ lost: {}, captured: true })).why, 'a hero was captured');
    assert.strictEqual(verdict(npc(5), XML.battle({ lost: {}, captured: true })).keep, true);
  });

  await t('the army\'s return report is deleted, unless its kind\'s number is 0', async () => {
    const d = verdict(npc(5), XML.back());
    assert.strictEqual(d.keep, false);
    has(d.why, 'return report');
    assert.strictEqual(verdict(npc(5), XML.back(), rules('reportstokeep 1 a:500 b:0 a:3800 a:6000')).keep, true);
    assert.strictEqual(verdict(valley, XML.back()).keep, false);
  });

  await t('never deleted: a report it cannot judge — scouting, a transport or arriving march, a defence, unreadable text', async () => {
    for (const [what, xml] of [['scout', XML.scout], ['transport home', XML.back(1)], ['reinforcement home', XML.back(2)],
      ['arriving', XML.arrive], ['defence', XML.battle({ isAttack: false })], ['text', XML.text], ['empty', '']]) {
      const d = verdict(npc(5), xml);
      assert.strictEqual(d.keep, true, `${what}: ${d.why}`);
    }
  });

  section('reportstokeep: which rows are opened at all');

  // the map cache the console's scans feed (db.js mapCache)
  const XY = { npc5: [103, 100], npc10: [104, 100], npc7: [105, 100], npcNoLevel: [106, 100], lake: [107, 100], player: [108, 100], flat: [109, 100], unknown: [110, 100] };
  const tile = (key, extra) => { const [x, y] = XY[key]; return { id: C.coordsToFieldId(x, y), x, y, seen: NOW, ...extra }; };
  D.mapCache.upsertMany([
    tile('npc5', { kind: 'npc', npc: true, level: 5, name: "Barbarian's Town" }),
    tile('npc10', { kind: 'npc', npc: true, level: 10, name: "Barbarian's City" }),
    tile('npc7', { kind: 'npc', npc: true, level: 7, name: "Barbarian's Fort" }),
    tile('npcNoLevel', { kind: 'npc', npc: true, name: 'Barbarian' }),
    tile('lake', { kind: 'lake', level: 6, userName: 'Someone' }),
    tile('player', { kind: 'player', npc: false, userName: 'Rival', name: 'Rival City' }),
    tile('flat', { kind: 'flat', level: 3 }),
  ]);
  const OWN = new Set([home().fieldId]);
  const pos = (key, name = 'Target') => `${name}(${XY[key][0]},${XY[key][1]})`;
  let rid = 1000;
  const row = (target, over = {}) => ({ id: rid++, type: 1, armyType: 5, title: 'Attack', isRead: 0, eventTime: 1, startPos: 'Home(100,100)', targetPos: pos(target), back: false, attack: true, ...over });

  await t('an attack from our city on a known NPC camp or valley is opened; its level comes from the map cache', async () => {
    const T = (r) => RP._internals.targetOf(r, OWN);
    assert.deepStrictEqual(T(row('npc5')), { kind: 'npc', level: 5, where: '103,100' });
    assert.deepStrictEqual(T(row('npc10')), { kind: 'npc', level: 10, where: '104,100' });
    assert.deepStrictEqual(T(row('npcNoLevel')), { kind: 'npc', level: null, where: '106,100' });
    assert.strictEqual(T(row('lake')).kind, 'valley');
    assert.strictEqual(T(row('npc5', { armyType: undefined })).level, 5, 'a row without a mission type is judged by its target');
  });

  await t('never opened: another mission, a player city, a flat, a tile the map cache does not know, a march that is not ours', async () => {
    const T = (r) => RP._internals.targetOf(r, OWN);
    for (const m of [1, 2, 3, 4]) assert.strictEqual(T(row('npc5', { armyType: m })), null, `mission ${m}`);
    for (const k of ['player', 'flat', 'unknown']) assert.strictEqual(T(row(k)), null, k);
    assert.strictEqual(T(row('npc5', { startPos: 'Elsewhere(300,300)' })), null);
    assert.strictEqual(T(row('npc5', { targetPos: "Barbarian's Town" })), null, 'no coordinates');
  });

  section('reportstokeep: a run, paced');

  // A report box: rows (newest first) with their XML, on a fake game.
  function box(rows, contentOf) {
    const g = fakeGame([home()]);
    g.lists = []; g.opened = []; g.deleted = []; g.fail = {};
    const byId = new Map(rows.map((r) => [r.id, r]));
    g.reportList = async (type, page, size) => {
      assert.strictEqual(type, 'army', 'only army reports are ever listed');
      g.lists.push(page);
      if (g.fail.list) return { ok: -1, errorMsg: g.fail.list };
      const live = rows.filter((r) => byId.has(r.id));
      return { ok: 1, pageNo: page, totalPage: Math.max(1, Math.ceil(live.length / size)), reports: live.slice((page - 1) * size, page * size) };
    };
    g.readReport = async (id) => {
      g.opened.push(id);
      if (g.fail.read === id) throw new Error('no reply to report.markAsRead');
      const r = byId.get(id);
      return r ? { ok: 1, report: { ...r, content: contentOf(r) } } : { ok: -1, errorMsg: 'gone' };
    };
    g.deleteReports = async (ids) => {
      if (g.fail.delete) { g.fail.delete--; return { ok: -1, errorMsg: 'busy' }; }
      g.deleted.push(ids.slice());
      for (const id of ids) byId.delete(id);
      return { ok: 1 };
    };
    return g;
  }
  const run = (g, state, r = rules()) => RP.executors.reportsToKeep(g, g.castles[0], { kind: 'reportsToKeep', rules: r }, state);

  await t('one run: opens only NPC/valley attack reports, deletes what no rule keeps in one request, keeps the rest', async () => {
    const rows = [
      row('npc5'), row('npc5'), row('player'), row('npc10'), row('npc5', { armyType: 1 }), row('lake'),
    ];
    const content = new Map([[rows[0].id, XML.battle({ lost: { [B]: 2 } })], [rows[1].id, XML.back()], [rows[3].id, XML.battle({ lost: { [A]: 5000 } })],
      [rows[5].id, XML.battle({ lost: { [A]: 700 } })]]);
    const g = box(rows, (r) => content.get(r.id) || XML.text);
    const state = {};
    const r = await run(g, state);
    assert.strictEqual(r.ok, 1, r.errorMsg);
    assert.deepStrictEqual(g.opened, [rows[0].id, rows[1].id, rows[3].id, rows[5].id], 'the player-city row and the transport row are never opened');
    assert.deepStrictEqual(g.deleted, [[rows[1].id, rows[3].id]]);
    assert.deepStrictEqual([state.reports.kept, state.reports.deleted], [2, 2]);
    assert.deepStrictEqual(Object.keys(state.reports.keptIds).map(Number).sort(), [rows[0].id, rows[5].id].sort());
    assert.ok(state.reports.nextAt - Date.now() > RP._internals.REPORT_BUSY_MS, 'not a full batch: the next look is 10 minutes away');
  });

  await t('at most 5 reports opened a run; a full batch looks again in a minute; kept ids are never opened twice', async () => {
    const rows = Array.from({ length: 12 }, () => row('npc5'));
    const g = box(rows, () => XML.battle({ lost: { [B]: 1 } }));      // every one kept (a ballista lost)
    const state = {};
    await run(g, state);
    assert.strictEqual(g.opened.length, RP._internals.REPORT_BATCH);
    const wait = state.reports.nextAt - Date.now();
    assert.ok(wait > 0 && wait <= RP._internals.REPORT_BUSY_MS, String(wait));
    await run(g, state);
    await run(g, state);
    assert.deepStrictEqual(g.opened.slice().sort(), rows.map((r) => r.id).sort(), 'each opened exactly once');
    assert.strictEqual(state.reports.kept, 12);
    assert.deepStrictEqual(g.deleted, []);
  });

  await t('it looks at most 3 pages of 50 a run', async () => {
    const rows = Array.from({ length: 200 }, () => row('player'));
    const g = box(rows, () => XML.text);
    await run(g, {});
    assert.deepStrictEqual(g.lists, [1, 2, 3]);
    assert.deepStrictEqual(g.opened, []);
  });

  await t('a refused delete is tried again next run, without opening those reports again', async () => {
    const rows = [row('npc7'), row('npc7')];
    const g = box(rows, () => XML.battle({ lost: { [A]: 1 } }));
    g.fail.delete = 1;
    const state = {};
    const r = await run(g, state);
    assert.strictEqual(r.ok, 0);
    has(r.errorMsg, 'the delete was refused (busy)');
    assert.deepStrictEqual(state.reports.retry, rows.map((x) => x.id));
    assert.ok(state.reports.nextAt - Date.now() > 4 * MIN, 'retried in 5 minutes');
    await run(g, state);
    assert.deepStrictEqual(g.opened, rows.map((x) => x.id), 'opened once only');
    assert.deepStrictEqual(g.deleted, [rows.map((x) => x.id)]);
    assert.deepStrictEqual([state.reports.deleted, state.reports.retry], [2, []]);
  });

  await t('a delete refused 3 times leaves those reports in the box, and they are not opened again', async () => {
    const rows = [row('npc7')];
    const g = box(rows, () => XML.battle({ lost: { [A]: 1 } }));
    g.fail.delete = 99;
    const state = {};
    for (let i = 0; i < RP._internals.DELETE_TRIES; i++) await run(g, state);
    has(state.reports.last.error, 'refused 3 times (busy) — those 1 report(s) are left in the box');
    assert.deepStrictEqual(state.reports.retry, []);
    g.fail.delete = 0;
    await run(g, state);
    assert.deepStrictEqual([g.opened, g.deleted], [[rows[0].id], []]);
  });

  await t('a report that will not open stops the run; the ones judged before it are still dealt with', async () => {
    const rows = [row('npc7'), row('npc7'), row('npc7')];
    const g = box(rows, () => XML.battle({ lost: { [A]: 1 } }));
    g.fail.read = rows[1].id;
    const state = {};
    const r = await run(g, state);
    assert.strictEqual(r.ok, 0);
    has(r.errorMsg, 'no reply to report.markAsRead');
    assert.deepStrictEqual(g.opened, [rows[0].id, rows[1].id]);
    assert.deepStrictEqual(g.deleted, [[rows[0].id]]);
    has(state.reports.last.error, 'no reply');
  });

  await t('a list the server refuses: nothing opened, nothing deleted, tried again in 5 minutes', async () => {
    const g = box([row('npc7')], () => XML.battle({ lost: { [A]: 1 } }));
    g.fail.list = 'try later';
    const state = {};
    const r = await run(g, state);
    assert.strictEqual(r.ok, 0);
    assert.deepStrictEqual([g.opened, g.deleted], [[], []]);
    assert.ok(state.reports.nextAt - Date.now() > 4 * MIN);
  });

  await t('an NPC-camp row whose report turns out to be something else is kept, never deleted', async () => {
    const rows = [row('npc5'), row('npc5'), row('npc5'), row('npc5')];
    const xs = [XML.scout, XML.back(1), XML.text, XML.battle({ isAttack: false })];
    const g = box(rows, (r) => xs[rows.indexOf(r)]);
    const state = {};
    await run(g, state);
    assert.strictEqual(g.opened.length, 4);
    assert.deepStrictEqual(g.deleted, []);
    assert.strictEqual(state.reports.kept, 4);
  });

  section('reportstokeep: the plan');

  await t('no line: no plan; a line: one action, until the next look is due', async () => {
    assert.strictEqual(RP.plans.reportstokeep(ctxFor(home(), 'troop a:1k'), {}), null);
    const p = RP.plans.reportstokeep(ctxFor(home(), LINE), {});
    assert.deepStrictEqual(p.actions.map((a) => a.kind), ['reportsToKeep']);
    has(p.note, 'reportstokeep 1 a:500 b:1 a:3800 a:6000');
    const state = { reports: { kept: 3, deleted: 9, nextAt: Date.now() + 5 * MIN, last: { at: Date.now(), read: 5, deleted: 4, kept: 1, why: ['npc10 104,100: 3,000 archers lost < 3,800'] } } };
    const q = RP.plans.reportstokeep(ctxFor(home(), LINE), state);
    assert.deepStrictEqual(q.actions, []);
    has(q.note, '9 deleted, 3 kept so far');
    has(q.note, 'opened 5, deleted 4, kept 1 — npc10 104,100: 3,000 archers lost < 3,800');
    has(q.note, 'next look in 5 min');
  });

  await t('account-wide: only the first city with a readable line runs it; the others say which city does', async () => {
    const a = home(), b = home({ castleId: 22, id: 22, name: 'Second', fieldId: C.coordsToFieldId(200, 200) });
    const game = fakeGame([a, b]);
    const text = { 11: LINE, 22: 'reportstokeep 0 a:1 b:1 a:1 a:1' };
    const goalsOf = (c) => parseGoals(text[c.castleId]).goals;
    const plan = (c) => RP.plans.reportstokeep(ctxFor(c, text[c.castleId], { game, ctx: { goalsOf } }), {});
    assert.strictEqual(plan(a).actions.length, 1);
    const pb = plan(b);
    assert.deepStrictEqual(pb.actions, []);
    has(pb.note, 'reports belong to the account, so Home sorts them');
    // the first city's line broken: the second one takes over
    text[11] = 'reportstokeep 1 a:500';
    assert.strictEqual(plan(b).actions.length, 1);
  });

  section('reportstokeep: through the engine');

  function reportGame(rows, contentOf) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    return wireGame({
      replies: {
        'report.receiveReportList': (d) => ({ ok: 1, pageNo: d.pageNo, totalPage: 1, reports: rows.filter((r) => byId.has(r.id)) }),
        'report.markAsRead': (d) => ({ ok: 1, report: { ...byId.get(d.reportId), content: contentOf(byId.get(d.reportId)) } }),
        'report.deleteReport': (d) => { for (const id of String(d.idStr).split(',')) byId.delete(Number(id)); return { ok: 1 }; },
      },
    });
  }

  await t('a slice lists army reports (reportType 1), opens the camp reports and deletes the one no rule keeps', async () => {
    const rows = [row('npc10'), row('npc10'), row('player')];
    const xs = { [rows[0].id]: XML.battle({ lost: { [A]: 5000 } }), [rows[1].id]: XML.battle({ lost: { [A]: 9000 } }) };
    const { g, sent } = reportGame(rows, (r) => xs[r.id] || XML.text);
    const e = engineFor(g, LINE);
    const r = await e.focus(g.castles[0]);
    const rep = cmds(sent, /^report\./);
    assert.ok(rep.filter((s) => s.cmd === 'report.receiveReportList').every((s) => s.data.reportType === 1), JSON.stringify(rep));
    assert.deepStrictEqual(rep.filter((s) => s.cmd === 'report.markAsRead').map((s) => s.data.reportId), [rows[0].id, rows[1].id]);
    assert.deepStrictEqual(rep.filter((s) => s.cmd === 'report.deleteReport').map((s) => s.data.idStr), [String(rows[0].id)]);
    assert.ok(r.acted.some((a) => /reportstokeep: .* -> ok/.test(a)), r.acted.join(' | '));
    assert.deepStrictEqual([e.state['11'].reports.deleted, e.state['11'].reports.kept], [1, 1]);
    // the next slice waits for its time
    await e.focus(g.castles[0]);
    assert.strictEqual(cmds(sent, /^report\.receiveReportList/).length, 1);
  });

  await t('a dry run sends no report command at all', async () => {
    const { g, sent } = reportGame([row('npc10')], () => XML.battle({ lost: { [A]: 5000 } }));
    const e = engineFor(g, LINE);
    e.dryRun = true;
    const r = await e.focus(g.castles[0]);
    assert.deepStrictEqual(cmds(sent, /^report\./), []);
    assert.ok(r.acted.some((a) => /^\[plan\] reportstokeep/.test(a)), r.acted.join(' | '));
  });

  await t('game.reportList refuses a type it does not know rather than listing trade reports (the cleanreports bug)', async () => {
    const { g, sent } = wireGame();
    await assert.rejects(g.reportList('armies', 1, 50), /unknown report type "armies"/);
    assert.deepStrictEqual(sent, []);
    await g.reportList('army', 2, 50);
    assert.deepStrictEqual(sent.map((s) => [s.cmd, s.data]), [['report.receiveReportList', { pageNo: 2, pageSize: 50, reportType: 1 }]]);
  });

  // ============================================================ spamheroes
  section('spamheroes: the heroes the script\'s spam attacks use');

  const hero = (o) => Object.assign({
    id: 0, name: '?', level: 1, status: 0, power: 0, powerAdded: 0, management: 0, managementAdded: 0,
    stratagem: 0, stratagemAdded: 0, loyalty: 100, experience: 0, remainPoint: 0,
  }, o);
  const ROSTER = [
    hero({ id: 1, name: 'Atlas', level: 120, power: 200, management: 40, stratagem: 30 }),              // base 80
    hero({ id: 2, name: 'Polly', level: 6, status: 1, management: 40, power: 10 }),                    // the mayor
    hero({ id: 3, name: 'Junk1', level: 5, power: 25, management: 12, stratagem: 14 }),                // base 20
    hero({ id: 4, name: 'Junk2', level: 3, power: 15, management: 10, stratagem: 11 }),                // base 12
    hero({ id: 5, name: 'Rider', level: 4, status: 3, power: 18 }),                                    // marching
    hero({ id: 6, name: 'OTTO', level: 10, power: 30 }),                                               // base 20
    hero({ id: 7, name: 'Sulky', level: 2, power: 20, loyalty: 80 }),                                  // base 18
  ];
  const town = (heros = ROSTER) => ({ castleId: 77, name: 'Testville', heros, buildings: [] });
  const names = (list) => list.map((h) => h.name);
  const running = (src) => parseGoals(src);

  await t('no spamheroes line: NEAT\'s default any:base<=69,level<50, idle heroes only (never the mayor or one away)', async () => {
    assert.deepStrictEqual(names(H.spamHeroes(town(), running(''))), ['Junk1', 'Junk2', 'OTTO', 'Sulky']);
    assert.deepStrictEqual(names(H.spamHeroes(town(), null)), ['Junk1', 'Junk2', 'OTTO', 'Sulky']);
    assert.deepStrictEqual(names(H.spamHeroes(town(), [])), ['Junk1', 'Junk2', 'OTTO', 'Sulky']);
  });

  await t('lines add up in order; a hero string with names, filters and exclusions', async () => {
    assert.deepStrictEqual(names(H.spamHeroes(town(), running('spamheroes Atlas'))), ['Atlas']);
    assert.deepStrictEqual(names(H.spamHeroes(town(), running('spamheroes Atlas\nspamheroes junk*'))), ['Atlas', 'Junk1', 'Junk2']);
    assert.deepStrictEqual(names(H.spamHeroes(town(), running('spamheroes !Junk1,any:level<10'))), ['Junk2', 'Sulky'], 'OTTO is level 10');
    assert.deepStrictEqual(names(H.spamHeroes(town(), running('spamheroes Rider,Polly'))), [], 'a busy hero or the mayor is never offered');
  });

  await t('/reset clears every line before it; with nothing after it the default applies again', async () => {
    assert.deepStrictEqual(names(H.spamHeroes(town(), running('spamheroes Atlas\nspamheroes /reset'))), ['Junk1', 'Junk2', 'OTTO', 'Sulky']);
    assert.deepStrictEqual(names(H.spamHeroes(town(), running('spamheroes Atlas\nspamheroes /reset\nspamheroes Junk2'))), ['Junk2']);
  });

  await t('a script\'s spamheroes /reset (the script goal layer) clears the saved goals\' lines until the layer is cleared', async () => {
    const api = { layers: () => ({ prepend: null, city: 'spamheroes Atlas', append: null }) };
    const now = () => L.runningGoals(api, 'acct-18', 77, 'Testville');
    assert.deepStrictEqual(names(H.spamHeroes(town(), now())), ['Atlas']);
    const r = L.addScriptLine('acct-18', 77, 'spamheroes /reset');
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(names(H.spamHeroes(town(), now())), ['Junk1', 'Junk2', 'OTTO', 'Sulky'], 'the default, as after a reset');
    L.addScriptLine('acct-18', 77, 'spamheroes Junk1');
    assert.deepStrictEqual(names(H.spamHeroes(town(), now())), ['Junk1']);
    L.clearScriptLayer('acct-18', 77);
    assert.deepStrictEqual(names(H.spamHeroes(town(), now())), ['Atlas'], 'the saved goals again');
  });

  await t('never the traininghero or keepatthome\'s hero; spamHeroPool says why', async () => {
    const pool = H.spamHeroPool(town(), running('spamheroes any\ntraininghero OTTO 30 60\nconfig keepatthome:1'));
    assert.deepStrictEqual(names(pool.heroes), ['Junk1', 'Junk2', 'Sulky']);
    assert.deepStrictEqual(pool.held.map((x) => [x.hero.name, x.why]), [['Atlas', 'kept home by keepatthome'], ['OTTO', 'the traininghero']]);
    // just the goals array: no config, so keepatthome cannot be read
    assert.deepStrictEqual(names(H.spamHeroes(town(), running('spamheroes any\ntraininghero OTTO').goals)), ['Atlas', 'Junk1', 'Junk2', 'Sulky']);
  });

  await t('minLoyalty: SpamAttack sends only heroes at 100 loyalty', async () => {
    assert.deepStrictEqual(names(H.spamHeroes(town(), running(''), { minLoyalty: 100 })), ['Junk1', 'Junk2', 'OTTO']);
    const pool = H.spamHeroPool(town(), running(''), { minLoyalty: 100 });
    assert.deepStrictEqual(pool.held.map((x) => [x.hero.name, x.why]), [['Sulky', 'loyalty 80 (under 100)']]);
  });

  await t('the plans\' (ctx) form still works', async () => {
    const p = running('spamheroes any:base<=69,level<50');
    assert.deepStrictEqual(names(H.spamHeroes({ castle: town(), goals: p.goals, config: p.config })), ['Junk1', 'Junk2', 'OTTO', 'Sulky']);
  });

  await t('the line is blue now, and its plan names the spam heroes (and what it leaves out)', async () => {
    assert.ok(!('spamheroes' in G.NOT_IMPLEMENTED.goals));
    assert.deepStrictEqual(parseGoals('spamheroes any').lines[0], { n: 1, status: 'ok', msg: null });
    const plan = (src) => { const p = running(src); return H.plans.spamheroes({ castle: town(), goals: p.goals, config: p.config }); };
    assert.strictEqual(plan('troop a:1k'), null, 'no line, no note');
    const n1 = plan('spamheroes junk*\ntraininghero OTTO').note;
    assert.strictEqual(n1, 'spamheroes junk*: spam heroes here: Junk1, Junk2');
    const n2 = plan('spamheroes any\ntraininghero OTTO').note;
    has(n2, 'spam heroes here: Atlas, Junk1, Junk2, Sulky; not used: OTTO (the traininghero)');
    has(plan('spamheroes Atlas\nspamheroes /reset').note, "spamheroes reset, so NEAT's default any:base<=69,level<50: spam heroes here: Junk1, Junk2, OTTO, Sulky");
    has(plan('spamheroes Rider').note, 'no idle hero here fits');
  });

  // ========================================================= castle buffs
  section('castle buffs: server.CastleBuffUpdate');

  const buffGame = () => {
    const g = new Game(() => {});
    g.castles = [{ castleId: 11, name: 'Home', buffs: [{ typeId: 'ForceopenclosegateBuff', descName: 'gate', endTime: 5 }] },
      { castleId: 22, name: 'Other' }];
    return g;
  };
  const push = (g, updateType, buffBean, castleid = 11) => g.applyCastleBuffUpdate({ castleid, updateType, buffBean });

  await t('0 adds a buff to the city named by castleid (lowercase), 2 updates it, 1 removes it', async () => {
    const g = buffGame();
    push(g, 0, { typeId: 'IncArmyActionTimeBuff', descName: 'slower marches', endTime: 100 });
    assert.deepStrictEqual(g.castles[0].buffs.map((b) => [b.typeId, b.endTime]), [['ForceopenclosegateBuff', 5], ['IncArmyActionTimeBuff', 100]]);
    push(g, 2, { typeId: 'IncArmyActionTimeBuff', descName: 'still slower', endTime: 200 });
    assert.deepStrictEqual(g.castles[0].buffs[1], { typeId: 'IncArmyActionTimeBuff', descName: 'still slower', endTime: 200 });
    push(g, 1, { typeId: 'ForceopenclosegateBuff' });
    assert.deepStrictEqual(g.castles[0].buffs.map((b) => b.typeId), ['IncArmyActionTimeBuff']);
    assert.strictEqual(g.castles[1].buffs, undefined, 'the other city is untouched');
  });

  await t('an add of a buff already held updates the one copy; 2 for one not held adds it; a city with no list gets one', async () => {
    const g = buffGame();
    push(g, 0, { typeId: 'ForceopenclosegateBuff', descName: 'gate', endTime: 9 });
    assert.deepStrictEqual(g.castles[0].buffs, [{ typeId: 'ForceopenclosegateBuff', descName: 'gate', endTime: 9 }]);
    push(g, 2, { typeId: 'PeaceBuff', endTime: 3 }, 22);
    assert.deepStrictEqual(g.castles[1].buffs, [{ typeId: 'PeaceBuff', endTime: 3 }]);
  });

  await t('ignored: an unknown city, no buffBean or no typeId, and any other update type for a buff not held', async () => {
    const g = buffGame();
    const before = JSON.stringify(g.castles);
    push(g, 0, { typeId: 'X', endTime: 1 }, 999);
    g.applyCastleBuffUpdate({ castleid: 11, updateType: 0 });
    g.applyCastleBuffUpdate({ castleid: 11, updateType: 0, buffBean: { endTime: 1 } });
    g.applyCastleBuffUpdate(null);
    push(g, 3, { typeId: 'NotHeld', endTime: 1 });
    push(g, 1, { typeId: 'NotHeld' });
    assert.strictEqual(JSON.stringify(g.castles), before);
    push(g, 3, { typeId: 'ForceopenclosegateBuff', endTime: 7 });
    assert.strictEqual(g.castles[0].buffs[0].endTime, 7, 'another type still updates one that is held');
  });

  await t('castleId (camelCase) is read too, and the castle may be keyed by id', async () => {
    const g = new Game(() => {});
    g.castles = [{ id: 31, name: 'ById' }];
    g.applyCastleBuffUpdate({ castleId: 31, updateType: 0, buffBean: { typeId: 'A', endTime: 1 } });
    assert.deepStrictEqual(g.castles[0].buffs, [{ typeId: 'A', endTime: 1 }]);
  });

  await t('the timed-march speed reads the live list: a slowing buff pushed after login slows the march', async () => {
    const g = buffGame();
    const now = Date.now();
    const time = () => C.marchTimeMs({ x: 0, y: 0 }, { x: 10, y: 0 }, ['archer'], { marchSkill: 0, now, castleBuffs: g.castles[0].buffs });
    const before = time();
    push(g, 0, { typeId: 'IncArmyActionTimeBuff', endTime: now + 3600000 });
    assert.ok(time() > before, `${time()} should be slower than ${before}`);
    push(g, 1, { typeId: 'IncArmyActionTimeBuff' });
    assert.strictEqual(time(), before);
  });

  await t('Game.connect wires server.CastleBuffUpdate (and still PlayerBuffUpdate) to the lists it keeps', async () => {
    const P = EvonyClient.prototype;
    const saved = { connect: P.connect, login: P.login, send: P.send, await: P.await };
    const sent = [];
    P.connect = async function () {};
    P.login = async function () {
      return { data: { ok: 1, player: { playerInfo: { userName: 'Lord' }, castles: [{ id: 11, castleId: 11, name: 'Home', buffs: [] }], buffs: [] } } };
    };
    P.send = function (cmd, data) { sent.push(cmd); };
    P.await = async function (want) { return { cmd: want[0], data: { ok: 1 } }; };
    try {
      const g = new Game(() => {});
      await g.connect('ss0', 'lord@example.invalid', 'offline');
      g.c.emit('cmd', 'server.CastleBuffUpdate', { castleid: 11, updateType: 0, buffBean: { typeId: 'ForceopenclosegateBuff', endTime: 77 } });
      assert.deepStrictEqual(g.castles[0].buffs, [{ typeId: 'ForceopenclosegateBuff', endTime: 77 }]);
      g.c.emit('cmd', 'server.CastleBuffUpdate', { castleid: 11, updateType: 1, buffBean: { typeId: 'ForceopenclosegateBuff' } });
      assert.deepStrictEqual(g.castles[0].buffs, []);
      g.c.emit('cmd', 'server.PlayerBuffUpdate', { updateType: 0, buffBean: { typeId: 'PlayerPeaceBuff', endTime: 5 } });
      assert.deepStrictEqual(g.player.buffs.map((b) => b.typeId), ['PlayerPeaceBuff']);
      assert.ok(!sent.some((c) => /^report\.|setAllowAlliance/.test(c)), sent.join(','));
    } finally { Object.assign(P, saved); }
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
