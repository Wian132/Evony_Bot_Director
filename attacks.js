'use strict';
// What counts as an ATTACK: the one junk rule every warning reads.
//
// defensepolicy's /junktroop has always kept small attacks out of the defence
// goals (goalmods.js defensePlan, goal-war.js threatsOf, engine.js
// defenceLines, the script's NumberOfRealAttacks). The warnings did not read it:
// the console's red city tab and flashing Incoming icon and the Director's
// "under attack" lit up for any hostile army at all, a 1-troop scout included.
// The user, 2026-09-28: "if junktroop is 1000 and 999 troops are incoming, no
// animation nothing should display ... junktroop applies per attack". So the
// warnings, the Director's attack view and the Claude waker all ask this file,
// and the rule is written once:
//
//   * a city's line is its defensepolicy /junktroop, 1000 when the city has no
//     defensepolicy line or the line sets no /junktroop (NEAT's default);
//     /junktroop:0 means every attack counts
//   * it is applied to each inbound army on its own, never to a city's total
//   * an army whose size is UNKNOWN (not scouted, "?" per type, or only some
//     types readable) counts as real: its size is unknown, not small, and
//     assuming junk would be the dangerous default
const DEF_JUNK = 1000;

// A city's junk line from its parsed goals ([{ name, switches }]).
function junkLineOf(goals) {
  const dp = (goals || []).find((x) => x && x.name === 'defensepolicy');
  const v = dp && dp.switches ? dp.switches.junktroop : undefined;
  if (v === undefined || v === null || v === true || v === '') return DEF_JUNK;
  const j = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(j) && j >= 0 ? j : DEF_JUNK;
}

// An inbound army's size, from the engine's flat total or a raw TroopStrBean.
// An unscouted army sends "?" per type, so its size is UNKNOWN (null).
function armySize(a) {
  if (!a) return null;
  const t = a.troops !== undefined ? a.troops : a.troop;
  if (t === null || t === undefined) return null;
  if (typeof t === 'object') {
    let sum = 0, any = false;
    for (const v of Object.values(t)) {
      const s = String(v ?? '').trim().replace(/[,\s]/g, '');
      if (/^\d+$/.test(s)) { sum += parseInt(s, 10); any = true; } else if (v !== undefined && v !== null) return null;
    }
    return any ? sum : null;
  }
  if (a.known === false) return null;   // a partial total: some types were "?"
  const s = String(t).trim().replace(/[,\s]/g, '');
  return /^\d+$/.test(s) ? parseInt(s, 10) : null;
}

// Is this one army an attack under that line? (size unknown counts)
function isRealAttack(a, junkLine = DEF_JUNK) {
  const s = armySize(a);
  return s === null || s >= junkLine;
}

// A key that stays the same for one army across polls: the server's armyId,
// else where it comes from and when it lands.
function attackKey(a) {
  if (!a) return '';
  if (a.armyId !== undefined && a.armyId !== null && a.armyId !== '') return String(a.armyId);
  return `${a.from || a.startPosName || a.king || '?'}@${a.reachTime || '?'}`;
}

// A city's inbound armies split by its goals' line:
// { junkLine, real: [armies], junk: [armies] }.
function realAttacks(list, goals) {
  const junkLine = junkLineOf(goals);
  const real = [], junk = [];
  for (const a of list || []) (isRealAttack(a, junkLine) ? real : junk).push(a);
  return { junkLine, real, junk };
}

module.exports = { DEF_JUNK, junkLineOf, armySize, isRealAttack, attackKey, realAttacks };
