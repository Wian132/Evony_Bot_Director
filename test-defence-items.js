'use strict';
// Offline tests for defensepolicy: the NEAT switches, when each item is used,
// and that each one goes out through the game command the client uses for it.
// Nothing here connects or logs in: the game client is a real EvonyClient whose
// send/await are replaced, so every command is captured instead of sent.
//   node test-defence-items.js
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const util = require('util');
const crypto = require('crypto');

// Point db.js at a throwaway file BEFORE requiring anything that opens it.
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evony-defence-'));
if (!process.env.EVONY_DB) process.env.EVONY_DB = path.join(TMPDIR, 'test.db');

const C = require('./constants');
const { parseGoals } = require('./goals');
const M = require('./goalmods');
const { Game } = require('./game');
const { EvonyClient, passwordHash } = require('./evony');
const { Engine } = require('./engine');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok    ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
}
const section = (s) => console.log(`\n--- ${s} ---`);

const LIVE = 'defensepolicy /usetruce:79 /usespeech:2 /junktroop:5000 /usewarhorn:1 /usecorselet:1 /usepenicillin:1';
const PASSWORD = 'correct horse battery staple';
const HASH = crypto.createHash('sha1').update(PASSWORD, 'utf8').digest('hex');
const ID = C.DEFENSE_ITEMS;
const MIN = 60000;
// "The last real wave landed `ago` ms ago": the under-attack record every goal
// shares (goal-war.js underAttack, config defensecooldown).
const landed = (ago, extra = {}) => ({ war: { defense: { waves: {}, lastEndAt: Date.now() - ago } }, ...extra });

const policy = (line) => {
  const p = parseGoals(line);
  return { goals: p.goals, config: p.config, errors: p.errors.map((e) => e.error) };
};
const stock = (over = {}) => Object.entries({
  [ID.truce]: 3, [ID.speech]: 5, [ID.warhorn]: 2, [ID.ivoryhorn]: 1, [ID.corselet]: 2,
  [ID.ultracorselet]: 1, [ID.penicillin]: 1, ...over,
}).filter(([, c]) => c > 0).map(([id, count]) => ({ id, count }));

// A plan-only context: a plain game object, no client at all.
function planCtx({ line = LIVE, loyalty = 60, incoming = [], byCastle = null, items = stock(), buffs = [],
  uses = undefined, selfArmies = [], config = null, castles = null } = {}) {
  const castle = { castleId: 11, name: 'Home', resource: loyalty === null ? {} : { support: loyalty } };   // null: no loyalty on the bean
  const p = policy(line);
  const game = {
    castles: castles || [castle, { castleId: 22, name: 'Other', resource: { support: 100 } }],
    castleId: (c) => c.castleId,
    now: () => Date.now(),
    player: { items: items === null ? undefined : items, buffs },   // null: no inventory loaded
    itemUses: uses,
  };
  return {
    game, castle, goals: p.goals, config: config || p.config, incoming,
    incomingByCastle: byCastle || { 11: incoming.length }, selfArmies,
  };
}
const army = (troops, inMs = 5 * MIN) => ({ troops, known: troops !== null, reachTime: Date.now() + inMs, from: '1,1' });
const labels = (p) => p.actions.map((a) => a.label);
const items = (p) => p.actions.map((a) => a.item);

// A real Game over a real EvonyClient whose socket calls are captured.
async function wireGame({ replies = {}, loggedIn = true, castles = null, items: held = stock(), buffs = [] } = {}) {
  const sent = [], logs = [];
  const c = new EvonyClient();
  c.send = (cmd, data) => { sent.push({ cmd, data }); c.emit('log', `-> ${cmd}`); };
  c.await = async (cmds) => {
    const cmd = cmds[0];
    const r = typeof replies[cmd] === 'function' ? replies[cmd](sent[sent.length - 1]) : replies[cmd];
    if (r === 'timeout') throw new Error('no reply to ' + cmd);
    return { cmd, data: r || { ok: 1 } };
  };
  if (loggedIn) await c.login('lord@example.com', PASSWORD);
  sent.length = 0;
  const g = new Game((m) => logs.push(String(m)));
  g.c = c;
  c.on('log', (m) => logs.push(String(m)));
  g.castles = castles || [
    { castleId: 11, name: 'Home', fieldId: 100 * 800 + 100, resource: { support: 60 }, troop: {}, fortification: {}, heros: [], buildings: [] },
  ];
  g.player = { playerInfo: { userName: 'Lord' }, items: held, buffs, selfArmys: [], enemyArmys: [] };
  return { g, c, sent, logs };
}

// The server's hostile army push: the whole account's list, no castle id; each
// army names the field it marches on (the engine files it by targetFieldId).
let armySeq = 700;
const wireArmy = (to, troop, inMs = 5 * MIN) => ({
  armyId: armySeq++, direction: 1, missionType: C.MISSION.attack, king: 'Raider', startPosName: 'Raider City',
  targetFieldId: to.fieldId, reachTime: Date.now() + inMs, troop,
});
const pushHostile = (c, armys) => c.emit('cmd', 'server.EnemyArmysUpdate', { armys });

// An engine over that game, with the live goal line in every city.
function engineFor(g, line = LIVE, logs = []) {
  const e = new Engine(g, (m) => logs.push(String(m)));
  e.dryRun = false;
  e.state = {};
  e.goalsFor = () => parseGoals(line);
  return e;
}

(async () => {
  // ===================================================================== parse
  section('parsing the switches');

  await t('the live goal line parses with no errors, every value a number', async () => {
    const p = policy(LIVE);
    assert.deepStrictEqual(p.errors, []);
    assert.deepStrictEqual(p.goals[0].switches,
      { usetruce: 79, usespeech: 2, junktroop: 5000, usewarhorn: 1, usecorselet: 1, usepenicillin: 1 });
  });

  await t('the NUM grammar: /junktroop:5k is 5000, 1.5k is 1500, 2m is two million', async () => {
    assert.strictEqual(policy('defensepolicy /junktroop:5k').goals[0].switches.junktroop, 5000);
    assert.strictEqual(policy('defensepolicy /junktroop:1.5k').goals[0].switches.junktroop, 1500);
    assert.strictEqual(policy('defensepolicy /junktroop:2m').goals[0].switches.junktroop, 2000000);
    assert.strictEqual(policy('defensepolicy /JunkTroop:500').goals[0].switches.junktroop, 500);
  });

  await t('an unreadable value is an error and the switch stays unset (never NaN or 0)', async () => {
    const p = policy('defensepolicy /junktroop:lots /usetruce:abc /usespeech:');
    assert.strictEqual(p.errors.length, 3, p.errors.join(' | '));
    assert.match(p.errors[0], /cannot read "lots" as a number/);
    assert.match(p.errors[1], /cannot read "abc" as a number/);
    assert.match(p.errors[2], /\/usespeech needs a value/);
    assert.deepStrictEqual(p.goals[0].switches, {});
  });

  await t('flags are 0 or 1; a bare flag means on; a loyalty is at most 100', async () => {
    const p = policy('defensepolicy /usewarhorn:2 /usepenicillin /usecorselet:0 /usetruce:150 /usespeech:100');
    assert.deepStrictEqual(p.goals[0].switches, { usepenicillin: 1, usecorselet: 0, usespeech: 100 });
    assert.ok(p.errors.some((e) => /\/usewarhorn is 0 \(off\) or 1 \(on\), not 2/.test(e)), p.errors.join(' | '));
    assert.ok(p.errors.some((e) => /\/usetruce is a loyalty from 0 to 100, not 150/.test(e)), p.errors.join(' | '));
  });

  await t('a mistyped switch or a bare word is an error, not silently ignored', async () => {
    const p = policy('defensepolicy /usetruse:79 truce');
    assert.ok(p.errors.some((e) => /unknown switch "\/usetruse"/.test(e)), p.errors.join(' | '));
    assert.ok(p.errors.some((e) => /expected \/switch:value, got "truce"/.test(e)), p.errors.join(' | '));
    assert.deepStrictEqual(p.goals[0].switches, {});
  });

  await t('every NEAT switch is known, including the ivory horn and ultra corselet', async () => {
    const p = policy('defensepolicy /junktroop:0 /usetruce:2 /usespeech:5 /usewarhorn:1 /useivoryhorn:1 /usecorselet:1 /useultracorselet:1 /usepenicillin:0');
    assert.deepStrictEqual(p.errors, []);
    assert.strictEqual(Object.keys(p.goals[0].switches).length, 8);
  });

  // ============================================================ when to use
  section('when each item is used (the plan)');

  await t('no attack: nothing is used, even with loyalty under the truce line', async () => {
    const ctx = planCtx({ loyalty: 60 });
    const p = M.defensePlan(ctx, {});
    assert.deepStrictEqual(p.actions, []);
    assert.match(p.note, /truce: loyalty 60 <= 79, but not under attack/);
  });

  await t('loyalty 100 and no attack: the note is the short one', async () => {
    const p = M.defensePlan(planCtx({ loyalty: 100 }), {});
    assert.deepStrictEqual(p.actions, []);
    assert.strictEqual(p.note, 'defense: loyalty 100, 0 real attack(s) inbound');
  });

  await t('a real attack inbound: horn, corselet and penicillin, and the truce waits for the gap', async () => {
    const p = M.defensePlan(planCtx({ loyalty: 60, incoming: [army(20000)] }), {});
    assert.deepStrictEqual(items(p), ['warhorn', 'corselet', 'penicillin']);
    assert.match(p.note, /truce: loyalty 60 <= 79, held while 1 army\(ies\) march at the account/);
    assert.match(p.note, /game refuses a truce until none do/);
  });

  await t('an army at ANOTHER city of the account also holds the truce back', async () => {
    const st = landed(MIN);
    const p = M.defensePlan(planCtx({ loyalty: 60, byCastle: { 11: 0, 22: 2 } }), st);
    assert.ok(!items(p).includes('truce'), labels(p).join(' | '));
    assert.match(p.note, /held while 2 army\(ies\) march at the account/);
  });

  await t('after the wave lands, inside defensecooldown: the truce goes, the buffs wait for it', async () => {
    const st = landed(5 * MIN);
    const p = M.defensePlan(planCtx({ loyalty: 60 }), st);
    assert.deepStrictEqual(items(p), ['truce']);
    assert.strictEqual(p.actions[0].itemId, 'player.peace.1');
    assert.match(p.note, /under attack for another 25 min \(defensecooldown\)/);
    assert.match(p.note, /covers every city for 12 h, so no other city sends another/);
    assert.match(p.note, /War Horn, Corselet, Penicillin: waiting to see whether the truce takes/);
  });

  await t('the window is config defensecooldown (NEAT default 30 min)', async () => {
    const st = () => landed(31 * MIN);
    assert.deepStrictEqual(M.defensePlan(planCtx({ loyalty: 60 }), st()).actions, []);
    const ctx = planCtx({ loyalty: 60, config: { defensecooldown: 45 } });
    assert.deepStrictEqual(items(M.defensePlan(ctx, st())), ['truce']);
    const short = planCtx({ loyalty: 60, config: { defensecooldown: '30s' } });
    assert.deepStrictEqual(M.defensePlan(short, landed(MIN)).actions, []);
  });

  await t('seeing a real attack starts the window; a junk one does not', async () => {
    const st = {};
    M.defensePlan(planCtx({ incoming: [army(4000)] }), st);
    assert.ok(!(st.war && st.war.defense), 'a 4000-troop army under /junktroop:5000 started the window');
    M.defensePlan(planCtx({ incoming: [army(6000)] }), st);
    assert.strictEqual(Object.keys(st.war.defense.waves).length, 1, 'the real attack is not being watched');
  });

  await t('junk under /junktroop is ignored entirely and said so', async () => {
    const p = M.defensePlan(planCtx({ loyalty: 50, incoming: [army(4999), army(10)] }), {});
    assert.deepStrictEqual(p.actions, []);
    assert.match(p.note, /0 real attack\(s\) inbound \(2 junk under 5000 ignored\)/);
  });

  await t('an unscouted army ("?" sizes) is a real threat, never junk', async () => {
    const raw = { troop: { archer: '?', scouter: '?' }, reachTime: Date.now() + MIN };
    const p = M.defensePlan(planCtx({ incoming: [army(null), raw] }), {});
    assert.match(p.note, /2 real attack\(s\) inbound/);
    assert.deepStrictEqual(items(p), ['warhorn', 'corselet', 'penicillin']);
  });

  await t('/junktroop:0 makes every attack count; no /junktroop is NEAT\'s 1000', async () => {
    const zero = M.defensePlan(planCtx({ line: 'defensepolicy /junktroop:0 /usewarhorn:1', incoming: [army(1)] }), {});
    assert.deepStrictEqual(items(zero), ['warhorn']);
    const dflt = M.defensePlan(planCtx({ line: 'defensepolicy /usewarhorn:1', incoming: [army(999)] }), {});
    assert.deepStrictEqual(dflt.actions, []);
    const big = M.defensePlan(planCtx({ line: 'defensepolicy /usewarhorn:1', incoming: [army(1000)] }), {});
    assert.deepStrictEqual(items(big), ['warhorn']);
  });

  await t('an army whose landing time passed over a minute ago is stale and ignored', async () => {
    const p = M.defensePlan(planCtx({ incoming: [army(20000, -2 * MIN)] }), {});
    assert.match(p.note, /0 real attack\(s\) inbound/);
  });

  await t('speech: at or below its loyalty, under attack, and it does not wait for the truce', async () => {
    const st = landed(MIN);
    // Speech Text first, then the truce (the user, 2026-09-18)
    assert.deepStrictEqual(items(M.defensePlan(planCtx({ loyalty: 2 }), st)), ['speech', 'truce']);
    assert.ok(!items(M.defensePlan(planCtx({ loyalty: 3 }), st)).includes('speech'));
    // with the truce held back by an inbound army, speech still goes
    const p = M.defensePlan(planCtx({ loyalty: 2, incoming: [army(20000)] }), {});
    assert.deepStrictEqual(items(p), ['speech', 'warhorn', 'corselet', 'penicillin']);
    assert.strictEqual(p.actions[0].scope, 'city');
  });

  await t('unknown loyalty is not loyalty 0: no truce, no speech', async () => {
    const st = landed(MIN);
    const p = M.defensePlan(planCtx({ loyalty: null }), st);
    assert.ok(!items(p).includes('truce') && !items(p).includes('speech'), labels(p).join(' | '));
    assert.match(p.note, /loyalty \?/);
    assert.match(p.note, /truce: loyalty unknown/);
  });

  // ================================================================= held
  section('only what is held, only what is not running');

  await t('a Truce Agreement that is not held is not used, and the note says so', async () => {
    const st = landed(MIN);
    const p = M.defensePlan(planCtx({ loyalty: 50, items: stock({ [ID.truce]: 0 }) }), st);
    assert.ok(!items(p).includes('truce'));
    assert.match(p.note, /truce: loyalty 50 <= 79, but no Truce Agreement is held/);
  });

  await t('no horn, corselet or penicillin held: none used, each named', async () => {
    const none = stock({ [ID.warhorn]: 0, [ID.corselet]: 0, [ID.penicillin]: 0 });
    const p = M.defensePlan(planCtx({ incoming: [army(20000)], items: none }), {});
    assert.deepStrictEqual(p.actions, []);
    assert.match(p.note, /War Horn: no War Horn is held/);
    assert.match(p.note, /Corselet: no Corselet is held/);
    assert.match(p.note, /Penicillin: no Penicillin is held/);
  });

  await t('no inventory loaded at all: nothing is used', async () => {
    const p = M.defensePlan(planCtx({ incoming: [army(20000)], items: null }), {});
    assert.deepStrictEqual(p.actions, []);
    assert.match(p.note, /the inventory has not loaded/);
  });

  await t('horn pair: the War Horn first; the Ivory Horn only when the War Horn is gone and /useivoryhorn is on', async () => {
    const both = 'defensepolicy /usewarhorn:1 /useivoryhorn:1';
    assert.deepStrictEqual(items(M.defensePlan(planCtx({ line: both, incoming: [army(20000)] }), {})), ['warhorn']);
    const noWar = stock({ [ID.warhorn]: 0 });
    assert.deepStrictEqual(items(M.defensePlan(planCtx({ line: both, incoming: [army(20000)], items: noWar }), {})), ['ivoryhorn']);
    const onlyWar = M.defensePlan(planCtx({ line: 'defensepolicy /usewarhorn:1', incoming: [army(20000)], items: noWar }), {});
    assert.deepStrictEqual(onlyWar.actions, []);
    assert.match(onlyWar.note, /no War Horn is held/);
    const ultra = 'defensepolicy /useultracorselet:1';
    assert.deepStrictEqual(items(M.defensePlan(planCtx({ line: ultra, incoming: [army(20000)] }), {})), ['ultracorselet']);
  });

  await t('a buff already running (any source) is not stacked', async () => {
    const buffs = [{ typeId: 'PlayerIncArmyAttachBuff', endTime: Date.now() + 3 * 3600000 },
      { typeId: 'TroopReliveBuff', endTime: Date.now() - MIN }];      // expired: the delete push is late
    const p = M.defensePlan(planCtx({ incoming: [army(20000)], buffs }), {});
    assert.deepStrictEqual(items(p), ['corselet', 'penicillin']);
    assert.match(p.note, /War Horn: already running for another 3 h 0 min/);
  });

  await t('in truce: no truce, no speech, no buffs — no attack can land', async () => {
    const st = landed(MIN);
    const buffs = [{ typeId: 'PlayerPeaceBuff', endTime: Date.now() + 10 * 3600000 }];
    const p = M.defensePlan(planCtx({ loyalty: 2, buffs }), st);
    assert.deepStrictEqual(p.actions, []);
    assert.match(p.note, /truce: the account is in truce for another 10 h 0 min/);
    assert.match(p.note, /speech: not needed, no attack can land in truce/);
  });

  await t('in truce cooldown (trailing space and all): the game allows no new truce', async () => {
    const st = landed(MIN);
    const buffs = [{ typeId: 'PlayerPeaceCoolDownBuff ', endTime: Date.now() + 3600000 }];
    const p = M.defensePlan(planCtx({ loyalty: 50, buffs }), st);
    assert.ok(!items(p).includes('truce'));
    assert.match(p.note, /in truce cooldown for another 1 h 0 min, the game allows no new truce/);
  });

  // ============================================================ cooldowns
  section('cooldowns: stamped only once the server said ok');

  await t('planning stamps nothing; the old plan-time def_* stamps are dropped', async () => {
    const st = landed(MIN, { def_truce: Date.now(), def_warhorn: Date.now() });
    const p = M.defensePlan(planCtx({ loyalty: 50 }), st);
    assert.deepStrictEqual(items(p), ['truce'], 'an old plan-time stamp still held the truce back');
    assert.deepStrictEqual(st.defence.used, {});
    assert.strictEqual(st.def_truce, undefined);
    // planned again a minute later, never sent: still due
    assert.deepStrictEqual(items(M.defensePlan(planCtx({ loyalty: 50 }), st)), ['truce']);
  });

  await t('after an ok, the same item waits as long as it runs, even with no buff push', async () => {
    const st = landed(MIN, { defence: { used: { warhorn: Date.now() - 3600000 } } });
    const p = M.defensePlan(planCtx({ incoming: [army(20000)] }), st);
    assert.deepStrictEqual(items(p), ['corselet', 'penicillin']);
    assert.match(p.note, /War Horn: went out 1 h 0 min ago/);
    st.defence.used.warhorn = Date.now() - 25 * 3600000;          // a War Horn lasts 24 h
    assert.ok(items(M.defensePlan(planCtx({ incoming: [army(20000)] }), st)).includes('warhorn'));
  });

  await t('a refusal is retried after 2 minutes, not every tick', async () => {
    const uses = { [ID.warhorn]: { at: Date.now() - 30000, ok: 0, castleId: 11, errorMsg: 'nope' } };
    const p = M.defensePlan(planCtx({ line: 'defensepolicy /usewarhorn:1', incoming: [army(20000)], uses }), {});
    assert.deepStrictEqual(p.actions, []);
    assert.match(p.note, /War Horn was refused \(nope\) 3\d s ago, trying again in [12] min/);
    uses[ID.warhorn].at = Date.now() - 3 * MIN;
    assert.deepStrictEqual(items(M.defensePlan(planCtx({ line: 'defensepolicy /usewarhorn:1', incoming: [army(20000)], uses }), {})), ['warhorn']);
  });

  await t('speech waits 2 minutes after an ok, for the city to show loyalty 100', async () => {
    const st = landed(MIN, { defence: { used: { speech: Date.now() - MIN } } });
    const line = 'defensepolicy /usespeech:5';
    assert.deepStrictEqual(M.defensePlan(planCtx({ line, loyalty: 3 }), st).actions, []);
    st.defence.used.speech = Date.now() - 3 * MIN;
    assert.deepStrictEqual(items(M.defensePlan(planCtx({ line, loyalty: 3 }), st)), ['speech']);
  });

  // ================================================================ one truce
  section('one truce for the whole account');

  await t('a truce another city sent this session holds this city back, and says where it came from', async () => {
    const st = landed(MIN);
    const uses = { [ID.truce]: { at: Date.now() - 20000, ok: 1, castleId: 22 } };
    const p = M.defensePlan(planCtx({ loyalty: 50, uses }), st);
    assert.ok(!items(p).includes('truce'));
    assert.match(p.note, /a Truce Agreement went out 2\d s ago from Other and covers every city/);
  });

  await t('a truce another city was refused holds this city back too (the reason is account-wide)', async () => {
    const st = landed(MIN);
    const uses = { [ID.truce]: { at: Date.now() - 20000, ok: 0, castleId: 22, errorMsg: 'troops out' } };
    const p = M.defensePlan(planCtx({ loyalty: 50, uses }), st);
    assert.ok(!items(p).includes('truce'));
    assert.match(p.note, /Truce Agreement from Other was refused \(troops out\) 2\d s ago/);
  });

  await t('our own attacks out: the truce is still tried, and the note warns the game refuses it then', async () => {
    const st = landed(MIN);
    const p = M.defensePlan(planCtx({ loyalty: 50, selfArmies: [{ missionType: 5 }, { missionType: 5 }, { missionType: 5 }] }), st);
    assert.deepStrictEqual(items(p), ['truce']);
    assert.match(p.note, /3 of our own attack\(s\) are out, and the game refuses a truce then/);
  });

  await t('our own transports and reinforcements do not stop a truce, and are not warned about', async () => {
    const st = landed(MIN);
    const p = M.defensePlan(planCtx({ loyalty: 50, selfArmies: [{ missionType: 1 }, { missionType: 2 }] }), st);
    assert.deepStrictEqual(items(p), ['truce']);
    assert.doesNotMatch(p.note, /our own/);
  });

  // ============================================================ the wire
  section('the game commands (game.js, evony.js)');

  await t('the login keeps the SHA1 it sent; nothing can print it', async () => {
    const { c, logs } = await wireGame();
    assert.strictEqual(passwordHash(PASSWORD), HASH);
    assert.strictEqual(c.passwordHash(), HASH);
    assert.ok(!JSON.stringify(Object.assign({}, c)).includes(HASH));
    assert.ok(!util.inspect(c, { depth: 6, showHidden: true }).includes(HASH));
    assert.ok(!logs.join('\n').includes(HASH) && !logs.join('\n').includes(PASSWORD));
  });

  await t('Truce Agreement -> city.setStopWarState {ItemId, passWord: sha1(password)}, no castleId', async () => {
    const { g, sent } = await wireGame();
    const r = await g.useDefenceItem(11, ID.truce);
    assert.strictEqual(r.ok, 1);
    assert.deepStrictEqual(sent, [{ cmd: 'city.setStopWarState', data: { ItemId: 'player.peace.1', passWord: HASH } }]);
    assert.strictEqual(g.itemUses[ID.truce].ok, 1);
    assert.strictEqual(g.itemUses[ID.truce].castleId, 11);
  });

  await t('Speech Text -> shop.useCastleGoods {castleId, itemId}', async () => {
    const { g, sent } = await wireGame();
    await g.useDefenceItem(11, ID.speech);
    assert.deepStrictEqual(sent, [{ cmd: 'shop.useCastleGoods', data: { castleId: 11, itemId: 'player.heart.1.a' } }]);
  });

  await t('horns, corselets and penicillin -> shop.useGoods {castleId, itemId, num: 1}', async () => {
    const { g, sent } = await wireGame();
    for (const k of ['warhorn', 'ivoryhorn', 'corselet', 'ultracorselet', 'penicillin']) await g.useDefenceItem(11, ID[k]);
    assert.deepStrictEqual(sent.map((s) => s.cmd), Array(5).fill('shop.useGoods'));
    assert.deepStrictEqual(sent.map((s) => s.data.itemId),
      ['player.attackinc.1', 'player.attackinc.1.b', 'player.defendinc.1', 'player.defendinc.1.b', 'player.relive.1']);
    for (const s of sent) assert.deepStrictEqual(Object.keys(s.data).sort(), ['castleId', 'itemId', 'num']);
    assert.ok(sent.every((s) => s.data.num === 1 && s.data.castleId === 11));
  });

  await t('no login, no password: the truce is not sent at all', async () => {
    const { g, sent } = await wireGame({ loggedIn: false });
    const r = await g.useDefenceItem(11, ID.truce);
    assert.strictEqual(r.ok, 0);
    assert.deepStrictEqual(sent, []);
  });

  await t('a refusal and a lost reply are both recorded, neither as ok', async () => {
    const { g } = await wireGame({ replies: { 'shop.useGoods': { ok: -1, errorMsg: 'not now' }, 'shop.useCastleGoods': 'timeout' } });
    await g.useDefenceItem(11, ID.warhorn);
    assert.deepStrictEqual([g.itemUses[ID.warhorn].ok, g.itemUses[ID.warhorn].errorMsg], [0, 'not now']);
    await assert.rejects(g.useDefenceItem(11, ID.speech), /no reply/);
    assert.strictEqual(g.itemUses[ID.speech].ok, null);
  });

  await t('something that is not a defence item is refused without a send', async () => {
    const { g, sent } = await wireGame();
    const r = await g.useDefenceItem(11, 'player.box.hero.a');
    assert.strictEqual(r.ok, 0);
    assert.deepStrictEqual(sent, []);
  });

  await t('server.PlayerBuffUpdate keeps the buff list: 0 adds, 1 deletes, else updates', async () => {
    const { g } = await wireGame({ buffs: [] });
    // Game.connect wires server.PlayerBuffUpdate to this; connect itself needs the network
    const push = (updateType, buffBean) => g.applyPlayerBuffUpdate({ updateType, buffBean });
    push(0, { typeId: 'PlayerPeaceBuff', endTime: 5, descName: 'Truce' });
    push(0, { typeId: 'TroopReliveBuff', endTime: 7 });
    push(2, { typeId: 'PlayerPeaceBuff', endTime: 9 });
    assert.deepStrictEqual(g.player.buffs.map((b) => [b.typeId, b.endTime]), [['PlayerPeaceBuff', 9], ['TroopReliveBuff', 7]]);
    push(1, { typeId: 'PlayerPeaceBuff' });
    assert.deepStrictEqual(g.player.buffs.map((b) => b.typeId), ['TroopReliveBuff']);
    push(1, { typeId: 'Nothing' });
    assert.strictEqual(g.player.buffs.length, 1);
  });

  // ============================================================ the engine
  section('end to end through the engine');

  await t('the live line, no attack, loyalty 60: nothing is sent', async () => {
    const { g, sent } = await wireGame();
    const e = engineFor(g);
    await e.focus(g.castles[0]);
    assert.deepStrictEqual(sent.filter((s) => /stopWar|useGoods|useCastleGoods/.test(s.cmd)), []);
  });

  await t('the live line, a 20k attack inbound: horn, corselet, penicillin through shop.useGoods; no truce', async () => {
    const { g, c, sent } = await wireGame();
    const e = engineFor(g);
    pushHostile(c, [wireArmy(g.castles[0], { archer: '20000' })]);
    const r = await e.focus(g.castles[0]);
    const uses = sent.filter((s) => /stopWar|useGoods|useCastleGoods/.test(s.cmd));
    assert.deepStrictEqual(uses.map((s) => [s.cmd, s.data.itemId]),
      [['shop.useGoods', ID.warhorn], ['shop.useGoods', ID.corselet], ['shop.useGoods', ID.penicillin]]);
    assert.ok(r.acted.some((a) => /War Horn \(under attack\) -> ok/.test(a)), r.acted.join(' | '));
    assert.ok(e.state[11].defence.used.warhorn > 0, 'the ok was not stamped');
    assert.match(r.defense.note, /truce: loyalty 60 <= 79, held while 1 army\(ies\) march at the account/);
  });

  await t('through the hostile push: the wave is seen, lands, and the truce goes in the gap after it', async () => {
    const { g, c, sent } = await wireGame();
    const e = engineFor(g);
    pushHostile(c, [wireArmy(g.castles[0], { archer: '20000' })]);
    await e.focus(g.castles[0]);                        // inbound: buffs, the truce held
    assert.strictEqual(Object.keys(e.state[11].war.defense.waves).length, 1, 'the real attack did not open the defensecooldown window');
    assert.strictEqual(sent.filter((s) => s.cmd === 'city.setStopWarState').length, 0);
    pushHostile(c, []);                                 // the wave has landed: the list is empty
    const r = await e.focus(g.castles[0]);
    assert.strictEqual(sent.filter((s) => s.cmd === 'city.setStopWarState').length, 1, r.acted.join(' | '));
    assert.match(r.defense.note, /under attack for another 30 min \(defensecooldown\)/);
  });

  await t('a junk wave through the push opens no window and spends nothing', async () => {
    const { g, c, sent } = await wireGame();
    const e = engineFor(g);
    pushHostile(c, [wireArmy(g.castles[0], { archer: '4999' })]);
    const r = await e.focus(g.castles[0]);
    assert.deepStrictEqual(sent.filter((s) => /stopWar|useGoods|useCastleGoods/.test(s.cmd)), []);
    assert.ok(!(e.state[11].war && e.state[11].war.defense));
    assert.match(r.defense.note, /\(1 junk under 5000 ignored\)/);
  });

  await t('the live line, after the wave, loyalty 60: one truce, signed with the password hash', async () => {
    const { g, sent } = await wireGame();
    const e = engineFor(g);
    e.state[11] = landed(2 * MIN);
    const r = await e.focus(g.castles[0]);
    const truce = sent.filter((s) => s.cmd === 'city.setStopWarState');
    assert.deepStrictEqual(truce, [{ cmd: 'city.setStopWarState', data: { ItemId: 'player.peace.1', passWord: HASH } }]);
    assert.ok(r.acted.some((a) => /Truce Agreement for the whole account \(loyalty 60 <= 79\) -> ok/.test(a)), r.acted.join(' | '));
    assert.ok(e.state[11].defence.used.truce > 0);
  });

  await t('a refused truce stamps no cooldown, and the server\'s reason is in the log', async () => {
    const { g } = await wireGame({ replies: { 'city.setStopWarState': { ok: -1, errorMsg: 'You have troops marching' } } });
    const e = engineFor(g);
    e.state[11] = landed(2 * MIN);
    const r = await e.focus(g.castles[0]);
    assert.ok(r.acted.some((a) => /-> You have troops marching/.test(a)), r.acted.join(' | '));
    assert.strictEqual(e.state[11].defence.used.truce, undefined, 'a refused truce was stamped as used');
  });

  await t('two cities under attack at low loyalty in one tick: exactly one truce is sent', async () => {
    const castles = [
      { castleId: 11, name: 'Home', fieldId: 80100, resource: { support: 40 }, troop: {}, fortification: {}, heros: [], buildings: [] },
      { castleId: 22, name: 'Other', fieldId: 80200, resource: { support: 30 }, troop: {}, fortification: {}, heros: [], buildings: [] },
    ];
    const { g, sent } = await wireGame({ castles });
    const logs = [];
    const e = engineFor(g, LIVE, logs);
    e.state[11] = landed(MIN);
    e.state[22] = landed(MIN);
    await e.tick();
    assert.strictEqual(sent.filter((s) => s.cmd === 'city.setStopWarState').length, 1);
    assert.ok(logs.some((l) => /\[Other\].*a Truce Agreement went out \d+ s ago from Home and covers every city/.test(l)), logs.join('\n'));
    // and the next tick sends nothing more, in either city
    sent.length = 0;
    await e.tick();
    assert.strictEqual(sent.filter((s) => s.cmd === 'city.setStopWarState').length, 0);
  });

  await t('plan-only mode: the truce is shown as [plan], nothing is sent, nothing is stamped', async () => {
    const { g, sent } = await wireGame();
    const e = engineFor(g);
    e.dryRun = true;
    e.state[11] = landed(MIN);
    const r = await e.focus(g.castles[0]);
    assert.ok(r.acted.includes('[plan] Truce Agreement for the whole account (loyalty 60 <= 79)'), r.acted.join(' | '));
    assert.deepStrictEqual(sent, []);
    assert.deepStrictEqual(e.state[11].defence.used, {});
  });

  await t('a Truce Agreement not held: nothing is sent', async () => {
    const { g, sent } = await wireGame({ items: stock({ [ID.truce]: 0 }) });
    const e = engineFor(g);
    e.state[11] = landed(MIN);
    await e.focus(g.castles[0]);
    assert.deepStrictEqual(sent.filter((s) => s.cmd === 'city.setStopWarState'), []);
  });

  await t('neither the password nor its hash reaches a log line, the report or the saved state', async () => {
    const { g, logs } = await wireGame();
    const e = engineFor(g, LIVE, logs);
    e.state[11] = landed(MIN);
    await e.tick();
    const everything = [logs.join('\n'), JSON.stringify(e.state), JSON.stringify(e.lastReport),
      util.inspect(g, { depth: 8 }), util.inspect(e, { depth: 8 })].join('\n');
    assert.ok(everything.includes('Truce Agreement'), 'the truce did not run, so this test proves nothing');
    assert.ok(!everything.includes(HASH), 'the password hash leaked');
    assert.ok(!everything.includes(PASSWORD), 'the password leaked');
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
