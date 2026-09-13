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
const { execFile } = require('child_process');
const { Game } = require('./game');
const { buildSnapshot } = require('./snapshot');

const D = require('./db');
const AUTH = require('./auth');
AUTH.configure();

const PORT = Number(process.env.DIRECTOR_PORT || 8712);
const GAP_MS = Number(process.env.POLL_GAP_MS || 25000);   // between accounts
const CYCLE_MIN_MS = Number(process.env.POLL_CYCLE_MS || 10 * 60000);
const UPTIME_MS = Number(process.env.UPTIME_MS || 60000);  // bot health sample

const n = (x) => Number(x || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = [];
const note = (m) => { log.push({ t: Date.now(), m: String(m) }); if (log.length > 500) log.shift(); console.log(new Date().toLocaleTimeString(), m); };

// seed from .env on first run so there is something to look at
if (!D.accounts.all().length && fs.existsSync(path.join(__dirname, '.env'))) {
  const env = {};
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2];
  }
  if (env.EVONY_EMAIL) {
    D.accounts.upsert({ id: 'a1', label: 'Lord22', server: env.EVONY_SERVER || 'ss71', email: env.EVONY_EMAIL, password: env.EVONY_PASSWORD, enabled: true, notes: 'seeded from .env' });
  }
}

// ------------------------------------------------------------------ proxies
// Evony tolerates roughly 10 accounts per IP, so accounts are spread across the
// proxy list. An account may pin a specific proxy with `proxy: "<raw line>"`.
const { parseList, parseProxy } = require('./proxy');
const PROXY_FILE = path.join(__dirname, 'proxies.txt');
const MAX_PER_PROXY = Number(process.env.MAX_PER_PROXY || 10);

function proxyText() {
  let t = D.settings.get('proxyText', null);
  if (t === null && fs.existsSync(PROXY_FILE)) {
    t = fs.readFileSync(PROXY_FILE, 'utf8');
    D.settings.set('proxyText', t);
  }
  return t || '';
}
function loadProxies() { return parseList(proxyText()); }

// Deterministic spread: account order decides the bucket, so assignments are
// stable between restarts instead of shuffling every poll.
function proxyAssignments() {
  const list = loadProxies();
  const out = new Map();
  if (!list.length) return out;
  const accts = D.accounts.all();
  const spread = accts.filter((a) => !a.proxy);
  spread.forEach((a, i) => out.set(a.id, list[Math.floor(i / MAX_PER_PROXY) % list.length]));
  for (const a of accts.filter((x) => x.proxy)) {
    const p = parseProxy(a.proxy);
    if (p) out.set(a.id, p);
  }
  return out;
}

function proxyFor(acc) { return proxyAssignments().get(acc.id) || null; }

// ---------------------------------------------------------------- snapshot
async function pollAccount(acc) {
  const g = new Game(() => {});
  const started = Date.now();
  const proxy = proxyFor(acc);
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

// ------------------------------------------------------------ poll rotation
let polling = false;
// The console holds a live session per focused account. Logging in again for the
// same account makes the server kick that session, so ask the console first.
// Every configured console is asked, not just the first one: with a console per
// account, checking only :8711 would let the poller log into the account held by
// a console on another port and kick it.
async function focusedAccountIds() {
  const held = new Set();
  for (const pr of probeList()) {
    const r = await getJson(pr.url.replace(/\/$/, '') + '/api/session', 1500);
    if (!r.ok || !r.json) continue;
    // Claim the account if the console OWNS it, even mid-reconnect — otherwise
    // the poller slips into that window and the two fight over the login.
    if (r.json.account && r.json.account.id) held.add(r.json.account.id);
  }
  return held;
}

async function pollCycle() {
  if (polling) return;
  polling = true;
  const targets = D.accounts.all().filter((a) => a.enabled !== false);
  note(`poll cycle: ${targets.length} account(s), ~${Math.round((targets.length * GAP_MS) / 60000)} min`);
  const focused = await focusedAccountIds();
  for (const acc of targets) {
    if (focused.has(acc.id)) {
      note(`${acc.label}: open in the console — skipped (a second login would kick it)`);
      continue;
    }
    const snap = await pollAccount(acc);
    D.snapshots.add(acc.id, snap);
    note(snap.ok ? `${acc.label}: ok (${snap.cities} cities, ${snap.incoming} incoming)` : `${acc.label}: ${snap.error}`);
    await sleep(GAP_MS);
  }
  polling = false;
  note('poll cycle done');
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

function probeList() {
  const extra = D.settings.get('probes', null);
  return Array.isArray(extra) && extra.length ? extra : PROBE_DEFAULTS;
}

function getJson(url, timeout = 2500) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get(url, { timeout }, (res) => {
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

const lastSeq = {};

// The live header each console last reported, keyed by account id. A console
// holds the truth about its own account — the Director never polls an account a
// console owns, so its snapshot is by definition older than the console's view.
// Without this the Fleet tab happily showed "reporting" while the bot itself was
// sitting in maintenance.
const liveByAccount = new Map();

async function sampleUptime() {
  const at = Date.now();
  for (const pr of probeList()) {
    const r = await getJson(pr.url.replace(/\/$/, '') + '/api/session');
    if (!r.ok) {
      D.uptime.add({ at, probe: pr.probe, reachable: false, up: false,
        state: 'down', reason: r.error === 'ECONNREFUSED' ? 'bot process not running' : r.error,
        latencyMs: r.ms, activity: false });
      for (const [id, v] of liveByAccount) {
        if (v.probe === pr.probe) {
          liveByAccount.set(id, { ...v, at, connected: false, state: 'process down',
            reason: r.error === 'ECONNREFUSED' ? 'bot process not running' : r.error });
        }
      }
      continue;
    }
    const h = r.json || {};
    // A console-held account is never polled by pollCycle (a second login would
    // kick it), so without this its snapshot history would stay empty — exactly
    // for the accounts that are actually being run. The console publishes one
    // every few minutes and the Director just files it.
    if (h.snapshot && h.account && h.account.id) {
      try {
        const last = D.one('SELECT at FROM snapshots WHERE accountId = ? ORDER BY at DESC LIMIT 1', h.account.id);
        if (!last || h.snapshot.at > n(last.at)) D.snapshots.add(h.account.id, h.snapshot);
      } catch (e) { note(`snapshot from ${pr.probe}: ${e.message}`); }
    }
    // Traffic within the sample window, or the log/tick counters moved.
    const seq = n(h.logSeq);
    const moved = lastSeq[pr.probe] !== undefined && seq !== lastSeq[pr.probe];
    lastSeq[pr.probe] = seq;
    const fresh = h.idleMs !== null && h.idleMs !== undefined && n(h.idleMs) < UPTIME_MS * 1.5;
    const paused = !!(h.maintenance && h.maintenance.paused);
    if (h.account && h.account.id) {
      liveByAccount.set(h.account.id, {
        at, probe: pr.probe,
        connected: !!h.connected,
        state: paused ? 'maintenance' : (h.state || null),
        reason: paused ? (h.maintenance.why || 'server maintenance') : (h.reason || null),
        engineMode: h.engineMode || null,
        maintenance: h.maintenance || null,
        retryInSec: h.retryInSec ?? null,
        proc: h.proc || null,
      });
    }
    D.uptime.add({
      at, probe: pr.probe,
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
}

// which NEAT bots are running on this machine (matches the old Director's view)
function scanProcesses() {
  return new Promise((resolve) => {
    // NEAT only runs on Windows; elsewhere there is no bobby.exe and no tasklist.
    if (process.platform !== 'win32') return resolve([]);
    execFile('tasklist', ['/fi', 'imagename eq bobby.exe', '/fo', 'csv', '/nh'], (err, out) => {
      if (err || !out || /No tasks/i.test(out)) return resolve([]);
      const rows = out.trim().split(/\r?\n/).map((l) => l.split('","').map((s) => s.replace(/^"|"$/g, '')));
      resolve(rows.filter((r) => r.length >= 5).map((r) => ({ name: r[0], pid: Number(r[1]), memory: r[4] })));
    });
  });
}

// ------------------------------------------------------------------- server
const body = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch { res({}); } }); });

const rawBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b));
});

http.createServer(async (req, res) => {
  if (await AUTH.guard(req, res, { readBody: rawBody })) return;
  const url = new URL(req.url, 'http://x');
  const send = (code, type, data) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' }); res.end(data); };

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return send(200, 'text/html', fs.readFileSync(path.join(__dirname, 'public', 'director.html')));
  }

  if (url.pathname === '/api/accounts') {
    const procs = await scanProcesses();
    const assign = proxyAssignments();
    const list = loadProxies();
    const counts = {};
    for (const [, p] of assign) counts[p.label] = (counts[p.label] || 0) + 1;
    return send(200, 'application/json', JSON.stringify({
      accounts: D.accounts.withSnapshots().map((a) => ({
        ...a,
        proxyLabel: (assign.get(a.id) || {}).label || null,
        live: liveByAccount.get(a.id) || null,
      })),
      polling, gapMs: GAP_MS, processes: procs, log: log.slice(-120),
      proxies: list.map((p) => ({ label: p.label, accounts: counts[p.label] || 0 })),
      proxyText: proxyText(), maxPerProxy: MAX_PER_PROXY, storage: D.stats(),
    }));
  }

  if (url.pathname === '/api/proxies' && req.method === 'POST') {
    const b = await body(req);
    D.settings.set('proxyText', String(b.text || ''));
    fs.writeFileSync(PROXY_FILE, String(b.text || ''));   // kept so it stays eyeballable
    const list = loadProxies();
    note(`proxy list updated: ${list.length} usable, covers ${list.length * MAX_PER_PROXY} accounts`);
    return send(200, 'application/json', JSON.stringify({ ok: true, count: list.length }));
  }

  if (url.pathname === '/api/account' && req.method === 'POST') {
    const b = await body(req);
    if (b.delete) D.accounts.remove(b.id);
    else D.accounts.upsert(b);
    return send(200, 'application/json', JSON.stringify({ ok: true, accounts: D.accounts.withSnapshots() }));
  }

  if (url.pathname === '/api/poll' && req.method === 'POST') {
    const b = await body(req);
    if (b.id) {
      const acc = D.accounts.get(b.id);
      if (acc) { note(`polling ${acc.label} on demand`); D.snapshots.add(acc.id, await pollAccount(acc)); }
      return send(200, 'application/json', JSON.stringify({ ok: true, accounts: D.accounts.withSnapshots() }));
    }
    pollCycle();
    return send(200, 'application/json', JSON.stringify({ ok: true, started: true }));
  }

  // ---- uptime ----
  if (url.pathname === '/api/uptime') {
    const hours = Math.min(720, Math.max(1, Number(url.searchParams.get('hours')) || 12));
    const since = Date.now() - hours * 3600000;
    const rows = D.uptime.series(since, url.searchParams.get('probe') || null);

    // Bucket into fixed slots so a gap (bot process dead, nothing written) shows
    // up as a real hole rather than the chart joining across it.
    const bucketMs = Math.max(UPTIME_MS, Math.round((hours * 3600000) / 720));
    const buckets = new Map();
    for (const r of rows) {
      const key = r.probe + '|' + Math.floor(r.at / bucketMs);
      const cur = buckets.get(key) || { probe: r.probe, t: Math.floor(r.at / bucketMs) * bucketMs,
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

    // The very first sample ever recorded. Before it, an empty slot means the
    // Director was not watching yet — which is not the same as the bot being
    // down, and must not be painted as an outage.
    return send(200, 'application/json', JSON.stringify({
      hours, bucketMs, sampleMs: UPTIME_MS, slots, now: Date.now(),
      firstSample: firstEver,
      probes, summary, configured: probeList(),
    }));
  }

  if (url.pathname === '/api/probes' && req.method === 'POST') {
    const b = await body(req);
    if (Array.isArray(b.probes)) {
      D.settings.set('probes', b.probes.filter((p) => p && p.probe && p.url));
      note(`uptime probes updated: ${probeList().map((p) => p.probe).join(', ')}`);
    }
    return send(200, 'application/json', JSON.stringify({ ok: true, probes: probeList() }));
  }

  // ---- per-account history for the fleet charts ----
  if (url.pathname === '/api/history') {
    const id = url.searchParams.get('id');
    const field = url.searchParams.get('field') || 'prestige';
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7));
    return send(200, 'application/json', JSON.stringify({
      id, field, points: D.snapshots.series(id, Date.now() - days * 86400000, field),
    }));
  }

  send(404, 'text/plain', 'not found');
}).listen(PORT, AUTH.bindHost(), () => {
  const st = D.stats();
  note(`Director on http://localhost:${PORT}  (${st.accounts} account(s), ${GAP_MS / 1000}s between polls)`);
  note(`storage: ${path.basename(D.FILE)} — ${(st.sizeBytes / 1024).toFixed(0)} KB, ${st.snapshots} snapshot(s), ${st.uptime} uptime sample(s)`);
  // Give any console that is starting alongside the Director time to come up
  // and claim its account before the first poll goes looking for logins.
  setTimeout(pollCycle, 30000);
  setInterval(pollCycle, Math.max(CYCLE_MIN_MS, D.accounts.all().length * GAP_MS + 60000));
  sampleUptime();
  setInterval(sampleUptime, UPTIME_MS);
  setInterval(() => { D.uptime.prune(30); D.snapshots.prune(90); }, 6 * 3600000);
  // Keep the write-ahead log from growing all night.
  setInterval(() => {
    const before = D.stats().walBytes;
    D.checkpoint('PASSIVE');
    const after = D.stats().walBytes;
    if (before > 8e6) note(`wal checkpoint: ${(before / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(1)}MB`);
  }, 5 * 60000);
});
