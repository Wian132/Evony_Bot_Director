'use strict';
// NEAT-style scripts: a line-by-line language with labels, jumps, conditions,
// variables and expressions, whose commands live in script-cmd-*.js.
//
// ------------------------------------------------------------------ language
//   // comment   # comment          whole line; // also after code (never inside "quotes")
//   @echo "quiet"                   @ first on a line runs it silently (@: is a time, not this)
//   set target 111,222              NEAT's replacement variable: %target% in a line is
//                                   swapped in when that line runs (so it can change in a
//                                   loop); with no `set`, %x% reads the true variable x
//   x = 5 | x += 2 | x++ | a.b = 1 | list[0] = "a"      true variables (see script-expr.js)
//   echo "My city is at " + city.coords + " with" cavs "cavalry"
//                                   expressions side by side are joined with a space;
//                                   text in quotes is literal, {expr} inside "..." is filled in,
//                                   and a line that is not an expression prints as written
//   print text                      plain text, %vars% only
//   label name | goto name | gosub name ... return (also gosubreturn)
//   if (cond) <any line>            the brackets are optional: if $error goto retry
//                                   if a == 1 if b == 1 echo "both" | if x item = "y"
//   ifgoto (cond) name | ifgosub (cond) name       (NEAT's older forms)
//   loop | loop 0                   back to the top, forever
//   loop 5 | loop name | loop 5 name | loop name 5   the whole script / the part from label
//                                   `name` runs 5 times in all (forever without a count)
//   loop 3 ... endloop              OTTObot's block: the lines between run 3 times
//   repeat 10 | repeat | repeat 0   the last line that ran, until it has run 10 times in all
//                                   (NEAT's count: `repeat 1` adds nothing) | until it fails or Stop
//                                   A line the server refuses, reached again (goto, loop, repeat),
//                                   waits repeatGapMs (200 ms) before it is sent again; the same
//                                   line refused 10 times in a row ends the run
//   sleep 5 | sleep 1:30 | sleep 1:00:00 | sleep @:14:15 | sleep rnd:300 | sleep rnd:300:600
//   end | exit                      the script ends here (exit never closes the console)
//   stop                            pause here until resumed (without a resume, the script ends)
//   die "message"                   end with an error
//   execute "goto city" + city.timeSlot    build a line and run it
//   call "farm upgrades"            run another script (a loadout) with these true variables;
//                                   it comes back at its end or at a top-level return
//   command "who " + name           an in-line command; its output in $result, a failure in $error
//   function name(a, b) ... return x       (up to the next function, endfunction or the end)
//   callfunc name(1, 2)             or call it in an expression: y = name(1, 2)
//   $result, $error                 set after every command ($error is null when it worked)
//   any other first word            a command from script-cmd-*.js, e.g.
//     attack 123,456 any a:99k @:07:00:00.500 | train a 10k | upgrade cottage | sell wood 1000 @0.55
//
// run(game, actions, log, opts) -> actions done. Beside the options server.js
// passes (dryRun, castle, autoReq, session, shouldStop, otherScripts, atLogout,
// repeatGapMs, tradeGapMs, stopOnError):
//   startLine       a line number (NEAT's Run box) or a label ('autorun') to start at
//   loadScript(name) -> text | null   what `call` runs (no hook: `call` fails, clearly)
//   onPause({line, next}) -> Promise  `stop` waits for it; it resolves false to end instead
//   parseGoalLine(text) / applyGoalLine(text, goal, env)   goal lines in scripts (config npc:5)
//   globals         extra global names (tests); modules: extra command modules (tests)
//   mapSource       handed to script-functions/objects through ctx (tests)
//   timeScale       (tests) every wait lasts this fraction of its time: 0.001 = 1000x faster
//   trace(line, top)  (tools) called with each statement's line number as it starts
//                   (top: false inside a called script)
//
// ------------------------------------------------------------ command modules
// Commands live in script-cmd-<area>.js (deploy, city, hero, account, market,
// info, social, goals). Each exports:
//
//   commands: {
//     <name>: {
//       usage: 'tax <0-100>',                // shown in docs and errors
//       aliases: ['settax'],                 // more words that start such a line
//       words: [...],                        // OR exactly these words (<name> itself is not one)
//       parse(args, { word, line, tok }),    // load time -> action (plain data)
//       async run(action, env),              // run time -> { ok, done, result, error, end }
//       parseAtRunTime: true,                // optional: parse only when the line runs
//     },
//   },
//   functions: (ctx) => ({ ... }),           // optional: more globals (getters for game state)
//   readOnly: new Set(['NAME']),             // optional: globals a script may not assign
//   inline: { <name>: { usage, aliases, async run(argsText, env) } },   // optional: `command "<name> ..."`
//   goalLines: { parse(text, info), async run(action, env) },   // optional: lines no command claims
//
// Words are matched in any case; the first module (in MODULE_FILES order) to
// claim a word has it, and the language's keywords (if, goto, echo...) cannot be
// claimed. Each module loads on its own: one that fails to load brings no
// commands, and every line that then reads as an unknown command names it
// (parse(...).loadErrors and lineStatus(...).loadErrors list them too).
//
// goalLines.parse(text, info) gets a whole line whose first word is no command
// (nor an expression like `list.push(1)`); info = { word: that first word in lower
// case, words: the registry's Map of command words, failed: the modules that did
// not load ([{ file, error }]) }. It returns an action, null to leave the line
// alone (then it is an unknown command), or throws for a bad goal line.
// run()'s parseGoalLine/applyGoalLine hooks, when given, are asked first.
// goalLines.run(action, env) is called like a command's run.
//
// parse(args, info) gets the text after the command word, with comments, the @
// prefix and %vars% already dealt with; info.word is the command word as written
// (lower case), info.line the whole line, info.tok = line.split(/\s+/). It returns
// the action — plain data only, so the editor can show it — or throws
// Error('what to write instead'): a script with such a line is refused before
// anything runs. The action's `cmd` defaults to <name>; a parse may put another
// command's name there (deploy bu -> construct, useheroitem X holy water ->
// waterhero) and that command's run gets it. A command without parse is no word
// (construct: only `deploy bu` makes one). parseAtRunTime: the line is parsed when
// it is reached; a line holding {expr}, or a %name% whose value can change, is
// parsed then anyway, and a parse error then fails only that line.
//
// run(action, env) does the work; action is what parse returned, plus line and raw.
//   env.game, env.castle, env.cid   getters: the CURRENT Game (a run follows reconnects)
//                             and the run's city; read them again after any wait
//   env.session, env.opts, env.dryRun    opts is run()'s opts
//   env.log(msg)              a line of output, '  '-indented under the line's header;
//                             silenced by @, and collected for $result
//   env.say(reply)            'ok' | 'FAILED (ok=-5) - msg'; a refusal marks the line failed
//   env.verdict(reply)        the same text, marking nothing
//   env.refused()             has say() seen a refusal on this line?
//   env.stopped(), env.pause(ms)   Stop pressed? / wait, cut short by Stop
//   env.follow()              take the session's new Game after a reconnect
//   env.state                 an object per module per run (the market's pacing)
//   env.sentHeroes            Map heroId -> ms: heroes this run sent on marches
//   env.ctx                   the run's ctx (DESIGN.md); env.line: the source line number
//   env.registry()            the run's commands as plain frozen data: { commands: [{ name,
//                             usage, words, aliases }], inline: [{ name, usage, words }], keywords }
//   env.evaluate(src)         an expression, in the line's own scope (a function's arguments)
//   env.echoText(src)         the text `echo <src>` would print (bare words as written)
// It returns (every field optional):
//   ok      it did what was asked; default: no reply through say() was a refusal
//   done    how many actions count toward run()'s return (server replies, refusals
//           included); default 0
//   result  the value for $result; default: the text the line logged
//   error   $error when ok is false; default: the last refused verdict ($error is null when ok)
//   end     true ends the run after this line (logout; Stop in the middle of a wait)
//   refused true: count this failure as a refusal though nothing was sent (buyitem past
//           the run's limit) — the same line refused 10 times in a row ends the run
// A throw is logged as "  FAILED: <message>", sets $error and the script goes on
// (unless opts.stopOnError). After every command the VM sets $error (null when
// ok, else the message) and $result. A dry run logs what would go out and
// "  [dry run] not sent", sends nothing and returns {} (done 0). A bare `repeat`
// stops when ok is false. The VM logs "line N: <line>" before a command runs;
// a module logs only its own '  '-indented lines. Modules must not
// require('./script') at load time (it requires them): shared helpers are in
// script-words.js (troop/resource/building words, num, parseTroops, times).

const W = require('./script-words');
const E = require('./script-expr');

const MODULE_FILES = ['./script-cmd-deploy', './script-cmd-city', './script-cmd-hero', './script-cmd-account',
  './script-cmd-market', './script-cmd-info', './script-cmd-social', './script-cmd-goals'];
const PROVIDERS = ['./script-functions', './script-objects'];

// `repeat N` runs the line N times IN ALL, counting the run just before it (so
// `repeat 1` adds nothing), as NEAT means it: the wiki's Goto page prints
// `echo ... / repeat 2` twice a round, the Gosub page's `upgrade house / repeat 2`
// "upgrades the cottage twice", IfGosub's `train arch:250 Bubba / repeat 4`
// queues archers "4 times", and the tutorial's "attack it 8 times" is
// `attack ... / repeat 8`. OTTObot's old meaning (N MORE runs) is false here.
const REPEAT_COUNTS_TOTAL = true;
// The same line refused this many times in a row ends the run (Run.countRefusal).
const MAX_REFUSALS = 10;

const KEYWORDS = new Set(['label', 'goto', 'gosub', 'return', 'gosubreturn', 'if', 'ifgoto', 'ifgosub', 'loop',
  'endloop', 'repeat', 'end', 'exit', 'stop', 'die', 'echo', 'print', 'sleep', 'set', 'execute', 'call', 'command',
  'function', 'endfunction', 'callfunc']);
// Lines that do something a `repeat` can do again.
const ACTIONS = new Set(['cmd', 'echo', 'print', 'sleep', 'assign', 'expr', 'command', 'callfunc', 'call', 'goal', 'goalmod']);
const VAR_RE = /%([A-Za-z_][A-Za-z0-9_]*)%/g;

// ------------------------------------------------------------------ registry

// Each module on its own: one that does not load (a half-edited file) brings no
// commands, and every line that then reads as an unknown command says why.
function buildRegistry(extra = []) {
  const mods = [...extra];
  const failed = [];
  for (const f of MODULE_FILES) {
    try { mods.push(require(f)); } catch (e) { failed.push({ file: f.slice(2) + '.js', error: String(e.message).split('\n')[0] }); }
  }
  const words = new Map(), cmds = new Map(), inline = new Map(), goalLines = [];
  for (const mod of mods) {
    try {
      for (const [name, spec] of Object.entries(mod.commands || {})) {
        if (!cmds.has(name)) cmds.set(name, { name, spec, mod });
        if (typeof spec.parse !== 'function') continue;
        for (const w of spec.words || [name, ...(spec.aliases || [])]) {
          const k = String(w).toLowerCase();
          if (!words.has(k) && !KEYWORDS.has(k)) words.set(k, { name, spec, mod });
        }
      }
      for (const [name, spec] of Object.entries(mod.inline || {})) {
        for (const w of [name, ...(spec.aliases || [])]) if (!inline.has(String(w).toLowerCase())) inline.set(String(w).toLowerCase(), { name, spec, mod });
      }
      if (mod.goalLines && typeof mod.goalLines.parse === 'function') goalLines.push({ mod, spec: mod.goalLines });
    } catch (e) {
      failed.push({ file: 'a command module', error: e.message });
    }
  }
  return { mods, words, cmds, inline, goalLines, failed };
}
let REGISTRY = null;
// A failed module is tried again on the next parse: it may have been fixed.
const registry = (extra) => {
  if (extra && extra.length) return buildRegistry(extra);
  if (!REGISTRY || REGISTRY.failed.length) REGISTRY = buildRegistry();
  return REGISTRY;
};
const unknownCommand = (word, reg) => new Error('unknown command: ' + word
  + (reg.failed.length ? ` — note: ${reg.failed.map((f) => `${f.file} failed to load (${f.error})`).join('; ')}` : ''));

// ------------------------------------------------------------------ lines

// `//` outside quotes ends the line. An apostrophe inside a word (don't) opens nothing.
function stripComment(t) {
  let q = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"') { q = c; continue; }
    if (c === "'" && (i === 0 || /[\s(,=[+:!&|?{]/.test(t[i - 1]))) { q = c; continue; }
    if (c === '/' && t[i + 1] === '/') return t.slice(0, i);
  }
  return t;
}

// execute's text as statements: one a line, except that a line with a (, [ or {
// still open goes on into the next — SortingMemberList builds `members = [ … ]`
// with a line per member. Brackets in quotes or after // do not count.
function executeLines(text) {
  const out = [];
  let buf = '';
  for (const line of String(text).split(/\r?\n/)) {
    buf = buf ? buf + ' ' + line.trim() : line;
    if (openBrackets(buf) > 0) continue;
    out.push(buf);
    buf = '';
  }
  if (buf) out.push(buf);
  return out;
}

function openBrackets(t) {
  let depth = 0, q = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"') { q = c; continue; }
    if (c === "'" && (i === 0 || /[\s(,=[+:!&|?{]/.test(t[i - 1]))) { q = c; continue; }
    if (c === '/' && t[i + 1] === '/') break;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
  }
  return depth;
}

// One line of source -> { text, silent } or { text: '' } for blank and comment.
function preprocess(raw) {
  let t = String(raw).replace(/^\uFEFF/, '').trim();
  if (!t) return { text: '', blank: true };
  if (t.startsWith('//') || t.startsWith('#')) return { text: '', comment: true };
  t = t.replace(/^\d+:\s+(?=\S)/, '');           // the wiki's "1: sleep ..." line numbers
  let silent = false;
  if (t.startsWith('@') && !t.startsWith('@:')) { silent = true; t = t.slice(1).trim(); }
  t = stripComment(t).trim();
  if (!t) return { text: '', comment: true };
  return { text: t, silent };
}

function parseSleep(rest) {
  const a = rest.split(/\s+/)[0] || '';
  if (a.startsWith('@:')) return { cmd: 'sleep', until: W.parseLandTime(a) };
  const r = /^rnd:(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?$/i.exec(a);
  if (r) {
    const lo = r[2] === undefined ? 0 : +r[1], hi = r[2] === undefined ? +r[1] : +r[2];
    if (hi < lo) throw new Error('sleep rnd:min:max — the second number is the longest wait, so it cannot be smaller');
    return { cmd: 'sleep', rnd: [lo, hi] };
  }
  if (/:/.test(a)) return { cmd: 'sleep', seconds: W.parseDuration(a, 'sleep time') };
  return { cmd: 'sleep', seconds: parseFloat(a) };
}

const exprErr = (what, e) => new Error(`${what}: ${e.message}`);

// One statement's text -> a node { kind, view, ... }. C: { reg, opts, runtime }.
function parseStmt(text, C) {
  const word = (/^[A-Za-z_$][\w$]*/.exec(text) || [''])[0];
  const lw = word.toLowerCase();
  const tail = text.slice(word.length);
  const rest = tail.trim();
  const restAt = text.length - tail.trimStart().length;
  const next = tail[0];

  if (E.assignmentStart(text)) {
    let ast;
    try { ast = E.parseStatement(text); } catch (e) { throw exprErr('assignment', e); }
    if (ast.type !== 'assign' && ast.type !== 'update') throw unknownCommand(lw, C.reg);
    return { kind: 'assign', ast, view: { cmd: 'assign', expr: text } };
  }

  const single = (what) => {
    if (!rest || /\s/.test(rest)) throw new Error(`${what}: usage  ${what} <label name>`);
    return rest.toLowerCase();
  };
  const expr = (what, src, at) => { try { return E.parseExpression(src, at); } catch (e) { throw exprErr(what, e); } };
  // echo/die items; a quote left open at the end of the line closes there, as
  // NEAT's did (MapFunctions: echo "Distance from {city.coords} to {targ} is {distance}.)
  const list = (src) => {
    try { return E.parseList(src); } catch { /* below */ }
    if (!/"/.test(src)) return null;
    try { return E.parseList(src + '"'); } catch { return null; }
  };

  if (KEYWORDS.has(lw)) {
    switch (lw) {
      case 'label': {
        if (!/^[\w$.!-]+$/.test(rest)) throw new Error('label: usage  label <name>   (one word)');
        return { kind: 'label', name: rest.toLowerCase(), view: { cmd: 'label', name: rest } };
      }
      case 'goto': case 'gosub':
        return { kind: lw, label: single(lw), view: { cmd: lw, label: rest } };
      case 'return': case 'gosubreturn':
        return { kind: 'return', expr: rest ? expr('return', rest, restAt) : null, view: { cmd: 'return', ...(rest ? { expr: rest } : {}) } };
      case 'if': case 'ifgoto': case 'ifgosub': {
        if (!rest) throw new Error(`${lw}: usage  ${lw === 'if' ? 'if (condition) <line>' : lw + ' (condition) <label>'}`);
        let pre;
        try { pre = E.parsePrefix(rest, 0, restAt); } catch (e) { throw exprErr(lw, e); }
        const cond = rest.slice(0, pre.end).trim();
        const after = rest.slice(pre.end).trim();
        if (lw !== 'if') {
          if (!after || /\s/.test(after)) throw new Error(`${lw}: usage  ${lw} (condition) <label>`);
          const kind = lw === 'ifgoto' ? 'goto' : 'gosub';
          return { kind: 'if', cond: pre.ast, then: { kind, label: after.toLowerCase(), view: { cmd: kind, label: after } }, view: { cmd: lw, cond, label: after } };
        }
        if (!after) throw new Error('if: say what to do when it is true — e.g.  if city.troop.archer < 20k goto trainarchers');
        const then = parseStmt(after, C);
        if (['label', 'function', 'endfunction', 'endloop'].includes(then.kind)) throw new Error(`if: a ${then.kind} cannot depend on a condition`);
        return { kind: 'if', cond: pre.ast, then, view: { cmd: 'if', cond, then: then.view } };
      }
      case 'loop': {
        const toks = rest ? rest.split(/\s+/) : [];
        let times = null, label = null;
        for (const t of toks) {
          if (/^\d+$/.test(t) && times === null) times = parseInt(t, 10);
          else if (/^[\w$.!-]+$/.test(t) && !/^\d+$/.test(t) && label === null) label = t;
          else throw new Error('loop: usage  loop [count] [label]   — no count or 0 is forever');
        }
        return { kind: 'loop', times: times || null, label: label && label.toLowerCase(), view: { cmd: 'loop', times: times || null, ...(label ? { label } : {}) } };
      }
      case 'endloop': return { kind: 'endloop', view: { cmd: 'endloop' } };
      case 'repeat': {
        // A bare `repeat` (or 0) has no count: it runs the line above until that
        // fails or the run is stopped.
        if (!rest) return { kind: 'repeat', times: null, view: { cmd: 'repeat', times: null } };
        if (!/^\d+$/.test(rest)) throw new Error('repeat: give a count (repeat 10), or none to repeat until it fails or you press Stop');
        const n = parseInt(rest, 10);
        return { kind: 'repeat', times: n || null, view: { cmd: 'repeat', times: n || null } };
      }
      case 'end':
        if (/^function$/i.test(rest)) return { kind: 'endfunction', view: { cmd: 'endfunction' } };
        if (rest) throw new Error('end: nothing goes after it');
        return { kind: 'end', view: { cmd: 'end' } };
      case 'exit': case 'stop':
        if (rest) throw new Error(`${lw}: nothing goes after it`);
        return { kind: lw, view: { cmd: lw } };
      case 'die': return { kind: 'die', items: rest ? list(rest) : [], text: rest, view: { cmd: 'die', text: rest } };
      case 'echo': return { kind: 'echo', items: list(rest), text: rest, view: { cmd: 'echo', text: rest } };
      case 'print': return { kind: 'print', text: rest, view: { cmd: 'print', text: rest } };
      case 'sleep': { const v = parseSleep(rest); return { kind: 'sleep', ...v, view: v }; }
      case 'set': {
        const m = rest.match(/^([a-z_][a-z0-9_]*)\s+(.+)$/i);
        if (!m) throw new Error('set: usage  set <name> <value>   and then %name% in the lines below');
        return { kind: 'set', name: m[1].toLowerCase(), value: m[2].trim(), view: { cmd: 'set', name: m[1], value: m[2].trim() } };
      }
      case 'execute': case 'command': {
        if (!rest) throw new Error(`${lw}: usage  ${lw} "<line>"   (an expression: "goto city" + city.timeSlot)`);
        return { kind: lw, expr: expr(lw, rest, restAt), view: { cmd: lw, expr: rest } };
      }
      case 'call': {
        if (!rest) throw new Error('call: usage  call "<loadout name or number>"');
        const bare = /^[A-Za-z_$][\w$-]*$/.test(rest) ? rest : null;
        return { kind: 'call', expr: bare && /-/.test(bare) ? null : expr('call', rest, restAt), bare, view: { cmd: 'call', script: rest } };
      }
      case 'function': {
        const m = rest.match(/^([A-Za-z_$][\w$]*)\s*\(([^)]*)\)$/);
        if (!m) throw new Error('function: usage  function name(a, b)   — the lines below it, up to return, are its body');
        const params = m[2].split(',').map((x) => x.trim()).filter(Boolean);
        for (const p of params) if (!/^[A-Za-z_$][\w$]*$/.test(p)) throw new Error(`function ${m[1]}: "${p}" is not a name`);
        return { kind: 'function', name: m[1], params, view: { cmd: 'function', name: m[1], params } };
      }
      case 'endfunction': return { kind: 'endfunction', view: { cmd: 'endfunction' } };
      case 'callfunc': {
        const ast = expr('callfunc', rest, restAt);
        if (ast.type !== 'call' || ast.callee.type !== 'id') throw new Error('callfunc: usage  callfunc name(arguments)');
        return { kind: 'callfunc', call: ast, name: ast.callee.name, view: { cmd: 'callfunc', call: rest } };
      }
      default: break;
    }
  }

  // An expression on its own line: Arr.forEach(f), Settings.autoUseItems([...]).
  const exprLine = () => {
    let ast;
    try { ast = E.parseExpression(text); } catch { return null; }
    let calls = false;
    const walk = (n) => {
      if (!n || typeof n !== 'object' || calls) return;
      if (n.type === 'call' || n.type === 'assign' || n.type === 'update') { calls = true; return; }
      for (const v of Object.values(n)) if (v && typeof v === 'object' && v !== n.src) (Array.isArray(v) ? v.forEach(walk) : walk(v));
    };
    walk(ast);
    return calls ? { kind: 'expr', ast, view: { cmd: 'expr', expr: text } } : null;
  };

  const ent = lw && C.reg.words.get(lw);
  if (ent && !['(', '.', '['].includes(next)) return commandNode(ent, lw, text, rest, C);
  if (lw) { const n = exprLine(); if (n) return n; }

  // Goal lines in scripts (config npc:5): run()'s hooks first, then the
  // modules' goalLines (script-cmd-goals.js).
  if (C.opts && typeof C.opts.parseGoalLine === 'function') {
    const g = C.opts.parseGoalLine(text);
    if (g) return { kind: 'goal', text, goal: g, view: { cmd: 'goal', text } };
  } else if (C.opts && typeof C.opts.applyGoalLine === 'function') {
    return { kind: 'goal', text, goal: null, view: { cmd: 'goal', text } };
  }
  for (const gl of C.reg.goalLines) {
    const action = gl.spec.parse(text, { word: lw, words: C.reg.words, failed: C.reg.failed });
    if (action) return { kind: 'goalmod', runner: gl, action, view: { cmd: 'goal', ...action } };
  }
  throw unknownCommand(lw || text.split(/\s+/)[0].toLowerCase(), C.reg);
}

// A command line: parsed now, or when it runs if it holds {expr}.
function commandNode(ent, lw, text, rest, C) {
  if (ent.spec.parseAtRunTime || E.hasSpans(rest)) {
    return { kind: 'cmd', deferred: true, text, view: { cmd: ent.name, deferred: true } };
  }
  const { action, runner } = parseCommand(ent, lw, text, rest, C.reg);
  return { kind: 'cmd', action, runner, view: action };
}

function parseCommand(ent, lw, text, rest, reg) {
  const out = ent.spec.parse(rest, { word: lw, line: text, tok: text.split(/\s+/) });
  const action = out && out.cmd ? out : { cmd: ent.name, ...out };
  const runner = reg.cmds.get(action.cmd);
  if (!runner || typeof runner.spec.run !== 'function') throw new Error(`${lw}: nothing runs "${action.cmd}"`);
  return { action, runner };
}

const forEachNode = (n, f) => { f(n); if (n.then) forEachNode(n.then, f); };

// ------------------------------------------------------------------ compile

// Names set with `set` and true variables assigned anywhere: a %x% that is
// neither can be refused before the run.
function scanNames(lines) {
  const sets = new Set(), assigned = new Set();
  let dynamic = false;
  for (const t of lines) {
    for (const m of t.matchAll(/(?:^|\s)set\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) sets.add(m[1].toLowerCase());
    for (const m of t.matchAll(/([A-Za-z_$][\w$]*)\s*(?:=(?!=)|\+=|-=|\*=|\/=|%=|\+\+|--)/g)) assigned.add(m[1].toLowerCase());
    for (const m of t.matchAll(/function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/gi)) for (const p of m[1].split(',')) assigned.add(p.trim().toLowerCase());
    if (/(^|\s)(execute|call)\s/i.test(t)) dynamic = true;
  }
  return { sets, assigned, dynamic };
}

function compile(text, opts = {}) {
  const reg = registry(opts.modules);
  const C = { reg, opts };
  const program = { stmts: [], labels: new Map(), functions: new Map(), reg, opts, warnings: [], cache: new Map() };
  const pre = String(text == null ? '' : text).split(/\r?\n/).map((raw, i) => ({ n: i + 1, ...preprocess(raw) }));
  const names = scanNames(pre.map((p) => p.text).filter(Boolean));
  const known = new Set([...(opts.knownVars || [])].map((v) => String(v).toLowerCase()));
  const setVals = new Map();

  for (const p of pre) {
    if (!p.text) continue;
    const base = { line: p.n, src: p.text, silent: p.silent };
    let t = p.text;
    const usesVars = /%[A-Za-z_][A-Za-z0-9_]*%/.test(t);
    let node;
    try {
      if (usesVars) {
        const missing = [];
        const subbed = t.replace(VAR_RE, (m, name) => {
          const v = setVals.get(name.toLowerCase());
          if (v === undefined) { missing.push(name); return m; }
          return v;
        });
        const unknown = missing.find((n) => !names.sets.has(n.toLowerCase()) && !names.assigned.has(n.toLowerCase())
          && !known.has(n.toLowerCase()) && !names.dynamic);
        if (unknown) throw new Error(`%${unknown}% is not set — put  set ${unknown} <value>  above this line`);
        if (missing.length) {
          // its value is only known when the line runs
          const w = (/^[A-Za-z_$][\w$]*/.exec(t) || [''])[0].toLowerCase();
          node = { kind: 'dynamic', view: { cmd: w === 'set' ? 'set' : w || 'line', deferred: true } };
        } else t = subbed;
      }
      if (!node) node = parseStmt(t, C);
      if (node.kind === 'set') setVals.set(node.name, node.value);
    } catch (e) {
      node = { kind: 'error', error: e.message, view: null };
    }
    // lineText: the line as it reads now (%vars% filled in); null until it runs
    Object.assign(node, base, { lineText: node.kind === 'dynamic' ? null : t, usesVars });
    program.stmts.push(node);
  }
  link(program);
  return program;
}

// Labels, functions, loop blocks and the checks that need the whole script.
function link(P) {
  const S = P.stmts;
  const fail = (node, msg) => { if (node.kind !== 'error') Object.assign(node, { kind: 'error', error: msg }); else node.more = [...(node.more || []), msg]; };

  // functions: a body runs to the next function, endfunction, or the end
  for (let i = 0; i < S.length; i++) {
    if (S[i].kind !== 'function') continue;
    const node = S[i];
    let j = i + 1;
    while (j < S.length && S[j].kind !== 'function' && S[j].kind !== 'endfunction') j++;
    const closed = j < S.length && S[j].kind === 'endfunction';
    const def = { name: node.name, params: node.params, line: node.line, bodyStart: i + 1, bodyEnd: j };
    node.fn = def;
    node.skipTo = closed ? j + 1 : j;
    if (closed) S[j].fn = def;
    else {
      // lines after the body's last return still belong to it: say so
      let lastRet = -1;
      for (let k = i + 1; k < j; k++) if (S[k].kind === 'return') lastRet = k;
      if (lastRet !== -1 && lastRet < j - 1) {
        P.warnings.push({ line: node.line, warning: `function ${node.name} has no endfunction, so line ${S[lastRet + 1].line} to line ${S[j - 1].line}, after its return, are part of it — close it with endfunction` });
      }
    }
    for (let k = i + 1; k < j; k++) S[k].inFn = def;
    const key = node.name.toLowerCase();
    if (P.functions.has(key)) fail(node, `function ${node.name} is already on line ${P.functions.get(key).line}`);
    else P.functions.set(key, def);
  }
  for (const n of S) if (n.kind === 'endfunction' && !n.fn) fail(n, 'endfunction without function');

  for (let i = 0; i < S.length; i++) {
    const n = S[i];
    if (n.kind !== 'label') continue;
    if (P.labels.has(n.name)) fail(n, `label ${n.view.name} is already on line ${S[P.labels.get(n.name)].line}`);
    else P.labels.set(n.name, i);
  }

  // OTTObot's loop N ... endloop blocks; a loop no endloop closes is NEAT's jump back
  const stack = [];
  for (let i = 0; i < S.length; i++) {
    const n = S[i];
    if (n.kind === 'loop' && !n.label) stack.push(i);
    else if (n.kind === 'endloop') {
      const at = stack.pop();
      if (at === undefined) { fail(n, 'endloop without loop'); continue; }
      S[at].block = true;
      n.loopPc = at;
    }
  }

  const labelCheck = (n, name, what) => {
    const at = P.labels.get(name);
    if (at === undefined) return `${what}: there is no label "${name}"`;
    if ((S[at].inFn || null) !== (n.inFn || null)) return `${what} ${name}: the label is ${S[at].inFn ? 'inside function ' + S[at].inFn.name : 'outside the function'} — a jump cannot cross a function's edge`;
    return null;
  };
  const hasReturnAfter = (at) => {
    for (let k = at + 1; k < S.length; k++) {
      let found = false;
      forEachNode(S[k], (x) => { if (x.kind === 'return') found = true; });
      if (found) return true;
    }
    return false;
  };

  // A command whose spec says noBareRepeat (buyitem) may not be followed by a
  // repeat without a count: that would run it until it fails, spending as it goes.
  const noBareRepeat = (x) => {
    let why = null;
    forEachNode(x, (y) => {
      const name = why ? null : y.kind === 'cmd' ? (y.action ? y.action.cmd : y.view && y.view.cmd) : y.kind === 'dynamic' ? y.view && y.view.cmd : null;
      const ent = name && (P.reg.cmds.get(name) || P.reg.words.get(String(name).toLowerCase()));
      if (ent && ent.spec && ent.spec.noBareRepeat) why = `repeat after ${name}: ${ent.spec.noBareRepeat}`;
    });
    return why;
  };
  let prevAction = false, prevForever = false, afterLogout = null, prevNode = null;
  for (let i = 0; i < S.length; i++) {
    const n = S[i];
    if (n.kind === 'error') { prevAction = true; prevNode = null; continue; }
    forEachNode(n, (x) => {
      if (x.kind === 'goto' || x.kind === 'gosub') {
        const bad = labelCheck(n, x.label, x.kind);
        if (bad) fail(n, bad);
        else if (x.kind === 'gosub' && !hasReturnAfter(P.labels.get(x.label))) {
          // a warning, not a refusal: NEAT runs subroutines that never come back
          // (the LoadGoals page's own example ends at a stop)
          P.warnings.push({ line: n.line, warning: `gosub ${x.label}: there is no return after label ${x.label} — a subroutine ends with return` });
        }
      }
      if (x.kind === 'loop' && x.label) { const bad = labelCheck(n, x.label, 'loop'); if (bad) fail(n, bad); }
      if (x.kind === 'callfunc' && !P.functions.has(x.name.toLowerCase())) fail(n, `callfunc: there is no function ${x.name} in this script`);
    });
    if (n.kind === 'error') continue;

    if (n.kind === 'repeat') {
      if (!prevAction) fail(n, 'repeat with no previous action');
      else if (prevForever) fail(n, 'the repeat above never ends, so there is nothing after it to repeat');
      else if (n.times === null && prevNode && noBareRepeat(prevNode)) fail(n, noBareRepeat(prevNode));
    }
    // After a logout there is no game to run anything against (logout.js).
    if (afterLogout && !['label', 'function', 'end', 'exit', 'stop', 'die', 'return', 'endfunction'].includes(n.kind)) {
      fail(n, 'nothing can run after logout now — the run ends there; to carry on once the console is back, give a time to log out: logout 0 <back> (NEAT)');
      afterLogout = null;
    }
    if (['label', 'function'].includes(n.kind)) afterLogout = null;
    // a NEAT logout (resume: true) waits for the console to log back in and goes on
    if (n.kind === 'cmd' && n.action && n.action.cmd === 'logout' && !n.action.resume) afterLogout = n;

    if (ACTIONS.has(n.kind) || n.kind === 'if' || n.kind === 'execute' || n.kind === 'dynamic') { prevAction = true; prevNode = n; }
    prevForever = n.kind === 'repeat' && n.times === null;
  }
  lintNames(P);
}

// Names read but never assigned and not global: a warning, since NEAT reads them
// as undefined (`ifgosub castle found` relies on that).
let PROVIDER_NAMES = null;
function providerNames(reg) {
  if (PROVIDER_NAMES && PROVIDER_NAMES.reg === reg) return PROVIDER_NAMES.names;
  const names = new Set(Object.keys(E.builtins()).map((k) => k.toLowerCase()));
  const fake = { game: null, castle: null, session: undefined, opts: {}, dryRun: true, log() {}, vars: new Map(),
    evaluate: async () => undefined, call: async () => undefined, busyHeroes: () => false, mapSource: undefined };
  const add = (obj) => { if (obj) for (const k of Object.getOwnPropertyNames(obj)) names.add(k.toLowerCase()); };
  let complete = true;
  for (const mod of reg.mods) if (typeof mod.functions === 'function') { try { add(mod.functions(fake)); } catch { complete = false; } }
  for (const f of PROVIDERS) {
    try { const m = require(f); if (m && typeof m.globals === 'function') add(m.globals(fake)); } catch { complete = false; }
  }
  if (complete) PROVIDER_NAMES = { reg, names };
  return names;
}

function lintNames(P) {
  const reads = new Map(), writes = new Set(['$result', '$error']);
  const note = (ast, line, skipBare) => {
    if (!ast) return;
    const r = E.names(ast);
    for (const w of r.writes) writes.add(w.toLowerCase());
    for (const x of r.reads) if (!(skipBare && skipBare.has(x))) if (!reads.has(x)) reads.set(x, line);
  };
  for (const n of P.stmts) {
    forEachNode(n, (x) => {
      if (x.kind === 'function') for (const p of x.params) writes.add(p.toLowerCase());
      if (x.kind === 'assign' || x.kind === 'expr') note(x.ast, n.line);
      if (x.kind === 'if') note(x.cond, n.line);
      if (x.kind === 'execute' || x.kind === 'command' || x.kind === 'return' || (x.kind === 'call' && !x.bare)) note(x.expr, n.line);
      if (x.kind === 'callfunc') for (const a of x.call.args) note(a, n.line);
      if ((x.kind === 'echo' || x.kind === 'die') && x.items) {
        // a bare word in an echo prints as written, so it is no mistake
        const bare = new Set(x.items.filter((it) => it.type === 'id' && !it.paren).map((it) => it.name));
        for (const it of x.items) note(it, n.line, bare);
      }
    });
  }
  let globals = null;
  for (const fn of P.functions.values()) writes.add(fn.name.toLowerCase());
  for (const [name, line] of reads) {
    if (writes.has(name.toLowerCase())) continue;
    globals = globals || providerNames(P.reg);
    if (globals.has(name.toLowerCase()) || (P.opts.globals && name in P.opts.globals)) continue;
    P.warnings.push({ line, warning: `"${name}" is never set in this script and is no known name — it reads as undefined` });
  }
}

// ------------------------------------------------------------------ public parse

const viewOf = (n) => (n.kind === 'error'
  ? [{ cmd: 'error', line: n.line, raw: n.lineText || n.src, error: n.error }, ...(n.more || []).map((m) => ({ cmd: 'error', line: n.line, raw: n.lineText || n.src, error: m }))]
  : [{ ...n.view, line: n.line, raw: n.lineText || n.src }]);

// The script's lines as a list of plain entries: commands as their actions
// ({ cmd: 'train', troop, amount, line, raw }), control lines as { cmd: 'goto',
// label, ... }, and a { cmd: 'error', line, raw, error } for every line that
// cannot run. `set` lines are not listed. The program run() needs rides along
// as the list's hidden `program`. opts.check: the editor's check (the same parse;
// nothing is ever expanded any more).
function parse(text, opts = {}) {
  const program = compile(text, opts);
  const out = [];
  for (const n of program.stmts) if (!(n.view && n.view.cmd === 'set')) out.push(...viewOf(n));
  Object.defineProperty(out, 'program', { value: program, enumerable: false });
  Object.defineProperty(out, 'warnings', { value: program.warnings, enumerable: false });
  Object.defineProperty(out, 'loadErrors', { value: program.reg.failed.slice(), enumerable: false });
  return out;
}

// One line on its own: the action (or entry) it reads as, null for a blank or
// comment line; throws on a bad line. No %vars%.
function parseLine(raw) {
  const p = preprocess(String(raw == null ? '' : raw));
  if (!p.text) return null;
  return parseStmt(p.text, { reg: registry(), opts: {} }).view;
}

// Each line's standing for the console editor's colours, in the shape goals.js
// gives goals ({ n, status: ok|error|comment|blank, msg }), plus the errors as
// Apply lists them. A warning rides on an ok line's msg.
function lineStatus(text) {
  const src = String(text || '');
  const view = parse(src, { check: true });
  const errs = new Map();
  for (const a of view) {
    if (a.cmd !== 'error') continue;
    if (!errs.has(a.line)) errs.set(a.line, new Set());
    errs.get(a.line).add(a.error);
  }
  const warns = new Map();
  for (const w of view.warnings) if (!warns.has(w.line)) warns.set(w.line, w.warning);
  const lines = src.split(/\r?\n/).map((given, i) => {
    const n = i + 1;
    if (errs.has(n)) return { n, status: 'error', msg: [...errs.get(n)].join('; ') };
    const p = preprocess(given);
    if (p.blank) return { n, status: 'blank', msg: null };
    if (!p.text) return { n, status: 'comment', msg: null };
    return { n, status: 'ok', msg: warns.get(n) || null };
  });
  const errors = [...errs].flatMap(([line, set]) => [...set].map((error) => ({ line, error })));
  return { lines, errors, warnings: view.warnings.slice(), loadErrors: view.loadErrors };
}

// ---------------------------------------------------------------- executor

// The server sends a human-readable errorMsg on failure -- always show it.
const verdict = (r) => {
  if (!r) return 'no response';
  if (r.ok === 1) return 'ok';
  return `FAILED (ok=${r.ok})` + (r.errorMsg ? ` - ${r.errorMsg}` : ` ${JSON.stringify(r)}`);
};

const tick = () => new Promise((r) => setImmediate(r));

// Thrown to end the run from anywhere inside it.
class Halt { constructor(how) { this.how = how; } }

// A list of actions from elsewhere (not parse()'s): each entry one line.
function programFromActions(actions) {
  const reg = registry();
  const stmts = [];
  for (const a of actions) {
    const base = { line: a.line, src: a.raw, lineText: a.raw, usesVars: false };
    let node;
    if (a.cmd === 'error') node = { kind: 'error', error: a.error };
    else if (a.cmd === 'forever' || a.cmd === 'repeat') node = { kind: 'repeat', times: a.times || null };
    else if (a.cmd === 'echo') node = { kind: 'print', text: a.text };
    else if (a.cmd === 'sleep') node = { kind: 'sleep', ...a };
    else if (reg.cmds.has(a.cmd)) node = { kind: 'cmd', action: a, runner: reg.cmds.get(a.cmd) };
    else node = { kind: 'error', error: 'unknown command: ' + a.cmd };
    stmts.push(Object.assign(node, base));
  }
  return { stmts, labels: new Map(), functions: new Map(), reg, opts: {}, warnings: [], cache: new Map() };
}

function loadProvider(file, ctx, note) {
  let mod;
  try { mod = require(file); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(`'${file}'`)) return null;
    note(`${file.slice(2)}.js did not load (${e.message}) — its names read as undefined`);
    return null;
  }
  if (!mod || typeof mod.globals !== 'function') return null;
  try { return { globals: mod.globals(ctx), readOnly: mod.readOnly }; } catch (e) {
    note(`${file.slice(2)}.js did not start (${e.message}) — its names read as undefined`);
    return null;
  }
}

class Run {
  constructor(game, program, log, opts) {
    this.game = game;
    this.program = program;
    this.out = log;
    this.opts = opts;
    this.dryRun = !!opts.dryRun;
    this.done = 0;
    this.vars = new Map();
    // $error is null until a command fails, and again after one that worked (NEAT:
    // NewCityScript's `if $error == null goal $result`); the message after a failure
    this.specials = new Map([['$result', ''], ['$error', null]]);
    this.setVars = new Map();
    this.sentHeroes = new Map();
    this.moduleState = new Map();
    this.silent = 0;
    this.depth = 0;
    this.fnDepth = 0;
    this.last = null;           // the last line that did something: what `repeat` runs again
    this.stopLogged = false;
    this.scopes = new Map();
    this.refusals = new Map();  // refusalKey -> refusals in a row (see paceRefused)
    this.progIds = new WeakMap();
    this.progSeq = 0;
    const R = this;
    // game and castle follow a reconnect on every read, so a command that waited
    // (for the builder, a landing time) sends on the session's live Game
    this.ctx = {
      get game() { R.follow(); return R.game; },
      get castle() { R.follow(); return R.game.castle(R.opts.castle); },
      session: opts.session,
      opts,
      dryRun: this.dryRun,
      log: (m) => R.log(m),
      vars: this.vars,
      evaluate: async (src) => E.evaluate(E.parseExpression(String(src)), R.scopeNow || R.scopeFor(R.program)),
      call: async (fn, args) => E.callValue(fn, args || [], undefined, 'that', R.scopeNow || R.scopeFor(R.program)),
      busyHeroes: (id) => { const at = R.sentHeroes.get(id); return at !== undefined && Date.now() - at < 60000; },
      get mapSource() { return R.opts.mapSource; },
    };
    // the globals, in DESIGN order after the script's own names
    this.layers = [];
    this.readOnly = new Set();
    if (opts.globals) this.layers.push(opts.globals);
    for (const mod of program.reg.mods) {
      for (const n of mod.readOnly || []) this.readOnly.add(n);
      if (typeof mod.functions !== 'function') continue;
      try {
        const g = mod.functions(this.ctx);
        if (g) this.layers.push(g);
      } catch (e) { this.out(`note: a command module's functions did not start (${e.message}) — its names read as undefined`); }
    }
    for (const f of PROVIDERS) {
      const p = loadProvider(f, this.ctx, (m) => this.out('note: ' + m));
      if (!p) continue;
      this.layers.push(p.globals);
      for (const n of p.readOnly || []) this.readOnly.add(n);
    }
    this.layers.push(E.builtins());
  }

  log(m) { if (!this.silent) this.out(m); }
  stopped() { return !!(this.opts.shouldStop && this.opts.shouldStop()); }
  stopNow() {
    if (!this.stopLogged) { this.out('stopped — the rest of the script was not run'); this.stopLogged = true; }
    throw new Halt('stopped');
  }
  // opts.timeScale (tests): every wait (sleep, repeat gaps, a module's env.pause)
  // lasts that fraction of its time, so NEAT's own `sleep 300` lines can run as written
  async pause(ms) {
    const scale = Number(this.opts.timeScale) > 0 ? Number(this.opts.timeScale) : 1;
    const end = Date.now() + Math.max(0, Number(ms) || 0) * scale;
    // a wait timeScale shrinks under a millisecond still gives the event loop a
    // turn: a module polling for a push (a building landing) must let it arrive
    if (ms > 0 && Date.now() >= end) { await new Promise((r) => setImmediate(r)); return; }
    while (!this.stopped() && Date.now() < end) await new Promise((r) => setTimeout(r, Math.max(1, Math.min(250, end - Date.now()))));
  }
  // After a reconnect the session holds a new Game, and the one this run began
  // with talks to a closed socket. Take the session's while it is the same
  // player: the console can switch accounts under a running script.
  follow() {
    const s = this.opts.session;
    const who = (g) => ((g && g.player && g.player.playerInfo) || {}).userName;
    if (s && s.connected && s.game && s.game !== this.game && who(s.game) && who(s.game) === who(this.game)) this.game = s.game;
  }

  // One Scope per program: its own functions first, then the shared globals.
  scopeFor(program) {
    let s = this.scopes.get(program);
    if (s) return s;
    const fnLayer = {};
    for (const def of program.functions.values()) {
      fnLayer[def.name] = E.makeScriptFunction((args) => this.callFunction(program, def, args), { name: def.name, params: def.params });
    }
    s = new E.Scope({ vars: this.vars, specials: this.specials, layers: [fnLayer, ...this.layers], readOnly: this.readOnly });
    this.scopes.set(program, s);
    return s;
  }

  substVars(text, scope) {
    return String(text).replace(VAR_RE, (m, name) => {
      const v = this.setVars.get(name.toLowerCase());
      if (v !== undefined) return v;
      const r = scope.lookupVar(name);
      if (r.found) return E.toStr(r.value);
      throw new Error(`%${name}% is not set — put  set ${name} <value>  above this line`);
    });
  }

  // A line made while running (execute, a %var% that changed): parsed once per text.
  compileRuntime(program, text, proto) {
    const key = text;
    let node = program.cache.get(key);
    if (!node) {
      try {
        node = parseStmt(text, { reg: program.reg, opts: program.opts, runtime: true });
        let bad = null;
        forEachNode(node, (x) => { if (['label', 'function', 'endfunction', 'endloop'].includes(x.kind)) bad = x.kind; });
        if (bad) throw new Error(`a ${bad} cannot be made while the script runs`);
        if (node.kind === 'loop' && !node.label) node.block = false;
      } catch (e) { node = { kind: 'error', error: e.message }; }
      if (program.cache.size > 500) program.cache.clear();
      program.cache.set(key, node);
    }
    return Object.assign(Object.create(node), { line: proto.line, silent: proto.silent, lineText: text, inFn: proto.inFn });
  }

  jumpTarget(name, frame) {
    const pc = frame.program.labels.get(name);
    if (pc === undefined) throw new Error(`there is no label "${name}"`);
    const target = frame.program.stmts[pc];
    if ((target.inFn || null) !== (frame.fn || null)) throw new Error(`label ${name} is on the other side of a function's edge`);
    return pc;
  }

  // meta: { line, raw, silent, round, of } — the line a node runs for (an if's
  // inner command, an executed line, a repeat round) and how to show it.
  header(meta) {
    const r = !meta.round ? ''
      : meta.of ? ` (${REPEAT_COUNTS_TOTAL ? 'run' : 'repeat'} ${meta.round} of ${meta.of})`
        : ` (repeat ${meta.round}, until it fails or Stop)`;
    this.log(`line ${meta.line}: ${meta.raw}${r}`);
    meta.logged = true;
  }
  remember(node, frame, meta, ok) {
    this.last = { node, frame, raw: meta.raw, silent: meta.silent, line: meta.line, ok };
  }

  async execRange(frame, pc, end) {
    while (pc < end) {
      if (this.stopped()) this.stopNow();
      await tick();
      this.follow();
      const r = await this.stepTop(frame.program.stmts[pc], frame, pc);
      if (r.ret) return r;
      pc = r.next;
    }
    return { fell: true };
  }

  async stepTop(node, frame, pc) {
    if (typeof this.opts.trace === 'function') this.opts.trace(node.line, frame.program === this.program);
    let n = node;
    const meta = { line: node.line, raw: node.lineText || node.src, silent: node.silent };
    if (node.usesVars) {
      let text;
      try { text = this.substVars(node.src, frame.scope); } catch (e) {
        return this.failed(node, e, meta, frame, pc);
      }
      if (text !== node.lineText) { n = this.compileRuntime(frame.program, text, node); meta.raw = text; }
    }
    return this.step(n, frame, pc, meta);
  }

  failed(node, e, meta, frame, pc) {
    const msg = e && e.message ? e.message : String(e);
    if (meta.silent) this.silent++;
    if (!meta.logged) this.header(meta);
    this.log('  FAILED: ' + msg);
    if (meta.silent) this.silent--;
    this.specials.set('$error', msg);
    if (ACTIONS.has(node.kind) || node.kind === 'if') this.remember(node, frame, meta, false);
    if (this.opts.stopOnError) throw new Halt('error');
    return { next: pc + 1 };
  }

  async step(node, frame, pc, meta) {
    if (meta.silent) this.silent++;
    const outer = this.scopeNow;
    this.scopeNow = frame.scope;          // what ctx.evaluate reads names from
    let out;
    try {
      out = await this.stepInner(node, frame, pc, meta);
    } catch (e) {
      if (meta.silent) this.silent--;
      this.scopeNow = outer;
      if (e instanceof Halt) throw e;
      return this.failed(node, e, meta, frame, pc);
    }
    if (meta.silent) this.silent--;
    this.scopeNow = outer;
    return out;
  }

  // guards: the conditions of the ifs around this node (`if !x repeat`): a repeat
  // there checks them again before each round, as NEAT's goes back a line and
  // reads the if again (MapFunctions: `if data == null repeat`).
  async stepInner(node, frame, pc, meta, guards = null) {
    const next = { next: pc + 1 };
    const scope = frame.scope;
    switch (node.kind) {
      case 'error':
        this.log(`line ${meta.line}: PARSE ERROR — ${node.error}`);
        this.specials.set('$error', node.error);
        return next;
      case 'label': return next;
      case 'function': return { next: node.skipTo };
      case 'endfunction': return frame.fn ? { ret: true, value: undefined } : next;
      case 'set': this.setVars.set(node.name, node.value); return next;
      case 'goto': return { next: this.jumpTarget(node.label, frame) };
      case 'gosub': {
        const to = this.jumpTarget(node.label, frame);
        if (frame.gosub.length >= 1000) throw new Error('gosub inside gosub more than 1000 deep — a subroutine is missing its return');
        frame.gosub.push(pc + 1);
        return { next: to };
      }
      case 'return':
        if (frame.gosub.length) return { next: frame.gosub.pop() };
        return { ret: true, value: node.expr ? await E.evaluate(node.expr, scope) : undefined };
      case 'if':
        if (E.truthy(await E.evaluate(node.cond, scope))) return this.stepInner(node.then, frame, pc, meta, [...(guards || []), node.cond]);
        return next;
      case 'loop': return this.loop(node, frame, pc, meta);
      case 'endloop': return this.endloop(node, frame, pc, meta);
      case 'repeat': return this.repeat(node, frame, pc, meta, guards);
      case 'end': throw new Halt('end');
      case 'exit':
        this.log(`line ${meta.line}: exit — the script ends here (the console stays on)`);
        throw new Halt('end');
      case 'stop': return this.pauseAt(frame, pc, meta);
      case 'die': {
        const msg = await this.listText(node.items, node.text, scope);
        this.log(`line ${meta.line}: die — ${msg}`);
        this.specials.set('$error', msg || 'died');
        throw new Halt('die');
      }
      case 'echo': case 'print': {
        this.header(meta);
        const text = node.kind === 'print' ? node.text : await this.listText(node.items, node.text, scope);
        for (const l of String(text).split('\n')) this.log('  ' + l);
        this.remember(node, frame, meta, true);
        return next;
      }
      case 'sleep': {
        this.header(meta);
        if (node.until) {
          const at = W.nextOccurrence(node.until, this.game.now());
          this.log(`  until ${new Date(at).toLocaleTimeString()} on this machine's clock`);
          await this.pause(at - this.game.now());
        } else if (node.rnd) {
          const [lo, hi] = node.rnd;
          const s = lo + Math.random() * (hi - lo);
          this.log(`  ${Math.round(s)}s (a random wait of ${lo}-${hi}s)`);
          await this.pause(s * 1000);
        } else await this.pause(node.seconds * 1000);
        this.remember(node, frame, meta, true);
        return next;
      }
      case 'assign': case 'expr':
        await E.evaluate(node.ast, scope);
        this.remember(node, frame, meta, true);
        return next;
      case 'execute': return this.execute(node, frame, pc, meta);
      case 'call': return this.callScript(node, frame, pc, meta);
      case 'command': return this.inlineCommand(node, frame, pc, meta);
      case 'callfunc': {
        const def = frame.program.functions.get(node.name.toLowerCase());
        if (!def) throw new Error(`there is no function ${node.name}`);
        const args = [];
        for (const a of node.call.args) args.push(await E.evaluate(a, scope));
        const value = await this.callFunction(frame.program, def, args);
        this.specials.set('$result', value);
        this.remember(node, frame, meta, true);
        return next;
      }
      case 'cmd': return this.command(node, frame, pc, meta);
      case 'goal': return this.goal(node, frame, pc, meta);
      case 'goalmod': {
        // a bare goal line a module's goalLines took (script-cmd-goals.js)
        this.header(meta);
        const a = { ...node.action, line: meta.line, raw: meta.raw };
        await this.runModule(node.runner, a, node, frame, meta, (env) => node.runner.spec.run(a, env));
        return next;
      }
      case 'dynamic': throw new Error('this line could not be read');
      default: throw new Error('cannot run a ' + node.kind);
    }
  }

  // echo's items: a bare word nothing defines prints as written.
  async listText(items, text, scope) {
    if (!items) return text;
    const out = [];
    for (const it of items) {
      if (it.type === 'id' && !it.paren && !scope.lookup(it.name).found) { out.push(it.name); continue; }
      out.push(E.toStr(await E.evaluate(it, scope)));
    }
    return out.join(' ');
  }

  loop(node, frame, pc, meta) {
    if (node.block) { frame.loops.set(pc, 1); return { next: pc + 1 }; }
    const target = node.label ? this.jumpTarget(node.label, frame) : (frame.fn ? frame.fn.bodyStart : 0);
    if (node.times === null) {
      if (this.dryRun) {
        this.log(`line ${meta.line}: loop — [dry run] would go back to ${node.label ? 'label ' + node.label : 'the top'} and run it again until you press Stop`);
        return { next: pc + 1 };
      }
      return { next: target };
    }
    const c = frame.loops.get(pc) || 1;
    if (c < node.times) { frame.loops.set(pc, c + 1); return { next: target }; }
    frame.loops.delete(pc);
    return { next: pc + 1 };
  }

  endloop(node, frame, pc, meta) {
    const at = node.loopPc;
    const head = frame.program.stmts[at];
    if (head.times === null) {
      if (this.dryRun) {
        this.log(`line ${meta.line}: endloop — [dry run] would go back to line ${head.line} again until you press Stop`);
        frame.loops.delete(at);
        return { next: pc + 1 };
      }
      return { next: at + 1 };
    }
    const c = frame.loops.get(at) || 1;
    if (c < head.times) { frame.loops.set(at, c + 1); return { next: at + 1 }; }
    frame.loops.delete(at);
    return { next: pc + 1 };
  }

  // `repeat N` runs the last line that did something again until it has run N
  // times in all (see REPEAT_COUNTS_TOTAL), whatever each round gets back; a
  // bare `repeat` or `repeat 0` keeps going while it goes through. Under an if
  // (guards), each round after the first reads the if again and ends when it no
  // longer holds: `x = GetDetailInfo(id) / if !x repeat` waits for the detail.
  async repeat(node, frame, pc, meta, guards = null) {
    const last = this.last;
    if (!last) throw new Error('repeat: nothing has run yet to repeat');
    const n = last.line;
    const again = async (round, of) => {
      await this.step(last.node, last.frame, pc, { line: last.line, raw: last.raw, silent: last.silent, round, of });
    };
    const holds = async () => {
      for (const c of guards || []) if (!E.truthy(await E.evaluate(c, frame.scope))) return false;
      return true;
    };
    if (node.times === null) {
      if (this.dryRun) {
        this.log(`line ${meta.line}: repeat — [dry run] would run line ${n} again until it fails${guards ? ', its if no longer holds,' : ''} or you press Stop`);
        return { next: pc + 1 };
      }
      for (let round = 1; ; round++) {
        if (!this.last.ok) { this.log(`line ${meta.line}: repeat ends — line ${n} did not go through`); return { next: pc + 1 }; }
        if (this.stopped()) this.stopNow();
        // A line that never waits on the server (echo) would otherwise spin here
        // without yielding, and Stop could never get through.
        await tick();
        await this.pause(this.opts.repeatGapMs ?? 200);
        if (this.stopped()) this.stopNow();
        if (round > 1 && !(await holds())) return { next: pc + 1 };
        this.follow();
        await again(round, null);
      }
    }
    // rounds are numbered as runs of the line: 2 of 3, 3 of 3 (the line itself was 1)
    const first = REPEAT_COUNTS_TOTAL ? 2 : 1;
    for (let i = first; i <= node.times; i++) {
      if (this.stopped()) this.stopNow();
      await tick();
      if (i > first && !(await holds())) break;
      this.follow();
      await again(i, node.times);
    }
    return { next: pc + 1 };
  }

  async pauseAt(frame, pc, meta) {
    const nextLine = (frame.program.stmts[pc + 1] || {}).line;
    if (typeof this.opts.onPause !== 'function') {
      this.log(`line ${meta.line}: stop — this run cannot be paused and resumed, so the script ends here`);
      throw new Halt('end');
    }
    this.log(`line ${meta.line}: stop — paused; resume to carry on${nextLine ? ' from line ' + nextLine : ''}`);
    let settled = false, answer;
    const p = Promise.resolve(this.opts.onPause({ line: meta.line, next: nextLine })).then((v) => { settled = true; answer = v; },
      (e) => { settled = true; answer = false; this.log('  resume failed: ' + e.message); });
    while (!settled) {
      if (this.stopped()) this.stopNow();
      await Promise.race([p, new Promise((r) => setTimeout(r, 250))]);
    }
    if (answer === false) { this.log('  not resumed — the script ends here'); throw new Halt('end'); }
    this.log('  resumed');
    return { next: pc + 1 };
  }

  makeEnv(mod, meta, captured, flags, scope) {
    const R = this;
    const sc = scope || R.scopeFor(R.program);
    if (!this.moduleState.has(mod)) this.moduleState.set(mod, {});
    return {
      get game() { R.follow(); return R.game; },
      get castle() { R.follow(); return R.game.castle(R.opts.castle); },
      get cid() { R.follow(); return R.game.castleId(R.game.castle(R.opts.castle)); },
      session: R.opts.session,
      opts: R.opts,
      dryRun: R.dryRun,
      ctx: R.ctx,
      line: meta.line,
      log: (m) => { captured.push(String(m).replace(/^ {2}/, '')); R.log(m); },
      say: (r) => { const v = verdict(r); if (!r || r.ok !== 1) { flags.refused = true; flags.bad = v; } return v; },
      verdict,
      refused: () => flags.refused,
      stopped: () => R.stopped(),
      pause: (ms) => R.pause(ms),
      follow: () => R.follow(),
      state: R.moduleState.get(mod),
      sentHeroes: R.sentHeroes,
      registry: () => R.registryInfo(),
      // in the scope of the line's own frame: a function's arguments, a called script's names
      evaluate: async (src) => E.evaluate(E.parseExpression(String(src)), sc),
      echoText: async (src) => {
        let items = null;
        try { items = E.parseList(String(src)); } catch { /* printed as written */ }
        return R.listText(items, String(src), sc);
      },
    };
  }

  // The commands this run knows, as plain data: what starts each line.
  registryInfo() {
    if (this.regInfo) return this.regInfo;
    const reg = this.program.reg;
    const wordsOf = (table, name) => [...table].filter(([, e]) => e.name === name).map(([w]) => w);
    const commands = [...reg.cmds.values()].map(({ name, spec }) => Object.freeze({
      name, usage: spec.usage || '', words: Object.freeze(wordsOf(reg.words, name)), aliases: Object.freeze([...(spec.aliases || [])]),
    }));
    const seen = new Set();
    const inline = [];
    for (const [, e] of reg.inline) {
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      inline.push(Object.freeze({ name: e.name, usage: e.spec.usage || '', words: Object.freeze(wordsOf(reg.inline, e.name)) }));
    }
    this.regInfo = Object.freeze({ commands: Object.freeze(commands), inline: Object.freeze(inline), keywords: Object.freeze([...KEYWORDS]) });
    return this.regInfo;
  }

  // A line the server refuses, run again and again by a goto, loop or repeat,
  // would send as fast as the server answers (a review measured 57,933 refused
  // writes a second). So a line that failed last time waits opts.repeatGapMs
  // (200 ms) before it runs again, and its MAX_REFUSALS-th refusal in a row
  // ends the run. Refused: the line failed after the server said no (say()
  // saw a refusal), after it sent something (done), or when the command says
  // so itself (refused: true — buyitem past the run's limit). A failure that
  // sent nothing is only paced. A line that goes through starts over. The same
  // line: same script, line number and text.
  refusalKey(frame, meta) {
    let id = this.progIds.get(frame.program);
    if (id === undefined) { id = ++this.progSeq; this.progIds.set(frame.program, id); }
    return `${id}:${meta.line}:${meta.raw}`;
  }
  async paceRefused(key) {
    if (!this.refusals.has(key)) return;
    const gap = Number(this.opts.repeatGapMs ?? 200);
    if (gap > 0) await this.pause(gap);
    if (this.stopped()) this.stopNow();
  }
  countRefusal(key, meta, refused, ok) {
    if (ok) { this.refusals.delete(key); return; }
    if (this.refusals.size > 500) this.refusals.clear();
    const n = (this.refusals.get(key) || 0) + (refused ? 1 : 0);
    this.refusals.set(key, n);
    if (n >= MAX_REFUSALS) {
      this.out(`line ${meta.line} was refused ${MAX_REFUSALS} times in a row — stopped`);
      throw new Halt('refused');
    }
  }

  // A module's command, or an in-line one: $result and $error after it.
  async runModule(runner, action, node, frame, meta, how) {
    const captured = [], flags = { refused: false, bad: null };
    const env = this.makeEnv(runner.mod, meta, captured, flags, frame.scope);
    const key = this.refusalKey(frame, meta);
    await this.paceRefused(key);
    let res;
    try {
      res = (await how(env)) || {};
    } catch (e) {
      this.log('  FAILED: ' + e.message);
      this.specials.set('$error', e.message);
      this.remember(node, frame, meta, false);
      this.countRefusal(key, meta, flags.refused, false);
      if (this.opts.stopOnError) throw new Halt('error');
      return;
    }
    this.done += Number(res.done) || 0;
    const ok = res.ok !== undefined ? !!res.ok : !flags.refused;
    this.specials.set('$error', ok ? null : String(res.error || flags.bad || 'failed'));
    this.specials.set('$result', res.result !== undefined ? res.result : captured.join('\n'));
    this.remember(node, frame, meta, ok);
    this.countRefusal(key, meta, !ok && (flags.refused || Number(res.done) > 0 || res.refused === true), ok);
    if (res.end) throw new Halt('end');
  }

  async command(node, frame, pc, meta) {
    let { action, runner } = node;
    if (node.deferred) {
      // {expr} in the arguments, or a command that reads them late
      const text = await E.fillText(node.text, frame.scope);
      meta.raw = text;
      const word = (/^[A-Za-z_$][\w$]*/.exec(text) || [''])[0].toLowerCase();
      const ent = frame.program.reg.words.get(word);
      if (!ent) throw unknownCommand(word, frame.program.reg);
      ({ action, runner } = parseCommand(ent, word, text, text.slice(word.length).trim(), frame.program.reg));
    }
    this.header(meta);
    const a = { ...action, line: meta.line, raw: meta.raw };
    await this.runModule(runner, a, node, frame, meta, (env) => runner.spec.run(a, env));
    return { next: pc + 1 };
  }

  async inlineCommand(node, frame, pc, meta) {
    const text = E.toStr(await E.evaluate(node.expr, frame.scope)).trim().replace(/^\\/, '');
    meta.raw = `command "${text}"`;
    this.header(meta);
    const word = (text.split(/\s+/)[0] || '').toLowerCase();
    const ent = frame.program.reg.inline.get(word);
    if (!ent) {
      const known = [...frame.program.reg.inline.keys()];
      const msg = `there is no in-line command "${word}"${known.length ? ' — there are: ' + known.join(', ') : ' yet'}`;
      this.log('  ' + msg);
      this.specials.set('$error', msg);
      this.specials.set('$result', '');
      this.remember(node, frame, meta, false);
      return { next: pc + 1 };
    }
    await this.runModule(ent, null, node, frame, meta, (env) => ent.spec.run(text.slice(word.length).trim(), env));
    return { next: pc + 1 };
  }

  async goal(node, frame, pc, meta) {
    this.header(meta);
    if (typeof this.opts.applyGoalLine !== 'function') throw new Error('goal lines cannot be set from this run');
    const captured = [], flags = { refused: false, bad: null };
    const env = this.makeEnv('goals', meta, captured, flags, frame.scope);
    const r = await this.opts.applyGoalLine(node.text, node.goal, env);
    const ok = !(r && r.ok === false);
    if (typeof r === 'string') this.log('  ' + r);
    this.specials.set('$error', ok ? null : String((r && r.error) || 'failed'));
    this.remember(node, frame, meta, ok);
    return { next: pc + 1 };
  }

  async execute(node, frame, pc, meta) {
    const text = E.toStr(await E.evaluate(node.expr, frame.scope));
    for (const raw of executeLines(text)) {
      const p = preprocess(raw);
      if (!p.text) continue;
      const inner = this.compileRuntime(frame.program, p.text, { line: node.line, silent: node.silent || p.silent, inFn: node.inFn });
      const r = await this.step(inner, frame, pc, { line: meta.line, raw: p.text, silent: meta.silent || p.silent });
      if (r.ret || r.next !== pc + 1) return r;
    }
    return { next: pc + 1 };
  }

  async callScript(node, frame, pc, meta) {
    let name;
    if (node.bare && !frame.scope.lookup(node.bare).found) name = node.bare;
    else name = E.toStr(await E.evaluate(node.expr, frame.scope));
    meta.raw = `call ${name}`;
    this.header(meta);
    if (typeof this.opts.loadScript !== 'function') {
      throw new Error('this run cannot load other scripts — call runs a loadout from the console');
    }
    if (this.depth >= 20) throw new Error('scripts calling scripts more than 20 deep');
    const text = await this.opts.loadScript(name);
    if (text === null || text === undefined) throw new Error(`there is no script "${name}" to call`);
    const view = parse(String(text), { ...this.program.opts, knownVars: [...this.vars.keys()] });
    const errs = view.filter((a) => a.cmd === 'error');
    if (errs.length) throw new Error(`${name} line ${errs[0].line}: ${errs[0].error}${errs.length > 1 ? ` (and ${errs.length - 1} more)` : ''}`);
    const prog = view.program;
    const saved = this.setVars;
    this.setVars = new Map();      // %vars% are not passed; true variables are
    this.depth++;
    let r;
    try {
      r = await this.execRange({ program: prog, scope: this.scopeFor(prog), gosub: [], loops: new Map(), fn: null }, 0, prog.stmts.length);
    } finally { this.setVars = saved; this.depth--; }
    this.specials.set('$result', r && r.ret ? r.value : undefined);
    this.specials.set('$error', null);
    this.remember(node, frame, meta, true);
    return { next: pc + 1 };
  }

  async callFunction(program, def, args) {
    if (this.fnDepth >= 200) throw new Error(`${def.name}: functions calling functions more than 200 deep`);
    const scope = this.scopeFor(program).child(new Map(def.params.map((p, i) => [p, args[i]])));
    this.fnDepth++;
    try {
      const r = await this.execRange({ program, scope, gosub: [], loops: new Map(), fn: def }, def.bodyStart, def.bodyEnd);
      return r.ret ? r.value : undefined;
    } finally { this.fnDepth--; }
  }

  startPc() {
    const P = this.program;
    const s = this.opts.startLine;
    if (s === undefined || s === null || s === '' || s === 0 || s === '0') return 0;
    if (typeof s === 'number' || /^\d+$/.test(String(s))) {
      const n = Number(s);
      const pc = P.stmts.findIndex((st) => st.line >= n);
      if (pc === -1) { this.out(`line ${n} is past the end of the script — starting at line 1`); return 0; }
      return pc;
    }
    const pc = P.labels.get(String(s).toLowerCase());
    if (pc === undefined) { this.out(`there is no label ${s} — starting at line 1`); return 0; }
    return pc;
  }

  async go() {
    const P = this.program;
    const frame = { program: P, scope: this.scopeFor(P), gosub: [], loops: new Map(), fn: null };
    try {
      await this.execRange(frame, this.startPc(), P.stmts.length);
    } catch (e) {
      if (!(e instanceof Halt)) throw e;
    }
    return this.done;
  }
}

// opts.shouldStop() is polled between lines and during waits; once it says yes
// the run ends where it is. It is the only way an endless `repeat` or `loop`
// ends while its line keeps going through.
async function run(game, actions, log, opts = {}) {
  const program = (actions && actions.program) || programFromActions(actions || []);
  return new Run(game, program, log, opts).go();
}

module.exports = {
  parse, parseLine, lineStatus, run, verdict,
  parseTroops: W.parseTroops, parseResources: W.parseResources, parseLandTime: W.parseLandTime,
  parseDuration: W.parseDuration, nextOccurrence: W.nextOccurrence,
};
