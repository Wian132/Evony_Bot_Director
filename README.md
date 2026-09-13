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

**`holidaysnipe`** (`holiday-snipe.js`) is a script command that keeps running after
the script returns. It watches the market, and when food, wood, stone or iron is
offered under 1 gold it bids the best ask + 0.01 in every city with over 1b gold:
ten 99m orders each, all cities at once, and ten more for as long as they fill. It
never takes a city under 1b and cancels whatever does not fill. The server keeps the
0.5% fee on a cancelled order, and charges your bid, not the seller's price, so after a
round where nothing fills it leaves that resource alone for 30s, doubling each time it
happens again (up to 10 min). `holidaysnipe dry`
only says what it would buy; `holidaysnipe status` and `holidaysnipe stop` do what
they say. Every default can be changed on the line, e.g. `holidaysnipe under:0.5 floor:2b`.

**`teleport`** (`teleport.js`) moves the open city tab, or any city with `from <city>`.
Which teleporter it spends depends on the target:

| line | spends | lands |
|---|---|---|
| `teleport 212,312` | Advanced Teleporter | on that empty flat |
| `warteleport 212,312` | War Teleporter | on that NPC camp |
| `teleport thuringia` | City Teleporter | somewhere random in that state |
| `teleport random` | City Teleporter | in a state picked at random |

Before it sends anything, it checks that the item is held and that the target isn't
one of your own cities. Coordinates are read off the live map first: a flat for
`teleport`, an NPC camp for `warteleport`. When the tile type is wrong it refuses and
names the command that would work. The move itself is the server's call, and a refusal
comes back with the server's reason. Once a city has moved it is never abandonable
by `buildnpc`.

**`lostheroes`** and **`recover`** (`stone-of-finding.js`) do what the Stone of Finding
does in the game: it opens a list of heroes you have lost, and restoring one spends a
stone. A hero captured by the city it attacked is on that list, and comes home with it.
Don't `release` a captured hero from the captor's side: that loses it. `lostheroes`
prints the list, with each hero's level, base attributes (points not included), when it
was lost and its id, plus how many stones you hold. `recover Aldric` restores Aldric into the open city
tab, and `recover Aldric to Second City` restores that hero into another city. A name is
matched in any case, and an id always works. Nothing is sent without a stone, or for a
name that isn't on the list, or for a name two heroes share (it lists both so you can
pick by id). A dry run reads the list and stops there. When the server refuses and the
city's Feasting Hall looks full, the refusal says so. `useitem player.item.stoneoffinding`
is refused and points you to `recover`.

**`renamehero <hero> <new name>`** (`rename-hero.js`) does what the Feasting Hall's Change
Name button does, for a hero in any of your cities: `renamehero Att66A391 OTTO`. The hero
can be given by name, in any case, or by id. The game's own rules are checked before
anything is sent: no quotes, backslashes or spaces, and 10 letters at most (a Chinese
character counts as 2). It won't touch a prisoner, and it won't guess between two heroes
that share a name (rename one by its id). When another hero already has the new name, it
refuses, because `useheroitem` finds a hero by name and takes the first match, so two heroes
with one name could get each other's items. Add `anyway` to go ahead regardless. Scripts
and goals that named the hero by its old name need the new name afterwards.

**`waterhero <hero> [/heropoints="..."]`** (`water-hero.js`) is NEAT's command for Holy
Water: it resets a hero's attribute points, then spends them again. On its own
(`waterhero Smarty`) every point goes to the hero's highest stat. After a reset that is the
stat the hero was born with, so an intel-born hero built into attack comes back an intel
hero. The `/heropoints` switch takes what a `heropoints` goal takes: `/heropoints="att"`
puts every point into attack, `/heropoints="pol:300,int:100 att"` brings politics to 300
and intel to 100 in proportion and the rest into attack, `/heropoints="pol:300 int:100 att"`
does them in turn, and `/heropoints=off` leaves the points unspent. A reset costs one Holy
Water per ten levels begun (`ceil(level / 10)`: 10 for a level 100 hero, 25 for level 250),
which is what the game's own button charges. Nothing is sent for a prisoner, a hero that
is out (marching, returning, farming or defending), a name two heroes share, or when too
little Holy Water is held. In that last case it names any Holy Water packs you could open
with `useitem`. The points are spent against the stats the reset sends back, never the old
ones. The Heroes tab's **Reset** button does the same, and shows the cost first.
`useheroitem <hero> holy water` runs `waterhero`, because the game never resets through
`hero.useItem`.

**`canceltroopqueues [n]`** and **`cancelfortifications [n]`** (`queue-cancel.js`) are
NEAT's commands for emptying the barracks and the Walls queue in the open city tab.
`n` batches stay in each barrack (or in the Walls queue), and every batch after them is
cancelled. With no `n`, every batch goes. Batches are cancelled from the back, so the
one in training goes last. `canceltroops`, `cancelwalls` and `clearwallqueue` do the
same. To cancel one batch by hand, use the ✖ beside it in the **Barracks queues** or
**Fortifications** panel. A troop or fortification goal that is still short queues
more on the engine's next pass, so pause the engine first to keep the queues empty.

### Timed marches and extra cities

Marches read the way NEAT reads them. `deploy <type> x,y <hero> <troops> <resources> <time>`
takes `at` attack, `bu` build city, `re` reinforce, `sc` scout and `tr` transport.
Troops come first and resources second, so `s:` and `w:` mean scouts and warriors in the
first list and stone and wood in the second (`f w s i g`, `l` for lumber, or the full
names). `@:14:30:07.500` lands the march at that moment on this machine's clock.
`@0:30:00`, or a bare `0:30:00`, camps it that long. Plain `@hh:mm:ss` used to be a landing
time here; like NEAT, it is camp time now. `set name value` and then `%name%` swaps text
into later lines.

An `@:` march (`timed-march.js`) is sent to the millisecond. Its march time is worked out
the way the client does it (`C.marchTimeMs`): the slowest speed held in an int, the drive
skill for mounted troops and siege, the sending city's Relief Station when the target is
yours or your alliance's, the map's wrap-around, and the march-time buffs. Camp is whole
seconds, so the fraction is taken up by holding the send back. After the send, the
server's own `reachTime` for the new army is checked, against the aimed moment for the
first march and against the marches already due for every later one, from any city's
script. A march that misses the second is recalled at once and sent again, up to three
tries. The miss is learned (a network lead, or a speed factor for that city and kind of
tile), so the next march is right first time. A stamp that no speed rule could explain is
reported and left alone. Aim mid-second (`.500`): an aim on a second boundary can be split
across two seconds by a few ms of network jitter. **`marchcheck`** holds the formula
against the server's own start and arrival times for every march the account has out,
with and without the Relief Station. It costs nothing in game, so it's worth running
before a real attempt.

This is what the extra-cities trick needs. The server checks the city limit
(`titleId + 1`: 10 cities for a Prinzessin) when a build is sent, not against the builds
already on their way, so many `deploy bu` marches sent with one slot open, all landing in
the same second, can go over it. `city-build.js` refuses a build before it is sent when the
target isn't a flat you hold, when another build march is already heading there, or when
no city slot is open. `buildstatus` lists every build march on its way, grouped by the
second it lands in. Flats taken after login now reach the console (`server.CastleFieldUpdate`).

**`logout <when> <back>`** (`logout.js`) takes the console off the game, the way the
recipe says to once the builds are out: `logout now @:14:35` or `logout now 1:05:00`. It
waits for the other cities' scripts to finish first, blocks every login until the time
(the maintenance override doesn't lift it), survives a restart, and logs back in on its
own. **Connect** ends it early. Nothing can follow it in a script.

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
for t in test-war test-heroes test-npc test-enginestate test-buildnpc test-maint test-auth test-tenancy test-holiday-snipe test-teleport test-queue-cancel test-stone-of-finding test-mail test-transfer test-script test-timed-march; do node $t.js; done
```

615 tests, no network required.

## Not in this repo

- `.env`, `evony.db`, `accounts.json`, `proxies.txt` — credentials
- `src/` — the decompiled 1922 client. It is the authority for every command and field
  name, but it is someone else's copyrighted code.
- `ffdec/`, `*.pcap`, `payloads*.txt` — tooling and captures
