'use strict';
// Inspect the prerequisite/condition responses for building + research.
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

  const b = (c.buildings || []).filter((x) => x.typeId);
  console.log(`buildings in ${c.name}: ${b.length}`);
  console.log('  ' + b.slice(0, 14).map((x) => `${x.name || x.typeId}@pos${x.positionId}=L${x.level}`).join('  '));

  const townhall = b.find((x) => x.typeId === 31);
  if (townhall) {
    g.c.send('castle.checkOutUpgrade', { castleId: cid, positionId: townhall.positionId });
    try {
      const r = await g.c.await(['castle.checkOutUpgrade'], 10000);
      console.log('\ncheckOutUpgrade (Town Hall pos ' + townhall.positionId + '):');
      console.log('  ' + JSON.stringify(r.data).slice(0, 900));
    } catch (e) { console.log('checkOutUpgrade: ' + e.message); }
  }

  for (const typeId of [25, 27]) {   // Academy, Feasting Hall
    g.c.send('castle.getAvailableBuildingBean', { castleId: cid, typeId });
    try {
      const r = await g.c.await(['castle.getAvailableBuildingBean'], 10000);
      console.log(`\ngetAvailableBuildingBean typeId=${typeId}:`);
      console.log('  ' + JSON.stringify(r.data).slice(0, 900));
    } catch (e) { console.log(`getAvailableBuildingBean ${typeId}: ` + e.message); }
  }

  g.c.send('tech.getResearchList', { castleId: cid });
  try {
    const r = await g.c.await(['tech.getResearchList'], 10000);
    console.log('\ntech.getResearchList:');
    console.log('  ' + JSON.stringify(r.data).slice(0, 1100));
  } catch (e) { console.log('getResearchList: ' + e.message); }

  g.close();
  process.exit(0);
})();
