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
  return null;
}

// The probe list is how the Director finds a console at all: the uptime sampler
// walks it, and the Fleet tab learns which port an account is on from whoever
// answers. An unregistered console is invisible, so this is not optional.
function registerProbe(org, acc, url) {
  const list = storedProbes(org).filter((p) => portOf(p.url) !== portOf(url));
  let name = String(acc.label || acc.id).trim() || acc.id;
  if (list.some((p) => p.probe === name)) name = `${name} (${acc.id})`;
  list.push({ probe: name, url });
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

// Start the console for one account, or adopt the one already running it.
// Resolves to { ok, adopted, url, port, pid, probe, paused, ready, error }.
async function start(org, acc, opts = {}) {
  const note = opts.note || (() => {});
  if (!acc || !acc.id) return { ok: false, error: 'no account' };
  if (!acc.email || !acc.password) {
    return { ok: false, error: `${acc.label || acc.id} has no email/password yet — a console cannot log in without them` };
  }

  const held = await running(org, acc);
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
  const paused = opts.paused !== undefined ? !!opts.paused : !hasGoals(org, acc);

  const out = fs.openSync(path.join(LOG_DIR, `console-${acc.id}.log`), 'a');
  const err = fs.openSync(path.join(LOG_DIR, `console-${acc.id}.err.log`), 'a');
  const env = { ...process.env, CONSOLE_PORT: String(port), ACCOUNT_ID: acc.id };
  if (paused) env.ENGINE_PAUSED = '1'; else delete env.ENGINE_PAUSED;
  // Detached and unref'd on purpose: the console outlives the Director, exactly
  // as it does when started by hand. Restarting the Director must not take the
  // bots down with it.
  // server.js in every real case; the test points it at a stub that exits, to
  // prove a console that dies on startup is reported and rolled back.
  const child = spawn(process.execPath, [opts.script || 'server.js'], {
    cwd: __dirname, env, detached: true, windowsHide: true, stdio: ['ignore', out, err],
  });
  child.unref();
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  child.on('error', (e) => { exited = e.message; });

  const probe = registerProbe(org, acc, url);
  remember(org, acc.id, { pid: child.pid, port, url, probe, at: Date.now(), paused });
  note(`${acc.label}: starting a console on ${url} (pid ${child.pid}${paused ? ', engine paused' : ''})`);

  // Wait for it to answer with this account. Until it does we cannot tell a
  // console that is logging in from one that died on startup.
  const deadline = Date.now() + (Number(opts.readyMs) || READY_MS);
  while (Date.now() < deadline) {
    if (exited !== null) {
      remember(org, acc.id, null);
      dropProbe(org, url);
      fs.closeSync(out); fs.closeSync(err);
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
async function stop(org, acc, opts = {}) {
  const note = opts.note || (() => {});
  const rec = bots(org)[acc.id];
  if (!rec) return { ok: false, error: `no console on record for ${acc.label || acc.id}` };
  if (rec.pid && alive(rec.pid)) {
    try { process.kill(rec.pid); } catch (e) { return { ok: false, error: e.message }; }
    note(`${acc.label || acc.id}: stopped the console on ${rec.url} (pid ${rec.pid})`);
  } else {
    note(`${acc.label || acc.id}: no console process was running on ${rec.url}`);
  }
  if (!opts.keepProbe) dropProbe(org, rec.url);
  remember(org, acc.id, null);
  return { ok: true, url: rec.url, port: rec.port };
}

module.exports = {
  start, stop, running, bots, pickPort, hasGoals,
  probeList, storedProbes, registerProbe, dropProbe, alive,
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
