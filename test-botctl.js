'use strict';
// Bot consoles: one per account, started by the Director.
//
// Nothing here touches the game. The consoles are stubs — a few lines of node
// that answer /api/session the way server.js does — because what is being tested
// is the bookkeeping around a console: which port it gets, that it is written
// down as a probe (without which the Director cannot see it at all), and that a
// console which dies on startup is reported rather than silently forgotten.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-bot-'));
process.env.EVONY_DB = path.join(TMP, 't.db');
process.env.BOT_LOG_DIR = TMP;
// A range of its own, so a test never lands on a console that is really running.
process.env.BOT_PORT_BASE = '18811';
process.env.BOT_PORT_STEP = '2';
process.env.DIRECTOR_PORT = '18812';
process.env.BOT_READY_MS = '8000';

const D = require('./db');
const BOTS = require('./botctl');

let pass = 0, fail = 0;
const t = (n, f) => async () => {
  try { await f(); console.log('  ok    ' + n); pass++; }
  catch (e) { console.log('  FAIL  ' + n + '\n        ' + (e.stack || e.message)); fail++; }
};
const section = (s) => console.log('\n' + s + '\n');

const O = D.orgs.create('Bot Fleet');
const org = D.org(O.id);
const acc = org.accounts.upsert({ label: 'Runner', email: 'r@x.com', password: 'pw' });
const bare = org.accounts.upsert({ label: 'NoLogin' });

// A stub console: answers /api/session with the account it was given, exactly as
// server.js does, and stays up until it is killed.
const STUB = path.join(TMP, 'stub-console.js');
fs.writeFileSync(STUB, `
require('http').createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ account: { id: process.env.ACCOUNT_ID, label: 'stub' }, connected: true, argv: process.argv.slice(2), paused: process.env.ENGINE_PAUSED === '1' }));
}).listen(Number(process.env.CONSOLE_PORT), '127.0.0.1');
`);
// A console that cannot start: the real one exits(1) when another console
// already holds its account.
const DYING = path.join(TMP, 'dying-console.js');
fs.writeFileSync(DYING, `
console.error('REFUSING TO START: something is already running this account');
process.exit(1);
`);

const started = [];   // pids to clean up, whatever happens

async function main() {
  section('ports');

  await t('the Director\'s own port is never handed to a console', async () => {
    org.settings.set('probes', []);
    const p = await BOTS.pickPort(org);
    assert.notStrictEqual(p, 18812);
    assert.strictEqual(p, 18811);
  })();

  await t('a port already in the probe list is skipped', async () => {
    org.settings.set('probes', [{ probe: 'one', url: 'http://localhost:18811' }]);
    assert.strictEqual(await BOTS.pickPort(org), 18813);
  })();

  await t('and so is a port something else is listening on', async () => {
    org.settings.set('probes', []);
    const s = http.createServer(() => {});
    await new Promise((r) => s.listen(18811, '127.0.0.1', r));
    assert.strictEqual(await BOTS.pickPort(org), 18813);
    await new Promise((r) => s.close(r));
  })();

  section('the probe list');

  await t('a started console is written down, or the Director cannot see it', () => {
    org.settings.set('probes', []);
    BOTS.registerProbe(org, acc, 'http://localhost:18811');
    assert.deepStrictEqual(org.settings.get('probes'), [{ probe: 'Runner', url: 'http://localhost:18811', accountId: acc.id }]);
  })();

  await t('two accounts with the same label still get separate probes', () => {
    const twin = org.accounts.upsert({ label: 'Runner', email: 't@x.com', password: 'pw' });
    BOTS.registerProbe(org, twin, 'http://localhost:18813');
    assert.deepStrictEqual(org.settings.get('probes').map((p) => p.probe), ['Runner', `Runner (${twin.id})`]);
    org.accounts.remove(twin.id);
  })();

  await t('one port holds one probe: restarting on it does not add a second', () => {
    org.settings.set('probes', []);
    BOTS.registerProbe(org, acc, 'http://localhost:18811');
    BOTS.registerProbe(org, acc, 'http://localhost:18811');
    assert.strictEqual(org.settings.get('probes').length, 1);
  })();

  await t('one account holds one probe too: a crash that lands it on a new port drops the old one', () => {
    org.settings.set('probes', []);
    BOTS.registerProbe(org, acc, 'http://localhost:18811');
    BOTS.registerProbe(org, acc, 'http://localhost:18899');
    const list = org.settings.get('probes');
    assert.strictEqual(list.length, 1, 'the dead port was left behind as a ghost probe');
    assert.strictEqual(list[0].url, 'http://localhost:18899');
  })();

  await t('the defaults are never written to the database as probes', () => {
    org.settings.set('probes', []);
    assert.deepStrictEqual(BOTS.storedProbes(org), []);
    assert.deepStrictEqual(BOTS.probeList(org).map((p) => p.probe), ['console']);
  })();

  section('starting a console');

  await t('an account with no password cannot have one: say so, do not spawn', async () => {
    org.settings.set('probes', []);
    const r = await BOTS.start(org, bare);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /email\/password/);
    assert.deepStrictEqual(BOTS.storedProbes(org), [], 'a probe was left behind');
  })();

  await t('a console that dies on startup is reported, with its own words', async () => {
    org.settings.set('probes', []);
    const r = await BOTS.start(org, acc, { script: DYING });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /REFUSING TO START/);
  })();

  await t('and nothing is left behind claiming it is there', async () => {
    assert.deepStrictEqual(BOTS.storedProbes(org), [], 'a probe for a dead console');
    assert.deepStrictEqual(BOTS.bots(org), {}, 'a bot record for a dead console');
  })();

  await t('a console that comes up is reported ready, on a port of its own', async () => {
    org.settings.set('probes', []);
    const r = await BOTS.start(org, acc, { script: STUB });
    if (r.pid) started.push(r.pid);
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.ready, true);
    assert.strictEqual(r.port, 18811);
    assert.ok(BOTS.alive(r.pid), 'the process is not running');
  })();

  await t('it is in the probe list under the account label', () => {
    assert.deepStrictEqual(BOTS.storedProbes(org), [{ probe: 'Runner', url: 'http://localhost:18811', accountId: acc.id }]);
  })();

  await t('an account starts live even with no goals of its own (prepend goals may be all it has)', () => {
    assert.strictEqual(BOTS.bots(org)[acc.id].paused, false);
  })();

  await t('hasGoals sees an account’s own default goals', () => {
    assert.strictEqual(BOTS.hasGoals(org, acc), false);
    org.goals.set(acc.id, 'default', 'goal', 'build f:10:10');
    assert.strictEqual(BOTS.hasGoals(org, acc), true);
  })();

  section('not twice');

  await t('the console already running the account is found', async () => {
    const held = await BOTS.running(org, acc);
    assert.ok(held, 'a running console was not seen');
    assert.strictEqual(held.port, 18811);
  })();

  await t('starting again adopts it instead of spawning a second login', async () => {
    const before = BOTS.bots(org)[acc.id].pid;
    const r = await BOTS.start(org, acc, { script: STUB });
    if (r.pid && r.pid !== before) started.push(r.pid);
    assert.strictEqual(r.adopted, true, 'a second console was started for one account');
    assert.strictEqual(BOTS.bots(org)[acc.id].pid, before, 'the record changed process');
    assert.strictEqual(BOTS.storedProbes(org).length, 1);
  })();

  section('stopping');

  await t('stop takes the process down and takes back the probe', async () => {
    const pid = BOTS.bots(org)[acc.id].pid;
    const r = await BOTS.stop(org, acc);
    assert.strictEqual(r.ok, true, r.error);
    // the kill is asynchronous as far as this process is concerned
    for (let i = 0; i < 40 && BOTS.alive(pid); i++) await new Promise((x) => setTimeout(x, 50));
    assert.ok(!BOTS.alive(pid), 'the console is still running');
    assert.deepStrictEqual(BOTS.storedProbes(org), []);
    assert.deepStrictEqual(BOTS.bots(org), {});
  })();

  await t('stopping a console nobody started is a message, not a crash', async () => {
    const r = await BOTS.stop(org, acc);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /no console on record/);
  })();

  section("start-up parameters (NEAT's Custom Parameters, and each account's own)");

  await t("a console gets the fleet's and its account's on its command line, the account's winning", async () => {
    org.settings.set('probes', []);
    const other = org.accounts.upsert({ label: 'Parms', email: 'p@x.com', password: 'pw' });
    org.goals.set(other.id, 'default', 'goal', 'build f:10:10');
    org.settings.set(BOTS.PARMS_KEY, '-autoscripts 1 -runscript "Fleet Start.txt"');
    org.settings.set(BOTS.PARMS_KEY + ':' + other.id, '-autoscripts 0\n-autorun 0');
    assert.deepStrictEqual(BOTS.startupParms(org, other.id).args, ['-autoscripts', '0', '-runscript', 'Fleet Start.txt', '-autorun', '0']);
    const r = await BOTS.start(org, other, { script: STUB });
    if (r.pid) started.push(r.pid);
    assert.strictEqual(r.ok, true, r.error);
    const h = await new Promise((res) => http.get(r.url + '/api/session', (x) => { let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => res(JSON.parse(d))); }));
    assert.deepStrictEqual(h.argv, ['-autoscripts', '0', '-runscript', 'Fleet Start.txt', '-autorun', '0'], 'what the console was started with');
    assert.strictEqual(h.paused, true, '-autorun 0 starts the engine paused, goals or not');
    assert.deepStrictEqual(BOTS.bots(org)[other.id].args, h.argv, 'kept, so the Director can tell a console on old parameters');
    await BOTS.stop(org, other);
  })();

  for (const pid of started) { try { process.kill(pid); } catch {} }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main();
