'use strict';
// trading-setup.js: the Director's Trading tab — the control file's read/write (a round
// trip keeps every other line, the write is atomic), the holiday / side checks, and the
// Start / Stop sequence with the process runner, the clock and the consoles all mocked.
// Offline: it reads a COPY of scripts/glitch-res-control.txt and never writes the real one,
// never starts a console, never logs in.
//
//   node test-trading-setup.js
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const TS = require('./trading-setup');
const TM = require('./trade-monitor');

const tests = [];
const t = (n, f) => tests.push([n, f]);

// the real control file, as text (read only) — and a small one for the edge cases
const REAL = fs.readFileSync(path.join(__dirname, 'scripts', 'glitch-res-control.txt'), 'utf8');
const SMALL = [
  '// the play', 'res = "wood"', 'price = 1', 'prevRes = "stone"', 'keepGold = 10000000000', 'keepRes = 10000000000',
  'u = player.playerInfo.userName', 'holi = 0', 'if u == "lord04" || u == "Lord08" holi = 1',
  'if holi == 0 && side == "sell" && price < 50 end', 'foodCap = 950000000000', 'play = "auto"',
  'capRes = 400000000000', 'capGold = 40000000000000', 'if res == "food" capRes = 600000000000',
  'if sellfood == 1 && side == "sell" keepRes = 1000000000', 'label done', '',
].join('\r\n');

// ---------------------------------------------------------------- amounts
t('amounts read as the user writes them', () => {
  assert.strictEqual(TS.parseAmount('800b'), 800e9);
  assert.strictEqual(TS.parseAmount('25t'), 25e12);
  assert.strictEqual(TS.parseAmount('10m'), 10e6);
  assert.strictEqual(TS.parseAmount('1.5b'), 1.5e9);
  assert.strictEqual(TS.parseAmount('1,000,000'), 1e6);
  assert.strictEqual(TS.parseAmount(' 950B '), 950e9);
  assert.ok(Number.isNaN(TS.parseAmount('lots')));
  assert.ok(Number.isNaN(TS.parseAmount('')));
  assert.strictEqual(TS.fmtAmount(800e9), '800b');
  assert.strictEqual(TS.priceText(0.01), '0.01');
  assert.strictEqual(TS.priceText('150'), '150');
  assert.throws(() => TS.priceText(151), /0\.001 – 150/);
  assert.throws(() => TS.priceText(0), /0\.001 – 150/);
});

// ---------------------------------------------------------------- the control file
t('the real control file parses to its values', () => {
  const c = TS.parseControl(REAL);
  assert.ok(TS.RES.includes(c.res), 'res ' + c.res);
  assert.ok(Number(c.price) > 0);
  assert.strictEqual(c.foodCap, 950e9);
  assert.ok(c.holi.length >= 1, 'a holi list');
  assert.ok('food' in c.capLines, 'food has its own cap line');
  assert.strictEqual(c.eol, /\r\n/.test(REAL) ? '\r\n' : '\n');
  assert.strictEqual(c.stopped, false);
});

t('a write changes the value lines and NOTHING else, CRLF kept', () => {
  const next = TS.applyControl(REAL, { res: 'iron', price: 3, prevRes: 'wood', keepGold: '12b', keepRes: '11b', capGold: '30t',
    caps: { food: '700b', stone: '5t' } });
  const a = REAL.split(/\r?\n/), b = next.split(/\r?\n/);
  const eol = /\r\n/.test(REAL) ? '\r\n' : '\n';
  assert.strictEqual(next.split(eol).length, next.split(/\r?\n/).length, 'every line ends as the file did');
  const c = TS.parseControl(next);
  assert.deepStrictEqual([c.res, c.price, c.prevRes, c.keepGold, c.keepRes, c.capGold, c.caps.food, c.caps.stone],
    ['iron', 3, 'wood', 12e9, 11e9, 30e12, 700e9, 5e12]);
  assert.strictEqual(c.foodCap, 950e9, 'the hard food cap is untouched');
  assert.deepStrictEqual(c.holi, TS.parseControl(REAL).holi, 'the holi list is untouched');
  // line by line: only the value lines moved
  const changed = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) changed.push(b[i]);
  for (const l of changed) assert.ok(/^(res|price|prevRes|keepGold|keepRes|capGold) = |^if res == "(food|stone)" capRes = /.test(l), 'unexpected change: ' + l);
  assert.ok(changed.length >= 8 && changed.length <= 10, `changed ${changed.length} line(s)`);
  // the lines around the edits are exactly as they were
  for (const keep of ['if holi == 0 && side == "sell" && price < 50 end', 'if holi == 0 && side == "buy" && price >= 50 end', '@call "glitch-skip.txt"',
    'if sellfood == 1 && side == "sell" keepRes = 1000000000', 'if small == 1 keepGold = 10000000']) {
    assert.ok(next.includes(keep), 'kept: ' + keep);
  }
});

t('a resource with no cap line of its own gets one, beside the others', () => {
  const next = TS.applyControl(SMALL, { caps: { wood: '500b', iron: '300b' } });
  const lines = next.split('\r\n');
  const i = lines.indexOf('if res == "food" capRes = 600000000000');
  assert.deepStrictEqual(lines.slice(i, i + 3).sort(), ['if res == "food" capRes = 600000000000', 'if res == "iron" capRes = 300000000000', 'if res == "wood" capRes = 500000000000'].sort());
  const c = TS.parseControl(next);
  assert.deepStrictEqual([c.caps.wood, c.caps.iron, c.caps.food, c.caps.stone], [500e9, 300e9, 600e9, 400e9]);
  // and a second write edits them in place rather than adding more
  const again = TS.applyControl(next, { caps: { wood: '1t' } });
  assert.strictEqual(again.split('\r\n').filter((l) => l.startsWith('if res == "wood"')).length, 1);
});

t('food never past 950b: its cap is refused above it, and a file with a looser foodCap is not written', () => {
  assert.throws(() => TS.applyControl(SMALL, { caps: { food: '951b' } }), /over 950b/);
  assert.doesNotThrow(() => TS.applyControl(SMALL, { caps: { food: '950b' } }));
  const loose = SMALL.replace('foodCap = 950000000000', 'foodCap = 999000000000');
  assert.throws(() => TS.applyControl(loose, { price: 2 }), /foodCap/);
  assert.throws(() => TS.applyControl(SMALL, { res: 'gold' }), /res must be/);
  assert.throws(() => TS.applyControl(SMALL, { keepGold: 'plenty' }), /amount/);
  assert.throws(() => TS.applyControl('res = "wood"\nprice = 1\n', { price: 2 }), /foodCap/);
});

t('the holi list is rewritten as one line, never emptied', () => {
  const next = TS.applyControl(SMALL, { holi: ['lord04', 'Lord05', 'Lord09'] });
  assert.ok(next.includes('if u == "lord04" || u == "Lord05" || u == "Lord09" holi = 1'));
  assert.deepStrictEqual(TS.parseControl(next).holi, ['lord04', 'Lord05', 'Lord09']);
  assert.throws(() => TS.applyControl(SMALL, { holi: [] }), /cannot be emptied/);
  assert.throws(() => TS.applyControl(SMALL, { holi: ['a"b'] }), /quote/);
  assert.strictEqual(next.split('\r\n').length, SMALL.split('\r\n').length);
});

t('stop puts `end` first; restore takes exactly it out again', () => {
  const stopped = TS.applyControl(REAL, { stop: true });
  assert.ok(stopped.startsWith('end' + TS.parseControl(REAL).eol));
  assert.strictEqual(TS.parseControl(stopped).stopped, true);
  assert.strictEqual(TS.applyControl(stopped, { stop: true }), stopped, 'twice is once');
  assert.strictEqual(TS.applyControl(stopped, { stop: false }), REAL, 'the file is back byte for byte');
  // and TradeMonitor's own reader agrees it is stopped
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'scripts', 'glitch-res-control.txt'), stopped);
  assert.strictEqual(TM.readControl(dir).stopped, true);
});

t('the write is atomic: a temp file beside it, then one rename — retried while a reader holds it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-'));
  const file = path.join(dir, 'glitch-res-control.txt');
  fs.writeFileSync(file, SMALL);
  const calls = [];
  let busy = 2;
  const fsx = { ...fs,
    openSync: (p, m) => { calls.push(['open', path.basename(p), m]); return fs.openSync(p, m); },
    writeFileSync: () => { throw new Error('a plain write must never be used'); },
    renameSync: (a, b) => {
      calls.push(['rename', path.basename(a), path.basename(b)]);
      if (busy-- > 0) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      return fs.renameSync(a, b);
    },
  };
  const next = TS.applyControl(SMALL, { price: 2 });
  TS.writeAtomic(file, next, { fsx });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), next);
  assert.ok(calls[0][0] === 'open' && calls[0][1].endsWith('.tmp') && calls[0][1] !== 'glitch-res-control.txt', 'the text goes to a temp file first');
  assert.ok(!calls.some((c) => c[0] === 'open' && c[1] === 'glitch-res-control.txt'), 'the live file is never opened for writing');
  assert.strictEqual(calls.filter((c) => c[0] === 'rename').length, 3, 'retried through two EPERMs');
  assert.deepStrictEqual(fs.readdirSync(dir), ['glitch-res-control.txt'], 'no temp file left behind');
  // a rename that never works: the file stays as it was, the temp goes
  const stuck = { ...fs, renameSync: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } };
  assert.throws(() => TS.writeAtomic(file, 'res = "food"', { fsx: stuck }), /nothing was changed/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), next);
  assert.deepStrictEqual(fs.readdirSync(dir), ['glitch-res-control.txt']);
});

t('a write based on an old read is refused (another session edited it meanwhile)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-'));
  const file = path.join(dir, 'c.txt');
  fs.writeFileSync(file, SMALL);
  const cf = TS.controlFile(file);
  const r = cf.read();
  fs.writeFileSync(file, SMALL.replace('price = 1', 'price = 2'));   // someone else
  assert.throws(() => cf.write(TS.applyControl(r.text, { price: 3 }), r.version), (e) => e.conflict === true);
  assert.ok(fs.readFileSync(file, 'utf8').includes('price = 2'));
});

// ---------------------------------------------------------------- the checks
const acct = (id, o = {}) => ({ id, label: id.toUpperCase(), enabled: true, holiday: false, lord: id.toUpperCase(), connected: true, fresh: true, at: 1, processDown: false, maintenance: false, ...o });

t('a resource play: the SELLING side must be on holiday', () => {
  const accounts = [acct('b1', { holiday: true }), acct('b2', { holiday: false }), acct('o1'), acct('o2')];
  const sides = { b1: 'sell', b2: 'sell', o1: 'buy', o2: 'buy' };
  const c = TS.checkPlay({ sides, accounts, price: 1, forStart: true });
  assert.strictEqual(c.kind, 'res'); assert.strictEqual(c.bankSide, 'sell');
  assert.strictEqual(c.errors.length, 1);
  assert.match(c.errors[0], /B2 is NOT on holiday/);
  const ok = TS.checkPlay({ sides: { b1: 'sell', o1: 'buy' }, accounts, price: 0.01, forStart: true });
  assert.deepStrictEqual(ok.errors, []);
});

t('a gold play: the BUYING side must be on holiday; unknown holiday is refused too', () => {
  const accounts = [acct('b1', { holiday: true }), acct('b2', { holiday: null, connected: false, processDown: true }), acct('o1')];
  const c = TS.checkPlay({ sides: { b1: 'buy', b2: 'buy', o1: 'sell' }, accounts, price: 150, forStart: true });
  assert.strictEqual(c.kind, 'gold'); assert.strictEqual(c.bankSide, 'buy');
  assert.strictEqual(c.errors.length, 1);
  assert.match(c.errors[0], /B2's holiday state is unknown/);
  // the same accounts the other way round at 150: our (non-holiday) account would buy dear
  const wrong = TS.checkPlay({ sides: { o1: 'buy', b1: 'sell' }, accounts, price: 150, forStart: true });
  assert.match(wrong.errors.join(' '), /O1 is NOT on holiday/);
  assert.match(wrong.warnings.join(' '), /B1 is on holiday but on OUR side/);
});

t('the price decides the side at exactly 50', () => {
  const accounts = [acct('b1', { holiday: true }), acct('o1')];
  assert.strictEqual(TS.checkPlay({ sides: {}, accounts, price: 49.9 }).bankSide, 'sell');
  assert.strictEqual(TS.checkPlay({ sides: {}, accounts, price: 50 }).bankSide, 'buy');
});

t('the holi list must name every bank; a listed lord not on holiday is flagged', () => {
  const accounts = [acct('b1', { holiday: true, lord: 'lord04' }), acct('b2', { holiday: true, lord: 'Lord08' }), acct('o1', { lord: 'Lord09' })];
  const control = { holi: ['lord04', 'Lord09'] };
  const c = TS.checkPlay({ sides: { b1: 'sell', b2: 'sell', o1: 'buy' }, accounts, price: 1, control, forStart: true });
  assert.match(c.errors.join('\n'), /B2 \(in-game "Lord08"\) is not in the control file's holi list/);
  assert.match(c.warnings.join('\n'), /"Lord09" \(O1\), which is NOT on holiday/);
});

t('switched off, in maintenance, or not logged in: refused for a start', () => {
  const accounts = [acct('b1', { holiday: true }), acct('o1', { enabled: false }), acct('o2', { maintenance: true, connected: false }),
    acct('o3', { connected: false, reason: 'rate limited' }), acct('o4', { connected: false, processDown: true })];
  const c = TS.checkPlay({ sides: { b1: 'sell', o1: 'buy', o2: 'buy', o3: 'buy', o4: 'buy' }, accounts, price: 1, forStart: true });
  const e = c.errors.join('\n');
  assert.match(e, /O1 is switched off/);
  assert.match(e, /O2 is in server maintenance/);
  assert.match(e, /O3 is not logged in \(rate limited\)/);
  assert.ok(!/O4/.test(e), 'a console that is simply not running can be started');
  assert.match(TS.checkPlay({ sides: { b1: 'sell' }, accounts, price: 1, forStart: true }).errors.join(), /nobody is buying/);
});

// ---------------------------------------------------------------- the sequence
// A world: the org's settings, a control file in a temp dir, a runner that records what
// it would have run, the consoles' headers, a monitor of fake events and a fake clock.
function world({ text = SMALL, accounts, sides, play = {}, opts = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-'));
  const file = path.join(dir, 'glitch-res-control.txt');
  fs.writeFileSync(file, text);
  const kv = new Map();
  const store = { get: (k, d) => (kv.has(k) ? JSON.parse(kv.get(k)) : d), set: (k, v) => kv.set(k, JSON.stringify(v)) };
  let clock = new Date(2026, 8, 22, 10, 0, 0).getTime();
  const execs = [];
  const exec = async (args) => {
    execs.push({ at: clock, args });
    if (args[0] === 'start') {
      const id = args[2];
      // the console starts its autorun: the gate is recorded
      const g = store.get('autorunLastStart', {}); g[id] = clock; store.set('autorunLastStart', g);
      return { ok: true, out: `10:00:00 ${id.toUpperCase().padEnd(12)} ${args[4]}  console up, pid 4242\n` };
    }
    return { ok: true, out: 'ok' };
  };
  const accs = accounts || [acct('b1', { holiday: true, lord: 'lord04' }), acct('b2', { holiday: true, lord: 'Lord08' }), acct('o1'), acct('o2')];
  const events = new Map();
  const lines = new Map();
  const R = new TS.Runner({
    store, control: TS.controlFile(file), exec, accounts: () => accs,
    monitor: { events: (id) => events.get(id) || [] }, lastLineAt: (id) => lines.get(id) || 0, now: () => clock,
  });
  R.saveSetup({ sides: sides || { b1: 'sell', b2: 'sell', o1: 'buy', o2: 'buy' }, play: { res: 'wood', price: 1, ...play }, ...opts });
  return { R, store, file, execs, accs, events, lines, advance: (ms) => { clock += ms; }, now: () => clock, read: () => fs.readFileSync(file, 'utf8') };
}
const starts = (w) => w.execs.filter((e) => e.args[0] === 'start').map((e) => `${e.args[1]} ${e.args[2]} ${e.args[4]}`);

t('Start: one control-file write, a "before" snapshot, the buyers, then the sellers after the delay', async () => {
  const w = world({ text: 'end\r\n' + SMALL, play: { res: 'stone', price: 2, caps: { stone: '500b' } }, opts: { delaySec: 60 } });
  w.R.start();
  const c = TS.parseControl(w.read());
  assert.deepStrictEqual([c.res, c.price, c.prevRes, c.stopped, c.caps.stone], ['stone', 2, 'wood', false, 500e9], 'the play, prevRes auto, and the `end` out — together');
  await w.R.tick();
  assert.deepStrictEqual(w.execs[0].args, ['snap', 'before', '--reset'], 'the snapshot comes first');
  assert.deepStrictEqual(starts(w), ['--buy o1 glitch-res-buy.txt', '--buy o2 glitch-res-buy.txt'], 'the buyers only');
  assert.strictEqual(w.R.run().phase, 'delay');
  w.advance(30000); await w.R.tick();
  assert.strictEqual(starts(w).length, 2, 'no seller inside the head start');
  w.advance(31000); await w.R.tick();
  assert.deepStrictEqual(starts(w).slice(2), ['--sell b1 glitch-res-sell.txt', '--sell b2 glitch-res-sell.txt']);
  const sellAt = w.execs.find((e) => e.args[2] === 'b1').at, buyAt = w.execs.find((e) => e.args[2] === 'o2').at;
  assert.ok(sellAt - buyAt >= 60000, 'the sellers start a full minute after the last buyer');
  assert.strictEqual(w.R.run().state, 'running');
});

t('Start with "clean before" runs the clean-then scripts', async () => {
  const w = world({ opts: { cleanBefore: true, delaySec: 0 } });
  w.R.start();
  await w.R.tick(); await w.R.tick();
  assert.deepStrictEqual(starts(w), ['--buy o1 clean-then-buy.txt', '--buy o2 clean-then-buy.txt', '--sell b1 clean-then-sell.txt', '--sell b2 clean-then-sell.txt']);
});

t('Start is refused, and nothing written, when a bank is not on holiday', () => {
  const w = world({ accounts: [acct('b1', { holiday: true, lord: 'lord04' }), acct('b2', { holiday: false, lord: 'Lord08' }), acct('o1'), acct('o2')] });
  const before = w.read();
  assert.throws(() => w.R.start(), /B2 is NOT on holiday/);
  assert.strictEqual(w.read(), before);
  assert.strictEqual(w.R.run(), null);
  assert.strictEqual(w.execs.length, 0);
});

t('Start is refused when a bank is missing from the holi list', () => {
  const w = world({ accounts: [acct('b1', { holiday: true, lord: 'lord04' }), acct('b2', { holiday: true, lord: 'Lord05' }), acct('o1'), acct('o2')] });
  assert.throws(() => w.R.start(), /Lord05.*holi list/);
});

t('an account inside its restart gate waits for it (and says so) instead of starting to nothing', async () => {
  const w = world({ opts: { delaySec: 0 } });
  w.store.set('autorunLastStart', { o2: w.now() - 4 * 60000 });            // restarted 4 min ago
  w.R.start();
  await w.R.tick();
  assert.deepStrictEqual(starts(w), ['--buy o1 glitch-res-buy.txt']);
  assert.ok(w.R.run().events.some((e) => /O2 waits for its restart gate/.test(e.m)));
  w.advance(5 * 60000); await w.R.tick();
  assert.strictEqual(starts(w).length, 1, 'still inside 10 min + the pad');
  w.advance(90000); await w.R.tick();
  assert.deepStrictEqual(starts(w).slice(1, 2), ['--buy o2 glitch-res-buy.txt']);
});

t('the restart gate is the setup one: 0 starts at once and lifts the console 10-minute guard', async () => {
  const w = world({ opts: { delaySec: 0, gateMin: 0 } });
  w.store.set('autorunLastStart', { o2: w.now() - 60000 });                // restarted 1 min ago
  w.R.start();
  await w.R.tick();
  assert.deepStrictEqual(starts(w).slice(0, 2), ['--buy o1 glitch-res-buy.txt', '--buy o2 glitch-res-buy.txt'], 'no wait');
  const at = w.execs.find((e) => e.args[2] === 'o2').at;
  assert.ok(w.R.run().events.some((e) => /O2: its console restarted under 10 minutes ago/.test(e.m)));
  assert.strictEqual(w.R.gateUntil('o2'), at, 'the start itself is the new last start');
});

t('a 3-minute restart gate waits 3 minutes, not 10', async () => {
  const w = world({ opts: { delaySec: 0, gateMin: 3 } });
  w.store.set('autorunLastStart', { o2: w.now() - 60000 });
  w.R.start();
  await w.R.tick();
  assert.deepStrictEqual(starts(w), ['--buy o1 glitch-res-buy.txt']);
  w.advance(119000); await w.R.tick();
  assert.strictEqual(starts(w).length, 1);
  w.advance(2000); await w.R.tick();
  assert.deepStrictEqual(starts(w).slice(1, 2), ['--buy o2 glitch-res-buy.txt']);
  assert.strictEqual(TS.cleanSetup({ gateMin: -5 }).gateMin, 0);
  assert.strictEqual(TS.cleanSetup({}).gateMin, 10);
});

t('the sellers are not started if a bank has left holiday during the head start — the play stops instead', async () => {
  const w = world({ opts: { delaySec: 60 } });
  w.R.start();
  await w.R.tick();
  w.accs[1].holiday = false;                                               // b2 out of holiday
  w.advance(61000); await w.R.tick();
  assert.ok(!starts(w).some((s) => s.startsWith('--sell')), 'no seller started');
  assert.strictEqual(w.R.run().state, 'stopping');
  await w.R.tick();
  assert.strictEqual(TS.parseControl(w.read()).stopped, true, '`end` is in');
});

t('Stop: `end` first, the runs drain, `end` out again, then each account cleans its reports', async () => {
  const w = world({ opts: { delaySec: 0, cleanAfter: true } });
  w.R.start();
  await w.R.tick(); await w.R.tick();
  assert.strictEqual(w.R.run().state, 'running');
  const played = w.read();
  w.R.requestStop();
  await w.R.tick();
  assert.strictEqual(TS.parseControl(w.read()).stopped, true, '`end` written');
  // a city is still finishing its batch
  for (const id of ['b1', 'b2', 'o1', 'o2']) w.lines.set(id, w.now() - 60000);
  w.lines.set('o1', w.now() + 10000);
  w.advance(20000); await w.R.tick();
  assert.strictEqual(TS.parseControl(w.read()).stopped, true, 'o1 still logging: `end` stays');
  w.advance(20000); await w.R.tick();
  assert.strictEqual(w.read(), played, 'every log quiet: the file is exactly as it was');
  // clean after: the gate from the start is still closed, so it waits for it
  assert.strictEqual(w.R.run().state, 'stopping');
  assert.ok(!starts(w).some((s) => s.includes('clean-reports')), 'not inside the gate');
  w.advance(10 * 60000); await w.R.tick();
  assert.deepStrictEqual(starts(w).filter((s) => s.includes('clean-reports')).map((s) => s.split(' ')[1]).sort(), ['b1', 'b2', 'o1', 'o2']);
  assert.strictEqual(w.R.run().state, 'stopped');
});

t('Stop leaves `end` in when the runs will not go quiet', async () => {
  const w = world({ opts: { delaySec: 0 } });
  w.R.start(); await w.R.tick(); await w.R.tick();
  w.R.requestStop(); await w.R.tick();
  for (let i = 0; i < 20; i++) { w.lines.set('o1', w.now()); w.advance(10000); await w.R.tick(); }
  assert.strictEqual(TS.parseControl(w.read()).stopped, true);
  assert.strictEqual(w.R.run().state, 'stopped');
  assert.ok(w.R.run().events.some((e) => /STAYS in the control file/.test(e.m)));
});

t('Stop found the file already stopped by hand: it is left stopped', async () => {
  const w = world({ text: 'end\r\n' + SMALL });
  w.R.requestStop({ clean: false });
  await w.R.tick(); w.advance(30000); await w.R.tick();
  assert.strictEqual(TS.parseControl(w.read()).stopped, true);
  assert.strictEqual(w.R.run().state, 'stopped');
});

t('a Stop pressed while a start is in flight is held, then applied — the start goes no further', async () => {
  const w = world({ opts: { delaySec: 0 } });
  w.R.start();
  let release;
  const gate = new Promise((r) => { release = r; });
  const orig = w.R.exec;
  w.R.exec = async (args) => { if (args[0] === 'start' && args[2] === 'o1') await gate; return orig(args); };
  const p = w.R.tick();
  await new Promise((r) => setImmediate(r));
  const mid = w.R.requestStop({ clean: false });
  assert.strictEqual(mid.stopPending, true);
  release(); await p;
  assert.strictEqual(w.R.run().state, 'stopping', 'the stop was not written over by the tick');
  assert.deepStrictEqual(starts(w), ['--buy o1 glitch-res-buy.txt'], 'o2 and the sellers never started');
});

t('the watchdog: scriptless consoles go back on their script; sitting out, run dry, offline and gated ones are left alone', async () => {
  const w = world({ opts: { delaySec: 0, watchdog: true } });
  w.R.start(); await w.R.tick(); await w.R.tick();
  const t0 = w.now();
  w.advance(20 * 60000);
  const T = (m) => t0 + m * 60000;
  // o1: a console restarted plainly at +8 with no order since -> put back
  w.events.set('o1', [{ kind: 'order', t: T(5), placed: 10 }, { kind: 'conn', t: T(8), text: 'session supervisor started' }]);
  // o2: sat out on a cap after its last order -> left alone
  w.events.set('o2', [{ kind: 'order', t: T(1), placed: 3 }, { kind: 'sitout', t: T(2), out: true }]);
  // b1: FRESHSTART and nothing after it -> out of the resource
  w.events.set('b1', [{ kind: 'order', t: T(1), placed: 3 }, { kind: 'fresh', t: T(3) }]);
  // b2: quiet, but its console is not logged in -> never restarted into a rate limit
  w.accs[1].connected = false; w.accs[1].reason = 'rate limited';
  w.events.set('b2', [{ kind: 'order', t: T(1), placed: 3 }]);
  await w.R.tick();
  const wd = starts(w).slice(4);
  assert.deepStrictEqual(wd, ['--buy o1 glitch-res-buy.txt'], 'only o1, on the PLAIN script');
  const ev = w.R.run().events.map((e) => e.m).join('\n');
  assert.match(ev, /O2 is sitting out/); assert.match(ev, /B1 started and ended on its first loop/); assert.match(ev, /B2 is quiet but not logged in/);
  // two minutes on, o1 is inside the gate its restart set: not again
  w.advance(2 * 60000); await w.R.tick();
  assert.strictEqual(starts(w).length, 5);
});

t('a bank that leaves holiday mid-play stops it (two readings)', async () => {
  const w = world({ opts: { delaySec: 0 } });
  w.R.start(); await w.R.tick(); await w.R.tick();
  w.accs[0].holiday = false; w.accs[0].at = 100;
  await w.R.tick();
  assert.strictEqual(w.R.run().state, 'running', 'one odd reading is not enough');
  w.accs[0].at = 200;
  await w.R.tick();
  assert.strictEqual(w.R.run().state, 'stopping');
  assert.ok(w.R.run().events.some((e) => /NO LONGER ON HOLIDAY/.test(e.m)));
});

t('the price ladder: over 80% steps cheaper in a resource play, never judged on a broken fleet', async () => {
  const accounts = ['b1', 'b2', 'b3'].map((id, i) => acct(id, { holiday: true, lord: ['lord04', 'Lord08', 'x3'][i] }))
    .concat(['o1', 'o2', 'o3', 'o4', 'o5'].map((id) => acct(id)));
  const sides = { b1: 'sell', b2: 'sell', b3: 'sell', o1: 'buy', o2: 'buy', o3: 'buy', o4: 'buy', o5: 'buy' };
  const w = world({ accounts, sides, text: SMALL.replace('u == "Lord08"', 'u == "Lord08" || u == "x3"'), play: { price: 1 }, opts: { delaySec: 0, ladder: true, watchdog: false } });
  w.R.start(); await w.R.tick(); await w.R.tick();
  assert.strictEqual(w.R.run().state, 'running');
  const t0 = w.now();
  const fill = (ids, n) => { for (const id of ids) w.events.set(id, [...(w.events.get(id) || []), { kind: 'order', t: t0 + 5 * 60000, placed: n }]); };
  fill(['b1', 'b2', 'b3'], 100); fill(['o1', 'o2', 'o3', 'o4'], 90);        // o5 dead: 4 of 5
  w.advance(10 * 60000 + 1000); await w.R.tick();
  assert.strictEqual(TS.parseControl(w.read()).price, 1, 'a dead buyer: not judged');
  assert.ok(w.R.run().events.some((e) => /not judged/.test(e.m)));
  fill(['o5'], 1);
  w.events.forEach((list) => list.forEach((e) => { e.t = w.now() - 60000; }));
  w.advance(10 * 60000 + 1000);
  w.events.forEach((list) => list.forEach((e) => { e.t = w.now() - 60000; }));
  await w.R.tick();
  assert.strictEqual(TS.parseControl(w.read()).price, 0.5, '361 of 300 = 120%: one rung cheaper');
});

t('the gold ladder walks down from 150 when rivals take the bid', async () => {
  const accounts = [acct('b1', { holiday: true, lord: 'lord04' }), acct('o1')];
  const w = world({ accounts, sides: { b1: 'buy', o1: 'sell' }, text: SMALL.replace('u == "lord04" || u == "Lord08"', 'u == "lord04"'), play: { price: 150 }, opts: { delaySec: 0, ladder: true, watchdog: false } });
  w.R.start(); await w.R.tick(); await w.R.tick();
  w.advance(10 * 60000 + 1000);
  w.events.set('b1', [{ kind: 'order', t: w.now() - 60000, placed: 100 }]);
  w.events.set('o1', [{ kind: 'order', t: w.now() - 60000, placed: 30 }]);
  await w.R.tick();
  assert.strictEqual(TS.parseControl(w.read()).price, 140);
});

t('a price set by hand is left alone by the ladder, and a resource switch is followed, not stood down', async () => {
  const accounts = [acct('b1', { holiday: true, lord: 'lord04' }), acct('o1')];
  const w = world({ accounts, sides: { b1: 'sell', o1: 'buy' }, text: SMALL.replace('u == "lord04" || u == "Lord08"', 'u == "lord04"'), play: { price: 1 }, opts: { delaySec: 0, ladder: true, watchdog: false } });
  w.R.start(); await w.R.tick(); await w.R.tick();
  w.R.applyLive({ price: 1.5 });
  w.advance(10 * 60000 + 1000);
  w.events.set('b1', [{ kind: 'order', t: w.now() - 60000, placed: 100 }]);
  w.events.set('o1', [{ kind: 'order', t: w.now() - 60000, placed: 99 }]);
  await w.R.tick();
  assert.strictEqual(TS.parseControl(w.read()).price, 1.5);
  w.R.applyLive({ res: 'iron', prevRes: 'wood' });
  w.advance(10 * 60000 + 1000); await w.R.tick();
  assert.strictEqual(w.R.run().res, 'iron', 'the ladder takes the new resource on');
  assert.ok(w.R.run().events.some((e) => /the play is iron now \(was wood\) — judging it from here/.test(e.m)));
  // and judges it at the next reading: price 1.5 is not a rung, so still left alone — set a rung
  w.R.applyLive({ price: 1 });
  w.advance(10 * 60000 + 1000);
  w.events.set('b1', [{ kind: 'order', t: w.now() - 60000, placed: 100 }]);
  w.events.set('o1', [{ kind: 'order', t: w.now() - 60000, placed: 99 }]);
  await w.R.tick();
  assert.strictEqual(TS.parseControl(w.read()).price, 0.5, 'iron judged: 99% -> one rung cheaper');
});

t('the user own ladder: rungs, shares and interval from the setup, on/off live', async () => {
  const accounts = [acct('b1', { holiday: true, lord: 'lord04' }), acct('o1')];
  const w = world({ accounts, sides: { b1: 'sell', o1: 'buy' }, text: SMALL.replace('u == "lord04" || u == "Lord08"', 'u == "lord04"'), play: { price: 0.005 },
    opts: { delaySec: 0, ladder: false, watchdog: false, ladderCfg: { res: '0.001 0.005 0.02', high: 90, low: 40, everyMin: 5 } } });
  w.R.start(); await w.R.tick(); await w.R.tick();
  const judge = async (ours) => {
    w.advance(5 * 60000 + 1000);
    w.events.set('b1', [{ kind: 'order', t: w.now() - 60000, placed: 100 }]);
    w.events.set('o1', [{ kind: 'order', t: w.now() - 60000, placed: ours }]);
    await w.R.tick();
    return TS.parseControl(w.read()).price;
  };
  assert.strictEqual(await judge(10), 0.005, 'the ladder is off: nothing moves');
  w.R.saveSetup({ ladder: true });
  await w.R.tick();
  assert.ok(w.R.run().events.some((e) => /the price ladder is ON/.test(e.m)), 'switched on live, no restart');
  assert.strictEqual(await judge(85), 0.005, '85% is between 40 and 90: holding');
  assert.strictEqual(await judge(30), 0.02, 'under 40%: one rung dearer');
  assert.strictEqual(await judge(95), 0.005, 'over 90%: one rung cheaper');
  assert.strictEqual(await judge(95), 0.001, 'and again');
  assert.strictEqual(await judge(95), 0.001, 'the cheap end: never past it');
  assert.ok(w.R.run().events.some((e) => /end of the ladder/.test(e.m)));
  w.R.saveSetup({ ladder: false });
  await w.R.tick();
  assert.ok(w.R.run().events.some((e) => /the price ladder is off/.test(e.m)));
  assert.throws(() => w.R.saveSetup({ ladderCfg: { res: '0.001', high: 80, low: 60 } }), /at least two rungs/);
});

t('the setup persists (sides, play, boxes) and a Director restart mid-start is not resumed blindly', async () => {
  const w = world({ opts: { delaySec: 90, cleanAfter: true } });
  const s = w.R.setup();
  assert.deepStrictEqual(s.sides, { b1: 'sell', b2: 'sell', o1: 'buy', o2: 'buy' });
  assert.strictEqual(s.cleanAfter, true); assert.strictEqual(s.delaySec, 90);
  w.R.saveSetup({ play: { caps: { iron: '2t' } } });
  assert.strictEqual(w.R.setup().play.caps.iron, 2e12);
  assert.strictEqual(w.R.setup().play.caps.food, 600e9, 'the rest of the caps kept (seeded from the control file on the first save)');
  // a setup never saved starts from what the control file has now
  const fresh = new TS.Runner({ store: { get: (k, d) => d, set: () => {} }, control: w.R.control, exec: async () => ({}), accounts: () => [], monitor: { events: () => [] }, lastLineAt: () => 0 });
  const seed = fresh.setup().play;
  assert.deepStrictEqual([seed.res, seed.price, seed.caps.food, seed.caps.wood, seed.capGold], ['wood', 1, 600e9, 400e9, 40e12]);
  assert.throws(() => w.R.saveSetup({ play: { caps: { food: '1t' } } }), /950b/);
  w.R.start(); await w.R.tick();
  const R2 = new TS.Runner({ store: w.store, control: w.R.control, exec: w.R.exec, accounts: () => w.accs, monitor: w.R.monitor, lastLineAt: () => 0, now: w.now });
  R2.resume();
  assert.strictEqual(R2.run().state, 'interrupted');
  await R2.tick();
  assert.ok(!starts(w).some((x) => x.startsWith('--sell')));
});

t('partial live changes touch only what was sent', () => {
  const c = TS.parseControl(SMALL);
  assert.deepStrictEqual(TS.partialChange({ price: '3' }, c), { price: 3 });
  assert.deepStrictEqual(TS.partialChange({ res: 'iron' }, c), { res: 'iron', prevRes: 'wood' });
  assert.deepStrictEqual(TS.partialChange({ res: 'wood', prevRes: 'auto' }, c), { res: 'wood' });
  assert.deepStrictEqual(TS.partialChange({ caps: { food: '700b', wood: '' } }, c), { caps: { food: '700b' } });
});

// ---------------------------------------------------------------- the logs
t('report cleaning is read off the logs (autorun and Script-tab runs) and reported per account', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'scripts', 'glitch-res-control.txt'), SMALL);
  const hms = (d) => d.toTimeString().slice(0, 8);
  const now = Date.now();
  const at = (m) => new Date(now - m * 60000);
  fs.writeFileSync(path.join(dir, 'console-a4.log'), [
    `[autorun New city] ${hms(at(20))}.100 line 13: echo "CLEANREPORTS start" · CLEANREPORTS start`,
    `[autorun New city] ${hms(at(17))}.100 line 15: echo "CLEANREPORTS done — removed " + $result · CLEANREPORTS done — removed 23718`,
    `[autorun 2] ${hms(at(16))}.100 line 18: buy wood 99999999 1 x10 · 10 × buy 99,999,999 wood @ 1 from 2 · … — 10 of 10 placed`,
    `[script] ${hms(at(5))}.100 line 3: echo "x" · CLEANREPORTS start`,
    `[autorun 3] ${hms(at(4))}.100 line 30: sleep 0.3`,
    `[autorun 3] ${hms(at(3))}.100 line 9: goto top`, '',
  ].join('\n'));
  const mon = new TM.Monitor({ dir });
  const r = TM.report(mon, [{ id: 'a4', label: 'Lord04', holiday: false }], { minutes: 60, dir });
  const row = r.accounts[0];
  assert.strictEqual(row.cleanedInWindow, 23718);
  assert.strictEqual(row.clean.running, true, 'a second clean is going');
  assert.deepStrictEqual([r.cleaned.removed, r.cleaned.runs, r.cleaned.running], [23718, 1, ['a4']]);
  // and the drain check sees the last script line
  const last = TS.lastScriptLineAt(dir, 'a4', now);
  assert.ok(Math.abs(last - at(4).getTime()) < 2000, 'the last glitch-loop line (the wait on a full city), not an echo or a goto');
  assert.strictEqual(TS.lastScriptLineAt(dir, 'nobody', now), 0);
});

(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log('  ok    ' + n); pass++; } catch (e) { console.log('  FAIL  ' + n + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 8).join('\n        ')); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
