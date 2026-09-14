'use strict';
// City upkeep, the NEAT way (wiki Comfort, ComfortPolicy, TaxPolicy, Production,
// WarehousePolicy, NoHealing, HealTroops, Levy):
//
//   config comfort:<0|1>   on unless 0 — NEAT's default is 1. Keeps loyalty up
//                          and grievance down with praying and disaster relief,
//                          and holds the tax the gold allows (taxpolicy below).
//   comfortpolicy <min> <max> [options]
//                          every min-max minutes: popraise (only below the
//                          population limit), bless, pray, relief, and levies of
//                          gold, food, wood, stone or iron. Needs comfort on.
//   taxpolicy <min> <max> [war]     the range the tax is held in (default 0 100)
//   production <food> <wood> <stone> <iron>         the Town Hall's labour, held
//   warehousepolicy <food> <lumber> <stone> <iron>  warehouse protection, held
//   config nohealing:<0|1> the medic camp is healed unless 1 (default 0)
//
// Plans are pure: they read the city, the game's medic-camp record and this
// module's record in the city's state (state.upkeep), and return actions. The
// executors send, and stamp the record with what the server said, so a refusal
// is never taken for a success. Every action spends the engine's normal action
// budget; a plan's note says what it waits for.
//
// comfort is planned by the engine in the slot the old comfortpolicy had,
// ahead of defensepolicy (engine.js focus, through goalmods.comfortPlan); the
// other four are this module's `plans`, which the engine runs right after it.
//
// PROTOCOL AND GAME FACTS, from the decompiled client (src/scripts/...):
//   interior.pacifyPeople {castleId, typeId}         InteriorCommands.as:87-98
//     1 disaster relief  +5 loyalty, -15 grievance   (PacifyPeopleView.as:449-456)
//     2 praying          +25 loyalty, -5 grievance   (:457-464)
//       both cost food: prestige / 10 x castleCount x the city's
//       usePACIFY_SUCCOUR_OR_PACIFY_PRAY, at most 10,000,000 (:451-454)
//     3 blessing         food = the population limit, gold = a tenth of it (:465-468)
//     4 population raise +5% of the limit, never past it; food = limit x 5 (:469-471)
//   interior.taxation {castleId, typeId} — a levy     InteriorCommands.as:41-52
//     1 gold (population / 10), 2 food (population), 3 lumber (population),
//     4 stone (population / 2), 5 iron (population x 0.4)
//     (CollectionMaterialsView.as:398-414, 486-499); every levy costs 20
//     loyalty (Lang 临时征收物资会降低民心20: "Every levy declines Loyalty by 20").
//   interior.modifyTaxRate {castleId, tax}           InteriorCommands.as:28-39
//     gold per hour = population x rate / 100        (AdjustmentCess.as:523, 667)
//   loyalty drifts toward 100 - tax - grievance      (SupportTooltip.as:420-434)
//   gold per hour = taxIncome - herosSalary          (GoldTooltip.as:478, CastleInfoFrame.as:2544)
//   interior.getResourceProduceData {castleId} -> resourceProduceDataBean[{typeid 1-4, commenceRate}]
//   interior.modifyCommenceRate {castleId, foodrate, woodrate, stonerate, ironrate}  (ResourceProduce.as:918)
//   city.getStoreList {castleId} -> {totalCap, storeBeans[{storeTypeId 1-4, storePercent}]}
//   city.modifyStorePercent {castleId, foodrate, woodrate, stonerate, ironrate}      (WareHouse.as:556)
//   army.getInjuredTroop {castleId}: a bare reply; the camp comes as the push
//     server.InjuredTroopUpdate {castleId, goldNeed, troop}  (HospitalWin.as:228-252, 557)
//   army.cureInjuredTroop {castleId} heals the whole camp; the client sends it
//     only when goldNeed is within the city's gold   (HospitalWin.as:490-504)
//     Wounded left there "will gradually die" (Lang 伤兵在校场的伤兵营中等待治疗).
//
// Two things the other goals keep, respected here:
//   a day of hero salaries — goal-heroes.salaryReserve, the same figure the
//     rewards keep back (the server's herosSalary an hour, else level x 20 a
//     hero): the tax's gold emergency and the gold a cure may not touch.
//   the next construction's cost — ctx.buildReserve (Engine.resolveBuild): a
//     comfort's food or gold, a cure's gold, and the gold the tax counts as
//     banked all leave it where it is.
const W = require('./goal-war');
const H = require('./goal-heroes');

const n = (x) => Number(x || 0);
const fmt = (x) => Math.round(n(x)).toLocaleString('en-US');
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
// a number the bean really carries, or null — a missing field is unknown, never 0
const val = (x) => (x === undefined || x === null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

// "40 s", "25 min", "3 h 5 min"
const span = (ms) => {
  const mins = Math.round(Math.max(0, ms) / 60000);
  if (mins >= 60) return `${Math.floor(mins / 60)} h ${mins % 60} min`;
  if (ms >= 59500) return `${mins} min`;
  return `${Math.max(1, Math.round(Math.max(0, ms) / 1000))} s`;
};

// ------------------------------------------------------------------ the tables
// interior.pacifyPeople typeIds by NEAT's names (wiki Comfort: 1 relief,
// 2 pray, 3 bless, 4 popraise — the client's own order). constants.js calls 3
// "sacrifice" (祭天); the client's English name is Blessing.
const PACIFY = { relief: 1, pray: 2, bless: 3, popraise: 4 };
const PACIFY_NAME = { relief: 'disaster relief', pray: 'praying', bless: 'blessing', popraise: 'population raising' };
// interior.taxation typeIds (wiki Levy: 1 gold, 2 food, 3 wood, 4 stone, 5 iron)
const LEVY = { gold: 1, food: 2, wood: 3, stone: 4, iron: 5 };
const LEVY_SHARE = { gold: 0.1, food: 1, wood: 1, stone: 0.5, iron: 0.4 };   // of the population

// comfortpolicy's options (wiki ComfortPolicy), and `sacrifice`, this bot's old
// word for blessing, so a line written for the old comfortpolicy still reads.
const OPTION_WORDS = {
  gold: 'gold', go: 'gold', stone: 'stone', st: 'stone', iron: 'iron', ir: 'iron', food: 'food', fo: 'food',
  wood: 'wood', lumber: 'wood', wo: 'wood', lu: 'wood',
  popraise: 'popraise', po: 'popraise', bless: 'bless', bl: 'bless', pray: 'pray', pr: 'pray', relief: 'relief', dr: 'relief',
  sacrifice: 'bless',
};

// The words the NEAT `comfort` and `levy` script commands take, numbers
// included, for whatever script runs them (wiki Comfort, Levy).
function comfortTypeOf(word) {
  const w = String(word || '').toLowerCase();
  const byNum = { 1: 'relief', 2: 'pray', 3: 'bless', 4: 'popraise' }[w];
  const type = byNum || OPTION_WORDS[w];
  return type && PACIFY[type] ? { type, typeId: PACIFY[type] } : null;
}
function levyTypeOf(word) {
  const w = String(word || '').toLowerCase();
  const byNum = { 1: 'gold', 2: 'food', 3: 'wood', 4: 'stone', 5: 'iron' }[w];
  const type = byNum || OPTION_WORDS[w];
  return type && LEVY[type] ? { type, typeId: LEVY[type] } : null;
}

// ------------------------------------------------------------------ timings
// NEAT's gold emergency: under 24 hours of hero salary (wiki TradePolicy) — the
// same day the rewards keep back (goal-heroes REWARD_RESERVE_HOURS). A tax
// raised for gold comes back down once two days of salary are banked, so it
// does not flip at the line every slice.
const RESERVE_H = H.REWARD_RESERVE_HOURS || 24;
const RELEASE_H = 2 * RESERVE_H;
const TAX_SETTLE_MS = 3 * 60000;         // after a change, until the city shows it
const UPKEEP_GAP_MS = 2 * 60000;         // between two loyalty/grievance comforts
const RETRY_MS = 2 * 60000;              // a comfortpolicy action whose reply was lost
const CHECK_MS = 30 * 60000;             // production / warehouse: how often to look
const CAMP_READ_MS = 60 * 60000;         // the medic camp: how often to look
const CAMP_AFTER_LANDING_MS = 60000;     // ...and this long after an attack lands
const LADDER = [5 * 60000, 15 * 60000, 60 * 60000];   // after a refusal
// A levy costs 20 loyalty. The wiki gives no floor; this bot never lets a levy
// take loyalty under 50, and never levies while under attack, when loyalty is
// all that stands between the city and capture.
const LEVY_LOYALTY_COST = 20;
const LEVY_FLOOR = 50;

const upkeep = (state) => (state.upkeep = state.upkeep || {});
const part = (state, key) => { const u = upkeep(state); return (u[key] = u[key] || {}); };

// A refusal waits its turn on the ladder rather than being asked every slice.
function heldBack(rec, now = Date.now()) {
  const f = rec.fail;
  return f && now < n(f.until) ? f : null;
}
function noteOutcome(rec, r) {
  if (r && r.ok === 1) { delete rec.fail; return; }
  const f = rec.fail || { n: 0 };
  f.n = n(f.n) + 1;
  f.until = Date.now() + LADDER[Math.min(f.n - 1, LADDER.length - 1)];
  f.msg = String((r && (r.errorMsg || (r.ok !== undefined ? `ok=${r.ok}` : ''))) || 'no reply').slice(0, 120);
  rec.fail = f;
}
const failText = (f) => `refused (${f.msg}), asking again in ${span(n(f.until) - Date.now())}`;

// ------------------------------------------------------------------ parsing
const kvWord = (s) => String(s).toLowerCase();

// A percentage: a whole number 0-100, "%" allowed.
function percent(s, what, errs) {
  const m = String(s === undefined ? '' : s).trim().match(/^(\d+)%?$/);
  const v = m ? Number(m[1]) : null;
  if (v === null || v > 100) { errs.push(`${what} "${s === undefined ? '' : s}" is not a whole percentage from 0 to 100`); return null; }
  return v;
}

// A number of minutes, at least one.
function minutes(s, what, errs) {
  const m = String(s === undefined ? '' : s).trim().match(/^\d+(\.\d+)?$/);
  const v = m ? Number(s) : null;
  if (v === null || v < 1) { errs.push(`${what} "${s === undefined ? '' : s}" is not a number of minutes (1 or more)`); return null; }
  return v;
}

// Four percentages in a fixed order; a line with any error is left out whole.
function fourRates(name, words, args, errs) {
  if (args.length !== 4) errs.push(`expected: ${name} ${words.map((w) => `<${w}%>`).join(' ')}`);
  const out = {};
  const keys = ['food', 'wood', 'stone', 'iron'];
  keys.forEach((k, i) => { out[k] = percent(args[i], words[i], errs); });
  return keys.every((k) => out[k] !== null) && !errs.length ? out : null;
}

const parsers = {
  // config comfort:<0|1> (wiki Comfort: "Switch: 0 = off, 1 = on", default 1).
  // goals.js runs a config-kind parser on its key when the goals are read, so
  // `comfort:2` shows red there; comfortSwitch below leaves such a city's
  // comfort off. (A line of its own, `comfort 1`, reads as config comfort:1.)
  comfort: {
    kind: 'config', multi: false,
    parse(value) {
      const errs = [];
      const set = value !== undefined && value !== null && value !== '';
      if (set && !/^[01]$/.test(String(value).trim())) errs.push(`comfort is 0 (off) or 1 (on), not "${value}"`);
      return { on: !set || String(value).trim() === '1', errors: errs };
    },
  },

  // taxpolicy min_rate max_rate [war_rate]   (wiki TaxPolicy; defaults 0 and 100)
  taxpolicy: {
    kind: 'policy', multi: false,
    parse(args) {
      const errs = [];
      if (args.length < 2 || args.length > 3) errs.push('expected: taxpolicy <min_rate> <max_rate> [war_rate]  (whole percentages, 0-100)');
      const min = percent(args[0], 'min_rate', errs);
      const max = percent(args[1], 'max_rate', errs);
      const war = args[2] === undefined ? null : percent(args[2], 'war_rate', errs);
      if (min !== null && max !== null && min > max) errs.push(`min_rate ${min} is above max_rate ${max}`);
      // a line with an error changes no tax at all: whatever it meant, it was not this
      return { min, max, war, valid: !errs.length, errors: errs };
    },
  },

  // comfortpolicy min_time max_time [options]   (wiki ComfortPolicy)
  comfortpolicy: {
    kind: 'policy', multi: false,
    parse(args) {
      const errs = [];
      const everyMinMin = minutes(args[0], 'min_time', errs);
      const everyMaxMin = minutes(args[1], 'max_time', errs);
      if (everyMinMin !== null && everyMaxMin !== null && everyMaxMin < everyMinMin) {
        errs.push(`max_time ${everyMaxMin} is shorter than min_time ${everyMinMin}`);
      }
      const options = [];
      for (const raw of args.slice(2)) {
        for (const word of String(raw).split(',')) {
          if (!word) continue;
          const type = OPTION_WORDS[kvWord(word)];
          if (!type) { errs.push(`unknown option "${word}" (known: popraise bless pray relief gold food wood stone iron, or po bl pr dr go fo wo lu st ir)`); continue; }
          if (options.some((o) => o.type === type)) continue;
          options.push({ word, type, kind: LEVY[type] ? 'levy' : 'comfort', typeId: LEVY[type] || PACIFY[type] });
        }
      }
      const valid = everyMinMin !== null && everyMaxMin !== null && everyMaxMin >= everyMinMin;
      return { everyMinMin, everyMaxMin, options, mode: options.length ? options[0].type : null, valid, errors: errs };
    },
  },

  // production food% wood% stone% iron%   (wiki Production)
  production: {
    kind: 'directive', multi: false,
    parse(args) {
      const errs = [];
      const rates = fourRates('production', ['food', 'wood', 'stone', 'iron'], args, errs);
      return { rates, valid: !!rates, errors: errs };
    },
  },

  // warehousepolicy food% lumber% stone% iron%   (wiki WarehousePolicy: the
  // total cannot exceed 100%; gold is never stored)
  warehousepolicy: {
    kind: 'policy', multi: false,
    parse(args) {
      const errs = [];
      const rates = fourRates('warehousepolicy', ['food', 'lumber', 'stone', 'iron'], args, errs);
      const total = rates ? rates.food + rates.wood + rates.stone + rates.iron : 0;
      if (rates && total > 100) errs.push(`the four add up to ${total}%, and the warehouse holds 100% at most`);
      return { rates: rates && total <= 100 ? rates : null, valid: !!rates && total <= 100, errors: errs };
    },
  },
};

// ------------------------------------------------------------------ the city
// What the castle bean says, each value null when it is not there. The hero
// salary is goal-heroes' figure, so the tax, the cure and the rewards all keep
// back the same day of it.
function cityFacts(ctx) {
  const res = (ctx.castle && ctx.castle.resource) || {};
  const bank = (k) => val(res[k] && typeof res[k] === 'object' ? res[k].amount : res[k]);
  return {
    loyalty: val(res.support), grievance: val(res.complaint), tax: val(res.texRate),
    population: val(res.curPopulation), limit: val(res.maxPopulation),
    income: val(res.taxIncome), salary: H.salaryReserve(ctx.castle).perHour,
    gold: bank('gold'), food: bank('food'), wood: bank('wood'), stone: bank('stone'), iron: bank('iron'),
  };
}

// What the next construction needs kept in the bank (Engine.resolveBuild sets
// ctx.buildReserve), or nothing.
const keptFor = (ctx) => (ctx && ctx.buildReserve) || null;
const keptWhat = (keep) => (keep && keep.label) || 'the next construction';

// config comfort: on unless 0 (wiki Comfort: "Default: config comfort:1").
// Anything but 0 or 1 is not understood, and leaves comfort off.
function comfortSwitch(cfg) {
  const v = (cfg || {}).comfort;
  if (v === undefined || v === null || v === '') return { on: true, set: false };
  if (Number(v) === 1) return { on: true, set: true };
  if (Number(v) === 0) return { on: false, set: true };
  return { on: false, set: true, error: `config comfort:${v} is not 0 or 1, so comfort is left off` };
}

// What a comfort costs this city, or null when the bean cannot say.
function comfortCost(ctx, type, f) {
  if (type === 'popraise') return f.limit === null ? null : { food: f.limit * 5 };
  if (type === 'bless') return f.limit === null ? null : { food: f.limit, gold: Math.ceil(f.limit * 0.1) };
  const game = ctx.game || {};
  const info = (game.player && game.player.playerInfo) || {};
  const prestige = val(info.prestige);
  const count = val(info.castleCount) ?? ((game.castles || []).length || null);
  const mult = val(ctx.castle && ctx.castle.usePACIFY_SUCCOUR_OR_PACIFY_PRAY);
  if (prestige === null || count === null || mult === null) return null;
  return { food: Math.min(Math.floor((prestige / 10) * count * mult), 10e6) };
}
const costText = (cost) => (cost ? Object.entries(cost).map(([k, v]) => `${fmt(v)} ${k}`).join(' and ') : 'an unknown amount');
// The first thing the city holds too little of once the next construction's
// share is left in the bank, or null (unknown banks are left to the server).
function shortOf(cost, f, keep = null) {
  for (const [k, v] of Object.entries(cost || {})) {
    if (f[k] === null || f[k] === undefined) continue;
    const held = n(keep && keep[k]);
    if (f[k] - held < v) return `${fmt(v)} ${k} (has ${fmt(f[k])}${held ? `, ${fmt(held)} of it kept for ${keptWhat(keep)}` : ''})`;
  }
  return null;
}

// ------------------------------------------------------------------ comfort
// Loyalty drifts toward 100 - tax - grievance (SupportTooltip.as:420). So a
// prayer lifts loyalty for good only up to 100 - tax; above that the tax takes
// it back. The bot comforts when grievance is above 0, or loyalty is under what
// the tax lets it hold — with NEAT's default tax of 0 that is NEAT's "100
// loyalty / 0 grievance" exactly, and at a higher tax no food is burned on
// prayers the tax undoes. It picks praying or disaster relief by which does
// more good (pray +25 loyalty -5 grievance, relief +5 loyalty -15 grievance).
function upkeepStep(ctx, state, f, roundComforts, now) {
  const st = part(state, 'comfort');
  if (f.loyalty === null && f.grievance === null) return { notes: [], actions: [] };
  const griev = Math.max(0, f.grievance || 0);
  const ceiling = f.tax === null ? null : clamp(100 - f.tax, 0, 100);
  const gap = f.loyalty !== null && ceiling !== null ? Math.max(0, ceiling - f.loyalty) : 0;
  const head = `loyalty ${f.loyalty === null ? '?' : f.loyalty}, grievance ${f.grievance === null ? '?' : griev}`;
  if (!gap && !griev) {
    const why = f.loyalty !== null && ceiling !== null && ceiling < 100 && f.loyalty < 100 ? ` (a ${f.tax}% tax holds loyalty at ${ceiling})` : '';
    const unknown = f.loyalty !== null && f.loyalty < 100 && ceiling === null ? ' (tax rate unknown, so no prayer for loyalty)' : '';
    return { notes: [`${head}${why}${unknown}`], actions: [] };
  }
  const pray = Math.min(25, gap) + Math.min(5, griev);
  const relief = Math.min(5, gap) + Math.min(15, griev);
  const type = relief > pray ? 'relief' : 'pray';
  if (roundComforts) return { notes: [`${head}: the comfortpolicy round comforts this slice`], actions: [] };
  if (n(st.upkeepAt) && now - n(st.upkeepAt) < UPKEEP_GAP_MS) {
    return { notes: [`${head}: ${PACIFY_NAME[st.upkeepType] || 'comforted'} ${span(now - n(st.upkeepAt))} ago, waiting for the city to show it`], actions: [] };
  }
  const f0 = heldBack(st);
  if (f0) return { notes: [`${head}: ${PACIFY_NAME[type]} ${failText(f0)}`], actions: [] };
  const cost = comfortCost(ctx, type, f);
  const short = shortOf(cost, f, keptFor(ctx));
  if (short) return { notes: [`${head}: ${PACIFY_NAME[type]} needs ${short}`], actions: [] };
  return {
    notes: [`${head}: ${PACIFY_NAME[type]} (${type === 'pray' ? '+25 loyalty, -5 grievance' : '+5 loyalty, -15 grievance'}, costs ${costText(cost)})`],
    actions: [{ kind: 'upkeepComfort', type, typeId: PACIFY[type], upkeep: true,
      label: `comfort: ${PACIFY_NAME[type]} (${head}${ceiling !== null && ceiling < 100 ? `, the tax holds it at ${ceiling}` : ''})` }],
  };
}

// A comfortpolicy round (wiki ComfortPolicy): "comfortpolicy 15 20 popraise
// wood pray" raises the population if needed every 15-20 minutes, "and if not
// then levy wood ... and follow with a prayer ... whether it's needed or not".
// So each round, in the line's order:
//   popraise   only while the population is under its limit ("if needed")
//   a levy     only when no popraise was needed this round
//   bless / pray / relief   every round
// Each option is tried once a round; the next round starts min-max minutes
// (picked at random) after the last one settled. A refusal is noted and the
// round moves on; a lost reply is asked again after two minutes, once.
function roundStep(ctx, state, policy, f, war, now) {
  const st = part(state, 'comfort');
  const opts = policy.options || [];
  const head = `comfortpolicy ${policy.everyMinMin}-${policy.everyMaxMin} min`;
  if (!policy.valid) return { notes: [`${head}: the line has an error, so it does nothing`], actions: [], comforts: false };
  if (!opts.length) return { notes: [`${head}: no options, nothing to add to the comforting`], actions: [], comforts: false };
  const what = opts.map((o) => o.type).join(' ');
  // each round draws its own gap to the next one, somewhere in min-max
  const drawGap = () => Math.round((policy.everyMinMin + Math.random() * (policy.everyMaxMin - policy.everyMinMin)) * 60000);

  // a line edited mid-round starts afresh
  if (st.round && st.round.what !== what) delete st.round;
  if (!st.round) {
    // the old comfortpolicy's stamp carries over, so an upgrade does not fire at once
    if (st.next === undefined && n(state.lastComfort)) st.next = n(state.lastComfort) + drawGap();
    if (n(st.next) > now) return { notes: [`${head} ${what}: next round in ${span(n(st.next) - now)}${lastText(st)}`], actions: [], comforts: false };
    st.round = { id: now, what, types: opts.map((o) => o.type), done: {}, gapMs: drawGap() };
  }
  const r = st.round;
  const popNeeded = opts.some((o) => o.type === 'popraise') && f.population !== null && f.limit !== null && f.population < f.limit;
  const notes = [], actions = [];
  let comforts = false;
  opts.forEach((o, i) => {
    const d = r.done[i];
    if (d && d.state !== 'retry') return;
    if (d && d.state === 'retry' && now < n(d.until)) { notes.push(`${o.type}: no reply, asking again in ${span(n(d.until) - now)}`); return; }
    const skip = (why) => { r.done[i] = { state: 'skip', why }; };
    const act = (a, label) => {
      actions.push({ ...a, round: r.id, opt: i, label: `comfortpolicy: ${label}` });
    };
    if (o.type === 'popraise') {
      if (f.population === null || f.limit === null) return skip('population unknown');
      if (!popNeeded) return skip(`not needed, population ${fmt(f.population)} is at its limit`);
      const cost = comfortCost(ctx, 'popraise', f);
      const short = shortOf(cost, f, keptFor(ctx));
      if (short) return skip(`needed, but it costs ${short}`);
      return act({ kind: 'upkeepComfort', type: 'popraise', typeId: PACIFY.popraise },
        `population raising (${fmt(f.population)} of ${fmt(f.limit)}, +${fmt(Math.min(Math.floor(f.limit * 0.05), f.limit - f.population))} for ${costText(cost)})`);
    }
    if (o.kind === 'levy') {
      if (popNeeded) return skip('popraise was needed this round, and a levy only comes when it is not');
      if (war.on) return skip(`not while under attack: a levy costs ${LEVY_LOYALTY_COST} loyalty`);
      if (f.loyalty === null) return skip('loyalty unknown, and a levy costs 20 of it');
      if (f.loyalty - LEVY_LOYALTY_COST < LEVY_FLOOR) return skip(`loyalty ${f.loyalty}: a levy costs ${LEVY_LOYALTY_COST} and may not take it under ${LEVY_FLOOR}`);
      const gets = f.population === null ? '' : ` for about ${fmt(Math.floor(f.population * LEVY_SHARE[o.type]))} ${o.type}`;
      return act({ kind: 'upkeepLevy', type: o.type, typeId: LEVY[o.type] }, `levy ${o.type}${gets} (-${LEVY_LOYALTY_COST} loyalty)`);
    }
    const cost = comfortCost(ctx, o.type, f);
    const short = shortOf(cost, f, keptFor(ctx));
    if (short) return skip(`it costs ${short}`);
    if (o.type === 'pray' || o.type === 'relief') comforts = true;
    return act({ kind: 'upkeepComfort', type: o.type, typeId: PACIFY[o.type] }, `${PACIFY_NAME[o.type]} (every round, costs ${costText(cost)})`);
  });
  const skipped = opts.map((o, i) => (r.done[i] && r.done[i].state === 'skip' ? `${o.type}: ${r.done[i].why}` : null)).filter(Boolean);
  settleRound(st);
  const where = actions.length ? `round due, ${actions.length} to do`
    : st.round ? 'round open' : `round done, next in ${span(n(st.next) - now)}`;
  return { notes: [`${head} ${what}: ${where}`, ...notes, ...skipped], actions, comforts };
}

// Every option tried: the round closes, and the next one comes the round's
// own gap after this moment.
function settleRound(st) {
  const r = st.round;
  if (!r) return;
  for (let i = 0; i < r.types.length; i++) {
    const d = r.done[i];
    if (!d || d.state === 'retry') return;
  }
  st.last = { at: Date.now(), results: r.types.map((type, i) => ({ type, state: r.done[i].state, why: r.done[i].why || null })) };
  st.next = Date.now() + n(r.gapMs);
  delete st.round;
}
// "; last round: popraise refused (Insufficient food)"
function lastText(st) {
  const bad = ((st.last && st.last.results) || []).filter((x) => x.state === 'refused');
  return bad.length ? `; last round: ${bad.map((x) => `${x.type} refused (${x.why})`).join(', ')}` : '';
}

function comfortPlan(ctx, state) {
  const sw = comfortSwitch(ctx.config);
  const policy = (ctx.goals || []).find((g) => g.name === 'comfortpolicy');
  if (!sw.on) {
    if (sw.error) return { note: `comfort: ${sw.error}`, actions: [] };
    return policy ? { note: 'comfortpolicy does nothing while config comfort:0 — it needs comfort on (wiki ComfortPolicy)', actions: [] } : null;
  }
  const f = cityFacts(ctx);
  const now = Date.now();
  const war = policy ? W.underAttack(ctx, state) : { on: false };
  const round = policy ? roundStep(ctx, state, policy, f, war, now) : { notes: [], actions: [], comforts: false };
  const up = upkeepStep(ctx, state, f, round.comforts, now);
  // comfort on only by default, and nothing to do: nothing worth a line every slice
  if (!sw.set && !policy && !up.actions.length && f.loyalty === 100 && !(f.grievance > 0)) return null;
  const notes = [...up.notes, ...round.notes];
  if (!notes.length) return null;
  return { note: `comfort: ${notes.join('; ')}`, actions: [...up.actions, ...round.actions] };
}

// ------------------------------------------------------------------ tax
// The policy in force: a taxpolicy line, or NEAT's default range 0-100 when
// comfort is on without one (wiki Comfort: comforting "adjusts tax rates to
// prevent riots"; TaxPolicy: "The default values are 0 (min) and 100 (max)").
// A taxpolicy line works with comfort off too: it was written to be obeyed.
function taxPolicyOf(ctx) {
  const line = (ctx.goals || []).find((g) => g.name === 'taxpolicy');
  if (line) return line.valid ? { min: line.min, max: line.max, war: line.war, from: 'taxpolicy' } : { invalid: true };
  return comfortSwitch(ctx.config).on ? { min: 0, max: 100, war: null, from: 'comfort' } : null;
}

// The rate the tax should be at, and why. Pure: the tests drive it directly.
//   war    while under attack the war rate, when the line gives one
//   base   a rate set by hand since the goal last looked (kept, "don't fight
//          a manual tax"), else min — inside [min, max] either way
//   gold   when the base rate does not pay the heroes and the bank holds
//          under a day of their salary, the rate that pays them and refills
//          that day within a day, up to max; it stays at the paying rate until
//          two days are banked
function taxTarget(p) {
  const { cur, min, max, war, underAttack, manual, raised, gold, salary, income, population } = p;
  if (war !== null && war !== undefined && underAttack) return { rate: war, raised: false, why: `the war rate while under attack` };
  const base = clamp(manual === null || manual === undefined ? min : manual, min, max);
  const baseWhy = manual === null || manual === undefined ? `the minimum ${min}%` : `the ${base}% set by hand`;
  // gold per point of tax: what this city's income says, else the client's own estimate
  const perPoint = cur > 0 && income > 0 ? income / cur : population > 0 ? population / 100 : 0;
  if (salary === null || salary === undefined || gold === null || gold === undefined) {
    // no gold figures: keep inside the range, and never lower a rate it cannot judge
    const keep = cur === null || cur === undefined ? base : clamp(cur, min, max);
    return { rate: manual === null || manual === undefined ? keep : base, raised: !!raised, why: 'the gold figures are missing' };
  }
  if (salary <= 0 || base * perPoint >= salary) return { rate: base, raised: false, why: `${baseWhy}${salary > 0 ? ' pays the hero salary' : ''}` };
  if (perPoint <= 0) return { rate: base, raised: false, why: 'no population to tax' };
  const hours = gold / salary;
  if (hours < RESERVE_H) {
    const need = salary + (RESERVE_H * salary - gold) / RESERVE_H;
    return { rate: clamp(Math.ceil(need / perPoint), base, max), raised: true,
      why: `gold ${fmt(gold)} is under a day of hero salary (${fmt(salary)}/h)` };
  }
  if (raised && hours < RELEASE_H) {
    return { rate: clamp(Math.ceil(salary / perPoint), base, max), raised: true,
      why: `paying the hero salary until two days of it are banked (${Math.floor(hours)} h now)` };
  }
  return { rate: base, raised: false, why: `${baseWhy}; ${Math.floor(hours)} h of hero salary banked` };
}

function taxPlan(ctx, state) {
  const pol = taxPolicyOf(ctx);
  if (!pol) return null;
  if (pol.invalid) return { note: 'tax: the taxpolicy line has an error, so the tax is left alone', actions: [] };
  const f = cityFacts(ctx);
  if (f.tax === null) return null;                // no bean to judge by
  const st = part(state, 'tax');
  const now = Date.now();
  const sig = `${pol.from}:${pol.min}:${pol.max}:${pol.war}`;
  const cur = f.tax;
  // A rate that moved without this goal moving it was set by hand (a script's
  // tax, the console or the game): kept until the tax settings change. NEAT's
  // settaxrate is overridden by a taxpolicy that disagrees (wiki SetTaxRate);
  // this bot does not fight it.
  if (st.sig !== sig) { st.sig = sig; st.manual = null; st.raised = false; }
  else if (st.seen !== undefined && st.seen !== null && cur !== st.seen && cur !== st.sent) st.manual = cur;
  st.seen = cur;
  if (st.sent === cur) st.sent = null;            // arrived
  const war = W.underAttack(ctx, state);
  // gold the next construction needs is spoken for: it does not pay salaries
  const keep = keptFor(ctx);
  const keptGold = n(keep && keep.gold);
  const gold = f.gold === null ? null : Math.max(0, f.gold - keptGold);
  const t = taxTarget({ cur, min: pol.min, max: pol.max, war: pol.war, underAttack: war.on, manual: st.manual, raised: st.raised,
    gold, salary: f.salary, income: f.income, population: f.population });
  st.raised = t.raised;
  if (t.raised && keptGold) t.why += `, with ${fmt(keptGold)} gold kept for ${keptWhat(keep)}`;
  const range = `${pol.from === 'taxpolicy' ? 'taxpolicy' : 'comfort, taxpolicy default'} ${pol.min}-${pol.max}${pol.war !== null ? `, war ${pol.war}` : ''}`;
  const head = `tax ${cur}% (${range}${st.manual !== null && st.manual !== undefined ? `; ${st.manual}% was set by hand and is kept` : ''})`;
  if (t.rate === cur) return { note: `${head}: holds — ${t.why}`, actions: [] };
  if (st.sent !== null && st.sent !== undefined && now - n(st.sentAt) < TAX_SETTLE_MS) {
    return { note: `${head}: ${st.sent}% sent ${span(now - n(st.sentAt))} ago, waiting for the city to show it`, actions: [] };
  }
  const f0 = heldBack(st, now);
  if (f0) return { note: `${head}: ${t.rate}% ${failText(f0)}`, actions: [] };
  return {
    note: `${head}: to ${t.rate}% — ${t.why}`,
    actions: [{ kind: 'upkeepTax', rate: t.rate, label: `tax ${cur}% -> ${t.rate}% (${t.why})` }],
  };
}

// ------------------------------------------------------------------ healing
// NEAT heals the medic camp unless config nohealing:1 (wiki NoHealing). The
// camp is known from the server's InjuredTroopUpdate pushes (game.injured) and
// read with army.getInjuredTroop once an attack on the city has landed, and
// hourly. The wiki says nothing of attacks: this bot holds the cure while a
// real wave is still marching in, when the healed troops would only meet it,
// and never spends the gold the heroes' next day of salary needs, nor what the
// next construction needs.
function healPlan(ctx, state) {
  const game = ctx.game || {};
  const cid = game.castleId ? Number(game.castleId(ctx.castle)) : null;
  const camp = cid !== null && game.injured ? game.injured[cid] || null : null;
  const wounded = camp ? n(camp.total) : 0;
  if (!W.healingAllowed(ctx)) {
    return wounded > 0 ? { note: `heal: ${fmt(wounded)} wounded left in the medic camp (config nohealing:1)`, actions: [] } : null;
  }
  const st = part(state, 'heal');
  const now = Date.now();
  const war = W.underAttack(ctx, state);
  const f = cityFacts(ctx);
  if (wounded > 0) {
    const need = n(camp.goldNeed);
    const head = `heal: ${fmt(wounded)} wounded in the medic camp, ${fmt(need)} gold to cure`;
    if (war.inbound > 0) return { note: `${head} — held while ${war.inbound} real attack(s) march in`, actions: [] };
    if (f.gold !== null && need > f.gold) return { note: `${head} — the city has ${fmt(f.gold)}`, actions: [] };
    // a day of hero salaries (the rewards keep the same), and the next construction's gold
    const day = f.salary > 0 ? RESERVE_H * f.salary : 0;
    const keep = keptFor(ctx);
    const keptGold = n(keep && keep.gold);
    if (f.gold !== null && (day || keptGold) && f.gold - need < day + keptGold) {
      const what = [day ? `a day of hero salary (${fmt(day)} gold)` : null,
        keptGold ? `${fmt(keptGold)} gold for ${keptWhat(keep)}` : null].filter(Boolean).join(' and ');
      return { note: `${head} — it would leave the city under ${what}`, actions: [] };
    }
    const f0 = heldBack(st, now);
    if (f0) return { note: `${head} — ${failText(f0)}`, actions: [] };
    return { note: head, actions: [{ kind: 'upkeepHeal', goldNeed: need, wounded, label: `heal ${fmt(wounded)} wounded for ${fmt(need)} gold` }] };
  }
  // Look again? A minute after an attack on the city lands (that is what fills
  // the camp), and hourly as a fallback for battles fought while nobody was
  // watching. "Last look" is the latest of our own read and any push. The
  // first fallback look comes an hour after the city is first seen, so a
  // start-up does not spend a slot in every city's first slice, when the
  // backlog is biggest.
  const lastLook = Math.max(n(st.readAt), camp ? n(camp.at) : 0) || null;
  if (lastLook === null && !n(st.firstSeen)) st.firstSeen = now;
  const landedAt = war.sinceEndMs === null || war.sinceEndMs === undefined ? null : now - war.sinceEndMs;
  const afterAttack = landedAt !== null && now - landedAt >= CAMP_AFTER_LANDING_MS && (lastLook === null || landedAt > lastLook);
  const told = n(st.curedAt) && camp && camp.cured ? `cured ${span(now - n(st.curedAt))} ago`
    : lastLook === null ? 'the medic camp has not been looked at yet'
      : `no wounded when last looked, ${span(now - lastLook)} ago`;
  if (war.inbound > 0) return { note: `heal: ${told}; looking again once the attack has landed`, actions: [] };
  const since = lastLook === null ? n(st.firstSeen) : lastLook;
  const due = now - since >= CAMP_READ_MS || afterAttack;
  if (!due) {
    // nothing known and no look due yet: nothing worth a note
    return lastLook === null ? null : { note: `heal: ${told}`, actions: [] };
  }
  const f0 = heldBack(st, now);
  if (f0) return { note: `heal: ${told}; reading the camp was ${failText(f0)}`, actions: [] };
  return { note: `heal: ${told}${afterAttack ? '; an attack has landed since' : ''}`, actions: [{ kind: 'upkeepCamp', label: 'medic camp: look for wounded troops' }] };
}

// ------------------------------------------------------------------ production / warehouse
// Both hold four percentages the server keeps: every half hour, or when the
// line changes, one action reads what the city has and sets it only if it
// differs (wiki Production: "It sets the desired city production"; wiki
// WarehousePolicy: "adjust the amount of resources stored in the warehouse").
const RATE_ORDER = ['food', 'wood', 'stone', 'iron'];
const rateText = (r, words = RATE_ORDER) => RATE_ORDER.map((k, i) => `${words[i]} ${r[k]}%`).join(' ');

function holdPlan(ctx, state, { goal, key, kind, what, words, extra }) {
  const g = (ctx.goals || []).find((x) => x.name === goal);
  if (!g) return null;
  if (!g.valid) return { note: `${key}: the ${goal} line has an error, so nothing is changed`, actions: [] };
  const st = part(state, key);
  const now = Date.now();
  const sig = RATE_ORDER.map((k) => g.rates[k]).join('/');
  const head = `${key} ${rateText(g.rates, words)}`;
  if (extra) { const why = extra(ctx); if (why) return { note: `${head}: ${why}`, actions: [] }; }
  const same = st.sig === sig && n(st.at);
  const was = same && st.had ? `, was ${rateText(st.had, words)}` : '';
  const seen = !same ? 'not checked yet' : st.changed ? `set ${span(now - n(st.at))} ago${was}` : `as wanted ${span(now - n(st.at))} ago`;
  const f0 = heldBack(st, now);
  if (f0) return { note: `${head}: ${failText(f0)}`, actions: [] };
  if (same && now - n(st.at) < CHECK_MS) return { note: `${head}: ${seen}, next look in ${span(n(st.at) + CHECK_MS - now)}`, actions: [] };
  return { note: `${head}: ${seen}`, actions: [{ kind, rates: g.rates, sig, label: `${what} (want ${rateText(g.rates, words)})` }] };
}

const productionPlan = (ctx, state) => holdPlan(ctx, state, {
  goal: 'production', key: 'production', kind: 'upkeepProduction', what: 'production: check the Town Hall labour split',
});

// The warehouse window is a Warehouse's (WareHouseObj.as); a city without one
// has nothing to set.
const warehousePlan = (ctx, state) => holdPlan(ctx, state, {
  goal: 'warehousepolicy', key: 'warehouse', kind: 'upkeepStore', what: 'warehousepolicy: check the warehouse split',
  words: ['food', 'lumber', 'stone', 'iron'],
  extra: (c) => ((c.castle.buildings || []).some((b) => Number(b.typeId) === 3 && n(b.level) > 0) ? null : 'no Warehouse in this city'),
});

// ------------------------------------------------------------------ executors
// A Game wrapper when there is one, else the raw command (a stub has only req).
const call = (game, method, args, cmd, data) => (typeof game[method] === 'function' ? game[method](...args) : game.req(cmd, data));
// What a stale plan asked for may already be moot: the round it belonged to is gone.
const roundOf = (state, a) => { const r = state && state.upkeep && state.upkeep.comfort && state.upkeep.comfort.round; return r && r.id === a.round ? r : null; };

// Stamp what one comfort or levy came to. A lost reply may still have gone
// through: a loyalty comfort then waits its usual gap before the next, and a
// round's option is asked once more, two minutes on.
async function settleOption(state, a, fn) {
  const st = part(state || {}, 'comfort');
  const r = a.round !== undefined ? roundOf(state, a) : null;
  let res;
  try { res = await fn(); } catch (e) {
    if (a.upkeep) { st.upkeepAt = Date.now(); st.upkeepType = a.type; }
    if (r) {
      const tries = n(r.done[a.opt] && r.done[a.opt].tries) + 1;
      r.done[a.opt] = tries >= 2 ? { state: 'refused', why: `no reply (${e.message})` } : { state: 'retry', until: Date.now() + RETRY_MS, tries };
      settleRound(st);
    }
    throw e;
  }
  const ok = res && res.ok === 1;
  if (a.upkeep) {
    if (ok) { st.upkeepAt = Date.now(); st.upkeepType = a.type; }
    noteOutcome(st, res);
  }
  if (r) {
    r.done[a.opt] = { state: ok ? 'ok' : 'refused', why: ok ? null : String((res && res.errorMsg) || `ok=${res && res.ok}`).slice(0, 120) };
    settleRound(st);
  }
  return res;
}

const executors = {
  // interior.pacifyPeople {castleId, typeId}
  upkeepComfort: async (game, castle, a, state) => settleOption(state, a,
    () => call(game, 'pacify', [game.castleId(castle), a.typeId], 'interior.pacifyPeople', { castleId: game.castleId(castle), typeId: a.typeId })),

  // interior.taxation {castleId, typeId}
  upkeepLevy: async (game, castle, a, state) => settleOption(state, a,
    () => call(game, 'levy', [game.castleId(castle), a.typeId], 'interior.taxation', { castleId: game.castleId(castle), typeId: a.typeId })),

  // interior.modifyTaxRate {castleId, tax}. The rate counts as sent before the
  // reply: one that went through with its reply lost must not look like a
  // change made by hand.
  upkeepTax: async (game, castle, a, state) => {
    const st = part(state || {}, 'tax');
    st.sent = a.rate; st.sentAt = Date.now();
    const r = await call(game, 'setTax', [game.castleId(castle), a.rate], 'interior.modifyTaxRate', { castleId: game.castleId(castle), tax: a.rate });
    if (!(r && r.ok === 1)) st.sent = null;
    noteOutcome(st, r);
    return r;
  },

  // army.cureInjuredTroop {castleId}. It heals the whole camp, so an ok empties
  // the game's record of it until the server says otherwise. The client's own
  // gold check is made again here, on the city as it stands now.
  upkeepHeal: async (game, castle, a, state) => {
    const st = part(state || {}, 'heal');
    const cid = game.castleId(castle);
    const gold = cityFacts({ castle }).gold;
    if (gold !== null && gold < n(a.goldNeed)) return { ok: 0, errorMsg: `curing needs ${fmt(a.goldNeed)} gold and the city has ${fmt(gold)}` };
    const r = await call(game, 'cureInjured', [cid], 'army.cureInjuredTroop', { castleId: cid });
    if (r && r.ok === 1) {
      st.curedAt = Date.now();
      game.injured = game.injured || {};
      game.injured[Number(cid)] = { at: st.curedAt, goldNeed: 0, troop: {}, total: 0, cured: true };
    }
    noteOutcome(st, r);
    return r;
  },

  // army.getInjuredTroop {castleId}; what it finds lands in game.injured
  // A read the server answered without a camp push means it has nothing to
  // report there; a push that comes later still replaces this.
  upkeepCamp: async (game, castle, _a, state) => {
    const st = part(state || {}, 'heal');
    const cid = game.castleId(castle);
    const r = typeof game.readInjured === 'function' ? await game.readInjured(cid) : await game.req('army.getInjuredTroop', { castleId: cid });
    if (r && r.ok === 1) {
      st.readAt = Date.now();
      if (!r.camp) {
        game.injured = game.injured || {};
        game.injured[Number(cid)] = { at: st.readAt, goldNeed: 0, troop: {}, total: 0 };
      }
    }
    noteOutcome(st, r);
    return r;
  },

  // interior.getResourceProduceData, then interior.modifyCommenceRate if it differs
  upkeepProduction: async (game, castle, a, state) => {
    const cid = game.castleId(castle);
    const RES = { 1: 'food', 2: 'wood', 3: 'stone', 4: 'iron' };
    return holdExec(state, 'production', a,
      () => call(game, 'productionData', [cid], 'interior.getResourceProduceData', { castleId: cid }),
      (d) => ratesFrom(d && d.resourceProduceDataBean, 'typeid', 'commenceRate', RES),
      () => call(game, 'setProduction', [cid, a.rates], 'interior.modifyCommenceRate',
        { castleId: cid, foodrate: a.rates.food, woodrate: a.rates.wood, stonerate: a.rates.stone, ironrate: a.rates.iron }));
  },

  // city.getStoreList, then city.modifyStorePercent if it differs
  upkeepStore: async (game, castle, a, state) => {
    const cid = game.castleId(castle);
    const RES = { 1: 'food', 2: 'wood', 3: 'stone', 4: 'iron' };
    return holdExec(state, 'warehouse', a,
      () => call(game, 'storeList', [cid], 'city.getStoreList', { castleId: cid }),
      (d) => ratesFrom(d && d.storeBeans, 'storeTypeId', 'storePercent', RES),
      () => call(game, 'setStorePercent', [cid, a.rates], 'city.modifyStorePercent',
        { castleId: cid, foodrate: a.rates.food, woodrate: a.rates.wood, stonerate: a.rates.stone, ironrate: a.rates.iron }));
  },
};

// {food, wood, stone, iron} from a list of beans, or null if any is missing
function ratesFrom(list, idKey, rateKey, RES) {
  const out = {};
  for (const b of Array.isArray(list) ? list : []) {
    const k = RES[Number(b && b[idKey])];
    if (k && val(b[rateKey]) !== null) out[k] = Number(b[rateKey]);
  }
  return RATE_ORDER.every((k) => out[k] !== undefined) ? out : null;
}

// Read, compare, set only what differs. A read the city cannot answer sets
// the goal's split anyway: it is what the line asks for, and asking twice
// changes nothing.
async function holdExec(state, key, a, read, parse, set) {
  const st = part(state || {}, key);
  const d = await read();
  if (!d || d.ok !== 1) { noteOutcome(st, d); return d || { ok: 0, errorMsg: 'no reply' }; }
  const had = parse(d);
  if (had && RATE_ORDER.every((k) => had[k] === a.rates[k])) {
    Object.assign(st, { at: Date.now(), sig: a.sig, had, changed: false });
    noteOutcome(st, d);
    return d;
  }
  const r = await set();
  if (r && r.ok === 1) Object.assign(st, { at: Date.now(), sig: a.sig, had, changed: true });
  noteOutcome(st, r);
  return r;
}

// ------------------------------------------------------------------ describe
// One readable line per goal, for the console (goals.js describe).
function describeGoal(g) {
  if (g.name === 'comfortpolicy') {
    if (!g.valid) return `comfortpolicy: ${g.raw} (has an error, does nothing)`;
    const opts = (g.options || []).map((o) => (o.type === 'popraise' ? 'popraise if needed'
      : o.kind === 'levy' ? `levy ${o.type}${(g.options || []).some((x) => x.type === 'popraise') ? ' when no popraise is needed' : ''}` : o.type));
    return `comfortpolicy: every ${g.everyMinMin}-${g.everyMaxMin} min${opts.length ? `: ${opts.join(', ')}` : ', nothing extra'} (needs config comfort on)`;
  }
  if (g.name === 'taxpolicy') {
    return g.valid ? `taxpolicy: tax held at ${g.min}%, raised up to ${g.max}% when the heroes' gold runs short${g.war !== null ? `, ${g.war}% while under attack` : ''}`
      : `taxpolicy: ${g.raw} (has an error, does nothing)`;
  }
  if (g.name === 'production') return g.valid ? `production: labour held at ${rateText(g.rates)}` : `production: ${g.raw} (has an error, does nothing)`;
  if (g.name === 'warehousepolicy') {
    return g.valid ? `warehousepolicy: protection held at ${rateText(g.rates, ['food', 'lumber', 'stone', 'iron'])}` : `warehousepolicy: ${g.raw} (has an error, does nothing)`;
  }
  return `${g.name}: ${g.raw}`;
}

module.exports = {
  parsers,
  // comfort is not here: the engine plans it in the old comfortpolicy's slot,
  // ahead of defensepolicy (goalmods.comfortPlan)
  plans: { tax: taxPlan, heal: healPlan, production: productionPlan, warehouse: warehousePlan },
  executors,
  configKeys: [],
  comfortPlan,
  describeGoal,
  // for the script commands comfort / levy / healtroops / settaxrate
  PACIFY, LEVY, comfortTypeOf, levyTypeOf,
  // exported for the tests
  _internals: { taxTarget, cityFacts, comfortSwitch, comfortCost, taxPolicyOf, OPTION_WORDS,
    RESERVE_H, RELEASE_H, TAX_SETTLE_MS, UPKEEP_GAP_MS, RETRY_MS, CHECK_MS, CAMP_READ_MS, CAMP_AFTER_LANDING_MS,
    LADDER, LEVY_FLOOR, LEVY_LOYALTY_COST },
};
