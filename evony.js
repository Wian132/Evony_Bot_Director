'use strict';
// Evony socket client: 4-byte BE length framing + AMF0 {cmd, data}
const net = require('net');
const crypto = require('crypto');
const http = require('http');
const { EventEmitter } = require('events');
const amf = require('./amf3');   // wire payloads are pure AMF3 (confirmed by probe)

const VERSION = '091103_11';   // still the constant shipped in EvonyClient1922.swf

function getServerConfig(serverId) {
  return new Promise((resolve, reject) => {
    const url = `http://${serverId}.evony.com/config.xml`;
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        const host = (body.match(/<server>([^<]+)<\/server>/) || [])[1];
        const port = parseInt((body.match(/<port>([^<]+)<\/port>/) || [])[1], 10);
        const state = (body.match(/<ServerState>([^<]+)<\/ServerState>/) || [])[1];
        if (!host) return reject(new Error('no <server> in config.xml'));
        resolve({ host, port: port || 443, state });
      });
    }).on('error', reject);
  });
}

// The game never sees the password itself: login, the truce and every other
// password prompt send SHA1.hash(text), lowercase hex of the UTF-8 bytes
// (EvonyClient.as:4778, StageChangeWin.as:447, GiveupCastle.as:417).
const passwordHash = (password) => crypto.createHash('sha1').update(password, 'utf8').digest('hex');

class EvonyClient extends EventEmitter {
  // The hash the login sent. A private field: JSON, util.inspect and the logs
  // cannot reach it, and nothing writes it to disk.
  #pwHash = null;

  constructor() {
    super();
    this.buf = Buffer.alloc(0);
    this.sock = null;
    // Every frame the server sends is emitted as 'cmd', in the order it arrived —
    // which is what lets game.js pipe hand each market reply to the oldest request
    // still waiting for one. A connection that answers any other way must not say so.
    this.pipelines = true;
    // Eight listeners are permanent (Game's six pushes, the Engine's two), and
    // every command in flight adds one of its own while it waits for its reply
    // (await below). A console running several cities' scripts beside the engine
    // passes ten routinely, and Node's default warned about a leak every time —
    // filling each console's error log with a false alarm, which is the last
    // place a real one should have to be found. The ceiling is set where a leak
    // would still show: this is a deliberate number, not a silenced warning.
    this.setMaxListeners(64);
  }

  // `proxy` (optional) is a parsed entry from proxy.js -- the game socket is then
  // tunnelled through it, which is how one machine can run many accounts safely.
  connect(host, port, proxy = null) {
    return new Promise(async (resolve, reject) => {
      const attach = (sock, via) => {
        this.sock = sock;
        // Nagle's algorithm holds a small frame back until the one before it has
        // been acknowledged — up to a whole round trip (~240 ms from South
        // Africa). A console writes from many places at once (nine city scripts,
        // the engine, the page) and market writes are pipelined (game.js pipe),
        // so every frame goes out the moment it is written.
        if (typeof sock.setNoDelay === 'function') sock.setNoDelay(true);
        this.lastFrameAt = Date.now();
        sock.on('data', (d) => this._onData(d));
        sock.on('error', (e) => { this.emit('log', 'socket error: ' + e.message); reject(e); });
        // Who ended it (2026-09-22): a close we did not ask for (close() below) and that no
        // socket error explains is the SERVER hanging up — which is what another login
        // (NEAT's, a person's) looks like: no kick message ever arrives, only this.
        sock.on('close', (hadError) => { this.closedHadError = !!hadError; this.emit('log', 'socket closed'); });
        this.emit('log', `connected to ${host}:${port}${via ? ' via ' + via : ''}`);
        resolve();
      };

      if (proxy) {
        try {
          const { connectVia } = require('./proxy');
          const sock = await connectVia(proxy, host, port);
          return attach(sock, proxy.label);
        } catch (e) {
          this.emit('log', 'proxy failed: ' + e.message);
          return reject(e);
        }
      }

      const sock = net.connect({ host, port }, () => attach(sock, null));
      sock.on('error', (e) => { this.emit('log', 'socket error: ' + e.message); reject(e); });
    });
  }

  _onData(d) {
    this.lastFrameAt = Date.now();
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 4) return;
      const len = this.buf.readUInt32BE(0);
      if (len > 50 * 1024 * 1024) { this.emit('log', 'bogus frame length ' + len + ' - resyncing'); this.buf = Buffer.alloc(0); return; }
      if (this.buf.length < 4 + len) return;
      const payload = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      let msg;
      try {
        msg = amf.decode(payload);
      } catch (e) {
        this.emit('log', `decode failed (${e.message}) raw=${payload.subarray(0, 64).toString('hex')}`);
        continue;
      }
      if (msg && msg.cmd) {
        // the last few commands the server sent, so a close can say what came just before it
        (this.recentCmds = this.recentCmds || []).push(msg.cmd);
        if (this.recentCmds.length > 6) this.recentCmds.shift();
        this.emit('cmd', msg.cmd, msg.data, msg);
      }
      this.emit('frame', msg);
    }
  }

  send(cmd, data) {
    const body = amf.encode({ cmd, data });
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    this.sock.write(Buffer.concat([head, body]));
    this.emit('log', `-> ${cmd}`);
  }

  // The server answers a bad payload by hanging up, but answers an over-active
  // account by ignoring commands while the socket stays open. Distinguishing the
  // two matters, so count consecutive unanswered commands and say so plainly.
  noteTimeout(cmd) {
    this.missedReplies = (this.missedReplies || 0) + 1;
    if (this.missedReplies === 3) {
      this.emit('log', `THREE commands in a row went unanswered while the socket is open — `
        + `the server is ignoring this account (rate limit). Back off and let it settle.`);
    }
  }
  // lastReplyAt: when the server last answered one of OUR commands — proof it is
  // working through them, which pushes (chat, updates) are not
  noteReply() { this.missedReplies = 0; this.lastReplyAt = Date.now(); }

  // Wait for a specific cmd (or any of several), with timeout
  await(cmds, ms = 20000) {
    const want = Array.isArray(cmds) ? cmds : [cmds];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('cmd', h);
        this.noteTimeout(want[0]);
        reject(new Error('no reply to ' + want.join('/') + (this.missedReplies >= 3 ? ' (server is ignoring this account — rate limited)' : '')));
      }, ms);
      const h = (cmd, data, msg) => {
        if (!want.includes(cmd)) return;
        clearTimeout(timer);
        this.off('cmd', h);
        this.noteReply();
        resolve(msg);
      };
      this.on('cmd', h);
    });
  }

  async login(email, password) {
    this.send('gameClient.version', VERSION);
    const pwd = passwordHash(password);
    this.#pwHash = pwd;
    this.send('login', { user: email, pwd });
    return this.await(['server.LoginResponse', 'login', 'server.ErrorResponse'], 25000);
  }

  // Commands that re-ask for the password (city.setStopWarState for a truce)
  // take the same hash the login used. Null until this client has logged in.
  passwordHash() { return this.#pwHash; }

  close() { this.closedByUs = true; if (this.sock) this.sock.destroy(); }
}

module.exports = { EvonyClient, getServerConfig, VERSION, passwordHash };
