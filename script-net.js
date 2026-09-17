'use strict';
// The web as script commands reach it (get, post): addresses on the public
// internet only. An address must be global unicast, checked on the URL, again
// on every name lookup (at connect time, so a name cannot answer one thing to
// the check and another to the connection) and again on every redirect. Any
// way of writing this machine or its networks is caught: 127.1, 2130706433,
// 0x7f.1, 0177.0.0.1 (the URL parser turns them all into 127.0.0.1),
// [::ffff:127.0.0.1] and [::ffff:7f00:1] (IPv4-mapped), [::127.0.0.1]
// (IPv4-compatible), [64:ff9b::a9fe:a9fe] (NAT64), [2002:a00:1::] (6to4).
// No other module here requires this one, and it never requires script.js.
//
//   addressKind(ip)        'global' | 'private' | 'blocked', or null when ip is no IP address
//   checkUrl(url, opts)    -> URL, or throws Error(why): http or https, no user:password@, and a
//                          host written as an IP address must pass; a host name passes here and
//                          is checked when it is looked up
//   safeLookup(opts)       a dns.lookup for http.request's `lookup` option that refuses answers
//                          that do not pass
//   await resolveUrl(url, opts)  -> { url, addresses }: checkUrl plus a lookup now, for a client
//                          that cannot take `lookup` (it leaves a window: prefer safeFetch)
//   await safeFetch(url, opts)   -> { status, statusText, headers, text, url }
//       method ('GET'), headers, body, timeoutMs (15 s, all of it), maxBytes (2 MB), truncate
//       (false: a bigger answer is an error; true: it is cut), redirects (3, followed for GET
//       and HEAD only, each one checked anew; otherwise the 3xx comes back), allowPrivate, lookup
//   opts.allowPrivate      loopback and the private networks pass as well (127/8, 10/8,
//                          172.16/12, 192.168/16, 100.64/10, ::1, fc00::/7) — for a console
//                          only this machine uses. Link-local (169.254/16: cloud metadata),
//                          multicast, reserved and the rest never pass.
//   opts.lookup            dns.lookup (callback) or dns.promises.lookup (promise) shaped; tests
const dns = require('dns');
const net = require('net');

// ------------------------------------------------------------------ addresses

const v4Int = (s) => s.split('.').reduce((n, p) => n * 256 + Number(p), 0);

// Everything IPv4 that is not global unicast (IANA special-purpose registry).
const V4_RANGES = [
  ['0.0.0.0', 8, 'blocked'],          // "this network"
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'private'],      // shared address space (carrier NAT)
  ['127.0.0.0', 8, 'private'],        // loopback
  ['169.254.0.0', 16, 'blocked'],     // link-local, cloud metadata
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'blocked'],       // IETF protocol assignments
  ['192.0.2.0', 24, 'blocked'],       // documentation
  ['192.88.99.0', 24, 'blocked'],     // 6to4 relay anycast
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'blocked'],      // benchmarking
  ['198.51.100.0', 24, 'blocked'],    // documentation
  ['203.0.113.0', 24, 'blocked'],     // documentation
  ['224.0.0.0', 4, 'blocked'],        // multicast
  ['240.0.0.0', 4, 'blocked'],        // reserved, and 255.255.255.255
].map(([a, bits, kind]) => ({ base: v4Int(a), size: 2 ** (32 - bits), kind }));

function kind4(n) {
  for (const r of V4_RANGES) if (n >= r.base && n < r.base + r.size) return r.kind;
  return 'global';
}

// Any textual IPv6 (compressed, full, a dotted IPv4 tail, a %zone) -> 8 words.
function v6Words(s) {
  let t = String(s).toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!net.isIPv6(t)) return null;
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (dotted) {
    if (!net.isIPv4(dotted[2])) return null;
    const n = v4Int(dotted[2]);
    t = `${dotted[1]}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const cut = t.indexOf('::');
  const head = cut < 0 ? t : t.slice(0, cut), tail = cut < 0 ? null : t.slice(cut + 2);
  const h = head ? head.split(':') : [];
  const tl = tail ? tail.split(':') : [];
  const words = [...h, ...Array(tail === null ? 0 : 8 - h.length - tl.length).fill('0'), ...tl].map((x) => parseInt(x, 16));
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

// IPv6: the forms that carry an IPv4 address are judged by it; beyond those,
// only 2000::/3 is global unicast, less its special-purpose parts.
function kind6(w) {
  const zero = (from, to) => w.slice(from, to).every((x) => x === 0);
  const v4At = (i) => w[i] * 65536 + w[i + 1];
  if (zero(0, 8)) return 'blocked';                                             // ::
  if (zero(0, 7) && w[7] === 1) return 'private';                               // ::1
  if (zero(0, 5) && w[5] === 0xffff) return kind4(v4At(6));                     // ::ffff:0:0/96 IPv4-mapped
  if (zero(0, 6)) return kind4(v4At(6));                                        // ::/96 IPv4-compatible
  if (zero(0, 4) && w[4] === 0xffff && w[5] === 0) return kind4(v4At(6));       // ::ffff:0:0:0/96 IPv4-translated
  if (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6)) return kind4(v4At(6));    // 64:ff9b::/96 NAT64
  if (w[0] === 0x2002) return kind4(v4At(1));                                   // 2002::/16 6to4
  if ((w[0] & 0xfe00) === 0xfc00) return 'private';                             // fc00::/7 unique local
  if ((w[0] & 0xe000) !== 0x2000) return 'blocked';                             // link-local, multicast, 64:ff9b:1::/48 ...
  if (w[0] === 0x2001 && w[1] < 0x200) return 'blocked';                        // 2001::/23: Teredo 2001::/32, ORCHID ...
  if (w[0] === 0x2001 && w[1] === 0xdb8) return 'blocked';                      // documentation
  if (w[0] === 0x3fff && w[1] < 0x1000) return 'blocked';                       // documentation 3fff::/20
  return 'global';
}

function addressKind(ip) {
  const s = String(ip === undefined || ip === null ? '' : ip).trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (net.isIPv4(s)) return kind4(v4Int(s));
  const w = v6Words(s);
  return w ? kind6(w) : null;
}

const passes = (kind, allowPrivate) => kind === 'global' || (kind === 'private' && !!allowPrivate);
const whyNot = (host, kind, at) => (kind === 'private'
  ? `${host}${at ? ` is at ${at}, which` : ''} is this machine or its own network — only addresses on the public internet can be reached`
  : `${host}${at ? ` is at ${at}, which` : ''} is not an address on the public internet (link-local, reserved or special-purpose) — refused`);

// ------------------------------------------------------------------ URLs

function checkUrl(raw, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(raw instanceof URL ? raw.href : String(raw === undefined || raw === null ? '' : raw).trim()); } catch {
    throw new Error(`"${raw}" is not a web address`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`only http:// and https:// addresses can be reached, not ${u.protocol}`);
  if (u.username || u.password) throw new Error('no user:password@ in the address');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw new Error(`"${raw}" names no host`);
  const kind = addressKind(host);
  if (kind) {
    if (!passes(kind, allowPrivate)) throw new Error(whyNot(u.hostname, kind));
  } else if (host === 'localhost' || host.endsWith('.localhost')) {
    if (!allowPrivate) throw new Error(whyNot(u.hostname, 'private'));
  }
  return u;
}

// dns.lookup's shape, for http.request: every answer must pass.
function safeLookup({ allowPrivate = false, lookup = dns.lookup } = {}) {
  return (host, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const o = typeof opts === 'number' ? { family: opts } : { ...(opts || {}) };
    let settled = false;
    const answer = (err, address, family) => {
      if (settled) return;
      settled = true;
      if (err) { cb(err); return; }
      let list = Array.isArray(address) ? address : address && typeof address === 'object' ? [address] : [{ address, family }];
      list = list.filter((x) => x && x.address).map((x) => ({ address: x.address, family: x.family || (net.isIPv6(x.address) ? 6 : 4) }));
      if (!list.length) { cb(Object.assign(new Error(`${host}: no address found`), { code: 'ENOTFOUND' })); return; }
      for (const x of list) {
        const kind = addressKind(x.address);
        if (!passes(kind, allowPrivate)) { cb(Object.assign(new Error(whyNot(host, kind || 'blocked', x.address)), { code: 'EREFUSED_ADDRESS' })); return; }
      }
      if (o.all) cb(null, list);
      else cb(null, list[0].address, list[0].family);
    };
    let r;
    try { r = lookup(host, o, answer); } catch (e) { answer(e); return; }
    // dns.promises.lookup's shape: the answer is the promise's
    if (r && typeof r.then === 'function') r.then((v) => answer(null, v), (e) => answer(e));
  };
}

async function resolveUrl(raw, { allowPrivate = false, lookup = dns.lookup } = {}) {
  const u = checkUrl(raw, { allowPrivate });
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (addressKind(host)) return { url: u, addresses: [host] };
  const list = await new Promise((resolve, reject) => {
    safeLookup({ allowPrivate, lookup })(host, { all: true }, (e, a) => (e ? reject(e) : resolve(a)));
  });
  return { url: u, addresses: list.map((x) => x.address) };
}

// ------------------------------------------------------------------ fetch

const lowerKeys = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [String(k).toLowerCase(), v]));
const mb = (n) => (n >= 1048576 ? `${Math.round((n / 1048576) * 10) / 10} MB` : `${Math.round(n / 1024)} KB`);

function safeFetch(raw, opts = {}) {
  const {
    method = 'GET', headers = {}, body, timeoutMs = 15000, maxBytes = 2 * 1024 * 1024, truncate = false,
    redirects = 3, allowPrivate = false, lookup = dns.lookup,
  } = opts;
  return new Promise((resolve, reject) => {
    let u;
    try { u = checkUrl(raw, { allowPrivate }); } catch (e) { reject(e); return; }
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const payload = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const hdrs = { 'user-agent': 'OTTObot script', ...lowerKeys(headers) };
    if (payload) hdrs['content-length'] = String(payload.length);
    let done = false, timer = null, req = null;
    const finish = (f, v) => { if (done) return; done = true; clearTimeout(timer); f(v); };
    try {
      // agent:false: a fresh connection, so every request goes through the lookup
      req = lib.request(u, { method, headers: hdrs, agent: false, lookup: safeLookup({ allowPrivate, lookup }) }, (res) => {
        const status = res.statusCode || 0;
        const loc = res.headers.location;
        if (status >= 300 && status < 400 && loc && redirects > 0 && /^(GET|HEAD)$/i.test(method)) {
          res.resume();
          let next;
          try { next = new URL(loc, u).href; } catch { finish(reject, new Error(`${u.host} sent it on to a bad address`)); return; }
          finish(resolve, safeFetch(next, { ...opts, redirects: redirects - 1 }));
          return;
        }
        const chunks = [];
        let size = 0;
        const out = () => ({ status, statusText: res.statusMessage || '', headers: { ...res.headers },
          text: Buffer.concat(chunks).toString('utf8').replace(/^﻿/, ''), url: u.href });
        res.on('data', (c) => {
          if (done) return;
          if (size + c.length > maxBytes) {
            if (truncate) { chunks.push(c.subarray(0, maxBytes - size)); size = maxBytes; finish(resolve, out()); }
            else finish(reject, new Error(`${u.host} sent more than ${mb(maxBytes)} — too big`));
            res.destroy();
            return;
          }
          size += c.length;
          chunks.push(c);
        });
        res.on('end', () => finish(resolve, out()));
        res.on('error', (e) => finish(reject, e));
      });
    } catch (e) { finish(reject, e); return; }
    timer = setTimeout(() => {
      finish(reject, new Error(`${u.host} did not answer within ${timeoutMs >= 1000 ? Math.round(timeoutMs / 1000) + ' s' : timeoutMs + ' ms'}`));
      req.destroy();
    }, timeoutMs);
    req.on('error', (e) => finish(reject, e && e.code === 'EREFUSED_ADDRESS' ? e : new Error(`could not reach ${u.host}: ${(e && e.message) || e}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { addressKind, checkUrl, safeLookup, resolveUrl, safeFetch };
