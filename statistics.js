'use strict';
// The game's Statistics window (RankWin.as): every player, alliance, hero and city
// on the server, ranked. The console's Statistics tab reads it all through its own
// connection, stores it here and searches it (the user, 2026-09-19).
//
// Requests, from the decompiled client:
//   rank.getPlayerRank / getAllianceRank / getHeroRank / getCastleRank
//     {key, pageNo, pageSize, sortType}                     RankCommands.as:27-88
//   key null = the whole list (AllianceList.as:453 asks so); a name makes the server
//   search. The window asks 10 a page (RankWin.as:166) and starts with sortType 0
//   (its typeId, RankWin.as:228); a reply is {ok, pageNo, pageSize, totalPage, beans}.
//   Players come back as PlayerInfoBeans, the rest as Rank*Bean (common/beans).
// The window's columns (RankWin.as:1733-2023, dataField -> header):
//   players   ranking, userName 君主, alliance, titleId 爵位, honor, prestige, castleCount, population
//   alliances rank, name, playerName 盟主 (host), member, city, prestige, honor
//   heroes    rank, name 将领, kind 君主 (the lord), grade 等级, management 内政, power 勇武, stratagem 智谋
//   cities    rank, name, level, kind 君主 (the lord), alliance, population
//
// Two ways in, both read-only and never a login (the console's live game only):
//   page()   the tab browses a list a page at a time, straight from the server, and
//            reads AHEAD pages past it in the background so Next is instant. A page
//            read in the last FRESH_MS is served from the database (the tab polls).
//   start()  Refresh: every list end to end, for searching. A read that stopped (a
//            console restart, the connection) carries on from its last page.
// One page in flight at a time per background reader, with a pause between pages, and
// both wait while the account's own market writes are queued (EVONY-RULES §3: load in
// flight is what breaks an account). Rows are keyed by their place in the list (pos),
// so a page overwrites the last read of it; a list that shrank loses its tail.
//
// Live (2026-09-19, Lord04): pageSize 100 is taken, players ran to 247 pages, ~0.6 s a page.
// Unverified: what sortType 0 sorts by (a refusal or an empty list falls back to the
// window's first sort that makes a ranking), and what a key search answers beyond the
// page the name is on (RankWin.as searchOwer/readFromServer).
const D = require('./db');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v) => (v === undefined || v === null ? '' : String(v));

// PlayerInfoTypeManager.getTitle, as script-cmd-social.js shows it (a lady lord gets the female form)
const TITLES = [['Civilian', 'Civilian'], ['Knight', 'Dame'], ['Baronet', 'Baronetess'], ['Baron', 'Baroness'],
  ['Viscount', 'Viscountess'], ['Earl', 'Countess'], ['Marquis', 'Marchioness'], ['Duke', 'Duchess'],
  ['Furst', 'Furstin'], ['Prinz', 'Prinzessin']];
const titleName = (id, sex) => (TITLES[num(id)] || [])[num(sex) === 1 ? 1 : 0] || '';

// col: the table column; h: the tab's header; n: a number; q: searched, and a
// click on it searches for it. from: the bean -> the value.
const KINDS = {
  players: {
    label: 'Players', cmd: 'rank.getPlayerRank', fallbackSort: 2,       // 2 prestige (RankWin.as:199-215)
    rank: (b) => b.ranking,
    cols: [
      { col: 'name', h: 'Lord', q: 1, from: (b) => b.userName },
      { col: 'alliance', h: 'Alliance', q: 1, from: (b) => b.alliance },
      { col: 'title', h: 'Title', from: (b) => titleName(b.titleId, b.sex) },
      { col: 'prestige', h: 'Prestige', n: 1, from: (b) => b.prestige },
      { col: 'honor', h: 'Honor', n: 1, from: (b) => b.honor },
      { col: 'cities', h: 'Cities', n: 1, from: (b) => b.castleCount },
      { col: 'population', h: 'Population', n: 1, from: (b) => b.population },
    ],
  },
  alliances: {
    label: 'Alliances', cmd: 'rank.getAllianceRank', fallbackSort: 2,   // 2 prestige (RankWin.as:210-218)
    rank: (b) => b.rank,
    cols: [
      { col: 'name', h: 'Alliance', q: 1, from: (b) => b.name },
      { col: 'host', h: 'Host', q: 1, from: (b) => b.playerName },
      { col: 'founder', h: 'Founder', q: 1, from: (b) => b.createrName },
      { col: 'members', h: 'Members', n: 1, from: (b) => b.member },
      { col: 'cities', h: 'Cities', n: 1, from: (b) => b.city },
      { col: 'prestige', h: 'Prestige', n: 1, from: (b) => b.prestige },
      { col: 'honor', h: 'Honor', n: 1, from: (b) => b.honor },
    ],
  },
  heroes: {
    label: 'Heroes', cmd: 'rank.getHeroRank', fallbackSort: 1,          // 1 level (RankWin.as:138-149)
    rank: (b) => b.rank,
    cols: [
      { col: 'name', h: 'Hero', q: 1, from: (b) => b.name },
      { col: 'lord', h: 'Lord', q: 1, from: (b) => b.kind },
      { col: 'level', h: 'Level', n: 1, from: (b) => b.grade },
      { col: 'politics', h: 'Pol', n: 1, from: (b) => b.management },
      { col: 'attack', h: 'Atk', n: 1, from: (b) => b.power },
      { col: 'intel', h: 'Int', n: 1, from: (b) => b.stratagem },
    ],
    // The hero ranking does not name the alliance, so it is the lord's, looked up in
    // the player ranking when the list is searched. Not stored: a lord who changes
    // alliance shows the new one as soon as the players are read again.
    derived: [
      { col: 'alliance', h: 'Alliance', q: 1,
        sql: `(SELECT p.alliance FROM stat_players p WHERE p.server = stat_heroes.server
          AND p.name = stat_heroes.lord COLLATE NOCASE LIMIT 1)`,   // no ORDER BY: it sends sqlite past the name index (20 s to sort)
        // filtering on it: the lords of those alliances, which the lord index answers fast.
        // It takes the server and then the text, so it is one lookup, not one per hero.
        like: `lord COLLATE NOCASE IN (SELECT name FROM stat_players WHERE server = ?
          AND alliance LIKE ? ESCAPE '\\')` },
    ],
  },
  cities: {
    label: 'Cities', cmd: 'rank.getCastleRank', fallbackSort: 1,        // 1 population (RankWin.as:217-223)
    rank: (b) => b.rank,
    cols: [
      { col: 'name', h: 'City', q: 1, from: (b) => b.name },
      { col: 'level', h: 'Level', n: 1, from: (b) => b.level },
      { col: 'lord', h: 'Lord', q: 1, from: (b) => b.kind },
      { col: 'alliance', h: 'Alliance', q: 1, from: (b) => b.alliance },
      { col: 'population', h: 'Population', n: 1, from: (b) => b.population },
    ],
  },
};
const KIND_NAMES = Object.keys(KINDS);
const table = (kind) => `stat_${kind}`;

for (const [kind, k] of Object.entries(KINDS)) {
  const cols = k.cols.map((c) => `${c.col} ${c.n ? 'REAL' : 'TEXT'}`).join(', ');
  D.run(`CREATE TABLE IF NOT EXISTS ${table(kind)} (server TEXT NOT NULL, pos INTEGER NOT NULL, rank INTEGER,
    ${cols}, at INTEGER, PRIMARY KEY (server, pos))`);
  for (const c of k.cols.filter((x) => x.q)) {
    D.run(`CREATE INDEX IF NOT EXISTS ${table(kind)}_${c.col} ON ${table(kind)} (server, ${c.col} COLLATE NOCASE)`);
  }
}
// One row per list: the last crawl, and the one running (written every page, so any
// console on the server sees another's progress).
D.run(`CREATE TABLE IF NOT EXISTS stat_meta (server TEXT NOT NULL, kind TEXT NOT NULL,
  state TEXT, at INTEGER, rows INTEGER, pageNo INTEGER, totalPage INTEGER, pageSize INTEGER,
  sortType INTEGER, account TEXT, error TEXT, startedAt INTEGER, updatedAt INTEGER,
  PRIMARY KEY (server, kind))`);

const PAGE_WANT = Math.max(10, Number(process.env.OTTO_STATS_PAGE) || 100);
const PAUSE_MS = Math.max(0, Number(process.env.OTTO_STATS_PAUSE_MS) || 250);
const REPLY_MS = 15000;
const BUSY_PIPE = 10;           // wait while more market writes than this are in flight
const RETRIES = [2000, 5000, 15000];
const MAX_PAGES = 50000;
const STALE_MS = 90000;         // a "running" row not written for this long is a crawl that died
const FRESH_MS = Math.max(0, Number(process.env.OTTO_STATS_FRESH_MS) || 10 * 60000);
const AHEAD = 5;                // pages read ahead of the one the tab shows
const RESUME_MS = 24 * 3600000; // a stopped Refresh younger than this carries on
// Refresh reads the small lists first, so a long one never keeps them out
const CRAWL_ORDER = ['alliances', 'players', 'cities', 'heroes'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function meta(server, kind) {
  return D.one('SELECT * FROM stat_meta WHERE server = ? AND kind = ?', server, kind) || null;
}
function setMeta(server, kind, o) {
  const m = { ...(meta(server, kind) || {}), ...o, server, kind, updatedAt: Date.now() };
  D.run(`INSERT OR REPLACE INTO stat_meta (server, kind, state, at, rows, pageNo, totalPage, pageSize, sortType,
    account, error, startedAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  server, kind, str(m.state), m.at || null, num(m.rows), num(m.pageNo), num(m.totalPage), num(m.pageSize),
  num(m.sortType), str(m.account), m.error || null, m.startedAt || null, m.updatedAt);
}

function saveBeans(server, kind, rows, at) {
  const k = KINDS[kind];
  const names = ['server', 'pos', 'rank', ...k.cols.map((c) => c.col), 'at'];
  const sql = `INSERT OR REPLACE INTO ${table(kind)} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`;
  const stmt = D.db.prepare(sql);
  D.db.exec('BEGIN');
  try {
    for (const { pos, bean } of rows) {
      const vals = k.cols.map((c) => (c.n ? num(c.from(bean)) : str(c.from(bean))));
      stmt.run(server, pos, num(k.rank(bean)) || pos, ...vals, at);
    }
    D.db.exec('COMMIT');
  } catch (e) { D.db.exec('ROLLBACK'); throw e; }
}

// The crawl this process runs (one at a time), and how to stop it.
const JOB = { running: false, stop: false, kind: null, kinds: [], account: null, server: null, startedAt: 0 };

// Ask one page. The reply names only its command, so each list's requests queue in
// their own lane (game.js lane) — a script's searchheroes can't take our reply.
async function askPage(game, cmd, pageNo, pageSize, sortType, key = null) {
  const run = () => game.req(cmd, { key, pageNo, pageSize, sortType }, REPLY_MS);
  return typeof game.lane === 'function' ? game.lane(cmd, run) : run();
}
const okReply = (r) => r && Number(r.ok) === 1;

// Ask a page again after a lost or refused reply. Returns the last reply.
async function askRetry({ game, k, pageNo, pageSize, sortType, alive, log }) {
  let r = null;
  for (let i = 0; i <= RETRIES.length; i++) {
    try { r = await askPage(game, k.cmd, pageNo, pageSize, sortType); } catch (e) { r = { ok: 0, errorMsg: e.message }; }
    if (okReply(r)) break;
    if (i < RETRIES.length && alive() && !JOB.stop) {
      log(`statistics: ${k.label.toLowerCase()} page ${pageNo} -> ${r.errorMsg || 'ok=' + r.ok}, again in ${RETRIES[i] / 1000} s`);
      await sleep(RETRIES[i]);
    }
  }
  return r;
}

// Where a stopped read of this list got to, if it can carry on from there.
function resumeAt(server, kind, now) {
  const m = meta(server, kind);
  if (!m || !['stopped', 'failed', 'running'].includes(m.state)) return null;
  if (m.state === 'running' && now - num(m.updatedAt) < STALE_MS) return null;   // another console is on it
  if (!(num(m.pageNo) > 0 && num(m.pageSize) && num(m.totalPage) > num(m.pageNo))) return null;
  if (now - num(m.startedAt) > RESUME_MS) return null;
  return { pageNo: num(m.pageNo), pageSize: num(m.pageSize), sortType: num(m.sortType), totalPage: num(m.totalPage) };
}

// Read one list end to end. Returns { rows, error }.
async function crawlKind({ game, server, kind, account, alive, log }) {
  const k = KINDS[kind];
  const t0 = Date.now();
  let pageSize = PAGE_WANT, sortType = 0, eff = 0, pageNo = 1, totalPage = 0, pos = 0, pages = 0;
  const fail = (error) => { setMeta(server, kind, { state: 'failed', error }); return { rows: pos, error }; };
  const why = (r) => (!r ? 'no reply' : r.errorMsg || 'ok=' + r.ok);
  let r = null;
  const back = resumeAt(server, kind, t0);
  if (back) {
    // carry on after the last page the stopped read saved
    ({ pageSize, sortType, totalPage } = back);
    eff = pageSize;
    pageNo = back.pageNo + 1;
    pos = back.pageNo * pageSize;
    setMeta(server, kind, { state: 'running', account, error: null });
    log(`statistics: ${k.label.toLowerCase()} carries on at page ${pageNo} of ${totalPage}`);
    r = await askRetry({ game, k, pageNo, pageSize, sortType, alive, log });
    if (!okReply(r)) return fail(`page ${pageNo} of ${totalPage}: ${why(r)}`);
  } else {
    setMeta(server, kind, { state: 'running', startedAt: t0, pageNo: 0, totalPage: 0, rows: 0, account, error: null });
    // The first page settles the sort and the page size the server really uses.
    for (const [ps, st] of [[pageSize, 0], [pageSize, k.fallbackSort], [10, 0], [10, k.fallbackSort]]) {
      try { r = await askPage(game, k.cmd, 1, ps, st); } catch (e) { r = { ok: 0, errorMsg: e.message }; }
      if (okReply(r) && (r.beans || []).length) { pageSize = ps; sortType = st; break; }
      if (!alive() || JOB.stop) break;
    }
    if (!okReply(r) || !(r.beans || []).length) {
      return fail(!r ? 'no reply' : r.errorMsg || (okReply(r) ? 'the list came back empty' : `the server answered ok=${r.ok}`));
    }
  }

  for (;;) {
    const beans = r.beans || [];
    totalPage = num(r.totalPage) || totalPage || 1;
    // a page before the last is full, so its length is the size the server pages by
    if (!eff) eff = pageNo < totalPage ? beans.length : Math.max(beans.length, 1);
    const at = Date.now();
    saveBeans(server, kind, beans.map((bean, i) => ({ pos: (pageNo - 1) * eff + i + 1, bean })), at);
    pos = Math.max(pos, (pageNo - 1) * eff + beans.length);
    pages++;
    setMeta(server, kind, { state: 'running', pageNo, totalPage, pageSize: eff, sortType, rows: pos });
    if (pageNo >= totalPage || !beans.length || pages >= MAX_PAGES) break;
    pageNo++;

    // pace: a pause, and the account's own market writes first
    await sleep(PAUSE_MS);
    while (alive() && !JOB.stop && typeof game.pipeInFlight === 'function' && game.pipeInFlight() > BUSY_PIPE) await sleep(1000);
    if (!alive()) { setMeta(server, kind, { state: 'stopped', error: 'the connection went' }); return { rows: pos, error: 'the connection went' }; }
    if (JOB.stop) { setMeta(server, kind, { state: 'stopped', error: 'stopped' }); return { rows: pos, error: 'stopped' }; }

    r = await askRetry({ game, k, pageNo, pageSize, sortType, alive, log });
    if (!okReply(r)) return fail(`page ${pageNo} of ${totalPage}: ${why(r)}`);
  }
  // the whole list is in: anything past its end is from an older, longer list
  D.run(`DELETE FROM ${table(kind)} WHERE server = ? AND pos > ?`, server, pos);
  setMeta(server, kind, { state: 'done', at: Date.now(), rows: pos, error: null });
  log(`statistics: ${k.label.toLowerCase()} read — ${pos.toLocaleString('en-US')} in ${pages} page(s), ${Math.round((Date.now() - t0) / 1000)} s`);
  return { rows: pos, error: null };
}

// ---- browsing: a page at a time, from the server --------------------------

const rowOut = (k, row) => {
  const o = { rank: row.rank };
  for (const c of k.cols) o[c.col] = row[c.col];
  return o;
};
// The saved rows of one page, and whether they are the whole page and recent.
function cachedPage(server, kind, pageNo, pageSize, totalPage, now = Date.now()) {
  const k = KINDS[kind];
  const lo = (pageNo - 1) * pageSize + 1, hi = pageNo * pageSize;
  const rows = D.all(`SELECT pos, rank, ${k.cols.map((c) => c.col).join(', ')}, at FROM ${table(kind)}
    WHERE server = ? AND pos BETWEEN ? AND ? ORDER BY pos`, server, lo, hi);
  const whole = rows.length === pageSize || (pageNo === totalPage && rows.length > 0);
  const at = rows.length ? Math.min(...rows.map((x) => num(x.at))) : 0;
  return { rows: rows.map((x) => rowOut(k, x)), at, fresh: !!(whole && totalPage && now - at < FRESH_MS) };
}

// Pages being read now, so the tab and the reader ahead never ask for one twice.
const INFLIGHT = new Map();

// Read one page from the server into the database. Returns { pageNo, error }.
// A list never read settles its page size and sort on page 1 first, as a crawl does.
function loadPage({ game, server, kind, pageNo }) {
  const id = `${server}:${kind}:${pageNo}`;
  if (INFLIGHT.has(id)) return INFLIGHT.get(id);
  const p = (async () => {
    const k = KINDS[kind];
    const m = meta(server, kind) || {};
    const known = num(m.pageSize) > 0;
    const tries = known ? [[num(m.pageSize), num(m.sortType)]]
      : [[PAGE_WANT, 0], [PAGE_WANT, k.fallbackSort], [10, 0], [10, k.fallbackSort]];
    const want = known ? pageNo : 1;
    let r = null, ps = 0, st = 0;
    for (const [a, b] of tries) {
      try { r = await askPage(game, k.cmd, want, a, b); } catch (e) { r = { ok: 0, errorMsg: e.message }; }
      if (okReply(r) && (known || (r.beans || []).length)) { ps = a; st = b; break; }
    }
    if (!okReply(r)) return { error: !r ? 'no reply' : r.errorMsg || `the server answered ok=${r.ok}` };
    const beans = r.beans || [];
    if (!known && !beans.length) return { error: 'the list came back empty' };
    const totalPage = num(r.totalPage) || 1;
    const got = num(r.pageNo) || want;
    // the size the server really pages by: a full page before the last says it
    const eff = got < totalPage && beans.length ? beans.length : ps;
    saveBeans(server, kind, beans.map((bean, i) => ({ pos: (got - 1) * eff + i + 1, bean })), Date.now());
    // the last page ends the list: anything saved past it is from a longer, older one
    const end = got >= totalPage ? (got - 1) * eff + beans.length : totalPage * eff;
    D.run(`DELETE FROM ${table(kind)} WHERE server = ? AND pos > ?`, server, end);
    const cur = meta(server, kind) || {};
    // a Refresh under way owns the numbers it pages by
    if (!(cur.state === 'running' && Date.now() - num(cur.updatedAt) < STALE_MS)) setMeta(server, kind, { totalPage, pageSize: eff, sortType: st });
    if (!known && pageNo !== 1) { INFLIGHT.delete(id); return loadPage({ game, server, kind, pageNo }); }   // now the size is known
    return { pageNo: got, error: null };
  })().finally(() => { if (INFLIGHT.get(id) === p) INFLIGHT.delete(id); });
  INFLIGHT.set(id, p);
  return p;
}

// The reader ahead: one page at a time, paced, only while the connection is the console's.
const AHEAD_Q = [];
let aheadBusy = false;
function readAhead(item) {
  // the tab moved on: what it wanted before in this list no longer matters
  for (let i = AHEAD_Q.length - 1; i >= 0; i--) if (AHEAD_Q[i].server === item.server && AHEAD_Q[i].kind === item.kind) AHEAD_Q.splice(i, 1);
  for (const pageNo of item.pages) AHEAD_Q.push({ ...item, pageNo });
  if (aheadBusy) return;
  aheadBusy = true;
  (async () => {
    try {
      while (AHEAD_Q.length) {
        const it = AHEAD_Q.shift();
        if (!it.alive()) continue;
        const m = meta(it.server, it.kind) || {};
        if (!num(m.pageSize) || it.pageNo > num(m.totalPage)) continue;
        if (cachedPage(it.server, it.kind, it.pageNo, num(m.pageSize), num(m.totalPage)).fresh) continue;
        while (it.alive() && typeof it.game.pipeInFlight === 'function' && it.game.pipeInFlight() > BUSY_PIPE) await sleep(1000);
        if (!it.alive()) continue;
        const res = await loadPage(it);
        if (res.error) {
          it.log(`statistics: reading ahead, ${KINDS[it.kind].label.toLowerCase()} page ${it.pageNo} -> ${res.error}`);
          for (let i = AHEAD_Q.length - 1; i >= 0; i--) if (AHEAD_Q[i].kind === it.kind) AHEAD_Q.splice(i, 1);
        }
        await sleep(PAUSE_MS);
      }
    } catch (e) { AHEAD_Q.length = 0; } finally { aheadBusy = false; }
  })();
}

// How long a list is: exact once its last page is saved, else from its page count.
function listSize(server, kind, m = meta(server, kind) || {}) {
  const tp = num(m.totalPage), ps = num(m.pageSize);
  if (!tp || !ps) return { total: 0, exact: false };
  const last = num((D.one(`SELECT count(*) c FROM ${table(kind)} WHERE server = ? AND pos > ?`, server, (tp - 1) * ps) || {}).c);
  return { total: (tp - 1) * ps + (last || ps), exact: !!last };
}

// One page of a list, as the game's window shows it: from the database when it was
// read in the last FRESH_MS, else from the server; and the next `ahead` read behind it.
// Without a connection it serves what the database has.
async function page({ game, server, kind, pageNo = 1, alive = () => true, ahead = AHEAD, log = () => {} }) {
  const k = KINDS[kind];
  if (!k) return { error: 'no such list' };
  const up = !!game && alive();
  let m = meta(server, kind) || {};
  let n = Math.max(1, Math.floor(num(pageNo)) || 1);
  if (num(m.totalPage) && n > num(m.totalPage)) n = num(m.totalPage);
  const saved = () => (num(m.pageSize) ? cachedPage(server, kind, n, num(m.pageSize), num(m.totalPage)) : { rows: [], at: 0, fresh: false });
  let c = saved();
  let error = null;
  if (!c.fresh) {
    if (up) {
      const res = await loadPage({ game, server, kind, pageNo: n });
      if (res.error) error = res.error;
      else n = res.pageNo;
      m = meta(server, kind) || {};
      c = saved();
    } else if (!c.rows.length) error = 'not connected';
  }
  const totalPage = num(m.totalPage), pageSize = num(m.pageSize);
  if (up && ahead > 0 && totalPage > n) {
    const pages = [];
    for (let i = n + 1; i <= Math.min(totalPage, n + ahead); i++) pages.push(i);
    readAhead({ game, server, kind, alive, log, pages });
  }
  return { kind, label: k.label, cols: colsOut(k), rows: c.rows, pageNo: n, totalPage, pageSize,
    ...listSize(server, kind, m), at: c.at || null, error, live: true };
}

// Ask the server for a name (the window's search box): it answers with the page that
// name is on. The rows come back as they are, not saved — what else such a reply
// holds is unverified — and each says which page of the list it is on.
async function lookup({ game, server, kind, name }) {
  const k = KINDS[kind];
  const key = String(name || '').trim();
  if (!k || !key) return { error: 'nothing to look up' };
  const out = { kind, label: k.label, cols: colsOut(k), rows: [], error: null };
  if (!game) return { ...out, error: 'not connected' };
  const m = meta(server, kind) || {};
  const ps = num(m.pageSize) || PAGE_WANT;
  let r;
  try { r = await askPage(game, k.cmd, 1, ps, num(m.sortType), key); } catch (e) { r = { ok: 0, errorMsg: e.message }; }
  if (!okReply(r)) return { ...out, error: (r && r.errorMsg) || `the server answered ok=${r && r.ok}` };
  const low = key.toLowerCase();
  out.rows = (r.beans || []).map((b) => {
    const o = { rank: num(k.rank(b)) };
    for (const c of k.cols) o[c.col] = c.n ? num(c.from(b)) : str(c.from(b));
    o.page = o.rank ? Math.ceil(o.rank / ps) : num(r.pageNo) || 1;
    o.exact = k.cols.some((c) => c.q && String(o[c.col]).toLowerCase() === low);
    return o;
  }).sort((a, b) => b.exact - a.exact || a.rank - b.rank);
  return out;
}

// Start reading the lists (all of them by default) in the background. `alive` says
// whether `game` is still the console's live connection; a crawl never connects.
function start({ game, server, account, kinds = KIND_NAMES, alive = () => true, log = () => {} }) {
  if (JOB.running) return { ok: false, error: `already reading ${KINDS[JOB.kind] ? KINDS[JOB.kind].label.toLowerCase() : 'the statistics'}` };
  if (!game) return { ok: false, error: 'not connected' };
  const want = CRAWL_ORDER.filter((k) => (kinds || []).includes(k));
  if (!want.length) return { ok: false, error: 'nothing to read' };
  Object.assign(JOB, { running: true, stop: false, kind: want[0], kinds: want, account, server, startedAt: Date.now() });
  log(`statistics: reading ${want.join(', ')} through ${account || 'this account'}`);
  (async () => {
    try {
      for (const kind of want) {
        if (JOB.stop || !alive()) break;
        JOB.kind = kind;
        await crawlKind({ game, server, kind, account, alive, log });
      }
    } catch (e) {
      log(`statistics: stopped — ${e.message}`);
      if (JOB.kind) setMeta(server, JOB.kind, { state: 'failed', error: e.message });
    } finally {
      Object.assign(JOB, { running: false, kind: null });
    }
  })();
  return { ok: true };
}

function stop() {
  if (!JOB.running) return { ok: false, error: 'nothing is being read' };
  JOB.stop = true;
  return { ok: true };
}

// Each list: how many rows, when it was last read in full, and a crawl in progress
// (this console's, or another console's on the same server).
function status(server) {
  const out = {};
  for (const [kind, k] of Object.entries(KINDS)) {
    const m = meta(server, kind) || {};
    const rows = num((D.one(`SELECT count(*) c FROM ${table(kind)} WHERE server = ?`, server) || {}).c);
    const size = listSize(server, kind, m);
    if (!size.total) Object.assign(size, { total: rows, exact: true });
    let state = m.state || (rows ? 'done' : 'never');
    const mine = JOB.running && JOB.server === server && JOB.kinds.includes(kind);
    if (state === 'running' && !mine && Date.now() - num(m.updatedAt) > STALE_MS) state = 'stopped';
    if (mine && JOB.kind !== kind && state !== 'running') state = JOB.kinds.indexOf(kind) > JOB.kinds.indexOf(JOB.kind) ? 'queued' : state;
    out[kind] = {
      label: k.label, rows, ...size, state, at: m.at || null, pageNo: num(m.pageNo), totalPage: num(m.totalPage),
      pageSize: num(m.pageSize), account: m.account || null, error: m.error || null, updatedAt: m.updatedAt || null,
    };
  }
  return { lists: out, running: JOB.running && JOB.server === server, account: JOB.running ? JOB.account : null };
}

const likeOf = (q) => `%${String(q).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
const colsOut = (k) => [{ k: 'rank', h: 'Rank', n: 1 }, ...k.cols.map((c) => ({ k: c.col, h: c.h, n: !!c.n, q: !!c.q }))];

// One list, filtered by text in any of its searched columns, sorted by a column.
//
// `filters` narrows it a COLUMN at a time, which is what makes the Director's
// Statistics view worth having: every player in one alliance, every hero of one
// lord, every city of a level. A text column takes a substring, a number column
// takes a value or {min, max}. A filter on a column the list does not have is
// ignored, so the same filters can be thrown at all four lists.
function searchKind(server, kind, { q = '', sort = 'rank', dir = 'asc', limit = 200, offset = 0, filters = null } = {}) {
  const k = KINDS[kind];
  const all = [...k.cols, ...(k.derived || [])];
  const expr = (c) => c.sql || c.col;
  const like = (c) => c.like || `${c.col} LIKE ? ESCAPE '\\'`;
  const likeArgs = (c, v) => (c.like ? [server, likeOf(v)] : [likeOf(v)]);
  const qc = all.filter((c) => c.q);
  const text = String(q || '').trim();
  const where = ['server = ?'];
  const args = [server];
  if (text) {
    where.push(`(${qc.map(like).join(' OR ')})`);
    for (const c of qc) args.push(...likeArgs(c, text));
  }
  for (const [col, want] of Object.entries(filters || {})) {
    const c = all.find((x) => x.col === col);
    if (!c || want === null || want === undefined || want === '') continue;
    if (!c.n) { where.push(like(c)); args.push(...likeArgs(c, String(want).trim())); continue; }
    const r = typeof want === 'object' ? want : { min: want, max: want };
    if (r.min !== undefined && r.min !== null && r.min !== '') { where.push(`${col} >= ?`); args.push(num(r.min)); }
    if (r.max !== undefined && r.max !== null && r.max !== '') { where.push(`${col} <= ?`); args.push(num(r.max)); }
  }
  const cols = ['rank', ...all.map((c) => c.col)];
  const by = cols.includes(sort) ? sort : 'rank';
  const d = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const numeric = by === 'rank' || (all.find((c) => c.col === by) || {}).n;
  // an exact name first, then the chosen order
  const exact = text ? `(${qc.map((c) => `${expr(c)} = ? COLLATE NOCASE`).join(' OR ')}) DESC, ` : '';
  const exactArgs = text ? qc.map(() => text) : [];
  const total = num((D.one(`SELECT count(*) c FROM ${table(kind)} WHERE ${where.join(' AND ')}`, ...args) || {}).c);
  const lim = Math.max(1, Math.min(5000, Math.floor(num(limit)) || 200));
  const off = Math.max(0, Math.floor(num(offset)));
  const rows = D.all(`SELECT rank, ${all.map((c) => (c.sql ? `${c.sql} AS ${c.col}` : c.col)).join(', ')} FROM ${table(kind)}
    WHERE ${where.join(' AND ')} ORDER BY ${exact}${by}${numeric ? '' : ' COLLATE NOCASE'} ${d}, pos LIMIT ? OFFSET ?`,
  ...args, ...exactArgs, lim, off).map((r) => ({ ...r }));
  const out = [...colsOut(k), ...(k.derived || []).map((c) => ({ k: c.col, h: c.h, n: !!c.n, q: !!c.q }))];
  return { kind, label: k.label, cols: out, total, rows, offset: off };
}

// The tab's search: one list, or every list ('all') with the first few of each.
function search(server, { kind = 'all', q = '', sort, dir, limit, offset, filters } = {}) {
  if (KINDS[kind]) return { kind, lists: [searchKind(server, kind, { q, sort, dir, limit, offset, filters })] };
  const each = Math.max(1, Math.min(100, Math.floor(num(limit)) || 10));
  return { kind: 'all', lists: KIND_NAMES.map((k) => searchKind(server, k, { q, limit: each, filters })) };
}

module.exports = { KINDS, KIND_NAMES, start, stop, status, search, searchKind, colsOut, page, lookup, crawlKind, JOB, titleName, FRESH_MS };
