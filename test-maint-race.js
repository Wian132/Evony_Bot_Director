'use strict';
// session.js maintRace: OFF unless OTTO_MAINT_RACE=1 (the user, 2026-09-20 — every
// console now follows the clock instead). These tests switch it on to cover the code
// that is left; the last one covers the default, which is that it does not run.
// With it on: during a maintenance window the MAINTENANCE MONITOR probes
// for its end and takes the login risk; FOLLOWER consoles spend no login until the
// monitor's signal is newer than the window's start, then log in at once. The role
// is the account's own setting (maintRole:<id>), so it survives any restart.
// Offline: a fake session carrying only the few fields the race reads.
const os = require('os'), path = require('path'), fs = require('fs');
// session.js opens the database as it loads: point it at a throwaway one first
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'otto-race-')), 't.db');
const assert = require('assert');
const { Session } = require('./session');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const now = Date.now();

function fake(role, { over = 0, portOpen = true, connectOk = true, startAgo = 5 * 60000 } = {}) {
  process.env.OTTO_MAINT_RACE = '1';
  process.env.OTTO_MAINT_MONITOR = '';
  process.env.OTTO_MAINT_FOLLOW = '';
  const store = { 'maintWindow:ss71': { startAt: now - startAgo, until: now + 60 * 60000 }, 'maintOver:ss71': over };
  if (role) store['maintRole:a6'] = role;
  const f = {
    account: { id: 'a6', server: 'ss71' }, connected: false, maint: { plan: null }, notes: [], connects: 0, store,
    settings: () => ({ get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; } }),
    note(m) { this.notes.push(m); }, noteConnectOk() {}, clearMaintenancePlan() { this.maint.plan = null; },
    noteMaintenanceEnded() { this.ended = (this.ended || 0) + 1; },
    portOpen: async () => portOpen,
    async connect() { this.connects++; if (!connectOk) throw new Error('no reply to server.LoginResponse'); this.connected = true; return {}; },
  };
  for (const k of ['maintRole', 'maintRaceState', 'maintRace', 'armRaceFromServer']) f[k] = Session.prototype[k].bind(f);
  return f;
}

t("the server's own status arms the race when no announcement did (yesterday's window stored)", async () => {
  const m = fake('monitor');
  m.store['maintWindow:ss71'] = { startAt: now - 24 * 3600000, until: now - 22 * 3600000, text: 'yesterday' };
  m.maint.reason = 'the server reports ServerState=2';
  const w = m.armRaceFromServer(now);
  assert.ok(w, 'armed');
  assert.deepStrictEqual([m.store['maintWindow:ss71'].startAt, m.store['maintWindow:ss71'].until], [now - 2 * 60000, now + 90 * 60000]);
  assert.match(m.store['maintWindow:ss71'].text, /detected: the server reports ServerState=2/);
  // the monitor probes at once (the window began two minutes back)
  await m.maintRace();
  assert.strictEqual(m.connects, 1, 'the monitor tried its login straight away');
});
t('an announced window that is already armed is left alone', () => {
  const m = fake('monitor');
  const before = { ...m.store['maintWindow:ss71'] };
  assert.strictEqual(m.armRaceFromServer(now), null);
  assert.deepStrictEqual(m.store['maintWindow:ss71'], before);
});
t('a follower spends no login while the maintenance monitor is still out', async () => {
  const f = fake('follow');
  assert.strictEqual(await f.maintRace(), true);
  assert.strictEqual(f.connects, 0);
  assert.match(f.disconnectReason, /waiting for the maintenance monitor/);
});
t('a follower logs in at once when the monitor got in after the window began', async () => {
  const f = fake('follow', { over: now - 1000 });
  assert.strictEqual(await f.maintRace(), true);
  assert.strictEqual(f.connects, 1);
  assert.strictEqual(f.connected, true);
  assert.strictEqual(f.ended, 1, 'the maintenance is counted as over (holidayRun)');
});
t('a signal from before the window (yesterday\'s) does not release anyone', async () => {
  const f = fake('follow', { over: now - 24 * 3600000 });
  await f.maintRace();
  assert.strictEqual(f.connects, 0);
});
t('a connected console is left alone by the race', async () => {
  const f = fake('follow');
  f.connected = true;
  assert.strictEqual(await f.maintRace(), false);
});
t('the monitor waits two minutes into the window, and never logs in on a closed port', async () => {
  const early = fake('monitor', { startAgo: 60000 });
  await early.maintRace();
  assert.strictEqual(early.connects, 0);
  const closed = fake('monitor', { portOpen: false });
  await closed.maintRace();
  assert.strictEqual(closed.connects, 0);
  assert.match(closed.disconnectReason, /port is still closed/);
});
t('the maintenance monitor, once in, writes the signal for the followers', async () => {
  const f = fake('monitor');
  await f.maintRace();
  assert.strictEqual(f.connects, 1);
  assert.ok(f.store['maintOver:ss71'] > now - 5000);
});
t('an ignored monitor login writes nothing, and the next is at least 30 s later', async () => {
  const f = fake('monitor', { connectOk: false });
  await f.maintRace();
  await f.maintRace();
  assert.strictEqual(f.connects, 1, 'one login, not a second inside 30 s');
  assert.strictEqual(f.store['maintOver:ss71'], 0);
});
t('no role, or the window over: the race does not run', async () => {
  const none = fake(null);
  assert.strictEqual(await none.maintRace(), false);
  const late = fake('follow', { startAgo: 200 * 60000 });
  late.store['maintWindow:ss71'].until = now - 1;
  assert.strictEqual(await late.maintRace(), false);
});
t('the role is the account\'s own setting; a start-up switch overrides it', async () => {
  const f = fake(null);
  assert.strictEqual(f.maintRole(), null);
  f.store['maintRole:a6'] = 'follow';
  assert.strictEqual(f.maintRole(), 'follow', 'read from the settings, no restart needed');
  f.store['maintRole:a6'] = 'something else';
  assert.strictEqual(f.maintRole(), null, 'only monitor and follow mean anything');
  process.env.OTTO_MAINT_MONITOR = '1';
  assert.strictEqual(f.maintRole(), 'monitor');
  process.env.OTTO_MAINT_MONITOR = '';
});

t('a follower gives up on a monitor that never signals, and goes it alone', async () => {
  // 2026-09-20: the monitor came back on the ordinary ladder, so maintOver was never
  // written and the followers waited on yesterday's stale signal for 70 minutes.
  const f = fake('follow', { startAgo: 26 * 60000 });
  f.store['maintOver:ss71'] = now - 24 * 3600000;        // yesterday's, correctly stale
  assert.strictEqual(await f.maintRace(), false, 'the tick falls through to ordinary recovery');
  assert.strictEqual(f.connects, 0, 'no login is spent by the race itself');
  assert.match(f.notes.join(' '), /no word from the maintenance monitor/);
});
t('a follower still inside the patience window keeps waiting', async () => {
  const f = fake('follow', { startAgo: 10 * 60000 });
  assert.strictEqual(await f.maintRace(), true);
  assert.strictEqual(f.connects, 0);
});

t('the race is off by default: nobody probes, nobody waits on a monitor', async () => {
  const m = fake('monitor');
  process.env.OTTO_MAINT_RACE = '';
  assert.strictEqual(m.maintRaceState(), null, 'no race state at all');
  assert.strictEqual(await m.maintRace(), false, 'the tick falls through to the normal stand-down');
  assert.strictEqual(m.connects, 0, 'no login is spent into the maintenance');
  const f = fake('follow');
  process.env.OTTO_MAINT_RACE = '';
  assert.strictEqual(await f.maintRace(), false, 'a follower is not held back waiting for a monitor');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log('  ok    ' + n); pass++; } catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
