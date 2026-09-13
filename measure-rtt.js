'use strict';
// Safe latency measurement: TCP connect + Flash policy request (no login, no game commands).
const net = require('net');

const HOST = '216.66.17.119', PORT = 443, N = 30;

function once() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let tConn = null;
    const s = net.connect({ host: HOST, port: PORT });
    s.on('connect', () => {
      tConn = process.hrtime.bigint();
      s.write(Buffer.from('<policy-file-request/>\0', 'binary'));
    });
    s.on('data', () => {
      const t2 = process.hrtime.bigint();
      s.destroy();
      resolve({
        connect: Number(tConn - t0) / 1e6,
        rtt: Number(t2 - tConn) / 1e6,
      });
    });
    s.on('error', (e) => { s.destroy(); resolve({ err: e.code || e.message }); });
    s.on('close', () => resolve({ err: 'closed-without-reply' }));
    setTimeout(() => { s.destroy(); resolve({ err: 'timeout' }); }, 8000);
  });
}

const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];

(async () => {
  const conn = [], rtt = [], fails = {};
  for (let i = 0; i < N; i++) {
    const r = await once();
    if (r && r.rtt !== undefined) { conn.push(r.connect); rtt.push(r.rtt); }
    else { const k = (r && r.err) || 'unknown'; fails[k] = (fails[k] || 0) + 1; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (Object.keys(fails).length) console.log('failures: ' + JSON.stringify(fails));
  conn.sort((a, b) => a - b); rtt.sort((a, b) => a - b);
  const f = (x) => x.toFixed(1).padStart(7);
  console.log(`samples: ${rtt.length}/${N}`);
  console.log('                 min    median      p95      max    jitter(p95-min)');
  console.log(`TCP connect  ${f(conn[0])}  ${f(pct(conn, 0.5))}  ${f(pct(conn, 0.95))}  ${f(conn[conn.length - 1])}   ${f(pct(conn, 0.95) - conn[0])}  ms`);
  console.log(`app RTT      ${f(rtt[0])}  ${f(pct(rtt, 0.5))}  ${f(pct(rtt, 0.95))}  ${f(rtt[rtt.length - 1])}   ${f(pct(rtt, 0.95) - rtt[0])}  ms`);
})();
