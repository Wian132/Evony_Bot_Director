# Evony rules

What OTTObot has learned about the live game (Evony Age 1, server **ss71**) — the hard way,
mostly. Read this before doing anything that acts on the game: starting or stopping a
script, placing or cancelling trades, logging an account in, restarting or starting a
console, switching an account on or off, sending marches, using or buying items. The
code is documented in MANUAL.md and SCRIPTS.md; this file is about the **game** and about
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
- **`city.troopStillInProduction` in a string prints `function Function() {}`** (2026-09-23).
  It is the dual property/call shim in `script-objects.js` (a property on one wiki page, a
  call on another), so `"… " + city.troopStillInProduction` renders the callable, not the
  troops — which means the "troops still queued" figure in `holiday-prep.txt`'s and
  `holiday-prep-go.txt`'s `HOLIDAYPREP done` line has never said anything. Read a type off
  it instead (`city.troopStillInProduction.archer`). Walls (`city.fortificationProduceQueue`,
  prints `tra:0`) and `city.tradesArray.length` are fine.
- **`/autoextend` works, and a holiday costs 20 coins for 2 days** (Lord05 a5, observed
  live 2026-09-23). Its holiday ran down to `2m42s` at 08:36:17 and at **08:39:02** jumped
  straight back to **1d 23h** — the game renews it **at expiry, for the same term it was
  taken for**, with no login, no command and nothing from us. Its coins went **1,834 →
  1,814 across the renewal: 20 coins for 2 days, i.e. 10 a day.** This replaces the
  "*unverified:* what the game charges in coins" that stood here from 2026-09-20. *One
  observation* — confirm it on the next account that renews before treating the rate as
  exact, and note it was a RENEWAL; whether the first holiday costs the same is still
  unverified.
  What this means in practice: an account's coins divided by 10 is roughly the days of
  holiday it can still pay for. Points went on holiday that morning with **81** coins —
  about 8 more days, not the near-immediate lapse a low balance first suggested.
- **Whether a holiday will renew itself is readable — `player.autoFurlough`** (2026-09-23).
  `/autoextend` sets the game's own `isAutoFurlough` on `furlough.isFurlought`, and it comes
  back on the login's PlayerBean as `autoFurlough`, with `furloughDay` for the term. Until
  this was found nothing in OTTObot could tell a holiday that renews from one about to
  lapse — the Director showed both the same. The protection watch (session.js
  `checkProtection`) now reports `auto` and `days`, and the Director's badge marks a
  holiday that will NOT renew. Both fields are login-seeded rather than pushed, but the
  flag only changes when a holiday is sent, so a login is soon enough.
- **The game PUSHES protection changes; it never answers a question about them**
  (2026-09-23). An account's protection — holiday, dream truce, truce, peace — is not on
  the castle's `status` field (a lord on holiday still reports status 0 on every city). It
  is in the player's buff list, which reaches a console two ways only: the **login** seeds
  it, and **`server.PlayerBuffUpdate`** adds, updates or removes one as it happens
  (game.js `applyPlayerBuffUpdate`). There is **no command that returns our own buffs** —
  `common.getPlayerInfoByName`, which the heartbeat sends every 60 s, is the PUBLIC summary
  (name, alliance, prestige, honor, ranking, cities, population, title) and carries none.
  So: a protection that starts while we are logged in arrives within seconds on a push and
  needs nothing asked; a push **missed** while the socket stayed up is only corrected by the
  next login. Buffs carry an `endTime`, so one running out is seen locally with no traffic
  at all (`buffs.list()` drops it).
- **`game.holiday` is a LOGIN artifact, not the holiday state.** It is written in one place
  — game.js, from the login reply's `ok=-100` — and nothing else ever touches it. An account
  that goes on holiday while already logged in keeps `holiday = null` until its console next
  reconnects, which is why the Director's Status column looked broken on 2026-09-23: five
  accounts went on holiday 08:02–08:04 and at 08:12 only the two that happened to re-login
  (Lord13 08:08:01, Lord12 08:12:47) had the badge. The Director cannot fix this by
  polling — it skips any account a console holds ("a second login would kick it"), so it
  never gets a fresh login-derived holiday for one. Read protection from the buffs
  (`buffs.protectionOf`), which is what `holidayRun` already did and what the **protection
  watch** (session.js `checkProtection`, every 2 min, `PROTECTION_MS`) now publishes as
  `live.protection` for the Status column.
- **Prep and holiday in ONE console restart** (2026-09-23, `scripts/holiday-prep-go.txt`).
  `holiday-prep.txt` then `holiday-go.txt` is two restarts, and the second is refused by the
  **10-minute autorun gate** (a console skips its autorun if that account's script started in
  the last 10 minutes) — about 15 minutes before the holiday is even asked for, which does
  not fit in the hour before maintenance. The combined file does the one-off prep
  (`recallall`, `canceltrade`, `cancelbuilding`) once, then holiday-go's rounds
  (`cancelwalls`/`canceltroops` in every city, staggered `sleep rnd:36`, the `holiday` sent
  from the first city only, 20 tries 40 s apart). Live on Lord13, Lord12, Lord11,
  Lord10 and Lord04 at 08:01: **three of the five answered "put the account on holiday for 2
  days, renewing itself until the coins run out" within 60 seconds of the restart**
  (Lord10 08:02:40, Lord11 08:02:43, Lord12 08:02:46) — first try, no second pass.
- **The `ok=-25` refusal reaches a script as plain text in `$error`**, not as a code:
  `Recruiting soldiers. in 4` (Lord04 and Lord13, 2026-09-23) — the city is named at the end,
  and `Manufacturing fortified units. in <city>` is the walls version. So `if $error == null
  end` is the only check a holiday loop needs; the text itself says which city to wait for.
- **Coins are what `/autoextend` spends.** Before a holiday, read the account's coins: the
  game renews the holiday until they run out, so a low balance is a short holiday whatever
  the 2 days say (Lord13 went on holiday 2026-09-23 with **81** coins against Lord04's 1,590,
  Lord10's 2,306, Lord11's 2,880 and Lord12's 1,064). *Unverified:* the coins a
  holiday and each renewal actually cost.
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
  The one exception is the user's own (2026-09-28): an account's **Claude permission 6,
  "Holiday account"** (`claude-perms.js`, off by default) lets a Claude woken for an attack
  put THAT account on holiday (`holiday <days> confirm`). Ticking it is the user's decision
  made in advance. Nothing lets a Claude end a holiday (`holiday /exit`) or set one to renew
  itself (`/autoextend` spends coins).
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
  **The half-hour test is not sharp at the boundary — take several samples, not one**
  (2026-09-27, a30 Lord30). Four kicks in one afternoon, measured from *our* login
  (which is the moment the other client is kicked and starts its own pause) to the next
  kick of us: 11:23:16 -> 11:54:01 = **30m45s**, 11:59:31 -> 12:30:22 = **30m51s**,
  13:00:32 -> 13:29:05 = **28m33s**. Three of four sit just over 30 minutes; the fourth sits
  a minute and a half *under* it and by the letter of the test above would have been read as
  our own fleet. It was not: a port sweep of every listening console found 30 accounts served
  and none duplicated. So a single gap near 30 minutes proves nothing either way — collect
  three or four, and confirm with a duplicate-console check before blaming our own fleet.
  A contested account is also simply unusable for anything that must not be interrupted: a30
  never held a login longer than half an hour all afternoon, so its eight cities were left
  out of the 2026-09-27 hub move rather than teleported inside a window that might close
  mid-operation.
  **The kicker was on an HOURLY CLOCK, not a pause-after-kick rhythm** (a30, 2026-09-27, and
  this is what the 30-minute test misreads). Eleven kicks: 11:22:52, 11:54:01, 12:30:22,
  13:29:05, 14:28:20, 15:27:39, 16:27:29, 17:26:20, 18:26:37, 19:28:11, 20:26:53. From 13:29
  on, every one lands at **:26-:29 past the hour, about 59-60 minutes apart**, whatever we do
  in between. That is a scheduled job, and it explains the gaps that looked like NEAT's
  31-minute pause: our own 30-minute kick hold puts our login back at :56-:58, so we survive
  the ~28 minutes to the next hourly tick and the *apparent* gap is an artefact of OUR hold
  length, not of the other client's behaviour. **So measure kick-to-kick, not login-to-kick.**
  Kick-to-kick lands on a round number when a scheduler is behind it; login-to-kick just
  measures our own hold. Neither a29 (12:56, 13:55, 14:54 — 59 min apart) nor a31 (13:12,
  14:11 — 59 min) was pausing either; all three were on the same hourly clock.
- **"kick hold ended early — Connect" does NOT mean anybody pressed Connect** (2026-09-27 —
  this cost a wrong accusation, so read it carefully). `Session.clearKickHold()` emits that
  one line whoever calls it (session.js ~488, `if (had) this.note(...)`), and **`reconnect()`
  calls it** (session.js 1581) — so does `/api/connect` (server.js 616) and a maintenance
  close. Therefore **every `/api/reconnect` silently ends a kick hold and retakes the
  account.** A verification relog is not a read-only act on a contested account.
  I reported an unexplained "automatic Connect" on a31 at 14:33:06 during the hub move and
  was wrong: it was my own verification relog of a31, seconds earlier, wearing that label.
  Nothing in the codebase POSTs `/api/connect` — the only two call sites are onclick handlers
  in `public/app.html` — so when the line appears with no relog of ours behind it, it really
  was a person clicking the red bar's *Take it back now* (a30, 20:27:12).
  Two consequences: don't blame our own fleet for a retake until you have ruled out your own
  relogs; and **on a contested account, treat a verification relog as a deliberate retake** —
  it is fine when the kicker is a scheduler (it does not escalate), and it is exactly what
  must not happen when the kicker is a client that fights back.
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

- **The holiday goal-file restore works, verified live 2026-09-25.** Four accounts
  (Lord08 a8, Lord09 a9, Lord15 a15, Lord16 a16) were prepped with their goals emptied
  AND `goalFile:prepend:<id>` set to `null` — the unlink is what makes an emptied goal
  stay empty, since the Director re-syncs the file over it within 15 s. The moment each
  holiday confirmed, `session.js holidayGoalFile()` re-pointed that account at the fleet
  prepend file and re-synced it on its own: a8, a9 and a16 were back to a full 4,096-char
  prepend without anyone restoring anything, while a15 (still refused) stayed `null`.
  So for a holiday, **unlink + empty is now self-healing** — do not hand-restore the goals
  afterwards, just check the setting came back.
- **Four accounts on holiday in 105 seconds** (2026-09-25 08:27:56 restart → 08:29:40).
  `scripts/holiday-prep-go.txt` on autorun via
  `node glitch-run.js start --buy a8,a9,a15,a16 --buy-script holiday-prep-go.txt`.
  Lord08 and Lord09 went in on **try 1** (08:28:55), Lord16 on **try 2** (08:29:40). The
  two that refused got the already-documented `ok=-25 Manufacturing fortified units`
  (above) and were simply waited out by the loop's 40 s rounds. Second live confirmation
  that one restart is enough when the window is under 30 minutes.
- **Emptying "every goals row" for an account also hits its saved SCRIPT loadouts.** The
  `goals` table holds rows of `kind='script'` (a console's script-box loadout, keyed
  `<cityId>:load1`). A blanket `UPDATE`/`goals.set` over `WHERE accountId = ?` wipes those
  too. They cannot block a holiday, so **filter on `kind='goal'`** — 2026-09-25 a8's
  `script/4088776:load1` was emptied and restored from the backup JSON straight after.
- **A new holiday can read `furlough: false` in the Director for a quarter of an hour, and
  the account IS on holiday** (2026-09-25, found while holidaying four accounts). The
  snapshot's `furlough` and `holidayRun()` used DIFFERENT definitions: holidayRun counted
  `game.holiday` (the login artifact) OR the protection buff, while the snapshot counted
  the protection buff OR `player.furlough` and **not** `game.holiday`. The protection buff
  is PUSHED, so a console that has had no push yet reads no protection — all four of that
  morning's holidays showed `furlough: false` on fresh 4-minute-old snapshots while their
  own consoles had already confirmed the holiday and re-linked their goal files.
  `session.js` now uses the same three sources in both places.
  - **The trustworthy check is `settings holidayRun:<id>`** — that record is only ever
    written once holidayRun() has decided the account is on holiday, so a `since` stamp is
    proof. The Director's pill is not, until its console has restarted onto the fix.
  - Do not conclude from a `false` that a holiday failed; read the console's `HOLIDAYGO
    result` line and the holidayRun record before re-sending one.

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

- **AN ACCOUNT ON HOLIDAY IS SENT NO MAINTENANCE ANNOUNCEMENT** (2026-09-23, from the
  console logs of that morning's maintenance). Every console that was playing normally
  logged four copies of "Evony Server ss71 will be taken offline for daily security
  maintenance" (08:45, 08:48, 08:51, 08:54 — the lead in the text counts down, so the
  stand-down lands in the right place) and stood down at 08:54:03. The four holidayed
  accounts — a4 Lord04, a5 Lord05, a6 Lord07, a14 Lord14 — logged **none of
  them**. So they were still connected when the server closed every socket at
  09:00:00.6, and then spent the whole window on the ordinary reconnect ladder: attempts
  at 09:00, 09:01, 09:03, 09:08, a proxy change at 09:11 and the same again, every one of
  them answering `connect failed: socks5 ... host unreachable`. That is the login churn
  that holds an account back half an hour, and it is how the proxies get killed (above).
  They were still out at 09:18 while the rest of the fleet was back. *Why the server does
  not send it is unverified* — holiday mode presumably drops the account out of the
  system-chat broadcast. Do not assume a quiet console means no maintenance.
- **One bot hearing it now stands the whole fleet down** (2026-09-23, the user asked for
  it: "the bots tell the director it's maintenance now"). The first console to hear the
  announcement, or to find the game port closed, writes `maintWindow:<server>` in the
  ORG's settings (`maint.js`) and every other console adopts it as its own stand-down —
  holidayed accounts included. The Director reads the same record and makes **no poll
  login** while a window is open, and declares one itself when the fleet's own behaviour
  says so: two consoles reporting the server down, or three losing the game socket in the
  same uptime sweep (they do not share a proxy; one console alone proves nothing, because
  a dying proxy looks exactly the same). One account still logged in vetoes it — the
  server is up. **Every way back in now writes `maintOver:<server>`**, not just the
  dormant race's monitor, which is what left it stale on 2026-09-20. *In code 2026-09-23;
  it reaches a console only when that console restarts, and the Director when it does.*

- **OUR OWN MARKET SPAM CAN FAKE A MAINTENANCE — the fleet stood itself down at 11:07 on a
  day maintenance had ended at 09:19** (2026-09-25, the user: "suddenly all my bots think
  its maintennance? at 11:08 AM"). The whole fleet was pushing the glitch play at full
  throttle. The server stopped answering, and between **11:05:13 and 11:06:15 every one of
  the 21 consoles lost its game socket** — most of them with
  `heartbeat failed (no reply in 30s, 20 market writes in flight) — cycling the socket`,
  the last frames sent being four `trade.newTrade`. The scripts were already logging
  `no reply to trade.newTrade (server is ignoring this account — rate limited)`. So the
  drops were self-inflicted: too many market writes in flight, no reply, heartbeat times
  out, the console closes its own socket. All 21 did it inside one minute, which is
  exactly the shape the Director reads as the server going down.
  The sweep at ~11:07:03 saw three consoles dropped and **none connected**, so
  `maint.verdict` said `'down'`, `maintWindow:ss71` was written with
  `"3 consoles lost the game socket at once"`, and all 21 accounts were told to stand down
  until 11:21:03.
  **The "one account still logged in vetoes it" guard cannot help here**, because a
  fleet-wide stall takes every account at once, so no console is connected in that sweep.
  Worse: a2 Lord02 **did reconnect at 11:07:50** — proof the server was up — and was
  told to stand down 3 seconds later, before the next sweep could see it connected and
  call `'back'`.
  **The tell:** the game port was open the whole time. `216.66.17.119:443` (ss71) answered
  a TCP handshake in ~240 ms from this machine while the fleet sat in the fake window.
  `maintenanceFromFleet` (director.js) declares from the drop counts alone and **never
  probes the port** — the one check that separates "the server is down" from "we wrote
  ourselves off the server". The Director already has `getServerConfig('ss71')` and
  `testProxy` a few hundred lines away (the `/api/proxies/test` handler).
  Also: **there is no way to cancel a false window** — no Director endpoint, no UI button.
  The only route is writing `maintOver:<server>` into the ORG's settings by hand.
  A fake window is not free: 21 accounts stop playing for the 15 minutes to `resumeAt`,
  and every running script stops with them.
  *Both gaps are unfixed as of 2026-09-25.*
  **The release worked exactly as designed**, and fast: `maintOver:ss71` = `Date.now()` at
  11:17:18, and 19 of the 21 consoles were logged in by **11:17:52** — 12 to 34 seconds,
  no restart, every running script kept. Each one took the designed path,
  `port is open — login attempt 1 after maintenance in 2s` → `logged in as … — 10 city(ies)`
  → `maintenance plan cleared` → `back online after maintenance`. Within a minute the fleet
  was placing hundreds of orders again (`10 of 10 placed`) against a handful of refusals.
  Two accounts were never in the window at all: a18, whose `maintPlan` was `null`, stayed
  connected right through — and it is the one still being refused almost everything
  afterwards (3 placed against 120+ refused), because it never stopped hammering while the
  others were stood down. **A console that sits out the stall recovers; one that keeps
  pushing stays throttled.**

- **NO NETWORK LOOKS EXACTLY LIKE MAINTENANCE — and a changed public IP kills every proxy
  at once** (2026-09-25 evening, the second false window of the same day, different cause).
  The PC is set to start the Director at boot; it booted **with no wifi**. Every console's
  game-port probe failed, so each concluded the server was down, and at **20:12:24** the
  Director wrote a window: `"22 consoles report the server down"`, stand down until
  20:26:24. The game server was up the whole time.
  **A console cannot tell "the server is down" from "I have no network."** `portOpen()`
  fails the same way for both, and `armRaceFromServer` (session.js) declares a fleet-wide
  window off `detected: server down`. A boot with no network therefore stands the entire
  fleet down by design.
  **Then the network came back and the fleet still could not play**, because the public IP
  had changed. Every proxy line in `proxies.txt` is a bare `host:port` with **no
  user:pass** — so Webshare authenticates us by **IP allowlist**, and the new IP was not on
  it. All 100 proxies answered
  `socks5: no acceptable auth method · http: CONNECT returned 407` (the app's own
  `testProxy` says it in plain words: *"it wants a login: give the line as
  host:port:user:pass, or allow this PC's IP at the provider"*). 12 of 12 sampled failed.
  **a23 Lord23 is the only account with `proxy=""` — it connects direct.** That is why
  it was the one and only console that got back in (20:15:02), and its login wrote
  `maintOver:ss71`, which released the whole fleet without anyone touching the database.
  A direct-connect account in the fleet is worth keeping for exactly this reason.
  **The check that separates the two cases:** the game port direct from this PC
  (`216.66.17.119:443` answered in ~300 ms) against the same port through a proxy. Port
  open direct + every proxy refusing = our side, not Evony's.
  **After any router reboot, ISP reconnect or move, the public IP must go back on the
  Webshare allowlist** (`curl http://api.ipify.org` gives it — it was <home-ip> that
  evening), or the proxy lines must carry `host:port:user:pass`. Until then the fleet
  cannot log in at all, however healthy the game is.
  **CONFIRMED and fixed the same evening.** The cause was travel: a new wifi network, so a
  new public IP. The user put the new IP on the Webshare allowlist and the proxies came
  back at once — **22 of the 23 accounts' proxies passed** `testProxy` on the retest
  (600–1500 ms tunnels) against 0 of 12 before it. No console restart was needed: the
  fleet reconnected itself between **20:19:50 and 20:22:18**, on the ordinary 30 s port
  probe and reconnect ladder. The one remaining failure, a10 Lord10's
  `<proxy-ip>:8073`, is `socks5: timeout · http: timeout` — a dead proxy, a different
  fault from the allowlist, and a10 got back in anyway.
  **So the signature is worth trusting:** `no acceptable auth method` / `CONNECT returned
  407` on EVERY proxy = the allowlist, fix it at the provider; a `timeout` on ONE proxy =
  that proxy is dead, let the rotation handle it.
  *Unfixed in code as of 2026-09-25: nothing distinguishes a dead local network from a dead
  server before declaring a window — travelling with this PC will do it again.*
- **IT HAPPENED AGAIN OVERNIGHT, WITHOUT TRAVEL** (2026-09-26, the user: "the director now
  says maintenance for everything"). The public IP changed again, from <home-ip> to
  **<home-ip>**, sometime in the early hours, with the PC left where it was. The
  likeliest cause is the ISP or router handing out a new IP (*unverified*). From 03:01
  (11 consoles lost the socket at once) the Director declared a fake window, then
  re-declared one **every hour at about :47** ("21 consoles report the server down") until
  morning. a2's first reconnect after a kick hold, at 03:24:25, already answered
  `socks5 …: no acceptable auth method`. At 08:30 the game port answered direct in 270 ms,
  3 of 3 sampled proxies gave the allowlist signature, and a23 Lord23 (direct) was the
  only account logged in. The glitch log's 03:01 "before" record was taken off this fake
  window, not a real maintenance. **So the IP can change on its own at any time: check
  `api.ipify.org` against the Webshare allowlist first whenever the fleet is stuck in
  "maintenance" outside 08:30–09:30.** For a lasting fix, put user:pass on every proxy line
  (`host:port:user:pass`) so a new IP no longer matters.
  **Fixed at ~08:38 by the user updating the allowlist.** This time Webshare took about
  **4 minutes** to accept the new IP: proxies were still refused at 08:41:43 and passed
  from 08:42:16, and even then one of the three sampled still refused. **No restart was
  needed.** The consoles came back by themselves on their 30 s port probe between
  08:42:23 and 08:43, with every script kept. So after an allowlist change, wait 5 minutes
  and retest before touching anything.

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
- **One account tops out near 3,500 market orders a minute, however many cities it has**
  (2026-09-27, a32 Lord32 on ss91, 33 cities, holiday; `sell wood 1 0.001 x{free}` on
  loop, every order filled at once by a deep 0.1 bid). **One city alone did ~1,800 a
  minute** (10 orders every ~0.33 s); **all 33 together did 3,500–3,640 a minute**, the
  same from minute to minute, with 0 refusals. So the account, not the city count, is the
  ceiling — 20 writes in flight (`Game.PIPE_LIMIT`) at ~240 ms a round trip is about that
  (*unverified* whether the pipe or the server is the tighter limit). A relog at 20:25
  cost every city its batch in flight ("connection closed before it was sent") and two
  cities got "rate limited" 30 s later; all 33 were back to full rate the next minute.
  **The rate did not hold: it fell steadily, 3,600 → 2,000 (20:40) → 1,250 a minute
  (21:09)**, still 33 cities, 0 refusals, connected throughout, the console idle (28 s
  CPU in 55 min). Each order's reply went from ~0.33 s to ~1 s (one city's 10-order batch
  from 0.33 s to 16 s). *Unverified* cause: the ~97k trade reports the account had piled
  up by then — the fall tracks the running total, not the clock. Clearing the reports and
  watching the rate is the test.
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
  **Happened again 2026-09-24 07:20 and 07:27 (Lord02 a2):** `node botctl.js stop a2` +
  `start a2` (to load a UI/endpoint change) killed the stone buy/cancel loop and **neither
  restart brought it back** — no `[autorun` line after the new login. The last `[autorun`
  lines in the log were the OLD process's, seconds before the stop; they look like a resumed
  loop if you only read the tail. Compare the timestamp with the login line. A plain
  `botctl` restart does not carry the play's script (it is set by `glitch-run.js start`), so
  **a UI-only change to a console that is mid-play should wait or go to the other consoles
  first — or be restarted through `glitch-run.js` so the script comes back.**
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
- **The Trading tab starts the BUYING side first, whatever side is ours** (2026-09-23,
  trading-setup.js: `run.phase` goes 'buy' -> 'delay' -> 'sell'). In a RESOURCE play that
  is right — our buyers' bids go on the book first. In a **GOLD** play the buyers are the
  holiday banks, so their 150 bids rest on the book alone for the whole delay and rival
  SELLERS fill them: that is bank gold going to other players, and it is the opposite of
  the rule above ("start our normal accounts' side first"). Measured on the 09:30 gold
  pass: the nine banks bid from **09:30:56–09:31:38**, our twelve sellers only placed from
  **09:33:04–09:34:31** — between 2 and 3.5 minutes of exposure. Until the tab orders the
  two sides by which one is OURS, either set the delay to 0 for a gold play or start the
  selling side by hand with `glitch-run.js start` before pressing Start process.
- **An account's live holiday state is readable straight from its console** (2026-09-23),
  with no Director and no login: `GET http://127.0.0.1:<port>/api/session` with the header
  **`x-otto-internal: <auth.internalToken()>`** (auth.js `INTERNAL_OK` lists /api/session).
  `protection.kind === 'holiday'`, with `protection.left`, is the truth the Director itself
  uses; `holiday` on the same object is only the login artifact (§1). This is the check to
  run over every account before a play starts. On the 09:30 gold pass it found all nine
  buy-side accounts genuinely on holiday, and Lord03 and Lord16 — taken out that
  morning — correctly on the selling side and off the `holi` list.
- **`capGold` is per CITY, not per account** (control file: `city.resource.gold > capGold`).
  The user's "stack up to 20t throughout" on 2026-09-23 means 20t a town: twelve selling
  accounts × 10 towns × 20t = 2,400t of room against the nine banks' ~2,559t of gold, so
  the whole bank balance has somewhere to land. Read per-account it would be nonsense —
  five of the sellers already held 59–129t and would have sat the play out at once.
  **He raised it to 25t a town the same morning** (09:48), and said why: *"so we don't
  decrease the amount of cities working together too much"* — a town over the cap SITS OUT,
  so a cap set close to what the towns already hold quietly shrinks the number of cities
  trading, and the number of cities trading is what makes a pass fast. So when a gold pass
  feels slow, check the SITOUT lines and the cap before blaming the fleet: **the cap is a
  throttle on parallelism, not only on where the gold lands.** Set it above what the
  fullest towns hold, not at it.
  A cap edited by hand in the control file is live within a second, but the **Trading tab's
  saved setup still holds the old figure** — pressing Apply or Start there writes it back
  over the edit. Change it in both.
- **`capRes` does NOTHING in a gold play** (2026-09-23, read off the control file after I
  had claimed the opposite). Both the sitout line and the `maxOrders` room line are gated on
  `kind == "res"`, and `kind` is `"gold"` whenever the price is 50 or more. So in a gold
  pass the buying banks are held only by the **hard** `foodCap` (950b, with its 2b margin) —
  at ~600b of food a town that is ~350b of room, about 3,500 orders, ~52t of gold a town,
  which comfortably covers the richest bank’s ~48t a town. The soft `capRes` figures are for
  OUR buyers in a **resource** play; do not raise them “so the banks have room”, they were
  never in the banks’ way. `capGold` is the mirror: gated on `kind == "gold"` and the sell
  side, so it does nothing in a resource play.
- **Counting which towns a play actually reached:** the `autorun: <file> started in <city>`
  note goes to the session notes, **not** to `console-<id>.log`. In the log, count the
  distinct `[autorun <city>]` prefixes after the last `Evony console ->` banner — that is
  the only per-town evidence there. (2026-09-23, after a first reading of "0 towns
  everywhere" that was purely the wrong grep.)
- **Taking a bank out of holiday mid-play leaves its BIDS on the book, and nothing in the
  control file takes them down** (2026-09-23, Lord07). Dropping it from the `holi` list
  stops it placing anything new within a second — the safety line sets `hold = 1` and
  `goto holdit`, which is **before** the cancel loop, so the loop never runs. And even if it
  did, on the buy side its own bids at the play's price are the ones the file wants to keep.
  So the account sits there with up to **10 bids a town × 10 towns × 15.07b = ~1.5t of gold**
  live on the market, fillable by any rival seller, and every one of those fills is now real.
  What actually clears them is **switching that account to the other side**: the sell script
  sets `want = 1`, which makes every resting BUY stale, and the cancel loop takes them all
  down. A restart onto a cancel script does it too. Both wait on the console's 10-minute
  autorun gate, so there is a window either way.
  **Therefore: an account comes out of holiday only after its runs are stopped AND its book
  is cleared** — otherwise plan for that gap. On 09-23 Lord07 spent **2.768t → 0.070t
  of gold in about five minutes** across the changeover; most of it went to our own sellers
  (they were the ones selling food at 150 at that moment), so it was mostly a transfer
  between our accounts rather than a loss, but that was luck, not design.
- **`protection: none now (holiday has ended)` in a console's `[conn]` log is the live
  confirmation** that an account has left holiday, and `/api/session` then reads
  `protection: null`. **A disconnected console keeps serving the STALE buff** — Lord07
  still read `holiday 22h37m` at 10:01 while `connected` was false, minutes after the user
  had taken it off. Never read protection off a console that is not connected; `connected`
  is part of the answer, which is why `tradingAccounts` in director.js only trusts the buff
  when `connected` is true.
- **Taking an account off holiday in the game client kicks our console** (one login per
  account, §1). Lord07 dropped at ~10:01 and was back at 10:01:51 by itself. Expect the
  disconnect; don't restart it into the kick hold.
- **A restart costs that side the next TEN MINUTES — think before reaching for one**
  (2026-09-23, learned the expensive way). The gold pass stalled at ~09:57 with both sides
  on full books; our twelve sellers were restarted at **10:15:10** to clear them. A minute
  later the user asked to turn the play around (banks sell food cheap, ours buy) — and that
  could not happen until **10:26:08**, because the restart had set each console's autorun
  gate. The login is not the cost; the gate is. **Before restarting a side, ask whether a
  change of direction, resource or side might be wanted soon.** If it might, change the
  control file instead and leave the gate unburnt — everything in that file is live within a
  second, and only a change of SCRIPT (which side an account is on) needs a restart at all.
- **A price step frees a stalled book on one side and may not on the other** (2026-09-23,
  cause *unverified*). Both sides had stopped placing with ten resting offers a town.
  Stepping 150 -> 140 at 10:13 made the BANKS cancel and re-list inside a minute (72 orders
  at 140 across seven of them). **Our sellers placed nothing at 140**: every town stayed in
  `glitch-res-sell.txt`'s `full` branch (`line 41: sleep 0.3`) with no `SITOUT` echo, which
  means line 22 (`free < 1`) — their ten slots were still held by the old 150 offers, so the
  control file's cancel loop had not freed them. Why is not known yet.
  **And the log cannot answer it:** the control file is reached by `@call`, and the `@`
  silences the called file's own logging, so its `execute "canceltrade …"` lines never
  appear. You cannot tell from a console log whether the cancel loop ran. If this matters
  again, add a temporary echo on the CALLING script, not in the control file.
- **The garrison food floor must exempt holiday accounts** (2026-09-23). A floor that keeps
  a day of `troopCostFood` under any food sale is right for our own towns, but a holiday
  account is *meant* to sell every last b — the next maintenance puts it all back. Written
  as `if res == "food" && side == "sell" && holi == 0 && keepRes < dayfood keepRes = dayfood`,
  and it has to sit **after** `holi` is worked out, not with the `keepRes` lines at the top.
- **Turning a gold play into a resource play changes which side each account must run**, so
  it is the one change that cannot be done from the control file alone. Dropping the price
  under 50 is safe on its own — the SAFETY lines immediately HOLD every non-holiday account
  that is still on the selling script, so nothing is dumped cheap in the gap — but nothing
  trades until both sides are restarted onto the opposite scripts. **Our buying side goes
  first**; start the banks selling first and the cheap food goes to rival buyers.
- **A PRICE CHANGE DE-SYNCHRONISES THE TWO BOOKS — it does not "free" them** (2026-09-23,
  observed twice, and it is the opposite of what the skill's "switch resource / tune the
  price live" wording implies). On a price step the **holiday side cancels and re-lists at
  the new price within a minute; OUR side does not.** Our towns stay at `free < 1` with ten
  orders resting at the OLD price, and an order at the old price never crosses one at the
  new price — so the step stops the matching dead instead of restarting it.
  - 150 -> 140 at 10:13: the banks placed 72 orders at 140 inside a minute; our twelve
    sellers placed **nothing** at 140 and sat in `glitch-res-sell.txt`'s `full` branch
    (`line 41: sleep 0.3`).
  - 0.001 -> 0.002 at 10:55: the banks placed 204 orders at 0.002 in 40 s; our thirteen
    buyers placed **6**, and sat in `glitch-res-buy.txt`'s `full` branch (`line 35`).
  - It is NOT the caps: of 130 buying towns, only 10 had ever printed `SITOUT`, so they were
    at line 24 (`free < 1`), not over `capRes`/`capGold`.
  - **The early-session spikes that made a price step look like the cure were the RESTARTS
    that went with it, not the price.** A fresh start re-lists everything at the live price.
  - **So: do not step the price to unstick a stall.** Either put the price back to what our
    side's resting orders are still at (the banks re-list onto it, and the books cross
    again — no restart, instant), or restart OUR side so it re-lists at the live price.
  - Why our side does not re-list is **unverified**. The cancel loop looks symmetrical
    (`if t.tradeType == want && t.price == price goto next`, else cancel), and the control
    file is reached by `@call`, which silences its `execute "canceltrade …"` lines — so the
    log cannot show whether the loop ran. To chase it, echo from the CALLING script.
- **The real throughput ceiling is 10 offer slots a city, with BOTH sides resting**
  (2026-09-23). A fill happens only when a NEW order crosses a RESTING one; two resting
  orders at the same price never match each other. Each side places until its ten slots are
  full and then waits, so once both books are full the play deadlocks with no refusals, no
  rate limiting and plenty of stock on both sides. At 10:53 every one of our 13 buyers and
  6 of the 8 banks were in the `sleep 0.3` branch, the banks still held ~28t of food, our
  towns were far under the 600b cap, and the Director read "steady, no drops or unanswered
  orders in the last 10 min". **The short side sets the pace:** 8 banks x 10 towns = 80
  selling towns against 130 buying towns, and only 98 of the 210 towns were trading at all.
- **What the slot recycling is worth, measured (2026-09-23 11:36-11:39).** With the buy
  side recycling its slots (`slotWait` / `recycleAfter`, live in the control file) the play
  ran at **36,569 fills in three minutes = 1.22t of food a minute, ~95% capture** of the
  3.84t the banks sold in the same window. Yesterday's best buy-back pass was 94b a minute.
  So the deadlock, not the price and not the rivals, was the whole difference.
  - **Count fills as `placed − cancelled`** from the logs: the recycling makes "placed"
    meaningless on its own (44,139 placed, 7,570 cancelled in those three minutes), and
    snapshots are worse still — they showed 71b a minute, a 17x understatement, because
    bought food travels.
  - The SELLING side's slots free only by filling: 38,394 sells placed, **zero cancels**.
    That is the clean way to measure what the banks really moved.
- **A long-running seller sits out while its towns are still full** (2026-09-23 11:41, Lord04).
  Its run had been selling since 10:27 and the control file's own tracker (`startRes −
  traded × order`, which counts every order PLACED as sold) had walked down to nothing, so
  every city printed "SITOUT sell food — over a cap or under its runway" while really
  holding 522-720b a town — 6.2t of the fleet's food idle, the largest holder of the eight.
  Nothing in the log says "the tracker is stale"; the tell is a bank that places no orders
  while its snapshot still shows food. **A relog resets `startRes` and `traded`** and it was
  selling again within a minute. Check every seller's placement count against its snapshot
  before assuming the supply is gone.
- **After a pass that spends an account's gold, its sell side will not start until it
  relogs** (2026-09-23 13:02). Every bank sat in `glitch-res-sell.txt`'s "no room / not
  enough gold" branch (`sleep 0.3`, line 41) placing nothing, because the script checks the
  city's gold against the 0.5% listing fee and the console's CACHED gold still read ~0 from
  the end of the 150 gold pass. Nothing in the log says why — the branch is silent. A relog
  refreshed the balances and all eight banks listed stone within seconds. `canceltrade`
  reported 0 offers, so the slots were never the problem.
- **Changing the RESOURCE mid-play needs no restart — changing the PRICE still does**
  (2026-09-23 14:51). Stone -> wood was a two-line edit to the control file (`res` and
  `prevRes`); within 45 seconds the banks were listing wood (4,182 orders) and our side
  bidding on it (10,442), with no console touched. `prevRes` is what makes it clean: both
  sides take their old-resource orders off the book, so the ten slots are free for the new
  one. Contrast the price fault above, where only the banks re-list.
- **The selling side sets the pace, and it fades as sellers empty** (the stone pass,
  2026-09-23). Eight banks moved 69.2t of stone at ~950b a minute; once four had sold out
  the remaining four managed ~250b a minute between them — each survivor lists at about
  half the rate it did when all eight were going, because a seller's slot only frees when
  an ask fills. 54.6t moved in about 50 minutes, 78% of it caught by our side. Leaving the
  last 14.6t behind costs nothing: a holiday account's stock returns at the next
  maintenance, so the tail of a pass is always the cheapest part to abandon.
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
  **For a stranger, whose console we do not have**, the answer is the `state` on their
  castles on the map: 5 is holiday (§6). That is how the Monitor tells who is sitting out.
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


### Turning the play around: the new BUYING side must be told to drop its old offers (2026-09-24)

- **A bare `canceltrade` first, or the buying side places nothing at all.** At 09:30 the
  play turned from "the banks sell stone at 0.001" to "the banks buy food at 150". Every
  bank city came back from the restart with its ten slots still held by the ASKS it had
  been resting (stone at 0.001, then food at 150 for the two minutes between the control
  file changing and the restart). `glitch-res-buy.txt` computes `free = cap -
  city.tradesArray.length`, so free was 0 in all 80 towns: for eleven minutes the eight
  banks placed **not one bid**, while their stone asks at 0.001 sat on the book for any
  rival to take. The control file's own per-offer cancel loop did NOT clear them.
  The fix is the one that worked on the selling side on 2026-09-23: a bare `canceltrade`
  (every offer of the city, unfilled ones refunded) as the first line of the script —
  `scripts/cancel-clean-then-buy.txt`. Within 90 seconds of that restart the banks were
  placing 86-445 bids each. **Whenever the play reverses, restart the new buying side onto
  a script that cancels first.**
- **A control file that is `@call`ed is SILENT, so a stuck side says nothing.** `@` first on
  a line runs it without logging (script.js:262), and every glitch script calls the control
  file as `@call "glitch-res-control.txt"`. So its `echo "HOLD …"`, its cancels and every
  refusal inside it are invisible in `console-<id>.log` — the account looks idle for no
  reason. To see why a side is doing nothing, put the echo in the CALLING script
  (glitch-res-buy.txt has a `DBG` line for this), never in the control file.
- **A 60-second cadence in the log is the tell for a silent hold or a stalled cancel loop.**
  The only 60 s sleep in the play is the control file's HOLD; a loop that comes round once
  a minute instead of every two seconds is in it (or in a cancel loop whose commands are
  timing out), whatever the log says.

- **A city stuck on a STALE trade list places nothing and says nothing — only a fresh login
  clears it.** 2026-09-24 11:36-12:04: Lord05, Lord06 and Lord14 came out of the gold
  pass, were restarted onto `cancel-then-sell.txt`, echoed `SITOUT over - trading again` in
  all ten towns each — and then placed **not one order for 28 minutes** while holding 15.2t
  of stone. Nothing was wrong with the play: `sitout` was 0, so the run was falling through
  to `free = cap - city.tradesArray.length` and finding no free slot, on a cached list of
  ten offers the server no longer had. Neither the script's own bare `canceltrade` on its
  first line (it runs before the console has the list) nor a second and third one from the
  control file changed anything. **Restarting those three consoles fixed it instantly** —
  4,700-5,770 orders each in the next 110 seconds, against ~1,000 from the banks that were
  already going.
  - The tell: a seller with stock, no `SITOUT` line, and a log that shows only `sleep 0.3`
    or `canceltrade buy` coming round. Place-count it (`glitch-run.js flow`) rather than
    trusting that a restart alone put it right — **it had already been restarted once.**
  - Do not chase it in the control file. The list is the console's cache of
    `trade.getMyTradeList`, kept current by the server's `TradesUpdate` pushes; a login is
    the only thing in OTTObot that re-seeds it.
- **What the pacing IS for, seen the same afternoon.** On the user's instruction the delay
  was taken to 0 on both sides at 13:22. Nothing happened for the first hour. Then, from
  about 14:45, accounts began answering **"no reply to trade.newTrade (server is ignoring
  this account)"** — Lord12 five times and Lord13 four in 92 seconds, then Lord04 ten times
  and Lord06 nine, then Lord10, Lord12 and Lord13 again, which had been clear an hour
  earlier. Their orders fell from ~1,000 per 92 s each to ~280 and the fleet from 664b a
  minute to **99b**. Our own thirteen answered it 17 times in one window too.
  - **The limiter is cumulative and it SPREADS.** It does not arrive when the pace changes;
    it builds and then shows up across the fleet an hour or two later. Throughput measured
    in the first minutes after a change says nothing about it.
  - Climbing back out: 1 s cleared two accounts, 3 s brought Lord06 from 0 to 455 orders,
    Lord04 needed 6 s, and at **2 s on both sides** the banks went back to ~440 orders each and
    all but one were clear. Per-account pacing (`if u == "lord04" sellPace = 6`) is the way to
    protect one without slowing the other seven — Lord06 needed the same at 3 s on 09-20.
  - **Never restart an account while it is being ignored.** Pace it and wait; the limiter
    eases with time as much as with the pacing.
- **The loop pacing is NOT what limits throughput — measured 2026-09-24 13:00.** Asked
  whether the play was "putting in unnecessary wait times", the control file's one-second
  sleep was cut to 0.3 s on the selling side and the fleet was counted over a minute either
  way: **1,084b a minute at 1.0 s, 965b at 0.3 s** — no gain, slightly worse — while the
  sellers' "market is full" loops went up FOUR times (Lord10 46 -> 196, Lord04 138 -> 588).
  The selling side is not waiting on us; it is waiting for its ten slots to be matched. A
  shorter loop only spins against a full market and buys rate-limit risk for nothing. Put
  back to 1.0 s, and `sellPace` / `buyPace` are separate in the control file now so either
  can be tuned live.
- **What DOES set the rate is how many bank CITIES are selling.** Each selling town runs at
  roughly 270 orders a minute (27b of resource), whatever the pacing, so the fleet rate is
  about `27b x towns`. Four live banks = ~1.08t a minute; all eight = **1,332b a minute**
  (2026-09-24 13:03), which beats the 1.22t best of the day before. A bank that goes quiet
  is worth a relog immediately — it is worth ~270b a minute.
- **What one town sees is the fleet rate divided by the buying towns.** 1,332b a minute
  across 13 accounts of ten towns is about **10b a minute a town**, or ~600b an hour — which
  is the "400b incoming" figure remembered from a good day. A town showing "20b" over a
  short window is not a fault; count the fleet from the logs before chasing it.
### What the 2026-09-24 maintenance put back (the day the play ran overnight)

- The eight banks (Lord04, Lord05, Lord06, Lord10, Lord11, Lord12, Lord13,
  Lord14) came out of the 09:18 maintenance with **2,420.5t of GOLD**, 41.4t food,
  23.5t wood, 68.1t stone and 18.5t iron put back into them — against 32.5t of gold and
  almost no resources going in. Gold is restored like any other resource, and after a day
  of selling resources cheap into our accounts it is the biggest single thing the glitch
  gives back. Filed in the glitch log as `maint:2026-09-24` (see below).
- **The glitch log had never recorded anything: its tables did not exist.** `glitch-log.js`
  is only loaded by the Director, and the Director has not been restarted since it was
  written (2026-09-23), so `glitch_maint` / `glitch_runs` were never created and no
  before/after record was ever taken. Filed 2026-09-24 by hand from what was already
  there — `before` = that morning's 08:30 record, `after` = the consoles' own post-restore
  snapshots — and marked `source = assumed` in the row. **Until the Director is restarted,
  no maintenance is being recorded: take the record by hand on the day, or it is lost.**

- **Sizing `capGold` (or any cap on the side that RECEIVES): size it on where the towns
  END, not where they start** (2026-09-25). Asked to raise the gold cap to "75t or 100t"
  with at least half our towns selling, the useful numbers were not the current holdings
  but the arithmetic of the pass: our 110 towns held 41.3t of gold at the median and 50.1t
  at the most, so *every* candidate cap already had 99-100% of them selling and the choice
  looked arbitrary. The banks held 3,092t, which is ~28t a town once moved, so a typical
  town FINISHES near 69t and the fullest near 78t. 75t would therefore have dropped the
  fullest towns onto the sitout in the closing stretch — the worst moment, when the last
  gold is hardest to shift. 100t was chosen for that reason. **Always add the incoming
  amount / town count to the current maximum before picking a cap.**
- **Check the RECEIVING side's room before a gold pass, against the cap that actually
  binds.** At price >= 50 `kind` is "gold", so `capRes` (the 900b food soft cap) is NOT
  read — only the hard `foodCap` 950b is. Measuring against 900b said the nine banks had
  26.3t of room for a 20.6t need (a worryingly thin 28%); against the 950b that really
  binds it was 30.7t, or 149% of the need, with no town sitting out at the start. Read the
  `kind` gate before believing a capacity figure.
- **A lord name is NOT the account label, and the comparison is case-sensitive.**
  `u = player.playerInfo.userName`, and the fleet's are `lord04`, `Lord05`, `points`,
  `Lord19` and `Lord15` against labels Lord04, Lord05, Lord13, Lord19 and
  Lord15. A mis-cased name in the `holi` list silently drops that account to the
  non-holiday branch, where the safety HOLDS it — fail-safe, but the pass quietly runs
  without it. Read the lord off a snapshot (`json.lord`) before editing the list.

- **Cancelling to "recycle" market slots was a REGRESSION. Do not add it back without a
  measurement** (the user, 2026-09-25). The original and correct behaviour is: read how
  many offer slots are free (`free = cap - city.tradesArray.length`) and place exactly that
  many (`x{free}`) each loop; a full city waits for one of its own offers to go. The user:
  *"what worked really well was when we just would check x number of spots in market and we
  place that number each time … that was like 3 days ago and we had 400b+ incoming of food
  in one city at a stage, highest ive seen in past 2 days was 113b … we did change something
  and its a change for the worse."* The dates line up: the **buy** script gained its
  cancel-and-re-list recycle on 2026-09-23, AFTER that fast run, and the **sell** script
  gained one at 10:02 on 2026-09-25, after which that pass got worse, not better. Both were
  removed at 10:25; each `full` branch is now `waitslot {slotWait}` then `goto top`.
  - **Cancelling a SELL does not refund the fee.** The console says so plainly — *"about
    749,999,993 gold in fees stays paid"* per town per cycle (Lord03, 10:11). So a
    recycling sell side BURNS gold to destroy orders that would otherwise have filled.
    Cancelling an unfilled BID is refunded; the two are not symmetric, and the buy script's
    comment ("Cancelling costs nothing") was only ever true of bids.
  - The deadlock argument the recycle was written for ("two resting orders never cross")
    did not survive contact: with the recycle off the banks went on draining normally.
- **`recycleAfter` is NOT live-tunable, whatever its comment says** (2026-09-25). The
  control file is `@call`ed every loop and prices and caps do apply within a second, but
  `recycleAfter` was set to 999999 at 10:16 and the `canceltrade` it guards still fired at
  **10:22:18** on Lord08, six minutes and many loops later. The mechanism is *unverified* —
  what is established is that the knob did not stop the behaviour, so a change to the
  recycle has to be made in the SCRIPT and needs a restart. Do not trust a live edit to
  `recycleAfter`/`slotWait` to take effect; verify in the log that the behaviour changed.
- **Never restart the same account twice inside 10 minutes — the second restart runs
  NOTHING** (2026-09-25, cost ~9 minutes mid-pass). A console skips its autorun if that
  account's script started in the last 10 minutes (the evony-holiday-prep skill has said so
  since 2026-09-22). Six sellers were restarted at 09:53 and again at 10:02:59; they logged
  in cleanly (`logged in as Lord01 — 10 city(ies)`) and then sat there with no script at
  all, silent in the log, while the four accounts NOT caught by the gate ran normally. The
  tell is a console whose log simply STOPS after the `[conn] … session ready` line. Check
  the last `[autorun` timestamp per account before assuming a restart worked.

- **Run every glitch play through the Director's Trading tab** (the user, 2026-09-25:
  *"Always trade through this trading tab please, its really useful for me to be able to see
  whats going on … document it in the trading skill so future agents always work through
  it."*). Starting one from `glitch-run.js` leaves that screen showing a stale play — on
  2026-09-25 it still listed the previous day's stone sides and "Start is refused — 9
  issues" while a gold play ran from the command line, so the user could not see their own
  fleet. The tab also enforces the holiday check per account, works around the 10-minute
  autorun gate and starts the buyers 60 s before the sellers. How to drive it: the
  **evony-glitch skill**, first section.
- **A gold pass ends when the BUYING side runs out of ROOM, not gold** (2026-09-25). Food
  caps at 950b a city, so each bank town absorbs only what is left under that. The pass
  moved 2,180t of 3,092t and stopped with 913t still in the banks, because the gold and the
  room were in different accounts: Lord08, Lord09 and Lord15 held **759t between them with
  every town at the cap** (0.02-0.13t of room each), while the banks that had room held
  0.1t of gold. The fleet total (17.5t of room, 913t of gold) looked healthy and hid it
  completely. **Size it as `min(gold, room x price)` per bank, then sum.** 150 is the price
  box's maximum, so price cannot buy more gold per unit of food — room is the only lever.
  The unblock is a round trip (the full banks sell that food back at 0.001, then flip to
  gold again); otherwise it waits for maintenance, which resets their food and their gold.

- **MOVE GOLD THROUGH STONE, NOT FOOD — and the day's order is gold, stone, food, wood,
  iron** (the user, 2026-09-26: *"going forward as a rule transfer gold through stone, for
  exactly this reason, because theres no more space for more food … I want the order each
  day to be 1. Gold 2. Stone 3. food 4. wood 5. iron"*).
  - **Why.** The carrier's cap is what ends a gold pass. Food may never pass 950b a town (at
    1t a city's food RESETS TO 0) and both sides sit near it, so a food-carried gold pass
    strangles itself. Measured that morning: Lord08 still held **364t of gold with 0.9t of
    food room** — 229t of it could not move at all — while the banks with room held no
    gold, and a bank cannot use another bank's room. Stone's cap is **2,000b a town**: the
    same banks had **97.8t of stone room** against the ~5t needed to carry the remaining
    740t of gold.
  - The user spotted it from the game, not the dashboard: *"I see a bunch of accounts
    showing over 100b in stone coming in"*.
  - `trade-advance.js` now walks gold -> stone -> food -> wood -> iron and **flips the sides
    per step** (a GOLD pass has the banks BUYING the carrier; a RESOURCE pass has them
    SELLING it).
- **The Trading tab's `clean-then-buy.txt` / `clean-then-sell.txt` did NOT cancel the order
  book** — only the reports (found 2026-09-26). So every switch left the previous pass's ten
  resting orders in place: after the 08:43-08:54 stone pass the gold pass that followed
  could place **one order a city** (`sell food … x1`) because nine slots still held stone
  bids at 0.001, and those bids went on filling — which is how the user noticed. It ran at
  about a tenth of its throughput for ten minutes. Both scripts now `canceltrade` first;
  after the restart every account placed `x10`. **An unfilled BID is refunded; a cancelled
  SELL keeps its fee**, which at 0.001 is a few hundred gold.
  - Watch the `x<n>` in `sell|buy <res> … x<n>`: it is the count of FREE slots. A fleet
    sitting at x1 is a held book, not a slow market.

- **A BANK'S GOLD CANNOT BE MEASURED WHILE ITS BIDS ARE RESTING — the committed gold is
  invisible, and a gold pass therefore looks finished when it is not** (2026-09-26). The
  fee AND the full price are taken when a buy order is PLACED, so a bank sitting on ten
  resting bids a city (10 cities x 10 orders x 99,999,999 stone @ 150 = ~15b each) has well
  over a trillion locked away and reads as almost empty. That morning the banks read
  **0.77t of gold** after the gold pass — every one at 0.07-0.11t, apparently down to the
  20m keep floor — so the pass was called finished. The next step (stone at 0.001) began
  with `canceltrade`, which **refunded every resting bid**, and the banks immediately read
  **8.64t**. Our own gold was unchanged at 8,618.5t over the same window, which proves the
  gold came back from their own cancelled orders and not from us.
  - **So: cancel the books BEFORE judging whether a gold pass is done.** A reading taken
    with orders resting understates the bank's gold by roughly (resting orders x price x
    amount). Re-run the gold step after the next switch has cleared the books.
  - `bank-truth.js` relogs the banks for a true figure, but a relog does NOT cancel orders,
    so it does not cure this one. Only a cancel does.

### What the 2026-09-27 maintenance put back, and the rotation around it

- **The put-back is PARTIAL, and it can miss one resource completely.** The nine banks
  (Lord04, Lord05, Lord08, Lord09, Lord11, Lord13, Lord14, Lord15, Lord16) had been drained
  to ~0.1t of gold each the day before; the 08:58 maintenance put **2,610t of gold** back
  into them — 235-472t each — plus their food, wood, stone and iron. That is roughly 86% of
  the ~3,039t taken out of them, so **do not plan on a full restore**.
  **Lord14 got every resource back and NO GOLD AT ALL** (0.1t before, 0.1t after, while its
  food/wood/stone/iron all returned). One account's gold missing entirely, with its
  resources intact, is a shape worth knowing: it is not a failed poll, and it is not
  something we did. *One observation — watch whether it repeats on the same account.*
- **An account holidayed the evening before is glitch-ready the very next morning.** The
  five put in on 2026-09-26 evening (Lord02, Lord03, Lord17, Lord20, Lord21) came through
  this one maintenance and the Director showed all five `holiday=ready` at 09:19, each
  holding the ~837-916t of gold they carried in. One maintenance is all "across a
  maintenance" needs.

### A `capGold` can park an ENTIRE account, from the first second of the next pass (2026-09-27)

Every one of Lord01's ten towns read **99.2-100.1t of gold** against a `capGold` of 100t:
they had each filled to the cap during the previous day's pass and stopped there. So at the
next start Lord01 was on the sitout in all ten towns — a tenth of the selling side, and the
12.3t of stone it held, silently out of the play with nothing in any log to say so.

**The total room figure will not show you this.** Room summed over all towns looked healthy;
it was one account's towns all sitting exactly at the ceiling. Before a pass, print the
**per-town** holdings against the cap and count how many towns are actually under it — not
just the total. (The related rule above, "size it on where the towns END", is what stops
towns reaching the cap mid-pass; this one is about towns that are already there when you
start.) The user's call on the day was to let that account sit out rather than raise the cap.

### Stopping the play and starting it again is a ~20-minute round trip (2026-09-27)

The Trading tab's stop is not instant, and neither is the next start. Measured:

- Stop issued **09:27:3x**. `drain` first — "waiting for every city to finish its last batch
  and end its run", 20 s to 2.5 min. Then `clean`, which **restarts every console onto
  `clean-reports.txt`**, and each restarted console must then wait out its own **10-minute
  autorun gate**. The status text names the gate expiry per account. State reached
  `stopped` at **09:38:29** — **11 minutes**.
- The next start, issued at 09:42, then put all five banks in `waiting` until **09:48:3x** —
  the *same* gate again, because the clean had just restarted them — with the selling side
  60 s behind that.

So: **never stop a running pass for a change that the control file can make live.** Price,
the caps, the runways, the `holi` list and the sitout rules all apply within a second of
being edited (`@call`ed every loop). Stop only to change which accounts are on which SIDE,
or to end the day. And when a stop has just run, expect the next start to idle ~10 minutes
before a single order is placed — that is the gate, not a fault.

### A hand-run script STOPS that city's trading run, and the watchdog will not put it back (2026-09-27)

The user ran a `useitem aries amulet` loop by hand in one of Lord24's cities while the gold
pass was on. The city's trading run ended on the spot — `stopped — the rest of the script was
not run` — and stayed dead. **One city runs one script**: starting anything in a city kills
what was already running there.

Worse, **the Trading tab's watchdog deliberately leaves it alone.** Its rules skip an account
that is "sitting out on a cap" or whose run "ended on its first loop", and a near-empty
account reads exactly like that — so nothing restarts it and nothing complains. Lord24 sat
doing nothing and the only trace was the absence of its name in `glitch-run.js flow`.

**So: after running anything by hand in an account that is in the play, put it back**
(`node glitch-run.js start --sell <id> --sell-script clean-then-sell.txt`, or `--buy` /
`clean-then-buy.txt` for a bank). A hand-run in a trading account is a silent withdrawal from
the pass.

- Tell the two apart in the log by the prefix: `[autorun <city>]` is the play's own script,
  `[script]` is an ad-hoc run from the console's box.

### Before restarting a console, READ its autorun stamp — the gate is per account (2026-09-27)

Restarted Lord24 at 09:59:25 to put it back on the play. It logged in and ran **nothing**: its
last autorun was 09:51:04 and the gate is 10 minutes, so the restart fell 1m39s inside it. The
tell is exactly as documented — the log ends at `reconnected` with no `[autorun …]` line after
it — and the console does **not** retry once the gate lifts. The restart is simply wasted.

**The stamp is readable, so read it instead of guessing:** the org settings key
`autorunLastStart` is a map of accountId -> ms. Gate lifts at that + 10 min
(`AUTORUN_GAP_MS`, `script-console.js`). Wait for it (plus a few seconds) and restart again.

```js
const last = org.settings.get('autorunLastStart', {})['a24'];   // ms, per account
// restart only after last + 10*60000
```

Note the stamp only advances when autorun actually STARTS scripts — a login that was gated
does not move it, so the gate does not creep forward each time you retry.

### A start that is stopped part-way can leave an ORPHAN console (2026-09-27)

A gold pass was started at 09:25 and stopped at 09:27, while it was still restarting the
banks' consoles one by one. Half an hour later Lord04 was serving **two** consoles — 8731
(pid 19824, the current one) and 8747 (pid 8904, started 09:26:55, from the interrupted
start). Both were logged in, which is the endless login war the game reports as "ANOTHER USER
HAS LOGGED INTO THIS ACCOUNT".

**After any interrupted start or stop, map the ports before trusting the fleet.** `botctl.js
list` prints the port and pid the Director *tracks*; anything else answering on a console port
for the same account is the orphan, and `botctl` cannot clear it because it does not know it
exists — kill that pid directly (`Stop-Process -Id <pid> -Force`). `C:\tmp\portmap.js`
asks every port which account it holds and names the duplicates.

### The market fee is 0.5% of the order's VALUE, in gold — which limits a poor account (2026-09-27)

A sell of 99,999,999 stone at 150 logs `a 74,999,999 gold fee (0.5%) each`: 0.5% of the
1.5e10 the order is worth, taken **in gold, per order, at placement** (and a cancelled SELL
keeps its fee — only an unfilled BID is refunded). At the gold-pass price of 150 that is
**~75m gold an order**.

This is nothing to a town holding 50t, but it is the binding limit on bootstrapping an empty
account: Lord24 and Lord25 hold ~600m of gold a town, which is **eight sell orders** before
the 20m runway stops them. It is still richly worth it — one filled order returns 15b — but
an empty account cannot open a full book of 10, and if its offers do not fill the fee is gone.
Give such an account resources first (or let a resource pass fill it) rather than expecting it
to trade its way up from nothing in one pass.

### "Insufficient resources. Required Gold 2147483647" means the account is simply OUT of gold (2026-09-27)

A bank refusing every buy with

    FAILED (ok=-1) - Insufficient resources. Required Gold 2147483647.

looks like a 32-bit overflow bug, because **2,147,483,647 is exactly 2^31-1**. It is not a
bug to work around: the *required* figure in the error is clamped to INT_MAX by the server's
int32 field, while the real requirement was the 15,074,999,849 gold the console had just
printed on the same line. The refusal itself is honest — **the city had no gold left.**

It is in fact the most reliable tell that a gold pass has drained the banks, and it arrives
long before the snapshots admit it: Lord02 began refusing at **10:12**, and its cached
snapshot still read 337t of gold (1,194t across the five banks) at **10:38**. A relog put the
true figure at **0.44t**.

**So: a bank refusing with Required Gold 2147483647 is finished. Do not read the number.**

### The scheduler judges "finished" on CACHED figures, which lag ~20 minutes (2026-09-27)

`trade-advance.js` measures both sides from `account_latest`, and on a busy account that
table lags badly. At 10:23:59 it logged `gold: banks 1194.2t` and — correctly, by its own
rule — kept the gold pass running. The banks had actually been empty since about 10:12, and
every city had been printing `SITOUT` and `canceltrade … has no open bids to cancel` for
twenty minutes. Nothing was wrong with the scheduler's logic; its *input* was stale.

**The signature: the Trading tab shows 0 orders a minute while the scheduler says there is
plenty left.** When those two disagree, the tab is right and the cache is wrong.

**The fix is a relog, and it is quick.** `node bank-truth.js` reconnects each bank and waits
for a snapshot newer than the relog, which rewrites `account_latest`. Once it had run at
10:43:05, the very next scheduled run (10:43:59) read `banks 0.4t`, called gold finished and
started the stone pass by itself — no forcing, no hand-started pass.

- Keep `BANK_IDS` in `bank-truth.js` in step with the roster; it is the **fourth** place a
  rotation has to be changed, after `BANKS`/`OURS` in `trade-advance.js` and the `holi` list.
  Run against the wrong list it silently relogs the wrong accounts — here it relogged nine
  accounts that were mid-pass on our side.
- Worth considering: have `trade-advance.js` relog the draining side itself before it
  declares a pass finished, rather than trusting the cache.

### The price ladder measures our share on RAW order counts, so in a resource play it always drives to the cheapest rung (2026-09-27)

`res-ladder.js` (in `trading-setup.js`, `ladder()`) decides which way to step the price with

    const pct = b.placed ? Math.round(100 * o.placed / b.placed) : null;

— the **raw** count of orders placed by our side over the banks'. Our buying side cancels and
re-places its whole book to keep its slots turning over, so `o.placed` counts the same ten
bids again and again and comes out **ten to twenty times** the real figure. Measured
2026-09-27 13:21-13:25: ours 103,452 placed against the banks' 10,198 — a raw 1,014%.

In a resource play `better = -1` (cheaper), and the step fires whenever `pct > 80`. Since the
raw ratio is *never* below 80, **the ladder steps cheaper every single round until it hits the
bottom rung and stops**. Observed that morning: 0.01 -> 0.001 at 12:37, then "0.001 is the end
of the ladder" at 12:47 and 12:57; and when the price was raised to 3 by hand it walked it
straight back, **3 -> 2 at 13:07 and 2 -> 1 at 13:17**, quoting 466% and 734%.

**The Trading tab's own "Return" does not have this bug** — it nets cancelled bids off our
count, and its note says why: *"without that the return read 1072% on a day the banks had
already run dry (2026-09-24)"*. So the dashboard read **50%** over the same window the ladder
read 466-1,014%. The dashboard was fixed for this and the ladder never was.

**Why it matters:** cheaper is not automatically better. Cheap stone is what other players'
bots lock onto. Our own intake fell as the ladder drove the price down — 185.1t -> 194.2t
(+9.1t) in the 20 minutes to 12:47, then only +5.3t in the 20 minutes to 13:07 — while the
banks' stock kept draining, i.e. the extra volume was going to strangers.

**CONFIRMED by pinning the price.** With the ladder off and the price held at 3, the share
of what left the banks that actually reached us went:

| window | price | left the banks | reached us | our share |
|---|---|---|---|---|
| 12:47-13:07 | 0.001 | 12.79t | +5.3t | **41%** |
| 13:07-13:27 | 1 -> 3 | 5.31t | +4.4t | 83% |
| 13:27-13:47 | 3 | 5.00t | +4.6t | **92%** |

Same fleet, same scripts, same 20-minute windows: **41% -> 92% on the price alone.** At
0.001 the banks drained more than twice as fast and over half of it went to strangers.
Note the cost of price 3 is paid to a HOLIDAY account, so it returns in that bank's restore
baseline and the next gold pass sweeps it out again — a dear buy-back price is close to
free, and a cheap one is what actually costs.

**What to do until it is fixed:**
- **Turn the ladder off** before setting a price by hand: `POST /api/trading/setup {"ladder": false}`.
  Otherwise your price lasts about two minutes.
- Or set a price that is **not one of the rungs** (res: 0.001, 0.01, 0.1, 0.5, 1, 2, 3; e.g.
  use 2.5). The ladder has a guard — *"price N is not one of … (set by hand), left alone"* —
  and will not touch it.
- **Judge capture on the tab's Return, never on the ladder's percentage.**

*The fix, when someone writes it:* count a cancelled bid off `o.placed` in `count()`, the same
way the tab does, or judge the ladder on filled orders rather than placed ones.

### A pass slows because CITIES RETIRE, not because the scripts slow down — count them first (2026-09-27)

**When throughput falls, the first thing to measure is how many cities on the draining side
can still place an order.** Not the price, not the order rate, not the cancel churn — the
count of live cities. A city whose stock drops under `keepRes + order` (1b + 0.1b = **1.1b**
for the sell side) goes quiet **silently**: it prints `SITOUT` at most, the account stays
connected and "healthy", and nothing in the Trading tab says the selling side has shrunk.

Measured at 13:39 on the stone pass, with the banks' totals still reading 12.81t:

| bank | stone | cities able to sell |
|---|---|---|
| Lord17 | 8.69t | 10/10 |
| Lord03 | 2.94t | 9/10 |
| Lord02 | 0.74t | 5/10 |
| Lord21 | 0.44t | 1/10 |
| Lord20 | **0.00t** | **0/10** |
| | | **25 of 50** |

Half the selling side had retired, so the order rate had roughly halved — 3,993/min against
~7,300/min an hour earlier — with **no sitout, hold or refusal** on the accounts still
working. Nothing was broken.

**The trap is that the remaining stock is CONCENTRATED, so a spot check lies.** Looking at one
of Lord03's cities showed ~709b of stone and the reasonable conclusion "we still have
almost a trillion per city, why is it so slow?" — while four of Lord02's cities held
0.01-0.14b and every one of Lord20's was under 0.94b. An account total divided by ten is
not the per-city figure; print the distribution.

```js
// the number that actually explains the throughput
const FLOOR = 1.1e9;                       // keepRes 1b + one order 0.1b
cityList.filter((c) => (c.stone || 0) >= FLOOR).length
```

**Diagnostic order when a pass slows:**
1. **Count the live cities on the draining side** (above the runway). Half gone = half speed.
2. Only then look at the tab's **Return** for leakage to other players (and check whether the
   price ladder has walked the price down — see the entry above).
3. Only then look at the scripts.

Doing this the other way round on 2026-09-27 cost two wrong changes: backing the cancel
recycle off from 2 to 8 (measured no better, reverted) and reading the whole slowdown as
leakage. Both of those were real findings in their own right — the ladder bug is genuine and
pinning the price took our share from 41% to 83% — but neither was the main cause, which was
simply that the pass was 88% finished and the banks were emptying out.

### A resource pass can DEADLOCK at price 3 from a cold start — 1 crosses, 3 does not (2026-09-27, mechanism unexplained)

The food pass was started fresh at **price 3** (after price 3 had worked well on stone). For
**20 minutes** both sides placed hard and **nothing whatsoever crossed**:

- banks placed ~17,400 food sell orders in 3 minutes, our side ~17,900 buy orders;
- **zero fills** — not one `ok=-97` ("this order is closed or nonexistent", the tell that a
  bid matched before we could cancel it) across all eighteen of our accounts;
- a relog of the banks showed food still at **45.0t**, unchanged from before the pass began;
- a relog of two of OUR accounts showed food unchanged (8.44t, 9.00t) and gold flat
  (-1.3t, just order fees) — **so it was not leaking to other players either**. Nothing was
  moving in any direction.

Dropping the price to **1** crossed within seconds: **1,643 fills in the next 2.5 minutes.**

**What this is NOT.** It is tempting to explain it with the note in `glitch-res-buy.txt` that
"orders at the same price never cross" — but that cannot be it, because at price 1 both sides
are *also* on the same price and it crosses perfectly well. The same-price explanation is
disproved by the fix. (The gold pass also runs both sides at 150 and moved 4,150t.)

**What we actually know:** food, cold start, price 3 = deadlock; price 1 = fine. Stone reached
price 3 by being walked *up* from 0.001 while already trading, and kept moving. So the safe
rule is:

> **Start a resource pass at 1 (the user's own starting figure). Only step UP to 2 or 3 on a
> pass that is already crossing, and check fills after each step.**

Do not start cold at 3. And when a pass reads zero movement, **count `ok=-97` fills** before
anything else — placements prove nothing, and both sides can look perfectly busy while
achieving literally nothing.

**CONFIRMED on wood the same afternoon: stepping UP works, and it is worth doing.** Wood was
started at 1, verified crossing, then stepped 1 -> 2 -> 3, measuring fills over 2.5 minutes
at each rung:

| wood price | fills / 2.5 min |
|---|---|
| 1 | ~1,960 |
| 2 | 5,767 |
| 3 | 5,640 |

**Price 3 did NOT deadlock here** — the same price that froze food from a cold start was
perfectly fine as a step up from a pass already crossing, which is exactly what the rule
above predicts. 2 and 3 are equivalent on throughput; prefer 3, because a dearer price is
what deters the other players' bots (stone went 41% -> 92% on that alone) and the gold is
paid to a holiday account, so the closing gold sweep takes it back.

**And the corollary, learned by getting it wrong on food:** a pass left at 1 leaks badly.
Food ran at 1 and captured only **31%** — the banks lost 27.0t and our side gained 8.5t, the
rest going to strangers. It should have been stepped up to 2 as soon as it was crossing.
*Do not leave a crossing pass sitting at 1.*

*Unverified:* why 3 fails cold. Worth testing whether it is the price level itself, the
resource, or the absence of a backlog of cheaper resting offers to cross against.

### A snapshot's AGE is not its freshness — the row can be minutes old and its contents much older (2026-09-27)

`account_latest.at` records when the row was WRITTEN, not when the game data in it was
current. A console that has not re-read a city still writes its old figures into a brand new
row.

Caught the hard way after the hub move: a27's snapshot was **4 minutes old** and reported
city 4 still at its origin 257,547 **and** 272 War Teleporters. Both were wrong. A
`/api/reconnect` and re-read gave city 4 at **717,110** and **271** teleporters — which
reconciles exactly with 278 at the start less 7 moves. The stale row even made the item
count agree with the wrong story (one teleporter unspent for one city unmoved), so the two
figures corroborated each other and both were stale.

**Consequences to avoid repeating:**
- A teleport is verified by **relog only** — never by a snapshot, however recent the row
  looks. This is already the rule in the city-swap skill; the reason is here.
- **Do not use a snapshot to contradict a relog-verified report.** That inverts the order of
  authority. It was done here, and a correct report was wrongly called an over-report.
- Two stale numbers agreeing is not corroboration — they came from the same stale read.

### Three ways to measure a pass, and only one of them is trustworthy (2026-09-27)

All three were used on the same passes that afternoon and they disagreed badly. In order of
how much they can be believed, worst first:

1. **`ok=-97` fill counts — OVER-REPORT.** The code means "this order is closed or
   nonexistent" when we try to cancel it, which catches a bid that *filled* but equally one
   that expired or had already gone. On wood it implied ~4.5t moving per 20 minutes while the
   banks' own total fell 0.55t. Useful only as a yes/no that *something* is crossing — which
   is genuinely valuable (it is what proved the price-3 food deadlock), but never as a volume.
2. **The draining side's resource total — CONFOUNDED.** It falls when goods are listed as
   well as when they sell, it is subject to snapshot timing, and on a holiday bank it says
   nothing about where the goods went. Food read "moved 7.16t" while our side gained 0.4t.
3. **A BUYING side's city totals HIDE what is still travelling.** Goods bought on the market
   travel to the city: the gold leaves when the order fills, the goods land minutes later.
   So a relog of a BUYER can read "nothing gained" while food is pouring in — the owner
   could see it as `Incoming` in the city view when the totals said zero. Twice on
   2026-09-27 this produced a confident wrong conclusion ("none of them is getting food")
   about accounts that were working perfectly.
   **For a buying side, read `Incoming` / in-transit, or watch GOLD falling as the proof of
   fills.** Totals alone are a lagging measure and understate a working pass.
4. **RELOG OUR OWN SIDE AND READ THE TOTALS — the best measure, with that caveat.** It is the one
   number that answers the actual question, "how much did we get?", and it also catches the
   failure that matters most: if our GOLD is falling while the resource is not arriving, we
   are buying from strangers rather than from our banks.

```
node bank-truth.js          # the banks, after a fresh login
# and the same /api/reconnect + wait-for-newer-snapshot trick on 3-4 of OUR accounts
```

**Always read gold alongside the resource.** Gold flat (bar order fees) plus resource rising
= the glitch is working. Gold falling with the resource rising = we are paying real players.
That single check ruled out a leak twice on 2026-09-27 in seconds.

Note `trade-advance.js` relogs the BANKS before judging but still reads our side from
`account_latest`, so its "we hold" figure can be twenty minutes stale — it once read 82.8t
unchanged across two runs while four relogged accounts had just gained 0.70t between them.

### A verification RELOG ends a kick hold — `/api/reconnect` clears it silently (2026-09-27)

`Session.reconnect()` (server.js `/api/reconnect`, the page's Refresh) calls
`clearKickHold()` before it logs in. So **every relog we do to check a figure also takes a
kicked account straight back**, restarting the login war with whatever kicked it — and
manufacturing the very "kicked again inside half an hour" signature that §1's test reads as
our own fleet. `bank-truth.js` and every ad-hoc relog do this.

**Read the log carefully — the message lies about which call it was.** `clearKickHold()`
always prints `kick hold ended early — Connect`, whoever called it. Tell them apart by what
follows:

| log | what really happened |
|---|---|
| `kick hold ended early — Connect` **followed by** `refresh — logging in afresh` | `/api/reconnect` — a RELOG (ours, almost certainly) |
| `kick hold ended early — Connect` **alone** | `/api/connect` — the Connect button or the kick banner's "Take it back now" |

Measured the same day: a31 14:33:06 had both lines (our own relog); a30 20:27:12 had only
the first (a human click, 19 s after the kick). Nothing in the codebase POSTs `/api/connect`
— both call sites in `public/app.html` are `.onclick` handlers — so a bare Connect line is
always a person.

**So: never relog an account that is in a kick hold** unless you mean to take it back. If a
figure is needed from a contested account, wait for the hold to run out, or accept the
cached one and say it is cached.

*Worth fixing:* a relog that does not clear the hold (a flag on `/api/reconnect`, or a
separate read-only refresh), so verification cannot start a fight.

### An account with no `keepherobuff` goal needs a hero that clears 1526 NAKED (2026-09-27)

The instant-catapult bar is **1526 attack**, or **1221 while an Excalibur's +25% runs**. The
1221 figure is only safe on an account whose goals carry
`keepherobuff OTTO excalibur /below:1526`, because that is what renews the buff.

**On an account with no goals at all, an Excalibur-dependent hero silently stops being an
insta-pult hero in 7 days** when the buff expires, and nothing says so. a26-a31 have no
`goalFile:prepend:` setting and not one row in the `goals` table, so every hero sent to them
must clear **1526 on its own**.

This also changes what counts as a spare. Counting the donors at the 1221 bar gives a6 17,
a7 8, a16 4; counting at **1526 naked** gives a6 **3**, a7 **7**, a16 **4** — six usable
spares once each account's own OTTO is excluded. **State which bar you are counting at.**

### No `quitalliance` when the two sides are already in different alliances (2026-09-27)

The 2026-09-23 hero move paid **10% of a lord's prestige** to `quitalliance` before the
attack. That cost was avoidable and is not always needed: it was paid because both sides
were in the **same** alliance. Where they already differ, no one has to leave.

Measured today: donors a6/a16 `0utCasts` and a7 `Nbk`; receivers a26/a27/a30/a31 `1112` and
a28/a29 `1111`. Every pairing crosses an alliance boundary, so the whole plan costs no
prestige. **Read both `alliance` fields before assuming the 10% is due.**

*Unverified:* whether an alliance ALLY or NAP relation blocks an attack the way shared
membership does. Check the relation, not just the name, before marching.

### NEVER attack with a hero over level 1800 (2026-09-28, the user)

> "As a rule of thumb never attack anything with a hero over lv1800, these are big heroes
> and its easy to lose a good hero if someone warports on to a npc10 or maybe theres a typo
> in the coords or something so never use >1800 but anything else can be used."

A lost battle can lose the hero (§5b). The risk is not the NPC — it is a tile that stopped
being an NPC between planning and landing (someone war-teleports onto it; we proved a War
Teleporter is accepted onto an L10 on 2026-09-27), or a mistyped coordinate. So every attack
filter in an NPC drive carries `level<1800`, killing waves included.

### `getspamhero` is what actually raises the wave rate (2026-09-28, the user)

**Every attack needs its own hero, and heroes — not troops — are the binding constraint.**
The user: *"often a city has 1mil prax but only 3 heroes, then the spam heroes help because
each attack needs a hero and any level hero will suffice for capturing npc10s."*

    if city.checkFeastingHallSpace getspamhero

`getspamhero` is `hire best` from the inn. `city.checkFeastingHallSpace` is the right guard
because it already **reserves one slot for the training hero when it is away**
(script-objects.js), which is the user's rule: *"we want to always keep 1 feastinghall space
so training hero can move around"*. Call it before each wave, not once.

This is why runs kept stalling with plenty of troops: cities logged "no idle hero ... is
marching, is marching, is marching — waiting" while holding millions of cataphracts.

### Rally Spot sets BOTH the wave size and the number of waves (2026-09-28)

> "lvl of rally spot x 10000 = max troops per wave and waves per city = rally spot level so
> you can use 100k x 10 in almost all cases (since our cities are usually maxed) with a
> haunted castle or halloween or christmas castle they automatically add +25% so we get that
> extra"

So a maxed city is **100,000 a wave x 10 waves = 1m troops in the air**, and a festive castle
raises both by 25%. That is the ceiling a single town can contribute, whatever it holds in
garrison — which is why a town with 9.2m cataphracts is no better than one with 1m, and why
the answer is to reinforce a NEARER town rather than attack from the deep one.

### A march carries at most 100,000 troops — 10,000 per Rally Spot level (2026-09-28)

`reinforce 700,120 any:attack>500 cata:312500` is refused outright:

    FAILED (ok=0) - a march from 3 takes at most 100,000 troops (10,000 per Rally Spot
    level), not 312,500 — /nolimit sends it anyway

So a level-10 Rally Spot caps every march at 100k, and with 10 march slots a city can have
about **1m troops in the air at once**. That is what the user means by "we can use at most
1.25mil prax in a set", and it is why the killing wave is **90k prax** — just under the cap.

**The consequence for an NPC10 drive:** a town holding far more than ~1m prax cannot use it.
lord06's 712,115 held **9,223,701 cataphracts** and could still only throw 100k a march, while
the town nearest the camp (700,120, d6) held 10,265 and no heroes at all. The answer is to
REINFORCE the near town from the deep one — 8 marches x 100k moves 800k plus heroes — and let
the near town do the killing, because distance is what sets the wave rate.

### Only wave 1 needs a big hero; waves 2+ are loyalty grind (2026-09-28, the user)

> "A town only has 8-9 heroes, so wave 1 kills the troops (big hero big attack), waves 2
> onwards are just to clear the remaining abatis, as they dont disappear with first wave, and
> to get the loyalty going to 0, so wave 2 onwards can be scrappy heroes, its just wave 1
> that needs to be proper." And: **"500+ attack is big enough."**

So `any:level<1500` on the follow-up waves is correct and deliberate — do not 'improve' it to
demand attack. Doing that on 2026-09-28 matched NO heroes at all (`no hero in 2 matches
any:attack>500,level<1500`) and stopped the waves dead.

**STICKY WAVES.** The user: *"there do exist sticky waves in the game due to lag ... that the
90k prax wave gets stuck and never kills the troops (its a lag-type glitch) not a game
feature, but often its better to send 2 big waves at the front or even 3 and then start the
loyalty waves."* If the killing wave sticks, every scrappy wave behind it dies against live
troops instead of grinding loyalty — which is exactly what 659 waves into 701,126 did.
**Send 3 killing waves, not 1.**

### Capturing an NPC city is a PLAIN ATTACK, and it can be timed (2026-09-28)

The user: *"its just a regular attack and it can be timed. just send a regular attack! and
time it! make it 3 or 4 regular attacks for a worst case."*

`capture` / `loyaltyattack` are only a convenience wrapper that loops waves in the background
(`/waves=100 /hours=12`) and cannot take an `@:` time. Reading them as the *only* way to take
a city is what made the sequence depend on march length and hero availability. The whole
drive — killing waves, loyalty waves and the capturing town's waves — is plain `attack` lines
with `@:hh:mm:ss.mmm /within=1s`, which fixes the order by the clock.

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
  - A **Haunted Castle / Halloween Castle** applied to a city (`player.haunted.castle`,
    `.adv`, `player.halloween.castle`, `.adv`, spent through `shop.useCastleGoods` on ONE
    city) raises what a march may take by **25%** as well — 125k at Rally Spot L10 with no
    War Ensign (the user, 2026-09-24). It leaves a **`HauntedCastleBuf`** or
    **`HauntedCastleAdvBuf`** running; the client reads that off the PLAYER buff bar
    (`WallBuilding.as:249`, `CastleInfoFrame.as:1317`) although the item is spent on one
    city, so both lists are worth searching. *In the decompiled client the only effects of
    that buff are +10% on all four resources (`CastleInfoFrame.as:1317-1324`) and the
    castle's skin — the march-capacity part is the server's and is **unverified in code**.*
  - **When the march is refused, read WHOSE refusal it is.** On 2026-09-24 a 125k wave was
    turned down by **our own guard**, not by Evony: `game.js newArmy` counts the troops
    against `rally.js marchTroopLimit` and answers in the server's shape
    (`ok=0, errorMsg`) without sending anything — the log line reads "a march from 2 takes
    at most 100,000 troops (10,000 per Rally Spot level), not 125,000", which is our
    wording. A guard that cannot see a bonus must never be the reason a march the game
    would have taken is not even tried, so the guard now adds the haunted castle's 25% and
    **`/nolimit`** sends a march whatever it thinks. The game's own refusal costs nothing:
    no item is spent and no troops leave.
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
- **The server can answer `ok` to a mayor appointment and change nothing** (2026-09-27,
  Lord24's city 3 at 678,497). From 08:06 the user's `setmayor pol` and then the engine
  appointed QUEEN2 (politics 502) 30+ times, every one `hero.promoteToChief -> ok`, with
  **no `server.HeroUpdate` push** and QUEEN2 still idle. The server's own figures prove it
  was ignored: city 3's resource `increaseRate` ran at ~21.7 wood per worker against
  54–77 in Lord24's other cities, which all have a politics mayor — the bare no-mayor rate.
  Nothing of ours sent a `dischargeChief` in that time. City 3 was under a steady attack
  (Chipp, 125k waves) with the gate being opened and closed by hand, and the engine had
  had `Status of this hero is not Idle.` for other heroes there earlier; QUEEN2 herself had
  read status 2 (guard) on the roster from at least 23:26 the night before until the 08:01
  relog. **Why the server ignores it is unknown** — the attack is the first suspect,
  *unverified*. Since that day an `ok` is only believed once the roster shows the hero at
  status 1: the script's `mayor`/`setmayor` and the Heroes tab's Promote wait 3 s for it
  and say "the server answered ok … it ignored the appointment", and the engine, finding
  the hero still idle on its next pass, puts the appointment on the retry ladder instead of
  sending it every minute. Worth trying when it happens: appoint in the real client, and
  appoint again once the attacks stop, to see which condition the server wants.
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

### The fleet has NO taker for an NPC 10 left on ss71 — a1–a25 are all at their cap (2026-09-27)

Read straight out of `account_latest` at 18:45 UTC: **every one of a1–a25 is title 9 with
exactly 10 cities**, and the cap is titleId + 1 (§7), so not one of them can capture. The
capture side of the `evony-npc10` method needs an account **under** its cap; a 10-city
account can only drain. So a drive on the hub's remaining L10 camps is limited by taker
slots, not by troops — Lord06 alone holds 472m troops and eight cities with 500k+ cavalry.

The only ss71 accounts with room are the six new ones moved into the hub the same day:

| account | cities | free slots |
|---|---|---|
| a26 Lord26 | 5 | 5 |
| a27 Lord27 | 7 | 3 |
| a28 Lord28 | 4 | 6 |
| a29 Lord29 | 5 | 5 |
| a30 Lord30 | 8 | 2 |
| a31 Lord31 | 9 | 1 |

**22 free slots against the 19 open L10 camps inside r12 of 704,119** — the arithmetic works
almost exactly, and each of those accounts already has a city 1–4 tiles from several camps.
But those same five (a26–a29, a31) are the **buy side of the live food play** (`tradingRun`
`muk623b7`, started 20:43 SAST), so a capture drive and a market pass compete for the same
accounts. Pick one.

**a32 ShardBearer's 33 cities are not a precedent for beating the cap** — that account is on
**ss91**, a different server, and its cities are at x303–317 / y528–555.

### An NPC 10 falls to plain 20k waves with NO clearing hit at all (2026-09-27, measured)

Settled by accident, live. **716,111 was captured by a27 lord27 at 22:36:25 without a
single clearing hit ever landing on it.** Lord06's clearing city 712,115 was refused every
attempt for ten minutes (the hero-name bug below), so the tile met nothing but plain
`capture` waves of **20,000 cavalry + 20,000 cataphracts + 20,000 scouts** from five drainer
cities (a6 710,110 · 709,112 · 707,110 · 708,109 and a16 713,103) on a 30 s cadence. A full
level-10 garrison — ~400k warriors behind full 5K forts — was ground down in **14 minutes**,
and the three taker cities finished it about 6 minutes after their first 1,500-cavalry wave.

So the "clearing hit MUST land first" rule (§5, 2026-09-18) is about **cost, not
possibility**: it stops individual waves being thrown away, but with five or more heavy
drainers on one tile the mass alone is enough. Compare the same run's 711,121, which *did*
get its two hits (CptKush att 1515 and Peter att 1190) and fell in **11 minutes end to end,
3 minutes after the first capture wave** — faster, and without the wave losses.

Two figures worth keeping from that run: **both targets cost about 81,000 cavalry of capture
waves in total**, against ~150,000 burned for nothing on 2026-09-26; and a taker city spends
its cavalry at exactly `takeWave` a wave, so **30,000 cavalry is 20 waves and then the city
goes silent** (a26 @697,124 did precisely that, 30,000 → 0).

### THE DRAIN CAN DESTROY THE TARGET: a camp taken to zero loyalty with no taker present becomes a FLAT (2026-09-27)

The costliest lesson of the run, and it inverts the `takeDelay` rule. **696,123 was lost, not
captured.** Dated precisely, because one `map_cache` sweep wrote all three targets at the same
instant, 22:34:08 SAST (`seen` 20:34:08Z on all three to within 100 ms):

| tile | at 22:34:08 | truth |
|---|---|---|
| 711,121 | `kind=player, user=Lord26` | captured 22:33:30 — sweep 38 s later, right |
| 716,111 | `kind=npc, npc=1` | captured 22:36:25 — sweep 2 min earlier, so cache lag |
| **696,123** | **`kind=flat, npc=0, typeName=Flat`** | `npc=1, level=10` in a probe at 19:0x |

So it went from NPC 10 to flat **inside our own drain window and before the takers' first wave
at 22:30:32 could convert it.** Between 22:22:44 and 22:30:32 the only things hitting it were
**a16 Lord16's five cities** — 500,000 cavalry and 0.9–1.3m cataphracts each, only 4.5–11 tiles
out, so the highest wave rate of the three targets — plus two 115k-cataphract clearing hits.
**a16 is at 10 cities and cannot capture.** The loyalty reached zero with no taker wave in
flight, and the city ceased to exist. (Mechanism *inferred*: NPC battle reports are not kept,
so the killing blow cannot be read. What is certain is the tile was an NPC 10 before our drain
and a flat 12 minutes into it.)

Corroboration, all consistent with an empty tile afterwards: a26 @691,128's cavalry **stopped
falling and rose** (29,999 → 16,649 at 22:38 → 16,799 at 22:42), because waves against an
empty flat come home whereas waves against a live L10 garrison are annihilated; and the wave
composition kept flickering as troops cycled back. `capture` still answered `-> null`, which
means only that the march was accepted.

**So `takeDelay` is a two-sided risk, and only one side was known:**

- too short → the taker's wave meets the full garrison and dies (2026-09-18, 60k troops)
- **too long → the drain takes loyalty to zero with nobody able to take it, and the camp is
  destroyed** (2026-09-27, one extra city lost)

Since 716,111 proved five heavy drainers flatten a garrison with no clearing hit at all, **the
clearing hit is not worth waiting five minutes for.** Set `takeDelay` to the *smallest* value
that clears the clearing march — 35–58 for that run's 165–226 s marches, not 60 — and **with a
very heavy drain, start the takers first and set it to zero**: a taker wave that dies costs
1,500 cavalry, a destroyed camp costs the whole city.

Nothing in the machinery notices. The `capture` path in `deploy-loops.js` has **no "its city is
gone" guard** (only the scout path does), `job-take.txt` never reads `doneTargets`, and
`npc-taken-watch.js` only ever matches `TAKEN` — so a *destroyed* target is never recorded and
every drainer and taker keeps firing at bare ground. Until that is fixed, the manual stop is to
**add the tile to `doneTargets` by hand**: `job-drain-big.txt` re-reads `glitch-done.txt` every
loop, so the drainers stop and recall within seconds with **no console restart**.

**What the flat is worth afterwards.** An Advanced Teleporter onto it only *moves* an existing
city, so the account's count does not grow and the tile's real value is forfeited. If it
re-seeds as a Barbarian's city (§5e: hours, not days) it can be **captured for +1 city**. So
where the goal is city count, waiting for the re-seed beats teleporting; the only cost of
waiting is leaving the tile open to an outsider meanwhile. That is an item spend either way and
the fleet owner's call alone.

### A hero whose name is only digits breaks every clearing hit (2026-09-27)

`attack <x,y> <hero> …` **refuses a purely numeric hero name**:

    attack: hero string "123" — "123" is just a number — write it as a filter,
    e.g. any:level>=123

Lord06's city 712,115 has a hero literally named **"123"** (att 1457, L1369) and it is that
city's best idle hero, so `job-drain-big.txt` picked it every time and the clearing hit was
refused once a minute for ten minutes. Worse, the job does `if $error return` after hit 1, so
**a refused hit 1 blocks hit 2 and never falls back to waves** — `dbstage` stays 0 and the
city contributes *nothing*. The fleet's heaviest northern city, 9.2m cataphracts, sat idle
through an entire capture.

The guard, in the hero-picking loop straight after the `level > 1500` test:

    if dbx.name * 1 > 0 goto db_hn

`"123" * 1` is 123 so it is skipped; `"CptKush" * 1` is NaN and `NaN > 0` is false, so real
heroes are kept. **Check the clearing city's best idle hero before trusting a plan**, and note
two of Lord06's ten cities (700,120 and 704,111) have **no idle hero ≤L1500 at all** — a
clearing city there would print "no idle hero" for ever.

### A taker cannot retarget itself, so every capture strands its cavalry (2026-09-27)

`job-drain-big.txt` has `db_retarget` and moves a freed drainer to the next spare.
**`job-take.txt` has no equivalent and never reads `doneTargets`.** Once its target is
captured it simply loops on `capture` and logs, every two minutes:

    FAILED: 716,111 is your own city New city

Harmless — but the city's remaining cavalry is stranded until the plan is edited and that
console restarted. Minutes after the two captures above, a27's three taker cities held
**79,808 cavalry with no target** and a26's 713,124 held **48,470**: about 85 waves of
capacity idling. On a multi-target drive this is the main efficiency loss. Either give
`job-take.txt` a `doneTargets`-aware retarget, or set each taker city's `takeTargets` to
**several** of its account's targets from the start — the job already loops over every entry
and merely errors on the ones already taken.

### One account per target: two DIFFERENT accounts taking one camp attack each other (2026-09-27)

`job-take.txt` never reads `doneTargets` — only the drainers do. So if two taker cities of
**different** accounts are aimed at the same camp, the moment one of them captures it the
other keeps sending capture waves at what is now a **fleet city**, and nothing stops it until
someone edits the plan. With the hub's drainers in **0utCasts** and the new takers in
**1112**, those waves land as an *enemy* attack on our own account, not as an ally's.

Two taker cities of the **same** account on one camp are safe and are what the method wants
(more takers = more waves): a capture attempt on a city you already own just answers
"x,y is your own city". **So: several taker cities per target, but all from one account.**

### `spareTargets = ""` is a BLANK target, not "no spares" (2026-09-27)

`"".split(" ")` is `[""]`, not `[]`. So `job-drain-big.txt`'s `db_retarget` finds exactly one
"spare", finds `doneTargets.includes("  ")` false, and sets **`jobTarget = ""`** — every
drainer whose target has just fallen then marches at nothing, once a minute, for ever. This
is the same failure the 2026-09-22 leading-space bug caused, reached by the opposite route.

**Use a sentinel when there are genuinely no spares:**

    doneTargets = " none "
    spareTargets = "none"

`db_retarget` then finds its one spare already done and simply stops. This is safe across
captures because **`npc-taken-watch.js` appends** to `doneTargets`
(`doneTargets = "${cur}${target} "`), so the sentinel is never overwritten.

### Fleet Feet does not change capture-wave spacing; it multiplies the wave RATE (2026-09-27)

`capture` / `loyaltyattack` waves are paced by the **console's own naps**
(`deploy-loops.js` TIMING, `spamGapMs`/`tickMs`) and carry **no camp at all**, so the
2026-09-27 camp-shortening rule above does not touch them. What Fleet Feet cuts is the
march out and the march home, i.e. the **hero's round trip** — and one hero per wave is the
bottleneck (§5, above). Two charges (factor 0.3) therefore means roughly **3.3× the waves an
hour out of the same city with the same heroes**. Since wave COUNT is what takes an NPC 10
and wave size is not, **Fleet Feet on the drainers is the biggest single lever in the
method.** (Worked out from the code 2026-09-27; *unverified* live against a measured wave
count.)

**`takeDelay` is wall-clock and does NOT scale with the buffs.** It is a count of 5-second
dispatch ticks in `job-take.txt`, so a Fleet Feet that shortens the clearing hit leaves the
delay where it was — safe in that direction, but a plan whose clearing city is far away needs
the delay sized from that city's real march time:

    takeDelay >= (clearing city's one-way march in seconds + 60) / 5

The settled `takeDelay = 60` (300 s) was set when the drainers were 1–2 tiles out. a6 Lord06's
eight heavy cities sit at y109–117 and are **14–21 tiles** from the hub's southern camps
(`marchTimeMs` at cataphract pace: 577–860 s unbuffed, 173–258 s with two Fleet Feet), where
60 would send the taker's wave into a full garrison. Its eastern camps (711,121 and 716,111)
are 4–7 tiles out — 165–243 s unbuffed — where 60 is ample.

### `armyTimeFactor` predicts a march of 0 s when a Fleet Feet has over 8 h left (2026-09-27)

Measured off `constants.js` the same day: the client's band is −35% under 4 h left, −70%
between 4 and 8 h, and **−105% above 8 h**, so `armyTimeFactor` returns `0.65`, `0.30` and
then **0** — and `marchTimeMs` multiplies by it, so every predicted march time becomes **0 s**
once three charges are on. Anything built on that figure (`marchcheck`, `travelinfo`, timed
waves, `goal-war`'s camp, a `takeDelay` computed from a march) silently goes to zero. The two
camp sites (`script-cmd-deploy.js`, `timed-march.js`) already guard `factor > 0`; the march
prediction does not. **Treat a predicted march of 0 s as "the buff band is out of range", not
as an instant march.** *Unverified:* what the server really does with three charges — the
game cannot plausibly give a negative march, so the real floor is probably lower than 0.30
but above 0.

### War Town holds what LEAVES the city, not what arrives (2026-09-24)

The user asked for "wartown 1 is NO TROOPS MOVE except the training hero, wartown 2 no
troops at all", and then, an hour later, **"its fine to send to a war town"**. So the rule
is the NEAT one and it is about marches OUT:

- a war town sends no transfer march of its own — keeptroops, sendtroops, keepresources,
  sendresources are all held there — and no npc or buildnpc run leaves it;
- it still RECEIVES: another city's keeptroops / sendtroops may reinforce it, and its own
  requesttroops / requestresources still pull, because the march that carries them belongs
  to the city that sends;
- mode 2 keeps the training hero in the city it has landed in; mode 1 lets it come and go,
  and either mode lets it move IN.

**Sealing it to arrivals as well was tried and reverted the same day** (a receiver skip in
pushPlan, a hold on requesttroops, and a block on the training hero arriving at mode 2).
Do not build it again without being asked: a city at war wants reinforcing.

**The sending side was never broken.** Before changing anything, every shape of it was
checked and held: `keeptroops` under `config wartown:1`, `:2`, and under the console's War
Town Mode 1 and 2, with the goal coming from the account PREPEND layer and the mode from
`cityControls:<account>`, end to end through the engine — and `requesttroops` pulling out
of one. **A war town seen marching troops out is worth checking against a hand-run
`reinforce` in the Script tab before blaming the engine** (Lord07's log was full of
them at the time). Tests: `test-wartown.js`.

### A wartownpolicy line was putting the CONSOLE'S switch on a timetable (2026-09-24)

**The bug, with live proof.** Lord07's city 5 sat on War Town Mode 2, set by hand from
the console, and at 13:08 sent **100,000 catapults to main** under the prepend's
`keeptroops main cp:100k`. Nothing was wrong with the sending guard: `lockdown()` found a
`wartownpolicy 05:00 10:00` line, the clock said 13:08, and so it returned `on: false` —
which makes `isWarTown()` return 0 and every transfer guard fall open. The mode was still
2 and the source still "the console"; only `on` was false.

**Where the policy line comes from matters: the ACCOUNT APPEND goals.** Sixteen accounts
carry `config wartown:1` + `wartownpolicy 05:00 10:00` there (a2, a3, a5, a6, a7, a8, a9,
a14, a15, a16, a17-a21 — the last five have the policy only in a COMMENT, so those and a1
are war towns permanently, which is deliberate while they are being brought to the hub).
The append layer is **database-only** — `goalFile:append:<id>` is null for all of them — so
it is invisible if you only read `goals-backup-a15-prepend-2026-09-20.txt`. **Read both
layers out of the `goals` table before concluding anything about a city's goals.**

**Fixed** in `goal-war.js lockdown()`: a mode set from the console returns `on: true`
immediately, before the wartownpolicy windows are looked at. A switch thrown by hand means
"on now". Off and Auto are untouched (Off returns earlier on `!cfg.enabled`; Auto never
reaches the branch). A SCHEDULED war town is still written as `config wartown:` in the
goals. Test: "the switch is not scheduled" in `test-wartown.js` — it fails on the old code.
**Needs a console restart per account**; done for a7 and a9 (the only two with a hand-set
mode) at 13:28.

**Two things that made this hard to find, worth remembering:**

- **A console's log file can never show an engine decision.** `session.note()` writes only
  `[conn]` lines to stdout; the engine's lines live in the in-memory ring the console UI's
  Engine tab reads. `console-a7.log` had nothing at all about war town or keeptroops.
- **`engine_state`'s `war.wartown.on` is not evidence.** It read `on: true` on all ten of
  a7's cities from 2026-09-22 while the lockdown was not holding: `warTownPlan` returns
  before it can clear the flag when nothing is set, and the flag means "the switch is on",
  not "the lockdown holds". *Unfixed, minor.*
- The corroboration that did work: `engine_state` `processing.points.t.at` for the city —
  a troop mission had left city 5 at 13:08:10 — and the distance 631,92 -> 698,110 = 69.38,
  exactly what the army table showed. **100,000 is the Rally Spot march cap**
  (`constants.js MARCH_TROOP_MAX`), not the goal's figure.

### The fleet has ONE war town now (2026-09-24)

The user: *"that wartown was set initially for capturing cities, but its no longer
necessary so you can remove it all"* — and before that, *"nothing should have the permanent
wartown, only that 1 city of lord07 nothing else"*. So **every** `config wartown:` and
`wartownpolicy` line is out of the account Append goals:

- six accounts (Lord01, Lord17, Lord18, Lord19, Lord20, Lord21) had a bare
  `config wartown:1` with no policy, which made every one of their cities a war town around
  the clock — no transfers, no NPC farming, no valley runs. It was put there while they were
  being brought to the hub and capturing cities;
- ten trading accounts had `config wartown:1` + `wartownpolicy 05:00 10:00`, the morning
  window that brought marches home before the holiday prep and the 09:00 maintenance.

Both are gone. **The only war town in the fleet is Lord07 city 5 (castle 1667), War
Town Mode 2, set by hand from its console.** Lord09's hand-set mode on its main was
cleared back to Auto at the same time.

Every append text as it stood is in **`goals-backup-append-wartown-2026-09-24.json`**, so
the morning window can be put back in one command if the marches-home behaviour is missed.
What those ten appends held was the war town pair and nothing else, so they are empty of
goal lines now; the six new accounts keep their `keepherobuff OTTO excalibur /below:1526`.

### The console's War Town Mode switch (2026-09-24)

It works for all four settings, and this is now covered end to end in `test-wartown.js`:
the page posts to `/api/wartown`, `Session.setWarTown` writes `cityControls:<account>` in
the org settings (per city, so a restart keeps it), and the engine reads it back per city
through `controlsFor`. **Off (0) BEATS a `config wartown:2` line in the goals** — it is not
a "let the goals decide", that is what Auto is for.

- Fixed on the way past: `setWarTown` read the mode with `Number(mode)`, and `Number(null)`
  and `Number("")` are both 0 — so a request that named no mode switched the city to **Off**
  without a word instead of being refused. It reads the value as text now and only auto, 0,
  1 and 2 pass. The page always sent a proper value, so nothing in the fleet was affected.

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
- **The numbers that decide march range, out of the client's own tables, and CONFIRMED
  LIVE** (tables read 2026-09-25 from `WarReport.swf` — `GetDataXML_XMLTech` and
  `GetDataXML_XMLBuilding`, with the same Node tag walk `extract-items.js` uses; every
  fleet account has all 20 researches at L10, from the engine's cached `techs.levels` in
  `engine_state`). **`travelinfo 704,119 cp:7500` from Lord07's 700,110, 2026-09-25
  06:49, matched every figure below to the second:**

  ```
  Distance to 704,119: 9.85miles (from 4)
  attack time: 1h:22m:04          <- 9.8489 tiles x 500 s = 4924.4 s
  reinforce time: 13m:41 (Relief Station x6)   <- 4924.4 / 6 = 820.7 s
  carrying total/attack/reinforce: 1125000/-4004614/270064
  ```

  1,125,000 / 7,500 = **150 a catapult**, so Logistics is +100%. The attack figure is
  1,125,000 − 3,750,000 x 1.3679 h = −4,004,589, and the reinforce figure
  1,125,000 − 3,750,000 x 0.2280 h = +270,073 — both the client formula to the rounding.
  Nothing here is inference any more:
  - **Compass L10 = +100%** infantry moving speed → `marchSkillParam` 100.
  - **Horseback Riding L10 = +50%**, not +100% — it is **5% a level**, and it covers
    *"cavalrys and mechanics"*. So `driveSkillParam` is **50**, and it is what the
    catapult, ballista, ram, transporter, cavalry and cataphract move on
    (`constants.js DRIVE_KEYS`). **A catapult's speed is 80 × 1.5 = 120**, so a tile costs
    `60000 / 120 = 500 s = 8m20s`. (An earlier note here said 6m15s from assuming +100%.)
  - **Logistics L10 = +100% load** → `loadSkillParam` 100; a catapult holds 150.
  - **Relief Station**: the `limit` column of its `levelDatas` is the multiplier —
    2, 2, 2, 3, 4, 4, 4, 5, 5, **6**. **L10 multiplies march speed by six**, and the
    building's own text is *"the speed of army movement between the cities of your own and
    your allies"* — it is the TARGET's owner that earns it, which is what
    `game.js troopParams` reads as `transportStationParam`. A catapult **reinforcement**
    therefore runs at 720: **1m23s a tile**, one sixth of an attack.
  - **Rally Spot L10 = 10 marches out of one city. Feasting Hall L10 = 10 heroes in it.**
    Both are the `limit` column, 1 a level.
  - **Archery L10 = +50% range for Archer, Ballista, Catapult and Archer's Tower** — the
    text names those four and not the treb, abatis or trap. So a catapult reaches 2250, a
    ballista 2100, an arrow tower 1950; the 5K field is still set by the 5000-range forts.
- **A march carries its own food, and that caps how FAR a slow army can go** (the client's
  formula, already in `constants.js` — `capacityOf` / `marchFood` — and confirmed by the
  `travelinfo` run above, whose carry figures are exactly what it gives). Every troop carries `load × (1 + loadSkill/100)`
  and eats `food × 2` an hour, on the march and in camp, out of that same hold. For an
  army of ONE troop type the count cancels, so the range is fixed whatever its size:
  `load × (1 + loadSkill/100) / (food × 2)` hours. A **catapult** (load 75, food 250) holds
  150 and eats 500 an hour → **0.3 h = 18 minutes of marching**, whatever else is true.
  - **Attacking**, at 8m20s a tile, that is **2.16 tiles**; **reinforcing**, at 1m23s a
    tile, **12.96 tiles**. Past that the army cannot carry its own food and `travelinfo`'s
    carry figure goes negative (−4,004,614 in the run above, at 9.85 tiles).
  - **THE SERVER DOES NOT ENFORCE ANY OF THIS ON AN ATTACK** (live, 2026-09-25 07:08,
    Lord09). 10,000 catapults were sent from 698,121 to 699,111, **10.05 tiles** — five
    times the 2.16 the food arithmetic allows, with `travelinfo` reading
    **carrying 1,500,000 / −5,479,081 / 336,819** — and the server answered plain `ok`,
    army id 1930754, left 07:08:10.016, lands 08:31:54.016. **No transporters, no refusal.**
    So the carry figure is a *client march-window* rule, not a server one, and OTTObot
    (which only weighs food when the march carries resources — `script-cmd-deploy.js`,
    `if (carried > 0)`) sails straight past it. A catapult wave can be sent any distance.
    - **The army arrives whole — troops do NOT starve on a march** (the user, 2026-09-25).
      So for an attack, which carries no loot, the carry figure can be ignored outright.
    - **But the load IS real at long range** (the user, 2026-09-25): a *much* further march
      does get rejected without transporters. Where the server starts caring is not known,
      and it does not matter for the hub — nothing here is more than ~30 tiles apart, and
      10 tiles already sails through at five times the arithmetic’s limit. Worth pinning
      down only if we ever attack across the map.
  - **The real trap is not food, it is that the deploy log's march time can be WRONG**
    (found the same hour). The same send logged
    `attack 699,111 any cp:10k · march 7537.4s` — 750 s a tile, catapult speed 80, as if no
    Horseback Riding at all. `travelinfo` for the same city and target said **1h:23m:45**
    and the server landed it at **1h 23m 44s** (5024 s, 500 s a tile, speed 120). The log
    line is the odd one out: `script-cmd-deploy.js:687` passes
    `game.marchSkillParam` — the LOGIN's number, which reads **0** here — as the whole
    skills argument, so `marchTimeMs` uses it for the drive speed too. The right source is
    the city's own `army.getTroopParam`, which is what `travelinfo` and `timed-march.js`
    (`speedParams`) both use, and both are right. **Timed waves are unaffected.** Never
    plan off the untimed log line; use `travelinfo` or the march's own `reachTime`.
    *(Fixed 2026-09-27: the untimed line now uses the city's troop params, the Relief
    Station to our own tiles and the buffs — it had said 6 h 6 m for Lord24's cavalry
    3 → 5. Live from each console's restart.)*
  - **Transporters buy the range back** and never slow the wave (225 against the
    catapult's 120). Each holds 10,000 and eats only 20 an hour, so for N catapults over
    D tiles you need `T ≥ N × (69.44 D − 150) / (10000 − 2.78 D)`: about **5 per 1,000
    catapults at 2.8 tiles, 15 at 4.2, 27 at 6, 48 at 9**.
  - `travelinfo <x,y> cp:7500` prints it for a real city — the **"carrying
    total/attack/reinforce"** line, and a negative attack figure is a march that cannot
    feed itself. Run it before laying out anything that depends on catapult range.
- **A wave takes loyalty only when the ATTACKER WINS** (the user, 2026-09-25). A wave that
  loses takes none. This corrects the *unverified* note below: a farm defence that never
  falls costs the defending city **no loyalty at all**, so there is no comfort treadmill
  and no ceiling on waves per day from loyalty.
- **You cannot attack your own alliance** (the user, 2026-09-25). Anything built on
  attacking our own accounts — the amulet and XP farm above all — needs the defending
  account **outside** the attackers' alliance. It also settles the Relief Station
  question: an attack can never earn that speed off the target being ours, so only
  reinforcements and transports between our own cities get the ×6.
- **The attacking hero's quality does not matter while the defender's feasting hall is
  FULL** (the user, 2026-09-25): with no vacancy there is no capture (§5b), so any hero
  may lead a farm wave and comes home. **Never let a spot open in the defending city's
  feasting hall while a farm is running** — one vacancy and our own heroes start being
  taken.
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
- **The march buffs shorten the CAMP too — Fleet Feet above all** (2026-09-27, Lord24, seen
  live). `reinforce 5 none wo:9k,w:4k,c:48880,cata:1000 @:12:00:00` from city 3 (678,497)
  with **two Fleet Feet on** (−70%): the formula said 3,047 s of march, so 11,085 s of camp
  was asked for — and the server set `reachTime` **6,376 s** after the send, 2 h 09 m
  early. `0.3 × (10,157 s unbuffed march + 11,085 s camp) = 6,373 s`: the server applies
  the ReduceArmyActionBuff factor to march **and camp together**. The Relief Station is a
  speed and only speeds the march (fitting it to the camp as well gives 3,601 s, far off).
  So **a camp of C asked for is C × factor in the game; to camp C, ask C ÷ factor** — with
  two Fleet Feet, 16 h of camp needs 53 h 20 m asked. `constants.js armyTimeFactor` holds
  the factor; timed marches (`@:`), plain camps (`0:30:00`), `marchcheck` and the war-town
  hide march all use it since that day. *Unverified:* that the slower castle buff
  (IncArmyActionTimeBuff) and HarvesterWagesBuff scale the camp the same way (assumed), and
  whether the server caps a very long camp. The hide march was the dangerous one: planned
  to be away past the wave, it would have come home into it with Fleet Feet on.
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
    3, about 2,000+ each → 4. *Unverified:* the exact steps. **A wave that LOSES takes
    none** — loyalty only moves when the attacker wins (the user, 2026-09-25).
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
- **The sixteen states are a 4x4 grid of 200x200 tiles**, read row by row from (0,0):
  Friesland, Saxony, North March, Bohemia / Lower Lorraine, Franconia, Thuringia, Moravia
  / Upper Lorraine, Swabia, Bavaria, Carinthia / Burgundy, Lombardy, Tuscany, Romagna. So
  the state of any tile is `ZONES[floor(y/200)*4 + floor(x/200)]` (`constants.js zoneOf`)
  — (457,281) is Thuringia, which is what NEAT shows, and our hub (703,114) is Bohemia.
  The *names* are what is relied on; the ids `city.moveCastle` takes come live from
  `common.zoneInfo`. (Confirmed again 2026-09-24 while putting the state into the console's
  Map tab — the page works it out from the coordinates, the server is not asked.)
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
  Teleporter. We don't respect anyone's ownership of flats.
- **The NPC10 rule, and the user's 2026-09-27 exception.** The standing rule is: never
  war-teleport onto an NPC level 10 — those are CAPTURED for extra cities, and a teleport
  onto one spends a city you already have instead of gaining a new one. It is a value
  rule, not a limit of the game: the server accepts the teleport (settled 2026-09-27,
  below).
  **On 2026-09-27 the user lifted it for PACKING THE HUB**, twice and in their own words:
  *"I think you can start porting onto npc10s aswell because the hub seems to have a lot
  of gaps"*, then *"I want the hub packed compactly please, no gaps for another player to
  move in, so ignore the NPC10 rule, I want you to fill it so it has no gaps at all"*.
  The reason: every flat around the hub is already claimed, so **NPC camps are the only
  tiles an outsider could still take**, and closing the ring airtight to r<=12 needs 34
  camps of which **20 are level 10**. There is no airtight r<=12 that avoids them.
  **The exception is scoped to filling the hub, and it is not a general repeal.** Outside
  that job the rule stands, and only the user may lift it — in person, not through a
  relayed instruction. Anyone acting on this should have the price in front of them: each
  L10 taken this way is one extra city forgone.
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

### A flat's LEVEL is a day counter that wraps 10 -> 1. It says nothing about the tile (2026-09-27)

A flat's level climbs by **+1 every day at 07:19 UTC** and **wraps from 10 back to 1**.
Verified in `tile_levels` (keyed by `fieldId = y * 800 + x`) on five tiles at once —
707,129 · 703,132 · 704,132 · 713,124 · 711,127 — every one reading:

    09-18 npcL5 | 09-22 flatL6 | 09-23 flatL7 | 09-24 flatL8 | 09-25 flatL9 | 09-26 flatL10 | 09-27 flatL1

Two things follow, and the second is the trap:

1. **The level is not a terrain or usability marker.** It does not mark a valley, and it does
   not predict whether a teleport will land. Only occupancy does that, and occupancy is
   readable solely through `field.getOtherFieldInfo` (`scripts/teleport-probe.txt`) — nothing
   about it is stored offline.
2. **A level-1 flat is NOT a freshly freed one.** It is ten days old. This matters because a
   freed flat is only good for a few hours before it re-seeds as a Barbarian's city (above),
   so "L1" is exactly the tile someone would wrongly grab as fresh. **Never read freshness
   off the level; read it off `tile_levels`' own timestamps.**

Also visible in that trace: a destroyed NPC becomes a flat and **keeps the NPC's level**,
continuing to count from there (npcL5 -> flatL6), so the counter spans the tile's whole
history rather than restarting when it becomes a flat.

### The hub is ONE cluster, and its landable tiles are nearly all NPC camps (2026-09-27)

The working hub around y126-134 and EVONY-STRATEGY.md's strategic centre 704,119 are **the
same cluster**, not two: 238 fleet cities sit within 22 tiles of 704,119 (bbox x687-716,
y103-134), the density peaks at y119, and y126-134 is simply its southern expansion frontier.

**Inside r=8 of 704,119 there is not one flat and not one non-L10 NPC** — the core is
entirely ours plus foreign cities, which is why the strategy doc's plan is 14 internal swaps
and no captures. All the room is south and on the rim.

From a full 640,000-tile map sweep (2026-09-27 09:31-10:08 UTC), inside x693-715 / y126-134:

| | count |
|---|---|
| ours | 45 |
| **valley — permanently unusable** | **111 (69% of the gaps)** |
| NPC L10 (capture for an extra city, never teleport onto) | 24 |
| NPC L1-9 (a War Teleporter lands directly) | 10 |
| flats (terrain-landable, ownership UNKNOWN) | 15 |
| foreign player cities | 2 |

**So that box holds only ~25 landable tiles — 38 cities cannot fit in it.** A plan for 38 has
to reach to r≈15-16 of 704,119 or push south of y134. Within r=20 there are **93 NPC L1-9
camps**, which is ample.

**Prefer NPC camps over flats as teleport targets.** 11 of 13 war teleports onto NPC camps
landed first try (2026-09-22, confirmed by relog), whereas a probe of **51 flats** across
x670-735 / y90-150 on 2026-09-25 answered `ok=-84` on **every single one**, including tiles a
fresh scan had just called empty. Treat any flat list as a probe queue, never as a plan.

### The server accepts a War Teleporter onto an NPC level 10 (settled 2026-09-27)

Whether the server allows this was marked unverified for five days. It does. Observed live:
a26 Lord26's city 6 went `590,129 (North March) -> 697,124 (Bohemia)` onto a **level-10
Barbarian's city** at 12:37:50 SAST 2026-09-27; the reply was
`ok — 6 is now at 697,124, 355 War Teleporter left` (one item spent, from 356), and a **fresh
login** read the city at 697,124. No special reply code, no refusal — to `city.WarMoveCastle`
an L10 camp is just an NPC camp, and the camp is gone afterwards.

The earlier refusal at 694,122 that read "is an NPC camp (level 10)" was **our own console**
refusing locally, not the server: `teleport.js judge()` blocks an *Advanced* Teleporter on any
non-flat. It never said anything about War Teleporters.

**This does not change the standing rule "never war-teleport onto an NPC level 10."** That rule
is about value, not about what the server permits: an L10 camp is worth an extra city to
whoever captures it (§5e1, the `evony-npc10` skill), and landing on it destroys that. Only the
fleet owner, in person, can decide to spend L10 camps that way.

### What counts as a "gap" in the hub: valleys and claimed flats are not gaps (2026-09-27)

Of the non-city tiles, only some are holes an outsider can drop a city into:

| tile | can an outsider land a city on it? |
|---|---|
| valley (desert/forest/grassland/hill/lake/swamp) | **never** — permanently safe, do not try to fill |
| flat **already claimed by a player** | **no** — `ok=-84` while he holds it |
| flat nobody holds | yes, with an Advanced Teleporter |
| NPC camp, any level 1-10 | yes, with a War Teleporter |

A live `field.getOtherFieldInfo` probe of every landable tile within r=12 of 704,119
(2026-09-27 12:35 SAST, the `scripts/teleport-probe.txt` idiom, 57 tiles) found **not one free
flat**: all 22 flats in that radius are held — JackylBlue and Karnage (**We3Kings, our own
alliance**), Phrac (0utCasts), KingCool (GANG), Lord18016314 (1513). Every NPC camp read back
`npc=true canOccupy=true` and unowned. So around this hub a teleport plan is a
**War-Teleporter-only** plan; a flat becomes a target only after somebody captures and abandons
it (§5e flats rule), and it re-seeds as a camp within hours.

Counted by Chebyshev ring from 704,119 (sweep 2026-09-27 10:08 UTC): **r<=6 holds zero landable
tiles at all** — that core is already airtight. NPC camps by ring: 3 at r7, 2 at r8, 5 at r9,
3 at r10, 9 at r11, 12 at r12, 25 at r13. So 22 cities would close the hub out to r=11 and 34
out to r=12. That ring count is the honest measure of "no gaps", not a tile count inside a box.

### A new account's own transports pin its cities for hours (2026-09-27)

a26-a31 had each sent a mission-1 transport to the hub (703,111 / 702,111) from nearly every
city *before* the move began. A homebound transport **cannot be recalled** (§5e), so `recallall`
answered `ok` and the city still could not teleport: 21 of 30 cities were blocked, landing
**1 to 3.8 hours** out (worst: a27 city 4, 257,547 -> 703,111, 13,582 s). Only 9 of 30 could
move at once. **Read the `city.selfArmies` reach stamps before promising a fleet move a time**
(`scripts/army-list.txt`), and ship resources to the hub *after* the cities move, not before.

**`ok=-77` outlives the reach stamp — keep retrying, don't reschedule.** a29 city 2's transport
was due home at 14:54; the city still answered -77 at 15:53 and 15:54 and only went through at
15:55:09, by which time `city.selfArmies` read 0. So the stamp is a lower bound, not a
deadline, and the honest test remains "try it again in a minute". Nothing is lost by trying:
the move logged **1,645 `ok=-77` refusals and not one other refusal code** — no -84, -81 or
-90 anywhere — and the War Teleporter stock proves every refusal was free. Each account's
final count is its start minus exactly one per city moved: a26 356->351 (5), a27 278->271 (7),
a28 264->260 (4), a29 319->314 (5), a30 289->281 (8), a31 249->240 (9). So **a refused teleport
spends nothing, confirmed by arithmetic over 1,757 of them**, and a one-try-a-minute loop is the
right tool: **38 of 38 cities landed, 0 failed, 0 retargeted**, every one verified by relog.

**The outcome, for reference: every NPC camp of level 1-9 within r=12 of 704,119 is now ours.**
a26-a31's 38 cities took them all. What is left open inside r=12 is 19 level-10 camps and
nothing else — the 23 flats there are all held by other players (blocked, not open), and the
328 valleys can never be built on. Closing those last 19 is a capture job (`evony-npc10`),
which fills the tile *and* gains a city, rather than a teleport job, which fills it and spends
one. The move took ~8 hours wall-clock for 30 cities because of the transport pinning above,
and 11 minutes for the last 8 once their marches were home.

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
  - **`recall <x,y>` used to recall EVERY city's armies on that tile** — the whole
    account's, not the running city's. A script run in all cities therefore recalled the
    same marches once per city, and one city's stop pulled back the others' hits
    (`ally-drain.txt` carried a warning never to put a bare `recall <x,y>` in a one-off;
    on 2026-09-22 a console restart re-ran one and all the hits on 679,135 were pulled
    back twice, 18:06 and 18:14). Fixed in code 2026-09-23 at the user's instruction:
    `recall x,y` now recalls only the armies that left the city the line is running in,
    like `recallall` always has, and `recall x,y all` is the explicit fleet-wide form.
    The same per-city scope now applies inside `capture` / `loyaltyattack` (a wave lost,
    or loyalty reaching the floor, recalls that city's attacks only) and to `setguard`
    (it watches only its own city's attacks). `idrecall <id>` is unchanged — one named army.

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

### Private chat (whispers) (2026-09-27, tested Lord25 → Lord24)
- `common.privateChat {targetName, msg}` reaches a player by name alone: they need not
  have spoken since the bot logged in, nor be anywhere on screen. The console's chat box
  takes `/Name message` for this (and `/Name` alone just picks who to whisper).
- The server echoes a whisper back to the SENDER as `server.PrivateChatMessage` with
  `from` = the sender's own name, so the sender's Private tab shows its own line but not
  who it went to. The receiver gets the same line. Confirmed again 2026-09-27 when the
  user sent `/Chipp Hey` from Lord24 and it showed as "[Lord24]: Hey". The console now
  remembers each whisper it sends (`session.whisperTo`, matched by text within a minute)
  and the page shows "To Chipp" / "From Chipp".
- The console swallows the request's reply (`sendChat` … `.catch(() => ({ok:1}))`), so a
  misspelt name still shows "sent"; whether the server answers a bad name with an error
  code is *unverified*.

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

- **There is no free tile to teleport a city onto near the hub, and `ok=-84` is what says
  so** (2026-09-25, 51 tiles probed). Moving Lord23's cities in, every single candidate
  answered `ok=-84 "Unable to teleport city to a preoccupied valley."` — 51 distinct Flats
  across 670-735 x 90-150, including the level-1s, and including tiles the console's own
  fresh scan had just called *"an empty flat (level 4)"* a line earlier. **A local scan
  saying "empty flat" does not mean landable.**
  - The cause is in `db.js`: *unowned flats and valleys gain +1 level at each daily
    maintenance*. **The cached map holds ZERO tiles at level 0** — out of 640,000 — and
    every Flat is L1..L10. A levelled flat is a VALLEY, and a city cannot be placed on one.
  - So a landable tile exists only in the window between a city leaving a tile and the next
    daily maintenance levelling it. **That is why `evony-city-swap` works the way it does**:
    the taker hammers `teleport <tile>` while the holder is still standing on it and lands
    within seconds of it being freed. It is not merely about keeping strangers out — it is
    the only way to get a tile at level 0 at all.
  - **Consequence for bringing a new account into the hub:** its cities cannot simply be
    teleported in. Each one needs a tile freed for it by one of ours moving out (a swap), or
    a captured NPC/conquest. Plan the pairs before starting; do not burn map scans probing.
  - Probing is otherwise safe — a refused teleport sends nothing and spends no item; the
    cost is one map scan each, and the count in the log ("259 held") never moved.

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
- **A castle's `state` on the map is the only honest read of a STRANGER's protection**
  (read from the client on 2026-09-23, `CityConstants` + `PlayerInfoTypeManager.getState`,
  for the Monitor). Every castle in a `common.mapInfoSimple` reply carries it:

  | `state` | client constant | the game's word | what it means |
  |---|---|---|---|
  | 1 | `CASTLE_NOMAL_STATE` | 和平 | peace — no protection |
  | 2 | `CASTLE_ANTI_BATTLE_STATE` | 免战 | truce (a Truce Agreement) |
  | 3 | `CASTLE_FRESH_MAN_STATE` | 新手 | beginner protection |
  | 5 | `CASTLE_VACATION_STATE` | 休假 | **holiday** |
  | 6 | `CASTLE_DREAM_TRUCE_STATE` | 时间段休战 | dream truce (the timed one) |

  There is no 4. `script-functions.js` already had the same table under NEAT's names
  (`PlayerState`: peace, truce, beginner, holiday, dream), and `monitor.js` repeats it.
  For a stranger it is the **only** read available, and it is much better than the
  `furlough` flag, which read `false` for all four of our own banks while every one of
  them was on holiday (§4).
- **But one map reading is NOT proof — it disagreed with the game itself (2026-09-23).**
  Ten minutes after maintenance, a sweep read **Lord03 and Lord16 as `state 1` (peace)
  while both accounts' own live `FurloughBuff` said holiday with 23h21m left** and still
  counting down. A forced fresh re-read of their blocks said `1` again, so it was not a
  stale cache. It is **not** viewer-relative either: read through Lord02's console in
  the same sweep, our own alliance-mates Lord04, Lord05, Lord10, Lord11, Lord12,
  points and Lord14 all showed `state 5` correctly. **Cause unverified** — the two
  had both been read as `5` in the sweeps before maintenance, so the suspicion is that a
  castle's state comes back wrong for a while after a maintenance, or that the vacation
  shield and the furlough buff are genuinely two different things. *Until it is
  understood:* treat a single state reading as a rumour. `monitor.js` now believes a state
  only when **two sweeps in a row agree**, which is what stops it announcing a holiday
  ending that has not happened. Where we own the account, the console's live
  `protection` (the 2-minute buff watch) beats the map.
- *Unverified:* whether a map castle's `prestige` is the LORD's prestige or
  that castle's (the Monitor stores the highest across a lord's cities and says so), and
  whether the second hex digit of a player castle's terrain byte is its city level the way
  it is an NPC camp's.
- **The map is live; the rankings are not.** The Statistics window is recomputed server
  side roughly every 15 minutes (the user, 2026-09-23), so a lord's prestige there lags,
  while the same lord's castles on the map answer with what is true now. Anything that has
  to notice a change quickly — a holiday ending, a bot stopping — reads the MAP; the
  rankings are for the shape of the server (who is biggest, whose heroes). Reading the
  rankings more often than every 15 minutes buys nothing and costs ~250 pages.
- **`common.getPlayerInfoByName {userName}`** answers a whole `PlayerInfoBean`: `prestige`,
  `castleCount`, `ranking`, `population`, `honor`, `alliance`, `titleId`, `office`,
  `medal`, `levelId` and — the useful one — **`lastLoginTime`** (read from the client
  2026-09-23; `server.js runScan` has sent it live since 2026-09-12). It carries no state
  or furlough field, which is why holiday has to come off the map. One request a name.
- **A whole-world map sweep is 1,600 blocks** (800x800, the server answers at most 20x20 and
  the client asks on a grid aligned to 20). The console pipelines them nine at a time
  (`Session.MAP_BATCH`) and keeps each block for 30 minutes, so a sweep that does not throw
  its blocks away again leaves half an hour of the world in that console's heap — the
  Monitor's `/api/mapsweep` passes `drop` for exactly that reason (§7, the consoles that
  ran out of memory).
- **Measured live, 2026-09-23 through Lord02's console** (the Monitor's first two
  sweeps, 45 blocks a request with a 300 ms pause): a whole-world sweep takes **118 s and
  107 s** — about **two minutes**, comfortably inside a 10-minute period. ss71 held
  **13,549 player cities across 2,501 lords**, of whom **165 were on holiday** (state 5),
  2 truced, 1 in beginner protection. The account was trading nothing at the time and
  showed no sign of being throttled by it. *Still unverified:* whether sweeping every
  10 minutes for hours adds to the account's rate limiting — watch the console log for
  "ignoring this account".
- **Map prestige IS live, and it is the signal for "is that bot still running".** Between
  two sweeps five minutes apart, **641 of 2,501 lords (26%) moved prestige** and the rest
  did not (2026-09-23). So a lord whose prestige has not moved for tens of minutes really
  has stopped, and the ranked lists' 15-minute lag is not in the way.
- **Beware the top few: prestige is an int32 and the biggest accounts are at its ceiling.**
  The highest on ss71 read **2,146,178,357 against a 2,147,483,647 maximum — 99.94% of it**
  (2026-09-23); 4 lords are within 1% of the cap and 13 within 5%. Their prestige has
  nowhere left to go, so **"prestige is not moving" says nothing about the very top
  accounts** — exactly the ones a "top 10" watch list picks. For those, use the watch
  pass's `lastLoginTime`, or their city count and honor, instead.
- **A full sweep fills the shared map cache with the whole world, once.** The first one
  took `evony.db` from 51 MB to 248 MB (640,000 `map_cache` rows, 655,816 `tile_levels`
  rows). The **second sweep added nothing** — 0 new `tile_levels` rows, the same 248 MB —
  so this is a one-off cost, not growth per sweep, and NPC farming and the valley goals
  get the whole world for free out of it.
- **Do not sweep through an account that is in a trading play — and if you must, make the
  sweep yield.** On 2026-09-23 the Monitor was pointed at Lord02, which was at the same
  time running the glitch play (`sell stone 99999999 150 x10` out of eight cities). A
  whole-world sweep is ~1,600 reads on the same socket those orders go out on, and rate
  limiting is per ACCOUNT (§3), so the two compete for the account's budget. `mapSweep`
  now waits while more than 10 of the account's own writes are in flight (up to 20 s a
  request), the way the statistics crawl already did. **Prefer a monitor account that is
  not trading and not being watched for throughput.**
- **The Monitor stands down with its console, and that is the point of driving one.**
  On 2026-09-23 maintenance was announced 08:51, Lord02's console stood down 08:54, and
  the Monitor simply reported *"waiting for the console — Lord02's console is not
  logged in"* every 30 s until it came back. It never logs in, so it cannot log in during
  maintenance (§2) and cannot kick anything.
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
- **An attack under the city's `/junktroop` is not an attack — for the warnings too** (the
  user, 2026-09-28: "if junktroop is 1000 and 999 troops are incoming, no animation nothing
  should display … junktroop applies per attack"). Until then the red city tab, the
  flashing Incoming icon and the Director's "under attack" lit up for ANY hostile army,
  because they read the server's `castle.hasEnemy`, which the game sets for a 1-troop scout
  as well. The rule now lives once in `attacks.js`: per army, at or above the city's
  `defensepolicy /junktroop` (1000 when unset, `/junktroop:0` = everything), size unknown
  counting as real. The Claude waker uses the same rule. Consoles show it after a restart.
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

- **The glitch log: a record either side of every maintenance** (2026-09-23, the user's
  ask — glitch-log.js, the Trading tab's **Glitch log** view, filtered by date). It is the
  pairing the hourly and 08:30 records could never give: for each maintenance, what every
  town of every account held going **in** and what it held coming **out**, the difference
  per resource, the trading runs of that day, and which side of the play each account was
  on at the time. Where it sits in the record:
  - **before** — taken at the fleet's stand-down (maint.js `pauseAt`, 5 minutes before the
    announced start). **after** — taken once every console has published a snapshot from
    after the server came back, or 20 minutes on if some never do.
  - Both are filed in `city_resources` under `kind = 'maint:<day>:before' | ':after'`, so
    they never mix with the hourly rows and `restoreReport` sees them too.
  - Who each account was — its lord, its holiday badge, its side of the play — is stored
    **with** the record, because none of it can be recovered later: a holiday ends and a
    run stops, and the log would then call a bank an ordinary account.
  - The runs are archived per run id (`glitch_runs`) on every save. The settings keep only
    the *current* run, so before this a finished run was gone the moment the next started.
  - No announcement was heard that day: the record still happens, hung on the assumed
    08:30 window and marked `assumed` on the page.

- **The before-record relogs the whole fleet first** (2026-09-23, the user's choice). A
  console's cached figures go stale on a busy account and only a relog refreshes them
  (§3), so without it the "before" figures can be an hour old — which is exactly the
  account being traded hardest. **It is not free: a refresh ends every city's autorun
  script and nothing puts it back (§4), and it spends a login each.** So it is fenced in:
  - only on a window that was actually **announced** — never on the assumed 08:30 one,
    because a relog fired on a guessed time can land inside a real maintenance, and that
    holds the account back ~30 minutes (§2);
  - once per maintenance, at `leadMin` before the announced start (default 10, floor 6),
    and never inside the stand-down — `SESSION.connect()` refuses there anyway;
  - a console will not relog twice inside 15 minutes (server.js `REFRESH_GAP_MS`);
  - the page marks each town **live** or **cached**, so a figure is never passed off as
    the server's when the relog failed or landed after the record was taken.
  It runs over the console route `POST /api/snapshot/refresh`, which is the **one**
  bot-driving route the machine token may call (auth.js `INTERNAL_OK`) — it takes no
  arguments, relogs, and hands back the snapshot, which the Director files at once rather
  than waiting for its next uptime sweep. Switch the relog off in the tab and the record
  still happens, from whatever the consoles had cached.
  *Unverified as of 2026-09-23: none of this has run against a real maintenance yet, and
  the Director must be restarted before any of it exists.*

### Starting the fleet after a reboot (2026-09-24)

**Nothing used to start OTTObot when the machine booted** — no scheduled task, nothing in
the Startup folder, nothing in either Run key. A reboot left the Director and all 21
consoles down until somebody noticed.

There is now a logon task, **"OTTObot Director"**, installed by `install-startup.ps1`
(`-Remove` takes it away; no admin rights, it is a per-user logon task). It runs
**`node director-keep.js`**, not `director.js` — the supervisor, so the Director is watched
from the first second. The Director's own keep-on watchdog then starts a console for every
account marked "keep on", which is how the fleet comes back without 21 logins at once.

- **Laptop settings matter and are easy to miss:** the task is registered with
  `AllowStartIfOnBatteries`, `DontStopIfGoingOnBatteries` and no execution time limit.
  Windows defaults every one of those the wrong way for a machine that runs a fleet.
- **Only one supervisor may ever run.** Two would each spawn a Director, the second would
  fail to bind 8712, the first would read that as a crash and relaunch it for ever, and
  both would be starting consoles. `director-keep.js` holds `director-keep.pid` and leaves
  if the pid in it is alive; a stale lock from a killed supervisor is taken over.
  Windows will not double-start the task itself, but a hand-started one beside it would.
- To hand over from a hand-started supervisor to the task: stop the supervisor, delete
  `director-keep.pid`, stop whatever is on 8712, then `Start-ScheduledTask -TaskName
  "OTTObot Director"`. Verified live 2026-09-24 23:46.

### "Turn off" on the Director page leaves nothing to turn it back on with (2026-09-25)

The switch top-right writes `director-stop.flag` and then **exits the process that serves
the page**, and `director-keep.js` deliberately leaves it down while the flag is there. So
the moment it goes off, the page is gone — and the Turn on half of the switch is on that
page. There is no way back through the browser.

**The way back is the flag**: delete `C:\EvonyTool\director-stop.flag` and the supervisor
relaunches the Director within a few seconds (verified 2026-09-25: off at 06:38:13, flag
removed, up again at 06:38:58 on its own).

So: **never use Turn off as a restart.** To pick up new `director.js` or `monitor.js` code,
stop the process and let the supervisor bring it straight back — no flag, no gap you need a
shell to climb out of. Turn off is for putting the Director away on purpose, and whoever
uses it needs shell access to undo it.

### The Director died of a locked database and nobody noticed for 50 minutes (2026-09-24)

At 21:26, with 21 consoles restarting into a 20.7MB WAL checkpoint, an uptime write waited
out its 5-second `busy_timeout` and threw `database is locked` inside `sampleUptime`. The
Director exited. **It had no `unhandledRejection` / `uncaughtException` guard** — every
console has had one since the beginning (`server.js`) — so an ordinary transient error took
the whole control plane down: no live sweep, no goal-file sync, no Trading tab, no
fleet-wide maintenance signal.

**It failed silently, which is the worse half.** The Fleet page kept rendering; every row
just fell back from `online` / `holiday` / `under attack` to **`reporting`** or **`stale`**,
because all the rich statuses come from `a.live`, which only `sampleUptime` refreshes and
`statusPillFor` ignores once it is more than five minutes old. That is the tell:
**a whole fleet showing nothing but "reporting" and "stale" means the Director is dead**,
not that the accounts are. Check `director.err.log` and whether anything is listening on
8712 before looking at the accounts at all.

Both halves are fixed:

- `director.js` now carries the same crash guard the consoles have — the error is logged
  loudly and the Director lives on.
- **`director-keep.js` relaunches it whenever it stops**, with a wait that grows only while
  it keeps crashing (2s, 5s, 15s … 2 min) and resets once it has been up five minutes.
  Start it with `node director-keep.js`; it is what should be started at boot from now on,
  not `director.js`. Proved live: killing the Director brought it back in two seconds.
- **The only thing that keeps it down is the stop file**, `director-stop.flag`, written by
  the Turn off button on the Director page (its own themed confirm, never the browser box)
  via `/api/director/stop`. Deleting the file brings it back within five seconds. It is a
  FILE on purpose: the database is the likeliest thing to be broken when the Director dies,
  and a supervisor that cannot read its own switch is no supervisor.
  Tests: `test-director-keep.js`.

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

### Where a goal really comes from: the FILE, then the row (2026-09-23)

Three layers, and only the top one is the source:

1. **The goal file.** An account may name a `.txt` for its Prepend or Append text
   (Director ✎; org setting `goalFile:prepend:<id>`). `goalfiles.js` reads it **every 15
   seconds** and copies it over the saved text whenever the two differ. The comment in
   that file says it plainly: *"The file is the source: a save in the console's editor is
   put back from the file on the next check."*
2. **The `goals` table in `evony.db`** — `prepend`/`append` per account, plus per-city rows
   keyed by castle id. This is what the engine reads, every tick, with no cache.
3. **`prepend-goals.txt` in the repo is neither.** Nothing reads it. It is a draft.

**A write to the database for an account that names a file is silently undone.** Measured
2026-09-23: 21 prepend rows were written at 05:21:04 UTC and **16 of them were put back at
05:21:10** — six seconds later — by the Director's sync. The 5 that survived (a5, a6, a7,
a14, a16) are the only ones with no `goalFile:prepend` setting. The write *reported
success*; only re-reading the rows showed it gone. **Always check which accounts name a
file before editing goals, and edit the file for those.**

**An account with no `goalFile` keeps whatever copy of the prepend it was last given, and
looks fine.** 2026-09-24, on the user asking "did you remove the goals?": Lord07 (a7)
and Lord16 (a16) had a full prepend in the goals table and were nevertheless out of date —
3,919 characters from 2026-09-23 07:21 against the file's 4,021, missing `build b:0:1`,
five `fortification ab:` lines and the newer `troop r:300k,…` (they still had `r:500k`).
Nothing had deleted anything; they were simply never pointed at the file. **Auditing the
goals table alone will not find this — compare each account's `goalFile:prepend:<id>`,
and the LENGTH of its row against the file's.** Setting the setting is enough: the
Director pushed the file to both within 15 seconds, no restart.

The eight holiday banks are a separate case and are deliberately NOT on the file: five
(Lord04, Lord10, Lord11, Lord12, Lord13) are stripped to a 94-character stub by the
holiday prep so nothing queues, and three (Lord05, Lord06, Lord14) still carry the
older copy. Pushing the prepend onto a bank starts it building and training out of the
very resources the glitch is there to move, and queues work that can block a later
holiday — so it is the user's call, not a gap to fix.

As of 2026-09-23 sixteen accounts (a1–a4, a8–a13, a15, a17–a21) all point at the same
file, `goals-backup-a15-prepend-2026-09-20.txt`, so one edit moves all sixteen. a22 is
switched off and has no prepend row. `add-demolish-line.js` does this properly and is the
model to copy: file first, rows only for the accounts with no file.

### A build line that demolishes: the third number, and the line's place (2026-09-23)

Both learned adding the "research is done, tear the four down" line fleet-wide.

- **`x:0` does not demolish — `x:0:0` does.** A build target is `type:level[:quantity]`
  and a missing quantity reads as **1** (goals.js: "1 is the reading that can never
  demolish anything"). So `fo:0` means *at most one Forge*, which a city with one Forge
  already meets. Only the third `:0` means none at all. Offline proof: `?ho:10,ar:10?fo:0,
  ws:0,st:0` plans `all build targets met`; the same line with `:0:0` plans three
  demolitions.
- **Where the line sits decides whether it ever runs.** Build lines are worked **in
  order** — the first line not yet met takes the builder, and later lines are only ranked
  below it. Put at the *end* of the fleet prepend the demolition line sat behind
  `build f:10:37`, which no developed city can ever meet (all 40 field plots in use), so
  the demolitions were planned and never placed. Inserted **before** the first build line
  it is worked at once, and once the four are gone it is met and hands the builder on.
- The condition's codes are the research codes, not free text: `ho`, not `hbr` (an unknown
  code throws the **whole line** out). Inside `?…?` **`st` is the Stable**, so Stockpile
  must be written `sp:10` there.
- Fleet-wide as of 2026-09-23 07:25, on all 21 switched-on accounts:
  `build ?ag:10,…,pr:10?st:0:0,fo:0:0,ws:0:0,wh:0:0` as build line 1 of 6. The gate is not
  really a gate — every account already has all 19 researches at 10 (a6's two cities were
  one short, Stockpile L9) — so it fires immediately. **The warehouses are included at the
  user's word**, giving up the resources a warehouse protects from a raid.

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

### Three ways a new Director feature dies quietly (2026-09-23, the Monitor going live)

All three looked like "it started fine" and then did nothing. Watch for them in anything
new that talks to a console or spawns a process:

- **A new console route needs adding to `auth.js` INTERNAL_OK.** Consoles are behind the
  same login as everything else, and a background process has no browser session — it
  sends `x-otto-internal`. `guard()` accepts that token for a *named* few read-only routes
  only. A route left off the list answers **401**, which the caller reports as something
  else entirely ("is it running this build?"). The Monitor needed `/api/mapsweep`,
  `/api/players`, `/api/stats` and `/api/stats/refresh`; the first sweep failed because
  only two of the four were listed.
- **`D.org(id)` hands back a handle that names itself `orgId`, not `id`.** Reading
  `org.id` gives `undefined`, and a process spawned with `--org undefined` reads an empty
  organization's settings: it is alive, it logs its startup line, and it never does any
  work. The Director did exactly this for ten minutes. If a background process is up and
  idle, check its **command line** before anything else.
- **The database is shared by twenty-odd writers and gives up after 5 seconds.**
  `PRAGMA busy_timeout = 5000` (db.js) and every console, the Director and the Monitor
  write to the same `evony.db`. A big transaction — the Monitor's sweep writing 18,000
  map tiles at once — loses that race and throws **"database is locked"**, failing whatever
  contained it. Write in small transactions (the sweep uses 2,000 tiles), retry, and treat
  a cache write that fails as a lost bonus rather than a failed job.

### A page can show an old setting: the Director is the code it STARTED with (2026-09-24)

The Monitor's "watch the top N heroes" was set to 1000 and the page kept showing 50 after
every save. Nothing was resetting it: `evony.db` held 1000 the whole time, and the Monitor
process duly watched **481 lords** on its next pass (the top 1000 heroes belong to 481
lords on ss71; the top 50 belong to 36 — that 36 was the giveaway). The Director process
had been up since 2026-09-23 08:54 and so was still running *that hour's* `monitor.js`,
which capped the setting lower — while serving *today's* `director.html`.

- **`public/*.html` is read from disk on every request; the `.js` is loaded once, at
  start.** A browser can show a brand-new page in front of a two-day-old API. Any "the UI
  ignores my change" starts with `Get-CimInstance Win32_Process -Filter "Name='node.exe'"`
  (CreationDate) against the file's mtime.
- **Believe the database, not the page**: read the row (`settings` where `k='monitor'`) and
  look at what the worker actually did (`mon_sweep.asked`).
- The value was stored raw but clamped on the way out, so the two could disagree at all.
  Fixed in `monitor.js` 2026-09-24: `normalize()` runs on the way in and on the way out.

### A console restart can take away a route the Monitor needs (2026-09-24)

`server.js` on disk has **no `/api/mapsweep` and no `/api/players`** any more, though
`auth.js` still lists them in INTERNAL_OK and `monitor.js` still calls them. While a2's
console kept the process it had started with, the Monitor read fine (19:10: 36 of 36
lords). The console restarted onto the newer `server.js` and from 19:25 every pass
answered *"the console answered 404 with something that is not JSON"* — 0/1,600 map blocks,
0 of 481 lords. The Monitor has been blind since, and will stay blind on every console
started from this build until the two routes are put back.

A route that a background process needs is **not** proved by "it worked yesterday": it is
proved by the console process that is running now having been started from a build that
has it.

**Put back 2026-09-25.** `git log -S` says neither route was ever committed at all: they
only ever existed in a working copy, and the console that read the map fine had been
started from it. `session.js` had both implementations the whole time — `mapSweep()` and
`playerInfo()`, fully written, with their comments about yielding to the account's own
traffic — and `auth.js` had both on INTERNAL_OK. The only thing missing in `server.js`
was the six lines that call them. Both are now in `server.js`, POST and internal-token
only. **Verified live the same morning**: a2's console was restarted at 05:58 and the very
next passes read 1,600 of 1,600 map blocks (13,554 castles, 2,501 lords) and 481 of 481
watched lords with 151 changes — against 0 and 0 twenty minutes earlier. The other twenty
consoles still run the old build and will pick the routes up when they next restart.

**A third route was missing with them: `/api/snapshot/refresh`.** That is the glitch
log's pre-maintenance relog (`director.js glitchRelog`), so the "before" record of an
announced maintenance has *never* been taken from a fresh login — every console answered
the sign-in guard instead, which the Director reports as *"this console is older than the
glitch log — restart it"*. Written 2026-09-25 with the fences `auth.js` already promised:
no arguments, never during a stand-down, and never a second relog inside `REFRESH_GAP_MS`
(20 minutes), so a Director that retries cannot spend an account's logins.

**How this class of bug is caught now.** `test-monitor.js` stubbed the console, so it
answered every route the Monitor asked for and could never notice a real console had none
of them. Two tests were added there that read `auth.js` and `server.js` themselves: every
path in INTERNAL_OK must have a route in `server.js`, and the Monitor's two must be a
POST, internal-token only, and must not `connect()`. The first of them is what found
`/api/snapshot/refresh`. **A stub that always answers proves nothing about the thing it is
standing in for** — test the contract between the two files, not the stub.

- **A failed poll writes a snapshot row with NO `totals`, and anything reading
  `snapshot.totals[res]` blind will die on it** (2026-09-25). The user moved the machine to a
  different network and re-did the IPs at about 18:04; polls came back without totals while
  the proxies re-established, and `trade-advance.js` threw
  `Cannot read properties of undefined (reading 'food')` on **every 20-minute run for the
  next two hours** with the play sitting stopped. Nothing was lost — the banks' resources
  reset at maintenance — but four passes' worth of time was. Guard every `totals` read;
  skipping one stale account is far better than no scheduler.
  - The same window is worth remembering generally: **a network or IP change stalls the
    whole fleet**, and the trade-monitor's ladder shows it as "nothing traded HH:MM-HH:MM".
    The consoles do reconnect on their own; the Trading tab refuses a start while any
    account in the play is still `connecting`/`offline`, which is correct — wait and retry
    rather than forcing it.

- **TWO CONSOLES ON ONE ACCOUNT look exactly like a person logging in** (2026-09-26). Four
  accounts — Lord02, Lord03, Lord19, Lord20 — sat permanently "kicked", each
  logging the game's own words: *"ANOTHER USER HAS LOGGED INTO THIS ACCOUNT — that is the
  game kicking us out, not a network fault"*, then *"another user took this account while we
  were logging in"*. There was no person: **each had two console processes**, and they
  kicked each other for ever. Every other account had exactly one console and was connected.
  - **How to see it:** map every listening console port to the account it holds (ask each
    `:87xx/api/session` who its `account` is) and look for an account on two ports. Here:
    Lord02 on 8729 **and** 8757, Lord03 8731/8759, Lord19 8713/8717, Lord20
    8747/8761 — 26 consoles listening for 22 accounts. A raw process count is the first
    hint (43 node processes where ~24 were expected).
  - **`botctl` cannot clear it.** `stopNow` kills only the console it REMEMBERS, and
    `running()` walks the **probe list** — which holds one URL per account, so an untracked
    orphan is invisible to it. Stopping the tracked console therefore just spawns a fresh
    one beside the orphan and the war continues. The orphan process has to be ended.
  - **Suspect it whenever an account is kicked again within a minute of every retry**, and
    especially after a spell of restarts, a crash or a Director relaunch.
  - Lowering `kickHoldMin` makes this WORSE, not better: at 1 minute the two consoles fight
    every minute and the ladder climbs (1, 2, 3 … min) until they are both locked out.

- **Duplicate consoles COME BACK after every Director restart — re-check, don't assume.**
  Four were cleared at 15:0x on 2026-09-26; by 15:56 a new one had appeared (Lord05 on
  8713 beside its tracked 8737) because the Director restarted at 15:42 and its `bots`
  record went with it, so keep-on started a console for an account that already had one.
  **After any Director restart, re-map the ports** (ask each `:87xx/api/session` who it
  holds) and end the one the probe list does NOT name. Ports also shift between checks, so
  re-map immediately before ending anything — on 2026-09-26 the four orphan ports had all
  moved between the first look and the kill.
- **"It doesn't open" — a bot tab was stuck on a dead port** (the user, 2026-09-26,
  Lord19). `openBotTab` in director.html only navigated the named tab when it could
  READ its location and found it blank; a console is on another PORT, so reading it throws
  (cross-origin), `blank` stayed false and the tab was never re-pointed. Once a bot tab
  existed it kept whatever port it first got, and after a console restart moved the port,
  clicking the account only focused a dead tab. Writing another window's `location` IS
  allowed cross-origin, so it is now set unconditionally. director.html is read from disk
  per request — a page refresh is enough, no Director restart.

## 8. The Director's own failures (2026-09-25)

- **An account with NO proxy crashed `/api/accounts` on every call.** `director.js` counted
  proxy use with `for (const [, p] of assign) counts[p.label] = …`; an account that has no
  proxy has no entry, so `p` is null and it threw. Lord23 was switched on that morning to
  join the fleet, running direct at the user's choice, and the Accounts tab broke instantly.
  The crash guard caught each one ("the Director kept running") so it never showed up as an
  outage — only as a repeating UNHANDLED REJECTION in `director.err.log`. Guarded with
  `if (p && p.label)`. **Read `director.err.log` when anything looks odd; a guarded crash is
  silent by design.**
- **The supervisor itself can die, and a logon-only task cannot recover from it.**
  `director-keep.log` for 2026-09-25 shows the supervisor relaunching the Director correctly
  through the morning (06:17, 06:23), honouring a hand turn-off at 06:38:13 and restarting it
  at 06:38:58 when the flag cleared — then **nothing at all** until it was started by hand at
  12:44. It had died silently while the Director it spawned kept running, so when the Director
  died at about 12:11 nothing relaunched it and the fleet sat idle for half an hour with the
  trading play frozen.
  - **Fix: the "OTTObot Director" task now REPEATS every 10 minutes for ever** as well as
    firing at logon (`install-startup.ps1`). `director-keep.js` holds a single-instance pid
    lock, so a repeat that fires while a healthy supervisor is up just logs
    `another supervisor is already running (pid N) — leaving it to that one` and exits.
    Verified live 2026-09-25 12:46.
  - In PowerShell an indefinite repetition is `$rep.Duration = ''`;
    `[TimeSpan]::MaxValue` is rejected by the task XML, and `Set-ScheduledTask` on the
    running task answers **Access is denied** — re-register through `install-startup.ps1`
    instead.
  - **A Director that is up is not the same as a Director that is watched.** Check
    `director-keep.pid` names a LIVE process, not just that :8712 answers.

## Keeping this file true

When you learn something about how the game behaves — by watching it, not by guessing —
add it to the right section with the date and how it was observed. Mark anything inferred
as *unverified*. When an entry turns out to be wrong, fix it or delete it; don't leave a
contradiction for the next session. Keep it about the game and about operating it safely;
how the code works belongs in MANUAL.md and SCRIPTS.md.
