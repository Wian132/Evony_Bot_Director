'use strict';
// Multi-tenancy for OTTObot.
//
// The whole risk here is one missing `WHERE orgId = ?`. The `accounts` table
// holds other people's game logins in plain text, so a leak is not a bug, it is
// a breach. The defence is structural rather than disciplinary:
//
//   * every tenant table carries an orgId
//   * callers never get an unscoped handle — they must go through org(id),
//     which closes over the orgId and applies it to every read and write
//   * anything reached BY accountId (goals, snapshots, engine state, the city
//     registry) is checked to belong to this org first, because an id guessed
//     or leaked from elsewhere must not resolve
//
// World data — the map cache and tile levels — is deliberately SHARED. It
// describes the game world, not a customer, and every tenant scanning it makes
// it better for the rest. The one piece of tenant data that used to live there,
// the "is this city mine" flag, is computed at read time instead.
const crypto = require('crypto');

const now = () => Date.now();
const newId = (p) => `${p}_${crypto.randomBytes(9).toString('base64url')}`;
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'org';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orgs (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  slug      TEXT NOT NULL UNIQUE,
  plan      TEXT NOT NULL DEFAULT 'free',
  createdAt INTEGER,
  disabled  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  passwordHash TEXT NOT NULL,
  name         TEXT,
  createdAt    INTEGER,
  lastLoginAt  INTEGER,
  disabled     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(lower(email));

CREATE TABLE IF NOT EXISTS memberships (
  userId    TEXT NOT NULL,
  orgId     TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'owner',   -- owner | admin | member
  createdAt INTEGER,
  PRIMARY KEY (userId, orgId)
);
CREATE INDEX IF NOT EXISTS memberships_org ON memberships(orgId);

CREATE TABLE IF NOT EXISTS user_sessions (
  sid       TEXT PRIMARY KEY,
  userId    TEXT NOT NULL,
  orgId     TEXT,
  createdAt INTEGER,
  expiresAt INTEGER,
  ip        TEXT,
  ua        TEXT
);
CREATE INDEX IF NOT EXISTS user_sessions_user ON user_sessions(userId);
`;

// Columns added to existing tenant tables. ALTER ADD COLUMN is cheap and lets an
// older evony.db catch up without a dump/restore.
const TENANT_COLUMNS = [
  ['accounts', 'orgId', "TEXT NOT NULL DEFAULT ''"],
  ['uptime', 'orgId', "TEXT NOT NULL DEFAULT ''"],
  ['player_snapshots', 'orgId', "TEXT NOT NULL DEFAULT ''"],
];

function install(db, helpers) {
  const { run, all, one } = helpers;
  db.exec(SCHEMA);

  for (const [table, col, decl] of TENANT_COLUMNS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  }

  // settings was keyed on k alone; it now needs to be per-org. SQLite cannot
  // change a primary key in place, so rebuild it once.
  const sCols = db.prepare('PRAGMA table_info(settings)').all().map((c) => c.name);
  if (!sCols.includes('orgId')) {
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE settings_v2 (
        orgId TEXT NOT NULL DEFAULT '', k TEXT NOT NULL, v TEXT, PRIMARY KEY (orgId, k))`);
      db.exec(`INSERT INTO settings_v2 (orgId, k, v) SELECT '', k, v FROM settings`);
      db.exec('DROP TABLE settings');
      db.exec('ALTER TABLE settings_v2 RENAME TO settings');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  // "mine" is a per-account fact and has no business in a table every tenant
  // shares. It is computed at read time now; blank the stored column.
  const mCols = db.prepare('PRAGMA table_info(map_cache)').all().map((c) => c.name);
  if (mCols.includes('mine')) db.exec('UPDATE map_cache SET mine = 0 WHERE mine <> 0');
}

function build(db, helpers) {
  const { run, all, one, bind } = helpers;

  // -------------------------------------------------------------- orgs
  const orgs = {
    all() { return all('SELECT * FROM orgs ORDER BY createdAt'); },
    get(id) { return one('SELECT * FROM orgs WHERE id = ?', id) || null; },
    bySlug(slug) { return one('SELECT * FROM orgs WHERE slug = ?', slug) || null; },

    create(name, plan = 'free') {
      let slug = slugify(name);
      if (orgs.bySlug(slug)) slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
      const id = newId('org');
      run('INSERT INTO orgs (id,name,slug,plan,createdAt) VALUES (?,?,?,?,?)',
        id, String(name).slice(0, 80), slug, plan, now());
      return orgs.get(id);
    },

    rename(id, name) { run('UPDATE orgs SET name = ? WHERE id = ?', String(name).slice(0, 80), id); },

    members(orgId) {
      return all(`SELECT u.id, u.email, u.name, m.role, m.createdAt
                  FROM memberships m JOIN users u ON u.id = m.userId
                  WHERE m.orgId = ? ORDER BY m.createdAt`, orgId);
    },
  };

  // ------------------------------------------------------------- users
  const users = {
    get(id) { return one('SELECT * FROM users WHERE id = ?', id) || null; },
    byEmail(email) { return one('SELECT * FROM users WHERE lower(email) = lower(?)', String(email || '')) || null; },
    count() { return Number(one('SELECT count(*) c FROM users').c) || 0; },

    create({ email, passwordHash, name }) {
      const id = newId('usr');
      run('INSERT INTO users (id,email,passwordHash,name,createdAt) VALUES (?,?,?,?,?)',
        id, String(email).trim(), passwordHash, name || null, now());
      return users.get(id);
    },

    setPassword(id, passwordHash) { run('UPDATE users SET passwordHash = ? WHERE id = ?', passwordHash, id); },
    noteLogin(id) { run('UPDATE users SET lastLoginAt = ? WHERE id = ?', now(), id); },

    orgsOf(userId) {
      return all(`SELECT o.*, m.role FROM memberships m JOIN orgs o ON o.id = m.orgId
                  WHERE m.userId = ? ORDER BY m.createdAt`, userId);
    },

    join(userId, orgId, role = 'member') {
      run(`INSERT INTO memberships (userId,orgId,role,createdAt) VALUES (?,?,?,?)
           ON CONFLICT(userId,orgId) DO UPDATE SET role = excluded.role`, userId, orgId, role, now());
    },

    roleIn(userId, orgId) {
      const m = one('SELECT role FROM memberships WHERE userId = ? AND orgId = ?', userId, orgId);
      return m ? m.role : null;
    },
  };

  // ---------------------------------------------------------- sessions
  const sessions = {
    create(userId, orgId, ip, ua, hours = 12) {
      const sid = crypto.randomBytes(32).toString('hex');
      run('INSERT INTO user_sessions (sid,userId,orgId,createdAt,expiresAt,ip,ua) VALUES (?,?,?,?,?,?,?)',
        sid, userId, orgId || null, now(), now() + hours * 3600000, ip || null, String(ua || '').slice(0, 160));
      run('DELETE FROM user_sessions WHERE expiresAt < ?', now());
      return sid;
    },

    // Returns {user, org, role} or null. A session pointing at an org the user
    // has since been removed from resolves to no org, not to the org anyway.
    resolve(sid) {
      if (!sid) return null;
      const s = one('SELECT * FROM user_sessions WHERE sid = ?', String(sid));
      if (!s || s.expiresAt < now()) return null;
      const user = users.get(s.userId);
      if (!user || user.disabled) return null;
      let org = null, role = null;
      if (s.orgId) {
        role = users.roleIn(user.id, s.orgId);
        if (role) org = orgs.get(s.orgId);
      }
      return { sid, user, org, role };
    },

    switchOrg(sid, orgId) { run('UPDATE user_sessions SET orgId = ? WHERE sid = ?', orgId, sid); },
    end(sid) { run('DELETE FROM user_sessions WHERE sid = ?', sid); },
    endAllFor(userId) { run('DELETE FROM user_sessions WHERE userId = ?', userId); },
  };

  // ------------------------------------------------------- scoped access
  //
  // Everything below is closed over one orgId. There is no way to ask these for
  // another tenant's rows.
  function org(orgId) {
    if (!orgId) throw new Error('org(): an organization id is required');

    // An account id that is not ours must not resolve, however it was obtained.
    const ownsAccount = (accountId) => !!one(
      'SELECT 1 x FROM accounts WHERE id = ? AND orgId = ?', String(accountId), orgId);
    const requireAccount = (accountId) => {
      if (!ownsAccount(accountId)) throw new Error(`account ${accountId} does not belong to this organization`);
      return String(accountId);
    };

    const accounts = {
      all() {
        return all('SELECT * FROM accounts WHERE orgId = ? ORDER BY pos, rowid', orgId)
          .map((a) => ({ ...a, enabled: !!a.enabled }));
      },
      get(id) {
        const a = one('SELECT * FROM accounts WHERE id = ? AND orgId = ?', String(id), orgId);
        return a ? { ...a, enabled: !!a.enabled } : null;
      },
      byEmail(email) {
        const a = one('SELECT * FROM accounts WHERE lower(email) = lower(?) AND orgId = ?',
          String(email || ''), orgId);
        return a ? { ...a, enabled: !!a.enabled } : null;
      },
      nextId() {
        for (let i = 1; ; i++) {
          if (!one('SELECT 1 x FROM accounts WHERE id = ?', 'a' + i)) return 'a' + i;
        }
      },
      upsert(acc) {
        const id = acc.id ? requireAccountOrNew(acc.id) : accounts.nextId();
        const prev = accounts.get(id) || {};
        const pos = acc.pos !== undefined ? acc.pos
          : (prev.pos !== undefined ? prev.pos
            : Number((one('SELECT max(pos) m FROM accounts WHERE orgId = ?', orgId) || {}).m || 0) + 1);
        run(`INSERT INTO accounts (id,orgId,label,server,email,password,enabled,notes,proxy,pos,createdAt)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               label=excluded.label, server=excluded.server, email=excluded.email,
               password=excluded.password, enabled=excluded.enabled, notes=excluded.notes,
               proxy=excluded.proxy, pos=excluded.pos`,
          id, orgId,
          acc.label !== undefined ? acc.label : (prev.label || id),
          acc.server !== undefined ? acc.server : (prev.server || 'ss71'),
          acc.email !== undefined ? acc.email : prev.email,
          acc.password !== undefined ? acc.password : prev.password,
          acc.enabled !== undefined ? (acc.enabled ? 1 : 0) : (prev.enabled === false ? 0 : 1),
          acc.notes !== undefined ? acc.notes : prev.notes,
          acc.proxy !== undefined ? acc.proxy : prev.proxy,
          pos, prev.createdAt || now());
        return accounts.get(id);
      },
      remove(id) {
        const a = requireAccount(id);
        for (const t of ['accounts', 'snapshots', 'account_latest', 'goals', 'city_registry', 'engine_state']) {
          run(`DELETE FROM ${t} WHERE ${t === 'accounts' ? 'id' : 'accountId'} = ?`, a);
        }
      },
      touch(id, at) { run('UPDATE accounts SET lastPolled = ? WHERE id = ? AND orgId = ?', at || now(), String(id), orgId); },
      withSnapshots() { return accounts.all().map((a) => ({ ...a, snapshot: snapshots.latest(a.id) })); },
    };

    // A brand new id is fine; an existing one must already be ours.
    function requireAccountOrNew(id) {
      const existing = one('SELECT orgId FROM accounts WHERE id = ?', String(id));
      if (existing && existing.orgId !== orgId) {
        throw new Error(`account ${id} belongs to another organization`);
      }
      return String(id);
    }

    const snapshots = {
      add(accountId, snap) { return raw.snapshots.add(requireAccount(accountId), snap); },
      latest(accountId) { return ownsAccount(accountId) ? raw.snapshots.latest(accountId) : null; },
      series(accountId, since, field) {
        return ownsAccount(accountId) ? raw.snapshots.series(accountId, since, field) : [];
      },
    };

    const goals = {
      find(accountId, keys, kind) {
        return ownsAccount(accountId) ? raw.goals.find(accountId, keys, kind) : null;
      },
      set(accountId, cityKey, kind, src) { return raw.goals.set(requireAccount(accountId), cityKey, kind, src); },
      remove(accountId, cityKey, kind) { return raw.goals.remove(requireAccount(accountId), cityKey, kind); },
      list(kind) {
        const mine = new Set(accounts.all().map((a) => a.id));
        return raw.goals.list(kind).filter((g) => mine.has(g.accountId));
      },
    };

    const engineState = {
      load(accountId) { return ownsAccount(accountId) ? raw.engineState.load(accountId) : {}; },
      save(obj, accountId) { return raw.engineState.save(obj, requireAccount(accountId)); },
    };

    const registry = {
      all(accountId) { return ownsAccount(accountId) ? raw.registry.all(accountId) : []; },
      get(accountId, fieldId) { return ownsAccount(accountId) ? raw.registry.get(accountId, fieldId) : null; },
      byCastleId(accountId, castleId) { return ownsAccount(accountId) ? raw.registry.byCastleId(accountId, castleId) : null; },
      claimFlat(accountId, ...a) { return raw.registry.claimFlat(requireAccount(accountId), ...a); },
      markBuilt(accountId, ...a) { return raw.registry.markBuilt(requireAccount(accountId), ...a); },
      markAbandoned(accountId, ...a) { return raw.registry.markAbandoned(requireAccount(accountId), ...a); },
      reconcile(accountId, ...a) { return raw.registry.reconcile(requireAccount(accountId), ...a); },
    };

    const uptime = {
      add(row) { run2Uptime({ ...row, orgId }); },
      series(since, probe) {
        return probe
          ? all('SELECT * FROM uptime WHERE orgId = ? AND at >= ? AND probe = ? ORDER BY at', orgId, since || 0, probe)
          : all('SELECT * FROM uptime WHERE orgId = ? AND at >= ? ORDER BY at', orgId, since || 0);
      },
      probes(since) {
        return all('SELECT DISTINCT probe FROM uptime WHERE orgId = ? AND at >= ? ORDER BY probe', orgId, since || 0)
          .map((r) => r.probe);
      },
      latest(probe) { return one('SELECT * FROM uptime WHERE orgId = ? AND probe = ? ORDER BY at DESC LIMIT 1', orgId, probe) || null; },
      firstAt() { return Number((one('SELECT min(at) m FROM uptime WHERE orgId = ?', orgId) || {}).m) || 0; },
      prune(days = 30) { run('DELETE FROM uptime WHERE orgId = ? AND at < ?', orgId, now() - days * 86400000); },
    };
    const run2Uptime = (row) => raw.uptime.add(row);

    const settings = {
      get(k, d = null) {
        const r = one('SELECT v FROM settings WHERE orgId = ? AND k = ?', orgId, k);
        if (!r) return d;
        try { return JSON.parse(r.v); } catch { return r.v; }
      },
      set(k, v) {
        run(`INSERT INTO settings (orgId,k,v) VALUES (?,?,?)
             ON CONFLICT(orgId,k) DO UPDATE SET v = excluded.v`, orgId, k, JSON.stringify(v));
      },
    };

    const players = {
      record(userName, prestige, at) {
        run(`INSERT INTO player_snapshots (orgId,userName,at,prestige) VALUES (?,?,?,?)
             ON CONFLICT(userName,at) DO UPDATE SET prestige = excluded.prestige`,
          orgId, userName, at || now(), Number(prestige) || null);
      },
      latest(userName) {
        return one('SELECT * FROM player_snapshots WHERE orgId = ? AND userName = ? ORDER BY at DESC LIMIT 1',
          orgId, userName) || null;
      },
    };

    return { orgId, accounts, snapshots, goals, engineState, registry, uptime, settings, players, ownsAccount };
  }

  let raw = null;                       // filled in by db.js once its API exists
  const attach = (api) => { raw = api; };

  return { orgs, users, sessions, org, attach, slugify, newId };
}

module.exports = { install, build };
