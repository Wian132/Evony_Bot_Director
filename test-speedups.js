'use strict';
// Free finishes (speedups.js): the game finishes a construction or a research
// for nothing when its PRESET time is five minutes or less. Offline: the pure
// plan against fake castles and a fake clock, then the real Game and Engine
// against a fake server. No network, no login.
const assert = require('assert');
const path = require('path'), os = require('os'), fs = require('fs');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-speed-')), 't.db');

const C = require('./constants');
const S = require('./speedups');
const { EvonyClient } = require('./evony');
const { Game } = require('./game');
const { Engine } = require('./engine');
const { parseGoals, NOT_IMPLEMENTED } = require('./goals');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const n = (x) => Number(x || 0);

// ---- the pure plan: fake castles, a fake clock -------------------------------

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const FARM = 7, COTTAGE = 1, BARRACKS = 2, FORGE = 22, WAREHOUSE = 3, WALLS = 32, TOWN_HALL = 31;
const FEASTING_HALL = 27, INFORMATICS = 7, AGRICULTURE = 1;

// A building bean the way the server sends one: the CURRENT level, status 1
// upgrading or 2 demolishing, start and end on the server's clock. `ran` is
// how long the job runs in all (its preset time unless said otherwise).
function bean(typeId, positionId, level, { status = 1, left = 60, ran = null } = {}) {
  const total = ran ?? (S.presetSec('building', typeId, level) || 1200);
  const endTime = NOW + left * 1000;
  return { typeId, positionId, level, status, name: C.BUILDING_BY_ID[typeId].name, startTime: endTime - total * 1000, endTime };
}
const plan = (buildings, o = {}) => S.freeSpeedPlan(
  { castle: { buildings }, config: o.config || {}, research: o.research || null, now: o.now ?? NOW },
  o.cityState || {}, o.seen || null);
const research = (typeId, level, { left = 100, startTime, endTime, seenAt } = {}) => ({
  typeId, level, startTime: startTime ?? NOW - 10e3, endTime: endTime ?? NOW + left * 1000, seenAt: seenAt ?? NOW,
});

section('when the game gives a free finish (SpeedUpCheckOut: the level\'s preset time, 300 s or less)');

t('the item and the limit are the client\'s', () => {
  assert.strictEqual(C.FREE_SPEED.item, 'free.speed');
  assert.strictEqual(C.FREE_SPEED.limitSec, 300);
});

t('preset times by the level a job starts from, from the client\'s tables', () => {
  const b = (typeId, level) => S.presetSec('building', typeId, level);
  assert.deepStrictEqual([0, 1, 2, 3].map((l) => b(COTTAGE, l)), [75, 150, 300, null], 'Cottage 1-3 free, 4 not');
  assert.deepStrictEqual([0, 1, 2, 3, 4].map((l) => b(FARM, l)), [30, 60, 120, 240, null], 'Farm 1-4 free, 5 not');
  assert.deepStrictEqual([b(BARRACKS, 0), b(BARRACKS, 1)], [300, null], 'Barracks 1 is exactly 300 s: free');
  assert.deepStrictEqual([b(FORGE, 0), b(FORGE, 1)], [180, null], 'Forge 2 takes 360 s: not free');
  assert.deepStrictEqual([b(FEASTING_HALL, 0), b(29, 1), b(29, 2)], [300, 300, null]);
  for (const typeId of [WAREHOUSE, WALLS, TOWN_HALL, 23, 24, 25, 26, 28, 30]) {
    assert.strictEqual(b(typeId, 0), null, `${C.BUILDING_BY_ID[typeId].name} is never free`);
  }
  assert.deepStrictEqual([S.presetSec('research', INFORMATICS, 0), S.presetSec('research', INFORMATICS, 1)], [300, null]);
  assert.strictEqual(S.presetSec('research', AGRICULTURE, 0), null, 'Agriculture 1 takes 400 s');
  assert.strictEqual(S.presetSec('building', COTTAGE, null), null, 'no level, no answer');
});

section('what the plan finishes');

t('a new Cottage going up (status 1 at level 0) is finished at its plot', () => {
  const p = plan([bean(COTTAGE, 5, 0)]);
  assert.strictEqual(p.finishes.length, 1);
  assert.deepStrictEqual([p.finishes[0].kind, p.finishes[0].positionId, p.finishes[0].preset], ['building', 5, 75]);
  assert.strictEqual(p.finishes[0].label, 'Cottage (pos 5) L0->L1');
  assert.deepStrictEqual(p.notes, []);
});

t('300 s of preset time is free, 360 s is not (Barracks 1 against Forge 2)', () => {
  assert.strictEqual(plan([bean(BARRACKS, 3, 0, { left: 250 })]).finishes.length, 1);
  const p = plan([bean(FORGE, 4, 1, { left: 250 })]);
  assert.strictEqual(p.finishes.length, 0);
  assert.match(p.notes[0], /no free finish for Forge \(pos 4\) L1->L2 \(4m 10s left\)/);
});

t('the time left plays no part: a qualifying job is finished at the first look, whenever that is', () => {
  for (const left of [299, 180, 3]) {
    assert.strictEqual(plan([bean(COTTAGE, 5, 2, { left })]).finishes.length, 1, `${left} s left`);
  }
  assert.strictEqual(plan([bean(FARM, 1001, 0, { left: 1 })]).finishes.length, 1, 'a 30 s farm one second from done');
});

t('a long job with under five minutes left is not free, and the note says why', () => {
  const at300 = plan([bean(WAREHOUSE, 6, 0, { left: 300 })]);
  assert.strictEqual(at300.finishes.length, 0, 'a 10-minute Warehouse is never free');
  assert.match(at300.notes[0], /no free finish for Warehouse \(pos 6\) L0->L1 \(5m left\): the game gives one only to a job whose preset time is 5m or less, and this one's is longer/);
  const at301 = plan([bean(WAREHOUSE, 6, 0, { left: 301 })]);
  assert.deepStrictEqual([at301.finishes.length, at301.notes.length], [0, 0], 'quiet until it is under five minutes');
});

t('a demolition is never finished free, not even a short one', () => {
  const p = plan([bean(FARM, 1001, 1, { status: 2, left: 20, ran: 30 })]);
  assert.deepStrictEqual([p.finishes.length, p.notes.length], [0, 0]);
});

t('a job over by the clock has nothing left to finish', () => {
  assert.strictEqual(plan([bean(COTTAGE, 5, 0, { left: 0 })]).finishes.length, 0);
  assert.strictEqual(plan([bean(COTTAGE, 5, 0, { left: -40 })]).finishes.length, 0);
  assert.strictEqual(plan([{ ...bean(COTTAGE, 5, 0), status: 0 }]).finishes.length, 0, 'standing, not building');
});

t('a job that runs longer than its preset time is not the job the table describes: left alone', () => {
  const long = plan([bean(COTTAGE, 5, 2, { ran: 303, left: 200 })]);
  assert.strictEqual(long.finishes.length, 0);
  assert.match(long.notes[0], /it runs 5m 3s, longer than its 5m preset time/);
  assert.strictEqual(plan([bean(COTTAGE, 5, 2, { ran: 302, left: 200 })]).finishes.length, 1, 'two seconds of stamping slack');
  assert.strictEqual(plan([bean(COTTAGE, 5, 2, { ran: 240, left: 200 })]).finishes.length, 1, 'research and the mayor make it shorter');
});

t('config freespeedup:0 turns it off; 1 or nothing leaves it on', () => {
  const off = plan([bean(COTTAGE, 5, 0)], { config: { freespeedup: 0 } });
  assert.strictEqual(off.finishes.length, 0);
  assert.match(off.notes[0], /free finish for Cottage \(pos 5\) L0->L1 is off \(config freespeedup:0\)/);
  assert.strictEqual(plan([bean(COTTAGE, 5, 0)], { config: { freespeedup: 1 } }).finishes.length, 1);
  assert.strictEqual(plan([bean(COTTAGE, 5, 0)], { config: {} }).finishes.length, 1);
});

t('an unreadable freespeedup value is read as on, and the note says so', () => {
  const p = plan([bean(COTTAGE, 5, 0)], { config: { freespeedup: 'off' } });
  assert.strictEqual(p.finishes.length, 1);
  assert.match(p.notes[0], /config freespeedup:off is read as on — 1 keeps free finishes on \(the default\), 0 turns them off/);
});

t('a job is asked once: an ok is not sent again, a refusal is not retried and says so', () => {
  const b = bean(COTTAGE, 5, 0);
  const first = plan([b]);
  const key = first.finishes[0].key;
  const done = plan([b], { cityState: { freeSpeed: { [key]: { at: NOW, ok: true, msg: '' } } } });
  assert.deepStrictEqual([done.finishes.length, done.notes.length], [0, 0]);
  const refused = plan([b], { cityState: { freeSpeed: { [key]: { at: NOW, ok: false, msg: 'Not enough time' } } } });
  assert.strictEqual(refused.finishes.length, 0);
  assert.match(refused.notes[0], /the free finish for Cottage \(pos 5\) L0->L1 was refused \(Not enough time\); not asked again/);
});

t('a job an earlier pass of the slice listed is not listed twice', () => {
  const b = bean(COTTAGE, 5, 0);
  const seen = new Set([plan([b]).finishes[0].key]);
  assert.strictEqual(plan([b], { seen }).finishes.length, 0);
});

t('research: Informatics 1 (300 s) is finished, Agriculture 1 (400 s) is not', () => {
  const p = plan([], { research: research(INFORMATICS, 0) });
  assert.deepStrictEqual(p.finishes.map((f) => [f.kind, f.label, f.preset]), [['research', 'research Informatics L0->L1', 300]]);
  const ag = plan([], { research: research(AGRICULTURE, 0, { left: 200 }) });
  assert.strictEqual(ag.finishes.length, 0);
  assert.match(ag.notes[0], /no free finish for research Agriculture L0->L1 \(3m 20s left\)/);
  assert.strictEqual(plan([], { research: research(INFORMATICS, 1) }).finishes.length, 0, 'Informatics 2 takes 600 s');
});

t('research: over by the clock is nothing; without an end time it runs at most its preset time from when it was seen', () => {
  assert.strictEqual(plan([], { research: research(INFORMATICS, 0, { left: -5 }) }).finishes.length, 0);
  const seenRecently = { typeId: INFORMATICS, level: 0, startTime: 0, endTime: 0, seenAt: NOW - 200e3 };
  assert.strictEqual(plan([], { research: seenRecently }).finishes.length, 1);
  assert.strictEqual(plan([], { research: { ...seenRecently, seenAt: NOW - 400e3 } }).finishes.length, 0);
  const unknown = plan([], { research: { typeId: INFORMATICS, level: null, endTime: NOW + 100e3, seenAt: NOW } });
  assert.strictEqual(unknown.finishes.length, 0);
  assert.match(unknown.notes[0], /no free finish for research Informatics L\?->L\?: its level is not known yet/);
});

// ---- the real Game on a fake wire ---------------------------------------------

class FakeClient extends EvonyClient {
  constructor(server) { super(); this.server = server; this.sock = { destroyed: false }; }
  send(cmd, data) { this.server.handle(this, cmd, data); }
}

// Plays the server: starts and finishes construction and research, and applies
// what the server would push (server.BuildComplate, which session.js writes into
// castle.buildings) straight into the city. `startPushMs` holds the push of a
// construction START back that long, as a push that comes after the reply;
// `finishPush: false` never pushes the end of a free-finished job.
class FakeServer {
  constructor({ startPushMs = 0, finishPush = true, speed = 0.8 } = {}) {
    this.startPushMs = startPushMs;
    this.finishPush = finishPush;
    this.speed = speed;            // research and the mayor: jobs run shorter than their preset
    this.sent = [];
    this.refuse = null;            // a reply for castle.speedUpBuildCommand / tech.speedUpResearch
    this.replies = {};             // cmd -> a fixed reply
    this.research = {};            // castleId -> the tech being researched
  }

  attach(g) { this.g = g; g.c = new FakeClient(this); return g; }

  handle(client, cmd, data) {
    this.sent.push({ cmd, data });
    const reply = (d) => setImmediate(() => client.emit('cmd', cmd, d, { cmd, data: d }));
    if (this.replies[cmd]) return reply(this.replies[cmd]);
    const castle = this.g.castles.find((c) => this.g.castleId(c) === data.castleId);
    const at = (pos) => castle && castle.buildings.find((b) => Number(b.positionId) === Number(pos));
    const now = this.g.now();
    if (cmd === 'castle.upgradeBuilding' || cmd === 'castle.newBuilding') {
      const b = cmd === 'castle.newBuilding'
        ? { typeId: data.buildingType, positionId: data.positionId, level: 0, status: 0, name: C.BUILDING_BY_ID[data.buildingType].name }
        : at(data.positionId);
      if (!b || n(b.status) !== 0) return reply({ ok: -1, errorMsg: 'One building allowed to be built at a time.' });
      const sec = (S.presetSec('building', b.typeId, b.level) || 1200) * this.speed;
      const started = { ...b, status: 1, startTime: now, endTime: now + sec * 1000 };
      if (this.startPushMs) setTimeout(() => this.put(castle, started), this.startPushMs);
      else this.put(castle, started);
      return reply({ ok: 1 });
    }
    if (cmd === 'castle.speedUpBuildCommand') {
      if (this.refuse) return reply(this.refuse);
      const b = at(data.positionId);
      if (!b || n(b.status) !== 1) return reply({ ok: -1, errorMsg: 'No building is under construction there.' });
      if (this.finishPush) this.put(castle, { ...b, status: 0, level: n(b.level) + 1, startTime: 0, endTime: 0 });
      return reply({ ok: 1 });
    }
    if (cmd === 'tech.research') {
      const tech = { typeId: data.techId, level: 0, upgradeing: true, castleId: data.castleId, startTime: now, endTime: now + 240e3 };
      this.research[data.castleId] = tech;
      return reply({ ok: 1, tech });
    }
    if (cmd === 'tech.speedUpResearch') {
      if (this.refuse) return reply(this.refuse);
      const tech = this.research[data.castleId];
      if (!tech) return reply({ ok: -1, errorMsg: 'Nothing is being researched.' });
      delete this.research[data.castleId];
      return reply({ ok: 1, tech: { ...tech, level: tech.level + 1, upgradeing: false } });
    }
    return reply({ ok: 1 });
  }

  put(castle, b) {
    const i = castle.buildings.findIndex((x) => Number(x.positionId) === Number(b.positionId));
    if (i >= 0) castle.buildings[i] = b; else castle.buildings.push(b);
  }

  cmds(re = /./) { return this.sent.filter((s) => re.test(s.cmd)); }
  speedUps() { return this.cmds(/speedUp/).map((s) => (s.cmd === 'tech.speedUpResearch' ? ['research', s.data.itemId] : [s.data.positionId, s.data.itemId])); }
}

const city = (id, name, buildings = []) => ({
  id, name, fieldId: 100 * 800 + 100 + id,
  resource: { food: { amount: 1e12 }, wood: { amount: 1e12 }, stone: { amount: 1e12 }, iron: { amount: 1e12 },
              gold: 1e9, curPopulation: 1000, maxPopulation: 1000, workPeople: 0, buildPeople: 0, support: 100 },
  troop: {}, fortification: {}, heros: [], buildings,
});
const standingBean = (typeId, positionId, level) => ({ typeId, positionId, level, status: 0, name: C.BUILDING_BY_ID[typeId].name });

function world(buildings = [], opts = {}) {
  const server = new FakeServer(opts);
  const g = server.attach(new Game());
  g.castles = [city(1, 'Home', buildings)];
  g.player = { playerInfo: { userName: 'T' }, selfArmys: [], enemyArmys: [], items: [], castles: g.castles };
  return { server, g, home: g.castles[0] };
}

function engine(w, goals, { dryRun = false } = {}) {
  const e = new Engine(w.g, () => {});
  e.dryRun = dryRun;
  e.state = {};
  e.goalsFor = () => parseGoals(goals);
  return e;
}

const liveBean = (g, typeId, positionId, level, { status = 1, ran = null } = {}) => {
  const sec = ran ?? (S.presetSec('building', typeId, level) || 1200);
  const now = g.now();
  return { typeId, positionId, level, status, name: C.BUILDING_BY_ID[typeId].name, startTime: now - 5e3, endTime: now - 5e3 + sec * 1000 };
};

async function pass(w, { config = {}, cityState = {}, dryRun = false, seen = null } = {}) {
  const p = S.freeSpeedPlan({ castle: w.home, config, research: w.g.runningResearch(1), now: w.g.now() }, cityState, seen);
  const acted = await S.runFreeSpeed(w.g, w.home, p, cityState, { dryRun, seen });
  return { p, acted, cityState };
}

section('sending it (the real Game on a fake wire)');

t('castle.speedUpBuildCommand {castleId, positionId, itemId: free.speed} goes out', async () => {
  const w = world();
  w.home.buildings.push(liveBean(w.g, COTTAGE, 5, 0));
  const first = await pass(w);
  assert.deepStrictEqual(w.server.cmds(/speedUp/).map((s) => [s.cmd, s.data]),
    [['castle.speedUpBuildCommand', { castleId: 1, positionId: 5, itemId: 'free.speed' }]]);
  assert.deepStrictEqual(first.acted, ['free finish Cottage (pos 5) L0->L1 (preset 1m 15s) -> ok']);
  assert.deepStrictEqual([w.home.buildings[0].level, w.home.buildings[0].status], [1, 0], 'finished');
});

t('an ok is not sent again while the list still shows the job running', async () => {
  const w = world([], { finishPush: false });                // the end is never pushed (goalsd keeps no pushes)
  w.home.buildings.push(liveBean(w.g, COTTAGE, 5, 0));
  const first = await pass(w);
  const again = await pass(w, { cityState: first.cityState });
  assert.deepStrictEqual([first.acted.length, again.acted, again.p.notes], [1, [], []]);
  assert.strictEqual(w.server.cmds(/speedUp/).length, 1);
});

t('research goes out as tech.speedUpResearch {castleId, itemId: free.speed}', async () => {
  const w = world();
  await w.g.research(1, INFORMATICS);
  const r = await pass(w);
  assert.deepStrictEqual(w.server.cmds(/speedUp/).map((s) => [s.cmd, s.data]),
    [['tech.speedUpResearch', { castleId: 1, itemId: 'free.speed' }]]);
  assert.deepStrictEqual(r.acted, ['free finish research Informatics L0->L1 (preset 5m) -> ok']);
  assert.strictEqual(w.g.runningResearch(1), null, 'a research finished at once has nothing left running');
});

t('a refusal is shown, kept, and not retried for that job', async () => {
  const w = world();
  w.server.refuse = { ok: -1, errorMsg: 'The free speed-up is not available.' };
  w.home.buildings.push(liveBean(w.g, FARM, 1001, 2));
  const first = await pass(w);
  assert.deepStrictEqual(first.acted, ['free finish Farm (pos 1001) L2->L3 (preset 2m) -> The free speed-up is not available.']);
  const second = await pass(w, { cityState: first.cityState });
  assert.deepStrictEqual(second.acted, []);
  assert.strictEqual(w.server.cmds(/speedUp/).length, 1);
  assert.match(second.p.notes[0], /the free finish for Farm \(pos 1001\) L2->L3 was refused \(The free speed-up is not available\.\); not asked again/);
});

t('a send that fails outright counts as refused and is not retried', async () => {
  const w = world();
  w.home.buildings.push(liveBean(w.g, FARM, 1001, 0));
  w.g.speedUpBuild = async () => { throw new Error('no reply to castle.speedUpBuildCommand'); };
  const first = await pass(w);
  assert.deepStrictEqual(first.acted, ['free finish Farm (pos 1001) L0->L1 (preset 30s) -> no reply to castle.speedUpBuildCommand']);
  const second = await pass(w, { cityState: first.cityState });
  assert.deepStrictEqual(second.acted, []);
});

t('a dry run lists it and sends nothing, and keeps nothing', async () => {
  const w = world();
  w.home.buildings.push(liveBean(w.g, COTTAGE, 5, 1));
  const r = await pass(w, { dryRun: true });
  assert.deepStrictEqual(r.acted, ['[plan] free finish Cottage (pos 5) L1->L2 (preset 2m 30s)']);
  assert.deepStrictEqual([w.server.sent.length, r.cityState.freeSpeed], [0, undefined]);
});

t('an answer is forgotten once its job is gone; a job started again gets its own attempt', async () => {
  const w = world();
  w.server.refuse = { ok: -1, errorMsg: 'no' };
  w.home.buildings.push(liveBean(w.g, COTTAGE, 5, 0));
  const first = await pass(w);
  assert.strictEqual(Object.keys(first.cityState.freeSpeed).length, 1);
  // cancelled and started again: a new start time, so a new job
  w.home.buildings[0] = { ...liveBean(w.g, COTTAGE, 5, 0), startTime: w.g.now() - 1e3 };
  w.server.refuse = null;
  const second = await pass(w, { cityState: first.cityState });
  assert.deepStrictEqual(second.acted, ['free finish Cottage (pos 5) L0->L1 (preset 1m 15s) -> ok']);
  const third = await pass(w, { cityState: second.cityState });   // the cottage stands at L1 now
  assert.strictEqual(third.cityState.freeSpeed, undefined, 'answers for jobs no longer running were kept');
});

t('two cities asking at once each get their own reply (the command waits in a lane)', async () => {
  const w = world();
  w.g.castles.push(city(2, 'Second', []));
  w.home.buildings.push(liveBean(w.g, COTTAGE, 5, 0));
  w.g.castles[1].buildings.push(liveBean(w.g, FARM, 1001, 0));
  const [a, b] = await Promise.all([
    w.g.speedUpBuild(1, 5, C.FREE_SPEED.item),
    w.g.speedUpBuild(2, 999, C.FREE_SPEED.item),       // nothing at 999: refused
  ]);
  assert.deepStrictEqual([a.ok, b.ok], [1, -1]);
});

section('research seen in passing (Game.runningResearch)');

t('a research list read notes the research in the city it was read for, and in the others it names', async () => {
  const w = world();
  w.server.replies['tech.getResearchList'] = { ok: 1, acailableResearchBeans: [
    { typeId: INFORMATICS, level: 0, upgradeing: true, castleId: 1, startTime: 100, endTime: 200 },
    { typeId: AGRICULTURE, level: 3, upgradeing: true, castleId: 2, startTime: 300, endTime: 400 },
    { typeId: 8, level: 1, upgradeing: false, castleId: 0 },
  ] };
  await w.g.researchList(1);
  assert.deepStrictEqual(w.g.runningResearch(1), { typeId: INFORMATICS, level: 0, startTime: 100, endTime: 200, seenAt: w.g.runningResearch(1).seenAt });
  assert.strictEqual(w.g.runningResearch(2).typeId, AGRICULTURE);
  w.server.replies['tech.getResearchList'] = { ok: 1, acailableResearchBeans: [{ typeId: INFORMATICS, level: 1, upgradeing: false }] };
  await w.g.researchList(1);
  assert.strictEqual(w.g.runningResearch(1), null, 'a list with nothing running here clears it');
  assert.strictEqual(w.g.runningResearch(2).typeId, AGRICULTURE, 'the other city is not the one this list was read for');
});

t('tech.research notes the research it started; a refused one notes nothing', async () => {
  const w = world();
  await w.g.research(1, INFORMATICS);
  assert.deepStrictEqual([w.g.runningResearch(1).typeId, w.g.runningResearch(1).level], [INFORMATICS, 0]);
  const w2 = world();
  w2.server.replies['tech.research'] = { ok: -1, errorMsg: 'no academy' };
  await w2.g.research(1, INFORMATICS);
  assert.strictEqual(w2.g.runningResearch(1), null);
});

t('a research reply without the tech still notes it, with the level unknown', () => {
  const g = new Game();
  g.noteResearch(1, { typeId: INFORMATICS, upgradeing: true });
  assert.deepStrictEqual([g.runningResearch(1).typeId, g.runningResearch(1).level], [INFORMATICS, null]);
});

// ---- through the engine ------------------------------------------------------

section('through the engine');

// Construction orders and speed-ups. Since Step 11 the engine also reads an
// order's requirements first (castle.checkOutUpgrade / getAvailableBuildingBean);
// those reads change nothing, so they are left out here.
const ORDERS = /^castle\.(?!checkOutUpgrade$|getAvailableBuildingBean$)/;

t('the slice\'s own construction is finished in the same slice', async () => {
  const w = world([standingBean(FARM, 1001, 1)]);
  const e = engine(w, 'config hero:0\nbuild f:4:1');
  const r = await e.focus(w.home);
  assert.deepStrictEqual(w.server.cmds(ORDERS).map((s) => [s.cmd, s.data.positionId]),
    [['castle.upgradeBuilding', 1001], ['castle.speedUpBuildCommand', 1001]]);
  assert.deepStrictEqual([w.home.buildings[0].level, w.home.buildings[0].status], [2, 0]);
  assert.ok(r.acted.includes('free finish Farm (pos 1001) L1->L2 (preset 1m) -> ok'), r.acted.join(' | '));
});

t('free finishes do not count against the slice\'s three actions', async () => {
  const w = world([standingBean(FARM, 1001, 1)]);
  const e = engine(w, 'config hero:0\nbuild f:4:1');
  e.maxActionsPerSlice = 1;
  await e.focus(w.home);
  assert.deepStrictEqual(w.server.cmds(ORDERS).map((s) => s.cmd), ['castle.upgradeBuilding', 'castle.speedUpBuildCommand']);
});

t('a job started elsewhere is finished before the plan, and the builder takes the next one in the same slice', async () => {
  const w = world();
  w.home.buildings.push(liveBean(w.g, COTTAGE, 5, 0));        // a script's `build cottage` since the last slice
  const e = engine(w, 'config hero:0\nbuild c:3:1');
  const r = await e.focus(w.home);
  assert.deepStrictEqual(w.server.cmds(ORDERS).map((s) => [s.cmd, s.data.positionId]),
    [['castle.speedUpBuildCommand', 5], ['castle.upgradeBuilding', 5], ['castle.speedUpBuildCommand', 5]]);
  assert.strictEqual(w.home.buildings[0].level, 2);
  assert.strictEqual(r.acted[0], 'free finish Cottage (pos 5) L0->L1 (preset 1m 15s) -> ok', 'the first pass is logged first');
});

t('a start pushed after the slice has moved on is finished first thing next slice — no timer needed', async () => {
  const w = world([standingBean(FARM, 1001, 1)], { startPushMs: 20 });
  const e = engine(w, 'config hero:0\nbuild f:4:1');
  await e.focus(w.home);
  assert.deepStrictEqual(w.server.cmds(ORDERS).map((s) => s.cmd), ['castle.upgradeBuilding'], 'nothing to see yet');
  await new Promise((r) => setTimeout(r, 40));                // the push lands between slices
  w.server.sent = [];
  await e.focus(w.home);
  assert.deepStrictEqual(w.server.cmds(ORDERS).map((s) => [s.cmd, s.data.positionId]),
    [['castle.speedUpBuildCommand', 1001], ['castle.upgradeBuilding', 1001]]);
  await new Promise((r) => setTimeout(r, 40));
  w.server.sent = [];
  await e.focus(w.home);
  assert.deepStrictEqual(w.server.cmds(/speedUp/).length, 1, 'each job once');
  await new Promise((r) => setTimeout(r, 40));                // let the last late push land
});

t('the engine leaves no timer behind', async () => {
  const timers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
  const w = world([standingBean(FARM, 1001, 1)]);
  const e = engine(w, 'config hero:0\nbuild f:4:1');
  const before = timers();
  await e.focus(w.home);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(timers(), before);
});

// A war pass (tick({urgent: true})) is hiding and the gate alone, racing a
// wave. A free finish is never in a race — a job that qualifies stays
// qualified — so it waits for the city's regular slice.
t('an urgent war-only pass sends no free finish; the regular slice does', async () => {
  const w = world();
  w.home.buildings.push(liveBean(w.g, COTTAGE, 5, 0));
  const e = engine(w, 'config hero:0\nbuild c:3:1');
  await e.tick({ urgent: true });
  assert.deepStrictEqual(w.server.cmds(/speedUp/), []);
  await e.focus(w.home);
  assert.deepStrictEqual(w.server.speedUps()[0], [5, 'free.speed']);
});

t('a long job gets nothing through the engine; near its end the note says why', async () => {
  const w = world();
  const farm = liveBean(w.g, FARM, 1001, 5);                  // Farm 6: 960 s preset
  farm.endTime = w.g.now() + 200e3;
  w.home.buildings.push(farm);
  const e = engine(w, 'config hero:0\nbuild f:10:1');
  const r = await e.focus(w.home);
  assert.deepStrictEqual(w.server.cmds(ORDERS), []);
  assert.match(r.speedup.note, /^free finish: no free finish for Farm \(pos 1001\) L5->L6 \(3m 20s left\)/);
});

t('config freespeedup:0 in the goals: nothing sent, and the plan says so', async () => {
  const w = world([standingBean(FARM, 1001, 1)]);
  const e = engine(w, 'config hero:0,freespeedup:0\nbuild f:4:1');
  const r = await e.focus(w.home);
  assert.deepStrictEqual(w.server.cmds(/speedUp/), []);
  assert.match(r.speedup.note, /free finish for Farm \(pos 1001\) L1->L2 is off \(config freespeedup:0\)/);
});

t('a dry run plans the finish once a slice and sends nothing', async () => {
  const w = world();
  w.home.buildings.push(liveBean(w.g, COTTAGE, 5, 0));
  const e = engine(w, 'config hero:0\nbuild c:3:1', { dryRun: true });
  const r = await e.focus(w.home);
  assert.deepStrictEqual(r.acted.filter((a) => /free finish/.test(a)), ['[plan] free finish Cottage (pos 5) L0->L1 (preset 1m 15s)']);
  assert.deepStrictEqual(w.server.cmds(/speedUp/), []);
});

t('a research the game object has seen start is finished at the next slice, once', async () => {
  const w = world();
  await w.g.research(1, INFORMATICS);                          // the script's `research informatics`
  const e = engine(w, 'config hero:0\nbuild c:0:0');
  await e.focus(w.home);
  await e.focus(w.home);
  assert.deepStrictEqual(w.server.speedUps(), [['research', 'free.speed']]);
});

t('the research list a build ?condition? reads also tells the free finish what is researched', async () => {
  const w = world();
  const now = w.g.now();
  w.server.replies['tech.getResearchList'] = { ok: 1, acailableResearchBeans: [
    { typeId: INFORMATICS, level: 0, upgradeing: true, castleId: 1, startTime: now - 40e3, endTime: now + 200e3 },
  ] };
  w.server.research[1] = { typeId: INFORMATICS, level: 0, upgradeing: true, castleId: 1 };
  const e = engine(w, 'config hero:0\nbuild ?in:1?c:1:1');
  await e.focus(w.home);
  assert.strictEqual(w.server.cmds(/tech\.getResearchList/).length, 1, 'read once, by the build condition');
  assert.deepStrictEqual(w.server.speedUps(), [['research', 'free.speed']]);
});

t('troop and wall batches never get one: the client has no free finish for them', async () => {
  const w = world([standingBean(BARRACKS, 4, 1), standingBean(FARM, 1001, 1), standingBean(WALLS, -2, 1)]);
  const q = (pos, type) => ({ ok: 1, allProduceQueue: [{ positionId: pos, allProduceQueue: [{ queueId: 1, type, num: 5, endTime: w.g.now() + 60e3, costTime: 60 }] }] });
  w.server.replies['troop.getProduceQueue'] = q(4, 7);
  w.server.replies['fortifications.getProduceQueue'] = q(-2, 15);
  w.server.replies['troop.getTroopProduceList'] = { ok: 1, troopList: [{ typeId: 7, permition: true, conditionBean: { time: 12 } }] };
  const e = engine(w, 'config hero:0\ntroop a:10\nfortification ab:10\nbuild f:4:1');
  await e.focus(w.home);
  assert.deepStrictEqual(w.server.cmds(/accTroopProduce/), []);
  assert.deepStrictEqual(w.server.speedUps(), [[1001, 'free.speed']], 'the farm still gets its own');
});

section('the live goals (live-goals.txt)');

// Lord22 (a1), as its city goals are saved.
const A1 = `// Lord22 build-up
config comfort:1,hero:1,troopsusepopmax:1
comfortpolicy 15 16 popraise
defensepolicy /usetruce:79 /usespeech:2 /junktroop:5000 /usewarhorn:1 /usecorselet:1 /usepenicillin:1
build f:10:37,s:0:0,i:0:0,q:0:0
// troop ladder: ballista+transports first, then a broad base, then archers/scouts
troop b:5k,t:5k
troop wo:10k,w:10k,s:10k,p:10k,sw:10k,a:10k,t:10k,c:10k,cata:10k,b:10k
troop a:100k,s:100k

fortification ab:5000`;

// Lord02 (a2): the build lines every one of its cities carries.
const A2_BUILD = `build fh:1
build th:10,w:10,c:10:1,b:10:1,a:10:1,r:10:1,be:10:1,rs:10:1
build f:10:37`;

t('the live goals still parse clean, and leave free finishes on', () => {
  for (const text of [A1, `config comfort:1,hero:1,troopsusepopmax:1,npc:5\n${A2_BUILD}`]) {
    const p = parseGoals(text);
    assert.deepStrictEqual(p.errors, []);
    assert.strictEqual(p.config.freespeedup, undefined, 'on by default');
  }
});

t('config freespeedup:0 and :1 are known keys', () => {
  assert.deepStrictEqual(parseGoals('config freespeedup:0').errors, []);
  assert.strictEqual(parseGoals('config freespeedup:0').config.freespeedup, 0);
  assert.strictEqual(parseGoals('config troop:1,freespeedup:1').config.freespeedup, 1);
  assert.match(parseGoals('config freespeedups:0').errors[0].error, /unknown config key "freespeedups"/);
});

t('the goals editor shows a freespeedup line as working (blue), not "does nothing yet"', () => {
  const p = parseGoals('config freespeedup:0\nconfig comfort:1,freespeedup:1');
  assert.deepStrictEqual(p.lines.map((l) => [l.status, l.msg]), [['ok', null], ['ok', null]]);
  assert.ok(!('freespeedup' in NOT_IMPLEMENTED.config));
});

// Lord22's fortification ab:5000 comes ahead of every build line: without
// Walls the first order is new Walls (NEAT build semantics). These fixtures
// have that goal met (Walls standing, 5,000 abatis built), so the build line's
// farms are what the builder takes on next.
function lord22(buildings = []) {
  const w = world([standingBean(TOWN_HALL, -1, 1), standingBean(WALLS, -2, 1), ...buildings]);
  w.home.fortification = { abatis: 5000 };
  return w;
}

t('Lord22 without Walls: the first Walls come first, and they are never free', async () => {
  const w = world([standingBean(TOWN_HALL, -1, 1)]);
  const e = engine(w, A1);
  const r = await e.focus(w.home);
  assert.deepStrictEqual(w.server.cmds(/castle\.newBuilding/).map((s) => [s.data.positionId, s.data.buildingType]), [[-2, WALLS]]);
  assert.deepStrictEqual(w.server.speedUps(), [], 'Walls 1 take 30 minutes');
  assert.ok(!r.acted.some((a) => /free finish/.test(a)), r.acted.join(' | '));
});

t('Lord22: the farm going up and the farm the slice starts are both finished free', async () => {
  const w = lord22();
  w.home.buildings.push(liveBean(w.g, FARM, 1001, 0));         // a new farm going up
  const e = engine(w, A1);
  const r = await e.focus(w.home);
  assert.deepStrictEqual(w.server.speedUps(), [[1001, 'free.speed'], [1002, 'free.speed']],
    `the farm underway, then the one this slice started: ${r.acted.join(' | ')}`);
  assert.deepStrictEqual(w.server.cmds(/castle\.newBuilding/).map((s) => [s.data.positionId, s.data.buildingType]), [[1002, FARM]]);
});

t('Lord22: a farm\'s first four levels are free, its fifth is not', async () => {
  // Every open plot farmed, so no new farm comes first; upgrades go lowest
  // level first, so the one farm at L1 is next every slice until it passes L5.
  // Since Step 11 a Town Hall that opens fewer plots than the 37 farms goes up
  // first, so here it opens all 37 (L9).
  const w = lord22([standingBean(FARM, 1001, 1)]);
  w.home.buildings.find((b) => b.typeId === TOWN_HALL).level = 9;
  for (let pos = 1002; pos <= 1037; pos++) w.home.buildings.push(standingBean(FARM, pos, 5));
  const e = engine(w, A1);
  for (let slice = 0; slice < 4; slice++) await e.focus(w.home);
  const ups = w.server.cmds(/castle\.(upgradeBuilding|speedUpBuildCommand)/).map((s) => [s.cmd.slice(7), s.data.positionId]);
  assert.deepStrictEqual(ups.slice(0, 6), [['upgradeBuilding', 1001], ['speedUpBuildCommand', 1001],
    ['upgradeBuilding', 1001], ['speedUpBuildCommand', 1001], ['upgradeBuilding', 1001], ['speedUpBuildCommand', 1001]]);
  assert.strictEqual(w.home.buildings.find((b) => b.positionId === 1001).level, 4, 'L1 to L4 in three slices');
  assert.deepStrictEqual(ups.slice(6), [['upgradeBuilding', 1001]], 'L4->L5 (480 s) runs its time');
});

t('Lord02: the new Feasting Hall (300 s) is finished free; the Town Hall and Walls never are', async () => {
  const w = world([standingBean(TOWN_HALL, -1, 1), standingBean(WALLS, -2, 1)]);
  const e = engine(w, `config hero:0\n${A2_BUILD}`);
  await e.focus(w.home);
  const fh = w.server.cmds(/castle\.newBuilding/)[0];
  assert.strictEqual(fh.data.buildingType, FEASTING_HALL, 'the first line of the goals comes first');
  assert.deepStrictEqual(w.server.speedUps(), [[fh.data.positionId, 'free.speed']]);
  const th = plan([bean(TOWN_HALL, -1, 1, { left: 100 }), bean(WALLS, -2, 1, { left: 100 })]);
  assert.strictEqual(th.finishes.length, 0);
});

// ---------------------------------------------------------------------------

(async () => {
  let passed = 0, failed = 0;
  for (const [name, f] of tests) {
    if (!f) { console.log('\n' + name + '\n'); continue; }
    try { await f(); console.log('  ok    ' + name); passed++; }
    catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  try { fs.rmSync(path.dirname(process.env.EVONY_DB), { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
})();
