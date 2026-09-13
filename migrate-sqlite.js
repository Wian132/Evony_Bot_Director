'use strict';
// One-shot import of the old JSON files into evony.db.
//
//   node migrate-sqlite.js          import, leaving the JSON files untouched
//   node migrate-sqlite.js --archive  import, then move the JSON into ./json-backup
//
// Safe to run more than once: every write is an upsert keyed on id, so a second
// run refreshes rather than duplicates.
const fs = require('fs');
const path = require('path');
const D = require('./db');

const ARCHIVE = process.argv.includes('--archive');
const read = (f, d) => {
  const p = path.join(__dirname, f);
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return d; }
};
const exists = (f) => fs.existsSync(path.join(__dirname, f));
const say = (m) => console.log('  ' + m);

console.log(`\nimporting into ${D.FILE}\n`);

// ------------------------------------------------------------------ accounts
const adb = read('accounts.json', { accounts: [] });
let nAcc = 0, nSnap = 0;
for (const [i, a] of (adb.accounts || []).entries()) {
  D.accounts.upsert({
    id: a.id, label: a.label, server: a.server, email: a.email, password: a.password,
    enabled: a.enabled !== false, notes: a.notes, proxy: a.proxy, pos: i,
  });
  nAcc++;
  // The old file held exactly one snapshot per account; it becomes row one of
  // the history rather than being thrown away.
  if (a.snapshot && a.snapshot.at) { D.snapshots.add(a.id, a.snapshot); nSnap++; }
}
say(`accounts: ${nAcc}  (${nSnap} snapshot(s) seeded as the first history row)`);

if (adb.proxyText !== undefined) D.settings.set('proxyText', adb.proxyText);
else if (exists('proxies.txt')) D.settings.set('proxyText', fs.readFileSync(path.join(__dirname, 'proxies.txt'), 'utf8'));

// --------------------------------------------------------------------- goals
// The flat store was keyed by castle id or name with a global `default`. Those
// keys move in under accountId '' (shared) so nothing stops resolving; the
// Director can then re-home them per account.
let nGoals = 0;
for (const [file, kind] of [['goalstore.json', 'goal'], ['scriptstore.json', 'script']]) {
  const store = read(file, {});
  for (const [key, entry] of Object.entries(store)) {
    if (!entry || !entry.src) continue;
    D.goals.set('', key, kind, entry.src);
    nGoals++;
  }
}
say(`goals/scripts: ${nGoals}`);

// -------------------------------------------------------------- engine state
const est = read('enginestate.json', {});
D.engineState.save(est);
say(`engine state: ${Object.keys(est).length} city key(s)`);

// ----------------------------------------------------------------- map cache
const mc = read('mapcache.json', { castles: {} });
const tiles = Object.values(mc.castles || {});
if (tiles.length) D.mapCache.upsertMany(tiles);
say(`map cache: ${tiles.length} tile(s)`);

// ------------------------------------------------------------- watchlist etc
const watch = read('watchlist.json', null);
if (watch) D.settings.set('watchlist', watch);
const snaps = read('snapshots.json', {});
let nPlayers = 0;
for (const [name, s] of Object.entries(snaps)) {
  if (!s || !s.at) continue;
  D.players.record(name, s.prestige, s.at);
  nPlayers++;
}
say(`watchlist: ${watch ? watch.length : 0} name(s), ${nPlayers} prestige snapshot(s)`);

// --------------------------------------------------------------------- done
if (ARCHIVE) {
  const dir = path.join(__dirname, 'json-backup');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['accounts.json', 'goalstore.json', 'scriptstore.json', 'enginestate.json',
    'mapcache.json', 'watchlist.json', 'snapshots.json']) {
    if (exists(f)) fs.renameSync(path.join(__dirname, f), path.join(dir, f));
  }
  say(`archived the old JSON into ${dir}`);
}

const s = D.stats();
console.log(`\ndone — ${(s.sizeBytes / 1024).toFixed(0)} KB`);
console.log(`  accounts ${s.accounts} | snapshots ${s.snapshots} | goals ${s.goals} | map ${s.mapCache} | uptime ${s.uptime}\n`);
