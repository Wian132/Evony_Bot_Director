# How we play Evony — and where the fleet is going

The user's account of how the game is played today, and what OTTObot is being built
towards. Written 2026-09-18 from the user's own words. [EVONY-RULES.md](EVONY-RULES.md)
holds the game's rules and what must never happen; this file holds the **why**, so a
request like "make Lord04 a bank" or "start the builders" makes sense without a history
lesson. Update it when the plan moves.

---

## The game today

Evony Age 1 was built with the battle mechanics in EVONY-RULES.md §5b. It has been "dead"
for over 10 years. Only a few players are left on it (server ss71), and they have made it
their own:
- Most of the glitches are known and used.
- Battle mechanics are well understood.
- **Bots run everything**, so one player runs **hundreds of accounts**.

**Heroes and items are what matter most.** Resources and troops can be mass-produced.
A strong hero normally takes years to build. The fast methods (below) take weeks or
months and cost enormous resources. Anything that could lose a hero (a lost battle, a
`release`) is the costliest mistake there is.

## Account roles

For a fleet of about 100 accounts, a typical split (it depends on a lot):

| Role | How many | What it does |
|---|---|---|
| **Alt** | ~85 | Small account that **farms NPCs** for resources and sends them to the dump. Its marches are always out, so it can't teleport, truce or holiday. |
| **Dump** | 1 | An **empty city** that collects the alts' resources. Mains and builders **attack it with transporters** to take the resources, which is how they are moved. |
| **Builder** | ~8 | **Builds troops non-stop**, with an insta hero as mayor. Fed by the alts through the dump, and later by banks. |
| **Spammer** | ~5 | **Protects the attacking heroes** (below). Keeps an **inn in every town**, with 9–10 low-level heroes at **0 loyalty**. |
| **Main** | 1–5 | A big account: a lot of resources, heroes and items. **Mostly on holiday**, because nobody wants a main killed while they're at work or asleep. |
| **Bank** | the plan: ~10 | An account on **holiday** holding a large, even spread of resources and gold. It **trades them out through the market** to our accounts outside holiday, and at each maintenance gets them all back (the glitch, EVONY-RULES.md §4). |

**Builders and banks swap roles in cycles.** They are the same accounts (Lord04, Lord05,
Lord08, Lord09 and the ones the user adds soon), not separate ones. See the dream, below.

### Spammers: why they exist

When an attack **loses**, the defender can **capture the attacking hero**, then persuade it
(it joins them) or release it (it's gone; see EVONY-RULES.md §5 on Stones of Finding).
But the attacks worth making need **big heroes**, because they do more damage.

So spammers land a series of **loyalty 0/1 low-level heroes 1 second before** the attack
with the good hero lands. The throwaway heroes arrive first and take the capture risk
ahead of the big one. The inn in every spammer town keeps replacement heroes coming.

This makes **landing times to the second** part of attacking. It's the same kind of
timing as the extra-cities trick (EVONY-RULES.md §5).

## The fleet on 2026-09-20 — who is what, and the insta-hero plan

The user set this out on the morning of 2026-09-20, after the roster flipped.

### Who is what today

| Group | Accounts | State | What they are for |
|---|---|---|---|
| **Mains** | a3 Lord03, a6 Lord06, a7 Lord07, a16 Lord16 | **out of holiday** this morning | The real accounts: the biggest heroes and the most resources. They keep **prepend goals at all times** — at the very least truce, Speech Text, comfort and the hero lines — because they are the accounts worth protecting. |
| **Banks** | a4 Lord04, a5 Lord05, a8 Lord08, a9 Lord09 | **on holiday** since 2026-09-20 08:2x | Holidayed holding ~1,373t gold and 400-600b of each resource a town. Their gold and resources come back at every maintenance, so they feed the fleet through the market (EVONY-RULES.md §4). Their goals were **emptied** for the holiday — the texts are in `goals-backup-2026-09-20.json` and must go back. |
| **Growing** | a10 Lord10, a11 Lord11, a12 Lord12, a13 Lord13, a14 Lord14, a15 Lord15 | normal | Being seeded with resources and gold. They sell food to the banks for gold, and buy cheap resources when a play runs. |
| **Utility** | a1 Lord22 (maintenance monitor), a2 Lord02 | normal | Lord22 probes for the end of maintenance and never trades; Lord02 is the test account. |

Eight accounts are on holiday in all — the four banks and four the user holds elsewhere.

### What the insta heroes are for

Everything is aimed at **producing troops and wall defences as fast as the server allows**.
Two numbers matter (EVONY-RULES.md §5 has the full tables):

- **Attack 1526** on the mayor = **instant catapults** (every cheaper troop too). With an
  Excalibur running (+25%) a base of **1221** is enough while it lasts.
- **Politics 1066** on the mayor = **instant defensive trebuchets**, the dearest
  fortification (rolling log 965, archer's tower 826, abatis 745, trap 607).

So every account wants at least one hero over 1526 attack and one over 1066 politics. The
mains have heroes far past both; the growing accounts have none.

### Every account's best heroes (read live 2026-09-20 09:25-09:51)

From `scripts/hero-list.txt` on autorun — `HEROLIST` lines in each `console-<id>.log`,
read back with the scratch script `heroes.js`. Attack and politics are the hero's own
numbers; an Excalibur's +25% sits on top of the attack.

| Account | Heroes | Best attack | Insta catapult? | Best politics | Insta treb? | Second by level |
|---|---|---|---|---|---|---|
| a1 Lord22 | 7 | OTTO L648 — att 714 | no | Noel L22 — pol 88 | no | Noel L22 |
| a2 Lord02 | 35 | OTTO L842 — att 912 | no | Pol66P257 L433 — pol 499 | no | Att66A691 L805 (att 871) |
| a3 Lord03 | 43 | kingkush L1400 — att 1459 | with Excalibur | QUEEN2 L1008 — **pol 1070** | yes | 6hen L1351 (att 1404) |
| a4 Lord04 | 84 | OTTO L1398 — att 1466 | with Excalibur | queenkush L1189 — **pol 1209** | yes | queenkush L1189 |
| a5 Lord05 | 84 | OTTO L1563 — **att 1590** | yes | queenkush L1476 — **pol 1506** | yes | queenkush L1476 |
| a6 Lord06 | 84 | bosskush1 L3841 — **att 3926** | yes | QueenKush L1229 — **pol 1259** | yes | Wian L1651 (att 1642) |
| a7 Lord07 | 69 | bosskush L3216 — **att 2458** | yes | queenkush1 L1102 — **pol 1148** | yes | KingKush L1774 (att 1894) |
| a8 Lord08 | 83 | OTTO L1352 — att 1439 | with Excalibur | queenkush1 L1007 — **pol 1068** | yes | queenkush1 L1007 |
| a9 Lord09 | 82 | OTTO L1038 — att 1103 | no | QueenTreb L1027 — pol 1053 | rolling log only | QueenTreb L1027 |
| a10 Lord10 | 32 | OTTO L1829 — **att 1917** | yes | npc10 L912 — pol 941 | no | npc10 L912 |
| a11 Lord11 | 63 | Att66A624 L783 — att 849 | no | Pol118P379 L322 — pol 440 | no | Att60A628 L759 (att 819) |
| a12 Lord12 | 74 | Kush L918 — att 993 | no | Pol115P486 L405 — pol 520 | no | Att64A708 L693 (att 757) |
| a13 Lord13 | 90 | Alger L868 — att 916 | no | SuperQueen L469 — pol 584 | no | Ryan L836 (att 890) |
| a14 Lord14 | 71 | Kush L199 — att 269 | no | POLITICS L280 — pol 417 | no | Elsa L238 (pol 360) |
| a15 Lord15 | 45 | kush L1084 — att 1105 | no | QUEEN L511 — pol 571 | no | Att75A880 L805 (att 880) |
| a16 Lord16 | 53 | bosskush L4716 — **att 4781** | yes | queenkush L1847 — **pol 1895** | yes | queenkush L1847 |

**Where the fleet stands:** 6 accounts have an insta-catapult hero (a5, a6, a7, a10, a16;
a3, a4 and a8 get there with an Excalibur) and 7 have an insta-trebuchet hero. **a1, a2,
a11, a12, a13, a14 and a15 have neither**, and a9 is 13 politics short of the trebuchet.

### The plan from here (the user, 2026-09-20)

1. **Every account gets a hero over 1526 attack and one over 1066 politics.** The mains
   hold plenty of spare big heroes; the growing accounts hold none.
2. **Holy Water turns an attack hero into a politics one.** Where an account's best hero is
   an attack hero well above its best politics hero (a15 Lord15's kush L1084 att 1105,
   a12's Kush L918, a13's Alger L868), Holy Water re-rolls the points, so the level already
   earned can be turned into politics. `waterhero` works live (2026-09-22, a12 Kush: 92 Holy
   Water, base att 75 · pol 26 · int 32, so all-politics would read pol 944) — **always with
   `/heropoints="pol"`**: without it the points go straight back into attack (EVONY-RULES.md §5).
3. **Levelling** is the other route: a hero gains XP by defending (the highest-attack hero
   in the city defends) and from the amulet farm — see "Training heroes" below.

**Open question, do not assume:** the user speaks of *moving* insta heroes from the mains
into the other accounts. Evony Age 1 has no hero transfer between players that we have
found — a hero only changes hands by being **captured** when its owner loses a battle, and
a Stone of Finding brings it back to the owner, not to the captor. Before planning any
move, ask the user what they have in mind, or find the mechanic and record it here.

## Giving every account an insta-catapult and an insta-trebuchet hero (plan, 2026-09-20)

**Status 2026-09-22: the user moved the attack heroes around by hand on 2026-09-21** — so the
attack-hero part of this plan is done; don't redo it from the table below (it predates the
moves). Any account can serve as an NPC10 hammer now. Re-read the live hero lists before
acting on the politics part.

Written 2026-09-20 from the hero table above, the raw `HEROLIST` lines behind it (999
heroes across the 16 accounts) and the user's brief: *"each account should have a 1066
politics hero and a 1526 attack hero. Keep the politics heroes naked, the attack heroes
can have +25%. The best heroes stay where they are, so the weakest heroes that are
instant treb and instant pult get transferred. Heroes can also be holy watered."*

This is the **what** — which hero, which account, why. The **how** (capture and Stone of
Finding) is the user's own routine and is not settled here.

### The two bars

- **Insta catapult: attack 1526.** Excalibur is +25% and we hold plenty, so **attack 1221
  qualifies** as long as the buff is kept running (`keepherobuff OTTO excalibur
  /below:1526` as a prepend goal, EVONY-RULES.md §5).
- **Insta trebuchet: politics 1066, naked.** No Wealth of Nations, so the hero's own
  politics must reach 1066.

### What Holy Water can and cannot do — the arithmetic

A hero gets **one attribute point per level**, and a reset gives all of them back. So the
most any one stat can be made to read is **that stat's base + the hero's level**.

Three things follow, and they decide most of this plan:

1. **Watering a politics-dominant hero gains nothing.** Its points are already in
   politics, so its base politics is `politics − level` and the ceiling is the politics it
   already has. a10's `npc10` L912 pol 941 is 125 short of the bar and watering it would
   return exactly 941. Same for a9's `QueenTreb` L1027 pol 1053 — 13 short, ceiling 1053.
2. **An attack hero's politics IS its base politics**, because its points all went to
   attack. So its ceiling is `politics + level`, and that is where the gains are: a15's
   `kush` L1084 (att 1105, pol 67) waters into about **1151 politics**.
3. **The gain equals the points currently sitting in the other stats** — nothing more.

**The per-attribute base is not in the data.** The HeroBean carries only `power`,
`management`, `stratagem` (points already included) and `remainPoint`. `base` on the hero
bean is `Game.heroBase` — the **top** attribute less the level plus unspent points, i.e.
the dominant stat's base only. The individual bases come back from the server **after**
`hero.resetPoint`, when the Holy Water has already been spent. So every ceiling below is
computed as `politics + level` and is exact **only if no points were spent on politics**,
which holds for every hero in this plan (their politics reads 9–67, far below any plausible
base-plus-points figure). `scripts/hero-list-base.txt` prints `bsum` (the three bases added
up) so a split build gives itself away before water is spent on it.

There is **no permanent attribute item** in the client's item table — the medals
(`hero.loyalty.1..9`) are loyalty only, and Excalibur / The Wealth of Nations / The Art of
War are 7-day buffs. Holy Water and levelling are the only ways a hero's own numbers move.

### Where the fleet stands

Against the 1221 (buffed) catapult bar and the 1066 naked trebuchet bar:

| | Accounts short | |
|---|---|---|
| **Insta catapult** | **8** | a1, a2, a9, a11, a12, a13, a14, a15 |
| **Insta trebuchet** | **9** | a1, a2, a9, a10, a11, a12, a13, a14, a15 |

Fleet stock: **44 heroes at attack 1221+** (a6 18, a7 12, a16 8, a3 2, a4/a5/a8/a10 1 each)
and **20 heroes at politics 1066+** (a6 8, a7 4, a3/a4/a16 2 each, a5/a8 1 each). Supply is
not the problem; moving them is.

**Do a1 and a2 need them?** — the user asked, so:
- **a1 Lord22: no.** One city, seven heroes, best attack 714. It exists to probe for the
  end of maintenance and never trades or builds. Two big heroes would sit idle.
- **a2 Lord02: yes, but last.** Four cities, and it is the test account — the first live
  `waterhero`, the first mayor swap, the first instant-training check all belong there
  rather than on a main. One of each so those can be rehearsed. Low priority, not zero.

So the working target is **seven accounts: a9, a10, a11, a12, a13, a14, a15**, plus a2 as
an eighth if there is spare.

### Holy Water instead of a transfer

Two accounts can solve their own trebuchet, which is cheaper than a move:

| Account | Hero | Today | After water | Cost | Why it is safe |
|---|---|---|---|---|---|
| **a15 Lord15** | `kush` L1084 | att 1105, pol 67, int 7 | **pol ~1151** | **109 HW** | 1105 × 1.25 = 1381, never an insta catapult, so nothing is lost. Margin 85 over the bar. |
| **a9 Lord09** | `OTTO` L1038 | att 1103, pol 46, int 35 | **pol ~1084** | **104 HW** | Same: 1103 × 1.25 = 1379, short of 1526 whatever happens. **Margin only 18** — check `bsum` before spending. |

Notes:
- a9 has a **free** alternative: `QueenTreb` L1027 is pol 1053, thirteen short. Thirteen
  more levels with the points into politics gets there at no item cost — about 1.4b hero XP
  on the amulet farm (100 × level² per level). Prefer this if the farm is running.
- a9's `OTTO` is its training hero, so watering it means a9's best attack hero changes and
  the OTTO name moves (EVONY-RULES.md §5: OTTO is the account's best hero; a renamed one
  becomes `{level}Att{attack}`).
- **a10 Lord10 must not water.** Its only candidate is its own `OTTO` L1829 (att 1917),
  the fleet's third-best attack hero. It receives a trebuchet hero instead.
- Nobody else can self-solve: a2, a11, a12, a13, a14 hold no hero whose `politics + level`
  reaches 1066 at all.
- **Stock is unknown.** The only inventory we hold is a1 Lord22's, cached in
  `accounts.json` on 2026-09-12: **1,284 Holy Water**. What the mains hold is not recorded —
  `scripts/hero-list-base.txt` prints a `HEROSTOCK` line per account to settle it.

### The transfers — insta trebuchet (5 moves)

Weakest qualifying hero first, every account keeping its best:

| # | Hero | From | To | Why it is the weakest that qualifies |
|---|---|---|---|---|
| 1 | `2` L1023 **pol 1068** | a6 Lord06 | **a10 Lord10** | Lowest politics of any movable trebuchet hero in the fleet. a6 keeps seven more (best QueenKush 1259). |
| 2 | `QUEEN` L1008 **pol 1069** | a3 Lord03 | **a11 Lord11** | Second lowest movable. a3 keeps QUEEN2 (1070). |
| 3 | `queenkush` L1043 **pol 1071** | a7 Lord07 | **a12 Lord12** | Weakest of a7's four; a7 keeps 1096, 1105 and 1148. |
| 4 | `Queen` L967 **pol 1072** | a6 Lord06 | **a13 Lord13** | Next up the list, and the lowest-level trebuchet hero we have (L967). |
| 5 | `ROCKHARD` L1022 **pol 1076** | a6 Lord06 | **a14 Lord14** | Next again. |
| 6 *(optional)* | `HR6910` L1034 **pol 1079** | a6 Lord06 | *a2 Lord02* | Only if a2 is included. a4's `Wian` L1027 pol 1079 is an equal alternative. |

- **a8 Lord08's `queenkush1` L1007 pol 1068** is the second-weakest in the whole fleet but is
  **a8's only trebuchet hero** — locked, it cannot move.
- **Watch a3 Lord03.** Move 2 takes its spare and leaves a main on one trebuchet hero at
  +4 over the bar. Strictly weakest-first says take it; if you would rather not leave a main
  with no spare, take a6's `HR6910` L1034 pol 1079 instead and lose nine points of margin.

### The transfers — insta catapult (6 moves)

Every one of these needs an Excalibur running to clear 1526; the user accepted that.

| # | Hero | From | To | Buffed | Why it is the weakest that qualifies |
|---|---|---|---|---|---|
| 1 | `TrainMe` L1106 **att 1223** | a6 Lord06 | **a11 Lord11** | **1529** | The weakest hero anywhere in the fleet that clears 1526 with the buff — three points over. |
| 2 | `TrainMe` L1107 **att 1230** | a6 Lord06 | **a12 Lord12** | 1538 | Next up. |
| 3 | `kush` L1186 **att 1246** | a7 Lord07 | **a9 Lord09** | 1558 | Weakest of a7's twelve. |
| 4 | `Wian` L1199 **att 1266** | a6 Lord06 | **a13 Lord13** | 1583 | Next up. |
| 5 | `TrainMe` L1150 **att 1268** | a6 Lord06 | **a14 Lord14** | 1585 | Next up. |
| 6 | `CptKush` L1221 **att 1287** | a7 Lord07 | **a15 Lord15** | 1609 | a7's second weakest. |
| 7 *(optional)* | `TrainMe` L1164 **att 1288** | a6 Lord06 | *a2 Lord02* | 1610 | Only if a2 is included. |

**Margin 3 on move 1 is entirely Excalibur-dependent.** Every recipient needs the
`keepherobuff OTTO excalibur /below:1526` prepend goal from the day the hero lands, or the
catapults stop being instant the moment the seven days run out.

### What each donor gives up

| Donor | Catapult heroes | Trebuchet heroes | After the plan |
|---|---|---|---|
| a6 Lord06 | 18 | 8 | gives 4 + 3 → keeps **14 and 5**, including bosskush1 (att 3926) and QueenKush (pol 1259) |
| a7 Lord07 | 12 | 4 | gives 2 + 1 → keeps **10 and 3**, including bosskush (att 2458) and queenkush1 (pol 1148) |
| a3 Lord03 | 2 | 2 | gives 0 + 1 → keeps **2 and 1** (kingkush att 1459, QUEEN2 pol 1070) |
| a16 Lord16 | 8 | 2 | **untouched** — none of its heroes is the weakest that qualifies; its lowest catapult hero is att 1327 |
| a4, a5, a8, a10 | 1 each | 1–2 | **untouched** — a4 could spare its second trebuchet hero (Wian pol 1079) if a2 is included |

### The moves, most valuable first

1. **Trebuchet into a10 Lord10.** a10 already has the fleet's third-best attack hero
   (`OTTO` L1829, att 1917, instant catapults naked) and ten cities, but nothing over
   politics 941. One hero turns it into a complete builder. Biggest gain per move by a
   distance.
2. **Holy Water a15's `kush` L1084** → politics ~1151, 109 HW. No transfer, no risk to any
   other hero, and it leaves a15 needing only a catapult hero. Run the first live
   `waterhero` on a throwaway low-level hero on a2 first (EVONY-RULES.md §5).
3. **a9 Lord09's trebuchet** — either 13 levels on `QueenTreb` (free, slow) or 104 HW on
   `OTTO` L1038 (fast, margin 18). Check the arithmetic on the hero before spending.
4. **Catapult + trebuchet into a11 Lord11** — 10 cities, best attack 849, best politics 440.
5. **Catapult + trebuchet into a12 Lord12** — 10 cities, best attack 993, best politics 520.
6. **Catapult + trebuchet into a13 Lord13** — 10 cities, 90 heroes, best attack 916.
7. **Catapult into a9 Lord09** — 10 cities; its `OTTO` att 1103 tops out at 1379 buffed.
8. **Catapult into a15 Lord15** — 5 cities, so fewer walls and barracks to feed.
9. **Catapult + trebuchet into a14 Lord14** — 8 cities, but by far the weakest account
   on the roster (best hero L199, att 269). It will take the longest to put them to work.
10. **a2 Lord02, one of each** — 4 cities, the test account. Worth it so hero work can be
    rehearsed off the mains.
11. **a1 Lord22 — skip.** One city, monitor only.

### Where we are genuinely short

**Nowhere, if a hero can be moved at all.** 44 catapult-capable and 20 trebuchet-capable
heroes against 16 accounts is comfortable. The constraint is the mechanic, not the stock.

**If moving a hero turns out not to work**, the picture is much worse and worth saying
plainly:
- Only **a9 and a15** can reach 1066 politics on their own, through Holy Water.
- **a2, a10, a11, a12, a13, a14** have no hero and no reachable ceiling for the trebuchet.
- **a1, a2, a11, a12, a13, a14** have none for the catapult either (a9 and a15 top out at
  1379 and 1381 buffed — still short).
- For all of those the only route is levelling on the amulet farm, which is weeks to months
  per hero.

### Still to settle

- **Per-attribute base is not readable before the reset.** Every ceiling here assumes no
  points were spent on politics. `scripts/hero-list-base.txt` (read-only, written
  2026-09-20, **not yet run**) prints `pts` (unspent), `bdom`, `bsum` and both ceilings so
  each candidate can be checked before water is spent. Run it on the next console restart.
- **Holy Water stock per account is unknown** — only a1's 1,284 (2026-09-12) is recorded.
  The same script prints a `HEROSTOCK` line with Holy Water, its packs, Excaliburs and
  Wealth of Nations.
- Some heroes read a base of 120–150 rather than the usual 20–70 (e.g. `a5 Geoff` L5 att
  128). All are low level and none affects this plan, but it means the fleet holds heroes
  born well above 100 base — worth knowing when picking a hero to level.
- Whether the server **rounds or floors** the Excalibur 25%. At attack 1223 it is the
  difference between 1529 and 1528, and both clear 1526, so nothing here depends on it.


## How a city is built

For a builder or main with an insta hero (EVONY-RULES.md §5 has the exact levels):

- **One barracks is enough.** At insta attack, training is instant, so there's no point
  splitting orders across barracks.
- **Everything else goes to cottages.** More cottages means more population, which means
  more troops.
- **Popraise** (raising population with the town hall's comforting actions) boosts
  population further.
- **Research** needs the stable, forge and workshop only until it is maxed. After that,
  they and the **warehouses** can be demolished to make room for more cottages.
- **The inn** can go once the city has its **9 heroes**. Spammers keep theirs.
- **That is the whole removal list**: extra barracks, stable, forge, workshop, warehouses,
  inn. Everything else stays, including the **academy, embassy and feasting hall** (and
  the marketplace, which trading needs). The Town Hall and the Walls are never demolished
  (EVONY-RULES.md §5). Never demolish anything else without asking.
- Insta attack also means instant troops. **Politics** makes wall fortifications instant,
  and **intelligence** speeds research. Put the right hero in as mayor *before* queuing,
  because the time is fixed when the order is queued.

## Holiday vs truce

These facts are in EVONY-RULES.md §5. Why they matter:
- **Holiday pauses everything.** That is why mains live on holiday, and why banks work at
  all: resources put back at each maintenance — usually. The put-back fails at random
  per town (sometimes per resource), so banks are **rotated daily**: the accounts holding
  most go into holiday before maintenance, the banks whose put-back failed worst come out
  to be restocked (2026-09-22; EVONY-RULES.md §4, evony-glitch "Daily bank rotation").
- **A truce is 12 hours of peace**, but troops still eat.
- Neither is allowed with outgoing attacks. So alts, whose marches are always out, can't
  use them.

## Training heroes: the amulet and XP farm

The fastest way to build a hero and the main source of amulets:

1. A **designated defending account** sits in **5K / range defence**: at least one trap,
   abatis or treb (EVONY-RULES.md §5b). It holds enough **ballista and catapults, and no
   other troops**, to defend with **0 losses**.
2. **Builders with insta-catapult heroes** (1526 attack, 1221 with Excalibur) build
   catapults non-stop and attack it, usually **5k–10k catapults per attack**.
3. The attackers heal **65%** of their lost catapults with **Penicillin**.
4. The **defending hero** gains the experience. That is the highest-attack hero present in
   the city, idle or mayor, so the higher-attack heroes are **sent out** first to make
   sure the right hero trains.
5. The attacks drop **amulets**, roughly 1 per 3–8 attacks (the user's estimate).
   Thousands of amulets, spun, give thousands of coins, "onwars" and other items.

With about 50 accounts attacking like this, a **level 1500–2000 hero takes weeks to
months**. Hero XP needed for the next level is 100 × level².

## The farm, laid out: defender 704,119 and twenty launchpads (2026-09-25)

The plan above says *what* the farm is. This says **where**, worked out against the map
scan of 2026-09-24 17:02-19:15 (640k tiles in `map_cache`) and the client's own research
and building tables. Nothing here has been moved yet.

### The numbers it is built on

All from `WarReport.swf` and EVONY-RULES.md §5b, and **confirmed live 2026-09-25 06:49** by
`travelinfo 704,119 cp:7500` run from Lord07's 700,110 (9.85 tiles out): attack
1h:22m:04, reinforce 13m:41 at Relief Station ×6, carrying 1,125,000 / −4,004,614 / 270,064.
Every figure below matched to the second. Every account has all 20 researches at L10.

| | |
|---|---|
| catapult attack speed | 80 x 1.5 (Horseback L10 is +50%, not +100%) = 120 -> **8m20s a tile** |
| catapult reinforce speed | x6 (Relief Station L10) = 720 -> **1m23s a tile** |
| march range | **no limit** — the food/carry figure is a client-window rule the server does not enforce (proved live, below) |
| marches out of one city | **10** (Rally Spot L10) |
| heroes in one city | **10** (Feasting Hall L10) |
| loyalty cost of a wave | **none** — a wave only takes loyalty when the attacker *wins* (the user) |

So a launchpad at distance *d* lands **10 x 3600 / (d x 500)** waves an hour, and because a
wave dies at the target, the slot frees on landing. **Distance is the throughput**: a tile at
d=1 is worth 72 waves/hour, at d=2 thirty-six, at d=4 eighteen. That is what the site was
chosen on, not on centrality.

### Why 704,119

About half of every neighbourhood in this hub is valley, and no city can stand on a valley.
Nowhere within x 670-750 / y 90-165 has more than 16 of its 24 nearest tiles usable. Ranking
every candidate by the throughput of its best twenty launchpads:

| tile | owner today | ring 1 | within 2.16 (cp range) | within 2.9 | waves/hour | swaps |
|---|---|---|---|---|---|---|
| **704,119** | Lord12 | 6/8 | 10/12 | 16/24 | **803** | 13 |
| 705,119 | Lord10 | 7/8 | 10/12 | 14/24 | 805 | 14 |
| 704,120 | Lord12 | 7/8 | 10/12 | 14/24 | 789 | 13 |
| 702,119 | Lord09 | 3/8 | 6/12 | 15/24 | 686 | 11 |
| 701,112 (middle of today's seven `main` cities) | — | — | 8/12 | 9/24 | far lower | — |

704,119 and 705,119 are a dead heat; 704,119 takes it on one fewer swap, more tiles inside
pure-catapult range, and a shorter mean reinforcement leg (9.2 tiles to all 210 fleet cities).
**Today's seven cities called `main` sit around (701,112), one of the worst spots in the hub** —
they move south, the defender does not move north.

The hub can only grow **east, west and south**: 6-22 tiles out, the northern sector holds 57
foreign cities against 2-3 in each of the others.

### The twenty launchpads

803 waves/hour = **19,300 a day** with every rally slot busy — far past what the fleet will
actually produce, which is the point: the ring should never be the limit.

| # | account | launchpad | tiles | one-way | waves/h | on it today | action |
|---|---|---|---|---|---|---|---|
| 1 | Lord09 (a9) | 703,119 | 1 | 8m20s | 72 | Lord09 | stays |
| 2 | Lord12 (a12) | 704,120 | 1 | 8m20s | 72 | Lord12 | stays |
| 3 | Lord10 (a10) | 705,119 | 1 | 8m20s | 72 | Lord10 | stays |
| 4 | Lord02 (a2) | 704,118 | 1 | 8m20s | 72 | Lord09 | **swap** — Lord09 moves out |
| 5 | Lord11 (a11) | 705,120 | 1.41 | 11m45s | 51 | Lord11 | stays |
| 6 | Lord04 (a4) | 705,118 | 1.41 | 11m45s | 51 | Lord09 | **swap** — Lord09 moves out |
| 7 | Lord08 (a8) | 704,117 | 2 | 16m40s | 36 | Lord08 | stays |
| 8 | Lord06 (a6) | 702,119 | 2 | 16m40s | 36 | Lord09 | **swap** — Lord09 moves out |
| 9 | Lord07 (a7) | 704,121 | 2 | 16m40s | 36 | Lord11 | **swap** — Lord11 moves out |
| 10 | Lord13 (a13) | 706,119 | 2 | 16m40s | 36 | Lord12 | **swap** — Lord12 moves out |
| 11 | Lord14 (a14) | 702,120 | 2.24 | 18m40s | 32 | Lord11 | **swap** — Lord11 moves out |
| 12 | Lord15 (a15) | 703,121 | 2.24 | 18m40s | 32 | Lord12 | **swap** — Lord12 moves out |
| 13 | Lord16 (a16) | 705,121 | 2.24 | 18m40s | 32 | Lord12 | **swap** — Lord12 moves out |
| 14 | Lord17 (a17) | 706,120 | 2.24 | 18m40s | 32 | Lord11 | **swap** — Lord11 moves out |
| 15 | Lord03 (a3) | 702,117 | 2.83 | 23m35s | 25 | Lord03 | stays |
| 16 | Lord18 (a18) | 706,117 | 2.83 | 23m35s | 25 | Lord12 | **swap** — Lord12 moves out |
| 17 | Lord19 (a19) | 707,119 | 3 | 25m00s | 24 | Lord12 | **swap** — Lord12 moves out |
| 18 | Lord05 (a5) | 705,116 | 3.16 | 26m20s | 23 | Lord05 | stays |
| 19 | Lord20 (a20) | 701,118 | 3.16 | 26m20s | 23 | Lord03 | **swap** — Lord03 moves out |
| 20 | Lord21 (a21) | 701,121 | 3.61 | 30m05s | 20 | Lord12 | **swap** — Lord12 moves out |

Twelve more usable tiles sit at 3.6-4.5 tiles for the next accounts, and 52 within 6.

### The fourteen swaps

Every tile in the zone is already ours, so **no captures and no fighting** — these are
internal swaps. Only four accounts give ground, because they are the ones who clustered
there: Lord12 loses 7 cities from the zone, Lord09 3, Lord11 3, Lord03 1.

Each one runs through the **`evony-city-swap` skill**: the taker loops on the tile first, the
holder moves off it second, and both accounts are relogged before the next pair starts.
Destinations below are free tiles 6-13 tiles out (so still one relief-speed hop from the
launchpad) — **re-probe each one on the day** with `scripts/teleport-probe.txt`: the map
cache cannot see who owns a flat.

| taker | tile taken | holder today | holder sends that city out to | taker moves in this city |
|---|---|---|---|---|
| **Lord01 (a1) — the defender** | **704,119** | Lord12 | 710,122 (war, NPC 5) | 704,127 (its closest) |
| Lord02 (a2) | 704,118 | Lord09 | 711,121 (adv, flat) | 694,122 (d10.4, its furthest) |
| Lord04 (a4) | 705,118 | Lord09 | 700,126 (adv, flat) | 692,109 (d15.6, its furthest) |
| Lord06 (a6) | 702,119 | Lord09 | 703,127 (adv, flat) | 708,109 (d10.8, its furthest) |
| Lord07 (a7) | 704,121 | Lord11 | 702,127 (adv, flat) | 179,701 (d783.8, its furthest) |
| Lord13 (a13) | 706,119 | Lord12 | 706,127 (adv, flat) | 716,103 (d20, its furthest) |
| Lord14 (a14) | 702,120 | Lord11 | 701,127 (adv, flat) | 695,123 (d9.8, its furthest) |
| Lord15 (a15) | 703,121 | Lord12 | 707,127 (adv, flat) | 716,119 (d12, its furthest) |
| Lord16 (a16) | 705,121 | Lord12 | 706,128 (adv, flat) | 689,104 (d21.2, its furthest) |
| Lord17 (a17) | 706,120 | Lord11 | 701,128 (war, NPC 5) | 713,108 (d14.2, its furthest) |
| Lord18 (a18) | 706,117 | Lord12 | 697,126 (adv, flat) | 691,119 (d13, its furthest) |
| Lord19 (a19) | 707,119 | Lord12 | 714,118 (adv, flat) | 715,108 (d15.6, its furthest) |
| Lord20 (a20) | 701,118 | Lord03 | 713,124 (adv, flat) | 687,129 (d19.7, its furthest) |
| Lord21 (a21) | 701,121 | Lord12 | 714,122 (adv, flat) | 691,124 (d13.9, its furthest) |

### Which city is called `main`

The fleet prepend carries one line, `keeptroops main cp:100k`, and it resolves per account.
A city name is looked up with `.find`, so **two cities called `main` in one account means the
goal silently takes whichever comes first** — no warning, no error. So exactly one `main` per
account, and it is the launchpad. Rename the old one *before* naming the new one.

| account | its `main` becomes | called `main` today | action |
|---|---|---|---|
| Lord02 (a2) | 704,118 | — | name 704,118 `main` |
| Lord03 (a3) | 702,117 | 703,115 | rename 703,115 first, then name 702,117 `main` |
| Lord04 (a4) | 705,118 | 702,110 | rename 702,110 first, then name 705,118 `main` |
| Lord05 (a5) | 705,116 | 702,112 | rename 702,112 first, then name 705,116 `main` |
| Lord06 (a6) | 702,119 | — | name 702,119 `main` |
| Lord07 (a7) | 704,121 | 698,110 | rename 698,110 first, then name 704,121 `main` |
| Lord08 (a8) | 704,117 | 701,111 | rename 701,111 first, then name 704,117 `main` |
| Lord09 (a9) | 703,119 | 704,113 | rename 704,113 first, then name 703,119 `main` |
| Lord10 (a10) | 705,119 | — | name 705,119 `main` |
| Lord11 (a11) | 705,120 | — | name 705,120 `main` |
| Lord12 (a12) | 704,120 | — | name 704,120 `main` |
| Lord13 (a13) | 706,119 | — | name 706,119 `main` |
| Lord14 (a14) | 702,120 | — | name 702,120 `main` |
| Lord15 (a15) | 703,121 | — | name 703,121 `main` |
| Lord16 (a16) | 705,121 | 701,113 | rename 701,113 first, then name 705,121 `main` |
| Lord17 (a17) | 706,120 | — | name 706,120 `main` |
| Lord18 (a18) | 706,117 | — | name 706,117 `main` |
| Lord19 (a19) | 707,119 | — | name 707,119 `main` |
| Lord20 (a20) | 701,118 | — | name 701,118 `main` |
| Lord21 (a21) | 701,121 | — | name 701,121 `main` |

Give every other city of an account a unique name too (`f1`...`f9`): `teleport ... from <city>`
breaks on duplicates, which is how Lord14's five "Eldian" cities caused trouble in §5e.

### Wave size

Amulets come per attack, so **amulets an hour = waves an hour**, which the rally slots cap.
Wave *size* does not change that — it only changes how many catapults each amulet costs. Hero
XP scales with what is killed, so it tracks catapults an hour, not wave count. The two do not
fight: run every slot, and size the wave to whatever production sustains.

The self-balancing rule is **wave = stock / 10** (one per rally slot), floored at a few
hundred and capped at 100,000 (the Rally Spot march cap). Supply short -> smaller waves, more
of them, more amulets per catapult; supply long -> bigger waves and nothing idles. That is the
user's "catapults/20" instinct with the divisor the game actually sets.

### Food does not limit the ring at all — proved live

I had this wrong twice over, and the user's own send settled it (2026-09-25 07:08, Lord09):
**10,000 catapults, 698,121 → 699,111, 10.05 tiles, no transporters, and the server said
`ok`.** `travelinfo` for that same march reads `carrying 1,500,000 / −5,479,081 / 336,819` —
a shortfall of five and a half million food — and it went anyway, army 1930754, landing
08:31:54.016.

So the carry figure is a rule of the **client's march window**, not of the server, and
OTTObot never applies it to an attack (it only weighs food when the march is carrying
resources). **No transporter tax, and the launchpad ring is not constrained by food.** The
earlier table here said otherwise; ignore it.

One thing is still open: whether the army **arrives whole**. Nothing suggests a starved march
loses troops — most likely the carry figure only ever governed how much loot an army can haul
home, which an attack does not do. The cheapest check is to recall that march and count what
comes back.

What food *does* still bound is a **transport**, which really is carrying something.

### The march time in the send log is not to be trusted

The same send logged `attack 699,111 any cp:10k · march 7537.4s` — 750 s a tile, as if the
city had no Horseback Riding. `travelinfo` said **1h:23m:45** and the server landed it at
**1h 23m 44s**: 500 s a tile, catapult speed 120, exactly the model this plan is built on.

The log line is the wrong one. `script-cmd-deploy.js:687` hands `marchTimeMs` the **login's**
`marchSkillParam` (0 on this console) and lets it stand in for the drive speed too, instead of
asking the city's own `army.getTroopParam`. `travelinfo` and `timed-march.js` both ask the
city, and both are right, so **timed waves are unaffected** — but never plan a wave off the
untimed log line. It is worth fixing before the farm runs, since every number in this section
is a march time.

### Order of work

1. ~~`travelinfo 704,119 cp:7500`~~ — **done 2026-09-25, every figure confirmed.**
2. Build the defence on an **Lord01** city where it stands now (it is in TiTANs, not
   We3Kings, and **you cannot attack your own alliance**), and run a few hundred waves at it
   from the nearest existing `main`. Measure: amulets per attack, XP per defence, whether the
   defence is truly lossless, and that loyalty really does not move.
3. Keep that city's **feasting hall full** for as long as the farm runs — one vacancy and our
   own heroes start being captured.
4. Only then the fourteen swaps, one pair at a time.
5. Rename, then point the prepend at the new `main` cities.


## The dream

Where the fleet is heading (the user, 2026-09-18):

- **~10 bank accounts**, each on holiday, **each city** holding about **200b of every
  resource** and **20t gold**. 20t per city is the starting point; the user wants more.
  Spread evenly, banks can feed any number of accounts through the market, and it all
  comes back at each maintenance. More banks also means **more trading capacity and
  speed**: more cities, more offer slots and more accounts in parallel (EVONY-RULES.md §3).
- **Builders and banks swap in weekly-ish cycles**, with the stack growing each time (how
  it turns out is still to be seen):
  1. One set stacks up to 20t gold per city, then goes on holiday as banks.
  2. The other set, fed by those banks, builds and stacks up to 40t or 80t per city. Then
     they switch: the new stack goes on holiday and the old banks come out.
  3. Next round, up to 100t or 200t, and so on.

  Every switch is a holiday change, so the glitch rule applies each time. Stop every play
  an account is in **before** it leaves holiday. A new bank only works after a maintenance
  on holiday (EVONY-RULES.md §4).
- **Up to ~50 builders** eventually, each with an **insta-catapult hero**, fed by the
  banks, building catapults non-stop.
- The builders run the **amulet and XP farm** above against a designated 5K defence
  account: heroes trained at scale, and amulets turned into coins and items.

Remember the food cap: **a city's food resets to 0 at 1t, so keep it under 950b**
(EVONY-RULES.md §3). A 200b-per-resource spread is well inside it.

## Where we are (2026-09-18) and next steps

- **On holiday now:** a3 Lord03, a6 Lord06, a7 Lord07. They don't hold that much any
  more; the gold glitches have moved most of it into our other accounts.
- **Taking the resources in:** a4 Lord04, a5 Lord05, a8 Lord08, a9 Lord09. The Director
  showed about 354t, 323t, 282t and 101t gold at 10:36. They are the first
  **builders/banks** of the cycle. The user will add a few more accounts soon.
- **This weekend (2026-09-19/20):**
  1. Move the rest into those four accounts.
  2. The user takes Lord03, Lord06 and Lord07 **out of holiday**. **No glitch
     trading with them from then on** (EVONY-RULES.md §4). Stop any play they are part of
     before they leave holiday.
  3. The user spreads the resources more evenly and **puts more accounts on holiday** as
     banks, maybe on Sunday after maintenance.
- A new bank is only usable once it has been on holiday **across a maintenance**.

## Open questions (ask the user; move the answers up when known)

- What does an amulet spin give, besides coins and onwars?
- The Penicillin 65% heal: is it per battle, and how many does a 5k–10k wave use?
