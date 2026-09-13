'use strict';
// The account's inventory as the console lists it: every item held, named, and
// filed under the game's own categories with the medals kept apart.
//
// The names come from the item catalogue. The client ships it as an XML asset
// (GetDataXML_XMLItem, read by com/evony/eum/ItemEumDefine.as), and WarReport.swf
// embeds the same table. extract-items.js copies it out to itemcatalog.json,
// which stays local like src/: it is the game's data, not ours to publish.
// Items added after that build come from the server's common.getItemDefXml,
// dumped to itemdefs.json, and those win where both know an id. With neither
// file, every item still lists, under its raw id.
const fs = require('fs');
const path = require('path');

const CATALOGUE = path.join(__dirname, 'itemcatalog.json');
const SERVER_DEFS = path.join(__dirname, 'itemdefs.json');

// ItemEum.itemType -> the tab MyTreasure.as files it under, in the English of
// the client's Lang table. The game calls 宝物 "Items"; here it is "General",
// so the list does not read Items > Items.
const CATEGORY = {
  '宝物': 'General', '加速': 'Speed Up', '生产': 'Produce', '宝箱': 'Chest',
  '奖章': 'Medal', '计谋': 'Stratagem', '材料': 'Material', '任务': 'Quest',
};

// CommonConstants.ITEM_TYPE_MEDAL is 奖章, and the only items of that type are
// the nine hero-loyalty medals. They are named here too, so they still sort as
// medals without the catalogue.
const MEDAL_TYPE = '奖章';
const MEDALS = {
  'hero.loyalty.1': 'Cross Medal', 'hero.loyalty.2': 'Rose Medal', 'hero.loyalty.3': 'Lion Medal',
  'hero.loyalty.4': 'Honor Medal', 'hero.loyalty.5': 'Courage Medal', 'hero.loyalty.6': 'Wisdom Medal',
  'hero.loyalty.7': 'Freedom Medal', 'hero.loyalty.8': 'Justice Medal', 'hero.loyalty.9': 'Nation Medal',
};

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] !== '#') return ENT[e] === undefined ? m : ENT[e];
  const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return Number.isFinite(n) ? String.fromCodePoint(n) : m;
});

// <itemEum id=".." name=".." itemType=".." desc=".." .../> -> id -> {name, type, desc}
function parseItemXml(xml) {
  const out = new Map();
  for (const tag of String(xml || '').match(/<itemEum\b[^>]*>/g) || []) {
    const a = {};
    for (const m of tag.matchAll(/(\w+)="([^"]*)"/g)) a[m[1]] = unxml(m[2]);
    if (a.id) out.set(a.id, { name: (a.name || '').trim(), type: a.itemType || '', desc: (a.desc || a.itemDesc || '').trim() });
  }
  return out;
}

// Re-read only when one of the two files changes, so a fresh extract shows up
// without a console restart.
let cache = null;
function catalogue() {
  const stamp = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  const key = `${stamp(CATALOGUE)}:${stamp(SERVER_DEFS)}`;
  if (cache && cache.key === key) return cache.map;
  const map = new Map();
  try {
    for (const [id, d] of Object.entries(JSON.parse(fs.readFileSync(CATALOGUE, 'utf8')).items || {})) map.set(id, d);
  } catch { /* not extracted yet */ }
  try {
    for (const [id, d] of parseItemXml(JSON.parse(fs.readFileSync(SERVER_DEFS, 'utf8')).itemXml)) map.set(id, d);
  } catch { /* never fetched */ }
  cache = { key, map };
  return map;
}

// Everything held, one row per item id. Order is the console's to choose.
function inventory(game, cat = catalogue()) {
  const rows = [];
  for (const it of (game && game.player && game.player.items) || []) {
    const count = Number((it && it.count) || 0);
    if (!it || it.id === undefined || it.id === null || count <= 0) continue;
    const id = String(it.id);
    const d = cat.get(id) || {};
    const medal = d.type === MEDAL_TYPE || id in MEDALS;
    rows.push({
      id, count, medal,
      name: d.name || MEDALS[id] || id,
      category: medal ? 'Medal' : CATEGORY[d.type] || 'Other',
      desc: d.desc || '',
    });
  }
  return { items: rows, named: cat.size > 0 };
}

module.exports = { CATEGORY, MEDALS, parseItemXml, catalogue, inventory, CATALOGUE };
