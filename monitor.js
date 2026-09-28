'use strict';
// The Monitor: one watcher over the WHOLE server, not a bot in every account.
//
//   node monitor.js                 run it (the Director starts and stops it)
//   node monitor.js --once map      one full map sweep, then exit
//   node monitor.js --status        what it knows, on the console
//
// It reads three things on a schedule and keeps their history:
//
//   the map        every mapMin minutes, all 1,600 blocks of the 800x800 world:
//                  where every player city is, whose it is, its alliance, and the
//                  lord's state — peace / truce / beginner / holiday / dream truce
//                  (CityConstants, see STATE below). The map is LIVE.
//   the rankings   every statsMin minutes, the game's Statistics window end to end
//                  (statistics.js: players, alliances, heroes, cities). The server
//                  recomputes those roughly every 15 minutes, so reading them
//                  faster than that only costs pages.
//   the watch      the lords of the top N heroes, asked for by name
//                  (common.getPlayerInfoByName) — prestige, castles, ranking and
//                  lastLoginTime, for telling a bot that is farming from one that
//                  has stopped.
//
// IT NEVER LOGS IN. A second login for an account kicks whatever holds it
// (EVONY-RULES §1), and this has to run for hours, so instead it drives ONE
// console over HTTP — the account chosen in the Director → Monitor → Setup. The
// game still sees the single session that console already had; everything here is
// read-only traffic on that socket, paced by the console's own map batching and
// the statistics crawl's pauses.
//
// Everything it learns is server-wide public data, so the tables below are keyed
// by SERVER, not by organization — the same way statistics.js and the map cache
// are. Only the settings (which account, how often, how many) belong to the org.
const http = require('http');

const D = require('./db');
const ST = require('./statistics');
const AUTH = require('./auth');

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v) => (v === undefined || v === null ? '' : String(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

// A castle's `state` on the map, from the client's CityConstants (1 normal,
// 2 anti-battle, 3 fresh man, 5 vacation, 6 dream truce) and the words
// PlayerInfoTypeManager.getState puts on them. This is the ONLY reliable read of
// whether a stranger is on holiday: the player bean's `furlough` flag is not
// (EVONY-RULES §4). script-functions.js has the same table under NEAT's names.
const STATE = { 1: 'peace', 2: 'truce', 3: 'beginner', 5: 'holiday', 6: 'dreamtruce' };
const stateName = (s) => STATE[n(s)] || (s === null || s === undefined || s === '' ? '' : 'state ' + s);
const HOLIDAY = 5;

const WORLD = 800;                       // tiles a side
const BLOCK = 20;                        // the server answers at most 20x20
const BLOCKS = (WORLD / BLOCK) ** 2;     // 1,600 for a whole-world sweep

// ---------------------------------------------------------------- the tables

// One row per sweep of anything, finished or not — the Monitor tab's history and
// the "is it running" answer both come from here.
D.run(`CREATE TABLE IF NOT EXISTS mon_sweep (
  id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL, kind TEXT NOT NULL,
  startedAt INTEGER, endedAt INTEGER, asked INTEGER, got INTEGER,
  castles INTEGER, players INTEGER, events INTEGER,
  account TEXT, error TEXT)`);
D.run('CREATE INDEX IF NOT EXISTS mon_sweep_at ON mon_sweep (server, kind, startedAt)');

// Every player city the map has shown us, by its field id (y*800+x).
D.run(`CREATE TABLE IF NOT EXISTS mon_city (
  server TEXT NOT NULL, fieldId INTEGER NOT NULL, x INTEGER, y INTEGER,
  name TEXT, userName TEXT, allianceName TEXT,
  prestige REAL, honor REAL, state INTEGER, level INTEGER,
  firstSeen INTEGER, lastSeen INTEGER, sweepId INTEGER,
  PRIMARY KEY (server, fieldId))`);
for (const c of ['userName', 'allianceName', 'name']) {
  D.run(`CREATE INDEX IF NOT EXISTS mon_city_${c} ON mon_city (server, ${c} COLLATE NOCASE)`);
}
D.run('CREATE INDEX IF NOT EXISTS mon_city_seen ON mon_city (server, lastSeen)');

// CREATE TABLE IF NOT EXISTS says nothing about a table that already exists, so a
// column added after the first run has to be asked for by name.
function addColumns(table, cols) {
  const have = new Set(D.all(`PRAGMA table_info(${table})`).map((r) => r.name));
  for (const [name, decl] of Object.entries(cols)) {
    if (!have.has(name)) D.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  }
}
addColumns('mon_city', { level: 'INTEGER' });

// One row a lord, as the last complete map sweep left them, plus whatever the
// watch pass has asked the server about them by name.
//   prestigeAt  when prestige last CHANGED (not when it was last read) — the
//               whole point: a bot that is farming moves it, a stopped one doesn't
//   stateAt     when the state last changed, so "left holiday at 06:12" is exact
D.run(`CREATE TABLE IF NOT EXISTS mon_player (
  server TEXT NOT NULL, userName TEXT NOT NULL,
  allianceName TEXT, cities INTEGER, prestige REAL, honor REAL, state INTEGER,
  x INTEGER, y INTEGER,
  firstSeen INTEGER, lastSeen INTEGER,
  prestigeAt INTEGER, prevPrestige REAL,
  stateAt INTEGER, prevState INTEGER,
  rank INTEGER, population INTEGER, title INTEGER, lastLoginTime INTEGER, askedAt INTEGER,
  watch INTEGER DEFAULT 0, note TEXT,
  PRIMARY KEY (server, userName))`);
D.run('CREATE INDEX IF NOT EXISTS mon_player_alliance ON mon_player (server, allianceName COLLATE NOCASE)');
D.run('CREATE INDEX IF NOT EXISTS mon_player_prestige ON mon_player (server, prestige)');
// `state` is the CONFIRMED state; `rawState` is the last single reading. See
// confirmState() below for why one reading is not enough.
addColumns('mon_player', { rawState: 'INTEGER' });

// Prestige over time: a row only when something changed, so a year of a dead
// account is one row and a busy one is a graph.
D.run(`CREATE TABLE IF NOT EXISTS mon_player_history (
  server TEXT NOT NULL, userName TEXT NOT NULL, at INTEGER NOT NULL,
  prestige REAL, cities INTEGER, state INTEGER, allianceName TEXT, src TEXT,
  PRIMARY KEY (server, userName, at))`);
// how pruneReadings finds the old heartbeats without reading the whole table
D.run('CREATE INDEX IF NOT EXISTS mon_hist_src ON mon_player_history (server, src, at)');

// What changed, for the feed and for the alerts the user asked for.
D.run(`CREATE TABLE IF NOT EXISTS mon_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL, at INTEGER NOT NULL,
  userName TEXT, kind TEXT, detail TEXT, fromVal TEXT, toVal TEXT, watch INTEGER DEFAULT 0)`);
D.run('CREATE INDEX IF NOT EXISTS mon_event_at ON mon_event (server, at)');
D.run('CREATE INDEX IF NOT EXISTS mon_event_kind ON mon_event (server, kind, at)');
D.run('CREATE INDEX IF NOT EXISTS mon_event_who ON mon_event (server, userName, at)');

// ------------------------------------------------------------------ settings

// The Monitor's settings live with the organization that owns the fleet: which
// account's console it drives, and how hard it reads. The defaults are
// deliberately gentle — see EVONY-RULES §3 on what load in flight does.
const DEFAULTS = {
  on: false,              // the Director's Start / Stop
  account: '',            // whose console it drives (an account id, e.g. 'a2')
  mapMin: 10,             // a whole-world map sweep this often
  statsMin: 15,           // the rankings this often (the server recomputes ~15 min)
  watchMin: 15,           // the watch list asked by name this often
  watchTop: 50,           // watch the lords of the top N heroes
  watchNames: [],         // and these lords, whatever they rank
  stallMin: 45,           // prestige unchanged this long = not moving
  blocksPerCall: 45,      // map blocks per request to the console (5 batches of 9)
  pauseMs: 300,           // between requests
  // A prestige reading is normally kept only when something MOVED, so a lord
  // standing still leaves one row and the Changes tab's readings panel has
  // nothing to draw a plateau with. These two keep a heartbeat reading as well:
  // one a watched lord no oftener than this, so "it was already this number an
  // hour ago, and the hour before that" can be read off. 481 watched lords at
  // 60 minutes is about 11,500 rows a day, and the heartbeats alone are thrown
  // away after keepDays. 0 = keep no heartbeats, only the moves.
  readingEveryMin: 60,
  readingKeepDays: 14,
};
const KEY = 'monitor';
const STATUS_KEY = 'monitorStatus';

function config(org) {
  return normalize((org && org.settings.get(KEY, null)) || {});
}
// Every value the Monitor runs on goes through here, on the way in and on the way
// out. Storing a raw value and clamping only on the way out would let the database
// hold a number the page never shows: the setting looks like it "resets" on every
// save, because the save took and the read put it back (2026-09-24).
function normalize(saved) {
  const c = { ...DEFAULTS, ...(saved || {}) };
  // A number out of range is pulled back to the nearest end rather than thrown
  // away: someone typing 0 into "every N minutes" means "as often as you can",
  // not "use the default". Only a value that is no number at all falls back.
  const clamp = (v, lo, hi, dflt) => {
    const x = Number(v);
    return Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : dflt));
  };
  c.on = !!c.on;
  c.account = str(c.account);
  c.mapMin = clamp(c.mapMin, 2, 1440, DEFAULTS.mapMin);
  c.statsMin = clamp(c.statsMin, 5, 1440, DEFAULTS.statsMin);
  c.watchMin = clamp(c.watchMin, 2, 1440, DEFAULTS.watchMin);
  c.watchTop = clamp(c.watchTop, 0, 1000, DEFAULTS.watchTop);
  c.stallMin = clamp(c.stallMin, 5, 10080, DEFAULTS.stallMin);
  c.blocksPerCall = clamp(c.blocksPerCall, 9, 180, DEFAULTS.blocksPerCall);
  c.pauseMs = clamp(c.pauseMs, 0, 5000, DEFAULTS.pauseMs);
  c.readingEveryMin = clamp(c.readingEveryMin, 0, 1440, DEFAULTS.readingEveryMin);
  c.readingKeepDays = clamp(c.readingKeepDays, 1, 365, DEFAULTS.readingKeepDays);
  c.watchNames = Array.isArray(c.watchNames) ? c.watchNames.map(str).map((s) => s.trim()).filter(Boolean) : [];
  return c;
}
function setConfig(org, patch) {
  const c = normalize({ ...config(org), ...(patch || {}) });
  org.settings.set(KEY, c);
  return c;
}
const readStatus = (org) => (org && org.settings.get(STATUS_KEY, null)) || {};
const writeStatus = (org, patch) => org.settings.set(STATUS_KEY, { ...readStatus(org), ...patch, at: now() });

// --------------------------------------------------------- talking to a console

// The console the Monitor drives. botctl records every console it starts under
// the org's `bots` setting; consoles are pinned to one account each, so the
// account's own console is the only one allowed to answer for it.
function consoleUrl(org, accountId) {
  const bots = org.settings.get('bots', {}) || {};
  const rec = bots[accountId];
  if (rec && rec.url) return String(rec.url).replace(/\/$/, '');
  for (const p of org.settings.get('probes', []) || []) {
    if (p && p.accountId === accountId && p.url) return String(p.url).replace(/\/$/, '');
  }
  return null;
}

function ask(url, { method = 'GET', body = null, timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (o) => { if (!done) { done = true; resolve(o); } };
    const data = body === null ? null : Buffer.from(JSON.stringify(body));
    let u;
    try { u = new URL(url); } catch (e) { return finish({ ok: false, error: e.message }); }
    // A console is behind the same login as everything else, and the Monitor has
    // no browser session — so it identifies itself with the machine's internal
    // token, which auth.js accepts for exactly the read-only routes it needs.
    const req = http.request(u, {
      method,
      headers: {
        'x-otto-internal': AUTH.internalToken(),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
      timeout,
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return finish({ ok: false, error: 'the console refused the internal token — is it running this build?' });
        }
        try { finish({ ok: res.statusCode < 400, status: res.statusCode, json: JSON.parse(b || '{}') }); }
        catch { finish({ ok: false, error: `the console answered ${res.statusCode} with something that is not JSON` }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('the console did not answer in time')); });
    req.on('error', (e) => finish({ ok: false, error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

// Is that console up, logged in, and holding the account we were told to use?
// Asked before every pass — a console restarted onto another account, or one
// between logins, must not be sent a sweep.
async function reachConsole(org, accountId) {
  const url = consoleUrl(org, accountId);
  if (!url) return { error: `no console is registered for ${accountId} — start its bot first` };
  const r = await ask(url + '/api/session', { timeout: 5000 });
  if (!r.ok || !r.json) return { error: `${url} did not answer (${r.error || r.status})` };
  const acc = r.json.account || {};
  if (acc.id !== accountId) return { error: `${url} is running ${acc.id || 'nothing'}, not ${accountId}` };
  if (r.json.connected === false) return { error: `${acc.label || accountId}'s console is not logged in` };
  return { url, account: acc, session: r.json };
}

// ------------------------------------------------------------- the map sweep

// The blocks of the whole world, in reading order.
function worldBlocks() {
  const out = [];
  for (let y = 0; y < WORLD; y += BLOCK) for (let x = 0; x < WORLD; x += BLOCK) out.push([x, y]);
  return out;
}

const sweepStart = (server, kind, account) => {
  D.run('INSERT INTO mon_sweep (server, kind, startedAt, account) VALUES (?,?,?,?)', server, kind, now(), str(account));
  return n((D.one('SELECT last_insert_rowid() id') || {}).id);
};
const sweepEnd = (id, o) => D.run(`UPDATE mon_sweep SET endedAt = ?, asked = ?, got = ?, castles = ?,
  players = ?, events = ?, error = ? WHERE id = ?`,
now(), n(o.asked), n(o.got), n(o.castles), n(o.players), n(o.events), o.error || null, id);

// One whole-world sweep, a chunk of blocks at a time through the console.
// `onProgress` is how the Director's page watches it crawl.
async function mapSweep({ org, server, accountId, cfg, log = () => {}, stop = () => false, onProgress = () => {} }) {
  const con = await reachConsole(org, accountId);
  if (con.error) return { error: con.error };
  const id = sweepStart(server, 'map', con.account.label || accountId);
  const blocks = worldBlocks();
  const byName = new Map();            // userName -> the castles we saw of theirs
  let got = 0, castles = 0, failed = 0, lastErr = null;
  const t0 = now();
  for (let i = 0; i < blocks.length; i += cfg.blocksPerCall) {
    if (stop()) { sweepEnd(id, { asked: i, got, castles, error: 'stopped' }); return { id, stopped: true, got, castles }; }
    const chunk = blocks.slice(i, i + cfg.blocksPerCall);
    // The console sends nine blocks at a time and each batch waits up to 15 s for
    // the last reply, so a big chunk can legitimately take minutes. Give the
    // request room for that or a slow sweep looks like a dead console.
    const r = await ask(con.url + '/api/mapsweep', {
      method: 'POST', body: { blocks: chunk, drop: true }, timeout: 30000 + chunk.length * 2500,
    });
    const out = r.json || {};
    if (!r.ok || out.error) {
      failed += chunk.length;
      lastErr = out.error || r.error || `the console answered ${r.status}`;
      // A sweep is many chunks; one bad answer (a reconnect, a maintenance
      // stand-down) is not worth losing the rest of the world over, but a console
      // that has gone away will fail every one of them — so give up once it is
      // clearly down rather than spending the whole period on timeouts.
      if (failed > chunk.length * 3) {
        sweepEnd(id, { asked: i + chunk.length, got, castles, error: lastErr });
        return { id, error: lastErr, got, castles };
      }
      await sleep(Math.max(cfg.pauseMs, 2000));
      continue;
    }
    got += n(out.got);
    for (const c of out.castles || []) {
      castles++;
      const list = byName.get(c.userName) || [];
      list.push(c);
      byName.set(c.userName, list);
    }
    onProgress({ id, blocks: i + chunk.length, of: blocks.length, castles, startedAt: t0 });
    if (cfg.pauseMs) await sleep(cfg.pauseMs);
  }
  // The world is in: only now is a player's city COUNT trustworthy, so the player
  // rows and their events are written in one go at the end.
  // Twenty consoles share this database and sqlite gives up after 5 s, so a write
  // this size can lose the race ("database is locked", seen live 2026-09-23). The
  // transaction rolls back whole, which makes another go safe.
  let res = null;
  for (let attempt = 0; ; attempt++) {
    try { res = applySweep({ server, sweepId: id, byName, at: now(), full: failed === 0 }); break; }
    catch (e) {
      if (attempt >= 3) {
        log(`map sweep: could not save it — ${e.message}`);
        sweepEnd(id, { asked: blocks.length, got, castles, error: e.message });
        return { id, got, castles, error: e.message };
      }
      log(`map sweep: saving it — ${e.message}, again in ${attempt + 1}s`);
      await sleep(1000 * (attempt + 1));
    }
  }
  sweepEnd(id, { asked: blocks.length, got, castles, players: res.players, events: res.events, error: lastErr });
  log(`map sweep: ${got}/${blocks.length} blocks, ${castles.toLocaleString('en-US')} player cities, `
    + `${res.players.toLocaleString('en-US')} lords, ${res.events} change(s), ${Math.round((now() - t0) / 1000)} s`
    + (failed ? ` — ${failed} block(s) unanswered` : ''));
  return { id, got, castles, ...res, error: lastErr };
}

// ------------------------------------------------------------- the analysis

const event = (server, at, userName, kind, detail, fromVal, toVal, watch) =>
  D.run('INSERT INTO mon_event (server, at, userName, kind, detail, fromVal, toVal, watch) VALUES (?,?,?,?,?,?,?,?)',
    server, at, str(userName), kind, str(detail),
    fromVal === null || fromVal === undefined ? null : str(fromVal),
    toVal === null || toVal === undefined ? null : str(toVal), watch ? 1 : 0);

// Turn a finished sweep into city rows, player rows, history and events.
// Exported so the tests can drive it without a game or a console.
function applySweep({ server, sweepId, byName, at = Date.now(), full = true }) {
  const cityIns = D.db.prepare(`INSERT INTO mon_city
    (server, fieldId, x, y, name, userName, allianceName, prestige, honor, state, level, firstSeen, lastSeen, sweepId)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(server, fieldId) DO UPDATE SET x=excluded.x, y=excluded.y, name=excluded.name,
      userName=excluded.userName, allianceName=excluded.allianceName, prestige=excluded.prestige,
      honor=excluded.honor, state=excluded.state, level=excluded.level,
      lastSeen=excluded.lastSeen, sweepId=excluded.sweepId`);
  const prevStmt = D.db.prepare('SELECT * FROM mon_player WHERE server = ? AND userName = ?');
  const playerIns = D.db.prepare(`INSERT INTO mon_player (server, userName, allianceName, cities, prestige,
      honor, state, rawState, x, y, firstSeen, lastSeen, prestigeAt, prevPrestige, stateAt, prevState)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(server, userName) DO UPDATE SET allianceName=excluded.allianceName,
      cities=COALESCE(excluded.cities, mon_player.cities), prestige=excluded.prestige,
      honor=excluded.honor, state=excluded.state, rawState=excluded.rawState,
      x=excluded.x, y=excluded.y, lastSeen=excluded.lastSeen,
      prestigeAt=excluded.prestigeAt, prevPrestige=excluded.prevPrestige,
      stateAt=excluded.stateAt, prevState=excluded.prevState`);
  const histIns = D.db.prepare(`INSERT OR REPLACE INTO mon_player_history
    (server, userName, at, prestige, cities, state, allianceName, src) VALUES (?,?,?,?,?,?,?,?)`);
  let players = 0, events = 0;
  const pending = [];
  D.db.exec('BEGIN');
  try {
    for (const [userName, list] of byName) {
      if (!userName) continue;
      players++;
      for (const c of list) {
        cityIns.run(server, n(c.id), n(c.x), n(c.y), str(c.name), str(userName), str(c.allianceName),
          n(c.prestige), n(c.honor), c.state === undefined || c.state === null ? null : n(c.state),
          c.level === undefined || c.level === null ? null : n(c.level), at, at, sweepId);
      }
      // A lord's cities all carry their lord-wide figures; take the first that
      // has one rather than assuming every castle answered with them.
      const first = list[0];
      const pick = (f) => {
        for (const c of list) if (c[f] !== undefined && c[f] !== null && c[f] !== '') return c[f];
        return null;
      };
      const prestige = Math.max(...list.map((c) => n(c.prestige)));
      const state = pick('state') === null ? null : n(pick('state'));
      const alliance = str(pick('allianceName'));
      const cities = full ? list.length : null;
      const was = prevStmt.get(server, userName) || null;
      const wasState = was && was.state !== null && was.state !== undefined ? n(was.state) : null;
      // A state has to be read the SAME WAY TWICE before it is believed.
      //
      // On 2026-09-23, ten minutes after maintenance, the map called Lord03 and
      // Lord16 `peace` while both accounts' own FurloughBuff said holiday with 23h21m
      // left — so a single sweep announced two holidays ending that had not ended.
      // Whatever the cause (EVONY-RULES §6 has the evidence, the cause is unverified),
      // one odd reading must not raise an alert. `state` is only moved when two
      // readings in a row agree; `rawState` remembers the last single one.
      const rawWas = was && was.rawState !== null && was.rawState !== undefined ? n(was.rawState) : null;
      const confirmed = !was ? state : (state === rawWas ? state : wasState);
      const prestigeMoved = !was || n(was.prestige) !== prestige;
      const stateMoved = !was || wasState !== confirmed;

      playerIns.run(server, userName, alliance, cities, prestige, n(pick('honor')), confirmed, state, n(first.x), n(first.y),
        was ? n(was.firstSeen) || at : at, at,
        prestigeMoved ? at : n(was.prestigeAt) || at,
        prestigeMoved && was ? n(was.prestige) : (was ? was.prevPrestige : null),
        stateMoved ? at : (was ? n(was.stateAt) || at : at),
        stateMoved && was ? wasState : (was ? was.prevState : null));

      if (prestigeMoved || stateMoved || !was || str(was.allianceName) !== alliance) {
        histIns.run(server, userName, at, prestige, cities, confirmed, alliance, 'map');
      }
      if (was) pending.push({ userName, was, wasState, state: confirmed, alliance, prestige, cities, watch: n(was.watch) });
    }
    D.db.exec('COMMIT');
  } catch (e) { D.db.exec('ROLLBACK'); throw e; }

  // The events the user asked for, written outside the big transaction so a
  // failure here cannot lose the sweep itself.
  for (const p of pending) {
    const { userName, was, wasState, watch } = p;
    if (wasState !== p.state && !(wasState === null && p.state === null)) {
      // The headline one: a lord who has been sitting out comes back to the map.
      const kind = wasState === HOLIDAY ? 'left-holiday' : p.state === HOLIDAY ? 'went-holiday' : 'state';
      const detail = kind === 'left-holiday'
        ? `${userName} came off holiday — now ${stateName(p.state) || 'unknown'}`
        : kind === 'went-holiday' ? `${userName} went on holiday`
          : `${userName} is now ${stateName(p.state) || 'unknown'} (was ${stateName(wasState) || 'unknown'})`;
      event(server, at, userName, kind, detail, stateName(wasState), stateName(p.state), watch);
      events++;
    }
    if (str(was.allianceName) !== p.alliance) {
      event(server, at, userName, 'alliance',
        p.alliance ? `${userName} joined ${p.alliance}` : `${userName} left ${was.allianceName}`,
        was.allianceName, p.alliance, watch);
      events++;
    }
    if (p.cities !== null && n(was.cities) && n(was.cities) !== p.cities) {
      event(server, at, userName, 'cities',
        `${userName} ${p.cities > n(was.cities) ? 'gained' : 'lost'} a city — ${was.cities} → ${p.cities}`,
        was.cities, p.cities, watch);
      events++;
    }
  }
  return { players, events };
}

// Who is not moving: a lord whose prestige has not changed for `stallMin`, who is
// NOT on holiday (a holidayed account cannot move it, so its stillness says
// nothing) and whom we have watched long enough to tell.
function stalled(server, { stallMin = 45, watchOnly = true, limit = 200 } = {}) {
  const cut = now() - Math.max(1, n(stallMin)) * 60000;
  return D.all(`SELECT * FROM mon_player
    WHERE server = ? AND (? = 0 OR watch = 1)
      AND (state IS NULL OR state <> ${HOLIDAY})
      AND prestigeAt IS NOT NULL AND prestigeAt < ?
      AND firstSeen < ?
    ORDER BY prestige DESC LIMIT ?`, server, watchOnly ? 1 : 0, cut, cut, Math.max(1, n(limit) || 200))
    .map((r) => ({ ...r, stateName: stateName(r.state), stillMin: Math.round((now() - n(r.prestigeAt)) / 60000) }));
}

// ------------------------------------------------------------- the watch list

// Who to watch: the lords of the top N heroes in the rankings, plus any names the
// user added. Heroes are ranked by level and the hero list names its lord, so
// "the top 50 heroes" turns straight into the accounts worth watching.
function watchList(server, cfg) {
  const names = new Map();
  if (cfg.watchTop > 0) {
    for (const r of D.all(`SELECT lord, name, level FROM stat_heroes
      WHERE server = ? AND lord <> '' ORDER BY rank LIMIT ?`, server, cfg.watchTop)) {
      if (!names.has(r.lord)) names.set(r.lord, { userName: r.lord, why: `hero ${r.name} (L${n(r.level)})` });
    }
  }
  for (const nm of cfg.watchNames) if (!names.has(nm)) names.set(nm, { userName: nm, why: 'named by you' });
  return [...names.values()];
}

// Mark exactly this set as watched, so the tab and stalled() agree with the
// setting even after the top N has been changed.
function setWatched(server, list) {
  D.run('UPDATE mon_player SET watch = 0 WHERE server = ? AND watch = 1', server);
  const t = now();
  for (const w of list) {
    D.run(`INSERT INTO mon_player (server, userName, watch, firstSeen, lastSeen, note) VALUES (?,?,1,?,?,?)
      ON CONFLICT(server, userName) DO UPDATE SET watch = 1, note = excluded.note`,
    server, w.userName, t, t, w.why || '');
  }
}

// Ask the console for each watched lord by name. This is the live read —
// common.getPlayerInfoByName answers with prestige, castleCount, ranking,
// population and lastLoginTime — and it is what turns "their prestige has not
// moved" into a verdict rather than a guess.
async function watchPass({ org, server, accountId, cfg, log = () => {}, stop = () => false }) {
  const con = await reachConsole(org, accountId);
  if (con.error) return { error: con.error };
  const list = watchList(server, cfg);
  if (!list.length) return { asked: 0, error: 'nothing to watch — set "top N heroes", or add a name' };
  setWatched(server, list);
  const id = sweepStart(server, 'watch', con.account.label || accountId);
  const at = now();
  let got = 0, events = 0, lastErr = null;
  // In batches, so one slow name cannot hold the whole pass and the console can
  // pace the lookups itself.
  const BATCH = 25;
  for (let i = 0; i < list.length; i += BATCH) {
    if (stop()) break;
    const names = list.slice(i, i + BATCH).map((w) => w.userName);
    const r = await ask(con.url + '/api/players', { method: 'POST', body: { names }, timeout: 120000 });
    const out = r.json || {};
    if (!r.ok || out.error) {
      lastErr = out.error || r.error || `the console answered ${r.status}`;
      log(`watch: ${lastErr}`);
      await sleep(2000);
      continue;
    }
    for (const p of out.rows || []) {
      got++;
      events += recordWatched(server, p, at, cfg);
    }
    if (cfg.pauseMs) await sleep(cfg.pauseMs);
  }
  sweepEnd(id, { asked: list.length, got, players: got, events, error: lastErr });
  const dropped = pruneReadings(server, cfg);
  log(`watch: ${got}/${list.length} lord(s) read, ${events} change(s)`
    + (dropped ? `, ${dropped} old heartbeat reading(s) dropped` : ''));
  return { id, asked: list.length, got, events, error: got ? null : lastErr };
}

// One watched lord's live figures. Returns how many events it raised.
// The heartbeat readings alone are thrown away once they are old enough. A
// reading that recorded a MOVE is history and is kept for ever — that is the
// row that answers "when did this lord stop" a year from now. Run after every
// watch pass, so the table has a ceiling rather than a slope.
function pruneReadings(server, cfg) {
  const days = n((cfg || {}).readingKeepDays) || DEFAULTS.readingKeepDays;
  const r = D.run("DELETE FROM mon_player_history WHERE server = ? AND src = 'watch-still' AND at < ?",
    server, now() - days * 86400000);
  return n(r && r.changes);
}

function recordWatched(server, p, at, cfg) {
  const userName = str(p.userName);
  if (!userName) return 0;
  const was = D.one('SELECT * FROM mon_player WHERE server = ? AND userName = ?', server, userName) || null;
  const prestige = n(p.prestige);
  const moved = !was || n(was.prestige) !== prestige;
  const prestigeAt = moved ? at : n(was.prestigeAt) || at;
  D.run(`INSERT INTO mon_player (server, userName, allianceName, cities, prestige, honor, rank, population,
      title, lastLoginTime, askedAt, firstSeen, lastSeen, prestigeAt, prevPrestige, watch)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
    ON CONFLICT(server, userName) DO UPDATE SET allianceName=excluded.allianceName, cities=excluded.cities,
      prestige=excluded.prestige, honor=excluded.honor, rank=excluded.rank, population=excluded.population,
      title=excluded.title, lastLoginTime=excluded.lastLoginTime, askedAt=excluded.askedAt,
      lastSeen=excluded.lastSeen, prestigeAt=excluded.prestigeAt, prevPrestige=excluded.prevPrestige, watch=1`,
  server, userName, str(p.alliance), n(p.castleCount), prestige, n(p.honor), n(p.ranking), n(p.population),
  n(p.titleId), n(p.lastLoginTime), at, was ? n(was.firstSeen) || at : at, at,
  prestigeAt, moved && was ? n(was.prestige) : (was ? was.prevPrestige : null));

  // A reading is kept when the prestige MOVED -- that is the history proper --
  // and otherwise as a heartbeat, no oftener than readingEveryMin. Without the
  // heartbeat a lord who has stood still for two days leaves exactly one row,
  // and "it was already this number an hour ago" cannot be shown at all. The
  // two are told apart by `src` so the heartbeats alone can be thrown away
  // later (pruneReadings).
  const every = n(cfg.readingEveryMin);
  let keep = moved;
  if (!keep && every > 0) {
    const last = D.one('SELECT at FROM mon_player_history WHERE server = ? AND userName = ? ORDER BY at DESC LIMIT 1',
      server, userName);
    keep = !last || at - n(last.at) >= every * 60000;
  }
  if (keep) {
    D.run(`INSERT OR REPLACE INTO mon_player_history (server, userName, at, prestige, cities, state, allianceName, src)
      VALUES (?,?,?,?,?,?,?,?)`, server, userName, at, prestige, n(p.castleCount),
    was ? was.state : null, str(p.alliance), moved ? 'watch' : 'watch-still');
  }
  if (!was) return 0;
  // A lord on holiday cannot move prestige, so their stillness means nothing.
  if (n(was.state) === HOLIDAY) return 0;

  // "Stopped" and "started again" are each worth saying ONCE, so they are raised
  // on the crossing: an unbroken still spell is the one that began at prestigeAt,
  // and it has been called out already if an event for it is on the record.
  const stillMin = Math.round((at - prestigeAt) / 60000);
  const said = D.one(`SELECT id FROM mon_event WHERE server = ? AND userName = ? AND kind = 'stalled' AND at >= ?`,
    server, userName, prestigeAt);
  if (!moved && stillMin >= cfg.stallMin && !said) {
    event(server, at, userName, 'stalled', `${userName} has not moved prestige for ${stillMin} min`, null, null, 1);
    return 1;
  }
  if (moved) {
    const wasStill = Math.round((at - (n(was.prestigeAt) || at)) / 60000);
    const toldAbout = D.one(`SELECT id FROM mon_event WHERE server = ? AND userName = ? AND kind = 'stalled' AND at >= ?`,
      server, userName, n(was.prestigeAt) || at);
    if (toldAbout) {
      event(server, at, userName, 'moving',
        `${userName} is moving again (+${(prestige - n(was.prestige)).toLocaleString('en-US')} prestige after ${wasStill} min still)`,
        was.prestige, prestige, 1);
      return 1;
    }
  }
  return 0;
}

// ------------------------------------------------------------- the rankings

// Reading the Statistics window is the console's own job (statistics.js), so the
// Monitor only asks it to start and then waits for it to finish. The rows land in
// the same stat_* tables the console's Statistics tab reads.
async function statsPass({ org, server, accountId, log = () => {}, stop = () => false }) {
  const con = await reachConsole(org, accountId);
  if (con.error) return { error: con.error };
  const id = sweepStart(server, 'stats', con.account.label || accountId);
  const r = await ask(con.url + '/api/stats/refresh', { method: 'POST', body: {}, timeout: 30000 });
  const out = r.json || {};
  if (!r.ok || out.ok === false) {
    const error = out.error || r.error || `the console answered ${r.status}`;
    sweepEnd(id, { error });
    return { id, error };
  }
  // It runs in the console's background; wait for its own status to say it is done.
  const t0 = now();
  let rows = 0;
  for (;;) {
    if (stop()) break;
    await sleep(5000);
    const s = await ask(con.url + '/api/stats', { timeout: 15000 });
    const st = (s.json || {}).status;
    if (!st) break;
    rows = Object.values(st.lists || {}).reduce((a, l) => a + n(l.rows), 0);
    if (!st.running) break;
    if (now() - t0 > 30 * 60000) break;                       // never wait past one period
  }
  sweepEnd(id, { got: rows, players: n((D.one('SELECT count(*) c FROM stat_players WHERE server = ?', server) || {}).c) });
  log(`rankings read — ${rows.toLocaleString('en-US')} row(s) across the four lists`);
  return { id, rows };
}

// ---------------------------------------------------------------- searching

// The Director's Statistics view. The four ranked lists are statistics.js's; what
// it adds is a filter per COLUMN, so "every player in alliance X", "every hero of
// player Y" and "every city of level 10 in alliance Z" are each one query rather
// than a text search over everything.
const searchStats = (server, kind, opts = {}) => ST.searchKind(server, kind, opts);

// Every alliance the map has seen, for the Director's alliance picker: the name,
// how many lords fly it and how many cities they hold between them. Lords with no
// alliance at all come back as one row with an empty name, because "nobody's
// lords" is a group to keep or hide like any other.
function alliances(server) {
  return D.all(`SELECT coalesce(allianceName, '') AS name, count(*) AS lords,
    coalesce(sum(cities), 0) AS cities FROM mon_player WHERE server = ?
    GROUP BY coalesce(allianceName, '') COLLATE NOCASE
    ORDER BY lords DESC, name COLLATE NOCASE`, server)
    .map((r) => ({ name: str(r.name), lords: n(r.lords), cities: n(r.cities) }));
}

// One alliance filter, shared by the cities, the lords and the changes: a list of
// names to KEEP (`allies`) or a list to DROP (`notAllies`). An empty name in the
// list means "no alliance at all".
//
// coalesce() is what makes the exclusion honest. `NOT (NULL IN ('NEAT'))` is
// NULL, not true, so without it a user who asked only to hide one alliance would
// silently lose every lord who is in none — which on a fresh map is most of them.
function allyClause(col, names, drop) {
  const list = [...new Set((names || []).map((x) => str(x)))];
  if (!list.length) return null;
  const sql = `coalesce(${col}, '') COLLATE NOCASE IN (${list.map(() => '?').join(',')})`;
  return { sql: drop ? `NOT (${sql})` : sql, args: list };
}

// Both lists, onto a WHERE that is being built. Keeping and dropping are allowed
// together: "only these three, but not that one of them" is a sensible thing to
// ask for and costs nothing to allow.
function allyWhere(where, args, col, allies, notAllies) {
  for (const c of [allyClause(col, allies, false), allyClause(col, notAllies, true)]) {
    if (c) { where.push(c.sql); args.push(...c.args); }
  }
}

// The cities the map sweep found, filtered the same way. This is the live table:
// the rankings only list the top cities, the map has every one of them, with
// where it is and what state its lord is in.
function searchCities(server, { q = '', alliance = '', allies = [], notAllies = [], lord = '', state = '',
  minPrestige = '', level = '', sort = 'prestige', dir = 'desc', limit = 200, offset = 0, seenMin = 0 } = {}) {
  const where = ['server = ?'], args = [server];
  const like = (v) => `%${String(v).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  if (q) { where.push("(name LIKE ? ESCAPE '\\' OR userName LIKE ? ESCAPE '\\')"); args.push(like(q), like(q)); }
  if (alliance) { where.push("allianceName LIKE ? ESCAPE '\\'"); args.push(like(alliance)); }
  allyWhere(where, args, 'allianceName', allies, notAllies);
  if (lord) { where.push("userName LIKE ? ESCAPE '\\'"); args.push(like(lord)); }
  if (state !== '' && state !== null && state !== undefined) { where.push('state = ?'); args.push(n(state)); }
  if (minPrestige !== '' && minPrestige !== null) { where.push('prestige >= ?'); args.push(n(minPrestige)); }
  if (level !== '' && level !== null && level !== undefined) { where.push('level = ?'); args.push(n(level)); }
  if (seenMin) { where.push('lastSeen >= ?'); args.push(now() - n(seenMin) * 60000); }
  const cols = ['fieldId', 'x', 'y', 'name', 'userName', 'allianceName', 'prestige', 'honor', 'state', 'level', 'lastSeen'];
  const by = cols.includes(sort) ? sort : 'prestige';
  const d = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const text = ['name', 'userName', 'allianceName'].includes(by);
  const total = n((D.one(`SELECT count(*) c FROM mon_city WHERE ${where.join(' AND ')}`, ...args) || {}).c);
  const rows = D.all(`SELECT ${cols.join(', ')} FROM mon_city WHERE ${where.join(' AND ')}
    ORDER BY ${by}${text ? ' COLLATE NOCASE' : ''} ${d}, fieldId LIMIT ? OFFSET ?`,
  ...args, Math.max(1, Math.min(5000, n(limit) || 200)), Math.max(0, n(offset)))
    .map((r) => ({ ...r, stateName: stateName(r.state) }));
  return { total, rows, offset: Math.max(0, n(offset)) };
}

// The players the map sweep found: one row a lord, with how long their prestige
// has stood still and what state they are in.
function searchPlayers(server, { q = '', alliance = '', allies = [], notAllies = [], state = '',
  watch = false, moving = '', sort = 'prestige', dir = 'desc', limit = 200, offset = 0, stallMin = 45 } = {}) {
  const where = ['server = ?'], args = [server];
  const like = (v) => `%${String(v).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  if (q) { where.push("userName LIKE ? ESCAPE '\\'"); args.push(like(q)); }
  if (alliance) { where.push("allianceName LIKE ? ESCAPE '\\'"); args.push(like(alliance)); }
  allyWhere(where, args, 'allianceName', allies, notAllies);
  if (state !== '' && state !== null && state !== undefined) { where.push('state = ?'); args.push(n(state)); }
  if (watch) where.push('watch = 1');
  const cut = now() - Math.max(1, n(stallMin)) * 60000;
  if (moving === 'still') { where.push(`prestigeAt < ? AND (state IS NULL OR state <> ${HOLIDAY})`); args.push(cut); }
  if (moving === 'moving') { where.push('prestigeAt >= ?'); args.push(cut); }
  const cols = ['userName', 'allianceName', 'cities', 'prestige', 'honor', 'state', 'x', 'y', 'rank',
    'population', 'lastLoginTime', 'firstSeen', 'lastSeen', 'prestigeAt', 'prevPrestige', 'stateAt', 'watch', 'note'];
  const by = cols.includes(sort) ? sort : 'prestige';
  const d = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const text = ['userName', 'allianceName', 'note'].includes(by);
  const total = n((D.one(`SELECT count(*) c FROM mon_player WHERE ${where.join(' AND ')}`, ...args) || {}).c);
  const rows = D.all(`SELECT ${cols.join(', ')} FROM mon_player WHERE ${where.join(' AND ')}
    ORDER BY ${by}${text ? ' COLLATE NOCASE' : ''} ${d}, userName LIMIT ? OFFSET ?`,
  ...args, Math.max(1, Math.min(5000, n(limit) || 200)), Math.max(0, n(offset)))
    .map((r) => ({
      ...r,
      stateName: stateName(r.state),
      stillMin: r.prestigeAt ? Math.round((now() - n(r.prestigeAt)) / 60000) : null,
      still: !!(r.prestigeAt && n(r.prestigeAt) < cut && n(r.state) !== HOLIDAY),
    }));
  return { total, rows, offset: Math.max(0, n(offset)) };
}

// The best hero each of these lords owns — the Changes table's "Best hero"
// column, so a row says how much weight is behind the name in it.
//
// It comes out of the rankings sweep (stat_heroes, rank.getHeroRank), not from a
// live read: nothing here asks the game anything. That list is the game's own
// hero ranking and it is ordered by LEVEL, so a lord's highest-level ranked hero
// IS their best one — the same hero the watch list already names them by.
//
// Only RANKED heroes are in it (110,722 of them on ss71, held by 2,250 lords), so
// a lord whose heroes are all too small to rank has no answer here rather than a
// wrong one. A stale answer is possible too and is fine: the rankings are swept
// every 15 minutes and a hero's level does not move in a hurry.
//
// One query for the whole page rather than one a row.
function bestHeroes(server, names) {
  const want = [...new Set((names || []).map((x) => str(x)).filter(Boolean))];
  const out = new Map();
  // sqlite takes 999 bound variables at most, and `server` is one of them.
  const CHUNK = 400;
  for (let i = 0; i < want.length; i += CHUNK) {
    const part = want.slice(i, i + CHUNK);
    const marks = part.map(() => '?').join(',');
    const rows = D.all(`SELECT lord, name, level, attack, politics, intel FROM stat_heroes
      WHERE server = ? AND lord COLLATE NOCASE IN (${marks}) ORDER BY level DESC, rank ASC`,
    server, ...part);
    // the first row of each lord is their best, the ORDER BY having done the work
    for (const r of rows) {
      const k = str(r.lord).toLowerCase();
      if (out.has(k)) continue;
      out.set(k, { name: str(r.name), level: n(r.level), attack: n(r.attack),
        politics: n(r.politics), intel: n(r.intel) });
    }
  }
  return out;
}

// Everything about one lord that a scouting run needs: where every city of theirs
// is, and their best heroes. The Changes table opens this when the best hero is
// clicked, and the coordinates go out as a script the user pastes into a city.
//
// The lord is matched EXACTLY, case aside. searchCities matches a lord with LIKE,
// which is right for a search box and wrong here — a scout list for "Thrall" must
// not carry "Thrall2"'s cities.
//
// The cities are the map sweep's (every 10 minutes by default), so a city taken
// or founded since the last one is not in this yet. Cities come in map reading
// order, which is the order the array goes out in.
function lordSheet(server, userName, { heroes = 10, readings = 200 } = {}) {
  const name = str(userName);
  if (!name) return { userName: '', cities: [], heroes: [], readings: [], movedAt: null, prestige: null };
  const cities = D.all(`SELECT fieldId, x, y, name, allianceName, state, level, prestige, lastSeen
    FROM mon_city WHERE server = ? AND userName = ? COLLATE NOCASE ORDER BY y, x`, server, name)
    .map((r) => ({ ...r, stateName: stateName(r.state) }));
  const top = D.all(`SELECT rank, name, level, attack, politics, intel FROM stat_heroes
    WHERE server = ? AND lord = ? COLLATE NOCASE ORDER BY level DESC, rank ASC LIMIT ?`,
  server, name, Math.max(1, Math.min(50, n(heroes) || 10)));
  // Every prestige reading we hold, newest first — the answer to "it says they
  // stopped 2,729 minutes ago, but what was the number and when exactly?".
  // `moved` marks a reading that differs from the one before it (the one before
  // in TIME, so the list is walked oldest-first to work them out), and `movedAt`
  // is the newest of those: the moment the standing still began.
  const rows = D.all(`SELECT at, prestige, cities, state, allianceName, src FROM mon_player_history
    WHERE server = ? AND userName = ? COLLATE NOCASE ORDER BY at DESC LIMIT ?`,
  server, name, Math.max(1, Math.min(5000, n(readings) || 200)));
  let movedAt = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const prev = rows[i + 1];                       // the reading before it in time
    rows[i].moved = !prev || n(prev.prestige) !== n(rows[i].prestige);
    // the oldest reading has nothing to be compared with, so it is not a move
    if (!prev) rows[i].moved = false;
    if (rows[i].moved && (movedAt === null || n(rows[i].at) > movedAt)) movedAt = n(rows[i].at);
  }
  return { userName: name, cities, heroes: top, readings: rows, movedAt,
    prestige: rows.length ? n(rows[0].prestige) : null };
}

// ---- the Changes feed ----
// Two readers over one WHERE. `events()` hands back a plain array and is what
// the rest of the Monitor and every test asks "what changed for this lord"; it
// is left exactly as it was. `eventPage()` is the Changes TABLE: the same rows,
// searched, sorted on any column it shows, and a page at a time with a total.
function eventWhere(server, { kind = '', userName = '', watch = false, q = '',
  allies = [], notAllies = [], sinceMs = 0, stillMin = 0 }) {
  const where = ['server = ?'], args = [server];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (userName) { where.push('userName = ? COLLATE NOCASE'); args.push(userName); }
  if (watch) where.push('watch = 1');
  // mon_event holds no alliance — a change is about a LORD, and which alliance a
  // lord is in lives in mon_player, one row each. So the filter is a sub-select
  // over that table rather than a column here. A lord the map has never seen is
  // in no alliance and so survives an exclusion, which is the honest answer.
  for (const [names, drop] of [[allies, false], [notAllies, true]]) {
    const c = allyClause('allianceName', names, false);
    if (!c) continue;
    const inSet = `userName COLLATE NOCASE IN (SELECT userName FROM mon_player
      WHERE server = ? AND ${c.sql})`;
    where.push(drop ? `NOT (${inSet})` : inSet);
    args.push(server, ...c.args);
  }
  if (sinceMs) { where.push('at >= ?'); args.push(now() - n(sinceMs)); }
  // "no change for at least N minutes": judged on the lord as they stand NOW
  // (mon_player.prestigeAt, their last prestige move), not on when the row was
  // said, so a lord who has since moved again drops out. Holiday lords are left
  // out as in stalled() — they cannot move, so their stillness says nothing.
  if (n(stillMin) > 0) {
    where.push(`userName COLLATE NOCASE IN (SELECT userName FROM mon_player
      WHERE server = ? AND (state IS NULL OR state <> ${HOLIDAY})
        AND prestigeAt IS NOT NULL AND prestigeAt <= ?)`);
    args.push(server, now() - n(stillMin) * 60000);
  }
  // the search box: the lord, or what was said about them
  if (q) {
    const like = `%${String(q).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    where.push("(userName LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  return { sql: where.join(' AND '), args };
}

function events(server, opts = {}) {
  const { sql, args } = eventWhere(server, opts);
  return D.all(`SELECT * FROM mon_event WHERE ${sql} ORDER BY at DESC, id DESC LIMIT ?`,
    ...args, Math.max(1, Math.min(2000, n(opts.limit) || 200)));
}

// Every row carries its lord's best hero, so the table's Best hero column needs
// nothing else. Sorting BY that hero is the one sort sqlite cannot do for us --
// the hero is not in mon_event -- so it is done over the whole matching set
// rather than over one page, which would order a page by a key the paging did
// not use and quietly lie about what comes next.
const EVENT_SORTS = new Set(['at', 'userName', 'kind', 'detail']);
const EVENT_SORT_CAP = 5000;              // how many rows a hero sort will order at once

// One line per lord (the user, 2026-09-28: "the same player is being displayed
// multiple times ... 1 line per player"): a lord who stalls every day left a row
// per day, and the table filled with the same name. Of the rows that match, only
// each lord's newest is shown, and `times` says how many matched in all.
function eventPage(server, { sort = 'at', dir = 'desc', limit = 200, offset = 0, ...rest } = {}) {
  const w = eventWhere(server, rest);
  const from = `mon_event JOIN (SELECT id lid, count(*) OVER (PARTITION BY lower(userName)) times,
      row_number() OVER (PARTITION BY lower(userName) ORDER BY at DESC, id DESC) rn
    FROM mon_event WHERE ${w.sql}) latest ON latest.lid = mon_event.id`;
  const sql = 'latest.rn = 1', args = w.args;
  const total = n((D.one(`SELECT count(*) c FROM ${from} WHERE ${sql}`, ...args) || {}).c);
  const take = Math.max(1, Math.min(2000, n(limit) || 200));
  const skip = Math.max(0, n(offset));
  const d = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const withHeroes = (rows) => {
    const best = bestHeroes(server, rows.map((e) => e.userName));
    // and when the lord last moved prestige, so the table can say how long they
    // have been still as of now rather than as of the row
    const names = [...new Set(rows.map((e) => str(e.userName).toLowerCase()))];
    const movedAt = new Map(names.length ? D.all(`SELECT lower(userName) k, prestigeAt, state FROM mon_player
      WHERE server = ? AND lower(userName) IN (${names.map(() => '?').join(',')})`, server, ...names)
      .map((p) => [p.k, n(p.state) === HOLIDAY ? null : p.prestigeAt]) : []);
    return rows.map((e) => { const k = str(e.userName).toLowerCase();
      return { ...e, hero: best.get(k) || null, movedAt: movedAt.get(k) ?? null }; });
  };

  if (sort === 'hero') {
    const all = withHeroes(D.all(`SELECT mon_event.*, latest.times FROM ${from} WHERE ${sql}
      ORDER BY at DESC, id DESC LIMIT ?`,
      ...args, EVENT_SORT_CAP));
    // a lord with no ranked hero sorts last whichever way round it is asked for,
    // rather than crowding the top of "best first"
    const lvl = (e) => (e.hero ? n(e.hero.level) : null);
    all.sort((a, b) => {
      const x = lvl(a), y = lvl(b);
      if (x === null && y === null) return n(b.at) - n(a.at);
      if (x === null) return 1;
      if (y === null) return -1;
      return (d === 'ASC' ? x - y : y - x) || n(b.at) - n(a.at);
    });
    return { total, offset: skip, rows: all.slice(skip, skip + take), capped: total > EVENT_SORT_CAP };
  }

  const by = EVENT_SORTS.has(sort) ? sort : 'at';
  const text = by === 'userName' || by === 'kind' || by === 'detail';
  const rows = D.all(`SELECT mon_event.*, latest.times FROM ${from} WHERE ${sql}
    ORDER BY ${by}${text ? ' COLLATE NOCASE' : ''} ${d}, id DESC LIMIT ? OFFSET ?`, ...args, take, skip);
  return { total, offset: skip, rows: withHeroes(rows), capped: false };
}

const history = (server, userName, limit = 500) =>
  D.all('SELECT * FROM mon_player_history WHERE server = ? AND userName = ? ORDER BY at DESC LIMIT ?',
    server, userName, Math.max(1, Math.min(5000, n(limit) || 500)));

const sweeps = (server, limit = 40) =>
  D.all('SELECT * FROM mon_sweep WHERE server = ? ORDER BY startedAt DESC LIMIT ?',
    server, Math.max(1, Math.min(500, n(limit) || 40)));

// What the Monitor tab shows at the top: the last sweep of each kind, what is
// running now, and how big the picture is.
function status(server, org) {
  const last = {};
  for (const kind of ['map', 'stats', 'watch']) {
    last[kind] = D.one(`SELECT * FROM mon_sweep WHERE server = ? AND kind = ? AND endedAt IS NOT NULL
      ORDER BY startedAt DESC LIMIT 1`, server, kind) || null;
  }
  const running = D.one(`SELECT * FROM mon_sweep WHERE server = ? AND endedAt IS NULL
    ORDER BY startedAt DESC LIMIT 1`, server) || null;
  const counts = {
    cities: n((D.one('SELECT count(*) c FROM mon_city WHERE server = ?', server) || {}).c),
    players: n((D.one('SELECT count(*) c FROM mon_player WHERE server = ?', server) || {}).c),
    watched: n((D.one('SELECT count(*) c FROM mon_player WHERE server = ? AND watch = 1', server) || {}).c),
    holiday: n((D.one(`SELECT count(*) c FROM mon_player WHERE server = ? AND state = ${HOLIDAY}`, server) || {}).c),
    events: n((D.one('SELECT count(*) c FROM mon_event WHERE server = ?', server) || {}).c),
  };
  return {
    server, last, running, counts, blocks: BLOCKS,
    config: org ? config(org) : DEFAULTS,
    live: org ? readStatus(org) : {},
    stats: ST.status(server),
    states: Object.entries(STATE).map(([k, v]) => ({ state: Number(k), name: v })),
  };
}

// ------------------------------------------------------------------ the loop

// One process, one organization. It wakes every few seconds, sees what is due and
// runs it — never two passes at once, because they share one console's socket.
async function run({ orgId, log = console.log } = {}) {
  const org = D.org(orgId);
  const me = { stop: false };
  const bye = () => { me.stop = true; };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
  const due = { map: 0, stats: 0, watch: 0 };
  writeStatus(org, { pid: process.pid, startedAt: now(), state: 'starting', error: null, progress: null });
  log(`monitor: watching ${BLOCKS} map blocks, pid ${process.pid}`);

  while (!me.stop) {
    const cfg = config(org);
    const acc = cfg.account ? org.accounts.get(cfg.account) : null;
    if (!cfg.on || !acc) {
      writeStatus(org, { state: cfg.on ? 'no account chosen' : 'off', error: null });
      await sleep(5000);
      continue;
    }
    const server = acc.server || 'ss71';
    const t = now();
    const pick = ['map', 'stats', 'watch'].filter((k) => t >= due[k]).sort((a, b) => due[a] - due[b])[0];
    if (!pick) {
      const next = Math.min(...Object.values(due));
      writeStatus(org, { state: 'waiting', account: cfg.account, nextAt: next, error: null });
      await sleep(Math.min(5000, Math.max(500, next - t)));
      continue;
    }
    // A pass must not start on a console that is down; wait for it rather than
    // burning the period on failures.
    const con = await reachConsole(org, cfg.account);
    if (con.error) {
      writeStatus(org, { state: 'waiting for the console', account: cfg.account, error: con.error });
      await sleep(30000);
      continue;
    }
    const every = { map: cfg.mapMin, stats: cfg.statsMin, watch: cfg.watchMin }[pick];
    due[pick] = t + every * 60000;
    writeStatus(org, { state: `${pick} sweep`, account: cfg.account, error: null, since: t });
    try {
      const args = { org, server, accountId: cfg.account, cfg, log, stop: () => me.stop };
      const r = pick === 'map'
        ? await mapSweep({ ...args, onProgress: (p) => writeStatus(org, { state: 'map sweep', progress: p }) })
        : pick === 'stats' ? await statsPass(args) : await watchPass(args);
      if (r && r.error) { log(`monitor: ${pick} — ${r.error}`); writeStatus(org, { error: r.error }); }
    } catch (e) {
      log(`monitor: ${pick} failed — ${e.message}`);
      writeStatus(org, { error: e.message });
    }
    writeStatus(org, { state: 'waiting', progress: null });
  }
  writeStatus(org, { state: 'stopped', pid: null, progress: null });
  log('monitor: stopped');
}

module.exports = {
  STATE, stateName, HOLIDAY, BLOCKS, BLOCK, WORLD, DEFAULTS, KEY, STATUS_KEY,
  config, setConfig, readStatus, writeStatus, consoleUrl, reachConsole, worldBlocks,
  mapSweep, applySweep, statsPass, watchPass, watchList, setWatched, recordWatched,
  stalled, searchStats, searchCities, searchPlayers, alliances, events, eventPage, bestHeroes, lordSheet, pruneReadings, history, sweeps, status, run,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const orgId = flag('--org') || (D.orgs.all().filter((o) => !o.disabled)[0] || {}).id;
  if (!orgId) { console.error('no organization to monitor'); process.exit(1); }
  const org = D.org(orgId);
  const acc = () => org.accounts.get(config(org).account);

  if (argv.includes('--status')) {
    const a = acc();
    console.log(JSON.stringify(status((a && a.server) || 'ss71', org), null, 2));
    process.exit(0);
  }
  const once = flag('--once');
  if (once) {
    const cfg = config(org);
    const a = acc();
    if (!a) { console.error('no account chosen — pick one in the Director (Monitor -> Setup)'); process.exit(1); }
    const args = { org, server: a.server || 'ss71', accountId: cfg.account, cfg, log: console.log };
    const job = once === 'map'
      ? mapSweep({ ...args, onProgress: (p) => process.stdout.write(`\r  ${p.blocks}/${p.of} blocks, ${p.castles} cities   `) })
      : once === 'stats' ? statsPass(args) : once === 'watch' ? watchPass(args) : null;
    if (!job) { console.error('--once takes map, stats or watch'); process.exit(1); }
    job.then((r) => { console.log('\n' + JSON.stringify(r, null, 2)); process.exit(r && r.error ? 1 : 0); })
      .catch((e) => { console.error(e.message); process.exit(1); });
  } else {
    run({ orgId }).catch((e) => { console.error(e); process.exit(1); });
  }
}
