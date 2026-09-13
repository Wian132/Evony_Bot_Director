'use strict';
// Offline tests for the Mail & Reports window: mailbox.js (report XML, mail
// text, limits) and the session's mail/report calls over a fake game.
//   node test-mail.js
// Nothing here connects to the game; the database is a throwaway file.
const path = require('path'), os = require('os'), fs = require('fs');
const EventEmitter = require('events');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-mail-')), 't.db');
const M = require('./mailbox');
const { Session, fetchText } = require('./session');
const { Game } = require('./game');

let pass = 0, fail = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; fails.push(`${name}\n      ${e.message}`); }
}
async function t2(name, fn) {
  try { await fn(); pass++; }
  catch (e) { fail++; fails.push(`${name}\n      ${e.message}`); }
}
function eq(got, want, what = '') {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${what ? what + ': ' : ''}got ${g}, want ${w}`);
}
function ok(cond, what) { if (!cond) throw new Error(what || 'expected true'); }
async function expectThrow(promise, re) {
  try { await promise; }
  catch (e) { if (!re.test(e.message)) throw new Error(`wrong error: ${e.message}`); return; }
  throw new Error('expected it to throw');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fixtures
const WIN = '<?xml version="1.0" encoding="UTF-8"?><!-- a comment -->'
  + '<reportData reportUrl="battle.evony.com/default.html?logfile=a.xml"><battleReport isAttack="true" isAttackSuccess="true" round="4" prestige="1250" isSeize="false" attackWinnerItems="player.box.gambling.3=2,player.item.x">'
  + '<attackTroop king="Me" heroName="Moore" heroLevel="156"><troopUnit typeId="7" count="50000" lose="412"/><troopUnit typeId="11" count="2000" lose="0"/></attackTroop>'
  + '<defendTroop king="NPC"><troopUnit typeId="3" count="12000" lose="12000"/><troopUnit typeId="15" count="600" lose="600"/></defendTroop>'
  + '<lootResource gold="81234" food="512000" wood="0"/>'
  + '<backTroop isBack="true"><troops heroName="Moore" heroLevel="156" isHeroBeSeized="false"><troopInfo typeId="7" preCount="50000" remain="49588" injured="3"/></troops></backTroop>'
  + '</battleReport></reportData>';
const LOSS = '<reportData><battleReport isAttack="false" isAttackSuccess="true" round="1">'
  + '<attackTroop king="Batram"><troopUnit typeId="9" count="80000" lose="1520"/></attackTroop>'
  + '<defendTroop king="Me"><troopUnit typeId="14" count="5000" lose="5000"/></defendTroop>'
  + '<lootResource gold="2500000"/></battleReport></reportData>';

// ---------------------------------------------------------------- XML
t('attributes and child elements both become properties', () => {
  const o = M.parseXml('<a x="1"><b>hi</b><c y="2"/></a>');
  eq(o, { a: { b: 'hi', c: { y: 2 }, x: 1 } });
});
t('a repeated element becomes a list, a single one does not', () => {
  const one = M.parseXml('<r><u id="1"/></r>').r.u;
  const two = M.parseXml('<r><u id="1"/><u id="2"/></r>').r.u;
  ok(!Array.isArray(one), 'single stays an object');
  eq(two, [{ id: 1 }, { id: 2 }]);
});
t('SimpleXMLDecoder number rules: "0..." stays text, booleans convert', () => {
  eq(M.simpleType('0'), '0');
  eq(M.simpleType('007'), '007');
  eq(M.simpleType('-0.5'), '-0.5');
  eq(M.simpleType('12'), 12);
  eq(M.simpleType('true'), true);
  eq(M.simpleType('FALSE'), false);
  eq(M.simpleType('1E'), '1E');
});
t('entities, CDATA, self-closing tags and quoted ">" in attributes', () => {
  const o = M.parseXml('<a t="x &gt; y" q=\'1>2\'><![CDATA[<raw>]]></a>');
  eq(o.a._text, '<raw>');
  eq(o.a.t, 'x > y');
  eq(o.a.q, '1>2');
});
t('text that also carries attributes keeps both (ComplexString)', () => {
  eq(M.parseXml('<a k="1">hello</a>').a, { _text: 'hello', k: 1 });
});
t('an empty element is null, and __proto__ is never assigned', () => {
  const o = M.parseXml('<a><e/><__proto__ polluted="1"/></a>');
  eq(o.a.e, null);
  eq({}.polluted, undefined);
  ok(!Object.prototype.hasOwnProperty.call(o.a, '__proto__'), 'no __proto__ key');
});
t('broken XML does not throw', () => {
  M.parseXml('<a><b></a');
  M.parseXml('<<<>>>');
  M.parseXml('');
});

// ---------------------------------------------------------------- battle reports
t('a won attack: sides, verdict, loot, return', () => {
  const d = M.describeReport(WIN, { startPos: 'Home(1,1)', targetPos: 'NPC(2,2)' });
  eq(d.kind, 'battle');
  eq(d.headline, 'Your army from Home(1,1) reached NPC(2,2) and attacked.');
  eq(d.verdict, { text: 'Victory', good: true });
  eq(d.url, 'http://battle.evony.com/default.html?logfile=a.xml');
  ok(d.lines.includes('The battle lasted 4 rounds, the attacker won.'), 'round line');
  ok(d.lines.includes('The army is returning to Home(1,1).'), 'isShowReturn line');
  const sides = d.sections.find((s) => s.type === 'sides').sides;
  eq(sides.map((s) => [s.role, s.whose, s.won]), [['Attacker', 'you', true], ['Defender', 'enemy', false]]);
  eq(sides[0].troops.map((u) => [u.name, u.count, u.lost, u.left]), [['Archer', 50000, 412, 49588], ['Ballista', 2000, 0, 2000]]);
  eq(sides[0].total, { count: 52000, lost: 412, left: 51588 });
  eq(sides[1].troops.map((u) => u.name), ['Warrior', 'Abatis']);      // 14 and up: fortifications
  const loot = d.sections.find((s) => s.type === 'res');
  eq([loot.title, loot.sign, loot.res], ['Resources plundered', '+', { gold: 81234, food: 512000, wood: 0 }]);
  const back = d.sections.find((s) => s.type === 'units' && /returning/.test(s.title));
  eq(back.rows, [['Archer', 50000, 49588, 3]]);
});
t('a lost defence: we are the defender, and the loot is ours lost', () => {
  const d = M.describeReport(LOSS, { startPos: 'Bad(9,9)', targetPos: 'Mine(3,3)' });
  eq(d.headline, 'An army attacked Mine(3,3).');
  eq(d.verdict, { text: 'Defeat', good: false });
  const sides = d.sections.find((s) => s.type === 'sides').sides;
  eq(sides.map((s) => [s.role, s.whose, s.won]), [['Attacker', 'enemy', true], ['Defender', 'you', false]]);
  const loot = d.sections.find((s) => s.type === 'res');
  eq([loot.title, loot.sign], ['Resources lost', '-']);
  eq(d.url, null);
});
t('treasure names come from the item catalogue when there is one', () => {
  const names = M.itemNamesFromXml('<itemEum id="player.box.gambling.3" name="Aries Amulet" desc="x"/>');
  const d = M.describeReport(WIN, {}, { itemName: (id) => names.get(id) || null });
  const tr = d.sections.find((s) => s.title === 'Treasure acquired');
  eq(tr.rows, [['Aries Amulet', 2], ['player.item.x', 1]]);
});
t('a battle with no side information does not break', () => {
  const d = M.describeReport('<reportData><battleReport round="1"/></reportData>', {});
  eq(d.kind, 'battle');
  eq(d.verdict, null);                               // no isAttackSuccess: no verdict either
  eq(d.headline, '');                                // BattleReportDetail hides it without isAttack
  const empty = M.describeReport('<reportData><battleReport/></reportData>', {});
  eq(empty.kind, 'battle');
});

// ---------------------------------------------------------------- the other kinds
t('scout report: what the scouts saw', () => {
  const d = M.describeReport('<reportData><scoutReport><scoutInfo heroName="W" heroLevel="120" gold="45" population="52000" support="92">'
    + '<resource food="12" wood="35"/><troops><troopStrType typeId="7" count="1000-2000"/></troops>'
    + '<buildings><buildingType type="31" levels="10"/><buildingType type="1" levels="10,9"/></buildings>'
    + '<techs><techType type="8" level="10"/></techs></scoutInfo></scoutReport></reportData>', { targetPos: 'X(1,2)' });
  eq(d.kind, 'scout');
  eq(d.headline, 'The scouting party reached X(1,2).');
  eq(d.sections.find((s) => s.title === 'Resources').res, { food: 12, wood: 35, gold: 45 });
  eq(d.sections.find((s) => s.title === 'Troops').rows, [['Archer', '1000-2000']]);
  eq(d.sections.find((s) => s.title === 'Buildings').rows, [['Town Hall', '10'], ['Cottage', '10,9']]);
  eq(d.sections.find((s) => s.title === 'Technology').rows, [['Military Science', 10]]);
  eq(d.sections.find((s) => s.title === 'City survey').rows, [['Hero', 'W (Lv 120)'], ['Population', 52000], ['Loyalty', 92]]);
  // ScoutInfoUi's order: city, resources, buildings, fortifications, troops, technology
  eq(d.sections.map((s) => s.title), ['City survey', 'Resources', 'Buildings', 'Troops', 'Technology']);
  ok(/Research Informatics/.test(d.foot[0]), 'a report with information suggests more Informatics');
});
t('scout report with nothing learned says so', () => {
  const d = M.describeReport('<reportData><scoutReport/></reportData>', {});
  ok(/Informatics level is too low/.test(d.foot[0]), d.foot[0]);
});
t('trade report reads like the client', () => {
  const d = M.describeReport('<reportData><tradeReport tradeType="Bought" dealedAmount="1000000" resName="food" gold="100000"/></reportData>', {});
  eq(d.kind, 'trade');
  eq(d.headline, 'Trade completed: Bought 1,000,000 food, total price 100,000 gold.');
});
t('troop movement: arrived vs back, mission named from the type', () => {
  const there = M.describeReport('<reportData><troopMovement type="2" isBack="false"><troops typeId="4" count="1"/></troopMovement></reportData>', { startPos: 'A', targetPos: 'B' });
  eq(there.headline, 'The troops on a reinforce mission reached B.');
  const back = M.describeReport('<reportData><troopMovement type="1" isBack="true"><resource food="10"/></troopMovement></reportData>', { startPos: 'A', targetPos: 'B' });
  eq(back.headline, 'The troops sent to B on a transport mission are back at A.');
  eq(back.sections.find((s) => s.type === 'res').res, { food: 10 });
});
t('hero escape lists every hero; troop die lists the dead', () => {
  const h = M.describeReport('<reportData><heroEscapeReport><heroName>Lucien</heroName><heroName>Marcus</heroName></heroEscapeReport></reportData>', { targetPos: 'S' });
  eq(h.sections[0].rows, [['Lucien'], ['Marcus']]);
  const one = M.describeReport('<reportData><heroEscapeReport><heroName>Solo</heroName></heroEscapeReport></reportData>', {});
  eq(one.sections[0].rows, [['Solo']]);
  const d = M.describeReport('<reportData><troopDieReport><troopUnit typeId="10" count="2109"/></troopDieReport></reportData>', {});
  eq(d.sections[0].rows, [['Cataphract', 2109]]);
});
t('uprising and rob reports', () => {
  const u = M.describeReport('<reportData><uprisingReport population="1200" gold="5" food="0" wood="0" stone="0" iron="0" complaint="35"/></reportData>', { targetPos: 'S' });
  eq(u.sections[0].rows[0], ['Population', '-1,200']);
  eq(u.sections[0].rows[6], ['Public grievance', '+35']);
  const r = M.describeReport('<reportData><robReport><loseResource food="9"/><loseTroops typeId="8" count="20"/></robReport></reportData>', { targetPos: 'T' });
  eq(r.kind, 'rob');
  eq(r.sections.map((s) => s.type), ['res', 'units']);
});
t('an unknown kind shows the raw data; plain text shows as text', () => {
  const u = M.describeReport('<reportData><allianceReport a="1"/></reportData>', {});
  eq(u.kind, 'unknown');
  eq(u.sections[0].type, 'raw');
  const p = M.describeReport('just words<br>two lines', {});
  eq([p.kind, p.sections[0].text], ['text', 'just words\ntwo lines']);
});
t('report links are http(s) only', () => {
  eq(M.safeUrl('battle.evony.com/x'), 'http://battle.evony.com/x');
  eq(M.safeUrl('https://a.b/c'), 'https://a.b/c');
  eq(M.safeUrl(''), null);
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x']) {
    const u = M.describeReport(`<reportData reportUrl="${bad}"><tradeReport/></reportData>`, {}).url;
    ok(u === null || /^https?:\/\//.test(u), `${bad} -> ${u}`);
  }
});

// ---------------------------------------------------------------- the web battle log
// The report from the Reports window screenshot, as the server sent it.
const LOG = 'logfile/20260913/26/b8/26b8db5fd5effbd730fba6745c62f0e4.xml';
const TRANSPORT = `<reportData reportUrl="battless71.evony.com/default.html?${LOG}">\n  <troopMovement isBack="true" type="1">\n`
  + '    <troops typeId="8" count="1"/>\n  </troopMovement>\n</reportData>';
t('the transport report from the screenshot', () => {
  const d = M.describeReport(TRANSPORT, { startPos: '8(489,678)', targetPos: '9(571,648)' });
  eq(d.kind, 'movement');
  eq(d.headline, 'The troops sent to 9(571,648) on a transport mission are back at 8(489,678).');
  eq(d.sections, [{ type: 'units', title: 'Troops', cols: ['Troop', 'Amount'], rows: [['Transporter', 1]] }]);
  eq(d.log, { xml: `http://battless71.evony.com/${LOG}`, page: `http://battless71.evony.com/default.html?${LOG}`, day: '2026-09-13' });
});
t('battle-log links: every form the game and players write', () => {
  const want = `http://battless71.evony.com/${LOG}`;
  for (const s of [`battless71.evony.com/default.html?${LOG}`, `http://battless71.evony.com/default.html?${LOG}`,
    `https://battless71.evony.com/default.html?${LOG}`, `battless71.evony.com/default.html?${LOG.replace('logfile/', 'logfile=')}`,
    `http://battless71.evony.com/default.html?${encodeURIComponent(LOG)}`, `http://battless71.evony.com/${LOG}`,
    `  BATTLESS71.EVONY.COM/default.html?${LOG}  `, `battless71.evony.com/?${LOG}`]) {
    const r = M.battleLogUrl(s);
    eq(r && r.xml, want, s);
  }
});
t('battle-log links: nothing but a log file on an evony.com host', () => {
  for (const s of ['', null, 'hello', 'http://evil.com/logfile/a/b.xml', `http://battless71.evony.com.evil.com/${LOG}`,
    `http://evony.com/${LOG}`, `http://user:pw@battless71.evony.com/${LOG}`, `http://battless71.evony.com:8080/${LOG}`,
    'http://battless71.evony.com/logfile/../../etc/passwd.xml', 'http://battless71.evony.com/logfile/%2e%2e/x.xml',
    'http://battless71.evony.com/default.html?logfile/../x.xml', 'http://battless71.evony.com/logfile/a/b.txt',
    'http://battless71.evony.com/default.html?id=5', 'javascript:alert(1)//battless71.evony.com/logfile/a.xml',
    `ftp://battless71.evony.com/${LOG}`, 'http://battless71.evony.com/logfile/' + 'a/'.repeat(120) + 'b.xml']) {
    eq(M.battleLogUrl(s), null, String(s));
  }
});

t('fortifications use the names the game\'s report screens print', () => {
  eq(['14', 15, 16, 17, 18, 7, 99].map((n) => M.unitName(n)),
    ['Trap', 'Abatis', "Archer's Tower", 'Rolling Log', 'Defensive Trebuchet', 'Archer', 'unit 99']);
});
t('each side: hero, experience and castle, as BattleTroopUi shows them', () => {
  const d = M.describeReport('<reportData><battleReport isAttack="false" isAttackSuccess="false">'
    + '<attackTroop king="Bad" heroName="Grim" heroLevel="80" heroExp="1500" castlePos="Keep(5,6)"><troopUnit typeId="9" count="10" lose="10"/></attackTroop>'
    + '<defendTroop king="Me"/></battleReport></reportData>', { targetPos: 'Mine(1,1)' });
  const [a, b] = d.sections.find((s) => s.type === 'sides').sides;
  eq([a.king, a.hero, a.heroLevel, a.heroExp, a.castlePos, a.whose, a.won], ['Bad', 'Grim', 80, 1500, 'Keep(5,6)', 'enemy', false]);
  eq([b.king, b.troops.length, b.whose, b.won], ['Me', 0, 'you', true]);
  eq(d.verdict, { text: 'Victory', good: true });
});
t('back troops: a captured hero says so', () => {
  const d = M.describeReport('<reportData><battleReport isAttack="true" isAttackSuccess="false">'
    + '<backTroop isBack="true"><troops heroName="Moore" heroLevel="9" isHeroBeSeized="true"><troopInfo typeId="7" preCount="5" remain="0" injured="0"/>'
    + '<resource food="3"/></troops></backTroop></battleReport></reportData>', {});
  eq(d.sections.map((s) => s.title), ['Troops returning — Moore (Lv 9) — the hero was captured', 'Resources carried back']);
  eq(d.lines, [], 'no rounds given, and a lost attack has no "returning to" line');
});
t('the outcome rows, by the game\'s labels', () => {
  const d = M.describeReport('<reportData><battleReport isAttack="true" isAttackSuccess="true" prestige="12" injuredPer="30" honor="5" heroExp="700"'
    + ' support="-3" complaint="4" isSeize="true" seizeProblem="The lord is protected."/></reportData>', {});
  eq(d.sections.find((s) => s.title === 'Outcome').rows, [['Prestige gained', 12], ['Wounded proportion', '30%'], ['Honor', 5],
    ['Hero experience gained', 700], ['Loyalty change', -3], ['Public grievance change', 4], ['Conquest note', 'The lord is protected.'],
    ['Conquest', 'the city was taken']]);
});

// ScoutResults: [isAttack, isFound, isSuccess] -> verdict
t('scouting: all six outcomes the game tells apart', () => {
  const cases = [
    ['true', 'false', 'false', 'Scouts lost', false, /spotted .* wiped out/],
    ['true', 'false', 'true', 'Scouted', true, /too small to stop them/],
    ['true', 'true', 'false', 'Scouts lost', false, /None came back/],
    ['true', 'true', 'true', 'Scouted', true, /survivors brought back/],
    ['false', 'true', 'false', 'Enemy scouts wiped out', true, /outnumbered the enemy scouts/],
    ['false', 'false', 'true', 'Your city was scouted', false, /scouted your city/],
  ];
  for (const [a, f, s, text, good, re] of cases) {
    const d = M.describeReport(`<reportData><scoutReport isAttack="${a}" isFound="${f}" isSuccess="${s}"/></reportData>`, { targetPos: 'T(1,1)' });
    eq(d.verdict, { text, good }, `${a}/${f}/${s}`);
    ok(re.test(d.lines[0]), `${a}/${f}/${s}: ${d.lines[0]}`);
  }
});
t('scouted by the enemy: our city in the headline, no advice about Informatics', () => {
  const d = M.describeReport('<reportData><scoutReport isAttack="false" isSuccess="true"/></reportData>', { targetPos: 'Mine(2,2)' });
  eq(d.headline, 'Enemy scouts reached Mine(2,2).');
  eq(d.foot, []);
  const ours = M.describeReport('<reportData><scoutReport isAttack="true" isFound="true" isSuccess="true"/></reportData>', { targetPos: 'X(3,3)' });
  eq(ours.headline, 'Your scouts reached X(3,3).');
});
t('the scouts\' fight shows only when there were defenders, and loot goes by isAttack', () => {
  const fought = M.describeReport('<reportData><scoutReport isAttack="true" isFound="false" isSuccess="true">'
    + '<battleInfo isAttack="true" isAttackSuccess="true" round="2"><attackTroop><troopUnit typeId="4" count="500" lose="20"/></attackTroop>'
    + '<defendTroop><troopUnit typeId="3" count="50" lose="50"/></defendTroop><lootResource gold="9"/></battleInfo></scoutReport></reportData>', {});
  const i = fought.sections.findIndex((s) => s.title === 'The scouts fought');
  ok(i >= 0, 'fight shown');
  eq(fought.sections[i].text, 'The battle lasted 2 rounds, the attacker won.');
  eq(fought.sections[i + 1].type, 'sides');
  eq(fought.sections.find((s) => s.type === 'res').title, 'Resources plundered');
  const quiet = M.describeReport('<reportData><scoutReport isAttack="true"><battleInfo isBack="true">'
    + '<attackTroop><troopUnit typeId="4" count="5" lose="0"/></attackTroop></battleInfo></scoutReport></reportData>', {});
  ok(!quiet.sections.some((s) => s.title === 'The scouts fought' || s.type === 'sides'), 'no defenders, no fight');
});
t('troop movements: mission words, resources, the problem line', () => {
  const atk = M.describeReport('<reportData><troopMovement type="5" isBack="true" heroName="H" heroLevel="3" problem="The target moved.">'
    + '<troops typeId="7" count="4"/><resource gold="1" iron="2"/></troopMovement></reportData>', { startPos: 'A', targetPos: 'B' });
  eq(atk.headline, 'The troops sent to B on an attack mission are back at A.');
  eq(atk.lines, ['The target moved.']);
  eq(atk.sections.map((s) => s.title), ['Hero', 'Troops', 'Resources carried back']);
  eq(atk.sections[0].rows, [['Hero', 'H (Lv 3)']]);
  const delivered = M.describeReport('<reportData><troopMovement type="1" isBack="false"><resource food="7"/></troopMovement></reportData>', { targetPos: 'C' });
  eq(delivered.sections[0].title, 'Resources delivered');
  const colony = M.describeReport('<reportData><troopMovement type="11" isBack="false"/></reportData>', {});
  eq(colony.headline, 'The troops on a deployment mission reached their target.');
});
t('the kinds only the web battle log knew', () => {
  const war = M.describeReport('<reportData><declaredWarReport myself="false" startTime="2026-09-14 08:00" endTime="2026-09-16 08:00"/></reportData>', { startPos: 'Rival', targetPos: 'Me' });
  eq([war.kind, war.headline], ['war', 'Rival has declared war on you.']);
  eq(war.sections[0].rows, [['Begins', '2026-09-14 08:00'], ['Ends', '2026-09-16 08:00']]);
  eq(M.describeReport('<reportData><declaredWarReport myself="true"/></reportData>', { targetPos: 'Rival' }).headline, 'You have declared war on Rival.');
  const pol = M.describeReport('<reportData><policyReport detail="Taxes rose.&lt;br&gt;Loyalty fell."/></reportData>', {});
  eq([pol.kind, pol.sections[0].text], ['policy', 'Taxes rose.\nLoyalty fell.']);
  eq(M.describeReport('<reportData><heroFleeReport><detail>Gone.</detail></heroFleeReport></reportData>', {}).sections[0].text, 'Gone.');
  const moves = M.describeReport('<reportData><TroopMoveList><TroopMove type="Attack" Start="A(1,1)" Dest="B(2,2)" ArriveTime="12:00"/>'
    + '<TroopMove type="Scout" Start="C" Dest="B(2,2)" ArriveTime="12:05"/></TroopMoveList></reportData>', { targetPos: 'B(2,2)' });
  eq(moves.sections[0].rows, [['1', 'Attack', 'A(1,1)', 'B(2,2)', '12:00'], ['2', 'Scout', 'C', 'B(2,2)', '12:05']]);
  const levy = M.describeReport('<reportData><ImpositionReport isColony="true" suzerain="Lord" colony="Col(1,1)" food="5" lumber="6" stone="0" iron="1" gold="2"/></reportData>', {});
  eq(levy.headline, 'Lord levied resources from Col(1,1).');
  eq(levy.sections[1], { type: 'res', title: 'Resources levied', res: { food: 5, wood: 6, stone: 0, iron: 1, gold: 2 }, sign: '-' });
  eq(M.describeReport('<reportData><ColonyAbadonReport colony="Col(1,1)" suzerain="Lord"/></reportData>', {}).headline, 'The colony Col(1,1) was abandoned.');
  const sow = M.describeReport('<reportData><sowDiscordReport suzerainLord="L" suzerainCastle="S(1,1)"><capturedHero heroName="Z" heroLevel="7"/></sowDiscordReport></reportData>', {});
  eq(sow.sections[0].rows, [['Suzerain lord', 'L'], ['Suzerain city', 'S(1,1)'], ['Hero captured', 'Z (Lv 7)']]);
  eq(M.describeReport('<reportData><uprisingWarReport isColony="true" startTime="a" endTime="b"/></reportData>', { startPos: 'P', targetPos: 'Q' }).headline,
    'An uprising war from P against Q.');
});

// ---------------------------------------------------------------- reportview.js, the shared renderer
global.window = {};
require('./public/reportview.js');
const RV = global.window.ReportView;
t('the renderer escapes everything the report carries', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const d = M.describeReport(`<reportData><battleReport isAttack="true" isAttackSuccess="true" unNomal="${evil.replace(/</g, '&lt;')}">`
    + `<attackTroop king="${evil.replace(/</g, '&lt;')}"><troopUnit typeId="7" count="5" lose="1"/></attackTroop></battleReport></reportData>`, { startPos: evil, targetPos: '"q"' });
  const h = RV.body(d);
  ok(!/<img/i.test(h), 'no raw tag: ' + h);
  ok(h.includes('&lt;img src=x onerror=alert(1)&gt;'), 'shown as text');
  ok(!/="q"/.test(h), 'quotes escaped');
});
t('the renderer: sides, resources in the game\'s order, the foot', () => {
  const h = RV.body(M.describeReport(WIN, { startPos: 'Home(1,1)', targetPos: 'NPC(2,2)' }));
  ok(h.includes('rv-side won') && h.includes('rv-side lost'), 'both sides, marked');
  ok(h.includes('our side') && h.includes('enemy side'), 'whose side');
  ok(h.indexOf('Food') < h.indexOf('Lumber') && h.indexOf('Lumber') < h.indexOf('Gold'), 'LootResourceUi order');
  ok(h.includes('+81,234'), 'plunder signed and formatted');
  const s = RV.body(M.describeReport('<reportData><scoutReport/></reportData>', {}));
  ok(s.includes('rv-foot'), 'foot drawn');
  eq(RV.kindTitle('scout'), 'Scout report');
});

// ---------------------------------------------------------------- mail
t('mail text: Flash html to plain text, HREF link cut off', () => {
  eq(M.mailText('Hi<br>there<BR/>&lt;b&gt; &mdash; ok<p>para</p><font color="#f00">red</font>'), 'Hi\nthere\n<b> — ok\npara\nred');
  eq(M.mailText('Maintenance. CLICK HERE HREFhttp://forum.x/maint'), 'Maintenance. CLICK HERE');
});
t('mail links: HREF, <a href>, and (Link) mails — never event: or javascript:', () => {
  eq(M.mailLinks('x HREFhttp://forum.x/m'), ['http://forum.x/m']);
  eq(M.mailLinks('<a href="event:here">CLICK</a><a href="javascript:alert(1)">x</a><a href="https://ok.x/">y</a>'), ['https://ok.x/']);
  eq(M.mailLinks('http://www.evony.com/e', 'Festival (Link)'), ['http://www.evony.com/e']);
});
t('rows: MailBean and ReportBean, sent mail is never unread', () => {
  eq(M.mailRow({ mailid: 5, sender: 'A', receiver: 'B', title: 'T', receiveTime: 9, isRead: 0 }, 'inbox'),
    { id: 5, from: 'A', to: 'B', title: 'T', time: 9, read: false, box: 'inbox' });
  eq(M.mailRow({ mailid: 6, isRead: 0 }, 'sent').read, true);
  eq(M.reportRow({ id: 7, title: 'R', eventTime: 1, startPos: 's', targetPos: 't', isRead: 1, attack: true }, 'army'),
    { id: 7, title: 'R', time: 1, from: 's', to: 't', read: true, attack: true, back: false, type: 'army' });
});
t('what MailWin checks before sending', () => {
  eq(M.checkMail({ to: '', title: 'a', body: 'b' }).error, 'the recipient cannot be empty');
  eq(M.checkMail({ to: 'x', title: ' ', body: 'b' }).error, 'the subject cannot be empty');
  eq(M.checkMail({ to: 'x', title: 'a', body: '' }).error, 'the mail cannot be empty');
  ok(/500/.test(M.checkMail({ to: 'x', title: 'a', body: 'y'.repeat(501) }).error), '500 limit');
  ok(/one recipient/.test(M.checkMail({ to: 'a,b', title: 'a', body: 'b' }).error), 'one recipient');
  eq(M.checkMail({ to: ' Batram ', title: ' Hi ', body: ' x\r\ny ' }), { to: 'Batram', title: 'Hi', body: 'x\ny' });
  eq(M.checkMail({ to: 'x', title: 'a', body: 'y'.repeat(500) }).body.length, 500);
});

// ---------------------------------------------------------------- the session over a fake game
function fakeSession({ pushMail = true } = {}) {
  const sent = [];
  const c = Object.assign(new EventEmitter(), { sock: { destroyed: false } });
  const mails = [
    { mailid: 1, type: 1, sender: 'A', receiver: 'Me', title: 'one', isRead: 0, receiveTime: 1, content: 'hello<br>there' },
    { mailid: 2, type: 1, sender: 'B', receiver: 'Me', title: 'two', isRead: 1, receiveTime: 2, content: 'x' },
    { mailid: 3, type: 2, sender: 'System', receiver: 'Me', title: 'sys', isRead: 0, receiveTime: 3, content: 'y' },
  ];
  const reports = [{ id: 10, type: 1, title: 'atk', isRead: 0, eventTime: 1, startPos: 'a', targetPos: 'b', content: WIN }];
  const counts = () => ({ count: mails.filter((m) => m.type < 3 && !m.isRead).length,
    count_inbox: mails.filter((m) => m.type === 1 && !m.isRead).length, count_system: mails.filter((m) => m.type === 2 && !m.isRead).length });
  const g = {
    c, castles: [],
    player: { newMailCount: 2, newMaileCount_inbox: 1, newMaileCount_system: 1, newReportCount: 1, newReportCount_army: 1, newReportCount_trade: 0, newReportCount_other: 0 },
    async req(cmd, data) {
      sent.push([cmd, data]);
      if (cmd === 'mail.receiveMailList') return { ok: 1, pageNo: data.pageNo, totalPage: 1, mails: mails.filter((m) => m.type === data.type) };
      if (cmd === 'mail.readMail') {
        const m = mails.find((x) => x.mailid === data.mailId);
        if (!m) return { ok: -1, errorMsg: 'gone' };
        m.isRead = 1;
        if (pushMail) setTimeout(() => c.emit('cmd', 'server.NewMail', counts()), 5);
        return { ok: 1, ...m };
      }
      if (cmd === 'mail.deleteMail') return { ok: 1 };
      if (cmd === 'mail.sendMail') return data.username === 'nobody' ? { ok: -1, errorMsg: 'no such player' } : { ok: 1 };
      if (cmd === 'report.receiveReportList') return { ok: 1, pageNo: 1, totalPage: 1, reports: reports.filter((r) => r.type === data.reportType) };
      if (cmd === 'report.markAsRead') return { ok: 1, report: reports[0] };
      if (cmd === 'report.deleteReport') return { ok: 1 };
      return { ok: 1 };
    },
  };
  for (const k of ['mailList', 'readMail', 'markMailRead', 'deleteMail', 'sendMail', 'readReport', 'markReportsRead']) g[k] = Game.prototype[k];
  g.reportList = (type, pageNo, pageSize) => g.req('report.receiveReportList', { pageNo, pageSize, reportType: { trade: 0, army: 1, other: 2 }[type] });
  g.deleteReports = (ids) => g.req('report.deleteReport', { idStr: ids.join(',') });
  const s = Object.create(Session.prototype);
  const notes = [];
  Object.assign(s, { game: g, log: [], acts: [], reports: [], chat: {}, maint: { active: false }, account: { id: 't' } });
  s.note = (m, meta) => notes.push([m, meta && meta.kind]);
  s.wire(g);
  return { s, g, c, sent, notes };
}

(async () => {
  await t2('lists go out with the client\'s own params and page size', async () => {
    const { s, sent } = fakeSession();
    const r = await s.mailList('system', '2');
    eq(sent[0], ['mail.receiveMailList', { pageNo: 2, type: 2, pageSize: 10 }]);
    eq(r.mails.map((m) => [m.id, m.box, m.read]), [[3, 'system', false]]);
    await s.reportPage('army', 1);
    eq(sent[1], ['report.receiveReportList', { pageNo: 1, pageSize: 10, reportType: 1 }]);
  });
  await t2('bad box / type / ids are refused before anything is sent', async () => {
    const { s, sent } = fakeSession();
    await expectThrow(s.mailList('trash'), /inbox, system or sent/);
    await expectThrow(s.reportPage('toString'), /army, trade or other/);
    await expectThrow(s.mailRead('abc'), /bad mail id/);
    await expectThrow(s.mailDelete([]), /no mail selected/);
    eq(sent.length, 0);
  });
  await t2('not connected: an error, never a login', async () => {
    const { s, c, sent } = fakeSession();
    c.sock.destroyed = true;
    await expectThrow(s.mailList('inbox'), /not connected/);
    await expectThrow(s.reportRead(10), /not connected/);
    eq(sent.length, 0);
  });
  await t2('reading a mail: text cleaned, and the server\'s NewMail push sets the header', async () => {
    const { s, g } = fakeSession();
    await s.mailList('inbox');
    const r = await s.mailRead(1);
    eq([r.mail.id, r.mail.text, r.mail.box], [1, 'hello\nthere', 'inbox']);
    await sleep(20);
    eq([g.player.newMailCount, g.player.newMaileCount_inbox], [1, 0]);
  });
  await t2('no push after a read: the session takes the read one off itself', async () => {
    const { s, g, notes } = fakeSession({ pushMail: false });
    await s.mailList('inbox');
    const w = s.mrCountsAfter('server.NewMail', s.mrCleared('mail', [1]), 10);
    w.settle();
    await sleep(40);
    eq([g.player.newMailCount, g.player.newMaileCount_inbox, g.player.newMaileCount_system], [1, 0, 1]);
    ok(notes.some(([m, k]) => /took 1 off/.test(m) && k === 'net'), 'noted on the debug log');
  });
  await t2('a push during the wait wins over the local correction', async () => {
    const { s, g, c } = fakeSession({ pushMail: false });
    await s.reportPage('army');
    const w = s.mrCountsAfter('server.NewReport', s.mrCleared('report', [10]), 20);
    c.emit('cmd', 'server.NewReport', { count: 7, army_count: 7, trade_count: 0, other_count: 0 });
    w.settle();
    await sleep(50);
    eq([g.player.newReportCount, g.player.newReportCount_army], [7, 7]);
  });
  await t2('counts never go below zero', async () => {
    const { s, g } = fakeSession();
    g.player.newReportCount_trade = 0;
    s.mrDropUnread(g.player, 'server.NewReport', [{ where: 'trade' }, { where: 'trade' }]);
    eq(g.player.newReportCount_trade, 0);
  });
  await t2('delete: only ids a list has shown, logged as an act', async () => {
    const { s, sent, notes } = fakeSession();
    await expectThrow(s.mailDelete([1]), /not in any list/);
    await s.mailList('inbox');
    const r = await s.mailDelete([1, 2, 2]);
    eq(r.deleted, 2);
    eq(sent[sent.length - 1], ['mail.deleteMail', { str_mailid: '1,2' }]);
    ok(notes.some(([m, k]) => m === 'delete 2 mail(s) from inbox -> ok' && k === 'act'), JSON.stringify(notes));
    await expectThrow(s.mailDelete([1]), /not in any list/);    // gone from the cache too
  });
  await t2('reading a report returns it decoded, with the XML alongside', async () => {
    const { s, sent } = fakeSession();
    await s.reportPage('army');
    const r = await s.reportRead('10');
    eq(sent[sent.length - 1], ['report.markAsRead', { reportId: 10 }]);
    eq([r.report.id, r.report.type, r.report.read, r.report.detail.kind], [10, 'army', true, 'battle']);
    ok(r.report.content.startsWith('<?xml'), 'raw content kept');
    const del = await s.reportDelete([10]);
    eq(del.deleted, 1);
    eq(sent[sent.length - 1], ['report.deleteReport', { idStr: '10' }]);
  });
  await t2('send: checked, logged either way, and one every 5 seconds', async () => {
    const { s, sent, notes } = fakeSession();
    await expectThrow(s.mailSend('Batram', '', 'x'), /subject/);
    eq(sent.length, 0);
    const r = await s.mailSend(' Batram ', 'Re: truce', 'deal');
    eq(r, { ok: true, to: 'Batram', title: 'Re: truce' });
    eq(sent[0], ['mail.sendMail', { username: 'Batram', title: 'Re: truce', content: 'deal' }]);
    ok(notes.some(([m, k]) => m === 'mail to Batram "Re: truce" -> ok' && k === 'act'), 'send logged');
    await expectThrow(s.mailSend('Batram', 'again', 'x'), /every 5 seconds/);
    eq(sent.length, 1);
    s._mrSentAt = 0;
    await expectThrow(s.mailSend('nobody', 'hi', 'x'), /no such player/);
    ok(notes.some(([m]) => m === 'mail to nobody "hi" -> no such player'), 'refusal logged');
  });
  await t2('calls queue: two lists at once go out one after the other', async () => {
    const { s, g } = fakeSession();
    const order = [];
    const req = g.req;
    g.req = async (cmd, data) => { order.push('start ' + data.type); await sleep(10); order.push('end ' + data.type); return req(cmd, data); };
    await Promise.all([s.mailList('inbox'), s.mailList('system')]);
    eq(order, ['start 1', 'end 1', 'start 2', 'end 2']);
  });

  // ---------------------------------------------------------------- the web battle log
  await t2('a battle log opens from its link alone — no game connection, fetched once', async () => {
    const { s, c, sent } = fakeSession();
    c.sock.destroyed = true;                          // not connected: does not matter here
    const asked = [];
    s.fetchLog = async (u) => { asked.push(u); return TRANSPORT; };
    const r = await s.reportLog(`battless71.evony.com/default.html?${LOG}`, { from: '8(489,678)', to: '9(571,648)' });
    eq(asked, [`http://battless71.evony.com/${LOG}`]);
    eq(r.detail.headline, 'The troops sent to 9(571,648) on a transport mission are back at 8(489,678).');
    eq([r.log.day, r.content], ['2026-09-13', TRANSPORT]);
    const again = await s.reportLog(`http://battless71.evony.com/${LOG}`);
    eq(asked.length, 1, 'a log never changes: the second look is from memory');
    eq(again.detail.headline, 'The troops sent to their target on a transport mission are back at home.');
    eq(sent.length, 0, 'nothing went to the game');
  });
  await t2('a bad link is refused before anything is fetched; a non-report is not kept', async () => {
    const { s } = fakeSession();
    let calls = 0;
    s.fetchLog = async () => { calls++; return '<html>404</html>'; };
    await expectThrow(s.reportLog('http://evil.com/logfile/a/b.xml'), /not a battle-log link/);
    eq(calls, 0);
    await expectThrow(s.reportLog(`battless71.evony.com/default.html?${LOG}`), /not a report/);
    await expectThrow(s.reportLog(`battless71.evony.com/default.html?${LOG}`), /not a report/);
    eq(calls, 2, 'refused content is fetched again next time');
  });
  await t2('fetchText: plain http, a 404 said plainly, a size cap and a deadline', async () => {
    const http = require('http');
    const srv = http.createServer((req, res) => {
      if (req.url === '/ok') return res.end('<reportData/>');
      if (req.url === '/big') { res.write('x'.repeat(3000)); return res.end('y'.repeat(3000)); }
      if (req.url === '/slow') return;                // never answers
      if (req.url === '/moved') { res.writeHead(302, { Location: 'http://example.com/' }); return res.end(); }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
      eq(await fetchText(base + '/ok'), '<reportData/>');
      await expectThrow(fetchText(base + '/gone'), /does not have that battle log/);
      await expectThrow(fetchText(base + '/moved'), /answered 302/);
      await expectThrow(fetchText(base + '/big', { maxBytes: 4000 }), /too big/);
      await expectThrow(fetchText(base + '/slow', { timeoutMs: 150 }), /did not answer in time/);
    } finally { srv.closeAllConnections(); srv.close(); }
  });

  console.log('');
  for (const f of fails) console.log('  FAIL  ' + f);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
