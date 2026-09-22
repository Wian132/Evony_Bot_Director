'use strict';
// Social commands for scripts (the command-module contract is at the top of
// script.js): chat, friends, speech and sound, posting to the web, and NEAT's
// in-line commands (`command "who Bob"`).
//
//   whisper Bob Hello friend!              a private message
//   alliancechat Help, I have 5 waves coming to 400,123
//   worldchat Hello world!                 costs one Speaker a line (the game's rule), 10 s apart
//   addfriend BFF | friendadd BFF | removefriend ExBFF | block Spammer | unblock Spammer
//   say "Your city is under attack."       spoken in an open console tab
//   say "es# Tu ciudad esta siendo atacada."   a two-letter language code first picks the voice
//   say city.name + " has " + city.NumberOfRealAttacks + " incoming attacks"
//   play alarm.mp3 | play "media/SingleAttack.mp3" | play "https://example.com/alarm.mp3"
//   post URL data | post "https://example.com/hook" "some text" | post /form URL data
//   command "who " + name                  an in-line command (below); its text in $result
//
// Chat lines go out as written (NEAT: "expressions do not work with this"):
// build one with execute, or put {expr} in it, and quote a line that holds a
// link, since // starts a comment. A line longer than the chat box's 150
// characters goes out in parts, four at most (world chat refuses it instead:
// every part would cost a Speaker). A line counts as sent when the server says
// ok or it comes back in chat; no answer and no echo within 8 s fails the line.
// The game's client never sends a line with "cheat" in it, and neither does this.
//
// say / play reach the console through opts.notify ({kind:'say', text, lang}
// or {kind:'play', url | file}); with no console tab open nothing is heard, and
// the line says so. play takes a file from the console's media folder or an
// http(s) link, never a path on this computer.
// post is http(s) only. An object or array goes as JSON, anything else as text;
// /form sends a flat object as a form (what a PHP page reads from $_POST).
// 15 s timeout; $result is the reply's text (up to 100 kB); an HTTP status of
// 400 or more fails the line, and a redirect is not followed. Link-local and
// unspecified addresses are always refused; loopback and private ones too on a
// console other people sign in to (BIND set to a non-loopback address).
//
// In-line commands, `command "<name> <args>"` (NEAT's InLineCommands page; a
// leading \ and the wiki's ! in front of a name are both fine):
//   alliance  accept <name> | alliance <name> | applicants | apply <alliance>
//             createalliance <name>   (8 characters at most, an Embassy of level 2, 10,000 gold)
//             declare <alliance> red|blue|grey|none   (red is war: it takes confirm)
//             expel <name> confirm | eject <name> confirm | invite <name> | invites
//             join <alliance> | members | quitalliance confirm | resign confirm
//             sethost <name> confirm | setvicehost <name> confirm | setmember | setofficer | setpresbyter
//   account   holiday <days> confirm | holiday /exit    (/autoextend is refused: it renews the
//             holiday until the coins run out, and scripts spend coins only through buyitem)
//   reports   armyreport [page] | quickarmyreport [page] | readreport <id> | warreport [page]
//   mail      listmail [page] | listsentmail [page] | listsystemmail [page]
//             mail <name> <subject> <text>   (a subject with spaces goes in quotes)
//   lookups   listallheroes | listcastles x,y x,y [max] [min prestige] | loc x,y
//             searchalliances <name>|* [members|prestige|honor] [page]
//             searchcastle <alliance|city|lord> | searchenemies <max>
//             searchheroes <name>|* lvl|atk|pol|int [page] | who <name>
// Their text is shaped as NEAT printed it, so its scripts can split it: members
// is CSV with a header line ("Lord","Position","Prestige","Honor","Last login",
// "Cities","Population"); who is "Player info: bob, alliance: X, castle: 1,
// pres: ..., honor: ..., rank: ..., pos: ..., title: ..., pop: ...". Times are
// this machine's ("Mon May 23 2011 11:30:01 PM"), which date("...") reads back.
// Leaving the alliance, resigning, handing over the host, making a vice host
// (who can expel members), expelling, declaring war and going on holiday are
// never one typo away: each needs the word confirm
// at the end, and a name must be exact (no any, *, or lists).
// A dry run sends nothing that changes anything. Lookups still read, so $result
// is real; opening mail or a report marks it read, so a dry run only lists them.
//
// Requests, from the decompiled client (src/scripts/...; each is cited again
// where it is sent). None of the alliance, friend, rank or furlough ones has
// been sent by OTTObot before.
//   common.privateChat {targetName, msg}           CommonCommands.as:90   ChatContentData.as:239
//   common.allianceChat {msg, languageType}        CommonCommands.as:172  ChatContentData.as:295
//   common.worldChat {msg, languageType}           CommonCommands.as:133  ChatContentData.as:278
//   common.getPlayerInfoByName {userName}          CommonCommands.as:121
//   friend.addFriend / deleteFriend / addBlock / deleteBlock {player}   FriendCommands.as:27-89
//   alliance.* (AllianceCommands.as, AllianceManagementCommands.as)  see the in-line table
//   furlough.isFurlought / cancelFurlought         FurloughCommands.as:21-50
//   rank.getAllianceRank / getHeroRank             RankCommands.as:48-88
//   mail.* / report.* through game.js (MailCommands.as, ReportCommands.as)
const dns = require('dns');
const net = require('net');
const C = require('./constants');
const E = require('./script-expr');
const MB = require('./mailbox');

const REPLY_MS = 12000;
const CHAT_MAX = 150;              // ChatFrame.as:438, the chat box's maxChars
const CHAT_PARTS = 4;
const CHAT_WAIT_MS = 8000;         // as session.sendChat waits
const WORLD_GAP_MS = 10000;        // ChatFrame.as:569, spaceSentTimer: one world line in 10 s
const SPEAKER = 'consume.1.a';     // ChatFrame.as:1341: a world line needs a Speaker
const PAGE = 10;                   // the rank, mail and report windows show 10 a page
const POST_TIMEOUT_MS = 15000;
const POST_MAX_REPLY = 100000;
const POST_MAX_BODY = 1000000;

// ------------------------------------------------------------------ words

const lc = (s) => String(s == null ? '' : s).toLowerCase();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const p2 = (n) => String(n).padStart(2, '0');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

// Words, where "double" or 'single' quotes keep spaces (the quotes go). An
// apostrophe inside a word (I'm) is just a letter.
const WORD_RE = /"([^"]*)"|'([^']*)'|(\S+)/g;
const words = (text) => [...String(text == null ? '' : text).matchAll(WORD_RE)].map((m) => m[1] ?? m[2] ?? m[3]);

// The first word and the rest of the text as written.
function firstWord(text) {
  const s = String(text == null ? '' : text).trim();
  const m = /^"([^"]*)"(?:\s+|$)|^'([^']*)'(?:\s+|$)|^(\S+)\s*/.exec(s);
  if (!m) return { word: '', rest: '' };
  return { word: m[1] ?? m[2] ?? m[3], rest: s.slice(m[0].length).trim() };
}

// A player or alliance name as written. The wiki writes !Name — MoinMoin's
// escape for a CamelCase word, which the page shows as Name — so a ! goes.
const nameOf = (w) => String(w == null ? '' : w).trim().replace(/^!(?=\S)/, '');

// A name an order acts on: exact, never a pattern or a list.
function exactName(word, what) {
  const n = nameOf(word);
  if (!n) throw new Error(`${what}: whose name?`);
  if (lc(n) === 'any' || /[*?,]/.test(n)) throw new Error(`${what}: name the player or alliance exactly — "${n}" is not one name`);
  if (n.length > 40) throw new Error(`${what}: "${n.slice(0, 20)}…" is too long for a name`);
  return n;
}

// A trailing `confirm`, taken off the words.
function takeConfirm(list) {
  const toks = list.slice();
  const confirmed = toks.length > 0 && lc(toks[toks.length - 1]) === 'confirm';
  if (confirmed) toks.pop();
  return { toks, confirmed };
}

// "hi!" -> hi!  (the wiki's `alliancechat "hi!"`: a chat line in quotes)
function unquote(s) {
  const t = String(s == null ? '' : s).trim();
  const m = /^"([^"]*)"$/.exec(t);
  return m ? m[1] : t;
}

const csv = (...vals) => vals.map((v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',');

// A page number (1 when none is given), or null for anything else.
function pageOf(list) {
  if (!list.length) return 1;
  if (list.length > 1 || !/^\d+$/.test(list[0]) || Number(list[0]) < 1) return null;
  return Number(list[0]);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// NEAT's time stamps, in this machine's time: "Mon May 23 2011 11:30:01 PM";
// mail headers put an @ before the clock. date("Mon May 23 2011 11:30:01 PM")
// in a script reads one back.
function neatTime(ms, at = ' ') {
  const t = Number(ms);
  if (!t) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const h = d.getHours();
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${p2(d.getDate())} ${d.getFullYear()}${at}`
    + `${p2(h % 12 || 12)}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${h < 12 ? 'AM' : 'PM'}`;
}

// PlayerInfoTypeManager.getTitle (titleId 0-9; a lady lord, sex 1, gets the
// female form, as session.js shows it) and getOffice (office 0-5).
const TITLES = [['Civilian', 'Civilian'], ['Knight', 'Dame'], ['Baronet', 'Baronetess'], ['Baron', 'Baroness'],
  ['Viscount', 'Viscountess'], ['Earl', 'Countess'], ['Marquis', 'Marchioness'], ['Duke', 'Duchess'],
  ['Furst', 'Furstin'], ['Prinz', 'Prinzessin']];
const OFFICES = ['Civilian', 'Lieutenant', 'Captain', 'Major', 'Colonel', 'General'];
const titleName = (id, sex) => (TITLES[num(id)] || [])[num(sex) === 1 ? 1 : 0] || '';
const officeName = (o) => (o === undefined || o === null ? '' : /^\d+$/.test(String(o)) ? OFFICES[Number(o)] || String(o) : String(o));

// A member's alliance rank, PlayerInfoBean.levelId: AllianceConstants.as:13-27
// (TOP_POWER 4 host, TOP2 5 vice host, MIDDLE 6 presbyter, MIDDLE2 7 officer,
// LAST 8 member), the ranks AllianceMemberInfoShow.as:78-90 offers.
const POSITIONS = { 4: 'Host', 5: 'Vicehost', 6: 'Presbyter', 7: 'Officer', 8: 'Member' };
const RANK_TYPE = { setvicehost: 5, setpresbyter: 6, setofficer: 7, setmember: 8 };

// declare's words -> AllianceConstants FRIEND 1, MIDDLE 2, ENEMY 3 (Diplomatic.as:501-507)
const STANDING = {
  red: 'red', enemy: 'red', war: 'red', hostile: 'red',
  blue: 'blue', ally: 'blue', friend: 'blue', friendly: 'blue',
  grey: 'grey', gray: 'grey', neutral: 'grey',
  none: 'none', clear: 'none', drop: 'none', remove: 'none',
};
const STANDING_TYPE = { red: 3, blue: 1, grey: 2 };
const STANDING_WORD = { red: 'enemy (red)', blue: 'friendly (blue)', grey: 'neutral (grey)' };

// A report's units as NEAT's lines write them: the troop codes, and the
// fortifications as its status line prints them (tr ab at rl dt).
const UNIT_CODE = { ...Object.fromEntries(C.TROOPS.map((t) => [t.typeId, t.code])), 14: 'tr', 15: 'ab', 16: 'at', 17: 'rl', 18: 'dt' };

// ------------------------------------------------------------------ the game

const playerOf = (g) => (g && g.player) || {};
const infoOf = (g) => playerOf(g).playerInfo || {};
const myName = (g) => String(infoOf(g).userName || '');
const castleName = (env) => { try { return env.castle.name || ''; } catch { return ''; } };
const hereXY = (env) => { try { return C.fieldIdToCoords(Number(env.castle.fieldId)); } catch { return null; } };

// A refusal before anything is sent: logged, and the line fails with it.
function bad(env, msg) {
  env.log('  ' + msg);
  return { ok: false, error: msg, result: '' };
}

// A request whose reply must say ok: { r } or { fail } (what the line returns).
async function askFn(env, fn) {
  let r;
  try { r = await fn(); } catch (e) {
    env.log(`  -> ${e.message}`);
    return { fail: { ok: false, error: e.message, result: '' } };
  }
  if (!r || Number(r.ok) !== 1) {
    const v = env.say(r);
    env.log('  -> ' + v);
    return { fail: { ok: false, done: 1, error: (r && r.errorMsg) || v, result: '' } };
  }
  return { r };
}
const ask = (env, cmd, data, ms = REPLY_MS) => askFn(env, () => env.game.req(cmd, data, ms));

// An order that changes something: described, and in a dry run not sent.
async function order(env, what, cmd, data) {
  env.log('  ' + what);
  if (env.dryRun) { env.log(`  [dry run] not sent (${cmd})`); return {}; }
  const { fail } = await ask(env, cmd, data);
  if (fail) return fail;
  env.log('  -> ok');
  return { done: 1, sent: true };
}

// The console's Mail and Reports windows send the same requests, and a reply
// names nothing but its command, so they take turns (session.mrQueue).
const mrQueue = (env, fn) => (env.session && typeof env.session.mrQueue === 'function' ? env.session.mrQueue(fn) : fn());

function listOut(env, lines, done = 1) {
  for (const l of lines) for (const x of String(l).split('\n')) env.log('  ' + x);
  return { done, result: lines.join('\n') };
}

// At most one of `key` per gap in a run (a wait, cut short by Stop).
async function pace(env, key, gapMs) {
  const st = env.state;
  st.last = st.last || {};
  const wait = (st.last[key] || 0) + gapMs - Date.now();
  if (wait > 0) await env.pause(wait);
  st.last[key] = Date.now();
}

// Our alliance as the login knows it: kept up to date after join, create and
// quit, as the client's Context is.
function setAlliance(env, name) {
  const info = infoOf(env.game);
  if (env.game && env.game.player && env.game.player.playerInfo) info.alliance = name;
  const s = env.session;
  if (s && s.diplo) s.diplo = { ...s.diplo, at: 0 };        // diplomacy() reads it again next time
}

// ------------------------------------------------------------------ chat

// A text in parts of at most `max` characters, cut between words.
function chatParts(text, max = CHAT_MAX) {
  const out = [];
  let s = String(text).trim();
  while (s.length > max) {
    let cut = s.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(s.slice(0, cut).trim());
    s = s.slice(cut).trim();
  }
  if (s) out.push(s);
  return out;
}

// What a chat push says, as text: tags gone, entities read, spaces single.
const heard = (s) => MB.decodeEntities(String(s == null ? '' : s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

// Send one chat line and wait for the server's answer or our own line coming
// back in chat (the server echoes it, session.js:707), whichever comes first.
async function chatOut(env, cmd, data, text) {
  const g = env.game;
  const me = lc(myName(g));
  const c = g && g.c && typeof g.c.on === 'function' && typeof g.c.off === 'function' ? g.c : null;
  const want = String(text).replace(/\s+/g, ' ').trim();
  let listener = null;
  const echoed = new Promise((resolve) => {
    if (!c || !me) return;
    listener = (name, d) => {
      if (!d || !/^server\.\w*chat/i.test(String(name))) return;
      const from = lc(d.fromUser || d.userName || d.senderName || d.name || '');
      if (from === me && heard(d.msg) === want) resolve({ echo: true });
    };
    c.on('cmd', listener);
  });
  const replied = Promise.resolve()
    .then(() => g.req(cmd, data, env.opts.chatWaitMs ?? CHAT_WAIT_MS))
    .then((r) => ({ r }), (e) => ({ e }));
  try {
    return await Promise.race([replied, echoed]);
  } finally { if (listener) c.off('cmd', listener); }
}

const speakersHeld = (g) => (playerOf(g).items || []).filter((i) => i && i.id === SPEAKER).reduce((n, i) => n + num(i.count), 0);

const CHAT = {
  whisper: { where: (a) => `to ${a.to}`, gap: 'chat' },
  alliancechat: { where: () => 'to alliance chat', gap: 'chat' },
  worldchat: { where: () => 'to world chat', gap: 'world' },
};

async function runChat(a, env) {
  const kind = a.cmd;
  const g = env.game;
  const text = a.msg;
  env.log(`  ${CHAT[kind].where(a)}: ${text}`);
  // ChatFrame.as:1370, 1455: the client drops any line with "cheat" in it
  if (/cheat/i.test(text)) return bad(env, `${kind}: the game's client never sends a chat line with "cheat" in it — reword it`);
  if (kind === 'whisper' && lc(a.to) === lc(myName(g))) return bad(env, 'whisper: that is you — the game does not let you whisper yourself');
  const pieces = chatParts(text);
  if (kind === 'worldchat') {
    if (pieces.length > 1) return bad(env, `worldchat: a world line is 150 characters at most (this has ${text.length}) — every line costs a Speaker, so shorten it`);
    if (!speakersHeld(g)) return bad(env, 'worldchat: no Speaker held — the game spends one on every world line (buyitem Speaker buys them)');
    // ChatFrame.as:1394-1404: the same world line twice in a row is refused
    if (env.state.lastWorld === text) return bad(env, 'worldchat: the game refuses the same world line twice in a row');
  } else if (pieces.length > CHAT_PARTS) {
    return bad(env, `${kind}: ${text.length} characters is too long — chat takes 150 a line, and this sends ${CHAT_PARTS} lines at most`);
  }
  if (pieces.length > 1) env.log(`  (in ${pieces.length} lines: the chat box takes 150 characters)`);
  if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }

  let done = 0;
  for (const piece of pieces) {
    await pace(env, CHAT[kind].gap, kind === 'worldchat' ? env.opts.worldGapMs ?? WORLD_GAP_MS : env.opts.chatGapMs ?? 1000);
    if (env.stopped()) return { done, ok: false, error: 'stopped before it was sent', end: true };
    env.follow();
    // ChatContentData.sendMes escapes "<" before sending (ChatContentData.as:219)
    const msg = piece.replace(/</g, '&lt;');
    let res;
    if (kind === 'whisper') {
      // common.privateChat {targetName, msg} — CommonCommands.as:90-98, sent by ChatContentData.as:239
      res = await chatOut(env, 'common.privateChat', { targetName: a.to, msg }, piece);
    } else if (kind === 'alliancechat') {
      // common.allianceChat {msg, languageType} — CommonCommands.as:172-180, sent by ChatContentData.as:295
      res = await chatOut(env, 'common.allianceChat', { msg, languageType: 0 }, piece);
    } else {
      // common.worldChat {msg, languageType} — CommonCommands.as:133-141, sent by ChatContentData.as:278
      res = await chatOut(env, 'common.worldChat', { msg, languageType: 0 }, piece);
    }
    done++;
    if (res.echo) { env.log('  -> ok (seen in chat)'); continue; }
    if (res.r) {
      const v = env.say(res.r);
      env.log('  -> ' + v);
      if (!res.r || Number(res.r.ok) !== 1) return { done, ok: false, error: (res.r && res.r.errorMsg) || v };
      continue;
    }
    env.log(`  -> ${res.e.message}, and the line did not come back in chat — it may not have gone out`);
    return { done, ok: false, error: `${res.e.message} (not seen in chat either)` };
  }
  if (kind === 'worldchat') env.state.lastWorld = text;
  return { done };
}

// whisper <name> <message>: the name may be quoted, the message is the rest.
function parseWhisper(args) {
  const { word, rest } = firstWord(args);
  const to = nameOf(word);
  if (!to) throw new Error('whisper: usage  whisper <name> <message>');
  const msg = unquote(rest);
  if (!msg) throw new Error(`whisper: what to say to ${to}? — whisper ${to} Hello friend!`);
  if (/^https?:$/i.test(msg.split(/\s+/).pop())) throw new Error('whisper: put a line with a link in quotes — // starts a comment');
  return { to, msg };
}
function parseChat(word) {
  return (args) => {
    const msg = unquote(args);
    if (!msg) throw new Error(`${word}: what to say? — ${word} Hello friends!`);
    if (/^https?:$/i.test(msg.split(/\s+/).pop())) throw new Error(`${word}: put a line with a link in quotes — // starts a comment`);
    return { msg };
  };
}

// ------------------------------------------------------------------ friends

// FriendResponse carries the lists after the change (friendArr, blockArr —
// FriendResponse.as:46-61) and the client takes them as its own
// (FriendList.as:387, 560): so does game.player, which `player.friendBeansArray`
// reads.
const FRIEND = {
  addfriend: { cmd: 'friend.addFriend', list: 'friendBeans', reply: 'friendArr', add: true, verb: 'add to your friends' },
  removefriend: { cmd: 'friend.deleteFriend', list: 'friendBeans', reply: 'friendArr', add: false, verb: 'take off your friends' },
  block: { cmd: 'friend.addBlock', list: 'blockBeans', reply: 'blockArr', add: true, verb: 'block' },
  unblock: { cmd: 'friend.deleteBlock', list: 'blockBeans', reply: 'blockArr', add: false, verb: 'unblock' },
};
const onList = (g, key, name) => (playerOf(g)[key] || []).some((b) => b && lc(b.userName) === lc(name));

function parseFriend(word) {
  return (args) => {
    const w = words(args);
    if (w.length !== 1) throw new Error(`${word}: usage  ${word} <name>   (a name with spaces goes in quotes)`);
    return { player: exactName(w[0], word) };
  };
}

async function runFriend(a, env) {
  const f = FRIEND[a.cmd];
  const g = env.game;
  env.log(`  ${f.verb}: ${a.player}`);
  if (f.add && lc(a.player) === lc(myName(g))) return bad(env, `${a.cmd}: that is you`);   // UserInputUI.as addHandler
  // The client moves a name between the lists only after asking (UserInputUI.as:
  // onIsSure deletes it from the other list first): here that is your choice.
  if (a.cmd === 'addfriend' && onList(g, 'blockBeans', a.player)) return bad(env, `addfriend: ${a.player} is on your block list — unblock ${a.player} first`);
  if (a.cmd === 'block' && onList(g, 'friendBeans', a.player)) return bad(env, `block: ${a.player} is on your friends list — removefriend ${a.player} first`);
  if (env.dryRun) { env.log(`  [dry run] not sent (${f.cmd})`); return {}; }
  // friend.addFriend / friend.deleteFriend / friend.addBlock / friend.deleteBlock {player}
  // — FriendCommands.as:80-89 / 39-48 / 51-60 / 27-36, sent by UserInputUI.as:318,
  // FriendList.as:370, UserInputUI.as:313, FriendList.as:374
  const { r, fail } = await ask(env, f.cmd, { player: a.player });
  if (fail) return fail;
  const p = g.player;
  if (p) {
    if (Array.isArray(r[f.reply])) p[f.list] = r[f.reply];
    else if (f.add && !onList(g, f.list, a.player)) p[f.list] = [...(p[f.list] || []), { userName: a.player }];
    else if (!f.add) p[f.list] = (p[f.list] || []).filter((b) => !b || lc(b.userName) !== lc(a.player));
  }
  env.log(`  -> ok (${(p && p[f.list] || []).length} on the ${f.list === 'friendBeans' ? 'friends' : 'block'} list)`);
  return { done: 1 };
}

// ------------------------------------------------------------------ say, play

// What an `echo <src>` line would print (core's env.echoText), with a
// fallback for a VM without it.
async function textOf(env, src) {
  if (typeof env.echoText === 'function') return E.toStr(await env.echoText(src));
  let items;
  try { items = E.parseList(src); } catch { return String(src); }
  const ev = typeof env.evaluate === 'function' ? env.evaluate : (s) => env.ctx.evaluate(s);
  const out = [];
  for (const it of items) {
    let v = await ev(E.describe(it));
    if (v === undefined && it.type === 'id' && !it.paren) v = it.name;
    out.push(E.toStr(v));
  }
  return out.join(' ');
}
// One value: an expression if the text is one, else the text as echo prints it.
async function valueOf(env, src) {
  try { E.parseExpression(src); } catch { return textOf(env, src); }
  return typeof env.evaluate === 'function' ? env.evaluate(src) : env.ctx.evaluate(src);
}

// opts.notify is the console (server.js): it speaks or plays in every open
// console tab and answers how many there were.
async function notify(env, msg) {
  const fn = env.opts && env.opts.notify;
  if (typeof fn !== 'function') { env.log('  (no console to hear it through — logged only)'); return { result: '' }; }
  await pace(env, 'notify', env.opts.notifyGapMs ?? 1000);
  let n;
  try { n = await fn({ ...msg, line: env.line, city: castleName(env) }); } catch (e) {
    env.log('  -> ' + e.message);
    return { ok: false, error: e.message };
  }
  const how = msg.kind === 'say' ? 'spoken' : 'played';
  const text = typeof n !== 'number' ? 'sent to the console'
    : n > 0 ? `${how} in ${n} console tab${n === 1 ? '' : 's'}` : 'no console tab is open — nothing was heard';
  env.log('  -> ' + text);
  return { result: text };
}

async function runSay(a, env) {
  const text = String(await textOf(env, a.src));
  const m = /^\s*([a-z]{2})#\s*/i.exec(text);
  const lang = m ? m[1].toLowerCase() : null;
  const spoken = (m ? text.slice(m[0].length) : text).trim().slice(0, 500);
  if (!spoken) return bad(env, 'say: there is nothing to say');
  env.log(`  say${lang ? ` (${lang})` : ''}: ${spoken}`);
  if (env.dryRun) { env.log('  [dry run] not spoken'); return {}; }
  return notify(env, { kind: 'say', text: spoken, lang });
}

function parsePlay(args) {
  const t = unquote(args);
  if (!t) throw new Error('play: usage  play alarm.mp3 | play "https://example.com/alarm.mp3"');
  if (/^https?:$/i.test(t)) throw new Error('play: put the link in quotes — // starts a comment: play "http://…/alarm.mp3"');
  if (/^https?:\/\//i.test(t)) {
    let u;
    try { u = new URL(t); } catch { throw new Error(`play: "${t}" is not a link`); }
    if (u.username || u.password) throw new Error('play: no user:password@ in the link');
    return { url: u.href };
  }
  if (/^[a-z]:|^[\\/]|\\|(^|\/)\.\.(\/|$)/i.test(t)) {
    throw new Error("play: a file from the console's media folder (play alarm.mp3) or an http(s) link — not a path on this computer");
  }
  if (!/^[\w .\/-]+\.(mp3|wav|ogg)$/i.test(t)) throw new Error(`play: "${t}" is not a sound file name (.mp3, .wav or .ogg) or an http(s) link`);
  return { file: t };
}

async function runPlay(a, env) {
  env.log(`  play ${a.url || a.file}`);
  if (env.dryRun) { env.log('  [dry run] not played'); return {}; }
  return notify(env, a.url ? { kind: 'play', url: a.url } : { kind: 'play', file: a.file });
}

// ------------------------------------------------------------------ post

// 'blocked' (never), 'private' (loopback and private networks) or 'public'.
// script-net.js decides, so every way of writing an address (::ffff:7f00:1,
// NAT64, 6to4…) is judged by what it really reaches.
function ipKind(addr) {
  const k = require('./script-net').addressKind(addr);
  return k === 'global' ? 'public' : k === 'private' ? 'private' : 'blocked';
}

// A console only this machine uses (the default, BIND unset) may post to
// localhost — NEAT's own example posts to http://localhost:8080. One that
// other people sign in to may not reach its host's private network.
function privateOk(env) {
  if (env.opts && env.opts.postPrivate !== undefined) return !!env.opts.postPrivate;
  const bind = lc(process.env.BIND || '127.0.0.1');
  return bind === '127.0.0.1' || bind === 'localhost' || bind === '::1';
}

async function checkUrl(env, raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error(`"${raw}" is not a link — post "https://host/page" data`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`only http and https links can be posted to, not ${u.protocol}`);
  if (u.username || u.password) throw new Error('no user:password@ in the link — put a key in the data instead');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host }];
  else {
    const look = env.opts.dnsLookup || dns.promises.lookup;
    try { addrs = await look(host, { all: true }); } catch (e) { throw new Error(`${host}: no such host (${e.code || e.message})`); }
  }
  for (const { address } of addrs || []) {
    const k = ipKind(address);
    if (k === 'blocked') throw new Error(`${host} is ${address}, a link-local or unspecified address — refused`);
    if (k === 'private' && !privateOk(env)) throw new Error(`${host} is ${address}, a private address — a console others sign in to posts only to the internet`);
  }
  return u;
}

function bodyOf(data, form) {
  if (data === undefined || data === null) return { body: '', type: 'text/plain; charset=utf-8', kind: 'nothing' };
  if (form) {
    if (!isObj(data)) throw new Error('post /form: the data must be an object, e.g. {msg: message}');
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(data)) p.append(k, v !== null && typeof v === 'object' && !(v instanceof Date) ? jsonOf(v) : E.toStr(v));
    return { body: p.toString(), type: 'application/x-www-form-urlencoded', kind: 'a form' };
  }
  if (typeof data === 'object' && !(data instanceof Date)) return { body: jsonOf(data), type: 'application/json', kind: 'JSON' };
  return { body: E.toStr(data), type: 'text/plain; charset=utf-8', kind: 'text' };
}
// json_encode's own rules (script-functions.js), so a city view goes as its fields.
function jsonOf(v) {
  try { return require('./script-functions').jsonEncode(v); } catch { return JSON.stringify(v); }
}

async function readCapped(res, max) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let n = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        n += value.length;
        if (n >= max) { reader.cancel().catch(() => {}); break; }
      }
    } catch { /* what arrived is kept */ }
    return Buffer.concat(chunks).subarray(0, max).toString('utf8');
  }
  if (typeof res.text === 'function') return String(await res.text()).slice(0, max);
  return '';
}

function parsePost(args) {
  let s = String(args).trim();
  let form = false;
  const sw = /^\/(form|json|text)(?:\s+|$)/i.exec(s);
  if (sw) { form = lc(sw[1]) === 'form'; s = s.slice(sw[0].length).trim(); }
  if (!s) throw new Error('post: usage  post <url> [data]   e.g.  data = {msg: message}  then  post URL data');
  if (/^https?:(\s|$)/i.test(s)) throw new Error('post: put the link in quotes — // starts a comment: post "http://…" data');
  const lit = /^(https?:\/\/\S+)(?:\s+|$)/i.exec(s);
  if (lit) return { url: lit[1], urlSrc: null, dataSrc: s.slice(lit[0].length).trim() || null, form };
  let items;
  try { items = E.parseList(s); } catch (e) { throw new Error(`post: ${e.message} — post "https://host/page.php" data`); }
  const first = items[0];
  const cut = first && Number.isInteger(first.e) ? first.e : s.length;
  return { url: null, urlSrc: s.slice(0, cut).trim(), dataSrc: s.slice(cut).trim() || null, form };
}

async function runPost(a, env) {
  const rawUrl = a.url || E.toStr(await valueOf(env, a.urlSrc));
  let u;
  try { u = await checkUrl(env, rawUrl); } catch (e) { return bad(env, 'post: ' + e.message); }
  const data = a.dataSrc === null || a.dataSrc === undefined ? undefined : await valueOf(env, a.dataSrc);
  let b;
  try { b = bodyOf(data, a.form); } catch (e) { return bad(env, e.message); }
  if (b.body.length > POST_MAX_BODY) return bad(env, `post: ${b.body.length} characters is too much to post (1,000,000 at most)`);
  env.log(`  POST ${u.href} — ${b.kind}${b.body ? `, ${b.body.length} characters` : ''}`);
  if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
  await pace(env, 'post', env.opts.postGapMs ?? 1000);
  const ms = env.opts.postTimeoutMs ?? POST_TIMEOUT_MS;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  let res, text = '';
  try {
    if (env.opts.fetch) {
      // tests hand in a fetch of their own
      res = await env.opts.fetch(u.href, {
        method: 'POST', body: b.body, redirect: 'manual', signal: ctl.signal,
        headers: { 'content-type': b.type, 'user-agent': 'OTTObot script' },
      });
      text = await readCapped(res, POST_MAX_REPLY);
    } else {
      // script-net checks the address again as the connection is made, so a
      // name cannot answer one address to checkUrl and another to the post
      const r = await require('./script-net').safeFetch(u.href, {
        method: 'POST', body: b.body, headers: { 'content-type': b.type }, redirects: 0, truncate: true,
        maxBytes: POST_MAX_REPLY, timeoutMs: ms, allowPrivate: privateOk(env), lookup: env.opts.dnsLookup || undefined,
      });
      res = { status: r.status, statusText: r.statusText, headers: { get: (k) => r.headers[String(k).toLowerCase()] ?? null } };
      text = r.text;
    }
  } catch (e) {
    const why = e && e.name === 'AbortError' ? `no answer in ${ms >= 1000 ? Math.round(ms / 1000) + ' s' : ms + ' ms'}` : (e && e.message) || String(e);
    env.log('  -> ' + why);
    return { ok: false, done: 1, error: why, result: '' };
  } finally { clearTimeout(timer); }
  const status = Number(res && res.status) || 0;
  const where = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
  if (status >= 300 && status < 400) {
    const why = `HTTP ${status} — ${u.host} sends it on${where ? ' to ' + where : ''}; post there instead`;
    env.log('  -> ' + why);
    return { ok: false, done: 1, error: why, result: text };
  }
  if (status >= 400 || status === 0) {
    const why = `HTTP ${status}${res && res.statusText ? ' ' + res.statusText : ''}`;
    env.log(`  -> ${why}${text ? ': ' + text.slice(0, 200) : ''}`);
    return { ok: false, done: 1, error: why, result: text };
  }
  env.log(`  -> HTTP ${status}${text ? ': ' + text.slice(0, 200).replace(/\s+/g, ' ') : ''}`);
  return { done: 1, result: text };
}

// ------------------------------------------------------------------ script commands

const commands = {
  whisper: { usage: 'whisper <name> <message>', parse: parseWhisper, run: runChat },
  alliancechat: { usage: 'alliancechat <message>', parse: parseChat('alliancechat'), run: runChat },
  worldchat: { usage: 'worldchat <message>   (one Speaker a line)', parse: parseChat('worldchat'), run: runChat },
  // friendadd is how the wiki's RemoteCommands page writes it
  addfriend: { usage: 'addfriend <name>', aliases: ['friendadd'], parse: parseFriend('addfriend'), run: runFriend },
  removefriend: { usage: 'removefriend <name>', parse: parseFriend('removefriend'), run: runFriend },
  block: { usage: 'block <name>', parse: parseFriend('block'), run: runFriend },
  unblock: { usage: 'unblock <name>', parse: parseFriend('unblock'), run: runFriend },
  say: {
    usage: 'say "<text>" | say "es# <text>" | say <expression>',
    parse(args) {
      if (!String(args).trim()) throw new Error('say: what to say? — say "Your city is under attack."');
      return { src: String(args).trim() };
    },
    run: runSay,
  },
  play: { usage: 'play <file.mp3> | play "<http(s) link>"', parse: parsePlay, run: runPlay },
  post: { usage: 'post <url> [data] | post /form <url> <object>', parse: parsePost, run: runPost },
};

// ------------------------------------------------------------------ in-line: alliance

// A one-name alliance order: accept, invite, expel, sethost, set<rank>...
function nameOrder(word, { cmd, data, what, confirm }) {
  return async (t, env) => {
    const { toks, confirmed } = takeConfirm(words(t));
    const usage = `${word}: usage  ${word} <name>${confirm ? ' confirm' : ''}`;
    if (toks.length !== 1) return bad(env, usage);
    let name;
    try { name = exactName(toks[0], word); } catch (e) { return bad(env, e.message); }
    if (confirm && !confirmed) return bad(env, `${word}: this would ${what(name)} — ${confirm} — write  ${word} ${name} confirm  to do it`);
    return order(env, what(name), cmd, data(name, env));
  };
}

function setRank(word, confirm) {
  const typeId = RANK_TYPE[word];
  // alliance.setPowerForUserByAlliance {userName, typeId} — AllianceManagementCommands.as:167-178,
  // sent by AllianceMemberInfoShow.as:1182 with the rank box's typeId
  return nameOrder(word, {
    cmd: 'alliance.setPowerForUserByAlliance',
    data: (userName) => ({ userName, typeId }),
    what: (n) => `make ${n} ${POSITIONS[typeId]} of the alliance`,
    confirm,
  });
}

// The two lists the Alliance window's managers read, as CSV.
async function allianceList(env, t, word, cmd, key, head, row) {
  if (words(t).length) return bad(env, `${word}: nothing goes after it`);
  const { r, fail } = await ask(env, cmd, {});
  if (fail) return fail;
  return listOut(env, [csv(...head), ...(r[key] || []).map((b) => csv(...row(b || {})))]);
}

// ------------------------------------------------------------------ in-line: reports and mail

// A report's details as NEAT's lines: Info lines, then each side's units as
// code:left/total, then the battle log's link (mailbox.describeReport reads it).
function reportDetail(d) {
  const out = [];
  const secs = d.sections || [];
  if (d.kind !== 'battle' && d.headline) out.push('Info: ' + d.headline);
  if (d.verdict && d.verdict.text) out.push('Info: ' + d.verdict.text);
  for (const l of d.lines || []) out.push('Info: ' + l);
  for (const s of secs.filter((x) => x.type === 'kv')) {
    for (const [k, v] of s.rows || []) out.push(k === 'Loyalty change' ? `Info: The Loyalty of this city is ${v}.` : `Info: ${k}: ${v}`);
  }
  for (const s of secs) {
    if (s.type === 'sides') {
      for (const side of s.sides || []) {
        if (!side) continue;
        const units = side.troops.map((u) => `${UNIT_CODE[u.typeId] || u.name}:${u.left}/${u.count}`).join(', ');
        out.push(`${side.role === 'Attacker' ? 'attackers' : 'defenders'}: ${units}`);
      }
    } else if (s.type === 'res') {
      out.push(`${s.title}: ${Object.entries(s.res || {}).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    } else if (s.type === 'units') {
      out.push(`${s.title}: ${(s.rows || []).map((r) => r.join(' ')).join(', ')}`);
    } else if (s.type === 'text' && s.text) {
      out.push(`${s.title ? s.title + ': ' : ''}${String(s.text).replace(/\s+/g, ' ')}`);
    }
  }
  const url = d.url || (d.log && d.log.page);
  if (url) out.push('url: ' + url);
  return out;
}

const reportTag = (row) => (row.attack ? 'ATT' : 'DEF');
// "ATT Attack Reports on Mon May 23 2011 04:27:04 PM from MyCity(111,333) to Barbarian's city(111,334)"
const reportHead = (row) => `${reportTag(row)} ${row.title}${row.time ? ' on ' + neatTime(row.time) : ''}`
  + `${row.from ? ' from ' + row.from : ''}${row.to ? ' to ' + row.to : ''}`;

async function reportList(t, env, word, full) {
  const page = pageOf(words(t));
  if (page === null) return bad(env, `${word}: usage  ${word} [page]`);
  const g = env.game;
  // report.receiveReportList {pageNo, pageSize, reportType} — ReportCommands.as:39-48 (game.reportList);
  // type 1 is the army reports (constants REPORT_TYPE), 10 a page (PublicReportCanvas)
  const { r, fail } = await askFn(env, () => mrQueue(env, () => g.reportList('army', page, PAGE)));
  if (fail) return fail;
  const rows = (r.reports || []).map((x) => MB.reportRow(x, 'army'));
  const lines = [`Page: ${num(r.pageNo) || page}/${num(r.totalPage)}`];
  let opened = 0;
  for (const row of rows) {
    if (!full) { lines.push(`[${row.id}]${reportTag(row)} ${row.title} from ${row.from} to ${row.to} on ${neatTime(row.time)}`); continue; }
    lines.push(reportHead(row));
    if (env.dryRun) continue;
    // report.markAsRead {reportId} — ReportCommands.as:27-34 (game.readReport): how the
    // client opens a report (PublicReportCanvas.showDetail); it marks it read
    const got = await askFn(env, () => mrQueue(env, () => g.readReport(row.id)));
    opened++;
    if (got.fail) { lines.push(`(could not open report ${row.id}: ${got.fail.error})`); continue; }
    const rep = got.r.report || {};
    lines.push(...reportDetail(MB.describeReport(rep.content, rep)));
  }
  if (full && env.dryRun && rows.length) lines.push('[dry run] the reports were not opened — opening one marks it read');
  return listOut(env, lines, 1 + opened);
}

async function readReport(t, env) {
  const w = words(t);
  if (w.length !== 1 || !/^\d+$/.test(w[0])) return bad(env, 'readreport: usage  readreport <report id>   (quickarmyreport lists the ids)');
  const id = Number(w[0]);
  if (env.dryRun) { env.log(`  would open report ${id}`); env.log('  [dry run] not opened — opening a report marks it read'); return {}; }
  // report.markAsRead {reportId} — ReportCommands.as:27-34 (game.readReport)
  const { r, fail } = await askFn(env, () => mrQueue(env, () => env.game.readReport(id)));
  if (fail) return fail;
  const rep = r.report;
  if (!rep) return bad(env, `readreport: the server sent no report ${id}`);
  const row = MB.reportRow(rep, null);
  const lines = [reportHead(row), ...reportDetail(MB.describeReport(rep.content, rep))];
  return listOut(env, lines);
}

async function warReport(t, env) {
  const page = pageOf(words(t));
  if (page === null) return bad(env, 'warreport: usage  warreport [page]');
  // alliance.getMilitarySituationList {pageNo, pageSize} — AllianceCommands.as:34-45, as
  // MilitarySituationList.as:548 asks (10 a page). Each situation carries its
  // report's XML (MilitarySituation.as:66, xml_data), which PublicReportDetail shows.
  const { r, fail } = await ask(env, 'alliance.getMilitarySituationList', { pageNo: page, pageSize: PAGE });
  if (fail) return fail;
  const lines = [`Page: ${num(r.pageNo) || page}/${num(r.totalPage)}`];
  for (const s of r.situations || []) {
    if (!s) continue;
    const other = s.otherAllianceName === undefined || s.otherAllianceName === null ? 'null' : s.otherAllianceName;
    lines.push(`${s.attack ? 'ATT' : 'DEF'} ${other} ${s.eventName || ''} on ${neatTime(s.time)} from ${s.startPos || ''} to ${s.targetPos || ''}`);
    if (s.xml_data) lines.push(...reportDetail(MB.describeReport(s.xml_data, { startPos: s.startPos, targetPos: s.targetPos })));
  }
  return listOut(env, lines);
}

async function mailBox(t, env, box, word) {
  const page = pageOf(words(t));
  if (page === null) return bad(env, `${word}: usage  ${word} [page]`);
  const g = env.game;
  // mail.receiveMailList {pageNo, type, pageSize} — MailCommands.as:115-124 (game.mailList);
  // type 1 inbox, 2 system, 3 sent (MailConstants, mailbox.MAIL_BOX), 10 a page (MailWin)
  const { r, fail } = await askFn(env, () => mrQueue(env, () => g.mailList(MB.MAIL_BOX[box], page, MB.PAGE_SIZE)));
  if (fail) return fail;
  const rows = (r.mails || []).map((m) => MB.mailRow(m, box));
  const lines = [`Page: ${num(r.pageNo) || page}/${num(r.totalPage)}`];
  let opened = 0;
  for (const m of rows) {
    lines.push(`[${m.id}:${m.from}>${m.to}] ${m.title} on ${neatTime(m.time, '@')}`);
    if (env.dryRun) continue;
    // mail.readMail {mailId} — MailCommands.as:98-105 (game.readMail): opening a mail reads it (MailWin.onSeeAbout)
    const got = await askFn(env, () => mrQueue(env, () => g.readMail(m.id)));
    opened++;
    if (got.fail) { lines.push(`(could not open mail ${m.id}: ${got.fail.error})`); continue; }
    const text = MB.mailText(got.r.content);
    if (text) lines.push(text);
  }
  if (env.dryRun && rows.length) lines.push('[dry run] the mails were not opened — opening one marks it read');
  return listOut(env, lines, 1 + opened);
}

async function sendMail(t, env) {
  const one = firstWord(t);
  const two = firstWord(one.rest);
  const v = MB.checkMail({ to: nameOf(one.word), title: two.word, body: two.rest });
  if (v.error) return bad(env, `mail: ${v.error} — mail <name> <subject> <text>   (a subject with spaces goes in quotes)`);
  env.log(`  mail to ${v.to}: "${v.title}" (${v.body.length} characters)`);
  if (env.dryRun) { env.log('  [dry run] not sent (mail.sendMail)'); return {}; }
  // MailWin.sendMail: "There is a 5 second cooldown on sending messages."
  await pace(env, 'mail', env.opts.mailGapMs ?? MB.MAIL_LIMITS.cooldownMs);
  if (env.stopped()) return { ok: false, error: 'stopped before it was sent', end: true };
  // mail.sendMail {username, title, content} — MailCommands.as:84-93 (game.sendMail)
  const { fail } = await askFn(env, () => mrQueue(env, () => env.game.sendMail(v.to, v.title, v.body)));
  if (fail) return fail;
  env.log('  -> ok');
  return { done: 1 };
}

// ------------------------------------------------------------------ in-line: lookups

function mapFns(env) { return require('./script-functions').globals(env.ctx); }

const miles = (d) => `${Math.round(d * 100) / 100} miles`;
const stateWord = (s) => require('./script-functions').stateName(s) || String(s);

// "Castle 10(111,222), peace, 5.09 miles, MyCity, Botter TuffGuys, pres 14997337, honor 212942"
function castleLine(b, from) {
  const kind = b.npc || b.type === 12 ? 'NPC' : 'Castle';
  const lvl = b.level !== null && b.level !== undefined ? ' ' + b.level : '';
  const dist = from ? miles(C.mapDistance(from, b)) : '? miles';
  const owner = [b.userName, b.allianceName].filter(Boolean).join(' ');
  return `${kind}${lvl}(${b.x},${b.y}), ${stateWord(b.state)}, ${dist}, ${b.name || ''}, ${owner}, pres ${num(b.prestige)}, honor ${num(b.honor)}`;
}
const CASTLE_HEAD = 'Coords, State, Distance, Castle, Owner, Alliance, Prestige, Honor';

function castleList(env, title, list) {
  return listOut(env, [`===${title}===`, CASTLE_HEAD, ...list.map((b) => castleLine(b, hereXY(env))), '===end search==='], 0);
}

const byDistance = (from) => (a, b) => (from ? C.mapDistance(from, a) - C.mapDistance(from, b) : 0) || a.id - b.id;
const XY_RE = /^(\d{1,3}),(\d{1,3})$/;

async function listCastles(t, env) {
  const w = words(t);
  const usage = 'listcastles: usage  listcastles x,y x,y [max towns] [min prestige]';
  if (w.length < 2 || w.length > 4) return bad(env, usage);
  const a = XY_RE.exec(w[0]), b = XY_RE.exec(w[1]);
  if (!a || !b) return bad(env, usage);
  const max = w[2] === undefined ? 1000 : Number(w[2]);
  let minPres = 0;
  try { minPres = w[3] === undefined ? 0 : num(require('./script-words').num(w[3])); } catch { return bad(env, usage); }
  if (!Number.isInteger(max) || max < 1) return bad(env, usage);
  const list = (await mapFns(env).CastlesInRectangle(+a[1], +a[2], +b[1], +b[2]))
    .filter((c) => num(c.prestige) >= minPres).sort(byDistance(hereXY(env))).slice(0, max);
  return castleList(env, `castles in ${w[0]} ${w[1]}`, list);
}

async function searchCastle(t, env) {
  const w = words(t);
  if (w.length !== 1) return bad(env, 'searchcastle: usage  searchcastle <alliance | city name | lord>   (names with spaces in quotes)');
  const q = lc(nameOf(w[0]));
  const W = C.MAP_W || 800;
  // the map cache and the session's live blocks (script-functions.js), as NEAT searched its map scan
  const all = await mapFns(env).CastlesInRectangle(0, 0, W - 1, W - 1);
  const hits = all.filter((c) => lc(c.allianceName) === q || lc(c.name) === q || lc(c.userName) === q).sort(byDistance(hereXY(env)));
  return castleList(env, `search castle for ${nameOf(w[0])}`, hits);
}

async function searchEnemies(t, env) {
  const w = words(t);
  if (w.length > 1 || (w.length && !/^\d+$/.test(w[0]))) return bad(env, 'searchenemies: usage  searchenemies <max results>');
  const list = await mapFns(env).SearchEnemyCastles(w.length ? Number(w[0]) : undefined);
  return castleList(env, 'Enemy castles', list);
}

async function loc(t, env) {
  const w = words(t);
  const m = w.length === 1 && XY_RE.exec(w[0]);
  if (!m) return bad(env, 'loc: usage  loc x,y');
  const x = +m[1], y = +m[2];
  const fid = C.coordsToFieldId(x, y);
  const b = await mapFns(env).GetDetailInfo(fid);
  if (!b) return bad(env, `loc: nothing is known about ${x},${y} — scan it first (scanmap ${x},${y} 1)`);
  const type = b.type === undefined || b.type === null ? (b.npc ? 12 : b.userName ? 11 : null) : Number(b.type);
  const kind = type === 12 ? 'NPC' : type === 11 ? 'Castle' : ((C.FIELD_TYPES[type] || {}).name || 'Field');
  const lvl = b.level !== null && b.level !== undefined ? ' ' + b.level : '';
  const zone = String(b.zoneName || C.zoneOf(x, y) || '').toUpperCase();
  const owner = b.userName ? `${b.userName}${b.allianceName ? ` (${b.allianceName})` : ''}` : 'none';
  const text = `Location: ${x},${y}: ${kind}${lvl}(${x},${y}) ${stateWord(b.state)}, ${b.name || ''} ${zone}, belongs to ${owner}`;
  return listOut(env, [text], 0);
}

// rank.getHeroRank sortType: 1 level, 2 politics, 3 attack, 4 intelligence (RankWin.as:138-149)
const HERO_SORT = { lvl: 1, level: 1, pol: 2, politics: 2, atk: 3, attack: 3, int: 4, intel: 4, intelligence: 4 };
// rank.getAllianceRank sortType: 1 members, 2 prestige, 3 honor (RankWin.as:210-218)
const ALLIANCE_SORT = { members: 1, member: 1, prestige: 2, pres: 2, honor: 3 };

async function searchHeroes(t, env) {
  const w = words(t);
  const usage = 'searchheroes: usage  searchheroes <hero name>|* lvl|atk|pol|int [page]';
  if (!w.length || w.length > 3) return bad(env, usage);
  const sortType = HERO_SORT[lc(w[1] || 'lvl')];
  const page = pageOf(w.slice(2));
  if (!sortType || page === null) return bad(env, usage);
  const key = w[0] === '*' ? null : nameOf(w[0]);
  // rank.getHeroRank {key, pageNo, pageSize, sortType} — RankCommands.as:78-88, as RankWin.as:2302
  // asks (10 a page, RankWin.as:166); RankHeroResponse.beans are RankHeroBean
  // {rank, name, kind = the lord (the "君主" column, RankWin.as:2000-2204), grade, power, stratagem, management}
  const { r, fail } = await ask(env, 'rank.getHeroRank', { key, pageNo: page, pageSize: PAGE, sortType });
  if (fail) return fail;
  const lines = [`Page ${num(r.pageNo) || page} of ${num(r.totalPage)} Pages`, csv('Rank', 'Name', 'Owner', 'Level', 'Atk', 'Int', 'Pol'),
    ...(r.beans || []).map((h) => csv(num(h.rank), h.name, h.kind, num(h.grade), num(h.power), num(h.stratagem), num(h.management)))];
  return listOut(env, lines);
}

async function searchAlliances(t, env) {
  const w = words(t);
  const usage = 'searchalliances: usage  searchalliances <alliance name>|* [members|prestige|honor] [page]';
  if (!w.length || w.length > 3) return bad(env, usage);
  const sortType = ALLIANCE_SORT[lc(w[1] || 'prestige')];
  const page = pageOf(w.slice(2));
  if (!sortType || page === null) return bad(env, usage);
  const key = w[0] === '*' ? null : nameOf(w[0]);
  // rank.getAllianceRank {key, pageNo, pageSize, sortType} — RankCommands.as:48-58, as
  // AllianceList.as:453 (key null: every alliance) and RankWin.as:918 ask; beans are
  // RankAllianceBean {rank, name, playerName = host (the "盟主" column, RankWin.as:1186, 1840),
  // createrName, member, city, prestige, honor}
  const { r, fail } = await ask(env, 'rank.getAllianceRank', { key, pageNo: page, pageSize: PAGE, sortType });
  if (fail) return fail;
  const lines = [`Page ${num(r.pageNo) || page} of ${num(r.totalPage)} Pages`, csv('Rank', 'Name', 'Host', 'Founder', 'Members', 'Cities', 'Prestige', 'Honor'),
    ...(r.beans || []).map((a) => csv(num(a.rank), a.name, a.playerName, a.createrName, num(a.member), num(a.city), num(a.prestige), num(a.honor)))];
  return listOut(env, lines);
}

const whoLine = (p, name) => `Player info: ${p.userName || name}, alliance: ${p.alliance || ''}, castle: ${num(p.castleCount)}, `
  + `pres: ${num(p.prestige)}, honor: ${num(p.honor)}, rank: ${num(p.ranking)}, pos: ${officeName(p.office)}, `
  + `title: ${titleName(p.titleId, p.sex)}, pop: ${num(p.population)}`;

async function who(t, env) {
  const w = words(t);
  if (w.length !== 1 || !nameOf(w[0])) return bad(env, 'who: usage  who <name>   (a name with spaces goes in quotes)');
  const name = nameOf(w[0]);
  const me = lc(myName(env.game));
  // common.getPlayerInfoByName {userName} — CommonCommands.as:121-128; PlayerInfoResponse.playerInfo
  // is a PlayerInfoBean (PlayerInfoResponse.as:40)
  const q = () => ask(env, 'common.getPlayerInfoByName', { userName: name });
  let res = await q();
  // game.js's heartbeat asks the same about us, and a reply names only its
  // command: an answer about us when we asked about someone else was the ping's.
  const about = (x) => lc(((x.r || {}).playerInfo || {}).userName);
  if (res.r && me && lc(name) !== me && about(res) === me) res = await q();
  if (res.fail) return res.fail;
  const text = whoLine(res.r.playerInfo || {}, name);
  return listOut(env, [text]);
}

function heroModule() { try { return require('./script-cmd-hero'); } catch { return null; } }

// NEAT's ListAllHeroes: the hero module's command when it has one, so there is one format.
async function listAllHeroes(t, env) {
  if (words(t).length) return bad(env, 'listallheroes: nothing goes after it');
  const H = heroModule();
  const spec = H && H.commands && H.commands.listallheroes;
  if (spec && typeof spec.run === 'function') {
    const a = typeof spec.parse === 'function' ? spec.parse('', { word: 'listallheroes', line: 'listallheroes', tok: ['listallheroes'] }) : {};
    return spec.run({ cmd: 'listallheroes', ...(a || {}) }, env);
  }
  const lines = [];
  for (const c of env.game.castles || []) {
    for (const h of c.heros || []) {
      lines.push(`${c.name} ${h.name} Lvl:${num(h.level)} [P:${Math.floor(num(h.management))} A:${Math.floor(num(h.power))} I:${Math.floor(num(h.stratagem))}]`
        + ` exp:${Math.floor(num(h.experience))}/${Math.floor(num(h.upgradeExp))}`);
    }
  }
  if (!lines.length) { env.log('  no heroes in any city'); return { result: '' }; }
  return listOut(env, lines, 0);
}

// ------------------------------------------------------------------ in-line: holiday

function passwordHash(env) {
  // the login's SHA1 hex, kept by the client (evony.js passwordHash() on goals/integration)
  const c = env.game && env.game.c;
  try { return c && typeof c.passwordHash === 'function' ? c.passwordHash() || null : null; } catch { return null; }
}

const HOLIDAY_USAGE = 'holiday <days> confirm [/autoextend] | holiday /exit   (/autoextend renews the holiday until the coins run out)';
async function holiday(t, env) {
  const { toks, confirmed } = takeConfirm(words(t));
  let days = null, auto = false, exit = false;
  for (const w of toks) {
    const k = lc(w);
    if (k === '/autoextend' || k === '/auto') auto = true;
    else if (k === '/exit') exit = true;
    else if (/^\d+$/.test(k) && days === null) days = Number(k);
    else return bad(env, `holiday: "${w}" is neither a switch nor a number of days — ${HOLIDAY_USAGE}`);
  }
  const g = env.game;
  const playerId = infoOf(g).id;               // StageChangeWin.as:606 sends playerInfo.id
  if (playerId === undefined || playerId === null) return bad(env, "holiday: the account's player id is not known — reconnect the console");
  if (exit) {
    if (days !== null || auto) return bad(env, 'holiday /exit: nothing else goes with it');
    // furlough.cancelFurlought {playerId} — FurloughCommands.as:41-50, sent by HolidayTips.as:205
    return order(env, 'end the holiday now', 'furlough.cancelFurlought', { playerId });
  }
  // NEAT's /autoextend renews the holiday at every end "until coins run out" (the game's own
  // isAutoFurlough flag). The user asked for it on 2026-09-20 for the bank accounts; it still
  // needs `confirm`, and it is the one thing here that keeps spending coins by itself.
  // `confirm` is always the last word (takeConfirm), so the switch goes before it
  const again = `holiday ${days || 3}${auto ? ' /autoextend' : ''} confirm`;
  if (days === null) return bad(env, `holiday: for how many days? (2 or more) — ${again}`);
  // StageChangeWin.as:593: the Holiday window refuses fewer than 2 days
  if (days < 2) return bad(env, `holiday: 2 days at least (the game's Holiday window takes no fewer) — ${again.replace(/\d+/, '2')}`);
  const what = `put the account on holiday for ${days} days${auto ? ', renewing itself until the coins run out' : ''}`;
  if (!confirmed) {
    return bad(env, `holiday: this would ${what} — the account goes off-line for days, and the game may charge coins for it — write  ${again}  to do it`);
  }
  const hash = passwordHash(env);
  if (!hash) {
    return bad(env, "holiday: this console cannot give the game the account's password, which the Holiday request carries — "
      + "it needs the goals update (goals/integration); until then use the game's own Holiday window");
  }
  // StageChangeWin.as:600-602: the window asks first while armies are marching on you
  const incoming = (playerOf(g).enemyArmys || []).length;
  if (incoming) env.log(`  note: ${incoming} enemy ${incoming === 1 ? 'army is' : 'armies are'} marching on you`);
  env.log('  ' + what);
  if (env.dryRun) { env.log('  [dry run] not sent (furlough.isFurlought)'); return {}; }
  // furlough.isFurlought {playerId, day, password, isAutoFurlough} — FurloughCommands.as:21-33,
  // sent by StageChangeWin.as:606 with SHA1.hash of the password; the data is never logged
  const { fail } = await ask(env, 'furlough.isFurlought', { playerId, day: days, password: hash, isAutoFurlough: auto });
  if (fail) return fail;
  env.log(`  -> ok — the account is on holiday${auto ? ', and renews itself while the coins last' : ''}`
    + ' (the game client reloads the account after this)');
  return { done: 1 };
}

// ------------------------------------------------------------------ the in-line table

const inline = {
  // alliance.agreeComeinAllianceByLeader {userName} — AllianceManagementCommands.as:192-202, CheckApply.as:205
  accept: {
    usage: 'accept <name>',
    run: nameOrder('accept', {
      cmd: 'alliance.agreeComeinAllianceByLeader', data: (userName) => ({ userName }),
      what: (n) => `accept ${n} into the alliance`,
    }),
  },
  alliance: {
    usage: 'alliance <alliance name>',
    async run(t, env) {
      const w = words(t);
      if (w.length !== 1 || !nameOf(w[0])) return bad(env, 'alliance: usage  alliance <alliance name>');
      const name = nameOf(w[0]);
      // alliance.getAllianceInfo {allianceName} — AllianceCommands.as:97-106, AllianceInfo.as:621;
      // AllianceInfoResponse {leader, creator, memberCount, prestigeCount, ranking, allinaceInfo (sic)}
      const { r, fail } = await ask(env, 'alliance.getAllianceInfo', { allianceName: name });
      if (fail) return fail;
      const lines = [`Alliance info: ${name}, host: ${r.leader || ''}, founder: ${r.creator || ''}, members: ${num(r.memberCount)}, `
        + `prestige: ${num(r.prestigeCount)}, rank: ${num(r.ranking)}`];
      const intro = MB.mailText(r.allinaceInfo || r.allianceInfo || '');
      if (intro) lines.push(`Introduction: ${intro}`);
      return listOut(env, lines);
    },
  },
  applicants: {
    usage: 'applicants',
    // alliance.agreeComeinAllianceList {} — AllianceManagementCommands.as:98-107, the list CheckApply.as:271
    // shows; AllianceUserAddResponse.allianceAddPlayerByUserInfoBeanList (AllianceUserAddResponse.as:47)
    run: (t, env) => allianceList(env, t, 'applicants', 'alliance.agreeComeinAllianceList', 'allianceAddPlayerByUserInfoBeanList',
      ['Name', 'Prestige', 'Rank', 'Cities', 'Applied'],
      (b) => [b.userName, num(b.prestige), num(b.rank), num(b.castleCount), neatTime(b.inviteTime)]),
  },
  // alliance.userWantInAlliance {allianceName} — AllianceManagementCommands.as:86-96, AllianceInfo.as:1067
  apply: {
    usage: 'apply <alliance name>',
    run: nameOrder('apply', {
      cmd: 'alliance.userWantInAlliance', data: (allianceName) => ({ allianceName }),
      what: (n) => `apply to join ${n}`,
    }),
  },
  armyreport: { usage: 'armyreport [page]', run: (t, env) => reportList(t, env, 'armyreport', true) },
  createalliance: {
    usage: 'createalliance <name>   (8 characters at most; an Embassy of level 2 and 10,000 gold)',
    async run(t, env) {
      const w = words(t);
      if (w.length !== 1 || !nameOf(w[0])) return bad(env, 'createalliance: usage  createalliance <name>');
      const name = nameOf(w[0]);
      // CreateWin.as:136 takes 8 characters; InputTextFilter.specialCharFilter refuses " ' and space
      if (name.length > 8) return bad(env, `createalliance: "${name}" is ${name.length} characters — an alliance name is 8 at most`);
      if (/["' ]/.test(name)) return bad(env, 'createalliance: no quotes or spaces in an alliance name');
      // CreateWin.as:275-293: the city needs an Embassy of level 2
      const emb = C.BUILDING_BY_CODE.embassy.typeId;
      const bs = (() => { try { return env.castle.buildings || []; } catch { return []; } })();
      if (bs.length && !bs.some((b) => Number(b.typeId) === emb && num(b.level) >= 2)) {
        return bad(env, `createalliance: ${castleName(env) || 'this city'} needs an Embassy of level 2 to found an alliance`);
      }
      // alliance.createAlliance {castleId, allianceName} — AllianceManagementCommands.as:269-280, CreateWin.as:294
      const res = await order(env, `found the alliance ${name} from ${castleName(env)} (costs 10,000 gold)`, 'alliance.createAlliance',
        { castleId: env.cid, allianceName: name });
      if (res.sent) setAlliance(env, name);
      return res;
    },
  },
  declare: {
    usage: 'declare <alliance> red|blue|grey|none   (red takes confirm)',
    async run(t, env) {
      const { toks, confirmed } = takeConfirm(words(t));
      if (toks.length !== 2) return bad(env, 'declare: usage  declare <alliance> red|blue|grey|none');
      let name;
      try { name = exactName(toks[0], 'declare'); } catch (e) { return bad(env, e.message); }
      const st = STANDING[lc(toks[1])];
      if (!st) return bad(env, `declare: "${toks[1]}" is not a standing — red (enemy), blue (friendly), grey (neutral) or none`);
      if (st === 'none') {
        // alliance.dropAllianceFriendshipRelation {targetAllianceName} — AllianceManagementCommands.as:294-304, Diplomatic.as:715
        const res = await order(env, `drop the alliance's standing with ${name}`, 'alliance.dropAllianceFriendshipRelation', { targetAllianceName: name });
        if (res.sent) setAlliance(env, infoOf(env.game).alliance);
        return res;
      }
      const what = `declare ${name} ${STANDING_WORD[st]}`;
      if (st === 'red' && !confirmed) {
        return bad(env, `declare: this would ${what}: war — and a standing can be changed once a day (AllianceConstants: 24 h) — write  declare ${name} red confirm  to do it`);
      }
      // alliance.setAllianceFriendship {targetAllianceName, type} — AllianceManagementCommands.as:306-317,
      // Diplomatic.as:501-507; type AllianceConstants FRIEND 1, MIDDLE 2, ENEMY 3
      const res = await order(env, what, 'alliance.setAllianceFriendship', { targetAllianceName: name, type: STANDING_TYPE[st] });
      if (res.sent) setAlliance(env, infoOf(env.game).alliance);
      return res;
    },
  },
  // alliance.kickOutMemberfromAlliance {userName} — AllianceManagementCommands.as:341-351,
  // AllianceMemberInfoShow.as:1249, AllianceRetire.as:246
  expel: {
    usage: 'expel <name> confirm',
    aliases: ['eject'],
    run: nameOrder('expel', {
      cmd: 'alliance.kickOutMemberfromAlliance', data: (userName) => ({ userName }),
      what: (n) => `expel ${n} from the alliance`, confirm: 'they are out at once',
    }),
  },
  holiday: { usage: HOLIDAY_USAGE, run: holiday },
  // alliance.addUsertoAlliance {userName} — AllianceManagementCommands.as:282-292, InviteMember.as:220
  invite: {
    usage: 'invite <name>',
    run: nameOrder('invite', {
      cmd: 'alliance.addUsertoAlliance', data: (userName) => ({ userName }),
      what: (n) => `invite ${n} to the alliance`,
    }),
  },
  invites: {
    usage: 'invites',
    // alliance.addUsertoAllianceList {} — AllianceManagementCommands.as:156-165, the list InviteMember.as:405
    // shows; AllianceInviteBeanResponse.allianceAddPlayerInfoBeanList (AllianceInviteBeanResponse.as:47)
    run: (t, env) => allianceList(env, t, 'invites', 'alliance.addUsertoAllianceList', 'allianceAddPlayerInfoBeanList',
      ['Name', 'Prestige', 'Rank', 'Invited by', 'Invited', 'State'],
      (b) => [b.userName, num(b.prestige), num(b.rank), b.invitePerson, neatTime(b.inviteTime), b.state]),
  },
  join: {
    usage: 'join <alliance name>',
    async run(t, env) {
      const w = words(t);
      if (w.length !== 1) return bad(env, 'join: usage  join <alliance name>   (an alliance that has invited you)');
      let name;
      try { name = exactName(w[0], 'join'); } catch (e) { return bad(env, e.message); }
      // alliance.agreeComeinAllianceByUser {castleId, allianceName} — AllianceManagementCommands.as:240-251,
      // BeginAlliance.as:296 (from the current city)
      const res = await order(env, `join ${name} (accepting its invitation)`, 'alliance.agreeComeinAllianceByUser', { castleId: env.cid, allianceName: name });
      if (res.sent) setAlliance(env, name);
      return res;
    },
  },
  listallheroes: { usage: 'listallheroes', run: listAllHeroes },
  listcastles: { usage: 'listcastles x,y x,y [max towns] [min prestige]', run: listCastles },
  listmail: { usage: 'listmail [page]', run: (t, env) => mailBox(t, env, 'inbox', 'listmail') },
  listsentmail: { usage: 'listsentmail [page]', run: (t, env) => mailBox(t, env, 'sent', 'listsentmail') },
  listsystemmail: { usage: 'listsystemmail [page]', run: (t, env) => mailBox(t, env, 'system', 'listsystemmail') },
  loc: { usage: 'loc x,y', run: loc },
  mail: { usage: 'mail <name> <subject> <text>', run: sendMail },
  members: {
    usage: 'members',
    async run(t, env) {
      if (words(t).length) return bad(env, 'members: nothing goes after it');
      // alliance.getAllianceMembers {} — AllianceCommands.as:86-95, as AllianceMemberInfoShow.as:854 asks;
      // AllianceMembersResponse.members are PlayerInfoBeans (AllianceMembersResponse.as:47), levelId the rank
      const { r, fail } = await ask(env, 'alliance.getAllianceMembers', {});
      if (fail) return fail;
      const rows = (r.members || []).filter(Boolean).map((m) => csv(m.userName, POSITIONS[num(m.levelId)] || '', num(m.prestige), num(m.honor),
        neatTime(m.lastLoginTime), num(m.castleCount), num(m.population)));
      return listOut(env, [csv('Lord', 'Position', 'Prestige', 'Honor', 'Last login', 'Cities', 'Population'), ...rows]);
    },
  },
  quickarmyreport: { usage: 'quickarmyreport [page]', run: (t, env) => reportList(t, env, 'quickarmyreport', false) },
  quitalliance: {
    usage: 'quitalliance confirm',
    async run(t, env) {
      const { toks, confirmed } = takeConfirm(words(t));
      if (toks.length) return bad(env, 'quitalliance: usage  quitalliance confirm');
      const al = infoOf(env.game).alliance;
      // AllianceConstants.SAY_BYE_TO_ALLIANCE_PRESTIGE_DEDUCT_RATE = 0.1
      const what = `leave ${al || 'the alliance'}`;
      if (!confirmed) return bad(env, `quitalliance: this would ${what}, which costs 10% of your prestige — write  quitalliance confirm  to do it`);
      // alliance.sayByetoAlliance {} — AllianceManagementCommands.as:204-213, AllianceManageView.as:381, 684
      const res = await order(env, what, 'alliance.sayByetoAlliance', {});
      if (res.sent) setAlliance(env, '');
      return res;
    },
  },
  readreport: { usage: 'readreport <report id>', run: readReport },
  resign: {
    usage: 'resign confirm',
    async run(t, env) {
      const { toks, confirmed } = takeConfirm(words(t));
      if (toks.length) return bad(env, 'resign: usage  resign confirm');
      if (!confirmed) return bad(env, 'resign: this would give up your rank in the alliance and make you a member — write  resign confirm  to do it');
      // alliance.resignForAlliance {} — AllianceManagementCommands.as:109-118, AllianceManageView.as:372
      return order(env, 'resign your alliance rank', 'alliance.resignForAlliance', {});
    },
  },
  searchalliances: { usage: 'searchalliances <name>|* [members|prestige|honor] [page]', run: searchAlliances },
  searchcastle: { usage: 'searchcastle <alliance | city | lord>', run: searchCastle },
  searchenemies: { usage: 'searchenemies <max results>', run: searchEnemies },
  searchheroes: { usage: 'searchheroes <name>|* lvl|atk|pol|int [page]', run: searchHeroes },
  // alliance.resetTopPowerForAlliance {userName} — AllianceManagementCommands.as:74-84, ChangeCovenanter.as:251
  sethost: {
    usage: 'sethost <name> confirm',
    run: nameOrder('sethost', {
      cmd: 'alliance.resetTopPowerForAlliance', data: (userName) => ({ userName }),
      what: (n) => `hand the alliance over to ${n} as its host`, confirm: 'you stop being host',
    }),
  },
  setmember: { usage: 'setmember <name>', run: setRank('setmember') },
  setofficer: { usage: 'setofficer <name>', run: setRank('setofficer') },
  setpresbyter: { usage: 'setpresbyter <name>', run: setRank('setpresbyter') },
  // a vice host can expel members and change ranks: not one typo away
  setvicehost: { usage: 'setvicehost <name> confirm', run: setRank('setvicehost', 'a vice host can expel members and change their ranks') },
  warreport: { usage: 'warreport [page]', run: warReport },
  who: { usage: 'who <name>', run: who },
};

module.exports = {
  commands, inline,
  // the console's Alliance and Friends tabs (alliance.js) name things the same way
  POSITIONS, RANK_TYPE, titleName, officeName,
  // for tests
  _test: { neatTime, ipKind, chatParts, words, firstWord, nameOf, reportDetail, whoLine, castleLine },
};
