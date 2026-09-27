'use strict';
// KEEP THE DIRECTOR UP (the user, 2026-09-24: "ensure the director auto-relaunches next
// time it crashes; only allow me to manually turn it off with a confirmation popup").
//
// The Director is the fleet's control plane — the live status sweep, the goal-file sync,
// the Trading and Resources tabs, the maintenance signal. On 2026-09-24 at 21:26 a single
// `database is locked` in a timer killed it and it stayed dead for 50 minutes without
// anyone noticing: every row on the Fleet page quietly fell back to "reporting"/"stale".
// director.js now carries the same crash guard every console has, so that particular death
// cannot repeat — this is the second line, for the ones nobody has thought of.
//
//   node director-keep.js          start the Director and keep it up
//
// OFF BY HAND is the only way it stays down: the Director's own page has the switch (it
// writes the stop file below and exits), and this supervisor then waits rather than
// relaunching. Deleting the file — or pressing the switch again — brings it back within a
// few seconds. Nothing else stops it: a crash, an exit, a kill, all bring it straight back.
//
// The stop flag is a FILE, deliberately, not a database row: the thing most likely to be
// wrong when the Director dies is the database, and a supervisor that cannot read its own
// switch is no supervisor.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = __dirname;
const STOP_FILE = path.join(DIR, 'director-stop.flag');
const LOG = path.join(DIR, 'director-keep.log');
const CHECK_MS = 5000;               // how often it looks at the stop file while off
// A crash loop must not hammer the machine: the wait grows, and a Director that has been
// up a while is treated as healthy again (see `healthyFor`).
const BACKOFF = [2000, 5000, 15000, 30000, 60000, 120000];
const HEALTHY_MS = 5 * 60000;

const stamp = () => new Date().toTimeString().slice(0, 8);
function note(m) {
  const line = `${stamp()} ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* the console line is enough */ }
}

const stopped = () => { try { return fs.existsSync(STOP_FILE); } catch { return false; } };
// How long to wait before try number `n` (0-based), given how long the last run lasted.
function waitFor(n, lastRunMs) {
  if (lastRunMs >= HEALTHY_MS) return 0;          // it was up and well: straight back
  return BACKOFF[Math.min(n, BACKOFF.length - 1)];
}
// What to say about an exit, in the terms the log reader cares about.
function exitNote(code, signal) {
  if (signal) return `killed by ${signal}`;
  if (code === 0) return 'exited cleanly';
  return `exited with code ${code}`;
}

// ONE SUPERVISOR, EVER. Two of these would each spawn a Director, the second would fail to
// bind 8712, this one would call that a crash and relaunch it for ever — and both would be
// starting consoles. The logon task Windows runs cannot double up (its multiple-instances
// policy refuses), but a hand-started one beside it could, which is exactly how it would
// happen. The lock is a file holding the pid: if that process is alive, this one leaves.
const LOCK = path.join(DIR, 'director-keep.pid');
function takeLock() {
  try {
    const was = Number(fs.readFileSync(LOCK, 'utf8').trim());
    if (was && was !== process.pid) {
      try { process.kill(was, 0); return was; } catch { /* stale: the process is gone */ }
    }
  } catch { /* no lock file yet */ }
  try { fs.writeFileSync(LOCK, String(process.pid)); } catch { /* best effort */ }
  return null;
}
function dropLock() {
  try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); } catch { /* gone */ }
}

let child = null;
let tries = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loop() {
  const other = takeLock();
  if (other !== null) {
    note(`another supervisor is already running (pid ${other}) — leaving it to that one`);
    process.exit(0);
  }
  note('supervisor started — the Director will be relaunched whenever it stops,'
    + ' unless it is turned off from its own page');
  for (;;) {
    if (stopped()) {
      if (child) child = null;
      await sleep(CHECK_MS);
      continue;
    }
    const startedAt = Date.now();
    const out = fs.openSync(path.join(DIR, 'director.log'), 'a');
    const err = fs.openSync(path.join(DIR, 'director.err.log'), 'a');
    child = spawn(process.execPath, [path.join(DIR, 'director.js')],
      { cwd: DIR, env: process.env, stdio: ['ignore', out, err], windowsHide: true });
    note(`Director started, pid ${child.pid}`);
    const how = await new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
    const ran = Date.now() - startedAt;
    child = null;
    try { fs.closeSync(out); fs.closeSync(err); } catch { /* already gone */ }
    if (stopped()) { note(`Director ${exitNote(how.code, how.signal)} — turned off by hand, staying down`); continue; }
    const wait = waitFor(tries, ran);
    tries = ran >= HEALTHY_MS ? 0 : tries + 1;
    note(`Director ${exitNote(how.code, how.signal)} after ${Math.round(ran / 1000)}s`
      + ` — relaunching${wait ? ` in ${Math.round(wait / 1000)}s` : ' now'}`
      + (tries > 1 ? ` (try ${tries})` : ''));
    if (wait) await sleep(wait);
  }
}

// The supervisor going away must not leave a Director nobody watches.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    note(`supervisor told to stop (${sig}) — stopping the Director too`);
    if (child) { try { child.kill(); } catch { /* already gone */ } }
    dropLock();
    process.exit(0);
  });
}
for (const kind of ['unhandledRejection', 'uncaughtException']) {
  process.on(kind, (e) => note(`${kind}: ${(e && e.message) || e} — the supervisor kept running`));
}

process.on('exit', dropLock);

module.exports = { STOP_FILE, LOCK, waitFor, exitNote, stopped, takeLock, dropLock, BACKOFF, HEALTHY_MS };
if (require.main === module) loop();
