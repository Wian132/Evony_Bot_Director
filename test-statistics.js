'use strict';
// statistics.js offline: a fake game answers rank.get*Rank from made-up lists, into a
// throwaway database. Never connects to anything.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const DB = path.join(os.tmpdir(), `otto-stats-${process.pid}.db`);
process.env.EVONY_DB = DB;
process.env.OTTO_STATS_PAUSE_MS = '1';
const ST = require('./statistics');
const eq = (a, b, m) => assert.deepStrictEqual(a, b, m);

// A server holding `lists`: pages of min(pageSize, cap) rows; sortType in `sorts` or refused.
function fakeGame({ lists, cap = 100, sorts = [0, 1, 2], fail = {}, busy = () => 0 }) {
  const sent = [];
  return {
    sent,
    pipeInFlight: busy,
    lane: (cmd, fn) => fn(),
    async req(cmd, d) {
      sent.push({ cmd, ...d });
      const key = `${cmd}:${d.pageNo}`;
      if (fail[key] && fail[key]-- > 0) throw new Error(`no reply to ${cmd}`);
      if (!sorts.includes(d.sortType)) return { ok: -1, errorMsg: 'bad sort' };
      const all = lists[cmd] || [];
      const size = Math.min(d.pageSize, cap);
      const totalPage = Math.max(1, Math.ceil(all.length / size));
      const beans = all.slice((d.pageNo - 1) * size, d.pageNo * size);
      return { ok: 1, pageNo: d.pageNo, pageSize: size, totalPage, beans };
    },
  };
}
const players = (n, pre = 'Lord') => Array.from({ length: n }, (_, i) => ({ ranking: i + 1, userName: `${pre}${i + 1}`,
  alliance: i % 2 ? 'Reds' : 'Blues', titleId: 3, sex: i === 0 ? 1 : 0, prestige: 1e6 - i, honor: i, castleCount: 10, population: 5000 }));
const heroes = (n) => Array.from({ length: n }, (_, i) => ({ rank: i + 1, name: i === 4 ? 'Lord7' : `Hero${i + 1}`, kind: `Lord${(i % 9) + 1}`,
  grade: 300 - i, management: 10, power: 500 + i, stratagem: 20 }));
const alliances = [{ rank: 1, name: 'Reds', playerName: 'Lord2', createrName: 'Lord2', member: 50, city: 400, prestige: 9e6, honor: 1 },
  { rank: 2, name: '50%_off', playerName: 'Lord3', createrName: 'Old', member: 3, city: 9, prestige: 10, honor: 0 }];
const cities = [{ rank: 1, name: 'Capital', level: 10, kind: 'Lord1', alliance: 'Blues', population: 132050 }];
const LISTS = { 'rank.getPlayerRank': players(234), 'rank.getHeroRank': heroes(57), 'rank.getAllianceRank': alliances, 'rank.getCastleRank': cities };

async function ahead() { await new Promise((r) => setTimeout(r, 60)); }
async function done() { while (ST.JOB.running) await new Promise((r) => setTimeout(r, 5)); }
const S1 = 'test1';
const logs = [];
const log = (m) => logs.push(m);

const tests = [
  ['reads all four lists, 100 a page', async () => {
    const g = fakeGame({ lists: LISTS });
    eq(ST.start({ game: g, server: S1, account: 'Tester', log }).ok, true);
    eq(ST.start({ game: g, server: S1, account: 'Tester', log }).ok, false, 'one crawl at a time');
    await done();
    const st = ST.status(S1).lists;
    eq([st.players.rows, st.alliances.rows, st.heroes.rows, st.cities.rows], [234, 2, 57, 1]);
    eq(st.players.state, 'done');
    eq(st.players.pageSize, 100);
    eq(g.sent.filter((s) => s.cmd === 'rank.getPlayerRank').map((s) => s.pageNo), [1, 2, 3]);
    eq(g.sent.find((s) => s.cmd === 'rank.getPlayerRank'), { cmd: 'rank.getPlayerRank', key: null, pageNo: 1, pageSize: 100, sortType: 0 });
    eq(g.sent[0].cmd, 'rank.getAllianceRank', 'the small lists first');
  }],
  ['a server that pages by 10 whatever is asked', async () => {
    const g = fakeGame({ lists: LISTS, cap: 10 });
    ST.start({ game: g, server: 'cap10', kinds: ['players'], log });
    await done();
    const st = ST.status('cap10').lists.players;
    eq(st.rows, 234);
    eq(st.pageSize, 10);
    eq(g.sent.length, 24);
    const r = ST.search('cap10', { kind: 'players', sort: 'rank', limit: 5000 });
    eq(r.lists[0].rows.map((x) => x.rank), Array.from({ length: 234 }, (_, i) => i + 1));
  }],
  ['sortType 0 refused: the fallback sort', async () => {
    const g = fakeGame({ lists: LISTS, sorts: [1, 2] });
    ST.start({ game: g, server: 'sorts', kinds: ['players', 'heroes'], log });
    await done();
    eq(ST.status('sorts').lists.players.rows, 234);
    eq(g.sent.filter((s) => s.cmd === 'rank.getPlayerRank').every((s, i) => i === 0 || s.sortType === 2), true);
    eq(g.sent.filter((s) => s.cmd === 'rank.getHeroRank').slice(1).every((s) => s.sortType === 1), true);
  }],
  ['a lost reply is asked again; a list that shrank loses its tail', async () => {
    const g = fakeGame({ lists: LISTS, fail: { 'rank.getPlayerRank:2': 1 } });
    ST.start({ game: g, server: S1, kinds: ['players'], log });
    await done();
    eq(ST.status(S1).lists.players.rows, 234);
    assert(logs.some((l) => /page 2 .*again in 2 s/.test(l)));
    const small = fakeGame({ lists: { ...LISTS, 'rank.getPlayerRank': players(150) } });
    ST.start({ game: small, server: S1, kinds: ['players'], log });
    await done();
    eq(ST.status(S1).lists.players.rows, 150);
  }],
  ['stop, and a connection that goes', async () => {
    const big = { ...LISTS, 'rank.getPlayerRank': players(3000) };
    const g = fakeGame({ lists: big, cap: 10 });
    ST.start({ game: g, server: 'stop', kinds: ['players', 'heroes'], log });
    while (g.sent.length < 3) await new Promise((r) => setTimeout(r, 2));
    eq(ST.stop().ok, true);
    await done();
    const st = ST.status('stop').lists;
    eq(st.players.state, 'stopped');
    assert(st.players.rows < 3000 && st.players.rows > 0);
    eq(st.heroes.rows, 0, 'the next list never starts');
    eq(ST.stop().ok, false);
    let up = true;
    const g2 = fakeGame({ lists: big, cap: 10 });
    ST.start({ game: g2, server: 'gone', kinds: ['players'], alive: () => up, log });
    while (g2.sent.length < 2) await new Promise((r) => setTimeout(r, 2));
    up = false;
    await done();
    eq(ST.status('gone').lists.players.state, 'stopped');
  }],
  ['waits while the market pipe is busy', async () => {
    let n = 12;
    const g = fakeGame({ lists: LISTS, cap: 100, busy: () => n });
    ST.start({ game: g, server: 'busy', kinds: ['players'], log });
    await new Promise((r) => setTimeout(r, 300));
    eq(g.sent.length, 1, 'page 2 waits');
    n = 0;
    await done();
    eq(ST.status('busy').lists.players.rows, 234);
  }],
  ['nothing to read', async () => {
    const g = fakeGame({ lists: { } });
    ST.start({ game: g, server: 'empty', kinds: ['cities'], log });
    await done();
    eq(ST.status('empty').lists.cities.state, 'failed');
    eq(ST.start({ game: null, server: 'x' }).ok, false);
  }],
  ['browse: a page from the server, the next 5 read behind it, then from the database', async () => {
    const g = fakeGame({ lists: { ...LISTS, 'rank.getHeroRank': heroes(1234) } });
    const p1 = await ST.page({ game: g, server: 'br', kind: 'heroes', pageNo: 1, log });
    eq([p1.pageNo, p1.totalPage, p1.pageSize, p1.rows.length, p1.error], [1, 13, 100, 100, null]);
    eq(p1.rows[0].name, 'Hero1');
    await ahead();
    eq(g.sent.map((s) => s.pageNo), [1, 2, 3, 4, 5, 6]);
    const p3 = await ST.page({ game: g, server: 'br', kind: 'heroes', pageNo: 3, log });
    eq(p3.rows[0].rank, 201);
    await ahead();
    eq(g.sent.filter((s) => s.pageNo === 3).length, 1, 'page 3 came from the database');
    eq(g.sent.map((s) => s.pageNo).slice(6), [7, 8], 'only what was not read yet');
    const last = await ST.page({ game: g, server: 'br', kind: 'heroes', pageNo: 99, ahead: 0, log });
    eq([p1.total, p1.exact], [1300, false], 'a guess until the last page is read');
    eq([last.pageNo, last.rows.length, last.total, last.exact], [13, 34, 1234, true], 'past the end: the last page');
    const off = await ST.page({ game: null, server: 'br', kind: 'heroes', pageNo: 2 });
    eq([off.rows.length, off.error], [100, null], 'no connection: what is saved');
    eq((await ST.page({ game: null, server: 'br', kind: 'cities' })).error, 'not connected');
  }],
  ['browse: a first look at page 7 settles the page size on page 1; one ask for a page wanted twice', async () => {
    const g = fakeGame({ lists: { ...LISTS, 'rank.getPlayerRank': players(900) }, cap: 10 });
    const p = await ST.page({ game: g, server: 'b10', kind: 'players', pageNo: 7, ahead: 0 });
    eq([p.pageNo, p.pageSize, p.totalPage, p.rows[0].rank], [7, 10, 90, 61]);
    eq(g.sent.map((s) => [s.pageNo, s.pageSize]), [[1, 100], [7, 10]]);
    const both = await Promise.all([ST.page({ game: g, server: 'b10', kind: 'players', pageNo: 9, ahead: 0 }),
      ST.page({ game: g, server: 'b10', kind: 'players', pageNo: 9, ahead: 0 })]);
    eq(both[0].rows, both[1].rows);
    eq(g.sent.filter((s) => s.pageNo === 9).length, 1);
  }],
  ['browse: a page older than FRESH_MS is read again', async () => {
    const g = fakeGame({ lists: LISTS });
    await ST.page({ game: g, server: 'old', kind: 'alliances', ahead: 0 });
    require('./db').run(`UPDATE stat_alliances SET at = ? WHERE server = 'old'`, Date.now() - ST.FRESH_MS - 1);
    await ST.page({ game: g, server: 'old', kind: 'alliances', ahead: 0 });
    eq(g.sent.length, 2);
  }],
  ['lookup: the server page for a name, exact first, with the page it is on', async () => {
    const g = fakeGame({ lists: LISTS });
    g.req = async (cmd, d) => { g.sent.push({ cmd, ...d }); return { ok: 1, pageNo: 3, totalPage: 3, beans: players(234).slice(200, 234) }; };
    const r = await ST.lookup({ game: g, server: S1, kind: 'players', name: 'lord205' });
    eq(g.sent[0].key, 'lord205');
    eq([r.rows[0].name, r.rows[0].exact, r.rows[0].page], ['Lord205', true, 3]);
    eq(r.rows.filter((x) => x.exact).length, 1);
    eq((await ST.lookup({ game: null, server: S1, kind: 'players', name: 'x' })).error, 'not connected');
  }],
  ['Refresh carries on where a stopped read left off', async () => {
    const big = { ...LISTS, 'rank.getPlayerRank': players(3000) };
    const g = fakeGame({ lists: big });
    ST.start({ game: g, server: 'res', kinds: ['players'], log });
    while (g.sent.length < 4) await new Promise((r) => setTimeout(r, 2));
    ST.stop();
    await done();
    const at = ST.status('res').lists.players.pageNo;
    assert(at >= 3 && at < 30);
    const g2 = fakeGame({ lists: big });
    ST.start({ game: g2, server: 'res', kinds: ['players'], log });
    await done();
    eq(g2.sent[0].pageNo, at + 1, 'no page read twice');
    const st = ST.status('res').lists.players;
    eq([st.state, st.rows], ['done', 3000]);
    const all = ST.search('res', { kind: 'players', limit: 5000 }).lists[0].rows.map((x) => x.rank);
    eq(all, Array.from({ length: 3000 }, (_, i) => i + 1));
    const g3 = fakeGame({ lists: big });
    ST.start({ game: g3, server: 'res', kinds: ['players'], log });
    await done();
    eq(g3.sent[0].pageNo, 1, 'a finished read starts again at the top');
  }],
  ['search: every list, an exact name first', async () => {
    const r = ST.search(S1, { kind: 'all', q: 'lord7', limit: 10 });
    const by = Object.fromEntries(r.lists.map((l) => [l.kind, l]));
    // Lord7, Lord70-79, Lord700.. no (150 players): Lord7 + Lord70..79 = 11
    eq(by.players.total, 11);
    eq(by.players.rows[0].name, 'Lord7', 'exact first');
    eq(by.players.rows.length, 10);
    // heroes owned by Lord7, plus the hero named Lord7
    eq(by.heroes.rows[0].name === 'Lord7' || by.heroes.rows[0].lord === 'Lord7', true);
    eq(by.heroes.total, heroes(57).filter((h) => h.kind === 'Lord7' || h.name === 'Lord7').length);
    eq(by.cities.total, 0);
    eq(by.players.cols.map((c) => c.k), ['rank', 'name', 'alliance', 'title', 'prestige', 'honor', 'cities', 'population']);
  }],
  ['search: an alliance finds its members; % and _ are plain text', async () => {
    const r = ST.search(S1, { kind: 'players', q: 'reds', limit: 5000 });
    eq(r.lists[0].total, 75);
    eq(ST.search(S1, { kind: 'alliances', q: '50%' }).lists[0].rows.map((a) => a.name), ['50%_off']);
    eq(ST.search(S1, { kind: 'alliances', q: '_' }).lists[0].total, 1);
    eq(ST.search(S1, { kind: 'alliances', q: 'old' }).lists[0].rows[0].founder, 'Old', 'the founder is searched');
  }],
  ['search: sorting, paging, titles', async () => {
    const top = ST.search(S1, { kind: 'heroes', sort: 'attack', dir: 'desc', limit: 3 }).lists[0];
    eq(top.rows.map((h) => h.attack), [556, 555, 554]);
    eq(top.total, 57);
    const page2 = ST.search(S1, { kind: 'players', limit: 2, offset: 2 }).lists[0];
    eq(page2.rows.map((p) => p.rank), [3, 4]);
    const p1 = ST.search(S1, { kind: 'players', limit: 2 }).lists[0].rows;
    eq([p1[0].title, p1[1].title], ['Baroness', 'Baron']);
    eq(ST.search(S1, { kind: 'players', sort: 'nonsense; DROP', limit: 1 }).lists[0].rows[0].rank, 1, 'unknown sort: by rank');
  }],
];

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n      ')); }
  }
  try { require('./db').db.close(); } catch {}
  for (const f of [DB, DB + '-wal', DB + '-shm']) try { fs.unlinkSync(f); } catch {}
  console.log(fail ? `${fail} failed` : `all ${tests.length} passed`);
  process.exit(fail ? 1 : 0);
})();
