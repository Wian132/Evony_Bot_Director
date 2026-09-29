'use strict';
// Claude's own key to a console (2026-09-28).
//
// The internal token (auth.js) deliberately reaches only a few read-only routes:
// it is a machine secret, not a second way to drive the bots. Claude needs more
// than that — to read everything, to follow the events feed, to run a script
// line, stop a script, close a gate — but not EVERYTHING a signed-in person can
// do. So Claude gets keys of its own, with their own short lists:
//
//   claudeToken      interactive: the user is at the keyboard with Claude.
//                    Reads, the events feed, in-line commands, scripts (run,
//                    stop, resume, runs), the gate, recalling a march, and
//                    /api/claude/act.
//   claudeAutoToken  auto: a Claude woken by an attack with nobody watching.
//                    Reads, the events feed, and ONLY /api/claude/act, which
//                    lets through just what this account's permissions allow
//                    (claude-perms.js: gate, troops, teleport, truce,
//                    dreamtruce, holiday).
//
// Both travel in the header `x-otto-claude` and are accepted ONLY from this
// machine (loopback): the consoles may be bound wider for the Director's pages,
// and these keys must never work from outside.
//
// Some things are refused in every scope, with the reason, because each has
// already cost the fleet or would cost it something that cannot be bought back
// (EVONY-RULES.md): see DENY_ROUTES and DENY_COMMANDS below.
//
// Every request with a Claude key that changes something is written to
// logs/claude-actions.jsonl — time, account, scope, route, command, result.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HEADER = 'x-otto-claude';

// ------------------------------------------------------------------ tokens
// Generated once per install, kept in the settings table like internalToken().
function tokenFor(key) {
  const D = require('./db');
  let t = D.settings.get(key, null);
  if (!t) { t = crypto.randomBytes(24).toString('hex'); D.settings.set(key, t); }
  return t;
}
const claudeToken = () => tokenFor('claudeToken');
const claudeAutoToken = () => tokenFor('claudeAutoToken');

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// 'interactive' | 'auto' | null (no header) | 'bad' (a header that is neither)
function scopeOf(req) {
  const sent = req.headers[HEADER];
  if (!sent) return null;
  if (same(sent, claudeToken())) return 'interactive';
  if (same(sent, claudeAutoToken())) return 'auto';
  return 'bad';
}

// The same reading of the address auth.js uses (ipOf), and nothing a client can
// set: X-Forwarded-For is ignored on purpose.
function isLoopback(req) {
  const ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1';
}

// ------------------------------------------------------------------ routes
// Reads: GET only, and only routes that answer from memory or from the live
// connection — never one that would log in to answer (/api/map, /api/inn and
// /api/market connect when not connected, so they are not here).
const READ_GET = new Set([
  '/api/session', '/api/city', '/api/cityx', '/api/marches', '/api/log', '/api/engine/report',
  '/api/items', '/api/script/runs', '/api/script/quick', '/api/editor', '/api/goals/script',
  '/api/goals/account', '/api/loadouts', '/api/chat', '/api/mapsearch', '/api/mapblocks',
  '/api/debug/city', '/api/stats', '/api/stats/lookup', '/api/alliance', '/api/alliance/player',
  '/api/friends', '/api/reports', '/api/reports/read', '/api/reports/log', '/api/events',
  '/api/claude/perms',
]);

// What the interactive key may change.
const INTERACTIVE_POST = new Set([
  '/api/script/inline', '/api/script', '/api/script/stop', '/api/script/resume',
  '/api/gate', '/api/army/recall', '/api/claude/act',
]);
// What the auto key may change: one door, behind the per-account permissions.
const AUTO_POST = new Set(['/api/claude/act']);

// Refused in every scope, with the reason given back.
const LOGIN_WHY = 'it logs the account in (or out and back in) — a Claude never spends a login: a second login kicks '
  + 'whatever holds the account, and one during maintenance holds it back ~30 minutes (EVONY-RULES §1, §2)';
const DENY_ROUTES = {
  '/api/connect': LOGIN_WHY,
  '/api/reconnect': LOGIN_WHY + '; a relog also ends a kick hold silently and kills every running script (EVONY-RULES §4)',
  '/api/switch': LOGIN_WHY,
  '/api/snapshot/refresh': LOGIN_WHY,
  '/api/settings': 'the account\'s settings (its security code) are the user\'s alone',
  '/api/settings/check': 'the account\'s settings (its security code) are the user\'s alone',
  '/api/maintenance': 'the maintenance override and plan decide when the console may log in — the user\'s call, not Claude\'s (EVONY-RULES §2)',
  '/api/pause': 'pausing the goal engine is the user\'s call: if the bot is on, its goals are on',
  '/api/valley': 'giving up a valley or founding a city cannot be undone',
  '/api/hero': 'the hero buttons include release and fire, which lose a hero for good (EVONY-RULES §5) — use a script line through cmd instead',
  '/api/goals': 'goal edits are overwritten from the goal files within 15 s and change what every city does — edit them with the user',
  '/api/goals/account': 'goal edits are overwritten from the goal files within 15 s and change what every city does — edit them with the user',
  '/api/items/use': 'items cost the account something — run the useitem line through cmd with the user present',
  '/api/debug/market-timing': 'the market probe places real orders',
};

// Script commands refused in every scope, wherever they appear in the text.
// Matched as whole words at a command position (start of a line or statement,
// after `then`/`else`, after a `\`, or quoted as a `command "…"` / `execute`),
// so an ordinary word inside `say` text still passes.
const DENY_COMMANDS = [
  { re: /release/, why: 'release on the captor\'s side loses our hero for good (EVONY-RULES §5)' },
  { re: /fire/, why: 'fire dismisses a hero for good (EVONY-RULES §5c: one of the five irreversible acts)' },
  { re: /disband/, why: 'disband dismisses troops for good (EVONY-RULES §5c)' },
  { re: /resetplayer/, why: 'resetplayer restarts the whole account (EVONY-RULES §5c)' },
  // `abandontown <city>` gives up a CITY and cannot be undone — always refused here, and it
  // needs OTTO_ALLOW_ABANDON_TOWN=1 on the console as well (EVONY-RULES §5d), so a city stays
  // doubly protected.
  //
  // `abandon <x,y>` is a different command: it releases a VALLEY OR FLAT the city occupies
  // (SCRIPTS.md "abandon <x,y> (a valley or flat of yours)"), and it is reversible — the tile
  // can simply be occupied again. Blocking it as well cost a real job on 2026-09-29: a26's
  // far-flung city could not be teleported to the hub because a city that occupies a valley
  // refuses to teleport (`ok=-84 Unable to teleport city to a preoccupied valley` — the
  // message names the SOURCE's valley, not the destination), and releasing that valley was
  // the fix the user had asked for ("capture and abandon a flat so the city can come closer").
  // So: refuse `abandon` unless it names a tile as x,y.
  { re: /abandontown/, why: 'abandoning a city cannot be undone (EVONY-RULES §5d)' },
  { re: /abandon\b(?!\s*\d+\s*,\s*\d+)/, why: 'abandon without x,y would give up a city, which cannot be undone (EVONY-RULES §5d); `abandon <x,y>` releases a valley or flat and is allowed' },
  { re: /allowabandon/, why: 'allowabandon adopts a city for abandoning, which cannot be undone (EVONY-RULES §5d)' },
  { re: /holiday\s+(?:\/?exit|\/end|off)\b/, why: 'never end a holiday — holiday in and out is the user\'s alone (EVONY-RULES §1)' },
  { re: /logout/, why: LOGIN_WHY },
  { re: /securitycode/, why: 'the security code is the user\'s alone (EVONY-RULES §5c)' },
  { re: /changeplayername/, why: 'renaming the lord cannot be undone' },
  { re: /resign/, why: 'resigning an alliance post cannot be undone by the bot' },
  { re: /quitalliance/, why: 'leaving the alliance cannot be undone by the bot (EVONY-RULES §4)' },
];
// where a command can start: line start, `;`, `then`, `else`, `do`, a
// backslash, or a quote after command/execute
const CMD_POS = String.raw`(?:^|[;\n\\]|\bthen\b|\belse\b|\bdo\b|(?:command|execute)\s*\(?\s*["'])\s*`;

// -> the reason a text is refused, or null
function deniedCommand(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return null;
  for (const d of DENY_COMMANDS) {
    const re = new RegExp(CMD_POS + '(?:' + d.re.source + ')(?![\\w])', 'm');
    if (re.test(s)) return `refused: ${d.why}`;
  }
  return null;
}

// Routes that must not log in to answer: a Claude call arriving while the
// console is offline is refused rather than letting SESSION.connect() log in.
const NEEDS_LIVE = new Set(['/api/script/inline', '/api/script', '/api/gate', '/api/army/recall',
  '/api/claude/act', '/api/debug/city']);
const needsLive = (method, p) => NEEDS_LIVE.has(p) && (method === 'POST' || p === '/api/debug/city');

// A Claude request that changes something (what gets audited).
function mutating(method, p) {
  return method !== 'GET' && p !== '/api/events';
}

// -> { ok: true } | { ok: false, code, error }
function checkRoute(scope, method, p) {
  if (DENY_ROUTES[p] && !(method === 'GET' && READ_GET.has(p))) return { ok: false, code: 403, error: `refused: ${DENY_ROUTES[p]}` };
  if (method === 'GET' || method === 'HEAD') {
    if (READ_GET.has(p)) return { ok: true };
    return { ok: false, code: 403, error: `refused: ${p} is not on Claude's read list` };
  }
  const allowed = scope === 'auto' ? AUTO_POST : INTERACTIVE_POST;
  if (allowed.has(p)) return { ok: true };
  return { ok: false, code: 403, error: scope === 'auto'
    ? `refused: in auto mode a Claude may only act through /api/claude/act, within this account's permissions`
    : `refused: ${p} is not on Claude's list of actions` };
}

// ------------------------------------------------------------ /api/claude/act
// The permissions module is part B's (claude-perms.js). It is read lazily so
// this file loads without it; with it missing, auto mode allows nothing.
function perms() {
  try { return require('./claude-perms'); } catch { return null; }
}

// body: {city, action:'gate', mode} | {city, command:'<script line>'}
// -> { ok: true, kind: 'gate'|'command', perm } | { ok: false, error }
function checkAct(scope, accountId, b, P = perms()) {
  b = b || {};
  const isGate = String(b.action || '') === 'gate';
  const command = isGate ? null : String(b.command || '').trim().replace(/^\\/, '').trim();
  if (!isGate && !command) return { ok: false, error: 'send {city, action:"gate", mode} or {city, command:"<script line>"}' };
  if (isGate && !['auto', 'open', 'closed'].includes(String(b.mode || ''))) return { ok: false, error: 'gate mode must be auto, open or closed' };
  if (command) {
    if (/\n/.test(command)) return { ok: false, error: 'one command at a time' };
    const no = deniedCommand(command);
    if (no) return { ok: false, error: no };
  }
  if (scope !== 'auto') return { ok: true, kind: isGate ? 'gate' : 'command', perm: null };
  if (!P) return { ok: false, error: 'refused: the permissions module (claude-perms.js) is missing, so auto mode may do nothing' };
  const perm = isGate ? 'gate' : P.permFor(command);
  if (!perm) return { ok: false, error: `refused: "${command.slice(0, 60)}" is not one of the actions auto mode may take` };
  if (!P.allowed(accountId, perm)) return { ok: false, error: `refused: this account has not given Claude the "${perm}" permission (Director → Claude tab, or the console's Settings → Claude permissions)` };
  return { ok: true, kind: isGate ? 'gate' : 'command', perm };
}

// ------------------------------------------------------------------- audit
function auditFile() {
  return process.env.OTTO_CLAUDE_AUDIT || path.join(__dirname, 'logs', 'claude-actions.jsonl');
}
function audit(entry) {
  try {
    const f = auditFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) { console.error('[claude] audit write failed: ' + e.message); }
}

// What the audit line says the request asked for, short.
function describeBody(p, b) {
  if (!b || typeof b !== 'object') return null;
  if (p === '/api/script') return { city: b.city ?? b.castle ?? null, src: String(b.src || '').slice(0, 400), dryRun: !!b.dryRun };
  if (p === '/api/script/inline') return { city: b.city ?? null, text: String(b.text || '').slice(0, 400) };
  if (p === '/api/claude/act') return { city: b.city ?? null, action: b.action || null, mode: b.mode || null, command: b.command ? String(b.command).slice(0, 400) : null };
  return Object.fromEntries(Object.entries(b).slice(0, 8).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 200) : v]));
}

// ---------------------------------------------------------------- the gate
// Called by auth.guard before anything else. -> null when the request carries
// no Claude key (auth carries on as before), true when it was refused and the
// answer sent, false when it may go on (req.claude = {scope} is set, and a
// POST's body is read and kept on req._rawBody for the route to use).
async function gate(req, res, url, { readBody } = {}) {
  const scope = scopeOf(req);
  if (scope === null) return null;
  const refuse = (code, error) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error, claude: true }));
    return true;
  };
  if (!isLoopback(req)) return refuse(403, 'refused: a Claude key only works from this machine');
  if (scope === 'bad') return refuse(401, 'refused: that is not a Claude key of this install');
  const p = url.pathname;
  const r = checkRoute(scope, req.method, p);
  const log = (result, request = null) => audit({ scope, route: p, method: req.method, request, result });
  if (!r.ok) { if (mutating(req.method, p)) log({ refused: r.error }); return refuse(r.code, r.error); }

  req.claude = { scope };
  if (req.method === 'POST' && readBody) {
    const raw = await readBody(req);
    req._rawBody = raw;
    let b = {};
    try { b = JSON.parse(raw || '{}'); } catch { b = {}; }
    req.claude.body = b;
    // the text a script route would run, checked before it gets anywhere near the game
    const text = p === '/api/script' ? (b.parseOnly ? '' : b.src)
      : p === '/api/script/inline' ? b.text
      : p === '/api/claude/act' ? b.command : '';
    const no = deniedCommand(text);
    if (no) { log({ refused: no }, describeBody(p, b)); return refuse(403, no); }
  }
  return false;
}

// After the route has answered: the audit line, with the account and a short
// result. server.js wraps res.end for a mutating Claude request and calls this.
function auditDone(req, p, accountId, status, bodyText) {
  let result = null;
  try {
    const j = JSON.parse(String(bodyText || ''));
    result = { ok: j.ok ?? null, error: j.error || null, started: j.started || undefined };
    if (Array.isArray(j.lines)) result.lines = j.lines.slice(0, 5).map((l) => String(l).slice(0, 200));
  } catch { result = { raw: String(bodyText || '').slice(0, 200) }; }
  audit({ account: accountId || null, scope: req.claude && req.claude.scope, route: p, method: req.method,
    status, request: describeBody(p, req.claude && req.claude.body), result });
}

module.exports = {
  HEADER, claudeToken, claudeAutoToken, scopeOf, isLoopback, checkRoute, deniedCommand, checkAct,
  needsLive, mutating, gate, audit, auditDone, auditFile, describeBody,
  READ_GET, INTERACTIVE_POST, AUTO_POST, DENY_ROUTES, DENY_COMMANDS,
};
