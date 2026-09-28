'use strict';
// An account's console, reached through the Director: /console/<accountId>/...
// is passed on to that console's own http://localhost:<port>/... (director.js).
//
// Why (the user, 2026-09-28): the fleet moved to a server that is reached over
// Tailscale, and only the Director's port is served there. A console link was
// http://localhost:87xx, which from the user's laptop is the LAPTOP, so the Fleet
// view opened but no account did. Through the Director every console is on one
// address, behind the Director's own sign-in.
//
// The console page (public/app.html) asks for its data at absolute paths —
// fetch('/api/…'), href="/report?…", some ninety of them. Rather than edit each,
// a page passed through here gets a small script at the top of <head> that puts
// the prefix in front of any absolute path it fetches, opens or clicks, and its
// static href/src/action attributes are rewritten the same way. Redirects from
// the console (Location: /login) get the prefix too.
//
// The target is never taken from the request: the Director hands in the port of
// the console it already knows for that account.

const http = require('http');

// Headers that carry a machine secret or a loopback trust. Through here the
// caller is whoever reached the Director (over Tailscale, perhaps), yet the
// console would see 127.0.0.1 — so none of them is passed on.
const DROP = new Set(['x-otto-internal', 'x-otto-claude', 'host', 'connection', 'accept-encoding',
  'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);

// /console/a5/api/state -> { id: 'a5', rest: '/api/state' }; /console/a5 -> rest ''
function parse(pathname) {
  const m = /^\/console\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname);
  return m ? { id: m[1], rest: m[2] || '' } : null;
}

// Only a path of our own site ('/x'), never '//host/x', and never one already prefixed.
function prefixPath(prefix, u) {
  if (typeof u !== 'string' || u[0] !== '/' || u[1] === '/') return u;
  if (u === prefix || u.startsWith(prefix + '/')) return u;
  return prefix + u;
}

// The script put at the top of every page passed through. Plain ES5-ish, runs
// before the page's own scripts.
function shim(prefix) {
  const P = JSON.stringify(prefix);
  return `<script>(function(){var P=${P};
function fx(u){if(typeof u!=='string'||u.charAt(0)!=='/'||u.charAt(1)==='/')return u;if(u===P||u.indexOf(P+'/')===0)return u;return P+u;}
var f=window.fetch;if(f)window.fetch=function(i,o){if(typeof i==='string')i=fx(i);else if(i instanceof URL&&i.origin===location.origin)i=fx(i.pathname+i.search);return f.call(this,i,o);};
var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){var a=[].slice.call(arguments);a[1]=fx(u);return xo.apply(this,a);};
if(window.EventSource){var E=window.EventSource;var NE=function(u,c){return new E(fx(u),c);};NE.prototype=E.prototype;window.EventSource=NE;}
var wo=window.open;window.open=function(u){var a=[].slice.call(arguments);if(a.length)a[0]=fx(u);return wo.apply(this,a);};
function fixA(e){var t=e.target;var a=t&&t.closest&&t.closest('a[href],form[action]');if(!a)return;var k=a.tagName==='FORM'?'action':'href';var h=a.getAttribute(k);var n=fx(h);if(n!==h)a.setAttribute(k,n);}
document.addEventListener('click',fixA,true);document.addEventListener('auxclick',fixA,true);document.addEventListener('submit',fixA,true);
})();</script>`;
}

// Static attributes, and the shim at the top of <head> (or of the page).
function rewriteHtml(html, prefix) {
  const out = html.replace(/(\s(?:href|src|action)=)(["'])\/(?!\/)/g, (m, attr, q) => `${attr}${q}${prefix}/`);
  const tag = shim(prefix);
  const head = /<head[^>]*>/i.exec(out);
  if (head) return out.slice(0, head.index + head[0].length) + tag + out.slice(head.index + head[0].length);
  return tag + out;
}

// Pass req on to 127.0.0.1:port at `rest`, answering on res. prefix is
// '/console/<id>'. Resolves when the answer has been sent.
function pass(req, res, { port, prefix, rest, search = '' }) {
  return new Promise((resolve) => {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP.has(k.toLowerCase())) headers[k] = v;
    headers.host = `localhost:${port}`;
    headers['accept-encoding'] = 'identity';          // so a page can be rewritten
    headers['x-forwarded-prefix'] = prefix;
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: (rest || '/') + search, headers }, (r) => {
      const h = { ...r.headers };
      if (h.location) h.location = prefixPath(prefix, h.location);
      const type = String(h['content-type'] || '');
      if (!/text\/html/i.test(type)) {
        res.writeHead(r.statusCode, h);
        r.pipe(res);
        r.on('end', resolve); r.on('error', resolve);
        return;
      }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const body = Buffer.from(rewriteHtml(Buffer.concat(chunks).toString('utf8'), prefix), 'utf8');
        delete h['content-length']; delete h['transfer-encoding'];
        h['content-length'] = body.length;
        res.writeHead(r.statusCode, h);
        res.end(body);
        resolve();
      });
      r.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); resolve(); });
    });
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`That account's console did not answer (${e.code || e.message}). It may be restarting; try again in a moment.`);
      resolve();
    });
    req.pipe(up);
  });
}

module.exports = { parse, prefixPath, shim, rewriteHtml, pass };
