'use strict';
// One-off: rewrite requestresources / requesttroops lines saved in this tool's
// OLD argument order into NEAT's order, so each line keeps doing exactly what
// it did before.
//
//   node migrate-goals-transfer.js                 dry run: show every change, write nothing
//   node migrate-goals-transfer.js --apply         write them (each changed row is backed up first)
//   node migrate-goals-transfer.js --account a2    only that account (with or without --apply)
//
// It works on the database EVONY_DB names, else evony.db beside this file.
//
//   old  requestresources <from> <type> <min> <max> <batch> <keep> [t] [/slots:N]
//   new  requestresources <from> <type> <max> <keep> * <batch> [t] /below:<min> [/slots:N]
//
// and the same for requesttroops. Why that is the same line (goal-transfer.js):
//   <max>   becomes localAmount: never fill past it, and nothing is asked for at
//           or above it, which is what max - have <= 0 did before.
//   <keep>  becomes remoteAmount: what a sender keeps.
//   *       minBatch: there was none, so nothing is held back for size.
//   <batch> becomes maxBatch: at most this per send.
//   <min>   becomes /below: start asking only under it. A sender is still
//           never taken under it either, as before (its trigger level).
//
// Run it ONCE, right after updating to the NEAT order: until then every saved
// line is in the old order. A line that already carries /below is taken as
// done, so a second run changes nothing. A line the old parser would have
// refused (not four amounts, a carrier other than t, a switch other than
// /slots) is left as it is and listed, for a person to look at. Commented
// lines in the old shape, like the usage note `// requestresources <donor>
// <type> <min> <max> <batch> <keep>`, are rewritten too, so the note above the
// lines still describes them.
const fs = require('fs');
const path = require('path');

const KEYWORDS = new Set(['requestresources', 'requesttroops']);
// the old parser's number grammar (goal-transfer.js before the NEAT order)
const isNum = (t) => /^[\d.]+\s*[kmbd]?$/i.test(String(t)) && Number.isFinite(parseFloat(t));
const isPlaceholder = (t) => /^<[^<>\s]+>$/.test(String(t));
// the only 5th word the old requestresources took: transports
const OLD_FLAG = /^(t|trans|transports?|transporters?)$/i;

// One line of goal text -> { text, changed, why }. `why` says why a request
// line was left alone.
function migrateLine(raw) {
  const m = String(raw).match(/^(\s*)((?:\/\/|#)\s*)?(.*?)\s*$/);
  const indent = m[1], comment = m[2] || '', body = m[3];
  const tok = body.split(/\s+/).filter(Boolean);
  if (!tok.length || !KEYWORDS.has(tok[0].toLowerCase())) return { text: raw, changed: false };
  const troops = tok[0].toLowerCase() === 'requesttroops';
  const amountOk = (t) => t === '*' || isNum(t) || (comment && isPlaceholder(t));

  const switches = [], rest = [];
  for (const t of tok.slice(1)) {
    const s = t.match(/^\/([a-z]+)(?:[:=](.*))?$/i);
    if (s) switches.push({ key: s[1].toLowerCase(), tok: t }); else rest.push(t);
  }
  if (switches.some((s) => s.key === 'below')) return { text: raw, changed: false, done: true };
  const odd = switches.find((s) => s.key !== 'slots');
  if (odd) return { text: raw, changed: false, why: `switch ${odd.tok} is not the old grammar's` };

  const [target, what, ...nums] = rest;
  if (!target || !what) return { text: raw, changed: false, why: 'no <from> and <type>' };
  let flag = null;
  if (!troops && nums.length === 5 && OLD_FLAG.test(nums[4])) flag = nums.pop();
  if (nums.length !== 4 || !nums.every(amountOk)) {
    return { text: raw, changed: false, why: `not in the old shape (<min> <max> <batch> <keep>${troops ? '' : ' [t]'})` };
  }
  const [min, max, batch, keep] = nums;
  const out = [tok[0], target, what, max, keep, '*', batch];
  if (flag) out.push(flag);
  out.push(`/below:${min}`);
  for (const s of switches) out.push(s.tok);
  return { text: `${indent}${comment}${out.join(' ')}`, changed: true };
}

// A whole goal text -> { src, changes: [{line, before, after}], skipped: [{line, text, why}], done }
// where `done` counts the lines already in the new order (they carry /below).
function migrateText(src) {
  const lines = String(src || '').split(/\r?\n/);
  const eol = /\r\n/.test(String(src || '')) ? '\r\n' : '\n';
  const changes = [], skipped = [];
  let done = 0;
  const out = lines.map((line, i) => {
    const r = migrateLine(line);
    if (r.changed) changes.push({ line: i + 1, before: line.trim(), after: r.text.trim() });
    else if (r.why) skipped.push({ line: i + 1, text: line.trim(), why: r.why });
    else if (r.done) done++;
    return r.text;
  });
  return { src: out.join(eol), changes, skipped, done };
}

// ---------------------------------------------------------------------- CLI

function main(argv) {
  const apply = argv.includes('--apply');
  const ai = argv.indexOf('--account');
  const only = ai >= 0 ? argv[ai + 1] : null;
  const D = require('./db');
  const say = (s = '') => console.log(s);

  say(`\n${apply ? 'MIGRATING' : 'dry run (nothing is written; add --apply to write)'}: ${D.FILE}${only ? `, account ${only}` : ''}\n`);
  const rows = D.goals.list('goal').filter((r) => !only || r.accountId === only);
  const todo = [];
  let lines = 0, skips = 0, done = 0;
  for (const r of rows) {
    const res = migrateText(r.src);
    done += res.done;
    if (!res.changes.length && !res.skipped.length) continue;
    say(`=== account ${r.accountId || '(shared)'} city ${r.cityKey}`);
    for (const c of res.changes) say(`  line ${c.line}\n    before: ${c.before}\n    after:  ${c.after}`);
    for (const s of res.skipped) say(`  line ${s.line} left as it is (${s.why}): ${s.text}`);
    say();
    lines += res.changes.filter((c) => !/^(\/\/|#)/.test(c.before)).length;
    skips += res.skipped.length;
    if (res.changes.length) todo.push({ row: r, src: res.src });
  }
  say(`${lines} goal line(s) to rewrite in ${todo.length} goal text(s), ${skips} left alone`
    + `${done ? `, ${done} already in the new order` : ''}.`);
  if (!apply) { say('Dry run: nothing written.'); return 0; }
  if (!todo.length) { say('Nothing to write.'); return 0; }

  // A copy of every row before it changes, beside the database (json-backup/
  // is gitignored).
  const dir = path.join(path.dirname(D.FILE), 'json-backup');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `goals-before-neat-order-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(todo.map((t) => t.row), null, 2));
  say(`backup of ${todo.length} row(s): ${file}`);
  for (const t of todo) D.goals.set(t.row.accountId, t.row.cityKey, 'goal', t.src);
  say(`written. The engine reads goals every tick, so the next tick runs the new lines.`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { migrateLine, migrateText, main };
