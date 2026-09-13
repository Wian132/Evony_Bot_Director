'use strict';
// Decode Evony frames from captured traffic.
// Export with: tshark -r cap.pcap -T fields -e tcp.stream -e tcp.dstport -e tcp.payload -Y tcp.payload
// Handles: multiple concurrent connections, and a capture that started mid-stream (resyncs).
const fs = require('fs');
const amf3 = require('./amf3');

const lines = fs.readFileSync(process.argv[2] || 'payloads.txt', 'utf8').split(/\r?\n/).filter(Boolean);

const bufs = new Map();   // key: "<stream>/<up|down>"
for (const line of lines) {
  const [stream, dstport, payload] = line.split('\t');
  if (!payload) continue;
  const key = `${stream}/${dstport === '443' ? 'up' : 'down'}`;
  if (!bufs.has(key)) bufs.set(key, []);
  bufs.get(key).push(Buffer.from(payload.replace(/:/g, ''), 'hex'));
}

// Try to decode a run of frames starting at `off`; return how many parsed cleanly.
function tryFrom(buf, off) {
  let p = off, n = 0;
  const out = [];
  while (p + 4 <= buf.length) {
    const len = buf.readUInt32BE(p);
    if (len === 0 || len > 2 * 1024 * 1024) break;
    if (p + 4 + len > buf.length) break;
    try {
      const msg = amf3.decode(buf.subarray(p + 4, p + 4 + len));
      if (!msg || typeof msg !== 'object' || typeof msg.cmd !== 'string') break;
      out.push(msg);
    } catch { break; }
    p += 4 + len; n++;
  }
  return { n, out };
}

function resync(buf) {
  let best = { n: 0, out: [] };
  const limit = Math.min(buf.length, 200000);
  for (let off = 0; off < limit; off++) {
    const r = tryFrom(buf, off);
    if (r.n > best.n) { best = r; if (r.n > 40) break; }
  }
  return best;
}

const cmds = new Map(), samples = new Map();
let totalFrames = 0;

for (const [key, chunks] of bufs) {
  const buf = Buffer.concat(chunks);
  if (buf.length < 16) continue;
  const { n, out } = resync(buf);
  if (!n) { console.log(`${key}: ${buf.length} bytes, no frames recovered`); continue; }
  console.log(`${key}: ${buf.length} bytes -> ${n} frames`);
  totalFrames += n;
  for (const msg of out) {
    const dir = key.endsWith('up') ? '>' : '<';
    const tag = dir + ' ' + msg.cmd;
    cmds.set(tag, (cmds.get(tag) || 0) + 1);
    if (!samples.has(tag)) samples.set(tag, JSON.stringify(msg.data));
  }
}

console.log(`\n===== ${totalFrames} frames total =====`);
for (const [tag, n] of [...cmds.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`\n[${n}x] ${tag}`);
  const s = samples.get(tag);
  if (s) console.log('    ' + (s.length > 420 ? s.slice(0, 420) + ' …' : s));
}
