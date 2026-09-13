'use strict';
// One snapshot shape, built from a live Game.
//
// The Director builds one by logging in and out; a console builds one from the
// session it is already holding. Before this was shared, only the Director could
// produce snapshots — which meant the accounts you actually RUN had no history
// at all, because the Director skips any account a console owns.
const n = (x) => Number(x || 0);

function buildSnapshot(g, extra = {}) {
  const p = g.player || {};
  const info = p.playerInfo || {};
  const totals = { food: 0, wood: 0, stone: 0, iron: 0, gold: 0, population: 0, maxPopulation: 0 };
  let troops = 0, heroes = 0, walls = 0;
  for (const c of g.castles || []) {
    const r = c.resource || {};
    totals.food += n(r.food && r.food.amount); totals.wood += n(r.wood && r.wood.amount);
    totals.stone += n(r.stone && r.stone.amount); totals.iron += n(r.iron && r.iron.amount);
    totals.gold += n(r.gold);
    totals.population += n(r.curPopulation); totals.maxPopulation += n(r.maxPopulation);
    troops += Object.values(c.troop || {}).reduce((s, v) => s + n(v), 0);
    heroes += (c.heros || []).length;
    walls += Object.values(c.fortification || {}).reduce((s, v) => s + n(v), 0);
  }

  // Troops that are out on a march are not in any city's troop block, so a
  // snapshot taken while farming otherwise looks like the army shrank.
  let marchingTroops = 0;
  for (const a of p.selfArmys || []) {
    const t = a.troop || a.troops || {};
    if (t && typeof t === 'object') {
      for (const v of Object.values(t)) { const x = n(v); if (Number.isFinite(x)) marchingTroops += x; }
    }
  }

  return {
    at: Date.now(), ok: true, error: null,
    lord: info.userName, alliance: info.alliance || null,
    prestige: n(info.prestige), honor: n(info.honor), rank: n(info.ranking),
    title: info.title || info.titleId, cities: (g.castles || []).length,
    // the client calls these "cents / game coins"; the protocol field is `medal`
    coins: n(info.medal), lastLoginTime: n(info.lastLoginTime),
    totals, troops: troops + marchingTroops, garrisonTroops: troops, marchingTroops,
    heroes, walls,
    incoming: (p.enemyArmys || []).length,      // "on wars"
    marching: (p.selfArmys || []).length,
    furlough: !!p.furlough,
    items: Object.fromEntries((p.items || []).map((i) => [i.id, i.count])),
    cityList: (g.castles || []).map((c) => {
      const xy = (g.castleXY && g.castleXY(c)) || {};
      return { name: c.name, x: xy.x, y: xy.y, troops: Object.values(c.troop || {}).reduce((s, v) => s + n(v), 0) };
    }),
    ...extra,
  };
}

// What our own armies are doing right now. Read-only; the fields come straight
// off ArmyBean.
function marches(g) {
  const C = require('./constants');
  const MISSION_NAME = Object.fromEntries(Object.entries(C.MISSION).map(([k, v]) => [v, k]));
  return ((g.player && g.player.selfArmys) || []).map((a) => {
    const troop = a.troop || a.troops || {};
    const units = {};
    let total = 0;
    if (troop && typeof troop === 'object') {
      for (const [k, v] of Object.entries(troop)) {
        const x = Number(v);
        if (Number.isFinite(x) && x > 0) { units[k] = x; total += x; }
      }
    }
    const res = a.resource || {};
    const loot = {};
    let lootTotal = 0;
    for (const k of ['food', 'wood', 'stone', 'iron', 'gold']) {
      const x = Number(res[k] || 0);
      if (x > 0) { loot[k] = x; lootTotal += x; }
    }
    return {
      id: a.id, armyId: a.armyId,
      missionType: Number(a.missionType),
      mission: MISSION_NAME[Number(a.missionType)] || String(a.missionType),
      state: a.state, stateName: a.stateName,
      from: a.startPosName, to: a.targetPosName,
      startFieldId: Number(a.startFieldId), targetFieldId: Number(a.targetFieldId),
      target: Number.isFinite(Number(a.targetFieldId)) ? C.fieldIdToCoords(Number(a.targetFieldId)) : null,
      // ArmyBean.hero is a STRING (the name), with heroLevel beside it — there is
      // no hero object and no heroId. Reading a.hero.name gives undefined, which
      // is why every march showed a blank hero.
      hero: typeof a.hero === 'string' ? a.hero : (a.hero && a.hero.name) || null,
      heroLevel: Number(a.heroLevel || 0),
      startTime: Number(a.startTime || 0), reachTime: Number(a.reachTime || 0),
      units, troopTotal: total,
      loot, lootTotal,
    };
  });
}

// Armies heading AT us. ArmyBean.troop is a TroopStrBean of STRINGS, and an
// unscouted army sends "?" — reading it as numbers makes every real attack look
// like nothing, which is a mistake this codebase has already made once.
// "Incoming" means armies OTHER people are sending at us, hostile or not. The
// server splits those across two lists: enemyArmys for attacks and scouts, and
// friendArmys for reinforcements and resource transports from allies. Reading
// only the enemy list left Incoming permanently empty for everything friendly.
//
// Our OWN marches are not incoming, whichever way they are pointing — they are
// what is sitting in the rally spot, and they belong on the Armies tab.
function incomingArmies(g) {
  const C = require('./constants');
  const MISSION_NAME = Object.fromEntries(Object.entries(C.MISSION).map(([k, v]) => [v, k]));
  const mine = new Map((g.castles || []).map((c) => [Number(c.fieldId), c.name]));
  const p = g.player || {};
  const hostile = new Set((p.enemyArmys || []).map((a) => a));

  return [...(p.enemyArmys || []), ...(p.friendArmys || [])].map((a) => {
    const troop = a.troop || a.troops || {};
    const units = {};
    let known = true, total = 0;
    if (troop && typeof troop === 'object') {
      for (const [k, v] of Object.entries(troop)) {
        const raw = String(v);
        if (raw === '?' || raw === '') { known = false; units[k] = '?'; continue; }
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) { units[k] = n; total += n; }
      }
    }
    const target = Number(a.targetFieldId);
    return {
      missionType: Number(a.missionType),
      mission: MISSION_NAME[Number(a.missionType)] || String(a.missionType),
      from: a.startPosName, to: a.targetPosName || mine.get(target) || null,
      startFieldId: Number(a.startFieldId), targetFieldId: target,
      origin: Number.isFinite(Number(a.startFieldId)) ? C.fieldIdToCoords(Number(a.startFieldId)) : null,
      target: Number.isFinite(target) ? C.fieldIdToCoords(target) : null,
      hero: a.hero || null, heroLevel: Number(a.heroLevel || 0),
      alliance: a.alliance, king: a.king,
      startTime: Number(a.startTime || 0), reachTime: Number(a.reachTime || 0),
      units, troopTotal: total, scouted: known,
      myCity: mine.get(target) || null,
      hostile: hostile.has(a),
      resources: (() => {
        const r = a.resource || {};
        const out = {};
        for (const k of ['food', 'wood', 'stone', 'iron', 'gold']) {
          const v = Number(r[k] || 0);
          if (v > 0) out[k] = v;
        }
        return out;
      })(),
    };
  });
}

module.exports = { buildSnapshot, marches, incomingArmies };
