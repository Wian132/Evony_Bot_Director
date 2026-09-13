'use strict';
// Is the whole connection dead, or only the trade subsystem?
const fs = require('fs');
const path = require('path');
const { Game } = require('./game');
const C = require('./constants');

function loadEnv() {
  const out = {};
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2];
  }
  return out;
}

(async () => {
  const env = loadEnv();
  const g = new Game(() => {});
  await g.connect(env.EVONY_SERVER, env.EVONY_EMAIL, env.EVONY_PASSWORD);
  const cid = g.castleId(g.castle());

  const probe = async (cmd, payload) => {
    const t0 = Date.now();
    g.c.send(cmd, payload);
    try {
      await g.c.await([cmd], 7000);
      console.log(`  ${cmd.padEnd(34)} replied in ${Date.now() - t0}ms`);
    } catch {
      console.log(`  ${cmd.padEnd(34)} NO REPLY (7s)`);
    }
  };

  console.log('non-trade commands:');
  await probe('common.getPlayerInfoByName', { userName: g.player.playerInfo.userName });
  await probe('army.getTroopParam', {});
  await probe('fortifications.getProduceQueue', { castleId: cid });
  await probe('report.receiveReportList', { pageNo: 1, pageSize: 5, reportType: 0 });

  console.log('\ntrade commands:');
  await probe('trade.searchTrades', { resType: C.TRADE_RES.food });
  await probe('trade.getMyTradeList', { castleId: cid });

  console.log('\nsocket alive:', g.alive);
  g.close();
  process.exit(0);
})();
