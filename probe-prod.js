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
  const c = g.castle();
  const cid = g.castleId(c);

  const r = await g.req('interior.getResourceProduceData', { castleId: cid }).catch((e) => ({ error: e.message }));
  console.log('getResourceProduceData:');
  console.log('  ' + JSON.stringify(r).slice(0, 900));

  const res = c.resource || {};
  console.log('\nfrom the castle bean:');
  for (const k of ['curPopulation', 'maxPopulation', 'workPeople', 'buildPeople', 'texRate', 'taxIncome', 'support', 'complaint']) {
    console.log(`  ${k} = ${JSON.stringify(res[k])}`);
  }
  for (const k of ['food', 'wood', 'stone', 'iron']) {
    const v = res[k] || {};
    console.log(`  ${k}: workPeople=${v.workPeople} increaseRate=${v.increaseRate} max=${v.max}`);
  }
  g.close();
  process.exit(0);
})();
