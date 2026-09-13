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
  const me = g.castleXY(g.castle());
  console.log('my castle at', JSON.stringify(me));

  const rect = { x1: me.x - 4, y1: me.y - 4, x2: me.x + 4, y2: me.y + 4 };
  for (const cmd of ['common.mapInfoSimple', 'common.mapInfo']) {
    const t0 = Date.now();
    g.c.send(cmd, rect);
    try {
      const r = await g.c.await([cmd], 15000);
      const s = JSON.stringify(r.data);
      console.log(`\n${cmd} (9x9=81 tiles) in ${Date.now() - t0}ms, ${s.length} bytes`);
      console.log('  keys: ' + Object.keys(r.data).join(', '));
      const arr = r.data.mapInfos || r.data.castles || r.data.list || [];
      console.log('  entries: ' + (Array.isArray(arr) ? arr.length : 'n/a'));
      console.log('  sample: ' + s.slice(0, 700));
    } catch (e) { console.log(`${cmd}: ${e.message}`); }
  }

  for (const cmd of ['common.getPackageList', 'common.getPackageNumber']) {
    g.c.send(cmd, { castleId: cid });
    try {
      const r = await g.c.await([cmd], 12000);
      console.log(`\n${cmd}: ` + JSON.stringify(r.data).slice(0, 600));
    } catch (e) { console.log(`${cmd}: ${e.message}`); }
  }

  g.c.send('hero.GetDisappearHeros', {});
  try {
    const r = await g.c.await(['hero.GetDisappearHeros'], 12000);
    console.log('\nhero.GetDisappearHeros: ' + JSON.stringify(r.data).slice(0, 400));
  } catch (e) { console.log('GetDisappearHeros: ' + e.message); }

  g.close();
  process.exit(0);
})();
