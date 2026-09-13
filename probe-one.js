'use strict';
// Single connection attempt, verbose about what happens. No login, no game commands.
const net = require('net');
const t0 = Date.now();
const s = net.connect({ host: '216.66.17.119', port: 443 });
s.on('connect', () => {
  console.log(`connect OK after ${Date.now() - t0}ms — sending policy request`);
  s.write(Buffer.from('<policy-file-request/>\0', 'binary'));
});
s.on('data', (d) => { console.log(`reply after ${Date.now() - t0}ms: ${d.length} bytes`); s.destroy(); process.exit(0); });
s.on('error', (e) => { console.log(`ERROR after ${Date.now() - t0}ms: ${e.code} ${e.message}`); process.exit(0); });
s.on('close', () => { console.log(`closed after ${Date.now() - t0}ms (no reply)`); process.exit(0); });
setTimeout(() => { console.log('timeout after 10s, still open, no reply'); process.exit(0); }, 10000);
