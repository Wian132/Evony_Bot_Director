'use strict';
// script-net.js offline: which addresses a script may reach (get, post), every
// way of writing a forbidden one, name lookups (stubbed) that point home, and
// the real fetch path against a server on this machine's loopback — which must
// never be reached unless allowPrivate says so.
const assert = require('assert');
const http = require('http');
const N = require('./script-net');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);
const refused = (f, re = /this machine or its own network|not an address on the public internet/) => {
  let err = null;
  try { f(); } catch (e) { err = e; }
  assert.ok(err, 'not refused');
  assert.match(err.message, re);
};
const rejects = async (p, re) => {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert.ok(err, 'not refused');
  if (re) assert.match(err.message, re);
  return err;
};

// A lookup that answers `map[host]` (a list), in dns.lookup's callback shape.
const cbLookup = (map) => (host, opts, cb) => {
  const list = (map[host] || []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  if (!list.length) { const e = new Error('getaddrinfo ENOTFOUND ' + host); e.code = 'ENOTFOUND'; setImmediate(() => cb(e)); return; }
  setImmediate(() => (opts && opts.all ? cb(null, list) : cb(null, list[0].address, list[0].family)));
};
// ... and in dns.promises.lookup's shape.
const promiseLookup = (map) => async (host, opts) => {
  const list = (map[host] || []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  if (!list.length) throw Object.assign(new Error('ENOTFOUND ' + host), { code: 'ENOTFOUND' });
  return opts && opts.all ? list : list[0];
};

// ---------------------------------------------------------------------------
section('addressKind: only global unicast is global');

t('IPv4: every non-global range, and the edges beside them', () => {
  const want = {
    '8.8.8.8': 'global', '1.1.1.1': 'global', '0.0.0.0': 'blocked', '0.255.1.1': 'blocked',
    '10.0.0.1': 'private', '100.64.0.1': 'private', '100.127.255.255': 'private', '100.128.0.1': 'global', '100.63.255.255': 'global',
    '127.0.0.1': 'private', '127.255.255.254': 'private', '169.254.169.254': 'blocked', '169.253.1.1': 'global',
    '172.15.255.255': 'global', '172.16.0.1': 'private', '172.31.255.255': 'private', '172.32.0.1': 'global',
    '192.0.0.8': 'blocked', '192.0.2.1': 'blocked', '192.88.99.1': 'blocked', '192.168.1.5': 'private', '192.169.0.1': 'global',
    '198.18.0.1': 'blocked', '198.19.255.255': 'blocked', '198.20.0.1': 'global', '198.51.100.7': 'blocked', '203.0.113.9': 'blocked',
    '224.0.0.1': 'blocked', '239.255.255.250': 'blocked', '240.0.0.1': 'blocked', '255.255.255.255': 'blocked', '223.255.255.254': 'global',
  };
  for (const [ip, kind] of Object.entries(want)) eq(N.addressKind(ip), kind, ip);
});

t('IPv6 carrying IPv4, in every textual form: mapped, compatible, translated, NAT64, 6to4', () => {
  const home = ['::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:7F00:0001', '0:0:0:0:0:ffff:127.0.0.1', '0000:0000:0000:0000:0000:ffff:7f00:0001',
    '[::ffff:127.0.0.1]', '::ffff:10.0.0.1', '::ffff:a00:1', '::127.0.0.1', '::7f00:1', '::ffff:0:127.0.0.1', '::ffff:0:7f00:1',
    '64:ff9b::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::a00:1', '2002:7f00:1::', '2002:7f00:0001:0:0:0:0:1', '2002:c0a8:105::1'];
  for (const ip of home) eq(N.addressKind(ip), 'private', ip);
  const never = ['::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::', '::ffff:0.0.0.0', '::ffff:224.0.0.1', '::2'];
  for (const ip of never) eq(N.addressKind(ip), 'blocked', ip);
  for (const ip of ['::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1']) eq(N.addressKind(ip), 'global', ip);
});

t('IPv6: loopback, link-local, unique local, multicast, documentation, Teredo, unspecified', () => {
  const want = {
    '::1': 'private', '0:0:0:0:0:0:0:1': 'private', '::': 'blocked', 'fe80::1': 'blocked', 'fe80::1%eth0': 'blocked', 'febf::1': 'blocked',
    'fec0::1': 'blocked', 'fc00::1': 'private', 'fdff:ffff::1': 'private', 'ff02::1': 'blocked', 'ff0e::1': 'blocked',
    '2001:db8::1': 'blocked', '3fff::1': 'blocked', '2001::1': 'blocked', '2001:0:4136:e378:8000:63bf:3fff:fdd2': 'blocked',
    '2001:2::1': 'blocked', '2001:10::1': 'blocked', '64:ff9b:1::1': 'blocked', '100::1': 'blocked', '5f00::1': 'blocked',
    '2606:4700:4700::1111': 'global', '2a00:1450:4001:80b::200e': 'global', '2001:4860:4860::8888': 'global',
  };
  for (const [ip, kind] of Object.entries(want)) eq(N.addressKind(ip), kind, ip);
  eq([N.addressKind('example.com'), N.addressKind(''), N.addressKind('1.2.3'), N.addressKind('::ffff:1.2.3.999')], [null, null, null, null]);
});

// ---------------------------------------------------------------------------
section('checkUrl');

t('the forms the security review used, and IPv4 written in decimal, octal, hex and short', () => {
  for (const u of ['http://[::ffff:127.0.0.1]:8711/x', 'http://[::ffff:7f00:1]/', 'http://[::ffff:169.254.169.254]/latest/meta-data',
    'http://[::ffff:10.0.0.1]/', 'http://[0:0:0:0:0:ffff:127.0.0.1]/', 'http://[::127.0.0.1]/', 'http://[64:ff9b::7f00:1]/',
    'http://[2002:7f00:1::]/', 'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', 'http://[::]/', 'http://[::1]:8711/', 'http://[fe80::1]/',
    'http://[fd00::1]/', 'http://[ff02::1]/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f.0.0.1/', 'http://0x7f.1/', 'http://127.1/',
    'http://127.0.0.1./', 'http://017700000001/', 'http://0x7f000001/', 'http://3232235777/', 'http://0xa9.0xfe.0xa9.0xfe/', 'http://0/',
    'http://localhost:8711/', 'http://LOCALHOST./', 'http://api.localhost/', 'https://169.254.169.254/']) {
    refused(() => N.checkUrl(u));
  }
});

t('public addresses and names pass; other schemes and user:password@ do not', () => {
  eq(N.checkUrl('http://battle1.evony.com/logfile/a.xml').hostname, 'battle1.evony.com');
  eq(N.checkUrl('https://8.8.8.8/x').hostname, '8.8.8.8');
  eq(N.checkUrl('https://[2606:4700:4700::1111]/').hostname, '[2606:4700:4700::1111]');
  eq(N.checkUrl('http://[::ffff:8.8.8.8]/').hostname, '[::ffff:808:808]');
  refused(() => N.checkUrl('ftp://example.com/a'), /only http:\/\/ and https:\/\//);
  refused(() => N.checkUrl('file:///C:/Windows/win.ini'), /only http:\/\/ and https:\/\//);
  refused(() => N.checkUrl('http://me:pw@example.com/'), /no user:password@/);
  refused(() => N.checkUrl('not a url'), /not a web address/);
});

t('allowPrivate lets loopback and the private networks through, never link-local or the rest', () => {
  const p = { allowPrivate: true };
  for (const u of ['http://127.0.0.1:8080/', 'http://localhost:8080/', 'http://[::1]/', 'http://10.0.0.1/', 'http://[::ffff:192.168.1.5]/', 'http://[fd00::1]/']) {
    assert.ok(N.checkUrl(u, p), u);
  }
  for (const u of ['http://169.254.169.254/', 'http://[::ffff:a9fe:a9fe]/', 'http://0.0.0.0/', 'http://[::]/', 'http://[fe80::1]/', 'http://224.0.0.1/', 'http://[2001:db8::1]/']) {
    refused(() => N.checkUrl(u, p), /not an address on the public internet/);
  }
});

// ---------------------------------------------------------------------------
section('names that point home (stubbed lookups)');

const MAP = {
  'evil.test': ['127.0.0.1'], 'mapped.test': ['::ffff:7f00:1'], 'meta.test': ['169.254.169.254'], 'lan.test': ['192.168.1.5'],
  'mixed.test': ['8.8.8.8', '10.0.0.1'], 'nat64.test': ['64:ff9b::a9fe:a9fe'], 'good.test': ['8.8.8.8', '2606:4700:4700::1111'],
};

t('safeLookup refuses a name if any answer does not pass, in both lookup shapes', async () => {
  for (const shape of [cbLookup, promiseLookup]) {
    const look = N.safeLookup({ lookup: shape(MAP) });
    const ask = (host, opts) => new Promise((resolve) => look(host, opts, (e, a, f) => resolve({ e, a, f })));
    for (const host of ['evil.test', 'mapped.test', 'meta.test', 'lan.test', 'mixed.test', 'nat64.test']) {
      const r = await ask(host, { all: true });
      assert.ok(r.e, `${host} passed`);
      assert.match(r.e.message, new RegExp(`^${host.replace('.', '\\.')} is at `));
    }
    const all = await ask('good.test', { all: true });
    eq([all.e, all.a.map((x) => x.address)], [null, ['8.8.8.8', '2606:4700:4700::1111']]);
    const one = await ask('good.test', {});
    eq([one.e, one.a, one.f], [null, '8.8.8.8', 4]);
    assert.match((await ask('nowhere.test', {})).e.message, /ENOTFOUND/);
  }
  const lanOk = N.safeLookup({ lookup: cbLookup(MAP), allowPrivate: true });
  const r = await new Promise((resolve) => lanOk('lan.test', {}, (e, a) => resolve({ e, a })));
  eq([r.e, r.a], [null, '192.168.1.5']);
});

t('resolveUrl: checkUrl plus a lookup now', async () => {
  eq((await N.resolveUrl('http://good.test/x', { lookup: promiseLookup(MAP) })).addresses, ['8.8.8.8', '2606:4700:4700::1111']);
  await rejects(N.resolveUrl('http://evil.test/x', { lookup: promiseLookup(MAP) }), /evil\.test is at 127\.0\.0\.1/);
  await rejects(N.resolveUrl('http://[::ffff:7f00:1]/'), /this machine/);
});

// ---------------------------------------------------------------------------
section('safeFetch against a server on this machine\'s loopback');

let srv = null, port = 0;
const hits = [];
async function server() {
  if (srv) return;
  srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, body });
      if (req.url === '/big') { res.end('x'.repeat(5000)); return; }
      if (req.url === '/slow') { setTimeout(() => res.end('late'), 1500); return; }
      if (req.url === '/to-meta') { res.writeHead(302, { location: 'http://[::ffff:169.254.169.254]/latest/meta-data' }); res.end(); return; }
      if (req.url === '/to-lan') { res.writeHead(302, { location: 'http://lan.test:' + port + '/secret' }); res.end(); return; }
      if (req.url === '/to-local') { res.writeHead(301, { location: '/secret' }); res.end(); return; }
      res.end(`SECRET ${req.method} ${req.url}${body ? ' ' + body : ''}`);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
}

t('none of the bypass forms reaches the server', async () => {
  await server();
  hits.length = 0;
  for (const h of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:127.0.0.1]', '[::127.0.0.1]', '[64:ff9b::7f00:1]',
    '2130706433', '0177.0.0.1', '0x7f.1', '127.1', '127.0.0.1', 'localhost']) {
    await rejects(N.safeFetch(`http://${h}:${port}/x`), /this machine or its own network/);
  }
  for (const host of ['evil.test', 'mapped.test']) {
    await rejects(N.safeFetch(`http://${host}:${port}/x`, { lookup: cbLookup(MAP) }), /is at .* this machine or its own network/);
  }
  eq(hits, [], 'the loopback server saw nothing');
});

t('the lookup is used at connect time: a stubbed name reaches the loopback server only with allowPrivate', async () => {
  await server();
  hits.length = 0;
  const r = await N.safeFetch(`http://files.test:${port}/page?a=1`, { allowPrivate: true, lookup: cbLookup({ 'files.test': ['127.0.0.1'] }) });
  eq([r.status, r.text, hits.length], [200, 'SECRET GET /page?a=1', 1]);
  await rejects(N.safeFetch(`http://files.test:${port}/page`, { lookup: cbLookup({ 'files.test': ['127.0.0.1'] }) }), /files\.test is at 127\.0\.0\.1/);
  eq(hits.length, 1);
});

t('every redirect is checked again: to a forbidden address it stops, even with allowPrivate', async () => {
  await server();
  const p = { allowPrivate: true, lookup: cbLookup({ 'files.test': ['127.0.0.1'], 'lan.test': ['192.168.1.5'] }) };
  await rejects(N.safeFetch(`http://files.test:${port}/to-meta`, p), /not an address on the public internet/);
  const ok = await N.safeFetch(`http://files.test:${port}/to-local`, p);
  eq([ok.status, ok.text], [200, 'SECRET GET /secret']);
  await rejects(N.safeFetch(`http://files.test:${port}/to-lan`, { lookup: p.lookup, allowPrivate: false }), /this machine/);
  const none = await N.safeFetch(`http://files.test:${port}/to-local`, { ...p, redirects: 0 });
  eq([none.status, none.headers.location], [301, '/secret'], 'no redirects left: the 3xx comes back');
});

t('POST sends its body and does not follow a redirect; size cap, truncation and the deadline', async () => {
  await server();
  const p = { allowPrivate: true, lookup: cbLookup({ 'files.test': ['127.0.0.1'] }) };
  const posted = await N.safeFetch(`http://files.test:${port}/hook`, { ...p, method: 'POST', body: '{"msg":"hi"}', headers: { 'Content-Type': 'application/json' } });
  eq([posted.status, posted.text], [200, 'SECRET POST /hook {"msg":"hi"}']);
  const moved = await N.safeFetch(`http://files.test:${port}/to-local`, { ...p, method: 'POST', body: 'x' });
  eq(moved.status, 301);
  await rejects(N.safeFetch(`http://files.test:${port}/big`, { ...p, maxBytes: 1000 }), /sent more than 1 KB — too big/);
  const cut = await N.safeFetch(`http://files.test:${port}/big`, { ...p, maxBytes: 1000, truncate: true });
  eq(cut.text.length, 1000);
  await rejects(N.safeFetch(`http://files.test:${port}/slow`, { ...p, timeoutMs: 200 }), /did not answer within 200 ms/);
});

// ---------------------------------------------------------------------------
(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n + '\n'); continue; }
    try { await f(); console.log('  ok    ' + n); pass++; } catch (e) { console.log('  FAIL  ' + n + '\n        ' + String(e.message).split('\n').join('\n        ')); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (srv) srv.close();
  process.exit(fail ? 1 : 0);
})();
