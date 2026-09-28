'use strict';
// What Claude may do to an account on its own (2026-09-28).
//
// When the Director wakes Claude for an attack (claude-wake.js), Claude reaches
// the game only through the otto MCP server in its "auto" scope, and there the
// one acting route is POST /api/claude/act on the account's console. That route
// asks this file whether the command is allowed: each account carries six
// switches, all OFF until the user ticks them — on the console's Settings ->
// Claude permissions tab or the Director's Claude tab. Everything a command
// does that is not one of the six is refused in auto scope (permFor -> null).
//
// Storage: one settings row per account, `claudePerms:<accountId>`, on the
// organization that owns the account (org(id).settings; install-wide settings
// for an account with no org). The Director and every console open the same
// evony.db (or EVONY_DB) through db.js, so a tick in either is read by the
// other on its next call — nothing is cached here.
//
// Holiday is the user's alone (EVONY-RULES.md section 1). Ticking the holiday
// box is the user choosing to let Claude put THAT account on holiday under
// attack; even then `holiday /exit` (which ends one) and `/autoextend` (which
// spends coins renewing it) are never Claude's — permFor returns null for them,
// so no switch can allow them.

const PERMS = ['gate', 'troops', 'teleport', 'truce', 'dreamtruce', 'holiday'];
const LABELS = {
  gate: 'Control gate',
  troops: 'Move troops in/out',
  teleport: 'Teleport city',
  truce: 'Use Truce Agreement',
  dreamtruce: 'Use Dream Truce (item)',
  holiday: 'Holiday account',
};
// what each one lets through, for the settings pages
const HELP = {
  gate: 'gate open / close / auto',
  troops: 'recall, recallall, reinforce, evacuatetown, dumptroop',
  teleport: 'teleport, warteleport',
  truce: 'truce (a Truce Agreement)',
  dreamtruce: 'dreamtruce (the timed Dream Truce item)',
  holiday: 'holiday <days> confirm — never holiday /exit or /autoextend',
};
const KEY = (id) => 'claudePerms:' + String(id);

// Where an account's row lives: its org's settings, else the install-wide ones.
// `D` is db.js, or a stand-in with the same { one, org, settings } surface.
function storeFor(D, accountId) {
  let orgId = null;
  try { const r = D.one('SELECT orgId FROM accounts WHERE id = ?', String(accountId)); orgId = r && r.orgId; } catch { orgId = null; }
  if (orgId) { try { return D.org(orgId).settings; } catch { /* fall through */ } }
  return D.settings;
}

function make(getD) {
  const empty = () => Object.fromEntries(PERMS.map((p) => [p, false]));

  // { gate: false, troops: false, ... } — every one false unless ticked
  function get(accountId) {
    const out = empty();
    if (!accountId) return out;
    let row = null;
    try { row = storeFor(getD(), accountId).get(KEY(accountId), null); } catch { row = null; }
    if (row && typeof row === 'object') for (const p of PERMS) out[p] = row[p] === true;
    return out;
  }

  // Merge { perm: bool } into the account's row; unknown keys are ignored.
  function set(accountId, patch) {
    if (!accountId) throw new Error('claude-perms: an account id is required');
    const next = get(accountId);
    for (const [k, v] of Object.entries(patch || {})) if (PERMS.includes(k)) next[k] = v === true || v === 1 || v === 'true' || v === 'on';
    storeFor(getD(), accountId).set(KEY(accountId), next);
    return next;
  }

  const allowed = (accountId, perm) => PERMS.includes(perm) && get(accountId)[perm] === true;

  // { accountId: perms } for a list of ids
  const all = (ids) => Object.fromEntries((ids || []).map((id) => [id, get(id)]));

  return { get, set, allowed, all };
}

// Which switch a console command needs, or null when it is none of the six
// (and so refused in auto scope). The command is the text as typed on the
// console or in a script line: the first word is the command.
//
//   gate open|close(d)|auto            gate
//   recall, recallall, reinforce,
//   evacuatetown, dumptroop            troops
//   teleport, warteleport              teleport
//   truce                              truce
//   dreamtruce                         dreamtruce — including `dreamtruce /cancel`:
//                                      cancelling one only takes protection AWAY,
//                                      but it is the same item's own switch, and a
//                                      cancel is as much a decision about that
//                                      account's cover as a use (chosen 2026-09-28)
//   holiday <days> ... confirm         holiday — never with /exit (ends a holiday)
//                                      or /autoextend (spends coins renewing it)
function permFor(commandText) {
  const s = String(commandText || '').trim().replace(/^command\s+"(.*)"$/i, '$1').trim();
  if (!s) return null;
  const words = s.split(/\s+/);
  const cmd = words[0].toLowerCase();
  const rest = words.slice(1).map((w) => w.toLowerCase());
  switch (cmd) {
    case 'gate': return ['open', 'close', 'closed', 'auto'].includes(rest[0]) ? 'gate' : null;
    case 'recall': case 'recallall': case 'reinforce': case 'evacuatetown': case 'dumptroop': return 'troops';
    case 'teleport': case 'warteleport': return 'teleport';
    case 'truce': return 'truce';
    case 'dreamtruce': return 'dreamtruce';
    case 'holiday': {
      if (rest.some((w) => w === '/exit' || w.startsWith('/autoextend'))) return null;
      if (!rest.includes('confirm')) return null;
      return /^\d+(\.\d+)?$/.test(rest[0] || '') ? 'holiday' : null;
    }
    default: return null;
  }
}

const api = make(() => require('./db'));
module.exports = { PERMS, LABELS, HELP, KEY, permFor, ...api, make };
