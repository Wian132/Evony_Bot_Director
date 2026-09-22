---
name: evony-troops
description: Checks and fixes troop training from goals in Evony (the troop goal, the traininghero OTTO rotating through the cities, insta heroes, 30-minute batches). Use when the user says troops aren't training, "check troop training", "is OTTO moving", "test the training hero", or asks why a city isn't building troops.
---

# Troop training from goals

**Read `EVONY-RULES.md` first** (§0, §5: instant training, the training hero, and the
entry on training stopping fleet-wide). Worked out live on Lord02 (a2), 2026-09-19.

## How it should run

- Every city carries the `troop` ladder and `traininghero OTTO` (prepend goals, or its own).
- OTTO goes round the cities. In each one the engine makes it mayor and fills the barracks,
  then moves it on after the stay: min 600 s by default, `traininghero OTTO 30 60` = 30–60 s.
- **Batches:** 30 minutes each by default (`/queuetime`, `config troopqueuetime`/`troopslot`).
  A level-10 barracks holds 10: one training, nine waiting.
- **Instant types** (under 1 s a troop with OTTO as mayor) go in as ONE batch of the whole
  shortfall. The batch finishes at once and doesn't take a slot. Population is the limit;
  `troopsusepopmax:1` frees the field workers while the batches go in.
- While OTTO is away, a city **waits** for it, and says so in its note: "traininghero OTTO
  is away, waiting for it: Ballista (Bob does not build them instantly)".
- **Only the training hero fills the barracks** (`config trooptraineronly`, `/traineronly`,
  on by default since 2026-09-22). Another hero queues only types it builds instantly,
  because a 30-minute batch holds its queue slot and nine of them left OTTO nothing to
  train with. A hero never mayor in that city with at least OTTO's attack is let through
  once, so its speed gets measured. `trooptraineronly:0` restores NEAT's
  `troopidlequeuetime` rule (small batches in idle barracks). Symptom of the old
  behaviour: barracks full of 30-minute batches, OTTO passing through and training nothing.

## Checking it

1. **Are troops rising?** The Director's snapshots (`evony.db`, table `snapshots`, column
   `troops` per account). Read-only with `node:sqlite` `{ readOnly: true }`. Flat for hours
   on accounts with troop goals means training has stopped.
2. **Where is OTTO, and is it moving?** `engine_state` row `key='hero'` per account: `at`
   (castle id) and `since`. A `since` many hours old means it's stuck. The console's
   read-only route shows the hero: `GET /api/debug/city?id=<castleId>&hero=OTTO` with the
   `x-otto-internal` header (the `internalToken` setting). No other internal routes; never
   create login sessions.
3. **Has OTTO ever been mayor in a city?** `engine_state` per city: `troopGoal.times` keys
   are the mayors each city trained under (`otto` when it has).
4. **What the engine decided:** restart a **non-trading** account's console with
   `OTTO_TROOP_TRACE=1` (e.g. `node botctl.js stop a2`, then `OTTO_TROOP_TRACE=1 node botctl.js start a2`;
   botctl passes the environment on). `console-<id>.log` then has `[troops HH:MM:SS]` lines:
   - each city's troop note, then `| {idle, whole, popBudget, pool, trainer, mayor, best, bars}`
   - `appoint OTTO as mayor`, `train N X (~time) -> ok`, `lower production` / `production back`
   - `traininghero OTTO: A -> B`, `move OTTO to B -> marching`
   Ask the user before restarting any console in a play (glitch accounts), and tell the
   other sessions (ListAgents + SendMessage). A restart loads everyone's uncommitted edits.

## The two ways a city stops the round (2026-09-22)

The training hero can only enter a city with a free Feasting Hall slot, and it can only
leave a city on a reinforce march carrying one scout. So two states break the round:

- **A city with no hero of its own** (0 heroes, or nothing but a prisoner or the visiting
  trainer). OTTO lands, becomes the only hero, takes the mayor's office, and the rotation
  has to stand it down to move it on -- and if the city has no scout the march fails and
  the mayor plan puts it straight back. Stuck for good.
- **A city holding ten.** No slot, so OTTO never gets in. Prisoners hold slots too, and a
  level-2 hero from a conquered valley is the usual culprit.

The engine now handles both (goal-heroes `emptycity`, `makeRoom`, goalmods `mayorPlan`):
an empty city opens a Sigil of Recruitment then a Crystal of Attunement, else hires with
no base bar; a full city releases an unprotected prisoner or marches its weakest idle hero
to a city of its own account under 9 heroes; the trainer is never left holding the office
alone; and its move is held, not started, when the city has no scout.

**Sweeping the fleet for both** -- read-only, off each console's own session, sends nothing
to the game:

```bash
node botctl.js list                       # account -> console URL (ports are dynamic)
# then per console, with the x-otto-internal header (auth.internalToken()):
#   GET <url>/api/session                 -> its cities and their ids
#   GET <url>/api/debug/city?id=<id>&roster=1   -> that city's whole roster
```

`roster=1` gives id, name, level, status, att/pol/int, base and loyalty per hero, plus the
city's scouts and hall size. Once consoles have restarted onto this build, the same sweep
is in the database: `account_latest` carries `cityList[].heroes`, `cityList[].captives`
and a fleet-wide `captives` list per account, and the Director shows both (a Prisoners
column, an "Empty / full cities" column, a violet row for an account holding prisoners).

**Never require server.js to do this** -- it starts a real console and logs in.

## What went wrong before (2026-09-19)

- "not trainable here yet" for **every** type: the engine trusted the server's `permition`
  flag, which is false for all types. Now the conditionBean decides, as in the client. If
  a type really is short, the note names it, e.g. "Ballista (needs Barracks 9)".
- "traininghero OTTO: nowhere else to go": a city had the line twice (its own and the
  prepend's). Now each city is on the round once.
- Instant batches were capped at 30 minutes' worth (~1,800–2,900) and counted as taking a
  slot. Now they go in whole and leave the slot free.

## Offline tests

`node test-troop-parity.js` (troop goal, including the live findings above) and
`node test-hero-fixes.js` (traininghero rotation). Both are offline. Never glob `test-*.js`.
