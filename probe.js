'use strict';
// Diagnostic matrix: figure out what the server actually expects on connect.
const net = require('net');
const amf = require('./amf0');

const HOST = '216.66.17.119', PORT = 443;

function hex(b) { return b.subarray(0, 120).toString('hex').replace(/(..)/g, '$1 ').trim(); }
function ascii(b) { return Array.from(b.subarray(0, 120)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join(''); }

function frame(payload) {
  const h = Buffer.alloc(4); h.writeUInt32BE(payload.length, 0);
  return Buffer.concat([h, payload]);
}

// AMF0 object (0x03) form -- what our encoder emits
function objForm(cmd, data) { return amf.encode({ cmd, data }); }

// AMF0 ECMA-array (0x08) form -- what some AMF libs emit for a dict/map
function ecmaForm(cmd, data) {
  const parts = [Buffer.from([0x08])];
  const n = Buffer.alloc(4); n.writeUInt32BE(2, 0); parts.push(n);
  const key = (s) => { const b = Buffer.from(s, 'utf8'); const h = Buffer.alloc(2); h.writeUInt16BE(b.length, 0); return Buffer.concat([h, b]); };
  parts.push(key('cmd'), amf.encode(cmd));
  parts.push(key('data'), amf.encode(data));
  parts.push(Buffer.from([0x00, 0x00, 0x09]));
  return Buffer.concat(parts);
}

function test(name, sendFn, waitMs = 6000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port: PORT });
    let got = Buffer.alloc(0);
    let closed = false;
    const done = (why) => {
      if (closed) return; closed = true;
      s.destroy();
      const verdict = got.length ? `RECEIVED ${got.length} bytes` : `nothing (${why})`;
      console.log(`\n--- ${name}: ${verdict}`);
      if (got.length) { console.log('    hex: ' + hex(got)); console.log('    txt: ' + ascii(got)); }
      resolve(got);
    };
    s.on('connect', () => { try { sendFn(s); } catch (e) { console.log('send error ' + e.message); } });
    s.on('data', (d) => { got = Buffer.concat([got, d]); });
    s.on('close', () => done('server closed'));
    s.on('error', (e) => done('err ' + e.message));
    setTimeout(() => done('timeout, still open'), waitMs);
  });
}

(async () => {
  await test('A: connect, send nothing', () => {});
  await test('B: flash policy request', (s) => s.write(Buffer.from('<policy-file-request/>\0', 'binary')));
  await test('C: version frame, AMF0 object(0x03)', (s) => s.write(frame(objForm('gameClient.version', '091103_11'))));
  await test('D: version frame, AMF0 ecma-array(0x08)', (s) => s.write(frame(ecmaForm('gameClient.version', '091103_11'))));
  await test('E: policy then version frame', (s) => {
    s.write(Buffer.from('<policy-file-request/>\0', 'binary'));
    setTimeout(() => s.write(frame(objForm('gameClient.version', '091103_11'))), 800);
  }, 8000);
  process.exit(0);
})();
