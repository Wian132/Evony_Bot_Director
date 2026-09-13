'use strict';
// renamehero, against a fake server — no network. It runs on the real Game
// (hero pushes included) and the real script parser and runner.
const assert = require('assert');
const { EvonyClient } = require('./evony');
const { Game } = require('./game');
const RH = require('./rename-hero');
const script = require('./script');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);

class FakeServer {
  constructor(g) {
    this.g = g;
    this.sent = [];
    this.refuse = null;              // a reply to give every rename instead
    this.homeOf = null;              // heroId -> the only castleId the server accepts it from
    this.push = 'after';             // the new name's push comes 'after' the reply, 'before' it, or 'none'
  }

  handle(client, cmd, data) {
    this.sent.push({ cmd, data });
    const emit = (name, d) => client.emit('cmd', name, d, { cmd: name, data: d });
    const reply = (d) => setImmediate(() => emit(cmd, d));
    if (cmd !== 'hero.changeName') return reply({ ok: 1 });
    if (this.refuse) return reply(this.refuse);
    const home = this.homeOf ? this.homeOf[data.heroId] : undefined;
    if (home !== undefined && home !== data.castleId) return reply({ ok: -44, errorMsg: 'Hero doesn\'t exist' });
    const c = this.g.castles.find((x) => x.id === data.castleId);
    const h = c && c.heros.find((x) => x.id === data.heroId);
    if (!h) return reply({ ok: -44, errorMsg: 'Hero doesn\'t exist' });
    const pushed = () => emit('server.HeroUpdate', { castleId: data.castleId, updateType: 2, hero: { ...h, name: data.newName } });
    if (this.push === 'before') setImmediate(pushed);
    reply({ ok: 1 });
    if (this.push === 'after') setTimeout(pushed, 5);
  }

  renames() { return this.sent.filter((s) => s.cmd === 'hero.changeName'); }
}

class FakeClient extends EvonyClient {
  constructor(server) { super(); this.server = server; this.sock = { destroyed: false }; }
  send(cmd, data) { if (this.sock.destroyed) throw new Error('socket closed'); this.server.handle(this, cmd, data); }
  close() { this.sock.destroyed = true; }
}

const hero = (id, name, extra = {}) => ({ id, name, level: 40, status: 0, experience: 1000, ...extra });
const city = (id, name, heros = []) => ({ id, name, fieldId: id * 1000, heros });

// Lord02's cities, in the order the server lists them.
function world(cities) {
  const g = new Game();
  const server = new FakeServer(g);
  g.c = new FakeClient(server);
  g.castles = cities || [
    city(1, '9', [hero(150304224, 'Att66A391', { level: 648 })]),
    city(2, '7', [hero(150185592, 'OTTO', { level: 842 }), hero(3, 'Noel')]),
  ];
  // Game.connect() wires this, and it never runs here.
  g.c.on('cmd', (cmd, d) => { if (cmd === 'server.HeroUpdate') g.applyHeroUpdate(d); });
  return { server, g };
}

async function rh(w, line, opts = {}) {
  const out = [];
  const ok = await RH.run(w.g, script.parseLine(line), { log: (m) => out.push(m), waitMs: 200, ...opts });
  return { ok, out, text: out.join('\n') };
}

const names = (c) => (c.heros || []).map((h) => h.name);
const errs = (src) => script.parse(src).filter((x) => x.cmd === 'error').map((x) => x.error);

// ---------------------------------------------------------------------------

section('what each line means');

t('the hero, then the new name', () => {
  assert.deepStrictEqual(script.parseLine('renamehero Att66A391 OTTO'), { cmd: 'renamehero', hero: 'Att66A391', name: 'OTTO', anyway: false });
  assert.strictEqual(script.parseLine('RenameHero 150304224 Otto').hero, '150304224', 'by id, any case of command');
  assert.deepStrictEqual(script.parseLine('renamehero Sir Bob Bobby'), { cmd: 'renamehero', hero: 'Sir Bob', name: 'Bobby', anyway: false });
});

t('a trailing anyway is the override, but a lone "anyway" is just a name', () => {
  assert.deepStrictEqual(script.parseLine('renamehero Att66A391 OTTO anyway'), { cmd: 'renamehero', hero: 'Att66A391', name: 'OTTO', anyway: true });
  assert.deepStrictEqual(script.parseLine('renamehero Att66A391 anyway'), { cmd: 'renamehero', hero: 'Att66A391', name: 'anyway', anyway: false });
});

t('a script with a bad renamehero line is refused before anything runs', () => {
  assert.match(errs('renamehero')[0], /usage {2}renamehero <hero name or id> <new name>/);
  assert.match(errs('renamehero OTTO')[0], /usage/);
  assert.match(errs('renamehero Att66A391 O\'Neil')[0], /refuses a quote or a backslash/);
  assert.match(errs('renamehero Att66A391 "OTTO"')[0], /refuses a quote/);
  assert.match(errs('renamehero Att66A391 a\\b')[0], /backslash/);
});

t('the name is 10 wide at most, a Chinese character counting 2', () => {
  assert.strictEqual(script.parseLine('renamehero A ABCDEFGHIJ').name, 'ABCDEFGHIJ');
  assert.match(errs('renamehero A ABCDEFGHIJK')[0], /"ABCDEFGHIJK" is too long — the game takes 10 letters at most/);
  assert.strictEqual(RH.width('奥托'), 4);
  assert.strictEqual(script.parseLine('renamehero A 奥托奥托奥').name, '奥托奥托奥');
  assert.match(errs('renamehero A 奥托奥托奥托')[0], /too long/);
  assert.match(errs('renamehero A 奥托奥托奥x')[0], /too long/);
});

section('renamehero');

t('finds the hero in whichever city it is and sends castleId, heroId, newName', async () => {
  const w = world();
  const r = await rh(w, 'renamehero Att66A391 Wian', { castle: '7' });
  assert.ok(r.ok, r.text);
  assert.deepStrictEqual(w.server.renames().map((s) => s.data), [{ castleId: 1, heroId: 150304224, newName: 'Wian' }]);
  assert.deepStrictEqual(names(w.g.castle('9')), ['Wian'], 'the push renames it in the roster');
  assert.match(r.text, /rename Att66A391 \(L648, id 150304224\) in 9 to Wian/);
  assert.match(r.text, /-> ok — Att66A391 is now Wian in 9/);
  assert.match(r.text, /scripts and goals that name Att66A391 need Wian now/);
});

t('by id, and by name in any case', async () => {
  const w = world();
  assert.ok((await rh(w, 'renamehero 150304224 First')).ok);
  assert.ok((await rh(w, 'renamehero first Second')).ok);
  assert.deepStrictEqual(w.server.renames().map((s) => s.data.newName), ['First', 'Second']);
  assert.deepStrictEqual(names(w.g.castle('9')), ['Second']);
});

t('a new name another hero already has is refused, and anyway renames it all the same', async () => {
  const w = world();
  const r = await rh(w, 'renamehero Att66A391 otto');
  assert.strictEqual(r.ok, false);
  assert.match(r.text, /OTTO L842 in 7, id 150185592 already has that name — nothing sent/);
  assert.match(r.text, /useheroitem finds a hero by name and takes the first/);
  assert.match(r.text, /renamehero Att66A391 otto anyway/);
  assert.strictEqual(w.server.renames().length, 0);

  const r2 = await rh(w, 'renamehero Att66A391 OTTO anyway');
  assert.ok(r2.ok, r2.text);
  assert.match(r2.text, /to OTTO — OTTO in 7 has that name too/);
  assert.deepStrictEqual(names(w.g.castle('9')), ['OTTO']);
});

t('changing only the case of its own name is not a clash', async () => {
  const w = world();
  const r = await rh(w, 'renamehero OTTO Otto');
  assert.ok(r.ok, r.text);
  assert.deepStrictEqual(names(w.g.castle('7')), ['Otto', 'Noel']);
});

t('the name it already has sends nothing', async () => {
  const w = world();
  assert.match((await rh(w, 'renamehero otto OTTO')).text, /OTTO already has that name — nothing sent/);
  assert.strictEqual(w.server.renames().length, 0);
});

t('a hero not in any city is never sent', async () => {
  const w = world();
  const r = await rh(w, 'renamehero Zed Zeta');
  assert.strictEqual(r.ok, false);
  assert.match(r.text, /no hero called Zed in any city — nothing sent/);
  assert.strictEqual(w.server.renames().length, 0);
});

t('two heroes of one name are not guessed between', async () => {
  const w = world([city(1, 'A', [hero(21, 'Twin', { level: 30 })]), city(2, 'B', [hero(22, 'Twin', { level: 80 })])]);
  const r = await rh(w, 'renamehero twin Solo');
  assert.match(r.text, /more than one hero is called twin — rename one by its id — nothing sent/);
  assert.match(r.text, /Twin L30 in A, id 21\n.*Twin L80 in B, id 22/);
  assert.strictEqual(w.server.renames().length, 0);
  assert.ok((await rh(w, 'renamehero 22 Solo')).ok);
  assert.deepStrictEqual(w.server.renames().map((s) => s.data), [{ castleId: 2, heroId: 22, newName: 'Solo' }]);
});

// Seen live on Lord02 (2026-09-13): Att66A391 was listed in both 9 and Flat
// with one id, the Flat entry the fresher (more experience, loyalty 70 not 100).
t('one hero listed in two cities is one hero: the fresher city goes first, the other if it is refused', async () => {
  const stale = hero(150304224, 'Att66A391', { level: 648, status: 3, experience: 13129553, loyalty: 100 });
  const fresh = { ...stale, experience: 13129586, loyalty: 70 };
  const w = world([city(1, '9', [stale]), city(5, 'Flat', [fresh])]);
  const r = await rh(w, 'renamehero Att66A391 Wian');
  assert.ok(r.ok, r.text);
  assert.match(r.text, /Att66A391 is listed in Flat and 9, which it can't be — trying Flat, the fresher entry, first/);
  assert.deepStrictEqual(w.server.renames().map((s) => s.data.castleId), [5]);
  assert.match(r.text, /Att66A391 is now Wian in Flat/);

  const w2 = world([city(1, '9', [{ ...stale }]), city(5, 'Flat', [{ ...fresh }])]);
  w2.server.homeOf = { 150304224: 1 };
  const r2 = await rh(w2, 'renamehero Att66A391 Wian');
  assert.ok(r2.ok, r2.text);
  assert.deepStrictEqual(w2.server.renames().map((s) => s.data.castleId), [5, 1]);
  assert.match(r2.text, /Flat: FAILED \(ok=-44\) - Hero doesn't exist\n.*Att66A391 is now Wian in 9/);
});

t('a prisoner is not renamed', async () => {
  const w = world([city(1, 'Home', [hero(9, 'Captive', { status: 4 })])]);
  assert.match((await rh(w, 'renamehero Captive Mine')).text, /Captive is a prisoner held in Home, not one of your heroes — the game won't rename it — nothing sent/);
  assert.strictEqual(w.server.renames().length, 0);
});

t('a refusal is reported with the server\'s reason, and the roster keeps the old name', async () => {
  const w = world();
  w.server.refuse = { ok: -1, errorMsg: 'The name is illegal' };
  const r = await rh(w, 'renamehero Att66A391 Wian');
  assert.strictEqual(r.ok, false);
  assert.match(r.text, /-> FAILED \(ok=-1\) - The name is illegal/);
  assert.doesNotMatch(r.text, /9: FAILED/, 'a hero listed once is not reported per city');
  assert.strictEqual(w.server.renames().length, 1);
  assert.deepStrictEqual(names(w.g.castle('9')), ['Att66A391']);
});

t('the new name is caught even when its push beats the reply', async () => {
  const w = world();
  w.server.push = 'before';
  assert.match((await rh(w, 'renamehero Att66A391 Wian')).text, /Att66A391 is now Wian in 9/);
});

t('an accepted rename with no push says so rather than guessing', async () => {
  const w = world();
  w.server.push = 'none';
  const r = await rh(w, 'renamehero Att66A391 Wian');
  assert.ok(r.ok);
  assert.match(r.text, /-> ok — the server accepted it, but the new name has not come back yet/);
});

t('a dry run says what it would do and sends nothing', async () => {
  const w = world();
  const r = await rh(w, 'renamehero Att66A391 Wian', { dryRun: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.text, /rename Att66A391 .* to Wian\n.*\[dry run\] not sent/);
  assert.strictEqual(w.server.sent.length, 0);
});

t('a script runs it and counts the rename', async () => {
  const w = world();
  const out = [];
  const n = await script.run(w.g, script.parse('renamehero Att66A391 Wian\nrenamehero Nobody X'), (m) => out.push(m), { castle: '7' });
  assert.strictEqual(n, 1, out.join('\n'));
  assert.strictEqual(w.server.renames()[0].data.castleId, 1);
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
