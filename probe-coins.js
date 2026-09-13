'use strict';
const fs = require('fs');
const path = require('path');
const { Game } = require('./game');

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
  const items = g.player.items || [];

  console.log('items whose id mentions money / coin / cent / gold:');
  for (const it of items) {
    if (/money|coin|cent|gold/i.test(it.id)) console.log(`  ${String(it.count).padStart(8)}  ${it.id}`);
  }

  console.log('\nfirst 12 items in payload order (the array is not sorted by count):');
  items.slice(0, 12).forEach((it, i) => console.log(`  ${String(i).padStart(2)}  ${String(it.count).padStart(8)}  ${it.id}`));

  // anything that looks like a currency balance anywhere in the login payload
  const s = JSON.stringify(g.player);
  console.log('\nkeys matching money/cent/coin anywhere:', [...new Set(s.match(/"[a-zA-Z_]*(money|cent|coin)[a-zA-Z_]*"/gi) || [])].join(', ') || 'none');

  g.close();
  process.exit(0);
})();
