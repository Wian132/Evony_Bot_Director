---
name: evony-holiday-prep
description: Prepares an Evony account to be put on holiday — empties its goals, recalls its marches, cancels fortification and troop queues and market offers, and checks it is clear. Use when the user says "prep <account> for holiday", "get X ready for holiday", "clear X so I can holiday it", or asks why a holiday is refused.
---

# Prepping an account for holiday

The user puts accounts on holiday themselves (see **Never go in or out of holiday**). This
skill gets an account into a state where the game accepts it, in about a minute.

**Read `EVONY-RULES.md` first** (§0 checklist, §1 logins and holiday, §5 marches). Holiday
matters because accounts on holiday have their resources put back at every maintenance —
the market glitch (`evony-glitch` skill) runs on it, and what an account holds when it goes
on holiday becomes what it gets back every day. So **never throw resources away** while
prepping: cancel queues, don't demolish or dump anything.

## What stops a holiday

- **`ok=-25` "Manufacturing fortified units"** — the city is building traps, abatis or
  trebuchets (seen live 2026-09-20 on Lord04). Troop batches and open market offers block it
  the same way.
- **Armies out.** You can't go into truce or holiday with outgoing attacks (the user).
  Transports take 5-10 minutes each way, so a recall is not instant — the account can only
  go on holiday once they land.
- **The engine queues it all again** while the goals are still there: troop lines,
  fortification lines and `requestresources` transports. Emptying the goals is what makes
  the prep stick.

## The steps

1. **Check §0 of EVONY-RULES.md.** Which console holds the account, is it switched on, is
   maintenance near, is the account in a play (`evony-glitch`)? If it is trading, stop the
   play first (`end` at the top of `scripts/glitch-res-control.txt`) — a holiday account
   that keeps selling cheap after it leaves holiday gives its resources away for real.
2. **Back up the goals, then empty them.** Every row of the `goals` table for that account
   — `prepend`, any city's own text, `append`, `default` — goes into a JSON file in the repo
   root (`goals-backup-<date>.json`), then each is set to a comment saying where the backup
   is. A running console re-reads its goals every tick, so this takes effect within a minute
   with no restart.
   ```js
   const D = require('./db');
   const rows = D.all('SELECT accountId,cityKey,kind,src FROM goals WHERE accountId = ?', id);
   require('fs').writeFileSync(`goals-backup-${date}.json`, JSON.stringify(rows, null, 1));
   for (const r of rows) D.goals.set(r.accountId, r.cityKey, r.kind, '// EMPTIED <date> for the holiday — the texts are in goals-backup-<date>.json\n');
   ```
3. **Run `scripts/holiday-prep.txt` in every city**, through console autorun:
   ```
   node glitch-run.js start --buy <id> --buy-script holiday-prep.txt
   ```
   (`--buy` only picks the script; nothing is bought.) It runs once per city: `recallall`,
   `cancelfortifications`, `canceltroopqueues`, `canceltrade`, `cancelbuilding`, then prints
   `HOLIDAYPREP done <city> — walls still queued … troops still queued … offers …`.
   **A console skips its autorun if that account's script started in the last 10 minutes** —
   wait it out rather than restarting again, or nothing runs.
4. **Check it is clear.** Count `HOLIDAYPREP done` lines in `console-<id>.log` (one per
   city) and read what each says. Then `json.marching` in the Director's snapshot
   (`account_latest`) must reach **0** — it is a COUNT, not a list. Transports recalled a
   moment ago are still on their way; wait for the count to fall.
5. **Tell the user it is ready**, with the coins the account holds (the game charges coins
   for a holiday; how much is *unverified*). They run, in ONE city's script box:
   ```
   command "holiday 3 /autoextend confirm"
   ```
   `holiday` is an **in-line** command, so it needs `command "…"`; **`confirm` must be the
   last word**; at least 2 days; `/autoextend` makes the game renew the holiday until the
   coins run out. It is account-wide — one city, not autorun in all ten.

## Lessons from 2026-09-22 (five accounts prepped at 08:12)

- **A goal FILE overrides an emptied goal.** Most accounts' Prepend goals are synced from a
  file (`goalFile:prepend:<id>` in settings; the Director re-reads it every 15 s and the file
  wins). Emptying the goals alone is undone within 15 s. Save the link in the backup JSON,
  set the setting to `null`, THEN empty the goals, and check 20 s later that they stayed
  empty. On the way back, restore the link as well as the text.
- **One prep pass may not clear the walls.** `cancelfortifications` cancelled "10 of 10
  batches" per city on Lord03 and still left 54–343 abatis queued in six cities.
  `scripts/holiday-go.txt` cancels once more in every city, waits, then sends the holiday
  from the first city only and retries a refusal 5 times, 30 s apart — so the second pass
  costs no extra 10-minute autorun gate.
- **Cancels in all cities at once don't work**: the queue replies aren't matched to the
  city that asked, so every city cancels the first city's queue ids (Lord16: 9 cities, same
  ids 100–102). Stagger per-city cancels (holiday-go.txt: 4 s per city). holiday-prep.txt
  still runs them together — fix it, or rely on holiday-go's staggered rounds.
- **`sleep` takes a number, not an expression** — `sleep idx * 4` slept 0 in every city.
  Spread cities with `sleep rnd:36`. With that, the 2026-09-22 holidays went through in
  ~1–2 minutes each (Lord14 08:46:55, Lord16 08:47:23, Lord03 08:47:29) after 25
  minutes of refusals with all cities cancelling at once.
- **`$error` is `null` after a line that worked, never `""`.** holiday-go.txt had `if
  $error == "" end`, so it never stopped after a holiday that went through: it kept on for
  all 20 rounds (the later `holiday` sends just failed harmlessly). Fixed to `if $error ==
  null end` on 2026-09-22.
- **Use `canceltroops` / `cancelwalls`** (the user's NEAT names; same commands).
- **2 days** (`holiday 2 /autoextend confirm`) — the minimum; banks rotate after ~2 days.
- **Kill helper loops for real**: `pkill` in Git Bash didn't stop a background loop, which
  kept restarting accounts onto the holiday script and re-sent Lord07's holiday every
  30 s after it was in. Stop by command line in PowerShell and check it's gone.
- **The refusal names the city** (`ok=-25 … in 8`). A batch already in production isn't
  in the queue the cancels read (they say "0 batches") — wait it out; holiday-go retries
  20 × 30 s. Troops in a barracks that no longer exists answer `ok=-30` "Building Barracks
  required" to every cancel (Lord06 city 8, rams) — that one needs the user.
- When the user says in that message to put accounts on holiday, run `holiday-go.txt` on
  them (glitch-run.js start --buy <ids> --buy-script holiday-go.txt). Still never `/exit`.

## Never go in or out of holiday

**Holiday in and out is the user's alone** (the user, 2026-09-18, and EVONY-RULES.md §1).
Prep the account, then hand it over. Never run `holiday …` or `holiday /exit` yourself
unless the user asks for that account in that message — and never `/exit` at all.

## Afterwards

- **Put the goals back** from `goals-backup-<date>.json` when the account comes off holiday
  (or when the user asks) — otherwise it sits there with no goals, building nothing.
- The account's consoles keep running; a holiday login answers `ok=-100` and is a normal
  login (§1). Its resources now come back at every maintenance, so it is a glitch "bank".
- Record anything new — a refusal code, a coin cost, a timing — in EVONY-RULES.md and here.
