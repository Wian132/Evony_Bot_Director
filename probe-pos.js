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
  const c = g.castle();
  const cid = g.castleId(c);

  for (const cmd of ['castle.getAvailableBuildingListInside', 'castle.getAvailableBuildingListOutside']) {
    g.c.send(cmd, { castleId: cid });
    try {
      const r = await g.c.await([cmd], 10000);
      console.log(`\n${cmd}:\n  ` + JSON.stringify(r.data).slice(0, 700));
    } catch (e) { console.log(`${cmd}: ${e.message}`); }
  }

  // what positions exist, and which are empty?
  const b = (c.buildings || []);
  const occupied = b.filter((x) => x.typeId).map((x) => x.positionId).sort((a, z) => a - z);
  const empty = b.filter((x) => !x.typeId).map((x) => x.positionId).sort((a, z) => a - z);
  console.log('\noccupied positions:', occupied.slice(0, 40).join(','));
  console.log('empty/other entries:', empty.slice(0, 40).join(','), ' (count ' + empty.length + ')');
  console.log('sample building entry:', JSON.stringify(b[0]));

  g.close();
  process.exit(0);
})();
