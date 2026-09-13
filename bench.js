'use strict';
// Throughput/latency benchmark. Read-only commands, ONE warm connection, ramped bursts.
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
const TARGET = 'WhoAreYou';
const LOOKUP = 'common.getPlayerInfoByName';
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];

(async () => {
  const cfg = await getServerConfig(env.EVONY_SERVER || 'ss71');
  const c = new EvonyClient();
  let alive = true;
  c.on('log', (m) => { if (/closed/.test(m)) { alive = false; console.log('!! socket closed: ' + m); } });

  await c.connect(cfg.host, cfg.port);
  const lr = await c.login(env.EVONY_EMAIL, env.EVONY_PASSWORD);
  if (!lr || lr.data.ok !== 1) { console.log('login failed'); process.exit(1); }
  console.log('logged in\n');

  // What time fields does the server give us? (for clock-offset work later)
  const tFields = JSON.stringify(lr.data).match(/"(\w*[Tt]ime\w*)":(\d{9,})/g);
  console.log('time-ish fields in LoginResponse: ' + (tFields ? tFields.slice(0, 6).join(', ') : 'none with epoch-looking values'));

  // ---------- Test A: sequential round trips ----------
  console.log('\n=== A: sequential command round-trip (n=10) ===');
  const seq = [];
  for (let i = 0; i < 10 && alive; i++) {
    const t0 = process.hrtime.bigint();
    c.send(LOOKUP, { userName: TARGET });
    try { await c.await([LOOKUP], 10000); seq.push(Number(process.hrtime.bigint() - t0) / 1e6); }
    catch (e) { console.log('  timeout at #' + i); break; }
  }
  seq.sort((a, b) => a - b);
  if (seq.length) console.log(`  min ${seq[0].toFixed(1)}  median ${pct(seq, 0.5).toFixed(1)}  p95 ${pct(seq, 0.95).toFixed(1)}  max ${seq[seq.length - 1].toFixed(1)} ms`);

  // ---------- Test B: pipelined bursts ----------
  console.log('\n=== B: pipelined burst (send N back-to-back, then await N replies) ===');
  for (const N of [2, 5, 10, 20]) {
    if (!alive) { console.log(`  N=${N}: skipped, socket dead`); break; }
    let got = 0, firstAt = null;
    const t0 = process.hrtime.bigint();
    const onCmd = (cmd) => { if (cmd === LOOKUP) { got++; if (firstAt === null) firstAt = Number(process.hrtime.bigint() - t0) / 1e6; } };
    c.on('cmd', onCmd);

    for (let i = 0; i < N; i++) c.send(LOOKUP, { userName: TARGET });
    const sentAt = Number(process.hrtime.bigint() - t0) / 1e6;

    const deadline = Date.now() + 15000;
    while (got < N && Date.now() < deadline && alive) await new Promise((r) => setTimeout(r, 5));
    const total = Number(process.hrtime.bigint() - t0) / 1e6;
    c.off('cmd', onCmd);

    const verdict = got === N ? 'ALL replied' : `only ${got}/${N}` + (alive ? '' : ' + DISCONNECTED');
    console.log(`  N=${String(N).padStart(2)}  write ${sentAt.toFixed(1)}ms  first reply ${firstAt === null ? '—' : firstAt.toFixed(1) + 'ms'}  all done ${total.toFixed(1)}ms  -> ${verdict}`);
    if (got === N) console.log(`         effective ${(N / (total / 1000)).toFixed(1)} commands/sec vs ${(1000 / pct(seq, 0.5)).toFixed(1)}/sec sequential`);
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log('\nsocket still alive: ' + alive);
  c.close();
  process.exit(0);
})();
