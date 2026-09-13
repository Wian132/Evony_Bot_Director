'use strict';
// Goal engine: evaluates standing goals for each city, round-robin, forever.
//
// A goal is an END STATE. Every focus slice we ask each goal "what, if anything,
// should happen right now?" and execute a bounded number of the answers.
const fs = require('fs');
const path = require('path');
const C = require('./constants');
const { parseGoals } = require('./goals');
const M = require('./goalmods');

// War / hero / NPC goals live in their own modules, each exporting
// { parsers, plans, executors }. parsers are merged by goals.js; plans and
// executors are wired here.
const MODULES = ['./goal-war', './goal-heroes', './goal-npc', './goal-buildnpc'].map((p) => {
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

// The SWF loads the fortification cost table from an XML at runtime, so it is
// not in the decompiled source and there is no table here to size orders from.
// Instead, learn the limit from the server's own refusal and retry with a
// quantity that fits. Both messages carry exact numbers:
//
//   "Remaining fortified space is 2000, 4000 more is needed."
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

// ---------------------------------------------------------------- troop ladder
// Stages are attempted in order. If an EARLIER stage is no longer satisfied
// (losses, disbanding), we drop back to it -- per the wiki's described behaviour.
function troopPlan(ctx) {
  const stages = ctx.goals.filter((g) => g.name === 'troop');
  if (!stages.length) return null;
  if (ctx.config.troop === 0) return { note: 'troop building disabled by config troop:0' };

  const have = ctx.castle.troop || {};
  let active = null, index = 0;
  for (let i = 0; i < stages.length; i++) {
    const missing = {};
    let short = false;
    for (const [key, want] of Object.entries(stages[i].troops)) {
      const deficit = want - n(have[key]);
      if (deficit > 0) { missing[key] = deficit; short = true; }
    }
    if (short) { active = { stage: stages[i], missing }; index = i; break; }
  }
  if (!active) return { done: true, note: `all ${stages.length} troop stage(s) satisfied` };

  // How many can we actually afford right now?
  const res = ctx.castle.resource || {};
  const idlePop = Math.max(0, n(res.curPopulation) - n(res.workPeople) - n(res.buildPeople));
  const usePopMax = (active.stage.switches.usepopmax ?? ctx.config.troopsusepopmax ?? 0) >= 1;
  const popBudget = usePopMax ? n(res.maxPopulation) - n(res.workPeople) : idlePop;

  const orders = [];
  let popLeft = popBudget;
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
  for (const [key, deficit] of Object.entries(active.missing)) {
    const t = C.BY_KEY[key];
    if (!t) continue;
    const byPop = t.pop > 0 ? Math.floor(popLeft / t.pop) : deficit;
    const byRes = Math.min(...RES_KEYS.map((k) => (t.cost[k] ? Math.floor(pool[k] / t.cost[k]) : Infinity)));
    const num = Math.max(0, Math.min(deficit, byPop, byRes));
    if (num > 0) {
      orders.push({ troop: t, num });
      popLeft -= num * t.pop;
      for (const k of RES_KEYS) if (t.cost[k]) pool[k] -= num * t.cost[k];
    }
  }

  return {
    stageIndex: index + 1, stageCount: stages.length,
    targets: active.stage.troops,          // what THIS stage is working toward
    missing: active.missing, orders, popBudget,
    note: `stage ${index + 1}/${stages.length}: short ${Object.entries(active.missing).map(([k, v]) => `${k} ${fmt(v)}`).join(', ')}`,
  };
}

// ------------------------------------------------------- fortification ladder
function fortPlan(ctx) {
  const stages = ctx.goals.filter((g) => g.name === 'fortification');
  if (!stages.length) return null;
  const have = ctx.fortifications || {};
  for (let i = 0; i < stages.length; i++) {
    const missing = {};
    let short = false;
    for (const [code, want] of Object.entries(stages[i].forts)) {
      const deficit = want - n(have[code]);
      if (deficit > 0) { missing[code] = deficit; short = true; }
    }
    if (short) {
      const orders = Object.entries(missing).map(([code, num]) => ({ wall: C.WALL_BY_CODE[code], num }));
      return { stageIndex: i + 1, stageCount: stages.length, missing, orders,
        note: `stage ${i + 1}/${stages.length}: short ${Object.entries(missing).map(([k, v]) => `${k} ${fmt(v)}`).join(', ')}` };
    }
  }
  return { done: true, note: `all ${stages.length} fortification stage(s) satisfied` };
}

// --------------------------------------------------------------- build targets
// build <type>:<level>:<qty> states the END STATE for that building type:
// exactly <qty> of them, each at <level>.
//   f:10:37  -> 37 farms, all level 10
//   f:0:10   -> keep 10 farms, don't upgrade them
//   s:0:0    -> no sawmills at all (demolish every one)
// Demolitions run first so the freed slots can be reused in the same pass.
function buildPlan(ctx) {
  const goals = ctx.goals.filter((g) => g.name === 'build');
  if (!goals.length) return null;
  const demolish = [], create = [], upgrade = [];
  const summary = [];

  for (const g of goals) {
    for (const t of g.targets) {
      const def = C.BUILDING_BY_CODE[t.building.toLowerCase().replace(/[^a-z]/g, '')];
      if (!def) continue;
      const existing = (ctx.castle.buildings || []).filter((b) => b.typeId === def.typeId);
      const want = Math.max(0, n(t.quantity));

      if (existing.length > want) {
        // too many: tear down the weakest first
        const excess = existing.slice().sort((a, b) => n(a.level) - n(b.level)).slice(0, existing.length - want);
        for (const b of excess) demolish.push({ kind: 'demolish', def, positionId: b.positionId, level: b.level });
        summary.push(`${def.name} ${existing.length}->${want} (demolish ${excess.length})`);
      } else if (existing.length < want) {
        for (let i = 0; i < want - existing.length; i++) create.push({ kind: 'new', def, target: t });
        summary.push(`${def.name} ${existing.length}->${want} (build ${want - existing.length})`);
      }

      // only chase levels when a level was actually asked for
      if (t.level > 0) {
        const keep = existing.slice().sort((a, b) => n(b.level) - n(a.level)).slice(0, want);
        const low = keep.filter((b) => n(b.level) < t.level).sort((a, b) => n(b.level) - n(a.level));
        for (const b of low) upgrade.push({ kind: 'upgrade', def, positionId: b.positionId, from: b.level, to: t.level });
        if (low.length) summary.push(`${def.name} upgrade ${low.length} to L${t.level}`);
      }
    }
  }

  const actions = [...demolish, ...create, ...upgrade];
  return {
    actions,
    note: actions.length ? `build: ${summary.slice(0, 3).join('; ')}${summary.length > 3 ? ` (+${summary.length - 3} more)` : ''}` : 'all build targets met',
  };
}

// ---------------------------------------------------------------- the engine
class Engine {
  constructor(game, log = console.log, accountId = null) {
    this.accountId = accountId;
    this.game = game;
    this.log = log;
    this.state = loadState(accountId);
    this.running = false;
    this.dryRun = true;
    this.maxActionsPerSlice = 3;
    this.lastReport = {};
    this.incoming = {};

    // defensepolicy needs to know what is inbound; the server pushes it
    if (game && game.c) {
      game.c.on('cmd', (cmd, data) => {
        if (cmd !== 'server.EnemyArmysUpdate' || !data) return;
        const cid = data.castleId ?? data.caslteId;
        const armies = data.armys || data.armies || [];
        // ArmyBean names the field `troop` (SINGULAR) and it is a TroopStrBean whose
        // values are STRINGS — an unscouted army sends "?" per type. Reading
        // `a.troops` gave undefined, so every inbound army totalled 0 and the
        // junk filter threw away real attacks.
        this.incoming[cid] = armies.map((a) => {
          const raw = a.troop || a.troops || {};
          let total = 0, known = true, any = false;
          for (const v of Object.values(raw)) {
            const s = String(v ?? '').trim().replace(/[,\s]/g, '');
            if (!/^\d+$/.test(s)) { if (v !== undefined && v !== null) known = false; continue; }
            total += parseInt(s, 10); any = true;
          }
          return {
            troops: any ? total : null,   // null = genuinely unknown, NOT zero
            known: any && known,
            reachTime: a.reachTime, from: a.startPosName, raw: a,
          };
        });
        if (armies.length) this.log(`incoming: ${armies.length} army(ies) toward castle ${cid}`);
      });

      // Our OWN marches. army.newArmy replies without an armyId, so a recall
      // (hiding's early return, wartown's recall-all) can only get one from here.
      this.selfArmies = [];
      game.c.on('cmd', (cmd, data) => {
        if (cmd !== 'server.SelfArmysUpdate' || !data) return;
        this.selfArmies = (data.armys || data.armies || []).map((a) => ({
          armyId: a.armyId, missionType: a.missionType, direction: a.direction,
          targetFieldId: a.targetFieldId, startFieldId: a.startFieldId,
          reachTime: a.reachTime, restTime: a.restTime, raw: a,
        }));
      });
    }
  }

  // Goals are stored per account, keyed by city id or city name. db.goals.find
  // walks id -> name -> this account's default -> the shared default.
  goalsFor(...keys) {
    const row = D.goals.find(this.accountId, keys, 'goal');
    return row ? parseGoals(row.src) : null;
  }

  async focus(castle) {
    const g = this.game;
    const key = castle.name || String(g.castleId(castle));
    const parsed = this.goalsFor(g.castleId(castle), castle.name);
    if (!parsed) return { city: key, note: 'no goals set' };

    // castle.fortification is an object keyed by beanKey, e.g. {"abatis":1418,...}
    const fortifications = {};
    for (const w of C.WALLS) fortifications[w.code] = n((castle.fortification || {})[w.beanKey]);

    const cityState = (this.state[key] = this.state[key] || {});
    cityState.accountId = this.accountId || null;   // executors read it from here
    const ctx = {
      game: g, castle, goals: parsed.goals, config: parsed.config, fortifications,
      // buildnpc's registry is keyed by account; without this it stands down
      // rather than guess which account a city belongs to.
      accountId: this.accountId || null,
      incoming: (this.incoming && this.incoming[g.castleId(castle)]) || [],
      // our own marches, so hiding/wartown can recall by armyId
      selfArmies: this.selfArmies || g.player.selfArmys || [],
      // how many armies are inbound to each of our cities — hiding uses this to
      // avoid running INTO a city that is itself under attack
      incomingByCastle: Object.fromEntries(
        Object.entries(this.incoming || {}).map(([k, v]) => [k, (v || []).length]),
      ),
    };
    const report = {
      city: key,
      troop: troopPlan(ctx), fort: fortPlan(ctx), build: buildPlan(ctx),
      comfort: M.comfortPlan(ctx, cityState),
      defense: M.defensePlan(ctx, cityState),
      request: M.requestResourcesPlan(ctx, g),
      acted: [],
    };

    // war / hero / npc module plans — each is pure and may return null
    for (const { name, mod } of MODULES) {
      for (const [key, fn] of Object.entries(mod.plans || {})) {
        try {
          const p = fn(ctx, cityState, g);
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

    let budget = this.maxActionsPerSlice;

    // mayor first — it changes the speed of everything that follows this slice
    if (report.mayor && report.mayor.actions) {
      for (const a of report.mayor.actions) {
        if (this.dryRun) { report.acted.push(`[plan] ${a.label}`); continue; }
        try {
          if (a.hadMayor) await g.dischargeChief(g.castleId(castle));
          const r = await g.promoteToChief(g.castleId(castle), a.hero.id);
          report.acted.push(`${a.label} -> ${r.ok === 1 ? 'ok' : (r.errorMsg || 'ok=' + r.ok)}`);
        } catch (e) { report.acted.push(`${a.label} -> ${e.message}`); }
      }
    }

    // generic executors for the plan-style goals
    // Every plan on the report, not a fixed list — otherwise a war/hero plan gets
    // computed and then silently never executed. troop/fort/build/mayor run in
    // their own dedicated blocks above, so skip them here.
    const OWN_BLOCKS = new Set(['troop', 'fort', 'build', 'mayor', 'acted', 'city']);
    for (const [key, p] of Object.entries(report)) {
      if (OWN_BLOCKS.has(key)) continue;
      if (!p || typeof p !== 'object' || !p.actions) continue;
      for (const a of p.actions) {
        if (budget-- <= 0) break;
        if (this.dryRun) { report.acted.push(`[plan] ${a.label}`); continue; }
        try {
          let r = { ok: 1 };
          if (a.kind === 'pacify') { r = await g.req('interior.pacifyPeople', { castleId: g.castleId(castle), typeId: a.typeId }); cityState.lastComfort = Date.now(); cityState.comfortGapMs = 0; }
          else if (a.kind === 'useItem') { r = await g.useCastleItem(g.castleId(castle), a.itemId); }
          else if (a.kind === 'transport') {
            const xy = g.castleXY(a.to);
            const bean = g.buildArmyBean({
              missionType: C.MISSION.transport, targetPoint: C.coordsToFieldId(xy.x, xy.y),
              troops: { carriage: Math.ceil(a.amount / C.BY_KEY.carriage.load) },
              resources: { [a.resource]: a.amount },
            });
            r = await g.newArmy(g.castleId(a.from), bean);
          } else if (a.kind === 'note') { report.acted.push(a.label); continue; }
          else if (MODULE_EXECUTORS[a.kind]) {
            r = await MODULE_EXECUTORS[a.kind](g, castle, a, cityState);
          } else { report.acted.push(`${a.label} -> no executor for "${a.kind}"`); continue; }
          report.acted.push(`${a.label} -> ${r.ok === 1 ? 'ok' : (r.errorMsg || 'ok=' + r.ok)}`);
        } catch (e) { report.acted.push(`${a.label} -> ${e.message}`); }
      }
    }

    if (report.troop && report.troop.orders) {
      for (const o of report.troop.orders) {
        if (budget-- <= 0) break;
        const line = `train ${fmt(o.num)} ${o.troop.name}`;
        if (this.dryRun) { report.acted.push(`[plan] ${line}`); continue; }
        const barracks = (castle.buildings || []).find((b) => b.typeId === 2);
        if (!barracks) { report.acted.push('no barracks in this city'); break; }
        const r = await g.produceTroop(g.castleId(castle), o.troop.typeId, o.num, barracks.positionId);
        report.acted.push(`${line} -> ${r.ok === 1 ? 'ok' : (r.errorMsg || 'ok=' + r.ok)}`);
      }
    }

    if (report.fort && report.fort.orders) {
      for (const o of report.fort.orders) {
        if (budget-- <= 0) break;
        const line = `build ${fmt(o.num)} ${o.wall.name}`;
        if (this.dryRun) { report.acted.push(`[plan] ${line}`); continue; }
        const fkey = `wall:${o.wall.typeId}`;
        if (blocked(cityState, fkey)) { report.acted.push(`${line} -> skipped: ${blockedFor(cityState, fkey)}`); continue; }
        let r = await g.produceWall(g.castleId(castle), o.wall.typeId, o.num);
        let ok = r.ok === 1;
        // Refused for space or resources? Ask the message how many DO fit and
        // place that instead of losing the whole tick.
        if (!ok) {
          const fits = fitFromError(o.num, r.errorMsg, castle.resource || {});
          if (fits > 0) {
            report.acted.push(`${line} -> only ${fmt(fits)} fit, retrying`);
            r = await g.produceWall(g.castleId(castle), o.wall.typeId, fits);
            ok = r.ok === 1;
            if (ok) report.acted.push(`build ${fmt(fits)} ${o.wall.name} -> ok`);
          }
        }
        recordResult(cityState, fkey, ok, r.errorMsg || ('ok=' + r.ok));
        if (!ok) report.acted.push(`${line} -> ${r.errorMsg || 'ok=' + r.ok}`);
      }
    }

    if (report.build && report.build.actions) {
      for (const a of report.build.actions) {
        if (budget-- <= 0) break;
        const line = a.kind === 'upgrade' ? `upgrade ${a.def.name} (pos ${a.positionId}) L${a.from}->L${a.to}`
          : a.kind === 'demolish' ? `demolish ${a.def.name} (pos ${a.positionId}, L${a.level})`
          : `new ${a.def.name}`;
        if (this.dryRun) { report.acted.push(`[plan] ${line}`); continue; }
        const fkey = `build:${a.kind}:${a.def.typeId}:${a.positionId === undefined ? 'new' : a.positionId}`;
        if (blocked(cityState, fkey)) { report.acted.push(`${line} -> skipped: ${blockedFor(cityState, fkey)}`); continue; }
        let r;
        if (a.kind === 'upgrade') r = await g.upgradeBuilding(g.castleId(castle), a.positionId);
        else if (a.kind === 'demolish') r = await g.destructBuilding(g.castleId(castle), a.positionId);
        else {
          const slot = g.freeSlot(castle, !!a.def.outside);
          // A full city is a standing condition, not a blip — back it off too,
          // otherwise the planner re-proposes the same building every tick.
          if (slot === null) {
            recordResult(cityState, fkey, false, 'no free building slot');
            report.acted.push(`${line} -> no free slot`);
            continue;
          }
          r = await g.newBuilding(g.castleId(castle), slot, a.def.typeId);
        }
        const ok = r.ok === 1;
        recordResult(cityState, fkey, ok, r.errorMsg || ('ok=' + r.ok));
        report.acted.push(`${line} -> ${ok ? 'ok' : (r.errorMsg || 'ok=' + r.ok)}`);
      }
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
    this.lastReport[key] = report;
    return report;
  }

  async tick() {
    const g = this.game;

    // per-city goals, round robin (one city has "focus" at a time, as NEAT does)
    for (const castle of g.castles) {
      const r = await this.focus(castle);
      // every plan on the report contributes its note, module plans included
      const notes = Object.entries(r)
        .filter(([k, v]) => k !== 'acted' && v && typeof v === 'object' && v.note)
        .map(([, v]) => v.note);
      this.log(`[${r.city}] ${notes.join(' | ') || r.note}`);
      for (const a of r.acted || []) this.log(`   ${a}`);
    }

    // traininghero is cross-city, so it runs once per tick over all cities
    const cityGoals = g.castles
      .map((castle) => ({ castle, parsed: this.goalsFor(g.castleId(castle), castle.name) }))
      .filter((x) => x.parsed);
    for (const p of M.trainingHeroPlan(g, cityGoals, this.state)) {
      this.log(`   ${p.note}`);
      for (const a of p.actions || []) {
        if (this.dryRun) { this.log(`   [plan] ${a.label}`); continue; }
        try {
          const hero = (a.from.heros || []).find((h) => (h.name || '').toLowerCase() === String(a.heroName).toLowerCase());
          if (!hero) { this.log(`   ${a.label} -> hero vanished`); continue; }
          // a mayor cannot march, so stand him down first
          const chiefed = (a.from.heros || []).some((h) => h.id === hero.id && Number(h.status) === 1);
          if (chiefed) await g.dischargeChief(g.castleId(a.from));
          const xy = g.castleXY(a.to);
          const bean = g.buildArmyBean({
            missionType: C.MISSION.reinforce, heroId: hero.id,
            targetPoint: C.coordsToFieldId(xy.x, xy.y), troops: { scouter: 1 },
          });
          const r = await g.newArmy(g.castleId(a.from), bean);
          this.log(`   ${a.label} -> ${r.ok === 1 ? 'marching' : (r.errorMsg || 'ok=' + r.ok)}`);
          if (r.ok === 1) { this.state.hero[String(a.heroName).toLowerCase()].since = Date.now(); }
        } catch (e) { this.log(`   ${a.label} -> ${e.message}`); }
      }
    }
    saveState(this.state, this.accountId);
  }
}

module.exports = { Engine, troopPlan, fortPlan, buildPlan, fitFromError };
