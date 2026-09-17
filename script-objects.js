'use strict';
// NEAT's script objects: the game state a script can read, under NEAT's names.
//
//   echo city.name " has " city.troop.archer " archers"
//   if city.hasEnemyArmiesWithin(600) gosub defend
//   if m_city.AnyIdleHero("any:att>100,att<300") if city.troops.archer > 100k execute "attack ..."
//   t = GetTroops("a:30k,b:40k")   echo TroopBeanToString(t, ",") " eats " t.foodConsumeRate "/h"
//   cities.forEach(CreateFunction("c,i,a", "echo c.cityManager.name c.cityManager.coords"))
//
// The names are the Evony client's own bean fields, typos included (texRate,
// storeRercent, upgradeing, permition, scouter, heavyCavalry), because NEAT
// scripts read those beans. Everything a script gets is a COPY built on each
// read. `city.troop.archer = 5` or `cities.pop()` changes only that copy. The
// city objects are frozen views that read the live castle on every access, so
// a held `cm = cities[0].cityManager` still shows what is true now. Members
// that need a server read (researches, inn heroes, queues, production, march
// skills) return a Promise, which the evaluator awaits. Those reads are cached
// for a few seconds and are all read-only.
//
// Globals (globals(ctx)):
//   city = m_city = m_city.cityManager          the city the script runs in (CityView)
//   cities[i]  (cities[i].cityManager)          every city, in login order
//   player = m_context.Player                   the PlayerBean (accountName left out: it is the login)
//   m_context  truced inTruceCooldown hasBuff(t) buff(t) buffs ItemCount(id) GetItem(id)
//              marketReady() buyPrice(res) sellPrice(res)  (the three: script-cmd-market.js)
//              findFirstCity() serverHours serverMinutes serverSeconds
//              serverYear serverMonth(0-11) serverDate maintenanceStart Player
//   Screen.mainLog|cityLog|reportLog|aChat|pChat|wChat|sChat .buffer / .addEvent("text")
//   Config.<key>                                server, proxy, and opts.config keys (never the login)
//   Settings.autoUseItems(all, fivePerDay)      NEAT's items-it-uses-by-itself list: none here, so it says so
//   GetTroops(str) TroopBeanToString(bean[, sep]) GetFortifications(str)   (GetResources: script-functions.js)
//   ItemCount(idOrName) GetItem(idOrName) IsHeroInCastle(heroString) AnyIdleHero(heroString)
//   GetTechLevel(type) is_researching HeroLevel(level, exp) HeroExperience(end[, start[, exp]])
//
// CityView members:
//   id name fieldId x y coords cityCoords timeSlot cityNameCoords() cityManager castle
//   script.callScript("lines")          start those lines in that (another) city; the console
//                                       runs them (run() opts.runInCity), else it says why not
//   resource estResource resetEstResource() reservedResource ResourceProduction* incomingResources([sec])
//   hasResource(res)                    at least these held (a resource bean or "f:1m,g:5k")
//   troop troops troopStillInProduction* (also callable) getAvailableTroop([inCityOnly])
//   getCarryingLoad(troops)* getTravelTime(fromFid, toFid, troops[, type])*
//   fortification fortificationsRequirement fortificationRequirement fortificationProduceQueue*
//   buildings getBuildingLevel(t) getBuildingByTypeId(t) getBuildingByPosId(p) countBuilding(t[, min[, max]])
//   hasBuilding(t[, min]) getTownHallLevel() getWallLevel() getActiveBuilding() getEmptyPositions(t)
//   rallySpotAvailable([reserveForTrainingHero[, extra]])
//   researches* getTechLevel(t)* GetTechLevel(t)* hasTech(t, lvl)* getActiveResearch()* is_researching*
//   heroes innHeroes* innheroes* findHeroByName(n) heros(n) getMayor() IsHeroInCastle(s) AnyIdleHero(s)
//   trainingHeroName TrainingHeroIsHere checkFeastingHallSpace
//   enemyArmies friendlyArmies selfArmies myArmies hasEnemyArmies hasEnemyArmiesWithin(sec[, blind])
//   NumberOfRealAttacks fields tradesArray transingTradesArray buyPrice(res) sellPrice(res)
//   buffs hasBuff(t) buff(t) brokenGates
//   PRFactor comfortingNeeds(1-4) getConfig(key) cityHasGoalErrors CityHasGoalErrors GateControl
//   compareByDistanceToCastle(a, b) setCityTimer(key) cityTimingAllowed(key, sec[, test])
//   (* = one cached server read; the value is a Promise)
//
// Beans (exported as `beans`, for command modules and script-functions.js):
//   troops(counts) fortifications(counts) resources(res) hero(h, ctx) army(a) field(f)
//   building(b) buff(b) research(r) item(it) city(castle, ctx) player(ctx)
//   Troop beans: 12 keys + foodConsumeRate, foodConsumption(sec), add(x), addTo(x), toString(sep).
//   Resource beans: gold food wood stone iron + add, addTo, toString. Strings round-trip:
//   GetTroops(TroopBeanToString(b, ",")) gives b back ("a:0" / "f:0" when empty).
//   A command that changes what a cached read shows calls forget(game, prefix):
//   'research:' (startresearch), 'inn:' (hire/fire), 'troopq:' (train), 'wallq:'
//   (walldefense), 'prod:' (production).
//
// ctx is DESIGN.md's; ctx.busyHeroes(heroId) (heroes this run sent in the last
// minute) feeds hero.isBusy/isAvailable and AnyIdleHero.
//
// Not here, for want of data: estimated resources between pushes (estResource
// is the last push), NEAT's building order 0-73 (buildings is the server's
// order), getMaxArmySize, hasResourceForArmy, haunted, distanceSettings,
// buildCityLocations, the queue/inn "status" flags and other NEAT internals,
// the beginners chat and command log. Left out on purpose (logins):
// Config.username/password and accountName in any PlayerInfoBean.
const C = require('./constants');
const { Game } = require('./game');
const H = require('./goal-heroes');
const R = require('./rally');

const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();
const BLOCKED = new Set(['__proto__', 'prototype', 'constructor']);
// Word tables with no prototype, so "toString:5" is an unknown word, not a key.
const table = (entries) => Object.assign(Object.create(null), Object.fromEntries(entries));

// A method or helper that JSON and key listings should not see.
function hide(obj, name, value) {
  Object.defineProperty(obj, name, { value, enumerable: false, writable: false, configurable: false });
  return obj;
}
function hideGetter(obj, name, get) {
  Object.defineProperty(obj, name, { get, enumerable: false, configurable: false });
  return obj;
}
// core passes the raw text between the parens to these when it is not an
// expression: IsHeroInCastle(any:att>200), heros(Queen), hasBuff(ForceopenclosegateBuff).
const rawArgs = (f) => { f.rawArgs = true; return f; };

const isPlain = (v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

// Server beans are copied from an ALLOWLIST: the client's own bean fields
// (src/scripts/com/evony/common/beans/*.as), less anything that is a login or
// a security setting. A field the server adds some day stays out until it is
// named here. Nested beans (resource, troop, heros ...) are built separately.
const BEAN = {
  castle: ['allowAlliance', 'fieldId', 'goOutForBattle', 'hasEnemy', 'id', 'logUrl', 'name', 'status',
    'usePACIFY_SUCCOUR_OR_PACIFY_PRAY'],                                                          // CastleBean
  hero: ['experience', 'id', 'itemAmount', 'itemId', 'level', 'logoUrl', 'loyalty', 'management', 'managementAdded',
    'managementBuffAdded', 'name', 'power', 'powerAdded', 'powerBuffAdded', 'remainPoint', 'status', 'stratagem',
    'stratagemAdded', 'stratagemBuffAdded', 'upgradeExp'],                                          // HeroBean
  army: ['alliance', 'armyId', 'direction', 'hero', 'heroLevel', 'king', 'missionType', 'reachTime', 'restTime',
    'startFieldId', 'startPosName', 'startTime', 'targetFieldId', 'targetPosName'],                 // ArmyBean
  field: ['id', 'level', 'name', 'statu', 'type'],                                                  // FieldBean
  building: ['endTime', 'level', 'name', 'positionId', 'startTime', 'status', 'typeId'],            // BuildingBean
  buildingQueue: ['costTime', 'id', 'level', 'name', 'positionId', 'queueType', 'status', 'typeId'], // BuildingQueueBean
  buff: ['descName', 'endTime', 'typeId'],                                                          // BuffBean
  trade: ['amount', 'dealedAmount', 'dealedTotal', 'id', 'price', 'resType', 'resourceName', 'tradeType', 'tradeTypeName'],
  transingTrade: ['amount', 'endTime', 'id', 'price', 'resType', 'resourceName', 'total'],         // TransingTradeBean
  research: ['avalevel', 'castleId', 'endTime', 'level', 'permition', 'startTime', 'typeId', 'upgradeing'],
  item: ['count', 'id', 'maxCount', 'minCount', 'name'],                                           // ItemBean
  castleSign: ['id', 'name', 'x', 'y'],                                                             // CastleSignInfoBean
  // PlayerInfoBean without accountName (the login e-mail); friends and blocked players are these too.
  playerInfo: ['alliance', 'allianceLevel', 'bdenyotherplayer', 'castleCount', 'createrTime', 'faceUrl', 'flag',
    'honor', 'id', 'lastLoginTime', 'levelId', 'medal', 'office', 'population', 'prestige', 'ranking', 'sex',
    'titleId', 'userId', 'userName'],
  // PlayerBean's game state, without isSetSecurityCode and the client's UI counters.
  player: ['autoFurlough', 'currentDateTime', 'currentTime', 'finishedQuestCount', 'freshMan', 'furlough', 'furloughDay',
    'gameSpeed', 'mapSizeX', 'mapSizeY', 'newMailCount', 'newMaileCount_inbox', 'newMaileCount_system',
    'newReportCount', 'newReportCount_army', 'newReportCount_other', 'newReportCount_trade'],
};
function pick(src, fields) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const k of fields) if (Object.prototype.hasOwnProperty.call(src, k) && isPlain(src[k])) out[k] = src[k];
  return out;
}
const beanOf = (kind) => (src) => pick(src, BEAN[kind]);

// The plain values of a script's own parameters (opts.config), not server data.
function scalars(src) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const k of Object.keys(src)) if (!BLOCKED.has(k) && !k.startsWith('__') && isPlain(src[k])) out[k] = src[k];
  return out;
}

// NEAT's extra words (arch, warr, cav, treb, lumber ...) live in core's
// script-words.js; the codes and protocol keys are checked here first. A
// missing module is asked for again at most every few seconds.
let wordsMod = null, wordsTriedAt = 0;
function words() {
  if (wordsMod) return wordsMod;
  if (Date.now() - wordsTriedAt < 5000) return null;
  wordsTriedAt = Date.now();
  try { wordsMod = require('./script-words'); } catch { wordsMod = null; }
  return wordsMod;
}
const isBag = (v) => !!v && (typeof v === 'object' || typeof v === 'function');

// ---------------------------------------------------------------- troops

const TROOP_KEYS = C.TROOP_DISPLAY_ORDER.slice();               // barracks order
const TROOP_CODE = table(C.TROOPS.map((t) => [t.key, t.code]));
const TROOP_BY_WORD = table(C.TROOPS.flatMap((t) => [[t.code, t.key], [t.key.toLowerCase(), t.key]]));

function troopKeyOf(word) {
  if (TROOP_KEYS.includes(word)) return word;
  const hit = TROOP_BY_WORD[lc(word)];
  if (hit) return hit;
  const w = words();
  const t = w && typeof w.troopByWord === 'function' ? w.troopByWord(word) : null;
  return t ? t.key : null;
}

// An unscouted army's TroopStrBean says '?' per type, and a scout report at
// low Informatics a range such as '1000-2000': unknown, not zero. Such text is
// kept as it came; it adds up to '?'.
const isUnknown = (v) => typeof v === 'string' && v.trim() !== '' && !Number.isFinite(Number(v));

function addTroopsInto(target, src) {
  if (!target || typeof target !== 'object' || !isBag(src)) return;
  for (const k of TROOP_KEYS) {
    if (isUnknown(target[k]) || isUnknown(src[k])) { target[k] = '?'; continue; }
    target[k] = num(target[k]) + num(src[k]);
  }
}

function troopString(bean, sep) {
  const parts = [];
  for (const k of TROOP_KEYS) {
    const v = bean[k];
    if (isUnknown(v)) parts.push(`${TROOP_CODE[k]}:${v.trim()}`);
    else if (num(v) > 0) parts.push(`${TROOP_CODE[k]}:${num(v)}`);
  }
  return parts.length ? parts.join(sep === undefined || sep === null ? ',' : String(sep)) : 'a:0';
}

// A TroopBean: all twelve types, whatever the input named.
//   counts   {archer: 5}, {a: 5}, a TroopBean, or an army's TroopStrBean
function troops(counts) {
  const out = {};
  for (const k of TROOP_KEYS) out[k] = 0;
  if (typeof counts === 'string') counts = parseTroopText(counts);
  if (isBag(counts)) {
    for (const word of Object.keys(counts)) {
      if (BLOCKED.has(word) || word.startsWith('__')) continue;
      const k = troopKeyOf(word);
      if (!k) continue;
      const v = counts[word];
      if (isUnknown(v)) out[k] = out[k] === 0 ? v.trim() : '?';
      else if (!isUnknown(out[k])) out[k] += num(v);
      else if (num(v)) out[k] = '?';
    }
  }
  const rate = () => TROOP_KEYS.reduce((s, k) => s + num(out[k]) * C.BY_KEY[k].food, 0);
  hideGetter(out, 'foodConsumeRate', rate);                              // food per hour
  hide(out, 'foodConsumption', (sec) => rate() * num(sec) / 3600);
  // Both return nothing: NEAT's totals script chains them with ||.
  hide(out, 'add', (x) => { addTroopsInto(out, typeof x === 'string' ? troops(x) : x); });
  hide(out, 'addTo', (x) => { addTroopsInto(x, out); });
  hide(out, 'toString', (sep) => troopString(out, sep));
  return out;
}

// troopStillInProduction is a property on one wiki page and a call on
// another, so the value is both: a function that returns the bean, carrying
// the counts as its own properties.
function callableTroops(bean) {
  const f = () => troops(bean);
  for (const k of TROOP_KEYS) Object.defineProperty(f, k, { value: bean[k], enumerable: true });
  hideGetter(f, 'foodConsumeRate', () => bean.foodConsumeRate);
  hide(f, 'foodConsumption', (sec) => bean.foodConsumption(sec));
  hide(f, 'toString', (sep) => troopString(bean, sep));
  return f;
}

// "a:30k,b:40k" -> {archer: 30000, ballista: 40000}. The script language's own
// parser (script-words.js, re-exported by script.js) knows every NEAT word;
// the fallback reads codes and protocol keys.
const COUNT = /^([\d.]+)\s*([kmb])?$/i;
function countOf(s) {
  const m = String(s).trim().match(COUNT);
  if (!m || !Number.isFinite(parseFloat(m[1]))) throw new Error('bad number: ' + s);
  return Math.round(parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1));
}
function scriptParser(name) {
  const w = words();
  if (w && typeof w[name] === 'function') return w[name];
  try { const S = require('./script'); return typeof S[name] === 'function' ? S[name] : null; } catch { return null; }
}
function parsePairs(text, keyOf, what) {
  const out = {};
  for (const part of String(text).split(/[,\s]+/)) {
    if (!part) continue;
    const m = part.match(/^([a-z_]+)\s*:\s*(.+)$/i);
    const k = m && keyOf(m[1]);
    if (!k) throw new Error(`bad ${what}: ${part}`);
    out[k] = (out[k] || 0) + countOf(m[2]);
  }
  return out;
}
function parseTroopText(text) {
  const p = scriptParser('parseTroops');
  return p ? p(String(text)) : parsePairs(text, troopKeyOf, 'troop string');
}

// GetTroops: null for a bad string, as NEAT's own example tests for.
function getTroops(s) {
  if (isBag(s)) return troops(s);
  const text = String(s == null ? '' : s).trim();
  if (!text) return null;
  try { return troops(parseTroopText(text)); } catch { return null; }
}

// ------------------------------------------------------------- resources

const RES_KEYS = ['gold', 'food', 'wood', 'stone', 'iron'];            // ResourceBean
const RES_ORDER = ['food', 'wood', 'stone', 'iron', 'gold'];
const RES_CODE = { food: 'f', wood: 'w', stone: 's', iron: 'i', gold: 'g' };
const RES_WORD = table(Object.entries({ f: 'food', food: 'food', w: 'wood', wood: 'wood', l: 'wood', lumber: 'wood',
  s: 'stone', stone: 'stone', i: 'iron', iron: 'iron', g: 'gold', gold: 'gold' }));

function resKeyOf(word) {
  const hit = RES_WORD[lc(word)];
  if (hit) return hit;
  const w = words();
  return (w && typeof w.resourceByWord === 'function' && w.resourceByWord(word)) || null;
}

// A castle's resource is {amount, ...} per kind; a march's is a bare number.
const amountOf = (v) => (v && typeof v === 'object' ? num(v.amount) : num(v));

function addResourcesInto(target, src) {
  if (!target || typeof target !== 'object' || !src || typeof src !== 'object') return;
  for (const k of RES_KEYS) target[k] = num(target[k]) + amountOf(src[k]);
}

function resourceString(bean, sep) {
  const parts = RES_ORDER.filter((k) => num(bean[k]) > 0).map((k) => `${RES_CODE[k]}:${num(bean[k])}`);
  return parts.length ? parts.join(sep === undefined || sep === null ? ',' : String(sep)) : 'f:0';
}

function resources(res) {
  const out = {};
  for (const k of RES_KEYS) out[k] = 0;
  if (typeof res === 'string') res = parseResourceText(res);
  if (res && typeof res === 'object') {
    for (const word of Object.keys(res)) {
      if (BLOCKED.has(word) || word.startsWith('__')) continue;
      const k = resKeyOf(word);
      if (k) out[k] += amountOf(res[word]);
    }
  }
  hide(out, 'add', (x) => { addResourcesInto(out, typeof x === 'string' ? resources(x) : x); });
  hide(out, 'addTo', (x) => { addResourcesInto(x, out); });
  hide(out, 'toString', (sep) => resourceString(out, sep));
  return out;
}

function parseResourceText(text) {
  const p = scriptParser('parseResources');
  return p ? p(String(text)) : parsePairs(text, resKeyOf, 'resource string');
}
function getResources(s) {
  if (s && typeof s === 'object') return resources(s);
  const text = String(s == null ? '' : s).trim();
  if (!text) return null;
  try { return resources(parseResourceText(text)); } catch { return null; }
}

// The client beans' numeric fields: a field the server left out reads 0 there
// (an AS3 int), so it must here too, or `upkeep += c.resource.troopCostFood` is NaN.
const INFO_FIELDS = ['amount', 'increaseRate', 'max', 'storeRercent', 'workPeople'];           // ResourceInfoBean
const CASTLE_RES_FIELDS = ['buildPeople', 'complaint', 'curPopulation', 'gold', 'herosSalary', 'maxPopulation',
  'populationDirection', 'support', 'taxIncome', 'texRate', 'troopCostFood', 'workPeople'];       // CastleResourceBean
const withZeros = (out, fields) => { for (const k of fields) if (typeof out[k] !== 'number') out[k] = num(out[k]); return out; };

// One kind of a castle's resource: ResourceInfoBean. It compares and prints as
// its amount, so `city.resource.food > 100k` does what it reads as.
function resourceInfo(v) {
  const src = v && typeof v === 'object' ? v : { amount: num(v) };
  const out = withZeros(pick(src, INFO_FIELDS), INFO_FIELDS);
  hide(out, 'valueOf', () => num(src.amount));
  hide(out, 'toString', () => String(num(src.amount)));
  return out;
}

// CastleResourceBean: population, loyalty (support), grievance (complaint),
// tax (texRate), gold, and a ResourceInfoBean per kind.
function castleResource(r) {
  const src = r || {};
  const out = withZeros(pick(src, CASTLE_RES_FIELDS), CASTLE_RES_FIELDS);
  for (const k of ['food', 'wood', 'stone', 'iron']) out[k] = resourceInfo(src[k]);
  hide(out, 'toString', () => resourceString(resources(src)));
  return out;
}

// -------------------------------------------------------- fortifications

const FORT_KEYS = C.WALLS.map((w) => w.beanKey);             // trap abatis arrowTower rollingLogs rockfall
const FORT_CODE = { trap: 'tra', abatis: 'ab', arrowTower: 'at', rollingLogs: 'r', rockfall: 'tre' };   // NEAT's goal codes
const FORT_WORD = table(Object.entries({
  tra: 'trap', tr: 'trap', trap: 'trap', traps: 'trap', ab: 'abatis', abatis: 'abatis',
  at: 'arrowTower', tower: 'arrowTower', towers: 'arrowTower', arrowtower: 'arrowTower', arrowtowers: 'arrowTower',
  archertower: 'arrowTower', archertowers: 'arrowTower',
  r: 'rollingLogs', rl: 'rollingLogs', logs: 'rollingLogs', rollinglogs: 'rollingLogs',
  tre: 'rockfall', treb: 'rockfall', trebs: 'rockfall', trebuchet: 'rockfall', trebuchets: 'rockfall',
  rf: 'rockfall', rocks: 'rockfall', rockfall: 'rockfall',
}));

function fortKeyOf(word) {
  if (FORT_KEYS.includes(word)) return word;
  const hit = FORT_WORD[lc(word).replace(/[\s_-]/g, '')];
  if (hit) return hit;
  const w = words();
  const def = w && typeof w.fortByWord === 'function' ? w.fortByWord(word) : null;
  return def ? def.beanKey : null;
}

function fortifications(counts) {
  const out = {};
  for (const k of FORT_KEYS) out[k] = 0;
  if (typeof counts === 'string') counts = parsePairs(counts, fortKeyOf, 'fortification string');
  if (counts && typeof counts === 'object') {
    for (const word of Object.keys(counts)) {
      const k = fortKeyOf(word);
      if (k) out[k] += num(counts[word]);
    }
  }
  hide(out, 'toString', (sep) => {
    const parts = FORT_KEYS.filter((k) => num(out[k]) > 0).map((k) => `${FORT_CODE[k]}:${num(out[k])}`);
    return parts.length ? parts.join(sep === undefined || sep === null ? ',' : String(sep)) : 'tra:0';
  });
  return out;
}

function getFortifications(s) {
  if (s && typeof s === 'object') return fortifications(s);
  const text = String(s == null ? '' : s).trim();
  if (!text) return null;
  try { return fortifications(parsePairs(text, fortKeyOf, 'fortification string')); } catch { return null; }
}

// ------------------------------------------------------------ small beans

const MISSION_NAME = Object.fromEntries(Object.entries(C.MISSION).map(([k, v]) => [v, k]));

function coordsOf(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? C.fieldIdToCoords(v) : null;
  if (typeof v === 'string') {
    const m = v.match(/^\s*\(?\s*(\d+)\s*,\s*(\d+)\s*\)?\s*$/);
    if (m) return { x: +m[1], y: +m[2] };
    return /^\s*\d+\s*$/.test(v) ? C.fieldIdToCoords(Number(v)) : null;
  }
  if (typeof v === 'object') {
    if (Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y)) && v.x !== null && v.y !== null) return { x: Number(v.x), y: Number(v.y) };
    if (v.fieldId !== undefined) return coordsOf(Number(v.fieldId));
    if (v.id !== undefined) return coordsOf(Number(v.id));
  }
  return null;
}
const coordsText = (fid) => {
  const xy = fid === undefined || fid === null || fid === '' ? null : coordsOf(Number(fid));
  return xy ? `${xy.x},${xy.y}` : null;
};

function buff(b) {
  const out = pick(b, BEAN.buff);
  hide(out, 'toString', () => String((b && (b.descName || b.typeId)) || ''));
  return out;
}

function building(b) {
  const out = pick(b, BEAN.building);
  hide(out, 'toString', () => `${(b && b.name) || 'building'} L${num(b && b.level)}`);
  return out;
}

// FieldBean {id, level, name, statu, type} plus where it is.
function field(f) {
  const out = pick(f, BEAN.field);
  const xy = coordsOf(Number(f && f.id));
  if (xy) Object.assign(out, { x: xy.x, y: xy.y, coords: `${xy.x},${xy.y}` });
  out.armysArray = ((f && f.armys) || []).map(army);
  hide(out, 'toString', () => `${(f && f.name) || 'field'} L${num(f && f.level)}${xy ? ` (${xy.x},${xy.y})` : ''}`);
  return out;
}

// ArmyBean. `hero` is the hero's NAME on the wire; troop is a TroopStrBean,
// '?' where nobody has scouted it.
function army(a) {
  const src = (a && a.raw) || a || {};
  const out = pick(src, BEAN.army);
  if (src.hero && typeof src.hero === 'object') out.hero = src.hero.name === undefined ? null : src.hero.name;
  out.resource = resources(src.resource || src.resources || {});
  out.troop = troops(src.troop || src.troops || {});
  out.startCoords = out.startFieldCoords = coordsText(src.startFieldId);
  out.targetCoords = out.targetFieldCoords = coordsText(src.targetFieldId);
  hide(out, 'toString', () => `${MISSION_NAME[num(src.missionType)] || 'army'} ${src.startPosName || out.startCoords || '?'}`
    + ` -> ${src.targetPosName || out.targetCoords || '?'}: ${troopString(out.troop)}`);
  return out;
}

// AvailableResearchListBean (conditionBean left out).
const research = beanOf('research');

function item(it, name) {
  const out = pick(it, BEAN.item);
  out.id = String((it && it.id) || '');
  out.count = num(it && it.count);
  if (name) out.name = name;
  hide(out, 'toString', () => `${out.name || out.id} x${out.count}`);
  return out;
}

// ------------------------------------------------------------------ heroes

// Hero experience. INFERRED: a level costs level^2 x 100, which fits every row
// of the wiki's ListAllHeroes sample (L193 needs 3,724,900). The bean's own
// upgradeExp is used for the first step when it is there.
const heroExp = {
  toNext: (level) => num(level) * num(level) * 100,
  levelsFrom(level, exp, firstCost) {
    let L = num(level), left = num(exp), n = 0;
    let cost = num(firstCost) > 0 ? num(firstCost) : heroExp.toNext(L);
    while (cost > 0 && left >= cost && n < 100000) { left -= cost; n++; L++; cost = heroExp.toNext(L); }
    return n;
  },
  expBetween(end, start = 1, exp = 0) {
    let sum = 0;
    for (let L = Math.max(1, num(start) || 1); L < num(end) && L < 100000; L++) sum += heroExp.toNext(L);
    return Math.max(0, sum - num(exp));
  },
};

function heroBusy(ctx, id) {
  const b = ctx && ctx.busyHeroes;
  if (!b || id === undefined) return false;
  if (typeof b === 'function') return !!b(id);
  if (typeof b.has === 'function') return !!b.has(id);
  return false;
}

// HeroBean plus NEAT's helpers. status: 0 idle, 1 mayor, 2 defending, 3
// marching, 4 captive, 5 returning, 8 farming (HeroConstants.as).
function hero(h, ctx) {
  const src = h || {};
  const out = pick(src, BEAN.hero);
  const st = num(src.status);
  const busy = heroBusy(ctx, src.id);
  const dom = Game.dominant(src);
  const eff = (k) => Math.round(num(src[k]) * (1 + num(src[k + 'BuffAdded']) / 100));
  Object.assign(out, {
    buffsArray: (src.buffs || []).map(buff),
    base: Game.heroBase(src),
    expLevels: heroExp.levelsFrom(src.level, src.experience, src.upgradeExp),
    isAttackHero: dom === 'power', isPoliticsHero: dom === 'management', isIntelHero: dom === 'stratagem',
    isIdle: st === 0, isMayor: st === 1, isDefending: st === 2, isMarching: st === 3 || st === 8,
    isCaptured: st === 4, isReturning: st === 5,
    isBusy: busy, isAvailable: !busy && (st === 0 || st === 1),
    isLoyal: num(src.loyalty) >= 100,
    powerWithBuffAdded: eff('power'), managementWithBuffAdded: eff('management'), stratagemWithBuffAdded: eff('stratagem'),
  });
  hide(out, 'toString', () => String(src.name === undefined ? '' : src.name));
  return out;
}

// Does any hero of this city that passes `test` match the hero string
// (goal-heroes.js grammar: a name, bob,fred, !bob, any:att>200, a|b)? best and
// worst are measured against the whole city.
function heroMatch(c, spec, test) {
  if (!c) return false;
  const pool = c.heros || [];
  const text = spec && typeof spec === 'object' ? String(spec.name || '') : String(spec == null ? '' : spec).trim();
  const parsed = H.parseHeroString(text);
  if (parsed.errors.length) throw new Error(`bad hero string "${text}": ${parsed.errors[0]}`);
  return pool.some((h) => test(h) && H.matchHero(h, parsed, pool));
}
const inCastle = (h) => num(h.status) === 0 || num(h.status) === 1;       // home and ours: idle or mayor

function findHero(c, name, ctx) {
  const key = lc(name && typeof name === 'object' ? name.name : name);
  const h = c && key ? (c.heros || []).find((x) => lc(x.name) === key) : null;
  return h ? hero(h, ctx) : null;
}

// ------------------------------------------------------------- the world

const gameOf = (ctx) => (ctx ? ctx.game : null) || null;
const idOf = (g, c) => (g && typeof g.castleId === 'function' ? g.castleId(c) : (c.castleId ?? c.id));
const nowOf = (g) => (g && typeof g.now === 'function' ? g.now() : Date.now());
const castlesOf = (ctx) => { const g = gameOf(ctx); return (g && g.castles) || []; };
function xyOf(g, c) {
  if (g && typeof g.castleXY === 'function') return g.castleXY(c);
  return c.fieldId !== undefined && c.fieldId !== null ? C.fieldIdToCoords(Number(c.fieldId)) : null;
}
function current(ctx) { try { return (ctx && ctx.castle) || null; } catch { return null; } }
const playerOf = (ctx) => { const g = gameOf(ctx); return (g && g.player) || {}; };
const listOf = (ctx, key) => playerOf(ctx)[key] || [];
const sameField = (a, b) => a !== undefined && a !== null && b !== undefined && b !== null && Number(a) === Number(b);
const raw = (a) => (a && a.raw) || a || {};

// Armies are account-wide lists (session.js keeps them whole from the pushes).
// A city's enemy and friendly armies are the ones aimed at its tile; its own
// are the ones that left from it.
const enemyOf = (ctx, c) => listOf(ctx, 'enemyArmys').filter((a) => sameField(raw(a).targetFieldId, c.fieldId));
const friendlyOf = (ctx, c) => listOf(ctx, 'friendArmys').filter((a) => sameField(raw(a).targetFieldId, c.fieldId));
const selfOf = (ctx, c) => listOf(ctx, 'selfArmys').filter((a) => sameField(raw(a).startFieldId, c.fieldId));

// Buffs arrive with the login only (CastleBuffUpdate/PlayerBuffUpdate are not
// kept yet), so one whose endTime has passed is dropped here.
function liveBuffs(g, list) {
  const now = nowOf(g);
  return (list || []).filter((b) => b && (!num(b.endTime) || num(b.endTime) > now));
}
// Exact typeId, any case: ForceopenclosegateBuff must not match its cooldown.
function findBuff(g, list, type) {
  const t = lc(type && typeof type === 'object' ? type.typeId : type);
  return t ? liveBuffs(g, list).find((b) => lc(b.typeId) === t) || null : null;
}
// MainFrame.as: the truce icon is any of the first three; DreamTruceBuff is a truce too.
const TRUCE_BUFFS = ['PlayerPeaceBuff', 'PlayerPeaceUniteServerBuff', 'TruceAgreementBuff', 'DreamTruceBuff'];

// Server reads, cached per connection for a few seconds, one in flight per key.
const CACHE = new WeakMap();
const TTL = { research: 15000, inn: 15000, troopq: 10000, prod: 60000 };
function cached(g, key, ttl, load) {
  if (!g) return Promise.reject(new Error('not connected to the game'));
  let m = CACHE.get(g);
  if (!m) CACHE.set(g, (m = new Map()));
  const hit = m.get(key);
  if (hit && hit.pending) return hit.pending;
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.data);
  const pending = Promise.resolve().then(load).then(
    (data) => { m.set(key, { at: Date.now(), data }); return data; },
    (e) => { m.delete(key); throw e; });
  m.set(key, { pending });
  return pending;
}
// For commands that change what a read shows (startresearch, hire, train...).
function forget(g, prefix = '') {
  const m = g && CACHE.get(g);
  if (!m) return;
  for (const k of [...m.keys()]) if (!prefix || k.startsWith(prefix)) m.delete(k);
}

async function researchBeans(ctx, c) {
  const g = gameOf(ctx);
  const cid = idOf(g, c);
  const r = await cached(g, `research:${cid}`, TTL.research, () => g.researchList(cid));
  return (r && (r.acailableResearchBeans || r.availableResearchBeans)) || [];     // sic, the server's spelling
}
async function techLevel(ctx, c, type) {
  const hit = (await researchBeans(ctx, c)).find((b) => num(b.typeId) === num(type));
  return hit ? num(hit.level) : 0;
}

async function troopParams(g, cid) {
  try { return await g.troopParams(cid); } catch {
    const m = num(g.marchSkillParam ?? 100);
    return { marchSkill: m, driveSkill: m, loadSkill: num(g.loadSkillParam), relief: 0 };
  }
}

// The city's goals as goals.js reads them, or null with no goal store (tests,
// a bare run). goals.js is loaded only here: it opens the database.
function cityGoals(ctx, c) {
  const s = ctx && ctx.session;
  const store = s && s.org && s.org.goals;
  if (!store || typeof store.own !== 'function') return null;
  try {
    const entry = store.own(s.account && s.account.id, idOf(gameOf(ctx), c), c.name, 'goal');
    if (!entry || !String(entry.src || '').trim()) return { goals: [], config: {}, errors: [], none: true };
    return require('./goals').parseGoals(entry.src);
  } catch { return { goals: [], config: {}, errors: [], failed: true }; }
}
function controlsOf(ctx, c) {
  const s = ctx && ctx.session;
  try { return s && typeof s.controls === 'function' ? s.controls(idOf(gameOf(ctx), c)) : null; } catch { return null; }
}

function trainingHeroName(ctx, c) {
  const parsed = cityGoals(ctx, c);
  const goal = parsed && (parsed.goals || []).find((x) => x.name === 'traininghero' && x.hero);
  return goal ? String(goal.hero) : '';
}

// ------------------------------------------------------------- the city

// NEAT's callScript (the callScript page): cities[x].cityManager.script.callScript(
// "lines") starts those lines (\n between them) as a run in that city and goes
// on. The console starts it — run() opts.runInCity(castleId, text) -> { ok } |
// { busy } | { error } — and refuses lines with errors. Not in the city the
// script runs in (NEAT: "it will not work"). -> null (NEAT's Dummy = ...).
async function callScriptIn(ctx, castleId, name, text) {
  const src = String(text == null ? '' : text).replace(/\\n/g, '\n');
  if (!src.trim()) throw new Error('callScript: no lines to run — callScript("echo \'bob\'")');
  const g = gameOf(ctx);
  const here = ctx && ctx.castle && g ? idOf(g, ctx.castle) : null;
  if (here !== null && String(here) === String(castleId)) {
    throw new Error(`callScript: ${name} is the city this script runs in — callScript starts lines in another city (write them here instead)`);
  }
  const start = ctx && ctx.opts && ctx.opts.runInCity;
  if (typeof start !== 'function') throw new Error('callScript: only the console can start a script in another city, and this run cannot');
  const r = await start(castleId, src);
  if (r && r.busy) throw new Error(`callScript: ${name} already has a script running — its lines were not started`);
  if (!r || r.error || r.ok === false) throw new Error(`callScript: ${(r && r.error) || 'the console did not start it'}`);
  return null;
}

// A frozen view of one city, found by castle id on every read so it follows
// reconnects (ctx.game is swapped) and every server push.
class CityView {
  #ctx; #id;
  constructor(ctx, id) { this.#ctx = ctx; this.#id = id; Object.freeze(this); }
  #g() { return gameOf(this.#ctx); }
  #c() {
    const g = this.#g();
    return (g && (g.castles || []).find((c) => idOf(g, c) === this.#id)) || null;
  }
  #with(fn, none) { const c = this.#c(); return c ? fn(c, this.#g(), this.#ctx) : none; }

  toString() { return this.#with((c, g) => { const xy = xyOf(g, c) || {}; return `${c.name} (${xy.x},${xy.y})`; }, ''); }

  // ---- who and where ----
  get cityManager() { return this; }
  get id() { return this.#id; }
  get name() { return this.#with((c) => c.name); }
  get fieldId() { return this.#with((c) => num(c.fieldId)); }
  get x() { return this.#with((c, g) => (xyOf(g, c) || {}).x); }
  get y() { return this.#with((c, g) => (xyOf(g, c) || {}).y); }
  get coords() { return this.#with((c, g) => { const xy = xyOf(g, c); return xy ? `${xy.x},${xy.y}` : null; }); }
  get cityCoords() { return this.coords; }
  get timeSlot() { const g = this.#g(); return g ? (g.castles || []).findIndex((c) => idOf(g, c) === this.#id) : -1; }
  get cityNameCoords() { return () => this.toString(); }
  // NEAT's callScript: cities[x].cityManager.script.callScript("lines")
  get script() { return Object.freeze({ callScript: (text) => callScriptIn(this.#ctx, this.#id, this.name, text) }); }
  // CastleBean with the client's *Array names.
  get castle() {
    return this.#with((c, g, ctx) => {
      const out = pick(c, BEAN.castle);
      out.resource = castleResource(c.resource);
      out.troop = troops(c.troop);
      out.fortification = fortifications(c.fortification);
      out.buffsArray = liveBuffs(g, c.buffs).map(buff);
      out.buffs = out.buffsArray;
      out.buildingQueuesArray = (c.buildingQueues || []).map(beanOf('buildingQueue'));
      out.buildingsArray = (c.buildings || []).map(building);
      out.fieldsArray = (c.fields || []).map(field);
      out.herosArray = (c.heros || []).map((h) => hero(h, ctx));
      out.tradesArray = (c.trades || []).map(trade);
      out.transingTradesArray = (c.transingTrades || []).map(transingTrade);
      return out;
    });
  }

  // ---- resources ----
  get resource() { return this.#with((c) => castleResource(c.resource)); }
  // OTTObot keeps the last pushed amounts; it does not extrapolate between pushes.
  get estResource() { return this.#with((c) => resources(c.resource)); }
  get resetEstResource() { return () => this.estResource; }
  // hasResource(res): the city holds at least these (a resource bean or a
  // string) — CreateFunction's `every` example: city.cityManager.hasResource(limit)
  get hasResource() {
    return (want) => this.#with((c) => {
      const need = typeof want === 'string' ? getResources(want) : want && typeof want === 'object' ? resources(want) : null;
      if (!need) throw new Error('hasResource wants resources, e.g. hasResource(GetResources("f:1m,g:500k"))');
      const have = resources(c.resource);
      return RES_KEYS.every((k) => num(have[k]) >= num(need[k]));
    });
  }
  // DERIVED from NEAT's definition: a day of troop upkeep (food), a day of hero
  // salary (gold), plus one disaster relief while there is any grievance.
  get reservedResource() {
    return this.#with((c) => {
      const r = c.resource || {};
      const relief = num(r.complaint) > 0 ? (this.comfortingNeeds(1) || {}).food || 0 : 0;
      return resources({ food: num(r.troopCostFood) * 24 + relief, gold: num(r.herosSalary) * 24 });
    });
  }
  // The Town Hall's labour %, interior.getResourceProduceData.
  get ResourceProduction() {
    return this.#with(async (c, g) => {
      const cid = idOf(g, c);
      const d = await cached(g, `prod:${cid}`, TTL.prod, () => g.productionData(cid));
      const KIND = { 1: 'food', 2: 'wood', 3: 'stone', 4: 'iron' };            // ResourceProduction.as typeid
      const out = { food: 0, wood: 0, stone: 0, iron: 0 };
      for (const b of (d && d.resourceProduceDataBean) || []) if (KIND[num(b.typeid)]) out[KIND[num(b.typeid)]] = num(b.commenceRate);
      hide(out, 'toString', () => `food ${out.food}% wood ${out.wood}% stone ${out.stone}% iron ${out.iron}%`);
      return out;
    });
  }
  // What reaches this city within `sec` (all of it with no argument): market
  // purchases in transit, transports and reinforcements aimed here (ours and
  // allies'), and our attacks coming home with loot.
  get incomingResources() {
    return (sec) => this.#with((c, g, ctx) => {
      const now = nowOf(g);
      const until = sec === undefined || sec === null || sec === '' ? Infinity : now + num(sec) * 1000;
      const out = { food: 0, wood: 0, stone: 0, iron: 0, gold: 0 };
      const TR = { 0: 'food', 1: 'wood', 2: 'stone', 3: 'iron' };               // TradeConstants resType
      for (const t of c.transingTrades || []) {
        const k = TR[num(t.resType)];
        if (k && num(t.endTime) <= until) out[k] += num(t.amount);
      }
      const take = (a) => { if (num(a.reachTime) <= until) for (const k of RES_KEYS) out[k] += num((a.resource || {})[k]); };
      for (const a of [...listOf(ctx, 'selfArmys'), ...listOf(ctx, 'friendArmys')].map(raw)) {
        const going = num(a.direction) === 1 && sameField(a.targetFieldId, c.fieldId)
          && (num(a.missionType) === C.MISSION.transport || num(a.missionType) === C.MISSION.reinforce);
        const loot = num(a.direction) === 2 && sameField(a.startFieldId, c.fieldId) && num(a.missionType) === C.MISSION.attack;
        if (going || loot) take(a);
      }
      const bean = resources(out);
      bean.total = RES_KEYS.reduce((s, k) => s + bean[k], 0);
      return bean;
    });
  }

  // ---- troops ----
  get troop() { return this.#with((c) => troops(c.troop)); }
  get troops() { return this.troop; }
  // Everything the city owns: at home, plus (unless inCityOnly) out on its marches.
  get getAvailableTroop() {
    return (inCityOnly) => this.#with((c, g, ctx) => {
      const bean = troops(c.troop);
      if (!inCityOnly) for (const a of selfOf(ctx, c)) addTroopsInto(bean, troops(raw(a).troop || raw(a).troops || {}));
      return bean;
    });
  }
  // What the barracks still have queued, troop.getProduceQueue.
  get troopStillInProduction() {
    return this.#with(async (c, g) => {
      const cid = idOf(g, c);
      const d = await cached(g, `troopq:${cid}`, TTL.troopq, () => g.troopQueue(cid));
      const byType = Object.fromEntries(C.TROOPS.map((t) => [t.typeId, t.key]));
      const counts = {};
      for (const b of (d && d.allProduceQueue) || []) {
        for (const p of b.allProduceQueue || []) { const k = byType[num(p.type)]; if (k) counts[k] = (counts[k] || 0) + num(p.num); }
      }
      return callableTroops(troops(counts));
    });
  }
  // NewArmyWin.as:2853: load x count x (1 + Logistics/100), at distance 0.
  get getCarryingLoad() {
    return (t) => this.#with(async (c, g) => {
      const bean = getTroops(t) || troops({});
      const p = await troopParams(g, idOf(g, c));
      return Math.floor(TROOP_KEYS.reduce((s, k) => s + C.BY_KEY[k].load * num(bean[k]) * (1 + num(p.loadSkill) / 100), 0));
    });
  }
  // Seconds from one tile to another (field ids, "x,y" or beans) for these
  // troops, the client's formula with this city's skills and buffs. type 1 or
  // 2 (transport, reinforce) gets the Relief Station, as NEAT's type 2 does.
  get getTravelTime() {
    return (from, to, t, type) => this.#with(async (c, g) => {
      const a = coordsOf(from), b = coordsOf(to);
      if (!a || !b) throw new Error('getTravelTime wants two field ids or x,y coordinates');
      const bean = getTroops(t);
      if (!bean) throw new Error('getTravelTime wants troops, e.g. GetTroops("a:1000")');
      const keys = TROOP_KEYS.filter((k) => num(bean[k]) > 0);
      const p = await troopParams(g, idOf(g, c));
      const relief = num(type) === C.MISSION.transport || num(type) === C.MISSION.reinforce ? p.relief : 0;
      const ms = C.marchTimeMs(a, b, keys, {
        marchSkill: p.marchSkill, driveSkill: p.driveSkill, relief,
        castleBuffs: c.buffs, playerBuffs: playerOf(this.#ctx).buffs, now: nowOf(g),
      });
      return ms === null ? null : Math.round(ms / 1000);
    });
  }

  // ---- fortifications ----
  get fortification() { return this.#with((c) => fortifications(c.fortification)); }
  // What the city's current fortification goal stage wants (zeros without one).
  get fortificationsRequirement() {
    return this.#with((c, g, ctx) => {
      const parsed = cityGoals(ctx, c);
      const stages = ((parsed && parsed.goals) || []).filter((x) => x.name === 'fortification' && x.forts);
      const have = fortifications(c.fortification);
      const code = Object.fromEntries(C.WALLS.map((w) => [w.code, w.beanKey]));
      const want = (st) => Object.fromEntries(Object.entries(st.forts).map(([k, v]) => [code[k] || k, num(v)]));
      const stage = stages.find((st) => Object.entries(want(st)).some(([k, v]) => v > num(have[k]))) || stages[stages.length - 1];
      return fortifications(stage ? want(stage) : {});
    });
  }
  get fortificationRequirement() { return this.fortificationsRequirement; }
  // What the walls still have queued, fortifications.getProduceQueue.
  get fortificationProduceQueue() {
    return this.#with(async (c, g) => {
      const cid = idOf(g, c);
      const d = await cached(g, `wallq:${cid}`, TTL.troopq, () => g.wallQueue(cid));
      const counts = {};
      for (const b of (d && d.allProduceQueue) || []) {
        for (const p of b.allProduceQueue || []) { const w = C.WALL_BY_TYPE[num(p.type)]; if (w) counts[w.beanKey] = (counts[w.beanKey] || 0) + num(p.num); }
      }
      return fortifications(counts);
    });
  }

  // ---- buildings (BuildingTypes ids; Town Hall 31 sits at position -1) ----
  get buildings() { return this.#with((c) => (c.buildings || []).map(building), []); }
  #standing(c) { return (c.buildings || []).filter((b) => !(num(b.status) === 0 && num(b.level) === 0)); }
  #best(c, type) {
    return this.#standing(c).filter((b) => num(b.typeId) === num(type)).sort((a, b) => num(b.level) - num(a.level))[0] || null;
  }
  get getBuildingByTypeId() { return (t) => this.#with((c) => { const b = this.#best(c, t); return b ? building(b) : null; }, null); }
  get getBuildingLevel() { return (t) => this.#with((c) => num((this.#best(c, t) || {}).level), 0); }
  get getBuildingByPosId() {
    return (pos) => this.#with((c) => { const b = (c.buildings || []).find((x) => num(x.positionId) === num(pos)); return b ? building(b) : null; }, null);
  }
  get countBuilding() {
    return (t, min = 1, max = 10) => this.#with((c) => this.#standing(c)
      .filter((b) => num(b.typeId) === num(t) && num(b.level) >= num(min) && num(b.level) <= num(max)).length, 0);
  }
  get hasBuilding() {
    return (t, min = 1) => this.#with((c) => this.#standing(c).some((b) => num(b.typeId) === num(t) && num(b.level) >= num(min)), false);
  }
  get getTownHallLevel() { return () => this.getBuildingLevel(C.TOWN_HALL); }
  get getWallLevel() { return () => this.getBuildingLevel(C.WALLS_TYPE); }
  get getActiveBuilding() {
    return () => this.#with((c) => { const b = this.#standing(c).find((x) => num(x.status) === 1 || num(x.status) === 2); return b ? building(b) : null; }, null);
  }
  // Free plots a building of this type could go on (inside or outside the walls).
  get getEmptyPositions() {
    return (t) => this.#with((c) => {
      const def = C.BUILDING_BY_ID[num(t)];
      if (!def || num(t) === C.TOWN_HALL || num(t) === C.WALLS_TYPE) return [];
      const { used, townHall } = Game.plotsInUse(c);
      const { from, to } = C.plotRange(!!def.outside, townHall);
      const out = [];
      for (let p = from; p <= to; p++) if (!used.has(p)) out.push(p);
      return out;
    }, []);
  }
  // A free rally slot, after keeping one back for the training hero and `extra` more.
  get rallySpotAvailable() {
    return (reserve, extra) => this.#with((c, g, ctx) => {
      const cap = R.rallyCapacity(c);
      if (cap === null) return false;
      return cap - selfOf(ctx, c).length - (reserve ? 1 : 0) - num(extra) > 0;
    }, false);
  }

  // ---- research (ResearchTypes ids) ----
  // Indexed by type id, as NEAT's researches[x] is; ids 0 and 6 are holes.
  get researches() {
    return this.#with(async (c, g, ctx) => {
      const out = [];
      for (const b of await researchBeans(ctx, c)) out[num(b.typeId)] = research(b);
      for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = null;
      return out;
    });
  }
  get getTechLevel() { return (t) => this.#with((c, g, ctx) => techLevel(ctx, c, t)); }
  get GetTechLevel() { return this.getTechLevel; }
  get hasTech() { return (t, level) => this.#with(async (c, g, ctx) => (await techLevel(ctx, c, t)) >= num(level)); }
  get getActiveResearch() {
    return () => this.#with(async (c, g, ctx) => { const b = (await researchBeans(ctx, c)).find((x) => x.upgradeing); return b ? research(b) : null; });
  }
  get is_researching() { return this.#with(async (c, g, ctx) => (await researchBeans(ctx, c)).some((x) => !!x.upgradeing)); }

  // ---- heroes ----
  get heroes() { return this.#with((c, g, ctx) => (c.heros || []).map((h) => hero(h, ctx)), []); }
  get innHeroes() {
    return this.#with(async (c, g, ctx) => {
      const cid = idOf(g, c);
      const d = await cached(g, `inn:${cid}`, TTL.inn, () => g.tavernList(cid));
      return ((d && (d.heros || d.herosArray)) || []).map((h) => hero(h, ctx));
    });
  }
  get innheroes() { return this.innHeroes; }
  get findHeroByName() { return rawArgs((n) => this.#with((c, g, ctx) => findHero(c, n, ctx), null)); }
  get heros() { return this.findHeroByName; }
  get getMayor() {
    return () => this.#with((c, g, ctx) => { const h = (c.heros || []).find((x) => num(x.status) === 1); return h ? hero(h, ctx) : null; }, null);
  }
  // Home and ours: idle or mayor. A prisoner we hold (status 4) is not "in the castle".
  get IsHeroInCastle() { return rawArgs((s) => this.#with((c) => heroMatch(c, s, inCastle), false)); }
  get AnyIdleHero() {
    return rawArgs((s) => this.#with((c, g, ctx) => heroMatch(c, s, (h) => num(h.status) === 0 && !heroBusy(ctx, h.id)), false));
  }
  get trainingHeroName() { return this.#with((c, g, ctx) => trainingHeroName(ctx, c), ''); }
  get TrainingHeroIsHere() {
    return this.#with((c, g, ctx) => {
      const name = lc(trainingHeroName(ctx, c));
      return !!name && (c.heros || []).some((h) => lc(h.name) === name && inCastle(h));
    }, false);
  }
  // A free Feasting Hall slot, keeping one for the training hero when it is
  // elsewhere. Capacity is INFERRED as one slot per hall level (goal-heroes.js).
  get checkFeastingHallSpace() {
    return this.#with((c, g, ctx) => {
      const cap = H.feastingHall({ castle: c, config: {} }).capacity;
      if (cap === null) return false;
      const name = lc(trainingHeroName(ctx, c));
      const away = !!name && !(c.heros || []).some((h) => lc(h.name) === name);
      return cap - (c.heros || []).length - (away ? 1 : 0) > 0;
    }, false);
  }

  // ---- armies ----
  get enemyArmies() { return this.#with((c, g, ctx) => enemyOf(ctx, c).map(army), []); }
  get friendlyArmies() { return this.#with((c, g, ctx) => friendlyOf(ctx, c).map(army), []); }
  get selfArmies() { return this.#with((c, g, ctx) => selfOf(ctx, c).map(army), []); }
  get myArmies() { return this.selfArmies; }
  get hasEnemyArmies() { return this.#with((c, g, ctx) => enemyOf(ctx, c).length > 0, false); }
  // blind = true also counts an army whose arrival time the beacon cannot show.
  get hasEnemyArmiesWithin() {
    return (sec, blind) => this.#with((c, g, ctx) => {
      const now = nowOf(g);
      return enemyOf(ctx, c).map(raw).some((a) => (num(a.reachTime) ? num(a.reachTime) - now <= num(sec) * 1000 : !!blind));
    }, false);
  }
  // Attacks at or above defensepolicy /junktroop (1000 by default). An
  // unscouted one counts: its size is unknown, not small.
  get NumberOfRealAttacks() {
    return this.#with((c, g, ctx) => {
      const parsed = cityGoals(ctx, c);
      const dp = parsed && (parsed.goals || []).find((x) => x.name === 'defensepolicy');
      const junk = dp && dp.switches && num(dp.switches.junktroop) > 0 ? num(dp.switches.junktroop) : 1000;
      return enemyOf(ctx, c).map(raw).filter((a) => {
        if (num(a.missionType) !== C.MISSION.attack || num(a.direction) === 2) return false;
        const vals = Object.values(a.troop || a.troops || {});
        return vals.some(isUnknown) || vals.reduce((s, v) => s + num(v), 0) >= junk;
      }).length;
    }, 0);
  }

  // ---- valleys, market, buffs ----
  get fields() { return this.#with((c) => (c.fields || []).map(field), []); }
  get tradesArray() { return this.#with((c) => (c.trades || []).map(trade), []); }
  get transingTradesArray() { return this.#with((c) => (c.transingTrades || []).map(transingTrade), []); }
  // Market.txt city.buyPrice(2), References cityManager.sellPrice(food): script-cmd-market.js.
  get buyPrice() { return marketOf(this.#ctx).buyPrice; }
  get sellPrice() { return marketOf(this.#ctx).sellPrice; }
  get buffs() { return this.#with((c, g) => liveBuffs(g, c.buffs).map(buff), []); }
  get hasBuff() { return rawArgs((t) => this.#with((c, g) => !!findBuff(g, c.buffs, t), false)); }
  get buff() { return rawArgs((t) => this.#with((c, g) => { const b = findBuff(g, c.buffs, t); return b ? buff(b) : null; }, null)); }
  // MonitorCity's own test for broken gates.
  get brokenGates() { return this.#with((c, g) => !!findBuff(g, c.buffs, 'ForceopenclosegateBuff'), false); }

  // ---- comforting (PacifyPeopleView.as) ----
  // The multiplier the client puts on relief and prayer costs.
  get PRFactor() { return this.#with((c) => num(c.usePACIFY_SUCCOUR_OR_PACIFY_PRAY)); }
  // 1 relief, 2 prayer: prestige/10 x cities x PRFactor, capped at 10m food.
  // 3 sacrifice: max population in food and 10% of it in gold. 4 raise population: 5 x max population in food.
  get comfortingNeeds() {
    return (type) => this.#with((c, g, ctx) => {
      const info = playerOf(ctx).playerInfo || {};
      const maxPop = num((c.resource || {}).maxPopulation);
      let food = 0, gold = 0;
      const n = num(type);
      if (n === 1 || n === 2) {
        const cities = num(info.castleCount) || castlesOf(ctx).length;
        food = Math.trunc(Math.min(num(info.prestige) / 10 * cities * num(c.usePACIFY_SUCCOUR_OR_PACIFY_PRAY), 10000000));
      } else if (n === 3) { food = maxPop; gold = Math.ceil(maxPop * 0.1); }
      else if (n === 4) food = maxPop * 5;
      else return null;
      return { typeId: n, needAmount: food, food, gold };
    }, null);
  }

  // ---- goals and controls ----
  // A config value from the city's goals (0 when unset). The console's War Town
  // control wins over config wartown, as it does for the engine. Script config
  // lines are not seen here yet.
  get getConfig() {
    return (key) => this.#with((c, g, ctx) => {
      const k = lc(key);
      if (k === 'wartown') {
        const ctl = controlsOf(ctx, c);
        if (ctl && ctl.wartown !== undefined && ctl.wartown !== null && ctl.wartown !== 'auto') return num(ctl.wartown);
      }
      const parsed = cityGoals(ctx, c);
      const v = parsed && parsed.config ? parsed.config[k] : undefined;
      return v === undefined ? 0 : v;
    }, 0);
  }
  // True when the goals could not be read, or there are none at all.
  get cityHasGoalErrors() {
    return this.#with((c, g, ctx) => {
      const p = cityGoals(ctx, c);
      if (!p) return false;
      return !!(p.failed || p.none || (!(p.goals || []).length && !Object.keys(p.config || {}).length));
    }, false);
  }
  get CityHasGoalErrors() { return this.cityHasGoalErrors; }
  // 0 auto, 1 open, 2 closed: the console's Gate Control.
  get GateControl() {
    return this.#with((c, g, ctx) => ({ open: 1, closed: 2 }[(controlsOf(ctx, c) || {}).gate] || 0), 0);
  }

  // ---- map ----
  // A plain sync comparator for .sort(): nearer to this city first. Takes
  // field ids, "x,y" strings or beans with x/y or an id.
  get compareByDistanceToCastle() {
    return (a, b) => {
      const home = this.#with((c, g) => xyOf(g, c), null);
      const d = (v) => { const xy = coordsOf(v); return home && xy ? C.mapDistance(home, xy) : Infinity; };
      const da = d(a), db = d(b);
      return da === db ? 0 : da - db;
    };
  }

  // ---- named timers (script-functions.js keeps them) ----
  get setCityTimer() { return (key) => { const t = cityTimers(); return t ? t.set(this.#id, key) : undefined; }; }
  get cityTimingAllowed() {
    return (key, sec, test = false) => { const t = cityTimers(); return t ? t.allowed(this.#id, key, sec, test) : true; };
  }
}
Object.freeze(CityView.prototype);

function cityTimers() {
  try { const F = require('./script-functions'); return F.cityTimers || null; } catch { return null; }
}

// Prices, marketReady and the TradeBean names belong to script-cmd-market.js.
// It is required when asked for, so a failed load (a file mid-edit) is tried
// again on the next read; without it prices are NaN and the market never ready.
const NO_MARKET = {
  buyPrice: rawArgs(() => NaN), sellPrice: rawArgs(() => NaN), price: () => NaN, marketReady: () => false,
};
function marketModule() { try { return require('./script-cmd-market'); } catch { return null; } }
function marketOf(ctx) {
  const M = marketModule();
  let m = null;
  try { m = M && typeof M.market === 'function' ? M.market(ctx) : null; } catch { m = null; }
  return m || NO_MARKET;
}
// TradeBean / TransingTradeBean with the names a push may leave out, or a plain copy.
function tradeCopy(kind, t) {
  const M = marketModule();
  if (M && typeof M[kind] === 'function') { try { return M[kind](t); } catch { /* a plain copy below */ } }
  return pick(t, kind === 'tradeBean' ? BEAN.trade : BEAN.transingTrade);
}
const trade = (t) => tradeCopy('tradeBean', t);
const transingTrade = (t) => tradeCopy('transingTradeBean', t);

const cityView = (castle, ctx) => (castle ? new CityView(ctx, idOf(gameOf(ctx), castle)) : null);

// -------------------------------------------------------------- the player

// PlayerInfoBean from its allowlist: no accountName, which is a login e-mail a
// shared script could whisper to anyone. Friends and blocked players are
// PlayerInfoBeans too.
const playerInfo = beanOf('playerInfo');

// PlayerBean, with the client's *Array names. The friend and block lists are
// kept current by script-cmd-social.js from the server's FriendResponse.
function playerBean(ctx) {
  const g = gameOf(ctx);
  if (!g || !g.player) return undefined;
  const p = g.player;
  const out = pick(p, BEAN.player);
  out.playerInfo = playerInfo(p.playerInfo || {});
  out.castleSignBeanArray = (p.castleSignBean || p.castleSignBeans || []).map(beanOf('castleSign'));
  out.friendBeansArray = (p.friendBeans || []).map(playerInfo);
  out.blockBeansArray = (p.blockBeans || []).map(playerInfo);
  out.buffsArray = liveBuffs(g, p.buffs).map(buff);
  out.itemsArray = (p.items || []).map((it) => item(it));
  out.selfArmysArray = (p.selfArmys || []).map(army);
  out.enemyArmysArray = (p.enemyArmys || []).map(army);
  out.friendArmysArray = (p.friendArmys || []).map(army);
  hide(out, 'toString', () => String(out.playerInfo.userName || ''));
  return out;
}

// ----------------------------------------------------------------- items

function catalogue() { try { return require('./items').catalogue(); } catch { return new Map(); } }
function itemIdOf(ref) {
  const key = lc(ref);
  if (!key) return null;
  for (const [id, d] of catalogue()) if (lc(id) === key || lc(d && d.name) === key) return id;
  return null;
}
function heldItem(ctx, ref) {
  const items = playerOf(ctx).items || [];
  const key = lc(ref && typeof ref === 'object' ? ref.id : ref);
  if (!key) return null;
  const hit = items.find((i) => lc(i.id) === key);
  if (hit) return hit;
  const id = itemIdOf(key);
  return id ? items.find((i) => String(i.id) === id) || null : null;
}
const itemCount = (ctx, ref) => { const it = heldItem(ctx, ref); return it ? num(it.count) : 0; };
// ItemBean for an id or name: the count held, 0 for a known item not held, null for no such item.
function getItem(ctx, ref) {
  const it = heldItem(ctx, ref);
  const id = it ? String(it.id) : itemIdOf(ref && typeof ref === 'object' ? ref.id : ref);
  if (!id) return null;
  const d = catalogue().get(id) || {};
  return item(it || { id, count: 0 }, d.name || (it && it.name) || id);
}

// -------------------------------------------------------------- m_context

const serverDate = (g) => new Date(nowOf(g) + num(g && g.serverTzOffsetMs));   // read with getUTC*

class ContextView {
  #ctx;
  constructor(ctx) { this.#ctx = ctx; Object.freeze(this); }
  #buffs() { return playerOf(this.#ctx).buffs; }
  get truced() { const g = gameOf(this.#ctx); return TRUCE_BUFFS.some((t) => !!findBuff(g, this.#buffs(), t)); }
  get inTruceCooldown() { return !!findBuff(gameOf(this.#ctx), this.#buffs(), 'PlayerPeaceCoolDownBuff'); }
  get hasBuff() { return rawArgs((t) => !!findBuff(gameOf(this.#ctx), this.#buffs(), t)); }
  get buff() { return rawArgs((t) => { const b = findBuff(gameOf(this.#ctx), this.#buffs(), t); return b ? buff(b) : null; }); }
  get buffs() { return liveBuffs(gameOf(this.#ctx), this.#buffs()).map(buff); }
  get ItemCount() { return (id) => itemCount(this.#ctx, id); }
  get GetItem() { return (id) => getItem(this.#ctx, id); }
  // script-cmd-market.js: false after a (re)login until all four books are read.
  // Function values, so NEAT's `ask = m_context.buyPrice; ask(0)` works.
  get marketReady() { return marketOf(this.#ctx).marketReady; }
  get buyPrice() { return marketOf(this.#ctx).buyPrice; }
  get sellPrice() { return marketOf(this.#ctx).sellPrice; }
  get findFirstCity() { return () => cityView(castlesOf(this.#ctx)[0], this.#ctx); }
  // The server's own wall clock, in its timezone (measured at login).
  get serverHours() { return serverDate(gameOf(this.#ctx)).getUTCHours(); }
  get serverMinutes() { return serverDate(gameOf(this.#ctx)).getUTCMinutes(); }
  get serverSeconds() { return serverDate(gameOf(this.#ctx)).getUTCSeconds(); }
  get serverYear() { return serverDate(gameOf(this.#ctx)).getUTCFullYear(); }
  get serverMonth() { return serverDate(gameOf(this.#ctx)).getUTCMonth(); }       // 0-11, as date().getMonth()
  get serverDate() { return serverDate(gameOf(this.#ctx)).getUTCDate(); }
  // When announced maintenance starts (ms since 1970), 0 when none is pending.
  get maintenanceStart() {
    const s = this.#ctx && this.#ctx.session;
    const plan = s && s.maint && s.maint.plan;
    if (!plan || plan.source === 'logout' || !(Date.now() < num(plan.resumeAt))) return 0;
    return num(plan.startsAt);
  }
  get Player() { return playerBean(this.#ctx); }
  toString() { return '[m_context]'; }
}
Object.freeze(ContextView.prototype);

// ----------------------------------------------------------------- Screen

const RING = 400;      // session.js keeps chat and reports this long
const hms = (t) => new Date(num(t)).toTimeString().slice(0, 8);
const CHAT = { aChat: 'alliance', pChat: 'private', wChat: 'world', sChat: 'system' };
const plain = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, '');

function screenLines(ctx, tab) {
  const s = ctx && ctx.session;
  if (!s) return [];
  if (CHAT[tab]) return ((s.chat && s.chat[CHAT[tab]]) || []).map((x) => `${hms(x.t)} ${x.from ? x.from + ': ' : ''}${x.msg}`);
  if (tab === 'reportLog') return (s.reports || []).map((l) => `${hms(l.t)} ${l.m}`);
  if (tab === 'cityLog') {
    const c = current(ctx);
    return (s.log || []).filter((l) => c && l.city === c.name).map((l) => `${hms(l.t)} ${l.m}`);
  }
  return (s.acts || []).map((l) => `${hms(l.t)} ${l.city ? `(${l.city}) ` : ''}${l.m}`);
}

// Adds a line to that tab on this console only; nothing is sent to the game.
function addEvent(ctx, tab, text) {
  const s = ctx && ctx.session;
  const msg = plain(text);
  if (!s) { if (ctx && typeof ctx.log === 'function') ctx.log(msg); return; }
  const c = current(ctx);
  const ring = (list, entry) => { list.push(entry); if (list.length > RING) list.shift(); };
  if (CHAT[tab] && s.chat && s.chat[CHAT[tab]]) ring(s.chat[CHAT[tab]], { t: Date.now(), from: 'script', msg });
  else if (tab === 'reportLog' && Array.isArray(s.reports)) ring(s.reports, { t: Date.now(), m: msg, city: c ? c.name : null, kind: 'report' });
  else if (typeof s.note === 'function') s.note(msg, { city: c ? c.name : null, kind: 'act' });
}

function screenTab(ctx, tab) {
  const out = {};
  Object.defineProperty(out, 'buffer', { get: () => screenLines(ctx, tab).join('\n'), enumerable: true });
  hide(out, 'addEvent', (text) => { addEvent(ctx, tab, text); });
  hide(out, 'toString', () => screenLines(ctx, tab).join('\n'));
  return Object.freeze(out);
}

// No beginners chat (it lands in world) and no command log: bChat and
// commandLog are left out.
class ScreenView {
  #ctx;
  constructor(ctx) { this.#ctx = ctx; Object.freeze(this); }
  get mainLog() { return screenTab(this.#ctx, 'mainLog'); }
  get mainlog() { return this.mainLog; }
  get cityLog() { return screenTab(this.#ctx, 'cityLog'); }
  get reportLog() { return screenTab(this.#ctx, 'reportLog'); }
  get aChat() { return screenTab(this.#ctx, 'aChat'); }
  get pChat() { return screenTab(this.#ctx, 'pChat'); }
  get wChat() { return screenTab(this.#ctx, 'wChat'); }
  get sChat() { return screenTab(this.#ctx, 'sChat'); }
  toString() { return '[Screen]'; }
}
Object.freeze(ScreenView.prototype);

// ----------------------------------------------------------------- Config

// NEAT's Config.sol, without the login: the server, the proxy label and any
// parameters the run was given as opts.config. A key never given is
// undefined, so `if Config.teleport == null` works.
function configBean(ctx) {
  const s = ctx && ctx.session;
  const g = gameOf(ctx);
  const out = {};
  const given = ctx && ctx.opts && ctx.opts.config;
  if (given && typeof given === 'object') {
    for (const [k, v] of Object.entries(scalars(given))) if (!/pass|secret|token/i.test(k)) out[k] = v;
  }
  if (s && s.account && s.account.server) out.server = s.account.server;
  if (g && g.proxy && g.proxy.label) out.proxy = g.proxy.label;
  return out;
}

// ----------------------------------------------------------------- Settings

// NEAT's global settings from a script (AutoRunScript page):
// Settings.autoUseItems(useAll, fivePerDay) sets the items NEAT uses by itself.
// Nothing in OTTObot uses items unasked, so the call says how to do it instead
// of failing as "Settings is undefined".
const SETTINGS = Object.freeze({
  autoUseItems() {
    throw new Error('Settings.autoUseItems: OTTObot keeps no list of items to use by itself — use them from the script: '
      + 'useitem <item>, then repeat <count> (ItemCount(item) says how many are held)');
  },
  toString() { return '[Settings]'; },
});

// ---------------------------------------------------------------- globals

function globals(ctx) {
  const out = {};
  const get = (name, fn) => Object.defineProperty(out, name, { get: fn, enumerable: true });
  const fn = (name, f) => Object.defineProperty(out, name, { value: f, enumerable: true });
  const here = () => cityView(current(ctx), ctx);

  get('city', here);
  get('m_city', here);
  get('cities', () => castlesOf(ctx).map((c) => cityView(c, ctx)));
  get('player', () => playerBean(ctx));
  get('m_context', () => new ContextView(ctx));
  get('Screen', () => new ScreenView(ctx));
  get('Config', () => configBean(ctx));
  get('Settings', () => SETTINGS);
  get('is_researching', () => { const c = here(); return c ? c.is_researching : false; });

  // GetResources is script-functions.js's (it builds beans.resources).
  fn('GetTroops', (s) => getTroops(s));
  fn('TroopBeanToString', (bean, sep) => troopString(troops(bean), sep));
  fn('GetFortifications', (s) => getFortifications(s));
  fn('ItemCount', (id) => itemCount(ctx, id));
  fn('GetItem', (id) => getItem(ctx, id));
  fn('IsHeroInCastle', rawArgs((s) => heroMatch(current(ctx), s, inCastle)));
  fn('AnyIdleHero', rawArgs((s) => heroMatch(current(ctx), s, (h) => num(h.status) === 0 && !heroBusy(ctx, h.id))));
  fn('GetTechLevel', (t) => { const c = current(ctx); return c ? techLevel(ctx, c, t) : 0; });
  fn('HeroLevel', (level, exp) => num(level) + heroExp.levelsFrom(level, exp));
  fn('HeroExperience', (end, start, exp) => heroExp.expBetween(end, start === undefined ? 1 : start, exp));
  return out;
}

const beans = {
  troops, resources, fortifications, hero, army, field, building, buff, research, item,
  city: cityView, castleResource, player: playerBean,
};

module.exports = {
  globals, beans, heroExp, forget,
  // the names script-functions.js asked for
  troopBean: troops, fortBean: fortifications, resourceBean: resources,
  troopString, resourceString, getTroops, getResources, getFortifications,
  CityView, TROOP_KEYS, FORT_KEYS, RES_KEYS,
};
