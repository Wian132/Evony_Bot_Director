'use strict';
// Timed marches, build-city marches and logout, offline. The Game is real; its
// network calls are stubbed by a small simulated server that stamps each new
// army's reachTime the way the real one does — from when the send arrived,
// its own idea of the march time, and the camp — and pushes it into selfArmys
// a moment after replying. Sends wait for real (under ~1.1 s each), so the
// millisecond timing is exercised, not mocked.
const path = require('path'), os = require('os'), fs = require('fs');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-timed-')), 't.db');   // before session.js loads
const assert = require('assert');
const C = require('./constants');
const { Game } = require('./game');
const TM = require('./timed-march');
const CB = require('./city-build');
const script = require('./script');
const LO = require('./logout');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const F = (x, y) => C.coordsToFieldId(x, y);
const parseErr = (line) => { try { script.parseLine(line); } catch (e) { return e.message; } return null; };

// Two cities; Home holds three flats and a lake.
const PARAMS = { marchSkill: 55, driveSkill: 30, relief: 3 };
function sim({ latency = 20, factor = 1, reliefApplies = true, reachWithCamp = true, wholeSeconds = false,
  recallOk = true, push = true, reply = { ok: 1 }, title = 9, stampSeconds = false, skewMs = 0 } = {}) {
  const g = new Game();
  g.serverOffset = 0;
  g.minRtt = latency * 2;
  const hero = (id, name) => ({ id, name, status: 0, level: 10 });
  g.player = { playerInfo: { userName: 'Me', titleId: title, alliance: 'Ally' }, selfArmys: [], buffs: [] };
  g.castles = [
    { id: 1, name: 'Home', fieldId: F(100, 100), heros: [hero(11, 'Ann'), hero(12, 'Bob'), hero(13, 'Cid')], buffs: [],
      fields: [{ id: F(103, 104), type: 10, level: 5 }, { id: F(96, 99), type: 10, level: 7 }, { id: F(110, 90), type: 10, level: 3 }, { id: F(101, 97), type: 6, level: 9 }] },
    { id: 2, name: 'Fla', fieldId: F(120, 100), heros: [hero(21, 'Dee')], buffs: [], fields: [] },
  ];
  const log = [];
  g.troopParams = async () => PARAMS;
  g.fieldOwner = async () => ({ userName: null, allianceName: null });
  let nextId = 100;
  g.newArmy = async (castleId, bean) => {
    log.push({ cmd: 'newArmy', castleId, bean });
    if (reply.ok !== 1) return reply;
    const castle = g.castles.find((c) => c.id === castleId);
    const start = g.now() + latency;
    const keys = Object.keys(bean.troops).filter((k) => bean.troops[k] > 0);
    const march = C.marchTimeMs(C.fieldIdToCoords(castle.fieldId), C.fieldIdToCoords(bean.targetPoint), keys,
      { ...PARAMS, relief: reliefApplies ? PARAMS.relief : 0 }) * factor;
    let land = start + march + bean.restTime * 1000 + skewMs;
    if (wholeSeconds) land = Math.floor(land / 1000) * 1000;
    let reachTime = reachWithCamp ? land : land - bean.restTime * 1000;
    if (stampSeconds) reachTime = Math.floor(reachTime / 1000);
    const army = { armyId: nextId++, direction: 1, missionType: bean.missionType, targetFieldId: bean.targetPoint,
      startFieldId: castle.fieldId, startTime: start, restTime: bean.restTime, hero: 'x', reachTime };
    if (push) setTimeout(() => { g.player.selfArmys = [...g.player.selfArmys, army]; }, 30);
    return { ok: 1 };
  };
  g.recallArmy = async (castleId, armyId) => {
    log.push({ cmd: 'recall', castleId, armyId });
    if (!recallOk) return { ok: -9, errorMsg: 'cannot recall' };
    const a = g.player.selfArmys.find((x) => x.armyId === armyId);
    if (a) a.direction = 2;
    setTimeout(() => { g.player.selfArmys = g.player.selfArmys.filter((x) => x.armyId !== armyId); }, 100);
    return { ok: 1 };
  };
  return { g, log };
}

// Send one timed build march from Home to a flat.
async function land(s, { to = F(103, 104), aimMs, troops = { peasants: 500 }, castle = s.g.castles[0], construct = true } = {}) {
  const out = [];
  const target = C.fieldIdToCoords(to);
  const res = await TM.send({
    game: s.g, castle, construct, from: C.fieldIdToCoords(castle.fieldId), target, targetPoint: to,
    troopKeys: Object.keys(troops), aimMs, log: (m) => out.push(m), checkMs: 1500,
    makeBean: (rest) => s.g.buildArmyBean({ missionType: C.MISSION.construct, heroId: 11, targetPoint: to, troops, restTimeSec: rest }),
  });
  return { res, out, text: out.join('\n') };
}
const aimIn = (ms) => Math.floor((Date.now() + ms) / 1000) * 1000 + 500;   // mid-second
const fresh = () => TM.MOMENTS.clear();

// ---------------------------------------------------------------------------
section('march time, the client\'s way');

t('the slowest speed is held in an int', () => {
  // workers 180 x 1.55 = 279 exactly; archers 250 x 1.55 = 387.5 -> 387 when alone
  const a = C.marchTimeMs({ x: 0, y: 0 }, { x: 3, y: 4 }, ['archer'], { marchSkill: 55 });
  assert.strictEqual(a, 5 * 60000 / 387 * 1000);
});
t('mounted troops use the drive skill, foot troops the march skill', () => {
  const cav = C.marchTimeMs({ x: 0, y: 0 }, { x: 10, y: 0 }, ['lightCavalry'], { marchSkill: 55, driveSkill: 30 });
  assert.strictEqual(cav, 10 * 60000 / 1300 * 1000);
  const old = C.marchTimeMs({ x: 0, y: 0 }, { x: 10, y: 0 }, ['lightCavalry'], 55);
  assert.strictEqual(old, 10 * 60000 / 1550 * 1000, 'a bare number still means one skill for everything');
});
t('the Relief Station multiplies the int speed, and that product is an int too', () => {
  const w = C.marchTimeMs({ x: 0, y: 0 }, { x: 0, y: 8 }, ['peasants'], { marchSkill: 33, relief: 3 });
  // 180 x 1.33 = 239.4 -> 239, x3 = 717
  assert.strictEqual(w, 8 * 60000 / 717 * 1000);
});
t('the map wraps: 5,5 to 795,5 is 10 tiles, not 790', () => {
  assert.strictEqual(C.mapDistance({ x: 5, y: 5 }, { x: 795, y: 5 }), 10);
  assert.strictEqual(C.mapDistance({ x: 2, y: 798 }, { x: 798, y: 2 }), Math.hypot(4, 4));
});
t('march-time buffs, by how long they have left', () => {
  const now = 1e12, base = C.marchTimeMs({ x: 0, y: 0 }, { x: 10, y: 0 }, ['archer'], { marchSkill: 0, now });
  const slow = (h) => C.marchTimeMs({ x: 0, y: 0 }, { x: 10, y: 0 }, ['archer'], { marchSkill: 0, now, castleBuffs: [{ typeId: 'IncArmyActionTimeBuff', endTime: now + h * 3600000 }] });
  assert.strictEqual(slow(1), base * 1.2);
  assert.strictEqual(slow(5), base * 1.4);
  assert.strictEqual(slow(9), base * 1.6);
  const wages = C.marchTimeMs({ x: 0, y: 0 }, { x: 10, y: 0 }, ['archer'], { marchSkill: 0, now, playerBuffs: [{ typeId: 'HarvesterWagesBuff', endTime: now + 1 }] });
  assert.strictEqual(wages, base * 0.9);
});

// ---------------------------------------------------------------------------
section('landing plan');

t('camp is whole seconds and the send makes up the fraction', () => {
  const s = sim();
  const aim = Date.now() + 3600000 + 123;
  const pl = TM.plan({ game: s.g, castle: s.g.castles[0], from: { x: 100, y: 100 }, target: { x: 103, y: 104 },
    troopKeys: ['peasants'], aimMs: aim, params: PARAMS, cls: 'mine', key: '1:mine' });
  assert.ok(Number.isInteger(pl.restTimeSec));
  assert.strictEqual(Math.round(pl.sendAt + pl.leadMs + pl.march + pl.restTimeSec * 1000), aim);
  const lead = pl.sendAt - Date.now();
  assert.ok(lead >= 40 && lead <= 1100, 'sends within a second: ' + lead);
});
t('too late says how long the march takes', () => {
  const s = sim();
  assert.throws(() => TM.plan({ game: s.g, castle: s.g.castles[0], from: { x: 100, y: 100 }, target: { x: 300, y: 300 },
    troopKeys: ['peasants'], aimMs: Date.now() + 5000, params: PARAMS, cls: 'mine', key: 'k' }), /too late: the march takes/);
});

section('whose tile (NewArmyWin.otherFieldInfo)');

t('own city, own flat, a build march: mine without asking', async () => {
  const s = sim();
  let asked = 0; s.g.fieldOwner = async () => { asked++; return null; };
  assert.strictEqual(await TM.targetClass(s.g, { targetPoint: F(96, 99) }), 'mine');
  assert.strictEqual(await TM.targetClass(s.g, { targetPoint: F(120, 100) }), 'mine');
  assert.strictEqual(await TM.targetClass(s.g, { targetPoint: 5, construct: true }), 'mine');
  assert.strictEqual(asked, 0);
});
t('alliance, other, and the client\'s null == null', async () => {
  const s = sim();
  s.g.fieldOwner = async () => ({ userName: 'Pal', allianceName: 'Ally' });
  assert.strictEqual(await TM.targetClass(s.g, { targetPoint: 5 }), 'alliance');
  s.g.fieldOwner = async () => ({ userName: 'Foe', allianceName: 'Other' });
  assert.strictEqual(await TM.targetClass(s.g, { targetPoint: 5 }), 'other');
  s.g.fieldOwner = async () => ({ userName: null, allianceName: null });
  assert.strictEqual(await TM.targetClass(s.g, { targetPoint: 5 }), 'other', 'we have an alliance, the empty tile does not');
  s.g.player.playerInfo.alliance = undefined;
  assert.strictEqual(await TM.targetClass(s.g, { targetPoint: 5 }), 'unowned', 'no alliance on either side reads as a match');
});

section('judging a landing');

t('the first march is held against the aim, later ones against it', () => {
  const aim = 1e12 + 500;
  assert.ok(TM.judge(aim + 250, aim, []).ok);
  assert.ok(!TM.judge(aim + 350, aim, []).ok, 'past the first-march tolerance');
  assert.ok(!TM.judge(aim - 501, aim, []).ok, 'the second before');
  const peers = [{ armyId: 1, landing: aim + 250 }];
  assert.ok(TM.judge(aim + 60, aim, peers).ok, '190 ms from the first, same second');
  assert.ok(!TM.judge(aim - 200, aim, peers).ok, '450 ms from the first');
});
t('whole-second stamps: the second is all there is to go by', () => {
  const aim = 1e12 + 500, stamp = 1e12;
  assert.ok(TM.judge(stamp, aim, []).ok);
  assert.ok(TM.judge(stamp, aim, [{ armyId: 1, landing: stamp }]).ok);
  assert.ok(!TM.judge(stamp + 1000, aim, [{ armyId: 1, landing: stamp }]).ok);
});
t('reachTime is read as including the camp, unless only another reading fits', () => {
  const aim = 1e12, fits = (e) => Math.abs(e) < 600000;
  const s = sim();
  assert.strictEqual(TM.landingOf(s.g, { reachTime: aim + 5, restTime: 3000 }, aim, fits), aim + 5);
  assert.strictEqual(s.g._landModel.reach, 'withCamp');
  const s2 = sim();
  assert.strictEqual(TM.landingOf(s2.g, { reachTime: aim - 3000000 + 5, restTime: 3000 }, aim, fits), aim + 5);
  assert.strictEqual(s2.g._landModel.reach, 'campSeconds');
  // 17 minutes early with a 34-minute camp: the other reading would say 17 late
  const s3 = sim();
  assert.strictEqual(TM.landingOf(s3.g, { reachTime: aim - 1020000, restTime: 2040 }, aim, (e) => Math.abs(e) < 1100000), aim - 1020000);
  assert.strictEqual(s3.g._landModel.reach, null, 'nothing learned from a miss');
});

// ---------------------------------------------------------------------------
section('sending, checking, putting right');

t('a march lands on the aimed millisecond, give or take the network', async () => {
  fresh();
  const s = sim();
  const aim = aimIn(3600000);
  const r = await land(s, { aimMs: aim });
  assert.ok(r.res.sent, r.text);
  assert.ok(Math.abs(r.res.landing - aim) <= 40, 'off by ' + (r.res.landing - aim) + '\n' + r.text);
  assert.match(r.text, /your own tile: the city's Relief Station x3 applies/);
  assert.match(r.text, /server: lands .* — 1 march due then/);
  assert.strictEqual(s.log.filter((x) => x.cmd === 'recall').length, 0);
});
t('two cities\' marches to one moment line up, and the log counts them', async () => {
  fresh();
  const s = sim();
  const aim = aimIn(3600000);
  await land(s, { aimMs: aim });
  const r = await land(s, { aimMs: aim, to: F(125, 103), castle: s.g.castles[1] });
  assert.ok(r.res.sent, r.text);
  assert.match(r.text, /2 marches due then, \d+ ms apart/);
});
t('a server that does not give the relief: recalled, learned, sent again, then right first time', async () => {
  fresh();
  const s = sim({ reliefApplies: false });
  const aim = aimIn(3600000);
  const r = await land(s, { aimMs: aim });
  assert.ok(r.res.sent, r.text);
  assert.strictEqual(s.log.filter((x) => x.cmd === 'recall').length, 1, r.text);
  assert.match(r.text, /MISSED: not on the aimed moment/);
  assert.match(r.text, /learned: the server does not give these marches the Relief Station x3 — no city's march/);
  assert.match(r.text, /sending it again \(try 2 of 3\)/);
  const r2 = await land(s, { aimMs: aim, to: F(96, 99) });
  assert.ok(r2.res.sent, r2.text);
  assert.match(r2.text, /Relief Station x3 does not apply \(learned from an earlier landing\)/);
  // another city: the rule is the server's, so it is right first time there too
  const r3 = await land(s, { aimMs: aim, to: F(125, 103), castle: s.g.castles[1] });
  assert.ok(r3.res.sent, r3.text);
  assert.strictEqual(s.log.filter((x) => x.cmd === 'recall').length, 1, 'only the very first march needed a recall');
});
t('a server that gives relief the client would not: learned the same way', async () => {
  fresh();
  const s = sim();
  s.g.fieldOwner = async () => ({ userName: 'Foe', allianceName: 'Other' });   // someone else's tile: no relief planned
  const aim = aimIn(3600000);
  const r = await land(s, { aimMs: aim, to: F(104, 106), construct: false });
  assert.ok(r.res.sent, r.text);
  assert.match(r.text, /learned: the server gives these marches the Relief Station x3, which the client would not/);
});
t('a steady network delay is learned into the lead', async () => {
  fresh();
  const s = sim({ latency: 140 });
  s.g.minRtt = 40;                   // we think 20 ms each way; it is 140
  const aim = aimIn(3600000);
  const r = await land(s, { aimMs: aim });
  assert.ok(r.res.sent, r.text);     // 120 ms late is inside the first-march tolerance
  assert.ok(s.g._landModel.leadMs > 60, 'lead now ' + s.g._landModel.leadMs);
});
t('camp read without the camp in reachTime still lands right', async () => {
  fresh();
  const s = sim({ reachWithCamp: false });
  const aim = aimIn(3600000);
  const r = await land(s, { aimMs: aim });
  assert.ok(r.res.sent && Math.abs(r.res.landing - aim) <= 40, r.text);
  assert.strictEqual(s.g._landModel.reach, 'campSeconds');
});
t('whole-second stamps are accepted on the second', async () => {
  fresh();
  const s = sim({ wholeSeconds: true });
  const aim = aimIn(3600000);
  const a = await land(s, { aimMs: aim });
  const b = await land(s, { aimMs: aim, to: F(96, 99) });
  assert.ok(a.res.sent && b.res.sent, a.text + '\n' + b.text);
  assert.strictEqual(a.res.landing % 1000, 0);
  assert.strictEqual(a.res.landing, b.res.landing);
});
t('a reachTime in epoch seconds is read as ms', async () => {
  fresh();
  const s = sim({ stampSeconds: true });
  const aim = aimIn(3600000);
  const r = await land(s, { aimMs: aim });
  assert.ok(r.res.sent, r.text);
  assert.strictEqual(Math.floor(r.res.landing / 1000), Math.floor(aim / 1000));
});
t('a stamp no speed rule could explain is reported and never recalled', async () => {
  fresh();
  const s = sim({ skewMs: 3 * 3600000 });
  const r = await land(s, { aimMs: aimIn(3600000) });
  assert.ok(r.res.sent && r.res.odd, r.text);
  assert.match(r.text, /does not fit this march at all — left alone, not recalled/);
  assert.strictEqual(s.log.filter((x) => x.cmd === 'recall').length, 0);
});
t('a recall the server refuses is reported loudly, not retried', async () => {
  fresh();
  const s = sim({ factor: 1.01, recallOk: false });
  const r = await land(s, { aimMs: aimIn(3600000) });
  assert.ok(r.res.sent && r.res.missed, r.text);
  assert.match(r.text, /RECALL REFUSED .* Recall it in the game before then/);
  assert.strictEqual(s.log.filter((x) => x.cmd === 'newArmy').length, 1);
});
t('a server that is out by more each time: recalled and given up after three tries', async () => {
  fresh();
  const s = sim();
  let n = 0;
  const realNew = s.g.newArmy;
  // +5 s, then +10, then +15: whatever is learned from one try, the next is out by 5 s more
  s.g.newArmy = async (cid, bean) => { n++; return realNew(cid, { ...bean, restTime: bean.restTime + 5 * n }); };
  const r = await land(s, { aimMs: aimIn(3600000) });
  assert.ok(!r.res.sent, r.text);
  assert.strictEqual(n, 3);
  assert.match(r.text, /gave up after 3 tries/);
});
t('the server refusing the send ends it there', async () => {
  fresh();
  const s = sim({ reply: { ok: -1, errorMsg: 'no free rally slot' } });
  const r = await land(s, { aimMs: aimIn(3600000) });
  assert.ok(!r.res.sent);
  assert.match(r.text, /FAILED \(ok=-1\) - no free rally slot/);
});
t('no army pushed: sent, but said to be unchecked', async () => {
  fresh();
  const s = sim({ push: false });
  const r = await land(s, { aimMs: aimIn(3600000) });
  assert.ok(r.res.sent && r.res.landing === null, r.text);
  assert.match(r.text, /cannot be checked/);
});
t('an aim on a second boundary gets a warning', async () => {
  fresh();
  const s = sim();
  const r = await land(s, { aimMs: Math.floor((Date.now() + 3600000) / 1000) * 1000 + 40 });
  assert.match(r.text, /right on a second boundary/);
});

section('marchcheck');

t('matches the server to the ms, and tells relief from none', async () => {
  const s = sim();
  const start = 1.7e12, home = s.g.castles[0];
  const plain = C.marchTimeMs({ x: 100, y: 100 }, { x: 130, y: 100 }, ['archer'], { marchSkill: 55, driveSkill: 30, now: start });
  const relieved = C.marchTimeMs({ x: 100, y: 100 }, { x: 103, y: 104 }, ['peasants'], { ...PARAMS, now: start });
  s.g.player.selfArmys = [
    { armyId: 1, direction: 1, missionType: 5, startFieldId: home.fieldId, targetFieldId: F(130, 100), troop: { archer: 500 }, startTime: start, reachTime: start + plain, restTime: 0 },
    { armyId: 2, direction: 1, missionType: 4, startFieldId: home.fieldId, targetFieldId: F(103, 104), troop: { peasants: '500' }, startTime: start, reachTime: start + relieved + 60000, restTime: 60 },
    { armyId: 3, direction: 2, missionType: 5, startFieldId: home.fieldId, targetFieldId: F(1, 1), troop: { archer: 1 }, startTime: 1, reachTime: 2 },
  ];
  const out = [];
  assert.strictEqual(await TM.check(s.g, (m) => out.push(m)), 2);
  const text = out.join('\n');
  assert.match(text, /-> 130,100 {2}attack .* without relief x3 {2}\+0 ms/);
  assert.match(text, /-> 103,104 {2}construct .* with relief x3 {2}\+0 ms/);
  assert.match(text, /2 of 2 to the millisecond, 0 within a second, 0 further out — the formula is the server's/);
});
t('with nothing out it says what to do', async () => {
  const s = sim();
  const out = [];
  await TM.check(s.g, (m) => out.push(m));
  assert.match(out.join('\n'), /no marches out to compare against — send one/);
});

// ---------------------------------------------------------------------------
section('build-city checks (city-build.js)');

t('only a flat you hold', () => {
  const s = sim();
  assert.throws(() => CB.preflight(s.g, F(300, 300)), /300,300 is not a flat you hold/);
  assert.throws(() => CB.preflight(s.g, F(101, 97)), /your Lake L9, not a flat/);
  assert.match(CB.preflight(s.g, F(103, 104))[0], /flat L5, held by Home · 8 open city slots \(title allows 10, you have 2\)/);
});
t('not while a build march is already heading there', () => {
  const s = sim();
  s.g.player.selfArmys = [{ armyId: 1, direction: 1, missionType: 4, targetFieldId: F(103, 104) }];
  assert.throws(() => CB.preflight(s.g, F(103, 104)), /already on its way to 103,104/);
});
t('one open city slot is needed when it is sent', () => {
  const s = sim({ title: 1 });
  assert.throws(() => CB.preflight(s.g, F(103, 104)), /no open city slot — your title allows 2 cities and you have 2/);
});
t('buildstatus groups the marches by the second they land in', () => {
  const s = sim();
  const base = 1e12;
  s.g._landModel = { leadMs: 0, scale: new Map(), reach: 'withCamp' };
  s.g.player.selfArmys = [
    { armyId: 1, direction: 1, missionType: 4, targetFieldId: F(103, 104), startFieldId: F(100, 100), reachTime: base + 510, restTime: 3000, hero: 'Ann' },
    { armyId: 2, direction: 1, missionType: 4, targetFieldId: F(96, 99), startFieldId: F(100, 100), reachTime: base + 530, restTime: 3000, hero: 'Bob' },
    { armyId: 3, direction: 1, missionType: 4, targetFieldId: F(110, 90), startFieldId: F(120, 100), reachTime: base + 2100, restTime: 3000, hero: 'Dee' },
    { armyId: 4, direction: 1, missionType: 5, targetFieldId: F(1, 1), reachTime: base },
  ];
  const text = CB.status(s.g).join('\n');
  assert.match(text, /cities: 2 of the 10 your title allows \(8 open\)/);
  assert.match(text, /3 build marches on the way, landing in 2 different seconds — only marches that land together/);
  assert.match(text, /— 2 marches, 20 ms apart/);
  assert.match(text, /Fla +-> 110,90 +hero Dee/);
});

// ---------------------------------------------------------------------------
section('script: the recipe\'s lines');

t('set and %name%', () => {
  const acts = script.parse('set timeh 14\nset timem 30 // half past\necho %timeh%:%timem%');
  assert.strictEqual(acts.length, 1);
  assert.strictEqual(acts[0].text, '14:30');
  assert.strictEqual(acts[0].raw, 'echo 14:30');
  assert.match(script.parse('echo %nope%')[0].error, /%nope% is not set — put {2}set nope <value> {2}above this line/);
  assert.match(script.parse('set')[0].error, /set: usage/);
});
t('deploy bu reads like the recipe', () => {
  const acts = script.parse('set timeh 14\nset timem 30\n'
    + 'deploy bu 103,104 any wo:500 f:26k,l:26k,s:26k,i:12k,g:10k @:%timeh%:%timem%:07.04');
  const a = acts[0];
  assert.strictEqual(a.cmd, 'construct', JSON.stringify(a));
  assert.deepStrictEqual(a.target, { x: 103, y: 104 });
  assert.strictEqual(a.hero, 'any');
  assert.deepStrictEqual(a.troops, { peasants: 500 });
  assert.deepStrictEqual(a.resources, { food: 26000, wood: 26000, stone: 26000, iron: 12000, gold: 10000 });
  assert.deepStrictEqual(a.land, { h: 14, m: 30, s: 7, ms: 40 });
});
t('deploy\'s other march types, and a bad one', () => {
  assert.strictEqual(script.parseLine('deploy at 1,2 any a:10').cmd, 'attack');
  assert.strictEqual(script.parseLine('deploy re 1,2 none w:25000 f:100000 1:30:00').cmd, 'reinforce');
  assert.strictEqual(script.parseLine('deploy sc 1,2 any s:1').cmd, 'scout');
  assert.strictEqual(script.parseLine('deploy tr Fla t:10 f:1m').cmd, 'transport');
  assert.match(parseErr('deploy zz 1,2 any a:1'), /deploy: say the march type first — at \(attack\), bu \(build city\)/);
  assert.match(parseErr('deploy bu Fla any wo:500'), /a build march goes to a flat's coordinates/);
  assert.match(parseErr('deploy bu 1,2 any'), /no troop string/);
});
t('NEAT\'s wiki example: warriors first, then wood, then 1h30m of camp', () => {
  const a = script.parseLine('deploy reinforce 111,222 none w:25000 f:100000 1:30:00');
  assert.deepStrictEqual([a.troops, a.resources, a.camp, a.land], [{ militia: 25000 }, { food: 100000 }, 5400, null]);
});
t('troops first, resources second: s and w are stone and wood in the second list', () => {
  const a = script.parseLine('attack 111,222 any a:1000 s:100 @:18:20:20');
  assert.deepStrictEqual([a.troops, a.resources], [{ archer: 1000 }, { stone: 100 }]);
  const b = script.parseLine('reinforce Fla s:1k');
  assert.deepStrictEqual([b.troops, b.resources], [{ scouter: 1000 }, null], 'a first list of troop codes is troops');
  const c = script.parseLine('reinforce Fla wood:5k');
  assert.deepStrictEqual([c.troops, c.resources], [{ scouter: 1 }, { wood: 5000 }]);
  assert.match(parseErr('attack 1,2 any a:1 zz:5'), /"zz:5" is neither a troop string nor a resource string/);
});
t('@: is a clock time, @ and a bare time are camp, like NEAT', () => {
  assert.deepStrictEqual(script.parseLine('attack 1,2 any a:1 @:3:37').land, { h: 3, m: 37, s: 0, ms: 0 });
  assert.strictEqual(script.parseLine('attack 1,2 any a:1 @00:30:00').camp, 1800);
  assert.strictEqual(script.parseLine('attack 1,2 any a:1 @4:30').camp, 270, 'two parts are m:ss');
  assert.strictEqual(script.parseLine('attack 1,2 any a:1 1:00:00').camp, 3600);
  assert.match(parseErr('attack 1,2 any a:1 @07:00:00.500'), /camp time is whole seconds; for a landing time put a colon after the @: @:07:00:00\.500/);
  assert.match(parseErr('attack 1,2 any a:1 @:25:00'), /bad time/);
  assert.match(parseErr('attack 1,2 any a:1 @:1:00 @0:30'), /one time per march/);
});
t('sleep takes NEAT\'s forms too', () => {
  assert.strictEqual(script.parseLine('sleep 15').seconds, 15);
  assert.strictEqual(script.parseLine('sleep 1:43').seconds, 103);
  assert.strictEqual(script.parseLine('sleep 4:22:32').seconds, 15752);
  assert.deepStrictEqual(script.parseLine('sleep @:14:15:00').until, { h: 14, m: 15, s: 0, ms: 0 });
});
t('logout: both times needed, and it is the last thing', () => {
  assert.deepStrictEqual(script.parseLine('logout now @:14:35'), { cmd: 'logout', out: { wait: 0 }, back: { at: { h: 14, m: 35, s: 0, ms: 0 } } });
  assert.deepStrictEqual(script.parseLine('logout 1:00 29:00').back, { wait: 1740 });
  assert.match(parseErr('logout now'), /say when to log out and when to log back in/);
  assert.match(parseErr('logout soon 1:00'), /is not a time/);
  const acts = script.parse('logout now 1:05:00\necho too late');
  assert.match(acts.find((a) => a.cmd === 'error').error, /nothing can run after logout/);
  assert.ok(!script.parse('echo hi\nlogout now 1:05:00').some((a) => a.cmd === 'error'));
});
t('buildstatus parses', () => { assert.strictEqual(script.parseLine('buildstatus').cmd, 'buildstatus'); });

section('script: running the recipe');

t('two deploy bu lines: both build marches land together, each with its own hero', async () => {
  fresh();
  const s = sim();
  const at = new Date(aimIn(3600000));
  const hh = at.getHours(), mm = at.getMinutes(), ss = at.getSeconds();   // unpadded, as `set timem 5` would be
  const src = `set timeh ${hh}\nset timem ${mm}\n`
    + `deploy bu 103,104 any wo:500 f:26k,l:26k,s:26k,i:12k,g:10k @:%timeh%:%timem%:${ss}.5\n`
    + `deploy bu 96,99 any wo:500 f:26k,l:26k,s:26k,i:12k,g:10k @:%timeh%:%timem%:${ss}.5`;
  const out = [];
  const done = await script.run(s.g, script.parse(src), (m) => out.push(m), { castle: 'Home' });
  const text = out.join('\n');
  assert.strictEqual(done, 2, text);
  const sends = s.log.filter((x) => x.cmd === 'newArmy');
  assert.strictEqual(sends.length, 2, text);
  const b = sends[0].bean;
  assert.strictEqual(b.missionType, C.MISSION.construct);
  assert.strictEqual(b.troops.peasants, 500);
  assert.deepStrictEqual(b.resource, { iron: 12000, food: 26000, wood: 26000, stone: 26000, gold: 10000 });
  assert.ok(Number.isInteger(b.restTime) && b.restTime > 3000, 'camp ' + b.restTime);
  assert.notStrictEqual(sends[0].bean.heroId, sends[1].bean.heroId, 'the second "any" skips the hero just sent');
  assert.match(text, /flat L5, held by Home/);
  assert.match(text, /build city -> \(103,104\)/);
  assert.match(text, /2 marches due then/);
});
t('a build to a lake fails before anything is sent', async () => {
  fresh();
  const s = sim();
  const out = [];
  await script.run(s.g, script.parse('deploy bu 101,97 any wo:500 @:23:59:59.5'), (m) => out.push(m), { castle: 'Home' });
  assert.strictEqual(s.log.length, 0);
  assert.match(out.join('\n'), /FAILED: 101,97 is your Lake L9, not a flat/);
});
t('camp-only marches go at once with that camp', async () => {
  const s = sim();
  const out = [];
  await script.run(s.g, script.parse('reinforce Fla none a:5 @0:30:00'), (m) => out.push(m), { castle: 'Home' });
  assert.strictEqual(s.log[0].bean.restTime, 1800);
  assert.match(out.join('\n'), /camp 30m 00\.000s/);
});

section('logout (logout.js)');

t('waits for the other cities\' scripts, then stands the console down until the time', async () => {
  const s = sim();
  let others = ['2'], calls = [], flag = [];
  setTimeout(() => { others = []; }, 1200);
  const session = { logoutUntil: (at, why) => calls.push({ at, why }) };
  const out = [];
  const a = script.parseLine('logout now 1:05:00');
  const ok = await LO.run(s.g, a, { session, log: (m) => out.push(m), otherScripts: () => others, atLogout: (v) => flag.push(v) });
  assert.ok(ok);
  assert.match(out.join('\n'), /waiting for the script in Fla to finish first/);
  assert.doesNotMatch(out.join('\n'), /build march/, 'no build status when there are no builds out');
  assert.strictEqual(calls.length, 1);
  assert.ok(Math.abs(calls[0].at - (Date.now() + 3900000)) < 3000);
  assert.deepStrictEqual(flag, [true, false]);
});
t('the session: a logout is a stand-down no login gets through, until its time', async () => {
  const { Session } = require('./session');
  const s = new Session(); s.account = { id: 'test', label: 'T' }; s.note = () => {};
  s.game = { castles: [{}, {}] };
  const p = s.logoutUntil(Date.now() + 3600000);
  assert.deepStrictEqual([p.source, p.citiesBefore, s.planPhase()], ['logout', 2, 'standdown']);
  s.game = null;
  await assert.rejects(s.connect(), /logged out by a script until .* press Connect to end that early/);
  assert.strictEqual(s.planPhase(Date.now() + 3600001), 'recovering', 'after the time it logs back in');
  s.clearMaintenancePlan();
  assert.strictEqual(s.planPhase(), 'none');
});
t('with builds out, logout shows where they all land before going dark', async () => {
  const s = sim();
  s.g.player.selfArmys = [{ armyId: 1, direction: 1, missionType: 4, targetFieldId: F(103, 104), startFieldId: F(100, 100), reachTime: 1e12 + 500, restTime: 0, hero: 'Ann' }];
  const out = [];
  await LO.run(s.g, script.parseLine('logout now 1:05:00'), { session: { logoutUntil: () => {} }, log: (m) => out.push(m) });
  assert.match(out.join('\n'), /1 build march on the way, landing in 1 different second/);
});
t('a dry run stays logged in, and so does a run without the console', async () => {
  const s = sim();
  const out = [];
  assert.strictEqual(await LO.run(s.g, script.parseLine('logout now 1:00:00'), { log: (m) => out.push(m), dryRun: true }), false);
  await assert.rejects(LO.run(s.g, script.parseLine('logout now 1:00:00'), { log: () => {} }), /only works from the console/);
});

// ---------------------------------------------------------------------------
(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n + '\n'); continue; }
    try { await f(); console.log('  ok    ' + n); pass++; }
    catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message.split('\n').join('\n        ')); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
