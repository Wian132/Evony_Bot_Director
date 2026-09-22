'use strict';
// The Armies (rally spot) tab, rendered from the real app.html source. Offline:
// nothing connects, nothing logs in. What matters here is the Action cell —
// every march that is still out has to offer its own Recall button, because a
// recall is the one thing you cannot do from anywhere else once a march is on
// its way.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const tests = [];
const t = (name, fn) => tests.push({ name, fn });
const ok = (v, m) => assert.ok(v, m);
const eq = (a, b, m) => assert.deepStrictEqual(a, b, m);

// ---- the real renderArmies, lifted out of public/app.html ------------------
function armiesTab() {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'app.html'), 'utf8');
  const from = html.indexOf('// ---- Armies (rally spot) and Incoming');
  const to = html.indexOf('// ---- Troops --');
  ok(from > 0 && to > from, 'renderArmies not found in app.html');
  const sandbox = {
    S: { marches: null, armiesAll: false },
    esc: (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])),
    fmt: (x) => String(x),
    short: (x) => String(x ?? ''),
    until: (ms) => String(ms),
    TROOP_NAME: {},
    grid: (cols, rows) => { sandbox.lastGrid = { cols, rows }; return '<table/>'; },
  };
  vm.createContext(sandbox);
  vm.runInContext(html.slice(from, to) + '\nthis.renderArmies = renderArmies;', sandbox);
  return sandbox;
}

const CITY = { fieldId: 1000, x: 100, y: 100, buildings: [{ name: 'Rally Spot', levels: [10] }] };
const march = (o = {}) => ({
  armyId: 55, mission: 'attack', direction: 'out', hero: 'Alfred', heroLevel: 21,
  to: 'Barbarian', startFieldId: 1000, targetFieldId: 1001, target: { x: 101, y: 100 },
  reachTime: Date.now() + 60000, troopTotal: 100000, units: { archer: 100000 }, ...o,
});
// The Action cell of every rendered row, in order.
function actions(sandbox, list, opt = {}) {
  sandbox.S.marches = { serverNow: Date.now(), outgoing: list };
  sandbox.S.armiesAll = !!opt.all;
  sandbox.lastGrid = null;
  sandbox.renderArmies(opt.city || CITY);
  const rows = (sandbox.lastGrid && sandbox.lastGrid.rows) || [];
  return rows.map((r) => r.cells[r.cells.length - 1]);
}

t('a march still going out gets its own Recall button', () => {
  const s = armiesTab();
  const cells = actions(s, [march()]);
  eq(cells.length, 1);
  ok(/data-act="recall"/.test(cells[0]), 'no Recall button: ' + cells[0]);
  ok(/data-id="55"/.test(cells[0]), 'the button carries the armyId: ' + cells[0]);
});

t('one Recall button per march, each with its own army', () => {
  const s = armiesTab();
  const cells = actions(s, [march({ armyId: 1 }), march({ armyId: 2, mission: 'transport' }), march({ armyId: 3, direction: 'camped' })]);
  eq(cells.length, 3);
  eq(cells.map((c) => (/data-id="(\d+)"/.exec(c) || [])[1]), ['1', '2', '3']);
});

t('a march on its way home offers no Recall', () => {
  const s = armiesTab();
  const cells = actions(s, [march({ direction: 'back' })]);
  ok(!/data-act="recall"/.test(cells[0]), 'a returning march cannot be recalled: ' + cells[0]);
});

t('a march with no armyId cannot be recalled, and says so instead of failing', () => {
  const s = armiesTab();
  const cells = actions(s, [march({ armyId: undefined })]);
  ok(!/data-act="recall"/.test(cells[0]), 'no button without an armyId: ' + cells[0]);
  ok(/no army id yet/.test(cells[0]), 'says why there is no button: ' + cells[0]);
});

t('a returning march says it is coming home rather than leaving the cell blank', () => {
  const s = armiesTab();
  const cells = actions(s, [march({ direction: 'back' })]);
  ok(/coming home/.test(cells[0]), cells[0]);
});

t('a camped march tells the confirm it is camped, not heading out', () => {
  const s = armiesTab();
  const cells = actions(s, [march({ direction: 'camped' })]);
  ok(/data-dir="camped"/.test(cells[0]), cells[0]);
});

t('every city: a march from another city still gets a Recall', () => {
  const s = armiesTab();
  const cells = actions(s, [march({ armyId: 7, startFieldId: 2000, from: 'Other' })], { all: true });
  eq(cells.length, 1);
  ok(/data-act="recall"/.test(cells[0]), 'no Recall on another city\'s march: ' + cells[0]);
});

(async () => {
  let bad = 0;
  for (const x of tests) {
    try { await x.fn(); console.log('  ok   ' + x.name); }
    catch (e) { bad++; console.log('  FAIL ' + x.name + '\n       ' + (e.message || e).split('\n')[0]); }
  }
  console.log(bad ? `\n${bad} failed` : `\nall ${tests.length} passed`);
  process.exit(bad ? 1 : 0);
})();
