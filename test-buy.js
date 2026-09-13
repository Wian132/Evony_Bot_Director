'use strict';
// Isolate why trade.newTrade kills the connection.
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
const env = loadEnv();

async function attempt(label, payload) {
  const g = new Game((m) => console.log('    [net] ' + m));
  let dead = false;
  await g.connect(env.EVONY_SERVER, env.EVONY_EMAIL, env.EVONY_PASSWORD);
  g.c.on('log', (m) => { if (/closed/.test(m)) dead = true; });
  const cid = g.castleId(g.castle());
  const body = { castleId: cid, ...payload };

  process.stdout.write(`${label.padEnd(34)} `);
  const t0 = Date.now();
  g.c.send('trade.newTrade', body);
  try {
    const r = await g.c.await(['trade.newTrade'], 9000);
    console.log(`replied in ${Date.now() - t0}ms -> ${JSON.stringify(r.data)}`);
  } catch (e) {
    console.log(`NO REPLY after ${Date.now() - t0}ms, socket ${dead ? 'DEAD' : 'alive'}`);
  }
  g.close();
  await new Promise((r) => setTimeout(r, 1500));
}

(async () => {
  // first, what does the market look like and how many offers do we hold?
  const g = new Game((m) => console.log('    [net] ' + m));
  await g.connect(env.EVONY_SERVER, env.EVONY_EMAIL, env.EVONY_PASSWORD);
  const cid = g.castleId(g.castle());
  const mkt = await g.searchTrades('food');
  const sellers = (mkt.sellers || []).slice(0, 3).map((s) => `${s.amount}@${s.price}`).join('  ');
  const mine = await g.myTrades(cid);
  console.log('food sellers :', sellers || '(none)');
  console.log('my offers    :', (mine.trades || mine.tradeList || []).length);
  console.log('gold         :', Math.round(Number((g.castle().resource || {}).gold || 0)).toLocaleString('en-US'));
  console.log('');
  g.close();
  await new Promise((r) => setTimeout(r, 1200));

  const base = { resType: C.TRADE_RES.food, tradeType: C.TRADE_TYPE.buy };
  await attempt('amount 1000 @0.01',        { ...base, amount: 1000,     price: '0.01' });
  await attempt('amount 99999999 @0.01',    { ...base, amount: 99999999, price: '0.01' });
  await attempt('amount 99999999 price num',{ ...base, amount: 99999999, price: 0.01 });
  process.exit(0);
})();
