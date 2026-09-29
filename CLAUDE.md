# OTTObot — notes for Claude

A bot and fleet console for the live game Evony Age 1, in dependency-free Node.js.
README.md is the overview and setup, MANUAL.md explains the apps in depth, SCRIPTS.md the
script language, STORAGE.md the database.

**If a `CLAUDE.local.md` exists, read it too** — it is this install's own notes (its
fleet, its machine, its habits) and is kept out of git. **Read it before touching the
fleet:** the live fleet may run on another machine (a server reached over SSH), in which
case this folder's `evony.db`, `scripts/` and goal files are stale copies and nothing
fleet-related may be started here.

## Setup, if it is not done yet

- **Node 24+** is the only requirement (`node --version`). The database is the built-in
  `node:sqlite`; there is no `package.json` and nothing to `npm install`. If `node:sqlite`
  is missing, Node is too old — upgrade Node, don't add an npm SQLite package.
- The `sqlite3` CLI is optional, for reading `evony.db` by hand
  (`winget install SQLite.SQLite` / `brew install sqlite` / `apt install sqlite3`).
- First run: `cp .env.example .env`, then
  `OTTO_PASSWORD=… node migrate-tenancy.js <email> "<fleet name>"`, then `node director.js`
  (:8712) and add accounts there. README.md has the details.
- **Servers are per account.** Each account row has its own `server` (`ss1`, `ss71`, …);
  never assume one. `EVONY_SERVER` in `.env` is only a default, and code that finds no
  server falls back to `ss71` — when you touch such a fallback, prefer the account's own.

## Where things are

Everything is flat at the repo root.

| | |
|---|---|
| `amf0.js`, `amf3.js`, `evony.js`, `game.js` | the wire protocol and the game client (socket, commands, replies) |
| `session.js` | one logged-in account: login, reconnect, kick hold, proxies, maintenance |
| `server.js` | the **console** (one per account, HTTP + page `public/app.html`) |
| `director.js`, `botctl.js`, `console-proxy.js` | the **Director** (fleet view, `public/director.html`), console start/stop, and `/console/<id>/` (a console through the Director, for remote use) |
| `engine.js`, `goals.js`, `goal-*.js`, `goalmods.js`, `goallayers.js` | the goal engine: parse goal lines, plan per city, act |
| `script*.js`, `script-cmd-*.js` | the script language: parser, expressions, one file per command family |
| `monitor.js`, `statistics.js`, `mapscan.js` | the server-wide watcher, rankings, map |
| `db.js`, `tenancy.js`, `auth.js` | SQLite storage, org scoping, Director login |
| `test-*.js` | tests, one suite per file, no framework |
| `probe*.js`, `*-probe.js`, `bench*.js`, `migrate-*.js` | one-off tools and migrations |

The decompiled game client (`src/`, gitignored, not always present) is the authority for
command and field names when it exists. Otherwise EVONY-RULES.md and the existing code are.

## Never do these

- **Never log an account in twice.** A second login kicks whatever holds the account — a
  running console, or the owner playing by hand. Before anything that logs in (a probe, a
  live test, a new console) check the Director / `node botctl.js list` for one that already
  holds it, and ask.
- **Never `require('./server')`** (or `director`) from a test or a helper script: it starts a
  real console and logs in. Use `node --check server.js` to check syntax.
- **Never run `test-*.js` as a glob.** Run suites by name with a throwaway database:
  `EVONY_DB=/tmp/x.db node test-goals.js`. Some suites open `evony.db` unless `EVONY_DB` is
  set. `test-login`, `test-scope`, `test-raw`, `test-block`, `test-buy`, `test-wall`,
  `test-clean`, `test-castle`, `test-ctx`, `test-shapes`, `test-lookup` log in to the live
  game — only run them when asked.
- **Never restart a running console or the Director without asking.** They are the live
  bots; a restart logs every account out and back in.
- **Never write a real in-game name, login email, password, security code, home or proxy IP
  into a tracked file** — see Privacy.
- **Never commit `evony.db`, `.env`, proxy lists, logs or `privacy.local.json`.**

## Read EVONY-RULES.md before touching the live game

**Read [EVONY-RULES.md](EVONY-RULES.md) first when a request would act on the real game** —
starting, stopping or editing a running script (trading, marches, anything), placing or
cancelling market orders, logging an account in, starting, stopping or restarting a console
or the Director, switching an account on or off, changing its proxy, running a test file
that might log in, using or buying items. It holds what has been learned about how Evony
behaves and how a fleet breaks, so the same costly mistakes aren't made twice: a second
login kicking a console, logging in during maintenance, a rate-limited account, a hero lost
to `release`, gold spent from stale balances.

Pure code work (editing files, offline tests) doesn't need it — until the change is about
to go live.

[EVONY-STRATEGY.md](EVONY-STRATEGY.md) is one fleet's play — roles (alts, dump, builders,
banks), insta heroes, the amulet farm. Read it when a request names a role or a plan and
the reason behind it isn't obvious.

## Say when an endpoint would have helped

The fleet has its own tool API (`otto-mcp.js`, registered in `.mcp.json`: `fleet`, `state`,
`log`, `events`, `wait`, `cmd`, `script`, `script_stop`, `script_runs`, `act`). It is meant
to grow as the work exposes gaps.

**So, as you work, notice the moment you think "an endpoint for this would have saved me"**
— and say so, there and then, in your reply to the user. Do not save it for the end and do
not quietly work around it. The moments worth catching are:

- you are parsing a console log, or reading `account_latest`, to get a fact the game knows
- you are polling in a loop instead of waiting on an event
- you hit a failure that a pre-flight check would have caught before anything was sent
- you are running the same one-off script across many cities to gather one number
- you discovered a limit (a march cap, a hero filter, a truce) only from a refusal

Write the suggestion as **what you were trying to do and what went wrong without it**, not
as an API design. The user decides what gets built. (The user, 2026-09-28: *"Is there
enhancements you would like to make to the API to further enable you? ... as we work so we
enhance it as we go along"*.)

## Keep EVONY-RULES.md current

**Every lesson, as soon as it is learned — not at the end.** Whenever something goes
wrong, surprises you, or the user corrects or teaches you something about the game or the
fleet, write it down before moving on: into EVONY-RULES.md (how the game behaves, what must
never happen), and into the skill for that kind of task (`.claude/skills/…`) when there is
one — or a new skill when the same kind of task will come again. Say in your reply what you
recorded.

Add it in the right section, with the date and how it was observed. Mark inferences as
*unverified*. Correct or remove entries that turn out to be wrong. Code documentation
belongs in MANUAL.md and SCRIPTS.md, not there.

## Privacy: accounts are aliases

Tracked files name accounts by **alias** — `Lord01`, `Lord02` … — usually beside the
account id (`a2 Lord02`). The real in-game names live only in `privacy.local.json`
(gitignored). To see who is who: `node privacy.js`. The database and the web pages show the
real names; only the repo's files don't.

- Writing about an account in a doc, test, skill or comment: use its alias (and id).
- A new account: `node privacy.js sync` gives it the next alias.
- Before committing: `node privacy.js check` (the pre-commit hook runs it on staged files
  once `node privacy.js install-hook` has been run). If it fails, `node privacy.js scrub`
  fixes names and redacted strings; a password, email or security code must be removed
  by hand.
- Code must not hard-code account names: look labels up from the `accounts` table by id.

## Style

Match the surrounding code: CommonJS, `'use strict'`, no dependencies, comments that say
*why* in plain prose with the date and the evidence when they record something learned
live. Tests are plain `assert` suites run with `node test-x.js`.
