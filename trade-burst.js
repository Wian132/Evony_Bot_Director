'use strict';
// Pipelined WRITE test: fire N tiny sell orders back-to-back without waiting,
// count how many the server confirms, then cancel every one of them.
const fs = require('fs');
const path = require('path');
const { Game } = require('./game');
const C = require('./constants');

function loadEnv() {
  const out = {};
  const p = path.join(__dirname, '.env');
  if (fs.existsSync(p)) for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2];
  }
  return out;
}

const N = Number(process.env.N || 5);

(async () => {
  const env = loadEnv();
  const g = new Game((m) => console.log('[g] ' + m));
  await g.connect(env.EVONY_SERVER || 'ss71', env.EVONY_EMAIL, env.EVONY_PASSWORD);
  const cid = g.castleId(g.castle());

  const mkt = await g.searchTrades('wood');
  const top = (mkt.sellers || []).reduce((m, s) => Math.max(m, Number(s.price) || 0), 0);
  const price = (top > 0 ? top * 2 + 5 : 50).toFixed(2);
  console.log(`\nlisting ${N} x 1 wood @ ${price} (top seller ${top}) - pipelined\n`);

  let ok = 0, fail = 0, alive = true;
  g.c.on('log', (m) => { if (/closed/.test(m)) alive = false; });
  const failCodes = {};
  const onCmd = (cmd, data) => {
    if (cmd !== 'trade.newTrade') return;
    if (data && data.ok === 1) ok++;
    else { fail++; const k = JSON.stringify(data); failCodes[k] = (failCodes[k] || 0) + 1; }
  };
  g.c.on('cmd', onCmd);

  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    g.c.send('trade.newTrade', { castleId: cid, resType: C.TRADE_RES.wood, tradeType: C.TRADE_TYPE.sell, amount: 1, price: String(price) });
  }
  const written = Date.now() - t0;

  const deadline = Date.now() + 25000;
  while (ok + fail < N && Date.now() < deadline && alive) await new Promise((r) => setTimeout(r, 5));
  const total = Date.now() - t0;
  g.c.off('cmd', onCmd);

  console.log(`wrote ${N} frames in ${written}ms`);
  console.log(`confirmed ok=${ok} fail=${fail} in ${total}ms  -> ${(ok / (total / 1000)).toFixed(1)} trades/sec`);
  console.log("failure payloads: " + JSON.stringify(failCodes));
  console.log(`socket alive: ${alive}`);
  console.log(`(sequential would be ~${(N * 0.534).toFixed(1)}s)`);

  // cleanup
  await new Promise((r) => setTimeout(r, 800));
  const mine = await g.myTrades(cid);
  const list = (mine.trades || mine.tradeList || []).filter((t) => Number(t.amount) === 1);
  let cancelled = 0;
  for (const t of list) {
    const id = t.id ?? t.tradeId;
    if (id === undefined) continue;
    try { const r = await g.cancelTrade(cid, id); if (r.ok === 1) cancelled++; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`\ncleaned up ${cancelled}/${list.length} listing(s)`);
  g.close();
  process.exit(0);
})();
