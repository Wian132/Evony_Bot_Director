# Evony rules

What OTTObot has learned about the live game (Evony Age 1, server **ss71**) — the hard way,
mostly. Read this before doing anything that acts on the game: starting or stopping a
script, placing or cancelling trades, logging an account in, restarting or starting a
console, switching an account on or off, sending marches, using or buying items. The
code is documented in README.md and SCRIPTS.md; this file is about the **game** and about
**operating the fleet** without doing damage. How the user plays and what the fleet is being
built towards (alts, mains, builders, banks; insta heroes; amulet farming) is in
[EVONY-STRATEGY.md](EVONY-STRATEGY.md).

Every entry says how it was learned. *Unverified* means inferred, not observed — treat it
as a guess where a wrong guess could cost something. When you learn more, update this
file (see the end).

---

## 0. Before you act on the live game

1. **Which accounts, and who holds them?** One login per account: a second login kicks the
   first. Check which console holds it (`node botctl.js list`, the Director) before
   anything logs in.
2. **Is it switched on?** A switched-off account refuses every login. Switching one on
   logs this machine into it and kicks any other session on that login (NEAT, a browser,
   another PC). Ask the user first.
3. **Is maintenance near?** Daily, somewhere 08:30–09:30 SAST. Don't start anything that
   needs logins in the half hour around it unless it's meant for it (§2).
4. **Can it cost something?** Gold, resources, cents (coins), a hero, an ended holiday, a
   demolished building — or a city's food, which **resets to 0 at 1t** (§3). Do a dry run
   first where there is one, and ask when it's not clearly what the user asked for.
5. **Other Claude sessions share this machine.** Several sessions edit the same files and
   restart the same consoles. Ask the user before restarting a console, and tell the
   other sessions (ListAgents + SendMessage). A restart loads every session's uncommitted
   edits and kills every script running in that console.

---

## 1. Accounts and logins

- **One login per account.** A second login kicks the first, and two supervisors fighting
  over one account trip the rate limiter. Never log in to an account a console holds —
  not with a standalone probe, not with a test file.
- **Some `test-*.js` files log in live** as a1 Lord22 (the .env account): test-scope,
  test-login, test-raw, test-block, test-buy, test-wall, test-clean, test-castle,
  test-ctx, test-shapes, test-lookup. The name is no guide — grep a file for `.connect(`
  or `EVONY_PASSWORD` before running it, and never glob `test-*.js`. (Two accidental live
  logins, 2026-09-13.)
- **Login reply codes:** `ok=1` in; **`ok=-100` = the account is on holiday — it is still a
  login**, the whole account comes with it; log in anyway and **never end the holiday**
  (the game's own client offers to; NEAT and OTTObot don't). `-5` = captcha wanted. `2` =
  no lord on the account yet. A login reply carries 100 KB+ of player data — never put
  one in a log line or an error. (Observed, fixed 2026-09-17.)
- **Going on holiday from a console:** `holiday` is an **in-line** command, so a script line
  reads `command "holiday 3 /autoextend confirm"` — a bare `holiday …` answers "unknown
  command" (the user hit this 2026-09-20). **`confirm` must be the LAST word.** At least 2
  days (the game's own window refuses fewer). It sends `furlough.isFurlought {playerId, day,
  password, isAutoFurlough}` with the login's password hash, so the console must have logged
  in with a password. `/autoextend` sets isAutoFurlough — the game then renews the holiday
  until the coins run out; it was refused in OTTObot until the user asked for it
  (2026-09-20). It is account-wide: run it in ONE city, not on autorun in every city.
  *Unverified:* what the game charges in coins.
- **The game refuses a holiday while a city is building fortifications**: `ok=-25`
  "Manufacturing fortified units" (2026-09-20, Lord04's New city). Troop batches and open
  market offers get in the way the same. Before a holiday: empty every account's goals so
  nothing queues again (**`goals-backup-2026-09-20.json` holds the texts emptied on
  2026-09-20 — put them back afterwards**), then run `scripts/holiday-prep.txt` on autorun
  in every city (`cancelfortifications`, `canceltroopqueues`, `canceltrade`,
  `cancelbuilding`). All 40 towns of a4/a5/a8/a9 cleared in about 40 seconds.
  How to run it: the **evony-holiday-prep skill** (`.claude/skills/evony-holiday-prep/`).
- **Holiday in and out is the user's alone** (the user, 2026-09-18). Never put an account
  on holiday and never take one off it — not by request, script, `holiday /exit` or the
  game's own prompt, whatever a plan says. Plans say *when the user* will do it.
- **What ends a holiday:** only the explicit request `furlough.cancelFurlought {playerId}`
  (the client sends it from HolidayTips.as:205; in OTTObot only `holiday /exit` sends it).
  Market orders don't end one: the glitch trades thousands of them on holiday accounts.
  Reading and deleting reports (`report.receiveReportList`, `report.deleteReport`, i.e.
  `cleanreports`) should be just as safe. *Unverified live* — inferred from the client
  code, 2026-09-18. Check the holiday badge after the first clean.
- **An account can hold hundreds of thousands of reports** (~450k on one, 2026-09-18).
  Reading them page by page (50 a page) took over 12 minutes before one
  `report.receiveReportList` went unanswered (12 s timeout). `cleanreports` used to read
  every page before deleting, so it failed having deleted nothing; it now deletes page 1
  as it goes. *Unverified:* whether deep pages answer slower than page 1, and whether the
  server takes a pageSize above 50.
- **A fresh login right after a connection drops can be ignored** ("no reply to
  server.LoginResponse") for a minute or more. Retrying fast keeps it blocked. Let the
  console's own backoff ladder (30 s, 1 m, 2 m, 5 m, 10 m) handle it. (2026-09-18: two
  standalone logins on Lord22 ignored 45 s apart; the console got in ~1 minute later.)
- **The server can stop answering an IP entirely.** On 2026-09-18, after a heavy trading
  morning, ss71 left every direct connection from this PC hanging (SYN never answered)
  while the same server answered instantly through proxies. Symptom: consoles stuck
  "port closed" while `ServerState` says running. Fix: per-account proxies.
- **Proxies:** each account can log in through its own (Director → ✎ → Proxy). Test them
  first (Director → Proxies → Test all: a tunnel + the policy request, never a login).
  Webshare answers **HTTP 402** when the plan's bandwidth is used up or this IP isn't
  authorised, and SOCKS5 says "no acceptable auth method" for the same reasons. Through a
  good proxy the round trip to ss71 was 237–300 ms, about the same as direct from South
  Africa. (2026-09-18: the first 10 ran out of bandwidth; 100 new ones all worked.)
- **Rate limiting is per ACCOUNT, not per IP.** Lord06 kept being ignored while trading hard
  even on its own proxy IP (2026-09-18).

## 2. Maintenance

- **Daily**, announced on the system chat about 15 minutes ahead ("will be taken offline
  for daily security maintenance on 02:00:00 CDT", 2026-09-18 = 09:00 SAST). The start
  varies roughly 08:30–09:30 SAST. It says "usually 15 minutes"; on 2026-09-18 it ran
  09:00 → about 09:30.
- **Logging in during maintenance can hold an account back for ~30 minutes** (the user's
  experience; the console stands down 5 minutes before the announced start for this
  reason). Only the **maintenance monitor** account takes that risk (§7).
- `config.xml` `ServerState` lags — it read `ServerRunning` while the game port was
  closed. **The game port is the truth.**
- **Accounts on holiday have their resources put back at each maintenance** to what they
  held at the previous maintenance. This is what the market glitch (§4) relies on. It
  only works for an account that has been on holiday **across** a maintenance — the
  Director's "Market glitch ready" column counts them.
- Right after maintenance other players' bots take **15–30 minutes** to come back (the
  user's experience). **On 2026-09-18 it was about 5 minutes:** capture was ~77–91% in the
  first 5-minute bucket after maintenance, 44% in the next, and ~40% after that, then
  collapsed to ~0% at 150 about 27 minutes in. One day's data — keep measuring
  (GLITCH-LEDGER.md) before trusting either figure.
- Trades rest and fill server-side whether the owner is logged in or not: our asks kept
  filling while the sellers were stood down before maintenance (2026-09-18).

- **2026-09-19 maintenance:** the server's chat notice came ~5 min ahead ("due in 5 mi…",
  for 02:00 CDT) and armed the race; down 08:59, Lord22 back in **09:14:56**, followers at
  09:15:16-09:16:33, and the gold play relaunched fresh at 09:15:18 — about 20 s after the
  server was back. About 16 minutes down (yesterday ~33).
- **The maintenance race arms itself from the server** (2026-09-19): a chat notice arms
  it (`maintWindow:<server>`), and now so does the server's own status — the first
  console that sees `ServerState` flag maintenance, or the game port stop answering, sets
  the window from two minutes back, so Lord22 (the monitor) probes at once and the
  followers log in the moment it's in. Only the monitor needs this code (followers just
  read the window). Don't seed windows by hand (the user: automate it). A port glitch
  can arm a window by mistake; it's harmless — the monitor gets in at once and releases
  everyone.

- **2026-09-20: the maintenance race is OFF — every account follows the clock instead**
  (the user's call, after watching Lord22 that morning). What happened: Lord22 (the
  maintenance monitor) stood down at 08:54:03 as announced, and was logged straight back
  in at 08:54:26 by something other than the supervisor — a page poll, a script or the
  engine, all of which could call `connect()` with nothing checking the stand-down. The
  supervisor closed it again two seconds later. That pair went round every 20–60 s from
  08:54 to 09:00 – about a dozen logins into a server that was on its way down – and then
  its proxy (<proxy-ip>:6797) answered "host unreachable" for every attempt after 09:00.
  So the account that was supposed to be back FIRST was the one that could not get back
  at all. The race also never bought real speed worth that risk.
  The rule now: **stand down before the announced start, come back at the announced end,
  and until the game port answers spend no login at all.** The port check is a TCP
  handshake through the account's own proxy and costs nothing, so it runs every 30 s;
  a login is spent only once the port answers, after a stagger of up to 15 s. And
  `connect()` itself refuses a stand-down, whoever asks — that guard is the actual fix
  for the churn. The old race still exists behind `OTTO_MAINT_RACE=1`.
- **A stale `maintOver:<server>` strands the whole fleet** (2026-09-20, the same
  maintenance). Lord22's console was restarted at 09:10 and came back at 09:15:00 on the
  **ordinary reconnect ladder**, not through `maintRace()` — so it never wrote
  `maintOver:ss71`. The value still in the database was **yesterday's** (09:14:56 on
  2026-09-19), which `maintRaceState` correctly refuses as older than today's window
  start. Result: thirteen followers (a3–a15) sat waiting in silence for a signal that was
  never coming, and would have waited until the window expired at 10:29 — 70 minutes past
  the end of maintenance. Yesterday's `maintEnded` times show the same thing happened on
  2026-09-19: a3–a9 only came back 10:10–10:20, not 09:15 as §2 above records.
  **The release is `maintOver:<server>` in the ORG's settings** (not install-wide). Writing
  it to `Date.now()` releases every follower on its next tick — within 10 s, no console
  restart, no running script lost. Only do that with the server verifiably back (another
  account already logged in). Fixed in code: a follower now gives up on the monitor 25
  minutes into the window (`FOLLOWER_WAIT_MIN`) and falls through to the ordinary port
  probe, and it says on the record every 5 minutes that it is waiting.
- **A waiting console used to look exactly like a dead one.** `port still closed`, `port is
  open — login attempt N` and the follower's wait never reached `console-<id>.log`, because
  `Session.CONN_NOTE` did not match them — which is why 13 logs had nothing after 08:54 and
  it looked as though the fleet had died. `port` and `maintenance` are in that filter now
  (2026-09-20). To tell a waiting console from a dead one meanwhile: the process and its
  listening port (`Get-NetTCPConnection`), not the log's last line.
- **Don't restart a console that has just logged back in.** a14 and a15 came back at
  09:23:00/09:23:17 and were restarted ~25 s later; both then answered `no reply to
  server.LoginResponse` — a second login for the same account inside half a minute. Check
  `console-<id>.log` for `back online` or `reconnected` before restarting anything after a
  maintenance.
- **Hammering a proxy with logins kills it** (2026-09-20, the same event): a Webshare
  SOCKS5 endpoint that had worked all night went "host unreachable" on every connect
  after about a dozen rapid login attempts through it, and stayed that way. Treat a
  sudden run of `connect failed: socks5 ... host unreachable` as self-inflicted until
  proven otherwise, and stop connecting rather than retry harder.

## 3. The market

- **Order limits** (the game client's price box): price at most 5 characters, at most
  **150**, at least **0.001**; one order at most **99,999,999**. OTTObot rounds a buy's
  price down and a sell's up.
- **FOOD RESETS TO 0 AT 1t IN A CITY.** A city's food never goes past 950b — the hard
  rule. Anything that adds food to a city (buying it, transporting it, a glitch) has an
  upper limit, counting what is still on its way: a batch of orders and every bid still
  resting on the book. (The user, 2026-09-18.)
- **10 open offers per city** at a level-10 Marketplace; the 11th is refused `ok=-38`
  ("10 offers are allowed at level 10 Marketplace").
- **Fees:** 0.5% of the order's value, taken when it is placed. A buy is charged at its
  own bid price plus 0.5%, not at the seller's ask. A cancel returns the unfilled value
  but **keeps the fee**. (Learned live 2026-09-13.)
- **Goods bought on the market travel to the city.** The gold leaves the moment an order
  fills; the goods arrive later (the purchase shows as a trade "on its way", city
  `transingTradesArray`). So a buying account's resource figure lags what it has really
  bought — on 2026-09-18 our stone buyers showed +27b stone after spending ~645b gold on
  bids at 1 (~6,400 fills). Judge a buying run by orders filled or gold spent, not by the
  resource total, and count goods in transit toward any cap (food, §3).
- **"Insufficient resources. Required Gold 2147483647"** means not enough gold: the server
  caps the figure at the 32-bit maximum (a 99,999,999 @ 150 buy needs ~15.07b).
- **A market reply is only `{packageId, ok}`** — no trade id, no city. Replies come back in
  the order requests were sent, and pipelined orders are created in send order (rising
  trade ids; measured 2026-09-18). OTTObot therefore matches replies by position
  (game.js `pipe`). A lost reply shifts every later one onto the wrong order.
- **Speed from South Africa** (server in Toronto, ~240 ms round trip): a lone order ~530 ms
  (two round trips), ten sent together ~480 ms in all, 40 reads together ~480 ms. Cities
  of one account used to queue behind each other; they no longer do. Separate accounts
  are fully parallel. A host near Toronto would cut all of it by an order of magnitude.
- **The server rate-limits an account that trades very hard**: it stops answering it, then
  drops the connection, and the next login can be ignored for minutes. Keep a pause in
  every trading loop (1 s per loop worked; lord06 needed 3 s). **Never restart a
  rate-limited account to "fix" it** — that adds a login into the limit (2026-09-18,
  Lord06).
- **Much of that "rate limiting" is the server falling behind, and our own heartbeat then
  drops the socket** (2026-09-18, from the Director's uptime samples and the console logs,
  09:33–14:00). The server answers an account's commands roughly one at a time (~4–5
  market orders a second at best). With many cities of one account trading at once, up to
  ~90 orders sit in that account's queue; if the server is slow on them (Lord06's sells at 1
  hit a deep book of bids — *unverified* why it is slower), replies come after our 30 s
  timeout. The console's heartbeat (`common.getPlayerInfoByName`, 10 s timeout) waits
  behind the same queue, fails, and the console **closes the socket itself** — labelled
  "the server closed the connection" or "rate limited" in the Director. Figures: Lord06
  (9 cities selling, ~10.8k orders/h) was down 28% of the time with 280–390 unanswered
  orders an hour; Lord07 from 2 cities sent MORE (~15.7k/h) and was down 0–1 minute
  in 15, with 3–26 unanswered an hour; with ~10 cities earlier it had 190–330. Our buyers
  (cheap resting bids) stay up at ~14.5k/h. **Load per account in flight, not orders per
  minute, is what breaks it.**
  Fixed in code 2026-09-18 (live on Lord06 and Lord07 from 14:23): at most 20 market
  writes in flight per account (`Game.PIPE_LIMIT`, env `OTTO_PIPE_LIMIT`); no heartbeat
  while our commands are being answered, 30 s for it otherwise, and no hang-up if
  something else was answered meanwhile; connection events printed to `console-<id>.log`
  as `[conn] HH:MM:SS.mmm …`.
- **A login the server doesn't answer used to leave its socket open** (fixed 2026-09-18,
  `Game.connect` now closes it). Lord06's console held 3 sockets to its proxy, every other
  console 1; after that its live socket closed twice (14:40:08, 14:46:47) with a script's
  order starting a login a second later that went unanswered. *Unverified:* that the
  server finished a stale login late and so took the account off the live socket — the
  drops matched it; watched from 14:52.
- **Result of both fixes** (2026-09-18, Director uptime samples): Lord06 was down 29% of
  09:34–14:22 and 3% of 14:52–16:07; Lord07 9% → 1%. The only down minutes after the
  fixes were a deliberate relog at 15:03. Unanswered market orders: 280–390 an hour on
  Lord06 before, none in 15:00–16:00.
- **The first login right after a restart often gets no reply; the next, a minute or two
  later, works** (Lord06 14:24 and 14:50 on 2026-09-18, both times the backoff's second or
  third try got in). *Unverified:* the server may still hold the old session for about a
  minute. Don't restart again over it — the supervisor's backoff gets it in.
- **A console's cached resource figures go stale on a busy account.** Lord03 showed 16b+
  gold in every city while the server refused every order as insufficient, and its
  snapshot sat at one value for over an hour (2026-09-18). Trust the server's refusals over
  the cached balance. **A relog is what refreshes them** (the user): after relogging the
  holiday accounts at 11:40 on 2026-09-18, Lord06's gold read 3.6t where the cache had said
  2.4t, and Lord07's 5.3t where it had said 3.4t. Before reporting a holiday account's
  balances, relog it — restarting its console with the same script keeps a play running.
  Mind the rate limit: a relog of an account that is being ignored can itself be ignored
  for a few minutes.
- **A refresh (relog inside the running console) keeps the autorun scripts running** —
  no restart needed. Lord06 2026-09-19: refreshed at 09:25:14 with 18 market writes in
  flight; the orders in flight were lost, two logins went unanswered, it got in at 09:26:31
  (77 s), and its cities placed again from 09:27 — all clean by 09:28:15.
- **Other players' bots watch for big market moves and piggyback** — under-cutting our
  asks and over-bidding our bids within minutes (~3 minutes after maintenance on
  2026-09-18). Normal stone/food/wood/iron prices are around 10–30 gold.

## 4. The market glitch ("glitch wood", "glitch stone", …)

A named play the user runs; when they say "glitch <resource>", this is what they mean.

- **Dump direction:** an account on holiday sells a resource cheap in bulk (the user uses
  1–5; 0.001 is ideal but conspicuous) and our other accounts buy it. At the next
  maintenance the holiday account's resources are put back, so the resource is
  duplicated.
- **Gold direction (the inverse):** the holiday accounts **buy** a resource at a high price
  (150 = 15b gold per 99,999,999 order) and our other accounts **sell** it to them, moving
  the holiday gold out. At maintenance the holiday accounts get their gold back.
- **Ready only when on holiday across a maintenance** (Director column).
- **A resource switch doesn't revive an ended run** (2026-09-18, 16:56–16:58). Relogging
  the holiday side while the control file still named a resource they had run out of
  ended every such city at once (under the runway); switching to food a minute later
  found nothing left running on Lord07 and Lord03. To relog around a switch:
  relog the BUYERS on the old resource (fresh balances for the food cap), switch the
  control file, THEN relog the holiday side — and a console only starts its autorun
  again 10 minutes after its last start.
- **Spreading the stock (the user's goal, 2026-09-18):** about 200–300b of each resource
  and 30–40t gold per city across our accounts — many cities trading is what makes a play
  fast. Soft caps in the control file (`capRes` 400b, `capGold` 40t) make a full city sit a
  transfer out rather than end; see the skill. The 950b food cap is separate and hard.
  Food's soft cap is its own line in the control file: **600b** since 2026-09-19 10:35 (the
  user: more buyers going); the other resources stay at 400b.
  Stone got its own **600b** line for the night of 2026-09-19 (the user: "a good amount of
  stone"): at 400b our 50 buyer towns had room for only ~4.4t of the holiday side's ~19.6t.
- **NO GLITCH TRADING WITH AN ACCOUNT THAT IS NOT ON HOLIDAY** (the user, 2026-09-18).
  - The holiday side only gets its resources back because it's on holiday. An account
    taken out of holiday gives away for real whatever it sells cheap or overpays for.
  - Before every start, and whenever the user takes accounts out of holiday, check the
    Director's status column for each holiday-side account.
  - Stop the play (`end` in the control file) **before** any holiday-side account leaves
    holiday.
  - The glitch scripts do **not** check this themselves: they pick a side by lord name.
    Neither do the accounts listed below. Those lists go stale: the user plans to take
    Lord03, Lord06 and Lord07 out of holiday the weekend of 2026-09-19/20, and to
    holiday other accounts as banks (see EVONY-STRATEGY.md).
- **Speed is the whole game** — the piggybacking bots take whatever we are slow about.
- **How it runs:** the **evony-glitch skill** (`.claude/skills/evony-glitch/`) has the whole
  procedure and the user's phrases ("glitch gold, through stone", "glitch stone" …).
  Scripts in `scripts/`, on console autorun (`AUTOSCRIPTS=1 RUNSCRIPT=<file>`), each city
  placing only as many `x<n>` orders as it has free offer slots. The generic set works
  both ways and for any resource: `glitch-res-buy.txt` / `glitch-res-sell.txt` with the
  control file `glitch-res-control.txt` (`res`, `price`, limits). The first set,
  `glitch-buy.txt` / `glitch-sell.txt` / `glitch-price.txt`, is gold-through-stone only.
  The control file is `call`ed every loop, so **the price, the pauses and the stop rules in
  it apply live** — edit it, don't restart; `end` as its first line stops every city of
  the play. `node glitch-run.js start | snap | flow` starts the consoles on their scripts,
  snapshots balances, and shows the order flow.
- **Runway rule (the user's):** every city keeps **10b** (`keepGold` / `keepRes` in the price
  file; 1b until the user raised it on 2026-09-18) — a buying city stops below 10b gold plus
  one order's cost, a selling city below 10b of the traded resource plus one order — and
  any city stops after 3 "Insufficient resources" refusals in a row (the cached balance
  can be stale, §3). The generic control file also never trusts a cached balance past
  what the run itself has traded. A stopped city's run ends; it needs a new start. **Food:
  a city buying food stops short of 950b** (`foodCap`, §3).
- **Before starting one:** the accounts must be switched on (ask), each on its own tested
  proxy. Start **our normal accounts' side first** — their offers are the ones that wait
  on the book (asks in a gold glitch, bids in a resource glitch) — and the holiday side
  after, so it trades into ours rather than other players'. Check the §0 list.
- **Buying back (the user's rule, 2026-09-18):** after a gold glitch the holiday accounts
  hold the resource they bought, which the next maintenance would take away. Sell it back
  to ours at **1**; measure the return over 3 snapshots 10 minutes apart; keep 1 if at
  least 50% comes back to us, otherwise go to **3**.
- **Accounts (2026-09-18):** holiday gold accounts a3 Lord03, a6 Lord06 (in-game name
  `lord06`, lower case), a7 Lord07; stone accounts a4 Lord04, a5 Lord05, a8 Lord08,
  a9 Lord09. Lord03 keeps nearly all its resources in one city.
- **2026-09-19 after maintenance, gold at 150:** Lord03 (nearly all in one city) spent
  its restored gold in about 3 minutes (09:15 → out at 09:18); Lord06 and Lord07 still
  bought on 7 cities each at 09:50, with our sellers placing ~73% as many orders as they did.
- **How long the restored gold lasts (2026-09-19):** Lord03 out at 09:18, Lord07
  10:00, Lord06 10:03 — the gold play after maintenance ran ~48 minutes. A buying city
  that falls under `keepGold` ends **silently** (no line): a holiday account whose log
  stops on "10 of 10 placed" with no refusal has run out.
- **Food at 0.01, first reading (2026-09-19 10:13–10:18):** 28% came to us — rival bids above
  0.01 take most of it. Lord03 had only 1–3b food per city (under the 10b runway), so it
  sells none.
- **Iron, 2026-09-19 afternoon: rivals outbid us about 20 minutes after each rise.** Our
  share was ~40% at 0.1, 0.5 and 1 alike (so price bought little), then at 1 it went
  40% → 33% → **1%** (15:41-15:51) → 11%: our bids at 1 sat full and unfilled while Lord06
  sold ~1,900 orders per 10 minutes — other bots bid above 1. *Inferred* from the fills; the
  book itself can't be logged from the control file (`@call` silences its `echo`).
  **Outbid looks exactly like "our buyers are done"**: few buyer cities placing orders. A
  plan rule that read it as out-of-gold moved iron on to wood at 16:46 while the holiday
  side still had iron to sell; the user put iron back at **3** at 17:11. Judge "buyers done"
  by SITOUT (at the cap) or gold, never by how few orders they place.
- **A holiday account earns far more from a resource play than our price suggests**
  (2026-09-19): its sells fill the HIGHEST bids first, and rivals bid well above ours. From
  10:10 to 19:32 Lord06's sells counted at our prices came to ~5.5t, Lord07's ~4.1t,
  yet after a relog they held **45.2t and 36.2t** gold (they had spent down to ~0.3t each
  in the morning's gold play). Relog before planning a gold play with their day's takings.
- **Two safety lines in the control file (2026-09-19):** a normal account's run ends if it
  would SELL under 50 or BUY at 50+ — only the holiday accounts (listed by lord name in the
  file: update it when the user changes holidays) may. And the small new accounts
  (keepGold 10m) end on anything but a food buy.
- **More buyers, 2026-09-19:** a10–a15 join the buying side (the skill has the list); the
  control file's `keepGold` is 10m for them (they are short of gold), 10b for the rest.
- First run, 2026-09-18: ~117t gold moved before maintenance and ~138t in the 25 minutes
  after it.
- **Record every run in the ledger** (`GLITCH-LEDGER.md`, data in `glitch-ledger.csv`):
  `node glitch-run.js ledger … --record "note"` after the run, plus its events in the
  document. The point is the pattern over many days — how fast and at what prices the other
  traders react.
- First stone buy-back, 2026-09-18 10:31–10:52, holiday accounts selling at **1**: **74%**
  of their stone reached our accounts (75% then 72% per 10 minutes; counted from orders).
  The rest went to other players' bids above 1 — the holiday accounts took in ~4t gold,
  far more than our ~1.1t, so those bids averaged several gold per stone. A seller at 1
  fills the highest bids first, so any rival bid above ours wins.

## 5. Heroes, items, cities

- **Never `release` a captured hero from the captor's side** — that loses the hero. The
  owner gets it back with a **Stone of Finding**: `lostheroes`, then `recover <id>` on the
  owner's console. (The user corrected this sharply, 2026-09-13.)
- **The training hero (OTTO) is ONE per account: the account's best hero** (the user,
  2026-09-19) — the strongest across all its cities, never one per city, and never
  simply whichever hero is already called otto. On 2026-09-19 `scripts/rename-otto.txt`
  preferred an existing "Otto" and on a10 renamed an L301 hero (att 365) while Kingkush
  L1829 (att 1917) was the best; a4/a5/a8/a9 got the right one.
  - **Keep OTTO at insta catapult (1526 attack) where possible** (the user, 2026-09-19):
    Excalibur (+25%, 7 days) on an OTTO whose own attack is under 1526, and a new one
    when it expires — the `keepherobuff OTTO excalibur /below:1526` prepend goal on
    a4/a5/a8/a9/a10 since 2026-09-19 00:36, live from each console's next start. With it,
    base 1221 is enough; a9's OTTO (1103 → ~1379) still falls short of catapult.
    `power` on a hero is the base; the Excalibur percentage sits in `powerBuffAdded`.
    *Unverified:* what a second Excalibur does to a running one (extends or is wasted) —
    the goal never stacks one.
  - Seen live 2026-09-19 00:42 (the console's read-only debug route): a running Excalibur
    shows on the hero as `powerBuffAdded: 25` plus a buff `{typeId: "HeroPowerBuff",
    descName: "Enhance hero's Attack by 25%.", endTime}` — the text is not "Excalibur".
    a4, a5, a8 and a9's OTTOs already had one (118–139 h left), so the goal's first uses
    fall due about 2026-09-23 22:40 (a4, a5), 09-24 12:40 (a9) and 09-24 19:40 (a8).
  - 2026-09-19 00:47, same route, every OTTO: a1 Lord22 (L648, att 714) 141 h left,
    **a2 Lord02 (L842, att 912) 1677 h (~70 days)** — far past one 7-day Excalibur, so
    Excaliburs used on a running one most likely **add their time** (*unverified*: the
    count used on it isn't known). a10's OTTO (1917) has none and needs none. a1 and a2
    have no `keepherobuff` line, so nothing renews theirs.
  - **A hero that loses the OTTO name is renamed `{level}Att{attack}`**, e.g. `354Att410`
    (the user's format), not Otto2.
- **Fleet Feet** (`player.box.present.money.70`, an angel item; the Director's Fleet Feet
  column counts it) speeds a lord's marches **35% for 4 hours; a second one makes it 70%**
  (the user, 2026-09-19). It can only be used on **another** lord who is your friend
  (`addfriend`) or an ally, never on yourself: `useangelitem <lord> Fleet Feet`. Lord04,
  Lord05, Lord08, Lord09 and Lord03 share the alliance We3Kings, so they can use it
  on each other. *Unverified:* whether it speeds transports as well as attacks.
  **At most two on one lord at a time**: a third is refused `ok=-302` "This item can only
  stackup to 2 times for the same player" and nothing is spent (seen 2026-09-19 14:20, used
  from `scripts/fleetfeet-then-buy.txt`: Lord04→Lord05, Lord05→Lord08, Lord08→Lord09,
  Lord09→Lord04, two each). In a script, `$error` is not empty after a command that worked —
  test it for "FAILED", not for "".
- **Merchant Fleet** (`consume.transaction.1`): "Instantly finish the transportation from
  Market" — lands goods bought on the market at once. The accounts hold ~540.
- `useitem` never buys; only `buyitem` spends cents (coins), capped at 100 items a run
  without `confirm`.
- **Holy Water / `waterhero`** has never been run live. First time: a low-level hero (1–2
  bottles), and check the refund, the bottle count and the cost (`ceil(level/10)`,
  *unverified*).
- **A march takes at most 10,000 troops per Rally Spot level**: 10k at L1, 20k at L2 … 100k
  at L10, every troop kind together (the user, 2026-09-18). Over it the server refuses the
  march with "Troops dispatch limit reached 100000" (seen live 2026-09-18 at 20:35: a
  requestresources transport of 199,974 transports for 999,868,896 food). One hide march
  saves at most 100k troops. The level also sets how many marches can be out at once.
  OTTObot caps every march at this (rally.js `marchTroopLimit`; `game.newArmy` refuses
  anything over it).
  - A **War Ensign** (`/big`, `bigattack`, `bigscout` …; `useFlag`) raises the limit 25%:
    125k at L10 (its item text: "increase personnel limit 25%").
  - **Stygandr's Banner of the Horde** (`/horde`; `useItem`) lets a march take **1,000,000**,
    and 1.25m with a War Ensign too (the user, 2026-09-18; the NEAT wiki's Attack page says
    "10 times as many troops … 1 million"). *Unverified* below Rally Spot L10: whether it
    is a flat 1m or 10× the level's limit. OTTObot's guard allows the flat 1m.
- **Recalling a march** (`army.callBackArmy {castleId, armyId}`, ArmyCommands.as:118): only a
  march still going out or camped can be called back — ArmyConstants.as direction 1 (out) and
  3 (camped). Direction 2 means it has already turned round and is on its way home, and there
  is nothing left to recall. The `castleId` is the city it **left from** (`startFieldId`), not
  the one you have open. The `armyId` comes only from the server's `selfArmys` list
  (`server.SelfArmysUpdate`) — `army.newArmy` answers without one, so a march just sent cannot
  be recalled until that list arrives a moment later. A recalled march keeps its Rally Spot
  slot until it is home. (Code path read 2026-09-20 while putting a Recall button on each row
  of the console's Armies tab; the direction rule is how the client behaves — *not re-verified
  live this session*.)
- **What a march carries** (client code, NewArmyWin.as:2852-2853, :3102, :1719): each troop
  holds its base load × (1 + loadSkillParam/100). loadSkillParam is the account's
  **Logistics** bonus (army.getTroopParam), +100 at Logistics 10 (the user, 2026-09-18), so a
  transport holds 10,000, a cavalry 200 and a scout 10. The march's **own food** rides in the
  same hold: twice each troop's upkeep for every hour of the one-way march, at the slowest
  troop's speed. So at Rally Spot L10 one transport march carries about **1b**, less its food.
  Scouts eat 10 an hour, so beyond about an hour's march they carry nothing. The 199,974 above
  was the bot counting base loads only, so it asked for twice the transports (fixed
  2026-09-18, goal-transfer.js `netHold`).
- **City cap is titleId + 1.** The user's "extra cities" trick sends build marches that land
  in the **same server second** from every city, then logs off until they land. How the
  server stamps and checks arrival times is *unverified*.
- The Town Hall and the Walls are never demolished (the game's own client offers no
  Destruct for them).
- **Troop training costs little next to the stockpiles** (the user, 2026-09-19): about 2b of
  resources a day per account, so it can run alongside a bank build-up — no need to hold it.
- **Instant training.** The mayor's **attack** sets troop training time. The mayor's
  **politics** sets construction, including wall fortifications. Research sets **intel**
  (research time = base × 0.995^intel).
  - Time = base × 0.9^10 × 0.995^stat, and training is instant once that is under 1 second.
  - Excalibur gives +25% hero attack (client item text).
  - The time is fixed when the order is queued, so put the right hero in as mayor first.
  - Checked 2026-09-18: the client's base times give exactly the published tables and the
    user's "insta catapult = 1526".

  | Troop | Attack for instant | With Excalibur |
  |---|---|---|
  | Warrior | 432 | 346 |
  | Worker | 571 | 457 |
  | Scout | 709 | 568 |
  | Pikeman | 790 | 632 |
  | Swordsman | 871 | 697 |
  | Archer | 959 | 768 |
  | Cavalry | 1030 | 824 |
  | Transporter | 1168 | 935 |
  | Cataphract | 1249 | 1000 |
  | Ballista | 1388 | 1111 |
  | Battering Ram | 1468 | 1175 |
  | **Catapult** | **1526** | **1221** |

  Fortifications, by **politics**: trap 607, abatis 745, archer's tower 826, rolling log
  965, defensive trebuchet 1066.
- **Troop training had stopped on every account** (found 2026-09-19 from the Director's
  snapshots: troop totals flat on all 12 accounts checked, since at least 05:20 that day).
  - **The troop list's `permition` is false for every type**, Workers in a level-10
    barracks included (`troop.getTroopProduceList`, seen live on Lord02 14:32). The game's
    own Enlist button never reads it: it goes by the conditionBean's `buildings` / `techs` /
    `items`, each with `successFlag` (SWTypeUI.as, UIUtil.isConditionMatch). The engine
    trusted `permition`, so every type read "not trainable here yet". With no batches to
    place, the attack hero was never made mayor either. Fixed in engine.js the same day;
    trained at once on Lord02 (city 7, 14:38).
  - **A city listing `traininghero` in its own goals AND in the prepend goals** was its
    own next stop, so the hero never left ("nowhere else to go"): Lord02's OTTO sat
    idle in city 7 from 2026-09-18 18:09, Lord09's in 100307139 from 22:00. Fixed in
    goalmods.js (each city once, its own line first).
  - **Instant training seen live** (Lord02 2026-09-19 14:38, OTTO att 912 + Excalibur
    25% = 1140 as mayor): warriors, scouts, pikes, swords, archers and cavalry went in as
    one batch each and showed `~0s`. Cataphracts (1249 needed) took 30-minute batches of
    1,800, i.e. ~1 s each. This matches the table above. The per-unit time the server
    gives (`conditionBean.time`) is a Number: under 1 s means instant.
  - **An instant batch never takes a queue slot.** City 5 at 14:41:57: seven instant
    batches, then four of cataphracts. A minute later the server's queue
    (`troop.getProduceQueue`) listed only the four cataphract batches (6,989). So an insta
    hero can train the whole population in one pass, and the barracks' 10 slots are left
    for slower types.
  - What stops an insta hero is **population**. City 5 went from 95,400 idle to 0 in one
    pass (with `troopsusepopmax:1` lowering production to 0 while the batches went in).
  - The console's `OTTO_TROOP_TRACE=1` prints every city's troop decision to
    `console-<id>.log`. Without it they are only in the Engine tab, in memory, behind the
    login.
- **Hero experience:** the next level needs 100 × level² XP (old wiki).
  - **XP per unit killed = (food + wood + 2×stone + 2.5×iron + 10×gold) ÷ 100** (fandom
    wiki "Experience", read via api.php 2026-09-19). It agrees with the per-unit table on
    evonylord.blogspot.com (2011): **catapult 290**, ram 137.5, ballista 100, phrax 87.5,
    cav 28.5, archer/sword 13.5, pike 9, scout 6.95, warrior 3.05, worker 2.25,
    transporter 29.75; forts: treb 166, log 63, arrow tower 54.5, abatis 16.75, trap 8.75.
    The user remembered 138 for a catapult; that is the ram (137.5).
  - **"2× experience for the winner" is not in any source found** (fandom, evonylord,
    evonyguideage1, sonya75's Age 1 battle calculator; 2026-09-19). *Unverified.* Battle
    reports carry `heroExp` (mailbox.js), so one farm report settles it: 10k catapults
    killed should read 2.9M, or 5.8M if the bonus is real.
- **Population** (client building table and live snapshots, 2026-09-19):
  - Max population = **50 + the cottages**: level 10 cottage 5,500 (L1-9: 100, 300, 600,
    1k, 1.5k, 2.1k, 2.8k, 3.6k, 4.5k). The Town Hall adds none. 24 × L10 = 132,050
    (a1's 22 cottages read 121,050 live).
  - **Popraise** adds floor(5% of max) and never goes past max; it costs 5 × max in food
    (client PacifyPeopleView). Its cooldown is 15 minutes per the fandom Q&A and NEAT's
    own `comfortpolicy 15 20 popraise` example. *Unverified in our logs*, and so is
    whether it shares that cooldown with pray and relief.
  - **Natural regrowth is linear, not a share of the gap.** a4 on 2026-09-18 06:31-08:30
    (tax/loyalty as the bot held them) rose exactly 7,850 per ~6-minute tick with 5
    cities below cap: about **1,570 per city per 6 min, ~15k per city per hour**
    (cities of ~118k max). a10 rose a flat 3,027 per tick all the way to its cap.
    Whether it scales with max population, tax or loyalty is *unverified*.
  - A catapult takes 8 population.
- **The training hero is each account's strongest attack hero, named OTTO** (the user,
  2026-09-19; the prepend goals say `traininghero OTTO`). Renamed live 2026-09-19 00:25 with
  `scripts/rename-otto.txt` on autorun (Lord04, Lord05, Lord08: their KingKush; Lord09: otto;
  Lord10: Kingkush L1829). `hero.changeName` answered ok at once and the new name came
  back in a HeroUpdate. **The engine matches `traininghero` ignoring case**, so a second
  hero called otto/Otto on the account can be picked instead: keep only one. (First pass
  preferred an existing "Otto" and named Lord10's L301 hero instead of its L1829; the
  script now always takes the strongest and renames any other otto to <level>Att<attack>,
  the user's form: Lord10's became 301Att365.)
- **Truce and holiday** (the user, 2026-09-18):
  - You can't go into truce or holiday while you have outgoing attacks. Alts farming NPCs
    therefore can't teleport, truce or holiday.
  - Our own **transports and reinforcements do not stop a truce** (the user, 2026-09-18).
    Builders and mains don't farm, so they have no attacks out.
  - **Under attack, Speech Text comes first, then the truce, then comfort** (the user,
    2026-09-18).
  - A truce gives 12 hours of peace, but everything keeps running: troops still eat.
  - A holiday pauses everything. That is what the resource glitch (§4) rests on. Accounts
    on holiday also get their resources put back at each maintenance (§2).
- **Which hero defends:** the hero with the **highest attack present in the city**, idle or
  mayor, is the one that defends and gains the experience. To train a particular hero by
  defending, send the higher-attack heroes out of that city first (the user, 2026-09-18).
- How the user's fleet uses all this (account roles, city layouts, the hero-training
  plan) is in [EVONY-STRATEGY.md](EVONY-STRATEGY.md).

- **Hero boxes: Sigils and Crystals** (opened for Lord04, Lord05, Lord08, Lord09 and
  Lord10 on 2026-09-18, 162 boxes; `scripts/job-heroes.txt`):
  - `useitem player.box.hero.f` (Ardee's Sigil of Recruitment) or `.e` (Crystal of
    Attunement) in a city puts the new hero **straight into that city** (`shop.useGoods`
    with its castleId). A Sigil gives a **level 5-9 hero with one attribute ~115-130** (base
    ~110-125); a Crystal a level 51-70 hero with one attribute ~100-117. Sigils came out
    **mostly politics and intel** — attack heroes were the minority.
  - **Right after a login the item list hasn't arrived and every item counts as not held**:
    a job that opens boxes must wait and retry (job-heroes.txt does, for a minute).
  - **`fire <name>` used to dismiss the FIRST hero with that name** — a big hero can share a
    name with a new one. Now `fire` refuses a shared name and takes an id (`fire 561410581`).
    **Always dismiss by id**, and only a hero whose id you saw appear (the user: heroes that
    took years to build must never be dismissed by mistake).
  - **Dismissing a town's surplus role on the spot wastes heroes when boxes are scarce.**
    Lord10's small towns ended with 1-5 heroes after dismissing third politics / second
    intel heroes another town lacked. Next time: open boxes, then **move** surplus heroes to
    towns missing that role (`reinforce <town> <hero> s:1 from <town>`; the hero stays
    there), and dismiss only what no town needs once every town is full.
  - The user's layout: **9 heroes a town — 2 politics, at most 1 intel, the rest attack**
    (the mayor counts; prisoners don't).
- **Which items the game lets you Use from My Items** (read from the client, 2026-09-18,
  for the console's Items tab Apply button): the Use button shows when the item's
  definition has `playerItem` set, **except** the event keys and tokens
  (`player.key.*`, `player.bone.key`, candy, harvest tokens, …), any `.quest.` item and the
  War Ensign (UseGoodWin.as:1150-1160). Speed-ups go on a build or research
  (`castle.speedUpBuildCommand` / `tech.speedUpResearch`), not `shop.useGoods`. Our
  itemcatalog.json doesn't keep `playerItem`, so the console's list of what to refuse
  (script-cmd-account.js `applyRefusal`) is built from ids and categories; the hero
  quest items (`hero.taskitem.*`), the stratagems and the blacksmith items are refused on
  that basis, *unverified* against the flag.
- **Taking NPC 10s for another account** (the user's method, run 2026-09-18; how to run
  it: the `evony-npc10` skill):
  - A level-10 NPC ("Barbarian's city") holds ~400k warriors, full 5K forts (traps,
    abatis, trebs), a Lv 27-30 hero and loyalty ~90.
  - **Clearing hit first:** a hero with attack 300+ (level <= 1500) and 90k cataphracts,
    5k cavalry, 5k scouts. Won with attack 484-722; it cost ~12.8k cataphracts plus the
    5k cavalry and 5k scouts. **It must land before any wave** — a 20k/20k/20k wave that
    met the full garrison lost everything (killing ~267k warriors).
  - **Then loyalty waves** (20k cav + 20k cata + 20k scouts, a hero each). Lord05 took
    689,112 on the 28th wave. An account at 10 cities can't take one, so it drains
    ("keeps killing it") while the account that wants the city sends capture waves; the
    user wants the drain non-stop until the city is taken — 100 waves is fine.
  - Wave heroes are the bottleneck (one per wave); the user allows any idle hero up to
    level 1000 for waves.
  - **Waves sometimes get stuck** — still outbound long past their arrival, even after a
    relog. An Evony glitch (the user): recall them and send again.
  - **NPC battle reports aren't kept** on these accounts (not in the report list, not
    readable by id), so loyalty can't be read from them; judge a battle by the troops
    that came home (a loss kills every attacker).
  - The `attack` line's "march N s" is not the one-way time; `marchcheck` and
    `travelinfo` give the server's figure. Returns are fast with Relief Stations.

## 5b. Battle mechanics (Age 1)

From the guides the user pointed to (2026-09-18): "Battle Mechanics: Compact / 5K Range
Guide" (evonyhookups.info, 2014) and "Battle Mechanics – a rough guide" (old bbs.evony.com,
mirrored at evony-tricks.blogspot.com). **Guides about T1–T14 tiers, generals or "Ground
beats Ranged" are The King's Return — a different game. Never mix them in.**

- **A round:** every unit moves (fastest first, either side; ties go to the defender), then
  units fight, then fortifications fight. A unit with a target in range doesn't move.
  **One troop type hits exactly one enemy type per round** — why thin layers work.
- **Targeting:** melee hits the in-range target with the highest total attack. Ranged units
  (archer, ballista, catapult, the defender's arrow towers and trebs) must hit **enemy
  ranged units in range first** — arrow towers first — and only then melee, **fastest melee
  first**. Attacking scouts wait at the back until everything else on their side is dead;
  defending scouts never act.
- **Field length** = longest base range present (units or forts, no research) + 200:
  archers only 1400, catapults 1700, any trap/abatis/treb (5000) → 5200. Fortifications
  are built inside the walls (the wall level sets how many slots there are), so the walls
  set the field only through the forts on them: walls with no trap, abatis or treb are
  compact (the user, 2026-09-18). The old guides say arrow towers also get a range bonus
  from the walls (+200 at level 10, *unverified*).
- **Base range/speed:** worker 10/180, warrior 20/200, scout 20/3000, pike 50/300, sword
  30/275, archer 1200/250, cav 100/1000, phrax 80/750, transporter 10/150, ballista
  1400/100, ram 600/120, catapult 1500/80; arrow tower and rolling log 1300; treb, abatis,
  trap 5000.
- **Compact defence** (only arrow towers/logs, or no forts): ranged units are in range of
  each other from round 1 and shoot each other; **arrow towers are a shield** the
  attacker's ranged must kill first. Pitfall — the "Viof Jack": a compact city with **no
  melee** falls to 1 each of scout, archer, cav, ballista, catapult plus a mass of phrax
  (the decoys soak the defender's ranged rounds).
- **5K / range defence** (at least one trap, abatis or treb): ranged units start out of range
  and walk in; melee walks into fire and dies. Keep melee to thin layers on 5K; compact
  protects melee. **Check which field a target has before choosing a wave.**
- **Hero attack vs intelligence** (the user, 2026-09-18). Attack makes troops stronger, which
  is what breaks through walls and layers. Intelligence cuts your losses. **For attacking
  players, attack is always better.** On defence, intelligence is usually better, but it
  depends on the defence and on what you're being hit with.
- **The loss formula** (evony-tricks.blogspot.com/p/intel.html, from DarkBrady and others;
  it matches the user's numbers):
  - units killed = attackers × damage ÷ (health ÷ defence)
  - damage = floor((1 + heroAttack/100 + MilitaryTradition/20) × horn × base attack) ×
    range modifier. The horn is 1.2 with War or Ivory Horn.
  - health = base health × (1 + Medicine/20)
  - defence = (1000 − min(500, unitDefence × (1 + heroIntel/100 + IronWorking/20) ×
    corselet)) / 1000. The corselet is 1.2. Damage reduction is **capped at 50%**, so at
    most a unit's health doubles.
  Attack has no cap, and that is why it outweighs intelligence.
- **"Perfect intelligence"** is the intelligence at which a troop reaches that cap, with Iron
  Working 10. Intelligence above it does nothing for that troop.

  Base stats come from the game client's own troop table (WarReport.swf `XMLTroop`, read
  2026-09-18). The intelligence needed is the smallest int where
  defence × (1.5 + int/100) × corselet ≥ 500.

  The corselet's own item text in the client says **+20%** ("Increase Defence of troops by
  20%"), and the old guides use 1.2. The user remembers +25%, so both columns are here.
  Until a war report settles it, trust the +20% column.

  | Troop | Life | Attack | Defence | Range | Speed | Int, no corselet | Int, corselet +20% | Int, corselet +25% |
  |---|---|---|---|---|---|---|---|---|
  | Worker | 100 | 5 | 10 | 10 | 180 | 4850 | 4017 | 3850 |
  | Warrior | 200 | 50 | 50 | 20 | 200 | 850 | 684 | 650 |
  | Scout | 100 | 20 | 20 | 20 | 3000 | 2350 | 1934 | 1850 |
  | Pikeman | 300 | 150 | 150 | 50 | 300 | 184 | 128 | 117 |
  | Swordsman | 350 | 100 | 250 | 30 | 275 | 50 | 17 | 10 |
  | Archer | 250 | 120 | 50 | 1200 | 250 | 850 | 684 | 650 |
  | Transporter | 700 | 10 | 60 | 10 | 150 | 684 | 545 | 517 |
  | Cavalry | 500 | 250 | 180 | 100 | 1000 | 128 | 82 | 73 |
  | Cataphract | 1000 | 350 | 350 | 80 | 750 | 0 | 0 | 0 |
  | Ballista | 320 | 450 | 160 | 1400 | 100 | 163 | 111 | 100 |
  | Battering Ram | 5000 | 250 | 160 | 600 | 120 | 163 | 111 | 100 |
  | Catapult | 480 | 600 | 200 | 1500 | 80 | 100 | 59 | 50 |

  The client's fortification stats (life/attack/defence, range, wall slots):
  - Archer's Tower: 2000/300/360, range 1300, 3 slots
  - Rolling Log: attack 500, range 1300, 4 slots
  - Defensive Trebuchet: attack 800, range 5000, 5 slots
  - Abatis: range 5000, 2 slots
  - Trap: range 5000, 1 slot

  **Scouts and workers:** the old guide says intelligence does nothing for them. It says
  their modifier is always 1 and their real defence is 50, not what the client shows. The
  user remembers scouts needing about 2100 intelligence. That sits between the 1934 and
  2350 you get by applying the formula to the client's defence of 20. *Unverified* which
  is right. A war report with a known hero intelligence would settle it.
- **The attacker loses 90%+ of real battles.** Killing a main account's city takes hundreds or
  thousands of waves. **A hero can be lost when you lose a battle** (captured, see §5).
  Never risk a valuable hero on an attack without asking.

## 5c. The security code (the account's second password)

Read from the decompiled client on 2026-09-20 (`src/scripts/com/evony/client/action/
SecurityCommands.as` and `view/module/playerInfo/*`), because Lord14 has one set.
The protocol is implemented in `security.js` and tested offline in `test-security-code.js`.

**A player can set a second password in Player Info, and choose which irreversible
actions it guards.** It is exactly five, a bitmask, and the game's own words for them
(`SetSecurity.as:162-233`, the checkbox labels):

| bit | Label in the game | Command it guards |
|----|----|----|
| 1 | Restart game | `common.deleteUserAndRestart` |
| 2 | Abandon cities | `city.giveupCastle` |
| 4 | Dismiss armies | `troop.disbandTroop` |
| 8 | Dismiss heroes | `hero.fireHero` |
| 16 | Adjust tax rate | `interior.modifyTaxRate` |

- **31 is all five.** Bit 1 (Restart game) is checked AND disabled in the game's own
  window — a player cannot switch it off.
- **Demolishing a building is NOT protected**, nor is destroying wall fortifications,
  nor `hero.releaseHero`. The user expected demolish and hero release to be covered;
  they are not. Only the five above carry a `-200` branch in the client.
  (Corrected against the client, 2026-09-20.)

**`ok = -200` means "the security code comes first" — it is a REFUSAL, not a failure.**
`ErrorCode.NEED_SECURITY_CODE_ERROR = -200` (`ErrorCode.as:229`). Nothing happened: no
city given up, no troops disbanded, no gold or hero spent. Never read a -200 as a
partial success, and never send the command a third time — it will keep refusing.

**How the client answers a -200, and so does OTTObot:**

1. Send the command **normally, with no code on it**. An account with no security code,
   or one that does not protect that action, never pays for an extra round trip.
2. On `-200`: `common.authSecurityCode {code}` — **once per session**. The client keeps
   this as `Context.bLoginSecurityCode` (`ApplySecurityCode.as:437`).
3. `common.setUnlockOption {option}` with that one bit, or 31 for all
   (`UnlockSecurityCode.as:278-282`).
4. **Send the original command again, unchanged.** The code is never added to it.

**The unlock lasts the session only.** The game's own window says so: *"Will only be
effective during this session and will end at logout."* So every reconnect starts locked
again — which is why OTTObot's unlocked mask lives on the `Game` and dies with it.

Other commands on `SecurityCommands.as`, none of which OTTObot sends on its own:
`common.getIsSecurityCodeSetted`, `common.getProtectOption` → `{option}` (what this
account actually guards), `common.setProtectOption {option}`, `common.setSecurityCode
{code}`, `common.changeSecurityCode {curCode, newCode}`, `common.removeSecurityCode` and
`common.cancelRemovingSecurityCodeProcess`.

- **`removeSecurityCode` starts a 72-HOUR wait**, not an instant removal
  (`CancelSecurityCode.as:133`, and the `RemovingSecurityCodeBuff` buff). Aborting it is
  `cancelRemovingSecurityCodeProcess`. **Never send either** — setting, changing or
  removing an account's security code is the user's alone, the way holiday is.
- `isSetSecurityCode` arrives with the login on PlayerBean, so whether a code exists is
  known without asking.

**In OTTObot:** the code is stored per account (`accounts.securityCode`, set in the
Director's account editor or with `securitycode set <code>` at a console). It is read at
the moment the game asks for it, so changing it needs no reconnect. It is never logged,
never echoed and not enumerable on the `Game`. `securitycode` on its own reports what the
game says this account protects; `securitycode check` proves the stored code is right
without unlocking anything.

## 5d. Abandoning a city

- **`city.giveupCastle {password, castleId}` is irreversible** and takes the account
  password as **SHA1 of the text** (`GiveupCastle.as:417`), plus the security code when
  "Abandon cities" is protected. Heroes, troops and marches in or from that city are lost.
- **OTTObot is default-deny about it.** A city is only abandonable if the city registry
  says so, and until 2026-09-20 the only path to that was buildnpc building it itself on
  a flat it had claimed. Everything else — a capture, a purchase, a city built by hand or
  **by NEAT's npcbuild** — is recorded `protected` and refused.
- **`allowabandon <x,y|city> confirm`** (added 2026-09-20) is the one way to let a city
  the bot did not build be given up: it marks the registry row `origin='adopted'`.
  `allowabandon … confirm off` puts it back. It is for a person to type — **the goal
  engine still cannot abandon an adopted city**, because buildnpc's own guard demands
  `origin === 'buildnpc'`.
- `abandontown` also needs the console started with `OTTO_ALLOW_ABANDON_TOWN=1`, the word
  `confirm`, and `anyway` if heroes, troops or marches would be lost.
- A city that **teleports** loses `abandonable` — a moved city is no longer obviously a
  throwaway, so the registry fails closed.

## 6. Game data and references

- The NEAT wiki (http://guide.neatportal.com/wiki/, plain HTTP only) is the spec for goals
  and scripts. Fetch raw pages with `?action=raw`, **one request every 4 s** — parallel
  fetches trip surge protection and lock you out for an hour.
- English names and item tables come out of the game client's `WarReport.swf`.
- **The Statistics (rankings)** are four read-only requests,
  `rank.getPlayerRank / getAllianceRank / getHeroRank / getCastleRank {key, pageNo, pageSize,
  sortType}` (RankCommands.as). `key` null is the whole list, a name makes the server
  search. The game's window asks 10 a page and starts at sortType 0. Read from the client
  code on 2026-09-19 for the console's Statistics tab (`statistics.js`). **Unverified live:**
  whether the server takes a pageSize above 10 (the crawl asks 100 and falls back to 10),
  what sortType 0 sorts by, how long a full read takes, and whether heavy reading adds to
  an account's rate limiting. The crawl sends one page at a time and waits while the
  account has more than 10 market writes in flight. Prefer a Refresh from an account that
  isn't in a trading play. Record the first live run here: page size, list sizes, time.

## 7. Operating the fleet

- **Consoles:** one `server.js` per account, ports 8711, 8713, 8715, … (a1 Lord22 :8711,
  a2 Lord02 :8713, a3 :8715 … a9 :8727). The Director is `director.js` on :8712 and does
  not touch consoles when it restarts. Start and stop consoles with `node botctl.js`. Don't
  start two in the same breath: SQLite answered "database is locked" once. Find a
  console's pid by its port, never trust one written down earlier.
- **A console restart kills every script running in it.** A running Run is answered by the
  console as it starts, so a restart no longer re-sends it.
- **The maintenance role is an ORG setting** (`maintRole:<id>` on `D.org(orgId).settings`,
  not the install-wide `D.settings`) — a role written install-wide is never read
  (2026-09-20). a10-a15 had no role at all until then, so they would have logged in during
  maintenance; all six are now `follow`.
- **After maintenance:** each account's ✎ "After maintenance" role — **maintenance
  monitor** (one per server, Lord22) probes for the end of maintenance through its proxy
  and takes the login risk; **followers** spend no login until it is in, then log in at
  once. (The user reserves "scout" for an account that scouts in game.)
- **Scripts that run without a browser:** console autorun (`AUTOSCRIPTS=1` +
  `RUNSCRIPT=<file in scripts/>`, or a loadout holding `label autorun`), once per console
  start, skipped if that account's autorun started in the last 10 minutes.
  `OTTO_PROBE_AT_START=orders:10` measures an account's market speed once after login.
- **Autorun scripts is set in the Director** (2026-09-18): ✎ → Autorun scripts per account,
  **Start-up** for every account (NEAT's Custom Parameters). It reaches a console only when
  the console **starts** — switching it on does nothing to a running console (↻ in the
  Autorun scripts column), and restarting a console to apply it kills its running scripts
  and, if autorun is on, starts its autorun scripts (orders!) at the next login. Restarting
  is the user's call. `AUTOSCRIPTS`/`RUNSCRIPT` in the environment (glitch-run.js) still win.
- **NEAT's start-up parameters, per its wiki** (StartupParameters / CmdParms pages, read
  2026-09-18): `-autoscripts 1` = autorun scripts, `-autorun 1` = auto *goals* (not
  scripts — easy to mix up), `-runscript File.txt` runs before each city's `label autorun`;
  CmdParms.txt gives its parameters to every bot in the folder; the Director's Custom
  Parameters go to every bot it (re)starts. Forms: `-p v`, `-p=v`, `-p:v`, `/p v`, `/p=v`,
  `/p:v`; on = 1/yes/on/true. *Unverified:* which wins in NEAT when CmdParms.txt and the
  command line disagree — OTTObot lets the command line win.
- **If the bot is on, the goals are on — no engine is ever paused** (the user, 2026-09-18).
  Found that day: 8 of 10 consoles (a3–a10) had started paused, because `botctl` started a
  console paused whenever the account had no *default* goal text — prepend goals and a
  city's own goals didn't count. So a4, a5, a8, a9, a10 had prepend goals saved and none
  of them running. Fixed in botctl.js (only an explicit `-autorun 0` pauses now); it
  reaches a console at its next start. A running console that is paused needs **Resume**
  on its page. To check: a console's log (`console-aN.log`) prints `engine: live` or
  `engine: PAUSED` at start; `get "PrependGoals.txt"` in a script only shows the text is
  saved, not that the engine runs it.
- **The truce goal (`defensepolicy /usetruce:N`) has never fired live** (console logs
  checked 2026-09-18). Until then it ran only in the 60 s engine tick and after comfort,
  within the 3-action budget. Changed in code the same day, **not live until each console
  restarts**. Speech Text and the truce now go first and outside the budget, in the fast
  war pass. That pass wakes about 1.5 s after a wave lands or leaves, and at once when
  loyalty falls to a line. The console log shows each wave's landing time and the loyalty,
  each loyalty change while at war, and how many seconds after the wave each item went.
  Check these lines after the first real attack. The truce waits until no army is
  marching at any of our cities; the item's text says the game refuses it otherwise
  (*unverified live*). A paused engine never truces.
- **A one-off script on an account that is in a play** (2026-09-19, the OTTO renames): restart
  it with a wrapper that calls the one-off, then the play's script (`otto-then-buy.txt`,
  `heroes-then-buy.txt`) through `glitch-run.js start`. The buy loop kept going through
  it (a4/a5/a8 placed ~160–240 buys in the first 5 minutes). A second restart back onto the plain
  play script must come **more than 10 minutes** after the first, or autorun is skipped
  and the play silently stops.
- **Never create login sessions or use the console's internal token to drive a bot** —
  the auth design forbids it and the permission classifier refuses it. The user runs
  things from the page, or they run through autorun.
- Don't probe the game server by hand during maintenance; the maintenance monitor does
  that. Repeated ad-hoc connections were refused by the permission classifier as
  interfering, and they are exactly the traffic that gets an IP or account held back.
- **Commit only your own paths** (`git add <paths>`), never `git add -A`: other sessions'
  uncommitted work sits in the same files.

---

- **Goal amounts take k, m and b — not t** (2026-09-18): `requestresources any gold 40t …`
  is an error and the line doesn't run; write `40000b`. Parse goal text before saving it
  (`require('./goals').parseGoals(text).errors`).
- **The resource-spread layer** (the user, 2026-09-18) sits last among each account's
  prepend `requestresources` lines: `requestresources any <res> 400b 400b 100m 1b t` for
  food, wood, stone, iron and `… gold 40000b 40000b 100m 1b t` — a town under the max asks,
  only towns over it give, and never below it. At 1b a march (100k transports), moving tens
  of trillions of gold takes many marches.
  - **Lowest first** (the user, 2026-09-18): towns at 20t gold were being topped up while
    a town at 100 gold got nothing — each town took the nearest sender, first come first
    served. Now a sender leaves a resource for the town that holds least of it (and is
    asking, and can be reached now). Tiers of lines can't do this: a town never sends
    below its own line's level, so with the 40t line no town under 40t sends gold at all.
  - **500m a march on 100,000 transports** (the user, 2026-09-19): 100,000 × 5,000 is
    exactly 500m, the **base** load — the planner had no Logistics figure (it counts base
    loads when it has none; at Logistics 10 the same march takes ~1b). The saved prepend
    lines already had maxBatch 1b, so the lines weren't the cap there (the old
    `… 1b 2b 100m 500m t` lines in prepend-goals.txt and on a9's city 100307139 are a 500m
    cap of their own). Why the figure was missing is *unverified*: the login sends
    `army.getTroopParam` with **no castleId** (game.js; the client always sends the city's
    castleId, ArmyCommands.as:54, NewArmyWin.as:1616), and `Game` has no default for
    `loadSkillParam` if that reply is missing or late; or the reply without a castleId says 0.
    The console's Log tab shows `march skill …, load skill …` after each login — check it.
    **The server never tells a maximum**: the client works out the room itself
    (NewArmyWin.as:3119 `leftSpace = loads - portableFood`), from `loadSkillParam` and the
    Rally Spot limit; the server only refuses what is over ("Troops dispatch limit reached
    100000"). Changed 2026-09-19 (goal-transfer.js, not live until the consoles restart):
    the planner reads the sending city's own `army.getTroopParam` answer first
    (Game.troopParams), says in its note when it has none, and a transport sent without it
    asks for it (with the castleId) so the next pass loads full marches. `*` as maxBatch,
    or one bigger than a march, is one full march.
  - **Steps, the poorest first** (the user, 2026-09-19): "under 1t asks from anything over
    1t, under 10t from over 10t, under 20t from over 20t — and the 10t step doesn't start
    before the 1t one is done; nine towns at 20–40t and one at 500m must fill the 500m one,
    not shuffle between the rich." Built as `/steps:` on one line (goal-transfer.js):
    `requestresources any gold 20000b 20000b 100m * t /steps:1000b,10000b` and
    `requestresources any <res> 400b 400b 100m * t /steps:10b,100b`. A level waits while any
    town with the line is still under a lower level that some town can fill; donors never go
    below the level; the richest free town sends. Offline-tested only.
  - **Food never past 950b** is now enforced in goal-transfer.js itself (requests and
    keep/send lines), counting what is on its way — not only by the lines' amounts.
  - **How fast the steps can move anything** (worked out 2026-09-19, offline from the
    Director's snapshots of Lord08 and Lord09): a transport covers 10 tiles in about
    33 minutes one way (speed 150), and a line allows ONE trip per sender→city pair,
    going or coming back (`/slots:1`). So one city takes in at most about 1b per sender
    per ~70 minutes: ~9b an hour from nine senders, across all resources together.
    Gold at the 10t step (a new town at 5.9t) needs ~4,000 marches — hundreds of hours.
    `/slots:N` on the lines multiplies it (a L10 Rally Spot has 10 slots, shared with
    everything else the sender does). The market moves gold far faster than transports.
  - **Line order starved iron** (2026-09-19, Lord08's New city: iron stuck at 1.49b from
    10:20 to 13:55 while gold, food and wood came in). Each sender makes one trip at a
    time, so the line served first took every sender that came free — gold, listed first.
    Fixed the same day in goal-transfer.js, **not live until the consoles restart**:
    stepped lines go lowest step first across resources, then the emptiest. Still in the
    way (engine.js, not changed): a slice sends at most 3 marches, the senders with the
    fewest processing points first, and the richest city (main) has the most points, so
    a line that picks main waits until the others are busy.
  - The Director snapshot's `marching` is a **count** of marches out (selfArmys), not a
    list. At 13:55 on 2026-09-19 it read a4 18, a5 7, a8 9, a9 8 (a4: 1.8m troops,
    exactly 100k a march), so marches were out. The snapshot doesn't say what kind.
    Resources rising in a buyer's town may be market buys, not transports.

- **A trading console runs out of memory in about 3 hours and is restarted plainly**
  (2026-09-20, found from `console-<id>.err.log` and the Director's `uptime` table). Lord04,
  Lord05, Lord08 and Lord09 all died of "FATAL ERROR: ... JavaScript heap out of memory"
  at ~4 GB, 2.7–3.1 hours after their 19:31 start (22:14, 22:18, 22:25, 22:36 on 09-19).
  The Director then starts the dead console **with no play script** ("keep bot on — no
  console is running it, starting one"), so the play stops silently — the user noticed no
  stone arriving for ~1.5 hours.
  - It is **not** the troop-training change: the same climb is in the uptime table from
    the day before (a4 at 2.1 GB at 01:56, 2.3 GB at 11:56 on 09-19).
  - It goes with **trading load**, not with being logged in: a2 Lord02, which trades
    nothing, sits at ~130 MB all day, while the trading consoles climb ~10 MB a minute
    (a14 Lord14 read 3,748 MB at 00:25 on 09-20). The leak itself is *unverified* —
    nobody has found what holds the memory yet.
  - So: after about 3 hours of trading, expect a console to die and its play to stop.
    Check `rssMb` in the uptime table (the Director's uptime page) before trusting that a
    play is still running, and restart a trading console onto its play script.
- **A console restarted without its autorun script silently stops a play** (2026-09-18,
  22:57): Lord06's and Lord07's consoles were restarted plainly (another session), and
  the wood play stood still for 40 minutes while every buyer's bids sat full. A console's
  log shows `[conn] … session supervisor started` for a new process; with no `[autorun …]`
  lines after it, nothing is running. **Restart a console that's in a play with its play
  script** (`node glitch-run.js start --buy|--sell <id> --…-script <file>`), never plainly,
  and check the Director's Trading tab afterwards: holiday side "0 cities trading" while ours
  "wait on a full city" means the sellers are down.
  - **A trading console runs out of memory after about 3 hours and the Director starts it
    again plainly** (2026-09-20, found by another session from `console-<id>.err.log`:
    "FATAL ERROR: JavaScript heap out of memory" at ~4 GB — a8 22:14, a4 22:18, a5 22:25,
    a9 22:36, all started 19:31). The Director's "keep bot on — no console is running it"
    start carries no play script, so the account stops trading silently: Lord04, Lord05,
    Lord08 and Lord09 bought nothing for ~1.5 hours until the user noticed. Lord14 was
    at 3.7 GB and rising ~10 MB/min. Not caused by the engine change — a2, which doesn't
    trade, stays at ~130 MB, and the climb shows in the uptime table from the day before.
    **A long play needs a watchdog**: an account whose console started after its last order
    and has placed nothing since gets `glitch-run.js start` with its play script again
    (the night plan does this every 2 minutes since 2026-09-20 00:30).
  - **The Director does this too** (2026-09-19, Lord09): at 23:46:57 `director.log` says
    "Lord09 is set to keep its bot on — restarting its console instead of switching it
    off". It started the console with no script (engine paused), and the wood buy run that
    had started at 22:30 was gone. The OTTO renames later restarted it onto
    `rename-otto.txt` alone (00:25) and then plainly (00:38), so it stood idle until 01:12.
    **To find a buyer that has stopped:** its last `FRESHSTART` in `console-<id>.log` is
    older than the other buyers', and there are no `buy <res>` lines after its last
    `session supervisor started`. `glitch-run.js flow` counts look like whole-log totals,
    so don't trust its "cities running" for this. Fix: `node glitch-run.js start --buy <id>
    --buy-script glitch-res-buy.txt`.

- **`glitch-run.js flow <hh:mm:ss>` is wrong after midnight** (2026-09-19): it compares
  clock times as text, so `flow 01:46:30` also counts yesterday's 02:00-23:59 lines. Use the
  Director's Trading tab or `trade-monitor.js` (it dates each line) across midnight.
- **Switching an account off and on in the Director restarts its console plainly**
  (2026-09-19 10:13–10:18, Lord14 — the user stopping its farming elsewhere): its
  play script was gone. Restart it onto the play script once the 10-minute autorun gap
  has passed.
- **A console's port can change** (Lord03 moved to 8737 on 2026-09-18, another session's
  restart). `glitch-run.js start` reads the recorded port; if it prints `pid undefined`, no
  console came up — check the port listens and start it again.

- **Every city's resources are recorded once an hour** (since 2026-09-19): the Director's
  Resources tab (city-resources.js, table `city_resources`), from the per-city figures each
  console's snapshot carries (snapshot.js `cityList`). The figures are the console's cached
  ones — right after a login they are the server's, so for a record that must be exact
  (before a maintenance), relog first, then "Record now". The pre-maintenance record of
  2026-09-19 07:53 is also in `resource-records/`.

### Never `require()` a program that starts a console

`node -e "require('./server.js')"` **starts a whole console**: it binds the port, starts
the session supervisor and begins logging in as whatever `ACCOUNT_ID`/.env says. On
2026-09-20 it was used as a "does this file load?" check and started a second a1 console;
it died a second later on `EADDRINUSE` because the real console held :8711, so no second
login went out — but only by luck. Had the port been free it would have logged in and
kicked the live console.

**To check a file OTTObot runs as a program, use `node --check <file>`** (parses, runs
nothing). `require()` is only safe for modules that export and do nothing at load:
`game.js`, `db.js`, `security.js`, the `script-cmd-*.js`. Anything that listens, connects
or spawns — `server.js`, `director.js`, `botctl.js`, the probes — is run, never required.

## Keeping this file true

When you learn something about how the game behaves — by watching it, not by guessing —
add it to the right section with the date and how it was observed. Mark anything inferred
as *unverified*. When an entry turns out to be wrong, fix it or delete it; don't leave a
contradiction for the next session. Keep it about the game and about operating it safely;
how the code works belongs in README.md and SCRIPTS.md.
