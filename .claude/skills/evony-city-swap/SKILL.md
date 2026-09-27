---
name: evony-city-swap
description: Swaps two Evony cities between tiles without ever leaving the tile empty for an outsider — the taker loops on the tile first, then the holder moves off it. Use when the user says "swap those two cities", "move X onto Y's tile", "put <account> on <x,y>", "rearrange the hub", "give that tile to <account>", or asks how to move a city inside the hub safely.
---

# Swapping two cities inside the hub

**Read `EVONY-RULES.md` first** — §0 (before you act), §5e (teleporting: every refusal code
and every way a move lies about having worked). This skill is only the *ordering* that §5e
does not cover, and the user's reason for it.

## The rule that this whole skill exists for

**Never free a tile inside the hub before someone of ours is already looping on it.**
(The user, 2026-09-25.)

The hub is where every account's resources flow. A stranger who lands a city in the middle
of it can sit there, truce, go on holiday and come back out on his own terms — there is no
way to make him leave. A tile a city teleports off becomes a **level-1 flat that anyone can
take**, and §5e records that freed hub flats were gone within hours. So the order is always:

1. the **taker** starts hammering `teleport <tile>` — refused, harmlessly, while the tile is
   still a city;
2. **then** the **holder** moves off it;
3. the taker lands within a couple of seconds.

Doing it the other way round — vacate, then teleport in — leaves a window of minutes that is
not ours to control. Never do it that way, however quick it looks.

## Why the loop is safe to leave running

`teleport` reads the target tile **live** before it sends anything
(`teleport.js readTile` → `session.scanArea(..., { fresh: true })`, not the map cache). While
the holder is still standing there the tile reads as a city, the command refuses **locally**,
and **nothing is sent and no item is spent**. The moment the holder leaves, the same scan
reads an empty flat and the teleport goes. A refused teleport never costs an item — that is
in §5e and it is what makes the hammering free.

The cost is one map scan per try. Keep the window short; if a console starts complaining,
widen the loop to 3–5 s rather than leaving it running for an hour.

## Before you start — both cities

- **The taker needs an Advanced Teleporter** (`player.more.castle.1.a`). A tile a city
  teleports *off* is a level-1 **flat**, not an NPC camp, so a War Teleporter is the wrong
  item. Count by item id, never by a word (§5e). The command says so itself if none is held,
  and sends nothing.
- **The holder needs whatever its own destination takes** — `war` for an NPC camp
  (never a level 10), `adv` for a free flat. Pick and re-read that tile the same session:
  a flat freed a few hours ago may already be an NPC camp.
- **Every army home, on both.** The server refuses with `ok=-77` while *any* army of that
  city is away, **including one already flying home, which cannot be recalled at all**.
  `recallall` is not the test and `city.selfArmies` is not the test — run
  `scripts/army-list.txt` in the city and read the lines. Transports from far away take
  hours (§5e).
- **Pause `traininghero`, `defensepolicy` and `requestresources`** in both accounts' goals,
  and put them back afterwards. `traininghero` alone deadlocked a fleet move for 35 minutes
  because it re-sends the hero every two minutes (§5e). Goals are read live, so no console
  restart is needed.
- `config wartown:1` on both accounts keeps new armies from going out while you work.
- **Check maintenance** (§2). Don't start a swap in the half hour around it.

## Running it

Two scripts, each run from the console's **Script tab** in the city it belongs to. Edit the
two lines at the top of each.

1. **Taker first.** In the taker's city, run `scripts/swap-take.txt` with
   `swTarget` = the tile being taken. Watch the log: it should print
   `SWAP take: … loop starts now` and then go quiet. If it prints refusals about armies or a
   missing item, **stop and fix that before touching the holder** — the tile is not yet
   protected by anything.
2. **Then the holder.** In the holder's city, run `scripts/swap-vacate.txt` with its own
   `swTarget` and `swMode`.
3. The taker should land in seconds and print `SWAP take: LANDED …`.

## It is not done until both accounts have been relogged

**A teleport can report success and not have happened** (§5e, Lord02 2026-09-20: three
cities logged a successful move and were still on their old tiles half an hour later,
snapshot and all, because the test reads the *client's cached* castle record). The only
honest check is a fresh login and the city list. Relog both accounts and read the
coordinates before you call the swap done or start the next one.

While the client holds a wrong tile for a city, `recallall` also stops working for it
(it matches armies on `startFieldId`), so an unverified swap quietly breaks the next one.

## Afterwards

- **Rename.** The launchpad city of each account is the one called `main`, because the fleet
  prepend carries `keeptroops main cp:100k`. A name is looked up with `.find`, so **two
  cities called `main` in one account means the goal silently picks whichever comes first**
  in the list — there is no warning. After a swap, rename immediately: the new launchpad to
  `main`, and whatever used to hold that name to something else. Keep every city name unique
  within an account (`teleport … from <city>` breaks on duplicates too — §5e).
- Put `traininghero`, `defensepolicy` and `requestresources` back.
- `config wartown:0` when the whole batch is finished.

## Doing a batch

- One pair at a time, verified by relog, before the next. A chain (A takes B's tile, B takes
  C's) must run in reverse order — the last city in the chain moves out first.
- The **teleport cooldown is per city** (`ok=-90`, "this city is still on teleport
  cooldown"), so different cities of the same account can move in the same session.
- Keep a written list of pairs with each holder's outward destination chosen **before** the
  batch starts, and re-read those destination tiles on the day.

## What has gone wrong before (§5e, worth re-reading)

- `ok=-84` says "already yours" but really means **another player holds that flat**.
- Freed hub flats came back as **NPC camps** within hours — 694,122 and 701,123 as level 10.
- A war target can read "empty flat" an hour after it was chosen, and `warteleport` then
  refuses; switch the line to `adv`.
- The "N held" item count a teleport prints **lags**. Count the moves, not the badge.
