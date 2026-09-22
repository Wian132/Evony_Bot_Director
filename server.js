'use strict';
// Local UI server for the Evony offline-account scanner. No dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { EvonyClient, getServerConfig } = require('./evony');

const { Session } = require('./session');
const D = require('./db');
const AUTH = require('./auth');
AUTH.configure();

// One console per account: a second login for the same account gets kicked, so
// running a second account means a second process on another port.
const PORT = Number(process.env.CONSOLE_PORT || 8711);

const SESSION = new Session();
// Set only when the account was chosen explicitly, not inferred from .env.
const PINNED = process.env.ACCOUNT_ID || null;

// NEAT's start-up parameters: this console's command line (where the Director
// puts its fleet-wide and per-account ones, as NEAT's Director does) over
// CmdParms.txt — script-console.js. -autorun 0 starts the engine paused, as
// ENGINE_PAUSED=1 does; -autoscripts and -runscript are read at autorun.
{
  const SCP = require('./script-console');
  SCP.setStartupArgs(process.argv.slice(2));
  const goals = SCP.readCmdParms().autorun;
  if (goals !== undefined && !SCP.switchOn(goals)) SESSION.userPaused = true;
}

// A console holds the game socket, the goal engine and every running script for
// one account. Node ends the process on an unhandled rejection, so one route
// that forgot a catch — the Director's uptime routes did exactly this — took all
// of that down with it, mid-march and mid-script, and the page behind it just
// stopped answering. A bug in one request is not worth a bot going dark: it is
// logged loudly, put in the Log tab where it will be seen, and the console lives
// on. Anything truly unrecoverable still fails at its own next step.
for (const kind of ['unhandledRejection', 'uncaughtException']) {
  process.on(kind, (err) => {
    const e = err instanceof Error ? err : new Error(String(err));
    const what = kind === 'unhandledRejection' ? 'unhandled rejection' : 'uncaught exception';
    console.error(`\n  ${what.toUpperCase()}: ${e.message}\n${e.stack || ''}\n  (the console kept running)\n`);
    try { SESSION.note(`${what}: ${e.message} — the console kept running; its terminal has the stack`, { kind: 'sys' }); } catch { /* not up yet */ }
  });
}

// ONE CONSOLE PER ACCOUNT. Two logins for the same account make the server kick
// one of them, and the two supervisors then fight and trip the rate limiter.
// Ask every other configured console who it holds before starting; if one of
// them already owns this account, refuse rather than start the fight.
(async () => {
  const mine = SESSION.account && SESSION.account.id;
  if (!mine) return;
  const probes = (SESSION.org ? SESSION.org.settings : D.settings)
    .get('probes', [{ probe: 'console', url: 'http://localhost:8711' }]);
  for (const pr of probes) {
    const url = String(pr.url || '').replace(/\/$/, '');
    if (!url || url.endsWith(':' + PORT)) continue;            // that is us
    const held = await new Promise((resolve) => {
      const req = http.get(url + '/api/session', { timeout: 1500 }, (res) => {
        let b = ''; res.on('data', (c) => (b += c));
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
    if (held && held.account && held.account.id === mine) {
      console.error(`
  REFUSING TO START: ${url} is already running account `
        + `${mine} (${SESSION.account.label}).
  One console per account — `
        + `start this one with a different ACCOUNT_ID, or stop that one first.
`);
      process.exit(1);
    }
  }
})();

console.log(`  account: ${SESSION.account ? SESSION.account.id + ' ' + SESSION.account.label : '(from .env)'}`
  + `   port: ${PORT}   engine: ${SESSION.userPaused ? 'PAUSED (ENGINE_PAUSED=1 or -autorun 0) — press Resume' : 'live'}`);

// A console for an account switched off in the Director comes up and stays
// parked: the page, the log and the scripts are all there, but nothing logs in.
// Say so at startup, or a console that never connects looks broken.
if (typeof SESSION.switchedOff === 'function' && SESSION.switchedOff()) {
  console.log('  this account is SWITCHED OFF in the Director — this console will not log in '
    + 'until it is switched back on there');
}

SESSION.startSupervisor();     // heartbeat + auto-reconnect for the console session
SESSION.startEngine();         // ticks the goal engine, live, unless paused from the console

function loadEnv() {
  const out = {};
  const p = path.join(__dirname, '.env');
  if (fs.existsSync(p)) for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2];
  }
  return out;
}

const LOADOUTS = 10;     // script loadout slots per city

// Scripts running now, by city: { stop, startedAt, lines, dropped }. Stop sets
// `stop`, which the run polls between lines — the only way an endless `repeat`
// ends while its line keeps going through.
const SCRIPT_RUNS = new Map();
// The last run of each city, kept after it ends so the Script tab can still show
// how it went: a live Run is answered the moment it starts (see /api/script), so
// its ending reaches the page through /api/script/runs, not through the reply.
const SCRIPT_DONE = new Map();
const SCRIPT_DONE_KEEP = 20;       // cities remembered; the oldest is forgotten
const SCRIPT_KEEP = 2000;          // lines a run keeps; older ones are dropped
const CALL_FRESH_MS = 1000;        // how long a run trusts what `call` last loaded

// A script's parse errors, once each: loop/repeat expansion copies a bad line.
function scriptErrors(actions) {
  const seen = new Map();
  for (const a of actions) if (a.cmd === 'error') seen.set(`${a.line}:${a.error}`, { line: a.line, error: a.error });
  return [...seen.values()];
}

// NEAT's !NewCityScript.txt: the account's new-city script (goallayers.js) runs
// once in a city the moment it appears (session.js cityAdded). It is an
// ordinary run of that city's, as /api/script starts one: it shows in
// /api/script/runs, Stop ends it, it never doubles a run already going there,
// and a script with errors runs whole or not at all.
// A new city's script goes through the console's own runner, so it gets what
// every other run gets: call, stop/Resume, say/play, the goal layer and the
// run-id guard. It keeps its old answer shape ({ok, errors, actions, stopped}),
// which session.js reports in the Log.
SESSION.runNewCityScript = async (castleId, src, log) => {
  const actions = require('./script').parse(src || '');
  const errors = scriptErrors(actions);
  if (errors.length) return { ok: false, errors };
  try {
    const r = await runCityScript(String(castleId), actions, { castle: castleId, log, source: 'new-city script' });
    if (r.busy) return { ok: false, error: 'a script is already running in that city' };
    return r.ok ? { ok: true, actions: r.n, stopped: r.stopped } : { ok: false, error: r.error, stopped: r.stopped };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

function body(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

async function runScan({ names }, log) {
  // shares the console's session — a second login would kick it
  const g = await SESSION.connect();
  const c = g.c;
  log(`scanning as ${g.player.playerInfo.userName}`);

  const now = Date.now();
  const rows = [];

  for (const name of names) {
    c.send('common.getPlayerInfoByName', { userName: name });
    let info = null;
    try {
      const r = await c.await(['common.getPlayerInfoByName'], 8000);
      if (r.data && r.data.ok === 1) info = r.data.playerInfo;
      else log(`  ${name}: not found (ok=${r.data && r.data.ok})`);
    } catch (e) { log(`  ${name}: ${e.message}`); }

    if (info) {
      const was = ORG.players.latest(name);
      const delta = was ? info.prestige - was.prestige : null;
      const mins = was ? Math.round((now - was.at) / 60000) : null;
      rows.push({
        name: info.userName, alliance: info.alliance, prestige: info.prestige,
        castles: info.castleCount, rank: info.ranking, population: info.population,
        office: info.office, delta, sinceMin: mins,
        stalled: was ? delta === 0 : null,
      });
      ORG.players.record(name, info.prestige, now);
      log(`  ${name}: pres ${info.prestige}` + (delta === null ? ' (first sighting)' : delta === 0 ? `  NOT MOVING for ${mins}m` : `  +${delta}`));
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  return rows;   // shared session stays open
}

const rawBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b));
});

// ---- script runs: what every run the console starts shares -----------------
// The Run button and NEAT's autorun both start a city's script through
// runCityScript: one run per city at a time, kept in SCRIPT_RUNS where Stop,
// Resume and the live output find it. script-console.js has the details.
const SC = require('./script-console');
const NOTES = new SC.Notifier();          // say / play, for the open console tabs

const cityNameOf = (id) => {
  const g = SESSION.game;
  const c = g && (g.castles || []).find((x) => String(g.castleId(x)) === String(id));
  return (c && c.name) || null;
};

// A Run from the page is one long request. When the console restarts under it,
// the browser sends it again to the new process, which then started the script
// over from the top (2026-09-13: 167 extra market orders). The page gives each
// Run an id, kept here across restarts: an id already started is refused.
function claimRunId(id) {
  const st = SESSION.org ? SESSION.org.settings : D.settings;
  const now = Date.now();
  const seen = (st.get('scriptRunIds', []) || []).filter((x) => x && now - x.at < 7 * 86400000);
  if (seen.some((x) => x.id === id)) return false;
  seen.push({ id, at: now });
  st.set('scriptRunIds', seen.slice(-200));
  return true;
}

// NEAT's Run box: a line number or a label to start at; blank or 0 is line 1.
// -> { startLine } | { error }
function startLineOf(v, actions) {
  const s = String(v ?? '').trim();
  if (!s || s === '0') return { startLine: null };
  const stmts = actions.program ? actions.program.stmts : actions;
  if (/^\d+$/.test(s)) {
    const n = Number(s), last = Math.max(0, ...stmts.map((a) => Number(a.line) || 0));
    if (n > last) return { error: `nothing runs from line ${n} — the last line that does anything is line ${last}` };
    return { startLine: n };
  }
  const name = s.replace(/^label\s+/i, '');
  if (!actions.some((a) => a.cmd === 'label' && String(a.name).toLowerCase() === name.toLowerCase())) {
    return { error: `there is no label ${name} in this script to start at` };
  }
  return { startLine: name };
}

// `say` / `play` from a run of city `key` (script-cmd-social.js): queued for the
// console tabs. -> how many tabs are open to hear it.
function scriptNotify(n, key, log) {
  if (!n || (n.kind !== 'say' && n.kind !== 'play')) return 0;
  const note = { kind: n.kind, city: key, cityName: cityNameOf(key), line: n.line ?? null };
  if (n.kind === 'say') {
    note.text = String(n.text == null ? '' : n.text).slice(0, 500);
    note.lang = /^[a-z]{2,3}(-[a-z]{2})?$/i.test(String(n.lang || '')) ? String(n.lang).toLowerCase() : null;
  } else if (n.url && /^https?:\/\//i.test(String(n.url))) {
    note.url = String(n.url);
  } else {
    try {
      const m = SC.mediaFile(n.file || n.url);
      if (fs.existsSync(m.file)) note.url = '/api/script/media?f=' + encodeURIComponent(m.rel);
      else { note.beep = true; log(`  (there is no ${m.rel} in ${SC.MEDIA_DIR} — a console tab beeps instead)`); }
    } catch (e) { note.beep = true; log(`  (${e.message} — a console tab beeps instead)`); }
  }
  return NOTES.push(note);
}

// run()'s options for a run of city `key`: Stop, NEAT's `stop` (a pause that
// Resume ends), `call`, `say`/`play`, logout's wait, NEAT's start-up
// parameters (Config.<key>, e.g. -teleport), callScript, and whose run it is.
function scriptOpts(key, running, castle, log, { dryRun = false } = {}) {
  const accountId = (SESSION.account && SESSION.account.id) || null;
  const callCache = new Map();     // loadScript's: name -> { at, src }
  return {
    castle, session: SESSION, accountId, cityId: key,
    // CmdParms.txt's -name value pairs; the Config bean drops pass/secret/token keys
    config: SC.readCmdParms(),
    // cities[x].cityManager.script.callScript("lines") (script-objects.js): the
    // lines start as that city's own run, keyed by its castle id like every
    // run, never beside one already there; a dry run starts a dry run
    runInCity: (castleId, text) => {
      const g = SESSION.game;
      const city = g && (g.castles || []).find((c) => String(g.castleId(c)) === String(castleId));
      if (!city) return { error: `there is no city ${castleId} to start it in` };
      const other = String(g.castleId(city));
      if (SCRIPT_RUNS.has(other)) return { busy: true };
      const actions = require('./script').parse(String(text));
      const errors = scriptErrors(actions);
      if (errors.length) return { error: `line ${errors[0].line}: ${errors[0].error}` };
      runCityScript(other, actions, { castle: other, dryRun, source: `callScript from ${cityNameOf(key) || key}`,
        log: (m) => console.log(`[callScript ${city.name || other}] ${m}`) }).catch(() => {});
      return { ok: true };
    },
    shouldStop: () => running.stop,
    // `logout` waits for the other cities' scripts, except any already waiting at a logout.
    otherScripts: () => [...SCRIPT_RUNS].filter(([, r]) => r !== running && !r.atLogout).map(([city]) => city),
    atLogout: (on) => { running.atLogout = !!on; },
    // waits until /api/script/resume; Stop ends it (the run polls shouldStop meanwhile)
    onPause: ({ line, next }) => new Promise((resolve) => {
      running.paused = { line, next: next || null, since: Date.now(), resolve };
    }),
    // `call`: this city's loadouts by slot or first-line name, else a file in the scripts folder
    // A loop calling the same file every pass read the loadouts table and the file
    // each time; what was found is kept a second, so an edit still lands at once.
    loadScript: (name) => {
      const k = String(name), hit = callCache.get(k);
      if (hit && Date.now() - hit.at < CALL_FRESH_MS) return hit.src;
      const org = SESSION.org;
      const slots = org && accountId && /^\d+$/.test(String(key)) ? org.goals.loadouts(accountId, key) : [];
      const src = SC.resolveCall(name, slots).src;
      if (callCache.size >= 20) callCache.delete(callCache.keys().next().value);
      callCache.set(k, { at: Date.now(), src });
      return src;
    },
    notify: (n) => scriptNotify(n, key, log),
  };
}

// Every line a run puts out carries the time it happened, by this machine's
// clock, and stands on its own: one event, one line. The VM says a line's
// "line N: <source>" header first and what the command did after it, so the
// header is folded into the first thing the command says, and anything more it
// says gets its own stamped line naming the same source line. A command that
// says nothing at all is still its own line. Nothing here changes what the
// script language itself writes — only how a console keeps it.
const two = (n) => String(n).padStart(2, '0');
function clockTime(d = new Date()) {
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
const STAMP_RE = /^\d\d:\d\d:\d\d\.\d\d\d /;         // how a stamped line starts (the page strips it too)
function stamped(emit) {
  let head = null;                 // { num, text, out }: the header of the line running now
  const put = (s) => emit(`${clockTime()} ${s}`);
  // A header waits only for the tick it was said in. What a command says in the
  // same breath — an order's reply, a refusal — folds into it; what takes a while
  // to answer must not hold it back, or a `sleep 300`, or a run paused at `stop`,
  // would say nothing at all until it was over.
  const now = () => { if (head && !head.out) { put(head.text); head.out = true; } };
  // one line of a command's output, folded into the header if it is the first
  const detail = (s) => {
    if (!head) return put(s.trim());
    if (head.out) return put(`line ${head.num}: ${s.trim()}`);
    put(`${head.text} · ${s.trim()}`);
    head.out = true;
  };
  const fn = (m) => {
    // a command that says several things in one breath still gets a line each,
    // so nothing a console keeps ever runs over more than one line
    const parts = String(m).split(/\r?\n/).filter((x) => x.trim());
    if (!parts.length) return;
    const h = /^line (\d+): /.exec(parts[0]);
    if (h) {
      now();
      head = { num: h[1], text: parts[0].replace(/\s+$/, ''), out: false };
      setImmediate(now);
      for (const x of parts.slice(1)) detail(x);
      return;
    }
    // what a command says is '  '-indented under its header (the VM's contract);
    // anything else is the run speaking for itself, not for one line
    if (parts[0].startsWith('  ') && head) { for (const x of parts) detail(x); return; }
    now(); head = null;
    for (const x of parts) put(x.trim());
  };
  fn.flush = () => { now(); head = null; };
  return fn;
}

// Run a parsed script in city `key` and wait for its end. o: { castle, lines,
// log, dryRun, autoReq, startLine, source }. -> { ok, n, stopped, running,
// error } | { ok: false, busy: true } when the city already has a run.
// Whoever waits for this, /api/script no longer does for a live run: it starts
// the run and answers, and what happened is read from SCRIPT_DONE afterwards.
async function runCityScript(key, actions, o = {}) {
  if (SCRIPT_RUNS.has(key)) return { ok: false, busy: true };
  const lines = o.lines || [];
  const running = { stop: false, startedAt: Date.now(), lines, dropped: 0, paused: null, source: o.source || null };
  SCRIPT_RUNS.set(key, running);
  let done = { ok: false, error: 'the run did not finish' };
  const log = stamped((m) => {
    lines.push(m);
    if (o.log) o.log(m);
    // an endless `repeat` would otherwise grow this without bound
    if (lines.length > SCRIPT_KEEP) { lines.shift(); running.dropped++; }
  });
  // Use the SHARED session. Logging in a second time for the same account makes
  // the server kick the first connection, which is what was knocking the
  // console offline every time a script ran.
  try {
    const game = await SESSION.connect();
    const n = await require('./script').run(game, actions, log, {
      ...scriptOpts(key, running, o.castle ?? key, log, { dryRun: o.dryRun === true }),
      dryRun: o.dryRun === true, autoReq: !!o.autoReq, startLine: o.startLine ?? null,
    });
    done = { ok: true, n, stopped: running.stop, running };
    return done;
  } catch (e) {
    done = { ok: false, error: e.message, stopped: running.stop, running };
    return done;
  } finally {
    log.flush();
    running.paused = null;
    SCRIPT_RUNS.delete(key);
    SCRIPT_DONE.delete(key);         // re-inserted last: the Map keeps insertion order
    SCRIPT_DONE.set(key, { at: Date.now(), startedAt: running.startedAt, lines: running.lines, dropped: running.dropped,
      stopped: running.stop, source: running.source || null, n: done.n || 0, error: done.error || null });
    while (SCRIPT_DONE.size > SCRIPT_DONE_KEEP) SCRIPT_DONE.delete(SCRIPT_DONE.keys().next().value);
  }
}

// NEAT's autorun (AutorunScripts, AutoRunScript.txt, CmdParms -autoscripts and
// -runscript): once per console start, after the first login and never again on
// a reconnect, every city runs its startup file and then each saved loadout
// holding `label autorun`, from that label, one after another. A city that
// already has a run is left alone, so nothing is ever started twice. It is OFF
// unless switched on (AUTOSCRIPTS=1, or -autoscripts 1 in CmdParms.txt), and
// its last start per account is kept in the database: a console that starts
// again within 10 minutes (a crash loop, another session restarting it) skips it.
const AUTORUN = { done: false, timer: null };
async function startAutoruns() {
  const set = SC.autorunSettings();
  if (!set.on) {
    SESSION.note(set.from
      ? `autorun: off (${set.from} says so) — no script starts by itself`
      : 'autorun: off — no script starts by itself (switch it on in the Director: ✎ the account → Autorun scripts, or'
        + ' Start-up for every account; it applies from the console\'s next start)');
    return;
  }
  SESSION.note(`autorun: on (${set.from})`);
  const g = SESSION.game, org = SESSION.org, acct = SESSION.account && SESSION.account.id;
  const gate = SC.autorunGate(org ? org.settings : D.settings, acct || 'console');
  if (!gate.ok) { SESSION.note('autorun: ' + gate.why); return; }
  const startup = SC.startupScript(set);
  if (startup && startup.error) SESSION.note(`autorun: ${startup.name} not run — ${startup.error}`);
  for (const c of (g && g.castles) || []) {
    const key = String(g.castleId(c));
    let slots = [];
    try { slots = org && acct ? org.goals.loadouts(acct, key) : []; } catch (e) { SESSION.note(`autorun: ${c.name}'s loadouts did not load — ${e.message}`, { city: c.name, kind: 'sys' }); }
    const plan = SC.autorunPlan(slots, startup && startup.src ? startup : null);
    if (plan.length) autorunCity(key, c.name, plan);          // the cities run side by side
  }
}
async function autorunCity(key, name, plan) {
  const say = (m) => SESSION.note('autorun: ' + m, { city: name, kind: 'sys' });
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const rest = plan.length - i > 1 ? ` (and ${plan.length - i - 1} more autorun script(s) after it)` : '';
    const actions = require('./script').parse(p.src);
    const errors = scriptErrors(actions);
    if (errors.length) {
      say(`${p.what} not started in ${name} — line ${errors[0].line}: ${errors[0].error}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''}`);
      continue;
    }
    if (SCRIPT_RUNS.has(key)) { say(`${name} already has a script running — ${p.what}${rest} not started`); return; }
    say(`${p.what} started in ${name}${p.startLine ? ' from label autorun' : ''}`);
    const r = await runCityScript(key, actions, {
      castle: key, log: (m) => console.log(`[autorun ${name}] ${m}`), startLine: p.startLine, source: `autorun ${p.what}`,
    });
    if (r.busy) { say(`${name} already has a script running — ${p.what}${rest} not started`); return; }
    // nobody may have watched it run, so the Log says what went wrong in it
    const bad = r.running.lines.filter((l) => /(^|·) *FAILED: /.test(l));
    say(`${p.what} in ${name} ${!r.ok ? 'failed: ' + r.error : r.stopped ? 'stopped' : `ended — ${r.n} action(s)`}`
      + (bad.length ? `; ${bad.length} line(s) failed, the first: ${bad[0].replace(STAMP_RE, '').trim()}` : ''));
    if (r.stopped) { if (rest) say(`stopped, so the rest of ${name}'s autorun was not started`); return; }
  }
}
AUTORUN.timer = setInterval(() => {
  if (AUTORUN.done || !SESSION.connected || !SESSION.game) return;
  AUTORUN.done = true;
  clearInterval(AUTORUN.timer);
  startAutoruns().catch((e) => SESSION.note('autorun: ' + e.message));
}, 2000);

// OTTO_PROBE_AT_START=reads | orders | orders:10: measure this account's market speed once,
// a few seconds after the console's own first login (market-probe.js), and
// write what it found to <temp>/otto-market-probe-<account>.json. No page, no
// signed-in user: it runs inside the console on the session it already holds,
// so it needs no second login either. `orders` places real bids of a few stone
// at 0.001 and cancels every one of them again; `reads` places nothing.
if (process.env.OTTO_PROBE_AT_START) {
  const mode = String(process.env.OTTO_PROBE_AT_START);
  const probeTimer = setInterval(async () => {
    if (!SESSION.connected || !SESSION.game) return;
    clearInterval(probeTimer);
    await new Promise((r) => setTimeout(r, 5000));        // let the login's own traffic settle
    const acct = (SESSION.account && SESSION.account.id) || 'console';
    const file = path.join(require('os').tmpdir(), `otto-market-probe-${acct}.json`);
    const log = (m) => { console.log('[probe] ' + m); SESSION.note('market probe: ' + m, { kind: 'sys' }); };
    log(`starting (${mode}) — results go to ${file}`);
    try {
      // `orders` is five a phase; `orders:10` any number up to the city's ten slots
      const m = /^orders(?::(\d+))?$/.exec(mode);
      const orders = m ? Math.max(1, Math.min(10, Number(m[1] || 5))) : 0;
      const out = await require('./market-probe').run(SESSION.game, { reads: true, orders, log });
      fs.writeFileSync(file, JSON.stringify({ ok: true, host: require('os').hostname(), ...out }, null, 2));
      log('done');
    } catch (e) {
      fs.writeFileSync(file, JSON.stringify({ ok: false, error: e.message }, null, 2));
      log('FAILED: ' + e.message);
    }
  }, 2000);
}

const server = http.createServer(async (req, res) => {
  // Login gate first: everything below controls live accounts.
  if (await AUTH.guard(req, res, { readBody: rawBody })) return;

  // Signed in is not enough — this console belongs to ONE organization, and a
  // user from another has no business seeing its bots or its stored password.
  if (SESSION.orgId && req.org && req.org.id !== SESSION.orgId) {
    res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: false, error: 'This console belongs to another organization.' }));
  }
  const ORG = SESSION.org;

  const send = (code, type, data) => { res.writeHead(code, {
    // never let a browser hold on to a stale page or a stale account list
    'Cache-Control': 'no-store, must-revalidate', 'Content-Type': type.includes('charset') ? type : type + '; charset=utf-8' }); res.end(data); };

  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;

  // NOTE: match on pathname, not req.url — "/?account=a1" is not "/"
  if (url.pathname === '/' || url.pathname === '/app' || url.pathname === '/app.html') {
    return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'public', 'app.html')));
  }
  if (url.pathname === '/scanner' || url.pathname === '/index.html') {
    return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  }
  // The web battle log rebuilt without Flash, and the report view it shares
  // with the console's Reports window.
  if (url.pathname === '/report' || url.pathname === '/report.html') {
    return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'public', 'report.html')));
  }
  if (url.pathname === '/reportview.js' || url.pathname === '/reportview.css') {
    const js = url.pathname.endsWith('.js');
    return send(200, js ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
      fs.readFileSync(path.join(__dirname, 'public', js ? 'reportview.js' : 'reportview.css')));
  }

  // ---- shared session endpoints ----
  if (url.pathname === '/api/session') {
    // startupArgs: what this console was started with, so the Director can mark one still on old parameters
    return send(200, 'application/json', JSON.stringify({ ...SESSION.header(), cities: SESSION.cities(), startupArgs: SC.parmsToArgs(SC.startupArgs()) }));
  }
  // Focus an account by id from the Director's shared accounts.json
  if (url.pathname === '/api/switch' && req.method === 'POST') {
    const b = await body(req);
    // A console started with an explicit ACCOUNT_ID is PINNED to that account.
    // A stale browser tab at /?account=<other> used to switch it on every load,
    // which silently moved a console onto an account another console already
    // held — two logins, a kick, and a throttled account. The URL does not get
    // to override the process.
    if (PINNED && b.accountId !== PINNED) {
      return send(200, 'application/json', JSON.stringify({
        ok: false,
        pinned: PINNED,
        error: `this console is pinned to ${SESSION.account.label} (${PINNED}). `
             + `Open the console that runs ${b.accountId} instead of switching this one.`,
      }));
    }
    const acc = ORG.accounts.get(b.accountId);
    if (!acc) return send(200, 'application/json', JSON.stringify({ ok: false, error: 'unknown account ' + b.accountId }));
    try { const h = await SESSION.switchTo(acc); return send(200, 'application/json', JSON.stringify({ ok: true, ...h })); }
    catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }

  // ---- this account's own settings (the page's cog) ----
  //
  // So far one: the game's SECURITY CODE. It is stored on the account because
  // the console needs it at the moment the game answers -200, with nobody
  // watching. It is WRITE-ONLY over this API — the page is told whether one is
  // stored, never what it is, so a stored code cannot be read back out of a
  // signed-in tab or a proxy log.
  if (url.pathname === '/api/settings' && req.method === 'GET') {
    const SEC = require('./security');
    const acc = SESSION.account ? ORG.accounts.get(SESSION.account.id) : null;
    let protection = { option: null, error: 'not connected', options: SEC.OPTIONS };
    if (SESSION.game) {
      const p = await SEC.readProtection(SESSION.game);
      protection = { option: p.option, error: p.error, isSet: p.isSet, options: SEC.OPTIONS };
    }
    return send(200, 'application/json', JSON.stringify({
      ok: true,
      label: acc ? acc.label : (SESSION.account && SESSION.account.label) || null,
      hasSecurityCode: !!(acc && acc.securityCode),
      protection,
    }));
  }
  if (url.pathname === '/api/settings' && req.method === 'POST') {
    const b = await body(req);
    if (!SESSION.account || !SESSION.account.id) {
      return send(200, 'application/json', JSON.stringify({ ok: false, error: 'this console is not bound to an account, so there is nothing to save it on' }));
    }
    if (b.securityCode === undefined) return send(200, 'application/json', JSON.stringify({ ok: false, error: 'nothing to save' }));
    ORG.accounts.upsert({ id: SESSION.account.id, securityCode: String(b.securityCode) });
    // Anything unlocked with the old code stays unlocked for this session; the
    // next login starts locked again either way.
    if (SESSION.game) SESSION.game._secAuthed = false;
    // Deliberately not the code, not even its length: this line is kept.
    SESSION.note(String(b.securityCode) ? 'security code stored for this account' : 'the stored security code was cleared', { kind: 'sys' });
    return send(200, 'application/json', JSON.stringify({ ok: true, hasSecurityCode: !!String(b.securityCode) }));
  }
  // Is the stored code the right one? common.authSecurityCode only
  // authenticates — it unlocks nothing — so this changes nothing in the game.
  if (url.pathname === '/api/settings/check' && req.method === 'POST') {
    const g = SESSION.game;
    if (!g) return send(200, 'application/json', JSON.stringify({ ok: false, error: 'not connected to the game' }));
    if (!g.hasSecurityCode()) return send(200, 'application/json', JSON.stringify({ ok: false, error: 'no security code is stored for this account' }));
    let r = null;
    try { r = await g.req('common.authSecurityCode', { code: g.securityCode() }); }
    catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
    if (r && r.ok === 1) { g._secAuthed = true; return send(200, 'application/json', JSON.stringify({ ok: true })); }
    return send(200, 'application/json', JSON.stringify({ ok: false, error: `the game refused it (${(r && (r.errorMsg || r.ok)) || 'no answer'})` }));
  }

  if (url.pathname === '/api/connect' && req.method === 'POST') {
    // Connect is also how a script's logout is ended early (logout.js).
    if (SESSION.maint.plan && SESSION.maint.plan.source === 'logout') SESSION.clearMaintenancePlan();
    // ...and how the hold after another login kicked us is ended early.
    SESSION.clearKickHold();
    try { await SESSION.connect(); } catch (e) { /* reported via header */ }
    return send(200, 'application/json', JSON.stringify(SESSION.header()));
  }
  // The page's Refresh button: a fresh login now, as F5 is in the game client.
  if (url.pathname === '/api/reconnect' && req.method === 'POST') {
    try { await SESSION.reconnect(); } catch (e) { /* reported via header */ }
    return send(200, 'application/json', JSON.stringify(SESSION.header()));
  }
  // What our own armies are doing right now — the direct answer to "is it
  // actually farming", which the logs only imply.
  // How fast can this account's market go? (market-probe.js) OFF unless the
  // console was started for it (OTTO_PROBE=1), and only for a signed-in user —
  // the machine token deliberately cannot drive a bot (auth.js guard). The same
  // probe can run by itself once after the console's own login instead
  // (OTTO_PROBE_AT_START), with no page and no session needed.
  if (url.pathname === '/api/debug/market-timing' && req.method === 'POST') {
    if (process.env.OTTO_PROBE !== '1') {
      return send(403, 'application/json', JSON.stringify({ ok: false, error: 'start the console with OTTO_PROBE=1 to measure' }));
    }
    const b = await body(req);
    try {
      const g = await SESSION.connect();
      const out = await require('./market-probe').run(g, {
        city: b.city || null, resource: String(b.resource || 'stone'), reads: b.reads !== false,
        orders: b.orders === true ? 5 : Math.max(0, Math.min(10, Number(b.orders) || 0)), log: (m) => console.log('[probe] ' + m),
      });
      return send(200, 'application/json', JSON.stringify({ ok: true, ...out }));
    } catch (e) {
      return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // Diagnostic: the raw shapes the server actually sends, so UI work is built
  // against reality rather than against the bean definitions, which list only a
  // subset of what arrives at runtime. Internal token only.
  if (url.pathname === '/api/debug/city' && AUTH.isInternal(req)) {
    try {
      const g = await SESSION.connect();
      const c = q.get('id') ? g.castles.find((x) => String(g.castleId(x)) === q.get('id')) : g.castle();
      if (!c) return send(200, 'application/json', JSON.stringify({ error: 'no such city' }));
      const shape = (v, depth = 0) => {
        if (v === null || v === undefined) return typeof v;
        if (Array.isArray(v)) return `array[${v.length}]` + (v.length && depth < 2 ? ' of ' + JSON.stringify(shape(v[0], depth + 1)) : '');
        if (typeof v === 'object') {
          if (depth >= 2) return 'object{' + Object.keys(v).slice(0, 12).join(',') + '}';
          return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, shape(x, depth + 1)]));
        }
        return typeof v === 'string' ? `"${String(v).slice(0, 24)}"` : String(v);
      };
      // The whole roster of this city, in the few fields a hero audit needs.
      // Read-only, off the session already in memory: it sends nothing to the
      // game. This is how the fleet is swept for cities with no heroes, cities
      // packed to their hall's limit, and prisoners sitting in the cells.
      if (q.get('roster')) {
        const G = require('./game').Game;
        const HH = require('./goal-heroes');
        return send(200, 'application/json', JSON.stringify({
          city: c.name, castleId: g.castleId(c),
          scouts: Number((c.troop && c.troop.scouter) || 0),
          heroes: (c.heros || []).map((h) => ({
            id: h.id, name: h.name, level: Number(h.level || 0), status: Number(h.status),
            statusWord: G.STATUS_WORD[Number(h.status)] || `status ${h.status}`,
            att: Number(h.power || 0), pol: Number(h.management || 0), int: Number(h.stratagem || 0),
            base: G.heroBase(h), loyalty: h.loyalty,
          })),
          hall: HH.feastingHall({ castle: c, game: g, goals: [], config: {} }).capacity,
        }, null, 1));
      }
      // One hero in full, when asked for by name — the shape summary truncates.
      const heroName = q.get('hero');
      if (heroName) {
        const h = (c.heros || []).find((x) => String(x.name || '').toLowerCase() === heroName.toLowerCase());
        return send(200, 'application/json', JSON.stringify({ hero: h || null }, null, 1));
      }
      return send(200, 'application/json', JSON.stringify({
        castleKeys: Object.keys(c),
        castle: shape(c),
        playerKeys: Object.keys(g.player || {}),
        player: shape(g.player || {}),
      }, null, 1));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ error: e.message })); }
  }

  // Manual valley actions from the Valleys tab.
  //
  // `field.giveUpField {fieldId}` releases a valley — irreversible, so it is
  // only ever accepted for a field this city actually holds, never for an
  // arbitrary id the caller sends. Founding a city is the same check.
  if (url.pathname === '/api/valley' && req.method === 'POST') {
    const b = await body(req);
    try {
      const g = await SESSION.connect();
      const fieldId = Number(b.fieldId);
      if (!Number.isFinite(fieldId)) throw new Error('no field id');

      const owner = (g.castles || []).find((c) => (c.fields || []).some((f) => Number(f.id) === fieldId));
      if (!owner) throw new Error('that field is not one of yours');
      const field = (owner.fields || []).find((f) => Number(f.id) === fieldId);

      if (b.action === 'abandon') {
        const r = await g.req('field.giveUpField', { fieldId });
        SESSION.note(`valley ${fieldId} abandoned -> ok=${r && r.ok}`, { city: owner.name, kind: 'act' });
        return send(200, 'application/json', JSON.stringify({ ok: r && r.ok === 1, error: r && r.errorMsg }));
      }

      if (b.action === 'build') {
        const C2 = require('./constants');
        const t = C2.FIELD_TYPES[Number(field.type)] || {};
        if (!t.buildable) throw new Error(`a ${t.name || 'field'} cannot be built on — only flats can`);
        const r = await g.req('city.constructCastle', {
          castleId: g.castleId(owner), fieldId, isTroopBack: true,
        });
        SESSION.note(`constructCastle on ${fieldId} -> ok=${r && r.ok}`, { city: owner.name, kind: 'act' });
        return send(200, 'application/json', JSON.stringify({ ok: r && r.ok === 1, error: r && r.errorMsg }));
      }

      throw new Error('action must be "abandon" or "build"');
    } catch (e) {
      return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (url.pathname === '/api/marches') {
    const { incomingArmies } = require('./snapshot');
    const out = SESSION.marches();
    let inc = [];
    try { inc = SESSION.connected ? incomingArmies(SESSION.game) : []; } catch (e) { /* reported as empty */ }
    return send(200, 'application/json', JSON.stringify({
      now: Date.now(), serverNow: SESSION.game ? SESSION.game.now() : Date.now(),
      outgoing: out, incoming: inc,
      count: out.length, incomingCount: inc.length,
      marches: out,                       // kept for anything already reading it
    }));
  }
  // The server's item catalogue, cached once per install. Gives real names for
  // the ids we hold, which is what makes "useheroitem OTTO excalibur" possible.
  if (url.pathname === '/api/itemdefs') {
    const cached = D.settings.get('itemDefs', null);
    if (cached && !q.get('refresh')) return send(200, 'application/json', JSON.stringify(cached));
    try {
      const g = await SESSION.connect();
      const raw = await g.itemDefs();
      D.settings.set('itemDefs', raw);
      return send(200, 'application/json', JSON.stringify(raw));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ error: e.message })); }
  }
  // The Items tab: everything the account holds, named (items.js). Read from the
  // session's own copy, which server.ItemUpdate keeps current — the tab polls,
  // so this never connects or asks the server anything.
  // The panel's three tabs come from here: Items, Medals (both from the
  // inventory) and Buffs — what the account and its cities are under, which the
  // game shows in the same place (buffs.js).
  if (url.pathname === '/api/items') {
    const g = SESSION.game;
    if (!g || !g.player) return send(200, 'application/json', JSON.stringify({ ok: false, error: 'not connected' }));
    const b = require('./buffs').active(g);
    const open = q.get('city');
    const city = open && b.cities[String(open)] ? b.cities[String(open)] : [];
    const inv = require('./items').inventory(g);
    const { applyRefusal } = require('./script-cmd-account');
    for (const it of inv.items) it.noApply = applyRefusal(it);
    return send(200, 'application/json', JSON.stringify({
      ok: true, ...inv,
      buffs: [...b.player.map((x) => ({ ...x, scope: 'account' })), ...city.map((x) => ({ ...x, scope: 'city' }))],
      protection: b.protection,
    }));
  }
  // The Items tab's Apply: spends an item in the open city exactly as the
  // useitem script line does (the same held-count check, shop.useGoods or
  // shop.useCastleGoods), and sends its lines back for the page to show.
  if (url.pathname === '/api/items/use' && req.method === 'POST') {
    const b = await body(req);
    const lines = [];
    try {
      const A = require('./script-cmd-account');
      const g = await SESSION.connect();
      const castle = b.city ? g.castles.find((c) => g.castleId(c) === Number(b.city)) || g.castle() : g.castle();
      const id = String(b.itemId || '');
      const held = ((g.player && g.player.items) || []).find((i) => i && String(i.id) === id);
      const inv = require('./items').inventory(g).items.find((i) => i.id === id);
      if (!held || !inv) throw new Error(`you hold no ${id}`);
      const no = A.applyRefusal(inv);
      if (no) throw new Error(no);
      const count = Math.max(1, Math.floor(Number(b.count) || 1));
      const a = A.commands.useitem.parse(`/count=${count} ${id}`);
      const env = {
        game: g, castle, dryRun: false,
        log: (m) => lines.push(String(m).trim()),
        say: (x) => (x && x.ok === 1 ? 'ok' : `FAILED (ok=${x && x.ok})${x && x.errorMsg ? ' - ' + x.errorMsg : ''}`),
      };
      const res = await A.commands[a.cmd].run(a, env) || {};
      const ok = !res.error && lines.some((l) => /^-> ok\b/.test(l));
      SESSION.note(`manual: useitem ${count} x ${inv.name} -> ${ok ? 'ok' : res.error || lines[lines.length - 1] || 'failed'}`,
        { city: castle.name, kind: 'act' });
      return send(200, 'application/json', JSON.stringify({ ok, lines, error: res.error || null }));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, lines, error: e.message })); }
  }
  // The Statistics tab: the game's rankings (players, alliances, heroes, cities),
  // statistics.js. Browsing reads a page at a time from the server (and a few ahead);
  // a search runs in the database over what has been read, and a lookup asks the
  // server for a name. Refresh reads every list whole. All of it through this
  // console's live connection (never a login); every console on the server shares it.
  if (url.pathname === '/api/stats' || url.pathname.startsWith('/api/stats/')) {
    const ST = require('./statistics');
    const server = (SESSION.account && SESSION.account.server) || process.env.EVONY_SERVER || 'ss71';
    const g = SESSION.connected ? SESSION.game : null;
    const alive = () => !!g && SESSION.game === g && SESSION.connected;
    const log = (m) => SESSION.note(m, { kind: 'sys' });
    // browsing (live=1): a page of a list as the game's window shows it, from the
    // server and read ahead; 'all' is page 1 of every list. Without a connection,
    // what the database holds.
    if (url.pathname === '/api/stats' && req.method === 'GET' && q.get('live')) {
      const kind = q.get('kind') || 'all';
      const kinds = ST.KINDS[kind] ? [kind] : ST.KIND_NAMES;
      const lists = await Promise.all(kinds.map((k) => ST.page({ game: g, server, kind: k, alive, log,
        pageNo: kinds.length > 1 ? 1 : q.get('page'), ahead: kinds.length > 1 ? 0 : undefined })));
      const each = kinds.length > 1 ? Math.max(1, Math.min(100, Number(q.get('limit')) || 10)) : 0;
      if (each) for (const l of lists) l.rows = l.rows.slice(0, each);
      return send(200, 'application/json', JSON.stringify({ ok: true, server, connected: !!g, status: ST.status(server), kind, lists }));
    }
    // a name asked of the server itself (the window's search box), in one list or all four
    if (url.pathname === '/api/stats/lookup' && req.method === 'GET') {
      const kind = q.get('kind') || 'all';
      const kinds = ST.KINDS[kind] ? [kind] : ST.KIND_NAMES;
      const lists = [];
      for (const k of kinds) lists.push(await ST.lookup({ game: alive() ? g : null, server, kind: k, name: q.get('name') }));
      return send(200, 'application/json', JSON.stringify({ ok: true, server, name: q.get('name') || '', lists }));
    }
    if (url.pathname === '/api/stats' && req.method === 'GET') {
      const res = ST.search(server, { kind: q.get('kind') || 'all', q: q.get('q') || '', sort: q.get('sort') || 'rank',
        dir: q.get('dir') || 'asc', limit: q.get('limit'), offset: q.get('offset') });
      return send(200, 'application/json', JSON.stringify({ ok: true, server, status: ST.status(server), ...res }));
    }
    if (url.pathname === '/api/stats/refresh' && req.method === 'POST') {
      const b = await body(req);
      if (!g) return send(200, 'application/json', JSON.stringify({ ok: false, error: 'not connected — the lists are read through this account\'s live connection' }));
      const account = (SESSION.account && SESSION.account.label) || (g.player && g.player.userName) || null;
      const r = ST.start({ game: g, server, account, kinds: Array.isArray(b.kinds) && b.kinds.length ? b.kinds : undefined, alive, log });
      return send(200, 'application/json', JSON.stringify({ ...r, status: ST.status(server) }));
    }
    if (url.pathname === '/api/stats/stop' && req.method === 'POST') {
      return send(200, 'application/json', JSON.stringify({ ...ST.stop(), status: ST.status(server) }));
    }
  }
  // The Alliance and Friends tabs (alliance.js): read through the live connection
  // when the user opens a tab, never a login. The orders are the script commands'.
  //   GET /api/alliance?view=info|members|events|war[&page=][&fresh=1]
  //   GET /api/alliance/player?name=     GET /api/friends
  //   POST /api/alliance/act {action: rank|expel|standing|addfriend|removefriend|block|unblock, name, rank?, standing?}
  if (url.pathname === '/api/alliance' || url.pathname.startsWith('/api/alliance/') || url.pathname === '/api/friends') {
    const AL = require('./alliance');
    const reply = (v) => send(200, 'application/json', JSON.stringify(v));
    try {
      if (url.pathname === '/api/friends') return reply(AL.friends(SESSION));
      if (url.pathname === '/api/alliance/player') return reply(await AL.player(SESSION, q.get('name')));
      if (url.pathname === '/api/alliance/act' && req.method === 'POST') return reply(await AL.act(SESSION, await body(req)));
      if (url.pathname === '/api/alliance') {
        const view = q.get('view') || 'info', fresh = !!q.get('fresh'), page = q.get('page');
        if (view === 'info') return reply(await AL.overview(SESSION, { fresh }));
        if (view === 'members') return reply(await AL.members(SESSION, { fresh }));
        if (view === 'events') return reply(await AL.events(SESSION, page));
        if (view === 'war') return reply(await AL.war(SESSION, page));
      }
      return reply({ ok: false, error: 'no such alliance view' });
    } catch (e) { return reply({ ok: false, error: e.message }); }
  }
  if (url.pathname === '/api/city') {
    return send(200, 'application/json', JSON.stringify(SESSION.city(q.get('id')) || {}));
  }
  // kind: activity (what the bot did) | engine (its thinking) | reports |
  // debug (everything, the protocol trace included). 'log' is the old name for debug.
  if (url.pathname === '/api/log') {
    const kind = q.get('kind') || 'activity';
    return send(200, 'application/json', JSON.stringify(
      SESSION.logView(kind, { city: q.get('city') || null, q: q.get('q') || '' })));
  }

  if (url.pathname === '/api/log/clear' && req.method === 'POST') {
    const b = await body(req);
    const removed = SESSION.clearLog(b.kind || 'debug', b.city || null);
    return send(200, 'application/json', JSON.stringify({ ok: true, removed }));
  }

  // ---- the console's per-city controls -----------------------------------
  // Gate Control: auto | open | closed. Open/closed go to the server at once.
  if (url.pathname === '/api/gate' && req.method === 'POST') {
    const b = await body(req);
    try { return send(200, 'application/json', JSON.stringify(await SESSION.setGate(b.city, String(b.mode || '')))); }
    catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }
  // War Town Mode: auto | 0 | 1 | 2 — overrides `config wartown:` for the city.
  if (url.pathname === '/api/wartown' && req.method === 'POST') {
    const b = await body(req);
    try { return send(200, 'application/json', JSON.stringify(SESSION.setWarTown(b.city, b.mode))); }
    catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }
  // The pause button: the engine stops acting; its mode is left alone.
  if (url.pathname === '/api/pause' && req.method === 'POST') {
    const b = await body(req);
    SESSION.userPaused = !!b.paused;
    SESSION.note(SESSION.userPaused ? 'PAUSED from the console — the engine will not act until resumed' : 'resumed from the console');
    return send(200, 'application/json', JSON.stringify({ ok: true, paused: SESSION.userPaused }));
  }
  // Per-city data that costs a request: queues | research | reinf | prod.
  if (url.pathname === '/api/cityx') {
    try {
      const data = await SESSION.cityExtra(q.get('id'), q.get('kind'), q.get('fresh') === '1');
      return send(200, 'application/json', JSON.stringify(data));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ error: e.message })); }
  }
  if (url.pathname === '/api/engine/report') {
    return send(200, 'application/json', JSON.stringify({
      paused: SESSION.userPaused, lastTickAt: SESSION.lastTickAt || null,
      report: SESSION.engineReport(q.get('city')),
    }));
  }

  // Cancel one of our own market offers. Only an offer this city actually has
  // is accepted, never an arbitrary id.
  if (url.pathname === '/api/trade/cancel' && req.method === 'POST') {
    const b = await body(req);
    try {
      const g = SESSION.game;
      if (!SESSION.connected || !g) throw new Error('not connected');
      const castle = g.castles.find((c) => g.castleId(c) === Number(b.city));
      if (!castle) throw new Error('no such city');
      const t = (castle.trades || []).find((x) => Number(x.id) === Number(b.tradeId));
      if (!t) throw new Error('that offer is not one of this city\'s');
      const r = await g.cancelTrade(g.castleId(castle), t.id);
      SESSION.note(`cancelled ${Number(t.tradeType) === 0 ? 'buy' : 'sell'} offer: ${t.resourceName || 'resource'} `
        + `${Number(t.amount).toLocaleString('en-US')} @ ${t.price} -> ${r && r.ok === 1 ? 'ok' : (r && r.errorMsg) || 'refused'}`,
      { city: castle.name, kind: 'act' });
      return send(200, 'application/json', JSON.stringify({ ok: !!(r && r.ok === 1), error: r && r.errorMsg }));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }

  // Cancel one batch in a barrack or the Walls queue: the ✖ on the Barracks and
  // Fortifications panels. {city, kind: troop|wall, positionId, queueId}. Only a
  // batch the city's queue holds right now is sent (queue-cancel.js).
  if (url.pathname === '/api/queue/cancel' && req.method === 'POST') {
    const b = await body(req);
    try {
      const g = SESSION.game;
      if (!SESSION.connected || !g) throw new Error('not connected');
      const castle = g.castles.find((c) => g.castleId(c) === Number(b.city));
      if (!castle) throw new Error('no such city');
      const r = await require('./queue-cancel').cancelOne(g, castle, String(b.kind || ''),
        { positionId: b.positionId, queueId: b.queueId }, { session: SESSION });
      SESSION.note(r.text, { city: castle.name, kind: 'act' });
      return send(200, 'application/json', JSON.stringify({ ok: r.ok, error: r.error }));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }

  // Recall one of our own marches. army.callBackArmy {castleId, armyId}
  // (ArmyCommands.as:118) — the castle is the one the army left from.
  if (url.pathname === '/api/army/recall' && req.method === 'POST') {
    const b = await body(req);
    try {
      const g = SESSION.game;
      if (!SESSION.connected || !g) throw new Error('not connected');
      const a = ((g.player && g.player.selfArmys) || []).find((x) => String(x.armyId) === String(b.armyId));
      if (!a) throw new Error('no such army of yours');
      const castle = g.castles.find((c) => Number(c.fieldId) === Number(a.startFieldId));
      if (!castle) throw new Error('cannot tell which city that army belongs to');
      const r = await g.req('army.callBackArmy', { castleId: g.castleId(castle), armyId: a.armyId });
      SESSION.note(`recalled army ${a.armyId} (${a.targetPosName || 'target'}) -> ${r && r.ok === 1 ? 'ok' : (r && r.errorMsg) || 'refused'}`,
        { city: castle.name, kind: 'act' });
      return send(200, 'application/json', JSON.stringify({ ok: !!(r && r.ok === 1), error: r && r.errorMsg }));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }
  if (url.pathname === '/api/chat' && req.method === 'GET') {
    const ch = q.get('channel') || 'alliance';
    return send(200, 'application/json', JSON.stringify({ lines: (SESSION.chat[ch] || []).slice(-200) }));
  }
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    const b = await body(req);
    try { await SESSION.sendChat(b.channel, b.msg, b.target); return send(200, 'application/json', '{"ok":true}'); }
    catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }
  // ---- mail & reports: the windows behind the header's Mail / Reports boxes ----
  //   GET  /api/mail?box=inbox|system|sent&page=1     GET /api/mail/read?id=
  //   POST /api/mail/delete {ids}   /api/mail/markread {ids}   /api/mail/send {to, title, body}
  //   GET  /api/reports?type=army|trade|other&page=1   GET /api/reports/read?id=
  //   POST /api/reports/delete {ids}   /api/reports/markread {ids}
  // Each one is the user opening the window or acting in it — nothing polls.
  // Not connected, or refused by the server: {ok:false, error}. See session.js.
  if (url.pathname === '/api/mail' || url.pathname.startsWith('/api/mail/')
      || url.pathname === '/api/reports' || url.pathname.startsWith('/api/reports/')) {
    const reply = (v) => send(200, 'application/json', JSON.stringify(v));
    const b = req.method === 'POST' ? await body(req) : {};
    try {
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /api/mail': return reply(await SESSION.mailList(q.get('box') || 'inbox', q.get('page')));
        case 'GET /api/mail/read': return reply(await SESSION.mailRead(q.get('id')));
        case 'POST /api/mail/delete': return reply(await SESSION.mailDelete(b.ids));
        case 'POST /api/mail/markread': return reply(await SESSION.mailMarkRead(b.ids));
        case 'POST /api/mail/send': return reply(await SESSION.mailSend(b.to, b.title, b.body));
        case 'GET /api/reports': return reply(await SESSION.reportPage(q.get('type') || 'army', q.get('page')));
        case 'GET /api/reports/read': return reply(await SESSION.reportRead(q.get('id')));
        case 'POST /api/reports/delete': return reply(await SESSION.reportDelete(b.ids));
        case 'POST /api/reports/markread': return reply(await SESSION.reportMarkRead(b.ids));
        // the web battle log, fetched from the game's report host: ?u=<link>&from=&to=
        case 'GET /api/reports/log': return reply(await SESSION.reportLog(q.get('u'), { from: q.get('from'), to: q.get('to') }));
        default: break;
      }
    } catch (e) { return reply({ ok: false, error: e.message }); }
  }
  // Manual override: keep working even while the server reports maintenance.
  if (url.pathname === '/api/maintenance' && req.method === 'POST') {
    const b = await body(req);
    if (b.check) SESSION.maint.checkedAt = 0;          // force a re-read now
    // Start the stand-down protocol for a window you know about but we did not
    // see announced: pause 5 min before it, sit out the window, then retry on a
    // 5-minute ladder.
    if (b.plan !== undefined) {
      if (b.plan === null || b.plan === false) SESSION.clearMaintenancePlan();
      else SESSION.planMaintenance(Number(b.inMin) || 15, Number(b.windowMin) || 15);
    }
    const m = b.override === undefined ? SESSION.maint : SESSION.setMaintenanceOverride(b.override);
    return send(200, 'application/json', JSON.stringify({ ok: true, maintenance: { ...m, paused: SESSION.paused } }));
  }
  // A city's Goals window shows that city's own goals, exactly what the engine
  // runs there (db.goals.own) — never another city's or the default's.
  if (url.pathname === '/api/editor') {
    const city = q.get('city') || 'default';
    const kind = q.get('kind') === 'script' ? 'script' : 'goal';
    const acct = SESSION.account && SESSION.account.id;
    const g = SESSION.game;
    const castle = g && (g.castles || []).find((c) => String(g.castleId(c)) === city);
    const entry = kind === 'goal' && city !== 'default'
      ? ORG.goals.own(acct, city, castle && castle.name, kind)
      : ORG.goals.find(acct, [city], kind);
    return send(200, 'application/json', JSON.stringify({ src: (entry && entry.src) || '' }));
  }
  // ---- manual hero operations (inn + feasting hall) ----
  if (url.pathname === '/api/inn') {
    try {
      const g = await SESSION.connect();
      const cid = Number(q.get('city')) || g.castleId(g.castle());
      const d = await g.tavernList(cid);
      const { Game } = require('./game');
      const base = (h, k) => Number(h[k] || 0) - Number(h[k + 'Added'] || 0);
      return send(200, 'application/json', JSON.stringify({
        heroes: (d.heros || []).map((h) => ({
          name: h.name, level: h.level, base: Game.heroBase(h),
          attack: Game.attrValue(h, 'power'), politics: Game.attrValue(h, 'management'), intel: Game.attrValue(h, 'stratagem'),
          baseAttack: base(h, 'power'), basePolitics: base(h, 'management'), baseIntel: base(h, 'stratagem'),
        })),
      }));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ error: e.message })); }
  }

  if (url.pathname === '/api/hero' && req.method === 'POST') {
    const b = await body(req);
    try {
      const g = await SESSION.connect();
      const castle = b.city ? g.castles.find((c) => g.castleId(c) === Number(b.city)) || g.castle() : g.castle();
      const cid = g.castleId(castle);
      const hero = b.heroName ? g.findHero(castle, b.heroName) : null;
      let r;

      // Holy Water, as the waterhero script line (water-hero.js), its lines sent
      // back for the page to show. The preview only checks: it sends nothing.
      if (b.action === 'water' || b.action === 'waterpreview') {
        if (!hero) throw new Error('hero not found in this city');
        const WH = require('./water-hero');
        const a = { hero: String(hero.id), rule: b.heropoints ? WH.parseRule(b.heropoints) : null };
        if (b.action === 'waterpreview') {
          const p = WH.prepare(g, a);
          return send(200, 'application/json', JSON.stringify({ ok: p.ok, need: p.need, held: p.held, lines: p.lines.map((l) => l.trim()) }));
        }
        const lines = [];
        const went = await WH.run(g, a, { log: (m) => lines.push(m.trim()) });
        for (const l of lines) SESSION.note(`manual: waterhero ${hero.name}: ${l}`, { city: castle.name, kind: 'act' });
        return send(200, 'application/json', JSON.stringify({ ok: went, lines }));
      }

      // The hero items held, for the hero row's + window. A preview only: it
      // sends the game nothing, it reads the inventory the session already has.
      if (b.action === 'itemspreview') {
        const HI = require('./heroitems');
        return send(200, 'application/json', JSON.stringify({ ok: true, items: HI.heroItemChoices(g) }));
      }

      // Apply a hero item (Excalibur and the rest), as the useheroitem script
      // line does, and send its lines back for the page to show. The item sets a
      // timed percentage buff rather than moving the attribute, so the summary
      // reports the buff and how many are left.
      if (b.action === 'useitem') {
        if (!hero) throw new Error('hero not found in this city');
        if (Number(hero.status) === 4) throw new Error(`${hero.name} is a prisoner you hold, not one of your heroes`);
        const HI = require('./heroitems');
        const itemId = HI.resolveItem(b.itemId);
        if (!itemId) throw new Error(`unknown hero item "${b.itemId}"`);
        if (itemId === 'hero.reset.1') throw new Error('Holy Water is the Reset button, not this one');
        const times = Math.min(50, Math.max(1, Math.floor(Number(b.times) || 1)));
        const lines = [];
        const r2 = await HI.useOnHero(g, {
          heroName: hero.name, heroId: hero.id, castleId: cid, itemId, times,
          log: (m) => lines.push(String(m).trim()),
        });
        if (r2.used) {
          const pct = { power: 'attack', management: 'politics', stratagem: 'intel' };
          const moved = Object.entries(pct)
            .map(([k, word]) => [word, r2.after[k + 'Buff'] - r2.before[k + 'Buff']])
            .filter(([, d]) => d)
            .map(([word, d]) => `${word} +${d}%`);
          lines.push(`Used ${r2.used} x ${HI.describeItem(itemId)} on ${r2.hero} in ${r2.castle}`
            + (r2.heldAfter === undefined ? '' : ` — ${r2.heldAfter} left`)
            + (moved.length ? `, now ${moved.join(', ')}` : ''));
        }
        if (r2.error) lines.push(r2.error);
        SESSION.note(`manual: useheroitem ${hero.name} ${itemId} x${times} -> ${r2.used || 0} used${r2.error ? ': ' + r2.error : ''}`,
          { city: castle.name, kind: 'act' });
        return send(200, 'application/json', JSON.stringify({ ok: !!r2.used && !r2.error, used: r2.used || 0, lines, error: r2.error }));
      }

      // The Heroes tab's Level button. hero.levelUp moves ONE level a time, so a
      // hero sitting on banked experience needs one send per level; each is
      // followed by the new point going on the attribute, exactly as the
      // `levelup <hero>` script line does (which is what runs here). times is
      // capped so one press cannot become an unbounded run of sends.
      if (b.action === 'levelup') {
        if (!hero) throw new Error('hero not found in this city');
        const times = Math.min(200, Math.max(1, Math.floor(Number(b.times) || 1)));
        const attr = b.attr ? require('./game').Game.ATTR[String(b.attr).toLowerCase()] : null;
        if (b.attr && !attr) throw new Error('attribute must be attack, politics or intel');
        const lines = [];
        const env = {
          game: g, castle, dryRun: false,
          log: (m) => lines.push(String(m).trim()),
          say: (x) => (x && x.ok === 1 ? 'ok' : `FAILED (ok=${x && x.ok})${x && x.errorMsg ? ' - ' + x.errorMsg : ''}`),
          stopped: () => false,
        };
        const cmd = require('./script-cmd-hero').commands.levelup;
        let done = 0, stop = null;
        for (let i = 0; i < times; i++) {
          const res = await cmd.run({ cmd: 'levelup', name: hero.name, attr }, env) || {};
          if (res.error) { stop = res.error; break; }        // out of experience, or busy
          if (!res.done) { stop = lines[lines.length - 1] || 'nothing was levelled'; break; }
          done += res.done;
        }
        SESSION.note(`manual: levelup ${hero.name} x${done}${stop ? ` (stopped: ${stop})` : ''}`, { city: castle.name, kind: 'act' });
        return send(200, 'application/json', JSON.stringify({ ok: done > 0, done, lines, error: done ? null : stop }));
      }

      // Persuade a prisoner we hold to join, as the persuadehero script line does
      // (the same gold and medal checks), its lines sent back for the page. The
      // preview is that line's dry run: it says the cost and sends nothing.
      if (b.action === 'persuade' || b.action === 'persuadepreview') {
        if (!hero) throw new Error('hero not found in this city');
        const lines = [];
        const env = {
          game: g, castle, dryRun: b.action === 'persuadepreview',
          log: (m) => lines.push(String(m).trim()),
          say: (x) => (x && x.ok === 1 ? 'ok' : `FAILED (ok=${x && x.ok})${x && x.errorMsg ? ' - ' + x.errorMsg : ''}`),
        };
        const res = await require('./script-cmd-hero').commands.persuadehero.run({ cmd: 'persuadehero', name: String(hero.id) }, env) || {};
        const ok = env.dryRun ? !res.error : !!res.result;
        if (!env.dryRun) SESSION.note(`manual: persuadehero ${hero.name} -> ${ok ? 'ok' : lines[lines.length - 1] || 'failed'}`, { city: castle.name, kind: 'act' });
        return send(200, 'application/json', JSON.stringify({ ok, lines, error: res.error }));
      }

      // What the next inn refresh would spend; the page asks before paying coins.
      if (b.action === 'refreshinnpreview') {
        const cost = g.innRefreshCost();
        return send(200, 'application/json', JSON.stringify({ ok: true, held: cost.held, text: cost.text }));
      }

      // Release only a prisoner we hold, never Fire or promote one, promote only
      // an idle hero (Game.heroActionRefusal, which the script asks too).
      if (['mayor', 'fire', 'release'].includes(b.action)) {
        const no = require('./game').Game.heroActionRefusal(b.action, hero);
        if (no) throw new Error(no);
      }

      if (b.action === 'mayor') {
        // Straight over the sitting mayor, as the client does (CastleChief.as:377-394):
        // discharging first left the city with no mayor whenever the promotion failed.
        r = await g.promoteToChief(cid, hero.id);
      } else if (b.action === 'unmayor') {
        r = await g.dischargeChief(cid);
      } else if (b.action === 'fire') {
        r = await g.fireHero(cid, hero.id);
      } else if (b.action === 'release') {
        r = await g.releaseHero(cid, hero.id);
      } else if (b.action === 'addpoint') {
        if (!hero) throw new Error('hero not found in this city');
        const alloc = { management: 0, power: 0, stratagem: 0 };
        const key = { attack: 'power', politics: 'management', intel: 'stratagem' }[b.attr] || b.attr;
        if (!(key in alloc)) throw new Error('attribute must be attack, politics or intel');
        alloc[key] = Number(b.amount) || 1;
        r = await g.addPoint(cid, hero, alloc);   // increments; game.js converts to totals
      } else if (b.action === 'recall') {
        // hero.callBackHero {castleId, heroId}: the Feasting Hall's recall, which
        // it offers for a hero out marching (3) or defending a valley (2).
        if (!hero) throw new Error('hero not found in this city');
        if (![2, 3].includes(Number(hero.status))) throw new Error(`${hero.name} is not out marching or defending`);
        r = await g.callBackHero(cid, hero.id);
      } else if (b.action === 'hire') {
        r = await g.hireHero(cid, b.heroName);
      } else if (b.action === 'refreshinn') {
        // Coins only when the page has asked (it sends force after its ask()).
        const cost = g.innRefreshCost();
        if (!cost.item && !b.force) throw new Error(`not refreshed: ${cost.text}`);
        r = await g.refreshTavern(cid);
      } else {
        throw new Error('unknown action ' + b.action);
      }

      SESSION.note(`manual: ${b.action}${b.heroName ? ' ' + b.heroName : ''} -> ${r && r.ok === 1 ? 'ok' : (r && r.errorMsg) || 'ok=' + (r && r.ok)}`,
        { city: castle.name, kind: 'act' });
      return send(200, 'application/json', JSON.stringify({ ok: r && r.ok === 1, result: r }));
    } catch (e) {
      return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (url.pathname === '/api/map') {
    try {
      const r = Math.max(1, Math.min(40, Number(q.get('r')) || 10));
      // NOTE: Number(null) is 0, so test the raw params before converting
      const rawX = q.get('x'), rawY = q.get('y');
      let cx = Number(rawX), cy = Number(rawY);
      if (rawX === null || rawY === null || rawX === '' || rawY === '' || Number.isNaN(cx) || Number.isNaN(cy)) {
        const g = await SESSION.connect();
        const c = q.get('city') ? g.castles.find((x) => g.castleId(x) === Number(q.get('city'))) : g.castle();
        const xy = g.castleXY(c) || { x: 400, y: 400 };
        cx = xy.x; cy = xy.y;
      }
      // Served from the session's block cache while fresh; fresh=1 re-reads it.
      const out = await SESSION.scanArea(cx, cy, r, { fresh: q.get('fresh') === '1' });
      return send(200, 'application/json', JSON.stringify(out));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ error: e.message })); }
  }

  // The panning map: ?blocks=440,280;460,280[&fresh=1] names up to 9 20x20
  // blocks by any point inside them (wrapped into the world, aligned to 20).
  // Cached blocks come straight back; the rest are asked for only over a live
  // socket — this never logs in. Returns {blocks, missing, skipped, offline,
  // fetched, cached, ttlMs, tiles, diplo} — diplo is the alliance's standing
  // with others, for the map's colours (Session.diplomacy).
  if (url.pathname === '/api/mapblocks') {
    try {
      const points = String(q.get('blocks') || '').split(';')
        .map((s) => s.split(',').map((v) => (v.trim() === '' ? NaN : Number(v))))
        .filter((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
        .map(([x, y]) => ({ x, y }));
      const out = await SESSION.mapBlocks(points, { fresh: q.get('fresh') === '1' });
      return send(200, 'application/json', JSON.stringify(out));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ error: e.message })); }
  }

  if (url.pathname === '/api/mapsearch') {
    return send(200, 'application/json', JSON.stringify(SESSION.searchCache(q.get('q'))));
  }

  if (url.pathname === '/api/market') {
    try {
      const g = await SESSION.connect();
      const out = {};
      for (const res of ['food', 'wood', 'stone', 'iron']) {
        const d = await g.searchTrades(res);
        const sellers = (d.sellers || []).map((s) => Number(s.price)).filter((x) => x > 0);
        const buyers = (d.buyers || []).map((s) => Number(s.price)).filter((x) => x > 0);
        out[res] = {
          bestAsk: sellers.length ? Math.min(...sellers) : null,
          bestBid: buyers.length ? Math.max(...buyers) : null,
          sellVolume: (d.sellers || []).reduce((n2, s) => n2 + Number(s.amount || 0), 0),
          buyVolume: (d.buyers || []).reduce((n2, s) => n2 + Number(s.amount || 0), 0),
          // The top of the book, best first, for the resource hover card.
          asks: (d.sellers || []).map((s) => ({ price: Number(s.price), amount: Number(s.amount || 0) }))
            .filter((s) => s.price > 0).sort((a, b) => a.price - b.price).slice(0, 5),
          bids: (d.buyers || []).map((s) => ({ price: Number(s.price), amount: Number(s.amount || 0) }))
            .filter((s) => s.price > 0).sort((a, b) => b.price - a.price).slice(0, 5),
        };
      }
      const cid = Number(q.get('city')) || g.castleId(g.castle());
      const mine = await g.myTrades(cid).catch(() => ({}));
      out.mine = mine.trades || mine.tradeList || [];
      return send(200, 'application/json', JSON.stringify(out));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ error: e.message })); }
  }

  if (url.pathname === '/api/config') {
    const env = loadEnv();
    return send(200, 'application/json', JSON.stringify({
      server: env.EVONY_SERVER || 'ss71',
      email: env.EVONY_EMAIL || '',
      hasPassword: !!env.EVONY_PASSWORD,
      names: ORG.settings.get('watchlist', ['WhoAreYou']),
    }));
  }

  if (url.pathname === '/goals' || url.pathname === '/goals.html') {
    return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'public', 'goals.html')));
  }

  if (url.pathname === '/api/goals' && req.method === 'POST') {
    const b = await body(req);
    const { parseGoals, describe } = require('./goals');
    const parsed = parseGoals(b.src || '');
    // The editor's colours ask this on every pause in typing: the parse and its
    // per-line standing only. A check never saves, whatever else it is sent.
    if (b.check) return send(200, 'application/json', JSON.stringify({ ok: true, errors: parsed.errors, lines: parsed.lines }));
    let saved = null, scriptCleared = false;
    if (b.save) {
      const key = String(b.city || 'default').trim() || 'default';
      const acct = SESSION.account && SESSION.account.id;
      ORG.goals.set(acct, key, b.kind === 'script' ? 'script' : 'goal', b.src);
      saved = key;
      // Saving a city's goals is NEAT's Set Goals, which puts back what a script
      // changed there (wiki Config): the city's script goal layer ends.
      if (b.kind !== 'script' && /^\d+$/.test(key) && require('./goallayers').clearScriptLayer(acct, key)) {
        scriptCleared = true;
        const g = SESSION.game, c = g && (g.castles || []).find((x) => String(g.castleId(x)) === key);
        SESSION.note(`script goals cleared: ${(c && c.name) || 'the city'}'s goals were saved`, { city: (c && c.name) || null, kind: 'sys' });
      }
    }
    return send(200, 'application/json', JSON.stringify({
      ok: true, errors: parsed.errors, lines: parsed.lines, described: describe(parsed), saved, scriptCleared,
      engineNote: (SESSION.userPaused
        ? 'Saved. The engine is PAUSED — these take effect when you resume it.'
        : 'Saved. The engine picks these up on its next tick.')
        + (scriptCleared ? ' The goals a script had set here were dropped.' : ''),
    }));
  }

  // The account-wide texts behind the editor's selector (goallayers.js): the
  // new-city template, the Prepend and Append goals every city runs around its
  // own, and the new-city script.
  //   GET  /api/goals/account?which=template|prepend|append|script
  //   POST /api/goals/account {which, src, save}  -> {errors (with where), described, note}
  if (url.pathname === '/api/goals/account') {
    const G = require('./goallayers');
    const acct = SESSION.account && SESSION.account.id;
    try {
      if (!ORG || !acct) throw new Error('this console has no account to keep account-wide goals under');
      // a prepend/append text the Director keeps in step with a file (goalfiles.js)
      const fileOf = (which) => ORG.settings.get(`goalFile:${which}:${acct}`, null) || null;
      if (req.method !== 'POST') {
        const r = G.readText(ORG.goals, acct, q.get('which'));
        r.file = fileOf(r.which);
        return send(200, 'application/json', JSON.stringify(r));
      }
      const b = await body(req);
      const r = G.saveText(ORG.goals, acct, b);
      r.file = fileOf(r.which);
      if (r.saved) {
        if (SESSION.userPaused && (r.which === 'prepend' || r.which === 'append')) r.note = 'Saved. The engine is PAUSED — these take effect when you resume it.';
        if (r.file) r.note = `${r.note || 'Saved.'} The Director puts ${r.file} back over this within 15 seconds — edit the file instead.`;
        SESSION.note(`${r.label} saved from the console (${G.goalLines(b.src)} line(s))`);
      }
      return send(200, 'application/json', JSON.stringify(r));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }

  // A city's script goal layer (goallayers.js): goal lines scripts ran there,
  // held in memory over its saved goals until cleared.
  //   GET  /api/goals/script?city=<id>          -> { ok, layer: {src, setAt, base, loaded, count} | null }
  //   POST /api/goals/script {city, clear: true} -> { ok, cleared }
  if (url.pathname === '/api/goals/script') {
    const G = require('./goallayers');
    const acct = SESSION.account && SESSION.account.id;
    try {
      const b = req.method === 'POST' ? await body(req) : {};
      const city = String(b.city ?? q.get('city') ?? '').trim();
      if (!/^\d+$/.test(city)) throw new Error('script goals belong to a city — open one first');
      if (req.method !== 'POST') return send(200, 'application/json', JSON.stringify({ ok: true, city, layer: G.getScriptLayer(acct, city) }));
      if (!b.clear) throw new Error('the console only clears script goals; scripts set them');
      const cleared = G.clearScriptLayer(acct, city);
      if (cleared) {
        const g = SESSION.game, c = g && (g.castles || []).find((x) => String(g.castleId(x)) === city);
        SESSION.note(`script goals cleared from the console: ${(c && c.name) || 'the city'} runs its saved goals again`, { city: (c && c.name) || null, kind: 'sys' });
      }
      return send(200, 'application/json', JSON.stringify({ ok: true, cleared }));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }

  if (url.pathname === '/script' || url.pathname === '/script.html') {
    return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'public', 'script.html')));
  }

  if (url.pathname === '/api/script' && req.method === 'POST') {
    const b = await body(req);
    // The editor's colours: each line's standing, asked on every pause in typing.
    // It logs nothing and runs nothing. The page sends parseOnly with it, so a
    // console older than the page only parses too.
    if (b.parseOnly && b.lines) {
      return send(200, 'application/json', JSON.stringify({ ok: true, ...require('./script').lineStatus(b.src || '') }));
    }
    const env = loadEnv();
    const lines = [];
    const log = stamped((m) => { lines.push(m); console.log('[script] ' + m); });
    const { parse, run } = require('./script');
    const { Game } = require('./game');

    const actions = parse(b.src || '');
    const errors = scriptErrors(actions);
    log(`parsed ${actions.filter((a) => a.cmd !== 'error').length} action(s)` + (errors.length ? `, ${errors.length} error(s)` : ''));

    if (b.parseOnly) {
      for (const a of actions) log(a.cmd === 'error' ? `line ${a.line}: ERROR ${a.error}` : `line ${a.line}: ${a.cmd} ${JSON.stringify({ ...a, cmd: undefined, line: undefined, raw: undefined })}`);
      return send(200, 'application/json', JSON.stringify({ ok: true, log: lines, errors }));
    }

    // A script is one sequence; running it with lines missing is not what was
    // written, so it runs whole or not at all.
    if (errors.length) {
      for (const e of errors) log(`line ${e.line}: ERROR ${e.error}`);
      log('nothing was run — fix the error(s) and run it again');
      return send(200, 'application/json', JSON.stringify({ ok: false, log: lines, errors }));
    }

    // NEAT's Run box: a line number or a label to start at (blank: line 1).
    const from = startLineOf(b.startLine, actions);
    if (from.error) {
      log(from.error);
      log('nothing was run');
      return send(200, 'application/json', JSON.stringify({ ok: false, log: lines, errors }));
    }

    // A live run needs the page's runId: it is what keeps a Run the browser
    // sends again after a console restart from starting twice (claimRunId).
    // The console's Script tab sends one; the old /script page does not, so
    // it only dry-runs.
    if (b.dryRun !== true && !b.runId) {
      log('not started: a live run needs a runId, which the console\'s Script tab sends with every Run — the old /script page does not,'
        + ' so it can only do a dry run there; run it live from the Script tab');
      return send(200, 'application/json', JSON.stringify({ ok: false, log: lines, errors }));
    }
    // One run per city at a time, so Stop and the live output know which run
    // is meant — keyed by the city's castle id however the city was named (the
    // Script tab sends the id, the old page a name or an index, autorun the id).
    let key;
    try {
      const g = await SESSION.connect();
      key = String(g.castleId(g.castle(b.castle ?? b.city)));
    } catch (e) {
      log('ERROR: ' + e.message);
      log('nothing was run');
      return send(200, 'application/json', JSON.stringify({ ok: false, log: lines, errors }));
    }
    if (SCRIPT_RUNS.has(key)) {
      log('a script is already running in this city — stop it first');
      return send(200, 'application/json', JSON.stringify({ ok: false, log: lines, errors }));
    }
    if (b.runId && !claimRunId(String(b.runId).slice(0, 64))) {
      log('not started again: this Run was already started once, and the console restarted under it, so the browser sent it again — press Run to start it anew');
      return send(200, 'application/json', JSON.stringify({ ok: false, log: lines, errors }));
    }
    if (from.startLine) log(`starting at ${/^\d+$/.test(String(from.startLine)) ? 'line ' : 'label '}${from.startLine}`);
    // The console sends the open city tab as `city`. Reading only `castle`
    // ran every console script in the FIRST city, whichever tab was open.
    // Live unless a caller asks otherwise — only the old /script page still does.
    const started = runCityScript(key, actions, {
      castle: b.castle ?? b.city, lines, log: (m) => console.log('[script] ' + m),
      dryRun: b.dryRun === true, autoReq: !!b.autoReq, startLine: from.startLine, source: 'console',
    });
    // A live run is ANSWERED NOW, not when it ends. Waiting held one browser
    // connection open per running city, and a browser allows six to one origin:
    // with five endless `loop`s going, the sixth city's Run — and every other
    // request the page made, loadouts included — queued behind them, so the
    // console looked frozen and kept showing the city before. The run's output
    // and its ending are read from /api/script/runs from here on. A dry run is
    // short and has no such tab behind it (the old /script page), so it waits.
    // `wait: true` asks for the old behaviour — the reply comes when the run is
    // over. Only the tests and a caller with no tab behind it use it; the Script
    // tab must never send it, for the reason above.
    if (b.dryRun !== true && b.wait !== true) {
      started.catch((e) => console.log('[script] ' + key + ': ' + e.message));
      log('started — the Output tab follows it from here; Stop ends it');
      return send(200, 'application/json', JSON.stringify({ ok: true, started: true, city: key, log: lines.slice(), errors }));
    }
    const r = await started;
    if (r.busy) {
      log('a script is already running in this city — stop it first');
      return send(200, 'application/json', JSON.stringify({ ok: false, log: lines, errors }));
    }
    if (r.ok) log(`done — ${r.n} action(s) executed`);
    else log('ERROR: ' + r.error);
    const running = r.running;
    const kept = running.dropped ? [`(${running.dropped} earlier line(s) not kept)`, ...lines] : lines;
    return send(200, 'application/json', JSON.stringify({ ok: true, log: kept, errors, stopped: running.stop }));
  }

  // Stop a city's script after the line it is on; waits (sleep, @time, market
  // pacing) are cut short.
  if (url.pathname === '/api/script/stop' && req.method === 'POST') {
    const b = await body(req);
    const running = SCRIPT_RUNS.get(String(b.city ?? ''));
    if (!running) return send(200, 'application/json', JSON.stringify({ ok: false, error: 'no script is running in that city' }));
    running.stop = true;           // a run paused at `stop` sees it too, and ends
    return send(200, 'application/json', JSON.stringify({ ok: true }));
  }

  // A script paused at NEAT's `stop` carries on from the line after it.
  if (url.pathname === '/api/script/resume' && req.method === 'POST') {
    const b = await body(req);
    const running = SCRIPT_RUNS.get(String(b.city ?? ''));
    const no = !running ? 'no script is running in that city' : !running.paused ? 'the script in that city is not paused' : null;
    if (no) return send(200, 'application/json', JSON.stringify({ ok: false, error: no }));
    const p = running.paused;
    running.paused = null;
    p.resolve(true);
    return send(200, 'application/json', JSON.stringify({ ok: true, line: p.line, next: p.next }));
  }

  // Which cities have a script running, and ?city='s output so far — how the
  // page shows a long run as it goes, and finds runs again after a reload.
  // paused: {line, next, since} while a run waits at `stop`; source: console |
  // autorun Load N | ...
  if (url.pathname === '/api/script/runs') {
    const asked = q.get('city');
    // the run going on in that city, or — since a live Run is answered as it
    // starts — the last one that finished there, so the page can show its end
    const running = asked === null ? null : SCRIPT_RUNS.get(asked);
    const over = running || asked === null ? null : SCRIPT_DONE.get(asked) || null;
    const lines = (running || over) ? (running || over).lines : null;
    const tail = lines ? lines.slice(-400) : null;
    const held = running || over;
    return send(200, 'application/json', JSON.stringify({
      runs: [...SCRIPT_RUNS].map(([city, r]) => ({ city, startedAt: r.startedAt, stopping: r.stop,
        paused: r.paused ? { line: r.paused.line, next: r.paused.next, since: r.paused.since } : null, source: r.source || null })),
      lines: tail,
      dropped: held ? held.dropped + lines.length - tail.length : 0,
      ended: over ? { at: over.at, startedAt: over.startedAt, n: over.n, stopped: over.stopped, error: over.error, source: over.source } : null,
    }));
  }

  // What scripts said and played (say / play), for the open console tabs. Each
  // tab polls with its own id; ?after=<seq>&boot=<id> gets what came since.
  if (url.pathname === '/api/script/notify') {
    return send(200, 'application/json', JSON.stringify(NOTES.poll({ after: q.get('after'), boot: q.get('boot'), tab: q.get('tab') })));
  }
  // A sound `play` names, from the console's media folder only.
  if (url.pathname === '/api/script/media') {
    try {
      const m = SC.mediaFile(q.get('f'));
      const st = fs.statSync(m.file);
      if (!st.isFile() || st.size > 20 * 1024 * 1024) throw new Error('not a sound');
      res.writeHead(200, { 'Content-Type': SC.MEDIA_TYPES[path.extname(m.file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size, 'Cache-Control': 'no-store' });
      return fs.createReadStream(m.file).on('error', () => res.destroy()).pipe(res);
    } catch { return send(404, 'text/plain', 'no such sound'); }
  }

  // NEAT's command line: `\who Bob` typed in the chat box runs that in-line
  // command (the modules' `inline` tables, as `command "who Bob"` does) in the
  // open city, and answers with its output instead of sending it as chat.
  if (url.pathname === '/api/script/inline' && req.method === 'POST') {
    const b = await body(req);
    const text = String(b.text || '').trim().replace(/^\\/, '').trim();
    if (!text) return send(200, 'application/json', JSON.stringify({ ok: false, error: 'type \\ and an in-line command, e.g. \\who Bob' }));
    const S = require('./script');
    const lines = [];
    let result, error = null;
    try {
      const game = await SESSION.connect();
      // the text rides in as a value, so no quote in it can change the line
      const globals = { ottoInlineText: text, ottoInlineDone: (r, e) => { result = r; error = e || null; } };
      const view = S.parse('command ottoInlineText\nottoInlineDone($result, $error)', { globals });
      const bad = view.find((a) => a.cmd === 'error');
      if (bad) throw new Error(bad.error);
      await S.run(game, view, (m) => lines.push(m), {
        castle: b.city, session: SESSION, accountId: (SESSION.account && SESSION.account.id) || null,
        cityId: String(b.city ?? ''), globals, shouldStop: () => false,
      });
    } catch (e) { error = e.message; }
    const out = lines.filter((l) => !/^line 1: /.test(l)).map((l) => l.replace(/^ {2}/, ''));
    try { JSON.stringify(result); } catch { result = String(result); }
    return send(200, 'application/json', JSON.stringify({ ok: !error, error, lines: out,
      result: result === undefined ? null : result }));
  }

  // Script loadouts: numbered slots per CITY, so a city's Load 1 is its own and
  // saving it never changes another city's. Kept as goals rows of kind 'script'
  // keyed <cityId>:load<N>, read exactly (db.goals.loadouts). An emptied slot is
  // saved empty, not deleted: a city with no rows at all is one never opened,
  // and its first look copies in the account-wide slots the console used to
  // share between cities.
  if (url.pathname === '/api/loadouts') {
    const acct = SESSION.account && SESSION.account.id;
    try {
      const b = req.method === 'POST' ? await body(req) : {};
      const city = String(b.city ?? q.get('city') ?? '').trim();
      if (!/^\d+$/.test(city)) throw new Error('loadouts belong to a city — open one first');
      if (req.method === 'POST') {
        const slot = Number(b.slot);
        if (!Number.isInteger(slot) || slot < 1 || slot > LOADOUTS) throw new Error(`there is no loadout ${b.slot}`);
        const src = String(b.src || '');
        ORG.goals.set(acct, `${city}:load${slot}`, 'script', src.trim() ? src : '');
        return send(200, 'application/json', JSON.stringify({ ok: true, errors: scriptErrors(require('./script').parse(src)) }));
      }
      const slots = ORG.goals.loadouts(acct, city);
      return send(200, 'application/json', JSON.stringify({ ok: true, account: acct || null, city, count: LOADOUTS, slots }));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }

  if (url.pathname === '/api/scan' && req.method === 'POST') {
    const b = await body(req);
    const env = loadEnv();
    const lines = [];
    const log = (m) => { lines.push(m); console.log('[scan] ' + m); };
    const names = (b.names || []).map((s) => s.trim()).filter(Boolean);
    ORG.settings.set('watchlist', names);
    try {
      const rows = await runScan({ names }, log);
      return send(200, 'application/json', JSON.stringify({ ok: true, rows, log: lines }));
    } catch (e) {
      log('ERROR: ' + e.message);
      return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message, log: lines }));
    }
  }

  send(404, 'text/plain', 'not found');
});

const HOST = AUTH.bindHost();
server.listen(PORT, HOST, () => console.log(
  `
  Evony console -> http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`
  + `   auth ${AUTH.isEnabled() ? 'ON' : 'OFF (localhost only)'}
`));
