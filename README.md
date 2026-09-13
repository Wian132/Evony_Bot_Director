# Evony Bot + Director

A dependency-free Node client for Evony Age 1 (server `ss71`), replacing NEAT/`bobby.exe`.
Flash was never needed — the game speaks a plain socket protocol.

Two apps and a goal engine:

| | | |
|---|---|---|
| `server.js` | **console**, one per account | per-city goals and scripts, monitors, map, chat |
| `director.js` | **fleet view** over every account | status, resources, items, proxies, uptime graph |
| `goalsd.js` | headless goal daemon | an alternative to running a console |

Everything is headless. The HTML pages are viewers that poll the process — close every
tab and the bots keep running.

## Running it

```bash
cp .env.example .env          # the default console's login
node director.js              # fleet + uptime            -> :8712
CONSOLE_PORT=8711 ACCOUNT_ID=a1 node server.js            -> :8711
CONSOLE_PORT=8713 ACCOUNT_ID=a2 ENGINE_MODE=live node server.js
```

`ENGINE_MODE` is `off` | `plan` | `live`. **Plan mode reports what it would do and
touches nothing** — always the right place to start.

Add an account:

```bash
EVONY_ACCOUNT_EMAIL=... EVONY_ACCOUNT_PASSWORD=... node add-account.js "Label"
```

Requires Node 24+ for the built-in `node:sqlite`. No npm install, no dependencies.

## One process per account

A second login for the same account gets kicked, and the two supervisors then fight and
trip the server's rate limiter. Three guards enforce this, all learned the hard way:

- a console started with `ACCOUNT_ID` is **pinned** — `/?account=<other>` cannot switch it
- a second console for an account already running **refuses to start**
- the Director asks every console who it holds and skips those accounts

## Goals

Declarative end states, re-evaluated every tick, order-independent — the NEAT model.
Scripts are the imperative counterpart. Parsed by `goals.js`, evaluated by `engine.js`.

```
config comfort:1,hero:1,npc:5
build f:10:37
troop b:5k,t:5k
troop a:100k,s:100k
fortification ab:5000
distancepolicy 15
npcteams 3
requestresources any wood 100000 2000000 500000 200000
```

Modules each export `{parsers, plans, executors, configKeys}` and are wired generically:

| module | covers |
|---|---|
| `goal-war.js` | hiding, recalls, gates, defence |
| `goal-heroes.js` | recruiting, levelling, firing, mayors |
| `goal-npc.js` | NPC farming — levels, 8h cycles, camp cooldowns, troop sizing |
| `goal-buildnpc.js` | turning flats into NPC camps (**off by default**, see below) |
| `goalmods.js` | comfort, defence, resource sharing, training heroes, mayors |

## Safety

**`buildnpc` is default-deny.** `city.giveupCastle` is irreversible and takes the account
password, so abandoning is gated on a persistent registry keyed by **fieldId** — cities
teleport (`city.advMoveCastle` keeps the castleId, changes the fieldId), so identity is
resolved by castleId first. `abandonable=1` is reachable only through `claimFlat()` →
`markBuilt()`, and the claim is written *before* the build. Anything that turns up
unrecorded — a capture, a purchase, a hand-built city — is permanently protected however
empty it looks. `test-buildnpc.js` was verified by sabotage: deleting any single guard
clause makes tests fail.

**Maintenance.** The server announces maintenance ~15 minutes ahead on
`server.SystemInfoMsg`. The bot stands down 5 minutes before, sits out the window, then
recovers on a 5-minute ladder — probing with a bare **TCP handshake**, never a login.
Reachability costs a handshake; a login is a scarce, account-scoped resource, and
spending them against a server in maintenance is believed to be what earns a block.

## Storage

One SQLite file, `evony.db` (see `STORAGE.md`). It holds accounts, **snapshot history**,
goals keyed per account, engine state keyed per `(account, city)`, the shared map cache,
uptime samples and the city registry.

`evony.db` is gitignored — it contains every account's password in plain text.

## Tests

```bash
for t in test-war test-heroes test-npc test-enginestate test-buildnpc test-maint; do node $t.js; done
```

304 tests, no network required.

## Not in this repo

- `.env`, `evony.db`, `accounts.json`, `proxies.txt` — credentials
- `src/` — the decompiled 1922 client. It is the authority for every command and field
  name, but it is someone else's copyrighted code.
- `ffdec/`, `*.pcap`, `payloads*.txt` — tooling and captures
