---
name: evony-glitch
description: Runs the user's Evony market glitch — moving resources or gold between holiday-mode accounts and normal accounts through the market. Use when the user says "glitch gold", "glitch gold through stone/wood/food/iron", "glitch stone", "glitch wood", "glitch food", "glitch iron", "buy back the stone", or asks to start, tune, measure or stop such trading.
---

# The market glitch

Accounts on **holiday** have their resources put back at every daily maintenance to what
they held at the previous one. So whatever a holiday account gives away through the
market comes back tomorrow: trading between holiday accounts and our normal accounts
**duplicates** it. Speed is the whole game — other players' bots watch for big market
moves and piggyback (under-cut our offers, over-bid our bids) within minutes.

**Read `EVONY-RULES.md` first** (§0 checklist, §3 market, §4 glitch). This skill says how
to run a play; that file says what must never happen.

## ALWAYS run the play through the Director's Trading tab

**The user, 2026-09-25: *"Always trade through this trading tab please, its really useful
for me to be able to see whats going on … document it in the trading skill so future
agents always work through it."*** This is not a preference about tooling — the tab is how
the user watches a play they are not driving themselves. Starting a play any other way
leaves that screen showing a stale or wrong picture (on 2026-09-25 it still listed the
previous day's stone sides and "Start is refused — 9 issues" while a gold play was
actually running from the command line), and the user is then blind to their own fleet.

`glitch-run.js` is a FALLBACK for when the tab genuinely cannot do the thing. If you use
it, say so and reconcile the tab afterwards.

### What the tab does that a hand-start does not

- **It refuses to start a play that would lose resources.** `checkPlay` tests every account
  on the cheap-selling / dear-buying side against what the consoles say about holiday
  *right now*, and names each offender ("X is NOT on holiday, and the Selling side sells at
  0.001 — only a holiday account may"). This is EVONY-RULES §4's hardest rule, enforced.
- **It handles the 10-minute autorun gate** (`GATE_MS`/`GATE_PAD`, `REWATCH_MS`). Started by
  hand on 2026-09-25 I restarted six sellers twice inside that window; they logged in and
  ran NOTHING for nine minutes. The tab schedules around it instead.
- **It sequences the sides** — buyers first, sellers `delaySec` (60s) later — so the bids
  are on the book before anything is sold into them.
- **Clean before / clean after**, the price ladder and the watchdog (no order for 12 min =
  stopped → restart) all hang off the run.
- It writes the control file **once**, atomically, with a version, instead of hand edits
  racing a running play.

### The sides are the sides of the PLAY, not who we are

"Buying" and "Selling" mean which side of the market that account takes. In a **gold play
the holiday banks are the Buying side** (they buy the resource dear and their gold comes to
us); our accounts are Selling. In a **resource play it is the other way round**. Get this
backwards and the check will usually catch it — but understand it, do not guess.
An account left out of `sides` entirely is **not trading** (that is how Lord07 was
held out on 2026-09-25 when the user wanted it by hand).

### Driving it

The endpoints are on the Director (:8712) and need a signed-in cookie. From the command
line, mint one for the user rather than reusing the browser's:

```js
const A = require('./auth'), D = require('./db');
const org = D.all('SELECT id FROM orgs LIMIT 1')[0];
console.log(A.newSession('<userId from users table>', org.id, '127.0.0.1', 'claude-cli'));
```

then `curl -H "Cookie: otto_sid=$SID" …`:

| Call | What it does |
|---|---|
| `GET /api/trading/setup` | the setup, the run, the control file **and `check.errors`** |
| `POST /api/trading/setup` | `{sides, play:{res,price,capGold,caps…}}` — merges; `sides` replaces wholesale. **While a play runs, price/caps/runways go live to the control file with no restart**; changing `res` or moving an account between sides needs a Start |
| `POST /api/trading/control` | the control file now (live), incl. the `holi` list — it refuses any lord the consoles do not report as on holiday |
| `POST /api/trading/start` | checks, one control-file write, then the whole sequence |
| `POST /api/trading/stop` | `end`, waits for the runs to drain, restores, cleans after |

**Always `GET` first and read `check.errors` — zero before you Start.** Nine errors on
2026-09-25 were simply a stale stored setup (still stone @ 0.001) while the control file
had already moved to food @ 150; fixing the setup cleared all nine.

### The holi list has its own guard

`POST /api/trading/control` will not put a lord in the `holi` list unless that account's
console reports it on holiday. Note the control file's parser expects **one**
`if u == "…" … holi = 1` line (`HOLI_RE`); hand-writing a second line for extra accounts is
not what it reads. Let the tab write that list.

### Walking all four resources to the end, unattended

**GOLD RUNS FIRST *AND* LAST — that is the user's order in full** (2026-09-27, and it is
what `trade-advance.js` now does):

> **gold → stone → food → wood → iron → gold sweep**

Both halves come from the user: *"1. Gold 2. Stone 3. food 4. wood 5. iron"* (2026-09-26) and
then *"clear up stone food and wood and then repass through gold else we need to run through
gold after wood again and after food again"* (2026-09-26). Gold first because it is the prize
and it dwarfs the rest — on 2026-09-27 the five banks held **4,380t of gold against ~150t of
all four resources put together** — and because **capture is highest in the half hour after
maintenance**, before the other players' bots have loaded. That window is worth spending on
gold, not on iron.

**WHY THE CLOSING SWEEP STILL EARNS ITS PLACE:** every resource pass
begins with `canceltrade`, and cancelling a bank's resting BUY orders **refunds the gold**
locked in them, so gold keeps reappearing behind us — sweep it once at the end instead of
chasing it after every step. A gold reading taken while bids are resting is meaningless: the
banks read 0.77t and looked finished, then **8.64t** the moment the stone pass cancelled
their books (our own gold unchanged, so it was their refund, not our payment).

**The two gold steps are indistinguishable from the control file** — both are stone at 150 —
so `trade-advance.js` keeps the step's **index** in its saved state and that is what tells
the opening pass from the closing sweep. Without it, finishing the sweep reads as finishing
the opening pass and the day loops back to stone for ever. If you add or reorder steps, keep
the index in the state.

**Gold moves THROUGH STONE, never food.** A gold pass ends when the side receiving the
carrier runs out of ROOM, and food caps at 950b a town (1t resets a city to 0) while stone
caps at 2,000b. Carried by food on 2026-09-26 the pass jammed with Lord08 holding 364t of gold
against 0.9t of food room; switched to stone the same banks had 97.8t of room for the ~5t the
remaining 740t of gold needed. **The sides flip per step**: a GOLD pass has the banks BUYING
the carrier, a RESOURCE pass has them SELLING it.

**`trade-advance.js` + the Windows task "OTTObot Trade Advance"** (the user, 2026-09-25:
*"if the food is done, move on to wood and then stone and then iron and a schedule task, so
all of them get completed … so we actually move everything from holiday into the unholiday
accounts"*). The task runs the script every 20 minutes; the script looks at the play that is
on and starts the next resource when the current one is finished, in the order
**food → wood → stone → iron**, then stops the play and cleans the reports.

It drives the Trading tab's own endpoints, so every guard above still applies.

**Check the holiday set against `BANKS` before every start, in code, and refuse if they
differ.** The roster changes daily and both lists go stale the moment the user moves an
account. The cheap version, worth pasting into any start script:

```js
const onHol = (setup.accounts || []).filter((a) => a.holiday === true).map((a) => a.id).sort().join(',');
if (onHol !== BANKS.slice().sort().join(',')) { console.log('REFUSING — holiday set does not match BANKS'); return; }
```

When the rotation happens, **FOUR places change in one edit** and none of them may be
forgotten:

1. `BANKS` in `trade-advance.js`
2. `OURS` in `trade-advance.js`
3. the `holi` list in `scripts/glitch-res-control.txt` (comment the old lines out rather
   than deleting them — that roster comes back next time those accounts are the banks)
4. `BANK_IDS` in `bank-truth.js`

Miss the fourth and `bank-truth.js` silently relogs the *wrong* accounts — on 2026-09-27 it
reconnected nine accounts that were mid-pass on our side while telling us nothing about the
banks we actually wanted.

### START A RESOURCE PASS AT 1, and judge it on FILLS not placements

On 2026-09-27 the food pass was started cold at price 3 and **deadlocked for 20 minutes**:
both sides placing ~17,000 orders every 3 minutes and **zero fills**. Relogs confirmed no
food moved and no gold left us, so it was not leakage — nothing crossed at all. Price 1
crossed within seconds (1,643 fills in 2.5 min).

- **Start at 1.** Step up to 2 or 3 only on a pass that is ALREADY crossing, checking fills
  after each step. Stone reached 3 by being walked up while trading, and was fine.
- **Judge on fills, never placements.** The tell is `ok=-97` ("this order is closed or
  nonexistent") when cancelling — it means the bid matched first. Both sides can look
  perfectly busy and achieve nothing.
- The mechanism is not understood and is NOT 'same price never crosses' — at 1 both sides
  are also on the same price. See EVONY-RULES.md.

### A pass slows because CITIES RETIRE — count them before diagnosing anything

A selling city whose stock falls under `keepRes + order` (1b + 0.1b = **1.1b**) goes quiet
**silently**. The account stays connected, prints no hold and no refusal, and nothing on the
Trading tab says the selling side has shrunk. So when volume drops, measure this FIRST:

```js
cityList.filter((c) => (c[res] || 0) >= 1.1e9).length   // live cities on the draining side
```

On 2026-09-27 the stone pass had **25 of 50** bank cities still able to sell — Lord20 0/10,
Lord21 1/10, Lord02 5/10, Lord03 9/10, Lord17 10/10 — so the order rate had halved
with nothing wrong. **A spot check lies**, because the last of the stock concentrates: one
Lord03 city showed ~709b while four of Lord02's held 0.01-0.14b. Print the
distribution, never the account total divided by ten.

Diagnose in this order: **live cities -> the tab's Return (leakage, and has the ladder walked
the price down?) -> the scripts.** Doing it backwards that day cost two wrong changes.

### The price ladder will undo a price you set by hand (2026-09-27)

`res-ladder.js` judges our share on **raw orders placed**, which our own cancel-and-replace
churn inflates 10-20x, so in a resource play it reads 400-1,000% every round and steps
**cheaper every time** until it bottoms out at 0.001. A price set by hand lasts about two
minutes: on 2026-09-27 a hand-set 3 went `3 -> 2` at 13:07 and `2 -> 1` at 13:17.

Before setting a price by hand, **turn the ladder off**:

```
POST /api/trading/setup {"ladder": false}
```

(or pick a price that is not one of its rungs — res 0.001/0.01/0.1/0.5/1/2/3 — which it
leaves alone.) And judge capture on the tab's **Return**, which nets cancelled bids off, not
on the ladder's percentage. See EVONY-RULES.md for the measurements.

### When the tab says 0 orders a minute but the scheduler says there is plenty left

**Believe the tab and relog.** `trade-advance.js` measures both sides from `account_latest`,
which lags ~20 minutes on a busy account. On 2026-09-27 it logged `gold: banks 1194.2t` and
kept the pass running; the banks had actually been empty since 10:12 and every bank city was
printing `SITOUT` and `canceltrade … has no open bids to cancel`. A relog put the truth at
**0.44t**, and the very next scheduled run called gold finished and started stone by itself.

    node bank-truth.js      # reconnects the banks, waits for a fresh snapshot, prints the truth

Do not force the next pass by hand — refresh the figures and let the schedule act on them.

**The other tell, on the bank's own console:** `FAILED (ok=-1) - Insufficient resources.
Required Gold 2147483647`. That number is INT_MAX (2^31-1), clamped into the error's int32
field — not an overflow bug and not the real requirement. It means the bank is **out of
gold**, and it shows up ~25 minutes before the snapshots admit it.

**"Finished" means any of three things**, because only one of them is "the banks are empty"
and all three mean *move on*:

| | what it means |
|---|---|
| banks hold < 1t | nothing left to move |
| our room < 1t | our towns are full — the rest resets to them at maintenance anyway |
| nothing moved in 25 min | the book is stuck; not worth waiting with three resources queued |

**Check our ROOM per resource before promising a clean sweep.** On 2026-09-25 the banks held
food 47.7t / wood 33.8t / stone 82.9t / iron 25.8t, and our 120 towns had room for
22.5t / 67.4t / 148.7t / 72.8t — so wood, stone and iron all fitted and **food could only
half move**, because our own towns were already at 85.5t against a 900b-a-town cap.
Room is `sum over towns of (cap - held)`, and the caps differ per resource.

Two bugs worth not repeating, both found by running it once before trusting it:
- **`view.control` IS the parsed control file** — `res` and `price` sit on it directly. Its
  own `play` field is the control file's `play = "auto"` variable, something else entirely.
- **Treat `starting` and `stopping` as running.** A start takes minutes (stop the old play,
  wait out the autorun gate, sides 60 s apart); calling that "not running" makes the script
  ask for a second start, which the Director refuses with *"a play is already starting"*.

Log: `trade-advance.log`. To stop it early:
`Unregister-ScheduledTask -TaskName 'OTTObot Trade Advance' -Confirm:$false`.

## What the user means

| The user says | Holiday accounts | Normal accounts | Price |
|---|---|---|---|
| **"glitch gold, through stone"** (or through wood, food, iron) | **BUY** the resource | **SELL** it to them | high — 150 is the box's maximum, 15b gold per order |
| **"glitch stone"** (or wood, food, iron) | **SELL** the resource | **BUY** it | low — the user uses 1–5 |
| "buy back the stone" | SELL the stone they bought during a gold glitch | BUY it back | low (1, then 3) |

"Glitch gold" moves **gold** from the holiday accounts into ours; the resource is only
the carrier. "Glitch <resource>" moves the **resource** into ours. If a request could
read either way, ask which direction before starting — getting it backwards gives our
gold or resources away for real.

Getting an account ready to go on holiday (goals off, queues and marches cleared) is the
**evony-holiday-prep** skill.

## The accounts (2026-09-20 — check the Director, this changes)

**The roster flipped on 2026-09-20:** the banks on holiday are now **a4 Lord04, a5 Lord05,
a8 Lord08, a9 Lord09** (holidayed with ~1,373t gold and 400-600b of each resource a town),
and **a3 Lord03, a6 Lord06, a7 Lord07 come OUT of holiday** that day — they take no
further part. The other side is **a10 Lord10, a11 Lord11, a12 Lord12, a13 Lord13,
a14 Lord14, a15 Lord15**. The control file's `holi` list and the small-account list
must be updated whenever this changes — they decide the safety lines.

## The older roster, for reference

- Holiday: **a3 Lord03, a6 Lord06 (in-game name `lord06`), a7 Lord07**. Lord03
  keeps nearly everything in one city.
- Normal, traded with: **a4 Lord04, a5 Lord05, a8 Lord08, a9 Lord09**.
- Added 2026-09-19 as buyers (the user): **a10 Lord10, a11 Lord11, a12 Lord12,
  a13 Lord13 (in-game all lower case), a14 Lord14, a15 Lord15 (in-game `Lord15`)**. They are
  short of gold, so the control file lets them keep buying down to **10m** gold (a
  `keepGold` override by lord name) — they gather cheap resources to sell later. Cities at
  the soft cap sit out and these carry on.
- Not part of it: a1 Lord22 (the maintenance monitor), a2 Lord02.
- A holiday account only works for this once it has been on holiday **across** a
  maintenance — the Director's "Market glitch ready" column.
- **Never glitch-trade with an account that is out of holiday.** Once it leaves holiday
  nothing comes back at maintenance, so every cheap sale or overpriced buy is a real loss.
  - Check each holiday-side account's status in the Director **before every start**.
  - Stop the play (`end` in the control file) **before** the user takes any of them out.
  - The scripts pick a side by lord name and do not check holiday status.
- **Putting accounts on holiday and taking them off is the user's alone.** Never do either.
- **The user's plan (told 2026-09-18) — this list goes stale by it:**
  - Fri 2026-09-18 and Sat 2026-09-19: glitch in full, as now.
  - **Sun 2026-09-20, before maintenance:** the user puts the four buyers (Lord04, Lord05,
    Lord08, Lord09) on holiday. **After maintenance**, once resources are restored, the
    user takes Lord06, Lord07, Lord03 and **Lord16** (not on this computer yet)
    out. Stop every play on them before that.
  - Then a day or two of trading while the resources are spread more evenly over those
    four accounts' cities (the caps below), after which the user puts them on holiday
    too — then eight holiday accounts sell for a week or two, to other accounts the user
    brings in closer to the time.

## The scripts

All in `scripts/`. Each side runs one script in every city on console autorun; one
**control file** is `call`ed by every city on every loop, so **everything in it applies
live within a second — edit it, never restart to change a price or a limit.**

- **Generic, both directions — prefer this:** `glitch-res-buy.txt` (the side that buys),
  `glitch-res-sell.txt` (the side that sells), control `glitch-res-control.txt`
  (`res` = food | wood | stone | iron, `price`, the limits).
  - "glitch stone": holiday accounts run `glitch-res-sell.txt`, ours run `glitch-res-buy.txt`.
  - "glitch gold through wood": holiday accounts run `glitch-res-buy.txt`, ours run
    `glitch-res-sell.txt`; set `res = "wood"` and a high `price`.
- **The first gold set, stone only:** `glitch-buy.txt` (holiday buys) / `glitch-sell.txt`
  (ours sell), control `glitch-price.txt`. Buyers are recognised by lord name there.
- Only one play at a time per control file: two plays at once would share one price.
- A `call` sees an edit to the control file within a second (it is cached that long).
  Before 2026-09-22 every `call` leaked memory and the trading consoles crashed out of
  memory every few hours (EVONY-RULES.md §7) — a console started before that fix still
  does, so restart it (with the user's OK) before a long play.

Each city places only as many orders as it has free offer slots (10 per city), and
re-lists our own offers of that resource at the current price when the price changes
(other offers are never touched).

**The put-back is random per town (2026-09-22 — this replaces "a town sold dry stays dry
for good").** When a town's put-back works, it comes back EXACTLY to what it held at the
previous maintenance. But any town, on any day, may fail, and sometimes just one resource
of it fails; a failed town usually glitches again once restacked. See "Daily bank
rotation" below. A town holding a sliver still has nothing worth selling. The Director's
Resources tab flags such towns, and `scripts/glitch-skip.txt` (called by the control file,
matched by COORDINATES — names repeat) makes a listed town sit the play out while its
account is on holiday. **Emptied 2026-09-22 12:20 (the user).** It had listed Lord06
700,120 and 709,112 and Lord07 704,109; those now sell like any other town. To trust one again: on holiday, sell ~10b from
that town alone and see whether the next maintenance brings it back.

**A seller needs gold for the fee** (0.5% of price x amount, paid when the order is
placed): at 150 that is 75m gold an order. `glitch-res-sell.txt` sizes the amount to the
city's gold so a poor city can bootstrap; don't remove that.

## The hard limits (the user's — never loosen without being asked)

- **Runway: every city keeps 10b.** A buying city stops before its gold would go below
  10b after one more order; a selling city stops before the resource would go below 10b.
  (`keepGold` / `keepRes`.)
- **FOOD: never past 950b in a city.** At 1t food a city's food **resets to 0**. A city
  buying food stops while its food plus a full batch plus every resting bid plus the food
  still **in transit** to it (bought goods travel) stays under 950b (`foodCap`). This is the one limit whose breach destroys something instantly — if
  you are unsure, leave food alone and ask.
- **Room under the caps (the user, 2026-09-22 12:00).** A buying city works out its room
  every loop: `cap − (held + in transit + its own resting bids)`. For food it also takes
  `foodCap − …` and uses whichever room is smaller. It places at most `maxOrders =
  floor(room / 100m)`, so 880b under a 900b cap = 200 more orders, then it stops exactly
  at the cap. It's live in the control file. Buy scripts started before then don't know
  `maxOrders`, so they sit out once less than a full batch (10 orders) fits.
  `glitch-res-buy.txt` sets `batchAware = 1` and uses it from its next start. The user
  asked for it after seeing 400b incoming on a city: incoming was already counted in the
  sitout, but a full batch plus resting bids could overshoot the cap by up to ~2b.
- **Caps — spreading the stock evenly (soft; the user's, 2026-09-18):** a city on OUR side
  that already holds plenty sits a transfer out — no order, no end — and joins again by
  itself when the cap goes up. `capRes` (400b): our buyers of the resource, counting what's
  in transit. `capGold` (40t): our sellers in a gold play. `play = "auto"` tells the two
  apart by price (50+ = a gold play); set `"res"`/`"gold"` by hand if a price is unusual.
  0 = no cap. The holiday side is never capped. The user raises them (e.g. to 500b) when
  everything nears the cap — the aim is 200–300b of each resource and 30–40t gold a city.
  A city that sits out prints `SITOUT … sitting out` once, and `SITOUT over` when back.
  The caps work in runs started after 2026-09-18 16:06 (older runs ignore them).
- **Stale balances:** a busy account's cached figures lag the server. The control file
  never trusts them past what the run itself has traded, and stops a city after 3
  "Insufficient resources" refusals in a row. Keep both when editing.
- **Pacing:** 1 s per loop for every account. The server rate-limits an account that
  trades very hard: it ignores it, then drops it. **Never restart a rate-limited account.**
  Lord06 had 3 s from 2026-09-18 after being ignored while trading hard. The user had that
  removed on 2026-09-22 12:25, since the early trouble was likely a start-up fluke. If
  Lord06 shows "no reply to trade.newTrade" in bulk again, tell the user; don't quietly
  slow it.
- **Runs never end by themselves any more (the user, 2026-09-22 13:17).** Every former
  `end` in the control file is now a **HOLD**: no order that round, one `HOLD <side>
  <res> — <why>` log line, `sleep 60`, then the file is read afresh. The reasons are: not
  on the holi list for a cheap-sell or dear-buy side, 3 "Insufficient" refusals in a row,
  and food within 2b of 950b. Out of a resource or under its runway, a city sits out
  every loop as before. So switching resource (Apply in the Trading tab, or an edit here)
  reaches every run live. Only `end` as the file's first line (the tab's Stop) still ends
  runs. What still kills a run is a console restart or relog without its autorun, which
  the tab's watchdog puts back.

## Running a play

1. §0 of EVONY-RULES.md: the accounts are switched on (switching one on is the user's
   call), each has its own tested proxy, maintenance isn't due, no other session is
   mid-restart. **Every holiday-side account shows holiday in the Director** and is
   "Market glitch ready". If one isn't, don't start. Ask.
2. **Set it up in the Trading tab and Start from there** — see *ALWAYS run the play
   through the Director's Trading tab* above. `POST /api/trading/setup` with the sides and
   the play, `GET` it back until `check.errors` is empty, then `POST /api/trading/start`.
   The tab orders the sides itself (buyers, then sellers 60 s later) and works around the
   10-minute autorun gate. The user asked on 2026-09-25 that every play go this way.
3. Snapshot first: `node glitch-run.js snap "before" --reset` (reading only, still useful).
4. FALLBACK ONLY, when the tab cannot do it — the **buying side first**, so its bids are on
   the book before the selling:
   `node glitch-run.js start --buy <ids> --buy-script <file> --sell <ids> --sell-script <file>`
   This restarts those consoles (it kills whatever they were running) with the script on
   autorun; every city starts it after login. It does NOT know about the autorun gate, and
   it leaves the Trading tab showing a stale play — tell the user, and reconcile the tab.
5. Watch: the Director's **Trading** tab (the play, 10-minute returns, 5-minute bars, each
   account's speed, sit-outs and connection — read off the console logs, refreshed every
   15 s; trade-monitor.js), or `node glitch-run.js flow` (orders per account over the last two minutes), and
   `node glitch-run.js snap "<label>"` every 10 minutes or so.
6. **Switch resource mid-play** (e.g. stone → iron) in the control file: `res = "iron"` and
   `prevRes = "stone"`. Every city then cancels our offers of the old resource (freeing
   their slots), restarts its counting, and trades the new one — no restart. A city already
   under the runway for the new resource just ends.
   - **Make both edits in ONE write.** The control file is re-read before every batch, so
     any gap between two edits is a gap the whole fleet acts on. On 2026-09-20 the resource
     was changed while a stop rule keyed on the old one was still in the file, and six
     accounts' runs ended inside a minute.
   - **CLEAN THE REPORTS AT EVERY SWITCH** (the user, 2026-09-20). Every filled order
     leaves a trade report, so a day of this runs them into the hundreds of thousands. So
     the switch is: edit the control file, then restart each trading account onto
     `clean-then-buy.txt` / `clean-then-sell.txt` — the account's FIRST city runs
     `cleanreports` while its other nine keep trading, then joins them. The switch is the
     cheapest moment for it: the books are being cancelled and re-listed anyway.
     Trade reports clean fine beside the trading; ARMY reports silence the whole account
     for a few minutes (EVONY-RULES.md §7), which is why this is not done mid-play.
   - The restart is worth having in its own right at a switch: it revives runs that have
     ended and clears order books that have stalled full. Mind the **autorun gate** —
     an account restarted under 10 minutes ago runs nothing at all.
     The Trading tab's **restart gate** (minutes, in the setup; 0 = at once — the user,
     2026-09-22) replaces that wait for the tab's own starts: it dates the console's last
     autorun start back past 10 minutes just before it restarts it. Starts by hand
     (`glitch-run.js start`) still meet the console's 10 minutes.
   The user's switch rules (2026-09-18): check every 30 min; switch when an interval's
   return is under 25%, or once 6 or fewer holiday cities hold more than 10b of the
   resource. Count that from the LIVE figures: relog the holiday accounts (restart with the
   same script) — each city's first line is `FRESHSTART <side> food … wood … stone … iron …`
   — never from the cached ones. Stock sits in a few cities per account.
7. **Tune live** in the control file: the price, the limits. **Stop** every city of a play:
   put `end` as the control file's first line — every run ends on its next loop — then
   put the file back as it was.

## A day's rotation (the user, 2026-09-19)

Once the holiday gold runs out after maintenance: FOOD (0.01 → 0.1 → 1), then WOOD, IRON,
STONE (start at 1) — each until its holiday sellers or our buyers run dry. Food is bought
by every normal account incl. the small new ones; the rest only by the rich ones (the
control file ends the small ones' runs on anything but food). Late at night the small
accounts SELL their food to the holiday accounts at 150 so they have gold for the next
day. Stop everything (`end`) before a maintenance after which the user changes holidays.
The user's price ladder (14:20): every resource starts at **0.01**; a 10-minute reading
under 40% → 0.1 → 0.5 → 1 (up only). On 2026-09-19 food went 0.01 (28–34%) → 0.1 (61–73%).
Iron is what the fleet lacks most. To use Fleet Feet on the transports at the same time, restart the
four buyers onto `fleetfeet-then-buy.txt` (two each on the next account, then the buy loop).
A switch writes the control file first and then restarts buyers, then sellers, with
`glitch-run.js start` (ended runs don't revive by themselves).

## Running the day (the user, 2026-09-20)

The aim is to **move as much off the holiday accounts as possible each day**. So:

- **A side that stops right after a price step is not proof the resource is done** — relog
  one account and read FRESHSTART (2026-09-22: Lord04 "finished" with 200b wood in 4 cities;
  the tally bug is fixed in the control file, but verify).
- **Keep the watchdog's lists to accounts that can trade this play.** An account out of
  the resource, or whose console fails every login, gets restarted every 12 minutes for
  nothing — drop it from `--buy`/`--sell` (2026-09-22: Lord15, Lord16).

- **War Town 05:00–10:00 on every trading account** (the user, 2026-09-22: marches take a
  lot of time). Each of a2–a16 carries an APPEND goal layer `config wartown:1` +
  `wartownpolicy 05:00 10:00` (goals table, cityKey 'append'). Lord02 (a2) gets the War
  Town window too (the user, 2026-09-22) — but it is NOT a trading account. In the window no NPC farming, valley runs or
  transports leave, and marches heading out are recalled, so they are home for the 08:15
  holiday prep, the 09:00 maintenance and the gold pass. A NEW trading account needs the
  same append row. Check it took: `engine_state` shows `war.wartown.on: true`.
- **Gold moves TWICE a day**: right after maintenance, and again before the next one. Their
  gold refills through the day as we buy their resources up, so the second pass collects
  what the first could not.
- **Resource plays: buyers keep only 100m gold** (the user, 2026-09-22 10:00) — at 0.001–0.1
  an order costs 0.1–10m gold, so a 10b runway only shut the poorer cities out. The six
  small accounts keep 10m. Food starts at **0.001** that day (the user, expecting a lower
  return, so the low-gold cities get some); food cap 600b throughout.
- **Gold cap 50t a city** (the user, 2026-09-22 09:37). With six rich banks (~1,100t) the
  25t cap parked our sellers within a minute of the gold pass; check SITOUT lines before
  blaming the fleet when the return drops.
- **Gold price: start at 150 and walk it DOWN** — 150 → 140 → 130 … when the return falls.
  150 is the box's maximum and the most gold an order carries, but it is also the most
  attractive bid on the market, so rival sellers pile into it. A lower bid is less worth
  their while and keeps more of it for us. `res-ladder.js --mode gold` does this.
- **Resources in between**, one at a time, each on its own ladder
  (`res-ladder.js --res <name>`): over 80% capture step cheaper, under 60% step dearer.
- **The Trading tab's ladder is the user's to configure** (2026-09-22):
  - Setup → price ladder: resource rungs and gold rungs (cheap → dear; the default
    resource rungs start at 0.001), the step-our-way / step-back shares, and the reading
    interval.
  - The on/off switch and every setting apply to a running play; no Stop/Start needed.
  - It moves only a price that is one of its rungs, one rung at a time, never past either
    end.
  - It follows a live resource switch instead of standing down.
  - The user's price is the user's: the ladder won't jump onto a rung from an off-ladder
    price.
- **Watch the volume every 30 minutes** (`play-manager.js`). A fall of **75% or more** is
  the trigger to investigate — never to act.

### When the volume falls: NEVER decide on a cached figure

This is the mistake to design against. The Director's and the snapshots' figures for a
holiday account are **cached and lag badly** on a busy account, and a dry resource and a
dead fleet look identical from the outside. Twice on 2026-09-20 the wrong call was made
from stale numbers. The order is:

1. **Which accounts have gone quiet?** An account whose last log line is a `[conn]` line,
   or that has placed nothing for 10 minutes, is dead — restart it. That alone explains
   most falls. (2026-09-20: Lord05 dead 101 minutes; three banks idle after a refresh.)
2. **Relog ONE holiday account** and read what it prints on login — `glitch-res-sell.txt`
   echoes `FRESHSTART sell food … wood … stone … iron …` per city from a fresh session.
   That is the only figure to judge on. One account is enough to tell whether the resource
   is gone.
3. **Then decide.** Under ~10b a city left (the runway) the resource really is finished —
   move to the next one, with the switch procedure above (one write, then the
   clean-then-* restart). Otherwise the stock is fine and the fall is the fleet.

## Daily bank rotation (the user, 2026-09-22)

**The put-back is random per town and even per resource** (EVONY-RULES.md §4). A normal
day brings back 8–9 of a bank's 10 towns in full; after 09-20 it was 1, 2, 5–6 and 9 of
10 on the four banks. A town that failed usually glitches again once restacked. So the
banks are rotated, and choosing the rotation is part of every day:

1. **Every morning after maintenance: measure each bank's put-back, per town, per
   resource**, from a FRESH relog (FRESHSTART lines), against what it held going into
   maintenance (the 08:30 morning record). Write the per-town result down — which towns
   came back, which resources did not — in GLITCH-LEDGER.md. This is how we learn whether
   failures follow any pattern.
2. **Before the next maintenance, propose the rotation to the user:**
   - **INTO holiday:** the normal accounts holding the MOST resources (restocked by the
     day's buying) — those give the most to trade tomorrow. They must be on holiday
     *before* maintenance to count tomorrow.
   - **OUT of holiday** (after maintenance): the banks whose put-back failed worst — they
     get restocked by trading as normal accounts, then go back in a day or two later.
   - Holiday in/out is **the user's own click** — propose, never do it. Before an account
     goes in: stop its play runs and run evony-holiday-prep (goals/queues/marches) **at
     08:15** — the user: 08:30 is already too late for a 09:00 maintenance. Before
     one comes out: `end` every play it is in.
3. **Update the control file's `holi` list** (in-game lord names) the moment the user
   changes a holiday — it guards the SAFETY lines — and swap the sides in glitch-run
   starts, the watchdog, `res-ladder.js` and `play-manager.js` (their BANKS/OURS lists).
4. Don't read a failed town as dead: `glitch-skip.txt` entries are a choice to revisit
   after the town is restacked, not a permanent rule.

The plan on 2026-09-22: **Lord06, Lord07, Lord03, Lord16 and Lord14 go INTO
holiday before the 09:00 maintenance**; **after it Lord04, Lord08 and Lord09 come OUT**
(put-backs on 09-21: 4/10, 2/10, 1/10 — a failed town sits drained at ~10b, and the
put-back can only return it to that, so Lord04 would bank with just 4 towns; restack it
instead). So from after TODAY's maintenance: 6 banks (Lord05 + those five) against Lord04,
Lord08, Lord09, Lord10, Lord11, Lord12, Lord13, Lord15 — plus 3–5 more buyer
accounts the user brings in during the day (port them to the hub). The rotation's balance counts from the maintenance they go in before, not the
day after. Accounts going in stock up first: food cap 800b for them vs 600b for the rest.

## What really ends a gold pass: the banks run out of ROOM, not gold (2026-09-25)

A gold play is limited by the **carrying capacity of the side that BUYS the resource**, and
that limit arrives long before their gold does. Food is the usual carrier and a city's food
may never pass 950b (at 1t it resets to 0), so each bank town can absorb only
`950b - what it already holds`.

The 2026-09-25 pass moved **2,180t of 3,092t (70%)** and then stopped dead with 913t still
in the banks. Nothing was broken — the gold and the room had ended up in DIFFERENT accounts:

| bank | gold left | food room | extractable |
|---|---|---|---|
| Lord08 | 423.9t | 0.02t | 2.3t |
| Lord15 | 213.6t | 0.13t | 19.2t |
| Lord09 | 121.7t | 0.05t | 7.0t |
| Lord05 / Lord11 / Lord14 | 0.1t each | 12.2t | — |

759t of gold sat in three banks whose every town was at the cap, while the banks with room
had nothing to spend. Only 182t of the 913t could still move.

**So: check gold AGAINST room per account, not in total.** A fleet total looks fine
(17.5t of room, 913t of gold) and hides the mismatch completely. The early check that
matters is `min(gold, room x price)` **per bank**, summed — that is the real prize.

**The unblock is a round trip:** flip to a RESOURCE pass (the full banks SELL that food back
at 0.001, our accounts buy it), which empties their towns, then flip back to gold. It costs
nothing — the food is theirs, it returns to them at the next maintenance, and we keep it.
Watch OUR room on the way back (110 towns x 900b against what we already hold).

**And the price cannot rescue it:** 150 is the box's maximum, so you cannot buy more gold
per unit of food. Room is the only lever.

If the user would rather not do the round trip, the rest simply waits for maintenance: the
banks' food resets to what they held at the last one, freeing every town, and their gold
comes back too.

## Measuring

- **Capture / return** = the share of the holiday side's trading that lands with our
  accounts rather than other players'. **Count orders, not balances**: the holiday side's
  placed orders (in `flow`) against ours, over the same window. Balances mislead both
  ways: a busy holiday account's snapshot can be stale, and **goods bought on the market
  travel to the city** — the gold leaves when the order fills, the goods land minutes
  later — so a buying account's resource figure lags what it has really bought.
  A buyer's GOLD drop (at a known price) is a good cross-check: 100.5m per filled
  99,999,999 order at price 1.
- Seen 2026-09-18: gold glitch at 150 — ~70% in its first minute, ~76% right after
  maintenance (other bots still loading), ~30% once they're back, **0% once undercut**. When
  our offers stop filling, the holiday side is only feeding other players: tell the user
  and pause or reprice (they chose to reprice, 150 → 100).
- The user's rule for buying back stone: start at 1, measure over 3 snapshots 10 minutes
  apart, keep 1 if at least 50% returns, otherwise go to 3.
- **Record every run in the ledger** — the user wants the pattern of how the other traders
  react, over many days. After a run (or every half hour of a long one):
  `node glitch-run.js ledger --holiday <ids> --ours <ids> --from <hh:mm> --to <hh:mm> --record "run N: …; the events that bend the numbers"`
  appends 5-minute buckets to `glitch-ledger.csv`; then add the run's events and anything
  new about the competition to `GLITCH-LEDGER.md` (its "What the data shows" and
  "Questions" sections). Over 100% return means other players traded into our orders too.
- **A slow buyer? Check its proxy's round trip before anything else** (2026-09-29).
  The order rate falls as the proxy gets farther away: with enough cities trading,
  buyers on proxies 5–20 ms from the VPS and a23 with no proxy ran at ~1,960/min, and a
  proxy ~230 ms away (a30) at ~1,110/min. Per-socket round trip on the VPS:
  `ss -tnpi state established` (the `rtt:` field), matched to accounts via
  `ACCOUNT_ID` in `/proc/<pid>/environ`. See EVONY-RULES §1, "Proxies". Rule out fewer
  cities trading and rate limiting first (a20, a26, a25 were slow for those reasons).

## The Glitch log (Trading → Glitch log, 2026-09-23)

The Director keeps its own record of every maintenance now, so a day's glitch can be read
back weeks later: **what every town of every account held going in, what it held coming
out, the difference per resource, and the runs of that day** — filtered by date, opened a
day at a time. It is the answer to "did the put-back actually happen, and where didn't
it", which order counts alone can never give.

How to use it during a play:

- **Before a run, look at yesterday.** A bank town whose wood came out flat two
  maintenances running is a town not to sell dry — what leaves it is gone.
- **The per-town cells read `in → out` with the difference.** On a holiday account the
  "out" should be what it went into the *previous* maintenance with.
- **`live` vs `cached` per town matters.** `live` means that account was logged in afresh
  just before the record, so the figures are the server's; `cached` means they are the
  console's, which lags badly on an account being traded hard (EVONY-RULES §3). Never
  judge a town on a `cached` row.
- The **runs** under each day carry the play, the price, the sides and when it started and
  stopped — the ledger (`glitch-ledger.csv`) still holds the minute-by-minute capture, and
  these two are read together.

What it does to the fleet, and it is not nothing:

- **It relogs every account ~10 minutes before the announced maintenance**, to make the
  "before" figures honest. **That ends every city's running script and nothing puts it
  back** (EVONY-RULES §4). In practice the play is over by then — the stand-down is 5
  minutes later — but if a run is meant to go right up to the window, switch the relog off
  in the tab (the record still happens, marked `cached`) or expect to restart the play.
- It never relogs on a day nobody heard the announcement, and never inside the stand-down.
- **Relog the fleet now** on that tab does the same thing on demand — same cost, and it
  asks first. Use it before reporting any balance, which was already the rule.

## After maintenance

**Restart the play fresh right after maintenance** (the user, 2026-09-19: "right after maint
do the gold xfer as soon as possible"). Runs that carried on through maintenance still count
the pre-maintenance balances (`startGold`/`startRes`) and end early; a fresh
`glitch-run.js start` counts the restored ones. Trigger: a holiday account's settings row
`maintEnded:<id>` (written when it's back). The consoles come back on the announced end
plus however long the port takes to answer — check the log for `port is open — login
attempt N after maintenance`.

The user's experience: other players' bots take 15–30 minutes to load after maintenance.
On 2026-09-18 capture fell from ~80–90% to ~44% within 5 minutes — see the ledger. Either
way the first minutes are the best of the day. Since 2026-09-20 **every account comes back
on the clock**: stand down five minutes before the announced start, back at the announced
end, then a free port check every 30 s until the game answers. The monitor/follower race
is off (`OTTO_MAINT_RACE=1` brings it back) — it bought no speed and killed Lord22's
proxy. Expect the fleet in within a minute of the server's real return, not instantly.
Runs that had ended stay ended: they need a new start
(`glitch-run.js start`) when the holiday accounts' gold or resources are back.

### If the accounts don't come back after maintenance

Check the **process and its listening port**, not the log's last line — a console waiting
through a maintenance writes nothing (fixed 2026-09-20, but not live until it restarts):

    Get-NetTCPConnection -State Listen | ? OwningProcess -in (Get-Process node).Id

If the consoles are alive but out, read `maintOver:<server>` and `maintWindow:<server>` in
the **org's** settings. If `maintOver` is older than the window's start it is a stale
signal from a previous day and every follower is stuck on it — which is what happened on
2026-09-19 and 2026-09-20. Set `maintOver:<server>` to `Date.now()` and they all log in
within ~10 s, no restart. Only once another account is verifiably logged in.

Then leave them alone: an account that has just logged back in and is restarted a few
seconds later answers `no reply to server.LoginResponse` and drops onto the 60s/120s ladder.

### A "maintenance" in the middle of the day is usually THIS PLAY (2026-09-25)

The play at full throttle can stall the server and stand the whole fleet down, hours after
the real maintenance. On 2026-09-25 (real maintenance over at 09:19) every console lost its
socket between **11:05:13 and 11:06:15** with

    heartbeat failed (no reply in 30s, 20 market writes in flight) — cycling the socket

the last frames sent being four `trade.newTrade`, and the scripts already saying
`no reply to trade.newTrade (server is ignoring this account — rate limited)`. Too many
market writes in flight → no reply → the heartbeat times out → the console closes its own
socket. All 21 did it inside a minute, the Director read that as the server going down, and
wrote a window with `"3 consoles lost the game socket at once"`. 21 accounts stopped for
15 minutes and every running script stopped with them.

**Before believing a mid-day maintenance, check the game port.** It is open in this case
and closed in a real one:

    node -e "require('./evony').getServerConfig('ss71').then(c=>{const s=require('net').connect(c.port||443,c.host);s.setTimeout(5000);s.on('connect',()=>{console.log('OPEN');s.destroy()});s.on('error',e=>console.log('closed',e.message));s.on('timeout',()=>{console.log('TIMEOUT');s.destroy()})})"

Port open + a `maintWindow` whose `text` counts dropped sockets + `maintEnded:*` already
dated today = a fake window. Release it the same way as a stale signal above
(`maintOver:<server>` = `Date.now()`). Nothing in the Director cancels one for you.

Going back in, **turn the throttle down** or it happens again on the next pass — it is the
writes in flight per console that do it, not the number of accounts.

## Did the script reach every town? (2026-09-23)

The mechanism does guarantee it: `startAutoruns` (server.js) loops over **every** castle and
starts the RUNSCRIPT in each, and `clean-then-buy.txt` / `clean-then-sell.txt` run
`cleanreports` in the FIRST city only — every other town falls straight through to
`call "glitch-res-buy.txt"` / `..-sell.txt`. A town is skipped only if it already has a run
(impossible right after a console restart) or the script fails to parse.

**Proving it afterwards is the hard part, and two obvious checks are traps:**

- **`cities[].script` in `/api/session` is always `null`** for an autorun run — nothing
  fills it. It read `0/10` on all 21 accounts while every one of them was visibly trading.
  Don't use it.
- **The `[autorun <city>]` prefix in `console-<id>.log` is the city NAME, and names repeat.**
  Lord10 has nine towns called "New city"; counting distinct prefixes said "2 towns" for
  an account whose ten were all trading. It is a floor, never a count.
- And per EVONY-RULES §4, **read the log as utf8, not latin1** — an em-dash or `·` in the
  regex silently matches nothing (this cost a whole reading of "0 orders everywhere").

What does work, until the log carries coordinates: **orders placed per account per 2
minutes** from the `N of 10 placed` lines. A town that has its ten offers resting logs
nothing at all (the `full` branch, `sleep 0.3`), so a quiet account means "its book is full
and waiting for fills" or "it is out of the resource" — check the snapshot's resource
column to tell those apart, never the silence.

## The small accounts run out of resource long before the gold cap (2026-09-23)

On the 09:30 gold pass, the six new accounts (Lord01, Lord17, Lord18, Lord19, Lord20,
Lord21) held only ~0.1t of stone each — about 10b a town. At 150 that is ~90 orders a
town, ~1.35t of gold a town, and they were **dry inside seven minutes**: Lord01 14.2t →
29.2t gold with stone 0.106t → 0.005t, Lord17 14.7t → 30.5t, Lord18 15.1t → 29.9t, Lord21
14.7t → 29.3t, all four then silent with nothing left to sell.

So a gold cap of 20t **a town** (= 200t an account) is not a plan for an account that holds
no resource. Sizing rule: an account can only take in
`(its resource − keepRes) / 99,999,999 × price` of gold. To fill the poor accounts, give
them resource first (a cheap resource play out of the banks) and run the gold pass after —
otherwise the whole bank balance lands on the few rich sellers that already have the stone.

## Keep it true

When a play teaches something new — a capture figure, a price that worked or didn't, a
limit, a failure — add it to `EVONY-RULES.md` (dated, how observed) and, if it changes how
to run a play, to this skill.

## Turning the play around (2026-09-24)

When the direction reverses — the banks stop selling a resource and start buying one —
**the side that is about to BUY must cancel its old offers before it can do anything**.
Its ten slots still hold the asks from the play before, `free = cap - tradesArray.length`
is 0, and it places nothing at all while its old cheap asks sit on the book for rivals.
The control file's per-offer cancel loop does not clear them.

So the reversal is: edit the control file in ONE write (res, price, prevRes, the limits),
then restart

- the new BUYING side onto `cancel-clean-then-buy.txt` — bare `canceltrade`, then
  `cleanreports trade` in the first city, then `glitch-res-buy.txt`;
- the new SELLING side onto `clean-then-sell.txt` (or `cancel-then-sell.txt` if it is
  coming off a play where it was the buyer).

`cleanreports trade` — not bare `cleanreports` — while a play is live: trade reports clean
fine beside the trading, army ones silence the whole account for a couple of minutes
(EVONY-RULES.md §7). Sweep army and other when the fleet is idle.

**Debugging a side that does nothing:** the control file is `@call`ed, and `@` means silent,
so nothing it says — holds, cancels, refusals — reaches the log. Put the echo in the
calling script instead (`glitch-res-buy.txt` keeps a `DBG` line for it). A loop that comes
round once a MINUTE rather than every second or two is sitting in the control file's
60-second HOLD, silently.

## Getting back into the play after a hand-run (2026-09-24)

A script run by hand in a city **ends that city's autorun run** — one run per city — and
nothing puts it back, so any hand-run stops that account trading until its console is
restarted. The console's Script tab now has a **Quick… dropdown** beside Run for exactly
this: picking **"Turn trading back on"** starts `glitch-res-buy.txt` / `-sell.txt` again in
every city that has no run of its own, in one click and with no restart.

The list is `scripts/quick-scripts.txt`, read on every ask, so entries are added by editing
that file — `Label | script file | all`, where `{side}` in the file name becomes the side
this account is on in the Trading tab's setup. The code is `quick-scripts.js`
(`test-quick-scripts.js`), served by `/api/script/quick`; **a console has it only after it
restarts**.

## A seller that places nothing and says nothing (2026-09-24)

Stock in the town, no `SITOUT` line, and the log only shows `sleep 0.3` coming round: the
console is on a **stale trade list** and thinks all ten slots are taken. A `canceltrade`
does not clear it — the list is the console's cache and only a fresh login re-seeds it.
**Restart that account's console**, then confirm with `glitch-run.js flow` that it is
placing. It can happen to an account that was *already* restarted once (EVONY-RULES.md §4).
