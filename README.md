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
Start it with `ENGINE_PAUSED=1` to come up paused instead — for a restart after a change
to what the goals do, when you want the page, scripts and chat but not the engine until
you have looked things over.

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
  the next tick recall the marches still heading out of the city, exactly as the goal
  does.

Under the editor, **Apply** checks goals or a script for errors without saving anything
and **Save** keeps them. **Every city's editor is its own:** its goals are the goals the
engine runs there and nowhere else, and its scripts live in that city's own ten
**loadouts** — the first line names one, each city remembers which one it has open, and
**Run** runs it in that city, alongside any other city's run. Unsaved edits and the
**Output** tab stay with their city too. A script with any error is refused whole; a goal
line with an error is skipped and the rest run.

**The goal editor colours every line as you type.** Blue lines are ones the engine acts
on, red lines have an error or would do nothing, and grey lines are comments. Hover a red
line, or put the cursor on it, to see why. The strip under the editor counts each kind,
and Apply's Output lists them too. A line read differently from how it was written, such
as `wartown 1` or an obsolete NEAT goal, stays blue and says what it was read as. Scripts
are coloured the same way.

The selector under the editor, beside Apply and Save, opens the texts the whole account
shares instead of the city's own: the **New-city template**, the **Prepend goals** and
**Append goals** every city runs before and after its own, and **Goal set 1** to **9**,
which a script's `loadgoals N` runs. On the script tab it holds the city's loadouts and
the **New-city script**. When a script has changed the goals a city runs, the editor's hint
says so, and **Clear script goals** puts the city back on its saved goals.

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
The goal language is NEAT's: every goal and config key its wiki documents is read in
NEAT's syntax and does what the wiki's page says. Where the wiki is silent the bot takes
the careful reading, and the plan note says what it did.

```
config comfort:1,hero:1,npc:5
build f:10:37
research lo:5,ho:5
troop b:5k,t:5k
troop a:100k,s:100k
fortification ab:5000
taxpolicy 20 100
distancepolicy 15
npcteams 3
requestresources any wood 2m 200k * 500k /below:100k
requesttroops any archer 200k 10k * 50k /below:100k
defensepolicy /junktroop:5000 /usetruce:79
rallypolicy r:2 t:1 max:8
```

**How lines combine.** `config` lines merge, and a key written again later wins. A goal a
city has once, such as `comfortpolicy` or `defensepolicy`, is replaced by a later line of
the same name. `troop`, `build`, `research`, `plan` and `fortification` lines stack and are
worked in the order written. Numbers take `5k`, `1.5m` and `2b`. Troop, fortification and
resource names are the same in every goal: NEAT's abbreviations (`warr`, `cav`, `cata`,
`ram`, `pult`, `tra`, `ab`, `at`, `tre`, `lumber` …), full names and plurals.

**A city's turn.** The engine visits every city once a minute, one at a time. Most goals
share three actions a turn. Hiding and the gate go first, before anything else is read,
and some work has a slot of its own that never waits behind the rest: one construction
order, one research start, up to 20 troop batches, and the free finishes. Anything the
server refused is retried later, from 1 minute up to 4 hours. While it waits it uses no
action slot and writes no log line; the engine's plan note lists it under `held back`.

**Goal marches never overfill a rally spot.** A city has as many march slots as its
Rally Spot level. Every march holds one, going, camped or coming home. Before any goal
march leaves, the engine checks the sending city's slots. That covers NPC farming,
buildnpc, valleys and flats, transfers and traininghero. Hiding is exempt: getting the
army out is never held. `rallypolicy` (wiki: RallyPolicy) goes in the sending city's goals
and caps goal marches by kind: `n` NPC farming (`n:10:1` caps one level), `b` buildnpc and
flats, `v` valleys, `m` medal hunting, `t` troop reinforcements, `r` resource transports.
The server lists a valley attack like an NPC attack, so `n` counts valley attacks too.
`max:8` is ours: goals stop at 8 busy slots, whatever holds them, so a L10 rally spot
always keeps 2 free for scripts and manual marches. `npcteams` counts the city's attacks
(NPC farming, valley farming and captures), as in NEAT.

### Building and research

**Build lines are targets, the NEAT way.** `build f:10:37` means at least 37 farms at L10
or higher. A missing quantity counts as 1. Nothing is demolished unless a level or
quantity is 0: `c:0:8` keeps the 8 strongest cottages, `inn:2:0` takes the inn down to L1
one level at a time, `i:0:0` removes every iron mine. The Town Hall and Walls are never
demolished. Targets for one type combine (`b:4:15,b:9:2` is 15 barracks, two at L9), and
the lowest building is raised first. When two targets contradict, the one written first
wins and the plan says so. Lines run in order like troop stages. A line with no free plot
is skipped until one frees, and a one-per-city building with no plot stops with
`Needs space: Academy`. `?w:10?` or `?met:10,w:10?` before or after a group holds it back
until the condition is met (`?i:4:0?` means no iron mine at L4 or higher; inside a
condition `st` is the Stable and `sp` Stockpile). `config building:0` pauses construction.
Use `t` or `th` for the Town Hall; full names work too.

**Prerequisites are built first, the NEAT way.** Before the bot places a construction
order it asks the game what the order needs. A building it needs, including Town Hall
levels, is built or raised first ("Cottage L9 needs Town Hall L8"). The prerequisite's own
needs are checked the same way. If there's no plot for it, the bot says `Needs space: Farm`
and stops, except that below Town Hall L10 a field gets a plot by raising the Town Hall.
Fields a line wants that don't fit also raise the Town Hall, no higher than they need. An
order that needs research is skipped and noted for the research goal. A level-10 upgrade
needing a Michelangelo's Script is skipped when you hold none, and spends one when you do
(NEAT's wiki warns of the same). When resources or idle population are short, the builder
waits and says what for, and troop and wall batches leave that cost in the bank.

**A city has one builder.** Each turn sends at most one construction order, and none while
something is already being built. The Walls a fortification goal needs come first, then
the lines in order. Within a line, demolitions go first, then new buildings, then upgrades
from the lowest level up: the fastest work first. A city without Walls gets them built
when a `w:` target or a fortification goal needs them. New buildings only go on open
plots. Outside the walls the Town Hall decides how many plots are open: 13 at level 1, 3
more per level, all 40 at level 10. The plan note says what can't be built and why, e.g.
`no free field plot for 7 more Farm (all 40 in use)`, and the Buildings tab shows the
prerequisite being built, what the builder waits for, and what it skipped.

**Free speed-ups.** The game finishes a construction or research for nothing when the job
is a short one: its preset time, before research and the mayor shorten it, is five minutes
or less. That covers the early levels: a Farm's first four, a Cottage's, Sawmill's or
Quarry's first three, an Ironmine's or Rally Spot's first two, the first level of a
Barracks, Stable, Inn, Forge or Feasting Hall, and Informatics 1. The engine finishes these
the moment it sees them, including the building it has just started, so the builder moves
straight on. The time left doesn't matter: a long job with a minute to go is still a long
job. Demolitions, troops and fortifications never get a free finish. A refused one isn't
asked again. `config freespeedup:0` turns them off in a city.

**Research, the NEAT way.** `research lo:5,ho:5,com:4` researches Logistics and Horseback
Riding to level 5 and Compass to 4. Lines run in order, one research at a time in each
city, and a city never starts a tech another city is already researching. Use NEAT's
codes (`st` or `sp` for Stockpile) or full names, and a `?condition?` before or after the
targets as on a build line (`research ?a:10?pr:10`; inside a condition `st` is the Stable).
A tech the target needs is researched first. A building it needs is built before the build
lines' own work, including the Academy when a tech has reached the level this city's
Academy allows (Machinery needs Academy L9). When resources are short it waits and says
for what, and troop and wall batches leave the cost in the bank. `config research:0`
pauses research. With a research line or `config research:1`, the techs your build lines
need are researched too. A script's `research` line, or NEAT's older `techgoals`, adds a
research line.

**Plans.** `plan c:4:9,i:4:40,b:4:14,mi:4` puts buildings and research on one line. It is
finished before the next plan line starts: every building standing at its level and every
research at its level. On a plan line `st` is the Stable and `sp` Stockpile. Plan lines
come ahead of your build and research lines, which carry on whenever the plan leaves the
builder or the Academy free. `config plan:0` pauses them.

### Troops and walls

**Troops train in batches of about 30 minutes.** Each turn the engine reads the barracks
queues and the city's per-unit training time (mayor and research included), and fills the
free slots: a barracks holds as many batches as its level. A batch is the smallest of: the
queue time's worth of training, the idle population, the resources, and what is still
short. Troops already queued, out on a march from the city, or reinforcing it on their way
in count toward the target. Stages are worked in order, and the engine drops back to an
earlier stage that is no longer met. Batch time is fixed when a batch is queued, so the
attack mayor is appointed first. Batches leave the next construction's and research's
cost in the bank, and a day of the troops' food. `config troop:0` stops training.

**Troop lines take NEAT's switches**, and each switch overrides its config key for that
line. `/queuetime` (hours; `config troopqueuetime`) sets the batch length, 30 minutes by
default; `/slot` and `config troopslot` do the same in minutes, and 0 removes the cap.
`/increment` at 0 trains the line left to right, each type filling the barracks before the
next. A share like `0.01` or a number like `500` takes turns, and `1` keeps every type at
the same share of its target. `/usereserved` lets training spend part of the day of food
kept for troop upkeep. `/usepopmax` (`config troopsusepopmax`) lets it take part of the
whole population: production is set to 0 while the batches go in, then put back.
`/idlequeuetime` lets another hero queue small batches in empty barracks while the
`traininghero` is away; otherwise types it trains slower wait for the traininghero.
`config reservedbarrack:1` keeps one barracks free for the first line under attack, and
`config troopdelbadque:1` cancels a batch queued far too slowly (one a turn, only while
the best attack hero is mayor).

**Fortifications count the wall queue** toward the target, and each order is sized to the
fortified space left. The Walls level sets the space: 1,000 at L1 up to 55,000 at L10. A
trap (`tra`) takes 1, abatis (`ab`) 2, an archer tower (`at`) 3, rolling logs (`r`) 4 and a
trebuchet (`tre`) 5. When a stage needs more space than the Walls give, the Walls upgrade
goes to the builder. `config fortification:0` pauses the goal, the first Walls included.
`config wallqueuetime` sets the batch length (15 minutes by default), and
`config fortsusereserved` works like `/usereserved`. During an attack, one of each type on
the first `fortification` line goes up first.

### City upkeep

**City upkeep, the NEAT way.** `config comfort:1` (on unless you write `comfort:0`) keeps
each city's grievance at 0 and its loyalty as high as its tax allows, praying or giving
disaster relief only when that helps, and holds the tax your gold allows.
`taxpolicy <min> <max> [war]` sets that range (default `0 100`): the tax sits at the
minimum and rises, up to the maximum, only when the city has less than a day of hero
salary banked and the tax isn't paying it. It uses the war rate while under attack, and
keeps a rate you set by hand. `comfortpolicy <min> <max> [options]` adds a round every
min–max minutes: `popraise` (only below the population limit), `bless`, `pray`, `relief`,
and levies of `gold food wood stone iron`. A levy comes only in a round where no popraise
was needed, never while under attack, and never below 50 loyalty.
`production <food> <wood> <stone> <iron>` and `warehousepolicy <food> <lumber> <stone> <iron>`
hold the Town Hall labour split and the warehouse's protected split, checked every half
hour. Wounded troops in the medic camp are healed when the city can spare the gold, unless
`config nohealing:1`.

### Resources, troops and the market

**Resources and troops move from the nearest city that can spare them, the NEAT way.**
`requestresources <from> <type> <localAmount> <remoteAmount> [minBatch] [maxBatch] [troopType]`
and `requesttroops <from> <troop> <localAmount> <remoteAmount> [minBatch] [maxBatch]` ask
only while the city holds less than localAmount, counting what is on its way, and never
fill it past that. They never take a sender below remoteAmount, or below the level at which
the sender's own line would ask for more, so two cities can't pass resources back and
forth. One batch number is the maximum per send. A minimum batch waits until it fits,
unless the city is down to half of localAmount. `*` means "doesn't matter", `troopType`
carries the resources (transports by default), and `<from>` is `any`, a city name or `x,y`,
several joined with `|` (`!Name` in NEAT's wiki is only markup, and reads as `Name`).
`/below:<amount>` is ours: start asking only under that amount, then fill to localAmount.
A line with an error doesn't run. Rules for each line:
- What is already on its way counts: our transports and reinforcements heading in, and
  market purchases in transit.
- The **nearest** city that can send the whole batch sends it. It needs enough over its
  remoteAmount, spare transports (a quarter stay home for farming) and a free rally slot.
  If no city can send it all, the one that can send the most does.
- Only **one mission at a time** between a sender and the city, going or coming back, as
  in NEAT. `/slots:N` on a line allows more. While the nearest sender is still busy with
  this city, the line waits for it instead of calling on a farther one.
- Lines one sender serves ride in **one march**: food, wood and stone from one city is a
  single transport.

**Surplus goes where it is wanted.** These lines go in the sending city.
`keepresources <to> f:1b,w:20m [minBatch] [troopType]` keeps that much in the city and
ships everything over it.
`sendresources <to> <type> <localAmount> <remoteAmount> [minBatch] [maxBatch] [troopType]`
sends while this city holds more than localAmount and the receiver holds less than
remoteAmount. `keeptroops` and `sendtroops` do the same for troops, counting only the
troops at home. `<to>` is `any`, a city name or `x,y`, several joined with `|`; coordinates
can be another account's city, which works with keep lines or a `*` remoteAmount.
Receivers are served nearest first, one mission each unless `/slots:N`, a quarter of the
transports stay home, and a war town sends nothing. Neither a send nor a sale leaves the
city short of what its other goals need: a day of hero salary in gold, the food for the
next comfort, and the next construction's cost.

**The market keeps the rest in line.** With `config trade:1` the city trades toward its
`tradepolicy /type:<res> /min:<amount|Nd> /max:<amount> /batch:<amount>` lines, or
`resourcelimits <food> <lumber> <stone> <iron>`. `Nd` is N days: of troop upkeep for food,
of hero salary for gold. It never bids gold below gold's `/min` and buys what is under
`/min` with the spare. It sells what is over `/max`, using the proceeds for resources under
`/max`. It sells for gold in an emergency (gold under a day of hero salary, or food under 30
minutes of upkeep). `/allowselltomin` and `/donotautosellabovemax` work as in NEAT. Orders
take only what the market already offers, each at its own price, paced 1.2 s apart. Offers
of ours that sit unfilled for 20 minutes are cancelled (the fee is lost), and a running
`holidaysnipe` is left alone. With neither kind of line, `config trade:1` trades on NEAT's
built-in values, buying wood, stone and iron up to 20m each, so write the lines first.

### NPC farming, valleys and flats

**NPC farming works the NEAT way.** `config npc:<n>` farms level n and up, highest first.
It picks camps by the first rule that is set: `npclist`, `npcbounds`, `farmingpolicy`
`/mindistance` `/maxdistance`, then `distancepolicy`'s first number
(`distancepolicy <farming> <building> <valley> <acquire> <scan>`), otherwise 10 tiles,
measured the short way round the map. `excludelist` always applies. Each camp is hit again
8.4 hours after its last hit, or on `config farmingcycle`, a level's `farmingpolicy`
`/cycle`, or hourly under `config training:1` (levels 1-9) and `training10:1` (level 10).
`config farmingcyclemin`, `/mincycle` or `config smartfarming:2` hit the camp worth most
per trip instead, and smartfarming 1 and 3 take only the transports the refill needs.
Levels 1-5 need Military Tradition at level+2 and Archery 10, Archery 9 with Horseback
Riding 8 or 9, or Archery 8 with Horseback Riding 5 or 6. Levels 6-10 need `npclimits`
(troops that must be home before a run leaves) and `npctroops`. `npcheroes` says which
heroes go (a line with no level covers levels 1-5), `npcteams` how many runs may be out
(10 by default), and `config npclimit:<days>` stops farming once the city holds that many
days of food. Intel heroes and the best politics hero stay home unless
`config trainint:1` (intel heroes farm first) or `config trainpol:1` (the politics hero
goes first while another hero stands in as mayor). The farming history resets after
maintenance. The console reads the map around every farming city by itself, a few blocks
a minute and each block every four hours, so a new city finds its camps;
`config mapscan:0` turns that off.

**Valleys and flats, the NEAT way.** `config valley:10` captures level-10 valleys of the
city's main resource: forests for lumber, hills for iron, deserts for stone, lakes for
food. Add `config valleymin:5` to take the highest level from 5 to 10 first, and to swap
the lowest valley for a better one once the slots (the Town Hall level) are full.
`config valleyfarming:10`, with `valleyfarming <forest> <desert> <hill> <swamp> <grassland> <lake>`
miles, hits valleys hourly once every slot is full. `safevalleyfarm 9,10` scouts valleys
and hits only the ones it can take without losses. `config hunting:5` hunts medals by
capturing a valley and letting it go before the next wave; `huntingpos` and `huntingtype`
say where. `config acquireflats:1` holds nearby flats, and `config abandonflats:1` lets the
ones below buildnpc's level go just before maintenance so they level up.
`config buildnpc:5` (or 10, 15, 20) captures a flat, founds a city on it, and hands it
back as an NPC; `npcbuildpolicy /level:10 /mindistance:1 /maxdistance:5` says how far out.
`valleytroops`, `valleyheroes` and `valleylimit` choose the troops, the heroes, and what
stays home. Before any march the game is asked who holds the tile, nothing marches from a
war town or a city under attack, and a valley is given up only for the reasons above.
`config abandon:1` strips a city you plan to give away (its queues, troops and walls go,
the tax goes to 100 and levies drain its loyalty), but only once its `troop`,
`fortification`, `taxpolicy` and `comfortpolicy` lines are gone and `comfort:0` is set. It
never acts in your only city.

### Heroes

**The mayor is always a hero at home**: the best politics hero, or the best attack hero
while troops are being queued, promoted straight over the old one. It is left alone under
`config hero:0` or `config nomayor:1`.

**Levelling, points and firing.** With `config hero:1` or higher, heroes are levelled and
any points no `heropoints` line covers go into their best stat. `heropoints <hero> att:500 int`
spends them in stages, and `nolevelheroes` names heroes left unlevelled. Heroes are fired
only when a slot is needed — for a hire, or for the training hero coming round — or with
`keepheroes /always` (ours). `config hero:XY` keeps X good politics heroes and Y intel
heroes and the rest attack: the bot sets those aside, then fires the worst attack score.
It never fires a hero `keepheroes` protects (with no `keepheroes` line, NEAT's default
`any:level>=50|any:base>=69`), the mayor, a hero that is out, a prisoner or the training
hero. `feastinghallspace` only says where hiring stops. The hall's free slots are read from
the inn when needed.

**Captured heroes.** Prisoners are never released automatically; `release <name>` works
only on a prisoner. A prisoner you persuade is judged by `keepcapturedheroes` (with no
line, NEAT's default `any:level>=200|any:base>69`), not `keepheroes`. `herofirelimit N` and
`capturedfirelimit N` are read as `keepheroes any:level>=N` and
`keepcapturedheroes any:level>=N`. A hero of yours captured by another city comes home
with a Stone of Finding (`recover`, above).

**Hiring and rewards.** With `config hero:10` or higher and `config fasthero:65`, each city
hires from its inn by itself. It reads the inn at most every ten minutes and hires the
best offer the makeup still wants whose base is 65 or more, one at a time, as long as over
1,000,000 gold stays in the city after paying level × 1000. It stops when
`feastinghallspace` slots are free, plus one while a training hero is on its way. When
the hall is full, it fires one idle hero below the bar that `keepheroes` doesn't protect
to make room for a better offer. At `fasthero:120` or more it judges attack + intel −
level. It never refreshes the inn (`innrefresh` pays game coins only with `force`) and
never hires an offer that needs an item. With `config hero:1` or higher, heroes below 100
loyalty are rewarded with gold (level × 100), lowest loyalty first, one at a time, always
keeping a day of hero salaries in the city.

**The training hero.** `traininghero <hero> [minStay] [maxStay] [npcHits]` sends one hero
round every city whose goals list it. It stays at least minStay seconds (600 by default),
then leaves after maxStay seconds or npcHits NPC runs from that city, whichever comes
first. It moves only from home (idle or mayor), and every city on its round keeps a hall
slot free for it while it is elsewhere.

**Spam heroes.** `spamheroes <hero-string>` names the heroes a script's spamattack or
loyaltyattack may send (default: base 69 or less, under level 50). `spamheroes /reset`
clears earlier lines, and from a script it lasts until the script goals are cleared. The
engine's plan lists which heroes those are. Neither the training hero nor the keepatthome
hero is ever one of them.

### Defence

**Defence reacts to the attacks the server reports.** Each hostile army is matched to the
city it is marching on, including armies already on their way when the bot logged in.
Hiding and the gate act first in a city's turn and never wait behind other goals. They
also keep their own clock: the bot looks again at the exact moment a wave enters the lead
window, so `config hiding:0.5` (30 s) and `config gate:0.1` (6 s) work as the NEAT wiki
describes. An attack under `defensepolicy /junktroop` troops (1000 by default; 0 makes
every attack count) is junk and sets nothing off; one of unknown size counts. Waves that
land at least `config attackgap` seconds apart (6 by default) are separate attacks, and
the city counts as under attack while a real one is inbound and for
`config defensecooldown` minutes (30 by default) after the last lands or is recalled.

**Hiding and the gate.** `config hiding:<minutes>` sends the garrison out just before a
wave lands, so it lands on an empty town, and brings it home once the wave has passed. It
goes to your nearest city that is not under attack itself, or where
`hidingpolicy /target:x,y` says (`hidingpolicy` is ours: NEAT works these things out
itself), and a hide march carries food at the game's own rate of twice upkeep.
`config gate:<minutes>` sets the gate for the waves inside that lead:
`gatepolicy <noattack> <regular> <scoutbomb> <mixed> <maintenance>` gives each case 0 (the
bot decides), 1 (open) or 2 (closed). It uses each wave's troop mix to tell a scout bomb
(`/scoutratio`, 0.9 by default) from a regular or mixed attack, and `/mintoggle` (10 s by
default) keeps it from flipping faster. The gate is only switched back after a wave has
landed, as soon as the server reports the battle. The console's Gate Control outranks it.

**Defence items.** `defensepolicy` uses defensive items for you, the way NEAT does.
`/usetruce:<loyalty>` spends a Truce Agreement and `/usespeech:<loyalty>` a Speech Text
when a city's loyalty falls to that value while it is under attack. `/usewarhorn`,
`/useivoryhorn`, `/usecorselet`, `/useultracorselet` and `/usepenicillin` (0 or 1) apply
those buffs while under attack. A truce covers the whole account for 12 hours, so only one
city ever sends it. The game refuses one while any army is marching at you (and, by the
item's text, while your own troops are out), so the bot uses it in the gap after a wave
lands. Items are used only if you hold them, never on top of a buff that is already
running, and never while you are in truce; the plan line says why each one is waiting.

**War Town.** `config wartown:1` or `2` (or War Town Mode on the console) locks a city down
for war. It sends no NPC farming or valley runs, buildnpc stands down, and no resource or
troop transfers leave it, though other cities can still supply it. With 1 the training
hero comes and goes as usual; with 2 it stays once it lands there. When you switch it on,
the city recalls the marches it still has heading out, once each, with its own castle id;
armies coming home or camped elsewhere are left alone. `wartownpolicy 06:00 12:00 [...]`
applies the lockdown only during those hours, on this machine's clock.

**Heroes kept home.** `config keepatthome:1` keeps your best attack hero home (never the
training hero; the second best while `config training` is on), and `homeheroes N` keeps N
heroes home while farming (the mayor doesn't count). Hiding can still use them to lead an
escape.

**The embassy and alliance chat.** `config embassy:1` keeps the Embassy's "allow alliance
troops" box open, `0` keeps it closed, and `2` opens it only while the city is under
attack and for `config defensecooldown` after. Only cities that write the setting are
touched. `config warrules:<minutes>` tells alliance chat about a real attack at once, again
every that many minutes while the picture changes, and every five times that while it
doesn't. The message is deliberately short: alliance chat is not private.

### Reports, hours and priorities

**Report cleaning.** `reportstokeep 1 a:500 b:1 a:3800 a:6000` opens the account's NPC and
valley attack reports a few at a time and deletes the ones not worth keeping. It keeps
reports with treasure, valley attacks losing 500 archers or more, npc5 attacks losing a
ballista, and npc10 attacks losing under 3,800 or over 6,000 archers; a 0 keeps every
report of that kind. Lost battles, captured heroes and anything that isn't an NPC or
valley attack are never deleted. It runs from the first city that has the line.

**Office hours and mission priorities.** `schedulepolicy 06:00 12:00 17:00 23:00` lets a
city act only in those hours, on this machine's clock. Its defence never stops: hiding, the
gate, emergency walls, defence items, the war town recall, warrules and the embassy still
act, and the training hero doesn't leave the city outside them.
`processingpolicy n:10 m:20 *:5` weighs npc farming (n), buildnpc (b), valley farming (v),
safe valley farming (s), valley acquisition (a), medal hunting (m), sendtroops (t) and
sendresources (r). Each mission sent adds points to its task and the fewest points go
first, so `m:20` sends about twice as many medal hunters as `n:10`. `!b` or `b:0` turns a
task off, `*`/`!*` covers the rest, and `/start:13:00 /end:14:00 !n` does it for an hour.
Rescue (q) is accepted and does nothing: the wiki itself isn't sure what it is.

### Account-wide goals and scripts

**New cities and global goals.** When a city is founded or captured, OTTObot gives it the
account's *New-city template*, but only if the city has no goals yet. It logs the line
count and records the city in the registry at once. A console (not `goalsd.js`) also runs
the account's *New-city script* once there, if you have written one. Around every city's
own goals run two account-wide texts: *Prepend goals*, read first, and *Append goals*,
read last. As in NEAT's GlobalGoals, a setting written again later wins, and troop, build
and fortification lines stack in that order. Errors say which text they are in ("append
line 3: …"), and every city's plan says so while a global line is broken. The texts are
read every turn, so an edit counts from the next one. An account without a template is
offered NEAT's default !NewCityGoals.txt, word for word. Cities that buildnpc builds to hand
back get neither the template nor the script.

**Goals set by scripts.** A script can change the goals a city is running without touching
the saved ones, as NEAT allows. A script's `config npc:5` or `goal <line>` runs after the
city's saved goals, so its settings win. `loadgoals N` runs the account's goal set N (Goal
set 1 to 9 in the goal editor) in place of the city's goals. `loadgoals <city>` runs
another city's saved goals instead. `resetgoals` stops all goals until the script sets new
ones. A bare `loadgoals`, the **Clear script goals** button, saving the city's goals, or
restarting the console puts the city back on its saved goals. While a script's goals are
active the goal editor's hint and the engine's plan say so.

### NEAT goal files

**A NEAT goal file reads as it stands.** All 46 config keys the NEAT wiki documents are
accepted, and each does what its page says (`monitorarmy` does nothing, as in NEAT).
`troopslot`, `freespeedup` and `mapscan` are ours. A config key written on its own line
(`wartown 1`) is read as `config wartown:1`, with a note. NEAT's obsolete lines
(`ballsused`, `npc10troops`, `npc10list`, `npc10limit`, `npc10heroes`, `npcexcludelist`,
`npc10excludelist`, `noabandonflats`, `capturedfirelimit`) are read as the goals that
replaced them, and the editor says so. A value that can't be read is an error,
never a silent 0. NEAT's `set name value` and `%name%` work in scripts, not in goal files.

### Modules

Most modules export `{parsers, plans, executors, configKeys}` and are wired generically;
the exceptions are under the table.

| module | covers |
|---|---|
| `goal-upkeep.js` | comfort, comfortpolicy, taxpolicy, levies, production, warehousepolicy, healing |
| `goal-war.js` | incoming attacks, hiding, gate and gatepolicy, war town, keepatthome, attackgap, defensecooldown, embassy, warrules |
| `goal-heroes.js` | hero strings, keepheroes, heropoints, levelling, firing, hiring, rewards, spamheroes |
| `goal-npc.js` | NPC farming — camps, cycles, research gate, troop sizing, the background map scan |
| `goal-buildnpc.js` | turning flats into NPC camps (**off by default**, see below) |
| `goal-valley.js` | valleys, valley farming, safe valley farming, hunting, flats, abandon |
| `goal-transfer.js` | requestresources, requesttroops, keep and send lines — nearest sender, one march per sender |
| `goal-trade.js` | config trade, tradepolicy, resourcelimits — the market |
| `goal-reports.js` | reportstokeep |
| `goal-research.js` | research |
| `goal-plan.js` | plan lines |
| `processing.js` | schedulepolicy, processingpolicy |
| `goalmods.js` | defensepolicy items, training heroes, mayors |
| `goallayers.js` | the account's texts (template, prepend, append, goal sets, new-city script) and the script goal layer |
| `speedups.js` | free finishes |

`goal-research.js`, `goal-plan.js` and `processing.js` bring their own parsers, but the
engine plans them itself, around the builder and the action budget. `goallayers.js` and
`speedups.js` are not goal modules. Neither is `rally.js`: it is the rally slots they all
share, and `rallypolicy`. The build, troop and fortification lines are `engine.js`'s own.

## Upgrading from the old goals

Saved goals keep loading after an update, but some lines now mean what they mean in NEAT,
not what they meant here. Two one-off tools rewrite saved goals. Both are dry runs unless
given `--apply`, work on the database `EVONY_DB` names (else `evony.db`), and save every row
they change in `json-backup/` beside it first.

**Request lines: run `migrate-goals-transfer.js` once.** `requestresources` and
`requesttroops` took this tool's own order (`<min> <max> <batch> <keep>`) and take NEAT's
now. `node migrate-goals-transfer.js` prints every change, and
`node migrate-goals-transfer.js --apply` writes them (`--account <id>` for one account). Each
old line becomes the NEAT line that does the same:
`requestresources any wood 100000 2000000 500000 200000` becomes
`requestresources any wood 2000000 200000 * 500000 /below:100000`. A line that already has
`/below` is left alone, so a second run changes nothing. Until it runs, an old line reads in
the new order: one whose batch is bigger than its keep is an error, and the rest fill the
city only to the old minimum and keep the old maximum in every sender.

**Build lines: usually leave them.** A `build` target means "at least" now, and nothing
comes down without a 0. `c:10:1,b:10:1` used to mean exactly one cottage and one barracks
at L10, and the old engine demolished any others; now they stay.
`node migrate-goals-build.js` rewrites each such target as `c:10:1,c:0:1`, which brings
those demolitions back (`--db <file>` reads another database). Apply it only if you want
them.

**What changes on the first start:**
- **Tax goes to 0%.** With `config comfort:1` and no `taxpolicy` line the range is NEAT's
  `0 100`, so the tax sits at 0% and rises only when a city has less than a day of hero
  salary banked. Add `taxpolicy N N` to pin a rate or `taxpolicy 20 100` for a floor, in
  each city or in the Prepend goals.
- **`troopsusepopmax` works.** It used to do nothing. While troop batches need more than
  the idle population, production is set to 0 for a few seconds so field workers can
  train, and resource output drops until the population grows back. Remove it, or set it
  to 0, to train from idle population only.
- **`config hero:1` spends points and gold.** Points no `heropoints` line covers go into
  each hero's best stat, which only Holy Water undoes, and heroes under 100 loyalty are
  rewarded with gold (level × 100), keeping a day of salaries.
- **Defence items get used.** A `defensepolicy` with `/usewarhorn`, `/usecorselet` or
  `/usepenicillin` uses them on the first real attack, for the whole account, and
  `/usetruce` spends a Truce Agreement once loyalty falls to its number while under attack.
- **Build lines run in order.** A later line waits while an earlier one has work to do,
  and a missing one-per-city building with no plot stops the lines with `Needs space: …`.
- **NPC farming needs research.** Levels 1-5 farm only with the research NEAT's FAQ names,
  and pause with a note without it. Camps are picked within 10 tiles unless a rule says
  otherwise (it was 20), and the farming history resets after maintenance.
- **The new-city template.** An account's `default` goals are its New-city template now,
  and open from the editor's selector. A city founded or captured gets its copy the moment
  it appears, and the log says so. Cities buildnpc builds to hand back get none. A template
  line like `s:0:0` takes down every sawmill in a captured city, so read it first.
- **Also:** troop ladders fill the barracks faster (up to 20 batches a turn); troop types
  that train slower without the traininghero wait for it while it is away
  (`config troopidlequeuetime:30` allows small batches); comfort popraises only below the
  population limit and prays or gives relief only when that helps; wounded troops are
  healed; construction no longer waits behind troops, and waits for resources instead of
  backing off for hours; early levels are finished for free; the engine's state moves from
  city names to castle ids, and the log says so once.

**Before switching on:** `config trade:1` with no `tradepolicy` or `resourcelimits` line
trades on NEAT's built-in values and buys wood, stone and iron up to 20m each in every
city. `config abandon:1` disbands a city's troops and destroys its walls. `config valleymin`
and `config hunting` give valleys up by design.

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
goals keyed per account (each city's own, and the account's template, global goals, goal
sets and new-city script), engine state keyed per `(account, castle id)`, the shared map
cache, uptime samples and the city registry. Goals a script sets are kept in memory only.

`evony.db` is gitignored — it contains every account's password in plain text.

## Tests

Run the offline suites by name, each against a throwaway database so nothing touches
your `evony.db`:

```bash
for t in test-enginestate test-goals test-war test-npc test-heroes test-buildnpc \
  test-queue-cancel test-maint test-tenancy test-teleport test-holiday-snipe test-mail \
  test-stone-of-finding test-rename-hero test-transfer test-water-hero \
  test-timed-march test-auth test-city-editors test-items test-snapshot \
  test-goal-lines test-incoming test-defence-items test-wartown test-build-neat \
  test-newcity test-speedups test-hero-fixes test-neat-compat test-script-layer \
  test-prereq test-hiring test-upkeep test-npc-parity test-resources-market \
  test-misc-goals test-research test-troop-parity test-valleys test-plan-schedule \
  test-script test-script-lang test-script-objects test-script-functions \
  test-script-regex test-script-net test-script-post test-script-deploy \
  test-script-city test-script-hero test-script-account test-script-market \
  test-script-info test-script-social test-script-goals test-script-console \
  test-script-compat test-script-safety; do
  EVONY_DB=/tmp/otto-$t.db node $t.js; rm -f /tmp/otto-$t.db*
done
```

2,813 tests in 59 suites, no network required. `test-holiday-snipe` has 10 known
failures, which it had before the goals and scripts build-outs.

**Never run `test-*.js` as a glob.** `test-scope`, `test-login`, `test-raw`, `test-block`,
`test-buy`, `test-wall`, `test-clean`, `test-castle`, `test-ctx`, `test-shapes` and
`test-lookup` log in to the live game.

## Not in this repo

- `.env`, `evony.db`, `accounts.json`, `proxies.txt` — credentials
- `src/` — the decompiled 1922 client. It is the authority for every command and field
  name, but it is someone else's copyrighted code.
- `ffdec/`, `*.pcap`, `payloads*.txt` — tooling and captures
