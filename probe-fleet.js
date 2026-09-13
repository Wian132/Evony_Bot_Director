'use strict';
// Which fields can a single login give the Director?
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
  const p = g.player;

  console.log('--- scalar fields on player ---');
  for (const [k, v] of Object.entries(p)) {
    if (v === null || typeof v === 'object') continue;
    console.log(`  ${k} = ${v}`);
  }
  console.log('\n--- array fields ---');
  for (const [k, v] of Object.entries(p)) {
    if (Array.isArray(v)) console.log(`  ${k}: ${v.length} entries` + (v.length ? '  e.g. ' + JSON.stringify(v[0]).slice(0, 160) : ''));
  }
  console.log('\n--- playerInfo ---');
  console.log('  ' + JSON.stringify(p.playerInfo));

  // anything coin-ish anywhere in the payload?
  const s = JSON.stringify(p);
  const coinKeys = [...new Set((s.match(/"[a-zA-Z]*[Cc]oin[a-zA-Z]*"/g) || []))];
  console.log('\ncoin-ish keys anywhere in LoginResponse:', coinKeys.join(', ') || 'none');

  g.close();
  process.exit(0);
})();
