'use strict';
// Feasibility probe: connect -> version handshake -> login -> dump what the server sends.
const fs = require('fs');
const path = require('path');
const { EvonyClient, getServerConfig } = require('./evony');

function loadEnv() {
  const p = path.join(__dirname, '.env');
  const out = {};
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  }
  return out;
}

function preview(v, depth = 0) {
  if (v === null || v === undefined) return String(v);
  if (typeof v !== 'object') return JSON.stringify(v);
  if (depth >= 2) return Array.isArray(v) ? `[${v.length} items]` : `{${Object.keys(v).slice(0, 8).join(',')}}`;
  if (Array.isArray(v)) return `[${v.length}] ` + v.slice(0, 3).map((x) => preview(x, depth + 1)).join(', ');
  const keys = Object.keys(v).slice(0, 12);
  return '{ ' + keys.map((k) => `${k}: ${preview(v[k], depth + 1)}`).join(', ') + (Object.keys(v).length > keys.length ? ', …' : '') + ' }';
}

(async () => {
  const env = loadEnv();
  const server = env.EVONY_SERVER || 'ss71';
  const email = env.EVONY_EMAIL;
  const password = env.EVONY_PASSWORD;
  if (!email || !password) { console.error('Set EVONY_EMAIL / EVONY_PASSWORD in C:\\EvonyTool\\.env'); process.exit(1); }

  const cfg = await getServerConfig(server);
  console.log(`[cfg] ${server} -> ${cfg.host}:${cfg.port}  state=${cfg.state}`);

  const c = new EvonyClient();
  c.on('log', (m) => console.log('[net] ' + m));

  const seen = new Map();
  c.on('cmd', (cmd, data) => {
    seen.set(cmd, (seen.get(cmd) || 0) + 1);
    if (seen.get(cmd) === 1) console.log(`[<- ${cmd}] ${preview(data)}`.slice(0, 400));
  });

  await c.connect(cfg.host, cfg.port);

  try {
    const resp = await c.login(email, password);
    console.log('\n=== LOGIN RESPONSE ===');
    console.log(JSON.stringify(resp, null, 2).slice(0, 3000));
  } catch (e) {
    console.log('\n!!! login: ' + e.message);
  }

  console.log('\n[listening 15s for pushed frames…]');
  setTimeout(() => {
    console.log('\n=== COMMANDS SEEN ===');
    for (const [cmd, n] of [...seen.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(4)}  ${cmd}`);
    c.close();
    process.exit(0);
  }, 15000);
})();
