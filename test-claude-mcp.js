'use strict';
// otto-mcp.js, end to end: spawned as Claude Code would spawn it, talking MCP
// over stdio, against a FAKE console on a random local port. It checks the
// protocol (initialize, tools/list, tools/call, ping), account resolution (id,
// alias, name, prefix), that Claude's key from the database is what the
// console is sent, the long-poll wait, and output truncation. Offline: a temp
// database; nothing here goes near the live Director or a real console.
//
//   node test-claude-mcp.js
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-claude-mcp-'));
if (!process.env.EVONY_DB) process.env.EVONY_DB = path.join(TMP, 't.db');
const PRIV = path.join(TMP, 'privacy.json');
fs.writeFileSync(PRIV, JSON.stringify({ aliases: { Lord07: { id: 'a1', names: ['x'] } } }));
const LOGDIR = path.join(TMP, 'logs');
fs.mkdirSync(LOGDIR);

const D = require('./db');
const CG = require('./claude-guard');
const O = D.orgs.create('MCP Fleet');
const org = D.org(O.id);
const a1 = org.accounts.upsert({ label: 'Alfa', server: 'ss9', email: 'a@x.com', password: 'p' });
const a2 = org.accounts.upsert({ label: 'Bravo', server: 'ss9', email: 'b@x.com', password: 'p' });
const a3 = org.accounts.upsert({ label: 'Bravissimo', server: 'ss9', email: 'c@x.com', password: 'p' });
// a3 has no console but a log file on disk: log() falls back to its tail
fs.writeFileSync(path.join(LOGDIR, `console-${a3.id}.log`), Array.from({ length: 5000 }, (_, i) => `line ${i} ${i % 100 === 0 ? 'ATTACK' : 'quiet'}`).join('\n') + '\n');

// ---- the fake console ---------------------------------------------------------
const seen = [];                         // { method, path, claude, body }
let events = [{ seq: 1, t: Date.now(), type: 'connected', account: a1.id }];
let eventSeq = 1;
const pushEvent = (e) => { events.push({ seq: ++eventSeq, t: Date.now(), account: a1.id, ...e }); };
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const body = b ? JSON.parse(b) : null;
    seen.push({ method: req.method, path: u.pathname, claude: req.headers['x-otto-claude'], body });
    const json = (v, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (req.headers['x-otto-claude'] !== CG.claudeToken()) return json({ ok: false, error: 'not signed in', login: '/login' }, 401);
    switch (u.pathname) {
      case '/api/session': return json({
        connected: true, state: 'connected', paused: false, account: { id: a1.id, label: 'Alfa' }, server: 'ss9', lord: 'alfa',
        prestige: 12345678, rank: 9, coins: 50, protection: null, kick: null, maintenance: { phase: 'none' },
        underAttack: { on: true, at: Date.now(), cities: [{ id: 11, name: 'Home', inbound: 2, junk: 1, firstLandsAt: Date.now() + 120000, lastWaveAt: null, loyalty: 88 }] },
        cities: [{ id: 11, name: 'Home', gateOpen: false, gate: 'auto', incoming: 2 }, { id: 12, name: 'Hub', gateOpen: true, gate: 'open', incoming: 0 }],
        snapshot: { totals: { food: 2e9, wood: 1e6, stone: 3e9, iron: 5e5, gold: 7e10 }, troops: 2.5e6, marchingTroops: 0, heroes: 12, captives: [],
          cityList: [{ id: 11, name: 'Home', x: 10, y: 20, troops: 2e6, food: 1e9, gold: 5e10, heroes: 8 }, { id: 12, name: 'Hub', x: 11, y: 21, troops: 5e5, food: 1e9, gold: 2e10, heroes: 4 }] },
      });
      case '/api/script/runs': return json({ runs: [{ city: '11', runId: '11-abc', startedAt: Date.now(), source: 'console' }],
        lines: u.searchParams.get('city') ? ['07:00:00.000 line 1: sleep 1', '07:00:01.000 done'] : null, dropped: 0, ended: null });
      case '/api/log': {
        const big = u.searchParams.get('q') === 'huge';
        const lines = Array.from({ length: big ? 300 : 3 }, (_, i) => ({ t: Date.now() - (i === 0 && !big ? 3600000 : 0), m: big ? 'x'.repeat(100) + i : `entry ${i} wave`, city: 'Home', kind: 'act' }));
        return json({ lines, total: lines.length });
      }
      case '/api/marches': return json({ serverNow: Date.now(), outgoing: [{ mission: 'transport', from: 'Home', to: 'Hub', direction: 'out', troopTotal: 100, reachTime: Date.now() + 60000 }],
        incoming: [{ hostile: true, mission: 'attack', king: 'Raider', myCity: 'Home', scouted: false, reachTime: Date.now() + 120000 }], count: 1, incomingCount: 1 });
      case '/api/city': return json({ id: 11, name: 'Home', x: 10, y: 20, tax: 20, resources: { food: 1e9, gold: 5e10, population: 5000, maxPopulation: 6000, idle: 100 },
        troops: [{ key: 'archer', count: 1000 }, { key: 'scout', count: 0 }], fortifications: { trap: 500 }, general: { gates: 'Closed', loyalty: 88, complaint: 0 },
        heroes: [{ name: 'OTTO', level: 300, status: 0, levelsReady: 2 }], construction: [], incoming: {} });
      case '/api/engine/report': return json({ report: { city: 'Home', notes: ['all good'] } });
      case '/api/script/inline': return json({ ok: true, error: null, lines: [`who: ${body.text} in ${body.city}`], result: { n: 1 } });
      case '/api/script': return json({ ok: true, started: true, city: String(body.city), log: ['parsed 1 action(s)', 'started'] });
      case '/api/script/stop': return json({ ok: true });
      case '/api/claude/act': return json(body.action === 'gate' ? { ok: true, perm: 'gate', gateOpen: false } : { ok: false, error: 'refused: not allowed' }, body.action === 'gate' ? 200 : 403);
      case '/api/events': {
        const since = Number(u.searchParams.get('since') || 0);
        const wait = Number(u.searchParams.get('wait') || 0);
        const types = u.searchParams.get('types') ? new Set(u.searchParams.get('types').split(',')) : null;
        const now = () => events.filter((e) => e.seq > since && (!types || types.has(e.type)));
        const answer = () => json({ ok: true, boot: 'b1', seq: eventSeq, events: now().slice(-Number(u.searchParams.get('limit') || 200)) });
        if (now().length || !wait) return answer();
        const t = setInterval(() => { if (now().length) { clearInterval(t); answer(); } }, 20);
        setTimeout(() => { clearInterval(t); if (!res.writableEnded) answer(); }, wait * 1000);
        return undefined;
      }
      default: return json({ error: 'nope' }, 404);
    }
  });
});

// ---- the MCP client -----------------------------------------------------------
function startMcp(extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, 'otto-mcp.js')], {
    cwd: __dirname, env: { ...process.env, OTTO_PRIVACY_MAP: PRIV, BOT_LOG_DIR: LOGDIR, OTTO_CLAUDE_MODE: 'interactive', ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '', nextId = 1;
  const waiting = new Map();
  const stray = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const msg = JSON.parse(line);           // stdout must be pure protocol
      if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); } else stray.push(msg);
    }
  });
  let err = '';
  child.stderr.on('data', (c) => (err += c));
  const rpc = (method, params, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => reject(new Error(`no answer to ${method} (stderr: ${err.slice(-300)})`)), timeoutMs);
    waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const tool = async (name, args = {}, timeoutMs) => {
    const r = await rpc('tools/call', { name, arguments: args }, timeoutMs);
    return { text: r.result.content[0].text, isError: !!r.result.isError };
  };
  return { child, rpc, notify, tool, stray, stderr: () => err };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let M;

test('initialize echoes the protocol version; notifications get no answer; ping', async () => {
  const r = await M.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.strictEqual(r.result.protocolVersion, '2025-03-26');
  assert.strictEqual(r.result.serverInfo.name, 'otto');
  assert.ok(r.result.capabilities.tools);
  M.notify('notifications/initialized', {});
  const p = await M.rpc('ping', {});
  assert.deepStrictEqual(p.result, {});
  assert.strictEqual(M.stray.length, 0, 'the notification was not answered');
  const bad = await M.rpc('nope/method', {});
  assert.strictEqual(bad.error.code, -32601);
});

test('tools/list names every tool, each with a schema', async () => {
  const r = await M.rpc('tools/list', {});
  const names = r.result.tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['act', 'cmd', 'events', 'fleet', 'log', 'script', 'script_runs', 'script_stop', 'state', 'wait']);
  for (const t of r.result.tools) assert.strictEqual(t.inputSchema.type, 'object');
});

test('fleet: every account in one call — up, attack, scripts; no console; a dead port', async () => {
  const { text } = await M.tool('fleet');
  assert.match(text, /3 accounts, 1 up/);
  assert.match(text, new RegExp(`${a1.id}\\s+Alfa.*Lord07.*up.*scripts 1.*ATTACK Home: 2 inbound`));
  assert.match(text, /\(\+1 junk\)/);
  assert.match(text, new RegExp(`${a2.id}\\s+Bravo.*not running`));
  assert.match(text, new RegExp(`${a3.id}\\s+Bravissimo.*no console`));
  assert.ok(text.length < 1500, 'short');
});

test('the console is sent Claude\'s interactive key from the database', () => {
  const s = seen.filter((x) => x.path === '/api/session');
  assert.ok(s.length);
  assert.ok(s.every((x) => x.claude === CG.claudeToken()));
});

test('account resolution: id, alias, name, prefix; ambiguous and unknown are clear errors', async () => {
  for (const q of [a1.id, 'Lord07', 'alfa', 'ALF']) {
    const { text, isError } = await M.tool('state', { account: q });
    assert.ok(!isError, `${q}: ${text}`);
    assert.match(text, new RegExp(`^${a1.id} Alfa \\(Lord07\\)`));
  }
  const amb = await M.tool('state', { account: 'brav' });
  assert.ok(amb.isError);
  assert.match(amb.text, /matches .*Bravo.*Bravissimo/);
  const none = await M.tool('state', { account: 'zulu' });
  assert.ok(none.isError);
  assert.match(none.text, /no account "zulu"/);
});

test('state: summary with cities; one city in depth', async () => {
  const all = await M.tool('state', { account: a1.id });
  assert.match(all.text, /UNDER ATTACK: Home: 2 inbound/);
  assert.match(all.text, /totals: food 2\.0b .*gold 70\.0b/);
  assert.match(all.text, /Hub\(12\).*gate:OPEN\(open\)/);
  assert.match(all.text, /HOSTILE attack Raider -> Home \? troops/);
  const one = await M.tool('state', { account: a1.id, city: 'home' });
  assert.match(one.text, /Home \(11\) 10,20 — gate Closed · loyalty 88/);
  assert.match(one.text, /troops: archer 1k/);
  assert.match(one.text, /OTTO L300 idle \+2lv/);
  assert.match(one.text, /engine: .*all good/);
  const bad = await M.tool('state', { account: a1.id, city: 'Nowhere' });
  assert.ok(bad.isError);
  assert.match(bad.text, /no city "Nowhere".*Home \(11\)/);
});

test('log: filtered on the console, the since window applied here', async () => {
  const { text } = await M.tool('log', { account: a1.id, grep: 'wave', since: '15m' });
  assert.match(text, /2 of 2 line\(s\)/, 'the hour-old line is outside 15m');
  const q = seen.filter((x) => x.path === '/api/log').pop();
  assert.ok(q, 'asked the console');
});

test('log: output is truncated, with a hint to narrow it', async () => {
  const { text } = await M.tool('log', { account: a1.id, grep: 'huge', limit: 400 });
  assert.match(text, /… \(truncated \d+ more chars — narrow it/);
  assert.ok(text.length < 3300);
});

test('log: a console that is down falls back to the tail of its log file', async () => {
  const { text, isError } = await M.tool('log', { account: a3.id, grep: 'ATTACK', limit: 5 });
  assert.ok(!isError, text);
  assert.match(text, /tail of console-.*\.log instead \(5 line\(s\)\)/);
  assert.match(text, /line 4900 ATTACK/);
});

test('cmd, script, script_stop, script_runs go to the right routes with the city id', async () => {
  const c = await M.tool('cmd', { account: a1.id, city: 'Hub', text: 'who Bob' });
  assert.match(c.text, /Hub: ok\nwho: who Bob in 12/);
  const s = await M.tool('script', { account: a1.id, city: 11, text: 'sleep 1' });
  assert.match(s.text, /started/);
  const sent = seen.filter((x) => x.path === '/api/script').pop();
  assert.match(sent.body.runId, /^claude-/);
  assert.strictEqual(sent.body.city, 11);
  const st = await M.tool('script_stop', { account: a1.id, city: 'Home' });
  assert.match(st.text, /stop sent/);
  assert.strictEqual(seen.filter((x) => x.path === '/api/script/stop').pop().body.city, '11');
  const runs = await M.tool('script_runs', { account: a1.id, city: 'Home' });
  assert.match(runs.text, /1 running\n {2}Home 11-abc/);
  assert.match(runs.text, /done/);
});

test('act: gate goes through; a refusal is reported, not thrown', async () => {
  const g = await M.tool('act', { account: a1.id, city: 'Home', action: 'gate', mode: 'closed' });
  assert.match(g.text, /gate closed: ok \[perm gate\]/);
  const n = await M.tool('act', { account: a1.id, city: 'Home', action: 'command', command: 'who Bob' });
  assert.match(n.text, /REFUSED\/FAILED: refused: not allowed/);
});

test('events: the first look, then only what is new', async () => {
  const first = await M.tool('events', { account: a1.id });
  assert.match(first.text, /connected/);
  const again = await M.tool('events', { account: a1.id });
  assert.match(again.text, /^0 event\(s\) since the last look/);
  pushEvent({ type: 'script_finished', runId: '11-abc', city: 'Home', n: 3, secs: 4, tail: ['done'] });
  const next = await M.tool('events', { account: 'all' });
  assert.match(next.text, /script_finished Home run 11-abc done n=3 4s/);
});

test('wait: returns as soon as a matching event arrives, skipping others', async () => {
  const t0 = Date.now();
  setTimeout(() => pushEvent({ type: 'march_arrived', mission: 'transport', from: 'Home', to: 'Hub', troops: 5 }), 200);
  setTimeout(() => pushEvent({ type: 'attack_incoming', city: 'Home', king: 'Raider', troops: 90000, inSec: 300 }), 500);
  const r = await M.tool('wait', { account: a1.id, types: 'attack_incoming', timeout_s: 20 }, 30000);
  assert.match(r.text, /matched on [^]*attack_incoming Home: Raider 90k troops lands in 5m/);
  assert.ok(Date.now() - t0 < 5000, 'did not sit out the timeout');
  const p = await (async () => {
    setTimeout(() => pushEvent({ type: 'gate_changed', city: 'Hub', open: true, by: 'engine' }), 150);
    return M.tool('wait', { account: 'all', pattern: 'Hub', timeout_s: 10 }, 20000);
  })();
  assert.match(p.text, /gate_changed Hub: OPEN by engine/);
  const none = await M.tool('wait', { account: a1.id, types: 'maintenance', timeout_s: 1 }, 15000);
  assert.match(none.text, /nothing matched in 1s/);
});

test('auto mode: cmd and script are refused locally, and the auto key is what is sent', async () => {
  const A = startMcp({ OTTO_CLAUDE_MODE: 'auto' });
  try {
    await A.rpc('initialize', { protocolVersion: '2025-06-18' });
    const c = await A.tool('cmd', { account: a1.id, city: 'Home', text: 'who Bob' });
    assert.ok(c.isError);
    assert.match(c.text, /auto mode: use act/);
    const f = await A.tool('fleet');
    // the fake console only knows the interactive key, as a console refusing the auto key would
    assert.match(f.text, /needs a restart|not signed in|does not know/);
    assert.ok(seen.some((x) => x.claude === CG.claudeAutoToken()));
  } finally { A.child.kill(); }
});

test('stdout carried nothing but protocol, stderr the diagnostics', () => {
  assert.match(M.stderr(), /\[otto-mcp\] ready \(mode interactive/);
});

(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const port = fake.address().port;
  // a1 on the fake console, a2 on a port nobody listens on, a3 with no console at all
  org.settings.set('bots', { [a1.id]: { url: `http://localhost:${port}`, port }, [a2.id]: { url: 'http://localhost:1', port: 1 } });
  M = startMcp({ OTTO_MCP_MAX_CHARS: '3000' });
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
  }
  M.child.kill();
  fake.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
