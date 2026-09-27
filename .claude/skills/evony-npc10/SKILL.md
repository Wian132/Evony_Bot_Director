---
name: evony-npc10
description: Captures level-10 NPC cities ("Barbarian's city") in Evony to give an account more cities. Use when the user says "cap an npc10", "capture an npc 10", "get <account> to 10 cities", "take an NPC for <account>", or "cap an npc10 from account X for account Y".
---

# Capping NPC 10s

**Read `EVONY-RULES.md` first** (§0 checklist, §5 heroes/cities, §5b battle). This skill is
how the user's method runs on OTTObot; it was worked out live on 2026-09-18, when Lord05,
Lord10 and others were brought up to 10 cities.

## What the user means

- **"cap an npc10 from X for Y"**: account X clears and drains an NPC 10; account Y captures
  it. X can be at 10 cities (then it can't capture — which is the point); Y must be under
  its city cap (city cap = title + 1, so 10 for a title-9 lord).
- **"cap an npc10 from X"** / **"for X"**: X does it all and captures on its own waves (X must
  be under its cap).
- **"get everyone to 10 cities"**: one target per missing city, every idle city of the
  10-city accounts draining, each short account capturing. Not Lord22 or Lord02.
- Holiday accounts are never used for this (holiday rules: `evony-glitch` skill).

## The method (the user's)

1. **Scout** the target (5k scouts, no hero) — optional; every NPC 10 on ss71 looked the
   same: ~400k warriors, full 5K forts (traps, abatis, trebuchets, logs, towers), a Lv 27-30
   hero, loyalty ~90.
2. **Clearing hit, and it must land FIRST**: one hero with **attack ≥ 300 and level ≤ 1500**
   (the user's limit — never the account's top heroes), with **90k cataphracts, 5k cavalry,
   5k scouts**. Heroes with attack 476-722 won; a win cost ~12.8k cataphracts plus the 5k
   cavalry and 5k scouts. A wave that meets the full garrison instead loses everything.
   - **Mass substitutes for the hero (2026-09-20).** Lord14's best hero is 269 attack
     and it still took two NPC 10s in **ten minutes for ~168k troops**, with the user's
     bigger recipe: **two back-to-back War Ensign hits of 115k cataphracts / 6k scouts /
     4k cavalry** behind the city's two best idle heroes (230 and 224 attack were enough),
     then 20k waves from three or four more cities. So attack ≥ 300 is a guideline, not a
     requirement — `scripts/job-drain-big.txt` is that version of the job.
   - **115,000 + 6,000 + 4,000 = 125,000 needs `/big`.** A Rally Spot L10 march carries
     100,000; a **War Ensign** (`player.troop.1.a`) adds 25%. Without it the server refuses
     the line. Check the stock first — Lord14 held 547, Lord15 1,019.
   - **Pick the clearing city by its HEROES, not by which is nearest.** Heroes sit where
     they sit: on 2026-09-20 the city beside one target had nothing above 67 attack while
     a city one tile further held 269. Dump them first (`scripts/npc-capability.txt`).
3. **Loyalty waves, non-stop**: **20k cavalry + 20k cataphracts + 20k scouts**, one hero each,
   heroes **any idle up to level 1000** (never the mayor). The capturing account's waves can
   be small — **5k/5k/5k** is fine (Lord10 had few troops). Lord05 took 689,112 on
   its 28th wave; don't count, **keep going until it's taken** ("100 waves is fine, troops
   on the draining accounts don't matter").
4. **Many cities at once.** More drainers on one target = faster; the garrison **grows back**
   between waves, so a lone slow drainer lets the capturer's waves land on a regrown
   garrison and die. The user: "should take less than 30 minutes".
5. **Keep it close** — march time is everything. Pick targets within ~10 miles of the
   drainers and of the capturer's city (`findfield npc 10 20` lists them nearest first).

## Which cities may attack

Only cities that are **not trading**: a city of a buying account that sits the glitch play
out (over the resource cap, `SITOUT`) or an account that isn't in a play. Every city of a
buying account normally runs the buy loop; don't take a trading city off it without asking.
The Director's **Trading** tab lists which cities sit out.

Find troops and heroes per city with a look-only job step (below): `city.troop.lightCavalry`,
`.heavyCavalry`, `.scouter`; heroes are **`city.heroes`** (name, level, power = attack,
status: 0 idle, 1 mayor, 3 marching, 4 captive, 5 returning). Not `city.heros`, not
`castle.herosArray` — those are undefined in scripts.

## The machinery (all in `scripts/`)

Scripts can only be started in a city through a console's autorun (no API session), so each
account is (re)started with a **dispatcher** as its autorun script:

| File | What it does |
|---|---|
| `glitch-dispatch-buy.txt` | For a buying account: the cities named in `glitch-jobs.txt` run their job; every other city runs the buy loop as before |
| `job-dispatch.txt` | For an account that isn't trading: only the named cities run a job, the rest do nothing |
| `glitch-jobs.txt` | **The plan**: per city, `jobTarget` (+ `jobClear = 1` if this city clears it first) → `job-drain.txt`; or `takeTargets` (+ `takeWave`, `takeDelay`) → `job-take.txt`. Read once when a city's run starts |
| `job-drain.txt` | Clears (if `jobClear`: best idle hero, atk ≥ 300, lvl ≤ 1500, 90k cata/5k cav/5k scouts), waits until that hero is home, then `capture` waves (up to 20k each, sized from the city's troops, heroes lvl ≤ 1000) non-stop. Restarts the waves every 10 min (a lost battle ends them); recalls stuck armies every minute; when its target shows up in `glitch-done.txt` it ends, recalls, and moves to the next open `spareTargets` target |
| `job-take.txt` | The capturer: `capture` waves (up to `takeWave`, default 5000, each of cav/cata/scouts) on every target in `takeTargets`, heroes lvl ≤ 1000; restarts every 10 min; every minute prints `TAKEN x,y` for each target that is now its own city |
| `glitch-done.txt` | `doneTargets = " x,y x,y "` (spaces around each) and `spareTargets = "..."` (the open targets, in order) |
| `job-stuck.txt` | Recalls any army of the city still outbound 3+ min past its arrival |
| `../npc-taken-watch.js` | `node npc-taken-watch.js a10,a8,a9` (the takers' account ids): turns their `TAKEN` lines into `doneTargets`, so the drainers stop hitting the new city at once |

## Running it

1. §0 of EVONY-RULES.md. Note each account's autorun gate: **a console only starts its
   autorun 10 minutes after its last start** — a restart inside that window leaves every city
   idle.
2. Look: nearest NPC 10s (`findfield npc 10 20` in a job step), which cities are idle, their
   troops and heroes, `travelinfo x,y c:20000,cata:20000,s:20000` for march times.
3. Write `glitch-jobs.txt`: per target, one clearing city (`jobClear = 1`) plus as many
   drainers as there are idle cities near it; one taker city per capturing account, with
   `takeDelay` (5 s units) if its waves would otherwise land before the clearing hit.
   Set `doneTargets = " "` and `spareTargets` in `glitch-done.txt`.
4. Parse-check every job file offline first (`node -e` with `script.parse`) — a file with an
   error is refused whole.
5. Start: `node glitch-run.js start --buy <buying accounts> --buy-script glitch-dispatch-buy.txt --sell <other accounts> --sell-script job-dispatch.txt`,
   and `node npc-taken-watch.js <taker ids>` in the background.
6. Watch the console logs for `· DRAIN`, `· TAKE`, `· TAKEN`, `· STUCK`, `attackstatus`. The
   capturer's city list grows (`has joined the account` in its Log; `TAKEN` in the log file).
7. When every target is taken: end the jobs — set the next restart back to the plain buy
   script (`glitch-run.js start --buy … --buy-script glitch-res-buy.txt`), or leave the
   drainers idle (they stop at `doneTargets`).

## Moving a capturer to the targets (Lord02, 2026-09-20)

When the account that should capture is on the far side of the map, move it rather than
send hour-long marches. The machinery is `scripts/teleport-targets.txt` (per-city landing
tile, keyed on `city.cityManager.coords`), `scripts/teleport-job.txt` (recall, try, retry
every minute for 90 min) and a wrapper — for an account with no play to return to,
`scripts/a2-hub-then-take.txt`: `npc-capability.txt` → `teleport-job.txt` →
`job-dispatch.txt`. The teleport runs FIRST, so the account's lines in `glitch-jobs.txt`
are keyed on the **new** coordinates; a city whose move was refused then matches nothing
and stays quiet instead of marching across the map.

- **Land on NPC camps, never on a level 10** — those are the targets. Around our hub no
  flat is free (EVONY-RULES §5e), so it is a War Teleporter job: check the stock first
  (`player.more.castle.1.c` in the account's `account_latest` row — Lord02 held 22).
- **A farming account moves easily.** Four of Lord02's five cities landed with **0
  retries** although each had three NPC-farm attacks out: `recallall` pulls an attack
  march straight back. It is homebound transports that cannot be recalled and force the
  retry loop.
- **Fix the goals before the restart, on every row.** Comment out `defensepolicy
  /usetruce:…` (a truce makes our own attacks fail `ok=-83`), comment out
  `requestresources` and **`traininghero`** (both keep an army out, so every teleport is
  refused `ok=-77`; traininghero bites the LAST city to move, because by then the hero's
  trip to the next city is the width of the map and it is never home) and set
  `config npc:0` —
  NPC farming keeps every hero marching, and a `capture` wave needs an idle one. Do it in
  prepend, in `default` **and** in every city row; `default` is what a newly captured city
  inherits. Back the texts up first (`goals-backup-a2-2026-09-20.txt`) and check each with
  `require('./goals').parseGoals(text).errors` before saving.
- **`npc-capability.txt` reported `rally=` from building 26, which is the Workshop** —
  the Rally Spot is typeId 29. Fixed 2026-09-20; a `rally=0` in an older log means nothing.
- **Check the taker's cavalry, not just its scouts.** Lord02 held 10,000 cavalry and
  10,000 cataphracts a city against ~100,000 scouts, so a `takeCav = 2000` wave lasts
  exactly five waves and then the background attack stalls. `job-take.txt` re-sizes the
  wave from what the city holds at each ten-minute restart (`c:2000,cata:1000,s:10000` →
  `cata:500,s:10000`), so it heals itself — but the useful wave count per city is
  cavalry ÷ takeCav, not 200.
- **A capture city with no heroes sends nothing, silently.** Lord02's fifth city had
  0 heroes at all; `attackstatus` showed `#1 capture 710,124 from Flat: 0 waves sent` for
  as long as it ran. Read `TAKESTATUS`/`ALLHEROES` early and give such a city a hero
  (`reinforce <city> <hero> <troops>`) or leave it out of the plan.

## The capturing side (learned taking Lord10's cities, 2026-09-18)

- **The capturing hero and army stay in the city they take** — and the hero can end up its
  mayor. The origin city loses that hero; the new city has the hero but hardly any troops
  (the fight cost them). Plan the next capture from the new city: move troops in
  (`reinforce <new city> none c:…,cata:…,s:…`, own-city reinforcements are quick) and free
  its hero with **`unmayor`** (in that city) so it can lead waves.
- A small account often has **one hero per city and it's the mayor**. `unmayor` frees it
  (the engine, if running, may swap a mayor back — Lord10's was paused). Afterwards run
  `scripts/fix-mayors.txt` on the account (autorun) to give every city without a mayor its
  strongest idle hero.
- One-off orders for a running taker city: `scripts/glitch-oneoff.txt` (called silently by
  `job-take.txt` every loop, one flag per order). Disarm an order once it has run — a
  restart resets the flags and would run it again.
- A taker city prints `TAKESTATUS` (heroes with status, troops) and `TAKELOG` every 5 min,
  and once, at the start, `ALLHEROES` for every city of the account — use them to see why
  a taker sends nothing ("no SpamHero is free" = no idle hero at level ≤ 1000).
- If the capturer has no usable hero anywhere near, a city with one far away can move it:
  `reinforce <city> <hero> <troops>` (the hero stays there).
- When all targets are taken: restart the drainers' accounts on the plain buy script
  (`glitch-run.js start --buy … --buy-script glitch-res-buy.txt`), stop
  `npc-taken-watch.js`, and fix the mayors.

## Many accounts at once around the hub (the 2026-09-22 drive)

The user: "fill all accounts up with towns … over 20 … quick and dirty … use cataphracts".
Set up in ~15 minutes for 21 targets and 13 accounts:

- **Goals without touching the shared prepend file.** Every account's prepend is synced
  from one file (Director ✎ → `goalFile:prepend:<id>`, goalfiles.js). Copy it with the
  `defensepolicy` / `requestresources` / `traininghero` lines commented out
  (`prepend-capture-2026-09-22.txt`, plus `config npc:0`) and point only the capture
  accounts' `goalFile:prepend:<id>` at the copy; the Director saves it within 15 s. The old
  paths are kept in the setting `capturePrependBackup:2026-09-22` — **put them back when the
  drive ends.** Use forward slashes in the path (a `C:\…` typed through the shell lost its
  backslashes and the Director said "the file is not there").
- **One wrapper for every account**: `scripts/hub-capture.txt` = `hub-fleetfeet.txt` (two
  Fleet Feet to a partner in the same alliance) → `npc-capability.txt` → `teleport-job.txt`
  (far cities war-teleport onto a non-L10 camp first) → `job-dispatch.txt`. Drainers and
  takers get the same autorun; `glitch-jobs.txt` alone says who does what, keyed on the
  coordinates the city will have AFTER its teleport.
- **`glitch-jobs.txt` was generated** from a target → taker / clearing city / drainers
  table by a throwaway Node script, which also refused any city given two jobs. Faster
  and safer than hand-writing 85 `if` lines.
- **Every drainer runs `job-drain-big.txt`** with `jobClear = 1` on one heavy city per
  target (lord04 ~10m troops a city, Lord08 up to 433m): it picks the two best idle heroes and
  falls back to waves when the city has under 20k cataphracts. Note it chose Lord04's OTTO
  (atk 1466) and kush (1027): the level ≤ 1500 filter does not keep top heroes out.
- **Never make a city the account captured earlier its taker.** It holds one hero, and
  that hero is its mayor, so the capture task reports `0 waves sent` for ever (2026-09-22:
  Lord02's 696,122 and Lord15's 708,124, 30 minutes lost). Read ALLHEROES before you
  pick: the taker needs idle heroes at level ≤ 1000. Better still, give each target two or
  three taker cities of the account — the replan put four on each and both fell within
  minutes.
- **A drainer that moves to a spare target used to lose its clearing role** (`jobClear =
  0` in `db_retarget`), so Lord20's targets, which had no clearing city, only ever met
  20k waves. Since 2026-09-22 a city holding ≥ 200k cataphracts opens its next target with
  the two big hits again. And keep a spare target that has **no taker yet** out of
  `spareTargets` (or park it in `doneTargets`): every freed drainer piles onto the first
  open spare, and 20 cities spent ten minutes on 693,126 with nobody there to take it.
- **A taker that runs out of cavalry used to send scouts alone**, which always lose to an
  NPC city (Lord20 690,125 at 899 cavalry, 2026-09-22 15:45). `job-take.txt` now sends
  nothing under 500 cavalry a wave and says so. Fix such a city by moving cavalry in from a
  sister city (a `glitch-oneoff.txt` line: `reinforce <x,y> none c:15000`) and a smaller
  `takeCav` (1,500) so the cavalry lasts more waves.
- **A taker's capture task can die quietly and sit dead for ten minutes.** A lost wave
  ends it (and recalls that **city's** attacks on the target — fleet-wide until
  2026-09-23, when `recall`, `capture`/`loyaltyattack` and `setguard` were all made per
  city), and so does a relog
  (Lord20's server drop at 16:29). `attackstatus` then says "no background attacks
  running" while the job waits for its 10-minute restart. `job-take.txt` restarts the
  waves every **2** minutes since 2026-09-22 16:40.
- **One target at a time for a weak taker.** Lord20's second city split its last
  cavalry across 687,129 (every drainer on it) and 693,130 (no drainer yet), so the
  waves on 693,130 only lost. With `takeTargets` narrowed to the drained target (a
  `glitch-oneoff.txt` line, live), 687,129 fell in a minute. Then it waited until the
  clearing hits on 693,130 had landed, about 7 minutes at 20 tiles, and 693,130 fell
  within 3 minutes of its first wave.
- **`@call` hides everything, the march included.** The one-off runs inside job-take's
  silent `@call "glitch-oneoff.txt"`, so neither its echo nor the reinforce shows in the
  log: judge it by the troops in the next `TAKESTATUS`. Key a teleported city on
  `city.cityManager.coords` to be safe (the line was switched from `city.coords` before the
  troops showed up, so which of the two fired is *unverified*).
- Trading was cut to two sellers and two buyers by editing the `tradingRun` record's
  `buy`/`sell`/`ours`/`banks` (read back three times, it held), so the Director's watchdog
  leaves the capture consoles alone. Holiday sellers that stop run `cancel-sells-idle.txt`.

## Result on 2026-09-18

Lord05 (689,112, 18:46), then with the generic jobs and many drainers: Lord10 698,120
(~20:00), Lord08 697,121 (20:30), Lord09 698,121 (20:35), Lord10 712,110 (20:39) and
699,122 (20:41) — four captures in ~40 minutes once the setup was right, against hours of
step-by-step work before.

## What went wrong on 2026-09-18 (don't repeat)

- **A wave landed before the clearing hit** and lost 60k troops: start waves only after the
  clearing hero is home (job-drain does), and delay takers (`takeDelay`) when they're close.
- **Waves get stuck** — still outbound long past arrival, even after a relog (an Evony
  glitch). Recall them (`job-stuck.txt`); a stuck clearing hit is recalled and re-sent.
- **NPC battle reports aren't kept** on these accounts: `quickarmyreport` and `readreport`
  don't show them, `loyaltyattack` never sees loyalty move (it shows the scout report's 90).
  Judge a battle by the troops that come home (a loss kills every attacker), and use
  `capture`, not `loyaltyattack`, for draining (no scout report needed, no loyalty floor).
- **The drainers kept hitting a city after it was taken** (it became the capturer's city):
  that's what `glitch-done.txt` and `npc-taken-watch.js` are for. Also, a capture attempt
  on a city already yours answers "x,y is your own city".
- **A relog loses the background attacks and the `spamheroes` line** (script goal lines live
  only in the run). The jobs re-set both; a bespoke job must too.
- **Default spam heroes** (base ≤ 69, level < 50) left 1 hero per city — the user allows any
  idle hero up to level 1000 for waves: `spamheroes any:level<=1000`.
- **A loop over an undefined list spun forever** (`city.herosArray`) and wrote ~1 MB/s of
  log: cap every loop (`|| i >= 200`), and the disk had only 7.7 GB free.
- **Step-by-step job files with `done = step` bookkeeping** were slow and error-prone
  (skipped steps, re-runs after a relog). Use the generic jobs; the user wants efficiency,
  not precision.
- The `attack` line's "march N s" is not the one-way time; `travelinfo`/`marchcheck` give
  the server's figure. Returns are fast with Relief Stations.
- `quickarmyreport`, `readreport`, `warreport` are in-line commands: `command "readreport 123"`.

## Capturing for an ally (2026-09-22)

The ally lands the capture wave; our accounts only drop loyalty (they are at 10 cities).
Two things that went wrong, both now in EVONY-RULES.md §5e1:

- **Never send a wave you cannot call back.** The moment the ally takes the tile it is his
  city, and anything still flying hits an alliance member. `ally-burst.txt` fires once per
  `burstGo`, so it now has a stop path: `allyStop = 1` in `ally-targets.txt` makes each
  burst city run `endloyaltyattack` and `recall <target>` once. `ally-drain.txt` already
  recalls when `UpdateDetailInfo` shows the target is no longer an NPC — but only while
  its loop is running. A script someone has stopped recalls nothing.
  Since 2026-09-23 `recall <x,y>` calls back **only the running city's** armies, so a stop
  path like this must run in every city that fired (a script run in all cities does);
  `recall <x,y> all` is the one line that pulls the whole account's back.
- **Read the server's arrival stamp** (`city.selfArmies[i].reachTime`, `TimeDiff` in ms,
  direction 1 out / 2 home) — the printed "march Ns" is 2.5-3x too long. Lord08's burst was
  793-835 s over ~23 tiles, not the 1,842-1,937 s printed.
