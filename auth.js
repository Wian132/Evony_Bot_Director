'use strict';
// Sign-in for OTTObot.
//
// These pages control live game accounts and the Director's editor shows their
// stored passwords, so this is the only thing between the internet and other
// people's fleets:
//
//   * passwords verified with scrypt + timingSafeEqual, never stored in clear
//   * sessions are 32 random bytes, httpOnly + SameSite=Strict, server-side
//     expiry, revocable per user
//   * failed attempts back off exponentially per IP
//   * the same error for a wrong password and an unknown email, so the form
//     cannot be used to discover who has an account here
//   * binding a non-loopback interface REFUSES to start with no users
//
// Every request that gets through carries {user, org, role}; see tenancy.js for
// how that org then scopes every read and write.
const crypto = require('crypto');
const D = require('./db');

const SESSION_HOURS = Number(process.env.AUTH_SESSION_HOURS || 12);
const COOKIE = 'otto_sid';

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
// OTTObot is multi-tenant: sign-in is per user, and every user belongs to one
// or more organizations. Auth is "on" as soon as any user exists.
function configure() { return D.users.count() > 0; }
function isEnabled() { return D.users.count() > 0; }

// Open registration is off by default — this is a private deployment until the
// operator explicitly opens it. ALLOW_SIGNUP=1 turns it on.
function signupOpen() {
  return process.env.ALLOW_SIGNUP === '1' || D.users.count() === 0;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

// Returns {ok:true, user, org} or {ok:false, error}.
function register({ email, password, orgName, name }) {
  email = String(email || '').trim();
  password = String(password || '');
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'That does not look like an email address.' };
  if (password.length < 10) return { ok: false, error: 'Use at least 10 characters.' };
  if (D.users.byEmail(email)) return { ok: false, error: 'That email is already registered. Sign in instead.' };

  const user = D.users.create({ email, passwordHash: hashPassword(password), name: name || null });
  // Every new account gets its own organization, and owns it. Sharing one later
  // is an invite, never a default.
  const org = D.orgs.create(orgName && orgName.trim() ? orgName.trim() : (name || email.split('@')[0]) + "'s fleet");
  D.users.join(user.id, org.id, 'owner');
  return { ok: true, user, org };
}

// Returns {ok:true, user, org} or {ok:false, error}. The error is deliberately
// identical for unknown-email and wrong-password so it cannot be used to find
// out who has an account here.
function signIn({ email, password }) {
  const user = D.users.byEmail(String(email || '').trim());
  const WRONG = { ok: false, error: 'Wrong email or password.' };
  if (!user || user.disabled) {
    // still spend the time, so a missing user is not faster than a wrong password
    hashPassword(String(password || ''));
    return WRONG;
  }
  if (!verifyPassword(password, user.passwordHash)) return WRONG;
  D.users.noteLogin(user.id);
  const orgs = D.users.orgsOf(user.id);
  return { ok: true, user, org: orgs[0] || null };
}

// --------------------------------------------------------------- sessions

const newSession = (userId, orgId, ip, ua) => D.sessions.create(userId, orgId, ip, ua, SESSION_HOURS);
const resolveSession = (sid) => D.sessions.resolve(sid);
const validSession = (sid) => !!D.sessions.resolve(sid);
const endSession = (sid) => D.sessions.end(sid);
const revokeAll = (userId) => D.sessions.endAllFor(userId);

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

const PAGE = ({ mode = 'signin', msg = '', email = '', canSignup = true }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>OTTObot</title><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<style>
  :root { --bg:#eef1f5; --panel:#fff; --line:#d3dae3; --ink:#16202c; --dim:#5a6878;
          --blue:#1857c4; --bad:#c22f2f; --shadow:0 1px 2px rgba(20,30,45,.06),0 10px 34px rgba(20,30,45,.09); }
  :root[data-theme="dark"] { --bg:#171b22; --panel:#1f242d; --line:#39424f; --ink:#f0f3f8; --dim:#9fabbb;
          --blue:#7cb0ff; --bad:#ff7b7b; --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 34px rgba(0,0,0,.45); }
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);
       font:14.5px/1.5 "IBM Plex Sans","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;padding:24px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:30px 32px;
        width:min(380px,100%);box-shadow:var(--shadow)}
  .brand{display:flex;align-items:baseline;gap:8px;margin-bottom:2px}
  .brand b{font-size:21px;font-weight:700;letter-spacing:-.02em}
  .brand span{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--dim)}
  p.lede{margin:0 0 22px;color:var(--dim);font-size:13px}
  label{display:block;font-size:12px;color:var(--dim);margin:12px 0 5px}
  input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;
        font:14.5px inherit;background:var(--bg);color:var(--ink)}
  input:focus{outline:2px solid var(--blue);outline-offset:1px;border-color:var(--blue)}
  button{width:100%;margin-top:20px;padding:11px;border:0;border-radius:8px;background:var(--blue);
         color:#fff;font:600 14.5px inherit;cursor:pointer}
  button:hover{filter:brightness(1.08)}
  .alt{margin-top:18px;font-size:13px;color:var(--dim);text-align:center}
  .alt a{color:var(--blue);text-decoration:none;font-weight:500}
  .err{margin-top:16px;padding:9px 11px;border-radius:7px;background:rgba(194,47,47,.1);
       color:var(--bad);font-size:13px}
  .hint{font-size:11.5px;color:var(--dim);margin-top:5px}
</style></head><body>
<script>document.documentElement.setAttribute('data-theme',localStorage.getItem('evony_theme')||'light')</script>
<div class="card">
  <div class="brand"><b>OTTObot</b><span>Fleet Control</span></div>
  <p class="lede">${mode === 'signup'
    ? 'Create an account. You get your own organization — nobody else can see its bots.'
    : 'Sign in to your organization.'}</p>
  <form method="POST" action="${mode === 'signup' ? '/register' : '/login'}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email" required
           value="${String(email).replace(/"/g, '&quot;')}" autofocus>
    ${mode === 'signup' ? `
    <label for="orgName">Organization</label>
    <input id="orgName" name="orgName" placeholder="e.g. Acme Raiders">
    <div class="hint">What your fleet is called. You can change it later.</div>` : ''}
    <label for="password">Password</label>
    <input id="password" name="password" type="password" required
           autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}">
    ${mode === 'signup' ? '<div class="hint">At least 10 characters.</div>' : ''}
    <button type="submit">${mode === 'signup' ? 'Create account' : 'Sign in'}</button>
    ${msg ? `<div class="err">${msg}</div>` : ''}
  </form>
  ${mode === 'signup'
    ? '<div class="alt">Already have one? <a href="/login">Sign in</a></div>'
    : (canSignup ? '<div class="alt">No account yet? <a href="/register">Create one</a></div>' : '')}
</div></body></html>`;

// Handles /login, /register and /logout, and refuses everything else to anyone
// not signed in. Returns true when the request is finished.
//
// On success it hangs {user, org, role} on the request, and every route below
// reads its tenant from there — never from a query parameter, which the caller
// controls.
async function guard(req, res, { readBody }) {
  const url = new URL(req.url, 'http://x');
  const cookies = cookiesOf(req);
  const ip = ipOf(req);

  const send = (code, type, body, extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
    res.end(body);
    return true;
  };
  const setCookie = (sid) => {
    const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? ' Secure;' : '';
    return `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict;${secure} Max-Age=${SESSION_HOURS * 3600}`;
  };

  // Nobody has registered yet: send everyone to the sign-up form rather than a
  // locked door with no key.
  if (D.users.count() === 0 && url.pathname !== '/register') {
    return send(302, 'text/plain', 'set up', { Location: '/register' });
  }

  if (url.pathname === '/logout') {
    endSession(cookies[COOKIE]);
    return send(302, 'text/plain', 'bye', {
      'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`, Location: '/login',
    });
  }

  if (url.pathname === '/register') {
    if (!signupOpen()) return send(403, 'text/html; charset=utf-8',
      PAGE({ mode: 'signin', msg: 'Registration is closed on this server.', canSignup: false }));
    if (req.method !== 'POST') return send(200, 'text/html; charset=utf-8', PAGE({ mode: 'signup' }));
    const f = new URLSearchParams(await readBody(req));
    const r = register({
      email: f.get('email'), password: f.get('password'),
      orgName: f.get('orgName'), name: f.get('name'),
    });
    if (!r.ok) return send(400, 'text/html; charset=utf-8',
      PAGE({ mode: 'signup', msg: r.error, email: f.get('email') || '' }));
    const sid = newSession(r.user.id, r.org.id, ip, req.headers['user-agent']);
    return send(302, 'text/plain', 'ok', { 'Set-Cookie': setCookie(sid), Location: '/' });
  }

  if (url.pathname === '/login' && req.method === 'POST') {
    const wait = throttleFor(ip);
    if (wait > 0) return send(429, 'text/html; charset=utf-8',
      PAGE({ msg: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.`, canSignup: signupOpen() }));
    const f = new URLSearchParams(await readBody(req));
    const r = signIn({ email: f.get('email'), password: f.get('password') });
    if (!r.ok) {
      noteFailure(ip);
      return send(401, 'text/html; charset=utf-8',
        PAGE({ msg: r.error, email: f.get('email') || '', canSignup: signupOpen() }));
    }
    noteSuccess(ip);
    const sid = newSession(r.user.id, r.org && r.org.id, ip, req.headers['user-agent']);
    return send(302, 'text/plain', 'ok', { 'Set-Cookie': setCookie(sid), Location: '/' });
  }

  const sess = resolveSession(cookies[COOKIE]);
  if (sess) {
    req.user = sess.user;
    req.org = sess.org;
    req.role = sess.role;
    req.sid = sess.sid;
    // Signed in but with no organization is a broken state, not a usable one.
    if (!sess.org && !url.pathname.startsWith('/api/')) {
      return send(403, 'text/html; charset=utf-8',
        PAGE({ msg: 'Your account is not in an organization. Ask whoever invited you.', canSignup: false }));
    }
    return false;
  }

  if (url.pathname === '/login') {
    return send(200, 'text/html; charset=utf-8', PAGE({ canSignup: signupOpen() }));
  }
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
  if (!loopback && D.users.count() === 0) {
    console.error(`\n  REFUSING TO BIND ${host}: no users exist yet.\n`
      + `  These pages control live game accounts and show their stored passwords.\n`
      + `  Start on localhost first and register an account, or leave BIND unset.\n`);
    process.exit(1);
  }
  return host;
}

module.exports = {
  configure, isEnabled, signupOpen, guard, bindHost,
  hashPassword, verifyPassword, register, signIn,
  newSession, resolveSession, validSession, endSession, revokeAll,
  cookiesOf, ipOf, COOKIE, PAGE,
};
