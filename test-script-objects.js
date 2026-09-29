'use strict';
// The script object model, offline: what `city`, `cities`, `m_context`,
// `player`, `Screen` and `Config` read, and the bean functions. The Game is
// real (castle lookup, castle ids, the clock); game.req is stubbed, and army,
// troop, resource and chat pushes go through session.js's own push handler
// on a fake socket. Nothing connects.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-so-')), 't.db');   // goals.js opens it
const EventEmitter = require('events');
const C = require('./constants');
const { Game } = require('./game');
const { Session } = require('./session');
const O = require('./script-objects');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const F = (x, y) => C.coordsToFieldId(x, y);
const NOW = Date.UTC(2026, 8, 14, 17, 30, 15);     // the server's epoch in every test

// City 9 at 571,648 has five heroes (one the mayor, one out, one a prisoner),
// buildings, valleys, trades and buffs. Fla at 484,619 has almost nothing.
function world() {
  const g = new Game();
  g.now = () => NOW;
  g.serverTzOffsetMs = -5 * 3600000;               // ss71: UTC-5
  g.c = new EventEmitter();
  g.player = {
    currentTime: NOW - 3600000, currentDateTime: '2026.09.14 11.30.15',
    playerInfo: { userName: 'Lord02', accountName: 'secret@example.com', prestige: 100000, castleCount: 2, titleId: 3, sex: 0, alliance: 'Allies', medal: 50 },
    castleSignBean: [{ id: 1, name: 'home', x: 1, y: 2 }],
    friendBeans: [{ userName: 'Pal', accountName: 'pal@example.com', prestige: 5 }],
    blockBeans: [{ userName: 'Troll', accountName: 'troll@example.com' }],
    items: [{ id: 'player.box.gambling.3', count: 7 }, { id: 'player.peace.1', count: 1 }],
    buffs: [
      { typeId: 'PlayerPeaceBuff', endTime: NOW + 3600000, descName: 'Truce' },
      { typeId: 'OldPlayerBuff', endTime: NOW - 1000, descName: 'gone' },
    ],
    selfArmys: [
      { armyId: 1, missionType: 5, direction: 1, startFieldId: F(571, 648), targetFieldId: F(580, 650), startPosName: '9', targetPosName: "Barbarian's city",
        hero: 'Rider', heroLevel: 40, troop: { archer: 5000, carriage: 10 }, resource: {}, startTime: NOW - 60000, reachTime: NOW + 600000 },
      { armyId: 2, missionType: 5, direction: 2, startFieldId: F(571, 648), targetFieldId: F(560, 660), startPosName: '9', targetPosName: 'Forest',
        hero: 'Other', heroLevel: 20, troop: { archer: 1000 }, resource: { food: 30000 }, startTime: NOW - 600000, reachTime: NOW + 45000 },
      { armyId: 3, missionType: 1, direction: 1, startFieldId: F(484, 619), targetFieldId: F(571, 648), startPosName: 'Fla', targetPosName: '9',
        troop: { carriage: 10 }, resource: { wood: 20000 }, startTime: NOW - 60000, reachTime: NOW + 120000 },
    ],
    enemyArmys: [],
    friendArmys: [
      { armyId: 9, missionType: 1, direction: 1, startFieldId: F(100, 100), targetFieldId: F(571, 648), king: 'Pal', alliance: 'Allies',
        troop: { carriage: '5' }, resource: { stone: 7000 }, reachTime: NOW + 1800000 },
    ],
  };
  g.castles = [
    {
      id: 1, name: '9', fieldId: F(571, 648), logUrl: 'images/castle.png', status: 0, allowAlliance: true, goOutForBattle: false, hasEnemy: true,
      usePACIFY_SUCCOUR_OR_PACIFY_PRAY: 2,
      heros: [
        { id: 11, name: 'Trebber', status: 0, level: 200, power: 250, management: 30, stratagem: 20, powerBuffAdded: 25, loyalty: 100,
          experience: 5000000, upgradeExp: 4000000, remainPoint: 0, buffs: [{ typeId: 'HeroPowerBuff', endTime: NOW + 60000, descName: 'Excalibur' }] },
        { id: 12, name: 'QUEEN', status: 1, level: 193, power: 67, management: 254, stratagem: 21, loyalty: 88, experience: 4737560, upgradeExp: 3724900, remainPoint: 0 },
        { id: 13, name: 'Rider', status: 3, level: 40, power: 350, management: 10, stratagem: 10, loyalty: 100 },
        { id: 14, name: 'Prisoner', status: 4, level: 90, power: 500, management: 10, stratagem: 10, loyalty: 10 },
        { id: 15, name: 'Weak', status: 0, level: 50, power: 150, management: 20, stratagem: 60, loyalty: 100, remainPoint: 3 },
      ],
      troop: { ...C.EMPTY_TROOPS, archer: 120000, scouter: 5000, carriage: 1000 },
      resource: {
        food: { amount: 2000000, increaseRate: 50000, max: 5000000, storeRercent: 25, workPeople: 1000 },
        wood: { amount: 300000, increaseRate: 9000, max: 5000000, storeRercent: 25, workPeople: 500 },
        stone: { amount: 400000, increaseRate: 8000, max: 5000000, storeRercent: 25, workPeople: 500 },
        iron: { amount: 500000, increaseRate: 7000, max: 5000000, storeRercent: 25, workPeople: 500 },
        gold: 900000, curPopulation: 18000, maxPopulation: 20000, workPeople: 2500, buildPeople: 50,
        support: 90, complaint: 5, troopCostFood: 20000, herosSalary: 1500, texRate: 20, taxIncome: 3000, populationDirection: 1,
      },
      fortification: { trap: 100, abatis: 200, arrowTower: 300, rollingLogs: 0, rockfall: 11 },
      buildings: [
        { typeId: 31, level: 10, positionId: -1, name: 'Town Hall', status: 0, startTime: 0, endTime: 0 },
        { typeId: 32, level: 8, positionId: -2, name: 'Walls', status: 0 },
        { typeId: 2, level: 9, positionId: 3, name: 'Barracks', status: 0 },
        { typeId: 2, level: 10, positionId: 4, name: 'Barracks', status: 0 },
        { typeId: 29, level: 3, positionId: 5, name: 'Rally Spot', status: 0 },
        { typeId: 27, level: 6, positionId: 6, name: 'Feasting Hall', status: 0 },
        { typeId: 23, level: 7, positionId: 7, name: 'Marketplace', status: 0 },
        { typeId: 6, level: 5, positionId: 1001, name: 'Ironmine', status: 0 },
        { typeId: 6, level: 7, positionId: 1002, name: 'Ironmine', status: 0 },
        { typeId: 6, level: 2, positionId: 1003, name: 'Ironmine', status: 0 },
        { typeId: 4, level: 6, positionId: 1004, name: 'Sawmill', status: 1, startTime: NOW - 1000, endTime: NOW + 60000 },
      ],
      fields: [
        { id: F(575, 650), level: 7, name: 'Forest', statu: 0, type: 1 },
        { id: F(560, 640), level: 3, name: 'Lake', statu: 0, type: 6 },
      ],
      trades: [{ id: 501, resType: 0, tradeType: 1, amount: 100000, price: 1.2, dealedAmount: 0, dealedTotal: 0, resourceName: 'Food', tradeTypeName: 'Sell' }],
      transingTrades: [{ id: 601, resType: 1, amount: 50000, price: 0.5, endTime: NOW + 60000, resourceName: 'Lumber', total: 25000 }],
      buffs: [
        { typeId: 'ForceopenclosegateBuff', endTime: NOW + 3600000, descName: 'Gates forced open' },
        { typeId: 'ForceopenclosegateCooldownBuff', endTime: NOW + 7200000, descName: 'cooldown' },
        { typeId: 'OldCastleBuff', endTime: NOW - 1000, descName: 'gone' },
      ],
    },
    { id: 2, name: 'Fla', fieldId: F(484, 619), heros: [], troop: { archer: 10 }, resource: { gold: 5 }, buildings: [], fields: [] },
  ];

  // game.req stands in for the socket: every read-only command the objects
  // may send, counted.
  const calls = [];
  const replies = {
    'tech.getResearchList': () => ({ acailableResearchBeans: [
      { typeId: 14, level: 8, avalevel: 10, upgradeing: false, castleId: 1, startTime: 0, endTime: 0, permition: true, conditionBean: { x: 1 } },
      { typeId: 11, level: 5, avalevel: 10, upgradeing: true, castleId: 1, startTime: NOW - 1000, endTime: NOW + 3600000, permition: true },
    ] }),
    'hero.getHerosListFromTavern': () => ({ heros: [{ id: 91, name: 'InnGuy', level: 30, power: 80, powerAdded: 29, management: 20, stratagem: 15, status: 0 }] }),
    'troop.getProduceQueue': () => ({ allProduceQueue: [
      { positionId: 3, allProduceQueue: [{ queueId: 1, type: 7, num: 5000 }, { queueId: 2, type: 11, num: 100 }] },
      { positionId: 4, allProduceQueue: [{ queueId: 3, type: 7, num: 1000 }] },
    ] }),
    'interior.getResourceProduceData': () => ({ resourceProduceDataBean: [
      { typeid: 1, commenceRate: 100 }, { typeid: 2, commenceRate: 50 }, { typeid: 3, commenceRate: 25 }, { typeid: 4, commenceRate: 0 },
    ] }),
    'army.getTroopParam': () => ({ marchSkillParam: 50, driveSkillParam: 30, loadSkillParam: 100, transportStationParam: 0 }),
    'fortifications.getProduceQueue': () => ({ allProduceQueue: [
      { positionId: -2, allProduceQueue: [{ queueId: 8, type: 14, num: 50 }, { queueId: 9, type: 18, num: 5 }] },
    ] }),
  };
  g.req = async (cmd, data) => {
    calls.push({ cmd, data });
    if (!replies[cmd]) throw new Error('no reply to ' + cmd);
    return replies[cmd](data);
  };
  return { g, calls, replies, busy: new Set() };
}

// The console's session, minus the constructor: its push handler, log rings,
// city controls and a goal store holding each city's goals.
function fakeSession(w, goals = {}) {
  const s = Object.create(Session.prototype);
  const store = new Map();
  Object.assign(s, {
    game: w.g, chat: { alliance: [], world: [], private: [], system: [] }, reports: [], log: [], acts: [],
    maint: { plan: null }, account: { id: 'a1', server: 'ss71' },
    org: {
      settings: { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v) },
      goals: { own: (...key) => (goals[key[2]] === undefined ? null : { src: goals[key[2]] }) },   // (account, castleId, name, kind)
    },
  });
  s.wire(w.g);
  return s;
}
const push = (w, cmd, data) => w.g.c.emit('cmd', cmd, data);

function context(w, { castle = '9', session, opts = {} } = {}) {
  const out = [];
  const ctx = {
    get game() { return w.g; },
    get castle() { return w.g.castle(castle); },
    session, opts, dryRun: false,
    log: (m) => out.push(m), vars: new Map(),
    busyHeroes: (id) => w.busy.has(id),
  };
  return { ctx, G: O.globals(ctx), out };
}

const GOALS = [
  'config hero:10,wartown:1',
  'traininghero QUEEN 3600',
  'fortification tra:500,ab:500',
  'fortification tra:1000,at:1000',
  'defensepolicy /junktroop:5000',
].join('\n');

// ---------------------------------------------------------------------------
section('beans: troop, resource and fortification strings');

t('GetTroops reads a troop string and TroopBeanToString gives it back', () => {
  const { G } = context(world());
  const b = G.GetTroops('a:30k,b:40k,w:1,p:1,sw:1');
  assert.deepStrictEqual({ ...b }, { ...C.EMPTY_TROOPS, archer: 30000, ballista: 40000, militia: 1, pikemen: 1, swordsmen: 1 });
  const s = G.TroopBeanToString(b, ',');
  assert.strictEqual(s, 'w:1,p:1,sw:1,a:30000,b:40000');
  assert.deepStrictEqual({ ...G.GetTroops(s) }, { ...b }, 'round trip');
  assert.strictEqual(G.TroopBeanToString(b, '\n'), 'w:1\np:1\nsw:1\na:30000\nb:40000');
  assert.strictEqual(String(b), s, 'echo prints the troop string');
});
t('a bad troop string is null, as NEAT scripts test for; nothing prints as a:0', () => {
  const { G } = context(world());
  assert.strictEqual(G.GetTroops('zz:5'), null);
  assert.strictEqual(G.GetTroops(''), null);
  for (const s of ['toString:5', 'constructor:1', '__proto__:1']) assert.strictEqual(G.GetTroops(s), null, s);
  assert.strictEqual(G.GetFortifications('valueOf:1'), null);
  const none = G.GetTroops('a:0');
  assert.strictEqual(G.TroopBeanToString(none), 'a:0');
  assert.deepStrictEqual({ ...G.GetTroops(G.TroopBeanToString(none)) }, { ...C.EMPTY_TROOPS });
});
t('foodConsumeRate is per hour and foodConsumption(sec) scales it', () => {
  const { G } = context(world());
  const b = G.GetTroops('a:30k,b:40k,w:1,p:1,sw:1');
  assert.strictEqual(b.foodConsumeRate, 30000 * 9 + 40000 * 50 + 3 + 6 + 7);
  assert.strictEqual(b.foodConsumption(60), b.foodConsumeRate / 60);
  assert.ok(!Object.keys(b).includes('foodConsumeRate'), 'the bean lists only the twelve types');
});
t('add and addTo sum beans and return nothing (NEAT chains them with ||)', () => {
  const { G } = context(world());
  const total = G.GetTroops('a:0');
  assert.strictEqual(total.add(G.GetTroops('a:5,c:2')), undefined);
  assert.strictEqual(G.GetTroops('a:1').addTo(total), undefined);
  total.add('s:3');
  assert.strictEqual(G.TroopBeanToString(total), 's:3,a:6,c:2');
  const unknown = O.troopBean({ archer: '?', scouter: '4', pikemen: '1000-2000' });
  assert.deepStrictEqual([unknown.archer, unknown.scouter, unknown.pikemen], ['?', 4, '1000-2000'],
    "an unscouted '?' and a scout report's range stay as text, counts become numbers");
  assert.strictEqual(String(unknown), 's:4,p:1000-2000,a:?');
  assert.strictEqual(unknown.foodConsumeRate, 4 * 5, 'text eats nothing it can count');
  total.add(unknown);
  assert.deepStrictEqual([total.archer, total.pikemen, total.scouter], ['?', '?', 7]);
});
t('beans accept codes, protocol keys, NEAT words and troop strings alike', () => {
  assert.strictEqual(O.troopBean({ a: 5, archer: 5 }).archer, 10);
  assert.strictEqual(O.troopBean('cata:2').heavyCavalry, 2);
  const { G } = context(world());
  assert.strictEqual(G.TroopBeanToString(G.GetTroops('arch:25000,warr:25000,t:1000')), 'w:25000,a:25000,t:1000', 'NEAT words (script-words.js)');
});
t('resource beans: add/addTo and a readable string that parses back', () => {
  const r = O.getResources('f:1m,g:5');
  assert.deepStrictEqual({ ...r }, { gold: 5, food: 1000000, wood: 0, stone: 0, iron: 0 });
  assert.strictEqual(String(r), 'f:1000000,g:5');
  const sum = O.resourceBean({});
  assert.strictEqual(String(sum), 'f:0');
  assert.strictEqual(r.addTo(sum), undefined);
  sum.add({ wood: 7 });
  assert.strictEqual(String(sum), 'f:1000000,w:7,g:5');
  assert.deepStrictEqual({ ...O.getResources(String(sum)) }, { ...sum }, 'round trip');
  assert.strictEqual(O.getResources('gold:oops'), null);
  assert.deepStrictEqual({ ...O.resourceBean({ lumber: 2, food: { amount: 9 } }) }, { gold: 0, food: 9, wood: 2, stone: 0, iron: 0 },
    'words, and a castle kind reads as its amount');
});
t('GetFortifications reads NEAT codes (tra ab at r tre)', () => {
  const { G } = context(world());
  const f = G.GetFortifications('tra:100,ab:5,at:3,r:2,tre:11');
  assert.deepStrictEqual({ ...f }, { trap: 100, abatis: 5, arrowTower: 3, rollingLogs: 2, rockfall: 11 });
  assert.strictEqual(String(f), 'tra:100,ab:5,at:3,r:2,tre:11');
  assert.strictEqual(G.GetFortifications('moat:1'), null);
});

// ---------------------------------------------------------------------------
section('the city: values');

t('who and where', () => {
  const { G } = context(world());
  const c = G.city;
  assert.deepStrictEqual([c.name, c.id, c.fieldId, c.x, c.y, c.coords, c.cityCoords, c.timeSlot], ['9', 1, F(571, 648), 571, 648, '571,648', '571,648', 0]);
  assert.strictEqual(c.cityNameCoords(), '9 (571,648)');
  assert.strictEqual(String(c), '9 (571,648)');
  assert.strictEqual(c.cityManager, c, 'city.cityManager is the city');
  assert.strictEqual(G.m_city.cityManager.name, '9');
  assert.deepStrictEqual(G.cities.map((x) => x.cityManager.name), ['9', 'Fla']);
  assert.strictEqual(G.cities[1].timeSlot, 1);
  assert.strictEqual(G.cities[5], undefined, 'past the end is undefined, so `if cs == null` works');
});
t('resource: the CastleResourceBean with its typos', () => {
  const { G } = context(world());
  const r = G.city.resource;
  assert.deepStrictEqual([r.food.amount, r.food.storeRercent, r.gold, r.texRate, r.support, r.complaint, r.troopCostFood, r.maxPopulation],
    [2000000, 25, 900000, 20, 90, 5, 20000, 20000]);
  assert.ok(r.food > 1500000, 'a kind compares as its amount');
  assert.strictEqual(String(r.iron), '500000');
  assert.strictEqual(G.city.resource['wood'].amount, 300000, 'city.resource[resName] as TradeScript reads it');
});
t('estResource, and reservedResource derived from upkeep and salary', () => {
  const { G } = context(world());
  assert.deepStrictEqual({ ...G.city.estResource }, { gold: 900000, food: 2000000, wood: 300000, stone: 400000, iron: 500000 });
  assert.deepStrictEqual({ ...G.city.resetEstResource() }, { ...G.city.estResource });
  // a day of troop food + one disaster relief (grievance 5), a day of hero salary
  const relief = 100000 / 10 * 2 * 2;
  assert.deepStrictEqual({ ...G.city.reservedResource }, { gold: 1500 * 24, food: 20000 * 24 + relief, wood: 0, stone: 0, iron: 0 });
});
t('troop, troops, and getAvailableTroop with and without marches', () => {
  const { G } = context(world());
  assert.strictEqual(G.city.troop.archer, 120000);
  assert.strictEqual(G.city.troops.scouter, 5000);
  assert.strictEqual(G.city.troop.foodConsumeRate, 120000 * 9 + 5000 * 5 + 1000 * 10);
  const all = G.city.getAvailableTroop();
  assert.deepStrictEqual([all.archer, all.carriage], [120000 + 5000 + 1000, 1000 + 10], 'troops out on its marches count');
  assert.strictEqual(G.city.getAvailableTroop(true).archer, 120000, 'true = in the city only');
});
t('fortification and what the goal stage asks for', () => {
  const w = world();
  const { G } = context(w, { session: fakeSession(w, { 9: GOALS }) });
  assert.deepStrictEqual({ ...G.city.fortification }, { trap: 100, abatis: 200, arrowTower: 300, rollingLogs: 0, rockfall: 11 });
  assert.strictEqual(G.city.fortification.rockfall, 11, 'trebs are rockfall');
  assert.deepStrictEqual({ ...G.city.fortificationsRequirement }, { trap: 500, abatis: 500, arrowTower: 0, rollingLogs: 0, rockfall: 0 });
  w.g.castles[0].fortification = { trap: 600, abatis: 500 };
  assert.deepStrictEqual({ ...G.city.fortificationRequirement }, { trap: 1000, abatis: 0, arrowTower: 1000, rollingLogs: 0, rockfall: 0 }, 'the next stage');
  assert.strictEqual(context(world()).G.city.fortificationsRequirement.trap, 0, 'no goals, nothing required');
});
t('buildings and the BuildingFunctions', () => {
  const { G } = context(world());
  const c = G.city;
  assert.strictEqual(c.buildings.length, 11);
  assert.deepStrictEqual([c.getBuildingLevel(2), c.getBuildingByTypeId(2).positionId, c.getBuildingByPosId(-1).name], [10, 4, 'Town Hall']);
  assert.deepStrictEqual([c.countBuilding(6), c.countBuilding(6, 5, 10), c.countBuilding(6, 1, 5), c.countBuilding(25)], [3, 2, 2, 0]);
  assert.deepStrictEqual([c.hasBuilding(2, 10), c.hasBuilding(25), c.hasBuilding(6)], [true, false, true]);
  assert.deepStrictEqual([c.getTownHallLevel(), c.getWallLevel(), c.getBuildingLevel(25)], [10, 8, 0]);
  assert.strictEqual(c.getBuildingByTypeId(25), null);
  assert.strictEqual(c.getActiveBuilding().typeId, 4, 'the sawmill being upgraded');
  assert.strictEqual(String(c.getBuildingByPosId(4)), 'Barracks L10');
  const inside = c.getEmptyPositions(1);
  assert.ok(!inside.includes(3) && inside.includes(0) && inside.length === 32 - 5, 'plots 3-7 are taken: ' + inside.length);
  assert.ok(c.getEmptyPositions(6).every((p) => p >= 1005 && p <= 1040), 'a mine goes outside');
});
t('fields, trades, trades in transit and the castle bean', () => {
  const w = world();
  const { G } = context(w);
  const c = G.city;
  assert.strictEqual(c.fields.length, 2);
  assert.deepStrictEqual([c.fields[0].id, c.fields[0].level, c.fields[0].name, c.fields[0].type, c.fields[0].coords, c.fields[0].x],
    [F(575, 650), 7, 'Forest', 1, '575,650', 575]);
  assert.deepStrictEqual([c.tradesArray.length, c.tradesArray[0].id, c.tradesArray[0].tradeTypeName], [1, 501, 'Sell']);
  assert.strictEqual(c.transingTradesArray[0].resourceName, 'Lumber');
  // made once per list the server sent (a loop reading [j] was quadratic), each
  // read its own array, and a push — a new list — is seen at once
  const a = c.transingTradesArray, b = c.transingTradesArray;
  assert.ok(a !== b && a[0] === b[0], 'the beans are reused, the array is not');
  a.pop();
  assert.strictEqual(c.transingTradesArray.length, 1, 'one read popping its array leaves the next read whole');
  const raw = w.g.castle('9');
  raw.transingTrades = [...raw.transingTrades, { ...raw.transingTrades[0], id: 777 }];
  assert.deepStrictEqual(c.transingTradesArray.map((t) => t.id).slice(-1), [777]);
  const k = c.castle;
  assert.deepStrictEqual([k.name, k.allowAlliance, k.hasEnemy, k.goOutForBattle, k.logUrl], ['9', true, true, false, 'images/castle.png']);
  assert.deepStrictEqual([k.herosArray.length, k.buildingsArray.length, k.fieldsArray.length, k.resource.herosSalary, k.troop.archer],
    [5, 11, 2, 1500, 120000]);
});
t('buffs: expired ones are gone, a cooldown is not the buff itself', () => {
  const { G } = context(world());
  const c = G.city;
  assert.deepStrictEqual(c.buffs.map((b) => b.typeId), ['ForceopenclosegateBuff', 'ForceopenclosegateCooldownBuff']);
  assert.strictEqual(c.hasBuff('ForceopenclosegateBuff'), true);
  assert.strictEqual(c.hasBuff('forceopenclosegatebuff'), true, 'any case');
  assert.strictEqual(c.hasBuff('OldCastleBuff'), false, 'ended');
  assert.strictEqual(c.buff('ForceopenclosegateBuff').descName, 'Gates forced open');
  assert.strictEqual(c.buff('Nope'), null);
  assert.strictEqual(c.brokenGates, true);
  assert.strictEqual(c.hasBuff.rawArgs, true, 'hasBuff(ForceopenclosegateBuff) without quotes');
  const w = world();
  w.g.castles[0].buffs = [{ typeId: 'ForceopenclosegateCooldownBuff', endTime: NOW + 60000 }];
  assert.strictEqual(context(w).G.city.brokenGates, false);
});
t('comforting: PRFactor and the client cost formula', () => {
  const { G } = context(world());
  assert.strictEqual(G.city.PRFactor, 2);
  assert.deepStrictEqual(G.city.comfortingNeeds(1), { typeId: 1, needAmount: 40000, food: 40000, gold: 0 });
  assert.strictEqual(G.city.comfortingNeeds(2).needAmount, 40000);
  assert.deepStrictEqual([G.city.comfortingNeeds(3).food, G.city.comfortingNeeds(3).gold], [20000, 2000]);
  assert.strictEqual(G.city.comfortingNeeds(4).needAmount, 100000);
  assert.strictEqual(G.city.comfortingNeeds(9), null);
});
t('incomingResources: trades, transports, allies and loot, within a time', () => {
  const { G } = context(world());
  const all = G.city.incomingResources();
  assert.deepStrictEqual({ ...all }, { gold: 0, food: 30000, wood: 50000 + 20000, stone: 7000, iron: 0, total: 107000 });
  const soon = G.city.incomingResources(90);
  assert.deepStrictEqual([soon.food, soon.wood, soon.stone, soon.total], [30000, 50000, 0, 80000]);
  assert.strictEqual(String(soon), 'f:30000,w:50000');
});
t('rallySpotAvailable counts the marches out against the rally spot', () => {
  const { G } = context(world());
  assert.strictEqual(G.city.rallySpotAvailable(), true, 'L3, two out');
  assert.strictEqual(G.city.rallySpotAvailable(true), false, 'the last slot kept for the training hero');
  assert.strictEqual(G.city.rallySpotAvailable(false, 1), false);
  assert.strictEqual(G.cities[1].rallySpotAvailable(), false, 'no rally spot');
});
t('compareByDistanceToCastle is a plain comparator for .sort()', () => {
  const { G } = context(world());
  const far = F(700, 700), near = F(572, 649), mid = F(600, 600);
  assert.deepStrictEqual([far, mid, near].sort(G.city.compareByDistanceToCastle), [near, mid, far]);
  assert.deepStrictEqual(['700,700', '572,649'].sort(G.city.compareByDistanceToCastle), ['572,649', '700,700']);
  assert.ok(G.city.compareByDistanceToCastle(near, far) < 0);
  const cmp = G.city.compareByDistanceToCastle;
  assert.strictEqual(cmp(near, near), 0, 'works unbound');
});
t('goals and console controls: getConfig, GateControl, goal errors, training hero', () => {
  const w = world();
  const s = fakeSession(w, { 9: GOALS });
  const { G } = context(w, { session: s });
  assert.deepStrictEqual([G.city.getConfig('hero'), G.city.getConfig('HERO'), G.city.getConfig('npc')], [10, 10, 0]);
  assert.strictEqual(G.city.getConfig('wartown'), 1);
  s.setControls(1, { wartown: 2, gate: 'closed' });
  assert.strictEqual(G.city.getConfig('wartown'), 2, 'the console War Town control wins, as in the engine');
  assert.strictEqual(G.city.GateControl, 2);
  s.setControls(1, { gate: 'open' });
  assert.strictEqual(G.city.GateControl, 1);
  assert.strictEqual(G.cities[1].GateControl, 0, 'auto');
  assert.deepStrictEqual([G.city.cityHasGoalErrors, G.cities[1].CityHasGoalErrors], [false, true], 'Fla has no goals');
  assert.deepStrictEqual([G.city.trainingHeroName, G.city.TrainingHeroIsHere], ['QUEEN', true], 'the mayor is in town');
  w.g.castles[0].heros[1].status = 3;
  assert.strictEqual(G.city.TrainingHeroIsHere, false, 'out marching');
  assert.strictEqual(G.cities[1].trainingHeroName, '');
});
t('city.goals prints the lines the engine runs; the prepend counts everywhere (Lord30, 2026-09-29)', () => {
  // An account whose goals are all prepend: `echo city.goals` said undefined,
  // and getConfig / trainingHeroName saw none of the prepend's lines.
  const w = world();
  const s = fakeSession(w);
  const texts = {
    prepend: '// the fleet prepend\nconfig hero:1\ntraininghero OTTO 30 60\ntroop b:5k,t:5k\ndefensepolicy /junktroop:5000\nbogus line',
    city: { 1: 'defensepolicy /junktroop:100\ntroop a:1k' },
  };
  s.org.goals.layers = (acct, cid) => ({ prepend: texts.prepend, city: texts.city[cid] || null, append: null });
  const { G } = context(w, { session: s });
  assert.strictEqual(G.cities[1].trainingHeroName, 'OTTO', 'a prepend-only city has the prepend traininghero');
  assert.strictEqual(G.cities[1].getConfig('hero'), 1);
  assert.strictEqual(G.cities[1].cityHasGoalErrors, false, 'the prepend is goals');
  assert.strictEqual(G.cities[1].goals, [
    'Fla runs 3 goal(s) (lines: prepend 5)',
    'config hero:1',
    'prepend 3: traininghero OTTO 30 60',
    'prepend 4: troop b:5k,t:5k',
    'prepend 5: defensepolicy /junktroop:5000',
    'skipped prepend line 6: unknown goal "bogus"',
  ].join('\n'));
  // the city's own lines come first, and its defensepolicy beats the prepend's
  assert.strictEqual(G.city.goals, [
    '9 runs 4 goal(s) (lines: city 2, prepend 5)',
    'config hero:1',
    'city 1: defensepolicy /junktroop:100',
    'city 2: troop a:1k',
    'prepend 3: traininghero OTTO 30 60',
    'prepend 4: troop b:5k,t:5k',
    'skipped prepend line 6: unknown goal "bogus"',
  ].join('\n'));
  texts.prepend = '';
  assert.strictEqual(G.cities[1].goals, 'Fla has no goals — the engine leaves it alone');
  assert.strictEqual(G.cities[1].cityHasGoalErrors, true);
  // a store with only own() (no layers) still reads the city's own text
  const w2 = world();
  const { G: G2 } = context(w2, { session: fakeSession(w2, { 9: 'troop a:5' }) });
  assert.strictEqual(G2.city.goals, '9 runs 1 goal(s)\ncity 1: troop a:5');
  assert.strictEqual(context(world()).G.city.goals, null, 'no goal store, no goals to show');
});
t('checkFeastingHallSpace keeps a slot for a training hero who is elsewhere', () => {
  const w = world();
  assert.strictEqual(context(w, { session: fakeSession(w, { 9: GOALS }) }).G.city.checkFeastingHallSpace, true, 'hall L6, five heroes, QUEEN is here');
  const w2 = world();
  assert.strictEqual(context(w2, { session: fakeSession(w2, { 9: 'traininghero Nomad 3600' }) }).G.city.checkFeastingHallSpace, false);
  assert.strictEqual(context(world()).G.cities[1].checkFeastingHallSpace, false, 'no hall');
});

// ---------------------------------------------------------------------------
section('heroes');

t('HeroBean fields and NEAT helpers', () => {
  const { G } = context(world());
  const [treb, queen, rider, pris] = G.city.heroes;
  assert.strictEqual(G.city.heroes.length, 5);
  assert.deepStrictEqual([treb.name, treb.level, treb.status, treb.power, treb.loyalty], ['Trebber', 200, 0, 250, 100]);
  assert.deepStrictEqual([treb.isAttackHero, queen.isPoliticsHero, G.city.heroes[4].isIntelHero], [true, true, false]);
  assert.deepStrictEqual([treb.isIdle, queen.isMayor, rider.isMarching, pris.isCaptured], [true, true, true, true]);
  assert.deepStrictEqual([treb.isAvailable, queen.isAvailable, rider.isAvailable, pris.isAvailable], [true, true, false, false]);
  assert.deepStrictEqual([treb.isLoyal, queen.isLoyal], [true, false]);
  assert.strictEqual(treb.powerWithBuffAdded, 313, '250 + 25%');
  assert.strictEqual(queen.managementWithBuffAdded, 254);
  assert.strictEqual(treb.base, Game.heroBase(G.city.castle.herosArray[0]));
  assert.strictEqual(G.city.heroes[4].base, 150 - 50 + 3);
  assert.strictEqual(queen.expLevels, 1, 'wiki ListAllHeroes: L193 4,737,560/3,724,900');
  assert.strictEqual(treb.buffsArray[0].descName, 'Excalibur');
  assert.strictEqual(String(treb), 'Trebber');
});
t('isBusy: a hero this run has just sent', () => {
  const w = world();
  const { G } = context(w);
  w.busy.add(11);
  assert.deepStrictEqual([G.city.heroes[0].isBusy, G.city.heroes[0].isAvailable], [true, false]);
  assert.strictEqual(G.AnyIdleHero('Trebber'), false);
  assert.strictEqual(G.IsHeroInCastle('Trebber'), true, 'still at home');
});
t('getMayor, findHeroByName and heros(name)', () => {
  const w = world();
  const { G } = context(w);
  assert.strictEqual(G.city.getMayor().name, 'QUEEN');
  assert.strictEqual(G.city.findHeroByName('trebber').level, 200);
  assert.strictEqual(G.m_city.cityManager.heros('QUEEN').stratagem, 21);
  assert.strictEqual(G.city.findHeroByName('nobody'), null);
  assert.strictEqual(G.city.findHeroByName.rawArgs, true);
  w.g.castles[0].heros[1].status = 0;
  assert.strictEqual(G.city.getMayor(), null);
});
t('IsHeroInCastle takes a name or a hero string; home means idle or mayor', () => {
  const { G } = context(world());
  const yes = ['Trebber', 'QUEEN', 'queen', 'any:att>200', 'Rider,Trebber', 'any:level>=190', 'T*', 'any:pol>200|nobody'];
  const no = ['Rider', 'Prisoner', 'Nobody', 'any:att>300', '!Trebber,any:att>200', 'any:att=best'];
  for (const s of yes) assert.strictEqual(G.m_city.IsHeroInCastle(s), true, s);
  for (const s of no) assert.strictEqual(G.m_city.IsHeroInCastle(s), false, s);
  assert.strictEqual(G.IsHeroInCastle('any:att>200'), true, 'the global reads the current city');
  assert.strictEqual(G.IsHeroInCastle.rawArgs, true, 'IsHeroInCastle(any:att>200) without quotes');
});
t('AnyIdleHero: idle heroes only', () => {
  const { G } = context(world());
  assert.strictEqual(G.m_city.AnyIdleHero('any:att>100,att<300'), true);
  assert.strictEqual(G.m_city.AnyIdleHero('QUEEN'), false, 'the mayor is not idle');
  assert.strictEqual(G.m_city.AnyIdleHero('any:pol>200'), false);
  assert.strictEqual(G.AnyIdleHero('any:attack>1000'), false);
  assert.strictEqual(G.cities[1].AnyIdleHero('any'), false, 'no heroes');
});
t('a broken hero string is an error, not a quiet false', () => {
  const { G } = context(world());
  assert.throws(() => G.IsHeroInCastle('any:speed>5'), /bad hero string "any:speed>5": unknown hero field/);
  assert.throws(() => G.AnyIdleHero(''), /bad hero string/);
});
t('HeroLevel and HeroExperience', () => {
  const { G } = context(world());
  assert.strictEqual(G.HeroLevel(193, 4737560), 194);
  assert.strictEqual(G.HeroLevel(193, 100), 193);
  assert.strictEqual(G.HeroExperience(195, 193, 4737560), 193 * 193 * 100 + 194 * 194 * 100 - 4737560);
  assert.strictEqual(G.HeroExperience(3), 100 + 400);
  assert.strictEqual(G.HeroExperience(2, 1, 1e9), 0);
});

// ---------------------------------------------------------------------------
section('armies (through session.js pushes)');

const ENEMIES = [
  { armyId: 70, missionType: 5, direction: 1, startFieldId: F(10, 20), targetFieldId: F(571, 648), startPosName: 'Hostile', targetPosName: '9',
    king: 'Bad', alliance: 'Foes', hero: 'Brute', heroLevel: 150,
    troop: { archer: '3000', ballista: '0' }, resource: {}, startTime: NOW - 1000, reachTime: NOW + 300000 },
  { armyId: 71, missionType: 3, direction: 1, targetFieldId: F(571, 648), troop: { scouter: '1' }, reachTime: NOW + 30000 },
  { armyId: 72, missionType: 5, direction: 1, targetFieldId: F(484, 619), troop: { archer: '99999' }, reachTime: NOW + 30000 },
  { armyId: 73, missionType: 5, direction: 1, targetFieldId: F(571, 648), troop: { archer: '?', militia: '?' }, reachTime: 0 },
  { armyId: 74, missionType: 5, direction: 1, targetFieldId: F(571, 648), troop: { militia: '10' }, reachTime: NOW + 900000 },
];

t('enemyArmies are the ones aimed at this city, straight from the push', () => {
  const w = world();
  const s = fakeSession(w);
  const { G } = context(w, { session: s });
  assert.deepStrictEqual([G.city.enemyArmies.length, G.city.hasEnemyArmies], [0, false]);
  push(w, 'server.EnemyArmysUpdate', { armys: ENEMIES });
  const e = G.city.enemyArmies;
  assert.deepStrictEqual(e.map((a) => a.armyId), [70, 71, 73, 74]);
  assert.strictEqual(G.cities[1].enemyArmies.length, 1);
  assert.deepStrictEqual([e[0].king, e[0].alliance, e[0].hero, e[0].heroLevel, e[0].missionType, e[0].direction], ['Bad', 'Foes', 'Brute', 150, 5, 1]);
  assert.deepStrictEqual([e[0].startCoords, e[0].targetCoords, e[0].targetFieldCoords], ['10,20', '571,648', '571,648']);
  assert.strictEqual(e[0].troop.archer, 3000, 'counts arrive as strings and read as numbers');
  assert.strictEqual(e[2].troop.archer, '?', 'unscouted stays unknown');
  assert.strictEqual(String(e[0].troop), 'a:3000');
  assert.strictEqual(String(e[0].resource), 'f:0');
  assert.strictEqual(String(e[0]), 'attack Hostile -> 9: a:3000');
  assert.strictEqual(G.city.hasEnemyArmies, true);
  push(w, 'server.EnemyArmysUpdate', { armys: [] });
  assert.strictEqual(G.city.hasEnemyArmies, false, 'the next push replaces the list');
});
t('hasEnemyArmiesWithin, and the beacon-blind flag', () => {
  const w = world();
  const s = fakeSession(w);
  const { G } = context(w, { session: s });
  push(w, 'server.EnemyArmysUpdate', { armys: ENEMIES });
  assert.deepStrictEqual([G.city.hasEnemyArmiesWithin(600), G.city.hasEnemyArmiesWithin(20)], [true, false]);
  assert.strictEqual(G.city.hasEnemyArmiesWithin(60), true, 'the scout lands in 30 s');
  push(w, 'server.EnemyArmysUpdate', { armys: [ENEMIES[3]] });
  assert.deepStrictEqual([G.city.hasEnemyArmiesWithin(60), G.city.hasEnemyArmiesWithin(60, true)], [false, true]);
});
t('NumberOfRealAttacks: attacks at or over /junktroop, unscouted ones included', () => {
  const w = world();
  const { G } = context(w, { session: fakeSession(w) });
  push(w, 'server.EnemyArmysUpdate', { armys: ENEMIES });
  assert.strictEqual(G.city.NumberOfRealAttacks, 2, '3000 archers and the unscouted one; not the scout, not 10 warriors');
  const w2 = world();
  const { G: G2 } = context(w2, { session: fakeSession(w2, { 9: GOALS }) });
  push(w2, 'server.EnemyArmysUpdate', { armys: ENEMIES });
  assert.strictEqual(G2.city.NumberOfRealAttacks, 1, 'defensepolicy /junktroop:5000');
});
t('friendlyArmies and selfArmies (= myArmies)', () => {
  const w = world();
  const { G } = context(w, { session: fakeSession(w) });
  assert.deepStrictEqual(G.city.friendlyArmies.map((a) => [a.king, a.resource.stone, a.troop.carriage]), [['Pal', 7000, 5]]);
  assert.deepStrictEqual(G.city.selfArmies.map((a) => a.armyId), [1, 2]);
  assert.deepStrictEqual(G.city.myArmies.map((a) => a.armyId), [1, 2]);
  assert.strictEqual(G.city.myArmies[1].resource.food, 30000);
  assert.strictEqual(String(G.city.myArmies[1].resource), 'f:30000', 'echo city.myArmies[0].resource prints the load');
  assert.deepStrictEqual(G.cities[1].selfArmies.map((a) => a.armyId), [3]);
  push(w, 'server.SelfArmysUpdate', { armys: [] });
  assert.strictEqual(G.city.selfArmies.length, 0);
});

// ---------------------------------------------------------------------------
section('fresh on every read');

t('pushed troops and resources show on the next read, through a held city', () => {
  const w = world();
  const { G } = context(w, { session: fakeSession(w) });
  const cm = G.cities[0].cityManager;
  push(w, 'server.TroopUpdate', { caslteId: 1, troop: { ...C.EMPTY_TROOPS, archer: 7 } });
  assert.strictEqual(cm.troop.archer, 7);
  push(w, 'server.ResourceUpdate', { castleId: 1, resource: { ...w.g.castles[0].resource, gold: 42 } });
  assert.strictEqual(cm.resource.gold, 42);
  w.g.castles[0].heros.push({ id: 16, name: 'New', status: 0, level: 1 });
  assert.strictEqual(cm.heroes.length, 6);
});
t('a reconnect swaps the Game and the views follow it', () => {
  const w = world();
  const { G } = context(w);
  const held = G.city;
  const old = w.g;
  const g2 = new Game();
  g2.now = () => NOW;
  g2.player = old.player;
  g2.castles = [{ ...old.castles[0], name: 'Renamed' }, old.castles[1]];
  w.g = g2;
  assert.strictEqual(held.name, 'Renamed');
  assert.strictEqual(G.cities.length, 2);
});
t('a city lost reads as nothing, not a crash', () => {
  const w = world();
  const { G } = context(w, { session: fakeSession(w) });
  const fla = G.cities[1];
  push(w, 'server.CastleUpdate', { updateType: 1, castleBean: { id: 2 } });
  assert.strictEqual(G.cities.length, 1);
  assert.deepStrictEqual([fla.name, fla.heroes.length, fla.getBuildingLevel(31), fla.hasEnemyArmies], [undefined, 0, 0, false]);
});
t('every global read builds a fresh object', () => {
  const { G } = context(world());
  assert.notStrictEqual(G.city, G.city);
  assert.notStrictEqual(G.cities, G.cities);
  assert.notStrictEqual(G.city.troop, G.city.troop);
  assert.notStrictEqual(G.player, G.player);
  const d = Object.getOwnPropertyDescriptor(G, 'city');
  assert.ok(typeof d.get === 'function' && d.enumerable, 'city is a getter');
});

// ---------------------------------------------------------------------------
section('copies never reach the game');

t('changing what a script got changes only its copy', () => {
  const w = world();
  const { G } = context(w, { session: fakeSession(w) });
  const before = JSON.stringify({ c: w.g.castles, p: w.g.player });
  const c = G.city;
  c.troop.archer = 1;
  c.troops.scouter = 1;
  c.heroes[0].name = 'Hacked';
  c.heroes.pop();
  c.resource.food.amount = 0;
  c.resource.gold = 0;
  c.buildings[0].level = 99;
  c.fields.pop();
  c.castle.herosArray.pop();
  c.castle.troop.archer = 0;
  c.fortification.trap = 0;
  c.tradesArray[0].price = 999;
  c.myArmies[0].troop.archer = 0;
  c.getAvailableTroop().add('a:1000000');
  G.cities.pop();
  G.player.playerInfo.userName = 'x';
  G.player.castleSignBeanArray.pop();
  G.m_context.Player.itemsArray[0].count = 0;
  assert.strictEqual(JSON.stringify({ c: w.g.castles, p: w.g.player }), before);
  assert.strictEqual(G.cities.length, 2);
  assert.strictEqual(G.city.troop.archer, 120000);
});
t('the views themselves are frozen', () => {
  const { G } = context(world());
  const c = G.city;
  assert.ok(Object.isFrozen(c) && Object.isFrozen(G.m_context) && Object.isFrozen(G.Screen));
  assert.throws(() => { c.name = 'x'; }, TypeError);
  assert.throws(() => { c.extra = 1; }, TypeError);
  assert.throws(() => { G.m_context.truced = false; }, TypeError);
  assert.strictEqual(G.city.name, '9');
});

// ---------------------------------------------------------------------------
section('m_context, player, items');

t('player is the PlayerBean, without the login e-mail', () => {
  const { G } = context(world());
  const p = G.player;
  assert.deepStrictEqual([p.playerInfo.userName, p.playerInfo.titleId, p.playerInfo.castleCount, p.currentTime], ['Lord02', 3, 2, NOW - 3600000]);
  assert.strictEqual(p.currentDateTime, '2026.09.14 11.30.15');
  assert.strictEqual(p.playerInfo.accountName, undefined);
  assert.deepStrictEqual(p.castleSignBeanArray, [{ id: 1, name: 'home', x: 1, y: 2 }]);
  assert.deepStrictEqual([p.friendBeansArray, p.blockBeansArray], [[{ userName: 'Pal', prestige: 5 }], [{ userName: 'Troll' }]],
    "friends and blocked players, without anyone's login e-mail");
  assert.strictEqual(G.m_context.Player.playerInfo.sex, 0);
  assert.deepStrictEqual([p.selfArmysArray.length, p.buffsArray.length], [3, 1]);
});
t('only the client bean fields reach a script: anything else the server sends stays out', () => {
  const w = world();
  const SECRET = 'hunter2-secret';
  Object.assign(w.g.player, { isSetSecurityCode: true, sessionKey: SECRET, furlough: false });
  Object.assign(w.g.player.playerInfo, { password: SECRET, securityCode: SECRET });
  w.g.player.friendBeans[0].password = SECRET;
  w.g.player.castleSignBean[0].token = SECRET;
  w.g.player.items[0].owner = SECRET;
  w.g.player.selfArmys[0].secret = SECRET;
  w.g.player.buffs[0].secret = SECRET;
  const c = w.g.castles[0];
  Object.assign(c, { secret: SECRET });
  c.resource.secret = SECRET;
  c.resource.food.secret = SECRET;
  c.heros[0].secret = SECRET;
  c.buildings[0].secret = SECRET;
  c.fields[0].secret = SECRET;
  c.trades[0].secret = SECRET;
  c.transingTrades[0].secret = SECRET;
  c.buildingQueues = [{ id: 1, typeId: 1, level: 1, positionId: 9, secret: SECRET }];
  const { G } = context(w);
  const seen = JSON.stringify([G.player, G.m_context.Player, G.city.castle, G.city.heroes, G.city.enemyArmies, G.city.myArmies,
    G.city.fields, G.city.buildings, G.city.buffs, G.city.tradesArray, G.city.transingTradesArray, G.city.resource,
    G.GetItem('player.box.gambling.3'), G.m_context.buffs]);
  assert.ok(!seen.includes(SECRET), 'a field no client bean has leaked');
  assert.ok(!seen.includes('secret@example.com') && !seen.includes('pal@example.com'), 'an accountName leaked');
  assert.ok(!seen.includes('isSetSecurityCode'));
  assert.strictEqual(G.player.furlough, false, 'the allowed fields still come through');
  assert.strictEqual(G.city.castle.buildingQueuesArray[0].positionId, 9);
});
t('truced, inTruceCooldown, hasBuff and buff', () => {
  const w = world();
  const { G } = context(w);
  assert.deepStrictEqual([G.m_context.truced, G.m_context.inTruceCooldown], [true, false]);
  assert.strictEqual(G.m_context.hasBuff('PlayerPeaceBuff'), true);
  assert.strictEqual(G.m_context.buff('PlayerPeaceBuff').descName, 'Truce');
  assert.strictEqual(G.m_context.buff('OldPlayerBuff'), null, 'ended');
  w.g.player.buffs = [{ typeId: 'PlayerPeaceCoolDownBuff', endTime: NOW + 60000 }];
  assert.deepStrictEqual([G.m_context.truced, G.m_context.inTruceCooldown], [false, true]);
  w.g.player.buffs = [{ typeId: 'PlayerPeaceUniteServerBuff', endTime: NOW + 60000 }];
  assert.strictEqual(G.m_context.truced, true, 'a server-merge truce counts');
});
t('ItemCount and GetItem, by id (and by name when the catalogue is there)', () => {
  const { G } = context(world());
  assert.deepStrictEqual([G.ItemCount('player.box.gambling.3'), G.m_context.ItemCount('player.peace.1'), G.ItemCount('player.none.1')], [7, 1, 0]);
  assert.strictEqual(G.GetItem('player.box.gambling.3').count, 7);
  assert.strictEqual(G.GetItem('no.such.item'), null);
  if (require('./items').catalogue().has('player.peace.1')) {
    assert.strictEqual(G.ItemCount('Truce Agreement'), 1);
    assert.strictEqual(G.GetItem('hero.reset.1').count, 0, 'known but not held');
    assert.strictEqual(G.GetItem('player.peace.1').name, 'Truce Agreement');
  }
});
t('the server clock in the server timezone, and maintenanceStart', () => {
  const w = world();
  const s = fakeSession(w);
  const { G } = context(w, { session: s });
  const m = G.m_context;
  assert.deepStrictEqual([m.serverHours, m.serverMinutes, m.serverSeconds, m.serverYear, m.serverMonth, m.serverDate], [12, 30, 15, 2026, 8, 14]);
  assert.strictEqual(m.maintenanceStart, 0);
  const startsAt = Date.now() + 10 * 60000;
  s.maint.plan = { source: 'announcement', startsAt, resumeAt: startsAt + 15 * 60000 };
  assert.strictEqual(G.m_context.maintenanceStart, startsAt);
  s.maint.plan = { source: 'logout', startsAt, resumeAt: startsAt + 60000 };
  assert.strictEqual(G.m_context.maintenanceStart, 0, "a script's logout is not maintenance");
});
t('findFirstCity', () => {
  const { G } = context(world());
  assert.strictEqual(G.m_context.findFirstCity().name, '9');
});

// script-cmd-market.js owns prices, marketReady and the TradeBean names. It is
// swapped for a stand-in here, so these tests say what the WIRING does.
const Module = require('module');
async function withMarket(exportsObj, fn) {
  const file = require.resolve('./script-cmd-market');
  const prev = require.cache[file];
  const m = new Module(file, module);
  Object.assign(m, { filename: file, loaded: true, exports: exportsObj });
  require.cache[file] = m;
  try { return await fn(); } finally { if (prev) require.cache[file] = prev; else delete require.cache[file]; }
}
t('m_context and city prices and marketReady come from the market module', () => withMarket({
  market: (ctx) => {
    const buy = Object.assign((res, amount) => `bid ${res} ${amount === undefined ? '' : amount}`.trim(), { rawArgs: true });
    return { buyPrice: buy, sellPrice: Object.assign((res) => `ask ${res}`, { rawArgs: true }), marketReady: () => !!ctx.game };
  },
  tradeBean: (t) => ({ id: t.id, tradeTypeName: 'Offer', resourceName: 'Food' }),
  transingTradeBean: (t) => ({ id: t.id, resourceName: 'Lumber!' }),
}, () => {
  const { G } = context(world());
  assert.strictEqual(G.m_context.buyPrice(0), 'bid 0');
  const ask = G.m_context.buyPrice;
  assert.strictEqual(ask(1, 5), 'bid 1 5', 'a function value, as NEAT scripts pass it around');
  assert.strictEqual(G.m_context.sellPrice.rawArgs, true, 'sellPrice(food) without quotes');
  assert.strictEqual(G.city.buyPrice(2), 'bid 2');
  assert.strictEqual(G.m_city.cityManager.sellPrice('food'), 'ask food');
  assert.strictEqual(G.m_context.marketReady(), true);
  assert.deepStrictEqual(G.city.tradesArray, [{ id: 501, tradeTypeName: 'Offer', resourceName: 'Food' }]);
  assert.strictEqual(G.city.castle.transingTradesArray[0].resourceName, 'Lumber!');
}));
t('without the market module: NaN prices, never ready, plain trade copies', () => withMarket({}, () => {
  const { G } = context(world());
  assert.ok(Number.isNaN(G.m_context.buyPrice(0)) && Number.isNaN(G.city.sellPrice(3)));
  assert.strictEqual(G.m_context.marketReady(), false);
  assert.strictEqual(G.city.tradesArray[0].tradeTypeName, 'Sell');
  assert.strictEqual(G.city.transingTradesArray[0].total, 25000);
}));

// ---------------------------------------------------------------------------
section('Screen and Config');

t('the log and chat rings read as text, and addEvent writes locally only', () => {
  const w = world();
  const s = fakeSession(w);
  const { G } = context(w, { session: s });
  s.note('trained 5 archers', { city: '9', kind: 'act' });
  s.note('bought food', { city: 'Fla', kind: 'act' });
  push(w, 'server.ChannelChatMsg', { channel: 'alliance_chat', fromUser: 'Pal', msg: '<b>hi</b> all' });
  assert.match(G.Screen.mainLog.buffer, /^\d\d:\d\d:\d\d \(9\) trained 5 archers\n\d\d:\d\d:\d\d \(Fla\) bought food$/);
  assert.match(G.Screen.cityLog.buffer, /trained 5 archers/);
  assert.doesNotMatch(G.Screen.cityLog.buffer, /bought food/);
  assert.match(G.Screen.aChat.buffer, /Pal: hi all$/);
  assert.strictEqual(G.Screen.wChat.buffer, '');
  const sent = [];
  w.g.c.send = (...a) => sent.push(a);
  G.Screen.mainLog.addEvent('<b>Why hello there.</b>');
  G.Screen.wChat.addEvent('hi world');
  assert.match(G.Screen.mainlog.buffer, /\(9\) Why hello there\.$/);
  assert.match(G.Screen.wChat.buffer, /script: hi world$/);
  assert.strictEqual(sent.length, 0, 'nothing goes to the game');
});
t('without a session, addEvent lands in the run output', () => {
  const { G, out } = context(world());
  G.Screen.mainLog.addEvent('note <i>this</i>');
  assert.deepStrictEqual(out, ['note this']);
  assert.strictEqual(G.Screen.mainLog.buffer, '');
});
t('Config: the server and run parameters, never a password', () => {
  const w = world();
  const { G } = context(w, { session: fakeSession(w), opts: { config: { teleport: 'tuscany', password: 'x', owner: 'Bob' } } });
  assert.deepStrictEqual([G.Config.server, G.Config.teleport, G.Config.owner, G.Config.password], ['ss71', 'tuscany', 'Bob', undefined]);
  assert.strictEqual(context(world()).G.Config.teleport, undefined, 'so `if Config.teleport == null` works');
});

// ---------------------------------------------------------------------------
section('members that read the server (cached, read-only)');

t('researches, getTechLevel, hasTech, getActiveResearch, is_researching: one request', async () => {
  const w = world();
  const { G } = context(w);
  const r = await G.city.researches;
  assert.deepStrictEqual([r.length, r[14].level, r[14].avalevel, r[14].permition, r[0], r[11].upgradeing], [15, 8, 10, true, null, true]);
  assert.strictEqual(r[14].conditionBean, undefined);
  assert.strictEqual(await G.city.getTechLevel(14), 8);
  assert.strictEqual(await G.city.GetTechLevel(12), 0);
  assert.strictEqual(await G.GetTechLevel(14), 8);
  assert.deepStrictEqual([await G.city.hasTech(14, 8), await G.city.hasTech(14, 9)], [true, false]);
  assert.strictEqual((await G.city.getActiveResearch()).typeId, 11);
  assert.deepStrictEqual([await G.city.is_researching, await G.is_researching], [true, true]);
  assert.strictEqual(w.calls.filter((c) => c.cmd === 'tech.getResearchList').length, 1, 'cached');
  assert.deepStrictEqual(w.calls[0].data, { castleId: 1 });
  O.forget(w.g, 'research:');
  await G.city.getTechLevel(14);
  assert.strictEqual(w.calls.filter((c) => c.cmd === 'tech.getResearchList').length, 2, 'forget() drops it');
});
t('troopStillInProduction reads as a property and as a call', async () => {
  const { G } = context(world());
  const q = await G.city.troopStillInProduction;
  assert.deepStrictEqual([q.archer, q.ballista, q.scouter], [6000, 100, 0]);
  assert.strictEqual(q().ballista, 100);
  assert.strictEqual(q.foodConsumeRate, 6000 * 9 + 100 * 50);
  assert.strictEqual(G.TroopBeanToString(q), 'a:6000,b:100');
});
t('innHeroes, ResourceProduction', async () => {
  const { G } = context(world());
  const inn = await G.city.innHeroes;
  assert.deepStrictEqual([inn.length, inn[0].name, inn[0].powerAdded], [1, 'InnGuy', 29]);
  assert.strictEqual((await G.city.innheroes)[0].level, 30);
  const p = await G.city.ResourceProduction;
  assert.deepStrictEqual({ ...p }, { food: 100, wood: 50, stone: 25, iron: 0 });
  const walls = await G.city.fortificationProduceQueue;
  assert.strictEqual(String(walls), 'tra:50,tre:5');
});
t('getCarryingLoad and getTravelTime use the city skills', async () => {
  const w = world();
  const { G } = context(w);
  assert.strictEqual(await G.city.getCarryingLoad(G.GetTroops('t:100k')), 5000 * 100000 * 2, 'Logistics +100%');
  assert.strictEqual(await G.city.getCarryingLoad('a:10'), 25 * 10 * 2);
  const secs = await G.city.getTravelTime(F(571, 648), F(575, 650), G.GetTroops('a:1'), 5);
  const ms = C.marchTimeMs({ x: 571, y: 648 }, { x: 575, y: 650 }, ['archer'],
    { marchSkill: 50, driveSkill: 30, relief: 0, castleBuffs: w.g.castles[0].buffs, playerBuffs: w.g.player.buffs, now: NOW });
  assert.strictEqual(secs, Math.round(ms / 1000));
  assert.strictEqual(await G.city.getTravelTime('571,648', '575,650', 'a:1', 5), secs, 'coords and a troop string do too');
  await assert.rejects(G.city.getTravelTime(1, 2, 'zz:1'), /wants troops/);
  assert.strictEqual(w.calls.filter((c) => c.cmd === 'army.getTroopParam').length, 1, "Game.troopParams' own cache");
});
t('a failed read is an error the script sees', async () => {
  const w = world();
  delete w.replies['tech.getResearchList'];
  const { G } = context(w);
  await assert.rejects(G.city.getTechLevel(14), /no reply to tech.getResearchList/);
});

// ---------------------------------------------------------------------------
section('wiki lines through the expression evaluator (script-expr.js)');

// core's evaluator and Scope, until script.js wires the globals into run().
let X = null;
try { X = require('./script-expr'); if (!X.parseStatement || !X.evaluate || !X.Scope) X = null; } catch { X = null; }
function evaluator(w, session) {
  const { G } = context(w, { session });
  const layers = [X.builtins ? X.builtins() : {}, { GetResources: O.getResources }, G];
  const scope = new X.Scope({ vars: new Map(), layers });
  return async (src) => X.evaluate(X.parseStatement(src), scope);
}
const e2e = (n, f) => t(n, async () => {
  if (!X) { console.log('        (skipped: script-expr.js has no parseStatement/evaluate/Scope yet)'); return; }
  await f();
});

e2e('Army, City, Heroes and HeroFunctions pages', async () => {
  const w = world();
  const s = fakeSession(w, { 9: GOALS });
  push(w, 'server.EnemyArmysUpdate', { armys: ENEMIES });
  const ev = evaluator(w, s);
  assert.strictEqual(await ev('city.enemyArmies[0].king'), 'Bad');
  assert.strictEqual(await ev('city.enemyArmies[0].troop.ballista'), 0);
  assert.strictEqual(await ev('m_city.cityManager.hasEnemyArmiesWithin(600)'), true);
  assert.strictEqual(await ev('"My first wave at " + city.selfArmies[0].startPosName + " has " + city.selfArmies[0].targetPosName + " as its target."'),
    "My first wave at 9 has Barbarian's city as its target.");
  assert.strictEqual(await ev('"Food amount is " + city.selfArmies[1].resource.food'), 'Food amount is 30000');
  assert.strictEqual(await ev('city.castle.allowAlliance'), true);
  assert.strictEqual(await ev('m_city.IsHeroInCastle(any:att>200)'), true, 'unquoted hero string');
  assert.strictEqual(await ev('m_city.AnyIdleHero("any:att>100,att<300") && city.troops.archer > 100k'), true);
  assert.strictEqual(await ev('m_city.cityManager.heros(QUEEN).stratagem'), 21, 'unquoted name');
  assert.strictEqual(await ev('"Hero {city.heroes[1].name} is a politics hero: {city.heroes[1].isPoliticsHero}"'), 'Hero QUEEN is a politics hero: true');
  assert.strictEqual(await ev('m_city.cityManager.hasBuff(ForceopenclosegateBuff )'), true, 'unquoted buff name');
  assert.strictEqual(await ev('m_city.cityManager.TrainingHeroIsHere'), true);
  assert.strictEqual(await ev('city.getMayor().name'), 'QUEEN');
});
e2e('troop strings, beans and the totals script', async () => {
  const w = world();
  const ev = evaluator(w);
  await ev('mytroops = GetTroops("a:30k,b:40k,w:1,p:1,sw:1")');
  assert.strictEqual(await ev('"Food consumption of " + TroopBeanToString(mytroops, ",") + " is " + mytroops.foodConsumeRate + " per hour"'),
    'Food consumption of w:1,p:1,sw:1,a:30000,b:40000 is 2270016 per hour');
  assert.strictEqual(await ev('"" + city.myArmies[1].resource'), 'f:30000', 'a resource bean prints itself');
  await ev('troops = GetTroops("a:0")');
  await ev('res = GetResources("f:0")');
  await ev('upkeep = 0');
  await ev('cities.forEach(CreateFunction("city,ind,arr","troops.add(city.cityManager.getAvailableTroop())||city.cityManager.estResource.addTo(res)||upkeep+=city.cityManager.resource.troopCostFood"))');
  // 9: 120k archers home, 5k + 1k out; 1000 transporters home, 10 out. Fla: 10 archers, 10 transporters out.
  assert.strictEqual(await ev('TroopBeanToString(troops, ",")'), 's:5000,a:126010,t:1020', 'both cities, marches included');
  assert.deepStrictEqual([await ev('res.gold'), await ev('upkeep')], [900005, 20000]);
});
e2e('server reads, sorting, and what a script may not do', async () => {
  const w = world();
  const ev = evaluator(w);
  assert.strictEqual(await ev('"I have archery level {city.getTechLevel(14)}"'), 'I have archery level 8');
  assert.strictEqual(await ev('city.researches[14].level + city.troopStillInProduction.archer'), 8 + 6000);
  assert.strictEqual(await ev('city.troopStillInProduction().ballista'), 100);
  assert.deepStrictEqual(await ev(`[${F(700, 700)}, ${F(572, 649)}].sort(city.compareByDistanceToCastle)`), [F(572, 649), F(700, 700)]);
  assert.strictEqual(await ev('city.selfArmies.toArray().sortOn("reachTime", 18)[0].armyId'), 1, 'AutoTeleporter: latest first');
  assert.strictEqual(await ev('cities[5] == null'), true);
  await assert.rejects(ev('city.name = "x"'));
  await assert.rejects(ev('city.constructor'));
  await ev('city.troop.archer = 1');
  assert.strictEqual(await ev('city.troop.archer'), 120000);
  assert.strictEqual(w.g.castles[0].troop.archer, 120000);
});
// The whole VM, now that script.js loads this module as a global provider.
t('a NEAT script through script.run', async () => {
  let S = null;
  try { S = require('./script'); } catch (e) { console.log('        (skipped: script.js does not load: ' + e.message.split('\n')[0] + ')'); return; }
  const w = world();
  const s = fakeSession(w, { 9: GOALS });
  push(w, 'server.EnemyArmysUpdate', { armys: ENEMIES });
  const src = [
    'if m_city.IsHeroInCastle(any:att>200) echo "Trebber is home"',
    'if city.hasEnemyArmiesWithin(600) echo "incoming from " + city.enemyArmies[0].king',
    'echo "I have archery level {city.getTechLevel(14)}"',
    'echo city.myArmies[1].resource',
    'current = city.fortification.rockfall',
    'echo "We have " + current + " trebs, and need " + (11000 - current) + " more"',
    'if city.NumberOfRealAttacks == 1 echo "one real attack"',
    'city.troop.archer = 1',
    'echo city.goals',
  ].join('\n');
  const acts = S.parse(src);
  assert.deepStrictEqual(acts.filter((a) => a.cmd === 'error').map((a) => a.error), []);
  const out = [];
  await S.run(w.g, acts, (m) => out.push(m), { castle: '9', repeatGapMs: 0, session: s });
  const text = out.join('\n');
  for (const want of [/Trebber is home/, /incoming from Bad/, /I have archery level 8/, /f:30000/, /We have 11 trebs, and need 10989 more/, /one real attack/,
    /9 runs 4 goal\(s\)\n +config hero:10,wartown:1\n +city 2: traininghero QUEEN 3600/]) {
    assert.match(text, want);
  }
  assert.strictEqual(w.g.castles[0].troop.archer, 120000, 'the copy changed, not the city');
});

// ---------------------------------------------------------------------------
section('with nothing loaded');

t('no game: empty, never a crash', () => {
  const { G } = context({ g: null, busy: new Set() });
  assert.deepStrictEqual([G.city, G.cities.length, G.player, G.m_context.truced, G.ItemCount('x')], [null, 0, undefined, false, 0]);
  assert.strictEqual(G.m_context.findFirstCity(), null);
  assert.strictEqual(G.IsHeroInCastle('any'), false);
  assert.strictEqual(G.is_researching, false);
});

// ---------------------------------------------------------------------------
(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n + '\n'); continue; }
    try { await f(); console.log('  ok    ' + n); pass++; }
    catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(path.dirname(process.env.EVONY_DB), { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
