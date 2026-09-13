'use strict';
// ONE login attempt, then exit. No supervisor, no retry, no engine.
//
// Used to test whether a throttled account has come back without starting a
// console that would then retry on its own and keep the block alive.
//   node login-probe.js a2
const D = require('./db');
const { Game } = require('./game');

const id = process.argv[2] || 'a2';
const acc = D.accounts.get(id);
if (!acc) { console.error(`no account ${id}`); process.exit(1); }

const t0 = Date.now();
(async () => {
  const g = new Game(() => {});
  try {
    await g.connect(acc.server || 'ss71', acc.email, acc.password);
    const p = g.player && g.player.playerInfo;
    console.log(`OK  ${acc.label}: logged in as ${p && p.userName} — `
      + `${g.castles.length} city(ies), ${Date.now() - t0}ms`);
    g.close();
    process.exit(0);
  } catch (e) {
    try { g.close(); } catch {}
    const throttled = /no reply to server\.LoginResponse/.test(e.message);
    console.log(`${throttled ? 'STILL BLOCKED' : 'FAILED'}  ${acc.label}: ${e.message} (${Date.now() - t0}ms)`);
    process.exit(2);
  }
})();
