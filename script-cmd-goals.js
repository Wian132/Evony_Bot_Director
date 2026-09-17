'use strict';
// Goal lines in scripts (the command-module contract is at the top of script.js).
// NEAT: "Any goal can be used in the script window" (wiki Scr1ptingForDummies, Goal).
//
//   config npc:5,comfort:1             config switches (wiki Config)
//   troop a:5000 | fortification ab:1k | comfortpolicy 15 16 popraise | hiding 2 ...
//                                      any goal line on its own: its first word is a goal
//                                      and no script command
//   goal config npc:5                  any goal line, said explicitly (wiki Goal)
//   goal build c:10:9                  (city's build/research send `build c:10:9`, `build ?w:10?q:0:0`
//                                      and `research lo:5` here too; build cottage stays a command)
//   goal $result                       an expression: every line of its text is a goal line
//                                      (NewCityScript: @get "NewCityGoals.txt" / if $error == null goal $result)
//   buildinggoals st:0:0,b:9:12        = goal build st:0:0,b:9:12 (wiki BuildingGoals)
//   techgoals ar:10,ho:10,mt:9         = goal research ...; OTTObot has no research goal yet, so
//                                      this fails with the goals' reason (wiki TechGoals: deprecated)
//   loadgoals 3 | loadgoals Fla | loadgoals 12345
//                                      goal set 3 (the console's "Goal set 3"), or that city's saved
//                                      goals, in place of this city's goals, global ones too (wiki LoadGoals)
//   loadgoals | loadgoals 0            back to the city's saved goals: the script's goals end
//   resetgoals                         no goals at all in this city; goal lines set after it build
//                                      a fresh set (wiki ResetGoals)
//
// They change the goals the engine RUNS in the run's city, never the saved ones:
// the goal layer (goallayers.js, the goals update) keeps a script layer per
// account and city in memory. It holds until a script changes it again, the
// city's goals are saved, "Clear script goals", or a restart (wiki Config).
// $result = the layer: { base: 'saved'|'loaded'|'reset', count, loaded, lines }
// (echo $result prints a summary); $error = what the goals could not take (none
// when all of it went in). A line the goals could not use at all is an error too.
// A dry run says what it would set and sets nothing.
//
// run() opts: goalLayers   the goal-layer module to use (tests); false = none.
// Without goallayers.js every goal line fails, clearly, and the script goes on.
// Also exported: goalAction(text, via) for another module's parse that reads a
// line as a goal (city's `build c:10:9`), and goalFile(name, env) for `get`
// ("NewCityGoals.txt" and the other goal files = the account's goal texts).
const E = require('./script-expr');

const MISSING = 'goal lines in scripts need the goals update (goals/integration)';

// ------------------------------------------------------------------ load time

// goals.js's parser: which words are goals, and a line's errors. The goals
// update brings a newer one; null when it cannot load (then nothing is checked).
let GOALS_MOD;
function goalsMod() {
  if (GOALS_MOD === undefined) { try { GOALS_MOD = require('./goals'); } catch { GOALS_MOD = null; } }
  return GOALS_MOD;
}
const firstWord = (text) => (String(text).trim().split(/\s+/)[0] || '').toLowerCase();
const isGoalWord = (w) => {
  const G = goalsMod();
  return !!(G && G.GOALS && Object.prototype.hasOwnProperty.call(G.GOALS, w));
};
// Goals NEAT has that the goals side is still adding: let through here, and the
// goal layer says when it runs whether it can take them.
const COMING = new Set(['research']);

// A goal line as written -> the reasons it cannot be read ([] when it reads,
// or cannot be checked here).
function goalErrors(text) {
  const G = goalsMod();
  if (!G || typeof G.parseGoals !== 'function') return [];
  const w = firstWord(text);
  if (!isGoalWord(w)) return COMING.has(w) ? [] : [`"${w}" is not a goal`];
  let p;
  try { p = G.parseGoals(text); } catch (e) { return [e.message]; }
  return (p.errors || []).map((e) => e.error);
}

// A goal line -> its action; a goal line that cannot be read refuses the script
// before it runs, as any command's bad arguments do. Another module may route a
// line here (NEAT's `build c:10:9` is the build goal): require this module and
// return goalAction('build ' + args, 'build') from its parse.
function goalAction(text, via = 'goal', cmd = 'goal') {
  const t = String(text).trim();
  let errs = goalErrors(t);
  // `config: CONFIG: ...` says it twice; a bare line keeps what it was read as
  if (via !== 'line' && via !== 'goal') errs = errs.map((e) => e.replace(/^[A-Z]+: /, ''));
  if (errs.length) throw new Error(`${via === 'line' ? 'goal line' : via}: ${errs.join('; ')}`);
  return { cmd, text: t, via };
}

// A bare goal line holding {expr}: filled when it runs, as a "..." text is.
const quoted = (t) => '"' + String(t).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

const usage = (word, u, eg) => new Error(`${word}: usage  ${u}${eg ? '   e.g. ' + eg : ''}`);

// ------------------------------------------------------------------ run time

// The goal layer: opts.goalLayers, else goallayers.js, each function looked for
// when a goal line runs.
function goalLayers(env, need) {
  let GL = env.opts ? env.opts.goalLayers : undefined;
  if (GL === false || GL === null) throw new Error(MISSING);
  if (GL === undefined) {
    try { GL = require('./goallayers'); } catch (e) {
      if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes("'./goallayers'")) throw new Error(MISSING);
      throw new Error(`goallayers.js did not load (${String(e.message).split('\n')[0]}) — goal lines cannot run`);
    }
  }
  if (!GL || typeof GL[need] !== 'function') throw new Error(`${MISSING} — this goallayers.js has no ${need}()`);
  return GL;
}

function accountOf(env) {
  const o = (env && env.opts) || {};
  const s = env && env.session;
  return (o.accountId !== undefined ? o.accountId : (s && s.account && s.account.id)) ?? null;
}

// The account and city a run's goal lines belong to: the engine reads the
// layer of the same pair.
function place(env) {
  const o = env.opts || {};
  const accountId = accountOf(env);
  let castleId = null;
  try { castleId = env.cid; } catch { /* no city loaded */ }
  if (castleId === null || castleId === undefined) castleId = o.cityId ?? null;
  if (castleId === null || castleId === undefined) throw new Error('goal lines need the run\'s city, and this run has none');
  return { accountId: accountId ?? null, castleId };
}

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
function describeLayer(l) {
  if (!l) return 'no script goals: the city runs its saved goals';
  const n = plural(l.count || 0, 'script goal line');
  if (l.base === 'reset') return `goals reset: only the ${n} set since run`;
  if (l.base === 'loaded') return `running ${l.loaded || 'a goal set'} in place of the saved goals${l.count ? `, with ${n} on top` : ''}`;
  return `${n} on top of the saved goals`;
}
// $result: the layer as plain data; `echo $result` prints the summary.
function layerResult(l, extra = {}) {
  const res = {
    base: l ? l.base || 'saved' : 'saved', count: l ? l.count || 0 : 0, loaded: (l && l.loaded) || null,
    lines: l && l.src ? String(l.src).split('\n').filter((x) => x.trim()) : [], ...extra,
  };
  Object.defineProperty(res, 'toString', { value: () => describeLayer(l), enumerable: false });
  return res;
}
const layerNow = (GL, p) => (GL && typeof GL.getScriptLayer === 'function' ? GL.getScriptLayer(p.accountId, p.castleId) : null);

// One goal-layer answer -> the error texts, and the notes goals.js puts on lines
// that read but do nothing yet (status idle) or were read differently from how
// they were written (`hiding 2` is config hiding:2). A line the layer left out
// is said to be.
function readAnswer(r) {
  const errors = [], notes = [];
  if (!r) return { errors: ['the goal layer gave no answer'], notes };
  if (r.error) return { errors: [r.error], notes };
  for (const e of r.errors || []) {
    const own = !e.source || e.source === 'script';
    errors.push(`${!own && e.where ? e.where + ': ' : ''}${e.error}${e.where === 'script, not added' ? ' (not added)' : ''}`);
  }
  for (const l of r.lines || []) if (l && (l.status === 'idle' || l.status === 'ok') && l.msg) notes.push(l.msg);
  return { errors, notes };
}

// The lines of a goal action: as written, or an expression's text, one goal
// line per line (a list: one per item). Blank and comment lines are no goals.
async function linesOf(a, env) {
  let texts;
  if (a.expr !== undefined) {
    const v = await env.ctx.evaluate(a.expr);
    if (v === undefined || v === null) throw new Error(`goal ${a.expr}: that is ${v === null ? 'null' : 'undefined'}, so there are no goal lines in it`);
    texts = Array.isArray(v) ? v.map((x) => (x === null || x === undefined ? '' : E.toStr(x))) : [E.toStr(v)];
  } else texts = [String(a.text)];
  return texts.flatMap((t) => t.split(/\r?\n/)).map((l) => l.trim()).filter((l) => l && !/^(\/\/|#)/.test(l));
}

// goal / config / buildinggoals / techgoals / a goal line on its own.
async function runGoal(a, env) {
  const lines = await linesOf(a, env);
  if (!lines.length) {
    env.log('  nothing to set — no goal lines in it');
    return { ok: true, result: layerResult(null) };
  }
  const GL = goalLayers(env, 'addScriptLine');
  const p = place(env);
  const many = lines.length > 1;
  if (env.dryRun) {
    for (const l of lines) env.log(`  [dry run] would add to this city's script goals: ${l}`);
    env.log('  [dry run] not set');
    return {};
  }
  const max = Number(GL.SCRIPT_MAX_LINES) || 1000;
  if (lines.length > max) {
    const msg = `${lines.length} goal lines — the script goal layer holds ${max} at most`;
    env.log('  -> FAILED - ' + msg);
    return { ok: false, error: msg, result: layerResult(layerNow(GL, p)) };
  }
  const errors = [];
  let layer, noResearch = false;
  for (const l of lines) {
    if (many) env.log('  + ' + l);
    const r = GL.addScriptLine(p.accountId, p.castleId, l);
    const got = readAnswer(r);
    for (const n of got.notes) env.log(`  ${many ? '  ' : ''}note: ${n}`);
    for (const e of got.errors) {
      env.log(`  ${many ? '  ' : '-> '}FAILED - ${e}`);
      errors.push(many ? `"${l}": ${e}` : e);
    }
    if (got.errors.length && firstWord(l) === 'research' && !isGoalWord('research')) noResearch = true;
    if (r && r.layer !== undefined) layer = r.layer;
    if (!r || r.error) break;                 // the layer is full: the rest cannot go in either
  }
  if (layer === undefined) layer = layerNow(GL, p);
  if (!errors.length) env.log('  -> ok — ' + describeLayer(layer));
  else if (layer) env.log('  ' + describeLayer(layer));
  let error = errors.join('; ');
  if (noResearch) {
    // techgoals, goal research ..., and city's `research lo:5` (NEAT's research goal)
    const why = 'OTTObot has no research goal yet — research <tech> (no level) researches it now';
    env.log('  ' + why);
    error += ` (${why})`;
  }
  return { ok: !errors.length, error, result: layerResult(layer) };
}

const commands = {
  goal: {
    usage: 'goal <goal line> | goal <expression whose text holds goal lines>',
    parse(args) {
      const rest = String(args).trim();
      if (!rest) throw usage('goal', 'goal <goal line>', 'goal config npc:5 | goal build c:10:9 | goal $result');
      const w = firstWord(rest);
      if (isGoalWord(w) || COMING.has(w)) return goalAction(rest, 'goal');
      try { E.parseExpression(rest); } catch {
        if (!goalsMod()) return { cmd: 'goal', text: rest, via: 'goal' };   // cannot tell: the goal layer will
        throw new Error(`goal: "${w}" is not a goal — write a goal line after it (goal config npc:5, goal build c:10:9), `
          + 'or an expression whose text holds goal lines (goal $result)');
      }
      return { cmd: 'goal', expr: rest, via: 'goal' };
    },
    run: runGoal,
  },

  config: {
    usage: 'config <key>:<value>[,<key>:<value>...]',
    parse(args) {
      if (!String(args).trim()) throw usage('config', 'config <key>:<value>[,<key>:<value>]', 'config npc:5,comfort:1');
      return goalAction('config ' + String(args).trim(), 'config', 'config');
    },
    run: runGoal,
  },

  buildinggoals: {
    usage: 'buildinggoals <build goal>',
    parse(args) {
      if (!String(args).trim()) throw usage('buildinggoals', 'buildinggoals <type>:<level>[:<quantity>][,...]', 'buildinggoals st:0:0,b:9:12');
      return goalAction('build ' + String(args).trim(), 'buildinggoals', 'buildinggoals');
    },
    run: runGoal,
  },

  // Deprecated in NEAT (`research` in a script edits the research goals now).
  // OTTObot has no research goal yet: the goal layer says so when it runs.
  techgoals: {
    usage: 'techgoals <research goal>',
    parse(args) {
      if (!String(args).trim()) throw usage('techgoals', 'techgoals <tech>:<level>[,...]', 'techgoals ar:10,ho:10,mt:9');
      return goalAction('research ' + String(args).trim(), 'techgoals', 'techgoals');
    },
    run: runGoal,
  },

  loadgoals: {
    usage: 'loadgoals [goal set 1-9 | city name | castle id]   (none or 0: back to the saved goals)',
    parse(args) {
      let which = String(args).trim();
      const q = /^"([^"]*)"$|^'([^']*)'$/.exec(which);
      if (q) which = (q[1] ?? q[2]).trim();
      return { cmd: 'loadgoals', which };
    },
    async run(a, env) {
      const GL = goalLayers(env, 'loadScriptGoals');
      const p = place(env);
      const ending = a.which === '' || a.which === '0';
      if (env.dryRun) {
        env.log(ending ? '  [dry run] would end this city\'s script goals: it would run its saved goals again'
          : `  [dry run] would load ${/^\d$/.test(a.which) ? 'goal set ' + a.which : '"' + a.which + '"'} in place of this city's goals`);
        env.log('  [dry run] not set');
        return {};
      }
      const r = GL.loadScriptGoals(p.accountId, p.castleId, a.which);
      if (!r || r.error) {
        const msg = (r && r.error) || 'the goal layer gave no answer';
        env.log('  -> FAILED - ' + msg);
        return { ok: false, error: msg, result: layerResult(layerNow(GL, p)) };
      }
      if (ending) {
        env.log(r.cleared ? '  -> ok — the script goals are gone: the city runs its saved goals again'
          : '  -> ok — there were no script goals: the city runs its saved goals');
        return { ok: true, result: layerResult(null, { cleared: !!r.cleared }) };
      }
      const got = readAnswer(r);
      for (const n of got.notes) env.log('  note: ' + n);
      for (const e of got.errors) env.log('  FAILED - ' + e);
      const layer = r.layer !== undefined ? r.layer : layerNow(GL, p);
      env.log(`  -> ${got.errors.length ? 'loaded, with lines the goals cannot use' : 'ok'} — ${describeLayer(layer)}`);
      return { ok: !got.errors.length, error: got.errors.join('; '), result: layerResult(layer) };
    },
  },

  resetgoals: {
    usage: 'resetgoals',
    parse(args) {
      if (String(args).trim()) throw new Error('resetgoals: nothing goes after it (loadgoals 0 brings the saved goals back)');
      return { cmd: 'resetgoals' };
    },
    async run(a, env) {
      const GL = goalLayers(env, 'resetScriptGoals');
      const p = place(env);
      if (env.dryRun) {
        env.log('  [dry run] would stop every goal in this city until loadgoals 0, Clear script goals or a restart');
        env.log('  [dry run] not set');
        return {};
      }
      const r = GL.resetScriptGoals(p.accountId, p.castleId);
      if (!r || r.error) {
        const msg = (r && r.error) || 'the goal layer gave no answer';
        env.log('  -> FAILED - ' + msg);
        return { ok: false, error: msg };
      }
      const layer = r.layer !== undefined ? r.layer : layerNow(GL, p);
      env.log('  -> ok — no goals run in this city now; goal lines set from here on build a fresh set (loadgoals 0 brings the saved ones back)');
      return { ok: true, result: layerResult(layer) };
    },
  },
};

// NEAT's goals (wiki CategoryAllGoals), for a clearer refusal than "unknown
// command" when a line starts with one OTTObot has no goal for.
const NEAT_GOALS = new Set(('abandon abandonflats acquireflats attackgap build buildnpc capturedfirelimit comfort '
  + 'comfortpolicy defensecooldown defensepolicy distancepolicy embassy excludelist farmingcycle farmingcyclemin '
  + 'farmingpolicy fasthero feastinghallspace fortification fortsusereserved gate gatepolicy hero herofirelimit '
  + 'heropoints hiding homeheroes hunting huntingpos huntingtype keepatthome keepcapturedheroes keepheroes '
  + 'keepresources keeptroops monitorarmy nohealing nolevelheroes nomayor npc npcbounds npcbuildpolicy npcheroes '
  + 'npclimit npclimits npclist npcteams npctroops plan processingpolicy production rallypolicy reportstokeep '
  + 'requestresources requesttroops research reservedbarrack resourcelimits safevalleyfarming schedulepolicy '
  + 'sendresources sendtroops spamheroes taxpolicy trade tradepolicy trainint trainpol training training10 '
  + 'traininghero troop troopdelbadque troopidlequeuetime troopincrement troopqueuetime troopsusepopmax '
  + 'troopsusereserved valley valleyfarming valleyheroes valleylimit valleymin valleytroops wallqueuetime warrules '
  + 'wartown wartownpolicy warehousepolicy').split(' '));

// NEAT's script commands (wiki ScriptAccount, ScriptCity, ScriptControlStructures,
// ScriptHero, ScriptInformational, ScriptResource, ScriptTroop, ScriptDeprecated,
// CategoryDeployment). Where a goal and a command share a name the command wins
// (wiki Goal: that is what `goal` is for), so a line starting with one is never
// read as a goal — even when OTTObot has no such command or its module did not
// load: `comfort pray` is the comfort command, never config comfort:pray.
const NEAT_COMMANDS = new Set(('addfriend alliancechat block breakgates buyitem changeflag changeplayername '
  + 'cleannpcreports cleanreports completequests dreamtruce logout removefriend resetplayer truce unblock '
  + 'useangelitem usedevilitem useitem whisper worldchat '
  + 'abandon abandontown buildcity cancelbuildcity cancelbuilding cancelfortifications cancelresearch checkresearch '
  + 'comfort create demo demosite evacuatetown levy production renamecity setfocus settaxrate speedups '
  + 'startresearch teleport upgrade walldefense warteleport '
  + 'call command echo end execute exit gosub gosubreturn goto if ifgosub ifgoto label loop play post repeat return '
  + 'say sleep stop print '
  + 'changeheroname findhero firehero getspamhero heroroute listallheroes persuadehero releasehero renamehero '
  + 'rewardheroes setmayor setmayorbyname uplevelheroes useheroitem waithero waitherolost waterhero '
  + 'listbuffs listcommands listitems listmedals rescanmap rescanrec scanmap scanrec travelinfo '
  + 'buy buyprice canceltrade dumpresource marketupdate sell sellprice '
  + 'canceltroopqueues disband dumptroop healtroops train troopgoal '
  + 'attack bigattack bigdeploy bigreinforce bigscout bigtransport capture deploy endguardedattack endloyaltyattack '
  + 'endspamattack guardedattack idrecall loyaltyattack recall recallall recallhero reinforce scout setballsused '
  + 'setguard spamattack transport').split(' '));

// A line whose first word is no script command (script.js asks after commands
// and expressions): a goal line when that word is a goal, as NEAT reads any goal
// line in a script. null leaves it to "unknown command", so a mistyped command
// still says so; a goal line that cannot be read refuses the script.
// info (from script.js, when it passes it): { words, failed } — the registry's
// command words, and the command modules that did not load. While one is
// missing no line is read as a goal: its commands' words are unknown.
const goalLines = {
  parse(text, info = {}) {
    const t = String(text).trim();
    const w = firstWord(t);
    if (NEAT_COMMANDS.has(w)) return null;
    if (info && info.words && typeof info.words.has === 'function' && info.words.has(w)) return null;
    if (info && Array.isArray(info.failed) && info.failed.length) return null;
    if (!isGoalWord(w)) {
      const G = goalsMod();
      const args = t.split(/\s+/).slice(1);
      const configKey = !!(G && G.CONFIG_KEYS && G.CONFIG_KEYS.has(w));
      const asConfig = () => new Error(`${w} is a config switch, not a line of its own — write  config ${w}:${args.join('') || '<value>'}`);
      // `npc 5` is config npc:5 written as a line; `plan b:1,...` is NEAT's Plan goal
      if (configKey && args.length === 1 && /^[\d.]+[kmb]?$/i.test(args[0])) throw asConfig();
      if (NEAT_GOALS.has(w)) throw new Error(`${w} is a NEAT goal OTTObot has no goal for yet, so nothing would act on this line`);
      if (configKey) throw asConfig();
      return null;
    }
    if (E.hasSpans(t)) return { cmd: 'goal', expr: quoted(t), via: 'line' };
    return goalAction(t, 'line');
  },
  run: runGoal,
};

// NEAT's goal files beside the bot, as `get` reads them (NewCityScript:
// @get "NewCityGoals.txt"). Here they are the account's goal texts: the
// new-city template (the 'default' goal row) and, with the goals update, the
// prepend and append goals. -> the text ('' when the account has none), or null
// for a name that is none of these (`get` then looks elsewhere).
const GOAL_FILES = { newcitygoals: 'template', prependgoals: 'prepend', appendgoals: 'append' };
function goalFile(name, env) {
  const base = String(name ?? '').trim().replace(/^.*[\\/]/, '').replace(/^!/, '').replace(/\.txt$/i, '').toLowerCase();
  const which = GOAL_FILES[base];
  if (!which) return null;
  const s = env && env.session;
  const accountId = accountOf(env);
  const api = (s && s.org && s.org.goals) || require('./db').goals;
  let GL = env && env.opts ? env.opts.goalLayers : undefined;
  if (GL === undefined) { try { GL = require('./goallayers'); } catch { GL = null; } }
  if (GL && typeof GL.readText === 'function' && typeof api.exact === 'function') {
    const r = GL.readText(api, accountId, which);
    return r && (r.exists || r.inherited) ? String(r.src || '') : '';
  }
  // before the goals update an account has only the template
  if (which !== 'template') return '';
  const row = api.find(accountId, [], 'goal');     // the account's default, then the shared one
  return row && row.src ? String(row.src) : '';
}

module.exports = { commands, goalLines, goalAction, goalFile, MISSING };
