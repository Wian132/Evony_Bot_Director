'use strict';
// Claude's keys to a console (claude-guard.js): the two scopes, loopback only,
// the denylist in every scope, the auto scope's per-account permissions, and the
// audit line. Offline: a temp database, fake requests, nothing near a console.
//
//   node test-claude-guard.js
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-claude-guard-'));
if (!process.env.EVONY_DB) process.env.EVONY_DB = path.join(TMP, 't.db');
process.env.OTTO_CLAUDE_AUDIT = path.join(TMP, 'claude-actions.jsonl');

const CG = require('./claude-guard');
const AUTH = require('./auth');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function fakeReq({ token, ip = '127.0.0.1', method = 'GET', url = '/api/session', body = null }) {
  const headers = {};
  if (token) headers['x-otto-claude'] = token;
  return { headers, method, url, socket: { remoteAddress: ip }, _body: body };
}
function fakeRes() {
  const r = { code: null, body: null, writeHead(c) { r.code = c; }, end(b) { r.body = b; } };
  return r;
}
const readBody = async (req) => (req._body === null ? '' : JSON.stringify(req._body));
const gate = async (o) => {
  const req = fakeReq(o), res = fakeRes();
  const url = new URL(req.url, 'http://x');
  const out = await CG.gate(req, res, url, { readBody });
  return { out, req, res, json: res.body ? JSON.parse(res.body) : null };
};
const auditLines = () => (fs.existsSync(process.env.OTTO_CLAUDE_AUDIT)
  ? fs.readFileSync(process.env.OTTO_CLAUDE_AUDIT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const I = CG.claudeToken(), A = CG.claudeAutoToken();

test('two different tokens, kept, and different from the internal one', () => {
  assert.ok(I && A && I !== A);
  assert.strictEqual(CG.claudeToken(), I, 'generated once');
  assert.notStrictEqual(I, AUTH.internalToken());
});

test('scopeOf: interactive, auto, none, bad', () => {
  assert.strictEqual(CG.scopeOf(fakeReq({ token: I })), 'interactive');
  assert.strictEqual(CG.scopeOf(fakeReq({ token: A })), 'auto');
  assert.strictEqual(CG.scopeOf(fakeReq({})), null);
  assert.strictEqual(CG.scopeOf(fakeReq({ token: 'nope' })), 'bad');
});

test('no Claude header: the gate stays out of the way (null)', async () => {
  const { out } = await gate({});
  assert.strictEqual(out, null);
});

test('loopback only — IPv4, IPv6 and v4-mapped pass; anything else is refused', async () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const { out } = await gate({ token: I, ip });
    assert.strictEqual(out, false, ip);
  }
  const r = await gate({ token: I, ip: '192.168.1.20' });
  assert.strictEqual(r.out, true);
  assert.strictEqual(r.res.code, 403);
  assert.match(r.json.error, /only works from this machine/);
});

test('a wrong key is 401', async () => {
  const r = await gate({ token: 'x'.repeat(48) });
  assert.strictEqual(r.out, true);
  assert.strictEqual(r.res.code, 401);
});

test('reads pass in both scopes and mark the request', async () => {
  for (const token of [I, A]) {
    for (const url of ['/api/session', '/api/log?kind=activity', '/api/events?since=3&wait=10', '/api/marches', '/api/script/runs']) {
      const r = await gate({ token, url });
      assert.strictEqual(r.out, false, url);
      assert.ok(r.req.claude && r.req.claude.scope);
    }
  }
});

test('a GET not on the read list is refused (it might log in to answer)', async () => {
  for (const url of ['/api/market', '/api/inn', '/api/map']) {
    const r = await gate({ token: I, url });
    assert.strictEqual(r.out, true, url);
    assert.strictEqual(r.res.code, 403);
  }
});

test('login / relog / settings / maintenance routes are refused in every scope, with why', async () => {
  for (const token of [I, A]) {
    for (const p of ['/api/connect', '/api/reconnect', '/api/switch', '/api/snapshot/refresh', '/api/settings', '/api/maintenance']) {
      const r = await gate({ token, method: 'POST', url: p, body: {} });
      assert.strictEqual(r.out, true, p);
      assert.strictEqual(r.res.code, 403);
      assert.match(r.json.error, /^refused: /);
    }
  }
  const r = await gate({ token: I, method: 'POST', url: '/api/reconnect', body: {} });
  assert.match(r.json.error, /login/);
});

test('interactive may run scripts, in-line commands, the gate and recall; auto may not', async () => {
  for (const p of ['/api/script/inline', '/api/script', '/api/script/stop', '/api/gate', '/api/army/recall', '/api/claude/act']) {
    const ok = await gate({ token: I, method: 'POST', url: p, body: { text: 'who Bob', src: 'sleep 1', city: 1 } });
    assert.strictEqual(ok.out, false, 'interactive ' + p);
  }
  for (const p of ['/api/script/inline', '/api/script', '/api/script/stop', '/api/gate', '/api/army/recall']) {
    const no = await gate({ token: A, method: 'POST', url: p, body: {} });
    assert.strictEqual(no.out, true, 'auto ' + p);
    assert.match(no.json.error, /auto mode/);
  }
  const act = await gate({ token: A, method: 'POST', url: '/api/claude/act', body: { city: 1, action: 'gate', mode: 'closed' } });
  assert.strictEqual(act.out, false);
});

test('the body is read once and kept for the route (req._rawBody)', async () => {
  const r = await gate({ token: I, method: 'POST', url: '/api/script/inline', body: { text: 'who Bob', city: 7 } });
  assert.strictEqual(r.out, false);
  assert.deepStrictEqual(JSON.parse(r.req._rawBody), { text: 'who Bob', city: 7 });
  assert.strictEqual(r.req.claude.body.city, 7);
});

test('deniedCommand: the catastrophic commands, at a command position', () => {
  const no = ['release OTTO', '\\release OTTO', 'fire Bob', 'disband /archer=100', 'resetplayer', 'abandontown 12',
    'abandon', 'allowabandon Flat confirm', 'holiday /exit', 'holiday exit', 'logout 5', 'securitycode set 1234',
    'quitalliance', 'if $x > 1 then release Bob', 'sleep 1\nrelease Bob', 'command "release Bob"', 'execute "fire Bob"',
    'RELEASE Bob', 'sleep 1; release Bob'];
  for (const t of no) assert.ok(CG.deniedCommand(t), `should refuse: ${t}`);
  const ok = ['who Bob', 'recall 312,400', 'say the release is tomorrow', 'holiday 3 confirm', 'gate closed',
    'truce', 'dreamtruce', 'teleport 300,300', 'firstaid', 'releasenotes', 'echo fire at will', ''];
  for (const t of ok) assert.strictEqual(CG.deniedCommand(t), null, `should pass: ${t}`);
  assert.match(CG.deniedCommand('release OTTO'), /loses our hero/);
  assert.match(CG.deniedCommand('holiday /exit'), /never end a holiday/);
});

test('a denied line in a script or an in-line command is refused before the route, and audited', async () => {
  const before = auditLines().length;
  const r = await gate({ token: I, method: 'POST', url: '/api/script', body: { src: 'sleep 2\nrelease OTTO', city: 5, runId: 'x' } });
  assert.strictEqual(r.out, true);
  assert.strictEqual(r.res.code, 403);
  assert.match(r.json.error, /loses our hero/);
  const i = await gate({ token: I, method: 'POST', url: '/api/script/inline', body: { text: '\\holiday /exit', city: 5 } });
  assert.strictEqual(i.out, true);
  const lines = auditLines().slice(before);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].scope, 'interactive');
  assert.strictEqual(lines[0].route, '/api/script');
  assert.match(lines[0].result.refused, /release/);
  assert.match(lines[0].request.src, /release OTTO/);
});

test('a parse-only script check is not refused (it runs nothing)', async () => {
  const r = await gate({ token: I, method: 'POST', url: '/api/script', body: { src: 'release OTTO', parseOnly: true, lines: true } });
  assert.strictEqual(r.out, false);
});

// a stand-in for claude-perms.js, per the contract
const stubPerms = (grants) => ({
  PERMS: ['gate', 'troops', 'teleport', 'truce', 'dreamtruce', 'holiday'],
  allowed: (acct, perm) => !!(grants[acct] && grants[acct][perm]),
  get: (acct) => grants[acct] || {},
  permFor: (t) => {
    const w = String(t).trim().split(/\s+/)[0].toLowerCase();
    if (['recall', 'recallall', 'reinforce', 'evacuatetown', 'dumptroop'].includes(w)) return 'troops';
    if (['teleport', 'warteleport'].includes(w)) return 'teleport';
    if (w === 'truce') return 'truce';
    if (w === 'dreamtruce') return 'dreamtruce';
    if (w === 'holiday' && /confirm/.test(t) && !/\/exit/.test(t)) return 'holiday';
    return null;
  },
});

test('checkAct, auto scope: only what the account allows', () => {
  const P = stubPerms({ a2: { gate: true, troops: true }, a3: {} });
  assert.deepStrictEqual(CG.checkAct('auto', 'a2', { city: 1, action: 'gate', mode: 'closed' }, P), { ok: true, kind: 'gate', perm: 'gate' });
  assert.strictEqual(CG.checkAct('auto', 'a2', { city: 1, command: 'recall 300,300' }, P).perm, 'troops');
  const noTele = CG.checkAct('auto', 'a2', { city: 1, command: 'teleport 1,1' }, P);
  assert.strictEqual(noTele.ok, false);
  assert.match(noTele.error, /"teleport" permission/);
  assert.strictEqual(CG.checkAct('auto', 'a3', { city: 1, action: 'gate', mode: 'open' }, P).ok, false);
  const other = CG.checkAct('auto', 'a2', { city: 1, command: 'who Bob' }, P);
  assert.strictEqual(other.ok, false);
  assert.match(other.error, /not one of the actions/);
  // the denylist wins even over a granted permission
  const P2 = stubPerms({ a2: { holiday: true } });
  assert.strictEqual(CG.checkAct('auto', 'a2', { city: 1, command: 'holiday 3 confirm' }, P2).ok, true);
  assert.match(CG.checkAct('auto', 'a2', { city: 1, command: 'holiday /exit confirm' }, P2).error, /never end a holiday/);
  // no perms module: nothing in auto
  assert.match(CG.checkAct('auto', 'a2', { city: 1, action: 'gate', mode: 'open' }, null).error, /claude-perms/);
});

test('checkAct, interactive: anything not denied; bad shapes refused', () => {
  const P = stubPerms({});
  assert.strictEqual(CG.checkAct('interactive', 'a2', { city: 1, command: 'who Bob' }, P).ok, true);
  assert.strictEqual(CG.checkAct('interactive', 'a2', { city: 1, command: 'release Bob' }, P).ok, false);
  assert.strictEqual(CG.checkAct('interactive', 'a2', { city: 1, action: 'gate', mode: 'sideways' }, P).ok, false);
  assert.strictEqual(CG.checkAct('interactive', 'a2', { city: 1 }, P).ok, false);
  assert.match(CG.checkAct('interactive', 'a2', { city: 1, command: 'who a\nrelease b' }, P).error, /one command/);
});

test('the real claude-perms.js (when there) keeps to the contract', () => {
  let P;
  try { P = require('./claude-perms'); } catch { return; }       // part B not in yet
  for (const k of ['PERMS', 'get', 'allowed', 'permFor']) assert.ok(k in P, k);
  assert.strictEqual(P.permFor('holiday /exit'), null);
  assert.strictEqual(P.permFor('recall 1,1'), 'troops');
  assert.strictEqual(P.permFor('release Bob'), null);
});

test('auditDone writes account, scope, route, request and result', () => {
  const before = auditLines().length;
  const req = { method: 'POST', claude: { scope: 'auto', body: { city: 9, action: 'gate', mode: 'closed' } } };
  CG.auditDone(req, '/api/claude/act', 'a2', 200, JSON.stringify({ ok: true, perm: 'gate' }));
  const l = auditLines().slice(before)[0];
  assert.strictEqual(l.account, 'a2');
  assert.strictEqual(l.scope, 'auto');
  assert.strictEqual(l.request.mode, 'closed');
  assert.strictEqual(l.result.ok, true);
  assert.ok(l.at);
});

test('auth.guard hands a Claude request to the gate before anything else', async () => {
  // no users exist in this database: without a Claude key that is a redirect to /register
  const res = fakeRes();
  const req = fakeReq({ token: I, url: '/api/session' });
  const done = await AUTH.guard(req, res, { readBody });
  assert.strictEqual(done, false);
  assert.strictEqual(req.claude.scope, 'interactive');
  const res2 = fakeRes();
  const done2 = await AUTH.guard(fakeReq({ url: '/api/session' }), res2, { readBody });
  assert.strictEqual(done2, true);
  assert.strictEqual(res2.code, 302);
  const res3 = fakeRes();
  assert.strictEqual(await AUTH.guard(fakeReq({ token: A, method: 'POST', url: '/api/connect', body: {} }), res3, { readBody }), true);
  assert.strictEqual(res3.code, 403);
});

test('needsLive: the acting routes and the city debug read', () => {
  assert.ok(CG.needsLive('POST', '/api/script/inline'));
  assert.ok(CG.needsLive('POST', '/api/claude/act'));
  assert.ok(CG.needsLive('GET', '/api/debug/city'));
  assert.ok(!CG.needsLive('POST', '/api/script/stop'));
  assert.ok(!CG.needsLive('GET', '/api/session'));
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
