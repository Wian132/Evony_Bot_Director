# Glitch ledger

A running record of every market-glitch run (see `EVONY-RULES.md` §4 and the
`evony-glitch` skill): how much of our trading reached our own accounts, minute by minute,
and what the other traders did. One day of numbers says little; many days should show how
the competition reacts — how fast, at what prices, at what time of day, after maintenance —
and that is worth knowing before every run.

- **The data:** `glitch-ledger.csv`, one row per 5-minute bucket per run.
- **This file:** what the numbers mean, each run's events, and what the data shows so far.

## Recording a run

After every run (or during a long one), from the stamped console logs:

```
node glitch-run.js ledger --holiday a3,a6,a7 --ours a4,a5,a8,a9 --from 10:30 --to 11:05 --record "run N: what it was; the events that bend the numbers"
```

A bucket already in the CSV is not added twice. Then add the run to **Runs** below: its
events with times (price changes, starts, restarts, rate limits, maintenance), the gold or
resource moved, and anything the other traders did.

## What the numbers mean

| column | meaning |
|---|---|
| `play` | `gold through stone` = the holiday side BUYS the resource (gold moves to ours); `stone` = the holiday side SELLS it (the resource moves to ours) |
| `holiday_price` / `our_price` | the prices each side's orders went in at in that bucket (`100/150` = a price change inside the bucket) |
| `holiday_orders` | orders the holiday side placed (each 99,999,999) |
| `our_orders` | orders our side placed on the opposite side. Our cities only place into free offer slots, and a slot frees when an order fills, so in a steady stretch this is **our fills** |
| `return_pct` | `our_orders / holiday_orders` — the share of the holiday side's trading that reached us |
| `min_after_maint` | minutes from the end of that day's maintenance (the monitor's signal); negative = before it |

**Reading it:**

- **Over 100%** means our orders filled more than the holiday side supplied: **other
  players traded into our orders too**, at our price. On 2026-09-18 this was confirmed by
  the gold our buyers spent (100.5m per fill at price 1).
- **Distorted buckets** (the notes say which): the first bucket of every run includes our
  cities' first listing (about 360 orders — 10 per city — before anything fills); a price
  change makes our cities cancel and relist (another ~360); a stand-down or restart leaves
  a bucket with our side offline.
- **Goods travel.** A buying account's resource total lags what it bought (EVONY-RULES.md
  §3), so the resource totals in snapshots are no measure of a run. The orders are, and
  a buyer's gold drop at a known price is the cross-check.

## Runs

### 2026-09-18 (Friday) — ss71, maintenance 09:00 → 09:32:55

Holiday side: a3 Lord03, a6 Lord06, a7 Lord07. Our side: a4 Lord04, a5 Lord05,
a8 Lord08, a9 Lord09. All seven on their own proxies from 09:32.

**Run 1 — gold through stone, before maintenance (08:30–08:54)**

| time | event |
|---|---|
| 08:30:35 | start at 150; our sellers first, then the holiday buyers |
| 08:31–08:36 | Lord06 and Lord07 rate-limited: ignored, then dropped and reconnected |
| 08:33:50 | Lord06 restarted (a mistake: its new login was ignored ~1.5 min) |
| 08:37:44 | price 150 → **100** (only ~33% was reaching our stone at 150 by then) |
| 08:40:18 | 1 s pause per loop added; 08:43:24 3 s for lord06 |
| 08:54 | consoles stand down for maintenance |

~117t gold reached the four stone accounts before maintenance.

**Run 2 — gold through stone, after maintenance (09:32–10:14)**

| time | event |
|---|---|
| 09:32:44 | maintenance monitor (Lord22) restarted on a proxy; in at **09:32:55** |
| 09:32:55 | all seven followers log in on their own proxies and start at **150** |
| 09:48 / 09:55 | runway rule live: a city stops below 1b; three "insufficient" refusals end a city |
| 10:08:33 | runway 1b → **10b**; Lord07's cities stop |
| 10:09–10:11 | **0 of our asks fill** — every holiday buy goes to cheaper stone of other players |
| 10:14:06 | price 150 → **100** (the user's choice); Lord06 already out of gold at 10:13 |

~153t gold reached the stone accounts after maintenance; **+269.9t for the day**, for
2.08t of stone.

**Run 3 — stone buy-back at 1 (10:31 →)**

| time | event |
|---|---|
| 10:31:30 | our buyers start first (bids at 1), then the holiday sellers |
| 10:48:06 | control file also counts goods in transit (food cap); no effect on stone |
| ~10:55 | **other players start selling stone into our bids at 1** — our fills exceed the holiday side's sales |
| 11:40 | holiday accounts relogged (same script) to refresh their cached balances |
| 11:57 | the user's rule: check every 30 min; **switch to iron when a 30-min interval returns under 25%** (a watcher does it; it also switches if the holiday side has no stone left to sell). 11:27–11:57 returned **60%** — the third-party selling at 1 had faded |
| 12:05 | second switch rule (the user's): **also switch to iron once 6 or fewer holiday cities hold more than 10b stone — by the live count after a relog**, not the cached figures. Not running yet: an automatic relog every 30 min needs the user's permission |
| 12:16 | relog watcher running (the user's OK). 11:46–12:16 returned **60%** (16,151 holiday sell orders, 9,621 ours). Live count after the relog: **11 cities over 10b stone** — Lord06 9 of 9 (0.3–4.5t each), Lord07 2 of 10 (2.1t and 6.0t; the rest under 10b), Lord03 0 of 10 (7.6–9.6b each: its stone is done). Iron waiting for the switch: Lord06 4.85t (8 cities over 10b), Lord07 1.59t (4), Lord03 ~0 |
| 12:53 | 12:23–12:53 returned **56%** (16,335 / 9,102). Live count 12:55: still **11 cities** over 10b. In 39 min Lord06's stone fell 9.01t → 8.50t (−0.51t) and Lord07's two cities 8.10t → 6.67t (−1.43t): ~3t an hour from the holiday side, Lord07 selling ~3× faster than Lord06 |
| 13:23 | 12:53–13:23 returned **301%** (10,099 holiday / 30,356 ours): **a big rival dump into our bids at 1**, far larger than at 10:55. At 13:21–13:23 ours filled 1,292 orders in 2 min against the holiday side's 166; our four buyers hit the rate limit now and then (server ignoring a few orders). ~3t gold spent in the half hour for ~3t stone; our buyers still hold 99–351t gold each |
| 13:27 | live count: 11 cities over 10b stone (Lord06 8.17t, Lord07 6.01t). The rival dump ended ~13:28: 5-min returns 275%, 320%, 612%, 114%, then 56%, 55% |
| 13:41:50 | **switched to iron at 1** (the user's call: "we have enough stone") — control file `res = "iron"`, `prevRes = "stone"`; no restart. Selling iron: Lord06 8 cities (4.85t; city 5 had 0.1b and ended), Lord07 cities 2 and 8 (884b, 653b; Lord07 was rate-limited for its first minute). Stone stopped at the next loop |
| 13:43–13:46 | **iron returns 300–400%**: ours placed ~6,300 bids in 2.5 min against the holiday side's ~1,500 — other players sell iron into bids at 1 at once, far faster than they did with stone |
| 13:48:10 | iron price 1 → **0.5** (the user: drop while returns stay very high; 13:40–13:50 at 1 read 419% then 325%). From here the user's rule: reads every 10 min, one step cheaper (0.5 → 0.1 → 0.01) only after **two readings in a row at 100%+**; a reading under 50% goes one step back up and stays |
| 13:59 / 14:09 | iron at 0.5: 13:50–13:59 **250%** (2,894 / 7,222), then 13:59–14:09 **45%** (4,262 / 1,938) — the rival selling stopped within ~20 min of the drop. Price back to **1** at 14:09 (the rule), settled there |
| 15:03 | **live iron after a relog** (vs the 13:24/13:27 relogs): Lord06 4.85t → 3.39t (sold 1.46t), Lord07 1.59t → 0.05t (sold 1.54t; every city now at 10b — done). 3.00t sold live = 29,928 orders placed (2.99t): order counts are a sound measure. Ours placed 33,498 bids (~3.25–3.35t filled after cancels and resting bids) → **~110% overall** since 13:41:50, the rival dump at 13:42–14:00 included; **~54% since the price went back to 1** (14:11–15:03: 5-min buckets 39–62%) |

Fresh totals at 11:42 (holiday accounts just relogged), since the 10:31 start:
holiday side sold **2.97t** of stone (Lord03 0.69t, Lord06 0.79t, Lord07 1.49t) and
took in **10.7t** of gold; our side spent **4.14t** gold (≈4.1t of stone at 1), of which
**2.59t** had arrived and ~1.5t was still in transit. So ~1.1t came from other players
selling at 1, and the holiday stone that went elsewhere fetched roughly 11 gold each — about
the normal market price, i.e. ordinary buy orders on the book.

By 10:52 (three snapshots, 10 minutes apart): **74%** of the holiday stone reached us
(75%, then 72%); price kept at 1 under the user's rule (≥50% keeps it). The holiday
accounts took in ~4t gold against the ~1.1t our buyers paid, so the other ~26% of their
stone went to rival bids averaging roughly **7 gold per stone**.

## What the data shows so far

One day only — treat these as leads, not laws.

1. **After maintenance the other traders were back within ~5 minutes, not 15–30.** The first
   bucket after maintenance returned 91% (about 77% without our first listing); the next
   one, +2 to +7 minutes, only 44%, and it stayed at 37–44% (one 59% bucket at +17). The
   window of an empty market was a few minutes on 2026-09-18.
2. **At 150 the gold glitch collapsed ~27 minutes after maintenance** — 3%, then 1%: other
   sellers had undercut our asks completely, so every holiday buy took their stone. Before
   maintenance the decay was slower (87% → 65% over 25 minutes at 150, then 100).
3. **The stone buy-back at 1 held steady at 71–75% for ~20 minutes.** About a quarter of the
   holiday stone went to rival bids above 1, which a seller at 1 always fills first.
4. **Rivals sold into our bids at 1 after ~25 minutes** — cheap stone for us that didn't
   come from our holiday accounts (~270b between 10:52 and 11:02). Why they sell at 1 is
   unknown: copying the price they see, or dumping what they bought.
5. **Rate limiting hit the biggest holiday accounts** (Lord06, Lord07) at 10 orders a
   batch across 10 cities; 1 s per loop (3 s for lord06) mostly stopped it.

## Questions worth answering on later runs

- How many minutes after maintenance do the other traders return? Is it the same every day,
  every weekday, at weekends?
- At which gold-glitch price do rivals stop undercutting (150, 140, 120, 100)? How fast do
  they react to a price change of ours?
- Do rivals always start selling into our cheap bids after ~25 minutes? At what price do
  they bid for holiday stone?
- Do other resources (wood, food, iron) behave like stone?
- Does a smaller batch or a longer pause avoid rate limits without losing return?

## 2026-09-20 evening — the clean-up sequence before maintenance

The order to run, one at a time, each finished before the next begins. A resource is
finished when a FRESH login (not a cached figure) shows every city at the 10b runway.

1. **food** — started 20:06 at 0.1. ~3.7t on the banks, 3.1t of it Lord05's: left over
   from the morning, when the play moved to stone while Lord04 and Lord05 still held some.
2. **stone** — ~3.3t, and this one has a DEADLINE. It is the stone we sold them during the
   18:00 gold pass, and at maintenance their resources reset to the previous morning's
   figures, so anything still on them vanishes. Buying it back recovers most of the ~5t
   the gold pass cost.
3. **gold, once more** — they earn gold from steps 1 and 2 (about 700b at 0.1, on top of
   the 1.3t they still hold). The user: "then you can move the final gold over again early
   on". Banks BUY, we sell, starting at 150 and walking down.

Wood and iron are already at the floor (8-15b a city) and are not worth another pass.

The check that decides each switch is `play-manager.js`, every 30 minutes: if the holiday
side has almost stopped placing, it relogs one bank and prints that bank's LIVE per-city
stock. Under 10b a city means finished. Never switch on the Director's figures — on
2026-09-20 they showed Lord04 at 344.5t of gold when it actually held 774b.

## 2026-09-21 maintenance — the put-back, per town (measured 2026-09-22)

The first put-back for the banks Lord04, Lord05, Lord08, Lord09 (on holiday since before the
09-20 maintenance). Compared per town: 09-20 07:55 record → 09-21 08:00 (drained by the
plays) → 09-21 09:59 (after maintenance). "Back" = wood and iron within 1% of 09-20. Stone is NOT judged: the user drained stone on 09-21
after maintenance (no Claude session), so the 09:59 stone figures were mid-sale.

| Bank | Towns back in full | Failed towns | Notes |
|---|---|---|---|
| Lord09 | 1/10 (698,121) | 9 | 704,113 back on wood/stone, iron 196b→200b (close) |
| Lord08 | 2/10 (697,121, 708,115) | 8 | |
| Lord04 | 4/10 (697,112, 696,109, 698,113, 694,113) | 6 | |
| Lord05 | 9/10 | 696,117 | judged on wood + iron |

A normal day is 8–9/10 (the user). The friend's view: random per town and per resource; a
failed town usually glitches again once restacked. Plan: rotate banks daily (evony-glitch
skill, "Daily bank rotation"). Next: record each morning's result here the same way, and
note which failed towns were restacked, to test "restacked → glitches again".
