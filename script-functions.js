'use strict';
// NEAT's global function library and constants: the names a script can call or
// read bare, apart from the game objects (script-objects.js) and the command
// modules' own globals. Everything returns plain data, never a live game bean;
// the map functions read the map cache and work offline.
//
// Math       abs acos asin atan atan2 ceil cos exp floor log pow sin sqrt tan random()
//            round(n[, places])   max(a, b, ...) min(a, b, ...)   isNaN isFinite
//            parseInt parseFloat Number String (String.fromCharCode) Math.<any of these>
//            PI E SQRT1_2 SQRT2 LN2 LN10 LOG10E LOG2E NaN Infinity
// Strings    CenterPad / LeftPad / RightPad(str, length[, pad=" "])   StringRepeat(count[, str=" "])
//            Merge(a, b[, delim=" "])   Upper1(str)   StringToObject(str, delim1, delim2[, into])
//            ToCSV(...values)   FormatNumber(n[, places=0[, commas=true]])   FormatNumber2(n)
//            FormatPercent(n[, places=1])   FormatMiles(n)
// Parsing    ParseInteger(text, min[, max[, suffix]])  -1 when the text is not such a number
//            PrepareParameters(text)  ["a", "b c", ...] (quotes keep spaces)
//            GetResources("f:1m,w:5k,s:0,i:2k,g:10k")  (getResources)  null for a bad string
// Time       date() | date(ms) | date(y, month0, d[, h, mi, s, ms])   TimeDiff(t[, from])  t - now, ms
// JSON, XML  json_encode(v[, indent])  json_decode(text)  xml(text) -> the root element as an object
//            GetTroopsFromXML(list[, countProp="count"])  GetFortsFromXML(list[, countProp])
//            GetResourcesFromXML(node)
// Map        GetFieldId("x,y" | x, y)   FieldIdToCoords(id) -> "x,y"  (fieldIdToCompareString)
//            GetX GetY GetLevel GetType GetZoneName (id)   GetFieldType(name)  GetFieldName(type)
//            MapDistance(x1, y1, x2, y2)   FormatDistance(id1, id2) -> "90.09 miles"
//            StateCoords(state | 0-15 | "all") -> "0,400 199,599"   StateName(n) (stateName)
//            FindField(x, y, radius, fieldType[, level]) -> field ids, level 0 = any
//            CastlesInRectangle(x1, y1, x2, y2[, omitNpc=true[, byId=false]])  (CastleInRectangle)
//            AllCastles(id1, id2[, omitNpc=true])   MapCastles(x, y, radius)   SearchEnemyCastles([n])
//            GetDetailInfo(id[, priority[, expireSeconds[, sinceMs]]]) -> MapCastleBean or null
//            UpdateDetailInfo(id)  (asks the server now)   RelationIndex(bean) 0-6
//            ResetMap(x, y, radius) | ResetMap(x, y, width, height)
//            getTravelTime(id1, id2, troops, type)  seconds; type 2 transport/reinforce, 5 attack/scout
// Timers     setCityTimer(key)   cityTimingAllowed(key, seconds[, test])  per city, in memory
// Constants  BuildVersion BuildDate BuildName   RESOURCETYPE_FOOD/WOOD/STONE/IRON  ResourceNames
//            BuildingTypes ResearchTypes FieldTypes PlayerState Abbreviations SpeedUpItems
//
// Map data comes from the session's live map blocks (every tile, fresh for 30
// minutes) laid over the SQLite map cache (castles, NPCs and flats). Valleys,
// types 1-6, are known only from live blocks, so scan first (rescanmap).
// Detail info (GetDetailInfo) is field.getOtherFieldInfo, cached per account.
// Tests pass a fake map with setMapCache(src) or ctx.mapSource; db.js is not
// required until a map function needs the cache.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const C = require('./constants');

// ---------------------------------------------------------------- values

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
const SAFE_KEY = (k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
const MAX_TEXT = 1000000;   // a string helper never builds more than this

// A script value as a number. Strings may carry NEAT's suffixes (20k, 1.5m, 2b,
// 5%), since %var% text often reaches a function that way.
function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null) return 0;
  if (v === undefined) return NaN;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'object' && typeof v.valueOf === 'function') {
    const p = v.valueOf();   // a bean that counts as a number (city.resource.food)
    if (typeof p === 'number') return p;
  }
  const s = String(v).trim();
  if (s === '') return 0;
  const m = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+))\s*([kmb%])$/i);
  if (m) {
    const k = m[2].toLowerCase();
    return Number(m[1]) * (k === '%' ? 0.01 : k === 'k' ? 1e3 : k === 'm' ? 1e6 : 1e9);
  }
  return Number(s);
}
const int = (v, dflt = 0) => { const n = Math.trunc(num(v)); return Number.isFinite(n) ? n : dflt; };

// A script value as text for the string helpers: null and undefined are "".
function toText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return as3DateString(v);
  if (Array.isArray(v)) return v.map(toText).join(',');
  return String(v);
}

function checkLength(n, what) {
  if (n > MAX_TEXT) throw new Error(`${what}: that would be more than ${MAX_TEXT.toLocaleString('en-US')} characters`);
}

// ---------------------------------------------------------------- math

// round(6.666, 2) = 6.67. Shifting by exponent rather than multiplying keeps
// 1.005 -> 1.01 instead of 1.00.
function roundTo(n, places = 0) {
  if (!Number.isFinite(n)) return n;
  const p = Math.trunc(places) || 0;
  if (!p) return Math.round(n);
  const s = String(n);
  if (/e/i.test(s)) return Math.round(n * 10 ** p) / 10 ** p;
  return Number(Math.round(Number(s + 'e' + p)) + 'e' + -p);
}

// max/min take any number of values; an array counts as its values.
const spread = (args) => args.flatMap((a) => (Array.isArray(a) ? a : [a])).map(num);

const MATH_CONSTANTS = {
  PI: Math.PI, E: Math.E, SQRT1_2: Math.SQRT1_2, SQRT2: Math.SQRT2,
  LN2: Math.LN2, LN10: Math.LN10, LOG10E: Math.LOG10E, LOG2E: Math.LOG2E,
};

function mathFunctions() {
  const one = (f) => (x) => f(num(x));
  return {
    abs: one(Math.abs), acos: one(Math.acos), asin: one(Math.asin), atan: one(Math.atan),
    ceil: one(Math.ceil), cos: one(Math.cos), exp: one(Math.exp), floor: one(Math.floor),
    log: one(Math.log), sin: one(Math.sin), sqrt: one(Math.sqrt), tan: one(Math.tan),
    atan2: (y, x) => Math.atan2(num(y), num(x)),
    pow: (b, e) => Math.pow(num(b), num(e)),
    round: (n, places) => roundTo(num(n), places === undefined || places === null ? 0 : int(places)),
    max: (...a) => Math.max(...spread(a)),
    min: (...a) => Math.min(...spread(a)),
    random: () => Math.random(),
  };
}

// ---------------------------------------------------------------- strings

function fill(pad, n) {
  const p = toText(pad) || ' ';
  if (n <= 0) return '';
  checkLength(n, 'pad');
  return p.repeat(Math.ceil(n / p.length)).slice(0, n);
}

// CenterPad("This is a test", 25, ".") = ".....This is a test......"
function centerPad(str, len, pad) {
  const s = toText(str);
  const n = int(len) - s.length;
  if (n <= 0) return s;
  const left = Math.floor(n / 2);
  return fill(pad, left) + s + fill(pad, n - left);
}
const leftPad = (str, len, pad) => { const s = toText(str); return fill(pad, int(len) - s.length) + s; };
const rightPad = (str, len, pad) => { const s = toText(str); return s + fill(pad, int(len) - s.length); };

function stringRepeat(count, str = ' ') {
  const s = str === undefined || str === null ? ' ' : toText(str);
  const n = Math.max(0, int(count));
  checkLength(s.length * n, 'StringRepeat');
  return s.repeat(n);
}

// Merge("One plus One", "Two", " = ") = "One plus One = Two"; the delimiter only
// goes in when both sides have text.
function merge(a, b, delim = ' ') {
  const x = toText(a), y = toText(b);
  return x && y ? x + (delim === undefined || delim === null ? ' ' : toText(delim)) + y : x || y;
}

const upper1 = (s) => { const t = toText(s); return t.charAt(0).toUpperCase() + t.slice(1); };

// StringToObject("test1:no1,test2:no2", ",", ":").test2 = "no2". Keys and values
// are trimmed; a part with no delim2 gets "". `into` is filled and returned.
function stringToObject(str, delim1, delim2, into = null) {
  const out = isObj(into) ? into : {};
  const d1 = toText(delim1) || ',', d2 = toText(delim2) || ':';
  for (const part of toText(str).split(d1)) {
    if (!part.trim()) continue;
    const i = part.indexOf(d2);
    const k = (i < 0 ? part : part.slice(0, i)).trim();
    if (!k || !SAFE_KEY(k)) continue;
    out[k] = i < 0 ? '' : part.slice(i + d2.length).trim();
  }
  return out;
}

// ToCSV(who, what, when) = "Bob","Cap his city","Tue Feb 11 19:59:38 GMT-0500 2014"
const toCSV = (...args) => args.map((v) => '"' + toText(v).replace(/"/g, '""') + '"').join(',');

// FormatNumber("1234567", 2) = "1,234,567.00"
function formatNumber(v, places = 0, commas = true) {
  const n = num(v);
  if (!Number.isFinite(n)) return String(n);
  const p = Math.max(0, Math.min(20, places === undefined || places === null ? 0 : int(places)));
  let s = roundTo(Math.abs(n), p).toFixed(p);
  const neg = n < 0 && Number(s) !== 0;
  const noCommas = commas === false || commas === 0 || /^(false|0|no)$/i.test(String(commas));
  if (!noCommas) {
    const [i, f] = s.split('.');
    s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f === undefined ? '' : '.' + f);
  }
  return (neg ? '-' : '') + s;
}
const formatNumber2 = (v, places, commas) => formatNumber(v, places === undefined || places === null ? 2 : places, commas);
// FormatPercent(0.25, 2) = "25.00%"
const formatPercent = (v, places) => formatNumber(num(v) * 100, places === undefined || places === null ? 1 : places) + '%';
// Cut, not rounded, to two places: the wiki's FormatDistance gives 351.80 for
// 351.8096, where round(MapDistance(...), 2) gives 351.81.
function formatMiles(v) {
  const n = num(v);
  if (!Number.isFinite(n)) return `${n} miles`;
  return (Math.trunc(n * 100 + (n >= 0 ? 1e-7 : -1e-7)) / 100).toFixed(2) + ' miles';
}

// ---------------------------------------------------------------- parsing

// ParseInteger("40s", 0, 40, "s") = 40; -1 when the text is not a whole number
// (after taking the suffix off), is below min or above max.
function parseInteger(text, min, max, suffix) {
  let s = toText(text).trim();
  if (suffix !== undefined && suffix !== null && suffix !== '') {
    const suf = toText(suffix);
    if (!s.toLowerCase().endsWith(suf.toLowerCase())) return -1;
    s = s.slice(0, s.length - suf.length).trim();
  }
  if (!/^[+-]?\d+$/.test(s)) return -1;
  const n = Number(s);
  if (min !== undefined && min !== null && n < num(min)) return -1;
  if (max !== undefined && max !== null && n > num(max)) return -1;
  return n;
}

// PrepareParameters("this is a test /a=\"qqq ww\" s") = [this, is, a, test, /a=qqq ww, s].
// Whitespace splits; a quoted run (single or double) keeps its spaces and loses
// its quotes, and may sit inside a word.
function prepareParameters(text) {
  const s = toText(text);
  const out = [];
  let cur = '', has = false, i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const end = s.indexOf(ch, i + 1);
      cur += end < 0 ? s.slice(i + 1) : s.slice(i + 1, end);
      has = true;
      i = end < 0 ? s.length : end + 1;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = ''; has = false; i++;
    } else { cur += ch; has = true; i++; }
  }
  if (has) out.push(cur);
  return out;
}

// NEAT's resource codes (Abbreviations), l/lumber for wood, or the names.
const RES_CODE = {
  f: 'food', food: 'food', w: 'wood', l: 'wood', wood: 'wood', lumber: 'wood',
  s: 'stone', stone: 'stone', i: 'iron', iron: 'iron', g: 'gold', gold: 'gold',
};
const RES_KEYS = ['gold', 'food', 'wood', 'stone', 'iron'];

// "f:990b,w:100m,i:10m:10m" -> {food, wood, iron}; null for a bad string. A
// second amount after a code (i:10m:10m, on the wiki) is ignored.
function parseResourceText(v) {
  if (isObj(v)) {
    const out = {};
    for (const k of RES_KEYS) if (v[k] !== undefined && v[k] !== null) out[k] = num(v[k]) || 0;
    return out;
  }
  const out = {};
  for (const part of toText(v).split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^([a-z]+)\s*:\s*([^:]+)/i);
    const key = m && RES_CODE[m[1].toLowerCase()];
    if (!key) return null;
    const n = num(m[2]);
    if (!Number.isFinite(n)) return null;
    out[key] = (out[key] || 0) + n;
  }
  return out;
}

// ---------------------------------------------------------------- beans

// Troop, fortification and resource beans are script-objects.js's, so GetTroops
// and GetTroopsFromXML hand back the same thing. Plain objects stand in when
// that module is missing.
function objectBeans() {
  try {
    const O = require('./script-objects');
    return O && (O.beans || O);
  } catch { return null; }
}
function troopBean(counts) {
  const B = objectBeans();
  if (B && typeof B.troops === 'function') return B.troops(counts);
  const out = {};
  for (const t of C.TROOPS) out[t.key] = counts[t.key] === undefined ? 0 : counts[t.key];
  return out;
}
function fortBean(counts) {
  const B = objectBeans();
  if (B && typeof B.fortifications === 'function') return B.fortifications(counts);
  const out = {};
  for (const w of C.WALLS) out[w.beanKey] = counts[w.beanKey] === undefined ? 0 : counts[w.beanKey];
  return out;
}
function resourceBean(res) {
  const B = objectBeans();
  if (B && typeof B.resources === 'function') return B.resources(res);
  const out = {};
  for (const k of RES_KEYS) out[k] = Number(res[k]) || 0;
  return out;
}

// ---------------------------------------------------------------- dates

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');
function tzText(d) {
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `GMT${off >= 0 ? '+' : '-'}${p2(Math.floor(a / 60))}${p2(a % 60)}`;
}
// ActionScript's Date.toString(), which is what NEAT prints:
// "Wed Oct 24 10:30:00 GMT-0400 2012".
function as3DateString(d) {
  if (Number.isNaN(d.getTime())) return 'Invalid Date';
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()} `
    + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${tzText(d)} ${d.getFullYear()}`;
}

class ScriptDate extends Date {
  toString() { return as3DateString(this); }
  // "Wed Oct 24 14:30:00 2012 UTC"
  toUTCString() {
    if (Number.isNaN(this.getTime())) return 'Invalid Date';
    return `${DAYS[this.getUTCDay()]} ${MONTHS[this.getUTCMonth()]} ${this.getUTCDate()} `
      + `${p2(this.getUTCHours())}:${p2(this.getUTCMinutes())}:${p2(this.getUTCSeconds())} ${this.getUTCFullYear()} UTC`;
  }
  toTimeString() { return `${p2(this.getHours())}:${p2(this.getMinutes())}:${p2(this.getSeconds())} ${tzText(this)}`; }
  toNumber() { return this.getTime(); }   // the wiki's name for it
}

// date() now; date(ms) that moment; date(y, month0, d, h, mi, s, ms) local time,
// months from 0 (date(2012, 9, 24, 10, 30) is 24 October).
function makeDate(nowMs, args) {
  if (!args.length) return new ScriptDate(nowMs);
  if (args.length === 1) {
    const v = args[0];
    if (v instanceof Date) return new ScriptDate(v.getTime());
    if (typeof v === 'string' && !/^\s*[+-]?\d+(\.\d+)?\s*$/.test(v)) return new ScriptDate(Date.parse(v));
    return new ScriptDate(num(v));
  }
  const [y, mo, d = 1, h = 0, mi = 0, s = 0, ms = 0] = args.map(num);
  return new ScriptDate(y, mo, d, h, mi, s, ms);
}

// ---------------------------------------------------------------- JSON

// The properties json_encode shows: own enumerable ones, plus the getters of a
// class-built view (script-objects.js's city, hero...), which live on its prototype.
function jsonKeys(v) {
  const keys = Object.keys(v);
  const seen = new Set(keys);
  for (let p = Object.getPrototypeOf(v); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const k of Object.getOwnPropertyNames(p)) {
      if (seen.has(k)) continue;
      const d = Object.getOwnPropertyDescriptor(p, k);
      if (d && typeof d.get === 'function') { keys.push(k); seen.add(k); }
    }
  }
  return keys;
}

// A detached copy made of JSON's own types: functions and promises dropped,
// dates as ISO text, a loop cut off as "[circular]". Views hand out fresh
// objects on every read, so the size is capped as well as the depth.
const JSON_MAX_NODES = 20000;
function toPlain(v, stack, budget) {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'function' || typeof v === 'symbol' || v === undefined) return undefined;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'number' && !Number.isFinite(v)) return null;
    return v;
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (safe(() => typeof v.then === 'function', true)) return undefined;   // a promise, or a getter that throws
  if (stack.includes(v)) return '[circular]';
  if (stack.length >= 32) return '[too deep]';
  if (++budget.n > JSON_MAX_NODES) return '[too big]';
  stack.push(v);
  let out;
  if (Array.isArray(v)) {
    out = v.map((x) => { const y = toPlain(x, stack, budget); return y === undefined ? null : y; });
  } else {
    out = {};
    for (const k of jsonKeys(v)) {
      if (!SAFE_KEY(k)) continue;
      let y;
      try { y = toPlain(v[k], stack, budget); } catch { continue; }
      if (y !== undefined) out[k] = y;
    }
  }
  stack.pop();
  return out;
}
function jsonEncode(v, indent) {
  const sp = indent === undefined || indent === null || indent === false ? undefined
    : indent === true ? 2 : typeof indent === 'string' ? indent : Math.max(0, Math.min(10, int(indent)));
  const s = JSON.stringify(toPlain(v, [], { n: 0 }), null, sp);
  return s === undefined ? 'null' : s;
}
function jsonDecode(text) {
  try { return JSON.parse(toText(text), (k, v) => (SAFE_KEY(k) ? v : undefined)); } catch { return null; }
}

// ---------------------------------------------------------------- XML

// The reader behind the console's Reports window (mailbox.js), which decodes
// the way the client's SimpleXMLDecoder does: attributes and child elements
// become properties, a repeated child becomes an array. xml() returns the root
// element, so report.scoutReport... works as in NEAT's examples.
function xml(src) {
  if (src !== null && typeof src === 'object') return src;
  const doc = require('./mailbox').parseXml(toText(src));
  if (!isObj(doc)) return null;
  const keys = Object.keys(doc);
  return keys.length === 1 ? doc[keys[0]] : doc;
}

// A count as the report gives it: a number, or text the scouts could not pin
// down ("?", a range), which is kept as text.
function countValue(v) {
  if (isObj(v)) v = v._text;
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  const n = Number(s.replace(/,/g, ''));
  return s !== '' && Number.isFinite(n) ? n : s;
}

// The entries of an XML list: one object or an array of them. Handed the
// parent node (troops, fortifications) instead, its list child is used.
function xmlList(v) {
  if (v === null || v === undefined || v === '') return [];
  if (Array.isArray(v)) return v.filter(isObj);
  if (!isObj(v)) return [];
  if (v.typeId !== undefined || v.type !== undefined) return [v];
  for (const k of Object.keys(v)) {
    const c = v[k];
    if (Array.isArray(c) || (isObj(c) && c.typeId !== undefined)) return xmlList(c);
  }
  return [];
}

function unitCounts(list, countProp, keyOf) {
  const out = {};
  const prop = countProp === undefined || countProp === null || countProp === '' ? 'count' : toText(countProp);
  for (const u of xmlList(list)) {
    const key = keyOf(num(u.typeId !== undefined ? u.typeId : u.type));
    if (!key) continue;
    const c = countValue(u[prop]);
    const prev = out[key];
    out[key] = prev === undefined ? c : typeof prev === 'number' && typeof c === 'number' ? prev + c : prev;
  }
  return out;
}
const TROOP_KEY_BY_TYPE = Object.fromEntries(C.TROOPS.map((t) => [t.typeId, t.key]));

function troopsFromXml(list, countProp) {
  if (list === null || list === undefined) return null;
  return troopBean(unitCounts(list, countProp, (id) => TROOP_KEY_BY_TYPE[id]));
}
function fortsFromXml(list, countProp) {
  if (list === null || list === undefined) return null;
  return fortBean(unitCounts(list, countProp, (id) => (C.WALL_BY_TYPE[id] || {}).beanKey));
}
// <lootResource gold="2500000" food="..."/> -> a resource bean; null when absent.
// Some reports say lumber for wood (ImpositionReport).
const XML_RES = { gold: 'gold', food: 'food', wood: 'wood', lumber: 'wood', stone: 'stone', iron: 'iron' };
function resourcesFromXml(node) {
  if (!isObj(node)) return null;
  const res = {};
  for (const [k, v] of Object.entries(node)) {
    const key = XML_RES[k.toLowerCase()];
    if (!key) continue;
    const n = countValue(v);
    res[key] = (res[key] || 0) + (typeof n === 'number' ? n : 0);
  }
  return resourceBean(res);
}

// ---------------------------------------------------------------- constants

// PlayerState, from the client's CityConstants (1 normal, 2 anti-battle, 3 fresh
// man, 5 vacation, 6 dream truce) in NEAT's words.
const PLAYER_STATE = { peace: 1, truce: 2, beginner: 3, holiday: 5, dream: 6 };
const STATE_NAME = Object.fromEntries(Object.entries(PLAYER_STATE).map(([k, v]) => [v, k]));

// FieldConstants / NEAT's FieldTypes.
const FIELD_TYPE_IDS = Object.fromEntries(Object.entries(C.FIELD_TYPES).map(([id, f]) => [f.name, Number(id)]));
const FIELD_TYPE_WORDS = {
  ...Object.fromEntries(Object.entries(C.FIELD_TYPES).map(([id, f]) => [f.key, Number(id)])),
  forests: 1, deserts: 2, hills: 3, swamps: 4, grasslands: 5, grass: 5, lakes: 6, flats: 10,
  city: 11, cities: 11, player: 11, castles: 11, npcs: 12, barbarian: 12,
};

// The Abbreviations page, code -> name.
const ABBREVIATIONS = {
  buildings: {
    a: 'academy', b: 'barrack', be: 'beacon tower', c: 'cottage', e: 'embassy', fh: 'feasting hall',
    fo: 'forge', f: 'farm', s: 'sawmill', q: 'quarry', i: 'iron mine', inn: 'inn', m: 'market',
    r: 'rally spot', rs: 'relief station', st: 'stable', t: 'town hall', w: 'wall', wh: 'warehouse', ws: 'workshop',
  },
  research: {
    ag: 'agriculture', lu: 'lumbering', mas: 'masonry', mi: 'mining', met: 'metal casting', in: 'informatics',
    ms: 'military science', mt: 'military tradition', ir: 'ironworking', lo: 'logistics', com: 'compass',
    ho: 'horseback riding', ar: 'archery', st: 'stockpile', sp: 'stockpile', med: 'medicine',
    con: 'construction', en: 'engineering', mac: 'machinery', pr: 'privateering',
  },
  troops: {
    wo: 'worker', w: 'warrior', s: 'scout', p: 'pikemen', sw: 'swordsmen', a: 'archer', c: 'cavalry',
    cata: 'cataphract', t: 'transport', b: 'ballista', ram: 'battering ram', br: 'battering ram',
    r: 'battering ram', cp: 'catapult', pult: 'catapult',
  },
  fortifications: { tra: 'trap', ab: 'abatis', at: 'archer towers', r: 'rolling logs', tre: 'trebuchets' },
  resources: { g: 'gold', f: 'food', w: 'wood', s: 'stone', i: 'iron' },
};

// The speed-ups the Speedups page names, shortest first. `seconds` is how much
// one takes off; Master's 10-30 h is random, Ultimate takes 30 percent.
const SPEED_UP_ITEMS = [
  { id: 'consume.2.a', name: 'Beginner Guidelines', seconds: 15 * 60 },
  { id: 'consume.2.b', name: 'Primary Guidelines', seconds: 3600 },
  { id: 'consume.2.b.1', name: 'Intermediate Guidelines', seconds: 2.5 * 3600 },
  { id: 'consume.2.c', name: 'Senior Guidelines', seconds: 8 * 3600 },
  { id: 'consume.2.c.1', name: 'Master Guidelines', seconds: 10 * 3600, maxSeconds: 30 * 3600 },
  { id: 'consume.2.d', name: 'Ultimate Guidelines', percent: 30 },
];

const RESOURCE_NAMES = ['Food', 'Wood', 'Stone', 'Iron'];   // ResourceId: the market's numbering

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
const named = (list) => Object.fromEntries(list.flatMap((x) => {
  const flat = x.name.replace(/\s+/g, '');
  return flat === x.name ? [[x.name, x.typeId]] : [[x.name, x.typeId], [flat, x.typeId]];
}));

// Fresh per run, then frozen: a script can read them but never change them for
// the next run.
function constants() {
  const speedUps = SPEED_UP_ITEMS.map((s) => {
    const o = { ...s };
    Object.defineProperty(o, 'toString', { value() { return this.name; } });
    return o;
  });
  const bot = botInfo();
  return {
    ...MATH_CONSTANTS,
    NaN: NaN, Infinity: Infinity,
    RESOURCETYPE_FOOD: C.TRADE_RES.food, RESOURCETYPE_WOOD: C.TRADE_RES.wood,
    RESOURCETYPE_STONE: C.TRADE_RES.stone, RESOURCETYPE_IRON: C.TRADE_RES.iron,
    ResourceNames: deepFreeze([...RESOURCE_NAMES]),
    BuildingTypes: deepFreeze(named(C.BUILDINGS)),
    ResearchTypes: deepFreeze(named(C.TECHS)),
    FieldTypes: deepFreeze({ ...FIELD_TYPE_IDS }),
    PlayerState: deepFreeze({ ...PLAYER_STATE }),
    Abbreviations: deepFreeze(JSON.parse(JSON.stringify(ABBREVIATIONS))),
    SpeedUpItems: deepFreeze(speedUps),
    BuildVersion: bot.version, BuildDate: bot.date, BuildName: bot.name,
  };
}

// Assigning one of these is an error, not a new variable: NEAT's version guard
// (@BuildVersion = "" then if BuildVersion < "3167" end) relies on it.
const readOnly = new Set([
  ...Object.keys(MATH_CONSTANTS), 'NaN', 'Infinity',
  'RESOURCETYPE_FOOD', 'RESOURCETYPE_WOOD', 'RESOURCETYPE_STONE', 'RESOURCETYPE_IRON', 'ResourceNames',
  'BuildingTypes', 'ResearchTypes', 'FieldTypes', 'PlayerState', 'Abbreviations', 'SpeedUpItems',
  'BuildVersion', 'BuildDate', 'BuildName',
]);

// ---------------------------------------------------------------- bot info

// OTTObot has no release number. BuildVersion sits above every NEAT build (the
// last was in the 3300s) so NEAT's version guards pass; BuildName and BuildDate
// come from the git commit the files on disk are at, read straight from .git.
const BUILD_VERSION = 9999;

function gitHead(dir) {
  try {
    let gitDir = path.join(dir, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const m = fs.readFileSync(gitDir, 'utf8').match(/gitdir:\s*(.+)/);
      if (!m) return null;
      gitDir = path.resolve(dir, m[1].trim());
    }
    let common = gitDir;
    try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch {}
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    let hash = /^[0-9a-f]{40}$/.test(head) ? head : null, refAt = null;
    if (!hash) {
      const ref = head.replace(/^ref:\s*/, '');
      for (const d of [gitDir, common]) {
        try {
          const p = path.join(d, ref);
          hash = fs.readFileSync(p, 'utf8').trim();
          refAt = fs.statSync(p).mtimeMs;
          break;
        } catch {}
      }
      if (!hash) {
        const line = fs.readFileSync(path.join(common, 'packed-refs'), 'utf8').split(/\r?\n/).find((l) => l.endsWith(' ' + ref));
        if (line) hash = line.slice(0, 40);
      }
    }
    if (!/^[0-9a-f]{40}$/.test(hash || '')) return null;
    // the committer time, when the commit is a loose object
    let at = refAt;
    try {
      const raw = zlib.inflateSync(fs.readFileSync(path.join(common, 'objects', hash.slice(0, 2), hash.slice(2)))).toString('utf8');
      const m = raw.match(/\ncommitter [^\n]* (\d+) [+-]\d{4}\n/);
      if (m) at = Number(m[1]) * 1000;
    } catch {}
    return { hash, at };
  } catch { return null; }
}

let _bot = null;
function botInfo() {
  if (_bot) return _bot;
  const head = gitHead(__dirname);
  let at = head && head.at;
  if (!at) { try { at = fs.statSync(__filename).mtimeMs; } catch { at = Date.now(); } }
  const d = new Date(at);
  const mdy = `${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${d.getFullYear()}`;
  _bot = {
    version: BUILD_VERSION,
    date: d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    name: `OTTObot Version ${mdy}${head ? '.' + head.hash.slice(0, 7) : ''}`,
    hash: head ? head.hash : null,
  };
  return _bot;
}

// ---------------------------------------------------------------- map: coordinates

const W = C.MAP_W;
const wrapXY = (v) => ((Math.floor(v) % W) + W) % W;
const clampXY = (v) => Math.max(0, Math.min(W - 1, Math.floor(v)));

// Anything a script may name a tile by: a field id, "x,y" (also "x.y", which
// the wiki writes once, and "Name(x,y)"), x and y, or an object with x/y or
// fieldId. Coordinates wrap round the map as the game's do.
function coordsOf(v, y) {
  if (y !== undefined && y !== null && v !== null && v !== undefined && typeof v !== 'object') {
    const x = num(v), yy = num(y);
    return Number.isFinite(x) && Number.isFinite(yy) ? { x: wrapXY(x), y: wrapXY(yy) } : null;
  }
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v < W * W ? C.fieldIdToCoords(v) : null;
  if (typeof v === 'object') {
    if (v.x !== undefined && v.y !== undefined) return coordsOf(v.x, v.y);
    if (v.fieldId !== undefined) return coordsOf(num(v.fieldId));
    return null;
  }
  const s = String(v).trim();
  let m = s.match(/^(-?\d+)\s*[,.:\s]\s*(-?\d+)$/);
  if (m) return coordsOf(Number(m[1]), Number(m[2]));
  if (/^\d+$/.test(s)) return coordsOf(Number(s));
  m = s.match(/\((-?\d+)\s*,\s*(-?\d+)\)\s*$/);
  if (m) return coordsOf(Number(m[1]), Number(m[2]));
  return null;
}
const fieldIdOf = (v, y) => { const c = coordsOf(v, y); return c ? C.coordsToFieldId(c.x, c.y) : null; };
const coordText = (v) => { const c = coordsOf(v); return c ? `${c.x},${c.y}` : null; };
const zoneName = (v) => { const c = coordsOf(v); return c ? C.zoneOf(c.x, c.y) : null; };

function mapDistance(a, b, c, d) {
  const p = c === undefined && d === undefined ? coordsOf(a) : coordsOf(a, b);
  const q = c === undefined && d === undefined ? coordsOf(b) : coordsOf(c, d);
  return p && q ? C.mapDistance(p, q) : NaN;
}

// StateCoords("upper lorraine") = StateCoords(8) = "0,400 199,599"; "all" is the world.
function stateCoords(zone) {
  if (zone === null || zone === undefined || zone === '') return null;
  const s = String(zone).trim().toLowerCase();
  if (s === 'all') return `0,0 ${W - 1},${W - 1}`;
  const flat = s.replace(/\s+/g, '');
  const i = /^\d+$/.test(s) ? Number(s) : C.ZONES.findIndex((z) => z.toLowerCase().replace(/\s+/g, '') === flat);
  if (!(i >= 0 && i < C.ZONES.length)) return null;
  const x = (i % 4) * 200, y = Math.floor(i / 4) * 200;
  return `${x},${y} ${x + 199},${y + 199}`;
}

const stateName = (n) => STATE_NAME[int(n, -1)] || '';

// GetFieldType("hill") = 3; -1 for a name that is no field type.
function fieldType(name) {
  if (typeof name === 'number') return C.FIELD_TYPES[name] ? name : -1;
  const s = toText(name).trim().toLowerCase();
  if (/^\d+$/.test(s)) return C.FIELD_TYPES[Number(s)] ? Number(s) : -1;
  const t = FIELD_TYPE_WORDS[s] !== undefined ? FIELD_TYPE_WORDS[s] : FIELD_TYPE_WORDS[s.replace(/\s+/g, '')];
  return t === undefined ? -1 : t;
}
const fieldName = (type) => { const f = C.FIELD_TYPES[int(type, -1)]; return f ? f.name : null; };

// ---------------------------------------------------------------- map: data

// The saved map cache: db.js, required on first use. setMapCache() swaps it
// (tests; anything else that wants its own). A source answers
// tiles(x1, y1, x2, y2, { castles }) with rows shaped like map_cache.json.
let mapCacheOverride = null;
function setMapCache(src) { mapCacheOverride = src || null; }

const dbMapCache = {
  tiles(x1, y1, x2, y2, { castles = false } = {}) {
    const D = require('./db');
    const rows = D.all(`SELECT json FROM map_cache WHERE id BETWEEN ? AND ?
      AND x BETWEEN ? AND ? AND y BETWEEN ? AND ?${castles ? ' AND (userName IS NOT NULL OR npc = 1)' : ''}`,
    y1 * W + x1, y2 * W + x2, x1, x2, y1, y2);
    const out = [];
    for (const r of rows) { try { out.push(JSON.parse(r.json)); } catch {} }
    return out;
  },
};

// The session's live blocks, via its own decoder (castles over terrain, with the
// server's `relation`). Only blocks that touch the rectangle are decoded.
function sessionTiles(session, game, x1, y1, x2, y2) {
  if (!session || typeof session.mapStore !== 'function' || typeof session.mapBlockTiles !== 'function') return [];
  let store;
  try { store = session.mapStore(); } catch { return []; }
  if (!store || !store.blocks) return [];
  const mine = new Set(((game && game.castles) || []).map((c) => Number(c.fieldId)));
  const out = [];
  for (const e of store.blocks.values()) {
    if (!e || e.x2 < x1 || e.x1 > x2 || e.y2 < y1 || e.y1 > y2) continue;
    for (const t of session.mapBlockTiles(e, mine)) {
      if (t.x < x1 || t.x > x2 || t.y < y1 || t.y > y2) continue;
      out.push({ ...t, seen: e.at });
    }
  }
  return out;
}

// ResetMap: areas whose cached tiles are hidden until seen again after the reset.
const RESETS = [];
const MAX_RESETS = 200;
const hiddenByReset = (t) => RESETS.some((r) => r.has(t.x, t.y) && Number(t.seen || 0) <= r.at);

const KIND_TYPE = { forest: 1, desert: 2, hill: 3, swamp: 4, grassland: 5, lake: 6, flat: 10, castle: 11, player: 11, npc: 12 };
function tileType(t) {
  if (t.npc === true || t.npc === 1 || t.kind === 'npc') return 12;
  if (t.userName || t.kind === 'player' || t.kind === 'castle') return 11;
  if (t.type !== undefined && t.type !== null && C.FIELD_TYPES[Number(t.type)]) return Number(t.type);
  return KIND_TYPE[t.kind] === undefined ? null : KIND_TYPE[t.kind];
}

const safe = (f, dflt = null) => { try { return f(); } catch { return dflt; } };
const gameOf = (ctx) => safe(() => ctx && ctx.game);
const castleOf = (ctx) => safe(() => ctx && ctx.castle);
const sessionOf = (ctx) => safe(() => ctx && ctx.session);

// Every known tile in a rectangle (clamped to the world), newest reading per
// tile, as fresh objects: {id, x, y, type, level, name, userName, ..., seen}.
async function mapTiles(ctx, x1, y1, x2, y2, opts = {}) {
  [x1, x2] = [clampXY(Math.min(x1, x2)), clampXY(Math.max(x1, x2))];
  [y1, y2] = [clampXY(Math.min(y1, y2)), clampXY(Math.max(y1, y2))];
  const byId = new Map();
  const add = (row) => {
    if (!row || row.id === undefined || row.id === null) return;
    const id = Number(row.id);
    if (!Number.isInteger(id) || id < 0 || id >= W * W) return;
    const { x, y } = C.fieldIdToCoords(id);
    if (x < x1 || x > x2 || y < y1 || y > y2) return;
    const prev = byId.get(id);
    if (prev && Number(prev.seen || 0) > Number(row.seen || 0)) return;
    byId.set(id, { ...row, id, x, y });
  };
  const src = (ctx && ctx.mapSource) || mapCacheOverride;
  if (src) {
    for (const r of (await src.tiles(x1, y1, x2, y2, opts)) || []) add(r);
  } else {
    try { for (const r of dbMapCache.tiles(x1, y1, x2, y2, opts)) add(r); } catch {}
  }
  if (!(ctx && ctx.mapSource)) for (const r of sessionTiles(sessionOf(ctx), gameOf(ctx), x1, y1, x2, y2)) add(r);
  const out = [];
  for (const t of byId.values()) {
    if (hiddenByReset(t)) continue;
    t.type = tileType(t);
    out.push(t);
  }
  return out;
}
async function oneTile(ctx, fid) {
  const c = C.fieldIdToCoords(fid);
  return (await mapTiles(ctx, c.x, c.y, c.x, c.y))[0] || null;
}

// The alliance picture relation is worked out from when a tile has no word from
// the server (the saved cache drops it): our alliance and the diplomacy lists
// the session last read (Session.diplomacy).
function standing(ctx) {
  const g = gameOf(ctx), s = sessionOf(ctx);
  const info = safe(() => g.player.playerInfo) || {};
  const d = safe(() => s.diplo) || null;
  const low = (list) => new Set((list || []).map((a) => String(a).toLowerCase()));
  return {
    me: info.userName ? String(info.userName).toLowerCase() : null,
    alliance: (d && d.alliance) || info.alliance || null,
    friendly: low(d && d.friendly), neutral: low(d && d.neutral), enemy: low(d && d.enemy),
  };
}
async function freshStanding(ctx) {
  const s = sessionOf(ctx);
  if (s && typeof s.diplomacy === 'function') { try { await s.diplomacy(); } catch {} }
  return standing(ctx);
}

// AllianceConstants: 0 same alliance, 1 friendly, 2 neutral, 3 enemy; 6 for an
// unowned tile or a lord with no standing (the wiki's "6 = unowned valleys or
// unallied castles").
function relationOf(t, st) {
  if (t.relation !== undefined && t.relation !== null && t.relation !== '') return Number(t.relation);
  if (!t.userName) return 6;
  const a = t.allianceName ? String(t.allianceName).toLowerCase() : null;
  if (!a) return 6;
  if (st.alliance && a === String(st.alliance).toLowerCase()) return 0;
  if (st.friendly.has(a)) return 1;
  if (st.neutral.has(a)) return 2;
  if (st.enemy.has(a)) return 3;
  return 6;
}

// canScout is the server's flag (MapCastleBean.canScout, FieldInfoWin's Scout
// button); a scan tile does not carry it, so it is worked out the way the flag
// falls: an NPC, or another lord's castle in its normal state (PlayerState 1 —
// not truce, beginner, holiday or dream). The CompleteQuests page filters
// CastlesInRectangle(...) on it.
function scoutable(t, st) {
  if (t.type === 12) return true;
  if (t.type !== 11) return false;
  const mine = t.mine === true || !!(st.me && t.userName && String(t.userName).toLowerCase() === st.me);
  const state = t.state === undefined || t.state === null ? 1 : Number(t.state);
  return !mine && state === 1;
}

// NEAT's MapCastleBean, plus x, y, coords, level, type and lastUpdated.
function tileBean(t, st) {
  const field = C.FIELD_TYPES[t.type];
  const flags = {};
  for (const k of ['canLoot', 'canOccupy', 'canSend', 'canTrans']) if (t[k] !== undefined && t[k] !== null) flags[k] = !!t[k];
  return {
    canScout: t.canScout !== undefined && t.canScout !== null ? !!t.canScout : scoutable(t, st),
    ...flags,
    id: t.id, x: t.x, y: t.y, coords: `${t.x},${t.y}`,
    name: t.name !== undefined && t.name !== null ? String(t.name) : field ? field.name : null,
    userName: t.userName || null,
    allianceName: t.allianceName || null,
    prestige: Number(t.prestige || 0),
    honor: Number(t.honor || 0),
    relation: relationOf(t, st),
    // the server answers 1 for an empty valley too (the wiki's GetDetailInfo sample)
    state: t.state === undefined || t.state === null ? 1 : Number(t.state),
    furlough: !!t.furlough,
    npc: t.type === 12,
    flag: t.flag || null,
    zoneName: C.zoneOf(t.x, t.y),
    level: t.level === undefined || t.level === null ? null : Number(t.level),
    type: t.type,
    lastUpdated: t.seen === undefined || t.seen === null ? null : Number(t.seen),
  };
}

const isCastle = (t) => t.type === 11 || t.type === 12;
const byIdOrder = (a, b) => a.id - b.id;

async function castlesIn(ctx, x1, y1, x2, y2, omitNpc = true) {
  const st = standing(ctx);
  return (await mapTiles(ctx, x1, y1, x2, y2, { castles: true }))
    .filter((t) => isCastle(t) && !(omitNpc && t.type === 12))
    .sort(byIdOrder).map((t) => tileBean(t, st));
}

// ---------------------------------------------------------------- map: detail info

// field.getOtherFieldInfo {fieldId} -> {bean: MapCastleBean} (FieldCommand.as,
// OtherFieldInfoResponse.as): what the client shows for a clicked tile. Kept per
// account (the session, or the game when there is none).
const DETAIL = new WeakMap();
const DETAIL_MAX = 5000;
const DETAIL_FIELDS = ['allianceName', 'changeface', 'flag', 'honor', 'id', 'name', 'playerLogoUrl', 'prestige',
  'relation', 'state', 'userName', 'zoneName', 'canLoot', 'canOccupy', 'canScout', 'canSend', 'canTrans', 'furlough', 'npc'];
const NO_ACCOUNT = {};

function detailStore(ctx) {
  const key = sessionOf(ctx) || gameOf(ctx) || NO_ACCOUNT;
  let m = DETAIL.get(key);
  if (!m) { m = new Map(); DETAIL.set(key, m); }
  return m;
}

function nowOf(ctx) {
  const g = gameOf(ctx);
  return g && typeof g.now === 'function' ? g.now() : Date.now();
}

function online(ctx) {
  const s = sessionOf(ctx), g = gameOf(ctx);
  if (!g || typeof g.req !== 'function') return false;
  if (s && 'connected' in s) return !!s.connected;
  return 'alive' in g ? !!g.alive : true;
}

async function liveDetail(ctx, fid) {
  if (!online(ctx)) return null;
  const g = gameOf(ctx);
  const ask = () => g.req('field.getOtherFieldInfo', { fieldId: fid }, 8000);
  let r;
  try { r = typeof g.lane === 'function' ? await g.lane('field.getOtherFieldInfo', ask) : await ask(); } catch { return null; }
  const b = r && r.bean;
  if (!b || (r.ok !== undefined && Number(r.ok) !== 1)) return null;
  if (b.id !== undefined && b.id !== null && Number(b.id) !== fid) return null;   // a reply meant for someone else
  const { x, y } = C.fieldIdToCoords(fid);
  const bean = { id: fid, x, y, coords: `${x},${y}` };
  for (const k of DETAIL_FIELDS) if (b[k] !== undefined) bean[k] = b[k];
  bean.id = fid;
  bean.lastUpdated = Date.now();
  const store = detailStore(ctx);
  store.delete(fid);
  store.set(fid, { bean, at: bean.lastUpdated });
  if (store.size > DETAIL_MAX) store.delete(store.keys().next().value);
  return { ...bean };
}

// GetDetailInfo(id[, priority[, expireSeconds[, sinceMs]]]): cached details if
// new enough, else the server's answer, else null. With no expiry anything
// cached will do; otherwise it must be newer than (sinceMs || now) - expire.
// A tile from the map scan counts as cached (without the can* flags).
// `priority` has no meaning here: requests are not queued, they are waited for.
async function getDetailInfo(ctx, id, _priority, expireSeconds, sinceMs) {
  const fid = fieldIdOf(id);
  if (fid === null) return null;
  const expire = num(expireSeconds) || 0, since = num(sinceMs) || 0;
  const cutoff = expire > 0 || since > 0 ? (since || Date.now()) - expire * 1000 : -Infinity;
  const hit = detailStore(ctx).get(fid);
  const tile = await oneTile(ctx, fid);
  const withTile = (b) => (b && tile ? Object.assign(b, { level: tile.level === undefined ? null : tile.level, type: tile.type }) : b);
  // of two good readings the newer wins: a scan after the detail may show a new owner
  if (hit && hit.at >= cutoff && !(tile && Number(tile.seen || 0) > hit.at)) return withTile({ ...hit.bean });
  if (tile && Number(tile.seen || 0) >= cutoff) return tileBean(tile, standing(ctx));
  return withTile(await liveDetail(ctx, fid));
}

// RelationIndex: 0 you, 1 enemy, 2 your alliance, 3 friendly, 4 neutral,
// 5 another alliance, 6 no alliance.
function relationIndex(ctx, bean) {
  if (!isObj(bean)) return 6;
  const st = standing(ctx);
  if (st.me && bean.userName && String(bean.userName).toLowerCase() === st.me) return 0;
  const rel = relationOf(bean, st);
  if (rel === 3) return 1;
  if (rel === 0) return 2;
  if (rel === 1) return 3;
  if (rel === 2) return 4;
  return bean.allianceName ? 5 : 6;
}

// ResetMap(x, y, r) a circle, ResetMap(x, y, w, h) a rectangle from x,y: cached
// tiles there are forgotten until a scan sees them again, and the session's live
// blocks touching it are dropped so the next scan asks the server.
function resetMap(ctx, x, y, a, b) {
  const cx = num(x), cy = num(y);
  if (![cx, cy, num(a)].every(Number.isFinite)) throw new Error('ResetMap(x, y, radius) or ResetMap(x, y, width, height)');
  let area, box;
  if (b === undefined || b === null) {
    const r = Math.max(0, num(a));
    area = (tx, ty) => Math.hypot(tx - cx, ty - cy) <= r;
    box = { x1: cx - r, y1: cy - r, x2: cx + r, y2: cy + r };
  } else {
    const w = Math.max(1, int(a)), h = Math.max(1, int(b));
    box = { x1: cx, y1: cy, x2: cx + w - 1, y2: cy + h - 1 };
    area = (tx, ty) => tx >= box.x1 && tx <= box.x2 && ty >= box.y1 && ty <= box.y2;
  }
  RESETS.push({ has: area, at: Date.now() });
  if (RESETS.length > MAX_RESETS) RESETS.shift();
  const store = detailStore(ctx);
  for (const fid of [...store.keys()]) { const c = C.fieldIdToCoords(fid); if (area(c.x, c.y)) store.delete(fid); }
  const s = sessionOf(ctx);
  try {
    const blocks = s && typeof s.mapStore === 'function' ? s.mapStore().blocks : null;
    if (blocks) for (const [k, e] of blocks) if (!(e.x2 < box.x1 || e.x1 > box.x2 || e.y2 < box.y1 || e.y1 > box.y2)) blocks.delete(k);
  } catch {}
  return null;
}

// ---------------------------------------------------------------- map: searches

// FindField(x, y, radius, type[, level]): field ids of that type within the
// radius, in NEAT's order (by x, then y). Level 0 or none is any level.
async function findField(ctx, cx, cy, radius, type, level) {
  const c = coordsOf(cx, cy);
  const r = num(radius);
  const t = fieldType(type);
  if (!c || !Number.isFinite(r) || r < 0) throw new Error('FindField(x, y, radius, fieldType[, level])');
  if (t < 0) throw new Error(`FindField: unknown field type ${toText(type)} (FieldTypes: 1-6 valleys, 10 flat, 11 castle, 12 npc)`);
  const lv = level === undefined || level === null ? 0 : int(level);
  const tiles = await mapTiles(ctx, c.x - r, c.y - r, c.x + r, c.y + r, { castles: t === 11 || t === 12 });
  return tiles
    .filter((x) => x.type === t && (!lv || Number(x.level) === lv) && C.mapDistance(c, x) <= r + 1e-9)
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .map((x) => x.id);
}

async function searchEnemyCastles(ctx, n) {
  const st = await freshStanding(ctx);
  const tiles = await mapTiles(ctx, 0, 0, W - 1, W - 1, { castles: true });
  const home = safe(() => coordsOf(castleOf(ctx).fieldId));
  const mine = new Set(safe(() => gameOf(ctx).castles.map((c) => Number(c.fieldId)), []) || []);
  const enemies = tiles.filter((t) => t.type === 11 && !mine.has(t.id) && relationOf(t, st) === 3).map((t) => tileBean(t, st));
  if (home) enemies.sort((a, b) => C.mapDistance(home, a) - C.mapDistance(home, b) || a.id - b.id);
  else enemies.sort(byIdOrder);
  const k = n === undefined || n === null ? enemies.length : Math.max(0, int(n));
  return enemies.slice(0, k);
}

// ---------------------------------------------------------------- travel time

// Seconds from one tile to another for these troops, the client's way
// (C.marchTimeMs). `troops` is a troop bean, {key: count}, or "a:5k,c:100".
// Type 2 (transport/reinforce) gets the Relief Station, which the client gives
// when the target is yours or your alliance's.
function troopKeys(troops) {
  if (typeof troops === 'string') {
    const out = [];
    for (const part of troops.split(',')) {
      const m = part.trim().match(/^([a-z]+)\s*:\s*(.+)$/i);
      const t = m && (C.BY_CODE[m[1].toLowerCase()] || C.BY_KEY[m[1]]);
      if (!t) throw new Error('bad troop string: ' + part.trim());
      if (num(m[2]) > 0) out.push(t.key);
    }
    return out;
  }
  if (!troops || typeof troops !== 'object') return [];
  return C.TROOPS.map((t) => t.key).filter((k) => num(troops[k]) > 0);
}

async function travelTime(ctx, from, to, troops, type) {
  const a = coordsOf(from), b = coordsOf(to);
  if (!a || !b) return null;
  const keys = troopKeys(troops);
  if (!keys.length) return null;
  const g = gameOf(ctx);
  let skills = { marchSkill: Number((g && g.marchSkillParam) ?? 100) };
  const castle = castleOf(ctx);
  if (online(ctx) && g && typeof g.troopParams === 'function' && castle) {
    try {
      const p = await g.troopParams(g.castleId ? g.castleId(castle) : castle.id);
      skills = { marchSkill: p.marchSkill, driveSkill: p.driveSkill, relief: num(type) === 2 || num(type) === 1 ? p.relief : 0 };
    } catch {}
  }
  const ms = C.marchTimeMs(a, b, keys, skills);
  return ms === null ? null : Math.round(ms / 1000);
}

// ---------------------------------------------------------------- city timers

// DocumentationPending's setCityTimer / cityTimingAllowed: named per-city clocks.
// cityTimingAllowed(key, seconds) is true when the timer is unset or that long
// has passed, and restarts it then (unless `test`). Held for the process's life.
const TIMERS = new Map();
const cityTimers = {
  set(castleId, key, at = Date.now()) { TIMERS.set(`${castleId}|${toText(key)}`, at); return null; },
  allowed(castleId, key, seconds, test = false, at = Date.now()) {
    const k = `${castleId}|${toText(key)}`;
    const last = TIMERS.get(k);
    const ok = last === undefined || at - last >= Math.max(0, num(seconds) || 0) * 1000;
    if (ok && !test) TIMERS.set(k, at);
    return ok;
  },
};
const castleKey = (ctx) => safe(() => { const c = castleOf(ctx); return c.castleId ?? c.id ?? c.name; }, 'none') ?? 'none';

// ---------------------------------------------------------------- globals

function globals(ctx = {}) {
  const math = mathFunctions();
  const consts = constants();
  const now = () => nowOf(ctx);

  const MathObj = Object.freeze({ ...math, ...MATH_CONSTANTS });
  const StringFn = (v) => (v === undefined ? '' : v === null ? 'null' : v instanceof Date ? as3DateString(v) : String(v));
  StringFn.fromCharCode = (...codes) => String.fromCharCode(...codes.map((c) => int(c)));
  Object.freeze(StringFn);

  const detail = (id, priority, expire, since) => getDetailInfo(ctx, id, priority, expire, since);
  const update = async (id) => { const fid = fieldIdOf(id); return fid === null ? null : liveDetail(ctx, fid); };
  // the optional flags are ActionScript booleans: anything falsy is false
  const flag = (v, dflt) => (v === undefined || v === null ? dflt : !!v);
  const rect = async (x1, y1, x2, y2, omitNpc, indexById) => {
    const xy = [x1, y1, x2, y2].map(num);
    if (!xy.every(Number.isFinite)) throw new Error('CastlesInRectangle(x1, y1, x2, y2[, omitNpc[, indexById]])');
    const list = await castlesIn(ctx, ...xy, flag(omitNpc, true));
    return flag(indexById, false) ? Object.fromEntries(list.map((c) => [c.id, c])) : list;
  };
  const corners = (a, b) => { const p = coordsOf(a), q = coordsOf(b); if (!p || !q) throw new Error('AllCastles(fieldId1, fieldId2)'); return [p, q]; };
  const getX = (v) => { const c = coordsOf(v); return c ? c.x : null; };
  const getY = (v) => { const c = coordsOf(v); return c ? c.y : null; };
  const getLevel = async (v) => { const f = fieldIdOf(v); const t = f === null ? null : await oneTile(ctx, f); return t && t.level !== undefined && t.level !== null ? Number(t.level) : null; };
  const getType = async (v) => { const f = fieldIdOf(v); const t = f === null ? null : await oneTile(ctx, f); return t ? t.type : null; };
  const getFieldId = (a, b) => fieldIdOf(a, b);

  const g = {
    ...consts,
    ...math,
    Math: MathObj,
    String: StringFn,
    Number: (v) => (v instanceof Date ? v.getTime() : Number(v)),
    parseInt: (s, radix) => parseInt(toText(s), radix === undefined ? undefined : int(radix)),
    parseFloat: (s) => parseFloat(toText(s)),
    isNaN: (v) => Number.isNaN(num(v)),
    isFinite: (v) => Number.isFinite(num(v)),

    CenterPad: centerPad, LeftPad: leftPad, RightPad: rightPad, StringRepeat: stringRepeat,
    Merge: merge, Upper1: upper1, StringToObject: stringToObject, ToCSV: toCSV,
    FormatNumber: formatNumber, FormatNumber2: formatNumber2, FormatPercent: formatPercent, FormatMiles: formatMiles,

    ParseInteger: parseInteger,
    PrepareParameters: prepareParameters,
    GetResources: (s) => { const r = parseResourceText(s); return r ? resourceBean(r) : null; },

    date: (...a) => makeDate(now(), a),
    TimeDiff: (t, from) => num(t) - (from === undefined || from === null ? now() : num(from)),

    json_encode: jsonEncode,
    json_decode: jsonDecode,
    xml,
    GetTroopsFromXML: troopsFromXml,
    GetFortsFromXML: fortsFromXml,
    GetResourcesFromXML: resourcesFromXml,

    GetFieldId: getFieldId,
    FieldIdToCoords: coordText,
    GetX: getX, GetY: getY, GetLevel: getLevel, GetType: getType, GetZoneName: zoneName,
    GetFieldType: fieldType, GetFieldName: fieldName,
    MapDistance: mapDistance,
    FormatDistance: (a, b) => formatMiles(mapDistance(a, b)),
    StateCoords: stateCoords,
    StateName: stateName,
    FindField: (x, y, r, type, level) => findField(ctx, x, y, r, type, level),
    CastlesInRectangle: rect,
    AllCastles: async (a, b, omitNpc) => { const [p, q] = corners(a, b); return rect(p.x, p.y, q.x, q.y, omitNpc); },
    MapCastles: async (x, y, r) => {
      const c = coordsOf(x, y), rr = num(r);
      if (!c || !Number.isFinite(rr)) throw new Error('MapCastles(x, y, radius)');
      return (await rect(c.x - rr, c.y - rr, c.x + rr, c.y + rr)).filter((b) => C.mapDistance(c, b) <= rr + 1e-9);
    },
    SearchEnemyCastles: (n) => searchEnemyCastles(ctx, n),
    GetDetailInfo: detail,
    UpdateDetailInfo: update,
    RelationIndex: (bean) => relationIndex(ctx, bean),
    ResetMap: (x, y, a, b) => resetMap(ctx, x, y, a, b),
    getTravelTime: (from, to, troops, type) => travelTime(ctx, from, to, troops, type),

    setCityTimer: (key) => cityTimers.set(castleKey(ctx), key),
    cityTimingAllowed: (key, seconds, test = false) => cityTimers.allowed(castleKey(ctx), key, seconds, test === true),
  };
  // the older spellings NEAT renamed over the versions
  Object.assign(g, {
    getResources: g.GetResources, stateName: g.StateName, updateDetailInfo: g.UpdateDetailInfo,
    fieldIdToCompareString: g.FieldIdToCoords, FieldIdToCompareString: g.FieldIdToCoords,
    getX: g.GetX, getY: g.GetY, getLevel: g.GetLevel, getType: g.GetType, getZoneName: g.GetZoneName,
    CastleInRectangle: g.CastlesInRectangle,
  });
  return g;
}

module.exports = {
  globals, readOnly,
  // pure helpers, for the evaluator and the command modules
  num, toText, roundTo, formatNumber, formatMiles, parseInteger, prepareParameters, parseResourceText,
  jsonEncode, jsonDecode, xml, coordsOf, fieldIdOf, stateName, stateCoords, fieldType, fieldName,
  ScriptDate, as3DateString, ABBREVIATIONS, SPEED_UP_ITEMS, PLAYER_STATE, botInfo, cityTimers,
  // the map, for tests and other modules (script-cmd-info.js: rescanmap/rescanrec, findfield)
  setMapCache, mapTiles, tileBean, resetMap,
};
