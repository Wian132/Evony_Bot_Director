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
const M = require('./goalmods');
const R = require('./rally');

// War / hero / NPC / transfer goals live in their own modules, each exporting
// { parsers, plans, executors }. parsers are merged by goals.js; plans and
// executors are wired here.
const MODULES = ['./goal-war', './goal-heroes', './goal-npc', './goal-buildnpc', './goal-transfer'].map((p) => {
  try { return { name: p, mod: require(p) }; }
  catch (e) { console.error(`goal module ${p} not loaded: ${e.message}`); return null; }
}).filter(Boolean);

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
const DEFAULT_SLOT_MIN = 30;

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

  // The server trains from IDLE population only, and refuses an order above it
  // outright ("Insufficient idle population, 24580 required") instead of
  // trimming it. troopsusepopmax used to size orders against max population,
  // so every order bigger than the idle count failed and nothing trained. A
  // target bigger than one batch is worked off batch by batch instead.
  const res = ctx.castle.resource || {};
  const popBudget = idleOf(res);

  // Each batch is sized to train in about this many minutes. A batch's time is
  // fixed when it is queued, so one giant batch holds the barracks for weeks at
  // whatever speed the city had then (4,916 ballista: 42 days), with its
  // population and resources locked up the whole time. Short batches keep the
  // queue turning and each one trains at the mayor and research of its moment.
  // troopslot:0 lifts the cap: batches as big as population and resources allow.
  const slotMin = active.stage.switches.slot ?? ctx.config.troopslot ?? DEFAULT_SLOT_MIN;
  const slotSec = Math.max(0, n(slotMin)) * 60;

  // A barracks holds as many batches as its level, one of them training
  // (Barrack.as: "waiting queue: remain / level - producing").
  const room = tr ? tr.barracks.map((b) => ({ positionId: b.positionId, free: b.capacity - b.items.length })) : null;

  const orders = [], cannot = [];
  let popLeft = popBudget, held = '';
  // Resources are a SHARED, running budget, exactly like population. Sizing each
  // troop type against the full untouched pool means the first order drains the
  // bank and every later one is rejected outright ("Insufficient resources.
  // Required Lumber 139300") instead of being trimmed to what is left.
  const RES_KEYS = ['food', 'wood', 'stone', 'iron'];
  const pool = {
    food: n(res.food && res.food.amount),
    wood: n(res.wood && res.wood.amount),
    stone: n(res.stone && res.stone.amount),
    iron: n(res.iron && res.iron.amount),
  };
  // One batch per troop type per tick, in the order the stage lists them, each
  // into the barracks with the most room.
  for (const [key, deficit] of Object.entries(active.missing)) {
    const t = C.BY_KEY[key];
    if (!t) continue;
    const unit = tr ? tr.unit[t.typeId] : null;
    if (tr && !(unit && unit.allowed)) { cannot.push(t.name); continue; }
    const bar = room && room.filter((b) => b.free > 0).sort((a, b) => b.free - a.free)[0];
    if (room && !bar) { held = held || 'a free barracks queue slot'; break; }
    const byPop = t.pop > 0 ? Math.floor(popLeft / t.pop) : deficit;
    const byRes = Math.min(...RES_KEYS.map((k) => (t.cost[k] ? Math.floor(pool[k] / t.cost[k]) : Infinity)));
    // a troop slower than the whole slot still trains, one at a time
    const byTime = unit && unit.time > 0 && slotSec > 0 ? Math.max(1, Math.floor(slotSec / unit.time)) : Infinity;
    const num = Math.max(0, Math.min(deficit, byPop, byRes, byTime));
    if (num > 0) {
      orders.push({ troop: t, num, positionId: bar ? bar.positionId : undefined, secs: unit ? num * unit.time : null });
      if (bar) bar.free--;
      popLeft -= num * t.pop;
      for (const k of RES_KEYS) if (t.cost[k]) pool[k] -= num * t.cost[k];
    } else if (!held) {
      held = byPop < 1 ? `idle population (${fmt(popLeft)})` : 'resources';
    }
  }

  let note = head;
  if (cannot.length) note += `; not trainable here yet: ${cannot.join(', ')}`;
  if (!orders.length && held) note += `; waiting on ${held}`;
  return { ...base, orders, popBudget, slotMin: slotSec / 60, note };
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
function fortPlan(ctx) {
  const stages = ctx.goals.filter((g) => g.name === 'fortification');
  if (!stages.length) return null;
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
  if (!active) return { done: true, note: `all ${stages.length} fortification stage(s) satisfied${inQueue}` };

  const base = { stageIndex: index + 1, stageCount: stages.length, missing: active.missing };
  const head = `stage ${index + 1}/${stages.length}: short ${Object.entries(active.missing).map(([k, v]) => `${k} ${fmt(v)}`).join(', ')}${inQueue}`;
  if (walls.error) return { ...base, orders: [], note: `${head}; not building: ${walls.error}` };

  const level = Math.min(10, n(walls.level));
  const capacity = C.WALL_SPACE[level];
  let used = 0;
  for (const def of C.WALLS) used += (n(built[def.code]) + n(queued[def.code])) * def.space;
  let left = Math.max(0, capacity - used);
  let room = Math.max(0, level - (walls.queue || []).length);

  // One batch per short type per tick, the whole shortfall or as much as fits.
  const orders = [];
  let held = '';
  for (const [code, deficit] of Object.entries(active.missing)) {
    const wall = C.WALL_BY_CODE[code];
    if (room <= 0) { held = held || (level ? `a free wall queue slot (${level} at Walls L${level})` : 'Walls'); break; }
    const num = Math.min(deficit, Math.floor(left / wall.space));
    if (num <= 0) { held = held || 'fortified space'; continue; }
    orders.push({ wall, num });
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
  return { ...base, orders, wallsFor, space: { used, capacity, level }, note };
}

// --------------------------------------------------------------- build targets
// build <type>:<level>:<qty> states the END STATE for that building type:
// exactly <qty> of them, each at <level>.
//   f:10:37  -> 37 farms, all level 10
//   f:0:10   -> keep 10 farms, don't upgrade them
//   s:0:0    -> no sawmills at all (demolish every one)
//   s:0:1    -> one sawmill, the strongest; the rest come down
//
// A demolition order takes a building down ONE level, so an L10 sawmill is ten
// orders. The weakest spare goes first and stays the weakest, so it is taken
// all the way down before the next is touched.
//
// A city has ONE builder: the server takes one construction at a time ("One
// building allowed to be built at a time."). So the plan is a ranked list of
// candidates and the engine places the first that goes through:
//   1. demolitions
//   2. new buildings, but only on plots that are open. Outside, the Town Hall
//      decides how many are (C.plotRange). A full city used to propose "new
//      Farm" every tick, and those doomed attempts took the slots the upgrades
//      needed, so nothing was ever built. Now it moves straight on:
//   3. the Walls level a fortification goal needs for space (fortPlan.wallsFor)
//   4. upgrades toward the goal levels.
// While something is being built, the plan holds everything and says what it
// is waiting on. It plans from the city as it will stand once that is done, so
// what it names next is what the builder really takes on next: the same
// building's next level down, or the plot a finished demolition opens.
function buildPlan(ctx, wallsFor = 0) {
  const goals = ctx.goals.filter((g) => g.name === 'build');
  if (!goals.length && !wallsFor) return null;
  const now = Date.now();
  const live = standing(ctx.castle);
  const all = live.map(finished).filter((b) => n(b.level) > 0);
  const idle = (b) => n(b.status) === 0;
  const { used, townHall } = Game.plotsInUse({ ...ctx.castle, buildings: all });
  const openPlots = (outside) => {
    const { from, to } = C.plotRange(outside, townHall);
    const out = [];
    for (let p = from; p <= to; p++) if (!used.has(p)) out.push(p);
    return out;
  };
  const plots = { inside: openPlots(false), outside: openPlots(true) };

  const demolish = [], create = [], walls = [], upgrade = [];
  const summary = [], noRoom = [];
  const upgrading = new Set();          // one upgrade per building, whoever asks

  // First, so it keeps its place even when a build goal also names the Walls.
  if (wallsFor) {
    const w = all.find((b) => b.typeId === C.WALLS_TYPE);
    if (w && n(w.level) < wallsFor && idle(w)) {
      upgrading.add(n(w.positionId));
      walls.push({ kind: 'upgrade', def: C.BUILDING_BY_ID[C.WALLS_TYPE], positionId: w.positionId, from: w.level, to: wallsFor, why: 'fortified space' });
    }
    summary.push(`Walls to L${wallsFor} for fortified space`);
  }

  for (const g of goals) {
    for (const t of g.targets) {
      const def = C.BUILDING_BY_CODE[t.building.toLowerCase().replace(/[^a-z]/g, '')];
      if (!def) continue;
      // The Town Hall and the Walls have fixed places: never built new or torn down.
      const fixed = def.typeId === C.TOWN_HALL || def.typeId === C.WALLS_TYPE;
      const existing = all.filter((b) => b.typeId === def.typeId);
      const want = Math.max(0, n(t.quantity));

      if (existing.length > want && !fixed) {
        // too many: tear down the weakest first
        const excess = existing.filter(idle).sort((a, b) => n(a.level) - n(b.level)).slice(0, existing.length - want);
        for (const b of excess) demolish.push({ kind: 'demolish', def, positionId: b.positionId, level: b.level });
        summary.push(`${def.name} ${existing.length}->${want} (demolish ${existing.length - want})`);
      } else if (existing.length < want && !fixed) {
        const kind = def.outside ? 'outside' : 'inside';
        const short = want - existing.length;
        const fit = Math.min(short, plots[kind].length);
        for (let i = 0; i < fit; i++) create.push({ kind: 'new', def, positionId: plots[kind].shift() });
        if (fit) summary.push(`${def.name} ${existing.length}->${want} (build ${fit})`);
        if (fit < short) noRoom.push({ def, kind, more: short - fit });
      }

      // only chase levels when a level was actually asked for
      if (t.level > 0) {
        const keep = existing.slice().sort((a, b) => n(b.level) - n(a.level)).slice(0, want);
        const low = keep.filter((b) => n(b.level) < t.level);
        const ready = low.filter((b) => idle(b) && !upgrading.has(n(b.positionId))).sort((a, b) => n(b.level) - n(a.level));
        for (const b of ready) {
          upgrading.add(n(b.positionId));
          upgrade.push({ kind: 'upgrade', def, positionId: b.positionId, from: b.level, to: t.level });
        }
        if (low.length) summary.push(`${def.name} upgrade ${low.length} to L${t.level}`);
      }
    }
  }

  // "no free field plot for 7 more Farm (Town Hall L7 opens 31 of 40)"
  const room = noRoom.map(({ def, kind, more }) => {
    if (kind === 'inside') return `no free city plot for ${more} more ${def.name} (all ${C.SLOTS.insideTo - C.SLOTS.insideFrom + 1} in use)`;
    const { from, to } = C.plotRange(true, townHall);
    const all40 = C.SLOTS.outsideTo - C.SLOTS.outsideFrom + 1;
    return `no free field plot for ${more} more ${def.name} (${to - from + 1 < all40 ? `Town Hall L${townHall} opens ${to - from + 1} of ${all40}` : `all ${all40} in use`})`;
  });

  const actions = [...demolish, ...create, ...walls, ...upgrade];
  const busy = live.filter((b) => underway(b, now));
  const parts = [];
  if (busy.length) {
    const b = busy[0];
    const left = n(b.endTime) > now ? `, ${dur((n(b.endTime) - now) / 1000)} left` : '';
    parts.push(`builder busy: ${n(b.status) === 2 ? 'demolishing' : 'building'} ${b.name || (C.BUILDING_BY_ID[b.typeId] || {}).name || 'type ' + b.typeId} (pos ${b.positionId}) L${n(b.level)}->L${n(finished(b).level)}${left}`);
    if (actions.length) parts.push(`next: ${buildLabel(actions[0])}`);
  } else if (actions.length) {
    parts.push(`${summary.slice(0, 3).join('; ')}${summary.length > 3 ? ` (+${summary.length - 3} more)` : ''}`);
  }
  parts.push(...new Set(room));      // two goals naming farms say it once
  return {
    actions: busy.length ? [] : actions,
    ranked: actions,            // in order, even while busy: what comes next
    busy: busy.length > 0,
    note: parts.length ? `build: ${parts.join('; ')}` : 'all build targets met',
  };
}

// "upgrade Farm (pos 1003) L6->L7, goal L10", "new Farm (pos 1031)",
// "demolish Sawmill (pos 1032) L10->L9"
function buildLabel(a) {
  if (a.kind === 'upgrade') {
    return `upgrade ${a.def.name} (pos ${a.positionId}) L${n(a.from)}->L${n(a.from) + 1}`
      + (a.why ? ` for ${a.why}` : n(a.to) > n(a.from) + 1 ? `, goal L${a.to}` : '');
  }
  if (a.kind === 'demolish') return `demolish ${a.def.name} (pos ${a.positionId}) L${n(a.level)}->L${n(a.level) - 1}`;
  return `new ${a.def.name} (pos ${a.positionId})`;
}

// The backoff key for a construction candidate. New buildings share one per
// type: the plot they would go on changes as others fill.
const buildKey = (a) => (a.kind === 'new' ? `build:new:${a.def.typeId}:new` : `build:${a.kind}:${a.def.typeId}:${a.positionId}`);

// What the builder takes on next in one city — the console's Buildings tab.
// Pure: the live building list, the goals and the city's engine state; nothing
// is sent. It is the plan the next tick makes, less the candidates the engine
// has backed off. `wallsFor` comes from the last tick, because the Walls level a
// fortification goal needs takes a Walls queue read that only a tick makes.
function buildOutlook({ castle, goals, cityState = {}, wallsFor = 0 }) {
  const plan = buildPlan({ castle, goals: goals || [] }, wallsFor);
  if (!plan) return { next: null, idle: 'no build goals for this city' };
  const held = [];
  let next = null;
  for (const a of plan.ranked) {
    const k = buildKey(a);
    if (blocked(cityState, k)) { held.push(`${buildLabel(a)}: ${blockedFor(cityState, k)}`); continue; }
    next = a;
    break;
  }
  const hold = n(cityState.builderHeld) - Date.now();
  return {
    next: next ? buildLabel(next) : null,
    // why it is not being placed this minute, if it is not
    wait: plan.busy ? 'once the builder is free'
      : hold > 0 ? `the server says the builder is busy, asking again in ${dur(hold / 1000)}` : null,
    held,
    idle: plan.ranked.length ? null : 'nothing: all build targets met',
    note: plan.note,
  };
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

// Hiding and the gate race a wave's arrival (Engine.urgentWar).
const URGENT_PLANS = ['hiding', 'gate'];
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
  goalsFor(id, name) {
    const row = D.goals.own(this.accountId, id, name, 'goal');
    return row ? parseGoals(row.src) : null;
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
    for (const c of g.castles) {
      const id = g.castleId(c);
      const list = incoming[id] || [];
      const sig = list.map((a) => `${a.armyId ?? ''}@${a.reachTime ?? ''}`).sort().join(',');
      if ((seen[id] || '') === sig) continue;
      seen[id] = sig;
      delete this.warCheckedAt[id];
      if (!list.length) continue;
      const first = Math.min(...list.map((a) => n(a.reachTime) || Infinity));
      this.line(`incoming: ${list.length} hostile army(ies)${Number.isFinite(first) ? `, the first lands in ${dur((first - now) / 1000)}` : ''}`,
        { city: c.name || String(id), kind: 'sys' });
    }
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
    if (!W) return out;
    const at = g.now ? g.now() : Date.now();
    for (const key of URGENT_PLANS) {
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
    const cid = g.castleId(castle);
    this.warCheckedAt[cid] = at;
    this.goalsSeen[cid] = { goals: ctx.goals, config: ctx.config };
    return out;
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
      const key = castle.name || String(cid);
      const ctx = {
        game: g, castle, goals: parsed.goals, config: parsed.config,
        controls: (this.controlsFor && this.controlsFor(castle)) || {},
        incoming: incoming[cid] || [],
      };
      const since = n(this.warCheckedAt[cid]);
      for (const m of W.mod.warMoments(ctx, this.state[key] || {})) {
        if (m > since && (best === null || m < best)) best = m;
      }
    }
    if (best === null) return null;
    return Date.now() + Math.max(0, best + WAKE_SLACK_MS - serverNow);
  }

  // Hiding and the gate alone, in every city with goals: the pass the console
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
      const key = castle.name || String(cid);
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
      for (const a of r.acted) this.line(a, { city: key, kind: /^\[plan\]/.test(a) ? 'plan' : 'act' });
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

  // Every city's rally slots, for this slice: live marches plus the ones sent
  // and not yet listed, against each city's Rally Spot and its rallypolicy.
  rallyBook(goalsOf = this.goalsLookup()) {
    return R.rallyBook({ game: this.game, armies: () => this.liveArmies(), pending: this.pendingMarches, goalsOf });
  }

  // The console files each line under its city and a kind (plan = thinking,
  // act = something was sent). A plain (m) => … logger — goalsd, the tests —
  // takes one argument, so it gets the old "[City] text" line instead.
  line(text, meta) {
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
        if (b) b.items = (bq.allProduceQueue || []).map((p) => ({ type: Number(p.type), num: n(p.num) }));
      }

      const mayor = (castle.heros || []).find((h) => Number(h.status) === 1);
      const mayorId = mayor ? mayor.id : null;
      let cached = this.unitTimes[cid];
      if (fresh || !cached || cached.mayorId !== mayorId || Date.now() - cached.at > UNIT_TIME_TTL) {
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
            allowed: t.permition !== false,
          };
        }
        cached = this.unitTimes[cid] = { at: Date.now(), mayorId, unit };
      }
      return { barracks, unit: cached.unit };
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

  async focus(castle) {
    const g = this.game;
    const key = castle.name || String(g.castleId(castle));
    const controls = (this.controlsFor && this.controlsFor(castle)) || {};
    const parsed = this.goalsFor(g.castleId(castle), castle.name);
    if (!parsed) {
      // A manual gate needs no goal file to be held — but nothing else may run
      // here: the mayor plan, for one, acts even when no goals are written.
      if (controls.gate === 'open' || controls.gate === 'closed') return this.holdGate(castle, key, controls);
      return { city: key, note: 'no goals set' };
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
    const ctx = {
      game: g, castle, goals: parsed.goals, config: parsed.config, fortifications,
      controls,
      // buildnpc's registry is keyed by account; without this it stands down
      // rather than guess which account a city belongs to.
      accountId: this.accountId || null,
      incoming: incoming[g.castleId(castle)] || [],
      // our own marches, so hiding/wartown can recall by armyId
      selfArmies: this.liveArmies(),
      // rally slots in every city, and any city's goals
      rally: book, goalsOf,
      // how many armies are inbound to each of our cities (by castle id) —
      // hiding uses this to avoid running INTO a city that is itself under attack
      incomingByCastle: countsOf(incoming),
    };
    // Hiding and the gate first, ahead even of the reads below (urgentWar).
    const urgent = await this.urgentWar(ctx, castle, cityState, book);
    if (parsed.goals.some((x) => x.name === 'troop') && parsed.config.troop !== 0) {
      ctx.training = await this.readTraining(castle);
    }
    // The Walls queue is only read when what already stands falls short.
    let fort = fortPlan(ctx);
    if (fort && !fort.done) {
      ctx.walls = await this.readWalls(castle);
      fort = fortPlan(ctx);
    }
    const report = {
      city: key,
      troop: troopPlan(ctx), fort, build: buildPlan(ctx, (fort && fort.wallsFor) || 0),
      comfort: M.comfortPlan(ctx, cityState),
      defense: M.defensePlan(ctx, cityState),
      acted: urgent.acted,
    };

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
    report.mayor = M.mayorPlan(ctx, willTrain ? 'train' : willBuild ? 'build' : 'idle');
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
    let newMayor = false;
    if (report.mayor && report.mayor.actions) {
      for (const a of report.mayor.actions) {
        const mkey = `mayor:${a.hero.id}`;
        if (blocked(cityState, mkey)) { report.mayor.note += `; held back: ${a.label}, ${blockedFor(cityState, mkey)}`; continue; }
        if (this.dryRun) { report.acted.push(`[plan] ${a.label}`); continue; }
        try {
          const r = await g.promoteToChief(g.castleId(castle), a.hero.id);
          if (r.ok === 1) newMayor = true;
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
      report.troop = troopPlan(ctx);
    }

    // Something backed off is not tried, costs no action and writes no log line
    // every tick: the plan's note says what is held and until when.
    const heldBack = (list) => (list.length ? `; held back: ${list.slice(0, 3).join('; ')}${list.length > 3 ? ` (+${list.length - 3} more)` : ''}` : '');

    // generic executors for the plan-style goals
    // Every plan on the report, not a fixed list — otherwise a war/hero plan gets
    // computed and then silently never executed. troop/fort/build/mayor run in
    // their own dedicated blocks above, so skip them here.
    //
    // A march (an action carrying `rally`) waits while the SENDING city's rally
    // spot or rallypolicy has no slot for it. The plans already ask, but plans
    // are made before anything in this slice is sent, so the book has the last
    // word. Hiding carries no `rally`: getting the army out is never held.
    // Hiding and the gate already ran, first and outside the budget (urgentWar).
    const OWN_BLOCKS = new Set(['troop', 'fort', 'build', 'mayor', 'acted', 'city', ...URGENT_PLANS]);
    for (const [key, p] of Object.entries(report)) {
      if (OWN_BLOCKS.has(key)) continue;
      if (!p || typeof p !== 'object' || !p.actions) continue;
      const held = [];
      for (const a of p.actions) {
        const full = a.rally ? book.check(a.rally) : null;
        if (full) { held.push(`${a.label}: ${full}`); continue; }
        if (budget-- <= 0) break;
        if (this.dryRun) {
          report.acted.push(`[plan] ${a.label}`);
          if (a.rally) book.record(a.rally, false);
          continue;
        }
        try {
          let r = { ok: 1 };
          if (a.kind === 'pacify') { r = await g.req('interior.pacifyPeople', { castleId: g.castleId(castle), typeId: a.typeId }); cityState.lastComfort = Date.now(); cityState.comfortGapMs = 0; }
          else if (a.kind === 'defenceItem') {
            // Each defence item through its own game command (game.js
            // useDefenceItem). A use counts only once the server says ok.
            r = await g.useDefenceItem(g.castleId(castle), a.itemId);
            if (r && r.ok === 1) {
              const d = (cityState.defence = cityState.defence || {});
              (d.used = d.used || {})[a.item] = Date.now();
            }
          }
          else if (a.kind === 'note') { report.acted.push(a.label); continue; }
          else if (MODULE_EXECUTORS[a.kind]) {
            r = await MODULE_EXECUTORS[a.kind](g, castle, a, cityState);
          } else { report.acted.push(`${a.label} -> no executor for "${a.kind}"`); continue; }
          if (r.ok === 1 && a.rally) book.record(a.rally);
          report.acted.push(`${a.label} -> ${r.ok === 1 ? 'ok' : (r.errorMsg || 'ok=' + r.ok)}`);
        } catch (e) { report.acted.push(`${a.label} -> ${e.message}`); }
      }
      if (held.length) p.note = (p.note || '') + heldBack(held);
    }

    if (report.troop && report.troop.orders) {
      for (const o of report.troop.orders) {
        if (budget-- <= 0) break;
        const per = o.secs != null ? o.secs / o.num : null;
        const what = (num) => `train ${fmt(num)} ${o.troop.name}${per != null ? ` (~${dur(per * num)})` : ''}`;
        if (this.dryRun) { report.acted.push(`[plan] ${what(o.num)}`); continue; }
        let pos = o.positionId;
        if (pos === undefined) {
          const barracks = (castle.buildings || []).find((b) => b.typeId === 2);
          if (!barracks) { report.acted.push('no barracks in this city'); break; }
          pos = barracks.positionId;
        }
        await orderFitted((num) => g.produceTroop(g.castleId(castle), o.troop.typeId, num, pos),
          o.num, castle, what, report.acted);
      }
    }

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
    if (report.build && report.build.actions && report.build.actions.length) {
      const held = [];
      const hold = n(cityState.builderHeld) - Date.now();
      if (hold > 0) {
        report.build.note += `; the server says the builder is busy, asking again in ${dur(hold / 1000)}`;
      } else {
        for (const a of report.build.actions) {
          const line = buildLabel(a);
          const fkey = buildKey(a);
          if (blocked(cityState, fkey)) { held.push(`${line}, ${blockedFor(cityState, fkey)}`); continue; }
          if (budget-- <= 0) break;
          if (this.dryRun) { report.acted.push(`[plan] ${line}`); break; }
          const cid = g.castleId(castle);
          const r = a.kind === 'upgrade' ? await g.upgradeBuilding(cid, a.positionId)
            : a.kind === 'demolish' ? await g.destructBuilding(cid, a.positionId)
            : await g.newBuilding(cid, a.positionId, a.def.typeId);
          const ok = r.ok === 1;
          report.acted.push(`${line} -> ${ok ? 'ok' : (r.errorMsg || 'ok=' + r.ok)}`);
          // Busy is the builder's state, not this building's fault: no backoff.
          if (!ok && BUILDER_BUSY.test(r.errorMsg || '')) cityState.builderHeld = Date.now() + BUILDER_HOLD;
          else recordResult(cityState, fkey, ok, r.errorMsg || ('ok=' + r.ok));
          break;
        }
      }
      report.build.note += heldBack(held);
    }

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

  // A city with no goals but a manual gate on the console: hold the gate and
  // do nothing else.
  async holdGate(castle, key, controls) {
    const g = this.game;
    const cityState = (this.state[key] = this.state[key] || {});
    const W = MODULES.find((m) => m.name === './goal-war');
    const report = { city: key, acted: [] };
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
    }

    // traininghero is cross-city, so it runs once per tick over all cities
    const cityGoals = g.castles
      .map((castle) => ({ castle, parsed: this.goalsFor(g.castleId(castle), castle.name) }))
      .filter((x) => x.parsed);
    const book = this.rallyBook();
    for (const p of M.trainingHeroPlan(g, cityGoals, this.state)) {
      this.line(p.note, { kind: 'plan' });
      for (const a of p.actions || []) {
        const city = a.from && a.from.name;
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
  inboundArmy, incomingByCity, WAKE_SLACK_MS };
