'use strict';
// Ramped trade test: 1 -> 10 -> 100 wood, listed well above market so nothing fills,
// then listed trades are cancelled again. Measures per-command latency.
const fs = require('fs');
const path = require('path');
const { Game } = require('./game');

function loadEnv() {
  const out = {};
  const p = path.join(__dirname, '.env');
  if (fs.existsSync(p)) for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2];
  }
  return out;
}

(async () => {
  const env = loadEnv();
  const g = new Game((m) => console.log('[g] ' + m));
  await g.connect(env.EVONY_SERVER || 'ss71', env.EVONY_EMAIL, env.EVONY_PASSWORD);
  const castle = g.castle();
  const cid = g.castleId(castle);

  console.log('\n--- current wood market ---');
  const mkt = await g.searchTrades('wood');
  const sellers = (mkt.sellers || []).slice(0, 3).map((s) => `${s.amount}@${s.price}`).join('  ');
  const buyers = (mkt.buyers || []).slice(0, 3).map((s) => `${s.amount}@${s.price}`).join('  ');
  console.log('  sellers:', sellers || '(none)');
  console.log('  buyers :', buyers || '(none)');

  // price well above the top seller so the listing just sits there
  const top = (mkt.sellers || []).reduce((m, s) => Math.max(m, Number(s.price) || 0), 0);
  const price = (top > 0 ? top * 2 + 5 : 50).toFixed(2);
  console.log(`  listing price: ${price} (top seller ${top})`);

  console.log('\n--- ramp: 1 -> 10 -> 100 wood ---');
  const timings = [];
  for (const amount of [1, 10, 100]) {
    const t0 = Date.now();
    let r;
    try { r = await g.newTrade({ castleId: cid, resource: 'wood', type: 'sell', amount, price }); }
    catch (e) { console.log(`  ${amount} wood: FAILED ${e.message}`); break; }
    const ms = Date.now() - t0;
    timings.push(ms);
    console.log(`  sell ${String(amount).padStart(4)} wood -> ok=${r.ok} in ${ms}ms` + (r.ok !== 1 ? '  ' + JSON.stringify(r) : ''));
    if (r.ok !== 1) break;
    await new Promise((res) => setTimeout(res, 1200));
  }

  console.log('\n--- my listed trades ---');
  const mine = await g.myTrades(cid);
  const list = mine.trades || mine.tradeList || [];
  console.log('  ' + (list.length ? JSON.stringify(list).slice(0, 500) : JSON.stringify(mine).slice(0, 400)));

  // clean up: cancel anything we just listed
  let cancelled = 0;
  for (const t of list) {
    const id = t.id ?? t.tradeId;
    if (id === undefined) continue;
    try {
      const r = await g.cancelTrade(cid, id);
      if (r.ok === 1) cancelled++;
      await new Promise((res) => setTimeout(res, 400));
    } catch { /* ignore */ }
  }
  console.log(`\ncancelled ${cancelled} trade(s)`);
  if (timings.length) console.log(`trade command latency: ${timings.join(' / ')} ms`);

  g.close();
  process.exit(0);
})();
