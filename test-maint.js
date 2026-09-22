'use strict';
// The maintenance stand-down protocol. Timing only — no network, no database
// writes beyond a throwaway file.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-maint-')), 't.db');
const { Session } = require('./session');

let pass = 0, fail = 0;
const queue = [];
const ta = (n, f) => { queue.push([n, f]); };
const t = (n, f) => { try { f(); console.log('  ok    ' + n); pass++; }
  catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message); fail++; } };

const S = () => { const s = new Session(); s.account = { id: 'test', label: 'T' }; s.note = () => {}; return s; };
const MIN = 60000;

console.log('\nrecognising the announcement\n');

t('a plain maintenance warning is recognised', () => {
  const s = S();
  assert.ok(s.noteAnnouncement('The server will be down for maintenance in 15 minutes.'));
});

t('ordinary chatter is ignored', () => {
  const s = S();
  assert.strictEqual(s.noteAnnouncement('anyone want to trade iron?'), null);
  assert.strictEqual(s.noteAnnouncement('Player X has conquered a city!'), null);
  assert.strictEqual(s.noteAnnouncement(''), null);
});

t('the lead time is read out of the message', () => {
  const s = S();
  const p = s.noteAnnouncement('Server maintenance in 30 minutes');
  const lead = Math.round((p.startsAt - p.announcedAt) / MIN);
  assert.strictEqual(lead, 30, 'read ' + lead + ' minutes');
});

t('with no time given it assumes the usual 15 minutes', () => {
  const s = S();
  const p = s.noteAnnouncement('Scheduled downtime is approaching.');
  assert.strictEqual(Math.round((p.startsAt - p.announcedAt) / MIN), 15);
});

console.log('\nthe timeline\n');

t('we stand down 5 minutes BEFORE it starts', () => {
  const s = S();
  const p = s.noteAnnouncement('maintenance in 15 minutes');
  assert.strictEqual(Math.round((p.startsAt - p.pauseAt) / MIN), 5);
});

t('so a 15-minute warning means 10 more minutes of play', () => {
  const s = S();
  const p = s.noteAnnouncement('maintenance in 15 minutes');
  assert.strictEqual(Math.round((p.pauseAt - p.announcedAt) / MIN), 10);
});

t('the quiet period is 20 minutes: 5 before plus the 15-minute window', () => {
  const s = S();
  const p = s.noteAnnouncement('maintenance in 15 minutes');
  assert.strictEqual(Math.round((p.resumeAt - p.pauseAt) / MIN), 20);
});

t('phases follow the clock', () => {
  const s = S();
  const p = s.noteAnnouncement('maintenance in 15 minutes');
  assert.strictEqual(s.planPhase(p.announcedAt + 1 * MIN), 'before');
  assert.strictEqual(s.planPhase(p.pauseAt - 1000), 'before');
  assert.strictEqual(s.planPhase(p.pauseAt + 1000), 'standdown');
  assert.strictEqual(s.planPhase(p.resumeAt - 1000), 'standdown');
  assert.strictEqual(s.planPhase(p.resumeAt + 1000), 'recovering');
});

t('no plan means no phase', () => {
  assert.strictEqual(S().planPhase(), 'none');
});

console.log('\nplanning by hand and clearing\n');

t('a hand-made plan uses the same 5-minute lead-in', () => {
  const s = S();
  const p = s.planMaintenance(20, 30);
  assert.strictEqual(Math.round((p.startsAt - p.pauseAt) / MIN), 5);
  assert.strictEqual(Math.round((p.resumeAt - p.startsAt) / MIN), 30);
  assert.strictEqual(p.source, 'manual');
});

t('clearing puts it back to none', () => {
  const s = S();
  s.planMaintenance(10);
  s.clearMaintenancePlan();
  assert.strictEqual(s.planPhase(), 'none');
});

t('a repeated announcement does not restart the clock', () => {
  const s = S();
  const a = s.noteAnnouncement('maintenance in 15 minutes');
  const b = s.noteAnnouncement('maintenance in 15 minutes');
  assert.strictEqual(a.pauseAt, b.pauseAt, 'the stand-down time moved');
});

console.log('\nno login gets through a stand-down\n');

// The churn of 2026-09-20: the console stood down, something else logged it straight
// back in, the supervisor closed it two seconds later, and round they went for six
// minutes until the proxy stopped answering. connect() refuses a stand-down itself
// now, whoever asks — a page poll, a script, the engine, the Director.
ta('connect() refuses while an announced stand-down is open', async () => {
  const s = S();
  s.noteAnnouncement('maintenance in 1 minute');       // pauseAt is already past
  assert.strictEqual(s.planPhase(), 'standdown');
  await assert.rejects(() => s.connect(), /standing down for maintenance/);
});

// Only refusals are tested here: anything that gets PAST the guard goes on to a real
// login, and no offline test may do that. The override's own path is the supervisor
// condition above, which the phase tests cover.
ta("a script's logout is refused even with the override on", async () => {
  const s = S();
  s.logoutUntil(Date.now() + 10 * MIN);
  s.maint.override = true;
  await assert.rejects(() => s.connect(), /logged out by a script/);
});

ta('a stand-down that is over no longer refuses', () => {
  const s = S();
  s.planMaintenance(-20, 5);                           // began 20m ago, 5m long
  assert.strictEqual(s.planPhase(), 'recovering');     // the guard only fires on 'standdown'
});

(async () => {
  for (const [n, f] of queue) {
    try { await f(); console.log('  ok    ' + n); pass++; }
    catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(path.dirname(process.env.EVONY_DB), { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
