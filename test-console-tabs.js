'use strict';
// One tab per account. Clicking an account in the Director opened ANOTHER tab for it
// every single time (the user, 2026-09-22): the Director targets a tab named
// otto_bot_<id>, but every console page renamed its own tab 'evony_console' the moment
// it loaded, so the name was never found again. This drives the real director.html and
// the real app.html in headless Chrome and counts the tabs.
//
// Nothing here logs into the game and nothing touches the live Director on 8712 or the
// consoles: a temp database, a Director on its own port, console ports far from 8711,
// and the "console" is a stub that serves public/app.html and a canned header.
//
//   node test-console-tabs.js            (SKIP_BROWSER=1 to skip the Chrome half)
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const http = require('http'), { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-tabs-'));
process.env.EVONY_DB = path.join(TMP, 't.db');
process.env.DIRECTOR_PORT = '18741';
process.env.BOT_LOG_DIR = TMP;
process.env.BOT_PORT_BASE = '18871';        // nowhere near the live consoles
process.env.POLL_GAP_MS = '60000';
process.env.POLL_CYCLE_MS = '3600000';
process.env.POLL_FIRST_MS = '3600000';
process.env.UPTIME_MS = '1000';
process.env.KEEP_ON_MS = '3600000';
delete process.env.BOT_AUTOSTART;
delete process.env.BIND;

const PORT = 18741, CONSOLE_PORT = 18871;
const tests = [];
const t = (n, f) => tests.push([n, f]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, ms = 15000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(80);
  }
}

const D = require('./db');
const AUTH = require('./auth');
const op = AUTH.register({ email: 'op@example.com', password: 'correct horse battery', orgName: 'Tab Org' });
const ORG = D.org(op.org.id);
const SID = AUTH.newSession(op.user.id, op.org.id, '127.0.0.1', 'test');
const A = ORG.accounts.upsert({ label: 'Alfa', server: 'ss0', pos: 1, email: 'alfa@example.com' });
const B = ORG.accounts.upsert({ label: 'Bravo', server: 'ss0', pos: 2, email: 'bravo@example.com' });

// The console: the real page, and just enough API for it to paint a header.
const header = (acc) => ({
  ok: true, account: { id: acc.id, label: acc.label }, connected: true, state: 'connected',
  reason: null, retryInSec: null, attempt: 0, server: 'ss0', lord: acc.label,
  coins: 0, prestige: 0, honor: 0, rank: 0, serverTime: Date.now(), serverClock: null,
  clockOffset: 0, idleMs: 0, ticks: 0, logSeq: 1, reconnects: 0, cities: [],
  counts: { packages: 0, reports: 0, mail: 0 }, proc: { pid: 1, rssMb: 1, upSec: 1, accounts: 1 },
});
const consoleStub = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/' || u.pathname === '/app.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'app.html')));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(u.pathname === '/api/session' ? header(A) : {}));
});

ORG.settings.set('probes', [{ probe: 'Alfa', url: `http://127.0.0.1:${CONSOLE_PORT}`, accountId: A.id }]);
require('./director');

// ---- the page code itself, without a browser ----

t('both pages agree on the name of an account\'s tab', () => {
  const dir = fs.readFileSync(path.join(__dirname, 'public', 'director.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, 'public', 'app.html'), 'utf8');
  assert.match(dir, /const botTabName = \(id\) => 'otto_bot_' \+ id;/, 'the Director names the tab');
  assert.match(app, /const botTabName = \(id\) => 'otto_bot_' \+ id;/, 'and the console claims that same name');
  assert.ok(!/window\.name = 'evony_console'/.test(app), 'the old one-name-for-every-console is gone');
});

// ---- and in a real browser ----

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browserOff = process.env.SKIP_BROWSER === '1' || !fs.existsSync(CHROME);
let chrome = null, ws = null, cdpId = 0;
const pending = new Map();
function cdp(method, params = {}, sessionId) {
  const id = ++cdpId;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}
const ev = async (expr, sessionId) => {
  // userGesture: a click the browser treats as a person's, or window.open is blocked
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) throw new Error('page: ' + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
  return r.result.value;
};
const pages = async () => (await cdp('Target.getTargets')).targetInfos.filter((x) => x.type === 'page');
const consoleTabs = async () => (await pages()).filter((p) => p.url.includes(`:${CONSOLE_PORT}`));

t('clicking an account opens its console once, and again only focuses it', async () => {
  if (browserOff) return 'skipped';
  await new Promise((r) => consoleStub.listen(CONSOLE_PORT, '127.0.0.1', r));
  const port = 9520 + Math.floor(Math.random() * 40);
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(TMP, 'chrome')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  const list = await until(async () => {
    try {
      return await new Promise((res, rej) => http.get(`http://127.0.0.1:${port}/json/list`, (r) => {
        let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b)));
      }).on('error', rej));
    } catch { return null; }
  }, 20000, 'Chrome');

  ws = new WebSocket(list.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const pr = pending.get(m.id); pending.delete(m.id);
      if (m.error) pr.reject(new Error(pr.method + ': ' + m.error.message)); else pr.resolve(m.result);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Network.enable');
  await cdp('Network.setCookie', { name: 'otto_sid', value: SID, url: `http://127.0.0.1:${PORT}/` });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });

  // the Director has to have found the console before its name is a link
  await until(() => ev(`!!document.querySelector('a.focus[target="otto_bot_${A.id}"]')`), 20000, 'the account link');

  const before = (await pages()).length;
  await ev(`document.querySelector('a.focus[target="otto_bot_${A.id}"]').click()`);
  await until(async () => (await consoleTabs()).length === 1, 15000, 'the console tab');
  assert.strictEqual((await pages()).length, before + 1, 'exactly one tab opened');

  // it loads and claims the name the Director targets
  const tab = (await consoleTabs())[0];
  const { sessionId } = await cdp('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
  await cdp('Runtime.enable', {}, sessionId);
  const name = await until(async () => {
    const n = await ev('window.name', sessionId);
    return n === `otto_bot_${A.id}` ? n : null;
  }, 20000, 'the console tab to claim its name');
  assert.strictEqual(name, `otto_bot_${A.id}`);

  // A mark in the tab: if the second click RELOADED the console instead of just
  // bringing it forward, the mark is gone — and so is whatever you had open in it.
  await ev('window.__stillHere = "yes"', sessionId);

  // click it again: the same tab, no new one — which is the whole point
  await ev(`document.querySelector('a.focus[target="otto_bot_${A.id}"]').click()`);
  await sleep(1200);
  assert.strictEqual((await consoleTabs()).length, 1, 'still one console tab for this account');
  assert.strictEqual((await pages()).length, before + 1, 'and no new tab anywhere');
  assert.strictEqual((await consoleTabs())[0].targetId, tab.targetId, 'the very same tab');
  assert.strictEqual(await ev('window.__stillHere', sessionId), 'yes', 'brought forward, not reloaded');

  // a different account is a different tab
  ORG.settings.set('probes', [
    { probe: 'Alfa', url: `http://127.0.0.1:${CONSOLE_PORT}`, accountId: A.id },
    { probe: 'Bravo', url: `http://127.0.0.1:${CONSOLE_PORT}`, accountId: B.id },
  ]);
  assert.strictEqual(await ev(`botTabName('${B.id}')`), `otto_bot_${B.id}`, 'named after the account, not the port');
});

t('a click through the row (not the link) uses that same tab', async () => {
  if (browserOff) return 'skipped';
  const tabs = await consoleTabs();
  await ev(`focusBot(DATA.accounts.find((a) => a.id === '${A.id}'))`);
  await sleep(1200);
  const after = await consoleTabs();
  assert.strictEqual(after.length, tabs.length, 'no extra tab');
  assert.strictEqual(after[0].targetId, tabs[0].targetId, 'the same one');
});

(async () => {
  let pass = 0, fail = 0, skip = 0;
  for (const [n, f] of tests) {
    if (!f) { console.log('\n== ' + n + '\n'); continue; }
    try { const r = await f(); if (r === 'skipped') { console.log('  --    ' + n + ' (skipped)'); skip++; } else { console.log('  ok    ' + n); pass++; } }
    catch (e) { console.log('  FAIL  ' + n + '\n        ' + String((e && e.stack) || e).split('\n').slice(0, 5).join('\n        ')); fail++; }
  }
  try { consoleStub.close(); } catch {}
  try { if (chrome) chrome.kill(); } catch {}
  console.log(`\n${pass} passed, ${fail} failed${skip ? ', ' + skip + ' skipped' : ''}\n`);
  process.exit(fail ? 1 : 0);
})();
