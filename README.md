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
CONSOLE_PORT=8713 ACCOUNT_ID=a2 node server.js
```

**The console's engine is always live** — from the moment it connects it acts on every
city's goals, once a minute. The pause button is how you stop it; a restart resumes it.

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

## The console

Laid out like NEAT: header counters (packages, reports, mail, coins, prestige, honor,
server time), city tabs, and one icon per panel. A city tab turns red when armies are
inbound, amber when its food runs out within a day, and gets a `*` when a manual
control is in force. The tab of the city holding the hero a `traininghero` goal names
is always green, with a dashed border while that hero is marching.

The row above the editor holds two **manual controls, kept per city, that outrank the
goals** until set back to Auto:

- **Gate Control** — Open/Closed goes to the server at once, then the engine holds it
  every tick, even in a city with no goals. Auto hands the gate back to
  `config gate:` + `gatepolicy`.
- **War Town Mode** — overrides `config wartown:` for the city. Switching it on makes
  the next tick recall marching armies, exactly as the goal does.

Under the editor, **Apply** checks goals or a script for errors without saving anything
and **Save** keeps them. **Every city's editor is its own:** its goals are the goals the
engine runs there and nowhere else, and its scripts live in that city's own ten
**loadouts** — the first line names one, each city remembers which one it has open, and
**Run** runs it in that city, alongside any other city's run. Unsaved edits and the
**Output** tab stay with their city too. A script with any error is refused whole; a goal
line with an error is skipped and the rest run.

The pause button stops the engine acting until it is resumed. The log is split
by kind: **Log** is what the bot did, **Engine** its per-city thinking, **Debug**
everything including the protocol trace.

The header's **Reports** and **Mail** boxes open the game's own mailbox. A report is
drawn the way the game's report screens drew it (`mailbox.js` decodes, `public/reportview.js`
draws). The game's "battle log on the web" is a Flash page, so **`/report`** stands in
for it: give it the game's link (`…evony.com/default.html?logfile/….xml`) and the console
fetches the log from the game's report server, with no game login needed. A report's
*Open as a battle log* opens it there, and battle-log links pasted in chat link to it.

### Scripts

A script is NEAT's script language, run from a city's loadouts: labels, `goto` and
`gosub`, `if`, variables and expressions, functions, NEAT's objects
(`city.troop.archer`, `m_context.ItemCount(...)`) and its function library, and some 130
commands for marches, building, research, troops, heroes, the market, items, quests, chat
and the alliance. NEAT's example scripts run as the wiki writes them. **[SCRIPTS.md](SCRIPTS.md)**
is the reference: the language, every command with its usage and how it differs from
NEAT, the objects and functions, and the safety switches.

The box beside **Run** starts at a line number or a label (NEAT's Run box), and a `stop`
line pauses the run until **Resume**. Autorun is off until `AUTOSCRIPTS=1` (or NEAT's
`-autoscripts 1`) switches it on; then a saved loadout holding `label autorun` starts by
itself once each time the console starts, after the startup file, unless the console last
started it under 10 minutes ago. Nothing a script does spends cents except `buyitem`, and
that stops at 100 items a run without `confirm`. A line typed in the chat
box that starts with `\` runs an in-line command (`\who Bob`) instead of going out as chat.
Scripts use the console's own session and never log in. `holidaysnipe` and NEAT's
background attacks (`spamattack`, `capture`...) keep running after the script that started
them ends. The timed marches behind the extra-cities trick (`deploy bu … @:14:30:07.500`,
`marchcheck`, `buildstatus`, `logout now`) are in
[SCRIPTS.md](SCRIPTS.md#timed-marches-and-extra-cities).

| variable | what it does |
|---|---|
| `AUTOSCRIPTS` | `1` switches autorun on (NEAT's `-autoscripts 1`); it is off otherwise |
| `RUNSCRIPT` | the startup file every city runs first (NEAT's `-runscript`); default `AutoRunScript.txt` |
| `EVONY_SCRIPTS_DIR` | where `call`, `get` and the startup file are read, default `scripts\` |
| `EVONY_MEDIA_DIR` | where `play` finds sounds, default `media\` |
| `EVONY_CMDPARMS` | NEAT's parameter file, default `CmdParms.txt`; the variables above win over it, and its `-name value` pairs reach scripts as `Config.<name>` |
| `OTTO_ALLOW_RESET_PLAYER` | `1` lets `resetplayer` delete the lord; off otherwise, whatever a script says |
| `OTTO_ALLOW_ABANDON_TOWN` | `1` lets `abandontown` give up a city, and then only one `buildnpc` built; off otherwise |

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
requesttroops any archer 100k 200k 50k 10k
rallypolicy r:2 t:1 max:8
```

**Resources and troops move from the nearest city that can spare them.**
`requestresources <from> <type> <min> <max> <batch> <keep>` and
`requesttroops <from> <troop> <min> <max> <batch> <keep>` top a city up once it drops
under `<min>`, never past `<max>`, at most `<batch>` a send. They never take a sender
below `<keep>`, or below its own `<min>` for the same thing, so two cities can't pass
resources back and forth. `*` means "doesn't matter". `<from>` is `any`, a city name,
or `x,y`, several joined with `|`. The argument order is this tool's, not NEAT's (the wiki
reads `<local> <remote> <minBatch> <maxBatch>`). Rules for each line:
- What is already on its way counts: our transports and reinforcements heading in, and
  market purchases in transit.
- The **nearest** city that can send the whole batch sends it. It needs enough over its
  keep, spare transports (a quarter stay home for farming) and a free rally slot. If no
  city can send it all, the one that can send the most does.
- Only **one mission at a time** between a sender and the city, going or coming back, as
  in NEAT. `/slots:N` on a line allows more. While the nearest sender is still busy with
  this city, the line waits for it instead of calling on a farther one.
- Lines one sender serves ride in **one march**: food, wood and stone from one city is a
  single transport.

**Goal marches never overfill a rally spot.** A city has as many march slots as its
Rally Spot level. Every march holds one, going, camped or coming home. Before any goal
march leaves, the engine checks the sending city's slots. That covers NPC farming,
buildnpc, transfers and traininghero. Hiding is exempt: getting the army out is never
held. `rallypolicy` (wiki: RallyPolicy) goes in the sending city's goals and caps goal
marches by kind:
`n` NPC farming (`n:10:1` caps one level), `b` buildnpc, `t` troop reinforcements, `r`
resource transports (`v` and `m` are accepted for NEAT files). `max:8` is ours: goals stop
at 8 busy slots, whatever holds them, so a L10 rally spot always keeps 2 free for scripts
and manual marches. `npcteams` counts farming teams (attacks) only, as in NEAT.

**Troops train in batches of about 30 minutes.** Each tick the engine reads the barracks
queue and the city's per-unit training time (mayor and research included), then queues
one batch per short troop type into the barracks with the most room. A batch is the
smallest of: the slot's worth of training, the idle population, the resources, and what
is still short. Troops already queued count toward the target. A barracks holds as many
batches as its level. `config troopslot:60` changes the slot (minutes), `/slot:60` on a
`troop` line changes it for that stage, and `troopslot:0` removes the cap. Batch time is
fixed when a batch is queued, so the attack mayor is appointed first. `troopsusepopmax`
is still accepted but does nothing: the server only trains from idle population.

**A city has one builder.** Each tick sends at most one construction command, and none
while something is already being built. New buildings only go on open plots. Outside
the walls the Town Hall decides how many plots are open: 13 at level 1, 3 more per level,
all 40 at level 10. With no plot left the engine goes straight to upgrading what stands.
The plan note says what can't be built and why, e.g. `no free field plot for 7 more Farm
(all 40 in use)`. Order: demolitions, new buildings, Walls needed for fortifications,
then upgrades.

**Fortifications count the wall queue** toward the target, and each order is sized to the
fortified space left. The Walls level sets the space: 1,000 at L1 up to 55,000 at L10. A
trap takes 1, abatis 2, a tower 3, logs 4 and rocks 5. When a stage needs more space than
the Walls give, the Walls upgrade goes to the builder. Anything the server refused is
retried later, from 1 minute up to 4 hours. While it waits it uses no action slot and
writes no log line; the engine's plan note lists it under `held back`.

Modules each export `{parsers, plans, executors, configKeys}` and are wired generically:

| module | covers |
|---|---|
| `goal-war.js` | hiding, recalls, gates, defence |
| `goal-heroes.js` | recruiting, levelling, firing, mayors |
| `goal-npc.js` | NPC farming — levels, 8h cycles, camp cooldowns, troop sizing |
| `goal-buildnpc.js` | turning flats into NPC camps (**off by default**, see below) |
| `goal-transfer.js` | requestresources, requesttroops — nearest sender, one march per sender |
| `goalmods.js` | comfort, defence, training heroes, mayors |

`rally.js` is not a module but the rally slots they all share, and `rallypolicy`.

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
for t in test-war test-heroes test-npc test-enginestate test-buildnpc test-maint test-auth test-tenancy test-holiday-snipe test-teleport test-queue-cancel test-stone-of-finding test-mail test-transfer test-script test-timed-march test-script-lang test-script-objects test-script-functions test-script-regex test-script-net test-script-deploy test-script-city test-script-hero test-script-account test-script-market test-script-info test-script-social test-script-post test-script-goals test-script-console test-script-compat test-script-safety; do node $t.js; done
```

1,570 tests, no network required.

## Not in this repo

- `.env`, `evony.db`, `accounts.json`, `proxies.txt` — credentials
- `src/` — the decompiled 1922 client. It is the authority for every command and field
  name, but it is someone else's copyrighted code.
- `ffdec/`, `*.pcap`, `payloads*.txt` — tooling and captures
