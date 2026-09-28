'use strict';
// otto-mcp.js — an MCP server that gives Claude its own terminal into the fleet
// (2026-09-28).
//
// Claude Code used to drive the bots with curl against ~28 consoles on different
// ports, grep 30 MB console-<id>.log files and poll with sleeps — always a step
// behind and heavy on tokens. This server speaks the Model Context Protocol over
// stdio (newline-delimited JSON-RPC 2.0) and turns that into a handful of tools
// whose answers are short summaries: the fleet in one call, one account's state,
// a filtered log, the events feed with a wait that returns the moment something
// matches, and the few actions a Claude may take.
//
// It NEVER logs in to the game. It only talks HTTP to the consoles already
// running on this machine, with Claude's own key (claude-guard.js). The mode
// comes from OTTO_CLAUDE_MODE: `interactive` (default; the user is present) or
// `auto` (a Claude woken with nobody watching — only /api/claude/act, within the
// account's permissions). Registered for Claude Code in .mcp.json.
//
// stdout is the protocol; everything else goes to stderr.
const http = require('http');
const fs = require('fs');
const path = require('path');

const MODE = process.env.OTTO_CLAUDE_MODE === 'auto' ? 'auto' : 'interactive';
const MAX_CHARS = Number(process.env.OTTO_MCP_MAX_CHARS || 6000);
const HTTP_TIMEOUT_MS = Number(process.env.OTTO_MCP_TIMEOUT_MS || 8000);
const VERSION = '1.0.0';

const log = (m) => { try { process.stderr.write(`[otto-mcp] ${m}\n`); } catch { /* nowhere to say it */ } };

// ------------------------------------------------------------------ the fleet
// Read from the database each time (it is small), so an account added or a
// console moved to another port is seen without restarting this server.
function D() { return require('./db'); }

function aliases() {
  try {
    const m = JSON.parse(fs.readFileSync(process.env.OTTO_PRIVACY_MAP || path.join(__dirname, 'privacy.local.json'), 'utf8'));
    const out = {};
    for (const [alias, v] of Object.entries(m.aliases || {})) if (v && v.id) out[v.id] = alias;
    return out;
  } catch { return {}; }
}

// [{ id, label, alias, server, enabled, url, port }] — the url found the way
// botctl.js finds a console: its own record first, then the probe list entry
// carrying the account id.
function accounts() {
  const B = require('./botctl');
  const al = aliases();
  const out = [];
  for (const o of D().orgs.all()) {
    const org = D().org(o.id);
    const bots = B.bots(org);
    const probes = B.probeList(org);
    for (const a of org.accounts.all()) {
      const rec = bots[a.id];
      const pr = probes.find((p) => p.accountId === a.id);
      const url = String((rec && rec.url) || (pr && pr.url) || '').replace(/\/$/, '') || null;
      let port = null;
      try { port = url ? Number(new URL(url).port) || null : null; } catch { /* keep null */ }
      out.push({ id: a.id, label: a.label || a.id, alias: al[a.id] || null, server: a.server || null,
        enabled: a.enabled !== false, url: url ? url.replace('://localhost', '://127.0.0.1') : null, port });
    }
  }
  return out;
}

// An account by id (a2), alias (Lord02) or label, case-insensitive; a unique
// label prefix also does. -> account | throws with the candidates.
// A Claude woken for one account (the waker sets OTTO_WAKE_ACCOUNT) may leave it out.
function resolveAccount(q, list = accounts()) {
  const s = String(q ?? process.env.OTTO_WAKE_ACCOUNT ?? '').trim().toLowerCase();
  if (!s) throw new Error('name an account: its id (a2), alias (Lord02) or name');
  const exact = list.filter((a) => a.id.toLowerCase() === s || (a.alias || '').toLowerCase() === s || String(a.label).toLowerCase() === s);
  if (exact.length === 1) return exact[0];
  const pre = list.filter((a) => String(a.label).toLowerCase().startsWith(s));
  if (pre.length === 1) return pre[0];
  const hits = exact.length ? exact : pre;
  if (hits.length > 1) throw new Error(`"${q}" matches ${hits.map((a) => a.id + ' ' + a.label).join(', ')} — be more exact`);
  throw new Error(`no account "${q}" — try fleet() for the list`);
}

// ------------------------------------------------------------------ http
function token() {
  const CG = require('./claude-guard');
  return MODE === 'auto' ? CG.claudeAutoToken() : CG.claudeToken();
}
function internal() {
  try { return require('./auth').internalToken(); } catch { return null; }
}

// -> { status, json, text } ; never throws for an HTTP answer, only for no answer
function call(base, method, p, bodyObj = null, { timeoutMs = HTTP_TIMEOUT_MS, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    if (!base) return reject(new Error('no console is on record for this account'));
    const u = new URL(base + p);
    const data = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = { 'x-otto-claude': token(), Accept: 'application/json' };
    // The internal token only opens /api/session and a few other reads — it lets
    // this server see a console started before Claude's key existed. Never on a
    // POST: one internal POST route relogs the console.
    if (method === 'GET') { const t = internal(); if (t) headers['x-otto-internal'] = t; }
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, timeout: timeoutMs }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text: b });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`no answer from ${base} in ${Math.round(timeoutMs / 1000)}s`)));
    req.on('error', (e) => reject(e.code === 'ECONNREFUSED' ? new Error(`the console at ${base} is not running`) : e));
    if (signal) signal.onabort = () => req.destroy(new Error('aborted'));
    if (data) req.write(data);
    req.end();
  });
}

// A JSON answer or a clear error. A console started before Claude's key existed
// answers "not signed in" — that is a restart, not a bug.
async function api(acc, method, p, bodyObj, opts) {
  const r = await call(acc.url, method, p, bodyObj, opts);
  if (r.status === 401 && r.json && r.json.login) {
    throw new Error(`${acc.id}'s console does not know Claude's key yet — it was started before it existed and needs a restart (ask the user)`);
  }
  if (!r.json) throw new Error(`${acc.id}: ${r.status} ${String(r.text).slice(0, 160)}`);
  if (r.json.claude && r.json.ok === false) throw new Error(r.json.error);
  return r.json;
}

// ------------------------------------------------------------------ formatting
function fmt(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return n === null || n === undefined ? '-' : String(n);
  const a = Math.abs(x);
  if (a >= 1e12) return (x / 1e12).toFixed(1) + 't';
  if (a >= 1e9) return (x / 1e9).toFixed(1) + 'b';
  if (a >= 1e6) return (x / 1e6).toFixed(1) + 'm';
  if (a >= 1e3) return (x / 1e3).toFixed(0) + 'k';
  return String(Math.round(x));
}
const hms = (t) => { const d = new Date(Number(t)); return Number.isFinite(d.getTime()) ? d.toTimeString().slice(0, 8) : '-'; };
function inWords(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '?';
  const s = Math.round(Number(ms) / 1000);
  if (s < 0) return `${-s}s ago`;
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
// "15m" | "2h" | "30s" | "1d" | a number of minutes -> ms
function sinceMs(v, dflt = 15 * 60000) {
  if (v === undefined || v === null || v === '') return dflt;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(String(v).trim());
  if (!m) return dflt;
  return Number(m[1]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[(m[2] || 'm').toLowerCase()]);
}
function clip(text, max = MAX_CHARS) {
  const s = String(text);
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… (truncated ${s.length - max} more chars — narrow it: city, grep, since, limit)`;
}

// ------------------------------------------------------------------ cities
async function sessionOf(acc) { return api(acc, 'GET', '/api/session'); }
// A city by id or by name (unique prefix too) -> { id, name }
function resolveCity(sess, city) {
  const list = (sess && sess.cities) || [];
  if (city === undefined || city === null || city === '') throw new Error('name a city (id or name): ' + list.map((c) => c.name).join(', '));
  const s = String(city).trim().toLowerCase();
  const hit = list.find((c) => String(c.id) === s) || list.find((c) => String(c.name).toLowerCase() === s)
    || (list.filter((c) => String(c.name).toLowerCase().startsWith(s)).length === 1
      ? list.find((c) => String(c.name).toLowerCase().startsWith(s)) : null);
  if (!hit) throw new Error(`no city "${city}" — this account has ${list.map((c) => `${c.name} (${c.id})`).join(', ') || 'no cities (offline?)'}`);
  return { id: hit.id, name: hit.name };
}

// ------------------------------------------------------------------ tools
const cursors = new Map();          // account id -> { seq, boot }: what events/wait has already shown

function attackLine(ua) {
  if (!ua || !ua.on) return null;
  return (ua.cities || []).map((c) => `${c.name}: ${c.inbound || 0} inbound`
    + (c.firstLandsAt ? `, first in ${inWords(c.firstLandsAt - (ua.at || Date.now()))}` : '')
    + (c.junk ? ` (+${c.junk} junk)` : '')
    + (c.lastWaveAt ? `, last wave ${inWords(c.lastWaveAt - (ua.at || Date.now()))}` : '')
    + (c.loyalty !== null && c.loyalty !== undefined ? `, loyalty ${c.loyalty}` : '')).join('; ');
}

async function toolFleet() {
  const list = accounts();
  const rows = await Promise.all(list.map(async (a) => {
    const name = `${a.id.padEnd(4)} ${String(a.label).slice(0, 16).padEnd(16)}${a.alias ? ' ' + a.alias.padEnd(7) : ''} ${a.port ? ':' + a.port : '     '}`;
    if (!a.url) return `${name} no console${a.enabled ? '' : ' (switched off)'}`;
    try {
      const [s, runs] = await Promise.all([
        api(a, 'GET', '/api/session', null, { timeoutMs: 4000 }),
        api(a, 'GET', '/api/script/runs', null, { timeoutMs: 4000 }).catch(() => null),
      ]);
      const bits = [s.connected ? 'up' : `${s.state || 'down'}${s.reason ? ' (' + String(s.reason).slice(0, 60) + ')' : ''}`];
      if (s.paused) bits.push('PAUSED');
      if (s.protection) bits.push(`${s.protection.label || s.protection.kind}${s.protection.left ? ' ' + s.protection.left : ''}`);
      else if (s.holiday) bits.push(`holiday ${s.holiday.text || ''}`.trim());
      if (s.kick) bits.push(`kick-hold until ${hms(s.kick.until)}`);
      if (s.maintenance && s.maintenance.phase && s.maintenance.phase !== 'none' && s.maintenance.phase !== 'idle') bits.push(`maint:${s.maintenance.phase}`);
      if (runs) bits.push(`scripts ${runs.runs.length}`);
      const atk = attackLine(s.underAttack);
      if (atk) bits.push(`ATTACK ${atk}`);
      return `${name} ${bits.join(' | ')}`;
    } catch (e) { return `${name} ${e.message}`; }
  }));
  const up = rows.filter((r) => / up( |$)/.test(r)).length;
  return `${list.length} accounts, ${up} up (mode ${MODE})\n${rows.join('\n')}`;
}

async function toolState(args) {
  const acc = resolveAccount(args.account);
  const s = await sessionOf(acc);
  const snap = s.snapshot || {};
  const out = [];
  out.push(`${acc.id} ${acc.label}${acc.alias ? ' (' + acc.alias + ')' : ''} ${acc.server || s.server || ''} :${acc.port} — ${s.connected ? 'connected' : s.state}`
    + `${s.reason ? ' (' + s.reason + ')' : ''}${s.paused ? ' — engine PAUSED' : ''}`);
  const pr = s.protection ? `${s.protection.label || s.protection.kind} ${s.protection.left || ''}`.trim() : (s.holiday ? 'holiday' : 'none');
  out.push(`lord ${s.lord || snap.lord || '?'} · prestige ${fmt(s.prestige ?? snap.prestige)} · rank ${s.rank ?? snap.rank ?? '?'} · coins ${s.coins ?? snap.coins ?? '?'} · protection ${pr}`
    + ` · maint ${(s.maintenance && s.maintenance.phase) || '-'}`);
  const atk = attackLine(s.underAttack);
  out.push(atk ? `UNDER ATTACK: ${atk}` : 'no real attack inbound');
  const t = snap.totals || {};
  out.push(`totals: food ${fmt(t.food)} wood ${fmt(t.wood)} stone ${fmt(t.stone)} iron ${fmt(t.iron)} gold ${fmt(t.gold)} · troops ${fmt(snap.troops)} (marching ${fmt(snap.marchingTroops)}) · heroes ${snap.heroes ?? '?'} · captives ${(snap.captives || []).length}`);

  if (args.city !== undefined && args.city !== null && args.city !== '') {
    const c = resolveCity(s, args.city);
    const [city, rep] = await Promise.all([
      api(acc, 'GET', `/api/city?id=${encodeURIComponent(c.id)}`),
      api(acc, 'GET', `/api/engine/report?city=${encodeURIComponent(c.id)}`).catch(() => null),
    ]);
    const r = city.resources || {}, gen = city.general || {};
    out.push(`\n${city.name} (${city.id}) ${city.x},${city.y} — gate ${gen.gates || '?'} · loyalty ${gen.loyalty ?? '?'} · grievance ${gen.complaint ?? '?'} · tax ${city.tax ?? '?'}% · ${gen.status || ''}`);
    out.push(`res: food ${fmt(r.food)} wood ${fmt(r.wood)} stone ${fmt(r.stone)} iron ${fmt(r.iron)} gold ${fmt(r.gold)} · pop ${fmt(r.population)}/${fmt(r.maxPopulation)} idle ${fmt(r.idle)}`);
    const troops = (city.troops || []).filter((x) => x.count > 0).map((x) => `${x.key} ${fmt(x.count)}`);
    out.push(`troops: ${troops.join(', ') || 'none'}`);
    const forts = Object.entries(city.fortifications || {}).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${fmt(v)}`);
    if (forts.length) out.push(`walls: ${forts.join(', ')}`);
    const heroes = (city.heroes || []).map((h) => `${h.name} L${h.level} ${['idle', 'mayor', 'defending', 'marching', 'prisoner'][Number(h.status)] || 's' + h.status}${h.levelsReady ? ' +' + h.levelsReady + 'lv' : ''}`);
    out.push(`heroes (${heroes.length}): ${heroes.join(', ') || 'none'}`);
    const cons = (city.construction || []).map((b) => `${b.name} ${b.kind === 'demolish' ? 'v' : '^'}L${b.to}${b.secsLeft ? ' ' + inWords(b.secsLeft * 1000) : ' queued'}`);
    if (cons.length) out.push(`building: ${cons.join(', ')}`);
    const inc = city.incoming || {};
    const incRes = Object.entries(inc).filter(([, v]) => v && v.total > 0).map(([k, v]) => `${k} ${fmt(v.total)}`);
    if (incRes.length) out.push(`resources inbound: ${incRes.join(', ')}`);
    if (rep && rep.report) {
      const txt = typeof rep.report === 'string' ? rep.report : JSON.stringify(rep.report);
      out.push(`engine: ${txt.slice(0, 700)}${txt.length > 700 ? '…' : ''}`);
    }
  } else {
    out.push('\ncities: name(id) xy troops food/gold heroes gate incoming script');
    const meta = new Map((s.cities || []).map((c) => [String(c.id), c]));
    for (const c of snap.cityList || []) {
      const m = meta.get(String(c.id)) || {};
      out.push(`  ${c.name}(${c.id}) ${c.x},${c.y} t${fmt(c.troops)} f${fmt(c.food)} g${fmt(c.gold)} h${c.heroes}${c.captives ? ' cap' + c.captives : ''}`
        + ` gate:${m.gateOpen ? 'OPEN' : 'closed'}${m.gate && m.gate !== 'auto' ? '(' + m.gate + ')' : ''}${m.incoming ? ' INC' + m.incoming : ''}${m.script ? ' script' : ''}`);
    }
  }
  try {
    const m = await api(acc, 'GET', '/api/marches');
    const now = m.serverNow || Date.now();
    const outg = (m.outgoing || []).slice(0, 15).map((a) => `  ${a.mission} ${a.from}->${a.to} ${a.direction} ${fmt(a.troopTotal)}${a.hero ? ' ' + a.hero : ''} eta ${inWords(a.reachTime - now)}`);
    const inc = (m.incoming || []).slice(0, 15).map((a) => `  ${a.hostile ? 'HOSTILE ' : ''}${a.mission} ${a.king || a.from || '?'} -> ${a.myCity || a.to} ${a.scouted ? fmt(a.troopTotal) : '?'} troops in ${inWords(a.reachTime - now)}`);
    out.push(`marches out: ${m.count}${outg.length ? '\n' + outg.join('\n') : ''}`);
    out.push(`inbound: ${m.incomingCount}${inc.length ? '\n' + inc.join('\n') : ''}`);
  } catch (e) { out.push(`marches: ${e.message}`); }
  return out.join('\n');
}

// The tail of a console's own log file, without reading 30 MB: the last chunk only.
function tailFile(file, { grep = null, limit = 80, bytes = 512 * 1024 } = {}) {
  const st = fs.statSync(file);
  const len = Math.min(bytes, st.size);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    let lines = buf.toString('utf8').split(/\r?\n/).slice(len < st.size ? 1 : 0).filter((l) => l.trim());
    if (grep) lines = lines.filter((l) => grep.test(l));
    return lines.slice(-limit);
  } finally { fs.closeSync(fd); }
}

const regexOf = (g) => { if (!g) return null; try { return new RegExp(g, 'i'); } catch { return new RegExp(String(g).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } };

async function toolLog(args) {
  const acc = resolveAccount(args.account);
  const kind = ['activity', 'engine', 'reports', 'debug'].includes(args.kind) ? args.kind : 'activity';
  const limit = Math.max(1, Math.min(400, Number(args.limit) || 80));
  const cutoff = Date.now() - sinceMs(args.since);
  const re = regexOf(args.grep);
  // a plain word is filtered by the console itself; a pattern here
  const plain = args.grep && !/[\\^$.|?*+()[\]{}]/.test(args.grep);
  let city = args.city || null;
  try {
    if (city) { const s = await sessionOf(acc); city = resolveCity(s, city).name; }
    const qs = new URLSearchParams({ kind });
    if (city) qs.set('city', city);
    if (plain) qs.set('q', args.grep);
    const r = await api(acc, 'GET', '/api/log?' + qs.toString());
    let lines = (r.lines || []).filter((l) => Number(l.t) >= cutoff);
    if (re && !plain) lines = lines.filter((l) => re.test(String(l.m)));
    const shown = lines.slice(-limit);
    const head = `${acc.id} ${kind} log, last ${args.since || '15m'}${city ? ' in ' + city : ''}${args.grep ? ' matching ' + args.grep : ''}: ${shown.length} of ${lines.length} line(s)`;
    return clip([head, ...shown.map((l) => `${hms(l.t)} ${l.city && !String(l.m).startsWith('[') ? '[' + l.city + '] ' : ''}${l.m}`)].join('\n'));
  } catch (e) {
    // The console is down (or predates the key): its own output file, the tail only.
    const dir = process.env.BOT_LOG_DIR || __dirname;
    const file = path.join(dir, `console-${acc.id}.log`);
    if (!fs.existsSync(file)) throw e;
    const lines = tailFile(file, { grep: re, limit });
    return clip([`${acc.id}: ${e.message} — the tail of console-${acc.id}.log instead (${lines.length} line(s)):`, ...lines].join('\n'));
  }
}

function eventLine(acc, e) {
  const who = `${hms(e.t)} ${acc.id} #${e.seq} ${e.type}`;
  switch (e.type) {
    case 'attack_incoming': case 'attack_junk': case 'scout_incoming': case 'army_incoming':
      return `${who} ${e.city}: ${e.king || e.from || '?'}${e.alliance ? ' (' + e.alliance + ')' : ''} ${e.troops === null ? '? troops' : fmt(e.troops) + ' troops'} lands in ${e.inSec === null ? '?' : inWords(e.inSec * 1000)}`;
    case 'attack_landed': case 'junk_landed': case 'attack_turned_back': case 'scout_landed':
      return `${who} ${e.city}: ${e.king || e.from || '?'} ${e.troops === null ? '?' : fmt(e.troops)} troops`;
    case 'march_started': case 'march_arrived': case 'march_returned': case 'march_gone':
      return `${who} ${e.mission} ${e.from || '?'}->${e.to || '?'} ${fmt(e.troops)}${e.hero ? ' ' + e.hero : ''}`;
    case 'script_started':
      return `${who} ${e.city || e.cityId} run ${e.runId} (${e.source || '?'})${e.dryRun ? ' dry' : ''}`;
    case 'script_finished': case 'script_error':
      return `${who} ${e.city || e.cityId} run ${e.runId} ${e.stopped ? 'stopped' : e.error ? 'error: ' + e.error : 'done'} n=${e.n} ${e.secs}s${e.failedLines ? ` ${e.failedLines} FAILED line(s)` : ''}${e.tail && e.tail.length ? ' | ' + e.tail.join(' | ') : ''}`;
    case 'gate_changed':
      return `${who} ${e.city}: ${e.open ? 'OPEN' : 'closed'}${e.mode ? ' (' + e.mode + ')' : ''} by ${e.by}`;
    case 'disconnected':
      return `${who} by ${e.by}${e.reason ? ': ' + e.reason : ''}${e.kickHold ? ' (kick hold)' : ''}`;
    default: {
      const rest = { ...e }; for (const k of ['seq', 't', 'type', 'account']) delete rest[k];
      return `${who} ${JSON.stringify(rest).slice(0, 200)}`;
    }
  }
}

function targetsOf(q) {
  const list = accounts();
  if (q === undefined || q === null || String(q).toLowerCase() === 'all' || q === '') return list.filter((a) => a.url);
  return [resolveAccount(q, list)];
}

// One feed read for one account, keeping its cursor. A new boot starts it over.
async function readFeed(acc, { since, types, waitS = 0, limit = 100, signal } = {}) {
  const cur = cursors.get(acc.id);
  const from = since !== undefined && since !== null ? Number(since) : cur ? cur.seq : null;
  const qs = new URLSearchParams({ since: String(from ?? 0), limit: String(limit) });
  if (types) qs.set('types', Array.isArray(types) ? types.join(',') : String(types));
  if (waitS) qs.set('wait', String(waitS));
  const r = await api(acc, 'GET', '/api/events?' + qs.toString(), null, { timeoutMs: (waitS + 10) * 1000, signal });
  let events = r.events || [];
  if (cur && cur.boot && r.boot !== cur.boot && (since === undefined || since === null)) {
    // the console restarted: its numbers began again, so everything it has is new
    const again = await api(acc, 'GET', `/api/events?since=0&limit=${limit}${types ? '&types=' + encodeURIComponent(qs.get('types')) : ''}`);
    events = again.events || [];
  }
  // a first look with no cursor shows only the most recent few
  if (from === null) events = events.slice(-20);
  cursors.set(acc.id, { seq: r.seq, boot: r.boot });
  return { events, seq: r.seq, boot: r.boot };
}

async function toolEvents(args) {
  const targets = targetsOf(args.account);
  const out = [];
  const errs = [];
  await Promise.all(targets.map(async (acc) => {
    try {
      const r = await readFeed(acc, { since: targets.length === 1 ? args.since_seq : undefined, types: args.types, limit: Number(args.limit) || 100 });
      for (const e of r.events) out.push({ acc, e });
    } catch (e) { errs.push(`${acc.id}: ${e.message}`); }
  }));
  out.sort((x, y) => x.e.t - y.e.t);
  const lines = out.map(({ acc, e }) => eventLine(acc, e));
  const cur = targets.map((a) => `${a.id}:${(cursors.get(a.id) || {}).seq ?? '?'}`).join(' ');
  return clip([`${lines.length} event(s)${lines.length ? '' : ' since the last look'}`, ...lines,
    ...(errs.length ? [`unreachable: ${errs.join('; ')}`] : []), `cursor ${cur}`].join('\n'));
}

// Waits for a matching event on one account or all of them; returns at the
// first match, or when timeout_s runs out. Only events newer than what this
// server has already shown count.
async function toolWait(args) {
  const targets = targetsOf(args.account);
  const timeoutS = Math.max(1, Math.min(600, Number(args.timeout_s) || 300));
  const deadline = Date.now() + timeoutS * 1000;
  const re = regexOf(args.pattern);
  const types = args.types || null;
  const ctl = { done: false, abort: [] };
  // start each cursor at "now" if there is none yet, so old news does not match
  await Promise.all(targets.map(async (acc) => {
    if (cursors.has(acc.id)) return;
    try { const r = await api(acc, 'GET', '/api/events?since=0&limit=1', null, { timeoutMs: 4000 }); cursors.set(acc.id, { seq: r.seq, boot: r.boot }); } catch { /* polled below */ }
  }));
  const found = await new Promise((resolve) => {
    let pending = targets.length;
    if (!pending) return resolve(null);
    for (const acc of targets) {
      (async () => {
        while (!ctl.done && Date.now() < deadline) {
          const waitS = Math.max(1, Math.min(55, Math.floor((deadline - Date.now()) / 1000)));
          const signal = {};
          ctl.abort.push(signal);
          try {
            const r = await readFeed(acc, { types, waitS, signal });
            const hit = r.events.filter((e) => !re || re.test(JSON.stringify(e)));
            if (hit.length && !ctl.done) { ctl.done = true; return resolve({ acc, events: hit }); }
          } catch (e) {
            if (ctl.done) break;
            await new Promise((r) => setTimeout(r, 3000));     // a console that is down: look again shortly
          }
        }
        if (--pending === 0) resolve(null);
      })();
    }
  });
  ctl.done = true;
  for (const s of ctl.abort) { try { if (s.onabort) s.onabort(); } catch { /* already over */ } }
  if (!found) return `nothing matched in ${timeoutS}s${args.pattern ? ' (pattern ' + args.pattern + ')' : ''}${types ? ' (types ' + types + ')' : ''} on ${targets.length} account(s)`;
  return clip([`matched on ${found.acc.id}:`, ...found.events.map((e) => eventLine(found.acc, e))].join('\n'));
}

async function toolCmd(args) {
  const acc = resolveAccount(args.account);
  if (MODE === 'auto') throw new Error('auto mode: use act(), which checks this account\'s permissions');
  const c = resolveCity(await sessionOf(acc), args.city);
  const r = await api(acc, 'POST', '/api/script/inline', { text: String(args.text || ''), city: c.id });
  const res = r.result === null || r.result === undefined ? '' : `\nresult: ${JSON.stringify(r.result).slice(0, 1500)}`;
  return clip(`${acc.id} ${c.name}: ${r.ok ? 'ok' : 'FAILED: ' + r.error}\n${(r.lines || []).join('\n')}${res}`);
}

async function toolScript(args) {
  const acc = resolveAccount(args.account);
  if (MODE === 'auto') throw new Error('auto mode: scripts cannot be started — use act()');
  const c = resolveCity(await sessionOf(acc), args.city);
  const runId = `claude-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const r = await api(acc, 'POST', '/api/script', { src: String(args.text || ''), city: c.id, runId, dryRun: !!args.dry_run });
  const tail = (r.log || []).slice(-15).join('\n');
  if (!r.ok) return clip(`${acc.id} ${c.name}: NOT started\n${tail}`);
  if (r.started) return clip(`${acc.id} ${c.name}: started (city ${c.id}). Follow it with wait(account, types="script_finished,script_error") or script_runs.\n${tail}`);
  return clip(`${acc.id} ${c.name}: ${args.dry_run ? 'dry run' : 'run'} over${r.stopped ? ' (stopped)' : ''}\n${tail}`);
}

async function toolScriptStop(args) {
  const acc = resolveAccount(args.account);
  if (MODE === 'auto') throw new Error('auto mode: scripts cannot be stopped from here');
  const c = resolveCity(await sessionOf(acc), args.city);
  const r = await api(acc, 'POST', '/api/script/stop', { city: String(c.id) });
  return `${acc.id} ${c.name}: ${r.ok ? 'stop sent — it ends after the line it is on' : r.error}`;
}

async function toolScriptRuns(args) {
  const acc = resolveAccount(args.account);
  let s = null, cityQ = '';
  if (args.city !== undefined && args.city !== null && args.city !== '') {
    s = await sessionOf(acc);
    cityQ = '?city=' + encodeURIComponent(resolveCity(s, args.city).id);
  }
  const r = await api(acc, 'GET', '/api/script/runs' + cityQ);
  const names = s ? new Map((s.cities || []).map((c) => [String(c.id), c.name])) : new Map();
  const out = [`${acc.id}: ${r.runs.length} running`];
  for (const x of r.runs) out.push(`  ${names.get(String(x.city)) || x.city} ${x.runId || ''} since ${hms(x.startedAt)} (${x.source || '?'})${x.paused ? ' PAUSED at line ' + x.paused.line : ''}${x.stopping ? ' stopping' : ''}`);
  if (r.ended) out.push(`last run ended ${hms(r.ended.at)}: ${r.ended.stopped ? 'stopped' : r.ended.error ? 'error ' + r.ended.error : 'done'} n=${r.ended.n}`);
  if (r.lines) out.push(`output (last ${Math.min(30, r.lines.length)} of ${r.lines.length}${r.dropped ? ', ' + r.dropped + ' dropped' : ''}):`, ...r.lines.slice(-30));
  return clip(out.join('\n'));
}

async function toolAct(args) {
  const acc = resolveAccount(args.account);
  const c = resolveCity(await sessionOf(acc), args.city);
  const action = String(args.action || (args.command ? 'command' : '')).toLowerCase();
  const b = action === 'gate' ? { city: c.id, action: 'gate', mode: String(args.mode || '') } : { city: c.id, command: String(args.command || '') };
  const r = await call(acc.url, 'POST', '/api/claude/act', b);
  if (r.status === 401 && r.json && r.json.login) throw new Error(`${acc.id}'s console needs a restart before it knows Claude's key (ask the user)`);
  const j = r.json || { ok: false, error: `${r.status} ${String(r.text).slice(0, 160)}` };
  return clip(`${acc.id} ${c.name} ${action === 'gate' ? 'gate ' + b.mode : b.command}: ${j.ok ? 'ok' : 'REFUSED/FAILED: ' + j.error}`
    + `${j.perm ? ' [perm ' + j.perm + ']' : ''}${(j.lines || []).length ? '\n' + j.lines.join('\n') : ''}`);
}

const ACCOUNT = { type: 'string', description: 'account id (a2), alias (Lord02) or name' };
const CITY = { type: ['string', 'number'], description: 'city id or name' };
const TOOLS = [
  { name: 'fleet', fn: toolFleet, description: 'Every account in one call: id, name, port, connected, protection/holiday, kick hold, maintenance, running scripts, and any REAL attack inbound.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'state', fn: toolState, description: 'One account summarised: header, totals, cities (or one city in depth: resources, troops, walls, heroes, building, loyalty, gate, engine report), marches out and inbound.',
    inputSchema: { type: 'object', properties: { account: ACCOUNT, city: CITY }, required: ['account'] } },
  { name: 'log', fn: toolLog, description: 'A console log filtered on the console: kind activity|engine|reports|debug, since (15m, 2h, 30s), grep (word or regex), city, limit. Falls back to the tail of console-<id>.log when the console is down.',
    inputSchema: { type: 'object', properties: { account: ACCOUNT, kind: { type: 'string', enum: ['activity', 'engine', 'reports', 'debug'] }, since: { type: 'string' }, grep: { type: 'string' }, city: CITY, limit: { type: 'number' } }, required: ['account'] } },
  { name: 'events', fn: toolEvents, description: 'New events from the consoles\' feed since the last look (or since_seq for one account): connected, disconnected, kicked, attack_incoming/landed/turned_back, attack_junk, scout_incoming, march_started/arrived/returned, script_started/finished/error, gate_changed, maintenance.',
    inputSchema: { type: 'object', properties: { account: { type: 'string', description: 'an account, or "all" (default)' }, since_seq: { type: 'number' }, types: { type: 'string', description: 'comma list of event types' }, limit: { type: 'number' } } } },
  { name: 'wait', fn: toolWait, description: 'Block until an event matching types and/or pattern (regex over the event JSON) arrives on the account (or "all"), or timeout_s (max 600) passes. Returns at the first match.',
    inputSchema: { type: 'object', properties: { account: { type: 'string', description: 'an account, or "all" (default)' }, pattern: { type: 'string' }, types: { type: 'string' }, timeout_s: { type: 'number' } } } },
  { name: 'cmd', fn: toolCmd, description: 'Run ONE in-line script command in a city (as \\who Bob in the chat box) and return its output. Interactive mode only; release/fire/abandon/logout/holiday exit and the like are refused.',
    inputSchema: { type: 'object', properties: { account: ACCOUNT, city: CITY, text: { type: 'string' } }, required: ['account', 'city', 'text'] } },
  { name: 'script', fn: toolScript, description: 'Start a script in a city (one run per city). Returns at once; follow with wait(types="script_finished,script_error") or script_runs. dry_run for a dry run. Interactive only.',
    inputSchema: { type: 'object', properties: { account: ACCOUNT, city: CITY, text: { type: 'string' }, dry_run: { type: 'boolean' } }, required: ['account', 'city', 'text'] } },
  { name: 'script_stop', fn: toolScriptStop, description: 'Stop the script running in a city (after its current line). Interactive only.',
    inputSchema: { type: 'object', properties: { account: ACCOUNT, city: CITY }, required: ['account', 'city'] } },
  { name: 'script_runs', fn: toolScriptRuns, description: 'Which cities have a script running; with city, that run\'s (or its last run\'s) last 30 output lines.',
    inputSchema: { type: 'object', properties: { account: ACCOUNT, city: CITY }, required: ['account'] } },
  { name: 'act', fn: toolAct, description: 'A permission-gated action: action "gate" with mode open|closed|auto, or a single command line (recall, reinforce, evacuatetown, dumptroop, teleport, truce, dreamtruce, holiday <days> confirm). In auto mode only what this account\'s Claude permissions allow.',
    inputSchema: { type: 'object', properties: { account: ACCOUNT, city: CITY, action: { type: 'string', enum: ['gate', 'command'] }, mode: { type: 'string', enum: ['open', 'closed', 'auto'] }, command: { type: 'string' } }, required: ['account', 'city'] } },
];

// ------------------------------------------------------------------ protocol
function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(msg) {
  const { id, method, params } = msg || {};
  const reply = (result) => { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, result }); };
  const fail = (code, message) => { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code, message } }); };
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'otto', version: VERSION },
        instructions: `OTTObot fleet tools (mode ${MODE}). Start with fleet(); state/log/events to look; wait to block on events instead of sleeping. `
          + 'Never ask a console to log in; release, fire, abandon, logout and ending a holiday are refused.',
      });
    case 'notifications/initialized': case 'notifications/cancelled': case 'initialized':
      return undefined;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const t = TOOLS.find((x) => x.name === (params && params.name));
      if (!t) return fail(-32602, `unknown tool ${params && params.name}`);
      try {
        const text = await t.fn((params && params.arguments) || {});
        return reply({ content: [{ type: 'text', text: clip(text) }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `error: ${e.message}` }], isError: true });
      }
    }
    default:
      if (method && method.startsWith('notifications/')) return undefined;
      return fail(-32601, `method not found: ${method}`);
  }
}

function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
      // each request on its own: a wait() must not hold up a fleet() behind it
      Promise.resolve(handle(msg)).catch((e) => log('handler: ' + e.stack));
    }
  });
  process.stdin.on('end', () => process.exit(0));
  log(`ready (mode ${MODE}, db ${process.env.EVONY_DB || 'evony.db'})`);
}

if (require.main === module) main();
module.exports = { handle, resolveAccount, resolveCity, accounts, clip, sinceMs, fmt, eventLine, tailFile, TOOLS };
