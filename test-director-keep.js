'use strict';
// The Director's supervisor (director-keep.js): what it does when the Director stops.
//
//   * a crash brings it back, with a wait that grows only while it keeps crashing
//   * a Director that stayed up a while is healthy: straight back, no wait
//   * the stop FILE is the only thing that keeps it down, and it is a file on purpose —
//     the database is the likeliest thing to be broken when the Director dies
//   * exits are described in the terms the log reader cares about
// Offline: a temp folder, no processes spawned.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');

const K = require('./director-keep');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok    ' + n); } catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };

console.log('the Director supervisor');

t('a crash comes back, and the wait grows only while it keeps crashing', () => {
  // a short run: back off, further each time
  assert.strictEqual(K.waitFor(0, 1000), K.BACKOFF[0]);
  assert.strictEqual(K.waitFor(1, 1000), K.BACKOFF[1]);
  assert.strictEqual(K.waitFor(2, 1000), K.BACKOFF[2]);
  // and it stops growing rather than running away
  assert.strictEqual(K.waitFor(99, 1000), K.BACKOFF[K.BACKOFF.length - 1]);
  assert.ok(K.BACKOFF[K.BACKOFF.length - 1] <= 120000, 'the longest wait is still a couple of minutes');
});

t('a Director that had been up a while is healthy: straight back, whatever the count', () => {
  assert.strictEqual(K.waitFor(0, K.HEALTHY_MS), 0);
  assert.strictEqual(K.waitFor(5, K.HEALTHY_MS + 1), 0, 'an old crash count does not punish a healthy run');
  assert.strictEqual(K.waitFor(5, K.HEALTHY_MS - 1), K.BACKOFF[5], 'a minute short of healthy still waits');
});

t('the stop flag is a FILE beside the code, not a database row', () => {
  assert.strictEqual(path.basename(K.STOP_FILE), 'director-stop.flag');
  assert.strictEqual(path.dirname(K.STOP_FILE), __dirname,
    'it sits beside director.js so the supervisor can read it with the database broken');
});

t('stopped() is false with no file, true with one, and never throws', () => {
  const had = fs.existsSync(K.STOP_FILE);
  const keep = had ? fs.readFileSync(K.STOP_FILE) : null;
  try {
    if (had) fs.unlinkSync(K.STOP_FILE);
    assert.strictEqual(K.stopped(), false, 'no file: the Director is meant to be up');
    fs.writeFileSync(K.STOP_FILE, 'off by hand\n');
    assert.strictEqual(K.stopped(), true, 'the file is there: leave it down');
    fs.unlinkSync(K.STOP_FILE);
    assert.strictEqual(K.stopped(), false, 'deleting it brings the Director back');
  } finally { if (had) fs.writeFileSync(K.STOP_FILE, keep); }
});

t('an exit is described the way the log reader needs it', () => {
  assert.strictEqual(K.exitNote(0, null), 'exited cleanly');
  assert.strictEqual(K.exitNote(1, null), 'exited with code 1');
  assert.strictEqual(K.exitNote(null, 'SIGTERM'), 'killed by SIGTERM');
});

t('only one supervisor ever runs: the pid lock turns a second one away', () => {
  const had = fs.existsSync(K.LOCK) ? fs.readFileSync(K.LOCK) : null;
  try {
    // a lock held by THIS process is our own: taking it again is fine
    fs.writeFileSync(K.LOCK, String(process.pid));
    assert.strictEqual(K.takeLock(), null, "its own lock does not turn it away");
    // a lock held by a process that is alive turns the newcomer away, naming it
    fs.writeFileSync(K.LOCK, String(process.ppid));
    assert.strictEqual(K.takeLock(), process.ppid, "a live supervisor is left to get on with it");
    // a lock left behind by a dead process is stale and gets taken over
    fs.writeFileSync(K.LOCK, "99999999");
    assert.strictEqual(K.takeLock(), null, "a stale lock is taken over, not obeyed");
    assert.strictEqual(Number(fs.readFileSync(K.LOCK, "utf8").trim()), process.pid);
    // and it lets go on the way out
    K.dropLock();
    assert.strictEqual(fs.existsSync(K.LOCK), false);
    assert.strictEqual(K.takeLock(), null, "no lock file at all is not a reason to stop");
    K.dropLock();
  } finally { if (had) fs.writeFileSync(K.LOCK, had); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
