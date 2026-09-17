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
//   set1-9    cityKey 'set1'..   goal    goal sets a script loads (`loadgoals N`)
//
// The template reuses the 'default' row on purpose: it is what add-account.js
// and the old /goals page already wrote, and what a city with no goals was
// already seeded from, so every account that had one keeps it as its template
// and nothing has to be migrated.
//
// Below them, in memory only, is each city's script goal layer: goal lines a
// script ran (see "the script goal layer" further down).
const { parseGoals, describe, GOALS } = require('./goals');

// NEAT's numbered goal sets for `loadgoals N` (wiki LoadGoals). Set 0 is the
// city's own goals, so the stored sets are 1 to 9, shared by the account's cities.
const GOAL_SETS = 9;

const TEXTS = {
  template: { cityKey: 'default', kind: 'goal', label: 'New-city template', where: 'template' },
  prepend: { cityKey: 'prepend', kind: 'goal', label: 'Prepend goals', where: 'prepend' },
  append: { cityKey: 'append', kind: 'goal', label: 'Append goals', where: 'append' },
  script: { cityKey: 'newcity', kind: 'script', label: 'New-city script', where: 'new-city script' },
};
for (let i = 1; i <= GOAL_SETS; i++) {
  TEXTS[`set${i}`] = { cityKey: `set${i}`, kind: 'goal', label: `Goal set ${i}`, where: `goal set ${i}` };
}

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
//
// `script` is the city's script goal layer (getScriptLayer), run LAST, so a
// script's config key or singleton wins over every saved text until the layer
// is cleared. After a script's `loadgoals N` the loaded text stands in for the
// saved and global goals, and after `resetgoals` nothing does: only the lines
// the script set since then run (see the script goal layer below).
function parseLayered({ prepend = null, city = null, append = null, script = null } = {}) {
  const base = script ? script.base : 'saved';
  const order = base === 'reset' ? [['script', script.src]]
    : base === 'loaded' ? [['loaded', script.loadedSrc], ['script', script.src]]
    : [['prepend', prepend], ['city', city], ['append', append], ['script', script ? script.src : null]];
  const present = order.filter(([source, src]) => (source === 'city' ? !!src : goalLines(src) > 0));
  if (!present.length) return null;
  const out = { config: {}, goals: [], errors: [], layers: {} };
  const where = (source, n) => (source === 'city' ? `line ${n}` : source === 'loaded' ? `${script.loaded} line ${n}` : `${source} line ${n}`);
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
    for (const e of p.errors) out.errors.push({ ...e, source, where: where(source, e.line) });
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
  if (!t) throw new Error(`there is no account-wide text called "${which}" — template, prepend, append or script, or a goal set set1 to set${GOAL_SETS}`);
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
  }[which] || `A script's \`loadgoals ${which.slice(3)}\` runs it in place of a city's goals; a city that loaded it earlier keeps the copy it took.`;
  return { ok: true, which, label: t.label, errors, lines, described, saved: save ? which : null, note: save ? `Saved. ${what}` : null };
}

// ------------------------------------------------------ the script goal layer
// NEAT runs goal lines from a script: `config npc:5`, `goal <line>` (or any goal
// line on its own), `buildinggoals ...`, `loadgoals [n]`, `resetgoals` (wiki
// Goal, Config, LoadGoals, ResetGoals, BuildingGoals). They change the goals
// the bot is RUNNING in that city, never the saved ones, and hold until
// (wiki Config) a script changes them again, the goals are set again from the
// goals window, or the bot restarts. Here that is a layer per account and city,
// in this process's memory only:
//
//   base 'saved'   the saved goals run (prepend + city + append), then the
//                  script's lines, which win for config keys and one-per-city
//                  goals and stack for troop, build and fortification lines
//   base 'loaded'  `loadgoals N`: the loaded text stands in for ALL of them,
//                  prepend and append included (NEAT reads its global files only
//                  at start, so a loaded set replaces everything it had), then
//                  the script's lines on top
//   base 'reset'   `resetgoals`: nothing runs but the lines set since (NEAT:
//                  "temporarily reset/disable your goals until the next bot
//                  restart"; its default policies are the engine's no-goal ones)
//
// It ends with clearScriptLayer: a script's bare `loadgoals` or `loadgoals 0`
// (NEAT's regular goal set, as its AutoTeleporter example ends), the console's
// "Clear script goals", saving that city's goals (NEAT's Set Goals, wiki Config),
// or a restart. Nothing here is written to the database.
const SCRIPT_MAX_LINES = 1000;
const LAYERS = new Map();                     // `${accountId}|${castleId}` -> layer
const layerKey = (accountId, castleId) => `${accountId || ''}|${castleId}`;
const splitLines = (text) => String(text ?? '').split(/\r?\n/);
// NEAT's older script form of a goal line: `techgoals ar:10,ho:10` is the
// research line `research ar:10,ho:10` (wiki TechGoals: "This command is
// deprecated, you can now just use research in scripts to modify the research
// goals"). A script's `research` line (`goal research ar:4,ms:5`, wiki Goal)
// needs nothing: it is a goal line, and stacks after the others like build.
const scriptForm = (text) => (/^\s*techgoals\b/im.test(String(text ?? ''))
  ? splitLines(text).map((l) => l.replace(/^(\s*)techgoals\b/i, '$1research')).join('\n') : text);
// A line is kept only if it sets something: a goal, or at least one config key.
// "unknown goal", or a config line whose every pair is bad, is reported to the
// script and left out, rather than repeating the same error in every plan.
const isGoalLine = (l) => {
  if (!l.replace(/^\s*(\/\/|#).*$/, '').trim()) return false;
  const p = parseGoals(l);
  return p.goals.length > 0 || Object.keys(p.config).length > 0;
};

// A config line only matters for the keys it sets, and the last one wins, so a
// key set again drops out of the earlier line (a line left with nothing goes);
// a one-per-city goal written again replaces the earlier line. A script that
// flips `config npc:5` and `config npc:0` in a loop does not grow the layer.
// A bare war setting (`hiding 2`, read as config hiding:2 by goals.js) counts as
// a config line of its one key.
function configPairs(line) {
  const m = String(line).match(/^\s*config\s+(.*)$/i);
  if (!m) return null;
  return m[1].split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf(':');
    return [(i < 0 ? p : p.slice(0, i)).toLowerCase(), p];
  });
}
const configOnly = (p) => p.goals.length === 0 && Object.keys(p.config).length > 0;
function compactInto(lines, added) {
  const out = lines.slice();
  for (const raw of added) {
    const line = raw.trim();
    const p = parseGoals(line);
    const g = p.goals[0];
    if (!p.errors.length && configOnly(p)) {
      const keys = new Set(Object.keys(p.config));
      for (let i = out.length - 1; i >= 0; i--) {
        const q = parseGoals(out[i]);
        if (!configOnly(q)) continue;
        const pairs = configPairs(out[i]);
        if (!pairs) {                              // bare: gone once its key is set again
          if (Object.keys(q.config).every((k) => keys.has(k))) out.splice(i, 1);
          continue;
        }
        const keep = pairs.filter(([k]) => !keys.has(k));
        if (keep.length === pairs.length) continue;
        if (keep.length) out[i] = `config ${keep.map(([, pair]) => pair).join(',')}`; else out.splice(i, 1);
      }
    } else if (!p.errors.length && g && GOALS[g.name] && !GOALS[g.name].multi) {
      for (let i = out.length - 1; i >= 0; i--) {
        const q = parseGoals(out[i]).goals[0];
        if (q && q.name === g.name) out.splice(i, 1);
      }
    }
    if (out[out.length - 1] !== line) out.push(line);        // the same line twice running is once
  }
  return out;
}

// What a call hands back: the parse of the text it was given, parseGoals-style
// ({ errors, lines }, line numbers counted in that text), each error also with
// `where`: its place in the layer as the plan note names it ("script line 3"),
// or "script, not added" for a line that set nothing and was left out.
function answer(accountId, castleId, text, extra = {}) {
  const p = parseGoals(text);
  const layer = LAYERS.get(layerKey(accountId, castleId));
  const at = layer ? layer.lines : [];
  const errors = p.errors.map((e) => {
    const given = splitLines(text)[e.line - 1].trim();
    const n = isGoalLine(given) ? at.lastIndexOf(given) + 1 : 0;
    return { ...e, source: 'script', where: n ? `script line ${n}` : 'script, not added' };
  });
  return { errors, lines: p.lines, layer: getScriptLayer(accountId, castleId), ...extra };
}

// Store a city's layer. `start` begins it afresh on a new base ({ base, loaded,
// loadedSrc }); without it the layer keeps the base and start time it had.
function putLayer(accountId, castleId, lines, start = null) {
  const k = layerKey(accountId, castleId), now = Date.now();
  const prev = start ? null : LAYERS.get(k);
  const from = start || prev || { base: 'saved' };
  LAYERS.set(k, {
    base: from.base, loaded: from.loaded || null, loadedSrc: from.loadedSrc || null,
    setAt: prev ? prev.setAt : now, changedAt: now, lines,
  });
}
const tooLong = () => ({ errors: [], lines: [], error: `the script goal layer holds ${SCRIPT_MAX_LINES} lines at most — a script's resetgoals or loadgoals, or Clear script goals, empties it` });

// { src, setAt, changedAt, base, loaded, count } or null. src is the script's
// own lines, one per line; count how many there are.
function getScriptLayer(accountId, castleId) {
  const l = LAYERS.get(layerKey(accountId, castleId));
  if (!l) return null;
  return { src: l.lines.join('\n'), setAt: l.setAt, changedAt: l.changedAt, base: l.base, loaded: l.loaded,
    loadedSrc: l.loadedSrc, count: l.lines.length };
}

// Replace the layer with these goal lines, on top of the saved goals.
function setScriptLayer(accountId, castleId, src) {
  src = scriptForm(src);
  const lines = compactInto([], splitLines(src).filter(isGoalLine));
  if (lines.length > SCRIPT_MAX_LINES) return tooLong();
  putLayer(accountId, castleId, lines, { base: 'saved', loaded: null, loadedSrc: null });
  return answer(accountId, castleId, src);
}

// Add goal lines to the layer (NEAT's `goal <line>`, a bare `config k:v`, or a
// multi-line `goal $result`), on top of whatever it stands on.
function addScriptLine(accountId, castleId, line) {
  line = scriptForm(line);
  const add = splitLines(line).filter(isGoalLine);
  if (!add.length) return answer(accountId, castleId, line);
  const cur = LAYERS.get(layerKey(accountId, castleId));
  const lines = compactInto(cur ? cur.lines : [], add);
  if (lines.length > SCRIPT_MAX_LINES) return tooLong();
  putLayer(accountId, castleId, lines);
  return answer(accountId, castleId, line);
}

// What `loadgoals <which>` loads. OTTObot has no numbered goal sets per city, so:
//   (nothing) or 0   the city's own saved goals, NEAT's regular set 0: the layer ends
//   1 to 9           the account's goal set N (the console's goal editor, Goal set N)
//   a castle id      that city's saved goals
//   a city's name    that city's saved goals (the account's cities, by the registry)
// The text is copied when it is loaded, as NEAT reads a set into memory.
function goalSetFor(accountId, which) {
  const D = require('./db');
  const w = String(which).trim();
  if (/^\d$/.test(w)) {
    const row = D.goals.exact(accountId, `set${w}`, 'goal');
    if (!row || !goalLines(row.src)) return { error: `goal set ${w} is empty — write it in the console's goal editor (Goal set ${w})` };
    return { label: `goal set ${w}`, src: row.src };
  }
  let castleId = /^\d+$/.test(w) ? w : null, name = null;
  if (!castleId) {
    const hit = D.registry.all(accountId)
      .find((r) => r.castleId !== null && r.state !== 'gone' && r.state !== 'abandoned' && String(r.name || '').toLowerCase() === w.toLowerCase());
    if (!hit) return { error: `loadgoals ${w}: not a goal set (1 to ${GOAL_SETS}) nor one of this account's cities` };
    castleId = String(hit.castleId);
    name = hit.name;
  }
  const row = D.goals.exact(accountId, castleId, 'goal');
  if (!row || !goalLines(row.src)) return { error: `${name || `city ${castleId}`} has no saved goals to load` };
  return { label: `the goals of ${name || `city ${castleId}`}`, src: row.src };
}

// NEAT's `loadgoals [n|name]`. Returns { errors, lines } for the loaded text,
// with `loaded` naming it, or { error } and the layer untouched.
function loadScriptGoals(accountId, castleId, which) {
  const w = which === undefined || which === null ? '' : String(which).trim();
  if (w === '' || w === '0') {
    const had = clearScriptLayer(accountId, castleId);
    return { errors: [], lines: [], layer: null, cleared: had, loaded: 'the saved goals' };
  }
  const set = goalSetFor(accountId, w);
  if (set.error) return { error: set.error };
  putLayer(accountId, castleId, [], { base: 'loaded', loaded: set.label, loadedSrc: set.src });
  const p = parseGoals(set.src);
  return {
    errors: p.errors.map((e) => ({ ...e, source: 'loaded', where: `${set.label} line ${e.line}` })),
    lines: p.lines, layer: getScriptLayer(accountId, castleId), loaded: set.label,
  };
}

// NEAT's `resetgoals`: the city runs no goals at all until the layer is cleared
// (or the console restarts); goal lines a script sets afterwards build a fresh set.
function resetScriptGoals(accountId, castleId) {
  putLayer(accountId, castleId, [], { base: 'reset', loaded: null, loadedSrc: null });
  return { errors: [], lines: [], layer: getScriptLayer(accountId, castleId) };
}

// Back to the saved goals. True when there was a layer to drop.
function clearScriptLayer(accountId, castleId) {
  return LAYERS.delete(layerKey(accountId, castleId));
}

// The goals the engine runs in one city: the saved layers (goalsApi.layers, the
// db or an organization's handle) with the city's script layer on top.
function runningGoals(goalsApi, accountId, castleId, cityName) {
  return parseLayered({ ...goalsApi.layers(accountId, castleId, cityName), script: getScriptLayer(accountId, castleId) });
}

const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

// The plan note while a city has a script layer, with any of its lines the
// parser could not read (the script was told when it set them).
function scriptNote(layer, parsed = null) {
  if (!layer) return null;
  const n = layer.count, at = hhmm(layer.setAt);
  const head = layer.base === 'reset' ? `script layer active: goals reset by a script at ${at}${n ? `, ${plural(n, 'line')} set since` : ', nothing set since'}`
    : layer.base === 'loaded' ? `script layer active: ${layer.loaded} loaded by a script at ${at}${n ? `, ${plural(n, 'line')} added` : ''}`
    : `script layer active (${plural(n, 'line')}, set by a script at ${at})`;
  const errs = ((parsed && parsed.errors) || []).filter((e) => e.source === 'script' || e.source === 'loaded');
  return head + (errs.length ? `; ${errs.length} line(s) not understood — ${errs.slice(0, 2).map((e) => `${e.where}: ${e.error}`).join('; ')}` : '');
}

module.exports = {
  TEXTS, GOAL_SETS, NEW_CITY_GOALS, goalLines, parseLayered, layerNote, readText, saveText,
  // the script goal layer
  setScriptLayer, addScriptLine, loadScriptGoals, resetScriptGoals, clearScriptLayer, getScriptLayer,
  runningGoals, scriptNote, SCRIPT_MAX_LINES,
};
