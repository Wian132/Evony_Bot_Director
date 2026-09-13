'use strict';
// Move a single-operator install into the multi-tenant model: everything that
// exists becomes one organization, owned by you.
//
//   node migrate-tenancy.js you@example.com "Your Fleet"
//
// Idempotent — rows already carrying an orgId are left alone.
const D = require('./db');
const AUTH = require('./auth');

const email = process.argv[2];
const orgName = process.argv[3] || 'My Fleet';
const password = process.env.OTTO_PASSWORD;

if (!email) {
  console.error('usage: OTTO_PASSWORD=... node migrate-tenancy.js <email> ["Org name"]');
  process.exit(1);
}

let user = D.users.byEmail(email);
let org;

if (user) {
  org = D.users.orgsOf(user.id)[0];
  console.log(`  existing user ${user.email}, org ${org ? org.name : '(none)'}`);
} else {
  if (!password) { console.error('  OTTO_PASSWORD is required to create the first user'); process.exit(1); }
  const r = AUTH.register({ email, password, orgName });
  if (!r.ok) { console.error('  ' + r.error); process.exit(1); }
  user = r.user; org = r.org;
  console.log(`  created ${user.email} and org "${org.name}"`);
}
if (!org) { console.error('  that user is not in any organization'); process.exit(1); }

// Anything still unassigned belongs to this first org.
const claims = [
  ['accounts', "orgId = '' OR orgId IS NULL"],
  ['uptime', "orgId = '' OR orgId IS NULL"],
  ['player_snapshots', "orgId = '' OR orgId IS NULL"],
  ['settings', "orgId = '' OR orgId IS NULL"],
];
for (const [table, where] of claims) {
  const before = D.one(`SELECT count(*) c FROM ${table} WHERE ${where}`).c;
  if (before) D.run(`UPDATE ${table} SET orgId = ? WHERE ${where}`, org.id);
  console.log(`  ${table}: ${before} row(s) -> ${org.name}`);
}

// Settings that were global but are really per-tenant, and one that is obsolete.
D.run("DELETE FROM settings WHERE k IN ('authHash','authSessions')");

const o = D.org(org.id);
console.log(`\n  ${org.name} now owns: ${o.accounts.all().map((a) => a.label).join(', ') || '(no accounts)'}`);
console.log(`  sign in at /login as ${user.email}\n`);
