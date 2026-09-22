'use strict';
// Which proxy each account logs in through. An account's `proxy` field is one of:
//
//   ''        direct — this PC's own IP
//   'random'  a proxy picked at random from the organization's list, and kept
//   '<line>'  that line of the list (or any proxy line), pinned
//
// "Random" is the default for a new account. Its pick is random but sticky: it is
// kept in the org's settings as proxyPick:<accountId> and used for every login
// until it stops being a good pick — the line leaves the list, it fails a test
// (Director → Proxies → Test all), or another account is pinned to it. Then a new
// one is picked. Changing IP on every login would look nothing like a player, and
// EVONY-RULES §1 says one proxy per account: two accounts on one proxy both lost
// their logins on 2026-09-22. So a pick is always a line no other account uses,
// one that passed its last test when there is one, else an untested one; a
// failed line is never picked while any other is left.
//
// The Director and every console call this. The Director resolves the whole fleet
// on every page refresh, so a console normally finds its pick already made; one
// running without the Director makes it itself. Two consoles picking the same line
// at the same moment is settled on the next call: the account later in the sort
// order gives it up and picks again.
const fs = require('fs');
const path = require('path');
const { parseList, parseProxy } = require('./proxy');

const RANDOM = 'random';
const PROXY_FILE = path.join(__dirname, 'proxies.txt');
const pickKey = (accountId) => `proxyPick:${accountId}`;
const isRandom = (v) => String(v == null ? '' : v).trim().toLowerCase() === RANDOM;

// A console that spends ten minutes logging in without getting in — or getting in
// and being dropped again seconds later — moves its account to another line by
// itself (session.js rotateProxyIfStuck, the user 2026-09-22). That move is kept
// HERE, as proxyOverride:<accountId> = { raw, was, at, why }, and not by rewriting
// the account's `proxy` field: the pin is the user's and must survive. An override
// outranks a pin and a random pick, counts as a pin when the lines are shared out,
// and is dropped the moment its line leaves the list, fails a test, or the user
// saves a proxy for that account themselves.
const overrideKey = (accountId) => `proxyOverride:${accountId}`;
// The line it was moved OFF is left alone for that account for a while, or the next
// pick hands it straight back.
const avoidKey = (accountId) => `proxyAvoid:${accountId}`;
const AVOID_MS = 6 * 3600 * 1000;

// { raw: whenItWasLeft } for one account, without the entries that have aged out.
function avoidOf(org, accountId) {
  const now = Date.now();
  const kept = {};
  const was = org.settings.get(avoidKey(accountId), {}) || {};
  for (const [raw, at] of Object.entries(was)) if (now - Number(at || 0) < AVOID_MS) kept[raw] = Number(at);
  return kept;
}

// The override for one account, as a parsed proxy, or null. `byRaw` is the list it
// must still be in; a line that has gone, or that failed its last test, ends it.
function overrideOf(org, accountId, byRaw, tests, note = () => {}) {
  const ov = org.settings.get(overrideKey(accountId), null);
  if (!ov || !ov.raw) return null;
  const p = byRaw.get(ov.raw);
  const dead = !p ? 'it is no longer in the list'
    : (tests[ov.raw] && tests[ov.raw].ok === false ? 'it failed its last test' : null);
  if (dead) {
    org.settings.set(overrideKey(accountId), null);
    note(`${accountId}: the proxy its console moved it to is dropped — ${dead}`);
    return null;
  }
  return p;
}

// The organization's proxy list, as text. Proxies belong to an organization: one
// tenant's IP budget is not another's. proxies.txt is imported once, the first time.
function proxyText(org) {
  let t = org.settings.get('proxyText', null);
  if (t === null && fs.existsSync(PROXY_FILE)) {
    t = fs.readFileSync(PROXY_FILE, 'utf8');
    org.settings.set('proxyText', t);
  }
  return t || '';
}
const loadProxies = (org) => parseList(proxyText(org));

// One line for an account that needs a pick. `used` counts the accounts already on
// each line. Free and passed first, then free and untested; with nothing free, the
// least-used line that has not failed, and only then a failed one.
// `avoid` holds the lines this account has just been moved off: skipped while
// anything else is left, so a rotation is a real change.
function choose(lines, used, tests, rand, avoid = {}) {
  const failed = (p) => !!(tests[p.raw] && tests[p.raw].ok === false);
  const passed = (p) => !!(tests[p.raw] && tests[p.raw].ok);
  const wanted = lines.filter((p) => !avoid[p.raw]);
  if (wanted.length) lines = wanted;
  const free = lines.filter((p) => !used.has(p.raw));
  const tiers = [free.filter(passed), free.filter((p) => !failed(p))];
  const least = (ps) => { if (!ps.length) return []; const m = Math.min(...ps.map((p) => used.get(p.raw) || 0)); return ps.filter((p) => (used.get(p.raw) || 0) === m); };
  tiers.push(least(lines.filter((p) => !failed(p))), least(lines));
  const pool = tiers.find((t) => t.length);
  return pool ? pool[Math.floor(rand() * pool.length) % pool.length] : null;
}

// Every account of the org -> the proxy it logs in through (parsed) or null for
// direct. Makes and keeps the random picks; says so through `note` when one changes.
function assignAll(org, { note = () => {}, rand = Math.random } = {}) {
  const lines = loadProxies(org);
  const byRaw = new Map(lines.map((p) => [p.raw, p]));
  const tests = org.settings.get('proxyTests', {}) || {};
  const accts = org.accounts.all();
  const out = new Map();
  const used = new Map();
  const use = (raw) => used.set(raw, (used.get(raw) || 0) + 1);

  // a console's own move first, then pins: both are fixed lines, and a move is where
  // the account really logs in from until the user says otherwise
  for (const a of accts) {
    const ov = overrideOf(org, a.id, byRaw, tests, note);
    if (!ov) continue;
    out.set(a.id, ov);
    use(ov.raw);
  }
  // pinned accounts next: a pin always wins over a random pick
  for (const a of accts) {
    if (out.has(a.id)) continue;
    if (!a.proxy || isRandom(a.proxy)) continue;
    const p = parseProxy(a.proxy);
    out.set(a.id, p || null);
    if (p) use(p.raw);
  }
  // random accounts keep a pick that still stands, in sort order
  const need = [];
  for (const a of accts) {
    if (out.has(a.id)) continue;
    if (!isRandom(a.proxy)) continue;
    const raw = org.settings.get(pickKey(a.id), null);
    const p = raw ? byRaw.get(raw) : null;
    let why = null;
    if (raw && !p) why = 'no longer in the list';
    else if (p && tests[raw] && tests[raw].ok === false) why = 'it failed its last test';
    else if (p && used.has(raw)) why = 'another account is on it';
    if (p && !why) { out.set(a.id, p); use(raw); } else need.push({ a, was: raw, why });
  }
  for (const { a, was, why } of need) {
    const p = choose(lines, used, tests, rand);
    const now = p ? p.raw : null;
    if (now !== was) {
      org.settings.set(pickKey(a.id), now);
      const wasLabel = was ? ((parseProxy(was) || {}).label || was) : null;
      if (p) note(`${a.label}: random proxy ${p.label}${wasLabel ? ` in place of ${wasLabel} (${why})` : ''} — from its next login`);
      else note(`${a.label}: random proxy, but the proxy list is empty — it logs in direct`);
    }
    out.set(a.id, p);
    if (p) use(p.raw);
  }
  for (const a of accts) if (!out.has(a.id)) out.set(a.id, null);
  return out;
}

// The proxy one account logs in through, or null for direct. `acc` is the account
// record; a random account needs the org to find, or make, its pick. A line its own
// console moved it to comes first, pin or no pin.
function forAccount(org, acc, opts) {
  if (!acc) return null;
  if (org) {
    const byRaw = new Map(loadProxies(org).map((p) => [p.raw, p]));
    const tests = org.settings.get('proxyTests', {}) || {};
    const ov = overrideOf(org, acc.id, byRaw, tests, (opts && opts.note) || (() => {}));
    if (ov) return ov;
  }
  if (!acc.proxy) return null;
  if (!isRandom(acc.proxy)) return parseProxy(acc.proxy);
  if (!org) return null;
  return assignAll(org, opts).get(acc.id) || null;
}

// Move an account to another line, because the one it is on is not getting it in.
// The line it leaves is remembered so it is not handed straight back, and the new one
// is free of every other account, exactly as a random pick is (EVONY-RULES §1: one
// proxy per account). Returns the new proxy, or null when there is nothing to move to
// — then the caller carries on where it is, because no proxy at all is worse than a
// poor one.
function rotate(org, acc, { note = () => {}, rand = Math.random, why = null } = {}) {
  if (!org || !acc) return null;
  const name = acc.label || acc.id;
  if (!acc.proxy && !org.settings.get(overrideKey(acc.id), null)) {
    note(`${name}: it logs in direct, so there is no proxy to change`);
    return null;
  }
  const lines = loadProxies(org);
  if (!lines.length) { note(`${name}: the proxy list is empty — nothing to move to`); return null; }

  const current = forAccount(org, acc);
  const avoid = avoidOf(org, acc.id);
  if (current) avoid[current.raw] = Date.now();
  org.settings.set(avoidKey(acc.id), avoid);

  // who is on what right now, this account left out
  const used = new Map();
  for (const [id, p] of assignAll(org, { rand })) {
    if (!p || id === acc.id) continue;
    used.set(p.raw, (used.get(p.raw) || 0) + 1);
  }
  // Only lines NO other account is on: choose() would otherwise double up rather
  // than come back empty, and two accounts on one proxy lose both their logins
  // (EVONY-RULES §1, 2026-09-22). Nowhere to go is a reason to stay, not to share.
  const tests = org.settings.get('proxyTests', {}) || {};
  const p = choose(lines.filter((l) => !used.has(l.raw)), used, tests, rand, avoid);
  if (!p || (current && p.raw === current.raw)) {
    note(`${name}: no other proxy line is free — staying on ${current ? current.label : 'direct'}`);
    return null;
  }
  org.settings.set(overrideKey(acc.id), { raw: p.raw, was: current ? current.raw : null, at: Date.now(), why: why || null });
  // a random account's kept pick moves with it, so the two never disagree
  if (isRandom(acc.proxy)) org.settings.set(pickKey(acc.id), p.raw);
  note(`${name}: moved to ${p.label}${current ? ` off ${current.label}` : ''}${why ? ` — ${why}` : ''}`);
  return p;
}

// Back to whatever the account itself says (the user saved a proxy for it, or asked).
function clearOverride(org, accountId) {
  if (!org) return null;
  const had = org.settings.get(overrideKey(accountId), null);
  if (!had) return null;
  org.settings.set(overrideKey(accountId), null);
  return had;
}

module.exports = { RANDOM, isRandom, pickKey, overrideKey, avoidKey, AVOID_MS, proxyText, loadProxies,
  choose, assignAll, forAccount, rotate, clearOverride, avoidOf, PROXY_FILE };
