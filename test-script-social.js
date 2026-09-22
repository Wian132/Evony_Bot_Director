'use strict';
// The social commands (chat, friends, say, play, post) and NEAT's in-line
// commands, offline: a real Game whose requests are stubbed, driven through
// script.parse + script.run. The Usage and Example lines of the wiki pages
// Whisper, AllianceChat, WorldChat, AddFriend, RemoveFriend, Block, Unblock,
// Command, InLineCommands, PromoAddFriend, SortingMemberList, Play, Say and
// Post run here, with the example scripts that use them (MonitorCity,
// PeacetimeStatusChecker, Config.sol, Scr1ptingForDummies, AutoTeleporter).
const assert = require('assert');
const { EventEmitter } = require('events');
const C = require('./constants');
const { Game } = require('./game');
const script = require('./script');
const S = require('./script-cmd-social');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const eq = (a, b, m) => assert.deepStrictEqual(a, b, m);
const F = (x, y) => C.coordsToFieldId(x, y);
// NEAT printed this machine's time; so do the in-line commands
const at = (y, mo, d, h, mi, s) => new Date(y, mo, d, h, mi, s).getTime();

// ---------------------------------------------------------------- the map

const T0 = Date.now() - 60000;
const row = (x, y, o) => ({ id: F(x, y), x, y, seen: T0, state: 1, furlough: false, npc: false, prestige: 0, honor: 0, ...o });
const ROWS = [
  row(111, 222, { name: 'MyCity', userName: 'Botter', allianceName: 'TuffGuys', prestige: 14997337, honor: 212942, level: 10, kind: 'player' }),
  row(111, 333, { name: 'ACity', userName: 'Botter', allianceName: 'TuffGuys', prestige: 14997337, honor: 212942, level: 10, kind: 'player' }),
  row(111, 223, { name: "Barbarian's city", npc: true, level: 5, kind: 'npc' }),
  row(115, 226, { name: 'HisCity', userName: 'BadGuy', allianceName: 'SomeReds', prestige: 5026954, honor: 3392049, level: 10, relation: 3, kind: 'player' }),
  row(105, 102, { name: 'Small', userName: 'Tiny', allianceName: null, prestige: 5000, level: 2, kind: 'player' }),
  row(108, 104, { name: 'Big', userName: 'Huge', allianceName: 'Giants', prestige: 3000000, level: 9, kind: 'player' }),
  row(100, 210, { name: 'Lonely', userName: 'Idle1', allianceName: null, prestige: 10, level: 1, kind: 'player' }),
];
const mapSource = {
  tiles(x1, y1, x2, y2, { castles = false } = {}) {
    return ROWS.filter((r) => r.x >= x1 && r.x <= x2 && r.y >= y1 && r.y <= y2 && (!castles || r.userName || r.npc)).map((r) => ({ ...r }));
  },
};

// ---------------------------------------------------------------- fixtures

const BATTLE = '<reportData reportUrl="battless71.evony.com/default.html?logfile/20260913/26/b8/abc.xml">'
  + '<battleReport isAttack="true" isAttackSuccess="true" round="3" support="88">'
  + '<attackTroop king="Botter"><troopUnit typeId="8" count="400" lose="400"/><troopUnit typeId="11" count="550" lose="550"/></attackTroop>'
  + '<defendTroop king="NPC"><troopUnit typeId="17" count="750" lose="750"/><troopUnit typeId="16" count="1250" lose="0"/>'
  + '<troopUnit typeId="3" count="750" lose="0"/></defendTroop></battleReport></reportData>';

const REPORTS = [
  { id: 10612, title: 'Attack Reports', eventTime: at(2011, 4, 23, 21, 27, 33), startPos: 'ACity(111,111)', targetPos: "Barbarian's city(111,112)", attack: true, isRead: 0 },
  { id: 10634, title: 'Attack Reports', eventTime: at(2011, 4, 23, 21, 2, 48), startPos: 'AnotherCity(111,222)', targetPos: "Barbarian's city(111,223)", attack: true, isRead: 0 },
];
// the wiki's ReadReport sample
const READ_ONLY = { id: 10565, title: 'Attack Reports', eventTime: at(2011, 4, 23, 16, 27, 4), startPos: 'MyCity(111,333)', targetPos: "Barbarian's city(111,334)", attack: true, isRead: 0 };
const MAILS = [
  { mailid: 501, sender: 'MyFriend', receiver: 'Botter', title: 'hello', receiveTime: at(2011, 4, 23, 16, 42, 17), isRead: 0 },
  { mailid: 502, sender: 'SomeHost', receiver: 'Botter', title: 'Can we Talk?', receiveTime: at(2011, 4, 23, 12, 11, 41), isRead: 1 },
];
const MAIL_TEXT = { 501: "hiya, just reminding you I'll be holidaying this week", 502: "I am SomeHost of alliance TuffGuys.<br>Can we talk!" };
const MEMBERS = [
  ['Member1', 8, 2827841, at(2011, 4, 23, 23, 30, 1)], ['Member2', 6, 13632813, at(2011, 4, 23, 23, 30, 50)],
  ['Member3', 8, 3266061, at(2011, 4, 23, 23, 30, 21)], ['Member4', 8, 9828232, at(2011, 4, 23, 23, 30, 16)],
  ['Member5', 7, 4304876, at(2011, 4, 23, 23, 28, 43)], ['Member6', 8, 1756597, at(2011, 4, 23, 23, 27, 6)],
].map(([userName, levelId, prestige, lastLoginTime], i) => ({ userName, levelId, prestige, honor: i * 10, lastLoginTime, castleCount: i + 1, population: 1000 * (i + 1) }));
const PLAYERS = {
  bob: { userName: 'bob', alliance: 'TuffGuys', castleCount: 1, prestige: 3666417, honor: 0, ranking: 123, office: '2', titleId: 1, sex: 0, population: 45678 },
  idle1: { userName: 'Idle1', alliance: '', castleCount: 1, prestige: 10, honor: 0, ranking: 99999, office: '0', titleId: 0, population: 0 },
  botter: { userName: 'Botter', alliance: 'TuffGuys', castleCount: 2, prestige: 14997337, honor: 212942, ranking: 5, office: '3', titleId: 4, population: 50000 },
  badguy: { userName: 'BadGuy', alliance: 'SomeReds', castleCount: 1, prestige: 5026954, honor: 3392049, ranking: 40, office: '1', titleId: 2, population: 70000 },
  huge: { userName: 'Huge', alliance: 'Giants', castleCount: 3, prestige: 3000000, honor: 5, ranking: 7, office: '5', titleId: 9, sex: 1, population: 90000 },
};

// ---------------------------------------------------------------- fake world

// Two cities at the wiki's 111,222 and 111,333; heroes; a Speaker; friends A B C.
function world({ replies = {}, player = {}, speakers = 2 } = {}) {
  const g = new Game();
  g.player = {
    playerInfo: { userName: 'Botter', id: 777, alliance: 'TuffGuys' },
    items: speakers ? [{ id: 'consume.1.a', count: speakers }] : [],
    friendBeans: [{ userName: 'A' }, { userName: 'B' }, { userName: 'C' }],
    blockBeans: [{ userName: 'Pest' }],
    enemyArmys: [],
    ...player,
  };
  g.castles = [
    { id: 1, name: 'MyCity', fieldId: F(111, 222), heros: [{ id: 11, name: 'Queen', level: 193, management: 254, power: 67, stratagem: 21, experience: 4737560, upgradeExp: 3724900, status: 1 }],
      buildings: [{ typeId: 28, level: 2, positionId: 7 }] },
    { id: 2, name: 'ACity', fieldId: F(111, 333), heros: [{ id: 12, name: 'Farmer1', level: 297, management: 27, power: 363, stratagem: 21, experience: 10180331, upgradeExp: 8820900, status: 0 }],
      buildings: [{ typeId: 28, level: 1, positionId: 7 }] },
  ];
  g.c = new EventEmitter();
  const sent = [];
  const base = {
    'report.receiveReportList': (d) => ({ ok: 1, pageNo: d.pageNo, totalPage: 6, reports: REPORTS }),
    'report.markAsRead': (d) => ({ ok: 1, report: { ...[...REPORTS, READ_ONLY].find((r) => r.id === d.reportId) || { id: d.reportId, title: 'Attack Reports' }, content: BATTLE } }),
    'mail.receiveMailList': (d) => ({ ok: 1, pageNo: d.pageNo, totalPage: 6, mails: MAILS }),
    'mail.readMail': (d) => ({ ok: 1, mailid: d.mailId, content: MAIL_TEXT[d.mailId] }),
    'alliance.getAllianceMembers': () => ({ ok: 1, members: MEMBERS }),
    'common.getPlayerInfoByName': (d) => (PLAYERS[d.userName.toLowerCase()] ? { ok: 1, playerInfo: PLAYERS[d.userName.toLowerCase()] } : { ok: -4, errorMsg: 'The player does not exist' }),
  };
  const table = { ...base, ...replies };
  g.req = async (cmd, data) => {
    sent.push({ cmd, data });
    const r = table[cmd];
    const v = typeof r === 'function' ? await r(data, g) : r;
    if (v instanceof Error) throw v;
    return v === undefined ? { ok: 1 } : v;
  };
  // game.js sends these two over the socket itself; route them through req
  g.reportList = (type, pageNo, pageSize) => g.req('report.receiveReportList', { pageNo, pageSize, reportType: C.REPORT_TYPE[type] });
  return { g, sent, cmds: () => sent.map((s) => s.cmd) };
}

const QUICK = { castle: 'MyCity', repeatGapMs: 0, chatGapMs: 0, worldGapMs: 0, mailGapMs: 0, notifyGapMs: 0, postGapMs: 0, chatWaitMs: 200, mapSource };

// Run a script; keep(x) in it records values ($result, $error).
async function runIn(w, src, opts = {}) {
  const out = [], kept = [];
  const view = script.parse(src, { globals: { keep: 1 } });
  const errs = view.filter((a) => a.cmd === 'error');
  const done = await script.run(w.g, view, (m) => out.push(m), { ...QUICK, globals: { keep: (v) => { kept.push(v); return v; } }, ...opts });
  return { done, out, kept, errs, text: out.join('\n') };
}
// `command "<text>"` then keep($result) and keep($error): { result, error, r }
async function inline(w, text, opts) {
  const r = await runIn(w, `command ${JSON.stringify(text)}\nkeep($result)\nkeep($error)`, opts);
  return { result: r.kept[0], error: r.kept[1], r };
}
const parseErr = (line) => { const v = script.parse(line)[0]; return v && v.cmd === 'error' ? v.error : null; };

// ---------------------------------------------------------------------------
section('whisper, alliancechat, worldchat');

t('whisper Bob Hello friend! sends a private chat', async () => {
  const w = world();
  const r = await runIn(w, 'whisper Bob Hello friend!\nkeep($error)');
  eq(w.sent, [{ cmd: 'common.privateChat', data: { targetName: 'Bob', msg: 'Hello friend!' } }], r.text);
  eq(r.kept, [null]);
});
t("Scr1ptingForDummies: whisper Buddy I don't have enough scouts, I'm not sending the attacks!", async () => {
  const w = world();
  await runIn(w, "whisper Buddy I don't have enough scouts, I'm not sending the attacks!");
  eq(w.sent[0].data, { targetName: 'Buddy', msg: "I don't have enough scouts, I'm not sending the attacks!" });
});
const attacked = { enemyArmys: [{ missionType: 5, targetFieldId: F(111, 222), troop: { archer: 50000 } }] };
t('the Whisper page: if (city.NumberOfRealAttacks > 0) execute "whisper Bob Help, I have " + ...', async () => {
  const w = world({ player: attacked });
  const r = await runIn(w, 'if (city.NumberOfRealAttacks > 0) execute "whisper Bob Help, I have " + city.NumberOfRealAttacks + " incoming waves to " + city.coords');
  eq(w.sent, [{ cmd: 'common.privateChat', data: { targetName: 'Bob', msg: 'Help, I have 1 incoming waves to 111,222' } }], r.text);
});
t('Unsorted: execute "whisper " + message.user + " " + message.text', async () => {
  const w = world();
  await runIn(w, 'message = { user:"bucks", text:"What\'s wrong with you?" }\nexecute "whisper " + message.user + " " + message.text');
  eq(w.sent[0].data, { targetName: 'bucks', msg: "What's wrong with you?" });
});
t('a quoted name may have spaces', async () => {
  const w = world();
  await runIn(w, 'whisper "Sir Bob" hi there');
  eq(w.sent[0].data, { targetName: 'Sir Bob', msg: 'hi there' });
});
t('alliancechat Hello friends! sends to alliance chat', async () => {
  const w = world();
  await runIn(w, 'alliancechat Hello friends!');
  eq(w.sent, [{ cmd: 'common.allianceChat', data: { msg: 'Hello friends!', languageType: 0 } }]);
});
t('the AllianceChat page: if (city.NumberOfRealAttacks > 0) execute "alliancechat Help, I have " + ...', async () => {
  const w = world({ player: attacked });
  await runIn(w, 'if (city.NumberOfRealAttacks > 0) execute "alliancechat Help, I have " + city.NumberOfRealAttacks + " incoming waves to " + city.coords');
  eq(w.sent[0].data.msg, 'Help, I have 1 incoming waves to 111,222');
});
t('CompleteQuests: alliancechat "hi!" sends hi! (the quotes go)', async () => {
  const w = world();
  await runIn(w, 'alliancechat "hi!"');
  eq(w.sent[0].data.msg, 'hi!');
});
t('Config.sol: execute "alliancechat Help! ... {Config.owner}!!" fills in the owner', async () => {
  const w = world();
  await runIn(w, 'execute "alliancechat Help! Help! I\'m under attack from someone other than {Config.owner}!!"', { config: { owner: 'Boss' } });
  eq(w.sent[0].data.msg, "Help! Help! I'm under attack from someone other than Boss!!");
});
t('PeacetimeStatusChecker: execute "alliancechat *** ATTENTION *** " + x.userName + " is now in peacetime!"', async () => {
  const w = world();
  await runIn(w, 'x = {userName: "Zed"}\nexecute "alliancechat *** ATTENTION *** " + x.userName + " is now in peacetime!"');
  eq(w.sent[0].data.msg, '*** ATTENTION *** Zed is now in peacetime!');
});
t('MonitorCity: execute "alliancechat " + message, then say message', async () => {
  const w = world();
  const heard = [];
  await runIn(w, 'message = "City MyCity @ 111,222 has broken gates!! Please let me know ASAP or log me on and save me!!!"\n'
    + 'echo message\nexecute "alliancechat " + message\nsay message', { notify: (m) => { heard.push(m); return 1; } });
  eq(w.sent[0].data.msg, 'City MyCity @ 111,222 has broken gates!! Please let me know ASAP or log me on and save me!!!');
  eq(heard.map((m) => [m.kind, m.text]), [['say', 'City MyCity @ 111,222 has broken gates!! Please let me know ASAP or log me on and save me!!!']]);
});
t('worldchat Hello world! sends to world chat when a Speaker is held', async () => {
  const w = world();
  const r = await runIn(w, 'worldchat Hello world!\nkeep($error)');
  eq(w.sent, [{ cmd: 'common.worldChat', data: { msg: 'Hello world!', languageType: 0 } }]);
  eq(r.kept, [null]);
});
t('worldchat with no Speaker is refused before anything goes out', async () => {
  const w = world({ speakers: 0 });
  const r = await runIn(w, 'worldchat Hello world!\nkeep($error)');
  eq(w.sent, []);
  assert.match(r.kept[0], /no Speaker held/);
});
t('the same world line twice in a row is refused (ChatFrame.as)', async () => {
  const w = world();
  const r = await runIn(w, 'worldchat Hello world!\nworldchat Hello world!\nkeep($error)');
  eq(w.cmds(), ['common.worldChat']);
  assert.match(r.kept[0], /twice in a row/);
});
t('a refusal from the server is the line\'s $error', async () => {
  const w = world({ replies: { 'common.allianceChat': { ok: -12, errorMsg: 'You have no alliance' } } });
  const r = await runIn(w, 'alliancechat hi\nkeep($error)');
  eq(r.kept, ['You have no alliance']);
  assert.match(r.text, /FAILED \(ok=-12\) - You have no alliance/);
});
t('no reply but the line comes back in chat: sent', async () => {
  const w = world({ replies: { 'common.allianceChat': (d, g) => { g.c.emit('cmd', 'server.ChannelChatMsg', { channel: 'alliance', fromUser: 'Botter', msg: `<font>${d.msg}</font>` }); return new Promise(() => {}); } } });
  const r = await runIn(w, 'alliancechat a<b and more\nkeep($error)');
  eq(w.sent[0].data.msg, 'a&lt;b and more');           // the client's escape (ChatContentData.as:219)
  eq(r.kept, [null], r.text);
  assert.match(r.text, /ok \(seen in chat\)/);
});
t('no reply and no echo: the line failed (not "sent", as the console reports it)', async () => {
  const w = world({ replies: { 'common.privateChat': new Error('no reply to common.privateChat') } });
  const r = await runIn(w, 'whisper Bob hi\nkeep($error)');
  assert.match(r.kept[0], /no reply to common\.privateChat \(not seen in chat either\)/);
  assert.match(r.text, /may not have gone out/);
});
t('a line over 150 characters goes out in parts, cut between words', async () => {
  const w = world();
  const long = Array.from({ length: 40 }, (_, i) => 'word' + i).join(' ');   // 268 characters
  await runIn(w, 'alliancechat ' + long);
  const parts = w.sent.map((s) => s.data.msg);
  eq(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 150));
  eq(parts.join(' '), long);
});
t('world chat refuses a line over 150 characters instead (each part costs a Speaker)', async () => {
  const w = world();
  const r = await runIn(w, 'worldchat ' + 'x'.repeat(151) + '\nkeep($error)');
  eq(w.sent, []);
  assert.match(r.kept[0], /150 characters at most/);
});
t('a line with "cheat" in it is never sent, as in the game client', async () => {
  const w = world();
  const r = await runIn(w, 'alliancechat no Cheating here\nkeep($error)');
  eq(w.sent, []);
  assert.match(r.kept[0], /cheat/);
});
t('whispering yourself is refused', async () => {
  const w = world();
  const r = await runIn(w, 'whisper botter hi\nkeep($error)');
  eq(w.sent, []);
  assert.match(r.kept[0], /that is you/);
});
t('a dry run sends no chat', async () => {
  const w = world();
  const r = await runIn(w, 'whisper Bob hi\nalliancechat hi\nworldchat hi', { dryRun: true });
  eq(w.sent, []);
  eq((r.text.match(/\[dry run\] not sent/g) || []).length, 3);
});
t('what cannot be sent is refused when the script is loaded', () => {
  assert.match(parseErr('whisper Bob'), /what to say to Bob/);
  assert.match(parseErr('whisper'), /usage {2}whisper <name> <message>/);
  assert.match(parseErr('alliancechat'), /what to say/);
  assert.match(parseErr('worldchat ""'), /what to say/);
});

// ---------------------------------------------------------------------------
section('friends and the block list');

t('addfriend BFF adds a friend; the reply\'s list becomes player.friendBeansArray', async () => {
  const w = world({ replies: { 'friend.addFriend': (d) => ({ ok: 1, friendArr: [{ userName: 'A' }, { userName: d.player }] }) } });
  const r = await runIn(w, 'addfriend BFF\nkeep(player.friendBeansArray.length)\nkeep($error)');
  eq(w.sent, [{ cmd: 'friend.addFriend', data: { player: 'BFF' } }]);
  eq(r.kept, [2, null], r.text);
});
t('friendadd (the RemoteCommands page) is addfriend, and the wiki\'s ! goes', async () => {
  const w = world();
  await runIn(w, 'friendadd SRG\naddfriend !BFF');
  eq(w.sent.map((s) => s.data.player), ['SRG', 'BFF']);
});
t('removefriend ExBFF, block Spammer, unblock Spammer', async () => {
  const w = world();
  const r = await runIn(w, 'removefriend ExBFF\nblock Spammer\nunblock Spammer\nkeep($error)');
  eq(w.sent, [
    { cmd: 'friend.deleteFriend', data: { player: 'ExBFF' } },
    { cmd: 'friend.addBlock', data: { player: 'Spammer' } },
    { cmd: 'friend.deleteBlock', data: { player: 'Spammer' } },
  ]);
  eq(r.kept, [null]);
});
t('block keeps player.blockBeansArray up to date when the reply has no list', async () => {
  const w = world();
  const r = await runIn(w, 'block Spammer\nkeep(player.blockBeansArray.length)\nunblock Pest\nkeep(player.blockBeansArray.length)');
  eq(r.kept, [2, 1], r.text);
});
t('a friend on the block list, or blocking a friend, needs the other list cleared first', async () => {
  const w = world();
  const r = await runIn(w, 'addfriend Pest\nkeep($error)\nblock A\nkeep($error)\naddfriend Botter\nkeep($error)');
  eq(w.sent, []);
  assert.match(r.kept[0], /Pest is on your block list — unblock Pest first/);
  assert.match(r.kept[1], /A is on your friends list — removefriend A first/);
  assert.match(r.kept[2], /that is you/);
});
t('names are exact: no any, * or lists', () => {
  assert.match(parseErr('removefriend any'), /exactly/);
  assert.match(parseErr('block Bob,Fred'), /exactly/);
  assert.match(parseErr('addfriend'), /usage/);
  assert.match(parseErr('addfriend Bob Fred'), /usage/);
});
t('PromoAddFriend (clear the list first): removefriend the first friend until none is left', async () => {
  const w = world({ replies: { 'friend.deleteFriend': (d, g) => ({ ok: 1, friendArr: g.player.friendBeans.filter((f) => f.userName !== d.player) }) } });
  const r = await runIn(w, 'execute "removefriend " + player.friendBeansArray[0].userName\nif player.friendBeansArray.length > 0 loop');
  eq(w.sent.map((s) => [s.cmd, s.data.player]), [['friend.deleteFriend', 'A'], ['friend.deleteFriend', 'B'], ['friend.deleteFriend', 'C']], r.text);
});
t('a dry run sends no friend request', async () => {
  const w = world();
  await runIn(w, 'addfriend BFF\nremovefriend A', { dryRun: true });
  eq(w.sent, []);
});

// ---------------------------------------------------------------------------
section('say and play');

const hear = () => { const got = []; return { got, notify: (m) => { got.push(m); return 1; } }; };
t('say "Your city is under attack." speaks in the console', async () => {
  const w = world(); const h = hear();
  const r = await runIn(w, 'say "Your city is under attack."\nkeep($result)\nkeep($error)', { notify: h.notify });
  eq(h.got, [{ kind: 'say', text: 'Your city is under attack.', lang: null, line: 1, city: 'MyCity' }]);
  eq(r.kept, ['spoken in 1 console tab', null]);
});
t('say "es# Tu ciudad esta siendo atacada." picks the Spanish voice', async () => {
  const w = world(); const h = hear();
  await runIn(w, 'say "es# Tu ciudad esta siendo atacada."', { notify: h.notify });
  eq([h.got[0].lang, h.got[0].text], ['es', 'Tu ciudad esta siendo atacada.']);
});
t('say city.name + " has " + city.NumberOfRealAttacks + " incoming attacks"', async () => {
  const w = world({ player: attacked }); const h = hear();
  await runIn(w, 'say city.name + " has " + city.NumberOfRealAttacks + " incoming attacks"', { notify: h.notify });
  eq(h.got[0].text, 'MyCity has 1 incoming attacks');
});
t('AutoTeleporter: say "Trying to teleport " + city.name + " to " + state', async () => {
  const w = world(); const h = hear();
  await runIn(w, 'state = "Normandy"\nsay "Trying to teleport " + city.name + " to " + state', { notify: h.notify });
  eq(h.got[0].text, 'Trying to teleport MyCity to Normandy');
});
t("say inside a script function reads the function's argument", async () => {
  const w = world(); const h = hear();
  await runIn(w, 'callfunc alert("hi there")\nend\nfunction alert(msg)\nsay msg + "!"\nreturn', { notify: h.notify });
  eq(h.got.map((m) => m.text), ['hi there!']);
});
t('with no console tab open the line says nothing was heard, and still works', async () => {
  const w = world();
  const r = await runIn(w, 'say "hello"\nkeep($result)\nkeep($error)', { notify: () => 0 });
  eq(r.kept, ['no console tab is open — nothing was heard', null]);
  const r2 = await runIn(w, 'say "hello"\nkeep($error)');
  eq(r2.kept, [null]);
  assert.match(r2.text, /no console to hear it through/);
});
t('a dry run speaks and plays nothing', async () => {
  const w = world(); const h = hear();
  await runIn(w, 'say "hello"\nplay alarm.mp3', { notify: h.notify, dryRun: true });
  eq(h.got, []);
});
t('play yourfile.mp3 and play "media/SingleAttack.mp3" play a file from the media folder', async () => {
  const w = world(); const h = hear();
  await runIn(w, 'play yourfile.mp3\nplay "media/SingleAttack.mp3"', { notify: h.notify });
  eq(h.got.map((m) => [m.kind, m.file, m.url]), [['play', 'yourfile.mp3', undefined], ['play', 'media/SingleAttack.mp3', undefined]]);
});
t('play http://yourdomain.com/yourfile.mp3 plays a link (unquoted if the VM keeps //, else it asks for quotes)', async () => {
  const w = world(); const h = hear();
  await runIn(w, 'play "http://yourdomain.com/yourfile.mp3"', { notify: h.notify });
  eq(h.got.map((m) => [m.kind, m.url, m.file]), [['play', 'http://yourdomain.com/yourfile.mp3', undefined]]);
  const v = script.parse('play http://yourdomain.com/yourfile.mp3')[0];
  if (v.cmd === 'error') assert.match(v.error, /quotes/);
  else eq(v.url, 'http://yourdomain.com/yourfile.mp3');
});
t('play never takes a path on this computer', () => {
  assert.match(parseErr('play C:\\sounds\\alarm.mp3'), /not a path/);
  assert.match(parseErr('play ../../secret.mp3'), /not a path/);
  assert.match(parseErr('play /etc/alarm.mp3'), /not a path/);
  assert.match(parseErr('play alarm.exe'), /not a sound file/);
  assert.match(parseErr('play'), /usage/);
});

// ---------------------------------------------------------------------------
section('post');

function fetchStub(reply = { status: 200, statusText: 'OK', body: 'thanks' }) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, ...init });
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply(url, init);
    return { status: reply.status, statusText: reply.statusText, headers: { get: (k) => (reply.headers || {})[k] || null }, text: async () => reply.body };
  };
  return { f, calls };
}
const lookup = (map) => async (host) => { if (!map[host]) { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; } return map[host].map((address) => ({ address })); };
const POST_WIKI = 'message = "This will be posted to file.php"\ndata = {msg:message}\nURL = "http://localhost:8080/file.php"\npost URL data';

t('the Post page: data = {msg:message} / post URL data sends JSON to localhost', async () => {
  const w = world(); const s = fetchStub();
  const r = await runIn(w, POST_WIKI + '\nkeep($result)\nkeep($error)', { fetch: s.f, dnsLookup: lookup({ localhost: ['127.0.0.1'] }) });
  eq(s.calls.length, 1, r.text);
  eq([s.calls[0].url, s.calls[0].method, s.calls[0].headers['content-type'], s.calls[0].body],
    ['http://localhost:8080/file.php', 'POST', 'application/json', '{"msg":"This will be posted to file.php"}']);
  eq(r.kept, ['thanks', null]);
});
t('post /form sends a form, what a PHP page reads from $_POST', async () => {
  const w = world(); const s = fetchStub();
  await runIn(w, POST_WIKI.replace('post URL data', 'post /form URL data'), { fetch: s.f, dnsLookup: lookup({ localhost: ['127.0.0.1'] }) });
  eq([s.calls[0].headers['content-type'], s.calls[0].body], ['application/x-www-form-urlencoded', 'msg=This+will+be+posted+to+file.php']);
});
t('post "https://…" "text" sends text; a status of 400 or more fails with the reply in $result', async () => {
  const w = world(); const s = fetchStub({ status: 500, statusText: 'Internal Server Error', body: 'boom' });
  const r = await runIn(w, 'post "https://example.com/hook" "city " + city.name + " is fine"\nkeep($result)\nkeep($error)',
    { fetch: s.f, dnsLookup: lookup({ 'example.com': ['93.184.216.34'] }) });
  eq([s.calls[0].headers['content-type'], s.calls[0].body], ['text/plain; charset=utf-8', 'city MyCity is fine']);
  eq(r.kept, ['boom', 'HTTP 500 Internal Server Error']);
});
t('a redirect is not followed', async () => {
  const w = world(); const s = fetchStub({ status: 302, statusText: 'Found', body: '', headers: { location: 'http://10.0.0.1/' } });
  const r = await runIn(w, 'post "https://example.com/hook" "x"\nkeep($error)', { fetch: s.f, dnsLookup: lookup({ 'example.com': ['93.184.216.34'] }) });
  eq(s.calls[0].redirect, 'manual');
  assert.match(r.kept[0], /HTTP 302 — example\.com sends it on to http:\/\/10\.0\.0\.1\//);
});
t('link-local, metadata and non-http addresses are refused; private ones on a shared console too', async () => {
  const w = world(); const s = fetchStub();
  const o = { fetch: s.f, dnsLookup: lookup({ 'meta.internal': ['169.254.169.254'], lan: ['192.168.1.5'], localhost: ['127.0.0.1'] }) };
  const r = await runIn(w, 'post "http://169.254.169.254/latest" "x"\nkeep($error)\npost "http://meta.internal/" "x"\nkeep($error)\n'
    + 'post "file:///etc/passwd" "x"\nkeep($error)\npost "http://user:pw@example.com/" "x"\nkeep($error)', o);
  eq(s.calls, []);
  assert.match(r.kept[0], /link-local/);
  assert.match(r.kept[1], /link-local/);
  assert.match(r.kept[2], /only http and https/);
  assert.match(r.kept[3], /no user:password@/);
  const r2 = await runIn(w, POST_WIKI + '\nkeep($error)\npost "http://lan/x" 1\nkeep($error)', { ...o, postPrivate: false });
  eq(s.calls, []);
  assert.match(r2.kept[0], /private address/);
  assert.match(r2.kept[1], /private address/);
});
t('no answer in time fails the line', async () => {
  const w = world();
  const slow = async (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  const r = await runIn(w, 'post "https://example.com/" "x"\nkeep($error)', { fetch: slow, postTimeoutMs: 30, dnsLookup: lookup({ 'example.com': ['93.184.216.34'] }) });
  eq(r.kept, ['no answer in 30 ms']);
});
t('a dry run posts nothing', async () => {
  const w = world(); const s = fetchStub();
  const r = await runIn(w, POST_WIKI, { fetch: s.f, dryRun: true, dnsLookup: lookup({ localhost: ['127.0.0.1'] }) });
  eq(s.calls, []);
  assert.match(r.text, /POST http:\/\/localhost:8080\/file\.php — JSON, \d+ characters\n {2}\[dry run\] not sent/);
});
t('post with nothing after it is refused when loaded', () => {
  assert.match(parseErr('post'), /usage/);
});

// ---------------------------------------------------------------------------
section('command "…" — alliance');

t('the Command page: command "invite NewDude"', async () => {
  const w = world();
  const x = await inline(w, 'invite NewDude');
  eq(w.sent, [{ cmd: 'alliance.addUsertoAlliance', data: { userName: 'NewDude' } }]);
  eq(x.error, null);
});
t('\\accept !NewGuy, \\apply !TuffGuys, \\invite !NewMember, \\join !TuffGuys', async () => {
  const w = world();
  await runIn(w, 'command "\\\\accept !NewGuy"\ncommand "\\\\apply !TuffGuys"\ncommand "\\\\invite !NewMember"\ncommand "\\\\join !TuffGuys"');
  eq(w.sent, [
    { cmd: 'alliance.agreeComeinAllianceByLeader', data: { userName: 'NewGuy' } },
    { cmd: 'alliance.userWantInAlliance', data: { allianceName: 'TuffGuys' } },
    { cmd: 'alliance.addUsertoAlliance', data: { userName: 'NewMember' } },
    { cmd: 'alliance.agreeComeinAllianceByUser', data: { castleId: 1, allianceName: 'TuffGuys' } },
  ]);
});
t('\\alliance !TuffGuys shows host, founder, members and prestige', async () => {
  const w = world({ replies: { 'alliance.getAllianceInfo': { ok: 1, leader: 'Boss', creator: 'Old', memberCount: 45, prestigeCount: 123456789, ranking: 12, allinaceInfo: 'We are <b>tuff</b>' } } });
  const x = await inline(w, '\\alliance !TuffGuys');
  eq(w.sent[0], { cmd: 'alliance.getAllianceInfo', data: { allianceName: 'TuffGuys' } });
  eq(x.result, 'Alliance info: TuffGuys, host: Boss, founder: Old, members: 45, prestige: 123456789, rank: 12\nIntroduction: We are tuff');
});
t('\\applicants and \\invites list as CSV', async () => {
  const w = world({ replies: {
    'alliance.agreeComeinAllianceList': { ok: 1, allianceAddPlayerByUserInfoBeanList: [{ userName: 'NewGuy', prestige: 500, rank: 9000, castleCount: 1, inviteTime: at(2011, 4, 23, 9, 5, 0) }] },
    'alliance.addUsertoAllianceList': { ok: 1, allianceAddPlayerInfoBeanList: [{ userName: 'NewMember', prestige: 20, rank: 99, invitePerson: 'Botter', inviteTime: at(2011, 4, 23, 13, 0, 0), state: 'waiting' }] },
  } });
  const a = await inline(w, '\\applicants');
  const b = await inline(w, '\\invites');
  eq(a.result, '"Name","Prestige","Rank","Cities","Applied"\n"NewGuy","500","9000","1","Mon May 23 2011 09:05:00 AM"');
  eq(b.result, '"Name","Prestige","Rank","Invited by","Invited","State"\n"NewMember","20","99","Botter","Mon May 23 2011 01:00:00 PM","waiting"');
  eq(w.cmds(), ['alliance.agreeComeinAllianceList', 'alliance.addUsertoAllianceList']);
});
t('\\createalliance: 8 characters at most (so the wiki\'s !NeatBotRox is refused), from a city with an Embassy of level 2', async () => {
  const w = world();
  const long = await inline(w, '\\createalliance !NeatBotRox');
  assert.match(long.error, /10 characters — an alliance name is 8 at most/);
  const ok = await inline(w, 'createalliance NeatBot');
  eq(w.sent, [{ cmd: 'alliance.createAlliance', data: { castleId: 1, allianceName: 'NeatBot' } }]);
  eq(ok.error, null);
  const w2 = world();
  const low = await inline(w2, 'createalliance NeatBot', { castle: 'ACity' });
  assert.match(low.error, /ACity needs an Embassy of level 2/);
  eq(w2.sent, []);
});
t('\\declare !NiceAlly blue / grey / none; red is war and needs confirm', async () => {
  const w = world();
  const war = await inline(w, '\\declare !BadAlly red');
  assert.match(war.error, /declare BadAlly enemy \(red\): war.*write {2}declare BadAlly red confirm/);
  eq(w.sent, []);
  await runIn(w, 'command "declare !BadAlly red confirm"\ncommand "\\\\declare !NiceAlly blue"\ncommand "declare Meh grey"\ncommand "declare Meh none"');
  eq(w.sent, [
    { cmd: 'alliance.setAllianceFriendship', data: { targetAllianceName: 'BadAlly', type: 3 } },
    { cmd: 'alliance.setAllianceFriendship', data: { targetAllianceName: 'NiceAlly', type: 1 } },
    { cmd: 'alliance.setAllianceFriendship', data: { targetAllianceName: 'Meh', type: 2 } },
    { cmd: 'alliance.dropAllianceFriendshipRelation', data: { targetAllianceName: 'Meh' } },
  ]);
  assert.match((await inline(w, 'declare Meh purple')).error, /not a standing/);
});
t('\\expel !BadMember and \\eject !BadMember need confirm; any and * are never a name', async () => {
  const w = world();
  assert.match((await inline(w, '\\expel !BadMember')).error, /write {2}expel BadMember confirm/);
  assert.match((await inline(w, '\\eject !BadMember')).error, /write {2}expel BadMember confirm/);
  assert.match((await inline(w, 'expel any confirm')).error, /exactly/);
  assert.match((await inline(w, 'expel * confirm')).error, /exactly/);
  eq(w.sent, []);
  await runIn(w, 'command "expel BadMember confirm"\ncommand "eject !Other confirm"');
  eq(w.sent, [{ cmd: 'alliance.kickOutMemberfromAlliance', data: { userName: 'BadMember' } }, { cmd: 'alliance.kickOutMemberfromAlliance', data: { userName: 'Other' } }]);
});
t('\\quitalliance and \\resign need confirm', async () => {
  const w = world();
  assert.match((await inline(w, '\\quitalliance')).error, /leave TuffGuys, which costs 10% of your prestige — write {2}quitalliance confirm/);
  assert.match((await inline(w, '\\resign')).error, /write {2}resign confirm/);
  eq(w.sent, []);
  const r = await runIn(w, 'command "resign confirm"\ncommand "quitalliance confirm"\nkeep(player.playerInfo.alliance)');
  eq(w.cmds(), ['alliance.resignForAlliance', 'alliance.sayByetoAlliance']);
  eq(r.kept, ['']);
});
t('\\sethost !NewLeader and \\setvicehost need confirm; \\setmember, setofficer, setpresbyter set the rank', async () => {
  const w = world();
  assert.match((await inline(w, '\\sethost !NewLeader')).error, /hand the alliance over to NewLeader.*sethost NewLeader confirm/);
  assert.match((await inline(w, '\\setvicehost !BillyJoe')).error, /make BillyJoe Vicehost of the alliance — a vice host can expel members and change their ranks — write {2}setvicehost BillyJoe confirm/);
  assert.match((await inline(w, 'setvicehost Stranger')).error, /setvicehost Stranger confirm/);
  eq(w.sent, []);
  await runIn(w, 'command "sethost !NewLeader confirm"\ncommand "\\\\setmember !BillyJoe"\ncommand "setofficer BillyJoe"\ncommand "\\\\setpresbyter !BillyJoe"\ncommand "\\\\setvicehost !BillyJoe confirm"');
  eq(w.sent, [
    { cmd: 'alliance.resetTopPowerForAlliance', data: { userName: 'NewLeader' } },
    { cmd: 'alliance.setPowerForUserByAlliance', data: { userName: 'BillyJoe', typeId: 8 } },
    { cmd: 'alliance.setPowerForUserByAlliance', data: { userName: 'BillyJoe', typeId: 7 } },
    { cmd: 'alliance.setPowerForUserByAlliance', data: { userName: 'BillyJoe', typeId: 6 } },
    { cmd: 'alliance.setPowerForUserByAlliance', data: { userName: 'BillyJoe', typeId: 5 } },
  ]);
});
t('a refused alliance order sets $error to the server\'s words', async () => {
  const w = world({ replies: { 'alliance.addUsertoAlliance': { ok: -3, errorMsg: 'Officer or higher rank is required' } } });
  const x = await inline(w, 'invite NewDude');
  eq(x.error, 'Officer or higher rank is required');
  eq(x.result, '');
});
t('a dry run describes an order and sends nothing', async () => {
  const w = world();
  const x = await inline(w, 'expel BadMember confirm', { dryRun: true });
  eq(w.sent, []);
  eq(x.error, null);
  assert.match(x.r.text, /expel BadMember from the alliance\n {2}\[dry run\] not sent \(alliance\.kickOutMemberfromAlliance\)/);
});

// ---------------------------------------------------------------------------
section('command "members": NEAT\'s CSV, and the two wiki scripts that read it');

t('\\members lists lord, position, prestige, honor, last login, cities, population', async () => {
  const w = world();
  const x = await inline(w, '\\members');
  const lines = x.result.split('\n');
  eq(lines[0], '"Lord","Position","Prestige","Honor","Last login","Cities","Population"');
  eq(lines[1], '"Member1","Member","2827841","0","Mon May 23 2011 11:30:01 PM","1","1000"');
  eq(lines[2], '"Member2","Presbyter","13632813","10","Mon May 23 2011 11:30:50 PM","2","2000"');
  eq(lines[5], '"Member5","Officer","4304876","40","Mon May 23 2011 11:28:43 PM","5","5000"');
  eq(lines.length, 7);
  eq(w.sent, [{ cmd: 'alliance.getAllianceMembers', data: {} }]);
});
t('PromoAddFriend: command "members" then the regex prints one addfriend line per member', async () => {
  const w = world();
  const r = await runIn(w, '// compliments of Sericom, I think\ncommand "members"\necho $result.replace(/"([^"]+).+/gm, "addfriend $1").split("\\n").splice(1).join("\\n")');
  const echoed = r.out.slice(r.out.findIndex((l) => l.startsWith('line 3:')) + 1).map((l) => l.trim());
  eq(echoed, ['addfriend Member1', 'addfriend Member2', 'addfriend Member3', 'addfriend Member4', 'addfriend Member5', 'addfriend Member6'], r.text);
});
t('SortingMemberList: the CSV becomes objects; sortOn finds the top prestige and the last login', async () => {
  const w = world();
  const src = [
    'command "members"',
    'execute "members = [ " + $result.replace(/^(".*?"),(".*?"),"(.*?)","(.*?)",(".*?"),"(.*?)","(.*?)".*?$/gm, "\\{ lord:$1, position:$2,prestige:$3,honor:$4,lastlogin:date($5),cities:$6,population:$7 \\}").split("\\n").splice(1).join(",\\n") + " ]"',
    '',
    'top = members.sortOn("prestige", 18)[0]',
    'echo "Highest prestige member is " + top.lord + ", prestige=" + FormatNumber(top.prestige)',
    '',
    'last = members.sortOn("lastlogin", 18)[0]',
    'echo "Most recent login is " + last.lord + ", login=" + last.lastlogin',
  ].join('\n');
  const r = await runIn(w, src);
  assert.match(r.text, /Highest prestige member is Member2, prestige=13,632,813/, r.text);
  assert.match(r.text, /Most recent login is Member2, login=Mon May 23 23:30:50 /, r.text);
});

// ---------------------------------------------------------------------------
section('command "…" — who, and the Command page\'s examples');

t('\\who Bob gives NEAT\'s Player info line', async () => {
  const w = world();
  const x = await inline(w, '\\who Bob');
  eq(w.sent, [{ cmd: 'common.getPlayerInfoByName', data: { userName: 'Bob' } }]);
  eq(x.result, 'Player info: bob, alliance: TuffGuys, castle: 1, pres: 3666417, honor: 0, rank: 123, pos: Captain, title: Knight, pop: 45678');
  eq(x.error, null);
});
t('the Command page: var = "SomeDude" / command "who " + var; an unknown player is $error', async () => {
  const w = world();
  const r = await runIn(w, 'var = "SomeDude"\ncommand "who " + var\nkeep($error)\nvar = "Huge"\ncommand "who " + var\nkeep($result)');
  eq(w.sent.map((s) => s.data.userName), ['SomeDude', 'Huge']);
  eq(r.kept, ['The player does not exist', 'Player info: Huge, alliance: Giants, castle: 3, pres: 3000000, honor: 5, rank: 7, pos: General, title: Prinzessin, pop: 90000']);
});
t("the heartbeat's answer about us is not taken for someone else's", async () => {
  let n = 0;
  const w = world({ replies: { 'common.getPlayerInfoByName': () => (n++ === 0 ? { ok: 1, playerInfo: { userName: 'Botter' } } : { ok: 1, playerInfo: PLAYERS.bob }) } });
  const x = await inline(w, 'who Bob');
  eq(w.sent.length, 2);
  assert.match(x.result, /^Player info: bob,/);
});
t("the Command page: jay777's inactive-account finder reads who's fields by position", async () => {
  const w = world();
  const src = [
    'distance = 20',
    'castles = AllCastles(GetFieldId(city.x - distance, city.y - distance), GetFieldId(city.x + distance, city.y + distance))',
    'i=0',
    'label next',
    '@command "who " + castles[i].userName',
    'if $error goto next',
    'if $result.split(\',\')[2].split(" ")[2] = 1 if $result.split(\',\')[8].split(" ")[2] = 0 echo "Found " + castles[i].userName + " at " + FieldIdToCoords(castles[i].id)',
    'i = i + 1',
    'if i < castles.length goto next',
    'echo "All done"',
  ].join('\n');
  const until = Date.now() + 5000;
  const r = await runIn(w, src, { shouldStop: () => Date.now() > until });
  assert.match(r.text, /Found Idle1 at 100,210/, r.text);
  eq(w.sent.map((x) => x.data.userName), ['Idle1', 'Botter', 'BadGuy']);
  assert.doesNotMatch(r.text, /Found Botter/);
  assert.match(r.text, /All done/);
});
t('the Command page: command "quickarmyreport" / echo $result', async () => {
  const w = world();
  const r = await runIn(w, 'command "quickarmyreport"\necho $result');
  const echoed = r.out.slice(r.out.findIndex((l) => l.startsWith('line 2:')) + 1).map((l) => l.trim());
  eq(echoed, [
    'Page: 1/6',
    "[10612]ATT Attack Reports from ACity(111,111) to Barbarian's city(111,112) on Mon May 23 2011 09:27:33 PM",
    "[10634]ATT Attack Reports from AnotherCity(111,222) to Barbarian's city(111,223) on Mon May 23 2011 09:02:48 PM",
  ], r.text);
  eq(w.sent, [{ cmd: 'report.receiveReportList', data: { pageNo: 1, pageSize: 10, reportType: 1 } }]);
});
t('an in-line command nobody has is $error, and lists the ones there are', async () => {
  const w = world();
  const x = await inline(w, 'frobnicate now');
  assert.match(x.error, /there is no in-line command "frobnicate" — there are: accept, alliance/);
});

// ---------------------------------------------------------------------------
section('command "…" — reports and mail');

t('\\quickarmyreport 2 asks for page 2', async () => {
  const w = world();
  const x = await inline(w, '\\quickarmyreport 2');
  eq(w.sent[0].data, { pageNo: 2, pageSize: 10, reportType: 1 });
  assert.match(x.result, /^Page: 2\/6\n\[10612\]ATT/);
});
t('\\armyreport 2 opens each report: Info, attackers and defenders as code:left/total', async () => {
  const w = world();
  const x = await inline(w, '\\armyreport 2');
  eq(w.cmds(), ['report.receiveReportList', 'report.markAsRead', 'report.markAsRead']);
  eq(w.sent[1].data, { reportId: 10612 });
  const lines = x.result.split('\n');
  eq(lines[0], 'Page: 2/6');
  eq(lines[1], "ATT Attack Reports on Mon May 23 2011 09:27:33 PM from ACity(111,111) to Barbarian's city(111,112)");
  assert.ok(lines.includes('Info: The Loyalty of this city is 88.'), x.result);
  assert.ok(lines.includes('attackers: t:0/400, b:0/550'), x.result);
  assert.ok(lines.includes('defenders: rl:0/750, at:1250/1250, w:750/750'), x.result);
  assert.ok(lines.indexOf('Info: The Loyalty of this city is 88.') < lines.indexOf('attackers: t:0/400, b:0/550'));
});
t('a dry-run armyreport lists the page but opens nothing (opening marks a report read)', async () => {
  const w = world();
  const x = await inline(w, 'armyreport', { dryRun: true });
  eq(w.cmds(), ['report.receiveReportList']);
  assert.match(x.result, /not opened — opening one marks it read/);
});
t('\\readreport 10565 shows the report and its battle-log link', async () => {
  const w = world();
  const x = await inline(w, '\\readreport 10565');
  eq(w.sent, [{ cmd: 'report.markAsRead', data: { reportId: 10565 } }]);
  assert.match(x.result, /^ATT Attack Reports on Mon May 23 2011 04:27:04 PM from MyCity\(111,333\) to Barbarian's city\(111,334\)\nInfo: /);
  assert.match(x.result, /\nurl: http:\/\/battless71\.evony\.com\/default\.html\?logfile\/20260913\/26\/b8\/abc\.xml$/);
  assert.match((await inline(w, 'readreport soon')).error, /usage/);
});
t('\\warreport 2 lists the alliance\'s war reports with their details', async () => {
  const w = world({ replies: { 'alliance.getMilitarySituationList': (d) => ({ ok: 1, pageNo: d.pageNo, totalPage: 1018, situations: [
    { id: 1, attack: true, otherAllianceName: null, eventName: 'Guy Attack City(111,222)', time: at(2011, 4, 23, 23, 43, 53), startPos: 'Town(222,333) Guy', targetPos: 'Town(222,222) EnemyGuy', xml_data: BATTLE },
  ] }) } });
  const x = await inline(w, '\\warreport 2');
  eq(w.sent, [{ cmd: 'alliance.getMilitarySituationList', data: { pageNo: 2, pageSize: 10 } }]);
  const lines = x.result.split('\n');
  eq(lines.slice(0, 2), ['Page: 2/1018', 'ATT null Guy Attack City(111,222) on Mon May 23 2011 11:43:53 PM from Town(222,333) Guy to Town(222,222) EnemyGuy']);
  assert.ok(lines.includes('attackers: t:0/400, b:0/550'), x.result);
});
t('\\listmail 2 shows each mail as NEAT did, opening it', async () => {
  const w = world();
  const x = await inline(w, '\\listmail 2');
  eq(w.sent, [
    { cmd: 'mail.receiveMailList', data: { pageNo: 2, type: 1, pageSize: 10 } },
    { cmd: 'mail.readMail', data: { mailId: 501 } },
    { cmd: 'mail.readMail', data: { mailId: 502 } },
  ]);
  eq(x.result, ['Page: 2/6', '[501:MyFriend>Botter] hello on Mon May 23 2011@04:42:17 PM', "hiya, just reminding you I'll be holidaying this week",
    '[502:SomeHost>Botter] Can we Talk? on Mon May 23 2011@12:11:41 PM', 'I am SomeHost of alliance TuffGuys.\nCan we talk!'].join('\n'));
});
t('\\listsentmail 2 and \\listsystemmail 2 read the other boxes; a dry run opens none', async () => {
  const w = world();
  await inline(w, '\\listsentmail 2');
  await inline(w, '\\listsystemmail 2');
  eq(w.sent.filter((s) => s.cmd === 'mail.receiveMailList').map((s) => s.data.type), [3, 2]);
  const w2 = world();
  await inline(w2, 'listmail', { dryRun: true });
  eq(w2.cmds(), ['mail.receiveMailList']);
});
t('\\mail !MyFriend holiday have a good holiday!', async () => {
  const w = world();
  const x = await inline(w, '\\mail !MyFriend holiday have a good holiday!');
  eq(w.sent, [{ cmd: 'mail.sendMail', data: { username: 'MyFriend', title: 'holiday', content: 'have a good holiday!' } }]);
  eq(x.error, null);
  await inline(w, 'mail Bob "two words" body text');
  eq(w.sent[1].data, { username: 'Bob', title: 'two words', content: 'body text' });
  assert.match((await inline(w, 'mail Bob subject')).error, /the mail cannot be empty/);
});
t('mail waits out the game\'s 5 seconds between mails', async () => {
  const w = world();
  const t0 = Date.now();
  await runIn(w, 'command "mail Bob a one"\ncommand "mail Bob b two"', { mailGapMs: 120 });
  assert.ok(Date.now() - t0 >= 110, 'waited');
  eq(w.sent.length, 2);
});

// ---------------------------------------------------------------------------
section('command "…" — lookups');

t('\\searchcastle !TuffGuys / !MyCity / Bob print NEAT\'s search blocks', async () => {
  const w = world();
  const a = await inline(w, '\\searchcastle !TuffGuys');
  eq(a.result.split('\n'), [
    '===search castle for TuffGuys===',
    'Coords, State, Distance, Castle, Owner, Alliance, Prestige, Honor',
    'Castle 10(111,222), peace, 0 miles, MyCity, Botter TuffGuys, pres 14997337, honor 212942',
    'Castle 10(111,333), peace, 111 miles, ACity, Botter TuffGuys, pres 14997337, honor 212942',
    '===end search===',
  ]);
  const b = await inline(w, '\\searchcastle !MyCity');
  eq(b.result.split('\n').length, 4);
  const c = await inline(w, '\\searchcastle Bob');
  eq(c.result.split('\n'), ['===search castle for Bob===', 'Coords, State, Distance, Castle, Owner, Alliance, Prestige, Honor', '===end search===']);
  eq(w.sent, []);
});
t('\\searchenemies 25 lists enemy castles nearest first', async () => {
  const w = world();
  const x = await inline(w, '\\searchenemies 25');
  eq(x.result.split('\n'), ['===Enemy castles===', 'Coords, State, Distance, Castle, Owner, Alliance, Prestige, Honor',
    'Castle 10(115,226), peace, 5.66 miles, HisCity, BadGuy SomeReds, pres 5026954, honor 3392049', '===end search===']);
});
t('\\listcastles 101,100 110,105 [30] [2000000]', async () => {
  const w = world();
  const a = await inline(w, '\\listcastles 101,100 110,105');
  eq(a.result.split('\n').slice(2, -1).map((l) => l.split(', ')[3]), ['Big', 'Small']);
  const b = await inline(w, '\\listcastles 101,100 110,105 30');
  eq(b.result.split('\n').length, 5);
  const c = await inline(w, '\\listcastles 101,100 110,105 30 2000000');
  eq(c.result.split('\n').slice(2, -1), ['Castle 9(108,104), peace, 118.04 miles, Big, Huge Giants, pres 3000000, honor 0']);
  assert.match((await inline(w, 'listcastles 101,100')).error, /usage/);
});
t('\\loc 111,222 and the wiki\'s Barbarian city line', async () => {
  const w = world();
  const a = await inline(w, '\\loc 111,223');
  eq(a.result, "Location: 111,223: NPC 5(111,223) peace, Barbarian's city LOWER LORRAINE, belongs to none");
  const b = await inline(w, '\\loc 111,222');
  eq(b.result, 'Location: 111,222: Castle 10(111,222) peace, MyCity LOWER LORRAINE, belongs to Botter (TuffGuys)');
  assert.match((await inline(w, 'loc 5,5')).error, /nothing is known about 5,5/);
});
t('\\searchheroes * atk 1 pages the hero stats, as the wiki prints them', async () => {
  const w = world({ replies: { 'rank.getHeroRank': (d) => ({ ok: 1, pageNo: d.pageNo, totalPage: 8782, beans: [
    { rank: 991, name: 'virgatt', kind: 'Lemsip', grade: 157, power: 224, stratagem: 14, management: 63 },
    { rank: 992, name: 'ABuch79', kind: 'Noobei', grade: 145, power: 224, stratagem: 26, management: 49 },
  ] }) } });
  const x = await inline(w, '\\searchheroes * atk 100');
  eq(w.sent, [{ cmd: 'rank.getHeroRank', data: { key: null, pageNo: 100, pageSize: 10, sortType: 3 } }]);
  eq(x.result.split('\n'), ['Page 100 of 8782 Pages', '"Rank","Name","Owner","Level","Atk","Int","Pol"',
    '"991","virgatt","Lemsip","157","224","14","63"', '"992","ABuch79","Noobei","145","224","26","49"']);
  await inline(w, 'searchheroes Bess int');
  eq(w.sent[1].data, { key: 'Bess', pageNo: 1, pageSize: 10, sortType: 4 });
  await inline(w, '\\searchheroes * atk 1');
  eq(w.sent[2].data, { key: null, pageNo: 1, pageSize: 10, sortType: 3 });
  assert.match((await inline(w, 'searchheroes * speed')).error, /usage/);
});
t('\\searchalliances * prestige 10', async () => {
  const w = world({ replies: { 'rank.getAllianceRank': (d) => ({ ok: 1, pageNo: d.pageNo, totalPage: 40, beans: [
    { rank: 91, name: 'TuffGuys', playerName: 'Boss', createrName: 'Old', member: 45, city: 120, prestige: 123456789, honor: 5 },
  ] }) } });
  const x = await inline(w, '\\searchalliances * prestige 10');
  eq(w.sent, [{ cmd: 'rank.getAllianceRank', data: { key: null, pageNo: 10, pageSize: 10, sortType: 2 } }]);
  eq(x.result.split('\n'), ['Page 10 of 40 Pages', '"Rank","Name","Host","Founder","Members","Cities","Prestige","Honor"',
    '"91","TuffGuys","Boss","Old","45","120","123456789","5"']);
  await inline(w, 'searchalliances Tuff members');
  eq(w.sent[1].data, { key: 'Tuff', pageNo: 1, pageSize: 10, sortType: 1 });
});
t('listallheroes: every hero in every city', async () => {
  const w = world();
  const x = await inline(w, 'listallheroes');
  eq(x.result.split('\n'), ['MyCity Queen Lvl:193 [P:254 A:67 I:21] exp:4737560/3724900', 'ACity Farmer1 Lvl:297 [P:27 A:363 I:21] exp:10180331/8820900']);
  eq(w.sent, []);
});

// ---------------------------------------------------------------------------
section('command "holiday"');

t('\\holiday 3 needs a number of days and confirm; /autoextend is refused (it renews until the coins run out)', async () => {
  const w = world();
  w.g.c.passwordHash = () => 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';
  assert.match((await inline(w, '\\holiday')).error, /for how many days\? \(2 or more\) — holiday 3 confirm/);
  assert.match((await inline(w, '\\holiday 3')).error, /on holiday for 3 days — the account goes off-line for days.*write {2}holiday 3 confirm/);
  assert.match((await inline(w, 'holiday 1 confirm')).error, /2 days at least/);
  // /autoextend (the user, 2026-09-20) renews the holiday until the coins run out: it still
  // needs the day count and confirm, and the line it suggests carries the switch
  assert.match((await inline(w, '\\holiday /autoextend')).error, /for how many days\? \(2 or more\) — holiday 3 \/autoextend confirm/);
  assert.match((await inline(w, 'holiday 7 /autoextend')).error, /renewing itself until the coins run out.*write {2}holiday 7 \/autoextend confirm/);
  eq(w.sent, []);
});
t('holiday <days> confirm /autoextend sends the game\'s own isAutoFurlough flag', async () => {
  const w = world();
  w.g.c.passwordHash = () => 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';
  await runIn(w, 'command "holiday 3 /autoextend confirm"\ncommand "holiday 5 /auto confirm"');
  eq(w.sent, [
    { cmd: 'furlough.isFurlought', data: { playerId: 777, day: 3, password: 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3', isAutoFurlough: true } },
    { cmd: 'furlough.isFurlought', data: { playerId: 777, day: 5, password: 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3', isAutoFurlough: true } },
  ]);
});
t('without the login\'s password hash (goals/integration) holiday says so', async () => {
  const w = world();
  assert.match((await inline(w, 'holiday 3 confirm')).error, /goals update \(goals\/integration\)/);
  eq(w.sent, []);
});
t('holiday 3 confirm sends furlough.isFurlought, never renewing; \\holiday /exit ends it', async () => {
  const w = world();
  w.g.c.passwordHash = () => 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';
  const r = await runIn(w, 'command "holiday 3 confirm"\ncommand "holiday 7 confirm"\ncommand "\\\\holiday /exit"\nkeep($error)');
  eq(w.sent, [
    { cmd: 'furlough.isFurlought', data: { playerId: 777, day: 3, password: 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3', isAutoFurlough: false } },
    { cmd: 'furlough.isFurlought', data: { playerId: 777, day: 7, password: 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3', isAutoFurlough: false } },
    { cmd: 'furlough.cancelFurlought', data: { playerId: 777 } },
  ]);
  eq(r.kept, [null]);
  assert.doesNotMatch(r.text, /a94a8fe5/, 'the hash is never logged');
});

// ---------------------------------------------------------------------------
section('small pieces');

t("neatTime is NEAT's stamp, and date() reads it back", () => {
  const ms = at(2011, 4, 23, 23, 30, 1);
  eq(S._test.neatTime(ms), 'Mon May 23 2011 11:30:01 PM');
  eq(S._test.neatTime(at(2011, 4, 23, 0, 5, 9), '@'), 'Mon May 23 2011@12:05:09 AM');
  eq(Date.parse(S._test.neatTime(ms)), ms);
});
t('ipKind', () => {
  const k = S._test.ipKind;
  eq(['169.254.169.254', '0.0.0.0', '224.0.0.1', '::', 'fe80::1'].map(k), ['blocked', 'blocked', 'blocked', 'blocked', 'blocked']);
  eq(['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.9', '100.64.0.1', '::1', 'fd00::5', '::ffff:10.0.0.1'].map(k), Array(8).fill('private'));
  eq(['93.184.216.34', '172.32.0.1', '2606:4700::1111'].map(k), ['public', 'public', 'public']);
});
t('every in-line command on the wiki is in the table', () => {
  const names = ['accept', 'alliance', 'applicants', 'apply', 'createalliance', 'declare', 'expel', 'invite', 'invites', 'join', 'members',
    'quitalliance', 'resign', 'sethost', 'setmember', 'setofficer', 'setpresbyter', 'setvicehost', 'holiday', 'armyreport', 'quickarmyreport',
    'readreport', 'warreport', 'listmail', 'listsentmail', 'listsystemmail', 'mail', 'listallheroes', 'listcastles', 'loc', 'searchalliances',
    'searchcastle', 'searchenemies', 'searchheroes', 'who'];
  eq(names.length, 35);
  for (const n of names) assert.ok(S.inline[n] && typeof S.inline[n].run === 'function', n);
  eq(S.inline.expel.aliases, ['eject']);
});

// ---------------------------------------------------------------------------
(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n + '\n'); continue; }
    try { await f(); console.log('  ok    ' + n); pass++; }
    catch (e) { console.log('  FAIL  ' + n + '\n        ' + String(e.message).split('\n').join('\n        ')); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
