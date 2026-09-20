'use strict';
// The account's SECURITY CODE — the game's second password.
//
// A player sets one in Player Info; it then guards the handful of actions that
// cannot be undone. The whole protocol is in the decompiled client
// (com/evony/client/action/SecurityCommands.as and view/module/playerInfo/*):
//
//   1. The command is sent NORMALLY, with no code on it.
//   2. If that action is protected and this session has not unlocked it, the
//      server answers `ok = -200` (ErrorCode.NEED_SECURITY_CODE_ERROR:229) and
//      does nothing. It is a refusal, not a failure — nothing was spent, lost
//      or changed.
//   3. The client then authenticates the code once per session
//      (`common.authSecurityCode {code}` — ApplySecurityCode.as:437) and
//      unlocks either that one operation or all five
//      (`common.setUnlockOption {option}` — UnlockSecurityCode.as:278-282).
//   4. It RE-SENDS the original command, which now goes through
//      (UnlockSecurityCode.onResponse calls giveUpCastle() again, and so on).
//
// The unlock lasts the session only — the client's own window says so: "Will
// only be effective during this session and will end at logout." So a reconnect
// starts locked again, which is why the unlocked mask lives on the Game and
// dies with it.
//
// Which actions are protected is the player's choice, a bitmask set in the
// Security Code window (SetSecurity.as:638-661) and read back with
// `common.getProtectOption` -> {option}. Bit 1 (Restart game) is checked and
// DISABLED in that window: it cannot be switched off.
const OPTIONS = [
  { bit: 1, key: 'restart', label: 'Restart game', cmd: 'common.deleteUserAndRestart', what: 'deleting the lord and starting over' },
  { bit: 2, key: 'abandon', label: 'Abandon cities', cmd: 'city.giveupCastle', what: 'giving a city up' },
  { bit: 4, key: 'disband', label: 'Dismiss armies', cmd: 'troop.disbandTroop', what: 'disbanding troops' },
  { bit: 8, key: 'heroes', label: 'Dismiss heroes', cmd: 'hero.fireHero', what: 'dismissing a hero' },
  { bit: 16, key: 'tax', label: 'Adjust tax rate', cmd: 'interior.modifyTaxRate', what: 'changing the tax rate' },
];
const ALL = 31;                                  // 1|2|4|8|16, the client's "Unlock All Operation"
const NEED_CODE = -200;                          // ErrorCode.NEED_SECURITY_CODE_ERROR

const byCmd = new Map(OPTIONS.map((o) => [o.cmd, o]));
const byKey = new Map(OPTIONS.map((o) => [o.key, o]));

// Which of the five a protect-option bitmask covers, in the game's own words.
function optionsIn(mask) {
  const m = Number(mask) || 0;
  return OPTIONS.filter((o) => (m & o.bit) === o.bit);
}

// `protectOption` as the Security Code window would read it back.
const describeMask = (mask) => {
  const on = optionsIn(mask);
  return on.length ? on.map((o) => o.label).join(', ') : 'nothing';
};

// hero.releaseHero is deliberately absent: only HERO_FIRE_HERO carries the -200
// branch in the client (HeroProperties.as:2007), so a release is not one of the
// protected five. Releasing a captured hero loses it — that is guarded by the
// bot's own rules, not by the game's code.
const isProtectedCmd = (cmd) => byCmd.has(cmd);

// Authenticate the code, then unlock. Both steps are needed the first time in a
// session; afterwards the auth is remembered by the server and only the unlock
// for a not-yet-unlocked operation is sent — the client keeps exactly this
// split with Context.bLoginSecurityCode.
async function unlock(game, bit, { code, log = () => {}, all = false } = {}) {
  if (!code) {
    return { ok: false, why: 'no security code is stored for this account — set one with:  securitycode set <code>' };
  }
  const want = all ? ALL : Number(bit);
  if (!game._secAuthed) {
    // common.authSecurityCode {code} (SecurityCommands.as:47-59)
    const a = await game.req('common.authSecurityCode', { code });
    if (!a || a.ok !== 1) {
      return { ok: false, why: `the game refused the security code (${(a && (a.errorMsg || a.ok)) || 'no answer'})`, reply: a };
    }
    game._secAuthed = true;
    log('  security code accepted');
  }
  // common.setUnlockOption {option} (SecurityCommands.as:118-128)
  const u = await game.req('common.setUnlockOption', { option: want });
  if (!u || u.ok !== 1) {
    return { ok: false, why: `the game would not unlock ${describeMask(want)} (${(u && (u.errorMsg || u.ok)) || 'no answer'})`, reply: u };
  }
  game._secUnlocked = (Number(game._secUnlocked) || 0) | want;
  log(`  security code unlocked ${describeMask(want)} for this session`);
  return { ok: true, unlocked: want };
}

// Send a command that MAY be protected, answering a -200 by unlocking and
// sending it once more. The first send carries no code at all, exactly as the
// client's does: an account with no security code, or one that does not protect
// this action, never sees the extra round trip.
//
// The retry happens ONCE. A second -200 means the unlock did not take, and
// sending a third time would only hammer a refusal.
async function sendProtected(game, cmd, data, { code, log = () => {}, timeout } = {}) {
  const first = timeout === undefined ? await game.req(cmd, data) : await game.req(cmd, data, timeout);
  if (!first || first.ok !== NEED_CODE) return first;
  const o = byCmd.get(cmd);
  const bit = o ? o.bit : ALL;
  log(`  the game wants this account's security code before ${o ? o.what : cmd} — nothing was done yet`);
  const un = await unlock(game, bit, { code, log });
  if (!un.ok) {
    // Hand the caller back the refusal it already has, with the reason the
    // unlock failed on it, so nothing downstream mistakes -200 for success.
    return { ...first, securityCode: un.why };
  }
  log('  sending it again now the code is unlocked');
  return timeout === undefined ? await game.req(cmd, data) : await game.req(cmd, data, timeout);
}

// What the live account actually protects: `common.getProtectOption` -> {option}
// (SecurityCommands.as:131-141). `isSetSecurityCode` arrives with the login on
// PlayerBean, so whether a code exists at all is known without asking.
async function readProtection(game) {
  const set = !!(game.player && game.player.isSetSecurityCode);
  let option = null, err = null;
  try {
    const r = await game.req('common.getProtectOption', {});
    if (r && r.ok === 1) option = Number(r.option) || 0;
    else err = (r && (r.errorMsg || `ok=${r.ok}`)) || 'no answer';
  } catch (e) { err = e.message; }
  return { isSet: set, option, protects: option === null ? null : optionsIn(option), error: err };
}

module.exports = { OPTIONS, ALL, NEED_CODE, optionsIn, describeMask, isProtectedCmd, unlock, sendProtected, readProtection, byKey, byCmd };
