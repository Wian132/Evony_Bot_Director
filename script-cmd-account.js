'use strict';
// Account commands for scripts: items, truces, quests, reports, the lord, and
// logging out (the command-module contract is at the top of script.js).
//
//   buyitem Ivory Horn | buyitem /count=10 Speaker | buyitem <itemId> [amount]
//        from the shop — the one command that spends cents on its own. More than 100
//        in one order takes confirm (buyitem /count=250 Speaker confirm); one run buys
//        100 items at most in all (a confirmed order may be bigger, once); a bare
//        repeat right after a buyitem line is refused when the script loads
//   useitem Ivory Horn | useitem player.attackinc.1.b | useitem /count=3 Ivory Horn | useitem <item> 3
//   useitem amulet | useitem amulet5 | useitem amulet 3 | useitem Aries Amulet | useitem player.box.gambling.3
//        an item you hold, by name or id. amulet: the amulet you hold; amulet N:
//        player.box.gambling.N. NEAT buys what is missing; here nothing is bought —
//        the line fails and says to buyitem it (and so it does while the inventory
//        has not arrived: an unknown count is none held). Teleporters, the Stone of Finding,
//        Holy Water, hero items and the items that need a target or a text each
//        say which command spends them; useitem Truce Agreement is truce.
//   truce                                a Truce Agreement for the whole account
//   dreamtruce 10:20:00 | dreamtruce 10:20 | dreamtruce 10 20 | dreamtruce /cancel
//        the Dream Truce's start, in SERVER time: 10 hours truced every 24 while they last
//   useangelitem Bob Fleet Feet | useangelitem "My Friend" player.box.present.money.70
//   usedevilitem 111,222 broken gates | usedevilitem 111,222 player.box.present.money.77 [/close]
//   breakgates 111,222 [/close]          a Broken Gates: that city's gates open (/close shuts them)
//   changeflag NEAT                      spends a National Flag (4 letters at most)
//   changeplayername !NeatLover confirm  spends a New ID; `confirm` because the lord's name
//                                        changes for good
//   resetplayer { unlockcode:"IReallyWantToDeleteThisAccount", player:null }
//        DELETES the lord (no undo) and takes the console off the game; the code is the
//        literal text. Making a new lord (player:"name") is not done here.
//   completequests [routine|daily|title|rank|office] [types] [names]
//                  [/mode=routine|daily] [/type=a,b] [/name="a b",c] [/query=available|finished|all]
//        claims every finished quest (both tabs when nothing else is given, the Routine
//        tab otherwise); $result is the list of quests claimed. /query claims nothing and
//        puts the available, finished or all quests in $result instead. title claims the
//        title promotions (Knight .. Prinzessin), rank or office the military ones
//        (Lieutenant .. General); plain routine takes promotions in the game's order.
//   cleanreports | cleanreports barbarian | cleanreports troops,lake
//        deletes every report whose subject or "to" has one of the texts (any case);
//        with none, every report there is. $result: how many went.
//   cleanreports trade|army|other        every report of that kind (OTTObot's form)
//   cleannpcreports                      attack and return reports for Barbarian cities,
//                                        and every transport report, from every city
//   packages                             the city's packages (also inventory)
//   logout now @:14:35 | logout now 1:05:00       off now until then; the run ends here
//   logout 1:00 29:00 | logout @:01:30:31 @:06:35:00
//        NEAT: off at the first time, back at the second, and the script carries on
//        from the next line once the console is back (logout.js)
//
// Every request is the one the client sends, with the command name and fields
// from the decompiled client (cited at each call). The ones that ask for the
// account password — a truce, a dream truce, a reset — sign with the SHA1 the
// login sent, which only the goals update keeps (goals/integration: evony.js
// passwordHash, game.js useTruce); without it they fail and say so. The hash is
// never logged.

const C = require('./constants');
const E = require('./script-expr');

// ------------------------------------------------------------------ words

// The words after a command: "quoted text" is one word, /key=value and
// /key="a b" are switches (the value may be null: /cancel).
function splitArgs(s) {
  const out = [];
  const re = /\/([A-Za-z]+)(?:=(?:"([^"]*)"|'([^']*)'|(\S*)))?|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(s || '')))) {
    if (m[1] !== undefined) out.push({ sw: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? null });
    else if (m[5] !== undefined) out.push({ text: m[5], quoted: true });
    else out.push({ text: m[6] });
  }
  return out;
}
const listOf = (v) => String(v == null ? '' : v).split(',').map((x) => x.trim()).filter(Boolean);
const eqi = (a, b) => String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase();

function wholeCount(v, what) {
  if (!/^\d+$/.test(String(v || '')) || Number(v) < 1) throw new Error(`${what}: the count is a whole number from 1 ("${v ?? ''}")`);
  return Number(v);
}

// A line that goes nowhere: said, and $error set to it.
function fail(env, msg) {
  env.log(`  ${msg} — nothing sent`);
  return { ok: false, error: msg };
}

// ------------------------------------------------------------------ items

const TRUCE_ITEM = 'player.peace.1';           // Truce Agreement
const DREAM_ITEM = 'player.truce.dream';       // Dream Truce
const FLAG_ITEM = 'consume.changeflag.1';      // National Flag
const NAME_ITEM = 'player.name.1.a';           // New ID
const WAR_ENSIGN = 'player.troop.1.a';
// buyitem's bounds: one order of more than BUY_ONE takes confirm, and a run buys
// BUY_RUN items at most (a confirmed order may be bigger, once)
const BUY_ONE = 100;
const BUY_RUN = 100;
const BROKEN_GATES = 'player.box.present.money.77';
const AMULET = (n) => `player.box.gambling.${n}`;

// The holiday items NEAT's Items page names, which the client's catalogue does
// not have. An Angel item is used on a lord by name, a Devil item on a city by
// its coordinates (UseGoodWin.as:1680-1717 isDevil / isAngel).
const ANGEL = {
  'player.box.present.money.70': 'Fleet Feet',
  'player.box.present.money.71': 'Endurance of the Immortals',
  'player.box.present.money.72': "Alchemist's Amplifier",
};
const DEVIL = {
  'player.box.present.money.74': "Opportunist's Plague",
  'player.box.present.money.75': 'Lost in the Wastes',
  'player.box.present.money.76': 'Poisoned Feast',
  [BROKEN_GATES]: 'Broken Gates',
};
const EXTRA_ITEMS = { ...ANGEL, ...DEVIL, 'player.item.stoneoffinding': 'Stone of Finding' };

// Spent on one city through shop.useCastleGoods, not shop.useGoods
// (UseGoodWin.as:1460-1463, 1576-1579).
const CASTLE_ITEMS = new Set(['player.heart.1.a', 'player.pop.1.a', 'player.haunted.castle',
  'player.haunted.castle.adv', 'player.halloween.castle', 'player.halloween.castle.adv']);

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Names and ids from the catalogue (items.js: itemcatalog.json, then the
// server's newer itemdefs.json) and the table above; rebuilt when items.js
// reads a changed file.
let INDEX = null;
function itemIndex() {
  let cat;
  try { cat = require('./items').catalogue(); } catch { cat = new Map(); }
  if (INDEX && INDEX.cat === cat) return INDEX;
  const byId = new Map(), byName = new Map();
  const add = (id, name) => {
    byId.set(id.toLowerCase(), { id, name });
    const k = norm(name);
    if (!k) return;
    if (!byName.has(k)) byName.set(k, []);
    if (!byName.get(k).includes(id)) byName.get(k).push(id);
  };
  for (const [id, name] of Object.entries(EXTRA_ITEMS)) add(id, name);
  for (const [id, d] of cat) add(id, (d && d.name) || id);
  INDEX = { cat, byId, byName };
  return INDEX;
}
function itemName(id) {
  const e = itemIndex().byId.get(String(id).toLowerCase());
  return e ? e.name : String(id);
}
const looksLikeId = (s) => /^[a-z][\w-]*(\.[\w-]+)+$/i.test(s);

// Item text -> { id, name, alts? } | { amulet: true } | null. An id the
// catalogue does not know still goes (the game has items newer than it).
function findItem(text, what) {
  const t = String(text || '').trim();
  if (!t) throw new Error(`${what}: say which item — its name (Ivory Horn) or its id (player.attackinc.1.b)`);
  const ix = itemIndex();
  const hit = ix.byId.get(t.toLowerCase());
  if (hit) return { id: hit.id, name: hit.name };
  // NEAT: amulet, amulet5, amulet 3 (player.box.gambling.N)
  const am = /^amulets?\s*(\d{1,2})?$/i.exec(t);
  if (am) {
    if (am[1] === undefined) return { amulet: true, name: 'amulet' };
    const n = Number(am[1]);
    if (n < 1 || n > 12) throw new Error(`${what}: the amulets are 1 to 12 (player.box.gambling.1 to .12)`);
    return { id: AMULET(n), name: itemName(AMULET(n)) };
  }
  const ids = ix.byName.get(norm(t));
  if (ids && ids.length) return { id: ids[0], name: itemName(ids[0]), ...(ids.length > 1 ? { alts: ids.slice() } : {}) };
  if (looksLikeId(t)) return { id: t, name: t };
  return null;
}
function unknownItem(text, what) {
  const ix = itemIndex();
  if (!ix.cat.size) {
    return new Error(`${what}: item names come from itemcatalog.json, which this install does not have (extract-items.js makes it) — give the item's id`);
  }
  const words = String(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const near = [];
  for (const [k, ids] of ix.byName) {
    if (!words.length || !words.every((w) => k.includes(w))) continue;
    near.push(`${itemName(ids[0])} (${ids[0]})`);
    if (near.length >= 5) break;
  }
  return new Error(`${what}: no item is called "${text}"`
    + (near.length ? ` — did you mean ${near.join(', ')}?` : ' — write it as the Items tab shows it, or give its id'));
}

// buyitem / useitem arguments: /count=N anywhere, then the item, and OTTObot's
// trailing count (useitem player.attackinc.1 2) when the whole text is no item.
function itemArgs(args, what) {
  let count = null;
  const words = [];
  for (const t of splitArgs(args)) {
    if (t.sw) {
      if (t.sw !== 'count') throw new Error(`${what}: unknown switch /${t.sw} — the one there is is /count=N`);
      if (count !== null) throw new Error(`${what}: /count twice`);
      count = wholeCount(t.value, what);
    } else words.push(t.text);
  }
  let text = words.join(' ');
  let item = findItem(text, what);
  const last = words[words.length - 1];
  if (!item && words.length > 1 && /^\d+$/.test(last)) {
    const rest = words.slice(0, -1).join(' ');
    item = findItem(rest, what);
    if (item) {
      if (count !== null) throw new Error(`${what}: two counts — /count=${count} and ${last}`);
      count = wholeCount(last, what);
      text = rest;
    }
  }
  if (!item) throw unknownItem(text, what);
  return { item, count: count === null ? 1 : count };
}

// How many of an item the account holds; null when the inventory never came.
function heldCount(game, id) {
  const items = game && game.player && game.player.items;
  if (!Array.isArray(items)) return null;
  const it = items.find((i) => i && String(i.id) === String(id));
  return it ? Number(it.count || 0) : 0;
}

// A request the game charges cents for when the item is missing (the client
// offers to buy it and sends anyway: StageChangeWin.useGoods, FlagChangeWin
// .useGoods) goes only when the item is held. -> the reason not to, or null.
function mustHold(game, id, name, buy) {
  const n = heldCount(game, id);
  if (n === null) return `the inventory has not arrived, so there is no telling whether a ${name} is held`;
  if (n < 1) return `you hold no ${name} (${id}) — NEAT would buy one; here that is  ${buy}  (it costs cents)`;
  return null;
}

// The goals update's login hash (evony.js passwordHash), for the requests that
// re-ask for the password. Read only when a request goes; never logged.
const signs = (game) => !!(game && game.c && typeof game.c.passwordHash === 'function');
const needsGoals = (what) => `${what} needs the goals update (goals/integration) — the game asks for the account password`
  + ' with it, and only that build keeps the login\'s password hash';

const heroItem = (id) => {
  if (/^hero\.loyalty\.\d+$/.test(id)) return true;
  try { return id !== 'hero.reset.1' && Object.prototype.hasOwnProperty.call(require('./heroitems').ALL, id); } catch { return false; }
};

// What useitem does with an item; the ones spent some other way say how.
function useitemAction(item, count) {
  if (item.amulet) return { cmd: 'useitem', itemId: null, amulet: true, amount: count, name: 'amulet', how: 'goods' };
  const { id, name } = item;
  // The client never spends these through shop.useGoods; each has its own move command.
  if (require('./teleport').ITEM_IDS.has(id)) {
    throw new Error(`useitem: ${id} is a teleporter — use  teleport <x,y>  |  teleport <state>  |  teleport random  |  warteleport <x,y>`);
  }
  if (id === require('./stone-of-finding').ITEM_ID) {
    throw new Error('useitem: the Stone of Finding is spent by  recover <hero>  — run  lostheroes  to see who it can bring back');
  }
  if (id === require('./water-hero').ITEM_ID) {
    throw new Error('useitem: Holy Water is spent on a hero by  waterhero <hero> [/heropoints="att"]');
  }
  // NEAT: truce is "useitem Truce Agreement". The item window refuses it and
  // sends people to Player Info (UseGoodWin.as:1437-1440).
  if (id === TRUCE_ITEM) {
    if (count > 1) throw new Error('useitem: one Truce Agreement at a time — the account is truced 12 hours by one');
    return { cmd: 'truce', itemId: id };
  }
  if (id === DREAM_ITEM) {
    throw new Error('useitem: a Dream Truce is set with  dreamtruce hh:mm:ss  (server time) — the item opens that window in the game too (UseGoodWin.as:1442-1446)');
  }
  if (ANGEL[id]) throw new Error(`useitem: ${name} is used on another lord —  useangelitem <lord> ${name}`);
  if (DEVIL[id]) {
    throw new Error(`useitem: ${name} is used on a city —  usedevilitem <x,y> ${name}${id === BROKEN_GATES ? '   (or  breakgates <x,y>)' : ''}`);
  }
  if (id === FLAG_ITEM) throw new Error('useitem: a National Flag changes the flag —  changeflag <new flag>');
  if (id === NAME_ITEM) throw new Error('useitem: a New ID renames the lord —  changeplayername <new name> confirm');
  if (heroItem(id)) throw new Error(`useitem: ${name} is used on a hero —  useheroitem <hero> ${name}`);
  if (id === WAR_ENSIGN) throw new Error('useitem: a War Ensign has no Use button — it goes out with a march from the Rally Spot');
  if (/\.quest\./.test(id)) throw new Error(`useitem: ${name} is a quest item — the game has no Use button for it`);
  return {
    cmd: 'useitem', itemId: id, amount: count, name, how: CASTLE_ITEMS.has(id) ? 'castle' : 'goods',
    ...(item.alts ? { alts: item.alts } : {}),
  };
}

const named = (name, id) => (name && name !== id ? `${name} (${id})` : String(id));

async function runUseitem(a, env) {
  const game = env.game;
  const castle = env.castle;
  let id = a.itemId, name = a.name;
  // amulet: the one held (most of); a name several items share: the one held
  if ((a.amulet || a.alts) && !Array.isArray(game.player && game.player.items)) {
    env.log(`  use ${a.amount} x ${name} in ${castle.name}`);
    return fail(env, `the inventory has not arrived, so there is no telling which ${name} is held`);
  }
  if (a.amulet || a.alts) {
    const pool = a.amulet ? Array.from({ length: 12 }, (_, i) => AMULET(i + 1)) : a.alts;
    const held = pool.map((x) => [x, heldCount(game, x) || 0]).filter(([, n]) => n > 0).sort((p, q) => q[1] - p[1]);
    if (held.length) { id = held[0][0]; name = itemName(id); } else if (a.amulet) {
      env.log(`  use ${a.amount} x amulet in ${castle.name}`);
      return fail(env, 'you hold no amulet (player.box.gambling.1 to .12) — NEAT would buy one; here that is  buyitem <sign> Amulet'
        + '  (it costs cents; the shop sells the month\'s sign)');
    }
  }
  env.log(`  use ${a.amount} x ${named(name, id)} in ${castle.name}`);
  const have = heldCount(game, id);
  // the game buys a missing item with cents, so an unknown count is none held
  if (have === null) return fail(env, `the inventory has not arrived, so there is no telling whether ${a.amount} x ${name} ${a.amount === 1 ? 'is' : 'are'} held`);
  if (have < a.amount) {
    return fail(env, have === 0
      ? `you hold no ${name} — NEAT would buy it; here that is  buyitem ${name}  (it costs cents)`
      : `you hold ${have} ${name}, not ${a.amount} — use  useitem /count=${have} ${name}, or buyitem the rest`);
  }
  if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
  const cid = game.castleId(castle);
  if (a.how === 'castle') {
    // shop.useCastleGoods {castleId, itemId} — one each: ShopCommands.as:116-124, UseGoodWin.as:1578
    let done = 0;
    for (let i = 0; i < a.amount; i++) {
      const r = await game.useCastleItem(cid, id);
      done++;
      env.log('  -> ' + env.say(r));
      if (!r || r.ok !== 1) break;
    }
    return { done };
  }
  // shop.useGoods {castleId, itemId, num}: ShopCommands.as:58-67, UseGoodWin.as:1505
  const r = await game.useItem(cid, id, a.amount);
  env.log('  -> ' + env.say(r));
  return { done: 1 };
}

// ------------------------------------------------------------------ holiday items

// usedevilitem 111,222 broken gates | breakgates 111,222 [/close]
function parseDevil(args, what, fixed) {
  let close = null;
  const words = [];
  for (const t of splitArgs(String(args || '').replace(/(\d)\s*,\s*(\d)/, '$1,$2'))) {
    if (!t.sw) { words.push(t.text); continue; }
    if (t.sw === 'close' || t.sw === 'open') { close = t.sw === 'close'; continue; }
    throw new Error(`${what}: unknown switch /${t.sw} — a Broken Gates takes /open (the default) or /close`);
  }
  const m = /^(\d+),(\d+)$/.exec(words[0] || '');
  if (!m) throw new Error(`${what}: say where first — the city's coordinates, like  ${what} 111,222${fixed ? '' : ' broken gates'}`);
  const x = Number(m[1]), y = Number(m[2]);
  if (x >= C.MAP_W || y >= C.MAP_W) throw new Error(`${what}: ${x},${y} is off the map (0 to ${C.MAP_W - 1})`);
  let item;
  if (fixed) {
    if (words.length > 1) throw new Error(`${what}: unexpected "${words.slice(1).join(' ')}" — ${what} <x,y> [/close]`);
    item = { id: fixed, name: DEVIL[fixed] };
  } else {
    const text = words.slice(1).join(' ');
    if (!text) throw new Error(`${what}: say which Devil item — ${Object.values(DEVIL).join(', ')}`);
    item = findItem(text, what);
    if (!item) throw unknownItem(text, what);
    if (!DEVIL[item.id]) throw new Error(`${what}: ${item.name || text} is not a Devil item — those are ${Object.values(DEVIL).join(', ')}`);
  }
  if (close !== null && item.id !== BROKEN_GATES) throw new Error(`${what}: /open and /close are for a Broken Gates`);
  return { cmd: fixed ? 'breakgates' : 'usedevilitem', x, y, itemId: item.id, name: DEVIL[item.id] || item.name,
    ...(item.id === BROKEN_GATES ? { gates: close ? 'close' : 'open' } : {}) };
}

async function runDevil(a, env) {
  const game = env.game;
  const own = (game.castles || []).find((c) => { const p = game.castleXY(c); return p && p.x === a.x && p.y === a.y; });
  const gates = a.gates === 'close' ? ' — its gates shut again' : a.gates === 'open' ? ' — its gates held open for an hour' : '';
  env.log(`  ${a.name} on the city at ${a.x},${a.y}${own ? ` (your ${own.name})` : ''}${gates}`);
  if (own && a.gates !== 'close') {
    return fail(env, `${a.x},${a.y} is your own city ${own.name}, and a Devil item works against the city it lands on`
      + (a.itemId === BROKEN_GATES ? ` (breakgates ${a.x},${a.y} /close shuts your gates again)` : ''));
  }
  const bad = mustHold(game, a.itemId, a.name, `buyitem ${a.name}`);
  if (bad) return fail(env, bad);
  if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
  // shop.useDevilItem {x, y, itemId, paramdata}: ShopCommands.as:72-82. The Use
  // button sends paramdata "" (UseGoodWin.as:1486); a Broken Gates has no Use
  // button, only Open "1" and Close "0" (UseGoodWin.as:1342, 1318, 1165-1172).
  const paramdata = a.gates === 'close' ? '0' : a.gates === 'open' ? '1' : '';
  const r = await game.req('shop.useDevilItem', { x: a.x, y: a.y, itemId: a.itemId, paramdata });
  env.log('  -> ' + env.say(r));
  return { done: 1 };
}

// ------------------------------------------------------------------ the lord

// Lord names and flags as the client's boxes take them: no quote, backslash or
// space (InputTextFilter.specialCharFilter); a lord's name 10 wide at most, a
// character from U+0391 up counting 2 (NameChangeWin.textChange); a flag 4
// characters (FlagChangeWin.as:206 maxChars).
const WIDE = /[Α-￥]/;
const width = (s) => String(s).split('').reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);

const UNLOCK = 'IReallyWantToDeleteThisAccount';
const RESET_KEYS = ['unlockcode', 'player', 'city', 'flag', 'sex', 'zone', 'runscript'];
const RESET_USAGE = `resetplayer: usage  resetplayer { unlockcode:"${UNLOCK}", player:null }`;

// resetplayer deletes the lord for good. The unlock code keeps it from being a
// typo, but a script can also come from `get` or `call`, so the console's
// operator has to switch it on too: start the console with
// OTTO_ALLOW_RESET_PLAYER=1. Nothing a script writes can switch it on.
const ALLOW = { resetPlayer: process.env.OTTO_ALLOW_RESET_PLAYER === '1' };

function literal(n) {
  if (n.type === 'str' || n.type === 'num' || n.type === 'lit') return n.value;
  if (n.type === 'tpl' && n.parts.every((p) => typeof p === 'string')) return n.parts.join('');
  if (n.type === 'unary' && n.op === '-' && n.arg.type === 'num') return -n.arg.value;
  throw new Error('resetplayer: the fields take plain values — "text", a number or null');
}

function parseReset(args) {
  if (!ALLOW.resetPlayer) {
    throw new Error('resetplayer is off in this console: it deletes the lord for good, so it runs only when the console'
      + ' is started with OTTO_ALLOW_RESET_PLAYER=1');
  }
  let ast;
  try { ast = E.parseExpression(String(args || '').trim()); } catch { throw new Error(RESET_USAGE); }
  if (!ast || ast.type !== 'obj') throw new Error(RESET_USAGE);
  const o = {};
  for (const p of ast.props) {
    const k = String(p.key).toLowerCase();
    if (!RESET_KEYS.includes(k)) throw new Error(`resetplayer: there is no field "${p.key}" — ${RESET_KEYS.join(', ')}`);
    o[k] = literal(p.value);
  }
  if (o.unlockcode !== UNLOCK) {
    throw new Error(`resetplayer: the unlock code is the text ${UNLOCK}, written exactly — nothing else deletes the lord`);
  }
  if (!('player' in o) || (o.player !== null && o.player !== '')) {
    throw new Error('resetplayer: only  player:null  works here (the lord is deleted and the console goes off the game) —'
      + ' a new lord is made after a fresh login answers the game\'s create-player step (common.createNewPlayer, with a captcha),'
      + ' which OTTObot\'s login does not do');
  }
  for (const k of ['city', 'flag', 'sex', 'zone', 'runscript']) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== '') throw new Error(`resetplayer: ${k} is for a new lord, and none is made here (player:null)`);
  }
  return { cmd: 'resetplayer', player: null };
}

// ------------------------------------------------------------------ quests

// quest.getQuestType's `type`: the Routine tab (成长任务) asks with 1, the
// Daily tab (日常任务) with 3 (QuestWin.as:942-946, 1765-1766).
const QUEST_MODES = { routine: 1, daily: 3 };
// PlayerInfoTypeManager.getTitle 1-9 and getOffice 1-5, in the game's English.
const TITLES = ['Knight', 'Baronet', 'Baron', 'Viscount', 'Earl', 'Marquis', 'Duke', 'Furstin', 'Prinzessin'];
const RANKS = ['Lieutenant', 'Captain', 'Major', 'Colonel', 'General'];
const QUERIES = ['available', 'finished', 'all'];

function parseQuests(args) {
  const toks = splitArgs(args);
  let mode = null, promo = null, types = null, names = null, query = null;
  const pos = [];
  for (const t of toks) {
    if (t.sw) {
      const v = t.value;
      if (t.sw === 'mode') {
        const m = String(v || '').toLowerCase();
        if (!QUEST_MODES[m]) throw new Error('completequests: /mode is routine or daily');
        if (mode && mode !== m) throw new Error('completequests: one mode — routine or daily');
        mode = m;
      } else if (t.sw === 'type' || t.sw === 'name') {
        const list = listOf(v);
        if (!list.length) throw new Error(`completequests: /${t.sw}= needs a value, like /${t.sw}=${t.sw === 'type' ? 'Rebuild,Promotion' : '"Population Increase"'}`);
        if (t.sw === 'type') { if (types) throw new Error('completequests: /type twice'); types = list; } else { if (names) throw new Error('completequests: /name twice'); names = list; }
      } else if (t.sw === 'query') {
        const q = String(v || '').toLowerCase();
        if (!QUERIES.includes(q)) throw new Error('completequests: /query is available, finished or all');
        query = q;
      } else throw new Error(`completequests: there is no /${t.sw} — the switches are /mode, /type, /name and /query`);
      continue;
    }
    const w = t.text.toLowerCase();
    if (!t.quoted && !pos.length && QUEST_MODES[w] && !mode) { mode = w; continue; }
    if (!t.quoted && !pos.length && ['title', 'rank', 'office'].includes(w) && !promo) { promo = w === 'title' ? 'title' : 'rank'; continue; }
    pos.push(t.text);
  }
  // NEAT's bare words: the quest types first, then the names
  // (completequests routine "Commodity Gathering" farming)
  for (const p of pos) {
    if (!types) types = listOf(p);
    else if (!names) names = listOf(p);
    else throw new Error(`completequests: unexpected "${p}" — after the mode come the quest types, then the names; a name with spaces goes in quotes`);
  }
  if (promo) {
    if (mode === 'daily') throw new Error(`completequests ${promo}: promotions are routine quests`);
    if (types && !types.some((x) => eqi(x, 'promotion'))) throw new Error(`completequests ${promo}: ${promo} means the Promotion quests — leave the type out`);
    types = ['Promotion'];
    names = names || (promo === 'title' ? TITLES : RANKS);
  }
  // Nothing at all: every quest on both tabs. Anything given: the Routine tab
  // unless daily is named (NEAT: "routine is assumed if /query is the only
  // parameter", and /type=Rebuild is "the same as" routine /type=Rebuild).
  const modes = mode ? [mode] : toks.length ? ['routine'] : ['routine', 'daily'];
  return { cmd: 'completequests', modes, types, names, query, ...(promo ? { promo } : {}) };
}

const finished = (q) => q.isFinish === true || q.isFinish === 1;

// The quests a /name list means: a name matched whole (any case), or, for a
// name no quest has whole, the quests with it as a word ("Knight" in a longer
// promotion name). The game's order is kept.
function byNames(list, names) {
  if (!names) return list;
  const keep = new Set();
  for (const n of names) {
    const exact = list.filter((q) => eqi(q.name, n));
    const w = String(n).trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^a-z0-9])${w}($|[^a-z0-9])`, 'i');
    for (const q of exact.length ? exact : list.filter((x) => re.test(String(x.name || '')))) keep.add(q);
  }
  return list.filter((q) => keep.has(q));
}

// A quest as scripts see it (QuestBean, with its QuestTargetBeans): plain data.
function questView(q, ty, mode) {
  const targets = () => (Array.isArray(q.targets) ? q.targets : [])
    .map((t) => ({ name: String(t && t.name != null ? t.name : ''), finished: !!(t && (t.finished === true || t.finished === 1)) }));
  return {
    questId: Number(q.questId), name: String(q.name ?? ''), type: String(ty.name ?? ''), typeId: Number(ty.typeId), mode,
    description: String(q.description ?? ''), manual: String(q.manual ?? ''), award: String(q.award ?? '').trim(),
    isCard: !!q.isCard, isFinish: finished(q), finished: finished(q), targetsArray: targets(), targets: targets(),
  };
}

// One quest command at a time per connection: the replies name only the
// command, not the list or the quest they answer.
const laneReq = (game, cmd, data) => (typeof game.lane === 'function' ? game.lane(cmd, () => game.req(cmd, data)) : game.req(cmd, data));

function describeQuests(a) {
  const parts = [];
  if (a.types) parts.push(`type ${a.types.join(', ')}`);
  if (a.names) parts.push(`named ${a.names.join(', ')}`);
  const tabs = a.modes.join(' and ');
  return (a.query ? `list the ${a.query === 'all' ? '' : a.query + ' '}${tabs} quests` : `claim every finished ${tabs} quest`)
    + (parts.length ? ` (${parts.join('; ')})` : '');
}

async function runQuests(a, env) {
  const game = env.game;
  const cid = env.cid;
  env.log('  ' + describeQuests(a));
  if (env.dryRun) { env.log('  [dry run] not sent'); return { result: [] }; }
  const out = [];
  let tries = 0, refusals = 0, lastRefusal = null;
  const readList = async (ty) => {
    // quest.getQuestList {castleId, typeId}: QuestCommands.as:32-43, as QuestWin asks it (QuestWin.as:641)
    const r = await laneReq(game, 'quest.getQuestList', { castleId: cid, typeId: ty.typeId });
    if (!r || r.ok !== 1) { env.log(`  ${ty.name} -> ${env.say(r)}`); return null; }
    return Array.isArray(r.quests) ? r.quests : [];
  };
  for (const mode of a.modes) {
    // quest.getQuestType {castleId, type}: QuestCommands.as:59-70 -> the tab's quest types
    const tr = await laneReq(game, 'quest.getQuestType', { castleId: cid, type: QUEST_MODES[mode] });
    if (!tr || tr.ok !== 1) { env.log(`  ${mode} quests -> ${env.say(tr)}`); continue; }
    const types = (Array.isArray(tr.types) ? tr.types : []).filter((ty) => !a.types || a.types.some((x) => eqi(x, ty.name)));
    for (const ty of types) {
      if (env.stopped()) break;
      // QuestTypeBean.isFinish: the type has something finished (QuestWin.countDoneValue)
      if (!a.query && ty.isFinish === false) continue;
      let list = await readList(ty);
      if (!list) continue;
      if (a.query) {
        for (const q of byNames(list, a.names)) {
          if (a.query === 'all' || (a.query === 'finished') === finished(q)) out.push(questView(q, ty, mode));
        }
        continue;
      }
      // One claim, then the list again: a claim can open the next quest, and a
      // promotion can use up what another one needed (NEAT: routine takes the
      // first promotion listed).
      const tried = new Set();
      for (let guard = 0; guard < 100 && !env.stopped(); guard++) {
        const q = byNames(list, a.names).find((x) => finished(x) && !tried.has(x.questId));
        if (!q) break;
        tried.add(q.questId);
        tries++;
        // quest.award {castleId, questId}: QuestCommands.as:100-111, the claim button (QuestWin.as:1293)
        const r = await laneReq(game, 'quest.award', { castleId: cid, questId: q.questId });
        const award = String(q.award || '').trim().replace(/\s+/g, ' ');
        env.log(`  claim ${q.name} (${ty.name}) -> ${env.verdict(r)}${r && r.ok === 1 && award ? ' — ' + award : ''}`);
        if (r && r.ok === 1) out.push({ ...questView(q, ty, mode), claimed: true });
        else { refusals++; lastRefusal = env.verdict(r); }
        list = await readList(ty);
        if (!list) break;
      }
    }
  }
  if (a.query) {
    const names = out.map((q) => q.name);
    env.log(`  ${out.length} quest${out.length === 1 ? '' : 's'}${names.length ? ': ' + names.slice(0, 20).join(', ') + (names.length > 20 ? ', …' : '') : ''}`);
    return { result: out };
  }
  env.log(out.length ? `  claimed ${out.length} quest${out.length === 1 ? '' : 's'}` : tries ? '  nothing claimed' : '  nothing finished to claim');
  // A claim the game refused is logged; the line fails only when none went
  // through (or a list could not be read: say() marked that).
  if (tries && !out.length) return { done: tries, ok: false, error: lastRefusal || 'the game refused every claim', result: out };
  if (refusals) env.log(`  ${refusals} claim${refusals === 1 ? '' : 's'} refused — last: ${lastRefusal}`);
  return { done: tries, result: out };
}

// ------------------------------------------------------------------ reports

const REPORT_KINDS = ['trade', 'army', 'other'];   // constants.js REPORT_TYPE 0 1 2 (ObjConstants.REPORT_TYPE_*)
const PAGE = 50;
const MAX_PAGES = 200;

// Every report of those kinds `pick` takes. All of it is read before anything
// goes (a delete moves the rest up a page), then deleted 50 at a time.
async function cleanWhere(env, kinds, pick) {
  const game = env.game;
  const ids = [];
  let seen = 0;
  for (const kind of kinds) {
    for (let page = 1, total = 1; page <= total && page <= MAX_PAGES; page++) {
      // report.receiveReportList {pageNo, pageSize, reportType}: ReportCommands.as:39-48 (Game.reportList)
      const d = await game.reportList(kind, page, PAGE);
      if (!d || (d.ok !== undefined && d.ok !== 1)) { env.log(`  ${kind} reports -> ${env.say(d)}`); break; }
      const rows = Array.isArray(d.reports) ? d.reports : [];
      seen += rows.length;
      for (const r of rows) if (pick(r)) ids.push(r.id);
      total = Number(d.totalPage) || 1;
      if (!rows.length) break;
    }
  }
  let removed = 0;
  for (let i = 0; i < ids.length; i += PAGE) {
    const chunk = ids.slice(i, i + PAGE);
    // report.deleteReport {idStr}: ReportCommands.as:70-77, "delete selected" (Game.deleteReports)
    const r = await game.deleteReports(chunk);
    if (r && r.ok !== undefined && r.ok !== 1) { env.log('  delete -> ' + env.say(r)); break; }
    removed += chunk.length;
  }
  return { seen, removed };
}

// ------------------------------------------------------------------ commands

const commands = {
  buyitem: {
    usage: `buyitem [/count=N] <item name or id> [confirm] | buyitem <itemId> [amount]   (more than ${BUY_ONE} at once takes confirm;`
      + ` a run buys ${BUY_RUN} at most)`,
    // script.js refuses a bare `repeat` (or `repeat 0`) right after this line when it loads
    noBareRepeat: 'a repeat with no count after it would buy until the cents run out — give it a count (repeat 5)',
    parse(args) {
      const toks = splitArgs(args);
      const last = toks[toks.length - 1];
      const confirm = !!(last && !last.sw && !last.quoted && /^confirm$/i.test(last.text));
      const { item, count } = itemArgs(confirm ? String(args).replace(/\s*confirm\s*$/i, '') : args, 'buyitem');
      if (item.amulet) {
        throw new Error('buyitem: say which amulet — buyitem Aries Amulet, or buyitem amulet 3 for player.box.gambling.3 (the shop sells the month\'s sign)');
      }
      if (item.alts) throw new Error(`buyitem: ${item.alts.length} items are called ${item.name} — ${item.alts.join(', ')}; give the id`);
      if (count > BUY_ONE && !confirm) {
        throw new Error(`buyitem: ${count.toLocaleString('en-US')} x ${item.name} in one order spends cents on more than ${BUY_ONE} —`
          + ` end the line with confirm to mean it: buyitem /count=${count} ${item.name} confirm`);
      }
      return { cmd: 'buyitem', itemId: item.id, amount: count, name: item.name, ...(confirm ? { confirm: true } : {}) };
    },
    async run(a, env) {
      const info = (env.game.player && env.game.player.playerInfo) || {};
      // A run buys BUY_RUN items at most in all (a loop around a buyitem line has
      // no other end); a confirmed line may go past that with its own one order.
      const bought = env.state.bought || 0;
      const cap = Math.max(BUY_RUN, a.confirm ? a.amount : 0);
      if (bought + a.amount > cap) {
        // refused: a loop that keeps asking is stopped by the VM (10 in a row)
        return { ...fail(env, `this run has bought ${bought.toLocaleString('en-US')} item(s) already, and ${a.amount.toLocaleString('en-US')} more`
          + ` would pass the ${cap.toLocaleString('en-US')} a run may buy — start the script again to buy more`), refused: true };
      }
      // PlayerInfoBean.medal is the coin balance the client checks a price against (UIUtil.checkItem)
      const cents = typeof info.medal === 'number' ? `; you have ${info.medal.toLocaleString('en-US')}` : '';
      env.log(`  buy ${a.amount} x ${named(a.name, a.itemId)} from the shop (costs cents${cents})`);
      if (env.dryRun) { env.state.bought = bought + a.amount; env.log('  [dry run] not sent'); return {}; }
      // shop.buy {itemId, amount}: ShopCommands.as:33-41 (Game.buyItem)
      const r = await env.game.buyItem(a.itemId, a.amount);
      env.log('  -> ' + env.say(r));
      if (r && r.ok === 1) env.state.bought = bought + a.amount;
      return { done: 1 };
    },
  },

  useitem: {
    usage: 'useitem [/count=N] <item name or id> [num] | useitem amulet[N]',
    parse(args) {
      const { item, count } = itemArgs(args, 'useitem');
      return useitemAction(item, count);
    },
    run: runUseitem,
  },

  // NEAT: the same as `useitem Truce Agreement`.
  truce: {
    usage: 'truce',
    parse(args) {
      if (String(args || '').trim()) throw new Error('truce: nothing goes after it — it spends one Truce Agreement');
      return { cmd: 'truce', itemId: TRUCE_ITEM };
    },
    async run(a, env) {
      const game = env.game;
      env.log('  a Truce Agreement for the whole account: 12 hours in which it cannot attack or be attacked');
      const bad = mustHold(game, a.itemId, 'Truce Agreement', 'buyitem Truce Agreement');
      if (bad) return fail(env, bad);
      if (typeof game.useTruce !== 'function') return fail(env, needsGoals('truce'));
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      // city.setStopWarState {ItemId, passWord}: CityCommands.as:134-142, sent from
      // Player Info (StageChangeWin.as:447); the goals build's Game.useTruce signs it.
      const r = await game.useTruce(a.itemId);
      env.log('  -> ' + env.say(r));
      return { done: 1 };
    },
  },

  dreamtruce: {
    usage: 'dreamtruce hh:mm[:ss] | dreamtruce hh mm [ss] | dreamtruce /cancel   (server time)',
    parse(args) {
      const toks = splitArgs(args);
      if (toks.length === 1 && toks[0].sw === 'cancel') return { cmd: 'dreamtruce', cancel: true };
      const usage = 'dreamtruce: usage  dreamtruce 10:20:00  |  dreamtruce 10 20  |  dreamtruce /cancel   (the server\'s clock)';
      if (toks.some((t) => t.sw)) throw new Error(usage);
      const words = toks.map((t) => t.text);
      let parts;
      if (words.length === 1 && /^\d{1,2}:\d{1,2}(:\d{1,2})?$/.test(words[0])) parts = words[0].split(':');
      else if (words.length >= 2 && words.length <= 3 && words.every((w) => /^\d{1,2}$/.test(w))) parts = words;
      else throw new Error(usage);
      const [hour, minute, second = 0] = parts.map(Number);
      if (hour > 23 || minute > 59 || second > 59) throw new Error(`dreamtruce: ${parts.join(':')} is not a time of day (24-hour, server time)`);
      return { cmd: 'dreamtruce', hour, minute, second };
    },
    async run(a, env) {
      const game = env.game;
      const p2 = (n) => String(n).padStart(2, '0');
      const now = typeof game.serverClock === 'function' ? game.serverClock().text : null;
      const buffs = game.player && Array.isArray(game.player.buffs) ? game.player.buffs : [];
      // StopWar.checkBuff: a Dream Truce already set shows as a DreamTruceBuff (StopWar.as:489-500)
      const set = buffs.some((b) => b && b.typeId === 'DreamTruceBuff');
      if (a.cancel) env.log('  cancel the Dream Truce, so it stops coming back');
      else {
        env.log(`  ${set ? 'move the Dream Truce to' : 'a Dream Truce from'} ${p2(a.hour)}:${p2(a.minute)}:${p2(a.second)} server time`
          + `${now ? ` (${now} there now)` : ''}: 10 hours truced, then 14 not, every day while the items last`);
        if (!set) {
          const bad = mustHold(game, DREAM_ITEM, 'Dream Truce', 'buyitem Dream Truce');
          if (bad) return fail(env, bad);
        }
      }
      if (!signs(game)) return fail(env, needsGoals('dreamtruce'));
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      const password = game.c.passwordHash();
      if (!password) return fail(env, 'this session never logged in with a password, so it cannot sign a dream truce');
      let r;
      if (a.cancel) {
        // truce.cancelDreamTruce {password}: TruceCommands.as:23-33, TruceChangeWin.as:669
        r = await game.req('truce.cancelDreamTruce', { password });
      } else if (set) {
        // truce.changeDreamTruceTime {hour, minute, second, password}: TruceCommands.as:35-48, TruceChangeWin.as:660
        r = await game.req('truce.changeDreamTruceTime', { hour: a.hour, minute: a.minute, second: a.second, password });
      } else {
        // truce.setDreamTruce {hour, minute, second, password}: TruceCommands.as:55-68, StopWar.as:521
        r = await game.req('truce.setDreamTruce', { hour: a.hour, minute: a.minute, second: a.second, password });
      }
      env.log('  -> ' + env.say(r));
      return { done: 1 };
    },
  },

  useangelitem: {
    usage: 'useangelitem <lord> <item>   (Fleet Feet, Endurance of the Immortals, Alchemist\'s Amplifier; "a lord name" with spaces in quotes)',
    parse(args) {
      const toks = splitArgs(args);
      if (toks.some((t) => t.sw)) throw new Error('useangelitem: no switches — useangelitem <lord> <item>');
      if (toks.length < 2) throw new Error('useangelitem: usage  useangelitem <lord> <item>   e.g.  useangelitem "My Friend" Fleet Feet');
      const lord = toks[0].text.trim();
      if (!lord) throw new Error('useangelitem: say which lord first');
      const text = toks.slice(1).map((t) => t.text).join(' ');
      const item = findItem(text, 'useangelitem');
      if (!item) throw unknownItem(text, 'useangelitem');
      if (!ANGEL[item.id]) throw new Error(`useangelitem: ${item.name || text} is not an Angel item — those are ${Object.values(ANGEL).join(', ')}`);
      return { cmd: 'useangelitem', lord, itemId: item.id, name: ANGEL[item.id] };
    },
    async run(a, env) {
      const game = env.game;
      env.log(`  ${a.name} on the lord ${a.lord}`);
      const bad = mustHold(game, a.itemId, a.name, `buyitem ${a.name}`);
      if (bad) return fail(env, bad);
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      // shop.useAngelItem {playername, itemId}: ShopCommands.as:87-95, UseGoodWin.as:1480-1482
      const r = await game.req('shop.useAngelItem', { playername: a.lord, itemId: a.itemId });
      env.log('  -> ' + env.say(r));
      return { done: 1 };
    },
  },

  usedevilitem: {
    usage: 'usedevilitem <x,y> <item> [/close]   (Opportunist\'s Plague, Lost in the Wastes, Poisoned Feast, Broken Gates)',
    parse: (args) => parseDevil(args, 'usedevilitem', null),
    run: runDevil,
  },

  // NEAT: a shortcut for usedevilitem <x,y> Broken Gates.
  breakgates: {
    usage: 'breakgates <x,y> [/close]',
    parse: (args) => parseDevil(args, 'breakgates', BROKEN_GATES),
    run: runDevil,
  },

  changeflag: {
    usage: 'changeflag <flag>   (spends a National Flag; 4 letters at most)',
    parse(args) {
      const toks = splitArgs(args);
      if (toks.length !== 1 || toks[0].sw) throw new Error('changeflag: usage  changeflag <flag>   e.g.  changeflag NEAT');
      const flag = toks[0].text;
      if (!flag || /["'\\\s]/.test(flag)) throw new Error(`changeflag: the game takes no quote, backslash or space in a flag ("${flag}")`);
      if (flag.length > 4) throw new Error(`changeflag: a flag is 4 characters at most — "${flag}" has ${flag.length}`);
      return { cmd: 'changeflag', flag };
    },
    async run(a, env) {
      const game = env.game;
      const info = (game.player && game.player.playerInfo) || {};
      env.log(`  the flag ${info.flag ? `"${info.flag}" ` : ''}becomes "${a.flag}" (spends a National Flag)`);
      if (info.flag === a.flag) return fail(env, `the flag is "${a.flag}" already`);
      const bad = mustHold(game, FLAG_ITEM, 'National Flag', 'buyitem National Flag');
      if (bad) return fail(env, bad);
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      // city.modifyFlag {newFlag}: CityCommands.as:71-78, FlagChangeWin.as:421
      const r = await game.req('city.modifyFlag', { newFlag: a.flag });
      env.log('  -> ' + env.say(r));
      if (!r || r.ok !== 1) return { done: 1 };
      // as FlagChangeWin.modifyFlagResponse keeps it (FlagChangeWin.as:444)
      if (game.player && game.player.playerInfo) game.player.playerInfo.flag = a.flag;
      return { done: 1, result: a.flag };
    },
  },

  changeplayername: {
    usage: 'changeplayername <new name> confirm   (spends a New ID; the lord\'s name changes for good)',
    parse(args) {
      const toks = splitArgs(args);
      if (toks.some((t) => t.sw) || !toks.length) throw new Error('changeplayername: usage  changeplayername <new name> confirm');
      const words = toks.map((t) => t.text);
      const name = words[0];
      if (words.length > 2 || (words.length === 2 && words[1].toLowerCase() !== 'confirm')) {
        throw new Error('changeplayername: a lord\'s name has no spaces — changeplayername <new name> confirm');
      }
      if (words.length < 2) {
        throw new Error(`changeplayername: this renames the lord for good and spends a New ID — add  confirm  to mean it:  changeplayername ${name} confirm`);
      }
      if (!name || /["'\\\s]/.test(name)) throw new Error(`changeplayername: the game takes no quote, backslash or space in a lord's name ("${name}")`);
      if (width(name) > 10) throw new Error(`changeplayername: "${name}" is too long — the game takes 10 letters at most, and a Chinese character counts as 2`);
      return { cmd: 'changeplayername', name };
    },
    async run(a, env) {
      const game = env.game;
      const info = (game.player && game.player.playerInfo) || {};
      env.log(`  the lord ${info.userName || '?'} becomes ${a.name} (spends a New ID)`);
      if (info.userName === a.name) return fail(env, `the lord is called ${a.name} already`);
      const bad = mustHold(game, NAME_ITEM, 'New ID', 'buyitem New ID');
      if (bad) return fail(env, bad);
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      // city.modifyUserName {userName, itemId}: CityCommands.as:96-104, NameChangeWin.as:416
      const r = await game.req('city.modifyUserName', { userName: a.name, itemId: NAME_ITEM });
      env.log('  -> ' + env.say(r));
      if (!r || r.ok !== 1) return { done: 1 };
      // A run follows a reconnect only onto a Game of the same lord (script.js
      // follow), so the name this Game knows moves with the lord.
      if (game.player && game.player.playerInfo) game.player.playerInfo.userName = a.name;
      return { done: 1, result: a.name };
    },
  },

  resetplayer: {
    usage: `resetplayer { unlockcode:"${UNLOCK}", player:null }   (deletes the lord; there is no undo)`,
    parse: (args) => parseReset(args),
    async run(a, env) {
      const game = env.game;
      const info = (game.player && game.player.playerInfo) || {};
      env.log(`  DELETE the lord ${info.userName || ''} and start over — every city, hero and item goes, and the game cannot`
        + ' undo it; no new lord is made (player:null)');
      if (!signs(game)) return fail(env, needsGoals('resetplayer'));
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      const pwd = game.c.passwordHash();
      if (!pwd) return fail(env, 'this session never logged in with a password, so it cannot confirm a reset');
      // common.deleteUserAndRestart {pwd}: CommonCommands.as:338-345, RestartGameWin.as:435
      const r = await game.req('common.deleteUserAndRestart', { pwd });
      env.log('  -> ' + env.say(r));
      // -200: the account's security code comes first (RestartGameWin.as:356-366)
      if (r && r.ok === -200) env.log('  the game wants the account\'s security code first — nothing was deleted');
      if (!r || r.ok !== 1) return { done: 1 };
      // The client restarts into the create-player screen here. A login would
      // find no lord, so the console stands down until Connect is pressed.
      if (env.session && typeof env.session.logoutUntil === 'function') {
        env.session.logoutUntil(Date.now() + 365 * 86400000, 'the lord was deleted by resetplayer — make a new one in the game, then press Connect');
        env.log('  the console is off the game — make a new lord in the game client, then press Connect');
      }
      return { done: 1, end: true };
    },
  },

  completequests: {
    usage: 'completequests [routine|daily|title|rank|office] [types] [names] [/mode=] [/type=] [/name=] [/query=available|finished|all]',
    parse: (args) => parseQuests(args),
    run: runQuests,
  },

  packages: {
    aliases: ['inventory'],
    usage: 'packages',
    parse: () => ({ cmd: 'packages' }),
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      const d = await game.packageList(game.castleId(castle));
      const ps = d.packages || [];
      if (!ps.length) { env.log('  no packages'); return {}; }
      for (const p of ps.slice(0, 25)) env.log(`  [${p.id}] ${p.packageName} (status ${p.status}, ${(p.itemList || []).length} item(s))`);
      if (ps.length > 25) env.log(`  … and ${ps.length - 25} more`);
      return {};
    },
  },

  // `logout now <back>` ends the run: from there the console is off the game.
  // NEAT's forms wait for the console to come back and carry on (logout.js).
  logout: {
    usage: 'logout now <back> | logout <when> <back>   (@:hh:mm[:ss] clock times, or waits: 90, 1:30, 1:05:00)',
    parse: (args, { tok }) => ({ cmd: 'logout', ...require('./logout').parseArgs(tok.slice(1)) }),
    async run(a, env) {
      const LO = require('./logout');
      const game = env.game;
      const hooks = { session: env.session, log: env.log, stopped: env.stopped, atLogout: env.opts.atLogout };
      const when = await LO.run(game, a, { ...hooks, dryRun: env.dryRun, otherScripts: env.opts.otherScripts });
      if (!when) return {};
      if (!a.resume) return { done: 1, end: true };
      const back = await LO.waitBack(game, when, hooks);
      if (!back) return { done: 1, ok: false, error: 'the console did not come back to the game', end: true };
      env.follow();
      return { done: 1 };
    },
  },

  cleanreports: {
    usage: 'cleanreports [text[,text...]] | cleanreports trade|army|other',
    parse(args) {
      const toks = splitArgs(args);
      if (toks.some((t) => t.sw)) throw new Error('cleanreports: no switches — cleanreports [text[,text...]]');
      const text = toks.map((t) => t.text).join(' ').trim();
      // OTTObot's kinds, a word on its own; "army" in quotes is a text to look for
      if (toks.length === 1 && !toks[0].quoted && REPORT_KINDS.includes(text.toLowerCase())) return { cmd: 'cleanreports', type: text.toLowerCase() };
      return { cmd: 'cleanreports', type: null, search: listOf(text) };
    },
    async run(a, env) {
      const terms = (a.search || []).map((s) => s.toLowerCase());
      env.log('  delete ' + (a.type ? `every ${a.type} report`
        : terms.length ? `every report whose subject or "to" has ${terms.map((t) => `"${t}"`).join(' or ')}` : 'every report there is'));
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      // The report list's Subject (主题) is a report's title and its To (目的地)
      // its targetPos (PublicReportCanvas.as:392-423, 618, 911).
      const has = (r) => {
        const hay = [r.title, r.targetPos].map((s) => String(s == null ? '' : s).toLowerCase());
        return terms.some((t) => hay.some((h) => h.includes(t)));
      };
      const n = await cleanWhere(env, a.type ? [a.type] : REPORT_KINDS, terms.length ? has : () => true);
      env.log(`  removed ${n.removed} report(s)${terms.length ? ` of ${n.seen} looked at` : ''}`);
      return { done: 1, result: n.removed };
    },
  },

  cleannpcreports: {
    usage: 'cleannpcreports',
    parse(args) {
      if (String(args || '').trim()) throw new Error('cleannpcreports: nothing goes after it');
      return { cmd: 'cleannpcreports' };
    },
    async run(a, env) {
      env.log('  delete the attack and return reports for Barbarian cities, and every transport report, from every city');
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      // ReportBean.armyType is the march's mission and `back` its return
      // (ReportStyleLabel.as:84-126): 1 transport, 5 attack.
      const npc = (r) => {
        const t = Number(r.armyType);
        if (t === C.MISSION.transport) return true;
        return t === C.MISSION.attack && [r.title, r.targetPos, r.startPos].some((s) => /barbarian/i.test(String(s == null ? '' : s)));
      };
      const n = await cleanWhere(env, ['army'], npc);
      env.log(`  removed ${n.removed} of ${n.seen} army report(s)`);
      return { done: 1, result: n.removed };
    },
  },
};

module.exports = { commands, findItem, splitArgs, TITLES, RANKS, ALLOW };
