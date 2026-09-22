'use strict';
// waterhero, against a fake server — no network. It runs on the real Game
// (hero and item pushes included) and the real script parser and runner.
//
// The fake server keeps each hero's truth apart from the client's roster: the
// stats it was born with, what it has spent, and the Holy Water held. A reset
// refunds everything spent into remainPoint and charges ceil(level / 10);
// hero.addPoint takes ABSOLUTE totals and refuses any that lower an attribute
// or spend more than is unspent — so totals worked out on stale stats fail.
const assert = require('assert');
const { EvonyClient } = require('./evony');
const { Game } = require('./game');
const WH = require('./water-hero');
const HI = require('./heroitems');
const script = require('./script');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);

const KEYS = ['power', 'management', 'stratagem'];
const sum = (o) => KEYS.reduce((s, k) => s + Number(o[k] || 0), 0);

class FakeServer {
  constructor(g) {
    this.g = g;
    this.sent = [];
    this.truth = {};                 // heroId -> the server's hero, with .base
    this.items = {};                 // itemId -> count
    this.refuse = null;              // a reply to give every reset instead
    this.homeOf = null;              // heroId -> the only castleId the server accepts it from
    this.push = 'after';             // the reset's push comes 'after' the reply, 'before' it, or 'none'
    this.charge = null;              // Holy Water a reset takes, if not ceil(level / 10)
    this.meddle = 0;                 // points something else spends between the reset's push and its reply
    this.refuseAdd = null;           // a reply to give every addPoint instead
  }

  view(h) { const { base, ...rest } = h; return { ...rest }; }

  handle(client, cmd, data) {
    this.sent.push({ cmd, data });
    const emit = (name, d) => client.emit('cmd', name, d, { cmd: name, data: d });
    const reply = (d) => setImmediate(() => emit(cmd, d));
    if (cmd === 'hero.resetPoint') return this.reset(emit, reply, data);
    if (cmd === 'hero.addPoint') return this.addPoint(emit, reply, data);
    return reply({ ok: 1 });
  }

  hero(castleId, heroId) {
    const c = this.g.castles.find((x) => x.id === castleId);
    return c && c.heros.some((x) => x.id === heroId) ? this.truth[heroId] : null;
  }

  reset(emit, reply, data) {
    if (this.refuse) return reply(this.refuse);
    const home = this.homeOf ? this.homeOf[data.heroId] : undefined;
    if (home !== undefined && home !== data.castleId) return reply({ ok: -44, errorMsg: 'Hero doesn\'t exist' });
    const h = this.hero(data.castleId, data.heroId);
    if (!h) return reply({ ok: -44, errorMsg: 'Hero doesn\'t exist' });
    const need = this.charge ?? Math.ceil(h.level / 10);
    const have = this.items['hero.reset.1'] || 0;
    if (have < need) return reply({ ok: -99, errorMsg: 'Not enough Holy Water' });
    this.items['hero.reset.1'] = have - need;
    h.remainPoint += sum(h) - sum(h.base);
    for (const k of KEYS) h[k] = h.base[k];

    const pushed = () => emit('server.HeroUpdate', { castleId: data.castleId, updateType: 2, hero: this.view(h) });
    const meddled = () => {
      h.power += this.meddle; h.remainPoint -= this.meddle;
      emit('server.HeroUpdate', { castleId: data.castleId, updateType: 2, hero: this.view(h) });
    };
    if (this.push === 'before') { setImmediate(pushed); if (this.meddle) setImmediate(meddled); }
    reply({ ok: 1 });
    if (this.push === 'after') setTimeout(pushed, 5);
    setTimeout(() => emit('server.ItemUpdate', { items: [{ id: 'hero.reset.1', count: this.items['hero.reset.1'] }] }), 8);
  }

  addPoint(emit, reply, data) {
    if (this.refuseAdd) return reply(this.refuseAdd);
    const h = this.hero(data.castleId, data.heroId);
    if (!h) return reply({ ok: -44, errorMsg: 'Hero doesn\'t exist' });
    const inc = Object.fromEntries(KEYS.map((k) => [k, data[k] - h[k]]));
    if (KEYS.some((k) => inc[k] < 0) || sum(inc) <= 0 || sum(inc) > h.remainPoint) {
      return reply({ ok: -1, errorMsg: 'Illegal attribute points' });
    }
    for (const k of KEYS) h[k] += inc[k];
    h.remainPoint -= sum(inc);
    reply({ ok: 1 });
    setTimeout(() => emit('server.HeroUpdate', { castleId: data.castleId, updateType: 2, hero: this.view(h) }), 5);
  }

  resets() { return this.sent.filter((s) => s.cmd === 'hero.resetPoint'); }
  adds() { return this.sent.filter((s) => s.cmd === 'hero.addPoint'); }
}

class FakeClient extends EvonyClient {
  constructor(server) { super(); this.server = server; this.sock = { destroyed: false }; }
  send(cmd, data) { if (this.sock.destroyed) throw new Error('socket closed'); this.server.handle(this, cmd, data); }
  close() { this.sock.destroyed = true; }
}

// A hero: the stats it was born with, what it has spent on top, and unspent.
const H = (id, name, { level = 100, status = 0, base = { power: 45, management: 20, stratagem: 72 }, spent = {}, unspent = 0, experience = 1000 } = {}) => ({
  id, name, level, status, experience, loyalty: 100, base,
  power: base.power + (spent.power || 0),
  management: base.management + (spent.management || 0),
  stratagem: base.stratagem + (spent.stratagem || 0),
  remainPoint: unspent, powerAdded: 0, managementAdded: 0, stratagemAdded: 0,
});
const city = (id, name, heros = []) => ({ id, name, fieldId: id * 1000, heros });

// Smarty: born intel (int 72), built into attack with 100 points.
function world(cities, { water = 1284, items = {} } = {}) {
  const g = new Game();
  const server = new FakeServer(g);
  g.c = new FakeClient(server);
  const spec = cities || [
    city(1, 'Home', [H(11, 'Smarty', { spent: { power: 100 } })]),
    city(2, 'Flat', [H(21, 'Robert1', { level: 400, base: { power: 45, management: 60, stratagem: 30 }, spent: { power: 400 } })]),
  ];
  // the client's roster holds no .base; the server's truth does
  g.castles = spec.map((c) => ({ ...c, heros: c.heros.map((h) => server.view(h)) }));
  for (const c of spec) for (const h of c.heros) server.truth[h.id] = { ...h, base: { ...h.base } };
  server.items = { 'hero.reset.1': water, ...items };
  g.player = { items: Object.entries(server.items).map(([id, count]) => ({ id, count })) };
  // Game.connect() wires these, and it never runs here.
  g.c.on('cmd', (cmd, d) => { if (cmd === 'server.HeroUpdate') g.applyHeroUpdate(d); });
  g.c.on('cmd', (cmd, d) => {
    if (cmd !== 'server.ItemUpdate') return;
    for (const it of d.items) {
      const i = g.player.items.findIndex((x) => x.id === it.id);
      if (i >= 0) g.player.items[i] = { ...g.player.items[i], ...it }; else g.player.items.push(it);
    }
  });
  return { server, g };
}

async function wh(w, line, opts = {}) {
  const out = [];
  const ok = await WH.run(w.g, script.parseLine(line), { log: (m) => out.push(m), waitMs: 200, ...opts });
  return { ok, out, text: out.join('\n') };
}

const stat = (w, id) => {
  const h = w.g.castles.flatMap((c) => c.heros).find((x) => x.id === id);
  return { power: h.power, management: h.management, stratagem: h.stratagem, remainPoint: h.remainPoint };
};
const held = (w) => (w.g.player.items.find((i) => i.id === 'hero.reset.1') || {}).count;
const errs = (src) => script.parse(src).filter((x) => x.cmd === 'error').map((x) => x.error);

// ---------------------------------------------------------------------------

section('what each line means');

t('a hero, then an optional /heropoints switch, as NEAT writes it', () => {
  assert.deepStrictEqual(script.parseLine('waterhero Smarty'), { cmd: 'waterhero', hero: 'Smarty', rule: null });
  const a = script.parseLine('waterhero Robert1 /heropoints="pol:300,int:100 att"');
  assert.strictEqual(a.hero, 'Robert1');
  assert.strictEqual(a.rule.raw, 'pol:300,int:100 att');
  assert.deepStrictEqual(a.rule.stages.map((s) => s.targets.map((x) => [x.attr, x.cap])),
    [[['management', 300], ['stratagem', 100]], [['power', Infinity]]]);
  assert.strictEqual(script.parseLine('waterhero Robert2 /heropoints="pol:300 int:100 att"').rule.stages.length, 3);
});

t('the switch unquoted, in single quotes, in any case, and a name with spaces', () => {
  assert.strictEqual(script.parseLine('WaterHero 150304224 /heropoints=att').rule.raw, 'att');
  assert.strictEqual(script.parseLine("waterhero X /heropoints='pol:300 att'").rule.raw, 'pol:300 att');
  const a = script.parseLine('waterhero Sir Bob /HEROPOINTS = "int"');
  assert.strictEqual(a.hero, 'Sir Bob');
  assert.strictEqual(a.rule.raw, 'int');
  assert.ok(script.parseLine('waterhero X /heropoints=off').rule.stages[0].off);
});

t('the switch as typed by hand: no slash, no =, a space before the quote', () => {
  // 2026-09-22: "waterhero kush heropoints pol" was read as a hero called "kush heropoints pol"
  for (const l of ['waterhero kush heropoints pol', 'waterhero kush /heropoints "pol"', 'waterhero kush /heropoints pol',
    'waterhero kush heropoints=pol', 'waterhero kush /heropoints:pol']) {
    const a = script.parseLine(l);
    assert.strictEqual(a.hero, 'kush', l);
    assert.strictEqual(a.rule.raw, 'pol', l);
  }
  const b = script.parseLine('waterhero Sir Bob heropoints pol:300 att');
  assert.strictEqual(b.hero, 'Sir Bob');
  assert.strictEqual(b.rule.raw, 'pol:300 att');
  assert.deepStrictEqual(script.parseLine('waterhero Heropoints'), { cmd: 'waterhero', hero: 'Heropoints', rule: null });
});

t('useheroitem <hero> holy water takes /heropoints too, and only for Holy Water', () => {
  for (const l of ['useheroitem Kush holywater /heropoints="pol"', 'useheroitem Kush holy water heropoints pol']) {
    const a = script.parseLine(l);
    assert.strictEqual(a.cmd, 'waterhero', l);
    assert.strictEqual(a.hero, 'Kush', l);
    assert.strictEqual(a.rule.raw, 'pol', l);
  }
  assert.match(errs('useheroitem Kush excalibur /heropoints=pol')[0], /\/heropoints only goes with Holy Water/);
});

t('a bad waterhero line is refused before anything runs', () => {
  assert.match(errs('waterhero')[0], /usage {2}waterhero <hero name or id> \[\/heropoints="att"\]/);
  assert.match(errs('waterhero /heropoints=att')[0], /usage/);
  assert.match(errs('waterhero X /heropoints=""')[0], /\/heropoints needs targets/);
  assert.match(errs('waterhero X /heropoints="pol:300')[0], /the \/heropoints quote is never closed/);
  assert.match(errs('waterhero X /heropoints=xyz')[0], /unknown heropoints target "xyz"/);
  assert.match(errs('waterhero X /heropoints=att:-5')[0], /bad heropoints cap "att:-5"/);
  assert.match(errs('waterhero X /force')[0], /unknown switch \/force — the only one is \/heropoints="..."/);
});

t('useheroitem <hero> holy water is waterhero, never hero.useItem', () => {
  assert.deepStrictEqual(script.parseLine('useheroitem Smarty holy water'), { cmd: 'waterhero', hero: 'Smarty', rule: null });
  assert.deepStrictEqual(script.parseLine('useheroitem Smarty reset'), { cmd: 'waterhero', hero: 'Smarty', rule: null });
  assert.deepStrictEqual(script.parseLine('useheroitem Smarty hero.reset.1'), { cmd: 'waterhero', hero: 'Smarty', rule: null });
  assert.match(errs('useheroitem Smarty reset repeat 3')[0], /Holy Water resets a hero once/);
  assert.match(errs('useitem hero.reset.1 5')[0], /Holy Water is spent on a hero by {2}waterhero <hero>/);
  assert.deepStrictEqual(errs('useitem hero.reset.1.a 1'), [], 'a pack still opens with useitem');
});

t('useOnHero refuses Holy Water without sending anything', async () => {
  const w = world();
  const r = await HI.useOnHero(w.g, { heroName: 'Smarty', itemId: 'hero.reset.1' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /goes through hero.resetPoint, not hero.useItem — use {2}waterhero Smarty/);
  assert.strictEqual(w.server.sent.length, 0);
});

t('one Holy Water per ten levels begun', () => {
  assert.deepStrictEqual([0, 1, 10, 11, 20, 21, 100, 101, 250, 842].map(WH.cost), [1, 1, 1, 2, 2, 3, 10, 11, 25, 85]);
});

section('waterhero');

t('resets, then puts every point on the highest stat — which is the one it was born with', async () => {
  const w = world();
  const r = await wh(w, 'waterhero Smarty');
  assert.ok(r.ok, r.text);
  assert.deepStrictEqual(w.server.resets().map((s) => s.data), [{ castleId: 1, heroId: 11 }]);
  assert.deepStrictEqual(stat(w, 11), { power: 45, management: 20, stratagem: 172, remainPoint: 0 },
    'born intel, so the 100 points go back to intel, not attack');
  assert.match(r.text, /Holy Water on Smarty L100 in Home \(id 11\): att 145 · pol 20 · int 72 · 0 unspent/);
  assert.match(r.text, /costs 10 Holy Water \(one per 10 levels\), 1,284 held; the points then go to its highest stat once reset/);
  assert.match(r.text, /-> reset: att 145 · pol 20 · int 72 · 0 unspent {2}=> {2}att 45 · pol 20 · int 72 · 100 unspent/);
  assert.match(r.text, /-> spent 100 by the highest stat: int \+100 {2}=> {2}att 45 · pol 20 · int 172 · 0 unspent/);
  assert.match(r.text, /Holy Water: 10 used, 1,274 left$/);
  assert.strictEqual(held(w), 1274);
});

t('/heropoints="att" keeps it an attack hero', async () => {
  const w = world();
  const r = await wh(w, 'waterhero Smarty /heropoints="att"');
  assert.ok(r.ok, r.text);
  assert.deepStrictEqual(stat(w, 11), { power: 145, management: 20, stratagem: 72, remainPoint: 0 });
  assert.match(r.text, /the points then go by \/heropoints="att"/);
  assert.match(r.text, /-> spent 100 by \/heropoints="att": att \+100/);
});

t('the totals sent are the reset stats plus the points — never the old build', async () => {
  const w = world();
  await wh(w, 'waterhero Smarty /heropoints="att"');
  assert.deepStrictEqual(w.server.adds().map((s) => s.data), [{ castleId: 1, heroId: 11, management: 20, power: 145, stratagem: 72 }]);
});

t('NEAT\'s examples: "pol:300,int:100 att" pro-rates a stage, "pol:300 int:100 att" takes them in turn', async () => {
  const w = world();
  const r = await wh(w, 'waterhero Robert1 /heropoints="pol:300,int:100 att"');
  assert.ok(r.ok, r.text);
  assert.deepStrictEqual(stat(w, 21), { power: 135, management: 300, stratagem: 100, remainPoint: 0 },
    '400 points: pol +240 and int +70 meet the stage, the other 90 go to attack');
  assert.match(r.text, /costs 40 Holy Water/);
  assert.match(r.text, /att \+90, pol \+240, int \+70/);

  // 155 points cannot meet pol 300 and int 100 (310 short), so they split 240:70
  const w2 = world([city(1, 'Home', [H(22, 'Robert1', { level: 155, base: { power: 45, management: 60, stratagem: 30 }, spent: { power: 155 } })])]);
  assert.ok((await wh(w2, 'waterhero Robert1 /heropoints="pol:300,int:100 att"')).ok);
  assert.deepStrictEqual(stat(w2, 22), { power: 45, management: 180, stratagem: 65, remainPoint: 0 });

  // in turn: pol to 300 first (240), then int with the 10 left
  const w3 = world([city(1, 'Home', [H(23, 'Robert2', { level: 250, base: { power: 45, management: 60, stratagem: 30 }, spent: { power: 250 } })])]);
  assert.ok((await wh(w3, 'waterhero Robert2 /heropoints="pol:300 int:100 att"')).ok);
  assert.deepStrictEqual(stat(w3, 23), { power: 45, management: 300, stratagem: 40, remainPoint: 0 });
});

t('leftovers after the stages go to the highest stat as it stands then', async () => {
  // born attack (70), turned intel: int reaches 300 with 260, and the other
  // 140 go to intel — by then the highest — not to the attack it was born with
  const w = world([city(1, 'Home', [H(31, 'Turncoat', { level: 400, base: { power: 70, management: 20, stratagem: 40 }, spent: { power: 400 } })])]);
  assert.ok((await wh(w, 'waterhero Turncoat /heropoints="int:300"')).ok);
  assert.deepStrictEqual(stat(w, 31), { power: 70, management: 20, stratagem: 440, remainPoint: 0 });
});

t('/heropoints=off resets and leaves every point unspent', async () => {
  const w = world();
  const r = await wh(w, 'waterhero Smarty /heropoints=off');
  assert.ok(r.ok, r.text);
  assert.deepStrictEqual(stat(w, 11), { power: 45, management: 20, stratagem: 72, remainPoint: 100 });
  assert.strictEqual(w.server.adds().length, 0);
  assert.match(r.text, /100 point\(s\) left unspent, as \/heropoints="off" says/);
});

t('unspent points from before the reset are spent with the refund', async () => {
  const w = world([city(1, 'Home', [H(12, 'Saver', { spent: { power: 80 }, unspent: 20 })])]);
  assert.ok((await wh(w, 'waterhero Saver /heropoints="att"')).ok);
  assert.deepStrictEqual(stat(w, 12), { power: 145, management: 20, stratagem: 72, remainPoint: 0 });
});

t('by id, and by name in any case', async () => {
  const w = world();
  assert.ok((await wh(w, 'waterhero 11 /heropoints=att')).ok);
  assert.ok((await wh(w, 'waterhero SMARTY /heropoints=att')).ok);
  assert.deepStrictEqual(w.server.resets().map((s) => s.data.heroId), [11, 11]);
});

t('the mayor can be watered', async () => {
  const w = world([city(1, 'Home', [H(13, 'Mayor', { status: 1, base: { power: 20, management: 75, stratagem: 30 }, spent: { power: 100 } })])]);
  assert.ok((await wh(w, 'waterhero Mayor')).ok);
  assert.deepStrictEqual(stat(w, 13), { power: 20, management: 175, stratagem: 30, remainPoint: 0 });
});

section('what is never sent');

t('not enough Holy Water sends nothing, and names the packs that could be opened', async () => {
  const w = world(null, { water: 9, items: { 'hero.reset.1.a': 3, 'player.box.currently.1': 1 } });
  const r = await wh(w, 'waterhero Smarty');
  assert.strictEqual(r.ok, false);
  assert.match(r.text, /costs 10 Holy Water \(one per 10 levels\), 9 held/);
  assert.match(r.text, /not enough Holy Water — nothing sent/);
  assert.match(r.text, /3 x Holy Water \(5 pieces package\) held — open one with {2}useitem hero.reset.1.a/);
  assert.match(r.text, /1 x Hero Package held — open one with {2}useitem player.box.currently.1/);
  assert.strictEqual(w.server.sent.length, 0);
});

t('the inventory not loaded: nothing is sent (a reset without the Holy Water held is paid in cents)', async () => {
  const w = world();
  w.g.player.items = undefined;
  const r = await wh(w, 'waterhero Smarty');
  assert.strictEqual(r.ok, false);
  assert.match(r.text, /costs 10 Holy Water \(one per 10 levels\); /, 'no count shown: none is known');
  assert.match(r.text, /the inventory has not loaded, so whether 10 Holy Water are held cannot be checked — nothing sent \(the game buys what is missing with cents\)/);
  assert.strictEqual(w.server.sent.length, 0);
  const p = WH.prepare(w.g, script.parseLine('waterhero Smarty'));
  assert.deepStrictEqual([p.ok, p.need, p.held], [false, 10, null], 'the Heroes tab\'s preview says the same');
});

t('the hero and the stock are read again right before each send: a level gained since costs more, and nothing goes', async () => {
  const stale = H(51, 'Att66A391', { level: 100, experience: 1, spent: { power: 600 } });
  const w = world([city(1, '9', [stale]), city(5, 'Flat', [{ ...stale, experience: 2 }])], { water: 10 });
  w.server.homeOf = { 51: 1 };
  // while the first city's try is refused, the hero's push brings it to L101 (11 Holy Water)
  const orig = w.server.reset.bind(w.server);
  w.server.reset = (emit, reply, data) => {
    if (data.castleId === 5) emit('server.HeroUpdate', { castleId: 1, updateType: 2, hero: { ...w.server.view(w.server.truth[51]), level: 101 } });
    return orig(emit, reply, data);
  };
  const r = await wh(w, 'waterhero Att66A391');
  assert.strictEqual(r.ok, false);
  assert.match(r.text, /Att66A391 is L101 now, which costs 11 Holy Water \(not 10\), and 10 are held — nothing sent/);
  assert.deepStrictEqual(w.server.resets().map((s) => s.data.castleId), [5], 'the second city was never asked');
});

t('a prisoner is not watered', async () => {
  const w = world([city(1, 'Home', [H(14, 'Captive', { status: 4 })])]);
  const r = await wh(w, 'waterhero Captive');
  assert.match(r.text, /Captive is a prisoner held in Home, not one of your heroes — the game won't reset it — nothing sent/);
  assert.strictEqual(w.server.sent.length, 0);
});

t('a hero that is out is not watered: marching, returning, farming or defending', async () => {
  for (const [st, word] of [[3, 'marching'], [5, 'returning'], [8, 'farming'], [2, 'garrisoned'], [6, 'status 6']]) {
    const w = world([city(1, 'Home', [H(15, 'Away', { status: st })])]);
    const r = await wh(w, 'waterhero Away');
    assert.strictEqual(r.ok, false);
    assert.match(r.text, new RegExp(`Away is ${word}, not in the Feasting Hall — water it once it is home — nothing sent`));
    assert.strictEqual(w.server.sent.length, 0);
  }
});

t('a hero not in any city is never sent, and the wiki\'s ! is explained', async () => {
  const w = world();
  const r = await wh(w, 'waterhero !BigGuy');
  assert.strictEqual(r.ok, false);
  assert.match(r.text, /no hero called !BigGuy in any city — nothing sent/);
  assert.match(r.text, /only stops a wiki link — leave it out/);
  assert.doesNotMatch((await wh(w, 'waterhero Zed')).text, /wiki/);
  assert.strictEqual(w.server.sent.length, 0);
});

t('two heroes of one name are not guessed between', async () => {
  const w = world([city(1, 'A', [H(41, 'Twin', { level: 30 })]), city(2, 'B', [H(42, 'Twin', { level: 80 })])]);
  const r = await wh(w, 'waterhero twin');
  assert.match(r.text, /more than one hero is called twin — water one by its id — nothing sent/);
  assert.match(r.text, /Twin L30 in A, id 41\n.*Twin L80 in B, id 42/);
  assert.strictEqual(w.server.sent.length, 0);
  assert.ok((await wh(w, 'waterhero 42')).ok);
  assert.deepStrictEqual(w.server.resets().map((s) => s.data), [{ castleId: 2, heroId: 42 }]);
});

t('a dry run says what it would cost and sends nothing', async () => {
  const w = world();
  const r = await wh(w, 'waterhero Smarty /heropoints=att', { dryRun: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.text, /costs 10 Holy Water.*\n.*\[dry run\] not sent/);
  assert.strictEqual(w.server.sent.length, 0);
});

section('what comes back');

t('a refusal is reported with the server\'s reason, and no points are touched', async () => {
  const w = world();
  w.server.refuse = { ok: -7, errorMsg: 'Hero is busy' };
  const r = await wh(w, 'waterhero Smarty');
  assert.strictEqual(r.ok, false);
  assert.match(r.text, /-> FAILED \(ok=-7\) - Hero is busy/);
  assert.strictEqual(w.server.adds().length, 0);
  assert.deepStrictEqual(stat(w, 11), { power: 145, management: 20, stratagem: 72, remainPoint: 0 });
});

t('the reset is caught even when its push beats the reply', async () => {
  const w = world();
  w.server.push = 'before';
  const r = await wh(w, 'waterhero Smarty /heropoints=att');
  assert.ok(r.ok, r.text);
  assert.deepStrictEqual(stat(w, 11), { power: 145, management: 20, stratagem: 72, remainPoint: 0 });
});

t('an accepted reset whose stats never come back spends nothing', async () => {
  const w = world();
  w.server.push = 'none';
  const r = await wh(w, 'waterhero Smarty');
  assert.ok(r.ok, 'the Holy Water was spent, so it counts');
  assert.match(r.text, /-> ok — the server accepted the reset, but Smarty's new stats have not come back — no points spent/);
  assert.strictEqual(w.server.adds().length, 0);
});

t('a hero with nothing spent comes back unchanged, and says so', async () => {
  const w = world([city(1, 'Home', [H(16, 'Fresh', { unspent: 5 })])]);
  const r = await wh(w, 'waterhero Fresh');
  assert.ok(r.ok);
  assert.match(r.text, /-> ok — but Fresh came back unchanged \(att 45 · pol 20 · int 72 · 5 unspent\): it had no spent points to give back/);
  assert.strictEqual(w.server.adds().length, 0);
});

t('points something else spent first are left alone, and the rest are spent', async () => {
  const w = world();
  w.server.push = 'before';
  w.server.meddle = 30;                   // e.g. a heropoints goal, between the push and the reply
  const r = await wh(w, 'waterhero Smarty /heropoints=att');
  assert.ok(r.ok, r.text);
  assert.match(r.text, /30 point\(s\) were spent before this could \(a heropoints goal\?\) — spending the rest/);
  assert.deepStrictEqual(stat(w, 11), { power: 145, management: 20, stratagem: 72, remainPoint: 0 });
  assert.deepStrictEqual(w.server.adds().map((s) => s.data.power), [145]);
});

t('a refused addPoint leaves the points unspent and says how to spend them', async () => {
  const w = world();
  w.server.refuseAdd = { ok: -1, errorMsg: 'nope' };
  const r = await wh(w, 'waterhero Smarty');
  assert.ok(r.ok);
  assert.match(r.text, /spending the points FAILED \(ok=-1\) - nope — 100 point\(s\) are unspent; spend them with addpoint or on the Heroes tab/);
  assert.deepStrictEqual(stat(w, 11), { power: 45, management: 20, stratagem: 72, remainPoint: 100 });
});

t('a charge that is not ceil(level / 10) is pointed out', async () => {
  const w = world();
  w.server.charge = 12;
  const r = await wh(w, 'waterhero Smarty');
  assert.match(r.text, /Holy Water: 12 used, 1,272 left — the game took 12, not the 10 that ceil\(level \/ 10\) makes it/);
});

t('one hero listed in two cities: the fresher city goes first, the other if it is refused', async () => {
  const stale = H(51, 'Att66A391', { level: 648, experience: 13129553, spent: { power: 600 } });
  const fresh = { ...stale, experience: 13129586 };
  const w = world([city(1, '9', [stale]), city(5, 'Flat', [fresh])]);
  w.server.homeOf = { 51: 1 };
  const r = await wh(w, 'waterhero Att66A391 /heropoints=att');
  assert.ok(r.ok, r.text);
  assert.match(r.text, /Att66A391 is listed in Flat and 9, which it can't be — trying Flat, the fresher entry, first/);
  assert.deepStrictEqual(w.server.resets().map((s) => s.data.castleId), [5, 1]);
  assert.match(r.text, /Flat: FAILED \(ok=-44\) - Hero doesn't exist/);
  assert.deepStrictEqual(w.server.adds().map((s) => s.data.castleId), [1], 'the points are spent where the reset landed');
});

t('a script runs it, counts it, and useheroitem reset runs the same way', async () => {
  const w = world();
  const out = [];
  const n = await script.run(w.g, script.parse('waterhero Smarty /heropoints="att"\nwaterhero Nobody\nuseheroitem Robert1 holy water'), (m) => out.push(m));
  assert.strictEqual(n, 2, out.join('\n'));
  assert.deepStrictEqual(w.server.resets().map((s) => s.data.heroId), [11, 21]);
  assert.strictEqual(held(w), 1284 - 10 - 40);
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
