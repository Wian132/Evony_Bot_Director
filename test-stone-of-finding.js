'use strict';
// The Stone of Finding, against a fake server — no network. It runs on the real
// Game (hero pushes included) and the real script parser and runner.
const assert = require('assert');
const { EvonyClient } = require('./evony');
const { Game } = require('./game');
const SF = require('./stone-of-finding');
const script = require('./script');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);

const STONE = SF.ITEM_ID;
const lost = (id, name, level = 40, at = '2026.09.13 10.15.00') =>
  ({ id: String(id), name, level, power: 60, management: 90, stratagem: 30, disppeartime: at });

class FakeServer {
  constructor({ items, lostList }) {
    this.items = { ...items };
    this.lost = lostList.slice();
    this.sent = [];
    this.listReply = null;     // a reply to give every list read instead
    this.refuse = null;        // a reply to give every restore instead
    this.okCode = 2;           // what ss71 answered a restore that worked
    this.push = 'after';       // the hero's push comes 'after' the reply, 'before' it, or 'none'
    this.nextHeroId = 900;
  }

  handle(client, cmd, data) {
    this.sent.push({ cmd, data });
    const emit = (name, d) => client.emit('cmd', name, d, { cmd: name, data: d });
    const reply = (d) => setImmediate(() => emit(cmd, d));

    if (cmd === 'hero.GetDisappearHeros') return reply(this.listReply || { ok: 1, heros: this.lost });
    if (cmd === 'hero.RecoverDisappearHero') {
      if (this.refuse) return reply(this.refuse);
      const h = this.lost.find((x) => x.id === data.id);
      if (!h || !this.items[STONE]) return reply({ ok: -44, errorMsg: 'no such hero' });
      this.lost = this.lost.filter((x) => x !== h);
      this.items[STONE] -= 1;
      // a new id, as the restored hero is a new HeroBean
      const hero = { id: this.nextHeroId++, name: h.name, level: h.level, power: h.power, management: h.management, stratagem: h.stratagem, status: 0 };
      const pushes = () => {
        emit('server.ItemUpdate', { items: [{ id: STONE, count: this.items[STONE] }] });
        emit('server.HeroUpdate', { castleId: data.castleid, updateType: 0, hero });
      };
      if (this.push === 'before') setImmediate(pushes);
      reply({ ok: this.okCode, errorMsg: `${h.name} has been restored successfully, please check your feasting hall to confirm.` });
      if (this.push === 'after') setTimeout(pushes, 5);
      return;
    }
    // Firing sends the hero's delete push and puts it on the stone's list.
    if (cmd === 'hero.fireHero') {
      reply({ ok: 1 });
      setTimeout(() => {
        emit('server.HeroUpdate', { castleId: data.castleId, updateType: 1, hero: { id: data.heroId, name: 'Fired' } });
        this.lost.push(lost(5000 + data.heroId, 'Fired', 70));
      }, 5);
      return;
    }
    return reply({ ok: 1 });
  }

  restores() { return this.sent.filter((s) => s.cmd === 'hero.RecoverDisappearHero'); }
  count(cmd) { return this.sent.filter((s) => s.cmd === cmd).length; }
}

class FakeClient extends EvonyClient {
  constructor(server) { super(); this.server = server; this.sock = { destroyed: false }; }
  send(cmd, data) { if (this.sock.destroyed) throw new Error('socket closed'); this.server.handle(this, cmd, data); }
  close() { this.sock.destroyed = true; }
}

const city = (id, name, heros = [], hallLevel = 10) => ({
  id, name, fieldId: id * 1000, heros,
  buildings: [{ typeId: 27, positionId: 3, level: hallLevel }],
});

function world({ items = { [STONE]: 3 }, lostList = [lost(11, 'Aldric'), lost(12, 'Brunhild', 55)], cities } = {}) {
  const server = new FakeServer({ items, lostList });
  const g = new Game();
  g.c = new FakeClient(server);
  g.castles = cities || [city(1, 'Home'), city(2, 'Second City')];
  g.player = { items: Object.entries(items).map(([id, count]) => ({ id, count })) };
  // Game.connect() wires these, and it never runs here.
  g.c.on('cmd', (cmd, d) => {
    if (cmd === 'server.HeroUpdate') g.applyHeroUpdate(d);
    if (cmd === 'server.ItemUpdate' && g.player.items) for (const it of d.items) { const x = g.player.items.find((i) => i.id === it.id); if (x) x.count = it.count; }
  });
  return { server, g };
}

async function sf(w, line, opts = {}) {
  const out = [];
  const ok = await SF.run(w.g, script.parseLine(line), { log: (m) => out.push(m), waitMs: 200, ...opts });
  return { ok, out, text: out.join('\n') };
}

const names = (c) => (c.heros || []).map((h) => h.name);
const held = (g) => g.player.items.find((i) => i.id === STONE).count;

// ---------------------------------------------------------------------------

section('what each line means');

t('recover takes a name, spaces allowed, or an id', () => {
  assert.deepStrictEqual(script.parseLine('recover Aldric'), { cmd: 'recover', hero: 'Aldric', to: null });
  assert.strictEqual(script.parseLine('recover Sir Aldric the Bold').hero, 'Sir Aldric the Bold');
  assert.strictEqual(script.parseLine('recover 12').hero, '12');
});

t('to <city> names the city it comes back to, names with spaces included', () => {
  const a = script.parseLine('recover Aldric to Second City');
  assert.deepStrictEqual([a.hero, a.to], ['Aldric', 'Second City']);
  assert.strictEqual(script.parseLine('recover Sir Bob TO Home').hero, 'Sir Bob');
});

t('a script with a bad recover line is refused before anything runs', () => {
  const errs = (src) => script.parse(src).filter((x) => x.cmd === 'error').map((x) => x.error);
  assert.match(errs('recover')[0], /usage {2}recover <hero name or id>/);
  assert.match(errs('recover to Home')[0], /usage/);
  assert.match(errs('recover Aldric to')[0], /"to" needs a city name/);
});

t('useitem on the stone says which command spends it instead', () => {
  assert.throws(() => script.parseLine('useitem ' + STONE), /spent by {2}recover <hero> {2}— run {2}lostheroes/);
  assert.strictEqual(script.parseLine('useitem player.box.1').cmd, 'useitem', 'other items are untouched');
});

section('lostheroes');

t('lists every lost hero with its level, base attributes, when it was lost and its id, and the stones held', async () => {
  const w = world();
  const r = await sf(w, 'lostheroes');
  assert.ok(r.ok);
  assert.match(r.text, /3 Stones of Finding held/);
  assert.match(r.text, /Aldric +L40 +base atk +60 +pol +90 +int +30 +lost 2026\.09\.13 10\.15\.00 +id 11/);
  assert.match(r.text, /Brunhild +L55 .* id 12/);
  assert.match(r.text, /recover <name or id> \[to <city>\]/);
  assert.deepStrictEqual(w.server.sent.map((s) => [s.cmd, s.data]), [['hero.GetDisappearHeros', {}]]);
});

t('an epoch dismissal time is shown on the server clock', () => {
  const g = { serverTzOffsetMs: -5 * 3600000 };
  assert.strictEqual(SF.when(g, String(Date.UTC(2026, 8, 13, 15, 4))), '2026-09-13 10:04');
  assert.strictEqual(SF.when(g, String(Date.UTC(2026, 8, 13, 15, 4) / 1000)), '2026-09-13 10:04');
  assert.strictEqual(SF.when(g, undefined), '?');
});

t('an empty list says so', async () => {
  assert.match((await sf(world({ lostList: [] }), 'lostheroes')).text, /no lost heroes to restore/);
});

t('a refused read is reported, never shown as an empty list', async () => {
  const w = world();
  w.server.listReply = { ok: -888, errorMsg: 'server busy' };
  const r = await sf(w, 'lostheroes');
  assert.strictEqual(r.ok, false);
  assert.match(r.text, /could not read the lost heroes \(server busy\)/);
  assert.doesNotMatch(r.text, /no lost heroes/);
});

section('recover');

t('by name: sends the list id as a string, lowercase keys, into the open city, and the hero is back', async () => {
  const w = world();
  const r = await sf(w, 'recover Aldric');
  assert.ok(r.ok, r.text);
  assert.deepStrictEqual(w.server.restores().map((s) => s.data), [{ castleid: 1, id: '11' }]);
  assert.deepStrictEqual(names(w.g.castle('Home')), ['Aldric']);
  assert.match(r.text, /Stone of Finding: restore Aldric L40 \(lost 2026\.09\.13 10\.15\.00, id 11\) into Home, 3 Stones of Finding held/);
  assert.match(r.text, /-> ok — Aldric L40 is back in Home, 2 Stones of Finding left/);
  assert.strictEqual(held(w.g), 2);
});

t('ok 2 with "restored successfully" is the server saying yes, and so is ok 1', async () => {
  const w = world();
  const r = await sf(w, 'recover Aldric');
  assert.doesNotMatch(r.text, /FAILED/, 'ss71 answers a restore that worked with ok 2');
  assert.ok(r.ok);
  w.server.okCode = 1;
  assert.ok((await sf(w, 'recover Brunhild')).ok);
});

t('by id, and by name in any case', async () => {
  const w = world();
  await sf(w, 'recover 12');
  await sf(w, 'recover aldric');
  assert.deepStrictEqual(w.server.restores().map((s) => s.data.id), ['12', '11']);
  assert.deepStrictEqual(names(w.g.castle('Home')).sort(), ['Aldric', 'Brunhild']);
});

t('to <city> restores into that city, not the open tab', async () => {
  const w = world();
  await sf(w, 'recover Brunhild to Second City', { castle: 'Home' });
  assert.deepStrictEqual(w.server.restores().map((s) => s.data), [{ castleid: 2, id: '12' }]);
  assert.deepStrictEqual(names(w.g.castle('Second City')), ['Brunhild']);
  assert.deepStrictEqual(names(w.g.castle('Home')), []);
});

t('with no stone held nothing is sent at all', async () => {
  const w = world({ items: { [STONE]: 0 } });
  const r = await sf(w, 'recover Aldric');
  assert.strictEqual(r.ok, false);
  assert.match(r.text, /no Stone of Finding in the inventory \(player\.item\.stoneoffinding\) — nothing sent/);
  assert.strictEqual(w.server.sent.length, 0);
});

t('an inventory that was never read leaves the stone count to the server', async () => {
  const w = world();
  w.g.player.items = undefined;
  const r = await sf(w, 'recover Aldric');
  assert.ok(r.ok, r.text);
  assert.match(r.text, /into Home$/m);
});

t('a hero not on the list is never sent, and the list is named', async () => {
  const w = world();
  const r = await sf(w, 'recover Zed');
  assert.strictEqual(r.ok, false);
  assert.match(r.text, /no lost hero called Zed — nothing sent/);
  assert.match(r.text, /the stone can restore: Aldric \(id 11\), Brunhild \(id 12\)/);
  assert.strictEqual(w.server.restores().length, 0);
});

t('two heroes of one name are not guessed between', async () => {
  const w = world({ lostList: [lost(21, 'Twin', 30), lost(22, 'Twin', 80)] });
  const r = await sf(w, 'recover twin');
  assert.match(r.text, /2 lost heroes are called twin — recover one by its id — nothing sent/);
  assert.match(r.text, /Twin +L30 .* id 21\n.*Twin +L80 .* id 22/);
  assert.strictEqual(w.server.restores().length, 0);
  assert.ok((await sf(w, 'recover 22')).ok);
  assert.deepStrictEqual(w.server.restores().map((s) => s.data.id), ['22']);
});

t('a dry run reads the list but restores nothing', async () => {
  const w = world();
  const r = await sf(w, 'recover Aldric', { dryRun: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.text, /restore Aldric .*\n.*\[dry run\] not sent/);
  assert.strictEqual(w.server.count('hero.GetDisappearHeros'), 1);
  assert.strictEqual(w.server.restores().length, 0);
});

t('a refused list read sends no restore', async () => {
  const w = world();
  w.server.listReply = { ok: -1 };
  assert.match((await sf(w, 'recover Aldric')).text, /could not read the lost heroes \(refused \(ok=-1\)\) — nothing sent/);
  assert.strictEqual(w.server.restores().length, 0);
});

t('a refusal is reported with the server\'s reason, and a full Feasting Hall is named', async () => {
  const w = world({ cities: [city(1, 'Home', [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], 2)] });
  w.server.refuse = { ok: -1, errorMsg: 'no room' };
  const r = await sf(w, 'recover Aldric');
  assert.strictEqual(r.ok, false);
  assert.match(r.text, /-> FAILED \(ok=-1\) - no room — Home's Feasting Hall looks full \(2\/2\); make room, or restore into another city with {2}recover Aldric to <city>/);
  assert.deepStrictEqual(names(w.g.castle('Home')), ['A', 'B']);
  const w2 = world();
  w2.server.refuse = { ok: -44, errorMsg: 'no item' };
  assert.doesNotMatch((await sf(w2, 'recover Aldric')).text, /Feasting Hall/, 'a hall with room is not blamed');
});

t('the hero is caught even when its push beats the reply', async () => {
  const w = world();
  w.server.push = 'before';
  assert.match((await sf(w, 'recover Aldric')).text, /Aldric L40 is back in Home/);
});

t('an accepted restore with no push says so rather than guessing', async () => {
  const w = world();
  w.server.push = 'none';
  const r = await sf(w, 'recover Aldric');
  assert.ok(r.ok);
  assert.match(r.text, /-> ok — the server accepted it \(Aldric has been restored successfully, please check your feasting hall to confirm\.\), but Aldric has not shown up in Home yet/);
});

t('a script runs it in the open city tab and counts only the restore', async () => {
  const w = world();
  const out = [];
  const n = await script.run(w.g, script.parse('lostheroes\nrecover Aldric'), (m) => out.push(m), { castle: 'Second City' });
  assert.strictEqual(n, 1, out.join('\n'));
  assert.strictEqual(w.server.restores()[0].data.castleid, 2);
});

section('hero pushes');

t('a dismissed hero leaves the roster, shows on the stone\'s list, and comes back', async () => {
  const w = world({ lostList: [], cities: [city(1, 'Home', [{ id: 7, name: 'Fired', level: 70 }, { id: 8, name: 'Kept' }])] });
  await w.g.fireHero(1, 7);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepStrictEqual(names(w.g.castle('Home')), ['Kept'], 'the delete push removes it');
  assert.match((await sf(w, 'lostheroes')).text, /Fired +L70 .* id 5007/);
  assert.ok((await sf(w, 'recover Fired')).ok);
  assert.deepStrictEqual(names(w.g.castle('Home')), ['Kept', 'Fired']);
});

// The ghost seen live: Lord02's hero was held prisoner in Lord22's city, the
// stone brought it home, and Lord22's console turned the server's delete into
// an update, so it kept listing the hero as Idle ("Hero doesn't exist" on Promote).
t('a prisoner the stone took back leaves the captor\'s roster, not turns Idle there', () => {
  const g = new Game();
  g.castles = [city(1, 'Captor', [{ id: 1, name: 'Noel', status: 1 }])];
  g.applyHeroUpdate({ castleId: 1, updateType: 0, hero: { id: 150304224, name: 'Att66A391', status: 4 } });
  assert.deepStrictEqual(names(g.castle('Captor')), ['Noel', 'Att66A391']);
  g.applyHeroUpdate({ castleId: 1, updateType: 1, hero: { id: 150304224, name: 'Att66A391', status: 0 } });
  assert.deepStrictEqual(names(g.castle('Captor')), ['Noel']);
});

t('an update replaces the hero in place and an add never duplicates it', () => {
  const g = new Game();
  g.castles = [city(1, 'Home', [{ id: 7, name: 'A', level: 1 }])];
  g.applyHeroUpdate({ castleId: 1, updateType: 2, hero: { id: 7, name: 'A', level: 2 } });
  g.applyHeroUpdate({ castleId: 1, updateType: 0, hero: { id: 7, name: 'A', level: 3 } });
  g.applyHeroUpdate({ castleId: 1, hero: { id: 8, name: 'B' } });
  assert.deepStrictEqual(g.castle('Home').heros.map((h) => [h.id, h.level]), [[7, 3], [8, undefined]]);
  g.applyHeroUpdate({ castleId: 1, updateType: 1, hero: { id: 99 } });
  g.applyHeroUpdate({ castleId: 2, updateType: 1, hero: { id: 7 } });
  assert.strictEqual(g.castle('Home').heros.length, 2, 'a delete for an unknown hero or city changes nothing');
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
  process.exit(fail ? 1 : 0);
})();
