'use strict';
// What does the castle bean actually contain for this account?
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

  for (const c of g.castles) {
    console.log('\ncastle keys:', Object.keys(c).join(', '));
    console.log('  castleId:', g.castleId(c), ' name:', c.name, ' fieldId:', c.fieldId, ' coords:', c.coords);
    console.log('  derived XY:', JSON.stringify(g.castleXY(c)));
    console.log('  heros:', JSON.stringify(c.heros));
    console.log('  troop:', JSON.stringify(c.troop));
  }
  console.log('\nplayerInfo:', JSON.stringify(g.player.playerInfo));
  g.close();
  process.exit(0);
})();
