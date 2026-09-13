'use strict';
// Offline tests for goal-npc.js. No network, no game client — fixtures plus the
// real mapcache.json (read only).
//
//   node test-npc.js
const fs = require('fs');
const path = require('path');
const C = require('./constants');
const G = require('./goals');
const NPC = require('./goal-npc');

const I = NPC._internals;

// ------------------------------------------------------------- tiny harness
let pass = 0, fail = 0, group = '';
const section = (s) => { group = s; console.log(`\n${s}`); };
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok    ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n          ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m ? m + ': ' : ''}expected ${B}, got ${A}`);
};
const near = (a, b, tol, m) => { if (Math.abs(a - b) > tol) throw new Error(`${m ? m + ': ' : ''}expected ~${b}, got ${a}`); };
const has = (s, sub, m) => { if (!String(s).includes(sub)) throw new Error(`${m ? m + ': ' : ''}"${s}" does not contain "${sub}"`); };

// ---------------------------------------------- goal parsing (goals.js + ours)
// Mirrors parseGoals() from goals.js with the npc parsers merged in, which also
// proves the parser shapes are drop-in compatible with the goal language.
const ALL = { ...G.GOALS, ...NPC.parsers };
function parseAll(text) {
  const goals = [], errors = [], config = {};
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/^\s*(\/\/|#).*$/, '').trim();
    if (!line) return;
    const tok = line.split(/\s+/);
    const name = tok[0].toLowerCase();
    const def = ALL[name];
    if (!def) { errors.push({ line: i + 1, error: `unknown goal "${tok[0]}"` }); return; }
    const parsed = def.parse(tok.slice(1), line);
    for (const e of parsed.errors || []) errors.push({ line: i + 1, error: `${name.toUpperCase()}: ${e}` });
    delete parsed.errors;
    if (name === 'config') { Object.assign(config, parsed.values); return; }
    if (!def.multi) { const p = goals.findIndex((g) => g.name === name); if (p >= 0) goals.splice(p, 1); }
    goals.push({ name, kind: def.kind, line: i + 1, raw: line, ...parsed });
  });
  return { config, goals, errors };
}

// -------------------------------------------------------------- the fixtures
const HOME = { x: 100, y: 100 };
const HOME_ID = C.coordsToFieldId(HOME.x, HOME.y);

// camps laid out at known distances so ordering is unambiguous
const CAMP_LAYOUT = [
  // [level, x, y]  — distances from 100,100 in tiles
  [5, 101, 100], [5, 100, 102], [5, 103, 100], [5, 100, 104], [5, 105, 100],
  [4, 102, 100], [4, 100, 103],
  [1, 100, 101],
  [10, 106, 100], [10, 100, 107],
  [5, 160, 100],            // far outside any sane radius
];

function fixtureCache(layout = CAMP_LAYOUT) {
  const castles = {};
  for (const [level, x, y] of layout) {
    const id = C.coordsToFieldId(x, y);
    castles[id] = { id, x, y, level, kind: 'npc', typeName: 'NPC', npc: true, name: "Barbarian's city", state: 1, seen: Date.now() };
  }
  // a player city and an unleveled npc, to prove they are filtered out
  castles[C.coordsToFieldId(99, 99)] = { id: C.coordsToFieldId(99, 99), x: 99, y: 99, npc: false, kind: 'player', userName: 'SomeLord', name: 'Town' };
  castles[C.coordsToFieldId(98, 98)] = { id: C.coordsToFieldId(98, 98), x: 98, y: 98, npc: true, name: "Barbarian's city" };
  return { updatedAt: Date.now(), castles };
}

const hero = (id, name, power, extra = {}) => ({ id, name, power, powerAdded: 0, management: 10, stratagem: 10, level: 20, loyalty: 100, status: 0, ...extra });

function fixtureCastle(over = {}) {
  return {
    castleId: 7, id: 7, name: 'Testville', fieldId: HOME_ID,
    troop: { ballista: 5000, carriage: 5000, archer: 500000, scouter: 100000, militia: 20000, peasants: 20000 },
    heros: [
      hero(1, 'Strong', 150), hero(2, 'Middling', 80), hero(3, 'Weakling', 20),
      hero(4, 'Mayor', 200, { status: 1 }),                    // HeroConstants.as: 1 = chief, cannot march
      hero(5, 'Brawler', 140), hero(6, 'Scrapper', 110), hero(7, 'Rookie', 60),
    ],
    resource: { food: { amount: 200e6 }, wood: { amount: 1e6 } },
    buildings: [{ typeId: 29, level: 10, positionId: 3 }, { typeId: 2, level: 10, positionId: 4 }],
    ...over,
  };
}

function fakeGame(castle, selfArmys = []) {
  return {
    castles: [castle],
    player: { selfArmys },
    marchSkillParam: 100, loadSkillParam: 100,
    castleId: (c) => c.castleId,
    castleXY: (c) => C.fieldIdToCoords(c.fieldId),
  };
}

function makeCtx(src, over = {}) {
  const parsed = parseAll(src);
  const castle = over.castle || fixtureCastle();
  return {
    ctx: { castle, goals: parsed.goals, config: parsed.config, mapCache: over.cache || fixtureCache(), now: over.now, ...over.ctx },
    parsed, castle,
    game: over.game || fakeGame(castle, over.selfArmys || []),
  };
}

const run = (src, over = {}) => {
  const m = makeCtx(src, over);
  const state = over.state || {};
  return { plan: NPC.plans.npc(m.ctx, state, m.game), state, ...m };
};

// ================================================================== parsers
section('parsers');

t('npcheroes with and without a level', () => {
  const p = parseAll('npcheroes 10 any:attack>100\nnpcheroes Alexander');
  eq(p.errors, []);
  eq(p.goals[0].level, 10); eq(p.goals[0].spec, 'any:attack>100');
  eq(p.goals[1].level, null); eq(p.goals[1].spec, 'Alexander');
});

t('npctroops reads NEAT troop codes', () => {
  const p = parseAll('npctroops 5 b:400,t:400\nnpctroops 10 a:90000,wo:2000,w:2000,s:4000,t:2000');
  eq(p.errors, []);
  eq(p.goals[0].troops, { ballista: 400, carriage: 400 });
  eq(p.goals[1].troops, { archer: 90000, peasants: 2000, militia: 2000, scouter: 4000, carriage: 2000 });
});

t('npctroops rejects a bad code and a bad amount', () => {
  const p = parseAll('npctroops 5 zz:400,b:lots');
  eq(p.errors.length, 3, 'unknown code + bad amount + nothing parsed');
  has(p.errors[0].error, 'unknown troop code "zz"');
  has(p.errors[1].error, 'bad amount "lots"');
});

t('npclimits needs a level', () => {
  const good = parseAll('npclimits 10 a:390k,s:50k');
  eq(good.errors, []);
  eq(good.goals[0], { name: 'npclimits', kind: 'directive', line: 1, raw: 'npclimits 10 a:390k,s:50k', level: 10, troops: { archer: 390000, scouter: 50000 } });
  const bad = parseAll('npclimits a:390k');
  has(bad.errors[0].error, 'needs an npc level');
});

t('npcteams is single valued and last-wins', () => {
  const p = parseAll('npcteams 7\nnpcteams 3');
  eq(p.goals.length, 1);
  eq(p.goals[0].teams, 3);
  has(parseAll('npcteams x').errors[0].error, 'expected: npcteams');
});

t('npclist takes a level and coordinate pairs', () => {
  const p = parseAll('npclist 5 111,222 111,333');
  eq(p.errors, []);
  eq(p.goals[0].level, 5);
  eq(p.goals[0].coords, [{ x: 111, y: 222 }, { x: 111, y: 333 }]);
});

t('npcbounds normalises a box', () => {
  const p = parseAll('npcbounds 5 215 200 415 400');
  eq(p.errors, []);
  eq(p.goals[0].box, { xMin: 200, xMax: 215, yMin: 400, yMax: 415 });
  has(parseAll('npcbounds 5 200 215').errors[0].error, 'expected: npcbounds');
});

t('farmingpolicy switches, per level, and unknown switches are flagged', () => {
  const p = parseAll('farmingpolicy 5 /farmingcycle:4 /safeballs:600');
  eq(p.errors, []);
  eq(p.goals[0].level, 5);
  eq(p.goals[0].switches, { farmingcycle: 4, safeballs: 600 });
  has(parseAll('farmingpolicy /wibble:1').errors[0].error, 'not supported by this build');
});

t('distancepolicy accepts all three spellings', () => {
  eq(parseAll('distancepolicy 12').goals[0].radius, 12);
  eq(parseAll('distancepolicy npc 9').goals[0].switches, { npc: 9 });
  eq(parseAll('distancepolicy /npc:15 /valley:5').goals[0].switches, { npc: 15, valley: 5 });
});

t('excludelist splits coordinates from names', () => {
  const p = parseAll('excludelist 111,222 SomeLord 333,444');
  eq(p.errors, []);
  eq(p.goals[0].coords, [{ x: 111, y: 222 }, { x: 333, y: 444 }]);
  eq(p.goals[0].names, ['somelord']);
});

t('rallypolicy reads the NEAT spelling and the older /npc: one', () => {
  const neat = parseAll('rallypolicy n:10:1 n:8 r:2 t:1 max:8');
  eq(neat.errors, []);
  eq([neat.goals[0].caps, neat.goals[0].levels, neat.goals[0].max], [{ n: 8, r: 2, t: 1 }, { 10: 1 }, 8]);
  eq(parseAll('rallypolicy /npc:3 /valley:2').goals[0].caps, { n: 3, v: 2 });
});

t('goals.js accepts every npc config key without warning', () => {
  const p = G.parseGoals('config npc:5,npclimit:10,ballsused:600,training:1,training10:1,farmingcyclemin:90');
  eq(p.config, { npc: 5, npclimit: 10, ballsused: 600, training: 1, training10: 1, farmingcyclemin: 90 });
  eq(p.errors, [], 'goals.js merges configKeys from the goal modules, so none of these are unknown');
  for (const k of NPC.configKeys) ok(G.CONFIG_KEYS.has(k), `CONFIG_KEYS is missing "${k}"`);
});

// =========================================================== target selection
section('target selection');

t('nearest first, own level only, far camps dropped by the radius', () => {
  const { plan } = run('config npc:5\nnpcheroes any\ndistancepolicy 10');
  const l5 = plan.actions.filter((a) => a.level === 5);
  ok(l5.length >= 3, 'expected several level 5 runs');
  eq(l5.map((a) => `${a.target.x},${a.target.y}`).slice(0, 3), ['101,100', '100,102', '103,100']);
  ok(!plan.actions.some((a) => a.target.x === 160), 'the 60-tile camp must be out of range');
});

t('distancepolicy shrinks the pool', () => {
  const tight = run('config npc:5\ndistancepolicy 2').plan;
  eq(tight.actions.map((a) => `${a.target.x},${a.target.y}`), ['101,100', '100,102']);
});

t('excludelist skips a camp by coordinate', () => {
  const { plan } = run('config npc:5\ndistancepolicy 10\nexcludelist 101,100');
  ok(!plan.actions.some((a) => a.target.x === 101 && a.target.y === 100), 'excluded camp was still targeted');
  eq(plan.actions[0].target, { x: 100, y: 102 });
});

t('npclist restricts to the listed camps', () => {
  const { plan } = run('config npc:5\ndistancepolicy 10\nnpclist 5 105,100');
  eq(plan.actions.length, 1);
  eq(plan.actions[0].target, { x: 105, y: 100 });
});

t('npcbounds restricts to a box', () => {
  const { plan } = run('config npc:5\ndistancepolicy 10\nnpcbounds 5 100 100 100 110');
  ok(plan.actions.every((a) => a.target.x === 100), 'only the x=100 column is inside the box');
});

t('unleveled npc tiles are counted, not targeted', () => {
  const d = I.digestCache(fixtureCache());
  eq(d.unleveled, 1);
  ok(d.npcs.every((x) => x.level >= 1 && x.level <= 10));
  ok(!d.npcs.some((x) => x.x === 99), 'a player city is not an npc camp');
});

// ============================================================= the troop load
section('troop load');

t('safe ballista table per level matches the wiki', () => {
  eq(I.SAFE_BALLISTAS, { 1: 20, 2: 50, 3: 170, 4: 350, 5: 550 });
  for (const level of [1, 2, 3, 4, 5]) {
    const ctx = makeCtx(`config npc:${level}`).ctx;
    const load = I.troopLoadFor(ctx, level, hero(1, 'Strong', 150), { x: 102, y: 100 }, { home: HOME, loadSkill: 100, marchSkill: 100 });
    eq(load.troops.ballista, I.SAFE_BALLISTAS[level], `level ${level} ballistas`);
  }
});

t('transports are the smallest escort that still carries the loot home', () => {
  const ctx = makeCtx('config npc:5').ctx;
  const load = I.troopLoadFor(ctx, 5, hero(1, 'Strong', 150), { x: 103, y: 100 }, { home: HOME, loadSkill: 100, marchSkill: 100 });
  ok(load.ok, load.reason);
  ok(load.space >= load.loot, `hold ${Math.round(load.space)} must cover loot ${load.loot}`);
  const oneFewer = { ...load.troops, carriage: load.troops.carriage - 1 };
  const space = I.capacityOf(oneFewer, 100) - I.marchFoodOf(oneFewer, load.oneWayMs);
  ok(space < load.loot, 'one transport fewer should NOT be enough');
});

t('capacity and march food follow the client formulas', () => {
  // NewArmyWin.as: load = load * count * (1 + loadSkill/100); food = foodRequest*2*count per hour of one-way march
  eq(I.capacityOf({ carriage: 10 }, 100), 10 * 5000 * 2);
  eq(I.capacityOf({ carriage: 10 }, 0), 10 * 5000);
  near(I.marchFoodOf({ ballista: 100 }, 3600000), 100 * 50 * 2, 0.001);
});

t('a stronger Logistics research means fewer transports', () => {
  const ctx = makeCtx('config npc:5').ctx;
  const base = I.troopLoadFor(ctx, 5, hero(1, 'S', 150), { x: 103, y: 100 }, { home: HOME, loadSkill: 100, marchSkill: 100 });
  const better = I.troopLoadFor(ctx, 5, hero(1, 'S', 150), { x: 103, y: 100 }, { home: HOME, loadSkill: 300, marchSkill: 100 });
  ok(better.troops.carriage < base.troops.carriage, `${better.troops.carriage} should be under ${base.troops.carriage}`);
});

t('npctroops overrides both the ballistas and the escort', () => {
  const ctx = makeCtx('config npc:5\nnpctroops 5 b:400,t:120').ctx;
  const load = I.troopLoadFor(ctx, 5, hero(1, 'Strong', 150), { x: 102, y: 100 }, { home: HOME, loadSkill: 100, marchSkill: 100 });
  eq(load.troops, { ballista: 400, carriage: 120 });
});

t('config ballsused changes the ballista count when no npctroops line exists', () => {
  const ctx = makeCtx('config npc:5,ballsused:700').ctx;
  const load = I.troopLoadFor(ctx, 5, hero(1, 'Strong', 150), { x: 102, y: 100 }, { home: HOME, loadSkill: 100, marchSkill: 100 });
  eq(load.troops.ballista, 700);
});

t('levels 6-10 have no built-in load — npctroops is required', () => {
  const bare = makeCtx('config npc:6').ctx;
  const load = I.troopLoadFor(bare, 8, hero(1, 'Strong', 150), { x: 102, y: 100 }, { home: HOME, loadSkill: 100, marchSkill: 100 });
  ok(!load.ok);
  has(load.reason, 'npctroops 8');
  const set = makeCtx('config npc:6\nnpctroops 8 a:90000,wo:2000,w:2000,s:4000,t:2000').ctx;
  const load2 = I.troopLoadFor(set, 8, hero(1, 'Strong', 150), { x: 102, y: 100 }, { home: HOME, loadSkill: 100, marchSkill: 100 });
  eq(load2.troops, { archer: 90000, peasants: 2000, militia: 2000, scouter: 4000, carriage: 2000 });
});

// ========================================================= hero attack < 50
section('hero rules');

t('a hero under 50 attack forces the safe ballista count', () => {
  const ctx = makeCtx('config npc:5,ballsused:1000\nnpctroops 5 b:300,t:100').ctx;
  const strong = I.troopLoadFor(ctx, 5, hero(1, 'Strong', 150), { x: 102, y: 100 }, { home: HOME, loadSkill: 100, marchSkill: 100 });
  const weak = I.troopLoadFor(ctx, 5, hero(3, 'Weakling', 20), { x: 102, y: 100 }, { home: HOME, loadSkill: 100, marchSkill: 100 });
  eq(strong.troops.ballista, 300, 'npctroops stands for a real hero');
  eq(weak.troops.ballista, 550, 'a weak hero is forced back to the safe 550');
  ok(weak.weakHero);
  has(weak.why, 'forced to 550');
});

t('attack is read straight off the attribute, which already includes allocated points', () => {
  const veteran = hero(9, 'Veteran', 45, { powerAdded: 20, powerBuffAdded: 5 });
  eq(I.heroAttack(veteran), 45, 'powerAdded must NOT be added on top');
  eq(I.heroCandidates([veteran], 'any:attack>40').length, 1);
  eq(I.heroCandidates([veteran], 'any:attack>60').length, 0);
  const ctx = makeCtx('config npc:5\nnpctroops 5 b:300,t:100').ctx;
  const load = I.troopLoadFor(ctx, 5, veteran, { x: 102, y: 100 }, { home: HOME, loadSkill: 100, marchSkill: 100 });
  eq(load.troops.ballista, 550, 'attack 45 is under the floor even with 20 allocated points');
});

t('/safeballs decides what "safe" means, even for a weak hero', () => {
  const ctx = makeCtx('config npc:5\nfarmingpolicy 5 /safeballs:620').ctx;
  const weak = I.troopLoadFor(ctx, 5, hero(3, 'Weakling', 20), { x: 102, y: 100 }, { home: HOME, loadSkill: 100, marchSkill: 100 });
  eq(weak.troops.ballista, 620);
});

t('hero string picks by name, by condition, and strongest first', () => {
  const pool = [hero(1, 'Strong', 150), hero(2, 'Middling', 80), hero(3, 'Weakling', 20)];
  eq(I.heroCandidates(pool, 'any').map((h) => h.name), ['Strong', 'Middling', 'Weakling']);
  eq(I.heroCandidates(pool, 'Middling').map((h) => h.name), ['Middling']);
  eq(I.heroCandidates(pool, 'Middling|Weakling').map((h) => h.name), ['Middling', 'Weakling']);
  eq(I.heroCandidates(pool, 'any:attack>100').map((h) => h.name), ['Strong']);
  eq(I.heroCandidates(pool, 'any:attack>900').length, 0);
});

t('hero string: !name vetoes a hero, the rest of "any" still stands', () => {
  const pool = [hero(1, 'Strong', 150), hero(2, 'Middling', 80), hero(3, 'Weakling', 20)];
  eq(I.heroCandidates(pool, '!Strong,any').map((h) => h.name), ['Middling', 'Weakling']);
  eq(I.heroCandidates(pool, '!strong,any').map((h) => h.name), ['Middling', 'Weakling'], 'names are case-insensitive');
  eq(I.heroCandidates(pool, '!Strong,!Weakling,any').map((h) => h.name), ['Middling']);
  eq(I.heroCandidates(pool, '!Strong,any:attack>50').map((h) => h.name), ['Middling']);
});

t('hero string: best is measured against the whole city, not just who is idle', () => {
  const roster = [hero(1, 'Strong', 150), hero(5, 'Brawler', 140)];
  const idle = [roster[1]];                      // Strong is out on a run
  eq(I.heroCandidates(idle, 'any:attack=best', roster).length, 0, 'the runner-up is not "best"');
  eq(I.heroCandidates(roster, 'any:attack=best', roster).map((h) => h.name), ['Strong']);
});

t('npcheroes with a bad hero string is a parse error', () => {
  has(parseAll('npcheroes 5 any:sneakiness>5').errors.map((e) => e.error).join(' '), 'unknown hero field');
  eq(parseAll('npcheroes !OTTO,any').errors, []);
});

t('npcheroes !name,any keeps that hero off every level', () => {
  const { plan } = run([
    'config npc:5', 'distancepolicy 10',
    'npctroops 10 a:90000,wo:2000,w:2000,s:4000,t:2000',
    'npclimits 10 a:100000,s:20000',
    'npcheroes !Strong,any',
  ].join('\n'));
  ok(plan.actions.length >= 3);
  ok(plan.actions.some((a) => a.level === 10) && plan.actions.some((a) => a.level === 5), 'both levels farmed');
  ok(!plan.actions.some((a) => a.hero.name === 'Strong'), 'Strong never marches');
});

t('npcheroes 10 any + npcheroes !name,any: that hero farms 10s only', () => {
  const { plan } = run([
    'config npc:5', 'distancepolicy 10',
    'npctroops 10 a:90000,wo:2000,w:2000,s:4000,t:2000',
    'npclimits 10 a:100000,s:20000',
    'npcheroes 10 any',
    'npcheroes !Strong,any',
  ].join('\n'));
  eq(plan.actions.find((a) => a.level === 10).hero.name, 'Strong', 'the level 10 line lets him in');
  const fives = plan.actions.filter((a) => a.level === 5);
  ok(fives.length >= 1);
  ok(!fives.some((a) => a.hero.name === 'Strong'), 'the level-less line keeps him off 5s');
});

t('several npcheroes lines for one level are OR\'d', () => {
  const ctx = makeCtx('npcheroes 5 Weakling\nnpcheroes 5 any:attack>100\nnpcheroes Rookie').ctx;
  eq(I.heroSpecFor(ctx, 5), 'Weakling|any:attack>100');
  eq(I.heroSpecFor(ctx, 4), 'Rookie', 'a level with no line of its own uses the level-less ones');
  eq(I.heroSpecFor(makeCtx('config npc:5').ctx, 5), 'any', 'no line at all is "any"');
  const pool = fixtureCastle().heros.filter((h) => h.status === 0);
  eq(I.heroCandidates(pool, I.heroSpecFor(ctx, 5)).map((h) => h.name), ['Strong', 'Brawler', 'Scrapper', 'Weakling']);
});

t('npcheroes is honoured per level and the mayor stays home', () => {
  const { plan } = run('config npc:5\ndistancepolicy 3\nnpcheroes 5 Middling');
  ok(plan.actions.length >= 1);
  eq(plan.actions[0].hero.name, 'Middling');
  ok(!plan.actions.some((a) => a.hero.name === 'Mayor'), 'a hero on chief duty (status 1) must not march');
  has(plan.note, 'no idle hero matches');   // only one Middling exists, the rest of the pass stalls
});

// ============================================================ level fallback
section('level fallback');

t('falls to a lower level when the higher one cannot be supplied', () => {
  const castle = fixtureCastle({ troop: { ballista: 400, carriage: 5000 } });
  const { plan } = run('config npc:4\ndistancepolicy 10', { castle });
  ok(plan.actions.length >= 1);
  eq(plan.actions[0].level, 4, '550 ballistas are out of reach, 350 are not');
  has(plan.note, 'L5: stopped — short Ballista');
});

t('level 10 is skipped without an npclimits line, then farms level 5', () => {
  const { plan } = run('config npc:5\ndistancepolicy 10\nnpctroops 10 a:90k,t:100');
  has(plan.note, 'needs "npclimits 10 ..."');
  ok(plan.actions.every((a) => a.level === 5));
});

t('level 10 runs once npclimits and npctroops are both set', () => {
  const { plan } = run([
    'config npc:5', 'distancepolicy 10',
    'npctroops 10 a:90000,wo:2000,w:2000,s:4000,t:2000',
    'npclimits 10 a:100000,s:20000',
    'npcheroes 10 any:attack>100',
  ].join('\n'));
  const tens = plan.actions.filter((a) => a.level === 10);
  eq(tens.length, 2, 'both level 10 camps in range');
  ok(tens.every((a) => a.heroAttack > 100), 'npcheroes 10 restricted the hero pool');
  eq(tens[0].troops, { archer: 90000, peasants: 2000, militia: 2000, scouter: 4000, carriage: 2000 });
  ok(plan.actions.findIndex((a) => a.level === 10) === 0, 'highest level is farmed first');
});

t('npclimits stops the level before the garrison drops below it', () => {
  const castle = fixtureCastle({ troop: { archer: 150000, scouter: 30000, carriage: 5000, militia: 20000, peasants: 20000 } });
  const { plan } = run([
    'config npc:10', 'distancepolicy 10',
    'npctroops 10 a:90000,wo:2000,w:2000,s:4000,t:2000',
    'npclimits 10 a:100000,s:20000',
  ].join('\n'), { castle });
  eq(plan.actions.length, 0, '150k archers minus 90k would break the 100k floor');
  has(plan.note, 'npclimits 10');
});

// ============================================================== concurrency
section('concurrency');

t('npcteams caps the runs planned in one pass', () => {
  const { plan } = run('config npc:5\ndistancepolicy 10\nnpcteams 2');
  eq(plan.actions.length, 2);
  has(plan.note, 'npcteams 2');
});

t('rallypolicy /npc and the rally spot level both cap it', () => {
  eq(run('config npc:5\ndistancepolicy 10\nnpcteams 9\nrallypolicy /npc:3').plan.actions.length, 3);
  const castle = fixtureCastle({ buildings: [{ typeId: 29, level: 1, positionId: 3 }] });
  const one = run('config npc:5\ndistancepolicy 10\nnpcteams 9', { castle }).plan;
  eq(one.actions.length, 1);
  has(one.note, 'rally spot L1');
});

// wiki NpcTeams: npcteams counts farming teams. A transport is not one, but it
// still holds a rally slot.
t('attacks in the air take team slots; a transport takes only a rally slot', () => {
  const selfArmys = [
    { startFieldId: HOME_ID, targetFieldId: C.coordsToFieldId(101, 100), missionType: 5, startTime: Date.now(), hero: { id: 1 } },
    { startFieldId: HOME_ID, targetFieldId: C.coordsToFieldId(500, 500), missionType: 1, startTime: Date.now() },
  ];
  const { plan } = run('config npc:5\ndistancepolicy 10\nnpcteams 3', { selfArmys });
  eq(plan.actions.length, 2, '3 teams, 1 attack out');
  has(plan.note, 'rally spot L10: 2/10 busy');
  ok(!plan.actions.some((a) => a.target.x === 101 && a.target.y === 100), 'the camp already under attack is skipped');
  ok(!plan.actions.some((a) => a.heroId === 1), 'a hero already marching cannot be sent again');

  const castle = fixtureCastle({ buildings: [{ typeId: 29, level: 3, positionId: 3 }] });
  const tight = run('config npc:5\ndistancepolicy 10\nnpcteams 3', { castle, selfArmys }).plan;
  eq(tight.actions.length, 1, 'rally spot L3 with 2 marches out leaves one slot');
});

t('transports filling the rally spot stop npc farming, and say so', () => {
  const castle = fixtureCastle({ buildings: [{ typeId: 29, level: 2, positionId: 3 }] });
  const selfArmys = [1, 2].map((i) => ({ startFieldId: HOME_ID, targetFieldId: C.coordsToFieldId(400 + i, 400), missionType: 1, startTime: Date.now() }));
  const { plan } = run('config npc:5\ndistancepolicy 10\nnpcteams 3', { castle, selfArmys });
  eq(plan.actions.length, 0);
  has(plan.note, 'no rally slot — rally spot L2: 2/2 busy');
});

t('rallypolicy max: and n:<level>: cap the runs', () => {
  eq(run('config npc:5\ndistancepolicy 10\nnpcteams 9\nrallypolicy max:4').plan.actions.length, 4);
  const one = run('config npc:4\ndistancepolicy 10\nnpcteams 9\nrallypolicy n:5:1').plan;
  eq(one.actions.filter((a) => a.level === 5).length, 1, 'one level 5 run');
  ok(one.actions.some((a) => a.level === 4), 'level 4 still farms');
  ok(!JSON.stringify(one.actions[0]).includes('"rally"'), 'the rally tag stays out of JSON');
});

t('nothing is planned when every team is out', () => {
  const selfArmys = [1, 2].map((i) => ({ startFieldId: HOME_ID, targetFieldId: C.coordsToFieldId(100 + i, 100), missionType: 5, startTime: Date.now() }));
  const { plan } = run('config npc:5\ndistancepolicy 10\nnpcteams 2', { selfArmys });
  eq(plan.actions.length, 0);
  has(plan.note, 'teams already out');
});

// ============================================================ cycle & cooldown
section('cycle and cooldown');

t('a camp hit in this pass is not hit again until the next one', () => {
  const state = {};
  const first = run('config npc:5\ndistancepolicy 10\nnpcteams 1', { state });
  eq(first.plan.actions.length, 1);
  const hit = first.plan.actions[0];
  I.recordSend(state, hit, { ok: 1 });

  // the run is still in the air: its slot is taken
  const during = run('config npc:5\ndistancepolicy 10\nnpcteams 1', { state });
  eq(during.plan.actions.length, 0);
  has(during.plan.note, 'teams already out');

  // once it is home, the pass moves to the NEXT camp, not the same one
  const later = run('config npc:5\ndistancepolicy 10\nnpcteams 1', { state, now: Date.now() + hit.roundTripMs + 120000 });
  eq(later.plan.actions.length, 1);
  ok(later.plan.actions[0].fieldId !== hit.fieldId, 'the same camp was hit twice inside one cycle');
});

t('when the pass is done it waits for the cycle, then starts again at the nearest', () => {
  const state = {};
  const src = 'config npc:5\ndistancepolicy 10\nnpcteams 5';
  const first = run(src, { state });
  const camps = first.plan.actions.length;
  ok(camps >= 3);
  for (const a of first.plan.actions) I.recordSend(state, a, { ok: 1 });

  const done = run(src, { state, now: Date.now() + 3600000 });   // an hour later, all home
  eq(done.plan.actions.length, 0);
  has(done.plan.note, 'pass complete');

  const next = run(src, { state, now: Date.now() + 9 * 3600000 });  // past the 8h cycle
  eq(next.plan.actions.length, camps, 'the whole pass comes back round');
  eq(next.plan.actions[0].target, { x: 101, y: 100 }, 'and it restarts at the nearest camp');
});

t('the cycle is 8h by default, /farmingcycle and config farmingcycle override it, training makes it hourly', () => {
  const c = (src, level = 5) => I.cycleMsFor(makeCtx(src).ctx, level) / 3600000;
  eq(c('config npc:5'), 8);
  eq(c('config npc:5,farmingcycle:4'), 4);
  eq(c('config npc:5,farmingcycle:4\nfarmingpolicy 5 /farmingcycle:2'), 2, '/farmingcycle wins over config');
  eq(c('config npc:5,training:1,farmingcycle:4'), 1, 'training beats everything');
  eq(c('config npc:5,training10:1', 10), 1);
  eq(c('config npc:5,training10:1', 5), 8, 'training10 only speeds up the tens');
  eq(c('config npc:5,farmingcyclemin:600'), 10, 'farmingcyclemin is a floor in minutes');
});

t('npclimit parks farming once the city is fat, unless training is on', () => {
  const castle = fixtureCastle({ troop: { ballista: 5000, carriage: 5000 }, resource: { food: { amount: 200e6 } } });
  const days = I.foodDays(castle);
  ok(days > 10, `fixture should hold plenty of food, got ${days.toFixed(1)}d`);
  const parked = run('config npc:5,npclimit:10\ndistancepolicy 10', { castle }).plan;
  eq(parked.actions.length, 0);
  has(parked.note, 'farming paused');
  const training = run('config npc:5,npclimit:10,training:1\ndistancepolicy 10', { castle }).plan;
  ok(training.actions.length > 0, 'training:1 keeps hitting npcs for the experience');
});

t('food days maths uses the garrison upkeep', () => {
  // 1000 ballistas eat 50/hr each = 50,000/hr = 1.2M/day
  const c = fixtureCastle({ troop: { ballista: 1000 }, resource: { food: { amount: 1200000 } } });
  near(I.foodDays(c), 1, 0.001);
  eq(I.foodDays(fixtureCastle({ troop: {} })), Infinity, 'no troops, no upkeep');
});

t('a camp further away than one cycle round trip is left alone', () => {
  // ballistas cover a tile in 5 minutes each way, so on the hourly training cycle
  // anything past 6 tiles can never get home before the next pass is due
  const cache = fixtureCache([[5, 101, 100], [5, 120, 100], [5, 100, 130]]);
  const { plan } = run('config npc:5,training:1\ndistancepolicy 40\nnpcteams 5', { cache });
  eq(plan.actions.length, 1);
  eq(plan.actions[0].target, { x: 101, y: 100 });
  ok(plan.actions.every((a) => a.roundTripMs <= a.cycleMs), 'planned a run it cannot finish inside the cycle');
  has(plan.note, '2 camp(s) skipped — round trip longer than the 1.0h cycle');
});

// ============================================================= empty cupboard
section('nothing to send with');

t('no troops at all', () => {
  const castle = fixtureCastle({ troop: {} });
  const { plan } = run('config npc:5\ndistancepolicy 10', { castle });
  eq(plan.actions.length, 0);
  has(plan.note, 'short Ballista');
});

t('no transports', () => {
  const castle = fixtureCastle({ troop: { ballista: 5000 } });
  const { plan } = run('config npc:5\ndistancepolicy 10', { castle });
  eq(plan.actions.length, 0);
  has(plan.note, 'short Transporter');
});

t('no hero', () => {
  const castle = fixtureCastle({ heros: [] });
  const { plan } = run('config npc:5\ndistancepolicy 10', { castle });
  eq(plan.actions.length, 0);
  has(plan.note, 'no idle hero');
});

t('every hero is busy elsewhere', () => {
  const castle = fixtureCastle({ heros: [hero(1, 'Marching', 150, { status: 3 }), hero(4, 'Mayor', 200, { status: 1 }), hero(5, 'Captured', 90, { status: 4 })] });
  const { plan } = run('config npc:5\ndistancepolicy 10', { castle });
  eq(plan.actions.length, 0);
  has(plan.note, 'no idle hero');
});

t('config npc:0 (or absent) means the goal is off', () => {
  eq(run('config comfort:1').plan, null);
  eq(run('config npc:0').plan, null);
});

t('an empty map cache is reported, not crashed on', () => {
  const { plan } = run('config npc:5', { cache: { castles: {} } });
  eq(plan.actions, []);
  has(plan.note, 'no npc camps');
  const unleveled = run('config npc:5', { cache: { castles: { 1: { id: 1, x: 1, y: 1, npc: true } } } }).plan;
  has(unleveled.note, 'without a level');
});

// ========================================================= the real map cache
section('the real mapcache.json (read only)');

const CACHE_PATH = path.join(__dirname, 'mapcache.json');
if (!fs.existsSync(CACHE_PATH)) {
  console.log('  skip  mapcache.json is not present');
} else {
  const real = I.loadNpcCache(CACHE_PATH);
  const byLevel = {};
  for (const c of real.npcs) byLevel[c.level] = (byLevel[c.level] || 0) + 1;
  console.log(`        ${real.npcs.length} levelled npc camps, ${real.unleveled} without a level, levels ${JSON.stringify(byLevel)}`);

  t('the cache digests into levelled camps', () => {
    ok(real.ok);
    ok(real.npcs.length > 0, 'the real cache should hold some levelled npc camps');
    ok(real.npcs.every((c) => c.level >= 1 && c.level <= 10 && Number.isFinite(c.x) && Number.isFinite(c.y)));
    ok(real.unleveled > 0, 'a plain mapscan.js sweep stores npcs with no level — that is expected');
  });

  t('coordinates round-trip through the field id', () => {
    for (const c of real.npcs.slice(0, 50)) eq(C.fieldIdToCoords(c.id), { x: c.x, y: c.y }, `camp ${c.id}`);
  });

  // plant the test city in the middle of the real level 5 cluster
  const fives = real.npcs.filter((c) => c.level === 5);
  const centre = fives.length
    ? { x: Math.round(fives.reduce((s, c) => s + c.x, 0) / fives.length), y: Math.round(fives.reduce((s, c) => s + c.y, 0) / fives.length) }
    : { x: 100, y: 100 };

  t(`plans real runs from ${centre.x},${centre.y}`, () => {
    const castle = fixtureCastle({ fieldId: C.coordsToFieldId(centre.x, centre.y) });
    const { plan } = run('config npc:5\ndistancepolicy 12\nnpcteams 4', { castle, cache: JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8').replace(/^﻿/, '')) });
    ok(plan.actions.length > 0, plan.note);
    eq(plan.actions.length, 4);
    ok(plan.actions.every((a) => a.level === 5));
    ok(plan.actions.every((a) => a.troops.ballista === 550 && a.troops.carriage > 0));
    const dists = plan.actions.map((a) => a.distance);
    eq(dists, dists.slice().sort((x, y) => x - y), 'nearest first');
    console.log(`        ${plan.note}`);
    for (const a of plan.actions) console.log(`        - ${a.label}`);
  });

  t('the same plan is stable when it is asked twice (no hidden state drift)', () => {
    const castle = fixtureCastle({ fieldId: C.coordsToFieldId(centre.x, centre.y) });
    const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8').replace(/^﻿/, ''));
    const state = {};
    const a = run('config npc:5\ndistancepolicy 12\nnpcteams 2', { castle, cache, state }).plan;
    const b = run('config npc:5\ndistancepolicy 12\nnpcteams 2', { castle, cache, state }).plan;
    eq(a.actions.map((x) => x.fieldId), b.actions.map((x) => x.fieldId));
  });

  t('the cache file was not touched', () => {
    const before = fs.statSync(CACHE_PATH).mtimeMs;
    I.loadNpcCache(CACHE_PATH);
    eq(fs.statSync(CACHE_PATH).mtimeMs, before);
  });
}

// ================================================================== executor
section('executor');

t('npcAttack builds the army bean the client would', () => {
  const castle = fixtureCastle();
  const { plan, state } = run('config npc:5\ndistancepolicy 3\nnpcteams 1');
  const action = plan.actions[0];
  let sent = null;
  const game = {
    castleId: (c) => c.castleId,
    buildArmyBean: require('./game').Game.prototype.buildArmyBean,
    newArmy: async (castleId, bean) => { sent = { castleId, bean }; return { ok: 1 }; },
  };
  return NPC.executors.npcAttack(game, castle, action, state).then(() => {
    eq(sent.castleId, 7);
    eq(sent.bean.missionType, C.MISSION.attack, 'attack is mission 5');
    eq(sent.bean.targetPoint, action.fieldId);
    eq(sent.bean.heroId, action.heroId);
    eq(sent.bean.troops.ballista, 550);
    eq(sent.bean.troops.militia, 0, 'the bean carries every troop key');
    eq(sent.bean.resource, { iron: 0, food: 0, wood: 0, stone: 0, gold: 0 });
    ok(state.npc.hits[action.fieldId] > 0, 'a successful send records the hit');
    eq(state.npc.runs.length, 1);
    eq(state.npc.npcHits, 1);
  });
});

t('a refused send records nothing', () => {
  const state = {};
  I.recordSend(state, { fieldId: 1, level: 5, roundTripMs: 1000 }, { ok: 0, errorMsg: 'no' });
  eq(state.npc, undefined);
});

t('the state reference on an action is not serialised into reports', () => {
  const { plan } = run('config npc:5\ndistancepolicy 3\nnpcteams 1');
  ok(plan.actions[0].state, 'the executor can still reach it');
  ok(!JSON.stringify(plan.actions[0]).includes('"state"'), 'but it stays out of JSON');
});

// ===================================================================== done
setTimeout(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 50);
