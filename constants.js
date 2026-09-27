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

// The most troops one march may take, every kind together: 10,000 per Rally
// Spot level, so 100,000 at L10 (the user, 2026-09-18; rally.js
// marchTroopLimit). More is refused: "Troops dispatch limit reached 100000"
// (seen live 2026-09-18, a requestresources transport of 199,974 transports;
// EVONY-RULES.md §5).
const MARCH_TROOPS_PER_LEVEL = 10000;
const MARCH_TROOP_MAX = 100000;
// A War Ensign (bean.useFlag, /big) raises that limit 25% (its item text:
// "increase personnel limit 25%"). Stygandr's Banner of the Horde (bean.useItem,
// /horde) lets a march take 1,000,000 (the user, 2026-09-18; the NEAT wiki's
// Attack page: "10 times as many ... 1 million", and 1.25 million with both).
// Whether a Rally Spot under L10 gets 1m or 10x its own limit is unverified;
// rally.js takes the flat 1m, the reading that never refuses a march the game
// would take.
const MARCH_ENSIGN_BONUS = 1.25;
const MARCH_HORDE_MAX = 1000000;
// A Haunted/Halloween Castle on the city (HauntedCastleBuf, HauntedCastleAdvBuf)
// raises what one march may take by 25% as well (the user, 2026-09-24). The
// client's own code only shows the buff's +10% production and its castle skin,
// so the server is the authority here — which is why our guard is generous and
// lets the server have the last word rather than refusing a march itself.
const MARCH_HAUNTED_BONUS = 1.25;

// com/evony/eum/TroopEumDefine + embedded <troopEum> XML.
// `code` matches the NEAT bot's short codes; `key` is the protocol field.
// life/attack/defence/range are the client's base stats (WarReport.swf XMLTroop,
// EVONY-RULES.md §5b); food is upkeep per unit per hour, buildTime base seconds.
const TROOPS = [
  { code: 'wo',   key: 'peasants',      typeId: 2,  name: 'Worker',        life: 100, attack: 5, defence: 10, range: 10, speed: 180,  load: 200,  food: 2 , pop: 1, cost: { food: 50, wood: 150, stone: 0, iron: 10 }, buildTime: 50 },
  { code: 'w',    key: 'militia',       typeId: 3,  name: 'Warrior',       life: 200, attack: 50, defence: 50, range: 20, speed: 200,  load: 20,   food: 3 , pop: 1, cost: { food: 80, wood: 100, stone: 0, iron: 50 }, buildTime: 25 },
  { code: 's',    key: 'scouter',       typeId: 4,  name: 'Scout',         life: 100, attack: 20, defence: 20, range: 20, speed: 3000, load: 5,    food: 5 , pop: 1, cost: { food: 120, wood: 200, stone: 0, iron: 150 }, buildTime: 100 },
  { code: 'p',    key: 'pikemen',       typeId: 5,  name: 'Pikeman',       life: 300, attack: 150, defence: 150, range: 50, speed: 300,  load: 40,   food: 6 , pop: 1, cost: { food: 150, wood: 500, stone: 0, iron: 100 }, buildTime: 150 },
  { code: 'sw',   key: 'swordsmen',     typeId: 6,  name: 'Swordsman',     life: 350, attack: 100, defence: 250, range: 30, speed: 275,  load: 30,   food: 7 , pop: 1, cost: { food: 200, wood: 150, stone: 0, iron: 400 }, buildTime: 225 },
  { code: 'a',    key: 'archer',        typeId: 7,  name: 'Archer',        life: 250, attack: 120, defence: 50, range: 1200, speed: 250,  load: 25,   food: 9 , pop: 2, cost: { food: 300, wood: 350, stone: 0, iron: 300 }, buildTime: 350 },
  { code: 't',    key: 'carriage',      typeId: 8,  name: 'Transporter',   life: 700, attack: 10, defence: 60, range: 10, speed: 150,  load: 5000, food: 10 , pop: 4, cost: { food: 600, wood: 1500, stone: 0, iron: 350 }, buildTime: 1000 },
  { code: 'c',    key: 'lightCavalry',  typeId: 9,  name: 'Cavalry',       life: 500, attack: 250, defence: 180, range: 100, speed: 1000, load: 100,  food: 18 , pop: 3, cost: { food: 1000, wood: 600, stone: 0, iron: 500 }, buildTime: 500 },
  { code: 'cata', key: 'heavyCavalry',  typeId: 10, name: 'Cataphract',    life: 1000, attack: 350, defence: 350, range: 80, speed: 750,  load: 80,   food: 35 , pop: 6, cost: { food: 2000, wood: 500, stone: 0, iron: 2500 }, buildTime: 1500 },
  { code: 'b',    key: 'ballista',      typeId: 11, name: 'Ballista',      life: 320, attack: 450, defence: 160, range: 1400, speed: 100,  load: 35,   food: 50 , pop: 5, cost: { food: 2500, wood: 3000, stone: 0, iron: 1800 }, buildTime: 3000 },
  { code: 'r',    key: 'batteringRam',  typeId: 12, name: 'Battering Ram', life: 5000, attack: 250, defence: 160, range: 600, speed: 120,  load: 45,   food: 100 , pop: 10, cost: { food: 4000, wood: 6000, stone: 0, iron: 1500 }, buildTime: 4500 },
  { code: 'cp',   key: 'catapult',      typeId: 13, name: 'Catapult',      life: 480, attack: 600, defence: 200, range: 1500, speed: 80,   load: 75,   food: 250 , pop: 8, cost: { food: 5000, wood: 5000, stone: 8000, iron: 1200 }, buildTime: 6000 },
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
// The other full names NEAT accepts (wiki: Build, Abbreviations): barrack, market, wall.
Object.assign(BUILDING_BY_CODE, {
  barrack: BUILDING_BY_CODE.barracks, market: BUILDING_BY_CODE.marketplace, wall: BUILDING_BY_CODE.walls,
});
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

// Building plots (BuildingConstants.as). Inside the walls there are 32, numbered
// 0-31 (CastleIn.SPACE_LIMIT); the Town Hall sits at -1 and the Walls at -2, so a
// full city holds 74 buildings. Outside there are 40, 1001-1040, but they open
// with the Town Hall: 13 at level 1 and 3 more per level, all 40 at level 10
// (CastleOut.initSpace / townHallLevelChange).
const SLOTS = {
  insideFrom: 0, insideTo: 31, outsideFrom: 1001, outsideTo: 1040,
  outsideAtL1: 13, outsidePerTownHall: 3,
};
const TOWN_HALL = 31, WALLS_TYPE = 32;

// The plots a building can go on, given the Town Hall level.
function plotRange(outside, townHallLevel = 1) {
  if (!outside) return { from: SLOTS.insideFrom, to: SLOTS.insideTo };
  const open = SLOTS.outsideAtL1 + (Math.max(1, Number(townHallLevel) || 1) - 1) * SLOTS.outsidePerTownHall;
  return { from: SLOTS.outsideFrom, to: Math.min(SLOTS.outsideTo, SLOTS.outsideFrom + open - 1) };
}

// TFConstants.as -- fortification ("wall") types for fortifications.produceWallProtect
// `beanKey` is how the castle's fortification object names it:
//   {"trap":1,"rollingLogs":0,"rockfall":0,"arrowTower":0,"abatis":1418}
// `space` is the fortified space one unit takes (CastleDefProduce.countFortSpace).
const WALLS = [
  { code: 'trap',   typeId: 14, name: 'Trap',         beanKey: 'trap',        space: 1 },
  { code: 'abatis', typeId: 15, name: 'Abatis',       beanKey: 'abatis',      space: 2 },
  { code: 'tower',  typeId: 16, name: 'Arrow Tower',  beanKey: 'arrowTower',  space: 3 },
  { code: 'logs',   typeId: 17, name: 'Rolling Logs', beanKey: 'rollingLogs', space: 4 },
  { code: 'rocks',  typeId: 18, name: 'Rock Fall',    beanKey: 'rockfall',    space: 5 },
];
const WALL_BY_CODE = Object.fromEntries(WALLS.flatMap((w) => [[w.code, w], [w.name.toLowerCase().replace(/ /g, ''), w]]));
const WALL_BY_TYPE = Object.fromEntries(WALLS.map((w) => [w.typeId, w]));

// Fortified space by Walls level (Wall.as changeCastleSpace). Built AND queued
// fortifications both take from it (Wall.as countSpace).
const WALL_SPACE = [0, 1000, 3000, 6000, 10000, 15000, 21000, 28000, 36000, 45000, 55000];

// ------------------------------------------------------------------ goal words
// The words a goal line may use for a troop, a fortification or a resource. ONE
// table, read by every goal parser (goals.js troop and fortification,
// goal-npc.js, goal-transfer.js, goal-war.js hidingpolicy /keep), so a spelling
// that works in one goal works in all of them. Matching ignores case, spaces,
// "_" and "-", and a plural of four letters or more also finds its singular.
//
// NEAT's list is the wiki's Abbreviations page: warrior w, worker wo, scout s,
// pikemen p, swordsmen sw, archer a, cavalry c, cataphract cata, transport t,
// ballista b, battering ram ram/br/r, catapult cp/pult. The Troop page and
// NEAT's own !NewCityGoals.txt add warr, cav, phract, arch, trans; the rest are
// the full names, the protocol keys (TroopStrBean) and what our parsers took
// before this table existed (ball, balls, cat, pike, sword, worker...).
// Note cata is the CATAPHRACT; the catapult is cp, cat or pult.
const TROOP_WORDS = {
  peasants:     ['wo', 'work', 'worker', 'workers', 'peasant', 'peasants'],
  militia:      ['w', 'warr', 'warrior', 'warriors', 'militia'],
  scouter:      ['s', 'scout', 'scouts', 'scouter', 'scouters'],
  pikemen:      ['p', 'pike', 'pikes', 'pikeman', 'pikemen'],
  swordsmen:    ['sw', 'sword', 'swords', 'swordsman', 'swordsmen'],
  archer:       ['a', 'arch', 'archer', 'archers'],
  carriage:     ['t', 'trans', 'transport', 'transports', 'transporter', 'transporters', 'carriage', 'carriages'],
  lightCavalry: ['c', 'cav', 'cavs', 'cavalry', 'lightcavalry'],
  heavyCavalry: ['cata', 'phract', 'phracts', 'cataphract', 'cataphracts', 'heavycavalry'],
  ballista:     ['b', 'ball', 'balls', 'ballista', 'ballistas', 'ballistae'],
  batteringRam: ['r', 'br', 'ram', 'rams', 'batteringram', 'batteringrams'],
  catapult:     ['cp', 'cat', 'cats', 'pult', 'pults', 'catapult', 'catapults'],
};

// Fortifications, keyed by WALLS code. NEAT's goal codes (FortificationGoal,
// Abbreviations) are tra, ab, at, r and tre; its "defenders:" status line
// prints tr, rl and dt (InLineCommands), and !NewCityGoals.txt writes trap and
// rock. NEAT's TREBUCHET is our Rock Fall, type 18: the client renames
// "Rockfall" to "Defensive Trebuchet" everywhere it shows it
// (CastleDefTypeUI.as:474-476, DescribeTooltip.as:183-186), and the wiki's
// Fortification page counts trebs with city.fortification.rockfall.
// "r" is rolling logs HERE and a battering ram in a troop list, as in NEAT.
// "ro" stays unknown: the wiki never uses it and it could mean either.
const FORT_WORDS = {
  trap:   ['tra', 'tr', 'trap', 'traps'],
  abatis: ['ab', 'abatis'],
  tower:  ['at', 'tower', 'towers', 'arrowtower', 'arrowtowers', 'archertower', 'archertowers'],
  logs:   ['r', 'rl', 'log', 'logs', 'rollinglog', 'rollinglogs'],
  rocks:  ['tre', 'treb', 'trebs', 'trebuchet', 'trebuchets', 'dt', 'defensivetrebuchet', 'defensivetrebuchets',
           'rf', 'rock', 'rocks', 'rockfall', 'rockfalls'],
};

// Resources (wiki Abbreviations: gold g, food f, wood w, stone s, iron i; NEAT's
// own pages also say lumber).
const RES_WORDS = {
  food: ['f', 'food'], wood: ['w', 'wood', 'l', 'lumber'], stone: ['s', 'stone'],
  iron: ['i', 'iron'], gold: ['g', 'gold'],
};

const wordKey = (s) => String(s == null ? '' : s).toLowerCase().replace(/[\s_-]+/g, '');
const invert = (words) => {
  const out = {};
  for (const [key, list] of Object.entries(words)) for (const w of list) out[w] = key;
  return out;
};
const TROOP_KEY_BY_WORD = invert(TROOP_WORDS);
const FORT_CODE_BY_WORD = invert(FORT_WORDS);
const RES_KEY_BY_WORD = invert(RES_WORDS);
const lookupWord = (table, tok) => {
  const k = wordKey(tok);
  if (Object.prototype.hasOwnProperty.call(table, k)) return table[k];
  // "archers", "ballistas": a plural of a word the table has. Short words are
  // left alone so "ws" or "cs" can never turn into a code by accident.
  const one = k.length >= 4 && k.endsWith('s') ? k.slice(0, -1) : null;
  return one && Object.prototype.hasOwnProperty.call(table, one) ? table[one] : null;
};

// The TROOPS entry for a word, or null.
function troopByWord(tok) {
  const key = lookupWord(TROOP_KEY_BY_WORD, tok);
  return key ? TROOPS.find((t) => t.key === key) : null;
}
// The WALLS entry for a word, or null.
function fortByWord(tok) {
  const code = lookupWord(FORT_CODE_BY_WORD, tok);
  return code ? WALLS.find((w) => w.code === code) : null;
}
// 'food' | 'wood' | 'stone' | 'iron' | 'gold', or null.
const resourceByWord = (tok) => lookupWord(RES_KEY_BY_WORD, tok);

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

// How the client spends each defence item. The command differs by item, and
// the bot sends exactly what the client sends:
//   city.setStopWarState {ItemId, passWord}  the Truce Agreement, from Player
//       Info (StageChangeWin.as:447); the item window will not spend it at all
//       (UseGoodWin.as:1437-1440). No castleId: it changes the whole account.
//   shop.useCastleGoods {castleId, itemId}   Speech Text, which works on one
//       city's loyalty (UseGoodWin.as:1576, SpeedupItemSelector.as:416).
//   shop.useGoods {castleId, itemId, num}    every other player item, the horns,
//       corselets and Penicillin included (UseGoodWin.as:1505).
// `buffs` are the player buff typeIds the item shows up as while it runs
// (PLayerBuffConstants.as; MainFrame.as:362 lists the truce family), and
// `lastsMs` is how long it runs, from the item's own description.
const DEFENSE_ITEM_USE = {
  'player.peace.1': { key: 'truce', name: 'Truce Agreement', cmd: 'city.setStopWarState', scope: 'account',
    buffs: ['PlayerPeaceBuff', 'PlayerPeaceUniteServerBuff', 'TruceAgreementBuff'], lastsMs: 12 * 3600000 },
  'player.heart.1.a': { key: 'speech', name: 'Speech Text', cmd: 'shop.useCastleGoods', scope: 'city', buffs: [], lastsMs: 0 },
  'player.attackinc.1': { key: 'warhorn', name: 'War Horn', cmd: 'shop.useGoods', scope: 'account',
    buffs: ['PlayerIncArmyAttachBuff'], lastsMs: 24 * 3600000 },
  'player.attackinc.1.b': { key: 'ivoryhorn', name: 'Ivory Horn', cmd: 'shop.useGoods', scope: 'account',
    buffs: ['PlayerIncArmyAttachBuff'], lastsMs: 7 * 24 * 3600000 },
  'player.defendinc.1': { key: 'corselet', name: 'Corselet', cmd: 'shop.useGoods', scope: 'account',
    buffs: ['PlayerIncArmyDefenceBuff'], lastsMs: 24 * 3600000 },
  'player.defendinc.1.b': { key: 'ultracorselet', name: 'Ultra Corselet', cmd: 'shop.useGoods', scope: 'account',
    buffs: ['PlayerIncArmyDefenceBuff'], lastsMs: 7 * 24 * 3600000 },
  'player.relive.1': { key: 'penicillin', name: 'Penicillin', cmd: 'shop.useGoods', scope: 'account',
    buffs: ['TroopReliveBuff'], lastsMs: 7 * 24 * 3600000 },
};
// While truced, and for the cooldown after, the game will not truce again
// (PlayerInfoWin.as:1845). NEAT calls these m_context.truced / inTruceCooldown.
const TRUCE_COOLDOWN_BUFFS = ['PlayerPeaceCoolDownBuff'];

// WARNING: two DIFFERENT resource numberings exist.
// TradeConstants.as -- market commands only:
const TRADE_RES = { food: 0, wood: 1, stone: 2, iron: 3 };
const TRADE_TYPE = { buy: 0, sell: 1 };
const TRADE_COMMISSION = 0.005;

// ObjConstants.as -- transport/resource payloads:
const RES = { wood: 1, iron: 2, food: 3, stone: 4, gold: 5, all: 6, pearl: 7 };

// ObjConstants.as
const REPORT_TYPE = { trade: 0, army: 1, other: 2 };

// ---- quests (QuestCommands.as, QuestWin.as) ----
// The two tabs. quest.getQuestType's `type`, and the `mainId` the QuestTypeBeans
// come back with: the Routine tab is 1, the Daily tab is 3 (QuestWin.as:942-946,
// :1036-1046, :1765-1766). The free daily amulet is a Daily quest (NEAT wiki
// CompleteQuests).
const QUEST_MODES = { routine: 1, daily: 3 };
// The Promotion quests, in the game's English: PlayerInfoTypeManager.getTitle
// 1-9 and getOffice 1-5. A title is worth claiming on its own -- the city cap
// is titleId + 1 (EVONY-RULES.md section 7).
const QUEST_TITLES = ['Knight', 'Baronet', 'Baron', 'Viscount', 'Earl', 'Marquis', 'Duke', 'Furstin', 'Prinzessin'];
const QUEST_RANKS = ['Lieutenant', 'Captain', 'Major', 'Colonel', 'General'];

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

// The sixteen states, a 4x4 grid of 200x200 blocks over the 800x800 map, read
// row by row. (457,281) -> column 2, row 1 -> Thuringia, which is what NEAT
// shows for that city. Only the NAMES are relied on elsewhere: the ids that
// city.moveCastle takes come live from common.zoneInfo.
const ZONES = [
  'Friesland', 'Saxony', 'North March', 'Bohemia',
  'Lower Lorraine', 'Franconia', 'Thuringia', 'Moravia',
  'Upper Lorraine', 'Swabia', 'Bavaria', 'Carinthia',
  'Burgundy', 'Lombardy', 'Tuscany', 'Romagna',
];
const zoneOf = (x, y) => ZONES[Math.min(3, Math.floor(y / 200)) * 4 + Math.min(3, Math.floor(x / 200))] || null;

// Mounted troops and siege engines move at driveSkillParam (Horseback Riding),
// everything on foot at marchSkillParam (NewArmyWin.speedFood).
const DRIVE_KEYS = new Set(['carriage', 'lightCavalry', 'heavyCavalry', 'ballista', 'batteringRam', 'catapult']);

// Tiles between two points the short way round: the map wraps at every edge,
// and NewArmyWin.countDistance tries all nine copies of the target.
function mapDistance(a, b) {
  let best = Infinity;
  for (const ox of [0, MAP_W, -MAP_W]) {
    for (const oy of [0, MAP_W, -MAP_W]) best = Math.min(best, Math.hypot(a.x - (b.x + ox), a.y - (b.y + oy)));
  }
  return best;
}

// How long a march takes, in ms, worked out the way the client does it
// (NewArmyWin.speedFood, :2850-3100). A timed landing is only as good as this.
//   skills   a number: marchSkillParam, used for every troop (the old call), or
//            { marchSkill, driveSkill, relief, castleBuffs, playerBuffs, now }
//   relief   army.getTroopParam's transportStationParam for the sending city.
//            The client applies it whenever the target is yours or your
//            alliance's, and that includes your own flats and valleys.
// The slowest speed is held in an int, and so is its product with relief.
function marchTimeMs(fromXY, toXY, troopKeys, skills = 100) {
  const p = skills !== null && typeof skills === 'object' ? skills : { marchSkill: skills };
  const march = Number(p.marchSkill ?? 100);
  const drive = Number(p.driveSkill ?? march);
  const speeds = troopKeys.filter((k) => BY_KEY[k])
    .map((k) => BY_KEY[k].speed * (1 + (DRIVE_KEYS.has(k) ? drive : march) / 100));
  if (!speeds.length) return null;
  let speed = Math.trunc(Math.min(...speeds));
  if (Number(p.relief) > 0) speed = Math.trunc(Number(p.relief) * speed);
  if (speed <= 0) return null;
  const ms = mapDistance(fromXY, toXY) * REC_SIZE / speed * 1000;
  return Math.max(0, ms * armyTimeFactor(p));
}

// What the buffs do to an army's time, as one multiplier, in the client's order
// (NewArmyWin:3043-3100). The first two scale with how long the buff has left
// to run: Fleet Feet (ReduceArmyActionBuff) is -35% with one charge on, -70%
// with two.
//
// THE SERVER APPLIES THIS TO THE CAMP TOO, not only the march (Lord24, 2026-09-27:
// a reinforce 3 -> 5 with two Fleet Feet on, 3,047 s of march by the formula and
// 11,085 s of camp asked, landed 6,376 s after the send — 0.3 x (10,157 + 11,085)
// = 6,373 s). The Relief Station is a speed, and speeds only the march. So a
// camp of C seconds asked for is C x factor in the game; to camp C, ask C / factor
// (timed-march.js, script-cmd-deploy.js). *Unverified* for the slower castle buff
// and HarvesterWagesBuff — assumed to work the same way as Fleet Feet.
function armyTimeFactor(p = {}) {
  let k = 1;
  const now = Number(p.now ?? Date.now());
  const latest = (list, name) => Math.max(0, ...(list || [])
    .filter((b) => String((b && b.typeId) || '').includes(name)).map((b) => Number(b.endTime) || 0));
  const band = (end, pcts) => (end - now > 8 * 3600000 ? pcts[0] : end - now > 4 * 3600000 ? pcts[1] : pcts[2]);
  const slower = latest(p.castleBuffs, 'IncArmyActionTimeBuff');
  if (slower > now) k += k * band(slower, [60, 40, 20]) / 100;
  const faster = latest(p.playerBuffs, 'ReduceArmyActionBuff');
  if (faster > now) k -= k * band(faster, [105, 70, 35]) / 100;
  for (const b of p.playerBuffs || []) if (String((b && b.typeId) || '').includes('HarvesterWagesBuff')) k = k * 90 / 100;
  return Math.max(0, k);
}

// The food an army takes with it, per hour, the way the client charges it
// (NewArmyWin.speedFood): every troop costs its upkeep TWICE — costObj =
// foodRequest * 2 * count (:2852) — for each hour of the ONE-WAY march
// (portableFood, :3102) and at the same rate for each hour encamped (needFood,
// :1717). It rides in the army's own hold (leftSpace = loads - needFood, :1719),
// and the client refuses a march the city cannot feed.
function marchFoodPerHour(troops) {
  let perHour = 0;
  for (const [k, v] of Object.entries(troops || {})) {
    const x = Number(v);
    if (BY_KEY[k] && Number.isFinite(x) && x > 0) perHour += BY_KEY[k].food * 2 * x;
  }
  return perHour;
}
// ...for a march of oneWayMs that then encamps for restMs.
const marchFood = (troops, oneWayMs, restMs = 0) =>
  marchFoodPerHour(troops) * ((Number(oneWayMs) || 0) + (Number(restMs) || 0)) / 3600000;

// The free speed-up. castle.speedUpBuildCommand and tech.speedUpResearch with
// this item finish a job at no cost, but only a job whose PRESET time is five
// minutes or less: the base time the client's tables give that level, before
// research and the mayor shorten it. The client compares that base time, not
// the time left, with the limit (SpeedUpCheckOut.as:18-28, from
// BuildingBar.onBuildingSpeedUp and TechReseachingUI.onSpeedUp), and says so
// when it works: "Presetted Constructing Time less than 5 minutes. Free
// speed-up finished." (Lang 生产时间低于5分钟免费加速).
const FREE_SPEED = {
  item: 'free.speed',     // CommonConstants.FREE_SPEED_ITEM_ID
  limitSec: 300,          // CommonConstants.FREE_SPEED_TIME_LIMIT
  // Base seconds of the jobs within the limit, by the level the job starts
  // from (levelData level N is the job from N to N+1; a new building starts at
  // 0), from the client's building and tech tables (GetDataXML_XMLBuilding,
  // GetDataXML_XMLTech). Every later level, and every type not listed here,
  // takes longer than 300 s.
  building: {
    1: [75, 150, 300],        // Cottage
    2: [300],                 // Barracks
    4: [45, 90, 180],         // Sawmill
    5: [60, 120, 240],        // Quarry
    6: [90, 180],             // Ironmine
    7: [30, 60, 120, 240],    // Farm
    20: [270],                // Stable
    21: [240],                // Inn
    22: [180],                // Forge
    27: [300],                // Feasting Hall
    29: [150, 300],           // Rally Spot
  },
  research: {
    7: [300],                 // Informatics
  },
};

module.exports = {
  MISSION, MARCH_TROOPS_PER_LEVEL, MARCH_TROOP_MAX, MARCH_ENSIGN_BONUS, MARCH_HORDE_MAX, MARCH_HAUNTED_BONUS, TROOPS, BY_CODE, BY_KEY, EMPTY_TROOPS, WALLS, WALL_BY_CODE, WALL_BY_TYPE, WALL_SPACE,
  TROOP_WORDS, FORT_WORDS, RES_WORDS, troopByWord, fortByWord, resourceByWord,
  BUILDINGS, BUILDING_BY_CODE, BUILDING_BY_ID, TECHS, TECH_BY_CODE, TECH_BY_ID,
  SLOTS, TOWN_HALL, WALLS_TYPE, plotRange,
  TROOP_DISPLAY_ORDER, BUILDING_DISPLAY_ORDER,
  TRADE_RES, TRADE_TYPE, TRADE_COMMISSION, RES, REPORT_TYPE, PACIFY, DEFENSE_ITEMS, DEFENSE_ITEM_USE, TRUCE_COOLDOWN_BUFFS,
  QUEST_MODES, QUEST_TITLES, QUEST_RANKS,
  MAP_W, REC_SIZE, coordsToFieldId, fieldIdToCoords, marchTimeMs, armyTimeFactor, mapDistance, DRIVE_KEYS, FIELD_TYPES, decodeTile,
  marchFood, marchFoodPerHour,
  ZONES, zoneOf,
  FREE_SPEED,
};
