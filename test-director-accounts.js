'use strict';
// The Director's Accounts tab (account management), offline:
//   1. the org's account store keeps a security code (it used to drop it: the
//      ✎ dialog's field saved nothing)
//   2. the real public/director.html in headless Chrome over CDP: the grid
//      lists every field, a cell is edited with the keys and saved at once,
//      Esc cancels, Tab and Enter move on, Fill down, Apply to all (every row
//      and the ticked ones), Undo, moving a row, the dropdowns, Delete
//
// Nothing here logs into the game and nothing touches the live Director on
// 8712 or the consoles: the accounts below have no credentials, so no console
// can be spawned for them, and there are no uptime probes to ask.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const http = require('http'), { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-accts-'));
process.env.EVONY_DB = path.join(TMP, 't.db');
process.env.DIRECTOR_PORT = '18733';
process.env.BOT_LOG_DIR = TMP;
process.env.BOT_PORT_BASE = '18861';
process.env.POLL_GAP_MS = '60000';
process.env.POLL_CYCLE_MS = '3600000';
process.env.POLL_FIRST_MS = '3600000';
process.env.UPTIME_MS = '3600000';
process.env.KEEP_ON_MS = '3600000';
delete process.env.BOT_AUTOSTART;
delete process.env.BIND;                 // loopback: goal files are offered

const PORT = 18733;
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
const op = AUTH.register({ email: 'op@example.com', password: 'correct horse battery', orgName: 'Grid Org' });
const ORG = D.org(op.org.id);
ORG.settings.set('probes', []);
const SID = AUTH.newSession(op.user.id, op.org.id, '127.0.0.1', 'test');

const A = ORG.accounts.upsert({ label: 'Alfa', server: 'ss0', pos: 2, email: 'alfa@example.com', notes: '' });
const B = ORG.accounts.upsert({ label: 'Bravo', server: 'ss0', pos: 1, email: 'bravo@example.com', password: 'hunter2' });
const C = ORG.accounts.upsert({ label: 'Charlie', server: 'ss0', pos: 3, email: 'charlie@example.com' });
const PREPEND = path.join(TMP, 'prepend-goals.txt');
fs.writeFileSync(PREPEND, '# a goals file for the grid test\n');

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
section('the security code is kept');

t('the Director is up', async () => {
  await until(async () => (await call('GET', '/api/accounts')).status === 200, 8000, 'the Director');
  assert.strictEqual((await get('/api/accounts')).accounts.length, 3);
});

t('a security code saved through the org store is there afterwards', async () => {
  const r = await post('/api/account', { id: A.id, securityCode: '4321' });
  assert.strictEqual(r.json.ok, true, r.body);
  assert.strictEqual((await accOf(A.id)).securityCode, '4321');
});

t('a save that says nothing about it leaves it alone; blank clears it', async () => {
  await post('/api/account', { id: A.id, notes: 'still here' });
  assert.strictEqual((await accOf(A.id)).securityCode, '4321');
  await post('/api/account', { id: A.id, securityCode: '' });
  assert.ok(!(await accOf(A.id)).securityCode, 'cleared');
  await post('/api/account', { id: A.id, notes: '' });
});

// ======================================================================= 2
section('the Accounts tab, in headless Chrome over CDP');

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
// Real key presses, the way a person makes them, so the grid's own handlers and
// the browser's text entry both run.
const VK = { Enter: 13, Escape: 27, Tab: 9, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, ' ': 32, F2: 113, Home: 36, End: 35 };
async function key(k, { ctrl = false, shift = false, alt = false } = {}) {
  const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
  const printable = k.length === 1;
  const vk = VK[k] !== undefined ? VK[k] : k.toUpperCase().charCodeAt(0);
  const base = { modifiers, key: printable && shift ? k.toUpperCase() : k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    code: printable ? (k === ' ' ? 'Space' : 'Key' + k.toUpperCase()) : k };
  const text = printable && !ctrl && !alt;
  await cdp('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text: k, unmodifiedText: k } : {}) });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
async function type(s) { for (const ch of s) await key(ch); }
const cur = () => ev(`(() => { const td = document.querySelector('#amTbl td.cur'); return td ? { id: td.closest('tr').dataset.id, c: Number(td.dataset.c), key: amCols()[Number(td.dataset.c)].key, editing: !!AM.editing } : null; })()`);
const colIndex = (k) => ev(`amCols().findIndex((c) => c.key === '${k}')`);
// go to a cell by account and column, with the arrow keys only
async function goTo(id, k) {
  const c = await colIndex(k);
  for (let i = 0; i < 40; i++) {
    const at = await cur();
    if (!at) throw new Error('no cell selected');
    if (at.id === id && at.c === c) return;
    const rows = await ev(`AM.rows.map((a) => a.id)`);
    const dr = rows.indexOf(id) - rows.indexOf(at.id);
    if (dr) await key(dr > 0 ? 'ArrowDown' : 'ArrowUp');
    else await key(c > at.c ? 'ArrowRight' : 'ArrowLeft');
  }
  throw new Error(`could not reach ${id} / ${k}`);
}
const askOpen = () => ev(`!!document.querySelector('dialog.ask[open]')`);
const askText = () => ev(`(document.querySelector('dialog.ask[open] .ask-body') || {}).textContent || ''`);
const askOk = () => ev(`document.querySelector('dialog.ask[open] button[value="ok"]').click()`);
const status = () => ev(`$('#amStatus').textContent`);
const browserOff = process.env.SKIP_BROWSER === '1' || !fs.existsSync(CHROME);

t('the Accounts tab lists every account in sort order', async () => {
  if (browserOff) return 'skipped';
  const port = 9460 + Math.floor(Math.random() * 40);
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(TMP, 'chrome')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1600,900', 'about:blank'], { stdio: 'ignore' });
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
    await until(() => ev(`document.querySelectorAll('#tbl tbody tr[data-id]').length === 3`), 15000, 'the fleet rows');
    await ev(`document.querySelector('.tab[data-p="accounts"]').click()`);
    await until(() => ev(`document.querySelectorAll('#amTbl tbody tr[data-id]').length === 3`), 8000, 'the grid rows');
  } catch (e) {
    throw new Error(e.message + (pageErrors.length ? ' — the page threw: ' + pageErrors.join(' | ') : ''));
  }
  assert.strictEqual(await ev(`$('#pageAccounts').hidden`), false);
  assert.strictEqual(await ev(`$('#pageFleet').hidden`), true);
  const order = await ev(`[...document.querySelectorAll('#amTbl tbody tr[data-id]')].map((tr) => tr.dataset.id)`);
  assert.deepStrictEqual(order, [B.id, A.id, C.id], 'Bravo is 1, Alfa 2, Charlie 3');
});

t('every field of the ✎ dialog has a column', async () => {
  if (browserOff) return 'skipped';
  const heads = await ev(`[...document.querySelectorAll('#amTbl thead th')].map((th) => th.textContent.trim()).filter(Boolean)`);
  for (const h of ['Account', 'On', 'Keep on', 'Server', 'Email', 'Password', 'Security code', 'Notes', 'Proxy', 'After maintenance',
    'Autorun scripts', 'Start-up parameters', 'Prepend goals file', 'Append goals file', 'Order', 'Status']) {
    assert.ok(heads.includes(h), `a ${h} column (have: ${heads.join(', ')})`);
  }
  const bravo = await ev(`(() => { const tr = document.querySelector('#amTbl tbody tr[data-id="${B.id}"]');
    return Object.fromEntries(amCols().map((c, i) => [c.key, tr.children[i].textContent.trim()])); })()`);
  assert.strictEqual(bravo.label, 'Bravo');
  assert.strictEqual(bravo.email, 'bravo@example.com');
  assert.strictEqual(bravo.password, 'hunter2', 'passwords are shown');
  assert.strictEqual(bravo.server, 'ss0');
  assert.strictEqual(bravo.pos, '1');
  assert.match(bravo._status, /no bot/);
  assert.match(bravo.proxy, /^random · socks5:\/\//, 'a new account is on a random proxy, and the cell says which');
  assert.match(bravo.autoscripts, /As every account/);
  // SHOT=<file.png> keeps a picture of the tab, for looking at the layout
  if (process.env.SHOT) {
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.SHOT, Buffer.from(shot.data, 'base64'));
  }
});

t('random proxies: each account its own line, and Random is what a new account starts on', async () => {
  if (browserOff) return 'skipped';
  const accts = (await get('/api/accounts')).accounts;
  assert.ok(accts.every((a) => a.proxy === 'random'), accts.map((a) => a.proxy).join(' '));
  const lines = accts.map((a) => a.proxyRaw);
  assert.ok(lines.every(Boolean), 'each has a pick');
  assert.strictEqual(new Set(lines).size, lines.length, 'no two share one');
  const v = await ev(`(() => { openDlg(null); const v = { value: $('#frm').proxy.value, first: $('#frm').proxy.options[0].textContent };
    $('#dlg').close(); return v; })()`);
  assert.strictEqual(v.value, 'random', 'the Add account dialog starts on Random');
  assert.match(v.first, /^Random/);
  const own = await ev(`(() => { openDlg(DATA.accounts.find((a) => a.id === '${B.id}')); const v = $('#frm').proxy.value;
    const taken = [...$('#frm').proxy.options].filter((o) => /in use by Alfa/.test(o.textContent)).length; $('#dlg').close(); return { v, taken }; })()`);
  assert.strictEqual(own.v, 'random');
  assert.strictEqual(own.taken, 1, "Alfa's line says it is Alfa's");
});

t('pinning an account onto another one\'s line is flagged as shared', async () => {
  if (browserOff) return 'skipped';
  const alfa = await accOf(A.id);
  await post('/api/account', { id: C.id, proxy: alfa.proxyRaw });
  await ev('refresh()');
  const cells = await ev(`(() => { const i = amCols().findIndex((c) => c.key === 'proxy');
    return ['${A.id}', '${C.id}'].map((id) => document.querySelector('#amTbl tbody tr[data-id="' + id + '"] td[data-c="' + i + '"]').textContent); })()`);
  // the pin wins, so Alfa's random pick moves off it and nothing is shared any more
  assert.ok(!/shared/.test(cells[0]) && !/shared/.test(cells[1]), cells.join(' | '));
  assert.notStrictEqual((await accOf(A.id)).proxyRaw, alfa.proxyRaw, 'Alfa moved');
  // a pin onto a PINNED account's line is shared, and says so
  await post('/api/account', { id: A.id, proxy: alfa.proxyRaw });
  await ev('refresh()');
  const both = await ev(`(() => { const i = amCols().findIndex((c) => c.key === 'proxy');
    return ['${A.id}', '${C.id}'].map((id) => document.querySelector('#amTbl tbody tr[data-id="' + id + '"] td[data-c="' + i + '"]').textContent); })()`);
  assert.ok(both.every((c) => /shared/.test(c)), both.join(' | '));
  await post('/api/account', { id: A.id, proxy: 'random' });
  await post('/api/account', { id: C.id, proxy: 'random' });
  await ev('refresh()');
});

t('passwords can be hidden', async () => {
  if (browserOff) return 'skipped';
  await ev(`(() => { $('#amShowPw').checked = false; $('#amShowPw').onchange(); })()`);
  const pw = await ev(`document.querySelector('#amTbl tbody tr[data-id="${B.id}"] td[data-c="' + amCols().findIndex((c) => c.key === 'password') + '"]').textContent.trim()`);
  assert.strictEqual(pw, '••••••');
  await ev(`(() => { $('#amShowPw').checked = true; $('#amShowPw').onchange(); })()`);
});

t('the arrow keys move the selected cell', async () => {
  if (browserOff) return 'skipped';
  await ev(`$('#amWrap').focus()`);
  let at = await cur();
  assert.strictEqual(at.id, B.id, 'starts on the first row');
  assert.strictEqual(at.key, 'label', 'on the account name');
  await key('ArrowRight'); await key('ArrowRight'); await key('ArrowRight');
  at = await cur();
  assert.strictEqual(at.key, 'server');
  await key('ArrowDown');
  at = await cur();
  assert.strictEqual(at.id, A.id, 'down a row');
  assert.strictEqual(at.key, 'server', 'same column');
  await key('ArrowUp');
});

t('typing into a cell and Enter saves it and moves down', async () => {
  if (browserOff) return 'skipped';
  await goTo(B.id, 'server');
  await type('ss9');
  assert.strictEqual((await cur()).editing, true, 'typing opened the editor');
  assert.strictEqual(await ev(`document.querySelector('#amTbl td.ed input').value`), 'ss9', 'over the old value, not after it');
  await key('Enter');
  await until(async () => (await accOf(B.id)).server === 'ss9', 8000, 'the server to be saved');
  await until(() => ev(`/server saved/.test($('#amStatus').textContent)`), 8000, 'the page to say so');
  const at = await cur();
  assert.strictEqual(at.id, A.id, 'moved down a row');
  assert.strictEqual(at.editing, false);
  assert.strictEqual(await ev(`document.querySelector('#amTbl tbody tr[data-id="${B.id}"] td[data-c="' + amCols().findIndex((c) => c.key === 'server') + '"]').textContent.trim()`), 'ss9', 'and shows it');
});

t('Esc cancels an edit', async () => {
  if (browserOff) return 'skipped';
  await goTo(A.id, 'server');
  await key('Enter');
  assert.strictEqual((await cur()).editing, true);
  await key('Escape');
  assert.strictEqual((await cur()).editing, false);
  await type('zz');
  await key('Escape');
  await sleep(200);
  assert.strictEqual((await accOf(A.id)).server, 'ss0', 'nothing saved');
  assert.strictEqual((await cur()).key, 'server', 'and the cell stays selected');
});

t('Tab saves and moves right', async () => {
  if (browserOff) return 'skipped';
  await goTo(A.id, 'server');
  await type('ss1');
  await key('Tab');
  const at = await cur();
  assert.strictEqual(at.id, A.id);
  assert.strictEqual(at.key, 'email', 'the next column, at once');
  assert.strictEqual(at.editing, false);
  await until(async () => (await accOf(A.id)).server === 'ss1', 8000, 'the server to be saved');
});

t('a blank account name is refused', async () => {
  if (browserOff) return 'skipped';
  await goTo(A.id, 'label');
  await key('Delete');
  assert.strictEqual(await ev(`document.querySelector('#amTbl td.ed input').value`), '', 'Delete opens the editor empty');
  await key('Enter');
  await until(() => ev(`/needs a name/.test($('#amStatus').textContent)`), 4000, 'the refusal');
  assert.strictEqual((await accOf(A.id)).label, 'Alfa');
});

t('Fill down copies the cell above', async () => {
  if (browserOff) return 'skipped';
  await post('/api/account', { id: B.id, notes: 'parked' });
  await ev('refresh()');
  await goTo(A.id, 'notes');
  await key('d', { ctrl: true });
  await until(async () => (await accOf(A.id)).notes === 'parked', 8000, 'the note to be copied down');
  await key('d', { ctrl: true });
  await until(() => ev(`/Already the same/.test($('#amStatus').textContent)`), 4000, 'nothing to do the second time');
});

t('Apply to all takes a goals file to every account, after a confirm', async () => {
  if (browserOff) return 'skipped';
  await post('/api/account', { id: B.id, prependFile: PREPEND });
  await ev('refresh()');
  assert.strictEqual((await accOf(B.id)).prependFile, PREPEND);
  await goTo(B.id, 'prependFile');
  await key('a', { ctrl: true, shift: true });
  await until(askOpen, 4000, 'the confirm box');
  const text = await askText();
  assert.match(text, /prepend goals file/);
  assert.match(text, /2 listed accounts/);
  assert.match(text, /Alfa, Charlie/);
  await askOk();
  await until(async () => {
    const all = (await get('/api/accounts')).accounts;
    return all.every((a) => a.prependFile === PREPEND);
  }, 10000, 'every account to have the file');
  await until(() => ev(`/set to .* on 2 accounts/.test($('#amStatus').textContent)`), 8000, 'the page to say so');
});

t('Undo puts the last change back on every account it touched', async () => {
  if (browserOff) return 'skipped';
  await key('z', { ctrl: true });
  await until(async () => {
    const a = await accOf(A.id), c = await accOf(C.id), b = await accOf(B.id);
    return !a.prependFile && !c.prependFile && b.prependFile === PREPEND;
  }, 10000, 'the two files to be cleared and Bravo\'s kept');
  await until(() => ev(`/Undone: 2 changes/.test($('#amStatus').textContent)`), 4000, 'the page to say so');
});

t('with rows ticked, Apply to all goes to those only', async () => {
  if (browserOff) return 'skipped';
  await goTo(B.id, 'notes');
  await type('alt');
  await key('Enter');
  await until(async () => (await accOf(B.id)).notes === 'alt', 8000, 'the note');
  await ev(`document.querySelector('#amTbl tbody tr[data-id="${C.id}"] .am-tick').click()`);
  assert.strictEqual(await ev(`AM.ticked.has('${C.id}')`), true);
  await goTo(B.id, 'notes');
  await key('a', { ctrl: true, shift: true });
  await until(askOpen, 4000, 'the confirm box');
  assert.match(await askText(), /1 ticked account/);
  await askOk();
  await until(async () => (await accOf(C.id)).notes === 'alt', 8000, 'Charlie to get it');
  assert.strictEqual((await accOf(A.id)).notes, 'parked', 'Alfa, not ticked, was left alone');
  await ev(`document.querySelector('#amTbl tbody tr[data-id="${C.id}"] .am-tick').click()`);
  assert.strictEqual(await ev(`AM.ticked.size`), 0);
});

t('a name is not applied to all', async () => {
  if (browserOff) return 'skipped';
  await goTo(B.id, 'label');
  await key('a', { ctrl: true, shift: true });
  await until(() => ev(`/each account's own/.test($('#amStatus').textContent)`), 4000, 'the refusal');
  assert.strictEqual(await askOpen(), false, 'no confirm box');
});

t('the autorun dropdown writes -autoscripts into the start-up parameters', async () => {
  if (browserOff) return 'skipped';
  await goTo(B.id, 'autoscripts');
  await key('Enter');
  assert.strictEqual(await ev(`!!document.querySelector('#amTbl td.ed select')`), true, 'a dropdown opened');
  await ev(`(() => { const s = document.querySelector('#amTbl td.ed select'); s.value = '1'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(150);
  assert.strictEqual((await accOf(B.id)).startupParms, '', 'a value stepped to with the keys is not saved until Enter');
  await key('Enter');
  await until(async () => (await accOf(B.id)).startupParms === '-autoscripts 1', 8000, 'the parameter');
  await until(() => ev(`/start-up parameters saved/.test($('#amStatus').textContent)`), 4000, 'the page to say when it applies');
  const shown = await ev(`document.querySelector('#amTbl tbody tr[data-id="${B.id}"] td[data-c="' + amCols().findIndex((c) => c.key === 'autoscripts') + '"]').textContent.trim()`);
  assert.strictEqual(shown, 'On');
});

t('the switches on the row are the account\'s own settings', async () => {
  if (browserOff) return 'skipped';
  await goTo(C.id, 'keepOn');
  await key(' ');
  await until(async () => (await accOf(C.id)).keepOn === true, 8000, 'keep on to be set');
  // a second press before the page has caught up is still a second flip
  await key(' ');
  await until(async () => (await accOf(C.id)).keepOn === false, 8000, 'keep on to be cleared');
  await until(() => ev(`(() => { const b = document.querySelectorAll('#amTbl tbody tr[data-id="${C.id}"] .am-bool'); return b.length === 2 && !b[1].checked; })()`), 8000, 'the box to show it');
  await goTo(C.id, 'enabled');
  await key(' ');
  await until(async () => (await accOf(C.id)).enabled === false, 10000, 'the account to go off');
  await until(() => ev(`document.querySelector('#amTbl tbody tr[data-id="${C.id}"]').classList.contains('off')`), 8000, 'the row to grey');
  await key(' ');
  await until(async () => (await accOf(C.id)).enabled === true, 15000, 'and back on');
});

t('Alt+↓ moves the row down and renumbers', async () => {
  if (browserOff) return 'skipped';
  await goTo(B.id, 'label');
  await key('ArrowDown', { alt: true });
  await until(async () => (await accOf(B.id)).pos === 2 && (await accOf(A.id)).pos === 1, 8000, 'Alfa and Bravo to swap');
  assert.strictEqual((await accOf(C.id)).pos, 3, 'Charlie was not touched');
  const order = await ev(`[...document.querySelectorAll('#amTbl tbody tr[data-id]')].map((tr) => tr.dataset.id)`);
  assert.deepStrictEqual(order, [A.id, B.id, C.id]);
  assert.strictEqual((await cur()).id, B.id, 'the selection follows the row');
});

t('the filter narrows the rows', async () => {
  if (browserOff) return 'skipped';
  await ev(`(() => { $('#amQ').value = 'charlie'; $('#amQ').dispatchEvent(new Event('input')); })()`);
  assert.deepStrictEqual(await ev(`[...document.querySelectorAll('#amTbl tbody tr[data-id]')].map((tr) => tr.dataset.id)`), [C.id]);
  await ev(`(() => { $('#amQ').value = ''; $('#amQ').dispatchEvent(new Event('input')); })()`);
  assert.strictEqual(await ev(`document.querySelectorAll('#amTbl tbody tr[data-id]').length`), 3);
});

t('Delete asks first, then removes the account', async () => {
  if (browserOff) return 'skipped';
  await goTo(C.id, '_del');
  await key('Enter');
  await until(askOpen, 4000, 'the confirm box');
  assert.match(await askText(), /Delete Charlie\?/);
  await askOk();
  await until(async () => (await get('/api/accounts')).accounts.length === 2, 10000, 'Charlie to go');
  await until(() => ev(`document.querySelectorAll('#amTbl tbody tr[data-id]').length === 2`), 8000, 'the row to go');
});

t('the ✎ dialog\'s Browse still fills its own box', async () => {
  if (browserOff) return 'skipped';
  assert.strictEqual(await ev(`typeof browsePick`), 'function');
  const v = await ev(`(() => { openDlg(DATA.accounts.find((a) => a.id === '${B.id}'));
    browsePick('', (p) => { $('#frm').prependFile.value = p; });
    browseFor('C:\\\\x\\\\y.txt'); const v = $('#frm').prependFile.value; $('#browseDlg').close(); $('#dlg').close(); return v; })()`);
  assert.strictEqual(v, 'C:\\x\\y.txt');
});

t('the refresh under an open editor leaves it alone', async () => {
  if (browserOff) return 'skipped';
  await goTo(B.id, 'notes');
  await key('Enter');
  await ev('refresh()');
  assert.strictEqual((await cur()).editing, true, 'still editing');
  assert.strictEqual(await ev(`!!document.querySelector('#amTbl td.ed input')`), true);
  await key('Escape');
});

(async () => {
  let pass = 0, fail = 0, skipped = 0;
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n); continue; }
    try {
      const r = await f();
      if (r === 'skipped') { console.log('  skip  ' + n); skipped++; } else { console.log('  ok    ' + n); pass++; }
    } catch (e) { console.log('  FAIL  ' + n + '\n        ' + String((e && e.message) || e).split('\n').slice(0, 14).join('\n        ')); fail++; }
  }
  if (pageErrors.length) console.log('\n  page exceptions (not failures):\n    ' + [...new Set(pageErrors)].slice(0, 8).join('\n    '));
  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
  try { if (ws) ws.close(); } catch {}
  try { if (chrome) chrome.kill(); } catch {}
  await sleep(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
