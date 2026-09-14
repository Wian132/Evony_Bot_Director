'use strict';
// One-off: keep saved `build` lines doing what they did before build lines were
// read the NEAT way (Step 5).
//
// The old engine read a target as an EXACT end state: `build c:10:1` meant
// exactly one cottage at L10, and every other cottage came down. NEAT reads it
// as AT LEAST one and demolishes only for a 0 (wiki: Build). So each target for
// a type a city can have many of, type:L:Q with L and Q above 0, becomes
// type:L:Q,type:0:Q: at least Q at L, and at most Q, as before.
//
//   node migrate-goals-build.js                      dry run on ./evony.db (or $EVONY_DB)
//   node migrate-goals-build.js --db other.db        dry run on another file
//   node migrate-goals-build.js --db other.db --apply
//        writes the rewritten rows, after saving the old ones as JSON in
//        json-backup/ beside the database file
//
// Only goal rows are read and only their build lines change. Comments, other
// goals and commented-out build lines are left as they are. Everything else
// the new reading changes is printed as a note, not rewritten. Running it
// twice changes nothing the second time.
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbAt = args.indexOf('--db');
const FILE = path.resolve(dbAt >= 0 && args[dbAt + 1] ? args[dbAt + 1] : (process.env.EVONY_DB || path.join(__dirname, 'evony.db')));

// goals.js loads the goal modules, and one of them opens db.js, which opens
// (and creates tables in) whatever EVONY_DB names. Point that at a throwaway
// file so the only file this script touches is the one it was asked to.
if (require.main === module) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-goals-build-'));
  process.env.EVONY_DB = path.join(scratch, 'unused.db');
  process.on('exit', () => {
    try { require('./db').db.close(); } catch {}
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  });
}
const G = require('./goals');
const C = require('./constants');

// node:sqlite prints an ExperimentalWarning on require
const _emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w).includes('SQLite is an experimental feature') ? undefined : _emit.call(process, w, ...rest));
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = _emit;

// One build line -> { line, notes }. Targets are rewritten in place, so
// conditions, groups and spacing stay as the user wrote them.
function migrateLine(line) {
  const m = line.match(/^(\s*build\s+)(.*?)(\s*)$/i);
  if (!m) return { line, notes: [] };
  const notes = [];
  if (/\?[^?]*\?/.test(m[2])) {
    notes.push('this line has a ?condition?: the old engine ignored it and ran the line always; now it runs only while the condition holds');
  }
  const seen = {};
  const body = m[2].split(/(\s+)/).map((tok) => {
    if (!tok.trim()) return tok;
    const g = tok.match(/^(\?[^?]*\?)?([^?]*)(\?[^?]*\?)?$/);
    if (!g || !g[2]) { notes.push(`"${tok}" is not a group the new parser reads; left as it is`); return tok; }
    const parts = g[2].split(',');
    const typesWhere = (ok) => new Set(parts.map((p) => p.trim().split(':')).filter(ok)
      .map((b) => (G.buildingOf(b[0]) || {}).typeId).filter(Boolean));
    // already capped in this group (a second run, or written that way)
    const capped = typesWhere((b) => b[1] === '0' && /^\d+$/.test(b[2] || ''));
    const raised = typesWhere((b) => /^[1-9]\d*$/.test(b[1] || '') && /^[1-9]\d*$/.test(b[2] || ''));
    const out = [];
    for (const raw of parts) {
      out.push(raw);
      const t = raw.trim();
      if (!t) continue;
      const [code, lv, qty, ...rest] = t.split(':');
      const def = G.buildingOf(code);
      if (!def || rest.length) continue;          // the parser reports these itself
      if (!/^\d+$/.test(lv || '') || (qty !== undefined && !/^\d+$/.test(qty))) {
        notes.push(`${t}: not a number; the old engine read it as 0 and demolished every ${def.name}, the new parser refuses it`);
        continue;
      }
      const L = Number(lv), Q = qty === undefined ? null : Number(qty);
      const multi = G.MULTI_BUILDINGS.has(def.typeId);
      seen[def.typeId] = (seen[def.typeId] || 0) + (L > 0 && Q !== 0 ? 1 : 0);
      if (multi && L > 0 && Q > 0 && !capped.has(def.typeId)) {
        out.push(`${code}:0:${Q}`);
        capped.add(def.typeId);
      } else if (multi && L > 0 && Q === null) {
        notes.push(`${t}: no quantity. The old engine kept exactly one ${def.name} and demolished the rest; now it keeps at least one and demolishes none. Write ${code}:${L}:1,${code}:0:1 for the old meaning`);
      } else if (L > 0 && Q === 0) {
        notes.push(`${t}: the old engine demolished every ${def.name}; now each is only taken down to L${L - 1}. Write ${code}:0:0 for the old meaning`);
      } else if (multi && L === 0 && Q > 0 && !raised.has(def.typeId)) {
        notes.push(`${t}: still at most ${Q}; the old engine also built new ones up to ${Q}, which the new reading doesn't`);
      }
    }
    return (g[1] || '') + out.join(',') + (g[3] || '');
  }).join('');
  for (const [typeId, count] of Object.entries(seen)) {
    if (count > 1) notes.push(`several targets for ${(C.BUILDING_BY_ID[typeId] || {}).name}: the old engine fought over them, now they combine`);
  }
  return { line: m[1] + body + m[3], notes };
}

// A whole goal text -> { src, changed: [{ n, from, to }], notes }
function migrateText(src) {
  const eol = /\r\n/.test(src) ? '\r\n' : '\n';
  const lines = String(src).split(/\r?\n/);
  const changed = [], notes = [];
  let buildLines = 0;
  const out = lines.map((line, i) => {
    if (!/^\s*build\s/i.test(line)) return line;       // comments start with // or #, so never match
    buildLines++;
    const r = migrateLine(line);
    for (const note of r.notes) notes.push(`line ${i + 1}: ${note}`);
    if (r.line !== line) changed.push({ n: i + 1, from: line.trim(), to: r.line.trim() });
    return r.line;
  });
  if (buildLines > 1) notes.push(`${buildLines} build lines now run one after another, in the order written; the old engine merged them`);
  return { src: out.join(eol), changed, notes };
}

function main() {
  if (!fs.existsSync(FILE)) { console.error(`no database at ${FILE}`); process.exit(2); }
  const db = new DatabaseSync(FILE, { readOnly: !apply });
  const has = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'goals'").get();
  if (!has) { console.error(`${FILE} has no goals table`); process.exit(2); }
  const rows = db.prepare("SELECT accountId, cityKey, kind, src FROM goals WHERE kind = 'goal' ORDER BY accountId, cityKey").all();
  console.log(`migrate-goals-build: ${apply ? 'APPLYING to' : 'dry run on'} ${FILE}${apply ? '' : ' (nothing is written; add --apply)'}`);

  const todo = [];
  for (const row of rows) {
    const r = migrateText(row.src || '');
    if (!r.changed.length && !r.notes.length) continue;
    console.log(`\n=== account ${row.accountId || '(shared)'} city ${row.cityKey}`);
    for (const c of r.changed) console.log(`  line ${c.n}: ${c.from}\n       -> ${c.to}`);
    for (const note of r.notes) console.log(`  note: ${note}`);
    const before = G.parseGoals(row.src || '').errors.length, after = G.parseGoals(r.src).errors;
    if (after.length > before) for (const e of after) console.log(`  parse: line ${e.line}: ${e.error}`);
    if (r.changed.length) todo.push({ row, src: r.src });
  }

  console.log(`\n${todo.length} of ${rows.length} goal row(s) ${apply ? 'to rewrite' : 'would change'}.`);
  if (!apply) {
    if (todo.length) console.log('Run again with --apply to write them.');
    db.close();
    return;
  }
  if (!todo.length) { db.close(); return; }
  // beside the database, in the json-backup folder migrate-sqlite.js uses (gitignored)
  const dir = path.join(path.dirname(FILE), 'json-backup');
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `goals-before-build-migration-${Date.now()}.json`);
  fs.writeFileSync(backup, JSON.stringify(todo.map(({ row }) => row), null, 2));
  console.log(`old rows saved to ${backup}`);
  const upd = db.prepare("UPDATE goals SET src = ?, savedAt = ? WHERE accountId = ? AND cityKey = ? AND kind = 'goal'");
  db.exec('BEGIN');
  try {
    for (const { row, src } of todo) upd.run(src, Date.now(), row.accountId, row.cityKey);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.close();
  console.log(`${todo.length} row(s) rewritten.`);
}

if (require.main === module) main();
module.exports = { migrateText, migrateLine };
