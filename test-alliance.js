'use strict';
// alliance.js offline: a fake session and game answer the Alliance and Friends
// tabs' requests from made-up beans. Never connects to anything.
const assert = require('assert');
const AL = require('./alliance');
const eq = (a, b, m) => assert.deepStrictEqual(a, b, m);

const ME = { userName: 'Robby', alliance: '1112', levelId: 5 };
const MEMBERS = [
  { userName: 'Rain', levelId: 4, sex: 0, prestige: 900, honor: 5, ranking: 6, castleCount: 10, population: 500000, titleId: 9, lastLoginTime: 1790000000000 },
  { userName: 'Robby', levelId: 5, sex: 0, prestige: 800, ranking: 7 },
  { userName: 'blazing', levelId: 8, sex: 1, prestige: 232030410, honor: 4371283, ranking: 874, castleCount: 9, population: 540267, titleId: 9 },
  { userName: 'Gremlin', levelId: 6, prestige: 10 },
];

function fake({ connected = true, replies = {} } = {}) {
  const sent = [];
  const player = {
    playerInfo: { ...ME },
    friendBeans: [{ userName: 'Bird', alliance: '1112' }],
    blockBeans: [{ userName: 'Spammer', alliance: 'SLUMLORD' }],
  };
  const game = {
    player,
    castles: [{ id: 11, name: 'BAVARIA' }],
    castle() { return this.castles[0]; },
    castleId: (c) => c.id,
    lane: (cmd, fn) => fn(),
    async req(cmd, d) {
      sent.push({ cmd, ...d });
      if (replies[cmd]) return replies[cmd](d);
      switch (cmd) {
        case 'alliance.isHasAlliance': return {
          ok: 1,
          indexAllianceInfoBean: { allianceName: '1112', creatorName: 'Rain', leaderName: 'Rain', memberCount: 89, memberLimit: 100, rank: 6, prestige: 24305316328, allianceInfo: 'Hi &amp; welcome', allianceNote: '' },
          friendlyList: [{ allianceName: 'Friends', rank: 3, memberCount: 50, leaderName: 'Bob', aPrestigeCount: 5, honor: 1 }],
          middleList: [],
          enemyList: [{ allianceName: 'Eldian', rank: 1, memberCount: 76, leaderName: 'EldianEyez', aPrestigeCount: 99021536682, honor: 333862 }, null],
        };
        case 'alliance.getAllianceMembers': return { ok: 1, members: MEMBERS };
        case 'alliance.getAllianceEventList': return { ok: 1, pageNo: d.pageNo, totalPage: 3, events: [{ eventName: 'Bob joined the alliance', time: 1790000000000 }] };
        case 'alliance.getMilitarySituationList': return {
          ok: 1, pageNo: d.pageNo, totalPage: 276,
          situations: [{ attack: false, eventName: 'Lord16 Attack 3(703,111)', otherAllianceName: 'We3Kings', time: 1790000000000, startPos: '1,2', targetPos: '703,111', xml_data: '<report></report>' }],
        };
        case 'common.getPlayerInfoByName': return { ok: 1, playerInfo: { userName: d.userName, alliance: 'X', prestige: 3, sex: 1, titleId: 1 } };
        case 'friend.addFriend': return { ok: 1, friendArr: [...player.friendBeans, { userName: d.player }] };
        case 'friend.deleteBlock': return { ok: 1, blockArr: player.blockBeans.filter((b) => b.userName !== d.player) };
        default: return { ok: 1 };
      }
    },
  };
  const session = { game, connected, notes: [], note(m) { this.notes.push(m); } };
  return { session, game, sent };
}

const tests = [
  ['not connected: refused, nothing sent', async () => {
    const { session, sent } = fake({ connected: false });
    await assert.rejects(AL.overview(session), /not connected/);
    await assert.rejects(AL.act(session, { action: 'expel', name: 'blazing' }), /not connected/);
    eq(sent, []);
  }],
  ['overview: info and the three standings in one request, cached, the map told', async () => {
    const { session, sent } = fake();
    const v = await AL.overview(session);
    eq(v.info, { name: '1112', founder: 'Rain', host: 'Rain', members: 89, limit: 100, ranking: 6, prestige: 24305316328, intro: 'Hi & welcome', notice: '' });
    eq(v.friendly.map((a) => a.name), ['Friends']);
    eq(v.neutral, []);
    eq(v.hostile, [{ name: 'Eldian', rank: 1, members: 76, host: 'EldianEyez', prestige: 99021536682, honor: 333862 }]);
    eq(session.diplo.enemy, ['Eldian']);
    await AL.overview(session);
    eq(sent.length, 1, 'the second read came from the cache');
    await AL.overview(session, { fresh: true });
    eq(sent.length, 2, 'Refresh asks again');
  }],
  ['no alliance: says so, asks nothing', async () => {
    const { session, game, sent } = fake();
    game.player.playerInfo.alliance = '';
    eq((await AL.overview(session)).none, true);
    eq((await AL.members(session)).none, true);
    eq(sent, []);
  }],
  ['members: named, and who may be expelled or re-ranked as the game decides', async () => {
    const { session } = fake();
    const v = await AL.members(session);
    const by = Object.fromEntries(v.members.map((m) => [m.name, m]));
    eq([by.blazing.sex, by.blazing.position, by.blazing.title, by.blazing.cities], ['F', 'Member', 'Prinzessin', 9]);
    eq([by.Rain.canExpel, by.Rain.canRank], [false, false], 'the host ranks above a vice host');
    eq([by.Robby.canExpel, by.Robby.canRank], [false, false], 'not yourself');
    eq([by.blazing.canExpel, by.blazing.canRank], [true, true]);
    eq([by.Gremlin.canExpel, by.Gremlin.canRank], [true, true]);
    eq(AL._test.may({ name: 'O', levelId: 7 }, { name: 'M', levelId: 8 }), { canExpel: true, canRank: false }, 'an officer cannot change positions');
  }],
  ['events and war reports: the page asked for, the report described', async () => {
    const { session, sent } = fake();
    const e = await AL.events(session, 2);
    eq([e.pageNo, e.totalPage, e.events[0].text], [2, 3, 'Bob joined the alliance']);
    const w = await AL.war(session, '0');
    eq(sent[sent.length - 1], { cmd: 'alliance.getMilitarySituationList', pageNo: 1, pageSize: 10 });
    const s = w.situations[0];
    eq([s.type, s.subject, s.alliance, s.to], ['DEFENSE', 'Lord16 Attack 3(703,111)', 'We3Kings', '703,111']);
    assert.ok(s.detail && typeof s.detail === 'object');
  }],
  ['player: a reply about us (the heartbeat\'s) is asked again', async () => {
    let n = 0;
    const { session } = fake({ replies: { 'common.getPlayerInfoByName': (d) => ({ ok: 1, playerInfo: { userName: n++ ? d.userName : 'Robby' } }) } });
    eq((await AL.player(session, 'Bird')).player.name, 'Bird');
    eq(n, 2);
  }],
  ['friends: the player bean\'s lists; orders replace them', async () => {
    const { session, sent } = fake();
    eq(AL.friends(session).friends, [{ name: 'Bird', alliance: '1112' }]);
    const a = await AL.act(session, { action: 'addfriend', name: 'Lechu' });
    eq([a.ok, a.friends.map((f) => f.name)], [true, ['Bird', 'Lechu']]);
    const u = await AL.act(session, { action: 'unblock', name: 'Spammer' });
    eq([u.ok, u.blocked], [true, []]);
    eq(sent.map((x) => x.cmd), ['friend.addFriend', 'friend.deleteBlock']);
    assert.ok(session.notes.some((m) => /manual: addfriend Lechu -> ok/.test(m)));
  }],
  ['friends: the script command\'s guard holds (a friend is not blocked without leaving the list)', async () => {
    const { session, sent } = fake();
    const r = await AL.act(session, { action: 'block', name: 'Bird' });
    eq(r.ok, false);
    assert.match(r.error, /removefriend Bird first/);
    eq(sent, []);
  }],
  ['orders: rank, expel and standing go out as the game sends them', async () => {
    const { session, sent } = fake();
    eq((await AL.act(session, { action: 'rank', name: 'blazing', rank: 'officer' })).ok, true);
    eq((await AL.act(session, { action: 'expel', name: 'blazing' })).ok, true);
    eq((await AL.act(session, { action: 'standing', name: 'Eldian', standing: 'hostile' })).ok, true);
    eq((await AL.act(session, { action: 'standing', name: 'Eldian', standing: 'none' })).ok, true);
    eq(sent, [
      { cmd: 'alliance.setPowerForUserByAlliance', userName: 'blazing', typeId: 7 },
      { cmd: 'alliance.kickOutMemberfromAlliance', userName: 'blazing' },
      { cmd: 'alliance.setAllianceFriendship', targetAllianceName: 'Eldian', type: 3 },
      { cmd: 'alliance.dropAllianceFriendshipRelation', targetAllianceName: 'Eldian' },
    ]);
    await assert.rejects(AL.act(session, { action: 'rank', name: 'x', rank: 'host' }), /not a rank/);
    await assert.rejects(AL.act(session, { action: 'standing', name: 'x', standing: 'war' }), /not a standing/);
    await assert.rejects(AL.act(session, { action: 'nuke', name: 'x' }), /no such action/);
  }],
  ['a refusal comes back as not ok, with the server\'s words', async () => {
    const { session } = fake({ replies: { 'alliance.kickOutMemberfromAlliance': () => ({ ok: -1, errorMsg: 'no permission' }) } });
    const r = await AL.act(session, { action: 'expel', name: 'blazing' });
    eq(r.ok, false);
    assert.match(r.error, /no permission/);
  }],
  ['an order drops the cache, so the tab reads what changed', async () => {
    const { session, sent } = fake();
    await AL.members(session);
    await AL.act(session, { action: 'expel', name: 'blazing' });
    await AL.members(session);
    eq(sent.filter((x) => x.cmd === 'alliance.getAllianceMembers').length, 2);
  }],
];

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n      ')); }
  }
  console.log(fail ? `${fail} failed` : `all ${tests.length} passed`);
  process.exit(fail ? 1 : 0);
})();
