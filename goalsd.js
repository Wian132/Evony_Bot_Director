'use strict';
// Goal daemon. Keeps one warm socket, reconnects on its own, and runs the goal
// engine round-robin over every city.
//   node goalsd.js            plan only (default — reports what it WOULD do)
//   node goalsd.js --live     actually act
const fs = require('fs');
const path = require('path');
const { Game } = require('./game');
const { Engine } = require('./engine');
const D = require('./db');

const LIVE = process.argv.includes('--live');
const CONSOLE_PORT = Number(process.env.CONSOLE_PORT || 8711);
const EVERY_MS = Number(process.env.TICK_MS || 60000);
const HEARTBEAT_MS = 60000;
const IDLE_LIMIT_MS = 150000;

function loadEnv() {
  const out = {};
  const p = path.join(__dirname, '.env');
  if (fs.existsSync(p)) for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2];
  }
  return out;
}

const ts = () => new Date().toLocaleTimeString();
const log = (m) => console.log(`${ts()}  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A sleep a changed hostile army list can cut short (Engine.onHostile), so a
// new attack gets its war pass without waiting out the rest of the nap.
let cutNap = null;
const nap = (ms) => new Promise((r) => {
  const t = setTimeout(() => { cutNap = null; r(); }, Math.max(0, ms));
  cutNap = () => { clearTimeout(t); cutNap = null; r(); };
});
const WAR_GAP_MS = 1000;

(async () => {
  const env = loadEnv();
  let game = null, engine = null;
  let backoff = 5000, attempts = 0, lastPing = 0;

  // The console (server.js) holds its own session. Two logins for one account make
  // the server kick one of them, and the two then fight over the connection.
  function consoleHoldsThisAccount() {
    return new Promise((resolve) => {
      const req = require('http').get(`http://localhost:${CONSOLE_PORT}/api/session`, { timeout: 1500 }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(b);
            // Claim the account if the console OWNS it, even while it is mid
            // reconnect — otherwise the daemon slips in during that window and
            // the two supervisors kick each other in a loop.
            resolve(!!(j.account && j.account.label));
          } catch { resolve(false); }
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  async function connect() {
    if (await consoleHoldsThisAccount()) {
      throw new Error(`the console at localhost:${CONSOLE_PORT} is logged into this account — `
        + 'close it or switch it to another account before running the daemon');
    }
    const g = new Game((m) => { if (!/^-> /.test(m)) log('  ' + m); });
    await g.connect(env.EVONY_SERVER || 'ss71', env.EVONY_EMAIL, env.EVONY_PASSWORD);
    game = g;
    // Goals are stored per account, so the daemon has to say who it is or it
    // would fall through to whatever shared default happens to exist.
    const acct = D.accounts.byEmail(env.EVONY_EMAIL || '');
    const prevState = engine && engine.state;
    engine = new Engine(g, log, acct && acct.id);
    if (prevState) engine.state = prevState;       // carry timers across a reconnect
    engine.dryRun = !LIVE;
    engine.onHostile = () => { if (cutNap) cutNap(); };
    lastPing = Date.now();
    log(`connected as ${acct ? acct.label : env.EVONY_EMAIL} — ${LIVE ? 'LIVE (will act)' : 'PLAN ONLY'}, `
      + `tick ${EVERY_MS / 1000}s, ${g.castles.length} city(ies)`);
  }

  for (;;) {
    // (re)connect when needed, backing off hard so we never hammer the server
    if (!game || !game.alive) {
      try {
        if (attempts) { log(`reconnecting in ${Math.round(backoff / 1000)}s (attempt ${attempts + 1})`); await sleep(backoff); }
        await connect();
        attempts = 0; backoff = 5000;
      } catch (e) {
        attempts++; backoff = Math.min(backoff * 2, 300000);
        log(`connect failed: ${e.message}`);
        continue;
      }
    }

    try {
      await engine.tick();
    } catch (e) {
      log('tick error: ' + e.message);
    }

    // keep the socket warm between ticks, and notice a silent death. Hiding and
    // the gate race a wave's arrival, so they get a pass of their own at each
    // moment the engine names (Engine.nextWakeAt), never two within a second.
    const waitUntil = Date.now() + EVERY_MS;
    let warAt = 0;
    while (Date.now() < waitUntil) {
      let wake = null;
      try { wake = engine.nextWakeAt(); } catch (e) { log('war clock: ' + e.message); }
      const wakeIn = wake ? Math.max(0, wake - Date.now(), warAt + WAR_GAP_MS - Date.now()) : Infinity;
      if (wakeIn <= 0) {
        try { await engine.tick({ urgent: true }); } catch (e) { log('war pass error: ' + e.message); }
        warAt = Date.now();
        continue;
      }
      await nap(Math.min(5000, waitUntil - Date.now(), wakeIn));
      if (!game.alive) { log('socket died between ticks'); break; }
      if (game.idleMs > IDLE_LIMIT_MS) { log(`no traffic for ${Math.round(game.idleMs / 1000)}s — cycling`); game.close(); break; }
      if (Date.now() - lastPing > HEARTBEAT_MS) {
        lastPing = Date.now();
        try { await game.ping(); }
        catch { log('heartbeat failed — cycling'); game.close(); break; }
      }
    }
  }
})();
