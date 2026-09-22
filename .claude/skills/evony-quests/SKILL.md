---
name: evony-quests
description: Checks and fixes automatic quest claiming in Evony — the Routine and Daily tabs, the free daily amulet, the title and rank promotions. Use when the user says quests aren't being claimed, "are we getting the daily amulet", "check the quests", "claim the quests on <account>", or asks why a promotion was not taken.
---

# Quests and the free daily amulet

**Read `EVONY-RULES.md` first** (§0, and §5g "Quests, and the free daily amulet"). Built
2026-09-22, after the user noticed that no account had ever claimed the daily amulet.

## How it should run

- `goal-quests.js` is a goal module, wired into `goals.js` and `engine.js` like the rest.
- **It needs no goal line.** `config completequests` defaults to **3** — claim everything,
  a title before a rank. `0` off, `1` all but the promotions, `2` all in the game's order.
  (NEAT keeps the same four in its Global Settings; the key is ours.)
- Every city **with goals** looks at both tabs — Routine (`type:1`) and Daily (`type:3`,
  the amulet's) — claims what is finished, then waits: **30 min** after a quiet look,
  **1 min** after a claim, **10 min** after the server refused. At most 20 claims a run.
- A quiet tab costs **one request**: each quest type comes back with `isFinish`, and a
  type with nothing finished is never listed.
- **A city with no goals is never visited by the engine**, so an account emptied for a
  holiday (evony-holiday-prep) claims nothing until its goals come back. That is on
  purpose — say so rather than "quests are broken".
- The `completequests` **script command** is unchanged and claims on demand. In a script
  the command always wins the name; in a goal file `completequests 1` is the config key.

## Checking it

1. **The plan note.** Every city's plan carries a `completequests:` line —
   `claim everything, a title before a rank …: N claimed so far; last look HH:MM: …;
   next look in 27 min`. That is the first thing to read: it says whether it ran, what it
   claimed and when it will look again.
2. **The console log** has the action line:
   `completequests: claim every finished quest here (…) -> ok` (or the refusal).
3. **Engine state** per city, key `quests`: `{claimed, nextAt, last:{at, claimed, names,
   refused, refusal, error}}` in `engine_state` (`evony.db`, read-only with `node:sqlite`
   `{ readOnly: true }`).
4. **On demand, live**, when the user wants it claimed now rather than within the half
   hour: run `completequests` as a script line in one city (`completequests daily` for the
   amulet alone). **One city at a time** — NEAT's wiki says the same. `completequests
   /query=finished` claims nothing and lists what is waiting, which is the safe first look.

## Watch for

- **A restart is needed.** A console only picks this up when it restarts. Ask the user
  first, and tell the other sessions (ListAgents + SendMessage) — a restart loads
  everyone's uncommitted edits and kills every script running there.
- **Promotions change the account.** A title promotion raises the **city cap** (titleId +
  1), which is why the default claims them. If the user ever wants an account left at its
  title, that account's goals need `config completequests:1`.
- **Never require `server.js`** to check any of this — it starts a real console and logs in.

## Offline tests

`node test-goal-quests.js` (29 tests: the config key, the plan, the claim loop, the four
modes, refusals, and the engine end to end). Offline. Never glob `test-*.js`.
