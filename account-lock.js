'use strict';
// ONE CONSOLE PER ACCOUNT, held by the operating system.
//
// Two consoles for one account kick each other out of the game on every retry,
// and it looks exactly like someone else logging in. The start-up check in
// server.js asks the other consoles over HTTP who they hold, but a console that
// is still starting does not answer yet. On 2026-09-29 (11:41, the VPS) the
// trading watchdog restarted a23 and a27 through glitch-run.js while the
// Director's keep-on round found them missing and started one each. Both copies
// came up in the same second, neither saw the other, and they fought for an
// hour.
//
// So a console now takes a lock named after its account before it logs in: an
// abstract Unix socket on Linux, a named pipe on Windows. Only one process can
// listen on a name. The OS lets go of it the moment the process dies, even on
// kill -9 or a crash, so a lock is never left behind. Whoever holds it answers a
// connection with { pid, port, accountId }, which tells the loser (and botctl)
// which console to use instead.
//
// The name is scoped to the database file, so a test database's a1 never
// collides with the live fleet's a1.
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function scope() {
  const db = path.resolve(process.env.EVONY_DB || path.join(__dirname, 'evony.db'));
  return crypto.createHash('sha1').update(db.toLowerCase()).digest('hex').slice(0, 10);
}

function lockName(accountId) {
  const id = String(accountId).replace(/[^A-Za-z0-9_-]/g, '_');
  const name = `otto-console-${scope()}-${id}`;
  if (process.platform === 'win32') return '\\\\.\\pipe\\' + name;
  if (process.platform === 'linux') return '\0' + name;       // abstract: no file, gone with the process
  return path.join(os.tmpdir(), name + '.sock');             // elsewhere a socket file, stale ones cleared below
}

// Who holds the account's lock: { pid, port, accountId } or null when nobody does.
function who(accountId, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let buf = '', done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve(v); } };
    const sock = net.connect(lockName(accountId));
    const timer = setTimeout(() => finish(buf ? parse(buf) : { pid: null, port: null, accountId }), timeoutMs);
    sock.on('data', (c) => { buf += c; });
    sock.on('end', () => finish(parse(buf)));
    sock.on('error', () => finish(null));
  });
  function parse(b) {
    try { return JSON.parse(b); } catch { return { pid: null, port: null, accountId }; }
  }
}

function listen(name, info) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => { sock.on('error', () => {}); sock.end(JSON.stringify(info)); });
    srv.once('error', (e) => resolve({ ok: false, code: e.code, error: e.message }));
    srv.listen(name, () => { srv.unref(); resolve({ ok: true, server: srv }); });
  });
}

// Take the account's lock for this process. Resolves to
//   { ok: true }                          — ours; hold it for as long as the process lives
//   { ok: false, holder: { pid, port } }  — another console holds the account
//   { ok: true, skipped: reason }         — the lock itself is unavailable here; go on
//                                           without it rather than keep a bot down
// A holder that is on its way out (a restart kills the old console and starts
// the new one straight after) is waited for, up to waitMs.
async function take(accountId, { port = null, waitMs = 10000 } = {}) {
  const name = lockName(accountId);
  const info = { pid: process.pid, port, accountId };
  const until = Date.now() + waitMs;
  for (;;) {
    const r = await listen(name, info);
    if (r.ok) return { ok: true };
    if (r.code !== 'EADDRINUSE') return { ok: true, skipped: r.error };
    const holder = await who(accountId);
    if (holder && holder.pid === process.pid) return { ok: true };
    if (!holder && !name.startsWith('\0') && !name.startsWith('\\\\')) {
      // Nobody answers: a socket file left by a crash (macOS and the like). Clear it.
      try { fs.unlinkSync(name); } catch { /* raced */ }
    }
    // Held by a process that does not say who it is (busy, or dying): still held.
    if (Date.now() >= until) return { ok: false, holder: holder || { pid: null, port: null, accountId } };
    await new Promise((res) => setTimeout(res, 500));
  }
}

module.exports = { take, who, lockName };
