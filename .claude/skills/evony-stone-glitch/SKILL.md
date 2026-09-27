---
name: evony-stone-glitch
description: Moves a hero from one of our Evony accounts to another for free, using capture plus a Stone of Finding instead of nation medals ("the stone of finding glitch"). Use when the user says "stone of finding glitch", "move a hero to <account>", "give <account> an insta catapult/trebuchet hero", "pass a hero through accounts", or asks to build a hero by passing it between accounts.
---

# The Stone of Finding glitch — moving a hero between our own accounts for free

**Heroes are the most valuable thing in the game.** A slip here does not cost troops, it
costs the hero, for good. Work the checklist below every single time, in order, and never
skip a step because "it worked last time". The user (2026-09-20) asked for exactly that:
a set, streamlined routine, because one day this will be used to pass a level-5000 hero
between accounts.

**Read `EVONY-RULES.md` first** (§0 checklist, §5 heroes and items).

## Why it works

Persuading a captured hero costs **nation medals** — roughly **9.1% of its level**, so
about **92 medals for a level 1000 hero**, plus level × 1,000 gold. That is the cost this
routine avoids entirely.

- A **Stone of Finding** (`lostheroes` / `recover`, `stone-of-finding.js`) brings back a
  hero you lost — **free, while the captor has NOT persuaded it**.
- Once the captor persuades it, the hero is theirs: recovering it then costs a stone
  **and** the medals. So the whole game is keeping the hero in the **captive
  (unpersuaded)** state the entire time.

**Nothing persuades by itself.** The game only persuades when someone clicks Persuade, and
OTTObot only persuades on an explicit `persuadehero` line. Likewise it **never releases a
prisoner automatically** (goal-heroes.js says so and makes you type `release <name>`). So
the free window stays open as long as no person and no script touches it.

## The three-account chain

To move a hero from **A** (the donor, e.g. Lord06 or Lord07) to **B** (the account
that should end up with it), with **C** as a third account:

| # | Who | What | Cost |
|---|---|---|---|
| 1 | A | attacks **B** with the hero and 1 scout, on repeat, until B captures it | the scout |
| 2 | — | the hero is now **captive, unpersuaded**, on B | — |
| 3 | A | `recover <hero>` — stones it back off B | **stone 1** |
| 4 | A | attacks **C** with the same hero, until C captures it | the scout |
| 5 | B | `recover <hero>` — stones it off C | **stone 2** |
| 6 | — | the hero is B's, and no medal was ever spent | — |

**Two stones, one from each side** (the user: "1 from lord06 or whoever holds the hero and
1 from the account getting the hero"). **C is what makes step 5 possible**: B can never
stone a hero straight off A, because a stone only recovers a hero that was taken from
*you* — step 3 is what puts it on B's lost list in the first place.

The same hero can be bounced round the loop as often as you like.

## THE CHECKLIST — every transfer, in order

**Before the hero leaves home:**

1. **Stones in hand.** Both A and B hold at least one Stone of Finding, checked in the
   inventory, **before anything marches**. `lostheroes` prints the list and the count. No
   stone on B means the hero ends up parked on C with no way home.
2. **The hero is idle** — not the mayor (`unmayor` first), not marching, not defending, not
   already a prisoner. A hero that is out **cannot be stoned back**: in this routine it must
   always be sitting captive when a stone is spent.
3. **The hero is protected from firing on both sides.** Check `keepheroes` /
   `herofirelimit` on A and `keepcapturedheroes` on B and C. Once a hero is persuaded,
   `fire` loses it like any other.
4. **No `persuadehero` anywhere** — not in a goal, not in a job script, not from a person
   looking at the Feasting Hall. Persuading closes the free window and every later step
   then costs medals.
5. **No `releaseheroes` or `release` line** on the capturing account. A released prisoner
   is gone for good.
   Since 2026-09-22 a **`keepcapturedheroes` line also releases** the prisoners it does not
   keep, so check it on B and C the same way. A hero of one of OUR accounts is safe
   whatever the line says -- the fleet register (`fleet_heroes` in `evony.db`) remembers
   every hero the fleet has ever held and the bot refuses to release one that is on it, by
   id or by name -- and this routine only ever moves our own heroes, so the guard covers
   it. A hero captured from a **stranger** on purpose is NOT on the register: protect that
   one with the keep line, or set `OTTO_NO_RELEASE=1` on the capturing console for the run.

**On the capturing side (B, then C):**

6. **Feasting Hall room in the city being attacked.** The capture chance rises with free
   slots and **a full hall can never capture at all** — 10 heroes in a level 10 hall means
   it will never work, however many times you attack. Count the heroes in that exact city,
   prisoners included: they hold slots too.
7. **Room again for the recovery.** The city a hero is stoned *into* needs a free slot as
   well; `recover` refuses on a full hall and says so.

**The trip:**

8. **Short.** March time is the whole cost of the loop, because it repeats until a capture
   happens. If the two accounts have no cities near each other, the capturing side takes a
   **valley next to the sender** and defends it — an attack on a valley can take the hero
   just as a city can, as long as the defender is a **real player** and **the troops stay
   in the valley**.
9. **Those troops must not be recalled.** NEAT pulls troops out of a valley by default, and
   on our side `config wartown:` and `hiding` both recall everything. Check the capturing
   account's goals for either before you start — an empty valley means the attacker simply
   takes the valley and the hero comes home.
10. **Right target, nobody else in the fight.** Attacking the wrong player, or another
    player taking that valley mid-loop, loses the hero. Send to one named target and watch
    it.

**The attack itself:** the hero plus **1 scout**, on repeat. Capture is a chance, not a
certainty, so it takes several attempts — that is normal and why the trip has to be short.

## The commands

```
lostheroes                      the list of heroes you have lost, with levels, ids and the stone count
recover <hero> [to <city>]      spends one stone, puts it in this city (or the named one)
unmayor                         frees a hero that is its city's mayor, so it can march
attack <x,y> <hero> s:1         the hero and one scout — repeat until captured
keepcapturedheroes <string>     protects a persuaded prisoner from firing
persuadehero <name>             NEVER in this routine — it is what we are avoiding
release <name>                  NEVER on the captor's side — the hero is gone for good
```

`recover` matches a name in any case, takes an id when two heroes share a name, and sends
nothing without a stone or for a name that is not on the list. A dry run reads the list and
stops there. `useitem player.item.stoneoffinding` is refused and points you here.

## What it is for

The immediate use (the user, 2026-09-20) is giving every account its two insta heroes: a
**1066-politics** hero for instant defensive trebuchets and a **1526-attack** one for
instant catapults (1221 is enough with an Excalibur). Lord06 and Lord07 hold dozens of
spares; a9, a10, a11, a12, a13, a14 and a15 have none. The donor list and which hero goes
where is the plan section in `EVONY-STRATEGY.md`.

Longer term the user wants to build a level-5000 hero by passing it between accounts, so
**this routine has to be reliable before it is fast**.

## The scripts (built 2026-09-22 for cptkush, Lord15 -> Lord09 via Lord11)

- `scripts/stonemove-control.txt`: the live control, @called every loop: `smHero`, `smA`
  (A's city holding the hero), `smB` / `smC` (the capturing cities), `smGoB = 1` (B
  recovers now), `smHalt = 1` (every stonemove run ends).
- `scripts/stonemove-a.txt` on A: only city `smA` acts (the others `call` the buy script
  and keep trading). `resetgoals` + `config hero:0` there first, so the mayor plan can't
  re-appoint the hero. Then it unmayors the hero, attacks `smB` with it and 1 scout until
  it's gone from the city (status 4, or missing 3 looks 10 s apart), `recover`s it, and
  does the same against `smC`. Then it tells you to set `smGoB = 1`.
- `scripts/stonemove-b.txt` on B: only city `smB` acts. It prints the hall level and hero
  count, prints `lostheroes` every 5 minutes, and recovers when `smGoB = 1`.
- `scripts/hall-read-then-buy.txt`: every city prints `HALLREAD <city> <xy> hall L<n>
  heroes <n>`, then trades on. It's how you read C's halls without stopping its trading.
- **`$error` is `null` when a line worked, never `""`.** Test `if $error != null` or `if
  $error`. The first cptkush run had `if $error != ""`, which fired after every success.
  After a good `recover` it would have logged FAILED and ended the chain. It was caught on
  the first attack and fixed before any stone was spent (2026-09-22 11:09).
- Restarting A mid-march is safe: the march carries on server-side, and the script picks
  the hero up by its status.

- **Take A and B out of the Trading tab's run first** (`run.buy` / `run.sell` in the
  org's `tradingRun`), or wait for no play at all. On 2026-09-22 the tab's watchdog saw
  Lord15's console "up with no script", because New city places no orders, and restarted
  it onto the buy script at 11:21:37. That killed stonemove-a after attack 4. The hero had
  been captured just before, so the chain survived; a minute earlier it would have been
  left marching with no script behind it.

## Keep it true

**First live run, 2026-09-22: cptkush (L1470, att 1529) Lord15 -> Lord09 via Lord11
— it works exactly as the user described.**
- 11:08:47 A attacks Lord09 4 (705,118). Captured on the **first** attack (lost
  11:09:54).
- 11:10:47 A `recover`s it (Lord15 stone 158 -> 157). At that same second the hero
  appears on **B's lost list** (stamped 04:10:47 server time). That's the step the glitch
  rests on, now seen live.
- 11:17–11:20 A attacks Lord11 New city 711,119 (L10 hall, 1 hero). Captured on the
  **4th** attack; `status 4` (captive) on Lord11.
- 11:26:41 B `recover cptkush` -> "cptkush L1470 is back in 4" (Lord09 stone 216 ->
  215). On Lord09: level, attack and politics unchanged, **loyalty 100** (it was 20 on
  Lord15). Two stones, no medals, 18 minutes. The user renamed it OTTO by hand. Record what actually happens — how many attacks a capture
took, whether the valley trick was needed, anything the server said — here and in
`EVONY-RULES.md`, dated.

## The direct move: capture, then persuade (2026-09-23)

The user's own call when medals are plentiful: skip the stones and the third account
entirely — A attacks B with the hero until B captures it, and **B persuades it**. One
march loop, no stone, no C. `scripts/heromove-control.txt` + `heromove-a.txt` (sender) +
`heromove-b.txt` (receiver) run it, and the receiver finishes the job the way the fleet
needs it: `persuadehero`, then the old OTTO is renamed `{level}A{attack}` and the new hero
becomes **OTTO**, so `traininghero OTTO` and `keepherobuff OTTO excalibur /below:1526`
both pick it up without another edit.

- **Leave the alliance first.** You cannot attack an alliance mate, so the SENDER quits
  (`quitalliance confirm`) — 10% of its prestige, the user's choice of who pays it.
- **Rename the hero by ID before it marches.** Lord16 held two `attkush` and three
  `cptkush`; `attack <target> <name>` takes the FIRST match, so without unique names the
  wrong hero marches. `renamehero <id> <name>` is the guard.
- **Pick the receiving city for Feasting Hall room**, not distance: a full hall never
  captures. Lord16's heroes went to towns with 5-9 free slots, 5-9 tiles away.
- Live figures, three heroes from Lord16 698,118: **captured after 2, 5 and 8+ attacks**
  with the hero + 1 scout against towns holding 60k-260k troops.
