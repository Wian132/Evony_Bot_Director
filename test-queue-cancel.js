'use strict';
// Cancelling barracks and Walls batches, against a fake server — no network.
// Runs the real Game, so what goes on the wire is what the console would send.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-qc-')), 't.db');
const { EvonyClient } = require('./evony');
const { Game } = require('./game');
const QC = require('./queue-cancel');
const script = require('./script');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);

const BALLISTA = 11, ARCHER = 7, ABATIS = 15, TRAP = 14;

class FakeServer {
  // troops: { castleId: { positionId: [[queueId, type, num], ...] } }, walls: { castleId: [...] }
  constructor({ troops = {}, walls = {} } = {}) {
    const rows = (list) => list.map(([queueId, type, num]) => ({ queueId, type, num, endTime: 0, costTime: 0 }));
    this.troops = Object.fromEntries(Object.entries(troops).map(([cid, bs]) =>
      [cid, Object.fromEntries(Object.entries(bs).map(([pos, list]) => [pos, rows(list)]))]));
    this.walls = Object.fromEntries(Object.entries(walls).map(([cid, list]) => [cid, rows(list)]));
    this.sent = [];
    this.refuse = new Map();        // queueId -> reply
    this.unreadable = false;
  }

  handle(client, cmd, data) {
    this.sent.push({ cmd, data });
    const reply = (d) => setImmediate(() => client.emit('cmd', cmd, d, { cmd, data: d }));
    const cid = data.castleId;
    if (cmd === 'troop.getProduceQueue') {
      if (this.unreadable) return reply({ ok: -1, errorMsg: 'busy' });
      return reply({ ok: 1, allProduceQueue: Object.entries(this.troops[cid] || {})
        .map(([pos, list]) => ({ positionId: Number(pos), allProduceQueue: list })) });
    }
    if (cmd === 'fortifications.getProduceQueue') {
      return reply({ ok: 1, allProduceQueue: [{ positionId: -2, allProduceQueue: this.walls[cid] || [] }] });
    }
    if (this.refuse.has(data.queueId)) return reply(this.refuse.get(data.queueId));
    if (cmd === 'troop.cancelTroopProduce') {
      const list = (this.troops[cid] || {})[data.positionId] || [];
      const i = list.findIndex((x) => x.queueId === data.queueId);
      if (i === -1) return reply({ ok: -1, errorMsg: 'no such queue' });
      list.splice(i, 1);
      return reply({ ok: 1 });
    }
    if (cmd === 'fortifications.cancelFortificationProduce') {
      const list = this.walls[cid] || [];
      const i = list.findIndex((x) => x.queueId === data.queueId);
      if (i === -1) return reply({ ok: -1, errorMsg: 'no such queue' });
      list.splice(i, 1);
      return reply({ ok: 1 });
    }
    return reply({ ok: 1 });
  }

  cancels() { return this.sent.filter((s) => /cancel/.test(s.cmd)); }
  left(cid, pos) { return (pos === undefined ? this.walls[cid] : this.troops[cid][pos]).map((x) => x.queueId); }
}

class FakeClient extends EvonyClient {
  constructor(server) { super(); this.server = server; this.sock = { destroyed: false }; }
  send(cmd, data) { this.server.handle(this, cmd, data); }
}

const city = (id, name, barrackPlots) => ({
  id, name, fieldId: id,
  buildings: barrackPlots.map((positionId) => ({ typeId: 2, positionId, level: 10 })),
});

// Home (1) has barracks on plots 4, 9 and 2 — the console numbers them by plot:
// 2 is barrack 0, 4 is barrack 1, 9 is barrack 2. Second (2) has one.
function world(over = {}) {
  const server = new FakeServer({
    troops: {
      1: { 4: [[41, BALLISTA, 4916], [42, BALLISTA, 4916], [43, ARCHER, 5000]], 9: [[91, ARCHER, 100]], 2: [] },
      2: { 5: [[51, ARCHER, 7]] },
    },
    walls: { 1: [[701, ABATIS, 1000], [702, TRAP, 500], [703, ABATIS, 250]] },
    ...over,
  });
  const g = new Game();
  g.c = new FakeClient(server);
  g.castles = [city(1, 'Home', [4, 9, 2]), city(2, 'Second', [5])];
  const session = {
    xcache: new Map([['1:queues', { at: Date.now(), data: {} }], ['2:queues', { at: Date.now(), data: {} }]]),
    userPaused: false,
    activeTroopStage: () => null,
    activeFortStage: () => null,
  };
  return { server, g, session };
}

async function run(w, line, opts = {}) {
  const out = [];
  const n = await QC.run(w.g, script.parseLine(line), { castle: 'Home', session: w.session, log: (m) => out.push(m), ...opts });
  return { n, out, text: out.join('\n') };
}

// ---------------------------------------------------------------------------

section('what each line means (NEAT wiki: CancelTroopQueues, CancelFortifications)');

t('canceltroopqueues and cancelfortifications cancel everything without a count', () => {
  assert.deepStrictEqual(script.parseLine('canceltroopqueues'), { cmd: 'cancelqueue', kind: 'troop', keep: 0 });
  assert.deepStrictEqual(script.parseLine('cancelfortifications'), { cmd: 'cancelqueue', kind: 'wall', keep: 0 });
});

t('a count is how many batches stay', () => {
  assert.strictEqual(script.parseLine('canceltroopqueues 2').keep, 2);
  assert.strictEqual(script.parseLine('cancelfortifications 1').keep, 1);
  assert.strictEqual(script.parseLine('CancelTroopQueues 3 // keep three').keep, 3, 'any case, comment dropped');
});

t('canceltroops, cancelwalls and clearwallqueue (the old wiki name) do the same', () => {
  assert.strictEqual(script.parseLine('canceltroops').kind, 'troop');
  assert.strictEqual(script.parseLine('cancelwalls 2').kind, 'wall');
  assert.strictEqual(script.parseLine('clearwallqueue').kind, 'wall');
});

t('anything but one whole number is refused before the script runs', () => {
  const errs = (src) => script.parse(src).filter((x) => x.cmd === 'error').map((x) => x.error);
  assert.match(errs('canceltroopqueues all')[0], /usage {2}canceltroopqueues \[n\].*each barrack/);
  assert.match(errs('cancelfortifications 1 2')[0], /usage {2}cancelfortifications \[n\].*Walls queue/);
  assert.match(errs('canceltroopqueues -1')[0], /usage/);
  assert.match(errs('canceltroopqueues 1.5')[0], /usage/);
});

section('canceltroopqueues');

t('with no count every batch in every barrack goes, on the wire as the client sends it', async () => {
  const w = world();
  const r = await run(w, 'canceltroopqueues');
  assert.strictEqual(r.n, 4, r.text);
  assert.deepStrictEqual(w.server.left(1, 4), []);
  assert.deepStrictEqual(w.server.left(1, 9), []);
  assert.deepStrictEqual(w.server.cancels()[0], { cmd: 'troop.cancelTroopProduce', data: { castleId: 1, positionId: 4, queueId: 43 } });
  assert.deepStrictEqual(w.server.left(2, 5), [51], 'the other city is untouched');
});

t('batches go from the back, so the one in training goes last', async () => {
  const w = world();
  await run(w, 'canceltroopqueues');
  const plot4 = w.server.cancels().filter((c) => c.data.positionId === 4).map((c) => c.data.queueId);
  assert.deepStrictEqual(plot4, [43, 42, 41]);
});

t('canceltroopqueues 1 leaves the first batch in each barrack', async () => {
  const w = world();
  const r = await run(w, 'canceltroopqueues 1');
  assert.strictEqual(r.n, 2, r.text);
  assert.deepStrictEqual(w.server.left(1, 4), [41]);
  assert.deepStrictEqual(w.server.left(1, 9), [91]);
  assert.match(r.text, /cancelling 2 of 4 troop batch\(es\), keeping 1 per barrack/);
});

t('the log names barracks the way the Barracks panel numbers them, and says what went', async () => {
  const w = world();
  const r = await run(w, 'canceltroopqueues 2');
  assert.match(r.text, /barrack 1: 5,000 Archer \(queue 43\) -> ok/);
  assert.match(r.text, /cancelled 1 of 1/);
});

t('nothing to cancel sends nothing and says so', async () => {
  const w = world();
  const r = await run(w, 'canceltroopqueues 5');
  assert.strictEqual(r.n, 0);
  assert.strictEqual(w.server.cancels().length, 0);
  assert.match(r.text, /nothing to cancel — Home has 4 troop batch\(es\) queued, keeping 5 per barrack/);
});

t('a dry run reads the queue and sends no cancel', async () => {
  const w = world();
  const r = await run(w, 'canceltroopqueues', { dryRun: true });
  assert.strictEqual(r.n, 0);
  assert.strictEqual(w.server.cancels().length, 0);
  assert.strictEqual((r.text.match(/\[dry run\] not sent/g) || []).length, 4, r.text);
  assert.ok(w.session.xcache.has('1:queues'), 'nothing changed, so the console keeps what it has');
});

t('a refused batch is reported with the server\'s reason and the rest still go', async () => {
  const w = world();
  w.server.refuse.set(42, { ok: -5, errorMsg: 'queue is locked' });
  const r = await run(w, 'canceltroopqueues');
  assert.strictEqual(r.n, 3);
  assert.match(r.text, /Ballista \(queue 42\) -> FAILED \(ok=-5\) - queue is locked/);
  assert.deepStrictEqual(w.server.left(1, 4), [42]);
  assert.match(r.text, /cancelled 3 of 4/);
});

t('an unreadable queue sends nothing', async () => {
  const w = world();
  w.server.unreadable = true;
  const r = await run(w, 'canceltroopqueues');
  assert.strictEqual(r.n, 0);
  assert.strictEqual(w.server.cancels().length, 0);
  assert.match(r.text, /barracks queue could not be read \(busy\) — nothing sent/);
});

t('afterwards the console reads the queues again instead of showing what is gone', async () => {
  const w = world();
  await run(w, 'canceltroopqueues');
  assert.ok(!w.session.xcache.has('1:queues'));
  assert.ok(w.session.xcache.has('2:queues'), 'only this city\'s');
});

t('a goal that is still short gets a note: the engine refills the queue', async () => {
  const w = world();
  w.session.activeTroopStage = () => ({ stageIndex: 1, stageCount: 2 });
  assert.match((await run(w, 'canceltroopqueues')).text, /note: this city's troop goal is still short, so the engine will queue more/);
  const w2 = world();
  w2.session.activeTroopStage = () => ({ stageIndex: 1, stageCount: 2 });
  w2.session.userPaused = true;
  assert.doesNotMatch((await run(w2, 'canceltroopqueues')).text, /note:/, 'not while the engine is paused');
  const w3 = world();
  w3.session.activeTroopStage = () => ({ done: true });
  assert.doesNotMatch((await run(w3, 'canceltroopqueues')).text, /note:/, 'nor once the goal is met');
});

section('cancelfortifications');

t('with no count the whole Walls queue goes, as {castleId, queueId}', async () => {
  const w = world();
  const r = await run(w, 'cancelfortifications');
  assert.strictEqual(r.n, 3, r.text);
  assert.deepStrictEqual(w.server.left(1), []);
  assert.deepStrictEqual(w.server.cancels().map((c) => c.data.queueId), [703, 702, 701]);
  assert.deepStrictEqual(w.server.cancels()[0], { cmd: 'fortifications.cancelFortificationProduce', data: { castleId: 1, queueId: 703 } });
});

t('cancelfortifications 2 leaves the first two batches', async () => {
  const w = world();
  const r = await run(w, 'cancelfortifications 2');
  assert.strictEqual(r.n, 1);
  assert.deepStrictEqual(w.server.left(1), [701, 702]);
  assert.match(r.text, /Walls: 250 Abatis \(queue 703\) -> ok/);
});

t('an empty Walls queue sends nothing', async () => {
  const w = world();
  const r = await run(w, 'cancelfortifications', { castle: 'Second' });
  assert.strictEqual(r.n, 0);
  assert.strictEqual(w.server.cancels().length, 0);
  assert.match(r.text, /nothing to cancel — Second has 0 fortification batch\(es\) queued/);
});

section('in a script');

t('it runs in the open city tab and counts as an action', async () => {
  const w = world();
  const out = [];
  const n = await script.run(w.g, script.parse('canceltroopqueues\ncancelfortifications 2'), (m) => out.push(m), { castle: 'Second', session: w.session });
  assert.strictEqual(n, 1, 'Second has troops to cancel and no Walls queue — ' + out.join('\n'));
  assert.deepStrictEqual(w.server.left(2, 5), []);
  assert.deepStrictEqual(w.server.left(1, 4), [41, 42, 43], 'Home is untouched');
});

section('the console\'s ✖ (cancelOne)');

t('cancels exactly the batch clicked', async () => {
  const w = world();
  const r = await QC.cancelOne(w.g, w.g.castle('Home'), 'troop', { positionId: 4, queueId: 42 }, { session: w.session });
  assert.deepStrictEqual([r.ok, r.error], [true, null]);
  assert.deepStrictEqual(w.server.left(1, 4), [41, 43]);
  assert.strictEqual(r.text, 'cancel 4,916 Ballista in barrack 1 (queue 42) -> ok');
  assert.ok(!w.session.xcache.has('1:queues'));
});

t('a Walls batch needs only its queueId', async () => {
  const w = world();
  const r = await QC.cancelOne(w.g, w.g.castle('Home'), 'wall', { queueId: 702 });
  assert.ok(r.ok);
  assert.strictEqual(r.text, 'cancel 500 Trap in the Walls (queue 702) -> ok');
  assert.deepStrictEqual(w.server.left(1), [701, 703]);
});

t('only a batch the city\'s queue holds right now is sent', async () => {
  const w = world();
  const home = w.g.castle('Home');
  await assert.rejects(QC.cancelOne(w.g, home, 'troop', { positionId: 4, queueId: 999 }), /no longer in the queue/);
  await assert.rejects(QC.cancelOne(w.g, home, 'troop', { positionId: 9, queueId: 42 }), /no longer in the queue/, 'another barrack\'s batch');
  await assert.rejects(QC.cancelOne(w.g, home, 'troop', { positionId: 5, queueId: 51 }), /no longer in the queue/, 'another city\'s batch');
  await assert.rejects(QC.cancelOne(w.g, home, 'wall', { queueId: 41 }), /no longer in the queue/, 'a barracks batch is not a Walls batch');
  await assert.rejects(QC.cancelOne(w.g, home, 'nonsense', { queueId: 41 }), /troop or wall/);
  assert.strictEqual(w.server.cancels().length, 0);
});

t('a refusal comes back with the server\'s reason', async () => {
  const w = world();
  w.server.refuse.set(701, { ok: -3, errorMsg: 'not enough time left' });
  const r = await QC.cancelOne(w.g, w.g.castle('Home'), 'wall', { queueId: 701 });
  assert.deepStrictEqual([r.ok, r.error], [false, 'not enough time left']);
  assert.match(r.text, /-> FAILED \(ok=-3\) - not enough time left/);
});

t('two clicks at once each get their own reply (the command waits in a lane)', async () => {
  const w = world();
  const home = w.g.castle('Home');
  w.server.refuse.set(41, { ok: -5, errorMsg: 'locked' });
  const [a, b] = await Promise.all([
    QC.cancelOne(w.g, home, 'troop', { positionId: 4, queueId: 41 }),
    QC.cancelOne(w.g, home, 'troop', { positionId: 4, queueId: 43 }),
  ]);
  assert.deepStrictEqual([a.ok, b.ok], [false, true], `${a.text}\n${b.text}`);
  assert.deepStrictEqual(w.server.left(1, 4), [41, 42]);
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
