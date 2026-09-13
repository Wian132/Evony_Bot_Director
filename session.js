'use strict';
// A single long-lived game session shared by the whole console.
// Server pushes (chat, reports, resource/troop updates) are buffered here so the
// dashboard can render them without logging in per request.
const fs = require('fs');
const path = require('path');
const { Game } = require('./game');
const C = require('./constants');
const D = require('./db');
const { getServerConfig } = require('./evony');
const { buildSnapshot, marches } = require('./snapshot');

const RING = 400;
const push = (arr, item) => { arr.push(item); if (arr.length > RING) arr.shift(); };

function loadEnv() {
  const out = {};
  const p = path.join(__dirname, '.env');
  if (fs.existsSync(p)) for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2];
  }
  return out;
}

class Session {
  // ACCOUNT_ID picks which account out of the database this console drives, so a
  // second account is just a second process:
  //   CONSOLE_PORT=8713 ACCOUNT_ID=a2 node server.js
  // With no ACCOUNT_ID it falls back to the credentials in .env.
  constructor(accountId = process.env.ACCOUNT_ID || null) {
    // Bootstrap lookup only: the operator names the account on the command line,
    // which is trusted. Everything AFTER this goes through this.org, scoped to
    // whichever organization owns that account.
    this.account = accountId ? D.accounts.get(accountId) : null;
    if (accountId && !this.account) throw new Error(`ACCOUNT_ID=${accountId} is not in the database`);
    // Resolve the .env account NOW, not after the first successful login. The
    // Director skips accounts a console already owns, and it asks by reading
    // /api/session — so a console that does not know its own name until it is
    // logged in leaves a startup window where the Director logs in too and
    // kicks it.
    if (!this.account) {
      try { this.account = D.accounts.byEmail(loadEnv().EVONY_EMAIL || '') || null; } catch {}
    }
    // A restart must not forget a stand-down that is already in progress.
    this.bindOrg();
    try {
      const saved = this.settings().get('maintPlan:' + (this.account && this.account.id), null);
      if (saved && Date.now() < saved.resumeAt + 3600000) this.maint.plan = saved;
    } catch {}
    this.game = null;
    this.connecting = null;
    this.log = [];
    this.chat = { alliance: [], world: [], private: [], system: [] };
    this.reports = [];
    this.engine = null;
    this.engineMode = process.env.ENGINE_MODE || 'off';   // off | plan | live
    // Daily maintenance: the server publishes its own state in config.xml and
    // the real client refuses to log in while it reads ServerMaintaining. That
    // is the signal used here — a plain HTTP GET, no game traffic, so polling it
    // costs nothing and cannot trip the rate limiter.
    this.maint = {
      active: false, since: null, state: null, checkedAt: 0, error: null,
      portDown: false, netFails: 0, reason: null,
      plan: null, nextLoginAt: 0, loginTries: 0,
      override: process.env.MAINT_OVERRIDE === '1',   // keep running regardless
    };
    this.lastError = null;
  }

  // logSeq is monotonic; this.log is a 400-entry ring, so its length plateaus
  // and cannot be used to tell whether anything happened between two samples.
  // The organization that owns this console's account. Every tenant read and
  // write below goes through it, so a console cannot reach another org's data
  // even by id.
  bindOrg() {
    this.orgId = (this.account && this.account.orgId) || null;
    this.org = this.orgId ? D.org(this.orgId) : null;
    return this.org;
  }
  settings() {
    return this.org ? this.org.settings : { get: (k, d) => d, set: () => {} };
  }

  // logSeq is monotonic; this.log is a 400-entry ring whose length plateaus, so
  // it cannot tell you whether anything happened between two samples.
  //
  // The engine already prefixes its per-city lines with "[CityName]", so the
  // city is taken off the front rather than threaded through every caller.
  // Anything without a prefix belongs to the session as a whole.
  note(m, city = null) {
    this.logSeq = (this.logSeq || 0) + 1;
    const text = String(m);
    let tag = city;
    if (!tag) {
      const hit = text.match(/^\[([^\]]{1,24})\]\s*/);
      if (hit) tag = hit[1];
    }
    push(this.log, { t: Date.now(), m: text, city: tag || null });
  }

  // Empty the log, or only the lines belonging to one city.
  clearLog(kind = 'log', city = null) {
    const target = kind === 'reports' ? 'reports' : 'log';
    const before = this[target].length;
    if (city) this[target] = this[target].filter((l) => l.city !== city);
    else this[target] = [];
    const removed = before - this[target].length;
    // The note comes after the clear, or it would be wiped along with it.
    this.note(city ? `log cleared for ${city} (${removed} line(s))` : `log cleared (${removed} line(s))`);
    return removed;
  }

  // Every city that currently has lines, for the filter.
  logCities(kind = 'log') {
    const seen = new Map();
    for (const l of (kind === 'reports' ? this.reports : this.log)) {
      if (l.city) seen.set(l.city, (seen.get(l.city) || 0) + 1);
    }
    return [...seen.entries()].map(([city, count]) => ({ city, count }))
      .sort((a, b) => String(a.city).localeCompare(String(b.city), undefined, { numeric: true }));
  }

  get connected() { return !!(this.game && this.game.c && this.game.c.sock && !this.game.c.sock.destroyed); }

  // ---- stability ----
  // The server drops idle sockets, and bursting reconnects gets the IP throttled,
  // so: heartbeat to stay warm, and back off hard when reconnecting.
  // Staged retry ladder: quick first, then progressively patient. Anything that
  // looks like server-side rate limiting starts further down the ladder.
  static BACKOFF = [30000, 60000, 120000, 300000, 600000];

  // Kept as a hook so tests can make the stagger deterministic.
  static rand() { return Math.random(); }

  startSupervisor({ heartbeatMs = 60000, idleLimitMs = 150000, checkMs = 5000 } = {}) {
    if (this._supervisor) return;
    this.attempt = 0;
    this.backoffMs = Session.BACKOFF[0];
    this.reconnects = 0;
    this._supervisor = setInterval(async () => {
      try {
        if (this.connecting) return;
        this.checkMaintenance();          // fire and forget; result is cached

        // During maintenance the server refuses logins. Retrying through it
        // burns the backoff ladder and can leave us throttled exactly when it
        // comes back, so stand down and wait.
        // A planned stand-down outranks everything: no logins at all while the
        // window is open, because login attempts into maintenance are what we
        // believe earned the block in the first place.
        const phase = this.planPhase();
        if (phase === 'standdown' && !this.maint.override) {
          if (this.connected) { this.note('standing down for maintenance'); try { this.game.close(); } catch {} }
          this.state = 'maintenance';
          this.disconnectReason = 'standing down for announced maintenance';
          this.maint.loginTries = 0;
          this.maint.nextLoginAt = this.maint.plan.resumeAt;
          return;
        }
        if (phase === 'recovering' && !this.connected && !this.maint.override) {
          this.state = 'maintenance';
          this.disconnectReason = 'waiting for the server to come back';
          if (Date.now() < (this.maint.nextLoginAt || 0)) return;
          this.maint.nextLoginAt = Date.now() + Session.RETRY_EVERY_MIN * 60000;
          // Free check first — never spend a login on a closed port.
          if (!(await this.portOpen())) {
            this.note(`port still closed — next check in ${Session.RETRY_EVERY_MIN}m`);
            return;
          }
          this.maint.loginTries++;
          this.note(`port is open — login attempt ${this.maint.loginTries} after maintenance`);
          try {
            await this.connect();
            this.noteConnectOk();
            this.state = 'connected'; this.disconnectReason = null;
            this.clearMaintenancePlan();
            this.note('back online after maintenance');
          } catch (e) {
            this.note(`still not accepting us — next attempt in ${Session.RETRY_EVERY_MIN}m`);
          }
          return;
        }

        if (this.paused) {
          if (this.connected) { this.note('server went down — closing the socket'); try { this.game.close(); } catch {} }
          this.state = 'maintenance';
          this.disconnectReason = this.maint.reason || 'server maintenance';
          // A maintenance window is 15-30 minutes, so a steady one-a-minute probe
          // gets us back promptly without the escalating ladder parking us for
          // ten minutes after the server has already returned. The engine stays
          // paused either way, so nothing is ordered into a dead server.
          this.attempt = 0;
          this.backoffMs = Session.BACKOFF[0];
          if (Date.now() < (this.nextTryAt || 0)) return;
          this.nextTryAt = Date.now() + 60000;

          // Probe with a bare TCP connect, NOT a login. Reachability costs a
          // handshake; a login is a scarce, account-scoped resource and the
          // server throttles an account that spends too many. Only once the
          // port answers do we spend one.
          const open = await this.portOpen();
          if (!open) { this.noteConnectError({ code: 'ECONNREFUSED' }); return; }

          // Stagger the fleet: if every bot logs in the instant the server
          // returns, they arrive as one burst.
          const jitter = Math.floor(Session.rand() * 15000);
          this.note(`the port is answering again — logging back in after ${Math.round(jitter / 1000)}s`);
          await new Promise((r) => setTimeout(r, jitter));
          try {
            await this.connect();
            this.noteConnectOk();
            this.state = 'connected'; this.disconnectReason = null;
            this.note('back online');
          } catch (e) { this.noteConnectError(e); }
          return;
        }

        if (!this.connected) {
          if (Date.now() < (this.nextTryAt || 0)) return;
          this.state = 'connecting';
          this.note(`reconnecting (attempt ${this.attempt + 1})`);
          try {
            await this.connect();
            this.noteConnectOk();
            this.attempt = 0; this.backoffMs = Session.BACKOFF[0]; this.nextTryAt = 0;
            this.state = 'connected'; this.disconnectReason = null;
            this.note('reconnected');
          } catch (e) {
            this.noteConnectError(e);
            if (this.paused) return;        // it is the server, not us — switch modes
            this.attempt++;
            this.backoffMs = Session.BACKOFF[Math.min(this.attempt, Session.BACKOFF.length - 1)];
            this.nextTryAt = Date.now() + this.backoffMs;
            this.state = 'reconnecting';
            this.disconnectReason = this.disconnectReason || e.message;
            this.note(`reconnect failed (${e.message}) — next try in ${Math.round(this.backoffMs / 1000)}s`);
          }
          return;
        }

        // connected: has it gone quiet for too long?
        if (this.game.idleMs > idleLimitMs) {
          this.note(`no traffic for ${Math.round(this.game.idleMs / 1000)}s — cycling the socket`);
          try { this.game.close(); } catch {}
          return;
        }

        if (Date.now() - (this.lastPingAt || 0) > heartbeatMs) {
          this.lastPingAt = Date.now();
          try { await this.game.ping(); }
          catch (e) {
            this.note('heartbeat failed — cycling the socket');
            try { this.game.close(); } catch {}
          }
        }
      } catch (e) { this.note('supervisor: ' + e.message); }
    }, checkMs);
    this.note('session supervisor started (heartbeat 60s, reconnect backoff 5s→5min)');
  }

  // Re-reads config.xml at most once a minute. Never throws: if the web server
  // is unreachable we must NOT assume maintenance, or a DNS blip would park the
  // bot for the rest of the day.
  async checkMaintenance(everyMs = 60000) {
    if (Date.now() - this.maint.checkedAt < everyMs) return this.maint;
    this.maint.checkedAt = Date.now();
    try {
      const env = loadEnv();
      const cfg = await getServerConfig((this.account && this.account.server) || env.EVONY_SERVER || 'ss71');
      this.maint.state = cfg.state || null;
      this.maint.error = null;
      this.flagged = String(cfg.state || '') === 'ServerMaintaining';
      this.refreshMaintenance();
    } catch (e) {
      // unreachable config.xml is not evidence of maintenance
      this.maint.error = e.message;
    }
    return this.maint;
  }

  // OBSERVED 2026-09-13: during a real maintenance window the game port was
  // refusing connections while config.xml still read ServerRunning. The flag
  // lags, or is simply not set for routine daily downtime, so it cannot be the
  // only signal — the port itself is the truth. Either one counts.
  refreshMaintenance() {
    const was = this.maint.active;
    const portDown = this.maint.netFails >= 2;
    this.maint.portDown = portDown;
    this.maint.active = !!(this.flagged || portDown);
    this.maint.reason = this.flagged
      ? `the server reports ServerState=${this.maint.state}`
      : (portDown ? `the game port stopped accepting connections (${this.maint.lastNetError || 'refused'})` : null);

    if (this.maint.active && !was) {
      this.maint.since = Date.now();
      this.note(`server looks down — ${this.maint.reason}`
        + (this.maint.override ? ' — override is ON, still trying' : ' — pausing, will retry once a minute'));
    } else if (!this.maint.active && was) {
      const mins = Math.round((Date.now() - (this.maint.since || Date.now())) / 60000);
      this.maint.since = null;
      this.note(`server is back after about ${mins} minute(s) — resuming`);
    }
    return this.maint;
  }

  // ---- scheduled maintenance ------------------------------------------
  //
  // The server announces maintenance about 15 minutes ahead on the system
  // channel. Rather than discover the outage by failing logins — which is what
  // gets an account blocked — stand down BEFORE it starts and come back on a
  // patient ladder.
  //
  //   announcement  ->  keep playing for ANNOUNCE_LEAD - PRE_PAUSE minutes
  //   pause         ->  PRE_PAUSE before the window, plus the window itself
  //   then          ->  port probe + one login, retried every RETRY_EVERY
  static ANNOUNCE_LEAD_MIN = 15;   // how far ahead the server warns
  static PRE_PAUSE_MIN = 5;        // stand down this long before it starts
  static WINDOW_MIN = 15;          // assumed length of the window
  static RETRY_EVERY_MIN = 5;      // spacing of login attempts afterwards

  static MAINT_WORDS = /\b(maintenance|maintainance|mainten|server\s+(will|is going to)\s+(be\s+)?(down|closed|restart)|scheduled\s+downtime)\b/i;

  // Returns the plan when a message looks like a maintenance warning.
  noteAnnouncement(text) {
    if (!text || !Session.MAINT_WORDS.test(text)) return null;
    // Ignore a repeat of one we already acted on.
    const plan = this.maint.plan;
    if (plan && Date.now() < plan.resumeAt && plan.text === text) return plan;

    const mins = Session.minutesFrom(text);
    const lead = mins === null ? Session.ANNOUNCE_LEAD_MIN : mins;
    const startsAt = Date.now() + lead * 60000;
    const pauseAt = startsAt - Session.PRE_PAUSE_MIN * 60000;
    const resumeAt = startsAt + Session.WINDOW_MIN * 60000;

    this.maint.plan = { text, announcedAt: Date.now(), startsAt, pauseAt, resumeAt, source: 'announcement' };
    try { this.settings().set('maintPlan:' + (this.account && this.account.id), this.maint.plan); } catch {}
    this.note(`maintenance announced ("${text.slice(0, 80)}") — standing down in `
      + `${Math.max(0, Math.round((pauseAt - Date.now()) / 60000))}m, back about `
      + `${new Date(resumeAt).toLocaleTimeString()}`);
    return this.maint.plan;
  }

  // "in 15 minutes", "in 5 mins", "15 minutes" -> 15
  static minutesFrom(text) {
    const m = String(text).match(/(?:in\s+)?(\d{1,3})\s*(?:minutes?|mins?|m)\b/i);
    if (m) return Math.min(180, Number(m[1]));
    const h = String(text).match(/(?:in\s+)?(\d{1,2})\s*(?:hours?|hrs?)\b/i);
    if (h) return Math.min(180, Number(h[1]) * 60);
    return null;
  }

  // Start the protocol by hand, for a window you know about but we did not see
  // announced. `inMin` is how long until it begins.
  planMaintenance(inMin = Session.ANNOUNCE_LEAD_MIN, windowMin = Session.WINDOW_MIN) {
    const startsAt = Date.now() + Number(inMin) * 60000;
    this.maint.plan = {
      text: 'planned by hand', announcedAt: Date.now(), startsAt,
      pauseAt: startsAt - Session.PRE_PAUSE_MIN * 60000,
      resumeAt: startsAt + Number(windowMin) * 60000,
      source: 'manual',
    };
    try { this.settings().set('maintPlan:' + (this.account && this.account.id), this.maint.plan); } catch {}
    this.note(`maintenance planned by hand — standing down at `
      + `${new Date(this.maint.plan.pauseAt).toLocaleTimeString()}, back about `
      + `${new Date(this.maint.plan.resumeAt).toLocaleTimeString()}`);
    return this.maint.plan;
  }

  clearMaintenancePlan() {
    this.maint.plan = null;
    this.maint.nextLoginAt = 0;
    try { this.settings().set('maintPlan:' + (this.account && this.account.id), null); } catch {}
    this.note('maintenance plan cleared');
  }

  // Where the plan says we are right now.
  planPhase(now = Date.now()) {
    const p = this.maint.plan;
    if (!p) return 'none';
    if (now < p.pauseAt) return 'before';      // carry on as normal
    if (now < p.resumeAt) return 'standdown';  // no logins at all
    return 'recovering';                        // port probe + spaced logins
  }

  // Is the game port accepting connections at all? A TCP handshake and nothing
  // more — no version, no login — so this can be run often without cost.
  portOpen(timeoutMs = 5000) {
    return new Promise(async (resolve) => {
      let host, port;
      try {
        const env = loadEnv();
        const cfg = await getServerConfig((this.account && this.account.server) || env.EVONY_SERVER || 'ss71');
        host = cfg.host; port = cfg.port || 443;
      } catch { return resolve(false); }
      const sock = require('net').connect(port, host);
      const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
      sock.setTimeout(timeoutMs);
      sock.on('connect', () => done(true));
      sock.on('error', () => done(false));
      sock.on('timeout', () => done(false));
    });
  }

  // Network-level refusals mean the far end is gone; anything else is ours.
  noteConnectError(err) {
    const code = (err && (err.code || '')) || '';
    const netLevel = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EAI_AGAIN|ENOTFOUND/.test(code)
      || /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|timed out/i.test(String(err && err.message));
    if (netLevel) { this.maint.netFails++; this.maint.lastNetError = code || 'timeout'; }
    else this.maint.netFails = 0;
    this.refreshMaintenance();
  }

  noteConnectOk() {
    if (this.maint.netFails || this.maint.active) {
      this.maint.netFails = 0;
      this.refreshMaintenance();
    }
  }

  // True when we should hold off entirely.
  get paused() { return this.maint.active && !this.maint.override; }

  setMaintenanceOverride(on) {
    this.maint.override = !!on;
    this.note(`maintenance override ${this.maint.override ? 'ON — the bot will keep working through maintenance' : 'OFF — the bot will pause during maintenance'}`);
    return this.maint;
  }

  stopSupervisor() { if (this._supervisor) { clearInterval(this._supervisor); this._supervisor = null; } }

  // ---- goal engine ----
  // The console used to expose an engineMode toggle that nothing read. This is
  // the loop that honours it: one tick per interval while the socket is up, in
  // plan mode (report only) or live mode (acts).
  startEngine({ tickMs = Number(process.env.TICK_MS || 60000) } = {}) {
    if (this._engineTimer) return;
    this._engineTimer = setInterval(async () => {
      if (this.engineMode === 'off' || this._ticking || !this.connected) return;
      if (this.paused) return;            // no orders while the server is down
      this._ticking = true;
      try {
        const { Engine } = require('./engine');
        const acctId = this.account && this.account.id;
        // Rebuilt when the socket or the account changes, so it never holds a
        // dead Game; in-memory timers carry across.
        if (!this.engine || this.engine.game !== this.game || this.engine.accountId !== acctId) {
          const prev = this.engine && this.engine.state;
          this.engine = new Engine(this.game, (m) => this.note(m), acctId);
          if (prev) this.engine.state = prev;
        }
        this.engine.dryRun = this.engineMode !== 'live';
        await this.engine.tick();
        this.lastTickAt = Date.now();
        this.ticks = (this.ticks || 0) + 1;
      } catch (e) {
        this.note('engine tick: ' + e.message);
      } finally { this._ticking = false; }
    }, tickMs);
    this.note(`goal engine loop started (tick ${Math.round(tickMs / 1000)}s, mode ${this.engineMode})`);
  }

  stopEngine() { if (this._engineTimer) { clearInterval(this._engineTimer); this._engineTimer = null; } }

  // Focus a specific account from the Director (credentials come from accounts.json).
  async switchTo(acc) {
    this.note(`focusing ${acc.label || acc.email}`);
    this.account = acc;
    this.chat = { alliance: [], world: [], private: [], system: [] };
    this.reports = [];
    try { if (this.game) this.game.close(); } catch {}
    this.game = null;
    await this.connect();
    return this.header();
  }

  async connect() {
    if (this.connected) return this.game;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const env = loadEnv();
      const acc = this.account;
      let proxy = null;
      if (acc && acc.proxy) { try { proxy = require('./proxy').parseProxy(acc.proxy); } catch {} }
      const g = new Game((m) => this.note(m));
      await g.connect(
        (acc && acc.server) || env.EVONY_SERVER || 'ss71',
        (acc && acc.email) || env.EVONY_EMAIL,
        (acc && acc.password) || env.EVONY_PASSWORD,
        proxy,
      );
      this.wire(g);
      this.game = g;
      this.lastError = null;

      // If we connected from .env rather than an explicit Director pick, work out
      // which account this is so the Director knows to skip polling it.
      if (!this.account) {
        try {
          const mine = D.accounts.byEmail(env.EVONY_EMAIL || '');
          if (mine) { this.account = mine; this.bindOrg(); }
        } catch {}
      }
      // Keep the city registry honest on every login. This can only ADD
      // protected rows or promote a flat we ourselves claimed — it can never
      // make an existing city abandonable. See goal-buildnpc.js.
      if (this.account && this.account.id) {
        try {
          const list = (g.castles || []).map((c) => {
            const xy = (g.castleXY && g.castleXY(c)) || {};
            return { fieldId: c.fieldId, castleId: g.castleId(c), name: c.name, x: xy.x, y: xy.y };
          });
          const r = this.org.registry.reconcile(this.account.id, list);
          for (const a of r.added) {
            this.note(a.promoted
              ? `city registry: ${a.name} promoted to a buildnpc city (field ${a.fieldId})`
              : `city registry: ${a.name || 'city'} recorded as ${a.origin} and PROTECTED (field ${a.fieldId})`);
          }
        } catch (e) { this.note('city registry: ' + e.message); }
      }

      this.lastPingAt = Date.now();
      this.state = 'connected';
      this.disconnectReason = null;
      g.c.on('log', (m) => {
        if (/closed/.test(m)) {
          this.state = 'reconnecting';
          this.disconnectReason = this.disconnectReason || 'the server closed the connection';
          this.nextTryAt = Date.now() + 2000;      // first retry is quick
          this.note('socket closed — supervisor will reconnect');
        }
        if (/ignoring this account/.test(m)) {
          this.disconnectReason = 'server is ignoring this account (rate limited) — backing off';
        }
      });
      // an explicit kick means something else logged in as this account
      g.c.on('cmd', (cmd) => {
        if (cmd === 'server.KickedOut') {
          this.disconnectReason = 'kicked — another client logged in to this account';
          this.note(this.disconnectReason);
        }
      });
      this.note('session ready');
      return g;
    })().catch((e) => { this.lastError = e.message; this.note('connect failed: ' + e.message); throw e; })
      .finally(() => { this.connecting = null; });
    return this.connecting;
  }

  wire(g) {
    g.c.on('cmd', (cmd, data) => {
      if (!data) return;
      const strip = (s) => String(s || '').replace(/<[^>]*>/g, '');
      // This build sends nearly all chat as server.ChannelChatMsg with a
      // `channel` field and `fromUser` — including an echo of your own messages.
      const who = (d) => d.fromUser || d.userName || d.senderName || d.name || '';
      const bucketFor = (ch) => {
        const s = String(ch || '').toLowerCase();
        if (s.includes('alli')) return 'alliance';
        if (s.includes('priv') || s.includes('whisper')) return 'private';
        if (s.includes('sys')) return 'system';
        return 'world';
      };

      switch (cmd) {
        case 'server.ChannelChatMsg':
          push(this.chat[bucketFor(data.channel)], { t: Date.now(), from: who(data), msg: strip(data.msg), channel: data.channel });
          break;
        case 'server.AllianceChatMsg':
          push(this.chat.alliance, { t: Date.now(), from: who(data), msg: strip(data.msg) }); break;
        case 'server.WorldChatMsg':
          push(this.chat.world, { t: Date.now(), from: who(data), msg: strip(data.msg) }); break;
        case 'server.PrivateChatMessage':
          push(this.chat.private, { t: Date.now(), from: who(data), msg: strip(data.msg) }); break;
        case 'server.SystemInfoMsg': {
          const text = strip(data.msg);
          push(this.chat.system, { t: Date.now(), from: 'system', msg: text });
          // Every broadcast is kept, not just ones we recognise: the exact
          // wording of the maintenance warning is not documented anywhere, so
          // the log is how we learn it.
          try {
            this.settings().set('lastSystemMsgs', [
              { at: Date.now(), msg: text },
              ...(this.settings().get('lastSystemMsgs', []) || []).slice(0, 29),
            ]);
          } catch {}
          this.noteAnnouncement(text);
          break;
        }
        case 'server.NewReport':
          push(this.reports, { t: Date.now(), msg: `new report (army ${data.army_count || 0}, trade ${data.trade_count || 0}, other ${data.other_count || 0})` }); break;
        case 'server.ResourceUpdate': {
          const c = g.castles.find((x) => g.castleId(x) === data.castleId);
          if (c && data.resource) c.resource = data.resource;
          break;
        }
        case 'server.TroopUpdate': {
          const cid = data.castleId ?? data.caslteId;    // the server really does misspell it
          const c = g.castles.find((x) => g.castleId(x) === cid);
          if (c && data.troop) c.troop = data.troop;
          break;
        }
        case 'server.BuildComplate': {
          const c = g.castles.find((x) => g.castleId(x) === data.castleId);
          if (c && data.buildingBean) {
            const i = (c.buildings || []).findIndex((b) => b.positionId === data.buildingBean.positionId);
            if (i >= 0) c.buildings[i] = data.buildingBean; else (c.buildings = c.buildings || []).push(data.buildingBean);
          }
          this.note(`build complete: ${data.buildingBean && data.buildingBean.name}`);
          break;
        }
      }
    });
  }

  cities() {
    if (!this.game) return [];
    return this.game.castles.map((c) => {
      const xy = this.game.castleXY(c) || { x: 0, y: 0 };
      return { id: this.game.castleId(c), name: c.name, x: xy.x, y: xy.y };
    });
  }

  city(id) {
    if (!this.game) return null;
    const c = this.game.castles.find((x) => this.game.castleId(x) === Number(id)) || this.game.castles[0];
    if (!c) return null;
    const xy = this.game.castleXY(c) || {};
    const res = c.resource || {};
    const amt = (k) => Math.round(Number((res[k] && res[k].amount) || 0));
    const forts = {};
    for (const w of C.WALLS) forts[w.name] = Number((c.fortification || {})[w.beanKey] || 0);
    return {
      id: this.game.castleId(c), name: c.name, x: xy.x, y: xy.y,
      resources: {
        food: amt('food'), wood: amt('wood'), stone: amt('stone'), iron: amt('iron'),
        gold: Math.round(Number(res.gold || 0)),
        population: Math.round(Number(res.curPopulation || 0)),
        maxPopulation: Math.round(Number(res.maxPopulation || 0)),
        // workPeople = population employed on resource fields (NOT the Worker troop),
        // buildPeople = population tied up in construction; the rest is idle.
        employed: Math.round(Number(res.workPeople || 0)),
        building: Math.round(Number(res.buildPeople || 0)),
        idle: Math.max(0, Math.round(Number(res.curPopulation || 0) - Number(res.workPeople || 0) - Number(res.buildPeople || 0))),
      },
      // Troops in barracks order, every type listed even at zero, with the
      // CURRENT goal stage's target beside the count (not the final stage).
      troops: (() => {
        const stage = this.activeTroopStage(c);
        return C.TROOP_DISPLAY_ORDER.map((key) => ({
          key, name: (C.BY_KEY[key] || {}).name || key,
          count: Number((c.troop || {})[key] || 0),
          goal: stage && stage.targets ? Number(stage.targets[key] || 0) : null,
        }));
      })(),
      troopStage: this.activeTroopStage(c),
      fortifications: forts,

      // ---- general ----
      // The runtime resource object carries far more than ResourceBean lists:
      // `support` is loyalty, `texRate` the tax rate, and
      // usePACIFY_SUCCOUR_OR_PACIFY_PRAY says which comfort action this city is
      // set to. None of it is in the bean definitions.
      general: (() => {
        const p = (this.game && this.game.player) || {};
        const info = p.playerInfo || {};
        const STATUS = { 0: 'Normal', 1: 'Truce', 2: 'Under attack', 3: 'Occupied' };
        const played = info.registerTime ? Date.now() - Number(info.registerTime) : null;
        return {
          town: c.name,
          location: `${xy.x},${xy.y}`,
          fieldId: c.fieldId,
          status: STATUS[Number(c.status)] || String(c.status ?? '?'),
          hasEnemy: !!c.hasEnemy,
          gates: c.goOutForBattle ? 'Open' : 'Closed',
          allowAlliance: !!c.allowAlliance,
          population: Math.round(Number(res.curPopulation || 0)),
          maxPopulation: Math.round(Number(res.maxPopulation || 0)),
          idle: Math.max(0, Math.round(Number(res.curPopulation || 0)
            - Number(res.workPeople || 0) - Number(res.buildPeople || 0))),
          loyalty: Math.round(Number(res.support || 0)),
          complaint: Math.round(Number(res.complaint || 0)),
          // 1 = praying, 2 = disaster relief (PACIFY constants)
          comfortMode: Number(c.usePACIFY_SUCCOUR_OR_PACIFY_PRAY) === 2 ? 'Disaster relief' : 'Praying',
          taxRate: Number(res.texRate || 0),
          taxIncome: Math.round(Number(res.taxIncome || 0)),
          heroSalary: Math.round(Number(res.herosSalary || 0)),
          troopUpkeep: Math.round(Number(res.troopCostFood || 0)),
          prestige: Number(info.prestige || 0),
          honor: Number(info.honor || 0),
          rank: Number(info.ranking || 0),
          title: info.title || info.titleId || null,
          alliance: info.alliance || null,
          office: info.office || null,
          lord: info.userName || null,
          playedMs: played,
        };
      })(),

      // Valleys and flats this city holds. FieldBean: {id, level, name, statu, type}
      valleys: (c.fields || []).map((f) => {
        const fxy = C.fieldIdToCoords(Number(f.id));
        const t = C.FIELD_TYPES[Number(f.type)] || {};
        return {
          id: f.id, x: fxy.x, y: fxy.y,
          level: Number(f.level || 0),
          type: Number(f.type),
          kind: t.key || 'unknown',
          typeName: t.name || ('type ' + f.type),
          bonus: t.bonus ? `+${(t.base || 0) + (t.rate || 0) * Number(f.level || 0)}% ${t.bonus}` : null,
          buildable: !!t.buildable,
          name: f.name || null,
          status: Number(f.statu || 0),
          armies: (f.armys || []).length,
          distance: Math.round(Math.hypot(fxy.x - xy.x, fxy.y - xy.y) * 10) / 10,
        };
      }).sort((a, b) => a.distance - b.distance),

      slots: this.game.freeSlots ? this.game.freeSlots(c) : null,
      // Town Hall allocation: labour on each field comes out of population.
      production: ['food', 'wood', 'stone', 'iron'].map((k) => ({
        resource: k,
        labour: Math.round(Number((res[k] && res[k].workPeople) || 0)),
        rate: Math.round(Number((res[k] && res[k].increaseRate) || 0)),
      })),
      tax: Math.round(Number(res.texRate || 0)),

      // What is under construction right now, and what is queued behind it.
      construction: [
        ...(c.buildings || [])
          .filter((b) => Number(b.endTime || 0) > Date.now())
          .map((b) => ({
            name: b.name, level: b.level, positionId: b.positionId,
            endTime: Number(b.endTime), secsLeft: Math.max(0, Math.round((Number(b.endTime) - Date.now()) / 1000)),
            state: 'building',
          })),
        ...(c.buildingQueues || []).map((q) => ({
          name: q.name, level: q.level, positionId: q.positionId,
          costTime: Number(q.costTime || 0), state: 'queued',
        })),
      ],

      // Resources on their way in, with where each lot is coming from.
      incoming: (() => {
        const TR = { 0: 'food', 1: 'wood', 2: 'stone', 3: 'iron' };
        const out = {};
        for (const k of ['food', 'wood', 'stone', 'iron', 'gold']) out[k] = { total: 0, sources: [] };

        for (const t of c.transingTrades || []) {
          const key = TR[Number(t.resType)];
          if (!key) continue;
          const amt = Number(t.amount || 0);
          out[key].total += amt;
          out[key].sources.push({ kind: 'market purchase', amount: amt, eta: Number(t.endTime || 0) });
        }

        // own transports heading to this city (missionType 1 = transport)
        for (const a of (this.game && this.game.player && this.game.player.selfArmys) || []) {
          if (Number(a.missionType) !== 1) continue;
          if (c.fieldId !== undefined && Number(a.targetFieldId) !== Number(c.fieldId)) continue;
          const r = a.resource || {};
          for (const k of ['food', 'wood', 'stone', 'iron', 'gold']) {
            const amt = Number(r[k] || 0);
            if (amt > 0) {
              out[k].total += amt;
              out[k].sources.push({ kind: 'transport from ' + (a.startPosName || 'another city'), amount: amt, eta: Number(a.reachTime || 0) });
            }
          }
        }
        return out;
      })(),
      // Buildings grouped by type: "Ironmine  3  10,9,9". Types you don't own show qty 0.
      buildings: C.BUILDING_DISPLAY_ORDER.map((name) => {
        const def = C.BUILDING_BY_CODE[name.toLowerCase().replace(/[^a-z]/g, '')];
        const mine = (c.buildings || []).filter((b) => def && b.typeId === def.typeId);
        return {
          name,
          qty: mine.length,
          levels: mine.map((b) => Number(b.level || 0)).sort((a, b) => b - a),
          outside: !!(def && def.outside),
        };
      }),
      // Hero items apply a TIMED PERCENTAGE buff, not a permanent stat change:
      // the hero carries powerBuffAdded / managementBuffAdded / stratagemBuffAdded
      // as a percent, plus a `buffs` array with the description and an endTime.
      // Reading only `power` is why using an Excalibur looked like it did
      // nothing — the base is untouched and the bonus lives beside it.
      heroes: (c.heros || []).map((h) => {
        const pct = (k) => Number(h[k + 'BuffAdded'] || 0);
        const eff = (k) => Math.round(Game.attrValue(h, k) * (1 + pct(k) / 100));
        const buffs = (h.buffs || []).map((b) => ({
          type: b.typeId, text: b.descName,
          endTime: Number(b.endTime || 0),
          msLeft: Math.max(0, Number(b.endTime || 0) - Date.now()),
        }));
        return {
          name: h.name, level: h.level, loyalty: h.loyalty,
          attack: Game.attrValue(h, 'power'),
          politics: Game.attrValue(h, 'management'),
          intel: Game.attrValue(h, 'stratagem'),
          attackBuff: pct('power'), politicsBuff: pct('management'), intelBuff: pct('stratagem'),
          attackEff: eff('power'), politicsEff: eff('management'), intelEff: eff('stratagem'),
          buffs,
          experience: Number(h.experience || 0),
          upgradeExp: Number(h.upgradeExp || 0),
          unspent: h.remainPoint || 0, status: h.status,
        };
      }),
      queues: { building: (c.buildingQueues || []).length },
    };
  }

  // Which troop-goal stage is this city currently working on?
  activeTroopStage(c) {
    try {
      const { parseGoals } = require('./goals');
      const { troopPlan } = require('./engine');
      const id = this.game ? this.game.castleId(c) : null;
      const entry = this.org.goals.find(this.account && this.account.id, [id, c.name], 'goal');
      if (!entry) return null;
      const parsed = parseGoals(entry.src);
      const plan = troopPlan({ castle: c, goals: parsed.goals, config: parsed.config });
      if (!plan || !plan.targets) return plan && plan.done ? { done: true, note: plan.note } : null;
      return { stageIndex: plan.stageIndex, stageCount: plan.stageCount, targets: plan.targets, note: plan.note };
    } catch { return null; }
  }

  // A snapshot of this account, rebuilt at most every SNAP_MS. The Director
   // picks it up off /api/session and files it, which is how a console-held
   // account gets any history at all.
  snapshot(maxAgeMs = Number(process.env.SNAP_MS || 5 * 60000)) {
    if (!this.connected) return null;
    if (this._snap && Date.now() - this._snap.at < maxAgeMs) return this._snap;
    try {
      this._snap = buildSnapshot(this.game, {
        source: 'console',
        accountId: this.account && this.account.id,
      });
    } catch (e) { this.note('snapshot failed: ' + e.message); return this._snap || null; }
    return this._snap;
  }

  marches() { return this.connected ? marches(this.game) : []; }

  header() {
    const p = this.game && this.game.player && this.game.player.playerInfo;
    return {
      connected: this.connected,
      state: this.connected ? 'connected' : (this.connecting ? 'connecting' : (this.state || 'offline')),
      reason: this.connected ? null : (this.disconnectReason || this.lastError || null),
      retryInSec: this.connected ? null : Math.max(0, Math.round(((this.nextTryAt || 0) - Date.now()) / 1000)),
      attempt: this.attempt || 0,
      lastError: this.lastError,
      engineMode: this.engineMode,
      account: this.account ? { id: this.account.id, label: this.account.label } : null,
      coins: p ? p.medal : null,      // "game coins" / cents
      server: (this.account && this.account.server) || (loadEnv().EVONY_SERVER || 'ss71'),
      lord: p ? p.userName : null,
      prestige: p ? p.prestige : null,
      honor: p ? p.honor : null,
      rank: p ? p.ranking : null,
      serverTime: this.game ? this.game.now() : Date.now(),
      serverClock: this.game ? this.game.serverClock() : null,
      clockOffset: this.game ? this.game.serverOffset : 0,
      idleMs: this.game ? this.game.idleMs : null,
      ticks: this.ticks || 0,
      lastTickAt: this.lastTickAt || null,
      logSeq: this.logSeq || 0,
      reconnects: this.reconnects || 0,
      snapshot: this.snapshot(),
      // This console's own process. Several accounts may share one process, so
      // `accounts` says how many this number is covering.
      proc: (() => {
        const m = process.memoryUsage();
        return {
          pid: process.pid,
          rssMb: +(m.rss / 1048576).toFixed(1),
          heapMb: +(m.heapUsed / 1048576).toFixed(1),
          externalMb: +(m.external / 1048576).toFixed(1),
          upSec: Math.round(process.uptime()),
          accounts: 1,
          node: process.version,
        };
      })(),
      maintenance: {
        active: this.maint.active,
        paused: this.paused,
        override: this.maint.override,
        state: this.maint.state,
        why: this.maint.reason,
        portDown: this.maint.portDown,
        since: this.maint.since,
        checkedAt: this.maint.checkedAt,
        error: this.maint.error,
        plan: this.maint.plan,
        phase: this.planPhase(),
        nextLoginAt: this.maint.nextLoginAt || null,
        loginTries: this.maint.loginTries || 0,
      },
    };
  }

  // Live scan of a square around a point. The server caps each request at 20x20,
  // so the box is tiled and the blocks are pipelined; replies echo their own
  // rectangle, so they can be matched up without ordering assumptions.
  async scanArea(cx, cy, radius) {
    const g = await this.connect();
    const BLOCK = 20;
    const x1 = Math.max(0, cx - radius), y1 = Math.max(0, cy - radius);
    const x2 = Math.min(799, cx + radius), y2 = Math.min(799, cy + radius);

    const blocks = [];
    for (let y = y1; y <= y2; y += BLOCK)
      for (let x = x1; x <= x2; x += BLOCK)
        blocks.push({ x1: x, y1: y, x2: Math.min(x + BLOCK - 1, x2), y2: Math.min(y + BLOCK - 1, y2) });

    const found = new Map();
    const terrain = new Map();          // "x,y" -> decoded tile
    let done = 0;
    const onCmd = (cmd, data) => {
      if (cmd !== 'common.mapInfoSimple') return;
      done++;
      for (const c of data.castles || []) found.set(c.id, c);
      // mapStr: 2 hex chars per tile, row-major (y outer, x inner) over the block
      if (typeof data.mapStr === 'string' && data.mapStr.length) {
        const w = data.x2 - data.x1 + 1;
        for (let yy = data.y1; yy <= data.y2; yy++) {
          for (let xx = data.x1; xx <= data.x2; xx++) {
            const idx = ((yy - data.y1) * w + (xx - data.x1)) * 2;
            const t = C.decodeTile(data.mapStr.substr(idx, 2));
            if (t) terrain.set(xx + ',' + yy, t);
          }
        }
      }
    };
    g.c.on('cmd', onCmd);
    for (const b of blocks) g.c.send('common.mapInfoSimple', b);
    const deadline = Date.now() + 20000;
    while (done < blocks.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    g.c.off('cmd', onCmd);

    const mine = new Set(g.castles.map((c) => c.fieldId));
    const tiles = [];

    // every tile in the box, terrain included — castles merge on top
    for (let yy = y1; yy <= y2; yy++) {
      for (let xx = x1; xx <= x2; xx++) {
        const t = terrain.get(xx + ',' + yy);
        if (!t) continue;
        tiles.push({
          x: xx, y: yy, id: C.coordsToFieldId(xx, yy),
          kind: t.key, typeName: t.name, level: t.level, desc: t.desc || null,
          dist: Math.round(Math.hypot(xx - cx, yy - cy) * 10) / 10,
        });
      }
    }
    const byXY = new Map(tiles.map((t) => [t.x + ',' + t.y, t]));

    for (const c of found.values()) {
      const xy = C.fieldIdToCoords(Number(c.id));
      const base = byXY.get(xy.x + ',' + xy.y) || { x: xy.x, y: xy.y, dist: Math.round(Math.hypot(xy.x - cx, xy.y - cy) * 10) / 10 };
      Object.assign(base, {
        id: c.id, name: c.name, userName: c.userName, allianceName: c.allianceName,
        prestige: Number(c.prestige || 0), honor: Number(c.honor || 0),
        npc: !!c.npc, state: c.state, furlough: !!c.furlough, mine: mine.has(Number(c.id)),
        kind: c.npc ? 'npc' : 'player',
        typeName: c.npc ? 'NPC' : 'Player city',
      });
      if (!byXY.has(xy.x + ',' + xy.y)) { tiles.push(base); byXY.set(xy.x + ',' + xy.y, base); }
    }
    tiles.sort((a, b) => a.dist - b.dist);

    // feed the shared map cache so Director/find stay warm too
    try {
      const seen = Date.now();
      // Keep empty terrain too — flats are what buildnpc needs, and their level
      // is the level of the NPC that will end up on them.
      D.mapCache.upsertMany(tiles
        .filter((t) => t.userName || t.npc || t.kind === 'flat' || Number(t.type) === 10)
        .map((t) => ({ ...t, seen })));
    } catch (e) { this.note('map cache write failed: ' + e.message); }

    return { center: { x: cx, y: cy }, radius, blocks: blocks.length, scanned: done, tiles };
  }

  // Instant lookup from the cache (no login needed).
  searchCache(q) {
    const hits = D.mapCache.search(q, 300);
    return {
      total: D.mapCache.count(), updatedAt: D.mapCache.updatedAt(),
      hits: hits.map((c) => ({ ...c, ...C.fieldIdToCoords(Number(c.id)) })),
    };
  }

  async sendChat(channel, msg, target) {
    const g = await this.connect();
    if (channel === 'alliance') return g.req('common.allianceChat', { msg, languageType: 0 }, 8000).catch(() => ({ ok: 1 }));
    if (channel === 'world') return g.req('common.worldChat', { msg, languageType: 0 }, 8000).catch(() => ({ ok: 1 }));
    if (channel === 'private') return g.req('common.privateChat', { targetName: target, msg }, 8000).catch(() => ({ ok: 1 }));
    throw new Error('unknown channel ' + channel);
  }
}

module.exports = { Session };
