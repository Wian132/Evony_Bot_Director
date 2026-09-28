'use strict';
// The Monitor (monitor.js) and the Director's Monitor tab, offline:
//   1. the analysis — a sweep becomes cities, lords, history and the changes
//      the user asked for: a lord coming off holiday, one that has stopped
//      moving, an alliance change, a city gained or lost
//   2. the searches — cities and lords by alliance / lord / state / level, and
//      the four ranked lists filtered a column at a time
//   3. the watch list — the lords of the top N heroes, and the stall crossing
//   4. a whole-world sweep driven against a FAKE console over HTTP, including
//      a console that falls over part way through
//   5. the real public/director.html in headless Chrome over CDP
//
// Nothing here logs into the game. There is no real console and no real
// Director: a temporary database, a stub console on a spare port, and the
// Director started in this process on 18747. The live Director on 8712 and the
// consoles on 8711+ are never touched.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const http = require('http'), { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-monitor-'));
process.env.EVONY_DB = path.join(TMP, 't.db');
process.env.DIRECTOR_PORT = '18747';
process.env.BOT_LOG_DIR = TMP;
process.env.BOT_PORT_BASE = '18871';
process.env.POLL_GAP_MS = '60000';
process.env.POLL_CYCLE_MS = '3600000';
process.env.POLL_FIRST_MS = '3600000';
process.env.UPTIME_MS = '3600000';
process.env.KEEP_ON_MS = '3600000';
delete process.env.BOT_AUTOSTART;
delete process.env.BIND;

const PORT = 18747;
const SERVER = 'ss0';
const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(60);
  }
}

const D = require('./db');
const M = require('./monitor');
const AUTH = require('./auth');
const op = AUTH.register({ email: 'op@example.com', password: 'correct horse battery', orgName: 'Watch Org' });
const ORG = D.org(op.org.id);
ORG.settings.set('probes', []);
const SID = AUTH.newSession(op.user.id, op.org.id, '127.0.0.1', 'test');
const ACC = ORG.accounts.upsert({ label: 'Watcher', server: SERVER, pos: 1, email: 'w@example.com', password: 'x' });

// ---- the stub console ------------------------------------------------
// It answers the three doors the Monitor knocks on. CASTLES is what the next
// map sweep will find; FAIL makes it refuse, the way a console that is
// reconnecting or standing down for maintenance does.
let CASTLES = [], PLAYERS = [], FAIL = null, STATS_RUNNING = false;
const HITS = { mapsweep: 0, players: 0, refresh: 0, session: 0 };
const stub = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    const say = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const url = req.url.split('?')[0];
    if (url === '/api/session') { HITS.session++; return say({ account: { id: ACC.id, label: ACC.label }, connected: true }); }
    if (url === '/api/mapsweep') {
      HITS.mapsweep++;
      if (FAIL) return say({ error: FAIL });
      const blocks = (JSON.parse(b || '{}').blocks || []).length;
      // every castle lands in the first chunk, so the rest of the world is empty
      const castles = HITS.mapsweep === 1 ? CASTLES : [];
      return say({ asked: blocks, got: blocks, at: Date.now(), castles });
    }
    if (url === '/api/players') {
      HITS.players++;
      if (FAIL) return say({ error: FAIL });
      const names = JSON.parse(b || '{}').names || [];
      return say({ rows: PLAYERS.filter((p) => names.includes(p.userName)), missing: [] });
    }
    if (url === '/api/stats/refresh') { HITS.refresh++; return say({ ok: true }); }
    if (url === '/api/stats') {
      return say({ ok: true, status: { running: STATS_RUNNING, lists: { players: { rows: 7 }, heroes: { rows: 3 } } } });
    }
    res.writeHead(404); res.end('no');
  });
});
const STUB_PORT = 18749;
stub.listen(STUB_PORT, '127.0.0.1');
ORG.settings.set('bots', { [ACC.id]: { url: `http://127.0.0.1:${STUB_PORT}`, pid: process.pid, port: STUB_PORT } });

require('./director');

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method,
      headers: { Cookie: 'otto_sid=' + SID,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: b, json }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const get = async (u) => (await call('GET', u)).json;
const post = (u, b) => call('POST', u, b);

// A sweep as the console hands one over: {userName: [castles]}.
const city = (id, o) => ({ id, x: id % 800, y: Math.floor(id / 800), name: 'town' + id, prestige: 0, honor: 0, state: 1, level: 8, ...o });
const sweepOf = (spec) => new Map(Object.entries(spec));

// ======================================================================= 1
section('a sweep becomes cities, lords and history');

const T0 = Date.now() - 6 * 3600000;

t('the first sweep records every city and lord', () => {
  M.applySweep({ server: SERVER, sweepId: 1, at: T0, byName: sweepOf({
    Ragnar: [city(1001, { allianceName: 'Wolves', prestige: 5000 }), city(1002, { allianceName: 'Wolves', prestige: 5000 })],
    Sleeper: [city(2001, { allianceName: 'Wolves', prestige: 300 })],
    Sunbather: [city(3001, { allianceName: 'Bears', prestige: 90000, state: 5 })],
  }) });
  const cities = M.searchCities(SERVER, {});
  assert.strictEqual(cities.total, 4);
  const lords = M.searchPlayers(SERVER, {});
  assert.strictEqual(lords.total, 3);
  const rag = lords.rows.find((r) => r.userName === 'Ragnar');
  assert.strictEqual(rag.cities, 2, 'both of Ragnar\'s cities counted');
  assert.strictEqual(rag.prestige, 5000);
  assert.strictEqual(rag.stateName, 'peace');
});

t('a lord on holiday is read off the map as holiday, not from any furlough flag', () => {
  const sun = M.searchPlayers(SERVER, { q: 'Sunbather' }).rows[0];
  assert.strictEqual(sun.state, 5);
  assert.strictEqual(sun.stateName, 'holiday');
  assert.strictEqual(M.searchCities(SERVER, { state: 5 }).total, 1);
});

t('the first sweep raises no changes — there is nothing to compare with', () => {
  assert.strictEqual(M.events(SERVER, {}).length, 0);
});

t('a second sweep that changes nothing leaves prestigeAt where it was', () => {
  const before = M.searchPlayers(SERVER, { q: 'Ragnar' }).rows[0].prestigeAt;
  M.applySweep({ server: SERVER, sweepId: 2, at: T0 + 60000, byName: sweepOf({
    Ragnar: [city(1001, { allianceName: 'Wolves', prestige: 5000 }), city(1002, { allianceName: 'Wolves', prestige: 5000 })],
    Sleeper: [city(2001, { allianceName: 'Wolves', prestige: 300 })],
    Sunbather: [city(3001, { allianceName: 'Bears', prestige: 90000, state: 5 })],
  }) });
  const after = M.searchPlayers(SERVER, { q: 'Ragnar' }).rows[0];
  assert.strictEqual(after.prestigeAt, before, 'unchanged prestige does not move prestigeAt');
  assert.strictEqual(M.events(SERVER, {}).length, 0, 'and raises nothing');
});

// ======================================================================= 2
section('the changes the user asked for');

t('prestige that moves is remembered, and the history grows', () => {
  M.applySweep({ server: SERVER, sweepId: 3, at: T0 + 120000, byName: sweepOf({
    Ragnar: [city(1001, { allianceName: 'Wolves', prestige: 5600 }), city(1002, { allianceName: 'Wolves', prestige: 5600 })],
  }) });
  const rag = M.searchPlayers(SERVER, { q: 'Ragnar' }).rows[0];
  assert.strictEqual(rag.prestige, 5600);
  assert.strictEqual(rag.prestigeAt, T0 + 120000);
  assert.strictEqual(rag.prevPrestige, 5000);
  assert.strictEqual(M.history(SERVER, 'Ragnar').length, 2);
});

t('holiday -> peace raises "came off holiday", with the two states on the row', () => {
  // two agreeing readings, because one is not believed (see the blip test)
  M.applySweep({ server: SERVER, sweepId: 4, at: T0 + 170000, byName: sweepOf({
    Sunbather: [city(3001, { allianceName: 'Bears', prestige: 90000, state: 1 })],
  }) });
  assert.strictEqual(M.events(SERVER, { kind: 'left-holiday' }).length, 0, 'not on one reading');
  M.applySweep({ server: SERVER, sweepId: 4, at: T0 + 180000, byName: sweepOf({
    Sunbather: [city(3001, { allianceName: 'Bears', prestige: 90000, state: 1 })],
  }) });
  const e = M.events(SERVER, { kind: 'left-holiday', userName: 'Sunbather' });
  assert.strictEqual(e.length, 1);
  assert.strictEqual(e[0].userName, 'Sunbather');
  assert.strictEqual(e[0].fromVal, 'holiday');
  assert.strictEqual(e[0].toVal, 'peace');
  assert.match(e[0].detail, /came off holiday/);
  assert.strictEqual(M.searchPlayers(SERVER, { q: 'Sunbather' }).rows[0].stateAt, T0 + 180000);
});

t('peace -> holiday raises "went on holiday"', () => {
  for (const at of [T0 + 230000, T0 + 240000]) {
    M.applySweep({ server: SERVER, sweepId: 5, at, byName: sweepOf({
      Sunbather: [city(3001, { allianceName: 'Bears', prestige: 90000, state: 5 })],
    }) });
  }
  assert.strictEqual(M.events(SERVER, { kind: 'went-holiday' }).length, 1);
});

t('one odd reading never raises an alert — a state must be read twice to be believed', () => {
  // The live lesson of 2026-09-23: ten minutes after maintenance the map called two
  // accounts `peace` that were provably still on holiday, and a single sweep
  // announced it. A blip must now survive a second sweep before it counts.
  const base = T0 + 500000;
  M.applySweep({ server: SERVER, sweepId: 90, at: base, byName: sweepOf({
    Blinker: [city(9001, { allianceName: 'Ravens', prestige: 10, state: 5, level: 12 })] }) });
  M.applySweep({ server: SERVER, sweepId: 91, at: base + 60000, byName: sweepOf({
    Blinker: [city(9001, { allianceName: 'Ravens', prestige: 10, state: 5, level: 12 })] }) });
  assert.strictEqual(M.events(SERVER, { userName: 'Blinker' }).length, 0, 'settled, nothing to say');

  // one sweep says peace: believed by nobody yet
  M.applySweep({ server: SERVER, sweepId: 92, at: base + 120000, byName: sweepOf({
    Blinker: [city(9001, { allianceName: 'Ravens', prestige: 10, state: 1, level: 12 })] }) });
  assert.strictEqual(M.searchPlayers(SERVER, { q: 'Blinker' }).rows[0].state, 5, 'still holiday');
  assert.strictEqual(M.events(SERVER, { kind: 'left-holiday', userName: 'Blinker' }).length, 0, 'no alert yet');

  // and it was a blip: back to holiday, still nothing said
  M.applySweep({ server: SERVER, sweepId: 93, at: base + 180000, byName: sweepOf({
    Blinker: [city(9001, { allianceName: 'Ravens', prestige: 10, state: 5, level: 12 })] }) });
  assert.strictEqual(M.searchPlayers(SERVER, { q: 'Blinker' }).rows[0].state, 5);
  assert.strictEqual(M.events(SERVER, { userName: 'Blinker' }).length, 0, 'the blip never became an alert');

  // a real change: two sweeps agree, and only then is it announced
  M.applySweep({ server: SERVER, sweepId: 94, at: base + 240000, byName: sweepOf({
    Blinker: [city(9001, { allianceName: 'Ravens', prestige: 10, state: 1, level: 12 })] }) });
  M.applySweep({ server: SERVER, sweepId: 95, at: base + 300000, byName: sweepOf({
    Blinker: [city(9001, { allianceName: 'Ravens', prestige: 10, state: 1, level: 12 })] }) });
  assert.strictEqual(M.searchPlayers(SERVER, { q: 'Blinker' }).rows[0].state, 1);
  const e = M.events(SERVER, { kind: 'left-holiday', userName: 'Blinker' });
  assert.strictEqual(e.length, 1, 'announced exactly once, on the second agreeing reading');
});

t('a truce is its own state, not a holiday', () => {
  for (const at of [T0 + 290000, T0 + 300000]) {
    M.applySweep({ server: SERVER, sweepId: 6, at, byName: sweepOf({
      Sleeper: [city(2001, { allianceName: 'Wolves', prestige: 300, state: 2 })],
    }) });
  }
  const e = M.events(SERVER, { kind: 'state', userName: 'Sleeper' });
  assert.strictEqual(e.length, 1);
  assert.strictEqual(e[0].toVal, 'truce');
  assert.strictEqual(M.events(SERVER, { kind: 'left-holiday', userName: 'Sunbather' }).length, 1,
    "Sleeper's truce did not turn into a holiday event");
});

t('changing alliance and gaining a city are each noticed', () => {
  M.applySweep({ server: SERVER, sweepId: 7, at: T0 + 360000, byName: sweepOf({
    Ragnar: [city(1001, { allianceName: 'Bears', prestige: 5600 }), city(1002, { allianceName: 'Bears', prestige: 5600 }),
      city(1003, { allianceName: 'Bears', prestige: 5600 })],
  }) });
  const al = M.events(SERVER, { kind: 'alliance' });
  assert.strictEqual(al.length, 1);
  assert.match(al[0].detail, /joined Bears/);
  const ct = M.events(SERVER, { kind: 'cities' });
  assert.strictEqual(ct.length, 1);
  assert.match(ct[0].detail, /gained a city/);
  assert.strictEqual(M.searchPlayers(SERVER, { q: 'Ragnar' }).rows[0].cities, 3);
});

t('a part sweep does not rewrite a city count it could not have seen in full', () => {
  M.applySweep({ server: SERVER, sweepId: 8, at: T0 + 420000, full: false,
    byName: sweepOf({ Ragnar: [city(1001, { allianceName: 'Bears', prestige: 5600 })] }) });
  assert.strictEqual(M.searchPlayers(SERVER, { q: 'Ragnar' }).rows[0].cities, 3, 'still 3, not 1');
  assert.strictEqual(M.events(SERVER, { kind: 'cities' }).length, 1, 'and no false "lost a city"');
});

// ======================================================================= 3
section('who is not moving');

t('a lord whose prestige has stood still is called still', () => {
  const still = M.searchPlayers(SERVER, { moving: 'still', stallMin: 30, watch: false });
  const names = still.rows.map((r) => r.userName);
  assert.ok(names.includes('Sleeper'), 'Sleeper has not moved prestige for hours');
});

t('a lord on holiday is NEVER called still — they cannot move prestige at all', () => {
  const names = M.searchPlayers(SERVER, { moving: 'still', stallMin: 30 }).rows.map((r) => r.userName);
  assert.ok(!names.includes('Sunbather'), 'the holidayed lord is left out');
  assert.strictEqual(M.stalled(SERVER, { stallMin: 30, watchOnly: false }).find((r) => r.userName === 'Sunbather'), undefined);
});

t('stalled() answers with how long each has been still', () => {
  const rows = M.stalled(SERVER, { stallMin: 30, watchOnly: false });
  const s = rows.find((r) => r.userName === 'Sleeper');
  assert.ok(s && s.stillMin >= 300, 'about six hours: ' + (s && s.stillMin));
});

// ======================================================================= 4
section('searching');

t('cities by alliance, by lord, by state and by level', () => {
  assert.strictEqual(M.searchCities(SERVER, { alliance: 'Bears' }).total, 4);
  assert.strictEqual(M.searchCities(SERVER, { lord: 'Ragnar' }).total, 3);
  assert.strictEqual(M.searchCities(SERVER, { state: 5 }).total, 1);
  assert.strictEqual(M.searchCities(SERVER, { level: 8 }).total, 5);
  assert.strictEqual(M.searchCities(SERVER, { level: 9 }).total, 0);
  assert.strictEqual(M.searchCities(SERVER, { minPrestige: 10000 }).total, 1);
});

t('a city search says where each one is', () => {
  const c = M.searchCities(SERVER, { lord: 'Sunbather' }).rows[0];
  assert.strictEqual(c.x, 3001 % 800);
  assert.strictEqual(c.y, Math.floor(3001 / 800));
  assert.strictEqual(c.stateName, 'holiday');
});

t('lords by alliance and by state', () => {
  assert.strictEqual(M.searchPlayers(SERVER, { alliance: 'Wolves' }).total, 1);
  assert.strictEqual(M.searchPlayers(SERVER, { state: 5 }).total, 1);
});

// The alliance picker (the Director's Cities, Lords and Changes views). It lives
// on its own server id so the counts here cannot be moved by a later sweep.
const ALLYS = 'ss-ally';
t('every alliance is listed, with how many lords fly it', () => {
  M.applySweep({ server: ALLYS, sweepId: 1, at: Date.now() - 600000, byName: sweepOf({
    Big1: [city(1001, { allianceName: 'NEAT', prestige: 10 })],
    Big2: [city(1002, { allianceName: 'NEAT', prestige: 20 }), city(1003, { allianceName: 'NEAT', prestige: 20 })],
    Small: [city(2001, { allianceName: 'Ravens', prestige: 30 })],
    Loner: [city(3001, { prestige: 40 })],
  }) });
  const rows = M.alliances(ALLYS);
  assert.deepStrictEqual(rows.map((a) => [a.name, a.lords]), [['NEAT', 2], ['', 1], ['Ravens', 1]],
    'biggest first, and "no alliance" is a row of its own');
  assert.strictEqual(rows[0].cities, 3, 'and how many cities they hold between them');
});

t('an alliance can be kept or hidden, in the lords and in the cities', () => {
  const lords = (o) => M.searchPlayers(ALLYS, o).rows.map((r) => r.userName).sort();
  assert.deepStrictEqual(lords({ allies: ['NEAT'] }), ['Big1', 'Big2']);
  assert.deepStrictEqual(lords({ notAllies: ['NEAT'] }), ['Loner', 'Small'],
    'the lord in NO alliance survives the exclusion — NOT (NULL IN (...)) would have dropped them');
  assert.deepStrictEqual(lords({ allies: ['neat'] }), ['Big1', 'Big2'], 'cased however the picker sends it');
  assert.deepStrictEqual(lords({ notAllies: ['NEAT', ''] }), ['Small'], "'' hides the lords in no alliance");
  assert.deepStrictEqual(lords({ allies: [''] }), ['Loner']);
  assert.deepStrictEqual(lords({}).length, 4, 'and an empty list filters nothing at all');
  assert.strictEqual(M.searchCities(ALLYS, { notAllies: ['NEAT'] }).total, 2);
  assert.strictEqual(M.searchCities(ALLYS, { allies: ['NEAT', 'Ravens'] }).total, 4);
});

t('the changes feed hides an alliance too, through the lord it is about', () => {
  const at = Date.now();
  for (const [who, kind] of [['Big1', 'stalled'], ['Small', 'stalled'], ['Loner', 'stalled'], ['Ghost', 'stalled']]) {
    D.run('INSERT INTO mon_event (server, at, userName, kind, detail, watch) VALUES (?,?,?,?,?,0)',
      ALLYS, at, who, kind, who + ' has not moved prestige for 45 min');
  }
  const feed = (o) => M.eventPage(ALLYS, o).rows.map((e) => e.userName).sort();
  assert.deepStrictEqual(feed({}), ['Big1', 'Ghost', 'Loner', 'Small']);
  assert.deepStrictEqual(feed({ notAllies: ['NEAT'] }), ['Ghost', 'Loner', 'Small'],
    'and a lord the map has never seen is in no alliance, so they stay');
  assert.deepStrictEqual(feed({ allies: ['NEAT'] }), ['Big1']);
  assert.deepStrictEqual(feed({ notAllies: ['NEAT', ''] }), ['Ghost', 'Small'], 'Ghost has no mon_player row at all');
  assert.strictEqual(M.eventPage(ALLYS, { notAllies: ['NEAT'] }).total, 3, 'the total counts the same rows');
  // the filter stacks with everything else the table already had
  assert.deepStrictEqual(feed({ notAllies: ['NEAT'], q: 'Small' }), ['Small']);
});

t('the ranked lists filter a column at a time', () => {
  const rows = [
    ['players', 1, { rank: 1, name: 'Ragnar', alliance: 'Bears', title: 'Duke', prestige: 5600, honor: 10, cities: 3, population: 900 }],
    ['players', 2, { rank: 2, name: 'Sleeper', alliance: 'Wolves', title: 'Baron', prestige: 300, honor: 1, cities: 1, population: 50 }],
    ['heroes', 1, { rank: 1, name: 'Bjorn', lord: 'Ragnar', level: 120, politics: 90, attack: 300, intel: 80 }],
    ['heroes', 2, { rank: 2, name: 'Ivar', lord: 'Ragnar', level: 110, politics: 70, attack: 280, intel: 60 }],
    ['heroes', 3, { rank: 3, name: 'Floki', lord: 'Sunbather', level: 100, politics: 60, attack: 200, intel: 99 }],
    ['cities', 1, { rank: 1, name: 'Kattegat', level: 10, lord: 'Ragnar', alliance: 'Bears', population: 900 }],
    ['cities', 2, { rank: 2, name: 'Hedeby', level: 8, lord: 'Sleeper', alliance: 'Wolves', population: 50 }],
  ];
  for (const [kind, pos, r] of rows) {
    const cols = Object.keys(r).filter((k) => k !== 'rank');
    D.run(`INSERT OR REPLACE INTO stat_${kind} (server, pos, rank, ${cols.join(',')}, at)
      VALUES (?,?,?,${cols.map(() => '?').join(',')},?)`, SERVER, pos, r.rank, ...cols.map((c) => r[c]), Date.now());
  }
  // every player in one alliance
  assert.strictEqual(M.searchStats(SERVER, 'players', { filters: { alliance: 'Wolves' } }).total, 1);
  // every hero of one lord
  const h = M.searchStats(SERVER, 'heroes', { filters: { lord: 'Ragnar' } });
  assert.strictEqual(h.total, 2);
  assert.deepStrictEqual(h.rows.map((x) => x.name), ['Bjorn', 'Ivar']);
  // heroes above a level
  assert.strictEqual(M.searchStats(SERVER, 'heroes', { filters: { level: { min: 115 } } }).total, 1);
  // cities of a level, and of an alliance
  assert.strictEqual(M.searchStats(SERVER, 'cities', { filters: { level: 10 } }).total, 1);
  assert.strictEqual(M.searchStats(SERVER, 'cities', { filters: { alliance: 'Wolves' } }).total, 1);
  // a filter a list does not have is ignored rather than emptying it
  assert.strictEqual(M.searchStats(SERVER, 'players', { filters: { nosuchcolumn: 'x' } }).total, 2);
});

// ======================================================================= 5
section('the watch list');

t('the top N heroes become their lords, deduplicated', () => {
  const list = M.watchList(SERVER, { watchTop: 2, watchNames: [] });
  assert.deepStrictEqual(list.map((w) => w.userName), ['Ragnar'], 'both top heroes are Ragnar\'s');
  const three = M.watchList(SERVER, { watchTop: 3, watchNames: [] });
  assert.deepStrictEqual(three.map((w) => w.userName), ['Ragnar', 'Sunbather']);
  assert.match(three[0].why, /Bjorn/);
});

t('names you add are watched whatever they rank', () => {
  const list = M.watchList(SERVER, { watchTop: 1, watchNames: ['Sleeper'] });
  assert.deepStrictEqual(list.map((w) => w.userName), ['Ragnar', 'Sleeper']);
  assert.strictEqual(list[1].why, 'named by you');
});

t('marking the watch list clears whoever was on it before', () => {
  M.setWatched(SERVER, [{ userName: 'Ragnar', why: 'one' }, { userName: 'Sleeper', why: 'two' }]);
  assert.strictEqual(M.searchPlayers(SERVER, { watch: true }).total, 2);
  M.setWatched(SERVER, [{ userName: 'Ragnar', why: 'one' }]);
  assert.strictEqual(M.searchPlayers(SERVER, { watch: true }).total, 1);
});

t('a watched lord that stops moving is called out once, then again when it moves', () => {
  const cfg = { stallMin: 60 };
  const base = Date.now();
  M.setWatched(SERVER, [{ userName: 'Quiet', why: 'test' }]);
  // first reading: nothing to compare with
  M.recordWatched(SERVER, { userName: 'Quiet', prestige: 1000, castleCount: 4, alliance: 'Bears' }, base - 5 * 3600000, cfg);
  // still the same five hours later: one "stopped moving"
  let n = M.recordWatched(SERVER, { userName: 'Quiet', prestige: 1000, castleCount: 4, alliance: 'Bears' }, base, cfg);
  assert.strictEqual(n, 1);
  assert.strictEqual(M.events(SERVER, { kind: 'stalled', userName: 'Quiet' }).length, 1);
  // and again a moment later: it is not said twice for the same spell
  n = M.recordWatched(SERVER, { userName: 'Quiet', prestige: 1000, castleCount: 4, alliance: 'Bears' }, base + 60000, cfg);
  assert.strictEqual(n, 0);
  assert.strictEqual(M.events(SERVER, { kind: 'stalled', userName: 'Quiet' }).length, 1);
  // it moves: "moving again"
  n = M.recordWatched(SERVER, { userName: 'Quiet', prestige: 1900, castleCount: 4, alliance: 'Bears' }, base + 120000, cfg);
  assert.strictEqual(n, 1);
  const mv = M.events(SERVER, { kind: 'moving', userName: 'Quiet' });
  assert.strictEqual(mv.length, 1);
  assert.match(mv[0].detail, /\+900 prestige/);
});

t('the watch pass keeps lastLoginTime, rank and population', () => {
  const at = Date.now();
  const login = at - 3 * 3600000;
  M.recordWatched(SERVER, { userName: 'Quiet', prestige: 1900, castleCount: 4, alliance: 'Bears',
    ranking: 12, population: 4321, lastLoginTime: login, titleId: 7 }, at, { stallMin: 60 });
  const p = M.searchPlayers(SERVER, { q: 'Quiet' }).rows[0];
  assert.strictEqual(p.rank, 12);
  assert.strictEqual(p.population, 4321);
  assert.strictEqual(p.lastLoginTime, login);
});

// ======================================================================= 6
section('a whole-world sweep, driven against a stub console');

// The stub console above answers whatever the Monitor asks it, so it can never
// notice that a REAL console has no such route. That is exactly what happened:
// auth.js let /api/mapsweep and /api/players through the internal token and
// session.js had both implementations, but server.js never routed either, so
// every map sweep and every watch pass came back "404 with something that is not
// JSON" while the rankings (a route that did exist) worked (2026-09-25). This
// reads the two sources instead of the stub, and fails if they part company
// again.
t('every route auth.js opens to the internal token is one server.js actually has', () => {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const guard = fs.readFileSync(path.join(__dirname, 'auth.js'), 'utf8');
  const list = /const INTERNAL_OK = new Set\(\[([^\]]*)\]/.exec(guard);
  assert.ok(list, 'auth.js still names its internal routes in one INTERNAL_OK set');
  const paths = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(paths.includes('/api/mapsweep') && paths.includes('/api/players'), paths.join(' '));
  for (const route of paths) {
    assert.ok(src.includes(`'${route}'`), `auth.js opens ${route} but server.js has no route for it`);
  }
});

// The two the Monitor lives on, in the shape it asks for them: a POST carrying
// the internal token, answered off the session rather than by a fresh login.
t('the sweep routes are a POST, internal-token only, and never connect()', () => {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  for (const [route, call] of [['/api/mapsweep', 'SESSION.mapSweep'], ['/api/players', 'SESSION.playerInfo']]) {
    const at = src.indexOf(`url.pathname === '${route}'`);
    assert.ok(at > 0, `no ${route} route`);
    const block = src.slice(at, src.indexOf('\n  }', at));
    assert.match(block, /req\.method === 'POST'/, `${route} must be a POST`);
    assert.match(block, /AUTH\.isInternal\(req\)/, `${route} must be internal-token only`);
    assert.ok(block.includes(call), `${route} must answer through ${call}`);
    assert.ok(!block.includes('SESSION.connect('), `${route} must not log in — a second login kicks the console`);
  }
});

t('the console is reached, and refused when it is running another account', async () => {
  const ok = await M.reachConsole(ORG, ACC.id);
  assert.ok(!ok.error, ok.error);
  assert.strictEqual(ok.url, `http://127.0.0.1:${STUB_PORT}`);
  const bad = await M.reachConsole(ORG, 'nope');
  assert.match(bad.error, /no console is registered/);
});

t('a sweep asks for all 1,600 blocks and records what came back', async () => {
  D.run('DELETE FROM mon_city WHERE server = ?', SERVER);
  D.run('DELETE FROM mon_player WHERE server = ?', SERVER);
  D.run('DELETE FROM mon_event WHERE server = ?', SERVER);
  HITS.mapsweep = 0;
  CASTLES = [
    { id: 4001, x: 1, y: 5, name: 'Far', userName: 'Stranger', allianceName: 'Ravens', prestige: 42, honor: 0, state: 1, level: 6 },
    { id: 4002, x: 2, y: 5, name: 'Away', userName: 'Stranger', allianceName: 'Ravens', prestige: 42, honor: 0, state: 1, level: 6 },
  ];
  const r = await M.mapSweep({ org: ORG, server: SERVER, accountId: ACC.id,
    cfg: { ...M.DEFAULTS, blocksPerCall: 180, pauseMs: 0 } });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.got, M.BLOCKS, 'every block answered');
  assert.strictEqual(HITS.mapsweep, Math.ceil(M.BLOCKS / 180));
  assert.strictEqual(r.castles, 2);
  assert.strictEqual(M.searchCities(SERVER, { lord: 'Stranger' }).total, 2);
  assert.strictEqual(M.searchPlayers(SERVER, { q: 'Stranger' }).rows[0].cities, 2);
});

t('a console that has fallen over ends the sweep instead of grinding through it', async () => {
  FAIL = 'not connected';
  HITS.mapsweep = 0;
  const r = await M.mapSweep({ org: ORG, server: SERVER, accountId: ACC.id,
    cfg: { ...M.DEFAULTS, blocksPerCall: 180, pauseMs: 0 } });
  FAIL = null;
  assert.strictEqual(r.error, 'not connected');
  assert.ok(HITS.mapsweep <= 5, 'gave up early, tried ' + HITS.mapsweep);
  const last = M.sweeps(SERVER, 1)[0];
  assert.strictEqual(last.error, 'not connected');
  assert.ok(last.endedAt, 'the sweep row is closed, not left open');
});

t('a watch pass asks the console for each lord by name', async () => {
  PLAYERS = [{ userName: 'Stranger', prestige: 999, castleCount: 2, alliance: 'Ravens', ranking: 5, population: 100, lastLoginTime: Date.now() }];
  M.setWatched(SERVER, []);
  const r = await M.watchPass({ org: ORG, server: SERVER, accountId: ACC.id,
    cfg: { ...M.DEFAULTS, watchTop: 0, watchNames: ['Stranger'], pauseMs: 0 } });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.got, 1);
  assert.strictEqual(M.searchPlayers(SERVER, { q: 'Stranger' }).rows[0].prestige, 999);
});

t('the rankings pass asks the console to refresh and waits for it', async () => {
  HITS.refresh = 0;
  const r = await M.statsPass({ org: ORG, server: SERVER, accountId: ACC.id });
  assert.ok(!r.error, r.error);
  assert.strictEqual(HITS.refresh, 1);
});

// ======================================================================= 7
section('the Director\'s Monitor API');

t('the Director is up and the Monitor is off to begin with', async () => {
  await until(async () => (await call('GET', '/api/monitor')).status === 200, 8000, 'the Director');
  const r = await get('/api/monitor');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.config.on, false);
  assert.strictEqual(r.blocks, 1600);
  assert.ok(r.accounts.find((a) => a.id === ACC.id).consoleUrl, 'the account has a console to read through');
});

t('an account with no console cannot be chosen — the Monitor never logs in', async () => {
  const other = ORG.accounts.upsert({ label: 'Lonely', server: SERVER, pos: 2, email: 'l@example.com' });
  const r = await post('/api/monitor/config', { account: other.id });
  assert.strictEqual(r.json.ok, false);
  assert.match(r.json.error, /no console running/);
  ORG.accounts.remove ? ORG.accounts.remove(other.id) : null;
});

t('choosing the account and the schedule saves', async () => {
  let r = await post('/api/monitor/config', { account: ACC.id });
  assert.strictEqual(r.json.ok, true, r.body);
  r = await post('/api/monitor/config', { mapMin: 7, statsMin: 20, watchTop: 25, stallMin: 90, watchNames: 'Alpha\nBeta, Gamma' });
  assert.strictEqual(r.json.config.mapMin, 7);
  assert.strictEqual(r.json.config.statsMin, 20);
  assert.strictEqual(r.json.config.watchTop, 25);
  assert.strictEqual(r.json.config.stallMin, 90);
  assert.deepStrictEqual(r.json.config.watchNames, ['Alpha', 'Beta', 'Gamma']);
});

t('a silly schedule is pulled back into range rather than taken', async () => {
  const r = await post('/api/monitor/config', { mapMin: 0, pauseMs: 999999, blocksPerCall: 1 });
  assert.strictEqual(r.json.config.mapMin, 2);
  assert.strictEqual(r.json.config.pauseMs, 5000);
  assert.strictEqual(r.json.config.blocksPerCall, 9);
  await post('/api/monitor/config', { mapMin: 10, pauseMs: 0, blocksPerCall: 180, watchNames: '' });
});

t('Start spawns the Monitor on a REAL org id, and Stop takes it down', async () => {
  // It once went out as `--org undefined` (the tenant handle calls itself orgId,
  // not id), and the process then read an empty org's settings and did nothing
  // for ever while the page said "running". Check the argument, not just the pid.
  let r = await post('/api/monitor/switch', { on: true });
  assert.strictEqual(r.json.ok, true, r.body);
  assert.ok(r.json.pid, 'a pid came back');
  const args = await new Promise((res) => {
    require('child_process').execFile('powershell.exe', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${r.json.pid}").CommandLine`],
    { timeout: 20000 }, (e, out) => res(String(out || '')));
  });
  if (args.trim()) {
    assert.match(args, /monitor\.js/, 'it really is monitor.js');
    assert.ok(!/--org\s+undefined/.test(args), 'the org id is a real one, not "undefined": ' + args.trim());
    const got = (args.match(/--org\s+(\S+)/) || [])[1];
    assert.strictEqual(got, ORG.orgId, 'and it is THIS org, not ' + got);
  }
  assert.strictEqual((await get('/api/monitor')).config.on, true);
  r = await post('/api/monitor/switch', { on: false });
  assert.strictEqual(r.json.ok, true, r.body);
  assert.strictEqual((await get('/api/monitor')).config.on, false);
});

t('the searches answer over HTTP', async () => {
  const cities = await get('/api/monitor/cities?lord=Stranger');
  assert.strictEqual(cities.total, 2);
  const players = await get('/api/monitor/players?q=Stranger');
  assert.strictEqual(players.rows[0].userName, 'Stranger');
  const stats = await get('/api/monitor/stats?kind=heroes&f_lord=Ragnar');
  assert.strictEqual(stats.total, 2);
  const ev = await get('/api/monitor/events?kind=left-holiday');
  assert.ok(Array.isArray(ev.rows));
});

t('one lord\'s history comes back with their changes', async () => {
  const r = await get('/api/monitor/history?name=Stranger');
  assert.strictEqual(r.ok, true);
  assert.ok(r.rows.length >= 1);
  assert.strictEqual(r.player.userName, 'Stranger');
});

// The Changes table's "Best hero" column. The answer comes out of the rankings
// the stats sweep already collected, so it costs the game nothing, and a lord too
// small to be in that ranking gets nothing rather than a wrong hero.
t('the best hero of a lord is their highest-level RANKED one', () => {
  const best = M.bestHeroes(SERVER, ['Ragnar', 'Sunbather', 'Nobody', '']);
  assert.strictEqual(best.get('ragnar').name, 'Bjorn', 'Bjorn is L120, Ivar L110');
  assert.strictEqual(best.get('ragnar').level, 120);
  assert.strictEqual(best.get('ragnar').attack, 300);
  assert.strictEqual(best.get('sunbather').name, 'Floki');
  assert.ok(!best.has('nobody'), 'a lord with no ranked hero has no answer, not a wrong one');
  assert.strictEqual(M.bestHeroes(SERVER, []).size, 0);
  // the lord is matched however it is cased, as everywhere else in the Monitor
  assert.strictEqual(M.bestHeroes(SERVER, ['RAGNAR']).get('ragnar').name, 'Bjorn');
});

t('every change carries the best hero of its lord', async () => {
  // a change of Ragnar's to read back, whatever the sweeps above left behind
  D.run('INSERT INTO mon_event (server, at, userName, kind, detail, watch) VALUES (?,?,?,?,?,0)',
    SERVER, Date.now(), 'Ragnar', 'alliance', 'Ragnar left Bears for Wolves');
  const ev = await get('/api/monitor/events?limit=200');
  const mine = ev.rows.find((e) => e.userName === 'Ragnar');
  assert.ok(mine, 'the change came back');
  assert.strictEqual(mine.hero.name, 'Bjorn');
  assert.strictEqual(mine.hero.level, 120);
  // Stranger is off the map, not out of the hero ranking, so they have none
  const none = ev.rows.find((e) => e.userName === 'Stranger');
  if (none) assert.strictEqual(none.hero, null, 'an unranked lord gets null, not a guess');
});

// "no change for ≥ N h": judged on the lord's last prestige move as of now, and
// never a lord on holiday.
t('the Changes feed narrows to lords still for at least N hours', async () => {
  const at = Date.now();
  D.run(`INSERT OR REPLACE INTO mon_player (server, userName, prestige, prestigeAt, firstSeen, state)
    VALUES (?,?,?,?,?,?)`, SERVER, 'StillLong', 10, at - 30 * 3600000, at - 40 * 3600000, 1);
  D.run(`INSERT OR REPLACE INTO mon_player (server, userName, prestige, prestigeAt, firstSeen, state)
    VALUES (?,?,?,?,?,?)`, SERVER, 'StillShort', 10, at - 2 * 3600000, at - 40 * 3600000, 1);
  D.run(`INSERT OR REPLACE INTO mon_player (server, userName, prestige, prestigeAt, firstSeen, state)
    VALUES (?,?,?,?,?,?)`, SERVER, 'StillAway', 10, at - 30 * 3600000, at - 40 * 3600000, 5);
  for (const nm of ['StillLong', 'StillShort', 'StillAway']) {
    D.run('INSERT INTO mon_event (server, at, userName, kind, detail, watch) VALUES (?,?,?,?,?,0)',
      SERVER, at, nm, 'stalled', `${nm} has not moved prestige for 300 min`);
  }
  const names = (r) => r.rows.map((e) => e.userName).filter((x) => x.startsWith('Still')).sort();
  assert.deepStrictEqual(names(await get('/api/monitor/events?kind=stalled&q=Still')),
    ['StillAway', 'StillLong', 'StillShort'], 'no limit: all three');
  const day = await get(`/api/monitor/events?kind=stalled&q=Still&stillMin=${24 * 60}`);
  assert.deepStrictEqual(names(day), ['StillLong'], 'a day: only the long one, never the holiday one');
  assert.ok(Math.abs(day.rows[0].movedAt - (at - 30 * 3600000)) < 1000, 'and it says when they last moved');
  assert.deepStrictEqual(names(await get('/api/monitor/events?kind=stalled&q=Still&stillMin=60')),
    ['StillLong', 'StillShort'], 'an hour: both that are not on holiday');
});

// Clicking the best hero opens the lord: their best heroes, and every city of
// theirs as a scouting script.
t('one lord comes back with their cities in map order and their best heroes', () => {
  // a second lord whose name STARTS with the first: a LIKE match would swallow them
  M.applySweep({ server: SERVER, sweepId: 91, at: Date.now(),
    byName: sweepOf({
      Ragnar: [city(8100, { x: 30, y: 20, allianceName: 'Bears' }), city(8101, { x: 10, y: 5, allianceName: 'Bears' })],
      Ragnarok: [city(8102, { x: 99, y: 99, allianceName: 'Bears' })],
    }) });
  const r = M.lordSheet(SERVER, 'Ragnar');
  assert.deepStrictEqual(r.cities.map((c) => `${c.x},${c.y}`), ['10,5', '30,20'], 'map reading order, y then x');
  assert.ok(!r.cities.some((c) => c.x === 99), 'Ragnarok is a different lord');
  assert.deepStrictEqual(r.heroes.map((h) => h.name), ['Bjorn', 'Ivar'], 'best first');
  assert.strictEqual(r.heroes[0].level, 120);
  // cased however you like, and capped to the number asked for
  assert.strictEqual(M.lordSheet(SERVER, 'RAGNAR').cities.length, 2);
  assert.strictEqual(M.lordSheet(SERVER, 'Ragnar', { heroes: 1 }).heroes.length, 1);
  // a lord nobody has seen is empty, not an error
  const none = M.lordSheet(SERVER, 'NoSuchLord');
  assert.deepStrictEqual([none.cities.length, none.heroes.length], [0, 0]);
  assert.deepStrictEqual(M.lordSheet(SERVER, '').cities, []);
});

// The Changes TABLE reader: the same rows as events(), searched, sorted on any
// column the table shows, and a page at a time.
t('the changes table searches, sorts and pages', () => {
  const at = Date.now();
  D.run('DELETE FROM mon_event WHERE server = ?', SERVER);
  const add = (ms, who, kind, detail) => D.run(
    'INSERT INTO mon_event (server, at, userName, kind, detail, watch) VALUES (?,?,?,?,?,0)',
    SERVER, at - ms, who, kind, detail);
  add(3000, 'Ragnar', 'alliance', 'Ragnar joined Wolves');      // Bjorn, L120
  add(2000, 'Sunbather', 'stalled', 'Sunbather has not moved prestige for 90 min');  // Floki, L100
  add(1000, 'Nobody', 'cities', 'Nobody gained a city');        // no ranked hero

  const all = M.eventPage(SERVER, {});
  assert.strictEqual(all.total, 3);
  assert.deepStrictEqual(all.rows.map((e) => e.userName), ['Nobody', 'Sunbather', 'Ragnar'], 'newest first');
  assert.strictEqual(all.rows[2].hero.name, 'Bjorn', 'each row carries its best hero');
  assert.strictEqual(all.rows[0].hero, null);

  // the search box reaches the lord AND what was said
  assert.strictEqual(M.eventPage(SERVER, { q: 'Ragnar' }).total, 1);
  assert.strictEqual(M.eventPage(SERVER, { q: 'gained a city' }).total, 1);
  assert.strictEqual(M.eventPage(SERVER, { q: 'joined' }).rows[0].userName, 'Ragnar');
  assert.strictEqual(M.eventPage(SERVER, { q: 'nothing like this' }).total, 0);
  // a % in the box is searched for, not treated as "anything"
  assert.strictEqual(M.eventPage(SERVER, { q: '%' }).total, 0);

  // every column the table shows
  assert.deepStrictEqual(M.eventPage(SERVER, { sort: 'at', dir: 'asc' }).rows.map((e) => e.userName),
    ['Ragnar', 'Sunbather', 'Nobody']);
  assert.deepStrictEqual(M.eventPage(SERVER, { sort: 'userName', dir: 'asc' }).rows.map((e) => e.userName),
    ['Nobody', 'Ragnar', 'Sunbather']);
  assert.deepStrictEqual(M.eventPage(SERVER, { sort: 'kind', dir: 'asc' }).rows.map((e) => e.kind),
    ['alliance', 'cities', 'stalled']);
  // and by the best hero, which sqlite cannot do: a lord with none sorts LAST either way
  assert.deepStrictEqual(M.eventPage(SERVER, { sort: 'hero', dir: 'desc' }).rows.map((e) => e.userName),
    ['Ragnar', 'Sunbather', 'Nobody'], 'L120, then L100, then no hero');
  assert.deepStrictEqual(M.eventPage(SERVER, { sort: 'hero', dir: 'asc' }).rows.map((e) => e.userName),
    ['Sunbather', 'Ragnar', 'Nobody'], 'turned round, but the heroless lord stays at the bottom');
  // a column that is not the table's is ignored rather than injected
  assert.strictEqual(M.eventPage(SERVER, { sort: 'id) --' }).rows.length, 3);

  // a page at a time, with the total of everything that matched
  const p1 = M.eventPage(SERVER, { limit: 2 });
  assert.strictEqual(p1.rows.length, 2);
  assert.strictEqual(p1.total, 3);
  const p2 = M.eventPage(SERVER, { limit: 2, offset: 2 });
  assert.deepStrictEqual([p2.rows.length, p2.offset], [1, 2]);
  assert.strictEqual(p2.rows[0].userName, 'Ragnar');
  // paging works the same when the sort is the one done in here
  assert.strictEqual(M.eventPage(SERVER, { sort: 'hero', limit: 1, offset: 1 }).rows[0].userName, 'Sunbather');

  // events() itself is untouched: still a plain array of the matching rows
  assert.strictEqual(M.events(SERVER, {}).length, 3);

  // one line per lord: a lord who stalled again shows once, the newest, with a count
  add(500, 'sunbather', 'stalled', 'Sunbather has not moved prestige for 50 min');
  const once = M.eventPage(SERVER, {});
  assert.strictEqual(once.total, 3, 'still three lords');
  assert.deepStrictEqual(once.rows.map((e) => e.detail.slice(-6)), ['50 min', 'a city', 'Wolves']);
  assert.strictEqual(once.rows[0].times, 2);
  // the count is of the rows that matched, not of everything the lord ever did
  assert.strictEqual(M.eventPage(SERVER, { q: '90 min' }).rows[0].times, 1);
  assert.strictEqual(M.eventPage(SERVER, { sort: 'hero' }).total, 3);
  assert.strictEqual(M.events(SERVER, {}).length, 4, 'events() still sees every row');
});

// A reading is always kept when the prestige MOVED. Between moves a heartbeat is
// kept too, no oftener than readingEveryMin, so a lord standing still leaves a
// trail rather than one lonely row -- and the heartbeats alone are pruned.
t('a still lord still leaves a trail, and the heartbeats are thrown away when old', () => {
  const base = Date.now() - 10 * 3600000;
  const cfg = { ...M.DEFAULTS, stallMin: 45, readingEveryMin: 60, readingKeepDays: 14 };
  const who = 'Statue';
  D.run('DELETE FROM mon_player WHERE server = ? AND userName = ?', SERVER, who);
  D.run('DELETE FROM mon_player_history WHERE server = ? AND userName = ?', SERVER, who);
  const read = (ms, prestige) => M.recordWatched(SERVER,
    { userName: who, prestige, castleCount: 3, alliance: 'Bears' }, base + ms, cfg);
  const rows = () => D.all('SELECT at, prestige, src FROM mon_player_history WHERE server = ? AND userName = ? ORDER BY at',
    SERVER, who);

  read(0, 5000);                                  // first sight: a row either way
  assert.strictEqual(rows().length, 1);
  read(15 * 60000, 5000);                         // 15 min later, unmoved and too soon
  read(30 * 60000, 5000);
  assert.strictEqual(rows().length, 1, 'no heartbeat inside the hour');
  read(61 * 60000, 5000);                         // past the hour, still unmoved
  assert.strictEqual(rows().length, 2, 'a heartbeat once the hour is up');
  assert.strictEqual(rows()[1].src, 'watch-still', 'marked as a heartbeat, not a move');
  read(70 * 60000, 7000);                         // it moved: kept whatever the clock says
  const after = rows();
  assert.strictEqual(after.length, 3);
  assert.strictEqual(after[2].src, 'watch', 'a move is a move');
  assert.strictEqual(after[2].prestige, 7000);

  // 0 turns the heartbeat off: only moves are kept
  D.run('DELETE FROM mon_player_history WHERE server = ? AND userName = ?', SERVER, who);
  const off = { ...cfg, readingEveryMin: 0 };
  M.recordWatched(SERVER, { userName: who, prestige: 7000, castleCount: 3, alliance: 'Bears' }, base + 200 * 60000, off);
  M.recordWatched(SERVER, { userName: who, prestige: 7000, castleCount: 3, alliance: 'Bears' }, base + 900 * 60000, off);
  assert.strictEqual(rows().length, 0, 'nothing moved and no heartbeat was asked for');

  // the prune takes the old heartbeats and leaves every move alone
  D.run('DELETE FROM mon_player_history WHERE server = ? AND userName = ?', SERVER, who);
  const old = Date.now() - 30 * 86400000;
  D.run("INSERT INTO mon_player_history (server, userName, at, prestige, src) VALUES (?,?,?,?,'watch-still')", SERVER, who, old, 1);
  D.run("INSERT INTO mon_player_history (server, userName, at, prestige, src) VALUES (?,?,?,?,'watch')", SERVER, who, old + 1, 2);
  D.run("INSERT INTO mon_player_history (server, userName, at, prestige, src) VALUES (?,?,?,?,'watch-still')", SERVER, who, Date.now(), 3);
  assert.strictEqual(M.pruneReadings(SERVER, cfg), 1, 'exactly the old heartbeat');
  assert.deepStrictEqual(rows().map((r) => r.prestige), [2, 3], 'the old MOVE is kept for ever');
  D.run('DELETE FROM mon_player_history WHERE server = ? AND userName = ?', SERVER, who);
  D.run('DELETE FROM mon_player WHERE server = ? AND userName = ?', SERVER, who);
});

t('a lord carries every prestige reading, and when it last moved', () => {
  const at = Date.now();
  D.run('DELETE FROM mon_player_history WHERE server = ? AND userName = ?', SERVER, 'Ragnar');
  // three readings: it moved at the middle one and has stood still since
  for (const [ms, p] of [[300 * 60000, 1000], [120 * 60000, 1200], [60 * 60000, 1200]]) {
    D.run('INSERT INTO mon_player_history (server, userName, at, prestige, cities, state) VALUES (?,?,?,?,?,?)',
      SERVER, 'Ragnar', at - ms, p, 2, 1);
  }
  const r = M.lordSheet(SERVER, 'Ragnar');
  assert.deepStrictEqual(r.readings.map((h) => h.prestige), [1200, 1200, 1000], 'newest first');
  assert.deepStrictEqual(r.readings.map((h) => h.moved), [false, true, false],
    'only the reading that differs from the one before it in TIME is a move');
  assert.strictEqual(r.prestige, 1200, 'the latest reading');
  assert.strictEqual(r.movedAt, at - 120 * 60000, 'the moment the standing still began');
  // a lord with one reading has moved never: there is nothing to compare it with
  D.run('DELETE FROM mon_player_history WHERE server = ? AND userName = ?', SERVER, 'Ragnar');
  D.run('INSERT INTO mon_player_history (server, userName, at, prestige) VALUES (?,?,?,?)',
    SERVER, 'Ragnar', at, 500);
  const one = M.lordSheet(SERVER, 'Ragnar');
  assert.deepStrictEqual([one.readings.length, one.readings[0].moved, one.movedAt], [1, false, null]);
});

t('the lord route answers over HTTP, and refuses an empty name', async () => {
  const r = await get('/api/monitor/lord?name=Ragnar');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.userName, 'Ragnar');
  assert.strictEqual(r.cities.length, 2);
  assert.strictEqual(r.heroes[0].name, 'Bjorn');
  const bad = await get('/api/monitor/lord?name=');
  assert.strictEqual(bad.ok, false);
  // take the two of them off the map again: the browser tests below count the
  // rows the Cities and Lords views show, and these were only ever fixtures
  for (const who of ['Ragnar', 'Ragnarok']) {
    D.run('DELETE FROM mon_city WHERE server = ? AND userName = ?', SERVER, who);
    D.run('DELETE FROM mon_player WHERE server = ? AND userName = ?', SERVER, who);
  }
});

// ======================================================================= 8
section('the Monitor tab, in headless Chrome over CDP');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let chrome = null, ws = null, cdpId = 0;
const pending = new Map(), pageErrors = [];
function cdp(method, params = {}) {
  const id = ++cdpId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}
async function ev(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error('page: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  }
  return r.result.value;
}
const browserOff = process.env.SKIP_BROWSER === '1' || !fs.existsSync(CHROME);

t('the tab opens and the Setup view shows the account and the schedule', async () => {
  if (browserOff) return 'skipped';
  const port = 9520 + Math.floor(Math.random() * 40);
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(TMP, 'chrome')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  const list = await until(async () => {
    try {
      return await new Promise((res, rej) => http.get(`http://127.0.0.1:${port}/json/list`,
        (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
    } catch { return null; }
  }, 15000, 'Chrome');
  const page = list.find((x) => x.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(p.method + ': ' + m.error.message)); else p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Network.enable');
  await cdp('Network.setCookie', { name: 'otto_sid', value: SID, url: `http://127.0.0.1:${PORT}/` });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await until(() => ev(`!!document.querySelector('.tab[data-p="monitor"]')`), 15000, 'the Monitor tab');
  await ev(`document.querySelector('.tab[data-p="monitor"]').click()`);
  await until(() => ev(`!$('#pageMonitor').hidden`), 8000, 'the Monitor page');
  await until(() => ev(`$('#monAcc').options.length > 1`), 8000, 'the account list');
  assert.strictEqual(await ev(`$('#monAcc').value`), ACC.id);
  assert.strictEqual(await ev(`$('#cfgMapMin').value`), '10');
  assert.strictEqual(await ev(`$('#monSwitch').textContent`), 'Start');
});

t('the cards say when each pass last ran', async () => {
  if (browserOff) return 'skipped';
  await until(() => ev(`document.querySelectorAll('#monCards .mon-card').length === 5`), 8000, 'the cards');
  const text = await ev(`$('#monCards').textContent`);
  assert.match(text, /Map sweep/);
  assert.match(text, /lords/);
});

t('the Statistics view lists a ranked list and filters it by column', async () => {
  if (browserOff) return 'skipped';
  await ev(`document.querySelector('#monSub [data-s="stats"]').click()`);
  await until(() => ev(`document.querySelectorAll('#msTbl tbody tr').length >= 2`), 8000, 'the players list');
  assert.strictEqual(await ev(`document.querySelectorAll('#msTbl tbody tr').length`), 2);
  // switch to heroes and filter by lord
  await ev(`document.querySelector('#msKind [data-k="heroes"]').click()`);
  await until(() => ev(`document.querySelectorAll('#msTbl tbody tr').length === 3`), 8000, 'three heroes');
  await ev(`(() => { const i = document.querySelector('#msFilters [data-f="lord"]'); i.value = 'Ragnar';
    i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await until(() => ev(`document.querySelectorAll('#msTbl tbody tr').length === 2`), 8000, 'Ragnar\'s two heroes');
  assert.match(await ev(`$('#msTbl').textContent`), /Bjorn/);
});

t('the Cities view shows where each city is and what state its lord is in', async () => {
  if (browserOff) return 'skipped';
  await ev(`document.querySelector('#monSub [data-s="cities"]').click()`);
  await until(() => ev(`document.querySelectorAll('#mcTbl tbody tr').length === 2`), 8000, 'the two cities');
  const text = await ev(`$('#mcTbl').textContent`);
  assert.match(text, /Stranger/);
  assert.match(text, /1,5/, 'the coordinates');
});

t('the Lords view marks who is not moving, and never a holiday', async () => {
  if (browserOff) return 'skipped';
  // put the three original lords back so there is something to judge
  M.applySweep({ server: SERVER, sweepId: 20, at: Date.now() - 4 * 3600000, byName: sweepOf({
    Dozer: [city(5001, { allianceName: 'Wolves', prestige: 700 })],
    Beachy: [city(6001, { allianceName: 'Wolves', prestige: 800, state: 5 })],
  }) });
  await ev(`document.querySelector('#monSub [data-s="lords"]').click()`);
  await until(() => ev(`document.querySelectorAll('#mlTbl tbody tr').length >= 3`), 8000, 'the lords');
  await ev(`document.querySelector('#mlMoving [data-m="still"]').click()`);
  // the "everyone" render has Dozer in it too, so wait for the render that has
  // dropped every holiday row rather than for a name both of them show
  await until(() => ev(`(() => { const rows = [...document.querySelectorAll('#mlTbl tbody tr')];
    return rows.length > 0 && rows.every((r) => !r.textContent.includes('holiday'))
      && rows.some((r) => r.textContent.includes('Dozer')); })()`), 8000, 'the still-only render');
  assert.ok(!(await ev(`$('#mlTbl').textContent`)).includes('Beachy'), 'the holidayed lord is not called still');
});

t('the Changes view lists what moved, in words', async () => {
  if (browserOff) return 'skipped';
  // a lord who goes on holiday and comes back off it again
  M.applySweep({ server: SERVER, sweepId: 21, at: Date.now() - 7200000,
    byName: sweepOf({ Returner: [city(7001, { allianceName: 'Ravens', prestige: 1234, state: 5 })] }) });
  for (const at of [Date.now() - 120000, Date.now() - 60000]) {
    M.applySweep({ server: SERVER, sweepId: 22, at,
      byName: sweepOf({ Returner: [city(7001, { allianceName: 'Ravens', prestige: 1234, state: 1 })] }) });
  }
  assert.strictEqual(M.events(SERVER, { kind: 'left-holiday' }).length, 1);
  await ev(`document.querySelector('#monSub [data-s="events"]').click()`);
  await until(() => ev(`document.querySelectorAll('#meTbl tbody tr').length >= 1`), 8000, 'the changes');
  await ev(`document.querySelector('#meKind [data-k="left-holiday"]').click()`);
  await until(() => ev(`$('#meTbl').textContent.includes('came off holiday')`), 8000, 'the holiday change');
  // the Best hero column: a header, and a dash for Returner, who holds no ranked hero
  assert.ok(await ev(`$('#meTbl').textContent.includes('Best hero')`), 'the column is there');
  assert.strictEqual(await ev(`document.querySelectorAll('#meTbl thead th').length`), 6);
  assert.ok(await ev(`document.querySelector('#meTbl tbody tr').children[2].textContent.trim() === '—'`),
    'an unranked lord shows a dash');
  // and Ragnar, who holds Bjorn, shows him with his level and attack
  await ev(`document.querySelector('#meKind [data-k=""]').click()`);
  await until(() => ev(`$('#meTbl').textContent.includes('Bjorn')`), 8000, 'the best hero');
  assert.ok(await ev(`$('#meTbl').textContent.includes('L120')`), 'with its level');
});

t('the Changes table sorts by a header and narrows to the search box', async () => {
  if (browserOff) return 'skipped';
  await ev(`document.querySelector('#monSub [data-s=\"events\"]').click()`);
  await ev(`document.querySelector('#meKind [data-k=\"\"]').click()`);
  await until(() => ev(`document.querySelectorAll('#meTbl tbody tr').length >= 2`), 8000, 'the changes');
  // every column the table shows is a sort, and the one sorting says which way
  assert.strictEqual(await ev(`document.querySelectorAll('#meTbl thead th[data-s]').length`), 5);
  const lords = () => ev(`[...document.querySelectorAll('#meTbl tbody tr')].map((r) => r.children[1].textContent)`);
  await ev(`document.querySelector('#meTbl thead th[data-s=\"userName\"]').click()`);
  await until(async () => {
    const l = await lords();
    return l.length > 1 && l.join('|') === [...l].sort().reverse().join('|');
  }, 8000, 'sorted by lord, Z to A');
  assert.ok((await ev(`$('#meTbl').textContent`)).includes('▼'), 'the header shows the direction');
  // clicking it again turns it round
  await ev(`document.querySelector('#meTbl thead th[data-s=\"userName\"]').click()`);
  await until(async () => {
    const l = await lords();
    return l.length > 1 && l.join('|') === [...l].sort().join('|');
  }, 8000, 'sorted by lord, A to Z');
  // the search box narrows it to one lord
  const one = (await lords())[0];
  await ev(`(() => { const b = $('#meQ'); b.value = ${JSON.stringify(one)};
    b.dispatchEvent(new Event('input')); })()`);
  await until(async () => {
    const l = await lords();
    return l.length > 0 && l.every((x) => x === one);
  }, 8000, 'narrowed to ' + one);
  await ev(`(() => { const b = $('#meQ'); b.value = ''; b.dispatchEvent(new Event('input')); })()`);
  await until(() => ev(`document.querySelectorAll('#meTbl tbody tr').length >= 2`), 8000, 'the changes back');
  await ev(`document.querySelector('#meTbl thead th[data-s=\"at\"]').click()`);
});

// The alliance picker: a dropdown with a search box in it, listing every alliance
// the map has seen, each one kept or hidden. Hiding is what it is for — the feed
// is mostly the same big alliances shuffling about, and hiding them leaves what
// the user is actually watching for.
t('the alliance picker hides a whole alliance from the Changes feed', async () => {
  if (browserOff) return 'skipped';
  await ev(`document.querySelector('#monSub [data-s=\"events\"]').click()`);
  await ev(`document.querySelector('#meKind [data-k=\"\"]').click()`);
  await until(() => ev(`document.querySelectorAll('#meTbl tbody tr').length >= 3`), 8000, 'the whole feed');
  const lords = () => ev(`[...document.querySelectorAll('#meTbl tbody tr')].map((r) => r.children[1].textContent)`);
  assert.ok((await lords()).includes('Returner'), 'Returner is in Ravens and in the feed');

  // it opens with every alliance the map has seen, each with how many lords fly it
  await ev(`$('#meAlly').querySelector('.ally-btn').click()`);
  await until(() => ev(`$('#meAlly').querySelectorAll('.ally-list label').length >= 2`), 8000, 'the alliance list');
  assert.match(await ev(`$('#meAlly').querySelector('.ally-list').textContent`), /Ravens/);
  assert.match(await ev(`$('#meAlly').querySelector('.ally-list').textContent`), /lord/, 'with its size');
  // the search box inside it narrows the list
  await ev(`(() => { const b = $('#meAlly').querySelector('.ally-find'); b.value = 'rav';
    b.dispatchEvent(new Event('input')); })()`);
  await until(() => ev(`$('#meAlly').querySelectorAll('.ally-list label').length === 1`), 4000, 'just Ravens');
  assert.match(await ev(`$('#meAlly').querySelector('.ally-list').textContent`), /Ravens/);

  // tick it, and every lord of that alliance leaves the feed
  await ev(`(() => { const b = $('#meAlly').querySelector('[data-name=\"Ravens\"]');
    b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(async () => {
    const l = await lords();
    return l.length > 0 && !l.includes('Returner');
  }, 8000, 'the Ravens rows gone');
  assert.ok((await lords()).includes('Nobody'), 'a lord the map has never seen is in no alliance, so they stay');
  assert.match(await ev(`$('#meAlly').querySelector('.ally-btn').textContent`), /Hiding Ravens/);
  // and the choice is remembered, so a feed cleaned up once opens clean
  assert.match(await ev(`localStorage.getItem('dir_ally_meAlly')`), /Ravens/);

  // "only these" turns it round
  await ev(`$('#meAlly').querySelector('[data-mode=\"only\"]').click()`);
  await until(async () => {
    const l = await lords();
    return l.length > 0 && l.every((x) => x === 'Returner');
  }, 8000, 'only the Ravens rows');
  // Show all puts the feed back, and the button says so
  await ev(`$('#meAlly').querySelector('.ally-clear').click()`);
  await until(async () => (await lords()).includes('Nobody'), 8000, 'the whole feed back');
  assert.strictEqual(await ev(`$('#meAlly').querySelector('.ally-btn').textContent`), 'Alliances: all');
  await ev(`$('#meAlly').querySelector('.ally-done').click()`);
  assert.strictEqual(await ev(`$('#meAlly').querySelector('.ally-pop').hidden`), true, 'Done closes it');
});

t('clicking the best hero opens the lord, with a scouting script for every city', async () => {
  if (browserOff) return 'skipped';
  // three prestige readings of Ragnar's, moving once and then standing still
  D.run('DELETE FROM mon_player_history WHERE server = ? AND userName = ?', SERVER, 'Ragnar');
  for (const [mins, p] of [[300, 1000], [120, 1200], [60, 1200]]) {
    D.run('INSERT INTO mon_player_history (server, userName, at, prestige, cities, state) VALUES (?,?,?,?,?,?)',
      SERVER, 'Ragnar', Date.now() - mins * 60000, p, 2, 1);
  }
  // two cities for Ragnar, so the script has an array and a repeat count
  M.applySweep({ server: SERVER, sweepId: 92, at: Date.now(),
    byName: sweepOf({ Ragnar: [city(8200, { x: 30, y: 20, allianceName: 'Bears' }),
      city(8201, { x: 10, y: 5, allianceName: 'Bears' })] }) });
  await ev(`document.querySelector('#monSub [data-s=\"events\"]').click()`);
  await ev(`document.querySelector('#meKind [data-k=\"\"]').click()`);
  await until(() => ev(`!!document.querySelector('[data-hero-lord]')`), 8000, 'a best hero to click');
  await ev(`document.querySelector('[data-hero-lord=\"Ragnar\"]').click()`);
  await until(() => ev(`$('#lordDlg').open`), 8000, 'the lord dialog');
  // their heroes, best first
  assert.match(await ev(`$('#ldHeroes').textContent`), /Bjorn/);
  // and the script: the array in map order, one scout a city, counted in total
  const script = await ev(`$('#ldScript').value`);
  assert.strictEqual(script,
    'a = [\"10,5\", \"30,20\"]\nscout {a.shift()} any s:100k\nrepeat 2');
  // the script the page writes must be one the script language actually takes
  const parsed = require('./script').parse(script);
  assert.deepStrictEqual(parsed.map((a) => a.cmd), ['assign', 'scout', 'repeat']);
  assert.ok(!parsed.some((a) => a.error), 'it parses clean');
  // and the prestige readings, newest first, with the one that moved marked
  const rd = await ev(`[...document.querySelectorAll('#ldReadings tbody tr')].map((r) => r.children[0].textContent + ' ' + r.children[1].textContent)`);
  assert.ok(rd.length >= 3, 'the readings are listed, got ' + rd.length);
  assert.ok(/^\d\d\/\d\d \d\d:\d\d /.test(rd[0]), 'stamped 09/24 18:18, got ' + rd[0]);
  // which readings moved is the unit test's job above; here it is that they are marked
  // at all. The sweep this test just applied is itself a reading, so there is more than one.
  assert.ok(rd.some((x) => x.includes('▲')), 'a reading that moved is marked');
  assert.ok(rd.some((x) => !x.includes('▲')), 'and one that did not is not');
  assert.ok((await ev(`$('#ldHead').textContent`)).includes('last moved at'), 'and when it stopped');
  await ev(`$('#ldClose').click()`);
  for (const id of [8200, 8201]) D.run('DELETE FROM mon_city WHERE server = ? AND fieldId = ?', SERVER, id);
  D.run('DELETE FROM mon_player WHERE server = ? AND userName = ?', SERVER, 'Ragnar');
});

t('Start asks first, and says what it will and will not do', async () => {
  if (browserOff) return 'skipped';
  await ev(`document.querySelector('#monSub [data-s="setup"]').click()`);
  await until(() => ev(`!$('#monSetup').hidden`), 5000, 'Setup');
  ev(`$('#monSwitch').click()`);                       // not awaited: it opens a modal
  await until(() => ev(`!!document.querySelector('dialog.ask[open]')`), 5000, 'the confirm');
  const text = await ev(`document.querySelector('dialog.ask[open]').textContent`);
  assert.match(text, /logs in to nothing/);
  assert.match(text, /Watcher/);
  await ev(`document.querySelector('dialog.ask[open] button[value="no"]').click()`);
  await sleep(200);
  assert.strictEqual((await get('/api/monitor')).config.on, false, 'cancelled, so still off');
});

(async () => {
  let pass = 0, fail = 0, skipped = 0;
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n); continue; }
    try {
      const r = await f();
      if (r === 'skipped') { console.log('  skip  ' + n); skipped++; } else { console.log('  ok    ' + n); pass++; }
    } catch (e) {
      console.log('  FAIL  ' + n + '\n        ' + String((e && e.message) || e).split('\n').slice(0, 14).join('\n        '));
      fail++;
    }
  }
  if (pageErrors.length) console.log('\n  page exceptions (not failures):\n    ' + [...new Set(pageErrors)].slice(0, 8).join('\n    '));
  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
  try { if (ws) ws.close(); } catch {}
  try { if (chrome) chrome.kill(); } catch {}
  try { stub.close(); } catch {}
  await sleep(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
