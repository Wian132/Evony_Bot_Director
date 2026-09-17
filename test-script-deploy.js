'use strict';
// Deployment commands (script-cmd-deploy.js, deploy-loops.js), offline: every
// NEAT usage and example line from the wiki's Deployment pages, and what each
// sends. The Game is real (castles, the army bean, march times); its network
// calls are stubbed and recorded, reports come from a fake report box, and the
// background attacks run on a fake session with the clock pushed forward.
const assert = require('assert');
const C = require('./constants');
const H = require('./goal-heroes');
const { Game } = require('./game');
const script = require('./script');
const D = require('./script-cmd-deploy');
const L = require('./deploy-loops');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const F = (x, y) => C.coordsToFieldId(x, y);
const parseErr = (line) => { try { script.parseLine(line); } catch (e) { return e.message; } return null; };
const P = (line) => script.parseLine(line);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting'); await sleep(5); }
}

// Fast clocks for the loops and waits.
Object.assign(L.TIMING, { tickMs: 5, waveMs: 30, spamGapMs: 5, idleMs: 10, reportMs: 10, guardPollMs: 5, findArmyMs: 300, marginMs: 50, stopWaitMs: 1000, offlineMs: 10 });
Object.assign(D.TIMING, { heroPollMs: 10, lostGraceMs: 40 });

// base = top attribute − level (Game.heroBase, which goal-heroes reads too):
// Ken 60, Biggy 200, Polly 70, att69int 69, Spammy 40, Disloyal 35.
const hero = (id, name, o = {}) => ({ id, name, status: 0, level: 10, power: 50, management: 20, stratagem: 20, loyalty: 100, remainPoint: 0, experience: 0, ...o });
function world({ loadSkill = 0, relief = 0, armyReplies = [], items = [{ id: 'player.troop.1.a', count: 2 }], params = true } = {}) {
  const g = new Game();
  g.serverOffset = 0;
  g.player = { playerInfo: { userName: 'Me', alliance: 'Ally' }, selfArmys: [], buffs: [], items };
  g.castles = [
    { id: 1, name: 'Home', fieldId: F(100, 100), buffs: [], heros: [
      hero(11, 'Ken', { power: 120, level: 60 }),
      hero(12, 'Biggy', { power: 300, level: 100 }),
      hero(13, 'Polly', { power: 90, management: 150, level: 80 }),
      hero(14, 'Mayor', { status: 1, power: 400, level: 150 }),
      hero(15, 'Away', { status: 3, power: 500, level: 100 }),
      hero(16, 'Prisoner', { status: 4, power: 600, level: 100 }),
      hero(17, 'att69int', { power: 99, level: 30 }),
      hero(18, 'Spammy', { power: 60, level: 20 }),
      hero(19, 'Disloyal', { power: 55, level: 20, loyalty: 80 }),
    ] },
    { id: 2, name: 'Fla', fieldId: F(120, 100), buffs: [], heros: [hero(21, 'Dee')] },
  ];
  const log = [];
  let nextArmy = 1000, nextReport = 500;
  if (params) g.troopParams = async () => ({ marchSkill: 0, driveSkill: 0, loadSkill, relief });
  g.fieldOwner = async () => ({ userName: 'Other', allianceName: 'X' });
  g.newArmy = async (castleId, bean) => {
    log.push({ cmd: 'newArmy', castleId, bean });
    const r = armyReplies.length ? armyReplies.shift() : { ok: 1 };
    if (r && r.ok === 1) {
      const castle = g.castles.find((c) => c.id === castleId);
      const keys = Object.keys(bean.troops).filter((k) => bean.troops[k] > 0);
      const start = g.now();
      const march = C.marchTimeMs(C.fieldIdToCoords(castle.fieldId), C.fieldIdToCoords(bean.targetPoint), keys, 0);
      const h = bean.heroId !== undefined ? castle.heros.find((x) => x.id === bean.heroId) : null;
      g.player.selfArmys = [...g.player.selfArmys, { armyId: nextArmy++, direction: 1, missionType: bean.missionType,
        targetFieldId: bean.targetPoint, startFieldId: castle.fieldId, startTime: start, restTime: bean.restTime,
        reachTime: start + march + bean.restTime * 1000, hero: h ? h.name : undefined, troop: bean.troops }];
      if (h) h.status = 3;       // the HeroUpdate that follows
    }
    return r;
  };
  g.recallArmy = async (castleId, armyId) => {
    log.push({ cmd: 'recall', castleId, armyId });
    const a = g.player.selfArmys.find((x) => x.armyId === armyId);
    if (a) a.direction = 2;
    return { ok: 1 };
  };
  g.callBackHero = async (castleId, heroId) => { log.push({ cmd: 'callBackHero', castleId, heroId }); return { ok: 1 }; };
  g.box = [];
  g.reportList = async (type, page, size) => {
    log.push({ cmd: 'reportList', type, page });
    const rows = g.box.slice().reverse().slice((page - 1) * size, page * size).map(({ content, ...r }) => r);
    return { ok: 1, reports: rows, pageNo: page, totalPage: Math.max(1, Math.ceil(g.box.length / size)) };
  };
  g.readReport = async (id) => { log.push({ cmd: 'readReport', id }); return { ok: 1, report: g.box.find((x) => x.id === id) }; };
  g.addReport = (x, y, content, at = g.now()) => { const r = { id: nextReport++, eventTime: at, startPos: 'Home(100,100)', targetPos: `NPC(${x},${y})`, content }; g.box.push(r); return r; };
  g.tavernList = async () => ({ ok: 1, heros: [{ name: 'InnA', power: 80, management: 30, stratagem: 10 }, { name: 'InnB', power: 40, management: 90, stratagem: 70 }] });
  g.hireHero = async (castleId, heroName) => { log.push({ cmd: 'hire', castleId, heroName }); return { ok: 1 }; };
  const sends = () => log.filter((x) => x.cmd === 'newArmy');
  const recalls = () => log.filter((x) => x.cmd === 'recall');
  return { g, log, sends, recalls };
}
const heroOf = (w, id) => w.g.castles.flatMap((c) => c.heros).find((h) => h.id === id);
const sessionFor = (w, extra = {}) => {
  const notes = [];
  return { notes, connected: true, get game() { return w.g; }, account: { id: 'acct' }, note(m, meta) { notes.push({ m, meta }); },
    text: () => notes.map((n) => n.m).join('\n'), ...extra };
};

async function runIn(w, src, opts = {}) {
  const out = [];
  const view = script.parse(src);
  const errs = view.filter((a) => a.cmd === 'error');
  if (errs.length) throw new Error('parse: ' + errs.map((e) => `line ${e.line}: ${e.error}`).join('; '));
  const done = await script.run(w.g, view, (m) => out.push(m), { castle: 'Home', repeatGapMs: 0, ...opts });
  return { done, out, text: out.join('\n') };
}
// the value of $result / $error after the last line
const probe = '\necho "result=" + $result\necho "error=" + $error';
const resultOf = (r) => (r.text.match(/ {2}result=(.*)$/m) || [])[1];
const errorOf = (r) => (r.text.match(/ {2}error=(.*)$/m) || [])[1];

const battleXml = ({ win = true, seized = false, support = null } = {}) => '<reportData><battleReport isAttack="true" isAttackSuccess="'
  + win + '" isSeize="' + seized + '"' + (support === null ? '' : ` support="${support}"`) + ' round="2"/></reportData>';
function scoutXml({ success = true, loyalty = null, troops = null, forts = null, info = true } = {}) {
  const units = (tag, list) => list.map(([id, n]) => `<${tag} typeId="${id}" count="${n}"/>`).join('');
  const body = !info ? '' : `<scoutInfo${loyalty === null ? '' : ` support="${loyalty}"`}>`
    + (troops ? `<troops>${units('troopStrType', troops)}</troops>` : '')
    + (forts ? `<fortifications>${units('fortificationsType', forts)}</fortifications>` : '') + '</scoutInfo>';
  return `<reportData><scoutReport isAttack="true" isFound="true" isSuccess="${success}">${body}</scoutReport></reportData>`;
}

// ---------------------------------------------------------------------------
section('the wiki\'s lines parse (Deployment pages, HeroString)');

t('Attack: all six examples', () => {
  const a = P('attack 111,222 any a:1000');
  assert.deepStrictEqual([a.cmd, a.target, a.hero, a.troops, a.resources, a.land, a.camp], ['attack', { x: 111, y: 222 }, 'any', { archer: 1000 }, null, null, null]);
  assert.strictEqual(P('attack 111,222 any a:1000 @00:30:00').camp, 1800);
  const c = P('attack 111,222 any a:1000 s:100 @:18:20:20');
  assert.deepStrictEqual([c.troops, c.resources, c.land], [{ archer: 1000 }, { stone: 100 }, { h: 18, m: 20, s: 20, ms: 0 }]);
  const big = P('attack 111,222 any s:125k /big');
  assert.deepStrictEqual([big.troops, big.big, big.horde], [{ scouter: 125000 }, true, undefined]);
  const horde = P('attack 111,222 any s:1m /horde');
  assert.deepStrictEqual([horde.troops, horde.big, horde.horde], [{ scouter: 1000000 }, undefined, true]);
  const both = P('attack 111,222 any s:1.25m /big /horde');
  assert.deepStrictEqual([both.troops, both.big, both.horde], [{ scouter: 1250000 }, true, true]);
  assert.match(parseErr('attack 111,222 any a:1 /huge'), /the switches are \/big \(a War Ensign\) and \/horde/);
});
t('BigAttack, BigScout, BigTransport', () => {
  const a = P('bigattack 111,222 any a:125000');
  assert.deepStrictEqual([a.cmd, a.big, a.troops], ['attack', true, { archer: 125000 }]);
  const s = P('bigscout 111,222 ken s:125000');
  assert.deepStrictEqual([s.cmd, s.big, s.hero, s.troops], ['scout', true, 'ken', { scouter: 125000 }]);
  const tr = P('bigtransport 111,222 t:125000 f:120000000');
  assert.deepStrictEqual([tr.cmd, tr.big, tr.hero, tr.troops, tr.resources], ['transport', true, null, { carriage: 125000 }, { food: 120000000 }]);
  assert.deepStrictEqual(P('bigtransport 111,222 trans:125000 f:1').troops, { carriage: 125000 }, 'the usage writes trans:');
});
t('BigDeploy: the example, and its march types atk bld rei sct', () => {
  const a = P('bigdeploy reinforce 111,222 none t:5k f:100k 1:30:00');
  assert.deepStrictEqual([a.cmd, a.big, a.hero, a.troops, a.resources, a.camp], ['reinforce', true, null, { carriage: 5000 }, { food: 100000 }, 5400]);
  assert.deepStrictEqual(['atk 1,2 any a:1', 'bld 1,2 any wo:500', 'rei 1,2 none a:1', 'sct 1,2 none s:1'].map((l) => P('bigdeploy ' + l).cmd),
    ['attack', 'construct', 'reinforce', 'scout']);
  assert.strictEqual(P('bigdeploy reinforce 111,222 none a:1 @:9:30').land.h, 9);
  assert.match(parseErr('bigdeploy zz 1,2 any a:1'), /atk, bld, rei and sct too/);
});
t('BigReinforce: both examples', () => {
  const a = P('bigreinforce 111,222 none a:125k f:10000 @:9:30');
  assert.deepStrictEqual([a.cmd, a.big, a.hero, a.troops, a.resources, a.land], ['reinforce', true, null, { archer: 125000 }, { food: 10000 }, { h: 9, m: 30, s: 0, ms: 0 }]);
  const b = P('bigreinforce 111,222 any:attack=best a:100k,w:25k');
  assert.deepStrictEqual([b.hero, b.troops], ['any:attack=best', { archer: 100000, militia: 25000 }]);
});
t('Deploy: the example, and its march types', () => {
  const a = P('deploy reinforce 111,222 none w:25000 f:100000 1:30:00');
  assert.deepStrictEqual([a.cmd, a.hero, a.troops, a.resources, a.camp], ['reinforce', null, { militia: 25000 }, { food: 100000 }, 5400]);
  assert.deepStrictEqual(['at', 'bu', 're', 'sc', 'tr', 'atk', 'bld', 'rei', 'sct'].map((m) => P(`deploy ${m} 1,2 any ${m === 'bu' || m === 'bld' ? 'wo:500' : 't:1'}`).cmd),
    ['attack', 'construct', 'reinforce', 'scout', 'transport', 'attack', 'construct', 'reinforce', 'scout']);
  assert.strictEqual(P('deploy at 1,2 any a:1 @:3:37').land.m, 37, '@:h:mm, 24-hour');
});
t('Scout: with a hero and with none; Reinforce and Transport examples', () => {
  assert.deepStrictEqual([P('scout 111,222 ken s:100000').hero, P('scout 111,222 ken s:100000').troops], ['ken', { scouter: 100000 }]);
  assert.deepStrictEqual([P('scout 111,222 none s:25000').hero, P('scout 111,222 none s:25000').troops], [null, { scouter: 25000 }]);
  const r = P('reinforce 111,222 none t:100 f:10000 @:9:30');
  assert.deepStrictEqual([r.hero, r.troops, r.resources, r.land.h], [null, { carriage: 100 }, { food: 10000 }, 9]);
  assert.deepStrictEqual(P('reinforce 111,222 ken a:90000,w:10000').troops, { archer: 90000, militia: 10000 });
  const tr = P('transport 111,222 t:1000 f:999998');
  assert.deepStrictEqual([tr.cmd, tr.troops, tr.resources], ['transport', { carriage: 1000 }, { food: 999998 }]);
  assert.match(parseErr('scout 111,222 s:1'), /scout: needs a hero — .* or none to send it without one/);
});
t('SpamAttack, LoyaltyAttack, Capture', () => {
  assert.deepStrictEqual(P('spamattack 111,222 c:500,s:500 10'), { cmd: 'spamattack', target: { x: 111, y: 222 }, troops: { lightCavalry: 500, scouter: 500 }, waves: 10 });
  assert.deepStrictEqual(P('loyaltyattack 111,222 s:100,c:5k').troops, { scouter: 100, lightCavalry: 5000 });
  assert.deepStrictEqual(P('loyaltyattack 111,222 3000').troops, { lightCavalry: 3000 }, 'a bare number is cavalry');
  assert.deepStrictEqual(P('capture 111,222 s:100,c:5k').troops, { scouter: 100, lightCavalry: 5000 });
  assert.deepStrictEqual(P('capture 111,222 3000').troops, { lightCavalry: 3000 });
  assert.deepStrictEqual(P('capture 111,222').troops, { lightCavalry: 500 }, 'none given: 500 cavalry');
  assert.match(parseErr('spamattack 111,222 c:500,s:500'), /say how many waves/);
  assert.match(parseErr('capture 111,222 zz:5'), /not a troop string/);
});
t('GuardedAttack: both examples', () => {
  const a = P('guardedattack 111,222 a:99600,w:100,s:100,p:100,sw:100 10 a:60000,cav:50000 at:19000');
  assert.deepStrictEqual([a.troops, a.scouts, a.limits], [{ archer: 99600, militia: 100, scouter: 100, pikemen: 100, swordsmen: 100 }, 10,
    { troops: { archer: 60000, lightCavalry: 50000 }, forts: { tower: 19000 } }]);
  const b = P('guardedattack 111,222 cav:99000,s:1000 10 a:500000 ab:1');
  assert.deepStrictEqual([b.troops, b.scouts, b.limits], [{ lightCavalry: 99000, scouter: 1000 }, 10, { troops: { archer: 500000 }, forts: { abatis: 1 } }]);
  assert.match(parseErr('guardedattack 111,222 cav:99000 10 a:500000'), /usage {2}guardedattack/);
});
t('SetGuard: the example, the NPC10 check, and no wall condition', () => {
  assert.deepStrictEqual(P('setguard 111,222 a:60000,cav:50000 ab:100').limits, { troops: { archer: 60000, lightCavalry: 50000 }, forts: { abatis: 100 } });
  const lines = script.parse('attack 111,222 bob c:99k,s:1k\nscout 111,222 fred s:1\n'
    + 'setguard 111,222 wo:1,w:400001,s:1,p:1,sw:1,a:1,c:1,cata:1,t:1,b:1,r:1,cp:1 at:5000,tre:2000');
  assert.ok(!lines.some((x) => x.cmd === 'error'), JSON.stringify(lines));
  assert.deepStrictEqual(lines[2].limits.forts, { tower: 5000, rocks: 2000 });
  assert.strictEqual(lines[2].limits.troops.batteringRam, 1, 'r in a troop list is the ram; in the walls it is logs');
  assert.strictEqual(lines[2].limits.troops.militia, 400001);
  assert.match(parseErr('setguard 111,222 a:60000,cav:50000'), /a wall condition is needed/);
  assert.match(parseErr('setguard 111,222 a:1 zz:1'), /a wall condition is needed/);
});
t('Recall, RecallAll, IdRecall, RecallHero, the End* lines, SetBallsUsed', () => {
  assert.deepStrictEqual(P('recall 111,222'), { cmd: 'recall', target: { x: 111, y: 222 }, targetCity: null });
  assert.deepStrictEqual(P('recallall'), { cmd: 'recallall' });
  assert.deepStrictEqual(P('idrecall 100333040'), { cmd: 'idrecall', armyId: 100333040 });
  assert.deepStrictEqual(P('idrecall !100333040').armyId, 100333040, 'the wiki\'s !ArmyId is MoinMoin markup');
  assert.deepStrictEqual(P('recallhero Fred'), { cmd: 'recallhero', hero: 'Fred' });
  assert.deepStrictEqual(P('recallhero any:att=best').hero, 'any:att=best');
  for (const w of ['endspamattack', 'endloyaltyattack', 'endguardedattack']) assert.deepStrictEqual(P(w), { cmd: w, all: false });
  assert.strictEqual(P('endspamattack all').all, true);
  assert.deepStrictEqual(P('setballsused 20,50,130,200,400').counts, [20, 50, 130, 200, 400]);
  assert.match(parseErr('idrecall soon'), /give the army id/);
  assert.match(parseErr('recallhero none'), /"none" is no hero/);
});
t('GetSpamHero, HeroRoute, WaitHero, WaitHeroLost, TravelInfo', () => {
  assert.deepStrictEqual(P('getspamhero'), { cmd: 'hire', best: true, attr: null });
  assert.deepStrictEqual(['power', 'atk', 'management', 'pol', 'stratagem', 'int'].map((x) => P('getspamhero ' + x).attr),
    ['power', 'power', 'management', 'management', 'stratagem', 'stratagem']);
  assert.match(parseErr('getspamhero luck'), /power\|atk, management\|pol or stratagem\|int/);
  assert.deepStrictEqual(P('heroroute'), { cmd: 'heroroute' });
  assert.deepStrictEqual(P('waithero ken'), { cmd: 'waithero', hero: 'ken' });
  assert.deepStrictEqual(P('waithero any:attack>=200').hero, 'any:attack>=200');
  assert.deepStrictEqual(P('waitherolost ken,henry'), { cmd: 'waitherolost', heroes: 'ken,henry' });
  const ti = P('travelinfo 111,222 cav:10,cata:10');
  assert.deepStrictEqual([ti.target, ti.troops], [{ x: 111, y: 222 }, { lightCavalry: 10, heavyCavalry: 10 }]);
});
t('HeroString: the wiki\'s script lines and every form of the grammar, checked on load', () => {
  assert.strictEqual(P('attack 111,222 !Biggy,any:attack>180 c:99k,s:1k').hero, '!Biggy,any:attack>180');
  assert.strictEqual(P('attack 111,222 !Polly,any:attack<100 w:5k').hero, '!Polly,any:attack<100');
  assert.strictEqual(P('reinforce 123,456 any c:100000').hero, 'any');
  for (const hs of ['bob,fred,joe|any:attack>=60', 'any:base>60,attack<300', 'att*:attack>200', '*:base>60', 'att??int:base>=69',
    '100,100', 'any:attack>politics', 'any:politics>level', 'any:attack<best', 'any:loy=100,exp>5k,pts<>0,lvl!=5,bse<=69', 'Farmer:attack<200']) {
    assert.strictEqual(P(`attack 1,2 ${hs} a:1`).hero, hs, hs);
  }
  assert.match(parseErr('attack 1,2 100 a:1'), /hero string "100" — "100" is just a number/);
  assert.match(parseErr('attack 1,2 any:luck>5 a:1'), /unknown hero field "luck"/);
  assert.match(parseErr('waithero any:attack>'), /missing a value/);
  const s = script.parse('attack 1,2 any:attack>>5 a:1');
  assert.strictEqual(s[0].cmd, 'error', 'a bad hero string stops the script before it runs');
});
t('coordinates are on the map', () => {
  assert.match(parseErr('attack 800,5 any a:1'), /off the map — x and y run 0-799/);
  assert.match(parseErr('spamattack 1,900 c:1 2'), /off the map/);
});

// ---------------------------------------------------------------------------
section('hero strings pick the hero that goes');

const heroSent = (w, i = 0) => w.sends()[i] && w.sends()[i].bean.heroId;
t('any on an attack: the strongest idle attack hero (never the mayor, one out, or a prisoner)', async () => {
  const w = world();
  await runIn(w, 'attack 111,222 any a:1');
  assert.strictEqual(heroSent(w), 12, 'Biggy 300: Mayor 400, Away 500 and Prisoner 600 cannot go');
});
t('any on a reinforce keeps the roster order', async () => {
  const w = world();
  await runIn(w, 'reinforce 111,222 any a:1');
  assert.strictEqual(heroSent(w), 11);
});
t('!name excludes, and the filters apply', async () => {
  const w = world();
  await runIn(w, 'attack 111,222 !Biggy,any:attack>100 a:1');
  assert.strictEqual(heroSent(w), 11);
});
t('a list goes in the order written', async () => {
  const w = world();
  await runIn(w, 'reinforce 111,222 Polly,Ken a:1');
  assert.strictEqual(heroSent(w), 13);
});
t('wildcards, and | between alternatives', async () => {
  const w = world();
  await runIn(w, 'attack 111,222 att??int:base>=69 a:1\nreinforce 111,222 nobody|Pol* a:1');
  assert.deepStrictEqual([heroSent(w, 0), heroSent(w, 1)], [17, 13]);
});
t('base is the top attribute less the levels (goal-heroes and the deploy lines read the same base)', async () => {
  const w = world();
  const h17 = heroOf(w, 17);
  assert.strictEqual(Game.heroBase(h17), 69);
  // since the goals build-out both sides read Game.heroBase; the deploy module
  // keeps no base of its own (it used to, while goal-heroes read attribute − *Added)
  assert.strictEqual(H.matchHero(h17, 'any:base<=69'), true, 'goal-heroes: base 69');
  assert.strictEqual(D.heroMatches(h17, 'any:base<=69'), true);
  await runIn(w, 'attack 111,222 any:base<=69,level<50 a:1');
  assert.strictEqual(heroSent(w), 17, 'att69int, strongest of the three that fit');
});
t('none sends no heroId, even on an attack', async () => {
  const w = world();
  await runIn(w, 'attack 111,222 none a:1\nscout 111,222 none s:25000');
  assert.ok(!('heroId' in w.sends()[0].bean) && !('heroId' in w.sends()[1].bean));
});
t('best compares against every hero of the city: the best is out, so nothing goes', async () => {
  const w = world();
  const r = await runIn(w, 'attack 111,222 any:attack=best a:1' + probe);
  assert.strictEqual(w.sends().length, 0);
  assert.match(errorOf(r), /no idle hero in Home matches any:attack=best — Away is marching/);
});
t('a named hero that is away, the mayor, a prisoner or unknown is not sent', async () => {
  const w = world();
  const r = await runIn(w, 'attack 111,222 Away a:1\nattack 111,222 Mayor a:1\nattack 111,222 Prisoner a:1\nattack 111,222 bob a:1');
  assert.strictEqual(w.sends().length, 0, r.text);
  assert.match(r.text, /FAILED: no idle hero in Home matches Away — Away is marching/);
  assert.match(r.text, /FAILED: no idle hero in Home matches Mayor — Mayor is mayor/);
  assert.match(r.text, /FAILED: no hero in Home matches Prisoner/);
  assert.match(r.text, /FAILED: no hero in Home matches bob/);
});
t('repeat with any takes a new hero each time; a named hero cannot go twice', async () => {
  const w = world();
  await runIn(w, 'attack 111,222 any a:1\nrepeat 3');
  assert.deepStrictEqual(w.sends().map((s) => s.bean.heroId), [12, 11, 17]);
  const v = world();
  const r = await runIn(v, 'reinforce 111,222 Ken a:1\nreinforce 111,222 Ken a:1');
  assert.strictEqual(v.sends().length, 1);
  assert.match(r.text, /Ken is marching/);
});
t('the any skip holds even before the server says the hero is away', async () => {
  const w = world();
  const orig = w.g.newArmy;
  w.g.newArmy = async (cid, bean) => { const h = heroOf(w, bean.heroId); const r = await orig(cid, bean); if (h) h.status = 0; return r; };
  await runIn(w, 'attack 111,222 any a:1\nattack 111,222 any a:1\nreinforce 111,222 Biggy a:1');
  assert.deepStrictEqual(w.sends().map((s) => s.bean.heroId), [12, 11]);
});

// ---------------------------------------------------------------------------
section('what a march sends');

t('/big ticks the War Ensign (useFlag), /horde the Horde box (useItem), bigattack = /big', async () => {
  const w = world();
  const r = await runIn(w, 'attack 111,222 any s:125k /big\nattack 111,222 any s:1m /horde\nbigattack 111,222 any a:125000\nattack 111,222 any a:1');
  const b = w.sends().map((s) => [s.bean.useFlag, s.bean.useItem]);
  assert.deepStrictEqual(b, [[true, false], [false, true], [true, false], [false, false]]);
  assert.match(r.text, /· War Ensign/);
  assert.match(r.text, /· Horde/);
});
t('/big counts its War Ensigns down within a run: one held, a repeat sends one /big march, not three', async () => {
  const w = world({ items: [{ id: 'player.troop.1.a', count: 1 }] });
  const r = await runIn(w, 'attack 111,222 any a:10 /big\nrepeat 3' + probe);
  assert.deepStrictEqual(w.sends().map((s) => s.bean.useFlag), [true], 'no ItemUpdate came, so the one held was counted off here');
  assert.match(errorOf(r), /\/big spends a War Ensign, and you hold none this run has not used already — nothing was sent/);
  // two held: two go, the third is refused
  const v = world({ items: [{ id: 'player.troop.1.a', count: 2 }] });
  const s = await runIn(v, 'attack 111,222 any a:10 /big\nattack 111,222 any a:10 /big\nattack 111,222 any a:10 /big' + probe);
  assert.deepStrictEqual(v.sends().map((x) => x.bean.useFlag), [true, true]);
  assert.match(errorOf(s), /you hold none this run has not used already/);
});
t('/big with the inventory not loaded is refused (a missing War Ensign is bought with cents)', async () => {
  const w = world({ items: null });
  w.g.player.items = undefined;
  const r = await runIn(w, 'attack 111,222 any a:10 /big' + probe + '\nattack 111,222 any a:10');
  assert.deepStrictEqual(w.sends().map((s) => s.bean.useFlag), [false], 'the plain march still goes');
  assert.match(errorOf(r), /\/big spends a War Ensign, and the inventory has not loaded, so whether one is held cannot be checked — nothing was sent/);
});
t('a reconnect while a timed march waits to send: it goes out on the new connection (timed-march.js gets a live view)', async () => {
  const w1 = world(), w2 = world();
  const session = { connected: true, game: w1.g, account: { id: 'acct' }, note() {} };
  const march = C.marchTimeMs({ x: 100, y: 100 }, { x: 101, y: 101 }, ['archer'], { marchSkill: 0, driveSkill: 0 });
  // to the ms: 1.7 s of slack is a 1 s camp and a send about 0.65 s from now, well after the reconnect
  const aim = new Date(Date.now() + march + 1700);
  const p2 = (x, k = 2) => String(x).padStart(k, '0');
  const at = `@:${p2(aim.getHours())}:${p2(aim.getMinutes())}:${p2(aim.getSeconds())}.${p2(aim.getMilliseconds(), 3)}`;
  const swap = setTimeout(() => { session.game = w2.g; }, 200);
  try {
    const r = await runIn(w1, `attack 101,101 any a:10 ${at}`, { session });
    assert.strictEqual(w1.sends().length, 0, 'nothing on the old connection:\n' + r.text);
    assert.strictEqual(w2.sends().length, 1, r.text);
  } finally { clearTimeout(swap); }
});
t('/big with no War Ensign held is refused, and nothing is bought', async () => {
  const w = world({ items: [{ id: 'player.other', count: 5 }] });
  const r = await runIn(w, 'bigattack 111,222 any a:125000' + probe);
  assert.strictEqual(w.sends().length, 0);
  assert.match(errorOf(r), /\/big spends a War Ensign, and you hold none — nothing was sent\. It is never bought for you/);
  assert.ok(!w.log.some((x) => x.cmd === 'buy'));
});
t('a dry run says why no hero can go, and sends nothing', async () => {
  const w = world();
  const r = await runIn(w, 'attack 111,222 !Biggy,any:attack>180 c:99k,s:1k /big', { dryRun: true });
  assert.strictEqual(w.sends().length, 0);
  assert.match(r.text, /FAILED: no idle hero in Home matches !Biggy,any:attack>180 — Mayor is mayor, Away is marching/);
});
t('a dry run of a line whose hero can go', async () => {
  const w = world();
  const r = await runIn(w, 'scout 111,222 ken s:100000', { dryRun: true });
  assert.strictEqual(w.sends().length, 0);
  assert.match(r.text, /scout -> \(111,222\) field \d+ from Home · hero Ken · 100,000 Scout · missionType 3/);
  assert.match(r.text, /\[dry run\] not sent/);
});
t('a camp time goes as restTime; a transport carries its resources', async () => {
  const w = world();
  await runIn(w, 'attack 111,222 any a:1000 @00:30:00\ntransport Fla t:1000 f:999998');
  assert.strictEqual(w.sends()[0].bean.restTime, 1800);
  assert.deepStrictEqual([w.sends()[1].bean.missionType, w.sends()[1].bean.troops.carriage, w.sends()[1].bean.resource.food, w.sends()[1].bean.targetPoint],
    [C.MISSION.transport, 1000, 999998, F(120, 100)]);
});
// Home (100,100) -> Fla (120,100): 20 tiles; transporters 150/h at skill 0 = 2.22 h,
// eating 10 x 2 = 20 food an hour: 44 food.
t('Transport: more than the hold less the march food is refused (the client refuses it too)', async () => {
  const w = world();
  const r = await runIn(w, 'transport Fla t:1 f:4957' + probe);
  assert.strictEqual(w.sends().length, 0);
  assert.match(errorOf(r), /1 Transporter carry 5,000 with this city's research, less 44 food for the march — room for 4,956, and this asks for 4,957\. Nothing was sent/);
  const ok = world();
  await runIn(ok, 'transport Fla t:1 f:4956');
  assert.strictEqual(ok.sends().length, 1, 'exactly full goes');
});
t('Logistics and the Relief Station make room; camp eats more', async () => {
  const w = world({ loadSkill: 10 });
  await runIn(w, 'transport Fla t:1 f:5400');
  assert.strictEqual(w.sends().length, 1, '5,500 with 10% Logistics');
  const r3 = world({ relief: 3 });
  await runIn(r3, 'transport Fla t:1 f:4985');
  assert.strictEqual(r3.sends().length, 1, 'three times as fast: 14 food');
  const camp = world();
  const r = await runIn(camp, 'transport Fla t:1 f:4950 @1:00:00');
  assert.strictEqual(camp.sends().length, 0, r.text);
  assert.match(r.text, /less 64 food for the march/);
});
t('with the city\'s Logistics unknown it is sent with a warning, as before', async () => {
  const w = world({ params: false });
  const r = await runIn(w, 'reinforce Fla wood:1000');
  assert.strictEqual(w.sends().length, 1);
  assert.match(r.text, /1 Scout carry about 5 before research, and this asks for 1,000 — the server may refuse/);
});
t('from <city> sends from there, with that city\'s heroes', async () => {
  const w = world();
  await runIn(w, 'attack 111,222 any a:1 from Fla');
  assert.deepStrictEqual([w.sends()[0].castleId, w.sends()[0].bean.heroId], [2, 21]);
});
t('dumpresource\'s call: parseMarch(word, line, tok) and transport.run(action, env)', async () => {
  const line = 'transport Fla t:2 f:1000,w:500';
  const a = D.parseMarch('transport', line, line.split(/\s+/));
  assert.deepStrictEqual([a.cmd, a.targetCity, a.troops, a.resources], ['transport', 'Fla', { carriage: 2 }, { food: 1000, wood: 500 }]);
  assert.strictEqual(typeof D.commands.transport.run, 'function');
});

// ---------------------------------------------------------------------------
section('recalls');

function armiesWorld() {
  const w = world();
  const T = F(111, 222);
  w.g.player.selfArmys = [
    { armyId: 1, direction: 1, missionType: 5, targetFieldId: T, startFieldId: F(100, 100), hero: 'Away', targetPosName: 'NPC' },
    { armyId: 2, direction: 1, missionType: 5, targetFieldId: T, startFieldId: F(120, 100) },
    { armyId: 3, direction: 3, missionType: 2, targetFieldId: T, startFieldId: F(100, 100) },
    { armyId: 4, direction: 2, missionType: 5, targetFieldId: T, startFieldId: F(100, 100) },
    { armyId: 5, direction: 1, missionType: 3, targetFieldId: F(5, 5), startFieldId: F(100, 100) },
  ];
  return w;
}
t('recall x,y: every army on its way there or staying, from any city, each from its own city', async () => {
  const w = armiesWorld();
  const r = await runIn(w, 'recall 111,222' + probe);
  assert.deepStrictEqual(w.recalls().map((x) => [x.castleId, x.armyId]), [[1, 1], [2, 2], [1, 3]]);
  assert.strictEqual(resultOf(r), '3');
  assert.ok(!errorOf(r) || errorOf(r) === 'null', r.text);
});
t('recallall: every army out from this city', async () => {
  const w = armiesWorld();
  await runIn(w, 'recallall');
  assert.deepStrictEqual(w.recalls().map((x) => x.armyId), [1, 3, 5]);
});
t('idrecall: that army; an unknown one, or one on its way home, fails', async () => {
  const w = armiesWorld();
  const r = await runIn(w, 'idrecall 2\nidrecall 99\nidrecall 4');
  assert.deepStrictEqual(w.recalls().map((x) => [x.castleId, x.armyId]), [[2, 2]]);
  assert.match(r.text, /FAILED: no army of yours has id 99/);
  assert.match(r.text, /FAILED: army 4 .* is already on its way home/);
});
t('a dry run lists the recalls and sends none', async () => {
  const w = armiesWorld();
  const r = await runIn(w, 'recall 111,222', { dryRun: true });
  assert.strictEqual(w.recalls().length, 0);
  assert.strictEqual((r.text.match(/\[dry run\] not sent/g) || []).length, 3);
});
t('recallhero: a hero out marching comes back (hero.callBackHero); one at home does not', async () => {
  const w = world();
  const r = await runIn(w, 'recallhero Fred\nrecallhero any:att=best' + probe + '\nrecallhero Ken');
  assert.deepStrictEqual(w.log.filter((x) => x.cmd === 'callBackHero').map((x) => [x.castleId, x.heroId]), [[1, 15]]);
  assert.match(r.text, /FAILED: no hero in Home matches Fred/);
  assert.match(r.text, /recall Away \(marching\) to Home/);
  assert.strictEqual(resultOf(r), 'Away');
  assert.match(r.text, /FAILED: Ken is idle — only a hero out marching or camping comes back/);
});

// ---------------------------------------------------------------------------
section('waiting on heroes');

t('waithero: at once when one is free; $result is its name', async () => {
  const w = world();
  const r = await runIn(w, 'waithero ken' + probe + '\nwaithero any:attack>=200' + probe);
  assert.deepStrictEqual(r.out.filter((l) => /^ {2}result=/.test(l)), ['  result=Ken', '  result=Biggy']);
});
t('waithero waits for a hero out to come home', async () => {
  const w = world();
  setTimeout(() => { heroOf(w, 15).status = 0; }, 60);
  const t0 = Date.now();
  const r = await runIn(w, 'waithero Away' + probe);
  assert.ok(Date.now() - t0 >= 50, 'it waited');
  assert.match(r.text, /waiting for Away to be in Home and free/);
  assert.strictEqual(resultOf(r), 'Away');
});
t('Stop ends a waithero; a dry run does not wait', async () => {
  const w = world();
  const t0 = Date.now();
  const r = await runIn(w, 'waithero Away\necho after', { shouldStop: () => Date.now() - t0 > 50 });
  assert.doesNotMatch(r.text, /after/);
  const d = await runIn(world(), 'waithero Away\necho after', { dryRun: true });
  assert.match(d.text, /\[dry run\] not waiting/);
  assert.match(d.text, /after/);
});
t('waitherolost: until one of them is no longer yours', async () => {
  const w = world();
  setTimeout(() => { w.g.castles[0].heros = w.g.castles[0].heros.filter((h) => h.id !== 11); }, 30);
  const r = await runIn(w, 'waitherolost ken,henry' + probe);
  assert.match(r.text, /watching Ken/);
  assert.match(r.text, /Ken is no longer yours \(captured — or dismissed\)/);
  assert.strictEqual(resultOf(r), 'Ken');
  const none = await runIn(world(), 'waitherolost henry');
  assert.match(none.text, /FAILED: no hero of yours matches henry/);
});
t('waitherolost: a hero moving to another city is not lost', async () => {
  const w = world();
  setTimeout(() => {
    const ken = heroOf(w, 11);
    w.g.castles[0].heros = w.g.castles[0].heros.filter((h) => h.id !== 11);
    setTimeout(() => w.g.castles[1].heros.push(ken), 10);
  }, 20);
  const t0 = Date.now();
  const r = await runIn(w, 'waitherolost ken', { shouldStop: () => Date.now() - t0 > 250 });
  assert.doesNotMatch(r.text, /no longer yours/);
});

// ---------------------------------------------------------------------------
section('travelinfo, getspamhero, heroroute, setballsused');

// Home (100,100) -> 111,222: 122.49 tiles. Cataphracts are slowest (750):
// 9,799.6 s = 2h:43m:20. Carry 10x100 + 10x80 = 1,800; food 10x18x2 + 10x35x2
// = 1,060 an hour.
t('travelinfo: NEAT\'s four lines, and $result', async () => {
  const w = world();
  const r = await runIn(w, 'travelinfo 111,222 cav:10,cata:10\nx = $result\necho x.carry x.carryAttack x.attackSeconds');
  assert.match(r.text, / {2}Distance to 111,222: 122\.49miles \(from Home\)/);
  assert.match(r.text, / {2}attack time: 2h:43m:20/);
  assert.match(r.text, / {2}reinforce time: 2h:43m:20/);
  assert.match(r.text, / {2}carrying total\/attack\/reinforce: 1800\/-1086\/-1086/);
  assert.match(r.text, / {2}1800 -1086 9800/);
  assert.strictEqual(w.sends().length, 0);
});
t('travelinfo: the Relief Station makes the reinforce faster, and Logistics carries more', async () => {
  const w = world({ relief: 3, loadSkill: 50 });
  const r = await runIn(w, 'travelinfo 111,222 cav:10,cata:10');
  assert.match(r.text, /reinforce time: 54m:27 \(Relief Station x3\)/);
  assert.match(r.text, /carrying total\/attack\/reinforce: 2700\/-186\/1738/);
});
t('getspamhero hires the inn\'s best (hire best)', async () => {
  const w = world();
  // InnA: attack 80; InnB: politics 90, the best of any
  await runIn(w, 'getspamhero\ngetspamhero atk\ngetspamhero pol');
  assert.deepStrictEqual(w.log.filter((x) => x.cmd === 'hire').map((x) => x.heroName), ['InnB', 'InnA', 'InnB']);
});
t('heroroute: each city and where the traininghero goes from it', async () => {
  const w = world();
  w.g.castles.push({ id: 3, name: 'Third', fieldId: F(50, 50), heros: [] });
  const goals = { 1: 'traininghero Ken 600', 2: 'traininghero Ken 600', 3: 'npc 5' };
  const session = sessionFor(w, { org: { goals: { own: (acct, cid) => ({ src: goals[cid] }) } } });
  const r = await runIn(w, 'heroroute\nx = $result\necho x.length', { session });
  assert.match(r.text, /traininghero Ken \(in Home now\):/);
  assert.match(r.text, / {4}Home -> Fla\n {4}Fla -> Home\n {4}Third -> Home \(not in the rotation\)/);
  assert.match(r.text, / {2}3$/m);
  const bare = await runIn(world(), 'heroroute');
  assert.match(bare.text, /FAILED: heroroute reads the cities' traininghero goals, which only the console has/);
});
t('setballsused: retired, says what to use, changes nothing', async () => {
  const w = world();
  const r = await runIn(w, 'setballsused 20,50,130,200,400' + probe);
  assert.match(r.text, /setballsused is retired .* config ballsused:<n>/);
  assert.match(errorOf(r), /Nothing was changed/);
});

// ---------------------------------------------------------------------------
section('background: spamattack');

t('spamattack: the waves go with idle SpamHeroes at 100 loyalty, and it outlives the script', async () => {
  const w = world();
  const session = sessionFor(w);
  const r = await runIn(w, 'spamattack 111,222 c:500,s:500 3' + probe, { session });
  assert.match(r.text, /3 waves of 500 Scout, 500 Cavalry at 111,222|3 waves of 500 Cavalry, 500 Scout at 111,222/);
  // goal-heroes.spamHeroPool (the goals build-out) explains the picks: the rule,
  // who it held back and who is free now
  assert.match(r.text, /SpamHeroes: any:base<=69,level<50 \(NEAT's default — this city has no spamheroes goal\); held back: Disloyal \(loyalty 80 \(under 100\)\) — free now: att69int, Spammy/);
  assert.match(r.text, /started as #\d+ — it goes on after this script ends/);
  assert.match(resultOf(r), /^\d+$/, '$result is the task id');
  await until(() => w.sends().length === 2);
  await sleep(40);
  assert.strictEqual(w.sends().length, 2, 'Disloyal (80 loyalty) never goes; Ken does not fit the default');
  assert.match(session.text(), /no SpamHero at 100 loyalty is free in Home — waiting for one/);
  // att69int home again would still be skipped (sent under a minute ago); Disloyal comes to 100 loyalty
  heroOf(w, 17).status = 0;
  heroOf(w, 19).loyalty = 100;
  await until(() => w.sends().length === 3);
  await until(() => /all 3 waves sent — done/.test(session.text()));
  assert.deepStrictEqual(w.sends().map((s) => [s.bean.missionType, s.bean.heroId, s.bean.troops.lightCavalry]), [[5, 17, 500], [5, 18, 500], [5, 19, 500]]);
  assert.strictEqual(L.TASKS.size, 0);
});
t('endspamattack stops it; attackstatus shows it first', async () => {
  const w = world();
  const session = sessionFor(w);
  for (const h of w.g.castles[0].heros) h.status = h.id === 18 ? 0 : 3;
  const r = await runIn(w, 'spamattack 111,222 c:500 10\nattackstatus', { session });
  assert.match(r.text, /#\d+ spamattack 111,222 from Home: \d+ of 10 waves sent, 0 refused/);
  await until(() => w.sends().length === 1);
  const e = await runIn(w, 'endspamattack' + probe, { session });
  assert.match(e.text, /ended #\d+ spamattack 111,222 from Home — 1 of 10 waves sent/);
  assert.strictEqual(resultOf(e), '1');
  assert.strictEqual(L.TASKS.size, 0);
  const again = await runIn(w, 'endspamattack\nattackstatus', { session });
  assert.match(again.text, /no spamattack running from Home/);
  assert.match(again.text, /no background attacks running/);
});
t('end... only ends this city\'s unless "all"', async () => {
  const w = world();
  const session = sessionFor(w);
  for (const h of w.g.castles[0].heros) h.status = 3;
  await runIn(w, 'spamattack 111,222 c:500 10', { session });
  const e = await runIn(w, 'endspamattack', { session, castle: 'Fla' });
  assert.match(e.text, /no spamattack running from Fla — 1 from other cities; "endspamattack all" ends those/);
  const all = await runIn(w, 'endspamattack all', { session, castle: 'Fla' });
  assert.match(all.text, /ended #\d+ spamattack/);
  assert.strictEqual(L.TASKS.size, 0);
});
t('three refusals in a row end a spamattack', async () => {
  const w = world({ armyReplies: [{ ok: -5, errorMsg: 'not enough troops' }, { ok: -5, errorMsg: 'no' }, { ok: -5, errorMsg: 'no' }] });
  w.g.newArmy = ((orig) => async (cid, bean) => { const r = await orig(cid, bean); return r; })(w.g.newArmy);
  const session = sessionFor(w);
  await runIn(w, 'spamattack 111,222 c:500 10', { session });
  await until(() => /the server refused 3 waves in a row — done/.test(session.text()));
  assert.strictEqual(w.sends().length, 3);
});
t('no console, no background attack; a dry run starts nothing', async () => {
  const w = world();
  const r = await runIn(w, 'spamattack 111,222 c:500 3' + probe);
  assert.match(errorOf(r), /background attacks run inside the console/);
  const d = await runIn(w, 'spamattack 111,222 c:500 3\ncapture 111,222\nsetguard 111,222 a:1 ab:1', { dryRun: true, session: sessionFor(w) });
  assert.strictEqual((d.text.match(/\[dry run\] not started/g) || []).length, 2, d.text);
  assert.match(d.text, /FAILED: no attack of yours is on its way to 111,222/);
  assert.strictEqual(w.sends().length + L.TASKS.size, 0);
});
t('a spamheroes goal line picks the SpamHeroes', async () => {
  const w = world();
  const session = sessionFor(w, { org: { goals: { own: () => ({ src: 'spamheroes Polly' }) } } });
  await runIn(w, 'spamattack 111,222 c:5 1', { session });
  await until(() => w.sends().length === 1);
  assert.strictEqual(w.sends()[0].bean.heroId, 13);
  await L.stopAll();
});

t('goal-heroes\' spamHeroPool (the goals branch) is used when it is there', async () => {
  const w = world();
  const session = sessionFor(w);
  const calls = [];
  H.spamHeroPool = (castle, running, opts) => {
    calls.push([castle.name, running, opts]);
    return { heroes: [heroOf(w, 11)], held: [{ hero: heroOf(w, 18), why: 'the traininghero' }], usingDefault: false, rule: 'Ken' };
  };
  try {
    const r = await runIn(w, 'spamattack 111,222 c:5 1', { session });
    assert.match(r.text, /SpamHeroes: Ken; held back: Spammy \(the traininghero\) — free now: Ken/);
    await until(() => w.sends().length === 1);
    assert.strictEqual(w.sends()[0].bean.heroId, 11);
    assert.deepStrictEqual(calls[0][2], { minLoyalty: 100 });
  } finally { delete H.spamHeroPool; }
});

// ---------------------------------------------------------------------------
section('background: loyaltyattack and capture');

t('loyaltyattack will not start without a scout report of the loyalty', async () => {
  const w = world();
  const r = await runIn(w, 'loyaltyattack 111,222 3000' + probe, { session: sessionFor(w) });
  assert.match(errorOf(r), /the loyalty of 111,222 is not known — scout it first/);
  assert.strictEqual(L.TASKS.size + w.sends().length, 0);
});
t('loyaltyattack: waves every 30 s until the reports take loyalty to 7, then the rest are recalled', async () => {
  const w = world();
  w.g.addReport(111, 222, scoutXml({ loyalty: 20, troops: [] }), w.g.now() - 3600000);
  w.g.addReport(5, 5, scoutXml({ loyalty: 90 }));
  const session = sessionFor(w);
  const r = await runIn(w, 'loyaltyattack 111,222 s:100,c:5k', { session });
  assert.match(r.text, /loyalty 20 by your scout report/);
  await until(() => w.sends().length >= 1);
  assert.deepStrictEqual(w.sends()[0].bean.troops.lightCavalry, 5000);
  w.g.addReport(111, 222, battleXml({ support: -5 }));
  await until(() => /loyalty 15/.test(session.text()));
  w.g.addReport(111, 222, battleXml({ support: -5 }));
  w.g.addReport(111, 222, battleXml({ support: -5 }));
  await until(() => /loyalty is 5 — done/.test(session.text()));
  const out = w.g.player.selfArmys.filter((a) => a.direction === 2).length;
  assert.ok(out >= 1 && w.recalls().length === out, 'the waves still out were recalled');
  assert.strictEqual(L.TASKS.size, 0);
});
t('a lost battle recalls every attack on its way there, from every city', async () => {
  const w = world();
  w.g.player.selfArmys.push({ armyId: 77, direction: 1, missionType: 5, targetFieldId: F(111, 222), startFieldId: F(120, 100) });
  const session = sessionFor(w);
  await runIn(w, 'capture 111,222 3000', { session });
  await until(() => w.sends().length >= 1);
  w.g.addReport(111, 222, battleXml({ win: false }));
  await until(() => /a wave lost its battle, so every attack on its way there was recalled — done/.test(session.text()));
  const ids = w.recalls().map((x) => [x.castleId, x.armyId]);
  assert.ok(ids.some(([c, a]) => c === 2 && a === 77), JSON.stringify(ids));
  assert.ok(ids.some(([c]) => c === 1));
});
t('capture ends when a report says the city was taken; the waves out are left to land', async () => {
  const w = world();
  const session = sessionFor(w);
  await runIn(w, 'capture 111,222', { session });
  await until(() => w.sends().length >= 1);
  assert.strictEqual(w.sends()[0].bean.troops.lightCavalry, 500);
  w.g.addReport(111, 222, battleXml({ seized: true }));
  await until(() => /111,222 was taken — the \d+ wave\(s\) still on the way are left to land — done/.test(session.text()));
  assert.strictEqual(w.recalls().length, 0);
});
t('reports from before the start, or about other places, do not count', async () => {
  const w = world();
  w.g.addReport(111, 222, battleXml({ win: false }), w.g.now() - 60000);
  w.g.addReport(5, 5, battleXml({ win: false }));
  const session = sessionFor(w);
  await runIn(w, 'capture 111,222', { session });
  await until(() => w.sends().length >= 2);
  assert.strictEqual(w.recalls().length, 0);
  const e = await runIn(w, 'endloyaltyattack', { session });
  assert.match(e.text, /ended #\d+ capture 111,222 from Home — \d+ waves sent/);
});

// ---------------------------------------------------------------------------
section('background: bounds (one per kind, target and city; 10 a console; waves, hours, unreadable reports)');

t('the same line again while its task runs starts nothing and says how to end it (a loop in a script)', async () => {
  const w = world();
  const session = sessionFor(w);
  const r = await runIn(w, 'capture 111,222 3000' + probe + '\nloop 25', { session });
  assert.strictEqual([...L.TASKS.values()].filter((t2) => t2.running).length, 1, 'one capture, not 25');
  assert.strictEqual((r.text.match(/started as #/g) || []).length, 1);
  assert.strictEqual((r.text.match(/is already running \(.*\) — nothing new started; endloyaltyattack ends it/g) || []).length, 24);
  assert.strictEqual(errorOf(r), 'null', 'the task the line asks for is running: no $error');
  // another target, another kind or another city is another task
  await runIn(w, 'capture 111,223 3000\nloyaltyattack 111,222 3000\ncapture 111,222 3000', { session, castle: 'Fla' });
  const kinds = [...L.TASKS.values()].filter((t2) => t2.running).map((t2) => `${t2.kind} ${t2.where} ${t2.cityName}`).sort();
  assert.deepStrictEqual(kinds, ['capture 111,222 Fla', 'capture 111,222 Home', 'capture 111,223 Fla'], 'loyaltyattack had no scout report, so it did not start');
});
t('a console runs 10 background attacks at most; the 11th is refused', async () => {
  const w = world();
  const session = sessionFor(w);
  const lines = Array.from({ length: 11 }, (_, i) => `capture 111,${230 + i} 3000`).join('\n');
  const r = await runIn(w, lines + probe, { session });
  assert.strictEqual([...L.TASKS.values()].filter((t2) => t2.running).length, 10);
  assert.match(errorOf(r), /10 background attacks are running on this console already — the most there can be; end one/);
  // another console's tasks do not count against this one
  const other = sessionFor(w);
  const r2 = await runIn(w, 'capture 300,300 3000' + probe, { session: other });
  assert.match(r2.text, /started as #/);
});
t('/waves= and /hours= on loyaltyattack and capture; 100 waves and 12 h by default', async () => {
  assert.deepStrictEqual([P('capture 111,222 3000 /waves=5').maxWaves, P('capture 111,222 /hours=1.5').maxHours], [5, 1.5]);
  assert.strictEqual(P('loyaltyattack 111,222 s:100,c:5k /waves=250 /hours=24').maxWaves, 250);
  assert.strictEqual(P('capture 111,222 3000').maxWaves, undefined);
  assert.match(parseErr('capture 111,222 /waves=0'), /\/waves= takes a whole number of waves from 1 to 10000/);
  assert.match(parseErr('capture 111,222 /hours=500'), /\/hours= takes hours from above 0 to 168/);
  assert.match(parseErr('capture 111,222 /forever'), /the switches are \/waves=N \(100 by default\) and \/hours=N \(12 by default\)/);
  assert.deepStrictEqual([L.LIMITS.waves, L.LIMITS.hours, L.LIMITS.tasks], [100, 12, 10]);
  const w = world();
  const session = sessionFor(w);
  const r = await runIn(w, 'capture 111,222 3000 /waves=3', { session });
  assert.match(r.text, /\(3 waves or 12 h at most, and 3 reports in a row that cannot be read stop it\)/);
  await until(() => /3 waves sent — the most this line sends \(write \/waves=N on it for more\) — done/.test(session.text()), 4000);
  assert.strictEqual(w.sends().length, 3);
  // the time cap
  const v = world();
  const s2 = sessionFor(v);
  await runIn(v, 'capture 111,222 3000 /hours=0.00001', { session: s2 });
  await until(() => /the longest this line runs \(write \/hours=N on it for longer\) — done/.test(s2.text()), 4000);
});
t('three reports in a row about the target that cannot be read stop a capture (the waves would go on blind)', async () => {
  const w = world();
  const session = sessionFor(w);
  await runIn(w, 'capture 111,222 3000', { session });
  await until(() => w.sends().length >= 1);
  w.g.addReport(111, 222, '<garbled');
  w.g.addReport(111, 222, '<reportData><somethingElse/></reportData>');
  await sleep(40);
  assert.ok(!/could not be read/.test(session.text()), 'two is not yet three');
  w.g.addReport(111, 222, battleXml({ support: -1 }));        // a report that reads starts the count over
  w.g.addReport(111, 222, '');
  w.g.addReport(111, 222, 'nope');
  await sleep(40);
  assert.ok(!/could not be read/.test(session.text()));
  w.g.addReport(111, 222, '<x/>');
  await until(() => /3 reports in a row about 111,222 could not be read, so what the waves did is not known — stopped/.test(session.text()));
  assert.strictEqual(L.TASKS.size, 0);
});
t('guardedattack whose city is gone recalls its attack and ends cleanly; a guard that fails recalls it too', async () => {
  const w = world();
  const session = sessionFor(w);
  const { task } = await guarded(w, session);
  w.g.castles = w.g.castles.filter((c) => c.name !== 'Home');
  jump(w, task.scoutAt);
  await until(() => /Home is not one of your cities any more, so no scouts could go — the attack was recalled where it could be — done/.test(session.text()));
  assert.strictEqual(w.sends().length, 1, 'no scouts');
  assert.match(session.text(), /cannot tell which city it left from — NOT recalled|recall army/);
  assert.ok(!/stopped on an error/.test(session.text()));
  // a guard body that throws: the attack is recalled before it ends
  const v = world();
  const s2 = sessionFor(v);
  const g2 = await guarded(v, s2);
  v.g.buildArmyBean = () => { throw new Error('boom'); };
  jump(v, g2.task.scoutAt);
  await until(() => /stopped on an error: boom/.test(s2.text()));
  assert.strictEqual(v.recalls().length, 1, 'its attack came back');
  assert.match(s2.text(), /its guard stopped on an error/);
});

// ---------------------------------------------------------------------------
section('background: guardedattack and setguard');

const jump = (w, toServerMs) => { w.g.serverOffset += toServerMs - w.g.now(); };
async function guarded(w, session, line = 'guardedattack 111,222 cav:99000,s:1000 10 a:500000 ab:1') {
  const r = await runIn(w, line + probe, { session });
  const task = [...L.TASKS.values()].pop();
  return { r, task };
}
t('guardedattack: the attack goes now, the scouts to land 15-30 s before it; under the limits it goes on', async () => {
  const w = world();
  const session = sessionFor(w);
  const { r, task } = await guarded(w, session);
  assert.match(r.text, /attack -> \(111,222\) from Home · hero Biggy · 99,000 Cavalry, 1,000 Scout/);
  assert.match(r.text, /-> ok/);
  assert.match(r.text, /it lands \d\d:\d\d:\d\d\.\d{3}; the scouts go at .* to land \d+s ahead of it/);
  assert.strictEqual(w.sends().length, 1);
  const lead = task.landing - task.scoutAt - task.scoutMs;
  assert.ok(lead >= 15000 && lead <= 30000, 'lead ' + lead);
  jump(w, task.scoutAt);
  await until(() => w.sends().length === 2);
  const sb = w.sends()[1].bean;
  assert.deepStrictEqual([sb.missionType, sb.troops.scouter, 'heroId' in sb], [C.MISSION.scout, 10, false]);
  w.g.addReport(111, 222, scoutXml({ troops: [[7, 100000]], forts: [[15, 0]] }));
  await until(() => /under every limit, so the attack goes on — done/.test(session.text()));
  assert.strictEqual(w.recalls().length, 0);
  assert.match(session.text(), /the scouts saw 100,000 Archer, 0 Abatis/);
});
t('guardedattack: one abatis there calls the attack off', async () => {
  const w = world();
  const session = sessionFor(w);
  const { task } = await guarded(w, session);
  jump(w, task.scoutAt);
  await until(() => w.sends().length === 2);
  w.g.addReport(111, 222, scoutXml({ troops: [[7, 10]], forts: [[15, 1]] }));
  await until(() => /called off — 1 Abatis \(limit 1\) — done/.test(session.text()));
  assert.deepStrictEqual(w.recalls().map((x) => [x.castleId, x.armyId]), [[1, [...task.armyIds][0]]]);
});
t('guardedattack: scouts wiped out, or a count shown only as a range over the limit, recall it', async () => {
  for (const [xml, why] of [[scoutXml({ success: false, info: false }), /the scouts were wiped out/],
    [scoutXml({ troops: [[7, '400000-600000']], forts: [] }), /600,000 Archer \(limit 500,000\)/],
    [scoutXml({ troops: [[7, 5]] }), /the report shows no fortifications, so they cannot be checked/]]) {
    const w = world();
    const session = sessionFor(w);
    const { task } = await guarded(w, session);
    jump(w, task.scoutAt);
    await until(() => w.sends().length === 2);
    w.g.addReport(111, 222, xml);
    await until(() => /called off/.test(session.text()));
    assert.match(session.text(), why);
    assert.strictEqual(w.recalls().length, 1);
  }
});
t('guardedattack: no report before it lands recalls it', async () => {
  const w = world();
  const session = sessionFor(w);
  const { task } = await guarded(w, session);
  jump(w, task.scoutAt);
  await until(() => w.sends().length === 2);
  jump(w, task.landing - 10);
  await until(() => /no scout report came back in time, so the attack was recalled — done/.test(session.text()));
  assert.strictEqual(w.recalls().length, 1);
});
t('guardedattack: refused, it starts nothing; ended early, no scouts and no recall', async () => {
  const w = world({ armyReplies: [{ ok: -3, errorMsg: 'no troops' }] });
  const r = await runIn(w, 'guardedattack 111,222 cav:99000,s:1000 10 a:500000 ab:1' + probe, { session: sessionFor(w) });
  assert.match(errorOf(r), /FAILED \(ok=-3\) - no troops/);
  assert.strictEqual(L.TASKS.size, 0);
  const v = world();
  const session = sessionFor(v);
  await guarded(v, session);
  const e = await runIn(v, 'endguardedattack', { session });
  assert.match(e.text, /ended #\d+ guardedattack 111,222 from Home/);
  assert.match(session.text(), /ended before the scouts went — the attack is left on its way/);
  assert.deepStrictEqual([v.sends().length, v.recalls().length], [1, 0]);
});
t('setguard: the NPC10 recipe — an attack, a scout, then the guard; a player there recalls the attack', async () => {
  const w = world();
  const session = sessionFor(w);
  const r = await runIn(w, 'attack 111,222 Ken c:99k,s:1k\nscout 111,222 none s:1\n'
    + 'setguard 111,222 wo:1,w:400001,s:1,p:1,sw:1,a:1,c:1,cata:1,t:1,b:1,r:1,cp:1 at:5000,tre:2000', { session });
  assert.match(r.text, /watching 1 attack\(s\) on their way to 111,222/);
  const attackId = w.g.player.selfArmys.find((a) => a.missionType === 5).armyId;
  w.g.addReport(111, 222, scoutXml({ troops: [[3, 400000], [7, 2]], forts: [[16, 1000], [18, 0]] }));
  await until(() => /called off — 2 Archer \(limit 1\)/.test(session.text()));
  assert.deepStrictEqual(w.recalls().map((x) => x.armyId), [attackId], 'only the attack, not the scout');
});
t('setguard: an NPC as it should be lets the attack go on', async () => {
  const w = world();
  const session = sessionFor(w);
  await runIn(w, 'attack 111,222 Ken c:99k,s:1k\nsetguard 111,222 a:60000,cav:50000 ab:100', { session });
  w.g.addReport(111, 222, scoutXml({ troops: [[7, 50000], [9, 0]], forts: [[15, 99]] }));
  await until(() => /the attack goes on — done/.test(session.text()));
  assert.strictEqual(w.recalls().length, 0);
});

// ---------------------------------------------------------------------------
section('report reading');

t('decode: a battle report gives the loyalty change; a scout report the level, troops and forts', () => {
  assert.deepStrictEqual(L.decode(battleXml({ win: false, support: -3 })), { kind: 'battle', mine: true, attackerWon: false, seized: false, loyaltyChange: -3 });
  const s = L.decode(scoutXml({ loyalty: 7, troops: [[7, '1000-2000'], [9, '?']], forts: [[15, 3]] }));
  assert.deepStrictEqual([s.kind, s.loyalty, s.troops.get(7), s.troops.get(9), s.forts.get(15)], ['scout', 7, 2000, null, 3]);
  assert.strictEqual(L.decode('not xml at all'), null);
});
t('reading reports goes one at a time with the console\'s own (Session.mrQueue)', async () => {
  const w = world();
  let queued = 0;
  const session = sessionFor(w, { mrQueue: (fn) => { queued++; return fn(); } });
  w.g.addReport(111, 222, scoutXml({ loyalty: 50 }));
  await runIn(w, 'loyaltyattack 111,222', { session });
  assert.ok(queued >= 2, 'list and read both queued: ' + queued);
  await L.stopAll();
});

// ---------------------------------------------------------------------------
(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n + '\n'); continue; }
    try { await f(); console.log('  ok    ' + n); pass++; }
    catch (e) { console.log('  FAIL  ' + n + '\n        ' + String(e.message).split('\n').join('\n        ')); fail++; }
    await L.stopAll();
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
