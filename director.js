'use strict';
// The Director: a fleet database over many Evony accounts.
//
//   node director.js            -> http://localhost:8712
//
// It holds the account list (name / server / credentials / notes), polls each one
// on a slow rotation, and stores a snapshot so you can ask fleet-wide questions:
// who is under attack, who is sitting on resources, who has stopped moving.
//
// Polling is deliberately unhurried: this server throttles an IP that opens many
// connections quickly, so accounts are visited one at a time with a gap between.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { Game } = require('./game');
const { buildSnapshot } = require('./snapshot');

const D = require('./db');
const AUTH = require('./auth');
const BOTS = require('./botctl');
const MAINT = require('./maint');       // the fleet's shared word on maintenance
// Prepend / Append goals kept in files, synced into each account (goalfiles.js)
const GF = require('./goalfiles');
AUTH.configure();
// Naming and browsing files on this machine is only for its own user: offered
// while the Director listens on the loopback address alone (goalfiles.js).
const LOCAL_FILES = ['127.0.0.1', 'localhost', '::1'].includes(process.env.BIND || '127.0.0.1');
const GOALFILE_SEEN = new Map();
// NEAT's start-up parameters (Custom Parameters, CmdParms.txt): checked here,
// kept per org, handed to each console on its command line by botctl.js
const SC = require('./script-console');

// Whether an account's console runs its autorun scripts, and who says so —
// what its console will read at its next start (script-console autorunSettings:
// the environment, then the command line, then CmdParms.txt).
function autoscriptsOf(org, acc) {
  const sp = BOTS.startupParms(org, acc.id);
  const own = SC.parseCmdParms(sp.text.account).autoscripts;
  const fleet = SC.parseCmdParms(sp.text.fleet).autoscripts;
  const file = SC.readCmdParms(SC.CMDPARMS, {}).autoscripts;
  const env = process.env.AUTOSCRIPTS;
  const [v, from] = env !== undefined ? [env, 'AUTOSCRIPTS'] : own !== undefined ? [own, 'account']
    : fleet !== undefined ? [fleet, 'fleet'] : file !== undefined ? [file, 'CmdParms.txt'] : [null, null];
  // a console running on other parameters than these: they apply from its next
  // start. What it says it was started with, else what botctl started it with.
  const live = liveByAccount.get(acc.id), rec = BOTS.bots(org)[acc.id];
  const now = live && live.state !== 'process down' && Date.now() - live.at < 5 * 60000 ? live.startupArgs || []
    : rec && rec.pid ? rec.args || [] : null;
  const pending = now !== null && JSON.stringify(now) !== JSON.stringify(sp.args);
  return { on: v === null ? false : SC.switchOn(v), from, pending };
}

const PORT = Number(process.env.DIRECTOR_PORT || 8712);
// when this process came up, for /api/director/state
const STARTED_AT = Date.now();
const GAP_MS = Number(process.env.POLL_GAP_MS || 25000);   // between accounts
const CYCLE_MIN_MS = Number(process.env.POLL_CYCLE_MS || 10 * 60000);
const UPTIME_MS = Number(process.env.UPTIME_MS || 60000);  // bot health sample
// How long the first poll waits for consoles to come up and claim their
// accounts. A test sets it far ahead to keep the game out of it entirely.
const FIRST_POLL_MS = Number(process.env.POLL_FIRST_MS || 30000);

const n = (x) => Number(x || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = [];
const note = (m) => { log.push({ t: Date.now(), m: String(m) }); if (log.length > 500) log.shift(); console.log(new Date().toLocaleTimeString(), m); };

// Claude, woken once per real attack (claude-wake.js; the Claude tab). It
// reads each console's underAttack from the uptime sweep below and never
// blocks it: a wake is a child process whose answer is filed when it ends.
// Off until the user switches it on (2026-09-28).
const WAKE = require('./claude-wake').create({ D, note });

// First-run setup belongs to migrate-tenancy.js: an account has to land in
// SOMEONE's organization, and this process serves many.

// ------------------------------------------------------------------ proxies
// Evony tolerates roughly 10 accounts per IP, so accounts are spread across the
// proxy list. An account may pin a specific proxy with `proxy: "<raw line>"`.
const { parseList, parseProxy } = require('./proxy');
// The Trading tab: the market play read off the consoles' logs (trade-monitor.js).
const TRADE = require('./trade-monitor');
// the console logs are where botctl writes them
const TRADE_DIR = process.env.BOT_LOG_DIR || __dirname;
const TRADE_MON = new TRADE.Monitor({ dir: TRADE_DIR });
const TRADE_HOLIDAY = new Map();
// The Trading tab's setup side: accounts dragged into Buying / Selling, the play, and the
// Start process / Stop buttons that run it the way glitch-run.js is run by hand
// (trading-setup.js). One runner per organization, ticked every few seconds; there is
// one control file, so only one play runs at a time.
const TS = require('./trading-setup');
const TRADE_CONTROL = TS.controlFile(path.join(__dirname, 'scripts', 'glitch-res-control.txt'));
const TRADE_RUNNERS = new Map();      // orgId -> Runner
// accountId -> { at, holiday: bool, hours, lord } — the last holiday badge seen while the
// console was logged in, for a console that is between samples (never older than 30 min)
const HOLI_SEEN = new Map();
function glitchRun(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, 'glitch-run.js'), ...args],
      { cwd: __dirname, timeout: 6 * 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '') + String(stderr || ''), error: err ? err.message : null }));
  });
}
// Each account as the setup sees it, from the consoles' live headers — the holiday badge
// there is the truth (the snapshot's `furlough` field is NOT, EVONY-RULES §4).
function tradingAccounts(org) {
  const now = Date.now();
  const rec = BOTS.bots(org);
  return org.accounts.all().map((a) => {
    const live = liveByAccount.get(a.id) || null;
    const fresh = !!(live && now - live.at < TS.LIVE_FRESH && live.state !== 'process down');
    const connected = !!(fresh && live.connected);
    const seen = HOLI_SEEN.get(a.id);
    let holiday = null, holidayText = null;
    // The protection watch (session.js) reads the buffs every couple of minutes,
    // so a holiday begun while the console was already logged in shows up within
    // that; `live.holiday` only ever arrives with a login reply, so it is the
    // fallback now rather than the source.
    if (connected) {
      const prot = live.protection && live.protection.kind === 'holiday' ? live.protection : null;
      holiday = !!(prot || live.holiday);
      holidayText = prot ? (prot.left || null) : (live.holiday ? live.holiday.text || null : null);
    }
    else if (seen && now - seen.at < 30 * 60000) {
      // last seen on holiday with at least an hour of it left: still on it
      holiday = seen.holiday ? (seen.hours >= 1 ? true : null) : false;
      holidayText = seen.holiday ? `${seen.text || ''} (seen ${Math.round((now - seen.at) / 60000)} min ago)` : null;
    }
    return {
      id: a.id, label: a.label, enabled: a.enabled !== false, holiday, holidayText,
      holidayReady: !!(live && live.holidayRun && live.holidayRun.ready),
      lord: (live && live.lord) || (seen && seen.lord) || null,
      connected, fresh, at: live ? live.at : 0,
      state: live ? live.state : null, reason: live ? live.reason : null,
      processDown: !fresh, maintenance: !!(live && live.state === 'maintenance'),
      hasConsole: !!(rec[a.id] && rec[a.id].port),
    };
  });
}
function tradingRunner(orgId) {
  let r = TRADE_RUNNERS.get(orgId);
  if (!r) {
    const org = D.org(orgId);
    r = new TS.Runner({
      store: org.settings, control: TRADE_CONTROL, exec: glitchRun,
      accounts: () => tradingAccounts(org), monitor: TRADE_MON,
      lastLineAt: (id) => TS.lastScriptLineAt(TRADE_DIR, id), note,
      // every save, so the Glitch log keeps the run after the next Start replaces it
      archive: (run) => { try { require('./glitch-log').archiveRun(orgId, run); } catch { /* the play comes first */ } },
    });
    TRADE_RUNNERS.set(orgId, r);
  }
  return r;
}
// ------------------------------------------------------------------ Monitor
// The Monitor tab: one watcher over the whole server (monitor.js) — the map every
// few minutes, the rankings, and the lords of the top heroes. It runs as its own
// process so a Director restart does not drop a sweep, and it has NO login of its
// own: it drives the chosen account's console over HTTP, so the game still sees
// one session for that account (EVONY-RULES §1).
const MON = require('./monitor');
const MON_PROCS = new Map();            // orgId -> { pid, at }

// D.org(id) hands back a tenant handle that names itself `orgId`, not `id` — and
// getting that wrong once already spawned a Monitor on `--org undefined`, which
// then read another tenant's (empty) settings and sat there doing nothing.
const orgKey = (org) => (org && (org.orgId || org.id)) || null;
const monAlive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };

// Is a Monitor running for this org — this Director's child, or one started by
// hand that wrote its pid into the settings?
function monRunning(org) {
  const mine = MON_PROCS.get(orgKey(org));
  if (mine && monAlive(mine.pid)) return { pid: mine.pid, mine: true };
  const st = MON.readStatus(org);
  if (st && st.pid && monAlive(st.pid)) return { pid: st.pid, mine: false };
  return null;
}

function monStart(org) {
  const have = monRunning(org);
  if (have) return { ok: true, adopted: true, pid: have.pid };
  const outFile = path.join(process.env.BOT_LOG_DIR || __dirname, 'monitor.log');
  const out = fs.openSync(outFile, 'a');
  const id = orgKey(org);
  if (!id) return { ok: false, error: 'that organization has no id' };
  const child = spawn(process.execPath, [path.join(__dirname, 'monitor.js'), '--org', id], {
    cwd: __dirname, env: process.env, detached: true, windowsHide: true, stdio: ['ignore', out, out],
  });
  child.unref();
  MON_PROCS.set(id, { pid: child.pid, at: Date.now() });
  MON.writeStatus(org, { pid: child.pid, state: 'starting', error: null });
  note(`monitor: started (pid ${child.pid}) — ${outFile}`);
  return { ok: true, pid: child.pid };
}

function monStop(org) {
  const have = monRunning(org);
  MON_PROCS.delete(orgKey(org));
  if (!have) { MON.writeStatus(org, { pid: null, state: 'off', progress: null }); return { ok: true, already: true }; }
  // SIGTERM, which monitor.js catches so it finishes the chunk it is on and
  // writes its sweep row rather than leaving one open for ever.
  try { process.kill(have.pid, 'SIGTERM'); } catch {}
  note(`monitor: asked pid ${have.pid} to stop`);
  return { ok: true, pid: have.pid };
}

// Like keep-bot-on, for the Monitor: if it is switched on it should be running.
function keepMonitorOn() {
  for (const o of D.orgs.all().filter((x) => !x.disabled)) {
    try {
      const org = D.org(o.id);
      const cfg = MON.config(org);
      if (cfg.on && !monRunning(org)) { note('monitor: switched on but not running — starting it'); monStart(org); }
      if (!cfg.on && monRunning(org) && MON_PROCS.has(orgKey(org))) monStop(org);
    } catch (e) { note('monitor watchdog: ' + e.message); }
  }
}
setTimeout(() => { keepMonitorOn(); setInterval(keepMonitorOn, 60000); }, 20000);

// The Resources tab: every city's food, wood, stone, iron and gold, recorded once an hour
// on the hour (city-resources.js), from the snapshots the consoles publish.
const CITY_RES = require('./city-resources');
function recordCityResources(why) {
  for (const o of D.orgs.all().filter((x) => !x.disabled)) {
    try {
      const r = CITY_RES.record({ orgId: o.id });
      note(`resource record (${why}): ${r.rows} cities${r.skipped.length ? ` — skipped ${r.skipped.join('; ')}` : ''}`);
    } catch (e) { note('resource record failed: ' + e.message); }
  }
}
// Besides the hourly record, one every morning at 08:30 — just before the daily
// maintenance window (EVONY-RULES §2), so it holds what each town was carrying into
// it. Checked every minute rather than scheduled once, so a Director that was down at
// 08:30 still takes the day's record at its next start (city-resources.js decides).
function recordMorningResources() {
  for (const o of D.orgs.all().filter((x) => !x.disabled)) {
    try {
      const r = CITY_RES.recordMorning({ orgId: o.id });
      if (!r) continue;
      note(r.taken
        ? `08:30 record for ${r.day}: ${r.rows} cities${r.late ? ' (late — taken at the first chance after 08:30)' : ''}`
          + `${r.skipped.length ? ` — skipped ${r.skipped.join('; ')}` : ''}`
        : `08:30 record for ${r.day}: nothing to record yet — ${r.skipped.join('; ') || 'no snapshots'}`);
    } catch (e) { note('08:30 resource record failed: ' + e.message); }
  }
}
{
  // on the hour, every hour; and at start-up when the last record is over 55 min old
  const next = 3600000 - (Date.now() % 3600000);
  setTimeout(() => { recordCityResources('hourly'); setInterval(() => recordCityResources('hourly'), 3600000); }, next);
  setTimeout(() => {
    for (const o of D.orgs.all()) if (Date.now() - CITY_RES.lastAt(o.id) > 55 * 60000) { recordCityResources('start-up'); break; }
  }, 90000);
  setTimeout(() => { recordMorningResources(); setInterval(recordMorningResources, 60000); }, 100000);
}

// ---------------------------------------------------------------- glitch log
// The Trading tab's Glitch log (glitch-log.js): one record per maintenance of what
// every town went in with and came out with, and the runs of that day. Three steps,
// each done once and each at its own moment — the module decides which is due, this
// does it. See glitch-log.js for why each step happens when it does.
const GL = require('./glitch-log');

// Who each account was at the moment of a record — none of which can be recovered
// later: a holiday ends, a run stops, and the log would then call a bank an ordinary
// account. The play's own sides win over the holiday badge, because a run names them.
function glitchAccountMeta(org) {
  let run = null;
  try { run = tradingRunner(orgKey(org)).run(); } catch { run = null; }
  const buy = new Set((run && run.buy) || []);
  const sell = new Set((run && run.sell) || []);
  const banks = new Set((run && run.banks) || []);
  return tradingAccounts(org).map((a) => ({
    id: a.id, label: a.label, lord: a.lord || null, holiday: a.holiday,
    side: banks.has(a.id) ? 'bank' : buy.has(a.id) ? 'buy' : sell.has(a.id) ? 'sell' : null,
  }));
}

// Log every console in afresh, so the "before" record holds the server's figures and
// not a console's cache (EVONY-RULES §3). They go together rather than one at a time:
// each is on its own proxy and the whole fleet logs in together after every
// maintenance anyway, and serially there would not be time before the stand-down.
//
// This is not free — a refresh kills every city's autorun scripts (EVONY-RULES §4) —
// which is why it only ever fires on an ANNOUNCED window, once, and why what it cost
// (the scripts that were running) is written down beside each account.
const RELOG_STAGGER_MS = 500;
const RELOG_TIMEOUT_MS = 150000;
async function glitchRelog(org, day) {
  const orgId = orgKey(org);
  const targets = org.accounts.all().filter((a) => a.enabled !== false);
  const jobs = targets.map((a, i) => (async () => {
    const live = liveByAccount.get(a.id);
    const base = { label: a.label, at: Date.now() };
    if (!live || !live.url) return [a.id, { ...base, ok: false, skipped: true, error: 'no console answering for this account' }];
    if (!live.connected) return [a.id, { ...base, ok: false, skipped: true, error: live.state || 'not logged in' }];
    await new Promise((r) => setTimeout(r, i * RELOG_STAGGER_MS));
    const r = await postJson(`${live.url}/api/snapshot/refresh`, {}, RELOG_TIMEOUT_MS);
    const j = (r && r.json) || {};
    // File the snapshot it handed back at once: waiting for the next uptime sweep to
    // pick it up would put the record after the stand-down, which is the whole point
    // of doing this early.
    if (j.snapshot && j.snapshot.at) {
      try { if (org.ownsAccount(a.id)) { org.snapshots.add(a.id, j.snapshot); rememberHeroes(a.id, j.snapshot); } }
      catch (e) { note(`glitch log: snapshot from ${a.label}: ${e.message}`); }
    }
    // A console that predates this route answers the sign-in guard, not JSON — which
    // reads as "bad json" and is worth saying plainly, because the answer is a restart.
    const why = j.error || (r.ok ? null : r.error === 'bad json'
      ? `this console is older than the glitch log (HTTP ${r.status}) — restart it`
      : r.error) || (j.skipped ? 'skipped' : null);
    return [a.id, { ...base, ok: !!j.ok, at: Number(j.at) || Date.now(), scripts: j.scripts ?? null,
      error: why, skipped: !!j.skipped }];
  })());
  const results = Object.fromEntries(await Promise.all(jobs));
  GL.markRelog(orgId, day, results);
  const ok = Object.values(results).filter((x) => x.ok).length;
  const scripts = Object.values(results).reduce((s, x) => s + (Number(x.scripts) || 0), 0);
  note(`glitch log ${day}: relogged ${ok}/${targets.length} accounts before maintenance`
    + (scripts ? ` — ${scripts} script run(s) were going and a refresh ends those` : '')
    + Object.entries(results).filter(([, x]) => !x.ok).map(([, x]) => ` · ${x.label}: ${x.error}`).join(''));
  return results;
}

let glitchBusy = false;
const GLITCH_SAID = new Set();          // reasons already said, so a retry is quiet
async function glitchTick() {
  if (glitchBusy) return;
  glitchBusy = true;
  try {
    for (const o of D.orgs.all().filter((x) => !x.disabled)) {
      let org = null;
      try { org = D.org(o.id); } catch { continue; }
      // the window this org's fleet believes in, for the server most of it is on
      const server = (org.accounts.all().find((a) => a.enabled !== false) || {}).server || 'ss71';
      const rec = MAINT.read(org.settings, server);
      let step = null;
      try { step = GL.due(org, Date.now(), { rec }); } catch (e) { note('glitch log: ' + e.message); continue; }
      if (!step) continue;
      if (step.action === 'relog') { await glitchRelog(org, step.day); continue; }
      const r = GL.take({ orgId: o.id, day: step.day, side: step.action, accounts: glitchAccountMeta(org),
        maxSnapAt: step.maxSnapAt || 0, minSnapAt: step.minSnapAt || 0 });
      const said = `${o.id}|${step.day}|${step.action}|${r.taken}`;
      const line = r.taken
        ? `glitch log ${step.day}: ${step.action} record — ${r.rows} cities (${step.why})`
          + (r.skipped.length ? ` — skipped ${r.skipped.join('; ')}` : '')
        : `glitch log ${step.day}: nothing to record for "${step.action}" — ${r.skipped.join('; ') || 'no snapshots'}`;
      // A record that cannot be taken stays owed and is tried again every half minute,
      // so the reason is said once rather than filling the log with it.
      if (r.taken || !GLITCH_SAID.has(said)) note(line);
      GLITCH_SAID.add(said);
    }
  } catch (e) { note('glitch log: ' + e.message); }
  finally { glitchBusy = false; }
}
// Every half minute: the announcement only comes about 15 minutes ahead (EVONY-RULES
// §2), and the stand-down is a moment, not a window.
setTimeout(() => { glitchTick(); setInterval(glitchTick, 30000); }, 45000);     // accountId -> last known holiday badge (a console restarting has none)
const PROXY_FILE = path.join(__dirname, 'proxies.txt');
const MAX_PER_PROXY = Number(process.env.MAX_PER_PROXY || 10);

// Proxies belong to an organization: one tenant's IP budget is not another's.
// Each account is direct, pinned to one line, or "random" — a free line picked for
// it and kept (proxy-pick.js). The Director's own polls go the same way the
// account's console does, so an account never shows the server two IPs.
const PP = require('./proxy-pick');
const proxyText = PP.proxyText;
const loadProxies = PP.loadProxies;
function proxyAssignments(org) { return PP.assignAll(org, { note }); }
function proxyFor(org, acc) { return proxyAssignments(org).get(acc.id) || null; }

// ---------------------------------------------------------------- snapshot
async function pollAccount(org, acc) {
  const g = new Game(() => {});
  const started = Date.now();
  const proxy = proxyFor(org, acc);
  try {
    await g.connect(acc.server || 'ss71', acc.email, acc.password, proxy);
    const snap = buildSnapshot(g, {
      tookMs: Date.now() - started, proxy: proxy ? proxy.label : null, source: 'director',
    });
    g.close();
    return snap;
  } catch (e) {
    try { g.close(); } catch {}
    return { at: Date.now(), ok: false, error: e.message, tookMs: Date.now() - started, proxy: proxy ? proxy.label : null };
  }
}

// Every hero this account holds goes into the fleet register (db.fleetHeroes),
// which is what stops any console releasing a prisoner that is one of OUR OWN
// heroes: a captured hero leaves its owner's roster at once, so only a
// remembered row can prove it was ours (EVONY-RULES.md section 5). A console
// writes its own too (session.rememberOwnHeroes); this covers an account the
// Director polls because no console is running it, so the register can still be
// complete — and with it incomplete, nothing is released anywhere.
function rememberHeroes(accountId, snap) {
  if (!snap || !snap.ok || !Array.isArray(snap.heroIds) || !snap.heroIds.length) return;
  try { D.fleetHeroes.seen(accountId, snap.heroIds); }
  catch (e) { note(`fleet hero register for ${accountId}: ${e.message}`); }
}

// ------------------------------------------------------------ poll rotation
let polling = false;
// The console holds a live session per focused account. Logging in again for the
// same account makes the server kick that session, so ask the console first.
// Every configured console is asked, not just the first one: with a console per
// account, checking only :8711 would let the poller log into the account held by
// a console on another port and kick it.
async function focusedAccountIds() {
  const held = new Set();
  for (const pr of allProbes()) {
    const r = await getJson(pr.url.replace(/\/$/, '') + '/api/session', 1500);
    if (!r.ok || !r.json) continue;
    // Claim the account if the console OWNS it, even mid-reconnect — otherwise
    // the poller slips into that window and the two fight over the login.
    if (r.json.account && r.json.account.id) held.add(r.json.account.id);
  }
  return held;
}

// Is a console holding THIS account, right now? Asked again immediately before the
// poll's own login, because the set taken at the top of a cycle goes stale: a cycle
// is one account every GAP_MS, so with 21 accounts it lasts nine minutes, and any
// console that comes up during it is not in that set.
// On 2026-09-22 that cost the whole fleet: after a reboot the cycle began at 22:29:14
// with nothing running, the keep-on watchdog brought all 21 consoles up by 22:30:07,
// and the poller then logged in to one account every 25 s — kicking its own consoles
// one after another, each of which stood down for 30 minutes (server.ConnectionLost is
// another user logging in, and the poller IS another user).
// One request in the ordinary case: the probe registered for this very account.
async function heldByConsole(acc) {
  const probes = allProbes();
  const mine = probes.filter((pr) => pr.accountId === acc.id);
  for (const pr of (mine.length ? mine : probes)) {
    const r = await getJson(pr.url.replace(/\/$/, '') + '/api/session', 1500);
    if (r.ok && r.json && r.json.account && r.json.account.id === acc.id) return true;
  }
  return false;
}

// ------------------------------------------------------- maintenance, fleet-wide
// The consoles tell the Director when the server is going down — one hears the
// announcement on the system chat, or sees the game port stop answering, and
// writes it where everyone reads it (maint.js). The Director's own poll is a
// login like any other, and a login into a maintenance is what holds an account
// back for half an hour (EVONY-RULES.md section 2), so it stands down too.
//
// Is any console of this server still reporting? While one is, it is the thing
// that finds the end of maintenance (it checks the free TCP port through its own
// proxy and costs no login), so the poller simply waits for its word. With none
// left, the poller is the only way to find out, and goes back to trying.
function consolesWatching(org, server, now = Date.now()) {
  let n = 0;
  for (const a of org.accounts.all()) {
    if ((a.server || 'ss71') !== server || a.enabled === false) continue;
    const live = liveByAccount.get(a.id);
    if (live && now - live.at < UPTIME_MS * 3 && live.state !== 'process down') n++;
  }
  return n;
}

// The record when this account must not be logged in right now, else null.
function maintenanceHold(org, acc, now = Date.now()) {
  const server = acc.server || 'ss71';
  const rec = MAINT.read(org.settings, server, now);
  if (!rec || rec.phase === 'over' || rec.phase === 'before') return null;
  if (rec.phase === 'recovering' && !consolesWatching(org, server, now)) return null;
  return rec;
}

// One process serves every organization, so the poller walks them in turn. The
// gap between accounts is global on purpose: it exists to avoid hammering the
// game server, which does not care whose account it is.
async function pollCycle() {
  if (polling) return;
  polling = true;
  try {
    const allOrgs = D.orgs.all().filter((o) => !o.disabled);
    const focused = await focusedAccountIds();
    let total = 0;
    for (const o of allOrgs) {
      const org = D.org(o.id);
      const targets = org.accounts.all().filter((a) => a.enabled !== false);
      if (!targets.length) continue;
      note(`poll cycle: ${o.name} — ${targets.length} account(s)`);
      for (const acc of targets) {
        // the set from the top of the cycle, and then a fresh look at this one
        // account — a console that came up since must not be kicked by our own poll
        if (focused.has(acc.id) || await heldByConsole(acc)) {
          note(`${acc.label}: open in a console — skipped (a second login would kick it)`);
          continue;
        }
        // Somebody else logged in and kicked our console: the account is theirs
        // until the hold runs out (Session.kickHold), and a poll would kick them.
        const kick = org.settings.get('kickHold:' + acc.id, null);
        if (kick && Number(kick.until) > Date.now()) {
          note(`${acc.label}: kicked by another login — left alone until ${new Date(kick.until).toLocaleTimeString()}`);
          continue;
        }
        // The bots said the server is down: no poll login until it is back.
        const held = maintenanceHold(org, acc);
        if (held) {
          note(`${acc.label}: ${acc.server || 'ss71'} is in maintenance`
            + `${held.by ? ` (${held.by} saw it)` : ''} — no poll login until it is back`
            + ` (about ${new Date(held.resumeAt).toLocaleTimeString()})`);
          continue;
        }
        const snap = await pollAccount(org, acc);
        org.snapshots.add(acc.id, snap);
        rememberHeroes(acc.id, snap);
        total++;
        note(snap.ok ? `${acc.label}: ok (${snap.cities} cities, ${snap.incoming} incoming)`
                     : `${acc.label}: ${snap.error}`);
        await sleep(GAP_MS);
      }
    }
    note(`poll cycle done (${total} account(s) across ${allOrgs.length} org(s))`);
  } finally { polling = false; }
}

// ------------------------------------------------------------ bot uptime
// Every minute, ask each bot console whether it is alive. This costs no game
// traffic at all — it is a local HTTP call — so it is safe to run at 1/min while
// the game poller stays on its slow rotation.
//
// Three states get recorded, and they mean different things:
//   reachable=0  the bot PROCESS is not running (connection refused)
//   reachable=1, up=0  process alive, game socket down (reconnecting/throttled)
//   reachable=1, up=1  logged in
// `activity` is separate again: connected but silent for minutes means the
// server is ignoring us, which looks identical to healthy on a plain ping.
const PROBE_DEFAULTS = [{ probe: 'console', url: 'http://localhost:8711' }];

// An org with no probes of its own (or no org at all, on a route that has none)
// gets the defaults: this runs inside request handlers, where a throw would
// take the whole Director down with it.
function probeList(org) {
  const extra = org && org.settings ? org.settings.get('probes', null) : null;
  return Array.isArray(extra) && extra.length ? extra : PROBE_DEFAULTS;
}

function getJson(url, timeout = 2500) {
  return new Promise((resolve) => {
    const started = Date.now();
    const opts = { timeout, headers: { 'x-otto-internal': AUTH.internalToken() } };
    const req = http.get(url, opts, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { resolve({ ok: true, json: JSON.parse(b), ms: Date.now() - started }); }
        catch (e) { resolve({ ok: false, error: 'bad json', ms: Date.now() - started }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message, ms: Date.now() - started }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout', ms: Date.now() - started }); });
  });
}

// The few routes the Director POSTs to a console (auth.js INTERNAL_OK). Kept apart
// from getJson so it is obvious in one place what the Director can make a bot do:
// today that is the before-maintenance refresh and nothing else.
function postJson(url, body = {}, timeout = 120000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', timeout,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'x-otto-internal': AUTH.internalToken() },
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { resolve({ ok: true, status: res.statusCode, json: JSON.parse(b), ms: Date.now() - started }); }
        catch { resolve({ ok: false, status: res.statusCode, error: 'bad json', ms: Date.now() - started }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message, ms: Date.now() - started }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout', ms: Date.now() - started }); });
    req.end(data);
  });
}

const lastSeq = {};

// The live header each console last reported, keyed by account id. A console
// holds the truth about its own account — the Director never polls an account a
// console owns, so its snapshot is by definition older than the console's view.
// Without this the Fleet tab happily showed "reporting" while the bot itself was
// sitting in maintenance.
const liveByAccount = new Map();

// Every organization's probes, tagged with who they belong to.
function allProbes() {
  const out = [];
  for (const o of D.orgs.all()) {
    if (o.disabled) continue;
    for (const pr of probeList(D.org(o.id))) out.push({ ...pr, orgId: o.id });
  }
  return out;
}

// THE DIRECTOR MUST NOT DIE OF A PASSING ERROR. Every console has had this guard since
// the beginning (server.js) and the Director never did — so on 2026-09-24 at 21:26 a
// single `database is locked` inside sampleUptime's uptime.add took the whole control
// plane down, and it stayed down: no live sweep, no goal-file sync, no Trading tab, and
// every row on the Fleet page fell back to "reporting"/"stale" because `live` had stopped
// being refreshed. The lock itself was ordinary — 21 consoles were restarting into a
// 20.7MB WAL checkpoint and the write waited out its 5-second busy_timeout.
for (const kind of ['unhandledRejection', 'uncaughtException']) {
  process.on(kind, (err) => {
    const e = err instanceof Error ? err : new Error(String(err));
    const what = kind === 'unhandledRejection' ? 'unhandled rejection' : 'uncaught exception';
    console.error(`\n  ${what.toUpperCase()}: ${e.message}\n${e.stack || ""}\n  (the Director kept running)\n`);
    try { note(`${what}: ${e.message} — the Director kept running; its terminal has the stack`); } catch { /* not up yet */ }
  });
}

// This is the timer that met the locked database on 2026-09-24. It writes an uptime row
// for every probe every minute, so it is the Director's likeliest write to collide with
// 21 consoles restarting — and a missed sample is only a gap in a chart. The guard above
// is what keeps that from being fatal; nothing here swallows the error, so it still
// reaches the log where it can be seen.
async function sampleUptime() {
  const at = Date.now();
  // Which accounts answered this round, and the probes that did not: a probe
  // that is dead while its account answered on another port is a leftover from a
  // restart (see registerProbe in botctl.js), not the account being down.
  const answered = new Set();
  const dead = [];
  // What this sweep says about each server, for the fleet-wide maintenance
  // record (maintenanceFromFleet below).
  const servers = new Map();      // `${orgId}|${server}` -> { orgId, server, dropped, saysDown, back }
  const serverNote = (orgId, server) => {
    const k = orgId + '|' + (server || 'ss71');
    if (!servers.has(k)) servers.set(k, { orgId, server: server || 'ss71', dropped: 0, saysDown: 0, connected: 0, back: null });
    return servers.get(k);
  };
  for (const pr of allProbes()) {
    const org = pr.orgId ? D.org(pr.orgId) : null;
    const r = await getJson(pr.url.replace(/\/$/, '') + '/api/session');
    if (!r.ok) {
      dead.push({ pr, r });
      for (const [id, v] of liveByAccount) {
        if (v.probe === pr.probe) {
          liveByAccount.set(id, { ...v, at, connected: false, state: 'process down',
            reason: r.error === 'ECONNREFUSED' ? 'bot process not running' : r.error });
        }
      }
      continue;
    }
    const h = r.json || {};
    if (h.account && h.account.id) answered.add(pr.orgId + '|' + h.account.id);
    // A console-held account is never polled by pollCycle (a second login would
    // kick it), so without this its snapshot history would stay empty — exactly
    // for the accounts that are actually being run. The console publishes one
    // every few minutes and the Director just files it.
    if (h.snapshot && h.account && h.account.id) {
      try {
        const last = D.one('SELECT at FROM snapshots WHERE accountId = ? ORDER BY at DESC LIMIT 1', h.account.id);
        // Only file it if this org really owns the account the console names —
        // a console is a separate process and its claim is not proof.
        if (org && org.ownsAccount(h.account.id)
            && (!last || h.snapshot.at > n(last.at))) {
          org.snapshots.add(h.account.id, h.snapshot);
          rememberHeroes(h.account.id, h.snapshot);
        }
      } catch (e) { note(`snapshot from ${pr.probe}: ${e.message}`); }
    }
    // Traffic within the sample window, or the log/tick counters moved.
    const seq = n(h.logSeq);
    const moved = lastSeq[pr.probe] !== undefined && seq !== lastSeq[pr.probe];
    lastSeq[pr.probe] = seq;
    const fresh = h.idleMs !== null && h.idleMs !== undefined && n(h.idleMs) < UPTIME_MS * 1.5;
    const paused = !!(h.maintenance && h.maintenance.paused);
    if (h.account && h.account.id) {
      // What this console says about the SERVER, before its row is overwritten:
      // did it just lose the game socket, did it just get back in, and does it
      // believe the server is down (the chat announcement it heard, the game
      // port it found closed). Several consoles losing the socket in the same
      // sweep is the server going down — they do not share a proxy, and nothing
      // else takes them all at once.
      const prev = liveByAccount.get(h.account.id) || null;
      const acc = org && org.accounts.get(h.account.id);
      const sv = serverNote(pr.orgId, (acc && acc.server) || 'ss71');
      const phase = h.maintenance && h.maintenance.phase;
      // An account switched off, or held out after a kick, was not taken by the
      // server going down — it was told to stay out.
      const toldToStayOut = h.state === 'off' || h.state === 'kicked' || !!h.kick;
      if (prev && prev.connected && !h.connected && prev.state !== 'process down' && !toldToStayOut) sv.dropped++;
      if (!h.connected && (paused || phase === 'standdown' || phase === 'recovering')) sv.saysDown++;
      if (h.connected) sv.connected++;
      if (h.connected && (!prev || !prev.connected)) sv.back = (acc && acc.label) || h.account.id;
      liveByAccount.set(h.account.id, {
        at, probe: pr.probe, url: String(pr.url || '').replace(/\/$/, ''),
        connected: !!h.connected,
        state: paused ? 'maintenance' : (h.state || null),
        reason: paused ? (h.maintenance.why || 'server maintenance') : (h.reason || null),
        engineMode: h.engineMode || null,
        // the console's engine paused (it should never be: the user, 2026-09-18)
        enginePaused: h.paused === true,
        // { on, cities: [{ name, inbound, firstLandsAt, lastWaveAt, loyalty }] }
        // (session.js underAttackView); none from a console older than it
        underAttack: h.underAttack || null,
        // An account on holiday is logged in and fully usable — the holiday is a
        // badge on the row, not a fault (see Game.loginOutcome).
        holiday: h.holiday || null,
        // { since, maints, ready }: how many maintenances it has been on holiday
        // through, which is what makes it usable for the market play — the
        // "Market glitch ready" column (session.js holidayRun).
        holidayRun: h.holidayRun || null,
        // the in-game name — what the control file's holi list names (trading-setup.js)
        lord: h.lord || null,
        maintenance: h.maintenance || null,
        // somebody else logged into this account: the hold running now, and the last
        // time it happened at all (session.js — the game's server.ConnectionLost)
        kick: h.kick || null,
        lastKick: h.lastKick || null,
        kickStep: h.kickStep || 0,
        retryInSec: h.retryInSec ?? null,
        proc: h.proc || null,
        // its command line's start-up parameters; none on a console older than them
        startupArgs: Array.isArray(h.startupArgs) ? h.startupArgs : [],
      });
      // a new real attack (junk is already left out by the console) wakes Claude once
      if (h.connected && h.underAttack && h.underAttack.on && org && org.ownsAccount(h.account.id)) {
        try { WAKE.observe({ orgId: pr.orgId, account: acc || h.account, underAttack: h.underAttack }); }
        catch (e) { note(`claude wake: ${e.message}`); }
      }
      if (h.connected) {
        HOLI_SEEN.set(h.account.id, { at, holiday: !!h.holiday, hours: h.holiday ? Number(h.holiday.hours) || 0 : 0,
          text: h.holiday ? h.holiday.text || null : null, lord: h.lord || null });
      }
    }
      D.uptime.add({
        orgId: pr.orgId, at, probe: pr.probe,
        accountId: h.account && h.account.id, label: (h.account && h.account.label) || h.lord || null,
        reachable: true, up: !!h.connected,
        state: paused ? 'maintenance' : (h.state || null),
        reason: paused ? 'server maintenance' : (h.reason || null),
        engineMode: h.engineMode || null,
        idleMs: n(h.idleMs), latencyMs: r.ms, logLines: seq,
        activity: !!h.connected && (fresh || moved),
        maintenance: paused,
        rssMb: h.proc && h.proc.rssMb, heapMb: h.proc && h.proc.heapMb,
      });
  }

  for (const { pr, r } of dead) {
    // Whose was it? The entry says so when botctl wrote it, else whoever last
    // answered under that probe name.
    let acct = pr.accountId || null;
    if (!acct) {
      const last = D.one('SELECT accountId FROM uptime WHERE orgId = ? AND probe = ? AND accountId IS NOT NULL ORDER BY at DESC LIMIT 1',
        pr.orgId || '', pr.probe);
      acct = last && last.accountId || null;
    }
    const org = pr.orgId ? D.org(pr.orgId) : null;
    if (acct && org && answered.has(pr.orgId + '|' + acct)) {
      // The account is up on another port, so this line is a dead port left by a
      // restart: drop it rather than sample it (and count it as downtime) forever.
      const stored = BOTS.storedProbes(org);
      const keep = stored.filter((p) => !(p.probe === pr.probe && p.url === pr.url));
      if (keep.length !== stored.length) {
        org.settings.set('probes', keep);
        note(`uptime probe "${pr.probe}" (${pr.url}) dropped — its account is running on another port`);
      }
      continue;
    }
      D.uptime.add({ orgId: pr.orgId, at, probe: pr.probe, accountId: acct || undefined,
      reachable: false, up: false,
      state: 'down', reason: r.error === 'ECONNREFUSED' ? 'bot process not running' : r.error,
      latencyMs: r.ms, activity: false });
  }

  maintenanceFromFleet(servers, at);
}

// What the sweep just saw, turned into the fleet's word on maintenance. The
// reading of it is maint.verdict; this is what the Director does about it.
function maintenanceFromFleet(servers, now = Date.now()) {
  for (const sv of servers.values()) {
    let org = null;
    try { org = sv.orgId ? D.org(sv.orgId) : null; } catch { org = null; }
    if (!org) continue;
    const rec = MAINT.read(org.settings, sv.server, now);
    const say = MAINT.verdict(sv, rec);
    if (say === 'back') {
      MAINT.signalBack(org.settings, sv.server, now);
      note(`${sv.server}: ${sv.back} is logged in again — maintenance is over, the fleet can go back in`);
      continue;
    }
    if (say !== 'down') continue;
    const why = sv.saysDown >= MAINT.SAYS_DOWN_IS_MAINTENANCE
      ? `${sv.saysDown} consoles report the server down`
      : `${sv.dropped} consoles lost the game socket at once`;
    const w = MAINT.declare(org.settings, sv.server, { startAt: now - 60000, text: why, by: 'the Director' }, now);
    if (w) {
      note(`${sv.server}: ${why} — telling the fleet it is maintenance now.`
        + ` Nothing logs in until it is back (about ${new Date(w.resumeAt).toLocaleTimeString()})`);
    }
  }
}

// ------------------------------------------------------------ keep bot on
// An account with "keep bot on" set is one that is meant to be playing: if its
// console is not there — it crashed, the machine rebooted, somebody stopped it —
// the Director starts it again. Switched off outranks it: off means off, which
// is the whole point of the switch, so this never touches a switched-off
// account. An account without credentials is skipped too; there is nothing to
// log in with.
const KEEP_MS = Number(process.env.KEEP_ON_MS || 60000);
let keeping = false;
async function keepBotsOn() {
  if (keeping) return;
  keeping = true;
  try {
    for (const o of D.orgs.all()) {
      if (o.disabled) continue;
      const org = D.org(o.id);
      for (const acc of org.accounts.all()) {
        if (!acc.keepOn || acc.enabled === false || !acc.email || !acc.password) continue;
        // Being started, stopped or restarted by someone else right now: that
        // is not "down", and a second start is the fight this is here to avoid.
        if (BOTS.busy(acc.id)) continue;
        if (await BOTS.running(org, acc)) continue;
        note(`${acc.label}: keep bot on — no console is running it, starting one`);
        const r = await BOTS.start(org, acc, { note });
        if (!r.ok) note(`${acc.label}: could not start its console — ${r.error}`);
      }
    }
  } catch (e) { note('keep bot on: ' + e.message); } finally { keeping = false; }
}

// ------------------------------------------------------------------- server
const body = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch { res({}); } }); });

const rawBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b));
});

http.createServer(async (req, res) => {
  if (await AUTH.guard(req, res, { readBody: rawBody })) return;
  // Every tenant read and write below goes through this handle, which is closed
  // over the org from the SESSION — never from anything the caller sends.
  const ORG = req.org ? D.org(req.org.id) : null;
  const url = new URL(req.url, 'http://x');
  const send = (code, type, data) => { res.writeHead(code, {
    // never let a browser hold on to a stale page or a stale account list
    'Cache-Control': 'no-store, must-revalidate', 'Content-Type': type + '; charset=utf-8' }); res.end(data); };

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return send(200, 'text/html', fs.readFileSync(path.join(__dirname, 'public', 'director.html')));
  }

  if (url.pathname === '/api/accounts') {
    const assign = proxyAssignments(ORG);
    const list = loadProxies(ORG);
    const counts = {};
    // An account may have NO proxy (Lord23, 2026-09-25, switched on to join the fleet
    // and running direct at the user's choice): proxyAssignments then has no entry for it
    // and `p` is null, which threw on every /api/accounts call and broke the Accounts tab.
    for (const [, p] of assign) if (p && p.label) counts[p.label] = (counts[p.label] || 0) + 1;
    return send(200, 'application/json', JSON.stringify({
      accounts: ORG.accounts.withSnapshots().map((a) => ({
        ...a,
        proxyLabel: (assign.get(a.id) || {}).label || null,
        // the line it actually logs in through (a random account's pick), for the
        // page to say when two accounts share one
        proxyRaw: (assign.get(a.id) || {}).raw || null,
        // set when the account's OWN console moved it off its proxy because it could
        // not get in (session.js rotateProxyIfStuck) — saving a proxy here ends it
        proxyMoved: (() => {
          const ov = ORG.settings.get(PP.overrideKey(a.id), null);
          if (!ov || !ov.raw) return null;
          return { label: (parseProxy(ov.raw) || {}).label || ov.raw, at: ov.at || null, why: ov.why || null,
            was: ov.was ? ((parseProxy(ov.was) || {}).label || ov.was) : null };
        })(),
        // after maintenance: 'monitor' finds its end, 'follow' logs in right behind it (session.js maintRace)
        maintRole: ORG.settings.get('maintRole:' + a.id, null),
        // after another login kicks its console: stay out this many minutes (null = not set), and the hold running now
        kickHoldMin: ORG.settings.get('kickHoldMin:' + a.id, null),
        kickHoldUntil: (() => { const h = ORG.settings.get('kickHold:' + a.id, null); return h && Number(h.until) > Date.now() ? Number(h.until) : null; })(),
        // how far up the ladder it is: 1 = the plain minutes, 2 = twice them, and so on
        // (session.js holdForKick) — back to 0 as soon as a login holds
        kickHoldStep: Number(ORG.settings.get('kickHoldStep:' + a.id, 0)) || 0,
        // the files its Prepend / Append goals are kept in step with (goalfiles.js)
        prependFile: GF.fileOf(ORG, a.id, 'prepend'),
        appendFile: GF.fileOf(ORG, a.id, 'append'),
        // its own start-up parameters, and whether its scripts autorun (and who says so)
        startupParms: BOTS.startupParms(ORG, a.id).text.account,
        autoscripts: autoscriptsOf(ORG, a),
        live: liveByAccount.get(a.id) || null,
        // Which console process is running this account. Consoles are pinned to
        // one account each, so this is how the UI knows where to send you.
        consoleUrl: (liveByAccount.get(a.id) || {}).url || null,
      })),
      polling, gapMs: GAP_MS, log: log.slice(-120),
      proxies: list.map((p) => ({ label: p.label, accounts: counts[p.label] || 0 })),
      // what an account's Proxy dropdown offers: each line, and how its last test went
      proxyOptions: list.map((p) => ({ raw: p.raw, label: p.label, test: (ORG.settings.get('proxyTests', {}) || {})[p.raw] || null })),
      proxyText: proxyText(ORG), maxPerProxy: MAX_PER_PROXY, storage: D.stats(),
      goalFiles: LOCAL_FILES,
      // every account's start-up parameters (NEAT's Custom Parameters)
      startupFleet: BOTS.startupParms(ORG, null).text.fleet,
    }));
  }

  // The fleet's start-up parameters: every console gets them at its next start,
  // under the account's own (botctl.js startupParms).
  // TURNING THE DIRECTOR OFF BY HAND — the only thing that keeps it down. director-keep.js
  // relaunches it whenever it stops, so a deliberate stop has to say so: this writes the
  // stop file the supervisor watches and then exits. The page asks for confirmation first
  // (its own themed dialog, never the browser box). Deleting the file, or pressing the
  // switch again, brings it back within a few seconds.
  if (url.pathname === '/api/director/stop' && req.method === 'POST') {
    const KEEP = require('./director-keep');
    try {
      fs.writeFileSync(KEEP.STOP_FILE, `turned off from the Director page at ${new Date().toISOString()}
`);
    } catch (e) {
      return send(500, 'application/json', JSON.stringify({ ok: false, error: `could not write the stop file — ${e.message}` }));
    }
    note('turned off from the page — writing the stop file and exiting; director-keep.js will leave it down');
    send(200, 'application/json', JSON.stringify({ ok: true, stopped: true, file: KEEP.STOP_FILE }));
    // let the answer reach the page before the process goes
    setTimeout(() => process.exit(0), 250);
    return true;
  }
  // Is a supervisor watching, and is the stop file set? The page shows the switch from this.
  if (url.pathname === '/api/director/state') {
    const KEEP = require('./director-keep');
    let off = false;
    try { off = fs.existsSync(KEEP.STOP_FILE); } catch { off = false; }
    return send(200, 'application/json', JSON.stringify({ ok: true, off, pid: process.pid, since: STARTED_AT }));
  }
  if (url.pathname === '/api/startup' && req.method === 'POST') {
    const b = await body(req);
    const text = String(b.text == null ? '' : b.text).trim();
    const chk = SC.checkStartupParms(text);
    if (chk.errors.length) return send(200, 'application/json', JSON.stringify({ ok: false, error: chk.errors.join(' · '), notes: chk.notes }));
    const was = BOTS.startupParms(ORG, null).text.fleet;
    ORG.settings.set(BOTS.PARMS_KEY, text);
    if (was !== text) note(`start-up parameters for every account: ${text ? SC.parmsToArgs(chk.parms).join(' ') : 'none'} — from each console's next start`);
    return send(200, 'application/json', JSON.stringify({ ok: true, notes: chk.notes, accounts: ORG.accounts.withSnapshots() }));
  }

  // The Browse button beside a goal file: a folder's sub-folders and .txt files.
  //   GET /api/browse?dir=<folder>   (the Director's own folder when empty)
  if (url.pathname === '/api/browse') {
    if (!LOCAL_FILES) return send(200, 'application/json', JSON.stringify({ ok: false, error: 'goal files are only for a Director on this machine (BIND is set)' }));
    return send(200, 'application/json', JSON.stringify(GF.browse(url.searchParams.get('dir'))));
  }

  // Test every proxy in the list against the game server (proxy.js testProxy:
  // a tunnel and the policy request, never a login), and keep the results so each
  // account's Proxy dropdown can say which ones work.
  if (url.pathname === '/api/proxies/test' && req.method === 'POST') {
    const list = loadProxies(ORG);
    let host = null, port = 443;
    try { ({ host, port } = await require('./evony').getServerConfig('ss71')); } catch (e) {
      return send(200, 'application/json', JSON.stringify({ ok: false, error: 'could not find the game server: ' + e.message }));
    }
    const { testProxy } = require('./proxy');
    const results = {};
    await Promise.all(list.map(async (p) => {
      const r = await testProxy(p, host, port);
      results[p.raw] = { ...r, label: p.label, at: Date.now() };
    }));
    ORG.settings.set('proxyTests', results);
    const good = Object.values(results).filter((r) => r.ok).length;
    note(`proxy test: ${good} of ${list.length} reach the game server`);
    return send(200, 'application/json', JSON.stringify({ ok: true, good, total: list.length, results }));
  }

  if (url.pathname === '/api/proxies' && req.method === 'POST') {
    const b = await body(req);
    ORG.settings.set('proxyText', String(b.text || ''));
    fs.writeFileSync(PROXY_FILE, String(b.text || ''));   // kept so it stays eyeballable
    const list = loadProxies(ORG);
    note(`proxy list updated: ${list.length} usable, covers ${list.length * MAX_PER_PROXY} accounts`);
    return send(200, 'application/json', JSON.stringify({ ok: true, count: list.length }));
  }

  if (url.pathname === '/api/account' && req.method === 'POST') {
    const b = await body(req);
    if (b.delete) {
      // Take its console down first: a pinned console whose account has been
      // deleted cannot even start again, and it would sit there logged in as an
      // account the Director no longer knows.
      // An id this organization does not own must not reach remove(), which
      // throws for it — and an uncaught throw in here takes the process with it.
      const acc = ORG.accounts.get(b.id);
      if (!acc) return send(404, 'application/json', JSON.stringify({ ok: false, error: 'no such account' }));
      await BOTS.stop(ORG, acc, { note }).catch(() => {});
      ORG.accounts.remove(b.id);
      ORG.settings.set(PP.pickKey(acc.id), null);     // its random proxy is free again
      return send(200, 'application/json', JSON.stringify({ ok: true, accounts: ORG.accounts.withSnapshots() }));
    }
    // A brand new account has no console behind it, and an account without a
    // console cannot be logged into at all — which is exactly how a new account
    // used to end up sitting in the fleet list doing nothing. Start its bot.
    const fresh = !b.id;
    const prev = fresh ? null : ORG.accounts.get(b.id);
    if (!fresh && !prev) {
      return send(404, 'application/json', JSON.stringify({ ok: false, error: 'no such account' }));
    }
    // The goal files are checked before anything is saved, so a bad path saves nothing.
    const files = {};
    for (const which of GF.WHICH) {
      const v = b[which + 'File'];
      if (v === undefined) continue;
      if (!LOCAL_FILES && String(v).trim()) return send(200, 'application/json', JSON.stringify({ ok: false, error: 'goal files are only for a Director on this machine (BIND is set)' }));
      try { files[which] = GF.checkPath(v); } catch (e) {
        return send(200, 'application/json', JSON.stringify({ ok: false, error: `${which} goals file: ${e.message}` }));
      }
    }
    // so are its start-up parameters
    let startup = null;
    if (b.startupParms !== undefined) {
      startup = SC.checkStartupParms(String(b.startupParms == null ? '' : b.startupParms).trim());
      if (startup.errors.length) return send(200, 'application/json', JSON.stringify({ ok: false, error: 'start-up parameters: ' + startup.errors.join(' · ') }));
    }
    const acc = ORG.accounts.upsert(b);
    // A proxy you choose outranks any move the account's console made for itself
    // when it could not get in (proxy-pick.js rotate): saving one ends that move.
    if (b.proxy !== undefined && (!prev || prev.proxy !== acc.proxy)) {
      const had = PP.clearOverride(ORG, acc.id);
      if (had) note(`${acc.label}: back on the proxy you chose — the move its console made to `
        + `${(parseProxy(had.raw) || {}).label || had.raw} is dropped`);
    }
    if (startup) {
      const text = String(b.startupParms == null ? '' : b.startupParms).trim();
      const was = BOTS.startupParms(ORG, acc.id).text.account;
      ORG.settings.set(`${BOTS.PARMS_KEY}:${acc.id}`, text || null);
      if (was !== text) note(`${acc.label}: start-up parameters ${text ? SC.parmsToArgs(startup.parms).join(' ') : 'cleared'} — from its console's next start`);
    }
    let goalFiles = null;
    if (Object.keys(files).length) {
      for (const [which, v] of Object.entries(files)) {
        const was = GF.fileOf(ORG, acc.id, which);
        GF.setFile(ORG, acc.id, which, v);
        if (was !== (v || null)) note(v ? `${acc.label}: ${which} goals now kept in step with ${v}` : `${acc.label}: ${which} goals no longer come from ${was} — the saved text stays`);
      }
      goalFiles = GF.syncAccount(ORG, acc, { note, seen: GOALFILE_SEEN });
    }
    // After a kick (another login — NEAT's, a person's): how long its console stays out.
    // Kept in the org's settings, read by the console every few seconds (session.js
    // kickHoldMin) — a change applies without a restart. Blank = not set, 0 = straight back.
    if (b.kickHoldMin !== undefined) {
      const raw = b.kickHoldMin === null ? '' : String(b.kickHoldMin).trim();
      const n = raw === '' ? null : Number(raw);
      if (n !== null && !(Number.isFinite(n) && n >= 0 && n <= 1440)) throw new Error('after a kick: minutes from 0 to 1440, or blank');
      const was = ORG.settings.get('kickHoldMin:' + acc.id, null);
      ORG.settings.set('kickHoldMin:' + acc.id, n);
      // a new number starts the ladder again, or the next hold would jump straight to
      // whatever step the old one had reached
      if (was !== n) ORG.settings.set('kickHoldStep:' + acc.id, 0);
      if (was !== n) note(`${acc.label}: after a kick ${n === null ? 'not set (straight back after a disconnect)' : n === 0 ? 'straight back in' : `stays out ${n} min, then ${n * 2}, ${n * 3} … while it goes on being refused`}`);
    }
    // After maintenance: kept in the org's settings, where the account's console
    // reads it on every tick — a change applies without a restart.
    if (b.maintRole !== undefined) {
      const role = b.maintRole === 'monitor' || b.maintRole === 'follow' ? b.maintRole : null;
      ORG.settings.set('maintRole:' + acc.id, role);
      // one maintenance monitor per server is enough: the signal is shared
      if (role === 'monitor') {
        for (const other of ORG.accounts.all()) {
          if (other.id !== acc.id && (other.server || 'ss71') === (acc.server || 'ss71') && ORG.settings.get('maintRole:' + other.id, null) === 'monitor') {
            ORG.settings.set('maintRole:' + other.id, 'follow');
            note(`${other.label}: maintenance monitor handed to ${acc.label} — ${other.label} now follows`);
          }
        }
      }
    }
    let bot = null, restarted = false;
    // "Keep bot on" turns the switch into a restart: the account is meant to be
    // playing, so switching it off only takes its console down and brings it
    // straight back. Clear the checkbox first if you want the account to stay
    // off — that is the pair of settings the Director's page explains.
    if (!fresh && b.enabled === false && acc.enabled === false && acc.keepOn) {
      ORG.accounts.upsert({ id: acc.id, enabled: true });
      restarted = true;
      note(`${acc.label} is set to keep its bot on — restarting its console instead of switching it off`);
      bot = await BOTS.restart(ORG, acc, { note, readyMs: 25000 });
      if (!bot.ok) note(`${acc.label}: no console — ${bot.error}`);
      return send(200, 'application/json', JSON.stringify({
        ok: true, bot, restarted, accounts: ORG.accounts.withSnapshots() }));
    }
    if (fresh) {
      note(`${acc.label} added — bringing up its console`);
      // Bounded on purpose: this is a browser waiting on a form. Once the
      // process is up the Uptime tab owns it, logged in or still trying.
      bot = await BOTS.start(ORG, acc, { note, readyMs: 25000 });
      if (!bot.ok) note(`${acc.label}: no console — ${bot.error}`);
    } else if (b.enabled !== undefined && (acc.enabled !== false) !== (prev.enabled !== false)) {
      // Switched off means switched off: the account stays in the fleet with all
      // its history, but nothing plays it. The poller already skips it — the
      // console is what actually logs in, so that has to come down too, or the
      // bot carries on building and marching for a row marked "off".
      if (acc.enabled === false) {
        note(`${acc.label} switched off — taking its console down`);
        bot = await BOTS.stop(ORG, acc, { note }).catch((e) => ({ ok: false, error: e.message }));
        // A console this Director never started is not ours to kill, and it is
        // still logged in and playing. Say so, rather than let the row read
        // "off" while the bot carries on.
        const live = liveByAccount.get(acc.id);
        if (!bot.ok && live && live.url && Date.now() - live.at < 5 * 60000) {
          bot.stillRunning = live.url;
          note(`${acc.label}: the console on ${live.url} was not started by the Director — stop it there`);
        }
      } else {
        note(`${acc.label} switched on — bringing its console back up`);
        bot = await BOTS.start(ORG, acc, { note, readyMs: 25000 });
        if (!bot.ok) note(`${acc.label}: no console — ${bot.error}`);
      }
    }
    return send(200, 'application/json', JSON.stringify({
      ok: true, bot, restarted, goalFiles, startupNotes: startup ? startup.notes : null, accounts: ORG.accounts.withSnapshots() }));
  }

  // Start or stop the console for one account, for the accounts that predate
  // auto-start (and for a bot that has been stopped by hand).
  if (url.pathname === '/api/bot' && req.method === 'POST') {
    const b = await body(req);
    const acc = ORG.accounts.get(b.id);
    if (!acc) return send(404, 'application/json', JSON.stringify({ ok: false, error: 'no such account' }));
    // A switched-off account has no business logging in, whichever button asked.
    if (acc.enabled === false && b.action !== 'stop') {
      return send(409, 'application/json', JSON.stringify({
        ok: false, error: `${acc.label} is switched off — switch it on to start its console` }));
    }
    const r = b.action === 'stop'
      ? await BOTS.stop(ORG, acc, { note })
      : await BOTS.start(ORG, acc, { note, paused: b.paused });
    // Stopping a bot that is set to keep on is a restart, not an ending: the
    // watchdog will have it back within the minute. Say so rather than let it
    // look like the stop did not take.
    if (b.action === 'stop' && acc.keepOn) r.keepOn = true;
    return send(200, 'application/json', JSON.stringify(r));
  }

  if (url.pathname === '/api/poll' && req.method === 'POST') {
    const b = await body(req);
    if (b.id) {
      const acc = ORG.accounts.get(b.id);
      if (acc) { note(`polling ${acc.label} on demand`); ORG.snapshots.add(acc.id, await pollAccount(ORG, acc)); }
      return send(200, 'application/json', JSON.stringify({ ok: true, accounts: ORG.accounts.withSnapshots() }));
    }
    pollCycle();
    return send(200, 'application/json', JSON.stringify({ ok: true, started: true }));
  }

  // ---- resources: the hourly per-city record ----
  if (url.pathname === '/api/resources' && req.method === 'GET') {
    const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 168));
    const accounts = (url.searchParams.get('accounts') || '').split(',').map((x) => x.trim()).filter(Boolean);
    try {
      const out = CITY_RES.series({ orgId: req.org.id, hours, accounts, q: url.searchParams.get('q') || '' });
      // each account's holiday state, for the holiday / not-holiday split: the live badge,
      // else the last badge seen at any age (nobody logs in or out of a holiday while the
      // consoles are down for maintenance), else unknown
      const hol = new Map(tradingAccounts(ORG).map((a) => {
        let h = a.holiday, seen = false;
        if (h == null && HOLI_SEEN.has(a.id)) { h = HOLI_SEEN.get(a.id).holiday; seen = true; }
        const live = liveByAccount.get(a.id);
        if (h == null && live && live.holidayRun) { h = true; seen = true; }
        return [a.id, { holiday: h, seen }];
      }));
      for (const a of out.accounts) Object.assign(a, hol.get(a.id) || { holiday: null, seen: false });
      return send(200, 'application/json', JSON.stringify(out));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ error: e.message })); }
  }
  if (url.pathname === '/api/resources/record' && req.method === 'POST') {
    try { return send(200, 'application/json', JSON.stringify({ ok: true, ...CITY_RES.record({ orgId: req.org.id }) })); }
    catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }
  // the daily 08:30 records, town by town
  if (url.pathname === '/api/resources/mornings' && req.method === 'GET') {
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7));
    const accounts = (url.searchParams.get('accounts') || '').split(',').map((x) => x.trim()).filter(Boolean);
    try {
      return send(200, 'application/json', JSON.stringify({
        ...CITY_RES.mornings({ orgId: req.org.id, days, accounts, q: url.searchParams.get('q') || '' }),
        due: CITY_RES.morningDue(req.org.id) }));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ error: e.message })); }
  }
  // which towns the market glitch does not put back
  if (url.pathname === '/api/resources/restore' && req.method === 'GET') {
    try { return send(200, 'application/json', JSON.stringify(CITY_RES.restoreReport({ orgId: req.org.id }))); }
    catch (e) { return send(200, 'application/json', JSON.stringify({ error: e.message })); }
  }

  // ---- the glitch log: one record per maintenance (glitch-log.js) ----
  //   GET  /api/glitch?from=&to=          -> the days, newest first, for the date filter
  //   GET  /api/glitch/day?day=&q=        -> one day in full: every town, in and out
  //   POST /api/glitch/config {on,relog,leadMin}
  //   POST /api/glitch/record {day, side} -> take one by hand
  //   POST /api/glitch/relog  {day}       -> relog the fleet now (it spends a login each)
  if (url.pathname.startsWith('/api/glitch')) {
    if (!req.org) return send(401, 'application/json', JSON.stringify({ error: 'sign in first' }));
    const org = D.org(req.org.id);
    try {
      if (url.pathname === '/api/glitch' && req.method === 'GET') {
        const from = url.searchParams.get('from') || null, to = url.searchParams.get('to') || null;
        const out = GL.days({ orgId: req.org.id, from, to });
        return send(200, 'application/json', JSON.stringify({ ...out, config: GL.config(org) }));
      }
      if (url.pathname === '/api/glitch/day' && req.method === 'GET') {
        const accounts = (url.searchParams.get('accounts') || '').split(',').map((x) => x.trim()).filter(Boolean);
        return send(200, 'application/json', JSON.stringify(GL.detail({
          orgId: req.org.id, day: url.searchParams.get('day') || '', accounts, q: url.searchParams.get('q') || '' })));
      }
      if (url.pathname === '/api/glitch/config' && req.method === 'POST') {
        const b = await body(req);
        return send(200, 'application/json', JSON.stringify({ ok: true, config: GL.setConfig(org, b || {}) }));
      }
      if (url.pathname === '/api/glitch/record' && req.method === 'POST') {
        const b = await body(req);
        const side = String(b.side || 'before');
        const day = String(b.day || GL.dayKey(Date.now()));
        // Taking one by hand still needs a window to hang it on, so that the day
        // reads the same as one the fleet recorded for itself.
        if (!GL.eventRow(req.org.id, day)) {
          const server = (org.accounts.all().find((a) => a.enabled !== false) || {}).server || 'ss71';
          const rec = MAINT.read(org.settings, server);
          if (rec && GL.dayKey(rec.startAt) === day) GL.ensureEvent(req.org.id, rec);
          else GL.saveEvent(req.org.id, day, { ...GL.assumedWindow(day), source: 'assumed', note: 'opened by hand' });
        }
        const r = GL.take({ orgId: req.org.id, day, side, accounts: glitchAccountMeta(org) });
        return send(200, 'application/json', JSON.stringify({ ok: !!r.taken, ...r }));
      }
      if (url.pathname === '/api/glitch/relog' && req.method === 'POST') {
        const b = await body(req);
        const day = String(b.day || GL.dayKey(Date.now()));
        if (!GL.eventRow(req.org.id, day)) GL.saveEvent(req.org.id, day, { ...GL.assumedWindow(day), source: 'assumed', note: 'opened by hand' });
        const results = await glitchRelog(org, day);
        const ok = Object.values(results).filter((x) => x.ok).length;
        return send(200, 'application/json', JSON.stringify({ ok: true, relogged: ok, total: Object.keys(results).length, results }));
      }
    } catch (e) { return send(200, 'application/json', JSON.stringify({ error: e.message })); }
  }

  // ---- trading: the market play, read off the consoles' logs ----
  // Holiday accounts are one side of the play and the rest the other; which is
  // which comes from the consoles' own live headers (the holiday badge).
  // ---- trading setup: Buying / Selling, the play, Start process / Stop (trading-setup.js) ----
  //   GET  /api/trading/setup                  -> { setup, run, control, accounts, check }
  //   POST /api/trading/setup   { sides?, play?, cleanBefore?, cleanAfter?, delaySec?, gateMin?, ladder?, watchdog? }
  //        saves it (the DB) — never touches the control file
  //   POST /api/trading/control { play?: {...}, holi?: [lords], version } -> the control file NOW (live)
  //   POST /api/trading/start   {}              -> checks, one control-file write, then the sequence
  //   POST /api/trading/stop    { clean? }      -> `end`, wait, restore, clean after
  if (url.pathname.startsWith('/api/trading') && !req.org) {
    return send(403, 'application/json', JSON.stringify({ ok: false, error: 'not in an organization' }));
  }
  if (url.pathname.startsWith('/api/trading/')) {
    const TR = tradingRunner(req.org.id);
    const reply = (extra = {}) => send(200, 'application/json', JSON.stringify({ ok: true, ...TR.view(), ...extra }));
    const fail = (e) => send(200, 'application/json', JSON.stringify({ ok: false, error: e.message, check: e.check || null, conflict: !!e.conflict }));
    const by = (req.user && (req.user.email || req.user.name)) || 'user';
    try {
      if (url.pathname === '/api/trading/setup' && req.method === 'GET') return reply();
      if (url.pathname === '/api/trading/setup' && req.method === 'POST') {
        const b = await body(req);
        TR.saveSetup(b, by);
        // While a play runs, the setup IS the play: its price, caps and runways go to the
        // control file at once, which every running city re-reads before each batch — no
        // Stop/Start (the user, 2026-09-22: "should I just change the setup and let it run,
        // would it automatically adapt?"). The resource and the sides still need a Start: a
        // resource switch cleans reports and restarts the consoles, and moving an account
        // between Buying and Selling means restarting it on the other script.
        let live = null;
        const run = TR.run();
        if (b.play && TR.active() && run.state === 'running') {
          const cur = TS.parseControl(TRADE_CONTROL.read().text);
          const ch = TS.partialChange({ ...b.play, res: undefined, prevRes: 'auto' }, cur);
          delete ch.res; delete ch.prevRes;
          if (ch.price !== undefined) {
            const chk = TS.checkPlay({ sides: Object.fromEntries([...run.buy.map((i) => [i, 'buy']), ...run.sell.map((i) => [i, 'sell'])]),
              accounts: tradingAccounts(ORG), price: ch.price });
            const bad = chk.errors.filter((e) => /holiday/i.test(e));
            if (bad.length) throw new Error(bad.join('\n'));
          }
          if (Object.keys(ch).length) {
            live = TR.applyLive(ch).version;
            note(`trading: setup saved during the play — written to the control file live (${by})`);
          }
        }
        return reply(live ? { written: live } : {});
      }
      if (url.pathname === '/api/trading/control' && req.method === 'POST') {
        const b = await body(req);
        const cur = TS.parseControl(TRADE_CONTROL.read().text);
        const ch = b.play ? TS.partialChange(b.play, cur) : {};
        if (Array.isArray(b.holi)) {
          // only lords of accounts the consoles say are ON HOLIDAY now may go in it: the
          // holi list is what lets an account sell cheap or buy dear (EVONY-RULES §4)
          const accts = tradingAccounts(ORG);
          const bad = b.holi.filter((x) => !accts.some((a) => a.lord === x && a.holiday === true));
          if (bad.length) throw new Error(`not on holiday (or not reporting), so not put in the holi list: ${bad.join(', ')}`);
          ch.holi = b.holi;
        }
        // a live change to a play started from here still has to keep its banks the
        // holiday side: a price across 50 would flip which side that is
        const run = TR.run();
        if (TR.active() && ch.price !== undefined) {
          const chk = TS.checkPlay({ sides: Object.fromEntries([...run.buy.map((i) => [i, 'buy']), ...run.sell.map((i) => [i, 'sell'])]),
            accounts: tradingAccounts(ORG), price: ch.price });
          const bad = chk.errors.filter((e) => /holiday/i.test(e));
          if (bad.length) throw new Error(bad.join('\n'));
        }
        if (!Object.keys(ch).length) throw new Error('nothing to change');
        const r = TR.applyLive(ch, b.version);
        note(`trading: control file written from the Trading tab (${by})`);
        return reply({ written: r.version });
      }
      if (url.pathname === '/api/trading/start' && req.method === 'POST') {
        const b = await body(req);
        if (b.setup) TR.saveSetup(b.setup, by);
        for (const [oid, other] of TRADE_RUNNERS) {
          if (oid !== req.org.id && other.active()) throw new Error('another organization has a play running on this machine — one control file, one play');
        }
        TR.start({ by });
        TR.tick();                       // the first step now, not in 5 s
        return reply();
      }
      if (url.pathname === '/api/trading/stop' && req.method === 'POST') {
        const b = await body(req);
        TR.requestStop({ clean: b.clean === undefined ? undefined : !!b.clean, by });
        TR.tick();
        return reply();
      }
    } catch (e) { return fail(e); }
    return send(404, 'application/json', JSON.stringify({ ok: false, error: 'no such trading route' }));
  }

  if (url.pathname === '/api/trading') {
    const minutes = Math.min(720, Math.max(15, Number(url.searchParams.get('minutes')) || 60));
    // A play started from the Trading tab says which accounts are in it and which side is
    // the holiday (bank) side; without one, the holiday badges decide as before.
    const run = tradingRunner(req.org.id).run();
    const runOn = run && Array.isArray(run.banks) && (['starting', 'running', 'stopping'].includes(run.state)
      || (run.stoppedAt && Date.now() - run.stoppedAt < minutes * 60000));
    const inRun = runOn ? new Set([...(run.buy || []), ...(run.sell || [])]) : null;
    const bankIds = runOn ? new Set(run.banks || (run.bankSide === 'buy' ? run.buy : run.sell) || []) : null;
    const accounts = ORG.accounts.all()
      .filter((a) => fs.existsSync(path.join(TRADE_DIR, `console-${a.id}.log`)))
      .filter((a) => !inRun || inRun.has(a.id))
      .map((a) => {
        const live = liveByAccount.get(a.id) || {};
        if (live.connected) TRADE_HOLIDAY.set(a.id, !!live.holiday);
        const holiday = bankIds ? bankIds.has(a.id) : (TRADE_HOLIDAY.get(a.id) ?? !!live.holiday);
        return { id: a.id, label: a.label, holiday, connected: live.connected ?? null };
      });
    try {
      const rep = TRADE.report(TRADE_MON, accounts, { minutes, dir: __dirname });
      if (runOn) {
        rep.run = { state: run.state, createdAt: run.createdAt, runningAt: run.runningAt || null, stoppedAt: run.stoppedAt || null,
          kind: run.kind, bankSide: run.bankSide, res: run.res, price: run.price,
          buy: run.buy, sell: run.sell, labels: run.labels, cleanBefore: !!run.cleanBefore, cleanAfter: !!run.cleanAfter };
      }
      return send(200, 'application/json', JSON.stringify(rep));
    } catch (e) {
      return send(200, 'application/json', JSON.stringify({ error: e.message }));
    }
  }

  // ---- uptime ----
  // ---------------------------------------------------------------- Monitor
  // Everything the Monitor tab reads and writes. The searches are served from the
  // database this Director shares with the Monitor process and the consoles, so
  // they cost the game nothing — the only routes that reach the game at all are
  // start/stop (which spawn the Monitor) and `run`, the Now buttons.
  if (url.pathname.startsWith('/api/monitor')) {
    if (!ORG) return send(401, 'application/json', JSON.stringify({ ok: false, error: 'sign in first' }));
    const q = url.searchParams;
    const cfg = MON.config(ORG);
    // The server the Monitor is watching: the chosen account's, else the fleet's.
    const chosen = cfg.account ? ORG.accounts.get(cfg.account) : null;
    const server = (chosen && chosen.server)
      || (ORG.accounts.all().find((a) => a.server) || {}).server || 'ss71';
    const num = (v, d = null) => (v === null || v === '' || v === undefined ? d : Number(v));
    // The alliance picker sends one `ally=` (keep) or `notAlly=` (hide) per
    // alliance, repeated rather than comma-joined, because an alliance name may
    // hold a comma. An EMPTY one is meant: it is "no alliance at all".
    const allies = (k) => q.getAll(k);

    if (url.pathname === '/api/monitor' && req.method === 'GET') {
      const run = monRunning(ORG);
      return send(200, 'application/json', JSON.stringify({
        ok: true, ...MON.status(server, ORG),
        process: run ? { pid: run.pid, mine: run.mine } : null,
        // whose console it can drive: an account with a console registered for it
        accounts: ORG.accounts.all().map((a) => ({
          id: a.id, label: a.label, server: a.server || 'ss71', enabled: a.enabled !== false,
          consoleUrl: MON.consoleUrl(ORG, a.id),
          live: (liveByAccount.get(a.id) || null),
        })),
        sweeps: MON.sweeps(server, 30),
      }));
    }

    if (url.pathname === '/api/monitor/config' && req.method === 'POST') {
      const b = await body(req);
      const patch = {};
      for (const k of ['mapMin', 'statsMin', 'watchMin', 'watchTop', 'stallMin', 'blocksPerCall', 'pauseMs',
        'readingEveryMin', 'readingKeepDays']) {
        if (b[k] !== undefined) patch[k] = Number(b[k]);
      }
      if (b.account !== undefined) patch.account = String(b.account || '');
      if (b.watchNames !== undefined) {
        patch.watchNames = Array.isArray(b.watchNames) ? b.watchNames
          : String(b.watchNames || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      }
      // Choosing an account only says whose console to drive — nothing logs in,
      // and that console goes on playing its own goals exactly as before.
      if (patch.account !== undefined && patch.account && patch.account !== cfg.account) {
        const a = ORG.accounts.get(patch.account);
        if (!a) return send(200, 'application/json', JSON.stringify({ ok: false, error: 'no such account' }));
        if (!MON.consoleUrl(ORG, patch.account)) {
          return send(200, 'application/json', JSON.stringify({ ok: false,
            error: `${a.label} has no console running — the Monitor reads through one, it never logs in itself` }));
        }
        note(`monitor: reading through ${a.label}'s console`);
      }
      const saved = MON.setConfig(ORG, patch);
      return send(200, 'application/json', JSON.stringify({ ok: true, config: saved }));
    }

    if (url.pathname === '/api/monitor/switch' && req.method === 'POST') {
      const b = await body(req);
      const on = !!b.on;
      if (on && !cfg.account) {
        return send(200, 'application/json', JSON.stringify({ ok: false, error: 'choose an account first' }));
      }
      if (on) {
        const reach = await MON.reachConsole(ORG, cfg.account);
        if (reach.error) return send(200, 'application/json', JSON.stringify({ ok: false, error: reach.error }));
      }
      MON.setConfig(ORG, { on });
      const r = on ? monStart(ORG) : monStop(ORG);
      return send(200, 'application/json', JSON.stringify({ ok: true, on, ...r, config: MON.config(ORG) }));
    }

    // The Now buttons: one pass, started here rather than waiting for its turn.
    // It runs in this process; the Monitor's own loop keeps its schedule.
    if (url.pathname === '/api/monitor/run' && req.method === 'POST') {
      const b = await body(req);
      const kind = String(b.kind || 'map');
      if (!cfg.account) return send(200, 'application/json', JSON.stringify({ ok: false, error: 'choose an account first' }));
      const reach = await MON.reachConsole(ORG, cfg.account);
      if (reach.error) return send(200, 'application/json', JSON.stringify({ ok: false, error: reach.error }));
      const args = { org: ORG, server, accountId: cfg.account, cfg, log: note };
      const job = kind === 'map' ? MON.mapSweep({ ...args, onProgress: (p) => MON.writeStatus(ORG, { state: 'map sweep', progress: p }) })
        : kind === 'stats' ? MON.statsPass(args) : kind === 'watch' ? MON.watchPass(args) : null;
      if (!job) return send(200, 'application/json', JSON.stringify({ ok: false, error: 'map, stats or watch' }));
      note(`monitor: ${kind} pass started by hand`);
      job.then((r) => note(`monitor: ${kind} pass ${r && r.error ? 'failed — ' + r.error : 'done'}`))
        .catch((e) => note(`monitor: ${kind} pass failed — ${e.message}`))
        .finally(() => MON.writeStatus(ORG, { state: 'waiting', progress: null }));
      return send(200, 'application/json', JSON.stringify({ ok: true, started: kind }));
    }

    // The Statistics view: one of the four ranked lists, filtered a column at a time.
    if (url.pathname === '/api/monitor/stats') {
      const kind = q.get('kind') || 'players';
      if (!MON.searchStats || !require('./statistics').KINDS[kind]) {
        return send(200, 'application/json', JSON.stringify({ ok: false, error: 'no such list' }));
      }
      const filters = {};
      for (const [k, v] of url.searchParams) {
        if (!k.startsWith('f_') || v === '') continue;
        const col = k.slice(2);
        if (col.endsWith('Min')) (filters[col.slice(0, -3)] ||= {}).min = v;
        else if (col.endsWith('Max')) (filters[col.slice(0, -3)] ||= {}).max = v;
        else filters[col] = v;
      }
      const res = MON.searchStats(server, kind, {
        q: q.get('q') || '', sort: q.get('sort') || 'rank', dir: q.get('dir') || 'asc',
        limit: q.get('limit') || 200, offset: q.get('offset') || 0, filters,
      });
      return send(200, 'application/json', JSON.stringify({ ok: true, server, status: MON.status(server, ORG).stats, ...res }));
    }

    // The cities the map sweep found — every one of them, not just the ranked few.
    if (url.pathname === '/api/monitor/cities') {
      return send(200, 'application/json', JSON.stringify({ ok: true, server,
        ...MON.searchCities(server, {
          q: q.get('q') || '', alliance: q.get('alliance') || '', lord: q.get('lord') || '',
          allies: allies('ally'), notAllies: allies('notAlly'),
          state: q.get('state') || '', minPrestige: q.get('minPrestige') || '', level: q.get('level') || '',
          sort: q.get('sort') || 'prestige', dir: q.get('dir') || 'desc',
          limit: q.get('limit') || 200, offset: q.get('offset') || 0, seenMin: num(q.get('seenMin'), 0),
        }) }));
    }

    // The lords: who is moving, who has stood still, and who is on holiday.
    if (url.pathname === '/api/monitor/players') {
      return send(200, 'application/json', JSON.stringify({ ok: true, server,
        ...MON.searchPlayers(server, {
          q: q.get('q') || '', alliance: q.get('alliance') || '', state: q.get('state') || '',
          allies: allies('ally'), notAllies: allies('notAlly'),
          watch: q.get('watch') === '1', moving: q.get('moving') || '',
          sort: q.get('sort') || 'prestige', dir: q.get('dir') || 'desc',
          limit: q.get('limit') || 200, offset: q.get('offset') || 0, stallMin: cfg.stallMin,
        }) }));
    }

    // The Changes table: searched, sorted on any column it shows, a page at a
    // time. Every row carries its lord's best hero, off the rankings the stats
    // sweep already collected — no game traffic.
    if (url.pathname === '/api/monitor/events') {
      return send(200, 'application/json', JSON.stringify({ ok: true, server,
        ...MON.eventPage(server, {
          kind: q.get('kind') || '', userName: q.get('name') || '', watch: q.get('watch') === '1',
          allies: allies('ally'), notAllies: allies('notAlly'),
          q: q.get('q') || '', sort: q.get('sort') || 'at', dir: q.get('dir') || 'desc',
          limit: q.get('limit') || 200, offset: q.get('offset') || 0, sinceMs: num(q.get('sinceMs'), 0),
          stillMin: num(q.get('stillMin'), 0),
        }) }));
    }

    // One lord in full, for the Changes table's best-hero panel: every city of
    // theirs on the map, and their best heroes. Both come from sweeps already
    // taken — it asks the game nothing.
    if (url.pathname === '/api/monitor/lord') {
      const name = q.get('name') || '';
      if (!name) return send(200, 'application/json', JSON.stringify({ ok: false, error: 'no lord named' }));
      return send(200, 'application/json', JSON.stringify({ ok: true, server,
        ...MON.lordSheet(server, name, { heroes: num(q.get('heroes'), 10),
          readings: num(q.get('readings'), 200) }) }));
    }

    if (url.pathname === '/api/monitor/history') {
      const name = q.get('name') || '';
      return send(200, 'application/json', JSON.stringify({ ok: true, server, name,
        rows: MON.history(server, name, q.get('limit') || 500),
        events: MON.events(server, { userName: name, limit: 100 }),
        player: MON.searchPlayers(server, { q: name, limit: 1, stallMin: cfg.stallMin }).rows[0] || null }));
    }

    // Every alliance on the server, for the picker the Cities, Lords and Changes
    // views filter with. It is a count over rows already swept — no game traffic.
    if (url.pathname === '/api/monitor/alliances') {
      return send(200, 'application/json', JSON.stringify({ ok: true, server, rows: MON.alliances(server) }));
    }

    // Who the watch list would be right now, for the Setup view to show before
    // the next pass runs.
    if (url.pathname === '/api/monitor/watchlist') {
      return send(200, 'application/json', JSON.stringify({ ok: true, server, rows: MON.watchList(server, cfg) }));
    }

    return send(404, 'application/json', JSON.stringify({ ok: false, error: 'not found' }));
  }

  if (url.pathname === '/api/uptime') {
    const hours = Math.min(720, Math.max(1, Number(url.searchParams.get('hours')) || 12));
    const since = Date.now() - hours * 3600000;
    const rows = ORG.uptime.series(since, url.searchParams.get('probe') || null);

    // A trading console that runs out of memory (EVONY-RULES.md, 2026-09-20) gets
    // restarted "plainly" on a new port every few hours, and each restart used to
    // register a brand new probe without ever dropping the old one — so one
    // account piled up several ghost rows, most of them dead (0% up) while only
    // the newest carried real data. The account is the true identity here, not
    // the probe name or port, so everything is folded into one series per
    // account, under the probe name it answered under most recently. A probe
    // that has never once answered with an account (a fresh entry nobody has
    // started yet) keeps its own row.
    const acctOfProbe = new Map();   // probe name -> whose it is (probeAccount below)
    const nameOfAcct = new Map();    // accountId -> probe name that last ANSWERED as it
    const lastNameOfAcct = new Map();// ...or, if nothing answered in the window, the last one tried
    // A dead probe writes a row with no account in it (nothing answered to say
    // whose it was), so a ghost keeps piling those up every minute. Whose it is
    // comes from, in order: the "(a5)" registerProbe puts on a clashing name, the
    // accountId the probe list gives it, the account whose label it is named
    // after, and only then whatever answered under that name most often. Not the
    // LAST answer: a port reused by another account for a minute ("Lord13 (a13)"
    // answering as a1, 2026-09-22) would otherwise hand it the whole dead history.
    // Without the label, a ghost that died before this window ("Lord05" beside
    // "Lord05 (a5)") never resolved and got a red row of its own.
    const owned = new Map(ORG.accounts.all().map((a) => [a.id, a]));
    const byLabel = new Map([...owned.values()].map((a) => [String(a.label || '').trim().toLowerCase(), a.id]));
    const cfgAcct = new Map(probeList(ORG).filter((p) => p.accountId).map((p) => [p.probe, p.accountId]));
    const seen = new Map();          // probe name -> Map(accountId -> answers)
    for (const r of rows) {
      if (!r.accountId) continue;
      const m = seen.get(r.probe) || new Map();
      m.set(r.accountId, (m.get(r.accountId) || 0) + 1);
      seen.set(r.probe, m);
    }
    const probeAccount = (name) => {
      const suffix = /\(([^()]+)\)\s*$/.exec(name);
      if (suffix && owned.has(suffix[1])) return suffix[1];
      if (cfgAcct.has(name)) return cfgAcct.get(name);
      const bare = String(name).replace(/\s*\([^()]*\)\s*$/, '').trim().toLowerCase();
      if (byLabel.has(bare)) return byLabel.get(bare);
      const m = seen.get(name);
      return m ? [...m].sort((a, b) => b[1] - a[1])[0][0] : null;
    };
    for (const r of rows) if (!acctOfProbe.has(r.probe)) acctOfProbe.set(r.probe, probeAccount(r.probe));
    // Rows are grouped under the name, so an account must never borrow a name
    // that belongs to another one — the two would be drawn as one line.
    for (const r of rows) {
      if (!r.accountId || acctOfProbe.get(r.probe) !== r.accountId) continue;
      lastNameOfAcct.set(r.accountId, r.probe);
      if (r.reachable) nameOfAcct.set(r.accountId, r.probe);
    }
    const canonOf = (a) => nameOfAcct.get(a) || lastNameOfAcct.get(a)
      || (owned.get(a) && owned.get(a).label) || a;
    const acctOf = (r) => r.accountId || acctOfProbe.get(r.probe) || null;
    const keyOf = (r) => { const a = acctOf(r); return a ? 'acct:' + a : 'probe:' + r.probe; };
    const nameOf = (r) => { const a = acctOf(r); return a ? canonOf(a) : r.probe; };

    // One sample per account per sampling instant. Every probe is asked at the
    // same `at`, so when an account's console answers on one port the dead old
    // ports asked in that same round are not the account being down — the live
    // row wins, and only a round where NOTHING answered counts (once) as down.
    const best = new Map();
    for (const r of rows) {
      const k = keyOf(r) + '|' + r.at;
      const cur = best.get(k);
      if (!cur || Number(r.up) > Number(cur.up) || (Number(r.up) === Number(cur.up) && Number(r.reachable) > Number(cur.reachable))) best.set(k, r);
    }

    // Bucket into fixed slots so a gap (bot process dead, nothing written) shows
    // up as a real hole rather than the chart joining across it.
    const bucketMs = Math.max(UPTIME_MS, Math.round((hours * 3600000) / 720));
    const buckets = new Map();
    for (const r of best.values()) {
      const key = keyOf(r) + '|' + Math.floor(r.at / bucketMs);
      const cur = buckets.get(key) || { probe: nameOf(r), t: Math.floor(r.at / bucketMs) * bucketMs,
        n: 0, up: 0, reachable: 0, activity: 0, maintenance: 0, label: null, reason: null, state: null };
      cur.n++;
      cur.up += r.up; cur.reachable += r.reachable; cur.activity += r.activity;
      cur.maintenance += (r.maintenance || 0);
      cur.label = r.label || cur.label;
      if (!r.up) { cur.reason = r.reason || cur.reason; cur.state = r.state || cur.state; }
      buckets.set(key, cur);
    }

    const probes = {};
    for (const b of buckets.values()) (probes[b.probe] = probes[b.probe] || []).push(b);
    for (const k of Object.keys(probes)) probes[k].sort((a, b) => a.t - b.t);

    // Summary per probe over the whole window, including the downtime the
    // samples never recorded because nothing was running to record it.
    const slots = Math.max(1, Math.round((hours * 3600000) / bucketMs));
    // Only count as "expected" the part of the window we were actually watching,
    // otherwise a Director started an hour ago reports 11 hours of fake outage.
    const firstEver = (D.one('SELECT min(at) m FROM uptime') || {}).m || Date.now();
    const watchedMs = Math.max(0, Date.now() - Math.max(since, firstEver));
    const summary = Object.entries(probes).map(([probe, list]) => {
      const samples = list.reduce((s, b) => s + b.n, 0);
      const up = list.reduce((s, b) => s + b.up, 0);
      const reach = list.reduce((s, b) => s + b.reachable, 0);
      const act = list.reduce((s, b) => s + b.activity, 0);
      // Scheduled maintenance is not the bot failing, so it is reported
      // separately and taken out of the denominator rather than counted
      // as downtime.
      const maint = list.reduce((s, b) => s + b.maintenance, 0);
      // Never below the samples actually taken: the sampler fires once at startup
      // as well as on the interval, so a bare division can round below reality
      // and push the percentages past 100.
      const expected = Math.max(1, samples, Math.round(watchedMs / UPTIME_MS));
      const missing = Math.max(0, expected - samples);
      const worst = list.filter((b) => b.up < b.n && !b.maintenance).slice(-5)
        .map((b) => ({ t: b.t, reason: b.reason || b.state }));
      const graded = Math.max(1, expected - maint);
      return {
        probe, samples, expected, missing, maintenance: maint,
        upPct: (up / graded) * 100,
        reachablePct: (reach / graded) * 100,
        activePct: (act / graded) * 100,
        lastSample: list.length ? list[list.length - 1].t : null,
        label: list.length ? list[list.length - 1].label : null,
        recentTrouble: worst,
      };
    });

    // The configured list is what the Fleet's Probes editor last saved, port and
    // all — it still has one line per restart until the console at an old port
    // is deliberately dropped there. Fold it the same way: a configured probe
    // that this window has already resolved to an account, under a name other
    // than the one that account is using now, is a leftover from a dead port and
    // is left out; one that has never answered at all (freshly added, or the
    // account has not started yet) still gets its "no data" card.
    const configured = probeList(ORG).filter((p) => {
      const acctId = acctOfProbe.get(p.probe);
      return !acctId || canonOf(acctId) === p.probe;
    });

    // The very first sample ever recorded. Before it, an empty slot means the
    // Director was not watching yet — which is not the same as the bot being
    // down, and must not be painted as an outage.
    return send(200, 'application/json', JSON.stringify({
      hours, bucketMs, sampleMs: UPTIME_MS, slots, now: Date.now(),
      firstSample: firstEver,
      probes, summary, configured,
    }));
  }

  if (url.pathname === '/api/probes' && req.method === 'POST') {
    const b = await body(req);
    if (Array.isArray(b.probes)) {
      ORG.settings.set('probes', b.probes.filter((p) => p && p.probe && p.url));
      note(`uptime probes updated: ${probeList(ORG).map((p) => p.probe).join(', ')}`);
    }
    return send(200, 'application/json', JSON.stringify({ ok: true, probes: probeList(ORG) }));
  }

  // ---- Claude: what it may do per account, auto-wake, and the wake log ----
  // (claude-perms.js, claude-wake.js; the Claude tab, 2026-09-28). The same
  // switches as each console's Settings -> Claude permissions. A Claude key
  // never changes any of this: a woken Claude cannot grant itself anything.
  if (url.pathname === '/api/claude' && req.method === 'GET') {
    const P = require('./claude-perms');
    const accounts = ORG.accounts.all();
    return send(200, 'application/json', JSON.stringify({
      ok: true,
      autoWake: WAKE.isOn(req.org && req.org.id),
      // open each wake as a Remote Control session (on by default) or the hidden -p run
      remote: WAKE.isRemote(req.org && req.org.id),
      cap: WAKE.cap(), lastHour: WAKE.wakesLastHour(), running: WAKE.running(),
      perms: P.PERMS.map((k, i) => ({ key: k, n: i + 1, label: P.LABELS[k], help: P.HELP[k] })),
      accounts: accounts.map((a) => ({ id: a.id, label: a.label, enabled: a.enabled !== false, perms: P.get(a.id) })),
      wakes: WAKE.wakes(req.org && req.org.id, 50),
    }));
  }
  if (url.pathname.startsWith('/api/claude/') && req.method === 'POST' && req.claude) {
    return send(403, 'application/json', JSON.stringify({ ok: false, error: 'refused: a Claude may not change the Claude settings' }));
  }
  if (url.pathname === '/api/claude/perms' && req.method === 'POST') {
    const P = require('./claude-perms');
    const b = await body(req);
    // { id, perms: {gate:true,...} } for one account, or { all: true, perms } for
    // every account of this org (the column's set-all)
    const ids = b.all ? ORG.accounts.all().map((a) => a.id) : [String(b.id || '')];
    for (const id of ids) {
      if (!ORG.ownsAccount(id)) return send(200, 'application/json', JSON.stringify({ ok: false, error: `no account ${id}` }));
    }
    const out = {};
    for (const id of ids) out[id] = P.set(id, b.perms || {});
    note(`Claude permissions changed for ${ids.length === 1 ? ((ORG.accounts.get(ids[0]) || {}).label || ids[0]) : `${ids.length} accounts`}: `
      + Object.entries(b.perms || {}).map(([k, v]) => `${k} ${v ? 'on' : 'off'}`).join(', '));
    return send(200, 'application/json', JSON.stringify({ ok: true, perms: out }));
  }
  if (url.pathname === '/api/claude/autowake' && req.method === 'POST') {
    const b = await body(req);
    if (b.on !== undefined) { WAKE.setOn(req.org && req.org.id, !!b.on); note(`Claude auto-wake on attack: ${b.on ? 'ON' : 'off'}`); }
    if (b.cap !== undefined) { WAKE.setCap(b.cap); note(`Claude auto-wake cap: ${WAKE.cap()} an hour, fleet-wide`); }
    if (b.remote !== undefined) { WAKE.setRemote(req.org && req.org.id, !!b.remote); note(`Claude wakes open as ${b.remote ? 'a Remote Control session' : 'a hidden run'}`); }
    return send(200, 'application/json', JSON.stringify({ ok: true, autoWake: WAKE.isOn(req.org && req.org.id), remote: WAKE.isRemote(req.org && req.org.id), cap: WAKE.cap() }));
  }

  // ---- per-account history for the fleet charts ----
  if (url.pathname === '/api/history') {
    const id = url.searchParams.get('id');
    const field = url.searchParams.get('field') || 'prestige';
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7));
    return send(200, 'application/json', JSON.stringify({
      id, field, points: ORG.snapshots.series(id, Date.now() - days * 86400000, field),
    }));
  }

  send(404, 'text/plain', 'not found');
}).listen(PORT, AUTH.bindHost(), () => {
  const st = D.stats();
  note(`OTTObot Director on http://localhost:${PORT}  `
    + `(${D.orgs.all().length} org(s), ${st.accounts} account(s), ${GAP_MS / 1000}s between polls)`);
  note(`storage: ${path.basename(D.FILE)} — ${(st.sizeBytes / 1024).toFixed(0)} KB, ${st.snapshots} snapshot(s), ${st.uptime} uptime sample(s)`);
  // Which accounts have no bot behind them. Starting them is opt-in: a console
  // logs into the game, and that is not something to do to every account on the
  // list just because a Director restarted. BOT_AUTOSTART=1 says do it anyway,
  // which is what you want on a machine that has just rebooted.
  setTimeout(async () => {
    for (const o of D.orgs.all()) {
      if (o.disabled) continue;
      const org = D.org(o.id);
      for (const acc of org.accounts.all()) {
        if (acc.enabled === false || !acc.email || !acc.password) continue;
        if (await BOTS.running(org, acc)) continue;
        if (process.env.BOT_AUTOSTART === '1') await BOTS.start(org, acc, { note });
        else note(`${acc.label}: no console is running — click the row to start one`);
      }
    }
  }, 5000);

  // Give any console that is starting alongside the Director time to come up
  // and claim its account before the first poll goes looking for logins.
  setTimeout(pollCycle, FIRST_POLL_MS);
  // The keep-on watchdog runs every KEEP_MS, starting one interval in — which
  // also gives a console coming up alongside the Director time to answer, so it
  // is not counted as missing and started a second time.
  setTimeout(() => { keepBotsOn(); setInterval(keepBotsOn, KEEP_MS); }, KEEP_MS);
  const totalAccounts = D.orgs.all().reduce((t, o) => t + D.org(o.id).accounts.all().length, 0);
  setInterval(pollCycle, Math.max(CYCLE_MIN_MS, totalAccounts * GAP_MS + 60000));
  sampleUptime();
  setInterval(sampleUptime, UPTIME_MS);
  // Prepend / Append goal files: a changed file reaches its accounts' goals
  // within SYNC_MS, and the consoles read those every turn (goalfiles.js).
  if (LOCAL_FILES) {
    const syncFiles = () => GF.syncAll(D.orgs.all().filter((o) => !o.disabled).map((o) => D.org(o.id)), { note, seen: GOALFILE_SEEN });
    syncFiles();
    setInterval(syncFiles, GF.SYNC_MS);
  }
  // The Trading tab's plays: a run that was going when the Director stopped carries on
  // (running, stopping); one that was mid-start is marked interrupted, not resumed.
  for (const o of D.orgs.all()) {
    if (o.disabled) continue;
    try { if (D.org(o.id).settings.get(TS.RUN_KEY, null)) tradingRunner(o.id).resume(); } catch (e) { note('trading: ' + e.message); }
  }
  setInterval(() => { for (const r of TRADE_RUNNERS.values()) r.tick(); }, 5000);
  // Retention is by age and applies to every organization alike.
  setInterval(() => { D.uptime.prune(30); D.snapshots.prune(90); GL.prune(120); }, 6 * 3600000);
  // Keep the write-ahead log from growing all night.
  setInterval(() => {
    const before = D.stats().walBytes;
    D.checkpoint('PASSIVE');
    const after = D.stats().walBytes;
    if (before > 8e6) note(`wal checkpoint: ${(before / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(1)}MB`);
  }, 5 * 60000);
});
