'use strict';
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
  const g = new Game(() => {});
  await g.connect(env.EVONY_SERVER || 'ss71', env.EVONY_EMAIL, env.EVONY_PASSWORD);
  const cid = g.castleId(g.castle());

  g.c.send('hero.getHerosListFromTavern', { castleId: cid });
  try {
    const r = await g.c.await(['hero.getHerosListFromTavern'], 10000);
    const d = r.data;
    const list = d.heros || d.heroList || d.herosList || [];
    console.log('tavern response keys:', Object.keys(d).join(', '));
    console.log('heroes offered:', list.length);
    for (const h of list.slice(0, 4)) console.log('  ' + JSON.stringify(h));
    if (!list.length) console.log('  raw: ' + JSON.stringify(d).slice(0, 600));
  } catch (e) { console.log('tavern: ' + e.message); }

  g.close();
  process.exit(0);
})();
