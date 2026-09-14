'use strict';
// One SQLite file behind the whole tool: accounts, goals, engine state, the map
// cache, snapshot history and bot uptime.
//
// Why SQLite and not the JSON files it replaces:
//   * the JSON snapshots were last-value-only, so the fleet had no history
//   * mapcache.json was a 150 KB whole-file rewrite with two writers and no
//     atomicity — a crash mid-write truncated it
//   * goals lived in both goalstore.json and the browser's localStorage
//
// Node 24 ships `node:sqlite`, so this stays dependency-free. WAL mode plus a
// busy timeout is what lets the console, the Director and the daemon all hold
// the file open at once.
const path = require('path');
const fs = require('fs');

// node:sqlite prints an ExperimentalWarning on require. It is noise in a tool
// that logs to the same console as the bot, so it is muted just for this line.
const _emit = process.emitWarning;
process.emitWarning = (w, ...rest) => {
  if (String(w).includes('SQLite is an experimental feature')) return;
  return _emit.call(process, w, ...rest);
};
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = _emit;

const FILE = process.env.EVONY_DB || path.join(__dirname, 'evony.db');

const db = new DatabaseSync(FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
`);

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id        TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  server    TEXT NOT NULL DEFAULT 'ss71',
  email     TEXT,
  password  TEXT,
  enabled   INTEGER NOT NULL DEFAULT 1,
  notes     TEXT,
  proxy     TEXT,
  pos       INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER,
  lastPolled INTEGER
);

-- Numbers only, one row per poll. This is the history the JSON never kept.
CREATE TABLE IF NOT EXISTS snapshots (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  accountId TEXT NOT NULL,
  at        INTEGER NOT NULL,
  ok        INTEGER NOT NULL,
  error     TEXT,
  tookMs    INTEGER,
  prestige  REAL, honor REAL, rank INTEGER, title INTEGER,
  cities    INTEGER, coins INTEGER, troops INTEGER, heroes INTEGER,
  walls     INTEGER, incoming INTEGER, marching INTEGER,
  food      REAL, wood REAL, stone REAL, iron REAL, gold REAL,
  population REAL, maxPopulation REAL,
  lastLoginTime INTEGER
);
CREATE INDEX IF NOT EXISTS snapshots_acct_at ON snapshots(accountId, at DESC);

-- The bulky part of a snapshot (items, city list) for the CURRENT poll only, so
-- history stays cheap while the fleet table stays rich.
CREATE TABLE IF NOT EXISTS account_latest (
  accountId TEXT PRIMARY KEY,
  at        INTEGER NOT NULL,
  json      TEXT NOT NULL
);

-- Goals and scripts. Keyed per account so one account's "default" can no longer
-- leak onto another's cities, which is what the flat goalstore.json did.
CREATE TABLE IF NOT EXISTS goals (
  accountId TEXT NOT NULL DEFAULT '',
  cityKey   TEXT NOT NULL,
  kind      TEXT NOT NULL DEFAULT 'goal',
  src       TEXT NOT NULL,
  savedAt   INTEGER,
  PRIMARY KEY (accountId, cityKey, kind)
);

-- Per-city engine bookkeeping. Keyed by (accountId, city) because city NAMES
-- are not unique across accounts — "5", "7", "9" are ordinary names, so a bare
-- city key silently merged two accounts' npc cycle clocks, camp cooldowns and
-- troop stages into one row.
CREATE TABLE IF NOT EXISTS engine_state (
  accountId TEXT NOT NULL DEFAULT '',
  key       TEXT NOT NULL,
  json      TEXT NOT NULL,
  at        INTEGER,
  PRIMARY KEY (accountId, key)
);

CREATE TABLE IF NOT EXISTS map_cache (
  id           INTEGER PRIMARY KEY,
  x INTEGER, y INTEGER,
  name TEXT, userName TEXT, allianceName TEXT,
  prestige REAL, honor REAL,
  npc INTEGER, mine INTEGER, kind TEXT, state INTEGER,
  level INTEGER, type INTEGER, typeName TEXT,
  seen INTEGER,
  json TEXT
);
CREATE INDEX IF NOT EXISTS map_user ON map_cache(userName);
CREATE INDEX IF NOT EXISTS map_kind ON map_cache(kind, level);

CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);

-- One row per probe per minute. A GAP in this table is the signal that the bot
-- process itself was not running.
CREATE TABLE IF NOT EXISTS uptime (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  probe     TEXT NOT NULL,
  accountId TEXT,
  label     TEXT,
  reachable INTEGER NOT NULL,
  up        INTEGER NOT NULL,
  rssMb     REAL,
  heapMb    REAL,
  state     TEXT,
  reason    TEXT,
  engineMode TEXT,
  idleMs    INTEGER,
  latencyMs INTEGER,
  logLines  INTEGER,
  activity  INTEGER,
  maintenance INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS uptime_at ON uptime(at);
CREATE INDEX IF NOT EXISTS uptime_probe_at ON uptime(probe, at);

-- Level history per tile. Unowned flats and valleys gain +1 level at each daily
-- maintenance, and the level of a flat decides the level of the NPC that ends up
-- on it — so the level has to be TRACKED over time, not just read once. One row
-- per observed change, not per scan.
CREATE TABLE IF NOT EXISTS tile_levels (
  fieldId INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  level   INTEGER,
  kind    TEXT,
  PRIMARY KEY (fieldId, at)
);
CREATE INDEX IF NOT EXISTS tile_levels_field ON tile_levels(fieldId, at DESC);

-- Every city this tool has ever seen, and where it came from.
--
-- This table exists for one reason: city.giveupCastle is irreversible and takes
-- the account password. Abandoning is therefore DEFAULT-DENY — a city is only
-- ever abandonable if this registry says WE built it on a flat via buildnpc,
-- and the intent row is written BEFORE the city is created. Anything that turns
-- up unrecorded (a capture, a purchase, a city built by hand) is recorded as
-- protected and can never be abandoned by the bot.
--
-- Keyed on fieldId, not castleId: the world position is the stable identity.
CREATE TABLE IF NOT EXISTS city_registry (
  accountId   TEXT    NOT NULL,
  fieldId     INTEGER NOT NULL,
  castleId    INTEGER,
  name        TEXT,
  x INTEGER, y INTEGER,
  origin      TEXT    NOT NULL,   -- pre-existing | buildnpc | appeared
  state       TEXT    NOT NULL,   -- protected | pending-build | built | abandoned | gone
  abandonable INTEGER NOT NULL DEFAULT 0,
  firstSeen   INTEGER,
  builtAt     INTEGER,
  abandonedAt INTEGER,
  movedAt     INTEGER,
  moves       INTEGER NOT NULL DEFAULT 0,
  notes       TEXT,
  PRIMARY KEY (accountId, fieldId)
);
CREATE INDEX IF NOT EXISTS registry_castle ON city_registry(accountId, castleId);

-- Prestige watchlist from the original offline-detection script.
CREATE TABLE IF NOT EXISTS player_snapshots (
  userName TEXT NOT NULL,
  at       INTEGER NOT NULL,
  prestige REAL,
  PRIMARY KEY (userName, at)
);
`);

// Columns added after the first release. ALTER TABLE ADD COLUMN is a no-op cost
// on an existing file and lets an older evony.db catch up without a migration.
for (const [table, col, decl] of [
  ['uptime', 'maintenance', 'INTEGER DEFAULT 0'],
  ['city_registry', 'movedAt', 'INTEGER'],
  ['city_registry', 'moves', 'INTEGER NOT NULL DEFAULT 0'],
  ['uptime', 'rssMb', 'REAL'],
  ['uptime', 'heapMb', 'REAL'],
]) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}

const TEN = require('./tenancy');

const n = (x) => (x === null || x === undefined || x === '' ? null : Number(x));
const b = (x) => (x ? 1 : 0);
const now = () => Date.now();

// node:sqlite rejects undefined and booleans, so every binding goes through here.
const bind = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
};
const run = (sql, ...args) => db.prepare(sql).run(...args.map(bind));
const all = (sql, ...args) => db.prepare(sql).all(...args.map(bind));
const one = (sql, ...args) => db.prepare(sql).get(...args.map(bind));

// ----------------------------------------------------------------- accounts

const accounts = {
  all() {
    return all('SELECT * FROM accounts ORDER BY pos, rowid').map((a) => ({
      ...a, enabled: !!a.enabled,
    }));
  },

  get(id) {
    const a = one('SELECT * FROM accounts WHERE id = ?', id);
    return a ? { ...a, enabled: !!a.enabled } : null;
  },

  byEmail(email) {
    const a = one('SELECT * FROM accounts WHERE lower(email) = lower(?)', String(email || ''));
    return a ? { ...a, enabled: !!a.enabled } : null;
  },

  // Accounts joined to their most recent snapshot, in the shape the Director UI
  // already expects ({...account, snapshot}).
  withSnapshots() {
    return accounts.all().map((a) => ({ ...a, snapshot: snapshots.latest(a.id) }));
  },

  nextId() {
    const ids = accounts.all().map((a) => a.id);
    for (let i = 1; ; i++) if (!ids.includes('a' + i)) return 'a' + i;
  },

  upsert(acc) {
    const id = acc.id || accounts.nextId();
    const prev = accounts.get(id) || {};
    const pos = acc.pos !== undefined ? acc.pos
      : (prev.pos !== undefined ? prev.pos : (n(one('SELECT max(pos) m FROM accounts').m) || 0) + 1);
    run(`INSERT INTO accounts (id,label,server,email,password,enabled,notes,proxy,pos,createdAt,lastPolled)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           label=excluded.label, server=excluded.server, email=excluded.email,
           password=excluded.password, enabled=excluded.enabled, notes=excluded.notes,
           proxy=excluded.proxy, pos=excluded.pos`,
      id,
      acc.label !== undefined ? acc.label : (prev.label || id),
      acc.server !== undefined ? acc.server : (prev.server || 'ss71'),
      acc.email !== undefined ? acc.email : prev.email,
      acc.password !== undefined ? acc.password : prev.password,
      b(acc.enabled !== undefined ? acc.enabled : (prev.enabled !== undefined ? prev.enabled : true)),
      acc.notes !== undefined ? acc.notes : prev.notes,
      acc.proxy !== undefined ? acc.proxy : prev.proxy,
      pos,
      prev.createdAt || acc.createdAt || now(),
      prev.lastPolled || null);
    return accounts.get(id);
  },

  remove(id) {
    run('DELETE FROM accounts WHERE id = ?', id);
    run('DELETE FROM snapshots WHERE accountId = ?', id);
    run('DELETE FROM account_latest WHERE accountId = ?', id);
    run('DELETE FROM goals WHERE accountId = ?', id);
  },

  touch(id, at) { run('UPDATE accounts SET lastPolled = ? WHERE id = ?', at || now(), id); },
};

// ---------------------------------------------------------------- snapshots

const snapshots = {
  // `snap` is the object the Director's poller already builds.
  add(accountId, snap) {
    const t = snap.totals || {};
    run(`INSERT INTO snapshots
         (accountId,at,ok,error,tookMs,prestige,honor,rank,title,cities,coins,troops,heroes,
          walls,incoming,marching,food,wood,stone,iron,gold,population,maxPopulation,lastLoginTime)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      accountId, snap.at || now(), b(snap.ok), snap.error || null, n(snap.tookMs),
      n(snap.prestige), n(snap.honor), n(snap.rank), n(snap.title), n(snap.cities), n(snap.coins),
      n(snap.troops), n(snap.heroes), n(snap.walls), n(snap.incoming), n(snap.marching),
      n(t.food), n(t.wood), n(t.stone), n(t.iron), n(t.gold), n(t.population), n(t.maxPopulation),
      n(snap.lastLoginTime));
    run(`INSERT INTO account_latest (accountId,at,json) VALUES (?,?,?)
         ON CONFLICT(accountId) DO UPDATE SET at=excluded.at, json=excluded.json`,
      accountId, snap.at || now(), JSON.stringify(snap));
    accounts.touch(accountId, snap.at || now());
  },

  latest(accountId) {
    const row = one('SELECT json FROM account_latest WHERE accountId = ?', accountId);
    if (!row) return null;
    try { return JSON.parse(row.json); } catch { return null; }
  },

  // Numeric series for charts. `field` is validated against the column list.
  series(accountId, sinceMs, field) {
    const cols = new Set(['prestige', 'honor', 'coins', 'troops', 'heroes', 'cities',
      'food', 'wood', 'stone', 'iron', 'gold', 'population', 'walls']);
    const f = cols.has(field) ? field : 'prestige';
    return all(`SELECT at, ${f} AS v FROM snapshots
                WHERE accountId = ? AND at >= ? AND ok = 1 ORDER BY at`,
      accountId, sinceMs || 0);
  },

  prune(keepDays = 90) {
    run('DELETE FROM snapshots WHERE at < ?', now() - keepDays * 86400000);
  },
};

// -------------------------------------------------------------------- goals

// Keys in the goals table that belong to the ACCOUNT, not to a city: the
// new-city template ('default'), the global goals run before and after every
// city's own ('prepend', 'append'), the new-city script ('newcity') and the
// goal sets a script loads ('set1' to 'set9'). See goallayers.js. A city's own
// key is its castle id, so these never collide with one; they are kept out of
// the by-NAME lookup, so a city that happens to be called "prepend" is not
// seeded from the prepend goals.
const NOT_A_CITY = new Set(['default', 'prepend', 'append', 'newcity',
  ...Array.from({ length: 9 }, (_, i) => `set${i + 1}`)]);

const goals = {
  // Try each key in turn for this account, then the account's own default, then
  // the shared default. Returns {src, cityKey, accountId} or null.
  find(accountId, keys, kind = 'goal') {
    const tries = [];
    for (const k of keys) if (k !== null && k !== undefined && k !== '') tries.push([accountId || '', String(k)]);
    if (accountId) tries.push([accountId, 'default']);
    for (const k of keys) if (k !== null && k !== undefined && k !== '') tries.push(['', String(k)]);
    tries.push(['', 'default']);
    for (const [a, k] of tries) {
      const row = one('SELECT * FROM goals WHERE accountId = ? AND cityKey = ? AND kind = ?', a, k, kind);
      if (row && row.src) return row;
    }
    return null;
  },

  // One city's own row and nothing else: what its window shows and what the
  // engine runs there, so saving one city never changes another. A city with no
  // row yet gets a copy of what find() would have fallen through to (a row under
  // its name, then the account's default, then the shared rows), once. That way
  // it keeps running what it ran before, and from then on the row is its own. A
  // row saved empty stays empty and never falls back to the default again.
  own(accountId, cityId, cityName, kind = 'goal') {
    return goals.seed(accountId, cityId, cityName, kind).row;
  },

  // own(), saying what happened: { row, seeded, from, had }. `had` is true when
  // the city already had a row of its own (an empty one included), `seeded`
  // when this call copied one in, and `from` names the row it was copied from
  // ({accountId, cityKey}; cityKey 'default' is the new-city template). The
  // session calls this the moment a city appears (server.CastleUpdate), so the
  // copy is made then and logged, rather than on the engine's first read.
  seed(accountId, cityId, cityName, kind = 'goal') {
    const none = { row: null, seeded: false, from: null, had: false };
    if (cityId === null || cityId === undefined || cityId === '') return none;
    const key = String(cityId);
    const get = () => one('SELECT * FROM goals WHERE accountId = ? AND cityKey = ? AND kind = ?', accountId || '', key, kind);
    let row = get();
    if (row) return { row: row.src ? row : null, seeded: false, from: null, had: true };
    const name = NOT_A_CITY.has(String(cityName || '').trim().toLowerCase()) ? null : cityName;
    let seed = goals.find(accountId, [key, name], kind);
    // An account that saved its template EMPTY has said "no template": the
    // install-wide rows find() falls through to must not seed its cities instead.
    if (seed && accountId && seed.accountId === '') {
      const tpl = goals.exact(accountId, 'default', kind);
      if (tpl && !tpl.src) seed = null;
    }
    if (!seed) return none;
    goals.set(accountId, key, kind, seed.src);
    row = get();
    return { row: row && row.src ? row : null, seeded: true, from: { accountId: seed.accountId, cityKey: seed.cityKey }, had: false };
  },

  // One exact row, no fallback: an account's template, prepend or append text.
  exact(accountId, cityKey, kind = 'goal') {
    return one('SELECT * FROM goals WHERE accountId = ? AND cityKey = ? AND kind = ?',
      accountId || '', String(cityKey), kind) || null;
  },

  // What the engine evaluates in one city (NEAT's GlobalGoals): the account's
  // prepend goals, the city's own (seeded as own() does), the append goals.
  // Each is the text or null; goallayers.parseLayered puts them together.
  layers(accountId, cityId, cityName) {
    const text = (r) => (r && r.src ? r.src : null);
    return {
      prepend: text(goals.exact(accountId, 'prepend', 'goal')),
      city: text(goals.own(accountId, cityId, cityName, 'goal')),
      append: text(goals.exact(accountId, 'append', 'goal')),
    };
  },

  // One city's script loadouts as [{slot, src, savedAt}], the empty ones left
  // out. They are rows of kind 'script' keyed <cityId>:load<N>. A city with no
  // such rows at all has never been opened, so it takes a copy of the
  // account-wide slots (load<N>) the console once shared between all cities.
  // An emptied slot is saved as an empty row, which is why that copy is made
  // only once.
  loadouts(accountId, cityId) {
    const acct = accountId || '', city = String(cityId);
    const slotOf = new RegExp(`^${city.replace(/\W/g, '\\$&')}:load(\\d+)$`);
    const scripts = () => all("SELECT * FROM goals WHERE accountId = ? AND kind = 'script' ORDER BY cityKey", acct);
    let rows = scripts().filter((r) => slotOf.test(r.cityKey));
    if (!rows.length) {
      for (const r of scripts()) {
        if (/^load\d+$/.test(r.cityKey) && r.src) goals.set(acct, `${city}:${r.cityKey}`, 'script', r.src);
      }
      rows = scripts().filter((r) => slotOf.test(r.cityKey));
    }
    return rows.filter((r) => r.src)
      .map((r) => ({ slot: Number(slotOf.exec(r.cityKey)[1]), src: r.src, savedAt: r.savedAt }))
      .sort((a, b) => a.slot - b.slot);
  },

  set(accountId, cityKey, kind, src) {
    run(`INSERT INTO goals (accountId,cityKey,kind,src,savedAt) VALUES (?,?,?,?,?)
         ON CONFLICT(accountId,cityKey,kind) DO UPDATE SET src=excluded.src, savedAt=excluded.savedAt`,
      accountId || '', String(cityKey || 'default'), kind || 'goal', String(src || ''), now());
  },

  list(kind) {
    return kind ? all('SELECT * FROM goals WHERE kind = ? ORDER BY accountId, cityKey', kind)
      : all('SELECT * FROM goals ORDER BY accountId, cityKey, kind');
  },

  remove(accountId, cityKey, kind = 'goal') {
    run('DELETE FROM goals WHERE accountId = ? AND cityKey = ? AND kind = ?', accountId || '', String(cityKey), kind);
  },
};

// ------------------------------------------------------------- engine state

// engine.js keeps one plain object keyed by city; this preserves that shape.
const engineState = {
  load(accountId = '') {
    const out = {};
    for (const r of all('SELECT key, json FROM engine_state WHERE accountId = ?', accountId || '')) {
      try { out[r.key] = JSON.parse(r.json); } catch {}
    }
    return out;
  },
  save(obj, accountId = '') {
    const t = now();
    for (const [k, v] of Object.entries(obj || {})) {
      run(`INSERT INTO engine_state (accountId,key,json,at) VALUES (?,?,?,?)
           ON CONFLICT(accountId,key) DO UPDATE SET json=excluded.json, at=excluded.at`,
        accountId || '', k, JSON.stringify(v), t);
    }
  },
  // save() only ever upserts, so a key the engine has moved (a city's state
  // re-keyed from its name to its castle id) has to be dropped here, or the
  // next load brings it back.
  remove(keys, accountId = '') {
    for (const k of keys || []) run('DELETE FROM engine_state WHERE accountId = ? AND key = ?', accountId || '', String(k));
  },
};

// ---------------------------------------------------------------- map cache

let mapVersion = 0;

const mapCache = {
  version() { return mapVersion; },

  upsertMany(tiles) {
    const stmt = db.prepare(`INSERT INTO map_cache
      (id,x,y,name,userName,allianceName,prestige,honor,npc,mine,kind,state,level,type,typeName,seen,json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        x=excluded.x, y=excluded.y, name=excluded.name, userName=excluded.userName,
        allianceName=excluded.allianceName, prestige=excluded.prestige, honor=excluded.honor,
        npc=excluded.npc, mine=excluded.mine, kind=excluded.kind, state=excluded.state,
        level=excluded.level, type=excluded.type, typeName=excluded.typeName,
        seen=excluded.seen, json=excluded.json`);
    const levelStmt = db.prepare(
      `INSERT INTO tile_levels (fieldId,at,level,kind) VALUES (?,?,?,?)
       ON CONFLICT(fieldId,at) DO UPDATE SET level=excluded.level`);
    const prevLevel = new Map(
      all('SELECT id, level FROM map_cache WHERE level IS NOT NULL').map((r) => [Number(r.id), Number(r.level)]));
    db.exec('BEGIN');
    try {
      for (const t of tiles) {
        if (t == null || t.id === undefined || t.id === null) continue;
        // Note a level CHANGE before overwriting the row, so the daily +1 on
        // unowned tiles becomes observable instead of being silently lost.
        const lvl = n(t.level);
        if (lvl !== null) {
          const prev = prevLevel.get(Number(t.id));
          if (prev === undefined || prev !== lvl) {
            levelStmt.run(Number(t.id), Number(t.seen || now()), lvl, bind(t.kind));
          }
        }
        stmt.run(
          Number(t.id), bind(n(t.x)), bind(n(t.y)), bind(t.name), bind(t.userName),
          bind(t.allianceName), bind(n(t.prestige)), bind(n(t.honor)),
          b(t.npc), b(t.mine), bind(t.kind), bind(n(t.state)),
          bind(n(t.level)), bind(n(t.type)), bind(t.typeName),
          Number(t.seen || now()), JSON.stringify(t));
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    mapVersion++;
  },

  // The shape goal-npc.js and the map UI already digest: {updatedAt, castles}.
  asJson() {
    const castles = {};
    for (const r of all('SELECT json FROM map_cache')) {
      try { const t = JSON.parse(r.json); castles[t.id] = t; } catch {}
    }
    const u = one('SELECT max(seen) m FROM map_cache');
    return { updatedAt: (u && u.m) || 0, castles };
  },

  count() { return n(one('SELECT count(*) c FROM map_cache').c) || 0; },

  updatedAt() { const u = one('SELECT max(seen) m FROM map_cache'); return (u && u.m) || 0; },

  // Every recorded level change for one tile, oldest first.
  levelHistory(fieldId, limit = 40) {
    return all('SELECT at, level, kind FROM tile_levels WHERE fieldId = ? ORDER BY at DESC LIMIT ?',
      Number(fieldId), limit).reverse();
  },

  // Tiles whose level moved since `sinceMs` — the evidence for the daily +1.
  recentLevelChanges(sinceMs, limit = 200) {
    return all(`SELECT t.fieldId, t.at, t.level, t.kind, m.x, m.y
                FROM tile_levels t LEFT JOIN map_cache m ON m.id = t.fieldId
                WHERE t.at >= ? ORDER BY t.at DESC LIMIT ?`, sinceMs || 0, limit);
  },

  // Flats, optionally only those at a given level.
  flats({ level = null, limit = 2000 } = {}) {
    const rows = level === null
      ? all(`SELECT json FROM map_cache WHERE (kind='flat' OR type=10)
             AND userName IS NULL AND npc=0 LIMIT ?`, limit)
      : all(`SELECT json FROM map_cache WHERE (kind='flat' OR type=10)
             AND userName IS NULL AND npc=0 AND level=? LIMIT ?`, Number(level), limit);
    return rows.map((r) => { try { return JSON.parse(r.json); } catch { return null; } }).filter(Boolean);
  },

  search(q, limit = 300) {
    const needle = '%' + String(q || '').toLowerCase() + '%';
    const rows = all(`SELECT json FROM map_cache
       WHERE lower(coalesce(userName,'')) LIKE ?
          OR lower(coalesce(allianceName,'')) LIKE ?
          OR lower(coalesce(name,'')) LIKE ?
       LIMIT ?`, needle, needle, needle, limit);
    return rows.map((r) => { try { return JSON.parse(r.json); } catch { return null; } }).filter(Boolean);
  },
};

// ----------------------------------------------------------------- settings

// INSTALL-WIDE settings only — things that belong to the machine, not to a
// customer, such as the internal service token. Anything a tenant owns lives on
// org(id).settings, which is keyed by orgId. Both share the table; this one
// holds the rows whose orgId is ''.
const settings = {
  get(k, d = null) {
    const r = one("SELECT v FROM settings WHERE orgId = '' AND k = ?", k);
    if (!r) return d;
    try { return JSON.parse(r.v); } catch { return r.v; }
  },
  set(k, v) {
    run(`INSERT INTO settings (orgId,k,v) VALUES ('',?,?)
         ON CONFLICT(orgId,k) DO UPDATE SET v = excluded.v`, k, JSON.stringify(v));
  },
};

// ------------------------------------------------------------------- uptime

const uptime = {
  add(row) {
    run(`INSERT INTO uptime (orgId,at,probe,accountId,label,reachable,up,state,reason,engineMode,idleMs,latencyMs,logLines,activity,maintenance,rssMb,heapMb)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.orgId || '', row.at || now(), row.probe, row.accountId || null, row.label || null,
      b(row.reachable), b(row.up), row.state || null, row.reason || null,
      row.engineMode || null, n(row.idleMs), n(row.latencyMs), n(row.logLines), b(row.activity),
      b(row.maintenance), n(row.rssMb), n(row.heapMb));
  },

  series(sinceMs, probe) {
    return probe
      ? all('SELECT * FROM uptime WHERE at >= ? AND probe = ? ORDER BY at', sinceMs || 0, probe)
      : all('SELECT * FROM uptime WHERE at >= ? ORDER BY at', sinceMs || 0);
  },

  probes(sinceMs) {
    return all('SELECT DISTINCT probe FROM uptime WHERE at >= ? ORDER BY probe', sinceMs || 0)
      .map((r) => r.probe);
  },

  latest(probe) { return one('SELECT * FROM uptime WHERE probe = ? ORDER BY at DESC LIMIT 1', probe); },

  prune(keepDays = 30) { run('DELETE FROM uptime WHERE at < ?', now() - keepDays * 86400000); },
};

// ----------------------------------------------------------------- players

// --------------------------------------------------------------- registry
//
// Nothing here ever sets abandonable=1 except claimFlat(), and that is only
// reachable from the buildnpc goal. Reconciling a live city list can only ever
// ADD protected rows or promote a row that was already claimed.
const registry = {
  all(accountId) {
    return all('SELECT * FROM city_registry WHERE accountId = ? ORDER BY fieldId', accountId)
      .map((r) => ({ ...r, abandonable: !!r.abandonable }));
  },

  get(accountId, fieldId) {
    const r = one('SELECT * FROM city_registry WHERE accountId = ? AND fieldId = ?', accountId, Number(fieldId));
    return r ? { ...r, abandonable: !!r.abandonable } : null;
  },

  byCastleId(accountId, castleId) {
    const r = one('SELECT * FROM city_registry WHERE accountId = ? AND castleId = ?', accountId, Number(castleId));
    return r ? { ...r, abandonable: !!r.abandonable } : null;
  },

  // Record the INTENT to build, before anything is sent. If the build never
  // happens this row stays 'pending-build' and can never be abandoned, because
  // the guard also requires a live castle at this exact fieldId.
  claimFlat(accountId, fieldId, xy = {}, notes = '') {
    const existing = registry.get(accountId, fieldId);
    if (existing) {
      // A flat we built on and already handed back may be claimed again.
      // Anything else — a live city, a protected row — is never re-labelled.
      const reclaimable = existing.origin === 'buildnpc'
        && (existing.state === 'pending-build' || existing.state === 'abandoned');
      if (!reclaimable) return existing;
    }
    run(`INSERT INTO city_registry (accountId,fieldId,origin,state,abandonable,castleId,builtAt,abandonedAt,firstSeen,x,y,notes)
         VALUES (?,?,'buildnpc','pending-build',0,NULL,NULL,NULL,?,?,?,?)
         ON CONFLICT(accountId,fieldId) DO UPDATE SET
           state='pending-build', abandonable=0, castleId=NULL, builtAt=NULL,
           abandonedAt=NULL, notes=excluded.notes`,
      accountId, Number(fieldId), now(), n(xy.x), n(xy.y), notes);
    return registry.get(accountId, fieldId);
  },

  // The claimed flat is now a live city of ours. This is the ONLY path to
  // abandonable=1, and it refuses unless the row was already a buildnpc claim.
  markBuilt(accountId, fieldId, castleId, name) {
    const r = registry.get(accountId, fieldId);
    if (!r || r.origin !== 'buildnpc' || r.state !== 'pending-build') return null;
    // A castle id we have seen before is an EXISTING city that arrived on this
    // tile — almost certainly a teleport onto the flat we claimed. Promoting it
    // would mark a real city abandonable, so refuse. castleId is the stable
    // identity across a move (city.advMoveCastle keeps it), fieldId is not.
    const known = registry.byCastleId(accountId, Number(castleId));
    if (known && Number(known.fieldId) !== Number(fieldId)) return null;
    run(`UPDATE city_registry SET state='built', abandonable=1, castleId=?, name=?, builtAt=?
         WHERE accountId=? AND fieldId=?`,
      Number(castleId), name || null, now(), accountId, Number(fieldId));
    return registry.get(accountId, fieldId);
  },

  markAbandoned(accountId, fieldId) {
    run(`UPDATE city_registry SET state='abandoned', abandonable=0, abandonedAt=? WHERE accountId=? AND fieldId=?`,
      now(), accountId, Number(fieldId));
  },

  // We just teleported this city ourselves. Its new tile may not be known yet
  // (a state move lands somewhere random and only a push says where), so stop
  // trusting any claim on it NOW, by castleId; reconcile moves the row and
  // counts the move once the tile is known.
  markMoved(accountId, castleId) {
    run(`UPDATE city_registry SET abandonable=0, movedAt=? WHERE accountId=? AND castleId=?`,
      now(), accountId, Number(castleId));
  },

  // Bring the registry in line with the live city list. Unknown cities are
  // recorded PROTECTED; a pending buildnpc claim at the same fieldId is
  // promoted instead. Cities that vanished are marked gone.
  // Cities can TELEPORT (city.advMoveCastle / WarMoveCastle), which keeps the
  // castleId and changes the fieldId. So identity is resolved by castleId FIRST
  // and only then by tile — otherwise a real city moving onto a flat we had
  // claimed would be promoted to abandonable, which is the worst bug this file
  // could have.
  reconcile(accountId, cities) {
    const seenFields = new Set();
    const added = [];
    const moved = [];
    const firstRun = registry.all(accountId).length === 0;

    for (const c of cities || []) {
      const fieldId = Number(c.fieldId);
      const castleId = Number(c.castleId);
      if (!Number.isFinite(fieldId)) continue;
      seenFields.add(fieldId);

      // 1. known castle? then this row IS this city, wherever it now sits.
      const byCastle = Number.isFinite(castleId) ? registry.byCastleId(accountId, castleId) : null;
      if (byCastle) {
        if (Number(byCastle.fieldId) !== fieldId) {
          // It teleported. Move the row, and STOP TRUSTING any buildnpc claim on
          // it: a throwaway city that has been moved is no longer obviously
          // throwaway, so fail closed rather than keep it abandonable.
          const blocker = registry.get(accountId, fieldId);
          if (blocker && Number(blocker.castleId) !== castleId) {
            // something else is recorded on the destination tile; a stale claim
            // there is void, anything real would be impossible
            run('DELETE FROM city_registry WHERE accountId=? AND fieldId=? AND state=?',
              accountId, fieldId, 'pending-build');
          }
          run(`UPDATE city_registry
                 SET fieldId=?, x=?, y=?, name=?, abandonable=0, movedAt=?, moves=moves+1
               WHERE accountId=? AND fieldId=?`,
            fieldId, n(c.x), n(c.y), c.name || null, now(), accountId, byCastle.fieldId);
          moved.push({ name: c.name, from: Number(byCastle.fieldId), to: fieldId, origin: byCastle.origin });
        } else {
          run(`UPDATE city_registry SET name=?, x=?, y=? WHERE accountId=? AND fieldId=?`,
            c.name || null, n(c.x), n(c.y), accountId, fieldId);
        }
        continue;
      }

      // 2. unknown castle sitting on a flat we claimed -> this is our new city
      const onTile = registry.get(accountId, fieldId);
      if (onTile && onTile.state === 'pending-build' && onTile.origin === 'buildnpc') {
        if (registry.markBuilt(accountId, fieldId, castleId, c.name)) {
          added.push({ fieldId, name: c.name, origin: 'buildnpc', promoted: true });
          continue;
        }
      }

      // 3. anything else is recorded protected
      if (!onTile) {
        run(`INSERT INTO city_registry (accountId,fieldId,castleId,name,x,y,origin,state,abandonable,firstSeen)
             VALUES (?,?,?,?,?,?,?,'protected',0,?)`,
          accountId, fieldId, n(castleId), c.name || null, n(c.x), n(c.y),
          firstRun ? 'pre-existing' : 'appeared', now());
        added.push({ fieldId, name: c.name, origin: firstRun ? 'pre-existing' : 'appeared' });
      } else {
        run(`UPDATE city_registry SET castleId=?, name=?, x=?, y=? WHERE accountId=? AND fieldId=?`,
          n(castleId), c.name || null, n(c.x), n(c.y), accountId, fieldId);
      }
    }

    // rows whose tile no longer holds one of our cities
    const liveCastles = new Set((cities || []).map((c) => Number(c.castleId)).filter(Number.isFinite));
    for (const r of registry.all(accountId)) {
      if (r.state === 'pending-build' || r.state === 'abandoned' || r.state === 'gone') continue;
      if (seenFields.has(Number(r.fieldId))) continue;
      if (r.castleId !== null && liveCastles.has(Number(r.castleId))) continue;   // it moved, already handled
      run(`UPDATE city_registry SET state='gone' WHERE accountId=? AND fieldId=?`, accountId, r.fieldId);
    }

    return { added, moved, total: registry.all(accountId).length };
  },
};

const players = {
  record(userName, prestige, at) {
    run(`INSERT INTO player_snapshots (userName,at,prestige) VALUES (?,?,?)
         ON CONFLICT(userName,at) DO UPDATE SET prestige=excluded.prestige`,
      userName, at || now(), n(prestige));
  },
  latest(userName) {
    return one('SELECT * FROM player_snapshots WHERE userName = ? ORDER BY at DESC LIMIT 1', userName);
  },
};

// With several long-lived connections the automatic checkpoint can be starved
// and the -wal file then grows without bound. PASSIVE never blocks a reader, so
// it is safe to call on a timer from any process.
function checkpoint(mode = 'PASSIVE') {
  try { db.exec(`PRAGMA wal_checkpoint(${mode})`); return true; }
  catch { return false; }
}

// ---------------------------------------------------------------- tenancy
TEN.install(db, { run, all, one });
const T = TEN.build(db, { run, all, one, bind });
T.attach({ snapshots, goals, engineState, registry, uptime, players });

module.exports = {
  db, FILE, run, all, one, checkpoint,
  // Multi-tenant surface. Anything that touches customer data goes through
  // org(id) — see tenancy.js for why the unscoped handles below are not it.
  orgs: T.orgs, users: T.users, sessions: T.sessions, org: T.org,
  accounts, snapshots, goals, engineState, mapCache, settings, uptime, players, registry,
  stats() {
    const t = (name) => n(one(`SELECT count(*) c FROM ${name}`).c) || 0;
    return {
      file: FILE,
      sizeBytes: (() => { try { return fs.statSync(FILE).size; } catch { return 0; } })(),
      walBytes: (() => { try { return fs.statSync(FILE + '-wal').size; } catch { return 0; } })(),
      accounts: t('accounts'), snapshots: t('snapshots'), goals: t('goals'),
      mapCache: t('map_cache'), uptime: t('uptime'),
    };
  },
};
