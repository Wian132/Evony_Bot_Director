'use strict';
// Does looking up a player break the castle context for this session?
const fs = require('fs');
const path = require('path');
const { EvonyClient, getServerConfig } = require('./evony');

function loadEnv() {
  const out = {};
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2];
  }
  return out;
}

(async () => {
  const env = loadEnv();
  const cfg = await getServerConfig(env.EVONY_SERVER);
  const c = new EvonyClient();
  await c.connect(cfg.host, cfg.port);
  const lr = await c.login(env.EVONY_EMAIL, env.EVONY_PASSWORD);
  const player = lr.data.player;
  const castle = player.castles[0];
  const cid = castle.castleId ?? castle.id;
  const me = player.playerInfo.userName;
  console.log('logged in, castleId =', cid, ' name =', castle.name);

  const probe = async (label, cmd, payload) => {
    const t0 = Date.now();
    c.send(cmd, payload);
    try { await c.await([cmd], 6000); console.log(`  OK   ${label} (${Date.now() - t0}ms)`); }
    catch { console.log(`  --   ${label}  NO REPLY`); }
  };

  console.log('\n1) castle command FIRST, before any player lookup:');
  await probe('tech.getResearchList', 'tech.getResearchList', { castleId: cid });

  console.log('\n2) now a player lookup:');
  await probe('getPlayerInfoByName(self)', 'common.getPlayerInfoByName', { userName: me });

  console.log('\n3) castle command again:');
  await probe('tech.getResearchList', 'tech.getResearchList', { castleId: cid });
  await probe('trade.getMyTradeList', 'trade.getMyTradeList', { castleId: cid });

  c.close();
  process.exit(0);
})();
