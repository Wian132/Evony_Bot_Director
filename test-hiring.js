'use strict';
// Step 12, automatic hiring and rewards, offline: config fasthero (wiki FastHero,
// Hero, FeastingHallSpace) and the gold rewards of config hero:1+ (wiki Hero,
// RewardHeroes). Hand-made rosters, inn offers and stub games only: nothing here
// connects to the game.
const path = require('path'), os = require('os'), fs = require('fs');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-hiring-')), 't.db');   // before db.js loads

const C = require('./constants');
const H = require('./goal-heroes');
const { Game } = require('./game');
const { Engine } = require('./engine');
const { parseGoals, NOT_IMPLEMENTED } = require('./goals');

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
// Shaped like the live roster: attributes include the points spent, *Added is 0,
// and base = top attribute - level + unspent points (Game.heroBase).
// Status (HeroConstants.as): 0 idle, 1 mayor, 2 guarding, 3 marching, 4 a
// prisoner we hold, 5 returning, 8 farming.
let nextId = 100;
const hero = (o) => Object.assign({
  id: nextId++, name: '?', level: 10, status: 0,
  power: 20, powerAdded: 0, management: 10, managementAdded: 0, stratagem: 10, stratagemAdded: 0,
  loyalty: 100, experience: 0, upgradeExp: 0, remainPoint: 0,
}, o);
const ATTR = { att: 'power', pol: 'management', int: 'stratagem' };
// a hero whose top attribute `role` has base `base` at level `level`
const good = (name, role, base, o = {}) => {
  const level = o.level ?? 10;
  return hero(Object.assign({ name, level, power: 5, management: 5, stratagem: 5, [ATTR[role]]: base + level }, o));
};
// idle, level 10, attack 30 (base 20): below any sensible bar, unprotected
const junk = (name, o = {}) => hero(Object.assign({ name, power: 30 }, o));

// An inn offer (a HeroBean from hero.getHerosListFromTavern). Level 1 unless
// said: a level-1 inn offers cheap heroes (wiki FastHero).
const offer = (name, role, base, o = {}) => {
  const level = o.level ?? 1;
  return Object.assign({
    name, level, power: 5, management: 5, stratagem: 5, loyalty: 70, itemId: '', itemAmount: 0,
    powerAdded: 0, managementAdded: 0, stratagemAdded: 0, [ATTR[role]]: base + level,
  }, o);
};

let nextCastle = 1;
function city(name, heros, { hall = 10, gold = 5e6, salary } = {}) {
  const id = nextCastle++;
  const resource = { food: { amount: 1e9 }, wood: { amount: 1e9 }, stone: { amount: 1e9 }, iron: { amount: 1e9 }, gold };
  if (salary !== undefined) resource.herosSalary = salary;
  return {
    castleId: id, id, name, fieldId: C.coordsToFieldId(100 + id * 5, 100),
    heros, troop: { scouter: 10 }, fortification: {}, resource,
    buildings: hall === null ? [] : [{ typeId: 27, level: hall, positionId: 3 }],
  };
}

// A game as the plans see it: castles, ids, and the inn readings Game keeps.
function planGame(castles) { return { castles, castleId: (c) => c.castleId, hallSeen: {}, innSeen: {} }; }
// The hall's size as Game.noteHall notes it (posCount + the roster then) ...
function readHall(game, castle, posCount, { at = Date.now() } = {}) {
  const fh = (castle.buildings || []).find((b) => b.typeId === 27);
  game.hallSeen[castle.castleId] = { at, posCount, heroes: castle.heros.length, capacity: posCount + castle.heros.length, fhLevel: fh ? fh.level : null };
}
// ... and the offers as Game.noteInn notes them.
function readOffers(game, castle, offers, { at = Date.now() } = {}) { game.innSeen[castle.castleId] = { at, offers: offers.slice() }; }
// both, as one inn read does
function readInn(game, castle, posCount, offers, opts) { readHall(game, castle, posCount, opts); readOffers(game, castle, offers, opts); }

function ctxFor(game, castle, src, others = {}) {
  const parsed = parseGoals(src);
  if (parsed.errors.length) throw new Error('goals did not parse: ' + JSON.stringify(parsed.errors));
  const goalsOf = (c) => (c === castle ? parsed.goals : (others[c.name] !== undefined ? parseGoals(others[c.name]).goals : null));
  return { game, castle, goals: parsed.goals, config: parsed.config, goalsOf, fortifications: {}, incoming: [] };
}
const kinds = (p) => ((p && p.actions) || []).map((a) => a.kind);
const hires = (p) => ((p && p.actions) || []).filter((a) => a.kind === 'hireHero').map((a) => a.heroName);
const fires = (p) => ((p && p.actions) || []).filter((a) => a.kind === 'fireHero').map((a) => a.heroName);
const rewards = (p) => ((p && p.actions) || []).filter((a) => a.kind === 'awardGold').map((a) => a.heroName);
const justRead = () => ({ hallReadAt: Date.now() });            // the inn was just asked
const plan = (game, castle, src, state = justRead(), others) => H.plans.fasthero(ctxFor(game, castle, src, others), state);

// A city with a good politics mayor and one junk hero, room for three more.
function roomy({ offers = [], src = 'config hero:10,fasthero:65', gold = 5e6, posCount = 3 } = {}) {
  const c = city('Roomy', [good('Polly', 'pol', 80, { status: 1 }), junk('Junk1')], { gold });
  const game = planGame([c]);
  readInn(game, c, posCount, offers);
  return { c, game, p: plan(game, c, src) };
}

// ======================================================================
section('1. the switches: config fasthero and config hero');
// ======================================================================
t('no config fasthero: no hiring plan at all', () => {
  const { c, game } = roomy({ offers: [offer('Atk70', 'att', 70)] });
  eq(plan(game, c, 'config hero:10'), null);
});

t('fasthero:0 (the default) is off; a value that is not a number is refused, not read as 0', () => {
  const { c, game } = roomy({ offers: [offer('Atk70', 'att', 70)] });
  const off = plan(game, c, 'config hero:10,fasthero:0');
  eq(off.actions, []);
  has(off.note, /config fasthero:0 — automatic hiring off/);
  const bad = plan(game, c, 'config hero:10,fasthero:lots');
  eq(bad.actions, []);
  has(bad.note, /config fasthero:lots is not a number — no hiring/);
});

t('it needs config hero:10 or higher (wiki Hero): hero:1, hero:0 and hero unset hire nothing and read no inn', () => {
  const { c, game } = roomy({ offers: [offer('Atk70', 'att', 70)] });
  for (const [src, re] of [['config hero:1,fasthero:65', /config hero:1 — level & reward only, never fire or hire/],
    ['config hero:0,fasthero:65', /config hero:0 — hero management off/],
    ['config fasthero:65', /config hero not set/]]) {
    const p = plan(game, c, src, {});
    eq(p.actions, [], src);
    has(p.note, /fasthero:65: hires only with config hero:10 or higher/, src);
    has(p.note, re, src);
  }
});

t('config hero:10 with fasthero:65 hires', () => {
  eq(hires(roomy({ offers: [offer('Atk70', 'att', 70)] }).p), ['Atk70']);
});

t('a roster that has not arrived: waiting, nothing hired', () => {
  const c = city('Empty', []);
  const game = planGame([c]);
  readInn(game, c, 3, [offer('Atk70', 'att', 70)]);
  const p = plan(game, c, 'config hero:10,fasthero:65');
  eq(p.actions, []);
  has(p.note, /waiting — no heroes in this city/);
});

// ======================================================================
section('2. the makeup: X good politics, Y good intel, the rest attack');
// ======================================================================
t('hero:10 with a good politics hero here: a politics offer is passed over, the attack offer is hired', () => {
  const { p } = roomy({ offers: [offer('Pol75', 'pol', 75), offer('Atk70', 'att', 70)] });
  eq(hires(p), ['Atk70']);
  has(p.note, /1 pol, 0 int, 0 att \(config hero:10 keeps 1 pol \+ 0 int, rest attack\)/);
});

t('...and with none good here, the politics offer comes first, even over a better attack offer', () => {
  const c = city('NoPol', [good('Weak', 'pol', 30, { status: 1 }), junk('Junk1')]);
  const game = planGame([c]);
  readInn(game, c, 3, [offer('Atk90', 'att', 90), offer('Pol66', 'pol', 66)]);
  eq(hires(plan(game, c, 'config hero:10,fasthero:65')), ['Pol66']);
});

t('only as many as the makeup names: with hero:10 an offer that is only a politics hero is not hired', () => {
  const { p } = roomy({ offers: [offer('Pol75', 'pol', 75)] });
  eq(p.actions, []);
  has(p.note, /none to hire: Pol75 \(politics, base 75, L1\): no more politics heroes wanted/);
});

t('hero:11 wants a good intel hero; hero:10 wants none', () => {
  const offers = [offer('Int70', 'int', 70), offer('Atk80', 'att', 80)];
  eq(hires(roomy({ offers, src: 'config hero:11,fasthero:65' }).p), ['Int70']);
  eq(hires(roomy({ offers, src: 'config hero:10,fasthero:65' }).p), ['Atk80']);
  const intOnly = roomy({ offers: [offer('Int70', 'int', 70)] }).p;
  eq(intOnly.actions, []);
  has(intOnly.note, /Int70 \(intel, base 70, L1\): no more intel heroes wanted/);
});

t('hero:21: politics until two good ones are here, then intel, then attack', () => {
  const offers = [offer('Atk99', 'att', 99), offer('Int70', 'int', 70), offer('Pol70', 'pol', 70)];
  eq(hires(roomy({ offers, src: 'config hero:21,fasthero:65' }).p), ['Pol70'], 'one good politics hero here, two wanted');
  const two = city('TwoPol', [good('P1', 'pol', 80, { status: 1 }), good('P2', 'pol', 70), junk('J')]);
  const game = planGame([two]);
  readInn(game, two, 3, offers);
  eq(hires(plan(game, two, 'config hero:21,fasthero:65')), ['Int70']);
});

t('a prisoner and a passing training hero do not count towards the makeup', () => {
  const c = city('Held', [good('Weak', 'pol', 30, { status: 1 }), good('Captive', 'pol', 90, { status: 4 }), good('Otto', 'pol', 90), junk('J')]);
  const other = city('Other', [junk('M', { status: 1 })]);
  const game = planGame([c, other]);
  readInn(game, c, 3, [offer('Pol66', 'pol', 66), offer('Atk80', 'att', 80)]);
  const p = plan(game, c, 'config hero:10,fasthero:65\ntraininghero Otto', justRead(), { Other: 'traininghero Otto' });
  eq(hires(p), ['Pol66']);
  has(p.note, /0 pol, 0 int, 0 att/);
});

// ======================================================================
section('3. the fasthero base');
// ======================================================================
t('offers below the base are passed over, and the note says so', () => {
  const { p } = roomy({ offers: [offer('Atk60', 'att', 60), offer('Atk64', 'att', 64)] });
  eq(p.actions, []);
  has(p.note, /inn read \d+s ago, 2 offer\(s\), none to hire: Atk60 \(attack, base 60, L1\) is below 65; Atk64 \(attack, base 64, L1\) is below 65/);
});

t('the highest base of the role wins; on a tie the cheaper (lower level) one', () => {
  eq(hires(roomy({ offers: [offer('A66', 'att', 66), offer('A72', 'att', 72), offer('A68', 'att', 68)] }).p), ['A72']);
  const tie = roomy({ offers: [offer('Dear', 'att', 70, { level: 5 }), offer('Cheap', 'att', 70, { level: 1 })] }).p;
  eq(hires(tie), ['Cheap']);
  eq(tie.actions[0].cost, 1000, 'level x 1000 gold (HireHero.as:743)');
});

t('an offer is judged by Game.heroBase, as the hero will be on the roster — not by attribute less *Added', () => {
  // power 80 at L10 with 20 points in attack: *Added says 60, heroBase says 70
  const spread = offer('Spread', 'att', 70, { level: 10, powerAdded: 20 });
  // power 80 at L20 with 5 points in attack: *Added says 75, heroBase says 60 —
  // hired, it would count 60 on the roster and be below the bar at once
  const trap = offer('Trap', 'att', 60, { level: 20, powerAdded: 5 });
  eq([H.fastScore(spread, H.fastHeroMode({ fasthero: 65 })), H.fastScore(trap, H.fastHeroMode({ fasthero: 65 }))], [70, 60]);
  eq(H.fastScore(trap, H.fastHeroMode({ fasthero: 65 })), Game.heroBase(hero({ level: 20, power: 80 })), 'the same number the roster gives it');
  eq(hires(roomy({ offers: [trap, spread] }).p), ['Spread']);
});

t('an offer that asks for an item (medals, jewellery) is never hired automatically', () => {
  const needy = offer('Needy', 'att', 90, { itemId: 'hero.loyalty.3', itemAmount: 2 });
  const p = roomy({ offers: [needy] }).p;
  eq(p.actions, []);
  has(p.note, /Needy \(attack, base 90, L1\) asks for 2 x hero.loyalty.3 — a hire spends no items/);
  eq(hires(roomy({ offers: [needy, offer('Plain', 'att', 66)] }).p), ['Plain']);
});

// ======================================================================
section('4. gold: over 1,000,000 in the city, plus the hire');
// ======================================================================
t('1,000,000 or less: no hire and no inn read (wiki FastHero: "over 1 million gold")', () => {
  for (const gold of [1e6, 500000]) {
    const c = city('Poor', [good('Polly', 'pol', 80, { status: 1 }), junk('J')], { gold });
    const game = planGame([c]);
    const p = plan(game, c, 'config hero:10,fasthero:65', {});
    eq(p.actions, [], String(gold));
    has(p.note, /gold here — it hires only with over 1,000,000 in the city/);
  }
});

t('the hire itself must leave over 1,000,000: 1,000,500 cannot pay a level-1 hire, 1,001,001 can', () => {
  const low = roomy({ gold: 1000500, offers: [offer('Atk70', 'att', 70)] }).p;
  eq(low.actions, []);
  has(low.note, /Atk70 \(attack, base 70, L1\) costs 1,000 gold, leaving 999,500/);
  eq(hires(roomy({ gold: 1001001, offers: [offer('Atk70', 'att', 70)] }).p), ['Atk70']);
  // a cheaper offer is taken when the better one is too dear
  eq(hires(roomy({ gold: 1004000, offers: [offer('Dear', 'att', 90, { level: 5 }), offer('Cheap', 'att', 66)] }).p), ['Cheap']);
});

t('the city\'s gold unknown: no hire', () => {
  const c = city('Blind', [good('Polly', 'pol', 80, { status: 1 }), junk('J')]);
  delete c.resource;
  const game = planGame([c]);
  readInn(game, c, 3, [offer('Atk70', 'att', 70)]);
  const p = plan(game, c, 'config hero:10,fasthero:65');
  eq(p.actions, []);
  has(p.note, /gold is not known yet/);
});

// ======================================================================
section('5. where hiring stops: feastinghallspace, plus 1 for a training hero on its way');
// ======================================================================
t('it hires while more slots are free than feastinghallspace', () => {
  const offers = [offer('Atk70', 'att', 70)];
  eq(hires(roomy({ offers, src: 'config hero:10,fasthero:65,feastinghallspace:2' }).p), ['Atk70'], '3 free, keep 2');
  const at = roomy({ offers, src: 'config hero:10,fasthero:65,feastinghallspace:3' }).p;
  eq(hires(at), [], '3 free, keep 3: full to its limit');
  const short = roomy({ offers, src: 'config hero:10,fasthero:65,feastinghallspace:4' }).p;
  eq(short.actions, []);
  has(short.note, /hall 2\/5, 3 free, keeping 4 \(feastinghallspace 4\) \| 1 slot\(s\) short of that — no hiring/);
});

// Otto rotates between Home and Away; he is in Away now, so Home holds a slot.
function trainingPair({ ottoHere = false, fhs = 2 } = {}) {
  const otto = good('Otto', 'att', 90);
  const home = city('Home', [good('Polly', 'pol', 80, { status: 1 }), junk('J'), ...(ottoHere ? [otto] : [])], { hall: ottoHere ? 6 : 5 });
  const away = city('Away', [junk('AM', { status: 1 }), ...(ottoHere ? [] : [otto])]);
  const game = planGame([home, away]);
  readInn(game, home, 3, [offer('Atk70', 'att', 70)]);
  const src = `config hero:10,fasthero:65,feastinghallspace:${fhs}\ntraininghero Otto 60`;
  return { home, game, ctx: ctxFor(game, home, src, { Away: 'traininghero Otto 60' }), src };
}

t('a training hero on its way: one more slot is held (wiki: "+ 1 more for TrainingHero")', () => {
  const { ctx } = trainingPair();
  const hall = H.feastingHall(ctx);
  eq([hall.free, hall.wantFree, hall.training.hero], [3, 3, 'Otto']);
  const p = H.plans.fasthero(ctx, justRead());
  eq(hires(p), [], '3 free, keep 2 + 1 for Otto');
  has(p.note, /keeping 3 \(feastinghallspace 2 \+ 1 for traininghero Otto \(now in Away\)\)/);
});

t('...none when he is here (he sits in his own slot: wiki City, "if not in that town"), or when no training hero comes', () => {
  const { ctx } = trainingPair({ ottoHere: true });
  eq(H.feastingHall(ctx).wantFree, 2);
  eq(hires(H.plans.fasthero(ctx, justRead())), ['Atk70']);
  eq(H.feastingHall(ctxFor(planGame([]), city('Solo', [junk('J')]), 'config feastinghallspace:2')).wantFree, 2, 'no training hero at all');
});

t('feastinghallspace:0 and no training hero: it fills the hall to the last slot', () => {
  const offers = [offer('Atk70', 'att', 70)];
  eq(hires(roomy({ offers, posCount: 1 }).p), ['Atk70']);
});

// ======================================================================
section('6. reading the inn: on the hall\'s clock, and only when a hire could follow');
// ======================================================================
t('no offers read yet: the inn is read first (the same readHall read, which notes the offers too)', () => {
  const c = city('Fresh', [good('Polly', 'pol', 80, { status: 1 }), junk('J')]);
  const game = planGame([c]);
  const p = plan(game, c, 'config hero:10,fasthero:65', {});
  eq(kinds(p), ['readHall']);
  has(p.actions[0].label, /read Fresh's inn: its offers and free hero slots \(fasthero\)/);
  has(p.note, /hall 2\/10, 8 free.* reading the inn for its offers$/, 'the size inferred from the Feasting Hall meanwhile');
  const bare = city('Bare', [good('Polly', 'pol', 80, { status: 1 }), junk('J')], { hall: null });
  const pb = plan(planGame([bare]), bare, 'config hero:10,fasthero:65', {});
  eq(kinds(pb), ['readHall']);
  has(pb.note, /reading the inn for its offers and the hall's size/);
});

t('at most one read every 10 minutes per city', () => {
  const c = city('Asked', [good('Polly', 'pol', 80, { status: 1 }), junk('J')]);
  const game = planGame([c]);
  const p = plan(game, c, 'config hero:10,fasthero:65', { hallReadAt: Date.now() - 60e3 });
  eq(p.actions, [], 'asked a minute ago and nothing came back');
  has(p.note, /hall size unknown, so no hiring — the inn is asked again in 9 min|the inn has not answered/);
  readInn(game, c, 3, [offer('Atk70', 'att', 70)], { at: Date.now() - 11 * 60e3 });
  eq(kinds(plan(game, c, 'config hero:10,fasthero:65', { hallReadAt: Date.now() - 11 * 60e3 })), ['readHall'], 'stale offers: read again');
  const wait = plan(game, c, 'config hero:10,fasthero:65', { hallReadAt: Date.now() - 4 * 60e3 });
  eq(wait.actions, [], 'stale offers, but the inn was asked 4 minutes ago');
  has(wait.note, /the offers are 11 min old — it is read again in 6 min/);
  readOffers(game, c, [offer('Atk70', 'att', 70)], { at: Date.now() - 2 * 60e3 });
  eq(hires(plan(game, c, 'config hero:10,fasthero:65', { hallReadAt: Date.now() - 2 * 60e3 })), ['Atk70'], 'fresh offers: hire from them');
});

t('no read when no hire could follow: low gold, hero:1, a short hall, or a full hall with nobody to swap', () => {
  const src = 'config hero:10,fasthero:65';
  const poor = city('Poor', [good('Polly', 'pol', 80, { status: 1 }), junk('J')], { gold: 900000 });
  eq(plan(planGame([poor]), poor, src, {}).actions, [], 'low gold');
  const one = city('One', [good('Polly', 'pol', 80, { status: 1 }), junk('J')]);
  eq(plan(planGame([one]), one, 'config hero:1,fasthero:65', {}).actions, [], 'hero:1');
  const short = city('Short', [good('Polly', 'pol', 80, { status: 1 }), junk('J')]);
  const gs = planGame([short]);
  readHall(gs, short, 1, { at: Date.now() - 20 * 60e3 });
  eq(plan(gs, short, 'config hero:10,fasthero:65,feastinghallspace:2', {}).actions, [], 'short hall');
  const full = city('Full', [good('Polly', 'pol', 80, { status: 1 }), good('Keeper', 'att', 40, { level: 60 }), good('Ok', 'att', 66)]);
  const gf = planGame([full]);
  readHall(gf, full, 0, { at: Date.now() - 20 * 60e3 });
  const p = plan(gf, full, src, {});
  eq(p.actions, [], 'full, and every idle hero is protected or already at the bar');
  has(p.note, /full to its limit, and no idle hero below 65 may go \(keep: any:level>=50\|any:base>=69 \(default\)\)/);
});

// ======================================================================
section('7. a full hall: one hero below the bar goes for a better offer (makeRoom)');
// ======================================================================
// Hall of four, full: the mayor, a protected L60 hero, two junk heroes.
function fullHall({ extra = [], src = 'config hero:10,fasthero:65', offers = [offer('Atk70', 'att', 70)], state } = {}) {
  const c = city('Packed', [good('Polly', 'pol', 80, { status: 1 }), good('Keeper', 'att', 40, { level: 60 }), junk('Junk1', { power: 30 }), junk('Junk2', { power: 25 }), ...extra]);
  const game = planGame([c]);
  readInn(game, c, 0, offers);
  return { c, game, p: plan(game, c, src, state || justRead()) };
}

t('at its limit, the worst-attack idle hero below the bar is fired for a qualifying offer', () => {
  const { p } = fullHall();
  eq(fires(p), ['Junk2']);
  eq(hires(p), [], 'the hire waits for the next pass, into the slot this makes');
  has(p.actions[0].label, /FIRE Junk2 .* fasthero: room for Atk70 \(attack, base 70, L1\); matches no keep rule .* irreversible/);
  has(p.note, /the hall is full \(4\/4/);
});

t('...and on the next pass, the fire done, the offer is hired into that slot', () => {
  const { c, game, p } = fullHall();
  const state = { hallReadAt: Date.now(), lastFireAt: Date.now() };
  c.heros = c.heros.filter((h) => h.name !== fires(p)[0]);          // the server's delete push
  eq(hires(H.plans.fasthero(ctxFor(game, c, 'config hero:10,fasthero:65'), state)), ['Atk70'], 'the fire cooldown does not hold a hire back');
});

t('never fired for it: a protected hero, the mayor, a prisoner, a training hero, a hero away, or one at the bar', () => {
  const c = city('Guarded', [
    good('Polly', 'pol', 30, { status: 1, power: 1 }),                     // the mayor, below the bar
    good('Keeper', 'att', 40, { level: 60 }),                               // keepheroes default: L50+
    good('Base70', 'att', 70),                                              // keepheroes default: base 69+
    junk('Captive', { status: 4, power: 2 }),                               // a prisoner
    junk('Otto', { power: 3 }),                                             // a training hero
    junk('Farmer', { status: 8, power: 4 }),                                // away farming
    good('AtBar', 'att', 66),                                               // idle, unprotected, at the bar
  ]);
  const other = city('Other', [junk('OM', { status: 1 })]);
  const game = planGame([c, other]);
  readInn(game, c, 0, [offer('Atk90', 'att', 90)]);
  const p = plan(game, c, 'config hero:10,fasthero:65\ntraininghero Otto', justRead(), { Other: 'traininghero Otto' });
  eq(p.actions, []);
  has(p.note, /full to its limit, and no idle hero below 65 may go/);
  // the same hall with one more junk hero: that one, and only that one, goes
  c.heros.push(junk('Spare', { power: 50 }));
  readInn(game, c, 0, [offer('Atk90', 'att', 90)]);
  eq(fires(plan(game, c, 'config hero:10,fasthero:65\ntraininghero Otto', justRead(), { Other: 'traininghero Otto' })), ['Spare']);
});

t('keepheroes decides who is protected: any:level>=100 leaves the L60 hero below the bar fireable', () => {
  const { p } = fullHall({ src: 'config hero:10,fasthero:65\nkeepheroes any:level>=100', extra: [] });
  eq(fires(p), ['Junk2'], 'still the worst attack first');
  const only = city('Only', [good('Polly', 'pol', 80, { status: 1 }), good('Keeper', 'att', 40, { level: 60 }), good('Ok', 'att', 66)]);
  const game = planGame([only]);
  readInn(game, only, 0, [offer('Atk70', 'att', 70)]);
  eq(fires(plan(game, only, 'config hero:10,fasthero:65\nkeepheroes any:level>=100')), ['Keeper']);
  eq(fires(plan(game, only, 'config hero:10,fasthero:65')), [], 'the default keeps L50+');
});

t('config hero sets its politics hero aside — until a better politics offer would replace it', () => {
  // the only politics hero is weak and idle; the mayor is an attack hero
  const mk = () => city('Swap', [good('Boss', 'att', 80, { status: 1 }), good('WeakPol', 'pol', 30), good('Keeper', 'att', 40, { level: 60 })]);
  const c1 = mk();
  const g1 = planGame([c1]);
  readInn(g1, c1, 0, [offer('Atk70', 'att', 70)]);
  const p1 = plan(g1, c1, 'config hero:10,fasthero:65');
  eq(p1.actions, [], 'an attack offer: WeakPol is the city\'s one politics hero, set aside by hero:10');
  has(p1.note, /every hero is protected or busy or already at 65 or more/);
  const c2 = mk();
  const g2 = planGame([c2]);
  readInn(g2, c2, 0, [offer('Pol70', 'pol', 70)]);
  eq(fires(plan(g2, c2, 'config hero:10,fasthero:65')), ['WeakPol'], 'a 70 politics offer takes its place in the reserve');
});

t('keepheroes /always does the firing itself, so fasthero only hires into a free slot', () => {
  const { p } = fullHall({ src: 'config hero:10,fasthero:65\nkeepheroes /always any:level>=50' });
  eq(p.actions, []);
  has(p.note, /keepheroes \/always does the firing here/);
});

t('the fire cooldown holds a swap back', () => {
  const { p } = fullHall({ state: { hallReadAt: Date.now(), lastFireAt: Date.now() - 10e3 } });
  eq(p.actions, []);
  has(p.note, /no room can be made: fired a hero 10s ago, waiting out the cooldown/);
});

t('with no offer at the bar nobody is fired', () => {
  const { p } = fullHall({ offers: [offer('Meh', 'att', 60)] });
  eq(p.actions, []);
  has(p.note, /none to hire: Meh \(attack, base 60, L1\) is below 65/);
});

// ======================================================================
section('8. fasthero 120+: attack + intel - level');
// ======================================================================
t('the wiki\'s example: 65 attack and 65 intel at level 10 is 120, kept at fasthero:120 and not at 121', () => {
  const dual = hero({ level: 10, power: 65, stratagem: 65, management: 5 });
  const mode = H.fastHeroMode({ fasthero: 120 });
  eq([mode.combined, H.fastScore(dual, mode)], [true, 120]);
  eq(H.fastHeroMode({ fasthero: 119 }).combined, false);
  const o = offer('Dual', 'att', 55, { level: 10, stratagem: 65 });           // power 65, intel 65, L10
  eq(hires(roomy({ offers: [o], src: 'config hero:10,fasthero:120' }).p), ['Dual']);
  const miss = roomy({ offers: [o], src: 'config hero:10,fasthero:121' }).p;
  eq(miss.actions, []);
  has(miss.note, /Dual \(attack, attack \+ intel - level 120, L10\) is below 121/);
});

t('unspent points count, as in Game.heroBase; an intel-led hero fills an attack slot; politics offers fall short', () => {
  eq(H.fastScore(hero({ level: 10, power: 60, stratagem: 60, remainPoint: 10 }), H.fastHeroMode({ fasthero: 120 })), 120);
  const intLed = offer('IntLed', 'int', 70, { level: 10, power: 60 });        // intel 80, attack 60, L10: 130
  eq(hires(roomy({ offers: [intLed], src: 'config hero:10,fasthero:120' }).p), ['IntLed'], 'hero:10 wants no intel hero, but 120+ judges attack + intel');
  const pol = roomy({ offers: [offer('Pol', 'pol', 150)], src: 'config hero:10,fasthero:120' }).p;
  eq(pol.actions, []);
  has(pol.note, /Pol \(politics, attack \+ intel - level 9, L1\) is below 120/);
});

t('at 120+ a strong one-stat hero is below the bar and may go; the mayor never does', () => {
  const mk = (bossStatus) => city('Duo', [
    good('Polly', 'pol', 80, { status: 1 }),
    hero({ name: 'Mono', level: 10, power: 100, stratagem: 10, status: bossStatus }),   // base 90, but 100 by attack + intel - level
    hero({ name: 'Dual', level: 10, power: 70, stratagem: 70 }),                        // 130
  ]);
  const c = mk(0);
  const game = planGame([c]);
  readInn(game, c, 0, [offer('Dual2', 'att', 60, { level: 10, stratagem: 65 })]);   // 70 + 65 - 10 = 125
  eq(fires(plan(game, c, 'config hero:10,fasthero:120\nkeepheroes any:level>=100')), ['Mono']);
  const m = mk(1);                                                                  // Mono is the mayor
  m.heros[0].status = 0;
  const gm = planGame([m]);
  readInn(gm, m, 0, [offer('Dual2', 'att', 60, { level: 10, stratagem: 65 })]);
  const p = plan(gm, m, 'config hero:10,fasthero:120\nkeepheroes any:level>=100');
  eq(p.actions, [], 'Polly is set aside by hero:10, Mono is mayor, Dual is at the bar');
  has(p.note, /every hero is protected or busy or already at 120 or more/);
});

// ======================================================================
section('9. one hire a pass, and each one seen on the roster before the next');
// ======================================================================
// A real Game whose only network call, req, is answered here; hires arrive
// as a HeroUpdate would put them.
function realGame(castles, reply) {
  const g = new Game();
  g.castles = castles;
  g.player = { playerInfo: { userName: 'T' }, items: [] };
  g.sent = [];
  g.req = async (cmd, data) => { g.sent.push({ cmd, data }); return typeof reply === 'function' ? reply(cmd, data) : reply; };
  return g;
}

t('many free slots and many good offers: still one hire a pass', () => {
  const { p } = roomy({ offers: [offer('A1', 'att', 70), offer('A2', 'att', 71), offer('A3', 'att', 72)] });
  eq(hires(p), ['A3']);
  eq(p.actions.length, 1);
});

t('the executor sends hero.hireHero {castleId, heroName}, takes the offer off the list and waits for it on the roster', async () => {
  const c = city('Hirer', [good('Polly', 'pol', 80, { status: 1 }), junk('J')]);
  const g = realGame([c], { ok: 1 });
  g.innSeen = { [c.castleId]: { at: Date.now(), offers: [offer('A1', 'att', 70), offer('A2', 'att', 71)] } };
  g.hallSeen = {};
  readHall(g, c, 3);
  const state = { hallReadAt: Date.now() };
  const p = H.plans.fasthero(ctxFor(g, c, 'config hero:10,fasthero:65'), state);
  eq(hires(p), ['A2']);
  const r = await H.executors.hireHero(g, c, p.actions[0], state);
  eq(r.ok, 1);
  eq(g.sent.map((s) => [s.cmd, s.data]), [['hero.hireHero', { castleId: c.castleId, heroName: 'A2' }]]);
  eq(g.innSeen[c.castleId].offers.map((o) => o.name), ['A1'], 'as the client drops it from its list');
  eq(state.lastHire.name, 'A2');

  // no HeroUpdate yet: the hall's count is a slot out, so nothing more is hired
  const wait = H.plans.fasthero(ctxFor(g, c, 'config hero:10,fasthero:65'), state);
  eq(wait.actions, []);
  has(wait.note, /hired A2 \d+s ago — waiting for it on the roster before another hire/);

  // the push (Game.applyHeroUpdate, updateType 0 add) brings it in
  g.applyHeroUpdate({ castleId: c.castleId, updateType: 0, hero: hero({ name: 'A2', level: 1, power: 71 }) });
  const next = H.plans.fasthero(ctxFor(g, c, 'config hero:10,fasthero:65'), state);
  has(next.note, /A2, hired \d+s ago, is on the roster/);
  eq(hires(next), ['A1'], 'the next from the same read');
  eq(state.lastHire, undefined);
});

t('a hire that never shows on the roster is let go after 10 minutes, and the inn is read afresh first', () => {
  const c = city('Lost', [good('Polly', 'pol', 80, { status: 1 }), junk('J')]);
  const game = planGame([c]);
  readInn(game, c, 3, [offer('A1', 'att', 70)], { at: Date.now() - 12 * 60e3 + 1000 });
  const state = { hallReadAt: Date.now() - 12 * 60e3, lastHire: { at: Date.now() - 11 * 60e3, name: 'Ghost', idsBefore: c.heros.map((h) => h.id) } };
  readOffers(game, c, [offer('A1', 'att', 70)], { at: Date.now() - 60e3 });   // a read from before the let-go
  const p = H.plans.fasthero(ctxFor(game, c, 'config hero:10,fasthero:65'), state);
  has(p.note, /Ghost, hired 11 min ago, never showed on the roster — the inn is read afresh before another hire/);
  eq(kinds(p), ['readHall']);
  eq(state.lastHire, undefined);
});

t('a refused hire drops the offers read, so it is not tried again before the next read', async () => {
  const c = city('Refused', [good('Polly', 'pol', 80, { status: 1 }), junk('J')]);
  const g = realGame([c], { ok: -1, errorMsg: 'The feasting hall is full' });
  g.innSeen = { [c.castleId]: { at: Date.now(), offers: [offer('A1', 'att', 70)] } };
  const state = {};
  const r = await H.executors.hireHero(g, c, { kind: 'hireHero', heroName: 'A1', cost: 1000 }, state);
  eq(r.ok, -1);
  eq(g.innSeen[c.castleId], undefined);
  eq(state.lastHire, undefined);
});

t('the executor checks the gold floor again and sends nothing below it', async () => {
  const c = city('Spent', [junk('J')], { gold: 1000500 });
  const g = realGame([c], { ok: 1 });
  let err = null;
  try { await H.executors.hireHero(g, c, { kind: 'hireHero', heroName: 'A1', cost: 1000 }, {}); } catch (e) { err = e.message; }
  has(err, /the city has 1,000,500 gold now — not hiring A1 below the 1,000,000 floor/);
  eq(g.sent, []);
});

t('Game.tavernList and refreshTavern note the offers (Game.noteInn); a refusal notes nothing', async () => {
  const c = city('Inn', [junk('J')]);
  const g = realGame([c], { ok: 1, posCount: 4, heros: [offer('A1', 'att', 70)] });
  await g.tavernList(c.castleId);
  eq(g.innSeen[c.castleId].offers.map((o) => o.name), ['A1']);
  eq(g.hallSeen[c.castleId].capacity, 5, 'and the hall, as before');
  const g2 = realGame([c], { ok: 1, heros: [offer('B1', 'att', 70)] });
  await g2.refreshTavern(c.castleId);
  eq(g2.innSeen[c.castleId].offers.map((o) => o.name), ['B1']);
  const g3 = realGame([c], { ok: -1, errorMsg: 'no' });
  await g3.tavernList(c.castleId);
  eq(g3.innSeen, undefined);
});

t('the readHall executor reads once when two plans ask in one slice', async () => {
  const c = city('Twice', [junk('J')]);
  const g = realGame([c], { ok: 1, posCount: 2, heros: [] });
  const state = {};
  await H.executors.readHall(g, c, { kind: 'readHall' }, state);
  const again = await H.executors.readHall(g, c, { kind: 'readHall' }, state);
  eq([again.ok, again.again], [1, true]);
  eq(g.sent.length, 1);
});

t('the client\'s costs: hire level x 1000, reward level x 100, salary level x 20 an hour', () => {
  eq([Game.hireCost({ level: 7 }), Game.awardCost({ level: 7 }), Game.heroSalary({ level: 7 })], [7000, 700, 140]);
});

// ======================================================================
section('10. the inn is never refreshed');
// ======================================================================
t('no executor refreshes the inn, and no plan asks for anything but a read, a hire or a fire', () => {
  ok(!Object.keys(H.executors).some((k) => /refresh/i.test(k)), Object.keys(H.executors).join(','));
  const seen = new Set();
  const scenarios = [
    roomy({ offers: [offer('Meh', 'att', 60)] }).p, roomy({ offers: [offer('Atk70', 'att', 70)] }).p,
    fullHall().p, fullHall({ offers: [offer('Meh', 'att', 60)] }).p, plan(planGame([]), city('New', [junk('J')]), 'config hero:10,fasthero:65', {}),
  ];
  for (const p of scenarios) for (const k of kinds(p)) seen.add(k);
  eq([...seen].sort(), ['fireHero', 'hireHero', 'readHall']);
});

// A stub game the engine can run whole focus slices against.
function engineGame(castles, { offers = [], posCount = 3 } = {}) {
  const calls = [];
  const g = {
    castles, calls, hallSeen: {}, innSeen: {},
    player: { playerInfo: { userName: 'T' }, selfArmys: [], enemyArmys: [], items: [] },
    castle: () => castles[0],
    castleId: (c) => c.castleId,
    castleXY: (c) => C.fieldIdToCoords(c.fieldId),
    now: () => Date.now(),
    req: async (cmd) => { calls.push([cmd]); return { ok: 1 }; },
    promoteToChief: async (cid, hid) => { calls.push(['promoteToChief', cid, hid]); return { ok: 1 }; },
    dischargeChief: async (cid) => { calls.push(['dischargeChief', cid]); return { ok: 1 }; },
    fireHero: async (cid, hid) => { calls.push(['fireHero', cid, hid]); return { ok: 1 }; },
    levelUpHero: async (cid, hid) => { calls.push(['levelUp', cid, hid]); return { ok: 1 }; },
    addPoint: async (cid, h, inc) => { calls.push(['addPoint', cid, h.id, inc]); return { ok: 1 }; },
    tavernList: async (cid) => {
      calls.push(['tavernList', cid]);
      const r = { ok: 1, posCount: g.posCount, heros: g.offers.slice() };
      Game.prototype.noteInn.call(g, cid, r);
      return Game.prototype.noteHall.call(g, cid, r);
    },
    refreshTavern: async (cid) => { calls.push(['refreshTavern', cid]); return { ok: 1 }; },
    hireHero: async (cid, name) => {
      calls.push(['hireHero', cid, name]);
      const c = castles.find((x) => x.castleId === cid);
      const o = g.offers.find((x) => x.name === name);
      g.offers = g.offers.filter((x) => x.name !== name);
      g.posCount--;
      if (g.pushHires) c.heros.push(hero(Object.assign({}, o, { id: nextId++, status: 0 })));   // the HeroUpdate add
      return { ok: 1 };
    },
    awardGold: async (cid, hid) => {
      calls.push(['awardGold', cid, hid]);
      const c = castles.find((x) => x.castleId === cid);
      const h = c.heros.find((x) => x.id === hid);
      if (g.pushRewards && h) h.loyalty = Math.min(100, h.loyalty + 10);                     // the HeroUpdate
      return { ok: 1 };
    },
    buildArmyBean: (o) => Game.prototype.buildArmyBean.call(g, o),
    newArmy: async (cid, bean) => { calls.push(['newArmy', cid, bean]); return { ok: 1 }; },
  };
  g.offers = offers.slice();
  g.posCount = posCount;
  g.pushHires = true;
  g.pushRewards = true;
  return g;
}
function engineFor(castles, srcFor, opts) {
  const game = engineGame(castles, opts);
  const lines = [];
  const e = new Engine(game, (m) => lines.push(m));
  e.dryRun = false;
  e.state = {};
  e.goalsFor = (id, name) => (srcFor[name] !== undefined ? parseGoals(srcFor[name]) : null);
  return { e, game, lines };
}
const sent = (game, cmd) => game.calls.filter((c) => c[0] === cmd);

t('through the engine, slice by slice: read the inn, hire, see it arrive, hire again — and never a refresh', async () => {
  const c = city('Engine', [good('Polly', 'pol', 80, { status: 1 }), junk('J')], { hall: 10 });
  const { e, game } = engineFor([c], { Engine: 'config hero:10,fasthero:65' }, { offers: [offer('A1', 'att', 70), offer('A2', 'att', 75), offer('Meh', 'att', 50)], posCount: 2 });
  const r1 = await e.focus(c);
  eq(sent(game, 'tavernList').length, 1, 'first slice: the inn is read');
  ok(r1.acted.some((x) => /read Engine's inn: its offers and free hero slots \(fasthero\) -> ok/.test(x)), r1.acted.join(' | '));
  const r2 = await e.focus(c);
  eq(sent(game, 'hireHero').map((x) => x[2]), ['A2'], 'second slice: the best offer');
  ok(r2.acted.some((x) => /hire A2 \(attack, base 75, L1\) from the inn for 1,000 gold .* -> ok/.test(x)), r2.acted.join(' | '));
  const r3 = await e.focus(c);
  has(r3.fasthero.note, /A2, hired \d+s ago, is on the roster/);
  eq(sent(game, 'hireHero').map((x) => x[2]), ['A2', 'A1'], 'third slice: the next good one');
  const r4 = await e.focus(c);
  eq(sent(game, 'hireHero').length, 2, 'the hall now holds its last free slot... and Meh is below the bar anyway');
  has(r4.fasthero.note, /A1, hired \d+s ago, is on the roster/);
  for (let i = 0; i < 3; i++) await e.focus(c);
  eq(sent(game, 'refreshTavern'), [], 'never refreshed');
  eq(sent(game, 'tavernList').length, 1, 'and read once: the offers are good for ten minutes');
});

// ======================================================================
section('11. rewards: config hero:1 and up, loyalty below 100, with gold');
// ======================================================================
const rctx = (heros, src = 'config hero:1', opts = {}) => {
  const c = city('Loyal', heros, opts);
  return ctxFor(planGame([c]), c, src);
};

t('the lowest loyalty first, one a pass, level x 100 gold (AwardHero.as:693)', () => {
  const a = hero({ name: 'A', loyalty: 60, level: 10 });
  const b = hero({ name: 'B', loyalty: 40, level: 20 });
  const p = H.plans.rewards(rctx([a, b, hero({ name: 'C', loyalty: 100 })]), {});
  eq(rewards(p), ['B']);
  eq([p.actions[0].cost, p.actions[0].heroId], [2000, b.id]);
  has(p.note, /rewards: 2 hero\(es\) below 100 loyalty \(B 40, A 60\) — rewarding B for 2,000 gold/);
  has(p.actions[0].label, /reward B \(L20, loyalty 40\) with 2,000 gold/);
});

t('equal loyalty: the higher level first', () => {
  const p = H.plans.rewards(rctx([hero({ name: 'Low', loyalty: 50, level: 5 }), hero({ name: 'High', loyalty: 50, level: 50 })]), {});
  eq(rewards(p), ['High']);
});

t('never a prisoner, never a hero whose loyalty is not known; nobody below 100 means no plan', () => {
  const pris = hero({ name: 'Pris', loyalty: 5, status: 4 });
  const blank = hero({ name: 'Blank' });
  delete blank.loyalty;
  eq(H.plans.rewards(rctx([pris, blank, hero({ name: 'Full', loyalty: 100 })]), {}), null);
  eq(rewards(H.plans.rewards(rctx([pris, hero({ name: 'Own', loyalty: 90 })]), {})), ['Own']);
});

t('config hero:0 or unset rewards nobody; hero:10 and up reward too', () => {
  const low = () => [hero({ name: 'Low', loyalty: 50 })];
  eq(H.plans.rewards(rctx(low(), 'config hero:0'), {}), null);
  eq(H.plans.rewards(rctx(low(), 'config comfort:1'), {}), null);
  eq(rewards(H.plans.rewards(rctx(low(), 'config hero:10'), {})), ['Low']);
  eq(rewards(H.plans.rewards(rctx(low(), 'config hero:22'), {})), ['Low']);
});

t('a day of hero salaries stays in the city: the server\'s herosSalary x 24', () => {
  const a = hero({ name: 'A', loyalty: 60, level: 10 });           // 1,000
  const b = hero({ name: 'B', loyalty: 40, level: 20 });           // 2,000
  // 100 an hour -> 2,400 kept; 3,900 covers A (2,900 left) but not B (1,900)
  const p = H.plans.rewards(rctx([a, b], 'config hero:1', { gold: 3900, salary: 100 }), {});
  eq(rewards(p), ['A']);
  has(p.note, /too little gold for B \(2,000\): 3,900 here, 2,400 kept for a day of hero salaries/);
  eq(rewards(H.plans.rewards(rctx([a, b], 'config hero:1', { gold: 3399, salary: 100 }), {})), [], 'not even A');
});

t('with no herosSalary from the server, level x 20 a hero (prisoners not paid for)', () => {
  const heros = [hero({ name: 'A', loyalty: 60, level: 10 }), hero({ name: 'B', level: 40 }), hero({ name: 'P', status: 4, level: 90 })];
  eq(H.salaryReserve(city('S', heros)).reserve, (10 + 40) * 20 * 24);
  eq(H.salaryReserve(city('S', heros, { salary: 500 })).perHour, 500);
  // 24,000 kept: 25,000 covers A's 1,000 exactly
  eq(rewards(H.plans.rewards(rctx(heros, 'config hero:1', { gold: 25000 }), {})), ['A']);
  eq(rewards(H.plans.rewards(rctx(heros, 'config hero:1', { gold: 24999 }), {})), []);
});

t('the executor sends hero.awardGold {castleId, heroId} and records the result', async () => {
  const a = hero({ name: 'A', loyalty: 60, level: 10 });
  const c = city('Pay', [a]);
  const g = realGame([c], { ok: 1 });
  const state = {};
  const p = H.plans.rewards(ctxFor(planGame([c]), c, 'config hero:1'), state);
  const r = await H.executors.awardGold(g, c, p.actions[0], state);
  eq(r.ok, 1);
  eq(g.sent.map((s) => [s.cmd, s.data]), [['hero.awardGold', { castleId: c.castleId, heroId: a.id }]]);
  eq([state.rewards[a.id].ok, state.rewards[a.id].loyalty], [true, 60]);
});

t('the executor checks again: gone, a prisoner, back at 100, or the gold no longer there — nothing sent', async () => {
  const c = city('Recheck', [hero({ name: 'A', loyalty: 60, level: 10 })], { gold: 1e6 });
  const g = realGame([c], { ok: 1 });
  const a = c.heros[0];
  const act = { kind: 'awardGold', heroId: a.id, heroName: 'A', reserve: 0 };
  const err = async (fn) => { try { await fn(); } catch (e) { return e.message; } return null; };
  a.loyalty = 100;
  has(await err(() => H.executors.awardGold(g, c, act, {})), /at loyalty 100 now/);
  a.loyalty = 60; a.status = 4;
  has(await err(() => H.executors.awardGold(g, c, act, {})), /is a prisoner/);
  a.status = 0;
  has(await err(() => H.executors.awardGold(g, c, { ...act, reserve: 999500 }, {})), /would dip into the 999,500 kept for salaries/);
  has(await err(() => H.executors.awardGold(g, c, { ...act, heroId: -1 }, {})), /no longer in this city/);
  eq(g.sent, []);
});

t('a refused reward is held for an hour; one whose loyalty has not moved is waited on, then held', () => {
  const a = hero({ name: 'A', loyalty: 60, level: 10 });
  const refused = { rewards: { [a.id]: { at: Date.now() - 60e3, loyalty: 60, ok: false, msg: 'Not enough gold' } } };
  const p1 = H.plans.rewards(rctx([a]), refused);
  eq(p1.actions, []);
  has(p1.note, /held: A: refused 60s ago \(Not enough gold\)/);
  const old = { rewards: { [a.id]: { at: Date.now() - 61 * 60e3, loyalty: 60, ok: false, msg: 'no' } } };
  eq(rewards(H.plans.rewards(rctx([a]), old)), ['A'], 'an hour on it is asked again');
  eq(old.rewards, undefined, 'and the old record is gone');

  const waiting = { rewards: { [a.id]: { at: Date.now() - 30e3, loyalty: 60, ok: true } } };
  has(H.plans.rewards(rctx([a]), waiting).note, /A: rewarded 30s ago, waiting for its loyalty to show/);
  const stuck = { rewards: { [a.id]: { at: Date.now() - 20 * 60e3, loyalty: 60, ok: true } } };
  has(H.plans.rewards(rctx([a]), stuck).note, /A: rewarded 20 min ago and its loyalty never rose — held for an hour/);
  const rose = { rewards: { [a.id]: { at: Date.now() - 30e3, loyalty: 50, ok: true } } };
  eq(rewards(H.plans.rewards(rctx([a]), rose)), ['A'], 'loyalty rose from 50 to 60: rewarded again');
});

t('another hero is rewarded while one is waited on; records of heroes gone are dropped', () => {
  const a = hero({ name: 'A', loyalty: 40 }), b = hero({ name: 'B', loyalty: 70 });
  const state = { rewards: { [a.id]: { at: Date.now() - 30e3, loyalty: 40, ok: true }, 999999: { at: Date.now(), loyalty: 1, ok: true } } };
  eq(rewards(H.plans.rewards(rctx([a, b]), state)), ['B']);
  eq(Object.keys(state.rewards), [String(a.id)]);
});

t('through the engine: one reward a slice until the city\'s heroes are back at 100', async () => {
  const c = city('Payday', [good('Polly', 'pol', 80, { status: 1, loyalty: 85 }), hero({ name: 'Low', loyalty: 75 })]);
  const { e, game } = engineFor([c], { Payday: 'config hero:1' });
  for (let i = 0; i < 6; i++) await e.focus(c);
  // Low 75 -> 85; then both at 85, same level, roster order: Polly; and so on
  const [polly, low] = c.heros.map((h) => h.id);
  eq(sent(game, 'awardGold').map((x) => x[2]), [low, polly, low, polly, low]);
  eq(c.heros.map((h) => h.loyalty), [100, 100]);
  eq(sent(game, 'tavernList'), [], 'config hero:1 never reads the inn');
});

// ======================================================================
section('12. the live goals (config hero:1): rewards only, no hiring');
// ======================================================================
const LIVE_A1 = `// Lord22 build-up
config comfort:1,hero:1,troopsusepopmax:1
comfortpolicy 15 16 popraise
defensepolicy /usetruce:79 /usespeech:2 /junktroop:5000 /usewarhorn:1 /usecorselet:1 /usepenicillin:1
build f:10:37,s:0:0,i:0:0,q:0:0
troop b:5k,t:5k
troop wo:10k,w:10k,s:10k,p:10k,sw:10k,a:10k,t:10k,c:10k,cata:10k,b:10k
troop a:100k,s:100k
fortification ab:5000`;
const LIVE_A2 = `config comfort:1,hero:1,troopsusepopmax:1,npc:5
comfortpolicy 15 16 popraise
build fh:1
build f:10:37
troop b:5k,t:5k
distancepolicy 15
npcteams 3
requestresources any gold 1000000 2000000 500000 200000
traininghero OTTO 30 60
npcheroes !OTTO,any
farmingpolicy 5 /distance:10`;

t('both still parse', () => { eq(parseGoals(LIVE_A1).errors, []); eq(parseGoals(LIVE_A2).errors, []); });

t('no hiring: no fasthero plan, no inn read', () => {
  for (const src of [LIVE_A1, LIVE_A2]) {
    const c = city('Live', [good('Pol', 'pol', 80, { status: 1 }), junk('J')]);
    eq(H.plans.fasthero(ctxFor(planGame([c]), c, src), {}), null);
  }
});

t('rewards: a hero below 100 loyalty is rewarded, keeping a day of salaries; at 100 nothing is said', () => {
  const c = city('F1', [good('Pol', 'pol', 80, { status: 1 }), hero({ name: 'Farm', level: 30, power: 60, loyalty: 70 })], { salary: 800 });
  const p = H.plans.rewards(ctxFor(planGame([c]), c, LIVE_A2), {});
  eq(rewards(p), ['Farm']);
  eq(p.actions[0].cost, 3000);
  eq(p.actions[0].reserve, 800 * 24);
  const full = city('F2', [good('Pol', 'pol', 80, { status: 1 })]);
  eq(H.plans.rewards(ctxFor(planGame([full]), full, LIVE_A1), {}), null);
});

t('a2: a city OTTO is on his way to holds his slot (feastinghallspace unset + 1)', () => {
  const otto = good('OTTO', 'att', 90);
  const f1 = city('F1', [otto, junk('M1', { status: 1 })]);
  const f2 = city('F2', [junk('M2', { status: 1 })]);
  const hall = H.feastingHall(ctxFor(planGame([f1, f2]), f2, LIVE_A2, { F1: LIVE_A2 }));
  eq([hall.wantFree, hall.training.hero], [1, 'OTTO']);
  eq(H.feastingHall(ctxFor(planGame([f1, f2]), f1, LIVE_A2, { F2: LIVE_A2 })).wantFree, 0, 'not in the city he is in');
});

t('the editor: config fasthero is off the idle table and its lines are blue; the live config lines are as before', () => {
  ok(!('fasthero' in NOT_IMPLEMENTED.config), 'fasthero still on the table');
  const l = (src) => parseGoals(src).lines[0];
  for (const src of ['config fasthero:65', 'config hero:10,fasthero:65,feastinghallspace:1', 'config fasthero:120']) {
    eq(l(src), { n: 1, status: 'ok', msg: null }, src);
  }
  // troopsusepopmax is still on the table (another step's business): unchanged
  eq(l('config comfort:1,hero:1,troopsusepopmax:1').status, NOT_IMPLEMENTED.config.troopsusepopmax ? 'idle' : 'ok');
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
