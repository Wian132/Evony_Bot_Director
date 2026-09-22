'use strict';
// A march that cannot go YET waits for the city instead of being refused
// (script-cmd-deploy.js waitReady / marchShort). Offline: the Game is real, its
// network calls are stubbed, and the "server" takes troops and resources on a
// send and hands them back when a march comes home — which is what the wait is
// waiting for.
//
// The case this was built for: `transport 7 t:100k f:999m` under `repeat 100`
// used to fail and iterate at the speed of the server's no, a hundred times in
// a second, without one transport going.
const assert = require('assert');
const C = require('./constants');
const { Game } = require('./game');
const script = require('./script');
const D = require('./script-cmd-deploy');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const F = (x, y) => C.coordsToFieldId(x, y);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits run at test speed; nothing here is allowed to wait for ever.
Object.assign(D.WAIT, { pollMs: 5, sayEveryMs: 5000, defaultMs: 2000 });

const hero = (id, name, o = {}) => ({ id, name, status: 0, level: 10, power: 50, management: 20, stratagem: 20, loyalty: 100, ...o });

// One account, two cities. `rally` is the Rally Spot's level (0 = no building
// list at all, which the code must leave to the server).
function world({ troop = {}, resource = {}, rally = 10, heros = null } = {}) {
  const g = new Game();
  g.serverOffset = 0;
  g.player = { playerInfo: { userName: 'Me' }, selfArmys: [], buffs: [], items: [] };
  const buildings = rally === null ? undefined : [{ typeId: 29, positionId: 5, name: 'Rally Spot', level: rally, status: 1 }];
  g.castles = [
    { id: 1,
      name: 'Home',
      fieldId: F(100, 100),
      buffs: [],
      buildings,
      // the server sends counts as strings (TroopStrBean)
      troop: Object.fromEntries(Object.entries(troop).map(([k, v]) => [k, String(v)])),
      resource: { food: { amount: resource.food || 0 }, wood: { amount: resource.wood || 0 },
        stone: { amount: resource.stone || 0 }, iron: { amount: resource.iron || 0 }, gold: resource.gold || 0 },
      heros: heros || [hero(11, 'Ken'), hero(12, 'Away', { status: 3 })] },
    { id: 2, name: 'Fla', fieldId: F(120, 100), buffs: [], heros: [hero(21, 'Dee')] },
  ];
  const log = [];
  let nextArmy = 1000;
  g.troopParams = async () => ({ marchSkill: 0, driveSkill: 0, loadSkill: 0, relief: 0 });
  g.fieldOwner = async () => ({ userName: 'Other', allianceName: 'X' });
  const home = g.castles[0];
  // The server's own book-keeping: a march takes its troops and its load out of
  // the city at once, and both are pushed back to us (session.js applies
  // server.TroopUpdate / server.ResourceUpdate the same way).
  g.newArmy = async (castleId, bean) => {
    log.push({ cmd: 'newArmy', castleId, bean });
    const castle = g.castles.find((c) => c.id === castleId);
    for (const [k, v] of Object.entries(bean.troops || {})) {
      const had = Number(castle.troop[k] || 0);
      if (had < v) return { ok: -1, errorMsg: `not enough ${k}` };
      castle.troop[k] = String(had - v);
    }
    for (const [k, v] of Object.entries(bean.resources || {})) {
      if (!v) continue;
      const bank = castle.resource[k];
      const had = Number(bank && typeof bank === 'object' ? bank.amount : bank || 0);
      if (had < v) return { ok: -1, errorMsg: `not enough ${k}` };
      if (bank && typeof bank === 'object') bank.amount = had - v; else castle.resource[k] = had - v;
    }
    const h = bean.heroId !== undefined ? castle.heros.find((x) => x.id === bean.heroId) : null;
    if (h) h.status = 3;
    g.player.selfArmys = [...g.player.selfArmys, { armyId: nextArmy++, direction: 1, missionType: bean.missionType,
      targetFieldId: bean.targetPoint, startFieldId: castle.fieldId, startTime: g.now(), troop: bean.troops }];
    return { ok: 1 };
  };
  // A march comes home: its slot, its troops and its hero are the city's again.
  const comeHome = (n = 1) => {
    for (let i = 0; i < n && g.player.selfArmys.length; i++) {
      const a = g.player.selfArmys.shift();
      for (const [k, v] of Object.entries(a.troop || {})) home.troop[k] = String(Number(home.troop[k] || 0) + v);
    }
    g.player.selfArmys = [...g.player.selfArmys];
  };
  const freeHero = (id) => { const h = home.heros.find((x) => x.id === id); if (h) h.status = 0; };
  const give = (k, n) => { const b = home.resource[k]; if (b && typeof b === 'object') b.amount += n; else home.resource[k] = Number(home.resource[k] || 0) + n; };
  const troops = (k, n) => { home.troop[k] = String(n); };
  const sends = () => log.filter((x) => x.cmd === 'newArmy');
  return { g, log, sends, home, comeHome, freeHero, give, troops };
}

async function runIn(w, src, opts = {}, sink = null) {
  const out = sink || [];
  const view = script.parse(src);
  const errs = view.filter((a) => a.cmd === 'error');
  if (errs.length) throw new Error('parse: ' + errs.map((e) => `line ${e.line}: ${e.error}`).join('; '));
  const done = await script.run(w.g, view, (m) => out.push(m), { castle: 'Home', repeatGapMs: 0, ...opts });
  return { done, out, text: out.join('\n') };
}
// Start a script and keep hold of it, so the world can change while it waits.
// The output goes into r.out AS IT HAPPENS — a test watches that to know the
// run has reached its wait.
function start(w, src, opts = {}) {
  const r = { out: [] };
  r.done = runIn(w, src, opts, r.out);
  return r;
}
const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await sleep(5); }
};

// ---------------------------------------------------------------------------
section('what a march waits for');

t('transport waits for its transporters and goes when they are home', async () => {
  const w = world({ troop: { carriage: 1000 }, resource: { food: 999000000 } });
  const r = start(w, 'transport Fla t:100000 f:1000000');
  await waitFor(() => /not yet:/.test(r.out.join('\n')));
  assert.strictEqual(w.sends().length, 0, 'nothing is sent while the troops are out');
  assert.match(r.out.join('\n'), /1,000 of 100,000 Transporter at home/);
  w.troops('carriage', 100000);
  await r.done;
  assert.strictEqual(w.sends().length, 1, 'it went once the transporters were there');
  assert.match(r.out.join('\n'), /ready after/);
});

t('the march waits for a free rally slot', async () => {
  const w = world({ troop: { militia: 500 }, rally: 2 });
  // two marches out already: every slot of a level-2 Rally Spot is busy
  w.g.player.selfArmys = [
    { armyId: 1, direction: 1, missionType: C.MISSION.attack, startFieldId: F(100, 100), targetFieldId: F(111, 222), startTime: w.g.now() },
    { armyId: 2, direction: 2, missionType: C.MISSION.attack, startFieldId: F(100, 100), targetFieldId: F(111, 222), startTime: w.g.now() },
  ];
  const r = start(w, 'attack 111,222 none w:100');
  await waitFor(() => /not yet:/.test(r.out.join('\n')));
  assert.match(r.out.join('\n'), /rally spot L2: 2\/2 busy/);
  assert.strictEqual(w.sends().length, 0);
  w.comeHome(1);
  await r.done;
  assert.strictEqual(w.sends().length, 1);
});

t('a city whose building list is unknown is never held back', async () => {
  const w = world({ troop: { militia: 500 }, rally: null });
  w.g.player.selfArmys = Array.from({ length: 20 }, (_, i) => ({ armyId: i, direction: 1, missionType: C.MISSION.attack,
    startFieldId: F(100, 100), targetFieldId: F(111, 222), startTime: w.g.now() }));
  const r = await runIn(w, 'attack 111,222 none w:100');
  assert.strictEqual(w.sends().length, 1, r.text);
});

t('the march waits for the resources it carries', async () => {
  const w = world({ troop: { carriage: 1000 }, resource: { food: 5000 } });
  const r = start(w, 'transport Fla t:1000 f:1000000');
  await waitFor(() => /not yet:/.test(r.out.join('\n')));
  assert.match(r.out.join('\n'), /food 5,000 of 1,000,000/);
  w.give('food', 2000000);
  await r.done;
  assert.strictEqual(w.sends().length, 1);
});

t('the march waits for a hero that is out, and takes it when it is home', async () => {
  const w = world({ troop: { militia: 500 }, heros: [hero(12, 'Away', { status: 3 })] });
  const r = start(w, 'attack 111,222 Away w:100');
  await waitFor(() => /not yet:/.test(r.out.join('\n')));
  assert.match(r.out.join('\n'), /no idle hero in Home matches Away/);
  w.freeHero(12);
  await r.done;
  assert.strictEqual(w.sends().length, 1);
  assert.strictEqual(w.sends()[0].bean.heroId, 12);
});

t('it says every reason at once, not one at a time', async () => {
  const w = world({ troop: { carriage: 10 }, resource: { food: 1 }, heros: [hero(12, 'Away', { status: 3 })] });
  const r = await runIn(w, 'transport Fla Away t:1000 f:5000 /wait=0:01');
  const line = (r.out.find((l) => /not yet:/.test(l)) || '');
  assert.match(line, /10 of 1,000 Transporter at home/);
  assert.match(line, /food 1 of 5,000/);
  assert.match(line, /no idle hero in Home matches Away/);
});

// ---------------------------------------------------------------------------
section('what it does NOT wait for');

t('a hero the city does not have at all still fails at once', async () => {
  const w = world({ troop: { militia: 500 } });
  const started = Date.now();
  const r = await runIn(w, 'attack 111,222 bob w:100');
  assert.ok(Date.now() - started < 1500, 'it did not sit and wait');
  assert.match(r.text, /FAILED: no hero in Home matches bob/);
  assert.strictEqual(w.sends().length, 0);
});

t('a march over the Rally Spot troop limit is not waited on', async () => {
  // The troops ARE at home, so there is nothing to wait for: the line goes
  // straight to the server, whose own guard (game.newArmy, rally.js
  // marchTroopLimit) refuses more than 10,000 per Rally Spot level.
  const w = world({ troop: { militia: 900000 }, rally: 1 });
  const started = Date.now();
  const r = await runIn(w, 'attack 111,222 none w:500000');
  assert.ok(Date.now() - started < 1500, r.text);
  assert.ok(!/not yet:/.test(r.text), 'nothing was waited for: ' + r.text);
  assert.strictEqual(w.sends().length, 1);
});

t('a load bigger than the troops can carry fails at once, without waiting', async () => {
  const w = world({ troop: { carriage: 1 }, resource: { food: 999000000 } });
  const started = Date.now();
  const r = await runIn(w, 'transport Fla t:1 f:9000000');
  assert.ok(Date.now() - started < 1500, r.text);
  assert.match(r.text, /room for/);
  assert.strictEqual(w.sends().length, 0);
});

// ---------------------------------------------------------------------------
section('the switches');

t('/nowait sends at once and lets the server refuse it', async () => {
  const w = world({ troop: { carriage: 10 } });
  const started = Date.now();
  const r = await runIn(w, 'transport Fla t:1000 /nowait');
  assert.ok(Date.now() - started < 1500, 'it did not wait');
  assert.strictEqual(w.sends().length, 1, 'it was sent anyway');
  assert.match(r.text, /not yet: 10 of 1,000 Transporter at home — \/nowait/);
  assert.match(r.text, /FAILED \(ok=-1\)/);
});

t('/wait= gives up after its time and says how long it waited', async () => {
  const w = world({ troop: { carriage: 10 } });
  const started = Date.now();
  const r = await runIn(w, 'transport Fla t:1000 /wait=1');
  const took = Date.now() - started;
  assert.ok(took >= 900 && took < 3000, 'waited about a second, not ' + took);
  assert.match(r.text, /FAILED: still not ready after .* — 10 of 1,000 Transporter at home/);
  assert.strictEqual(w.sends().length, 0, 'it is never sent after giving up');
});

t('/wait=0 is /nowait', async () => {
  assert.strictEqual(D.parseMarch('transport', 'transport Fla t:1 /wait=0', 'transport Fla t:1 /wait=0'.split(' ')).nowait, true);
  const a = D.parseMarch('transport', 'transport Fla t:1 /wait=2:30', 'transport Fla t:1 /wait=2:30'.split(' '));
  assert.strictEqual(a.waitMs, 150000);
});

t('a dry run never waits', async () => {
  const w = world({ troop: { carriage: 10 } });
  const started = Date.now();
  const r = await runIn(w, 'transport Fla t:1000', { dryRun: true });
  assert.ok(Date.now() - started < 1500, 'a dry run is not held up');
  assert.match(r.text, /\[dry run\] not sent/);
});

// ---------------------------------------------------------------------------
section('running one line over and over');

t('repeat sends every wave as the troops come home — none refused', async () => {
  const w = world({ troop: { carriage: 1000 }, resource: { food: 100000 }, rally: 10 });
  const r = start(w, 'transport Fla t:1000 f:10000\nrepeat 3');
  // each wave takes every transporter the city has; the next one waits for them
  for (let i = 0; i < 2; i++) {
    await waitFor(() => w.sends().length === i + 1);
    await waitFor(() => /not yet:/.test(r.out.slice(-6).join('\n')));
    w.comeHome(1);
  }
  await r.done;
  assert.strictEqual(w.sends().length, 3, r.out.join('\n'));
  assert.ok(!/FAILED/.test(r.out.join('\n')), 'no wave was refused: ' + r.out.join('\n'));
});

t('two sends in a row cannot spend the same troops twice', async () => {
  // The server's TroopUpdate can trail the reply, so the city's own count may
  // still show troops a march just took. The run's pending book covers that.
  const w = world({ troop: { carriage: 1000 }, resource: { food: 100000 } });
  const real = w.g.newArmy;
  w.g.newArmy = async (cid, bean) => {
    const troop = { ...w.home.troop }, armies = w.g.player.selfArmys;
    const r = await real(cid, bean);
    w.home.troop = troop;                  // the TroopUpdate has not come yet
    w.g.player.selfArmys = armies;         // nor has the army list: only the reply is in
    return r;
  };
  const r = await runIn(w, 'transport Fla t:600 f:1000\ntransport Fla t:600 f:1000 /wait=1');
  assert.strictEqual(w.sends().length, 1, 'the second one waited instead of spending the same 600 again');
  assert.match(r.text, /still not ready/);
});

t('the reason is said once, not on every look', async () => {
  const w = world({ troop: { carriage: 10 } });
  const r = await runIn(w, 'transport Fla t:1000 /wait=1');
  const said = r.out.filter((l) => /not yet:/.test(l)).length;
  assert.ok(said >= 1 && said <= 5, `said ${said} times in a second of waiting (pollMs 5)`);
});

t('Stop ends a wait, and the rest of the script does not run', async () => {
  const w = world({ troop: { carriage: 10 } });
  let stop = false;
  const r = start(w, 'transport Fla t:1000\necho "after"', { shouldStop: () => stop });
  await waitFor(() => /not yet:/.test(r.out.join('\n')));
  stop = true;
  await r.done;
  assert.ok(!/after/.test(r.out.join('\n')), 'the line after it never ran: ' + r.out.join('\n'));
  assert.strictEqual(w.sends().length, 0);
});

// ---------------------------------------------------------------------------
(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n + '\n'); continue; }
    try { await f(); console.log('  ok    ' + n); pass++; } catch (e) { console.log('  FAIL  ' + n + '\n        ' + String(e.message).split('\n').join('\n        ')); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
