'use strict';
// Step 15: NPC farming at NEAT parity. Every rule below is a NEAT wiki page
// (Npc, NpcList, NpcBounds, FarmingPolicy, DistancePolicy, FarmingCycle,
// FarmingCycleMin, SmartFarming, NpcLimit(s), NpcTroops, NpcHeroes, Training,
// Training10, TrainInt, TrainPol, CategoryNpcGoals, FAQ) or the console's own
// background map scan. Offline: fixture objects, a fake socket and a throwaway
// database — nothing here connects, logs in or sends a byte to the game.
//
//   node test-npc-parity.js
const assert = require('assert');
const path = require('path'), os = require('os'), fs = require('fs');
const { EventEmitter } = require('events');
if (!process.env.EVONY_DB) process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-npcparity-')), 't.db');

const C = require('./constants');
const D = require('./db');
const G = require('./goals');
const NPC = require('./goal-npc');
const M = require('./goalmods');
const { Engine } = require('./engine');
const { Game } = require('./game');
const { Session } = require('./session');

const I = NPC._internals;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok    ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); fail++; }
}
const section = (s) => console.log(`\n${s}\n`);
const eq = assert.deepStrictEqual;
const has = (s, sub) => assert.ok(String(s).includes(sub), `"${s}" does not contain "${sub}"`);
const hasNot = (s, sub) => assert.ok(!String(s).includes(sub), `"${s}" should not contain "${sub}"`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H1 = 3600000;

// ------------------------------------------------------------------ fixtures
const HOME = { x: 100, y: 100 };
const FULL = { at: Date.now(), levels: { 9: 10, 13: 10, 14: 10 } };     // MT, HBR, Archery
const techs = (mt, ho, ar) => ({ at: Date.now(), levels: { 9: mt, 13: ho, 14: ar } });

function cacheOf(list) {
  const castles = {};
  for (const [level, x, y] of list) {
    const id = C.coordsToFieldId(x, y);
    castles[id] = { id, x, y, level, kind: 'npc', npc: true, name: "Barbarian's city", seen: Date.now() };
  }
  return { updatedAt: Date.now(), castles };
}
const hero = (id, name, power, extra = {}) => ({ id, name, power, powerAdded: 0, management: 10, stratagem: 10, level: 20, loyalty: 100, status: 0, ...extra });
const crew = () => [hero(1, 'Strong', 150), hero(2, 'Brawler', 140), hero(3, 'Scrapper', 110), hero(4, 'Middling', 80),
  hero(5, 'Rookie', 60), hero(6, 'Mayor', 200, { status: 1 })];

function city(over = {}) {
  return {
    castleId: 7, id: 7, name: 'Testville', fieldId: C.coordsToFieldId(HOME.x, HOME.y),
    troop: { ballista: 20000, carriage: 20000, archer: 1000000, scouter: 100000, militia: 50000, peasants: 50000 },
    heros: crew(),
    resource: { food: { amount: 200e6 } },
    buildings: [{ typeId: 29, level: 10, positionId: 3 }],
    ...over,
  };
}
const fakeGame = (castle) => ({
  castles: [castle], player: { selfArmys: [] }, marchSkillParam: 100, loadSkillParam: 100,
  castleId: (c) => c.castleId, castleXY: (c) => C.fieldIdToCoords(c.fieldId),
});

// A plan the way the engine makes one: the real goal parser, research known.
function plan(src, over = {}) {
  const parsed = G.parseGoals(src);
  const castle = over.castle || city();
  const ctx = {
    castle, goals: parsed.goals, config: parsed.config, mapCache: over.cache, now: over.now,
    techs: over.techs === undefined ? FULL : over.techs, ...over.ctx,
  };
  const state = over.state || {};
  const game = over.game || fakeGame(castle);
  return { plan: NPC.plans.npc(ctx, state, game), state, ctx, parsed, castle };
}
const targets = (p) => p.actions.map((a) => `${a.target.x},${a.target.y}`);
const ctxOf = (src) => { const p = G.parseGoals(src); return { goals: p.goals, config: p.config }; };
const inRange = (src, cache, level = 5, home = HOME) => I.targetsFor(ctxOf(src), I.digestCache(cache), home, level).map((c) => `${c.x},${c.y}`);

(async () => {
  // ======================================================== which camps
  section('which camps: the first rule that is set wins (CategoryNpcGoals)');

  // L5 camps at 1, 5, 12, 25 and 40 tiles
  const RING = cacheOf([[5, 101, 100], [5, 100, 105], [5, 112, 100], [5, 100, 125], [5, 140, 100], [4, 100, 128]]);

  await t('nothing set: a 10-mile radius (it used to be 20)', () => {
    eq(inRange('config npc:5', RING), ['101,100', '100,105']);
    eq(I.rangeFor(ctxOf('config npc:5'), 5).why, 'within 10 tiles (default)');
  });

  await t('distancepolicy beats the default', () => {
    eq(inRange('config npc:5\ndistancepolicy 15', RING), ['101,100', '100,105', '112,100']);
  });

  await t('farmingpolicy /mindistance /maxdistance beat distancepolicy', () => {
    eq(inRange('config npc:5\ndistancepolicy 15\nfarmingpolicy 5 /maxdistance:30', RING), ['101,100', '100,105', '112,100', '100,125']);
    eq(inRange('config npc:5\ndistancepolicy 15\nfarmingpolicy 5 /mindistance:4 /maxdistance:30', RING), ['100,105', '112,100', '100,125']);
  });

  await t('a band with one end takes the next rule for the other; /distance is our /maxdistance', () => {
    eq(inRange('config npc:5\ndistancepolicy 15\nfarmingpolicy 5 /mindistance:4', RING), ['100,105', '112,100'], 'max from distancepolicy');
    eq(inRange('config npc:5\nfarmingpolicy 5 /mindistance:4', RING), ['100,105'], 'max from the 10-mile default');
    eq(inRange('config npc:5\nfarmingpolicy 5 /distance:30', RING), inRange('config npc:5\nfarmingpolicy 5 /maxdistance:30', RING));
  });

  await t('npcbounds beats every distance: the whole box, however far', () => {
    eq(inRange('config npc:5\ndistancepolicy 15\nnpcbounds 5 130 150 90 110', RING), ['140,100']);
    eq(inRange('config npc:5\nfarmingpolicy 5 /maxdistance:3\nnpcbounds 130 150 90 110', RING), ['140,100'], 'a box with no level covers every level');
  });

  await t('npclist beats npcbounds; excludelist still applies to it', () => {
    const src = 'config npc:5\nnpcbounds 5 130 150 90 110\nnpclist 5 140,100 100,125';
    eq(inRange(src, RING), ['100,125', '140,100']);
    eq(inRange(`${src}\nexcludelist 140,100`, RING), ['100,125']);
  });

  await t('rules are per level: an npclist for level 4 leaves level 5 on its own rules', () => {
    eq(inRange('config npc:4\nnpclist 4 100,128', RING, 5), ['101,100', '100,105']);
    eq(inRange('config npc:4\nnpclist 4 100,128', RING, 4), ['100,128']);
  });

  await t('a farmingpolicy line with no level covers every level; a line for the level wins', () => {
    eq(inRange('config npc:5\nfarmingpolicy /maxdistance:30', RING), ['101,100', '100,105', '112,100', '100,125']);
    eq(inRange('config npc:5\nfarmingpolicy /maxdistance:30\nfarmingpolicy 5 /maxdistance:3', RING), ['101,100']);
  });

  await t('/level:8 is the level (it used to be read as no level, for every level)', () => {
    const p = G.parseGoals('farmingpolicy /level:8 /mindistance:1 /maxdistance:5 /farmingcycle:1');
    eq(p.errors, []);
    eq([p.goals[0].level, p.goals[0].policy], [8, { minDistance: 1, maxDistance: 5, maxCycle: 1 }]);
    eq(inRange('config npc:4\nfarmingpolicy /level:5 /maxdistance:30', RING, 4), [], 'level 4 keeps the 10-mile default');
    assert.strictEqual(I.cycleFor(ctxOf('farmingpolicy /level:8 /farmingcycle:1'), 5).maxMs, 8.4 * H1);
    assert.strictEqual(I.cycleFor(ctxOf('farmingpolicy /level:8 /farmingcycle:1'), 8).maxMs, H1);
  });

  await t('an npclist camp the cache does not hold at that level is named in the note', () => {
    const { plan: p } = plan('config npc:5\nnpclist 5 101,100 150,150', { cache: RING });
    eq(targets(p), ['101,100']);
    has(p.note, 'L5: 1 npclist camp(s) are not level 5 npcs in the map cache — left out');
  });

  // ======================================================== map wrap
  section('distance goes the short way round the map (it wraps at 800)');

  await t('a camp across the x edge is 8 tiles away, not 792', () => {
    const home = { x: 795, y: 100 };
    const cache = cacheOf([[5, 3, 100], [5, 780, 100], [5, 395, 100]]);
    eq(inRange('config npc:5', cache, 5, home), ['3,100']);
    const castle = city({ fieldId: C.coordsToFieldId(795, 100) });
    const { plan: p } = plan('config npc:5\nnpcteams 1', { cache, castle });
    eq(targets(p), ['3,100']);
    assert.strictEqual(p.actions[0].distance, 8);
    assert.strictEqual(p.actions[0].oneWayMs, 8 * 300000, 'ballistas: 5 minutes a tile at march skill 100, the wrapped distance');
  });

  await t('and across the y edge', () => {
    eq(inRange('config npc:5', cacheOf([[5, 100, 4]]), 5, { x: 100, y: 798 }), ['100,4']);
  });

  await t('npcbounds: an Xmax past 799 carries on from 0', () => {
    const cache = cacheOf([[5, 3, 100], [5, 780, 100], [5, 795, 104]]);
    eq(inRange('config npc:5\nnpcbounds 5 790 810 95 105', cache, 5, { x: 795, y: 100 }), ['795,104', '3,100']);
    assert.ok(I.inBox({ x: 5, y: 0 }, { xMin: 790, xMax: 810, yMin: 0, yMax: 0 }));
    assert.ok(!I.inBox({ x: 15, y: 0 }, { xMin: 790, xMax: 810, yMin: 0, yMax: 0 }));
  });

  await t('npcbounds reads five numbers as level + box and four as a box — never guesses', () => {
    eq(G.parseGoals('npcbounds 5 200 215 400 415').goals[0].level, 5);
    const four = G.parseGoals('npcbounds 1 10 5 20');
    eq(four.errors, []);
    eq([four.goals[0].level, four.goals[0].box], [null, { xMin: 1, xMax: 10, yMin: 5, yMax: 20 }], 'Xmin 1 is not a level');
    has(G.parseGoals('npcbounds 11 1 2 3 4').errors[0].error, 'is not an npc level');
  });

  // ======================================================== distancepolicy
  section('distancepolicy: NEAT\'s five numbers');

  await t('npc farming, npc building, medal/valley farming, valley acquisition, map scanning', () => {
    const p = G.parseGoals('distancepolicy 10 20 5 10 25');
    eq(p.errors, []);
    eq(p.goals[0].distances, { npc: 10, build: 20, valley: 5, acquire: 10, scan: 25 });
    eq(p.goals[0].radius, 10);
    eq(G.parseGoals('distancepolicy 10 20').goals[0].distances, { npc: 10, build: 20 }, 'it used to store 20 under a kind named "10"');
  });

  await t('fractions stay, 150 is the most, 0 and a sixth number are errors', () => {
    eq(G.parseGoals('distancepolicy 10.5').goals[0].distances.npc, 10.5);
    const big = G.parseGoals('distancepolicy 200');
    has(big.errors[0].error, 'past the 150-mile limit');
    eq(big.goals[0].distances.npc, 150);
    has(G.parseGoals('distancepolicy 0').errors[0].error, 'reaches nothing');
    has(G.parseGoals('distancepolicy 1 2 3 4 5 6').errors[0].error, 'at most 5 distances');
    has(G.parseGoals('distancepolicy far').errors.map((e) => e.error).join(' '), 'needs a distance after it');
  });

  await t('the older spellings still read', () => {
    eq(G.parseGoals('distancepolicy npc 9').goals[0].distances, { npc: 9 });
    eq(G.parseGoals('distancepolicy /npc:15 /valley:5').goals[0].distances, { npc: 15, valley: 5 });
    eq(G.parseGoals('distancepolicy /all:12').goals[0].distances, { npc: 12, build: 12, valley: 12, acquire: 12, scan: 12 });
  });

  // ======================================================== cycles
  section('how often: training, farmingpolicy, config, 8.4 h (CategoryNpcGoals)');

  const cyc = (src, level = 5) => { const c = I.cycleFor(ctxOf(src), level); return [c.maxMs / H1, c.minMs == null ? null : c.minMs / H1, c.smart]; };

  await t('8.4 hours by default; config farmingcycle keeps its fraction (0.5 = 30 minutes)', () => {
    eq(cyc('config npc:5'), [8.4, null, false]);
    eq(cyc('config npc:5,farmingcycle:0.5'), [0.5, null, false]);
    eq(cyc('config npc:5,farmingcycle:6.5'), [6.5, null, false]);
  });

  await t('farmingpolicy /farmingcycle, /cycle, /maxcycle and /cyclemax are one switch, fractions kept', () => {
    for (const sw of ['farmingcycle', 'cycle', 'maxcycle', 'cyclemax']) eq(cyc(`farmingpolicy 5 /${sw}:8.4`), [8.4, null, false], sw);
    eq(cyc('config farmingcycle:6\nfarmingpolicy 5 /cycle:0.4'), [0.4, null, false], 'it used to round 0.4 to 0 and ignore it');
    eq(cyc('config farmingcycle:6\nfarmingpolicy 5 /cycle:2', 4), [6, null, false], 'another level keeps config');
  });

  await t('/mincycle (and /cyclemin) turn on the smart choice; the max falls back to config or 8.4', () => {
    eq(cyc('farmingpolicy 5 /mincycle:1'), [8.4, 1, true]);
    eq(cyc('farmingpolicy 5 /cyclemin:1 /cyclemax:4'), [4, 1, true]);
    eq(cyc('config farmingcycle:6\nfarmingpolicy 5 /mincycle:1'), [6, 1, true]);
  });

  await t('config farmingcyclemin is HOURS of the smart choice, for levels 1-5 only', () => {
    eq(cyc('config farmingcyclemin:1'), [8.4, 1, true]);
    eq(cyc('config farmingcyclemin:1,farmingcycle:6'), [6, 1, true]);
    eq(cyc('config farmingcyclemin:1', 8), [8.4, null, false], 'wiki FarmingCycleMin: "only affects level 1-5"');
    eq(cyc('config farmingcyclemin:5,farmingcycle:2'), [2, 2, true], 'a minimum past the maximum is the maximum');
  });

  await t('a level\'s farmingpolicy cycle wins over the config pair', () => {
    eq(cyc('config farmingcyclemin:1,farmingcycle:6\nfarmingpolicy 5 /cycle:4'), [4, null, false]);
  });

  await t('training:1 and :2 make levels 1-9 hourly, training10 level 10 — not each other\'s', () => {
    eq(cyc('config training:1\nfarmingpolicy 5 /cycle:4', 5), [1, null, false]);
    eq(cyc('config training:2', 9), [1, null, false]);
    eq(cyc('config training:1', 10), [8.4, null, false], 'training:1 used to make level 10 hourly too');
    eq(cyc('config training10:1', 10), [1, null, false]);
    eq(cyc('config training10:1', 5), [8.4, null, false]);
  });

  await t('/mincycle on a level above 5 is an error, and does nothing', () => {
    const p = G.parseGoals('farmingpolicy 10 /mincycle:1 /cycle:1');
    has(p.errors[0].error, '/mincycle only affects levels 1-5');
    eq(p.goals[0].policy, { maxCycle: 1 });
  });

  await t('farmingpolicy values that cannot be read are errors, not zeros', () => {
    has(G.parseGoals('farmingpolicy 5 /cycle:soon').errors[0].error, 'needs a number of hours');
    has(G.parseGoals('farmingpolicy 5 /maxdistance:200').errors[0].error, 'past the 150-mile limit');
    has(G.parseGoals('farmingpolicy 5 /level:6').errors[0].error, 'disagree');
    has(G.parseGoals('farmingpolicy 5 /cycle').errors[0].error, 'needs a value');
    has(G.parseGoals('farmingpolicy 5 /mindistance:9 /maxdistance:3').errors[0].error, 'read the other way round');
    eq(G.parseGoals('farmingpolicy 5 /mindistance:9 /maxdistance:3').goals[0].policy, { minDistance: 3, maxDistance: 9 });
  });

  // ======================================================== the per-camp clock
  section('each camp waits its cycle after its own hit');

  await t('a camp hit 8 hours ago waits (8.4 h); one hit 8.5 hours ago goes', () => {
    const cache = cacheOf([[5, 101, 100], [5, 100, 102]]);
    const now = Date.now();
    const A = C.coordsToFieldId(101, 100);
    eq(targets(plan('config npc:5\nnpcteams 1', { cache, now, state: { npc: { hits: { [A]: now - 8 * H1 } } } }).plan), ['100,102']);
    eq(targets(plan('config npc:5\nnpcteams 1', { cache, now, state: { npc: { hits: { [A]: now - 8.5 * H1 } } } }).plan), ['101,100']);
  });

  await t('a camp hit late in one pass is not hit again early in the next (the old pass clock did)', () => {
    const cache = cacheOf([[5, 101, 100], [5, 100, 102]]);
    const now = Date.now();
    const X = C.coordsToFieldId(101, 100), Y = C.coordsToFieldId(100, 102);
    // Y opened the pass 8.5 h ago, X was hit at its end, half an hour ago
    const state = { npc: { hits: { [Y]: now - 8.5 * H1, [X]: now - 0.5 * H1 }, cycles: { 5: { startedAt: now - 8.5 * H1 } } } };
    eq(targets(plan('config npc:5', { cache, now, state }).plan), ['100,102']);
  });

  await t('config farmingcycle:0.5: 31 minutes after the hit it goes, 29 minutes it waits', () => {
    const cache = cacheOf([[5, 101, 100]]);
    const now = Date.now(), A = C.coordsToFieldId(101, 100);
    eq(targets(plan('config npc:5,farmingcycle:0.5,training:0\ndistancepolicy 2', { cache, now, state: { npc: { hits: { [A]: now - 31 * 60000 } } } }).plan), ['101,100']);
    const wait = plan('config npc:5,farmingcycle:0.5\ndistancepolicy 2', { cache, now, state: { npc: { hits: { [A]: now - 29 * 60000 } } } }).plan;
    eq(wait.actions, []);
    has(wait.note, 'pass complete (1 camp(s)), next in 60s');
  });

  // ======================================================== smart farming
  section('the smart choice: FarmingCycleMin, /mincycle and SmartFarming');

  // wiki FarmingCycleMin: "2 npcs at 1 mile away with 50% of their resources
  // regenerated that you hit 4 hours ago, and 1 npc at 6 miles away with 100%"
  const WIKI = cacheOf([[5, 101, 100], [5, 100, 101], [5, 106, 100]]);
  const wikiState = (now) => ({ npc: { hits: { [C.coordsToFieldId(101, 100)]: now - 4.2 * H1, [C.coordsToFieldId(100, 101)]: now - 4.2 * H1 } } });

  await t('standard farming waits for the two near camps and goes to the far full one', () => {
    const now = Date.now();
    eq(targets(plan('config npc:5', { cache: WIKI, now, state: wikiState(now) }).plan), ['106,100']);
  });

  await t('farmingcyclemin:4 hits the two half-full camps at 1 mile before the full one at 6', () => {
    const now = Date.now();
    const { plan: p } = plan('config npc:5,farmingcyclemin:4', { cache: WIKI, now, state: wikiState(now) });
    eq(targets(p), ['101,100', '100,101', '106,100']);
    has(p.actions[0].label, '~50% worth');
    has(p.note, 'L5: within 10 tiles (default), smart, 4.0h to 8.4h between hits (config)');
  });

  await t('...but not before its minimum: farmingcyclemin:5 leaves them (hit 4.2 h ago)', () => {
    const now = Date.now();
    eq(targets(plan('config npc:5,farmingcyclemin:5', { cache: WIKI, now, state: wikiState(now) }).plan), ['106,100']);
  });

  await t('farmingpolicy /mincycle does the same for its level', () => {
    const now = Date.now();
    eq(targets(plan('config npc:5\nfarmingpolicy 5 /mincycle:1', { cache: WIKI, now, state: wikiState(now) }).plan), ['101,100', '100,101', '106,100']);
  });

  await t('smartfarming 2 turns it on with no minimum written (an hour, the troops\' refill); 0 and 1 leave it off', () => {
    const now = Date.now();
    eq(targets(plan('config npc:5,smartfarming:2', { cache: WIKI, now, state: wikiState(now) }).plan), ['101,100', '100,101', '106,100']);
    eq(cyc('config smartfarming:2'), [8.4, 1, true]);
    eq(cyc('config smartfarming:1'), [8.4, null, false]);
    eq(cyc('config smartfarming:3', 8), [8.4, null, false], 'levels 1-5 only, like FarmingCycleMin');
  });

  await t('smartfarming 3 and 1 send only the transports the refill needs; 2 sends them full', () => {
    const now = Date.now();
    const load = (src) => { const p = plan(src, { cache: WIKI, now, state: wikiState(now) }).plan; return Object.fromEntries(p.actions.map((a) => [`${a.target.x},${a.target.y}`, a.troops.carriage])); };
    const full = load('config npc:5,smartfarming:2');
    const needed = load('config npc:5,smartfarming:3');
    assert.ok(needed['101,100'] < full['101,100'], `half a camp takes fewer transports: ${needed['101,100']} vs ${full['101,100']}`);
    eq(needed['106,100'], full['106,100'], 'a full camp takes the full escort');
    // mode 1: the normal schedule, sized to the refill (hit every 4 h, ~half full)
    const one = load('config npc:5,smartfarming:1,farmingcycle:4');
    assert.ok(one['101,100'] < full['101,100']);
  });

  // ======================================================== training:2
  section('training:2 farms hourly without transports (wiki Training)');

  await t('levels 1-9 carry no transports for loot; level 10 is not training:2\'s', () => {
    const cache = cacheOf([[5, 101, 100], [10, 100, 102]]);
    const { plan: p } = plan('config npc:5,training:2\nnpctroops 10 a:90000,t:2000\nnpclimits 10 a:100k', { cache });
    const five = p.actions.find((a) => a.level === 5), ten = p.actions.find((a) => a.level === 10);
    eq(five.troops, { ballista: 550 }, 'the ballistas carry their own march food at one tile');
    has(five.why, 'no transports for loot (training:2)');
    eq(ten.troops.carriage, 2000);
    eq(five.cycleMs, H1);
  });

  await t('a long march still takes the transports its march food needs', () => {
    const cache = cacheOf([[5, 109, 100]]);
    const { plan: p } = plan('config npc:5,training:2\nfarmingpolicy 5 /maxdistance:12', { cache, techs: FULL });
    // 9 tiles is 45 minutes out, 90 back: over the hour, so none is planned;
    // the load itself is what matters here
    const load = I.troopLoadFor(ctxOf('config npc:5,training:2'), 5, hero(1, 'S', 150), { x: 109, y: 100 }, { home: HOME, noTransports: true });
    assert.ok(load.troops.carriage >= 1, 'the ballistas alone cannot carry 45 minutes of food');
    has(load.why, 'for the march food');
    eq(p.actions, []);
  });

  // ======================================================== npclimits / npctroops
  section('npclimits and npctroops as NEAT counts them');

  const TENS = cacheOf([[10, 101, 100], [10, 100, 102], [10, 103, 100], [10, 100, 104]]);

  await t('npclimits counts the troops at home before a run: 490k archers, 400k limit, 90k loads -> two runs', () => {
    const castle = city({ troop: { archer: 490000, carriage: 20000, peasants: 20000, militia: 20000, scouter: 20000 } });
    const { plan: p } = plan('config npc:10\nnpclimits 10 a:400k\nnpctroops 10 a:90k,t:2k', { cache: TENS, castle });
    eq(p.actions.length, 2, 'the old count (what stays behind) sent one');
    has(p.note, 'npclimits 10: 310,000 Archer at home, needs 400,000 before a run leaves');
  });

  await t('a level-less npclimits covers 6-10; a line for the level wins; it never gates 1-5', () => {
    const cache = cacheOf([[8, 101, 100], [8, 100, 102], [5, 103, 100]]);
    const castle = city({ troop: { archer: 300000, carriage: 20000, ballista: 5000 } });
    const src = 'config npc:5\nnpctroops 8 a:50k,t:10';
    eq(plan(src, { cache, castle }).plan.actions.filter((a) => a.level === 8).length, 0, 'no npclimits at all: no level 8');
    eq(plan(`${src}\nnpclimits a:100k`, { cache, castle }).plan.actions.filter((a) => a.level === 8).length, 2);
    const own = plan(`${src}\nnpclimits a:100k\nnpclimits 8 a:400k`, { cache, castle }).plan;
    eq(own.actions.filter((a) => a.level === 8).length, 0);
    has(own.note, 'npclimits 8: 300,000 Archer at home, needs 400,000');
    const five = plan(`${src}\nnpclimits b:1m`, { cache, castle }).plan;
    eq(five.actions.filter((a) => a.level === 5).length, 1, 'a level-less line is for 6-10');
    eq(plan(`${src}\nnpclimits 5 b:6000`, { cache, castle }).plan.actions.filter((a) => a.level === 5).length, 0, 'one written for level 5 counts');
  });

  await t('levels 6-10 have no default load: the wiki gives none, so none is guessed', () => {
    const { plan: p } = plan('config npc:10\nnpclimits 10 a:100k', { cache: TENS });
    eq(p.actions, []);
    has(p.note, 'level 10 has no default troop load — add "npctroops 10 ..."');
  });

  // ======================================================== npcheroes
  section('npcheroes: a line with no level covers levels 1-5 (wiki NpcHeroes)');

  await t('npcheroes !OTTO,any keeps OTTO off 1-5; 6-10 have no line, so any hero', () => {
    const castle = city({ heros: [hero(9, 'OTTO', 300), ...crew()] });
    const cache = cacheOf([[5, 101, 100], [5, 100, 102], [10, 103, 100]]);
    const { plan: p } = plan('config npc:5\nnpcheroes !OTTO,any\nnpclimits 10 a:100k\nnpctroops 10 a:90k,t:2k', { cache, castle });
    ok(!p.actions.some((a) => a.level === 5 && a.hero.name === 'OTTO'));
    assert.strictEqual(p.actions.find((a) => a.level === 10).hero.name, 'OTTO');
    eq(I.heroSpecFor(ctxOf('npcheroes !OTTO,any'), 10), 'any');
    eq(I.heroSpecFor(ctxOf('npcheroes !OTTO,any'), 5), '!OTTO,any');
  });

  await t('npc10heroes is NEAT\'s older "npcheroes 10"', () => {
    const p = G.parseGoals('npc10heroes Middling');
    eq(p.errors, []);
    eq([p.goals[0].level, p.goals[0].spec], [10, 'Middling']);
    eq(I.heroSpecFor(ctxOf('npc10heroes Middling\nnpcheroes 10 Rookie'), 10), 'Rookie|Middling');
  });

  // ======================================================== research
  section('research before levels 1-5 (wiki FAQ: Military Tradition level+2, Archery with Horseback Riding)');

  await t('the Archery / Horseback Riding pairs, read as written', () => {
    const ok5 = (ho, ar) => I.researchCheck(techs(10, ho, ar), 5).ok;
    eq([ok5(5, 8), ok5(6, 8), ok5(4, 8), ok5(7, 8)], [true, true, false, false], 'archery 8 + hbr 5/6');
    eq([ok5(8, 9), ok5(9, 9), ok5(7, 9), ok5(10, 9)], [true, true, false, false], 'archery 9 + hbr 8/9');
    eq([ok5(0, 10), ok5(10, 10)], [true, true], 'archery 10 + any hbr');
    eq(ok5(10, 7), false);
  });

  await t('Military Tradition must be the camp\'s level + 2', () => {
    eq([1, 2, 3, 4, 5].map((l) => I.researchCheck(techs(6, 10, 10), l).ok), [true, true, true, true, false]);
    has(I.researchCheck(techs(6, 10, 10), 5).why, 'Military Tradition 6, level 5 needs 7');
    assert.ok(I.researchCheck(null, 8).ok, 'levels 6-10 are not gated');
  });

  await t('unknown research farms no level that needs it, and says why; 6-10 still go', () => {
    const cache = cacheOf([[5, 101, 100], [10, 100, 102]]);
    const src = 'config npc:5\nnpclimits 10 a:100k\nnpctroops 10 a:90k,t:2k';
    const { plan: p } = plan(src, { cache, techs: null });
    eq(p.actions.map((a) => a.level), [10]);
    has(p.note, 'L5: 1 camp(s) held — research levels unknown — levels 1-5 wait for them (wiki FAQ)');
    const failed = plan(src, { cache, techs: { at: Date.now(), levels: null, error: 'research list unreadable: timeout' } }).plan;
    has(failed.note, 'research levels unknown (research list unreadable: timeout)');
    has(plan(src, { cache, techs: { levels: { 9: 10, 14: 10 } } }).plan.note, 'the research list has no Horseback Riding');
  });

  await t('a lower level still farms when only the higher one lacks Military Tradition', () => {
    const cache = cacheOf([[5, 101, 100], [4, 100, 102]]);
    const { plan: p } = plan('config npc:4', { cache, techs: techs(6, 10, 10) });
    eq(p.actions.map((a) => a.level), [4]);
    has(p.note, 'L5: 1 camp(s) held — Military Tradition 6, level 5 needs 7 (wiki FAQ)');
    const pair = plan('config npc:4', { cache, techs: techs(10, 10, 9) }).plan;
    eq(pair.actions, []);
    has(pair.note, 'Archery 9 with Horseback Riding 10');
  });

  await t('the engine reads research once for the account, not once per city, and keeps it 10 minutes', async () => {
    const world = engineWorld([{ id: 301, name: 'A', x: 300, y: 300 }, { id: 302, name: 'B', x: 340, y: 300 }]);
    D.mapCache.upsertMany([[5, 302, 300], [5, 342, 300]].map(([level, x, y]) => ({ id: C.coordsToFieldId(x, y), x, y, level, kind: 'npc', npc: true, name: "Barbarian's city", seen: Date.now() })));
    const { e, g } = world.engine({ A: 'config npc:5,hero:0', B: 'config npc:5,hero:0' });
    await e.tick();
    eq(g.reqs.filter((r) => r === 'tech.getResearchList').length, 1);
    eq(g.marches.map((m) => [m.castleId, m.bean.targetPoint]).sort(), [[301, C.coordsToFieldId(302, 300)], [302, C.coordsToFieldId(342, 300)]]);
    await e.tick();
    eq(g.reqs.filter((r) => r === 'tech.getResearchList').length, 1, 'still fresh');
  });

  // ======================================================== history reset
  section('farming history resets after maintenance (wiki Npc)');

  await t('a maintenance newer than the last reset forgets every camp; the runs in the air stay', () => {
    const cache = cacheOf([[5, 101, 100], [5, 100, 102]]);
    const now = Date.now(), A = C.coordsToFieldId(101, 100);
    const state = { npc: { hits: { [A]: now - H1 }, runs: [{ fieldId: 999, heroId: 77, doneAt: now + H1 }] } };
    const first = plan('config npc:5', { cache, now, state, ctx: { maintEndedAt: now - 60000 } }).plan;
    has(first.note, 'farming history reset after maintenance (1 camp(s) forgotten)');
    eq(targets(first), ['101,100', '100,102'], 'the camp hit an hour ago is fresh again');
    has(first.note, '1/10 teams out');
    eq(state.npc.historyResetAt, now - 60000);
    const again = plan('config npc:5', { cache, now, state, ctx: { maintEndedAt: now - 60000 } }).plan;
    hasNot(again.note, 'farming history reset');
  });

  await t('resetHistory by hand (NEAT\'s \\resetfarminghistory) says how many camps it forgot', () => {
    const state = { npc: { hits: { 1: 5, 2: 6 }, cycles: { 5: { startedAt: 1 } } } };
    eq(NPC.resetHistory(state, 'by hand', 123), 2);
    eq([state.npc.hits, state.npc.cycles, state.npc.historyResetAt, state.npc.historyResetWhy], [{}, undefined, 123, 'by hand']);
  });

  await t('the console hands the engine the moment it came back from maintenance', async () => {
    const { s } = sessionWith({ A: 'config comfort:1' });
    s.maintEndedAt = 424242;
    assert.strictEqual(await s.engineTick(), true);
    eq(s.engine.maintEndedAt, 424242);
  });

  // ======================================================== trainint / trainpol
  section('trainint and trainpol (wiki TrainInt, TrainPol, NoMayor)');

  const HEROES = () => [
    hero(1, 'Pol', 20, { management: 300, status: 1 }),            // the mayor, a politics hero
    hero(2, 'Atk', 150, { management: 40 }),
    hero(3, 'Grunt', 120, { management: 80 }),
    hero(4, 'Brain', 30, { stratagem: 200 }),                       // an intel hero
  ];
  const FOUR = cacheOf([[5, 101, 100], [5, 100, 102], [5, 103, 100], [5, 100, 104]]);

  await t('by default intel heroes do not farm, and the best politics hero stays home', () => {
    const heros = HEROES(); heros[0].status = 0;                    // idle: an attack hero is mayor for training
    heros.push(hero(5, 'TempMayor', 160, { status: 1 }));
    const { plan: p } = plan('config npc:5', { cache: FOUR, castle: city({ heros }) });
    eq(p.actions.map((a) => a.hero.name), ['Atk', 'Grunt']);
    const lone = plan('config npc:5', { cache: FOUR, castle: city({ heros: [heros[0], heros[3]] }) }).plan;
    has(lone.note, 'Pol is the best politics hero, kept home as mayor (config trainpol:1 lets it farm)');
    has(lone.note, 'Brain is an intel hero (config trainint:1 lets it farm)');
  });

  await t('trainint:1 sends the intel hero first, before the attack heroes', () => {
    const { plan: p } = plan('config npc:5,trainint:1', { cache: FOUR, castle: city({ heros: HEROES() }) });
    eq(p.actions.map((a) => a.hero.name), ['Brain', 'Atk', 'Grunt']);
    eq(p.actions[0].troops.ballista, 550, 'attack 30 still takes the safe ballistas');
  });

  await t('trainpol:1 sends the politics hero first, out of the mayor\'s office, and keeps a stand-in home', () => {
    const { plan: p } = plan('config npc:5,trainpol:1', { cache: FOUR, castle: city({ heros: HEROES() }) });
    eq(p.actions.map((a) => a.hero.name), ['Pol', 'Atk']);
    assert.strictEqual(p.actions[0].leavesOffice, true);
    has(p.actions[0].label, "leaves the mayor's office for it (trainpol)");
    // Grunt (politics 80) is the best at home to stand in; Brain is intel
    has(p.note, 'Grunt stays to stand in as mayor while Pol farms (trainpol)');
  });

  await t('the mayor plan, told who leaves, stands another hero in — only under trainpol', () => {
    const heros = HEROES();
    const leaving = new Set([1, 2]);
    const withPol = M.mayorPlan({ castle: { heros }, config: { trainpol: 1 } }, 'idle', { leaving });
    eq(withPol.actions.map((a) => a.hero.name), ['Grunt']);
    has(withPol.note, 'Pol goes NPC farming (trainpol), Grunt stands in');
    const without = M.mayorPlan({ castle: { heros }, config: {} }, 'idle', { leaving });
    has(without.note, 'Pol already set', 'Step 8\'s rules are untouched without trainpol');
    const back = M.mayorPlan({ castle: { heros: HEROES().map((h) => (h.id === 1 ? { ...h, status: 0 } : h.id === 3 ? { ...h, status: 1 } : h)) }, config: { trainpol: 1 } }, 'idle', { leaving: new Set() });
    eq(back.actions.map((a) => a.hero.name), ['Pol'], 'home and not going out: back in office');
  });

  await t('trainpol with hero:0 (no mayor plan) never sends the sitting mayor; nomayor:1 lets it farm like anyone', () => {
    const p = plan('config npc:5,trainpol:1,hero:0', { cache: FOUR, castle: city({ heros: HEROES() }) }).plan;
    ok(!p.actions.some((a) => a.hero.name === 'Pol'));
    has(p.note, 'trainpol: Pol is mayor, and with config hero:0 nothing stands another hero in');
    const heros = HEROES(); heros[0].status = 0;
    const nm = plan('config npc:5,nomayor:1', { cache: FOUR, castle: city({ heros }) }).plan;
    eq(nm.actions.map((a) => a.hero.name), ['Atk', 'Grunt', 'Pol'], 'no priority, strongest first');
  });

  await t('two politics heroes: the best stays as mayor, the second farms; when it passes the first they swap', () => {
    const two = [hero(1, 'P1', 20, { management: 300, status: 1 }), hero(2, 'P2', 50, { management: 200 }), hero(3, 'Atk', 150)];
    eq(plan('config npc:5', { cache: FOUR, castle: city({ heros: two }) }).plan.actions.map((a) => a.hero.name), ['Atk', 'P2']);
    const passed = [hero(1, 'P1', 20, { management: 300, status: 1 }), hero(2, 'P2', 50, { management: 310 }), hero(3, 'Atk', 150)];
    eq(plan('config npc:5', { cache: FOUR, castle: city({ heros: passed }) }).plan.actions.map((a) => a.hero.name), ['Atk'], 'P2 is now the one kept home');
    eq(M.mayorPlan({ castle: { heros: passed }, config: {} }, 'idle').actions.map((a) => a.hero.name), ['P2'], 'and the mayor plan appoints it');
    const after = [hero(1, 'P1', 20, { management: 300 }), hero(2, 'P2', 50, { management: 310, status: 1 }), hero(3, 'Atk', 150)];
    eq(plan('config npc:5', { cache: FOUR, castle: city({ heros: after }) }).plan.actions.map((a) => a.hero.name), ['Atk', 'P1'], 'the old mayor farms');
  });

  await t('engine: trainpol appoints the stand-in first, then the politics hero marches', async () => {
    const world = engineWorld([{ id: 401, name: 'T', x: 500, y: 500, heros: HEROES() }]);
    D.mapCache.upsertMany([[5, 501, 500], [5, 500, 502]].map(([level, x, y]) => ({ id: C.coordsToFieldId(x, y), x, y, level, kind: 'npc', npc: true, name: "Barbarian's city", seen: Date.now() })));
    const { e, g } = world.engine({ T: 'config npc:5,trainpol:1' });
    await e.tick();
    eq(g.log, ['promote 3', 'march 1', 'march 2']);
    const quiet = engineWorld([{ id: 402, name: 'U', x: 500, y: 540, heros: HEROES() }]);
    D.mapCache.upsertMany([[5, 501, 540]].map(([level, x, y]) => ({ id: C.coordsToFieldId(x, y), x, y, level, kind: 'npc', npc: true, name: "Barbarian's city", seen: Date.now() })));
    const r2 = quiet.engine({ U: 'config npc:5' });
    await r2.e.tick();
    eq(r2.g.log, ['march 2'], 'without trainpol the mayor stays and the attack hero farms');
  });

  await t('trainint / trainpol are off the "does nothing yet" table and read clean', () => {
    assert.ok(!('trainint' in G.NOT_IMPLEMENTED.config) && !('trainpol' in G.NOT_IMPLEMENTED.config));
    const p = G.parseGoals('config npc:5,trainint:1,trainpol:1,smartfarming:2,mapscan:1,farmingcyclemin:1');
    eq(p.errors, []);
    eq(p.lines[0], { n: 1, status: 'ok', msg: null });
  });

  // ======================================================== config values
  section('npc config values are checked, not quietly defaulted');

  await t('an unreadable or out-of-range farming key holds farming and says so', () => {
    const cache = cacheOf([[5, 101, 100]]);
    has(plan('config npc:5,farmingcycle:soon', { cache }).plan.note, 'held: config farmingcycle:soon is not a number of hours, e.g. 8.4');
    has(plan('config npc:11', { cache }).plan.note, 'config npc:11 is not the lowest npc level to farm');
    has(plan('config npc:5,smartfarming:4', { cache }).plan.note, 'config smartfarming:4 is not 0, 1, 2 or 3');
    has(plan('config npc:5,training:3', { cache }).plan.note, 'config training:3 is not 0, 1 or 2');
    eq(plan('config npc:0', { cache }).plan, null, 'npc:0 is off');
  });

  await t('a bad mapscan value farms on, and turns the scan off with a note', () => {
    const cache = cacheOf([[5, 101, 100]]);
    const { plan: p } = plan('config npc:5,mapscan:2', { cache });
    eq(p.actions.length, 1);
    has(p.note, 'config mapscan:2 is not 0 or 1 — the background map scan is off here');
    eq(I.scanWanted({ npc: 5, mapscan: 2 }), false);
  });

  // goals.js runs a config value through its module's config-kind parser (Step
  // 9), and a policy line's parser errors make it red: the editor says so as
  // the goals are read, not only the plan note later.
  await t('the editor paints bad npc values red as the goals are read; good ones stay blue', () => {
    const line = (src) => G.parseGoals(src).lines[0];
    for (const src of ['config smartfarming:5', 'config mapscan:yes', 'config farmingcycle:soon', 'config farmingcyclemin:0',
      'config npc:11', 'config training:3', 'config training10:2', 'config trainint:2', 'config trainpol:x', 'config ballsused:1.5',
      'distancepolicy 200', 'distancepolicy 0', 'distancepolicy 1 2 3 4 5 6', 'npcbounds 11 1 2 3 4', 'npcbounds 5 1 2',
      'farmingpolicy 5 /cycle:soon', 'farmingpolicy 10 /mincycle:1', 'farmingpolicy 5 /level:6', 'farmingpolicy 5 /maxdistance:200',
      'farmingpolicy 5 /wibble:1', 'npclimits 10']) {
      eq([src, line(src).status], [src, 'error']);
    }
    has(line('config smartfarming:5').msg, 'smartfarming:5 is not 0, 1, 2 or 3');
    for (const src of ['config npc:0', 'config npc:5,farmingcycle:8.4,farmingcyclemin:1,smartfarming:3,mapscan:0,trainint:1,trainpol:1,training:2,training10:1',
      'distancepolicy 10 20 5 10 25', 'distancepolicy 10.5', 'npcbounds 5 790 810 95 105', 'npcbounds 200 215 400 415',
      'farmingpolicy /level:8 /mindistance:1 /maxdistance:5 /farmingcycle:1', 'farmingpolicy 5 /mindistance:1 /maxdistance:7 /mincycle:1',
      'farmingpolicy 10 /cyclemax:1', 'npclimits a:100k', 'npc10heroes any']) {
      eq([src, line(src)], [src, { n: 1, status: 'ok', msg: null }]);
    }
    const bare = G.parseGoals('farmingcycle 8.4');
    eq([bare.config.farmingcycle, bare.lines[0].status], [8.4, 'ok'], 'a bare config key reads as the config line it means');
    eq(G.parseGoals('smartfarming 9').lines[0].status, 'error');
  });

  // ======================================================== the scan planner
  section('background map scan: which blocks (goal-npc scanPlan)');

  await t('who is scanned: farming or NPC-building cities, config mapscan:1, never mapscan:0', () => {
    eq([I.scanWanted({ npc: 5 }), I.scanWanted({ buildnpc: 1 }), I.scanWanted({}), I.scanWanted({ mapscan: 1 }), I.scanWanted({ npc: 5, mapscan: 0 })],
      [true, true, false, true, false]);
  });

  await t('how far: distancepolicy\'s fifth number (10 by default), or a farming rule of a level that can farm', () => {
    const area = (src) => I.scanAreaFor(ctxOf(src)).radius;
    assert.strictEqual(area('config npc:5'), 10);
    assert.strictEqual(area('config npc:5\ndistancepolicy 15'), 15);
    assert.strictEqual(area('config npc:5\ndistancepolicy 15\nfarmingpolicy 5 /maxdistance:10'), 10, 'only L5 can farm; 6-10 have no npclimits');
    assert.strictEqual(area('config npc:5\ndistancepolicy 15\nfarmingpolicy 5 /maxdistance:10\nnpclimits 8 a:1'), 15, 'L8 can farm now, at 15');
    assert.strictEqual(area('config npc:5\nfarmingpolicy 5 /maxdistance:3'), 10, 'the view distance is still 10');
    assert.strictEqual(area('config npc:5\ndistancepolicy 3 3 3 3 3'), 3);
    assert.strictEqual(area('config npc:5\ndistancepolicy 12 10 10 10 30'), 30);
    assert.strictEqual(area('config buildnpc:1\ndistancepolicy 5 25'), 25, 'npc building\'s distance');
    assert.strictEqual(area('config mapscan:1'), 10);
    assert.strictEqual(area('config npc:5\ndistancepolicy 400'), 150);
    const listed = I.scanAreaFor(ctxOf('config npc:5\nnpclist 5 300,300'));
    eq([listed.radius, listed.points], [10, [{ x: 300, y: 300 }]], 'an npclist level adds its camps; the default view stays');
  });

  await t('blocks: aligned 20x20, only those the circle reaches, nearest first, wrapped at the edge', () => {
    eq(I.blocksFor({ x: 100, y: 100 }, { radius: 10 }).map((b) => [b.x, b.y]), [[100, 100], [100, 80], [80, 100], [80, 80]]);
    eq(I.blocksFor({ x: 110, y: 110 }, { radius: 10 }).map((b) => [b.x, b.y]), [[100, 100], [120, 100], [100, 120]], 'the far corner block is 14 tiles off');
    eq(I.blocksFor({ x: 795, y: 100 }, { radius: 10 }).map((b) => [b.x, b.y]).sort(), [[0, 100], [0, 80], [780, 100], [780, 80]].sort());
    eq(I.blocksFor({ x: 100, y: 100 }, { radius: 150 }).length, 208, 'a 150-mile radius: the circle, not its square (256)');
  });

  await t('scanPlan: never-read blocks first, then the nearest; a block two cities share counts once; 3 a round', () => {
    const cities = [
      { name: 'A', xy: { x: 100, y: 100 }, config: { npc: 5 }, goals: [] },
      { name: 'B', xy: { x: 110, y: 100 }, config: { npc: 5 }, goals: [] },
      { name: 'Quiet', xy: { x: 400, y: 400 }, config: { comfort: 1 }, goals: [] },
    ];
    const now = 10 * 3600000;
    const seen = new Map([['100,100', now - 5 * 3600000]]);            // read 5 h ago: due
    const p = NPC.scanPlan({ cities, now, seenOf: (o) => seen.get(o.x + ',' + o.y) || 0 });
    eq(p.cities.map((c) => [c.city, c.blocks]), [['A', 4], ['B', 3]], 'B\'s corner block 120,80 is just past 10 tiles');
    eq(p.wanted, 5, 'A: 4 blocks, B: 3, sharing 2');
    eq(p.due, 5);
    eq(p.origins.length, 3);
    assert.ok(!p.origins.some((o) => o.x === 100 && o.y === 100), 'the block already read waits behind the never-read ones');
    seen.set('100,100', now - 3 * 3600000);                            // read 3 h ago: fresh
    eq(NPC.scanPlan({ cities, now, seenOf: (o) => seen.get(o.x + ',' + o.y) || 0 }).due, 4);
  });

  // ======================================================== the scan itself
  section('background map scan: the console reads them (session.js backgroundScan)');

  await t('three blocks a round, on the console\'s own socket, and the camps, flats and valleys land in the cache', async () => {
    const { s, sent } = sessionWith({ A: 'config npc:5' }, { camps: [{ x: 101, y: 100, level: 5 }] });
    const p = await s.backgroundScan();
    eq(sent.length, 3);
    eq(p.wanted, 4);
    const camp = D.mapCache.npcs().find((c) => c.x === 101 && c.y === 100);
    assert.ok(camp && camp.level === 5, 'the camp is cached with its level');
    const blk = D.mapCache.blockSeen(100, 100, 20);
    eq(blk.tiles, 400, 'every tile of the block: the camp, the flat and 398 forests');
    assert.ok(D.mapCache.flats().some((f) => f.x === 100 && f.y === 100), 'the flat');
    eq(s.mapScan.read, 3);
  });

  await t('at most one round per engine tick; a fresh block is not asked for again', async () => {
    const { s, sent } = sessionWith({ A: 'config npc:5' }, { at: { x: 200, y: 200 } });
    await s.backgroundScan();
    eq(await s.backgroundScan(), null, 'the gap between rounds');
    eq(sent.length, 3);
    s._scanAt = 0;
    await s.backgroundScan();
    eq(sent.length, 4, 'the fourth block');
    s._scanAt = 0;
    const idle = await s.backgroundScan();
    eq([sent.length, idle.due], [4, 0], 'all four read: nothing until they are four hours old');
  });

  await t('never while in maintenance, a stand-down, the console\'s pause, or offline', async () => {
    for (const [why, set] of [
      ['maintenance', (s) => { s.maint.active = true; }],
      ['stand-down', (s) => { s.maint.plan = { pauseAt: Date.now() - 1000, resumeAt: Date.now() + 600000, source: 'announcement' }; }],
      ['paused', (s) => { s.userPaused = true; }],
      ['offline', (s) => { s.game.c.sock.destroyed = true; }],
    ]) {
      const { s, sent } = sessionWith({ A: 'config npc:5' }, { at: { x: 300, y: 600 } });
      set(s);
      eq(await s.backgroundScan(), null, why);
      eq(sent.length, 0, why);
    }
  });

  await t('config mapscan:0 scans nothing; a city with no farming goals is not scanned', async () => {
    const off = sessionWith({ A: 'config npc:5,mapscan:0' }, { at: { x: 600, y: 100 } });
    eq((await off.s.backgroundScan()).wanted, 0);
    eq(off.sent.length, 0);
    const none = sessionWith({ A: 'config comfort:1' }, { at: { x: 600, y: 140 } });
    await none.s.backgroundScan();
    eq(none.sent.length, 0);
  });

  await t('what the cache already holds counts: a block read recently is skipped, one with unlevelled camps is read', async () => {
    const at = { x: 660, y: 660 };
    D.mapCache.upsertMany([
      { id: C.coordsToFieldId(661, 661), x: 661, y: 661, kind: 'forest', level: 3, seen: Date.now() },        // block 660,660: fresh
      { id: C.coordsToFieldId(645, 661), x: 645, y: 661, kind: 'npc', npc: true, seen: Date.now() },          // block 640,660: no level
    ]);
    const { s, sent } = sessionWith({ A: 'config npc:5' }, { at });
    await s.backgroundScan();
    const asked = sent.map((r) => `${r.x1},${r.y1}`);
    assert.ok(!asked.includes('660,660'), asked.join(' '));
    assert.ok(asked.includes('640,660'), asked.join(' '));
  });

  await t('a refused block is asked again after 15 minutes, not every round', async () => {
    const { s, sent } = sessionWith({ A: 'config npc:5' }, { at: { x: 700, y: 300 }, refuse: (req) => req.x1 === 700 && req.y1 === 300 });
    await s.backgroundScan();
    eq(sent.filter((r) => r.x1 === 700 && r.y1 === 300).length, 1);
    s._scanAt = 0;
    await s.backgroundScan();
    eq(sent.filter((r) => r.x1 === 700 && r.y1 === 300).length, 1, 'not straight away');
    const real = Date.now;
    try {
      Date.now = () => real() + 16 * 60000;
      s._scanAt = 0;
      await s.backgroundScan();
    } finally { Date.now = real; }
    eq(sent.filter((r) => r.x1 === 700 && r.y1 === 300).length, 2, '16 minutes on');
  });

  await t('a regular engine tick starts a round after it (outside its lock); a war pass does not', async () => {
    const { s, sent } = sessionWith({ A: 'config npc:5' }, { at: { x: 100, y: 700 } });
    assert.strictEqual(await s.engineTick({ urgent: true }), true);
    await sleep(50);
    eq(sent.length, 0, 'the war pass');
    assert.strictEqual(await s.engineTick(), true);
    for (let i = 0; i < 50 && sent.length < 3; i++) await sleep(10);
    eq(sent.length, 3);
  });

  await t('the cache keeps the level history as before: one row per change, whoever writes', () => {
    const id = C.coordsToFieldId(777, 777);
    D.mapCache.upsertMany([{ id, x: 777, y: 777, kind: 'flat', level: 3, seen: 1000 }]);
    D.mapCache.upsertMany([{ id, x: 777, y: 777, kind: 'flat', level: 3, seen: 2000 }]);
    D.mapCache.upsertMany([{ id, x: 777, y: 777, kind: 'flat', level: 4, seen: 3000 }]);
    eq(D.mapCache.levelHistory(id).map((r) => [r.at, r.level]), [[1000, 3], [3000, 4]]);
  });

  await t('goal-npc reads the npc rows only, and sees the scan\'s camps on the next slice', () => {
    const cache = I.loadNpcCache();
    assert.ok(cache.ok && cache.npcs.some((c) => c.x === 101 && c.y === 100 && c.level === 5));
    assert.ok(cache.npcs.every((c) => c.level >= 1 && c.level <= 10));
  });

  // ======================================================== the live lines
  section('the live goals (live-goals.txt, Lord02): what changes');

  // a2's city goals as saved, npc lines and all, comments dropped
  const LORD02 = `config comfort:1,hero:1,troopsusepopmax:1,npc:5
comfortpolicy 15 16 popraise
defensepolicy /usetruce:79 /usespeech:2 /junktroop:5000 /usewarhorn:1 /usecorselet:1 /usepenicillin:1
build fh:1
build th:10,w:10,c:10:1,b:10:1,a:10:1,r:10:1,be:10:1,rs:10:1
build f:10:37
troop b:5k,t:5k
troop wo:10k,w:10k,s:10k,p:10k,sw:10k,a:10k,t:10k,c:10k,cata:10k,b:10k
troop a:100k,s:100k
fortification ab:5000
distancepolicy 15
npcteams 3
requestresources any gold 1000000 2000000 500000 200000
requestresources any wood 100000 2000000 500000 200000
traininghero OTTO 30 60
npcheroes !OTTO,any
farmingpolicy 10 /distance:5
farmingpolicy 5 /distance:10`;

  await t('the npc lines parse clean and stay blue', () => {
    const p = G.parseGoals(LORD02);
    const src = LORD02.split('\n');
    for (const want of ['distancepolicy 15', 'npcteams 3', 'npcheroes !OTTO,any', 'farmingpolicy 10 /distance:5', 'farmingpolicy 5 /distance:10']) {
      const l = p.lines[src.indexOf(want)];
      eq([want, l.status], [want, 'ok']);
    }
    assert.ok(!p.errors.some((e) => /DISTANCEPOLICY|NPCTEAMS|NPCHEROES|FARMINGPOLICY/.test(e.error)), JSON.stringify(p.errors));
    eq(p.goals.find((g) => g.name === 'distancepolicy').distances, { npc: 15 });
    eq(p.goals.filter((g) => g.name === 'farmingpolicy').map((g) => [g.level, g.policy]), [[10, { maxDistance: 5 }], [5, { maxDistance: 10 }]]);
  });

  await t('L5 within 10 tiles (farmingpolicy beats distancepolicy 15, as before), 3 teams, never OTTO, each camp every 8.4 h', () => {
    const heros = [hero(9, 'OTTO', 300), hero(1, 'Strong', 150), hero(2, 'Brawler', 140), hero(3, 'Scrapper', 110),
      hero(6, 'Mayor', 20, { management: 250, status: 1 })];
    const cache = cacheOf([[5, 103, 100], [5, 100, 106], [5, 109, 100], [5, 112, 100], [10, 104, 100], [7, 108, 100]]);
    const { plan: p } = plan(LORD02, { cache, castle: city({ heros }) });
    eq(targets(p), ['103,100', '100,106', '109,100'], 'the 12-tile camp is past /distance:10');
    ok(!p.actions.some((a) => a.hero.name === 'OTTO'));
    has(p.note, 'L5: within 10 tiles (farmingpolicy), each hit every 8.4h (default)');
    has(p.note, 'L10: 1 target(s) skipped — needs "npclimits 10 ..."');
    has(p.note, 'L7: 1 target(s) skipped — needs "npclimits 7 ..."');
    has(p.note, '0/3 teams out (npcteams 3)');
    const noResearch = plan(LORD02, { cache, castle: city({ heros }), techs: null }).plan;
    eq(noResearch.actions, [], 'new: level 5 waits for the research reading');
  });

  await t('its background scan reads the blocks within 10 tiles of each city (L10 and 6-9 cannot farm)', () => {
    const { goals, config } = ctxOf(LORD02);
    eq(I.scanAreaFor({ goals, config }).radius, 10);
    const p = NPC.scanPlan({ cities: [{ name: 'F', xy: { x: 257, y: 413 }, config, goals }], now: Date.now() });
    eq([p.wanted, p.origins.length], [4, 3]);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();

function ok(c, m) { assert.ok(c, m); }

// ----------------------------------------------------------- engine worlds
// Real Engine over fake cities; the game answers the research list (every tech
// at 10) and records promotions and marches in order.
function engineWorld(defs) {
  const castles = defs.map((d) => ({
    castleId: d.id, id: d.id, name: d.name, fieldId: C.coordsToFieldId(d.x, d.y),
    troop: { ballista: 20000, carriage: 20000 }, resource: { food: { amount: 1e9 } },
    buildings: [{ typeId: 29, level: 10, positionId: 5 }], fortification: {},
    heros: d.heros || [hero(d.id * 10 + 1, `${d.name}hero`, 150)],
  }));
  const g = {
    castles, player: { playerInfo: { userName: 'T' }, selfArmys: [], enemyArmys: [], items: [] },
    marchSkillParam: 100, loadSkillParam: 100, reqs: [], marches: [], log: [],
    now: () => Date.now(),
    castleId: (c) => c.castleId,
    castleXY: (c) => C.fieldIdToCoords(c.fieldId),
    buildArmyBean: (o) => Game.prototype.buildArmyBean.call(g, o),
    newArmy: async (castleId, bean) => { g.marches.push({ castleId, bean }); g.log.push(`march ${bean.heroId}`); return { ok: 1 }; },
    promoteToChief: async (cid, heroId) => { g.log.push(`promote ${heroId}`); return { ok: 1 }; },
    dischargeChief: async () => ({ ok: 1 }),
    req: async (cmd) => {
      g.reqs.push(cmd);
      if (cmd === 'tech.getResearchList') {
        return { ok: 1, acailableResearchBeans: C.TECHS.map((x) => ({ typeId: x.typeId, level: 10, upgradeing: false })) };
      }
      return { ok: 1 };
    },
  };
  return {
    engine(srcFor) {
      const e = new Engine(g, () => {});
      e.dryRun = false;
      e.state = {};
      e.goalsFor = (id, name) => G.parseGoals(srcFor[name] || '');
      return { e, g };
    },
  };
}

// ---------------------------------------------------------- console sessions
// A Session on a fake socket: common.mapInfoSimple is answered with a block of
// forests, one flat at its corner and any camps asked for; `refuse` answers a
// block with a refusal instead. The engine is a stand-in that only has goals.
let cityId = 900;
function sessionWith(srcFor, { camps = [], at = HOME, refuse = null } = {}) {
  const c = new EventEmitter();
  c.sock = { destroyed: false };
  const sent = [];
  c.send = (cmd, data) => {
    if (cmd !== 'common.mapInfoSimple') return;
    sent.push(data);
    setImmediate(() => c.emit('cmd', 'common.mapInfoSimple', refuse && refuse(data) ? { ok: -1, errorMsg: 'no' } : blockReply(data, camps)));
  };
  const castles = Object.keys(srcFor).map((name, i) => ({ castleId: ++cityId, id: cityId, name, fieldId: C.coordsToFieldId(at.x + i * 40, at.y) }));
  const s = new Session();
  s.account = { id: 'npcparity', label: 'T', server: 'ss71' };
  s.note = () => {};
  s.game = { c, castles, player: {}, castleId: (x) => x.castleId, castleXY: (x) => C.fieldIdToCoords(x.fieldId), now: () => Date.now() };
  s.engine = {
    game: s.game, accountId: 'npcparity', state: {},
    goalsFor: (id, name) => G.parseGoals(srcFor[name] || ''),
    async tick() {},
  };
  return { s, sent };
}

function blockReply(req, camps) {
  let mapStr = '';
  for (let y = req.y1; y <= req.y2; y++) {
    for (let x = req.x1; x <= req.x2; x++) {
      const camp = camps.find((k) => k.x === x && k.y === y);
      mapStr += camp ? 'c' + camp.level.toString(16) : (x === req.x1 && y === req.y1 ? 'a3' : '14');
    }
  }
  const castles = camps.filter((k) => k.x >= req.x1 && k.x <= req.x2 && k.y >= req.y1 && k.y <= req.y2)
    .map((k) => ({ id: C.coordsToFieldId(k.x, k.y), name: "Barbarian's city", npc: true, state: 1 }));
  return { x1: req.x1, y1: req.y1, x2: req.x2, y2: req.y2, mapStr, castles };
}
