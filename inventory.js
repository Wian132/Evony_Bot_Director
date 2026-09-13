'use strict';
// What hero-related items does this account hold?
const fs = require('fs');
const path = require('path');
const { Game } = require('./game');

const NAMES = {
  'player.box.hero.a': 'Leather Helm of Robinhood (Lv10-15)',
  'player.box.hero.b': 'Chain Helm of Beowulf (Lv16-25)',
  'player.box.hero.c': 'Plate Helm of Lancelot (Lv26-35, attr 70-80)',
  'player.box.hero.d': 'Holy Helm of Mars (Lv36-50, attr 80+)',
  'player.box.hero.e': 'Crystal of Attunement (Lv51-70, attr 100+)',
  'player.box.hero.f': "Ardee's Sigil of Recruitment",
  'consume.refreshtavern.1': 'Hero Hunting (refresh the inn)',
  'hero.reset.1': 'Holy Water (redistribute attributes)',
  'player.box.currently.1': 'Hero Package (10 Holy Water + 10 Hero Hunting)',
};

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
  console.log(`inventory: ${items.length} distinct item(s)\n`);
  console.log('--- hero related ---');
  for (const it of items) {
    if (NAMES[it.id]) console.log(`  ${String(it.count).padStart(5)} x  ${NAMES[it.id]}   [${it.id}]`);
  }
  console.log('\n--- everything else with count > 0 (top 20 by count) ---');
  for (const it of items.filter((x) => !NAMES[x.id]).sort((a, b) => b.count - a.count).slice(0, 20)) {
    console.log(`  ${String(it.count).padStart(5)} x  ${it.id}`);
  }
  g.close();
  process.exit(0);
})();
