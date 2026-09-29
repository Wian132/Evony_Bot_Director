'use strict';
// Starting and stopping a bot console for one account.
//
// ONE CONSOLE PER ACCOUNT. A second login for the same account gets kicked, so
// every account needs its own `node server.js` on its own port. Doing that by
// hand is the step that got forgotten: an account added in the Director sat in
// the fleet list with no bot behind it, and clicking it only ever printed the
// command you were supposed to run yourself. The Director now calls in here the
// moment an account is saved, and this module owns everything that goes with a
// console: a free port, the process, and its uptime probe.
//
// Also usable from the command line, for an account that predates all this:
//
//   node botctl.js start a3        # start (or adopt) the console for a3
//   node botctl.js stop a3
//   node botctl.js list
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const AUTH = require('./auth');
const LOCK = require('./account-lock');

// Consoles take the odd ports from 8711 up, which leaves the Director's 8712
// where it has always been.
const BASE = Number(process.env.BOT_PORT_BASE || 8711);
const STEP = Number(process.env.BOT_PORT_STEP || 2);
const SPAN = Number(process.env.BOT_PORT_SPAN || 100);     // how many ports to try
const DIRECTOR_PORT = Number(process.env.DIRECTOR_PORT || 8712);
// A console has to read config.xml, log in and build its first snapshot before
// it answers with an account, and a throttled login can sit for a while.
const READY_MS = Number(process.env.BOT_READY_MS || 45000);
// Where a console's stdout and stderr land. Beside the code, as console-a1.log
// has always been; the test sends them somewhere temporary.
const LOG_DIR = process.env.BOT_LOG_DIR || __dirname;
// What a console IS. server.js in every real case; a test points it at a stub so
// starting a console costs no login.
const SCRIPT = process.env.BOT_SCRIPT || 'server.js';
// A console's JS heap ceiling. Node's default on this machine is ~4 GB, so a leak
// ran for hours before it crashed; an idle console's heap is 20-40 MB, a trading
// one's well under this. 0 = Node's default.
const HEAP_MB = Number(process.env.BOT_HEAP_MB ?? 512);
// A console log over this size is moved to console-<id>.log.1 (replacing the old
// one) when the console starts: a trading console writes hundreds of MB a day.
const LOG_ROTATE_BYTES = Number(process.env.BOT_LOG_ROTATE_MB ?? 50) * 1048576;
// A console's exit code when another console already holds its account (server.js).
const REFUSED_HELD = 3;

function rotateLog(file) {
  try {
    if (LOG_ROTATE_BYTES > 0 && fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, file + '.1');
  } catch { /* no log yet, or it is held open: keep appending */ }
}

const DEFAULT_PROBES = [{ probe: 'console', url: 'http://localhost:8711' }];

const portOf = (url) => { try { return Number(new URL(String(url)).port) || 0; } catch { return 0; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The probe list as the Director reads it, defaults included: those ports are
// taken whether or not anyone wrote them down.
function probeList(org) {
  const p = org.settings.get('probes', null);
  return Array.isArray(p) && p.length ? p.slice() : DEFAULT_PROBES.slice();
}
// The stored list, for writing back. Never the defaults — persisting those would
// invent a probe for a console nobody started, and the uptime page would then
// report a bot that never existed as down.
function storedProbes(org) {
  const p = org.settings.get('probes', null);
  return Array.isArray(p) ? p.slice() : [];
}

// What this module started, so it can be stopped again after a Director restart.
function bots(org) { return org.settings.get('bots', {}) || {}; }
function remember(org, id, rec) {
  const all = bots(org);
  if (rec) all[id] = rec; else delete all[id];
  org.settings.set('bots', all);
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ------------------------------------------------------------------ ports
function free(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function pickPort(org) {
  const taken = new Set([DIRECTOR_PORT]);
  for (const pr of probeList(org)) taken.add(portOf(pr.url));
  for (const rec of Object.values(bots(org))) taken.add(Number(rec.port));
  for (let i = 0; i < SPAN; i++) {
    const port = BASE + i * STEP;
    if (taken.has(port)) continue;
    if (await free(port)) return port;
  }
  return null;
}

// ---------------------------------------------------------------- consoles
function ask(url, timeout = 2000) {
  return new Promise((resolve) => {
    const opts = { timeout, headers: { 'x-otto-internal': AUTH.internalToken() } };
    const req = http.get(url.replace(/\/$/, '') + '/api/session', opts, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Is a console already holding this account? Asked of every probe, and of the
// port we have on record — starting a second one would make the game kick the
// first, and the two supervisors would then fight over the login.
async function running(org, acc) {
  const urls = probeList(org).map((p) => String(p.url || '').replace(/\/$/, ''));
  const rec = bots(org)[acc.id];
  if (rec && rec.url && !urls.includes(rec.url)) urls.push(rec.url);
  for (const url of urls) {
    const h = await ask(url);
    if (h && h.account && h.account.id === acc.id) return { url, port: portOf(url), session: h };
  }
  // A console that is still starting answers nobody yet, but it took the account's
  // lock first thing (account-lock.js). Without this the Director's keep-on round
  // saw "no console" in the seconds between glitch-run.js killing a console and its
  // replacement answering, and started a second one (a23 and a27, 2026-09-29).
  const w = await LOCK.who(acc.id);
  if (w && w.pid !== process.pid) {
    const url = w.port ? `http://localhost:${w.port}` : null;
    return { url, port: w.port || null, pid: w.pid || null, session: null, starting: true };
  }
  return null;
}

// ----------------------------------------------------- who holds which account
// Every console on this machine and the account it holds, whether or not anything
// wrote it down. The probe list holds one URL per account, so a second console for
// an account is invisible to everything that walks it: the Fleet page and fleet()
// showed a23 and a27 as merely "kicked" for an hour on 2026-09-29 while each had
// two consoles fighting. On Linux the processes themselves are read (/proc), which
// also finds a console that never got its HTTP port. Everywhere, every console
// port in the range is asked who it holds. `known` is { port, pid, accountId }
// rows the caller has already asked, so their ports are not asked again.
function consoleProcs() {
  if (process.platform !== 'linux') return [];
  const out = [];
  const script = path.basename(SCRIPT);
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return out; }
  for (const d of pids) {
    try {
      const argv = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0');
      if (!argv.some((a) => path.basename(a) === script)) continue;
      if (fs.readlinkSync(`/proc/${d}/cwd`) !== __dirname) continue;       // another install
      const env = Object.fromEntries(fs.readFileSync(`/proc/${d}/environ`, 'utf8').split('\0')
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      if (!env.ACCOUNT_ID) continue;
      out.push({ pid: Number(d), port: Number(env.CONSOLE_PORT) || null, accountId: env.ACCOUNT_ID, via: 'process' });
    } catch { /* gone, or not ours to read */ }
  }
  return out;
}

function listening(port, timeout = 400) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function sweep({ known = [] } = {}) {
  const found = [...consoleProcs()];
  for (const k of known) if (k && k.accountId && !found.some((f) => (k.pid && f.pid === k.pid) || (k.port && f.port === k.port))) found.push({ ...k, via: 'probe' });
  const seen = new Set(found.map((f) => f.port).filter(Boolean));
  const ports = [];
  for (let i = 0; i < SPAN; i++) {
    const p = BASE + i * STEP;
    if (p !== DIRECTOR_PORT && !seen.has(p)) ports.push(p);
  }
  await Promise.all(ports.map(async (port) => {
    if (!(await listening(port))) return;
    const h = await ask(`http://localhost:${port}`, 3000);
    if (h && h.account && h.account.id) found.push({ pid: (h.proc && h.proc.pid) || null, port, accountId: h.account.id, via: 'port' });
  }));
  const by = new Map();
  for (const f of found) {
    const list = by.get(f.accountId) || [];
    if (!list.some((x) => (f.pid && x.pid === f.pid) || (!f.pid && f.port && x.port === f.port))) list.push(f);
    by.set(f.accountId, list);
  }
  const dupes = [...by].filter(([, l]) => l.length > 1)
    .map(([accountId, l]) => ({ accountId, consoles: l.sort((a, b) => (a.port || 0) - (b.port || 0)) }));
  return { consoles: found, dupes };
}

// The probe list is how the Director finds a console at all: the uptime sampler
// walks it, and the Fleet tab learns which port an account is on from whoever
// answers. An unregistered console is invisible, so this is not optional.
//
// A trading console that runs out of memory gets restarted on a new port every
// few hours (EVONY-RULES.md, 2026-09-20), and used to leave its old probe entry
// behind: dropping by port only removes the entry for the port being reused,
// never the account's previous one, so a fleet running for days piled up a dead
// probe per crash. Dropping by accountId too means an account only ever has one
// entry, whatever port it lands on next.
function registerProbe(org, acc, url) {
  const list = storedProbes(org).filter((p) => portOf(p.url) !== portOf(url) && p.accountId !== acc.id);
  let name = String(acc.label || acc.id).trim() || acc.id;
  if (list.some((p) => p.probe === name)) name = `${name} (${acc.id})`;
  list.push({ probe: name, url, accountId: acc.id });
  org.settings.set('probes', list);
  return name;
}

function dropProbe(org, url) {
  const list = storedProbes(org);
  const keep = list.filter((p) => portOf(p.url) !== portOf(url));
  if (keep.length !== list.length) org.settings.set('probes', keep);
}

function tail(file, lines = 6) {
  try {
    const t = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    return t.slice(-lines).join(' | ');
  } catch { return ''; }
}

// A console started for an account with no goals of its own starts PAUSED. The
// engine is the part that acts in the game, and a brand new account has not been
// looked at yet — pausing means you can log in, see the cities and set the goals
// before anything marches. Press Resume in the console when it should run.
function hasGoals(org, acc) {
  try {
    const row = org.goals.find(acc.id, ['default'], 'goal');
    return !!(row && row.src && row.src.trim());
  } catch { return false; }
}

// NEAT's start-up parameters, kept by the Director: the fleet's (NEAT's Custom
// Parameters, which every bot gets) and the account's own, which win. A console
// gets them on its command line, as NEAT's Director hands them to a bot, and
// reads them over CmdParms.txt (script-console.js). They apply from a console's
// next start. -> { text: { fleet, account }, parms, args }
const PARMS_KEY = 'startupParms';
function startupParms(org, accId) {
  const SC = require('./script-console');
  const fleet = String(org.settings.get(PARMS_KEY, '') || '');
  const account = accId ? String(org.settings.get(`${PARMS_KEY}:${accId}`, '') || '') : '';
  const parms = { ...SC.parseCmdParms(fleet), ...SC.parseCmdParms(account) };
  return { text: { fleet, account }, parms, args: SC.parmsToArgs(parms) };
}

// One thing at a time per account. The Director reaches start and stop from
// several places at once — the on/off switch, a restart, the keep-on watchdog —
// and two starts racing for one account is exactly the pair of consoles that
// fight over a login. Each account's calls queue behind one another; different
// accounts do not wait on each other.
const chains = new Map();
function serial(id, fn) {
  const run = (chains.get(id) || Promise.resolve()).then(() => fn());
  const tail = run.catch(() => {});
  chains.set(id, tail);
  tail.then(() => { if (chains.get(id) === tail) chains.delete(id); });
  return run;
}
// Something is being started or stopped for this account right now.
const busy = (id) => chains.has(id);

const start = (org, acc, opts = {}) => serial(acc && acc.id, () => startNow(org, acc, opts));
const stop = (org, acc, opts = {}) => serial(acc && acc.id, () => stopNow(org, acc, opts));
// Stop then start as one turn, so nothing else can start the account in between
// and leave the restart adopting somebody else's console.
const restart = (org, acc, opts = {}) => serial(acc && acc.id, async () => {
  await stopNow(org, acc, opts).catch(() => {});
  return startNow(org, acc, opts);
});

// Start the console for one account, or adopt the one already running it.
// Resolves to { ok, adopted, url, port, pid, probe, paused, ready, error }.
async function startNow(org, acc, opts = {}) {
  const note = opts.note || (() => {});
  if (!acc || !acc.id) return { ok: false, error: 'no account' };
  if (!acc.email || !acc.password) {
    return { ok: false, error: `${acc.label || acc.id} has no email/password yet — a console cannot log in without them` };
  }
  // Read now, not from the copy the caller holds: a start queued a moment ago
  // (the keep-on watchdog's, say) must not bring up a console for an account
  // that has been switched off since. Off means nothing plays it.
  const now = org.accounts.get(acc.id);
  if (now && now.enabled === false) {
    return { ok: false, off: true, error: `${acc.label || acc.id} is switched off — switch it on to start its console` };
  }

  const held = await running(org, acc);
  if (held && !held.url) {
    return { ok: false, error: `${acc.label || acc.id} is already held by a console (pid ${held.pid || '?'}) that does not say its port yet — not starting a second` };
  }
  if (held) {
    // Adopt it: the process is there, it may just never have been written down.
    const probe = registerProbe(org, acc, held.url);
    remember(org, acc.id, { ...(bots(org)[acc.id] || {}), url: held.url, port: held.port, probe, at: Date.now() });
    note(`${acc.label}: already running on ${held.url}`);
    return { ok: true, adopted: true, url: held.url, port: held.port, probe, ready: true };
  }

  const port = Number(opts.port) || await pickPort(org);
  if (!port) return { ok: false, error: `no free console port in ${BASE}..${BASE + SPAN * STEP}` };
  const url = `http://localhost:${port}`;
  const sp = startupParms(org, acc.id);
  // A console starts with its engine live: if the bot is on, its goals are on
  // (the user, 2026-09-18) — its own, the prepend and the append goals alike.
  // Only an explicit -autorun 0 (NEAT's "no auto goals") starts it paused.
  const goalsOff = sp.parms.autorun !== undefined && !require('./script-console').switchOn(sp.parms.autorun);
  const paused = opts.paused !== undefined ? !!opts.paused : goalsOff;

  const outFile = path.join(LOG_DIR, `console-${acc.id}.log`), errFile = path.join(LOG_DIR, `console-${acc.id}.err.log`);
  rotateLog(outFile); rotateLog(errFile);
  const out = fs.openSync(outFile, 'a');
  const err = fs.openSync(errFile, 'a');
  const env = { ...process.env, CONSOLE_PORT: String(port), ACCOUNT_ID: acc.id };
  if (paused) env.ENGINE_PAUSED = '1'; else delete env.ENGINE_PAUSED;
  // Detached and unref'd on purpose: the console outlives the Director, exactly
  // as it does when started by hand. Restarting the Director must not take the
  // bots down with it.
  // server.js in every real case; the test points it at a stub that exits, to
  // prove a console that dies on startup is reported and rolled back.
  const heap = HEAP_MB > 0 ? [`--max-old-space-size=${HEAP_MB}`] : [];
  const child = spawn(process.execPath, [...heap, opts.script || SCRIPT, ...sp.args], {
    cwd: __dirname, env, detached: true, windowsHide: true, stdio: ['ignore', out, err],
  });
  child.unref();
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  child.on('error', (e) => { exited = e.message; });

  const probe = registerProbe(org, acc, url);
  remember(org, acc.id, { pid: child.pid, port, url, probe, at: Date.now(), paused, args: sp.args });
  note(`${acc.label}: starting a console on ${url} (pid ${child.pid}${paused ? ', engine paused' : ''}`
    + `${sp.args.length ? `, start-up parameters ${sp.args.join(' ')}` : ''})`);

  // Wait for it to answer with this account. Until it does we cannot tell a
  // console that is logging in from one that died on startup.
  const deadline = Date.now() + (Number(opts.readyMs) || READY_MS);
  while (Date.now() < deadline) {
    if (exited !== null) {
      remember(org, acc.id, null);
      dropProbe(org, url);
      fs.closeSync(out); fs.closeSync(err);
      // Exit 3: another console took the account's lock first (server.js). That one
      // is the console for the account now; write it down, or the probe list we
      // just cleared leaves it invisible and the next keep-on round tries again.
      const w = exited === REFUSED_HELD ? await LOCK.who(acc.id) : null;
      if (w && w.port) {
        const hurl = `http://localhost:${w.port}`;
        const hprobe = registerProbe(org, acc, hurl);
        remember(org, acc.id, { pid: w.pid || null, port: w.port, url: hurl, probe: hprobe, at: Date.now() });
        note(`${acc.label}: another console already holds it on ${hurl} (pid ${w.pid || '?'}) — adopted that one, no second console`);
        return { ok: true, adopted: true, url: hurl, port: w.port, pid: w.pid || null, probe: hprobe, ready: false };
      }
      const why = tail(path.join(LOG_DIR, `console-${acc.id}.err.log`)) || `exit ${exited}`;
      note(`${acc.label}: the console stopped straight away — ${why}`);
      return { ok: false, error: why, port, url };
    }
    const h = await ask(url, 1500);
    if (h && h.account && h.account.id === acc.id) {
      note(`${acc.label}: console up on ${url}${paused ? ' — engine PAUSED, press Resume when its goals are set' : ''}`);
      return { ok: true, url, port, pid: child.pid, probe, paused, ready: true };
    }
    await sleep(1000);
  }
  // Still alive but not logged in yet: a throttled or maintenance login can take
  // minutes. The probe is registered, so the uptime page owns it from here.
  note(`${acc.label}: console on ${url} is up but not logged in yet — watch it on the Uptime tab`);
  return { ok: true, url, port, pid: child.pid, probe, paused, ready: false };
}

// Stop the console this module started for an account. Only ever a console we
// have on record: another session's manually started bot is not ours to kill.
async function stopNow(org, acc, opts = {}) {
  const note = opts.note || (() => {});
  const rec = bots(org)[acc.id];
  if (!rec) return { ok: false, error: `no console on record for ${acc.label || acc.id}` };
  if (rec.pid && alive(rec.pid)) {
    try { process.kill(rec.pid); } catch (e) { return { ok: false, error: e.message }; }
    // Wait for the port to go quiet. A kill is not instant, and a start that
    // follows one — the Director restarts a console this way — would otherwise
    // find the dying console still answering and adopt it, leaving the bot
    // un-restarted and its pid unknown.
    for (let i = 0; i < 25 && (alive(rec.pid) || await ask(rec.url, 400)); i++) await sleep(200);
    note(`${acc.label || acc.id}: stopped the console on ${rec.url} (pid ${rec.pid})`);
  } else {
    note(`${acc.label || acc.id}: no console process was running on ${rec.url}`);
  }
  if (!opts.keepProbe) dropProbe(org, rec.url);
  remember(org, acc.id, null);
  return { ok: true, url: rec.url, port: rec.port };
}

module.exports = {
  start, stop, restart, busy, running, bots, pickPort, hasGoals, startupParms, PARMS_KEY,
  probeList, storedProbes, registerProbe, dropProbe, alive, sweep, portOf, REFUSED_HELD,
  BASE, STEP, DIRECTOR_PORT,
};

// ------------------------------------------------------------------- cli
if (require.main === module) {
  const D = require('./db');
  AUTH.configure();
  const [cmd, id] = process.argv.slice(2);
  const orgOf = (accId) => {
    for (const o of D.orgs.all()) {
      const org = D.org(o.id);
      if (org.accounts.get(accId)) return org;
    }
    return null;
  };
  (async () => {
    if (cmd === 'list') {
      for (const o of D.orgs.all()) {
        const org = D.org(o.id);
        console.log(`\n${o.name}`);
        for (const a of org.accounts.all()) {
          const rec = bots(org)[a.id];
          const held = await running(org, a);
          console.log(`  ${a.id.padEnd(4)} ${String(a.label).padEnd(14)} `
            + (held ? `console ${held.url}` : 'no console')
            + (rec ? `  (ours: pid ${rec.pid || '?'}${alive(rec.pid) ? '' : ' — gone'})` : ''));
        }
      }
      const { dupes } = await sweep();
      for (const d of dupes) {
        console.log(`\n  TWO CONSOLES HOLD ${d.accountId} — they kick each other: `
          + d.consoles.map((c) => `${c.port ? ':' + c.port : 'no port'} pid ${c.pid || '?'}`).join(', ')
          + '. End the one the list above does not name.');
      }
      return;
    }
    if (!['start', 'stop'].includes(cmd) || !id) {
      console.error('usage: node botctl.js start|stop <accountId>   |   node botctl.js list');
      process.exit(1);
    }
    const org = orgOf(id);
    if (!org) { console.error(`${id} is not an account in any organization`); process.exit(1); }
    const acc = org.accounts.get(id);
    const r = cmd === 'start'
      ? await start(org, acc, { note: (m) => console.log(m) })
      : await stop(org, acc, { note: (m) => console.log(m) });
    if (!r.ok) { console.error(r.error); process.exit(1); }
  })();
}
