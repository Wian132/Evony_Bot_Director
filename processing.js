'use strict';
// When a city's goals act, and which of its marches goes first: NEAT's
// SchedulePolicy and ProcessingPolicy (wiki: SchedulePolicy, ProcessingPolicy).
//
// ------------------------------------------------------------ schedulepolicy
//   schedulepolicy 06:00 12:00 [17:00 23:00 ...]
// wiki: "start and stop performing actions during certain times of the day" —
// "the bot would run from 6AM to 12 noon, and stop the rest of the time". The
// hours are this machine's clock, as wartownpolicy's and a script's @: times
// are, and a window may run past midnight (22:00 02:00). Outside them the
// engine (engine.js offHours) plans, reads and sends nothing for the city but
// its defence: hiding and the gate, the emergency walls while an attack is
// inbound (FortificationGoal), the defence items (defensepolicy), the war town
// recall, warrules and the embassy. OUR CHOICE: the wiki does not say an attack
// waits for office hours, and nothing that keeps a city alive is switched off by
// a schedule. Everything else waits: training (the reserved barracks' too), wall
// batches, construction, research, the mayor, comfort and the other upkeep
// goals, heroes, farming, buildnpc, valleys, transfers, the market, report
// cleaning, free finishes and the traininghero leaving that city. A goal line
// holds in the city whose goals carry it (NEAT's goals are per city); in the
// Prepend goals it holds in every city. The console's own reads (the background
// map scan) are not goal actions and are not held.
//
// ---------------------------------------------------------- processingpolicy
//   processingpolicy [/start:hh:mm[:ss]] [/end:hh:mm[:ss]] task[:priority] ...
//     q rescue   b buildnpc   v valley farming   n npc farming
//     s safe valley farming   a valley acquisition   m medal hunting
//     t sendtroops   r sendresources
// wiki: every task's priority is 10 unless written; `*:N` gives every task the
// line does not name N; `!x` (or x:0, x:off, x:false, x:no) turns a task off,
// and `!*` every task the line does not name; `=` may stand for `:` anywhere;
// /start and /end make a line hold only between those times of day
// ("processingpolicy /start:13:00 /end:1400 !n": no npc farming from 1 to 2 pm).
// "Each time the bot sends out a mission of a certain type, it will accumulate a
// higher internal point value on that task. Tasks with the lowest points will be
// given priority to perform first", and with "n:10 m:20" "roughly double the
// number of medal farmers would be sent". So each mission sent adds 10/priority
// points to its task, in the state of the city it leaves (engine state, by
// castle id), and when missions of several tasks are ready in one slice the
// engine (runPlanActions) sends them fewest points first: they compete for the
// slice's three actions and for the rally spot's slots. A task turned off sends
// nothing at all.
//
// OUR CHOICES, where the wiki is silent:
//   * Lines are read in order and a later line wins for the tasks it names; a
//     `*` or `!*` covers the tasks its own line does not name. A timed line
//     applies over the untimed ones while its window is open. /start alone runs
//     to midnight, /end alone from midnight.
//   * Points fade, halving every POINTS_HALF_LIFE, so a task that sat idle for a
//     day does not take every slot for hours once it wakes; the wiki speaks of
//     balance "after a few hours of running".
//   * Turned off, a goal stops outright: npc farming sends no run, buildnpc
//     stands down (no flat occupied, no city abandoned), and the city sends no
//     sendtroops/keeptroops or sendresources/keepresources march — nor is it
//     picked to answer another city's requesttroops/requestresources: that
//     mission leaves this city, so this city's policy and points are the ones
//     that count.
//   * q (rescue): the wiki itself is not sure what it is ("rescue (er..
//     resQue?)"), and OTTObot has no such task. It is accepted and does nothing.
//
// THE REGISTRY. A goal module that sends one of these missions registers the
// task, so the engine knows which of its actions to weigh and the editor which
// tasks work:
//     const P = require('./processing');
//     P.register('n', { kinds: ['npcAttack'] });                 // by action kind
//     P.register('v', { match: (a) => a.kind === 'valleyAttack' && a.purpose === 'farm' });
// An action may also carry `task: 'v'` itself. Before choosing a mission a plan
// asks P.allowed(ctx, 'v') -> { on, priority, why } and leaves the task out, with
// `why` in its note, while it is off. The engine does the ordering and the
// points; nothing else is needed. Tasks not registered are accepted on a line
// and noted as doing nothing yet. Registered today: n (goal-npc), b (goal-buildnpc
// claimFlat and foundCity; goal-valley's flat captures), t and r (goal-transfer),
// a v s m (goal-valley, by what a valley march is for; s's scouting too).
const W = require('./goal-war');

const n = (x) => Number(x || 0);

// The nine tasks, in the wiki's order, with the words a line may use for them.
const TASKS = {
  q: { name: 'rescue', words: ['rescue', 'resque'], aside: 'the NEAT wiki itself is unsure what it is' },
  b: { name: 'buildnpc', words: ['buildnpc', 'npcbuild', 'npcbuilding'] },
  v: { name: 'valley farming', words: ['valleyfarming', 'valley'] },
  n: { name: 'npc farming', words: ['npcfarming', 'npc'] },
  s: { name: 'safe valley farming', words: ['safevalleyfarming', 'safevalley'] },
  a: { name: 'valley acquisition', words: ['valleyacquisition', 'acquisition'] },
  m: { name: 'medal hunting', words: ['medalhunting', 'medal', 'hunting'] },
  t: { name: 'sendtroops', words: ['sendtroops', 'troops'] },
  r: { name: 'sendresources', words: ['sendresources', 'resources'] },
};
const CODES = Object.keys(TASKS);
const DEFAULT_PRIORITY = 10;           // wiki: "The default priority for any task is 10"
// A mission adds DEFAULT_PRIORITY / priority points: one point at the default.
const WEIGHT = DEFAULT_PRIORITY;
const POINTS_HALF_LIFE = 2 * 3600e3;   // OUR CHOICE, see above
const DAY = 86400;

const WORD = {};
for (const [code, t] of Object.entries(TASKS)) { WORD[code] = code; for (const w of t.words) WORD[w] = code; }
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z*]/g, '');
const taskCode = (word) => (Object.prototype.hasOwnProperty.call(WORD, slug(word)) ? WORD[slug(word)] : null);

// ------------------------------------------------------------------ registry
const REGISTRY = {};                   // code -> { kinds: Set, match: fn|null }

// A goal module sends missions of this task. `kinds` are its action kinds;
// `match(action)` decides for one kind shared by several tasks.
function register(code, { kinds = [], match = null } = {}) {
  if (!Object.prototype.hasOwnProperty.call(TASKS, code)) throw new Error(`processing: no task "${code}" (known: ${CODES.join(' ')})`);
  const r = (REGISTRY[code] = REGISTRY[code] || { kinds: new Set(), match: [] });
  for (const k of kinds) r.kinds.add(k);
  if (typeof match === 'function') r.match.push(match);
  return r;
}
const registered = (code) => !!REGISTRY[code];

// The task an action is a mission of, or null: its own `task`, else a
// registered kind or match.
function taskOf(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.task && Object.prototype.hasOwnProperty.call(TASKS, a.task)) return a.task;
  for (const [code, r] of Object.entries(REGISTRY)) {
    if (r.kinds.has(a.kind) || r.match.some((fn) => { try { return !!fn(a); } catch { return false; } })) return code;
  }
  return null;
}

// ------------------------------------------------------------------ clock
// "13:00", "13:00:30", "1400" (the wiki's own /end:1400), "130030" -> seconds
// after midnight; 24:00 is the end of the day. null when it is no time of day.
function timeOfDay(v) {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/) || s.match(/^(\d{2})(\d{2})(\d{2})?$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]), se = Number(m[3] || 0);
  if (mi > 59 || se > 59 || h > 24 || (h === 24 && (mi || se))) return null;
  return h * 3600 + mi * 60 + se;
}
const clock = (sec) => {
  const s = ((sec % DAY) + DAY) % DAY || (sec === DAY ? DAY : 0);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0'), mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  return s % 60 ? `${hh}:${mm}:${String(s % 60).padStart(2, '0')}` : `${hh}:${mm}`;
};
const secondOfDay = (at) => { const d = new Date(at); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); };
const inWindow = (w, sec) => (w.from < w.to ? sec >= w.from && sec < w.to : sec >= w.from || sec < w.to);
const nowOf = (ctx) => {
  const g = ctx && !Array.isArray(ctx) ? ctx.game : null;
  return g && typeof g.now === 'function' ? g.now() : Date.now();
};

// ------------------------------------------------------------------ parsers
// key:value or key=value (wiki: "= instead of : in all places")
function split(tok) {
  const i = String(tok).search(/[:=]/);
  return i < 0 ? [String(tok), null] : [String(tok).slice(0, i), String(tok).slice(i + 1)];
}
const OFF = new Set(['0', 'off', 'false', 'no']);
const ON = new Set(['on', 'true', 'yes']);

// A priority as written: nothing = the default 10, off/false/no/0 = off, a
// number (fractions too). null when it cannot be read.
function priorityOf(v) {
  if (v === null || v === undefined) return DEFAULT_PRIORITY;
  const s = String(v).trim().toLowerCase();
  if (OFF.has(s)) return 0;
  if (ON.has(s)) return DEFAULT_PRIORITY;
  return /^(\d+(\.\d+)?|\.\d+)$/.test(s) ? parseFloat(s) : null;
}

const parsers = {
  // schedulepolicy <start> <end> [<start> <end> ...] — hh:mm pairs, the same
  // way wartownpolicy reads its hours (goal-war.parseWindows). One per city: a
  // later line replaces an earlier one.
  schedulepolicy: {
    kind: 'policy', multi: false,
    parse(args) { return W.parseWindows(args, 'schedulepolicy'); },
  },

  // processingpolicy [/start:hh:mm[:ss]] [/end:hh:mm[:ss]] task[:priority] ...
  // Lines stack: an untimed one sets the priorities, a timed one changes them
  // for its hours.
  processingpolicy: {
    kind: 'policy', multi: true,
    parse(args) {
      const errs = [], tasks = {};
      let rest = null, start = null, end = null;
      const toks = (args || []).flatMap((t) => String(t).split(',')).map((t) => t.trim()).filter(Boolean);
      for (const tok of toks) {
        if (tok.startsWith('/')) {
          const [k, v] = split(tok.slice(1));
          const key = k.toLowerCase();
          if (key !== 'start' && key !== 'end') { errs.push(`unknown switch "/${k}" (known: /start /end)`); continue; }
          const s = v === null || v === '' ? null : timeOfDay(v);
          if (s === null) { errs.push(`/${key}${v ? `:${v}` : ''} needs a time of day — hh:mm or hh:mm:ss, e.g. /${key}:13:00`); continue; }
          if (key === 'start' && s === DAY) { errs.push('/start:24:00 is the end of the day — a window starts at 00:00'); continue; }
          if (key === 'start') start = s; else end = s;
          continue;
        }
        const off = tok.startsWith('!');
        const [word, v] = split(off ? tok.slice(1) : tok);
        if (off && v !== null) { errs.push(`"${tok}": write !${word} to turn it off, or ${word}:<priority> — not both`); continue; }
        const prio = off ? 0 : priorityOf(v);
        if (prio === null) { errs.push(`"${tok}": "${v}" is not a priority — a number (10 is the default), or 0/off/false/no to turn it off`); continue; }
        if (word === '*') {
          if (rest !== null) errs.push(`* is written twice on this line — the later one is used`);
          rest = prio;
          continue;
        }
        const code = taskCode(word);
        if (!code) { errs.push(`unknown task "${word}" — q b v n s a m t r, or * for every task the line does not name`); continue; }
        if (code in tasks) errs.push(`${code} is written twice on this line — the later one is used`);
        tasks[code] = prio;
      }
      let window = null;
      if (start !== null || end !== null) {
        const from = start === null ? 0 : start, to = end === null ? DAY : end;
        if (from === to % DAY && to !== DAY) errs.push(`/start and /end are the same time (${clock(from)})`);
        else window = { from, to, text: `${clock(from)}-${clock(to)}` };
      }
      if (!Object.keys(tasks).length && rest === null) errs.push('names no task — e.g. processingpolicy n:10 m:20, or !b');
      const out = { tasks, rest, window, errors: errs };
      // What the editor says of the tasks nothing here runs (goals.js lines):
      // named alongside a task that works, a note; alone, the line does nothing.
      const idle = Object.keys(tasks).filter((c) => !registered(c));
      if (idle.length) {
        const works = Object.keys(tasks).some(registered) || (rest !== null && CODES.some((c) => !(c in tasks) && registered(c)));
        const text = `${idle.map((c) => `${c} (${TASKS[c].name}${TASKS[c].aside ? ` — ${TASKS[c].aside}` : ''})`).join(', ')} `
          + `${idle.length > 1 ? 'are' : 'is'} accepted, but nothing here runs ${idle.length > 1 ? 'them' : 'it'} yet`;
        if (works) out.lineNote = text; else out.lineIdle = `processingpolicy does nothing yet: ${text}`;
      }
      return out;
    },
  },
};

// ------------------------------------------------------------------ the policy
const linesOf = (goals) => (goals || []).filter((g) => g && g.name === 'processingpolicy');

// Every task's priority at `at` (0 = off), and which window set it, if any.
function policyAt(goals, at = Date.now()) {
  const prio = Object.fromEntries(CODES.map((c) => [c, DEFAULT_PRIORITY]));
  const by = {};
  const lines = linesOf(goals);
  const sec = secondOfDay(at);
  const apply = (g) => {
    const named = g.tasks || {};
    for (const [c, v] of Object.entries(named)) { prio[c] = v; by[c] = g.window || null; }
    if (g.rest !== null && g.rest !== undefined) {
      for (const c of CODES) if (!(c in named)) { prio[c] = g.rest; by[c] = g.window || null; }
    }
  };
  for (const g of lines) if (!g.window) apply(g);
  const open = [];
  for (const g of lines) if (g.window && inWindow(g.window, sec)) { apply(g); open.push(g.window); }
  return { prio, by, open, lines: lines.length };
}

// One task's priority now, from a plan context or a city's goal list.
const priorityNow = (goals, code, at) => policyAt(goals, at).prio[code];

// May this city send a mission of this task now? { on, priority, why } — `why`
// is a few words for a plan note while it may not.
function allowed(ctx, code, at) {
  const goals = Array.isArray(ctx) ? ctx : (ctx && ctx.goals) || [];
  const when = at === undefined ? nowOf(ctx) : at;
  const p = policyAt(goals, when);
  const v = p.prio[code];
  if (v > 0) return { on: true, priority: v, why: null };
  const w = p.by[code];
  return { on: false, priority: 0,
    why: `processingpolicy turns ${TASKS[code] ? TASKS[code].name : code} (${code}) off${w ? ` from ${clock(w.from)} to ${clock(w.to)}` : ''}` };
}

// ------------------------------------------------------------------ points
// cityState.processing.points[code] = { v, at }: v points as they stood at `at`.
function points(state, code, at = Date.now()) {
  const p = state && state.processing && state.processing.points && state.processing.points[code];
  if (!p) return 0;
  const age = Math.max(0, n(at) - n(p.at));
  return n(p.v) * Math.pow(0.5, age / POINTS_HALF_LIFE);
}

// A mission of this task was sent from the city whose state this is.
function record(state, code, priority, at = Date.now()) {
  if (!state || !TASKS[code] || !(priority > 0)) return 0;
  const pr = (state.processing = state.processing || {});
  const ps = (pr.points = pr.points || {});
  const v = points(state, code, at) + WEIGHT / priority;
  ps[code] = { v: Math.round(v * 1000) / 1000, at };
  pr.sent = pr.sent || {};
  pr.sent[code] = n(pr.sent[code]) + 1;
  return v;
}

// ------------------------------------------------------------------ schedule
// The city's schedulepolicy at `at`: null without one, else
//   { on, window | next, hours, note, why }
function scheduleAt(goals, at = Date.now()) {
  const pol = (goals || []).find((g) => g && g.name === 'schedulepolicy');
  if (!pol || !(pol.windows || []).length) return null;
  const hours = pol.windows.map((w) => w.text).join(', ');
  const w = W.windowAt(pol.windows, at);
  if (w) return { on: true, window: w, hours, note: `schedulepolicy: acting until ${W.hhmm(w.to)} (hours ${hours})` };
  const next = W.nextWindow(pol.windows, at);
  const why = `is outside its schedulepolicy hours (${hours}) until ${W.hhmm(next.from)}`;
  return { on: false, next, hours, why,
    note: `schedulepolicy: outside its hours (${hours}) — only defence acts (hiding, the gate, defence items, the war town recall, warrules, the embassy) until ${W.hhmm(next.from)}` };
}

// ------------------------------------------------------------------ notes
const prioText = (v) => (v > 0 ? String(Math.round(v * 100) / 100) : 'off');

// The engine's note for processingpolicy in one city, or null without a line.
function processingNote(goals, state, at = Date.now()) {
  const lines = linesOf(goals);
  if (!lines.length) return null;
  const p = policyAt(goals, at);
  const work = CODES.filter(registered).map((c) => {
    const pts = points(state, c, at);
    return `${c} ${prioText(p.prio[c])}${pts >= 0.05 ? ` (${pts.toFixed(1)} pts)` : ''}`;
  });
  const out = [`processingpolicy: ${work.join(', ') || 'no task registered'}`];
  if (p.open.length) out.push(`now in ${p.open.map((w) => w.text).join(', ')}`);
  const later = lines.filter((g) => g.window && !p.open.includes(g.window));
  if (later.length) out.push(`later: ${later.map((g) => `${g.window.text} ${summary(g)}`).join('; ')}`);
  const named = new Set(lines.flatMap((g) => Object.keys(g.tasks || {})));
  const idle = CODES.filter((c) => named.has(c) && !registered(c));
  if (idle.length) out.push(`${idle.join(' ')} accepted, no such task here yet`);
  return out.join('; ');
}

// "n:10 m:20 *:5", "!n", as one line reads
function summary(g) {
  const bits = Object.entries(g.tasks || {}).map(([c, v]) => (v > 0 ? `${c}:${prioText(v)}` : `!${c}`));
  if (g.rest !== null && g.rest !== undefined) bits.push(g.rest > 0 ? `*:${prioText(g.rest)}` : '!*');
  return bits.join(' ');
}

// One readable line per goal, for goals.js describe().
function describeGoal(g) {
  if (g.name === 'schedulepolicy') {
    const hours = (g.windows || []).map((w) => w.text).join(', ');
    return `schedulepolicy: goals act only during ${hours || '(no valid hours)'} on this machine's clock; defence (hiding, the gate, defence items, the war town recall) always acts`;
  }
  const names = Object.entries(g.tasks || {}).map(([c, v]) => `${TASKS[c].name} ${v > 0 ? prioText(v) : 'off'}`);
  if (g.rest !== null && g.rest !== undefined) names.push(`every other task ${g.rest > 0 ? prioText(g.rest) : 'off'}`);
  return `processingpolicy: ${g.window ? `from ${clock(g.window.from)} to ${clock(g.window.to)}, ` : ''}${names.join(', ')}`
    + ' (default 10; each mission sent adds 10/priority points to its task, and the fewest points go first)';
}

module.exports = {
  parsers,
  configKeys: [],
  TASKS, CODES, DEFAULT_PRIORITY, WEIGHT, POINTS_HALF_LIFE,
  // the registry, for the goal modules (Step 20's valleys join here)
  register, registered, taskOf,
  // the policy, for plans and the engine
  policyAt, priorityNow, allowed, points, record,
  scheduleAt, processingNote, describeGoal,
  _internals: { timeOfDay, clock, inWindow, secondOfDay, REGISTRY },
};
