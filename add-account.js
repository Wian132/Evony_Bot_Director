'use strict';
// Add or update an account, and give it a starting set of goals.
//
//   EVONY_ACCOUNT_EMAIL=you@example.com EVONY_ACCOUNT_PASSWORD=... \
//   node add-account.js "Label" [server]
//
// Credentials come from the environment, never from this file — it is committed.
const D = require('./db');
const { parseGoals, describe } = require('./goals');

const label = process.argv[2];
const server = process.argv[3] || 'ss71';
const email = process.env.EVONY_ACCOUNT_EMAIL;
const password = process.env.EVONY_ACCOUNT_PASSWORD;

if (!label || !email || !password) {
  console.error('usage: EVONY_ACCOUNT_EMAIL=... EVONY_ACCOUNT_PASSWORD=... node add-account.js "<label>" [server]');
  process.exit(1);
}

// A reasonable starting ladder: ballista and transports first (NPC farming rides
// on exactly those two), then a broad base, then archers and scouts.
const GOALS = `// ${label}
config comfort:1,hero:1,troopsusepopmax:1
comfortpolicy 15 16 popraise
defensepolicy /usetruce:79 /usespeech:2 /junktroop:5000 /usewarhorn:1 /usecorselet:1 /usepenicillin:1

// Farms only. Adding s:0:0,i:0:0,q:0:0 would DEMOLISH every sawmill, ironmine
// and quarry — right for a city being built from nothing, ruinous on a
// developed account, and demolition cannot be undone.
build f:10:37

troop b:5k,t:5k
troop wo:10k,w:10k,s:10k,p:10k,sw:10k,a:10k,t:10k,c:10k,cata:10k,b:10k
troop a:100k,s:100k

fortification ab:5000

// NPC farming, level 5 only. config npc:<n> sets the LOWEST level and the
// engine works downwards from 10, but levels 6-10 are refused outright without
// an "npclimits <level> ..." line — so only level 5 can march.
distancepolicy 15
npcteams 3`;

const parsed = parseGoals(GOALS);
if (parsed.errors.length) {
  console.error('the starting goals did not parse:');
  for (const e of parsed.errors) console.error('  ' + (e.message || JSON.stringify(e)));
  process.exit(1);
}

const existing = D.accounts.byEmail(email) || {};
const saved = D.accounts.upsert({ id: existing.id, label, server, email, password, enabled: true });
if (!D.goals.find(saved.id, ['default'], 'goal')) D.goals.set(saved.id, 'default', 'goal', GOALS);

console.log(`\n${saved.id} = ${saved.label} <${saved.email}> on ${saved.server}\n`);
console.log(describe(parseGoals(D.goals.find(saved.id, ['default'], 'goal').src)).map((l) => '  ' + l).join('\n'));
console.log(`\nRun its console with:  CONSOLE_PORT=<port> ACCOUNT_ID=${saved.id} node server.js\n`);
