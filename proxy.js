'use strict';
// Proxy support: SOCKS5 and HTTP CONNECT, implemented directly on net sockets
// so the bot keeps its zero-dependency footprint.
//
// Accepted line formats (one per line, blank lines and # comments ignored):
//   host:port
//   host:port:user:pass
//   socks5://user:pass@host:port
//   http://user:pass@host:port
//   socks5://host:port
// Bare host:port defaults to socks5.
const net = require('net');

function parseProxy(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('//')) return null;

  let type = 'socks5', rest = raw;
  const scheme = raw.match(/^(socks5|socks|http|https):\/\/(.*)$/i);
  if (scheme) { type = /^http/i.test(scheme[1]) ? 'http' : 'socks5'; rest = scheme[2]; }

  let user = null, pass = null, hostport = rest;
  if (rest.includes('@')) {
    const at = rest.lastIndexOf('@');
    const creds = rest.slice(0, at).split(':');
    hostport = rest.slice(at + 1);
    user = creds[0] || null; pass = creds[1] || null;
  }

  const bits = hostport.split(':');
  if (bits.length >= 4 && !user) { user = bits[2]; pass = bits[3]; }   // host:port:user:pass
  const host = bits[0];
  const port = Number(bits[1]);
  if (!host || !port) return null;

  return { type, host, port, user, pass, label: `${type}://${host}:${port}`, raw };
}

function parseList(text) {
  return String(text || '').split(/\r?\n/).map(parseProxy).filter(Boolean);
}

// ---- SOCKS5 ----
function socks5(proxy, destHost, destPort, timeout) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: proxy.host, port: proxy.port });
    let stage = 'greet';
    const fail = (m) => { s.destroy(); reject(new Error(`socks5 ${proxy.host}:${proxy.port}: ${m}`)); };
    const timer = setTimeout(() => fail('timeout'), timeout);

    s.on('error', (e) => { clearTimeout(timer); fail(e.message); });
    s.on('connect', () => {
      const methods = proxy.user ? [0x00, 0x02] : [0x00];
      s.write(Buffer.from([0x05, methods.length, ...methods]));
    });

    s.on('data', (d) => {
      if (stage === 'greet') {
        if (d[0] !== 0x05) return fail('bad version');
        if (d[1] === 0xff) return fail('no acceptable auth method');
        if (d[1] === 0x02) {
          if (!proxy.user) return fail('proxy wants auth but no credentials given');
          const u = Buffer.from(proxy.user, 'utf8'), p = Buffer.from(proxy.pass || '', 'utf8');
          s.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          stage = 'auth';
          return;
        }
        stage = 'connect';
        return sendConnect();
      }
      if (stage === 'auth') {
        if (d[1] !== 0x00) return fail('proxy rejected the credentials');
        stage = 'connect';
        return sendConnect();
      }
      if (stage === 'connect') {
        if (d[0] !== 0x05) return fail('bad reply version');
        if (d[1] !== 0x00) {
          const why = { 1: 'general failure', 2: 'not allowed', 3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused', 6: 'ttl expired', 7: 'command not supported', 8: 'address type not supported' };
          return fail(why[d[1]] || `reply code ${d[1]}`);
        }
        clearTimeout(timer);
        s.removeAllListeners('data');
        s.removeAllListeners('error');
        resolve(s);
      }
    });

    function sendConnect() {
      const h = Buffer.from(destHost, 'utf8');
      const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(destHost);
      const head = isIp
        ? Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01]), Buffer.from(destHost.split('.').map(Number))])
        : Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h]);
      const port = Buffer.alloc(2); port.writeUInt16BE(destPort, 0);
      s.write(Buffer.concat([head, port]));
    }
  });
}

// ---- HTTP CONNECT ----
function httpConnect(proxy, destHost, destPort, timeout) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: proxy.host, port: proxy.port });
    let buf = '';
    const fail = (m) => { s.destroy(); reject(new Error(`http proxy ${proxy.host}:${proxy.port}: ${m}`)); };
    const timer = setTimeout(() => fail('timeout'), timeout);

    s.on('error', (e) => { clearTimeout(timer); fail(e.message); });
    s.on('connect', () => {
      const target = `${destHost}:${destPort}`;
      let req = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`;
      if (proxy.user) req += `Proxy-Authorization: Basic ${Buffer.from(`${proxy.user}:${proxy.pass || ''}`).toString('base64')}\r\n`;
      s.write(req + '\r\n');
    });
    s.on('data', (d) => {
      buf += d.toString('binary');
      if (!buf.includes('\r\n\r\n')) return;
      const status = Number((buf.match(/^HTTP\/1\.[01] (\d+)/) || [])[1]);
      if (status !== 200) return fail(`CONNECT returned ${status || 'garbage'}`);
      clearTimeout(timer);
      s.removeAllListeners('data');
      s.removeAllListeners('error');
      resolve(s);
    });
  });
}

// Returns a socket already tunnelled to destHost:destPort.
function connectVia(proxy, destHost, destPort, timeout = 20000) {
  if (!proxy) return null;
  return proxy.type === 'http'
    ? httpConnect(proxy, destHost, destPort, timeout)
    : socks5(proxy, destHost, destPort, timeout);
}

module.exports = { parseProxy, parseList, connectVia };
