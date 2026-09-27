---
name: evony-timed-waves
description: Times Evony attack waves to land together, to the millisecond, recalling and resending any wave that lands outside a window (timed-march.js, `/within=`). Use when the user says "time my waves", "land these together", "attack at hh:mm:ss.mmm", "within 500ms / within 1s", "sync the waves", or asks why timed attacks land out of step.
---

# Timed waves

**Read `EVONY-RULES.md` first**: §0, §5b (a hero can be lost on a lost battle; "March
times are exact to the millisecond"; the timed-waves entries). Built and live-tested
2026-09-22 on Lord02 (a2).

## What the user wants

Waves (from one city or many) that all land on the same moment, so the defender's bot
can't heal, reinforce or move troops between them. They give the moment and a window:
"land at 10:10:10.500 within 1s" means every wave landing 10:10:09.500–10:10:11.500 is
good, and anything outside is recalled and sent again. NEAT's `@:` landed −1 s…+3 s out.

## The line

```
attack <x,y> <hero> <troops> @:hh:mm:ss.mmm /within=<500ms|1s|1.5s> [/tries=N] [from <city>]
```

- One line per wave, same `@:` on each. `@:` is **this PC's clock** (UTC+2, SAST). The
  Armies/Incoming tabs show the server's clock, so check the server's time zone in the
  header tooltip before lining times up by hand.
- Each wave is planned on its own: march time (the server's whole seconds) + whole-second
  camp + a held-back send for the milliseconds. So later waves get less camp (2:00,
  1:59, …) automatically.
- A miss is recalled the moment the server's stamp shows it, and sent again, up to
  `/tries=` (10 by default) or until there is no time left for the march. A line that
  gives up has sent **nothing** that will land.
- Aim mid-second (`.500`).
- Every wave needs **its own idle hero** (`ok=-71` without one) and **a free rally slot**.
  NPC farming (`config npc:N`) keeps both busy: set `config npc:0` on the sending cities'
  goal rows first (check EVERY row, EVONY-RULES §7), and put it back afterwards.
- Aim far enough out that every wave (and its retries) can still make it: ~1 s per wave,
  ~1–2 s more per retry, plus the march itself.

## Testing it

`scripts/timed-waves-test.txt` (batches within 500/100/20 ms) and
`scripts/timed-waves-recall-test.txt` (±1 ms, to force recall-and-resend) run in the
account's city with the most idle heroes, at the nearest NPC city, with 1 scout and the
weakest idle heroes, and **recall everything minutes before it lands**. Restart the
account onto one with `node glitch-run.js start --buy <id> --buy-script <file>` (a restart
is the user's call). Two restarts need **more than 10 minutes** between them or autorun is
skipped. Read the results in `console-<id>.log` (`[autorun <city>]` lines: "server took
it … from the aimed send", "server: lands … (+N ms)").

## What went wrong so far

- 2026-09-22: the first city in the list had no hero → every wave failed before sending.
  The scripts now pick the city with the most idle heroes.
- An attack with hero `none` is refused (`ok=-71`).
- `marchcheck` misread marches with camp (restTime counts down from the send); fixed.
- Planning with the formula's fractional seconds landed marches up to 1 s early (the
  server rounds down); fixed. That was probably NEAT's error too.
- Rally slots full of NPC farming held one wave back 2 minutes until it gave up.
- 2026-09-27 (Lord24): with two Fleet Feet on, a `@:12:00:00` reinforce landed 2 h 09 m
  early — the server cuts the CAMP by the Fleet Feet factor as well as the march
  (EVONY-RULES §5b). Fixed: the camp asked is now the camp wanted ÷ the factor; the log
  line says "camp X (Y asked for …)". A `@:` time is this PC's clock (SAST), not server
  time: `@:00:00:00` is local midnight.
