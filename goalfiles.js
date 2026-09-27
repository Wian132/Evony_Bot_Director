'use strict';
// Prepend and Append goals kept in files (the Director's ✎ dialog). An account
// can name a .txt file for either text; the Director reads it every
// SYNC_MS and, when it differs from what the account has saved, saves the
// file's text as that account's Prepend or Append goals (goallayers.saveText,
// the same save the console's editor makes). The consoles read those texts
// every turn, so a file edit reaches the engine with no restart.
//
// The file is the source: a save in the console's editor is put back from the
// file on the next check. A missing or unreadable file leaves the saved text
// alone and is said once in the Director's log, not every check.
//
// The path is kept in the org's settings as goalFile:<which>:<accountId>, so a
// console can say in its editor that the text comes from a file.
//
// Paths on this machine are only offered when the Director is bound to the
// loopback address (director.js): these pages can serve other people, and
// naming or listing files on the host is only for the person sitting at it.
const fs = require('fs');
const path = require('path');
const GL = require('./goallayers');

const WHICH = ['prepend', 'append'];
const SYNC_MS = 15000;
const MAX_BYTES = 256 * 1024;
const key = (which, accountId) => `goalFile:${which}:${accountId}`;

// The account's file for `which`, or null.
function fileOf(org, accountId, which) {
  return org.settings.get(key(which, accountId), null) || null;
}

// Check a path the user typed or picked: absolute, a .txt file. It need not
// exist yet (the sync says when it does not). Returns the normalised path, or
// '' to clear; throws with a message the dialog shows.
function checkPath(p) {
  const s = String(p == null ? '' : p).trim().replace(/^"(.*)"$/, '$1');
  if (!s) return '';
  if (!path.isAbsolute(s)) throw new Error(`"${s}" is not a full path — start it with a drive, e.g. C:\\EvonyTool\\prepend-goals.txt`);
  if (path.extname(s).toLowerCase() !== '.txt') throw new Error(`"${s}" is not a .txt file`);
  return path.normalize(s);
}

// Keep or clear the account's file for `which`. Clearing stops the syncing and
// leaves the goals as they are.
function setFile(org, accountId, which, p) {
  if (!WHICH.includes(which)) throw new Error(`no goal file called "${which}"`);
  const v = checkPath(p);
  org.settings.set(key(which, accountId), v || null);
  return v || null;
}

// THE FLEET'S OWN FILE for one of the two texts: the org's `goalFileDefault:<which>`
// setting if it has one, otherwise whatever file most of its accounts already name. So an
// account that names none can be put on the same prepend the rest of the fleet runs
// without anyone naming it twice, and a rename follows by itself. null when no account
// names one, because then there is nothing to copy from.
// (2026-09-24, with session.holidayGoalFile below: "we can't get caught with one of our
// accs not having goals" — the user.)
function defaultFile(org, which = "prepend") {
  if (!WHICH.includes(which) || !org) return null;
  const named = org.settings.get("goalFileDefault:" + which, null);
  if (named) { try { return checkPath(named) || null; } catch { return null; } }
  let best = null, most = 0;
  const count = new Map();
  for (const acc of org.accounts.all()) {
    const f = fileOf(org, acc.id, which);
    if (!f) continue;
    const n = (count.get(f) || 0) + 1;
    count.set(f, n);
    if (n > most) { most = n; best = f; }
  }
  return best;
}

// Read a goal file: { ok, src } or { ok: false, why }.
function readFile(p) {
  let st;
  try { st = fs.statSync(p); } catch { return { ok: false, why: 'the file is not there' }; }
  if (!st.isFile()) return { ok: false, why: 'that is not a file' };
  if (st.size > MAX_BYTES) return { ok: false, why: `the file is ${Math.round(st.size / 1024)} KB, more than ${MAX_BYTES / 1024} KB` };
  try { return { ok: true, src: fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '') }; } catch (e) { return { ok: false, why: e.message }; }
}

// One account's two texts against their files. `seen` remembers the last
// problem per account and text so it is logged once. Returns what happened,
// per text: { which, file, synced, lines, errors } or { which, file, why }.
function syncAccount(org, acc, { note = () => {}, seen = new Map() } = {}) {
  const out = [];
  for (const which of WHICH) {
    const file = fileOf(org, acc.id, which);
    const tag = `${acc.id}:${which}`;
    if (!file) { seen.delete(tag); continue; }
    const r = readFile(file);
    if (!r.ok) {
      if (seen.get(tag) !== r.why) note(`${acc.label}: ${which} goals file ${file} not read — ${r.why}; its saved ${which} goals are left as they are`);
      seen.set(tag, r.why);
      out.push({ which, file, why: r.why });
      continue;
    }
    seen.delete(tag);
    const own = org.goals.exact(acc.id, which, 'goal');
    const want = r.src.trim() ? r.src : '';
    if (own && own.src === want) { out.push({ which, file, synced: false }); continue; }
    const s = GL.saveText(org.goals, acc.id, { which, src: r.src, save: true });
    const errs = s.errors.length;
    note(`${acc.label}: ${which} goals set from ${file} — ${GL.goalLines(r.src)} line(s)`
      + (errs ? `, ${errs} with an error, skipped until fixed (${s.errors.slice(0, 2).map((e) => `${e.where}: ${e.error}`).join('; ')})` : ''));
    out.push({ which, file, synced: true, lines: GL.goalLines(r.src), errors: errs });
  }
  return out;
}

// Every account of every organisation that has a file.
function syncAll(orgs, opts = {}) {
  for (const org of orgs) {
    for (const acc of org.accounts.all()) {
      try { syncAccount(org, acc, opts); } catch (e) { (opts.note || (() => {}))(`${acc.label}: goal files not synced — ${e.message}`); }
    }
  }
}

// A folder's sub-folders and .txt files, for the Browse dialog:
// { ok, dir, parent, dirs, files, roots }. `roots` are the drives on Windows.
function browse(dir) {
  const want = String(dir || '').trim();
  // "C:" alone is the current folder on C:, not its root
  const d = path.resolve(/^[a-z]:$/i.test(want) ? want + path.sep : want || __dirname);
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return { ok: false, error: `cannot open ${d}: ${e.code || e.message}` }; }
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$')).map((e) => e.name).sort(byName);
  const files = entries.filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === '.txt').map((e) => e.name).sort(byName);
  const parent = path.dirname(d) === d ? null : path.dirname(d);
  const roots = process.platform === 'win32'
    ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } })
    : ['/'];
  return { ok: true, dir: d, parent, dirs, files, roots };
}

module.exports = { WHICH, SYNC_MS, fileOf, defaultFile, checkPath, setFile, readFile, syncAccount, syncAll, browse };
