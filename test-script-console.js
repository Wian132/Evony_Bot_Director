'use strict';
// The console's side of scripts, offline:
//   1. script-console.js on its own (files, call, autorun, say/play queue)
//   2. `call` through the real VM
//   3. the real server.js on port 8799 with a stub Session and a temp database:
//      the editor's line check, the Run box, stop/Resume, call, say/play, the
//      in-line command line and autorun
//   4. the real page in headless Chrome over CDP (skipped with SKIP_BROWSER=1)
// Nothing here logs in, and nothing touches ports 8711/8713.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const http = require('http'), { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-sconsole-'));
process.env.EVONY_DB = path.join(TMP, 't.db');
process.env.EVONY_SCRIPTS_DIR = path.join(TMP, 'scripts');
process.env.EVONY_MEDIA_DIR = path.join(TMP, 'media');
process.env.EVONY_CMDPARMS = path.join(TMP, 'CmdParms.txt');
process.env.CONSOLE_PORT = '8799';
for (const k of ['ACCOUNT_ID', 'AUTOSCRIPTS', 'RUNSCRIPT', 'BIND']) delete process.env[k];
fs.mkdirSync(process.env.EVONY_SCRIPTS_DIR);
fs.mkdirSync(process.env.EVONY_MEDIA_DIR);

const SC = require('./script-console');
const script = require('./script');
const C = require('./constants');
const { Game } = require('./game');

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
const throws = (f, re) => { try { f(); } catch (e) { assert.match(e.message, re); return; } assert.fail('no error, wanted ' + re); };

// ======================================================================= 1
section('script-console.js: files');

t('a plain name, or one in a sub-folder, is a file in the scripts folder', () => {
  assert.strictEqual(SC.scriptFile('UseItems.txt'), path.join(SC.SCRIPTS_DIR, 'UseItems.txt'));
  assert.strictEqual(SC.scriptFile('sub/a b.txt'), path.join(SC.SCRIPTS_DIR, 'sub', 'a b.txt'));
  assert.strictEqual(SC.scriptFile('sub\\a.txt'), path.join(SC.SCRIPTS_DIR, 'sub', 'a.txt'));
});
t('.., full paths, drives, URLs, odd characters and device names are refused', () => {
  for (const n of ['../x.txt', 'a/../../x', '..\\x', 'C:\\x.txt', 'c:x', '/etc/passwd', '\\\\srv\\share\\x', 'http://x/y.txt',
    'a:b', 'x;y', '.', '...', 'a/./b', 'CON', 'nul.txt', 'sub/COM1', '']) {
    assert.throws(() => SC.scriptFile(n), /only files in the console's scripts folder/, n);
  }
});
t('a missing file reads as null; a present one as its text', () => {
  fs.writeFileSync(path.join(SC.SCRIPTS_DIR, 'hello.txt'), 'echo "from a file"');
  assert.strictEqual(SC.readScriptFile('hello.txt'), 'echo "from a file"');
  assert.strictEqual(SC.readScriptFile('nothere.txt'), null);
  assert.throws(() => SC.readScriptFile('../t.db'), /no \.\./);
});
// Links under the folder: a junction needs no admin rights on Windows, so the
// name's text alone cannot keep a read inside the folder.
const OUTSIDE = path.join(TMP, 'outside');
fs.mkdirSync(OUTSIDE);
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'TOP SECRET');
fs.writeFileSync(path.join(OUTSIDE, 'boom.mp3'), 'not a sound');
const LINKS = [];
const junction = (target, at) => { fs.symlinkSync(target, at, 'junction'); LINKS.push(at); return at; };
const unlinkAll = () => { while (LINKS.length) { const l = LINKS.pop(); try { fs.rmdirSync(l); } catch { try { fs.unlinkSync(l); } catch { /* gone */ } } } };
t('a junction in the scripts folder is refused, whatever the rest of the name', () => {
  try {
    junction(OUTSIDE, path.join(SC.SCRIPTS_DIR, 'link'));
    for (const n of ['link/secret.txt', 'link\\secret.txt', 'link', 'link/none.txt', 'link/x/y.txt']) {
      throws(() => SC.scriptFile(n), /"link" is a link \(symlink or junction\)/);
    }
    throws(() => SC.readScriptFile('link/secret.txt'), /is a link/);
    throws(() => SC.resolveCall('link/secret.txt', [{ slot: 1, src: 'echo 1' }]), /is a link/);
    // deeper: a real sub-folder holding a junction
    fs.mkdirSync(path.join(SC.SCRIPTS_DIR, 'sub2'));
    junction(OUTSIDE, path.join(SC.SCRIPTS_DIR, 'sub2', 'deep'));
    throws(() => SC.readScriptFile('sub2/deep/secret.txt'), /"deep" is a link/);
    // even one that points back into the folder
    junction(SC.SCRIPTS_DIR, path.join(SC.SCRIPTS_DIR, 'self'));
    throws(() => SC.scriptFile('self/hello.txt'), /"self" is a link/);
    // a folder beside it whose name starts the same is still outside
    fs.mkdirSync(SC.SCRIPTS_DIR + '-x');
    fs.writeFileSync(path.join(SC.SCRIPTS_DIR + '-x', 'a.txt'), 'beside');
    junction(SC.SCRIPTS_DIR + '-x', path.join(SC.SCRIPTS_DIR, 'near'));
    throws(() => SC.readScriptFile('near/a.txt'), /"near" is a link/);
  } finally { unlinkAll(); }
  assert.strictEqual(fs.readFileSync(path.join(OUTSIDE, 'secret.txt'), 'utf8'), 'TOP SECRET', 'removing the links left their targets alone');
  assert.strictEqual(SC.readScriptFile('sub2/none.txt'), null, 'a real sub-folder is fine');
});
t('a junction in the media folder is refused the same way', () => {
  try {
    junction(OUTSIDE, path.join(SC.MEDIA_DIR, 'snd'));
    throws(() => SC.mediaFile('snd/boom.mp3'), /"snd" is a link/);
    throws(() => SC.mediaFile('media/snd/boom.mp3'), /"snd" is a link/);
  } finally { unlinkAll(); }
});
t('a file symlink is refused too (skipped where this user may not make one)', () => {
  const at = path.join(SC.SCRIPTS_DIR, 'f.txt');
  try { fs.symlinkSync(path.join(OUTSIDE, 'secret.txt'), at, 'file'); } catch (e) { if (e.code === 'EPERM') return 'skipped'; throw e; }
  LINKS.push(at);
  try { throws(() => SC.readScriptFile('f.txt'), /"f\.txt" is a link/); } finally { unlinkAll(); }
});
t('a scripts folder that is itself a junction still works — the operator chose it', () => {
  const key = require.resolve('./script-console'), mine = require.cache[key], was = process.env.EVONY_SCRIPTS_DIR;
  const real = path.join(TMP, 'real-scripts');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'in.txt'), 'inside');
  const at = junction(real, path.join(TMP, 'scripts-link'));
  try {
    delete require.cache[key];
    process.env.EVONY_SCRIPTS_DIR = at;
    const SC2 = require('./script-console');
    assert.strictEqual(SC2.readScriptFile('in.txt'), 'inside');
    assert.strictEqual(SC2.readScriptFile('none.txt'), null);
  } finally {
    process.env.EVONY_SCRIPTS_DIR = was;
    require.cache[key] = mine;              // everything else keeps the first one
    unlinkAll();
  }
});
t('sounds come from the media folder; NEAT\'s media/ prefix is the same folder', () => {
  assert.deepStrictEqual(SC.mediaFile('media/SingleAttack.mp3'), { file: path.join(SC.MEDIA_DIR, 'SingleAttack.mp3'), rel: 'SingleAttack.mp3' });
  assert.strictEqual(SC.mediaFile('alarm.wav').rel, 'alarm.wav');
  throws(() => SC.mediaFile('x.exe'), /a sound is an \.mp3/);
  throws(() => SC.mediaFile('../t.db'), /only files in the console's media folder/);
  throws(() => SC.mediaFile('C:\\Windows\\x.mp3'), /not a full path/);
});

section('script-console.js: call');

const SLOTS = [
  { slot: 1, src: '// Farm upgrades\necho "one"' },
  { slot: 3, src: 'echo "three"' },
  { slot: 4, src: '// a loadout whose name is much longer than thirty characters\necho "four"' },
];
t('by slot: 3, load3, Load 3', () => {
  for (const n of ['3', 'load3', 'Load 3', 'LOAD3']) assert.deepStrictEqual(SC.resolveCall(n, SLOTS), { src: 'echo "three"', from: 'Load 3' }, n);
});
t('an empty or impossible slot says so', () => {
  throws(() => SC.resolveCall('load2', SLOTS), /Load 2 is empty in this city/);
  throws(() => SC.resolveCall('11', SLOTS), /there is no Load 11 — a city has Load 1 to Load 10/);
});
t('by the name its first line gives it, in any case, or its first 30 characters', () => {
  assert.strictEqual(SC.resolveCall('farm upgrades', SLOTS).src, SLOTS[0].src);
  assert.match(SC.resolveCall('Farm Upgrades', SLOTS).from, /^Load 1 \(Farm upgrades\)$/);
  assert.strictEqual(SC.resolveCall('a loadout whose name is much l', SLOTS).src, SLOTS[2].src);
});
t('else a file in the scripts folder, with or without .txt', () => {
  assert.deepStrictEqual(SC.resolveCall('hello.txt', SLOTS), { src: 'echo "from a file"', from: path.join('scripts', 'hello.txt') });
  assert.strictEqual(SC.resolveCall('hello', SLOTS).src, 'echo "from a file"');
});
t('no URLs, no paths out of the folder, and a clear miss', () => {
  throws(() => SC.resolveCall('http://example.com/x.txt', SLOTS), /not fetched from the web/);
  throws(() => SC.resolveCall('../t.db', []), /no \.\./);
  throws(() => SC.resolveCall('nothing here', SLOTS), /no loadout in this city is named "nothing here", and there is no file/);
  throws(() => SC.resolveCall('', SLOTS), /say which script/);
});

section('script-console.js: autorun');

t('label autorun is found in any case, with @ or a trailing comment, never inside other text', () => {
  for (const s of ['label autorun', 'echo 1\n  LABEL AutoRun\necho 2', '@label autorun', 'label autorun // go', 'x\r\nlabel autorun\r\n']) assert.ok(SC.hasAutorun(s), s);
  for (const s of ['label autorunner', '// label autorun', 'goto autorun', 'echo "label autorun"', '']) assert.ok(!SC.hasAutorun(s), s);
});
t('the plan: the startup file first, then each autorun loadout in slot order, from the label', () => {
  const plan = SC.autorunPlan([{ slot: 5, src: 'label autorun\necho 5' }, { slot: 2, src: 'echo 2\nlabel autorun' }, { slot: 3, src: 'echo 3' }],
    { name: 'AutoRunScript.txt', src: 'echo start' });
  assert.deepStrictEqual(plan.map((p) => [p.what, p.startLine]), [['AutoRunScript.txt', null], ['Load 2', 'autorun'], ['Load 5', 'autorun']]);
  assert.deepStrictEqual(SC.autorunPlan([{ slot: 1, src: 'echo 1' }], null), []);
});
t('AUTOSCRIPTS and RUNSCRIPT, else CmdParms.txt in NEAT\'s forms; OFF unless switched on', () => {
  const f = path.join(TMP, 'parms.txt');
  fs.writeFileSync(f, '-autologin 1\r\n-autoscripts 0\r\n/runscript:"My Items.txt"\r\n-minimize=1\r\n');
  const parms = SC.readCmdParms(f);
  assert.deepStrictEqual(parms, { autologin: '1', autoscripts: '0', runscript: 'My Items.txt', minimize: '1' });
  assert.deepStrictEqual(SC.autorunSettings({}, parms), { on: false, runscript: 'My Items.txt' });
  assert.deepStrictEqual(SC.autorunSettings({ AUTOSCRIPTS: 'yes', RUNSCRIPT: 'a.txt' }, parms), { on: true, runscript: 'a.txt' });
  assert.deepStrictEqual(SC.autorunSettings({}, {}), { on: false, runscript: null }, 'nothing said: off');
  assert.deepStrictEqual(SC.autorunSettings({}, { autoscripts: '1' }), { on: true, runscript: null }, 'NEAT\'s -autoscripts 1');
  assert.deepStrictEqual(SC.autorunSettings({ AUTOSCRIPTS: '1' }, {}), { on: true, runscript: null });
  assert.deepStrictEqual(SC.autorunSettings({ AUTOSCRIPTS: '0' }, { autoscripts: '1' }), { on: false, runscript: null }, 'the environment wins');
  for (const v of ['1', 'on', 'TRUE', 'yes']) assert.ok(SC.switchOn(v), v);
  for (const v of ['0', 'off', 'no', '2', '']) assert.ok(!SC.switchOn(v), v);
  assert.deepStrictEqual(SC.readCmdParms(path.join(TMP, 'none.txt')), {});
});
t('autorun\'s last start per account is kept: a start within 10 minutes is skipped (a crash loop)', () => {
  const kept = new Map();
  const store = { get: (k, d) => (kept.has(k) ? kept.get(k) : d), set: (k, v) => kept.set(k, v) };
  const t0 = Date.parse('2026-09-14T10:00:00');
  assert.deepStrictEqual(SC.autorunGate(store, 'acc1', t0), { ok: true, last: null });
  assert.deepStrictEqual(kept.get(SC.AUTORUN_KEY), { acc1: t0 }, 'recorded before anything runs');
  const again = SC.autorunGate(store, 'acc1', t0 + 3 * 60000);
  assert.strictEqual(again.ok, false);
  assert.match(again.why, /not started — it already started 3 minute\(s\) ago .* waits 10 minutes between starts/);
  assert.strictEqual(kept.get(SC.AUTORUN_KEY).acc1, t0, 'a skipped start does not move the clock');
  assert.strictEqual(SC.autorunGate(store, 'acc2', t0 + 60000).ok, true, 'another account has its own');
  assert.strictEqual(SC.autorunGate(store, 'acc1', t0 + SC.AUTORUN_GAP_MS + 1).ok, true, 'after 10 minutes it starts again');
  // a store that cannot record: autorun is not started (a restart would run it again)
  const broken = { get: () => ({}), set: () => { throw new Error('disk full'); } };
  assert.match(SC.autorunGate(broken, 'acc1', t0).why, /could not be recorded \(disk full\)/);
});
t('the startup file: AutoRunScript.txt when present, RUNSCRIPT when named, a clear miss', () => {
  assert.strictEqual(SC.startupScript({ runscript: null }), null, 'no AutoRunScript.txt: nothing');
  fs.writeFileSync(path.join(SC.SCRIPTS_DIR, 'AutoRunScript.txt'), 'echo "startup"');
  assert.deepStrictEqual(SC.startupScript({ runscript: null }), { name: 'AutoRunScript.txt', src: 'echo "startup"' });
  assert.match(SC.startupScript({ runscript: 'Mine.txt' }).error, /there is no Mine\.txt in/);
  assert.match(SC.startupScript({ runscript: '../x.txt' }).error, /no \.\./);
  fs.unlinkSync(path.join(SC.SCRIPTS_DIR, 'AutoRunScript.txt'));
});

section('script-console.js: say / play queue');

t('a tab\'s first poll learns the place; later polls get what came since', () => {
  let now = 1000;
  const N = new SC.Notifier({ now: () => now });
  assert.strictEqual(N.push({ kind: 'say', text: 'before' }), 0, 'no tab yet');
  const first = N.poll({ tab: 'a' });
  assert.deepStrictEqual([first.seq, first.items], [1, []]);
  assert.strictEqual(N.push({ kind: 'say', text: 'hi' }), 1, 'one tab open');
  const r = N.poll({ tab: 'a', after: first.seq, boot: first.boot });
  assert.deepStrictEqual(r.items.map((x) => x.text), ['hi']);
  assert.deepStrictEqual(N.poll({ tab: 'a', after: r.seq, boot: r.boot }).items, []);
  N.poll({ tab: 'b' });
  assert.strictEqual(N.listeners(), 2);
  now += 80000;
  assert.strictEqual(N.listeners(), 0, 'tabs that stopped polling are gone');
});
t('a tab that knew another console process gets what this one queued; old notes lapse', () => {
  let now = 1000;
  const N = new SC.Notifier({ now: () => now, maxAgeMs: 60000 });
  N.push({ kind: 'say', text: 'x' });
  assert.deepStrictEqual(N.poll({ after: 57, boot: 'old' }).items.map((x) => x.text), ['x']);
  now += 61000;
  assert.deepStrictEqual(N.poll({ after: 0, boot: N.boot }).items, []);
});
t('it keeps a bounded list', () => {
  const N = new SC.Notifier({ keep: 3 });
  for (let i = 0; i < 10; i++) N.push({ kind: 'say', text: String(i) });
  assert.deepStrictEqual(N.poll({ after: 0, boot: N.boot }).items.map((x) => x.text), ['7', '8', '9']);
});

// ======================================================================= 2
section('call through the real VM');

function world() {
  const g = new Game();
  g.player = { playerInfo: { userName: 'Tester' } };
  g.castles = [
    { id: 101, name: 'North', fieldId: C.coordsToFieldId(100, 100), heros: [] },
    { id: 102, name: 'South', fieldId: C.coordsToFieldId(200, 200), heros: [] },
    { id: 103, name: 'East', fieldId: C.coordsToFieldId(300, 300), heros: [] },
  ];
  g.req = async (cmd) => { throw new Error('no network in this test: ' + cmd); };
  return g;
}
async function vm(src, opts = {}) {
  const out = [];
  await script.run(world(), script.parse(src), (m) => out.push(m), { castle: '101', repeatGapMs: 0, ...opts });
  return out.join('\n');
}

t('call load3 runs Load 3 with the caller\'s true variables and comes back', async () => {
  const slots = [{ slot: 3, src: 'echo "in three, x is " + x\nx = x + 1' }];
  const text = await vm('x = 1\ncall load3\necho "back, x is " + x', { loadScript: (n) => SC.resolveCall(n, slots).src });
  assert.match(text, /in three, x is 1/);
  assert.match(text, /back, x is 2/);
});
t('call "a name" and call "file.txt"', async () => {
  const text = await vm('call "farm upgrades"\ncall "hello.txt"', { loadScript: (n) => SC.resolveCall(n, SLOTS).src });
  assert.match(text, /one/);
  assert.match(text, /from a file/);
});
t('a call nothing answers fails that line only, and says why', async () => {
  const text = await vm('call "http://x.com/a.txt"\necho "still here"', { loadScript: (n) => SC.resolveCall(n, SLOTS).src });
  assert.match(text, /FAILED: call: scripts are not fetched from the web/);
  assert.match(text, /still here/);
});

// ======================================================================= 3
section('server.js offline: port 8799, a stub Session, a temp database');

const D = require('./db');
const AUTH = require('./auth');
const op = AUTH.register({ email: 'op@example.com', password: 'correct horse battery', orgName: 'Test Org' });
const ORG = D.org(op.org.id);
ORG.settings.set('probes', []);                  // startup must never ask :8711/:8713
const ACC = ORG.accounts.upsert({ label: 'Tester', email: 'tester@example.com', password: 'x' });
const SID = AUTH.newSession(op.user.id, op.org.id, '127.0.0.1', 'test');

// say / play are script-cmd-social.js's own. Two test-only additions ride on
// that module here: an in-line `ping`, and `ottowhere`, which shows what a
// command (a goal line, say) learns about its run.
{
  const key = require.resolve('./script-cmd-social');
  const real = require('./script-cmd-social');
  const cmds = { ...(real.commands || {}) }, inline = { ...(real.inline || {}) };
  inline.ping = { usage: 'ping <text>', async run(args, env) { env.log('  pong ' + args); return { ok: true, result: 'pong' }; } };
  cmds.ottowhere = { usage: 'ottowhere', parse: () => ({}),
    async run(a, env) { env.log(`  account=${env.opts.accountId} city=${env.opts.cityId} cid=${env.cid}`); return { ok: true }; } };
  require.cache[key].exports = { ...real, commands: cmds, inline };
}

const W = { g: world() };
class StubSession {
  constructor() {
    this.account = ACC; this.orgId = op.org.id; this.org = ORG;
    this.game = W.g; this.connected = false;
    this.chat = { alliance: [], world: [], private: [], system: [] };
    this.userPaused = false; this.maint = { plan: null }; this.notes = [];
    StubSession.last = this;             // the server keeps its Session to itself
  }
  startSupervisor() {} startEngine() {}
  note(m, meta) { this.notes.push({ m: String(m), meta }); }
  async connect() { return this.game; }
  header() {
    return { state: this.connected ? 'connected' : 'offline', server: 'ss0', lord: 'Tester', account: { id: ACC.id, label: 'Tester' },
      counts: { packages: 0, reports: 0, reportsArmy: 0, reportsTrade: 0, reportsOther: 0, mail: 0, mailInbox: 0, mailSystem: 0 },
      paused: false, maintenance: {} };
  }
  cities() { return this.game.castles.map((c) => ({ id: c.id, name: c.name, ...this.game.castleXY(c), incoming: 0, trainingHeroes: [] })); }
  // Enough of a city for the page's Heroes tab, shaped the way session.js
  // shapes it: the attribute buffs are a percentage beside an untouched base.
  city(id) {
    const c = this.game.castles.find((x) => String(x.id) === String(id));
    if (!c) return {};
    const pct = (h, k) => Number(h[k + 'BuffAdded'] || 0);
    const eff = (h, k, v) => Math.round(v * (1 + pct(h, k) / 100));
    return { id: c.id, name: c.name, heroes: (c.heros || []).map((h) => ({
      id: h.id, name: h.name, level: h.level, loyalty: h.loyalty, status: h.status,
      statusName: { 0: 'Idle', 1: 'Mayor', 4: 'Captured' }[h.status] || String(h.status),
      type: 'Att', base: 100, unspent: h.remainPoint || 0,
      attack: Number(h.power || 0), politics: Number(h.management || 0), intel: Number(h.stratagem || 0),
      attackBuff: pct(h, 'power'), politicsBuff: pct(h, 'management'), intelBuff: pct(h, 'stratagem'),
      attackEff: eff(h, 'power', Number(h.power || 0)),
      politicsEff: eff(h, 'management', Number(h.management || 0)),
      intelEff: eff(h, 'stratagem', Number(h.stratagem || 0)),
      buffs: (h.buffs || []).map((b) => ({ type: b.typeId, text: b.descName,
        endTime: Number(b.endTime || 0), msLeft: Math.max(0, Number(b.endTime || 0) - Date.now()) })),
    })) };
  }
  logView() { return { lines: [], total: 0, cities: [], filtered: false }; }
  marches() { return []; }
  engineReport() { return null; }
  controls() { return {}; }
  allControls() { return {}; }
  async cityExtra() { return {}; }
  async sendChat() { throw new Error('chat was sent — it should not be'); }
}
require.cache[require.resolve('./session')] = { id: require.resolve('./session'), loaded: true, exports: { Session: StubSession } };
const origLog = console.log, AUTOLOG = [];
console.log = (...a) => {
  const s = String(a[0]);
  if (/^\[autorun/.test(s)) AUTOLOG.push(s);
  if (!/^\[(script|autorun)/.test(s)) origLog(...a);
};
require('./server');
let SESSION = null;          // the server's own Session: found through the notes it keeps

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: 8799, path: url, method,
      headers: { Cookie: 'otto_sid=' + SID, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      const bufs = [];
      res.on('data', (c) => bufs.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(bufs);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, type: res.headers['content-type'], raw, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
// A live Run from the Script tab carries a runId; the tests' live runs get one
// each unless they name their own (runId: undefined sends none).
let RUN_SEQ = 0;
const post = async (u, b) => {
  if (u === '/api/script' && b && !b.parseOnly && b.dryRun !== true && !('runId' in b)) b = { ...b, runId: `test-run-${++RUN_SEQ}-${Date.now()}` };
  return (await call('POST', u, b)).json;
};
const get = async (u) => (await call('GET', u)).json;
const runs = () => get('/api/script/runs');
const saveLoad = (city, slot, src) => post('/api/loadouts', { city, slot, src });

t('/api/items carries the buffs the panel\'s third tab shows', async () => {
  const now = W.g.now();
  W.g.player.buffs = [{ typeId: 'FurloughBuff', descName: '', endTime: now + 569 * 60000 }];
  W.g.castles[0].buffs = [{ typeId: 'ForceopenclosegateBuff', descName: 'The gates are held open.', endTime: now + 600000 }];
  try {
    const r = await get('/api/items?city=101');
    assert.strictEqual(r.ok, true);
    const account = r.buffs.filter((b) => b.scope === 'account');
    const city = r.buffs.filter((b) => b.scope === 'city');
    assert.deepStrictEqual(account.map((b) => [b.name, b.left]), [['Holiday mode', '9h29m']]);
    assert.deepStrictEqual(city.map((b) => b.text), ['The gates are held open.'], "the game's own sentence is kept");
    assert.strictEqual(r.protection.kind, 'holiday');
    assert.ok(Array.isArray(r.items), 'items still come with it');
    const other = await get('/api/items?city=102');
    assert.deepStrictEqual(other.buffs.filter((b) => b.scope === 'city'), [], "another city's tab shows only its own");
  } finally {
    W.g.player.buffs = []; W.g.castles[0].buffs = [];
  }
});

t('the server is up and signed in', async () => {
  await until(async () => { try { return (await call('GET', '/api/session')).status === 200; } catch { return false; } }, 5000, 'the server');
  const s = await get('/api/session');
  assert.strictEqual(s.account.id, ACC.id);
});

t('the editor\'s line check: parseOnly + lines answers each line\'s standing, logs and runs nothing', async () => {
  const r = await post('/api/script', { src: 'echo "a"\n// note\n\nfrobnicate 1', parseOnly: true, lines: true });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.lines.map((l) => l.status), ['ok', 'comment', 'blank', 'error']);
  assert.match(r.errors[0].error, /unknown command/);
  assert.strictEqual(r.log, undefined);
  const old = await post('/api/script', { src: 'echo "a"', parseOnly: true });
  assert.ok(Array.isArray(old.log) && old.log.length, 'Apply still gets its log');
});

t('Run box: a line number starts there', async () => {
  const r = await post('/api/script', { city: '101', src: 'echo "L1"\necho "L2"\necho "L3"', startLine: '2' });
  assert.strictEqual(r.ok, true);
  const text = r.log.join('\n');
  assert.match(text, /starting at line 2/);
  assert.doesNotMatch(text, /L1/);
  assert.match(text, /L2[\s\S]*L3/);
});
t('Run box: a label starts there (any case)', async () => {
  const r = await post('/api/script', { city: '101', src: 'echo "top"\nend\nlabel Two\necho "at two"', startLine: 'two' });
  assert.match(r.log.join('\n'), /at two/);
  assert.doesNotMatch(r.log.join('\n'), /top/);
});
t('Run box: a label or a line the script does not have runs nothing', async () => {
  const a = await post('/api/script', { city: '101', src: 'echo "x"', startLine: 'nowhere' });
  assert.strictEqual(a.ok, false);
  assert.match(a.log.join('\n'), /there is no label nowhere in this script to start at[\s\S]*nothing was run/);
  const b = await post('/api/script', { city: '101', src: 'echo "x"\n// end', startLine: '9' });
  assert.strictEqual(b.ok, false);
  assert.match(b.log.join('\n'), /nothing runs from line 9 — the last line that does anything is line 1/);
  const c = await post('/api/script', { city: '101', src: 'echo "x"', startLine: '0' });
  assert.match(c.log.join('\n'), /x/, '0 is line 1');
});

t('stop pauses: /api/script/runs says where, Resume carries on from the next line', async () => {
  const p = post('/api/script', { city: '101', src: 'echo "before"\nstop\necho "after"' });
  const r = await until(async () => { const x = await runs(); const me = x.runs.find((y) => y.city === '101'); return me && me.paused && x; }, 5000, 'the pause');
  const me = r.runs.find((y) => y.city === '101');
  assert.deepStrictEqual([me.paused.line, me.paused.next, me.source], [2, 3, 'console']);
  const live = await get('/api/script/runs?city=101');
  assert.match(live.lines.join('\n'), /stop — paused/);
  assert.strictEqual((await post('/api/script/resume', { city: '102' })).ok, false, 'nothing runs in 102');
  const res = await post('/api/script/resume', { city: '101' });
  assert.deepStrictEqual([res.ok, res.line, res.next], [true, 2, 3]);
  const done = await p;
  assert.match(done.log.join('\n'), /before[\s\S]*resumed[\s\S]*after/);
  assert.strictEqual((await post('/api/script/resume', { city: '101' })).ok, false, 'nothing is paused now');
});
t('Stop ends a paused run', async () => {
  const p = post('/api/script', { city: '101', src: 'stop\necho "after"' });
  await until(async () => { const x = await runs(); const me = x.runs.find((y) => y.city === '101'); return me && me.paused; }, 5000, 'the pause');
  assert.strictEqual((await post('/api/script/stop', { city: '101' })).ok, true);
  const done = await p;
  assert.strictEqual(done.stopped, true);
  assert.doesNotMatch(done.log.join('\n'), /after/);
  assert.match(done.log.join('\n'), /stopped — the rest of the script was not run/);
});
t('Resume refuses a run that is going but not paused', async () => {
  const p = post('/api/script', { city: '101', src: 'sleep 20' });
  await until(async () => (await runs()).runs.some((y) => y.city === '101'), 5000, 'the run');
  const r = await post('/api/script/resume', { city: '101' });
  assert.deepStrictEqual([r.ok, r.error], [false, 'the script in that city is not paused']);
  await post('/api/script/stop', { city: '101' });
  await p;
});

t('call: the city\'s loadouts by slot and name, a file, and refusals', async () => {
  await saveLoad('101', 2, '// farm upgrades\necho "in load two, x=" + x\nx = 7');
  await saveLoad('102', 2, 'echo "SOUTH\'s load two"');
  fs.writeFileSync(path.join(SC.SCRIPTS_DIR, 'UseItems.txt'), 'echo "use items file"');
  const r = await post('/api/script', { city: '101', src: 'x = 1\ncall load2\necho "x is now " + x\ncall "Farm Upgrades"\ncall "UseItems.txt"\ncall "../t.db"\ncall "http://a.b/c.txt"' });
  const text = r.log.join('\n');
  assert.match(text, /in load two, x=1[\s\S]*x is now 7/);
  assert.doesNotMatch(text, /SOUTH/, 'another city\'s Load 2 is not this one');
  assert.match(text, /use items file/);
  assert.match(text, /FAILED: .*no \.\./);
  assert.match(text, /FAILED: call: scripts are not fetched from the web/);
});

t('through the server: call and the sound route refuse a junction', async () => {
  try {
    junction(OUTSIDE, path.join(SC.SCRIPTS_DIR, 'link'));
    junction(OUTSIDE, path.join(SC.MEDIA_DIR, 'snd'));
    const r = await post('/api/script', { city: '101', src: 'call "link/secret.txt"\necho "after"' });
    const text = r.log.join('\n');
    assert.match(text, /FAILED: .*"link" is a link \(symlink or junction\)/);
    assert.doesNotMatch(text, /TOP SECRET/);
    const snd = await call('GET', '/api/script/media?f=snd/boom.mp3');
    assert.strictEqual(snd.status, 404);
    assert.doesNotMatch(snd.raw.toString(), /not a sound/);
  } finally { unlinkAll(); }
});

t('a command learns the run\'s account and city (what goal lines need)', async () => {
  const r = await post('/api/script', { city: '102', src: 'ottowhere' });
  assert.match(r.log.join('\n'), new RegExp(`account=${ACC.id} city=102 cid=102`));
});

t('a Run the browser sends again after a console restart is not started twice', async () => {
  const a = await post('/api/script', { city: '101', src: 'echo "once"', runId: 'run-abc' });
  assert.match(a.log.join('\n'), /once/);
  assert.ok(ORG.settings.get('scriptRunIds', []).some((x) => x.id === 'run-abc'), 'kept in the database, so a new process knows it');
  const b = await post('/api/script', { city: '101', src: 'echo "once"', runId: 'run-abc' });
  assert.strictEqual(b.ok, false);
  assert.match(b.log.join('\n'), /not started again: this Run was already started once/);
  assert.doesNotMatch(b.log.join('\n'), /line 1: echo/);
  const c = await post('/api/script', { city: '101', src: 'echo "twice"', runId: 'run-def' });
  assert.match(c.log.join('\n'), /twice/, 'a new Run has a new id');
});

t('a live run needs the Script tab\'s runId: the old /script page (none) is refused live and may dry-run', async () => {
  const oldPage = { src: 'echo "from the old page"', castle: 'North', autoReq: false };
  const a = await post('/api/script', { ...oldPage, dryRun: false, runId: undefined });
  assert.strictEqual(a.ok, false);
  assert.match(a.log.join('\n'), /not started: a live run needs a runId, which the console's Script tab sends with every Run — the old \/script page does not/);
  assert.doesNotMatch(a.log.join('\n'), /line 1: echo/);
  const d = await post('/api/script', { ...oldPage, dryRun: true });
  assert.match(d.log.join('\n'), /from the old page/);
});
t('runs are keyed by the city\'s castle id however it is named: a name and the id are one city', async () => {
  const p = post('/api/script', { castle: 'North', src: 'sleep 20' });
  await until(async () => (await runs()).runs.some((y) => y.city === '101'), 5000, 'North\'s run, keyed 101');
  assert.ok(!(await runs()).runs.some((y) => y.city === 'North'), 'not keyed by the typed name');
  const b = await post('/api/script', { city: '101', src: 'echo "second"' });
  assert.strictEqual(b.ok, false);
  assert.match(b.log.join('\n'), /already running in this city/);
  const c = await post('/api/script', { castle: '0', src: 'echo "by index"' });
  assert.match(c.log.join('\n'), /already running in this city/, 'index 0 is North too');
  const bad = await post('/api/script', { castle: 'Atlantis', src: 'echo "x"' });
  assert.match(bad.log.join('\n'), /ERROR: unknown castle: Atlantis[\s\S]*nothing was run/);
  assert.strictEqual((await post('/api/script/stop', { city: '101' })).ok, true, 'Stop finds it by id');
  await p;
});
t('NEAT\'s start-up parameters reach a script as Config.<key> (CmdParms.txt); a password never does', async () => {
  fs.writeFileSync(process.env.EVONY_CMDPARMS, '-teleport tuscany\r\n-password hunter2\r\n-sessiontoken abc\r\n');
  try {
    const r = await post('/api/script', { city: '101', src: 'echo "tp=" + Config.teleport\necho "pw=" + Config.password + " tok=" + Config.sessiontoken' });
    const text = r.log.join('\n');
    assert.match(text, /tp=tuscany/);
    assert.match(text, /pw=undefined tok=undefined/);
    assert.doesNotMatch(text, /hunter2|abc\b/);
  } finally { fs.unlinkSync(process.env.EVONY_CMDPARMS); }
});
t('callScript starts the lines as that city\'s own run (keyed by its id), never beside one already there', async () => {
  const src = 'cities[1].cityManager.script.callScript("sleep 20")\necho "first=" + ($error == null)'
    + '\ncities[1].cityManager.script.callScript("echo 2")\necho "second=" + $error'
    + '\ncities[2].cityManager.script.callScript("frobnicate 3")\necho "third=" + $error';
  const r = await post('/api/script', { city: '101', src });
  const text = r.log.join('\n');
  assert.match(text, /first=true/);
  assert.match(text, /second=callScript: South already has a script running — its lines were not started/);
  assert.match(text, /third=callScript: line 1: unknown command: frobnicate/);
  const south = (await runs()).runs.find((y) => y.city === '102');
  assert.ok(south, 'South runs the called lines');
  assert.strictEqual(south.source, 'callScript from North');
  assert.ok(!(await runs()).runs.some((y) => y.city === '103'), 'East\'s bad lines never ran');
  await post('/api/script/stop', { city: '102' });
  await until(async () => !(await runs()).runs.some((y) => y.city === '102'), 5000, 'South\'s run to stop');
});

t('say and play go to the open tabs; a missing sound beeps and says so', async () => {
  const first = await get('/api/script/notify?tab=t1');
  assert.deepStrictEqual(first.items, []);
  fs.writeFileSync(path.join(SC.MEDIA_DIR, 'SingleAttack.mp3'), Buffer.from([0xff, 0xfb, 0x90, 0x00]));
  // a second apart: social's say/play allow one a second per run
  const r = await post('/api/script', { city: '102', src: 'say "es# Tu ciudad esta siendo atacada."\nsleep 1.05\nplay "media/SingleAttack.mp3"\nsleep 1.05\nplay nothere.mp3\nsleep 1.05\nplay "http://example.com/a.mp3"' });
  const text = r.log.join('\n');
  assert.match(text, /\b1 (console )?tab/, 'one tab had polled');
  assert.match(text, /there is no nothere\.mp3 in .* — a console tab beeps instead/);
  const n = await get(`/api/script/notify?tab=t1&after=${first.seq}&boot=${first.boot}`);
  assert.deepStrictEqual(n.items.map((x) => [x.kind, x.text || x.url || (x.beep ? 'beep' : '')]), [
    ['say', 'Tu ciudad esta siendo atacada.'], ['play', '/api/script/media?f=SingleAttack.mp3'], ['play', 'beep'], ['play', 'http://example.com/a.mp3']]);
  assert.deepStrictEqual([n.items[0].lang, n.items[0].city, n.items[0].cityName, n.items[0].line, n.items[1].line], ['es', '102', 'South', 1, 3]);
  const snd = await call('GET', '/api/script/media?f=SingleAttack.mp3');
  assert.deepStrictEqual([snd.status, snd.type, snd.raw.length], [200, 'audio/mpeg', 4]);
  for (const bad of ['../t.db', 'x.txt', '..%5Ct.db', 'nothere.mp3']) assert.strictEqual((await call('GET', '/api/script/media?f=' + bad)).status, 404, bad);
});
t('a dry run says nothing', async () => {
  const before = await get('/api/script/notify?tab=t1');
  await post('/api/script', { city: '102', src: 'say "quiet"', dryRun: true });
  const n = await get(`/api/script/notify?tab=t1&after=${before.seq}&boot=${before.boot}`);
  assert.deepStrictEqual(n.items.filter((x) => x.text === 'quiet'), [], 'social\'s say must not notify in a dry run');
});

t('the command line: \\ping runs an in-line command in the open city, and a wrong one says so', async () => {
  const r = await post('/api/script/inline', { city: '101', text: '\\ping hello "world" {x}' });
  assert.deepStrictEqual([r.ok, r.result, r.lines], [true, 'pong', ['pong hello "world" {x}']]);
  const bad = await post('/api/script/inline', { city: '101', text: '\\nosuch thing' });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /there is no in-line command "nosuch"/);
  assert.strictEqual((await post('/api/script/inline', { city: '101', text: '\\' })).ok, false);
});

t('autorun: nothing starts before the first login', async () => {
  await saveLoad('101', 3, '// north auto\necho "north skipped this"\nlabel autorun\necho "north autorun ran"\ncall load9');
  await saveLoad('101', 5, 'label autorun\nsleep 30');
  await saveLoad('102', 1, 'label AUTORUN\nsleep 30');
  await saveLoad('103', 1, 'label autorun\necho "east autorun"');
  await saveLoad('102', 4, '// south, second\nlabel autorun\necho "south four"');
  fs.writeFileSync(path.join(SC.SCRIPTS_DIR, 'AutoRunScript.txt'), 'echo "startup file"');
  // East is busy with a script of the user's before the console logs in
  const busy = post('/api/script', { city: '103', src: 'sleep 30' });
  await until(async () => (await runs()).runs.some((y) => y.city === '103'), 5000, 'East\'s run');
  await sleep(2500);
  assert.deepStrictEqual((await runs()).runs.map((x) => x.city), ['103']);
  W.busy = busy;
});
t('autorun: after the first login each city runs the startup file, then its autorun loadouts', async () => {
  SESSION = StubSession.last;
  assert.ok(SESSION && SESSION.org === ORG, 'the server made its Session from the stub');
  process.env.AUTOSCRIPTS = '1';                  // off unless switched on
  const before = Date.now();
  SESSION.connected = true;
  const r = await until(async () => { const x = await runs(); return x.runs.some((y) => y.city === '102' && /autorun Load 1/.test(y.source)) && x; }, 6000, 'South\'s autorun');
  // North: the startup file, then Load 3 from the label, then Load 5 (still sleeping)
  await until(async () => (await runs()).runs.some((y) => y.city === '101' && y.source === 'autorun Load 5'), 6000, 'North\'s Load 5');
  const notes = SESSION.notes.map((n) => n.m).filter((m) => /^autorun:/.test(m));
  const north = notes.filter((m) => /North/.test(m));
  assert.deepStrictEqual(north.slice(0, 5), [
    'autorun: AutoRunScript.txt started in North', 'autorun: AutoRunScript.txt in North ended — 0 action(s)',
    'autorun: Load 3 started in North from label autorun',
    'autorun: Load 3 in North ended — 0 action(s); 1 line(s) failed, the first: call: Load 9 is empty in this city',
    'autorun: Load 5 started in North from label autorun']);
  assert.ok(notes.includes('autorun: East already has a script running — AutoRunScript.txt (and 1 more autorun script(s) after it) not started'), notes.join('\n'));
  assert.ok(r.runs.find((y) => y.city === '103').source === 'console', 'East keeps the user\'s own run');
  // South: Load 1 sleeps, so its Load 4 waits its turn
  assert.ok(!notes.some((m) => /Load 4 started in South/.test(m)), 'Load 4 must wait for Load 1');
  const live = await get('/api/script/runs?city=101');
  assert.ok(Array.isArray(live.lines));
  // its start is kept in the database, for the next console start to see
  const stamp = (ORG.settings.get(SC.AUTORUN_KEY, {}) || {})[ACC.id];
  assert.ok(stamp >= before && stamp <= Date.now(), 'autorun\'s start recorded for the account: ' + stamp);
  assert.strictEqual(SC.autorunGate(ORG.settings, ACC.id).ok, false, 'a console starting again now would skip it');
});
t('autorun: a loadout runs from its label (Load 3 never ran the line above it)', async () => {
  const north = AUTOLOG.filter((l) => l.startsWith('[autorun North]')).join('\n');
  assert.match(north, /startup file[\s\S]*north autorun ran/);
  assert.doesNotMatch(north, /north skipped this/);
});
t('autorun: a city that is running cannot be started twice, by the user or by autorun', async () => {
  const r = await post('/api/script', { city: '102', src: 'echo "x"' });
  assert.strictEqual(r.ok, false);
  assert.match(r.log.join('\n'), /already running in this city/);
});
t('autorun: a reconnect starts nothing again', async () => {
  for (const c of ['101', '102', '103']) await post('/api/script/stop', { city: c });
  await until(async () => (await runs()).runs.length === 0, 6000, 'every run to stop');
  await W.busy;
  assert.ok(SESSION.notes.some((n) => n.m === 'autorun: stopped, so the rest of South\'s autorun was not started'), 'Stop ends a city\'s autorun');
  assert.ok(!SESSION.notes.some((n) => /Load 4 started in South/.test(n.m)));
  const before = SESSION.notes.filter((n) => /started in/.test(n.m)).length;
  SESSION.connected = false;
  await sleep(2200);
  const g2 = world();
  W.g = g2;                   // W.g is the session's world; the page tests below set up in it
  SESSION.game = g2;
  SESSION.connected = true;
  await sleep(4500);
  assert.strictEqual(SESSION.notes.filter((n) => /started in/.test(n.m)).length, before);
  assert.deepStrictEqual((await runs()).runs, []);
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
  if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result.value;
}
const browserOff = process.env.SKIP_BROWSER === '1' || !fs.existsSync(CHROME);

t('the page loads, signed in, with a city open', async () => {
  if (browserOff) return 'skipped';
  const port = 9340 + Math.floor(Math.random() * 50);
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
  await cdp('Network.setCookie', { name: 'otto_sid', value: SID, url: 'http://127.0.0.1:8799/' });
  // the page's voice and speaker, recorded instead of heard
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__said = []; window.__played = [];
    if (window.speechSynthesis) speechSynthesis.speak = (u) => __said.push({ text: u.text, lang: u.lang });
    HTMLMediaElement.prototype.play = function () { __played.push(this.src); return Promise.resolve(); };` });
  await cdp('Page.navigate', { url: 'http://127.0.0.1:8799/' });
  // whatever the page threw on the way up is worth more than "timed out"
  try {
    await until(() => ev('typeof S === "object" && S.city'), 15000, 'a city to open');
  } catch (e) {
    throw new Error(e.message + (pageErrors.length ? ' — the page threw: ' + pageErrors.join(' | ') : ' — the page threw nothing'));
  }
});
t('Script tab: the Run box sits beside Run; the loadout picker marks autorun loadouts', async () => {
  if (browserOff) return 'skipped';
  await ev(`document.querySelector('#editTabs .ib[data-k=script]').click()`);
  await until(() => ev('!!loadOf()'), 8000, 'the loadouts');
  const s = await ev(`({ run: getComputedStyle($('runScript')).display, box: getComputedStyle($('runFrom')).display,
    opts: [...$('loadSel').options].map((o) => o.textContent) })`);
  assert.notStrictEqual(s.box, 'none');
  assert.ok(s.opts.some((o) => /^Load 3 · north auto · autorun$/.test(o)), s.opts.join(' | '));
  assert.ok(s.opts.some((o) => /^Load 2 · farm upgrades$/.test(o)), s.opts.join(' | '));
});
t('the Items panel\'s Buffs tab lists what the account and the city are under', async () => {
  if (browserOff) return 'skipped';
  // the game the SERVER holds: section 3 swapped a fresh world into both
  const g = SESSION.game;
  const now = g.now();
  g.player.buffs = [{ typeId: 'FurloughBuff', descName: '', endTime: now + 569 * 60000 }];
  g.castles[0].buffs = [{ typeId: 'ForceopenclosegateBuff', descName: 'The gates are held open.', endTime: now + 600000 }];
  const wasOn = await ev(`S.logs`);          // put the panel back for the tests after this one
  try {
    await ev(`document.querySelector('#logTabs .t[data-k=items]').click()`);
    await ev('renderItems(true)');          // the panel polls on a timer; ask now
    const seen = await ev(`(async () => { const r = await (await fetch('/api/items?city=' + (S.city || ''))).json();
      return { ok: r.ok, buffs: (r.buffs || []).map((b) => b.name + '/' + b.scope), logs: S.logs, city: S.city,
        tabs: [...$('itemKind').children].map((c) => c.textContent) }; })()`);
    assert.deepStrictEqual(seen.buffs, ['Holiday mode/account', 'Gates forced/city'], JSON.stringify(seen));
    await until(() => ev(`[...$('itemKind').children].some((b) => /^Buffs \\([1-9]\\d*\\)/.test(b.textContent))`), 8000,
      'the buff count — the page saw ' + JSON.stringify(seen));
    await ev(`[...$('itemKind').children].find((b) => b.dataset.k === 'buffs').click()`);
    await until(() => ev(`$('logBody').textContent.includes('Holiday mode')`), 8000, 'the holiday row');
    const t = await ev(`$('logBody').textContent`);
    assert.match(t, /Holiday mode/);
    assert.match(t, /9h29m/, t.slice(0, 200));
    assert.match(t, /The gates are held open\./, 'the open city\'s own buff is there too');
    assert.match(t, /account/);
    assert.match(t, /this city/);
    // and back to the items, which still work
    await ev(`[...$('itemKind').children].find((b) => b.dataset.k === 'items').click()`);
    await until(() => ev(`!$('logBody').textContent.includes('Holiday mode')`), 8000, 'the items table');
  } finally {
    g.player.buffs = []; g.castles[0].buffs = [];
    await ev(`[...$('itemKind').children].find((b) => b.dataset.k === 'items').click()`);
    await ev(`document.querySelector('#logTabs .t[data-k=${String(wasOn || 'activity')}]').click()`);
  }
});

t('Run from a line, pause at stop, Resume, and say reaches the tab', async () => {
  if (browserOff) return 'skipped';
  await ev(`(() => { $('loadSel').value = '1'; $('loadSel').onchange();
    $('editor').value = 'echo "first"\\necho "second"\\nstop\\nsay "hello from the page"\\necho "third"';
    $('editor').dispatchEvent(new Event('input')); $('runFrom').value = '2'; $('runScript').click(); })()`);
  const q = await until(() => ev(`(document.querySelector('dialog.ask') || {}).textContent`), 5000, 'the Run question');
  assert.match(q, /Run Load 1 \(echo "first"\) in North from line 2 now\?/);
  await ev(`document.querySelector('dialog.ask button[value=ok]').click()`);
  await until(() => ev(`!$('resumeScript').hidden`), 8000, 'Resume to show');
  const out = await until(() => ev(`/paused at line 3/.test(OUT[S.city] || '') && OUT[S.city]`), 5000, 'the paused output');
  assert.doesNotMatch(out, /first/);
  assert.match(await ev(`$('resumeScript').title`), /Paused at line 3 .* from line 4/);
  if (process.env.SHOT) {           // SHOT=<file.png>: how the paused Script tab looks
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    fs.writeFileSync(process.env.SHOT, Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  }
  await ev(`$('resumeScript').click()`);
  await until(() => ev(`!RUNS.has(String(S.city)) && /third/.test(OUT[S.city] || '')`), 8000, 'the run to finish');
  assert.ok(await ev(`$('resumeScript').hidden`));
  const said = await until(() => ev('__said.length && __said'), 6000, 'the tab to speak');
  assert.deepStrictEqual(said, [{ text: 'hello from the page', lang: '' }]);
});
t('a bad start label is refused with a hint', async () => {
  if (browserOff) return 'skipped';
  await ev(`(() => { $('runFrom').value = 'nolabel'; $('runScript').click(); })()`);
  await until(() => ev(`!!document.querySelector('dialog.ask')`), 5000, 'the Run question');
  await ev(`document.querySelector('dialog.ask button[value=ok]').click()`);
  const hint = await until(() => ev(`/no label nolabel/.test($('editHint').textContent) && $('editHint').textContent`), 6000, 'the hint');
  assert.match(hint, /there is no label nolabel in this script to start at — nothing was run/);
  await ev(`$('runFrom').value = ''`);
});
t('\\ping in the chat box runs the in-line command, and nothing is sent as chat', async () => {
  if (browserOff) return 'skipped';
  await ev(`(() => { $('chatInput').value = '\\\\ping from chat'; $('chatSend').click(); })()`);
  const out = await until(() => ev(`/pong from chat/.test(OUT[S.city] || '') && OUT[S.city]`), 6000, 'the command output');
  assert.match(out, /^\\ping from chat\n {2}pong from chat/);
  assert.strictEqual(await ev(`$('chatInput').value`), '');
});
t('Goals tab: the Run box goes where Run goes', async () => {
  if (browserOff) return 'skipped';
  await ev(`document.querySelector('#editTabs .ib[data-k=goals]').click()`);
  assert.strictEqual(await ev(`getComputedStyle($('runFrom')).display`), 'none');
  await ev(`document.querySelector('#editTabs .ib[data-k=script]').click()`);
  assert.notStrictEqual(await ev(`getComputedStyle($('runFrom')).display`), 'none');
});
t('with the goals branch\'s editor colours (skipped without them): each Script line is coloured from /api/script', async () => {
  if (browserOff || !await ev(`!!document.getElementById('edHl')`)) return 'skipped';
  await ev(`(() => { const e = $('editor'); e.value = 'echo "ok"\\nfrobnicate 3\\n// note'; e.dispatchEvent(new Event('input')); })()`);
  const cls = await until(() => ev(`(() => { const r = [...$('edHl').children].map((d) => d.className);
    return r.length === 3 && /gl-error/.test(r[1]) && r; })()`), 6000, 'the colours');
  assert.match(cls[0], /gl-ok/);
  assert.match(cls[2], /gl-comment/);
});
// The hero row's + (heroitems.js): the window it opens, what it says is held,
// and the one command it sends. W.g has no network, so hero.useItem is answered
// here; nothing in this file logs in.
t('Heroes tab: every hero line has a +, except a prisoner we hold', async () => {
  if (browserOff) return 'skipped';
  W.g.castles[0].heros = [
    { id: 7, name: 'OTTO', level: 40, status: 0, power: 120, management: 40, stratagem: 30, loyalty: 100, remainPoint: 0,
      powerBuffAdded: 25, buffs: [{ typeId: 'HeroPowerBuff', descName: 'Attack +25%', endTime: Date.now() + 6 * 86400000 }] },
    { id: 8, name: 'Bob', level: 20, status: 4, power: 60, management: 30, stratagem: 30, loyalty: 100, remainPoint: 0, buffs: [] },
  ];
  W.g.player.items = [{ id: 'hero.power.1', count: 3 }, { id: 'hero.intelligence.1', count: 1 }];
  await ev(`(() => { S.mon = 'heroes'; document.querySelector('#monTabs .ib[data-k=heroes]').click(); })()`);
  await ev('refresh(true)');
  await until(() => ev(`$('monBody').textContent.includes('OTTO')`), 8000, 'the Feasting Hall');
  const b = await ev(`[...$('monBody').querySelectorAll('button[data-act=heroitem]')].map((x) => [x.dataset.hero, x.textContent, x.className])`);
  assert.deepStrictEqual(b, [['OTTO', '+', 'sm buffadd has']], 'only OTTO, and marked as already buffed');
  assert.match(await ev(`$('monBody').querySelector('button[data-act=heroitem]').title`), /Attack \+25%/);
});
const clickPlus = async () => {
  await until(() => ev(`(() => { const b = $('monBody').querySelector('button[data-act=heroitem]');
    if (!b) return false; b.click(); return true; })()`), 8000, 'the hero row\'s +');
  await until(() => ev(`$('hiDlg').open`), 8000, 'the hero-item window');
};
t('the + window lists what is held, Excalibur first, with none-held greyed', async () => {
  if (browserOff) return 'skipped';
  await clickPlus();
  await until(() => ev(`$('hiList').querySelector('input[name=hiPick]') !== null`), 8000, 'the item list');
  const rows = await ev(`[...$('hiList').querySelectorAll('label')].map((l) => l.textContent.replace(/\\s+/g, ' ').trim())`);
  assert.match(rows[0], /^Excalibur\+25% attack for 7 days 3$/, rows.join(' | '));
  assert.match(rows[1], /^The Wealth of Nations\+25% politics.* 0$/, rows.join(' | '));
  assert.match(rows[2], /^The Art of War\+25% intelligence.* 1$/, rows.join(' | '));
  assert.deepStrictEqual(await ev(`[...$('hiList').querySelectorAll('input')].map((i) => i.disabled)`), [false, true, false],
    'the one with none held cannot be picked');
  assert.strictEqual(await ev(`hiPicked().value`), 'hero.power.1', 'the first one held is picked for you');
  assert.match(await ev(`$('hiTimesNote').textContent`), /3 held/);
  assert.match(await ev(`$('hiNow').textContent`), /Attack \+25%.*days left/s, 'it says what the hero is already under');
  if (process.env.SHOT_HERO) {     // SHOT_HERO=<file.png>: how the hero-item window looks
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    fs.writeFileSync(process.env.SHOT_HERO, Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  }
});
t('the count held is the ceiling on how many to apply', async () => {
  if (browserOff) return 'skipped';
  await ev(`(() => { $('hiTimes').value = '99'; $('hiList').querySelector('input[value="hero.intelligence.1"]').checked = true;
    $('hiList').dispatchEvent(new Event('change')); })()`);
  assert.strictEqual(await ev(`$('hiTimes').value`), '1', 'one Art of War held, so one is the most');
  assert.match(await ev(`$('hiTimesNote').textContent`), /1 held/);
});
t('Apply sends one hero.useItem, and the window says what it did', async () => {
  if (browserOff) return 'skipped';
  const sent = [];
  W.g.req = async (cmd, data) => { sent.push({ cmd, data }); return { ok: 1 }; };
  W.g.heroAfter = async () => ({ ...W.g.castles[0].heros[0], stratagemBuffAdded: 25 });
  try {
    await ev(`$('hiGo').click()`);
    const said = await until(() => ev(`(document.querySelector('dialog.ask') || {}).textContent`), 8000, 'the answer');
    assert.match(said, /Used 1 x The Art of War \(\+25% intelligence for 7 days\) on OTTO in North/, said);
    await ev(`document.querySelector('dialog.ask button[value=ok]').click()`);
  } finally { W.g.req = async (cmd) => { throw new Error('no network in this test: ' + cmd); }; }
  assert.deepStrictEqual(sent.map((x) => [x.cmd, x.data.castleId, x.data.heroId, x.data.itemId]),
    [['hero.useItem', 101, 7, 'hero.intelligence.1']]);
  assert.ok(SESSION.notes.some((n) => /^manual: useheroitem OTTO hero\.intelligence\.1 x1 -> 1 used$/.test(n.m)),
    SESSION.notes.slice(-3).map((n) => n.m).join(' | '));
});
t('more than one is asked about first, and dropping the ask sends nothing', async () => {
  if (browserOff) return 'skipped';
  await clickPlus();
  await until(() => ev(`$('hiList').querySelector('input[name=hiPick]') !== null`), 8000, 'the item list');
  await ev(`(() => { $('hiTimes').value = '3'; $('hiGo').click(); })()`);
  const q = await until(() => ev(`(document.querySelector('dialog.ask') || {}).textContent`), 8000, 'the question');
  assert.match(q, /Apply 3 x Excalibur to OTTO\?/);
  assert.match(q, /spends 3 of the 3 held/);
  await ev(`document.querySelector('dialog.ask button[value=no]').click()`);
  await sleep(300);
  assert.ok(!SESSION.notes.some((n) => /hero\.power\.1/.test(n.m)), 'no Excalibur was sent');
});

t('play reaches the tab too', async () => {
  if (browserOff) return 'skipped';
  await post('/api/script', { city: '102', src: 'play "SingleAttack.mp3"' });
  const played = await until(() => ev('__played.length && __played'), 6000, 'the tab to play');
  assert.match(played[0], /\/api\/script\/media\?f=SingleAttack\.mp3$/);
});

// ---------------------------------------------------------------------------

(async () => {
  let pass = 0, fail = 0, skipped = 0;
  for (const [n, f] of tests) {
    if (!f) { origLog('\n' + n + '\n'); continue; }
    try {
      const r = await f();
      if (r === 'skipped') { origLog('  skip  ' + n); skipped++; } else { origLog('  ok    ' + n); pass++; }
    } catch (e) { origLog('  FAIL  ' + n + '\n        ' + String(e && e.message || e).split('\n').slice(0, 14).join('\n        ')); fail++; }
  }
  if (pageErrors.length) origLog('\n  page exceptions (not failures):\n    ' + [...new Set(pageErrors)].slice(0, 8).join('\n    '));
  origLog(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
  try { if (ws) ws.close(); } catch {}
  try { if (chrome) chrome.kill(); } catch {}
  await sleep(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
