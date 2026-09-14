'use strict';
// Offline tests for goal-heroes.js.  node test-heroes.js
// Hand-made rosters only: nothing here connects to the game.
const H = require('./goal-heroes');

let pass = 0, fail = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; fails.push(`${name}\n      ${e.message}`); }
}
function eq(got, want, what = '') {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${what ? what + ': ' : ''}got ${g}, want ${w}`);
}
function ok(cond, what) { if (!cond) throw new Error(what || 'expected true'); }
const num = (x) => Number(x || 0);

// ---------------------------------------------------------------- fixtures
// power = attack, management = politics, stratagem = intel.
// Shaped like the live roster: the attribute already includes the points
// spent on it, and the *Added fields are 0 on every hired hero (game.js:
// Griselda, L26, power 87, powerAdded 0). base = top attribute - level +
// unspent points (Game.heroBase).
const hero = (o) => Object.assign({
  id: 0, name: '?', level: 1, status: 0,
  power: 0, powerAdded: 0, management: 0, managementAdded: 0, stratagem: 0, stratagemAdded: 0,
  loyalty: 100, experience: 0, upgradeExp: 0, remainPoint: 0,
}, o);

const ATLAS = hero({ id: 1, name: 'Atlas', level: 120, power: 200, management: 40, stratagem: 30 });                        // base 80
const POLLY = hero({ id: 2, name: 'Polly', level: 60, status: H.STATUS.MAYOR, management: 130, power: 35, stratagem: 30 });  // base 70
const SMARTY = hero({ id: 3, name: 'Smarty', level: 80, stratagem: 150, power: 40, management: 35 });                       // base 70
const JUNK1 = hero({ id: 4, name: 'Junk1', level: 5, power: 25, management: 12, stratagem: 14 });                          // base 20
const JUNK2 = hero({ id: 5, name: 'Junk2', level: 3, power: 15, management: 10, stratagem: 11 });
const RIDER = hero({ id: 6, name: 'Rider', level: 4, status: H.STATUS.MARCHING, power: 18, management: 9, stratagem: 8 });

const castle = (heroes, opts = {}) => ({
  castleId: 77, name: 'Testville',
  heros: heroes,
  buildings: opts.hallLevel === null ? [] : [{ typeId: 27, level: opts.hallLevel || 6, positionId: 3 }],
});

// Build a goal object the way goals.js does: { name, ...parse(args) }.
function goal(name, ...args) {
  const def = H.parsers[name];
  if (!def) throw new Error('no parser for ' + name);
  const parsed = def.parse(args.flatMap((a) => String(a).split(/\s+/)));
  const errors = parsed.errors || [];
  delete parsed.errors;
  return Object.assign({ name, kind: def.kind, raw: `${name} ${args.join(' ')}`, parseErrors: errors }, parsed);
}

const ctx = (heroes, { goals = [], config = {}, hallLevel } = {}) => ({
  game: null, castle: castle(heroes, { hallLevel }), goals, config, fortifications: {}, incoming: [],
});

// ======================================================================
console.log('hero strings');
// ======================================================================
const ALL = [ATLAS, POLLY, SMARTY, JUNK1, JUNK2, RIDER];
const names = (list) => list.map((h) => h.name);

t('any matches every hero', () => eq(names(H.matchHeroes(ALL, 'any')), names(ALL)));
t('none matches nobody', () => eq(names(H.matchHeroes(ALL, 'none')), []));
t('a bare name matches case-insensitively', () => eq(names(H.matchHeroes(ALL, 'atlas')), ['Atlas']));
t('a comma list matches each name', () => eq(names(H.matchHeroes(ALL, 'Junk1,Junk2')), ['Junk1', 'Junk2']));
t('level filter', () => eq(names(H.matchHeroes(ALL, 'any:level>=80')), ['Atlas', 'Smarty']));
t('base is the top attribute less the level, plus unspent points (Game.heroBase)', () => {
  eq(H.heroBase(ATLAS), 80, 'Atlas base');           // 200-120
  eq(H.heroBase(POLLY), 70, 'Polly base');           // 130-60
  eq(H.heroBase(JUNK1), 20, 'Junk1 base');           // 25-5
  eq(H.heroBase(hero({ level: 10, power: 70, remainPoint: 4 })), 64, 'unspent points are still base');
  eq(names(H.matchHeroes(ALL, 'any:base>=70')), ['Atlas', 'Polly', 'Smarty']);
});
t('alternatives are OR-ed with |', () =>
  eq(names(H.matchHeroes(ALL, 'any:level>=100|any:base>=70')), ['Atlas', 'Polly', 'Smarty']));
t('filters inside one alternative are AND-ed', () =>
  eq(names(H.matchHeroes(ALL, 'any:level>=50,base>=80')), ['Atlas']));
t('!name vetoes', () => eq(names(H.matchHeroes(ALL, '!Atlas,any:level>=80')), ['Smarty']));
t('a lone !name reads as "any except"', () =>
  eq(names(H.matchHeroes(ALL, '!Atlas')), ['Polly', 'Smarty', 'Junk1', 'Junk2', 'Rider']));
t('names and a filtered any combine with |', () =>
  eq(names(H.matchHeroes(ALL, 'Junk1,Junk2|any:level>=100')), ['Atlas', 'Junk1', 'Junk2']));
t('name plus filter on one alternative is AND', () =>
  eq(names(H.matchHeroes(ALL, 'Junk1:level>=100')), []));
t('wildcards', () => {
  eq(names(H.matchHeroes(ALL, 'Junk*')), ['Junk1', 'Junk2']);
  eq(names(H.matchHeroes(ALL, 'Junk?')), ['Junk1', 'Junk2']);
  eq(names(H.matchHeroes(ALL, '*:base>=80')), ['Atlas']);
});
t('best and worst are relative to the roster', () => {
  eq(names(H.matchHeroes(ALL, 'any:attack=best')), ['Atlas']);
  eq(names(H.matchHeroes(ALL, 'any:politics=best')), ['Polly']);
  eq(names(H.matchHeroes(ALL, 'any:attack=worst')), ['Junk2']);
  eq(names(H.matchHeroes(ALL, 'any:level<best')), ['Polly', 'Smarty', 'Junk1', 'Junk2', 'Rider']);
});
t('a stat can be compared to another stat', () => {
  eq(names(H.matchHeroes(ALL, 'any:attack>politics')), ['Atlas', 'Smarty', 'Junk1', 'Junk2', 'Rider']);
  eq(names(H.matchHeroes(ALL, 'any:intel>attack')), ['Smarty']);
});
t('every comparison operator parses', () => {
  for (const op of ['>', '<', '>=', '<=', '=', '!=', '<>']) {
    const p = H.parseHeroString(`any:level${op}50`);
    eq(p.errors, [], `operator ${op}`);
  }
});
t('abbreviations att/pol/int/lvl/bse/pts/loy/exp all parse', () => {
  for (const f of ['att', 'pol', 'int', 'lvl', 'bse', 'pts', 'loy', 'exp']) {
    eq(H.parseHeroString(`any:${f}>=1`).errors, [], f);
  }
});
t('points filter reads remainPoint', () => {
  const withPts = hero({ id: 9, name: 'Pointy', remainPoint: 12 });
  eq(names(H.matchHeroes([...ALL, withPts], 'any:points>=10')), ['Pointy']);
});
t('a hero string that is only a number is refused', () => {
  const p = H.parseHeroString('100');
  ok(p.errors.length, 'expected an error');
  ok(/just a number/.test(p.errors[0]), p.errors[0]);
  eq(H.matchHeroes(ALL, '100'), []);          // and it must select nobody
});
t('unknown field and missing comparison are reported', () => {
  ok(H.parseHeroString('any:sneakiness>5').errors.length);
  ok(H.parseHeroString('any:level').errors.length);
});
t('a broken rule matches nobody rather than everybody', () =>
  eq(H.matchHeroes(ALL, 'any:sneakiness>5'), []));

// ======================================================================
console.log('keepheroes / keepcapturedheroes / herofirelimit');
// ======================================================================
const ROSTER = [ATLAS, POLLY, SMARTY, JUNK1, JUNK2, RIDER];   // 6 heroes, hall L6 -> full

t('no hero goals at all -> no plan', () => eq(H.plans.keepheroes(ctx(ROSTER), {}), null));

t('config hero unset means never fire', () => {
  const c = ctx(ROSTER, { goals: [goal('keepheroes', 'any:level>=50')], config: { feastinghallspace: 1 } });
  const p = H.plans.keepheroes(c, {});
  eq(p.actions, []);
  ok(/config hero/.test(p.note), p.note);
});

t('config hero:1 is level-and-reward only, never fire', () => {
  const c = ctx(ROSTER, { goals: [goal('keepheroes', 'any:level>=50')], config: { hero: 1, feastinghallspace: 1 } });
  eq(H.plans.keepheroes(c, {}).actions, []);
});

// Changed on purpose (step 8): feastinghallspace is where hiring stops (wiki
// FeastingHallSpace), so a hall short of it no longer fires anyone.
t('a hall short of feastinghallspace fires nobody', () => {
  const c = ctx(ROSTER, { goals: [goal('keepheroes', 'any:level>=50')], config: { hero: 10, feastinghallspace: 1 } });
  const p = H.plans.keepheroes(c, {});
  eq(p.actions, []);
  ok(/none needs to go/.test(p.note), p.note);
});

t('/always fires the worst attack hero no rule protects', () => {
  const c = ctx(ROSTER, { goals: [goal('keepheroes', '/always', 'any:level>=50')], config: { hero: 10 } });
  const p = H.plans.keepheroes(c, {});
  eq(p.actions.length, 1);
  eq(p.actions[0].kind, 'fireHero');
  eq(p.actions[0].heroName, 'Junk2');          // lowest attack of the unprotected idle heroes
  ok(/irreversible/.test(p.actions[0].label), 'the label must say so');
});

t('the mayor is never fired, even when nothing protects it', () => {
  const lowMayor = hero({ id: 2, name: 'Polly', level: 5, status: H.STATUS.MAYOR, management: 40, power: 1 });
  const roster = [ATLAS, lowMayor, JUNK1, JUNK2, RIDER, SMARTY];
  const c = ctx(roster, { goals: [goal('keepheroes', '/always', '/max:9', 'any:level>=100')], config: { hero: 10 } });
  const p = H.plans.keepheroes(c, {});
  ok(p.actions.length >= 1, 'something unprotected is fired');
  ok(p.actions.every((a) => a.heroName !== 'Polly'), 'mayor must not be in the fire list');
  ok(p.actions.every((a) => a.heroStatus === H.STATUS.IDLE), 'only idle heroes may be fired');
});

t('a marching hero is never fired', () => {
  const c = ctx([ATLAS, POLLY, RIDER, JUNK1, JUNK2, SMARTY], {
    goals: [goal('keepheroes', '/always', 'any:level>=100')], config: { hero: 10 },
  });
  const p = H.plans.keepheroes(c, {});
  ok(p.actions.every((a) => a.heroName !== 'Rider'), 'Rider is marching');
});

t('garrisoned and captive heroes are never fired', () => {
  const guard = hero({ id: 7, name: 'Guard', level: 2, status: H.STATUS.GARRISON, power: 1 });
  const captive = hero({ id: 8, name: 'Prisoner', level: 2, status: H.STATUS.CAPTIVE, power: 2 });
  const c = ctx([ATLAS, POLLY, guard, captive, JUNK1], {
    goals: [goal('keepheroes', '/always', 'any:level>=100')], config: { hero: 10 },
  });
  const p = H.plans.keepheroes(c, {});
  eq(p.actions.map((a) => a.heroName), ['Junk1']);
});

t('/always fires everything unprotected, /max caps how many per pass', () => {
  const base = [ATLAS, POLLY, SMARTY, JUNK1, JUNK2, RIDER];
  const one = H.plans.keepheroes(ctx(base, {
    goals: [goal('keepheroes', '/always', 'any:level>=50')], config: { hero: 10 },
  }), {});
  eq(one.actions.length, 1, 'default cap is one per pass');
  const two = H.plans.keepheroes(ctx(base, {
    goals: [goal('keepheroes', '/always', '/max:2', 'any:level>=50')], config: { hero: 10 },
  }), {});
  eq(two.actions.map((a) => a.heroName), ['Junk2', 'Junk1'], 'worst attack first');
  const many = H.plans.keepheroes(ctx(base, {
    goals: [goal('keepheroes', '/always', '/max:9', 'any:level>=50')], config: { hero: 10 },
  }), {});
  eq(many.actions.length, 2, 'only the two junk heroes are unprotected and idle');
});

t('the fire cooldown holds the next one back', () => {
  const c = ctx(ROSTER, { goals: [goal('keepheroes', '/always', 'any:level>=50')], config: { hero: 10 } });
  const p = H.plans.keepheroes(c, { lastFireAt: Date.now() - 1000 });
  eq(p.actions, []);
  ok(/cooldown/.test(p.note), p.note);
  const later = H.plans.keepheroes(c, { lastFireAt: Date.now() - (H.FIRE_COOLDOWN_MS + 1000) });
  eq(later.actions.length, 1);
});

t('config hero:20 sets aside two politics heroes before ranking by attack', () => {
  const pol2 = hero({ id: 10, name: 'Pol2', level: 20, management: 150, power: 5 });
  const roster = [ATLAS, POLLY, pol2, JUNK1, JUNK2];
  const c = ctx(roster, { goals: [goal('keepheroes', '/always', 'any:level>=100')], config: { hero: 20 } });
  const p = H.plans.keepheroes(c, {});
  ok(p.actions.every((a) => a.heroName !== 'Pol2'), 'Pol2 is one of the two reserved politics heroes');
  eq(p.actions.map((a) => a.heroName), ['Junk2']);
});

t('nobody is fired when the roster has not arrived', () => {
  for (const heroes of [[], [{ name: 'Nameless' }]]) {
    const c = ctx(heroes, { goals: [goal('keepheroes', 'any:level>=50')], config: { hero: 10, feastinghallspace: 1 } });
    const p = H.plans.keepheroes(c, {});
    eq(p.actions, [], JSON.stringify(heroes));
  }
});

t('the last hero in a city is never fired', () => {
  const c = ctx([JUNK1], { goals: [goal('keepheroes', '/always', 'any:level>=100')], config: { hero: 10 } });
  eq(H.plans.keepheroes(c, {}).actions, []);
});

t('an unknown hall size means no firing for space', () => {
  const c = ctx(ROSTER, {
    goals: [goal('keepheroes', 'any:level>=50')], config: { hero: 10, feastinghallspace: 1 }, hallLevel: null,
  });
  const p = H.plans.keepheroes(c, {});
  eq(p.actions, []);
  ok(/hall size unknown/.test(p.note), p.note);
});

t('with no keepheroes goal the NEAT default protects level 50+ and base 69+', () => {
  const c = ctx(ROSTER, { goals: [goal('keepheroes', '/always')], config: { hero: 10 } });
  const p = H.plans.keepheroes(c, {});
  ok(/default/.test(p.note), p.note);
  eq(p.actions.map((a) => a.heroName), ['Junk2']);
  ok(p.fireable.every((h) => h.level < 50 && H.heroBase(h) < 69), 'default keeps 50+/69+');
});

t('herofirelimit N is read as keepheroes any:level>=N', () => {
  const g = goal('herofirelimit', '100');
  eq(g.parseErrors, []);
  eq(g.spec.src, 'any:level>=100');
  // Polly (L60) is now unprotected where the default would have kept her
  const c = ctx(ROSTER, { goals: [g, goal('keepheroes', '/always')], config: { hero: 10 } });
  const p = H.plans.keepheroes(c, {});
  ok(p.fireable.some((h) => h.name === 'Smarty'), 'L80 Smarty is below the limit and idle');
  eq(p.actions.map((a) => a.heroName), ['Junk2']);
});
t('herofirelimit without a level is an error', () => ok(goal('herofirelimit').parseErrors.length));

t('keepcapturedheroes governs heroes recorded as captured', () => {
  const cap = hero({ id: 20, name: 'Taken', level: 60, power: 30, management: 20 });
  const roster = [ATLAS, POLLY, SMARTY, cap, JUNK1];
  const state = { capturedHeroes: { 20: true } };
  // keepheroes would have kept a level-60 hero; the captured rule is what counts
  const c = ctx(roster, {
    goals: [goal('keepheroes', 'any:level>=50'), goal('keepcapturedheroes', 'any:level>=200')],
    config: { hero: 10 },
  });
  const withAlways = ctx(roster, {
    goals: [goal('keepheroes', '/always', '/max:5', 'any:level>=50'), goal('keepcapturedheroes', 'any:level>=200')],
    config: { hero: 10 },
  });
  const p = H.plans.keepheroes(withAlways, state);
  ok(p.actions.some((a) => a.heroName === 'Taken'), 'captured L60 is below keepcapturedheroes any:level>=200');
  // and a high-level captured hero is kept
  const state2 = { capturedHeroes: { 20: true } };
  const roster2 = [ATLAS, POLLY, SMARTY, hero({ id: 20, name: 'Taken', level: 250, power: 30 }), JUNK1];
  const p2 = H.plans.keepheroes(ctx(roster2, {
    goals: [goal('keepheroes', '/always', '/max:5', 'any:level>=50'), goal('keepcapturedheroes', 'any:level>=200')],
    config: { hero: 10 },
  }), state2);
  ok(p2.actions.every((a) => a.heroName !== 'Taken'), 'L250 captured hero must be kept');
  eq(H.plans.keepheroes(c, state).actions, [], 'space mode with room to spare fires nobody');
});

t('captured heroes are judged by keepcapturedheroes, everyone else by keepheroes', () => {
  const goodBase = { level: 60, power: 135, management: 20 };   // base 75
  const taken = hero(Object.assign({ id: 21, name: 'Taken' }, goodBase));
  const hired = hero(Object.assign({ id: 22, name: 'Hired' }, goodBase));
  const goals = [
    goal('keepheroes', '/always', '/max:5', 'any:level>=100'),      // neither is level 100
    goal('keepcapturedheroes', 'any:base>=69'),                     // base 75 -> keeps the captured one
  ];
  const c = ctx([ATLAS, POLLY, taken, hired, JUNK1], { goals, config: { hero: 10 } });
  const fired = H.plans.keepheroes(c, { capturedHeroes: { 21: true } }).actions.map((a) => a.heroName);
  ok(!fired.includes('Taken'), 'the captured hero is protected by keepcapturedheroes');
  ok(fired.includes('Hired'), 'the hired one falls under keepheroes, which does not protect it');
});

t('a switches-only keepheroes line sets the cap without adding a rule', () => {
  const goals = [goal('keepheroes', '/max:2'), goal('keepheroes', '/always', 'any:level>=50')];
  eq(goals[0].parseErrors, []);
  eq(H.plans.keepheroes(ctx(ROSTER, { goals, config: { hero: 10 } }), {}).actions.length, 2);
});

t('/reset drops the keep rules collected before it', () => {
  const goals = [goal('keepheroes', 'any:level>=1'), goal('keepheroes', '/reset'), goal('keepheroes', '/always', 'any:level>=100')];
  const c = ctx(ROSTER, { goals, config: { hero: 10 } });
  const p = H.plans.keepheroes(c, {});
  ok(/any:level>=100/.test(p.note) && !/any:level>=1\b/.test(p.note), p.note);
  eq(p.actions.length, 1);
});

t('a keepheroes line with a broken hero string reports and protects nothing new', () => {
  const g = goal('keepheroes', '250');
  ok(g.parseErrors.length, 'expected a parse error');
  // rulesFor skips broken rules, so the NEAT default takes over rather than
  // leaving the roster unprotected
  const c = ctx(ROSTER, { goals: [g], config: { hero: 10, feastinghallspace: 1 } });
  const p = H.plans.keepheroes(c, {});
  ok(/default/.test(p.note), p.note);
});

// ======================================================================
console.log('feasting hall');
// ======================================================================
// Changed on purpose (step 12): the training hero's slot is held only while one
// is on its way here (wiki City: checkFeastingHallSpace counts it "if not in
// that town"); these cities have no training hero, so no slot is held for one.
t('capacity comes from the feasting hall level; with no training hero coming, no slot is held for one', () => {
  const c = ctx([JUNK1, JUNK2], { config: { feastinghallspace: 2 }, hallLevel: 8 });
  const hall = H.feastingHall(c);
  eq({ capacity: hall.capacity, used: hall.used, free: hall.free, wantFree: hall.wantFree, hireBudget: hall.hireBudget },
     { capacity: 8, used: 2, free: 6, wantFree: 2, hireBudget: 4 });
  const p = H.plans.feastinghallspace(c);
  ok(/may hire 4 more/.test(p.note), p.note);
});
t('a full hall reports how many slots it is short', () => {
  const c = ctx(ROSTER, { config: { feastinghallspace: 1 }, hallLevel: 6 });
  eq(H.feastingHall(c).short, 1);
  ok(/1 slot\(s\) short/.test(H.plans.feastinghallspace(c).note));
});
t('castle.heroCapacity wins over the inferred level when present', () => {
  const c = ctx([JUNK1], { config: { feastinghallspace: 0 } });
  c.castle.heroCapacity = 4;
  eq(H.feastingHall(c).capacity, 4);
});
t('no feastinghallspace config -> no plan', () => eq(H.plans.feastinghallspace(ctx(ROSTER)), null));

// ======================================================================
console.log('heropoints');
// ======================================================================
const pointy = (o) => hero(Object.assign({ id: 30, name: 'BillyBob', level: 10, remainPoint: 30, power: 30, stratagem: 10, management: 5 }, o));

t('parses stages, caps, * and off', () => {
  const g = goal('heropoints', 'billybob', 'att:50', 'att:100,int:850', 'att');
  eq(g.parseErrors, []);
  eq(g.stages.length, 3);
  eq(g.stages[0].targets, [{ attr: 'power', cap: 50, raw: 'att:50' }]);
  ok(g.stages[2].targets[0].cap === Infinity, 'bare "att" means att:*');
  ok(goal('heropoints', 'x', 'off').stages[0].off, 'off stage');
  ok(goal('heropoints', 'x', 'none').stages[0].off, 'none == off');
  eq(goal('heropoints', 'x', 'pol:any').stages[0].targets[0].cap, 0, 'pol:any means do not assign');
});

t('fills the first stage, then spills the rest into the next in ratio', () => {
  const h = pointy();
  const c = ctx([h], { goals: [goal('heropoints', 'billybob', 'att:50', 'att:100,int:850', 'att')] });
  const p = H.plans.heropoints(c, {});
  eq(p.actions.length, 1);
  const a = p.actions[0];
  eq(a.points, 30);
  eq(a.add.power + a.add.stratagem + a.add.management, 30, 'every point is spent');
  eq(a.add.power, 21, '20 to reach att 50, then its share of the ratio stage');
  eq(a.add.stratagem, 9);
  eq(a.totals, { management: 5, power: 51, stratagem: 19 }, 'totals are current + added');
});

t('a satisfied stage is skipped', () => {
  const h = pointy({ power: 60, remainPoint: 10 });           // att:50 already met
  const c = ctx([h], { goals: [goal('heropoints', 'billybob', 'att:50', 'int:850')] });
  const a = H.plans.heropoints(c, {}).actions[0];
  eq(a.add, { power: 0, management: 0, stratagem: 10 });
});

t('a * target takes everything left', () => {
  const h = pointy({ remainPoint: 7 });
  const c = ctx([h], { goals: [goal('heropoints', 'billybob', 'politics:*')] });
  eq(H.plans.heropoints(c, {}).actions[0].add, { power: 0, management: 7, stratagem: 0 });
});

t('with no open-ended stage the leftovers go to the highest stat', () => {
  const h = pointy({ power: 30, stratagem: 10, remainPoint: 30 });
  const c = ctx([h], { goals: [goal('heropoints', 'billybob', 'int:15')] });
  const a = H.plans.heropoints(c, {}).actions[0];
  eq(a.add.stratagem, 5, 'int up to 15');
  eq(a.add.power, 25, 'the rest into attack, the highest stat');
});

t('the highest stat for leftovers is the highest once the stages are met', () => {
  const h = pointy({ power: 30, stratagem: 10, remainPoint: 60 });
  const c = ctx([h], { goals: [goal('heropoints', 'billybob', 'int:50')] });
  eq(H.plans.heropoints(c, {}).actions[0].add, { power: 0, management: 0, stratagem: 60 },
    'int 50 tops attack 30, so the 20 left go to intel too (wiki: "which would be intel")');
});

t('off holds the points back', () => {
  const c = ctx([pointy()], { goals: [goal('heropoints', 'billybob', 'off')] });
  const p = H.plans.heropoints(c, {});
  eq(p.actions, []);
  ok(/held/.test(p.note), p.note);
});

t('pol:any assigns nothing to politics', () => {
  const c = ctx([pointy()], { goals: [goal('heropoints', 'billybob', 'pol:any')] });
  eq(H.plans.heropoints(c, {}).actions[0].add.management, 0);
});

t('hero strings pick which rule applies, first match wins', () => {
  const big = pointy({ id: 31, name: 'Titan', level: 400, power: 100, stratagem: 50, remainPoint: 10 });
  const goals = [goal('heropoints', 'any:level>300', 'att:*'), goal('heropoints', 'titan', 'int:*')];
  const a = H.plans.heropoints(ctx([big], { goals }), {}).actions[0];
  eq(a.add, { power: 10, management: 0, stratagem: 0 }, 'the level rule was written first, so it wins');
});

t('heroes with no matching rule, no points, or held captive are left alone', () => {
  const nomatch = pointy({ id: 32, name: 'Nobody' });
  const nopoints = pointy({ id: 33, name: 'BillyBob', remainPoint: 0 });
  const captive = pointy({ id: 34, name: 'BillyBob', status: H.STATUS.CAPTIVE });
  const goals = [goal('heropoints', 'billybob', 'att:*')];
  eq(H.plans.heropoints(ctx([nomatch, nopoints, captive], { goals }), {}).actions, []);
});

t('no heropoints goal -> no plan', () => eq(H.plans.heropoints(ctx([pointy()]), {}), null));

t('heropoints /reset clears earlier rules', () => {
  const goals = [goal('heropoints', 'billybob', 'pol:*'), goal('heropoints', '/reset'), goal('heropoints', 'billybob', 'int:*')];
  const a = H.plans.heropoints(ctx([pointy()], { goals }), {}).actions[0];
  eq(a.add, { power: 0, management: 0, stratagem: 30 });
});

// ======================================================================
console.log('nolevelheroes / homeheroes / nomayor / spamheroes / training');
// ======================================================================
t('heroes with the experience are levelled unless nolevelheroes holds them', () => {
  const ready = hero({ id: 40, name: 'Ready', level: 10, experience: 500, upgradeExp: 400 });
  const held = hero({ id: 41, name: 'ForBob', level: 10, experience: 900, upgradeExp: 400 });
  const c = ctx([ready, held, ATLAS], { goals: [goal('nolevelheroes', 'ForBob')], config: { hero: 10 } });
  const p = H.plans.nolevelheroes(c);
  eq(p.actions.map((a) => a.heroName), ['Ready']);
  eq(p.actions[0].kind, 'levelUp');
});
t('nolevelheroes takes hero strings too', () => {
  const smart = hero({ id: 42, name: 'Brainy', level: 10, stratagem: 170, experience: 900, upgradeExp: 400 });
  const c = ctx([smart], { goals: [goal('nolevelheroes', 'any:intel>=163')], config: { hero: 10 } });
  eq(H.plans.nolevelheroes(c).actions, []);
});
t('config hero:0 levels nobody', () => {
  const ready = hero({ id: 40, name: 'Ready', experience: 500, upgradeExp: 400 });
  eq(H.plans.nolevelheroes(ctx([ready], { goals: [goal('nolevelheroes', 'none')], config: { hero: 0 } })).actions, []);
});

t('homeheroes holds back the weakest idle heroes', () => {
  const c = ctx(ROSTER, { goals: [goal('homeheroes', '2')] });
  const { keepHome, home, free } = H.farmableHeroes(c);
  eq(keepHome, 2);
  eq(home.map((h) => h.name), ['Junk2', 'Junk1'], 'the two worst attack heroes stay');
  ok(free.every((h) => h.status === H.STATUS.IDLE), 'only idle heroes are counted');
  ok(free.every((h) => h.name !== 'Junk1' && h.name !== 'Junk2'));
  ok(H.plans.homeheroes(c).note.includes('2 hero(es) free to farm') || free.length === 2, 'note reports the split');
});
t('no homeheroes goal -> everybody idle may farm', () => {
  eq(H.farmableHeroes(ctx(ROSTER)).free.length, 4);
  eq(H.plans.homeheroes(ctx(ROSTER)), null);
});

t('config nomayor:1 stands the mayor down', () => {
  const p = H.plans.nomayor(ctx(ROSTER, { config: { nomayor: 1 } }));
  eq(p.actions.length, 1);
  eq(p.actions[0].kind, 'dischargeChief');
  eq(p.actions[0].heroName, 'Polly');
});
t('config nomayor:1 with no mayor does nothing', () =>
  eq(H.plans.nomayor(ctx([ATLAS, JUNK1], { config: { nomayor: 1 } })).actions, []));
t('nomayor unset -> no plan', () => eq(H.plans.nomayor(ctx(ROSTER)), null));

t('spamheroes selects the junk heroes by default rule', () => {
  const c = ctx(ROSTER, { goals: [goal('spamheroes', 'any:base<=69,level<50')] });
  eq(H.spamHeroes(c).map((h) => h.name), ['Junk1', 'Junk2']);
});

t('config training drops the npc cooldown to an hour', () => {
  eq(H.npcCooldownMs(ctx(ROSTER, { config: {} }), 5), 8 * 3600e3);
  eq(H.npcCooldownMs(ctx(ROSTER, { config: { training: 1 } }), 5), 3600e3);
  eq(H.npcCooldownMs(ctx(ROSTER, { config: { training: 2 } }), 5), 3600e3);
  eq(H.npcUsesTransports(ctx(ROSTER, { config: { training: 2 } })), false);
  eq(H.npcCooldownMs(ctx(ROSTER, { config: { training: 1 } }), 10), 8 * 3600e3, 'npc10 has its own switch');
  eq(H.npcCooldownMs(ctx(ROSTER, { config: { training10: 1 } }), 10), 3600e3);
});

// ======================================================================
console.log('parser contract against goals.js');
// ======================================================================
t('the parsers drop straight into goals.js GOALS and parse a goal file', () => {
  const G = require('./goals');
  Object.assign(G.GOALS, H.parsers);          // in-process only; goals.js is untouched on disk
  const parsed = G.parseGoals([
    'config hero:10,feastinghallspace:1',
    'keepheroes any:level>=100|any:base>=69',
    'keepheroes /max:2',
    'keepcapturedheroes any:level>=200',
    'herofirelimit 80',
    'heropoints billybob att:50 att:100,int:850 att',
    'nolevelheroes ForBob',
    'homeheroes 2',
    'spamheroes any:base<=69,level<50',
  ].join('\n'));
  eq(parsed.errors, [], 'no goal should fail to parse');
  eq(parsed.config, { hero: 10, feastinghallspace: 1 });
  eq(parsed.goals.map((g) => g.name),
     ['keepheroes', 'keepheroes', 'keepcapturedheroes', 'herofirelimit', 'heropoints', 'nolevelheroes', 'homeheroes', 'spamheroes']);
  // and the plans run off exactly that (nothing needs a slot, so nobody goes)
  const c = { game: null, castle: castle(ROSTER), goals: parsed.goals, config: parsed.config, fortifications: {}, incoming: [] };
  const p = H.plans.keepheroes(c, {});
  ok(p && /keep: any:level>=100\|any:base>=69/.test(p.note), 'a plan comes out the other end');
  eq(p.actions, []);
});

t('goals.js reports bad hero goal lines instead of silently ignoring them', () => {
  const G = require('./goals');
  Object.assign(G.GOALS, H.parsers);
  const parsed = G.parseGoals('keepheroes 250\nheropoints\nhomeheroes');
  eq(parsed.errors.length, 3, JSON.stringify(parsed.errors));
  ok(/just a number/.test(parsed.errors[0].error), parsed.errors[0].error);
});

// ======================================================================
console.log('executors (against a stub game, still no network)');
// ======================================================================
function stubGame() {
  const calls = [];
  return {
    calls,
    castleId: (c) => c.castleId,
    fireHero: (cid, hid) => { calls.push(['fireHero', cid, hid]); return { ok: 1 }; },
    // game.addPoint(castleId, heroObject, increments) — it reads the hero's current
    // attributes and sends the absolute totals itself, and throws on a bare id.
    addPoint: (cid, heroObj, inc) => {
      if (!heroObj || typeof heroObj !== 'object') throw new Error('addPoint needs the hero object, not a bare id');
      calls.push(['addPoint', cid, heroObj, inc]);
      return { ok: 1 };
    },
    levelUpHero: (cid, hid) => { calls.push(['levelUp', cid, hid]); return { ok: 1 }; },
    dischargeChief: (cid) => { calls.push(['dischargeChief', cid]); return { ok: 1 }; },
  };
}
// the async checks, run to completion before the summary
(async () => {
  await t2('fireHero refuses when the hero has gone', async () => {
    const g = stubGame();
    await expectThrow(H.executors.fireHero(g, castle([ATLAS]), { heroId: 4, heroName: 'Junk1' }), /no longer/);
    eq(g.calls, []);
  });
  await t2('fireHero refuses when the id now belongs to another hero', async () => {
    const g = stubGame();
    await expectThrow(H.executors.fireHero(g, castle([Object.assign({}, JUNK1, { name: 'Renamed' })]), { heroId: 4, heroName: 'Junk1' }), /not "Junk1"/);
    eq(g.calls, []);
  });
  await t2('fireHero refuses a hero that is no longer idle', async () => {
    const g = stubGame();
    await expectThrow(H.executors.fireHero(g, castle([Object.assign({}, JUNK1, { status: H.STATUS.MAYOR })]), { heroId: 4, heroName: 'Junk1' }), /mayor/);
    eq(g.calls, []);
  });
  await t2('fireHero sends castleId and heroId', async () => {
    const g = stubGame();
    await H.executors.fireHero(g, castle([JUNK1, ATLAS]), { heroId: 4, heroName: 'Junk1' });
    eq(g.calls, [['fireHero', 77, 4]]);
  });
  await t2('addPoint hands over the live hero and the increments, not a bare id', async () => {
    const g = stubGame();
    const h = pointy();                                   // pol 5 / att 30 / int 10, 30 points
    const c = castle([h]);
    await H.executors.addPoint(g, c, {
      heroId: 30, heroName: 'BillyBob', points: 30,
      add: { management: 0, power: 21, stratagem: 9 },
    });
    // the stub throws on a bare id, so reaching here proves the hero object went across
    eq(g.calls.length, 1);
    eq(g.calls[0][0], 'addPoint');
    eq(g.calls[0][1], 77, 'castleId');
    ok(g.calls[0][2] === c.heros[0], 'the LIVE hero object out of the castle, not the planned copy');
    eq(g.calls[0][3], { management: 0, power: 21, stratagem: 9 }, 'increments — game.addPoint converts to totals');
  });
  await t2('addPoint scales the increments down when the hero has fewer points than planned', async () => {
    const g = stubGame();
    const h = pointy({ remainPoint: 10 });                // the plan was written for 30
    await H.executors.addPoint(g, castle([h]), {
      heroId: 30, heroName: 'BillyBob', points: 30,
      add: { management: 0, power: 21, stratagem: 9 },
    });
    eq(g.calls[0][3], { management: 0, power: 7, stratagem: 3 }, 'a third of each, never more than remainPoint');
    ok(Object.values(g.calls[0][3]).reduce((a, b) => a + b, 0) <= num(h.remainPoint), 'never spends points it does not have');
  });
  await t2('addPoint refuses when the points are already gone', async () => {
    const g = stubGame();
    await expectThrow(H.executors.addPoint(g, castle([pointy({ remainPoint: 0 })]), {
      heroId: 30, heroName: 'BillyBob', points: 30, add: { management: 0, power: 30, stratagem: 0 },
    }), /no points/);
    eq(g.calls, []);
  });
  await t2('levelUp and dischargeChief pass the ids through', async () => {
    const g = stubGame();
    await H.executors.levelUp(g, castle([ATLAS]), { heroId: 1, heroName: 'Atlas' });
    await H.executors.dischargeChief(g, castle([POLLY]), { heroId: 2 });
    eq(g.calls, [['levelUp', 77, 1], ['dischargeChief', 77]]);
  });

  console.log('');
  for (const f of fails) console.log('  FAIL  ' + f);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

async function t2(name, fn) {
  try { await fn(); pass++; }
  catch (e) { fail++; fails.push(`${name}\n      ${e.message}`); }
}
async function expectThrow(promise, re) {
  try { await promise; }
  catch (e) { if (!re.test(e.message)) throw new Error(`wrong error: ${e.message}`); return; }
  throw new Error('expected it to throw');
}
