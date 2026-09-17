'use strict';
// The plan goal (wiki: Plan).
//
//   plan c:4:9,i:4:40,b:4:14,mi:4     cottages, iron mines, barracks and Mining 4
//   plan ar:8,mt:7,ho:5               begins once everything above is finished
//
// wiki Plan: "it will allow you to specify both building and research on the
// same line, and neither task will work on other goals until it is completed" —
// in its example the second line (archery, etc.) "could begin" only once the
// cottages, iron mines, barracks and mining level 4 were all done. Build and
// research lines, by contrast, run side by side, each moving on by itself. The
// codes are Build's and Research's, except that on a plan line `st` is the
// Stable and `sp` Stockpile, and full names work too. config plan:0 turns plan
// lines off; plan:1 is the default.
//
// How the engine works it (engine.js focus and buildOutlook, through expand):
// the plan line in work is the first one not finished, and its targets go to the
// same machinery a build or a research line's go to — the builder (buildPlan,
// Step 5's order, Step 11's prerequisites and reserves) and the research goal
// (goal-research.js: one research per city, prerequisite techs first, the
// Academy built for it):
//   * its buildings are a build line of their own, AHEAD of the build lines, with
//     the finished plan lines' buildings above it, so a later line never undoes an
//     earlier one's targets (as build lines never undo each other);
//   * its research is a research line of its own, ahead of the research lines.
// OUR CHOICE — the wiki does not say how plan lines share a city with build and
// research lines: the plan goes first, and the build and research lines have the
// builder and the Academy whenever the plan line leaves them free. While its
// buildings stand and its research runs, the builder goes on with the build
// lines; while its research is done and its buildings go up, the research lines
// go on. What waits is the NEXT plan line, until every building and research of
// this one is finished: "neither task will work on other goals" read as other
// plan goals, which is all the wiki's example shows. A city with plan lines
// researches what its buildings need, as one with a research line does.
//
// Finished means: the buildings stand as the line asks — as they are now, not
// once the work on them ends — and each research is at its level by the last
// research list the engine read (research is the account's, so any city's read
// counts). Research never read is not finished; the line in work has its research
// list read (goal-research listNeeded), and the slice after the read that shows
// its last research done, the next line begins. It is worked out again every
// slice, so a building lost later puts its line back in work before the next
// line goes on: plan lines are end states, as build lines are. A plan line takes no ?condition?
// (the wiki gives it none, and "finished" could not be known): such a line is an
// error and left out.
const C = require('./constants');

const n = (x) => Number(x || 0);

// ------------------------------------------------------------------ parser
// One target on a plan line. A building's word goes first, so `st` is the Stable
// here; a research word is read with `st` left out, so Stockpile is `sp` (or its
// name). A building target is read exactly as a build line reads it (goals.js),
// a research target as a research line does (goal-research.js).
function readTarget(part, errs, out) {
  const G = require('./goals');
  const RS = require('./goal-research');
  const bits = part.split(':');
  if (G.buildingOf(bits[0])) {
    const p = G.GOALS.build.parse([part]);
    errs.push(...p.errors);
    out.buildings.push(...p.targets.map(({ when, condition, ...t }) => t));
    return;
  }
  const tech = RS.techByWord(bits[0], { st: false });
  if (tech) {
    if (bits.length === 3) { errs.push(`"${part}": ${tech.name} is research, which takes research:level — no quantity`); return; }
    const t = RS.researchTarget(part, errs, { st: false });
    if (t) out.research.push(t);
    return;
  }
  errs.push(`unknown building or research "${bits[0]}" — the Build and Research codes or full names (on a plan line st is the Stable and sp Stockpile)`);
}

const parsers = {
  // plan <target>[,<target>...] — building targets (type:level[:quantity]) and
  // research targets (research:level) in any mix, separated by commas or spaces
  plan: {
    kind: 'directive', multi: true,
    parse(args) {
      const G = require('./goals');
      const errs = [];
      const out = { buildings: [], research: [] };
      const raw = args.join(' ').replace(G.TWO_WORDS, '$1$2');
      if (/\?/.test(raw)) {
        errs.push('a plan line takes no ?condition? (the NEAT wiki gives it none) — write a conditional target on a build or research line; the whole line is left out');
        return { targets: [], buildings: [], research: [], errors: errs };
      }
      for (const part of raw.split(/[\s,]+/)) if (part) readTarget(part, errs, out);
      if (!raw.trim()) errs.push('needs at least one building or research target, e.g. plan c:4:3,ag:1');
      return { targets: [...out.buildings, ...out.research], buildings: out.buildings, research: out.research, errors: errs };
    },
  },
};

// ------------------------------------------------------------------ progress
// The city's buildings as they stand now: one being upgraded is still at its
// old level, one going up new is not there yet (engine.js standing).
const standingNow = (castle) => ((castle && castle.buildings) || [])
  .filter((b) => !(n(b.status) === 0 && n(b.level) === 0) && n(b.level) > 0);

// "Cottage 3/9 at L4", "no Sawmill (2 stand)", "Mining L4 (L2)"
function openText(t, live) {
  const levels = live.filter((b) => b.typeId === t.typeId).map((b) => n(b.level));
  const at = levels.filter((l) => l >= Math.max(1, t.level)).length;
  if (t.level > 0 && t.quantity > 0) return `${t.building} ${at}/${t.quantity} at L${t.level}`;
  if (t.quantity === 0) return `no ${t.building}${t.level > 0 ? ` at L${t.level}+` : ''} (${t.level > 0 ? at : levels.length} stand)`;
  return `${t.building} at most ${t.quantity} (${levels.length} stand)`;
}

// Which plan line is in work: the first not finished, or null when all are.
//   lines    the plan lines (goals named plan), in order
//   current  index into lines, or null
//   open     { buildings: [text], research: [text] } of the current line
// `levels` are the account's research levels ({techId: level}) or null.
function progress(goals, castle, levels) {
  const E = require('./engine');
  const lines = (goals || []).filter((g) => g.name === 'plan');
  const live = standingNow(castle);
  const want = new Map();
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    for (const t of line.buildings || []) E.addWant(want, t, []);
    const openB = [];
    for (const typeId of [...new Set((line.buildings || []).map((t) => t.typeId))]) {
      const def = C.BUILDING_BY_ID[typeId];
      if (!def) continue;
      const have = live.filter((b) => b.typeId === typeId);
      // what the lines so far want of the type, as the builder reads it
      // (typeOrders), with nothing claimed: only whether anything is left
      if (!E.typeOrders(def, want.get(typeId), have, () => false).unmet) continue;
      const mine = (line.buildings || []).filter((t) => t.typeId === typeId);
      const texts = mine.filter((t) => !E.buildMet(have.map((b) => n(b.level)), t)).map((t) => openText(t, live));
      openB.push(...(texts.length ? texts : [`${def.name} (as the plan lines so far want it)`]));
    }
    const openR = [];
    for (const t of line.research || []) {
      const lv = levels ? levels[t.techId] : undefined;
      if (lv === undefined || lv === null) openR.push(`${t.name} L${t.level} (research levels not read yet)`);
      else if (n(lv) < t.level) openR.push(`${t.name} L${t.level} (L${n(lv)} now)`);
    }
    if (openB.length || openR.length) return { lines, current: k, open: { buildings: openB, research: openR } };
  }
  return { lines, current: null, open: null };
}

// ------------------------------------------------------------------ expand
// The goals the engine plans with: the plan lines' work put in as build and
// research lines ahead of the city's own (see the top of this file), and what
// the plan note says. `parsed` is { goals, config }; `levels` as progress().
// Returns { goals, plan } — plan null when the city has no plan line:
//   plan  { total, current (1-based, null when all are finished), paused, note }
// The build lines made here carry `plan` (the plan line's number) and `tag`
// ("plan line 1/2"), which buildPlan and the research goal show in their notes.
function expand(parsed, castle, levels) {
  const goals = (parsed && parsed.goals) || [];
  const cfg = (parsed && parsed.config) || {};
  const lines = goals.filter((g) => g.name === 'plan');
  if (!lines.length) return { goals, plan: null };
  const total = lines.length;
  if (cfg.plan === 0) {
    return { goals, plan: { total, current: null, paused: true, note: `plan: ${total} line(s) paused by config plan:0` } };
  }
  const pr = progress(goals, castle, levels);
  const upTo = pr.current === null ? total : pr.current + 1;
  const tag = (k) => `plan line ${k + 1}/${total}`;
  const made = [];
  for (let k = 0; k < upTo; k++) {
    const line = lines[k];
    if (!(line.buildings || []).length) continue;
    made.push({
      name: 'build', kind: 'directive', line: line.line, raw: line.raw, source: line.source,
      plan: k + 1, tag: tag(k), targets: line.buildings, needsTech: false,
      groups: [{ condition: null, when: null, targets: line.buildings }],
    });
  }
  if (pr.current !== null && (lines[pr.current].research || []).length) {
    const line = lines[pr.current];
    made.push({
      name: 'research', kind: 'directive', line: line.line, raw: line.raw, source: line.source,
      plan: pr.current + 1, tag: tag(pr.current), targets: line.research,
      groups: [{ condition: null, when: null, targets: line.research }],
    });
  }
  return { goals: [...made, ...goals], plan: { total, current: pr.current === null ? null : pr.current + 1, paused: false,
    note: planNote(pr, cfg, total) } };
}

function planNote(pr, cfg, total) {
  if (pr.current === null) return `plan: all ${total} line(s) finished`;
  const k = pr.current + 1;
  const bits = [];
  if (pr.open.buildings.length) bits.push(`buildings: ${pr.open.buildings.join(', ')}`);
  if (pr.open.research.length) bits.push(`research: ${pr.open.research.join(', ')}`);
  const out = [`plan: line ${k}/${total} in work — ${bits.join('; ')}`];
  if (k < total) out.push(`line ${k + 1} begins once all of it is finished`);
  if (pr.open.buildings.length && cfg.building === 0) out.push('construction is paused by config building:0, so it cannot finish');
  if (pr.open.research.length && cfg.research === 0) out.push('research is paused by config research:0, so it cannot finish');
  return out.join('; ');
}

// goals.js describe()
function describe(list) {
  const what = (t) => (t.techId ? `${t.name} to L${t.level}`
    : t.level > 0 && t.quantity > 0 ? `${t.quantity} x ${t.building} to L${t.level}`
      : t.level === 0 && t.quantity > 0 ? `at most ${t.quantity} ${t.building}`
        : t.level === 0 ? `no ${t.building}` : `no ${t.building} at L${t.level} or higher`);
  return [`plan: ${list.length} line(s), each finished — buildings and research — before the next begins; ahead of the build and research lines`,
    ...list.map((g, i) => `   ${i + 1}. ${(g.targets || []).map(what).join(', ') || '(nothing readable on this line)'}`)];
}

module.exports = { parsers, configKeys: ['plan'], progress, expand, describe };
