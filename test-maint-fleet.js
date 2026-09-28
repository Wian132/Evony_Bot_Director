'use strict';
// The fleet's shared word on maintenance (maint.js + session.js).
//
// 2026-09-23: our holidayed accounts spent the whole maintenance on the
// reconnect ladder. An account on holiday is not sent the system chat
// announcement, so its console never planned a stand-down of its own, stayed
// connected into the start of the window, had the socket closed under it and
// then tried to log in again and again into a closed server. Now one console
// hearing it — or the Director watching the fleet drop at once — stands
// everybody down.
//
// Offline: no network, no game, a throwaway database file only because
// session.js opens one as it loads.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-maintfleet-')), 't.db');
const MAINT = require('./maint');
const { Session } = require('./session');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log('  ok    ' + n); pass++; }
  catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message); fail++; } };

const MIN = 60000;
const now = Date.now();
// A settings store like the org's, in memory.
const store = (rows = {}) => ({
  rows, get(k, d = null) { return k in this.rows ? this.rows[k] : d; }, set(k, v) { this.rows[k] = v; },
});
// A console for an account, with its own settings store.
function consoleFor(st, { id = 'a4', label = 'Lord04', server = 'ss71' } = {}) {
  const s = new Session();
  s.account = { id, label, server };
  s.notes = [];
  s.note = (m) => s.notes.push(String(m));
  s.settings = () => st;
  return s;
}

console.log('\nthe record itself\n');

t('an announced window: before, standing down, recovering', () => {
  const st = store();
  const w = MAINT.declare(st, 'ss71', { startAt: now + 15 * MIN, text: 'maintenance in 15 minutes', by: 'a2' }, now);
  assert.ok(w);
  assert.strictEqual(MAINT.read(st, 'ss71', now).phase, 'before');
  assert.strictEqual(MAINT.read(st, 'ss71', now + 11 * MIN).phase, 'standdown', 'five minutes before the start');
  assert.strictEqual(MAINT.read(st, 'ss71', now + 29 * MIN).phase, 'standdown');
  assert.strictEqual(MAINT.read(st, 'ss71', now + 31 * MIN).phase, 'recovering', 'the 15-minute window is over');
});

t('it says who saw it, and what they saw', () => {
  const st = store();
  MAINT.declare(st, 'ss71', { startAt: now, text: 'Evony Server ss71 will be taken offline', by: 'a2' }, now);
  const rec = MAINT.read(st, 'ss71', now);
  assert.strictEqual(rec.by, 'a2');
  assert.match(rec.text, /taken offline/);
});

t('an armed window is not moved by the next console to see it', () => {
  const st = store();
  MAINT.declare(st, 'ss71', { startAt: now + 10 * MIN, by: 'a2' }, now);
  assert.strictEqual(MAINT.declare(st, 'ss71', { startAt: now + 25 * MIN, by: 'a3' }, now), null);
  assert.strictEqual(MAINT.read(st, 'ss71', now).by, 'a2', 'the first one stands');
});

t('a window older than 90 minutes means nothing', () => {
  const st = store();
  MAINT.declare(st, 'ss71', { startAt: now - 95 * MIN }, now - 95 * MIN);
  assert.strictEqual(MAINT.read(st, 'ss71', now), null);
});

t("an account logged in again ends it; yesterday's signal does not", () => {
  const st = store();
  MAINT.declare(st, 'ss71', { startAt: now }, now);
  assert.strictEqual(MAINT.read(st, 'ss71', now + 6 * MIN).phase, 'standdown');
  MAINT.signalBack(st, 'ss71', now + 6 * MIN);
  assert.strictEqual(MAINT.read(st, 'ss71', now + 7 * MIN).phase, 'over');
  st.rows['maintOver:ss71'] = now - 24 * 3600000;        // yesterday's
  assert.strictEqual(MAINT.read(st, 'ss71', now + 7 * MIN).phase, 'standdown', 'stale, so it releases nobody');
});

t('a fresh window forgets the last one being over', () => {
  const st = store();
  MAINT.declare(st, 'ss71', { startAt: now - 30 * MIN }, now - 30 * MIN);
  MAINT.signalBack(st, 'ss71', now - 20 * MIN);
  assert.strictEqual(MAINT.read(st, 'ss71', now).phase, 'over');
  assert.ok(MAINT.declare(st, 'ss71', { startAt: now, text: 'down again' }, now), 'a window that is over can be replaced');
  assert.strictEqual(MAINT.read(st, 'ss71', now + MIN).phase, 'standdown');
});

console.log('\nwhat the Director makes of a sweep of the fleet\n');

const armed = () => { const st = store(); MAINT.declare(st, 'ss71', { startAt: now - MIN }, now); return MAINT.read(st, 'ss71', now); };

t('three consoles losing the socket at once is the server going down', () => {
  assert.strictEqual(MAINT.verdict({ dropped: 3, connected: 0 }, null), 'down');
  assert.strictEqual(MAINT.verdict({ dropped: 2, connected: 0 }, null), null, 'two is not enough');
});

// 2026-09-25: all 21 consoles cycled their sockets inside a minute from too many
// market writes in flight, while ss71's port answered in ~240 ms the whole time
t('drops with the game port OPEN are a stall on our side, not maintenance', () => {
  assert.strictEqual(MAINT.verdict({ dropped: 21, connected: 0, portOpen: true }, null), null);
  assert.strictEqual(MAINT.verdict({ dropped: 21, connected: 0, portOpen: false }, null), 'down', 'a closed port still declares');
  assert.strictEqual(MAINT.verdict({ saysDown: 2, dropped: 21, connected: 0, portOpen: true }, null), 'down',
    'consoles that read the server down from the game are believed');
});

t('two consoles reporting the server down is enough', () => {
  assert.strictEqual(MAINT.verdict({ saysDown: 2, connected: 0 }, null), 'down');
  assert.strictEqual(MAINT.verdict({ saysDown: 1, connected: 0 }, null), null);
});

t('one account still logged in settles it — the server is up', () => {
  assert.strictEqual(MAINT.verdict({ dropped: 5, saysDown: 3, connected: 1 }, null), null);
});

t('nothing is declared twice', () => {
  assert.strictEqual(MAINT.verdict({ dropped: 5, connected: 0 }, armed()), null);
});

t('an account back in during the window ends it for everyone', () => {
  assert.strictEqual(MAINT.verdict({ back: 'Lord02', connected: 1 }, armed()), 'back');
});

t('a login before the window began says nothing about it', () => {
  const st = store();
  MAINT.declare(st, 'ss71', { startAt: now + 10 * MIN }, now);
  assert.strictEqual(MAINT.verdict({ back: 'Lord02', connected: 1 }, MAINT.read(st, 'ss71', now)), null);
});

console.log('\na console that never heard the announcement\n');

t('it adopts the window another console put up, and stands down at the same time', () => {
  const st = store();
  MAINT.declare(st, 'ss71', { startAt: now + 15 * MIN, text: 'maintenance in 15 minutes', by: 'a2' }, now);
  const s = consoleFor(st);
  assert.ok(s.adoptFleetMaintenance(now), 'adopted');
  assert.strictEqual(s.maint.plan.source, 'fleet');
  assert.strictEqual(s.planPhase(now), 'before', 'it carries on playing until the stand-down');
  assert.strictEqual(s.planPhase(now + 11 * MIN), 'standdown');
  assert.strictEqual(s.planPhase(now + 31 * MIN), 'recovering');
  assert.match(s.notes.join(' '), /the fleet says the server/);
});

t('a window that has already started stands it down at once', () => {
  const st = store();
  MAINT.declare(st, 'ss71', { startAt: now - 2 * MIN, text: 'detected: the game port stopped accepting connections' }, now);
  const s = consoleFor(st);
  assert.ok(s.adoptFleetMaintenance(now));
  assert.strictEqual(s.planPhase(now), 'standdown');
});

t("a console's own plan is never overruled by the fleet's", () => {
  const st = store();
  const s = consoleFor(st);
  s.noteAnnouncement('maintenance in 15 minutes');
  const mine = s.maint.plan;
  st.rows['maintWindow:ss71'] = { startAt: now + 45 * MIN, until: now + 135 * MIN, text: 'someone else', by: 'a9' };
  s._fleetMaint = null;
  assert.strictEqual(s.adoptFleetMaintenance(now), null);
  assert.strictEqual(s.maint.plan, mine);
});

t("a script's logout is not overruled either", () => {
  const st = store();
  const s = consoleFor(st);
  s.logoutUntil(now + 30 * MIN, 'logged out by a script');
  MAINT.declare(st, 'ss71', { startAt: now - MIN }, now);
  s._fleetMaint = null;
  assert.strictEqual(s.adoptFleetMaintenance(now), null);
  assert.strictEqual(s.maint.plan.source, 'logout');
});

t('having come back through a window, it does not adopt the same one again', () => {
  const st = store();
  MAINT.declare(st, 'ss71', { startAt: now - MIN }, now);
  const s = consoleFor(st);
  assert.ok(s.adoptFleetMaintenance(now));
  s.clearMaintenancePlan();                       // what coming back online does
  s._fleetMaint = null;
  assert.strictEqual(s.adoptFleetMaintenance(now), null, 'it is done with this window');
});

t('another account getting in moves it to the recovery, not straight to a login', () => {
  const st = store();
  MAINT.declare(st, 'ss71', { startAt: now - MIN }, now);
  const s = consoleFor(st);
  s.adoptFleetMaintenance(now);
  assert.strictEqual(s.releaseIfFleetBack(now), false, 'nobody is in yet');
  MAINT.signalBack(st, 'ss71', now + 5 * MIN);
  s._fleetMaint = null;
  assert.strictEqual(s.releaseIfFleetBack(now + 5 * MIN), true);
  assert.strictEqual(s.planPhase(now + 5 * MIN), 'recovering', 'the port is checked before a login is spent');
  assert.match(s.notes.join(' '), /another account is logged in again/);
});

console.log('\nwhat a console tells the fleet\n');

t('hearing the announcement puts the window up for everyone', () => {
  const st = store();
  const s = consoleFor(st, { id: 'a2', label: 'Lord02' });
  s.noteAnnouncement('Evony Server ss71 will be taken offline for daily security maintenance in 9 minutes');
  const rec = MAINT.read(st, 'ss71', now);
  assert.ok(rec, 'the fleet was told');
  assert.strictEqual(rec.by, 'a2');
  assert.strictEqual(Math.round((rec.startAt - Date.now()) / MIN), 9);
  // and the console that heard it stands down five minutes before, as before
  assert.strictEqual(s.planPhase(rec.pauseAt + 1000), 'standdown');
});

t('the server looking down puts one up too', () => {
  const st = store();
  const s = consoleFor(st, { id: 'a5' });
  s.maint.reason = 'the game port stopped accepting connections (ECONNREFUSED)';
  assert.ok(s.armRaceFromServer(now));
  assert.match(MAINT.read(st, 'ss71', now).text, /game port stopped accepting/);
});

t('being back in tells the fleet the server is back — but only a login that held', () => {
  const st = store();
  MAINT.declare(st, 'ss71', { startAt: now - 10 * MIN }, now - 10 * MIN);
  const s = consoleFor(st);
  s.noteMaintenanceEnded();
  assert.strictEqual(MAINT.read(st, 'ss71', now).phase, 'standdown', 'not connected: nothing is claimed');
  Object.defineProperty(s, 'connected', { value: true, configurable: true });
  s.noteMaintenanceEnded();
  assert.strictEqual(MAINT.read(st, 'ss71', now).phase, 'over');
});

// A console STARTED in the middle of a window has no plan of its own yet: its first
// login would be spent before the supervisor's first tick five seconds later. Only the
// refusal is tested — anything that gets past the guard goes on to a real login, which
// no offline test may do.
(async () => {
  const st = store();
  MAINT.declare(st, 'ss71', { startAt: now - 2 * MIN, text: 'the fleet saw it' }, now);
  const s = consoleFor(st);
  try {
    await assert.rejects(() => s.connect(), /standing down for maintenance/);
    console.log('  ok    a console started inside a window refuses its first login too');
    pass++;
  } catch (e) { console.log('  FAIL  a console started inside a window refuses its first login too\n        ' + e.message); fail++; }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
