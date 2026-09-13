'use strict';
// Measure real request->response latency from captured traffic (the bot's own commands).
// Export: tshark -r cap.pcap -T fields -e tcp.stream -e tcp.dstport -e frame.time_epoch -e tcp.payload -Y tcp.payload
const fs = require('fs');
const amf3 = require('./amf3');

const lines = fs.readFileSync(process.argv[2] || 'payloads_t.txt', 'utf8').split(/\r?\n/).filter(Boolean);

// per stream+direction: chunks with timestamps
const parts = new Map();
for (const line of lines) {
  const [stream, dstport, ts, payload] = line.split('\t');
  if (!payload) continue;
  const key = `${stream}/${dstport === '443' ? 'up' : 'down'}`;
  if (!parts.has(key)) parts.set(key, []);
  parts.get(key).push({ buf: Buffer.from(payload.replace(/:/g, ''), 'hex'), ts: parseFloat(ts) });
}

function build(chunks) {
  const buf = Buffer.concat(chunks.map((c) => c.buf));
  const stamps = new Array(buf.length);
  let o = 0;
  for (const c of chunks) { for (let i = 0; i < c.buf.length; i++) stamps[o + i] = c.ts; o += c.buf.length; }
  return { buf, stamps };
}

function framesFrom(buf, stamps, off) {
  const out = [];
  let p = off;
  while (p + 4 <= buf.length) {
    const len = buf.readUInt32BE(p);
    if (len === 0 || len > 2 * 1024 * 1024 || p + 4 + len > buf.length) break;
    let msg;
    try { msg = amf3.decode(buf.subarray(p + 4, p + 4 + len)); } catch { break; }
    if (!msg || typeof msg.cmd !== 'string') break;
    out.push({ cmd: msg.cmd, ts: stamps[p + 4 + len - 1] });
    p += 4 + len;
  }
  return out;
}

function best(buf, stamps) {
  let b = [];
  const lim = Math.min(buf.length, 200000);
  for (let off = 0; off < lim; off++) {
    const f = framesFrom(buf, stamps, off);
    if (f.length > b.length) { b = f; if (f.length > 40) break; }
  }
  return b;
}

const streams = new Set([...parts.keys()].map((k) => k.split('/')[0]));
const pairs = [];
const sendGaps = [];

for (const s of streams) {
  const up = parts.get(`${s}/up`), down = parts.get(`${s}/down`);
  if (!up || !down) continue;
  const U = build(up), D = build(down);
  const uf = best(U.buf, U.stamps), df = best(D.buf, D.stamps);
  if (!uf.length || !df.length) continue;

  // consecutive client sends on one socket -> how fast does the real bot push commands?
  for (let i = 1; i < uf.length; i++) sendGaps.push((uf[i].ts - uf[i - 1].ts) * 1000);

  // pair each request with the next response bearing the same cmd
  const used = new Set();
  for (const req of uf) {
    const match = df.findIndex((r, i) => !used.has(i) && r.cmd === req.cmd && r.ts >= req.ts);
    if (match >= 0) { used.add(match); pairs.push({ cmd: req.cmd, ms: (df[match].ts - req.ts) * 1000 }); }
  }
}

const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
const lat = pairs.map((p) => p.ms).filter((x) => x >= 0 && x < 30000).sort((a, b) => a - b);

console.log(`matched ${lat.length} request/response pairs from the live bot\n`);
if (lat.length) {
  console.log('IN-GAME COMMAND LATENCY (real client, your connection)');
  console.log(`  min ${lat[0].toFixed(1)}   median ${pct(lat, 0.5).toFixed(1)}   p95 ${pct(lat, 0.95).toFixed(1)}   max ${lat[lat.length - 1].toFixed(1)}  ms`);
  console.log(`  jitter (p95 - min): ${(pct(lat, 0.95) - lat[0]).toFixed(1)} ms`);
}
const g = sendGaps.filter((x) => x > 0).sort((a, b) => a - b);
if (g.length) {
  console.log('\nGAP BETWEEN CONSECUTIVE COMMANDS FROM THE BOT (its own pacing)');
  console.log(`  min ${g[0].toFixed(0)}   median ${pct(g, 0.5).toFixed(0)}   p95 ${pct(g, 0.95).toFixed(0)}  ms   (n=${g.length})`);
}
const byCmd = new Map();
for (const p of pairs) { if (!byCmd.has(p.cmd)) byCmd.set(p.cmd, []); byCmd.get(p.cmd).push(p.ms); }
console.log('\nPER-COMMAND MEDIAN');
for (const [cmd, arr] of [...byCmd.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
  arr.sort((a, b) => a - b);
  console.log(`  ${String(arr.length).padStart(3)}x  ${cmd.padEnd(42)} ${pct(arr, 0.5).toFixed(1)} ms`);
}
