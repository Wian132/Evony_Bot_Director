'use strict';
// The buffs an account and its cities are under, and what protection they add
// up to. The game sends them as { typeId, descName, endTime }: `typeId` is a
// name like "FurloughBuff" (view/castle/PLayerBuffConstants.as and the cases in
// PlayerBuffUI.as), `descName` the sentence the game's own client shows, which
// is often empty, and `endTime` an epoch in ms.
//
// The account's protection never reaches the castle's `status` field — a lord on
// holiday still has status 0 (Normal) on every city — so it is read from the
// buffs, the way the client and NEAT both do it (MainFrame.as:362,
// PlayerInfoWin.as:1694, StopWar.as:495).

// Short names for the types worth naming. The game's own sentence (descName)
// wins when it sends one; this is the fallback, and the label the status row
// uses. Anything unknown is prettified from its typeId.
const NAMES = {
  FurloughBuff: 'Holiday mode',
  PlayerPeaceBuff: 'Peace',
  PlayerPeaceUniteServerBuff: 'Peace (server merge)',
  TruceAgreementBuff: 'Truce',
  DreamTruceBuff: 'Dream Truce',
  PlayerPeaceCoolDownBuff: 'Truce cooldown',
  PlayerNoPeaceBuff: 'No peace',
  StopTroopsUpkeepBuff: 'No troop upkeep',
  ReduceTroopsUpkeepBuff: 'Reduced troop upkeep',
  ReduceTroopsUpkeepBuff2: 'Reduced troop upkeep',
  DoubleResourceBuff: 'Double resources',
  ReduceArmyActionBuff: 'Faster marches',
  PlayerIncArmyAttachBuff: 'Attack bonus',
  PlayerIncArmyDefenceBuff: 'Defence bonus',
  IncFoodProduceBuff: 'More food',
  IncWoodProduceBuff: 'More wood',
  IncStoneProduceBuff: 'More stone',
  IncIronProduceBuff: 'More iron',
  IncGoldProduceBuff: 'More gold',
  TroopReliveBuff: 'Troop revival',
  KeepSilenceBuff: 'Silenced',
  RemovingSecurityCodeBuff: 'Security code removed',
  ForceopenclosegateBuff: 'Gates forced',
};

// The protection buffs, strongest first: the one a city's status shows.
const PROTECTION = [
  { type: 'FurloughBuff', kind: 'holiday', label: 'Holiday mode' },
  { type: 'DreamTruceBuff', kind: 'dreamtruce', label: 'Dream Truce' },
  { type: 'TruceAgreementBuff', kind: 'truce', label: 'Truce' },
  { type: 'PlayerPeaceBuff', kind: 'peace', label: 'Peace' },
  { type: 'PlayerPeaceUniteServerBuff', kind: 'peace', label: 'Peace (server merge)' },
];

const spaced = (t) => String(t).replace(/Buff\d*$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
const nameOf = (type) => NAMES[type] || (type ? spaced(type).replace(/^./, (c) => c.toUpperCase()) : 'Buff');

// "9h29m", "4d 3h", "55m29s" — the way the game's own Buffs tab reads.
function leftText(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'expired';
  const s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m${String(sec).padStart(2, '0')}s`;
}

// One buff as the console shows it. `now` is the SERVER clock: endTime is the
// server's, so this machine's clock would be wrong by the offset.
function view(b, now) {
  const type = String((b && b.typeId) || '');
  const endTime = Number((b && b.endTime) || 0);
  const msLeft = endTime ? endTime - now : null;
  return {
    type,
    name: nameOf(type),
    text: String((b && b.descName) || '').trim() || nameOf(type),
    endTime: endTime || null,
    msLeft,
    left: msLeft === null ? 'no end' : leftText(msLeft),
    expired: msLeft !== null && msLeft <= 0,
  };
}

const list = (arr, now) => (Array.isArray(arr) ? arr : []).map((b) => view(b, now)).filter((b) => b.type && !b.expired);

// Every buff the console can show: the account's, and each city's own.
// { player: [...], cities: { <castleId>: [...] }, protection }
function active(game) {
  if (!game || !game.player) return { player: [], cities: {}, protection: null };
  const now = typeof game.now === 'function' ? game.now() : Date.now();
  const player = list(game.player.buffs, now);
  const cities = {};
  for (const c of game.castles || []) {
    const id = game.castleId ? game.castleId(c) : c.id;
    const own = list(c.buffs, now);
    if (own.length) cities[String(id)] = own;
  }
  return { player, cities, protection: protectionOf(game, player, now) };
}

// What the account is protected by, or null. The login's own answer (ok=-100,
// game.holiday) counts too: it says holiday even in the moment before the buff
// list arrives.
function protectionOf(game, playerBuffs, now) {
  // the SERVER clock when there is one: endTime is the server's
  const at = now || (game && typeof game.now === 'function' ? game.now() : Date.now());
  const buffs = playerBuffs || list(game && game.player ? game.player.buffs : [], at);
  for (const p of PROTECTION) {
    const hit = buffs.find((b) => b.type === p.type);
    if (hit) return { kind: p.kind, label: p.label, type: p.type, msLeft: hit.msLeft, left: hit.left, text: hit.text };
  }
  if (game && game.holiday) {
    const ms = ((game.holiday.hours || 0) * 60 + (game.holiday.minutes || 0)) * 60000;
    return { kind: 'holiday', label: 'Holiday mode', type: 'FurloughBuff', msLeft: ms, left: game.holiday.text, text: 'Holiday mode' };
  }
  return null;
}

module.exports = { active, protectionOf, view, leftText, nameOf, NAMES, PROTECTION };
