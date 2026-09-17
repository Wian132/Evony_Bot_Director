'use strict';
// script-functions.js offline: NEAT's global functions and constants against
// the wiki's own examples. The map runs on a fake cache (never db.js) and a
// fake session block store; the game is a real Game whose req() is stubbed.
process.env.TZ = 'America/New_York';   // the wiki's date() output is EST/EDT

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Only the last section opens db.js, and then on a scratch file.
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-sf-')), 't.db');
const C = require('./constants');
const { Game } = require('./game');
const F = require('./script-functions');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b)), `${msg || ''} ${a} != ${b}`);
const FID = (x, y) => C.coordsToFieldId(x, y);
const MIN = 60000;

// ---------------------------------------------------------------- fake world

// The saved map cache: rows shaped like map_cache.json. The fake hands out its
// own row objects, so a function that leaked them would let a test see it.
const T0 = Date.now() - 10 * MIN;
const row = (x, y, o) => ({ id: FID(x, y), x, y, seen: T0, state: 1, furlough: false, npc: false, prestige: 0, honor: 0, ...o });
const ROWS = [
  row(460, 355, { name: 'MyCity', userName: 'YayMe', allianceName: '123456', prestige: 14517826, kind: 'player', mine: true }),
  row(455, 353, { name: 'B1', userName: 'Bob', allianceName: null, prestige: 4991, kind: 'player' }),
  row(457, 353, { name: 'F1', userName: 'Fred', allianceName: null, prestige: 8060, kind: 'player' }),
  row(459, 357, { name: 'G1', userName: 'George', allianceName: 'Pals', prestige: 10847, kind: 'player' }),
  row(457, 358, { name: 'G2', userName: 'George', allianceName: 'Pals', prestige: 10847, kind: 'player' }),
  row(464, 360, { name: 'H1', userName: 'Harry', allianceName: 'Meh', prestige: 0, kind: 'player', state: 2 }),
  row(456, 356, { name: "Barbarian's city", npc: true, level: 5, kind: 'npc' }),
  row(470, 355, { name: "Barbarian's city", npc: true, level: 10, kind: 'npc' }),
  row(480, 360, { name: 'Lair', userName: 'Evil', allianceName: 'Doom', prestige: 99, kind: 'player' }),
  row(300, 300, { name: 'Den', userName: 'Hated', allianceName: 'Doom', prestige: 5, kind: 'player' }),
  row(461, 356, { kind: 'flat', typeName: 'Flat', type: 10, level: 3 }),
  row(463, 350, { kind: 'flat', typeName: 'Flat', type: 10, level: 10 }),
  row(440, 355, { kind: 'flat', typeName: 'Flat', type: 10, level: 7 }),   // 20 away: outside radius 5
];
const cache = {
  calls: 0,
  tiles(x1, y1, x2, y2, { castles = false } = {}) {
    this.calls++;
    return ROWS.filter((r) => r.x >= x1 && r.x <= x2 && r.y >= y1 && r.y <= y2 && (!castles || r.userName || r.npc));
  },
};
F.setMapCache(cache);

// The session's live blocks: one 20x20 block, decoded the way Session.mapBlockTiles does.
function block(x1, y1, set, castles) {
  const tiles = [];
  for (let y = y1; y < y1 + 20; y++) for (let x = x1; x < x1 + 20; x++) tiles.push(set[`${x},${y}`] || '51');   // grassland 1
  return { x1, y1, x2: x1 + 19, y2: y1 + 19, mapStr: tiles.join(''), castles, at: Date.now() };
}
function fakeSession(blocks, extra = {}) {
  const store = { blocks: new Map(blocks.map((b) => [b.x1 + ',' + b.y1, b])) };
  return {
    connected: false,
    diplo: { at: Date.now(), alliance: '123456', friendly: ['Pals'], neutral: ['Meh'], enemy: ['Doom'] },
    async diplomacy() { return this.diplo; },
    mapStore() { return store; },
    mapBlockTiles(e, mine) {
      const byXY = new Map();
      const w = e.x2 - e.x1 + 1;
      for (let yy = e.y1; yy <= e.y2; yy++) {
        for (let xx = e.x1; xx <= e.x2; xx++) {
          const d = C.decodeTile(e.mapStr.substr(((yy - e.y1) * w + (xx - e.x1)) * 2, 2));
          if (d) byXY.set(xx + ',' + yy, { x: xx, y: yy, id: FID(xx, yy), kind: d.key, typeName: d.name, level: d.level });
        }
      }
      for (const c of e.castles) {
        const xy = C.fieldIdToCoords(c.id);
        const base = byXY.get(xy.x + ',' + xy.y) || { x: xy.x, y: xy.y };
        Object.assign(base, { id: c.id, name: c.name, userName: c.userName, allianceName: c.allianceName,
          prestige: c.prestige || 0, honor: c.honor || 0, npc: !!c.npc, state: c.state, furlough: !!c.furlough,
          mine: mine.has(c.id), relation: c.relation, kind: c.npc ? 'npc' : 'player' });
        byXY.set(xy.x + ',' + xy.y, base);
      }
      return [...byXY.values()];
    },
    ...extra,
  };
}
const liveBlock = () => block(420, 0, {
  '434,1': '21',   // desert level 1: the wiki's GetLevel(1234) example
  '425,5': '1a',   // forest level 10
  '430,10': 'a3',  // flat level 3
  '428,8': 'b0', '421,2': 'c7',
}, [
  { id: FID(428, 8), name: 'Keep', userName: 'Zed', allianceName: 'Doom', prestige: 100, honor: 5, npc: false, state: 2, relation: 3 },
  { id: FID(421, 2), name: "Barbarian's city", npc: true, state: 1, relation: 6 },
]);

// A real Game, offline unless `live`: req() answers from `replies`.
function world({ live = false, replies = {}, session } = {}) {
  const g = new Game();
  g.player = { playerInfo: { userName: 'YayMe', alliance: '123456' } };
  g.castles = [{ id: 1, name: 'MyCity', fieldId: FID(460, 355), heros: [] }, { id: 2, name: 'Other', fieldId: FID(10, 10), heros: [] }];
  g.marchSkillParam = 100;
  Object.defineProperty(g, 'alive', { value: live });
  const sent = [];
  g.req = async (cmd, data) => {
    sent.push({ cmd, data });
    const r = replies[cmd];
    return typeof r === 'function' ? r(data) : r;
  };
  let castle = 'MyCity';
  const ctx = {
    get game() { return g; },
    get castle() { return g.castle(castle); },
    session, opts: {}, dryRun: false, log: () => {},
    use(name) { castle = name; },
  };
  return { g, sent, ctx, fn: F.globals(ctx) };
}
const detailReply = (over = {}) => (data) => ({
  ok: 1,
  bean: { id: data.fieldId, name: 'Grassland', prestige: 0, furlough: false, changeface: 0, canLoot: false, honor: 0,
    playerLogoUrl: null, canScout: true, zoneName: 'LOWER LORRAINE', canOccupy: true, state: 1, npc: false,
    userName: null, canTrans: false, flag: null, allianceName: null, relation: 6, canSend: false, ...over },
});
const { fn } = world();

// ---------------------------------------------------------------- math
section('Math (the Math page, every example)');

t('abs, ceil, floor, pow, sqrt', () => {
  eq([fn.abs(-123456), fn.abs(123456), fn.ceil(4.1), fn.floor(1234.56), fn.pow(7, 3), fn.sqrt(16)], [123456, 123456, 5, 1234, 343, 4]);
});
t('the trigonometry and exp/log, to the digits the wiki prints', () => {
  near(fn.acos(0.75), 0.7227342478134157);
  near(fn.asin(0.75), 0.848062078981481);
  near(fn.atan(7), 1.4288992721907328);
  near(fn.atan2(7, 3), 1.1659045405098132);
  near(fn.cos(7), 0.7539022543433046);
  near(fn.exp(7), 1096.633158428458);
  near(fn.sin(3), 0.1411200080598672);
  near(fn.tan(4), 1.1578212823495775);
  near(fn.log(fn.E), 1);
});
t('round, with and without places', () => {
  eq([fn.round(6.66666666666666666666), fn.round(6.66666666666666666666, 1), fn.round(6.66666666666666666666, 2), fn.round(6.66666666666666666666, 3)],
    [7, 6.7, 6.67, 6.667]);
  eq([fn.round(1.005, 2), fn.round(1234, -2), fn.round(-2.5), fn.round('2.45', '1')], [1.01, 1200, -2, 2.5]);
});
t('max and min take any number of values (and k/m suffixes in text)', () => {
  eq([fn.max(5, 3, 9, 1, 7), fn.min(5, 3, 9, 1, 7), fn.max(40000, '100k'), fn.min('99999999', 12)], [9, 1, 100000, 12]);
  eq([fn.max([4, 8], 2), fn.min(3)], [8, 3]);
});
t('random() is in [0, 1) and round(random()*10) in 0..10', () => {
  for (let i = 0; i < 200; i++) {
    const r = fn.random();
    assert.ok(r >= 0 && r < 1);
    assert.ok(Number.isInteger(fn.round(r * 10)) && fn.round(r * 10) <= 10);
  }
});
t('isNaN and isFinite (the Unsorted page examples)', () => {
  eq([fn.isNaN(fn.NaN + 2), fn.isFinite(2 / 0), fn.isNaN('abc'), fn.isNaN(5), fn.isFinite('12')], [true, false, true, false, true]);
});
t('the constants', () => {
  eq([fn.PI, fn.E, fn.SQRT1_2, fn.SQRT2, fn.LN2, fn.LN10, fn.LOG10E, fn.LOG2E],
    [Math.PI, Math.E, Math.SQRT1_2, Math.SQRT2, Math.LN2, Math.LN10, Math.LOG10E, Math.LOG2E]);
  eq([fn.Math.floor(2.7), fn.Math.PI, fn.String.fromCharCode(70), fn.parseInt('42px'), fn.parseFloat('2.5e1')], [2, Math.PI, 'F', 42, 25]);
});

// ---------------------------------------------------------------- strings
section('Strings (the NEAT helpers on the Strings page)');

t('CenterPad, LeftPad, RightPad', () => {
  eq(fn.CenterPad('This is a test', 25, '.'), '.....This is a test......');
  eq(fn.LeftPad('This is a test', 25, '.'), '...........This is a test');
  eq(fn.RightPad('This is a test', 25, '.'), 'This is a test...........');
  eq([fn.LeftPad(7, 3), fn.LeftPad(7, 3, '0'), fn.RightPad('toolong', 3), fn.CenterPad('ab', 6, '-=')], ['  7', '007', 'toolong', '-=ab-=']);
  eq(fn.CenterPad('\nTOTAL TROOPS:\n', 43, '=').length, 43);
});
t('StringRepeat', () => {
  eq(fn.StringRepeat(25, '.'), '.........................');
  eq(fn.StringRepeat(25, 'Test'), 'Test'.repeat(25));
  eq(fn.StringRepeat(25, 'Test '), 'Test '.repeat(25));
  eq([fn.StringRepeat(3), fn.StringRepeat(-2, 'x')], ['   ', '']);
  assert.throws(() => fn.StringRepeat(1e9, 'xx'), /more than 1,000,000 characters/);
});
t('Merge', () => {
  eq(fn.Merge('This is a test', 'of the Emergency Broadcast System'), 'This is a test of the Emergency Broadcast System');
  eq(fn.Merge('One plus One', 'Two', ' = '), 'One plus One = Two');
  eq([fn.Merge('', 'b', '-'), fn.Merge('a', null, '-'), fn.Merge(null, undefined)], ['b', 'a', '']);
});
t('StringToObject', () => {
  const o = fn.StringToObject('test1:no1,test2:no2', ',', ':');
  eq(o.test2, 'no2');
  eq(fn.StringToObject(' a = 1 ; b=2;c ', ';', '='), { a: '1', b: '2', c: '' });
  const into = { keep: 1 };
  assert.strictEqual(fn.StringToObject('x:5', ',', ':', into), into);
  eq(into, { keep: 1, x: '5' });
  const bad = fn.StringToObject('__proto__:1,constructor:2,ok:3', ',', ':');
  eq(Object.keys(bad), ['ok']);
  assert.strictEqual(({}).polluted, undefined);
});
t('ToCSV, with a date in it', () => {
  eq(fn.ToCSV('Bob', 'Cap his city', fn.date(2014, 1, 11, 19, 59, 38)), '"Bob","Cap his city","Tue Feb 11 19:59:38 GMT-0500 2014"');
  eq(fn.ToCSV('say "hi"', 5, null), '"say ""hi""","5",""');
});
t('Upper1', () => { eq([fn.Upper1('testing'), fn.Upper1(''), fn.Upper1('Á la')], ['Testing', '', 'Á la']); });
t('FormatNumber and FormatNumber2', () => {
  eq(fn.FormatNumber('1234567'), '1,234,567');
  eq(fn.FormatNumber('1234567', '2'), '1,234,567.00');
  eq(fn.FormatNumber2('1234567'), '1,234,567.00');
  eq([fn.FormatNumber(-1234.5), fn.FormatNumber(1234567, 0, false), fn.FormatNumber(0.005, 2), fn.FormatNumber(-0.2), fn.FormatNumber('x')],
    ['-1,235', '1234567', '0.01', '0', 'NaN']);
  eq(fn.FormatNumber(2345.555, 2), '2,345.56');
});
t('FormatPercent', () => {
  eq([fn.FormatPercent('1'), fn.FormatPercent('0.25', '0'), fn.FormatPercent('0.25', '2'), fn.FormatPercent(0.091)], ['100.0%', '25%', '25.00%', '9.1%']);
});
t('FormatMiles cuts to two places', () => {
  eq([fn.FormatMiles(123), fn.FormatMiles(123.4), fn.FormatMiles(0.29), fn.FormatMiles(351.8096)], ['123.00 miles', '123.40 miles', '0.29 miles', '351.80 miles']);
});

// ---------------------------------------------------------------- parsing
section('ParseInteger, PrepareParameters, GetResources');

t('ParseInteger: the wiki examples', () => {
  eq(fn.ParseInteger('40s', 0, 40, 's'), 40);
  eq(fn.ParseInteger('50s', 0, 100), -1);
  // The wiki's first example says ParseInteger("40", 50) gives 40, which
  // contradicts its own usage line (50 is the MINIMUM). The usage line wins.
  eq(fn.ParseInteger('40', 50), -1);
  eq(fn.ParseInteger('40', 0), 40);
});
t('ParseInteger: edges', () => {
  eq([fn.ParseInteger('41s', 0, 40, 's'), fn.ParseInteger(' 7 ', 0), fn.ParseInteger('4.5', 0), fn.ParseInteger('', 0),
    fn.ParseInteger(null, 0), fn.ParseInteger(12, 0, 20), fn.ParseInteger('40S', 0, 50, 's'), fn.ParseInteger('-3', -5),
    fn.ParseInteger('1e3', 0), fn.ParseInteger('40', undefined, 39), fn.ParseInteger('20k', 0)],
  [-1, 7, -1, -1, -1, 12, 40, -3, -1, -1, -1]);
});
t('PrepareParameters: the wiki examples', () => {
  eq(String(fn.PrepareParameters('This is a test')), 'This,is,a,test');
  eq(fn.PrepareParameters("this is a /test 'with spaces and quotes'"), ['this', 'is', 'a', '/test', 'with spaces and quotes']);
  eq(fn.PrepareParameters('this is a test /a="qqq ww" s'), ['this', 'is', 'a', 'test', '/a=qqq ww', 's']);
});
t('PrepareParameters: edges', () => {
  eq([fn.PrepareParameters(''), fn.PrepareParameters('  a  '), fn.PrepareParameters('x "" y'), fn.PrepareParameters('"unclosed q')],
    [[], ['a'], ['x', '', 'y'], ['unclosed q']]);
});
t('GetResources (and getResources) from a resource string', () => {
  const r = fn.GetResources('f:990b,w:100m,i:10m:10m,s:10m,g:100m');
  eq([r.food, r.wood, r.iron, r.stone, r.gold], [990e9, 100e6, 10e6, 10e6, 100e6]);
  eq(fn.getResources('f:0').food, 0);
  eq([fn.GetResources('x:5'), fn.GetResources('food')], [null, null]);
  eq(fn.GetResources('lumber:2k,l:1k').wood, 3000);
});

// ---------------------------------------------------------------- dates
section('date() and TimeDiff');

t('date(y, m0, d, h, mi) counts months from 0 and prints like NEAT', () => {
  const d = fn.date(2012, 9, 24, 10, 30);
  eq(d.toString(), 'Wed Oct 24 10:30:00 GMT-0400 2012');
  eq(d.toUTCString(), 'Wed Oct 24 14:30:00 2012 UTC');
  eq(String(d), 'Wed Oct 24 10:30:00 GMT-0400 2012');
  eq('at ' + d, 'at Wed Oct 24 10:30:00 GMT-0400 2012');
  eq([d.getMonth(), d.getDate(), d.getDay(), d.getFullYear(), d.getHours(), d.getMinutes(), d.getSeconds()], [9, 24, 3, 2012, 10, 30, 0]);
  assert.ok(d instanceof Date);
});
t('date(ms) and date()', () => {
  eq(fn.date(1418253379677).toString(), 'Wed Dec 10 18:16:19 GMT-0500 2014');
  const now = fn.date();
  assert.ok(Math.abs(now.getTime() - Date.now()) < 1000);
  assert.ok(Math.abs(now.toNumber() - Date.now()) < 1000);
  eq(Math.floor((fn.date(10000) - fn.date(4000)) / 1000), 6);
  eq(fn.date(fn.date(5)).getTime(), 5);
  eq(json(fn.date(0)), '"1970-01-01T00:00:00.000Z"');
});
t('date() follows the game clock when there is one', () => {
  const w = world();
  w.g.serverOffset = 3600000;
  assert.ok(Math.abs(w.fn.date().getTime() - (Date.now() + 3600000)) < 1000);
});
t('TimeDiff', () => {
  const d = fn.TimeDiff(Date.now() + 5000);
  assert.ok(d > 4800 && d <= 5000, String(d));
  eq(fn.TimeDiff(2000, 500), 1500);
  eq(fn.TimeDiff(fn.date(9000), fn.date(1000)), 8000);
});
function json(v) { return fn.json_encode(v); }

// ---------------------------------------------------------------- JSON
section('json_encode / json_decode');

t('json_encode: the wiki example', () => { eq(fn.json_encode({ this: 'that' }), '{"this":"that"}'); });
t('json_encode: nesting, functions dropped, loops cut', () => {
  const o = { a: [1, 'x', null, () => 1], f() {}, n: NaN, d: { e: true } };
  o.self = o;
  eq(fn.json_encode(o), '{"a":[1,"x",null,null],"n":null,"d":{"e":true},"self":"[circular]"}');
  eq(fn.json_encode({ a: 1 }, 2), '{\n  "a": 1\n}');
  eq([fn.json_encode(undefined), fn.json_encode('s'), fn.json_encode([])], ['null', '"s"', '[]']);
});
t('json_encode shows a class-built view\'s getters and skips promises', () => {
  class View { #id = 7; get id() { return this.#id; } get name() { return 'Nine'; } get later() { return Promise.resolve(1); } get bad() { throw new Error('x'); } }
  eq(fn.json_encode(new View()), '{"id":7,"name":"Nine"}');
  // a view whose getters hand out new views without end stays bounded
  class Tree { get a() { return new Tree(); } get b() { return new Tree(); } }
  assert.ok(fn.json_encode(new Tree()).length < 2e6);
  class Self { get me() { return this; } get n() { return 1; } }
  eq(fn.json_encode(new Self()), '{"me":"[circular]","n":1}');
});
t('a bean that counts as a number counts as one (valueOf)', () => {
  const food = { amount: 5000, valueOf() { return 5000; }, toString() { return '5000'; } };
  eq([fn.max(food, 100), fn.FormatNumber(food), fn.round(food, -3)], [5000, '5,000', 5000]);
});
t('json_decode', () => {
  eq(fn.json_decode('{"a":[1,{"b":2}]}'), { a: [1, { b: 2 }] });
  eq(fn.json_decode('not json'), null);
  const o = fn.json_decode('{"__proto__":{"x":1},"ok":1}');
  eq(Object.keys(o), ['ok']);
  assert.strictEqual(({}).x, undefined);
});

// ---------------------------------------------------------------- XML
section('xml() and the XML helpers');

const SCOUT = '<?xml version="1.0" encoding="UTF-8"?><reportData reportUrl="battless71.evony.com/default.html?logfile/a.xml">'
  + '<scoutReport isAttack="true" isFound="false" isSuccess="true"><scoutInfo heroName="W" heroLevel="120" gold="45" population="52000">'
  + '<resource food="12" wood="35" stone="0" iron="7"/>'
  + '<fortifications><fortificationsType typeId="14" count="1000"/><fortificationsType typeId="16" count="250"/><fortificationsType typeId="18" count="0"/></fortifications>'
  + '<troops><troopStrType typeId="7" count="99500"/><troopStrType typeId="4" count="1000"/><troopStrType typeId="9" count="90"/></troops>'
  + '<buildings><buildingType type="31" levels="10"/></buildings></scoutInfo></scoutReport></reportData>';
const BATTLE = '<reportData><battleReport isAttack="true" isAttackSuccess="true" round="4">'
  + '<attackTroop king="Me"><troopUnit typeId="7" count="50000" lose="412"/><troopUnit typeId="11" count="2000" lose="0"/></attackTroop>'
  + '<lootResource gold="81234" food="512000" wood="0"/></battleReport></reportData>';

t('xml() returns the root element, so report.scoutReport... works', () => {
  const report = fn.xml(SCOUT);
  eq(report.scoutReport.scoutInfo.heroName, 'W');
  eq(report.scoutReport.isSuccess, true);
  eq(report.reportUrl, 'battless71.evony.com/default.html?logfile/a.xml');
  eq(report.scoutReport.scoutInfo.troops.troopStrType.length, 3);
  eq([fn.xml(''), fn.xml('plain text'), fn.xml('<reportData/>')], [null, null, null]);
  const same = { a: 1 };
  assert.strictEqual(fn.xml(same), same);
});
t('GetTroopsFromXML (the wiki example)', () => {
  const report = fn.xml(SCOUT);
  const troops = fn.GetTroopsFromXML(report.scoutReport.scoutInfo.troops.troopStrType);
  eq([troops.archer, troops.scouter, troops.lightCavalry, troops.militia], [99500, 1000, 90, 0]);
  const single = fn.GetTroopsFromXML(fn.xml('<a><troopStrType typeId="12" count="5"/></a>').troopStrType);
  eq(single.batteringRam, 5);
  // the parent node works too, and a count property other than "count"
  eq(fn.GetTroopsFromXML(report.scoutReport.scoutInfo.troops).archer, 99500);
  eq(fn.GetTroopsFromXML(fn.xml(BATTLE).battleReport.attackTroop.troopUnit, 'lose').archer, 412);
  eq(fn.GetTroopsFromXML(undefined), null);
});
t('GetTroopsFromXML keeps a count the scouts could not pin down', () => {
  const b = fn.GetTroopsFromXML(fn.xml('<a><troopStrType typeId="7" count="?"/><troopStrType typeId="5" count="1000-2000"/></a>').troopStrType);
  eq([b.archer, b.pikemen], ['?', '1000-2000']);
});
t('GetFortsFromXML', () => {
  const f = fn.GetFortsFromXML(fn.xml(SCOUT).scoutReport.scoutInfo.fortifications.fortificationsType);
  eq([f.trap, f.abatis, f.arrowTower, f.rollingLogs, f.rockfall], [1000, 0, 250, 0, 0]);
});
t('GetResourcesFromXML (the wiki example) and no loot = null', () => {
  const res = fn.GetResourcesFromXML(fn.xml(BATTLE).battleReport.lootResource);
  eq([res.gold, res.food, res.wood, res.stone, res.iron], [81234, 512000, 0, 0, 0]);
  eq(fn.GetResourcesFromXML(fn.xml('<reportData><battleReport round="1"/></reportData>').battleReport.lootResource), null);
  eq(fn.GetResourcesFromXML(fn.xml('<r><x lumber="5" food="0"/></r>').x).wood, 5);
});

// ---------------------------------------------------------------- map: coordinates
section('MapFunctions: coordinates, names, states');

t('GetFieldId and FieldIdToCoords (the wiki examples)', () => {
  eq([fn.GetFieldId('460,355'), fn.GetFieldId(460, 355), fn.GetFieldId('123,456'), fn.GetFieldId(142, 255)], [284460, 284460, 364923, 204142]);
  eq([fn.FieldIdToCoords(284460), fn.fieldIdToCompareString(284460), fn.FieldIdToCompareString(1234)], ['460,355', '460,355', '434,1']);
  eq([fn.GetX(284460), fn.GetY(284460), fn.getX('460,355'), fn.GetX(fn.FieldIdToCoords(64208)), fn.GetY(64208)], [460, 355, 460, 208, 80]);
  eq([fn.GetFieldId('Home(12,34)'), fn.GetFieldId({ x: 1, y: 1 }), fn.GetFieldId('284460'), fn.GetFieldId(-1, 0)], [FID(12, 34), 801, 284460, 799]);
  eq([fn.GetFieldId('nowhere'), fn.FieldIdToCoords(640000), fn.GetX(null)], [null, null, null]);
  eq(fn.GetFieldId('123.456'), 364923, 'the StateName page writes GetDetailInfo("123.456")');
});
t('MapDistance and FormatDistance (the wiki examples)', () => {
  eq(fn.round(fn.MapDistance(460, 355, 123, 456), 2), 351.81);
  eq(fn.FormatDistance(12345, 23456), '90.09 miles');
  eq(fn.FormatDistance(fn.GetFieldId(460, 355), fn.GetFieldId('123,456')), '351.80 miles');
  eq(fn.MapDistance(0, 0, 799, 0), 1, 'the map wraps');
  eq(fn.MapDistance('460,355', '460,360'), 5);
});
t('GetZoneName, StateCoords', () => {
  eq([fn.GetZoneName(fn.GetFieldId(457, 281)), fn.getZoneName(0), fn.GetZoneName(fn.GetFieldId(799, 799))], ['Thuringia', 'Friesland', 'Romagna']);
  eq([fn.StateCoords('upper lorraine'), fn.StateCoords(8), fn.StateCoords('all'), fn.StateCoords('Lombardy'), fn.StateCoords('LowerLorraine')],
    ['0,400 199,599', '0,400 199,599', '0,0 799,799', '200,600 399,799', '0,200 199,399']);
  eq(fn.StateCoords('bohemia'), '600,0 799,199');
  eq([fn.StateCoords('nowhere'), fn.StateCoords(16), fn.StateCoords('')], [null, null, null]);
});
t('StateName (and stateName)', () => {
  eq([fn.StateName(2), fn.StateName(1), fn.stateName(3), fn.StateName(5), fn.StateName(6), fn.StateName('2'), fn.StateName(4)],
    ['truce', 'peace', 'beginner', 'holiday', 'dream', 'truce', '']);
});
t('GetFieldName and GetFieldType', () => {
  eq([fn.GetFieldName(3), fn.GetFieldName(5), fn.GetFieldName(10), fn.GetFieldName(12), fn.GetFieldName(7)], ['Hill', 'Grassland', 'Flat', 'NPC', null]);
  eq([fn.GetFieldType('hill'), fn.GetFieldType('Grassland'), fn.GetFieldType('NPC'), fn.GetFieldType('castle'), fn.GetFieldType('flats'), fn.GetFieldType('moon')],
    [3, 5, 12, 11, 10, -1]);
});

// ---------------------------------------------------------------- map: searches
section('MapFunctions: FindField, CastlesInRectangle, AllCastles, SearchEnemyCastles');

t('AllCastles (the wiki example): players in a square, NPCs left out', async () => {
  const castles = await fn.AllCastles(fn.GetFieldId(455, 350), fn.GetFieldId(465, 360));
  eq(castles.map((c) => c.userName), ['Bob', 'Fred', 'YayMe', 'George', 'George', 'Harry']);
  const info = castles[0];
  eq(`Coord: ${fn.FieldIdToCoords(info.id)}, Username: ${info.userName}, Alliance: ${info.allianceName}, Prestige: ${info.prestige}`,
    'Coord: 455,353, Username: Bob, Alliance: null, Prestige: 4991');
  eq([info.coords, info.x, info.y, info.zoneName, info.npc, info.state, info.relation], ['455,353', 455, 353, 'Thuringia', false, 1, 6]);
});
t('CastlesInRectangle: NPCs on request, indexed by castle id (the Unsorted example)', async () => {
  eq((await fn.CastlesInRectangle(455, 350, 465, 360)).length, 6);
  const list = await fn.CastlesInRectangle(455, 350, 465, 360, false, true);
  eq(Object.keys(list).length, 7);
  const castle = list[fn.GetFieldId(456, 356)];
  eq([castle.npc, castle.level, castle.name, castle.type], [true, 5, "Barbarian's city", 12]);
  eq(list[fn.GetFieldId(1, 1)], undefined);
  eq((await fn.CastleInRectangle(465, 360, 455, 350)).length, 6, 'corners in any order');
  eq((await fn.CastlesInRectangle(455, 350, 465, 360, 0)).length, 7, 'any falsy value includes NPCs');
  eq((await fn.AllCastles(fn.GetFieldId(455, 350), fn.GetFieldId(465, 360), false)).length, 7);
  await assert.rejects(fn.CastlesInRectangle('a', 1, 2, 3), /CastlesInRectangle\(x1, y1, x2, y2/);
  await assert.rejects(fn.MapCastles('nowhere', undefined, 3), /MapCastles\(x, y, radius\)/);
});
t('MapCastles(x, y, r): the old radius form', async () => {
  eq((await fn.MapCastles(460, 355, 3)).map((c) => c.userName), ['YayMe', 'George'], 'Fred at 457,353 is 3.6 away');
  eq((await fn.MapCastles(460, 355, 4)).map((c) => c.userName), ['Fred', 'YayMe', 'George']);
});
t('FindField: flats around the city, by x then y, and with a level', async () => {
  eq(await fn.FindField(460, 355, 5, 10), [FID(461, 356)], '463,350 is 5.83 away');
  const flats = await fn.FindField(460, 355, 6, 10);
  eq(flats, [FID(461, 356), FID(463, 350)]);
  eq(`Coord: ${fn.FieldIdToCoords(flats[0])} is a level ${await fn.GetLevel(flats[0])} flat.`, 'Coord: 461,356 is a level 3 flat.');
  eq(await fn.FindField(460, 355, 6, 10, 10), [FID(463, 350)]);
  eq(await fn.FindField(460, 355, 20, 10), [FID(440, 355), FID(461, 356), FID(463, 350)], 'radius is inclusive');
});
t('FindField: NPCs of a level, castles, and a name for the type', async () => {
  eq(await fn.FindField(460, 355, 20, 12, 10), [FID(470, 355)]);
  eq(await fn.FindField(460, 355, 20, 12, 0), [FID(456, 356), FID(470, 355)]);
  eq(await fn.FindField(460, 355, 3, 'castle'), [FID(459, 357), FID(460, 355)]);
  await assert.rejects(fn.FindField(460, 355, 5, 'moon'), /unknown field type moon/);
});
t('SearchEnemyCastles: the enemy alliance (from the diplomacy), nearest first', async () => {
  const w = world({ session: fakeSession([]) });
  eq((await w.fn.SearchEnemyCastles(10)).map((c) => c.userName), ['Evil', 'Hated']);
  eq((await w.fn.SearchEnemyCastles(1)).map((c) => c.name), ['Lair']);
  eq(await fn.SearchEnemyCastles(10), [], 'no session, no diplomacy: nobody is known to be an enemy');
});
t('map beans are copies: changing one changes nothing', async () => {
  const [bob] = await fn.AllCastles(fn.GetFieldId(455, 353), fn.GetFieldId(455, 353));
  bob.userName = 'Hacked';
  bob.prestige = 1;
  eq(ROWS[1].userName, 'Bob');
  eq((await fn.AllCastles(fn.GetFieldId(455, 353), fn.GetFieldId(455, 353)))[0].userName, 'Bob');
});

section('MapFunctions: the session\'s live blocks');

t('valleys come from live blocks: GetLevel(1234) is a level 1 desert at 434,1 (the wiki example)', async () => {
  const w = world({ session: fakeSession([liveBlock()]) });
  eq(`The object on the map at ${w.fn.FieldIdToCoords(1234)} is level ${await w.fn.GetLevel(1234)}.`, 'The object on the map at 434,1 is level 1.');
  eq(await w.fn.GetType(1234), 2);
  eq(await w.fn.getLevel(fn.GetFieldId(425, 5)), 10);
});
t('FindField over live blocks: forests, flats and NPCs', async () => {
  const w = world({ session: fakeSession([liveBlock()]) });
  eq(await w.fn.FindField(430, 5, 10, 1), [FID(425, 5)]);
  eq(await w.fn.FindField(430, 5, 10, 1, 3), []);
  eq(await w.fn.FindField(430, 5, 10, 10), [FID(430, 10)]);
  eq(await w.fn.FindField(430, 5, 10, 12, 7), [FID(421, 2)]);
  eq((await w.fn.FindField(430, 5, 1, 'grassland')).length, 5);
});
t('a live block castle keeps the server\'s relation; enemies from both sources', async () => {
  const w = world({ session: fakeSession([liveBlock()]) });
  const keep = await w.fn.GetDetailInfo('428,8');
  eq([keep.userName, keep.relation, keep.state, w.fn.RelationIndex(keep)], ['Zed', 3, 2, 1]);
  eq((await w.fn.SearchEnemyCastles()).map((c) => c.userName), ['Evil', 'Hated', 'Zed']);
});
t('without a session there are no valleys, and the cache alone still answers', async () => {
  eq(await fn.GetLevel(1234), null);
  eq(await fn.GetType(fn.GetFieldId(461, 356)), 10);
});

// ---------------------------------------------------------------- detail info
section('GetDetailInfo, UpdateDetailInfo, RelationIndex');

t('GetDetailInfo(id): the cached scan will do', async () => {
  const w = world({ live: true, replies: { 'field.getOtherFieldInfo': detailReply() } });
  const bob = await w.fn.GetDetailInfo(w.fn.GetFieldId(455, 353));
  eq([bob.userName, bob.name, bob.lastUpdated], ['Bob', 'B1', T0]);
  eq(w.sent.length, 0, 'no request while the cache is good enough');
});
t('GetDetailInfo(id, false, 30): too old, so the server is asked, once', async () => {
  const w = world({ live: true, replies: { 'field.getOtherFieldInfo': detailReply({ userName: 'Bob', name: 'B1', prestige: 5000 }) } });
  const id = w.fn.GetFieldId(455, 353);
  const data = await w.fn.GetDetailInfo(id, false, 30);
  eq([data.userName, data.prestige, data.canScout, data.zoneName, data.id, data.coords], ['Bob', 5000, true, 'LOWER LORRAINE', id, '455,353']);
  eq(w.sent, [{ cmd: 'field.getOtherFieldInfo', data: { fieldId: id } }]);
  const again = await w.fn.GetDetailInfo(id, false, 0, w.fn.date().getTime() - 30000);
  eq(again.prestige, 5000);
  eq(w.sent.length, 1, 'the second call is served from the detail cache');
  again.prestige = 1;
  eq((await w.fn.GetDetailInfo(id, false, 30)).prestige, 5000, 'a copy each time');
});
t('StateName(GetDetailInfo("123,456").state) (the StateName example) and json_encode of it', async () => {
  const w = world({ live: true, replies: { 'field.getOtherFieldInfo': detailReply() } });
  const d = await w.fn.GetDetailInfo('123,456');
  eq(w.fn.StateName(d.state), 'peace');
  const j = JSON.parse(w.fn.json_encode(d));
  eq([j.id, j.name, j.relation, j.canOccupy, j.userName], [364923, 'Grassland', 6, true, null]);
  eq((await w.fn.GetDetailInfo(w.fn.GetFieldId(123, 456))).name, 'Grassland');
});
t('offline, a tile that is too old or unknown gives null', async () => {
  const w = world({ live: false, replies: { 'field.getOtherFieldInfo': detailReply() } });
  eq(await w.fn.GetDetailInfo(w.fn.GetFieldId(455, 353), false, 30), null);
  eq(await w.fn.GetDetailInfo('1,2'), null);
  eq(await w.fn.GetDetailInfo('not a place'), null);
  eq(w.sent.length, 0);
});
t('the session decides whether we are online', async () => {
  const w = world({ live: true, session: fakeSession([], { connected: false }), replies: { 'field.getOtherFieldInfo': detailReply() } });
  eq(await w.fn.GetDetailInfo('1,2'), null);
  eq(w.sent.length, 0);
});
t('a reply for another tile is not taken; a refusal is null', async () => {
  const w = world({ live: true, replies: { 'field.getOtherFieldInfo': () => ({ ok: 1, bean: { id: 5, name: 'Else' } }) } });
  eq(await w.fn.GetDetailInfo('1,2'), null);
  const w2 = world({ live: true, replies: { 'field.getOtherFieldInfo': { ok: -1, errorMsg: 'no' } } });
  eq(await w2.fn.GetDetailInfo('1,2'), null);
  const w3 = world({ live: true, replies: { 'field.getOtherFieldInfo': () => { throw new Error('timeout'); } } });
  eq(await w3.fn.GetDetailInfo('1,2'), null);
});
t('a scan newer than the cached detail wins', async () => {
  const w = world({ live: true, replies: { 'field.getOtherFieldInfo': detailReply({ userName: 'OldOwner', name: 'F1' }) } });
  const id = w.fn.GetFieldId(457, 353);
  eq((await w.fn.UpdateDetailInfo(id)).userName, 'OldOwner');
  eq((await w.fn.GetDetailInfo(id)).userName, 'OldOwner', 'the detail is newer than the scan');
  const was = ROWS[2].seen;
  ROWS[2].seen = Date.now() + 1000;
  eq((await w.fn.GetDetailInfo(id)).userName, 'Fred');
  ROWS[2].seen = was;
});
t('UpdateDetailInfo (and updateDetailInfo) always ask the server', async () => {
  const w = world({ live: true, replies: { 'field.getOtherFieldInfo': detailReply() } });
  await w.fn.UpdateDetailInfo('1,2');
  await w.fn.updateDetailInfo(FID(1, 2));
  eq(w.sent.length, 2);
  eq((await w.fn.GetDetailInfo('1,2')).canOccupy, true);
  eq(w.sent.length, 2);
});
t('the detail cache belongs to the account (session or game)', async () => {
  const a = world({ live: true, replies: { 'field.getOtherFieldInfo': detailReply({ name: 'A' }) } });
  const b = world({ live: true, replies: { 'field.getOtherFieldInfo': detailReply({ name: 'B' }) } });
  eq((await a.fn.GetDetailInfo('3,3')).name, 'A');
  eq((await b.fn.GetDetailInfo('3,3')).name, 'B');
});
t('RelationIndex: 0 you, 1 enemy, 2 your alliance, 3 friend, 4 neutral, 5 other, 6 none', async () => {
  const w = world({ session: fakeSession([]) });
  const at = async (x, y) => (await w.fn.CastlesInRectangle(x, y, x, y))[0];
  eq(w.fn.RelationIndex(await at(460, 355)), 0);
  eq(w.fn.RelationIndex(await at(480, 360)), 1);
  eq(w.fn.RelationIndex({ userName: 'Ally', allianceName: '123456' }), 2);
  eq(w.fn.RelationIndex(await at(459, 357)), 3);
  eq(w.fn.RelationIndex(await at(464, 360)), 4);
  eq(w.fn.RelationIndex({ userName: 'X', allianceName: 'Random' }), 5);
  eq(w.fn.RelationIndex(await at(455, 353)), 6);
  eq(w.fn.RelationIndex(null), 6);
});

section('ResetMap');

t('ResetMap(x, y, r) hides cached tiles until a scan sees them again', async () => {
  const w = world();
  const bobId = w.fn.GetFieldId(455, 353);
  eq(await w.fn.ResetMap(455, 353, 1), null);
  eq((await w.fn.AllCastles(w.fn.GetFieldId(455, 350), w.fn.GetFieldId(465, 360))).length, 5);
  eq(await w.fn.GetDetailInfo(bobId), null);
  ROWS[1].seen = Date.now() + 5;   // the next scan
  eq((await w.fn.GetDetailInfo(bobId)).userName, 'Bob');
});
t('ResetMap(x, y, w, h) drops the session blocks it touches and the detail cache inside it', async () => {
  const s = fakeSession([liveBlock()]);
  const w = world({ live: true, session: s, replies: { 'field.getOtherFieldInfo': detailReply() } });
  s.connected = true;
  await w.fn.UpdateDetailInfo('600,600');
  eq(await w.fn.GetLevel(1234), 1);
  w.fn.ResetMap(430, 0, 5, 5);
  eq(s.mapStore().blocks.size, 0);
  eq(await w.fn.GetLevel(1234), null);
  w.fn.ResetMap(590, 590, 20, 20);
  s.connected = false;
  eq(await w.fn.GetDetailInfo('600,600'), null);
  assert.throws(() => w.fn.ResetMap('x', 1, 2), /ResetMap\(x, y, radius\)/);
});
t('resetMap is exported for rescanmap/rescanrec (script-cmd-info.js)', async () => {
  const b = liveBlock();
  b.at = Date.now() + 1000;   // read after the reset the test above made over 434,1
  const s = fakeSession([b]);
  const w = world({ session: s });
  eq(await w.fn.GetLevel(1234), 1);
  eq(F.resetMap(w.ctx, 420, 0, 20, 20), null);
  eq(s.mapStore().blocks.size, 0);
  eq(await w.fn.GetLevel(1234), null);
  for (const k of ['mapTiles', 'fieldType', 'coordsOf', 'setMapCache', 'tileBean']) eq(typeof F[k], 'function', k);
});

// ---------------------------------------------------------------- travel, timers
section('getTravelTime, city timers');

t('getTravelTime offline uses the march skill the game knows', async () => {
  const w = world();
  w.g.marchSkillParam = 150;
  const want = Math.round(C.marchTimeMs({ x: 460, y: 355 }, { x: 123, y: 456 }, ['scouter'], { marchSkill: 150 }) / 1000);
  eq(await w.fn.getTravelTime(w.fn.GetFieldId(460, 355), w.fn.GetFieldId('123,456'), { scouter: 100000 }, 5), want);
  eq(await w.fn.getTravelTime('460,355', '123,456', 's:100k', 5), want);
  eq(await w.fn.getTravelTime('460,355', '123,456', {}, 5), null);
});
t('getTravelTime online asks the city\'s troop params; type 2 gets the Relief Station', async () => {
  const w = world({ live: true, replies: { 'army.getTroopParam': { marchSkillParam: 150, driveSkillParam: 120, transportStationParam: 2 } } });
  const a = { x: 460, y: 355 }, b = { x: 123, y: 456 };
  eq(await w.fn.getTravelTime('460,355', '123,456', 'c:10', 5), Math.round(C.marchTimeMs(a, b, ['lightCavalry'], { marchSkill: 150, driveSkill: 120 }) / 1000));
  eq(await w.fn.getTravelTime('460,355', '123,456', 'c:10', 2), Math.round(C.marchTimeMs(a, b, ['lightCavalry'], { marchSkill: 150, driveSkill: 120, relief: 2 }) / 1000));
  eq(w.sent.filter((s) => s.cmd === 'army.getTroopParam').length, 1, 'held by Game.troopParams');
});
t('setCityTimer / cityTimingAllowed, per city', () => {
  const w = world();
  w.fn.setCityTimer('x');
  eq([w.fn.cityTimingAllowed('x', 60), w.fn.cityTimingAllowed('x', 0)], [false, true]);
  eq([w.fn.cityTimingAllowed('y', 60), w.fn.cityTimingAllowed('y', 60)], [true, false]);
  eq([w.fn.cityTimingAllowed('z', 60, true), w.fn.cityTimingAllowed('z', 60, true)], [true, true], 'test only looks');
  w.ctx.use('Other');
  eq(w.fn.cityTimingAllowed('y', 60), true, 'another city has its own clock');
  eq(F.cityTimers.allowed(1, 'x', 60, false, Date.now() + 61000), true);
});

// ---------------------------------------------------------------- constants
section('Constants');

t('ResourceId: RESOURCETYPE_* and ResourceNames (the Unsorted example)', () => {
  const res = fn.RESOURCETYPE_WOOD;
  eq('Resource type ' + res + ' is for ' + fn.ResourceNames[res], 'Resource type 1 is for Wood');
  eq([fn.RESOURCETYPE_FOOD, fn.RESOURCETYPE_STONE, fn.RESOURCETYPE_IRON], [0, 2, 3]);
});
t('BuildVersion passes NEAT version guards; BuildName and BuildDate are OTTObot\'s own', () => {
  assert.ok(!(fn.BuildVersion < '3167') && !(fn.BuildVersion < '3200') && fn.BuildVersion > 3400);
  assert.match(fn.BuildName, /^OTTObot Version \d{2}-\d{2}-\d{4}(\.[0-9a-f]{7})?$/);
  assert.match(fn.BuildDate, /^[A-Z][a-z]+ \d{1,2}, \d{4}$/);
  assert.ok(!/NEAT/i.test(fn.BuildName));
});
t('the type tables', () => {
  eq([fn.BuildingTypes.Academy, fn.BuildingTypes['Town Hall'], fn.BuildingTypes.TownHall, fn.BuildingTypes.Walls, fn.BuildingTypes.Warehouse], [25, 31, 31, 32, 3]);
  eq([fn.ResearchTypes.Archery, fn.ResearchTypes['Horseback Riding'], fn.ResearchTypes.Privateering], [14, 13, 20]);
  eq(fn.FieldTypes, { Forest: 1, Desert: 2, Hill: 3, Swamp: 4, Grassland: 5, Lake: 6, Flat: 10, Castle: 11, NPC: 12 });
  eq(fn.PlayerState, { peace: 1, truce: 2, beginner: 3, holiday: 5, dream: 6 });
  eq([fn.Abbreviations.troops.pult, fn.Abbreviations.fortifications.tre, fn.Abbreviations.research.sp, fn.Abbreviations.buildings.t], ['catapult', 'trebuchets', 'stockpile', 'town hall']);
});
t('SpeedUpItems echo as names and carry the item ids', () => {
  eq(String(fn.SpeedUpItems), 'Beginner Guidelines,Primary Guidelines,Intermediate Guidelines,Senior Guidelines,Master Guidelines,Ultimate Guidelines');
  eq(fn.SpeedUpItems.map((s) => s.id), ['consume.2.a', 'consume.2.b', 'consume.2.b.1', 'consume.2.c', 'consume.2.c.1', 'consume.2.d']);
  eq(JSON.parse(fn.json_encode(fn.SpeedUpItems[3])), { id: 'consume.2.c', name: 'Senior Guidelines', seconds: 28800 });
});
t('constants are frozen, and fresh for every run', () => {
  assert.throws(() => { fn.BuildingTypes.Academy = 1; }, TypeError);
  assert.throws(() => { fn.ResourceNames[0] = 'x'; }, TypeError);
  assert.throws(() => { fn.SpeedUpItems[0].id = 'x'; }, TypeError);
  assert.notStrictEqual(F.globals({}).BuildingTypes, fn.BuildingTypes);
  eq(fn.BuildingTypes.Academy, 25);
});
t('readOnly names the constants a script may not assign', () => {
  for (const k of ['BuildVersion', 'BuildDate', 'BuildName', 'PI', 'RESOURCETYPE_WOOD', 'ResourceNames', 'SpeedUpItems', 'FieldTypes']) assert.ok(F.readOnly.has(k), k);
  for (const k of ['max', 'date', 'GetFieldId']) assert.ok(!F.readOnly.has(k), k);
  for (const k of F.readOnly) assert.ok(k in fn, k + ' is a global');
});

// ---------------------------------------------------------------- coverage
section('Every global the wiki\'s examples call that belongs here');

t('each exists, with both spellings where NEAT renamed one', () => {
  const names = ['abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'cos', 'exp', 'floor', 'log', 'max', 'min', 'pow', 'random', 'round', 'sin', 'sqrt', 'tan',
    'isNaN', 'isFinite', 'CenterPad', 'LeftPad', 'RightPad', 'StringRepeat', 'Merge', 'Upper1', 'StringToObject', 'ToCSV',
    'FormatNumber', 'FormatNumber2', 'FormatPercent', 'FormatMiles', 'ParseInteger', 'PrepareParameters', 'GetResources', 'getResources',
    'date', 'TimeDiff', 'json_encode', 'xml', 'GetTroopsFromXML', 'GetFortsFromXML', 'GetResourcesFromXML',
    'GetFieldId', 'FieldIdToCoords', 'fieldIdToCompareString', 'FieldIdToCompareString', 'GetX', 'GetY', 'GetLevel', 'GetType', 'GetZoneName',
    'getX', 'getY', 'getLevel', 'getType', 'getZoneName', 'GetFieldType', 'GetFieldName', 'MapDistance', 'FormatDistance', 'StateCoords',
    'StateName', 'stateName', 'FindField', 'CastlesInRectangle', 'CastleInRectangle', 'MapCastles', 'AllCastles', 'SearchEnemyCastles',
    'GetDetailInfo', 'UpdateDetailInfo', 'updateDetailInfo', 'RelationIndex', 'ResetMap', 'getTravelTime', 'setCityTimer', 'cityTimingAllowed'];
  for (const n of names) assert.strictEqual(typeof fn[n], 'function', n);
  eq(typeof fn.String.fromCharCode, 'function');
});
t('no eval, Function constructor or vm in the module', () => {
  const src = fs.readFileSync(path.join(__dirname, 'script-functions.js'), 'utf8');
  assert.ok(!/\beval\s*\(|new\s+Function\b|require\(\s*['"]vm['"]\s*\)/.test(src));
});
t('with a fake cache set, db.js was never opened', () => {
  assert.ok(!require.cache[require.resolve('./db')], 'db.js was required');
  assert.ok(cache.calls > 0);
});

// ---------------------------------------------------------------- the real cache
section('The SQLite map cache (a scratch database)');

t('castles, flats and NPCs come out of map_cache the way the session writes them', async () => {
  F.setMapCache(null);
  const D = require('./db');
  assert.strictEqual(D.FILE, process.env.EVONY_DB, 'must be the scratch file');
  const now = Date.now();
  D.mapCache.upsertMany([
    { id: FID(460, 355), x: 460, y: 355, name: 'MyCity', userName: 'YayMe', allianceName: '123456', prestige: 10, honor: 1, npc: false, state: 1, furlough: false, mine: true, kind: 'player', typeName: 'Player city', level: 0, seen: now },
    { id: FID(461, 356), x: 461, y: 356, kind: 'flat', typeName: 'Flat', level: 3, npc: false, seen: now },
    { id: FID(456, 356), x: 456, y: 356, name: "Barbarian's city", npc: true, state: 1, kind: 'npc', typeName: 'NPC', level: 5, seen: now },
    { id: FID(462, 354), x: 462, y: 354, name: 'Far', userName: 'Zed', allianceName: 'Doom', prestige: 3, npc: false, state: 5, furlough: true, kind: 'player', seen: now },
    { id: FID(100, 100), x: 100, y: 100, name: 'Elsewhere', userName: 'Nobody', npc: false, kind: 'player', seen: now },
  ]);
  const w = world({ session: fakeSession([]) });
  eq((await w.fn.AllCastles(w.fn.GetFieldId(455, 350), w.fn.GetFieldId(465, 360))).map((c) => c.userName), ['Zed', 'YayMe'], 'by field id');
  eq(Object.keys(await w.fn.CastlesInRectangle(455, 350, 465, 360, false, true)).length, 3);
  eq(await w.fn.FindField(460, 355, 5, 10), [FID(461, 356)]);
  eq(await w.fn.FindField(460, 355, 5, 12, 5), [FID(456, 356)]);
  const zed = await w.fn.GetDetailInfo('462,354');
  eq([zed.userName, zed.furlough, w.fn.StateName(zed.state), zed.relation, zed.lastUpdated], ['Zed', true, 'holiday', 3, now]);
  eq((await w.fn.SearchEnemyCastles()).map((c) => c.userName), ['Zed']);
  eq(await w.fn.GetLevel('461,356'), 3);
  F.setMapCache(cache);
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
  try { if (require.cache[require.resolve('./db')]) require('./db').db.close(); } catch {}
  try { fs.rmSync(path.dirname(process.env.EVONY_DB), { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
