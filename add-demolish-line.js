'use strict';
// Add (or remove) the "research is done, tear the four down" build line on the
// fleet's shared prepend goal.
//
//   node add-demolish-line.js            what it WOULD do, and nothing else
//   node add-demolish-line.js --write    write it
//   node add-demolish-line.js --remove --write   take the line back out
//
// The line is EVONY-STRATEGY.md's "How a city is built": once every research is
// maxed the stable, forge and workshop have nothing left to do, and the
// warehouses go with them, so the plots become cottages.
//
//   build ?ag:10,…,pr:10?st:0:0,fo:0:0,ws:0:0,wh:0:0
//
// Two things about that line that are easy to get wrong (both measured offline,
// 2026-09-23):
//
//   * the THIRD part is what demolishes. `fo:0` is level 0 quantity 1 — "at most
//     one Forge" — and a city with one Forge already meets it, so nothing
//     happens. `fo:0:0` is "none at all". Same for st, ws and wh.
//   * WHERE it goes in the text decides whether it ever runs. Build lines are
//     worked in order and the first line not yet met takes the builder, so put
//     at the END of the live prepend it sits behind `build f:10:37`, which no
//     developed city can meet (all 40 field plots are in use) — the demolitions
//     are then ranked but never placed. This script inserts it BEFORE the first
//     build line of the prepend, where it is worked at once and, once the four
//     are gone, is met and passes the builder on to the rest of the ladder.
//
// Safety, before running this:
//   * DEMOLITION CANNOT BE UNDONE, and it is not covered by the security code
//     (EVONY-RULES.md §5c). This is every city of every switched-on account.
//   * a warehouse holds the resources a raid cannot take. Tearing them down
//     gives that up — the user asked for it anyway (2026-09-23).
//   * a city's OWN goals stack BEFORE the prepend, so a city with unmet build
//     lines of its own works those first. Only a9's city 100307139 has any, and
//     it already carries this line.
//   * a prepend row that has been EMPTIED for a holiday is left alone. Those are
//     cleared on purpose (the evony-holiday-prep skill) and nothing may be added
//     back to them by anything but the restore.
//   * goals reload every tick, so no console restart is needed.
//
// THE FILE IS THE SOURCE, NOT THE DATABASE. An account may name a .txt file for
// its prepend (Director ✎, org setting `goalFile:prepend:<id>`), and goalfiles.js
// copies that file over the saved text every 15 seconds. Writing only the goals
// table looks like it worked and is silently undone on the next sync — measured
// 2026-09-23: 16 of 21 rows were put back six seconds after they were written.
// So this script changes the FILE for every account that names one, and the
// database row only for the accounts that name none.
//
// Every file and row it changes is backed up first.
const fs = require('fs');
const path = require('path');
const D = require('./db');
const { parseGoals } = require('./goals');
const { readFile } = require('./goalfiles');

const WRITE = process.argv.includes('--write');
const REMOVE = process.argv.includes('--remove');

const TECHS = 'ag:10,lu:10,mas:10,mi:10,met:10,in:10,ms:10,mt:10,ir:10,lo:10,com:10,ho:10,ar:10,sp:10,med:10,con:10,en:10,mac:10,pr:10';
const LINE = `build ?${TECHS}?st:0:0,fo:0:0,ws:0:0,wh:0:0`;
const MARK = 'st:0:0,fo:0:0,ws:0:0,wh:0:0';
const NOTE = [
  '// Once every research is at 10 the stable, forge and workshop have nothing left to',
  '// do and the warehouses go with them, so the plots can become cottages',
  '// (EVONY-STRATEGY.md "How a city is built"; the user, 2026-09-23).',
  '// The third :0 is what demolishes — st:0 alone would keep one of each.',
  '// It goes BEFORE the other build lines on purpose: build lines are worked in',
  '// order, and behind `build f:10:37` it would never get the builder.',
];
const NOTE_HEADS = NOTE.map((l) => l.slice(0, 24));

// A prepend that was emptied for a holiday: comments only, no goal lines.
const isEmptied = (src) => !String(src || '').split(/\r?\n/).some((l) => l.trim() && !l.trim().startsWith('//'));

// Put the line (and its note) immediately before the first `build` line, so it
// is the first build target the city works on. No build line at all: at the end.
function insertBeforeFirstBuild(src) {
  const lines = String(src).split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s*build\b/.test(l));
  const block = [...NOTE, LINE, ''];
  if (at < 0) return `${String(src).replace(/\s*$/, '')}\n\n${block.join('\n')}`;
  lines.splice(at, 0, ...block);
  return lines.join('\n');
}

const stripLine = (src) => String(src).split(/\r?\n/)
  .filter((l) => !l.includes(MARK) && !NOTE_HEADS.some((h) => l.startsWith(h)))
  .join('\n');

// The text each account's prepend really comes from: its goal file when it names
// one (goalfiles.js copies that over the saved row every 15s), else the row.
const fileFor = {};
for (const s of D.all("SELECT k, v FROM settings WHERE k LIKE 'goalFile:prepend:%'")) {
  let p = null;
  try { p = JSON.parse(s.v); } catch { p = s.v; }
  if (p) fileFor[s.k.split(':')[2]] = path.normalize(String(p));
}

const rows = D.goals.list('goal').filter((r) => r.cityKey === 'prepend' && r.accountId);
const accounts = Object.fromEntries(D.accounts.all().map((a) => [a.id, a]));
rows.sort((a, b) => Number(a.accountId.replace(/\D/g, '')) - Number(b.accountId.replace(/\D/g, '')));

// Each distinct goal file, once, with the accounts it feeds.
const files = new Map();
for (const r of rows) {
  const f = fileFor[r.accountId];
  if (!f) continue;
  if (!files.has(f)) files.set(f, []);
  files.get(f).push(r.accountId);
}

const changes = [];
for (const r of rows) {
  const acc = accounts[r.accountId] || {};
  const via = fileFor[r.accountId] ? ` (from ${path.basename(fileFor[r.accountId])})` : '';
  const label = `${r.accountId} ${acc.label || ''}`.padEnd(20);
  const has = String(r.src).includes(MARK);
  if (acc.enabled === false) { console.log(`${label} skipped — the account is switched off`); continue; }
  if (isEmptied(r.src)) { console.log(`${label} skipped — its prepend is EMPTIED (a holiday); restore it first`); continue; }
  // An account whose prepend comes from a file is changed by changing the file:
  // writing its row here would be put back within 15 seconds.
  if (fileFor[r.accountId]) { console.log(`${label} via the file${via}`); continue; }
  if (REMOVE) {
    if (!has) { console.log(`${label} nothing to remove`); continue; }
    changes.push({ r, src: stripLine(r.src), what: 'remove' });
    console.log(`${label} REMOVE the line`);
    continue;
  }
  if (has) { console.log(`${label} already has the line`); continue; }
  const src = insertBeforeFirstBuild(r.src);
  // never write a prepend the parser will not take
  const p = parseGoals(src);
  const errs = [...(p.errors || [])].map((e) => (typeof e === 'string' ? e : e.error));
  if (errs.length) { console.log(`${label} NOT CHANGED — the new text does not parse: ${errs.join('; ')}`); continue; }
  const built = (p.goals || []).filter((g) => g.name === 'build');
  const first = built[0];
  const ok = first && (first.targets || []).some((t) => t.raw === 'st:0:0');
  if (!ok) { console.log(`${label} NOT CHANGED — the line did not land as the first build line`); continue; }
  changes.push({ r, src, what: 'add' });
  console.log(`${label} ADD  as build line 1 of ${built.length}`);
}

// The goal files, which feed the accounts above that name one.
const fileChanges = [];
for (const [f, ids] of files) {
  const who = `${ids.length} account(s): ${ids.join(' ')}`;
  const read = readFile(f);
  if (!read.ok) { console.log(`\n${f}\n  SKIPPED — ${read.why} (${who})`); continue; }
  const hasIt = read.src.includes(MARK);
  if (REMOVE) {
    if (!hasIt) { console.log(`\n${f}\n  nothing to remove (${who})`); continue; }
    fileChanges.push({ f, src: stripLine(read.src), was: read.src });
    console.log(`\n${f}\n  REMOVE the line (${who})`);
    continue;
  }
  if (hasIt) { console.log(`\n${f}\n  already has the line (${who})`); continue; }
  const src = insertBeforeFirstBuild(read.src);
  const p = parseGoals(src);
  const errs = (p.errors || []).map((e) => (typeof e === 'string' ? e : e.error));
  if (errs.length) { console.log(`\n${f}\n  NOT CHANGED — does not parse: ${errs.join('; ')}`); continue; }
  const built = (p.goals || []).filter((g) => g.name === 'build');
  if (!(built[0] && (built[0].targets || []).some((t) => t.raw === 'st:0:0'))) {
    console.log(`\n${f}\n  NOT CHANGED — the line did not land as the first build line`);
    continue;
  }
  fileChanges.push({ f, src, was: read.src });
  console.log(`\n${f}\n  ADD as build line 1 of ${built.length} (${who})`);
}

if (!changes.length && !fileChanges.length) { console.log('\nnothing to write'); process.exit(0); }
if (!WRITE) {
  console.log(`\n${fileChanges.length} file(s) and ${changes.length} row(s) would change. Run again with --write to do it.`);
  console.log('DEMOLITION CANNOT BE UNDONE — this takes down the stable, forge, workshop and');
  console.log('every warehouse in every city of every account listed above.');
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 10);
const backup = path.join(__dirname, `goals-backup-prepend-${stamp}.json`);
fs.writeFileSync(backup, JSON.stringify({
  rows: changes.map((c) => ({ accountId: c.r.accountId, cityKey: c.r.cityKey, kind: c.r.kind, src: c.r.src })),
  files: fileChanges.map((c) => ({ file: c.f, src: c.was })),
}, null, 1));
console.log(`\nthe files and rows as they are now: ${backup}`);

for (const c of fileChanges) {
  fs.copyFileSync(c.f, `${c.f}.bak-${stamp}`);
  fs.writeFileSync(c.f, c.src);
  console.log(`wrote ${c.f}`);
}
for (const c of changes) D.goals.set(c.r.accountId, c.r.cityKey, c.r.kind, c.src);
console.log(`\n${fileChanges.length} file(s) and ${changes.length} prepend row(s) written.`);
console.log('The Director copies a changed goal file over each account\'s saved text within 15s,');
console.log('and goals reload every tick, so this is live from each console\'s next pass.');
