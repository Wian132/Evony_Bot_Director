'use strict';
// The console editor colours every goal line: blue when the engine acts on it,
// red when it has an error or reads fine but does nothing yet, grey for comments.
// The colours come from here: parseGoals' `lines` (goals.js), one status per
// source line, the NOT_IMPLEMENTED table behind "does nothing yet", and
// script.js lineStatus for scripts. The last section drives the two console
// routes the editor asks (server.js in this process: no port, no game, no
// outbound connection of any kind).
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-goal-lines-'));
process.env.EVONY_DB = path.join(TMP, 't.db');

// Nothing here may open a connection: the route tests load server.js, and a
// console that tried to reach the game or another console must fail loudly.
const net = require('net'), tls = require('tls'), http = require('http'), https = require('https');
const refuse = (what) => () => { throw new Error(`${what} is blocked in this test — it must not open a connection`); };
net.connect = net.createConnection = refuse('net.connect');
tls.connect = refuse('tls.connect');
http.get = http.request = refuse('http.request');
https.get = https.request = refuse('https.request');
globalThis.fetch = refuse('fetch');

const G = require('./goals');
const S = require('./script');
const { parseGoals, NOT_IMPLEMENTED } = G;

let pass = 0, fail = 0;
const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);

const st = (src) => parseGoals(src).lines.map((l) => l.status);
const line = (src, n = 1) => parseGoals(src).lines[n - 1];

// ---------------------------------------------------------------------------
section('goal lines: one status per source line');

t('every source line gets one entry, numbered from 1, whatever the line endings', () => {
  const p = parseGoals('troop a:1k\r\n\r\n// note\r\nconfig npc:5\n');
  assert.deepStrictEqual(p.lines.map((l) => l.n), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(p.lines.map((l) => l.status), ['ok', 'blank', 'comment', 'ok', 'blank']);
  assert.deepStrictEqual(parseGoals('').lines, [{ n: 1, status: 'blank', msg: null }]);
  assert.strictEqual(parseGoals(null).lines.length, 1);
});

t('blank and whitespace-only lines are blank', () => {
  assert.deepStrictEqual(st('\n   \n\t'), ['blank', 'blank', 'blank']);
});

t('a // or # line, indented or not, is a comment', () => {
  assert.deepStrictEqual(st('// a\n  // b\n# c\n\t#d\n//troop a:1k'), ['comment', 'comment', 'comment', 'comment', 'comment']);
});

t('a line the engine acts on is ok, with no message', () => {
  for (const src of ['troop b:5k,t:5k', 'fortification ab:5000', 'build f:10:37', 'comfortpolicy 15 16 popraise',
    'config comfort:1,hero:1,npc:5', 'requestresources any wood 2000000 200000 * 500000 /below:100000', 'npcheroes !OTTO,any',
    'traininghero OTTO 30 60', 'distancepolicy 15', 'npcteams 3', 'farmingpolicy 5 /distance:10',
    'defensepolicy /usetruce:79 /usespeech:2 /junktroop:5000', 'gatepolicy 0 0 0 0 0', 'rallypolicy n:3 r:2']) {
    assert.deepStrictEqual(line(src), { n: 1, status: 'ok', msg: null }, src);
  }
});

t('an unknown goal is an error, with the message Apply shows', () => {
  const p = parseGoals('troop a:1k\nbogus 1');
  assert.deepStrictEqual(p.lines[1], { n: 2, status: 'error', msg: 'unknown goal "bogus"' });
  assert.strictEqual(p.errors[0].error, p.lines[1].msg);
});

t('a bad value is an error, even though what did parse on the line still runs', () => {
  const p = parseGoals('troop a:10k,zz:5');
  assert.strictEqual(p.lines[0].status, 'error');
  assert.match(p.lines[0].msg, /unknown troop code "zz"/);
  assert.deepStrictEqual(p.goals[0].troops, { archer: 10000 }, 'the archers still train, as before');
});

t('an unknown config key, a spaced pair and a troopslot with a suffix are errors', () => {
  assert.match(line('config foo:1').msg, /unknown config key "foo"/);
  assert.strictEqual(line('config npc:5 // farm').status, 'error', 'an inline comment is not a comment in goals');
  assert.match(line('config troopslot:30m').msg, /troopslot is minutes per training batch/);
});

t('a bad switch is an error', () => {
  assert.match(line('gatepolicy 0 0 0 0 0 /bogus:1').msg, /unknown switch "\/bogus"/);
  assert.match(line('hidingpolicy /nope:1').msg, /unknown switch/);
  assert.strictEqual(line('requestresources any wood 1 2 3 4 /fast:1').status, 'error');
});

t('a one-per-city goal written twice: the earlier line is red and says which line replaced it', () => {
  const p = parseGoals('comfortpolicy 15 16 popraise\ntroop a:1k\ncomfortpolicy 10 20 pray');
  assert.strictEqual(p.lines[0].status, 'error');
  assert.match(p.lines[0].msg, /comfortpolicy is written again on line 3, and the later line wins, so this one does nothing/);
  assert.deepStrictEqual(p.lines[2], { n: 3, status: 'ok', msg: 'replaces line 1' });
  // Apply still reports it on the later line, word for word as before
  assert.deepStrictEqual(p.errors, [{ line: 3, text: 'comfortpolicy 10 20 pray',
    error: 'comfortpolicy appears more than once — the later one wins (line 1 discarded)' }]);
});

t('written three times, both earlier lines are red; a replaced line with its own error says both', () => {
  assert.deepStrictEqual(st('npcteams 1\nnpcteams 2\nnpcteams 3'), ['error', 'error', 'ok']);
  const p = parseGoals('npcteams x\nnpcteams 3');
  assert.match(p.lines[0].msg, /^NPCTEAMS: .*; npcteams is written again on line 2/);
});

// ---------------------------------------------------------------------------
section('lines that read fine but do nothing yet (NOT_IMPLEMENTED)');

t('the table only names things that parse: accepted config keys, known goals, config-kind goals', () => {
  for (const k of Object.keys(NOT_IMPLEMENTED.config)) assert.ok(G.CONFIG_KEYS.has(k), `config key ${k} is not accepted at all`);
  for (const k of Object.keys(NOT_IMPLEMENTED.goals)) assert.ok(G.GOALS[k], `goal ${k} does not exist`);
  for (const k of NOT_IMPLEMENTED.bare) assert.strictEqual((G.GOALS[k] || {}).kind, 'config', `${k} is not a config-kind goal`);
  for (const [k, why] of [...Object.entries(NOT_IMPLEMENTED.config), ...Object.entries(NOT_IMPLEMENTED.goals)]) {
    assert.ok(typeof why === 'string' && why.length > 10, `${k} needs a reason`);
  }
});

t('monitorarmy is in no list: NEAT documents it as doing nothing, so it is ok either way', () => {
  assert.ok(!('monitorarmy' in NOT_IMPLEMENTED.config) && !NOT_IMPLEMENTED.bare.includes('monitorarmy'));
  for (const src of ['config monitorarmy:1', 'monitorarmy', 'monitorarmy 1']) assert.strictEqual(line(src).status, 'ok', src);
});

t('each listed config key on its own config line is idle and names the key', () => {
  for (const k of Object.keys(NOT_IMPLEMENTED.config)) {
    const l = line(`config ${k}:1`);
    assert.strictEqual(l.status, 'idle', k);
    assert.ok(l.msg.startsWith(`${k} does nothing yet: ${NOT_IMPLEMENTED.config[k]}`), l.msg);
  }
});

// (Step 14 built config trade, so these use valley, which still does nothing.)
t('a config line with one idle key among working ones is red, naming the idle key and the ones that work', () => {
  const l = line('config comfort:1,hero:1,valley:1');
  assert.strictEqual(l.status, 'idle');
  assert.strictEqual(l.msg, `valley does nothing yet: ${NOT_IMPLEMENTED.config.valley} (comfort and hero on this line work)`);
  assert.match(line('config valley:1,npc:5').msg, /\(npc on this line works\)$/);
  assert.match(line('config valley:1,hunting:1').msg, /^valley does nothing yet: .*; hunting does nothing yet: /);
  // the values still reach the engine, exactly as before
  assert.deepStrictEqual(parseGoals('config comfort:1,hero:1,valley:1').config, { comfort: 1, hero: 1, valley: 1 });
});

t('an unknown key and an idle key on one line: an error, saying both, and never calling the unknown key working', () => {
  const l = line('config foo:1,valley:1');
  assert.strictEqual(l.status, 'error');
  assert.match(l.msg, /unknown config key "foo"; valley does nothing yet/);
  assert.ok(!/foo on this line works/.test(l.msg), l.msg);
});

t('each report-only goal line is idle', () => {
  const sample = { homeheroes: 'homeheroes 3', spamheroes: 'spamheroes any', keepcapturedheroes: 'keepcapturedheroes any:level>=200' };
  for (const k of Object.keys(NOT_IMPLEMENTED.goals)) {
    const l = line(sample[k] || `${k} any`);
    assert.strictEqual(l.status, 'idle', k);
    assert.strictEqual(l.msg, `${k} does nothing yet: ${NOT_IMPLEMENTED.goals[k]}`);
  }
});

// Step 9: a war setting written as a line of its own is read as the config it
// means, so it works (blue), and the line says how it was read.
t('a war setting written as a line of its own is read as config, and says how to write it', () => {
  assert.deepStrictEqual(NOT_IMPLEMENTED.bare, [], 'none is left doing nothing');
  const val = { hiding: '5', attackgap: '3', defensecooldown: '10' };
  for (const k of ['hiding', 'gate', 'warrules', 'wartown', 'keepatthome', 'attackgap', 'defensecooldown', 'nohealing']) {
    const v = val[k] || '1';
    const l = line(`${k} ${v}`);
    assert.strictEqual(l.status, NOT_IMPLEMENTED.config[k] ? 'idle' : 'ok', `${k}: ${l.msg}`);
    assert.ok(l.msg.endsWith(`read as "config ${k}:${v}" — ${k} is a config key, so write it that way`), l.msg);
    assert.strictEqual(parseGoals(`${k} ${v}`).config[k], Number(v), `${k} reaches config`);
  }
  assert.strictEqual(line('wartown 5').status, 'error', 'a bad value is still an error');
  assert.strictEqual(line('wartown').status, 'error', 'and so is no value');
});

t('the table is the one switch: a key taken off it turns ok with nothing else changed', () => {
  const was = NOT_IMPLEMENTED.config.valley;
  delete NOT_IMPLEMENTED.config.valley;
  try { assert.deepStrictEqual(line('config valley:1'), { n: 1, status: 'ok', msg: null }); }
  finally { NOT_IMPLEMENTED.config.valley = was; }
  // Step 18 took spamheroes off (the script's spam attacks use its heroes), so
  // the goals half is shown with an entry put on for the test and taken off again.
  assert.strictEqual(line('spamheroes any').status, 'ok');
  NOT_IMPLEMENTED.goals.spamheroes = 'a reason put here by this test only';
  try { assert.strictEqual(line('spamheroes any').status, 'idle'); }
  finally { delete NOT_IMPLEMENTED.goals.spamheroes; }
  assert.deepStrictEqual(line('spamheroes any'), { n: 1, status: 'ok', msg: null });
});

// Step 4 made these work (War Town, KeepAttHome, HomeHeroes, AttackGap,
// DefenseCooldown, WarTownPolicy): they are off the table and come out blue.
t('war town, keep-home and the defence timings are blue; wartownpolicy too', () => {
  for (const k of ['wartown', 'keepatthome', 'attackgap', 'defensecooldown']) {
    assert.ok(!(k in NOT_IMPLEMENTED.config), `${k} is still on the table`);
  }
  assert.ok(!('homeheroes' in NOT_IMPLEMENTED.goals), 'homeheroes is still on the table');
  for (const src of ['config wartown:2', 'config wartown:1,keepatthome:1', 'config attackgap:3,defensecooldown:10',
    'homeheroes 2', 'wartownpolicy 06:00 12:00', 'wartownpolicy 22:00 02:00 5:00 7:30']) {
    assert.deepStrictEqual(line(src), { n: 1, status: 'ok', msg: null }, src);
  }
  assert.strictEqual(line('wartownpolicy 06:00').status, 'error', 'a start with no end is an error');
  assert.strictEqual(line('wartownpolicy 6 12').status, 'error', 'so is a time that is not hh:mm');
});

// ---------------------------------------------------------------------------
section('parseGoals is otherwise unchanged');

t('config, goals and errors are what the engine always had; lines is the only new field', () => {
  const p = parseGoals('config npc:5\nconfig npc:3,comfort:1\ntroop a:1k\ntroop s:5\nbogus');
  assert.deepStrictEqual(Object.keys(p), ['config', 'goals', 'errors', 'lines']);
  assert.deepStrictEqual(p.config, { npc: 3, comfort: 1 });
  assert.deepStrictEqual(p.goals.map((g) => [g.name, g.line, g.raw]), [['troop', 3, 'troop a:1k'], ['troop', 4, 'troop s:5']]);
  assert.deepStrictEqual(Object.keys(p.goals[0]).sort(), ['kind', 'line', 'name', 'raw', 'switches', 'troops']);
  assert.deepStrictEqual(p.errors, [{ line: 5, text: 'bogus', error: 'unknown goal "bogus"' }]);
});

// ---------------------------------------------------------------------------
section('the live goals: blue, except what does nothing yet');

// As saved for the live cities on 2026-09-14 (Lord22's city, a Lord02 city,
// Lord02's default); Lord02's other cities hold the same text. The
// requestresources lines are as migrate-goals-transfer.js rewrites them into
// NEAT's argument order (Step 9); test-neat-compat.js covers the rewrite.
const LIVE = {
  lord22: `// Lord22 build-up
config comfort:1,hero:1,troopsusepopmax:1
comfortpolicy 15 16 popraise
defensepolicy /usetruce:79 /usespeech:2 /junktroop:5000 /usewarhorn:1 /usecorselet:1 /usepenicillin:1
build f:10:37,s:0:0,i:0:0,q:0:0
// troop ladder: ballista+transports first, then a broad base, then archers/scouts
troop b:5k,t:5k
troop wo:10k,w:10k,s:10k,p:10k,sw:10k,a:10k,t:10k,c:10k,cata:10k,b:10k
troop a:100k,s:100k

fortification ab:5000
`,
  lord02: `// Lord02 — the same build-up ladder as Lord22, plus NPC level-5 farming.
config comfort:1,hero:1,troopsusepopmax:1,npc:5
comfortpolicy 15 16 popraise
defensepolicy /usetruce:79 /usespeech:2 /junktroop:5000 /usewarhorn:1 /usecorselet:1 /usepenicillin:1
// NOTE: Lord22 runs \`build f:10:37,s:0:0,i:0:0,q:0:0\`. The s/i/q:0:0 part means
// DEMOLISH every sawmill, ironmine and quarry — on Lord22 that is a one-city
// build-out, but on Lord02 it would have flattened 26 sawmills and 12 iron
// mines across four developed cities, and demolition cannot be undone.
// Farms only for now. Delete this line and restore the one below it to opt in.
build fh:1
build th:10,w:10,c:10:1,b:10:1,a:10:1,r:10:1,be:10:1,rs:10:1
build f:10:37
// build f:10:37,s:0:1,i:0:1,q:0:1
// troop ladder: ballista and transports first — NPC farming rides on exactly
// those two, so this ladder feeds the farming rather than competing with it
troop b:5k,t:5k
troop wo:10k,w:10k,s:10k,p:10k,sw:10k,a:10k,t:10k,c:10k,cata:10k,b:10k
troop a:100k,s:100k

fortification ab:5000

// --- NPC farming, level 5 only ---------------------------------------------
// config npc:5 sets the LOWEST level to farm and the engine works downwards
// from 10. Levels 6-10 are refused outright unless an "npclimits <level> ..."
// line says what garrison must stay home, and there is none here on purpose,
// so only level 5 can ever march.
// No npctroops line either: level 5 then uses the safe default of 550 ballista
// plus however many transports the loot needs.
distancepolicy 15
npcteams 3

// --- resource sharing between the four cities ----------------------------
// requestresources <donor> <type> <max> <keep> * <batch> /below:<min>
//   pull when this city drops below <min>, top up toward <max>, at most
//   <batch> per run, and never take a donor below <keep>.
// Wood is the binding constraint on this account — every city is sitting on
// billions of food and iron but only tens of thousands of lumber — so the wood
// rule is the one that will actually fire once farming builds a surplus.
requestresources any gold 2000000 200000 * 500000 /below:1000000
requestresources any wood 2000000 200000 * 500000 /below:100000
requestresources any stone 50000000 10000000 * 5000000 /below:5000000
requestresources any iron 500000000 100000000 * 20000000 /below:50000000
requestresources any food 5000000000 1000000000 * 50000000 /below:500000000
traininghero OTTO 30 60
// OTTO is the traininghero: it rotates between towns and must never be out
// on an npc run when it is due to move. Every other hero may still farm.
npcheroes !OTTO,any
// --- per-level NPC ranges -------------------------------------------------
// farmingpolicy <level> /distance:<tiles> overrides distancepolicy for just
// that level, so each level can have its own radius.
// L10 will still not march until an "npclimits 10 ..." line exists — that is
// the deliberate guard on the high levels, not an oversight.
farmingpolicy 10 /distance:5
farmingpolicy 5 /distance:10

`,
  Lord02: `// Lord02 — the same build-up ladder as Lord22, plus NPC level-5 farming.
config comfort:1,hero:1,troopsusepopmax:1,npc:5
comfortpolicy 15 16 popraise
defensepolicy /usetruce:79 /usespeech:2 /junktroop:5000 /usewarhorn:1 /usecorselet:1 /usepenicillin:1
build f:10:37
// build f:10:37,s:0:0,i:0:0,q:0:0
troop b:5k,t:5k
troop wo:10k,w:10k,s:10k,p:10k,sw:10k,a:10k,t:10k,c:10k,cata:10k,b:10k
troop a:100k,s:100k

fortification ab:5000
distancepolicy 15
npcteams 3
requestresources any wood 2000000 200000 * 500000 /below:100000
requestresources any stone 50000000 10000000 * 5000000 /below:5000000
requestresources any iron 500000000 100000000 * 20000000 /below:50000000
requestresources any food 5000000000 1000000000 * 50000000 /below:500000000
farmingpolicy 10 /distance:5
farmingpolicy 5 /distance:10
`,
};

// What each live line should be: comments grey, blanks blank, and every goal line
// blue unless it names something on the NOT_IMPLEMENTED list.
function expected(raw) {
  if (!raw.trim()) return 'blank';
  if (/^\s*(\/\/|#)/.test(raw)) return 'comment';
  const keys = raw.startsWith('config ') ? raw.slice(7).split(',').map((p) => p.split(':')[0]) : [];
  return keys.some((k) => NOT_IMPLEMENTED.config[k]) ? 'idle' : 'ok';
}

for (const [name, src] of Object.entries(LIVE)) {
  t(`${name}: every line comes out as expected, and nothing is an error`, () => {
    const p = parseGoals(src);
    assert.deepStrictEqual(p.errors, []);
    src.split('\n').forEach((raw, i) => assert.strictEqual(p.lines[i].status, expected(raw), `line ${i + 1}: ${raw}`));
  });
}

t('the live config lines are red only for troopsusepopmax, and say the other keys work', () => {
  const works = { lord22: 'comfort and hero', lord02: 'comfort, hero and npc', Lord02: 'comfort, hero and npc' };
  for (const [name, src] of Object.entries(LIVE)) {
    const l = parseGoals(src).lines[1];
    if (!NOT_IMPLEMENTED.config.troopsusepopmax) { assert.strictEqual(l.status, 'ok'); continue; }
    assert.strictEqual(l.status, 'idle');
    assert.strictEqual(l.msg, `troopsusepopmax does nothing yet: ${NOT_IMPLEMENTED.config.troopsusepopmax} (${works[name]} on this line work)`);
  }
});

t('the live goals: every other goal line is blue (the counts)', () => {
  const count = (src) => parseGoals(src).lines.reduce((n, l) => ({ ...n, [l.status]: (n[l.status] || 0) + 1 }), {});
  const idle = NOT_IMPLEMENTED.config.troopsusepopmax ? 1 : 0;
  assert.deepStrictEqual(count(LIVE.lord22), { comment: 2, ...(idle ? { idle } : {}), ok: 8 - idle, blank: 2 });
  assert.deepStrictEqual(count(LIVE.lord02), { comment: 30, ...(idle ? { idle } : {}), ok: 21 - idle, blank: 5 });
});

// ---------------------------------------------------------------------------
section('script lines (the loadout editor)');

t('comment, ok, error and blank lines; # is not a comment in a script', () => {
  const r = S.lineStatus('// farm upgrades\ntrain a 10k\n\nbogus 1\n# note\nupgrade academy // why');
  assert.deepStrictEqual(r.lines.map((l) => l.status), ['comment', 'ok', 'blank', 'error', 'error', 'ok']);
  assert.deepStrictEqual(r.lines[3], { n: 4, status: 'error', msg: 'unknown command: bogus' });
  assert.deepStrictEqual(r.errors, [{ line: 4, error: 'unknown command: bogus' }, { line: 5, error: 'unknown command: #' }]);
});

t('a check never expands a big repeat or loop', () => {
  const t0 = Date.now();
  const r = S.lineStatus('train a 1\nrepeat 100000000\nloop 99999999\ntrain s 1\nendloop');
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
  assert.deepStrictEqual(r.lines.map((l) => l.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.strictEqual(S.parse('train a 1\nrepeat 5', { check: true }).length, 3, 'the check parse reads repeat 5 as 2');
  assert.strictEqual(S.parse('train a 1\nrepeat 5').length, 6, 'a run still gets all 5');
});

t('a check finds exactly the errors a full parse finds', () => {
  const src = ['endloop', 'repeat 3', 'loop 4', 'train zz 1', 'logout now 1:05:00', 'endloop', 'echo %nope%', 'set x 1',
    'echo %x%', 'repeat', 'repeat 2', 'bogus', 'loop 3', 'train a 1'].join('\n');
  const full = new Map();
  for (const a of S.parse(src)) if (a.cmd === 'error') full.set(`${a.line}:${a.error}`, { line: a.line, error: a.error });
  const want = [...full.values()].sort((a, b) => a.line - b.line || a.error.localeCompare(b.error));
  const got = S.lineStatus(src).errors.sort((a, b) => a.line - b.line || a.error.localeCompare(b.error));
  assert.deepStrictEqual(got, want);
  assert.ok(got.some((e) => /nothing can run after logout/.test(e.error)), 'the logout inside a loop of 4 is still caught');
});

// ---------------------------------------------------------------------------
section('the console routes the editor asks (server.js in this process)');

const D = require('./db');
const AUTH = require('./auth');
const reg = AUTH.register({ email: 'lines@example.com', password: 'offline-only-123', orgName: 'Lines' });
const ORG = D.org(reg.org.id);
ORG.settings.set('probes', []);        // server.js asks no other console who it holds
D.settings.set('probes', []);
const acc = ORG.accounts.upsert({ label: 'Lines', email: 'acct@example.com', password: 'x' });
const SID = AUTH.newSession(reg.user.id, reg.org.id, '127.0.0.1', 'test');
class StubSession {
  constructor() {
    this.account = { id: acc.id, label: 'Lines' }; this.org = ORG; this.orgId = reg.org.id;
    this.userPaused = false; this.maint = {}; this.game = null; this.connected = false;
  }
  startSupervisor() {} startEngine() {} note() {}
  async connect() { throw new Error('no game in this test'); }
}
const sessPath = require.resolve('./session');
require.cache[sessPath] = { id: sessPath, filename: sessPath, loaded: true, exports: { Session: StubSession } };
let handler = null;
http.createServer = (h) => { handler = h; return { listen() {}, on() {} }; };
const quiet = console.log;
console.log = () => {};                // server.js's start-up banner
require('./server');
console.log = quiet;

const { Readable } = require('stream');
function call(url, body) {
  return new Promise((resolve) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: 'POST', url, headers: { cookie: `otto_sid=${SID}` }, socket: { remoteAddress: '127.0.0.1' } });
    const res = { writeHead(c) { this.code = c; }, setHeader() {}, end(d) { resolve({ code: this.code, body: JSON.parse(String(d)) }); } };
    handler(req, res);
  });
}
const saved = () => (ORG.goals.own(acc.id, 101, 'North', 'goal') || {}).src;

t('/api/goals check: the statuses only, and never a save — even when told to save', async () => {
  ORG.goals.set(acc.id, '101', 'goal', 'troop a:1k');
  const r = await call('/api/goals', { src: 'config valley:1\nbogus\n// c\ntroop a:1k', city: '101', save: true, check: true });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(r.body.lines.map((l) => l.status), ['idle', 'error', 'comment', 'ok']);
  assert.deepStrictEqual(r.body.errors.map((e) => e.line), [2]);
  assert.strictEqual(r.body.described, undefined, 'a check skips the description');
  assert.strictEqual(saved(), 'troop a:1k', 'the check saved');
});

t('/api/goals Apply returns the statuses with the description, and saves nothing', async () => {
  // spamheroes is blue since Step 18 (it was the report-only line here)
  const r = await call('/api/goals', { src: 'troop a:2k\nspamheroes any\nconfig valley:1', city: '101', save: false });
  assert.deepStrictEqual(r.body.lines.map((l) => l.status), ['ok', 'ok', NOT_IMPLEMENTED.config.valley ? 'idle' : 'ok']);
  assert.ok(Array.isArray(r.body.described) && r.body.described.length);
  assert.strictEqual(r.body.saved, null);
  assert.strictEqual(saved(), 'troop a:1k');
});

t('/api/goals Save returns the statuses and saves, as before', async () => {
  const r = await call('/api/goals', { src: 'troop a:3k\nconfig valley:1', city: '101', save: true });
  assert.deepStrictEqual(r.body.lines.map((l) => l.status), ['ok', 'idle']);
  assert.strictEqual(r.body.saved, '101');
  assert.strictEqual(saved(), 'troop a:3k\nconfig valley:1');
});

t('/api/script parseOnly + lines: the statuses only; nothing runs and nothing is logged', async () => {
  const logged = [];
  console.log = (m) => logged.push(m);
  let r;
  try { r = await call('/api/script', { src: 'train a 1\nrepeat 100000000\nbogus', parseOnly: true, lines: true, city: '101' }); }
  finally { console.log = quiet; }
  assert.deepStrictEqual(r.body.lines.map((l) => l.status), ['ok', 'ok', 'error']);
  assert.deepStrictEqual(r.body.errors, [{ line: 3, error: 'unknown command: bogus' }]);
  assert.strictEqual(r.body.log, undefined);
  assert.deepStrictEqual(logged, []);
});

t('/api/script parseOnly without lines is Apply, unchanged: the log and the errors', async () => {
  const quietLog = console.log;
  console.log = () => {};
  let r;
  try { r = await call('/api/script', { src: 'train a 1\nbogus', parseOnly: true }); }
  finally { console.log = quietLog; }
  assert.ok(Array.isArray(r.body.log) && /parsed 1 action\(s\), 1 error\(s\)/.test(r.body.log[0]), JSON.stringify(r.body.log));
  assert.deepStrictEqual(r.body.errors, [{ line: 2, error: 'unknown command: bogus' }]);
});

// ---------------------------------------------------------------------------

(async () => {
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n + '\n'); continue; }
    try { await f(); console.log('  ok    ' + n); pass++; }
    catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
