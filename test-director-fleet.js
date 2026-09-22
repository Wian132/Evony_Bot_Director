'use strict';
// The Director's fleet table, offline:
//   1. the real director.js on a port of its own with a temp database, driven
//      over HTTP: switching an account off and back on
//   2. the console's own side of the switch: a Session whose account is off
//      logs out and refuses every login, which is what frees the account for a
//      bot on another machine
//   3. the real public/director.html in headless Chrome over CDP: the switch and
//      the keep-on box in the first columns, the sort order, and the totals row
//
// Nothing here logs into the game and nothing touches the live Director on 8712
// or the consoles on 8711/8713: the accounts seeded below have no credentials,
// so a console can never be spawned for them except the one account that is
// deliberately started against a STUB console, and the only probe is a stub of
// this test's own, which answers /api/session and nothing else.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const http = require('http'), { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-fleet-'));
process.env.EVONY_DB = path.join(TMP, 't.db');
process.env.DIRECTOR_PORT = '18732';
process.env.BOT_LOG_DIR = TMP;
process.env.BOT_PORT_BASE = '18841';
process.env.POLL_GAP_MS = '60000';
process.env.POLL_CYCLE_MS = '3600000';
// No poll ever runs in this suite: polling an account means logging into the
// game, and nothing here goes near the game.
process.env.POLL_FIRST_MS = '3600000';
process.env.UPTIME_MS = '3600000';
// The keep-on watchdog, fast enough to watch it work. A console here is the stub
// below, so starting one costs no login.
process.env.KEEP_ON_MS = '1500';
delete process.env.BOT_AUTOSTART;

const PORT = 18732;
const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(60);
  }
}

const D = require('./db');
const AUTH = require('./auth');
const op = AUTH.register({ email: 'op@example.com', password: 'correct horse battery', orgName: 'Fleet Org' });
const ORG = D.org(op.org.id);
// One probe, this test's own stub, so the uptime sampler never asks :8711. It
// stands in for a console somebody started by hand: the Director can see it but
// has no record of starting it, so it cannot stop it.
const STUB_PORT = 18899, STUB_URL = 'http://127.0.0.1:' + STUB_PORT;
ORG.settings.set('probes', [{ probe: 'byhand', url: STUB_URL }]);
const SID = AUTH.newSession(op.user.id, op.org.id, '127.0.0.1', 'test');

// Two accounts with a snapshot each, so the totals have something to add up.
// Neither has an email or a password, which is what keeps this test offline:
// botctl refuses to spawn a console without them.
const A = ORG.accounts.upsert({ label: 'Alfa', server: 'ss0', pos: 2 });
const B = ORG.accounts.upsert({ label: 'Bravo', server: 'ss0', pos: 1 });
// The one account with credentials, so the keep-on watchdog is allowed to start
// a console for it. BOT_SCRIPT points that console at the stub below.
const C = ORG.accounts.upsert({ label: 'Charlie', server: 'ss0', pos: 3,
  email: 'c@example.com', password: 'x' });
const STUB_CONSOLE = path.join(TMP, 'stub-console.js');
fs.writeFileSync(STUB_CONSOLE, `
require('http').createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ account: { id: process.env.ACCOUNT_ID, label: 'stub' }, connected: true }));
}).listen(Number(process.env.CONSOLE_PORT), '127.0.0.1');
`);
process.env.BOT_SCRIPT = STUB_CONSOLE;
const snap = (cities, coins, troops, food, stone) => ({
  at: Date.now(), ok: true, cities, coins, troops, prestige: 1000, honor: 0, heroes: 3,
  incoming: 0, marching: 0, lord: 'x', alliance: 'y',
  totals: { food, wood: 0, stone, iron: 0, gold: 0 },
  items: { 'player.item.stoneoffinding': 7 },
});
ORG.snapshots.add(A.id, snap(10, 1158, 464800000, 6815000000000, 3231000000000));
ORG.snapshots.add(B.id, snap(5, 1090, 150000, 1137000000000, 157700000000));

const stub = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ account: { id: B.id, label: 'Bravo' }, connected: true, idleMs: 0 }));
});
stub.listen(STUB_PORT, '127.0.0.1');

require('./director');

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method,
      headers: { Cookie: 'otto_sid=' + SID, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: b, json }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const get = async (u) => (await call('GET', u)).json;
const post = (u, b) => call('POST', u, b);
const accOf = async (id) => (await get('/api/accounts')).accounts.find((a) => a.id === id);

// ======================================================================= 1
section('the Director: switching an account off');

t('the page and the account list are served', async () => {
  await until(async () => (await call('GET', '/api/accounts')).status === 200, 8000, 'the Director');
  const r = await get('/api/accounts');
  assert.strictEqual(r.accounts.length, 3);
  assert.strictEqual(r.accounts[0].enabled, true, 'a new account starts switched on');
});

t('switching off leaves the account, its snapshot and its history alone', async () => {
  const r = await post('/api/account', { id: A.id, enabled: false });
  assert.strictEqual(r.status, 200, r.body);
  assert.strictEqual(r.json.ok, true);
  const a = await accOf(A.id);
  assert.strictEqual(a.enabled, false, 'it is off');
  assert.strictEqual(a.label, 'Alfa', 'and still itself');
  assert.strictEqual(a.snapshot.cities, 10, 'with its last snapshot');
  assert.strictEqual(ORG.snapshots.series(A.id, 0, 'cities').length, 1, 'and its history');
});

t('the poller skips a switched-off account', () => {
  const targets = ORG.accounts.all().filter((x) => x.enabled !== false).map((x) => x.label);
  assert.deepStrictEqual(targets, ['Bravo', 'Charlie']);
});

t('no console can be started for it while it is off', async () => {
  const r = await post('/api/bot', { id: A.id, action: 'start' });
  assert.strictEqual(r.status, 409, r.body);
  assert.match(r.json.error, /switched off/);
});

t('switching it back on asks for its console again', async () => {
  const r = await post('/api/account', { id: A.id, enabled: true });
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual((await accOf(A.id)).enabled, true);
  // No credentials, so botctl refuses rather than spawning anything — which is
  // exactly the answer the page reports back.
  assert.strictEqual(r.json.bot.ok, false, JSON.stringify(r.json.bot));
  assert.match(r.json.bot.error, /no email\/password/);
});

t('saving other details does not touch the switch', async () => {
  await post('/api/account', { id: B.id, enabled: false });
  const r = await post('/api/account', { id: B.id, label: 'Bravo', server: 'ss1', notes: 'parked' });
  assert.strictEqual(r.json.ok, true);
  const b = await accOf(B.id);
  assert.strictEqual(b.enabled, false, 'still off after an edit that says nothing about it');
  assert.strictEqual(b.server, 'ss1');
  await post('/api/account', { id: B.id, enabled: true });
});

t('a console the Director never started is reported, not silently left playing', async () => {
  // The uptime sampler has to have seen the stub before the Director can know
  // an account is being played by a console it did not start.
  await until(async () => (await accOf(B.id)).consoleUrl === STUB_URL, 10000, 'the stub console to be seen');
  const r = await post('/api/account', { id: B.id, enabled: false });
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual((await accOf(B.id)).enabled, false, 'switched off all the same');
  assert.strictEqual(r.json.bot.ok, false, 'there was no console of ours to stop');
  assert.strictEqual(r.json.bot.stillRunning, STUB_URL, 'and it says which one is still playing it');
  await post('/api/account', { id: B.id, enabled: true });
});

// ======================================================================= 2
section('the Director: keep bot on');

const BOTS = require('./botctl');
const pidOf = (id) => (ORG.settings.get('bots', {})[id] || {}).pid || null;
const KILLED = [];
const killBot = (id) => { const pid = pidOf(id); if (pid) { try { process.kill(pid); } catch {} } return pid; };

t('an account is not kept on unless it is asked for', async () => {
  assert.strictEqual((await accOf(C.id)).keepOn, false);
  const r = await post('/api/account', { id: C.id, keepOn: true });
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual((await accOf(C.id)).keepOn, true);
  assert.strictEqual((await accOf(C.id)).enabled, true, 'and the switch is untouched by it');
});

t('the watchdog starts a console for an account that is kept on', async () => {
  const pid = await until(() => pidOf(C.id), 20000, 'the watchdog to start a console');
  KILLED.push(pid);
  assert.ok(await until(() => BOTS.running(ORG, C), 10000, 'the console to answer as Charlie'));
});

t('a console that is kept on comes back after it is killed', async () => {
  const before = killBot(C.id);
  const after = await until(async () => {
    const pid = pidOf(C.id);
    return pid && pid !== before && (await BOTS.running(ORG, C)) ? pid : null;
  }, 20000, 'the watchdog to start it again');
  KILLED.push(after);
  assert.notStrictEqual(after, before, 'a new console process, not the dead one');
});

t('switching off an account that is kept on restarts it instead', async () => {
  const before = pidOf(C.id);
  const r = await post('/api/account', { id: C.id, enabled: false });
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.restarted, true, 'it says what it did instead');
  assert.strictEqual((await accOf(C.id)).enabled, true, 'the account stays on');
  assert.ok(pidOf(C.id) && pidOf(C.id) !== before, 'and its console was restarted');
  KILLED.push(pidOf(C.id));
});

t('clear keep on, and the switch switches it off and it stays off', async () => {
  await post('/api/account', { id: C.id, keepOn: false });
  const r = await post('/api/account', { id: C.id, enabled: false });
  assert.ok(!r.json.restarted, 'no restart this time');
  assert.strictEqual((await accOf(C.id)).enabled, false);
  const pid = pidOf(C.id);
  assert.strictEqual(pid, null, 'its console was stopped and not written down again');
  // The watchdog gets several turns and must leave it alone.
  await sleep(4000);
  assert.strictEqual(pidOf(C.id), null, 'and nothing started it again');
  assert.strictEqual((await accOf(C.id)).enabled, false, 'still off');
});

t('an account that is off is not started again even when it is kept on', async () => {
  await post('/api/account', { id: C.id, keepOn: true });
  assert.strictEqual((await accOf(C.id)).enabled, false, 'ticking keep on does not switch it back on');
  await sleep(4000);
  assert.strictEqual(pidOf(C.id), null, 'and the watchdog left it alone: off outranks keep on');
  await post('/api/account', { id: C.id, keepOn: false });
  // Back on for the page below, which reads the fleet as a whole.
  await post('/api/account', { id: C.id, enabled: true });
  KILLED.push(pidOf(C.id));
});

// ======================================================================= 3
section('the console: a switched-off account is not logged in');

t('a Session whose account is off refuses every login', async () => {
  process.env.ACCOUNT_ID = A.id;
  const { Session } = require('./session');
  const S = new Session(A.id);
  assert.strictEqual(S.switchedOff(), false, 'it starts on');
  await post('/api/account', { id: A.id, enabled: false });
  S._offReadAt = 0;                                  // do not wait out the 2s cache
  assert.strictEqual(S.switchedOff(), true, 'the console sees the switch, in another process');
  await assert.rejects(() => S.connect(), /switched off in the Director/);
  delete process.env.ACCOUNT_ID;
});

t('the supervisor closes the socket and stands down while it is off', async () => {
  const { Session } = require('./session');
  const S = new Session(A.id);
  let closed = 0;
  // A socket that looks live to Session.connected, and counts being closed.
  S.game = { c: { sock: { destroyed: false } }, close() { closed++; this.c.sock.destroyed = true; } };
  S.startSupervisor({ checkMs: 60 });
  await until(() => S.state === 'off', 5000, 'the supervisor to stand down');
  clearInterval(S._supervisor);
  assert.strictEqual(closed, 1, 'it logged out once, not once a tick');
  assert.strictEqual(S.disconnectReason, 'switched off in the Director');
  assert.ok(S.log.some((l) => /switched off in the Director — logging out/.test(l.text || l.m || '')),
    'and said so in its log');
  await post('/api/account', { id: A.id, enabled: true });
});

// ======================================================================= 4
section('the page, in headless Chrome over CDP');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let chrome = null, ws = null, cdpId = 0;
const pending = new Map(), pageErrors = [];
function cdp(method, params = {}) {
  const id = ++cdpId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}
async function ev(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  return r.result.value;
}
const browserOff = process.env.SKIP_BROWSER === '1' || !fs.existsSync(CHROME);

t('the fleet table loads with every account', async () => {
  if (browserOff) return 'skipped';
  const port = 9410 + Math.floor(Math.random() * 50);
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(TMP, 'chrome')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
  const list = await until(async () => {
    try { return await new Promise((res, rej) => http.get(`http://127.0.0.1:${port}/json/list`, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej)); } catch { return null; }
  }, 15000, 'Chrome');
  const page = list.find((x) => x.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(p.method + ': ' + m.error.message)); else p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Network.enable');
  await cdp('Network.setCookie', { name: 'otto_sid', value: SID, url: `http://127.0.0.1:${PORT}/` });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  try {
    await until(() => ev(`document.querySelectorAll('#tbl tbody tr[data-id]').length === 3`), 15000, 'the three rows');
  } catch (e) {
    throw new Error(e.message + (pageErrors.length ? ' — the page threw: ' + pageErrors.join(' | ') : ''));
  }
});

t('every column that can be added up has its total under the table', async () => {
  if (browserOff) return 'skipped';
  const f = await ev(`(() => {
    const keys = shownCols().map((c) => c.key);
    const cells = [...document.querySelectorAll('#tbl tfoot td')].map((td) => td.textContent);
    return Object.fromEntries(keys.map((k, i) => [k, cells[i]]));
  })()`);
  assert.strictEqual(f.label, 'total of 3', JSON.stringify(f));
  assert.strictEqual(f.cities, '15', 'the cities column adds up');
  assert.strictEqual(f.coins, '2,248');
  assert.strictEqual(f.troops, '464.9m', 'troops keep the short form the column itself uses');
  assert.strictEqual(f.food, '7952.0b');
  assert.strictEqual(f.stone, '3388.7b');
  assert.strictEqual(f.server, '', 'a column of names has no total');
  assert.strictEqual(f.status, '');
});

t('the totals follow the filter — they are of what is on screen', async () => {
  if (browserOff) return 'skipped';
  await ev(`(() => { $('#q').value = 'Bravo'; render(); })()`);
  const f = await ev(`(() => {
    const keys = shownCols().map((c) => c.key);
    const cells = [...document.querySelectorAll('#tbl tfoot td')].map((td) => td.textContent);
    return Object.fromEntries(keys.map((k, i) => [k, cells[i]]));
  })()`);
  assert.strictEqual(f.label, 'total of 1');
  assert.strictEqual(f.cities, '5');
  await ev(`(() => { $('#q').value = ''; render(); })()`);
});

t('an item column totals across the fleet', async () => {
  if (browserOff) return 'skipped';
  const v = await ev(`(() => {
    VISIBLE.add('i_stone'); saveCols(); render();
    const keys = shownCols().map((c) => c.key);
    const cells = [...document.querySelectorAll('#tbl tfoot td')].map((td) => td.textContent);
    return cells[keys.indexOf('i_stone')];
  })()`);
  assert.strictEqual(v, '14', 'seven Stones of Finding each');
});

t('the table starts in the accounts\' own sort order, lowest first', async () => {
  if (browserOff) return 'skipped';
  const order = await ev(`[...document.querySelectorAll('#tbl tbody tr[data-id]')].map((tr) => tr.dataset.id)`);
  assert.deepStrictEqual(order, [B.id, A.id, C.id], 'Bravo is 1, Alfa 2, Charlie 3');
  const moved = await post('/api/account', { id: C.id, pos: 0 });
  assert.strictEqual(moved.json.ok, true);
  await ev('refresh()');
  await until(async () => (await ev(`document.querySelector('#tbl tbody tr').dataset.id`)) === C.id,
    8000, 'Charlie to move to the top');
  await post('/api/account', { id: C.id, pos: 3 });
  await ev('refresh()');
});

t('the sort order box carries the account\'s own number, and saving it moves the row', async () => {
  if (browserOff) return 'skipped';
  const shown = await ev(`(() => {
    openDlg(DATA.accounts.find((a) => a.id === '${B.id}'));
    const v = { pos: $('#frm').pos.value, keepOn: $('#frm').keepOn.checked };
    $('#dlg').close(); return v; })()`);
  assert.strictEqual(shown.pos, '1');
  assert.strictEqual(shown.keepOn, false);
});

t('the keep-on box on the row is the account\'s own setting', async () => {
  if (browserOff) return 'skipped';
  await ev(`document.querySelector('#tbl tbody tr[data-id="${B.id}"] .keepon').click()`);
  await until(async () => (await accOf(B.id)).keepOn === true, 8000, 'keep on to be set');
  // The page says so once its own refresh has been through, which is after the
  // account itself has changed.
  await until(() => ev(`/will be kept on/.test($('#status').textContent)`), 8000, 'the page to say so');
  await ev(`document.querySelector('#tbl tbody tr[data-id="${B.id}"] .keepon').click()`);
  await until(async () => (await accOf(B.id)).keepOn === false, 8000, 'keep on to be cleared');
});

t('the switch in the first column turns an account off', async () => {
  if (browserOff) return 'skipped';
  await ev(`document.querySelector('#tbl tbody tr[data-id="${A.id}"] .onoff').click()`);
  await until(async () => (await accOf(A.id)).enabled === false, 10000, 'the account to go off');
  await until(() => ev(`document.querySelector('#tbl tbody tr[data-id="${A.id}"]').classList.contains('off')`), 10000, 'the row to show it');
  assert.match(await ev(`document.querySelector('#tbl tbody tr[data-id="${A.id}"]').textContent`), /off/);
  assert.strictEqual(await ev(`$('#cOff').textContent`), '1');
  assert.strictEqual(await ev(`$('#offStat').hidden`), false);
  await until(() => ev(`/is switched off/.test($('#status').textContent)`), 8000, 'the page to say it is off');
});

t('a switched-off account is offered no Start button', async () => {
  if (browserOff) return 'skipped';
  assert.strictEqual(await ev(`document.querySelector('#tbl tbody tr[data-id="${A.id}"] .startBot') !== null`), false);
});

t('the Switched off view lists exactly the ones that are off', async () => {
  if (browserOff) return 'skipped';
  const rows = await ev(`(() => { view = 'off'; render();
    return [...document.querySelectorAll('#tbl tbody tr[data-id]')].map((tr) => tr.dataset.id); })()`);
  assert.deepStrictEqual(rows, [A.id]);
  await ev(`(() => { view = 'all'; render(); })()`);
});

t('the switch turns it back on again', async () => {
  if (browserOff) return 'skipped';
  await ev(`document.querySelector('#tbl tbody tr[data-id="${A.id}"] .onoff').click()`);
  await until(async () => (await accOf(A.id)).enabled === true, 15000, 'the account to come back on');
  await until(() => ev(`!document.querySelector('#tbl tbody tr[data-id="${A.id}"]').classList.contains('off')`), 10000, 'the row to show it');
  assert.strictEqual(await ev(`$('#offStat').hidden`), true);
});

t('clicking the switch does not also open that bot', async () => {
  if (browserOff) return 'skipped';
  const opened = await ev(`(() => {
    let n = 0; const real = window.open; window.open = () => { n++; return null; };
    document.querySelector('#tbl tbody tr[data-id="${A.id}"] .onoff').click();
    window.open = real; return n; })()`);
  assert.strictEqual(opened, 0, 'the row click handler let the switch have the click');
  await until(async () => (await accOf(A.id)).enabled === false, 10000, 'the account to go off again');
  await post('/api/account', { id: A.id, enabled: true });
});

t('an account holding prisoners is marked out: a violet row, a pill and the Prisoners column', async () => {
  if (browserOff) return 'skipped';
  // the shape a console publishes once it is on this build (snapshot.js)
  ORG.snapshots.add(A.id, { ...snap(10, 1158, 464800000, 6815000000000, 3231000000000),
    captives: [{ city: 'main', id: '777', name: 'Harriet', level: 2 },
      { city: 'fort', id: '778', name: 'Philip', level: 12 }],
    cityList: [
      { id: 'c1', name: 'main', x: 10, y: 10, heroes: 10, captives: 1 },
      { id: 'c2', name: 'fort', x: 11, y: 10, heroes: 0, captives: 0 },
      { id: 'c3', name: 'quiet', x: 12, y: 10, heroes: 5, captives: 0 },
    ] });
  await ev('refresh()');
  await until(async () => (await ev(`!!document.querySelector('#tbl tbody tr.hascap')`)), 8000, 'the violet row');

  const row = await ev(`(() => {
    const tr = document.querySelector('#tbl tbody tr[data-id="${A.id}"]');
    const keys = shownCols().map((c) => c.key);
    const cells = [...tr.querySelectorAll('td')].map((td) => td.textContent.trim());
    return { cls: tr.className, cells: Object.fromEntries(keys.map((k, i) => [k, cells[i]])) };
  })()`);
  assert.ok(row.cls.includes('hascap'), 'the row carries the highlight class, got ' + row.cls);
  assert.strictEqual(row.cells.captives, '2', 'the Prisoners column counts them');
  assert.ok(/1 empty/.test(row.cells.heroGaps), 'the empty city is called out: ' + row.cells.heroGaps);
  assert.ok(/1 full/.test(row.cells.heroGaps), 'and the one holding ten: ' + row.cells.heroGaps);
  assert.ok(/2 prisoners/.test(row.cells.status), 'the status cell says so too: ' + row.cells.status);

  // and only that account
  const marked = await ev(`[...document.querySelectorAll('#tbl tbody tr.hascap')].map((tr) => tr.dataset.id)`);
  assert.deepStrictEqual(marked, [A.id], 'nobody else is marked');

  if (process.env.SHOT_CAPTIVES) {
    // wide enough that the fleet table's own columns are all on screen
    await cdp('Emulation.setDeviceMetricsOverride', { width: 2200, height: 700, deviceScaleFactor: 1, mobile: false });
    await ev(`(() => { VISIBLE = new Set(['_edit','label','status','cities','heroes','captives','heroGaps']); render(); })()`);
    const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(process.env.SHOT_CAPTIVES, Buffer.from(shot.data, 'base64'));
    await cdp('Emulation.clearDeviceMetricsOverride');
    await ev(`(() => { VISIBLE = new Set(DEFAULT_VISIBLE); render(); })()`);
  }

  // the view narrows to it
  const shown = await ev(`(() => { view = 'captives'; render();
    const ids = [...document.querySelectorAll('#tbl tbody tr[data-id]')].map((tr) => tr.dataset.id);
    view = 'all'; render(); return ids; })()`);
  assert.deepStrictEqual(shown, [A.id], 'the "Holding prisoners" view');
});

t('an account holding none is left alone', async () => {
  if (browserOff) return 'skipped';
  const row = await ev(`(() => {
    const tr = document.querySelector('#tbl tbody tr[data-id="${B.id}"]');
    const keys = shownCols().map((c) => c.key);
    const cells = [...tr.querySelectorAll('td')].map((td) => td.textContent.trim());
    return { cls: tr.className, cells: Object.fromEntries(keys.map((k, i) => [k, cells[i]])) };
  })()`);
  assert.ok(!row.cls.includes('hascap'), 'no highlight');
  assert.strictEqual(row.cells.captives, '0');
  assert.strictEqual(row.cells.heroGaps, '\u2014', 'a dash where there is nothing to report');
});

// ======================================================================= 5
section('the Trading tab');

// console logs for Alfa, in the log dir botctl writes to (BOT_LOG_DIR = TMP here)
const hms = (ms) => new Date(Date.now() - ms).toTimeString().slice(0, 8);
fs.writeFileSync(path.join(TMP, `console-${A.id}.log`), [
  `[autorun 3] ${hms(240000)}.000 line 24: buy food 99999999 0.5 x10 · 10 × buy 99,999,999 food @ 0.5 from 3 · a fee — 10 of 10 placed`,
  `[autorun 4] ${hms(60000)}.000 line 24: buy food 99999999 0.5 x10 · 10 × buy 99,999,999 food @ 0.5 from 4 · a fee — 7 of 10 placed (3 refused: no reply to trade.newTrade)`,
  `[autorun 6] ${hms(50000)}.000 line 15: if sitout … · SITOUT buy food — over the cap, sitting out`,
  `[conn] ${hms(30000)}.000 session ready`,
].join('\n') + '\n');

t('/api/trading reads the play off the console logs', async () => {
  const r = await get('/api/trading?minutes=30');
  assert.ok(r && !r.error, JSON.stringify(r).slice(0, 200));
  const a = r.accounts.find((x) => x.id === A.id);
  assert.ok(a, 'Alfa has a log, so it is listed');
  assert.deepStrictEqual([a.placed2, a.refused2, a.placed10, a.active, a.side], [7, 3, 17, 2, 'buy']);
  assert.deepStrictEqual(a.sitting.map((s) => s.city), ['6']);
  assert.ok(!r.accounts.find((x) => x.id === B.id), 'Bravo has no log, so it is not');
  assert.strictEqual(r.buckets.reduce((s, b) => s + b.ours, 0), 17);
  assert.ok(r.control === null || typeof r.control.res === 'string');
});

t('the Trading tab draws the play, the bars, the readings and each account', async () => {
  if (browserOff) return 'skipped';
  await ev(`document.querySelector('.tab[data-p="trading"]').click()`);
  await until(() => ev(`!!TR && document.querySelectorAll('#trCards .card').length === 6`), 10000, 'the cards');
  // and with a holiday side, as it looks in a live play
  await ev(`(() => {
    const now = Date.now(), B = 300000;
    TR = { now, control: { res: 'food', price: 0.5, play: 'auto', kind: 'res', capRes: 4e11, capGold: 4e13, keepRes: 1e10, keepGold: 1e10, foodCap: 9.5e11, stopped: false },
      buckets: Array.from({ length: 12 }, (_, i) => ({ t: now - (12 - i) * B, hol: 1400, ours: i === 3 ? 4300 : 1000, pct: i === 3 ? 307 : 71, prices: [i < 6 ? '1' : '0.5'] })),
      readings: [{ t: now - 1200000, hol: 5881, ours: 4338, pct: 74 }, { t: now - 600000, hol: 3000, ours: 2300, pct: 77 }],
      total: { res: 'food', since: now - 1800000, hol: 16601, ours: 13256, pct: 80, holT: 1.66, oursT: 1.33 },
      accounts: [
        { id: 'h', label: 'Lord06', holiday: true, connected: true, placed2: 540, refused2: 0, placed10: 2730, active: 8, side: 'sell', sitting: [], lastOrderAt: now,
          conn: [{ t: now - 60000, text: 'three commands in a row unanswered — ignoring this account? (17 market writes in flight, 36 waiting)' }],
          fresh: { food: 6.807e12, wood: 1e12, stone: 8e12, iron: 3e12 }, freshAt: now - 1800000, freshCities: 9 },
        { id: 'o', label: 'Lord04', holiday: false, connected: true, placed2: 253, refused2: 3, placed10: 1249, active: 9, side: 'buy', sitting: [{ city: 'main', res: 'food' }], lastOrderAt: now,
          conn: [{ t: now - 3600000, text: 'reconnected' }], fresh: { food: 3.63e12, wood: 3.5e12, stone: 3.3e12, iron: 1.1e12 }, freshAt: now - 1800000, freshCities: 10 },
        { id: 'x', label: 'Lord22', holiday: false, connected: true, placed2: 0, refused2: 0, placed10: 0, active: 0, side: null, sitting: [], lastOrderAt: null, conn: [], fresh: null } ] };
    paintTrading();
  })()`);
  const v = await ev(`(() => ({
    cards: [...document.querySelectorAll('#trCards .card')].map((c) => c.textContent),
    bars: document.querySelectorAll('#trBars .col').length,
    pcts: [...document.querySelectorAll('#trBars .pct')].map((p) => p.textContent),
    rows: [...document.querySelectorAll('#trAccounts tr')].map((r) => r.textContent),
    readings: document.querySelectorAll('#trReadings tr').length,
    prices: [...document.querySelectorAll('#trAxis span')].map((s) => s.textContent),
  }))()`);
  const flat = (x) => x.replace(/\s+/g, ' ').trim();
  v.cards = v.cards.map(flat);
  v.rows = v.rows.map(flat);
  assert.match(v.cards[0], /FOOD @ 0\.5/);
  assert.match(v.cards[0], /food hard cap 950b/);
  assert.match(v.cards[1], /77%/, 'the last full reading is the one before the filling one');
  assert.match(v.cards[2], /80%.*holiday sold 1\.66t · ours bought 1\.33t/);
  assert.match(v.cards[3], /270 \/ 127 a minute/);
  assert.match(v.cards[4], /1 shaky.*Lord06/);
  assert.strictEqual(v.bars, 12);
  assert.strictEqual(v.pcts[3], '307%');
  assert.deepStrictEqual(v.prices, ['@1', '@0.5'], 'the price shows where it changed');
  assert.match(v.rows[1], /^Lord06 holiday sells 270 0 8 — 6\.81t food/);
  assert.match(v.rows[2], /^Lord04 ours buys 127 3 9 main \(food\) 3\.63t food/);
  assert.match(v.rows[3], /not trading in this window: Lord22/);
  assert.strictEqual(v.readings, 3);
  if (process.env.SHOT) {
    const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(process.env.SHOT, Buffer.from(shot.data, 'base64'));
  }
  assert.deepStrictEqual(pageErrors, [], 'the page threw nothing');
});

// The Trading tab's second view: the three lists, a move by keyboard saved to the DB,
// and the checks. Start is never pressed — it would restart consoles. The control file
// is only READ here (the real one, for its values).
t('the Trading view: accounts move between the lists by key, the setup is saved, the checks refuse a start', async () => {
  const api = await get('/api/trading/setup');
  assert.strictEqual(api.ok, true, JSON.stringify(api).slice(0, 200));
  assert.ok(api.control && api.control.foodCap === 950e9, 'the control file is read');
  assert.match(api.check.errors.join(' '), /nobody is buying/);
  if (browserOff) return 'skipped';
  await ev(`showTrSub('setup')`);
  await until(() => ev(`!!TS && document.querySelectorAll('.ts-col[data-side="none"] .ts-acc').length > 0`), 10000, 'the setup lists');
  const id = await ev(`document.querySelector('.ts-col[data-side="none"] .ts-acc').dataset.id`);
  await ev(`(() => { const c = document.querySelector('.ts-acc[data-id="${id}"]'); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true })); })()`);
  await until(() => ev(`!!document.querySelector('.ts-col[data-side="buy"] .ts-acc[data-id="${id}"]')`), 8000, 'the card in Buying');
  assert.strictEqual((await get('/api/trading/setup')).setup.sides[id], 'buy', 'saved in the DB');
  // its S button moves it on
  await ev(`document.querySelector('.ts-acc[data-id="${id}"] button[data-to="sell"]').click()`);
  await until(async () => (await get('/api/trading/setup')).setup.sides[id] === 'sell', 8000, 'saved as selling');
  const v = await ev(`({ start: document.querySelector('#tsChecks').textContent, form: document.querySelector('#tsPrice').value })`);
  assert.match(v.start, /Start is refused/);
  assert.ok(v.form !== '', 'the play form is filled');
  if (process.env.SHOT_SETUP) {
    const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(process.env.SHOT_SETUP, Buffer.from(shot.data, 'base64'));
  }
  await post('/api/trading/setup', { sides: {} });
  await ev(`showTrSub('results')`);
  assert.deepStrictEqual(pageErrors, [], 'the page threw nothing');
});

// ======================================================================= 6
section('the Resources tab');

t('/api/resources: per record time, each resource summed over the matching cities', async () => {
  const CR = require('./city-resources');
  const org = op.org.id, h = 3600000, t0 = Date.now() - 2 * h;
  const ins = (at, acc, label, city, x, y, v) => D.run(`INSERT INTO city_resources (orgId,accountId,label,at,snapAt,cityId,city,x,y,food,wood,stone,iron,gold)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, org, acc, label, at, at, city, city, x, y, v, v * 2, v * 3, v * 4, v * 100);
  ins(t0, A.id, 'Alfa', 'main', 10, 10, 100e9); ins(t0, B.id, 'Bravo', 'b1', 20, 20, 50e9);
  ins(t0 + h, A.id, 'Alfa', 'main', 10, 10, 200e9); ins(t0 + h, B.id, 'Bravo', 'b1', 20, 20, 60e9);
  const all = await get('/api/resources?hours=24');
  assert.deepStrictEqual(all.points.map((p) => p.food), [150e9, 260e9]);
  assert.strictEqual(all.cities.length, 2, 'the latest record, city by city');
  const one = await get(`/api/resources?hours=24&accounts=${A.id}`);
  assert.deepStrictEqual(one.points.map((p) => p.gold), [100e9 * 100, 200e9 * 100]);
  const q = await get('/api/resources?hours=24&q=b1');
  assert.deepStrictEqual(q.cities.map((c) => c.city), ['b1'], 'the search matches the city name');
  assert.ok(CR.lastAt(org) >= t0 + h);
});

t('the Resources tab draws a chart per resource, the filters and the city table', async () => {
  if (browserOff) return 'skipped';
  await ev(`document.querySelector('.tab[data-p="resources"]').click()`);
  await until(() => ev(`!!RS && document.querySelectorAll('#rsCharts .rs-panel').length === 5`), 10000, 'the five charts');
  const v = await ev(`(() => ({
    now: [...document.querySelectorAll('.rs-now')].map((e) => e.textContent),
    rows: document.querySelectorAll('#rsTable tr').length,
    paths: document.querySelectorAll('#rsCharts path').length,
    sides: [...document.querySelectorAll('#rsTable .rs-side td:first-child')].map((e) => e.textContent),
    split: [...document.querySelectorAll('.rs-panel[data-k="food"] .rs-split-part')].map((e) => e.textContent),
  }))()`);
  assert.deepStrictEqual(v.now, ['260b', '520b', '780b', '1.04t', '26.0t']);
  assert.strictEqual(v.rows, 6, 'header, two cities, the total, and the total on each side of the holiday');
  assert.deepStrictEqual(v.sides, ['not on holiday — 1 accounts, 1 cities', 'holiday unknown — 1 accounts, 1 cities']);
  assert.deepStrictEqual(v.split, ['not on holiday 60b 23%', 'holiday unknown 200b 77%'], 'each card splits its figure by holiday');
  assert.strictEqual(v.paths, 10, 'a filled area and a line for each resource');
  await ev(`document.querySelector('#rsTypes [data-r="gold"]').click()`);
  assert.strictEqual(await ev(`document.querySelectorAll('#rsCharts .rs-panel').length`), 1, 'one resource on its own');
  await ev(`document.querySelector('#rsTypes [data-r="all"]').click()`);
  if (process.env.SHOT2) {
    const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(process.env.SHOT2, Buffer.from(shot.data, 'base64'));
  }
  assert.deepStrictEqual(pageErrors, [], 'the page threw nothing');
});

// ======================================================================= 6b
section('the Resources tab: the 08:30 record, and the towns the glitch leaves behind');

// Nothing below goes near the game either: the 08:30 record copies a snapshot that
// is planted here, and the glitch detection reads rows planted straight into
// city_resources under account ids no console owns.
const CR = require('./city-resources');
const ORGID = op.org.id;
const DAY_MS = 86400000;
const atOn = (daysAgo, h, m) => { const d = new Date(Date.now() - daysAgo * DAY_MS); d.setHours(h, m, 0, 0); return d.getTime(); };
const res = (food, wood, stone, iron, gold) => ({ food, wood, stone, iron, gold });
// every town gets its own x,y — the page tells one town from another by those
const XY = new Map();
const plant = (at, accountId, label, city, r) => {
  const key = accountId + '|' + city;
  if (!XY.has(key)) XY.set(key, [100 + XY.size, 200 + XY.size]);
  const [x, y] = XY.get(key);
  D.run(`INSERT INTO city_resources (orgId,accountId,label,at,snapAt,cityId,city,x,y,food,wood,stone,iron,gold,kind)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
  ORGID, accountId, label, at, at, city, city, x, y, r.food, r.wood, r.stone, r.iron, r.gold);
};

t('the 08:30 record is taken once a morning and marked with the day it belongs to', async () => {
  // a snapshot carrying per-city figures — what the record copies
  ORG.snapshots.add(A.id, { ...snap(10, 1158, 464800000, 6815000000000, 3231000000000),
    cityList: [{ id: 'c1', name: 'main', x: 10, y: 10, food: 1e9, wood: 2e9, stone: 3e9, iron: 4e9, gold: 5e9 }] });
  const day = CR.dayKey(Date.now());
  const half8 = atOn(0, 8, 30);
  assert.ok(CR.morningDue(ORGID, half8), 'at 08:30 the day is owed');
  const r = CR.recordMorning({ orgId: ORGID, now: half8 });
  assert.strictEqual(r.taken, true, JSON.stringify(r));
  assert.strictEqual(r.day, day, 'labelled with the date it belongs to');
  assert.strictEqual(r.kind, 'morning:' + day, 'and kept apart from the hourly record');
  const rows = D.all('SELECT kind, city FROM city_resources WHERE orgId = ? AND kind = ?', ORGID, 'morning:' + day);
  assert.strictEqual(rows.length, 1, 'one row per city with figures (Bravo and Charlie have none)');
  // never twice for the same morning
  assert.strictEqual(CR.morningDue(ORGID, half8), null);
  assert.strictEqual(CR.recordMorning({ orgId: ORGID, now: half8 }), null);
  // before 08:30 tomorrow's is not owed yet; after it, it is, and late says so
  assert.strictEqual(CR.morningDue(ORGID, atOn(-1, 7, 0)), null, 'nothing is owed before 08:30');
  assert.strictEqual(CR.morningDue(ORGID, atOn(-1, 8, 31)).late, false, 'on time at 08:31');
  assert.strictEqual(CR.morningDue(ORGID, atOn(-1, 11, 0)).late, true, 'a Director that was down comes back to a late one');
  assert.strictEqual(CR.morningDue(ORGID, atOn(-1, 20, 0)), null, 'but the evening is not the morning — past the grace it is written off');
  const api = await get('/api/resources/mornings?days=7');
  assert.deepStrictEqual(api.days, [day]);
  assert.strictEqual(api.towns.length, 1);
  assert.strictEqual(api.towns[0].by[day].stone, 3e9);
});

t('a town put back across a maintenance, one that is not, and one with no records', async () => {
  // Two mornings back. The older maintenance has no `maintEnded` of its own, so it
  // falls back to the daily window; yesterday's is taken from the settings.
  const d2 = CR.dayKey(atOn(1, 12, 0));
  ORG.settings.set('maintEnded:glitchy-test', { day: d2, at: atOn(1, 9, 20) });

  // GLITCHY — an account the record can see being put back
  plant(atOn(2, 7, 0), 'glitchy-test', 'Glitchy', 'kept', res(0, 0, 100e9, 0, 0));
  plant(atOn(2, 7, 0), 'glitchy-test', 'Glitchy', 'lost', res(0, 0, 500e9, 0, 0));
  plant(atOn(2, 10, 0), 'glitchy-test', 'Glitchy', 'kept', res(0, 0, 500e9, 0, 0));
  plant(atOn(2, 10, 0), 'glitchy-test', 'Glitchy', 'lost', res(0, 0, 500e9, 0, 0));
  plant(atOn(1, 7, 0), 'glitchy-test', 'Glitchy', 'kept', res(0, 0, 10e9, 0, 0));
  plant(atOn(1, 7, 0), 'glitchy-test', 'Glitchy', 'lost', res(0, 0, 10e9, 0, 0));
  plant(atOn(1, 10, 0), 'glitchy-test', 'Glitchy', 'kept', res(0, 0, 500e9, 0, 0));
  plant(atOn(1, 10, 0), 'glitchy-test', 'Glitchy', 'lost', res(0, 0, 10e9, 0, 0));
  // and a town nobody recorded either side of a maintenance
  plant(atOn(2, 7, 0), 'glitchy-test', 'Glitchy', 'gap', res(0, 0, 400e9, 0, 0));

  // ORDINARY — drained exactly like `lost`, but no town of it was ever put back, so
  // the record cannot tell a holiday from an account that simply spent what it had
  plant(atOn(1, 7, 0), 'plain-test', 'Plain', 'one', res(0, 0, 10e9, 0, 0));
  plant(atOn(1, 7, 0), 'plain-test', 'Plain', 'two', res(0, 0, 10e9, 0, 0));
  plant(atOn(2, 10, 0), 'plain-test', 'Plain', 'one', res(0, 0, 500e9, 0, 0));
  plant(atOn(2, 10, 0), 'plain-test', 'Plain', 'two', res(0, 0, 500e9, 0, 0));
  plant(atOn(1, 10, 0), 'plain-test', 'Plain', 'one', res(0, 0, 10e9, 0, 0));
  plant(atOn(1, 10, 0), 'plain-test', 'Plain', 'two', res(0, 0, 10e9, 0, 0));

  const rep = CR.restoreReport({ orgId: ORGID });
  const of = (label, city) => rep.towns.find((x) => x.label === label && x.city === city);
  const on = (t2, day) => (t2.checks.find((c) => c.day === day) || {}).verdict;

  assert.ok(rep.events.length >= 1, 'at least yesterday could be judged');
  assert.strictEqual(on(of('Glitchy', 'kept'), d2), 'restored', 'it came back to what it was put back to before');
  assert.strictEqual(on(of('Glitchy', 'lost'), d2), 'not restored', 'it was drained and stayed drained');
  assert.strictEqual(of('Glitchy', 'gap').judged, 0, 'a town with no records either side is judged on nothing');
  assert.ok(of('Glitchy', 'gap').checks.every((c) => c.verdict === 'unclear'));
  assert.strictEqual(of('Glitchy', 'kept').flagged, false);
  assert.strictEqual(of('Glitchy', 'lost').flagged, true, 'the one that never came back is flagged');
  assert.strictEqual(of('Glitchy', 'lost').concern, 'not restored');
  assert.strictEqual(of('Glitchy', 'gap').flagged, false, 'and nothing is claimed about the one we cannot see');

  // the evidence the page prints
  const ev2 = of('Glitchy', 'lost').checks.find((c) => c.day === d2);
  assert.deepStrictEqual(ev2.missing, ['stone']);
  assert.strictEqual(ev2.res.stone.anchor, 500e9, 'what it should have been put back to');
  assert.strictEqual(ev2.res.stone.before, 10e9);
  assert.strictEqual(ev2.res.stone.after, 10e9);

  // the honesty gate
  assert.strictEqual(on(of('Plain', 'one'), d2), 'unclear', 'an account that was never put back is never blamed');
  assert.match(of('Plain', 'one').checks.find((c) => c.day === d2).why, /not on holiday/);
  assert.strictEqual(of('Plain', 'one').flagged, false);

  const api = await get('/api/resources/restore');
  assert.deepStrictEqual(api.notRestored.map((x) => x.label + '/' + x.city), ['Glitchy/lost']);
});

t('a town emptied before the record began shows up beside the rest of its account', async () => {
  const d2 = CR.dayKey(atOn(1, 12, 0));
  // two towns that are drained and put back, and one that sits at a sliver of them
  // on two resources and never moves — the mark a town sold dry long ago leaves
  for (const [city, day1, day2before, day2after] of [
    ['a1', res(0, 400e9, 400e9, 400e9, 0), res(0, 5e9, 400e9, 5e9, 0), res(0, 400e9, 400e9, 400e9, 0)],
    ['a2', res(0, 400e9, 400e9, 400e9, 0), res(0, 5e9, 400e9, 5e9, 0), res(0, 400e9, 400e9, 400e9, 0)],
    ['a3', res(0, 1e9, 400e9, 1e9, 0), res(0, 1e9, 400e9, 1e9, 0), res(0, 1e9, 400e9, 1e9, 0)],
  ]) {
    plant(atOn(2, 10, 0), 'starved-test', 'Starved', city, day1);
    plant(atOn(1, 7, 0), 'starved-test', 'Starved', city, day2before);
    plant(atOn(1, 10, 0), 'starved-test', 'Starved', city, day2after);
  }
  const rep = CR.restoreReport({ orgId: ORGID });
  const of = (city) => rep.towns.find((x) => x.label === 'Starved' && x.city === city);
  assert.strictEqual(of('a1').concern, null, 'a town that is put back is fine');
  assert.strictEqual(of('a3').concern, 'starved');
  assert.deepStrictEqual(of('a3').starvedRes, ['wood', 'iron'], 'stone is level with the others, so it is not counted');
  assert.strictEqual(of('a3').checks.find((c) => c.day === d2).verdict, 'no change',
    'it was never drained here — the case rests on how far below the rest it sits');
  assert.strictEqual(of('a3').median.wood, 400e9);
  // food and gold never decide it: troops eat one and everything costs the other
  assert.ok(!of('a3').starvedRes.includes('food') && !of('a3').starvedRes.includes('gold'));
});

t('the Resources tab shows the 08:30 mornings, and no glitch-towns section', async () => {
  if (browserOff) return 'skipped';
  await ev(`document.querySelector('.tab[data-p="resources"]').click()`);
  await ev(`loadResources()`);
  await until(() => ev(`!!RSM && document.querySelectorAll('#rsMornTbl tr').length > 1`), 10000, 'the mornings');
  const v = await ev(`(() => ({
    band: !!document.querySelector('#rsGlitchBand'),
    marks: document.querySelectorAll('#rsTable .rs-flag').length,
    mornCols: document.querySelectorAll('#rsMornTbl th').length,
    mornRow: [...document.querySelectorAll('#rsMornTbl tr')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim())[1] || '',
  }))()`);
  assert.strictEqual(v.band, false, 'the glitch-towns section was removed (user, 2026-09-22)');
  assert.strictEqual(v.marks, 0, 'no glitch markers in the city table');
  if (process.env.SHOT3) {
    const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(process.env.SHOT3, Buffer.from(shot.data, 'base64'));
  }
  assert.strictEqual(v.mornCols, 4, 'account, city, x,y and one morning');
  assert.match(v.mornRow, /^Alfamain10,10/, 'the morning row is the town and what it held at 08:30');
  assert.deepStrictEqual(pageErrors, [], 'the page threw nothing');
});

// ======================================================================= 7
section('the Uptime tab: a crashed console\'s old port does not haunt it');

// A trading console that runs out of memory gets restarted "plainly" on a new
// port every few hours (EVONY-RULES.md, 2026-09-20), and used to leave its old
// probe behind forever — one account then showed up as several ghost cards,
// most stuck at 0% up. `/api/uptime` must fold every row that names the same
// account into one series, whichever probe name or port it was recorded under,
// and `configured` must not offer the dead names as cards of their own.
// Not a real account — /api/uptime only ever groups on the accountId an uptime
// row carries, so a fleet account is not needed to prove the grouping works,
// and not creating one keeps the earlier "exactly 3 accounts" assertions true.
const DELTA_ID = 'delta-ghost-test';
t('old and new probe names for one account merge into a single series', async () => {
  const hour = 3600000;
  // Two restarts ago: a dead port, never seen again.
  ORG.uptime.add({ at: Date.now() - 3 * hour, probe: 'Delta', accountId: DELTA_ID,
    reachable: false, up: false, activity: false, label: 'Delta' });
  // One restart ago: a second dead port, registered under the disambiguated name.
  ORG.uptime.add({ at: Date.now() - 2 * hour, probe: `Delta (${DELTA_ID})`, accountId: DELTA_ID,
    reachable: false, up: false, activity: false, label: 'Delta' });
  // Now: up and running, on yet another port, under a name collision fell back to.
  const nowAt = Date.now() - 60000;
  ORG.uptime.add({ at: nowAt, probe: 'Delta2', accountId: DELTA_ID,
    reachable: true, up: true, activity: true, label: 'Delta' });
  // ...while the sampler asked the two dead ports in the same round, and a dead
  // probe writes a row with no account in it. That is not Delta being down.
  ORG.uptime.add({ at: nowAt, probe: 'Delta', reachable: false, up: false, activity: false });
  ORG.uptime.add({ at: nowAt, probe: `Delta (${DELTA_ID})`, reachable: false, up: false, activity: false });
  // The settings list still carries all three — exactly what registerProbe used
  // to leave behind before it started dropping a probe by accountId too.
  ORG.settings.set('probes', [
    ...ORG.settings.get('probes', []),
    { probe: 'Delta', url: 'http://localhost:1', accountId: DELTA_ID },
    { probe: `Delta (${DELTA_ID})`, url: 'http://localhost:2', accountId: DELTA_ID },
    { probe: 'Delta2', url: 'http://localhost:3', accountId: DELTA_ID },
  ]);

  const r = await get('/api/uptime?hours=24');
  const rows = r.summary.filter((s) => s.label === 'Delta');
  assert.strictEqual(rows.length, 1, 'Delta must appear once, not once per dead port');
  assert.strictEqual(rows[0].probe, 'Delta2', 'under its most recently used name');
  assert.strictEqual(rows[0].samples, 3, 'three sampling rounds, not one per dead port');
  assert.ok(rows[0].upPct > 0, 'the one round that is actually up must count');
  assert.strictEqual(rows[0].reachablePct, rows[0].upPct, 'the ghosts\' dead rows did not drag the live round down');

  const configuredNames = r.configured.map((p) => p.probe);
  assert.ok(!configuredNames.includes('Delta'), 'the oldest dead name is not offered as its own card');
  assert.ok(!configuredNames.includes(`Delta (${DELTA_ID})`), 'nor the second dead name');
  assert.ok(configuredNames.includes('Delta2'), 'only the live one is');
});

// A ghost that died before the window never answered in it, so none of its rows
// names an account — on 2026-09-22 that gave "Lord05" a red row of its own beside
// "Lord05 (a5)", for eight accounts. Its name still says whose it is.
t('a ghost that never answered in the window folds in by its name', async () => {
  // an account of its own, made last so the "exactly 3 accounts" tests above hold
  const E = ORG.accounts.upsert({ label: 'Echo', server: 'ss0' });
  const at = Date.now() - 5 * 60000;
  const live = `Echo (${E.id})`;
  ORG.uptime.add({ at, probe: live, accountId: E.id, reachable: true, up: true, activity: true, label: 'Echo' });
  ORG.uptime.add({ at, probe: 'Echo', reachable: false, up: false, activity: false });
  // another account answered on that port for a minute: the dead rows are still Echo's
  ORG.uptime.add({ at: at + 60000, probe: live, accountId: A.id, reachable: true, up: true, activity: true, label: 'Alfa' });
  ORG.uptime.add({ at: at + 120000, probe: live, reachable: false, up: false, activity: false });
  ORG.uptime.add({ at: at + 120000, probe: 'Echo', reachable: false, up: false, activity: false });

  const r = await get('/api/uptime?hours=1');
  const names = r.summary.map((s) => s.probe);
  assert.ok(!names.includes('Echo'), 'the bare ghost name has no row of its own: ' + names.join(', '));
  const row = r.summary.find((s) => s.probe === live);
  assert.ok(row, 'Echo has its row: ' + names.join(', '));
  assert.strictEqual(row.samples, 2, 'two rounds for Echo, the ghost rows folded in, not doubled');
  assert.strictEqual(row.label, 'Echo', 'and Alfa, answering on its port for a minute, is not drawn into its line');
});

// ---------------------------------------------------------------------------

(async () => {
  let pass = 0, fail = 0, skipped = 0;
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n + '\n'); continue; }
    try {
      const r = await f();
      if (r === 'skipped') { console.log('  skip  ' + n); skipped++; } else { console.log('  ok    ' + n); pass++; }
    } catch (e) { console.log('  FAIL  ' + n + '\n        ' + String((e && e.message) || e).split('\n').slice(0, 14).join('\n        ')); fail++; }
  }
  if (pageErrors.length) console.log('\n  page exceptions (not failures):\n    ' + [...new Set(pageErrors)].slice(0, 8).join('\n    '));
  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
  try { if (ws) ws.close(); } catch {}
  try { stub.close(); } catch {}
  // Consoles are detached on purpose, so they outlive this process unless the
  // test takes them down itself.
  for (const pid of [...KILLED, pidOf(C.id)]) { if (pid) { try { process.kill(pid); } catch {} } }
  try { if (chrome) chrome.kill(); } catch {}
  await sleep(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
