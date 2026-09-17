'use strict';
// `post` through script-net.js, offline, against a real server on this machine:
// every way of writing a local address is refused before anything reaches it,
// a name is checked again when the connection is made, and a console that
// allows local posts (postPrivate) really does post.
const assert = require('assert');
const http = require('http');
const { EventEmitter } = require('events');
const C = require('./constants');
const { Game } = require('./game');
const script = require('./script');

const tests = [];
const t = (n, f) => tests.push([n, f]);

let server, port, hits = [];
function world() {
  const g = new Game();
  g.player = { playerInfo: { userName: 'Botter', id: 777 }, items: [] };
  g.castles = [{ id: 1, name: 'MyCity', fieldId: C.coordsToFieldId(111, 222), heros: [], buildings: [] }];
  g.c = new EventEmitter();
  g.req = async () => ({ ok: 1 });
  return g;
}
async function run(src, opts = {}) {
  const kept = [], out = [];
  const view = script.parse(src, { globals: { keep: 1 } });
  const errs = view.filter((a) => a.cmd === 'error');
  if (errs.length) throw new Error('refused: ' + errs.map((e) => e.error).join('; '));
  await script.run(world(), view, (m) => out.push(m), {
    castle: 'MyCity', repeatGapMs: 0, postGapMs: 0, postTimeoutMs: 3000,
    globals: { keep: (v) => { kept.push(v); return v; } }, ...opts,
  });
  return { result: kept[0], error: kept[1], text: out.join('\n') };
}
const post = (url, opts) => run(`post "${url}" "hello"\nkeep($result)\nkeep($error)`, opts);

t('every way of writing this machine is refused, and nothing reaches the server', async () => {
  for (const host of [`127.0.0.1:${port}`, `[::ffff:127.0.0.1]:${port}`, `[::ffff:7f00:1]:${port}`, `2130706433:${port}`,
    `0x7f.1:${port}`, `127.1:${port}`, `[::1]:${port}`, `[64:ff9b::7f00:1]:${port}`, `localhost:${port}`]) {
    const r = await post(`http://${host}/x`, { postPrivate: false });
    assert.ok(r.error, `${host} was not refused: ${r.text}`);
  }
  assert.strictEqual(hits.length, 0);
});

t('metadata and link-local are refused even where local posts are allowed', async () => {
  for (const host of ['169.254.169.254', '[::ffff:169.254.169.254]', '[::ffff:a9fe:a9fe]', '[fe80::1]']) {
    const r = await post(`http://${host}/latest/meta-data/`, { postPrivate: true });
    assert.ok(r.error, `${host} was not refused`);
  }
});

t('a name is checked again at connect time: one that answers 127.0.0.1 is refused', async () => {
  // checkUrl's own lookup answers a public address; the connection's lookup answers loopback
  let n = 0;
  const lookup = (host, o, cb) => {
    n++;
    if (typeof o === 'function') cb = o;
    const addr = n === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }];
    if (o && o.all) cb(null, addr); else cb(null, addr[0].address, 4);
  };
  const promiseLookup = (host, o) => new Promise((res, rej) => lookup(host, o, (e, a) => (e ? rej(e) : res(a))));
  const r = await post(`http://rebind.example:${port}/x`, { postPrivate: false, dnsLookup: promiseLookup });
  assert.ok(r.error, r.text);
  assert.strictEqual(hits.length, 0);
});

t('a console that allows local posts reaches the local server, and $result is its answer', async () => {
  const r = await post(`http://127.0.0.1:${port}/hook`, { postPrivate: true });
  assert.strictEqual(r.error, null, r.text);
  assert.strictEqual(r.result, 'thanks');
  assert.deepStrictEqual(hits, [{ url: '/hook', body: 'hello' }]);
  hits = [];
});

t('a redirect is not followed', async () => {
  const r = await post(`http://127.0.0.1:${port}/moved`, { postPrivate: true });
  assert.match(String(r.error), /HTTP 302/);
});

(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ url: req.url, body });
      if (req.url === '/moved') { res.writeHead(302, { location: 'http://169.254.169.254/' }); res.end(); return; }
      res.end('thanks');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    hits = [];
    try { await fn(); pass++; console.log('  ok    ' + name); } catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n        ')); }
  }
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
