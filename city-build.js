'use strict';
// Build-city marches (`deploy bu x,y ...`, missionType 4 ARMY_MISSION_CONSTRUCT)
// and `buildstatus`.
//
// The client allows a build only on a flat you hold (FieldInfoWin: isMineField
// && TYPE_FLAT), not while another build march is heading to that flat
// (checkIsBuilding), and only while titleId >= your city count
// (isFitCondition). So a Prinzessin (titleId 9) may build a tenth city, not an
// eleventh. That check counts cities only, never the build marches already on
// their way. Many marches sent with one slot open and landing in the same
// second is how the extra-cities trick goes over the limit (timed-march.js).
const C = require('./constants');
const TM = require('./timed-march');

const FLAT = 10;
const armies = (game) => (game.player && game.player.selfArmys) || [];
const isBuild = (x) => Number(x.direction) === 1 && Number(x.missionType) === C.MISSION.construct;

function titleSlots(game) {
  const info = (game.player && game.player.playerInfo) || {};
  const title = Number(info.titleId);
  const cities = (game.castles || []).length;
  return Number.isFinite(title) ? { title, max: title + 1, cities, open: title + 1 - cities } : { title: null, cities };
}

// Throws what the client (or the server) would refuse, so a line fails here
// rather than spending a march. Returns notes worth logging.
function preflight(game, fieldId) {
  const { x, y } = C.fieldIdToCoords(fieldId);
  let holder = null, field = null;
  for (const c of game.castles || []) {
    const f = (c.fields || []).find((v) => Number(v.id) === Number(fieldId));
    if (f) { holder = c; field = f; break; }
  }
  if (!field) throw new Error(`${x},${y} is not a flat you hold — capture it first; a city can only be built on your own flat`);
  if (Number(field.type) !== FLAT) {
    const t = C.FIELD_TYPES[Number(field.type)];
    throw new Error(`${x},${y} is your ${t ? t.name : 'type ' + field.type} L${field.level}, not a flat — cities go on flats only`);
  }
  if (armies(game).some((a) => isBuild(a) && Number(a.targetFieldId) === Number(fieldId))) {
    throw new Error(`a build march is already on its way to ${x},${y}`);
  }
  const s = titleSlots(game);
  if (s.title !== null && s.open < 1) {
    throw new Error(`no open city slot — your title allows ${s.max} cities and you have ${s.cities}. A build needs one slot open when it is sent`);
  }
  return [`flat L${Number(field.level) || 0}, held by ${holder.name}`
    + (s.title !== null ? ` · ${s.open} open city slot${s.open === 1 ? '' : 's'} (title allows ${s.max}, you have ${s.cities})` : '')];
}

// Every build march on its way, grouped by the second it lands in.
function status(game) {
  const out = [];
  const s = titleSlots(game);
  out.push(s.title !== null
    ? `cities: ${s.cities} of the ${s.max} your title allows (${Math.max(0, s.open)} open)`
    : `cities: ${s.cities}`);
  const byField = new Map();
  for (const c of game.castles || []) byField.set(Number(c.fieldId), c.name);
  const builds = armies(game).filter(isBuild).map((a) => {
    const to = C.fieldIdToCoords(Number(a.targetFieldId));
    return {
      a, to,
      from: byField.get(Number(a.startFieldId)) || a.startPosName || '?',
      landing: TM.landingOf(game, a),
    };
  }).sort((p, q) => (p.landing || 0) - (q.landing || 0));
  if (!builds.length) { out.push('no build marches on their way'); return out; }

  const groups = new Map();
  for (const b of builds) {
    const k = b.landing ? Math.floor(b.landing / 1000) : 'unknown';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }
  out.push(`${builds.length} build march${builds.length === 1 ? '' : 'es'} on the way, landing in ${groups.size} different second${groups.size === 1 ? '' : 's'}`
    + (groups.size > 1 ? ' — only marches that land together get round the city limit' : ''));
  for (const [k, list] of groups) {
    const ls = list.map((b) => b.landing).filter(Boolean);
    const gap = ls.length > 1 ? `, ${Math.max(...ls) - Math.min(...ls)} ms apart` : '';
    out.push(`  ${k === 'unknown' ? 'landing unknown' : TM.clock(k * 1000).slice(0, 8)} — ${list.length} march${list.length === 1 ? '' : 'es'}${gap}`);
    for (const b of list) {
      out.push(`    ${b.landing ? TM.clock(b.landing) : '?'}  ${String(b.from).padEnd(16)} -> ${b.to.x},${b.to.y}  hero ${b.a.hero || '-'}  army ${b.a.armyId}`);
    }
  }
  return out;
}

module.exports = { preflight, status, titleSlots };
