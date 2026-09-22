'use strict';
// Goal engine: evaluates standing goals for each city, round-robin, forever.
//
// A goal is an END STATE. Every focus slice we ask each goal "what, if anything,
// should happen right now?" and execute a bounded number of the answers.
const fs = require('fs');
const path = require('path');
const C = require('./constants');
const { Game } = require('./game');
const { parseGoals } = require('./goals');
const { layerNote, runningGoals, getScriptLayer, scriptNote } = require('./goallayers');
const M = require('./goalmods');
const R = require('./rally');
const S = require('./speedups');

// War / hero / NPC / transfer / market / report goals live in their own
// modules, each exporting { parsers, plans, executors }. parsers are merged by
// goals.js; plans and executors are wired here. City upkeep (tax, healing,
// production, warehouse) goes first: its rare, cheap actions come right after
// defensepolicy's.
const MODULES = ['./goal-upkeep', './goal-war', './goal-heroes', './goal-npc', './goal-buildnpc', './goal-valley', './goal-transfer', './goal-trade', './goal-reports', './goal-quests'].map((p) => {
  try { return { name: p, mod: require(p) }; }
  catch (e) { console.error(`goal module ${p} not loaded: ${e.message}`); return null; }
}).filter(Boolean);

// NPC farming asks for research levels before it plans (Engine.accountTechs)
const NPC_MOD = (MODULES.find((m) => m.name === './goal-npc') || {}).mod || null;

// The research goal is planned by focus itself, twice around the builder (see
// there), so it is not one of the MODULES above.
let RS = null;
try { RS = require('./goal-research'); } catch (e) { console.error(`goal module ./goal-research not loaded: ${e.message}`); }

// Step 19: the plan goal's line in work reaches the builder and the research
// goal as a build and a research line of their own (goal-plan.js expand), and
// schedulepolicy / processingpolicy (processing.js) say when a city acts and
// which of its marches goes first.
let PL = null, PR = null;
try { PL = require('./goal-plan'); } catch (e) { console.error(`goal module ./goal-plan not loaded: ${e.message}`); }
try { PR = require('./processing'); } catch (e) { console.error(`goal module ./processing not loaded: ${e.message}`); }

// action.kind -> executor, first module wins
const MODULE_EXECUTORS = {};
for (const { mod } of MODULES) {
  for (const [kind, fn] of Object.entries(mod.executors || {})) {
    if (!MODULE_EXECUTORS[kind]) MODULE_EXECUTORS[kind] = fn;
  }
}

const D = require('./db');
const loadState = (accountId) => D.engineState.load(accountId || '');
const saveState = (s, accountId) => D.engineState.save(s, accountId || '');

// Top-level engine state that is not a city's: the traininghero record
// (goalmods.trainingHeroPlan) and the marker migrateStateKeys leaves. Never
// taken for a city name.
const KEYED_BY = '_keyedBy';
const NOT_CITY_STATE = new Set(['hero', KEYED_BY]);

const n = (x) => Number(x || 0);
const fmt = (x) => Math.round(n(x)).toLocaleString('en-US');

// 90 -> "1m", 5400 -> "1h 30m", 3650400 -> "42d 6h"
function dur(sec) {
  const s = Math.max(0, Math.round(n(sec)));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

const TROOP_BY_TYPE = Object.fromEntries(C.TROOPS.map((t) => [t.typeId, t]));

// OTTO_TROOP_TRACE=1: the troop goal's decisions go to the console's own output
// (console-<id>.log) as well — each city's troop note and what its batches were
// sized from, every batch and mayor change sent, and the traininghero's moves.
// The Engine tab holds them in memory only, behind the login.
const TROOP_TRACE = process.env.OTTO_TROOP_TRACE === '1';
const TROOP_TRACE_LINE = /^(\[plan\] )?(train [\d,]|appoint |move \S+ to |traininghero |lower production|production back|cancel a slow batch)/;
const stamp = () => new Date().toTimeString().slice(0, 8);
function troopTrace(r) {
  const t = r && r.troop;
  if (!t) return;
  const m = r.mayor && r.mayor.note ? ` | ${r.mayor.note}` : '';
  console.log(`[troops ${stamp()}] [${r.city}] ${t.note || ''}${m}${t.diag ? ` | ${JSON.stringify(t.diag)}` : ''}`);
}

// Whether a troop type can be trained here: the game's own Enlist button is
// enabled when every building, research and item its conditionBean lists is met
// (SWTypeUI.onConditionTime -> UIUtil.isConditionMatch, successFlag on each),
// and never looks at the bean's `permition`. The server sends permition false
// for every type, Workers in a level-10 barracks included (seen live on
// Lord02, 2026-09-19), and trusting it stopped all training on every account.
// `lacks` names what is short, for the note.
function troopAllowed(t) {
  const cb = (t && t.conditionBean) || {};
  const lacks = [];
  for (const b of cb.buildings || []) if (!b.successFlag) lacks.push(`${(C.BUILDING_BY_ID[n(b.typeId)] || {}).name || `building ${b.typeId}`} ${n(b.level)}`);
  for (const x of cb.techs || []) if (!x.successFlag) lacks.push(`${(C.TECH_BY_ID[n(x.id)] || {}).name || `research ${x.id}`} ${n(x.level)}`);
  for (const x of cb.items || []) if (!x.successFlag) lacks.push(`item ${x.id}`);
  return { allowed: !lacks.length, ...(lacks.length ? { lacks } : {}) };
}

// Population free to train: what is left once the fields and the construction
// are staffed. The client's enlist screen caps its Max button at exactly this
// (SWEnlist.as), and the server refuses any order above it.
const idleOf = (res) => Math.max(0, n(res && res.curPopulation) - n(res && res.workPeople) - n(res && res.buildPeople));

// ---- the city's buildings, as the client reads them --------------------------
// A finished demolition is pushed as a status-0, level-0 bean
// (UIUtil.isBuildingDestroy); that plot is empty.
const standing = (castle) => ((castle && castle.buildings) || []).filter((b) => !(n(b.status) === 0 && n(b.level) === 0));

// Under construction: status 1 upgrading or 2 demolishing (BuildingConstants),
// the two the client lists in its construction bar (BottomToolBar.refreshBuilding).
// One whose end is well past had its completion push missed and is done.
const UNDERWAY_GRACE = 5 * 60e3;
const underway = (b, now = Date.now()) => (n(b.status) === 1 || n(b.status) === 2)
  && !(n(b.endTime) > 0 && n(b.endTime) < now - UNDERWAY_GRACE);

// A building as it will stand once the work on it is done. The bean keeps its
// CURRENT level until then: an upgrade ends a level up (a new building starts
// at 0), a demolition a level DOWN, and at 0 it is gone. The server takes a
// building down one level per order — "拆除一级", DestrctChoiceWin.as; clearing
// it in one go takes the paid player.destroy.1.a item — and the client's
// construction bar shows the same target (BuildingBar.myBuilding).
const finished = (b) => {
  const s = n(b.status);
  if (s !== 1 && s !== 2) return b;
  return { ...b, status: 0, level: n(b.level) + (s === 1 ? 1 : -1) };
};

const wallsLevel = (castle) => n((standing(castle).find((b) => b.typeId === C.WALLS_TYPE) || {}).level);

// The live building list normally shows the builder is taken before the server
// has to say so. This catches a start whose push has not arrived yet: the
// builder is left alone for a while rather than asked again every tick.
const BUILDER_BUSY = /at a time/i;
const BUILDER_HOLD = 10 * 60e3;

// ---- retry backoff for construction -----------------------------------------
// A wall order against a city with no fortified space left, or an upgrade the
// city can never afford, fails identically every tick. At one tick a minute
// that is ~1,400 doomed commands a night aimed at a server that rate-limits.
//
// Scope is deliberately narrow: buildings and walls only. Those repeat with a
// stable identity and are safe to defer. Training failures are transient
// (resources, queue depth) and marches must never be held back, so neither is
// covered here.
const RETRY_LADDER = [60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3, 4 * 3600e3];

// per-unit training times, re-read at most this often (Engine.readTraining)
const UNIT_TIME_TTL = 10 * 60e3;

// The SWF loads the fortification cost table from an XML at runtime, so it is
// not in the decompiled source and there is no table here to size orders from.
// Instead, learn the limit from the server's own refusal and retry with a
// quantity that fits. The messages carry exact numbers:
//
//   "Remaining fortified space is 2000, 4000 more is needed."
//   "Insufficient idle population, 24580 required."
//   "Insufficient resources. Required Lumber 139300."
//
// Returns a smaller quantity, 0 when nothing fits, or null when the refusal was
// not about quantity at all.
const RES_BY_WORD = {
  lumber: 'wood', wood: 'wood', food: 'food', stone: 'stone', iron: 'iron', gold: 'gold',
};

function fitFromError(num, msg, res) {
  const m = String(msg || '');
  const num0 = (x) => Number(String(x).replace(/,/g, '')) || 0;

  const space = m.match(/space is\s+([\d,]+)\s*,\s*([\d,]+)\s+more/i);
  if (space) {
    const have = num0(space[1]);
    const total = have + num0(space[2]);     // "N more is needed" is the shortfall
    return total > 0 ? Math.floor((num * have) / total) : 0;
  }

  const pop = m.match(/idle population\D*([\d,]+)\s*required/i);
  if (pop) {
    const total = num0(pop[1]);
    return total > 0 ? Math.floor((num * idleOf(res)) / total) : 0;
  }

  const need = m.match(/Required\s+([A-Za-z]+)\s+([\d,]+)/i);
  if (need) {
    const key = RES_BY_WORD[need[1].toLowerCase()];
    if (!key) return null;
    const bank = res && res[key];
    const have = n(bank && typeof bank === 'object' ? bank.amount : bank);
    const total = num0(need[2]);
    return total > 0 ? Math.floor((num * have) / total) : 0;
  }

  return null;
}

function blocked(cityState, key) {
  const f = (cityState.failures || {})[key];
  return !!(f && Date.now() < f.until);
}

function blockedFor(cityState, key) {
  const f = (cityState.failures || {})[key];
  if (!f) return '';
  const mins = Math.max(1, Math.round((f.until - Date.now()) / 60000));
  return `${f.msg || 'kept failing'} (retry in ${mins}m, ${f.n} attempt(s))`;
}

function recordResult(cityState, key, ok, msg) {
  const fails = (cityState.failures = cityState.failures || {});
  if (ok) { delete fails[key]; return; }
  const f = fails[key] || { n: 0 };
  f.n++;
  f.until = Date.now() + RETRY_LADDER[Math.min(f.n - 1, RETRY_LADDER.length - 1)];
  f.msg = String(msg || '').slice(0, 120);
  fails[key] = f;
  // never let this grow without bound
  const keys = Object.keys(fails);
  if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete fails[k];
}

// Place an order; if the server refuses it for quantity (idle population,
// fortified space, resources), place the largest quantity that does fit rather
// than losing the tick. The city is read after the refusal, so the fit uses
// whatever the server has pushed since the plan was made.
async function orderFitted(send, num, castle, what, acted) {
  let r = await send(num);
  if (r.ok !== 1) {
    const fits = fitFromError(num, r.errorMsg, castle.resource || {});
    if (fits > 0 && fits < num) {
      acted.push(`${what(num)} -> only ${fmt(fits)} fit, retrying`);
      num = fits;
      r = await send(num);
    }
  }
  acted.push(`${what(num)} -> ${r.ok === 1 ? 'ok' : (r.errorMsg || 'ok=' + r.ok)}`);
  return r;
}

// ---------------------------------------------------------------- troop ladder
// Stages are attempted in order. If an EARLIER stage is no longer satisfied
// (losses, disbanding), we drop back to it -- per the wiki's described behaviour.
//
// ctx.training (Engine.readTraining) is what the barracks already hold and how
// fast this city trains. Without it (the pure tests) orders are sized from
// population and resources alone.
//
// NEAT's troop settings (wiki Troop and the pages it names). Each is a config
// key, and a troop line's switch overrides it for that line alone (wiki Troop:
// "If no switches are specified, the bot will use the configured goals for all
// troops, or the default settings if both are lacking"):
//   troopqueuetime / queuetime    hours of work per batch, "each slot in each
//                                 barrack" (TroopQueueTime). config troopslot and
//                                 /slot are the same in minutes, and still work.
//   troopincrement / increment    0: the line left to right, each type in full
//                                 before the next; a share (0.01) or a number
//                                 (500): that much of each type in turn, round
//                                 and round; 1: ratio mode (TroopIncrement)
//   troopidlequeuetime / idlequeuetime  minutes a batch may run over the
//                                 traininghero's time while it is away
//   troopsusereserved / usereserved  how much of the day of food kept for the
//                                 troops' upkeep training may spend
//   troopsusepopmax / usepopmax   how much of the whole population training may
//                                 take, freeing workers from the fields for it
//   reservedbarrack, troopdelbadque  config only
// And one of ours, which NEAT has no equal of:
//   trooptraineronly / traineronly  1 (the default): while the traininghero is
//                                 away, only troops the hero here builds
//                                 instantly are queued, so the barracks' slots
//                                 are all free when the traininghero arrives.
//                                 0 goes back to NEAT's troopidlequeuetime rule.
// All of it is worked out by troopSettings below.
//
// Queue time: the Troop page says 30 minutes by default, the TroopQueueTime page
// 15. The Troop page is the goal's own and 30 is what this bot has always used,
// so 30 stays.
const DEFAULT_SLOT_MIN = 30;
// Training is instant once a troop takes under a second (EVONY-RULES.md §5, the
// user's insta-hero levels). The server's per-unit time is a fraction then
// (conditionBean.time is a Number), and batches of 30 minutes' worth would cap
// an insta hero at ~2,000 troops a batch where it can take the whole population.
const INSTANT_SEC = 1;
const instant = (unit) => !!unit && Number.isFinite(Number(unit.time)) && Number(unit.time) < INSTANT_SEC;
// wiki WallQueueTime: "If this is not set, the bot defaults to 15-minute queue times."
const DEFAULT_WALL_MIN = 15;
// wiki TroopsUseReserved, FortsUseReserved: "By default, the bot will attempt to
// keep 1 day of food in each city. The bot will not queue troops if doing so
// would bring it under this amount of days."
const FOOD_DAY_HOURS = 24;
// Training fills the barracks, NEAT's way: every free slot in every barracks
// takes a batch of queue-time length (TroopQueueTime), and the traininghero
// may be in a city for a single slice (a stay of 30-60 s) to do it. So batches
// have their own allowance each slice, outside the three actions every other
// goal shares, and this bounds the burst of commands.
const TROOP_ORDERS = 20;
// wiki TroopDelBadQue: a batch is "bad" when it "is not an optimal time to
// completion" — queued by hand, or through lag by the wrong mayor. Only a
// clearly slow one is cancelled: half as long again as the city's training hero
// takes, and 5 minutes more in all (never less than troopidlequeuetime allows,
// since "the bot won't cancel idle queues as bad queues", wiki FAQ). A cancel is
// not free — the FAQ calls a cancel loop "a terrible waste of resources" — so
// one a slice at most, only while that hero is mayor (the replacement is then
// really faster), and a troop type is not cancelled again for an hour. The batch
// in training is left alone: its time is already spent.
const BAD_QUEUE_SLOWER = 1.5;
const BAD_QUEUE_SLACK_SEC = 300;
const BAD_QUEUE_HOLD = 60 * 60e3;
// Ratio mode's smallest step for a type: 1% of its target, so the types take
// turns in batches worth placing rather than single troops. The wiki gives none.
const RATIO_STEP = 0.01;
// Per-hero training times kept per city (troopMemory) are trusted this long.
const HERO_TIMES_TTL = 24 * 3600e3;
const RES_KEYS = ['food', 'wood', 'stone', 'iron'];

// A setting as a number, or null when it is not set (or unreadable).
const setting = (v) => (v === undefined || v === null || v === '' || v === true || !Number.isFinite(Number(v)) ? null : Number(v));
const share = (v) => Math.min(1, Math.max(0, v));

// The settings a troop stage trains by: its own switches, then the config, then
// NEAT's defaults (wiki Troop: "Default queue time is 30 minutes, default idle
// queue time is 1 minute, default usepopmax is 0 (use only idle pop), default
// usereserved is 0 (it won't go below the reserved amounts), and default
// increment is 0 (off)"). The idle queue time is 0 outside ratio mode and 1 in
// it (wiki TroopIdleQueueTime; FAQ: "If you have config troopincrement:1 the bot
// will automatically enable config troopidlequeuetime:1 as well").
function troopSettings(stage, config = {}) {
  const sw = (stage && stage.switches) || {};
  const cfg = config || {};
  const first = (...vals) => { for (const v of vals) { const x = setting(v); if (x !== null) return x; } return null; };
  const q = first(sw.queuetime), sl = first(sw.slot), cq = first(cfg.troopqueuetime), cs = first(cfg.troopslot);
  const slot = q !== null ? { sec: q * 3600, from: '/queuetime' }
    : sl !== null ? { sec: sl * 60, from: '/slot' }
      : cq !== null ? { sec: cq * 3600, from: 'config troopqueuetime' }
        : cs !== null ? { sec: cs * 60, from: 'config troopslot' }
          : { sec: DEFAULT_SLOT_MIN * 60, from: null };
  const increment = Math.max(0, first(sw.increment, cfg.troopincrement) ?? 0);
  const ratio = increment === 1;
  return {
    slotSec: Math.max(0, slot.sec), slotFrom: slot.from,
    increment, ratio,
    idleMin: Math.max(0, first(sw.idlequeuetime, cfg.troopidlequeuetime) ?? (ratio ? 1 : 0)),
    useReserved: share(first(sw.usereserved, cfg.troopsusereserved) ?? 0),
    usePopMax: share(first(sw.usepopmax, cfg.troopsusepopmax) ?? 0),
    reservedBarrack: first(cfg.reservedbarrack) === 1,
    delBadQue: first(cfg.troopdelbadque) === 1,
    // ours: with a traininghero named, only it fills the barracks, unless the
    // hero here builds the type instantly (see paceOf). 0 gives NEAT's rule back.
    trainerOnly: (first(sw.traineronly, cfg.trooptraineronly) ?? 1) === 1,
  };
}

// Food the city's troops eat an hour: the server's own figure (the castle's
// resource.troopCostFood, which the client takes off the food rate,
// CastleInfoFrame.as:2113, Context.as:447), else worked out from the troops at
// home. Troops still in the barracks queue eat once they are out, so they count
// as well, at the upkeep constants.js lists (the larger of the two figures the
// game data gives, so the reserve errs on the safe side).
function upkeepPerHour(ctx) {
  const castle = (ctx && ctx.castle) || {};
  let per = setting((castle.resource || {}).troopCostFood);
  if (per === null) {
    per = 0;
    for (const [k, v] of Object.entries(castle.troop || {})) per += n(v) * n((C.BY_KEY[k] || {}).food);
  }
  for (const b of (ctx && ctx.training && ctx.training.barracks) || []) {
    for (const it of b.items || []) per += n(it.num) * n((TROOP_BY_TYPE[it.type] || {}).food);
  }
  return per;
}

// What the engine remembers per city for the troop goal (cityState.troopGoal):
//   times    hero name (lower case) -> {at, unit: {typeId: seconds}}: how fast
//            each hero trained here when it was mayor (noteHeroTimes), so the
//            traininghero's speed is known while it is away
//   badHold  troop typeId -> ms: no bad-queue cancel of that type until then
//   restore  {food, wood, stone, iron, at}: production rates lowered for
//            troopsusepopmax and not yet put back
function troopMemory(cityState) {
  const m = (cityState.troopGoal = cityState.troopGoal || {});
  m.times = m.times || {};
  m.badHold = m.badHold || {};
  return m;
}

function heroTimesOf(mem, name) {
  const t = mem && mem.times && name ? mem.times[String(name).toLowerCase()] : null;
  return t && Date.now() - n(t.at) < HERO_TIMES_TTL ? t : null;
}

// Keep how fast this city trains under `heroName` (the mayor the read was made
// under). The eight heroes seen last are kept.
function noteHeroTimes(cityState, heroName, tr) {
  if (!heroName || !tr || tr.error || !tr.unit || !Object.keys(tr.unit).length) return;
  const mem = troopMemory(cityState);
  const unit = {};
  for (const [id, u] of Object.entries(tr.unit)) if (u && u.time !== null && u.time !== undefined) unit[id] = n(u.time);
  mem.times[String(heroName).toLowerCase()] = { at: Date.now(), unit };
  const names = Object.keys(mem.times).sort((a, b) => n(mem.times[b].at) - n(mem.times[a].at));
  for (const k of names.slice(8)) delete mem.times[k];
}

// The traininghero this city's goals name (wiki TrainingHero), whether it is at
// home here, the hero wherever it is, and how fast it trained here. null
// without a traininghero line: then "the best available attack score hero in
// that city will be used as the traininghero".
function trainerOf(game, castle, goals, cityState = {}) {
  const line = (goals || []).find((x) => x.name === 'traininghero' && x.hero);
  if (!line) return null;
  const key = String(line.hero).toLowerCase();
  const named = (h) => String((h && h.name) || '').toLowerCase() === key;
  const here = ((castle && castle.heros) || []).find(named) || null;
  let hero = here;
  for (const c of (!hero && game && game.castles) || []) { hero = (c.heros || []).find(named) || null; if (hero) break; }
  return {
    name: line.hero, hero,
    present: !!(here && (n(here.status) === 0 || n(here.status) === 1)),
    times: heroTimesOf(cityState.troopGoal, key),
  };
}

// The heroes at home (idle, or the mayor), and the best attack hero of them:
// the one the mayor plan appoints to train (goalmods.mayorPlan).
const atHome =(castle) => ((castle && castle.heros) || []).filter((h) => n(h.status) === 0 || n(h.status) === 1);
const bestAttack = (castle) => atHome(castle).sort((a, b) => n(b.power) - n(a.power))[0] || null;

// Which of our marches are a city's troops. One that left from the city is
// still its own, going, coming back or camped (outward). One aimed at it from
// elsewhere only adds to it when it's a reinforcement on its way in (inward).
// A transport drops its load and takes the transporters home, so 12,657
// transporters bringing resources to Flat never became Flat's.
function cityMarches(fieldId, selfArmies) {
  const outward = {}, inward = {};
  for (const a of (fieldId === undefined || fieldId === null ? [] : selfArmies || [])) {
    const bean = a.raw || a;         // the engine's own list wraps the ArmyBean
    const bucket = Number(bean.startFieldId) === Number(fieldId) ? outward
      : Number(bean.targetFieldId) === Number(fieldId) && Number(bean.missionType) === C.MISSION.reinforce
        && Number(bean.direction) !== 2 ? inward : null;   // ArmyConstants.as: 2 = heading back
    if (!bucket) continue;
    for (const [k, v] of Object.entries(bean.troop || bean.troops || {})) {
      const x = Number(v);
      if (Number.isFinite(x) && x > 0) bucket[k] = (bucket[k] || 0) + x;
    }
  }
  return { outward, inward };
}

function troopPlan(ctx) {
  const stages = ctx.goals.filter((g) => g.name === 'troop');
  if (!stages.length) return null;
  if (ctx.config.troop === 0) return { note: 'troop building disabled by config troop:0' };

  // Queued troops count toward the target: they are paid for and on their way.
  // Counting only the ones at home re-ordered the same shortfall every tick, and
  // a b:5k,t:5k stage ended up with 2 x 4,916 ballista and 4 x 5,000
  // transporters in the queue.
  const tr = ctx.training || null;
  const queued = {};
  for (const b of (tr && tr.barracks) || []) {
    for (const it of b.items) {
      const t = TROOP_BY_TYPE[it.type];
      if (t) queued[t.key] = (queued[t.key] || 0) + it.num;
    }
  }
  const home = ctx.castle.troop || {};
  const queuedTotal = Object.values(queued).reduce((s, v) => s + v, 0);
  const inQueue = queuedTotal ? `; ${fmt(queuedTotal)} in the barracks queue` : '';

  // Troops out on a march from this city are still this city's, going or
  // coming back. Counting only the ones at home held a b:5k,t:5k stage open
  // with 6,352 ballista owned: NPC farming had 1,650 in the field, the 4,702
  // left read as short, and the ladder never reached its next stage.
  // Reinforcements on their way in count too; transports aimed here don't.
  const { outward: marching, inward } = cityMarches(ctx.castle.fieldId, ctx.selfArmies);
  const marchingTotal = Object.values(marching).reduce((s, v) => s + v, 0);
  const inwardTotal = Object.values(inward).reduce((s, v) => s + v, 0);
  const onMarch = (marchingTotal ? `; ${fmt(marchingTotal)} out on marches` : '')
    + (inwardTotal ? `; ${fmt(inwardTotal)} reinforcing on the way in` : '');

  let active = null, index = 0;
  for (let i = 0; i < stages.length; i++) {
    const missing = {};
    let short = false;
    for (const [key, want] of Object.entries(stages[i].troops)) {
      const deficit = want - n(home[key]) - n(queued[key]) - n(marching[key]) - n(inward[key]);
      if (deficit > 0) { missing[key] = deficit; short = true; }
    }
    if (short) { active = { stage: stages[i], missing }; index = i; break; }
  }
  if (!active) return { done: true, note: `all ${stages.length} troop stage(s) satisfied${inQueue}${onMarch}` };

  const base = {
    stageIndex: index + 1, stageCount: stages.length,
    targets: active.stage.troops,          // what THIS stage is working toward
    missing: active.missing,
  };
  // how long the shortfall takes at today's speed, e.g. "ballista 4,916 (~42d 5h)"
  const eta = (key, v) => {
    const u = tr && tr.unit[(C.BY_KEY[key] || {}).typeId];
    return u && u.time > 0 ? ` (~${dur(v * u.time)})` : '';
  };
  const head = `stage ${index + 1}/${stages.length}: short ${Object.entries(active.missing).map(([k, v]) => `${k} ${fmt(v)}${eta(k, v)}`).join(', ')}${inQueue}${onMarch}`;
  if (tr && tr.error) return { ...base, orders: [], note: `${head}; not training: ${tr.error}` };

  const s = troopSettings(active.stage, ctx.config);
  const mem = ctx.troopMemory || null;
  const res = ctx.castle.resource || {};

  // Population. The server trains from IDLE population only and refuses an
  // order above it outright ("Insufficient idle population, 24580 required")
  // rather than trimming it, so orders once sized against the whole population
  // all failed. By default only idle population is used (wiki Troop: "default
  // usepopmax is 0 (use only idle pop)"). troopsusepopmax lets training take up
  // to that share of the whole population "by dropping production temporarily"
  // (wiki TroopsUsePopMax; Production: "Troop production may adjust production
  // rates down temporarily"): the field workers the batches need are freed by
  // lowering the Town Hall's production rates while they are placed, and the
  // rates go back straight after (Engine.runTroops). Builders are never taken.
  const idle = idleOf(res);
  const whole = Math.max(0, n(res.curPopulation) - n(res.buildPeople));
  const popBudget = s.usePopMax > 0
    ? Math.max(idle, Math.min(whole, Math.floor(s.usePopMax * n(res.curPopulation)))) : idle;

  // Each batch is sized to train in about the queue time. A batch's time is
  // fixed when it is queued, so one giant batch holds the barracks for weeks at
  // whatever speed the city had then (4,916 ballista: 42 days), with its
  // population and resources locked up the whole time. Short batches keep the
  // queue turning and each one trains at the mayor and research of its moment.
  // A queue time of 0 lifts the cap: batches as big as population and resources allow.
  const slotSec = s.slotSec;

  // A barracks holds as many batches as its level, one of them training
  // (Barrack.as: "waiting queue: remain / level - producing"). One with nothing
  // queued at all is idle.
  const bars = tr ? tr.barracks.map((b) => ({ positionId: b.positionId, capacity: b.capacity, free: b.capacity - b.items.length, idle: !b.items.length })) : null;
  const notes = [];

  // wiki ReservedBarrack: "reserve 1 barrack in the city free of queues to use
  // to build instant troops and to build the first of your Troop goal lines when
  // under attack". The one kept is an empty barracks if there is one, the
  // highest of those. Under attack (goal-war's under-attack window) it takes the
  // first line's shortfall, and nothing else.
  if (s.reservedBarrack && bars && bars.length) {
    const kept = bars.slice().sort((a, b) => (b.idle - a.idle) || (b.capacity - a.capacity) || (a.positionId - b.positionId))[0];
    const war = !!(ctx.underAttack && ctx.underAttack.on);
    if (war && index === 0) notes.push(`under attack: the reserved barracks (plot ${kept.positionId}) trains stage 1 too`);
    else {
      kept.free = 0;
      notes.push(`the barracks on plot ${kept.positionId} is kept free (reservedbarrack)${war ? '; under attack, but stage 1 is complete' : ''}`);
    }
  }

  const orders = [], cannot = [], waits = [];
  // Step 11: the construction the builder takes on next — placed this slice
  // after the batches, or waited for — keeps its cost in the bank
  // (ctx.buildReserve, Engine.resolveBuild). Batches used to be sized from the
  // whole bank first, so a troop ladder could spend what the next building
  // needed and hold construction up for good.
  const reserve = ctx.buildReserve || null;
  let popLeft = Math.max(0, popBudget - n(reserve && reserve.population)), held = '';
  // Resources are a SHARED, running budget, exactly like population. Sizing each
  // troop type against the full untouched pool means the first order drains the
  // bank and every later one is rejected outright ("Insufficient resources.
  // Required Lumber 139300") instead of being trimmed to what is left.
  const pool = {
    food: n(res.food && res.food.amount),
    wood: n(res.wood && res.wood.amount),
    stone: n(res.stone && res.stone.amount),
    iron: n(res.iron && res.iron.amount),
  };
  if (reserve) for (const k of RES_KEYS) pool[k] = Math.max(0, pool[k] - n(reserve[k]));
  // wiki TroopsUseReserved: a day of the troops' upkeep stays in the granary
  // unless /usereserved (config troopsusereserved) lets training spend that
  // share of it: 0.5 keeps half a day, 1 keeps none. The troops being ordered
  // eat once they are out, so each one also keeps its own day of upkeep back —
  // "The bot will not queue troops if doing so would bring it under this amount
  // of days." The construction's food (above) is kept on top of it.
  const keepShare = 1 - s.useReserved;
  const foodKept = keepShare * FOOD_DAY_HOURS * upkeepPerHour(ctx);
  pool.food -= foodKept;
  const costEach = (t, k) => n(t.cost[k]) + (k === 'food' ? keepShare * FOOD_DAY_HOURS * n(t.food) : 0);

  // While the traininghero is set but away, who may fill the barracks.
  //
  // OURS (config trooptraineronly, /traineronly, ON by default). The barracks
  // hold as many batches as the barracks' level, and a batch queued by another
  // hero holds its slot for the whole queue time. So a city that fills nine
  // slots with 30-minute batches has nothing free when the training hero comes
  // round, and the one hero that could have put the whole city's population in
  // at once trains nothing (the user, 2026-09-22). With a traininghero named,
  // only it trains — EXCEPT a type the hero here builds INSTANTLY (under a
  // second each), which finishes as it is placed and never holds a slot.
  // A hero that has never been mayor here and is at least as strong as the
  // traininghero is let through once, so its speed here is measured rather than
  // guessed (items are not in `power`); after that its measured time decides.
  //
  // NEAT (trooptraineronly:0, wiki TroopIdleQueueTime): a troop type the best
  // hero here trains as fast as the traininghero is trained in full ("it will
  // do the full amount with the available hero rather than building small
  // amounts or waiting"). A type it trains slower goes in small batches, only
  // into idle barracks, each no more than troopidlequeuetime minutes longer than
  // the traininghero would take; with 0 (the default outside ratio mode) that
  // type waits for the traininghero. Its speed is what it trained at here as
  // mayor (troopMemory); until it has been, a hero here with at least its attack
  // counts as as fast, and otherwise the type waits for it.
  const trainer = ctx.trainer || null;
  const away = !!(trainer && trainer.hero && !trainer.present);
  const best = bestAttack(ctx.castle);
  const mayor = atHome(ctx.castle).find((h) => n(h.status) === 1) || null;
  // the best hero's time: this read's when it is mayor, else as it last trained
  // here, else the mayor's own — an upper bound, as attack only shortens it
  const bestIsMayor = !!(best && mayor && mayor.id === best.id);
  const bestTimes = best && !bestIsMayor ? heroTimesOf(mem, best.name) : null;
  // What the best hero here takes for one, as far as this city knows:
  //   known  its own measured time (this read's while it is mayor), else null
  //   upper  that, else the sitting mayor's — never under the best hero's own
  const timesHere = (t, unit) => {
    const read = unit && unit.time !== undefined && unit.time !== null ? n(unit.time) : null;
    const own = bestTimes ? bestTimes.unit[t.typeId] : undefined;
    const known = bestIsMayor ? read : (own !== undefined && own !== null ? n(own) : null);
    return { known, upper: known !== null ? known : read };
  };
  const paceOf = (t, unit) => {
    if (!away) return { mode: 'normal' };
    if (s.trainerOnly) {
      const { known, upper } = timesHere(t, unit);
      if (upper !== null && upper < INSTANT_SEC) return { mode: 'normal' };
      if (known === null && best && n(best.power) >= n(trainer.hero.power)) return { mode: 'normal' };
      return { mode: 'wait', why: best ? `${best.name} does not build them instantly` : 'no hero here to build them instantly' };
    }
    const tt = trainer.times ? trainer.times.unit[t.typeId] : undefined;
    if (tt === undefined || tt === null) {
      if (best && n(best.power) >= n(trainer.hero.power)) return { mode: 'normal' };
      return { mode: 'wait', why: `its speed here is not known yet` };
    }
    const bt = n(timesHere(t, unit).upper);      // no read at all: 0, as before
    if (bt <= n(tt)) return { mode: 'normal' };
    if (s.idleMin <= 0) return { mode: 'wait', why: 'troopidlequeuetime 0' };
    const cap = Math.floor((s.idleMin * 60) / (bt - n(tt)));
    if (cap < 1) return { mode: 'wait', why: `even one would take over ${s.idleMin} min longer` };
    return { mode: 'idle', cap };
  };

  const left = { ...active.missing };
  const blocked = {};
  let allowance = TROOP_ORDERS;
  const pickBar = (idleOnly) => bars && bars.filter((b) => b.free > 0 && (!idleOnly || (b.idle && !b.taken)))
    .sort((a, b) => b.free - a.free)[0];
  // One batch of a type, `want` at most, into the barracks with the most room.
  // False when the type can take none now; it is then left for this slice.
  const place = (key, want) => {
    const t = C.BY_KEY[key];
    const unit = tr ? tr.unit[t.typeId] : null;
    const pace = paceOf(t, unit);
    if (pace.mode === 'wait') { blocked[key] = true; waits.push(`${t.name} (${pace.why})`); return false; }
    const bar = pickBar(pace.mode === 'idle');
    if (bars && !bar) {
      blocked[key] = true;
      held = held || (pace.mode === 'idle' ? `an idle barracks for ${t.name}` : 'a free barracks queue slot');
      return false;
    }
    const byPop = t.pop > 0 ? Math.floor(popLeft / t.pop) : want;
    let byRes = Infinity, short = null;
    for (const k of RES_KEYS) {
      const each = costEach(t, k);
      if (each > 0 && Math.floor(pool[k] / each) < byRes) { byRes = Math.floor(pool[k] / each); short = k; }
    }
    // a troop slower than the whole slot still trains, one at a time. An
    // instant one (under a second each: the insta hero as mayor, EVONY-RULES §5)
    // has no batch length to keep to: the whole population goes in one batch.
    const byTime = unit && !instant(unit) && slotSec > 0 ? Math.max(1, Math.floor(slotSec / unit.time)) : Infinity;
    const num = Math.max(0, Math.min(want, byPop, byRes, byTime, pace.cap === undefined ? Infinity : pace.cap));
    if (num <= 0) {
      blocked[key] = true;
      held = held || (byPop < 1 ? `${s.usePopMax > 0 ? 'population' : 'idle population'} (${fmt(popLeft)})`
        : short === 'food' && foodKept > 0 ? `food (${fmt(foodKept)} is kept for a day of the troops' upkeep)` : 'resources');
      return false;
    }
    orders.push({ troop: t, num, positionId: bar ? bar.positionId : undefined, secs: unit ? num * unit.time : null,
      ...(pace.mode === 'idle' ? { idle: true } : {}) });
    // An instant batch is done the moment it is placed, so its slot is free
    // again for the next. Counting it as taken left 6 of city 7's 10 slots
    // empty after OTTO went on (Lord02, 2026-09-19: six instant types, then
    // only four 30-minute batches of cataphracts).
    if (bar && !instant(unit)) { bar.free--; bar.taken = true; }
    popLeft -= num * t.pop;
    for (const k of RES_KEYS) pool[k] -= num * costEach(t, k);
    left[key] -= num;
    allowance--;
    return true;
  };

  // The types to train, in the order the line lists them.
  const types = [];
  for (const key of Object.keys(active.missing)) {
    const t = C.BY_KEY[key];
    if (!t) continue;
    const unit = tr ? tr.unit[t.typeId] : null;
    if (tr && !(unit && unit.allowed)) { cannot.push(unit && unit.lacks ? `${t.name} (needs ${unit.lacks.join(', ')})` : t.name); continue; }
    types.push(key);
  }
  const target = active.stage.troops;
  if (s.ratio) {
    // wiki TroopIncrement, ratio mode (troopincrement:1): all the line's types
    // together, each kept at the same share of its target: "all troops must be
    // at an equal percentage of total completion, or it will focus on the
    // troop(s) that are below that average percentage". The furthest behind
    // goes first, up to the next one's share (or a step past its own).
    const ranked = Object.keys(target).filter((k) => n(target[k]) > 0 && C.BY_KEY[k]
      && !(tr && !(tr.unit[C.BY_KEY[k].typeId] || {}).allowed));
    const pct = (k) => Math.min(1, (n(target[k]) - n(left[k])) / n(target[k]));
    while (allowance > 0 && ranked.length) {
      const avg = ranked.reduce((sum, k) => sum + pct(k), 0) / ranked.length;
      const cand = types.filter((k) => left[k] > 0 && !blocked[k] && pct(k) <= avg + 1e-9).sort((a, b) => pct(a) - pct(b));
      if (!cand.length) break;
      const k = cand[0];
      const above = ranked.map(pct).filter((p) => p > pct(k) + 1e-9);
      const level = Math.min(1, Math.max(above.length ? Math.min(...above) : 0, pct(k) + RATIO_STEP));
      // (the small epsilon keeps 0.06 x 1,000,000 from rounding up to 60,001)
      place(k, Math.min(left[k], Math.max(1, Math.ceil(level * target[k] - (target[k] - left[k]) - 1e-6))));
    }
  } else if (s.increment > 0) {
    // wiki TroopIncrement: "queue 1000 warriors (1% of 100000) and then queue
    // 1000 scouts (1%), continuing down the line until it runs out of resources,
    // population, open barracks, or troops to queue, and then restarting at the
    // beginning of the line". A whole number is that many of each.
    const stepOf = (k) => (s.increment < 1 ? Math.max(1, Math.round(s.increment * target[k])) : Math.floor(s.increment));
    for (let progress = true; progress && allowance > 0;) {
      progress = false;
      for (const k of types) {
        if (allowance <= 0) break;
        if (left[k] > 0 && !blocked[k] && place(k, Math.min(stepOf(k), left[k]))) progress = true;
      }
    }
  } else {
    // wiki TroopIncrement: "The bot will first train 100k warriors, then 100k
    // scouts, and so on": each type fills the free slots before the next gets
    // any. A type that can take nothing now leaves them to the next.
    for (const k of types) while (left[k] > 0 && !blocked[k] && allowance > 0) place(k, left[k]);
  }

  // wiki TroopDelBadQue: config troopdelbadque:1 cancels a waiting batch that
  // is far slower than the city's training hero makes them (BAD_QUEUE_*). That
  // hero is the one the mayor plan appoints to train, the best attack hero at
  // home (goalmods.mayorPlan) — the traininghero, when it is here and the best.
  let cancel = null;
  if (s.delBadQue && tr) {
    const trainsWith = best;
    if (!mayor || !trainsWith || mayor.id !== trainsWith.id) {
      notes.push(`troopdelbadque: slow batches are looked for while ${trainsWith ? trainsWith.name : 'the training hero'} is mayor`);
    } else {
      const hold = (mem && mem.badHold) || {};
      const slack = Math.max(BAD_QUEUE_SLACK_SEC, s.idleMin * 60);
      for (const b of tr.barracks) {
        b.items.forEach((it, i) => {
          const u = tr.unit[it.type];
          // the first batch is the one in training
          if (i === 0 || !u || it.queueId === null || it.queueId === undefined || !(n(it.num) > 0) || !(n(it.costTime) > 0)) return;
          if (n(hold[it.type]) > Date.now()) return;
          const waste = n(it.costTime) - n(it.num) * n(u.time);
          if (n(it.costTime) / n(it.num) > n(u.time) * BAD_QUEUE_SLOWER && waste > slack && (!cancel || waste > cancel.waste)) {
            const t = TROOP_BY_TYPE[it.type];
            cancel = {
              positionId: b.positionId, queueId: it.queueId, type: it.type, num: it.num, waste,
              label: `cancel a slow batch: ${fmt(it.num)} ${t ? t.name : `troops of type ${it.type}`} in the barracks on plot ${b.positionId} `
                + `(${dur(it.costTime)} queued, ${dur(n(it.num) * n(u.time))} with ${mayor.name})`,
            };
          }
        });
      }
    }
  }

  // The field workers the batches take beyond the idle population, freed by
  // lowering production while they are placed (troopsusepopmax).
  const popUsed = orders.reduce((sum, o) => sum + o.num * o.troop.pop, 0);
  const workers = popUsed - Math.max(0, idle - n(reserve && reserve.population));
  const popmax = s.usePopMax > 0 && workers > 0 ? { workers, share: s.usePopMax } : null;

  let note = head;
  if (cannot.length) note += `; not trainable here yet: ${cannot.join(', ')}`;
  if (waits.length) {
    // "Worker, Warrior (its speed here is not known yet)": one reason, said once
    const by = new Map();
    for (const w of waits) {
      const [, name, why] = w.match(/^(.*) \((.*)\)$/);
      by.set(why, [...(by.get(why) || []), name]);
    }
    note += `; traininghero ${trainer.name} is away, waiting for it: ${[...by].map(([why, names]) => `${names.join(', ')} (${why})`).join('; ')}`;
  }
  const small = orders.filter((o) => o.idle).length;
  if (small) note += `; ${trainer.name} is away: ${small} small batch(es) in idle barracks with ${best ? best.name : 'the hero here'} (troopidlequeuetime ${s.idleMin} min)`;
  if (!orders.length && held) note += `; waiting on ${held}`;
  else if (held) note += `; then waiting on ${held}`;
  if (allowance <= 0 && types.some((k) => left[k] > 0 && !blocked[k])) note += `; ${TROOP_ORDERS} batches a slice, more next slice`;
  if (s.ratio) note += '; ratio mode (troopincrement 1)';
  else if (s.increment > 0) note += `; ${s.increment < 1 ? `${+(s.increment * 100).toFixed(2)}%` : fmt(s.increment)} of each type in turn (increment)`;
  if (s.slotFrom) note += `; batches of ${slotSec ? dur(slotSec) : 'any length'} (${s.slotFrom})`;
  if (s.useReserved > 0) note += `; ${s.useReserved >= 1 ? 'no food is' : `${+(keepShare * 100).toFixed(1)}% of a day of food is`} kept for upkeep (usereserved ${s.useReserved})`;
  for (const x of notes) note += `; ${x}`;
  if (popmax) note += `; frees ${fmt(workers)} workers from the fields for these (usepopmax ${s.usePopMax}), production put back straight after`;
  if (cancel) note += `; ${cancel.label}`;
  if (reserve && costText(reserve)) note += `; leaving ${costText(reserve)} in the bank for ${reserve.label || 'the next construction'}`;
  // what the batches were sized from, for the troop trace (OTTO_TROOP_TRACE)
  const diag = {
    idle, whole, popBudget, reservePop: n(reserve && reserve.population), foodKept: Math.round(foodKept),
    pool: Object.fromEntries(Object.entries(pool).map(([k, v]) => [k, Math.round(v)])),
    trainer: trainer ? { name: trainer.name, here: !!trainer.present, status: trainer.hero ? n(trainer.hero.status) : null, known: !!trainer.times, only: s.trainerOnly } : null,
    mayor: mayor ? mayor.name : null, best: best ? `${best.name}:${n(best.power)}` : null,
    bars: bars ? bars.map((b) => `${b.positionId}:${b.capacity - b.free}/${b.capacity}`).join(' ') : null,
  };
  return { ...base, orders, popBudget, slotMin: slotSec / 60, settings: s, cancel, popmax, note, diag };
}

// ------------------------------------------------------- fortification ladder
// Fortifications take fortified space, and only the Walls level grants it
// (C.WALL_SPACE). Everything built AND everything queued counts against it, and
// the Walls queue holds as many batches as the Walls level (Wall.as: "waiting
// queue: remain / level - producing").
//
// ctx.walls (Engine.readWalls) is the Walls level and what its queue holds.
// Queued fortifications count toward the target, as troops in the barracks do:
// counting only the ones standing re-ordered the same shortfall every tick
// until the queue was full ("10 fortified groups are only allowed on the
// waiting list"). Orders are sized to the space that is left, so the server is
// never asked for what cannot fit. When a stage needs more space than the Walls
// give, the plan names the Walls level that would hold it (wallsFor) and
// buildPlan puts that upgrade to the builder.
//
// NEAT's wall settings (wiki FortificationGoal, WallQueueTime, FortsUseReserved):
//   config fortification:0     no wall building ("You can disable wall building
//                              via goals with config fortification:0"), the
//                              emergency below included
//   config wallqueuetime:<h>   each batch about that many hours of work, 15
//                              minutes by default, from what one unit takes
//                              here (the fortification list's time, which has
//                              the mayor applied); 0 lifts the cap. With no time
//                              from the server the space decides, as before.
//   config fortsusereserved    wall batches keep the day of the troops' upkeep
//                              in the granary too, unless this share of it may go
//   the emergency              "During an attack on you, the bot will read and
//                              build 1 of each type of wall defense listed on the
//                              1st line of fortification goals with emergency
//                              priority." While a real wave is inbound (goal-war's
//                              under-attack reckoning, junk left out), each type
//                              the first line names gets a batch of one, once per
//                              attack, ahead of everything else in the slice
//                              (Engine.focus), met or not. Each still needs a
//                              wall queue slot and its space; one unit is cheap
//                              enough to go without the resource checks.
// What one of each costs in the client's own table (GetDataXML_XMLFort, in the
// client SWF; base seconds in the comments). The city's own costs come from
// the fortification list (Engine.readFortCosts); these stand in, for the food
// kept for upkeep, while that could not be read.
const FORT_BASE = {
  14: { food: 50, wood: 500, stone: 100, iron: 50 },       // Trap, 60 s
  15: { food: 100, wood: 1200, stone: 0, iron: 150 },      // Abatis, 120 s
  16: { food: 200, wood: 2000, stone: 1000, iron: 500 },   // Archer's Tower, 180 s
  17: { food: 300, wood: 6000, stone: 0, iron: 0 },        // Rolling Logs, 360 s
  18: { food: 600, wood: 0, stone: 8000, iron: 0 },        // Defensive Trebuchet, 600 s
};

function fortPlan(ctx) {
  const stages = ctx.goals.filter((g) => g.name === 'fortification');
  if (!stages.length) return null;
  const cfg = ctx.config || {};
  if (setting(cfg.fortification) === 0) {
    return { paused: true, orders: [], emergency: [], wallsFor: 0, note: 'fortification building paused by config fortification:0' };
  }
  const built = ctx.fortifications || {};
  const walls = ctx.walls || { level: wallsLevel(ctx.castle), queue: [] };
  const queued = {};
  for (const it of walls.queue || []) {
    const def = C.WALL_BY_TYPE[it.type];
    if (def) queued[def.code] = (queued[def.code] || 0) + it.num;
  }
  const queuedTotal = Object.values(queued).reduce((s, v) => s + v, 0);
  const inQueue = queuedTotal ? `; ${fmt(queuedTotal)} in the wall queue` : '';

  let active = null, index = 0;
  for (let i = 0; i < stages.length; i++) {
    const missing = {};
    let short = false;
    for (const [code, want] of Object.entries(stages[i].forts)) {
      const deficit = want - n(built[code]) - n(queued[code]);
      if (deficit > 0) { missing[code] = deficit; short = true; }
    }
    if (short) { active = { missing }; index = i; break; }
  }

  const level = Math.min(10, n(walls.level));
  const capacity = C.WALL_SPACE[level];
  let used = 0;
  for (const def of C.WALLS) used += (n(built[def.code]) + n(queued[def.code])) * def.space;
  let left = Math.max(0, capacity - used);
  let room = Math.max(0, level - (walls.queue || []).length);

  // The emergency, first: it takes its slots and space before the ladder does.
  // Only with the wall queue read, so the slots are known.
  const emergency = [];
  let urgent = '';
  const u = ctx.underAttack || null;
  if (u && n(u.inbound) > 0 && ctx.walls && !walls.error) {
    const had = ctx.fortEmergency && ctx.fortEmergency.key === u.key ? ctx.fortEmergency.done || [] : [];
    const firstLine = Object.entries(stages[0].forts).filter(([, v]) => n(v) > 0).map(([code]) => C.WALL_BY_CODE[code]);
    const missed = [];
    for (const wall of firstLine) {
      if (had.includes(wall.typeId)) continue;
      if (room <= 0) { missed.push(`${wall.name} (no free wall queue slot)`); continue; }
      if (left < wall.space) { missed.push(`${wall.name} (no fortified space)`); continue; }
      emergency.push({ wall, num: 1, key: u.key });
      left -= wall.space;
      room--;
    }
    const names = (l) => l.map((w) => w.name).join(', ');
    urgent = `; under attack: 1 of each on the first fortification line, first`
      + (emergency.length ? ` — ${names(emergency.map((o) => o.wall))} now` : had.length ? ' — done for this attack' : '')
      + (missed.length ? `; not yet: ${missed.join(', ')}` : '');
  }

  if (!active) return { done: true, emergency, wallsFor: 0, note: `all ${stages.length} fortification stage(s) satisfied${inQueue}${urgent}` };

  const base = { stageIndex: index + 1, stageCount: stages.length, missing: active.missing };
  const head = `stage ${index + 1}/${stages.length}: short ${Object.entries(active.missing).map(([k, v]) => `${k} ${fmt(v)}`).join(', ')}${inQueue}`;
  if (walls.error) return { ...base, orders: [], emergency, note: `${head}; not building: ${walls.error}` };

  // wiki WallQueueTime: hours per batch, 15 minutes when not set, 0 no cap.
  const wq = setting(cfg.wallqueuetime);
  const wallSec = wq === null ? DEFAULT_WALL_MIN * 60 : Math.max(0, wq * 3600);

  // Step 11: the construction the builder takes on next keeps its cost in the
  // bank (ctx.buildReserve), so while there is one a batch is also sized
  // against what is left, from what one of each type costs here
  // (ctx.fortCosts, Engine.readFortCosts). Costs not read: nothing is ordered
  // rather than spend it. FortsUseReserved keeps the troops' day of food as
  // well (the client's table stands in for costs not read). With costs read a
  // batch is sized to the bank in any case; with none read and nothing kept,
  // the space decides alone, as before.
  const reserve = ctx.buildReserve || null;
  const bank = (ctx.castle && ctx.castle.resource) || {};
  const keepShare = 1 - share(setting(cfg.fortsusereserved) ?? 0);
  const foodKept = keepShare * FOOD_DAY_HOURS * upkeepPerHour(ctx);
  const pool = reserve || foodKept > 0 || ctx.fortCosts ? Object.fromEntries(RES_KEYS
    .map((k) => [k, Math.max(0, n(bank[k] && bank[k].amount) - n(reserve && reserve[k]))])) : null;
  if (pool) pool.food -= foodKept;
  const kept = reserve ? `, with ${costText(reserve)} kept for ${reserve.label || 'the next construction'}` : '';

  // One batch per short type per tick, the whole shortfall or as much as fits.
  const orders = [];
  let held = '', capped = false;
  for (const [code, deficit] of Object.entries(active.missing)) {
    const wall = C.WALL_BY_CODE[code];
    if (room <= 0) { held = held || (level ? `a free wall queue slot (${level} at Walls L${level})` : 'Walls'); break; }
    let num = Math.min(deficit, Math.floor(left / wall.space));
    if (num <= 0) { held = held || 'fortified space'; continue; }
    const read = (ctx.fortCosts && ctx.fortCosts[wall.typeId]) || null;
    const each = read && read.time !== null && read.time !== undefined ? n(read.time) : null;
    if (each > 0 && wallSec > 0 && Math.floor(wallSec / each) < num) { num = Math.max(1, Math.floor(wallSec / each)); capped = true; }
    if (pool) {
      const cost = read || (reserve ? null : FORT_BASE[wall.typeId]);
      if (!cost) { held = held || `the fortification costs (unread)${kept}`; continue; }
      let byRes = Infinity, short = null;
      for (const k of RES_KEYS) {
        if (n(cost[k]) > 0 && Math.floor(pool[k] / n(cost[k])) < byRes) { byRes = Math.floor(pool[k] / n(cost[k])); short = k; }
      }
      num = Math.min(num, byRes);
      if (num <= 0) {
        held = held || (short === 'food' && foodKept > 0 ? `food (${fmt(foodKept)} is kept for a day of the troops' upkeep)${kept}` : `resources${kept}`);
        continue;
      }
      for (const k of RES_KEYS) pool[k] -= num * n(cost[k]);
    }
    orders.push({ wall, num, secs: each !== null ? num * each : null });
    left -= num * wall.space;
    room--;
  }

  let note = `${head}; space ${fmt(used)}/${fmt(capacity)} at Walls L${level}`;
  // The whole stage in place: what stands and is queued, plus the shortfall.
  const needed = used + Object.entries(active.missing).reduce((s, [code, v]) => s + v * C.WALL_BY_CODE[code].space, 0);
  let wallsFor = 0;
  if (needed > capacity) {
    const holds = C.WALL_SPACE.findIndex((cap) => cap >= needed);
    if (holds < 0) note += `; the stage needs ${fmt(needed)} space, more than Walls L10 hold (${fmt(C.WALL_SPACE[10])})`;
    else note += `; the stage needs ${fmt(needed)} space: Walls L${holds}`;
    wallsFor = holds < 0 ? 10 : holds;
    if (wallsFor <= level) wallsFor = 0;
  }
  if (!orders.length && held) note += `; waiting on ${held}`;
  if (capped) note += `; batches of ${dur(wallSec)} (${wq === null ? 'the 15-minute default' : 'wallqueuetime'})`;
  if (keepShare < 1) note += `; ${keepShare <= 0 ? 'no food is' : `${+(keepShare * 100).toFixed(1)}% of a day of food is`} kept for upkeep (fortsusereserved)`;
  return { ...base, orders, emergency, wallsFor, space: { used, capacity, level }, note: note + urgent };
}

// --------------------------------------------------------------- build targets
// A build line is a TARGET, the NEAT way (wiki: Build): how many of a type the
// city should end up with, at a level or higher.
//   f:10:37  -> at least 37 farms at L10 or higher. More farms, or higher ones,
//               are left alone: nothing is torn down to meet a target.
//   c:10     -> no quantity reads as 1: one cottage at L10. The wiki doesn't
//               settle it, and 1 is the reading that can never demolish.
//   c:0:8    -> level 0: at most 8 cottages; the weakest spares come down
//   inn:2:0  -> quantity 0: no inn at L2 or higher; each comes down to L1
//   s:0:0    -> no sawmills at all
// Only a 0 demolishes, and never the Town Hall or the Walls. Targets for one
// type combine: b:4:15,b:9:2 is 15 barracks, two of them at L9, not 17. The
// strongest buildings meet the highest target, and the lowest level is raised
// first. Lines never undo each other: when two disagree the first-written
// target wins (c:10:9 then c:0:8 keeps 9) and the note says so.
//
// A demolition order takes a building down ONE level, so an L10 sawmill is ten
// orders. The weakest spare goes first and stays the weakest, so it is taken
// all the way down before the next is touched.
//
// Lines run in order, like troop stages: the first line not yet met is worked
// on. Within it, demolitions go first, since they free the plots its new
// buildings need (the wiki is silent on mixing the two). Then the fastest work:
// a new building, then upgrades from the lowest level up. A line that can't
// finish because every plot of the kind it needs is taken is skipped, and taken
// up again once a plot frees. A building a city can have only one of, with no
// plot for it, stops the lines there: "Needs space: Academy". A group's
// ?condition? leaves its targets out until it holds; a line with nothing left
// is skipped.
//
// A city has ONE builder: the server takes one construction at a time ("One
// building allowed to be built at a time."). So the plan is a ranked list of
// candidates and the engine places the first that goes through:
//   1. the Walls a fortification goal needs for space (fortPlan.wallsFor), or
//      the first Walls of all when the city has none
//   2. the current line's orders
//   3. the later lines' orders. The engine only gets this far while every order
//      above is held back after a refusal, so a line the server keeps refusing
//      (a prerequisite, resources) doesn't leave the builder idle for hours.
// New buildings only go on plots that are open. Outside, the Town Hall decides
// how many are (C.plotRange). A full city used to propose "new Farm" every
// tick, and those doomed attempts took the slots the upgrades needed.
// While something is being built, the plan holds everything and says what it
// is waiting on. It plans from the city as it will stand once that is done, so
// what it names next is what the builder really takes on next: the same
// building's next level down, or the plot a finished demolition opens.
const { MULTI_BUILDINGS } = require('./goals');
const WALLS_POS = -2;             // BuildingConstants.POSITION_WALL; the Town Hall is -1
// Research levels are re-read at most this often, and only while a build
// ?condition? names one (Engine.readTechs).
const TECH_TTL = 10 * 60e3;

const isFixed = (typeId) => typeId === C.TOWN_HALL || typeId === C.WALLS_TYPE;

// Is a build target met, given the levels of that type standing?
function buildMet(levels, t) {
  const at = levels.filter((l) => l >= Math.max(1, t.level)).length;
  if (t.quantity === 0) return at === 0;                 // none at that level or higher
  if (t.level === 0) return levels.length <= t.quantity;  // at most that many
  return at >= t.quantity;
}

// Why a group's ?condition? does not hold, or null when it does. Buildings are
// read as they stand now, so one under construction has not reached its new
// level yet. Research comes from ctx.techs (Engine.readTechs). Unknown research
// is NOT met: a conditional demolition never runs on a guess.
function conditionFails(when, live, techs) {
  for (const c of when || []) {
    if (c.tech) {
      const lv = techs && techs.levels ? techs.levels[c.tech] : undefined;
      if (lv === undefined || lv === null) return `${c.raw}: research levels unknown${techs && techs.error ? ` (${techs.error})` : ''}`;
      if (n(lv) < c.level) return `${c.raw}: ${c.name} is L${n(lv)}`;
      continue;
    }
    const levels = live.filter((b) => b.typeId === c.typeId).map((b) => n(b.level)).filter((l) => l > 0);
    if (!buildMet(levels, c)) {
      return `${c.raw}: ${levels.length ? `${c.building} ${levels.length > 1 ? `x${levels.length}, highest ` : ''}L${Math.max(...levels)}` : `no ${c.building}`}`;
    }
  }
  return null;
}

// What the lines so far want of each type, all taken together:
//   floors  [{level, qty}]  at least qty at that level or higher
//   cap     at most this many
//   top     none above this level
// The first-written target wins a conflict.
function addWant(want, t, notes) {
  if (!want.has(t.typeId)) want.set(t.typeId, { floors: [], cap: Infinity, top: Infinity });
  const w = want.get(t.typeId);
  if (t.level > 0 && t.quantity > 0) {
    const qty = Math.min(t.quantity, w.cap), level = Math.min(t.level, w.top);
    if (qty < t.quantity) notes.push(`${t.raw} would undo ${w.capBy}: ${qty} kept`);
    else if (level < t.level) notes.push(`${t.raw} would undo ${w.topBy}: L${level} kept`);
    if (qty > 0 && level > 0) w.floors.push({ level, qty, raw: t.raw });
    return;
  }
  if (isFixed(t.typeId)) return;     // never demolished or taken down (goals.js refuses it too)
  if (t.level === 0) {
    const most = w.floors.reduce((m, f) => (f.qty > m.qty ? f : m), { qty: 0 });
    const cap = Math.max(t.quantity, most.qty);
    if (cap > t.quantity) notes.push(`${t.raw} would undo ${most.raw}: ${cap} kept`);
    if (cap < w.cap) Object.assign(w, { cap, capBy: t.raw });
    return;
  }
  const high = w.floors.reduce((m, f) => (f.level > m.level ? f : m), { level: 0 });
  const top = Math.max(t.level - 1, high.level);
  if (top > t.level - 1) notes.push(`${t.raw} would undo ${high.raw}: L${top} kept`);
  if (top < w.top) Object.assign(w, { top, topBy: t.raw });
}

// The orders that bring one type to what is wanted, from the city as it will
// stand once the builder's current job is done. `claim` gives each building one
// order at most, whoever asks. New buildings are left to the caller (`short`),
// since plots are shared between types.
function typeOrders(def, w, have, claim) {
  const out = { orders: [], notes: [], short: 0, unmet: false };
  const order = (b, o) => { if (n(b.status) === 0 && claim(b.positionId)) out.orders.push({ def, positionId: b.positionId, ...o }); };
  const weakFirst = (a, b) => n(a.level) - n(b.level) || n(a.positionId) - n(b.positionId);
  const strongFirst = (a, b) => n(b.level) - n(a.level) || n(a.positionId) - n(b.positionId);

  // too many: the weakest spares come down
  const spare = isFixed(def.typeId) ? [] : have.slice().sort(weakFirst).slice(0, Math.max(0, have.length - w.cap));
  for (const b of spare) order(b, { kind: 'demolish', level: b.level });
  if (spare.length) out.notes.push(`${def.name} ${have.length}->${w.cap} (demolish ${spare.length})`);
  const kept = have.filter((b) => !spare.includes(b));

  // too high: each comes down to the highest level allowed, the lowest first
  const high = isFixed(def.typeId) ? [] : kept.filter((b) => n(b.level) > w.top).sort(weakFirst);
  for (const b of high) order(b, { kind: 'demolish', level: b.level, to: w.top });
  if (high.length) out.notes.push(`${def.name} ${high.length} down to L${w.top}`);

  // too few or too low: the strongest meet the highest target
  const most = Math.max(0, ...w.floors.map((f) => f.qty));
  const need = (i) => Math.max(0, ...w.floors.filter((f) => f.qty > i).map((f) => f.level));
  const low = [];
  kept.slice().sort(strongFirst).slice(0, most).forEach((b, i) => {
    const to = need(i);
    if (n(b.level) >= to) return;
    low.push(to);
    order(b, { kind: 'upgrade', from: b.level, to });
  });
  if (low.length) {
    const lo = Math.min(...low), hi = Math.max(...low);
    out.notes.push(`${def.name} upgrade ${low.length} to L${lo}${hi > lo ? `-L${hi}` : ''}`);
  }
  out.short = Math.max(0, most - kept.length);
  out.unmet = spare.length > 0 || high.length > 0 || low.length > 0 || out.short > 0;
  return out;
}

// Field plots taken once what the lines so far want is done: each field type
// the lines name at what they want of it (what is kept after demolitions, or
// built up to), the others as they stand.
function outsideWanted(all, want) {
  let total = 0;
  for (const def of C.BUILDINGS.filter((d) => d.outside)) {
    const have = all.filter((b) => b.typeId === def.typeId).length;
    const w = want.get(def.typeId);
    total += w ? Math.max(Math.min(have, w.cap), Math.max(0, ...w.floors.map((f) => f.qty))) : have;
  }
  return total;
}

function buildPlan(ctx, wallsFor = 0) {
  const lines = ctx.goals.filter((g) => g.name === 'build');
  // Step 19: the plan line in work comes as build lines of its own, ahead of
  // these, each with its own tag ("plan line 1/2", goal-plan.js expand)
  const own = lines.filter((l) => !l.plan);
  const live = standing(ctx.castle);
  // A fortification goal can place nothing without Walls, whatever the wall
  // queue read said, so no Walls at all means build them — unless config
  // fortification:0 has the goal off (wiki FortificationGoal: "You can disable
  // wall building via goals with config fortification:0"). A w: build line
  // still builds them.
  const noWalls = !live.some((b) => b.typeId === C.WALLS_TYPE);
  const fortsNeedWalls = noWalls && setting(ctx.config && ctx.config.fortification) !== 0
    && ctx.goals.some((g) => g.name === 'fortification' && Object.values(g.forts || {}).some((v) => n(v) > 0));
  // Step 16: the buildings the research goal needs (goal-research.js) are
  // worked by the builder with no build line at all (resolvePrereqs)
  const forResearch = ctx.researchBuildWants || [];
  if (!lines.length && !wallsFor && !fortsNeedWalls && !forResearch.length) return null;
  if (ctx.config && ctx.config.building === 0) {
    return { actions: [], ranked: [], busy: false, paused: true, note: 'build: construction paused by config building:0' };
  }
  const now = Date.now();
  const all = live.map(finished).filter((b) => n(b.level) > 0);
  const { used, townHall } = Game.plotsInUse({ ...ctx.castle, buildings: all });
  const openPlots = (outside) => {
    const { from, to } = C.plotRange(outside, townHall);
    const out = [];
    for (let p = from; p <= to; p++) if (!used.has(p)) out.push(p);
    return out;
  };
  const plots = { inside: openPlots(false), outside: openPlots(true) };
  const claimed = new Set();
  const claim = (pos) => !claimed.has(n(pos)) && !!claimed.add(n(pos));
  const WALLS = C.BUILDING_BY_ID[C.WALLS_TYPE];

  // "no free field plot for 7 more Farm (Town Hall L7 opens 31 of 40)"
  const roomText = ({ def, kind, more }) => {
    if (kind === 'inside') return `no free city plot for ${more} more ${def.name} (all ${C.SLOTS.insideTo - C.SLOTS.insideFrom + 1} in use)`;
    const { from, to } = C.plotRange(true, townHall);
    const all40 = C.SLOTS.outsideTo - C.SLOTS.outsideFrom + 1;
    return `no free field plot for ${more} more ${def.name} (${to - from + 1 < all40 ? `Town Hall L${townHall} opens ${to - from + 1} of ${all40}` : `all ${all40} in use`})`;
  };

  const ranked = [], summary = [], skipped = [], conflicts = [];
  let room = [];
  const TOWN_HALL_DEF = C.BUILDING_BY_ID[C.TOWN_HALL];
  // Field plots the Town Hall opens at a level: 13 at L1, 3 more a level, 40 at L10.
  const fieldsAt = (lv) => C.plotRange(true, lv).to - C.SLOTS.outsideFrom + 1;

  // 1. The Walls a fortification goal needs, first, so they keep their place
  // even when a build line also names the Walls.
  const fortWalls = wallsFor || (fortsNeedWalls ? 1 : 0);
  if (fortWalls) {
    const w = all.find((b) => b.typeId === C.WALLS_TYPE);
    if (!w) {
      claim(WALLS_POS);
      ranked.push({ kind: 'new', def: WALLS, positionId: WALLS_POS, why: 'fortifications' });
      summary.push('Walls, new, for the fortifications');
    } else {
      if (n(w.level) < fortWalls && n(w.status) === 0 && claim(w.positionId)) {
        ranked.push({ kind: 'upgrade', def: WALLS, positionId: w.positionId, from: w.level, to: fortWalls, why: 'fortified space' });
      }
      summary.push(`Walls to L${fortWalls} for fortified space`);
    }
  }

  // 2 and 3. The lines, in order.
  const want = new Map();
  const planned = {};          // new buildings already given a plot, per type
  let active = 0, stop = null;
  for (let k = 0; k < lines.length && !stop; k++) {
    const line = lines[k], tag = line.tag || `line ${own.indexOf(line) + 1}/${own.length}`;
    const on = [], waits = [];
    for (const gr of line.groups || [{ targets: line.targets || [] }]) {
      const why = gr.when ? conditionFails(gr.when, live, ctx.techs) : null;
      if (why) waits.push(`?${gr.condition}? not met (${why})`);
      else on.push(...gr.targets.filter((t) => C.BUILDING_BY_ID[t.typeId]));
    }
    if (!on.length) {
      if (waits.length && !active) skipped.push(`${tag} waits: ${waits.join('; ')}`);
      continue;
    }
    for (const t of on) addWant(want, t, conflicts);

    const types = [...new Set(on.map((t) => t.typeId))];
    const orders = [], lineSum = [], lineRoom = [], shorts = [];
    let unmet = false, needsSpace = null;
    types.forEach((typeId, rank) => {
      const def = C.BUILDING_BY_ID[typeId];
      const have = all.filter((b) => b.typeId === typeId);
      const r = typeOrders(def, want.get(typeId), have, claim);
      orders.push(...r.orders.map((o) => ({ ...o, rank })));
      lineSum.push(...r.notes);
      unmet = unmet || r.unmet;
      if (r.short) shorts.push({ def, rank, missing: r.short, have: have.length });
    });
    // New buildings. One a city can have only one of takes a plot first:
    // without it the lines stop ("Needs space"), the others can wait for one.
    shorts.sort((a, b) => MULTI_BUILDINGS.has(a.def.typeId) - MULTI_BUILDINGS.has(b.def.typeId) || a.rank - b.rank);
    for (const { def, rank, missing, have } of shorts) {
      if (def.typeId === C.TOWN_HALL) continue;      // a city always has its Town Hall
      // 5b: the first Walls go on their own place, -2 (BaseNewBuildingWin.as:236-238)
      if (def.typeId === C.WALLS_TYPE) {
        if (claim(WALLS_POS)) orders.push({ kind: 'new', def, positionId: WALLS_POS, rank });
        lineSum.push('Walls, new');
        continue;
      }
      const kind = def.outside ? 'outside' : 'inside';
      const short = Math.max(0, missing - n(planned[def.typeId]));
      const fit = Math.min(short, plots[kind].length);
      for (let i = 0; i < fit; i++) orders.push({ kind: 'new', def, positionId: plots[kind].shift(), rank });
      planned[def.typeId] = n(planned[def.typeId]) + fit;
      if (fit) lineSum.push(`${def.name} ${have}->${have + missing} (build ${fit})`);
      if (fit < short) {
        lineRoom.push({ def, kind, more: short - fit });
        if (!MULTI_BUILDINGS.has(def.typeId)) needsSpace = needsSpace || def.name;
      }
    }
    // Step 11: fields the Town Hall has not opened plots for. It opens 13 + 3
    // per level (all 40 at L10), so when the fields the lines so far want
    // cannot all fit, the Town Hall goes up a level in place of the new fields
    // that have no plot — what a player would do. NEAT's wiki does not say it
    // does this (only "space permitting"). It is raised no further than the
    // fields need, and never while a demolition in the lines will free enough.
    const fieldsWanted = outsideWanted(all, want);
    if (lineRoom.some((r) => r.kind === 'outside') && townHall < 10 && fieldsWanted > fieldsAt(townHall)) {
      let to = townHall;
      while (to < 10 && fieldsAt(to) < fieldsWanted) to++;
      const th = all.find((b) => b.typeId === C.TOWN_HALL);
      if (th && claim(th.positionId)) {
        orders.push({ kind: 'upgrade', def: TOWN_HALL_DEF, positionId: th.positionId, from: n(th.level), to, plots: true,
          why: `field plots (Town Hall L${to} opens ${fieldsAt(to)})`, rank: -1 });
        lineSum.push(`Town Hall to L${to} for field plots`);
      }
    }
    if (!unmet) {                                // this line is met: on to the next
      if (waits.length && !active) skipped.push(`${tag} waits: ${waits.join('; ')}`);
      continue;
    }

    // demolitions first, the weakest first; then a new building (L0->L1), then
    // upgrades from the lowest level up — the fastest work first. The Town Hall
    // raised for field plots stands in for the new fields that have no plot,
    // so it comes after the ones that do.
    const speed = (o) => (o.kind === 'demolish' ? n(o.level) : o.plots ? 101.5 : 100 + (o.kind === 'new' ? 1 : n(o.from) + 1));
    orders.sort((a, b) => speed(a) - speed(b) || a.rank - b.rank || n(a.positionId) - n(b.positionId));
    const clean = orders.map(({ rank, ...o }) => o);

    if (active) {
      // a later line: only reached while everything above is held back
      if (needsSpace && !clean.length) break;
      ranked.push(...clean);
      if (needsSpace) break;
      continue;
    }
    if (clean.length) {
      active = k + 1;
      ranked.push(...clean);
      summary.push(`${tag}: ${lineSum.slice(0, 3).join('; ')}${lineSum.length > 3 ? ` (+${lineSum.length - 3} more)` : ''}`);
      if (waits.length) summary.push(`${tag} also waits: ${waits.join('; ')}`);
      room = room.concat(lineRoom);
      // a line held up for space goes no further than itself
      if (needsSpace) stop = `Needs space: ${needsSpace}`;
      continue;
    }
    if (needsSpace) {
      stop = `Needs space: ${needsSpace}`;
      room = room.concat(lineRoom);
      break;
    }
    if (lineRoom.length) {
      skipped.push(`${tag} waits for a plot: ${[...new Set(lineRoom.map(roomText))].join('; ')}`);
      continue;
    }
    // what it needs is already under way (the Walls above, a queued building)
    skipped.push(`${tag}: waiting on work already under way`);
  }

  const busy = live.filter((b) => underway(b, now));
  const parts = [];
  if (busy.length) {
    const b = busy[0];
    const left = n(b.endTime) > now ? `, ${dur((n(b.endTime) - now) / 1000)} left` : '';
    parts.push(`builder busy: ${n(b.status) === 2 ? 'demolishing' : 'building'} ${b.name || (C.BUILDING_BY_ID[b.typeId] || {}).name || 'type ' + b.typeId} (pos ${b.positionId}) L${n(b.level)}->L${n(finished(b).level)}${left}`);
    if (ranked.length) parts.push(`next: ${buildLabel(ranked[0])}`);
  } else if (ranked.length) {
    parts.push(...summary);
  }
  parts.push(...new Set(room.map(roomText)));     // two lines naming farms say it once
  parts.push(...skipped);
  if (stop) parts.push(stop);
  parts.push(...new Set(conflicts));
  // What the lines take down (a cap on how many, or a top level), so a
  // prerequisite is never built only for the lines to demolish it again.
  const limits = {};
  for (const [typeId, w] of want) if (w.cap < Infinity || w.top < Infinity) limits[typeId] = { cap: w.cap, top: w.top };
  const at = active ? lines[active - 1] : null;
  return {
    actions: busy.length ? [] : ranked,
    ranked,                     // in order, even while busy: what comes next
    busy: busy.length > 0,
    // the build line worked on (plan: the plan line, when that is it)
    line: at && !at.plan ? own.indexOf(at) + 1 : null, plan: at && at.plan ? at.plan : null,
    lines: own.length, stop, limits,
    note: parts.length ? `build: ${parts.join('; ')}`
      : lines.length || !forResearch.length ? 'all build targets met' : 'build: no build lines, only what the research goal needs',
  };
}

// "upgrade Farm (pos 1003) L6->L7, goal L10", "new Farm (pos 1031)",
// "demolish Sawmill (pos 1032) L10->L9", "new Walls (pos -2) for fortifications"
function buildLabel(a) {
  if (a.kind === 'upgrade') {
    return `upgrade ${a.def.name} (pos ${a.positionId}) L${n(a.from)}->L${n(a.from) + 1}`
      + (a.why ? ` for ${a.why}` : n(a.to) > n(a.from) + 1 ? `, goal L${a.to}` : '');
  }
  if (a.kind === 'demolish') return `demolish ${a.def.name} (pos ${a.positionId}) L${n(a.level)}->L${n(a.level) - 1}`;
  return `new ${a.def.name} (pos ${a.positionId})${a.why ? ` for ${a.why}` : ''}`;
}

// The backoff key for a construction candidate. New buildings share one per
// type: the plot they would go on changes as others fill.
const buildKey = (a) => (a.kind === 'new' ? `build:new:${a.def.typeId}:new` : `build:${a.kind}:${a.def.typeId}:${a.positionId}`);

// ------------------------------------------------------------ prerequisites
// NEAT (wiki: Build): "If a building upgrade requires a prerequisite building
// to be completed, the bot will automatically build and upgrade the
// prerequisite building with priority; e.g., to upgrade a cottage to level 9,
// you need townhall level 8 first." A stable needs a L5 farm, and with no farm
// and no room for one "it will say 'Needs space: farm' and stop there until
// you fix the problem".
//
// The game says what an order needs in its ConditionBean (ConditionBean.as):
// buildings[] {typeId, level, curLevel, successFlag}, techs[] {id, level,
// curLevel, successFlag}, items[] {id, num, curNum, successFlag}, and the
// cost: food, wood, stone, iron, gold, population. The client reads it before
// it offers the button (BuildingInfoWin.sendCheckRequest; UIUtil
// .isConditionMatch, .isResourceConditionMatch), and the engine now reads it
// before it places the builder's next order (Engine.resolveBuild):
//   a building short   that building goes first: the one of its type closest
//                      to the level is raised (the fewest upgrades meet it — the
//                      wiki does not say which), or a new one goes on a free
//                      plot. Its own needs are read the same way, a few deep at
//                      most. A field with no plot left gets one from the Town
//                      Hall; anything else with no plot: "Needs space: Farm",
//                      and the builder stops, as NEAT's does.
//   research short     a research want for the city (cityState.researchWants,
//                      for a research goal to take up); the order is passed
//                      over, with no backoff
//   an item short      Michelangelo's Script for a L10: with none held the
//                      order is passed over, no backoff; with one held it goes
//                      and the server spends it — as NEAT does, which its wiki
//                      warns about (Research)
//   resources or idle population short
//                      the builder waits for them, no backoff, and troop and
//                      wall batches leave that cost in the bank (ctx.buildReserve)
// Only a refusal the ConditionBean did not predict goes on the backoff ladder.
const PREREQ_DEPTH = 4;           // a prerequisite's prerequisite's ... this deep at most
const PREREQ_READS = 2;           // requirement reads per city per slice
const COND_TTL = 5 * 60e3;        // a requirement read is trusted this long
const COND_ERROR_TTL = 60e3;      // one that could not be read is asked again after this
const COST_KEYS = ['food', 'wood', 'stone', 'iron', 'gold'];

// Requirements go by type and level, not by plot: every L8 farm needs the same
// for L9, so one read serves them all.
const condKey = (a) => (a.kind === 'new' ? `new:${a.def.typeId}` : `up:${a.def.typeId}:${n(a.from)}`);

// The city's buildings in one short string. When it changes (a construction
// starts or ends, a push lands) every requirement read before is read again.
const buildingsSig = (castle) => require('crypto').createHash('sha1').update(standing(castle)
  .map((b) => `${b.positionId}:${b.typeId}:${n(b.level)}:${n(b.status)}`).sort().join('|')).digest('hex').slice(0, 16);

// 120000 -> "120k", 2500000 -> "2.5m"
function shortNum(x) {
  const v = Math.round(n(x));
  const cut = (d, s) => `${Math.round((v / d) * 10) / 10}${s}`;
  return v >= 1e9 ? cut(1e9, 'b') : v >= 1e6 ? cut(1e6, 'm') : v >= 1e4 ? cut(1e3, 'k') : fmt(v);
}

// "Cottage L9", "a new Stable": what an order brings about
const orderWhat = (a) => (a.kind === 'new' ? `a new ${a.def.name}` : `${a.def.name} L${n(a.from) + 1}`);

// What an order takes from the bank, and the words for it.
function costOf(cond) {
  const out = {};
  for (const k of COST_KEYS) if (n(cond[k]) > 0) out[k] = n(cond[k]);
  if (n(cond.population) > 0) out.population = n(cond.population);
  return out;
}
const costText = (cost) => Object.entries(cost).filter(([k]) => k !== 'label')
  .map(([k, v]) => `${shortNum(v)} ${k === 'population' ? 'idle population' : k}`).join(', ');

// The builder's next order, given the ranked plan and what is known of each
// order's requirements. Pure: `conds(key)` is a cache lookup, and an order not
// read yet comes back as `need` for the engine to read and ask again. Returns
//   pick     the order to place now (it may be a prerequisite; `via` is the
//            plan's order it is for, `chain` says why)
//   hold     {action, short, cost}: the builder waits for resources
//   stop     "Needs space: ..." — nothing is placed, as NEAT stops
//   need     an order whose requirements must be read first (`needFor` the
//            plan's order it belongs to)
//   skipped  orders passed over for research or an item, with why
//   held     orders held back by the backoff ladder
//   wants    research the passed-over orders need: {techId, level, have, name, for}
//   research why a building the research goal needs cannot go now
//
// Step 16: `forResearch` [{typeId, level, name, for}] are the buildings the
// research goal needs (goal-research.js), and they come first — NEAT (wiki
// Research): "The bot will automatically build and upgrade any buildings
// necessary to complete research goals"; for machinery "the bot will build and
// upgrade your academy to level 9 with priority". Each is met the way a
// prerequisite is (prereqFor, then its own requirements, the same depth and
// loop guards, the same Michelangelo's Script rule), and waits for resources
// the same way. But research and build lines run side by side (wiki Plan), so
// one that cannot go — no plot ("Needs space"), no script held, a building the
// build lines take down — is noted and the build lines go on.
function resolvePrereqs({ plan, castle, conds, cityState = {}, items = null, techLevels = null, forResearch = [] }) {
  const out = { pick: null, via: null, chain: [], cost: null, unread: null, spends: null,
    need: null, needFor: null, hold: null, stop: null, skipped: [], held: [], wants: [], research: [] };
  forResearch = forResearch || [];
  if (!plan || ((!plan.ranked || !plan.ranked.length) && !forResearch.length)) return out;
  const all = standing(castle).map(finished).filter((b) => n(b.level) > 0);
  const res = castle.resource || {};
  const { used, townHall } = Game.plotsInUse({ ...castle, buildings: all });
  const limits = plan.limits || {};
  const topOf = (typeId) => Math.max(0, ...all.filter((b) => b.typeId === typeId).map((b) => n(b.level)));
  const freePlot = (outside, claimed) => {
    const { from, to } = C.plotRange(outside, townHall);
    for (let p = from; p <= to; p++) if (!used.has(p) && !claimed.has(p)) return p;
    return null;
  };
  const want = (m, a) => {
    const had = out.wants.find((w) => w.techId === m.id);
    if (!had) out.wants.push({ techId: m.id, level: m.need, have: m.have, name: m.name, for: orderWhat(a) });
    else if (m.need > had.level) Object.assign(had, { level: m.need, for: orderWhat(a) });
  };

  // The order that meets building requirement m, or why there is none.
  const prereqFor = (m, needs, why, claimed, chain) => {
    const def = C.BUILDING_BY_ID[m.typeId];
    if (!def) return { skip: `${needs}, a building type unknown here` };
    const lim = limits[m.typeId];
    if (lim && (lim.cap === 0 || lim.top < m.need)) return { skip: `${needs}, which the build lines take down` };
    const b = all.filter((x) => x.typeId === m.typeId)
      .sort((x, y) => n(y.level) - n(x.level) || n(x.positionId) - n(y.positionId))[0];
    if (b) return { action: { kind: 'upgrade', def, positionId: b.positionId, from: n(b.level), to: m.need, why, prereq: true } };
    if (m.typeId === C.TOWN_HALL) return { skip: `${needs}, and the city has no Town Hall` };
    if (m.typeId === C.WALLS_TYPE) return { action: { kind: 'new', def, positionId: WALLS_POS, why, prereq: true } };
    const pos = freePlot(!!def.outside, claimed);
    if (pos !== null) return { action: { kind: 'new', def, positionId: pos, why, prereq: true } };
    // a field with no plot: the Town Hall opens more
    const th = all.find((x) => x.typeId === C.TOWN_HALL);
    if (def.outside && th && townHall < 10 && !chain.includes(C.TOWN_HALL)) {
      return { action: { kind: 'upgrade', def: C.BUILDING_BY_ID[C.TOWN_HALL], positionId: th.positionId,
        from: n(th.level), to: n(th.level) + 1, why: `a field plot (${needs})`, prereq: true } };
    }
    return { stop: `Needs space: ${def.name} (${needs})` };
  };

  const evaluate = (a, claimed, depth, chain) => {
    if (a.kind === 'demolish') return { place: a };
    const e = conds(condKey(a));
    if (!e) return { need: a };
    if (e.error || !e.cond) return { place: a, unread: e.error || null };
    const lacks = Game.unmetOf(e.cond, { resource: res, items });
    const techs = lacks.filter((m) => m.kind === 'tech' && !(techLevels && n(techLevels[m.id]) >= m.need));
    for (const m of techs) want(m, a);
    for (const m of lacks.filter((x) => x.kind === 'building')) {
      if (topOf(m.typeId) >= m.need) continue;        // it stands already: finished since the read
      const needs = `${orderWhat(a)} needs ${m.name} L${m.need}`;
      if (m.typeId === a.def.typeId || chain.includes(m.typeId)) return { skip: `${needs}, which needs it back`, chain: [needs] };
      if (depth >= PREREQ_DEPTH) return { skip: `${needs}: prerequisites nest deeper than ${PREREQ_DEPTH}`, chain: [needs] };
      const p = prereqFor(m, needs, `${orderWhat(a)} (it needs ${m.name} L${m.need})`, claimed, [...chain, a.def.typeId]);
      if (!p.action) return { ...p, chain: [needs] };
      const mine = p.action.kind === 'new' ? new Set([...claimed, n(p.action.positionId)]) : claimed;
      const r = evaluate(p.action, mine, depth + 1, [...chain, a.def.typeId]);
      return { ...r, chain: [needs, ...(r.chain || [])] };
    }
    if (techs.length) return { skip: `needs research ${techs.map((m) => `${m.name} L${m.need}`).join(', ')} (a research goal will pick this up)` };
    const scarce = lacks.filter((m) => m.kind === 'item');
    if (scarce.length) return { skip: `needs ${scarce.map((m) => `${m.need} ${m.name}, ${m.have ? `only ${m.have} held` : 'none held'}`).join('; ')}` };
    const short = lacks.filter((m) => m.kind === 'resource' || m.kind === 'population');
    if (short.length) return { hold: { action: a, short, cost: costOf(e.cond) } };
    const spends = (e.cond.items || []).map((it) => {
      const held = items ? Game.countOf(items, it.id) : null;
      return `${Math.max(1, n(it.num))} ${Game.itemName(it.id)}${held !== null ? ` (${held} held)` : ''}`;
    });
    return { place: a, cost: costOf(e.cond), spends: spends.length ? spends.join(', ') : null };
  };

  for (const w of forResearch) {
    const def = C.BUILDING_BY_ID[n(w.typeId)];
    if (!def || topOf(def.typeId) >= n(w.level)) continue;       // stands, or will once the work on it is done
    const what = `research ${w.for || 'goal'}`;
    const needs = `${what} needs ${def.name} L${n(w.level)}`;
    const p = prereqFor({ typeId: def.typeId, need: n(w.level), name: def.name }, needs,
      `${what} (it needs ${def.name} L${n(w.level)})`, new Set(), []);
    if (!p.action) { out.research.push(p.skip || p.stop); continue; }
    const k = buildKey(p.action);
    if (blocked(cityState, k)) { out.held.push(`${buildLabel(p.action)}, ${blockedFor(cityState, k)}`); continue; }
    const claimed = new Set(p.action.kind === 'new' ? [n(p.action.positionId)] : []);
    const r = evaluate(p.action, claimed, 1, []);
    const via = (x) => (x === p.action ? null : p.action);
    if (r.need) return Object.assign(out, { need: r.need, needFor: p.action });
    if (r.place) {
      const pk = buildKey(r.place);
      if (r.place !== p.action && blocked(cityState, pk)) {
        out.held.push(`${buildLabel(r.place)}, which ${buildLabel(p.action)} needs first, ${blockedFor(cityState, pk)}`);
        continue;
      }
      return Object.assign(out, { pick: r.place, via: via(r.place), chain: r.chain || [], cost: r.cost || null,
        unread: r.unread || null, spends: r.spends || null, forResearch: w });
    }
    if (r.hold) return Object.assign(out, { hold: { ...r.hold, via: via(r.hold.action) }, chain: r.chain || [], forResearch: w });
    out.research.push(`${buildLabel(p.action)}: ${r.stop || r.skip}`);
  }

  const ranked = plan.ranked;
  for (let i = 0; i < ranked.length; i++) {
    const a = ranked[i];
    const k = buildKey(a);
    if (blocked(cityState, k)) { out.held.push(`${buildLabel(a)}, ${blockedFor(cityState, k)}`); continue; }
    // the plots the plan's new buildings up to this one take are theirs
    const claimed = new Set(ranked.slice(0, i + 1).filter((x) => x.kind === 'new').map((x) => n(x.positionId)));
    const r = evaluate(a, claimed, 0, []);
    const via = (x) => (x === a ? null : a);
    if (r.need) return Object.assign(out, { need: r.need, needFor: a });
    if (r.place) {
      const pk = buildKey(r.place);
      if (r.place !== a && blocked(cityState, pk)) {
        out.held.push(`${buildLabel(r.place)}, which ${orderWhat(a)} needs first, ${blockedFor(cityState, pk)}`);
        continue;
      }
      return Object.assign(out, { pick: r.place, via: via(r.place), chain: r.chain || [], cost: r.cost || null,
        unread: r.unread || null, spends: r.spends || null });
    }
    if (r.hold) return Object.assign(out, { hold: { ...r.hold, via: via(r.hold.action) }, chain: r.chain || [] });
    if (r.stop) return Object.assign(out, { stop: r.stop, chain: r.chain || [] });
    out.skipped.push(`${buildLabel(a)}: ${r.skip}`);
  }
  return out;
}

// What a resolution adds to the build plan's note.
function prereqNotes(r) {
  const out = [];
  if (r.pick && r.forResearch && !r.via) out.push(`for the research goal first: ${buildLabel(r.pick)}`);
  if (r.pick && r.via) out.push(`prerequisite first: ${buildLabel(r.pick)}${r.chain.length > 1 ? ` (${r.chain.join('; ')})` : ''}`);
  if (r.pick && r.unread) out.push(`${buildLabel(r.pick)}: its requirements could not be read (${r.unread}), so it goes unchecked`);
  if (r.pick && r.spends) out.push(`${buildLabel(r.pick)} spends ${r.spends} (the NEAT wiki warns its bot spends Michelangelo's Scripts too)`);
  if (r.hold) {
    const short = r.hold.short.map((m) => (m.kind === 'population'
      ? `${shortNum(m.need)} idle population (${shortNum(m.have)} idle)` : `${shortNum(m.need)} ${m.key} (${shortNum(m.have)} held)`));
    out.push(`waiting for ${short.join(', ')} to ${buildLabel(r.hold.action)}${r.hold.via ? `, which ${orderWhat(r.hold.via)} needs first` : ''}`
      + `; troop and wall batches leave ${costText(r.hold.cost)} in the bank for it`);
  }
  if (r.stop) out.push(r.stop);
  if (r.need) out.push(`checking what ${buildLabel(r.needFor)} needs (next slice)`);
  if (r.skipped.length) out.push(`passed over: ${r.skipped.slice(0, 3).join('; ')}${r.skipped.length > 3 ? ` (+${r.skipped.length - 3} more)` : ''}`);
  if ((r.research || []).length) out.push(`for the research goal, not now: ${r.research.join('; ')}`);
  return out;
}

// One order's requirements through the game (Game.constructionCondition), or
// through the same two commands on a stand-in game that only has `req`.
async function readCondition(g, cid, a) {
  const fn = typeof g.constructionCondition === 'function' ? g.constructionCondition : Game.prototype.constructionCondition;
  try {
    return (await fn.call(g, cid, { kind: a.kind, typeId: a.def.typeId, positionId: a.positionId })) || { error: 'no reply' };
  } catch (e) {
    return { error: e.message };
  }
}

// What the builder takes on next in one city — the console's Buildings tab.
// Pure: the live building list, the goals and the city's engine state; nothing
// is sent. It is the plan the next tick makes, less the candidates the engine
// has backed off. `wallsFor` comes from the last tick, because the Walls level a
// fortification goal needs takes a Walls queue read that only a tick makes. The
// research levels a ?condition? tests are the engine's last reading.
function buildOutlook({ castle, goals, cityState = {}, wallsFor = 0, config = {}, techs = null, now = Date.now() }) {
  // the buildings the research goal asked for on the engine's last pass
  const forResearch = cityState.researchBuildWants || [];
  // Step 19: the plan line in work, as the engine plans it (goal-plan.js)
  if (PL) goals = PL.expand({ goals: goals || [], config: config || {} }, castle, ((techs || cityState.techs) || {}).levels || null).goals;
  const plan = buildPlan({ castle, goals: goals || [], config: config || {}, techs: techs || cityState.techs || null,
    researchBuildWants: forResearch }, wallsFor);
  if (!plan) return { next: null, idle: 'no build goals for this city' };
  if (plan.paused) return { next: null, held: [], idle: 'nothing: construction paused by config building:0', note: plan.note };
  const held = [];
  let next = null;
  for (const a of plan.ranked) {
    const k = buildKey(a);
    if (blocked(cityState, k)) { held.push(`${buildLabel(a)}: ${blockedFor(cityState, k)}`); continue; }
    next = a;
    break;
  }
  const hold = n(cityState.builderHeld) - Date.now();
  const out = {
    next: next ? buildLabel(next) : null,
    // why it is not being placed this minute, if it is not
    wait: plan.busy ? 'once the builder is free'
      : hold > 0 ? `the server says the builder is busy, asking again in ${dur(hold / 1000)}` : null,
    held,
    idle: plan.ranked.length ? null
      : forResearch.length ? `the buildings the research goal needs (${forResearch.map((w) => `${w.name || (C.BUILDING_BY_ID[w.typeId] || {}).name} L${w.level}`).join(', ')}), once the engine has checked them`
        : plan.note === 'all build targets met' ? 'nothing: all build targets met' : `nothing to place: ${plan.note.replace(/^build: /, '')}`,
    note: plan.note,
  };
  // The engine's last word on requirements (Engine.resolveBuild), while the
  // buildings still stand as it saw them: a prerequisite first, a wait for
  // resources, orders passed over for research or an item.
  const pre = cityState.prereq;
  if (pre && !plan.busy && (plan.ranked.length || forResearch.length) && pre.sig === buildingsSig(castle) && Date.now() - n(pre.at) < COND_TTL) {
    out.next = pre.next;
    if (pre.wait && !(hold > 0)) out.wait = pre.wait;
    held.push(...(pre.passed || []));
    if (!pre.next) out.idle = `nothing to place: ${pre.stop || 'every order is passed over or held back'}`;
    else out.idle = null;
  }
  // Step 19: outside the city's schedulepolicy hours nothing is placed (processing.js)
  const sched = PR && out.next && !plan.busy ? PR.scheduleAt(goals, now) : null;
  if (sched && !sched.on) out.wait = `the city ${sched.why}`;
  return out;
}

// ------------------------------------------------------------ inbound armies
// Hostile armies on their way to our cities. server.EnemyArmysUpdate carries
// the WHOLE account's list and nothing else, no castle id (EnemyArmysUpdate.as
// has only `armys`), and the client replaces its copy on every push
// (Context.as:403). Each army names the field it marches on, and that is how
// the client ties an attack to a city (CastleTooltip.peace: targetFieldId ==
// castleBean.fieldId). Filing the push under data.castleId put every attack
// under "undefined", so no city's defence ever saw one.
//
// Only armies still on their way count: ArmyConstants.as direction 2 is heading
// home and 3 is encamped, and neither is about to land. An attack on one of our
// valleys or flats has that field's id, not the city's, so it is not here.
function inboundArmy(a) {
  // ArmyBean names the field `troop` (SINGULAR) and it is a TroopStrBean whose
  // values are STRINGS — an unscouted army sends "?" per type. Reading
  // `a.troops` gave undefined, so every inbound army totalled 0 and the junk
  // filter threw away real attacks.
  const troop = a.troop || a.troops || {};
  let total = 0, known = true, any = false;
  for (const v of Object.values(troop)) {
    const s = String(v ?? '').trim().replace(/[,\s]/g, '');
    if (!/^\d+$/.test(s)) { if (v !== undefined && v !== null) known = false; continue; }
    total += parseInt(s, 10); any = true;
  }
  return {
    armyId: a.armyId, missionType: a.missionType, direction: a.direction,
    king: a.king, alliance: a.alliance, hero: a.hero,
    from: a.startPosName, startFieldId: a.startFieldId, targetFieldId: a.targetFieldId,
    startTime: a.startTime, reachTime: a.reachTime,
    // the per-type counts as sent: gatepolicy tells a scout bomb by them
    troop: troop && typeof troop === 'object' ? troop : {},
    troops: any ? total : null,       // null = genuinely unknown, NOT zero
    known: any && known,
    raw: a,
  };
}

// castleId -> the hostile armies inbound to that city (every city has a list).
function incomingByCity(game, armies) {
  const out = {}, byField = new Map();
  for (const c of (game && game.castles) || []) {
    const id = game.castleId(c);
    out[id] = [];
    const f = Number(c.fieldId);
    if (Number.isFinite(f)) byField.set(f, id);
  }
  for (const a of armies || []) {
    if (!a) continue;
    const d = Number(a.direction);
    if (d === 2 || d === 3) continue;
    const id = byField.get(Number(a.targetFieldId));
    if (id !== undefined) out[id].push(inboundArmy(a));
  }
  return out;
}

const countsOf = (incoming) => Object.fromEntries(Object.entries(incoming || {}).map(([k, v]) => [k, (v || []).length]));

// Each defence item through its own game command (game.js useDefenceItem).
// A use counts only once the server says ok.
async function useDefenceItem(g, castle, a, cityState) {
  const r = await g.useDefenceItem(g.castleId(castle), a.itemId);
  if (r && r.ok === 1) {
    const d = (cityState.defence = cityState.defence || {});
    (d.used = d.used || {})[a.item] = Date.now();
  }
  return r;
}

// Hiding and the gate race a wave's arrival (Engine.urgentWar).
const URGENT_PLANS = ['hiding', 'gate'];
// The report's entries that run in blocks of their own in focus, not through
// runPlanActions (hiding, the gate and defensepolicy ran first, in urgentWar).
const OWN_BLOCKS = new Set(['troop', 'fort', 'build', 'research', 'mayor', 'acted', 'city', 'defense', ...URGENT_PLANS]);
// defensepolicy (Speech Text, the truce, the horns) runs in urgentWar too,
// right after hiding and the gate: ahead of comfort and outside the slice's
// action budget, and in every war pass (the user, 2026-09-18: Speech Text
// first, then the truce, then comfort). A war pass is woken when a wave lands
// or leaves the list, and when a city's loyalty falls to a defence line
// (noteHostile, noteLoyalty), so a truce goes in the first gap in seconds.
// The pass looks this long after a wave lands: the loyalty push that follows
// a battle comes a moment after the army leaves the list.
const DEFENCE_SETTLE_MS = 1500;
// A city's defensepolicy loyalty lines: { top, junk } — the highest of
// /usetruce and /usespeech, and the /junktroop size under which an attack is
// junk (goalmods.js defensePlan) — or null with neither line.
function defenceLines(goals) {
  const g = (goals || []).find((x) => x.name === 'defensepolicy');
  if (!g) return null;
  const sw = g.switches || {};
  const lines = ['usetruce', 'usespeech'].filter((k) => sw[k] !== undefined).map((k) => Number(sw[k]));
  if (!lines.length) return null;
  return { top: Math.max(...lines), junk: sw.junktroop !== undefined ? n(sw.junktroop) : 1000 };
}
// an inbound army that counts as an attack under those lines (size unknown counts)
const realAttack = (a, lines) => a.troops === null || a.troops === undefined || n(a.troops) >= lines.junk;
// server time as hh:mm:ss (UTC), for the wave log
const clock = (ms) => new Date(ms).toISOString().slice(11, 19);

// Something backed off is not tried, costs no action and writes no log line
// every tick: the plan's note says what is held and until when.
const heldBack = (list) => (list.length ? `; held back: ${list.slice(0, 3).join('; ')}${list.length > 3 ? ` (+${list.length - 3} more)` : ''}` : '');
// A war pass lands this long after the moment it was woken for, so the wave is
// already inside (or already out of) the window when the plan looks.
const WAKE_SLACK_MS = 250;

// ---------------------------------------------------------------- the engine
class Engine {
  constructor(game, log = console.log, accountId = null) {
    this.accountId = accountId;
    this.game = game;
    this.log = log;
    // Set by the console: its manual per-city settings (Gate Control, War Town
    // Mode) for a castle. Absent under goalsd and the tests, where goals rule alone.
    this.controlsFor = null;
    this.state = loadState(accountId);
    this.migrateStateKeys();
    this.running = false;
    this.dryRun = true;
    this.maxActionsPerSlice = 3;
    this.lastReport = {};
    this.incoming = {};          // castleId -> inbound hostile armies (incomingFor)
    this.unitTimes = {};         // castleId -> { at, unit } — see readTraining
    // Marches sent that the server has not listed back yet (rally.js). They
    // hold their rally slot, troops and load until it does.
    this.pendingMarches = [];
    // The war clock (nextWakeAt): each city's goals as the last slice read
    // them, and the server time its hiding and gate were last asked.
    this.goalsSeen = {};
    this.warCheckedAt = {};
    // castleId -> server time a defence item may be due there (noteHostile,
    // noteLoyalty): a war-clock moment like the others
    this.defenceDue = {};
    // castleId -> its hostile armies and loyalty as last seen, and the server
    // time its last wave landed — for the wave log (noteHostile, noteLoyalty)
    this.hostileLists = {};
    this.loyaltySeen = {};
    this.lastWaveAt = {};
    // Set by the console: a changed hostile army list may need a war pass
    // before the next tick.
    this.onHostile = null;

    // Hostile armies, account-wide (inboundArmy above). defensepolicy, hiding,
    // the gate and warrules all read them per city through incomingFor.
    if (game && game.c) {
      this.enemyArmies = [];
      game.c.on('cmd', (cmd, data) => {
        if (cmd !== 'server.EnemyArmysUpdate' || !data) return;
        this.enemyPushed = true;
        this.enemyArmies = data.armys || data.armies || [];
        this.noteHostile();
        if (typeof this.onHostile === 'function') { try { this.onHostile(); } catch {} }
      });

      // Our OWN marches. army.newArmy replies without an armyId, so a recall
      // (hiding's early return, wartown's recall-all) can only get one from here.
      this.selfArmies = [];
      game.c.on('cmd', (cmd, data) => {
        if (cmd !== 'server.SelfArmysUpdate' || !data) return;
        this.armiesPushed = true;
        this.selfArmies = (data.armys || data.armies || []).map((a) => ({
          armyId: a.armyId, missionType: a.missionType, direction: a.direction,
          targetFieldId: a.targetFieldId, startFieldId: a.startFieldId,
          reachTime: a.reachTime, restTime: a.restTime, raw: a,
        }));
      });
    }
  }

  // A city runs its own goals and no other city's (db.goals.own). The first
  // time a city is seen it takes a copy of the default it used to fall through to.
  // After them run the account's global goals, the Prepend goals and then the
  // Append goals, each yielding to what came before (goallayers.js), and last
  // any goal lines a script ran here
  // (the script goal layer, in memory); null only when nothing is left.
  goalsFor(id, name) {
    return runningGoals(D.goals, this.accountId, id, name);
  }

  // Engine state used to be kept under each city's NAME. Names are not unique —
  // a new city takes the server's default name — so two such cities shared one
  // set of backoffs, builder holds and comfort timers. It is keyed by castle id
  // now. What was saved under a name is moved, once per account, to the current
  // city (or cities) of that name, each keeping a copy of what they shared, and
  // the name row is dropped from the database so the next load does not bring
  // it back. A marker then says the state is keyed by id, so a later city that
  // happens to carry an old name never inherits what is left under it. A name
  // that is also a castle id, and the keys that are not cities, are left alone.
  // Returns how many names were moved.
  migrateStateKeys() {
    const g = this.game;
    if (!g || !Array.isArray(g.castles) || !g.castles.length || !this.state || typeof g.castleId !== 'function') return 0;
    if (this.state[KEYED_BY] === 'castleId') return 0;
    this.state[KEYED_BY] = 'castleId';
    const ids = new Set(g.castles.map((c) => String(g.castleId(c))));
    const byName = new Map();
    for (const c of g.castles) {
      const name = c.name === undefined || c.name === null ? '' : String(c.name);
      if (!name || ids.has(name) || NOT_CITY_STATE.has(name)) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(String(g.castleId(c)));
    }
    const moved = [];
    for (const [name, list] of byName) {
      const old = this.state[name];
      if (!old || typeof old !== 'object') continue;
      // a city that already has state under its id keeps that, the newer one
      for (const id of list) if (!this.state[id]) this.state[id] = list.length > 1 ? JSON.parse(JSON.stringify(old)) : old;
      delete this.state[name];
      moved.push(name);
    }
    try {
      if (moved.length) D.engineState.remove(moved, this.accountId || '');
      saveState(this.state, this.accountId);
    } catch (e) { this.line(`engine state: could not save the move to castle ids (${e.message})`, { kind: 'sys' }); }
    if (moved.length) {
      this.line(`engine state: moved from city names to castle ids — ${moved.map((nm) => `${nm} -> ${byName.get(nm).join(', ')}`).join('; ')}`, { kind: 'sys' });
    }
    return moved.length;
  }

  // Our own marches. Until the first army push arrives, the login's list is
  // the only one there is — an empty list there would read as "nothing out".
  liveArmies() {
    const g = this.game;
    if (this.armiesPushed) return this.selfArmies;
    return (g && g.player && g.player.selfArmys) || this.selfArmies || [];
  }

  // Hostile armies, account-wide. Until the first push the login's list (kept
  // current by the console's own push handling) is the only one there is, so
  // an attack already on its way when we logged in is seen too.
  hostileArmies() {
    if (this.enemyPushed) return this.enemyArmies || [];
    const g = this.game;
    return (g && g.player && g.player.enemyArmys) || [];
  }

  // castleId -> the hostile armies inbound to that city, matched by the field
  // each one marches on (incomingByCity).
  incomingFor() {
    this.incoming = incomingByCity(this.game, this.hostileArmies());
    return this.incoming;
  }

  // On a hostile push, a city whose inbound armies changed gets one line in
  // the log — not one per push, which comes whenever any army anywhere on the
  // account changes — and its war clock is reset, so its hiding and gate are
  // asked straight away (nextWakeAt): a fast wave can already be inside its
  // lead window when it first shows up.
  noteHostile() {
    const g = this.game;
    if (!g || !Array.isArray(g.castles)) return;
    const incoming = this.incomingFor();
    const seen = (this._hostileSeen = this._hostileSeen || {});
    const now = g.now ? g.now() : Date.now();
    let left = false;
    for (const c of g.castles) {
      const id = g.castleId(c);
      const list = incoming[id] || [];
      const sig = list.map((a) => `${a.armyId ?? ''}@${a.reachTime ?? ''}`).sort().join(',');
      if ((seen[id] || '') === sig) continue;
      seen[id] = sig;
      delete this.warCheckedAt[id];
      // Each wave that left the list: landed (its time was up) or turned back.
      // Its landing time and the loyalty then go in the log; the loyalty the
      // battle leaves follows in noteLoyalty's line.
      const before = this.hostileLists[id] || [];
      this.hostileLists[id] = list;
      const still = new Set(list.map((a) => String(a.armyId)));
      let gone = false;
      for (const a of before) {
        if (still.has(String(a.armyId))) continue;
        left = gone = true;
        const rt = n(a.reachTime);
        const landed = rt > 0 && rt <= now + 2000;
        if (landed) this.lastWaveAt[id] = rt;
        this.line(`wave ${landed ? 'landed' : 'turned back'}: ${a.king || a.from || 'an army'}`
          + `${a.troops !== null && a.troops !== undefined ? ` (${a.troops} troops)` : ''}`
          + `${rt > 0 ? ` ${landed ? 'at' : 'was due'} ${clock(rt)}` : ''} · loyalty ${(c.resource || {}).support ?? '?'}`
          + `${list.length ? ` · ${list.length} more inbound` : ''}`, { city: c.name || String(id), kind: 'sys' });
      }
      // a wave gone: Speech Text or the truce may be due once its loyalty is in
      if (gone && defenceLines((this.goalsSeen[id] || {}).goals)) this.defenceDue[id] = now + DEFENCE_SETTLE_MS;
      if (!list.length) continue;
      const first = Math.min(...list.map((a) => n(a.reachTime) || Infinity));
      this.line(`incoming: ${list.length} hostile army(ies)${Number.isFinite(first) ? `, the first lands in ${dur((first - now) / 1000)}` : ''}`,
        { city: c.name || String(id), kind: 'sys' });
    }
    // The account's last wave gone: a truce can go in now, from any city with
    // defence lines, since the game refuses one while any army marches at us.
    if (left && !Object.values(incoming).some((l) => (l || []).length)) {
      for (const [cid, gs] of Object.entries(this.goalsSeen)) {
        if (defenceLines(gs.goals)) { this.defenceDue[cid] = now + DEFENCE_SETTLE_MS; delete this.warCheckedAt[cid]; }
      }
    }
  }

  // A city's loyalty changed (the console's server.ResourceUpdate; prev = the
  // loyalty before the push). While the city is at war — armies inbound, or a
  // wave landed in the last 30 min — the change goes in the log beside the
  // waves. A fall to or under a defensepolicy line makes a defence item due
  // now, so Speech Text and the truce need not wait for the next tick. True
  // when a war pass is wanted.
  noteLoyalty(castle, prev) {
    const g = this.game;
    if (!g || !castle || typeof g.castleId !== 'function') return false;
    const id = g.castleId(castle);
    const num = (v) => (v === undefined || v === null || v === '' || !isFinite(Number(v)) ? null : Number(v));
    const loy = num((castle.resource || {}).support);
    const was = num(prev) ?? num(this.loyaltySeen[id]);
    this.loyaltySeen[id] = loy;
    if (loy === null || was === null || loy === was) return false;
    const now = g.now ? g.now() : Date.now();
    const wave = n(this.lastWaveAt[id]);
    const inbound = (this.hostileLists[id] || []).length;
    if (inbound || (wave && now - wave < 30 * 60000)) {
      this.line(`loyalty ${was} -> ${loy}${wave ? ` · last wave landed ${clock(wave)}, ${Math.round((now - wave) / 1000)} s ago` : ''}`
        + `${inbound ? ` · ${inbound} inbound` : ''}`, { city: castle.name || String(id), kind: 'sys' });
    }
    const lines = defenceLines((this.goalsSeen[id] || {}).goals);
    if (!lines || loy > lines.top || loy > was) return false;
    this.defenceDue[id] = now;
    delete this.warCheckedAt[id];
    return true;
  }

  // Hiding and the gate race a wave's arrival, so they are planned and sent
  // first in a city's slice — before the mayor, the barracks reads and every
  // other goal — and cost none of the slice's action budget: comfort and two
  // defence items used to spend it in the very tick the hide march was due.
  // A hide march is booked on the rally spot like any other march, so goals
  // later in the slice see its slot, troops and load gone.
  async urgentWar(ctx, castle, cityState, book) {
    const g = this.game;
    const out = { plans: {}, acted: [], hid: false };
    const W = MODULES.find((m) => m.name === './goal-war');
    const at = g.now ? g.now() : Date.now();
    for (const key of W ? URGENT_PLANS : []) {
      const fn = W.mod.plans && W.mod.plans[key];
      if (!fn) continue;
      let p;
      try { p = fn(ctx, cityState, g); } catch (e) {
        out.plans[key] = null;
        out.acted.push(`${W.name} plan "${key}" failed: ${e.message}`);
        continue;
      }
      out.plans[key] = p;
      for (const a of (p && p.actions) || []) {
        const rally = a.kind === 'hideTroops'
          ? { from: castle, kind: R.KIND_BY_MISSION[a.missionType] || 'other', missionType: a.missionType,
              targetFieldId: a.targetPoint, troops: a.troops, resources: a.resources }
          : null;
        if (this.dryRun) {
          out.acted.push(`[plan] ${a.label}`);
          if (rally && book) book.record(rally, false);
          continue;
        }
        const fx = MODULE_EXECUTORS[a.kind];
        if (!fx) { out.acted.push(`${a.label} -> no executor for "${a.kind}"`); continue; }
        try {
          const r = (await fx(g, castle, a, cityState)) || {};
          if (r.ok === 1 && rally) { out.hid = true; if (book) book.record(rally); }
          out.acted.push(`${a.label} -> ${r.ok === 1 ? 'ok' : (r.errorMsg || 'ok=' + r.ok)}`);
        } catch (e) { out.acted.push(`${a.label} -> ${e.message}`); }
      }
    }
    await this.urgentDefence(ctx, castle, cityState, out);
    const cid = g.castleId(castle);
    this.warCheckedAt[cid] = at;
    this.goalsSeen[cid] = { goals: ctx.goals, config: ctx.config };
    return out;
  }

  // defensepolicy's items, planned and sent right after hiding and the gate,
  // in every slice and every war pass: Speech Text first, then the truce, then
  // the horns — ahead of comfort and outside the action budget (the user,
  // 2026-09-18). Each use says how long after the city's last wave it went.
  async urgentDefence(ctx, castle, cityState, out) {
    const g = this.game;
    let p;
    try { p = M.defensePlan(ctx, cityState); } catch (e) {
      out.plans.defense = null;
      out.acted.push(`defensepolicy plan failed: ${e.message}`);
      return;
    }
    out.plans.defense = p;
    const cid = g.castleId(castle);
    for (const a of (p && p.actions) || []) {
      if (this.dryRun) { out.acted.push(`[plan] ${a.label}`); continue; }
      const wave = n(this.lastWaveAt[cid]);
      const serverNow = g.now ? g.now() : Date.now();
      const after = wave ? ` · ${Math.round((serverNow - wave) / 1000)} s after the last wave landed (${clock(wave)})` : '';
      try {
        const r = (await useDefenceItem(g, castle, a, cityState)) || {};
        out.acted.push(`${a.label} -> ${r.ok === 1 ? 'ok' : (r.errorMsg || 'ok=' + r.ok)}${after}`);
      } catch (e) { out.acted.push(`${a.label} -> ${e.message}${after}`); }
    }
  }

  // The next moment (local Date.now() ms) any city's hiding or gate goal has
  // something to decide, or null. The moments come from goal-war's warMoments:
  // a wave entering a lead window, a wave landing, a hide march that may come
  // home, a gate hold running out. One that this engine has asked the city
  // about since is spent, so a launch that failed is not retried in a burst
  // (the regular tick retries it); one already due comes back as now, and a
  // change in a city's inbound armies makes all of its moments due again
  // (noteHostile). The goals are the ones the last slice read.
  nextWakeAt() {
    const W = MODULES.find((m) => m.name === './goal-war');
    const g = this.game;
    if (!W || typeof W.mod.warMoments !== 'function' || !g || !Array.isArray(g.castles)) return null;
    const serverNow = g.now ? g.now() : Date.now();
    const incoming = this.incomingFor();
    let best = null;
    for (const castle of g.castles) {
      const cid = g.castleId(castle);
      const parsed = this.goalsSeen[cid];
      if (!parsed) continue;
      const ctx = {
        game: g, castle, goals: parsed.goals, config: parsed.config,
        controls: (this.controlsFor && this.controlsFor(castle)) || {},
        incoming: incoming[cid] || [],
      };
      const since = n(this.warCheckedAt[cid]);
      // city state is keyed by castle id (migrateStateKeys)
      for (const m of W.mod.warMoments(ctx, this.state[String(cid)] || {})) {
        if (m > since && (best === null || m < best)) best = m;
      }
      // defensepolicy: a defence item due (noteHostile, noteLoyalty), and just
      // after each wave lands, when its loyalty push is in
      const lines = defenceLines(parsed.goals);
      if (lines) {
        const due = [n(this.defenceDue[cid]), ...ctx.incoming.filter((a) => realAttack(a, lines))
          .map((a) => (n(a.reachTime) ? n(a.reachTime) + DEFENCE_SETTLE_MS : 0))];
        for (const m of due) if (m > 0 && m > since && (best === null || m < best)) best = m;
      }
    }
    if (best === null) return null;
    return Date.now() + Math.max(0, best + WAKE_SLACK_MS - serverNow);
  }

  // Hiding, the gate and defensepolicy alone, in every city with goals: the pass the console
  // runs between ticks at the moment nextWakeAt names. Nothing else is planned
  // or sent, and only what was sent (or would be, in a dry run) is logged.
  async warPass() {
    const g = this.game;
    const book = this.rallyBook();
    const incoming = this.incomingFor();
    for (const castle of g.castles || []) {
      const cid = g.castleId(castle);
      // every city counts as looked at, so no moment can wake us twice
      this.warCheckedAt[cid] = g.now ? g.now() : Date.now();
      const parsed = this.goalsFor(cid, castle.name);
      if (!parsed) { delete this.goalsSeen[cid]; continue; }
      // state and reports by castle id, log lines by the city's name (focus)
      const key = String(cid);
      const label = castle.name || key;
      const cityState = (this.state[key] = this.state[key] || {});
      cityState.accountId = this.accountId || null;
      const ctx = {
        game: g, castle, goals: parsed.goals, config: parsed.config,
        controls: (this.controlsFor && this.controlsFor(castle)) || {},
        accountId: this.accountId || null,
        incoming: incoming[cid] || [], incomingByCastle: countsOf(incoming),
        selfArmies: this.liveArmies(), rally: book,
      };
      const r = await this.urgentWar(ctx, castle, cityState, book);
      for (const a of r.acted) this.line(a, { city: label, kind: /^\[plan\]/.test(a) ? 'plan' : 'act' });
      // the console's engine view shows the latest word from these two
      const last = this.lastReport[key];
      if (last) {
        for (const [k, p] of Object.entries(r.plans)) last[k] = p;
        if (r.acted.length) last.acted = [...(last.acted || []), ...r.acted];
      }
    }
    saveState(this.state, this.accountId);
  }

  // Any city's goals, read once per slice: transfers send FROM other cities,
  // under those cities' rallypolicy and their own request lines.
  goalsLookup() {
    const g = this.game, seen = new Map();
    return (c) => {
      const id = g.castleId(c);
      if (!seen.has(id)) { const p = this.goalsFor(id, c.name); seen.set(id, p ? p.goals : null); }
      return seen.get(id);
    };
  }

  // Any city's War Town mode right now (0 when not locked down): its own
  // `config wartown:` and wartownpolicy, with the console's War Town Mode on
  // top. Transfers ask it about the city that would send; the traininghero
  // about the city it would leave.
  warTownLookup() {
    const g = this.game, seen = new Map();
    const W = MODULES.find((m) => m.name === './goal-war');
    return (c) => {
      if (!W || !c) return 0;
      const id = g.castleId(c);
      if (!seen.has(id)) {
        const p = this.goalsFor(id, c.name);
        const controls = (this.controlsFor && this.controlsFor(c)) || {};
        seen.set(id, W.mod.isWarTown({ game: g, castle: c, config: (p && p.config) || {}, goals: (p && p.goals) || [], controls }));
      }
      return seen.get(id);
    };
  }

  // Every city's rally slots, for this slice: live marches plus the ones sent
  // and not yet listed, against each city's Rally Spot and its rallypolicy.
  rallyBook(goalsOf = this.goalsLookup()) {
    return R.rallyBook({ game: this.game, armies: () => this.liveArmies(), pending: this.pendingMarches, goalsOf });
  }

  // The console files each line under its city and a kind (plan = thinking,
  // act = something was sent). A plain (m) => … logger — goalsd, the tests —
  // takes one argument, so it gets the old "[City] text" line instead.
  line(text, meta) {
    if (TROOP_TRACE && TROOP_TRACE_LINE.test(text)) console.log(`[troops ${stamp()}] ${meta && meta.city ? `[${meta.city}] ` : ''}${text}`);
    if (this.log.length >= 2) return this.log(text, meta);
    return this.log(meta && meta.city ? `[${meta.city}] ${text}` : text);
  }

  // What the barracks already hold, and how long one of each troop takes to
  // train here right now. The server pushes neither, so ask before planning.
  // The per-unit time (TroopProduceListBean.conditionBean.time, seconds) has the
  // mayor, research and buffs already applied: it is what the enlist screen
  // multiplies by the batch size (SWEnlist.as). Only those change it, so it is
  // kept a few minutes, and re-read whenever the mayor changes — `fresh` for the
  // engine's own swap, before the hero update has been pushed.
  async readTraining(castle, fresh = false) {
    const g = this.game;
    const cid = g.castleId(castle);
    const barracks = (castle.buildings || []).filter((b) => b.typeId === 2)
      .map((b) => ({ positionId: Number(b.positionId), capacity: Math.max(1, n(b.level)), items: [] }));
    if (!barracks.length) return { barracks, unit: {}, error: 'no barracks in this city' };
    try {
      const q = await g.req('troop.getProduceQueue', { castleId: cid });
      if (!q || q.ok !== 1) return { barracks, unit: {}, error: `barracks queue unreadable (${(q && q.errorMsg) || 'no reply'})` };
      for (const bq of q.allProduceQueue || []) {
        const b = barracks.find((x) => x.positionId === Number(bq.positionId));
        // ProduceBean: queueId (what a cancel names), and costTime, the batch's
        // whole training time in seconds, fixed when it was queued (Barrack.as
        // adds them up for the queue's total) — troopdelbadque compares it
        if (b) {
          b.items = (bq.allProduceQueue || []).map((p) => ({
            type: Number(p.type), num: n(p.num),
            queueId: p.queueId === undefined || p.queueId === null ? null : Number(p.queueId),
            costTime: p.costTime === undefined || p.costTime === null ? null : n(p.costTime),
          }));
        }
      }

      const mayor = (castle.heros || []).find((h) => Number(h.status) === 1);
      const mayorId = mayor ? mayor.id : null;
      let cached = this.unitTimes[cid], readNow = false;
      if (fresh || !cached || cached.mayorId !== mayorId || Date.now() - cached.at > UNIT_TIME_TTL) {
        readNow = true;
        // the highest barracks unlocks the most troop types
        const top = barracks.reduce((a, b) => (b.capacity > a.capacity ? b : a));
        const l = await g.req('troop.getTroopProduceList', { castleId: cid, positionId: top.positionId });
        const list = (l && l.ok === 1 && l.troopList) || [];
        if (!list.length) return { barracks, unit: {}, error: `training times unreadable (${(l && l.errorMsg) || 'no troop list'})` };
        const unit = {};
        for (const t of list) {
          const time = t.conditionBean && t.conditionBean.time;
          const def = TROOP_BY_TYPE[Number(t.typeId)];
          // no time given: assume the unmodified base, the slowest it can be
          unit[Number(t.typeId)] = {
            time: time == null ? n(def && def.buildTime) : n(time),
            ...troopAllowed(t),
          };
        }
        cached = this.unitTimes[cid] = { at: Date.now(), mayorId, unit };
      }
      // readNow: the times were read just now, under mayorName (as the city's
      // hero list has it; the engine names its own new mayor itself)
      return { barracks, unit: cached.unit, readNow, mayorName: mayor ? mayor.name : null };
    } catch (e) {
      return { barracks, unit: {}, error: e.message };
    }
  }

  // The Walls level and what the Walls queue holds. Queued fortifications take
  // fortified space and count toward the goal, and the server does not push the
  // queue, so ask. Same reply shape as the barracks queue (ProduceQueueResponse).
  async readWalls(castle) {
    const g = this.game;
    const level = wallsLevel(castle);
    try {
      const q = await g.req('fortifications.getProduceQueue', { castleId: g.castleId(castle) });
      if (!q || q.ok !== 1) return { level, queue: [], error: `wall queue unreadable (${(q && q.errorMsg) || 'no reply'})` };
      const queue = [];
      for (const bq of q.allProduceQueue || []) {
        for (const p of bq.allProduceQueue || []) queue.push({ type: Number(p.type), num: n(p.num) });
      }
      return { level, queue };
    } catch (e) {
      return { level, queue: [], error: e.message };
    }
  }

  // Whether the city is under attack, by goal-war's reckoning (wiki
  // DefenseCooldown: while a real wave is inbound, and for defensecooldown after
  // the last lands; junk under defensepolicy /junktroop never counts), and which
  // attack it is: the first wave of the first attack group (wiki AttackGap), so
  // the emergency walls go once an attack. defensepolicy and the constraints
  // plan keep the same record; asking again in a slice is harmless.
  underAttackOf(ctx, cityState) {
    const W = MODULES.find((m) => m.name === './goal-war');
    if (!W || typeof W.mod.underAttack !== 'function') return null;
    try {
      const u = W.mod.underAttack(ctx, cityState);
      const first = u.attacks && u.attacks.groups && u.attacks.groups[0];
      const a = first && first.waves && first.waves[0];
      const key = a ? (a.armyId !== undefined && a.armyId !== null ? `id:${a.armyId}` : `at:${a.from}@${a.reachTime}`)
        : n(u.inbound) > 0 ? 'untimed' : null;
      return { on: !!u.on, inbound: n(u.inbound), key };
    } catch {
      return null;
    }
  }

  // Research levels for a build line's ?condition? (build ?met:10?q:0:0). The
  // server lists them per city (tech.getResearchList, AvailableResearchListBean:
  // typeId, level). Read at most every 10 minutes, only while a condition asks,
  // and kept in the city's state so the console's outlook tests the same
  // levels. A level once researched stays, so an older reading is still a safe
  // floor when a read fails.
  //
  // Step 16: the research goal reads the same list through readResearch, with
  // `beans` (it wants each tech's whole bean, kept here in memory only: the
  // city's state keeps the levels), its own `maxAge`, and `force` once what was
  // running here has ended. `until` is the end of the research the list shows
  // running in this city, `tops` the city's building levels it was read against.
  async readTechs(castle, cityState = {}, { maxAge = TECH_TTL, beans: whole = false, force = false } = {}) {
    const g = this.game;
    const cid = g.castleId(castle);
    this.techLevels = this.techLevels || {};
    const had = this.techLevels[cid] || cityState.techs || null;
    // a read that failed is not asked again sooner than a good one would be
    if (!force && had && Date.now() - n(had.at) < maxAge && (!whole || had.beans || had.error)) return had;
    let out;
    try {
      const r = await g.req('tech.getResearchList', { castleId: cid });
      const beans = r && (r.acailableResearchBeans || r.availableResearchBeans);
      if (!r || r.ok !== 1 || !Array.isArray(beans)) throw new Error((r && r.errorMsg) || 'no research list');
      // the same list says what is being researched, for the free finish (speedups.js)
      if (typeof g.noteResearchList === 'function') g.noteResearchList(cid, r);
      const levels = {};
      for (const t of beans) levels[Number(t.typeId)] = n(t.level);
      const here = beans.find((t) => t && t.upgradeing && Number(t.castleId) === Number(cid));
      // the buildings it was read against: one of them raised since makes its
      // answer out of date for the research goal (RS.raisedSince)
      out = { at: Date.now(), levels, beans, academyCount: r.academyCount, until: here ? n(here.endTime) || 1 : 0,
        tops: RS ? RS.topsOf(castle) : null };
    } catch (e) {
      // the last beans stay for the buildings they ask for; nothing starts on them
      out = { at: Date.now(), levels: (had && had.levels) || null, beans: (had && had.beans) || null,
        error: `research list unreadable: ${e.message}` };
    }
    this.techLevels[cid] = out;
    cityState.techs = { at: out.at, levels: out.levels, ...(out.error ? { error: out.error } : {}) };
    return out;
  }

  // Step 16: the research list for the research goal (goal-research.js), read
  // only when a decision is due. While a research runs here there is none to
  // make, and nothing is read. Once what ran here (by the list, or started by
  // the engine) has ended, the list is out of date and is read again; so it is
  // once a building a target waited for has gone up. Otherwise it is read at
  // most every RESEARCH_TTL while a target is open, every COND_TTL while only a
  // ?condition? naming research holds one back, and not at all once every
  // target is met (RS.readEvery). `fresh` asks for a list read within the last
  // minute: a start goes on nothing older.
  async readResearch(castle, cityState, ctx, { fresh = false } = {}) {
    const g = this.game;
    const cid = g.castleId(castle);
    const had = this.techLevels && this.techLevels[cid];
    const now = typeof g.now === 'function' ? g.now() : Date.now();
    const running = RS.runningLive(typeof g.runningResearch === 'function' ? g.runningResearch(cid) : null, now);
    const ended = !!(had && had.until && !running);
    if (!fresh && !ended && had && had.beans) {
      // running (a script's or the console's start too): read again once it ends
      if (running) { had.until = had.until || 1; return had; }
      const every = RS.readEvery(ctx, had, cityState);
      if (every === null || Date.now() - n(had.at) < every) return had;
      return this.readTechs(castle, cityState, { beans: true, force: true });
    }
    return this.readTechs(castle, cityState, { maxAge: fresh ? RS.START_FRESH : RS.RESEARCH_TTL, beans: true, force: ended });
  }

  // Step 11: what the builder's next order needs, read before it is placed,
  // and any prerequisite put first (resolvePrereqs). At most PREREQ_READS
  // reads a slice; each is kept COND_TTL, and all of a city's are dropped the
  // moment its buildings change (buildingsSig). Nothing is read while the
  // builder is busy. Sets ctx.buildReserve — the cost troop and wall batches
  // leave in the bank — and ctx.researchWants, and keeps the wants and the
  // outcome in the city's state for a research goal and the console:
  //   cityState.researchWants  [{techId, level, have, name, for, at}]
  //   cityState.prereq         {at, sig, next, wait, stop, passed}
  async resolveBuild(ctx, castle, cityState, plan) {
    ctx.buildReserve = null;
    // Step 16: the buildings the research goal needs go first (resolvePrereqs);
    // ctx.researchBuildBlocked says which of them cannot go now, and why
    ctx.researchBuildBlocked = [];
    const forResearch = (plan && !plan.paused && ctx.researchBuildWants) || [];
    const work = !!plan && !plan.paused && (plan.ranked.length > 0 || forResearch.length > 0);
    const waiting = work && (plan.busy || n(cityState.builderHeld) > Date.now());
    if (!work || waiting) {
      // while the builder works the last word stands; with nothing to build it is gone
      if (!waiting) { delete cityState.researchWants; delete cityState.prereq; }
      ctx.researchWants = cityState.researchWants || [];
      return plan;
    }
    const g = this.game;
    const cid = g.castleId(castle);
    const sig = buildingsSig(castle);
    this.conditions = this.conditions || {};
    let cache = this.conditions[cid];
    if (!cache || cache.sig !== sig) cache = this.conditions[cid] = { sig, beans: new Map() };
    const conds = (k) => {
      const e = cache.beans.get(k);
      return e && Date.now() - e.at < (e.error ? COND_ERROR_TTL : COND_TTL) ? e : undefined;
    };
    const items = g.player && Array.isArray(g.player.items) ? g.player.items : null;
    // research levels the engine has read (Engine.readTechs): a level once
    // reached stays, so they can only show a tech done since a read
    const techLevels = (ctx.techs && ctx.techs.levels) || (cityState.techs && cityState.techs.levels) || null;
    let r;
    try {
      for (let reads = 0; ; reads++) {
        r = resolvePrereqs({ plan, castle, conds, cityState, items, techLevels, forResearch });
        if (!r.need || reads >= PREREQ_READS) break;
        const got = await readCondition(g, cid, r.need);
        cache.beans.set(condKey(r.need), { at: Date.now(), cond: got.cond || null, error: got.error || null });
      }
    } catch (e) {
      // A fault here must not stop construction: the first order not backed
      // off goes, unchecked, as it did before requirements were read.
      const first = plan.ranked.find((a) => !blocked(cityState, buildKey(a))) || null;
      return { ...plan, pick: first, held: [], note: `${plan.note}; requirements not checked (${e.message})` };
    }
    const at = Date.now();
    const next = r.pick || (r.hold && r.hold.action) || null;
    const reserve = r.hold ? { ...r.hold.cost, label: buildLabel(r.hold.action) }
      : r.pick && r.cost && Object.keys(r.cost).length ? { ...r.cost, label: buildLabel(r.pick) } : null;
    ctx.buildReserve = reserve;
    if (r.wants.length) cityState.researchWants = r.wants.map((w) => ({ ...w, at }));
    else delete cityState.researchWants;
    ctx.researchWants = cityState.researchWants || [];
    ctx.researchBuildBlocked = r.research || [];
    const notes = prereqNotes(r);
    cityState.prereq = {
      at, sig,
      next: next ? buildLabel(next) : r.need ? buildLabel(r.needFor) : null,
      wait: r.hold ? notes.find((x) => x.startsWith('waiting for')) || null : r.need ? 'its requirements are read next slice' : null,
      stop: r.stop || null,
      passed: r.skipped.slice(0, 5),
    };
    return { ...plan, pick: r.pick, held: r.held, reserve, researchWants: ctx.researchWants,
      // with no build line, the research goal's building is the only order
      actions: plan.actions.length ? plan.actions : r.pick ? [r.pick] : [],
      note: notes.length ? `${plan.note}; ${notes.join('; ')}` : plan.note };
  }

  // What one of each fortification costs in this city, per unit, and how long
  // one takes to build here (fortifications.getFortificationsProduceList ->
  // fortList[] {typeId, conditionBean}; CastleDefProduce multiplies both by the
  // batch, ProduceBuildingResourceData.reCalcDataArray and :778). Read while
  // wall batches are to be placed, at most every 10 minutes; a failed read is
  // asked again after a minute.
  async readFortCosts(castle) {
    const g = this.game;
    const cid = g.castleId(castle);
    this.fortCostCache = this.fortCostCache || {};
    const had = this.fortCostCache[cid];
    if (had && Date.now() - had.at < (had.costs ? UNIT_TIME_TTL : COND_ERROR_TTL)) return had.costs;
    let costs = null;
    try {
      const r = await g.req('fortifications.getFortificationsProduceList', { castleId: cid });
      const list = (r && r.ok === 1 && r.fortList) || [];
      if (list.length) {
        costs = {};
        for (const f of list) {
          const c = f.conditionBean || {};
          costs[Number(f.typeId)] = { food: n(c.food), wood: n(c.wood), stone: n(c.stone), iron: n(c.iron),
            time: c.time === undefined || c.time === null ? null : n(c.time) };
        }
      }
    } catch {
      costs = null;
    }
    this.fortCostCache[cid] = { at: Date.now(), costs };
    return costs;
  }

  // Put back the production rates troopsusepopmax lowered (runTroops). Kept in
  // the city's state until the server takes them, so a slice cut short, or a
  // refusal, has the next slice put them back first.
  async restoreProduction(castle, mem, acted) {
    const r0 = mem.restore;
    if (!r0) return true;
    const what = `production back to food ${r0.food}%, wood ${r0.wood}%, stone ${r0.stone}%, iron ${r0.iron}%`;
    if (this.dryRun) { acted.push(`[plan] ${what}`); return true; }
    try {
      const g = this.game;
      const r = await g.req('interior.modifyCommenceRate', { castleId: g.castleId(castle),
        foodrate: r0.food, woodrate: r0.wood, stonerate: r0.stone, ironrate: r0.iron });
      const ok = !!(r && r.ok === 1);
      if (ok) delete mem.restore;
      acted.push(`${what} -> ${ok ? 'ok' : (r && r.errorMsg) || 'ok=' + (r && r.ok)}${ok ? '' : ' (asked again next slice)'}`);
      return ok;
    } catch (e) {
      acted.push(`${what} -> ${e.message} (asked again next slice)`);
      return false;
    }
  }

  // wiki TroopsUsePopMax: "use your entire population, by dropping production
  // temporarily". The rates the Town Hall holds are read
  // (interior.getResourceProduceData -> resourceProduceDataBean[] {typeid 1 food,
  // 2 wood, 3 stone, 4 iron; commenceRate}, ResourceProduce.as:1165-1203) and
  // all four are set to 0 (interior.modifyCommenceRate, ResourceProduce.as:918),
  // so every field worker is idle while the batches go in; runTroops puts them
  // back straight after. The workers fields need are
  // maxLabour x commenceRate / 100 of the population less the builders
  // (ResourceProduce.as:707, 1177), so at 0 the whole of it is idle. Returns
  // whether production was lowered.
  async lowerProduction(castle, mem, popmax, acted) {
    const g = this.game;
    const cid = g.castleId(castle);
    const what = `lower production to free ${fmt(popmax.workers)} workers for training (usepopmax ${popmax.share})`;
    if (this.dryRun) { acted.push(`[plan] ${what}, then put it back`); return false; }
    let rates = null;
    try {
      const r = await g.req('interior.getResourceProduceData', { castleId: cid });
      const beans = (r && r.ok === 1 && (r.resourceProduceDataBean || r.resourceProduceDataBeanArray)) || [];
      const by = {};
      for (const b of beans) by[Number(b.typeid)] = b.commenceRate;
      if ([1, 2, 3, 4].every((k) => setting(by[k]) !== null)) rates = { food: n(by[1]), wood: n(by[2]), stone: n(by[3]), iron: n(by[4]) };
      else { acted.push(`${what} -> the production rates could not be read (${(r && r.errorMsg) || 'no rates'}), training from idle population`); return false; }
    } catch (e) {
      acted.push(`${what} -> the production rates could not be read (${e.message}), training from idle population`);
      return false;
    }
    if (!rates.food && !rates.wood && !rates.stone && !rates.iron) return false;   // nobody works the fields
    // written down before the change, so it is put back even if this slice dies
    mem.restore = { ...rates, at: Date.now() };
    try { saveState(this.state, this.accountId); } catch {}
    try {
      const r = await g.req('interior.modifyCommenceRate', { castleId: cid, foodrate: 0, woodrate: 0, stonerate: 0, ironrate: 0 });
      if (!r || r.ok !== 1) {
        delete mem.restore;
        acted.push(`${what} -> ${(r && r.errorMsg) || 'ok=' + (r && r.ok)}, training from idle population`);
        return false;
      }
      acted.push(`${what} (was food ${rates.food}%, wood ${rates.wood}%, stone ${rates.stone}%, iron ${rates.iron}%) -> ok`);
      return true;
    } catch (e) {
      // no answer: it may have gone through, so the rates are put back regardless
      acted.push(`${what} -> ${e.message}`);
      return true;
    }
  }

  // The troop goal's commands for the slice, with their own allowance
  // (TROOP_ORDERS) outside the three actions the other goals share: production
  // left lowered by an earlier slice put back, then at most one bad-queue cancel
  // (troopdelbadque), then the batches — with production lowered around them
  // when troopsusepopmax needs the field workers.
  async runTroops(castle, cityState, plan, acted) {
    const g = this.game;
    const cid = g.castleId(castle);
    const mem = cityState.troopGoal || null;
    if (mem && mem.restore) await this.restoreProduction(castle, mem, acted);
    if (!plan) return;
    if (plan.cancel) {
      const c = plan.cancel;
      if (this.dryRun) acted.push(`[plan] ${c.label}`);
      else {
        const m = troopMemory(cityState);
        // held for the hour whatever the answer: a refusal is not asked every slice
        m.badHold[c.type] = Date.now() + BAD_QUEUE_HOLD;
        try {
          const r = typeof g.cancelTroop === 'function' ? await g.cancelTroop(cid, c.positionId, c.queueId)
            : await g.req('troop.cancelTroopProduce', { castleId: cid, positionId: c.positionId, queueId: c.queueId });
          acted.push(`${c.label} -> ${r && r.ok === 1 ? 'ok, queued again with the right hero next slice' : (r && r.errorMsg) || 'ok=' + (r && r.ok)}`);
        } catch (e) { acted.push(`${c.label} -> ${e.message}`); }
      }
    }
    const orders = (plan.orders || []).slice(0, TROOP_ORDERS);
    if (!orders.length) return;
    const lowered = plan.popmax ? await this.lowerProduction(castle, troopMemory(cityState), plan.popmax, acted) : false;
    try {
      for (const o of orders) {
        const per = o.secs != null ? o.secs / o.num : null;
        const what = (num) => `train ${fmt(num)} ${o.troop.name}${per != null ? ` (~${dur(per * num)})` : ''}${o.idle ? ' in an idle barracks' : ''}`;
        if (this.dryRun) { acted.push(`[plan] ${what(o.num)}`); continue; }
        let pos = o.positionId;
        if (pos === undefined) {
          const barracks = (castle.buildings || []).find((b) => b.typeId === 2);
          if (!barracks) { acted.push('no barracks in this city'); break; }
          pos = barracks.positionId;
        }
        try {
          await orderFitted((num) => g.produceTroop(cid, o.troop.typeId, num, pos), o.num, castle, what, acted);
        } catch (e) { acted.push(`${what(o.num)} -> ${e.message}`); break; }
      }
    } finally {
      if (lowered) await this.restoreProduction(castle, troopMemory(cityState), acted);
    }
  }

  // Research is the account's, not a city's: the list is read through a city,
  // but its levels are the lord's, and only the research running is placed in a
  // city (AvailableResearchListBean.castleId; Technology.as shows the others'
  // under "other castles"). So any city's reading that is still fresh will do,
  // and five farming cities cost one read, not five.
  async accountTechs(castle, cityState = {}) {
    const fresh = Object.values(this.techLevels || {})
      .find((t) => t && t.levels && !t.error && Date.now() - n(t.at) < TECH_TTL);
    return fresh || this.readTechs(castle, cityState);
  }

  // Step 19: every research level the engine has read, from any city (they are
  // the account's) and this city's saved reading, the highest of each — a
  // level once reached stays. null when nothing has been read. Whether a plan
  // line is finished is judged on these (goal-plan.js).
  knownTechLevels(cityState = {}) {
    const out = {};
    const add = (lv) => {
      for (const [k, v] of Object.entries(lv || {})) if (v !== null && v !== undefined) out[k] = Math.max(n(out[k]), n(v));
    };
    for (const t of Object.values(this.techLevels || {})) if (t) add(t.levels);
    add(cityState.techs && cityState.techs.levels);
    return Object.keys(out).length ? out : null;
  }

  // The plan-style goals' actions, sent in report order, `budget` of them at
  // most; returns the budget left. Every plan on the report, not a fixed list —
  // otherwise a war/hero plan gets computed and then silently never executed.
  // troop/fort/build/research/mayor run in their own blocks in focus.
  //
  // A march (an action carrying `rally`) waits while the SENDING city's rally
  // spot or rallypolicy has no slot for it. The plans already ask, but plans
  // are made before anything in this slice is sent, so the book has the last
  // word. Hiding carries no `rally`: getting the army out is never held.
  //
  // Step 19, processingpolicy (processing.js): the missions of the tasks it
  // weighs — npc farming, buildnpc, sendtroops, sendresources, and whatever
  // registers later — go together, where the first of their plans stands on the
  // report, fewest points first: each one sent adds 10/priority points to its
  // task in the state of the city it leaves (for another city's pull, that
  // city's), under that city's processingpolicy. A task turned off is held, even
  // if its own plan did not leave it out. Ties keep the report's order.
  async runPlanActions(report, { castle, cityState, book, budget, goals = [], goalsOf = null, skip = OWN_BLOCKS }) {
    const g = this.game;
    const heldOn = new Map();                // plan -> what waits, for its note
    const hold = (p, text) => { if (!heldOn.has(p)) heldOn.set(p, []); heldOn.get(p).push(text); };
    // one action: 'held' (no rally slot), 'stop' (no action left this slice),
    // 'planned' (a dry run), 'sent', or 'failed'
    const run = async (a, p) => {
      const full = a.rally ? book.check(a.rally) : null;
      if (full) { hold(p, `${a.label}: ${full}`); return 'held'; }
      if (budget-- <= 0) return 'stop';
      if (this.dryRun) {
        report.acted.push(`[plan] ${a.label}`);
        if (a.rally) book.record(a.rally, false);
        return 'planned';
      }
      try {
        let r = { ok: 1 };
        if (a.kind === 'defenceItem') r = (await useDefenceItem(g, castle, a, cityState)) || {};
        else if (a.kind === 'note') { report.acted.push(a.label); return 'noted'; }
        else if (MODULE_EXECUTORS[a.kind]) {
          r = await MODULE_EXECUTORS[a.kind](g, castle, a, cityState);
        } else { report.acted.push(`${a.label} -> no executor for "${a.kind}"`); return 'failed'; }
        if (r.ok === 1 && a.rally) book.record(a.rally);
        report.acted.push(`${a.label} -> ${r.ok === 1 ? 'ok' : (r.errorMsg || 'ok=' + r.ok)}`);
        return r.ok === 1 ? 'sent' : 'failed';
      } catch (e) { report.acted.push(`${a.label} -> ${e.message}`); return 'failed'; }
    };

    // the processingpolicy missions, and the plan they go at
    const queue = [];
    let at = null;
    for (const [key, p] of Object.entries(report)) {
      if (skip.has(key) || !p || typeof p !== 'object' || !Array.isArray(p.actions)) continue;
      for (const a of p.actions) {
        const task = PR ? PR.taskOf(a) : null;
        if (!task) continue;
        queue.push({ a, p, task });
        if (at === null) at = key;
      }
    }
    const queued = new Set(queue.map((x) => x.a));
    const runQueue = async () => {
      const now = g.now ? g.now() : Date.now();
      const here = String(g.castleId(castle));
      const senders = new Map();
      const senderOf = (a) => {
        const from = (a.rally && a.rally.from) || castle;
        const id = String(g.castleId(from));
        if (!senders.has(id)) {
          senders.set(id, {
            id, state: id === here ? cityState : (this.state[id] = this.state[id] || {}),
            goals: id === here ? goals : ((goalsOf && goalsOf(from)) || []),
          });
        }
        return senders.get(id);
      };
      const left = [];
      for (const x of queue) {
        x.s = senderOf(x.a);
        x.prio = PR.priorityNow(x.s.goals, x.task, now);
        if (x.prio > 0) left.push(x);
        else hold(x.p, `${x.a.label}: ${PR.allowed(x.s.goals, x.task, now).why}`);
      }
      const dry = new Map();                 // points a dry run would have added
      const score = (x) => PR.points(x.s.state, x.task, now) + n(dry.get(`${x.s.id}:${x.task}`));
      while (left.length) {
        let best = 0;
        for (let k = 1; k < left.length; k++) if (score(left[k]) < score(left[best]) - 1e-9) best = k;
        const x = left.splice(best, 1)[0];
        const r = await run(x.a, x.p);
        if (r === 'stop') break;
        if (r === 'sent') PR.record(x.s.state, x.task, x.prio, now);
        if (r === 'planned') dry.set(`${x.s.id}:${x.task}`, n(dry.get(`${x.s.id}:${x.task}`)) + PR.WEIGHT / x.prio);
      }
    };

    for (const [key, p] of Object.entries(report)) {
      if (skip.has(key)) continue;
      if (!p || typeof p !== 'object' || !p.actions) continue;
      if (key === at) await runQueue();
      for (const a of p.actions) {
        if (queued.has(a)) continue;
        if ((await run(a, p)) === 'stop') break;
      }
    }
    for (const [p, list] of heldOn) p.note = (p.note || '') + heldBack(list);
    return budget;
  }

  // wiki FortificationGoal: under attack, 1 of each type on the first line
  // "with emergency priority" — ahead of every other goal this slice, and
  // outside the action budget. Each type is tried once per attack.
  async emergencyWalls(castle, cityState, fort, acted) {
    const g = this.game;
    if (!fort || !fort.emergency || !fort.emergency.length) return;
    for (const o of fort.emergency) {
      const what = `emergency: build 1 ${o.wall.name} (under attack)`;
      if (this.dryRun) { acted.push(`[plan] ${what}`); continue; }
      const rec = cityState.fortEmergency && cityState.fortEmergency.key === o.key ? cityState.fortEmergency : { key: o.key, done: [] };
      cityState.fortEmergency = rec;
      rec.at = Date.now();
      if (!rec.done.includes(o.wall.typeId)) rec.done.push(o.wall.typeId);
      try {
        const r = await g.produceWall(g.castleId(castle), o.wall.typeId, 1);
        acted.push(`${what} -> ${r && r.ok === 1 ? 'ok' : (r && r.errorMsg) || 'ok=' + (r && r.ok)}`);
      } catch (e) { acted.push(`${what} -> ${e.message}`); }
    }
  }

  // schedulepolicy (processing.js), outside the city's hours: only its defence
  // acts. Hiding and the gate already ran (urgentWar); here the emergency walls
  // while an attack is inbound (FortificationGoal), the defence items
  // (defensepolicy) and goal-war's other plans — the war town recall, warrules,
  // the embassy — are planned and sent, the last two within the slice's budget.
  // Nothing else is read, planned or sent: no training, wall batches,
  // construction, research, mayor, comfort or other upkeep, hero, farming,
  // buildnpc, valley, transfer, market or report work, and no free finish.
  async offHours({ castle, ctx, cityState, urgent, sched, key, label, book, goalsOf }) {
    const g = this.game;
    const report = { city: label, schedule: { note: sched.note }, acted: urgent.acted };
    // the emergency walls: an attack does not wait for the city's hours either
    if (ctx.goals.some((x) => x.name === 'fortification')) {
      ctx.underAttack = this.underAttackOf(ctx, cityState);
      if (ctx.underAttack && ctx.underAttack.inbound > 0) {
        ctx.fortEmergency = cityState.fortEmergency || null;
        ctx.walls = await this.readWalls(castle);
        const fort = fortPlan(ctx);
        if (fort && fort.emergency && fort.emergency.length) {
          report.fort = { note: `fortification: under attack — the emergency walls go, outside the hours too`, emergency: fort.emergency };
          await this.emergencyWalls(castle, cityState, fort, report.acted);
        }
      }
    }
    report.defense = urgent.plans.defense;      // sent at the top of the slice (urgentDefence)
    const W = MODULES.find((m) => m.name === './goal-war');
    for (const [k, fn] of Object.entries((W && W.mod.plans) || {})) {
      try {
        const p = k in urgent.plans ? urgent.plans[k] : fn(ctx, cityState, g);
        if (p) report[k] = p;
      } catch (e) { report.acted.push(`${W.name} plan "${k}" failed: ${e.message}`); }
    }
    await this.runPlanActions(report, { castle, cityState, book, budget: this.maxActionsPerSlice, goals: ctx.goals, goalsOf });
    cityState.lastFocus = Date.now();
    this.state[key] = cityState;
    saveState(this.state, this.accountId);
    report.at = Date.now();
    report.dryRun = this.dryRun;
    this.lastReport[key] = report;
    return report;
  }

  async focus(castle) {
    const g = this.game;
    // State and reports are kept by castle id (see migrateStateKeys); the name
    // is what the log files the city's lines under.
    const key = String(g.castleId(castle));
    const label = castle.name || key;
    const controls = (this.controlsFor && this.controlsFor(castle)) || {};
    const parsed = this.goalsFor(g.castleId(castle), castle.name);
    if (!parsed) {
      // A manual gate needs no goal file to be held — but nothing else may run
      // here: the mayor plan, for one, acts even when no goals are written.
      if (controls.gate === 'open' || controls.gate === 'closed') return this.holdGate(castle, key, controls);
      const layer = getScriptLayer(this.accountId, g.castleId(castle));
      return { city: label, note: layer ? `no goals set — ${scriptNote(layer)}` : 'no goals set' };
    }
    // War Town Mode on the console overrides `config wartown:` for this city;
    // Auto (or nothing set) leaves whatever the goals say.
    if (controls.wartown !== undefined && controls.wartown !== null && controls.wartown !== 'auto') {
      parsed.config.wartown = Number(controls.wartown);
    }

    // castle.fortification is an object keyed by beanKey, e.g. {"abatis":1418,...}
    const fortifications = {};
    for (const w of C.WALLS) fortifications[w.code] = n((castle.fortification || {})[w.beanKey]);

    const cityState = (this.state[key] = this.state[key] || {});
    cityState.accountId = this.accountId || null;   // executors read it from here
    const goalsOf = this.goalsLookup();
    const book = this.rallyBook(goalsOf);
    // the account's hostile armies, grouped by the city each one marches on
    const incoming = this.incomingFor();
    // Step 19: the plan line in work, as a build and a research line ahead of
    // the city's own (goal-plan.js); finished or not by the research levels
    // the engine has read so far (research is the account's)
    const planned = PL ? PL.expand(parsed, castle, this.knownTechLevels(cityState)) : { goals: parsed.goals, plan: null };
    const ctx = {
      game: g, castle, goals: planned.goals, config: parsed.config, fortifications,
      controls,
      // buildnpc's registry is keyed by account; without this it stands down
      // rather than guess which account a city belongs to.
      accountId: this.accountId || null,
      incoming: incoming[g.castleId(castle)] || [],
      // our own marches, so hiding/wartown can recall by armyId
      selfArmies: this.liveArmies(),
      // rally slots in every city, and any city's goals
      rally: book, goalsOf,
      // any city's War Town mode (goal-transfer asks about its senders)
      warTownOf: this.warTownLookup(),
      // how many armies are inbound to each of our cities (by castle id) —
      // hiding uses this to avoid running INTO a city that is itself under attack
      incomingByCastle: countsOf(incoming),
      // when the console last came back from maintenance: goal-npc forgets its
      // farming history then (wiki Npc)
      maintEndedAt: this.maintEndedAt || 0,
    };
    // Hiding and the gate first, ahead even of the reads below (urgentWar).
    const urgent = await this.urgentWar(ctx, castle, cityState, book);
    // schedulepolicy (processing.js): outside the city's hours only its
    // defence acts, and nothing below is read or planned
    const sched = PR ? PR.scheduleAt(parsed.goals, g.now ? g.now() : Date.now()) : null;
    if (sched && !sched.on) return this.offHours({ castle, ctx, cityState, urgent, sched, key, label, book, goalsOf });
    // Free finishes next (speedups.js): a job started since the last slice
    // that the game finishes for free is done before the plans look at the city,
    // so the builder is free for this slice's plan.
    const freeSeen = new Set();
    const freeFirst = await this.freeSpeed(castle, parsed.config, cityState, freeSeen);
    const troops = parsed.goals.some((x) => x.name === 'troop') && parsed.config.troop !== 0;
    if (troops) {
      ctx.training = await this.readTraining(castle);
      // how fast the city trains under this mayor, kept for when the
      // traininghero is away (troopidlequeuetime)
      if (ctx.training.readNow) noteHeroTimes(cityState, ctx.training.mayorName, ctx.training);
      ctx.troopMemory = troopMemory(cityState);
      ctx.trainer = trainerOf(g, castle, parsed.goals, cityState);
    }
    // A day of the troops' upkeep (the queued troops' too): the troop and wall
    // batches keep it in the granary (TroopsUseReserved, FortsUseReserved), and
    // so does comfort's food (goal-upkeep shortOf).
    ctx.foodDay = FOOD_DAY_HOURS * upkeepPerHour(ctx);
    // Under attack? The reserved barracks (reservedbarrack) and the emergency
    // walls (FortificationGoal) act on it.
    if (troops || parsed.goals.some((x) => x.name === 'fortification')) ctx.underAttack = this.underAttackOf(ctx, cityState);
    ctx.fortEmergency = cityState.fortEmergency || null;
    // The Walls queue is only read when what already stands falls short, or an
    // attack is inbound (the emergency needs its free slots).
    let fort = fortPlan(ctx);
    if (fort && !fort.paused && (!fort.done || (ctx.underAttack && ctx.underAttack.inbound > 0))) {
      ctx.walls = await this.readWalls(castle);
      fort = fortPlan(ctx);
    }
    // A build line's ?condition? may name a research level (build ?met:10?...).
    if (parsed.config.building !== 0 && parsed.goals.some((x) => x.name === 'build' && x.needsTech)) {
      ctx.techs = await this.readTechs(castle, cityState);
    }
    // Step 16: the research goal (goal-research.js), planned twice around the
    // builder. First for the buildings it needs, which the builder takes on
    // before its own lines (resolveBuild), with the techs the build lines asked
    // for last slice; its list is read only when a decision is due
    // (readResearch), and its levels serve the build lines' conditions and NPC
    // farming's research check below too. Every one of these reads goes through
    // readTechs, into the one cache (this.techLevels) accountTechs looks in.
    let research = null;
    if (RS) {
      ctx.researchWants = cityState.researchWants || [];
      // the plan line's research counts as a research line (Step 19)
      if (RS.listNeeded({ ...parsed, goals: ctx.goals }, cityState)) {
        ctx.research = await this.readResearch(castle, cityState, ctx);
        if (ctx.research && ctx.research.levels) ctx.techs = ctx.research;
      }
      research = RS.researchPlan(ctx, cityState, g);
      ctx.researchBuildWants = (research && research.buildWants) || [];
    }
    // NPC farming at levels 1-5 needs them too (wiki FAQ: Military Tradition,
    // Archery, Horseback Riding — goal-npc researchCheck).
    if (!ctx.techs && NPC_MOD && NPC_MOD.needsResearch(parsed.config)) ctx.techs = await this.accountTechs(castle, cityState);
    // The builder's next order, its requirements read and any prerequisite put
    // first; its cost stays out of the troop and wall batches sized below.
    const build = await this.resolveBuild(ctx, castle, cityState, buildPlan(ctx, (fort && fort.wallsFor) || 0));
    // ...then for the research itself, now the builder has said what it keeps
    // in the bank and which techs its own orders need (ctx.researchWants). A
    // start goes on a list read within the minute: tech.research names no
    // level, so a level another city finished since the last read would be
    // researched past its goal. What the research takes or waits for stays out
    // of the troop and wall batches too.
    if (RS && (research || (ctx.researchWants || []).length)) {
      research = RS.researchPlan(ctx, cityState, g);
      if (research && research.actions.length && !RS.freshForStart(ctx.research)) {
        ctx.research = await this.readResearch(castle, cityState, ctx, { fresh: true });
        if (ctx.research && ctx.research.levels) ctx.techs = ctx.research;
        research = RS.researchPlan(ctx, cityState, g);
      }
      // still no list read within the minute: nothing starts this slice
      if (research && research.actions.length && !RS.freshForStart(ctx.research)) research.actions = [];
      if (research && research.reserve) ctx.buildReserve = RS.mergeReserve(ctx.buildReserve, research.reserve);
    }
    if (research && research.buildWants && research.buildWants.length) cityState.researchBuildWants = research.buildWants;
    else delete cityState.researchBuildWants;
    // What one of each fortification costs and takes here: for the batch length
    // (wallqueuetime), the day of food (fortsusereserved) and the reserve above.
    if (fort && fort.orders && fort.orders.length) {
      ctx.fortCosts = await this.readFortCosts(castle);
      fort = fortPlan(ctx);
    }
    const report = {
      city: label,
      troop: troopPlan(ctx), fort, build,
      comfort: M.comfortPlan(ctx, cityState),
      defense: urgent.plans.defense,        // sent at the top of the slice (urgentDefence)
      acted: urgent.acted,
    };
    if (research) report.research = research;
    // Step 19: the plan line in work, the city's hours, and how its marches rank
    if (planned.plan) report.plan = { note: planned.plan.note };
    if (sched) report.schedule = { note: sched.note };
    const processingNote = PR ? PR.processingNote(ctx.goals, cityState, g.now ? g.now() : Date.now()) : null;
    if (processingNote) report.processing = { note: processingNote };
    const globalsNote = layerNote(parsed);
    if (globalsNote) report.globals = { note: globalsNote };
    report.acted.push(...freeFirst.acted);
    // goals a script set here: they win until cleared, so every pass says so
    const layer = getScriptLayer(this.accountId, g.castleId(castle));
    if (layer) report.script = { note: scriptNote(layer, parsed) };

    // war / hero / npc module plans — each is pure and may return null
    for (const { name, mod } of MODULES) {
      for (const [key, fn] of Object.entries(mod.plans || {})) {
        try {
          // hiding and the gate were planned (and sent) at the top of the slice
          const p = name === './goal-war' && key in urgent.plans ? urgent.plans[key] : fn(ctx, cityState, g);
          if (p) report[`${key}`] = p;
        } catch (e) {
          report.acted.push(`${name} plan "${key}" failed: ${e.message}`);
        }
      }
    }

    // What is this slice about to do? The mayor is chosen to suit it:
    // attack hero while training, politics hero for building and idle production.
    const willTrain = !!(report.troop && report.troop.orders && report.troop.orders.length);
    // Fortifications are built by the same politics stat as buildings, and used
    // to be left out of this entirely — so wall production never got the
    // politics mayor. Training still wins the tie, because an attack mayor
    // speeds the troop queue and a city has only one mayor.
    const willBuild = !!(
      (report.build && report.build.actions && report.build.actions.length)
      || (report.fort && report.fort.orders && report.fort.orders.length)
    );
    // The heroes NPC farming sends this slice: under config trainpol:1 the mayor
    // plan stands another hero in for the politics hero that leaves (wiki TrainPol).
    const leaving = new Set(((report.npc && report.npc.actions) || []).map((a) => a.heroId));
    report.mayor = M.mayorPlan(ctx, willTrain ? 'train' : willBuild ? 'build' : 'idle', { leaving });
    // The mayor plan read the heroes before the hide march took one of them out.
    if (urgent.hid && report.mayor && report.mayor.actions && report.mayor.actions.length) {
      report.mayor = { note: `${report.mayor.note}; held this slice — the hide march just left`, actions: [] };
    }

    let budget = this.maxActionsPerSlice;

    // mayor first — it changes the speed of everything that follows this slice.
    // Promoted straight over the sitting mayor, as the client does
    // (CastleChief.as:377-394): discharging first and then having the promotion
    // refused used to leave the city with no mayor at all. A refusal backs off
    // on the retry ladder rather than being asked again every slice.
    let newMayor = false, newMayorName = null;
    if (report.mayor && report.mayor.actions) {
      for (const a of report.mayor.actions) {
        const mkey = `mayor:${a.hero.id}`;
        if (blocked(cityState, mkey)) { report.mayor.note += `; held back: ${a.label}, ${blockedFor(cityState, mkey)}`; continue; }
        if (this.dryRun) { report.acted.push(`[plan] ${a.label}`); continue; }
        try {
          const r = await g.promoteToChief(g.castleId(castle), a.hero.id);
          if (r.ok === 1) { newMayor = true; newMayorName = a.hero.name || null; }
          recordResult(cityState, mkey, r.ok === 1, r.errorMsg || ('ok=' + r.ok));
          report.acted.push(`${a.label} -> ${r.ok === 1 ? 'ok' : (r.errorMsg || 'ok=' + r.ok)}`);
        } catch (e) { report.acted.push(`${a.label} -> ${e.message}`); }
      }
    }
    // A batch's training time is fixed when it is queued, at the city's speed
    // at that moment. The new mayor changed that speed, so re-read it and
    // re-size the troop batches before any are placed.
    if (newMayor && ctx.training && report.troop && report.troop.orders && report.troop.orders.length) {
      ctx.training = await this.readTraining(castle, true);
      // under the hero just appointed: the city's hero list may not show it yet
      noteHeroTimes(cityState, newMayorName, ctx.training);
      report.troop = troopPlan(ctx);
    }

    // wiki FortificationGoal: under attack, 1 of each type on the first line
    // "with emergency priority" — ahead of every other goal (emergencyWalls)
    await this.emergencyWalls(castle, cityState, report.fort, report.acted);

    // generic executors for the plan-style goals (runPlanActions)
    budget = await this.runPlanActions(report, { castle, cityState, book, budget, goals: ctx.goals, goalsOf });

    // The troop goal: its own allowance, outside the budget above (runTroops).
    await this.runTroops(castle, cityState, report.troop && report.troop.orders ? report.troop : null, report.acted);

    if (report.fort && report.fort.orders) {
      const held = [];
      for (const o of report.fort.orders) {
        const what = (num) => `build ${fmt(num)} ${o.wall.name}`;
        const fkey = `wall:${o.wall.typeId}`;
        if (blocked(cityState, fkey)) { held.push(`${o.wall.name}, ${blockedFor(cityState, fkey)}`); continue; }
        if (budget-- <= 0) break;
        if (this.dryRun) { report.acted.push(`[plan] ${what(o.num)}`); continue; }
        const r = await orderFitted((num) => g.produceWall(g.castleId(castle), o.wall.typeId, num),
          o.num, castle, what, report.acted);
        recordResult(cityState, fkey, r.ok === 1, r.errorMsg || ('ok=' + r.ok));
      }
      report.fort.note += heldBack(held);
    }

    // One construction command per slice: the builder takes one at a time, so
    // once one is sent (placed or refused) the rest wait for the next slice.
    // It has its own slot, outside the three actions above (Step 11): three
    // troop batches used to leave no construction at all that slice. What is
    // placed is the order resolveBuild picked — maybe a prerequisite — and
    // only a refusal it did not see coming goes on the backoff ladder.
    if (report.build && report.build.actions && report.build.actions.length) {
      const hold = n(cityState.builderHeld) - Date.now();
      if (hold > 0) {
        report.build.note += `; the server says the builder is busy, asking again in ${dur(hold / 1000)}`;
      } else if (report.build.pick) {
        const a = report.build.pick;
        const line = buildLabel(a);
        if (this.dryRun) report.acted.push(`[plan] ${line}`);
        else {
          const cid = g.castleId(castle);
          const r = a.kind === 'upgrade' ? await g.upgradeBuilding(cid, a.positionId)
            : a.kind === 'demolish' ? await g.destructBuilding(cid, a.positionId)
            : await g.newBuilding(cid, a.positionId, a.def.typeId);
          const ok = r.ok === 1;
          report.acted.push(`${line} -> ${ok ? 'ok' : (r.errorMsg || 'ok=' + r.ok)}`);
          // Busy is the builder's state, not this building's fault: no backoff.
          if (!ok && BUILDER_BUSY.test(r.errorMsg || '')) cityState.builderHeld = Date.now() + BUILDER_HOLD;
          else recordResult(cityState, buildKey(a), ok, r.errorMsg || ('ok=' + r.ok));
        }
      }
      report.build.note += heldBack(report.build.held || []);
    }

    // Step 16: one research start a slice, in its own slot like construction:
    // a city researches one thing at a time, and three troop batches must not
    // crowd it out. A refusal goes on the backoff ladder for that tech, and the
    // list is read again for the next decision.
    if (report.research && report.research.actions && report.research.actions.length) {
      const a = report.research.actions[0];
      if (this.dryRun) report.acted.push(`[plan] ${a.label}`);
      else {
        let r;
        try { r = (await RS.executors.research(g, castle, a, cityState)) || {}; } catch (e) { r = { ok: 0, errorMsg: e.message }; }
        const ok = r.ok === 1;
        report.acted.push(`${a.label} -> ${ok ? 'ok' : (r.errorMsg || 'ok=' + r.ok)}`);
        recordResult(cityState, RS.backoffKey(a.techId), ok, r.errorMsg || ('ok=' + r.ok));
        const list = this.techLevels && this.techLevels[g.castleId(castle)];
        if (list) { if (ok) list.until = n(r.tech && r.tech.endTime) || 1; else list.at = 0; }
      }
    }

    // ...and again now: the construction this slice started is finished in the
    // same slice rather than the next. The notes are the city as it ends the slice.
    const freeAfter = await this.freeSpeed(castle, parsed.config, cityState, freeSeen);
    report.acted.push(...freeAfter.acted);
    if (freeAfter.notes.length) report.speedup = { note: `free finish: ${freeAfter.notes.join('; ')}` };

    // MERGE, never replace. Plans and executors write their own bookkeeping into
    // cityState during this slice — npc runs/hits/cycles, comfort timers, defence
    // and hero state. Assigning a fresh object here threw all of it away every
    // tick, so npcteams never counted, camp cooldowns never held, and comfort
    // reported "due now" forever.
    Object.assign(cityState, {
      lastFocus: Date.now(),
      troopStage: report.troop && report.troop.stageIndex,
    });
    this.state[key] = cityState;
    saveState(this.state, this.accountId);
    report.at = Date.now();
    report.dryRun = this.dryRun;
    this.lastReport[key] = report;
    return report;
  }

  // Free finishes in one city (speedups.js): what is running there now and
  // qualifies, sent at once. Outside the action budget: a free finish spends
  // nothing, and each job is asked once at most.
  async freeSpeed(castle, config, cityState, seen) {
    const g = this.game;
    const cid = g.castleId(castle);
    const plan = S.freeSpeedPlan({
      castle, config,
      research: typeof g.runningResearch === 'function' ? g.runningResearch(cid) : null,
      // end times are the server's clock
      now: typeof g.now === 'function' ? g.now() : Date.now(),
    }, cityState, seen);
    const acted = await S.runFreeSpeed(g, castle, plan, cityState, { dryRun: this.dryRun, seen });
    return { notes: plan.notes, acted };
  }

  // A city with no goals but a manual gate on the console: hold the gate and
  // do nothing else.
  async holdGate(castle, key, controls) {
    const g = this.game;
    const cityState = (this.state[key] = this.state[key] || {});
    const W = MODULES.find((m) => m.name === './goal-war');
    const report = { city: castle.name || key, acted: [] };
    if (!W) { report.note = 'no goals set (gate module not loaded)'; return report; }
    const p = W.mod.plans.gate({ game: g, castle, goals: [], config: {}, controls, incoming: [] }, cityState, g);
    report.gate = p;
    for (const a of (p && p.actions) || []) {
      if (this.dryRun) { report.acted.push(`[plan] ${a.label}`); continue; }
      try {
        const r = await MODULE_EXECUTORS.setGate(g, castle, a, cityState);
        report.acted.push(`${a.label} -> ${r.ok === 1 ? 'ok' : (r.errorMsg || 'ok=' + r.ok)}`);
      } catch (e) { report.acted.push(`${a.label} -> ${e.message}`); }
    }
    saveState(this.state, this.accountId);
    report.at = Date.now();
    report.dryRun = this.dryRun;
    this.lastReport[key] = report;
    return report;
  }

  // A full pass over every city, or with { urgent: true } the war goals alone
  // (warPass) — what the console runs between ticks at nextWakeAt.
  async tick(opts = {}) {
    const g = this.game;
    // state assigned after construction (a reconnect carries it over) may still
    // be keyed by name; a no-op once it is not
    this.migrateStateKeys();
    if (opts && opts.urgent) return this.warPass();

    // per-city goals, round robin (one city has "focus" at a time, as NEAT does)
    for (const castle of g.castles) {
      const r = await this.focus(castle);
      // every plan on the report contributes its note, module plans included
      const notes = Object.entries(r)
        .filter(([k, v]) => k !== 'acted' && v && typeof v === 'object' && v.note)
        .map(([, v]) => v.note);
      this.line(notes.join(' | ') || r.note, { city: r.city, kind: 'plan' });
      for (const a of r.acted || []) {
        this.line(a, { city: r.city, kind: /^\[plan\]/.test(a) ? 'plan' : 'act' });
      }
      if (TROOP_TRACE) troopTrace(r);
    }

    // traininghero is cross-city, so it runs once per tick over all cities
    const cityGoals = g.castles
      .map((castle) => ({ castle, parsed: this.goalsFor(g.castleId(castle), castle.name) }))
      .filter((x) => x.parsed);
    const book = this.rallyBook();
    const warTownOf = this.warTownLookup();
    for (const p of M.trainingHeroPlan(g, cityGoals, this.state)) {
      this.line(p.note, { kind: 'plan' });
      for (const a of p.actions || []) {
        const city = a.from && a.from.name;
        // wiki WarTown: under wartown:2 the traininghero stays in the city it
        // has landed in; under wartown:1 it comes and goes as usual, and it
        // may always move INTO a war town. The console's mode counts the same.
        if (warTownOf(a.from) === 2) {
          this.line(`${a.label} — held: ${city} is a war town (2), the traininghero stays there`, { city, kind: 'plan' });
          continue;
        }
        // schedulepolicy (processing.js): the march leaves that city, so it
        // goes only in that city's hours
        const from = cityGoals.find((x) => x.castle === a.from);
        const sch = PR && from ? PR.scheduleAt(from.parsed.goals, g.now ? g.now() : Date.now()) : null;
        if (sch && !sch.on) {
          this.line(`${a.label} — held: ${city} ${sch.why}`, { city, kind: 'plan' });
          continue;
        }
        const xy = g.castleXY(a.to);
        // checked before the mayor is stood down, not after
        const rally = { from: a.from, kind: 't', missionType: C.MISSION.reinforce, targetFieldId: C.coordsToFieldId(xy.x, xy.y), troops: { scouter: 1 } };
        const full = book.check(rally);
        if (full) { this.line(`${a.label} — waiting for a rally slot: ${full}`, { city, kind: 'plan' }); continue; }
        if (this.dryRun) { this.line(`[plan] ${a.label}`, { city, kind: 'plan' }); continue; }
        try {
          const hero = (a.from.heros || []).find((h) => (h.name || '').toLowerCase() === String(a.heroName).toLowerCase());
          if (!hero) { this.line(`${a.label} -> hero vanished`, { city, kind: 'act' }); continue; }
          // only a hero at home moves — idle, or the mayor — checked again here
          if (Number(hero.status) !== 0 && Number(hero.status) !== 1) { this.line(`${a.label} -> ${hero.name} is not at home (status ${hero.status}), not moving`, { city, kind: 'act' }); continue; }
          // The march carries one scout. With none in the city it cannot go at
          // all — and standing the mayor down for a march that then fails is
          // how the training hero ends up flapping in and out of the office and
          // never leaving (the user, 2026-09-22). So this is checked BEFORE the
          // discharge, and the hero is left as it is until the city has a scout.
          if (Number((a.from.troop && a.from.troop.scouter) || 0) < 1) {
            this.line(`${a.label} — held: no scout in ${city} to carry the march, so ${hero.name} cannot leave`, { city, kind: 'plan' });
            continue;
          }
          // a mayor cannot march, so stand him down first
          const chiefed = (a.from.heros || []).some((h) => h.id === hero.id && Number(h.status) === 1);
          if (chiefed) await g.dischargeChief(g.castleId(a.from));
          const bean = g.buildArmyBean({
            missionType: C.MISSION.reinforce, heroId: hero.id,
            targetPoint: rally.targetFieldId, troops: { scouter: 1 },
          });
          const r = await g.newArmy(g.castleId(a.from), bean);
          this.line(`${a.label} -> ${r.ok === 1 ? 'marching' : (r.errorMsg || 'ok=' + r.ok)}`, { city, kind: 'act' });
          if (r.ok === 1) { book.record(rally); this.state.hero[String(a.heroName).toLowerCase()].since = Date.now(); }
        } catch (e) { this.line(`${a.label} -> ${e.message}`, { city, kind: 'act' }); }
      }
    }
    saveState(this.state, this.accountId);
  }
}

module.exports = { Engine, troopPlan, cityMarches, fortPlan, buildPlan, buildLabel, buildOutlook, fitFromError, DEFAULT_SLOT_MIN,
  inboundArmy, incomingByCity, WAKE_SLACK_MS, resolvePrereqs, PREREQ_READS, COND_TTL,
  // the plan goal judges its lines finished the way the builder reads a target (goal-plan.js)
  addWant, typeOrders, buildMet,
  // the research goal tests its ?condition? the way a build line does (goal-research.js)
  conditionFails,
  // Step 17: the troop and wall settings
  troopSettings, upkeepPerHour, trainerOf, noteHeroTimes, troopMemory,
  DEFAULT_WALL_MIN, FOOD_DAY_HOURS, TROOP_ORDERS, BAD_QUEUE_HOLD };
