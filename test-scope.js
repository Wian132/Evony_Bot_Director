'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Game } = require('./game');
const C = require('./constants');

function loadEnv() {
  const out = {};
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2];
  }
  return out;
}

const cfgXml = () => new Promise((res) => {
  http.get('http://ss71.evony.com/config.xml', (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(b)); })
    .on('error', () => res(''));
});

(async () => {
  const env = loadEnv();
  const xml = await cfgXml();
  console.log('server state:', (xml.match(/<ServerState>([^<]+)</) || [])[1] || '?');

  const g = new Game(() => {});
  await g.connect(env.EVONY_SERVER, env.EVONY_EMAIL, env.EVONY_PASSWORD);
  const cid = g.castleId(g.castle());
  console.log('maintenanceStart in login payload:', g.player.maintenanceStart ?? '(absent)');

  const probe = async (cmd, payload) => {
    const t0 = Date.now();
    g.c.send(cmd, payload);
    try { await g.c.await([cmd], 6000); console.log(`  OK   ${cmd} (${Date.now() - t0}ms)`); return true; }
    catch { console.log(`  --   ${cmd}`); return false; }
  };

  await probe('common.getPlayerInfoByName', { userName: g.player.playerInfo.userName });
  await probe('common.mapInfoSimple', { x1: 88, y1: 172, x2: 92, y2: 176 });
  await probe('field.getOtherFieldInfo', { fieldId: C.coordsToFieldId(88, 172) });
  await probe('castle.getAvailableBuildingBean', { castleId: cid, typeId: 25 });
  await probe('hero.getHerosListFromTavern', { castleId: cid });
  await probe('tech.getResearchList', { castleId: cid });
  await probe('interior.getResourceProduceData', { castleId: cid });
  await probe('common.getPackageList', { castleId: cid });

  console.log('\nsocket alive:', g.alive);
  g.close();
  process.exit(0);
})();
