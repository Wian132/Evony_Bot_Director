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

## Lessons from 2026-09-23 (five accounts, prep and holiday in one pass)

The user asked at 07:54 for Lord13, Lord12, Lord11, Lord10 and Lord04 to go on
holiday — about 35 minutes before maintenance, and the consoles stand down 5 minutes
before its announced start. Two restarts would not have fitted.

- **`scripts/holiday-prep-go.txt` does prep and holiday from ONE console restart.**
  `holiday-prep.txt` then `holiday-go.txt` needs two, and the second is refused by the
  **10-minute autorun gate** — roughly 15 minutes before the holiday is even asked for.
  The combined file runs the one-off prep (`recallall`, `canceltrade`, `cancelbuilding`)
  after the staggered `sleep rnd:36`, then holiday-go's rounds unchanged. Prefer it
  whenever the window is tight; `holiday-prep.txt` alone still stands for prepping the
  evening before, which is better when there is time.
- **It worked first try on three of five, inside 60 seconds of the restart**: consoles up
  08:01:44–08:01:55, Lord10 on holiday 08:02:40, Lord11 08:02:43, Lord12 08:02:46.
  Lord04 and Lord13 were refused `ok=-25` *"Recruiting soldiers. in 4"* — a troop batch already
  in production in city 4, which no cancel can touch — and went in on **try 3**, at 08:04:00
  and 08:04:12. Whole job: about 2.5 minutes for five accounts. Two rounds of 40 s was all
  the waiting-out that batch needed; don't give up after one refusal.
- **Check the coins before you start and tell the user** — and now you can say what they
  buy. Measured live on Lord05 2026-09-23: **a 2-day renewal costs 20 coins (10 a day)**,
  and `/autoextend` renews **at expiry for the same term**, unprompted (its holiday hit
  `2m42s` and jumped back to `1d 23h` at 08:39:02, coins 1,834 → 1,814). So coins ÷ 10 ≈ the
  days of holiday still paid for. Points went on holiday with **81** coins — about 8 days,
  not the near-immediate lapse a bare "81" suggests. Don't repeat the mistake of calling a
  low balance urgent without doing that division.
- **Whether a holiday renews is readable: `player.autoFurlough`** (with `furloughDay`), off
  the login's PlayerBean. The protection watch reports it and the Director's badge shows
  `· not renewing` in amber on a holiday that will lapse. Use it to answer "are they all on
  /autoextend?" instead of guessing from how they were sent.
- **`$error` carries the refusal as plain text** — `Recruiting soldiers. in 4`, the city
  named at the end. `if $error == null end` is still the only check the loop needs.
- **The `HOLIDAYPREP done` line's troop figure is meaningless.**
  `city.troopStillInProduction` is a dual property/call shim, so in a string it prints
  `function Function() {}`. Walls (`tra:0`) and `offers` in that line are real; for troops
  read a type off it (`city.troopStillInProduction.archer`). Recorded in EVONY-RULES.md §1.
- **Tell the other Claude sessions before the restarts** (ListAgents + SendMessage) — all
  four active ones answered inside a minute and one warned that the shared prepend goal
  file had gained a demolition build line at 07:25 that morning, which the backup then
  captured. A restart also loads every session's uncommitted edits: `node --check` the
  files another session says it has been editing (server.js, session.js, statistics.js)
  before restarting anything.
- **Verify the holiday from a fresh snapshot, not from the echo.** `account_latest`'s
  `furlough` flag is only as new as its poll — the ones sitting there at 08:02 still said
  `false` for accounts that went on holiday at 08:04.

## Never go in or out of holiday

**Holiday in and out is the user's alone** (the user, 2026-09-18, and EVONY-RULES.md §1).
Prep the account, then hand it over. Never run `holiday …` or `holiday /exit` yourself
unless the user asks for that account in that message — and never `/exit` at all.

## Afterwards

- **Put the goals back** from `goals-backup-<date>.json` when the account comes off holiday
  (or when the user asks) — otherwise it sits there with no goals, building nothing.
- The account's consoles keep running; a holiday login answers `ok=-100` and is a normal
  login (§1). Its resources now come back at every maintenance, so it is a glitch "bank".
- **A holidayed account is never told about maintenance.** The game sends it no system
  chat announcement at all (2026-09-23, EVONY-RULES.md §2), so on its own its console
  would sit connected into the window and then hammer the reconnect ladder through it.
  Since 2026-09-23 the fleet's shared window covers it: one console hearing the
  announcement, or the Director seeing the fleet drop, stands every account down
  (`maint.js`). It only reaches a console **when that console restarts** — so after
  putting accounts on holiday, check the holidayed consoles logged
  `maintenance: the fleet says the server …` at the next maintenance, not a run of
  `reconnect failed (socks5 … host unreachable)`.
- Record anything new — a refusal code, a coin cost, a timing — in EVONY-RULES.md and here.
