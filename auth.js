'use strict';
// Login for the console and the Director.
//
// These pages control every bot and the Director's editor shows stored account
// passwords, so on any host that is not your own machine this is the only thing
// between the internet and the fleet. It is deliberately small and boring:
//
//   * password verified with scrypt + timingSafeEqual (no plaintext at rest)
//   * session token is 32 random bytes, httpOnly + SameSite=Strict, server-side
//     expiry, revocable
//   * failed attempts are rate limited per IP with a growing delay
//   * binding to anything other than loopback REFUSES to start without a password
//
// It is not a user system. One shared password, because there is one operator.
const crypto = require('crypto');
const D = require('./db');

const SESSION_HOURS = Number(process.env.AUTH_SESSION_HOURS || 12);
const COOKIE = 'evony_sid';

// ---------------------------------------------------------------- password

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const dk = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt}$${dk.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hex] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !salt || !hex) return false;
    const dk = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
    const want = Buffer.from(hex, 'hex');
    return dk.length === want.length && crypto.timingSafeEqual(dk, want);
  } catch { return false; }
}

// AUTH_PASSWORD sets (or resets) the password on startup; after that only the
// hash is kept. Returns the stored hash, or null when no password is set.
function configure() {
  const fromEnv = process.env.AUTH_PASSWORD;
  if (fromEnv) {
    const stored = hashPassword(fromEnv);
    D.settings.set('authHash', stored);
    return stored;
  }
  return D.settings.get('authHash', null);
}

function isEnabled() { return !!D.settings.get('authHash', null); }

// --------------------------------------------------------------- sessions

function newSession(ip, ua) {
  const sid = crypto.randomBytes(32).toString('hex');
  const sessions = D.settings.get('authSessions', {}) || {};
  sessions[sid] = { at: Date.now(), expires: Date.now() + SESSION_HOURS * 3600000, ip, ua: String(ua || '').slice(0, 120) };
  // drop anything expired while we are here
  for (const [k, v] of Object.entries(sessions)) if (!v || v.expires < Date.now()) delete sessions[k];
  D.settings.set('authSessions', sessions);
  return sid;
}

function validSession(sid) {
  if (!sid) return false;
  const sessions = D.settings.get('authSessions', {}) || {};
  const s = sessions[sid];
  return !!(s && s.expires > Date.now());
}

function endSession(sid) {
  const sessions = D.settings.get('authSessions', {}) || {};
  delete sessions[sid];
  D.settings.set('authSessions', sessions);
}

function revokeAll() { D.settings.set('authSessions', {}); }

// ------------------------------------------------------------ rate limit

const attempts = new Map();   // ip -> { n, until }

function throttleFor(ip) {
  const a = attempts.get(ip);
  if (!a) return 0;
  return Math.max(0, a.until - Date.now());
}

function noteFailure(ip) {
  const a = attempts.get(ip) || { n: 0, until: 0 };
  a.n++;
  // 0s, 1s, 2s, 4s ... capped at 5 minutes
  a.until = Date.now() + Math.min(300000, Math.pow(2, Math.min(a.n, 9)) * 250);
  attempts.set(ip, a);
  return a;
}

function noteSuccess(ip) { attempts.delete(ip); }

// ------------------------------------------------------------------ http

const cookiesOf = (req) => Object.fromEntries(
  String(req.headers.cookie || '').split(';').map((c) => {
    const i = c.indexOf('=');
    return i === -1 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }).filter(([k]) => k));

const ipOf = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

const LOGIN_PAGE = (msg) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Sign in</title><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  :root { --bg:#eef1f5; --panel:#fff; --line:#d3dae3; --ink:#16202c; --dim:#5a6878; --blue:#1857c4; --bad:#c22f2f; }
  :root[data-theme="dark"] { --bg:#171b22; --panel:#1f242d; --line:#39424f; --ink:#f0f3f8; --dim:#9fabbb; --blue:#7cb0ff; }
  *{box-sizing:border-box} body{margin:0;height:100vh;display:grid;place-items:center;background:var(--bg);
    color:var(--ink);font:14.5px/1.5 "IBM Plex Sans","Segoe UI",system-ui,sans-serif}
  form{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:28px 30px;width:330px;
    box-shadow:0 1px 2px rgba(20,30,45,.06),0 8px 28px rgba(20,30,45,.08)}
  h1{margin:0 0 4px;font-size:17px}
  p{margin:0 0 18px;color:var(--dim);font-size:13px}
  input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:7px;font:14.5px inherit;
    background:var(--bg);color:var(--ink)}
  input:focus{outline:2px solid var(--blue);outline-offset:1px;border-color:var(--blue)}
  button{width:100%;margin-top:12px;padding:10px;border:0;border-radius:7px;background:var(--blue);color:#fff;
    font:600 14.5px inherit;cursor:pointer}
  .err{color:var(--bad);font-size:13px;margin-top:12px}
</style></head><body>
<script>document.documentElement.setAttribute('data-theme',localStorage.getItem('evony_theme')||'light')</script>
<form method="POST" action="/login">
  <h1>Evony Director</h1>
  <p>This console controls live game accounts.</p>
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
  <button type="submit">Sign in</button>
  ${msg ? `<div class="err">${msg}</div>` : ''}
</form></body></html>`;

// Returns true when the request has been fully handled and the caller should
// stop. Mount this before every other route.
async function guard(req, res, { readBody }) {
  if (!isEnabled()) return false;           // no password set: nothing to guard

  const url = new URL(req.url, 'http://x');
  const cookies = cookiesOf(req);
  const ip = ipOf(req);

  const send = (code, type, body, extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
    res.end(body);
    return true;
  };

  if (url.pathname === '/logout') {
    endSession(cookies[COOKIE]);
    return send(302, 'text/plain', 'bye', {
      'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      Location: '/login',
    });
  }

  if (url.pathname === '/login' && req.method === 'POST') {
    const wait = throttleFor(ip);
    if (wait > 0) {
      return send(429, 'text/html; charset=utf-8',
        LOGIN_PAGE(`Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.`));
    }
    const raw = await readBody(req);
    const password = new URLSearchParams(raw).get('password') || '';
    if (verifyPassword(password, D.settings.get('authHash', null))) {
      noteSuccess(ip);
      const sid = newSession(ip, req.headers['user-agent']);
      const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? ' Secure;' : '';
      return send(302, 'text/plain', 'ok', {
        'Set-Cookie': `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict;${secure} Max-Age=${SESSION_HOURS * 3600}`,
        Location: '/',
      });
    }
    const a = noteFailure(ip);
    return send(401, 'text/html; charset=utf-8',
      LOGIN_PAGE(`Wrong password (${a.n} failed attempt${a.n === 1 ? '' : 's'}).`));
  }

  if (validSession(cookies[COOKIE])) return false;    // signed in, carry on

  if (url.pathname === '/login') return send(200, 'text/html; charset=utf-8', LOGIN_PAGE(''));

  // Anything else: a page gets the form, an API call gets a clean 401 so the
  // UI's fetch does not silently render a login page into a data pane.
  if (url.pathname.startsWith('/api/')) {
    return send(401, 'application/json', JSON.stringify({ ok: false, error: 'not signed in', login: '/login' }));
  }
  return send(302, 'text/plain', 'sign in', { Location: '/login' });
}

// Refuse to listen on a public interface without a password. This is the whole
// point: the failure mode we are avoiding is an unauthenticated Director facing
// the internet.
function bindHost() {
  const host = process.env.BIND || '127.0.0.1';
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!loopback && !isEnabled()) {
    console.error(`\n  REFUSING TO BIND ${host}: no password is set.\n`
      + `  These pages control live accounts and show stored passwords.\n`
      + `  Start once with AUTH_PASSWORD=... to set one, or leave BIND unset for localhost only.\n`);
    process.exit(1);
  }
  return host;
}

module.exports = {
  configure, isEnabled, guard, bindHost, hashPassword, verifyPassword,
  newSession, validSession, endSession, revokeAll, cookiesOf, ipOf, COOKIE,
};
