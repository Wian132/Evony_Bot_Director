'use strict';
// Send a command and log EVERY frame that follows, whatever its name.
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

  g.c.on('cmd', (cmd, data) => {
    console.log(`   <- ${cmd}  ${JSON.stringify(data).slice(0, 260)}`);
  });
  g.c.on('log', (m) => { if (!/^-> /.test(m)) console.log(`   [net] ${m}`); });

  const probe = async (label, cmd, payload, wait = 6000) => {
    console.log(`\n=== ${label} ===`);
    g.c.send(cmd, payload);
    await new Promise((r) => setTimeout(r, wait));
  };

  await probe('getMyTradeList', 'trade.getMyTradeList', { castleId: cid });
  await probe('getTransingTradeList', 'trade.getTransingTradeList', { castleId: cid });
  await probe('searchTrades food', 'trade.searchTrades', { resType: C.TRADE_RES.food });
  await probe('newTrade buy 1000 food @0.01', 'trade.newTrade', {
    castleId: cid, resType: C.TRADE_RES.food, tradeType: C.TRADE_TYPE.buy, amount: 1000, price: '0.01',
  }, 8000);

  console.log('\nsocket alive:', g.alive);
  g.close();
  process.exit(0);
})();
