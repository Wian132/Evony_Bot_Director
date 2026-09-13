'use strict';
// Pure helpers behind the console's Mail and Reports windows: list rows, mail
// text, and battle / scout / trade reports turned into something readable.
// Nothing here touches the network — test-mail.js runs all of it offline.
//
// Everything is read off the decompiled client (src/scripts):
//   com/evony/client/action/MailCommands.as     mail.* command names and params
//   com/evony/client/action/ReportCommands.as   report.* command names and params
//   com/evony/common/constants/MailConstants.as box ids, read flags, limits
//   com/evony/common/beans/MailBean.as, ReportBean.as   list rows
//   com/evony/common/module/mail/MailResponse.as        one mail WITH its content
//   com/evony/common/module/report/ReportResponse.as    { report: ReportBean }
//   view/module/mail/MailWin.as                 how the client lists, reads, replies
//   view/module/info/PublicReportDetail.as      a report's `content` is XML, decoded
//       with mx.rpc.xml.SimpleXMLDecoder and dispatched on its <reportData> child
//   view/module/info/reports/*.as, reports/ReportUi/*.as   the fields each report reads
const C = require('./constants');

// MailConstants.MAIL_RECEIVE / MAIL_SYSTEM / MAIL_SEND — the `type` of
// mail.receiveMailList. (MAIL_SYSTEM_BROADCAST = 4 has no tab in MailWin.)
const MAIL_BOX = { inbox: 1, system: 2, sent: 3 };

// MailConstants.TITLE_LIMIT / CONTENT_LIMIT. MailWin's own inputs are tighter
// for typing — the subject box takes 24 characters (a CJK one counts two) and
// the body 500 — but a reply pre-fills "Reply:<subject>", which runs past 24,
// so the server's limits are the hard ones. And MailWin.sendMail refuses a
// second mail within 5 seconds ("There is a 5 second cooldown on sending
// messages.").
const MAIL_LIMITS = { title: 200, titleTyped: 24, content: 500, cooldownMs: 5000 };

// MailWin.itemCount and PublicReportCanvas.pageSize are both 10.
const PAGE_SIZE = 10;

// Flash htmlText knows the first six; players paste the rest from web pages.
const ENT = {
  lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', bull: '•', middot: '·', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', times: '×', euro: '€',
};
function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    const k = e.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENT, k) ? ENT[k] : m;
  });
}

// ---------------------------------------------------------------- XML
// A small, forgiving XML reader: elements, attributes, text, CDATA; comments,
// <?xml?> and <!DOCTYPE> skipped. Whitespace-only text is dropped, as
// XMLUtil.createXMLDocument does (ignoreWhite).
function parseXmlTree(src) {
  const s = String(src == null ? '' : src);
  const doc = { name: '#document', attrs: {}, children: [] };
  const stack = [doc];
  const top = () => stack[stack.length - 1];
  const text = (t) => { if (/\S/.test(t)) top().children.push({ text: decodeEntities(t) }); };
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { text(s.slice(i)); break; }
    if (lt > i) text(s.slice(i, lt));
    const skipTo = (end, from) => { const e = s.indexOf(end, from); return e < 0 ? s.length : e + end.length; };
    if (s.startsWith('<!--', lt)) { i = skipTo('-->', lt + 4); continue; }
    if (s.startsWith('<![CDATA[', lt)) {
      const e = s.indexOf(']]>', lt + 9);
      top().children.push({ text: s.slice(lt + 9, e < 0 ? s.length : e) });
      i = e < 0 ? s.length : e + 3;
      continue;
    }
    if (s[lt + 1] === '?') { i = skipTo('?>', lt + 2); continue; }
    if (s[lt + 1] === '!') { i = skipTo('>', lt + 2); continue; }
    if (s[lt + 1] === '/') {
      const e = s.indexOf('>', lt + 2);
      const name = s.slice(lt + 2, e < 0 ? s.length : e).trim();
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
      i = e < 0 ? s.length : e + 1;
      continue;
    }
    // an opening tag — find its '>' outside any quoted attribute value
    let j = lt + 1, q = null;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (q) { if (ch === q) q = null; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '>') break;
    }
    let inner = s.slice(lt + 1, j);
    i = j + 1;
    const selfClose = /\/\s*$/.test(inner);
    if (selfClose) inner = inner.replace(/\/\s*$/, '');
    const m = inner.match(/^\s*([^\s/>]+)/);
    if (!m) continue;
    const el = { name: m[1], attrs: {}, children: [] };
    const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g;
    const rest = inner.slice(m[0].length);
    let a;
    while ((a = re.exec(rest))) el.attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    top().children.push(el);
    if (!selfClose) stack.push(el);
  }
  return doc;
}

// SimpleXMLDecoder.simpleType: "true"/"false" become booleans, numbers become
// numbers — except anything starting with "0" (or "-0") or ending in "E",
// which stays a string. So "0" is the STRING "0"; num() below copes.
function simpleType(v) {
  if (v === null || v === undefined) return v;
  const s = String(v);
  if (s === '') return s;
  if (Number.isNaN(Number(s)) || s[0] === '0' || (s[0] === '-' && s[1] === '0') || s[s.length - 1] === 'E') {
    const lc = s.toLowerCase();
    if (lc === 'true') return true;
    if (lc === 'false') return false;
    return s;
  }
  return Number(s);
}

const SAFE_KEY = (k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
const localName = (n) => String(n).replace(/^[^:]*:/, '');

// SimpleXMLDecoder.decodeXML: a node with a single text child is that text;
// otherwise child elements become properties (a repeated name becomes an
// array), and attributes are copied on top. An empty element is null.
function decodeNode(node) {
  const kids = node.children || [];
  let result;
  let simple = false;
  if (kids.length === 1 && kids[0].text !== undefined) {
    simple = true;
    result = simpleType(kids[0].text);
  } else if (kids.length > 0) {
    result = {};
    for (const k of kids) {
      if (k.text !== undefined) continue;          // mixed content: text is skipped
      const name = localName(k.name);
      if (!SAFE_KEY(name)) continue;
      const v = decodeNode(k);
      const have = result[name];
      if (have !== null && have !== undefined) result[name] = Array.isArray(have) ? [...have, v] : [have, v];
      else result[name] = v;
    }
  }
  for (const [k, v] of Object.entries(node.attrs || {})) {
    if (k === 'xmlns' || k.startsWith('xmlns:') || !SAFE_KEY(k)) continue;
    if (result === null || result === undefined) result = {};
    // ComplexString: text that also carries attributes
    if (simple) { result = { _text: result }; simple = false; }
    result[k] = simpleType(v);
  }
  return result === undefined ? null : result;
}

function parseXml(src) { return decodeNode(parseXmlTree(src)); }

// ---------------------------------------------------------------- names
const TROOP_BY_ID = Object.fromEntries(C.TROOPS.map((t) => [t.typeId, t.name]));
// The names the game's report screens print: the <fortificationEum> table the
// web battle log (WarReport.swf) embeds. constants.js keeps the bot's names
// ("Arrow Tower", "Rock Fall") for everything else.
const FORT_BY_ID = { 14: 'Trap', 15: 'Abatis', 16: "Archer's Tower", 17: 'Rolling Log', 18: 'Defensive Trebuchet' };
// LostTroopUI.getTypeName: 14 and up are fortifications, below that troops.
const unitName = (typeId) => TROOP_BY_ID[Number(typeId)] || FORT_BY_ID[Number(typeId)] || `unit ${typeId}`;
const buildingName = (typeId) => (C.BUILDING_BY_ID[Number(typeId)] || {}).name || `building ${typeId}`;
const techName = (typeId) => (C.TECH_BY_ID[Number(typeId)] || {}).name || `tech ${typeId}`;
// LevyTypeTransform.levyTypeTransf — the mission words, keyed like constants.MISSION,
// plus ObjConstants' colony-era missions, which the report screens never name.
const MISSION_NAME = {
  ...Object.fromEntries(Object.entries(C.MISSION).map(([k, v]) => [v, k])),
  7: 'colonize', 8: 'uprising', 9: 'suppression', 10: 'anti-colonial', 11: 'deployment',
};

// The item catalogue (itemdefs.json / common.getItemDefXml) as id -> name.
function itemNamesFromXml(xml) {
  const out = new Map();
  for (const tag of String(xml || '').match(/<itemEum\b[^>]*>/g) || []) {
    const id = tag.match(/\bid="([^"]*)"/);
    const name = tag.match(/\bname="([^"]*)"/);
    if (id && name) out.set(decodeEntities(id[1]), decodeEntities(name[1]));
  }
  return out;
}

// ---------------------------------------------------------------- small readers
const list = (v) => (v === null || v === undefined || v === '' ? [] : Array.isArray(v) ? v : [v]);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => {
  if (v === null || v === undefined) return null;
  if (isObj(v)) return v._text === undefined ? null : String(v._text);
  return String(v);
};
const num = (v) => { const n = Number(isObj(v) ? v._text : v); return Number.isFinite(n) ? n : 0; };
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(isObj(v) ? v._text : v);
  return Number.isFinite(n) ? n : null;
};
// numbers where they are numbers, the text where it is not ("1000-2000")
const numOrText = (v) => { const n = numOrNull(v); return n === null ? (str(v) || '') : n; };
const bool = (v) => {
  if (v === true || v === false) return v;
  if (v === null || v === undefined || v === '') return null;
  const s = String(isObj(v) ? v._text : v).toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return null;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const RES_KEYS = ['gold', 'food', 'wood', 'stone', 'iron'];
function resources(o) {
  if (!isObj(o)) return null;
  const out = {};
  for (const k of RES_KEYS) if (o[k] !== undefined && o[k] !== null) out[k] = num(o[k]);
  return Object.keys(out).length ? out : null;
}

// A link is only ever passed on as http(s).
function safeUrl(u) {
  let s = String(u || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;       // PublicReportDetail.onReportUrl prepends it
  try {
    const url = new URL(s);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- list rows
const isReadFlag = (v) => v === true || Number(v) === 1;    // MailConstants.IS_READ = 1

// MailBean. In the Sent box MailWin shows the receiver in the sender column.
function mailRow(m, box) {
  return {
    id: Number(m.mailid),
    from: m.sender == null ? '' : String(m.sender),
    to: m.receiver == null ? '' : String(m.receiver),
    title: m.title == null ? '' : String(m.title),
    time: Number(m.receiveTime) || null,
    read: box === 'sent' ? true : isReadFlag(m.isRead),
    box,
  };
}

// ReportBean.
function reportRow(r, type) {
  return {
    id: Number(r.id),
    title: r.title == null ? '' : String(r.title),
    time: Number(r.eventTime) || null,
    from: r.startPos == null ? '' : String(r.startPos),
    to: r.targetPos == null ? '' : String(r.targetPos),
    read: isReadFlag(r.isRead),
    attack: r.attack === true || r.attack === 1,
    back: r.back === true || r.back === 1,
    type,
  };
}

// ---------------------------------------------------------------- mail text
// MailWin shows the body as Flash htmlText. System mail may park a link after
// "HREF" (MailWin.onReadMail: indexOf("HREFhttp")), and a mail whose title has
// "(Link)" is nothing but a URL.
function mailText(content) {
  let s = String(content == null ? '' : content);
  const cut = s.indexOf('HREFhttp');
  if (cut >= 0) s = s.slice(0, cut);
  s = s.replace(/\r\n?/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?p\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function mailLinks(content, title) {
  const s = String(content == null ? '' : content);
  const found = [];
  const cut = s.indexOf('HREFhttp');
  if (cut >= 0) found.push(s.slice(cut + 4).trim().split(/\s/)[0]);
  for (const m of s.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) found.push(decodeEntities(m[1]));
  if (/\(Link\)/.test(String(title || ''))) found.push(s.trim());
  const out = [];
  for (const u of found) {
    if (!/^https?:\/\//i.test(u)) continue;                // never "event:here" or javascript:
    const ok = safeUrl(u);
    if (ok && !out.includes(ok)) out.push(ok);
  }
  return out;
}

// MailResponse — the mail as mail.readMail returns it.
function mailDetail(d, box) {
  return {
    ...mailRow(d, box || null),
    read: true,
    text: mailText(d.content),
    links: mailLinks(d.content, d.title),
  };
}

// What MailWin.sendMail checks before it sends, plus the server's limits.
function checkMail({ to, title, body } = {}) {
  const t = String(to == null ? '' : to).trim();
  const ti = String(title == null ? '' : title).trim();
  const b = String(body == null ? '' : body).replace(/\r\n?/g, '\n').trim();
  if (!t) return { error: 'the recipient cannot be empty' };
  if (/[\n,;]/.test(t)) return { error: 'one recipient only — the game has no multi-send' };
  if (t.length > 40) return { error: 'that is not a player name' };
  if (!ti) return { error: 'the subject cannot be empty' };
  if (ti.length > MAIL_LIMITS.title) return { error: `the subject is limited to ${MAIL_LIMITS.title} characters` };
  if (!b) return { error: 'the mail cannot be empty' };
  if (b.length > MAIL_LIMITS.content) return { error: `the mail is limited to ${MAIL_LIMITS.content} characters (it has ${b.length})` };
  return { to: t, title: ti, body: b };
}

// ---------------------------------------------------------------- reports
// A report's `content` is XML, and its reportUrl names the same XML on the
// game's web server, where the "battle log on the web" (default.html, which
// runs WarReport.swf in Flash) shows it. The in-game window and WarReport.swf
// share one set of report screens — view/module/info/reports/*.as in both —
// and describeReport() rebuilds what they show, in their order, in their
// English (the Lang keys), untangled where the original is garbled.
//
// Each report becomes { kind, headline, verdict, url, log, lines, sections, foot },
// and a section is one of:
//   { type:'sides', sides:[side, side] }                   a battle's two armies
//   { type:'kv', title, rows:[[label, value], ...] }
//   { type:'res', title, res:{gold,food,...}, sign }       '+' / '-' / ''
//   { type:'units', title, cols:[...], rows:[[name, ...], ...] }
//   { type:'text', title, text }
//   { type:'raw', title, text }                            a report we do not know
// `foot` is the small print a screen ends with.

const an = (w) => (/^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`);
const heroLabel = (name, level) => `${name}${level !== null && level !== undefined ? ` (Lv ${level})` : ''}`;

// BattleTroopUi.attackObj: one army — lord, hero, and troopUnit (one
// {typeId, count, lose} or a list), which LostTroopUI shows as count and loss.
function side(o, role, whose, won) {
  if (!isObj(o)) return null;
  const troops = list(o.troopUnit).filter(isObj).map((u) => {
    const count = num(u.count), lost = num(u.lose);
    return { typeId: num(u.typeId), name: unitName(u.typeId), count, lost, left: Math.max(0, count - lost) };
  });
  const total = troops.reduce((t, u) => ({ count: t.count + u.count, lost: t.lost + u.lost, left: t.left + u.left }), { count: 0, lost: 0, left: 0 });
  return {
    role, whose, won,
    king: str(o.king), hero: str(o.heroName), heroLevel: numOrNull(o.heroLevel),
    heroExp: numOrNull(o.heroExp), castlePos: str(o.castlePos),
    troops, total,
  };
}

// "player.item.a=2,player.box.b" (GetTreasure.myItem)
function items(v, itemName) {
  const s = str(v);
  if (!s) return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const [id, n] = x.split('=');
    return { id, name: (itemName && itemName(id)) || id, count: n === undefined ? 1 : num(n) || 1 };
  });
}

// BattleBackTroop.backTroops -> TroopInfoUi.troopsObj: each army after the
// fight — its hero, whether the hero was taken, what it carries, and every
// troop type before, after, and wounded.
function backSections(bt) {
  if (!isObj(bt)) return [];
  const out = [];
  for (const t of list(bt.troops).filter(isObj)) {
    const who = str(t.heroName);
    const title = `${bool(bt.isBack) === false ? 'Troops' : 'Troops returning'}${who ? ` — ${heroLabel(who, numOrNull(t.heroLevel))}` : ''}`
      + (bool(t.isHeroBeSeized) === true ? ' — the hero was captured' : '');
    const rows = list(t.troopInfo).filter(isObj).map((u) => [unitName(u.typeId), num(u.preCount), num(u.remain), num(u.injured)]);
    if (rows.length) out.push({ type: 'units', title, cols: ['Troop', 'Total', 'Remaining', 'Wounded'], rows });
    else out.push({ type: 'text', title, text: 'no troops listed' });
    const res = resources(t.resource);
    if (res) out.push({ type: 'res', title: 'Resources carried back', res, sign: '+' });
  }
  return out;
}

// BattleReportDetail.setXmlObj and its bindings. The scouts' fight
// (ScoutBattleReportDetail) is the same screen without the headline, and names
// the loot by isAttack alone.
function battle(b, start, target, itemName, { scouts = false } = {}) {
  const isAttack = bool(b.isAttack);
  const attackerWon = bool(b.isAttackSuccess);
  const youWon = isAttack === null || attackerWon === null ? null : isAttack === attackerWon;
  const mine = (attacker) => (isAttack === null ? null : (attacker === isAttack ? 'you' : 'enemy'));
  const atk = list(b.attackTroop).filter(isObj).map((o) => side(o, 'Attacker', mine(true), attackerWon));
  const def = list(b.defendTroop).filter(isObj).map((o) => side(o, 'Defender', mine(false), attackerWon === null ? null : !attackerWon));
  const sections = [];
  if (atk.length || def.length) sections.push({ type: 'sides', sides: [...atk, ...def] });

  const lines = [];
  const abnormal = str(b.unNomal);
  if (abnormal) lines.push(abnormal);
  const rounds = numOrNull(b.round);
  if (rounds !== null) lines.push(`The battle lasted ${plural(rounds, 'round', 'rounds')}, ${attackerWon ? 'the attacker won' : 'the defender won'}.`);

  const won = items(b.attackWinnerItems, itemName);
  if (won.length) sections.push({ type: 'units', title: 'Treasure acquired', cols: ['Item', 'Count'], rows: won.map((x) => [x.name, x.count]) });

  const stats = [];
  if (b.prestige != null) stats.push(['Prestige gained', numOrText(b.prestige)]);
  if (b.injuredPer != null) stats.push(['Wounded proportion', `${str(b.injuredPer)}%`]);
  if (b.honor != null) stats.push(['Honor', numOrText(b.honor)]);
  if (b.heroExp != null) stats.push(['Hero experience gained', numOrText(b.heroExp)]);
  if (b.support != null) stats.push(['Loyalty change', numOrText(b.support)]);
  if (b.complaint != null) stats.push(['Public grievance change', numOrText(b.complaint)]);
  if (str(b.seizeProblem)) stats.push(['Conquest note', str(b.seizeProblem)]);
  if (bool(b.isSeize) !== null) stats.push(['Conquest', bool(b.isSeize) ? 'the city was taken' : 'the city was not taken']);
  if (stats.length) sections.push({ type: 'kv', title: 'Outcome', rows: stats });

  const loot = resources(b.lootResource);
  // 掠夺的资源 (plundered) or 被掠夺的资源 (plundered from us)
  const ours = scouts ? isAttack === true : isAttack === attackerWon;
  if (loot) sections.push({ type: 'res', title: ours ? 'Resources plundered' : 'Resources lost', res: loot, sign: ours ? '+' : '-' });

  sections.push(...backSections(b.backTroop));
  // isShowReturn: an attack that won and did not take the place heads home
  if (!scouts && isAttack === true && attackerWon === true && isObj(b.backTroop) && bool(b.isSeize) === false) {
    lines.push(`The army is returning to ${start || 'its city'}.`);
  }

  return {
    // Label1 shows only when isAttack is known
    headline: isAttack === true ? `Your army${start ? ` from ${start}` : ''} reached ${target || 'its target'} and attacked.`
      : isAttack === false ? `An army attacked ${target || 'your city'}.` : '',
    verdict: youWon === null ? (attackerWon === null ? null : { text: attackerWon ? 'The attacker won' : 'The defender won', good: null })
      : { text: youWon ? 'Victory' : 'Defeat', good: youWon },
    lines, sections,
  };
}

function unitsSection(title, v, cols = ['Troop', 'Amount']) {
  const rows = list(v).filter(isObj).map((u) => [unitName(u.typeId), numOrText(u.count)]);
  return rows.length ? { type: 'units', title, cols, rows } : null;
}

// ScoutResults.myScoutObj: how the scouting went, from either end, picked by
// the report's isAttack / isFound / isSuccess — [isAttack, isFound, isSuccess,
// what the game says, verdict, good]. The defender's cases ignore isFound.
const SCOUT_RESULT = [
  [true, false, false, "Your scouts were spotted by the defenders' regular army and wiped out. No scouting report came back.", 'Scouts lost', false],
  [true, false, true, "Your scouts were spotted by the defenders' regular army, but it was too small to stop them: they won the fight and scouted the city.", 'Scouted', true],
  [true, true, false, "Your scouts got into the city, but other scouts there wiped them out. None came back.", 'Scouts lost', false],
  [true, true, true, "Your scouts got into the city and fought the scouts there; the survivors brought back a report.", 'Scouted', true],
  [false, null, false, 'You outnumbered the enemy scouts and wiped them out.', 'Enemy scouts wiped out', true],
  [false, null, true, 'Your defence against scouting failed: the enemy beat your scouts and scouted your city.', 'Your city was scouted', false],
];

// ScoutReportDetail: the outcome (ScoutResults), what the scouts saw
// (ScoutInfoUi and its Sc* parts, in their order), and any fight
// (ScoutBattleReportDetail).
function scout(o, start, target, itemName) {
  const isAttack = bool(o.isAttack);
  const found = bool(o.isFound), success = bool(o.isSuccess);
  const hit = SCOUT_RESULT.find(([a, f, s]) => a === isAttack && (f === null || f === found) && s === success);
  const info = isObj(o.scoutInfo) ? o.scoutInfo : null;
  const lines = hit ? [hit[3]] : [];
  const sections = [];
  if (info) {
    const city = [];
    if (str(info.heroName)) city.push(['Hero', heroLabel(str(info.heroName), numOrNull(info.heroLevel))]);
    if (info.population != null) city.push(['Population', numOrText(info.population)]);
    if (info.support != null) city.push(['Loyalty', numOrText(info.support)]);
    if (city.length) sections.push({ type: 'kv', title: 'City survey', rows: city });
    // ScResource: the four from <resource>, gold off scoutInfo itself
    const res = resources(info.resource) || {};
    delete res.gold;
    if (info.gold != null) res.gold = num(info.gold);
    if (Object.keys(res).length) sections.push({ type: 'res', title: 'Resources', res, sign: '' });
    if (isObj(info.buildings)) {
      const rows = list(info.buildings.buildingType).filter(isObj).map((x) => [buildingName(x.type), str(x.levels) || '']);
      if (rows.length) sections.push({ type: 'units', title: 'Buildings', cols: ['Building', 'Levels'], rows });
    }
    const fo = isObj(info.fortifications) ? unitsSection('Fortifications', info.fortifications.fortificationsType, ['Fortification', 'Amount']) : null;
    if (fo) sections.push(fo);
    const tr = isObj(info.troops) ? unitsSection('Troops', info.troops.troopStrType) : null;
    if (tr) sections.push(tr);
    if (isObj(info.techs)) {
      const rows = list(info.techs.techType).filter(isObj).map((x) => [techName(x.type), numOrText(x.level)]);
      if (rows.length) sections.push({ type: 'units', title: 'Technology', cols: ['Technology', 'Level'], rows });
    }
  }
  const bi = isObj(o.battleInfo) ? o.battleInfo : null;
  if (bi) {
    const bt = battle(bi, start, target, itemName, { scouts: true });
    // the fight shows only when there was someone to fight
    if (bi.defendTroop != null) sections.push({ type: 'text', title: 'The scouts fought', text: bt.lines.join(' ') || 'There was a fight.' }, ...bt.sections);
    else sections.push(...bt.sections.filter((s) => s.type !== 'sides'));
  }
  return {
    headline: isAttack === false ? `Enemy scouts reached ${target || 'your city'}.`
      : `${isAttack === true ? 'Your scouts' : 'The scouting party'} reached ${target || 'the target'}.`,
    verdict: hit ? { text: hit[4], good: hit[5] } : null,
    lines, sections,
    // the screen's last line; it is about the scout's own Informatics, so not for the scouted side
    foot: isAttack === false ? [] : [info ? 'Research Informatics for a more detailed scouting report.'
      : 'Your Informatics level is too low to learn anything.'],
  };
}

// TroopMovementDetail: a march that arrived, or is home again — its hero,
// troops, and what it carried.
function movement(o, start, target) {
  const mission = MISSION_NAME[num(o.type)] || 'march';
  const back = bool(o.isBack) === true;
  const sections = [];
  const who = str(o.heroName);
  if (who) sections.push({ type: 'kv', title: 'Hero', rows: [['Hero', heroLabel(who, numOrNull(o.heroLevel))]] });
  const tr = unitsSection('Troops', o.troops);
  if (tr) sections.push(tr);
  const res = resources(o.resource);
  if (res) sections.push({ type: 'res', title: back ? 'Resources carried back' : mission === 'transport' ? 'Resources delivered' : 'Resources', res, sign: '' });
  return {
    headline: back
      ? `The troops sent to ${target || 'their target'} on ${an(mission)} mission are back at ${start || 'home'}.`
      : `The troops on ${an(mission)} mission reached ${target || 'their target'}.`,
    verdict: null,
    lines: str(o.problem) ? [str(o.problem)] : [],
    sections,
  };
}

// The web battle log. A report's reportUrl is the game's Flash page,
//   battless71.evony.com/default.html?logfile/20260913/26/b8/<md5>.xml
// and WarReport.swf (PublicReportDetail.init) loads everything after the "?"
// as a path beside it: http://battless71.evony.com/logfile/20260913/.../<md5>.xml.
// Takes that page link (with or without http://, "logfile=" too) or the XML's
// own address, and returns where the XML is. Only *.evony.com hosts and a
// logfile/....xml path pass, so a link can never point the console elsewhere.
function battleLogUrl(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s || s.length > 400) return null;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!/^([a-z0-9-]+\.)+evony\.com$/.test(host)) return null;
  let rel = null;
  if (/^\/logfile\//i.test(u.pathname)) rel = u.pathname.slice(1);
  else if (/^\/(default\.html?)?$/i.test(u.pathname)) {
    let q = u.search.slice(1);
    try { q = decodeURIComponent(q); } catch { return null; }
    const m = q.match(/^logfile[=/](.+)$/i);
    if (m) rel = 'logfile/' + m[1];
  }
  if (!rel || rel.length > 200 || !/^logfile(\/[A-Za-z0-9_-]+)+\.xml$/.test(rel)) return null;
  const day = rel.match(/^logfile\/(\d{4})(\d{2})(\d{2})\//);
  return {
    xml: `http://${host}/${rel}`,
    page: `http://${host}/default.html?${rel}`,
    day: day ? `${day[1]}-${day[2]}-${day[3]}` : null,
  };
}

function describeReport(content, bean = {}, { itemName = null } = {}) {
  const start = bean.startPos == null ? '' : String(bean.startPos);
  const target = bean.targetPos == null ? '' : String(bean.targetPos);
  const out = { kind: 'unknown', headline: '', verdict: null, url: null, log: null, lines: [], sections: [], foot: [] };
  const src = String(content == null ? '' : content);
  let data = null;
  try { const root = parseXml(src); data = isObj(root) && isObj(root.reportData) ? root.reportData : null; } catch { data = null; }
  if (!data) {
    // not a report we can decode: show what there is as text
    out.kind = 'text';
    const t = mailText(src);
    if (t) out.sections.push({ type: 'text', title: '', text: t });
    return out;
  }
  // PublicReportDetail.refresh reads the url straight off the text
  const m = src.match(/reportUrl="([^"]*)"/);
  if (m) {
    out.url = safeUrl(decodeEntities(m[1]));
    out.log = battleLogUrl(decodeEntities(m[1]));
  }

  // PublicReportDetail.refresh dispatches on which child <reportData> holds, in
  // this order (WarReport.swf's, which knows the most). An empty element
  // decodes to null, so ask whether it is there.
  const has = (k) => Object.prototype.hasOwnProperty.call(data, k);
  const part = (k) => (isObj(data[k]) ? data[k] : {});
  const kvOf = (o, keys) => keys.filter(([k]) => o[k] != null && o[k] !== '').map(([k, label]) => [label, numOrText(o[k])]);
  let r = null;
  if (has('tradeReport')) {
    const o = part('tradeReport');
    out.kind = 'trade';
    r = {
      // TradeReportDetail: "交易完成: {tradeType} {dealedAmount} {resName}, 总成交价: 黄金 {gold}."
      headline: (`Trade completed: ${str(o.tradeType) || ''} ${num(o.dealedAmount).toLocaleString('en-US')} ${str(o.resName) || ''}, `
        + `total price ${num(o.gold).toLocaleString('en-US')} gold.`).replace(/\s+/g, ' ').replace(' ,', ','),
      verdict: null,
      lines: ['Traded resources take 30 minutes to arrive — see the Market.'],
      sections: [],
    };
  } else if (has('uprisingReport')) {
    const o = part('uprisingReport');
    out.kind = 'uprising';
    const rows = [['Population', `-${num(o.population).toLocaleString('en-US')}`]];
    for (const [k, label] of [['gold', 'Gold'], ['food', 'Food'], ['wood', 'Lumber'], ['stone', 'Stone'], ['iron', 'Iron']]) {
      rows.push([label, `-${num(o[k]).toLocaleString('en-US')}`]);
    }
    rows.push(['Public grievance', `+${num(o.complaint).toLocaleString('en-US')}`]);
    r = { headline: `${target || 'A city'}: poor governance — the people rose up.`, verdict: { text: 'Uprising', good: false }, lines: [], sections: [{ type: 'kv', title: 'Losses', rows }] };
  } else if (has('heroEscapeReport')) {
    const o = part('heroEscapeReport');
    out.kind = 'heroEscape';
    const names = list(o.heroName).map(str).filter(Boolean);
    r = {
      headline: `${target || 'A city'}: the treasury could not pay the heroes' salaries.`,
      verdict: { text: 'Heroes deserted', good: false },
      lines: ['Loyalty fell.'],
      sections: names.length ? [{ type: 'units', title: 'Heroes deserted', cols: ['Hero'], rows: names.map((n) => [n]) }] : [],
    };
  } else if (has('troopDieReport')) {
    out.kind = 'troopDie';
    const tr = unitsSection('Troops lost', part('troopDieReport').troopUnit);
    r = { headline: `${target || 'A city'}: the granary could not feed the troops.`, verdict: { text: 'Troops starved', good: false }, lines: [], sections: tr ? [tr] : [] };
  } else if (has('battleReport')) {
    out.kind = 'battle';
    r = battle(part('battleReport'), start, target, itemName);
  } else if (has('troopMovement')) {
    out.kind = 'movement';
    r = movement(part('troopMovement'), start, target);
  } else if (has('scoutReport')) {
    out.kind = 'scout';
    r = scout(part('scoutReport'), start, target, itemName);
  } else if (has('robReport')) {
    out.kind = 'rob';
    const o = part('robReport');
    const sections = [];
    const res = resources(o.loseResource);
    if (res) sections.push({ type: 'res', title: 'Resources robbed', res, sign: '-' });
    const tr = unitsSection('Troops lost', o.loseTroops);
    if (tr) sections.push(tr);
    r = { headline: `Our troops heading for ${target || 'their target'} were robbed on the way.`, verdict: { text: 'Robbed', good: false }, lines: [], sections };
  // From here on, report kinds only WarReport.swf knows (the in-game client
  // predates them) and whose English never made it into its language file:
  // the wording is ours, and every field is shown so nothing is lost.
  } else if (has('declaredWarReport')) {
    // DeclareWarReportDetail
    const o = part('declaredWarReport');
    out.kind = 'war';
    const mine = bool(o.myself) === true;
    r = {
      headline: mine ? `You have declared war on ${target || 'them'}.` : `${start || 'Another lord'} has declared war on you.`,
      verdict: { text: 'War declared', good: null },
      lines: ['The war begins 8 hours after the declaration and lasts 48 hours; both sides can attack each other. Items can raise your troops\' strength.'],
      sections: [{ type: 'kv', title: 'War', rows: [['Begins', str(o.startTime) || '—'], ['Ends', str(o.endTime) || '—']] }],
    };
  } else if (has('policyReport') || has('heroFleeReport')) {
    // PolicyReportDetail shows `detail` (it reads policyReport even for heroFleeReport)
    const key = has('policyReport') ? 'policyReport' : 'heroFleeReport';
    out.kind = key === 'policyReport' ? 'policy' : 'heroFlee';
    const text = mailText(str(part(key).detail) || str(data[key]) || '');
    r = { headline: key === 'policyReport' ? 'Policy report' : 'A hero fled', verdict: null, lines: [], sections: text ? [{ type: 'text', title: '', text }] : [] };
  } else if (has('TroopMoveList')) {
    // TroopMoveList: the marches an item revealed around the city
    out.kind = 'troopMoves';
    const rows = list(part('TroopMoveList').TroopMove).filter(isObj)
      .map((x, i) => [String(i + 1), str(x.type) || '', str(x.Start) || '', str(x.Dest) || '', str(x.ArriveTime) || '']);
    r = {
      headline: `Troop movements around ${target || 'the city'}.`, verdict: null, lines: [],
      sections: rows.length ? [{ type: 'units', title: 'Marches', cols: ['#', 'Type', 'From', 'To', 'Arrival'], rows }] : [],
    };
  } else if (has('uprisingWarReport')) {
    // UprisingWarReport: a colony rising against its suzerain
    const o = part('uprisingWarReport');
    out.kind = 'uprisingWar';
    r = {
      headline: `An uprising war${start ? ` from ${start}` : ''}${target ? ` against ${target}` : ''}.`,
      verdict: null, lines: [],
      sections: [{ type: 'kv', title: 'Uprising', rows: [['Begins', str(o.startTime) || '—'], ['Ends', str(o.endTime) || '—'],
        ['Your side', bool(o.isColony) ? 'the colony' : 'the suzerain']] }],
    };
  } else if (has('ImpositionReport')) {
    // ImpositionReport: a suzerain's levy on its colony (lumber is wood)
    const o = part('ImpositionReport');
    out.kind = 'levy';
    const colony = bool(o.isColony) === true;
    const res = {};
    for (const [k, from] of [['food', 'food'], ['wood', 'lumber'], ['stone', 'stone'], ['iron', 'iron'], ['gold', 'gold']]) if (o[from] != null) res[k] = num(o[from]);
    const sections = [{ type: 'kv', title: 'Levy', rows: kvOf(o, [['suzerain', 'Suzerain'], ['colony', 'Colony']]) }];
    if (Object.keys(res).length) sections.push({ type: 'res', title: 'Resources levied', res, sign: colony ? '-' : '+' });
    r = {
      headline: colony ? `${str(o.suzerain) || 'Your suzerain'} levied resources from ${str(o.colony) || 'your city'}.`
        : `You levied resources from your colony ${str(o.colony) || ''}.`.replace(' .', '.'),
      verdict: null, lines: [], sections,
    };
  } else if (has('ColonyAbadonReport')) {
    // AbandonmentReport (sic, "Abadon")
    const o = part('ColonyAbadonReport');
    out.kind = 'abandon';
    r = {
      headline: `The colony ${str(o.colony) || ''} was abandoned.`.replace('  ', ' '),
      verdict: null, lines: [],
      sections: [{ type: 'kv', title: 'Colony', rows: kvOf(o, [['suzerain', 'Suzerain'], ['colony', 'Colony']]) }],
    };
  } else if (has('sowDiscordReport')) {
    // SowDiscordReportDetail: discord sown against a suzerain, maybe a hero taken
    const o = part('sowDiscordReport');
    out.kind = 'sowDiscord';
    const rows = kvOf(o, [['suzerainLord', 'Suzerain lord'], ['suzerainCastle', 'Suzerain city']]);
    const h = isObj(o.capturedHero) ? o.capturedHero : null;
    if (h && str(h.heroName)) rows.push(['Hero captured', heroLabel(str(h.heroName), numOrNull(h.heroLevel))]);
    r = { headline: 'Discord was sown.', verdict: null, lines: [], sections: [{ type: 'kv', title: 'Sow discord', rows }] };
  } else {
    const keys = Object.keys(data).filter((k) => k !== 'reportUrl');
    out.headline = keys.length ? `A ${keys[0]} report — this console does not know that kind yet.` : 'An empty report.';
    out.sections.push({ type: 'raw', title: 'Raw report', text: JSON.stringify(data, null, 1).slice(0, 6000) });
    return out;
  }
  return { ...out, ...r };
}

module.exports = {
  MAIL_BOX, MAIL_LIMITS, PAGE_SIZE,
  decodeEntities, parseXmlTree, parseXml, simpleType,
  unitName, itemNamesFromXml, safeUrl, battleLogUrl,
  mailRow, reportRow, mailText, mailLinks, mailDetail, checkMail,
  describeReport,
};
