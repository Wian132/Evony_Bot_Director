'use strict';
// What a Claude woken for an attack is told about it (2026-09-28): each real
// army in detail, and what the city it lands on has to meet it with. The user:
// "{x incoming armies} with the incoming armies objects and attacking heroes and
// then city x has {x troops} {walldefense} and hero {x} (best attack hero) and
// best pol hero in the city, also how far the nearest other city of this
// account is". session.js underAttackView adds these to each city, so the
// Director (which only sees /api/session) can put them in the prompt.
//
// What the game gives: an inbound ArmyBean names its hero and the hero's level
// (ArmyBean.hero, heroLevel) but NOT the hero's attack or other stats; its
// troops come per type as strings, "?" when not scouted (TroopStrBean). The
// castle holds its home troops per type (castle.troop), its fortifications
// (castle.fortification: trap, abatis, arrowTower, rollingLogs, rockfall), its
// buildings (Walls = typeId 32) and its heroes (power = attack, management =
// politics, stratagem = intelligence; Game.attrValue: the field already holds
// allocated points).
const C = require('./constants');

const n = (x) => Number(x || 0);
const TROOP_KEYS = C.TROOPS.map((t) => t.key);
const CODE = Object.fromEntries(C.TROOPS.map((t) => [t.key, t.code]));
const MISSION_WORD = Object.fromEntries(Object.entries(C.MISSION).map(([k, v]) => [v, k]));

// { byType: {archer: 5000, …} (only types present; null = "?"), total: n|null }
function troopsOf(t) {
  if (!t || typeof t !== 'object') return { byType: {}, total: null };
  const byType = {};
  let total = 0, unknown = false;
  for (const k of TROOP_KEYS) {
    const v = t[k];
    if (v === undefined || v === null || v === '') continue;
    const s = String(v).trim().replace(/[,\s]/g, '');
    if (/^\d+$/.test(s)) { const c = parseInt(s, 10); if (c) { byType[k] = c; total += c; } }
    else { byType[k] = null; unknown = true; }
  }
  return { byType, total: unknown ? null : total };
}
// "a:5000 c:2000 s:?" — the script's own troop codes
const troopText = (byType) => Object.entries(byType || {}).map(([k, v]) => `${CODE[k] || k}:${v === null ? '?' : v}`).join(' ') || 'none';

// { byType: {trap: 1000, …} (only present ones), total }
function wallsOf(castle) {
  const f = (castle && castle.fortification) || {};
  const byType = {};
  let total = 0;
  for (const w of C.WALLS) { const v = n(f[w.beanKey]); if (v) { byType[w.beanKey] = v; total += v; } }
  return { byType, total };
}
const WALL_NAME = Object.fromEntries(C.WALLS.map((w) => [w.beanKey, w.name.toLowerCase()]));
const wallText = (byType) => Object.entries(byType || {}).map(([k, v]) => `${WALL_NAME[k] || k} ${v}`).join(', ') || 'none';

function wallLevel(castle) {
  const b = ((castle && castle.buildings) || []).find((x) => n(x.typeId) === 32);
  return b ? n(b.level) : null;
}

// A hero as the prompt names it.
function heroView(h, statusWord) {
  if (!h) return null;
  const st = Number(h.status);
  return { name: h.name, level: n(h.level), attack: n(h.power), politics: n(h.management), intel: n(h.stratagem),
    status: (statusWord && statusWord[st]) || `status ${h.status}` };
}
// The best attack and the best politics hero of the city (prisoners left out).
function bestHeroes(castle, statusWord) {
  const list = ((castle && castle.heros) || []).filter((h) => h && Number(h.status) !== 4);
  const top = (key) => list.reduce((b, h) => (!b || n(h[key]) > n(b[key]) ? h : b), null);
  return { bestAttack: heroView(top('power'), statusWord), bestPolitics: heroView(top('management'), statusWord) };
}

// The nearest OTHER city of the account, the short way round the wrapping map
// (C.mapDistance, as marches count it).
function nearestOther(castles, castle, xyOf) {
  const here = xyOf(castle);
  if (!here) return null;
  let best = null;
  for (const c of castles || []) {
    if (c === castle) continue;
    const xy = xyOf(c);
    if (!xy) continue;
    const d = C.mapDistance(here, xy);
    if (!best || d < best.tiles) best = { name: c.name, x: xy.x, y: xy.y, tiles: Math.round(d * 10) / 10 };
  }
  return best;
}

// The extra detail for one inbound army (the engine's inboundArmy shape, or a raw ArmyBean).
function armyDetail(a) {
  const raw = (a && a.raw) || a || {};
  const t = troopsOf(a.troop && typeof a.troop === 'object' ? a.troop : raw.troop);
  const sf = raw.startFieldId ?? a.startFieldId;
  const xy = sf !== undefined && sf !== null && Number.isFinite(Number(sf)) ? C.fieldIdToCoords(Number(sf)) : null;
  return {
    troop: t.byType,
    mission: MISSION_WORD[Number(raw.missionType ?? a.missionType)] || (raw.missionType ?? a.missionType ?? null),
    hero: raw.hero || a.hero || null,
    heroLevel: raw.heroLevel !== undefined ? n(raw.heroLevel) : null,
    fromXY: xy ? { x: xy.x, y: xy.y } : null,
  };
}

// What the city has to meet it with.
function cityDefence(game, castle, statusWord) {
  const xyOf = (c) => { try { return game.castleXY(c); } catch { return null; } };
  const troops = troopsOf(castle && castle.troop);
  const walls = wallsOf(castle);
  const xy = xyOf(castle);
  return {
    x: xy ? xy.x : null, y: xy ? xy.y : null,
    troops: { byType: troops.byType, total: troops.total },
    walls: { byType: walls.byType, total: walls.total, wallLevel: wallLevel(castle) },
    ...bestHeroes(castle, statusWord),
    nearest: nearestOther(game.castles, castle, xyOf),
  };
}

module.exports = { troopsOf, troopText, wallsOf, wallText, wallLevel, bestHeroes, heroView, nearestOther, armyDetail, cityDefence, MISSION_WORD };
