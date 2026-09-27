'use strict';
// Step 8, the hero quick fixes, offline: the mayor plan, the one base formula,
// the Feasting Hall's size from the inn, firing only for room, the fire cooldown
// and captured heroes, the default point spend, the traininghero's npc hits and
// status, and the release / "any" / inn-refresh guards.
// Hand-made rosters and stub games only: nothing here connects to the game.
const path = require('path'), os = require('os'), fs = require('fs'), vm = require('vm');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-herofix-')), 't.db');   // before db.js loads

const C = require('./constants');
const H = require('./goal-heroes');
const M = require('./goalmods');
const NPC = require('./goal-npc');
const { Game } = require('./game');
const { Engine } = require('./engine');
const { parseGoals } = require('./goals');
const script = require('./script');

let pass = 0, fail = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const section = (s) => tests.push([s, null]);
function eq(got, want, what = '') {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${what ? what + ': ' : ''}got ${g}, want ${w}`);
}
function ok(cond, what) { if (!cond) throw new Error(what || 'expected true'); }
const has = (text, re, what) => ok(re.test(String(text)), `${what ? what + ': ' : ''}${JSON.stringify(String(text))} does not match ${re}`);

// ---------------------------------------------------------------- fixtures
// Shaped like the live roster: attributes include the points spent, *Added is 0.
// Status (HeroConstants.as): 0 idle, 1 mayor, 2 guarding a valley, 3 marching,
// 4 a prisoner we hold, 5 returning, 8 farming.
let nextId = 100;
const hero = (o) => Object.assign({
  id: nextId++, name: '?', level: 10, status: 0,
  power: 20, powerAdded: 0, management: 10, managementAdded: 0, stratagem: 10, stratagemAdded: 0,
  loyalty: 100, experience: 0, upgradeExp: 0, remainPoint: 0,
}, o);

let nextCastle = 1;
function city(name, heros, { hall = 10, rally = 5, fieldId } = {}) {
  const id = nextCastle++;
  return {
    castleId: id, id, name, fieldId: fieldId ?? C.coordsToFieldId(100 + id * 5, 100),
    heros, troop: { scouter: 10 }, fortification: {},
    resource: { food: { amount: 1e9 }, wood: { amount: 1e9 }, stone: { amount: 1e9 }, iron: { amount: 1e9 }, gold: 1e9 },
    buildings: [
      ...(hall === null ? [] : [{ typeId: 27, level: hall, positionId: 3 }]),
      ...(rally === null ? [] : [{ typeId: 29, level: rally, positionId: 5 }]),
    ],
  };
}

// A game as the plans see it: castles, ids, and the inn readings Game.noteHall keeps.
function planGame(castles) {
  return { castles, castleId: (c) => c.castleId, hallSeen: {} };
}
// Note an inn reading the way Game.noteHall does (posCount + the roster then).
function readInn(game, castle, posCount, { at = Date.now() } = {}) {
  const fh = (castle.buildings || []).find((b) => b.typeId === 27);
  game.hallSeen[castle.castleId] = { at, posCount, heroes: castle.heros.length, capacity: posCount + castle.heros.length, fhLevel: fh ? fh.level : null };
}

// ctx for one city, its goals parsed by goals.js; other cities' goals by name.
function ctxFor(game, castle, src, others = {}) {
  const parsed = parseGoals(src);
  if (parsed.errors.length) throw new Error('goals did not parse: ' + JSON.stringify(parsed.errors));
  const goalsOf = (c) => (c === castle ? parsed.goals : (others[c.name] !== undefined ? parseGoals(others[c.name]).goals : null));
  return { game, castle, goals: parsed.goals, config: parsed.config, goalsOf, fortifications: {}, incoming: [] };
}
const fires = (p) => ((p && p.actions) || []).filter((a) => a.kind === 'fireHero').map((a) => a.heroName);
const kinds = (p) => ((p && p.actions) || []).map((a) => a.kind);

// ======================================================================
section('1. the mayor plan');
// ======================================================================
const mayorCtx = (heros, config = {}) => ({ castle: { heros }, config, goals: [] });

t('only an idle hero or the sitting mayor can be picked: away, farming, guarding, returning and prisoners are not', () => {
  const sitting = hero({ name: 'Sitting', status: 1, management: 60 });
  const roster = [
    sitting,
    hero({ name: 'Marcher', status: 3, management: 900 }),
    hero({ name: 'Farmer', status: 8, management: 800 }),
    hero({ name: 'Guard', status: 2, management: 700 }),
    hero({ name: 'Returner', status: 5, management: 600 }),
    hero({ name: 'Prisoner', status: 4, management: 999 }),
    hero({ name: 'Idler', status: 0, management: 80 }),
  ];
  const p = M.mayorPlan(mayorCtx(roster), 'idle');
  eq(p.actions.map((a) => a.hero.name), ['Idler'], 'the best politics hero AT HOME');
  eq(p.actions[0].kind, 'setMayor');
  ok(!('hadMayor' in p.actions[0]), 'no discharge is planned');
});

t('a prisoner with the best stats is never appointed, even with nobody else idle', () => {
  const p = M.mayorPlan(mayorCtx([hero({ name: 'Prisoner', status: 4, power: 999, management: 999 }), hero({ name: 'Away', status: 3 })]), 'train');
  eq(p.actions, undefined);
  has(p.note, /no hero at home to appoint/);
});

t('training wants the best attack hero at home, building and idle the best politics one', () => {
  const a = hero({ name: 'Atk', power: 300, management: 20 });
  const pl = hero({ name: 'Pol', status: 1, power: 20, management: 300 });
  const far = hero({ name: 'FarAtk', status: 8, power: 900 });
  eq(M.mayorPlan(mayorCtx([a, pl, far]), 'train').actions[0].hero.name, 'Atk');
  eq(M.mayorPlan(mayorCtx([a, pl, far]), 'build').note, 'mayor: Pol already set for building');
  eq(M.mayorPlan(mayorCtx([a, pl, far]), 'idle').note, 'mayor: Pol already set for resource production');
});

t('a tie keeps the sitting mayor rather than swapping to an equal hero', () => {
  const first = hero({ name: 'First', management: 100 });
  const sitting = hero({ name: 'Sitting', status: 1, management: 100 });
  const p = M.mayorPlan(mayorCtx([first, sitting]), 'idle');
  eq(p.actions, undefined);
  has(p.note, /Sitting already set/);
});

t('config hero:0 and config nomayor:1 stand it down; config hero unset still runs', () => {
  const roster = [hero({ name: 'Idler', management: 90 }), hero({ name: 'Sitting', status: 1, management: 10 })];
  eq(M.mayorPlan(mayorCtx(roster, { hero: 0 }), 'idle'), null, 'hero:0');
  eq(M.mayorPlan(mayorCtx(roster, { nomayor: 1 }), 'idle'), null, 'nomayor:1');
  eq(M.mayorPlan(mayorCtx(roster, { hero: 1, nomayor: 1 }), 'idle'), null, 'nomayor:1 with hero:1');
  eq(M.mayorPlan(mayorCtx(roster, {}), 'idle').actions[0].hero.name, 'Idler', 'unset: runs, as before');
  eq(M.mayorPlan(mayorCtx(roster, { hero: 1 }), 'idle').actions[0].hero.name, 'Idler', 'hero:1');
  const odd = M.mayorPlan(mayorCtx(roster, { hero: 'abc' }), 'idle');
  eq(odd.actions, undefined);
  has(odd.note, /not understood/);
});

t('nomayor:1 no longer flip-flops: tick after tick the mayor plan stays out and nomayor keeps the office empty', () => {
  const roster = [hero({ name: 'Polly', status: 1, management: 300 }), hero({ name: 'Idler', management: 50 })];
  const c = { castle: { heros: roster }, config: { hero: 1, nomayor: 1 }, goals: [] };
  for (let tick = 0; tick < 3; tick++) {
    eq(M.mayorPlan(c, 'idle'), null, `tick ${tick}: mayor plan`);
    const nm = H.plans.nomayor(c);
    if (tick === 0) { eq(kinds(nm), ['dischargeChief']); roster[0].status = 0; }   // the server stands her down
    else eq(nm.actions, [], `tick ${tick}: nothing to undo`);
  }
});

// A stub game the engine can run a whole focus slice against.
function engineGame(castles) {
  const calls = [];
  const g = {
    castles, calls,
    player: { playerInfo: { userName: 'T' }, selfArmys: [], enemyArmys: [], items: [] },
    castle: () => castles[0],
    castleId: (c) => c.castleId,
    castleXY: (c) => C.fieldIdToCoords(c.fieldId),
    now: () => Date.now(),
    req: async (cmd) => { calls.push([cmd]); return { ok: 1 }; },
    promoteToChief: async (cid, hid) => { calls.push(['promoteToChief', cid, hid]); return g.promoteReply || { ok: 1 }; },
    dischargeChief: async (cid) => { calls.push(['dischargeChief', cid]); return { ok: 1 }; },
    fireHero: async (cid, hid) => { calls.push(['fireHero', cid, hid]); return g.fireReply || { ok: 1 }; },
    levelUpHero: async (cid, hid) => { calls.push(['levelUp', cid, hid]); return { ok: 1 }; },
    addPoint: async (cid, h, inc) => { calls.push(['addPoint', cid, h.id, inc]); return { ok: 1 }; },
    tavernList: async (cid) => { calls.push(['tavernList', cid]); return { ok: 1, heros: [] }; },
    buildArmyBean: (o) => Game.prototype.buildArmyBean.call(g, o),
    newArmy: async (cid, bean) => { calls.push(['newArmy', cid, bean]); return { ok: 1 }; },
  };
  return g;
}
function engineFor(castles, srcFor) {
  const game = engineGame(castles);
  const lines = [];
  const e = new Engine(game, (m) => lines.push(m));
  e.dryRun = false;
  e.state = {};
  e.goalsFor = (id, name) => (srcFor[name] !== undefined ? parseGoals(srcFor[name]) : null);
  return { e, game, lines };
}
const sentCmds = (game, cmd) => game.calls.filter((c) => c[0] === cmd);

t('the engine promotes straight over the sitting mayor — no dischargeChief is sent', async () => {
  const a = city('Mayorville', [hero({ name: 'Old', status: 1, management: 50 }), hero({ name: 'Better', management: 300 })]);
  const { e, game } = engineFor([a], { Mayorville: 'config hero:1' });
  const r = await e.focus(a);
  eq(sentCmds(game, 'dischargeChief'), [], 'no discharge');
  eq(sentCmds(game, 'promoteToChief').map((c) => c[2]), [a.heros[1].id]);
  ok(r.acted.some((x) => /appoint Better as mayor .* -> ok/.test(x)), r.acted.join(' | '));
});

t('a refused promotion leaves the old mayor in office and backs off instead of asking every slice', async () => {
  const a = city('Stubborn', [hero({ name: 'Old', status: 1, management: 50 }), hero({ name: 'Better', management: 300 })]);
  const { e, game } = engineFor([a], { Stubborn: 'config hero:1' });
  game.promoteReply = { ok: -1, errorMsg: 'no' };
  await e.focus(a);
  eq(sentCmds(game, 'dischargeChief'), [], 'the old mayor was never stood down');
  eq(a.heros[0].status, 1);
  const r2 = await e.focus(a);
  eq(sentCmds(game, 'promoteToChief').length, 1, 'the refused promotion was not sent again straight away');
  has(r2.mayor.note, /held back: appoint Better/);
});

t('an ok the server never acted on is held back on the ladder, not sent every slice (Lord24 city 3, 2026-09-27)', async () => {
  const a = city('Deaf', [hero({ name: 'Idle1', management: 50 }), hero({ name: 'QUEEN2', management: 500 })]);
  const { e, game } = engineFor([a], { Deaf: 'config hero:1' });
  await e.focus(a);                                    // ok, but the roster never changes
  eq(sentCmds(game, 'promoteToChief').length, 1);
  const cs = Object.values(e.state).find((s) => s && s.mayorAsked);
  ok(cs, 'the promotion is remembered until the roster shows it');
  cs.mayorAsked.at -= 60000;                           // a slice later, still no mayor
  const r2 = await e.focus(a);
  eq(sentCmds(game, 'promoteToChief').length, 1, 'not sent again straight away');
  ok(r2.acted.some((x) => /the server answered ok but nothing changed/.test(x)), r2.acted.join(' | '));
  has(r2.mayor.note, /held back: appoint QUEEN2 .* never became mayor/);
});

t('an ok the roster confirms clears the watch', async () => {
  const a = city('Fine', [hero({ name: 'Idle1', management: 50 }), hero({ name: 'Pol', management: 500 })]);
  const { e, game } = engineFor([a], { Fine: 'config hero:1' });
  game.promoteToChief = async (cid, hid) => { game.calls.push(['promoteToChief', cid, hid]); a.heros.find((h) => h.id === hid).status = 1; return { ok: 1 }; };
  await e.focus(a);
  const r2 = await e.focus(a);
  eq(sentCmds(game, 'promoteToChief').length, 1);
  ok(!Object.values(e.state).some((s) => s && s.mayorAsked), 'nothing left to watch');
  has(r2.mayor.note, /Pol already set/);
});

// ======================================================================
section('2. one base formula: Game.heroBase');
// ======================================================================
t('the hero-string base is Game.heroBase: top attribute - level + unspent points; *Added plays no part', () => {
  const griselda = hero({ name: 'Griselda', level: 26, power: 87, powerAdded: 0 });        // the live example: base 61
  eq(H.heroBase(griselda), 61);
  eq(H.heroBase(griselda), Game.heroBase(griselda));
  eq(H.FIELDS.base(griselda), 61);
  eq(H.FIELDS.bse(griselda), 61);
  const withAdded = hero({ level: 26, power: 87, powerAdded: 40 });
  eq(H.heroBase(withAdded), 61, 'a filled *Added no longer lowers it');
  eq(H.heroBase(hero({ level: 10, power: 60, remainPoint: 5 })), 55, 'unspent points count');
  eq(H.heroBase(hero({ level: 5, power: 10, management: 70, stratagem: 30 })), 65, 'the TOP attribute, whichever it is');
});

t('the default keep rule no longer protects every hero past level ~20', () => {
  // Under the old formula base>=69 read the whole attribute: 87 >= 69, kept.
  const griselda = hero({ name: 'Griselda', level: 26, power: 87 });
  const natural = hero({ name: 'Natural', level: 30, power: 100 });                          // base 70
  const roster = [griselda, natural, hero({ name: 'Mayor', status: 1, management: 60 })];     // base 50
  const keep = H.parseHeroString(H.DEFAULT_KEEP);
  eq(H.matchHeroes(roster, keep).map((h) => h.name), ['Natural'], 'L26 base 61 is not kept; base 70 is');
  const spam = H.matchHeroes([griselda, natural], H.DEFAULT_SPAM).map((h) => h.name);
  eq(spam, ['Griselda'], 'and the spam default now selects the junk hero');
});

t('npcheroes any:base>=65 uses the same base', () => {
  const pool = [hero({ name: 'Junk', level: 40, power: 95 }), hero({ name: 'Good', level: 40, power: 110 })];   // 55, 70
  eq(H.matchHeroes(pool, 'any:base>=65').map((h) => h.name), ['Good']);
});

t('recruit.js judges inn offers by Game.heroBase too', () => {
  const src = fs.readFileSync(path.join(__dirname, 'recruit.js'), 'utf8');
  ok(/Game\.heroBase\(h\)/.test(src), 'recruit.js should use Game.heroBase');
  ok(!/h\[k \+ 'Added'\]/.test(src), 'and no longer subtract *Added');
});

// ======================================================================
section('3. the Feasting Hall\'s size from the inn (posCount)');
// ======================================================================
function realGame(castles, reply) {
  const g = new Game();
  g.castles = castles;
  g.player = { playerInfo: { userName: 'T' }, items: [] };
  g.sent = [];
  g.req = async (cmd, data) => { g.sent.push({ cmd, data }); return typeof reply === 'function' ? reply(cmd, data) : reply; };
  return g;
}

t('Game.tavernList notes posCount with the roster size, so the hall\'s size is posCount + heroes then', async () => {
  const a = city('Inny', [hero({}), hero({})], { hall: 10 });
  const g = realGame([a], { ok: 1, heros: [], posCount: 3 });
  await g.tavernList(a.castleId);
  eq(g.sent.map((s) => s.cmd), ['hero.getHerosListFromTavern']);
  const s = g.hallSeen[a.castleId];
  eq([s.posCount, s.heroes, s.capacity, s.fhLevel], [3, 2, 5, 10]);
  const hall = H.feastingHall({ game: g, castle: a, config: {} });
  eq([hall.capacity, hall.free, hall.fresh], [5, 3, true], 'the server\'s 5, not the inferred 10');
  has(hall.source, /the inn: 3 free with 2 hero\(es\)/);
});

t('the reading follows hires, fires and arrivals: free = size - heroes now', async () => {
  const a = city('Inny', [hero({}), hero({})], { hall: 10 });
  const g = realGame([a], { ok: 1, heros: [], posCount: 3 });
  await g.tavernList(a.castleId);
  a.heros.push(hero({}), hero({}));
  eq(H.feastingHall({ game: g, castle: a, config: {} }).free, 1, 'two arrived');
  a.heros.splice(0, 3);
  eq(H.feastingHall({ game: g, castle: a, config: {} }).free, 4, 'three left');
});

t('a refresh notes it too; a reply without posCount, or a refusal, is not noted', async () => {
  const a = city('Inny', [hero({})]);
  const g = realGame([a], { ok: 1, heros: [], posCount: 2 });
  await g.refreshTavern(a.castleId);
  eq(g.hallSeen[a.castleId].capacity, 3);
  const b = city('Quiet', [hero({})]);
  const g2 = realGame([b], { ok: 1, heros: [] });
  await g2.tavernList(b.castleId);
  eq(g2.hallSeen, undefined, 'no posCount: nothing noted (the client would read 0, "full")');
  const g3 = realGame([b], { ok: -1, errorMsg: 'no', posCount: 0 });
  await g3.tavernList(b.castleId);
  eq(g3.hallSeen, undefined, 'a refusal notes nothing');
});

t('a reading taken at another Feasting Hall level is ignored, and the inference comes back', () => {
  const a = city('Grown', [hero({}), hero({})], { hall: 6 });
  const g = planGame([a]);
  readInn(g, a, 1);                                      // size 3 at L6
  eq(H.feastingHall({ game: g, castle: a, config: {} }).capacity, 3);
  a.buildings[0].level = 7;
  const hall = H.feastingHall({ game: g, castle: a, config: {} });
  eq([hall.capacity, hall.readAt], [7, null], 'L7: inferred again until the inn is read');
});

t('with no reading the size is inferred as one slot per level, as before', () => {
  const a = city('Guess', [hero({})], { hall: 8 });
  const hall = H.feastingHall({ game: planGame([a]), castle: a, config: { feastinghallspace: 2 } });
  // step 12: no training hero comes here, so no slot is held for one (was 3)
  eq([hall.capacity, hall.free, hall.wantFree, hall.readAt, hall.fresh], [8, 7, 2, null, false]);
  has(hall.source, /inferred/);
  eq(H.feastingHall({ castle: a }).capacity, 8, 'no game at all (stone-of-finding calls it this way)');
});

t('the readHall executor stamps the attempt, reads the inn and reports the count', async () => {
  const a = city('Inny', [hero({})]);
  const g = realGame([a], { ok: 1, heros: [], posCount: 4 });
  const state = {};
  const r = await H.executors.readHall(g, a, { kind: 'readHall' }, state);
  eq([r.ok, r.posCount], [1, 4]);
  ok(state.hallReadAt > 0, 'hallReadAt stamped');
  eq(g.hallSeen[a.castleId].capacity, 5);
  const g2 = realGame([a], { ok: 1, heros: [] });
  const r2 = await H.executors.readHall(g2, a, { kind: 'readHall' }, {});
  eq(r2.ok, 0);
  has(r2.errorMsg, /no free-slot count/);
});

// ======================================================================
section('4. firing per NEAT: only for room, or with /always');
// ======================================================================
// Two cities list the training hero Otto; he is in A. B's hall is full.
function trainingPair({ bHeroes, bSrc = 'config hero:10\ntraininghero Otto 60', aSrc = 'traininghero Otto 60', hall = 4 } = {}) {
  const otto = hero({ name: 'Otto', power: 400 });
  const a = city('A', [otto, hero({ name: 'AMayor', status: 1 })]);
  const b = city('B', bHeroes || [
    hero({ name: 'BMayor', status: 1, management: 40 }),
    hero({ name: 'PolIdle', level: 5, power: 3, management: 60, stratagem: 5 }),   // base 55: the best politics hero, idle
    hero({ name: 'Weak', level: 8, power: 15, management: 5 }),                    // base 7
    hero({ name: 'Keeper', level: 60, power: 30 }),                                // L50+: kept by default
  ], { hall });
  const game = planGame([a, b]);
  const ctx = ctxFor(game, b, bSrc, { A: aSrc });
  return { otto, a, b, game, ctx };
}

t('a hall short of feastinghallspace fires nobody — it is where hiring stops', () => {
  const b = city('B', [hero({ name: 'M', status: 1, management: 99 }), hero({ name: 'J1', power: 5 }), hero({ name: 'J2', power: 6 })], { hall: 3 });
  const game = planGame([b]);
  readInn(game, b, 0);
  const p = H.plans.keepheroes(ctxFor(game, b, 'config hero:10,feastinghallspace:4'), {});
  eq(p.actions, []);
  has(p.note, /none needs to go/);
  // step 12: 4, not 5 — no training hero comes here, so no slot is held for one
  has(H.plans.feastinghallspace(ctxFor(game, b, 'config hero:10,feastinghallspace:4')).note, /4 slot\(s\) short of it: no hiring, and nobody is fired for it/);
});

t('room for a training hero on its way: the hall is read from the inn first', () => {
  const { ctx } = trainingPair();
  const p = H.plans.keepheroes(ctx, {});
  eq(kinds(p), ['readHall']);
  has(p.note, /room for traininghero Otto \(now in A\).*asking the inn first/);
});

t('...then, full by a fresh count, it fires by config hero: the best politics hero is set aside, then the worst attack goes', () => {
  const { ctx, game, b } = trainingPair();
  readInn(game, b, 0);
  const p = H.plans.keepheroes(ctx, { hallReadAt: Date.now() });
  // hero:10 keeps the 1 best politics hero: PolIdle (60), although it has the
  // worst attack. Keeper is L60 (default keep). So Weak goes, not PolIdle.
  eq(fires(p), ['Weak']);
  has(p.actions[0].label, /room for traininghero Otto .* irreversible/);
  has(p.note, /the hall is full \(4\/4/);
});

t('...and with a free slot nobody is fired', () => {
  const { ctx, game, b } = trainingPair({ hall: 5 });
  readInn(game, b, 1);
  const p = H.plans.keepheroes(ctx, {});
  eq(p.actions, []);
  has(p.note, /room for traininghero Otto \(now in A\): 1 slot\(s\) free/);
});

t('a reading older than 10 minutes is read again before a fire, at most every 10 minutes', () => {
  const { ctx, game, b } = trainingPair();
  readInn(game, b, 0, { at: Date.now() - 11 * 60e3 });
  eq(kinds(H.plans.keepheroes(ctx, {})), ['readHall'], 'stale: confirm first');
  eq(fires(H.plans.keepheroes(ctx, { hallReadAt: Date.now() - 60e3 })), ['Weak'], 'asked a minute ago: act on what it has');
});

t('when the inn gives no count, the inferred size is used, as before', () => {
  const { ctx } = trainingPair({ hall: 4 });
  const p = H.plans.keepheroes(ctx, { hallReadAt: Date.now() - 60e3 });   // a read was tried; nothing came back
  eq(fires(p), ['Weak']);
  has(p.note, /inferred/);
});

t('config hero:1 never fires for room and never reads the inn — it only says the hall is full', () => {
  const { ctx } = trainingPair({ bSrc: 'config hero:1\ntraininghero Otto 60' });
  const p = H.plans.keepheroes(ctx, {});
  eq(p.actions, []);
  has(p.note, /the hall is full \(0 slot\(s\) free\), and config hero:1/);
});

t('a training hero parked in the only city that lists it is not coming: no room is made', () => {
  const { ctx } = trainingPair({ aSrc: 'config hero:0' });
  const p = H.plans.keepheroes(ctx, {});
  eq(p.actions, []);
  has(p.note, /none needs to go/);
});

t('when the training hero is already here nothing is fired for it', () => {
  const otto = hero({ name: 'Otto', power: 400 });
  const b = city('B', [hero({ name: 'M', status: 1, management: 99 }), otto, hero({ name: 'J', power: 3 })], { hall: 3 });
  const a = city('A', [hero({ name: 'AM', status: 1 })]);
  const game = planGame([a, b]);
  readInn(game, b, 0);
  const p = H.plans.keepheroes(ctxFor(game, b, 'config hero:10\ntraininghero Otto 60', { A: 'traininghero Otto 60' }), {});
  eq(p.actions, []);
});

t('a training hero is never fired, even by /always', () => {
  const otto = hero({ name: 'Otto', level: 5, power: 1 });                // the weakest, unprotected
  const a = city('A', [hero({ name: 'M', status: 1, management: 99 }), otto, hero({ name: 'J', level: 5, power: 9 })]);
  const b = city('B', [hero({ name: 'BM', status: 1 })]);
  const game = planGame([a, b]);
  const p = H.plans.keepheroes(ctxFor(game, a, 'config hero:10\nkeepheroes /always /max:9', { B: 'traininghero Otto 60' }), {});
  eq(fires(p), ['J']);
});

t('config hero:21 sets aside two politics and one intel hero before the worst attack goes', () => {
  const roster = [
    hero({ name: 'Mayor', status: 1, management: 500 }),
    hero({ name: 'Pol2', level: 5, power: 1, management: 400 }),
    hero({ name: 'Int1', level: 5, power: 2, stratagem: 400 }),
    hero({ name: 'Int2', level: 5, power: 3, stratagem: 300 }),
    hero({ name: 'Atk', level: 5, power: 40 }),
  ];
  const b = city('B', roster, { hall: 5 });
  const game = planGame([b]);
  readInn(game, b, 0);
  // keep only L100+, so the high-base heroes are not simply protected
  const p = H.makeRoom(ctxFor(game, b, 'config hero:21\nkeepheroes any:level>=100'), { hallReadAt: Date.now() }, { need: 1, reason: 'a hire' });
  eq(fires(p), ['Int2'], 'the 2nd intel hero has the worst attack of the rest');
  const p10 = H.makeRoom(ctxFor(game, b, 'config hero:10\nkeepheroes any:level>=100'), { hallReadAt: Date.now() }, { need: 1, reason: 'a hire' });
  eq(fires(p10), ['Pol2'], 'with hero:10 only the mayor is set aside, and Pol2 has the worst attack');
});

t('makeRoom, for the hiring step: fires to the shortfall, one per pass unless /max says more', () => {
  const junk = (n, p) => hero({ name: n, level: 5, power: p });
  const b = city('B', [hero({ name: 'M', status: 1, management: 99 }), junk('J1', 3), junk('J2', 4), junk('J3', 5)], { hall: 4 });
  const game = planGame([b]);
  readInn(game, b, 0);
  const st = { hallReadAt: Date.now() };
  eq(fires(H.makeRoom(ctxFor(game, b, 'config hero:10'), st, { need: 2, reason: 'two hires' })), ['J1']);
  eq(fires(H.makeRoom(ctxFor(game, b, 'config hero:10\nkeepheroes /max:5'), st, { need: 2, reason: 'two hires' })), ['J1', 'J2']);
  eq(fires(H.makeRoom(ctxFor(game, b, 'config hero:10\nkeepheroes /max:5'), st, { need: 0, reason: 'nothing' })), []);
});

t('prisoners are never fired for room; the note names them and points at release', () => {
  const b = city('B', [
    hero({ name: 'M', status: 1, management: 99 }),
    hero({ name: 'Captive', status: 4, level: 3, power: 1 }),
    hero({ name: 'Keeper', level: 80, power: 50 }),
  ], { hall: 3 });
  const game = planGame([b]);
  readInn(game, b, 0);
  const p = H.makeRoom(ctxFor(game, b, 'config hero:10'), { hallReadAt: Date.now() }, { need: 1, reason: 'a hire' });
  eq(p.actions, []);
  has(p.note, /every hero is protected or busy/);
  // with no keepcapturedheroes line the prisoner is still never touched, and
  // the note says so and points at the line that would free the slot
  has(p.note, /1 prisoner\(s\) hold slots \(Captive\) — no keepcapturedheroes line here/);
});

// ======================================================================
section('5. the fire cooldown and captured heroes');
// ======================================================================
t('the fireHero executor writes lastFireAt when the fire goes through, and not when it is refused', async () => {
  const j = hero({ name: 'J' });
  const c = city('X', [j, hero({ name: 'K' })]);
  const game = { castleId: (x) => x.castleId, fireHero: async () => ({ ok: 1 }) };
  const state = {};
  await H.executors.fireHero(game, c, { heroId: j.id, heroName: 'J' }, state);
  ok(state.lastFireAt > Date.now() - 5000, 'stamped');
  const refused = {};
  await H.executors.fireHero({ castleId: (x) => x.castleId, fireHero: async () => ({ ok: -1, errorMsg: 'no' }) }, c, { heroId: j.id, heroName: 'J' }, refused);
  eq(refused.lastFireAt, undefined);
});

t('through the engine: a fire starts the 60 s cooldown, so the next slice fires nobody', async () => {
  const x = city('Firetown', [
    hero({ name: 'M', status: 1, management: 99 }),
    hero({ name: 'J1', level: 5, power: 3 }), hero({ name: 'J2', level: 5, power: 4 }),
  ]);
  const { e, game } = engineFor([x], { Firetown: 'config hero:10\nkeepheroes /always any:level>=50' });
  await e.focus(x);
  eq(sentCmds(game, 'fireHero').map((c) => c[2]), [x.heros[1].id]);
  ok(e.state[x.castleId].lastFireAt > 0, 'the engine handed the executor the city state');   // Step 6 keys city state by castle id
  x.heros.splice(1, 1);                                   // the server's delete push
  const r = await e.focus(x);
  eq(sentCmds(game, 'fireHero').length, 1, 'no second fire inside the cooldown');
  has(r.keepheroes.note, /waiting out the cooldown/);
});

t('prisoners are recorded in state.capturedHeroes, and one persuaded later is judged by keepcapturedheroes', () => {
  const pris = hero({ name: 'Taken', status: 4, level: 60, power: 70 });     // base 10
  const x = city('Jail', [hero({ name: 'M', status: 1, management: 99 }), pris, hero({ name: 'Own', level: 60, power: 75 })]);
  const state = {};
  const p = H.plans.captives({ castle: x, goals: [], config: {} }, state);
  has(p.note, /prisoners: Taken L60 — held: no keepcapturedheroes line here/);
  ok(state.capturedHeroes[pris.id], 'recorded');
  pris.status = 0;                                        // persuaded: ours now, same id
  const c = ctxFor(planGame([x]), x, 'config hero:10\nkeepheroes /always /max:5');
  // keepheroes' default keeps L50+ (Own, L60); keepcapturedheroes' keeps L200+ or base>69
  eq(fires(H.plans.keepheroes(c, state)), ['Taken']);
  eq(H.plans.captives({ castle: x, goals: [], config: {} }, state), null, 'no prisoner left to report');
  ok(state.capturedHeroes[pris.id], 'the record outlives the prisoner status');
});

t('a record is dropped when the hero leaves the city, but not off an empty roster', () => {
  const pris = hero({ name: 'Taken', status: 4 });
  const x = city('Jail', [hero({ name: 'M', status: 1 }), pris]);
  const state = { capturedHeroes: [pris.id] };           // the old array form is taken over
  H.plans.captives({ castle: x }, state);
  eq(Object.keys(state.capturedHeroes), [String(pris.id)]);
  x.heros = [];
  H.plans.captives({ castle: x }, state);
  eq(Object.keys(state.capturedHeroes), [String(pris.id)], 'an empty roster may just not have arrived');
  x.heros = [hero({ name: 'M', status: 1 })];
  H.plans.captives({ castle: x }, state);
  eq(Object.keys(state.capturedHeroes), [], 'gone from a whole roster: forgotten');
});

t('the keepcapturedheroes default is the wiki\'s base>69, strictly: base 69 is not kept, base 70 is', () => {
  eq(H.DEFAULT_KEEP_CAPTURED, 'any:level>=200|any:base>69');
  const b69 = hero({ name: 'B69', level: 20, power: 89 }), b70 = hero({ name: 'B70', level: 20, power: 90 });
  eq(H.matchHeroes([b69, b70], H.DEFAULT_KEEP_CAPTURED).map((h) => h.name), ['B70']);
});

// ======================================================================
section('6. unspent points go to the highest stat by default (config hero >= 1)');
// ======================================================================
const pointsCtx = (heros, src) => ctxFor(planGame([]), { castleId: 9, name: 'P', heros }, src);

t('with config hero:1 a hero no heropoints line matches spends everything on its highest stat', () => {
  const pol = hero({ name: 'Pol', management: 120, power: 20, remainPoint: 7 });
  const atk = hero({ name: 'Atk', power: 90, remainPoint: 3 });
  const p = H.plans.heropoints(pointsCtx([pol, atk], 'config hero:1'), {});
  eq(p.actions.map((a) => [a.heroName, a.add]), [['Pol', { power: 0, management: 7, stratagem: 0 }], ['Atk', { power: 3, management: 0, stratagem: 0 }]]);
  has(p.note, /2 on the highest stat, by default/);
  has(p.actions[0].label, /no heropoints rule, config hero:1/);
});

t('under config hero:0 or unset, only written rules spend points', () => {
  const pol = hero({ name: 'Pol', management: 120, remainPoint: 7 });
  eq(H.plans.heropoints(pointsCtx([pol], 'config hero:0'), {}), null);
  eq(H.plans.heropoints(pointsCtx([pol], 'config comfort:1'), {}), null);
  eq(H.plans.heropoints(pointsCtx([pol], 'config hero:0\nheropoints pol int:*'), {}).actions[0].add, { power: 0, management: 0, stratagem: 7 });
});

t('a written rule still wins, and heroes it leaves out get the default', () => {
  const a = hero({ name: 'Ruled', power: 90, remainPoint: 4 });
  const b = hero({ name: 'Free', stratagem: 90, remainPoint: 4 });
  const p = H.plans.heropoints(pointsCtx([a, b], 'config hero:1\nheropoints Ruled pol:*'), {});
  eq(p.actions.map((x) => [x.heroName, x.add]), [['Ruled', { power: 0, management: 4, stratagem: 0 }], ['Free', { power: 0, management: 0, stratagem: 4 }]]);
});

t('the default leaves alone prisoners, heroes nolevelheroes holds, and heroes with nothing to spend', () => {
  const pris = hero({ name: 'Pris', status: 4, power: 90, remainPoint: 4 });
  const held = hero({ name: 'ForBob', power: 90, remainPoint: 4 });
  const none = hero({ name: 'Spent', power: 90 });
  eq(H.plans.heropoints(pointsCtx([pris, held, none], 'config hero:1\nnolevelheroes ForBob'), {}), null);
});

// ======================================================================
section('7. the traininghero: npc hits counted, and only a hero at home moves');
// ======================================================================
function rotation({ ottoStatus = 0, src = 'traininghero Otto 60 3600 2' } = {}) {
  const otto = hero({ name: 'Otto', status: ottoStatus, power: 300 });
  const a = city('A', [otto]);
  const b = city('B', []);
  const game = { castles: [a, b], castleId: (c) => c.castleId };
  const cityGoals = [a, b].map((castle) => ({ castle, parsed: parseGoals(src) }));
  return { otto, a, b, game, cityGoals };
}
const hit = (state, otto) => NPC._internals.recordSend(state, { fieldId: nextId++, level: 5, heroId: otto.id, hero: otto, roundTripMs: 1000 }, { ok: 1 });

t('goal-npc records each run\'s time per hero in the sending city\'s state', () => {
  const otto = hero({ name: 'Otto' });
  const s = {};
  hit(s, otto); hit(s, otto);
  eq(s.heroHits.otto.length, 2);
  eq(s.npcHits, 2, 'the city total is still kept');
  NPC._internals.recordSend(s, { fieldId: 1, level: 5, heroId: otto.id, hero: otto }, { ok: 0 });
  eq(s.heroHits.otto.length, 2, 'a refused send is not a hit');
});

t('the npchits exit fires: after 2 hits it moves on before maxstay', () => {
  const { otto, a, game, cityGoals } = rotation();
  const state = { A: {}, hero: { otto: { since: Date.now() - 120e3, at: a.castleId, npcHits: 0 } } };
  hit(state.A, otto);
  let p = M.trainingHeroPlan(game, cityGoals, state)[0];
  eq(p.actions, undefined);
  has(p.note, /1\/2 npc hits/);
  hit(state.A, otto);
  p = M.trainingHeroPlan(game, cityGoals, state)[0];
  eq(p.actions.map((x) => x.kind), ['moveHero']);
  eq(state.hero.otto.npcHits, 2);
});

t('a city with its own traininghero line AND the prepend one is listed once: the hero moves on (Lord02, 2026-09-19)', () => {
  const otto = hero({ name: 'OTTO', status: 0, power: 900 });
  const [a, b, c] = [city('A', [otto]), city('B', []), city('C', [])];
  const game = { castles: [a, b, c], castleId: (x) => x.castleId };
  // the city's own line first, then the prepend's, as goallayers orders them
  const both = () => { const p = parseGoals('traininghero OTTO 30 60\ntraininghero OTTO'); return p; };
  const cityGoals = [a, b, c].map((castle) => ({ castle, parsed: both() }));
  eq(cityGoals[0].parsed.goals.filter((g) => g.name === 'traininghero').length, 2, 'both lines are kept by the parser');
  const state = { hero: { otto: { since: Date.now() - 90e3, at: a.castleId } } };
  const p = M.trainingHeroPlan(game, cityGoals, state)[0];
  eq(p.actions && p.actions.map((x) => x.to.name), ['B'], p.note);
  // the stay is the city's own line (30-60 s), not the prepend's 600 s
  const early = M.trainingHeroPlan(game, cityGoals, { hero: { otto: { since: Date.now() - 20e3, at: a.castleId } } })[0];
  has(early.note, /min 30s/);
});

t('hits from before its stay do not count', () => {
  const { otto, a, game, cityGoals } = rotation();
  const state = { A: { heroHits: { otto: [Date.now() - 900e3, Date.now() - 800e3] } }, hero: { otto: { since: Date.now() - 120e3, at: a.castleId } } };
  const p = M.trainingHeroPlan(game, cityGoals, state)[0];
  eq(p.actions, undefined);
  eq(state.hero.otto.npcHits, 0);
  void otto;
});

t('on arrival, a run the new city sent before the rotation noticed still counts (hits count from the move)', () => {
  const { otto, a, b, game, cityGoals } = rotation();
  a.heros = []; b.heros = [otto];                         // arrived in B
  const sentAt = Date.now() - 300e3;                      // engine.js stamped `since` when it sent the move
  const state = { B: { heroHits: { otto: [sentAt + 200e3] } }, hero: { otto: { since: sentAt, at: a.castleId } } };
  M.trainingHeroPlan(game, cityGoals, state);
  eq(state.hero.otto.at, b.castleId);
  eq(state.hero.otto.npcHits, 1);
});

t('a city\'s state under its id (no name) is found too', () => {
  const { otto, a, game, cityGoals } = rotation();
  a.name = '';
  const state = { [String(a.castleId)]: {}, hero: { otto: { since: Date.now() - 120e3, at: a.castleId } } };
  hit(state[String(a.castleId)], otto); hit(state[String(a.castleId)], otto);
  eq(M.trainingHeroPlan(game, cityGoals, state)[0].actions.length, 1);
});

t('a training hero that is not at home is not moved; the mayor is', () => {
  for (const [st, word] of [[3, 'marching'], [8, 'farming'], [5, 'returning'], [2, 'guarding a valley'], [4, 'a prisoner']]) {
    const { a, game, cityGoals } = rotation({ ottoStatus: st, src: 'traininghero Otto 60' });
    const state = { hero: { otto: { since: Date.now() - 120e3, at: a.castleId } } };
    const p = M.trainingHeroPlan(game, cityGoals, state)[0];
    eq(p.actions, undefined, `status ${st}`);
    has(p.note, new RegExp(`but it is ${word} — it moves once it is home`), `status ${st}`);
  }
  const { a, game, cityGoals } = rotation({ ottoStatus: 1, src: 'traininghero Otto 60' });
  const p = M.trainingHeroPlan(game, cityGoals, { hero: { otto: { since: Date.now() - 120e3, at: a.castleId } } })[0];
  eq(p.actions.map((x) => x.kind), ['moveHero'], 'the mayor (the engine stands it down first)');
});

t('the engine checks the status again before it sends the move', async () => {
  const otto = hero({ name: 'Otto', status: 3 });
  const a = city('A', [otto]);
  const b = city('B', []);
  const { e, game, lines } = engineFor([a, b], { A: 'config hero:0\ntraininghero Otto 0', B: 'config hero:0\ntraininghero Otto 0' });
  const real = M.trainingHeroPlan;
  M.trainingHeroPlan = () => [{ hero: 'Otto', note: 'stale plan', actions: [{ kind: 'moveHero', heroName: 'Otto', from: a, to: b, label: 'move Otto to B' }] }];
  try { await e.tick(); } finally { M.trainingHeroPlan = real; }
  eq(sentCmds(game, 'newArmy'), [], 'no march');
  eq(sentCmds(game, 'dischargeChief'), [], 'no discharge');
  ok(lines.some((l) => /move Otto to B -> Otto is not at home \(status 3\), not moving/.test(l)), lines.join('\n'));
});

// ======================================================================
section('8. guards: release, "any", prisoners in the console, the inn refresh');
// ======================================================================
const parseErr = (line) => { try { script.parseLine(line); } catch (e) { return e.message; } return null; };

t('"any" is refused in fire, release, mayor, levelup and addpoint; levelup all still works', () => {
  for (const line of ['fire any', 'release any', 'mayor any', 'appoint ANY', 'levelup any', 'levelup any attack', 'addpoint any attack 5', 'fire any:level<50']) {
    has(parseErr(line), /name the hero — ".*" is refused here/, line);
  }
  has(parseErr('levelup attack'), /levelup: give a hero name/, 'a bare attribute used to level the first hero');
  has(parseErr('addpoint attack 5'), /addpoint: give a hero name/);
  eq(script.parseLine('levelup all').name, 'all');
  eq(script.parseLine('fire Anya').name, 'Anya', 'a name that starts with "any" is still a name');
});

t('the script editor paints a refused "any" red with the reason (script.lineStatus)', () => {
  const s = script.lineStatus('fire any\nfire Bob\ninnrefresh');
  eq(s.lines.map((l) => l.status), ['error', 'ok', 'ok']);
  has(s.lines[0].msg, /fire: name the hero — "any" is refused here/);
  // innrefresh force is gone (scripts spend cents only through buyitem): red too
  eq(script.lineStatus('innrefresh force').lines[0].status, 'error');
});

t('the goals editor: keepcapturedheroes now acts (ok), and since step 12 fasthero too', () => {
  const G = require('./goals');
  const l = (src) => parseGoals(src).lines[0];
  eq(l('keepcapturedheroes any:level>=200').status, 'ok');
  ok(!('keepcapturedheroes' in G.NOT_IMPLEMENTED.goals), 'off the idle table');
  // changed on purpose (step 12): the hiring step reads config fasthero
  eq(l('config fasthero:65').status, 'ok');
  ok(!('fasthero' in G.NOT_IMPLEMENTED.config), 'off the idle table');
  for (const src of ['config hero:10,nomayor:1,feastinghallspace:2', 'keepheroes any:level>=50', 'heropoints any att', 'nolevelheroes ForBob', 'traininghero OTTO 30 60 5']) {
    eq(l(src).status, 'ok', src);
  }
});

t('Game.findHero matches a name only: "any" and an empty name find nobody', () => {
  const g = new Game();
  const c = { heros: [hero({ name: 'First' }), hero({ name: 'Bob' })] };
  eq(g.findHero(c, 'any'), null);
  eq(g.findHero(c, ''), null);
  eq(g.findHero(c, undefined), null);
  eq(g.findHero(c, 'BOB').name, 'Bob');
});

t('Game.heroActionRefusal: release only a prisoner; fire and promote never one; promote only an idle hero', () => {
  const R = (a, st) => Game.heroActionRefusal(a, hero({ name: 'H', status: st }));
  eq(R('release', 4), null);
  for (const st of [0, 1, 2, 3, 5, 8]) has(R('release', st), /not a prisoner/, `release status ${st}`);
  has(R('fire', 4), /prisoner you hold — a prisoner is dismissed with release/);
  eq(R('fire', 0), null);
  has(R('mayor', 4), /prisoner you hold — only your own heroes/);
  for (const st of [2, 3, 5, 8]) has(R('mayor', st), /not idle at home/, `mayor status ${st}`);
  eq(R('mayor', 0), null);
  has(Game.heroActionRefusal('fire', null), /not found/);
});

t('Game.innRefreshCost: a Hero Hunting when held, coins when not, unknown before the inventory loads', () => {
  const g = new Game();
  g.player = {};
  eq([g.innRefreshCost().held, g.innRefreshCost().item], [null, false]);
  g.player.items = [];
  eq([g.innRefreshCost().held, g.innRefreshCost().item], [0, false]);
  has(g.innRefreshCost().text, /charges game coins/);
  g.player.items = [{ id: 'consume.refreshtavern.1', count: 3 }];
  eq([g.innRefreshCost().held, g.innRefreshCost().item], [3, true]);
  has(g.innRefreshCost().text, /spends 1 Hero Hunting \(3 held\)/);
});

// A script world: a real Game whose only network call, req, is recorded.
function scriptWorld(heros, items = []) {
  const g = new Game();
  g.player = { playerInfo: { userName: 'T' }, items };
  const c = { id: 7, name: 'Nine', fieldId: C.coordsToFieldId(5, 5), heros, buildings: [] };
  g.castles = [c];
  const sent = [];
  g.req = async (cmd, data) => { sent.push(cmd); return { ok: 1, heros: [] }; };
  return { g, c, sent };
}
async function runScript(w, src) {
  const out = [];
  await script.run(w.g, script.parse(src), (m) => out.push(m), { castle: 'Nine', repeatGapMs: 0 });
  return out.join('\n');
}

t('script release refuses one of our own heroes, and sends only for a prisoner', async () => {
  const w = scriptWorld([hero({ name: 'Own', status: 0 }), hero({ name: 'Pris', status: 4 })]);
  const text = await runScript(w, 'release Own\nrelease Pris');
  has(text, /not sent: Own is not a prisoner \(idle\) — release only dismisses a prisoner you hold/);
  has(text, /release Pris .*\n.*Stone of Finding/);
  eq(w.sent, ['hero.releaseHero'], 'only the prisoner');
});

t('script fire refuses a prisoner; fire of our own hero goes', async () => {
  const w = scriptWorld([hero({ name: 'Own' }), hero({ name: 'Pris', status: 4 })]);
  const text = await runScript(w, 'fire Pris\nfire Own');
  has(text, /not sent: Pris is a prisoner you hold/);
  eq(w.sent, ['hero.fireHero']);
});

t('script mayor: never a prisoner or a hero away, straight over the sitting mayor for an idle one', async () => {
  const w = scriptWorld([hero({ name: 'Sitting', status: 1 }), hero({ name: 'Pris', status: 4 }), hero({ name: 'Away', status: 3 }), hero({ name: 'Idle' })]);
  const text = await runScript(w, 'mayor Pris\nmayor Away\nmayor Sitting\nmayor Idle');
  has(text, /not sent: Pris is a prisoner you hold/);
  has(text, /not sent: Away is marching, not idle at home/);
  has(text, /Sitting is already mayor of Nine/);
  eq(w.sent, ['hero.promoteToChief'], 'one promotion, no dischargeChief');
});

t('script innrefresh never pays coins: it spends a Hero Hunting or does nothing', async () => {
  const none = scriptWorld([hero({})], []);
  has(await runScript(none, 'innrefresh'), /not refreshed: no Hero Hunting held, so the server charges game coins — buy a Hero Hunting with buyitem first \(buyitem Hero Hunting\)/);
  eq(none.sent, [], 'nothing sent');
  // there is no "force": a refresh paid in coins can only be bought as an item
  has(parseErr('innrefresh force'), /scripts spend cents only through buyitem/);
  eq(none.sent, [], 'still nothing sent');
  const held = scriptWorld([hero({})], [{ id: 'consume.refreshtavern.1', count: 2 }]);
  has(await runScript(held, 'innrefresh'), /refresh the inn: spends 1 Hero Hunting \(2 held\)/);
  eq(held.sent[0], 'hero.refreshHerosListFromTavern');
  const unknown = scriptWorld([hero({})]);
  unknown.g.player.items = undefined;
  has(await runScript(unknown, 'innrefresh'), /not refreshed: the inventory has not loaded/);
  eq(unknown.sent, []);
  has(parseErr('innrefresh please'), /usage {2}innrefresh {3}— nothing goes after it/);
});

// The Heroes tab's Actions cell, from the real app.html source.
function heroesTab() {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'app.html'), 'utf8');
  const from = html.indexOf('const HSORT'), to = html.indexOf('// ---- Buildings');
  ok(from > 0 && to > from, 'renderHeroes not found in app.html');
  const sandbox = {
    esc: (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])),
    fmt: (x) => String(x),
    grid: (cols, rows) => rows,
  };
  vm.createContext(sandbox);
  vm.runInContext(html.slice(from, to) + '\nthis.renderHeroes = renderHeroes;', sandbox);
  return sandbox.renderHeroes;
}
t('the Heroes tab offers a prisoner no Promote, Fire or +Pts, and Promote only to an idle hero', () => {
  const render = heroesTab();
  const rows = render({ heroes: [0, 1, 2, 3, 4, 5, 8].map((st) => ({ name: 'S' + st, status: st, statusName: String(st), unspent: 3, attack: 1, politics: 1, intel: 1 })) });
  const acts = Object.fromEntries(rows.map((r) => [r.cells[1], [...r.cells[r.cells.length - 1].matchAll(/data-act="(\w+)"/g)].map((m) => m[1])]));
  // A prisoner we hold gets only the two the client offers it — Persuade and
  // Release — and none of Promote, Fire or +Pts.
  eq(acts.S4, ['persuade', 'release'], 'prisoner');
  ok(rows.find((r) => r.cells[1] === 'S4').cells[12].includes('prisoner'), 'says why');
  eq(acts.S0, ['mayor', 'points', 'water', 'fire']);
  eq(acts.S1, ['unmayor', 'points', 'water']);
  eq(acts.S2, ['recallhero']);
  eq(acts.S3, ['recallhero']);
  eq(acts.S5, ['points', 'fire'], 'returning: no Promote');
  eq(acts.S8, ['points', 'fire'], 'farming: no Promote');
});

// Experience past the current level is banked — the level only moves when
// hero.levelUp is sent, once per level. OTTO sat on 66 levels while Pts read 0,
// because every point he had won was already spent (2026-09-22).
t('the Heroes tab shows banked levels beside the level, with a Level button', () => {
  const render = heroesTab();
  const rows = render({ heroes: [
    { name: 'OTTO', status: 0, statusName: 'Idle', unspent: 0, levelsReady: 66, level: 1146, attack: 1211, politics: 39, intel: 42 },
    { name: 'Flat', status: 0, statusName: 'Idle', unspent: 0, levelsReady: 0, level: 40, attack: 5, politics: 5, intel: 5 },
    { name: 'Away', status: 3, statusName: 'Marching', unspent: 0, levelsReady: 12, level: 40, attack: 5, politics: 5, intel: 5 },
  ] });
  const by = Object.fromEntries(rows.map((r) => [r.cells[1].replace(/<[^>]*>/g, ''), r]));
  ok(String(by.OTTO.cells[5]).includes('+66'), 'the banked levels sit beside the level');
  ok(/data-act="levelup"/.test(by.OTTO.cells[12]), 'OTTO gets a Level button');
  eq(String(by.Flat.cells[5]), '40', 'no banked levels: just the number');
  ok(!/data-act="levelup"/.test(by.Flat.cells[12]), 'no button with nothing banked');
  // a hero out marching is only recalled, as the Feasting Hall offers
  ok(!/data-act="levelup"/.test(by.Away.cells[12]), 'no Level button for a hero away from town');
});

// ======================================================================
section('9. the live goals (a2: config hero:1, traininghero OTTO 30 60, npcheroes !OTTO,any)');
// ======================================================================
const LIVE_A2 = `config comfort:1,hero:1,troopsusepopmax:1,npc:5
comfortpolicy 15 16 popraise
build f:10:37
troop b:5k,t:5k
distancepolicy 15
npcteams 3
traininghero OTTO 30 60
npcheroes !OTTO,any
farmingpolicy 5 /distance:10`;

t('the a2 lines still parse', () => eq(parseGoals(LIVE_A2).errors, []));

t('a city OTTO is heading for: a note about his slot, no fire and no inn read (hero:1 never fires)', () => {
  const otto = hero({ name: 'OTTO', power: 300 });
  const a = city('F1', [otto, hero({ name: 'M1', status: 1 })]);
  const b = city('F2', [hero({ name: 'M2', status: 1 }), hero({ name: 'Farm', level: 30, power: 60 })], { hall: 2 });
  const game = planGame([a, b]);
  const p = H.plans.keepheroes(ctxFor(game, b, LIVE_A2, { F1: LIVE_A2 }), {});
  eq(p.actions, []);
  has(p.note, /room for traininghero OTTO \(now in F1\): the hall is full \(0 slot\(s\) free\), and config hero:1 — level & reward only, never fire/);
});

t('hero:1 still manages the mayor, and now spends unspent points on each hero\'s best stat', () => {
  const x = { castleId: 3, name: 'F3', heros: [hero({ name: 'Pol', status: 1, management: 200, remainPoint: 12 }), hero({ name: 'Atk', power: 150, remainPoint: 5 })] };
  const c = ctxFor(planGame([x]), x, LIVE_A2);
  eq(M.mayorPlan(c, 'idle').note, 'mayor: Pol already set for resource production');
  eq(M.mayorPlan(c, 'train').actions[0].hero.name, 'Atk');
  eq(H.plans.heropoints(c, {}).actions.map((a) => [a.heroName, a.add]),
    [['Pol', { power: 0, management: 12, stratagem: 0 }], ['Atk', { power: 5, management: 0, stratagem: 0 }]]);
});

t('OTTO out on a march when his 60 s are up waits for home instead of being sent', () => {
  const otto = hero({ name: 'OTTO', status: 3 });
  const a = city('F1', [otto]);
  const b = city('F2', []);
  const game = { castles: [a, b], castleId: (c) => c.castleId };
  const cityGoals = [a, b].map((castle) => ({ castle, parsed: parseGoals(LIVE_A2) }));
  const p = M.trainingHeroPlan(game, cityGoals, { hero: { otto: { since: Date.now() - 90e3, at: a.castleId } } })[0];
  eq(p.actions, undefined);
  has(p.note, /OTTO: due to leave F1 after 90s, but it is marching/);
});

// ---------------------------------------------------------------------------
(async () => {
  for (const [name, fn] of tests) {
    if (!fn) { console.log('\n' + name + '\n'); continue; }
    try { await fn(); console.log('  ok    ' + name); pass++; }
    catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(path.dirname(process.env.EVONY_DB), { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
