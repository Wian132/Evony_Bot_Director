'use strict';
// The research goal (wiki: Research, TechGoals, ResearchTypes, Abbreviations).
//
//   research lo:5,ho:5,com:4        Logistics to L5, Horseback Riding to L5, Compass to L4
//   research ?a:10?pr:10            Privateering to L10, once the Academy is L10
//   research pr:10?a:10?            the same, the condition written after
//
// NEAT: "As with troop and build goals, the bot will perform research goals line
// by line in sequential order" — the next research line starts once the one
// before it is finished (wiki Plan: "Then it would begin the 2nd line of that
// task"). "The bot will automatically build and upgrade any buildings necessary
// to complete research goals." config research:0 pauses research; research:1 is
// implied by any research line. A ?condition? tests building and research levels
// exactly as on a build line (goals.js buildCondition, engine.js conditionFails),
// and inside a condition `st` is the Stable and `sp` Stockpile; on the research
// line itself `st` is Stockpile too.
//
// What the game asks of a research, as the client's research window checks it
// before it offers the button (TechItemUI.onConditionTime, :442-460):
//   permition true, every conditionBean building, tech and item with its
//   successFlag (UIUtil.isConditionMatch), and the food, wood, stone, iron and
//   gold in the city (UIUtil.isResourceConditionMatch). The bean lists what the
//   NEXT level needs (TechItemUI.onMouseOver: level + 1). Then it sends
//   tech.research {castleId, techId} (TechItemUI.onStudy, TechCommand.as:54-65).
//   The list (tech.getResearchList {castleId}, AvailableResearchListBean) shows,
//   per tech, its level, the city's cap "Lv.<level>/Ct.<avalevel>"
//   (TechItemUI.as:302), and whether it is being researched and in which city
//   (upgradeing, castleId: Technology.onGetResearchList puts the current city's
//   in one slot and the other cities' in a list of their own, :761-799).
//   Techs are the account's: "Technologies can be shared in all your cities so
//   long as their academies reach the required level", and "One academy can
//   only conduct one research at a time. However, several academies in your
//   cities can perform multiple researches at the same time" (the Academy's own
//   description, GetDataXML_XMLBuilding). So a city researches one tech at a
//   time, and a tech another city is researching is not started here.
//
// Each slice the engine (engine.js focus) plans this twice around the builder:
// first for the buildings research needs, which the builder takes on first
// ("with priority", Engine.resolveBuild), then for the research itself, once
// the builder has said what it keeps in the bank and which techs its own orders
// need (cityState.researchWants, Step 11). The research list is read only when a
// decision is due (Engine.readResearch), and read again right before a start.
const C = require('./constants');
const { Game } = require('./game');

const n = (x) => Number(x || 0);
const ACADEMY = 25;
// a prerequisite tech's prerequisite's ... this deep at most (as engine.js PREREQ_DEPTH)
const DEPTH = 4;
// The list is read at most this often while a target is open, and a start
// needs a list read within START_FRESH: tech.research names the tech, not the
// level, so a level another city finished since the last read would otherwise
// be researched one past the goal.
const RESEARCH_TTL = 5 * 60e3;
const START_FRESH = 60e3;
// While every target is met and only a ?condition? naming research holds a
// group back, the list is looked at no more often than a build condition's.
const COND_TTL = 10 * 60e3;
const COST_KEYS = ['food', 'wood', 'stone', 'iron', 'gold'];

// The Academy level that first offers each tech, from the client's building
// table (GetDataXML_XMLBuilding, Academy upLevelDesc): "Level 1 Academy allows
// Agriculture, Lumbering and Military Science to be researched" ... "Machinery
// is allowed to be researched at level 9 Academy", "Privateering ... at level 10
// Academy". The server's own answer (permition, the conditionBean) decides; this
// is only asked when a city has no Academy, or the server says no (permition
// false) while the Academy is below the level it offers the tech from.
const ACADEMY_FOR = {
  1: 1, 2: 1, 8: 1,          // Agriculture, Lumbering, Military Science
  3: 2, 4: 2, 9: 2,          // Masonry, Mining, Military Tradition
  5: 3, 7: 3, 10: 3,         // Metal Casting, Informatics, Iron Working
  11: 4, 12: 4, 14: 4,       // Logistics, Compass, Archery
  13: 5, 17: 5,              // Horseback Riding, Construction
  15: 6, 16: 6,              // Stockpile, Medicine
  18: 8, 19: 9, 20: 10,      // Engineering, Machinery, Privateering
};

// ------------------------------------------------------------------ words
// NEAT's words for a research: the codes (goals.js TECH_ABBR: ag lu mas mi met in
// ms mt ir lo com ho ar sp med con en mac pr), `st` for Stockpile on a research
// line (wiki Research: "You may still use st for stockpiling in pure research
// goals"), the full names (wiki Research, ResearchTypes), "stockpiling" (wiki
// Plan), and the words NEAT's startresearch takes (metal, info, ironwork,
// horseback, construct, engineer, privateer). A plan line (wiki Plan) reads `st`
// as the Stable, so { st: false } leaves it out.
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const EXTRA_WORDS = { st: 15, stockpiling: 15, metal: 5, info: 7, ironwork: 10, horseback: 13, construct: 17, engineer: 18, privateer: 20 };
function techByWord(word, { st = true } = {}) {
  const k = slug(word);
  if (!k || (k === 'st' && !st)) return null;
  // goals.js loads this module while it sets itself up, so it is asked here, not at the top
  const { TECH_ABBR } = require('./goals');
  const name = TECH_ABBR[k];
  return (name ? C.TECH_BY_CODE[slug(name)] : C.TECH_BY_CODE[k] || C.TECH_BY_ID[EXTRA_WORDS[k]]) || null;
}
const techName = (id) => (C.TECH_BY_ID[id] || {}).name || `tech ${id}`;
const buildingName = (id) => (C.BUILDING_BY_ID[id] || {}).name || `building ${id}`;

// tech:level -> { techId, name, level, raw } or null, with the reason in errs.
// Levels run 1 to 10 (TechConstants.as:5). A three-part target is a building's
// (type:level:quantity): the wiki's own `research ?ho:10?st:0:0` says it
// demolishes the Stable, but a demolition never comes from a research line here
// — it goes on a build line, where the same words mean the same thing.
function researchTarget(part, errs, { st = true, where = '' } = {}) {
  const bits = part.split(':');
  const tech = techByWord(bits[0], { st });
  if (bits.length === 3) {
    errs.push(`"${part}" reads as a building target (type:level:quantity) — a research line takes research:level; put it on a build line (build ${part})${where}`);
    return null;
  }
  if (!tech) {
    // a building's code (a:10): the buildings research needs are built by themselves
    const { buildingOf } = require('./goals');
    const def = buildingOf(bits[0]);
    errs.push(def
      ? `"${part}": ${bits[0]} is the ${def.name}, a building — a research line takes research:level, and builds what its research needs by itself; a building target goes on a build line (build ${part})${where}`
      : `unknown research "${bits[0]}"${where} — ag lu mas mi met in ms mt ir lo com ho ar st (or sp) med con en mac pr, or the full name`);
    return null;
  }
  if (bits.length !== 2) { errs.push(`"${part}" needs research:level, e.g. lo:5${where}`); return null; }
  if (!/^\d+$/.test(bits[1].trim())) { errs.push(`"${part}": level "${bits[1]}" is not a whole number${where}`); return null; }
  const level = Number(bits[1]);
  if (level < 1 || level > 10) { errs.push(`"${part}": a research level is 1 to 10${where}`); return null; }
  return { techId: tech.typeId, name: tech.name, level, raw: part };
}

// ------------------------------------------------------------------ parser
const parsers = {
  // research <tech>:<level>[,<tech>:<level>...] — groups separated by spaces,
  // each with its own ?condition? before or after it, as on a build line
  research: {
    kind: 'directive', multi: true,
    parse(args) {
      const G = require('./goals');
      const errs = [], targets = [], groups = [];
      // "horseback riding:5" would fall apart into two groups (goals.js TWO_WORDS)
      const raw = args.join(' ').replace(G.TWO_WORDS, '$1$2')
        .replace(/\?[^?]*\?/g, (m) => m.replace(/\s+/g, ''));
      for (const text of raw.split(/\s+/)) {
        if (!text) continue;
        const m = text.match(/^(?:\?([^?]*)\?)?([^?]*)(?:\?([^?]*)\?)?$/);
        if (!m || !m[2]) {
          // whichever targets that condition was meant for, none may run without it
          errs.push(`"${text}": a ?condition? goes right before or right after its targets, e.g. ?a:10?pr:10 or pr:10?a:10?; the whole line is left out`);
          return { targets: [], groups: [], errors: errs };
        }
        const conds = [m[1], m[3]].filter((c) => c !== undefined);
        let when = null;
        if (conds.length) {
          const c = G.buildCondition(conds.join(','));
          // never research a conditional target without its condition
          if (c.errors.length) { for (const e of c.errors) errs.push(`${e}; "${text}" is left out`); continue; }
          when = c.terms;
        }
        const group = { condition: conds.length ? conds.join(',') : null, when, targets: [] };
        for (const part of m[2].split(',')) {
          if (!part.trim()) continue;
          const t = researchTarget(part.trim(), errs);
          if (!t) continue;
          Object.assign(t, { when, condition: group.condition });
          group.targets.push(t);
          targets.push(t);
        }
        if (group.targets.length) groups.push(group);
      }
      if (!raw.trim()) errs.push('needs at least one research:level, e.g. research lo:5');
      return { targets, groups, errors: errs };
    },
  },
};

// ------------------------------------------------------------------ helpers
// 90 -> "1m", 5400 -> "1h 30m" (engine.js dur)
function dur(sec) {
  const s = Math.max(0, Math.round(n(sec)));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
// 120000 -> "120k" (engine.js shortNum)
function shortNum(x) {
  const v = Math.round(n(x));
  const cut = (d, s) => `${Math.round((v / d) * 10) / 10}${s}`;
  return v >= 1e9 ? cut(1e9, 'b') : v >= 1e6 ? cut(1e6, 'm') : v >= 1e4 ? cut(1e3, 'k') : v.toLocaleString('en-US');
}
const costText = (cost) => COST_KEYS.filter((k) => n(cost[k]) > 0).map((k) => `${shortNum(cost[k])} ${k}`).join(', ');
const costOf = (cond) => Object.fromEntries(COST_KEYS.filter((k) => n(cond && cond[k]) > 0).map((k) => [k, n(cond[k])]));

// A research the game's cache says runs now (Game.runningResearch). One with no
// end time is taken as running for a while after it was seen, then read again.
function runningLive(run, now = Date.now()) {
  if (!run || !run.typeId) return false;
  if (n(run.endTime) > 0) return n(run.endTime) > now;
  return now - n(run.seenAt) < RESEARCH_TTL;
}

// What both the builder and the research goal keep in the bank, for the troop
// and wall batches (engine.js troopPlan / fortPlan read ctx.buildReserve).
function mergeReserve(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const out = { label: `${a.label || 'the next construction'} and ${b.label || 'the next research'}` };
  for (const k of [...COST_KEYS, 'population']) if (n(a[k]) + n(b[k]) > 0) out[k] = n(a[k]) + n(b[k]);
  return out;
}

const freshForStart = (list, now = Date.now()) => !!(list && list.beans && !list.error && now - n(list.at) < START_FRESH);
const backoffKey = (techId) => `research:${techId}`;

// Does this city need the research list read? A research line, or config
// research:1 while the build lines want a tech (cityState.researchWants), and
// not config research:0.
function listNeeded(parsed, cityState = {}) {
  const cfg = (parsed && parsed.config) || {};
  if (cfg.research === 0) return false;
  if (((parsed && parsed.goals) || []).some((x) => x.name === 'research')) return true;
  return (cfg.research === 1 || planOn(parsed && parsed.goals, cfg)) && (cityState.researchWants || []).length > 0;
}

// Step 19: a city working plan lines researches, as one with a research line
// does: the plan line in work comes to researchPlan as a research line of its
// own (goal-plan.js expand), and the techs its buildings need are researched too.
const planOn = (goals, cfg) => (goals || []).some((x) => x.name === 'plan') && (cfg || {}).plan !== 0;

// How often the list is worth reading, from the last one read:
//   0             now: a target is open and a building the list's answer hangs
//                 on has gone up since it was read (raisedSince)
//   RESEARCH_TTL  a target is below its goal (or the build lines want research)
//   COND_TTL      every target met, but a ?condition? naming research holds a
//                 group back: another city's research may meet it
//   null          every target met and nothing waits on research: no read
// Buildings in a condition are the live ones, so they need no read.
function readEvery(ctx, list, cityState = {}) {
  if (!list || !list.levels) return RESEARCH_TTL;
  const open = () => (raisedSince(list, ctx.castle) ? 0 : RESEARCH_TTL);
  if ((cityState.researchWants || []).length) return open();
  const { conditionFails } = require('./engine');
  const live = standing(ctx.castle);
  let cond = false;
  for (const line of (ctx.goals || []).filter((x) => x.name === 'research')) {
    for (const gr of line.groups || []) {
      if (gr.when && conditionFails(gr.when, live, list)) {
        if (gr.when.some((c) => c.tech)) cond = true;
        continue;
      }
      if (gr.targets.some((t) => n(list.levels[t.techId]) < t.level)) return open();
    }
  }
  return cond ? COND_TTL : null;
}

// The highest level of each building type in a city, as a list read records it
// (Engine.readTechs: `tops`).
function topsOf(castle) {
  const out = {};
  for (const b of standing(castle)) out[n(b.typeId)] = Math.max(n(out[n(b.typeId)]), n(b.level));
  return out;
}

// The buildings a list's answer hangs on: the Academy (its cap, what it
// offers: permition) and every building a bean says is short. One of them
// higher now than when the list was read makes that answer out of date — the
// moment the research waited for — so the list is read again then, not a few
// minutes later.
function raisedSince(list, castle) {
  if (!list || !list.tops || !castle) return false;
  const types = new Set([ACADEMY]);
  for (const b of list.beans || []) {
    for (const x of ((b && b.conditionBean) || {}).buildings || []) if (!x.successFlag) types.add(n(x.typeId));
  }
  const now = topsOf(castle);
  return [...types].some((typeId) => n(now[typeId]) > n(list.tops[typeId]));
}

// The city's buildings: standing now, and as they will stand once the work on
// them is done (engine.js standing / finished).
const standing = (castle) => ((castle && castle.buildings) || []).filter((b) => !(n(b.status) === 0 && n(b.level) === 0));
const doneLevel = (b) => n(b.level) + (n(b.status) === 1 ? 1 : n(b.status) === 2 ? -1 : 0);

// Everything a plan reads, in one place.
function envOf(ctx, cityState, g) {
  const castle = ctx.castle || {};
  const cid = g && typeof g.castleId === 'function' ? g.castleId(castle) : castle.id;
  const list = ctx.research || null;
  const beans = new Map();
  for (const b of (list && list.beans) || []) beans.set(n(b.typeId), b);
  const live = standing(castle);
  const levels = (list && list.levels) || {};
  const reserve = ctx.buildReserve || null;
  const now = g && typeof g.now === 'function' ? g.now() : Date.now();
  const cityName = (id) => {
    const c = ((g && g.castles) || []).find((x) => Number(g.castleId(x)) === Number(id));
    return (c && c.name) || `city ${id}`;
  };
  // What this city researches now: by the game's cache, where a start made
  // since the list was read shows first (Game.research notes it), or by the
  // list, the one bean running with this city's id.
  const run = g && typeof g.runningResearch === 'function' ? g.runningResearch(cid) : null;
  const inList = [...beans.values()].find((b) => b.upgradeing && Number(b.castleId) === Number(cid)
    && !(n(b.endTime) > 0 && n(b.endTime) <= now));
  const runningHere = runningLive(run, now) ? run
    : inList ? { typeId: n(inList.typeId), level: n(inList.level), endTime: n(inList.endTime), seenAt: n(list.at) } : null;
  return {
    g, castle, cid, list, beans, live, levels, reserve, now, cityState, cityName, runningHere,
    config: ctx.config || {},
    items: g && g.player && Array.isArray(g.player.items) ? g.player.items : null,
    levelOf: (id) => (beans.has(id) ? n(beans.get(id).level) : levels[id] === undefined ? null : n(levels[id])),
    nowLevel: (typeId) => Math.max(0, ...live.filter((b) => n(b.typeId) === typeId).map((b) => n(b.level))),
    doneLevel: (typeId) => Math.max(0, ...live.filter((b) => n(b.typeId) === typeId).map(doneLevel)),
    // what the bank holds, less what the builder keeps for its next order
    bank: (k) => Game.bankOf(castle.resource || {}, k),
    kept: (k) => n(reserve && reserve[k]),
    // the city researching this tech, by the game's cache of what runs where
    // (a start this engine made since the list was read shows here first)
    elsewhere: (techId) => {
      if (!g || typeof g.runningResearch !== 'function') return null;
      for (const c of g.castles || []) {
        const id = g.castleId(c);
        if (Number(id) === Number(cid)) continue;
        const run = g.runningResearch(id);
        if (run && n(run.typeId) === techId && runningLive(run, now)) return { castleId: id, endTime: n(run.endTime) };
      }
      return null;
    },
  };
}

// ------------------------------------------------------------- one target
// What it takes to bring one tech to `goal` in this city, from the research
// list and the city as it stands. Pure. Returns { kind, ... }:
//   met        at the goal already
//   running    being researched in this city now
//   elsewhere  being researched in another city (`where`), or a tech it needs is
//   start      this tech (or a tech it needs first: techId, `first`) can start now
//   hold       it could, but the bank is short (`short`)
//   build      a building must go up first (`waits`); `wants` go to the builder
//   blocked    it cannot go (`why`): an item not held, a loop, the game says no
// Every kind carries `wants`: [{typeId, level, name, for}] for the builder.
function resolveTech(env, techId, goal, depth = 0, chain = []) {
  const name = techName(techId);
  const bean = env.beans.get(techId);
  const lv = bean ? n(bean.level) : env.levelOf(techId);
  const base = { techId, name, goal, from: n(lv), to: n(lv) + 1, wants: [] };
  const label = `${name} L${n(lv)}->L${n(lv) + 1}`;
  const want = (typeId, level) => ({ typeId, level, name: buildingName(typeId), for: `${name} L${n(lv) + 1}` });
  // "Academy L4 (L2 here)", or ", under way" once the builder is on it
  const waitText = (w) => `${w.text}${env.doneLevel(w.typeId) >= w.need ? ', under way' : ''}`;
  if (lv !== null && lv >= goal) return { ...base, kind: 'met' };
  // running here, by the list or by a start since it was read
  if (env.runningHere && n(env.runningHere.typeId) === techId) {
    return { ...base, kind: 'running', label, endTime: n(env.runningHere.endTime) };
  }
  if (!bean) {
    // a city without an Academy may be sent no list for it at all
    if (env.nowLevel(ACADEMY) === 0) {
      const need = ACADEMY_FOR[techId] || 1;
      const w = { typeId: ACADEMY, need, text: `an Academy (this city has none; ${name} is offered from Academy L${need})` };
      return { ...base, kind: 'build', label, wants: env.doneLevel(ACADEMY) >= need ? [] : [want(ACADEMY, need)], waits: [waitText(w)] };
    }
    return { ...base, kind: 'blocked', label, why: `${name} is not in this city's research list` };
  }
  if (bean.upgradeing && !(n(bean.endTime) > 0 && n(bean.endTime) <= env.now)) {
    if (Number(bean.castleId) === Number(env.cid)) return { ...base, kind: 'running', label, endTime: n(bean.endTime) };
    return { ...base, kind: 'elsewhere', label, where: env.cityName(bean.castleId), endTime: n(bean.endTime) };
  }
  const other = env.elsewhere(techId);
  if (other) return { ...base, kind: 'elsewhere', label, where: env.cityName(other.castleId), endTime: other.endTime };
  const f = (env.cityState.failures || {})[backoffKey(techId)];
  if (f && Date.now() < f.until) {
    return { ...base, kind: 'blocked', label, backoff: true,
      why: `${label}: ${f.msg || 'refused'} (retry in ${Math.max(1, Math.round((f.until - Date.now()) / 60000))}m, ${f.n} attempt(s))` };
  }

  const cond = bean.conditionBean || {};
  // Buildings. A flag the read gave is as old as the read, so a building the
  // city has raised since counts as done (as engine.js resolvePrereqs does).
  const waits = [];
  for (const b of cond.buildings || []) {
    const typeId = n(b.typeId), need = n(b.level);
    if (b.successFlag || env.nowLevel(typeId) >= need) continue;
    waits.push({ typeId, need, text: `${buildingName(typeId)} L${need} (L${env.nowLevel(typeId)} here)` });
  }
  // The Academy, beyond what the bean names:
  //   its cap   "Lv.3/Ct.3" (TechItemUI.as:302) with the Academy no higher than
  //             3: the Academy goes up a level first — "The higher its level,
  //             the more technologies it can research" (its description). With
  //             the Academy above the level already, the cap is not the
  //             Academy's and the rest of the bean decides.
  //   unlock    the game says no (permition false) and the Academy is below the
  //             level the client's building table offers the tech from
  //             (ACADEMY_FOR: Machinery from L9, Privateering from L10).
  // One Academy wait, at the highest level any of these asks.
  const academy = env.nowLevel(ACADEMY);
  const cap = n(bean.avalevel);
  const unlock = ACADEMY_FOR[techId] || 1;
  const byBean = waits.find((w) => w.typeId === ACADEMY);
  let acad = byBean || null;
  if (n(lv) >= cap && academy < n(lv) + 1 && (!acad || acad.need < n(lv) + 1)) {
    acad = { typeId: ACADEMY, need: n(lv) + 1,
      text: academy ? `the Academy above L${academy} (${name} is at its cap here, Lv.${n(lv)}/Ct.${cap})` : 'an Academy (this city has none)' };
  }
  if (bean.permition === false && academy < unlock && (!acad || acad.need < unlock)) {
    acad = { typeId: ACADEMY, need: unlock, text: `Academy L${unlock} (${name} is offered from Academy L${unlock}; ${academy ? `L${academy}` : 'none'} here)` };
  }
  if (acad && acad !== byBean) {
    if (byBean) waits.splice(waits.indexOf(byBean), 1);
    waits.unshift(acad);
  }
  // techs it needs first, researched first
  const subs = [];
  for (const t of cond.techs || []) {
    const id = n(t.id ?? t.typeId), need = n(t.level);
    const have = env.levelOf(id);
    if (t.successFlag || (have !== null && have >= need)) continue;
    if (id === techId || chain.includes(id)) {
      return { ...base, kind: 'blocked', label, why: `${label} needs ${techName(id)} L${need}, which needs it back` };
    }
    if (depth >= DEPTH) return { ...base, kind: 'blocked', label, why: `${label}: prerequisites nest deeper than ${DEPTH}` };
    subs.push(resolveTech(env, id, need, depth + 1, [...chain, techId]));
  }
  const items = Game.unmetOf({ items: cond.items || [] }, { items: env.items }).filter((m) => m.kind === 'item');
  const wants = [
    ...waits.filter((w) => env.doneLevel(w.typeId) < w.need).map((w) => want(w.typeId, w.need)),
    ...subs.flatMap((s) => s.wants || []),
  ];
  const first = (s) => ({ ...s, wants, first: true, forLabel: `${name} L${n(lv) + 1}` });
  const start = subs.find((s) => s.kind === 'start');
  if (start) return first(start);
  const hold = subs.find((s) => s.kind === 'hold');
  if (hold) return first(hold);
  const subBuild = subs.filter((s) => s.kind === 'build');
  if (waits.length || subBuild.length) {
    return { ...base, kind: 'build', label, wants,
      waits: [...waits.map(waitText), ...subBuild.map((s) => `${s.name} L${s.to} first, which waits for ${s.waits.join(', ')}`)] };
  }
  const under = subs.find((s) => s.kind === 'elsewhere' || s.kind === 'running');
  if (under) {
    return { ...base, kind: 'elsewhere', label, wants, where: under.kind === 'running' ? env.cityName(env.cid) : under.where,
      endTime: under.endTime, via: `${under.name} L${under.to}` };
  }
  const stuck = subs.find((s) => s.kind === 'blocked');
  if (stuck) return { ...base, kind: 'blocked', label, wants, why: `${label} needs ${stuck.name} L${stuck.goal}: ${stuck.why}` };
  if (items.length) {
    return { ...base, kind: 'blocked', label, wants, why: `${label} needs ${items.map((m) => `${m.need} ${m.name}, ${m.have ? `only ${m.have} held` : 'none held'}`).join('; ')}` };
  }
  if (bean.permition === false) return { ...base, kind: 'blocked', label, wants, why: `the game does not offer ${label} here yet, and names nothing it lacks` };
  // the cost: food, wood, stone, iron and gold (UIUtil.isResourceConditionMatch
  // checks no population), less what the builder keeps
  const cost = costOf(cond);
  const short = COST_KEYS.filter((k) => n(cost[k]) > env.bank(k) - env.kept(k))
    .map((k) => ({ key: k, need: n(cost[k]), have: env.bank(k), kept: env.kept(k) }));
  if (short.length) return { ...base, kind: 'hold', label, wants, short, cost };
  return { ...base, kind: 'start', label, wants, cost };
}

// ------------------------------------------------------------------ the plan
// One slice's research in one city. Pure: reads ctx.research (the list,
// Engine.readResearch), ctx.researchWants (the techs the build lines need,
// Step 11), ctx.buildReserve (what the builder keeps), ctx.researchBuildBlocked
// (what the builder cannot do for the research goal) and the game's cache of
// what runs where; sends nothing. Returns null when the city has nothing to
// research, else { note, actions, buildWants, reserve, line }:
//   actions     [{kind:'research', techId, from, to, label, cost}], one at most
//   buildWants  [{typeId, level, name, for}]: buildings the builder raises
//               first (engine.js resolvePrereqs)
//   reserve     the cost of the research started or waited for, which troop
//               and wall batches leave in the bank
//
// Order: the techs the build lines need come first, as a building's
// prerequisite does (the wiki does not say; they are what stops the builder),
// but only one that can start now is taken — they never hold the research lines
// up. Then the research lines, in order: the first line with a target below its
// goal is worked on, and the next waits for it, even while that line waits for
// its Academy (wiki Build: "Make sure your research goals are sensibly ordered
// so that you get the basics built before trying to start on level 1-9
// academy!"). Within a line the targets go in the order written; one waiting
// for a building lets the next go meanwhile, one waiting for resources does not
// (the builder's rule too: engine.js resolvePrereqs). A line whose every open
// target is being researched in another city, or cannot go at all (a refusal
// backed off, an item not held, the game says no), is passed over and the next
// line worked on, as a build line waiting on work already under way is
// (engine.js buildPlan); the wiki does not say.
function researchPlan(ctx, cityState = {}, g = ctx.game) {
  const lines = (ctx.goals || []).filter((x) => x.name === 'research');
  const cfg = ctx.config || {};
  const fromBuild = (ctx.researchWants || []).filter((w) => w && n(w.techId) > 0);
  if (!lines.length && !fromBuild.length) return null;
  const idle = (note, extra = {}) => ({ note: `research: ${note}`, actions: [], buildWants: [], reserve: null, ...extra });
  const buildNeeds = () => fromBuild.map((w) => `${w.name || techName(w.techId)} L${w.level}${w.for ? ` (for ${w.for})` : ''}`).join(', ');
  if (cfg.research === 0) return idle('paused by config research:0', { paused: true });
  // NEAT's build goal builds buildings, not research; its research goal
  // researches what the research lines say. So the techs the build lines need
  // are researched only in a city that researches at all: one with a research
  // line, or config research:1. Elsewhere the build note and this one say so.
  if (!lines.length && cfg.research !== 1 && !planOn(ctx.goals, cfg)) {
    return idle(`the build lines need ${buildNeeds()} — nothing researches it: add a research line, or config research:1, and the bot researches what the build lines need`);
  }
  const env = envOf(ctx, cityState, g);
  // No list read, or none that could be read: nothing is planned on a guess —
  // not even an Academy, since the levels may be met already (they are the
  // account's). The client reads the list for any city, Academy or not
  // (BottomToolBar.refresh), so an unreadable one is the server's moment.
  if (!env.list || !env.list.beans) {
    return idle(`the research list is ${env.list && env.list.error ? `unreadable (${env.list.error})` : 'not read yet'}`);
  }
  // The last list stands for what it asks of the builder, but a read that
  // failed since starts nothing: tech.research names no level, so a start on an
  // old list can research one past the goal.
  const stale = !!env.list.error;
  const { conditionFails } = require('./engine');
  const runningHere = env.runningHere;
  const left = (end) => (n(end) > env.now ? `, ${dur((n(end) - env.now) / 1000)} left` : '');

  const tiers = [];
  if (fromBuild.length) {
    tiers.push({ tag: 'for the build lines', lead: true,
      targets: fromBuild.map((w) => ({ techId: n(w.techId), level: n(w.level), for: w.for || null })) });
  }
  // the plan line in work (Step 19) comes first with its own tag, "plan line 1/2"
  const own = lines.filter((l) => !l.plan);
  lines.forEach((line) => tiers.push(line.plan ? { tag: line.tag || `plan line ${line.plan}`, line, index: null, plan: line.plan }
    : { tag: `line ${own.indexOf(line) + 1}/${own.length}`, line, index: own.indexOf(line) + 1 }));

  let pick = null, hold = null, active = null, open = 0, condHeld = false, sawRunning = false;
  const parts = [], skipped = [], wants = [];
  for (const tier of tiers) {
    let targets = tier.targets;
    const condWaits = [];
    if (tier.line) {
      targets = [];
      for (const gr of tier.line.groups || []) {
        const why = gr.when ? conditionFails(gr.when, env.live, env.list) : null;
        if (why) condWaits.push(`?${gr.condition}? not met (${why})`);
        else targets.push(...gr.targets);
      }
    }
    const results = targets.map((t) => ({ t, r: resolveTech(env, t.techId, t.level) })).filter((x) => x.r.kind !== 'met');
    if (condWaits.length) condHeld = true;
    if (!results.length) {
      if (condWaits.length) skipped.push(`${tier.tag} waits: ${condWaits.join('; ')}`);
      continue;
    }
    if (!tier.lead) open++;
    for (const x of results) wants.push(...x.r.wants);
    const said = [];
    for (const { t, r } of results) {
      const goal = `${r.first ? `${r.label} first, for ${r.forLabel}` : r.label}${tier.lead && t.for ? ` (${t.for} needs ${techName(t.techId)} L${t.level})` : ''}`;
      if (r.kind === 'start') {
        if (!pick && !runningHere && !stale && (tier.lead || !hold)) { pick = { ...r, tag: tier.tag, goal }; said.push(`${goal}: starting`); }
        else said.push(`${goal}: ready`);
      } else if (r.kind === 'hold') {
        if (!tier.lead && !hold && !pick) hold = { ...r, tag: tier.tag, goal };
        said.push(`waiting for ${r.short.map((s) => `${shortNum(s.need)} ${s.key} (${shortNum(s.have)} held${s.kept ? `, ${shortNum(s.kept)} kept for the builder` : ''})`).join(', ')} to research ${goal}`);
      } else if (r.kind === 'running') {
        sawRunning = true;
        said.push(`researching ${r.label} here${left(r.endTime)}`);
      } else if (r.kind === 'elsewhere') {
        said.push(`${goal}${r.via ? ` waits for ${r.via},` : ''} under way in ${r.where}${left(r.endTime)}`);
      } else if (r.kind === 'build') {
        said.push(`${goal} needs ${r.waits.join(', ')}${r.wants.length ? ': the builder takes it on first' : ''}`);
      } else {
        said.push(r.why);
      }
    }
    parts.push(`${tier.tag}: ${said.join('; ')}`);
    if (condWaits.length) parts.push(`${tier.tag} also waits: ${condWaits.join('; ')}`);
    if (tier.lead) continue;
    // passed over: everything open here is under way elsewhere or cannot go
    if (results.every((x) => x.r.kind === 'elsewhere' || x.r.kind === 'blocked')) {
      skipped.push(`${tier.tag} passed over for now`);
      continue;
    }
    active = tier;
    break;
  }

  // one want per building, at the highest level asked, in the order asked
  const buildWants = [];
  for (const w of wants) {
    const had = buildWants.find((x) => x.typeId === w.typeId);
    if (!had) buildWants.push({ ...w });
    else if (w.level > had.level) Object.assign(had, { level: w.level, for: w.for });
  }
  const out = [];
  if (runningHere && !sawRunning) {
    // what runs here is none of the lines' (a script's, the console's, or a
    // target met since): the city waits for it all the same
    const same = env.beans.get(n(runningHere.typeId));
    const lv = runningHere.level !== null && runningHere.level !== undefined ? n(runningHere.level) : same ? n(same.level) : null;
    out.push(`researching ${techName(n(runningHere.typeId))}${lv !== null ? ` L${lv}->L${lv + 1}` : ''} here${left(runningHere.endTime)}`);
  }
  out.push(...parts);
  if (!open && own.length && !condHeld) out.push(`all ${own.length} research line(s) met`);
  else if (!open && own.length) out.push('every research target not held by a ?condition? is met');
  out.push(...skipped);
  if (stale) out.push(`nothing starts until the research list reads again (${env.list.error})`);
  if (buildWants.length && cfg.building === 0) {
    out.push(`construction is paused by config building:0, so ${buildWants.map((w) => `${w.name} L${w.level}`).join(', ')} waits`);
  }
  // what the builder said it cannot do for them this slice (engine.js
  // resolvePrereqs): no plot ("Needs space"), no Michelangelo's Script held, a
  // building the build lines take down
  const cannot = (ctx.researchBuildBlocked || []).filter(Boolean);
  if (buildWants.length && cannot.length) out.push(`the builder cannot place it now: ${cannot.join('; ')}`);
  if (buildWants.some((w) => w.level >= 10)) {
    out.push('a level-10 building takes a Michelangelo\'s Script: the builder spends one if it is held and passes the upgrade over if not (the NEAT wiki warns its bot spends them too)');
  }
  const actions = pick ? [{
    kind: 'research', techId: pick.techId, from: pick.from, to: pick.to, cost: pick.cost,
    label: `research ${pick.goal}`,
  }] : [];
  const reserve = pick ? { ...pick.cost, label: `research ${pick.label}` }
    : hold && !runningHere ? { ...hold.cost, label: `research ${hold.label}` } : null;
  if (hold && !pick && !runningHere && costText(hold.cost)) {
    out.push(`troop and wall batches leave ${costText(hold.cost)} in the bank for it`);
  }
  return {
    note: `research: ${out.join('; ') || 'nothing to research'}`,
    actions, buildWants, reserve: reserve && costText(reserve) ? reserve : null,
    line: active && active.index ? active.index : null, plan: active && active.plan ? active.plan : null, lines: own.length,
    running: runningHere ? n(runningHere.typeId) : null,
  };
}

// ---------------------------------------------------------------- executor
const executors = {
  // tech.research {castleId, techId} (TechCommand.as:54-65); Game.research also
  // notes it as running, for the free finish (speedups.js) and other cities.
  async research(game, castle, action) {
    return game.research(game.castleId(castle), action.techId);
  },
};

module.exports = {
  parsers,
  // engine.js plans this itself, around the builder (focus), not with the other modules
  plans: { research: researchPlan },
  executors,
  configKeys: ['research'],
  researchPlan, resolveTech, researchTarget, techByWord, listNeeded, readEvery, runningLive, mergeReserve,
  freshForStart, backoffKey, topsOf, raisedSince, ACADEMY_FOR, RESEARCH_TTL, START_FRESH, COND_TTL,
};
