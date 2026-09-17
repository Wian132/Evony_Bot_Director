'use strict';
// script-cmd-info.js offline, through the real VM (script.parse + script.run):
// listbuffs, listitems, listmedals, listcommands, the map scans (scanmap,
// rescanmap, scanrec, rescanrec), findfield, get and find. The Game is real; its
// socket is a fake that answers common.mapInfoSimple from a made-up map, and the
// session is the real Session map reader on a bare object (Object.create), so
// what a scan sends and files is the console's own code. The map cache is a
// scratch SQLite file, the scripts folder a scratch folder, get's web fetch a stub.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-info-'));
process.env.EVONY_DB = path.join(TMP, 't.db');
process.env.EVONY_SCRIPTS_DIR = path.join(TMP, 'scripts');
const C = require('./constants');
const { Game } = require('./game');
const { Session } = require('./session');
const script = require('./script');
const FN = require('./script-functions');
const INFO = require('./script-cmd-info');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);
const F = (x, y) => C.coordsToFieldId(x, y);
const DAY = 86400000;

// ---------------------------------------------------------------- the map

// The wiki's findfield example: 38 level-10 hills within 20 miles of 423,246.
const WIKI_HILLS = ['422,241', '424,240', '423,239', '416,249', '424,238', '432,246', '429,255', '412,245', '434,249',
  '433,252', '427,235', '431,255', '435,242', '432,237', '432,255', '424,233', '431,235', '435,253', '418,233',
  '435,255', '437,252', '435,236', '416,232', '436,255', '436,237', '432,259', '439,249', '424,263', '424,229',
  '434,260', '441,243', '436,259', '419,228', '436,232', '435,261', '418,227', '404,240', '407,234'];
const WIKI_ATTACKS = `attack 422,241 any s:100000 //Distance: 5.09 Mission time: 01m:41
attack 424,240 any s:100000 //Distance: 6.08 Mission time: 02m:01
attack 423,239 any s:100000 //Distance: 7 Mission time: 02m:20
attack 416,249 any s:100000 //Distance: 7.61 Mission time: 02m:32
attack 424,238 any s:100000 //Distance: 8.06 Mission time: 02m:41
attack 432,246 any s:100000 //Distance: 9 Mission time: 03m:00
attack 429,255 any s:100000 //Distance: 10.81 Mission time: 03m:36
attack 412,245 any s:100000 //Distance: 11.04 Mission time: 03m:40
attack 434,249 any s:100000 //Distance: 11.4 Mission time: 03m:48
attack 433,252 any s:100000 //Distance: 11.66 Mission time: 03m:53
attack 427,235 any s:100000 //Distance: 11.7 Mission time: 03m:54
attack 431,255 any s:100000 //Distance: 12.04 Mission time: 04m:00
attack 435,242 any s:100000 //Distance: 12.64 Mission time: 04m:12
attack 432,237 any s:100000 //Distance: 12.72 Mission time: 04m:14
attack 432,255 any s:100000 //Distance: 12.72 Mission time: 04m:14
attack 424,233 any s:100000 //Distance: 13.03 Mission time: 04m:20
attack 431,235 any s:100000 //Distance: 13.6 Mission time: 04m:32
attack 435,253 any s:100000 //Distance: 13.89 Mission time: 04m:37
attack 418,233 any s:100000 //Distance: 13.92 Mission time: 04m:38
attack 435,255 any s:100000 //Distance: 15 Mission time: 05m:00
attack 437,252 any s:100000 //Distance: 15.23 Mission time: 05m:04
attack 435,236 any s:100000 //Distance: 15.62 Mission time: 05m:12
attack 416,232 any s:100000 //Distance: 15.65 Mission time: 05m:13
attack 436,255 any s:100000 //Distance: 15.81 Mission time: 05m:16
attack 436,237 any s:100000 //Distance: 15.81 Mission time: 05m:16
attack 432,259 any s:100000 //Distance: 15.81 Mission time: 05m:16
attack 439,249 any s:100000 //Distance: 16.27 Mission time: 05m:25
attack 424,263 any s:100000 //Distance: 17.02 Mission time: 05m:40
attack 424,229 any s:100000 //Distance: 17.02 Mission time: 05m:40
attack 434,260 any s:100000 //Distance: 17.8 Mission time: 05m:56
attack 441,243 any s:100000 //Distance: 18.24 Mission time: 06m:04
attack 436,259 any s:100000 //Distance: 18.38 Mission time: 06m:07
attack 419,228 any s:100000 //Distance: 18.43 Mission time: 06m:08
attack 436,232 any s:100000 //Distance: 19.1 Mission time: 06m:22
attack 435,261 any s:100000 //Distance: 19.2 Mission time: 06m:24
attack 418,227 any s:100000 //Distance: 19.64 Mission time: 06m:32
attack 404,240 any s:100000 //Distance: 19.92 Mission time: 06m:38
attack 407,234 any s:100000 //Distance: 20 Mission time: 06m:40
//Accumulated mission time: 2h:57m:46`.split('\n');

// Tile codes: [type][level] in hex (FieldConstants): 3a hill 10, 51 grassland 1,
// a3 flat 3, b1 castle, c5 NPC level 5.
function makeMap() {
  const tiles = new Map(), castles = new Map();
  const m = {
    tiles, castles,
    set(x, y, code) { tiles.set(x + ',' + y, code); return m; },
    castle(x, y, bean, code = bean.npc ? 'c5' : 'b1') { tiles.set(x + ',' + y, code); castles.set(F(x, y), { id: F(x, y), prestige: 0, honor: 0, state: 1, furlough: false, ...bean }); return m; },
    drop(x, y) { tiles.delete(x + ',' + y); castles.delete(F(x, y)); return m; },
    // the server's answer: at most 20x20 from x1,y1, echoing the rectangle (MapInfoSimpleResponse)
    block({ x1, y1 }) {
      const x2 = x1 + 19, y2 = y1 + 19;
      let s = '';
      for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) s += tiles.get(x + ',' + y) || '51';
      const cs = [...castles.values()].filter((c) => { const p = C.fieldIdToCoords(c.id); return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2; });
      return { ok: 1, x1, y1, x2, y2, mapStr: s, castles: cs.map((c) => ({ ...c })) };
    },
  };
  return m;
}
function homeMap() {
  const m = makeMap();
  for (const xy of WIKI_HILLS) { const [x, y] = xy.split(',').map(Number); m.set(x, y, '3a'); }
  m.set(425, 247, '39');                                   // a level-9 hill
  m.set(423, 267, '3a');                                   // level 10, but 21 miles out
  m.set(424, 244, 'a3');                                   // a flat
  m.castle(423, 246, { name: 'Home', userName: 'Tester', allianceName: 'Pals', prestige: 900 });
  m.castle(430, 250, { name: 'Bobville', userName: 'Bob', allianceName: 'Pals', prestige: 4991 });
  m.castle(426, 250, { name: "Barbarian's city", npc: true }, 'c5');
  m.castle(430, 246, { name: "Barbarian's city", npc: true }, 'c5');
  m.castle(420, 244, { name: "Barbarian's city", npc: true }, 'c3');
  return m;
}

// The game's socket: records what is sent and answers map requests on the next
// turn, unless `drop` says the server stays silent for that block.
function socket(map, { drop = () => false } = {}) {
  const c = new EventEmitter();
  c.sent = [];
  c.inflight = 0;
  c.maxInflight = 0;
  c.send = (cmd, data) => {
    c.sent.push({ cmd, data: { ...data } });
    if (cmd !== 'common.mapInfoSimple' || drop(data)) return;
    c.inflight++;
    c.maxInflight = Math.max(c.maxInflight, c.inflight);
    setImmediate(() => { c.inflight--; c.emit('cmd', cmd, map.block(data)); });
  };
  c.maps = () => c.sent.filter((s) => s.cmd === 'common.mapInfoSimple').map((s) => s.data);
  return c;
}

let accounts = 0;
// A real Game in a city at `home`; the session is Session's own code on a bare
// object (no constructor: that reads the login), connected unless told not.
function world({ map = homeMap(), home = [423, 246], session = true, connected = true, drop, reply } = {}) {
  const g = new Game();
  g.player = { playerInfo: { userName: 'Tester', alliance: 'Pals' }, buffs: [], items: [] };
  g.castles = [
    { id: 1, name: 'Home', fieldId: F(...home), heros: [], buffs: [] },
    { id: 2, name: 'Fla', fieldId: F(700, 700), heros: [] },
  ];
  g.marchSkillParam = 100;
  g.c = socket(map, { drop });
  g.c.sock = { destroyed: !connected };        // what Session.connected reads
  const reqs = [];
  g.req = async (cmd, data) => {
    reqs.push({ cmd, data: { ...data } });
    if (cmd === 'army.getTroopParam') return { ok: 1, marchSkillParam: 0, driveSkillParam: 0, loadSkillParam: 0, transportStationParam: 0 };
    if (cmd === 'common.mapInfoSimple') return reply ? reply(data) : map.block(data);
    return { ok: 1 };
  };
  let s;
  if (session) {
    s = Object.create(Session.prototype);
    Object.assign(s, { account: { id: 700 + ++accounts, server: 'ss9' }, game: g, diplo: null, notes: [], note(msg) { this.notes.push(msg); } });
  }
  return { g, s, map, sock: g.c, reqs };
}

async function run(w, src, opts = {}) {
  const acts = script.parse(src, { modules: opts.modules });
  const errs = acts.filter((a) => a.cmd === 'error');
  if (errs.length) throw new Error('refused: ' + errs.map((e) => `line ${e.line}: ${e.error}`).join('; '));
  const out = [], kept = [];
  const globals = { keep: (v) => { kept.push(v); return v; } };
  const done = await script.run(w.g, acts, (m) => out.push(m), {
    castle: 'Home', repeatGapMs: 0, scanGapMs: 0, scanTimeoutMs: 250, session: w.s, globals, ...opts,
  });
  return { done, out, text: out.join('\n'), kept };
}
const errsOf = (src) => script.parse(src).filter((a) => a.cmd === 'error').map((a) => a.error);
const viewOf = (line) => script.parseLine(line);
const blockKeys = (list) => list.map((d) => `${d.x1},${d.y1}`).sort();

// ---------------------------------------------------------------------------
section('find (kept) — before any scan, the cache is empty');

t('find with no map cache says to scan first', async () => {
  const r = await run(world(), 'find Bob\nkeep($error)');
  assert.match(r.text, /no map cache yet — scan the map first:  scanmap <x,y> <radius>/);
  assert.match(r.kept[0], /no map cache/);
});

// ---------------------------------------------------------------------------
section('every usage and example line on the wiki pages parses');

const STATES = [['Friesland', '0,0 199,199'], ['Saxony', '200,0 399,199'], ['North March', '400,0 599,199'], ['Bohemia', '600,0 799,199'],
  ['Lower Lorraine', '0,200 199,399'], ['Franconia', '200,200 399,399'], ['Thuringia', '400,200 599,399'], ['Moravia', '600,200 799,399'],
  ['Upper Lorraine', '0,400 199,599'], ['Swabia', '200,400 399,599'], ['Bavaria', '400,400 599,599'], ['Carinthia', '600,400 799,599'],
  ['Burgundy', '0,600 199,799'], ['Lombardy', '200,600 399,799'], ['Tuscany', '400,600 599,799'], ['Romagna', '600,600 799,799']];

t('ScanMap, RescanMap, ScanRec, RescanRec: the usage examples and all 16 states', () => {
  for (const w of ['scanmap', 'rescanmap', 'scanrec', 'rescanrec']) {
    const src = STATES.map(([name, r]) => `//${name}\n${w} ${r}`).join('\n');
    eq(errsOf(src), [], w);
    eq(viewOf(`${w} 0,0 799,799`).area, { x1: 0, y1: 0, x2: 799, y2: 799, label: '0,0 799,799' });
    eq(viewOf(`${w} 400,200 599,399`).area.label, '400,200 599,399');
    eq(INFO.areaBlocks(viewOf(`${w} 400,200 599,399`).area).length, 100, 'a state is 10x10 blocks');
  }
  eq(viewOf('scanmap 111,222 30').area, { cx: 111, cy: 222, r: 30, label: '111,222 radius 30' });
  eq(viewOf('rescanmap 111,222 30').fresh, true);
  eq(viewOf('scanmap 111,222 30').fresh, false);
  eq(viewOf('ScanMap 111,222 30').cmd, 'scanmap', 'any case');
});

t('the MapFunctions and StateCoords lines that build a scan at run time parse', () => {
  eq(errsOf('radius = 20\nexecute "rescanmap {city.coords} {radius}"'), []);
  eq(errsOf('distance = 5\nexecute "rescanrec {city.x - distance},{city.y - distance} {city.x + distance},{city.y + distance}"'), []);
  eq(errsOf('state = "Lombardy"\ncoords = StateCoords(state)\nif !coords die "Unknown state name \'{state}\'"\nexecute "scanmap {coords}"'), []);
  eq(errsOf('scanrec 0,0 199,199\ncastles = AllCastles(GetFieldId(0,0),GetFieldId(199,199))'), []);
});

t('a bad area is refused before the run, saying what to write', () => {
  assert.match(errsOf('scanrec 111,222 30')[0], /scanrec: usage {2}scanrec x1,y1 x2,y2 .*top-left and bottom-right/);
  assert.match(errsOf('scanmap 111,222')[0], /scanmap: usage {2}scanmap x,y radius \| scanmap x1,y1 x2,y2/);
  assert.match(errsOf('scanmap 5000,1 10')[0], /the map runs 0,0 to 799,799/);
  assert.match(errsOf('rescanrec here there')[0], /usage/);
  eq(viewOf('scanrec 199,199 0,0').area.label, '0,0 199,199', 'corners given the wrong way round');
  eq(viewOf('scanmap 400,400 900').area.r, 400, 'a radius past the whole map is the whole map');
});

t('findfield: the three wiki examples, and what is wrong with a bad one', () => {
  const a = viewOf('findfield npc 5 10');
  eq([a.type, a.level, a.radius, a.hero], [12, 5, 10, undefined]);
  eq(viewOf('findfield npc 0 10').level, 0);
  const h = viewOf('findfield hill 10 20 any s:100000');
  eq([h.type, h.level, h.radius, h.hero, h.troopText, h.troops], [3, 10, 20, 'any', 's:100000', { scouter: 100000 }]);
  for (const [word, type] of [['Castle', 11], ['NPC', 12], ['Forest', 1], ['Desert', 2], ['Hill', 3], ['Swamp', 4], ['Grassland', 5], ['Lake', 6], ['Flat', 10]]) {
    eq(viewOf(`findfield ${word} 0 5`).type, type, word);
  }
  assert.match(errsOf('findfield volcano 1 5')[0], /"volcano" is no field type — castle, npc, forest/);
  assert.match(errsOf('findfield hill 10 20 any')[0], /the troops go after the hero/);
  assert.match(errsOf('findfield hill x 20')[0], /the level is a number, 0 for any level/);
  assert.match(errsOf('findfield hill 10 far')[0], /the radius is a number of miles/);
  assert.match(errsOf('findfield hill 10 20 any s:lots')[0], /findfield: bad troop string: s:lots/);
  assert.match(errsOf('findfield')[0], /usage {2}findfield <type> <level> <radius>/);
  eq(errsOf('list = FindField(city.x,city.y,20,12,10).sort(city.compareByDistanceToCastle)'), [], 'the function is untouched');
});

t('ListBuffs, ListCommands, ListItems, ListMedals as the wiki writes them', () => {
  eq(errsOf('ListBuffs\nListCommands\nListItems\nListMedals\nlistcommands scan'), []);
  assert.match(errsOf('listbuffs now')[0], /listbuffs: nothing goes after it/);
  assert.match(errsOf('listcommands a b')[0], /one word at most/);
});

t('XML: the four examples and NewCityScript parse', () => {
  const U = 'http://battleXXXXX.evony.com/logfile/20150810/AA/BB/ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ.xml';
  eq(errsOf(`url = "${U}"\nget url\nif $error die "Failed to load the xml file {url}."\nreport = xml($result)`), []);
  eq(errsOf(`url = "${U}"\nget url\nif $error die "Failed to load the XML file {url}."\nreport = xml($result)\nforts = GetFortsFromXML(report.scoutReport.scoutInfo.fortifications.fortificationsType)`), []);
  eq(errsOf(`url = "${U}"\nget url\nif $error end\nreport = xml($result)\ntroops = GetTroopsFromXML(report.scoutReport.scoutInfo.troops.troopStrType)`), []);
  eq(errsOf(`// requires valid report url with "default.html?" removed\n     url = "${U}"\n     get url\n     if $error end\n     report = xml($result)\n     res = GetResourcesFromXML(report.battleReport.lootResource)\n     if res echo "Resources: " + res`), []);
  eq(errsOf('// Set some temporary goals\n@get "NewCityGoals.txt"\nif $error == null goal $result'), []);
  eq(viewOf('get "NewCityGoals.txt"'), { cmd: 'get', expr: '"NewCityGoals.txt"' });
  eq(viewOf('get url').expr, 'url');
  assert.match(errsOf('get http://example.com/a.xml')[0], /put the address in quotes/);
  assert.match(errsOf('get')[0], /get: usage/);
});

// ---------------------------------------------------------------------------
section('listbuffs');

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const dhms = (d, h, m, s) => ((d * 24 + h) * 60 + m) * 60000 + s * 1000;

t('one BUFFS line a buff with the time left, NEAT style; the city\'s after the account\'s', async () => {
  const w = world();
  w.g.now = () => NOW;
  w.g.player.buffs = [
    { typeId: 'IncDefenseBuff', descName: "Enhance army's Defence by 20%.", endTime: NOW + dhms(177, 7, 29, 18) },
    { typeId: 'IncWoodBuff', descName: 'Enhance Lumber production by 25%.', endTime: NOW + dhms(251, 6, 8, 34) },
    { typeId: 'IncAttackBuff', descName: "Enhance army's Attack by 20%.", endTime: NOW + 3.5 * 365 * DAY },
    { typeId: 'IncStoneBuff', descName: 'Enhance Stone production by 25%.', endTime: NOW + 400 * DAY },
    { typeId: 'IncGoldBuff', descName: 'Enhance Tax Revenue by 100%.', endTime: NOW + dhms(0, 0, 4, 5) },
    { typeId: 'OldBuff', descName: 'gone', endTime: NOW - 1000 },
    { typeId: 'ForeverBuff', descName: 'No end', endTime: 0 },
  ];
  w.g.castles[0].buffs = [{ typeId: 'ForceopenclosegateBuff', descName: 'Gates forced open', endTime: NOW + dhms(0, 2, 0, 0) }];
  const r = await run(w, 'listbuffs\nkeep($result)\nkeep($error)\necho $result[1]\nkeep($result[0].expiresIn)');
  const lines = r.out.filter((l) => /^ {2}BUFFS: /.test(l)).map((l) => l.slice(2));
  eq(lines, [
    "BUFFS: Enhance army's Defence by 20%. (expires in 177d:7h:29m:18)",
    'BUFFS: Enhance Lumber production by 25%. (expires in 251d:6h:08m:34)',
    "BUFFS: Enhance army's Attack by 20%. (expires in More than 3 years)",
    'BUFFS: Enhance Stone production by 25%. (expires in More than a year)',
    'BUFFS: Enhance Tax Revenue by 100%. (expires in 04m:05)',
    'BUFFS: No end',
    'BUFFS: [Home] Gates forced open (expires in 2h:00m:00)',
  ]);
  const rows = r.kept[0];
  eq(rows.length, 7);
  eq({ ...rows[6] }, { typeId: 'ForceopenclosegateBuff', descName: 'Gates forced open', endTime: NOW + 7200000, expiresIn: 7200, city: 'Home' });
  eq(r.kept[1], null, '$error is null after it worked');
  assert.ok(r.out.includes('  Enhance Lumber production by 25%. (expires in 251d:6h:08m:34)'), 'a row echoes as its line');
  eq(r.kept[2], dhms(177, 7, 29, 18) / 1000);
});

t('no buffs: BUFFS: none and an empty list', async () => {
  const r = await run(world(), 'listbuffs\nkeep($result)');
  assert.match(r.text, / {2}BUFFS: none/);
  eq(r.kept[0], []);
});

// ---------------------------------------------------------------------------
section('listitems, listmedals');

t('Items: every item held on one line, server order; Medals: the loyalty medals only', async () => {
  const w = world();
  w.g.player.items = [
    { id: 'hero.loyalty.7', count: 94 }, { id: 'consume.2.b', count: 10 }, { id: 'hero.loyalty.6', count: 117 },
    { id: 'no.such.item.xyz', count: 3 }, { id: 'hero.loyalty.4', count: 0 }, { id: 'hero.loyalty.1', count: 135 },
  ];
  const inv = require('./items').inventory(w.g).items;
  const r = await run(w, 'listitems\nkeep($result)\nlistmedals\nkeep($result)\necho $result');
  const want = inv.map((x) => `${x.count} ${x.name}`).join(', ');
  assert.ok(r.out.includes(`  Items: ${want}`), r.text);
  assert.ok(r.out.includes('  Medals: 94 Freedom Medal, 117 Wisdom Medal, 135 Cross Medal'), r.text);
  eq(r.kept[0].map((x) => x.id), ['hero.loyalty.7', 'consume.2.b', 'hero.loyalty.6', 'no.such.item.xyz', 'hero.loyalty.1'], 'none of 0 held');
  eq({ ...r.kept[1][0] }, { id: 'hero.loyalty.7', name: 'Freedom Medal', count: 94, category: 'Medal', medal: true });
  assert.ok(r.out.includes('  94 Freedom Medal,117 Wisdom Medal,135 Cross Medal'), 'the list echoes as its lines');
  assert.ok(r.text.includes('3 no.such.item.xyz'), 'an item the catalogue does not know shows its id');
});

t('nothing held: Items: none, Medals: none', async () => {
  const r = await run(world(), 'listitems\nlistmedals');
  assert.match(r.text, / {2}Items: none/);
  assert.match(r.text, / {2}Medals: none/);
});

// ---------------------------------------------------------------------------
section('listcommands');

t('NEAT\'s *** line from the run\'s own registry, then each usage', async () => {
  const poke = { commands: { poke: { usage: 'poke <who>', aliases: ['prod'], parse: (args) => ({ args }), run: async () => ({}) } } };
  const r = await run(world(), 'listcommands\nkeep($result)', { modules: [poke] });
  const star = r.out.find((l) => l.startsWith('  *** '));
  assert.ok(star && star.endsWith(' ***'), r.text);
  const names = star.slice(6, -4).split(', ');
  for (const n of ['scanmap', 'rescanmap', 'scanrec', 'rescanrec', 'findfield', 'listbuffs', 'listitems', 'listmedals', 'listcommands', 'get', 'find', 'train', 'sell', 'poke']) {
    assert.ok(names.includes(n), `${n} missing from ${star}`);
  }
  assert.ok(!names.includes('construct'), 'a command no line starts is not listed');
  assert.ok(r.out.includes('  poke <who>   (also: prod)'));
  assert.ok(r.out.includes('  scanmap x,y radius | scanmap x1,y1 x2,y2'));
  assert.ok(r.out.some((l) => /^ {2}language: label goto gosub/.test(l)));
  const rows = r.kept[0];
  const poked = rows.find((x) => x.name === 'poke');
  eq([poked.usage, poked.words, poked.inline], ['poke <who>', ['poke', 'prod'], false]);
});

t('listcommands <word> shows only the commands that hold it; none is an error', async () => {
  const r = await run(world(), 'listcommands scan\nkeep($result)\nlistcommands zzzq\nkeep($error)');
  eq(r.kept[0].map((x) => x.name).sort(), ['rescanmap', 'rescanrec', 'scanmap', 'scanrec']);
  assert.ok(!r.out.some((l) => l.startsWith('  *** ')), 'no *** line for a filtered list');
  assert.match(r.kept[1], /no command has "zzzq" in its name/);
});

// ---------------------------------------------------------------------------
section('scanmap, scanrec (the console session\'s own map reader)');

t('scanmap x,y radius reads the square of aligned 20x20 blocks, 9 on the wire at most, and files it', async () => {
  const w = world();
  const r = await run(w, 'scanmap 423,246 30\nkeep($result)\nkeep($error)\nhills = FindField(423, 246, 20, 3, 10)\nkeep(hills.length)');
  const sent = w.sock.maps();
  eq(blockKeys(sent), ['380,200', '380,220', '380,240', '380,260', '400,200', '400,220', '400,240', '400,260',
    '420,200', '420,220', '420,240', '420,260', '440,200', '440,220', '440,240', '440,260']);
  for (const d of sent) eq([d.x2 - d.x1, d.y2 - d.y1], [19, 19], 'CommonCommands.mapInfoSimple(x1, y1, x2, y2): 20x20');
  assert.ok(w.sock.maxInflight <= 9, `at most 9 on the wire, saw ${w.sock.maxInflight}`);
  eq(blockKeys(sent.slice(0, 1)), ['420,240'], 'the block at the middle first');
  assert.ok(r.out.includes('  SCAN COMPLETED: 423,246 radius 30'), r.text);
  assert.ok(r.out.includes('  16 blocks: 16 read — 2 castles, 3 NPCs in the blocks read'), r.text);
  const sum = r.kept[0];
  eq({ ...sum }, { area: '423,246 radius 30', blocks: 16, read: 16, known: 0, failed: 0, castles: 2, npcs: 3, stopped: false });
  eq(String(sum), 'SCAN COMPLETED: 423,246 radius 30');
  eq(r.kept[1], null);
  eq(r.kept[2], 38, 'FindField sees the scanned hills (valleys from the session\'s blocks)');
  eq(w.s.mapStore().blocks.size, 16);
  eq(r.done, 1, 'a scan counts as one action');
  // castles, NPCs and flats went to the saved cache too (Session.mapBatch)
  const D = require('./db');
  const bob = D.mapCache.search('Bob', 5);
  eq(bob.map((b) => [b.x, b.y, b.userName]), [[430, 250, 'Bob']]);
});

t('blocks already read are not asked again; scanrec takes the corners', async () => {
  const w = world();
  await run(w, 'scanmap 423,246 30');
  const before = w.sock.maps().length;
  const r = await run(w, 'scanmap 423,246 30\nkeep($result)\nscanrec 400,240 439,279\nkeep($result)\nscanrec 440,240 479,279\nkeep($result)');
  eq(r.kept[0].known, 16);
  eq(r.kept[0].read, 0);
  assert.ok(r.out.includes('  16 blocks: 0 read, 16 already read — 0 castles, 0 NPCs in the blocks read'), r.text);
  eq([r.kept[1].blocks, r.kept[1].known], [4, 4], 'scanrec 400,240 439,279 is four known blocks');
  eq([r.kept[2].blocks, r.kept[2].known, r.kept[2].read], [4, 2, 2]);
  eq(blockKeys(w.sock.maps().slice(before)), ['460,240', '460,260'], 'only the two new blocks went out');
  eq(r.done, 1, 'only the scan that read something counts');
});

t('an area over the map\'s edge wraps round, as the game\'s map does', async () => {
  const w = world();
  const r = await run(w, 'rescanrec -3,350 7,360\nscanmap 5,795 10\nkeep($result)');
  eq(blockKeys(w.sock.maps().slice(0, 4)), ['0,340', '0,360', '780,340', '780,360']);
  eq(blockKeys(w.sock.maps().slice(4)), ['0,0', '0,780', '780,0', '780,780']);
  eq(r.kept[0].blocks, 4);
});

t('pacing: opts.scanGapMs between batches of 9', async () => {
  const w = world();
  const t0 = Date.now();
  await run(w, 'scanrec 0,0 99,99', { scanGapMs: 60 });    // 25 blocks: 9, 9, 7
  const took = Date.now() - t0;
  eq(w.sock.maps().length, 25);
  assert.ok(took >= 110, `two gaps of 60 ms, took ${took} ms`);
});

t('Stop cuts a big scan short and ends the run', async () => {
  const w = world();
  const r = await run(w, 'scanrec 0,0 199,199\necho "not reached"', { shouldStop: () => w.sock.maps().length >= 9, scanGapMs: 20 });
  eq(w.sock.maps().length, 9, 'one batch, then Stop');
  assert.match(r.text, /stopped after 9 of 100 blocks/);
  assert.ok(!r.text.includes('not reached'));
});

t('a block the server does not answer: $error says so, the rest is read', async () => {
  const w = world({ drop: (d) => d.x1 === 440 && d.y1 === 260 });
  const r = await run(w, 'scanmap 423,246 30\nkeep($error)\nkeep($result)');
  assert.match(r.kept[0], /^1 of 16 blocks did not answer — run it again for the rest$/);
  eq([r.kept[1].read, r.kept[1].failed], [15, 1]);
  assert.match(r.text, /no answer for the blocks at 440,260/);
  // run again: only the missing block goes out
  w.sock.sent.length = 0;
  const r2 = await run(Object.assign(w, {}), 'scanmap 423,246 30\nkeep($result)');
  eq(blockKeys(w.sock.maps()), ['440,260']);
  eq(r2.kept[0].known, 15);
});

t('offline console: the scan fails and says why; nothing is sent', async () => {
  const w = world({ connected: false });
  const r = await run(w, 'scanmap 423,246 10\nkeep($error)');
  eq(w.sock.sent.length, 0);
  assert.match(r.kept[0], /the console is not connected to the game — a scan reads the map over its connection, and a script never logs in/);
});

t('dry run: says what it would read and sends nothing', async () => {
  const w = world();
  const r = await run(w, 'scanmap 423,246 30\nrescanrec 0,0 199,199', { dryRun: true });
  eq(w.sock.sent.length + w.reqs.length, 0);
  assert.match(r.text, /423,246 radius 30: would read 16 of 16 blocks of 20x20\n {2}\[dry run\] not sent/);
  assert.match(r.text, /0,0 199,199: would read 100 of 100 blocks of 20x20, forgetting what is known there first/);
});

// ---------------------------------------------------------------------------
section('rescanmap, rescanrec: ResetMap, then read again');

t('rescanmap reads every block again and a castle that has gone drops out', async () => {
  const w = world();
  await run(w, 'scanmap 423,246 30');
  eq(w.sock.maps().length, 16);
  w.map.drop(430, 250).castle(431, 251, { name: 'Bobville', userName: 'Bob', allianceName: 'Pals' });
  const r = await run(w, 'rescanmap 423,246 30\nkeep($result)\nc = CastlesInRectangle(425, 245, 435, 255)\nkeep(c)\nkeep(FindField(423, 246, 20, 3, 10).length)');
  eq(w.sock.maps().length, 32, 'all 16 again');
  eq(r.kept[0].read, 16);
  eq(r.kept[1].map((b) => b.coords), ['431,251'], 'the old tile is hidden (it is still in the saved cache)');
  eq(r.kept[2], 38);
  const D = require('./db');
  eq(D.mapCache.search('Bobville', 5).map((b) => `${b.x},${b.y}`).sort(), ['430,250', '431,251'], 'the saved cache keeps both');
});

t('a big rescan forgets and re-reads 6x6 blocks at a time', async () => {
  const w = world();
  const resets = [];
  const orig = FN.resetMap;
  FN.resetMap = (ctx, ...a) => { resets.push({ a, sentBefore: w.sock.maps().length }); return orig(ctx, ...a); };
  let r;
  try {
    r = await run(w, 'rescanrec 0,0 199,199');
  } finally { FN.resetMap = orig; }
  eq(w.sock.maps().length, 100);
  eq(r.out.filter((l) => /^ {2}\d+% — \d+ of 100 blocks$/.test(l)).length, 3, 'progress at 25, 50 and 75%');
  eq(resets.map((x) => x.a).sort((p, q) => p[0] - q[0] || p[1] - q[1]),
    [[0, 0, 120, 120], [0, 120, 120, 80], [120, 0, 80, 120], [120, 120, 80, 80]]);
  eq(resets.map((x) => x.sentBefore), [0, 36, 60, 84], 'each chunk just before it is read');
});

t('a rescan stopped part-way says which forgotten blocks were not read again', async () => {
  const w = world();
  const r = await run(w, 'rescanrec 0,0 199,199', { shouldStop: () => w.sock.maps().length >= 9 });
  eq(w.sock.maps().length, 9);
  assert.match(r.text, /stopped after 9 of 100 blocks/);
  assert.match(r.text, /27 blocks were forgotten and not read again: what was known there stays hidden until a scan reads it/);
});

// ---------------------------------------------------------------------------
section('without the console\'s session: game.req, a block at a time');

t('scanrec sends common.mapInfoSimple through game.req and fills the saved cache', async () => {
  const map = homeMap().castle(505, 505, { name: 'Far', userName: 'Zed', allianceName: 'Doom' });
  const w = world({ map, session: false });
  const r = await run(w, 'scanrec 500,500 519,519\nkeep($result)\nscanrec 500,500 519,519\nkeep($result)');
  eq(w.reqs.filter((q) => q.cmd === 'common.mapInfoSimple').map((q) => q.data), [{ x1: 500, y1: 500, x2: 519, y2: 519 }]);
  eq(w.sock.sent.length, 0);
  eq([r.kept[0].read, r.kept[1].known], [1, 1], 'the second is known');
  eq(require('./db').mapCache.search('Zed', 5).map((b) => [b.x, b.y, b.kind]), [[505, 505, 'player']]);
});

t('Stop cuts a block-at-a-time batch short', async () => {
  const w = world({ session: false });
  const maps = () => w.reqs.filter((q) => q.cmd === 'common.mapInfoSimple').length;
  const r = await run(w, 'scanrec 600,0 699,99\necho "not reached"', { shouldStop: () => maps() >= 3 });
  eq(maps(), 3);
  assert.match(r.text, /stopped after 3 of 25 blocks/);
  assert.ok(!r.text.includes('not reached'));
});

t('a reply for another rectangle is no answer', async () => {
  const w = world({ session: false, reply: (d) => ({ ok: 1, x1: d.x1 + 20, y1: d.y1, mapStr: '51'.repeat(400), castles: [] }) });
  const r = await run(w, 'scanrec 600,600 619,619\nkeep($error)');
  assert.match(r.kept[0], /1 of 1 blocks did not answer/);
});

// ---------------------------------------------------------------------------
section('findfield');

t('findfield hill 10 20 any s:100000 prints the wiki\'s attack script', async () => {
  const w = world();
  const r = await run(w, 'findfield hill 10 20 any s:100000\nkeep($result)\nkeep($error)');
  eq(blockKeys(w.sock.maps()), ['400,220', '400,240', '400,260', '420,220', '420,240', '420,260', '440,220', '440,240', '440,260'],
    'it scans the radius first');
  assert.ok(r.out.includes('  Found 38 hill level 10 within a 20-mile radius around 423,246'), r.text);
  assert.ok(r.out.includes('  Copy and paste this into the script window'));
  const lines = r.out.filter((l) => /^ {2}(attack |\/\/Accumulated)/.test(l)).map((l) => l.slice(2));
  eq([...lines].sort(), [...WIKI_ATTACKS].sort(), 'the same 38 lines and total as the wiki');
  eq(lines[lines.length - 1], '//Accumulated mission time: 2h:57m:46');
  const d = lines.slice(0, -1).map((l) => Number(/Distance: ([\d.]+)/.exec(l)[1]));
  eq(d, [...d].sort((a, b) => a - b), 'nearest first');
  eq(r.kept[0], lines.join('\n'), '$result is the script');
  eq(script.parse(r.kept[0]).filter((a) => a.cmd === 'error'), [], 'and it reads as a script');
  eq(r.kept[1], null);
  assert.ok(w.reqs.some((q) => q.cmd === 'army.getTroopParam' && q.data.castleId === 1), 'the city\'s march skill (ArmyCommands.getTroopParam)');
  eq(r.done, 1, 'its scan counts as one action');
});

t('findfield npc 5 10 lists the level-5 camps nearest first; level 0 is any level; $result is the field ids', async () => {
  const w = world();
  const r = await run(w, 'findfield npc 5 10\nkeep($result)\nfindfield npc 0 10\nkeep($result)\nfindfield hill 0 3\nkeep($result)');
  assert.ok(r.out.includes('  Found 2 npc level 5 within a 10-mile radius around 423,246'), r.text);
  assert.ok(r.out.includes('  426,250  NPC level 5  (5 miles)'), r.text);
  assert.ok(r.out.includes('  430,246  NPC level 5  (7 miles)'));
  eq(r.kept[0], [F(426, 250), F(430, 246)]);
  assert.ok(r.out.includes('  Found 3 npc of any level within a 10-mile radius around 423,246'));
  eq(r.kept[1], [F(420, 244), F(426, 250), F(430, 246)]);
  eq(r.kept[2], [F(425, 247)], 'the level-9 hill 2.23 miles out');
  assert.ok(r.out.includes('  425,247  Hill level 9  (2.23 miles)'));
});

t('findfield castle 0 10 names the lords', async () => {
  const r = await run(world(), 'findfield castle 0 10');
  assert.ok(r.out.includes('  423,246  Home — Tester (Pals)  (0 miles)'), r.text);
  assert.ok(r.out.includes('  430,250  Bobville — Bob (Pals)  (8.06 miles)'), r.text);
});

t('findfield reaches round the map\'s edge', async () => {
  const map = makeMap().set(795, 5, '3a').set(8, 790, '3a');
  const w = world({ map, home: [5, 5] });
  const r = await run(w, 'findfield hill 10 12\nkeep($result)');
  eq(r.kept[0], [F(795, 5)], '10 miles west, over the edge');
  assert.ok(w.sock.maps().some((d) => d.x1 === 780 && d.y1 === 0));
});

t('dry run: the map is not read; what is known is searched', async () => {
  const w = world();
  await run(w, 'scanmap 423,246 30');
  const n = w.sock.maps().length;
  const r = await run(w, 'findfield npc 5 10\nkeep($result)', { dryRun: true });
  eq(w.sock.maps().length, n);
  assert.match(r.text, /\[dry run\] the map is not read — this searches what is already known/);
  eq(r.kept[0], [F(426, 250), F(430, 246)]);
});

t('offline: findfield says so and searches the saved cache', async () => {
  const w = world({ connected: false });
  const r = await run(w, 'findfield npc 5 10\nkeep($result)\nkeep($error)');
  assert.match(r.text, /the console is not connected to the game .* — searching what is already known/);
  eq(r.kept[0], [F(426, 250), F(430, 246)], 'the camps are in the saved cache from the scans above');
  eq(r.kept[1], null);
});

// ---------------------------------------------------------------------------
section('get');

const SCRIPTS = process.env.EVONY_SCRIPTS_DIR;
fs.mkdirSync(path.join(SCRIPTS, 'sub'), { recursive: true });
fs.writeFileSync(path.join(SCRIPTS, 'hello.txt'), '\uFEFFline one\nline two');
fs.writeFileSync(path.join(SCRIPTS, 'sub', 'deep.txt'), 'deep');

const SCOUT = '<?xml version="1.0" encoding="UTF-8"?><reportData><scoutReport isAttack="true" isSuccess="true"><scoutInfo heroName="W">'
  + '<fortifications><fortificationsType typeId="14" count="1000"/><fortificationsType typeId="16" count="250"/></fortifications>'
  + '<troops><troopStrType typeId="7" count="99500"/><troopStrType typeId="4" count="1000"/></troops></scoutInfo></scoutReport></reportData>';
const BATTLE = '<reportData><battleReport isAttack="true" round="4"><lootResource gold="81234" food="512000" wood="0"/></battleReport></reportData>';

function fetcher(pages) {
  const asked = [];
  INFO.setUrlFetcher(async (url) => {
    asked.push(url);
    if (!(url in pages)) throw new Error('battle1.evony.com answered 404 (no such page — a battle log may have expired)');
    return pages[url];
  });
  return asked;
}

t('get "<file>" reads the console\'s scripts folder: $result the text, $error null', async () => {
  const r = await run(world(), 'get "hello.txt"\nkeep($result)\nkeep($error)\nget "sub/deep.txt"\nkeep($result)\n@get "sub\\\\deep.txt"\nkeep($result)');
  eq(r.kept, ['line one\nline two', null, 'deep', 'deep']);
  assert.match(r.text, / {2}-> hello\.txt: 2 lines/);
});

t('get <expression> is read in the line\'s own scope: a function\'s argument', async () => {
  const r = await run(world(), 'function load(u)\nget u\nreturn $result\nendfunction\nx = load("hello.txt")\nkeep(x)\nf = "sub"\nget f + "/deep.txt"\nkeep($result)');
  eq(r.kept, ['line one\nline two', 'deep']);
});

t('a missing file, .., a full path, a device name: $error says why', async () => {
  const r = await run(world(), 'get "nothere.txt"\nkeep($error)\nget "../t.db"\nkeep($error)\nget "C:\\\\Windows\\\\win.ini"\nkeep($error)\nget "nul.txt"\nkeep($error)');
  eq(r.kept[0], `no file nothere.txt in ${SCRIPTS}`);
  assert.match(r.kept[1], /no \.\. or \. in the name/);
  assert.match(r.kept[2], /not a full path/);
  assert.match(r.kept[3], /device name/);
});

t('XML: get url, xml($result) and GetTroopsFromXML, as on the wiki', async () => {
  const U = 'http://battleXXXXX.evony.com/logfile/20150810/AA/BB/ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ.xml';
  const asked = fetcher({ [U]: SCOUT });
  try {
    const r = await run(world(), `url = "${U}"\nget url\nif $error die "Failed to load the xml file {url}."\nreport = xml($result)\n`
      + 'troops = GetTroopsFromXML(report.scoutReport.scoutInfo.troops.troopStrType)\nkeep(troops.archer)\nkeep(troops.scouter)\n'
      + 'forts = GetFortsFromXML(report.scoutReport.scoutInfo.fortifications.fortificationsType)\nkeep(forts)');
    eq(asked, [U]);
    eq([r.kept[0], r.kept[1]], [99500, 1000]);
    assert.ok(Object.values(r.kept[2]).includes(1000));
    assert.ok(!/die/.test(r.text), r.text);
  } finally { INFO.setUrlFetcher(null); }
});

t('XML: GetResourcesFromXML from a battle report; {expr} in the address', async () => {
  const U = 'http://battle1.evony.com/logfile/20150710/AA/BB/Z1.xml';
  const asked = fetcher({ [U]: BATTLE });
  try {
    const r = await run(world(), '// requires valid report url with "default.html?" removed\n     n = 1\n     get "http://battle{n}.evony.com/logfile/20150710/AA/BB/Z1.xml"\n'
      + '     if $error end\n     report = xml($result)\n     res = GetResourcesFromXML(report.battleReport.lootResource)\n     if res echo "Resources: " + res\n     keep(res.gold)');
    eq(asked, [U]);
    eq(r.kept[0], 81234);
    assert.match(r.text, / {2}Resources: /);
  } finally { INFO.setUrlFetcher(null); }
});

t('a page that is not there: $error, and the wiki\'s die line ends the script', async () => {
  fetcher({});
  try {
    const r = await run(world(), 'url = "http://battle1.evony.com/x.xml"\nget url\nkeep($error)\nif $error die "Failed to load the xml file {url}."\necho "not reached"');
    assert.match(r.kept[0], /answered 404/);
    assert.match(r.text, /die — Failed to load the xml file http:\/\/battle1\.evony\.com\/x\.xml\./);
    assert.ok(!r.text.includes('not reached'));
  } finally { INFO.setUrlFetcher(null); }
});

t('get reaches only the public internet (script-net.js); the fetcher is not even asked', async () => {
  const asked = fetcher({});
  try {
    const home = ['http://localhost:8711/api/map', 'http://127.0.0.1/x', 'http://192.168.1.5/x', 'http://10.1.2.3/x', 'http://[::1]:8711/',
      'https://api.localhost/x', 'http://[::ffff:127.0.0.1]:8711/x', 'http://[::ffff:7f00:1]/', 'http://[::ffff:10.0.0.1]/',
      'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f.1/'];
    const never = ['http://169.254.169.254/latest', 'http://[::ffff:169.254.169.254]/latest', 'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', 'http://[fe80::1]/'];
    const scheme = ['ftp://example.com/a.txt', 'file:///C:/Windows/win.ini'];
    const bad = [...home, ...never, ...scheme];
    const r = await run(world(), bad.map((u) => `get "${u}"\nkeep($error)`).join('\n'));
    eq(asked, []);
    bad.forEach((u, i) => assert.match(String(r.kept[i]), i < home.length ? /this machine or its own network/
      : i < home.length + never.length ? /not an address on the public internet/ : /only http:\/\/ and https:\/\/ addresses/, u));
  } finally { INFO.setUrlFetcher(null); }
});

t('the real fetch path: no form of this machine reaches a loopback server, nor a name that resolves to it', async () => {
  const hits = [];
  const srv = require('http').createServer((req, res) => { hits.push(req.url); res.end('SECRET'); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = srv.address().port;
  try {
    const urls = ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::127.0.0.1]', '127.1', '2130706433', 'localhost', 'evil.test']
      .map((h) => `http://${h}:${port}/x`);
    const dnsLookup = (host, opts, cb) => setImmediate(() => (opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)));
    const r = await run(world(), urls.map((u) => `get "${u}"\nkeep($error)\nkeep($result)`).join('\n'), { dnsLookup });
    eq(hits, [], 'the server saw nothing');
    for (let i = 0; i < urls.length; i++) {
      assert.match(String(r.kept[2 * i]), /this machine or its own network/, urls[i]);
      eq(r.kept[2 * i + 1], '');
    }
  } finally { srv.close(); }
});

t('dry run: a web page is not fetched, a file is still read', async () => {
  const asked = fetcher({ 'http://battle1.evony.com/a.xml': SCOUT });
  try {
    const r = await run(world(), 'get "http://battle1.evony.com/a.xml"\nkeep($result)\nget "hello.txt"\nkeep($result)', { dryRun: true });
    eq(asked, []);
    eq(r.kept, ['', 'line one\nline two']);
    assert.match(r.text, /\[dry run\] not fetched/);
  } finally { INFO.setUrlFetcher(null); }
});

t('NewCityScript: @get "NewCityGoals.txt" is the account\'s new-city goals when there is no such file', async () => {
  const w = world();
  w.s.org = { goals: { find: (...a) => (a[2] === 'goal' ? { src: 'config npc:5\nbuild c:10:9' } : null) } };
  const r = await run(w, '@get "NewCityGoals.txt"\nif $error == null keep($result)\nkeep($error)', { goalLayers: false });
  eq(r.kept, ['config npc:5\nbuild c:10:9', null]);
  fs.writeFileSync(path.join(SCRIPTS, 'NewCityGoals.txt'), 'config npc:9');
  try {
    const r2 = await run(w, '@get "NewCityGoals.txt"\nif $error == null keep($result)', { goalLayers: false });
    eq(r2.kept, ['config npc:9'], 'a file in the scripts folder wins');
  } finally { fs.unlinkSync(path.join(SCRIPTS, 'NewCityGoals.txt')); }
});

// ---------------------------------------------------------------------------
section('find (kept)');

t('find <player> lists castles from the saved cache the scans filled', async () => {
  const r = await run(world(), 'find Bob\nkeep($result)');
  assert.match(r.text, /cache holds \d+ castles/);
  assert.ok(r.kept[0].some((x) => x.userName === 'Bob' && x.coords === '431,251'), JSON.stringify(r.kept[0]));
});

// ---------------------------------------------------------------------------
(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n + '\n'); continue; }
    try { await f(); console.log('  ok    ' + n); pass++; } catch (e) { console.log('  FAIL  ' + n + '\n        ' + String(e.message).split('\n').join('\n        ')); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { require('./db').db.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
