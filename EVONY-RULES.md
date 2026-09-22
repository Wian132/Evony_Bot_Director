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
- **Out of holiday, when the user asks for it** (2026-09-22 09:23): `scripts/holiday-exit.txt`
  (`holiday /exit` from the first city only) — Lord04, Lord08 and Lord09 answered `ok` within
  a second. Take the account off the control file's `holi` list FIRST, then restore its
  goals from the backup JSON (goal files too, if it had any).
- **Look for duplicate consoles after a busy day** (2026-09-22): Lord09 had TWO consoles
  up, on :8797 (started 2026-09-20 17:10) and :8803 (a watchdog restart at 08:00), both
  answering "connected". Probe every console's `/api/session` (internal token) and stop
  the older process of any pair — two logins for one account kick each other.
- **Queue reads from many cities at once get each other's replies** (2026-09-22, Lord16
  08:41): nine cities running `cancelwalls` together all logged "cancelling 9 of 9" with
  the SAME queue ids (100–102) — `fortifications.getProduceQueue` (and
  `troop.getProduceQueue`) replies are matched by command name, not by castle, so every
  city got the first reply and cancelled ids that were not its own. Only one city per round
  was really cleared; the rest kept producing, which is why holidays stayed refused city
  after city. **Run per-city queue cancels one city at a time** (holiday-go.txt staggers
  them 4 s apart). The prep script (`holiday-prep.txt`) has the same flaw. *Code fix
  still owed:* game.js wallQueue/troopQueue should match the reply to its castleId.
- **The ok=-25 refusal names the city** (2026-09-22): *"Recruiting soldiers. in 8"*,
  *"Manufacturing fortified units. in New city"*. After a full prep, all five accounts that
  day were still refused while `canceltroopqueues`/`cancelfortifications` read **0
  batches** in those cities — i.e. the batch already IN PRODUCTION is not in the queue the
  cancel reads and cannot be cancelled; it has to finish (`holiday-go.txt` retries).
  **Troops queued in a barracks the server no longer has can't be cancelled at all:**
  Lord06's city 8 had 10 × 633 Battering Rams on "the barrack on plot 3", and every
  `troop.cancelTroopProduce` answered `ok=-30` *"Building Barracks required."* *Unverified:*
  whether that barracks was demolished (a `build` goal can demolish) and whether such a
  queue ever finishes. Prep the evening before, not the morning of, so there is time.
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
  `cleanreports`) are just as safe: **verified live on Lord05 on holiday, 2026-09-20 —
  the holiday badge was untouched** (details in the reports entry below). Inferred from the
  client code on 2026-09-18.
- **An account can hold hundreds of thousands of reports** (~450k on one, 2026-09-18).
  Reading them page by page (50 a page) took over 12 minutes before one
  `report.receiveReportList` went unanswered (12 s timeout). `cleanreports` used to read
  every page before deleting, so it failed having deleted nothing; it now deletes page 1
  as it goes. *Unverified:* whether deep pages answer slower than page 1.
- **Reports: the server takes pages and deletes of 1,000** (live on Lord06, 2026-09-20
  14:14–14:22, a normal account not on holiday). The game's own window asks for 10 a page;
  we had used 50. At 50 with a read and a delete one after the other `cleanreports` ran
  ~45 reports a second (09:26 that morning: 28,300 in 10 minutes, then a console restart
  ended it) — 650k is four hours, and any restart in that time loses the run. Now the
  next read is sent WITH the delete (the server answers an account's commands in the
  order they arrive, so it reads what is left) and the page grows 50 → 1,000; the same
  account cleared **457,021 reports (trade, army and other) in 8 min 40 s, 700–1,150 a
  second**, with no unanswered command, refusal or dropped connection. It falls back by
  itself if a server ever refuses a bigger page or a longer `idStr`. A report reply now
  gets 30 s (was 12): a late reply to an abandoned request is taken for the next one's,
  since replies match on the command name alone.
  - **On holiday: works, and the holiday is untouched** (Lord05 a5, 2026-09-20 14:48–14:52,
    holiday badge 66h01m before, 65h50m after — it only counts down). It cleared 77.7k
    trade reports at ~1,070 a second, next to two cities still selling stone at 0.1 (68
    batches placed in the first minute, no refusal). No difference from a normal account.
  - **Army reports are the heavy ones — they stalled the account.** When the clean moved on
    to Lord05's ~3k army reports (NPC-job reports) the server stopped answering the
    WHOLE account for ~2 min 20 s (14:49:32–14:51:51): the market writes in flight got no
    reply ("three commands in a row unanswered — ignoring this account?"), an army page
    read timed out at 30 s, and the clean fell to 17–53 a second. Trading came back the
    second the clean ended, holiday intact, connection never dropped. Pages of 1,000 army
    reports are presumably too big for the server to serve while it works the market queue
    (*unverified*; trade reports at the same size did not do it). Now: a page that goes
    unanswered is asked again at HALF the size and nothing bigger is tried again that run
    (code is in the repo; Lord05's and Lord06's consoles ran the version without it).
    **Until that is seen live, clean a trading account's ARMY reports on their own
    (`cleanreports army`) and watch the order flow, or do it when it isn't trading.**
  - Lord06 (2026-09-20 14:14–14:22) was idle on full offer slots while it cleaned, so it
    says nothing about a busy account; Lord05 above is the busy-account reading.
  - To run it on an account without a restart per attempt use the console's Script tab;
    `scripts/clean-then-buy.txt` (autorun) cleans from the FIRST city only, then every
    city goes on into the buy loop — reports belong to the account, and ten cities
    cleaning at once would just queue behind each other.
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
- **Two accounts on ONE proxy both lost their logins** (2026-09-22). Lord14 (a14) and
  Lord16 (a16) were both set to <proxy-ip>:5636. From ~05:25 (a16) and ~05:50 (a14)
  every login answered *"no reply to server.LoginResponse"*, through several console
  restarts, while all 12 accounts on their own proxies logged in fine. Cause found at
  06:14: **the proxy itself had died** — `testProxy` got "the game server did not answer
  through it" on socks5 and http. Moved to <proxy-ip>:6450 / <proxy-ip>:6154
  (unused Webshare lines, tested first) and both logged in within 15 s. **"no reply to
  server.LoginResponse" on every attempt = test the account's proxy first.** Rule stands:
  **one proxy per account — check for duplicates in the accounts table before a play**,
  and take such accounts off any watchdog so restarts stop adding login attempts (§2).
- **"Random" proxy (the default for a new account since 2026-09-22)** keeps that rule by
  itself: it picks a line no other account uses and that has not failed its test, keeps
  it for every login, and picks again only when the line fails a test, leaves the list or
  is pinned by another account (`proxy-pick.js`, the Director's log says each change).
  Pinned proxies are not checked for duplicates except by a warning in the Director. On
  2026-09-22 **a12 Lord12 and a17 Lord17 were both pinned to <proxy-ip>:5779**
  (read from evony.db, left as found for the user to decide).
- **A login that does not HOLD is the same as no login.** On 2026-09-22 Lord02 (a2)
  logged in about every ten seconds from ~17:00 to at least 21:10 — *"logged in as
  Lord02 — 10 city(ies)"*, then two seconds later *"socket closed by the server — the
  last it sent: … server.ConnectionLost"* — roughly **2,300 logins in four hours**, and
  the account played nothing the whole time. Nothing in the console said it was in
  trouble: every line read like a normal reconnect. Its 22 consoles were one per account
  (checked: each server.js process held its own port, 8711–8849), so no twin console was
  kicking it; the server was simply dropping it, on the proxy it was pinned to.
  **What a console does about it now** (the user asked for it that day, `session.js`
  `rotateProxyIfStuck`): ten minutes of trying without a login that lasts **two minutes**
  — failed logins, or logins dropped seconds later — and it closes the socket, moves the
  account to another proxy line and starts again on a fresh backoff ladder — after a
  60-second rest (`OTTO_PROXY_ROTATE_PAUSE_SEC`), because rate limiting is per account
  and a hurried login keeps it blocked, so a move must never spend more logins than the
  ladder it restarts. Each further
  move in the same spell waits twice as long (10, 20, 40 min, capped at an hour), so a
  fault that is not the proxy does not walk an account through the whole list. It never
  takes a line another account is on (see the rule above): with nothing free it stays
  where it is and says so. Switched off, a kick hold, a stand-down and maintenance are
  not "stuck" — nothing is moved through any of them.
  The move is the console's, not yours: it is kept as `proxyOverride:<account>` in the
  org's settings, the account's own Proxy field is untouched, the Director's Accounts
  grid shows *"· moved by its console"*, and **choosing a proxy there puts it back**.
  `OTTO_PROXY_ROTATE_MIN` (default 10) and `OTTO_SETTLED_SEC` (default 120) change the
  two times. It only applies to a console started after the change.
- **How to tell a bad proxy from a throttled account** (Lord02, 2026-09-22 21:20): its
  console log had **95 `three commands in a row unanswered — ignoring this account?`**
  lines and **no `server.KickedOut`/`gameClient.kickout` at all**, while its pinned proxy
  had passed its last test (socks5, 276 ms). Rate limiting is per ACCOUNT, so that
  reading says the server is refusing the account, not the IP, and **changing proxy
  cannot fix it** — only logging in less can. Read the log that way before blaming a
  line: "ignoring this account" = the account; "no reply to server.LoginResponse" on
  every attempt = test the proxy (2026-09-22, a14/a16).
- **A per-account "After a kick" of 0 or blank is what lets a flap run.** With it unset a
  bare server close reconnects straight away, which is how Lord02 could try 2,300
  times; setting it (Director → Accounts → After a kick) makes each drop cost that many
  minutes instead. The proxy move above is the backstop when it is not set.
- **`server.ConnectionLost` IS "Another user has logged into your account"** — the game's
  own popup (proved 2026-09-22 21:33). Lord02's every drop ended in that command, and
  NEAT, our other bot on the same account, logged *"Disconnected - Another user has
  logged into your account · Pausing jobs for 31m59s · Connection closed"* at the very
  second our console logged back in from its hold. Lord02 was kicked over and over
  from 17:00 to 21:30 — drops per hour went 12, then 281, 571, 423, 419. NEAT was the
  other side of ONE of those kicks, but it **pauses 30 minutes** when it is kicked, so it
  cannot be what kicked us back seconds later: the repeat offender was **our own fleet**
  (the user, 23:05; the Director's poller doing exactly this to 13 accounts an hour later
  is §7). OTTObot had ignored `server.ConnectionLost` entirely and
  reconnected within seconds, which is what kept the fight going; it now treats it as the
  kick it is (30 minutes by default, as NEAT pauses — unless the account sets its own
  minutes), says **"ANOTHER USER HAS LOGGED INTO THIS ACCOUNT"** in the log, shows a red
  bar on the console page with a *Take it back now* button, and a **"someone else logged
  in"** pill in the Director, sorted near the top. It is NOT treated as a kick while the
  server is going down: maintenance sends it too.
  **NEAT is not what re-kicks an account** (the user, 2026-09-22 23:05): *"neat waits 30
  minutes after kicking something off"*, and its own log says `Pausing jobs for 31m59s`.
  So a second kick inside half an hour is never NEAT — it is **our own fleet**. Read a
  rapid series of kicks as ours until proved otherwise, and go looking for the second
  login on this machine.
  **It is not only Lord02:** a18 Lord18 was kicked the same way at 22:21:54 that day,
  the console said so in capitals and stood down its 30 minutes — nobody had known. Every
  other account shows 10–14 `server.ConnectionLost` in a day's log, which is what a
  console restart looks like from the old console's side (the new login kicks it), so read
  a *count* with that in mind; what marked Lord02 out was 1,918 of them.
  **One bot per account, not just one console** — an account NEAT plays must be switched
  off in the Director, or the two will do this again.
- **The hold climbs while an account goes on being refused** (the user, 2026-09-22:
  *"5min then 10min if still refused 15min then 20 etc"*). The account's minutes are one
  step: a drop holds it out 5 minutes, the next 10, then 15, 20 … up to an hour
  (`OTTO_KICK_HOLD_MAX_MIN`, and never less than the minutes you set). **A login that
  lasts two minutes puts it back to one step** — that, not the clock, is what says the
  account is really in. The count is `kickHoldStep:<account>` in the org's settings, so a
  console restart in the middle of a spell does not lose it, and changing the minutes in
  the Director starts the ladder again. This is the answer to a throttled account:
  each refusal buys a longer rest, which is the only thing that clears per-account rate
  limiting. **a2 Lord02 was set to 30 minutes on 2026-09-22 21:45** (5 at 21:27, raised to match NEAT), the rest of the
  fleet is still blank.

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
- **Accounts on holiday USUALLY have their resources put back at each maintenance** to
  what they held at the previous maintenance. This is what the market glitch (§4) relies
  on. It only works for an account that has been on holiday **across** a maintenance — the
  Director's "Market glitch ready" column counts them. **It is not guaranteed, town by
  town and resource by resource — see §4 "The put-back is random per town".**
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
- **A SELLER pays its fee in GOLD, so a gold-poor city cannot sell at all** (2026-09-20):
  at price 150 a 99,999,999 order's fee is 74,999,999 gold, at 100 it is 50m. Lord10,
  Lord11 and Lord15 (a few hundred m gold between ten cities) had every order refused
  "Insufficient resources. Required Gold 74,999,999" and their runs ended after three in a
  row — they could not sell food because they had no gold, and had no gold because they
  could not sell. Fix in `glitch-res-sell.txt`: the amount is cut to what the city's gold
  covers (99,999,999 → 10m → 1m → 100k), so one small sale pays for a bigger next one and
  a city bootstraps itself in a few loops. Within 2 minutes all four poor accounts were
  selling from 5-9 cities each.
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
- **A city whose 10 slots are full of resting orders can stall for good after a price
  change** (2026-09-20 09:49-10:11: Lord04, Lord05 and Lord08 placed nothing for 20 minutes
  while Lord09, restarted a few minutes later, kept buying). No SITOUT, no refusal — the
  script sees `free < 1` every loop and waits, and the control file's cancel-and-reprice
  pass does not clear it (its output is silenced by `@call`, so the log shows nothing).
  **A restart clears it at once** — all three were back to 1,400-1,600 orders a minute from
  9-10 towns within a minute. Watch for an account whose log is only `sleep 0.3`.
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
- **The gold play, live figures (2026-09-22 21:18-21:30).** Six poor accounts (Lord01,
  Lord17, Lord18, Lord19, Lord20, Lord21 — 10 cities each, ~10b food a city) sold
  food at **150** to six holiday banks. In about **six minutes** each account sold ~96b
  food and took **~14.5t gold** (89t between them). The listing fee is **0.5% of the
  order's gold value — 75m gold per 99,999,999 order at 150**, paid by the seller when the
  order is PLACED, so a seller needs gold in hand to start (10 orders = 750m a city).
  - **`capGold` is how you aim the gold.** A selling city over the cap sits the play out,
    so setting it to **10t** left the 40t-a-city accounts out and sent every fill to the
    cities with none. `keepRes` is the other half: at the default 10b a city holding
    exactly 10b sells nothing — the six were given **1b** so they could sell.
  - Each city can hold only **10 market offers** (ok=-38 past that), so a city lists 10 ×
    99,999,999 and then waits for fills. The play's speed is offers filling, not orders.
  - Selling a resource to a bank is not a loss: at maintenance the bank's resources go
    back, and ours buy them back cheap afterwards (the buy-back rule above).
- **A restart does not always carry the autorun script** (2026-09-22 21:18, Lord02).
  `glitch-run.js start` printed "console up, pid 91696", but something restarted that
  console again seconds later and the new process had no `RUNSCRIPT`: no `[autorun …]`
  line appeared and the account never traded, while its log filled with goal work.
  **Check for `[autorun` lines with the new timestamp after every start**, not the
  "console up" line.
- **"no reply to trade.newTrade (server is ignoring this account)" = rate-limited.** Seen
  on Lord02 at 21:28 after two restarts in ten minutes while the whole fleet was
  hammering the market. Nothing it sent was accepted and its socket kept closing. Leave it
  alone to settle — restarting it again is what the "never restart a rate-limited account"
  rule forbids.
- **Measuring a buy-back from snapshots understates our side badly** (2026-09-22 22:07-22:16).
  Over nine minutes the banks' food fell 1.29t while our six buyers' snapshots rose only
  0.03t — an apparent 2% capture. Counting the orders in the logs instead: **8,502 filled
  buys of 99,999,999 = 850b food, about 66%**. Bought goods TRAVEL (§3), so a buyer's
  resource figure lags every fill by the march, and a busy seller's snapshot is stale on
  top of that. Count orders, never balances — and note a console log read as latin1 turns
  the "·" separator into "Â·", which silently breaks any regex that includes it.
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
  file: update it when the user changes holidays) may. (A third line, ending the small
  accounts' runs on anything but a food buy, was removed on 2026-09-20 when they went back
  to buying whatever the play is.)
- **Change a stop rule BEFORE the value it keys on — in ONE write.** Switching food → stone
  on 2026-09-20 12:33 while `if small == 1 && side == "buy" && res != "food" end` was still
  in the file ended every run on six accounts inside a minute; each needed a console
  restart. The control file is re-read before every batch, so any window between two edits
  is a window the whole fleet acts on. Edit the file once, with every change in it.
- **Stale offers of another resource can freeze a whole side.** Each city has 10 offer
  slots, and the control file used to clear only offers of `prevRes`. On 2026-09-22 05:30,
  after a day of plays other than the one starting, every city of ours held ten resting
  offers of some other resource: nothing cleared them, no slot came free, and all ten
  selling accounts sat at "waits on a full city" placing nothing. It now clears any offer
  whose resource is not the current `res` — one play runs at a time, so any other is stale.
  **The tell:** the sell or buy script looping at its `full` branch (`sleep 0.3`) with no
  `SITOUT` line, while `glitch-run.js flow` shows huge "waits on a full city" counts.
- **The snapshot's `furlough` field is NOT the holiday state.** It is a player-bean flag
  that read `false` for all four banks on 2026-09-22 while every one of them was on holiday
  (27-31h left). The holiday state is each console's live header — `/api/session`, readable
  with the internal token — which is what the Director uses. Check THAT before any glitch.
- **An exhausted resource makes every restart pointless, and looks exactly like a broken
  fleet.** A selling city ends its run the moment the resource is under `keepRes` (10b), so
  once the holiday accounts are sold down the cities die on their first loop, the watchdog
  restarts them, and they die again — a cycle that reads as "the fleet keeps falling over".
  On 2026-09-20 Lord05, Lord08 and Lord09 did exactly this for half an hour on wood while
  every one of their cities sat at 7-10b. **The tell:** the log ends at the `FRESHSTART`
  line, i.e. login, first loop, gone. **The fix is to switch resource, not to restart** —
  and restart only after the switch, or the new runs end just as fast.
  **And a price change could fake it (2026-09-22, fixed):** the run's own tally counted
  every PLACED order as traded, and a price change cancels and re-lists every resting
  offer — the unfilled wood goes back to the city, but the tally kept it as sold. After
  the ladder moved wood 0.1 -> 0.01 at 06:12, Lord04/Lord08 stopped at 06:14 "under the 10b
  runway"; a relog's FRESHSTART showed four Lord04 cities still holding 180–229b. The control
  file now takes a cancelled offer's unfilled part (`amount - dealedAmount`) back off
  `traded`/`spent`. **After any price step, a side that stops soon after needs a relog to
  check, not a switch.**
  **A buyer with nobody selling looks the same (2026-09-22 06:43):** once the banks' wood
  was gone, every buying city sat on ten resting bids and placed nothing, so the watchdog
  reported all our buyers "out of this resource". It was the SELL side that was empty —
  read the holiday side's figures, not the buyers', before deciding what ran out.
  **The same trap has a second door (2026-09-22):** a run that ends on its first loop
  leaves no order behind, so the next console restart looks "scriptless" (started, no
  order since) — and a restart is exactly what the watchdog does for scriptless. Lord15
  (under 21m wood a city) and Lord16 (console failing every login: *"no reply to
  server.LoginResponse"*) were both restarted by it at 05:46 for nothing; a restart of
  an account that cannot log in only adds login attempts. Take an account that is out of
  the resource, or failing login, off the watchdog's list rather than letting it cycle.
- **Cleaning ARMY reports silences the whole account for minutes.** On 2026-09-20 a
  `cleanreports` run on Lord05 (80,683 reports) left it answering nothing from 14:49:32
  to 14:51:51 — market writes unanswered and *"ignoring this account"* at 14:50:03 and
  14:51:03 — while it was on the army reports. It came back by itself the second the clean
  finished, with no reconnect, and the holiday badge was untouched (66h01m before, 65h50m
  after). **Trade**-report cleaning ran fine alongside the selling. So: clean army reports
  on an account that is NOT in a play, or accept a few minutes of it trading nothing.
  (Found by another session live-testing the faster `cleanWhere`.)
- **A session refresh ends every city's run, and nothing puts it back.** A
  `refresh — logging in afresh` in the console log kills the autorun scripts exactly as a
  console restart does, but the autorun does not come back (2026-09-20: Lord04 refreshed at
  12:30 and again 12:49, Lord08 and Lord09 at 12:31 — all three sat idle, and the stone
  play ran on one seller out of four for half an hour while the order counts looked like a
  price problem). **A watchdog must treat a refresh as a start to put back**, not only
  `session supervisor started`. Check a quiet account with `tail -1 console-<id>.log`: a
  `[conn]` line as the last line means nothing is running there.
- **A file a run already parsed does not change under it.** Only the `@call`ed control
  files are live. Raising the retry limit in `scripts/teleport-job.txt` on 2026-09-20 did
  nothing for the runs already going: they gave up at the old limit. A change to a *script*
  needs a console restart to take effect.
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

- **The put-back is RANDOM per town, and even per resource — plan for it** (the user,
  2026-09-22, from the 09-20/09-21 results and a friend who has run this glitch for a
  long time). After Saturday's play (09-19 → 09-20 maintenance, ~40 towns stacked, very
  high trading returns) the put-back itself went badly: on one bank **1 of 10** towns got
  everything back, on another **2 of 10**, one about **5–6 of 10**, one about **9 of 10**.
  A normal day is **8–9 of 10**. The friend's experience: it is random — a town that
  glitched today may not tomorrow and vice versa; sometimes just one resource of a town
  does not come back; **a town that failed usually glitches again the next time once it
  is restacked**. So:
  - **A town that failed once is NOT dead for good.** This overrides the "sold dry stays
    dry" entry below, which read one or two maintenances as permanent.
  - **Every town on every account can fail on any day.** Never count on the whole put-back;
    measure it each morning (fresh relog, never cached figures) before the day's plays.
  - The loss from a failed town is real and final for that day: what was sold from it is
    gone. That is the cost of the play, not a reason to stop it.
  - **The work-around is rotation** (the user's plan, 2026-09-22): each day before
    maintenance, decide which accounts go INTO holiday (the ones holding the most
    resources — restocked, so there is most to trade) and which come OUT (the banks whose
    put-back failed worst, to be restocked by trading). Holiday in/out is still the user's
    own click. See the evony-glitch skill "Daily bank rotation".
  - **Measured for the 09-21 maintenance** (hourly city_resources: 09-20 07:55 → 09-21
    08:00 drained → 09-21 09:59; a town "back" = wood, stone and iron within 1% of the
    09-20 figure): **Lord09 1/10, Lord08 2/10, Lord04 4/10, Lord05 9/10**, judged on WOOD and IRON only. Stone
    can't be judged for that day: the user drained stone on 09-21 after maintenance, so the
    09:59 stone figures were mid-sale (a first reading of "711,111 lost only its stone" was
    that sale, corrected by the user). **Judge the put-back only on resources nobody traded
    between maintenance and the reading.** A failed town
    sat at its drained ~7–10b, i.e. simply not restored. The towns that worked were put
    back to the unit.
  - *Unverified:* whether a restacked failed town reliably glitches next time, and whether
    a town's odds depend on anything we control (how full it is, what it traded, timing).
    Record every morning's per-town result to learn this.
- **The put-back AMOUNT, when it works, is EXACT and per town** (2026-09-20, measured from
  the hourly resource record over the 09-19 and 09-20 maintenances). Every one of Lord06's ten towns
  came out of the 09-20 maintenance holding the same wood, stone and iron **to the unit**
  as it came out of the 09-19 one — 455.5b wood / 446.8b stone / 240.9b iron on 706,110,
  and so on for the rest. So the amount a holidayed town is put back to is a fixed
  number per town, and selling more out of it on the day does not change it. Food is the
  exception in the readings: troops eat it and the play sells it, so it drifts. Gold too.
- **SUPERSEDED 2026-09-22 — read the "RANDOM per town" entry above first.** What was
  written on 2026-09-20: *"A town that was sold dry stays dry — the glitch cannot refill
  it."* Lord06's 700,120 and 709,112 were put back to **1.9b and 9.9b wood, and 1.9b and
  84m iron** while its other eight towns got ~455b wood and ~240–660b iron, and
  Lord07's 704,109 looked the same on stone and iron — over only one or two
  maintenances. That is now read as those towns having **failed a put-back** (random), and
  the low figure being what they held at the next snapshot — not as a permanent state.
  Per the user's friend, **restacking such a town usually makes it glitch again**. It is
  still true that a town holding a sliver has nothing worth selling, and that what a
  failed town sold that day is gone. `scripts/glitch-skip.txt` kept those three towns
  out of the plays until **2026-09-22 12:20, when the user had the list emptied**. No
  town is skipped now; about 1.3t of wood had been sitting in those three. The Director's Resources tab flags them (see the resource record near the end).

## 5. Heroes, items, cities

- **Never `release` a captured hero from the captor's side** — that loses the hero. The
  owner gets it back with a **Stone of Finding**: `lostheroes`, then `recover <id>` on the
  owner's console. (The user corrected this sharply, 2026-09-13.)
- **Junk prisoners block the training hero, and nobody walks 210 cities a day**
  (the user, 2026-09-22). Taking a valley off a real player drops **their** hero into our
  cell — level 2, level 20, worth nothing — and a prisoner **holds a Feasting Hall slot**,
  so a city at ten cannot take the training hero on its round. Seen live 2026-09-22:
  Lord15 and Lord02 were holding Harriet L2, Harlan L8, Philip L12, Morgan L24 and
  Rachel L39. **Releasing a stranger's junk hero is right; releasing one of OUR heroes is
  the mistake above.** The two are told apart by the **fleet register**
  (`fleet_heroes` in `evony.db`): every console writes its own heroes there, rows are kept
  forever, and a prisoner whose **id** — or whose **name** — is on it is never released.
  A captured hero leaves its owner's roster the instant it is taken, so nothing but a
  remembered row can prove it was ours.
  - The bot does this from **`keepcapturedheroes any:level>600|any:base>145`** (the user's
    rule, 2026-09-22): keep a prisoner past level 600 or with a base over 145, release the
    rest. **With no `keepcapturedheroes` line nothing is ever released** — the line is the
    opt-in. `OTTO_NO_RELEASE=1` stops every release fleet-wide.
  - **Take the accounts in a stone-of-finding move out of range first**, or write the
    keep line so it protects the hero being passed: the register does that by itself for
    a hero of ours, but a hero bought or captured on purpose from a stranger is not on it.
- **A city with NO hero is broken, and it is what traps the training hero**
  (the user, 2026-09-22). Nothing is mayor, so production and building run at the bare
  rate and **no troops train at all**; nobody defends; and the city cannot send the
  one-scout march that would fetch a hero, because **a march needs a hero to lead it**.
  When the training hero lands there it becomes the only hero, takes the mayor's office,
  and the rotation then has to stand it down and march it out — **a march that fails if
  the city has no scout**, after which the mayor plan re-appoints it and it is stuck for
  good.
  - Seen live 2026-09-22 across all 210 cities: **3 cities with no heroes at all**
    (Lord03 "6", Lord06 "2", Lord07 "6") and **11 holding ten**, which the training
    hero cannot enter (Lord04 "3", Lord05 "treb", Lord06 "4"/"3"/"2", Lord11 "3",
    Lord12 "7", Lord13 "6", Lord15 "3", Lord17 "2", Lord19 "7").
  - The fix, live from each console's next start: an empty city opens an **Ardee's Sigil
    of Recruitment**, then a **Crystal of Attunement**, else hires from the inn with no
    base bar; a city at ten frees a slot by releasing a prisoner or **marching** its
    weakest idle hero to a city of its own account under 9 heroes; the training hero is
    stood down as mayor whenever it is the only hero in a city it is passing through; and
    its move is **held** rather than the mayor stood down when the city has no scout.
  - **"No heroes" and "the hero list has not arrived" look exactly the same**, and that is
    why nothing is spent on an empty city until it has looked empty for **10 minutes**
    (goal-heroes `EMPTY_SETTLE_MS`). The roster comes in `server.HeroUpdate` pushes, so a
    console that has just logged in reports a SHORT list — the same lie as the 20:20
    entry above — and no check on the fields can catch it, only time. Every other guard
    in that module is about a roster being malformed; this one is about it being short.
  - **City names are not unique, and two cities of one account can share one.** Lord06
    holds two cities called "2" (castle ids 967406 and 775188) — one empty, one at ten.
    Anything that walks the fleet must key on the **castle id**, as the engine's state
    does; a sweep keyed on the name silently merges them.
- **Persuading a prisoner costs nation medals: about 9.1% of its level** (~92 for a level
  1000), plus level × 1,000 gold. **A Stone of Finding recovers a hero for free only while
  the captor has NOT persuaded it**; once persuaded, getting it back costs a stone *and*
  the medals, and `fire` can then lose it like any other hero. Nothing persuades or
  releases by itself — the game needs the button, and OTTObot needs an explicit
  `persuadehero` / `release` line. (The user, 2026-09-20.)
  - This is what the **`evony-stone-glitch` skill** is built on: a hero moves between our
    own accounts for two stones and no medals, A → B → (stoned back to A) → C → (stoned to
    B). The third account is required, because a stone only recovers a hero taken from
    *you*, and it is the recovery off B that puts the hero on B's lost list.
  - **Seen live 2026-09-22 (cptkush L1470, Lord15 -> Lord09 via Lord11): it works.**
    A's `recover` off B put the hero on B's lost list at that same second. The two
    captures took 1 and 4 attacks, with the hero and 1 scout against a well-defended city
    with a level 10 hall. It took 18 minutes and 2 stones. The hero kept its level and
    stats, and its loyalty came back 100. The skill has the timeline and the scripts.
  - **The Trading tab's watchdog will restart an account in the play whose console
    places no orders** — it killed the move script on A once. Take A and B out of the
    running play first.
  - **A hero that is out cannot be stoned back** — it must be sitting captive.
  - **A full Feasting Hall can never capture a hero**: 10 heroes in a level 10 hall means
    the attempt fails however many times it is repeated, and prisoners hold slots too. The
    chance rises with free slots. The city a hero is *recovered into* needs a free slot as
    well. (The user, 2026-09-20 — "0 spaces", not 10.)
  - **A valley can take a hero** like a city can, as long as the defender is a real player
    and **the troops stay in the valley**. NEAT recalls valley troops by default, and on
    our side `config wartown:` and `hiding` both recall everything — an empty valley just
    changes hands and the hero marches home.
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
  - **Reading heroes: a console that has just logged in lies** (2026-09-22 20:20). In
    `scripts/hero-audit.txt`, `city.heroes` came back SHORT (a city with 9 heroes reported
    2) and `heroitems` printed an empty bag on accounts holding 374-518 Excaliburs. A
    `sleep 25` at the top of the script fixed both; the Director's `snapshot.items` is the
    cross-check (`hero.power.1` = Excalibur, `hero.management.1` = Wealth of Nations,
    `hero.intelligence.1` = Art of War, `hero.reset.1` = Holy Water).
  - **Hero attributes in a script**: `power`/`management`/`stratagem` are the BASE; what
    the game shows is base + `powerAdded` etc., and a running Excalibur is `powerBuffAdded
    = 25` on top. An audit that reads `power` alone ranks heroes wrongly (an L894
    politics hero read att 68).
  - **`renamehero <id> OTTO` refuses when another hero already holds the name** — "OTTO
    L1156 in New city, id 167451 already has that name — nothing sent" — and offers
    `anyway`. That refusal is the right answer: `useheroitem OTTO <item>` finds a hero by
    name, so two OTTOs would take each other's items. Check for an existing OTTO first.
  - 2026-09-22 20:26, the six new accounts (Lord01, Lord17, Lord18, Lord19, Lord20,
    Lord21): each one's best attack hero is now named OTTO and carries an Excalibur.
    Three were renamed here (Grover L794, kush L1026, kush L997); Lord01, Lord17 and
    Lord18 already had an OTTO, which was also their best attack hero.
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
- **Holy Water / `waterhero`** — first live run 2026-09-22 on a12 Lord12, `useheroitem
  Kush holywater` (Kush L918 att 993 · pol 26 · int 32): the server refunded all 918 points
  as `remainPoint` with the stats dropping to the birth stats (att 75 · pol 26 · int 32), and
  took **exactly `ceil(level/10)` = 92 Holy Water** (1,814 → 1,722). Verified live. Still
  unseen: whether the server itself refuses a hero that is out (the command refuses first).
  - **Never water without a target.** With no `/heropoints` the refund goes back into the
    highest stat — for a hero built into its birth stat that is exactly where it was, so
    Kush came back att 993 as before and the 92 Holy Water bought nothing. Always name the
    stat: `waterhero Kush /heropoints="pol"`. (Since 2026-09-22 the command says so before
    sending, and also takes `heropoints pol` / `/heropoints "pol"` typed without the `=`:
    the user's `waterhero kush heropoints pol` on a15 had been read as a hero called
    "kush heropoints pol" and sent nothing.)
  - **What a reset can reach.** A hero gets one attribute point per level and a reset gives
    all of them back, so the most any one stat can be made to read is **that stat's base +
    the hero's level**. Two things follow (worked out 2026-09-20 while planning the
    insta-hero moves, from the arithmetic and the 999-hero roster, not yet seen live):
    - **Watering a hero gains nothing in the stat its points are already in.** A
      politics-born, politics-built hero comes back where it started: a10's `npc10` L912
      pol 941 has base politics 941 − 912 = 29 and a ceiling of 941. The gain is only
      whatever points are sitting in the *other* two stats.
    - **An attack hero's politics reading IS its base politics**, because its points all
      went to attack. So its ceiling is `politics + level` — a15's `kush` L1084 (att 1105,
      pol 67) waters to about 1151 politics, past the 1066 trebuchet bar.
  - **The per-attribute base cannot be read before the reset.** HeroBean carries only
    `power` / `management` / `stratagem` (points already included) and `remainPoint`;
    `base` on the script's hero bean is `Game.heroBase`, the **top** attribute less the
    level plus unspent points, i.e. the dominant stat's base only. The individual bases
    come back in the `server.HeroUpdate` that follows `hero.resetPoint` — after the water
    is spent. `scripts/hero-list-base.txt` prints `bsum` (the three bases added up, 100–260
    on a normal hero) so a hero whose points were split across two stats shows itself
    before water goes on it.
  - **There is no permanent attribute item.** The client's item table (itemcatalog.json,
    1,010 items) has nothing that raises attack, politics or intelligence for good: the
    medals `hero.loyalty.1..9` (Cross … Nation) are **loyalty** only and are what
    `persuadehero` wants, and Excalibur / The Wealth of Nations / The Art of War are +25%
    for 7 days. Holy Water and levelling are the only ways a hero's own numbers move.
    (Read 2026-09-20.)
- **A march takes at most 10,000 troops per Rally Spot level**: 10k at L1, 20k at L2 … 100k
  at L10, every troop kind together (the user, 2026-09-18). Over it the server refuses the
  march with "Troops dispatch limit reached 100000" (seen live 2026-09-18 at 20:35: a
  requestresources transport of 199,974 transports for 999,868,896 food). One hide march
  saves at most 100k troops. The level also sets how many marches can be out at once.
  OTTObot caps every march at this (rally.js `marchTroopLimit`; `game.newArmy` refuses
  anything over it).
  - A **War Ensign** (`player.troop.1.a`, `/big`) raises that limit by 25%, so an L10
    Rally Spot carries **125,000** — which is exactly the user's NPC-10 clearing hit of
    115k cataphracts + 6k scouts + 4k cavalry. Without the ensign the server refuses that
    line outright. Lord14 held 547 and Lord15 1,019 on 2026-09-20, so they are not
    scarce; the Horde banner raises it further.
  - **`requestresources` with `/slots:9` eats nine of the ten slots**, which starves any
    attack from that city. Comment those goal lines out for the length of a capture run
    (2026-09-20: Lord14's cities had 2-8 transports out and no room to march).
    **Then a city captured meanwhile asks for nothing** (2026-09-20, Lord14's "New city"
    695,122: 59k troops, 0 food, food −787,870/h, Troops tab "no troop goals for this city").
    Not a new-city bug: prepend goals run in every city, a new one included, with no copy
    (session.cityAdded says "the global goals run there too"; a captured city's own Goals
    window stays blank, that is normal). Its prepend had the `requestresources` lines
    commented out, and no troop lines at all. The user accepted the pause (2026-09-20).
    **Put the lines back when the captures are done** — the active text is in
    `goals-backup-a14-prepend-2026-09-20.txt`. Do NOT copy the prepend into a city's own
    goals: `troop`/`build`/`fortification` stages stack across layers and would run twice.
  - A city may have **as many marches out at once as its Rally Spot level**, and a march
    holds its slot going, camped and coming home. Scripts wait for a free slot from
    2026-09-20 (`script-cmd-deploy.js` waitReady) rather than being refused.
  - *Unverified:* whether the food a march eats on the way is taken from the **city** as
    well as out of the troops' hold. NewArmyWin carries it inside the hold
    (`leftSpace = loads - needFood - resources`), and OTTObot only ever subtracts it from
    what the troops can carry. A script waiting for a transport therefore waits for the
    resources it carries and not a gram more — waiting on food the game may not want
    would hang a transport that asks for everything the city has.
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
- **A city packed to ten heroes isn't really "full" if one of the ten can insta-train
  anyway** (the user, 2026-09-22): a hero with 1526+ attack in that city trains any troop
  instantly regardless of queue, so the city isn't a bottleneck for the training hero to
  worry about — and neither is a city where the traininghero itself holds the tenth slot.
  The Director's fleet "N full (…)" badge (director.html `cityHeroTrouble`, fed by
  snapshot.js `cityList.hasInstaHero`/`hasTrainingHero`) drops a city from the count on
  either condition. `hasTrainingHero` is console-only — a Director-polled account (no
  goals context) can't tell, so it always reads as not-full-because-training-hero for
  those; `hasInstaHero` works everywhere. Needs each console restarted to take effect.
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
- **A batch holds its queue slot, so another hero's batches lock the training hero out**
  (the user, 2026-09-22). A barracks holds as many batches as its level — ten at L10 — and
  one 30-minute batch keeps its slot for the whole 30 minutes. A city that filled nine
  slots with 30-minute batches under its own hero had nothing free when OTTO came round,
  so the one hero that could have put the whole population in at once trained nothing.
  An **instant** batch is the exception: it finishes as it is placed and leaves the slot
  free (above). **Rule: with a `traininghero` named, only it fills the barracks** — another
  hero may queue only what it builds instantly. In the engine this is
  `config trooptraineronly` (line switch `/traineronly`), **on by default**; 0 gives NEAT's
  `troopidlequeuetime` rule back. A hero that has never been mayor in that city and has at
  least the training hero's attack is let through once, so the city measures its speed
  instead of guessing it (hero items are not in the `power` field). Consequence to watch:
  a city now trains only while OTTO is there or when its own hero is insta-grade, so a
  stuck rotation (see the empty/full city entries above) stops training in every city it
  has not reached.
- **Listing every hero of an account:** `scripts/hero-list.txt` on autorun (read-only)
  prints one `HEROLIST` line per hero into `console-<id>.log` — id, name, level, attack,
  politics, intelligence, the Excalibur buff and status — from the account's first city, so
  each hero appears once. Used 2026-09-20 to build the insta-hero table in
  EVONY-STRATEGY.md. The Director's snapshots only carry a hero COUNT.
- **Hero experience:** the next level needs 100 × level² XP (old wiki). Confirmed live
  2026-09-22: OTTO (a22) at L1146 had `upgradeExp` 131,331,600 = 1146² × 100.
  - **Experience past the current level is BANKED, not spent automatically.** The server
    raises the level only when `hero.levelUp` is sent, and **one level per send** — there
    is no "level up to the maximum" command in the client or in NEAT. A hero can therefore
    sit on dozens of levels: OTTO had 9,287,483,523 XP at L1146 on 2026-09-22, enough for
    **66 levels**, and nothing had taken them.
  - **The Heroes tab's `Pts` column is UNSPENT points (`remainPoint`), not "points the
    experience is worth".** A hero that has spent every point it has won reads 0 there
    however much XP it holds — OTTO read 0 with 66 levels banked, which looked like
    levelling was broken. The console now also shows the banked levels (`1146 +66` in the
    Lvl column, a **Level** button, and "Banked — 66 level(s) ready" on hover).
  - **Each level gives 1 attribute point** (that is why `Game.heroBase` subtracts the
    level from the top attribute; OTTO: base 65 + 1146 levels = 1211 attack, pre-buff).
  - **`uplevelheroes` takes each hero up ONE level per call**, as NEAT's does, so banked
    levels need a loop: `config hero:1` / `uplevelheroes` / `repeat 70`. For a single hero
    with no goals, `levelup <hero> attack` / `repeat 70` does the same and needs no
    `config` line. Both count `repeat` **in total**.
  - **A `config hero:1` a script sets itself counts, since 2026-09-22.** Until then
    `script-cmd-hero.js` read only the *saved* goals, while a script's `config` line lands
    in the goal **layer** — so a script that set `config hero:1` on its own first line was
    still refused by the next line with "uplevelheroes needs config hero:1 or more".
    It now reads `goallayers.runningGoals`, as `script-cmd-deploy.js` already did.
    **Needs a console restart to take effect.**
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
    corselet)) / 1000. The corselet is 1.2 (the old guides and the client's item text; the
    user once remembered 1.25). Damage reduction is **capped at 50%**, so at
    most a unit's health doubles.
  Attack has no cap, and that is why it outweighs intelligence.
- **"Perfect intelligence"** is the intelligence at which a troop reaches that cap, with Iron
  Working 10. Intelligence above it does nothing for that troop.

  Base stats come from the game client's own troop table (WarReport.swf `XMLTroop`, read
  2026-09-18). The intelligence needed is the smallest int where
  defence × (1.5 + int/100) × corselet ≥ 500.

  The corselet's own item text in the client says **+20%** ("Increase Defence of troops by
  20%"), and the old guides use 1.2. The user remembered +25%, then (2026-09-22) chose
  1.2 to work with, so trust the +20% column until a war report with a known hero
  intelligence settles it. The intelligence columns (scouts included) were worked out by an agent from
  this formula, not measured (the user, 2026-09-22), so the scout figure is the formula's.

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
- **March times are exact to the millisecond** (2026-09-22). A march's `reachTime` and
  `startTime` are server-clock epochs in ms with real millisecond digits (a2's log,
  e.g. `reach=1789913236356`), so two waves a few hundred ms apart are told apart. The
  march lists (`selfArmys`, `enemyArmys`, `friendArmys`) are pushed whole on every change,
  so a console always holds the current ones and a page can read them every second at
  no cost to the game. The army's hero is given only as a name and level (no hero id).
- **The server counts march time in WHOLE SECONDS: the client formula's time rounded
  down** (2026-09-22, `marchcheck` on Lord02: 20 of 21 marches out read the formula
  minus its fraction, e.g. formula 3m 18.762s → server 3m 18.000s; one read +1 ms).
  `reachTime − startTime − camp` is always a whole second (± 1 ms). Planning a timed
  march with the fraction lands it up to a second EARLY. That is likely the −1 s…+1 s
  spread the user saw from NEAT's `@:` times. timed-march.js rounds down since then.
- **An attack needs a hero** — the server answers `ok=-71` "You must appoint a hero to
  lead the attack." (2026-09-22, Lord02). The client's march window offers "no hero",
  but that is for transports, reinforcements and scouts.
- **A march sent with camp time lands at `reachTime`, and `reachTime` already counts the
  camp**: send + march + camp, to the millisecond (verified live 2026-09-22, 8 timed attack
  waves from Lord02's city 8 at an NPC 2.8 tiles off; the server's `reachTime` came out
  exactly as planned). `restTime` on a march already out **counts down from the send**, in
  seconds: waves sent with 331 s read ~225 s 108 s later. So never take `restTime` off
  `reachTime` to get the march time once the march has been out a few seconds (that
  broke `marchcheck`, fixed the same day). *Unverified:* what a march shows as direction 3
  (camped).
- **Timed waves, live (2026-09-22, Lord02 → NPC 711,125, 1 scout each, all recalled
  before landing):** within ±500 ms, 3 waves at +206/+104/+184 ms; within ±100 ms, −30/
  −14/+0 ms; within ±20 ms, +10/−3 ms. Every wave was good first time. The server took each
  send within ~0–200 ms of the aimed moment, and the send lead settled at ~355 ms ahead
  (this PC, direct to ss71). No lag spike came along. **Recall-and-resend, live** (06:45,
  ±1 ms on purpose, 2 waves × 3 tries): a miss is recalled ~0.3 s after the server's stamp
  arrives, the army is home ~0.5 s later (it had only just left), and it goes again with
  1–2 s less camp. The misses shrank as the lead learned, +199 → +95 → +47 → +31 → +12 →
  +3 ms. A recall this early costs nothing. **The rally spot was the limit:** NPC farming (`config npc:5`)
  held all 10 slots, and one wave waited 2 min and never went. Before timed waves,
  switch the sending cities' NPC farming off (`config npc:0`) and have idle heroes ready,
  one per wave (an attack needs a hero).
- **Loyalty and capture** (the user, 2026-09-22):
  - Each attack wave takes **1–4 loyalty**. Bigger waves take more, and the attacking
    hero's attack counts too. The user's rough figures for a level-500 hero, cavalry and
    scouts in equal numbers: 250 each → 1, 500 each → 2, somewhere in 1,000–2,000 each →
    3, about 2,000+ each → 4. *Unverified:* the exact steps, and whether a lost wave
    takes any.
  - **Loyalty + public grievance + tax = 100.** A healthy city at 0% tax is 100/0.
    Tax comes out of loyalty: 10% tax makes it 90/0/10. A lost battle moves points from
    loyalty to grievance: one −4 at 10% tax makes it 86/4/10.
  - Waves take loyalty **only down to 15**. Below that, the waves only add grievance.
    Whenever loyalty + grievance + tax is over 100, loyalty falls **1 every 6 min 30 s**
    until the sum is 100 again. So at 0% tax, 15/85 holds steady, 15/89 falls to 11/89,
    and 15/100 falls all the way to 0. **Comforting** the people lowers grievance and
    stops the fall. *Unverified:* how fast grievance and loyalty recover on their own.
  - **The four comforts** (Town Hall; `interior.pacifyPeople` typeId; NEAT wiki `Comfort`
    page, read 2026-09-22, lists the same four and gives no numbers):
    1. disaster relief: +5 loyalty, −15 grievance
    2. praying: +25 loyalty, −5 grievance
    3. blessing: costs food equal to the population limit plus a tenth of that in gold.
       The client's text (WarReport.swf Lang, read 2026-09-22): "Success in escaping from
       a disaster might lead to one additional Blessing" (Chinese: avoids one natural
       disaster, with a chance of one heaven-sent gift). So it guards against one random
       city disaster. *Unverified:* what a disaster or a gift does. The NEAT wiki says
       nothing about it.
    4. population raising: **+5% of the population limit** (floor), never past the
       limit; food = 5 × the limit. That's the town hall window's own text (client code).
       The user remembered +10%.
    Relief and praying numbers: the user and the client code agree (2026-09-22). Both
    cost food: prestige / 10 × city count × a per-city factor, capped at 10m (NEAT's
    ComfortPolicy page warns of the 10m on big accounts).
  - **A levy costs 20 loyalty** and takes one resource from the city's idle population
    (`interior.taxation`: 1 gold, 2 food, 3 wood, 4 stone, 5 iron). The town hall's levy
    window (client code, CollectionMaterialsView.as) shows, per current population:
    **gold × 0.1, food × 1, wood × 1, stone × 0.5, iron × 0.4**. So 121,050 civilians
    give 12,105 gold. The user remembered 1 gold per civilian (121,050); NEAT's wiki has
    no numbers. *Unverified* live: one gold levy on a city with a known population
    settles it.
- **NPCs regrow 10% of their full strength per tick** (the user, 2026-09-22). An NPC 10's
  400k warriors come back 40k a tick, so an empty one is full after 10 ticks. The user
  gave the tick as 8 minutes, then as 10 minutes in an example, so which it is stays
  *unverified*. **Forts don't regrow** (the user, 2026-09-22).
- **NPCs, flats and abandoning** (the user, 2026-09-22): NPC cities stand on flats.
  **Abandon a city and it becomes an NPC** at its town hall's level: take a level-1 flat,
  build a city, raise the town hall to 5, abandon it, and it's a level-5 NPC. **Teleport
  the city away instead and the tile stays a level-1 flat.**
- **Valleys grow at each maintenance** (the user, 2026-09-22): every valley nobody owns,
  flats and lakes included, goes up 1 level. An owned valley stays at its level.
  *Unverified:* the top level, and whether NPC cities are affected.
- **Prestige** grows from producing resources and troops, building, finishing quests and
  research, and beating NPCs (the user, 2026-09-22).
- **Honor and healing** (the user, 2026-09-22):
  - Honor rises when you **win** a battle and kill more than you lose. When you lose
    more than you kill, it falls. A lost battle gives no honor.
  - Attackers usually lose honor wave after wave, until the wave that wipes the city,
    which usually kills a pile of transporters and wins it back.
  - **Healing depends on the two sides' honor.** The side with much less honor heals
    50% of its losses (65% with penicillin); the side with much more heals 10% (13%
    with penicillin). 1 honor against 10,000: the 1-honor side heals 50%. It reverses
    when the honor does. *Unverified:* how the percentages move between those ends.
- **Hero capture odds** (the user, 2026-09-22) depend on the losing hero's loyalty and on
  the free spaces in the captor's feasting hall. **With the feasting hall full, a hero
  can't be captured at all** (the user, 2026-09-22).

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

- **Until 2026-09-22 no security code was ever stored** through the Director's ✎ dialog,
  the console's settings or `securitycode set`: the org-scoped account store
  (`tenancy.js accounts.upsert`) left the column out, so every save silently dropped it,
  and on 2026-09-22 no account in evony.db had one (read from the live database,
  read-only). Fixed in tenancy.js that day, live from the next restart of the Director
  and of each console; **every code the user believes is stored must be entered again**
  after that. `test-director-accounts.js` covers the round trip.

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

## 5e. Teleporting a city (moving the fleet together)

- **The three items, three commands** (`teleport.js`): `teleport <x,y>` spends an
  **Advanced Teleporter** and lands only on a flat **nobody holds**; `warteleport <x,y>`
  spends a **War Teleporter** and lands on an **NPC camp**, which is gone afterwards;
  `teleport <state>` / `teleport random` spends a **City Teleporter**. `from <city>`
  moves another city — but only where city names are unique (Lord14 has five called
  "Eldian"), so a control file keyed on `city.cityManager.coords` is the safer way to
  drive a fleet move.
- **The item ids — count by id, never by a word** (2026-09-22: a search for "move" found
  only `consume.move.1` and reported "no War Teleporters" on five accounts holding 277–368
  each): Advanced = `player.more.castle.1.a`, War = `player.more.castle.1.c`, City
  Teleporter = `consume.move.1`.
- **Refusal codes:** -77 armies of that city still out, -78 alliance troops stationed in
  it, -81 the tile is not an empty flat (someone holds it), -84 it is already yours, -90
  teleport cooldown. A refused move **does not spend the item**.
- **The map cache cannot tell you who holds a tile.** A scan brings the terrain
  (`mapStr`) and the castles, nothing else, so a flat someone has claimed looks exactly
  like a free one. The owner comes only from `field.getOtherFieldInfo` — in a script
  `UpdateDetailInfo(GetFieldId("x,y"))`, which returns `userName`, `allianceName` and
  `canOccupy`. `GetDetailInfo` is not enough: it hands back the cached scan tile, which
  has no owner. `scripts/teleport-probe.txt` reads a list of tiles this way.
- **2026-09-20, around our hub (703,114): not one free flat within 9 tiles.** All 24
  nearest candidates were read live: every flat is claimed — `709,120 696,121 695,118
  710,122 711,121 694,122` by **JackylBlue (We3Kings, our own alliance)** and
  `701,123 694,119 714,107` by **Phrac (OutCasts)** — while 13 NPC camps at the same
  distance were free. So a fleet move into a crowded hub is a **War Teleporter** job, not
  an Advanced Teleporter one, unless flats are captured and given up first.
- **What wins a capture (the user, 2026-09-22):**
  - Against **player cities and barbarian (NPC) cities**, scouts alone always lose. Add
    cavalry: **at least 500**, and more the stronger their defences.
  - Against **valleys and flats, scouts alone capture**. Send **~100k scouts** instead of
    cavalry, because scouts march faster. This morning's flat-take.txt used 5k cavalry;
    the flat scripts use scouts from 2026-09-22 11:45.
- **Flats: ownership doesn't count — the user's rule, 2026-09-22.** To pack our cities
  tightly around the hub, a flat held by ANYONE (other alliances, and our own alliance's
  players too) may be captured and abandoned so the tile is free for an Advanced
  Teleporter. We don't respect anyone's ownership of flats. The NPC10 rule below still
  stands: never war-teleport onto an NPC level 10 — those are captured for extra cities.
- **The hub has only 8 flats within 9 tiles** (map cache 2026-09-22): 709,120 (d6),
  696,121 (d7), 695,118 / 711,121 / 710,122 (d8), 694,119 / 694,122 / 701,123 (d9) — the
  rest is 127 player cities and valleys, and a city can't land on a valley. The nearest
  non-L10 NPC camps are 10–12 out. So "tight" = those 8 flats first (capture + abandon with
  a hub account — `scripts/flat-take.txt` on Lord15), then NPC camps outward. Teleport
  targets go in `scripts/teleport-targets.txt` as `adv <flat>` / `war <npc>`.
- **A war target can read "empty flat" before the city moves** (2026-09-22: six of the
  new accounts' targets — 713,123 713,124 692,125 691,110 715,117 692,126 — read so about
  an hour after they were chosen). `warteleport` then refuses without sending. Switching
  the line to `adv` landed Lord17's two. *Unverified* whether the camps really changed:
  see the stale-cache entry below, which explained Lord21's two.
- **`ok=-84` "Unable to teleport city to a preoccupied valley" = another player holds
  that flat.** Our console adds "— that tile is already yours", which is WRONG here
  (2026-09-22). Lord21's two towns got -84 onto 715,117 and 692,126; the owners read
  EverKnight and Karnage, and a fresh relog showed both towns still at their old tiles
  (744,156 and 794,233). First thought (the user's, and mine): stale coordinates after a
  move. The relog ruled that out. **Don't abandon on your own** (the user stopped it
  here). Under the flats rule the tile can be captured and given up, but ask first. A
  refused teleport costs no item.
- **Flats given up at the hub came back as NPC camps** (2026-09-22, map cache 14:38-14:45).
  The flats Lord15 had freed that morning for the new accounts' Advanced Teleporters read
  as Barbarian's cities a few hours later: **694,122 and 701,123 as NPC level 10**, 695,118
  as L7, 694,119 as L4. Every `adv` teleport aimed at them was refused all afternoon, and
  694,122 even printed "is an NPC camp (level 10)". *Unverified* how (an abandoned city
  turning barbarian, or the map re-seeding). So a freed flat is only good for a few hours;
  re-read a target tile before relying on it, and `war`-teleport onto the camp if it turned
  into one (never onto a level 10).
- **War teleports from a freshly restarted console landed at once** (2026-09-22 14:50,
  the NPC10 drive): 11 of 13 far cities of Lord17, Lord18, Lord19, Lord21, Lord20 and
  Lord01 answered `ok — now at …, N War Teleporter left` on the first try, and the map
  scan two minutes later showed them there as player cities (not the stale-client false
  success of 2026-09-20). The two refusals were cities with armies still out.
  Again 2026-09-22 18:55: Lord01's last 7 far cities (only 2 had ever been given a
  target) all landed on non-L10 NPC camps 13-14 from the hub in one second, 0 retries,
  **confirmed by a relog** (NPCCAP coords). wartown:1 had kept their armies home, so
  nothing blocked the move. Pick targets from `D.mapCache.npcs()` (scans refresh it
  every ~30 min) and leave out the tiles already in teleport-targets/glitch-jobs.
- **Transports to the hub from far-away cities take HOURS to come home**, and the city
  can't teleport until they do (-77). The new accounts' transports to 702,111 were due home
  11:20–15:49 on 2026-09-22. `config wartown:1` stopped new ones (every army listed was
  on its way home), but the ones already out still have to land. `teleport-job.txt` now retries for 6 hours, not 1½.
- **Landing on an NPC works and is instant** (first live proof 2026-09-20 11:33:
  Lord14 447,759 -> 706,123, an NPC L2). **Never war-teleport onto an NPC level 10**:
  those are captured for extra cities (the user, 2026-09-20).
- **Recall first, then wait — `recallall` is not enough.** The server refuses with
  `ok=-77` *"Recall all the troops before you teleport city."* while **any** army of that
  city is away, including one already on its way home, which cannot be recalled at all.
  `recallall` only recalls what LEFT this city and is outgoing (direction 1) or staying
  (3), so it can answer *"no army from &lt;city&gt; is out"* and the move still be refused
  (Lord14, 2026-09-20). **Nor is `city.selfArmies` the test**: it showed 6-10 per
  city for armies that were not this city's own marches at all. The only honest test is
  whether the city is standing on the target afterwards
  (`city.cityManager.coords == target`), so the move script retries on a timer.
- **A teleport can report success and NOT have happened.** On 2026-09-20 three of
  Lord02's five cities logged `TELEPORT result … now at 704,124 after 0 tr(y/ies)` and
  were still on their old tiles — 9 at 571,648, 8 at 489,678, 7 at 577,620. The test
  `city.cityManager.coords == target` reads the CLIENT's cached castle record, and that
  record had taken the new tile while the server had not moved the city. The snapshot
  agreed with the client for half an hour, because the snapshot is built from the same
  cached object. **Only a fresh login tells the truth** — the console's city tabs after a
  relog showed the real coordinates.
  - The damage: those cities then read a hub job and sent capture waves **511 miles**,
    eight marches of 10,500-13,000 troops each with a hero apiece, four hours out.
  - It also breaks the recall: `recallall` matches an army by `startFieldId` against
    `castle.fieldId`, so while the client holds the wrong tile for a city it answers
    *"no army from &lt;city&gt; is out"* about armies that are plainly marching.
  - **So verify a fleet move by relogging the account and reading the city list again**,
    never from the figure the move itself printed.
- **A refused teleport sets `$error` to just `"failed"`** — the server's code and words
  go to the console log, not into the script. Never branch on the text of `$error` here.
- **An army out on an ATTACK recalls at once and the move goes through on the first try**
  (Lord02, 2026-09-20 14:48). Its five cities were each carrying NPC farming marches
  when `teleport-job.txt` ran; `recallall` pulled them back (`recall army … (attack from 9
  to Barbarian's city(566,645), hero …) -> ok`) and four of the five landed on their NPC
  camp with **0 retries** — 709,124, 709,123, 704,124 and 713,120, half the map away, in
  one second each. So the hour-and-a-half of retries Lord14 needed was about
  **transports already on their way home**, which cannot be recalled at all; an attack
  march out is no obstacle at all. A farming account is the easy one to move.
- **The "N held" count a teleport prints lags** (2026-09-20). Lord02 held 22 War
  Teleporters; after four cities had landed the console still read `21 held`, and so did
  the Director's snapshot half an hour later. The number comes from the console's cached
  inventory (`teleport.js heldCount`), which the server evidently does not push an update
  for. Count the moves, not the badge. *Unverified:* whether a fresh login corrects it.
- **`traininghero` deadlocks the LAST city of a fleet move** (Lord02 city 5,
  2026-09-20). The goal reinforces the training hero on to the next city, so the city it
  is sitting in always has an army out; `teleport-job.txt` recalls it every minute
  (`recall army … (reinforce from 5 to Flat(709,124), hero OTTO) -> ok`) and the engine
  sends it again about two minutes later, for ever. It only bites once the other cities
  have already moved — the trip is then the width of the map, so the hero is never home.
  It took **34 tries (35 minutes)** against 0 for its four sisters, all `ok=-77`; the
  sends only stopped once `traininghero` was commented out of that account's goals, and
  the city landed ~20 minutes later, when the last recalled trip had finally flown home. **Pause `traininghero` before moving a fleet**, with
  `defensepolicy` and `requestresources`, and put all three back afterwards. (The goal
  table is read live each engine pass, so a goal edit needs no console restart.)

## 5e1. Smashing an NPC10 for an ally

- **Waves you cannot recall will land on your ally's new city.** 2026-09-22: Lord08's two
  burst cities fired at 679,135 at 18:51-18:52; the server's own stamps said they would
  land at 19:05-19:06 (793 s and 835 s). Lord22 captured the tile before 19:00:39, when
  Lord04's `ally-drain.txt` read it as no longer an NPC and recalled Lord04's attacks. Nobody
  recalled Lord08's: `ally-burst.txt` fires once and had no stop path, and its loops had
  been stopped at 18:57, so ~4 waves of 15k cataphracts + 15k cavalry + 5k scouts hit an
  **alliance member's** brand-new city. Lessons:
  - A loyalty wave is only safe while the target is an NPC. **Every script that sends
    them must also be able to recall them** — `ally-burst.txt` now honours `allyStop = 1`
    in `ally-targets.txt` (once: `endloyaltyattack`, then `recall <target>`).
  - A stopped script recalls nothing. When a run is ended by hand, recall its marches by
    hand too.
  - Time the last wave: read the server's `reachTime` (§ march times) and stop sending
    once the ally is close to landing his capture.

## 5e2. Transporting resources to another account

- **Never transport to an account with 2.5x (or more) your prestige** (the user,
  2026-09-22): the march still goes, but a large part of the resources and ~40% of the
  transporters are lost. Check the ratio of receiver to sender prestige before every
  shipping run; `scripts/job-ship.txt` re-reads both live with `who` and refuses 2.0x or
  more (a safety margin under the 2.5x line).
- **Never use Horde banners for transports** (the user, 2026-09-22). War Ensigns were left
  out too (not asked; a transport runs at 100k transporters a march).
- The pace is set by the transporters a donor city owns, not by march size: Lord04 held
  1.5–2.2m a city, Lord08 ~1.1m, the other donors 2k–125k (2026-09-22 17:22). A march of
  100k at Logistics 10 carries ~900m after its own food.
- **CORRECTION (same day, 17:55): the `· march Ns` a transport prints is NOT the real
  time.** It came out at exactly **400.0 s per tile** on every account, Lord04 and Lord08 with
  two Fleet Feet on as much as Lord10 with none, so it is the console's own sum with no
  buffs. The real pace is much faster: Lord15's city 3 got a slot back 21 minutes after
  its first march, which the printed figure put at 68 minutes there and back. The user:
  **a transport takes ~80 s a mile with Fleet Feet on.** Use that for estimates, and
  treat the figures below as the console's, not the server's.
  - **Proof from what landed:** shipping began 17:22; Lord17's towns went from 0 to 27b
    wood / 26b stone / 31b food by the 17:27 snapshot, from donors 5–12 tiles away that
    the console priced at 30–80 minutes one way. So transports land within minutes.
  - An attack march prints **80 s per tile** (2,176 s for 27 tiles, Lord04 → 679,135), the
    same console sum; transporters are 5x slower than cataphracts in the troop table,
    which is where the 400 comes from. Neither printed figure should be trusted; judge by
    what arrives.
- **The server's arrival time is in `city.selfArmies[i].reachTime`** (`TimeDiff(reachTime)`
  = ms from now; `direction` 1 out, 2 home). Read it instead of the printed figure (the
  user, 2026-09-22: "the server should tell you how long"). First reading, 18:41: Lord04's
  115k-cataphract hits sent 18:19 from 27 tiles were already homebound, due home 18:47–18:48,
  i.e. **~14 minutes one way at cataphract pace with Fleet Feet (~30 s a tile)** where the
  console printed 36 minutes. `city.selfArmiesArray` read empty in the same script.
- **`ok=-13` "You can't perform this operation against this target"** on a transport =
  the receiver is not an ally (Lord01 after it left 1111, 2026-09-22). Transports only
  go to allies (or friends, *unverified*).
- **`recall <x,y>` recalls EVERY attack of the account on that tile, from all its cities**
  (2026-09-22 18:06, Lord04: one city's `recall 679,135` pulled back all 23 marches of three
  cities, the clearing hits included). It happened twice, because a console restart re-ran
  the one-off. To call back one city's marches use `idrecall <armyId>` from that city's
  own list (`job-stuck.txt` does), or `endloyaltyattack` for its capture task.
- **Transports are slow even inside the hub** (2026-09-22 17:26, the `· march Ns` the
  console prints; see the correction above): 800–1,650 s for 3–6 tiles, 3,000–5,400 s for 10–12, **6,597 s (110 min)**
  for 17 (Lord04 696,109 → Lord17 713,108), 7,725 s for 15 from Lord08. So a shipping plan must
  send each town's goods from the donors NEAREST it — the first plan spread the load
  evenly and sent marches 17 tiles. `scripts/ship-plan2.txt` (v3) is generated by giving
  each 900m piece to the donor city that would finish soonest (its ten slots, its march
  size and the round trip). At that pace ~2.4t over 36 donor cities is **a 15–20 hour job**.
- `ok=-51` "No more troops are allowed to sent at current level of Rally Spot" on a
  transport that had just waited for a slot = another march took the slot first; retry.

## 5f. Alliances

- **Leaving and applying work from a script** (first live use 2026-09-22 17:06, the user
  moving the hub fleet into We3Kings): `command "quitalliance confirm"` then
  `command "apply We3Kings"` answered `ok` on all 11 accounts: Lord20, Lord02
  (bootcamp), Lord10, Lord12, Lord15, Lord17, Lord18, Lord19, Lord21 (1111),
  Lord11 and Lord13 (1112). None was refused, so none of them was 1111's or 1112's host,
  or a host can quit too (*unverified* which). Leaving costs **10% of prestige** (the
  client's `SAY_BYE_TO_ALLIANCE_PRESTIGE_DEDUCT_RATE`, *unverified* live). An application
  still has to be **accepted** by the alliance's host or an officer.
- The alliance name is `player.playerInfo.alliance` in a script (the snapshot's
  `alliance`); an account in no alliance reads `null`.
- **Holiday accounts were left out on purpose** (Lord06, Lord07, Lord14): whether
  an alliance change is allowed on holiday, or touches the holiday, is not known, and
  holiday in/out is the user's alone.

## 5g. Quests, and the free daily amulet

- **A finished quest pays nothing until it is claimed.** The game's Quests window has two
  tabs — Routine (`quest.getQuestType type:1`) and Daily (`type:3`) — and each finished
  quest sits there, with its reward, until the Claim button is pressed
  (`quest.award {castleId, questId}`). Nothing expires it, so an unclaimed quest is not
  lost, only late. (Client: QuestCommands.as, QuestWin.as:641/1293/1649-1650.)
- **The free daily amulet is a Daily-tab quest** (NEAT wiki CompleteQuests: "any routine
  quests or daily quests (such as the free daily amulet)"). Until 2026-09-22 **no account
  in the fleet had ever claimed one**: `completequests` existed only as a script command
  and nothing ran it (the user noticed). The `completequests` goal (goal-quests.js) now
  claims both tabs in every city with goals, on by default. *Not yet seen live* — what the
  daily amulet actually pays, and whether the Daily tab resets at maintenance or at server
  midnight, is unverified.
- **Claim a title before a rank.** The Promotion quests are the titles (Knight →
  Prinzessin) and the offices (Lieutenant → General), and the game lists them mixed, so
  claiming "the first finished one" takes Major before Baronet. A title is the one worth
  hurrying: **the city cap is titleId + 1** (§7). This is NEAT's Global Settings option 3,
  and what OTTObot does by default.
- **Reading a quest list is cheap.** Each quest type comes back with `isFinish` — "there
  is something finished in here" — so a tab with nothing finished costs one request and no
  list read at all. A claim can open the next quest in a chain, so the list is re-read
  after every claim.
- **There is no "accept" step.** QuestCommands.as has getQuestType, getQuestList, award,
  getAwardItems, awardPacket and AllowRegister — and no accept: a quest is simply there,
  and becomes claimable when its targets are met. (`awardPacket {castleId, questId, key}`
  is called from nowhere in the client; the Claim button always sends plain `quest.award`,
  card quest or not.) So "claim every finished quest" is the whole of it.
- The reply to every quest command names only the command, not the tab, the type or the
  quest it answers, so each one has to wait in its own lane — the same trap as the market
  and report reads, and as the per-city queue reads in §1.

## 6. Game data and references

- The NEAT wiki (http://guide.neatportal.com/wiki/, plain HTTP only) is the spec for goals
  and scripts. Fetch raw pages with `?action=raw`, **one request every 4 s** — parallel
  fetches trip surge protection and lock you out for an hour.
- English names and item tables come out of the game client's `WarReport.swf`.
- **The Statistics (rankings)** are four read-only requests,
  `rank.getPlayerRank / getAllianceRank / getHeroRank / getCastleRank {key, pageNo, pageSize,
  sortType}` (RankCommands.as). `key` null is the whole list; a name makes the server
  answer with *the page that name is on* (RankWin.as searchOwer/readFromServer set pageNo
  from the reply and highlight the exact name). The game's window asks 10 a page and
  starts at sortType 0. Read from the client code on 2026-09-19 for the console's
  Statistics tab (`statistics.js`).
  **Seen live 2026-09-19** (a Refresh through Lord04, left in the database's `stat_meta`, found
  2026-09-22): the server **takes pageSize 100** with sortType 0; players ran to **247
  pages (~24,700 players)**; 94 pages came in 56 s (**~0.6 s a page** with the 250 ms
  pause). That read then died at page 94 (most likely a console restart) and alliances,
  heroes and cities were never read — so since 2026-09-22 the tab browses page by page from
  the server (5 read ahead) and a Refresh reads alliances first and carries on from its
  last page. **Unverified live:** what sortType 0 sorts by, what a `key` search answers
  beyond the name's page (the console shows only exact matches of it), the other lists'
  sizes, and whether heavy reading adds to an account's rate limiting. The crawl and the
  read-ahead send one page at a time and wait while the account has more than 10 market
  writes in flight. Prefer a Refresh from an account that isn't in a trading play.
- **The Alliance window** (console's Alliance and Friends tabs, `alliance.js`, read from
  the client code on 2026-09-22, **none of it sent live yet**): `alliance.isHasAlliance {}`
  answers the Info tab (`indexAllianceInfoBean`: creatorName, leaderName, memberCount,
  memberLimit, rank, prestige, allianceInfo = intro, allianceNote = notice) *and* the
  friendly / middle / enemy lists in one reply; `alliance.getAllianceMembers {}`,
  `alliance.getAllianceEventList {pageNo}` (events of {eventName, time}),
  `alliance.getMilitarySituationList {pageNo, pageSize 10}` (war reports, each carrying its
  report XML). The friends and block lists are the login's `friendBeans` / `blockBeans`,
  which each `friend.*` reply replaces. The game's member window allows **Expel** only on a
  member ranked below you (levelId larger: 4 host, 5 vice host, 6 presbyter, 7 officer,
  8 member) and **a new position** only when you are host, vice host or presbyter and they
  rank below you; rank limits are 2 vice hosts, 5 presbyters, 10 officers
  (AllianceConstants). *Unverified:* who may change a standing (the console lets host and
  vice host try and leaves the rest to the server), the reply's exact shape. Record the
  first live read here.

## 7. Operating the fleet

- **The Director's own poller kicked the whole fleet off (fixed 2026-09-22 22:50).** The
  poll cycle asked *once, at the top,* which accounts a console was holding, then walked
  the fleet one account every 25 s — nine minutes for 21 accounts. After the reboot that
  set was taken at 22:29:14, when nothing was running; the consoles came up at
  22:29:48–22:30:07; and from 22:31:51 the poller logged in to one account after another,
  **kicking its own consoles**, 31 seconds apart. Each console read that as *another user
  has logged into your account* (which it was — the Director is another user) and stood
  down 30 minutes: **13 accounts parked**, the Director's page a wall of "someone else
  logged in". The holds were ours, not NEAT's: every one was set between 22:31:51 and
  22:39:07, exactly one poll gap apart. Now the poller asks again for each account,
  immediately before its login (`heldByConsole`, director.js), and the 13 holds were
  cleared by hand so the fleet came straight back. Regression test: `test-poll-skip.js`
  (it fails against the old check). **Any check of "is something else on this account"
  has to be made at the moment of the login, not at the top of a loop that lasts
  minutes.**
- **A console window flashing on the desktop every few seconds was the Director's own
  `tasklist`** (2026-09-22 23:00, found by sampling Win32_Process every 200 ms: a
  `tasklist` child of the Director, each one spawning an `OpenConsole.exe` — the Windows
  Terminal window that flashes). It counted NEAT's processes for a figure in the Fleet
  header; `/api/accounts` called it, and **every open Director tab polls that every 5
  seconds**, so the flashing multiplied by the tabs left open. The count was a holdover
  from NEAT's own dashboard that nothing read, so **it and the scan were deleted at the
  user's word** (23:05); the `windowsHide: true` + 30 s cache that preceded that had
  already taken 45 s from 8 spawns to 1, and **0 OpenConsole**. Two lessons that outlive
  the feature: a child process spawned without `windowsHide` puts a window on the user's
  screen, and anything a page poll can reach is called every few seconds per open tab,
  not "once in a while".
- **After a reboot, start the Director and nothing else** (measured 2026-09-22 22:28). The
  laptop restart took all 22 consoles and the Director with it. Starting the Director
  alone — `node director.js`, detached, stdout appended to `director.log` — brought the
  whole fleet back in **about 80 seconds**: its keep-on watchdog (every 60 s) starts a
  console for every account with *Keep bot on* set, about one a second, and each logs in
  by itself. 20 of 22 were logged in at 22:31; the other two were correctly sitting out
  kick holds. **Holds survive a reboot** — they live in the org's settings, and both the
  Director's poller and the console honour what is left of them.
  Two things to expect in the log in the minute before the consoles arrive: the Director
  **polls the accounts itself** (`Lord03: ok (10 cities...)`) because nothing holds
  them yet, and it says *"no console is running — click the row to start one"* for every
  account one cycle before the watchdog starts them. Neither is a fault. No console
  kicked itself on the way up.
  Only a22 Lord22 has *Keep bot on* off, so it is the one account that stays down.

- **Never `require('./director.js')` or `require('./server.js')` to check a change —
  that STARTS a Director or a console.** Use `node --check <file>`. On 2026-09-22 13:37
  it was done by mistake, twice. Both died on `EADDRINUSE 127.0.0.1:8712`, and everything
  a Director does at boot (starting consoles, polling, the trading ticks) sits in the
  listen callback, so nothing ran. A free port would have made a second Director.
- **Kicks arrive as a bare server close (2026-09-22).** The ~30-minute disconnects on
  every console are **NEAT's logins taking the account** (the user). No
  `server.KickedOut` / `gameClient.kickout` has ever been seen. evony.js now records who
  closed a socket: us (`close()`), a socket error, or the server. session.js logs `socket
  closed by … — the last it sent: …`. With the account's **"After a kick (min)"** set
  (Director ✎ / Accounts grid, org setting `kickHoldMin:<id>`), a close by the server
  starts a kick hold for that long. Maintenance is excluded (planned stand-downs, and a
  hold dropped if the server turns out to be in maintenance). Blank or 0 = straight back,
  as before. Live per console from its next start.

- **CPU: the control file's transit walk is almost all of it** (profiled live 2026-09-22
  during the wood play). The fleet used about 5.4 Ryzen cores, and ~92% of that was the 9
  BUYING consoles (0.45–0.62 core each). The sellers skip the walk and use 0.01–0.05
  each. Every buying city walks `city.transingTradesArray` (~900 entries a city), and
  every read of that array rebuilds the city view and copies the whole list
  (script-objects.js `tradeBeans`), so each pass is quadratic: ~34k script statements
  and ~20k list copies a second on one console. It also adds ~55–60 ms to every loop
  pass. Decoding, HTTP, logging, the Director and snapshots are each under 1%. **Don't
  add per-entry loops over trade lists to the control file.** Fixed in code
  2026-09-22 13:09:
  - `city.transitAmount(rt)` and `city.restingAmount(rt, type)` are built-in sums,
    cached per pushed list.
  - The interpreter yields every ~1 ms instead of before every line.
  - Offline, a city pass fell from 33.8 ms to 5.2 ms. The fleet should need about 1.1–1.3
    cores instead of 5.4.
  - It takes effect per console at its next start. `scripts/glitch-res-control.next.txt`
    (built by the scratchpad's `mknext.js` from the live file) goes in only once EVERY
    console running a glitch script has restarted: an older console fails on the new
    calls.
  - Also built as opt-in commands, not yet used by any script: `waitslot` (returns when a
    slot frees) and `tradepace` (waits only for the rest of the pacing).
- **Profiling a live console** without a restart works: `node -e
  "process._debugProcess(<pid>)"`, then the inspector on 127.0.0.1:9229. It stays open
  until that console restarts: closing it from inside risks freezing the console. A
  second console can't open its inspector while 9229 is held.

- **Consoles:** one `server.js` per account, each on its own port. **The ports move**: on
  2026-09-22 a2 Lord02 was on :8817 and a1 on :8713, not the :8711/:8713 of earlier
  notes. Always read them from `node botctl.js list`. A Claude session can't send a
  one-off command to a running console: every route but `/api/session` and
  `/api/debug/city` (read-only, `x-otto-internal` token) needs a signed-in user. So ask the
  user to type it in the console, or restart with autorun, which is the user's call.
  **Give the user a plain script line** for the city's script box (e.g. `comfort bless`,
  then Run), never `command "\comfort bless"`: `command` runs only the in-line commands
  (alliance, mail, who, …), and answered "there is no in-line command comfort"
  (2026-09-22). The debug route reads only the account's FIRST city (a2: New(713,121),
  id 100311448), so a before/after test must happen in that city. The Director is `director.js` on :8712 and does
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
- **Before an account attacks anything, check EVERY goal row it has — not just prepend.**
  (Lord02, 2026-09-20.) An account's effective goals are prepend plus either its own
  city row or `default`, so a line commented out of prepend alone still runs from the
  five city rows underneath it. Lord02 carried `defensepolicy /usetruce:79` in prepend,
  in `default` **and** in each of its five city rows. `default` matters twice over: a city
  the account CAPTURES has no goal row of its own, so it falls straight through to
  `default` — a truce line left there would truce the new city as the next target's waves
  start landing. (This is exactly what took Lord15 out of the fight: `ok=-83 "Your city
  is now in Truce status"` on every attack of its own.)
- **NPC farming goals starve a capturing account of heroes** (Lord02, 2026-09-20).
  `config npc:<n>` with `npcheroes !OTTO,any` keeps every hero of every city out on a farm
  run — a2's hero dump showed most at `status=3` (marching) — and a `capture` wave needs an
  **idle** hero, so the waves would have reported "no SpamHero is free" forever. Set
  `config npc:0` (0 is off) on every goal row of an account that is about to capture, and
  put it back afterwards. Its `requestresources` lines go the same way for the duration:
  the transports they send are what refuses a teleport with `ok=-77`.
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
- **Every restart onto a new port left a dead uptime probe behind** (2026-09-20, seen on the
  Director's Uptime tab: Lord04, Lord05, Lord08, Lord09 and Lord14 each showed 3–4
  cards, most at 0% up). Cause: `registerProbe` (botctl.js) only dropped the probe entry for
  the port being reused, never the account's previous one, and the ~3-hourly out-of-memory
  crash of a trading console never goes through `stop`, so nothing dropped it either. The
  sampler kept writing a "process down" row for every dead port each minute.
  - Fixed in code the same day, **not live until the Director restarts** (the page itself is
    served fresh): probe entries now carry `accountId` and `registerProbe` drops an
    account's older entry; the sampler drops a dead probe whose account answered on another
    port in the same round; `/api/uptime` folds everything into one series per account and
    keeps one sample per account per round (the live one wins), so old rows are right too.
  - Reading the tab before the restart: the duplicate cards with 0% are dead ports, not
    downtime; an account's real figure is the one with a live port.
  - **Still doubled on 2026-09-22** (8 accounts, e.g. "Lord05" beside "Lord05 (a5)"): a
    ghost that had not answered once in the window wrote rows with no account, and the fold
    only knew a probe's account from an answer. `/api/uptime` now also resolves it by the
    "(aN)" suffix, the probe entry's accountId and the account's label; and a port another
    account answered on for a minute (a1 under "Lord13 (a13)") no longer hands that account
    the port's history or name. Live from the Director restart at 09:21 that day.

- **Every city's resources are recorded once an hour** (since 2026-09-19): the Director's
  Resources tab (city-resources.js, table `city_resources`), from the per-city figures each
  console's snapshot carries (snapshot.js `cityList`). The figures are the console's cached
  ones — right after a login they are the server's, so for a record that must be exact
  (before a maintenance), relog first, then "Record now". The pre-maintenance record of
  2026-09-19 07:53 is also in `resource-records/`.

- **A second record is taken every morning at 08:30** (since 2026-09-20, the user's
  ask): just before the daily maintenance window (§2), so it holds what every town was
  carrying INTO it. It is kept apart from the hourly rows by the `kind` column
  (`morning:<YYYY-MM-DD>`) and shown in its own table on the Resources tab. If the
  Director was down at 08:30 it catches the day's record up at its next start, still
  under that day, marked late on the page (✳) — and past 14:30 it gives up on the
  morning rather than pass an afternoon reading off as one.
- **The Resources tab names the towns the glitch does not put back** (2026-09-20,
  city-resources.js `restoreReport`). Two separate claims, and the page keeps them apart:
  *never put back* — the town was drained and did not come back at every maintenance we
  have records either side of; and *empty beside the rest* — its put-back amount is under
  a twentieth of its account's middle town on two of wood/stone/iron and has not moved,
  which is what a town sold dry before the record began looks like now. Judged only for
  an account the record has actually seen put back, so an ordinary account that simply
  spends is never blamed. **Limits, and they matter:** records only go back to
  2026-09-19, so most towns have one or two maintenances to judge; the first record after
  a maintenance can be half an hour late, by which time the play may already have sold
  the restored stock again (which reads as "not put back"); and nothing in the record
  says who was on holiday. Treat one maintenance as a suspicion, not a finding.
  On 2026-09-20 it flagged **Lord06 700,120 and 709,112, and Lord07 704,109** as
  empty beside the rest, and nothing as never-put-back.
  **Since 2026-09-22 the put-back is known to be random per town (§4), so a flag here
  means "failed at least once", never "will always fail".** Its "never put back" wording
  over-claims; the page and restoreReport should be reworded to count failures per
  maintenance instead (not done yet).

### Trading consoles ran out of memory every few hours (fixed in code 2026-09-22)

Seen 2026-09-22 in the consoles' own uptime rows (`rssMb`/`heapMb`) and `.err.log`s: every
console running the glitch loop grew ~700 MB/h of heap until "JavaScript heap out of
memory" at ~4 GB, 2–7 crashes each, burning ~65% of a core apiece in garbage collection on
the way. Cause: each `call` re-parsed the control file and kept every parsed copy for the
life of the run (`Run.scopes`, script.js); an offline A/B measured ~155 KB kept per call.
Fixed: parsed calls are reused while the text is unchanged, `call` re-reads its file at
most once a second, trade arrays are built once per push, and botctl starts consoles with
a 512 MB heap cap (`BOT_HEAP_MB`) and rotates a console log over 50 MB to `.log.1` at start
(`BOT_LOG_ROTATE_MB`). **Only a console started after the fix has it** — a running one
keeps leaking until restarted, and the heap cap needs the Director restarted (it loads
botctl). Idle consoles were always fine at ~120–140 MB.
If a console's heap climbs steadily again, look first for something kept per loop pass.

### Never `require()` a program that starts a console

`node -e "require('./server.js')"` **starts a whole console**: it binds the port, starts
the session supervisor and begins logging in as whatever `ACCOUNT_ID`/.env says. On
2026-09-20 it was used as a "does this file load?" check and started a second a1 console;
it died a second later on `EADDRINUSE` because the real console held :8711, so no second
login went out — but only by luck. Had the port been free it would have logged in and
kicked the live console.

**On 2026-09-22 it happened again, and that time the login DID go out.** The same
`node -e "require('./server.js')"` was run as a syntax check at 20:44:55; it printed
`account: a22 Lord22  port: 8711  engine: live`, started the supervisor and logged in.
The real :8711 console was kicked 7 seconds later — `console-a22.log` shows
`server.ConnectionLost` at 20:45:02, `socket closed by the server`. It reconnected by
itself at 20:45:15 (13 s out) and no 30-minute kick hold followed, so nothing was lost;
a busy trading or timed-march run would not have been so cheap. Two things to note:
**`EADDRINUSE` does not save you** — the supervisor logs in *before* the port is bound,
so the second login goes out even when the port is taken; and the process keeps running,
so it must be killed, not left to die.

**A running console is not proof the port is safe.** Check the file, never load it.

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
