# OTTObot

A bot and fleet console for **Evony Age 1** (the classic Flash-era game), written in plain
Node.js with no dependencies. The game speaks a socket protocol (AMF3 over TCP), so the bot
talks to it directly — no Flash, no browser, no game client.

- **Console** (`server.js`) — one process per game account: per-city goals, a NEAT-compatible
  script language, map, chat, reports. A web page to watch and drive it.
- **Director** (`director.js`) — the fleet view over every account: status, resources, items,
  proxies, uptime, trading. Starts and stops the consoles.
- **Goal daemon** (`goalsd.js`) — runs the goal engine headless, instead of a console.
- **Monitor** (`monitor.js`) — one watcher per game server: the whole map, the rankings, and
  who has stopped playing. It never logs in itself.

Everything is headless. The HTML pages in `public/` only view and drive the processes —
close every tab and the bots keep running.

> Using a bot breaks Evony's terms of service. Accounts can be banned. Use it at your own risk.

## Requirements

| | |
|---|---|
| **Node.js 24+** | The only hard requirement. The database is `node:sqlite`, which is built into Node (unflagged from 22.13 / 23.4; 24 is what it is developed on). There is **no `npm install`** — the code uses Node's standard library only. |
| **Git** | To clone it; a few tests also read older versions of files from git history. |
| `sqlite3` CLI *(optional)* | Only to look inside `evony.db` by hand. Windows: `winget install SQLite.SQLite` · macOS: `brew install sqlite` · Debian/Ubuntu: `sudo apt install sqlite3`. |
| A proxy per account *(optional)* | Recommended for a fleet: each account on its own IP. See MANUAL.md → Proxies. |

It runs on Windows, macOS and Linux. It grew up on Windows, so a handful of one-off helper
scripts still have a `C:/EvonyTool` path in them (see CLAUDE.md); the apps themselves do not.

## Getting started

```bash
git clone <this repo> otto && cd otto
node --version                       # must be 24 or newer

cp .env.example .env                 # the default console's login and server
OTTO_PASSWORD='choose-one' node migrate-tenancy.js you@example.com "My Fleet"
                                     # first run: your Director login + organization
node director.js                     # the Director -> http://localhost:8712
```

Sign in to the Director, then **Add account** for each game account: its label, login,
**server** and proxy. The Director starts that account's console for you. By hand:

```bash
node botctl.js start a1              # start (or adopt) the console for account a1
node botctl.js list                  # which accounts have a console, and on which port
CONSOLE_PORT=8711 ACCOUNT_ID=a1 node server.js     # or run one console directly
```

`evony.db` (created on first run) holds every account's password in plain text. It is
gitignored — keep it that way, and keep the Director on localhost or behind TLS
(MANUAL.md → Running it on a server).

### Servers

Evony Age 1 has many servers (`ss1`, `ss71`, …). **Every account carries its own `server`**
and one Director can run accounts on several. `EVONY_SERVER` in `.env` is only the default
for the console started from `.env`. Where an account has no server set, the code still
falls back to `ss71` (the server it was built on), so always set it.

## Documentation

| File | What it covers |
|---|---|
| [MANUAL.md](MANUAL.md) | The apps in depth: consoles, Director tabs, goals, safety, tenancy, tests |
| [SCRIPTS.md](SCRIPTS.md) | The script language (NEAT-compatible) and every command |
| [STORAGE.md](STORAGE.md) | What is in `evony.db`, table by table |
| [EVONY-RULES.md](EVONY-RULES.md) | How the live game behaves, learned the hard way: logins, kicks, maintenance, rate limits, market, heroes. **Read before acting on real accounts.** |
| [EVONY-STRATEGY.md](EVONY-STRATEGY.md) | One fleet's play, as a worked example of what the tool is for |
| [CLAUDE.md](CLAUDE.md) | Orientation for AI coding agents (Claude Code and similar) |

Account names in these files are aliases (`Lord01`, `Lord02` …) — see *Privacy* below.

## Tests

Run the offline suites **by name**, each against a throwaway database:

```bash
EVONY_DB=/tmp/t.db node test-goals.js
```

The full list is in MANUAL.md → Tests. **Never run `test-*.js` as a glob**: a few of them
(`test-login`, `test-scope`, `test-raw`, `test-block`, `test-buy`, `test-wall`, `test-clean`,
`test-castle`, `test-ctx`, `test-shapes`, `test-lookup`) log in to the live game with the
account in `.env`, and a second login kicks whatever console holds that account.

## Privacy

The docs and tests talk about real accounts, but tracked files never carry their in-game
names. Each account gets a stable alias, and the map from alias to real name lives in
`privacy.local.json`, which is gitignored. `privacy.js` builds and enforces it:

```bash
node privacy.js sync            # alias every account in evony.db, redact its proxy IPs
node privacy.js                 # the alias table
node privacy.js redact 203.0.113.9 "<home-ip>"     # always redact a string
node privacy.js scrub           # replace real names/redactions in the repo's files
node privacy.js install-hook    # refuse any commit that carries a real name, a redacted
                                # string, or an account's password, email or security code
```

## Not in this repo

- `.env`, `evony.db`, `accounts.json`, proxy lists — credentials
- `privacy.local.json`, `CLAUDE.local.md` — an install's own names and notes
- `scripts/`, goal backups — an install's own scripts and goal files
- `src/`, `ffdec/`, `*.swf` — the decompiled game client: the authority for command and
  field names, but someone else's copyrighted code
- `*.pcap`, logs — captures and console output
