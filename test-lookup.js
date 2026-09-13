'use strict';
// Verify common.getPlayerInfoByName -- try a few payload shapes until one answers.
const fs = require('fs');
const path = require('path');
const { EvonyClient, getServerConfig } = require('./evony');

function loadEnv() {
  const out = {};
  const p = path.join(__dirname, '.env');
  if (fs.existsSync(p)) for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2];
  }
  return out;
}

const NAME = process.argv[2] || 'Eldians Demons';

(async () => {
  const env = loadEnv();
  const cfg = await getServerConfig(env.EVONY_SERVER || 'ss71');
  const c = new EvonyClient();
  c.on('log', (m) => console.log('[net] ' + m));
  c.on('cmd', (cmd, data) => {
    if (cmd === 'server.SystemInfoMsg') return;
    console.log(`[<- ${cmd}] ` + JSON.stringify(data).slice(0, 900));
  });

  await c.connect(cfg.host, cfg.port);
  const login = await c.login(env.EVONY_EMAIL, env.EVONY_PASSWORD);
  console.log('login ok=' + login.data.ok + '  player=' + (login.data.player && login.data.player.playerInfo && login.data.player.playerInfo.accountName));

  const shapes = [
    ['string', NAME],
    ['{name}', { name: NAME }],
    ['{playerName}', { playerName: NAME }],
    ['{userName}', { userName: NAME }],
  ];

  for (const [label, payload] of shapes) {
    console.log(`\n>>> common.getPlayerInfoByName as ${label}`);
    c.send('common.getPlayerInfoByName', payload);
    try {
      const r = await c.await(['common.getPlayerInfoByName', 'server.PlayerInfoResponse', 'server.ErrorMsgResponse', 'server.ErrorResponse'], 6000);
      console.log('    ANSWER: ' + JSON.stringify(r.data).slice(0, 600));
      break;
    } catch (e) { console.log('    (no reply)'); }
  }

  setTimeout(() => { c.close(); process.exit(0); }, 1500);
})();
