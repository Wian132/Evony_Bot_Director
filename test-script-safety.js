'use strict';
// The VM's safety rails, offline (the 2026-09-14 safety review, item 6 and the
// VM half of item 9). The Game is real; its network calls are stubbed, and a
// small test-only command module (passed as parse's `modules`) plays a line
// the server refuses, one that fails without sending, and one that waits.
//   - a line the server refuses, reached again by goto / loop / repeat, waits
//     repeatGapMs before it goes out again, and 10 refusals in a row end the run
//   - lines that go through are never slowed
//   - env.game / env.castle / ctx.game follow the session's reconnect on every read
const assert = require('assert');
const C = require('./constants');
const { Game } = require('./game');
const script = require('./script');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const F = (x, y) => C.coordsToFieldId(x, y);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// City 9 and Fla; train goes through game.produceTroop (troop.produceTroop).
function world({ trainReplies = null, userName = 'Lord02' } = {}) {
  const g = new Game();
  g.player = { playerInfo: { userName } };
  g.castles = [
    { id: 1, name: '9', fieldId: F(571, 648), heros: [{ id: 11, name: 'Ken', status: 0, level: 50 }] },
    { id: 2, name: 'Fla', fieldId: F(484, 619), heros: [] },
  ];
  const sent = [];
  let n = 0;
  g.produceTroop = async (castleId, type, amount) => {
    sent.push({ cmd: 'troop.produceTroop', castleId, type, amount, at: Date.now() });
    const r = typeof trainReplies === 'function' ? trainReplies(n++) : trainReplies ? trainReplies[n++] : null;
    return r || { ok: 1 };
  };
  return { g, sent };
}
const REFUSE = { ok: -5, errorMsg: 'not enough resources' };

// poke: say() a refusal (sent and refused) | local: fail without sending |
// flagged: fail with refused: true | wait: read env.game, wait, read it again
const calls = [];
const MOD = {
  commands: {
    poke: {
      usage: 'poke <ok|no>', parse: (args) => ({ cmd: 'poke', how: String(args).trim() }),
      async run(a, env) {
        calls.push({ how: a.how, at: Date.now() });
        env.log('  -> ' + env.say(a.how === 'ok' ? { ok: 1 } : REFUSE));
        return { done: 1 };
      },
    },
    local: { usage: 'local', parse: () => ({ cmd: 'local' }), async run(a, env) { calls.push({ how: 'local', at: Date.now() }); env.log('  not sent'); return { ok: false, error: 'not sent' }; } },
    flagged: { usage: 'flagged', parse: () => ({ cmd: 'flagged' }), async run(a, env) { calls.push({ how: 'flagged', at: Date.now() }); return { ok: false, error: 'over the limit', refused: true }; } },
    wait: {
      usage: 'wait', parse: () => ({ cmd: 'wait' }),
      async run(a, env) {
        const before = env.game, cBefore = env.castle, ctxBefore = env.ctx.game;
        await env.pause(80);
        return { ok: true, result: [env.game === before ? 'same' : 'new', env.castle === cBefore ? 'same' : 'new', env.ctx.game === ctxBefore ? 'same' : 'new'].join(',') };
      },
    },
  },
};

async function runIn(w, src, opts = {}) {
  const out = [], seen = [];
  const globals = { see: (e, r) => { seen.push([e, r]); } };
  const acts = script.parse(src, { modules: [MOD], globals });
  const bad = acts.filter((a) => a.cmd === 'error');
  if (bad.length) throw new Error('parse: ' + bad.map((b) => `line ${b.line}: ${b.error}`).join('; '));
  const started = Date.now();
  let stop = false;
  const timer = opts.stopAfterMs ? setTimeout(() => { stop = true; }, opts.stopAfterMs) : null;
  let done;
  try {
    done = await script.run(w.g, acts, (m) => out.push(m), { castle: '9', repeatGapMs: 0, globals, shouldStop: () => stop, ...opts });
  } finally { if (timer) clearTimeout(timer); }
  return { done, out, text: out.join('\n'), seen, ms: Date.now() - started };
}
const trains = (w) => w.sent.filter((s) => s.cmd === 'troop.produceTroop');

// ---------------------------------------------------------------------------
section('a line the server refuses, run again and again');

t('label a / train a 1 / goto a against a refusing server: 10 refusals, paced, then the run stops', async () => {
  const w = world({ trainReplies: () => REFUSE });
  const r = await runIn(w, 'label a\ntrain a 1\ngoto a\necho "never"', { repeatGapMs: 40 });
  assert.strictEqual(trains(w).length, 10, r.text.slice(-400));
  assert.match(r.text, /line 2 was refused 10 times in a row — stopped$/);
  assert.doesNotMatch(r.text, /never/);
  const at = trains(w).map((s) => s.at);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 35, `send ${i + 1} came ${at[i] - at[i - 1]} ms after the one before`);
  assert.strictEqual(r.done, 10, 'each refusal counts as sent');
});

t('the same through loop and repeat N; a bare repeat still ends at the first refusal', async () => {
  for (const src of ['train a 1\nloop', 'train a 1\nrepeat 50', 'label top\ntrain a 1\nloop 100 top']) {
    const w = world({ trainReplies: () => REFUSE });
    const r = await runIn(w, src);
    assert.strictEqual(trains(w).length, 10, src);
    assert.match(r.text, /was refused 10 times in a row — stopped/, src);
  }
  const w = world({ trainReplies: () => REFUSE });
  const r = await runIn(w, 'train a 1\nrepeat');
  assert.strictEqual(trains(w).length, 1);
  assert.match(r.text, /repeat ends — line 1 did not go through/);
});

t('the pace is opts.repeatGapMs, 200 ms when not given', async () => {
  const w = world({ trainReplies: () => REFUSE });
  const r = await runIn(w, 'label a\ntrain a 1\ngoto a', { repeatGapMs: undefined, stopAfterMs: 1100 });
  const n = trains(w).length;
  assert.ok(n >= 4 && n <= 7, `${n} refused sends in about 1.1 s at 200 ms apart`);
  assert.match(r.text, /stopped — the rest of the script was not run/, 'Stop cut the wait short');
});

t('lines that go through are never slowed, however often they run', async () => {
  const w = world();
  const r = await runIn(w, 'i = 0\nlabel a\ntrain a 1\ni++\nif i < 40 goto a', { repeatGapMs: 200 });
  assert.strictEqual(trains(w).length, 40);
  assert.ok(r.ms < 3000, `40 good lines took ${r.ms} ms`);
  assert.doesNotMatch(r.text, /refused 10 times/);
});

t('a line that goes through starts its count over', async () => {
  // 9 refusals, 1 that goes, 9 refusals, 1 that goes ...: never 10 in a row
  const w = world({ trainReplies: (i) => ((i + 1) % 10 === 0 ? { ok: 1 } : REFUSE) });
  const r = await runIn(w, 'i = 0\nlabel a\ntrain a 1\ni++\nif i < 35 goto a');
  assert.strictEqual(trains(w).length, 35);
  assert.doesNotMatch(r.text, /refused 10 times/);
});

t('two refused lines taking turns are each counted: neither can flood', async () => {
  calls.length = 0;
  const w = world({ trainReplies: () => REFUSE });
  const r = await runIn(w, 'label a\ntrain a 1\npoke no\ngoto a', { repeatGapMs: 20 });
  assert.strictEqual(trains(w).length, 10);
  assert.strictEqual(calls.filter((c) => c.how === 'no').length, 9, 'the run ended on the train line\'s tenth');
  assert.match(r.text, /line 2 was refused 10 times in a row — stopped/);
  assert.ok(r.ms >= 18 * 20 - 20, `both were paced (${r.ms} ms)`);
});

t('a line that fails without sending is paced but never ends the run; refused: true counts as a refusal', async () => {
  calls.length = 0;
  const w = world();
  const r = await runIn(w, 'i = 0\nlabel a\nlocal\ni++\nif i < 20 goto a\necho "done"', { repeatGapMs: 15 });
  assert.strictEqual(calls.length, 20);
  assert.match(r.text, /done/);
  assert.ok(r.ms >= 19 * 15 - 15, `paced: ${r.ms} ms`);
  calls.length = 0;
  const r2 = await runIn(w, 'label a\nflagged\ngoto a');
  assert.strictEqual(calls.length, 10);
  assert.match(r2.text, /line 2 was refused 10 times in a row — stopped/);
});

t('the same line inside a called script or an execute counts by its own text', async () => {
  const w = world({ trainReplies: () => REFUSE });
  const r = await runIn(w, 'label a\nexecute "train a 1"\ngoto a');
  assert.strictEqual(trains(w).length, 10);
  assert.match(r.text, /line 2 was refused 10 times in a row — stopped/);
  // a line whose text changes each time is not the same line: its own refusals are paced, not stopped
  calls.length = 0;
  const v = world();
  const r2 = await runIn(v, 'i = 0\nlabel a\nexecute "poke no " + i\ni++\nif i < 15 goto a\necho "end"');
  assert.strictEqual(calls.length, 15);
  assert.match(r2.text, /end/);
});

t('a dry run sends nothing, so nothing is refused or paced', async () => {
  const w = world({ trainReplies: () => REFUSE });
  const r = await runIn(w, 'i = 0\nlabel a\ntrain a 1\ni++\nif i < 30 goto a', { dryRun: true, repeatGapMs: 200 });
  assert.strictEqual(trains(w).length, 0);
  assert.ok(r.ms < 3000);
  assert.doesNotMatch(r.text, /refused 10 times/);
});

// ---------------------------------------------------------------------------
section('reconnects: env.game and ctx.game follow the session on every read');

t('a command that waits reads the new Game after a reconnect (same lord); never another lord\'s', async () => {
  const w = world();
  const w2 = world();
  const session = { connected: true, game: w.g };
  setTimeout(() => { session.game = w2.g; }, 20);
  const r = await runIn(w, 'wait\nsee($error, $result)', { session });
  assert.deepStrictEqual(r.seen[0], [null, 'new,new,new']);
  const x = world();
  const other = world({ userName: 'SomeoneElse' });
  const s2 = { connected: true, game: x.g };
  setTimeout(() => { s2.game = other.g; }, 20);
  const r2 = await runIn(x, 'wait\nsee($error, $result)', { session: s2 });
  assert.deepStrictEqual(r2.seen[0], [null, 'same,same,same'], 'the console switched account: the run keeps its own');
  const y = world();
  const s3 = { connected: false, game: w2.g };
  const r3 = await runIn(y, 'wait\nsee($error, $result)', { session: s3 });
  assert.deepStrictEqual(r3.seen[0], [null, 'same,same,same'], 'offline: nothing to follow');
});

// ---------------------------------------------------------------------------

(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n + '\n'); continue; }
    try { await f(); console.log('  ok    ' + n); pass++; }
    catch (e) { console.log('  FAIL  ' + n + '\n        ' + String(e.message).split('\n').join('\n        ')); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
