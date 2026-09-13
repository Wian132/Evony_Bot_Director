'use strict';
// Listen for chat pushes and dump their exact shape.
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
  const seen = {};
  await g.connect(env.EVONY_SERVER, env.EVONY_EMAIL, env.EVONY_PASSWORD);

  g.c.on('cmd', (cmd, data) => {
    if (!/chat|Chat|Msg|msg/i.test(cmd)) return;
    seen[cmd] = (seen[cmd] || 0) + 1;
    if (seen[cmd] <= 2) console.log(`[${cmd}] ` + JSON.stringify(data).slice(0, 420));
  });

  // send one world message and watch whether it comes back to us
  const stamp = 'ping ' + new Date().toLocaleTimeString();
  console.log(`sending world chat: "${stamp}"`);
  try {
    const r = await g.req('common.worldChat', { msg: stamp, languageType: 0 }, 8000);
    console.log('send result: ' + JSON.stringify(r));
  } catch (e) { console.log('send: no direct reply (' + e.message + ')'); }

  console.log('listening 30s…\n');
  setTimeout(() => {
    console.log('\n=== chat-ish frames seen ===');
    for (const [k, v] of Object.entries(seen)) console.log(`  ${v} x ${k}`);
    if (!Object.keys(seen).length) console.log('  (none)');
    g.close(); process.exit(0);
  }, 30000);
})();
