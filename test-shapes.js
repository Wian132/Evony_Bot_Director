'use strict';
// The server drops the connection on a malformed payload, so每 shape needs a fresh login.
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

const env = loadEnv();
const NAME = process.env.TARGET || 'Eldians Demons';

async function attempt(cmd, payload, label) {
  const cfg = await getServerConfig(env.EVONY_SERVER || 'ss71');
  const c = new EvonyClient();
  let dropped = false;
  c.on('log', (m) => { if (/closed|error/.test(m)) dropped = true; });
  await c.connect(cfg.host, cfg.port);
  const lr = await c.login(env.EVONY_EMAIL, env.EVONY_PASSWORD);
  if (!lr || lr.data.ok !== 1) { console.log(`  ${label}: login failed`); c.close(); return null; }

  c.send(cmd, payload);
  let result = null;
  try {
    const r = await c.await([cmd, '_resp_' + cmd.replace(/\./g, '_'), 'server.ErrorMsgResponse'], 7000);
    result = r;
    console.log(`  ${label}: ANSWERED as "${r.cmd}"`);
    console.log('     ' + JSON.stringify(r.data).slice(0, 700));
  } catch (e) {
    console.log(`  ${label}: ${dropped ? 'REJECTED (socket dropped)' : 'no reply (still connected)'}`);
  }
  c.close();
  await new Promise((r) => setTimeout(r, 600));
  return result;
}

(async () => {
  console.log(`Probing common.getPlayerInfoByName for "${NAME}"\n`);
  const shapes = [
    ['{name}', { name: NAME }],
    ['{playerName}', { playerName: NAME }],
    ['{userName}', { userName: NAME }],
    ['{accountName}', { accountName: NAME }],
    ['{nickName}', { nickName: NAME }],
  ];
  for (const [label, payload] of shapes) {
    const r = await attempt('common.getPlayerInfoByName', payload, label);
    if (r && r.data && (r.data.ok === 1 || r.data.ok === undefined)) { console.log('\n>>> WORKING SHAPE: ' + label); break; }
  }
  process.exit(0);
})();
