'use strict';
// The completequests goal (goal-quests.js): the fleet claims every finished
// quest on its own, the free daily amulet among them. Offline — a fake game
// that answers quest.getQuestType / getQuestList / award from fixtures, a real
// Engine over a fake server for the wiring, a throwaway database. Nothing here
// connects, logs in or sends a byte.
//
//   node test-goal-quests.js
const assert = require('assert');
const path = require('path'), os = require('os'), fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-quests-'));
if (!process.env.EVONY_DB) process.env.EVONY_DB = path.join(TMP, 't.db');

// Nothing may open a connection.
const net = require('net'), tls = require('tls'), http = require('http'), https = require('https');
const refuse = (what) => () => { throw new Error(`${what} is blocked in this test — it must not open a connection`); };
net.connect = net.createConnection = refuse('net.connect');
tls.connect = refuse('tls.connect');
http.get = http.request = refuse('http.request');
https.get = https.request = refuse('https.request');
globalThis.fetch = refuse('fetch');

// game.js takes getServerConfig when it loads, so the stub goes in first.
const EV = require('./evony');
EV.getServerConfig = async () => ({ host: 'offline.invalid', port: 1, state: 'test' });

const C = require('./constants');
const Q = require('./goal-quests');
const { parseGoals, CONFIG_KEYS } = require('./goals');
const { Game } = require('./game');
const { Engine } = require('./engine');
const { EvonyClient } = EV;
const I = Q._internals;

// Declared here, run one after another at the end: a claim loop is async, and
// two of them running at once would read each other's fixtures.
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const section = (s) => tests.push([s, null]);
const has = (s, sub) => assert.ok(String(s).includes(sub), `"${s}" does not contain "${sub}"`);

// ------------------------------------------------------------------ fixtures
const castle = { castleId: 11, id: 11, name: 'Home' };

// The two tabs, as the server answers them: quest types with isFinish, and a
// list of QuestBeans per type.
function fakeGame(tabs, { award = () => ({ ok: 1 }) } = {}) {
  const g = {
    sent: [],
    castleId: (c) => c.castleId,
    async questTypes(castleId, type) {
      g.sent.push(['quest.getQuestType', { castleId, type }]);
      const tab = Object.values(tabs).find((x) => x.type === type);
      if (!tab) return { ok: 0, errorMsg: 'no such tab' };
      if (tab.refuse) return { ok: 0, errorMsg: tab.refuse };
      return { ok: 1, types: tab.types.map((ty) => ({ typeId: ty.typeId, name: ty.name, isFinish: ty.quests.some((q) => q.isFinish) })) };
    },
    async questList(castleId, typeId) {
      g.sent.push(['quest.getQuestList', { castleId, typeId }]);
      const ty = Object.values(tabs).flatMap((x) => x.types).find((x) => x.typeId === typeId);
      if (!ty) return { ok: 0, errorMsg: 'no such type' };
      if (ty.refuse) return { ok: 0, errorMsg: ty.refuse };
      return { ok: 1, quests: ty.quests.map((q) => ({ ...q })) };
    },
    async questAward(castleId, questId) {
      g.sent.push(['quest.award', { castleId, questId }]);
      const r = award(questId);
      if (r.ok === 1) {
        for (const tab of Object.values(tabs)) {
          for (const ty of tab.types) ty.quests = ty.quests.filter((q) => q.questId !== questId);
        }
      }
      return r;
    },
  };
  return g;
}
const quest = (questId, name, isFinish = true, over = {}) => ({ questId, name, isFinish, award: 'an amulet', ...over });
const tabsWith = ({ routine = [], daily = [] } = {}) => ({
  routine: { type: 1, types: routine },
  daily: { type: 3, types: daily },
});
const type = (typeId, name, quests) => ({ typeId, name, quests });

const DAILY_AMULET = () => tabsWith({
  daily: [type(31, 'Daily Quest', [quest(901, 'Free Amulet'), quest(902, 'Login', false)])],
});

const run = (g, state = {}, mode = 3) => Q.executors.completeQuests(g, castle, { kind: 'completeQuests', mode }, state);

// ------------------------------------------------------------------- the key
section('config completequests: ours, and on by default');

t('the tabs and the promotion names come from constants.js, shared with the script command', () => {
  assert.deepStrictEqual(C.QUEST_MODES, { routine: 1, daily: 3 });
  assert.strictEqual(C.QUEST_TITLES[0], 'Knight');
  assert.strictEqual(C.QUEST_TITLES[C.QUEST_TITLES.length - 1], 'Prinzessin');
  assert.deepStrictEqual(C.QUEST_RANKS, ['Lieutenant', 'Captain', 'Major', 'Colonel', 'General']);
  // the script command reads the same tables (script-cmd-account.js)
  const src = fs.readFileSync(path.join(__dirname, 'script-cmd-account.js'), 'utf8');
  has(src, 'const QUEST_MODES = C.QUEST_MODES;');
  has(src, 'const TITLES = C.QUEST_TITLES;');
  has(src, 'const RANKS = C.QUEST_RANKS;');
});

t('the goal parser knows the key, and the four values', () => {
  assert.ok(CONFIG_KEYS.has('completequests'));
  for (const v of [0, 1, 2, 3]) {
    const p = parseGoals(`config completequests:${v}`);
    assert.deepStrictEqual(p.errors, [], `completequests:${v} should parse`);
    assert.strictEqual(p.config.completequests, v);
  }
});

t('a value that is no mode is an error, not a silent default', () => {
  for (const bad of ['4', '-1', 'yes', '1.5', '']) {
    const p = parseGoals(`config completequests:${bad}`);
    assert.strictEqual(p.errors.length, 1, `completequests:${bad} should be refused`);
    has(p.errors[0].error, 'completequests is 0 (claim nothing)');
  }
});

t('written as a line of its own it reads as the config key it means', () => {
  const p = parseGoals('completequests 1');
  assert.deepStrictEqual(p.errors, []);
  assert.strictEqual(p.config.completequests, 1);
});

t('no key at all means 3: everything, a title before a rank', () => {
  assert.strictEqual(I.DEFAULT_MODE, 3);
  assert.strictEqual(I.modeOf({}), 3);
  assert.strictEqual(I.modeOf(undefined), 3);
  assert.strictEqual(I.modeOf({ completequests: '' }), 3);
  assert.strictEqual(I.modeOf({ completequests: 'rubbish' }), 3);
  assert.strictEqual(I.modeOf({ completequests: 0 }), 0);
  assert.strictEqual(I.modeOf({ completequests: 1 }), 1);
});

t('completequests is still a script command, so a script line is never read as this goal', () => {
  // script-cmd-goals.js: "Where a goal and a command share a name the command wins"
  const src = fs.readFileSync(path.join(__dirname, 'script-cmd-goals.js'), 'utf8');
  has(src, 'completequests');
  has(src, 'the command wins');
});

// ------------------------------------------------------------------ the plan
section('the plan: when a city looks, and what its note says');

t('with no goal line at all the city still plans a look', () => {
  const p = Q.plans.completequests({ config: {} }, {});
  assert.strictEqual(p.actions.length, 1);
  assert.strictEqual(p.actions[0].kind, 'completeQuests');
  assert.strictEqual(p.actions[0].mode, 3);
  has(p.note, 'the daily amulet');
});

t('config completequests:0 claims nothing and says so', () => {
  const p = Q.plans.completequests({ config: { completequests: 0 } }, {});
  assert.deepStrictEqual(p.actions, []);
  has(p.note, 'config completequests:0');
});

t('a look that is not due yet plans nothing, and the note says when and what last happened', () => {
  const state = { quests: { claimed: 4, nextAt: Date.now() + 12 * 60000, last: { at: Date.now(), claimed: 1, names: ['Free Amulet (Daily Quest)'] } } };
  const p = Q.plans.completequests({ config: {} }, state);
  assert.deepStrictEqual(p.actions, []);
  has(p.note, '4 claimed so far');
  has(p.note, 'Free Amulet (Daily Quest)');
  has(p.note, 'next look in 12 min');
});

t('a look that is due again plans one action, whatever the mode', () => {
  for (const [mode, text] of [[1, 'everything but the promotions'], [2, 'everything'], [3, 'a title before a rank']]) {
    const p = Q.plans.completequests({ config: { completequests: mode } }, { quests: { nextAt: Date.now() - 1000 } });
    assert.strictEqual(p.actions.length, 1, `mode ${mode}`);
    has(p.note, text);
  }
});

// -------------------------------------------------------------- the executor
section('claiming: the free daily amulet, and the rest');

t('a quiet account costs exactly two requests: one per tab, nothing listed', async () => {
  const g = fakeGame(tabsWith({
    routine: [type(1, 'Rebuild', [quest(1, 'Population Increase', false)])],
    daily: [type(31, 'Daily Quest', [quest(901, 'Free Amulet', false)])],
  }));
  const state = {};
  const r = await run(g, state);
  assert.strictEqual(r.ok, 1);
  assert.deepStrictEqual(g.sent.map((x) => x[0]), ['quest.getQuestType', 'quest.getQuestType']);
  assert.strictEqual(state.quests.claimed, 0);
  assert.ok(state.quests.nextAt - Date.now() > I.QUEST_IDLE_MS - 5000, 'a quiet look waits the idle time');
});

t('the free daily amulet is claimed, from the Daily tab', async () => {
  const g = fakeGame(DAILY_AMULET());
  const state = {};
  const r = await run(g, state);
  assert.strictEqual(r.ok, 1);
  has(r.msg, 'Free Amulet');
  const award = g.sent.filter((x) => x[0] === 'quest.award');
  assert.deepStrictEqual(award, [['quest.award', { castleId: 11, questId: 901 }]]);
  assert.strictEqual(state.quests.claimed, 1);
  // something was claimed: look again soon, a claim can open the next quest
  assert.ok(state.quests.nextAt - Date.now() <= I.QUEST_BUSY_MS + 1000);
});

t('the tabs are asked with the type the client uses: Routine 1, Daily 3', async () => {
  const g = fakeGame(DAILY_AMULET());
  await run(g);
  assert.deepStrictEqual(g.sent.filter((x) => x[0] === 'quest.getQuestType').map((x) => x[1].type), [1, 3]);
});

t('a quest that is not finished is never claimed', async () => {
  const g = fakeGame(DAILY_AMULET());
  await run(g);
  assert.ok(!g.sent.some((x) => x[0] === 'quest.award' && x[1].questId === 902), 'the unfinished Login quest was claimed');
});

t('a chain: the list is read again after each claim, so a quest a claim opens is taken too', async () => {
  const tabs = tabsWith({ routine: [type(2, 'Rebuild', [quest(1, 'Farming')])] });
  let opened = false;
  const g = fakeGame(tabs, {
    award: (questId) => {
      if (questId === 1 && !opened) { opened = true; tabs.routine.types[0].quests.push(quest(2, 'Farming II')); }
      return { ok: 1 };
    },
  });
  const state = {};
  await run(g, state);
  assert.deepStrictEqual(g.sent.filter((x) => x[0] === 'quest.award').map((x) => x[1].questId), [1, 2]);
  assert.strictEqual(state.quests.claimed, 2);
});

t('one run claims at most MAX_CLAIMS, so a slice never turns into a session', async () => {
  const many = Array.from({ length: I.MAX_CLAIMS + 5 }, (_, i) => quest(100 + i, `Quest ${i}`));
  const g = fakeGame(tabsWith({ routine: [type(2, 'Rebuild', many)] }));
  const state = {};
  await run(g, state);
  assert.strictEqual(state.quests.claimed, I.MAX_CLAIMS);
});

section('promotions: the four modes');

const PROMO = () => tabsWith({
  routine: [type(9, 'Promotion', [quest(41, 'Major'), quest(42, 'Baronet'), quest(43, 'Colonel', false)])],
});

t('mode 3 (the default) takes the title before the rank — Baronet before Major', async () => {
  const g = fakeGame(PROMO());
  await run(g, {}, 3);
  assert.deepStrictEqual(g.sent.filter((x) => x[0] === 'quest.award').map((x) => x[1].questId), [42, 41]);
});

t('mode 2 takes them in the order the game lists them', async () => {
  const g = fakeGame(PROMO());
  await run(g, {}, 2);
  assert.deepStrictEqual(g.sent.filter((x) => x[0] === 'quest.award').map((x) => x[1].questId), [41, 42]);
});

t('mode 1 claims everything but the promotions', async () => {
  const tabs = PROMO();
  tabs.daily.types.push(type(31, 'Daily Quest', [quest(901, 'Free Amulet')]));
  const g = fakeGame(tabs);
  const state = {};
  await run(g, state, 1);
  assert.deepStrictEqual(g.sent.filter((x) => x[0] === 'quest.award').map((x) => x[1].questId), [901]);
  assert.strictEqual(state.quests.claimed, 1);
});

t('a Promotion type under another name is still spotted by its quest names', async () => {
  const tabs = tabsWith({ routine: [type(9, 'Beförderung', [quest(41, 'Major'), quest(42, 'Baronet')])] });
  const g = fakeGame(tabs);
  await run(g, {}, 1);
  assert.deepStrictEqual(g.sent.filter((x) => x[0] === 'quest.award'), []);
  assert.ok(I.isPromotionType({ name: 'Promotion' }));
  assert.ok(I.isPromotionType({ name: 'anything' }, [{ name: 'Knight' }, { name: 'General' }]));
  assert.ok(!I.isPromotionType({ name: 'Rebuild' }, [{ name: 'Knight' }, { name: 'Farming' }]));
});

section('when the game says no');

t('a refused claim is recorded, tried once, and does not stop the rest', async () => {
  const tabs = tabsWith({ routine: [type(2, 'Rebuild', [quest(1, 'Farming'), quest(2, 'Population Increase')])] });
  const g = fakeGame(tabs, { award: (id) => (id === 1 ? { ok: 0, errorMsg: 'not yet' } : { ok: 1 }) });
  const state = {};
  const r = await run(g, state);
  assert.strictEqual(r.ok, 1);
  assert.deepStrictEqual(g.sent.filter((x) => x[0] === 'quest.award').map((x) => x[1].questId), [1, 2]);
  assert.strictEqual(state.quests.claimed, 1);
  assert.strictEqual(state.quests.last.refused, 1);
  has(state.quests.last.refusal, 'not yet');
});

t('a tab the server refuses fails the action and backs off, without losing what was claimed', async () => {
  const tabs = DAILY_AMULET();
  tabs.routine.refuse = 'the server is busy';
  const g = fakeGame(tabs);
  const state = {};
  const r = await run(g, state);
  assert.strictEqual(r.ok, 0);
  has(r.errorMsg, 'the routine quest types came back the server is busy');
  has(r.errorMsg, 'trying again in 10 min');
  assert.ok(state.quests.nextAt - Date.now() > I.QUEST_RETRY_MS - 5000);
  has(state.quests.last.error, 'the server is busy');
});

t('a list the server refuses is the same: it backs off, it does not spin', async () => {
  const tabs = DAILY_AMULET();
  tabs.daily.types[0].refuse = 'no';
  const g = fakeGame(tabs);
  const state = {};
  const r = await run(g, state);
  assert.strictEqual(r.ok, 0);
  has(r.errorMsg, 'would not list');
  assert.strictEqual(state.quests.claimed, 0);
});

section('the wiring: the engine plans and runs it');

t('goal-quests is one of the engine modules, and its executor is registered', () => {
  const engineSrc = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8');
  has(engineSrc, "'./goal-quests'");
  const goalsSrc = fs.readFileSync(path.join(__dirname, 'goals.js'), 'utf8');
  has(goalsSrc, "'./goal-quests'");
});

// A real Game over a real EvonyClient whose socket calls are captured, and a
// real Engine over it (the pattern test-misc-goals.js uses).
function wireGame(replies = {}) {
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
  g.castles = [{
    castleId: 11, id: 11, name: 'Home', fieldId: C.coordsToFieldId(100, 100),
    resource: { support: 100, food: { amount: 1e9 } }, troop: {}, fortification: {},
    heros: [], buildings: [], allowAlliance: false, goOutForBattle: false,
  }];
  g.player = { playerInfo: { userName: 'Lord' }, items: [], buffs: [], selfArmys: [], enemyArmys: [] };
  const e = new Engine(g, () => {});
  e.dryRun = false;
  e.state = {};
  e.goalsFor = () => parseGoals(replies.goals === undefined ? 'config comfort:1' : replies.goals);
  return { g, e, sent };
}
const QUEST_REPLIES = {
  'quest.getQuestType': (d) => (d.type === 3
    ? { ok: 1, types: [{ typeId: 31, name: 'Daily Quest', isFinish: true }] }
    : { ok: 1, types: [{ typeId: 1, name: 'Rebuild', isFinish: false }] }),
  'quest.getQuestList': () => ({ ok: 1, quests: [{ questId: 901, name: 'Free Amulet', isFinish: true, award: 'Amulet x1' }] }),
  'quest.award': { ok: 1 },
};

t('a city with goals claims the daily amulet in its first slice, and says so in the plan', async () => {
  const { g, e, sent } = wireGame({ ...QUEST_REPLIES });
  const r = await e.focus(g.castles[0]);
  const quest = sent.filter((s) => /^quest\./.test(s.cmd));
  assert.deepStrictEqual(quest.map((s) => s.cmd), ['quest.getQuestType', 'quest.getQuestType', 'quest.getQuestList', 'quest.award', 'quest.getQuestList']);
  assert.deepStrictEqual(quest.find((s) => s.cmd === 'quest.award').data, { castleId: 11, questId: 901 });
  assert.ok(r.acted.some((a) => /completequests: claim every finished quest here .* -> ok/.test(a)), r.acted.join(' | '));
  has(r.completequests.note, 'the daily amulet');
  // claimed: it looks again soon rather than waiting out the idle time
  const st = e.state['11'].quests;
  assert.strictEqual(st.claimed, 1);
  assert.ok(st.nextAt - Date.now() <= I.QUEST_BUSY_MS + 1000);
});

t('the next slice sends nothing: the look is not due again yet', async () => {
  const { g, e, sent } = wireGame({ ...QUEST_REPLIES });
  await e.focus(g.castles[0]);
  const before = sent.filter((s) => /^quest\./.test(s.cmd)).length;
  const r = await e.focus(g.castles[0]);
  assert.strictEqual(sent.filter((s) => /^quest\./.test(s.cmd)).length, before);
  has(r.completequests.note, 'next look in');
});

t('config completequests:0 sends nothing at all', async () => {
  const { g, e, sent } = wireGame({ ...QUEST_REPLIES, goals: 'config comfort:1,completequests:0' });
  const r = await e.focus(g.castles[0]);
  assert.deepStrictEqual(sent.filter((s) => /^quest\./.test(s.cmd)), []);
  has(r.completequests.note, 'config completequests:0');
});

t('a dry run plans the claim and sends nothing', async () => {
  const { g, e, sent } = wireGame({ ...QUEST_REPLIES });
  e.dryRun = true;
  const r = await e.focus(g.castles[0]);
  assert.deepStrictEqual(sent.filter((s) => /^quest\./.test(s.cmd)), []);
  assert.ok(r.acted.some((a) => /^\[plan\] completequests: claim every finished quest here/.test(a)), r.acted.join(' | '));
});

t('Game sends the three quest commands the client sends, each in its own lane', async () => {
  const lanes = [];
  const g = Object.create(Game.prototype);
  g.lane = (cmd, fn) => { lanes.push(cmd); return fn(); };
  const sent = [];
  g.req = async (cmd, data) => { sent.push([cmd, data]); return { ok: 1 }; };
  await g.questTypes(11, 3);
  await g.questList(11, 31);
  await g.questAward(11, 901);
  assert.deepStrictEqual(sent, [
    ['quest.getQuestType', { castleId: 11, type: 3 }],
    ['quest.getQuestList', { castleId: 11, typeId: 31 }],
    ['quest.award', { castleId: 11, questId: 901 }],
  ]);
  assert.deepStrictEqual(lanes, ['quest.getQuestType', 'quest.getQuestList', 'quest.award']);
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    if (!fn) { console.log(`\n--- ${name} ---`); continue; }
    try { await fn(); console.log('  ok    ' + name); pass++; }
    catch (e) { console.log('  FAIL  ' + name + '\n        ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n        ') : e)); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* the temp db is a temp file */ }
  process.exit(fail ? 1 : 0);
})();
