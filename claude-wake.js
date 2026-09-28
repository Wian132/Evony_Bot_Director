'use strict';
// Wake Claude when an account comes under a REAL attack (2026-09-28).
//
// The Director already asks every console for /api/session once a minute
// (director.js sampleUptime), and each answer carries underAttackView: the
// cities with attacks at or above their own defensepolicy /junktroop (1000 by
// default; an army of unknown size counts), each army with a stable key
// (session.js). This file looks at that, and for a NEW attack runs
//
//   claude -p "<prompt>" --mcp-config <otto, auto scope> --strict-mcp-config
//          --tools "" --allowedTools mcp__otto --permission-mode dontAsk
//          --output-format json --no-session-persistence
//
// in the repo folder, on the user's own Claude login (the Max subscription:
// any ANTHROPIC_API_KEY is taken out of the child's environment so the CLI
// falls back to that login). Claude gets no built-in tools at all — no shell,
// no files — only the otto MCP server's tools, and that server runs with
// OTTO_CLAUDE_MODE=auto, where the one acting route is the console's
// /api/claude/act, gated by the account's six switches (claude-perms.js).
//
// The user's rules, 2026-09-28:
//   * "1 wake up per attack". An attack is one ATTACKER against one account:
//     the attacker's alliance when it has one (an alliance hitting together is
//     one fight), else the lord, else the tile it marches from. Every wave of
//     that attacker landing within GROUP_GAP_MS (15 min) of the group's waves
//     is the same attack and wakes nobody; a wave landing further out is a new
//     attack. goal-war's attackGroups are per city and 6 s apart — they decide
//     how to hide, and live inside the console, where the Director cannot read
//     them — so the grouping here is its own, by attacker and window.
//   * each army key and each group is remembered in the database
//     (settings claudeWakeSeen) for a day, so a Director restart does not wake
//     again for an attack it already woke for
//   * junk never wakes: the console left it out of underAttackView already
//   * a fleet-wide cap, claudeWakeCap per hour (default 6), so an attack spread
//     over the whole fleet cannot burn the Max allowance; an attack over the
//     cap is logged as "capped" and never woken for later
//   * at most one Claude per account at once, and MAX_RUNNING overall; an
//     attack that comes while its account's Claude is still running is logged
//     as joined to that run (the running Claude sees it through its tools)
//   * the global switch (org settings claudeAutoWake) is OFF until the user
//     turns it on in the Director's Claude tab; while off nothing is noted, so
//     turning it on during an attack wakes for it
//   * every permission off still wakes: Claude can look and report/advise
//   * a run is killed after TIMEOUT_MS (10 min); nothing here blocks the
//     Director: the child is spawned and its end is filed when it comes
//
// Every wake is kept (settings claudeWakes, the newest 200): time, account,
// attack key, the prompt, the exit code and Claude's final answer — the
// Director's Claude tab shows them.
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const ROOT = __dirname;
const GROUP_GAP_MS = 15 * 60000;
const SEEN_KEEP_MS = 24 * 3600000;
const TIMEOUT_MS = Number(process.env.OTTO_WAKE_TIMEOUT_MS || 10 * 60000);
const DEFAULT_CAP = 6;
const MAX_RUNNING = 3;
const LOG_KEEP = 200;
const OUTPUT_KEEP = 20000;

const K_SEEN = 'claudeWakeSeen';       // install-wide: { accountId: { keys: {key: at}, groups: [...] } }
const K_LOG = 'claudeWakes';           // install-wide: [wake, ...] newest last
const K_CAP = 'claudeWakeCap';         // install-wide: wakes per hour, fleet-wide
const K_ON = 'claudeAutoWake';         // per org: true = wake on attack

// ------------------------------------------------------------ the command
// Which claude to run. On Windows `claude` on PATH is an npm .cmd shim, which
// cannot be spawned without a shell — and a shell would have to quote a
// multi-line prompt. The shim only runs node_modules/@anthropic-ai/claude-code/
// bin/claude.exe, so that is what is spawned. OTTO_CLAUDE_BIN overrides.
function claudeBin(env = process.env) {
  if (env.OTTO_CLAUDE_BIN) return env.OTTO_CLAUDE_BIN;
  if (process.platform !== 'win32') return 'claude';
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const exe = path.join(d, 'claude.exe');
    if (fs.existsSync(exe)) return exe;
    if (fs.existsSync(path.join(d, 'claude.cmd'))) {
      const inner = path.join(d, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (fs.existsSync(inner)) return inner;
    }
  }
  return 'claude';
}

// The MCP config handed to --mcp-config (as a JSON string, so no file is left
// behind): the otto server in auto scope, told which account woke it.
function mcpConfig(accountId, env = process.env) {
  const serverEnv = { OTTO_CLAUDE_MODE: 'auto', OTTO_WAKE_ACCOUNT: String(accountId || '') };
  if (env.EVONY_DB) serverEnv.EVONY_DB = env.EVONY_DB;
  return { mcpServers: { otto: { type: 'stdio', command: process.execPath, args: [path.join(ROOT, 'otto-mcp.js')], env: serverEnv } } };
}

// { cmd, args, env, cwd } for one wake.
function buildCommand(prompt, accountId, env = process.env) {
  const args = [
    '-p', prompt,
    '--mcp-config', JSON.stringify(mcpConfig(accountId, env)),
    '--strict-mcp-config',
    '--tools', '',                       // no built-in tools: no shell, no files
    '--allowedTools', 'mcp__otto',       // every tool of the otto server, nothing else
    '--permission-mode', 'dontAsk',      // anything not allowed above is refused, never asked
    '--output-format', 'json',
    '--no-session-persistence',
  ];
  const childEnv = { ...env };
  // the user's Max login, not an API key; and not "inside another Claude"
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete childEnv[k];
  return { cmd: claudeBin(env), args, env: childEnv, cwd: ROOT };
}

// The default launcher: spawn it, collect stdout, kill it at the timeout.
// Calls done({ code, signal, stdout, stderr, timedOut }) once.
function spawnLauncher({ cmd, args, env, cwd }, done, timeoutMs = TIMEOUT_MS) {
  let child;
  try {
    child = cp.spawn(cmd, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { setImmediate(() => done({ code: null, error: e.message, stdout: '', stderr: '' })); return { pid: null }; }
  let out = '', err = '', timedOut = false, finished = false;
  child.stdout.on('data', (b) => { if (out.length < 2e6) out += b; });
  child.stderr.on('data', (b) => { if (err.length < 2e5) err += b; });
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      // the MCP server is claude's child: take the whole tree
      if (process.platform === 'win32') cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else process.kill(-child.pid, 'SIGKILL');
    } catch { try { child.kill('SIGKILL'); } catch {} }
  }, timeoutMs);
  const finish = (r) => { if (finished) return; finished = true; clearTimeout(timer); done({ ...r, stdout: out, stderr: err, timedOut }); };
  child.on('error', (e) => finish({ code: null, error: e.message }));
  child.on('close', (code, signal) => finish({ code, signal }));
  return { pid: child.pid };
}

// ------------------------------------------------------------- the prompt
const hms = (ms) => new Date(ms).toISOString().slice(11, 19);
const localHms = (ms) => { const d = new Date(ms); const p = (x) => String(x).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const inText = (ms) => { const s = Math.round(ms / 1000); if (s < 0) return `${-s}s ago`; const m = Math.floor(s / 60); return m ? `in ${m}m${String(s % 60).padStart(2, '0')}s` : `in ${s}s`; };

function buildPrompt({ account, alias, attacker, cities, perms, labels, now }) {
  const P = require('./claude-perms');
  const L = labels || P.LABELS;
  const on = P.PERMS.filter((p) => perms && perms[p]);
  const off = P.PERMS.filter((p) => !(perms && perms[p]));
  const lines = [];
  lines.push(`OTTObot woke you: an Evony Age 1 account in the user's fleet is under a real attack.`);
  lines.push('');
  lines.push(`Account: ${account.id}${alias ? ` (${alias})` : ''}, lord "${account.label || account.id}", server ${account.server || 'ss71'}.`);
  lines.push(`Attacker: ${attacker}.`);
  lines.push(`Now: server ${hms(now)} (UTC), local ${localHms(now)}.`);
  lines.push('');
  lines.push('Cities hit (only attacks at or above the city\'s defensepolicy /junktroop are listed; a troop count of "unknown" means not scouted, which counts as real):');
  for (const c of cities) {
    lines.push(`- ${c.name}${c.id !== undefined && c.id !== null ? ` [castle ${c.id}]` : ''} — loyalty ${c.loyalty ?? '?'}, junk line ${c.junkLine ?? 1000}${c.junk ? `, ${c.junk} junk army(ies) ignored` : ''}`);
    for (const a of c.real || []) {
      const t = a.reachTime ? `lands server ${hms(a.reachTime)} / local ${localHms(a.reachTime)} (${inText(a.reachTime - now)})` : 'landing time unknown';
      lines.push(`    * ${a.troops === null || a.troops === undefined ? 'unknown' : a.troops} troops from ${a.king || '?'}${a.alliance ? ` [${a.alliance}]` : ''} at ${a.from || '?'} — ${t} (key ${a.key})`);
    }
  }
  lines.push('');
  lines.push(`Permissions the user has given you on THIS account: ${on.length ? on.map((p) => `${p} (${L[p]})`).join(', ') : 'NONE'}.`);
  if (off.length) lines.push(`Not given: ${off.map((p) => `${p} (${L[p]})`).join(', ')} — the act tool refuses these; do not try to get around it.`);
  lines.push('');
  lines.push('Your job is purely to KEEP THINGS ALIVE: the cities, the troops, the heroes, the loyalty. No counter-attacks, no marches at the attacker, nothing offensive, nothing that spends gold or items beyond what a permission above covers.');
  lines.push('Use the otto tools to look first (state, events, log, wait). Act ONLY through the act tool, and only within the permissions above. If nothing is allowed or nothing is needed, say what you would advise the user to do.');
  lines.push('Never log anything in, never restart a console, never take an account off holiday.');
  lines.push('Finish with a short report: what you saw (attacker, cities, troops, times, loyalty) and exactly what you did, with each act\'s result.');
  return lines.join('\n');
}

// ------------------------------------------------------------- the waker
// deps: { D (db.js), perms (claude-perms), launch (spawnLauncher-like),
//         now(), note(msg), aliasOf(accountId), env }
function create(deps = {}) {
  const D = deps.D || require('./db');
  const P = deps.perms || require('./claude-perms');
  const launch = deps.launch || spawnLauncher;
  const now = deps.now || Date.now;
  const note = deps.note || (() => {});
  const env = deps.env || process.env;
  const aliasOf = deps.aliasOf || defaultAliasOf;
  const running = new Map();          // wake id -> accountId

  // A run the Director was waiting on when it stopped never reports back.
  try {
    const log = D.settings.get(K_LOG, []) || [];
    let changed = false;
    for (const w of log) if (w.status === 'running') { w.status = 'lost'; w.output = (w.output || '') + '(the Director restarted while it ran; its answer was not kept)'; changed = true; }
    if (changed) D.settings.set(K_LOG, log);
  } catch { /* a fresh database */ }

  const orgSettings = (orgId) => { try { return orgId ? D.org(orgId).settings : D.settings; } catch { return D.settings; } };
  const isOn = (orgId) => orgSettings(orgId).get(K_ON, false) === true;
  const setOn = (orgId, on) => orgSettings(orgId).set(K_ON, !!on);
  const cap = () => { const c = Number(D.settings.get(K_CAP, DEFAULT_CAP)); return Number.isFinite(c) && c >= 0 ? c : DEFAULT_CAP; };
  const setCap = (n) => D.settings.set(K_CAP, Math.max(0, Math.round(Number(n) || 0)));
  const readLog = () => D.settings.get(K_LOG, []) || [];
  const writeLog = (log) => D.settings.set(K_LOG, log.slice(-LOG_KEEP));
  const addLog = (w) => { const log = readLog(); log.push(w); writeLog(log); };
  const patchLog = (id, patch) => { const log = readLog(); const w = log.find((x) => x.id === id); if (w) Object.assign(w, patch); writeLog(log); return w; };
  const wakesLastHour = () => readLog().filter((w) => (w.status !== 'capped' && w.status !== 'joined') && now() - w.at < 3600000).length;

  // Who an army belongs to, for grouping: the alliance, else the lord, else its tile.
  const attackerOf = (a) => (a.alliance ? `alliance ${a.alliance}` : a.king ? `lord ${a.king}` : `from ${a.fromFieldId ?? a.from ?? '?'}`);

  // Look at one console's underAttack answer. Returns what it did, for tests.
  function observe({ orgId, account, underAttack }) {
    const did = [];
    if (!account || !account.id || !underAttack || !Array.isArray(underAttack.cities)) return did;
    if (!isOn(orgId)) return did;
    const t = now();
    const seenAll = D.settings.get(K_SEEN, {}) || {};
    const seen = seenAll[account.id] || { keys: {}, groups: [] };
    // prune what is a day old
    for (const [k, at] of Object.entries(seen.keys)) if (t - at > SEEN_KEEP_MS) delete seen.keys[k];
    seen.groups = (seen.groups || []).filter((g) => t - (g.at || 0) < SEEN_KEEP_MS);

    // the new real armies, grouped by attacker
    const fresh = new Map();              // attacker -> { armies: [], cities: Map }
    for (const c of underAttack.cities) {
      for (const a of Array.isArray(c.real) ? c.real : []) {
        if (!a || !a.key) continue;
        // one that has already landed is not an attack to wake for
        if (a.reachTime && a.reachTime < t - 60000) continue;
        const k = String(a.key);
        if (seen.keys[k]) continue;
        seen.keys[k] = t;
        const who = attackerOf(a);
        if (!fresh.has(who)) fresh.set(who, { armies: [], cities: new Map() });
        const f = fresh.get(who);
        f.armies.push(a);
        if (!f.cities.has(c.name)) f.cities.set(c.name, { ...c, real: [] });
        f.cities.get(c.name).real.push(a);
      }
    }
    for (const [who, f] of fresh) {
      const times = f.armies.map((a) => Number(a.reachTime) || t);
      const first = Math.min(...times), last = Math.max(...times);
      // the same attacker's waves close to a group already woken for: one attack
      const g = seen.groups.find((x) => x.who === who && first <= x.last + GROUP_GAP_MS && last >= x.first - GROUP_GAP_MS);
      if (g) {
        g.first = Math.min(g.first, first); g.last = Math.max(g.last, last);
        did.push({ kind: 'same-attack', who, keys: f.armies.map((a) => a.key), wake: g.wake });
        continue;
      }
      const group = { who, first, last, at: t, wake: null };
      seen.groups.push(group);
      const cities = [...f.cities.values()];
      const base = { at: t, orgId: orgId || null, accountId: account.id, label: account.label || account.id,
        attacker: who, key: `${account.id}|${who}|${first}`, keys: f.armies.map((a) => a.key),
        cities: cities.map((c) => c.name) };
      const busy = [...running.values()].includes(account.id);
      if (busy) {
        const w = { ...base, id: newId(t), status: 'joined', output: 'a Claude was already running for this account; this attack was left to it' };
        addLog(w); group.wake = w.id; did.push({ kind: 'joined', who, id: w.id });
        continue;
      }
      if (wakesLastHour() >= cap() || running.size >= MAX_RUNNING) {
        const why = running.size >= MAX_RUNNING ? `${MAX_RUNNING} Claudes are already running` : `the cap of ${cap()} wakes an hour is reached`;
        const w = { ...base, id: newId(t), status: 'capped', output: `not woken: ${why}` };
        addLog(w); group.wake = w.id; did.push({ kind: 'capped', who, id: w.id });
        note(`${account.label || account.id}: attack by ${who} — Claude NOT woken (${why})`);
        continue;
      }
      const perms = P.get(account.id);
      const prompt = buildPrompt({ account, alias: aliasOf(account.id), attacker: who, cities, perms, now: t });
      const cmd = buildCommand(prompt, account.id, env);
      const w = { ...base, id: newId(t), status: 'running', prompt, perms, exitCode: null, output: null };
      addLog(w); group.wake = w.id;
      running.set(w.id, account.id);
      note(`${account.label || account.id}: real attack by ${who} on ${w.cities.join(', ')} — waking Claude (${Object.values(perms).filter(Boolean).length}/6 permissions on)`);
      let h = null;
      try {
        h = launch(cmd, (r) => {
          running.delete(w.id);
          let text = r.stdout || '';
          try { const j = JSON.parse(text); text = j.result !== undefined ? String(j.result) : text; } catch { /* plain text */ }
          if (!text && r.stderr) text = String(r.stderr);
          if (r.error) text = `${text ? text + '\n' : ''}could not run claude: ${r.error}`;
          const status = r.timedOut ? 'timeout' : r.code === 0 ? 'done' : 'error';
          patchLog(w.id, { status, exitCode: r.code ?? null, endedAt: now(), output: String(text).slice(0, OUTPUT_KEEP) });
          note(`${account.label || account.id}: Claude ${status === 'done' ? 'finished' : status === 'timeout' ? 'was stopped after the time limit' : `ended with code ${r.code}`}`);
        }, TIMEOUT_MS);
      } catch (e) {
        running.delete(w.id);
        patchLog(w.id, { status: 'error', endedAt: now(), output: 'could not run claude: ' + e.message });
      }
      if (h && h.pid) patchLog(w.id, { pid: h.pid });
      did.push({ kind: 'woke', who, id: w.id, cmd });
    }
    seenAll[account.id] = seen;
    D.settings.set(K_SEEN, seenAll);
    return did;
  }

  // For the Director's Claude tab: this org's wakes, newest first.
  function wakes(orgId, limit = 50) {
    return readLog().filter((w) => !orgId || !w.orgId || w.orgId === orgId).slice(-limit).reverse();
  }

  return { observe, wakes, isOn, setOn, cap, setCap, wakesLastHour, running: () => running.size };
}

let seq = 0;
const newId = (t) => `w${t.toString(36)}${(seq++).toString(36)}`;

// The account's alias (Lord02) from privacy.local.json, when this install has one.
function defaultAliasOf(accountId) {
  try {
    const m = require('./privacy').loadMap();
    for (const [alias, a] of Object.entries(m.aliases || {})) if (a && a.id === accountId) return alias;
  } catch { /* no privacy map */ }
  return null;
}

module.exports = { create, buildCommand, buildPrompt, mcpConfig, claudeBin, spawnLauncher,
  GROUP_GAP_MS, DEFAULT_CAP, TIMEOUT_MS, K_SEEN, K_LOG, K_CAP, K_ON };
