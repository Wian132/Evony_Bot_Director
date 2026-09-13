'use strict';
// Live check of the report-cleaning path (trade reports from the trade tests).
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

  const before = await g.reportList('trade', 1, 50);
  console.log(`\ntrade reports before: ${(before.reports || []).length} (totalPage ${before.totalPage})`);
  if ((before.reports || []).length) console.log('  sample: ' + JSON.stringify(before.reports[0]).slice(0, 200));

  const n = await g.cleanReports('trade');
  const after = await g.reportList('trade', 1, 50);
  console.log(`\ndeleted ${n}; trade reports after: ${(after.reports || []).length}`);

  g.close();
  process.exit(0);
})();
