'use strict';
// console-proxy.js: an account's console reached through the Director at
// /console/<id>/. A stand-in console on a free port plays the real one; nothing
// here logs in or opens evony.db.
const assert = require('assert');
const http = require('http');
const vm = require('vm');
const CP = require('./console-proxy');

let passed = 0, failed = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/reportview.css"><script src="/reportview.js"></script>
<link rel="preconnect" href="//cdn.example.com"></head>
<body><a href="/report?log=1">log</a><a href="https://example.com/x">out</a>
<form method="POST" action='/login'></form><script>fetch('/api/state')</script></body></html>`;

// the stand-in console
const seen = [];
const fake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: b });
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
    if (req.url === '/go') { res.writeHead(302, { Location: '/login' }); return res.end(); }
    if (req.url === '/away') { res.writeHead(302, { Location: 'https://example.com/' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, url: req.url, body: b }));
  });
});

// a Director in miniature: only the /console/ route
let consolePort = 0;
const front = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const cp = CP.parse(url.pathname);
  if (!cp) { res.writeHead(404); return res.end(); }
  const port = cp.id === 'dead' ? 1 : consolePort;
  CP.pass(req, res, { port, prefix: '/console/' + cp.id, rest: cp.rest, search: url.search });
});

function request(port, method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

let FP = 0;

t('parse: the account and the rest of the path', () => {
  assert.deepStrictEqual(CP.parse('/console/a5/api/state'), { id: 'a5', rest: '/api/state' });
  assert.deepStrictEqual(CP.parse('/console/a5/'), { id: 'a5', rest: '/' });
  assert.deepStrictEqual(CP.parse('/console/a5'), { id: 'a5', rest: '' });
  assert.strictEqual(CP.parse('/api/accounts'), null);
  assert.strictEqual(CP.parse('/console/../etc'), null, 'no dots in an account id');
});

t('prefixPath: only our own absolute paths, once', () => {
  const P = '/console/a5';
  assert.strictEqual(CP.prefixPath(P, '/api/x?y=1'), '/console/a5/api/x?y=1');
  assert.strictEqual(CP.prefixPath(P, '/console/a5/api/x'), '/console/a5/api/x');
  assert.strictEqual(CP.prefixPath(P, '//cdn.example.com/x'), '//cdn.example.com/x');
  assert.strictEqual(CP.prefixPath(P, 'https://example.com/'), 'https://example.com/');
  assert.strictEqual(CP.prefixPath(P, 'api/x'), 'api/x');
});

t('a page: the script goes in first, own links get the prefix, others do not', async () => {
  const r = await request(FP, 'GET', '/console/a5/');
  assert.strictEqual(r.status, 200);
  const b = r.body;
  assert.ok(/<head><script>\(function\(\)\{var P="\/console\/a5";/.test(b), 'the script opens <head>');
  assert.ok(b.includes('href="/console/a5/reportview.css"'));
  assert.ok(b.includes('src="/console/a5/reportview.js"'));
  assert.ok(b.includes('href="/console/a5/report?log=1"'));
  assert.ok(b.includes("action='/console/a5/login'"), 'single quotes too');
  assert.ok(b.includes('href="//cdn.example.com"'), 'a protocol-relative link is left alone');
  assert.ok(b.includes('href="https://example.com/x"'), 'another site is left alone');
  assert.strictEqual(Number(r.headers['content-length']), Buffer.byteLength(b), 'length matches the rewritten page');
});

t('an API call: path and query reach the console, the answer comes back as is', async () => {
  const r = await request(FP, 'GET', '/console/a5/api/state?city=12');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(JSON.parse(r.body), { method: 'GET', url: '/api/state?city=12', body: '' });
});

t('a POST body is passed on', async () => {
  const body = JSON.stringify({ accountId: 'a5' });
  const r = await request(FP, 'POST', '/console/a5/api/switch', { headers: { 'Content-Type': 'application/json' }, body });
  assert.deepStrictEqual(JSON.parse(r.body), { method: 'POST', url: '/api/switch', body });
});

t('a redirect to our own path gets the prefix; one elsewhere does not', async () => {
  assert.strictEqual((await request(FP, 'GET', '/console/a5/go')).headers.location, '/console/a5/login');
  assert.strictEqual((await request(FP, 'GET', '/console/a5/away')).headers.location, 'https://example.com/');
});

t('secrets and loopback trust are not passed on; the cookie is', async () => {
  seen.length = 0;
  await request(FP, 'GET', '/console/a5/api/session', { headers: {
    'x-otto-internal': 'secret', 'x-otto-claude': 'key', Cookie: 'otto_sid=abc' } });
  const h = seen[0].headers;
  assert.strictEqual(h['x-otto-internal'], undefined);
  assert.strictEqual(h['x-otto-claude'], undefined);
  assert.strictEqual(h.cookie, 'otto_sid=abc', 'the sign-in cookie still reaches the console');
  assert.strictEqual(h['x-forwarded-prefix'], '/console/a5');
});

t('a console that does not answer: 502 with a sentence, not a hang', async () => {
  const r = await request(FP, 'GET', '/console/dead/');
  assert.strictEqual(r.status, 502);
  assert.ok(/did not answer/.test(r.body), r.body);
});

t('the page script: fetch, XHR, EventSource, window.open and clicks get the prefix', () => {
  const calls = [];
  const listeners = {};
  const anchor = { tagName: 'A', attrs: { href: '/report?log=2' },
    getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = v; } };
  function XHR() {}
  XHR.prototype.open = function (m, u) { calls.push(['xhr', m, u]); };
  function ES(u) { calls.push(['es', u]); }
  const win = {
    fetch: (i) => { calls.push(['fetch', i]); return Promise.resolve(); },
    open: (u) => { calls.push(['open', u]); return null; },
    EventSource: ES,
  };
  const ctx = {
    window: win, XMLHttpRequest: XHR, URL, location: { origin: 'http://mk:8712' },
    document: { addEventListener: (ev, fn) => { listeners[ev] = fn; } },
  };
  const src = CP.shim('/console/a5').replace(/^<script>/, '').replace(/<\/script>$/, '');
  vm.runInNewContext(src, ctx);
  win.fetch('/api/state');
  win.fetch('https://example.com/x');
  new XHR().open('GET', '/api/items');
  new win.EventSource('/api/events');
  win.open('/report?log=1', '_blank');
  listeners.click({ target: { closest: () => anchor } });
  assert.deepStrictEqual(calls, [
    ['fetch', '/console/a5/api/state'],
    ['fetch', 'https://example.com/x'],
    ['xhr', 'GET', '/console/a5/api/items'],
    ['es', '/console/a5/api/events'],
    ['open', '/console/a5/report?log=1'],
  ]);
  assert.strictEqual(anchor.attrs.href, '/console/a5/report?log=2', 'a clicked link is fixed before it is followed');
});

(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  consolePort = fake.address().port;
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  FP = front.address().port;
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok    ' + name); }
    catch (e) { failed++; console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
  }
  fake.close(); front.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
