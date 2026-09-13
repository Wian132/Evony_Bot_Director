'use strict';
// Connect, send ONLY gameClient.version, and report anything that comes back.
// No credentials are sent, so this costs no login at all.
//
// If the version handshake gets a reply, the socket and our framing are fine and
// whatever is blocking us happens at the login/account layer. If nothing comes
// back, we are being ignored at the connection layer.
const { EvonyClient, getServerConfig } = require('./evony');

(async () => {
  const cfg = await getServerConfig(process.argv[2] || 'ss71');
  console.log(`  ${cfg.host}:${cfg.port}  ServerState=${cfg.state}`);

  const c = new EvonyClient();
  const seen = [];
  c.on('cmd', (cmd, data) => {
    seen.push(cmd);
    const s = JSON.stringify(data);
    console.log(`  <- ${cmd}  ${s === undefined ? '' : s.slice(0, 160)}`);
  });
  c.on('log', (m) => { if (/closed|error/i.test(m)) console.log('  !! ' + m); });

  const t0 = Date.now();
  await c.connect(cfg.host, cfg.port);
  console.log(`  connected in ${Date.now() - t0}ms`);
  c.send('gameClient.version', '091103_11');
  console.log('  -> gameClient.version (no credentials sent)');

  await new Promise((r) => setTimeout(r, 15000));
  console.log(`\n  frames received in 15s: ${seen.length}${seen.length ? ' -> ' + seen.join(', ') : '  (silence)'}`);
  try { c.close(); } catch {}
  process.exit(0);
})().catch((e) => { console.log('  ERROR ' + e.message); process.exit(1); });
