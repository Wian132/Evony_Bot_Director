'use strict';
// The Director must never log in to an account one of its own consoles is holding —
// and it has to ask afresh for each account, not once at the top of a poll cycle.
//
// On 2026-09-22 that distinction cost the whole fleet. After a laptop reboot the cycle
// began at 22:29:14 with nothing running, the keep-on watchdog brought all 21 consoles
// up by 22:30:07, and the poller — working from the empty set it took at 22:29:14 —
// logged in to one account every 25 s, kicking its own consoles one after another. Each
// read that as "another user has logged into your account" and stood down for 30
// minutes: 13 accounts parked, and the fleet did nothing for half an hour.
//
// Nothing here logs into the game and nothing goes near the live Director on 8712 or
// the real consoles: a temp database, its own port, accounts with no password, and a
// "console" that is a stub answering /api/session. The only network it touches is a DNS
// lookup for ss0.evony.com, which does not exist.
//
//   node test-poll-skip.js
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-poll-'));
process.env.EVONY_DB = path.join(TMP, 't.db');
process.env.DIRECTOR_PORT = '18751';
process.env.BOT_LOG_DIR = TMP;
process.env.BOT_PORT_BASE = '18881';
process.env.POLL_GAP_MS = '1500';           // a cycle long enough for a console to appear in
process.env.POLL_FIRST_MS = '3000';         // and time to get set up before it starts
process.env.POLL_CYCLE_MS = '3600000';
process.env.UPTIME_MS = '3600000';
process.env.KEEP_ON_MS = '3600000';         // this test starts no consoles of its own
delete process.env.BOT_AUTOSTART;
delete process.env.BIND;

const CONSOLE_PORT = 18883;
const tests = [];
const t = (n, f) => tests.push([n, f]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, ms = 25000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(50);
  }
}

// The Director says what it is doing through console.log; that IS the record of which
// accounts it polled and which it left alone, so the test reads it directly.
const LINES = [];
const realLog = console.log;
console.log = (...a) => { LINES.push(a.join(' ')); };
const said = (re) => LINES.some((l) => re.test(l));

const D = require('./db');
const AUTH = require('./auth');
const op = AUTH.register({ email: 'op@example.com', password: 'correct horse battery', orgName: 'Poll Org' });
const ORG = D.org(op.org.id);
// No passwords: an account the Director cannot log in to still goes through every
// "should I poll this one?" check, which is what is under test.
const A = ORG.accounts.upsert({ label: 'Alfa', server: 'ss0', pos: 1, email: 'a@example.com' });
const B = ORG.accounts.upsert({ label: 'Bravo', server: 'ss0', pos: 2, email: 'b@example.com' });
const C = ORG.accounts.upsert({ label: 'Charlie', server: 'ss0', pos: 3, email: 'c@example.com' });
ORG.settings.set('probes', []);

// A console for Charlie — brought up later, in the middle of a cycle, exactly as the
// keep-on watchdog does after a reboot.
const consoleStub = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(req.url.startsWith('/api/session')
    ? { ok: true, account: { id: C.id, label: 'Charlie' }, connected: true, state: 'connected', logSeq: 1 }
    : {}));
});

require('./director');

t('a console that comes up DURING a cycle is not polled over', async () => {
  await until(() => said(/poll cycle: /), 25000, 'the cycle to start');
  // it is now walking the fleet, with the "who holds what" set it took while nothing
  // was running anywhere
  await until(() => said(/Alfa: (ok|getaddrinfo|no |[a-z])/), 25000, 'the first account to be dealt with');

  // Charlie's console appears now, mid-cycle
  await new Promise((r) => consoleStub.listen(CONSOLE_PORT, '127.0.0.1', r));
  ORG.settings.set('probes', [{ probe: 'Charlie', url: `http://127.0.0.1:${CONSOLE_PORT}`, accountId: C.id }]);

  // wait for the cycle's VERDICT on Charlie, not for any line that mentions it
  await until(() => said(/poll cycle done/), 25000, 'the cycle to finish');
  assert.ok(said(/Charlie: open in a console — skipped/),
    'Charlie is skipped: its console holds the account, and a poll login would kick it');
  assert.ok(!said(/Charlie: (ok \(|getaddrinfo)/), 'and no login was attempted for it');
});

t('an account nothing is holding is still polled', () => {
  assert.ok(said(/Alfa: /), 'Alfa was dealt with');
  assert.ok(!said(/Alfa: open in a console/), 'and not skipped — nothing held it');
  assert.ok(said(/Bravo: /) && !said(/Bravo: open in a console/), 'nor Bravo');
});

t('the whole cycle finishes, and only the held account was left out', async () => {
  await until(() => said(/poll cycle done/), 25000, 'the cycle to finish');
  const done = LINES.find((l) => /poll cycle done/.test(l));
  assert.match(done, /poll cycle done \(2 account\(s\)/, 'two polled, one skipped');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    try { await f(); realLog('  ok    ' + n); pass++; }
    catch (e) { realLog('  FAIL  ' + n + '\n        ' + String((e && e.stack) || e).split('\n').slice(0, 5).join('\n        ')); fail++; }
  }
  try { consoleStub.close(); } catch {}
  realLog(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
