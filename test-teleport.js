'use strict';
// Teleporting a city, against a fake server — no network. It runs on the real
// Game and the real Session wiring (map reads, CastleUpdate pushes, the city
// registry), so what it reads back is what the console would hold.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-tele-')), 't.db');
const C = require('./constants');
const D = require('./db');
const { EvonyClient } = require('./evony');
const { Game } = require('./game');
const { Session } = require('./session');
const TP = require('./teleport');
const script = require('./script');
const { canAbandon, DEF } = require('./goal-buildnpc')._internals;

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);

const ADV = 'player.more.castle.1.a', WAR = 'player.more.castle.1.c', CITY = 'consume.move.1';
const F = (x, y) => C.coordsToFieldId(x, y);
const XY = (id) => { const p = C.fieldIdToCoords(id); return `${p.x},${p.y}`; };
// Zone ids that are NOT the list index, so only a server-listed id can match.
const ZONE_LIST = C.ZONES.map((name, i) => ({ id: 101 + i, name, playerCount: 1000 + i, castleCount: 2000 + i, rate: 40 + i }));

class FakeServer {
  // tiles: { 'x,y': 'flat' | 'npc' | 'city' }, everything else is forest
  constructor({ items, tiles = {}, zones = ZONE_LIST }) {
    this.items = { ...items };
    this.tiles = tiles;
    this.zones = zones;
    this.sent = [];
    this.refuse = null;        // a reply to give every move instead of moving
    this.push = 'after';       // 'after' the reply, 'before' it, or 'none'
  }

  code(x, y) {
    const k = this.tiles[x + ',' + y];
    return k === 'flat' ? 'a5' : k === 'npc' ? 'c5' : k === 'city' ? 'b0' : '13';
  }

  handle(client, cmd, data) {
    this.sent.push({ cmd, data });
    const emit = (name, d) => client.emit('cmd', name, d, { cmd: name, data: d });
    const reply = (d) => setImmediate(() => emit(cmd, d));

    if (cmd === 'common.mapInfoSimple') {
      let mapStr = '';
      const castles = [];
      for (let y = data.y1; y <= data.y2; y++) {
        for (let x = data.x1; x <= data.x2; x++) {
          mapStr += this.code(x, y);
          const k = this.tiles[x + ',' + y];
          if (k === 'npc') castles.push({ id: F(x, y), name: 'Barbarians', npc: true });
          if (k === 'city') castles.push({ id: F(x, y), name: 'Keep', userName: 'Rival' });
        }
      }
      return reply({ ok: 1, ...data, mapStr, castles });
    }
    if (cmd === 'common.zoneInfo') return reply({ ok: 1, zones: this.zones });

    const item = { 'city.advMoveCastle': ADV, 'city.WarMoveCastle': WAR, 'city.moveCastle': CITY }[cmd];
    if (item) {
      if (this.refuse) return reply(this.refuse);
      this.items[item] -= 1;
      // a state move lands in the middle of that state's 200x200 block
      const i = cmd === 'city.moveCastle' ? data.zoneId - 101 : -1;
      const to = i >= 0 ? F((i % 4) * 200 + 100, Math.floor(i / 4) * 200 + 100) : data.targetId;
      const pushes = () => {
        emit('server.ItemUpdate', { items: [{ id: item, count: this.items[item] }] });
        emit('server.CastleUpdate', { updateType: 2, castleBean: { id: data.castleId, fieldId: to } });
      };
      if (this.push === 'before') setImmediate(pushes);
      reply({ ok: 1 });
      if (this.push === 'after') setTimeout(pushes, 5);
      return;
    }
    return reply({ ok: 1 });
  }

  moves() { return this.sent.filter((s) => /^city\.\w*[mM]oveCastle$/.test(s.cmd)); }
  count(cmd) { return this.sent.filter((s) => s.cmd === cmd).length; }
}

class FakeClient extends EvonyClient {
  constructor(server) { super(); this.server = server; this.sock = { destroyed: false }; }
  send(cmd, data) { if (this.sock.destroyed) throw new Error('socket closed'); this.server.handle(this, cmd, data); }
  close() { this.sock.destroyed = true; }
}

const cityAt = (id, name, x, y) => ({
  id, name, fieldId: F(x, y),
  resource: { food: { amount: 0 }, wood: { amount: 0 }, stone: { amount: 0 }, iron: { amount: 0 }, gold: 0 },
  troop: {}, heros: [], fortification: {},
});

// Home at 100,100 and Second at 300,300 unless told otherwise.
function world({ items = { [ADV]: 2, [WAR]: 1, [CITY]: 3 }, tiles = {}, cities, zones, account = null } = {}) {
  const server = new FakeServer({ items, tiles, zones });
  const g = new Game();
  g.c = new FakeClient(server);
  g.castles = cities || [cityAt(1, 'Home', 100, 100), cityAt(2, 'Second', 300, 300)];
  g.player = { items: Object.entries(items).map(([id, count]) => ({ id, count })) };
  // Game.connect() is what applies server.ItemUpdate, and it never runs here.
  g.c.on('cmd', (cmd, d) => {
    if (cmd !== 'server.ItemUpdate') return;
    for (const it of d.items) { const x = g.player.items.find((i) => i.id === it.id); if (x) x.count = it.count; }
  });
  const s = new Session();
  s.account = account || { id: 'test', label: 'T' };
  s.bindOrg();
  const notes = [];
  s.note = (m) => notes.push(String(m));
  s.wire(g);
  s.game = g;
  return { server, g, s, notes };
}

async function tp(w, line, opts = {}) {
  const out = [];
  const a = script.parseLine(line);
  const moved = await TP.run(w.g, a, { session: w.s, log: (m) => out.push(m), waitMs: 200, ...opts });
  return { moved, out, text: out.join('\n') };
}

const held = (g, id) => TP.heldCount(g, id);

// ---------------------------------------------------------------------------

section('what each line means');

t('coordinates spend an Advanced Teleporter', () => {
  const a = script.parseLine('teleport 123,123');
  assert.deepStrictEqual([a.cmd, a.kind, a.target], ['teleport', 'adv', { x: 123, y: 123 }]);
  assert.strictEqual(script.parseLine('teleport 212, 312').kind, 'adv', 'a space after the comma is still coordinates');
});

t('a state name spends a City Teleporter, in any case and spacing', () => {
  assert.deepStrictEqual([script.parseLine('teleport thuringia').kind, script.parseLine('teleport thuringia').zone], ['state', 'Thuringia']);
  assert.strictEqual(script.parseLine('teleport THURINGIA').zone, 'Thuringia');
  assert.strictEqual(script.parseLine('teleport north march').zone, 'North March');
  assert.strictEqual(script.parseLine('teleport NorthMarch').zone, 'North March');
});

t('random and any pick the state at random', () => {
  for (const l of ['teleport random', 'teleport any']) {
    const a = script.parseLine(l);
    assert.deepStrictEqual([a.kind, a.zone], ['state', null], l);
  }
});

t('warteleport spends a War Teleporter, and only on coordinates', () => {
  const a = script.parseLine('warteleport 400,401');
  assert.deepStrictEqual([a.cmd, a.kind, a.target], ['teleport', 'war', { x: 400, y: 401 }]);
  assert.throws(() => script.parseLine('warteleport thuringia'), /needs coordinates/);
});

t('from <city> picks the city, names with spaces included', () => {
  assert.strictEqual(script.parseLine('teleport 5,6 from Second').from, 'Second');
  assert.strictEqual(script.parseLine('teleport lower lorraine from Home City').from, 'Home City');
  assert.strictEqual(script.parseLine('teleport lower lorraine from Home City').zone, 'Lower Lorraine');
});

t('a script with a bad teleport line is refused before anything runs', () => {
  const errs = (src) => script.parse(src).filter((x) => x.cmd === 'error').map((x) => x.error);
  assert.match(errs('teleport')[0], /usage/);
  assert.match(errs('teleport narnia')[0], /neither coordinates .* nor a state.*Thuringia/);
  assert.match(errs('teleport 800,5')[0], /off the map/);
  assert.match(errs('teleport 5,6 from')[0], /needs a city name/);
});

t('useitem on a teleporter says which command spends it instead', () => {
  for (const id of [ADV, WAR, CITY]) assert.throws(() => script.parseLine('useitem ' + id), /is a teleporter — use {2}teleport/);
  assert.strictEqual(script.parseLine('useitem player.box.1').cmd, 'useitem', 'other items are untouched');
});

section('coordinates');

t('teleport x,y onto a flat sends city.advMoveCastle with the fieldId, and follows the city there', async () => {
  const w = world({ tiles: { '123,123': 'flat' } });
  const r = await tp(w, 'teleport 123,123');
  assert.ok(r.moved, r.text);
  assert.deepStrictEqual(w.server.moves().map((m) => [m.cmd, m.data]), [['city.advMoveCastle', { castleId: 1, targetId: 123 * 800 + 123 }]]);
  assert.strictEqual(XY(w.g.castle('Home').fieldId), '123,123');
  assert.match(r.text, /Home is now at 123,123 \(Friesland\), 1 Advanced Teleporter left/);
  assert.strictEqual(held(w.g, ADV), 1);
});

t('warteleport x,y onto an NPC camp sends city.WarMoveCastle', async () => {
  const w = world({ tiles: { '410,212': 'npc' } });
  const r = await tp(w, 'warteleport 410,212');
  assert.ok(r.moved, r.text);
  assert.deepStrictEqual(w.server.moves().map((m) => [m.cmd, m.data]), [['city.WarMoveCastle', { castleId: 1, targetId: F(410, 212) }]]);
  assert.strictEqual(XY(w.g.castle('Home').fieldId), '410,212');
  assert.match(r.text, /an NPC camp \(level 5\)/);
});

t('teleport x,y onto an NPC is refused, and names warteleport', async () => {
  const w = world({ tiles: { '410,212': 'npc' } });
  const r = await tp(w, 'teleport 410,212');
  assert.strictEqual(r.moved, false);
  assert.strictEqual(w.server.moves().length, 0);
  assert.match(r.text, /only lands on an empty flat — to land on an NPC use: {2}warteleport 410,212 — nothing sent/);
});

t('warteleport onto a flat is refused, and names teleport', async () => {
  const w = world({ tiles: { '123,123': 'flat' } });
  const r = await tp(w, 'warteleport 123,123');
  assert.strictEqual(w.server.moves().length, 0);
  assert.match(r.text, /War Teleporter only lands on an NPC camp — to land on a flat use: {2}teleport 123,123/);
});

t('terrain and other players\' cities are refused for both', async () => {
  const w = world({ tiles: { '50,50': 'city' } });
  assert.match((await tp(w, 'teleport 60,60')).text, /is Forest level 3; an Advanced Teleporter only lands on an empty flat/);
  assert.match((await tp(w, 'teleport 50,50')).text, /is a city \(Keep, Rival\)/);
  assert.match((await tp(w, 'warteleport 50,50')).text, /is a city \(Keep, Rival\); a War Teleporter only lands on an NPC camp/);
  assert.strictEqual(w.server.moves().length, 0);
});

t('one of our own cities is refused without reading the map', async () => {
  const w = world();
  const r = await tp(w, 'teleport 300,300');
  assert.match(r.text, /300,300 is your own city Second — nothing sent/);
  assert.strictEqual(w.server.sent.length, 0);
});

t('with no teleporter held nothing is sent at all', async () => {
  const w = world({ items: { [ADV]: 0, [WAR]: 0, [CITY]: 0 }, tiles: { '123,123': 'flat' } });
  for (const [line, re] of [['teleport 123,123', /no Advanced Teleporter/], ['warteleport 1,1', /no War Teleporter/], ['teleport thuringia', /no City Teleporter/]]) {
    assert.match((await tp(w, line)).text, re);
  }
  assert.strictEqual(w.server.sent.length, 0);
});

t('a tile that cannot be read is left to the server', async () => {
  const w = world({ tiles: { '123,123': 'flat' } });
  const r = await tp(w, 'teleport 123,123', { session: null });
  assert.ok(r.moved, r.text);
  assert.match(r.text, /could not read the tile first — the server will judge it/);
});

section('states');

t('teleport thuringia sends city.moveCastle with the id the server lists for Thuringia', async () => {
  const w = world();
  const r = await tp(w, 'teleport thuringia');
  assert.ok(r.moved, r.text);
  const m = w.server.moves();
  assert.deepStrictEqual(m.map((x) => [x.cmd, x.data]), [['city.moveCastle', { castleId: 1, zoneId: 107 }]]);
  assert.strictEqual(C.zoneOf(...Object.values(C.fieldIdToCoords(w.g.castle('Home').fieldId))), 'Thuringia');
  assert.match(r.text, /Thuringia: 1,006 players, 2,006 cities, 46% crowded/);
  assert.match(r.text, /Home is now at 500,300 \(Thuringia\), 2 City Teleporter left/);
});

t('teleport random picks among the states the server lists', async () => {
  const w = world();
  const r = await tp(w, 'teleport random', { random: () => 0.99 });
  assert.match(r.text, /random pick: Romagna/);
  assert.strictEqual(w.server.moves()[0].data.zoneId, 116);
  const w2 = world();
  await tp(w2, 'teleport any', { random: () => 0 });
  assert.strictEqual(w2.server.moves()[0].data.zoneId, 101);
});

t('a state the server does not list is never guessed at', async () => {
  const w = world({ zones: ZONE_LIST.filter((z) => z.name !== 'Thuringia') });
  const r = await tp(w, 'teleport thuringia');
  assert.match(r.text, /the server lists no state called Thuringia/);
  assert.strictEqual(w.server.moves().length, 0);
  const w2 = world({ zones: [] });
  assert.match((await tp(w2, 'teleport saxony')).text, /could not read the list of states/);
  assert.strictEqual(w2.server.moves().length, 0);
});

section('the move itself');

t('a dry run reads the map and the states but sends no move', async () => {
  const w = world({ tiles: { '123,123': 'flat' } });
  assert.match((await tp(w, 'teleport 123,123', { dryRun: true })).text, /\[dry run\] not sent/);
  assert.match((await tp(w, 'teleport thuringia', { dryRun: true })).text, /\[dry run\] not sent/);
  assert.strictEqual(w.server.moves().length, 0);
  assert.ok(w.server.count('common.mapInfoSimple') >= 1 && w.server.count('common.zoneInfo') === 1);
  assert.strictEqual(XY(w.g.castle('Home').fieldId), '100,100');
});

t('a refusal is reported with its hint, and the city stays put', async () => {
  const w = world({ tiles: { '123,123': 'flat' } });
  w.server.refuse = { ok: -77, errorMsg: 'army exist' };
  const r = await tp(w, 'teleport 123,123');
  assert.strictEqual(r.moved, false);
  assert.match(r.text, /FAILED \(ok=-77\) - army exist — armies from this city are still out/);
  assert.strictEqual(XY(w.g.castle('Home').fieldId), '100,100');
});

t('the new tile is caught even when its push beats the reply', async () => {
  const w = world();
  w.server.push = 'before';
  const r = await tp(w, 'teleport thuringia');
  assert.match(r.text, /now at 500,300 \(Thuringia\)/);
});

t('an exact-tile move the server accepted lands there even without a push', async () => {
  const w = world({ tiles: { '123,123': 'flat' } });
  w.server.push = 'none';
  const r = await tp(w, 'teleport 123,123');
  assert.match(r.text, /Home is now at 123,123/);
  assert.strictEqual(XY(w.g.castle('Home').fieldId), '123,123');
});

t('a state move with no push says so rather than guessing', async () => {
  const w = world();
  w.server.push = 'none';
  const r = await tp(w, 'teleport saxony');
  assert.ok(r.moved);
  assert.match(r.text, /Home moved, but the server has not said where yet/);
  assert.strictEqual(XY(w.g.castle('Home').fieldId), '100,100');
});

t('from <city> moves that city, not the open tab', async () => {
  const w = world({ tiles: { '123,123': 'flat' } });
  await tp(w, 'teleport 123,123 from Second', { castle: 'Home' });
  assert.strictEqual(w.server.moves()[0].data.castleId, 2);
  assert.strictEqual(XY(w.g.castle('Second').fieldId), '123,123');
  assert.strictEqual(XY(w.g.castle('Home').fieldId), '100,100');
});

t('a script runs it in the open city tab and counts it', async () => {
  const w = world({ tiles: { '123,123': 'flat' } });
  const out = [];
  const n = await script.run(w.g, script.parse('teleport 123,123'), (m) => out.push(m), { castle: 'Second', session: w.s });
  assert.strictEqual(n, 1, out.join('\n'));
  assert.strictEqual(w.server.moves()[0].data.castleId, 2);
});

section('the city registry (buildnpc abandon guard)');

// Home, Extra, and a freshly built buildnpc city that canAbandon would allow.
function registryWorld() {
  const org = D.orgs.create('Tele ' + Math.random());
  const acc = D.org(org.id).accounts.upsert({ label: 'T', email: `t${Math.random()}@t`, password: 'pw' });
  const cities = [cityAt(1, 'Home', 100, 100), cityAt(2, 'Extra', 101, 100), cityAt(3, 'Built', 105, 105)];
  const w = world({ cities, account: acc, tiles: { '123,123': 'flat' } });
  D.registry.reconcile(acc.id, cities.slice(0, 2).map((c) => ({ fieldId: c.fieldId, castleId: c.id, name: c.name })));
  D.registry.claimFlat(acc.id, cities[2].fieldId, { x: 105, y: 105 });
  D.registry.markBuilt(acc.id, cities[2].fieldId, 3, 'Built');
  D.run('UPDATE city_registry SET builtAt = ? WHERE accountId = ? AND castleId = 3', Date.now() - 30 * 60000, acc.id);
  const verdict = () => canAbandon({ accountId: acc.id, game: w.g, castle: w.g.castle('Built'), policy: DEF });
  assert.ok(verdict().ok, 'setup: the built city should start out abandonable — ' + verdict().why);
  return { ...w, acc, verdict };
}

t('a teleported buildnpc city stops being abandonable, and the registry follows it', async () => {
  const w = registryWorld();
  await tp(w, 'teleport 123,123 from Built');
  const row = D.registry.byCastleId(w.acc.id, 3);
  assert.strictEqual(XY(row.fieldId), '123,123');
  assert.strictEqual(row.abandonable, false);
  assert.strictEqual(row.moves, 1);
  assert.ok(!w.verdict().ok);
  assert.ok(w.notes.some((m) => /Built moved from field/.test(m)), w.notes.join('\n'));
});

t('... even when the server never says where it went', async () => {
  const w = registryWorld();
  w.server.push = 'none';
  await tp(w, 'teleport bavaria from Built');
  assert.strictEqual(XY(w.g.castle('Built').fieldId), '105,105', 'still at the old tile, as far as we know');
  assert.strictEqual(D.registry.byCastleId(w.acc.id, 3).abandonable, false);
  assert.match(w.verdict().why, /not abandonable/);
});

t('a refused teleport leaves the registry alone', async () => {
  const w = registryWorld();
  w.server.refuse = { ok: -90, errorMsg: 'cooldown' };
  await tp(w, 'teleport 123,123 from Built');
  assert.ok(w.verdict().ok, w.verdict().why);
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
