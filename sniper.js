'use strict';
// Market sniper for ss71: watch resource prices, pounce when someone lists absurdly cheap.
//
//   node sniper.js            -- live
//   node sniper.js --dry      -- scan and report, buy nothing
//
// Priority order is wood -> iron -> food -> stone; after a buy it rescans from the top,
// so wood always gets first claim on your gold.
const fs = require('fs');
const path = require('path');
const { Game } = require('./game');
const C = require('./constants');

// ----------------------------------------------------------------- config
const CFG = {
  THRESHOLD: 0.02,        // pounce when the best ask is BELOW this
  BUY_PRICE: '0.021',     // our bid (must be >= the asks we want to match)
  ORDER: ['wood', 'iron', 'food', 'stone'],
  MIN_GOLD: 1_000_000_000,   // never trade the castle below this
  BURST: 10,              // buy orders fired back-to-back per volley
  MAX_BUYS: 100,          // "repeat 100" per trigger, then rescan
  SCAN_IDLE_MS: 700,      // pause between full scans when nothing is cheap
  // true  = size each order to what is actually listed below our bid (no leftover
  //         open offer, no locked gold, no wasted offer slot)
  // false = always order FIXED_AMOUNT, NEAT-style
  SIZE_TO_AVAILABLE: true,
  FIXED_AMOUNT: 99999999,
  CANCEL_LEFTOVERS: true, // clear our unfilled buy offers so slots stay free
};

const DRY = process.argv.includes('--dry');

function loadEnv() {
  const out = {};
  const p = path.join(__dirname, '.env');
  if (fs.existsSync(p)) for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2];
  }
  return out;
}

const ts = () => new Date().toLocaleTimeString();
const money = (n) => Math.round(n).toLocaleString('en-US');
const log = (m) => console.log(`${ts()}  ${m}`);

(async () => {
  const env = loadEnv();
  const g = new Game((m) => { if (!/^-> /.test(m)) log('  ' + m); });
  await g.connect(env.EVONY_SERVER || 'ss71', env.EVONY_EMAIL, env.EVONY_PASSWORD);

  const castle = g.castle(process.env.CASTLE);
  const cid = g.castleId(castle);
  let alive = true;
  g.c.on('log', (m) => { if (/closed/.test(m)) alive = false; });

  // keep gold current — the server pushes ResourceUpdate as trades settle
  const goldNow = () => Number((castle.resource && castle.resource.gold) || 0);
  g.c.on('cmd', (cmd, data) => {
    if (cmd === 'server.ResourceUpdate' && data && data.castleId === cid && data.resource) {
      castle.resource = data.resource;
    }
  });

  log(`sniping from ${castle.name} (castle ${cid})${DRY ? '  [DRY RUN]' : ''}`);
  log(`trigger < ${CFG.THRESHOLD}, bid ${CFG.BUY_PRICE}, min gold ${money(CFG.MIN_GOLD)}, gold now ${money(goldNow())}`);

  let scans = 0, bought = 0, spentOrders = 0;

  while (alive) {
    if (goldNow() < CFG.MIN_GOLD) {
      log(`gold ${money(goldNow())} is below the ${money(CFG.MIN_GOLD)} floor — holding`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    let firedThisPass = false;

    for (const res of CFG.ORDER) {
      if (!alive) break;
      let mkt;
      try { mkt = await g.searchTrades(res); } catch (e) { log(`scan ${res}: ${e.message}`); continue; }
      scans++;

      const sellers = (mkt.sellers || []).map((s) => ({ amount: Number(s.amount), price: Number(s.price) }))
        .filter((s) => s.price > 0).sort((a, b) => a.price - b.price);
      if (!sellers.length) continue;
      const best = sellers[0].price;

      if (best >= CFG.THRESHOLD) continue;

      const cheap = sellers.filter((s) => s.price <= Number(CFG.BUY_PRICE));
      const available = cheap.reduce((n, s) => n + s.amount, 0);
      const cost = cheap.reduce((n, s) => n + s.amount * s.price, 0);
      log(`*** ${res.toUpperCase()} best ask ${best} — ${money(available)} available at/below ${CFG.BUY_PRICE} (~${money(cost)} gold)`);
      firedThisPass = true;

      if (DRY) { log('  [dry run] would buy now'); continue; }

      const amount = CFG.SIZE_TO_AVAILABLE ? Math.min(available, CFG.FIXED_AMOUNT) : CFG.FIXED_AMOUNT;
      if (amount <= 0) continue;

      let ok = 0, fail = 0, capped = false;
      const onCmd = (cmd, data) => {
        if (cmd !== 'trade.newTrade') return;
        if (data && data.ok === 1) ok++;
        else {
          fail++;
          if (data && data.ok === -38) capped = true;
          else if (fail <= 2) log(`  reject: ${JSON.stringify(data)}`);
        }
      };
      g.c.on('cmd', onCmd);

      const t0 = Date.now();
      let sent = 0;
      while (sent < CFG.MAX_BUYS && !capped && alive && goldNow() >= CFG.MIN_GOLD) {
        const n = Math.min(CFG.BURST, CFG.MAX_BUYS - sent);
        for (let i = 0; i < n; i++) {
          g.c.send('trade.newTrade', {
            castleId: cid, resType: C.TRADE_RES[res], tradeType: C.TRADE_TYPE.buy,
            amount, price: String(CFG.BUY_PRICE),
          });
        }
        sent += n;
        const deadline = Date.now() + 12000;
        while (ok + fail < sent && Date.now() < deadline && alive) await new Promise((r) => setTimeout(r, 5));
        if (CFG.SIZE_TO_AVAILABLE) break;   // one pass is enough when sized to the book
      }
      g.c.off('cmd', onCmd);
      bought += ok; spentOrders += sent;
      log(`  ${res}: ${ok} filled / ${fail} rejected in ${Date.now() - t0}ms${capped ? '  (hit the 10-offer cap)' : ''}  gold ${money(goldNow())}`);

      if (CFG.CANCEL_LEFTOVERS) {
        try {
          const mine = await g.myTrades(cid);
          const open = (mine.trades || mine.tradeList || []).filter((t) => Number(t.tradeType) === C.TRADE_TYPE.buy);
          for (const t of open) {
            const id = t.id ?? t.tradeId;
            if (id === undefined) continue;
            await g.cancelTrade(cid, id);
            await new Promise((r) => setTimeout(r, 120));
          }
          if (open.length) log(`  cleared ${open.length} leftover buy offer(s)`);
        } catch (e) { log('  cleanup: ' + e.message); }
      }
      break;   // rescan from the top so wood keeps priority
    }

    if (!firedThisPass) {
      if (scans % 40 === 0) log(`watching… ${scans} scans, ${bought} orders filled, gold ${money(goldNow())}`);
      await new Promise((r) => setTimeout(r, CFG.SCAN_IDLE_MS));
    }
  }

  log('socket closed — stopping');
  g.close();
  process.exit(0);
})();
