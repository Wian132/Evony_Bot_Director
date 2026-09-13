'use strict';
// How large a map rectangle will the server return in one call?
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

  for (const size of [10, 20, 40, 80, 160, 400]) {
    const rect = { x1: 0, y1: 0, x2: size - 1, y2: size - 1 };
    const t0 = Date.now();
    g.c.send('common.mapInfoSimple', rect);
    try {
      const r = await g.c.await(['common.mapInfoSimple'], 20000);
      const n = (r.data.castles || []).length;
      const bytes = JSON.stringify(r.data).length;
      const got = { x1: r.data.x1, y1: r.data.y1, x2: r.data.x2, y2: r.data.y2 };
      const clamped = got.x2 !== rect.x2 || got.y2 !== rect.y2;
      console.log(`${String(size).padStart(3)}x${String(size).padEnd(3)} (${String(size * size).padStart(6)} tiles)  ${String(Date.now() - t0).padStart(5)}ms  castles ${String(n).padStart(4)}  ${String(bytes).padStart(7)} bytes  echoed ${JSON.stringify(got)}${clamped ? '  <- CLAMPED' : ''}`);
    } catch (e) { console.log(`${size}x${size}: ${e.message}`); }
    await new Promise((r) => setTimeout(r, 400));
  }
  g.close();
  process.exit(0);
})();
