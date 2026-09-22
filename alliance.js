'use strict';
// The console's Alliance and Friends tabs: the game's Alliance window (Info,
// Members, Friendly, Neutral, Hostile, War Reports, Events) and its Friends
// window (Blocklist, My Friends), as the user asked for them (2026-09-22).
//
// Everything here goes through the console's live connection and never logs in
// (a second login kicks the console — EVONY-RULES). A read is the user opening a
// tab or pressing Refresh; nothing polls. The orders (rank, expel, standing,
// friends, block) are the script language's own commands (script-cmd-social.js),
// run once with `confirm` already given, so their guards and log lines are the
// same as a script's.
//
// Requests, from the decompiled client (src/scripts/com/evony/...):
//   alliance.isHasAlliance {}      AllianceManagementCommands.as:319-326, the window's
//     first ask (AllianceExist.as). HasAllianceResponse.as: indexAllianceInfoBean
//     (IndexAllianceInfoBean.as: allianceName, creatorName, leaderName, memberCount,
//     memberLimit, rank, prestige, allianceInfo = intro, allianceNote = notice) and
//     friendlyList / middleList / enemyList of UnitAlliance (allianceName, rank,
//     memberCount, leaderName, aPrestigeCount, honor).
//   alliance.getAllianceMembers {}                 AllianceCommands.as:86-95 -> members, PlayerInfoBeans
//   alliance.getAllianceEventList {pageNo}         AllianceCommands.as:62-72 -> events [{eventName, time}], pageNo, totalPage
//   alliance.getMilitarySituationList {pageNo, pageSize}  AllianceCommands.as:34-45 -> situations, 10 a page
//   common.getPlayerInfoByName {userName}          CommonCommands.as:121-128 -> playerInfo
//   The friends and block lists are the player bean's friendBeans / blockBeans
//   (PlayerBean.as:208, PlayerInfoBeans), which the friend.* replies replace.
//
// Who may do what, as AllianceMemberInfoShow.as greys its buttons: Expel when the
// member ranks below you (levelId larger); a new rank when you are host, vice host
// or presbyter (levelId 4-6), the member is not you and ranks below you.
//
// Unverified live (2026-09-22): isHasAlliance's reply, the event list's eventName
// text, and whether a presbyter may change a standing (the server decides).
const MB = require('./mailbox');
const SOC = require('./script-cmd-social');

const REPLY_MS = 12000;
const CACHE_MS = 60000;            // Info and Members, between presses of Refresh
const WAR_PAGE = 10;               // MilitarySituationList.as:548

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v) => (v === undefined || v === null ? '' : String(v));
const lc = (s) => str(s).toLowerCase();

const cache = new WeakMap();       // game -> { overview, members }
const slot = (g) => { let c = cache.get(g); if (!c) cache.set(g, (c = {})); return c; };
function forget(g) { if (g) cache.delete(g); }

function live(session) {
  const g = session && session.game;
  if (!g || !session.connected) throw new Error('not connected — the alliance is read through this account\'s live connection, never a new login');
  return g;
}

// One request of a kind at a time: a reply names only its command.
async function req(g, cmd, data) {
  const run = () => g.req(cmd, data, REPLY_MS);
  const r = typeof g.lane === 'function' ? await g.lane(cmd, run) : await run();
  if (!r || Number(r.ok) !== 1) throw new Error(str(r && (r.errorMsg || r.msg)) || `the server refused ${cmd}${r && r.ok !== undefined ? ` (ok=${r.ok})` : ''}`);
  return r;
}

const infoOf = (g) => (g && g.player && g.player.playerInfo) || {};

// A PlayerInfoBean as the tabs show it.
function person(b) {
  b = b || {};
  const levelId = num(b.levelId);
  return {
    name: str(b.userName), alliance: str(b.alliance),
    sex: num(b.sex) === 1 ? 'F' : 'M',
    levelId, position: SOC.POSITIONS[levelId] || '',
    prestige: num(b.prestige), honor: num(b.honor), ranking: num(b.ranking),
    lastLogin: num(b.lastLoginTime) || null,
    cities: num(b.castleCount), population: num(b.population),
    title: SOC.titleName(b.titleId, b.sex), office: SOC.officeName(b.office),
  };
}

const unit = (a) => ({
  name: str(a && a.allianceName), rank: num(a && a.rank), members: num(a && a.memberCount),
  host: str(a && a.leaderName), prestige: num(a && a.aPrestigeCount), honor: num(a && a.honor),
});

// Info and the three standings, one request.
async function overview(session, { fresh = false } = {}) {
  const g = live(session);
  const mine = str(infoOf(g).alliance);
  if (!mine) return { ok: true, none: true, me: myself(g) };
  const c = slot(g);
  if (!fresh && c.overview && c.overview.alliance === mine && Date.now() - c.overview.at < CACHE_MS) return c.overview.v;
  const r = await req(g, 'alliance.isHasAlliance', {});
  const i = r.indexAllianceInfoBean || {};
  const v = {
    ok: true, at: Date.now(), me: myself(g),
    info: {
      name: str(i.allianceName) || mine, founder: str(i.creatorName), host: str(i.leaderName),
      members: num(i.memberCount), limit: num(i.memberLimit), ranking: num(i.rank), prestige: num(i.prestige),
      intro: MB.mailText(str(i.allianceInfo)), notice: MB.mailText(str(i.allianceNote)),
    },
    friendly: (r.friendlyList || []).filter(Boolean).map(unit),
    neutral: (r.middleList || []).filter(Boolean).map(unit),
    hostile: (r.enemyList || []).filter(Boolean).map(unit),
  };
  c.overview = { alliance: mine, at: v.at, v };
  // the map colours castles by the same lists (session.diplomacy)
  const names = (l) => l.map((a) => a.name).filter(Boolean);
  session.diplo = { at: Date.now(), alliance: mine, friendly: names(v.friendly), neutral: names(v.neutral), enemy: names(v.hostile) };
  return v;
}

function myself(g) {
  const p = infoOf(g);
  return { name: str(p.userName), alliance: str(p.alliance), levelId: num(p.levelId) };
}

async function members(session, { fresh = false } = {}) {
  const g = live(session);
  const mine = str(infoOf(g).alliance);
  const me = myself(g);
  if (!mine) return { ok: true, none: true, me, members: [] };
  const c = slot(g);
  if (!fresh && c.members && c.members.alliance === mine && Date.now() - c.members.at < CACHE_MS) return c.members.v;
  const r = await req(g, 'alliance.getAllianceMembers', {});
  const list = (r.members || []).filter(Boolean).map(person);
  // my own rank as the list gives it (the login's copy may be older)
  const self = list.find((m) => lc(m.name) === lc(me.name));
  if (self && self.levelId) me.levelId = self.levelId;
  for (const m of list) Object.assign(m, may(me, m));
  const v = { ok: true, at: Date.now(), me, members: list };
  c.members = { alliance: mine, at: v.at, v };
  return v;
}

// What the member window would let me do to m.
function may(me, m) {
  const mine = num(me.levelId), theirs = num(m.levelId);
  const self = lc(me.name) === lc(m.name);
  const below = !!mine && !!theirs && theirs > mine;
  return { canExpel: !self && below, canRank: !self && below && mine >= 4 && mine <= 6 };
}

async function events(session, page = 1) {
  const g = live(session);
  const pageNo = Math.max(1, Math.floor(num(page)) || 1);
  const r = await req(g, 'alliance.getAllianceEventList', { pageNo });
  return {
    ok: true, pageNo: num(r.pageNo) || pageNo, totalPage: num(r.totalPage),
    events: (r.events || []).filter(Boolean).map((e) => ({ text: MB.mailText(str(e.eventName)), time: num(e.time) || null })),
  };
}

async function war(session, page = 1) {
  const g = live(session);
  const pageNo = Math.max(1, Math.floor(num(page)) || 1);
  const r = await req(g, 'alliance.getMilitarySituationList', { pageNo, pageSize: WAR_PAGE });
  const rows = (r.situations || []).filter(Boolean).map((s, i) => {
    const bean = { startPos: s.startPos, targetPos: s.targetPos };
    let detail = null;
    try { detail = s.xml_data ? MB.describeReport(s.xml_data, bean) : null; } catch { detail = null; }
    return {
      i, type: s.attack ? 'ATTACK' : 'DEFENSE', subject: str(s.eventName),
      alliance: s.otherAllianceName === undefined || s.otherAllianceName === null ? '' : str(s.otherAllianceName),
      time: num(s.time) || null, from: str(s.startPos), to: str(s.targetPos),
      detail, content: str(s.xml_data).slice(0, 50000),
    };
  });
  return { ok: true, pageNo: num(r.pageNo) || pageNo, totalPage: num(r.totalPage), situations: rows };
}

// Anyone, by name.
async function player(session, name) {
  const g = live(session);
  const who = str(name).trim();
  if (!who) throw new Error('whose name?');
  const ask = () => req(g, 'common.getPlayerInfoByName', { userName: who });
  let r = await ask();
  // the heartbeat asks the same about us, and a reply names only its command
  const me = lc(myself(g).name);
  if (me && lc(who) !== me && lc((r.playerInfo || {}).userName) === me) r = await ask();
  const p = person(r.playerInfo);
  if (!p.name) throw new Error(`the server knows no ${who}`);
  const mem = slot(g).members;
  const m = mem && mem.v.members.find((x) => lc(x.name) === lc(p.name));
  return { ok: true, player: m ? { ...p, ...m } : p };
}

function friends(session) {
  const g = session && session.game;
  if (!g || !g.player) return { ok: false, error: 'not connected' };
  const rows = (list) => (list || []).filter(Boolean).map((b) => ({ name: str(b.userName), alliance: str(b.alliance) })).filter((b) => b.name);
  return { ok: true, friends: rows(g.player.friendBeans), blocked: rows(g.player.blockBeans), me: myself(g) };
}

// The orders. The page asks the user first; `confirm` here is that answer.
const quote = (n) => `"${str(n).replace(/"/g, '')}"`;
const RANKS = { vicehost: 'setvicehost', presbyter: 'setpresbyter', officer: 'setofficer', member: 'setmember' };
const STANDINGS = { friendly: 'blue', neutral: 'grey', hostile: 'red', none: 'none' };
const FRIEND_ACTS = { addfriend: 1, removefriend: 1, block: 1, unblock: 1 };

async function act(session, b = {}) {
  const g = live(session);
  const action = lc(b.action);
  const name = str(b.name).trim();
  if (!name) throw new Error('whose name?');
  const lines = [];
  const env = {
    game: g, session, castle: typeof g.castle === 'function' ? g.castle() : null,
    cid: typeof g.castle === 'function' && typeof g.castleId === 'function' ? g.castleId(g.castle()) : null,
    dryRun: false, opts: {}, state: {},
    log: (m) => lines.push(str(m).trim()),
    say: (x) => (x && Number(x.ok) === 1 ? 'ok' : `FAILED (ok=${x && x.ok})${x && x.errorMsg ? ' - ' + x.errorMsg : ''}`),
    stopped: () => false, pause: (ms) => new Promise((res) => setTimeout(res, ms)),
  };
  let res, what;
  if (FRIEND_ACTS[action]) {
    what = `${action} ${name}`;
    const spec = SOC.commands[action];
    res = await spec.run({ cmd: action, ...spec.parse(quote(name)) }, env);
  } else if (action === 'rank') {
    const word = RANKS[lc(b.rank)];
    if (!word) throw new Error(`"${b.rank}" is not a rank — vicehost, presbyter, officer or member`);
    what = `${word} ${name}`;
    res = await SOC.inline[word].run(`${quote(name)} confirm`, env);
  } else if (action === 'expel') {
    what = `expel ${name}`;
    res = await SOC.inline.expel.run(`${quote(name)} confirm`, env);
  } else if (action === 'standing') {
    const st = STANDINGS[lc(b.standing)];
    if (!st) throw new Error(`"${b.standing}" is not a standing — friendly, neutral, hostile or none`);
    what = `declare ${name} ${st}`;
    res = await SOC.inline.declare.run(`${quote(name)} ${st} confirm`, env);
  } else throw new Error(`no such action: ${b.action}`);
  res = res || {};
  const ok = !res.error && res.ok !== false && lines.some((l) => /^-> ok\b/.test(l));
  forget(g);
  if (typeof session.note === 'function') {
    session.note(`manual: ${what} -> ${ok ? 'ok' : res.error || lines[lines.length - 1] || 'failed'}`, { kind: 'act' });
  }
  return { ...(FRIEND_ACTS[action] ? friends(session) : {}), ok, lines, error: ok ? null : res.error || lines[lines.length - 1] || 'failed' };
}

module.exports = { overview, members, events, war, player, friends, act, _test: { person, unit, may, forget } };
