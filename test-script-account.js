'use strict';
// The account commands (script-cmd-account.js), offline: items, truces, holiday
// items, the lord, quests, reports and logout. The Game is real; its socket is a
// fake client that answers each command from a small simulated server and
// records what was sent, so every request is checked as it would go out.
const path = require('path'), os = require('os'), fs = require('fs');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-account-')), 't.db');   // before anything loads db.js
const assert = require('assert');
const C = require('./constants');
const { Game } = require('./game');
const script = require('./script');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const F = (x, y) => C.coordsToFieldId(x, y);
const parseErr = (line) => { try { script.parseLine(line); } catch (e) { return e.message; } return null; };
const errorsOf = (src) => script.parse(src).filter((a) => a.cmd === 'error').map((a) => a.error);

// A socket that answers from `handlers` (a reply, or a function of the request).
function fakeClient(handlers, sent) {
  const queue = new Map();
  return {
    send(cmd, data) {
      sent.push({ cmd, data: JSON.parse(JSON.stringify(data)) });
      const h = handlers[cmd];
      const reply = typeof h === 'function' ? h(data) : h !== undefined ? h : { ok: 1 };
      if (!queue.has(cmd)) queue.set(cmd, []);
      queue.get(cmd).push(reply);
    },
    async await(cmds) {
      const cmd = cmds.find((c) => queue.has(c) && queue.get(c).length);
      if (!cmd) throw new Error('no reply to ' + cmds.join('/'));
      const r = queue.get(cmd).shift();
      if (r instanceof Error) throw r;
      return { data: r };
    },
    on() {}, off() {},
  };
}

const HASH = '5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8';

// Lord02 with two cities. `items` is what is held; `goals` gives the session
// the login's password hash, which the requests that re-ask for the password are
// signed with (evony.js passwordHash; Game.useTruce reads it).
function world({ items = {}, handlers = {}, goals = false, buffs = [], userName = 'Lord02' } = {}) {
  const g = new Game();
  g.player = {
    playerInfo: { userName, flag: 'OLD', medal: 1234, titleId: 3 },
    items: Object.entries(items).map(([id, count]) => ({ id, count })),
    buffs, selfArmys: [],
  };
  g.castles = [
    { id: 1, name: 'Home', fieldId: F(100, 100), heros: [{ id: 11, name: 'Ann', status: 0, level: 10 }, { id: 12, name: 'Bob', status: 0, level: 9 }, { id: 13, name: 'Cid', status: 0, level: 8 }] },
    { id: 2, name: 'Fla', fieldId: F(484, 619), heros: [] },
  ];
  const sent = [];
  g.c = fakeClient(handlers, sent);
  if (goals) g.c.passwordHash = () => HASH;
  return { g, sent, of: (cmd) => sent.filter((s) => s.cmd === cmd).map((s) => s.data) };
}

// Runs a script; keep(name, value) in it records a value for the test.
async function runIn(w, src, opts = {}) {
  const out = [], kept = {};
  const done = await script.run(w.g, script.parse(src), (m) => { out.push(m); if (opts.tap) opts.tap(m); }, {
    castle: 'Home', repeatGapMs: 0, ...opts, globals: { keep: (k, v) => { kept[k] = v; }, ...(opts.globals || {}) },
  });
  return { done, out, text: out.join('\n'), kept };
}
const IVORY = 'player.attackinc.1.b';

// ---------------------------------------------------------------------------
section('buyitem (BuyItem)');

t('the wiki\'s lines and OTTObot\'s id form parse to shop items', () => {
  assert.deepStrictEqual(script.parseLine('buyitem Ivory Horn'), { cmd: 'buyitem', itemId: IVORY, amount: 1, name: 'Ivory Horn' });
  assert.deepStrictEqual(script.parseLine('buyitem /count=10 Speaker'), { cmd: 'buyitem', itemId: 'consume.1.a', amount: 10, name: 'Speaker' });
  assert.deepStrictEqual(script.parseLine('buyitem player.attackinc.1 2'), { cmd: 'buyitem', itemId: 'player.attackinc.1', amount: 2, name: 'War Horn' });
  assert.strictEqual(script.parseLine('buyitem ivory horn').itemId, IVORY, 'any case');
  assert.strictEqual(script.parseLine('buyitem Speaker /count=3').amount, 3, 'the switch goes anywhere');
  assert.strictEqual(script.parseLine('buyitem player.new.thing.1').itemId, 'player.new.thing.1', 'an id newer than the catalogue still goes');
});
t('a name that is no item, a bad count or a bare amulet is refused before the run', () => {
  assert.match(parseErr('buyitem Ivory'), /no item is called "Ivory" — did you mean Ivory Horn \(player\.attackinc\.1\.b\)/);
  assert.match(parseErr('buyitem /count=0 Speaker'), /the count is a whole number from 1/);
  assert.match(parseErr('buyitem /count=ten Speaker'), /the count is a whole number from 1/);
  assert.match(parseErr('buyitem /count=2 Speaker 3'), /two counts/);
  assert.match(parseErr('buyitem /each=2 Speaker'), /unknown switch \/each/);
  assert.match(parseErr('buyitem amulet'), /say which amulet — buyitem Aries Amulet/);
  assert.match(parseErr('buyitem'), /say which item/);
});
t('it sends shop.buy with the id and the count, and shows the coins', async () => {
  const w = world();
  const r = await runIn(w, 'buyitem /count=10 Speaker\nbuyitem Ivory Horn');
  assert.deepStrictEqual(w.of('shop.buy'), [{ itemId: 'consume.1.a', amount: 10 }, { itemId: IVORY, amount: 1 }]);
  assert.match(r.text, /buy 10 x Speaker \(consume\.1\.a\) from the shop \(costs cents; you have 1,234\)/);
  assert.strictEqual(r.done, 2);
});
t('a refusal says why; a dry run sends nothing', async () => {
  const w = world({ handlers: { 'shop.buy': { ok: -12, errorMsg: 'not enough coins' } } });
  const r = await runIn(w, 'buyitem Ivory Horn\nkeep("e", $error)');
  assert.match(r.text, /FAILED \(ok=-12\) - not enough coins/);
  assert.match(r.kept.e, /not enough coins/);
  const d = world();
  const dr = await runIn(d, 'buyitem Ivory Horn', { dryRun: true });
  assert.strictEqual(d.sent.length, 0);
  assert.match(dr.text, /\[dry run\] not sent/);
});

t('more than 100 in one order takes confirm; a bare repeat after buyitem is refused when the script loads', () => {
  assert.match(parseErr('buyitem /count=101 Speaker'), /101 x Speaker in one order spends cents on more than 100 — end the line with confirm to mean it: buyitem \/count=101 Speaker confirm/);
  assert.match(parseErr('buyitem /count=1000000 Speaker'), /1,000,000 x Speaker/);
  assert.match(parseErr('buyitem consume.1.a 250'), /more than 100/);
  assert.deepStrictEqual(script.parseLine('buyitem /count=101 Speaker confirm'), { cmd: 'buyitem', itemId: 'consume.1.a', amount: 101, name: 'Speaker', confirm: true });
  assert.strictEqual(script.parseLine('buyitem consume.1.a 250 confirm').amount, 250);
  assert.strictEqual(script.parseLine('buyitem /count=100 Speaker').amount, 100, '100 needs no confirm');
  const errs = (src) => script.parse(src).filter((a) => a.cmd === 'error').map((a) => `${a.line}: ${a.error}`);
  for (const src of ['buyitem Speaker\nrepeat', 'buyitem Speaker\nrepeat 0', 'buyitem Speaker\n// note\nlabel again\nrepeat', 'if 1 buyitem Speaker\nrepeat',
    'x = "Speaker"\nbuyitem {x}\nrepeat', 'buyitem Speaker\nrepeat 3\nrepeat']) {
    assert.match(errs(src).join(' | '), /repeat after buyitem: a repeat with no count after it would buy until the cents run out — give it a count \(repeat 5\)/, src);
  }
  assert.deepStrictEqual(errs('buyitem Speaker\nrepeat 5'), [], 'a count is fine');
  assert.deepStrictEqual(errs('buyitem Speaker\necho "x"\nrepeat'), [], 'the repeat is the echo\'s');
});
t('one run buys 100 items at most in all; a confirmed order may be bigger, once', async () => {
  let w = world();
  let r = await runIn(w, 'label top\nbuyitem Speaker\ngoto top');
  assert.strictEqual(w.of('shop.buy').length, 100, 'the 101st is refused, and the refusals end the run');
  assert.match(r.text, /this run has bought 100 item\(s\) already, and 1 more would pass the 100 a run may buy — start the script again to buy more/);
  w = world();
  r = await runIn(w, 'buyitem /count=60 Speaker\nbuyitem /count=60 Ivory Horn\nkeep("e", $error)\nbuyitem /count=40 Ivory Horn');
  assert.deepStrictEqual(w.of('shop.buy'), [{ itemId: 'consume.1.a', amount: 60 }, { itemId: IVORY, amount: 40 }]);
  assert.match(r.kept.e, /bought 60 item\(s\) already, and 60 more would pass the 100/);
  w = world();
  r = await runIn(w, 'buyitem /count=250 Speaker confirm\nbuyitem Speaker\nbuyitem /count=250 Speaker confirm');
  assert.deepStrictEqual(w.of('shop.buy'), [{ itemId: 'consume.1.a', amount: 250 }]);
  // a refused order spends nothing, so it does not count
  w = world({ handlers: { 'shop.buy': { ok: -12, errorMsg: 'not enough coins' } } });
  await runIn(w, 'buyitem /count=100 Speaker\nbuyitem /count=100 Speaker');
  assert.strictEqual(w.of('shop.buy').length, 2);
  // a dry run counts as if they went, and sends nothing
  w = world();
  r = await runIn(w, 'buyitem /count=80 Speaker\nbuyitem /count=80 Speaker', { dryRun: true });
  assert.strictEqual(w.sent.length, 0);
  assert.match(r.text, /bought 80 item\(s\) already/);
});

// ---------------------------------------------------------------------------
section('useitem (UseItem)');

t('the inventory not loaded: nothing is used (the game would buy a missing item with cents)', async () => {
  const w = world();
  w.g.player.items = undefined;
  const r = await runIn(w, 'useitem Ivory Horn\nkeep("e1", $error)\nuseitem amulet\nkeep("e2", $error)\nuseitem player.box.1 3\nkeep("e3", $error)');
  assert.strictEqual(w.sent.length, 0);
  assert.match(r.kept.e1, /the inventory has not arrived, so there is no telling whether 1 x Ivory Horn is held/);
  assert.match(r.kept.e2, /the inventory has not arrived, so there is no telling which amulet is held/);
  assert.match(r.kept.e3, /whether 3 x .* are held/);
});

t('every way the wiki names an item, amulets included', () => {
  const id = (l) => script.parseLine(l).itemId;
  assert.strictEqual(id('useitem Ivory Horn'), IVORY);
  assert.strictEqual(id('useitem player.attackinc.1.b'), IVORY);
  assert.deepStrictEqual(script.parseLine('useitem amulet'), { cmd: 'useitem', itemId: null, amulet: true, amount: 1, name: 'amulet', how: 'goods' });
  assert.strictEqual(id('useitem amulet5'), 'player.box.gambling.5');
  assert.strictEqual(id('useitem amulet 3'), 'player.box.gambling.3', 'amulet 3 is the third amulet, not three amulets');
  assert.strictEqual(id('useitem Aries Amulet'), 'player.box.gambling.3');
  assert.strictEqual(id('useitem player.box.gambling.3'), 'player.box.gambling.3');
  assert.match(parseErr('useitem amulet 13'), /the amulets are 1 to 12/);
});
t('OTTObot\'s trailing count and NEAT-style /count both work', () => {
  assert.strictEqual(script.parseLine('useitem player.box.1 3').amount, 3);
  assert.strictEqual(script.parseLine('useitem /count=2 Ivory Horn').amount, 2);
  assert.strictEqual(script.parseLine('useitem Ivory Horn 2').amount, 2);
});
t('items with a command of their own point there', () => {
  assert.match(parseErr('useitem City Teleporter'), /is a teleporter — use {2}teleport/);
  assert.match(parseErr('useitem Stone of Finding'), /spent by {2}recover <hero>/);
  assert.match(parseErr('useitem Holy Water'), /Holy Water is spent on a hero by {2}waterhero <hero>/);
  assert.match(parseErr('useitem Dream Truce'), /dreamtruce hh:mm:ss {2}\(server time\)/);
  assert.match(parseErr('useitem Fleet Feet'), /used on another lord — {2}useangelitem <lord> Fleet Feet/);
  assert.match(parseErr('useitem Broken Gates'), /usedevilitem <x,y> Broken Gates {3}\(or {2}breakgates <x,y>\)/);
  assert.match(parseErr('useitem National Flag'), /changeflag <new flag>/);
  assert.match(parseErr('useitem New ID'), /changeplayername <new name> confirm/);
  assert.match(parseErr('useitem hero.power.1'), /used on a hero — {2}useheroitem <hero>/);
  assert.match(parseErr('useitem War Ensign'), /War Ensign has no Use button/);
  assert.deepStrictEqual(script.parseLine('useitem Truce Agreement'), { cmd: 'truce', itemId: 'player.peace.1' });
  assert.match(parseErr('useitem Ivroy Horn'), /no item is called "Ivroy Horn"/);
});
t('an item held goes out as shop.useGoods from the run\'s city', async () => {
  const w = world({ items: { [IVORY]: 2 } });
  const r = await runIn(w, 'useitem Ivory Horn\nkeep("e", $error)');
  assert.deepStrictEqual(w.of('shop.useGoods'), [{ castleId: 1, itemId: IVORY, num: 1 }]);
  assert.match(r.text, /use 1 x Ivory Horn \(player\.attackinc\.1\.b\) in Home/);
  assert.ok(!r.kept.e, 'no $error');
});
t('nothing is bought: an item not held fails and says to buyitem it', async () => {
  const w = world({ items: { [IVORY]: 1 } });
  const r = await runIn(w, 'useitem Tax Policy\nkeep("e1", $error)\nuseitem /count=3 Ivory Horn\nkeep("e2", $error)');
  assert.strictEqual(w.sent.length, 0);
  assert.match(r.kept.e1, /you hold no Tax Policy — NEAT would buy it; here that is {2}buyitem Tax Policy {2}\(it costs cents\)/);
  assert.match(r.kept.e2, /you hold 1 Ivory Horn, not 3 — use {2}useitem \/count=1 Ivory Horn/);
  assert.match(r.text, /nothing sent/);
});
t('useitem amulet spends the amulet held; none held says so', async () => {
  const w = world({ items: { 'player.box.gambling.3': 1, 'player.box.gambling.7': 4 } });
  await runIn(w, 'useitem amulet');
  assert.deepStrictEqual(w.of('shop.useGoods'), [{ castleId: 1, itemId: 'player.box.gambling.7', num: 1 }]);
  const n = world();
  const r = await runIn(n, 'useitem amulet\nkeep("e", $error)');
  assert.strictEqual(n.sent.length, 0);
  assert.match(r.kept.e, /you hold no amulet .* buyitem <sign> Amulet/);
});
t('Speech Text and Civil Code go through shop.useCastleGoods, one each', async () => {
  const w = world({ items: { 'player.heart.1.a': 2, 'player.pop.1.a': 1 } });
  await runIn(w, 'useitem /count=2 Speech Text\nuseitem Civil Code');
  assert.deepStrictEqual(w.of('shop.useCastleGoods'), [{ castleId: 1, itemId: 'player.heart.1.a' }, { castleId: 1, itemId: 'player.heart.1.a' }, { castleId: 1, itemId: 'player.pop.1.a' }]);
  assert.strictEqual(w.of('shop.useGoods').length, 0);
});
t('OTTObot\'s id-and-count line still sends the count', async () => {
  const w = world({ items: { 'player.box.1': 5 } });
  await runIn(w, 'useitem player.box.1 3');
  assert.deepStrictEqual(w.of('shop.useGoods'), [{ castleId: 1, itemId: 'player.box.1', num: 3 }]);
});

// ---------------------------------------------------------------------------
section('truce and dreamtruce (Truce, DreamTruce)');

t('a session that cannot sign sends no truce, and says why', async () => {
  // no password hash on this session (it never logged in with a password), so
  // Game.useTruce refuses before anything goes out
  const w = world({ items: { 'player.peace.1': 1 } });
  const r = await runIn(w, 'truce\nkeep("e", $error)');
  assert.strictEqual(w.sent.length, 0);
  assert.match(r.kept.e, /this session never logged in with a password, so it cannot sign a truce/);
});
t('with it, the truce is city.setStopWarState signed with the login\'s hash, never logged', async () => {
  const w = world({ items: { 'player.peace.1': 1 }, goals: true });
  const r = await runIn(w, 'truce\nuseitem Truce Agreement');
  assert.deepStrictEqual(w.of('city.setStopWarState'), [{ ItemId: 'player.peace.1', passWord: HASH }, { ItemId: 'player.peace.1', passWord: HASH }]);
  assert.doesNotMatch(r.text, new RegExp(HASH));
  assert.match(r.text, /12 hours in which it cannot attack or be attacked/);
});
t('no Truce Agreement held: nothing goes (the game would charge for one)', async () => {
  const w = world({ goals: true });
  const r = await runIn(w, 'truce\nkeep("e", $error)');
  assert.strictEqual(w.sent.length, 0);
  assert.match(r.kept.e, /you hold no Truce Agreement .* buyitem Truce Agreement/);
  assert.match(parseErr('truce now'), /nothing goes after it/);
});
t('dreamtruce: the wiki\'s four forms', () => {
  const at = { cmd: 'dreamtruce', hour: 10, minute: 20, second: 0 };
  assert.deepStrictEqual(script.parseLine('dreamtruce 10:20:00'), at);
  assert.deepStrictEqual(script.parseLine('dreamtruce 10:20'), at);
  assert.deepStrictEqual(script.parseLine('dreamtruce 10 20'), at);
  assert.deepStrictEqual(script.parseLine('dreamtruce /cancel'), { cmd: 'dreamtruce', cancel: true });
  assert.match(parseErr('dreamtruce 25:00'), /not a time of day/);
  assert.match(parseErr('dreamtruce soon'), /usage {2}dreamtruce 10:20:00/);
});
t('dreamtruce sets, moves or cancels with the password hash; without the update it fails', async () => {
  const none = world({ items: { 'player.truce.dream': 3 } });
  const r0 = await runIn(none, 'dreamtruce 10:20\nkeep("e", $error)');
  assert.strictEqual(none.sent.length, 0);
  assert.match(r0.kept.e, /^dreamtruce needs the goals update \(goals\/integration\)/);

  const w = world({ items: { 'player.truce.dream': 3 }, goals: true });
  const r = await runIn(w, 'dreamtruce 10:20:05\ndreamtruce /cancel');
  assert.deepStrictEqual(w.of('truce.setDreamTruce'), [{ hour: 10, minute: 20, second: 5, password: HASH }]);
  assert.deepStrictEqual(w.of('truce.cancelDreamTruce'), [{ password: HASH }]);
  assert.match(r.text, /a Dream Truce from 10:20:05 server time/);
  assert.doesNotMatch(r.text, new RegExp(HASH));

  const set = world({ goals: true, buffs: [{ typeId: 'DreamTruceBuff' }] });
  const r2 = await runIn(set, 'dreamtruce 22 0');
  assert.deepStrictEqual(set.of('truce.changeDreamTruceTime'), [{ hour: 22, minute: 0, second: 0, password: HASH }], 'a set one is moved (TruceChangeWin)');
  assert.match(r2.text, /move the Dream Truce to 22:00:00/);

  const empty = world({ goals: true });
  const r3 = await runIn(empty, 'dreamtruce 10:20\nkeep("e", $error)');
  assert.strictEqual(empty.sent.length, 0);
  assert.match(r3.kept.e, /you hold no Dream Truce/);
});

// ---------------------------------------------------------------------------
section('holiday items (UseAngelItem, UseDevilItem, BreakGates)');

t('useangelitem: the wiki\'s lines, a lord in quotes', () => {
  assert.deepStrictEqual(script.parseLine('useangelitem Bob Fleet Feet'), { cmd: 'useangelitem', lord: 'Bob', itemId: 'player.box.present.money.70', name: 'Fleet Feet' });
  assert.deepStrictEqual(script.parseLine('useangelitem "My Friend" player.box.present.money.70').lord, 'My Friend');
  assert.strictEqual(script.parseLine("useangelitem Bob Alchemist's Amplifier").itemId, 'player.box.present.money.72');
  assert.match(parseErr('useangelitem Bob Ivory Horn'), /Ivory Horn is not an Angel item/);
  assert.match(parseErr('useangelitem Bob'), /usage {2}useangelitem <lord> <item>/);
});
t('useangelitem sends shop.useAngelItem to the lord named, when held', async () => {
  const w = world({ items: { 'player.box.present.money.70': 1 } });
  await runIn(w, 'useangelitem "My Friend" Fleet Feet');
  assert.deepStrictEqual(w.of('shop.useAngelItem'), [{ playername: 'My Friend', itemId: 'player.box.present.money.70' }]);
  const n = world();
  const r = await runIn(n, 'useangelitem Bob Endurance of the Immortals\nkeep("e", $error)');
  assert.strictEqual(n.sent.length, 0);
  assert.match(r.kept.e, /you hold no Endurance of the Immortals .* buyitem Endurance of the Immortals/);
});
t('usedevilitem and breakgates: the wiki\'s lines', () => {
  const a = script.parseLine('usedevilitem 111,222 broken gates');
  assert.deepStrictEqual(a, { cmd: 'usedevilitem', x: 111, y: 222, itemId: 'player.box.present.money.77', name: 'Broken Gates', gates: 'open' });
  assert.strictEqual(script.parseLine('usedevilitem 111,222 player.box.present.money.77').itemId, 'player.box.present.money.77');
  assert.deepStrictEqual(script.parseLine('breakgates 111,222'), { cmd: 'breakgates', x: 111, y: 222, itemId: 'player.box.present.money.77', name: 'Broken Gates', gates: 'open' });
  assert.strictEqual(script.parseLine('breakgates 111, 222 /close').gates, 'close');
  assert.strictEqual(script.parseLine("usedevilitem 5,6 Opportunist's Plague").itemId, 'player.box.present.money.74');
  assert.match(parseErr('usedevilitem broken gates'), /say where first/);
  assert.match(parseErr('usedevilitem 111,222 Fleet Feet'), /not a Devil item/);
  assert.match(parseErr('usedevilitem 111,222 Poisoned Feast /close'), /\/open and \/close are for a Broken Gates/);
  assert.match(parseErr('breakgates 900,1'), /off the map/);
});
t('shop.useDevilItem carries paramdata as the client sends it', async () => {
  const w = world({ items: { 'player.box.present.money.77': 5, 'player.box.present.money.76': 1 } });
  await runIn(w, 'usedevilitem 111,222 broken gates\nbreakgates 111,222 /close\nusedevilitem 111,222 Poisoned Feast');
  assert.deepStrictEqual(w.of('shop.useDevilItem'), [
    { x: 111, y: 222, itemId: 'player.box.present.money.77', paramdata: '1' },
    { x: 111, y: 222, itemId: 'player.box.present.money.77', paramdata: '0' },
    { x: 111, y: 222, itemId: 'player.box.present.money.76', paramdata: '' },
  ]);
});
t('a Devil item on your own city is refused, except shutting your gates', async () => {
  const w = world({ items: { 'player.box.present.money.77': 5, 'player.box.present.money.74': 1 } });
  const r = await runIn(w, 'usedevilitem 100,100 Opportunist\'s Plague\nkeep("e", $error)\nbreakgates 100,100\nbreakgates 100,100 /close');
  assert.match(r.kept.e, /100,100 is your own city Home/);
  assert.match(r.text, /breakgates 100,100 \/close shuts your gates again/);
  assert.deepStrictEqual(w.of('shop.useDevilItem'), [{ x: 100, y: 100, itemId: 'player.box.present.money.77', paramdata: '0' }]);
});

// ---------------------------------------------------------------------------
section('the lord (ChangeFlag, ChangePlayerName, ResetPlayer)');

t('changeflag spends a National Flag through city.modifyFlag', async () => {
  const w = world({ items: { 'consume.changeflag.1': 1 } });
  const r = await runIn(w, 'changeflag NEAT\nkeep("r", $result)');
  assert.deepStrictEqual(w.of('city.modifyFlag'), [{ newFlag: 'NEAT' }]);
  assert.strictEqual(w.g.player.playerInfo.flag, 'NEAT');
  assert.strictEqual(r.kept.r, 'NEAT');
  assert.match(parseErr('changeflag NEATO'), /4 characters at most/);
  assert.match(parseErr('changeflag "A B"'), /no quote, backslash or space/);
  const n = world();
  const r2 = await runIn(n, 'changeflag NEAT\nkeep("e", $error)');
  assert.strictEqual(n.sent.length, 0);
  assert.match(r2.kept.e, /you hold no National Flag .* buyitem National Flag/);
});
t('changeplayername needs confirm, then renames through city.modifyUserName', async () => {
  assert.match(parseErr('changeplayername !NeatLover'), /renames the lord for good and spends a New ID — add {2}confirm {2}to mean it: {2}changeplayername !NeatLover confirm/);
  assert.match(parseErr('changeplayername Neat Lover confirm'), /no spaces/);
  assert.match(parseErr('changeplayername AVeryLongName1 confirm'), /10 letters at most/);
  const w = world({ items: { 'player.name.1.a': 1 } });
  const r = await runIn(w, 'changeplayername !NeatLover confirm\nkeep("r", $result)');
  assert.deepStrictEqual(w.of('city.modifyUserName'), [{ userName: '!NeatLover', itemId: 'player.name.1.a' }]);
  assert.strictEqual(w.g.player.playerInfo.userName, '!NeatLover', 'a reconnect is followed onto the renamed lord');
  assert.strictEqual(r.kept.r, '!NeatLover');
});
const RESET_FULL = 'resetplayer { unlockcode:"IReallyWantToDeleteThisAccount", player:"NeatRox", city:"MyCity", flag:"NEAT", sex:0, zone:"Romagna", runscript:"SomeScript.txt" }';
const RESET_NULL = 'resetplayer { unlockcode:"IReallyWantToDeleteThisAccount", player:null }';
const ACCOUNT = require('./script-cmd-account');
t('resetplayer is refused unless the console was started with OTTO_ALLOW_RESET_PLAYER=1', () => {
  ACCOUNT.ALLOW.resetPlayer = false;
  assert.match(parseErr(RESET_NULL), /resetplayer is off in this console: .*OTTO_ALLOW_RESET_PLAYER=1/);
  ACCOUNT.ALLOW.resetPlayer = true;          // the tests below are the switched-on console
});
t('resetplayer: the unlock code, and only the reset-and-close form', () => {
  assert.deepStrictEqual(script.parseLine(RESET_NULL), { cmd: 'resetplayer', player: null });
  assert.deepStrictEqual(script.parseLine('resetplayer { unlockcode:"IReallyWantToDeleteThisAccount", player:"" }'), { cmd: 'resetplayer', player: null });
  assert.match(parseErr(RESET_FULL), /only {2}player:null {2}works here .*common\.createNewPlayer/);
  assert.match(parseErr('resetplayer { unlockcode:"IReallyWantToDeleteThisAccount" }'), /only {2}player:null/);
  assert.match(parseErr('resetplayer { unlockcode:"ireallywanttodeletethisaccount", player:null }'), /the unlock code is the text IReallyWantToDeleteThisAccount, written exactly/);
  assert.match(parseErr('resetplayer { player:null }'), /the unlock code/);
  assert.match(parseErr('resetplayer { unlockcode:"IReallyWantToDeleteThisAccount", player:null, age:3 }'), /there is no field "age"/);
  assert.match(parseErr('resetplayer { unlockcode:"IReallyWantToDeleteThisAccount", player:null, city:"X" }'), /city is for a new lord/);
  assert.match(parseErr('resetplayer'), /usage {2}resetplayer \{ unlockcode:/);
  assert.match(parseErr('resetplayer yes'), /usage/);
});
t('resetplayer deletes with the hash, ends the run and stands the console down', async () => {
  const none = world();
  const r0 = await runIn(none, RESET_NULL + '\nkeep("e", $error)');
  assert.strictEqual(none.sent.length, 0);
  assert.match(r0.kept.e, /^resetplayer needs the goals update/);

  const w = world({ goals: true });
  const plans = [];
  const r = await runIn(w, RESET_NULL + '\necho after', { session: { logoutUntil: (at, why) => plans.push({ at, why }) } });
  assert.deepStrictEqual(w.of('common.deleteUserAndRestart'), [{ pwd: HASH }]);
  assert.doesNotMatch(r.text, /after/, 'nothing runs after the lord is gone');
  assert.strictEqual(plans.length, 1);
  assert.ok(plans[0].at > Date.now() + 300 * 86400000 && /press Connect/.test(plans[0].why));
  assert.doesNotMatch(r.text, new RegExp(HASH));

  const sec = world({ goals: true, handlers: { 'common.deleteUserAndRestart': { ok: -200, errorMsg: 'security code' } } });
  const r2 = await runIn(sec, RESET_NULL + '\necho after');
  assert.match(r2.text, /needs its security code and it could not be used[\s\S]*nothing was deleted/);
  assert.match(r2.text, /after/);

  const dry = world({ goals: true });
  await runIn(dry, RESET_NULL, { dryRun: true });
  assert.strictEqual(dry.sent.length, 0);
});

// ---------------------------------------------------------------------------
section('completequests (CompleteQuests)');

// Routine types Rebuild, Promotion, Commodity Gathering, Domain Expansion; one
// Daily type. Claiming Major uses up what Baronet needed, the way NEAT says
// plain routine "would accept major before baronet".
function questWorld(opts = {}) {
  const S = {
    types: {
      1: [{ typeId: 10, mainId: 1, name: 'Rebuild' }, { typeId: 11, mainId: 1, name: 'Promotion' },
        { typeId: 12, mainId: 1, name: 'Commodity Gathering' }, { typeId: 13, mainId: 1, name: 'Domain Expansion' }],
      3: [{ typeId: 30, mainId: 3, name: 'Daily Quests' }],
    },
    quests: {
      10: [{ questId: 101, name: 'Build a Cottage', isFinish: true, award: '500 food', targets: [{ name: 'Cottage level 1', finished: true }] },
        { questId: 102, name: 'Population Increase', isFinish: false, targets: [{ name: 'Population 500', finished: false }] }],
      11: [{ questId: 111, name: 'Major', isFinish: true }, { questId: 112, name: 'Baronet', isFinish: true }],
      12: [{ questId: 121, name: 'Farming', isFinish: true, award: '1000 food' },
        { questId: 122, name: 'Lumbering', isFinish: false, targets: [{ name: 'Scout city', finished: false }, { name: 'Sawmill level 2', finished: true }] }],
      13: [],
      30: [{ questId: 301, name: 'Login daily and you will get this great gift!', isFinish: true, award: '1 x Aries Amulet' }],
    },
  };
  const handlers = {
    'quest.getQuestType': (d) => ({ ok: 1, types: (S.types[d.type] || []).map((ty) => ({ ...ty, isFinish: S.quests[ty.typeId].some((q) => q.isFinish) })) }),
    'quest.getQuestList': (d) => ({ ok: 1, quests: JSON.parse(JSON.stringify(S.quests[d.typeId] || [])) }),
    'quest.award': (d) => {
      if (opts.refuse) return { ok: -3, errorMsg: 'bag is full' };
      for (const list of Object.values(S.quests)) {
        const i = list.findIndex((q) => q.questId === d.questId);
        if (i < 0) continue;
        if (!list[i].isFinish) return { ok: -1, errorMsg: 'not finished' };
        const [q] = list.splice(i, 1);
        if (q.name === 'Major' || q.name === 'Baronet') for (const p of S.quests[11]) p.isFinish = false;
        return { ok: 1 };
      }
      return { ok: -1, errorMsg: 'no such quest' };
    },
    ...(opts.handlers || {}),
  };
  const w = world({ handlers });
  w.S = S;
  w.claimed = () => w.of('quest.award').map((d) => d.questId);
  return w;
}

t('every line on the wiki parses, and the "same as above" lines mean the same', () => {
  const lines = [
    'completequests', 'completequests daily', 'completequests routine', 'completequests title', 'completequests rank',
    'completequests /type="Rebuild"', 'completequests /query="all"', 'completequests /mode=routine',
    'completequests /type=rebuild,promotion', 'completequests routine /type=Rebuild,Promotion',
    'completequests /mode=routine Rebuild,Promotion', 'completequests routine Rebuild,Promotion',
    'completequests /type="Domain Expansion,Commodity Gathering"', 'completequests /name="Population Increase"',
    'completequests routine /name="Population Increase"', 'completequests /name=farming',
    'completequests /mode=routine /name=farming /type="Commodity Gathering"', 'completequests routine /type="Commodity Gathering" farming',
    'completequests routine "Commodity Gathering" farming', 'completequests office',
    'completequests /type=Promotion /name=Knight,Baronet,Baron,Viscount,Earl,Marquis,Duke,Furstin,Prinzessin',
    'completequests /type=Promotion /name=Lieutenant,Captain,Major,Colonel,General',
    'completequests /query=finished /type=Rebuild', 'completequests /query=available',
  ];
  assert.deepStrictEqual(errorsOf(lines.join('\n')), []);
  const p = (l) => { const a = script.parseLine(l); return JSON.stringify([a.modes, (a.types || []).map((x) => x.toLowerCase()), a.names && a.names.map((x) => x.toLowerCase()), a.query]); };
  assert.strictEqual(p('completequests /mode=routine'), p('completequests routine'));
  const rp = p('completequests /type=rebuild,promotion');
  for (const l of lines.slice(9, 12)) assert.strictEqual(p(l), rp, l);
  const farm = p('completequests /mode=routine /name=farming /type="Commodity Gathering"');
  assert.strictEqual(p('completequests routine /type="Commodity Gathering" farming'), farm);
  assert.strictEqual(p('completequests routine "Commodity Gathering" farming'), farm);
  assert.strictEqual(p('completequests /name="Population Increase"'), p('completequests routine /name="Population Increase"'));
  assert.deepStrictEqual(script.parseLine('completequests title').names, ['Knight', 'Baronet', 'Baron', 'Viscount', 'Earl', 'Marquis', 'Duke', 'Furstin', 'Prinzessin']);
  assert.deepStrictEqual(script.parseLine('completequests office').names, script.parseLine('completequests rank').names);
  assert.deepStrictEqual(script.parseLine('completequests').modes, ['routine', 'daily'], 'nothing given: both tabs');
  assert.deepStrictEqual(script.parseLine('completequests /query=all').modes, ['routine'], 'routine is assumed with /query alone');
});
t('bad switches and values are refused before the run', () => {
  assert.match(parseErr('completequests /query=some'), /\/query is available, finished or all/);
  assert.match(parseErr('completequests /mode=weekly'), /\/mode is routine or daily/);
  assert.match(parseErr('completequests /foo=1'), /there is no \/foo/);
  assert.match(parseErr('completequests routine Rebuild farming extra'), /unexpected "extra"/);
  assert.match(parseErr('completequests daily title'), /promotions are routine quests/);
  assert.match(parseErr('completequests title /type=Rebuild'), /title means the Promotion quests/);
});
t('completequests claims every finished quest on both tabs, promotions in the game\'s order', async () => {
  const w = questWorld();
  const r = await runIn(w, 'completequests\nkeep("r", $result)\nkeep("e", $error)');
  assert.deepStrictEqual(w.claimed(), [101, 111, 121, 301], r.text);
  assert.deepStrictEqual(w.of('quest.getQuestType').map((d) => [d.castleId, d.type]), [[1, 1], [1, 3]]);
  assert.ok(!w.of('quest.getQuestList').some((d) => d.typeId === 13), 'a type with nothing finished is not opened');
  assert.deepStrictEqual(r.kept.r.map((q) => q.name), ['Build a Cottage', 'Major', 'Farming', 'Login daily and you will get this great gift!']);
  assert.deepStrictEqual([r.kept.r[0].type, r.kept.r[0].mode, r.kept.r[0].claimed, r.kept.r[0].award], ['Rebuild', 'routine', true, '500 food']);
  assert.match(r.text, /claim Farming \(Commodity Gathering\) -> ok — 1000 food/);
  assert.match(r.text, /claimed 4 quests/);
  assert.ok(!r.kept.e);
});
t('title claims the title promotion, rank the military one', async () => {
  const w = questWorld();
  await runIn(w, 'completequests title');
  assert.deepStrictEqual(w.claimed(), [112]);
  const r = questWorld();
  await runIn(r, 'completequests rank');
  assert.deepStrictEqual(r.claimed(), [111]);
  const o = questWorld();
  await runIn(o, 'completequests /type=Promotion /name=Knight,Baronet,Baron,Viscount,Earl,Marquis,Duke,Furstin,Prinzessin');
  assert.deepStrictEqual(o.claimed(), [112], 'the long form of title');
});
t('daily, a type, and a name narrow what is claimed', async () => {
  const d = questWorld();
  await runIn(d, 'completequests daily');
  assert.deepStrictEqual(d.claimed(), [301]);
  const ty = questWorld();
  await runIn(ty, 'completequests /type=rebuild,promotion');
  assert.deepStrictEqual(ty.claimed(), [101, 111]);
  const n = questWorld();
  await runIn(n, 'completequests routine "Commodity Gathering" farming');
  assert.deepStrictEqual(n.claimed(), [121]);
  assert.deepStrictEqual(n.of('quest.getQuestList').map((x) => x.typeId), [12, 12], 'only that type, read again after the claim');
});
t('/query claims nothing and hands the quests to the script (the wiki\'s examples)', async () => {
  const w = questWorld();
  const r = await runIn(w, [
    '// assuming quests auto-completion is disabled',
    'completequests /query=finished /type=Rebuild',
    'quests = $result',
    'if quests.length > 0 echo "We have completed, but unclaimed quests of Rebuild type"',
    'completequests /query=available',
    'quests = $result',
    'names = quests.map(CreateFunction("v,i,a","v.name"))',
    'if names.length > 0 echo "Available quests: " + names.join("\\n")',
    'keep("names", names)',
  ].join('\n'));
  assert.strictEqual(w.of('quest.award').length, 0);
  assert.match(r.text, /We have completed, but unclaimed quests of Rebuild type/);
  assert.deepStrictEqual(r.kept.names, ['Population Increase', 'Lumbering']);
  assert.match(r.text, /Available quests: Population Increase\n {2}Lumbering/);
});
t('the targets example: targetsArray.toArray() and each target\'s finished', async () => {
  const w = questWorld();
  const r = await runIn(w, [
    'addFinishedTargets = CreateFunction("v,i,a","v.finished || targets.push(v.name)")',
    'checkTargets = CreateFunction("v,i,a","v.targetsArray.toArray().forEach(addFinishedTargets)")',
    'completequests /query=available',
    'quests = $result',
    'targets = []',
    'quests.forEach(checkTargets)',
    'if targets.length > 0 echo "Available targets: " + targets.join("\\n")',
    'keep("targets", targets)',
    'completequests /query=all',
    'keep("all", $result.length)',
  ].join('\n'));
  assert.deepStrictEqual(r.kept.targets, ['Population 500', 'Scout city'], r.text);
  assert.strictEqual(r.kept.all, 6, 'all: every routine quest, finished or not');
});
t('a refused claim is logged; the line fails only when nothing was claimed', async () => {
  const w = questWorld({ refuse: true });
  const r = await runIn(w, 'completequests daily\nkeep("e", $error)\nkeep("r", $result)');
  assert.deepStrictEqual(w.claimed(), [301], 'tried once, not again and again');
  assert.match(r.kept.e, /bag is full/);
  assert.deepStrictEqual(r.kept.r, []);
  const d = questWorld();
  const dr = await runIn(d, 'completequests', { dryRun: true });
  assert.strictEqual(d.sent.length, 0);
  assert.match(dr.text, /claim every finished routine and daily quest\n {2}\[dry run\] not sent/);
});

// ---------------------------------------------------------------------------
section('reports (CleanReports, CleanNpcReports)');

function reportWorld({ transports = 0 } = {}) {
  const R = {
    0: [{ id: 1, title: 'Trade completed', targetPos: 'Home(100,100)' }],
    1: [
      { id: 10, armyType: 5, title: "Attack Barbarian's city", targetPos: "Barbarian's city(111,222)", startPos: 'Home(100,100)' },
      { id: 11, armyType: 5, back: true, title: 'Troops returned', startPos: "Barbarian's city(111,222)", targetPos: 'Home(100,100)' },
      { id: 12, armyType: 5, title: 'Attack Lord22', targetPos: 'Lord22(300,300)', startPos: 'Home(100,100)' },
      { id: 13, armyType: 1, title: 'Transport arrived', targetPos: 'Fla(484,619)', startPos: 'Home(100,100)' },
      { id: 14, armyType: 3, title: "Scout Barbarian's city", targetPos: "Barbarian's city(5,5)", startPos: 'Home(100,100)' },
      { id: 15, armyType: 2, title: 'Reinforcement arrived', targetPos: 'Lake Troops(1,1)', startPos: 'Home(100,100)' },
      ...Array.from({ length: transports }, (_, i) => ({ id: 1000 + i, armyType: 1, title: 'Transport arrived', targetPos: 'Fla(484,619)' })),
    ],
    2: [{ id: 20, title: 'Lake troops lost' }, { id: 21, title: 'Welcome' }],
  };
  const handlers = {
    'report.receiveReportList': (d) => {
      const all = R[d.reportType];
      return { ok: 1, pageNo: d.pageNo, totalPage: Math.max(1, Math.ceil(all.length / d.pageSize)), reports: all.slice((d.pageNo - 1) * d.pageSize, d.pageNo * d.pageSize) };
    },
    'report.deleteReport': (d) => {
      const ids = new Set(String(d.idStr).split(',').map(Number));
      for (const k of Object.keys(R)) R[k] = R[k].filter((r) => !ids.has(r.id));
      return { ok: 1 };
    },
  };
  const w = world({ handlers });
  w.R = R;
  w.left = () => Object.values(R).flat().map((r) => r.id).sort((a, b) => a - b);
  return w;
}

t('the wiki\'s lines and OTTObot\'s kinds parse', () => {
  assert.deepStrictEqual(script.parseLine('cleanreports'), { cmd: 'cleanreports', type: null, search: [] });
  assert.deepStrictEqual(script.parseLine('cleanreports barbarian').search, ['barbarian']);
  assert.deepStrictEqual(script.parseLine('cleanreports troops,lake').search, ['troops', 'lake']);
  assert.deepStrictEqual(script.parseLine('cleanreports army'), { cmd: 'cleanreports', type: 'army' });
  assert.deepStrictEqual(script.parseLine('cleanreports "army"').search, ['army'], 'in quotes it is a text');
  assert.deepStrictEqual(script.parseLine("cleanreports Barbarian's city").search, ["Barbarian's city"]);
  assert.deepStrictEqual(script.parseLine('cleannpcreports'), { cmd: 'cleannpcreports' });
  assert.match(parseErr('cleannpcreports all'), /nothing goes after it/);
});
t('cleanreports with no text deletes every report of every kind', async () => {
  const w = reportWorld();
  const r = await runIn(w, 'cleanreports\nkeep("r", $result)');
  assert.deepStrictEqual(w.left(), []);
  assert.strictEqual(r.kept.r, 9);
  assert.deepStrictEqual([...new Set(w.of('report.receiveReportList').map((d) => d.reportType))], [0, 1, 2], 'each kind in turn');
});
t('a text matches the subject or the "to", any case, and a comma list matches any', async () => {
  const b = reportWorld();
  await runIn(b, 'cleanreports barbarian');
  assert.deepStrictEqual(b.left(), [1, 11, 12, 13, 15, 20, 21], 'the subjects of 10 and 14; 11 names it only as where it came from');
  const tl = reportWorld();
  const r = await runIn(tl, 'cleanreports troops,lake\nkeep("r", $result)');
  assert.deepStrictEqual(tl.left(), [1, 10, 12, 13, 14, 21]);
  assert.strictEqual(r.kept.r, 3);
  assert.match(r.text, /removed 3 report\(s\) of 9 looked at/);
});
t('cleanreports army keeps OTTObot\'s meaning: every army report', async () => {
  const w = reportWorld();
  await runIn(w, 'cleanreports army');
  assert.deepStrictEqual(w.left(), [1, 20, 21]);
  assert.deepStrictEqual([...new Set(w.of('report.receiveReportList').map((d) => d.reportType))], [1]);
});
t('cleannpcreports: Barbarian attacks and their returns, and transports; nothing else', async () => {
  const w = reportWorld({ transports: 120 });
  const r = await runIn(w, 'cleannpcreports\nkeep("r", $result)');
  assert.deepStrictEqual(w.left(), [1, 12, 14, 15, 20, 21]);
  assert.strictEqual(r.kept.r, 123);
  // page 1 read, its picks deleted, read again as the rest move up (asked with the delete, twice the size) — until it keeps only 12, 14, 15
  assert.ok(w.of('report.receiveReportList').every((d) => d.reportType === 1 && d.pageNo === 1), 'deletes as it reads');
  assert.deepStrictEqual(w.of('report.deleteReport').map((d) => d.idStr.split(',').length), [47, 76]);
  assert.match(r.text, /removed 123 of 126 army report\(s\)/);
});
t('cleanreports on a big account deletes page 1 over and over, and a filter walks past pages it keeps', async () => {
  const w = reportWorld({ transports: 5000 });
  const r = await runIn(w, 'cleanreports army\nkeep("r", $result)');
  assert.strictEqual(r.kept.r, 5006);
  assert.ok(w.of('report.receiveReportList').every((d) => d.pageNo === 1), 'never past page 1');
  assert.ok(w.of('report.deleteReport').length < 15, 'the page grows: 5,006 reports in a handful of deletes, not 101');
  const k = reportWorld({ transports: 200 });
  for (let i = 0; i < 120; i++) k.R[1].unshift({ id: 5000 + i, armyType: 5, title: 'Attack Lord22', targetPos: 'Lord22(300,300)' });
  await runIn(k, 'cleannpcreports');
  assert.strictEqual(k.R[1].filter((x) => x.armyType === 1).length, 0, 'transports behind two pages of kept reports go too');
  assert.deepStrictEqual(k.of('report.receiveReportList').map((d) => d.pageNo).slice(0, 3), [1, 2, 3]);
});
t('cleanreports asks again when a page goes unanswered, and keeps what it deleted when it gives up', async () => {
  const w = reportWorld({ transports: 120 });
  let calls = 0;
  const orig = w.g.reportList.bind(w.g);
  // the read sent with the first delete and the first ordinary read again both fail; the next answers
  w.g.reportList = (...a) => (++calls === 2 || calls === 3 ? Promise.reject(new Error('no reply to report.receiveReportList')) : orig(...a));
  const r = await runIn(w, 'cleannpcreports\nkeep("r", $result)', { reportWaitMs: 0 });
  assert.strictEqual(r.kept.r, 123);
  assert.match(r.text, /no reply to report\.receiveReportList — asking again/);
  const dead = reportWorld({ transports: 120 });
  let n = 0;
  const o2 = dead.g.reportList.bind(dead.g);
  dead.g.reportList = (...a) => (++n >= 2 ? Promise.reject(new Error('no reply to report.receiveReportList')) : o2(...a));
  const r2 = await runIn(dead, 'cleannpcreports', { reportWaitMs: 0 });
  assert.match(r2.text, /47 report\(s\) removed before it/);
  assert.strictEqual(dead.R[1].length, 126 - 47, 'the first page\'s deletes stay done');
});
// An account with `total` trade reports and a server with quirks: it hands out at most
// `pageCap` a page (and works out totalPage by that), refuses or ignores a page bigger
// than `refuseAbove` / `silentAbove`, refuses a delete of more than `idCap` ids, and with
// `lateDelete` answers a read sent behind a delete before it has done the delete.
function bigReportWorld({ total, pageCap = Infinity, refuseAbove = Infinity, silentAbove = Infinity, idCap = Infinity, lateDelete = false, deaf = false, stallAt = 0 }) {
  let reads = 0;
  let rows = Array.from({ length: total }, (_, i) => ({ id: i + 1, title: 'Trade completed' }));
  let owed = null;   // a delete not done yet (lateDelete)
  const apply = (ids) => { const gone = new Set(ids); rows = rows.filter((r) => !gone.has(r.id)); };
  const handlers = {
    'report.receiveReportList': (d) => {
      if (d.reportType !== 0) return { ok: 1, pageNo: 1, totalPage: 1, reports: [] };
      // stallAt: the server goes silent on ONE read of a page it has answered before (a busy account)
      if (stallAt && ++reads === stallAt) return new Error('no reply to report.receiveReportList');
      if (d.pageSize > silentAbove) return new Error('no reply to report.receiveReportList');
      if (d.pageSize > refuseAbove) return { ok: -1, errorMsg: 'page size too big' };
      const size = Math.min(d.pageSize, pageCap);
      const out = { ok: 1, pageNo: d.pageNo, totalPage: Math.max(1, Math.ceil(rows.length / size)), reports: rows.slice((d.pageNo - 1) * size, d.pageNo * size) };
      if (owed) { apply(owed); owed = null; }
      return out;
    },
    'report.deleteReport': (d) => {
      const ids = String(d.idStr).split(',').map(Number);
      if (ids.length > idCap) return { ok: -1, errorMsg: 'too many' };
      if (deaf) return { ok: 1 };
      if (lateDelete) owed = ids; else apply(ids);
      return { ok: 1 };
    },
  };
  const w = world({ handlers });
  w.left = () => rows.length;
  return w;
}
const sizesOf = (w) => w.of('report.receiveReportList').filter((d) => d.reportType === 0).map((d) => d.pageSize);

t('a big account: the page grows, the read rides with the delete, and 250,000 reports go in a few hundred requests', async () => {
  const w = bigReportWorld({ total: 250000 });
  const r = await runIn(w, 'cleanreports trade\nkeep("r", $result)');
  assert.strictEqual(w.left(), 0);
  assert.strictEqual(r.kept.r, 250000);
  const sizes = sizesOf(w);
  assert.deepStrictEqual(sizes.slice(0, 6), [50, 100, 200, 400, 800, 1000], 'doubles up to the ceiling');
  assert.ok(Math.max(...sizes) === 1000 && w.of('report.deleteReport').length < 300, 'a delete of 1,000 ids at a time');
  assert.ok(!/pages of/.test(r.text), 'nothing to complain about');
});
t('a server that hands out 50 a page however much is asked for: found out once, then 50', async () => {
  const w = bigReportWorld({ total: 5000, pageCap: 50 });
  const r = await runIn(w, 'cleanreports trade\nkeep("r", $result)');
  assert.strictEqual(w.left(), 0);
  assert.strictEqual(r.kept.r, 5000);
  assert.match(r.text, /the server gives 50 to a page — pages of 50 from here/);
  assert.deepStrictEqual(sizesOf(w).slice(0, 3), [50, 100, 50]);
});
t('a page size the server refuses or does not answer: back to the last one that worked', async () => {
  const refused = bigReportWorld({ total: 3000, refuseAbove: 50 });
  const r1 = await runIn(refused, 'cleanreports trade\nkeep("r", $result)');
  assert.strictEqual(refused.left(), 0);
  assert.strictEqual(r1.kept.r, 3000);
  assert.match(r1.text, /a page of 100 was refused — pages of 50 from here/);
  const silent = bigReportWorld({ total: 6000, silentAbove: 200 });
  const r2 = await runIn(silent, 'cleanreports trade\nkeep("r", $result)', { reportWaitMs: 0 });
  assert.strictEqual(silent.left(), 0);
  assert.strictEqual(r2.kept.r, 6000);
  assert.match(r2.text, /a page of 400 was no reply to report.receiveReportList — pages of 200 from here/);
  assert.ok(Math.max(...sizesOf(silent).slice(sizesOf(silent).indexOf(400) + 1)) <= 200, 'never above 200 again');
});
t('a page that worked and then goes unanswered is asked again smaller, and no bigger page is tried again', async () => {
  const w = bigReportWorld({ total: 30000, stallAt: 7 });
  const r = await runIn(w, 'cleanreports trade' + String.fromCharCode(10) + 'keep("r", $result)', { reportWaitMs: 0 });
  assert.strictEqual(w.left(), 0);
  assert.strictEqual(r.kept.r, 30000);
  assert.match(r.text, /no answer to a page of 1000 — pages of 500 from here/);
  const sizes = sizesOf(w), at = sizes.indexOf(500);
  assert.ok(at > 0 && Math.max(...sizes.slice(at)) <= 500, 'never above 500 after that: ' + sizes.join(','));
});
t('a delete of more ids than the server takes is sent in pieces of what it does take', async () => {
  const w = bigReportWorld({ total: 3000, idCap: 100 });
  const r = await runIn(w, 'cleanreports trade\nkeep("r", $result)');
  assert.strictEqual(w.left(), 0);
  assert.strictEqual(r.kept.r, 3000);
  assert.match(r.text, /at once was refused — pages of 100 from here/);
  assert.ok(w.of('report.deleteReport').every((d) => d.idStr.split(',').length <= 200), 'nothing over the size it had taken');
});
t('a read the server answers before it has done the delete is read again, not counted twice', async () => {
  const w = bigReportWorld({ total: 1000, lateDelete: true });
  const r = await runIn(w, 'cleanreports trade\nkeep("r", $result)');
  assert.strictEqual(w.left(), 0);
  assert.strictEqual(r.kept.r, 1000, 'each report counted once');
  assert.ok(!/kept reports it said it deleted/.test(r.text));
});
t('a delete the game says ok to and does not do stops the run, however many pages it asked for', async () => {
  const w = bigReportWorld({ total: 500, deaf: true });
  const r = await runIn(w, 'cleanreports trade\nkeep("r", $result)');
  assert.match(r.text, /the game kept reports it said it deleted — stopped/);
  assert.strictEqual(w.left(), 500);
  assert.ok(w.of('report.deleteReport').length <= 3, 'stops at the first repeat');
});
t('a dry run deletes nothing', async () => {
  const w = reportWorld();
  const r = await runIn(w, 'cleanreports\ncleannpcreports', { dryRun: true });
  assert.strictEqual(w.sent.length, 0);
  assert.match(r.text, /delete every report there is\n {2}\[dry run\] not sent/);
});

// ---------------------------------------------------------------------------
section('logout (Logout)');

// The session: a script's logout stands it down; `backIn` later it logs in
// again as `as` (a fresh Game, the way the supervisor makes one).
function consoleSession(w, { backIn = 30, as = 'Lord02' } = {}) {
  const s = { connected: true, game: w.g, plans: [], flags: [] };
  s.logoutUntil = (at, why) => {
    s.plans.push({ at, why });
    s.connected = false;
    setTimeout(() => {
      const g = new Game();
      g.player = { playerInfo: { userName: as }, items: [], buffs: [], selfArmys: [] };
      g.castles = w.g.castles.map((c) => ({ ...c, heros: c.heros.map((h) => ({ ...h })) }));
      g.newArmy = async (castleId, bean) => { w.sent.push({ cmd: 'newArmy', data: { castleId, bean, on: 'new' } }); return { ok: 1 }; };
      s.game = g;
      s.connected = true;
    }, backIn);
  };
  return s;
}

t('NEAT\'s forms carry on; `logout now` still ends the run', () => {
  assert.deepStrictEqual(script.parseLine('logout @:01:30:31 @:06:35:00'),
    { cmd: 'logout', out: { at: { h: 1, m: 30, s: 31, ms: 0 } }, back: { at: { h: 6, m: 35, s: 0, ms: 0 } }, resume: true });
  assert.deepStrictEqual(script.parseLine('logout 1:00 29:00'), { cmd: 'logout', out: { wait: 60 }, back: { wait: 1740 }, resume: true });
  assert.deepStrictEqual(script.parseLine('logout now @:14:35'), { cmd: 'logout', out: { wait: 0 }, back: { at: { h: 14, m: 35, s: 0, ms: 0 } } });
  // the Logout page's spam waves, with its "1: " line numbers
  assert.deepStrictEqual(errorsOf('1: logout 1:00 29:00\n2: attack 400,400 any c:1000,s:1000\n3: repeat 3\n4: sleep 45\n5: loop'), []);
  assert.match(errorsOf('logout now 1:05:00\necho too late')[0], /nothing can run after logout/);
  assert.match(parseErr('logout 1:00'), /say when to log out and when to log back in/);
});
t('the spam-wave example: off, back on, three waves on the new connection', async () => {
  const w = world();
  w.g.newArmy = async (castleId, bean) => { w.sent.push({ cmd: 'newArmy', data: { castleId, bean, on: 'old' } }); return { ok: 1 }; };
  const s = consoleSession(w);
  const flags = [];
  // the minute before the logout goes by at once
  const tap = (m) => { if (/log out at/.test(m)) w.g.serverOffset += 60000; };
  const src = 'logout 1:00 29:00\nattack 400,400 any c:1000,s:1000\nrepeat 3\nsleep 45\nloop';
  const r = await runIn(w, src, { session: s, tap, atLogout: (v) => flags.push(v), shouldStop: () => w.of('newArmy').length >= 3 });
  const armies = w.of('newArmy');
  assert.strictEqual(armies.length, 3, r.text);
  assert.ok(armies.every((a) => a.on === 'new'), 'every wave goes out on the connection made after the logout');
  assert.deepStrictEqual([armies[0].bean.targetPoint, armies[0].bean.troops.lightCavalry, armies[0].bean.troops.scouter], [F(400, 400), 1000, 1000]);
  assert.strictEqual(s.plans.length, 1);
  assert.ok(Math.abs(s.plans[0].at - (Date.now() + 1740000)) < 5000, 'back 29 minutes after the logout');
  assert.match(r.text, /and the script carries on after that/);
  assert.match(r.text, /back on the game at .* — the script carries on/);
  assert.match(r.text, /\(run 3 of 3\)/);
  assert.deepStrictEqual(flags, [true, false, true, false], 'counted as at a logout while it goes, and while it waits to come back');
});
t('loop brings it back to the logout for the next round', async () => {
  const w = world();
  const s = consoleSession(w, { backIn: 20 });
  let rounds = 0;
  const lo = s.logoutUntil;
  s.logoutUntil = (at, why) => { rounds++; s.game = w.g; lo(at, why); };
  const r = await runIn(w, 'logout 0 1:00\necho wave\nloop', { session: s, shouldStop: () => rounds >= 2 && s.connected });
  assert.strictEqual(rounds, 2, r.text);
  assert.strictEqual((r.text.match(/ {2}wave/g) || []).length, 1, 'one wave between the two logouts');
});
t('a dry run stays on and goes on; Stop while off ends it; another account ends it', async () => {
  const d = world();
  const dr = await runIn(d, 'logout 1:00 29:00\necho next', { dryRun: true, session: consoleSession(d) });
  assert.match(dr.text, /\[dry run\] staying logged in[\s\S]*next/);

  const w = world();
  const s = consoleSession(w, { backIn: 100000 });
  let stop = false;
  setTimeout(() => { stop = true; }, 300);
  const r = await runIn(w, 'logout 0 1:00\necho next', { session: s, shouldStop: () => stop });
  assert.match(r.text, /stopped — the console stays off until/);
  assert.doesNotMatch(r.text, /\n {2}next/);

  const o = world();
  const r2 = await runIn(o, 'logout 0 1:00\necho next\nkeep("e", $error)', { session: consoleSession(o, { as: 'Lord22' }) });
  assert.match(r2.text, /logged in as Lord22 now, not Lord02 — the script ends here/);
  assert.doesNotMatch(r2.text, /\n {2}next/);
});
t('logout now still ends the run where it is', async () => {
  const w = world();
  const s = consoleSession(w);
  const r = await runIn(w, 'echo before\nlogout now 1:00', { session: s });
  assert.strictEqual(s.plans.length, 1);
  assert.match(r.text, /logged out until/);
  assert.doesNotMatch(r.text, /carries on/);
});

// ---------------------------------------------------------------------------
section('packages (unchanged)');

t('packages lists the city\'s packages', async () => {
  const w = world({ handlers: { 'common.getPackageList': { ok: 1, packages: [{ id: 7, packageName: 'Starter', status: 0, itemList: [1, 2] }] } } });
  const r = await runIn(w, 'packages\ninventory');
  assert.deepStrictEqual(w.of('common.getPackageList'), [{ castleId: 1 }, { castleId: 1 }]);
  assert.match(r.text, /\[7\] Starter \(status 0, 2 item\(s\)\)/);
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
