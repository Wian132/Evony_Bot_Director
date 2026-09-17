'use strict';
// Step 20: valleys, flats and abandoning, as the NEAT wiki describes them
// (Valley, ValleyMin, ValleyFarming, SafeValleyFarming, ValleyHeroes,
// ValleyLimit, ValleyTroops, Hunting, HuntingPos, HuntingType, AcquireFlats,
// AbandonFlats, Abandon, BuildNpc, NpcBuildPolicy, DistancePolicy, ExcludeList,
// RallyPolicy, NpcTeams), and buildnpc's capture -> found -> expire flow.
// Offline: fixture objects, a fake game and a throwaway database — nothing here
// connects, logs in or sends a byte to the game.
//
//   node test-valleys.js
const assert = require('assert');
const path = require('path'), os = require('os'), fs = require('fs');
if (!process.env.EVONY_DB) process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-valleys-')), 't.db');

const C = require('./constants');
const D = require('./db');
const G = require('./goals');
const V = require('./goal-valley');
const B = require('./goal-buildnpc');
const NPC = require('./goal-npc');
const { Engine } = require('./engine');
const { Game } = require('./game');

const I = V._internals;
const BI = B._internals;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok    ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + String((e && e.message) || e).split('\n').slice(0, 14).join('\n        ')); fail++; }
}
const section = (s) => console.log(`\n${s}\n`);
const eq = assert.deepStrictEqual;
const has = (s, sub) => assert.ok(String(s).includes(sub), `"${s}" does not contain "${sub}"`);
const H1 = 3600000;
const NOW = Date.now();

// ------------------------------------------------------------------ fixtures
const HOME = { x: 100, y: 100 };
const fid = (x, y) => C.coordsToFieldId(x, y);
const hero = (id, name, power, extra = {}) => ({ id, name, power, powerAdded: 0, management: 10, stratagem: 10, level: 20, loyalty: 100, status: 0, ...extra });
const crew = () => [hero(1, 'Strong', 150), hero(2, 'Brawler', 140), hero(3, 'Scrapper', 110), hero(6, 'Mayor', 200, { status: 1 })];

// A lumber city: three sawmills at level 10, a Town Hall at level `th`, a
// level-10 Rally Spot, plenty of everything.
function city(over = {}) {
  const th = over.th === undefined ? 5 : over.th;
  const c = {
    castleId: 7, id: 7, name: 'Testville', fieldId: fid(HOME.x, HOME.y),
    troop: { militia: 500000, archer: 500000, scouter: 100000, pikemen: 10000, swordsmen: 10000, lightCavalry: 100000,
      ballista: 20000, carriage: 10000, peasants: 10000 },
    heros: crew(),
    resource: { food: { amount: 1e9 }, wood: { amount: 1e6 }, stone: { amount: 1e6 }, iron: { amount: 1e6 }, gold: 1e6, support: 100, texRate: 10 },
    buildings: [
      { typeId: 31, level: th, positionId: 1 }, { typeId: 29, level: 10, positionId: 3 },
      { typeId: 4, level: 10, positionId: 1001 }, { typeId: 4, level: 10, positionId: 1002 }, { typeId: 4, level: 10, positionId: 1003 },
      { typeId: 7, level: 5, positionId: 1004 },
    ],
    fields: [], fortification: {},
  };
  delete over.th;
  return Object.assign(c, over);
}
// A field this city holds (FieldBean).
const field = (x, y, kind, level) => ({ id: fid(x, y), type: { forest: 1, desert: 2, hill: 3, swamp: 4, grassland: 5, lake: 6, flat: 10 }[kind], level, name: kind });
// A map-cache tile, read just now.
const tile = (x, y, kind, level, extra = {}) => ({ id: fid(x, y), x, y, kind, level, seen: NOW, ...extra });

function fakeGame(castles, { selfArmys = [], fieldInfo = null, titleId = 9, reports = [], reportContent = {} } = {}) {
  const g = {
    castles, player: { playerInfo: { userName: 'Me', titleId }, selfArmys, enemyArmys: [], items: [] },
    sent: [], reqs: [], built: [], gaveUp: [],
    marchSkillParam: 100, loadSkillParam: 100,
    now: () => Date.now(),
    castleId: (c) => c.castleId,
    castleXY: (c) => C.fieldIdToCoords(c.fieldId),
    buildArmyBean: (o) => Game.prototype.buildArmyBean.call(g, o),
    newArmy: async (castleId, bean) => { g.sent.push({ castleId, bean }); return g.armyReply ? g.armyReply(bean) : { ok: 1 }; },
    req: async (cmd, data) => {
      g.reqs.push([cmd, data]);
      if (cmd === 'field.getOtherFieldInfo') return fieldInfo ? fieldInfo(data.fieldId) : { ok: 1, bean: { userName: null, canOccupy: true, canScout: true } };
      if (cmd === 'field.giveUpField') { g.gaveUp.push(data.fieldId); return { ok: 1 }; }
      if (cmd === 'troop.getProduceQueue') return { ok: 1, allProduceQueue: [{ positionId: 4, allProduceQueue: [{ queueId: 11, type: 7, num: 100 }] }] };
      if (cmd === 'fortifications.getProduceQueue') return { ok: 1, allProduceQueue: [{ positionId: -2, allProduceQueue: [{ queueId: 21, type: 15, num: 50 }] }] };
      return { ok: 1 };
    },
    fieldInfo: (id) => g.req('field.getOtherFieldInfo', { fieldId: id }),
    giveUpField: (id) => g.req('field.giveUpField', { fieldId: id }),
    constructCastle: async (castleId, fieldId, isTroopBack) => { g.built.push({ castleId, fieldId, isTroopBack }); return g.buildReply ? g.buildReply() : { ok: 1 }; },
    disbandTroop: (castleId, troopType, num) => g.req('troop.disbandTroop', { castleId, troopType, num }),
    destructWall: (castleId, typeId, num) => g.req('fortifications.destructWallProtect', { castleId, typeId, num }),
    setTax: (castleId, tax) => g.req('interior.modifyTaxRate', { castleId, tax }),
    levy: (castleId, typeId) => g.req('interior.taxation', { castleId, typeId }),
    cancelTroop: (castleId, positionId, queueId) => g.req('troop.cancelTroopProduce', { castleId, positionId, queueId }),
    cancelWall: (castleId, queueId) => g.req('fortifications.cancelFortificationProduce', { castleId, queueId }),
    reportList: async () => ({ ok: 1, reports }),
    readReport: async (id) => ({ ok: 1, report: { id, content: reportContent[id] } }),
  };
  return g;
}
const reqsOf = (g, cmd) => g.reqs.filter(([c]) => c === cmd).map(([, d]) => d);

// A plan the way the engine makes one: the real goal parser, the map tiles in hand.
function ctxFor(src, over = {}) {
  const parsed = G.parseGoals(src);
  const castle = over.castle || city();
  const game = over.game || fakeGame([castle, ...(over.others || [])]);
  return {
    game, castle, goals: parsed.goals, config: parsed.config, controls: over.controls || {}, incoming: over.incoming || [],
    mapTiles: over.tiles || [], now: over.now || NOW, maintEndedAt: over.maintEndedAt || 0, accountId: over.accountId,
    maintPlan: over.maintPlan === undefined ? null : over.maintPlan, parsed, ...(over.ctx || {}),
  };
}
function plan(name, src, over = {}) {
  const ctx = ctxFor(src, over);
  const state = over.state || {};
  const p = V.plans[name](ctx, state, ctx.game);
  return { p, ctx, state, game: ctx.game, castle: ctx.castle };
}
const lineOf = (src) => G.parseGoals(src).lines[0];

// Forests around (100,100): L5 at 3 tiles, L6 at 4, L8 at 8, L5 at 12; a L5
// hill at 2; a L10 forest at 6; a L10 hill at 5.
const RING = () => [
  tile(103, 100, 'forest', 5), tile(100, 104, 'forest', 6), tile(108, 100, 'forest', 8), tile(112, 100, 'forest', 5),
  tile(102, 100, 'hill', 5), tile(100, 106, 'forest', 10), tile(105, 100, 'hill', 10),
];

(async () => {
  // =================================================================== parsing
  section('the goal lines, as the wiki writes them');

  await t('config valley / valleymin / valleyfarming / hunting: levels 0-10, anything else is red', () => {
    for (const src of ['config valley:10', 'config valley:0', 'config valleymin:1', 'config valley:10,valleymin:5',
      'config valleyfarming:10', 'config hunting:0', 'config hunting:5', 'config hunting:10']) {
      eq(lineOf(src).status, 'ok', src);
    }
    for (const src of ['config valley:11', 'config valley:abc', 'config valleymin:2.5', 'config valleyfarming:11', 'config hunting:12', 'config hunting:x']) {
      eq(lineOf(src).status, 'error', src);
    }
    has(lineOf('config valley:11').msg, 'the valley level to capture, 1 to 10');
    const bare = G.parseGoals('hunting 5');
    eq([bare.config.hunting, bare.lines[0].status], [5, 'ok'], 'a bare hunting line reads as the config it means');
    has(bare.lines[0].msg, 'read as "config hunting:5"');
  });

  await t('config acquireflats 0/1/2, abandonflats 0/1, abandon 0/1', () => {
    for (const src of ['config acquireflats:0', 'config acquireflats:1', 'config acquireflats:2', 'config abandonflats:1', 'config abandon:0', 'config abandon:1']) {
      eq(lineOf(src).status, 'ok', src);
    }
    for (const src of ['config acquireflats:3', 'config abandonflats:2', 'config abandon:5']) eq(lineOf(src).status, 'error', src);
    // NEAT's script form "abandon x,y" is not a goal
    eq(lineOf('abandon 111,222').status, 'error');
  });

  await t('config buildnpc takes the wiki\'s codes: 0, 1-5, 10, 15, 20', () => {
    for (const v of [0, 1, 2, 3, 4, 5, 10, 15, 20]) eq(lineOf(`config buildnpc:${v}`).status, 'ok', String(v));
    for (const v of [6, 7, 8, 9, 11, 25, 'on']) eq(lineOf(`config buildnpc:${v}`).status, 'error', String(v));
    eq(V.buildWanted({ buildnpc: 15 }), { on: true, all: false, levels: [5, 10] });
    eq(V.buildWanted({ buildnpc: 20 }).all, true);
    eq(V.buildWanted({ buildnpc: 0 }), { on: false });
    eq(V.buildWanted({}), { on: false });
  });

  await t('the valley and flat keys are off the NOT_IMPLEMENTED table and come out blue', () => {
    for (const k of ['valley', 'valleymin', 'valleyfarming', 'hunting', 'abandon', 'abandonflats', 'acquireflats']) {
      assert.ok(!(k in G.NOT_IMPLEMENTED.config), `${k} is still on the table`);
    }
    eq(lineOf('config valley:10,valleymin:5,hunting:5,acquireflats:1,abandonflats:1,valleyfarming:10'), { n: 1, status: 'ok', msg: null });
  });

  await t('valleyfarming: the six miles (forest desert hill swamp grassland lake), and config valleyfarming:<level>', () => {
    const p = G.parseGoals('valleyfarming 5 0 5 0 0 0');
    eq(p.errors, []);
    eq(p.goals[0].miles, { forest: 5, desert: 0, hill: 5, swamp: 0, grassland: 0, lake: 0 });
    eq(G.parseGoals('valleyfarming 10 3 10 3 3 3').goals[0].miles.hill, 10);
    eq(G.parseGoals('valleyfarming 10.5 0 0 0 0 0').goals[0].miles.forest, 10.5, 'fractions, as distancepolicy');
    for (const src of ['valleyfarming 10', 'valleyfarming 5 0 5 0 0 0 1', 'valleyfarming a 0 5 0 0 0']) eq(lineOf(src).status, 'error', src);
    has(lineOf('valleyfarming 10').msg, 'the level to farm is config valleyfarming:<level>');
    eq(G.parseGoals('config valleyfarming:10\nvalleyfarming 5 0 5 0 0 0').errors, [], 'both forms together');
  });

  await t('valleyheroes: a hero string, OR\'d over lines, /reset (the wiki\'s examples)', () => {
    // wiki: "valleyheroes !AttackDude,!ValleyGuy" — the ! there is the wiki's
    // link escape before a CamelCase name, and the page says only those two go
    const a = G.parseGoals('valleyheroes AttackDude,ValleyGuy');
    eq(a.errors, []);
    eq(I.heroSpec({ goals: a.goals }).spec, 'AttackDude,ValleyGuy');
    const b = G.parseGoals('valleyheroes !trainingheroname,any:attack>60');
    eq(b.errors, []);
    const two = G.parseGoals('valleyheroes Bob\nvalleyheroes any:attack>100');
    eq(I.heroSpec({ goals: two.goals }).spec, 'Bob|any:attack>100');
    const reset = G.parseGoals('valleyheroes Bob\nvalleyheroes /reset\nvalleyheroes Fred');
    eq(I.heroSpec({ goals: reset.goals }).spec, 'Fred');
    eq(I.heroSpec({ goals: [] }).spec, 'any', 'the default: any available hero');
    eq(lineOf('valleyheroes any:wibble>3').status, 'error');
    eq(lineOf('valleyheroes').status, 'error');
  });

  await t('valleylimit <troops>, as NpcLimits (wiki: valleylimit w:100k,a:50k)', () => {
    const p = G.parseGoals('valleylimit w:100k,a:50k');
    eq(p.errors, []);
    eq(p.goals[0].troops, { militia: 100000, archer: 50000 });
    eq(lineOf('valleylimit').status, 'error');
    eq(lineOf('valleylimit q:5').status, 'error');
  });

  await t('valleytroops [/type:] [/level:] [level] <troops> — every example on the wiki page reads', () => {
    const src = ['valleytroops 1 s:5000', 'valleytroops 2 s:5000', 'valleytroops 3 s:5000', 'valleytroops 4 s:10000', 'valleytroops 5 s:10000',
      'valleytroops 6 s:50000', 'valleytroops 7 s:50000', 'valleytroops 8 s:100000', 'valleytroops 9 a:12800,sw:1,p:1,s:1,w:40000',
      'valleytroops 10 a:19990,sw:1,p:1,s:1,w:60000', 'valleytroops /level:10 /type:forest s:100000'].join('\n');
    const p = G.parseGoals(src);
    eq(p.errors, []);
    eq(p.goals[8], { ...p.goals[8], level: 9, type: null, troops: { archer: 12800, swordsmen: 1, pikemen: 1, scouter: 1, militia: 40000 } });
    eq([p.goals[10].level, p.goals[10].type, p.goals[10].troops], [10, 'forest', { scouter: 100000 }]);
    for (const [w, k] of [['fo', 'forest'], ['d', 'desert'], ['h', 'hill'], ['s', 'swamp'], ['g', 'grassland'], ['l', 'lake'], ['fl', 'flat'], ['grassland', 'grassland']]) {
      eq(G.parseGoals(`valleytroops /type:${w} a:1`).goals[0].type, k, w);
    }
    eq(lineOf('valleytroops /type:moon a:1').status, 'error');
    eq(lineOf('valleytroops /level:11 a:1').status, 'error');
    eq(lineOf('valleytroops 5').status, 'error', 'no troops');
    has(lineOf('valleytroops 4 /level:5 a:1').msg, 'disagree');
  });

  await t('safevalleyfarm <levels> | off; huntingpos x,y; huntingtype <type>', () => {
    eq(G.parseGoals('safevalleyfarm 10').goals[0].levels, [10]);
    eq(G.parseGoals('safevalleyfarm 9,10').goals[0].levels, [9, 10]);
    eq(G.parseGoals('safevalleyfarm off').goals[0].off, true);
    eq(G.parseGoals('safevalleyfarming 9,10').goals[0].levels, [9, 10], 'the page\'s own name reads too');
    eq(lineOf('safevalleyfarm 11').status, 'error');
    eq(lineOf('safevalleyfarm').status, 'error');
    eq(G.parseGoals('huntingpos 111,222').goals[0].coord, { x: 111, y: 222 });
    eq(lineOf('huntingpos 111').status, 'error');
    eq(lineOf('huntingpos 900,1').status, 'error');
    eq(G.parseGoals('huntingtype desert').goals[0].kind, 'desert');
    eq(G.parseGoals('huntingtype flat').goals[0].kind, 'flat');
    eq(lineOf('huntingtype moon').status, 'error');
  });

  await t('npcbuildpolicy: the NEAT switches, level ranges, max = min + 1; the older form still reads', () => {
    const a = G.parseGoals('npcbuildpolicy /level:10 /mindistance:1 /maxdistance:5');
    eq(a.errors, []);
    eq([a.goals[0].levels, a.goals[0].from, a.goals[0].to], [[10], 1, 5]);
    const b = G.parseGoals('npcbuildpolicy /level:5 /mindistance:5');
    eq([b.goals[0].from, b.goals[0].to], [5, 6], 'wiki: "If a maxdistance is not set, the bot defaults to mindistance + 1 mile"');
    eq(G.parseGoals('npcbuildpolicy /level:1-4 /mindistance:10 /maxdistance:20').goals[0].levels, [1, 2, 3, 4]);
    eq(G.parseGoals('npcbuildpolicy /level:1-10 /maxdistance:8').goals[0].levels.length, 10);
    const old = G.parseGoals('npcbuildpolicy 10 0-5');
    eq(old.errors, []);
    eq([old.goals[0].level, old.goals[0].levels, old.goals[0].from, old.goals[0].to], [10, [10], 0, 5]);
    for (const src of ['npcbuildpolicy /level:11 /maxdistance:5', 'npcbuildpolicy /mindistance:1', 'npcbuildpolicy /level:5', 'npcbuildpolicy /level:5 /far:3']) {
      eq(lineOf(src).status, 'error', src);
    }
    // the wiki's common examples, whole
    eq(G.parseGoals('config buildnpc:15\nnpcbuildpolicy /level:10 /mindistance:1 /maxdistance:5\nnpcbuildpolicy /level:5 /mindistance:5 /maxdistance:15').errors, []);
    eq(G.parseGoals('config buildnpc:20\nnpcbuildpolicy /level:10 /mindistance:1 /maxdistance:5\nnpcbuildpolicy /level:5 /mindistance:5 /maxdistance:10\nnpcbuildpolicy /level:1-4 /mindistance:10 /maxdistance:20').errors, []);
  });

  await t('the live goal texts read the same, and no valley goal runs for them', () => {
    const live = `config comfort:1,hero:1,troopsusepopmax:1,npc:5
comfortpolicy 15 16 popraise
build f:10:37
troop b:5k,t:5k
fortification ab:5000
distancepolicy 15
npcteams 3
traininghero OTTO 30 60
npcheroes !OTTO,any
farmingpolicy 10 /distance:5
farmingpolicy 5 /distance:10`;
    const c = ctxFor(live, { tiles: RING() });
    eq(c.parsed.errors, []);
    for (const k of Object.keys(V.plans)) eq(V.plans[k](c, {}, c.game), null, k);
    eq(B.plans.buildnpc(c, {}, c.game), null);
    eq(V.scanArea(c), null, 'and the map scan reads no further for them');
  });

  // ============================================================ valley capture
  section('config valley: capture valleys for production (wiki Valley, ValleyMin)');

  await t('the type comes from the resource fields: forests for lumber, hills for iron, deserts for stone, lakes for food', () => {
    const with_ = (typeId) => city({ buildings: [{ typeId: 31, level: 5 }, { typeId, level: 9 }, { typeId: 7, level: 3 }] });
    eq(I.cityResource(with_(4)).kind, 'forest');
    eq(I.cityResource(with_(6)).kind, 'hill');
    eq(I.cityResource(with_(5)).kind, 'desert');
    eq(I.cityResource(city({ buildings: [{ typeId: 7, level: 9 }] })).kind, 'lake');
    eq(I.cityResource(city({ buildings: [{ typeId: 4, level: 5 }, { typeId: 6, level: 5 }] })).kind, 'forest', 'a tie goes lumber first, as the wiki lists them');
    const none = plan('valley', 'config valley:5', { castle: city({ buildings: [{ typeId: 31, level: 5 }] }), tiles: RING() });
    has(none.p.note, 'no resource fields yet');
    eq(none.p.actions, []);
  });

  await t('valley alone is the level to capture: the nearest free L5 forest within 10 tiles, never the hill or the L6', () => {
    const { p } = plan('valley', 'config valley:5', { tiles: RING() });
    eq(p.actions.length, 1);
    const a = p.actions[0];
    eq([a.kind, a.purpose, a.capture, a.target, a.level, a.type], ['valleyAttack', 'capture', true, { x: 103, y: 100 }, 5, 'forest']);
    has(p.note, 'forests for lumber');
    eq(a.troops, { militia: 2400, scouter: 1, pikemen: 1, swordsmen: 1, lightCavalry: 1, archer: 800 }, 'wiki ValleyTroops default, level 5');
    eq([a.heroId, a.hero], [1, 'Strong'], 'the strongest idle attack hero');
    eq(a.rally.kind, 'v');
    eq(a.rally.missionType, C.MISSION.attack);
  });

  await t('distancepolicy\'s fourth number is how far valleys are captured', () => {
    const tiles = [tile(112, 100, 'forest', 5)];
    eq(plan('valley', 'config valley:5', { tiles }).p.actions.length, 0, '12 tiles is past the 10-tile default');
    const far = plan('valley', 'config valley:5\ndistancepolicy 10 10 10 15', { tiles }).p;
    eq(far.actions.length, 1);
    has(far.note, 'within 15 tiles (distancepolicy)');
  });

  await t('with valleymin: the highest level first, down to valleymin', () => {
    const { p } = plan('valley', 'config valley:8,valleymin:5', { tiles: RING() });
    eq(p.actions[0].target, { x: 108, y: 100 }, 'the L8 at 8 tiles before the L5 at 3');
    has(p.note, 'L5-8');
    eq(plan('valley', 'config valley:5,valleymin:8', { tiles: RING() }).p.actions, [], 'valleymin above valley');
    has(plan('valley', 'config valley:5,valleymin:8', { tiles: RING() }).p.note, 'valleymin:8 is above config valley:5');
    has(plan('valley', 'config valleymin:3', { tiles: RING() }).p.note, 'needs config valley');
  });

  await t('slots: the Town Hall\'s level; full slots and no valleymin: nothing more', () => {
    const c = city({ th: 2, fields: [field(90, 90, 'forest', 3), field(91, 90, 'lake', 2)] });
    const { p } = plan('valley', 'config valley:5', { castle: c, tiles: RING() });
    eq(p.actions, []);
    has(p.note, 'every slot is taken');
    has(p.note, '2/2 slots held');
  });

  await t('valleymin with full slots: the lowest valley is let go for a better one, after the capture leaves', () => {
    const c = city({ th: 2, fields: [field(90, 90, 'forest', 7), field(91, 90, 'lake', 3)] });
    const { p } = plan('valley', 'config valley:8,valleymin:5', { castle: c, tiles: RING() });
    eq(p.actions.length, 1);
    const a = p.actions[0];
    eq(a.target, { x: 108, y: 100 });
    eq(a.release, { fieldId: fid(91, 90), level: 3, type: 'lake', x: 91, y: 90 });
    has(a.label, 'then let go of the L3 lake at 91,90');
    // nothing better than what is held: no swap
    const top = city({ th: 2, fields: [field(90, 90, 'forest', 8), field(91, 90, 'forest', 8)] });
    const none = plan('valley', 'config valley:8,valleymin:5', { castle: top, tiles: RING() }).p;
    eq(none.actions, []);
    has(none.note, 'no better forest in range');
  });

  await t('capture troops: the wiki defaults per level, valleytroops lines over them, the most specific line winning', () => {
    const ctx = { goals: [] };
    eq(I.troopsFor(ctx, 1, 'forest', V.CAPTURE_TROOPS).troops, { archer: 50 });
    eq(I.troopsFor(ctx, 4, 'forest', V.CAPTURE_TROOPS).troops, { militia: 1200, scouter: 1, pikemen: 1, swordsmen: 1, archer: 400 });
    eq(I.troopsFor(ctx, 10, 'flat', V.CAPTURE_TROOPS).troops, { militia: 60000, scouter: 1, pikemen: 1, swordsmen: 1, lightCavalry: 1, archer: 19990 });
    const g = G.parseGoals('valleytroops 10 a:19990,sw:1,p:1,s:1,w:60000\nvalleytroops /level:10 /type:forest s:100000\nvalleytroops /type:lake s:7').goals;
    eq(I.troopsFor({ goals: g }, 10, 'forest', V.CAPTURE_TROOPS).troops, { scouter: 100000 }, 'level and type');
    eq(I.troopsFor({ goals: g }, 10, 'hill', V.CAPTURE_TROOPS).troops, { archer: 19990, swordsmen: 1, pikemen: 1, scouter: 1, militia: 60000 }, 'level');
    eq(I.troopsFor({ goals: g }, 10, 'lake', V.CAPTURE_TROOPS).troops, { scouter: 7 }, 'a type line beats a level line');
    eq(I.troopsFor({ goals: g }, 9, 'hill', V.CAPTURE_TROOPS).troops, V.CAPTURE_TROOPS[9], 'a level with no line takes the default');
    const { p } = plan('valley', 'config valley:5\nvalleytroops 5 s:5000', { tiles: RING() });
    eq(p.actions[0].troops, { scouter: 5000 });
  });

  await t('valleyheroes chooses who goes; keepatthome, homeheroes and the mayor stay home', () => {
    eq(plan('valley', 'config valley:5\nvalleyheroes Scrapper', { tiles: RING() }).p.actions[0].hero, 'Scrapper');
    eq(plan('valley', 'config valley:5\nvalleyheroes any:attack<145', { tiles: RING() }).p.actions[0].hero, 'Brawler');
    const none = plan('valley', 'config valley:5\nvalleyheroes Nobody', { tiles: RING() }).p;
    eq(none.actions, []);
    has(none.note, 'no idle hero matches valleyheroes "Nobody"');
    eq(plan('valley', 'config valley:5,keepatthome:1', { tiles: RING() }).p.actions[0].hero, 'Brawler', 'the best attack hero stays home');
    const home = plan('valley', 'config valley:5\nvalleyheroes Strong\nhomeheroes 1', { tiles: RING() }).p;
    eq(home.actions, []);
    has(home.note, 'homeheroes 1');
    const c = city({ heros: [hero(6, 'Mayor', 200, { status: 1 }), hero(7, 'Away', 90, { status: 3 })] });
    has(plan('valley', 'config valley:5', { castle: c, tiles: RING() }).p.note, 'no idle hero');
  });

  await t('a valleyheroes line that does not read holds every valley march', () => {
    const { p } = plan('valley', 'config valley:5\nvalleyheroes any:nope>1', { tiles: RING() });
    eq(p.actions, []);
    has(p.note, 'does not read, so no hero is sent');
  });

  await t('valleylimit: the troops that must stay home before a valley attack leaves', () => {
    const { p } = plan('valley', 'config valley:5\nvalleylimit w:600k', { tiles: RING() });
    eq(p.actions, []);
    has(p.note, 'valleylimit: 500,000 Warrior at home, needs 600,000');
    eq(plan('valley', 'config valley:5\nvalleylimit w:400k', { tiles: RING() }).p.actions.length, 1);
  });

  await t('a valley march leaves the day of the troops\' upkeep in the granary (ctx.foodDay, as the troop goal does)', () => {
    const c = city({ resource: { ...city().resource, food: { amount: 5000 } } });
    const { p } = plan('valley', 'config valley:5', { castle: c, tiles: RING(), ctx: { foodDay: 4900 } });
    eq(p.actions, []);
    has(p.note, 'keeping 4,900 for a day of its troops\' upkeep');
    eq(plan('valley', 'config valley:5', { castle: c, tiles: RING(), ctx: { foodDay: 10 } }).p.actions.length, 1);
  });

  await t('short of troops: the march waits and says what for', () => {
    const c = city({ troop: { militia: 100, archer: 10 } });
    const { p } = plan('valley', 'config valley:5', { castle: c, tiles: RING() });
    eq(p.actions, []);
    has(p.note, 'short of Warrior');
  });

  await t('rallypolicy v: counts our valley marches; the rally spot and npcteams count every march', () => {
    const c = city();
    const out = { armyId: 1, startFieldId: c.fieldId, targetFieldId: fid(90, 90), missionType: C.MISSION.attack, direction: 1, startTime: NOW };
    const state = { valley: { marches: { [fid(90, 90)]: { kind: 'v', purpose: 'capture', capture: true, at: NOW } } } };
    const game = fakeGame([c], { selfArmys: [out] });
    const held = plan('valley', 'config valley:5\nrallypolicy v:1', { castle: c, game, state, tiles: RING() }).p;
    eq(held.actions, []);
    has(held.note, 'rallypolicy v:1');
    eq(plan('valley', 'config valley:5\nrallypolicy v:2', { castle: c, game, state: { valley: { marches: { ...state.valley.marches } } }, tiles: RING() }).p.actions.length, 1);
    // an npc run (not ours) is not a valley march, but it is a team
    const npc = { ...out, targetFieldId: fid(80, 80) };
    const g2 = fakeGame([c], { selfArmys: [npc] });
    eq(plan('valley', 'config valley:5\nrallypolicy v:1', { castle: c, game: g2, tiles: RING() }).p.actions.length, 1);
    const teams = plan('valley', 'config valley:5\nnpcteams 1', { castle: c, game: g2, tiles: RING() }).p;
    eq(teams.actions, []);
    has(teams.note, '1/1 teams out');
  });

  await t('war town and an attack on the city hold every valley march', () => {
    has(plan('valley', 'config valley:5,wartown:1', { tiles: RING() }).p.note, 'held: war town 1');
    const wave = { armyId: 9, king: 'Raider', missionType: C.MISSION.attack, reachTime: NOW + 600000, troop: { archer: '200000' } };
    const ua = plan('valley', 'config valley:5', { tiles: RING(), incoming: [wave] }).p;
    eq(ua.actions, []);
    has(ua.note, 'under attack');
  });

  await t('only free tiles the map scan read lately: not excluded, not someone\'s, not stale, not read before maintenance', () => {
    const tiles = [tile(103, 100, 'forest', 5, { userName: 'Rival' }), tile(101, 100, 'forest', 5, { npc: true }),
      tile(104, 100, 'forest', 5, { seen: NOW - 6 * H1 }), tile(106, 100, 'forest', 5), tile(107, 100, 'forest', 5)];
    const { p } = plan('valley', 'config valley:5\nexcludelist 106,100', { tiles });
    eq(p.actions[0].target, { x: 107, y: 100 });
    has(p.note, '1 waiting for a fresh map read');
    const after = plan('valley', 'config valley:5', { tiles: [tile(106, 100, 'forest', 5, { seen: NOW - H1 })], maintEndedAt: NOW - 1000 }).p;
    eq(after.actions, [], 'read before the last maintenance: its level has moved');
    has(after.note, 'waiting for a fresh map read');
  });

  await t('config hunting keeps one slot free to hunt with', () => {
    const c = city({ th: 2, fields: [field(90, 90, 'forest', 5)] });
    const { p } = plan('valley', 'config valley:5,hunting:5', { castle: c, tiles: RING() });
    eq(p.actions, []);
    has(p.note, 'one kept for hunting');
  });

  await t('the executor: the game is asked who holds the tile first; an owned or unattackable tile is never hit', async () => {
    for (const [info, why] of [
      [() => ({ ok: 1, bean: { userName: 'Rival', canOccupy: true } }), 'belongs to Rival'],
      [() => ({ ok: 1, bean: { userName: null, canOccupy: false } }), 'does not offer an attack'],
      [() => ({ ok: 0, errorMsg: 'busy' }), 'could not read who holds it (busy)'],
      [() => ({ ok: 1 }), 'could not read who holds it'],
    ]) {
      const c = city();
      const game = fakeGame([c], { fieldInfo: info });
      const { p, state } = plan('valley', 'config valley:5', { castle: c, game, tiles: RING() });
      const r = await V.executors.valleyAttack(game, c, p.actions[0], state);
      eq(r.ok, 0);
      has(r.errorMsg, why);
      eq(game.sent.length, 0, why);
    }
  });

  await t('a tile the game turned down rests 6 hours (15 minutes if it only could not be read), and the next one is tried', async () => {
    const c = city();
    const game = fakeGame([c], { fieldInfo: (id) => (id === fid(103, 100) ? { ok: 1, bean: { userName: 'Rival', canOccupy: true } } : { ok: 1, bean: { canOccupy: true } }) });
    const tiles = () => [...RING(), tile(106, 100, 'forest', 5)];
    const first = plan('valley', 'config valley:5', { castle: c, game, tiles: tiles() });
    eq(first.p.actions[0].target, { x: 103, y: 100 });
    eq((await V.executors.valleyAttack(game, c, first.p.actions[0], first.state)).ok, 0);
    eq(first.state.valley.blocked[fid(103, 100)].ms, 6 * H1);
    const next = plan('valley', 'config valley:5', { castle: c, game, state: first.state, tiles: tiles() }).p;
    eq(next.actions[0].target, { x: 106, y: 100 }, 'moved on to the next');
    const later = plan('valley', 'config valley:5', { castle: c, game, state: first.state, tiles: tiles().map((x) => ({ ...x, seen: NOW + 7 * H1 })), now: NOW + 7 * H1 }).p;
    eq(later.actions[0].target, { x: 103, y: 100 }, 'asked again after its rest');
    const g2 = fakeGame([c], { fieldInfo: () => ({ ok: 0, errorMsg: 'timeout' }) });
    const s2 = {};
    const p2 = plan('valley', 'config valley:5', { castle: c, game: g2, state: s2, tiles: RING() });
    await V.executors.valleyAttack(g2, c, p2.p.actions[0], s2);
    eq(s2.valley.blocked[fid(103, 100)].ms, 15 * 60000);
    has(plan('hunting', 'config hunting:5\nhuntingpos 105,100', { castle: c, game, state: { valley: { blocked: { [fid(105, 100)]: { at: Date.now(), ms: 6 * H1, why: 'it belongs to Rival now' } } } }, tiles: RING() }).p.note,
      'huntingpos 105,100: it belongs to Rival now — asked again in');
  });

  await t('the executor sends the attack, records it, and only then lets the swapped valley go', async () => {
    const c = city({ th: 2, fields: [field(90, 90, 'forest', 7), field(91, 90, 'lake', 3)] });
    const game = fakeGame([c]);
    const { p, state } = plan('valley', 'config valley:8,valleymin:5', { castle: c, game, tiles: RING() });
    const r = await V.executors.valleyAttack(game, c, p.actions[0], state);
    eq(r.ok, 1);
    eq(game.sent.length, 1);
    eq([game.sent[0].bean.missionType, game.sent[0].bean.targetPoint, game.sent[0].bean.heroId], [C.MISSION.attack, fid(108, 100), 1]);
    eq(game.sent[0].bean.troops.militia, 19200);
    eq(game.gaveUp, [fid(91, 90)]);
    eq(state.valley.marches[fid(108, 100)].purpose, 'capture');
    // a refused attack lets nothing go
    const c2 = city({ th: 2, fields: [field(90, 90, 'forest', 7), field(91, 90, 'lake', 3)] });
    const g2 = fakeGame([c2]);
    g2.armyReply = () => ({ ok: 0, errorMsg: 'hero busy' });
    const again = plan('valley', 'config valley:8,valleymin:5', { castle: c2, game: g2, tiles: RING() });
    eq((await V.executors.valleyAttack(g2, c2, again.p.actions[0], again.state)).ok, 0);
    eq(g2.gaveUp, []);
  });

  await t('making room only ever lets a valley go, never a flat, and only one this city holds', async () => {
    const c = city({ fields: [field(90, 90, 'flat', 3), field(91, 90, 'lake', 3)] });
    const game = fakeGame([c]);
    let r = await V.executors.releaseFields(game, c, { purpose: 'room', fields: [{ fieldId: fid(90, 90), x: 90, y: 90 }] }, {});
    eq(r.ok, 0);
    has(r.errorMsg, 'a flat is never let go to make room');
    r = await V.executors.releaseFields(game, c, { purpose: 'room', fields: [{ fieldId: fid(95, 95), x: 95, y: 95 }] }, {});
    has(r.errorMsg, 'not held by this city');
    r = await V.executors.releaseFields(game, c, { purpose: 'room', fields: [{ fieldId: fid(91, 90), x: 91, y: 90, type: 'forest' }] }, {});
    has(r.errorMsg, 'it is a lake now, not a forest');
    eq(game.gaveUp, []);
  });

  await t('a hero npc farming sent moments ago in the same slice is not sent again', async () => {
    const c = city();
    const game = fakeGame([c]);
    const { p, state } = plan('valley', 'config valley:5', { castle: c, game, tiles: RING() });
    state.npc = { runs: [{ heroId: p.actions[0].heroId, sentAt: Date.now(), doneAt: Date.now() + H1 }] };
    const r = await V.executors.valleyAttack(game, c, p.actions[0], state);
    eq(r.ok, 0);
    has(r.errorMsg, 'has just left on an npc run');
    eq(game.sent, []);
  });

  await t('canOccupy as the server may send it (true or 1) lets the attack go', async () => {
    const c = city();
    const game = fakeGame([c], { fieldInfo: () => ({ ok: 1, bean: { userName: '', canOccupy: 1 } }) });
    const { p, state } = plan('valley', 'config valley:5', { castle: c, game, tiles: RING() });
    eq((await V.executors.valleyAttack(game, c, p.actions[0], state)).ok, 1);
  });

  await t('a config value that does not read holds the goal, with a note', () => {
    has(plan('valley', 'config valley:abc', { tiles: RING() }).p.note, 'valley — held: config valley:abc is not');
    has(plan('hunting', 'config hunting:15', { tiles: RING() }).p.note, 'hunting — held');
    has(plan('flats', 'config acquireflats:9', { tiles: RING() }).p.note, 'flats — held');
    has(plan('valleyfarming', 'config valleyfarming:x', { tiles: RING() }).p.note, 'valleyfarming — held');
  });

  await t('the executor re-counts the slots: a capture this slice already took the last one', async () => {
    const c = city({ th: 1 });
    const game = fakeGame([c]);
    const { p, state } = plan('valley', 'config valley:5', { castle: c, game, tiles: RING() });
    eq((await V.executors.valleyAttack(game, c, p.actions[0], state)).ok, 1);
    const second = { ...p.actions[0], fieldId: fid(112, 100), target: { x: 112, y: 100 }, heroId: 2, hero: 'Brawler' };
    const r = await V.executors.valleyAttack(game, c, second, state);
    eq(r.ok, 0);
    has(r.errorMsg, 'no free valley slot now');
    // and the same hero twice in one slice is caught before it gets that far
    const again = await V.executors.valleyAttack(game, c, { ...p.actions[0], fieldId: fid(112, 100), target: { x: 112, y: 100 } }, state);
    has(again.errorMsg, 'has just left on another valley march');
    // and the plan sees the capture on its way
    has(plan('valley', 'config valley:5', { castle: c, game, state, tiles: RING() }).p.note, '1 capture(s) on the way');
  });

  // ============================================================ valley farming
  section('config valleyfarming (wiki ValleyFarming)');

  const full = () => city({ th: 2, fields: [field(90, 90, 'forest', 10), field(91, 90, 'forest', 10)] });

  await t('a free slot holds farming: a win would capture the valley', () => {
    const { p } = plan('valleyfarming', 'config valleyfarming:10', { castle: city({ th: 5 }), tiles: RING() });
    eq(p.actions, []);
    has(p.note, 'fill the slots first');
  });

  await t('slots full: the city\'s own type within distancepolicy\'s third number, farm defaults', () => {
    const { p } = plan('valleyfarming', 'config valleyfarming:10', { castle: full(), tiles: RING() });
    eq(p.actions.length, 1);
    const a = p.actions[0];
    eq([a.purpose, a.capture, a.needFull, a.target], ['farm', false, true, { x: 100, y: 106 }]);
    eq(a.troops, { militia: 1, pikemen: 1, swordsmen: 1, lightCavalry: 1, archer: 25000, ballista: 2000, scouter: 1 }, 'wiki ValleyFarming L10');
    eq(plan('valleyfarming', 'config valleyfarming:10\ndistancepolicy 10 10 5', { castle: full(), tiles: RING() }).p.actions, [], '6 tiles is past 5');
  });

  await t('the miles line picks the types and how far (valleyfarming 5 0 5 0 0 0)', () => {
    const { p } = plan('valleyfarming', 'config valleyfarming:10\nvalleyfarming 5 0 5 0 0 0', { castle: full(), tiles: RING() });
    eq(p.actions[0].target, { x: 105, y: 100 }, 'the L10 hill at 5; the forest at 6 is past 5');
    eq(plan('valleyfarming', 'config valleyfarming:10\nvalleyfarming 0 0 0 0 0 9', { castle: full(), tiles: RING() }).p.actions, []);
    has(plan('valleyfarming', 'valleyfarming 5 0 5 0 0 0', { castle: full(), tiles: RING() }).p.note, 'once config valleyfarming:<level>');
  });

  await t('each valley at most once an hour', async () => {
    const c = full();
    const game = fakeGame([c]);
    const { p, state } = plan('valleyfarming', 'config valleyfarming:10\nvalleyfarming 10 0 10 0 0 0', { castle: c, game, tiles: RING() });
    eq(p.actions[0].target, { x: 105, y: 100 });
    eq((await V.executors.valleyAttack(game, c, p.actions[0], state)).ok, 1);
    game.player.selfArmys = [];                               // it came straight back
    const next = plan('valleyfarming', 'config valleyfarming:10\nvalleyfarming 10 0 10 0 0 0', { castle: c, game, state, tiles: RING(), now: NOW + 5 * 60000 }).p;
    eq(next.actions[0].target, { x: 100, y: 106 }, 'the hill waits its hour, the forest goes');
    const later = plan('valleyfarming', 'config valleyfarming:10\nvalleyfarming 10 0 10 0 0 0', { castle: c, game, state, tiles: RING(), now: NOW + H1 + 60000 }).p;
    eq(later.actions[0].target, { x: 105, y: 100 });
  });

  await t('the executor will not farm with a slot free', async () => {
    const c = full();
    const game = fakeGame([c]);
    const { p, state } = plan('valleyfarming', 'config valleyfarming:10', { castle: c, game, tiles: RING() });
    c.fields.pop();
    const r = await V.executors.valleyAttack(game, c, p.actions[0], state);
    eq(r.ok, 0);
    has(r.errorMsg, 'would capture the valley');
    eq(game.sent.length, 0);
  });

  // ======================================================= safe valley farming
  section('safevalleyfarm (wiki SafeValleyFarming)');

  await t('the three rules, and the archer table', () => {
    eq(I.safeLoad(9, { archer: 3000 }), { troops: { scouter: 1, lightCavalry: 3000 }, rule: 'only archers there' });
    eq(I.safeLoad(9, { militia: 5000, pikemen: 100 }).troops, { archer: 15000 });
    eq(I.safeLoad(10, {}).troops, { archer: 30000 });
    eq(I.safeLoad(10, { lightCavalry: 800, militia: 5, pikemen: 5 }).troops, { archer: 30000, ballista: 1, pikemen: 1, swordsmen: 1 });
    eq(I.safeLoad(10, { lightCavalry: 800, militia: 5, pikemen: 5, swordsmen: 5 }), null, 'three layers');
    eq(I.safeLoad(10, { lightCavalry: 800, archer: 5 }), null, 'cavalry and archers');
    eq(I.safeLoad(10, { archer: 5, militia: 1 }), null, 'archers and something else');
    eq(Object.values(I.SAFE_ARCHERS), [50, 100, 200, 500, 1000, 2000, 4000, 8000, 15000, 30000]);
  });

  const scoutXml = (troops, ok = true) => `<reportData><scoutReport isAttack="true" isFound="false" isSuccess="${ok}"><scoutInfo>`
    + `<troops>${troops.map(([typeId, count]) => `<troopStrType typeId="${typeId}" count="${count}"/>`).join('')}</troops></scoutInfo></scoutReport></reportData>`;

  await t('a scout report read the way the console decodes it', () => {
    eq(I.readScout(scoutXml([[7, 3000]])), { scout: true, success: true, garrison: { archer: 3000 }, why: null });
    eq(I.readScout(scoutXml([[3, 50], [9, 70]])).garrison, { militia: 50, lightCavalry: 70 });
    eq(I.readScout(scoutXml([[7, 3000]], false)).success, false);
    eq(I.readScout(scoutXml([[7, 'about 3000']])).garrison, null, 'a count that is not a number is not read as one');
    eq(I.readScout('<reportData><battleReport/></reportData>').scout, false);
    eq(I.readScout('<reportData><scoutReport isSuccess="true"></scoutReport></reportData>').garrison, null, 'no troop list seen');
  });

  await t('a valley the game will not let us scout is marked and left; a report that never comes marks it unsafe', async () => {
    const c = full();
    const game = fakeGame([c], { fieldInfo: () => ({ ok: 1, bean: { userName: null, canOccupy: true, canScout: false } }) });
    const state = {};
    const r = plan('safevalleyfarm', 'safevalleyfarm 10', { castle: c, game, state, tiles: RING() });
    const out = await V.executors.valleyScout(game, c, r.p.actions[0], state);
    eq(out.ok, 0);
    eq(I.safeMemory(game, c, [10]).valleys[fid(105, 100)].stage, 'skip');
    eq(game.sent, []);
    // a report that never comes
    const g2 = fakeGame([c]);
    const mem = I.safeMemory(g2, c, [10]);
    mem.valleys[fid(100, 106)] = { stage: 'scouting', sentAt: Date.now() - 20 * 60000, x: 100, y: 106, level: 10 };
    await V.executors.scoutReports(g2, c, { memory: mem, pending: [{ fieldId: fid(100, 106), x: 100, y: 106, sentAt: Date.now() - 20 * 60000, level: 10 }] });
    eq(mem.valleys[fid(100, 106)].stage, 'unsafe');
    eq(mem.valleys[fid(100, 106)].why, 'no scout report came back');
  });

  await t('not with config hunting, not with a slot free', () => {
    has(plan('safevalleyfarm', 'safevalleyfarm 10\nconfig hunting:5', { castle: full(), tiles: RING() }).p.note, 'does nothing while config hunting is on');
    has(plan('safevalleyfarm', 'safevalleyfarm 10', { castle: city(), tiles: RING() }).p.note, 'safe farming must never capture');
    eq(plan('safevalleyfarm', 'safevalleyfarm off', { castle: full(), tiles: RING() }).p, null);
  });

  await t('scout, read, then hit what is safe — at most once an hour; a new login starts afresh', async () => {
    const c = full();
    const game = fakeGame([c], { reports: [{ id: 501, targetPos: 'Forest(100,106)', eventTime: Math.floor(Date.now() / 1000) + 5 }] });
    const state = {};
    const src = 'safevalleyfarm 10';
    // 1. the nearest L10 valley is scouted: 1000 scouts, no hero
    let r = plan('safevalleyfarm', src, { castle: c, game, state, tiles: RING() });
    let a = r.p.actions[0];
    eq([a.kind, a.target, a.troops], ['valleyScout', { x: 105, y: 100 }, { scouter: 1000 }]);
    eq((await V.executors.valleyScout(game, c, a, state)).ok, 1);
    eq(game.sent[0].bean.missionType, C.MISSION.scout);
    assert.ok(!('heroId' in game.sent[0].bean), 'no hero with the scouts');
    // 2. then the next one, while the first is out
    game.player.selfArmys = [{ startFieldId: c.fieldId, targetFieldId: fid(105, 100), missionType: C.MISSION.scout, direction: 1 }];
    r = plan('safevalleyfarm', src, { castle: c, game, state, tiles: RING() });
    a = r.p.actions[0];
    eq(a.target, { x: 100, y: 106 });
    eq((await V.executors.valleyScout(game, c, a, state)).ok, 1);
    // 3. both home: read the reports (the forest's report is in, the hill's never comes)
    game.player.selfArmys = [];
    game.reportContent = null;
    const g2 = fakeGame([c], { reports: [{ id: 501, targetPos: 'Forest(100,106)', eventTime: Math.floor(Date.now() / 1000) + 5 }], reportContent: { 501: scoutXml([[7, 3000]]) } });
    Object.assign(game, { reportList: g2.reportList, readReport: g2.readReport });
    r = plan('safevalleyfarm', src, { castle: c, game, state, tiles: RING() });
    a = r.p.actions[0];
    eq(a.kind, 'scoutReports');
    eq((await V.executors.scoutReports(game, c, a, state)).ok, 1);
    const mem = I.safeMemory(game, c, [10]);
    eq(mem.valleys[fid(100, 106)].stage, 'safe');
    eq(mem.valleys[fid(105, 100)].stage, 'scouting', 'no report yet, waiting');
    // 4. the safe forest is hit with 1 scout + 3000 cavalry
    r = plan('safevalleyfarm', src, { castle: c, game, state, tiles: RING(), now: NOW + 3 * 60000 });
    a = r.p.actions.find((x) => x.kind === 'valleyAttack') || r.p.actions[0];
    eq([a.kind, a.target, a.troops], ['valleyAttack', { x: 100, y: 106 }, { scouter: 1, lightCavalry: 3000 }]);
    has(a.label, 'only archers there');
    // a new Game (a reconnection) starts from nothing
    eq(Object.keys(I.safeMemory(fakeGame([c]), c, [10]).valleys), []);
    // and so do other levels
    eq(Object.keys(I.safeMemory(game, c, [9, 10]).valleys), []);
  });

  // ================================================================== hunting
  section('config hunting, huntingpos, huntingtype (wiki Hunting, HuntingPos, HuntingType)');

  await t('the switches: 1 = L2-3 ... 4 = L9-10, 5 = L10, 6-10 that level', () => {
    eq([I.HUNT_LEVELS[1], I.HUNT_LEVELS[2], I.HUNT_LEVELS[3], I.HUNT_LEVELS[4], I.HUNT_LEVELS[5], I.HUNT_LEVELS[7]],
      [[2, 3], [4, 5, 6], [7, 8, 9], [9, 10], [10], [7]]);
  });

  await t('the nearest valley of those levels within distancepolicy\'s third number, hunting troops, rallypolicy m', () => {
    const { p } = plan('hunting', 'config hunting:5', { tiles: RING() });
    const a = p.actions[0];
    eq([a.purpose, a.capture, a.target, a.rally.kind], ['hunt', true, { x: 105, y: 100 }, 'm']);
    eq(a.troops, { militia: 1, pikemen: 1, swordsmen: 1, lightCavalry: 1, archer: 25000, ballista: 2000 }, 'wiki Hunting L10: no scout');
    eq(plan('hunting', 'config hunting:5\ndistancepolicy 10 10 4', { tiles: RING() }).p.actions, []);
    eq(plan('hunting', 'config hunting:5\nhuntingtype forest', { tiles: RING() }).p.actions[0].target, { x: 100, y: 106 });
    has(plan('hunting', 'config hunting:5\nrallypolicy m:0', { tiles: RING() }).p.note, 'rallypolicy m:0');
    eq(plan('hunting', 'config hunting:0', { tiles: RING() }).p, null);
  });

  await t('valleytroops steer the hunting load too (wiki Hunting: "the specified ValleyTroops ... or the default")', () => {
    eq(plan('hunting', 'config hunting:5\nvalleytroops 10 a:40000,b:3000', { tiles: RING() }).p.actions[0].troops, { archer: 40000, ballista: 3000 });
    eq(plan('hunting', 'config hunting:5\nvalleytroops /type:forest s:1', { tiles: RING() }).p.actions[0].troops, I.HUNT_TROOPS[10], 'a forest line leaves the hill alone');
  });

  await t('huntingpos: only there, and only a free valley the map cache knows', () => {
    eq(plan('hunting', 'config hunting:5\nhuntingpos 112,100', { tiles: RING() }).p.actions[0].target, { x: 112, y: 100 });
    has(plan('hunting', 'config hunting:5\nhuntingpos 150,150', { tiles: RING() }).p.note, 'is not a free valley in the map cache');
    has(plan('hunting', 'config hunting:5\nhuntingpos 90,90', { castle: city({ fields: [field(90, 90, 'forest', 5)] }), tiles: RING() }).p.note, 'one of our own fields');
    has(plan('hunting', 'huntingpos 1,1', { tiles: RING() }).p.note, 'config hunting, which is not on');
  });

  await t('catch and release: a valley a hunting wave took is let go at once — and only such a one', async () => {
    const c = city({ fields: [field(105, 100, 'hill', 10), field(90, 90, 'forest', 8)] });
    const game = fakeGame([c]);
    const state = { valley: { marches: { [fid(105, 100)]: { kind: 'm', purpose: 'hunt', capture: true, at: NOW - 60000 } } } };
    const { p } = plan('hunting', 'config hunting:5', { castle: c, game, state, tiles: RING() });
    eq(p.actions.length, 1);
    const a = p.actions[0];
    eq([a.kind, a.fields.map((f) => f.fieldId)], ['releaseFields', [fid(105, 100)]]);
    eq((await V.executors.releaseFields(game, c, a, state)).ok, 1);
    eq(game.gaveUp, [fid(105, 100)]);
    // the executor refuses a field that is not a hunting catch
    const r = await V.executors.releaseFields(game, c, { kind: 'releaseFields', purpose: 'hunt', fields: [{ fieldId: fid(90, 90), x: 90, y: 90 }] }, state);
    eq(r.ok, 0);
    has(r.errorMsg, 'not a hunting catch');
    eq(game.gaveUp.length, 1);
  });

  await t('no free slot: the lowest valley goes once the wave is on its way (wiki: "abandon 1 or more of your valleys")', async () => {
    const c = city({ th: 2, fields: [field(90, 90, 'forest', 8), field(91, 90, 'lake', 4)] });
    const game = fakeGame([c]);
    const { p, state } = plan('hunting', 'config hunting:5', { castle: c, game, tiles: RING() });
    const a = p.actions[0];
    eq(a.release.fieldId, fid(91, 90));
    eq((await V.executors.valleyAttack(game, c, a, state)).ok, 1);
    eq(game.gaveUp, [fid(91, 90)]);
  });

  await t('waves land three minutes apart, so the valley can be let go between them; a second wave needs no second slot', async () => {
    const c = city({ th: 1 });
    const game = fakeGame([c]);
    const first = plan('hunting', 'config hunting:5', { castle: c, game, tiles: RING() });
    eq((await V.executors.valleyAttack(game, c, first.p.actions[0], first.state)).ok, 1);
    const lands = NOW + first.p.actions[0].oneWayMs;
    game.player.selfArmys = [{ armyId: 5, startFieldId: c.fieldId, targetFieldId: fid(105, 100), missionType: C.MISSION.attack, direction: 1, reachTime: lands }];
    c.heros.find((h) => h.id === first.p.actions[0].heroId).status = 3;     // the hero push: marching
    const soon = plan('hunting', 'config hunting:5', { castle: c, game, state: first.state, tiles: RING() }).p;
    eq(soon.actions, []);
    has(soon.note, 'waves land 3m apart');
    const later = plan('hunting', 'config hunting:5', { castle: c, game, state: first.state, tiles: RING(), now: NOW + 5 * 60000 }).p;
    eq(later.actions.length, 1, 'three minutes on, the next wave may go');
    eq(later.actions[0].release, undefined, 'the wave out there holds the slot');
    const r = await V.executors.valleyAttack(game, c, later.actions[0], first.state);
    eq(r.ok, 1, r.errorMsg);
  });

  // ==================================================================== flats
  section('config acquireflats and abandonflats (wiki AcquireFlats, AbandonFlats)');

  const FLATS = () => [tile(102, 100, 'flat', 3), tile(104, 100, 'flat', 5), tile(100, 108, 'flat', 7), tile(115, 100, 'flat', 5)];

  await t('acquireflats:1 needs an open city slot; 2 captures anyway', () => {
    const noSlot = fakeGame([city()], { titleId: 0 });
    has(plan('flats', 'config acquireflats:1', { game: noSlot, castle: noSlot.castles[0], tiles: FLATS() }).p.note, 'no open city slot');
    const g2 = fakeGame([city()], { titleId: 0 });
    const two = plan('flats', 'config acquireflats:2', { game: g2, castle: g2.castles[0], tiles: FLATS() }).p;
    eq(two.actions.length, 1);
    eq([two.actions[0].purpose, two.actions[0].target, two.actions[0].rally.kind], ['flat', { x: 102, y: 100 }, 'b']);
    eq(two.actions[0].troops, { archer: 200 }, 'the capture default for a L3 flat');
  });

  await t('within npc-building distance: distancepolicy\'s second number, or npcbuildpolicy per level; up to buildnpc\'s level', () => {
    eq(plan('flats', 'config acquireflats:1', { tiles: [tile(115, 100, 'flat', 5)] }).p.actions, [], '15 is past the 10-tile default');
    eq(plan('flats', 'config acquireflats:1\ndistancepolicy 10 20', { tiles: [tile(115, 100, 'flat', 5)] }).p.actions.length, 1);
    eq(plan('flats', 'config acquireflats:1\nnpcbuildpolicy /level:5 /mindistance:12 /maxdistance:20', { tiles: [tile(104, 100, 'flat', 5), tile(115, 100, 'flat', 5)] }).p.actions[0].target,
      { x: 115, y: 100 }, 'L5 only 12-20 out');
    eq(plan('flats', 'config acquireflats:1\nnpcbuildpolicy /level:5 /mindistance:12 /maxdistance:20', { tiles: FLATS() }).p.actions[0].target,
      { x: 102, y: 100 }, 'a L3 flat has no band of its own: the 10-tile default');
    const five = plan('flats', 'config acquireflats:1,buildnpc:5', { tiles: [tile(100, 108, 'flat', 7), tile(104, 100, 'flat', 5)] }).p;
    eq(five.actions[0].target, { x: 104, y: 100 }, 'a L7 flat can never become a L5 npc');
    // with buildnpc's levels, a lower flat is held where the level it grows to is built
    const grow = 'config acquireflats:1,buildnpc:5\nnpcbuildpolicy /level:5 /mindistance:12 /maxdistance:20';
    eq(plan('flats', grow, { tiles: FLATS() }).p.actions[0].target, { x: 115, y: 100 }, 'the L3 at 2 tiles would grow into a L5 nobody builds there');
    eq(plan('flats', grow, { tiles: [tile(113, 100, 'flat', 2)] }).p.actions[0].target, { x: 113, y: 100 });
  });

  await t('acquireflats leaves alone a flat buildnpc has claimed, and one it is already marching on', () => {
    const acc = 'af1';
    D.run('DELETE FROM city_registry WHERE accountId = ?', acc);
    D.registry.claimFlat(acc, fid(102, 100), { x: 102, y: 100 }, 'buildnpc: founding');
    const c = city();
    const game = fakeGame([c], { selfArmys: [{ startFieldId: c.fieldId, targetFieldId: fid(104, 100), missionType: C.MISSION.attack, direction: 1 }] });
    const { p } = plan('flats', 'config acquireflats:2', { castle: c, game, tiles: FLATS(), accountId: acc });
    eq(p.actions[0].target, { x: 100, y: 108 });
  });

  await t('abandonflats: with no build level nothing goes; outside the maintenance warning it only says what will', () => {
    const c = city({ fields: [field(90, 90, 'flat', 3), field(91, 90, 'flat', 5)] });
    has(plan('flats', 'config abandonflats:1', { castle: c }).p.note, 'config buildnpc says which levels to build');
    has(plan('flats', 'config abandonflats:1,buildnpc:20', { castle: c }).p.note, 'none is let go');
    const wait = plan('flats', 'config abandonflats:1,buildnpc:5', { castle: c }).p;
    eq(wait.actions, []);
    has(wait.note, '1 flat(s) below or above L5 go at the next maintenance warning');
  });

  await t('abandonflats: in the maintenance warning the flats below the build level go; acquireflats waits it out', async () => {
    const c = city({ fields: [field(90, 90, 'flat', 3), field(91, 90, 'flat', 5), field(92, 90, 'forest', 9)] });
    const game = fakeGame([c]);
    const maintPlan = { startsAt: NOW + 6 * 60000, pauseAt: NOW + 60000, resumeAt: NOW + 21 * 60000, source: 'announcement' };
    const { p, state } = plan('flats', 'config abandonflats:1,acquireflats:2,buildnpc:5', { castle: c, game, maintPlan, tiles: FLATS() });
    eq(p.actions.length, 1);
    eq(p.actions[0].fields.map((f) => f.fieldId), [fid(90, 90)]);
    const r = await V.executors.releaseFields(game, c, p.actions[0], state);
    eq(r.ok, 1);
    eq(game.gaveUp, [fid(90, 90)]);
    c.fields.shift();
    const after = plan('flats', 'config abandonflats:1,acquireflats:2,buildnpc:5', { castle: c, game, maintPlan, tiles: FLATS(), state }).p;
    eq(after.actions, []);
    has(after.note, 'maintenance is near');
    // the executor re-checks: a L5 flat is never let go by abandonflats
    const again = await V.executors.releaseFields(game, c, { purpose: 'abandonflats', levels: [5], fields: [{ fieldId: fid(91, 90), x: 91, y: 90, type: 'flat' }] }, state);
    eq(again.ok, 0);
    eq(game.gaveUp.length, 1);
  });

  await t('the maintenance plan is read from the console\'s own record, and a script\'s logout is not maintenance', () => {
    const org = D.orgs.create('Valley Org');
    const acc = D.org(org.id).accounts.upsert({ label: 'Vally', email: 'vally@x.com', password: 'x' });
    const plan_ = { startsAt: NOW + 6 * 60000, pauseAt: NOW + 60000, resumeAt: NOW + 21 * 60000, source: 'announcement' };
    D.org(org.id).settings.set('maintPlan:' + acc.id, plan_);
    eq(I.maintenanceAhead({ accountId: acc.id }).startsAt, plan_.startsAt);
    D.org(org.id).settings.set('maintPlan:' + acc.id, { ...plan_, source: 'logout' });
    eq(I.maintenanceAhead({ accountId: acc.id }), null);
    eq(I.maintenanceAhead({}), null);
  });

  // ============================================================ config abandon
  section('config abandon (wiki Abandon)');

  await t('never in the only city; waits while other goals would undo it', () => {
    const c = city();
    has(plan('abandon', 'config abandon:1,comfort:0', { castle: c, game: fakeGame([c]) }).p.note, 'only city');
    const two = () => { const a = city(); return { castle: a, game: fakeGame([a, city({ castleId: 8, id: 8, fieldId: fid(50, 50) })]) }; };
    let w = plan('abandon', 'config abandon:1', two()).p;
    eq(w.actions, []);
    has(w.note, 'config comfort:0');
    w = plan('abandon', 'config abandon:1,comfort:0\ntroop a:1k', two()).p;
    has(w.note, 'troop lines');
    eq(plan('abandon', 'config abandon:0', two()).p, null);
  });

  await t('config troop:0 and fortification:0 (Step 17\'s switches) stand the troop and wall lines down, so it may go on', () => {
    const a = city();
    const game = fakeGame([a, city({ castleId: 8, id: 8, fieldId: fid(50, 50) })]);
    const w = plan('abandon', 'config abandon:1,comfort:0,troop:0,fortification:0\ntroop a:1k\nfortification ab:500', { castle: a, game }).p;
    eq(w.actions.length, 1);
    eq(w.actions[0].step, 'queues');
    has(plan('abandon', 'config abandon:1,comfort:0,troop:0\ntroop a:1k\nfortification ab:500', { castle: a, game }).p.note, 'the fortification lines (or write config fortification:0)');
  });

  await t('through the engine: while abandon strips a city, the troop goal trains nothing there (no batch, no barracks read)', async () => {
    const a = city({ castleId: 21, id: 21, name: 'Leaving', fieldId: fid(60, 60), troop: { archer: 100 } });
    const home = city({ castleId: 22, id: 22, name: 'Home', fieldId: fid(70, 70) });
    const game = fakeGame([home, a]);
    const produced = [];
    game.produceTroop = async (...x) => { produced.push(x); return { ok: 1 }; };
    const e = new Engine(game, () => {});
    e.state = {};
    const src = { Leaving: 'config hero:0,abandon:1,comfort:0,troop:0,reservedbarrack:1\ntroop a:100k' };
    e.goalsFor = (_, name) => (src[name] ? G.parseGoals(src[name]) : null);
    e.controlsFor = () => ({ gate: 'auto', wartown: 'auto' });
    e.dryRun = false;
    await e.tick();
    await e.tick();
    eq(produced, [], 'a troop batch was placed in the city being abandoned');
    eq(reqsOf(game, 'troop.getTroopProduceList').length, 0, 'the barracks were read for training');
    eq(reqsOf(game, 'troop.disbandTroop'), [{ castleId: 21, troopType: 7, num: 100 }]);
  });

  await t('the steps, one a slice: queues, troops, walls, tax 100, then a levy every 15 minutes', async () => {
    const c = city({ troop: { archer: 300, peasants: 50 }, fortification: { abatis: 20, trap: 5 }, resource: { ...city().resource, texRate: 20, support: 80 } });
    const game = fakeGame([c, city({ castleId: 8, id: 8, fieldId: fid(50, 50) })]);
    const state = {};
    const step = async (now = NOW) => {
      const r = plan('abandon', 'config abandon:1,comfort:0', { castle: c, game, state, now });
      const a = r.p.actions[0];
      if (a) eq((await V.executors.abandonStep(game, c, a, state)).ok, 1, a.step);
      return a ? a.step : r.p.note;
    };
    eq(await step(), 'queues');
    eq(reqsOf(game, 'troop.cancelTroopProduce'), [{ castleId: 7, positionId: 4, queueId: 11 }]);
    eq(reqsOf(game, 'fortifications.cancelFortificationProduce'), [{ castleId: 7, queueId: 21 }]);
    eq(await step(), 'troops');
    eq(reqsOf(game, 'troop.disbandTroop'), [{ castleId: 7, troopType: 7, num: 300 }, { castleId: 7, troopType: 2, num: 50 }]);
    c.troop = {};
    eq(await step(), 'walls');
    eq(reqsOf(game, 'fortifications.destructWallProtect'), [{ castleId: 7, typeId: 14, num: 5 }, { castleId: 7, typeId: 15, num: 20 }]);
    c.fortification = {};
    eq(await step(), 'tax');
    eq(reqsOf(game, 'interior.modifyTaxRate'), [{ castleId: 7, tax: 100 }]);
    c.resource.texRate = 100;
    eq(await step(), 'levy');
    eq(reqsOf(game, 'interior.taxation'), [{ castleId: 7, typeId: 1 }]);
    has(await step(), 'the next levy in');
    eq(await step(Date.now() + 16 * 60000), 'levy');
  });

  // ============================================================ buildnpc flow
  section('buildnpc: capture the flat, found the city, let failed claims go');

  const ACC = 'bn1';
  const setup = () => {
    D.run('DELETE FROM city_registry');
    D.accounts.upsert({ id: ACC, label: 'BN', email: 'bn@t', password: 'pw' });
    const home = city();
    const other = city({ castleId: 8, id: 8, name: 'Other', fieldId: fid(300, 300) });
    const game = fakeGame([home, other], { titleId: 9 });
    D.registry.reconcile(ACC, game.castles.map((c) => ({ fieldId: c.fieldId, castleId: c.castleId, name: c.name })));
    return { home, other, game };
  };
  const bplan = (src, { home, game }, over = {}) => {
    const ctx = ctxFor(src, { castle: home, game, accountId: ACC, tiles: over.tiles || FLATS(), now: over.now });
    const state = over.state || { accountId: ACC };
    state.accountId = ACC;
    return { p: B.plans.buildnpc(ctx, state, game), state, ctx };
  };

  await t('the founding gate: 10k of each resource and gold, 250 workers, an open city slot — or no flat is captured', () => {
    const w = setup();
    eq(BI.foundingGate(w.game, w.home).ok, true);
    const poor = city({ resource: { food: { amount: 5000 }, wood: { amount: 1e6 }, stone: { amount: 1e6 }, iron: { amount: 1e6 }, gold: 100 } });
    has(BI.foundingGate(w.game, poor).why, 'needs 10,000 food, gold');
    has(BI.foundingGate(w.game, city({ troop: { peasants: 249 } })).why, 'needs 250 workers (has 249)');
    const full_ = fakeGame([w.home, w.other], { titleId: 1 });
    has(BI.foundingGate(full_, w.home).why, 'no open city slot (the title allows 2, 2 cities)');
    const building = fakeGame([w.home], { titleId: 1, selfArmys: [{ missionType: C.MISSION.construct, direction: 1, targetFieldId: 5 }] });
    has(BI.foundingGate(building, w.home).why, '1 build(s) on the way');
    const { p } = bplan('config buildnpc:5', { home: w.home, game: full_ });
    eq(p.actions, []);
    has(p.note, 'no flat is captured until the city could found on it');
  });

  await t('buildnpc:5 captures the nearest L5 flat with an attack — ValleyTroops defaults, a ValleyHeroes hero — and writes no registry row yet', async () => {
    const w = setup();
    const { p, state } = bplan('config buildnpc:5\nvalleyheroes Brawler', w);
    eq(p.actions.length, 1);
    const a = p.actions[0];
    eq([a.kind, a.target, a.level, a.hero], ['claimFlat', { x: 104, y: 100 }, 5, 'Brawler']);
    eq(a.troops, V.CAPTURE_TROOPS[5]);
    eq(a.rally.kind, 'b');
    const r = await B.executors.claimFlat(w.game, w.home, a, state);
    eq(r.ok, 1);
    eq([w.game.sent[0].bean.missionType, w.game.sent[0].bean.targetPoint], [C.MISSION.attack, fid(104, 100)]);
    eq(state.buildnpc.claims[fid(104, 100)].stage, 'capturing');
    eq(D.registry.get(ACC, fid(104, 100)), null, 'the registry claim waits for the founding');
    // the claim counts against /maxconcurrent, and the plan says it is on its way
    w.game.player.selfArmys = [{ startFieldId: w.home.fieldId, targetFieldId: fid(104, 100), missionType: C.MISSION.attack, direction: 1 }];
    has(bplan('config buildnpc:5', w, { state }).p.note, 'the capture is on its way');
  });

  await t('buildnpc:15 builds levels 5 and 10; npcbuildpolicy says how far out each goes', () => {
    const w = setup();
    const tiles = [tile(101, 100, 'flat', 3), tile(106, 100, 'flat', 10), tile(109, 100, 'flat', 5)];
    eq(bplan('config buildnpc:15', w, { tiles }).p.actions[0].target, { x: 106, y: 100 });
    eq(bplan('config buildnpc:15\nnpcbuildpolicy /level:10 /mindistance:1 /maxdistance:5\nnpcbuildpolicy /level:5 /mindistance:5 /maxdistance:15', w, { tiles }).p.actions[0].target,
      { x: 109, y: 100 }, 'the L10 at 6 is past its 5');
    eq(bplan('config buildnpc:20', w, { tiles }).p.actions[0].target, { x: 101, y: 100 }, '20: every flat');
    eq(bplan('config buildnpc:5\nbuildnpclist 109,100', w, { tiles }).p.actions[0].target, { x: 109, y: 100 });
    eq(bplan('config buildnpc:5\nexcludelist 109,100', w, { tiles }).p.actions, []);
    has(bplan('config buildnpc:6', w, { tiles }).p.note, 'held: config buildnpc:6 is not');
  });

  await t('held: the founding — registry claim FIRST, then city.constructCastle from the holding city, troops sent home', async () => {
    const w = setup();
    const state = { accountId: ACC, buildnpc: { claims: { [fid(104, 100)]: { stage: 'capturing', sentAt: Date.now() - 60000, level: 5 } } } };
    w.home.fields = [field(104, 100, 'flat', 5)];
    const { p } = bplan('config buildnpc:5', w, { state });
    eq(state.buildnpc.claims[fid(104, 100)].stage, 'held');
    const a = p.actions[0];
    eq([a.kind, a.fieldId], ['foundCity', fid(104, 100)]);
    const r = await B.executors.foundCity(w.game, w.home, a, state);
    eq(r.ok, 1);
    eq(w.game.built, [{ castleId: 7, fieldId: fid(104, 100), isTroopBack: true }]);
    const row = D.registry.get(ACC, fid(104, 100));
    eq([row.origin, row.state, row.abandonable], ['buildnpc', 'pending-build', false]);
    eq(state.buildnpc.claims[fid(104, 100)].stage, 'founding');
    // the city appears: reconcile promotes the claim, and the plan closes it
    const built = city({ castleId: 9, id: 9, name: 'NewNpc', fieldId: fid(104, 100) });
    w.game.castles.push(built);
    w.home.fields = [];
    D.registry.reconcile(ACC, w.game.castles.map((c) => ({ fieldId: c.fieldId, castleId: c.castleId, name: c.name })));
    eq(D.registry.get(ACC, fid(104, 100)).state, 'built');
    const after = bplan('config buildnpc:5', w, { state }).p;
    has(after.note, 'the npc city stands (registry: built)');
    eq(state.buildnpc.claims[fid(104, 100)], undefined);
  });

  await t('the final check refuses a founding the live state no longer allows', async () => {
    const w = setup();
    const state = { accountId: ACC, buildnpc: { claims: { [fid(104, 100)]: { stage: 'held', heldAt: Date.now(), level: 5 } } } };
    const a = { kind: 'foundCity', fieldId: fid(104, 100), target: { x: 104, y: 100 }, level: 5 };
    let r = await B.executors.foundCity(w.game, w.home, a, state);
    eq(r.ok, 0);
    has(r.errorMsg, 'not held by this city');
    w.home.fields = [field(104, 100, 'flat', 5)];
    w.home.troop = { peasants: 10 };
    r = await B.executors.foundCity(w.game, w.home, a, state);
    eq(r.ok, 0);
    has(r.errorMsg, 'needs 250 workers');
    eq(w.game.built, []);
    eq(D.registry.get(ACC, fid(104, 100)), null, 'nothing recorded for a founding that never went');
  });

  await t('a refused founding is asked again after 10 minutes, three times, then the claim is let go', async () => {
    const w = setup();
    w.home.fields = [field(104, 100, 'flat', 5)];
    w.game.buildReply = () => ({ ok: 0, errorMsg: 'no' });
    const state = { accountId: ACC, buildnpc: { claims: { [fid(104, 100)]: { stage: 'held', heldAt: Date.now(), level: 5 } } } };
    const a = { kind: 'foundCity', fieldId: fid(104, 100), target: { x: 104, y: 100 }, level: 5 };
    eq((await B.executors.foundCity(w.game, w.home, a, state)).ok, 0);
    has(bplan('config buildnpc:5', w, { state }).p.note, 'founding was refused (no), asked again in');
    eq((await B.executors.foundCity(w.game, w.home, a, state)).ok, 0);
    eq((await B.executors.foundCity(w.game, w.home, a, state)).ok, 0);
    eq(state.buildnpc.claims[fid(104, 100)], undefined);
    eq(D.registry.get(ACC, fid(104, 100)).state, 'abandoned', 'the claim no longer counts');
  });

  await t('a let-go founding rests its flat 6 hours, then it may be founded again', async () => {
    const w = setup();
    w.home.fields = [field(104, 100, 'flat', 5)];
    w.game.buildReply = () => ({ ok: 0, errorMsg: 'no' });
    const state = { accountId: ACC, buildnpc: { claims: { [fid(104, 100)]: { stage: 'held', heldAt: Date.now(), level: 5 } } } };
    const a = { kind: 'foundCity', fieldId: fid(104, 100), target: { x: 104, y: 100 }, level: 5 };
    for (let i = 0; i < 3; i++) await B.executors.foundCity(w.game, w.home, a, state);
    eq(D.registry.get(ACC, fid(104, 100)).state, 'abandoned');
    const soon = bplan('config buildnpc:5', w, { state, tiles: [] }).p;
    eq(soon.actions, []);
    eq(state.buildnpc.claims[fid(104, 100)], undefined, 'not taken back at once');
    bplan('config buildnpc:5', w, { state, tiles: [], now: Date.now() + 7 * H1 });
    eq(state.buildnpc.claims[fid(104, 100)].stage, 'held', 'six hours on it is tried again');
  });

  await t('rallypolicy b: holds buildnpc\'s captures', () => {
    const w = setup();
    const { p } = bplan('config buildnpc:5\nrallypolicy b:0', w);
    eq(p.actions, []);
    has(p.note, 'rallypolicy b:0');
  });

  await t('valleytroops /type:flat is the load for a flat (wiki ValleyTroops: "valleys & flats")', () => {
    const w = setup();
    eq(bplan('config buildnpc:5\nvalleytroops /type:flat /level:5 s:20000', w).p.actions[0].troops, { scouter: 20000 });
  });

  await t('a capture that never took the flat is dropped after 10 minutes, and the flat rests 6 hours', () => {
    const w = setup();
    const state = { accountId: ACC, buildnpc: { claims: { [fid(104, 100)]: { stage: 'capturing', sentAt: Date.now() - 11 * 60000, level: 5 } } } };
    const { p } = bplan('config buildnpc:5', w, { state, tiles: [tile(104, 100, 'flat', 5), tile(109, 100, 'flat', 5)] });
    has(p.note, 'the capture did not take the flat');
    eq(state.buildnpc.claims[fid(104, 100)], undefined);
    assert.ok(state.buildnpc.failed[fid(104, 100)]);
    eq(p.actions[0].target, { x: 109, y: 100 }, 'buildnpc goes on with the next flat');
  });

  await t('a founding that never became a city is let go after 30 minutes (it used to stop buildnpc for good)', () => {
    const w = setup();
    D.registry.claimFlat(ACC, fid(104, 100), { x: 104, y: 100 }, 'buildnpc: founding');
    const state = { accountId: ACC, buildnpc: { claims: { [fid(104, 100)]: { stage: 'founding', foundAt: Date.now() - 31 * 60000, level: 5 } } } };
    const { p } = bplan('config buildnpc:5', w, { state, tiles: [tile(109, 100, 'flat', 5)] });
    has(p.note, 'no city stands there — the claim is let go (registry)');
    eq(D.registry.get(ACC, fid(104, 100)).state, 'abandoned');
    eq(p.actions[0].target, { x: 109, y: 100 });
  });

  await t('a claim from the old occupy flow: let go after an hour with nothing behind it; founded when this city holds the flat', () => {
    const w = setup();
    D.registry.claimFlat(ACC, fid(104, 100), { x: 104, y: 100 }, 'buildnpc: occupying');
    D.registry.claimFlat(ACC, fid(90, 90), { x: 90, y: 90 }, 'buildnpc: occupying');
    D.run('UPDATE city_registry SET firstSeen = ? WHERE accountId = ?', Date.now() - 2 * H1, ACC);
    w.home.fields = [field(90, 90, 'flat', 5)];
    const state = { accountId: ACC };
    const { p } = bplan('config buildnpc:5', w, { state, tiles: [] });
    eq(D.registry.get(ACC, fid(104, 100)).state, 'abandoned');
    eq(D.registry.get(ACC, fid(90, 90)).state, 'pending-build', 'the held one is kept');
    eq(state.buildnpc.claims[fid(90, 90)].stage, 'held');
    eq(p.actions[0].kind, 'foundCity');
    // a fresh one is left alone
    D.registry.claimFlat(ACC, fid(111, 100), { x: 111, y: 100 });
    D.run('UPDATE city_registry SET firstSeen = ? WHERE accountId = ? AND fieldId = ?', Date.now() - 10 * 60000, ACC, fid(111, 100));
    bplan('config buildnpc:5', w, { state, tiles: [] });
    eq(D.registry.get(ACC, fid(111, 100)).state, 'pending-build');
  });

  await t('expireClaim only ever touches a buildnpc claim still pending: never a built or protected row', () => {
    const w = setup();
    eq(BI.expireClaim(ACC, w.home.fieldId), false);
    eq(D.registry.get(ACC, w.home.fieldId).state, 'protected');
    D.registry.claimFlat(ACC, fid(120, 120), { x: 120, y: 120 });
    const b = city({ castleId: 12, id: 12, fieldId: fid(120, 120) });
    D.registry.markBuilt(ACC, fid(120, 120), b.castleId, 'B');
    eq(BI.expireClaim(ACC, fid(120, 120)), false);
    eq(D.registry.get(ACC, fid(120, 120)).state, 'built');
  });

  await t('a flat this city already holds at a wanted level is founded without a march', () => {
    const w = setup();
    w.home.fields = [field(104, 100, 'flat', 5)];
    const state = { accountId: ACC };
    const first = bplan('config buildnpc:5,acquireflats:1', w, { state }).p;
    has(first.note, 'a held L5 flat — founded next');
    eq(first.actions, []);
    eq(bplan('config buildnpc:5,acquireflats:1', w, { state }).p.actions[0].kind, 'foundCity');
    eq(w.game.sent, []);
  });

  await t('/maxconcurrent: a built city past the 24 h window says to abandon it by hand', () => {
    const w = setup();
    D.registry.claimFlat(ACC, fid(130, 130), { x: 130, y: 130 });
    D.registry.markBuilt(ACC, fid(130, 130), 44, 'Old');
    D.run('UPDATE city_registry SET builtAt = ? WHERE accountId = ? AND fieldId = ?', Date.now() - 30 * H1, ACC, fid(130, 130));
    const { p } = bplan('config buildnpc:5', w);
    eq(p.actions, []);
    has(p.note, '1/1 flat(s) already being converted');
    has(p.note, 'past the 24h window — it is left alone for good; abandon it by hand');
  });

  await t('the abandon guard is unchanged: a city buildnpc did not found is never abandoned', () => {
    const w = setup();
    const { p } = bplan('config buildnpc:5', w);
    assert.ok(!p.actions.some((a) => a.kind === 'abandonCity'));
    for (const c of w.game.castles) eq(BI.canAbandon({ accountId: ACC, game: w.game, castle: c }).ok, false);
  });

  // ============================================================= the map scan
  section('the background map scan reads around cities with a valley goal');

  await t('who is scanned, and how far', () => {
    const ctxOf = (src) => { const p = G.parseGoals(src); return { config: p.config, goals: p.goals }; };
    const I2 = NPC._internals;
    eq(I2.scanWanted({ valley: 10 }, []), true);
    eq(I2.scanWanted({}, ctxOf('safevalleyfarm 10').goals), true);
    eq(I2.scanWanted({ hunting: 5 }, []), true);
    eq(I2.scanWanted({ acquireflats: 1 }, []), true);
    eq(I2.scanWanted({ valley: 10, mapscan: 0 }, []), false, 'mapscan:0 still wins');
    eq(I2.scanWanted({ comfort: 1 }, []), false);
    eq(I2.scanAreaFor(ctxOf('config valley:10\ndistancepolicy 10 10 10 30')).radius, 30);
    eq(I2.scanAreaFor(ctxOf('config valleyfarming:10\nvalleyfarming 5 0 25 0 0 0')).radius, 25);
    eq(I2.scanAreaFor(ctxOf('config acquireflats:1\nnpcbuildpolicy /level:5 /mindistance:5 /maxdistance:18')).radius, 18);
    eq(I2.scanAreaFor(ctxOf('config buildnpc:5\nnpcbuildpolicy /level:5 /mindistance:5 /maxdistance:22')).radius, 22, 'buildnpc\'s farthest band');
    const hp = I2.scanAreaFor(ctxOf('config hunting:5\nhuntingpos 400,400'));
    eq([hp.radius, hp.points], [10, [{ x: 400, y: 400 }]]);
    eq(NPC.scanPlan({ cities: [{ name: 'A', xy: HOME, config: { valley: 10 }, goals: [] }], now: 10 * H1, seenOf: () => 0 }).wanted, 4);
  });

  // =================================================================== engine
  section('through the engine');

  await t('dry run plans the capture; live, it asks the game about the tile and sends one attack', async () => {
    D.run('DELETE FROM map_cache');
    D.mapCache.upsertMany([{ id: fid(103, 100), x: 103, y: 100, kind: 'forest', level: 5, seen: Date.now() }]);
    const c = city();
    const game = fakeGame([c]);
    const lines = [];
    const e = new Engine(game, (m) => lines.push(String(m)));
    e.state = {};
    e.goalsFor = () => G.parseGoals('config hero:0,valley:5');
    e.controlsFor = () => ({ gate: 'auto', wartown: 'auto' });
    e.dryRun = true;
    await e.tick();
    has(lines.join('\n'), '[plan] capture L5 forest at 103,100');
    eq(game.sent.length, 0);
    e.dryRun = false;
    await e.tick();
    eq(game.sent.length, 1);
    eq(reqsOf(game, 'field.getOtherFieldInfo').map((d) => d.fieldId), [fid(103, 100)]);
    has(lines.join('\n'), 'capture L5 forest at 103,100');
    assert.ok(e.state[String(c.castleId)].valley.marches[fid(103, 100)]);
  });

  await t('every valley goal at once, through two engine ticks: no plan fails, buildnpc and the valley goals share the slots', async () => {
    D.run('DELETE FROM map_cache');
    D.run('DELETE FROM city_registry');
    D.accounts.upsert({ id: 'eng1', label: 'E', email: 'e@t', password: 'pw' });
    const now = Date.now();
    D.mapCache.upsertMany([
      { id: fid(103, 100), x: 103, y: 100, kind: 'forest', level: 5, seen: now },
      { id: fid(104, 100), x: 104, y: 100, kind: 'flat', level: 5, seen: now },
      { id: fid(105, 100), x: 105, y: 100, kind: 'hill', level: 10, seen: now },
      { id: fid(100, 106), x: 100, y: 106, kind: 'forest', level: 10, seen: now },
    ]);
    const c = city({ th: 3 });
    const other = city({ castleId: 8, id: 8, name: 'Other', fieldId: fid(300, 300) });
    const game = fakeGame([c, other]);
    D.registry.reconcile('eng1', game.castles.map((x) => ({ fieldId: x.fieldId, castleId: x.castleId, name: x.name })));
    const lines = [];
    const e = new Engine(game, (m) => lines.push(String(m)), 'eng1');
    e.state = {};
    const src = { Testville: 'config hero:0,valley:5,hunting:5,acquireflats:2,abandonflats:1,buildnpc:5,valleyfarming:10\nvalleyfarming 10 0 10 0 0 0\nsafevalleyfarm 10\nvalleyheroes any', Other: 'config hero:0,abandon:1,comfort:0' };
    e.goalsFor = (id, name) => G.parseGoals(src[name] || '');
    e.controlsFor = () => ({ gate: 'auto', wartown: 'auto' });
    e.dryRun = false;
    await e.tick();
    await e.tick();
    const log = lines.join('\n');
    assert.ok(!/plan "[a-z]+" failed/.test(log), log);
    // three slots: the hunting one kept free, so at most two captures between valley, flats and buildnpc
    const captures = game.sent.filter((s) => s.bean.missionType === C.MISSION.attack);
    assert.ok(captures.length >= 1 && captures.length <= 3, `${captures.length} attack(s)`);
    const targets = captures.map((s) => s.bean.targetPoint);
    eq(new Set(targets).size, targets.length, 'never two attacks on one tile');
    has(log, 'safevalleyfarm 10 — does nothing while config hunting is on');
    has(log, 'abandon:1');
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
