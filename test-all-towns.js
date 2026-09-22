'use strict';
// The "all towns" tick beside Run, lifted out of the real public/app.html and
// run offline: nothing connects, nothing logs in, every post is captured.
//
// What matters here is that the tick changes WHO a press acts on and nothing
// else: unticked, Run and Stop are the open city's alone, exactly as before;
// ticked, Run starts the editor's text as a separate run in every city that has
// no run of its own going, and Stop ends every running city. No city's saved
// loadouts are read or written either way — a run carries the text with it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const tests = [];
const t = (name, fn) => tests.push({ name, fn });
const eq = (a, b, m) => assert.deepStrictEqual(a, b, m);
const ok = (v, m) => assert.ok(v, m);

const HTML = fs.readFileSync(path.join(__dirname, 'public', 'app.html'), 'utf8');
function chunk(from, to) {
  const a = HTML.indexOf(from), b = HTML.indexOf(to);
  ok(a > 0 && b > a, `not found in app.html: ${a > 0 ? to : from}`);
  return HTML.slice(a, b);
}

const CITIES = [{ id: 1, name: 'Home' }, { id: 2, name: 'Second' }, { id: 3, name: 'Third' }];

// The page's own code, with the parts it leans on stubbed. Everything the test
// asserts on (posts, hints, output) is recorded as it happens.
function page({ cities = CITIES, city = '1', ticked = false, running = [], src = 'buy wood 100', answer } = {}) {
  const els = {};
  const el = (id) => (els[id] || (els[id] = { id, style: {}, value: '', checked: false, disabled: false, hidden: false, title: '', textContent: '' }));
  // the page reads the tick back from the browser's store on load, as it does for real
  const rec = { posts: [], hints: [], out: [], asked: [], syncs: 0, stored: { evony_alltowns: ticked } };
  el('editor').value = src;
  el('allTowns').checked = ticked;
  const sandbox = {
    S: { edit: 'script', city, cities, hintUntil: 0 },
    RUNS: new Map(running.map((c) => [String(c), `city ${c}`])),
    RUN_POSTS: new Set(), RUN_LOAD: new Map(), ENDED_WANT: new Set(), PAUSED: new Map(),
    runGen: 0,
    $: el,
    store: { get: (k, d) => (k in rec.stored ? rec.stored[k] : d), set: (k, v) => { rec.stored[k] = v; } },
    acctWhich: () => '',
    cityNameById: (id) => (cities.find((c) => String(c.id) === String(id)) || {}).name || 'another city',
    loadName: (s) => (/^\s*\/\/\s*(.+)$/.exec(String(s).split('\n')[0]) || [])[1] || '',
    loadOf: () => ({ slot: 3, saved: {}, drafts: {} }),
    loadoutsToActOn: async () => ({ L: { slot: 3, saved: {}, drafts: {} }, ready: true }),
    ask: async (text, o) => { rec.asked.push(Object.assign({ text }, o)); return true; },
    post: async (url, body) => {
      rec.posts.push({ url, body });
      return answer ? answer(url, body) : { ok: true, started: true, log: ['started'] };
    },
    showOutput: (text, c) => rec.out.push({ city: String(c), text }),
    paintEditHint: (extra, bad) => rec.hints.push({ extra, bad }),
    syncRuns: () => { rec.syncs++; },
    refresh: () => {},
    unstamp: (l) => String(l).replace(/^\d\d:\d\d:\d\d\.\d\d\d /, ''),
    Date, Math, JSON, Promise, String, Number, RegExp,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    chunk('// "All towns": one Run starts the SAME script', "// The server's own list of runs")
    + chunk("// One city's Run: the post and the bookkeeping", "// NEAT's `stop` paused the script"),
    sandbox, { filename: 'app.html:all-towns' });
  return { sandbox, rec, el, run: () => el('runScript').onclick(), stop: () => el('stopScript').onclick() };
}

// ---- unticked: nothing changes -------------------------------------------
t('unticked, Run posts for the open city only', async () => {
  const p = page({ city: '2' });
  await p.run();
  eq(p.rec.posts.map((x) => x.url), ['/api/script']);
  eq(p.rec.posts[0].body.city, '2');
  eq(p.rec.posts[0].body.src, 'buy wood 100');
  ok(p.rec.asked[0].text.includes('in Second'), p.rec.asked[0].text);
});

t('unticked, Run is refused while that city runs', async () => {
  const p = page({ city: '1', running: ['1'] });
  await p.run();
  eq(p.rec.posts, []);
  ok(/already running/.test(p.rec.hints.pop().extra));
});

t('unticked, Stop stops the open city only', async () => {
  const p = page({ city: '1', running: ['1', '2'] });
  await p.stop();
  eq(p.rec.posts.map((x) => [x.url, x.body.city]), [['/api/script/stop', '1']]);
});

// ---- ticked: every town ---------------------------------------------------
t('ticked, Run starts the same text in every free city', async () => {
  const p = page({ ticked: true, city: '1' });
  await p.run();
  eq(p.rec.posts.map((x) => x.body.city).sort(), ['1', '2', '3']);
  for (const x of p.rec.posts) {
    eq(x.url, '/api/script');
    eq(x.body.src, 'buy wood 100', "every city runs the editor's text");
    ok(x.body.runId, 'each run carries its own id');
  }
  eq(new Set(p.rec.posts.map((x) => x.body.runId)).size, 3, 'no two cities share a runId');
  ok(!p.rec.posts.some((x) => x.url === '/api/loadouts'), "no city's loadouts are written");
});

t('ticked, a city already running is skipped, not doubled', async () => {
  const p = page({ ticked: true, city: '1', running: ['2'] });
  await p.run();
  eq(p.rec.posts.map((x) => x.body.city).sort(), ['1', '3']);
  ok(/Skipped.*Second/.test(p.rec.asked[0].detail), p.rec.asked[0].detail);
});

t('ticked with every city running, Run does nothing', async () => {
  const p = page({ ticked: true, city: '1', running: ['1', '2', '3'] });
  await p.run();
  eq(p.rec.posts, []);
  ok(/already running in every city/.test(p.rec.hints.pop().extra));
});

t('ticked, each city gets its own Output', async () => {
  const p = page({ ticked: true, city: '1' });
  await p.run();
  eq(new Set(p.rec.out.map((o) => o.city)), new Set(['1', '2', '3']));
  ok(p.rec.out.some((o) => o.city === '3' && /Third/.test(o.text)));
});

t('ticked, a city that refuses is named and the others still run', async () => {
  const p = page({ ticked: true,
    city: '1',
    answer: (url, b) => (b.city === '2'
      ? { ok: false, log: ['12:00:00.000 parsed 1 action(s)', '12:00:00.001 there is no label frog'] }
      : { ok: true, started: true, log: [] }) });
  await p.run();
  const h = p.rec.hints.pop();
  ok(/started in 2 of 3/.test(h.extra), h.extra);
  ok(/Second/.test(h.extra), h.extra);
  ok(h.bad);
});

t('ticked, nothing starting anywhere says why, once', async () => {
  const p = page({ ticked: true, city: '1', answer: () => ({ ok: false, errors: [{ line: 2, error: 'no such command' }], log: [] }) });
  await p.run();
  const h = p.rec.hints.pop();
  ok(/1 error\(s\)/.test(h.extra) && /any city/.test(h.extra), h.extra);
});

t('ticked, Stop stops every running city', async () => {
  const p = page({ ticked: true, city: '1', running: ['1', '3'] });
  await p.stop();
  eq(p.rec.posts.map((x) => x.body.city).sort(), ['1', '3']);
  ok(/stopping all 2/.test(p.rec.hints.pop().extra));
});

t('ticked, the start line goes to every city', async () => {
  const p = page({ ticked: true, city: '1' });
  p.el('runFrom').value = 'autorun';
  await p.run();
  for (const x of p.rec.posts) eq(x.body.startLine, 'autorun');
});

// ---- the button says what a press will do ---------------------------------
t('the tick renames Run and is remembered', async () => {
  const p = page({ ticked: true, city: '1' });
  p.sandbox.paintRunBtn();
  eq(p.el('runScript').textContent, 'Run all');
  ok(/all 3 cities/.test(p.el('runScript').title), p.el('runScript').title);
  p.el('allTowns').checked = false;
  p.el('allTowns').onchange();
  eq(p.el('runScript').textContent, 'Run');
  eq(p.rec.stored.evony_alltowns, false, 'the tick is remembered per browser');
});

t('unticked, Run stays disabled only for the city that is running', async () => {
  const p = page({ city: '1', running: ['1'] });
  p.sandbox.paintRunBtn();
  eq(p.el('runScript').disabled, true);
  p.sandbox.S.city = '2';
  p.sandbox.paintRunBtn();
  eq(p.el('runScript').disabled, false);
});

t('ticked, Stop shows while any city runs, named for all of them', async () => {
  const p = page({ ticked: true, city: '2', running: ['1', '3'] });
  p.sandbox.paintRunBtn();
  eq(p.el('stopScript').hidden, false, 'the open city is idle, but two others are not');
  eq(p.el('stopScript').textContent, 'Stop all (2)');
});

(async () => {
  let bad = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log('ok   ' + name); } catch (e) { bad++; console.log('FAIL ' + name + '\n     ' + e.message); }
  }
  console.log(`\n${tests.length - bad}/${tests.length} passed`);
  process.exit(bad ? 1 : 0);
})();
