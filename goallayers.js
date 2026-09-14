'use strict';
// Goals that belong to the ACCOUNT rather than to one city: NEAT's
// !NewCityGoals.txt, !NewCityScript.txt, !PrependGoals.txt and !AppendGoals.txt
// (wiki: NewCityGoals, NewCityScript, GlobalGoals, PrependGoals, AppendGoals).
//
// NEAT keeps them as files beside the bot. Here they are rows of the goals
// table, keyed by the account and a key no city can have (a city's key is its
// castle id, always digits):
//
//   template  cityKey 'default'  goal    copied into a city that appears with no
//                                        goals of its own, once (db.goals.seed)
//   prepend   cityKey 'prepend'  goal    run in EVERY city, before its own goals
//   append    cityKey 'append'   goal    run in every city, after its own goals
//   script    cityKey 'newcity'  script  run once in a city the moment it appears
//
// The template reuses the 'default' row on purpose: it is what add-account.js
// and the old /goals page already wrote, and what a city with no goals was
// already seeded from, so every account that had one keeps it as its template
// and nothing has to be migrated.
const { parseGoals, describe, GOALS } = require('./goals');

const TEXTS = {
  template: { cityKey: 'default', kind: 'goal', label: 'New-city template', where: 'template' },
  prepend: { cityKey: 'prepend', kind: 'goal', label: 'Prepend goals', where: 'prepend' },
  append: { cityKey: 'append', kind: 'goal', label: 'Append goals', where: 'append' },
  script: { cityKey: 'newcity', kind: 'script', label: 'New-city script', where: 'new-city script' },
};

// NEAT's default !NewCityGoals.txt, as the wiki quotes it (NewCityGoals):
//
//   config comfort:1,gate:1
//   // config trade:1
//   build c:1
//   troop a:1,warr:1,wo:1,p:1,sw:1,cav:1,cata:1,ram:1,cp:1,s:1
//   fortification trap:10,ab:10,at:1,r:10,rock:10
//
// Offered to an account that has no template yet, word for word: every code in
// it is read the NEAT way since Step 9 (constants.js FORT_WORDS: r is rolling
// logs and rock the rock fall, NEAT's trebuchet, in a fortification line).
// `build c:1` stays as NEAT wrote it: a build
// line is a target (engine.js buildPlan), so it asks for at least one cottage
// and never demolishes one, in a captured city either. NEAT wants that cottage
// so a city holding only its Town Hall is not abandoned on restart.
const NEW_CITY_GOALS = [
  '// New-city template: a city founded or captured gets a copy of this as its',
  '// own goals, once. NEAT\'s default !NewCityGoals.txt, in NEAT\'s own codes.',
  'config comfort:1,gate:1',
  '',
  '// config trade:1',
  '',
  '// at least one cottage, so the city never stands with its Town Hall alone',
  'build c:1',
  '',
  'troop a:1,warr:1,wo:1,p:1,sw:1,cav:1,cata:1,ram:1,cp:1,s:1',
  '',
  '// r is rolling logs and rock the rock fall (NEAT\'s trebuchet)',
  'fortification trap:10,ab:10,at:1,r:10,rock:10',
  '',
].join('\n');

// The lines that say something: not blank, not a comment.
const goalLines = (src) => String(src || '').split(/\r?\n/)
  .filter((l) => l.replace(/^\s*(\/\/|#).*$/, '').trim()).length;

// NEAT's GlobalGoals order: PrependGoals, then the city's own goals, then
// AppendGoals, each one "set" in turn. So a config key or a singleton goal
// (comfortpolicy, defensepolicy ...) written again in a later layer overrides
// the earlier one, exactly as a later line does within one text, and the goals
// that stack (troop, build, fortification ...) stack in that order: the
// prepend's troop stages come first.
//
// A global layer counts only when it has a goal line in it. The city's own
// text counts as it always has (any saved text, comments included), so a city
// with no goals and no global goals still reads "no goals set" and the engine
// leaves it alone. Returns null when nothing is left, else parseGoals' shape
// plus `source` on every goal and error ('prepend' | 'city' | 'append'), a
// `where` on every error ("append line 3") and per-layer line counts.
//
// NEAT's `set name value` / %name% variables are not part of this: the goal
// parser has no variables, so a line using them is reported where it stands.
function parseLayered({ prepend = null, city = null, append = null } = {}) {
  const present = [['prepend', prepend], ['city', city], ['append', append]]
    .filter(([source, src]) => (source === 'city' ? !!src : goalLines(src) > 0));
  if (!present.length) return null;
  const out = { config: {}, goals: [], errors: [], layers: {} };
  for (const [source, src] of present) {
    const p = parseGoals(src);
    Object.assign(out.config, p.config);
    for (const g of p.goals) {
      // the same test parseGoals applies within one text
      const def = GOALS[g.name];
      if (def && !def.multi) {
        const prev = out.goals.findIndex((x) => x.name === g.name);
        if (prev >= 0) out.goals.splice(prev, 1);
      }
      out.goals.push({ ...g, source });
    }
    for (const e of p.errors) {
      out.errors.push({ ...e, source, where: source === 'city' ? `line ${e.line}` : `${source} line ${e.line}` });
    }
    out.layers[source] = { lines: goalLines(src), errors: p.errors.length };
  }
  return out;
}

// A plan note for the engine report when the global goals have lines the parser
// could not read. The city's own errors are shown when it is saved; the global
// texts run in every city, so every city says so until they are fixed.
function layerNote(parsed) {
  const errs = ((parsed && parsed.errors) || []).filter((e) => e.source === 'prepend' || e.source === 'append');
  if (!errs.length) return null;
  const shown = errs.slice(0, 2).map((e) => `${e.where}: ${e.error}`).join('; ');
  return `global goals: ${errs.length} line(s) skipped, not understood — ${shown}${errs.length > 2 ? ` (+${errs.length - 2} more)` : ''}`;
}

const textOf = (which) => {
  const t = TEXTS[which];
  if (!t) throw new Error(`there is no account-wide text called "${which}" — template, prepend, append or script`);
  return t;
};

// ---- the console's editor for these texts (server.js /api/goals/account) ----
// `goalsApi` is the organization's goals handle (tenancy.js org(id).goals), so
// another organization's account never resolves.

// { which, label, kind, src, exists, inherited?, suggested? }. An account with
// no template row at all is offered NEAT's default (not saved until it is); one
// with no row of its own but an install-wide default is shown that, since that
// is what its new cities are seeded from.
function readText(goalsApi, accountId, which) {
  const t = textOf(which);
  const own = goalsApi.exact(accountId, t.cityKey, t.kind);
  const out = { ok: true, which, label: t.label, kind: t.kind, src: own ? own.src : '', exists: !!own };
  if (which === 'template' && !own) {
    const shared = goalsApi.find(accountId, ['default'], 'goal');
    if (shared && shared.src) { out.src = shared.src; out.inherited = true; } else out.suggested = NEW_CITY_GOALS;
  }
  return out;
}

// Check (and with `save`, keep) one of the texts. The errors carry their
// source — "prepend line 3: …" — because in a city they run among its own lines.
// `lines` is each line's standing for the editor's colours, the same answer
// /api/goals and /api/script give for a city's text.
function saveText(goalsApi, accountId, { which, src, save } = {}) {
  const t = textOf(which);
  const text = String(src ?? '');
  let errors, lines, described = [];
  if (t.kind === 'script') {
    // parsed the way the editor's check parses, so a huge `repeat N` is not
    // expanded just to find the errors (script.js lineStatus)
    ({ errors, lines } = require('./script').lineStatus(text));
  } else {
    const p = parseGoals(text);
    errors = p.errors;
    lines = p.lines;
    described = describe(p);
  }
  errors = errors.map((e) => ({ ...e, source: which, where: `${t.where} line ${e.line}` }));
  if (save) goalsApi.set(accountId, t.cityKey, t.kind, text.trim() ? text : '');
  const what = {
    template: 'Cities that appear from now on start from it; a city that already has goals keeps its own.',
    prepend: 'Every city runs these before its own goals from the engine\'s next tick.',
    append: 'Every city runs these after its own goals from the engine\'s next tick.',
    script: 'It runs once in each city founded or captured while this console is connected.',
  }[which];
  return { ok: true, which, label: t.label, errors, lines, described, saved: save ? which : null, note: save ? `Saved. ${what}` : null };
}

module.exports = { TEXTS, NEW_CITY_GOALS, goalLines, parseLayered, layerNote, readText, saveText };
