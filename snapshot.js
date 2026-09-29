'use strict';
// One snapshot shape, built from a live Game.
//
// The Director builds one by logging in and out; a console builds one from the
// session it is already holding. Before this was shared, only the Director could
// produce snapshots — which meant the accounts you actually RUN had no history
// at all, because the Director skips any account a console owns.
const n = (x) => Number(x || 0);

function buildSnapshot(g, extra = {}) {
  // Names of the traininghero goal line(s) this account runs, lowercased, so a
  // city it is currently standing in isn't called "full" below — passed apart
  // from `extra` since it belongs on cityList, not the top-level snapshot.
  const { trainingHeroNames, ...rest } = extra;
  const wantedHero = new Set((trainingHeroNames || []).map((x) => String(x).toLowerCase()));
  const p = g.player || {};
  const info = p.playerInfo || {};
  const totals = { food: 0, wood: 0, stone: 0, iron: 0, gold: 0, population: 0, maxPopulation: 0, idlePopulation: 0 };
  let troops = 0, heroes = 0, walls = 0;
  // Each troop type on its own, garrison and marching together (the Director's
  // per-type columns: the user, 2026-09-29, "Catapults, Scouts or any troop").
  const troopTypes = {};
  const addTypes = (t) => {
    for (const [k, v] of Object.entries(t || {})) { const x = n(v); if (Number.isFinite(x) && x) troopTypes[k] = (troopTypes[k] || 0) + x; }
  };
  for (const c of g.castles || []) {
    addTypes(c.troop);
    const r = c.resource || {};
    totals.food += n(r.food && r.food.amount); totals.wood += n(r.wood && r.wood.amount);
    totals.stone += n(r.stone && r.stone.amount); totals.iron += n(r.iron && r.iron.amount);
    totals.gold += n(r.gold);
    totals.population += n(r.curPopulation); totals.maxPopulation += n(r.maxPopulation);
    totals.idlePopulation += idleOf(r);
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
      addTypes(t);
    }
  }

  return {
    at: Date.now(), ok: true, error: null,
    lord: info.userName, alliance: info.alliance || null,
    prestige: n(info.prestige), honor: n(info.honor), rank: n(info.ranking),
    title: info.title || info.titleId, cities: (g.castles || []).length,
    // the client calls these "cents / game coins"; the protocol field is `medal`
    coins: n(info.medal), lastLoginTime: n(info.lastLoginTime),
    totals, troops: troops + marchingTroops, garrisonTroops: troops, marchingTroops, troopTypes,
    heroes, walls,
    incoming: (p.enemyArmys || []).length,      // incoming waves
    marching: (p.selfArmys || []).length,
    furlough: !!p.furlough,
    items: Object.fromEntries((p.items || []).map((i) => [i.id, i.count])),
    cityList: (g.castles || []).map((c) => {
      const xy = (g.castleXY && g.castleXY(c)) || {};
      // each city's own stock, for the Director's hourly resource record
      const r = c.resource || {};
      const amt = (k) => n(r[k] && r[k].amount);
      const roster = c.heros || [];
      return { name: c.name, x: xy.x, y: xy.y, troops: Object.values(c.troop || {}).reduce((s, v) => s + n(v), 0),
        id: c.id, food: amt('food'), wood: amt('wood'), stone: amt('stone'), iron: amt('iron'), gold: n(r.gold),
        // Heroes per city, so the Director can see a city with none (nothing
        // trains, no mayor) or one packed to its hall's limit (the training hero
        // cannot get in). Prisoners hold slots but are not ours, so they are
        // counted apart.
        heroes: roster.length,
        // Idle population: what the barracks would draw on. A city whose idle
        // stays near its maximum is not training (the Director's Idle pop column).
        population: n(r.curPopulation), maxPopulation: n(r.maxPopulation), idle: idleOf(r),
        captives: roster.filter((h) => n(h.status) === CAPTIVE).length,
        // A city packed to ten still isn't a bottleneck if one of the ten can
        // insta-train anything anyway (1526+ attack), or if the traininghero
        // itself is the one sitting in the tenth slot — director.html's "full"
        // badge drops a city that trips either of these.
        hasInstaHero: roster.some((h) => n(h.power) >= 1526),
        hasTrainingHero: wantedHero.size > 0 && roster.some((h) => wantedHero.has(String(h.name || '').toLowerCase())) };
    }),
    // Every prisoner the account holds, for the Director's highlight and for
    // anyone reading the fleet: {city, id, name, level, at}.
    captives: captivesOf(g),
    // This account's OWN heroes, id and name, so db.fleetHeroes can remember
    // them: a hero of ours captured by another of our accounts must never be
    // released by the console holding it. Prisoners are left out -- they are
    // someone else's heroes sitting in our cell.
    heroIds: ownHeroes(g),
    ...rest,
  };
}

// Population not on the fields (workPeople) and not tied up in construction
// (buildPeople) -- the same sum as session.city() and game.js's requirement check.
const idleOf = (r) => Math.max(0, n(r.curPopulation) - n(r.workPeople) - n(r.buildPeople));

// HeroConstants.as: 4 = a hero WE hold prisoner.
const CAPTIVE = 4;

// The prisoners this account holds, across all its cities.
function captivesOf(g) {
  const out = [];
  for (const c of g.castles || []) {
    for (const h of c.heros || []) {
      if (n(h.status) !== CAPTIVE) continue;
      out.push({ city: c.name, castleId: (g.castleId && g.castleId(c)) || c.id,
        id: h.id === undefined || h.id === null ? null : String(h.id),
        name: h.name || '', level: n(h.level) });
    }
  }
  return out;
}

// Our own heroes: everything on the roster that is not a prisoner.
function ownHeroes(g) {
  const out = [];
  for (const c of g.castles || []) {
    for (const h of c.heros || []) {
      if (n(h.status) === CAPTIVE) continue;
      if (h.id === undefined || h.id === null) continue;
      out.push({ id: String(h.id), name: h.name || '', level: n(h.level) });
    }
  }
  return out;
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
      // ArmyConstants.as: 1 forward, 2 backward, 3 stay (encamped)
      direction: { 1: 'out', 2: 'back', 3: 'camped' }[Number(a.direction)] || null,
      restTime: Number(a.restTime || 0),
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
// Our OWN marches are inbound too when they are on their way to one of our
// cities: a reinforcement or transport from another city lands there just as an
// ally's would, and neither server list carries it — only selfArmys does.
// Leaving them out showed "Nothing inbound" with Lord02's reinforcements on
// the road to Flat. Only while going (ArmyConstants.as: direction 1); one
// coming back is headed home, and that is the Armies tab's business.
function incomingArmies(g) {
  const C = require('./constants');
  const MISSION_NAME = Object.fromEntries(Object.entries(C.MISSION).map(([k, v]) => [v, k]));
  const mine = new Map((g.castles || []).map((c) => [Number(c.fieldId), c.name]));
  const p = g.player || {};
  const hostile = new Set((p.enemyArmys || []).map((a) => a));
  const own = new Set((p.selfArmys || []).filter((a) => Number(a.direction) === 1 && mine.has(Number(a.targetFieldId))));

  return [...(p.enemyArmys || []), ...(p.friendArmys || []), ...own].map((a) => {
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
      // the rest of the ArmyBean, for the Incoming tab's hover card
      armyId: a.armyId,
      direction: { 1: 'out', 2: 'back', 3: 'camped' }[Number(a.direction)] || null,
      restTime: Number(a.restTime || 0),
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
      hostile: hostile.has(a), own: own.has(a),
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
