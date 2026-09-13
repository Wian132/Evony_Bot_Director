'use strict';
// All values verified against the decompiled client (EvonyClient1922.swf).

// view/module/trainningField/NewArmyWin.as:1781 -- the mission combo box.
// NOTE: the label 攻击 ("attack") maps to the constant named ARMY_MISSION_OCCUPY.
const MISSION = {
  transport: 1,   // 运输  ARMY_MISSION_TRANS
  reinforce: 2,   // 派遣  ARMY_MISSION_SEND
  scout: 3,       // 侦察  ARMY_MISSION_SCOUT
  construct: 4,   //       ARMY_MISSION_CONSTRUCT
  attack: 5,      // 攻击  ARMY_MISSION_OCCUPY  <- attack really is 5
};

// com/evony/eum/TroopEumDefine + embedded <troopEum> XML.
// `code` matches the NEAT bot's short codes; `key` is the protocol field.
const TROOPS = [
  { code: 'wo',   key: 'peasants',      typeId: 2,  name: 'Worker',        speed: 180,  load: 200,  food: 2 , pop: 1, cost: { food: 50, wood: 150, stone: 0, iron: 10 }, buildTime: 50 },
  { code: 'w',    key: 'militia',       typeId: 3,  name: 'Warrior',       speed: 200,  load: 20,   food: 3 , pop: 1, cost: { food: 80, wood: 100, stone: 0, iron: 50 }, buildTime: 25 },
  { code: 's',    key: 'scouter',       typeId: 4,  name: 'Scout',         speed: 3000, load: 5,    food: 5 , pop: 1, cost: { food: 120, wood: 200, stone: 0, iron: 150 }, buildTime: 100 },
  { code: 'p',    key: 'pikemen',       typeId: 5,  name: 'Pikeman',       speed: 300,  load: 40,   food: 6 , pop: 1, cost: { food: 150, wood: 500, stone: 0, iron: 100 }, buildTime: 150 },
  { code: 'sw',   key: 'swordsmen',     typeId: 6,  name: 'Swordsman',     speed: 275,  load: 30,   food: 7 , pop: 1, cost: { food: 200, wood: 150, stone: 0, iron: 400 }, buildTime: 225 },
  { code: 'a',    key: 'archer',        typeId: 7,  name: 'Archer',        speed: 250,  load: 25,   food: 9 , pop: 2, cost: { food: 300, wood: 350, stone: 0, iron: 300 }, buildTime: 350 },
  { code: 't',    key: 'carriage',      typeId: 8,  name: 'Transporter',   speed: 150,  load: 5000, food: 10 , pop: 4, cost: { food: 600, wood: 1500, stone: 0, iron: 350 }, buildTime: 1000 },
  { code: 'c',    key: 'lightCavalry',  typeId: 9,  name: 'Cavalry',       speed: 1000, load: 100,  food: 18 , pop: 3, cost: { food: 1000, wood: 600, stone: 0, iron: 500 }, buildTime: 500 },
  { code: 'cata', key: 'heavyCavalry',  typeId: 10, name: 'Cataphract',    speed: 750,  load: 80,   food: 35 , pop: 6, cost: { food: 2000, wood: 500, stone: 0, iron: 2500 }, buildTime: 1500 },
  { code: 'b',    key: 'ballista',      typeId: 11, name: 'Ballista',      speed: 100,  load: 35,   food: 50 , pop: 5, cost: { food: 2500, wood: 3000, stone: 0, iron: 1800 }, buildTime: 3000 },
  { code: 'r',    key: 'batteringRam',  typeId: 12, name: 'Battering Ram', speed: 120,  load: 45,   food: 100 , pop: 10, cost: { food: 4000, wood: 6000, stone: 0, iron: 1500 }, buildTime: 4500 },
  { code: 'cp',   key: 'catapult',      typeId: 13, name: 'Catapult',      speed: 80,   load: 75,   food: 250 , pop: 8, cost: { food: 5000, wood: 5000, stone: 8000, iron: 1200 }, buildTime: 6000 },
];

const BY_CODE = Object.fromEntries(TROOPS.map((t) => [t.code, t]));
const BY_KEY = Object.fromEntries(TROOPS.map((t) => [t.key, t]));
const EMPTY_TROOPS = Object.fromEntries(TROOPS.map((t) => [t.key, 0]));

// Embedded <buildingEum> XML. `outside` = resource field (positions 1001-1040),
// everything else occupies an in-city slot (positions 1-30).
const BUILDINGS = [
  { typeId: 1,  name: 'Cottage' },        { typeId: 2,  name: 'Barracks' },
  { typeId: 3,  name: 'Warehouse' },      { typeId: 4,  name: 'Sawmill', outside: true },
  { typeId: 5,  name: 'Quarry', outside: true },   { typeId: 6,  name: 'Ironmine', outside: true },
  { typeId: 7,  name: 'Farm', outside: true },     { typeId: 20, name: 'Stable' },
  { typeId: 21, name: 'Inn' },            { typeId: 22, name: 'Forge' },
  { typeId: 23, name: 'Marketplace' },    { typeId: 24, name: 'Relief Station' },
  { typeId: 25, name: 'Academy' },        { typeId: 26, name: 'Workshop' },
  { typeId: 27, name: 'Feasting Hall' },  { typeId: 28, name: 'Embassy' },
  { typeId: 29, name: 'Rally Spot' },     { typeId: 30, name: 'Beacon Tower' },
  { typeId: 31, name: 'Town Hall' },      { typeId: 32, name: 'Walls' },
];
// In-game ordering for display panels (barracks order for troops).
const TROOP_DISPLAY_ORDER = [
  'peasants', 'militia', 'scouter', 'pikemen', 'swordsmen', 'archer',
  'lightCavalry', 'heavyCavalry', 'carriage', 'ballista', 'batteringRam', 'catapult',
];

const BUILDING_DISPLAY_ORDER = [
  'Town Hall', 'Walls', 'Cottage', 'Barracks', 'Warehouse', 'Marketplace', 'Inn',
  'Feasting Hall', 'Embassy', 'Rally Spot', 'Beacon Tower', 'Forge', 'Stable',
  'Workshop', 'Academy', 'Relief Station',
  'Farm', 'Sawmill', 'Quarry', 'Ironmine',
];

const slug = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
const BUILDING_BY_CODE = Object.fromEntries(BUILDINGS.map((b) => [slug(b.name), b]));
const BUILDING_BY_ID = Object.fromEntries(BUILDINGS.map((b) => [b.typeId, b]));

// Embedded <techEum> XML -- tech.research takes these ids.
const TECHS = [
  { typeId: 1,  name: 'Agriculture' },     { typeId: 2,  name: 'Lumbering' },
  { typeId: 3,  name: 'Masonry' },         { typeId: 4,  name: 'Mining' },
  { typeId: 5,  name: 'Metal Casting' },   { typeId: 7,  name: 'Informatics' },
  { typeId: 8,  name: 'Military Science' },{ typeId: 9,  name: 'Military Tradition' },
  { typeId: 10, name: 'Iron Working' },    { typeId: 11, name: 'Logistics' },
  { typeId: 12, name: 'Compass' },         { typeId: 13, name: 'Horseback Riding' },
  { typeId: 14, name: 'Archery' },         { typeId: 15, name: 'Stockpile' },
  { typeId: 16, name: 'Medicine' },        { typeId: 17, name: 'Construction' },
  { typeId: 18, name: 'Engineering' },     { typeId: 19, name: 'Machinery' },
  { typeId: 20, name: 'Privateering' },
];
const TECH_BY_CODE = Object.fromEntries(TECHS.map((t) => [slug(t.name), t]));
const TECH_BY_ID = Object.fromEntries(TECHS.map((t) => [t.typeId, t]));

const SLOTS = { insideFrom: 1, insideTo: 30, outsideFrom: 1001, outsideTo: 1040 };

// TFConstants.as -- fortification ("wall") types for fortifications.produceWallProtect
// `beanKey` is how the castle's fortification object names it:
//   {"trap":1,"rollingLogs":0,"rockfall":0,"arrowTower":0,"abatis":1418}
const WALLS = [
  { code: 'trap',   typeId: 14, name: 'Trap',         beanKey: 'trap' },
  { code: 'abatis', typeId: 15, name: 'Abatis',       beanKey: 'abatis' },
  { code: 'tower',  typeId: 16, name: 'Arrow Tower',  beanKey: 'arrowTower' },
  { code: 'logs',   typeId: 17, name: 'Rolling Logs', beanKey: 'rollingLogs' },
  { code: 'rocks',  typeId: 18, name: 'Rock Fall',    beanKey: 'rockfall' },
];
const WALL_BY_CODE = Object.fromEntries(WALLS.flatMap((w) => [[w.code, w], [w.name.toLowerCase().replace(/ /g, ''), w]]));

// interior.pacifyPeople typeId -- view/module/office/PacifyPeopleView.as switch
const PACIFY = {
  relief: 1,     // 赈灾  +5 loyalty, -15 complaint
  pray: 2,       // 祈福  +25 loyalty, -5 complaint
  sacrifice: 3,  // 祭天  avoids a disaster
  popraise: 4,   // 增丁  +5% of max population, costs food
};

// Item ids for defensepolicy, from the embedded <itemEum> XML.
const DEFENSE_ITEMS = {
  truce: 'player.peace.1',          // Truce Agreement
  speech: 'player.heart.1.a',       // Speech Text
  warhorn: 'player.attackinc.1',    // War Horn
  ivoryhorn: 'player.attackinc.1.b',
  corselet: 'player.defendinc.1',   // Corselet
  ultracorselet: 'player.defendinc.1.b',
  penicillin: 'player.relive.1',    // Penicillin
};

// WARNING: two DIFFERENT resource numberings exist.
// TradeConstants.as -- market commands only:
const TRADE_RES = { food: 0, wood: 1, stone: 2, iron: 3 };
const TRADE_TYPE = { buy: 0, sell: 1 };
const TRADE_COMMISSION = 0.005;

// ObjConstants.as -- transport/resource payloads:
const RES = { wood: 1, iron: 2, food: 3, stone: 4, gold: 5, all: 6, pearl: 7 };

// ObjConstants.as
const REPORT_TYPE = { trade: 0, army: 1, other: 2 };

// FieldConstants.as — mapStr is 2 hex chars per tile: [type][level].
// Bonus = base + rate * level (percent), per FieldImageMc.setFieldType.
const FIELD_TYPES = {
  1:  { key: 'forest',    name: 'Forest',    bonus: 'wood',  base: 3, rate: 2 },
  2:  { key: 'desert',    name: 'Desert',    bonus: 'stone', base: 3, rate: 2 },
  3:  { key: 'hill',      name: 'Hill',      bonus: 'iron',  base: 3, rate: 2 },
  4:  { key: 'swamp',     name: 'Swamp',     bonus: 'food',  base: 3, rate: 2 },
  5:  { key: 'grassland', name: 'Grassland', bonus: 'food',  base: 2, rate: 1 },
  6:  { key: 'lake',      name: 'Lake',      bonus: 'food',  base: 5, rate: 3 },
  10: { key: 'flat',      name: 'Flat',      buildable: true },
  11: { key: 'castle',    name: 'Castle' },
  12: { key: 'npc',       name: 'NPC' },
};

// Decode one tile code, e.g. "69" -> Lake level 9
function decodeTile(code) {
  if (!code || code.length < 2) return null;
  const type = parseInt(code[0], 16);
  const level = parseInt(code[1], 16);
  const def = FIELD_TYPES[type];
  if (!def) return { type, level, key: 'unknown', name: 'Unknown' };
  const out = { type, level, key: def.key, name: def.name };
  if (def.bonus) out.desc = `+${def.base + def.rate * level}% ${def.bonus}`;
  else if (def.buildable) out.desc = 'can be built on';
  return out;
}

const MAP_W = 800;   // confirmed: fieldId 64208 == (208,80) -> y*800 + x
const REC_SIZE = 60000;   // NewArmyWin.as:80

const coordsToFieldId = (x, y) => y * MAP_W + x;
const fieldIdToCoords = (id) => ({ x: id % MAP_W, y: Math.floor(id / MAP_W) });

// NewArmyWin.as:2850/3033 -- needTime = (distance * recSize / effectiveSpeed) * 1000
// effectiveSpeed = slowest troop speed * (1 + marchSkillParam/100)
function marchTimeMs(fromXY, toXY, troopKeys, marchSkillParam = 100) {
  const dx = fromXY.x - toXY.x, dy = fromXY.y - toXY.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const speeds = troopKeys.filter((k) => BY_KEY[k]).map((k) => BY_KEY[k].speed);
  if (!speeds.length) return null;
  const slowest = Math.min(...speeds);
  const effective = slowest * (1 + marchSkillParam / 100);
  return (distance * REC_SIZE / effective) * 1000;
}

module.exports = {
  MISSION, TROOPS, BY_CODE, BY_KEY, EMPTY_TROOPS, WALLS, WALL_BY_CODE,
  BUILDINGS, BUILDING_BY_CODE, BUILDING_BY_ID, TECHS, TECH_BY_CODE, TECH_BY_ID, SLOTS,
  TROOP_DISPLAY_ORDER, BUILDING_DISPLAY_ORDER,
  TRADE_RES, TRADE_TYPE, TRADE_COMMISSION, RES, REPORT_TYPE, PACIFY, DEFENSE_ITEMS,
  MAP_W, REC_SIZE, coordsToFieldId, fieldIdToCoords, marchTimeMs, FIELD_TYPES, decodeTile,
};
