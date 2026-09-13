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
  const cid = g.castleId(g.castle());

  console.log('player bean keys:', Object.keys(g.player).join(', '));
  for (const k of Object.keys(g.player)) {
    const v = g.player[k];
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && JSON.stringify(v[0]).includes('item')) {
      console.log(`  ${k}: ` + JSON.stringify(v).slice(0, 300));
    }
  }

  for (const cmd of ['common.getPackageList', 'common.getItemDefXml']) {
    g.c.send(cmd, { castleId: cid });
    try {
      const r = await g.c.await([cmd], 12000);
      const s = JSON.stringify(r.data);
      console.log(`\n${cmd}: ${s.length} bytes`);
      const hero = (s.match(/player\.box\.hero\.[a-f]/g) || []);
      const refresh = (s.match(/consume\.refreshtavern\.\d/g) || []);
      console.log('  hero-box mentions:', hero.length ? [...new Set(hero)].join(', ') : 'none');
      console.log('  refresh-tavern mentions:', refresh.length ? [...new Set(refresh)].join(', ') : 'none');
    } catch (e) { console.log(`${cmd}: ${e.message}`); }
  }
  g.close();
  process.exit(0);
})();
