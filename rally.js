'use strict';
// Rally spot slots, shared by every goal that starts a march.
//
// A city can have as many marches out as its Rally Spot level. Going, camped or
// coming home, each one holds a slot until it is back, and the server refuses a
// march over that (the console's Armies tab counts the same way).
//
// rallypolicy (wiki: RallyPolicy) limits how many slots each KIND of goal march
// may hold at once. Returning marches count, as they do in NEAT:
//
//   rallypolicy n:8 n:10:1 r:2 t:1 max:8
//
//     n    npc farming           n:<level>:<slots> limits one level (n:*:8 = n:8)
//     b    buildnpc              occupying a flat to build on
//     v    valley farming        no valley goal yet; accepted so NEAT files parse
//     m    medal hunting         likewise
//     t    troop reinforcements  requesttroops, traininghero
//     r    resource transports   requestresources
//     max  ours, not NEAT's: goals start nothing once this many of the city's
//          slots are busy, whatever holds them. A L10 rally spot with max:8
//          always leaves two for scripts and manual marches.
//
// It only ever lowers what goals may do. It reserves nothing, and nothing raises
// the rally spot's own limit. The older spelling /npc:3 /valley:2 still works.
//
// The server does not say which march a goal sent, so a live march's kind comes
// from its mission: attack n, transport r, reinforce t, construct b. A script's
// attack on a camp therefore counts as npc farming.
const C = require('./constants');

const n = (x) => Number(x || 0);

const RALLY_SPOT_TYPE = 29;          // constants.js BUILDINGS

const KIND_BY_MISSION = {
  [C.MISSION.attack]: 'n',
  [C.MISSION.transport]: 'r',
  [C.MISSION.reinforce]: 't',
  [C.MISSION.construct]: 'b',
};

const KIND_NAME = {
  n: 'npc farming', b: 'buildnpc', v: 'valley', m: 'medal hunting',
  t: 'troop reinforcement', r: 'resource transport',
};

const TYPE_ALIAS = {
  n: 'n', npc: 'n', b: 'b', buildnpc: 'b', v: 'v', valley: 'v', m: 'm', medal: 'm',
  t: 't', troop: 't', troops: 't', reinforce: 't',
  r: 'r', res: 'r', resource: 'r', resources: 'r', transport: 'r',
  max: 'max', all: 'max', total: 'max',
};

// A march the engine sent that the server has not listed back yet. The army
// list push normally follows within a second; this is only the fallback.
const PENDING_TTL = 3 * 60e3;
// A live march started this long before our record of sending it is ours.
const MATCH_SLACK = 30e3;

// ---------------------------------------------------------------- the parser

function parseRallyPolicy(args) {
  const errs = [], caps = {}, levels = {};
  let max = null;
  const whole = (s) => (/^\d+$/.test(String(s)) ? Number(s) : null);
  for (const raw of args) {
    const parts = String(raw).replace(/^\//, '').split(/[:=]/);
    const type = TYPE_ALIAS[parts[0].toLowerCase()];
    if (!type) { errs.push(`unknown rally type "${parts[0]}" — use n, b, v, m, t, r or max`); continue; }
    if (parts.length === 2) {
      const v = whole(parts[1]);
      if (v === null) { errs.push(`"${raw}" needs a whole number of slots`); continue; }
      if (type === 'max') max = v; else caps[type] = v;
    } else if (parts.length === 3 && type === 'n') {
      const v = whole(parts[2]);
      if (v === null) { errs.push(`"${raw}" needs a whole number of slots`); continue; }
      if (parts[1] === '*') { caps.n = v; continue; }
      const level = whole(parts[1]);
      if (level === null || level < 1 || level > 10) { errs.push(`"${raw}": the npc level must be 1-10 or *`); continue; }
      levels[level] = v;
    } else {
      errs.push(`"${raw}" — expected type:slots (r:2), n:<level>:<slots> (n:10:1) or max:<slots>`);
    }
  }
  if (!errs.length && !Object.keys(caps).length && !Object.keys(levels).length && max === null) {
    errs.push('expected e.g. rallypolicy n:8 r:2 t:1 max:8');
  }
  return { caps, levels, max, errors: errs };
}

const parser = { kind: 'policy', multi: false, parse: parseRallyPolicy };

function policyOf(goals) {
  const g = (goals || []).find((x) => x.name === 'rallypolicy');
  return g ? { caps: g.caps || {}, levels: g.levels || {}, max: g.max ?? null } : { caps: {}, levels: {}, max: null };
}

// ------------------------------------------------------------------- reading

// The Rally Spot's level, 0 when the city has none, null when the bean carries
// no building list at all and the limit is simply not known.
function rallyCapacity(castle) {
  const list = castle && castle.buildings;
  if (!Array.isArray(list)) return null;
  return list
    .filter((b) => Number(b.typeId) === RALLY_SPOT_TYPE && !(n(b.status) === 0 && n(b.level) === 0))
    .reduce((m, b) => Math.max(m, n(b.level)), 0);
}

// The most troops one march from this city may take: 10,000 per Rally Spot
// level, never more than the server's 100,000 (constants.js MARCH_TROOP_MAX).
// 0 with no Rally Spot, null when the building list is not known.
//   big    a War Ensign goes with it (/big, bean.useFlag): 25% more
//   horde  Stygandr's Banner of the Horde (/horde, bean.useItem): 1,000,000,
//          whatever the Rally Spot (constants.js MARCH_HORDE_MAX)
function marchTroopLimit(castle, { big = false, horde = false } = {}) {
  const lv = rallyCapacity(castle);
  let limit = horde ? C.MARCH_HORDE_MAX
    : lv === null ? null : Math.min(C.MARCH_TROOP_MAX, lv * C.MARCH_TROOPS_PER_LEVEL);
  if (limit !== null && big) limit = Math.floor(limit * C.MARCH_ENSIGN_BONUS);
  return limit;
}

// ArmyBean, or the engine's wrapper around one. ArmyConstants.as: direction
// 1 forward, 2 back, 3 camped. A transport keeps its load listed on the way
// home, so only a forward march is still delivering anything.
function norm(a) {
  const b = (a && a.raw) || a || {};
  return {
    start: Number(b.startFieldId), target: Number(b.targetFieldId),
    missionType: Number(b.missionType), direction: Number(b.direction) || 1,
    startTime: n(b.startTime),
    resources: b.resource || b.resources || {}, troops: b.troop || b.troops || {},
  };
}

const kindOf = (m) => m.kind || KIND_BY_MISSION[m.missionType] || 'other';

// ------------------------------------------------------------------- the book
//
// One per engine slice. `pending` is the engine's own list of marches it sent
// that the server has not listed yet; it outlives the book. Plans ask room()
// before proposing a march, the engine asks check() before sending one and
// record()s it once the server took it.
//
//   armies   the live army list, or a function returning it
//   goalsOf  castle -> that city's parsed goals, for its rallypolicy
function rallyBook({ game = null, armies = null, goalsOf = null, pending = null } = {}) {
  const shared = Array.isArray(pending) ? pending : [];
  const draft = [];                      // dry-run sends: counted, never kept
  const goalsSeen = new Map();

  const live = () => {
    const list = typeof armies === 'function' ? armies() : armies;
    return (list || (game && game.player && game.player.selfArmys) || []).map(norm);
  };

  const policy = (castle) => {
    if (!goalsOf) return policyOf(null);
    const key = castle.fieldId;
    if (!goalsSeen.has(key)) goalsSeen.set(key, policyOf(goalsOf(castle)));
    return goalsSeen.get(key);
  };

  // Drop what the server now lists itself, and anything too old to still be
  // waiting for.
  function prune(list) {
    const now = Date.now();
    for (let i = shared.length - 1; i >= 0; i--) {
      const p = shared[i];
      const seen = list.some((m) => m.start === p.start && m.target === p.target && m.missionType === p.missionType
        && (!m.startTime || m.startTime >= p.serverAt - MATCH_SLACK));
      if (seen || now - p.at > PENDING_TTL) shared.splice(i, 1);
    }
  }

  function all() {
    const list = live();
    prune(list);
    return [...list, ...shared, ...draft];
  }

  const marchesFrom = (castle) => {
    const fid = Number(castle.fieldId);
    return all().filter((m) => m.start === fid);
  };

  // How many more `kind` marches goals may start from this city. `planned` is
  // what the caller has already lined up this pass and not sent yet.
  function room(castle, kind, { level = null, levelOf = null, planned = {} } = {}) {
    const list = marchesFrom(castle);
    const busy = list.length + n(planned.total);
    const cap = rallyCapacity(castle);
    const pol = policy(castle);
    const limits = [];
    if (cap !== null) limits.push({ left: cap - busy, why: cap ? `rally spot L${cap}: ${busy}/${cap} busy` : 'no rally spot' });
    if (pol.max !== null) limits.push({ left: pol.max - busy, why: `rallypolicy max:${pol.max} (${busy} busy)` });
    if (pol.caps[kind] !== undefined) {
      const k = list.filter((m) => kindOf(m) === kind).length + n(planned.kind);
      limits.push({ left: pol.caps[kind] - k, why: `rallypolicy ${kind}:${pol.caps[kind]} (${k} ${KIND_NAME[kind] || kind} out)` });
    }
    if (kind === 'n' && level !== null && pol.levels[level] !== undefined) {
      const at = (m) => (m.level != null ? m.level : levelOf ? levelOf(m.target) : null);
      const k = list.filter((m) => kindOf(m) === 'n' && at(m) === level).length + n(planned.level);
      limits.push({ left: pol.levels[level] - k, why: `rallypolicy n:${level}:${pol.levels[level]} (${k} out)` });
    }
    const tight = limits.reduce((a, b) => (b.left < a.left ? b : a), { left: Infinity, why: '' });
    return { room: Math.max(0, tight.left), why: tight.why, busy: list.length, capacity: cap };
  }

  // Marches from one city to another with this mission, going or coming back.
  const between = (from, toFieldId, missionType) =>
    marchesFrom(from).filter((m) => m.target === Number(toFieldId) && m.missionType === Number(missionType)).length;

  // Our marches still on their way to a field, from any of our cities.
  const arriving = (toFieldId, missionType) =>
    all().filter((m) => m.target === Number(toFieldId) && m.missionType === Number(missionType) && m.direction === 1);

  // What a city has sent that its own counts may not show yet: the server
  // takes the troops and resources the moment a march leaves, but the push that
  // says so can trail the reply.
  function committed(castle) {
    const fid = Number(castle.fieldId);
    const out = { resources: {}, troops: {} };
    for (const p of [...shared, ...draft]) {
      if (p.start !== fid) continue;
      for (const [k, v] of Object.entries(p.resources || {})) out.resources[k] = n(out.resources[k]) + n(v);
      for (const [k, v] of Object.entries(p.troops || {})) out.troops[k] = n(out.troops[k]) + n(v);
    }
    return out;
  }

  // null when the march may go, else why not. `r` is an action's `rally`:
  //   { from, kind, missionType, targetFieldId, level?, levelOf?, pairLimit?, resources?, troops? }
  function check(r) {
    const left = room(r.from, r.kind, { level: r.level ?? null, levelOf: r.levelOf || null });
    if (left.room <= 0) return left.why;
    if (r.pairLimit) {
      const k = between(r.from, r.targetFieldId, r.missionType);
      if (k >= r.pairLimit) return `${k} ${KIND_NAME[r.kind] || 'march'}(s) already out between these cities (limit ${r.pairLimit})`;
    }
    return null;
  }

  function record(r, sent = true) {
    (sent ? shared : draft).push({
      start: Number(r.from.fieldId), target: Number(r.targetFieldId), missionType: Number(r.missionType),
      direction: 1, kind: r.kind, level: r.level ?? null,
      resources: r.resources || {}, troops: r.troops || {},
      at: Date.now(), serverAt: game && game.now ? game.now() : Date.now(),
    });
  }

  return { room, check, record, between, arriving, committed, marchesFrom, capacity: rallyCapacity, policy };
}

module.exports = {
  parser, parseRallyPolicy, policyOf, rallyCapacity, marchTroopLimit, rallyBook, kindOf, norm,
  KIND_BY_MISSION, KIND_NAME, RALLY_SPOT_TYPE, PENDING_TTL,
};
