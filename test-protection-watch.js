'use strict';
// The protection watch (session.js checkProtection), offline.
//
// Why it exists: `game.holiday` is written in exactly one place — game.js, from
// the login reply's ok=-100 — so an account that goes on holiday while it is
// already logged in shows nothing on the Director's Status column until its
// console happens to reconnect. On 2026-09-23 five accounts went on holiday at
// 08:02-08:04 and four of them still had no badge at 08:12. The watch reads the
// buffs instead, which the server keeps current with PlayerBuffUpdate pushes.
const assert = require('assert');
const { Session } = require('./session');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const NOW = 1758000000000;
const buff = (typeId, minsLeft, descName = '') => ({ typeId, descName, endTime: NOW + minsLeft * 60000 });

// A Session far enough along to read protection off a Game, with the notes it
// writes captured instead of logged.
// `connected` is a getter on Session (a live, undestroyed socket), so the fake
// carries the socket it reads rather than the flag.
function session({ player = [], holiday = null, connected = true, auto = false, days = 0 } = {}) {
  const s = Object.create(Session.prototype);
  s.notes = [];
  s.note = (m) => s.notes.push(m);
  s.protection = null;
  s.game = {
    now: () => NOW,
    player: { playerInfo: { userName: 'Lord04' }, buffs: player, autoFurlough: auto, furloughDay: days },
    castles: [],
    holiday,
    c: { sock: { destroyed: !connected } },
  };
  return s;
}
const unplug = (s) => { s.game.c.sock.destroyed = true; };

t('a holiday begun while already logged in is seen, with no login and no game.holiday', () => {
  const s = session({ player: [buff('FurloughBuff', 2879)] });   // 2 days, as holiday-go sends
  assert.strictEqual(s.game.holiday, null, 'the login never said so — this is the case that was broken');
  const p = s.checkProtection();
  assert.strictEqual(p.kind, 'holiday');
  assert.strictEqual(p.label, 'Holiday mode');
  assert.strictEqual(p.left, '1d 23h');
  assert.strictEqual(s.protection.kind, 'holiday', 'and it is kept for the live view');
});

t('each protection the game gives is named', () => {
  const kinds = [
    ['FurloughBuff', 'holiday', 'Holiday mode'],
    ['DreamTruceBuff', 'dreamtruce', 'Dream Truce'],
    ['TruceAgreementBuff', 'truce', 'Truce'],
    ['PlayerPeaceBuff', 'peace', 'Peace'],
    ['PlayerPeaceUniteServerBuff', 'peace', 'Peace (server merge)'],
  ];
  for (const [type, kind, label] of kinds) {
    const p = session({ player: [buff(type, 90)] }).checkProtection();
    assert.strictEqual(p.kind, kind, type);
    assert.strictEqual(p.label, label, type);
  }
});

t('the strongest protection wins when more than one is running', () => {
  const s = session({ player: [buff('PlayerPeaceBuff', 600), buff('FurloughBuff', 60)] });
  assert.strictEqual(s.checkProtection().kind, 'holiday', 'holiday outranks peace (buffs.js PROTECTION order)');
});

t('an expired buff is not a protection', () => {
  const s = session({ player: [buff('TruceAgreementBuff', -1)] });
  assert.strictEqual(s.checkProtection(), null);
  assert.strictEqual(s.protection, null);
});

t('nothing running reads as no protection, not as an error', () => {
  const s = session({ player: [buff('IncFoodProduceBuff', 300)] });
  assert.strictEqual(s.checkProtection(), null, 'a production buff protects nothing');
});

t('the login\'s own answer still counts, for a console that has only just logged in', () => {
  // buffs.protectionOf falls back to game.holiday, so the badge never goes
  // backwards for an account whose ok=-100 arrived before the buff list did.
  const s = session({ player: [], holiday: { hours: 47, minutes: 57, text: '47h57m' } });
  assert.strictEqual(s.checkProtection().kind, 'holiday');
});

t('a holiday says whether the game will renew it by itself', () => {
  // /autoextend sets the game's isAutoFurlough, which comes back as autoFurlough
  // on the login's PlayerBean. Nothing could read it before 2026-09-23, so a
  // holiday about to lapse looked exactly like one that renews.
  const on = session({ player: [buff('FurloughBuff', 2879)], auto: true, days: 2 }).checkProtection();
  assert.strictEqual(on.auto, true);
  assert.strictEqual(on.days, 2);

  const off = session({ player: [buff('FurloughBuff', 9)], auto: false, days: 3 });
  const p = off.checkProtection();
  assert.strictEqual(p.auto, false);
  assert.match(off.notes[0], /NOT set to renew — it will lapse/);
});

t('renewal is a holiday question only — a truce reports neither way', () => {
  const p = session({ player: [buff('TruceAgreementBuff', 90)], auto: true }).checkProtection();
  assert.strictEqual(p.auto, null, 'a truce does not autoextend; saying "not set to renew" would be a lie');
  assert.strictEqual(p.days, null);
});

t('a change of kind is put on the record, and a ticking countdown is not', () => {
  const s = session({ player: [buff('FurloughBuff', 2879)], auto: true, days: 2 });
  s.checkProtection();
  assert.strictEqual(s.notes.length, 1, 'going on holiday is news');
  assert.match(s.notes[0], /^protection: Holiday mode — 1d 23h left, renewing itself until the coins run out$/);

  // the same holiday, two minutes on: the countdown moved, the kind did not
  s.game.player.buffs = [buff('FurloughBuff', 2877)];
  s.checkProtection();
  assert.strictEqual(s.notes.length, 1, 'a countdown ticking down is not news');

  // and it ending is
  s.game.player.buffs = [];
  s.checkProtection();
  assert.strictEqual(s.notes.length, 2);
  assert.match(s.notes[1], /^protection: none now \(holiday has ended\)$/);
});

t('a truce that runs out into a holiday says both', () => {
  const s = session({ player: [buff('TruceAgreementBuff', 30)], auto: true, days: 2 });
  s.checkProtection();
  s.game.player.buffs = [buff('FurloughBuff', 2879)];
  s.checkProtection();
  assert.deepStrictEqual(s.notes, [
    'protection: Truce — 30m00s left',
    'protection: Holiday mode — 1d 23h left, renewing itself until the coins run out',
  ]);
});

t('a console that is not connected reports nothing and keeps nothing stale', () => {
  const s = session({ player: [buff('FurloughBuff', 600)] });
  s.checkProtection();
  assert.strictEqual(s.protection.kind, 'holiday');
  unplug(s);
  assert.strictEqual(s.checkProtection(), null);
  assert.strictEqual(s.protection, null, 'a dropped console must not keep claiming a protection it cannot see');
});

t('it never throws on a half-built game', () => {
  for (const g of [null, {}, { player: null }, { player: {} }, { player: { buffs: null } }]) {
    const s = session({});
    s.game = g;
    assert.doesNotThrow(() => s.checkProtection());
  }
});

t('the interval is two minutes, and overridable', () => {
  assert.strictEqual(Session.PROTECTION_MS, Number(process.env.PROTECTION_MS || 120000));
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ok    ' + name); }
    catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + String((e && e.message) || e).split('\n').slice(0, 5).join('\n        ')); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
