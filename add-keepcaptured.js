'use strict';
// Add (or remove) the captured-hero keep line on the fleet's shared prepend goal.
//
//   node add-keepcaptured.js            what it WOULD do, and nothing else
//   node add-keepcaptured.js --write    write it
//   node add-keepcaptured.js --remove --write   take the line back out
//
// The line is OTTObot's own reading of a NEAT goal: the prisoners it does NOT
// keep are RELEASED (goal-heroes captivesPlan). A prisoner sits in a Feasting
// Hall slot, so the level-2 hero a conquered valley drops into our cell blocks
// the training hero's round until somebody walks all 210 cities.
//
//   keepcapturedheroes any:level>600|any:base>145
//
// Safety, before running this:
//   * the consoles must already be on the build that understands it. On an older
//     console the line is read as a keep rule and nothing is released, which is
//     harmless — but then it is not doing its job either;
//   * nothing is released until the fleet hero register (`fleet_heroes`) has
//     heard from EVERY switched-on account, so a hero of ours in somebody's cell
//     can never be mistaken for a stranger. This script prints how far along that
//     is. Goals reload every tick, so no restart is needed for the line itself;
//   * a prepend row that has been EMPTIED for a holiday is left alone. Those are
//     cleared on purpose (the evony-holiday-prep skill) and nothing may be added
//     back to them by anything but the restore.
//
// Every row it changes is written to a backup file first.
const fs = require('fs');
const path = require('path');
const D = require('./db');

const WRITE = process.argv.includes('--write');
const REMOVE = process.argv.includes('--remove');
const LINE = 'keepcapturedheroes any:level>600|any:base>145';
const NOTE = '// Captured heroes: keep a prisoner past level 600 or with a base over 145, RELEASE the rest.\n'
  + '// A prisoner holds a Feasting Hall slot, so a level-2 hero from a conquered valley blocks\n'
  + '// the training hero. A hero of one of OUR accounts is never released (the fleet register).';

// A prepend that was emptied for a holiday: comments only, no goal lines.
const isEmptied = (src) => !String(src || '').split(/\r?\n/).some((l) => l.trim() && !l.trim().startsWith('//'));

const rows = D.goals.list('goal').filter((r) => r.cityKey === 'prepend' && r.accountId);
const accounts = Object.fromEntries(D.accounts.all().map((a) => [a.id, a]));
rows.sort((a, b) => Number(a.accountId.replace(/\D/g, '')) - Number(b.accountId.replace(/\D/g, '')));

const changes = [];
for (const r of rows) {
  const acc = accounts[r.accountId] || {};
  const label = `${r.accountId} ${acc.label || ''}`.padEnd(20);
  const has = String(r.src).includes('keepcapturedheroes');
  if (acc.enabled === false) { console.log(`${label} skipped — the account is switched off`); continue; }
  if (isEmptied(r.src)) { console.log(`${label} skipped — its prepend is EMPTIED (a holiday); restore it first`); continue; }
  if (REMOVE) {
    if (!has) { console.log(`${label} nothing to remove`); continue; }
    const src = String(r.src).split(/\r?\n/)
      .filter((l) => !l.includes('keepcapturedheroes') && !l.startsWith('// Captured heroes:') && !l.startsWith('// A prisoner holds') && !l.startsWith('// the training hero.'))
      .join('\n');
    changes.push({ r, src, what: 'remove' });
    console.log(`${label} REMOVE the line`);
    continue;
  }
  if (has) { console.log(`${label} already has a keepcapturedheroes line`); continue; }
  const src = `${String(r.src).replace(/\s*$/, '')}\n\n${NOTE}\n${LINE}\n`;
  changes.push({ r, src, what: 'add' });
  console.log(`${label} ADD  ${LINE}`);
}

// How complete the register is — the bot releases nothing until it is whole.
const on = D.accounts.all().filter((a) => a.enabled !== false && a.email);
const seen = new Map((D.fleetHeroes.coverage() || []).map((x) => [x.accountId, x]));
const cut = Date.now() - 24 * 3600e3;
const missing = on.filter((a) => { const x = seen.get(a.id); return !x || Number(x.at) < cut; });
console.log(`\nfleet hero register: ${D.fleetHeroes.count()} heroes from ${seen.size} of ${on.length} accounts`);
if (missing.length) {
  console.log(`  NOT COMPLETE — no heroes yet from: ${missing.map((a) => a.label || a.id).join(', ')}`);
  console.log('  Until every one has reported, nothing is released anywhere. That is the guard working,');
  console.log('  not a fault: each console writes its own heroes every few minutes once it is restarted.');
} else {
  console.log('  complete — releases may go ahead');
}

if (!changes.length) { console.log('\nnothing to write'); process.exit(0); }
if (!WRITE) { console.log(`\n${changes.length} row(s) would change. Run again with --write to do it.`); process.exit(0); }

const backup = path.join(__dirname, `goals-backup-prepend-${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(backup, JSON.stringify(changes.map((c) => ({ accountId: c.r.accountId, cityKey: c.r.cityKey, kind: c.r.kind, src: c.r.src })), null, 1));
console.log(`\nthe rows as they are now: ${backup}`);
for (const c of changes) D.goals.set(c.r.accountId, c.r.cityKey, c.r.kind, c.src);
console.log(`${changes.length} prepend row(s) written. Goals reload every tick, so this is live from each console's next pass.`);
