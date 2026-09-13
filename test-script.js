'use strict';
// The script language's marches and repeats, offline. The Game is real (castle
// lookup, hero picking, the army bean); only its two network calls are stubbed.
const assert = require('assert');
const C = require('./constants');
const { Game } = require('./game');
const script = require('./script');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const F = (x, y) => C.coordsToFieldId(x, y);
const parseErr = (line) => { try { script.parseLine(line); } catch (e) { return e.message; } return null; };

// City 9 at 571,648 (two heroes, one the mayor), Fla at 484,619, and a city
// whose name has a space in it.
function world({ trainReplies = [], armyReply = { ok: 1 }, tradeReplies = [] } = {}) {
  const g = new Game();
  g.player = { playerInfo: { userName: 'Lord02' } };
  g.castles = [
    { id: 1, name: '9', fieldId: F(571, 648), heros: [{ id: 11, name: 'Att66A391', status: 0, level: 648 }, { id: 12, name: 'QUEEN', status: 1 }] },
    { id: 2, name: 'Fla', fieldId: F(484, 619), heros: [] },
    { id: 3, name: 'Home City', fieldId: F(10, 10), heros: [] },
  ];
  const sent = [];
  g.newArmy = async (castleId, bean) => { sent.push({ cmd: 'newArmy', castleId, bean }); return armyReply; };
  let n = 0;
  g.produceTroop = async (castleId, type, amount) => {
    sent.push({ cmd: 'train', castleId, type, amount });
    const r = trainReplies[n++];
    if (r instanceof Error) throw r;
    return r || { ok: 1 };
  };
  let k = 0;
  g.newTrade = async (o) => {
    sent.push({ cmd: 'trade', ...o, at: Date.now() });
    const r = tradeReplies[k++];
    if (r instanceof Error) throw r;
    return r || { ok: 1 };
  };
  return { g, sent };
}

// A second connection, the way the session makes one on a reconnect or when
// the console switches account.
function relogin(w, userName) {
  const g = new Game();
  g.player = { playerInfo: { userName } };
  g.castles = w.g.castles;
  g.newTrade = async (o) => { w.sent.push({ cmd: 'trade as ' + userName, ...o }); return { ok: 1 }; };
  return g;
}

async function runIn(w, src, opts = {}) {
  const out = [];
  const done = await script.run(w.g, script.parse(src), (m) => out.push(m), { castle: '9', repeatGapMs: 0, ...opts });
  return { done, out, text: out.join('\n') };
}

// ---------------------------------------------------------------------------
section('marches: what each line means');

t('reinforce x,y any s:1 reads as before', () => {
  const a = script.parseLine('reinforce 484,619 any s:1');
  assert.deepStrictEqual([a.target, a.targetCity, a.hero, a.troops, a.troopsDefault], [{ x: 484, y: 619 }, null, 'any', { scouter: 1 }, false]);
});
t('reinforce with no troop string sends 1 scout', () => {
  const a = script.parseLine('reinforce 484,619 any');
  assert.deepStrictEqual([a.hero, a.troops, a.troopsDefault], ['any', { scouter: 1 }, true]);
});
t('the hero can be left out, or written none', () => {
  assert.strictEqual(script.parseLine('reinforce 484,619').hero, null);
  assert.strictEqual(script.parseLine('reinforce 484,619 none a:5').hero, null);
  assert.strictEqual(script.parseLine('reinforce 484,619 NONE').hero, null);
});
t('a hero name alone', () => {
  const a = script.parseLine('reinforce 484,619 Att66A391');
  assert.deepStrictEqual([a.hero, a.troops], ['Att66A391', { scouter: 1 }]);
});
t('a city name instead of coords', () => {
  const a = script.parseLine('reinforce Fla');
  assert.deepStrictEqual([a.target, a.targetCity, a.hero], [null, 'Fla', null]);
  assert.strictEqual(script.parseLine('transport 9 t:10 wood:50k').targetCity, '9', 'a name made of digits is a name');
});
t('a quoted name with a space, a hero, troops and resources', () => {
  const a = script.parseLine('reinforce "Home City" Wian a:500 wood:50k,food:20k');
  assert.deepStrictEqual([a.targetCity, a.hero, a.troops, a.resources], ['Home City', 'Wian', { archer: 500 }, { wood: 50000, food: 20000 }]);
});
t('spaces after commas, and troop or resource strings split over several words', () => {
  // NEAT reads troops first and resources after, so a later s:2 is 2 stone
  const a = script.parseLine('reinforce 484, 619 a:100, c:50 s:2 wood:1k food:2k');
  assert.deepStrictEqual(a.target, { x: 484, y: 619 });
  assert.deepStrictEqual(a.troops, { archer: 100, lightCavalry: 50 });
  assert.deepStrictEqual(a.resources, { stone: 2, wood: 1000, food: 2000 });
  const b = script.parseLine('reinforce 484,619 a:100 c:50');
  assert.deepStrictEqual(b.troops, { archer: 100, lightCavalry: 50 }, 'a later list of troop-only codes still adds troops');
});
t('from takes a quoted name too', () => {
  assert.strictEqual(script.parseLine('attack 1,2 any a:100 from "Home City"').from, 'Home City');
  assert.match(parseErr('reinforce 1,2 from'), /"from" needs a city name/);
});
t('transport goes without a hero, but not without troops', () => {
  assert.strictEqual(script.parseLine('transport Fla t:10 wood:50k').hero, null);
  assert.match(parseErr('transport 1,2 wood:1000'), /no troop string/);
});
t('attack and scout need a hero and troops', () => {
  assert.match(parseErr('attack 1,2 a:100'), /attack: needs a hero/);
  assert.match(parseErr('attack 1,2 none a:100'), /attack: needs a hero/);
  assert.match(parseErr('scout 1,2 s:1'), /scout: needs a hero/);
  assert.match(parseErr('attack 1,2 any'), /no troop string/);
  assert.match(parseErr('scout 1,2 any'), /no troop string/);
  assert.strictEqual(script.parseLine('scout 500,500 any s:1').hero, 'any');
});
t('the target has to come first', () => {
  for (const l of ['reinforce', 'reinforce any s:1', 'reinforce none', 'reinforce s:1', 'reinforce wood:5', 'reinforce @07:00:00']) {
    assert.match(parseErr(l), /say where first/, l);
  }
});
t('two hero words are an error that mentions quotes for city names', () => {
  assert.match(parseErr('reinforce Home City Wian s:1'), /one hero per march, and a city name with spaces goes in quotes/);
  assert.doesNotMatch(parseErr('reinforce 1,2 Bob Alice'), /quotes/);
  // one extra word is read as the hero; the run then says to use quotes
  assert.deepStrictEqual([script.parseLine('reinforce Home City').targetCity, script.parseLine('reinforce Home City').hero], ['Home', 'City']);
});

// ---------------------------------------------------------------------------
section('marches: what gets sent');

t('reinforce <city> sends 1 scout and no hero to that city', async () => {
  const w = world();
  const r = await runIn(w, 'reinforce Fla');
  assert.strictEqual(w.sent.length, 1, r.text);
  const { castleId, bean } = w.sent[0];
  assert.strictEqual(castleId, 1);
  assert.strictEqual(bean.targetPoint, F(484, 619));
  assert.strictEqual(bean.missionType, C.MISSION.reinforce);
  assert.strictEqual(bean.troops.scouter, 1);
  assert.ok(!('heroId' in bean), 'no heroId key when there is no hero');
  assert.match(r.text, /Fla \(484,619\).* hero none · 1 Scout \(no troop string given\)/);
});
t('a named hero and a quoted city', async () => {
  const w = world();
  await runIn(w, 'reinforce "home city" Att66A391 a:5');
  assert.strictEqual(w.sent[0].bean.heroId, 11);
  assert.strictEqual(w.sent[0].bean.targetPoint, F(10, 10), 'names match in any case');
  assert.strictEqual(w.sent[0].bean.troops.archer, 5);
});
t('resources ride along on a reinforce', async () => {
  const w = world();
  const r = await runIn(w, 'reinforce Fla a:400 wood:9k');
  assert.strictEqual(w.sent[0].bean.resource.wood, 9000);
  assert.doesNotMatch(r.text, /may refuse/, '400 archers carry 10,000');
});
t('more than the troops can carry is sent, with a warning', async () => {
  const w = world();
  const r = await runIn(w, 'reinforce Fla wood:1000');
  assert.strictEqual(w.sent.length, 1);
  assert.match(r.text, /1 Scout carry about 5 before research, and this asks for 1,000/);
});
t('the city it leaves from is not a target', async () => {
  const w = world();
  const r = await runIn(w, 'reinforce 9');
  assert.strictEqual(w.sent.length, 0);
  assert.match(r.text, /FAILED: 9 is the city this march would leave from/);
});
t('an unknown city names the ones there are', async () => {
  const w = world();
  const r = await runIn(w, 'reinforce Nowhere');
  assert.strictEqual(w.sent.length, 0);
  assert.match(r.text, /no city of yours is called "Nowhere" — yours are 9, Fla, Home City/);
});
t('from <city> sends from that city', async () => {
  const w = world();
  await runIn(w, 'reinforce 9 from Fla');
  assert.deepStrictEqual([w.sent[0].castleId, w.sent[0].bean.targetPoint], [2, F(571, 648)]);
});

// ---------------------------------------------------------------------------
section('repeat');

t('repeat N and repeat alone', () => {
  assert.strictEqual(script.parseLine('repeat 5').times, 5);
  assert.strictEqual(script.parseLine('repeat').times, null);
  assert.match(parseErr('repeat lots'), /give a count/);
});
t('repeat N copies the line with a counter', () => {
  const acts = script.parse('train a 1\nrepeat 2');
  assert.deepStrictEqual(acts.map((a) => [a.cmd, a.round, a.of]), [['train', undefined, undefined], ['train', 1, 2], ['train', 2, 2]]);
});
t('a bare repeat leaves one marker after its line', () => {
  const acts = script.parse('train a 1\nrepeat\necho after');
  assert.deepStrictEqual(acts.map((a) => a.cmd), ['train', 'forever', 'echo']);
  assert.strictEqual(acts[1].action.cmd, 'train');
});
t('nothing to repeat, and a repeat after an endless one, are errors', () => {
  assert.strictEqual(script.parse('repeat')[0].error, 'repeat with no previous action');
  assert.match(script.parse('train a 1\nrepeat\nrepeat 2').find((a) => a.cmd === 'error').error, /never ends/);
});
t('the counter shows in the output', async () => {
  const w = world();
  const r = await runIn(w, 'train a 1\nrepeat 2');
  assert.strictEqual(w.sent.length, 3);
  assert.match(r.text, /train a 1 \(repeat 1 of 2\)/);
  assert.match(r.text, /train a 1 \(repeat 2 of 2\)/);
});
t('an endless repeat keeps going until the server refuses, then runs the rest', async () => {
  const w = world({ trainReplies: [{ ok: 1 }, { ok: 1 }, { ok: 1 }, { ok: -5, errorMsg: 'not enough food' }] });
  const r = await runIn(w, 'train a 1\nrepeat\necho after');
  assert.strictEqual(w.sent.length, 4, 'the first go, three repeats, the last one refused');
  assert.match(r.text, /train a 1 \(repeat 3, until it fails or Stop\)/);
  assert.match(r.text, /FAILED \(ok=-5\) - not enough food/);
  assert.match(r.text, /line 2: repeat ends — line 1 did not go through/);
  assert.match(r.text, /\n {2}after$/);
});
t('an exception ends it too', async () => {
  const w = world({ trainReplies: [{ ok: 1 }, new Error('socket closed')] });
  const r = await runIn(w, 'train a 1\nrepeat');
  assert.strictEqual(w.sent.length, 2);
  assert.match(r.text, /repeat ends/);
});
t('Stop ends an endless repeat whose line keeps going through', async () => {
  const w = world();
  const r = await runIn(w, 'train a 1\nrepeat\necho after', { shouldStop: () => w.sent.length >= 5 });
  assert.strictEqual(w.sent.length, 5);
  assert.match(r.text, /stopped — the rest of the script was not run/);
  assert.doesNotMatch(r.text, /after/);
});
// Stop arrives on a timer, the way the console's Stop request arrives on the
// socket: a loop that never yields to them would hang this test.
t('an endless echo still lets Stop through (no spinning)', async () => {
  const w = world();
  let stop = false;
  setTimeout(() => { stop = true; }, 50);
  const r = await runIn(w, 'echo hi\nrepeat', { shouldStop: () => stop });
  assert.match(r.text, /stopped/);
  assert.ok(r.out.filter((l) => l === '  hi').length > 1, 'it did repeat');
});
t('a dry run does not loop', async () => {
  const w = world();
  const r = await runIn(w, 'train a 1\nrepeat', { dryRun: true });
  assert.strictEqual(w.sent.length, 0);
  assert.match(r.text, /\[dry run\] would run line 1 again until it fails or you press Stop/);
});
t('Stop cuts a sleep short', async () => {
  const w = world();
  const t0 = Date.now();
  const r = await runIn(w, 'sleep 30\necho after', { shouldStop: () => Date.now() - t0 > 300 });
  assert.ok(Date.now() - t0 < 2000, 'returned in ' + (Date.now() - t0) + 'ms');
  assert.doesNotMatch(r.text, /after/);
});
t('repeat N runs every round, whatever the rounds before it got back', async () => {
  const w = world({ trainReplies: [{ ok: 1 }, { ok: -5, errorMsg: 'not enough food' }, new Error('no reply to troop.produceTroop'), { ok: 1 }] });
  const r = await runIn(w, 'train a 1\nrepeat 3\necho after');
  assert.strictEqual(w.sent.length, 4, r.text);
  assert.match(r.text, /\n {2}after$/);
});

// ---------------------------------------------------------------------------
section('market orders');

const FULL = { ok: -38, errorMsg: 'too many trades' };
t('a full marketplace skips that order, and the repeat carries on', async () => {
  const w = world({ tradeReplies: [{ ok: 1 }, FULL, FULL, { ok: 1 }] });
  const r = await runIn(w, 'buy stone 99999999 @0.11\nrepeat 4\necho after', { tradeGapMs: 0 });
  assert.strictEqual(w.sent.length, 5, r.text);
  assert.deepStrictEqual([w.sent[0].resource, w.sent[0].type, w.sent[0].amount, w.sent[0].price], ['stone', 'buy', 99999999, '0.11']);
  assert.strictEqual((r.text.match(/marketplace full \(10 offers max\) — this one is skipped/g) || []).length, 2);
  assert.match(r.text, /\(repeat 4 of 4\)/);
  assert.match(r.text, /\n {2}after$/);
  assert.strictEqual(r.done, 5, 'refusals count as replies');
});
t('an unanswered order does not end the run; each one in a row doubles the gap', async () => {
  const miss = () => new Error('no reply to trade.newTrade');
  const w = world({ tradeReplies: [miss(), miss(), miss(), { ok: 1 }, { ok: 1 }] });
  const r = await runIn(w, 'sell wood 1000 @0.55\nrepeat 4', { tradeGapMs: 20 });
  const at = w.sent.map((s) => s.at);
  assert.strictEqual(at.length, 5, r.text);
  const gaps = at.slice(1).map((x, i) => x - at[i]);
  // 20ms normally: 40 after one miss, 80 after two, 160 after three, then 20 again
  assert.ok(gaps[0] >= 35 && gaps[1] >= 75 && gaps[2] >= 150 && gaps[3] < 150, 'gaps ' + gaps.join(', '));
  assert.strictEqual((r.text.match(/no reply to trade\.newTrade — carrying on/g) || []).length, 3);
});
t('an endless repeat still ends at the first refusal', async () => {
  const w = world({ tradeReplies: [{ ok: 1 }, FULL] });
  const r = await runIn(w, 'buy stone 5 @0.11\nrepeat\necho after', { tradeGapMs: 0 });
  assert.strictEqual(w.sent.length, 2, r.text);
  assert.match(r.text, /repeat ends — line 1 did not go through/);
  assert.match(r.text, /\n {2}after$/);
});
t('after a reconnect the next order goes out on the new connection', async () => {
  const w = world({ tradeReplies: [new Error('no reply to trade.newTrade')] });
  const s = { connected: false, game: null };
  // the first order goes to a dead socket; while it waits, the session logs back in
  const dead = w.g.newTrade;
  w.g.newTrade = (o) => { Object.assign(s, { connected: true, game: relogin(w, 'Lord02') }); return dead(o); };
  const r = await runIn(w, 'buy stone 5 @0.11\nrepeat 2', { tradeGapMs: 0, session: s });
  assert.deepStrictEqual(w.sent.map((x) => x.cmd), ['trade', 'trade as Lord02', 'trade as Lord02'], r.text);
});
t('but never on another account the console switched to', async () => {
  const w = world();
  const r = await runIn(w, 'buy stone 5 @0.11\nrepeat 1', { tradeGapMs: 0, session: { connected: true, game: relogin(w, 'Lord22') } });
  assert.deepStrictEqual(w.sent.map((x) => x.cmd), ['trade', 'trade'], r.text);
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
