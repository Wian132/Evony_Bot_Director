# OTTObot

Multi-tenant fleet control for Evony Age 1. A dependency-free Node client replacing
NEAT/`bobby.exe` — Flash was never needed, the game speaks a plain socket protocol.

Sign up, get your own organization, and run your bots. Nobody else can see them.

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

## Organizations

Every user belongs to one or more organizations, and **all customer data is scoped to
one**: game accounts, goals, snapshots, engine state, the city registry, proxies, probes
and uptime. The org comes from the signed-in session, never from a request parameter.

The risk being defended against is one missing `WHERE orgId = ?` — the `accounts` table
holds other people's game logins in plain text, so a leak there is a breach, not a bug.
So the defence is structural: callers never get an unscoped handle. They call `D.org(id)`,
which closes over the org and applies it to every read and write, and anything reached by
account id is checked for ownership first — an id guessed or leaked from elsewhere simply
does not resolve. `test-tenancy.js` covers that from both directions.

The **map cache is deliberately shared**. It describes the game world, not a customer, and
every tenant scanning it makes it better for everyone. The one piece of tenant data that
used to live there — "is this city mine" — is computed at read time instead.

First run:

```bash
OTTO_PASSWORD='...' node migrate-tenancy.js you@example.com "Your Fleet"
```

That creates your user, your org, and moves any existing single-operator data into it.
Registration is closed by default; `ALLOW_SIGNUP=1` opens it.

## Running it on a server

It is portable — the only Windows-specific thing was the NEAT process scan, which
now short-circuits off Windows. Node 24+ is the only requirement.

**Binding to anything but loopback requires at least one registered user**, because
otherwise the first stranger to find the port becomes the operator:

```
REFUSING TO BIND 0.0.0.0: no users exist yet.
```

Passwords are scrypt-hashed with `timingSafeEqual`. Sessions are 32 random bytes,
httpOnly + SameSite=Strict, 12h expiry, revocable per user. Failed logins back off
exponentially per IP, and a wrong password and an unknown email return the *same*
message so the form cannot be used to discover who has an account here.

**Put TLS in front of it.** The login cookie is only marked `Secure` when a proxy sets
`X-Forwarded-Proto: https`. Over plain HTTP on the open internet the password and cookie
travel in clear text. Terminate TLS at Caddy or nginx, or reach it through an SSH tunnel
(`ssh -L 8712:localhost:8712 host`) and leave it bound to loopback — the tunnel needs no
password at all and exposes nothing.

## Storage

One SQLite file, `evony.db` (see `STORAGE.md`). It holds accounts, **snapshot history**,
goals keyed per account, engine state keyed per `(account, city)`, the shared map cache,
uptime samples and the city registry.

`evony.db` is gitignored — it contains every account's password in plain text.

## Tests

```bash
for t in test-war test-heroes test-npc test-enginestate test-buildnpc test-maint test-auth test-tenancy; do node $t.js; done
```

349 tests, no network required.

## Not in this repo

- `.env`, `evony.db`, `accounts.json`, `proxies.txt` — credentials
- `src/` — the decompiled 1922 client. It is the authority for every command and field
  name, but it is someone else's copyrighted code.
- `ffdec/`, `*.pcap`, `payloads*.txt` — tooling and captures
