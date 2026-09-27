'use strict';
// Keeps a fleet's real names out of the repo.
//
// The docs, tests and skills talk about accounts all the time, and the in-game lord
// names tie the code to the real accounts on a live server. So tracked files never
// carry them: each account gets a stable ALIAS (Lord01, Lord02 …) and the map from
// alias to real name lives in privacy.local.json, which is gitignored and stays on
// this machine. The same file lists strings to redact outright (a home IP, proxy IPs).
//
//   node privacy.js                 the alias table: alias, account id, real names
//   node privacy.js sync            add any account in evony.db the map lacks, and
//                                   every proxy IP from the db and *proxies*.txt
//   node privacy.js redact <text> [<replacement>]
//                                   always replace <text> (default "<redacted>")
//   node privacy.js scrub [--dry]   rewrite tracked (and trackable) files in place
//   node privacy.js check [--staged]
//                                   exit 1 if a real name, redacted string, or any
//                                   account's password, email or security code (read
//                                   from evony.db, never stored) is in the files —
//                                   --staged reads what is about to be committed
//   node privacy.js filter          stdin -> stdout, for a history rewrite
//   node privacy.js install-hook    run `check --staged` before every commit
//
// privacy.local.json:
//   {
//     "aliases": {
//       "Lord02": { "id": "a2", "names": ["RealName", "OtherSpelling"] },
//       "Lord13": { "id": "a13", "names": [], "contextual": ["Harbor"] }
//     },
//     "redact": { "203.0.113.9": "<home-ip>" }
//   }
//
// A name matches whole (letters and digits either side stop it; `_` does not), in any
// case, and the alias takes the case it replaced: `name` -> `lord02`, `NAME` -> `LORD02`.
// A "contextual" name is an ordinary word too ("Harbor"), so it is replaced only on a
// line that also names the account's id or another fleet account — exact case only.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = __dirname;
const MAP_FILE = path.join(ROOT, 'privacy.local.json');
const TEXT_EXT = /\.(js|mjs|cjs|json|md|txt|html|css|csv|ps1|sh|ya?ml|xml|example)$/i;
const MAX_BYTES = 5 * 1024 * 1024;

function loadMap() {
  try { return JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')); } catch { return { aliases: {}, redact: {} }; }
}
function saveMap(m) { fs.writeFileSync(MAP_FILE, JSON.stringify(m, null, 2) + '\n'); }

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EDGE_L = '(?<![A-Za-z0-9])';
const EDGE_R = '(?![A-Za-z0-9])';

// The scrubber for one map: text in, text out.
function scrubber(map) {
  const byLower = new Map();           // lower-case name -> { alias, canonical }
  const contextual = [];               // { name, alias, id }
  for (const [alias, a] of Object.entries(map.aliases || {})) {
    for (const n of a.names || []) if (n) byLower.set(n.toLowerCase(), { alias, canonical: n });
    for (const n of a.contextual || []) if (n) contextual.push({ name: n, alias, id: a.id });
  }
  const names = [...byLower.values()].map((v) => v.canonical).sort((x, y) => y.length - x.length);
  const nameRe = names.length ? new RegExp(EDGE_L + '(' + names.map(esc).join('|') + ')' + EDGE_R, 'gi') : null;
  const aliasRe = new RegExp(EDGE_L + '(' + Object.keys(map.aliases || {}).map(esc).join('|') + ')' + EDGE_R, 'i');
  const redact = Object.entries(map.redact || {}).sort((x, y) => y[0].length - x[0].length);

  const cased = (hit, canonical, alias) => {
    if (hit === canonical) return alias;
    if (hit === hit.toLowerCase()) return alias.toLowerCase();
    if (hit === hit.toUpperCase() && canonical !== canonical.toUpperCase()) return alias.toUpperCase();
    return alias;
  };

  return (text) => {
    let out = text;
    for (const [s, r] of redact) out = out.split(s).join(r);
    if (nameRe) out = out.replace(nameRe, (hit) => { const v = byLower.get(hit.toLowerCase()); return cased(hit, v.canonical, v.alias); });
    if (contextual.length) {
      out = out.split('\n').map((line) => {
        for (const c of contextual) {
          if (!line.includes(c.name)) continue;
          const near = aliasRe.test(line) || (c.id && new RegExp(EDGE_L + esc(c.id) + EDGE_R).test(line));
          if (near) line = line.replace(new RegExp(EDGE_L + esc(c.name) + EDGE_R, 'g'), c.alias);
        }
        return line;
      }).join('\n');
    }
    return out;
  };
}

// Tracked files plus the untracked ones .gitignore lets through (what `git add .` takes).
function repoFiles() {
  const ls = (args) => cp.execSync('git ' + args, { cwd: ROOT, maxBuffer: 1e8 }).toString().split('\n').filter(Boolean);
  const all = [...new Set([...ls('ls-files'), ...ls('ls-files --others --exclude-standard')])];
  return all.filter((f) => TEXT_EXT.test(f) && f !== 'privacy.local.json' && fs.existsSync(path.join(ROOT, f)));
}

// Secrets that must never be in a file, read fresh from evony.db and never written out.
function dbSecrets() {
  const out = [];
  const file = process.env.EVONY_DB || path.join(ROOT, 'evony.db');
  if (!fs.existsSync(file)) return out;
  const emit = process.emitWarning;
  process.emitWarning = () => {};
  let db;
  try { db = new (require('node:sqlite').DatabaseSync)(file, { readOnly: true }); } catch { return out; } finally { process.emitWarning = emit; }
  const add = (v, what) => { v = String(v ?? '').trim(); if (v.length >= 5) out.push({ v, what }); };
  try {
    for (const r of db.prepare('SELECT id, email, password, securityCode FROM accounts').all()) {
      add(r.password, `account ${r.id} password`);
      add(r.email, `account ${r.id} login email`);
      add(r.securityCode, `account ${r.id} security code`);
    }
  } catch {}
  try { for (const r of db.prepare('SELECT email FROM users').all()) add(r.email, 'Director user email'); } catch {}
  db.close();
  return out;
}

function proxyHosts() {
  const hosts = new Set();
  const take = (s) => { const m = String(s || '').replace(/^\w+:\/\//, '').replace(/^[^@]*@/, '').match(/^(\d{1,3}(?:\.\d{1,3}){3})/); if (m) hosts.add(m[1]); };
  for (const f of fs.readdirSync(ROOT)) if (/proxies.*\.txt$/i.test(f)) for (const l of fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/)) take(l.trim());
  const file = process.env.EVONY_DB || path.join(ROOT, 'evony.db');
  if (fs.existsSync(file)) {
    const emit = process.emitWarning;
    process.emitWarning = () => {};
    try {
      const db = new (require('node:sqlite').DatabaseSync)(file, { readOnly: true });
      for (const r of db.prepare('SELECT proxy FROM accounts').all()) take(r.proxy);
      db.close();
    } catch {} finally { process.emitWarning = emit; }
  }
  return hosts;
}

function dbAccounts() {
  const file = process.env.EVONY_DB || path.join(ROOT, 'evony.db');
  if (!fs.existsSync(file)) return [];
  const emit = process.emitWarning;
  process.emitWarning = () => {};
  try {
    const db = new (require('node:sqlite').DatabaseSync)(file, { readOnly: true });
    const rows = db.prepare('SELECT id, label FROM accounts').all();
    db.close();
    return rows;
  } catch { return []; } finally { process.emitWarning = emit; }
}

function sync() {
  const map = loadMap();
  map.aliases = map.aliases || {};
  map.redact = map.redact || {};
  const known = new Set(Object.values(map.aliases).flatMap((a) => [...(a.names || []), ...(a.contextual || [])].map((n) => n.toLowerCase())));
  const taken = new Set(Object.keys(map.aliases));
  const added = [];
  for (const { id, label } of dbAccounts()) {
    if (!label || known.has(label.toLowerCase())) continue;
    const n = String(id).match(/\d+/);
    let alias = 'Lord' + String(n ? n[0] : taken.size + 1).padStart(2, '0');
    for (let i = taken.size + 1; taken.has(alias); i++) alias = 'Lord' + String(i).padStart(2, '0');
    map.aliases[alias] = { id, names: [label] };
    taken.add(alias);
    added.push(`${alias} = ${label} (${id})`);
  }
  let ips = 0;
  for (const h of proxyHosts()) if (!map.redact[h]) { map.redact[h] = '<proxy-ip>'; ips++; }
  saveMap(map);
  console.log(added.length ? 'added:\n  ' + added.join('\n  ') : 'no new accounts');
  console.log(`${ips} new proxy IP(s) to redact; ${Object.keys(map.redact).length} redactions in all`);
}

function list() {
  const map = loadMap();
  const labels = new Map(dbAccounts().map((r) => [r.id, r.label]));
  const rows = Object.entries(map.aliases || {}).sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }));
  if (!rows.length) return console.log('no aliases yet — run: node privacy.js sync');
  for (const [alias, a] of rows) {
    const names = [...(a.names || []), ...(a.contextual || []).map((n) => n + ' (contextual)')].join(', ');
    const now = labels.get(a.id);
    console.log(`${alias.padEnd(8)} ${String(a.id || '').padEnd(4)} ${names}${now && !(a.names || []).includes(now) ? `   [db now: ${now}]` : ''}`);
  }
}

function scrub(dry) {
  const fix = scrubber(loadMap());
  let changed = 0;
  for (const f of repoFiles()) {
    const p = path.join(ROOT, f);
    if (fs.statSync(p).size > MAX_BYTES) continue;
    const before = fs.readFileSync(p, 'utf8');
    if (before.includes('\0')) continue;
    const after = fix(before);
    if (after === before) continue;
    changed++;
    const a = before.split('\n'), b = after.split('\n');
    const n = a.reduce((k, l, i) => k + (l !== b[i] ? 1 : 0), 0);
    console.log(`${dry ? 'would change' : 'changed'} ${f} (${n} line${n === 1 ? '' : 's'})`);
    if (!dry) fs.writeFileSync(p, after);
  }
  console.log(`${changed} file(s) ${dry ? 'would change' : 'changed'}`);
}

function check(staged) {
  const map = loadMap();
  const fix = scrubber(map);
  const secrets = dbSecrets();
  const files = staged
    ? cp.execSync('git diff --cached --name-only --diff-filter=ACMR', { cwd: ROOT }).toString().split('\n').filter((f) => f && TEXT_EXT.test(f) && f !== 'privacy.local.json')
    : repoFiles();
  const read = (f) => staged ? cp.execSync('git show :' + JSON.stringify(f).slice(1, -1), { cwd: ROOT, maxBuffer: 1e8 }).toString() : fs.readFileSync(path.join(ROOT, f), 'utf8');
  const problems = [];
  for (const f of files) {
    let text;
    try { text = read(f); } catch { continue; }
    if (text.length > MAX_BYTES || text.includes('\0')) continue;
    for (const s of secrets) if (text.includes(s.v)) problems.push(`${f}: contains ${s.what}`);
    const after = fix(text);
    if (after !== text) {
      const a = text.split('\n'), b = after.split('\n');
      a.forEach((l, i) => { if (l !== b[i]) problems.push(`${f}:${i + 1}: a real name or redacted string (node privacy.js scrub fixes it)`); });
    }
  }
  if (!problems.length) { console.log(`privacy check: clean (${files.length} files)`); return 0; }
  console.error('privacy check FAILED:\n  ' + problems.slice(0, 200).join('\n  ') + (problems.length > 200 ? `\n  … and ${problems.length - 200} more` : ''));
  return 1;
}

function installHook() {
  const dir = cp.execSync('git rev-parse --git-path hooks', { cwd: ROOT }).toString().trim();
  const hook = path.join(ROOT, dir, 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\n# installed by: node privacy.js install-hook\nexec node privacy.js check --staged\n');
  try { fs.chmodSync(hook, 0o755); } catch {}
  console.log('pre-commit hook installed: ' + hook);
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'list') list();
  else if (cmd === 'sync') sync();
  else if (cmd === 'scrub') scrub(rest.includes('--dry'));
  else if (cmd === 'check') process.exitCode = check(rest.includes('--staged'));
  else if (cmd === 'install-hook') installHook();
  else if (cmd === 'redact') {
    if (!rest[0]) { console.error('usage: node privacy.js redact <text> [<replacement>]'); process.exit(2); }
    const map = loadMap(); map.redact = map.redact || {}; map.redact[rest[0]] = rest[1] || '<redacted>'; saveMap(map);
    console.log('will redact it as ' + map.redact[rest[0]]);
  } else if (cmd === 'filter') {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (buf.includes(0)) return process.stdout.write(buf);
      const text = buf.toString('utf8');
      const out = scrubber(loadMap())(text);
      process.stdout.write(out === text ? buf : out);
    });
  } else { console.error('unknown command: ' + cmd); process.exit(2); }
}

module.exports = { scrubber, loadMap };
