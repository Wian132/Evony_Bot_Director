'use strict';
// Round 2: try AMF3 encodings of the version frame.
const net = require('net');
const amf0 = require('./amf0');
const amf3 = require('./amf3');

const HOST = '216.66.17.119', PORT = 443;

function frame(payload) {
  const h = Buffer.alloc(4); h.writeUInt32BE(payload.length, 0);
  return Buffer.concat([h, payload]);
}
function hex(b) { return b.subarray(0, 160).toString('hex').replace(/(..)/g, '$1 ').trim(); }
function ascii(b) { return Array.from(b.subarray(0, 160)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join(''); }

function test(name, payload, waitMs = 7000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port: PORT });
    let got = Buffer.alloc(0), closed = false;
    const done = (why) => {
      if (closed) return; closed = true; s.destroy();
      console.log(`\n--- ${name}`);
      console.log(`    sent: ${hex(payload)}`);
      console.log(got.length ? `    GOT ${got.length} bytes:\n      hex: ${hex(got)}\n      txt: ${ascii(got)}` : `    nothing (${why})`);
      resolve(got);
    };
    s.on('connect', () => s.write(frame(payload)));
    s.on('data', (d) => { got = Buffer.concat([got, d]); });
    s.on('close', () => done('server closed'));
    s.on('error', (e) => done('err ' + e.message));
    setTimeout(() => done('timeout, still open'), waitMs);
  });
}

const msg = { cmd: 'gameClient.version', data: '091103_11' };

(async () => {
  await test('F: pure AMF3 object', amf3.encode(msg));
  await test('G: AMF0 avmplus marker 0x11 + AMF3', Buffer.concat([Buffer.from([0x11]), amf3.encode(msg)]));
  await test('H: AMF3 with data as object {version}', amf3.encode({ cmd: 'gameClient.version', data: { version: '091103_11' } }));
  await test('I: AMF0 object, no data key', amf0.encode({ cmd: 'gameClient.version' }));
  process.exit(0);
})();
