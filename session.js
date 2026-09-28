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
const MAINT = require('./maint');          // the fleet's shared word on maintenance

const RING = 400;
const push = (arr, item, cap = RING) => { arr.push(item); if (arr.length > cap) arr.shift(); };

// CommonConstants.UPDATE_TYPE_*: 0 add, 1 delete, 2 update, matched on id —
// the same rule Context.as applies to trades and trades in transit.
function applyUpdate(list, type, bean) {
  const cur = list || [];
  const rest = cur.filter((x) => x.id !== bean.id);
  if (Number(type) === 1) return rest;
  if (Number(type) === 0) return [...rest, bean];
  const i = cur.findIndex((x) => x.id === bean.id);
  if (i < 0) return [...cur, bean];
  const out = cur.slice();
  out[i] = { ...cur[i], ...bean };
  return out;
}

// The full stream (engine thinking and the protocol trace included) moves fast,
// so what the bot actually DID is kept in a ring of its own — otherwise a quiet
// night's actions scroll out behind a few hours of plan notes.
const LOG_RING = 1500;
const ACT_RING = 1000;

const { zoneOf } = C;

// PlayerInfoTypeManager.getTitle: titleId 0-9. The female forms are what the
// client shows a lady lord (sex 1) — NEAT's "Prinzessin".
const TITLES = {
  0: ['Civilian', 'Civilian'], 1: ['Knight', 'Dame'], 2: ['Baronet', 'Baronetess'],
  3: ['Baron', 'Baroness'], 4: ['Viscount', 'Viscountess'], 5: ['Earl', 'Countess'],
  6: ['Marquis', 'Marchioness'], 7: ['Duke', 'Duchess'], 8: ['Furst', 'Furstin'],
  9: ['Prinz', 'Prinzessin'],
};

// Wall.as: every fortification takes space, and the walls hold
// 1k, 3k, 6k ... 55k by level — 500 * L * (L + 1).
const WALL_SPACE = { trap: 1, abatis: 2, arrowTower: 3, rollingLogs: 4, rockfall: 5 };
const wallCapacity = (level) => 500 * level * (level + 1);

// HeroConstants.as
// 2 is HeroConstants.HERO_GUARD_STATU: holding a valley. NEAT calls it Defend.
const HERO_STATUS = { 0: 'Idle', 1: 'Mayor', 2: 'Defend', 3: 'Marching', 4: 'Captured', 5: 'Returning', 8: 'Farming' };

// How long the per-city extras (queues, research, reinforcements, production)
// stay fresh. Each is one read-only request, only made while its tab is open.
const EXTRA_TTL = { queues: 15000, prod: 60000, reinf: 60000, research: 120000 };

function loadEnv() {
  const out = {};
  const p = path.join(__dirname, '.env');
  if (fs.existsSync(p)) for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2];
  }
  return out;
}

// GET one small text file over plain http, for battle logs on the game's
// report host: no redirects, a deadline, and a size cap.
function fetchText(url, { timeoutMs = 10000, maxBytes = 1 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    const req = require('http').get(url, { headers: { Accept: 'text/xml, */*' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(res.statusCode === 404
          ? "the game's report server does not have that battle log (it may have expired)"
          : `the game's report server answered ${res.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { reject(new Error('that battle log is too big to be a report')); req.destroy(); } else chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => { reject(new Error("the game's report server did not answer in time")); req.destroy(); });
    req.on('error', (e) => reject(new Error(`could not reach the game's report server: ${e.message}`)));
  });
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
    this.log = [];          // everything, see note()
    this.acts = [];         // act + sys only: what the Log tab shows
    this.chat = { alliance: [], world: [], private: [], system: [] };
    this.reports = [];
    this.engine = null;
    // The console's pause button — the only thing that stops the engine acting.
    // ENGINE_PAUSED=1 starts it paused, for a console started after a change to
    // what the goals do: everything else (the page, scripts, chat, the map) runs,
    // and the engine waits for Resume.
    this.userPaused = process.env.ENGINE_PAUSED === '1';
    this.xcache = new Map();          // `${castleId}:${kind}` -> { at, data, pending }
    this.packages = null;             // { at, available, total }
    this.diplo = null;                // { at, alliance, friendly, neutral, enemy } — see diplomacy()
    this._controlsMem = null;         // city controls when there is no org to keep them
    // Daily maintenance: the server publishes its own state in config.xml and
    // the real client refuses to log in while it reads ServerMaintaining. That
    // is the signal used here — a plain HTTP GET, no game traffic, so polling it
    // costs nothing and cannot trip the rate limiter.
    this.maint = {
      active: false, since: null, state: null, checkedAt: 0, error: null,
      portDown: false, netFails: 0, reason: null,
      plan: null, nextLoginAt: 0, loginTries: 0, nextProbeAt: 0, notedClosedAt: 0,
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

  // Keep the city registry honest: on every login, and after a teleport. This
  // can only ADD protected rows, promote a flat we ourselves claimed, or record
  // a move — it can never make an existing city abandonable. See goal-buildnpc.js.
  reconcileRegistry(g) {
    if (!this.account || !this.account.id || !g) return null;
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
        if (a.promoted) this.leaveBare(g, a.fieldId);
      }
      for (const m of r.moved) this.note(`city registry: ${m.name || 'city'} moved from field ${m.from} to ${m.to}`);
      return r;
    } catch (e) { this.note('city registry: ' + e.message); return null; }
  }

  // A city buildnpc built on a flat to hand back as an NPC is not a new city
  // of the account in NEAT's sense: it must stay empty until it is abandoned,
  // and a template that trains, builds or hires there could keep it from ever
  // qualifying (goal-buildnpc canAbandon). So it is given an EMPTY goal row of
  // its own, which also stops the engine copying the template in on its first
  // read (db.goals.seed). The account's global goals still run there.
  leaveBare(g, fieldId) {
    const acct = this.account && this.account.id;
    const c = (g.castles || []).find((x) => Number(x.fieldId) === Number(fieldId));
    if (!c || !this.org || !acct) return false;
    const id = String(g.castleId(c));
    if (this.org.goals.exact(acct, id, 'goal')) return false;
    this.org.goals.set(acct, id, 'goal', '');
    this.note(`${c.name || 'city'} was built by buildnpc to be handed back as an NPC: it gets no new-city template and no new-city script`,
      { city: c.name || null, kind: 'sys' });
    return true;
  }

  // A city founded or captured while we are connected (server.CastleUpdate,
  // updateType 0) — NEAT's "new city" moment (wiki: NewCityGoals, NewCityScript):
  //   * the city registry learns of it now, so buildnpc sees it mid-session and
  //     not only at the next login
  //   * with no goals of its own it gets the account's new-city template at once
  //     (the engine would copy it on its first read anyway; this way it is the
  //     template as it stands now, and the log says so)
  //   * the account's new-city script, if it has one, runs in it once
  // Returns what was done, for the tests.
  cityAdded(g, castle) {
    const G = require('./goallayers');
    const id = g.castleId(castle);
    const name = castle.name || `city ${id}`;
    const xy = (g.castleXY && g.castleXY(castle)) || {};
    const say = (m, kind = 'sys') => this.note(m, { city: castle.name || null, kind });
    const out = { castleId: id, seeded: false, had: false, bare: false, script: null };
    say(`new city: ${name}${xy.x !== undefined ? ` (${xy.x},${xy.y})` : ''} has joined the account`);
    this.reconcileRegistry(g);

    const acct = this.account && this.account.id;
    if (!this.org || !acct) {
      say(`new city ${name}: this console has no account to keep goals under, so no new-city template was applied`);
      return out;
    }
    const reg = this.org.registry.byCastleId(acct, id);
    if (reg && reg.origin === 'buildnpc' && reg.state === 'built') { out.bare = true; return out; }

    // the global goals run in every city, this one included
    const globals = ['prepend', 'append']
      .map((k) => [k, G.goalLines((this.org.goals.exact(acct, k, 'goal') || {}).src)]).filter(([, n]) => n > 0);
    const also = globals.length ? `; the global goals run there too (${globals.map(([k, n]) => `${n} ${k} line(s)`).join(', ')})` : '';

    const s = this.org.goals.seed(acct, id, castle.name, 'goal');
    out.seeded = s.seeded; out.had = s.had;
    if (s.had) {
      say(`new city ${name}: it already has goals of its own, so the new-city template was not applied${also}`);
    } else if (s.seeded) {
      const from = s.from.cityKey !== 'default' ? `the goals saved under "${s.from.cityKey}"`
        : s.from.accountId ? 'the new-city template' : 'the install-wide default goals';
      out.lines = G.goalLines(s.row && s.row.src);
      say(`new city ${name}: goals set from ${from}, ${out.lines} goal line(s) applied${also}`, 'act');
    } else {
      say(`new city ${name}: this account has no new-city template, so it starts with no goals of its own`
        + (also || '; with no global goals either, the engine leaves it alone'));
    }

    // NEAT's !NewCityScript.txt. Run by the console (server.js installs the
    // runner), a few seconds on, so the pushes that come with a new city land
    // before its first line reads them.
    const script = this.org.goals.exact(acct, 'newcity', 'script');
    if (script && String(script.src || '').trim()) {
      if (typeof this.runNewCityScript !== 'function') {
        out.script = 'no runner';
        say(`new city ${name}: the new-city script only runs under the console, so it was not run here`);
      } else {
        out.script = 'started';
        say(`new city ${name}: running the new-city script`, 'act');
        setTimeout(async () => {
          try {
            const r = await this.runNewCityScript(id, script.src, (m) => say(`new-city script: ${m}`, 'act'));
            if (r && r.errors && r.errors.length) {
              say(`new city ${name}: the new-city script has ${r.errors.length} error(s) and was not run — `
                + r.errors.slice(0, 3).map((e) => `line ${e.line}: ${e.error}`).join('; '));
            } else if (r && r.ok) {
              say(`new city ${name}: the new-city script ${r.stopped ? 'was stopped' : 'finished'} (${r.actions || 0} action(s))`);
            } else say(`new city ${name}: the new-city script did not run — ${(r && r.error) || 'no reason given'}`);
          } catch (e) { say(`new city ${name}: the new-city script failed — ${e.message}`); }
        }, Session.NEW_CITY_SCRIPT_DELAY_MS);
      }
    }
    return out;
  }

  // logSeq is monotonic; this.log is a ring whose length plateaus, so it cannot
  // tell you whether anything happened between two samples.
  //
  // Every line carries a city (or null) and a kind:
  //   act   the bot did something in the game — trained, bought, closed a gate
  //   plan  the engine thinking: per-city notes and dry-run [plan] lines
  //   sys   the session itself — connecting, maintenance, a setting changed
  //   net   the protocol trace: "-> login", rtt, clock offset
  // The Log tab reads act + sys, Engine reads plan, Debug reads the lot.
  //
  // `meta` is a city name, or { city, kind }. A line that arrives with no city
  // but starts "[CityName]" is filed under that city, which is how older
  // callers still land in the right place.
  note(m, meta = null) {
    this.logSeq = (this.logSeq || 0) + 1;
    const text = String(m);
    const o = typeof meta === 'string' ? { city: meta } : (meta || {});
    let tag = o.city || null;
    if (!tag) {
      const hit = text.match(/^\[([^\]]{1,24})\]\s*/);
      if (hit) tag = hit[1];
    }
    const line = { t: Date.now(), m: text, city: tag, kind: o.kind || 'sys' };
    push(this.log, line, LOG_RING);
    // The connection's own story also goes to the console's output (console-<id>.log),
    // stamped, so a drop can be traced after the fact — the Log above is memory only.
    if (line.kind === 'sys' && Session.CONN_NOTE.test(text)) {
      const d = new Date(line.t);
      console.log(`[conn] ${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')} ${text}`);
    }
    if (line.kind === 'act' || line.kind === 'sys') push(this.acts, line, ACT_RING);
  }

  // The lines behind each log tab. Reports are shaped like log lines so one
  // renderer (and one search) serves every tab.
  logSource(kind) {
    if (kind === 'reports') return this.reports;
    if (kind === 'activity') return this.acts;
    if (kind === 'engine') return this.log.filter((l) => l.kind === 'plan');
    return this.log;                      // 'debug' (and the old 'log')
  }

  logView(kind, { city = null, q = '', limit = 500 } = {}) {
    let lines = this.logSource(kind);
    if (city) lines = lines.filter((l) => l.city === city);
    // Filtering happens BEFORE the tail is taken, so a match further back is
    // still found instead of being cut off by the window.
    const find = String(q || '').trim().toLowerCase();
    if (find) lines = lines.filter((l) => String(l.m).toLowerCase().includes(find));
    return { lines: lines.slice(-limit), total: lines.length, cities: this.logCities(kind), filtered: !!(city || find) };
  }

  // Empty a log tab, or only its lines for one city.
  clearLog(kind = 'debug', city = null) {
    const keep = (l) => (city ? l.city !== city : false);
    let removed = 0;
    const strip = (name, match) => {
      const before = this[name].length;
      this[name] = this[name].filter((l) => !match(l) || keep(l));
      removed += before - this[name].length;
    };
    if (kind === 'reports') strip('reports', () => true);
    else if (kind === 'activity') strip('acts', () => true);
    else if (kind === 'engine') strip('log', (l) => l.kind === 'plan');
    else { strip('log', () => true); strip('acts', () => true); }
    // The note comes after the clear, or it would be wiped along with it.
    this.note(city ? `${kind} log cleared for ${city} (${removed} line(s))` : `${kind} log cleared (${removed} line(s))`);
    return removed;
  }

  // Every city that currently has lines, for the filter.
  logCities(kind = 'debug') {
    const seen = new Map();
    for (const l of this.logSource(kind)) {
      if (l.city) seen.set(l.city, (seen.get(l.city) || 0) + 1);
    }
    return [...seen.entries()].map(([city, count]) => ({ city, count }))
      .sort((a, b) => String(a.city).localeCompare(String(b.city), undefined, { numeric: true }));
  }

  get connected() { return !!(this.game && this.game.c && this.game.c.sock && !this.game.c.sock.destroyed); }

  // Switched off in the Director. Re-read from the database rather than trusting
  // the copy taken at startup: the switch is flipped in another process, and the
  // whole point of it is that this console stops logging in — an account may be
  // being played from another machine, and a console that keeps reconnecting
  // takes the login back off it every few seconds. Cached for a couple of
  // seconds so the supervisor's 5s tick is not a database read a tick.
  switchedOff() {
    const id = this.account && this.account.id;
    if (!id) return false;
    if (!this._offReadAt || Date.now() - this._offReadAt > 2000) {
      this._offReadAt = Date.now();
      // A read that fails keeps the last answer: a locked database must not be
      // read as "switched on" and start a login.
      try { const a = D.accounts.get(id); this._off = !!(a && a.enabled === false); } catch { /* keep it */ }
    }
    return !!this._off;
  }

  // Somebody else logged in to this account and the server kicked us. That is a
  // person wanting to play it, so the account is theirs for KICK_HOLD_MS: no
  // login of any kind until then — the supervisor, a page, a script and the
  // engine all wait it out — and only after that does the console take it back.
  // Kept in the account's settings, like a script's logout, so a console
  // restart does not end it early and the Director's poller can see it too.
  // Connect (/api/connect) ends it early.
  static KICK_HOLD_MS = Number(process.env.KICK_HOLD_MIN || 30) * 60000;

  // The account's own "after a kick, stay out N minutes" (the Director's ✎ / Accounts grid,
  // org setting kickHoldMin:<id>; the user, 2026-09-22). null = not set: an explicit kick
  // message holds KICK_HOLD_MS as before, and a bare server close reconnects straight away.
  // 0 = straight back in, always. N = stay out N minutes after either.
  // The hold GROWS while the account goes on being refused: the account's minutes are
  // the step, and each drop that follows without a login that HELD adds another step —
  // 5, 10, 15, 20 … (the user, 2026-09-22, for Lord02). Any login that lasts
  // SETTLED_MS puts it back to one step. The step is kept in the org's settings, like
  // the hold itself, so a console restart in the middle of a spell does not lose count.
  static KICK_HOLD_MAX_MIN = Number(process.env.OTTO_KICK_HOLD_MAX_MIN || 60);

  holdStep() {
    const id = this.account && this.account.id;
    if (!id) return 0;
    try { return Number(this.settings().get('kickHoldStep:' + id, 0)) || 0; } catch { return 0; }
  }

  setHoldStep(n) {
    const id = this.account && this.account.id;
    if (!id) return;
    try { this.settings().set('kickHoldStep:' + id, n || 0); } catch {}
  }

  // It got in and stayed in: the next hold starts at one step again.
  clearHoldStep() {
    if (!this.holdStep()) return;
    this.setHoldStep(0);
    const base = this.kickHoldMin();
    this.note(`it is in and staying in — the next hold starts at ${base || '?'} min again`);
  }

  kickHoldMin() {
    const id = this.account && this.account.id;
    if (!id) return null;
    if (!this._khmReadAt || Date.now() - this._khmReadAt > 5000) {
      this._khmReadAt = Date.now();
      try { const v = this.settings().get('kickHoldMin:' + id, null); this._khm = v === null || v === '' ? null : Number(v); } catch { /* keep the last answer */ }
    }
    return Number.isFinite(this._khm) && this._khm >= 0 ? this._khm : null;
  }

  kickHold() {
    const id = this.account && this.account.id;
    if (!id) return null;
    if (!this._kickReadAt || Date.now() - this._kickReadAt > 2000) {
      this._kickReadAt = Date.now();
      try { this._kick = this.settings().get('kickHold:' + id, null); } catch { /* keep the last answer */ }
    }
    const h = this._kick;
    return h && Number(h.until) > Date.now() ? h : null;
  }

  holdForKick(ip, { minutes = null, source = 'kick', why = null } = {}) {
    const at = Date.now();
    // An account's own minutes are one step of a ladder; the fleet-wide default is flat.
    let step = 0, mins = null;
    if (minutes !== null) {
      const base = Math.max(0, Number(minutes) || 0);
      // the ladder is capped, but never below the minutes you asked for: a base of
      // 300 means 300, whatever the cap says
      const cap = Math.max(base, Session.KICK_HOLD_MAX_MIN);
      const steps = base > 0 ? Math.max(1, Math.ceil(cap / base)) : 1;
      step = Math.min(this.holdStep() + 1, steps);
      mins = Math.min(base * step, cap);
      this.setHoldStep(step);
    }
    const ms = mins !== null ? mins * 60000 : Session.KICK_HOLD_MS;
    const hold = { at, until: at + ms, ip: ip || null, source, minutes: mins, step };
    this._kick = hold; this._kickReadAt = at;
    try { this.settings().set('kickHold:' + (this.account && this.account.id), hold); } catch {}
    this.nextTryAt = hold.until;
    this.disconnectReason = `kicked — ${why || 'another login took this account'}${ip ? ' from ' + ip : ''}; `
      + `staying out ${mins !== null ? `${mins} min, until ` : 'until '}${new Date(hold.until).toLocaleTimeString()}`
      + `${step > 1 ? ` — refused ${step} times in a row now, so the wait grew` : ''} — Connect takes it back now`;
    this.note(this.disconnectReason);
    this.emitEvent('kicked', { source, ip: ip || null, minutes: mins, until: hold.until, step });
    return hold;
  }

  // Somebody else logged in. The game's own client shows a window for this; ours has
  // to say it just as plainly, because it explains everything that follows (the user,
  // 2026-09-22). Kept in the org's settings so the page still shows it after a restart
  // and the Director can see it too.
  noteSomebodyElseLoggedIn(ip, cmd) {
    const at = Date.now();
    const rec = { at, ip: ip || null, cmd: cmd || null };
    this._lastKick = rec;
    try { this.settings().set('lastKick:' + (this.account && this.account.id), rec); } catch {}
    this.note(`ANOTHER USER HAS LOGGED INTO THIS ACCOUNT${ip ? ` from ${ip}` : ''}`
      + ' — that is the game kicking us out, not a network fault'
      + '. If it happens again within half an hour it is OUR OWN fleet, not NEAT:'
      + ' NEAT pauses 30 minutes when it is kicked (the user, 2026-09-22)');
  }

  // The last time somebody else took this account, hold or no hold.
  lastKick() {
    if (this._lastKick) return this._lastKick;
    try { return this.settings().get('lastKick:' + (this.account && this.account.id), null); } catch { return null; }
  }

  clearKickHold() {
    const had = this.kickHold();
    this._kick = null; this._kickReadAt = Date.now();
    try { this.settings().set('kickHold:' + (this.account && this.account.id), null); } catch {}
    if (had) this.note('kick hold ended early — Connect');
  }

  // ---- stability ----
  // The server drops idle sockets, and bursting reconnects gets the IP throttled,
  // so: heartbeat to stay warm, and back off hard when reconnecting.
  // Staged retry ladder: quick first, then progressively patient. Anything that
  // looks like server-side rate limiting starts further down the ladder.
  static BACKOFF = [30000, 60000, 120000, 300000, 600000];

  // ---- a console that keeps trying but never comes in ----
  // Lord02 spent five hours on 2026-09-22 logging in every ten seconds and being
  // dropped two seconds later (`server.ConnectionLost`), ~2,300 logins, playing
  // nothing. A login that does not HOLD is the same as no login, so both count as
  // trying: after ROTATE_AFTER_MS of it the console closes the socket, moves the
  // account to another proxy line (proxy-pick.js rotate) and starts again.
  // A connection that lasts SETTLED_MS is "in", and ends the spell.
  static SETTLED_MS = Number(process.env.OTTO_SETTLED_SEC || 120) * 1000;
  static ROTATE_AFTER_MS = Number(process.env.OTTO_PROXY_ROTATE_MIN || 10) * 60000;
  // Each move in the same spell waits longer than the last: when the proxy is not
  // what is wrong, this must not walk the account through the whole list in an hour.
  static ROTATE_MAX_MS = 60 * 60000;
  // And it rests before trying the new line. Rate limiting is per ACCOUNT, not per IP
  // (EVONY-RULES §1), and "a fresh login right after a drop can be ignored for a minute
  // or more — retrying fast keeps it blocked": a new IP is no reason to hurry, and a
  // move must never end up spending MORE logins than the ladder it restarts.
  static ROTATE_PAUSE_MS = Number(process.env.OTTO_PROXY_ROTATE_PAUSE_SEC || 60) * 1000;
  // Which notes are about the connection (they are also printed, see note()).
  // `port` and `maintenance` are here because a stand-down is otherwise SILENT: on
  // 2026-09-20 thirteen consoles sat waiting with nothing in their log since 08:54,
  // and there was no way to tell a console that was patiently waiting from one that
  // had died. What a console is doing through a maintenance has to be on the record.
  // `protection` is here for the same reason: what an account is under — holiday,
  // dream truce, truce, peace — and the moment it changes belongs on the record,
  // not only in the live view the Director reads (2026-09-23).
  static CONN_NOTE = /socket|heartbeat|reconnect|connect failed|session ready|ignoring|kick|standing down|server went down|back online|logging out|switched off|no traffic|refresh|logged in as|port|maintenance|protection/i;

  // Kept as a hook so tests can make the stagger deterministic.
  static rand() { return Math.random(); }

  // How long after a city appears its new-city script starts (cityAdded).
  static NEW_CITY_SCRIPT_DELAY_MS = 5000;

  // It is in, or it is legitimately out (switched off, a kick hold, maintenance,
  // a script's logout): either way it is not stuck, so the clock starts afresh.
  clearTrouble() {
    this.troubleSince = 0;
    this.troubleRotations = 0;
    this.troubleWaitMs = Session.ROTATE_AFTER_MS;
  }

  // One supervisor tick of "still not really in". Starts the clock the first time,
  // and once it has run long enough closes the socket, changes proxy and lets the
  // next tick log in. True when it did that, so the tick stops there.
  async rotateProxyIfStuck() {
    const now = Date.now();
    if (!this.troubleSince) { this.troubleSince = now; return false; }
    const wait = this.troubleWaitMs || Session.ROTATE_AFTER_MS;
    if (now - this.troubleSince < wait) return false;

    const mins = Math.round((now - this.troubleSince) / 60000);
    const why = `${mins} min without a login that held`;
    this.troubleSince = now;
    this.troubleRotations = (this.troubleRotations || 0) + 1;
    this.troubleWaitMs = Math.min(wait * 2, Session.ROTATE_MAX_MS);

    this.disconnectReason = `${why} — changing proxy and trying again`;
    if (this.connected) {
      this.note(`${mins} min logging in and being dropped again — closing the socket and changing proxy`);
      try { this.game.close(); } catch {}
    } else {
      this.note(`${mins} min trying to log in without getting in — changing proxy`);
    }

    let p = null;
    try {
      p = require('./proxy-pick').rotate(this.org, this.account, {
        note: (m) => this.note(m, { kind: 'sys' }), why,
      });
    } catch (e) { this.note('proxy: ' + e.message, { kind: 'sys' }); }
    this.note(p
      ? `now logging in through ${p.label} (change ${this.troubleRotations}) — resting ${Math.round(Session.ROTATE_PAUSE_MS / 1000)}s first,`
        + ` then another change in ${Math.round(this.troubleWaitMs / 60000)} min if this one does not hold either`
      : `staying on the same proxy and going on trying — resting ${Math.round(Session.ROTATE_PAUSE_MS / 1000)}s first`);

    // a fresh ladder, after a rest: the socket has to finish closing, and the account
    // may be the thing being refused rather than the IP
    this.attempt = 0;
    this.backoffMs = Session.BACKOFF[0];
    this.nextTryAt = now + Session.ROTATE_PAUSE_MS;
    this.state = 'reconnecting';
    this.disconnectReason = p
      ? `${why} — moved to ${p.label}`
      : `${why} — no other proxy line is free`;
    return true;
  }

  startSupervisor({ heartbeatMs = 60000, idleLimitMs = 150000, checkMs = 5000, pingMs = 30000 } = {}) {
    if (this._supervisor) return;
    this.attempt = 0;
    this.backoffMs = Session.BACKOFF[0];
    this.reconnects = 0;
    this.clearTrouble();
    this._supervisor = setInterval(async () => {
      try {
        if (this.connecting) return;

        // Switched off outranks everything below, including maintenance and a
        // script's logout: no socket, no login, no engine (it needs the socket),
        // for as long as the switch is off. This is what frees the account for
        // another machine to play.
        if (this.switchedOff()) {
          if (this.connected) {
            this.note('switched off in the Director — logging out and staying out');
            try { this.game.close(); } catch {}
          }
          this.state = 'off';
          this.disconnectReason = 'switched off in the Director';
          this.nextTryAt = 0;
          this.attempt = 0;
          this.backoffMs = Session.BACKOFF[0];
          this.clearTrouble();
          return;
        }

        // Kicked by another login: wait the hold out before anything else,
        // maintenance recovery logins included — a person is playing it.
        const kick = this.kickHold();
        // a hold started by a bare server close is only a GUESS that another login did it;
        // if the server turns out to be in maintenance instead, it was not a kick — drop the
        // hold so the maintenance return is not delayed
        if (kick && kick.source === 'close' && !this.connected) {
          await this.checkMaintenance();
          if (this.maint.active) { this.clearKickHold(); this.note('that close was maintenance, not a kick — the kick hold is dropped'); }
        }
        if (this.kickHold() && !this.connected) {
          this.state = 'kicked';
          this.disconnectReason = this.disconnectReason && /^kicked/.test(this.disconnectReason)
            ? this.disconnectReason
            : `kicked by another login at ${new Date(kick.at).toLocaleTimeString()} — leaving it to them until ${new Date(kick.until).toLocaleTimeString()}`;
          this.nextTryAt = Number(kick.until);
          this.attempt = 0;
          this.backoffMs = Session.BACKOFF[0];
          this._kickWaiting = true;
          this.clearTrouble();          // somebody else is playing it, not a stuck console
          return;
        }
        if (this._kickWaiting && !kick) {
          this._kickWaiting = false;
          this.disconnectReason = null;
          this.nextTryAt = 0;
          this.note('the kick hold is over — logging back in');
        }

        this.checkMaintenance();          // fire and forget; result is cached

        // A maintenance race (monitor or follower) outranks the stand-down below.
        if (await this.maintRace()) return;

        // During maintenance the server refuses logins. Retrying through it
        // burns the backoff ladder and can leave us throttled exactly when it
        // comes back, so stand down and wait.
        // A planned stand-down outranks everything: no logins at all while the
        // window is open, because login attempts into maintenance are what we
        // believe earned the block in the first place.
        //
        // The plan does not have to be this console's own find: another console
        // hearing the announcement, or the Director watching the fleet drop at
        // once, puts the window up for everyone (maint.js). Without this an
        // account on holiday — which the server never tells — spends the whole
        // maintenance on the reconnect ladder (2026-09-23).
        this.adoptFleetMaintenance();
        this.releaseIfFleetBack();
        const phase = this.planPhase();
        // A script's logout (logout.js) was asked for, so the maintenance
        // override does not cancel it; Connect does.
        const loggedOut = !!(this.maint.plan && this.maint.plan.source === 'logout');
        if (phase === 'standdown' && (!this.maint.override || loggedOut)) {
          const back = new Date(this.maint.plan.resumeAt).toLocaleTimeString();
          if (this.connected) { this.note(loggedOut ? `logging out until ${back}, as the script asked` : 'standing down for maintenance'); try { this.game.close(); } catch {} }
          this.state = loggedOut ? 'loggedout' : 'maintenance';
          this.disconnectReason = loggedOut ? `${this.maint.plan.text} until ${back} — Connect ends it early` : 'standing down for announced maintenance';
          this.maint.loginTries = 0;
          this.maint.nextLoginAt = this.maint.plan.resumeAt;
          if (loggedOut) this.nextTryAt = this.maint.plan.resumeAt;
          this.clearTrouble();          // it is not trying to get in — it is told not to
          return;
        }
        if (phase === 'recovering' && !this.connected && (!this.maint.override || loggedOut)) {
          this.clearTrouble();          // waiting for the server, not stuck on a proxy
          this.state = loggedOut ? 'loggedout' : 'maintenance';
          this.disconnectReason = loggedOut ? 'logging back in after the script\'s logout' : 'waiting for the server to come back';
          const nowR = Date.now();
          // A login that failed holds every check back: a login is the scarce thing.
          if (nowR < (this.maint.nextLoginAt || 0)) return;
          // The port check is free (a TCP handshake through the account's proxy), so
          // it runs often: the announced end is only an estimate and the server is
          // usually a few minutes late. Only a port that answers earns a login.
          if (nowR < (this.maint.nextProbeAt || 0)) return;
          this.maint.nextProbeAt = nowR + Session.PROBE_EVERY_MS;
          if (!(await this.portOpen())) {
            // one line every few minutes, not one per probe
            if (nowR - (this.maint.notedClosedAt || 0) > Session.PROBE_NOTE_EVERY_MS) {
              this.maint.notedClosedAt = nowR;
              this.note(`port still closed — checking every ${Math.round(Session.PROBE_EVERY_MS / 1000)}s until it answers`);
            }
            return;
          }
          this.maint.nextLoginAt = Date.now() + Session.RETRY_EVERY_MIN * 60000;
          this.maint.loginTries++;
          // Every console of the fleet sees the port open within the same few
          // seconds. Spread the logins so they do not arrive as one burst.
          const stagger = Math.floor(Session.rand() * Session.RETURN_STAGGER_MS);
          this.note(`port is open — login attempt ${this.maint.loginTries} after maintenance`
            + (stagger > 999 ? ` in ${Math.round(stagger / 1000)}s` : ''));
          if (stagger) await new Promise((r) => setTimeout(r, stagger));
          try {
            await this.connect();
            this.noteConnectOk();
            this.state = 'connected'; this.disconnectReason = null;
            const was = this.maint.plan;
            // back from maintenance (not a script's logout): NPC farming forgets
            // its history, as NEAT does after it relogs (goal-npc, wiki Npc)
            if (!was || was.source !== 'logout') this.maintEndedAt = Date.now();
            this.clearMaintenancePlan();
            this.note(was && was.source === 'logout'
              ? `back online after the script's logout — ${this.game.castles.length} city(ies), ${was.citiesBefore ?? '?'} before it`
              : 'back online after maintenance');
            if (!was || was.source !== 'logout') this.noteMaintenanceEnded();
          } catch (e) {
            this.note(`still not accepting us — next attempt in ${Session.RETRY_EVERY_MIN}m`);
          }
          return;
        }

        if (this.paused) {
          if (this.connected) { this.note('server went down — closing the socket'); try { this.game.close(); } catch {} }
          this.clearTrouble();          // the server is down for everyone — no proxy fixes that
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
            this.maintEndedAt = Date.now();          // see the maintenance recovery above
            this.note('back online');
            this.noteMaintenanceEnded();
          } catch (e) { this.noteConnectError(e); }
          return;
        }

        if (!this.connected) {
          // Ten minutes of this and the proxy changes — before the ladder's own wait,
          // so a console parked on a 10-minute backoff still gets its move on time.
          if (await this.rotateProxyIfStuck()) return;
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

        // connected — but is it IN? A login that holds for SETTLED_MS is; one that is
        // dropped again seconds later is not, and the spell goes on counting until
        // rotateProxyIfStuck moves it (the flapping of 2026-09-22).
        if (Date.now() - (this.connectedSince || 0) >= Session.SETTLED_MS) { this.clearTrouble(); this.clearHoldStep(); }
        else if (await this.rotateProxyIfStuck()) return;

        // connected: has it gone quiet for too long?
        if (this.game.idleMs > idleLimitMs) {
          this.disconnectReason = `no traffic for ${Math.round(this.game.idleMs / 1000)}s — we closed the socket`;
          this.note(`no traffic for ${Math.round(this.game.idleMs / 1000)}s — cycling the socket`);
          try { this.game.close(); } catch {}
          return;
        }

        // The heartbeat proves the server still answers us. A reply to any of our
        // own commands proves the same, so while those keep coming it isn't sent:
        // it would only queue behind them (the server takes an account's commands
        // about one at a time) and, timing out there, cycle a working socket —
        // what dropped Lord06 again and again on 2026-09-18.
        if (Date.now() - (this.lastPingAt || 0) > heartbeatMs) {
          this.lastPingAt = Date.now();
          const c = this.game.c || {};
          if (c.lastReplyAt && Date.now() - c.lastReplyAt < heartbeatMs) return;
          const sentAt = Date.now();
          try { await this.game.ping(pingMs); }
          catch (e) {
            // busy, not dead: something else of ours was answered while it waited
            if (c.lastReplyAt && c.lastReplyAt > sentAt) {
              this.note(`heartbeat slow (over ${Math.round(pingMs / 1000)}s) but the server is still answering — keeping the socket`
                + ` (${this.game.pipeInFlight ? this.game.pipeInFlight() : 0} market writes in flight)`);
              return;
            }
            const inflight = this.game.pipeInFlight ? this.game.pipeInFlight() : 0;
            this.disconnectReason = `no reply to the heartbeat in ${Math.round(pingMs / 1000)}s — we closed the socket`;
            this.note(`heartbeat failed (no reply in ${Math.round(pingMs / 1000)}s, ${inflight} market writes in flight) — cycling the socket`);
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
      this.armRaceFromServer();
      this.emitEvent('maintenance', { phase: 'down', reason: this.maint.reason });
    } else if (!this.maint.active && was) {
      const mins = Math.round((Date.now() - (this.maint.since || Date.now())) / 60000);
      this.maint.since = null;
      this.note(`server is back after about ${mins} minute(s) — resuming`);
      this.emitEvent('maintenance', { phase: 'up', minutes: mins });
      this.noteMaintenanceEnded();
    }
    return this.maint;
  }

  // A maintenance has ended. Every way back calls this — the server-is-back
  // transition, the monitor and the followers of a maintenance race, the recovery
  // ladder, the paused probe — because which one a console takes depends on how
  // it came through the window. It is only WRITTEN down here: at the moment the
  // server returns a console may not know yet that its account is on holiday, so
  // holidayRun applies it once the holiday is confirmed. One maintenance a day.
  noteMaintenanceEnded() {
    const id = this.account && this.account.id;
    if (!id) return;
    try { this.settings().set('maintEnded:' + id, { day: new Date().toISOString().slice(0, 10), at: Date.now() }); } catch { /* not counted */ }
    // Tell the fleet the server is back — but only on a login that actually
    // holds. A guess here sends every console into a closed server, and a
    // signal that never arrives strands them all instead (EVONY-RULES.md
    // section 2, 2026-09-20): every way back in writes it now, not just the
    // maintenance monitor of the old race.
    if (this.connected) {
      try {
        MAINT.signalBack(this.settings(), (this.account && this.account.server) || 'ss71');
        this._fleetMaint = null;
      } catch { /* the others fall back to their own port probe */ }
    }
    this.holidayRun();
  }

  // How long this account has been on holiday, in MAINTENANCES rather than in
  // hours. A holidayed account's resources are put back at every maintenance to
  // what they were at the one before, so what matters is whether it has been on
  // holiday across a maintenance boundary at all: until it has, there is no
  // earlier amount to be put back to. Holiday mode gives no start time — only
  // how much protection is left — so this is counted by watching: `since` is
  // when a console first saw the holiday, and `maints` counts the maintenances
  // that ended while it was still on. Both are kept in the account's own
  // settings, so a console restart does not lose the count, and both are dropped
  // the moment the holiday ends.
  holidayRun() {
    const id = this.account && this.account.id;
    if (!id) return null;
    const key = 'holidayRun:' + id;
    let rec = null, ended = null;
    try { rec = this.settings().get(key, null); ended = this.settings().get('maintEnded:' + id, null); } catch { return null; }
    const on = !!(this.game && this.game.holiday)
      || (((require('./buffs').protectionOf(this.game) || {}).kind) === 'holiday');
    if (!on) {
      // Only what a console can SEE counts as the holiday being over: while it
      // is offline it knows nothing, and must not throw the count away.
      if (rec && this.connected) { try { this.settings().set(key, null); } catch { /* kept next time */ } }
      if (this.connected) this.warnNoGoalFile();
      return this.connected ? null : rec;
    }
    const next = rec && rec.since ? { ...rec } : { since: Date.now(), maints: 0 };
    // The last maintenance that ended, counted once. A holiday first seen up to two
    // hours after it ended counts it too: a console restarted after a maintenance
    // sees an old holiday for the first time then, and a holiday cannot be begun
    // while the server is down.
    if (ended && ended.day && next.lastMaint !== ended.day && Number(next.since) <= Number(ended.at) + 2 * 3600000) {
      next.maints = Number(next.maints || 0) + 1;
      next.lastMaint = ended.day;
      this.note(`on holiday through ${next.maints} maintenance(s) now — its resources are put back at each one`);
    }
    next.seenAt = Date.now();
    this.holidayGoalFile();
    const changed = !rec || rec.since !== next.since || Number(rec.maints || 0) !== Number(next.maints || 0) || rec.lastMaint !== next.lastMaint;
    if (changed) { try { this.settings().set(key, next); } catch { /* shown anyway */ } }
    return next;
  }
  // ON HOLIDAY: MAKE SURE THE ACCOUNT HAS ITS GOALS (the user, 2026-09-24: "if a bot logs
  // in it should check holidaymode yes/no — if its yes it should always automatically load
  // the goal files (prepend file). We cant get caught with one of our accs not having
  // goals.")
  //
  // WHY THE HOLIDAY GATE, and why it is not simply "always". Goals are emptied ON PURPOSE
  // in the hours BEFORE an account goes on holiday: a queued build or troop batch makes the
  // game refuse the holiday (ok=-25 — the evony-holiday-prep skill), so the prep empties the
  // goals and cancels the queues first. Reloading them in that window would put the queues
  // straight back and block the holiday. The moment the holiday is actually ON that reason
  // is gone, and an account left empty is one that comes back off holiday with nothing to
  // do — which is how Lord07 and Lord16 were found a day behind the fleet prepend on
  // 2026-09-24. So: holiday confirmed -> name the fleet's prepend file if this account
  // names none, and load it now rather than waiting on the Director's 15 s sync, which only
  // runs if the Director is up at all.
  //
  // It only ever ADDS: the file is the source of a prepend (goalfiles.js), so loading it
  // cannot empty anything, and an account that already names a file is left to the Director.
  // An account NOT on holiday that names no file is only WARNED about, once — it may be
  // mid-prep, and that is the user's doing.
  holidayGoalFile() {
    if (!this.connected || !this.org || !this.account || !this.account.id) return null;
    if (Date.now() - (this._goalFileAt || 0) < Session.GOAL_FILE_GAP_MS) return null;
    this._goalFileAt = Date.now();
    const GF = require('./goalfiles');
    try {
      let file = GF.fileOf(this.org, this.account.id, 'prepend');
      if (!file) {
        file = GF.defaultFile(this.org, 'prepend');
        if (!file) { this.note('on holiday with no prepend goal file, and no other account names one either — goals left as they are'); return null; }
        GF.setFile(this.org, this.account.id, 'prepend', file);
        this.note(`on holiday and naming no prepend goal file — pointed at ${file}, so it is never left without goals`);
      }
      this._goalFileSeen = this._goalFileSeen || new Map();
      return GF.syncAccount(this.org, this.account, { note: (m) => this.note(m), seen: this._goalFileSeen });
    } catch (e) { this.note(`prepend goal file not loaded — ${e.message}`); return null; }
  }

  // An account that is NOT on holiday and names no prepend file does not follow a fleet
  // edit of the prepend at all: it keeps whatever copy it was last given and looks fine
  // (Lord07 and Lord16 were 102 characters and five goal lines behind, 2026-09-24).
  // Said once per console, because it may be an account being made ready for a holiday.
  warnNoGoalFile() {
    if (this._noGoalFileSaid || !this.connected || !this.org || !this.account) return;
    try {
      if (require('./goalfiles').fileOf(this.org, this.account.id, 'prepend')) return;
      this._noGoalFileSaid = true;
      this.note('this account names no prepend goal file, so a fleet-wide goal edit does not reach it — name one in the Director (✎ Goal files) unless it is being made ready for a holiday');
    } catch { /* said next login */ }
  }
  // What the Director's "Market glitch ready" column reads.
  holidayRunView() {
    const rec = this.holidayRun();
    if (!rec || !rec.since) return null;
    const maints = Number(rec.maints || 0);
    return { since: rec.since, maints, ready: maints >= 1, seenAt: rec.seenAt || null };
  }

  // ---- the protection watcher -----------------------------------------
  //
  // What the account is protected by RIGHT NOW: holiday, dream truce, truce or
  // peace (buffs.js PROTECTION). Until 2026-09-23 the only thing the Director's
  // Status column had was `game.holiday`, which is written in one place —
  // game.js, from the login reply's ok=-100 — so an account that went on holiday
  // while already logged in showed nothing until its console happened to
  // reconnect. Five accounts went on holiday at 08:02-08:04 that morning and the
  // badge was still missing at 08:12 on the four that had not re-logged in.
  //
  // Nothing has to be asked of the server. The buff list is seeded by the login
  // and kept current by `server.PlayerBuffUpdate` pushes (game.js
  // applyPlayerBuffUpdate), and buffs carry an endTime, so buffs.list() drops
  // one the moment it expires. This is pure local reading: no command, no
  // login, nothing for the rate limiter to count. The ONE thing it cannot see
  // is a push that never arrived while the socket stayed up — there is no
  // command that returns our own buffs (common.getPlayerInfoByName, what the
  // heartbeat sends, is the public summary: name, alliance, prestige, no
  // buffs), so that case is only corrected by the next login.
  //
  // It is deliberately NOT in the goal engine: engineTick() returns early on
  // userPaused and on maintenance, which is exactly when a status still has to
  // be reported. This runs on the session's own timer whenever connected.
  // How often a holiday account re-checks its prepend goal file (holidayGoalFile). It is a
  // file read and a string compare, and holidayRun() is called on every Director poll, so
  // it is paced rather than run a few times a second. A login resets it to 0 so the check
  // always happens at once on the way in.
  static GOAL_FILE_GAP_MS = Number(process.env.OTTO_GOAL_FILE_GAP_SEC || 60) * 1000;
  static PROTECTION_MS = Number(process.env.PROTECTION_MS || 120000);

  startProtectionWatch({ everyMs = Session.PROTECTION_MS } = {}) {
    if (this._protTimer) return;
    this.checkProtection();
    this._protTimer = setInterval(() => this.checkProtection(), everyMs);
    this.note(`protection watch started (every ${Math.round(everyMs / 1000)}s: holiday, dream truce, truce, peace)`);
  }

  stopProtectionWatch() {
    if (this._protTimer) { clearInterval(this._protTimer); this._protTimer = null; }
  }

  // One reading. Returns the protection view, and says so on the record when
  // the KIND changes — a countdown ticking down is not news, going on holiday
  // or a truce running out is.
  checkProtection() {
    if (!this.connected || !this.game) { this.protection = null; return null; }
    let p = null;
    try { p = require('./buffs').protectionOf(this.game); } catch { return this.protection || null; }
    const now = Date.now();
    // On a holiday, whether the game will renew it by itself. `/autoextend` sets
    // the game's own isAutoFurlough (script-cmd-social.js), and it comes back on
    // the login's PlayerBean as `autoFurlough`, with `furloughDay` for the days
    // it was taken for. Those two are login-seeded, not pushed — but the flag
    // only ever changes when a holiday is sent, so a login is soon enough. It is
    // the only way to tell a holiday that renews from one about to lapse, which
    // nothing could read before (the user asked, 2026-09-23).
    const pb = (this.game && this.game.player) || {};
    const holiday = p && p.kind === 'holiday';
    const view = p ? {
      kind: p.kind, label: p.label, type: p.type,
      left: p.left, msLeft: p.msLeft,
      auto: holiday ? !!pb.autoFurlough : null,
      days: holiday ? (Number(pb.furloughDay) || null) : null,
      at: now,
    } : null;
    const was = this.protection ? this.protection.kind : null;
    const is = view ? view.kind : null;
    if (was !== is) {
      if (is) {
        const renew = view.auto === null ? ''
          : (view.auto ? ', renewing itself until the coins run out' : ', NOT set to renew — it will lapse');
        this.note(`protection: ${view.label}${view.left && view.left !== 'no end' ? ` — ${view.left} left` : ''}${renew}`);
      } else this.note(`protection: none now (${was} has ended)`);
    }
    this.protection = view;
    return view;
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
  static PROBE_EVERY_MS = 30000;   // how often the free TCP port check runs afterwards
  static PROBE_NOTE_EVERY_MS = 300000;  // how often "still closed" reaches the log
  static RETURN_STAGGER_MS = 15000;     // spread the fleet's logins when the port opens
  static FOLLOWER_WAIT_MIN = 25;   // how long a follower waits on the monitor before going it alone

  static MAINT_WORDS = /\b(maintenance|maintainance|mainten|server\s+(will|is going to)\s+(be\s+)?(down|closed|restart)|scheduled\s+downtime)\b/i;

  // Returns the plan when a message looks like a maintenance warning.
  // The server itself says it's down (ServerState, or the game port stopped answering)
  // and no announcement armed the maintenance race: arm it now, so the monitor starts
  // probing at once and the followers log in the moment it is in — without anyone
  // having to seed the window by hand (the user, 2026-09-19). The window starts two
  // minutes back, the point from which the monitor probes (maintRace).
  armRaceFromServer(now = Date.now()) {
    try {
      const server = (this.account && this.account.server) || 'ss71';
      // The window is the fleet's, not this console's: every other console reads
      // it and stands down too, which is the only thing that reaches an account
      // the system chat never told (a holiday account is sent no announcement —
      // maint.js). It starts two minutes back, the point the monitor probes from.
      const w = MAINT.declare(this.settings(), server, {
        startAt: now - 2 * 60000,
        text: `detected: ${this.maint.reason || 'server down'}`,
        by: (this.account && this.account.id) || null,
      }, now);
      if (!w) return null;                                   // one is armed already
      this.note(Session.raceOn()
        ? `maintenance race armed from the server's own status — the monitor probes now, followers log in behind it`
        : `maintenance window recorded from the server's own status (${new Date(w.startAt).toLocaleTimeString()}) — no logins until the port answers`);
      return w;
    } catch { return null; }   // the race just does not run; the once-a-minute check still does
  }

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
    // Tell the whole fleet, through the Director's database: this console heard
    // the announcement, the others may not have (a holiday account is sent no
    // system message at all — maint.js), and one bot hearing it is enough to
    // stand every account down. The window runs from the announced start for an
    // hour and a half — after that it stops meaning anything and the ordinary
    // recovery takes over.
    try {
      const server = (this.account && this.account.server) || 'ss71';
      MAINT.declare(this.settings(), server, {
        startAt: startsAt, resumeAt, text, by: (this.account && this.account.id) || null,
      });
    } catch { /* the fleet-wide word just does not get out; this console still stands down */ }
    this.note(`maintenance announced ("${text.slice(0, 80)}") — standing down in `
      + `${Math.max(0, Math.round((pauseAt - Date.now()) / 60000))}m, back about `
      + `${new Date(resumeAt).toLocaleTimeString()}`);
    this.emitEvent('maintenance', { phase: 'announced', text: text.slice(0, 200), startsAt, pauseAt, resumeAt });
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

  // A script's `logout` (logout.js): off the game now, back at resumeAt (local
  // ms). It is a stand-down like maintenance, so no login of any kind happens
  // in between and it survives a restart. It outranks the maintenance
  // override, and Connect (/api/connect) ends it early.
  logoutUntil(resumeAt, text = 'logged out by a script') {
    const now = Date.now();
    this.maint.plan = {
      text, announcedAt: now, startsAt: now, pauseAt: now, resumeAt: Number(resumeAt),
      source: 'logout', citiesBefore: ((this.game && this.game.castles) || []).length,
    };
    this.maint.nextLoginAt = Number(resumeAt);
    try { this.settings().set('maintPlan:' + (this.account && this.account.id), this.maint.plan); } catch {}
    this.note(`${text} — off the game until ${new Date(resumeAt).toLocaleTimeString()}`);
    return this.maint.plan;
  }

  clearMaintenancePlan() {
    // Whatever cleared it — back online after the window, or the user by hand —
    // this console is done with the window the fleet is holding up, and must not
    // adopt it again on the next tick (adoptFleetMaintenance).
    try { const rec = this.fleetMaintenance(Date.now(), 0); if (rec) this._fleetAdoptBlockAt = rec.startAt; } catch {}
    this.maint.plan = null;
    this.maint.nextLoginAt = 0;
    this.maint.nextProbeAt = 0;
    this.maint.notedClosedAt = 0;
    this.maint.loginTries = 0;
    try { this.settings().set('maintPlan:' + (this.account && this.account.id), null); } catch {}
    this.note('maintenance plan cleared');
  }

  // ---- the fleet's word on maintenance (maint.js) ----------------------
  //
  // Every console writes what it knows into one record per server, and reads
  // the others'. This is what the user asked for on 2026-09-23: the bots tell
  // the Director it is maintenance now, and nothing logs in until it is over.
  //
  // It matters most for an account ON HOLIDAY. A holidayed account is not sent
  // the system chat announcement (observed 2026-09-23: every other console
  // logged four copies of it, the four holidayed ones none), so it had no plan
  // of its own, stayed connected into the start of the window, had its socket
  // closed under it at 09:00:00 and then spent the whole maintenance on the
  // reconnect ladder — logins into a closed server, and a proxy hammered into
  // "host unreachable" (EVONY-RULES.md section 2).
  //
  // The read costs a local SQLite row, so it is throttled rather than run on
  // every 5 s supervisor tick.
  static FLEET_MAINT_EVERY_MS = 15000;
  fleetMaintenance(now = Date.now(), everyMs = Session.FLEET_MAINT_EVERY_MS) {
    const cached = this._fleetMaint;
    if (cached && now - cached.at < everyMs) return cached.rec;
    const server = (this.account && this.account.server) || 'ss71';
    const rec = MAINT.read(this.settings(), server, now);
    this._fleetMaint = { at: now, rec };
    return rec;
  }

  // Take on a window another console (or the Director) put up. A plan of this
  // console's own — the announcement it heard itself, one set by hand, or a
  // script's logout — always wins, and is left alone.
  // -> the plan adopted, or null.
  adoptFleetMaintenance(now = Date.now()) {
    if (this.maint.plan) return null;
    const rec = this.fleetMaintenance(now);
    if (!rec || rec.phase === 'over') return null;
    if (this._fleetAdoptBlockAt === rec.startAt) return null;   // done with this one already
    this.maint.plan = {
      text: rec.text || 'the fleet says the server is going down for maintenance',
      announcedAt: now, startsAt: rec.startAt, pauseAt: rec.pauseAt, resumeAt: rec.resumeAt,
      source: 'fleet', from: rec.by || null,
    };
    try { this.settings().set('maintPlan:' + (this.account && this.account.id), this.maint.plan); } catch {}
    const phase = this.planPhase(now);
    this.note(`maintenance: the fleet says the server ${phase === 'before' ? 'goes down at ' + new Date(rec.startAt).toLocaleTimeString() : 'is down'}`
      + `${rec.by ? ` (from ${rec.by})` : ''} — ${phase === 'before'
        ? `standing down at ${new Date(rec.pauseAt).toLocaleTimeString()}`
        : 'standing down now'}, back about ${new Date(rec.resumeAt).toLocaleTimeString()}`);
    return this.maint.plan;
  }

  // Another account is verifiably logged in again, so the server is back: a
  // console still sitting out a window it only adopted stops waiting. It does
  // NOT log straight in — it goes to the recovery phase, which checks the free
  // TCP port first and staggers the fleet's logins (EVONY-RULES.md section 2).
  releaseIfFleetBack(now = Date.now()) {
    const p = this.maint.plan;
    if (!p || p.source !== 'fleet' || now >= p.resumeAt) return false;
    const rec = this.fleetMaintenance(now);
    if (!rec || rec.phase !== 'over') return false;
    p.resumeAt = now;
    this.maint.nextLoginAt = now;
    this.maint.nextProbeAt = 0;
    try { this.settings().set('maintPlan:' + (this.account && this.account.id), p); } catch {}
    this.note(`maintenance: another account is logged in again (${new Date(rec.over).toLocaleTimeString()}) — checking the port and going back in`);
    return true;
  }

  // ---- the maintenance race (OFF by default) --------------------------
  //
  // OFF since 2026-09-20 (the user): every console now simply stands down before
  // the announced start and comes back at the announced end, checking the free
  // TCP port until it answers (the 'recovering' phase above). The race below
  // bought no real speed and cost a great deal: the monitor logged in again and
  // again into a closed server, and on 2026-09-19 that churn ran its proxy into
  // the ground ("host unreachable") so the account was slower back, not faster.
  // It only runs when OTTO_MAINT_RACE=1 is set on a console's start.
  //
  // The market glitch wants its accounts back the moment maintenance ends:
  // other players' bots take 15-30 minutes to load, and until they do the market
  // is ours. But logging in INTO a maintenance is what gets an account held back
  // for half an hour, so one account takes that risk for all of them:
  //   MAINTENANCE MONITOR  probes the port every 15 s from two minutes into the
  //            window, tries a login every 30 s once it answers, and the moment it
  //            is in writes maintOver:<server> to the org's settings.
  //   FOLLOWER spends no login at all through the window, and logs in the instant
  //            that signal is newer than the window's start.
  // The role is the account's own setting, maintRole:<id> = 'monitor' | 'follow'
  // (the Director's ✎ "After maintenance"), read on every tick, so it survives any
  // restart and a change applies at once; OTTO_MAINT_MONITOR=1 / OTTO_MAINT_FOLLOW=1
  // on a console's start override it. The window is maintWindow:<server> =
  // { startAt, until } in the org's settings.
  // -> { role, server, startAt, until, over } while a race is on, else null
  maintRole() {
    if (process.env.OTTO_MAINT_MONITOR === '1') return 'monitor';
    if (process.env.OTTO_MAINT_FOLLOW === '1') return 'follow';
    const id = this.account && this.account.id;
    if (!id) return null;
    let r = null;
    try { r = this.settings().get('maintRole:' + id, null); } catch { return null; }
    return r === 'monitor' || r === 'follow' ? r : null;
  }
  // The race is opt-in: with it off every console follows the clock instead, which
  // is what maintRaceState returning null means everywhere it is read.
  static raceOn() { return process.env.OTTO_MAINT_RACE === '1'; }
  maintRaceState(now = Date.now()) {
    if (!Session.raceOn()) return null;
    const role = this.maintRole();
    if (!role) return null;
    const server = (this.account && this.account.server) || 'ss71';
    let win = null, over = 0;
    try {
      win = this.settings().get('maintWindow:' + server, null);
      over = Number(this.settings().get('maintOver:' + server, 0)) || 0;
    } catch { return null; }
    if (!win || !win.startAt || now < Number(win.startAt) || now > Number(win.until || 0)) return null;
    return { role, server, startAt: Number(win.startAt), until: Number(win.until), over: over > Number(win.startAt) ? over : 0 };
  }
  // One supervisor tick of the race; true when it handled the tick.
  async maintRace() {
    if (this.connected) return false;
    const r = this.maintRaceState();
    if (!r) return false;
    const now = Date.now();
    this.state = 'maintenance';
    if (r.role === 'follow') {
      if (!r.over) {
        // A follower must never wait for ever on a signal that may never come. On
        // 2026-09-20 the monitor came back on the ordinary reconnect ladder instead of
        // through the race, so it never wrote maintOver, and thirteen accounts sat
        // waiting on YESTERDAY's signal — correctly refused as stale — for 70 minutes
        // past the end of maintenance. After FOLLOWER_WAIT_MIN the follower gives up on
        // the monitor and falls through to the ordinary recovery, which probes the port
        // itself and costs no login until it answers.
        if (now > r.startAt + Session.FOLLOWER_WAIT_MIN * 60000) {
          if (!this._raceGaveUp) {
            this._raceGaveUp = true;
            this.note(`no word from the maintenance monitor ${Session.FOLLOWER_WAIT_MIN} minutes into the window `
              + `— giving up on it and checking the port here instead`);
          }
          return false;
        }
        this.disconnectReason = 'waiting for the maintenance monitor to find the end of maintenance, then logging in at once';
        // and say so on the record now and then, so a waiting console cannot be
        // mistaken for a dead one
        if (now > (this._raceNotedAt || 0) + 5 * 60000) {
          this._raceNotedAt = now;
          this.note(`maintenance: waiting for the monitor to get in (window began ${new Date(r.startAt).toLocaleTimeString()})`);
        }
        return true;
      }
      this._raceGaveUp = false;
      if (now < (this._raceNextAt || 0)) return true;
      this._raceNextAt = now + 10000;
      this._raceGo = true;
      this.note(`the maintenance monitor is in (${new Date(r.over).toLocaleTimeString()}) — logging in now`);
      try {
        if (this.maint.plan) this.clearMaintenancePlan();
        await this.connect();
        this.noteConnectOk();
        this.state = 'connected'; this.disconnectReason = null;
        this.maintEndedAt = Date.now();
        this.note('back online after maintenance, right behind the maintenance monitor');
        this.noteMaintenanceEnded();
      } catch (e) { this.note(`login after the maintenance monitor failed (${e.message}) — again in 10s`); }
      return true;
    }
    // the maintenance monitor
    if (now < r.startAt + 2 * 60000) { this.disconnectReason = 'maintenance monitor: probing starts two minutes into the window'; return true; }
    if (now < (this._raceNextAt || 0)) return true;
    this._raceNextAt = now + 15000;
    if (!(await this.portOpen())) { this.disconnectReason = 'maintenance monitor: the game port is still closed (checked every 15s)'; return true; }
    if (now < (this._raceLoginAt || 0)) return true;
    this._raceLoginAt = now + 30000;
    this._raceGo = true;
    this.note('maintenance monitor: the port answers — trying a login');
    try {
      if (this.maint.plan) this.clearMaintenancePlan();
      await this.connect();
      this.noteConnectOk();
      this.state = 'connected'; this.disconnectReason = null;
      this.maintEndedAt = Date.now();
      this.settings().set('maintOver:' + r.server, Date.now());
      this.note('maintenance monitor: IN — maintenance is over; the followers log in now');
      this.noteMaintenanceEnded();
    } catch (e) {
      this.disconnectReason = `maintenance monitor: the port answers but the login did not (${e.message}); again in 30s`;
      this.note(`maintenance monitor: not in yet (${e.message}) — again in 30s`);
    }
    return true;
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
      // The same way the login goes: through the account's proxy when it has one.
      // Probing direct from an IP the server has stopped answering (seen
      // 2026-09-18: every proxy reached ss71 while this PC's own IP hung in
      // SYN_SENT) says "closed" for ever, and the monitor never tries its login.
      const acc = this.account;
      let proxy = null;
      // pinned, random (its kept pick, proxy-pick.js) or direct — as the login goes
      if (acc && acc.proxy) { try { proxy = require('./proxy-pick').forAccount(this.org, acc); } catch {} }
      if (proxy) {
        try { const s = await require('./proxy').connectVia(proxy, host, port, timeoutMs); try { s.destroy(); } catch {} return resolve(true); } catch { return resolve(false); }
      }
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
    // Every way in ends here, so this is where "if a bot logs in it should check
    // holidaymode" lives: holidayRun() reads the badge from the login reply and, when it
    // is on, holidayGoalFile() makes sure the account has the fleet's prepend goals.
    this._goalFileAt = 0;
    try { this.holidayRun(); } catch { /* the Director's poll runs it again anyway */ }
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
  // One tick per interval while the socket is up. Always live: the console's
  // pause button is the way to stop it acting.
  //
  // Between ticks the war goals keep their own time. Hiding and the gate race a
  // wave's arrival, and NEAT's own examples lead by 30 s (hiding:0.5) and 6 s
  // (gate:0.1), which a once-a-minute tick would catch about half and a tenth
  // of the time. So after every pass, and whenever the hostile army list
  // changes, the engine names the next moment one of them has something to
  // decide (Engine.nextWakeAt) and one war-only pass is run then (armWake).
  startEngine({ tickMs = Number(process.env.TICK_MS || 60000) } = {}) {
    if (this._engineTimer) return;
    this._tickMs = tickMs;
    this._engineTimer = setInterval(() => { this.engineTick(); }, tickMs);
    this.note(`goal engine loop started (tick ${Math.round(tickMs / 1000)}s, live)`);
  }

  // One engine pass: the full tick, or with `urgent` the war goals alone. Not
  // while another pass runs, the socket is down, the server is in maintenance
  // or the console has paused the engine. True when it ran.
  async engineTick({ urgent = false } = {}) {
    if (this._ticking) {
      // A war pass is short: the regular tick it held up runs straight after.
      if (!urgent && this._ticking === 'war') this._tickOwed = true;
      return false;
    }
    if (!this.connected) return false;
    if (this.paused) return false;            // no orders while the server is down
    if (this.userPaused) return false;        // the console's pause button
    this._ticking = urgent ? 'war' : 'tick';
    try {
      const { Engine } = require('./engine');
      const acctId = this.account && this.account.id;
      // Rebuilt when the socket or the account changes, so it never holds a
      // dead Game; in-memory timers carry across.
      if (!this.engine || this.engine.game !== this.game || this.engine.accountId !== acctId) {
        const prev = this.engine && this.engine.state;
        this.engine = new Engine(this.game, (m, meta) => this.note(m, meta), acctId);
        if (prev) this.engine.state = prev;
      }
      // a new or changed attack may need a war pass before the next tick
      this.engine.onHostile = () => this.armWake();
      this.engine.controlsFor = (castle) => this.controls(this.game.castleId(castle));
      this.engine.maintEndedAt = this.maintEndedAt || 0;
      this.engine.dryRun = false;
      await this.engine.tick({ urgent });
      if (!urgent) {
        this.lastTickAt = Date.now();
        this.ticks = (this.ticks || 0) + 1;
      }
    } catch (e) {
      this.note(`engine ${urgent ? 'war pass' : 'tick'}: ${e.message}`);
    } finally {
      this._ticking = false;
      if (urgent) this._warPassAt = Date.now();
    }
    if (urgent && this._tickOwed) { this._tickOwed = false; setImmediate(() => this.engineTick()); }
    this.armWake();
    // a few map blocks around the farming cities, after the tick and outside its
    // lock, so a war pass is never held up by it (backgroundScan)
    if (!urgent) this.backgroundScan().catch(() => {});
    return true;
  }

  // (Re)arm the one timer for the engine's next war moment. Never two pending,
  // never two war passes within WAKE_GAP_MS, and never further out than the
  // next regular tick, which re-arms it anyway. A wake that finds a pass
  // running is re-armed when that pass ends; one that finds the socket down or
  // the engine paused is left to the next regular tick.
  armWake() {
    const WAKE_GAP_MS = 1000;
    if (this._wakeTimer) { clearTimeout(this._wakeTimer); this._wakeTimer = null; }
    if (!this._engineTimer || !this.engine || typeof this.engine.nextWakeAt !== 'function') return null;
    let at = null;
    try { at = this.engine.nextWakeAt(); } catch (e) { this.note('engine wake: ' + e.message); }
    if (!at) return null;
    const now = Date.now();
    const delay = Math.max(0, at - now, (this._warPassAt || 0) + WAKE_GAP_MS - now);
    if (delay > (this._tickMs || 60000)) return null;
    this._wakeTimer = setTimeout(() => { this._wakeTimer = null; this.engineTick({ urgent: true }); }, delay);
    this._wakeAt = now + delay;
    return this._wakeAt;
  }

  stopEngine() {
    if (this._engineTimer) { clearInterval(this._engineTimer); this._engineTimer = null; }
    if (this._wakeTimer) { clearTimeout(this._wakeTimer); this._wakeTimer = null; }
  }

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

  // The page's Refresh: what F5 is in the game's own client — drop the socket
  // and log in afresh, now, whatever the backoff ladder says. Like Connect it
  // ends a kick hold or a script's logout; a Director switch-off still wins.
  async reconnect() {
    if (this.connecting) { try { await this.connecting; } catch {} }
    if (this.maint.plan && this.maint.plan.source === 'logout') this.clearMaintenancePlan();
    this.clearKickHold();
    this.note('refresh — logging in afresh');
    const old = this.game;
    this.game = null;
    try { if (old) old.close(); } catch {}
    this.attempt = 0; this.backoffMs = Session.BACKOFF[0]; this.nextTryAt = 0;
    this.state = 'connecting';
    try {
      await this.connect();
      this.noteConnectOk();
      this.state = 'connected'; this.disconnectReason = null;
    } catch (e) {
      this.noteConnectError(e);
      this.state = 'reconnecting';
      this.disconnectReason = e.message;
      this.nextTryAt = Date.now() + this.backoffMs;
      throw e;
    }
    return this.game;
  }

  async connect() {
    if (this.connected) return this.game;
    if (this.connecting) return this.connecting;
    // Every login waits out a script's logout, wherever it is asked for: a
    // page poll, a script, the engine. Connect clears the logout first.
    // Every login, wherever it is asked for — the page's Connect, a script, the
    // engine, the supervisor — is refused while the account is switched off.
    if (this.switchedOff()) {
      throw new Error('this account is switched off in the Director — switch it back on there to log in');
    }
    const kick = this.kickHold();
    if (kick) {
      throw new Error(`another login took this account at ${new Date(kick.at).toLocaleTimeString()} — `
        + `staying out until ${new Date(kick.until).toLocaleTimeString()}; press Connect to take it back now`);
    }
    // NO LOGIN OF ANY KIND while a stand-down is open — an announced maintenance
    // or a script's logout. The supervisor already respects it, but a login can be
    // asked for from a dozen other places (the page's polls, a script, the engine,
    // the Director), and on 2026-09-20 that is exactly what happened: the console
    // stood down, something else logged it straight back in, the supervisor closed
    // it two seconds later, and the pair went round like that for six minutes until
    // the proxy stopped answering. The stand-down has to be refused HERE, once, for
    // everyone. The maintenance override (the page's toggle) is the way through.
    // A console STARTED in the middle of a window has no plan of its own yet —
    // the supervisor's first tick is five seconds away, and the login would be
    // spent before it. Take the fleet's word first (maint.js).
    if (!this.maint.plan) this.adoptFleetMaintenance();
    const lo = this.maint.plan;
    if (lo && this.planPhase() === 'standdown'
        && (lo.source === 'logout' || !this.maint.override) && !this._raceGo) {
      throw new Error(lo.source === 'logout'
        ? `logged out by a script until ${new Date(lo.resumeAt).toLocaleTimeString()} — press Connect to end that early`
        : `standing down for maintenance until ${new Date(lo.resumeAt).toLocaleTimeString()} — `
          + `no logins until then, because logging in during maintenance holds the account back for ~30 minutes; `
          + `switch the maintenance override on to force it`);
    }
    // A follower in a maintenance race logs in only once the monitor is in: a page
    // poll or a script must not spend its login into the maintenance either.
    const race = this.maintRaceState();
    if (race && race.role === 'follow' && !race.over && !this._raceGo) {
      throw new Error(`waiting for the maintenance monitor to find the end of maintenance (${race.server}) — then this logs in at once`);
    }
    this.connecting = (async () => {
      const env = loadEnv();
      const acc = this.account;
      let proxy = null;
      // pinned, random (its kept pick — made now if it has none) or direct
      if (acc && acc.proxy) {
        try {
          proxy = require('./proxy-pick').forAccount(this.org, acc, { note: (m) => this.note(m, { kind: 'sys' }) });
        } catch (e) { this.note('proxy: ' + e.message, { kind: 'sys' }); }
      }
      // The socket's own chatter is protocol trace; the Log tab gets one line
      // saying who we are once the login has actually worked.
      const g = new Game((m) => this.note(m, { kind: 'net' }));
      await g.connect(
        (acc && acc.server) || env.EVONY_SERVER || 'ss71',
        (acc && acc.email) || env.EVONY_EMAIL,
        (acc && acc.password) || env.EVONY_PASSWORD,
        proxy,
      );
      // The security code is read from the account record at the moment the
      // game asks for it (a -200), not cached here: changing it in the Director
      // then applies without a reconnect. security.js has the protocol.
      g.setSecurityCode(() => {
        try {
          const cur = (this.account && this.account.id && this.org && this.org.accounts.get(this.account.id)) || this.account;
          return (cur && cur.securityCode) || null;
        } catch { return (this.account && this.account.securityCode) || null; }
      });
      // A hold that began WHILE this login was in flight still wins. Twice on
      // 2026-09-22 (21:28:26 and 21:38:46) Lord02 was kicked, took its hold, and
      // then the login already on the wire landed five seconds later and started the
      // fight with NEAT all over again. The login is spent either way; hanging up at
      // once is what actually leaves the account to whoever took it.
      if (this.kickHold()) {
        try { g.close(); } catch {}
        this.note('the login we had already sent arrived after the hold started — hanging up and leaving the account alone');
        throw new Error('another user took this account while we were logging in — staying out until '
          + new Date(this.kickHold().until).toLocaleTimeString());
      }
      this.wire(g);
      this.game = g;
      this.lastError = null;
      this.xcache.clear();
      this.packages = null;
      this.diplo = null;
      this.note(`logged in as ${(g.player.playerInfo || {}).userName || '?'} — ${g.castles.length} city(ies)`);

      // If we connected from .env rather than an explicit Director pick, work out
      // which account this is so the Director knows to skip polling it.
      if (!this.account) {
        try {
          const mine = D.accounts.byEmail(env.EVONY_EMAIL || '');
          if (mine) { this.account = mine; this.bindOrg(); }
        } catch {}
      }
      this.reconcileRegistry(g);

      this.lastPingAt = Date.now();
      // when THIS socket came up, so the supervisor can tell a login that holds from
      // one the server drops again seconds later
      this.connectedSince = Date.now();
      this.state = 'connected';
      this.disconnectReason = null;
      g.c.on('log', (m) => {
        // A socket replaced on purpose (Refresh, a switch) closes late: it must
        // not mark the new one as reconnecting.
        if (/closed/.test(m) && this.game === g) {
          // what the server sent last, so the next real kick shows whether it says anything first
          const last = (g.c.recentCmds || []).slice(-4).join(', ') || 'nothing';
          const byServer = !g.c.closedByUs && !g.c.closedHadError;
          this.note(`socket closed by ${g.c.closedByUs ? 'us' : g.c.closedHadError ? 'a socket error' : 'the server'} — the last it sent: ${last}`);
          // the server hung up on a session we did not end and no error explains: another login
          // (NEAT's, a person's) — the user's per-account hold, unless a stand-down is open
          const mins = this.kickHoldMin();
          if (byServer && mins && !this.kickHold() && !['standdown', 'recovering'].includes(this.planPhase()) && !this.maint.active) {
            this.holdForKick(null, { minutes: mins, source: 'close', why: 'the server closed the connection (another login — NEAT or a person — or it stopped answering this account)' });
          }
          if (this.kickHold()) {
            this.state = 'kicked';
            this.note('socket closed — staying out while the kick hold lasts');
          } else {
            this.state = 'reconnecting';
            this.disconnectReason = this.disconnectReason || 'the server closed the connection';
            this.nextTryAt = Date.now() + 2000;      // first retry is quick
            this.note('socket closed — supervisor will reconnect');
          }
          this.emitEvent('disconnected', {
            by: g.c.closedByUs ? 'us' : g.c.closedHadError ? 'error' : 'server', state: this.state,
            reason: this.disconnectReason || null, kickHold: !!this.kickHold(), lastCmds: last,
          });
        }
        if (/ignoring this account/.test(m)) {
          this.disconnectReason = 'server is ignoring this account (rate limited) — backing off';
          this.note(`three commands in a row unanswered — ignoring this account? (${g.pipeInFlight ? g.pipeInFlight() : 0} market writes in flight, ${g.pipeQueued ? g.pipeQueued() : 0} waiting)`);
        }
      });
      // An explicit kick means something else logged in as this account. The client
      // knows three names for it: GameClient.as gameClient.kickout, ResponseDispatcher.as
      // server.KickedOut (carrying the other side's ip), and **server.ConnectionLost** —
      // the one the game's own window shows as "Another user has logged into your
      // account", and the one ss71 actually sends. Proved on 2026-09-22: every one of
      // Lord02's ~2,300 drops ended in server.ConnectionLost, and NEAT — the other
      // bot on that account — logged *"Disconnected - Another user has logged into your
      // account, pausing jobs for 31m59s"* at the same second our console logged in.
      // Until that day we ignored it and reconnected straight away, which is what made
      // the two bots fight over the account for four hours.
      // Only the socket we are on counts: a stale one closing late must not start a hold.
      g.c.on('cmd', (cmd, data) => {
        const kickCmd = cmd === 'server.KickedOut' || cmd === 'gameClient.kickout' || cmd === 'server.ConnectionLost';
        if (!kickCmd || this.game !== g) return;
        // The server also says ConnectionLost when it is going down for maintenance, and
        // a stand-down is not somebody stealing the account.
        if (cmd === 'server.ConnectionLost' && (this.maint.active || ['standdown', 'recovering'].includes(this.planPhase()))) return;
        this.noteSomebodyElseLoggedIn(data && data.ip, cmd);
        const mins = this.kickHoldMin();
        if (mins === 0) { this.note('another user logged into this account — it is set to come straight back'); return; }
        this.holdForKick(data && data.ip, { minutes: mins,
          why: 'another user logged into this account (the game says so itself)' });
        try { g.close(); } catch {}
      });
      this.note('session ready');
      // Claude's events feed: the login, then the army lists it came with, so an
      // attack already on its way is announced at once rather than at the next push.
      this.emitEvent('connected', { cities: g.castles.length, proxy: (g.proxy && g.proxy.label) || null });
      g.emitEvent = (type, data) => { if (this.game === g) this.emitEvent(type, data); };
      this.trackArmies('enemy', g, (g.player && g.player.enemyArmys) || []);
      this.trackArmies('self', g, (g.player && g.player.selfArmys) || []);
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
        case 'server.ChannelChatMsg': {
          const b = bucketFor(data.channel);
          const line = { t: Date.now(), from: who(data), msg: strip(data.msg), channel: data.channel };
          if (b === 'private') line.to = this.whisperTo(data, line.msg);
          push(this.chat[b], line);
          break;
        }
        case 'server.AllianceChatMsg':
          push(this.chat.alliance, { t: Date.now(), from: who(data), msg: strip(data.msg) }); break;
        case 'server.WorldChatMsg':
          push(this.chat.world, { t: Date.now(), from: who(data), msg: strip(data.msg) }); break;
        case 'server.PrivateChatMessage':
          push(this.chat.private, { t: Date.now(), from: who(data), msg: strip(data.msg), to: this.whisperTo(data, strip(data.msg)) }); break;
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
        case 'server.NewReport': {
          // NewReport.as carries the unread totals, which are what the header shows.
          const p = g.player || {};
          p.newReportCount = Number(data.count || 0);
          p.newReportCount_army = Number(data.army_count || 0);
          p.newReportCount_trade = Number(data.trade_count || 0);
          p.newReportCount_other = Number(data.other_count || 0);
          push(this.reports, { t: Date.now(), m: `new report — unread: army ${data.army_count || 0}, trade ${data.trade_count || 0}, other ${data.other_count || 0}`, city: null, kind: 'report' });
          break;
        }
        case 'server.NewMail': {
          const p = g.player || {};
          p.newMailCount = Number(data.count || 0);
          p.newMaileCount_inbox = Number(data.count_inbox || 0);     // sic, the bean spells it so
          p.newMaileCount_system = Number(data.count_system || 0);
          break;
        }
        case 'server.PlayerInfoUpdate':
          if (data.playerInfo && g.player) g.player.playerInfo = { ...(g.player.playerInfo || {}), ...data.playerInfo };
          break;

        // Army lists arrive WHOLE, with no castle id (SelfArmysUpdate.as has only
        // `armys`), and Context.as replaces its copy on every push. Without this
        // the player bean kept the login snapshot forever: armies that came home
        // stayed on the Armies tab and new ones never appeared — and goal-npc,
        // which counts busy rally slots from this very list, counted stale marches.
        case 'server.SelfArmysUpdate':
          if (g.player) g.player.selfArmys = data.armys || [];
          if (this.game === g) this.trackArmies('self', g, data.armys || []);      // Claude's events feed
          break;
        case 'server.EnemyArmysUpdate':
          if (g.player) g.player.enemyArmys = data.armys || [];
          if (this.game === g) this.trackArmies('enemy', g, data.armys || []);
          break;
        case 'server.FriendArmysUpdate':
          if (g.player) g.player.friendArmys = data.armys || [];
          break;

        // Our own market offers and the purchases in transit: updateType 0 add,
        // 1 delete, 2 update, matched on id (CommonConstants / Context.as).
        case 'server.TradesUpdate': {
          const c = g.castles.find((x) => g.castleId(x) === data.castleId);
          if (c && data.tradeBean) c.trades = applyUpdate(c.trades, data.updateType, data.tradeBean);
          break;
        }
        case 'server.TransingTradeUpdate': {
          const c = g.castles.find((x) => g.castleId(x) === data.castleId);
          if (c && data.bean) c.transingTrades = applyUpdate(c.transingTrades, data.updateType, data.bean);
          break;
        }
        case 'server.FortificationsUpdate': {
          const c = g.castles.find((x) => g.castleId(x) === data.castleId);
          if (c && data.fortification) c.fortification = data.fortification;
          break;
        }
        // BuildingConstants: status 1 add, 2 update, 3 and 4 remove.
        case 'server.BuildingQueueUpdate': {
          const c = g.castles.find((x) => g.castleId(x) === data.castleId);
          const q = data.buildingQueueBean;
          if (!c || !q) break;
          const list = (c.buildingQueues || []).filter((x) => x.id !== q.id);
          c.buildingQueues = Number(q.status) === 1 || Number(q.status) === 2 ? [...list, q] : list;
          break;
        }
        // A city founded or lost. Only the fields Context.as itself copies on an
        // update are taken, so a partial bean cannot blank a live castle.
        case 'server.CastleUpdate': {
          const cb = data.castleBean;
          if (!cb) break;
          const i = g.castles.findIndex((x) => g.castleId(x) === g.castleId(cb));
          if (Number(data.updateType) === 0) {
            if (i < 0) {
              g.castles.push(cb);
              try { this.cityAdded(g, cb); } catch (e) { this.note(`new city ${cb.name || ''}: ${e.message}`); }
            }
          }
          else if (Number(data.updateType) === 1) { if (i >= 0) g.castles.splice(i, 1); }
          else if (i >= 0) {
            g.castles[i].fieldId = cb.fieldId ?? g.castles[i].fieldId;
            g.castles[i].usePACIFY_SUCCOUR_OR_PACIFY_PRAY = cb.usePACIFY_SUCCOUR_OR_PACIFY_PRAY ?? g.castles[i].usePACIFY_SUCCOUR_OR_PACIFY_PRAY;
          }
          break;
        }
        // A valley or flat taken, lost or levelled (Context.onCastleFieldUpdate).
        // Without it a flat captured after login stayed unknown until the next
        // login, and a city could not be built on it from a script.
        case 'server.CastleFieldUpdate': {
          const c = g.castles.find((x) => g.castleId(x) === data.castleId);
          if (c && data.bean) c.fields = applyUpdate(c.fields, data.updateType, data.bean);
          break;
        }
        case 'server.ResourceUpdate': {
          const c = g.castles.find((x) => g.castleId(x) === data.castleId);
          if (c && data.resource) {
            const was = (c.resource || {}).support;
            c.resource = data.resource;
            // the loyalty a battle leaves: logged beside the waves, and a fall
            // to a defensepolicy line wakes a war pass (Engine.noteLoyalty)
            try { if (this.engine && this.engine.game === g && this.engine.noteLoyalty(c, was)) this.armWake(); } catch {}
          }
          break;
        }
        case 'server.TroopUpdate': {
          const cid = data.castleId ?? data.caslteId;    // the server really does misspell it
          const c = g.castles.find((x) => g.castleId(x) === cid);
          if (c && data.troop) c.troop = data.troop;
          break;
        }
        // Pushed when construction STARTS (status 1 upgrading, 2 demolishing) as
        // well as when it ends. A finished demolition comes as status 0, level 0
        // and the client drops it (Context.onBuildComplete); keeping it left the
        // plot looking taken, so the goal engine never saw it free up.
        case 'server.BuildComplate': {
          const c = g.castles.find((x) => g.castleId(x) === data.castleId);
          const b = data.buildingBean;
          if (!b) break;
          const status = Number(b.status || 0);
          const level = Number(b.level || 0);
          const gone = status === 0 && level === 0;
          // A demolition takes one level, so one that ends above 0 leaves a
          // normal bean behind: only the status it had says it came DOWN.
          let was = 0;
          if (c) {
            const list = (c.buildings = c.buildings || []);
            const i = list.findIndex((x) => x.positionId === b.positionId);
            if (i >= 0) was = Number(list[i].status || 0);
            if (gone) { if (i >= 0) list.splice(i, 1); }
            else if (i >= 0) list[i] = b; else list.push(b);
          }
          const what = `${b.name || 'building'} (pos ${b.positionId})`;
          this.note(gone ? `demolished: ${what}`
            : status === 1 ? `construction started: ${what} L${level}->L${level + 1}`
            : status === 2 ? `demolition started: ${what} L${level}->L${level - 1}`
            : was === 2 ? `demolished a level: ${what}, now L${level}`
            : `build complete: ${b.name}${level ? ` L${level}` : ''}`,
          { city: c && c.name, kind: 'act' });
          break;
        }
      }
    });
  }

  // The city tabs, each with enough state to colour it the way NEAT does:
  // under attack, gate open, food running out, a manual override in force —
  // and which city the traininghero is in.
  cities() {
    if (!this.game) return [];
    const g = this.game;
    const training = this.trainingHeroes();
    const atk = this.attacksByCity();
    return g.castles.map((c) => {
      const xy = g.castleXY(c) || { x: 0, y: 0 };
      const id = g.castleId(c);
      const res = c.resource || {};
      const food = Number((res.food && res.food.amount) || 0);
      const foodRate = Number((res.food && res.food.increaseRate) || 0) - Number(res.troopCostFood || 0);
      const ctl = this.controls(id);
      const A = atk[id] || { real: [], junk: [], junkLine: null };
      return {
        id, name: c.name, x: xy.x, y: xy.y,
        // Only attacks at or above the city's /junktroop are an attack (the user,
        // 2026-09-28: 999 troops against junktroop 1000 shows nothing). The
        // server's c.hasEnemy is set for junk too, so it no longer lights the
        // tab on its own; junkIncoming says what was left out.
        incoming: A.real.length,
        junkIncoming: A.junk.length,
        junkLine: A.junkLine,
        underAttack: A.real.length > 0,
        gateOpen: !!c.goOutForBattle,
        foodHours: foodRate < 0 ? food / -foodRate : null,
        gate: ctl.gate, wartown: ctl.wartown,
        trainingHeroes: training.get(id) || [],
        script: this.scriptLayer(id),          // goals a script set, running over the saved ones
      };
    });
  }

  // Where each hero a `traininghero` goal names is right now, keyed by castle
  // id. It is in whichever city lists it — the test goalmods.trainingHeroPlan
  // rotates it by. On the road it is still listed at home, so its march says
  // where it is headed (ArmyBean.hero is the hero's name).
  trainingHeroes() {
    const g = this.game;
    const out = new Map();
    const names = new Set();
    try {
      // each city's goals as the engine reads them, the global goals included
      for (const c of g.castles) {
        const parsed = this.goalsOf(c);
        for (const x of (parsed && parsed.goals) || []) {
          if (x.name === 'traininghero' && x.hero) names.add(String(x.hero).toLowerCase());
        }
      }
    } catch { return out; }
    const armies = (g.player && g.player.selfArmys) || [];
    for (const key of names) {
      const c = g.castles.find((x) => (x.heros || []).some((h) => String(h.name || '').toLowerCase() === key));
      if (!c) continue;
      const h = c.heros.find((x) => String(x.name || '').toLowerCase() === key);
      const status = HERO_STATUS[Number(h.status)] || String(h.status);
      const march = status === 'Marching' ? armies.find((a) => String(a.hero || '').toLowerCase() === key) : null;
      const id = g.castleId(c);
      if (!out.has(id)) out.set(id, []);
      out.get(id).push({ name: h.name, status, to: (march && march.targetPosName) || null });
    }
    return out;
  }

  // ---- manual per-city controls: Gate Control and War Town Mode ----------
  // Kept per account in the org's settings. The engine reads them every tick
  // (engine.controlsFor), so they hold whether or not a goal mentions the gate.
  // With no organization (a console run straight from .env) there is nowhere to
  // save them, so they live in memory for the life of the process instead.
  controlsKey() { return 'cityControls:' + ((this.account && this.account.id) || 'default'); }
  allControls() {
    if (!this.org) return this._controlsMem || {};
    try { return this.settings().get(this.controlsKey(), {}) || {}; } catch { return {}; }
  }
  controls(castleId) {
    const c = this.allControls()[String(castleId)] || {};
    return { gate: c.gate || 'auto', wartown: c.wartown === undefined || c.wartown === null ? 'auto' : c.wartown };
  }
  setControls(castleId, patch) {
    const all = this.allControls();
    all[String(castleId)] = { ...(all[String(castleId)] || {}), ...patch };
    if (this.org) this.settings().set(this.controlsKey(), all);
    else this._controlsMem = all;
    return this.controls(castleId);
  }

  // Gate Control. Open and Closed are sent at once and then held by the engine;
  // Auto only hands the gate back to the goals.
  async setGate(castleId, mode) {
    if (!['auto', 'open', 'closed'].includes(mode)) throw new Error('gate must be auto, open or closed');
    const g = this.game;
    if (!this.connected || !g) throw new Error('not connected');
    const castle = g.castles.find((x) => g.castleId(x) === Number(castleId));
    if (!castle) throw new Error('no such city');
    let result = null;
    if (mode !== 'auto') {
      const open = mode === 'open';
      result = await g.req('army.setArmyGoOut', { castleId: g.castleId(castle), isArmyGoOut: open });
      if (!result || result.ok !== 1) throw new Error((result && result.errorMsg) || 'the server refused');
      castle.goOutForBattle = open;          // the server does not echo it back
    }
    const ctl = this.setControls(g.castleId(castle), { gate: mode });
    this.note(mode === 'auto'
      ? 'gate control: Auto — the goals decide the gate again'
      : `gate control: ${mode === 'open' ? 'OPENED' : 'CLOSED'} by hand, the engine will hold it`,
    { city: castle.name, kind: 'act' });
    this.emitEvent('gate_changed', { cityId: g.castleId(castle), city: castle.name, mode, open: !!castle.goOutForBattle, by: 'console' });
    return { ok: true, controls: ctl, gateOpen: !!castle.goOutForBattle };
  }

  setWarTown(castleId, mode) {
    // 2026-09-24: read it as TEXT first. Number(null), Number(undefined via ...) and
    // Number('') are all 0, so a request that named no mode used to switch the city to
    // Off without a word instead of being refused. Only auto, 0, 1 and 2 pass now,
    // written as a number or a string.
    const raw = mode === undefined || mode === null ? '' : String(mode).trim();
    const v = raw === 'auto' ? 'auto' : (/^[012]$/.test(raw) ? Number(raw) : NaN);
    if (v !== 'auto' && ![0, 1, 2].includes(v)) throw new Error('war town mode must be auto, 0, 1 or 2');
    const g = this.game;
    const castle = g && g.castles.find((x) => g.castleId(x) === Number(castleId));
    const ctl = this.setControls(castleId, { wartown: v });
    const label = { auto: 'Auto — the goals decide', 0: 'Off', 1: 'On (training hero may move)', 2: 'On (training hero stays)' }[v];
    this.note(`war town mode: ${label}`, { city: castle && castle.name, kind: 'act' });
    return { ok: true, controls: ctl };
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
    const out = {
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
        // A castle under an account-wide protection still reports status 0, so
        // "Normal" was shown for a lord on holiday or truce. The protection is
        // in the player's buffs (buffs.js); an attack or an occupation is about
        // this city and still outranks it.
        const prot = require('./buffs').protectionOf(this.game);
        const own = STATUS[Number(c.status)] || String(c.status ?? '?');
        return {
          town: c.name,
          location: `${xy.x},${xy.y}`,
          fieldId: c.fieldId,
          status: prot && (own === 'Normal' || own === 'Truce')
            ? `${prot.label}${prot.left && prot.left !== 'expired' ? ` (${prot.left} left)` : ''}`
            : own,
          protection: prot ? { kind: prot.kind, label: prot.label, left: prot.left, msLeft: prot.msLeft } : null,
          // the red "under attack" chip: a real attack only (attacks.js — the
          // server's c.hasEnemy is set for junk too; 2026-09-28)
          hasEnemy: (() => {
            try { const v = this.attacksByCity()[this.game.castleId(c)]; return !!(v && v.real.length); }
            catch { return !!c.hasEnemy; }
          })(),
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
      // `level` is where it stands now and `to` where it ends: a level up, or a
      // level down for a demolition (status 2).
      construction: [
        ...(c.buildings || [])
          .filter((b) => Number(b.endTime || 0) > Date.now())
          .map((b) => {
            const down = Number(b.status) === 2;
            const level = Number(b.level || 0);
            return {
              name: b.name, level, positionId: b.positionId,
              kind: down ? 'demolish' : level === 0 ? 'new' : 'upgrade',
              to: down ? level - 1 : level + 1,
              endTime: Number(b.endTime), secsLeft: Math.max(0, Math.round((Number(b.endTime) - Date.now()) / 1000)),
              state: 'building',
            };
          }),
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
          // Experience keeps piling up past the level the hero holds: the server
          // only moves the level when hero.levelUp is sent, one level a time. So
          // a hero with everything spent reads 0 unspent while sitting on dozens
          // of levels — that is what levelsReady counts, and why the Heroes tab
          // shows it beside the level.
          levelsReady: Game.heroLevelsReady(h),
          unspent: h.remainPoint || 0, status: h.status,
        };
      }),
      queues: { building: (c.buildingQueues || []).length },
      builder: this.buildOutlook(c),
    };
    return this.cityMore(c, out);
  }

  // Everything the NEAT-style panels need beyond the basics above, all from the
  // castle and player beans already in memory — no requests.
  cityMore(c, out) {
    const g = this.game;
    const res = c.resource || {};
    const info = (g.player && g.player.playerInfo) || {};
    const id = g.castleId(c);
    const num = (v) => Number(v || 0);

    // ---- resources: amount, net rate per hour, and how long it lasts ----
    // CastleInfoFrame.as: food = food.increaseRate - troopCostFood,
    // gold = taxIncome - herosSalary. Both can go negative.
    const bank = {};
    for (const k of ['food', 'wood', 'stone', 'iron']) {
      const r = res[k] || {};
      bank[k] = { amount: num(r.amount), gross: num(r.increaseRate), rate: num(r.increaseRate) - (k === 'food' ? num(res.troopCostFood) : 0), labour: num(r.workPeople) };
    }
    bank.gold = { amount: num(res.gold), gross: num(res.taxIncome), rate: num(res.taxIncome) - num(res.herosSalary) };
    for (const b of Object.values(bank)) b.hoursLeft = b.rate < 0 ? b.amount / -b.rate : null;

    // What the current troop stage still needs, in resources: its shortfall
    // as the ladder counts it, troops out on marches included.
    const needed = { food: 0, wood: 0, stone: 0, iron: 0, gold: 0 };
    const stage = out.troopStage;
    if (stage && stage.missing) {
      for (const [key, short] of Object.entries(stage.missing)) {
        const t = C.BY_KEY[key];
        if (t && short > 0) for (const k of ['food', 'wood', 'stone', 'iron']) needed[k] += short * num(t.cost[k]);
      }
    }
    out.bank = bank;
    out.needed = needed;

    // ---- general: the NEAT sheet ----
    const sex = num(info.sex);
    const created = num(info.createrTime || info.registerTime);
    Object.assign(out.general, {
      zone: zoneOf(out.x, out.y),
      title: (TITLES[num(info.titleId)] || [])[sex === 1 ? 1 : 0] || null,
      allianceRole: info.allianceLevel || null,
      alliance: info.alliance || null,
      office: info.office || null,
      playedMs: created ? g.now() - created : null,
      // holiday mode is an account buff, not a field on the player bean — but the buff is
      // PUSHED, so a console that has not been sent one yet reads no protection at all.
      // `g.holiday` is the login artifact (EVONY-RULES §1) and is the third source:
      // holidayRun() already counts it, and without it here the Director showed all four
      // of 2026-09-25's new holidays as NOT on holiday for 15 minutes after they went in,
      // while their own consoles had confirmed them. Same three sources in both places.
      furlough: (require('./buffs').protectionOf(g) || {}).kind === 'holiday' || !!(g.player && g.player.furlough) || !!g.holiday,
      grievance: num(res.complaint),
    });

    // ---- troops: where every unit is ----
    // Outward = in our marches that left from here; inward = our reinforcements
    // on their way in. Transports aimed here aren't inward: their transporters
    // go home. The same split the troop ladder counts (engine.cityMarches).
    const { outward: marchingFrom, inward: marchingTo } = require('./engine').cityMarches(c.fieldId, g.player && g.player.selfArmys);
    for (const t of out.troops) {
      t.code = (C.BY_KEY[t.key] || {}).code || '';
      t.typeId = (C.BY_KEY[t.key] || {}).typeId || null;   // matches ProduceBean.type in the queues
      // Base stats for the hover card on the Troops panel.
      const def = C.BY_KEY[t.key];
      if (def) t.stats = { life: def.life, attack: def.attack, defence: def.defence, range: def.range, speed: def.speed, load: def.load, food: def.food, pop: def.pop, cost: def.cost, buildTime: def.buildTime };
      t.outward = marchingFrom[t.key] || 0;
      t.inward = marchingTo[t.key] || 0;
    }
    // Every barracks by slot, so the queue panel can list idle ones too.
    out.barracks = (c.buildings || []).filter((b) => b.typeId === 2)
      .map((b) => ({ positionId: num(b.positionId), level: num(b.level) }))
      .sort((a, b) => a.positionId - b.positionId);

    // ---- buildings: the goal-language code beside each name ----
    const { BUILD_ABBR, FORT_ABBR } = require('./goals');
    const codeFor = Object.fromEntries(Object.entries(BUILD_ABBR).map(([code, name]) => [name, code]));
    for (const b of out.buildings) b.code = codeFor[b.name] || '';

    // ---- fortifications: counts, space, and the current goal stage ----
    const wallsLevel = (c.buildings || []).filter((b) => b.typeId === 32).reduce((m, b) => Math.max(m, num(b.level)), 0);
    const fortCode = Object.fromEntries(Object.entries(FORT_ABBR).map(([abbr, code]) => [code, abbr]));
    const fortGoal = this.activeFortStage(c);
    let used = 0;
    out.forts = C.WALLS.map((w) => {
      const count = num((c.fortification || {})[w.beanKey]);
      used += count * (WALL_SPACE[w.beanKey] || 0);
      return {
        key: w.beanKey, typeId: w.typeId, code: fortCode[w.code] || w.code, space: WALL_SPACE[w.beanKey] || 0,
        count, goal: fortGoal ? num(fortGoal.forts[w.code]) : null,
      };
    });
    out.wallSpace = { level: wallsLevel, total: wallCapacity(wallsLevel), used };
    out.fortStage = fortGoal ? { stageIndex: fortGoal.stageIndex, stageCount: fortGoal.stageCount } : null;

    // ---- heroes: status, what each is built around, and its base ----
    const heroBeans = new Map((c.heros || []).map((h) => [h.name, h]));
    for (const h of out.heroes) {
      const bean = heroBeans.get(h.name) || {};
      const main = Game.dominant(bean);
      h.id = bean.id;
      h.type = { power: 'Att', management: 'Pol', stratagem: 'Int' }[main];
      h.base = Game.heroBase(bean);
      h.statusName = HERO_STATUS[num(h.status)] || String(h.status);
    }

    // ---- market: our open offers and purchases on the road ----
    const TRES = { 0: 'food', 1: 'wood', 2: 'stone', 3: 'iron' };
    out.trades = (c.trades || []).map((t) => ({
      id: t.id, type: num(t.tradeType) === 0 ? 'Buy' : 'Sell', resource: t.resourceName || TRES[num(t.resType)],
      amount: num(t.amount), dealt: num(t.dealedAmount), price: num(t.price),
    }));
    out.transit = (c.transingTrades || []).map((t) => ({
      id: t.id, resource: t.resourceName || TRES[num(t.resType)], amount: num(t.amount), price: num(t.price), endTime: num(t.endTime),
    }));

    out.fieldId = num(c.fieldId);
    out.controls = this.controls(id);
    out.serverNow = g.now();
    return out;
  }

  // Which fortification stage is this city on, and what does it want?
  activeFortStage(c) {
    try {
      const parsed = this.goalsOf(c);
      if (!parsed) return null;
      const stages = parsed.goals.filter((x) => x.name === 'fortification');
      if (!stages.length) return null;
      const have = {};
      for (const w of C.WALLS) have[w.code] = Number((c.fortification || {})[w.beanKey] || 0);
      for (let i = 0; i < stages.length; i++) {
        if (Object.entries(stages[i].forts).some(([code, want]) => want > (have[code] || 0))) {
          return { stageIndex: i + 1, stageCount: stages.length, forts: stages[i].forts };
        }
      }
      return { stageIndex: stages.length, stageCount: stages.length, forts: stages[stages.length - 1].forts, done: true };
    } catch { return null; }
  }

  // ---- the extras: one read-only request each, cached, only on demand ----
  //   queues    troop.getProduceQueue + fortifications.getProduceQueue
  //   research  tech.getResearchList
  //   reinf     army.getStayAllianceArmys — other players' troops stationed here
  //   prod      interior.getResourceProduceData — the Town Hall production rates
  async cityExtra(castleId, kind, fresh = false) {
    if (!EXTRA_TTL[kind]) throw new Error('unknown extra ' + kind);
    if (!this.connected) throw new Error('not connected');
    const g = this.game;
    const castle = g.castles.find((x) => g.castleId(x) === Number(castleId));
    if (!castle) throw new Error('no such city');
    const cid = g.castleId(castle);
    const key = `${cid}:${kind}`;
    const hit = this.xcache.get(key);
    if (hit && hit.pending) return hit.pending;
    if (hit && !fresh && Date.now() - hit.at < EXTRA_TTL[kind]) return hit.data;

    const load = async () => {
      if (kind === 'queues') {
        const [tq, wq] = await Promise.all([g.troopQueue(cid), g.wallQueue(cid)]);
        const shape = (r) => ((r && r.allProduceQueue) || []).map((b) => ({
          positionId: Number(b.positionId),
          items: (b.allProduceQueue || []).map((p) => ({
            queueId: p.queueId, type: Number(p.type), num: Number(p.num || 0),
            endTime: Number(p.endTime || 0), costTime: Number(p.costTime || 0),
          })),
        }));
        return { troops: shape(tq), walls: shape(wq) };
      }
      if (kind === 'research') {
        const r = await g.researchList(cid);
        return {
          techs: ((r && (r.acailableResearchBeans || r.availableResearchBeans)) || []).map((t) => ({
            typeId: Number(t.typeId), name: (C.TECH_BY_ID[Number(t.typeId)] || {}).name || `tech ${t.typeId}`,
            level: Number(t.level || 0), max: Number(t.avalevel || 0),
            upgrading: !!t.upgradeing, endTime: Number(t.endTime || 0), allowed: t.permition !== false,
          })),
        };
      }
      if (kind === 'reinf') {
        const r = await g.req('army.getStayAllianceArmys', { castleId: cid });
        return {
          armies: ((r && r.allianceArmys) || []).map((a) => {
            const units = {};
            let total = 0;
            for (const [k, v] of Object.entries(a.troop || a.troops || {})) {
              const x = Number(v);
              if (Number.isFinite(x) && x > 0) { units[k] = x; total += x; }
            }
            return {
              armyId: a.armyId, from: a.startPosName || null, king: a.king || null, hero: a.hero || null,
              units, total, reachTime: Number(a.reachTime || 0), restTime: Number(a.restTime || 0),
            };
          }),
        };
      }
      // prod: typeid 1 food, 2 wood, 3 stone, 4 iron (ResourceProduction.as)
      const r = await g.productionData(cid);
      const RES = { 1: 'food', 2: 'wood', 3: 'stone', 4: 'iron' };
      const rates = {};
      for (const b of (r && r.resourceProduceDataBean) || []) {
        const k = RES[Number(b.typeid)];
        if (k) rates[k] = { rate: Number(b.commenceRate || 0), maxLabour: Number(b.maxLabour || 0), output: Number(b.totalOutput || 0) };
      }
      return { rates };
    };

    const pending = load().then((data) => {
      this.xcache.set(key, { at: Date.now(), data: { ...data, at: Date.now() } });
      return this.xcache.get(key).data;
    }).catch((e) => { this.xcache.delete(key); throw e; });
    this.xcache.set(key, { ...(hit || {}), pending });
    return pending;
  }

  // Packages waiting to be claimed (PACKAGE_STATUS_AVAIBLE = 2), refreshed at
  // most every ten minutes and only while the header is being looked at.
  async refreshPackages() {
    if (!this.connected || this._pkgBusy) return;
    if (this.packages && Date.now() - this.packages.at < 600000) return;
    this._pkgBusy = true;
    try {
      const g = this.game;
      const d = await g.packageList(g.castleId(g.castle()));
      const ps = (d && d.packages) || [];
      this.packages = { at: Date.now(), available: ps.filter((p) => Number(p.status) === 2).length, total: ps.length };
    } catch { this.packages = { at: Date.now(), available: null, total: null }; }
    finally { this._pkgBusy = false; }
  }

  // What the engine made of one city on its last pass — for the console's
  // engine view. Null until the engine has ticked at least once.
  engineReport(castleId) {
    const g = this.game;
    if (!g || !this.engine) return null;
    const castle = g.castles.find((x) => g.castleId(x) === Number(castleId));
    if (!castle) return null;
    const r = this.engine.lastReport[String(g.castleId(castle))];      // keyed by castle id (engine.focus)
    if (!r) return null;
    const notes = Object.entries(r)
      .filter(([k, v]) => k !== 'acted' && v && typeof v === 'object' && v.note)
      .map(([k, v]) => ({ plan: k, note: v.note }));
    return { at: r.at || null, note: r.note || null, notes, acted: r.acted || [] };
  }

  // What the builder takes on next in this city, planned from the live
  // buildings the way the next tick will plan it, less what the engine has
  // backed off. Null when it cannot be worked out.
  buildOutlook(c) {
    try {
      const { buildOutlook } = require('./engine');
      const id = this.game ? this.game.castleId(c) : null;
      // the merged prepend + city + append goals, as the engine plans with them
      const parsed = this.goalsOf(c) || { goals: [], config: {} };
      const key = String(id);                // the engine keys state and reports by castle id
      const e = this.engine;
      const last = e && e.lastReport[key];
      return buildOutlook({
        castle: c,
        goals: parsed.goals,
        config: parsed.config,          // config building:0 pauses construction
        cityState: (e && e.state[key]) || {},   // its research levels too (Engine.readTechs)
        wallsFor: (last && last.fort && last.fort.wallsFor) || 0,
      });
    } catch { return null; }
  }

  // The goals the engine works in one city: the account's prepend goals, the
  // city's own, the append goals and any goal lines a script ran there
  // (goallayers.runningGoals), or null. The console's views read these so they
  // show what the engine does.
  goalsOf(c) {
    const { runningGoals } = require('./goallayers');
    const id = this.game ? this.game.castleId(c) : null;
    return runningGoals(this.org.goals, this.account && this.account.id, id, c.name);
  }

  // A city's script goal layer for the console: how many lines, since when, and
  // what it stands on — or null when the city runs its saved goals.
  scriptLayer(castleId) {
    const L = require('./goallayers').getScriptLayer(this.account && this.account.id, castleId);
    return L ? { count: L.count, setAt: L.setAt, changedAt: L.changedAt, base: L.base, loaded: L.loaded } : null;
  }

  // Which troop-goal stage is this city currently working on?
  activeTroopStage(c) {
    try {
      const { troopPlan } = require('./engine');
      const parsed = this.goalsOf(c);
      if (!parsed) return null;
      // the same marches the engine counts, or this names a stage it has left
      const selfArmies = (this.game && this.game.player && this.game.player.selfArmys) || [];
      const plan = troopPlan({ castle: c, goals: parsed.goals, config: parsed.config, selfArmies });
      if (!plan || !plan.targets) return plan && plan.done ? { done: true, note: plan.note } : null;
      return { stageIndex: plan.stageIndex, stageCount: plan.stageCount, targets: plan.targets, missing: plan.missing, note: plan.note };
    } catch { return null; }
  }

  // A snapshot of this account, rebuilt at most every SNAP_MS. The Director
   // picks it up off /api/session and files it, which is how a console-held
   // account gets any history at all.
  snapshot(maxAgeMs = Number(process.env.SNAP_MS || 5 * 60000)) {
    if (!this.connected) return null;
    if (this._snap && Date.now() - this._snap.at < maxAgeMs) return this._snap;
    try {
      // Every traininghero goal line this account runs, city by city — so
      // snapshot.js's cityList can tell a city the training hero is parked in
      // apart from one that is genuinely packed full (goalmods.trainingHeroPlan
      // reads the same lines the same way).
      const trainingHeroNames = [];
      for (const c of this.game.castles || []) {
        const parsed = this.goalsOf(c);
        if (!parsed) continue;
        for (const g of parsed.goals) {
          if (g.name === 'traininghero' && g.hero) trainingHeroNames.push(String(g.hero).toLowerCase());
        }
      }
      this._snap = buildSnapshot(this.game, {
        source: 'console',
        accountId: this.account && this.account.id,
        trainingHeroNames,
      });
      this.rememberOwnHeroes(this._snap);
    } catch (e) { this.note('snapshot failed: ' + e.message); return this._snap || null; }
    return this._snap;
  }

  // Write this account's own heroes into the fleet register (db.fleetHeroes),
  // which is how every console knows a prisoner is one of OUR heroes and must
  // never be released (EVONY-RULES.md section 5). A hero leaves its owner's
  // roster the instant it is captured, so the register is the only proof left
  // -- rows are kept forever and this only ever adds.
  //
  // A console that has just logged in reports a SHORT roster (EVONY-RULES.md:
  // a city with 9 heroes came back with 2), which would leave real heroes
  // unregistered. Registering only adds, so a short read costs nothing -- but
  // the release side refuses to act until every account has reported recently
  // (goal-heroes registerCoverage), which is what closes that gap.
  rememberOwnHeroes(snap) {
    const id = this.account && this.account.id;
    if (!id || !snap || !Array.isArray(snap.heroIds) || !snap.heroIds.length) return;
    try { require('./db').fleetHeroes.seen(id, snap.heroIds); }
    catch (e) { this.note('fleet hero register: ' + e.message); }
  }

  marches() { return this.connected ? marches(this.game) : []; }

  // ---- Claude's events feed (claude-events.js, 2026-09-28) ----
  // A short in-memory ring of what is worth reacting to, read by /api/events.
  // Every hook that feeds it is one call wrapped so it can never throw into the
  // push handler or the login it sits in: these are live consoles.
  eventFeed() {
    if (!this._events) this._events = new (require('./claude-events').EventRing)();
    return this._events;
  }
  emitEvent(type, data = {}) {
    try { return this.eventFeed().emit(type, { account: (this.account && this.account.id) || null, ...data }); }
    catch { return null; }
  }
  // The army lists arrive whole on every push; what changed becomes events.
  // The previous list is kept across reconnects (army ids are the server's), so
  // a relog does not announce the same attack twice. Hostile armies already on
  // their way at the first look ARE announced — that is exactly what a waking
  // Claude needs to hear; our own marches at the first look are only the start.
  trackArmies(which, g, armies) {
    try {
      const CE = require('./claude-events');
      if (which === 'self') {
        const r = CE.diffSelf(this._selfPrev || null, armies, { now: g.now ? g.now() : Date.now() });
        this._selfPrev = r.next;
        for (const e of r.events) this.emitEvent(e.type, e);
        return r.events;
      }
      const castles = (g.castles || []).map((c) => ({ id: g.castleId(c), name: c.name, fieldId: c.fieldId }));
      // the junk line is the city's own defensepolicy /junktroop (attacks.js,
      // part B of this work) when that module is there; 1000 otherwise
      let isReal = null;
      try {
        const A = require('./attacks');
        const goalsOf = (cid) => (this.engine && this.engine.goalsSeen && this.engine.goalsSeen[cid] || {}).goals || [];
        isReal = (s, cid) => A.isRealAttack({ troops: s.troops }, A.junkLineOf(goalsOf(cid)));
      } catch { /* not there yet: the default line */ }
      const r = CE.diffEnemy(this._enemyPrev || new Map(), armies, castles, { now: g.now ? g.now() : Date.now(), isReal });
      this._enemyPrev = r.next;
      for (const e of r.events) this.emitEvent(e.type, e);
      return r.events;
    } catch { return []; }
  }

  // castleId -> { junkLine, real, junk } — each city's inbound hostile armies
  // split by its own defensepolicy /junktroop, army by army (attacks.js; the
  // user, 2026-09-28: "junktroop applies per attack"). Armies whose landing
  // time is more than a minute past are dropped, as threatsOf does. {} while
  // there is no game or the list cannot be read.
  attacksByCity() {
    const g = this.game, e = this.engine;
    if (!g || !Array.isArray(g.castles)) return {};
    const A = require('./attacks');
    let incoming = {};
    try {
      incoming = e && e.game === g ? e.incomingFor()
        : require('./engine').incomingByCity(g, (g.player && g.player.enemyArmys) || []);
    } catch { return {}; }
    const now = g.now ? g.now() : Date.now();
    const out = {};
    for (const c of g.castles) {
      const id = g.castleId(c);
      const list = (incoming[id] || []).filter((a) => { const rt = Number(a && a.reachTime); return !(rt > 1e12 && rt < now - 60000); });
      let goals = null;
      try { goals = (this.goalsOf(c) || {}).goals || null; } catch { goals = null; }
      out[id] = A.realAttacks(list, goals);
    }
    this.noteRealWaves(out, now);
    return out;
  }

  // When a REAL attack last landed in each city. The engine's lastWaveAt counts
  // junk waves too, so the Director's "hit N min ago" would light up for a
  // 10-troop scout; this remembers each real army seen and, once it leaves the
  // list at or after its landing time, files that time. It only knows what it
  // was shown, which is every poll of cities() and underAttackView() — the
  // console page and the Director ask every few seconds / every minute.
  noteRealWaves(byCity, now) {
    const m = (this._realWave = this._realWave || { seen: new Map(), lastAt: {} });
    const A = require('./attacks');
    const still = new Set();
    for (const [id, v] of Object.entries(byCity)) {
      for (const a of v.real) {
        const k = id + '|' + A.attackKey(a);
        still.add(k);
        m.seen.set(k, { id, reachTime: Number(a.reachTime) || 0 });
      }
    }
    for (const [k, s] of m.seen) {
      if (still.has(k)) continue;
      m.seen.delete(k);
      if (s.reachTime > 0 && s.reachTime <= now + 2000) m.lastAt[s.id] = Math.max(Number(m.lastAt[s.id] || 0), s.reachTime);
    }
  }

  // Under attack, for the Director, the Claude waker (claude-wake.js) and the
  // events feed: { on, at, cities: [{ id, name, inbound, junk, junkLine,
  // firstLandsAt, lastWaveAt, loyalty, real: [{ key, armyId, troops, from,
  // fromFieldId, king, alliance, reachTime }] }] } — each city with a REAL
  // attack marching at it now (at or above its /junktroop; troops null = size
  // unknown, which counts), or a real wave landed in the last 30 min. A city
  // with only junk inbound is left out: junk shows nothing and wakes nobody
  // (the user, 2026-09-28). `key` is stable across polls: the armyId, else
  // from@reachTime. Null while not logged in.
  underAttackView() {
    const g = this.game;
    if (!this.connected || !g || !Array.isArray(g.castles)) return null;
    const byCity = this.attacksByCity();
    const A = require('./attacks');
    const now = g.now ? g.now() : Date.now();
    const waves = (this._realWave && this._realWave.lastAt) || {};
    const cities = [];
    for (const c of g.castles) {
      const id = g.castleId(c);
      const v = byCity[id] || { real: [], junk: [], junkLine: A.DEF_JUNK };
      const list = v.real;
      const last = Number(waves[id] || 0);
      const recent = last && now - last < 30 * 60000;
      if (!list.length && !recent) continue;
      const lands = list.map((a) => Number(a.reachTime) || Infinity);
      cities.push({
        id, name: c.name, inbound: list.length, junk: v.junk.length, junkLine: v.junkLine,
        firstLandsAt: list.length && Number.isFinite(Math.min(...lands)) ? Math.min(...lands) : null,
        lastWaveAt: last || null, loyalty: (c.resource || {}).support ?? null,
        real: list.map((a) => ({
          key: A.attackKey(a), armyId: a.armyId ?? null, troops: A.armySize(a),
          from: a.from || null, fromFieldId: a.startFieldId ?? null,
          king: a.king || null, alliance: a.alliance || null, reachTime: Number(a.reachTime) || null,
        })),
      });
    }
    return { on: cities.length > 0, at: now, cities };
  }

  header() {
    const p = this.game && this.game.player && this.game.player.playerInfo;
    const pb = (this.game && this.game.player) || {};
    if (this.connected) this.refreshPackages();          // fire and forget, cached
    return {
      // NEAT's header boxes. Unread counts come with the login and are kept
      // current by server.NewReport / server.NewMail.
      counts: this.connected ? {
        packages: this.packages ? this.packages.available : null,
        reports: Number(pb.newReportCount || 0),
        reportsArmy: Number(pb.newReportCount_army || 0),
        reportsTrade: Number(pb.newReportCount_trade || 0),
        reportsOther: Number(pb.newReportCount_other || 0),
        mail: Number(pb.newMailCount || 0),
        mailInbox: Number(pb.newMaileCount_inbox || 0),
        mailSystem: Number(pb.newMaileCount_system || 0),
      } : null,
      paused: this.userPaused,
      // which cities have hostile armies inbound, or were hit in the last 30 min
      // (the Director's "under attack")
      underAttack: this.underAttackView(),
      // { hours, minutes, text } while the account is on holiday: the login goes
      // through and everything works, so this is a badge, not an error.
      holiday: (this.game && this.game.holiday) || null,
      // What it is protected by NOW — holiday, dream truce, truce or peace —
      // read from the buffs every couple of minutes by the protection watch,
      // so it does not wait for a login the way `holiday` above does.
      // { kind, label, type, left, msLeft, at } or null.
      protection: this.protection || null,
      // how many maintenances it has been on holiday through (holidayRun)
      holidayRun: this.holidayRunView(),
      alliance: p ? p.alliance || null : null,
      connected: this.connected,
      state: this.connected ? 'connected' : (this.connecting ? 'connecting' : (this.state || 'offline')),
      reason: this.connected ? null : (this.disconnectReason || this.lastError || null),
      retryInSec: this.connected ? null : Math.max(0, Math.round(((this.nextTryAt || 0) - Date.now()) / 1000)),
      attempt: this.attempt || 0,
      lastError: this.lastError,
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
      // the proxy this login went through, and how long it has held
      proxy: (this.game && this.game.proxy && this.game.proxy.label) || null,
      connectedSince: this.connected ? (this.connectedSince || null) : null,
      // set while the console has been trying to get in and failing: when it started,
      // and how many times it has changed proxy over it
      stuckSince: this.troubleSince || null,
      proxyChanges: this.troubleRotations || 0,
      // somebody else logged into this account — the game's own "Another user has logged
      // into your account". `kick` is the hold running now, `lastKick` the last time it
      // happened at all, and `kickStep` how far up the ladder the waits have climbed.
      kick: (() => { const h = this.kickHold(); return h ? { at: h.at, until: h.until, ip: h.ip || null, minutes: h.minutes ?? null, step: h.step || 0, source: h.source || null } : null; })(),
      lastKick: this.lastKick(),
      kickStep: this.holdStep(),
      kickHoldMin: this.kickHoldMin(),
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
        // what the whole fleet is going by (maint.js), so the Director can show
        // one answer for the server rather than 21 different ones
        fleet: (() => { const r = this.fleetMaintenance(); return r ? { startAt: r.startAt, resumeAt: r.resumeAt, phase: r.phase, text: r.text, by: r.by, over: r.over } : null; })(),
      },
    };
  }

  // ---- world map ----
  // The server answers common.mapInfoSimple for at most 20x20 tiles and echoes
  // the rectangle it answered. Every map read here asks for 20x20 blocks
  // ALIGNED to 20 (the world is 40x40 of them), so a reply is matched to its
  // block by its origin, each block is cached on its own, and panning the
  // console map costs only the blocks that came into view.
  static MAP_BLOCK = 20;
  static MAP_BLOCK_TTL = 3 * 60000;    // a block is not asked for again while this fresh
  static MAP_BLOCK_KEEP = 30 * 60000;  // older blocks are dropped (until then they are served while offline)
  static MAP_BATCH = 9;                // blocks per /api/mapblocks call, and per batch on the socket
  static MAP_FRESH_FLOOR = 15000;      // a forced rescan still never re-asks a block this young
  static MAP_CACHE_CHUNK = 2000;       // tiles per map-cache transaction during a Monitor sweep
  static MAP_SWEEP_BUSY = 10;          // a sweep waits while more of the account's own writes are in flight
  static MAP_SWEEP_YIELD_MS = 20000;   // but never more than this for one request

  // The block store belongs to the account: a switch may land on another server.
  mapStore() {
    const acc = this.account || {};
    const world = `${acc.id || ''}@${acc.server || ''}`;
    if (!this._mapStore || this._mapStore.world !== world) {
      this._mapStore = { world, blocks: new Map(), pending: new Map(), chain: Promise.resolve() };
    }
    const s = this._mapStore, now = Date.now();
    for (const [k, e] of s.blocks) if (now - e.at > Session.MAP_BLOCK_KEEP) s.blocks.delete(k);
    return s;
  }

  // Any point -> the origin of its block. The game's world wraps at the edge
  // (WorldMap.toAddress, NewArmyWin.countDistance), so coordinates wrap too.
  static mapOrigin(x, y) {
    const W = C.MAP_W, B = Session.MAP_BLOCK;
    const w = (v) => ((Math.floor(Number(v)) % W) + W) % W;
    const wx = w(x), wy = w(y);
    return { x: wx - (wx % B), y: wy - (wy % B) };
  }

  // Make sure these blocks (origins) are cached and fresh. At most MAP_BATCH
  // blocks are on the socket at once for this session — batches queue behind
  // each other — and a block already being fetched is waited for, never asked
  // for twice. `fresh` re-reads cached blocks (down to MAP_FRESH_FLOOR).
  async fetchMapBlocks(g, origins, { fresh = false, timeoutMs = 15000 } = {}) {
    const store = this.mapStore();
    const maxAge = fresh ? Session.MAP_FRESH_FLOOR : Session.MAP_BLOCK_TTL;
    const young = (k) => { const e = store.blocks.get(k); return !!e && Date.now() - e.at < maxAge; };
    const waits = [], todo = [];
    for (const o of origins) {
      const k = o.x + ',' + o.y;
      if (young(k)) continue;
      if (store.pending.has(k)) { waits.push(store.pending.get(k)); continue; }
      todo.push(o);
    }
    for (let i = 0; i < todo.length; i += Session.MAP_BATCH) {
      const batch = todo.slice(i, i + Session.MAP_BATCH);
      const run = store.chain.then(() => this.mapBatch(g, store, batch.filter((o) => !young(o.x + ',' + o.y)), timeoutMs));
      store.chain = run.catch(() => {});
      for (const o of batch) {
        const k = o.x + ',' + o.y;
        const p = run.then(() => store.blocks.get(k) || null, () => null)
          .finally(() => { if (store.pending.get(k) === p) store.pending.delete(k); });
        store.pending.set(k, p);
        waits.push(p);
      }
    }
    await Promise.all(waits);
  }

  // One pipelined batch. Replies are matched by the rectangle they echo; a
  // block with no reply by the deadline is simply left uncached.
  async mapBatch(g, store, batch, timeoutMs) {
    if (!batch.length || !g || !g.c) return;
    const B = Session.MAP_BLOCK;
    const waiting = new Map(batch.map((o) => [o.x + ',' + o.y, o]));
    const got = [];
    await new Promise((resolve) => {
      let timer = null;
      const finish = () => { clearTimeout(timer); g.c.off('cmd', onCmd); resolve(); };
      const onCmd = (cmd, data) => {
        if (cmd !== 'common.mapInfoSimple' || !data) return;
        const k = data.x1 + ',' + data.y1;
        if (waiting.has(k)) {
          waiting.delete(k);
          // mapStr: 2 hex chars per tile, row-major (y outer, x inner) over the block
          if (typeof data.mapStr === 'string' && data.mapStr.length) {
            const e = { x1: data.x1, y1: data.y1, x2: data.x2, y2: data.y2, mapStr: data.mapStr, castles: data.castles || [], at: Date.now() };
            store.blocks.set(k, e);
            got.push(e);
          }
        } else if (data.x1 === undefined && data.ok !== undefined && data.ok !== 1) {
          // A refusal need not echo the rectangle: count it against the oldest
          // block still waiting rather than sit out the whole timer.
          const first = waiting.keys().next().value;
          if (first !== undefined) waiting.delete(first);
          this.note('map block refused: ' + (data.errorMsg || 'ok=' + data.ok), { kind: 'net' });
        }
        if (!waiting.size) finish();
      };
      timer = setTimeout(finish, timeoutMs);
      g.c.on('cmd', onCmd);
      try {
        for (const o of batch) g.c.send('common.mapInfoSimple', { x1: o.x, y1: o.y, x2: o.x + B - 1, y2: o.y + B - 1 });
      } catch (e) { this.note('map request failed: ' + e.message, { kind: 'net' }); finish(); }
    });

    // feed the shared map cache so Director/find stay warm too
    if (!got.length) return;
    try {
      const mine = new Set((g.castles || []).map((c) => Number(c.fieldId)));
      const tiles = [];
      // `relation` is how the castle stands to THIS account's alliance: it has
      // no place in a table every tenant shares.
      for (const e of got) for (const { relation, ...t } of this.mapBlockTiles(e, mine)) tiles.push({ ...t, seen: e.at });
      // Keep empty terrain too — flats are what buildnpc needs, and their level
      // is the level of the NPC that will end up on them.
      D.mapCache.upsertMany(tiles.filter((t) => t.userName || t.npc || t.kind === 'flat'));
    } catch (e) { this.note('map cache write failed: ' + e.message); }
  }

  // The tiles of one cached block: every tile's terrain, castles merged on top.
  // `mine` is worked out per call, since the store outlives any one login.
  // `relation` is the server's word on how a castle stands to the account that
  // asked (AllianceConstants: 0 same alliance, 1 friendly, 3 enemy; the client's
  // CastleFlagMc flies white for anything else, neutral included).
  mapBlockTiles(e, mine) {
    const byXY = new Map();
    const w = e.x2 - e.x1 + 1;
    for (let yy = e.y1; yy <= e.y2; yy++) {
      for (let xx = e.x1; xx <= e.x2; xx++) {
        const t = C.decodeTile(e.mapStr.substr(((yy - e.y1) * w + (xx - e.x1)) * 2, 2));
        if (!t) continue;
        byXY.set(xx + ',' + yy, {
          x: xx, y: yy, id: C.coordsToFieldId(xx, yy),
          kind: t.key, typeName: t.name, level: t.level, desc: t.desc || null,
        });
      }
    }
    for (const c of e.castles) {
      const xy = C.fieldIdToCoords(Number(c.id));
      const k = xy.x + ',' + xy.y;
      const base = byXY.get(k) || { x: xy.x, y: xy.y };
      Object.assign(base, {
        id: c.id, name: c.name, userName: c.userName, allianceName: c.allianceName,
        prestige: Number(c.prestige || 0), honor: Number(c.honor || 0),
        npc: !!c.npc, state: c.state, furlough: !!c.furlough, mine: mine.has(Number(c.id)),
        relation: c.relation === undefined || c.relation === null ? null : Number(c.relation),
        kind: c.npc ? 'npc' : 'player',
        typeName: c.npc ? 'NPC' : 'Player city',
      });
      byXY.set(k, base);
    }
    return [...byXY.values()];
  }

  // The alliance's diplomacy, so the map can colour castles as NEAT does:
  // friendly, neutral and enemy alliances by name. `relation` alone can't
  // tell a neutral alliance from one with no standing at all. One
  // alliance.getAllianceFriendshipList at most every DIPLO_TTL, none for a
  // lord with no alliance, and a failed read waits DIPLO_RETRY so a panning
  // map does not keep asking.
  static DIPLO_TTL = 10 * 60000;
  static DIPLO_RETRY = 60000;
  async diplomacy() {
    if (!this.connected) return this.diplo;              // offline: the last known
    const p = this.game && this.game.player && this.game.player.playerInfo;
    const alliance = (p && p.alliance) || null;
    const d = this.diplo;
    if (!alliance) return (this.diplo = { at: Date.now(), alliance: null, friendly: [], neutral: [], enemy: [] });
    if (d && d.alliance === alliance && Date.now() - d.at < (d.error ? Session.DIPLO_RETRY : Session.DIPLO_TTL)) return d;
    if (this._diploBusy) return this._diploBusy;
    this._diploBusy = (async () => {
      const names = (list) => (list || []).map((a) => a && a.allianceName).filter(Boolean);
      try {
        const r = await this.game.req('alliance.getAllianceFriendshipList', {}, 8000);
        if (!r || (r.ok !== undefined && Number(r.ok) !== 1)) throw new Error((r && r.errorMsg) || 'refused');
        this.diplo = { at: Date.now(), alliance, friendly: names(r.friendlyList), neutral: names(r.middleList), enemy: names(r.enemyList) };
      } catch (e) {
        this.note('alliance diplomacy read failed: ' + e.message, { kind: 'net' });
        const last = d && d.alliance === alliance ? d : { friendly: [], neutral: [], enemy: [] };
        this.diplo = { ...last, at: Date.now(), alliance, error: e.message };
      } finally { this._diploBusy = null; }
      return this.diplo;
    })();
    return this._diploBusy;
  }

  // For /api/mapblocks: up to MAP_BATCH blocks (any point in a block names it),
  // from the cache while fresh, otherwise from the server — but only over a
  // live socket: moving the map never logs in. Tiles carry no `dist`; the page
  // measures from its own view centre.
  async mapBlocks(points, { fresh = false } = {}) {
    const seen = new Set(), origins = [], skipped = [];
    for (const p of points) {
      const o = Session.mapOrigin(p.x, p.y);
      const k = o.x + ',' + o.y;
      if (seen.has(k)) continue;
      seen.add(k);
      if (origins.length < Session.MAP_BATCH) origins.push(o); else skipped.push(k);
    }
    const offline = !this.connected;
    const t0 = Date.now();
    const diplo = this.diplomacy();                      // alongside the blocks, cached
    if (!offline && origins.length) await this.fetchMapBlocks(this.game, origins, { fresh });
    const store = this.mapStore();
    const mine = new Set(((this.game && this.game.castles) || []).map((c) => Number(c.fieldId)));
    const now = Date.now();
    const blocks = [], missing = [], tiles = [];
    let fetched = 0;
    for (const o of origins) {
      const k = o.x + ',' + o.y;
      const e = store.blocks.get(k);
      if (!e) { missing.push(k); continue; }
      if (e.at >= t0) fetched++;
      blocks.push({ x: o.x, y: o.y, at: e.at, stale: now - e.at >= Session.MAP_BLOCK_TTL });
      for (const t of this.mapBlockTiles(e, mine)) tiles.push(t);
    }
    return { blocks, missing, skipped, offline, fetched, cached: blocks.length - fetched, ttlMs: Session.MAP_BLOCK_TTL, tiles, diplo: await diplo };
  }

  // Scan of a square around a point, clamped to the world (the Map tab pans with
  // /api/mapblocks instead). Built from the same aligned blocks and cache, so a
  // rescan inside the TTL costs nothing unless `fresh` asks for it.
  async scanArea(cx, cy, radius, { fresh = false } = {}) {
    const g = await this.connect();
    const B = Session.MAP_BLOCK;
    cx = Math.round(cx); cy = Math.round(cy);
    const x1 = Math.max(0, cx - radius), y1 = Math.max(0, cy - radius);
    const x2 = Math.min(799, cx + radius), y2 = Math.min(799, cy + radius);

    const origins = [];
    for (let by = y1 - (y1 % B); by <= y2; by += B)
      for (let bx = x1 - (x1 % B); bx <= x2; bx += B) origins.push({ x: bx, y: by });
    await this.fetchMapBlocks(g, origins, { fresh });

    const store = this.mapStore();
    const mine = new Set(g.castles.map((c) => Number(c.fieldId)));
    const tiles = [];
    let scanned = 0;
    for (const o of origins) {
      const e = store.blocks.get(o.x + ',' + o.y);
      if (!e) continue;
      scanned++;
      for (const t of this.mapBlockTiles(e, mine)) {
        if (t.x < x1 || t.x > x2 || t.y < y1 || t.y > y2) continue;
        t.dist = Math.round(Math.hypot(t.x - cx, t.y - cy) * 10) / 10;
        tiles.push(t);
      }
    }
    tiles.sort((a, b) => a.dist - b.dist);
    return { center: { x: cx, y: cy }, radius, blocks: origins.length, scanned, tiles };
  }

  // ---- background map scan ----
  // NPC farming picks its camps from the shared map cache, which used to fill
  // only while someone browsed the Map tab or ran mapscan.js (a second login,
  // which kicks this console). So after each regular engine tick the console
  // reads a few blocks around its farming cities itself, on its own socket:
  // goal-npc scanPlan picks them (PER_ROUND a round, each block again after
  // REFRESH_MS, never-read and nearest first) and this only asks. At most one
  // round per MAP_SCAN_GAP, none while the socket is down, the server is in
  // maintenance, a stand-down is on or the console is paused. `config mapscan:0`
  // turns it off in a city. Every castle, camp, flat and valley of a block read
  // goes into the cache — valleys too, for the valley goals to come.
  static MAP_SCAN_GAP = 50000;

  async backgroundScan() {
    if (this._scanBusy) return null;
    if (!this.connected || this.paused || this.userPaused) return null;
    if (this.planPhase() === 'standdown') return null;
    const e = this.engine;
    if (!e || typeof e.goalsFor !== 'function') return null;
    if (Date.now() - (this._scanAt || 0) < Session.MAP_SCAN_GAP) return null;
    this._scanBusy = true;
    this._scanAt = Date.now();
    try {
      const g = this.game;
      const NPC = require('./goal-npc');
      const cities = [];
      for (const c of g.castles || []) {
        let parsed = null;
        try { parsed = e.goalsFor(g.castleId(c), c.name); } catch {}
        if (!parsed) continue;
        const xy = typeof g.castleXY === 'function' ? g.castleXY(c)
          : (c.fieldId !== undefined ? C.fieldIdToCoords(Number(c.fieldId)) : null);
        if (xy) cities.push({ name: c.name, xy, config: parsed.config || {}, goals: parsed.goals || [] });
      }
      // When each block was last read: this session's own reads, else what the
      // cache already holds from any reader (the Map tab, mapscan.js), unless it
      // cached camps without their level — then it is read again.
      const world = this.mapStore().world;
      if (!this._scanSeen || this._scanSeen.world !== world) this._scanSeen = { world, at: new Map() };
      const seen = this._scanSeen.at;
      const seenOf = (o) => {
        const k = o.x + ',' + o.y;
        if (!seen.has(k)) {
          let at = 0;
          try { const b = D.mapCache.blockSeen(o.x, o.y, Session.MAP_BLOCK); at = b.unleveled ? 0 : b.at; } catch {}
          seen.set(k, at);
        }
        return seen.get(k);
      };
      const plan = NPC.scanPlan({ cities, seenOf, now: Date.now() });
      this.mapScan = { at: Date.now(), wanted: plan.wanted, due: plan.due, cities: plan.cities, asked: plan.origins.length, read: 0 };
      if (!plan.origins.length) return plan;

      await this.fetchMapBlocks(g, plan.origins);
      const store = this.mapStore();
      const mine = new Set((g.castles || []).map((c) => Number(c.fieldId)));
      const tiles = [];
      let read = 0;
      for (const o of plan.origins) {
        const k = o.x + ',' + o.y;
        const blk = store.blocks.get(k);
        // no answer: asked again after RETRY_MS, not every round
        if (!blk) { seen.set(k, Date.now() - NPC.SCAN.REFRESH_MS + NPC.SCAN.RETRY_MS); continue; }
        read++;
        seen.set(k, blk.at);
        // `relation` is how a castle stands to THIS account: not for a shared table
        for (const { relation, ...t } of this.mapBlockTiles(blk, mine)) if (NPC.keepTile(t)) tiles.push({ ...t, seen: blk.at });
      }
      if (tiles.length) D.mapCache.upsertMany(tiles);
      this.mapScan.read = read;
      const where = [...new Set(plan.origins.map((o) => o.city).filter(Boolean))].join(', ');
      this.note(`map scan: ${read}/${plan.origins.length} block(s) read around ${where || 'the farming cities'}, `
        + `${Math.max(0, plan.due - read)} more due of ${plan.wanted}`, { kind: 'net' });
      return plan;
    } catch (err) {
      this.note('background map scan: ' + err.message, { kind: 'net' });
      return null;
    } finally { this._scanBusy = false; }
  }

  // ---- the Monitor's sweep ----
  // The Monitor (monitor.js) reads the WHOLE world on a schedule and has no login
  // of its own: a second login for an account kicks whatever holds it
  // (EVONY-RULES §1), so it drives one console over HTTP instead and the server
  // still sees the single session this console already had. This is that side of
  // it — read these blocks on the live socket, keep every castle, camp, flat and
  // valley in the shared map cache the way backgroundScan does, and answer with
  // the PLAYER cities alone, which is all the Monitor reasons about.
  //
  // `drop` forgets each block again the moment it has been read. A whole-world
  // sweep is 1,600 blocks and the block store keeps them for MAP_BLOCK_KEEP, so
  // without this half an hour of the world would sit in a console's heap — and
  // consoles have run out of memory before (EVONY-RULES §7). The rows are in the
  // database either way.
  async mapSweep(points, { fresh = false, drop = true, timeoutMs = 20000 } = {}) {
    if (!this.connected) return { error: 'not connected' };
    if (this.planPhase() === 'standdown') return { error: 'standing down for maintenance' };
    const g = this.game;
    if (!g || !g.c) return { error: 'no live connection' };
    const seen = new Set(), origins = [];
    for (const p of points || []) {
      const o = Session.mapOrigin(Array.isArray(p) ? p[0] : p.x, Array.isArray(p) ? p[1] : p.y);
      const k = o.x + ',' + o.y;
      if (seen.has(k)) continue;
      seen.add(k);
      origins.push(o);
    }
    if (!origins.length) return { asked: 0, got: 0, castles: [] };
    // The account's OWN work comes first. A sweep is a big read on the same socket
    // a trading play writes orders on, and rate limiting is per account
    // (EVONY-RULES §3) — on 2026-09-23 the Monitor's account was selling stone at
    // 150 while being swept. statistics.js has waited on this for the same reason;
    // so does this now. Bounded, so a permanently busy account still gets swept.
    if (typeof g.pipeInFlight === 'function') {
      const until = Date.now() + Session.MAP_SWEEP_YIELD_MS;
      while (this.connected && g.pipeInFlight() > Session.MAP_SWEEP_BUSY && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!this.connected) return { error: 'not connected' };
    }
    await this.fetchMapBlocks(g, origins, { fresh, timeoutMs });
    const store = this.mapStore();
    const mine = new Set((g.castles || []).map((c) => Number(c.fieldId)));
    const tiles = [], castles = [];
    let got = 0;
    for (const o of origins) {
      const k = o.x + ',' + o.y;
      const blk = store.blocks.get(k);
      if (!blk) continue;                       // no answer by the deadline: the next sweep has it
      got++;
      // `relation` is how a castle stands to THIS account, which is no business of
      // a shared table — the same reason backgroundScan drops it.
      for (const { relation, ...t } of this.mapBlockTiles(blk, mine)) {
        tiles.push({ ...t, seen: blk.at });
        if (t.userName && !t.npc) {
          castles.push({ id: t.id, x: t.x, y: t.y, name: t.name, userName: t.userName,
            allianceName: t.allianceName || '', prestige: t.prestige, honor: t.honor,
            state: t.state === undefined ? null : t.state,
            // the second hex digit of the tile's terrain byte, which for an NPC camp
            // IS its level — *unverified* that a player castle's means the same
            level: t.level === undefined ? null : t.level });
        }
      }
      if (drop) store.blocks.delete(k);
    }
    // The shared map cache is a BONUS of a sweep, not its point — the Monitor keeps
    // its own player rows. Writing 18,000 tiles in one transaction while twenty
    // consoles write too overran sqlite's 5 s busy timeout on the first live sweep
    // ("database is locked", 2026-09-23), which failed the whole chunk. So: small
    // transactions, a retry, and a failure that is reported rather than thrown.
    let cached = 0, cacheError = null;
    for (let i = 0; i < tiles.length; i += Session.MAP_CACHE_CHUNK) {
      const part = tiles.slice(i, i + Session.MAP_CACHE_CHUNK);
      for (let attempt = 0; ; attempt++) {
        try { D.mapCache.upsertMany(part); cached += part.length; break; }
        catch (e) {
          if (attempt >= 2) { cacheError = e.message; break; }
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
      if (cacheError) break;
    }
    if (cacheError) this.note(`map sweep: the map cache did not take these blocks — ${cacheError}`, { kind: 'net' });
    return { asked: origins.length, got, at: Date.now(), castles, cached, cacheError };
  }

  // Ask the server about these lords by name (common.getPlayerInfoByName). The
  // Monitor's watch pass lives on this: `lastLoginTime` and `prestige` together
  // are what tell a bot that is still farming from one that has stopped. Read
  // only — no login, no order — and paced, because it is one request a name.
  async playerInfo(names, { gapMs = 150, timeoutMs = 8000 } = {}) {
    if (!this.connected) return { error: 'not connected' };
    const g = this.game;
    if (!g || !g.c) return { error: 'no live connection' };
    const rows = [], missing = [];
    for (const raw of names || []) {
      const userName = String(raw || '').trim();
      if (!userName) continue;
      let info = null;
      try {
        g.c.send('common.getPlayerInfoByName', { userName });
        const r = await g.c.await(['common.getPlayerInfoByName'], timeoutMs);
        if (r && r.data && Number(r.data.ok) === 1) info = r.data.playerInfo;
      } catch { info = null; }
      if (info) rows.push(info); else missing.push(userName);
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
    }
    return { rows, missing, at: Date.now() };
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
    if (channel === 'private') {
      // The server echoes a whisper back to its sender "from" the sender, with no
      // recipient (EVONY-RULES §5f), so remember who it went to for whisperTo.
      this._pmOut = (this._pmOut || []).filter((p) => Date.now() - p.t < 60000);
      this._pmOut.push({ to: target, msg: String(msg).replace(/<[^>]*>/g, ''), t: Date.now() });
      return g.req('common.privateChat', { targetName: target, msg }, 8000).catch(() => ({ ok: 1 }));
    }
    throw new Error('unknown channel ' + channel);
  }

  // Who a whisper line went to: a recipient field if the server ever sends one,
  // else the whisper this console sent with the same text in the last minute.
  whisperTo(data, msg) {
    const named = data.toUser || data.targetName || data.toName || data.receiverName;
    if (named) return named;
    const out = this._pmOut || [];
    const i = out.findIndex((p) => p.msg === msg && Date.now() - p.t < 60000);
    return i < 0 ? undefined : out.splice(i, 1)[0].to;
  }

  // ---- mail & reports ------------------------------------------------------
  // The header's Mail and Reports boxes open a window onto the game's own
  // mailbox. Every request below is the user opening that window or acting in
  // it — nothing polls — and a console that is not connected answers with an
  // error instead of logging in on its own (mrGame).
  //
  // Protocol (MailCommands.as / ReportCommands.as; see game.js, mailbox.js):
  //   mail.receiveMailList {pageNo, type, pageSize}    type 1 inbox, 2 system, 3 sent
  //   mail.readMail {mailId}                            opening a mail reads it (MailWin)
  //   mail.readOverMailList {mailIds}   mail.deleteMail {str_mailid}
  //   mail.sendMail {username, title, content}
  //   report.receiveReportList {pageNo, pageSize, reportType}
  //   report.markAsRead {reportId}                      opening a report; content comes back
  //   report.readOverReport {reportIds} report.deleteReport {idStr}
  //
  // Replies are matched on the command name alone (EvonyClient.await), so these
  // calls queue behind one another: two pages in flight at once would each take
  // whichever reply landed first.
  mrGame() {
    if (!this.connected || !this.game) throw new Error('not connected — connect the console first');
    return this.game;
  }
  mrQueue(fn) {
    const run = (this._mrChain || Promise.resolve()).catch(() => {}).then(() => fn());
    this._mrChain = run.catch(() => {});
    return run;
  }

  // What each id was when it was last listed — {kind, where: box|type, read}.
  // A delete refuses ids no list has shown, and a read or delete knows which
  // unread count it clears. Per login, since ids belong to one account.
  mrSeen() {
    if (!this._mrSeen || this._mrSeenFor !== this.game) { this._mrSeen = new Map(); this._mrSeenFor = this.game; }
    return this._mrSeen;
  }
  mrRemember(kind, rows, key) {
    const seen = this.mrSeen();
    for (const r of rows) {
      seen.delete(`${kind}:${r.id}`);                 // re-insert, so the map's order is its age
      seen.set(`${kind}:${r.id}`, { kind, where: r[key], read: !!r.read });
    }
    while (seen.size > 3000) seen.delete(seen.keys().next().value);
  }
  mrIds(ids, kind, { mustKnow = true } = {}) {
    const out = [];
    for (const x of Array.isArray(ids) ? ids : [ids]) {
      const n = Number(x);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`bad ${kind} id: ${x}`);
      if (!out.includes(n)) out.push(n);
    }
    if (!out.length) throw new Error(kind === 'mail' ? 'no mail selected' : 'no reports selected');
    if (out.length > 100) throw new Error('at most 100 at a time');
    if (mustKnow) {
      const seen = this.mrSeen();
      const unknown = out.filter((n) => !seen.has(`${kind}:${n}`));
      if (unknown.length) throw new Error(`${kind} ${unknown.join(', ')} is not in any list this console has shown — reload the list`);
    }
    return out;
  }

  // The header's unread totals come only from server.NewMail / server.NewReport,
  // which carry absolute counts (wire above). The real client never adjusts
  // them itself — ToolBarFrame.onHasNewMail / onHasNewReport are their only
  // writers — so the server should push fresh totals after a read or a delete.
  // Listen from before the request goes out; if no push has come a moment
  // after the reply, take what we know we just cleared off the totals
  // ourselves. A later push overwrites either way, since it is absolute.
  mrCountsAfter(push, cleared, ms = 2500) {
    const g = this.game;
    const w = { seen: false, stop() {}, settle() {} };
    if (!cleared.length || !g || !g.c || typeof g.c.on !== 'function') return w;
    const h = (cmd) => { if (cmd === push) w.seen = true; };
    g.c.on('cmd', h);
    w.stop = () => { try { g.c.off('cmd', h); } catch {} };
    w.settle = () => {
      const t = setTimeout(() => {
        w.stop();
        if (w.seen || this.game !== g || !g.player) return;
        this.mrDropUnread(g.player, push, cleared);
      }, ms);
      if (t.unref) t.unref();
    };
    return w;
  }
  mrDropUnread(p, push, cleared) {
    const dec = (k, n) => { if (n > 0) p[k] = Math.max(0, Number(p[k] || 0) - n); };
    const count = (where) => cleared.filter((c) => c.where === where).length;
    if (push === 'server.NewMail') {
      const inbox = count('inbox'), system = count('system');
      dec('newMaileCount_inbox', inbox);             // sic, the bean spells it so
      dec('newMaileCount_system', system);
      dec('newMailCount', inbox + system);
    } else {
      let all = 0;
      for (const t of ['army', 'trade', 'other']) { const n = count(t); dec('newReportCount_' + t, n); all += n; }
      dec('newReportCount', all);
    }
    this.note(`${push}: no new totals from the server — took ${cleared.length} off the header count ourselves`, { kind: 'net' });
  }

  // Item names for "treasure won" in battle reports, from the catalogue dump.
  mrItemName() {
    if (!this._mrItems) {
      this._mrItems = new Map();
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'itemdefs.json'), 'utf8'));
        this._mrItems = require('./mailbox').itemNamesFromXml(raw && raw.itemXml);
      } catch {}
    }
    return (id) => this._mrItems.get(id) || null;
  }

  // One request that reads or clears items: count watch, queue, and a clear
  // error when the server says no.
  async mrCall(push, cleared, fn, refused) {
    const w = this.mrCountsAfter(push, cleared);
    let d;
    try { d = await this.mrQueue(fn); } catch (e) { w.stop(); throw e; }
    if (!d || d.ok !== 1) { w.stop(); throw new Error((d && d.errorMsg) || refused); }
    w.settle();
    for (const k of cleared) k.read = true;
    return d;
  }
  mrCleared(kind, ids) {
    const seen = this.mrSeen();
    return ids.map((n) => seen.get(`${kind}:${n}`)).filter((k) => k && !k.read);
  }
  mrWhere(kind, ids) {
    const seen = this.mrSeen();
    return [...new Set(ids.map((n) => (seen.get(`${kind}:${n}`) || {}).where).filter(Boolean))].join('/');
  }

  async mailList(box = 'inbox', page = 1) {
    const MB = require('./mailbox');
    const type = Object.prototype.hasOwnProperty.call(MB.MAIL_BOX, box) ? MB.MAIL_BOX[box] : null;
    if (!type) throw new Error('box must be inbox, system or sent');
    const g = this.mrGame();
    const pageNo = Math.max(1, Math.floor(Number(page)) || 1);
    const d = await this.mrQueue(() => g.mailList(type, pageNo, MB.PAGE_SIZE));
    if (!d || d.ok !== 1) throw new Error((d && d.errorMsg) || 'the server refused the mail list');
    const mails = (d.mails || []).map((m) => MB.mailRow(m, box));
    this.mrRemember('mail', mails, 'box');
    return { ok: true, box, page: Number(d.pageNo) || pageNo, totalPage: Number(d.totalPage) || 0, mails };
  }

  async mailRead(id) {
    const MB = require('./mailbox');
    const [mailId] = this.mrIds(id, 'mail', { mustKnow: false });
    const g = this.mrGame();
    const known = this.mrSeen().get('mail:' + mailId);
    const d = await this.mrCall('server.NewMail', this.mrCleared('mail', [mailId]),
      () => g.readMail(mailId), 'the server would not open that mail');
    const mail = MB.mailDetail(d, known ? known.where : null);
    return { ok: true, mail: { ...mail, id: mail.id || mailId } };
  }

  async mailMarkRead(ids) {
    const list = this.mrIds(ids, 'mail');
    const g = this.mrGame();
    await this.mrCall('server.NewMail', this.mrCleared('mail', list), () => g.markMailRead(list), 'the server refused');
    return { ok: true, marked: list.length };
  }

  async mailDelete(ids) {
    const list = this.mrIds(ids, 'mail');
    const g = this.mrGame();
    const what = `${list.length} mail(s)${this.mrWhere('mail', list) ? ' from ' + this.mrWhere('mail', list) : ''}`;
    try {
      await this.mrCall('server.NewMail', this.mrCleared('mail', list), () => g.deleteMail(list), 'the server refused');
    } catch (e) { this.note(`delete ${what} -> ${e.message}`, { kind: 'act' }); throw e; }
    this.note(`delete ${what} -> ok`, { kind: 'act' });
    for (const n of list) this.mrSeen().delete('mail:' + n);
    return { ok: true, deleted: list.length };
  }

  async mailSend(to, title, body) {
    const MB = require('./mailbox');
    const v = MB.checkMail({ to, title, body });
    if (v.error) throw new Error(v.error);
    const g = this.mrGame();
    // MailWin.sendMail: "There is a 5 second cooldown on sending messages."
    const wait = (this._mrSentAt || 0) + MB.MAIL_LIMITS.cooldownMs - Date.now();
    if (wait > 0) throw new Error(`one mail every 5 seconds — try again in ${Math.ceil(wait / 1000)}s`);
    this._mrSentAt = Date.now();
    let d;
    try { d = await this.mrQueue(() => g.sendMail(v.to, v.title, v.body)); }
    catch (e) {
      this.note(`mail to ${v.to} "${v.title}" -> ${e.message}`, { kind: 'act' });
      // A lost reply says nothing about whether it went: do not invite a resend.
      throw new Error(`${e.message} — look in the Sent box before sending it again`);
    }
    const ok = !!(d && d.ok === 1);
    this.note(`mail to ${v.to} "${v.title}" -> ${ok ? 'ok' : (d && d.errorMsg) || 'refused'}`, { kind: 'act' });
    if (!ok) throw new Error((d && d.errorMsg) || 'the server refused the mail');
    return { ok: true, to: v.to, title: v.title };
  }

  async reportPage(type = 'army', page = 1) {
    const MB = require('./mailbox');
    if (!Object.prototype.hasOwnProperty.call(C.REPORT_TYPE, type)) throw new Error('type must be army, trade or other');
    const g = this.mrGame();
    const pageNo = Math.max(1, Math.floor(Number(page)) || 1);
    const d = await this.mrQueue(() => g.reportList(type, pageNo, MB.PAGE_SIZE));
    if (!d || d.ok !== 1) throw new Error((d && d.errorMsg) || 'the server refused the report list');
    const reports = (d.reports || []).map((r) => MB.reportRow(r, type));
    this.mrRemember('report', reports, 'type');
    return { ok: true, type, page: Number(d.pageNo) || pageNo, totalPage: Number(d.totalPage) || 0, reports };
  }

  async reportRead(id) {
    const MB = require('./mailbox');
    const [reportId] = this.mrIds(id, 'report', { mustKnow: false });
    const g = this.mrGame();
    const known = this.mrSeen().get('report:' + reportId);
    const d = await this.mrCall('server.NewReport', this.mrCleared('report', [reportId]),
      () => g.readReport(reportId), 'the server would not open that report');
    if (!d.report) throw new Error('the server sent no report');
    const r = d.report;
    const row = MB.reportRow(r, known ? known.where : null);
    return {
      ok: true,
      report: {
        ...row, id: row.id || reportId, read: true,
        detail: MB.describeReport(r.content, r, { itemName: this.mrItemName() }),
        // the XML itself, so an unfamiliar report can still be looked at
        content: String(r.content == null ? '' : r.content).slice(0, 50000),
      },
    };
  }

  async reportMarkRead(ids) {
    const list = this.mrIds(ids, 'report');
    const g = this.mrGame();
    await this.mrCall('server.NewReport', this.mrCleared('report', list), () => g.markReportsRead(list), 'the server refused');
    return { ok: true, marked: list.length };
  }

  async reportDelete(ids) {
    const list = this.mrIds(ids, 'report');
    const g = this.mrGame();
    const what = `${list.length} ${this.mrWhere('report', list) || ''} report(s)`.replace(/\s+/g, ' ');
    try {
      await this.mrCall('server.NewReport', this.mrCleared('report', list), () => g.deleteReports(list), 'the server refused');
    } catch (e) { this.note(`delete ${what} -> ${e.message}`, { kind: 'act' }); throw e; }
    this.note(`delete ${what} -> ok`, { kind: 'act' });
    for (const n of list) this.mrSeen().delete('report:' + n);
    return { ok: true, deleted: list.length };
  }

  // The battle log on the web, without Flash. A report's link opens the
  // game's default.html, whose WarReport.swf only fetches the report's XML
  // from beside it (mailbox.battleLogUrl) and shows it with the in-game report
  // screens; this fetches that XML and decodes it like any report. The link is
  // all it needs — no game connection — so a link pasted in chat opens too.
  // from/to are the report row's positions, which the XML does not carry.
  // A log never changes, so the last few are kept.
  async reportLog(link, { from = '', to = '' } = {}) {
    const MB = require('./mailbox');
    const log = MB.battleLogUrl(link);
    if (!log) throw new Error('that is not a battle-log link (…evony.com/default.html?logfile/….xml)');
    const cache = this._mrLogs || (this._mrLogs = new Map());
    let content = cache.get(log.xml);
    if (content === undefined) {
      content = String(await (this.fetchLog || fetchText)(log.xml));
      if (!/<reportData\b/.test(content)) throw new Error("the game's report server sent something that is not a report");
      cache.set(log.xml, content);
      while (cache.size > 50) cache.delete(cache.keys().next().value);
    }
    const pos = (v) => String(v == null ? '' : v).slice(0, 80);
    return {
      ok: true, log,
      detail: MB.describeReport(content, { startPos: pos(from), targetPos: pos(to) }, { itemName: this.mrItemName() }),
      content: content.slice(0, 50000),
    };
  }
}

module.exports = { Session, fetchText };
