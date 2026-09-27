# OTTObot — manual

Multi-tenant fleet control for Evony Age 1. A dependency-free Node client replacing
NEAT — Flash was never needed, the game speaks a plain socket protocol.

Sign up, get your own organization, and run your bots. Nobody else can see them.

Three apps and a goal engine:

| | | |
|---|---|---|
| `server.js` | **console**, one per account | per-city goals and scripts, monitors, map, chat |
| `director.js` | **fleet view** over every account | status, resources, items, proxies, uptime graph |
| `goalsd.js` | headless goal daemon | an alternative to running a console |
| `monitor.js` | **monitor**, one per server | the whole map, the rankings, and who has stopped playing |

Everything is headless. The HTML pages are viewers that poll the process — close every
tab and the bots keep running.

## Running it

```bash
cp .env.example .env          # the default console's login
node director.js              # fleet + uptime            -> :8712
CONSOLE_PORT=8711 ACCOUNT_ID=a1 node server.js            -> :8711
CONSOLE_PORT=8713 ACCOUNT_ID=a2 node server.js
```

**The console's engine is always live** — from the moment it connects it acts on every
city's goals, once a minute. The pause button is how you stop it; a restart resumes it.
Start it with `ENGINE_PAUSED=1` to come up paused instead — for a restart after a change
to what the goals do, when you want the page, scripts and chat but not the engine until
you have looked things over.

Add an account:

```bash
EVONY_ACCOUNT_EMAIL=... EVONY_ACCOUNT_PASSWORD=... node add-account.js "Label"
```

Or add it in the Director with **Add account**, which then starts its console for you:
a free port, the process, and its uptime probe (without which the Director cannot see
it). An account with no console shows `no bot` and a **start** button on its row. By
hand, the same thing:

```bash
node botctl.js start a3       # start, or adopt the console already running a3
node botctl.js stop a3
node botctl.js list           # which accounts have a console, and where
```

The checkbox in the first column **switches an account off**: it stays in the fleet with
its history, goals and credentials, but nothing on this machine plays it any more, so a
bot on another machine can have the login to itself. The Director stops polling it and
takes its console down; a console that is still running for it anyway (one started by
hand) logs out within seconds and refuses every login — Connect, a script, the engine,
its own reconnects — until the account is switched back on. No console is started for a
switched-off account, whoever asks. Switching it back on starts the console again. The
row reads `off`, greyed, and the **Switched off** view lists them. Nothing is deleted;
**Delete** in the row's ✎ dialog is still the only thing that removes an account.

**Keep bot on** (a column, and a box in ✎) keeps an account's console running: the
Director checks every minute and starts it again if it is down, and switching the
account off only restarts it. Clear it to let a stopped bot stay stopped and a
switched-off account stay off. Off outranks keep on — an account that is off is never
started, even with the box ticked.

**Sort order** (in ✎, and the Order column) is your own order for the fleet; the table
starts sorted by it, lowest first.

**One tab per account.** Clicking an account's name (or its row) opens that console in a
tab named after the account, and clicking it again brings *that* tab to the front instead
of opening another one — without reloading it, so whatever you had open in the console is
still there. Ctrl/⌘ or middle click still means "a new tab", as everywhere else. The
console page claims the same name for itself (`botTabName`, in both pages), so a console
tab you opened by hand is found too; it used to call every console tab `evony_console`,
which is why duplicate tabs piled up. Test: `test-console-tabs.js` (the real pages, in
headless Chrome).

### The Accounts tab

Every field of every account in one grid, for changing many accounts without opening
each one's ✎: one row an account, one column a field — on/off, keep on, server, email,
password, security code, notes, proxy, after maintenance, autorun scripts, start-up
parameters, the prepend and append goals files, sort order, and the status from the
Fleet tab. Click a cell, or move to it with the arrow keys and press Enter, and change
it: the save is immediate, there is no Save button, and the footer says what the save
did — a goals file is read at once, start-up parameters apply from the console's next
start, a proxy from its next login. Enter saves and moves down, Tab saves and moves
right, Esc cancels, Space flips a switch, typing starts an edit over the old value,
Delete opens the cell empty. A dropdown stepped through with the keys is saved on Enter,
not at every step.

The shortcuts do the tedious part. **Apply to all** (Ctrl+Shift+A) takes the selected
cell's value to every account listed — or, if any rows are ticked, to those only — after
a confirm that names them; a name, an email or a sort order is each account's own and is
refused. **Fill down** (Ctrl+D) copies the cell above. **Undo** (Ctrl+Z) puts the last
change back on every account it touched. Alt+↑/↓ moves a row, **Renumber** makes the
order 1, 2, 3… as shown, and 🗑 deletes an account after a confirm. Switching an account
on or off here does what the Fleet tab's box does: its console comes up or goes down,
one account at a time when applied to all.

Under the table, every column that can be added up carries its **total** — coins,
cities, prestige, troops, resources, items — for the rows on screen, so a filter or a
view narrows the figures with the rows.

A console started this way comes up with its engine **live** — if the bot is on, its
goals are on, the account's prepend and append goals included. Only `-autorun 0` in its
start-up parameters starts it paused. `BOT_AUTOSTART=1 node
director.js` brings up every account's console on startup, for a machine that has just
rebooted; without it the Director only says which accounts have no bot.

Requires Node 24+ for the built-in `node:sqlite`. No npm install, no dependencies.

## One process per account

A second login for the same account gets kicked, and the two supervisors then fight and
trip the server's rate limiter. Three guards enforce this, all learned the hard way:

- a console started with `ACCOUNT_ID` is **pinned** — `/?account=<other>` cannot switch it
- a second console for an account already running **refuses to start**
- the Director asks every console who it holds and skips those accounts

### Proxies

**Proxies** holds the list, one per line (`host:port`, `host:port:user:pass`,
`socks5://user:pass@host:port`, `http://host:port`). **Test all** tunnels to the game
server through every line and asks for the policy file — never a login — and says which
work, how fast, and why the rest do not (most often: it wants a username and password, or
this PC's IP allowed at the provider). Each account's ✎ dialog, and the Accounts tab, has
a **Proxy** dropdown with three kinds of choice:

- **Random**, the default for a new account: a line of the list that no other account
  uses and that has not failed its test (one that passed first, else an untested one),
  picked for this account and **kept** — the same IP on every login — until that line
  fails a test, leaves the list, or another account is pinned to it. Then a new one is
  picked and the Director's log says so. With the list empty it logs in direct.
- **Direct**: this PC's own IP.
- **One line** of the list, pinned, with its last test result beside it and the accounts
  already on it. Sharing a line is allowed but warned about: one proxy per account.

The console of that account logs in through it from its next login on, and the
Director's own polls of the account go the same way (`proxy-pick.js`).

**When somebody else logs into an account**, the game sends `server.ConnectionLost` — the
same thing its own client shows as *"Another user has logged into your account"*. The
console treats it as the kick it is: it stands down (30 minutes by default, as NEAT does),
writes it in capitals in the log, and the console page shows a red bar naming the time and
the IP with a **Take it back now** button; the Director's fleet list shows a *someone else
logged in* pill near the top of the list. Only one bot should ever play an account.

**A hold that climbs.** An account's *After a kick* minutes are one step of a ladder: the
first drop holds its console out that long, the next twice as long, then three times … up
to an hour, and any login that holds for two minutes puts it back to the first step
(`session.js holdForKick`). Blank or 0 is the old behaviour — straight back in.

**A console that cannot get in changes its own proxy.** Ten minutes of trying without a
login that holds for two minutes — logins that fail, and logins the server drops again
seconds later, which are the same thing — and it closes the socket, moves the account to
another free line and starts again a minute later (`session.js rotateProxyIfStuck`; it rests
first because rate limiting is per account, not per IP). Each further move
in the same spell waits twice as long as the last (10, 20, 40 minutes, up to an hour), it
never takes a line another account is on, and it stays put rather than share one. The
Accounts grid shows such a line as "· moved by its console"; the account's own Proxy
setting is untouched, and **choosing a proxy there puts it back**. Nothing is moved while
the account is switched off, in a kick hold, or standing down for maintenance.
`OTTO_PROXY_ROTATE_MIN` and `OTTO_SETTLED_SEC` change the two times.

### After maintenance: everyone follows the clock

Every console hears the announcement on the system channel, stands down five minutes
before the announced start, and comes back at the announced end. From then on it checks
the game port every 30 seconds — a TCP handshake through the account's proxy, which costs
no login — and spends a login only once the port answers, after a stagger of up to 15
seconds so the fleet does not arrive as one burst. No login of any kind is made while the
stand-down is open, whoever asks for it: the supervisor, a page poll, a script, the engine
or the Director all get the same refusal, because a login into a maintenance can hold an
account back for half an hour. The page's **maintenance override** is the way through.

#### One bot hearing it stands the whole fleet down

Not every account is told. **An account on holiday is sent no system message at all**, so
its console used to sit connected into the start of the window, have the socket closed
under it, and then spend the whole maintenance on the reconnect ladder — logins into a
closed server, and a proxy hammered until it answered "host unreachable" (2026-09-23).

So the announcement is not kept to the console that heard it. The first console to hear
it — or to find the game port closed — writes the window where the whole fleet reads it
(`maintWindow:<server>` in the organization's settings, `maint.js`), and every other
console takes it on as its own stand-down, holidayed accounts included. Each console says
on its record whose word it is going by. A console's own plan always wins over the
fleet's, and a console that has come back through a window never adopts that one again.

**The Director hears it too, and declares it itself.** It watches every console at once,
so it sees what no single console can: two consoles reporting the server down, or three
losing the game socket in the same sweep, is the server — they do not share a proxy, and
one alone proves nothing (a dying proxy looks the same from one console). One account
still logged in settles it the other way: the server is up. While a window is open the
Director makes **no poll login of its own**, which is what used to log an account with no
console of its own into a maintenance.

The end is found the same way round: an account that was out and is logged in again is
the only proof the server is back, so every way back in now writes `maintOver:<server>`
(not just the dormant race's monitor, whose silence once stranded thirteen consoles for
70 minutes). A console that adopted the window then goes to its port check and staggered
login, not straight to a login of its own.

#### The maintenance race (dormant)

There is also a *maintenance race*, in which one account probes for the end of the window
and the others log in behind it. It is **off** since 2026-09-20: it bought no real speed,
and the monitor's repeated logins into a closed server ran its proxy into the ground. It
runs only on a console started with `OTTO_MAINT_RACE=1`. What it does then: each account's
✎ dialog has **After maintenance** (and a column of the same name):

- **Maintenance monitor** — one per server. From two minutes into the window it probes
  the game port every 15 s (through its proxy, if it has one) and tries a login every
  30 s once it answers; the moment it is in, it writes `maintOver:<server>` to the
  database. Making another account the monitor turns the old one into a follower.
- **Follower** — spends no login at all through the window (not the supervisor, not a
  page, not a script), and logs in the instant that signal is newer than the window's
  start.
- **Normal** — comes back on its own schedule, as before.

The role is kept per account and read on every tick, so it survives any restart and a
change applies at once; `OTTO_MAINT_MONITOR=1` / `OTTO_MAINT_FOLLOW=1` on a console's
start override it. The window (`maintWindow:<server>`: the announced start, for 90
minutes) is written by any console that hears the maintenance announcement, so it arms
itself whenever maintenance comes. A follower started with `AUTOSCRIPTS=1
RUNSCRIPT=<file>` then runs that script in every city the moment it is back.

### Market glitch ready

A **Market glitch ready** column says whether a holidayed account can be traded out of
yet. A holidayed account's resources are put back at every maintenance to what they were
at the one before, so an account that has only just gone on holiday has nothing to be put
back to — it has to have been on holiday **across** a maintenance. Holiday mode reports
only how much protection is LEFT, never when it began, so the console watches instead: it
records when it first saw the holiday and counts the maintenances that end while the
account is still on it (`holidayRun`, session.js). The count is kept in the account's own
settings, so a console restart does not lose it, and it is dropped the moment the holiday
ends. The column reads `—` off holiday, `not yet · 0 maintenances` before the first one,
and `ready · N maintenances` after. While a console is offline the count is left alone:
it cannot see, which is not the same as the holiday being over.

### The Resources tab

Every city's food, wood, stone, iron and gold, recorded **once an hour on the hour** and
again **every morning at 08:30** — just before the daily maintenance window, so that one
holds what each town was carrying into it (`city-resources.js`; the morning records are
marked in the `kind` column as `morning:<date>` and get their own table, so the hourly
series is unchanged). A Director that was down at 08:30 catches the day's record up at
its next start, marked late on the page; past 14:30 it gives the morning up rather than
pass an afternoon reading off as one.

The restore check behind `/api/resources/restore` (`city-resources.js`, which towns a
holidayed account's maintenance does not put back) is still served, but the page no longer
shows it (removed 2026-09-22 at the user's request).
ulti-tenant fleet control for Evony Age 1. A dependency-free Node client replacing
NEAT — Flash was never needed, the game speaks a plain socket protocol.

Sign up, get your own organization, and run your bots. Nobody else can see them.

Two apps and a goal engine:

| | | |
|---|---|---|
| `server.js` | **console**, one per account | per-city goals and scripts, monitors, map, chat |
| `director.js` | **fleet view** over every account | status, resources, items, proxies, uptime graph |
| `goalsd.js` | headless goal daemon | an alternative to running a console |

Everything is headless. The HTML pages are viewers that poll the process — close every
tab and the bots keep running.

## Running it

```bash
cp .env.example .env          # the default console's login
node director.js              # fleet + uptime            -> :8712
CONSOLE_PORT=8711 ACCOUNT_ID=a1 node server.js            -> :8711
CONSOLE_PORT=8713 ACCOUNT_ID=a2 node server.js
```

**The console's engine is always live** — from the moment it connects it acts on every
city's goals, once a minute. The pause button is how you stop it; a restart resumes it.
Start it with `ENGINE_PAUSED=1` to come up paused instead — for a restart after a change
to what the goals do, when you want the page, scripts and chat but not the engine until
you have looked things over.

Add an account:

```bash
EVONY_ACCOUNT_EMAIL=... EVONY_ACCOUNT_PASSWORD=... node add-account.js "Label"
```

Or add it in the Director with **Add account**, which then starts its console for you:
a free port, the process, and its uptime probe (without which the Director cannot see
it). An account with no console shows `no bot` and a **start** button on its row. By
hand, the same thing:

```bash
node botctl.js start a3       # start, or adopt the console already running a3
node botctl.js stop a3
node botctl.js list           # which accounts have a console, and where
```

The checkbox in the first column **switches an account off**: it stays in the fleet with
its history, goals and credentials, but nothing on this machine plays it any more, so a
bot on another machine can have the login to itself. The Director stops polling it and
takes its console down; a console that is still running for it anyway (one started by
hand) logs out within seconds and refuses every login — Connect, a script, the engine,
its own reconnects — until the account is switched back on. No console is started for a
switched-off account, whoever asks. Switching it back on starts the console again. The
row reads `off`, greyed, and the **Switched off** view lists them. Nothing is deleted;
**Delete** in the row's ✎ dialog is still the only thing that removes an account.

**Keep bot on** (a column, and a box in ✎) keeps an account's console running: the
Director checks every minute and starts it again if it is down, and switching the
account off only restarts it. Clear it to let a stopped bot stay stopped and a
switched-off account stay off. Off outranks keep on — an account that is off is never
started, even with the box ticked.

**Sort order** (in ✎, and the Order column) is your own order for the fleet; the table
starts sorted by it, lowest first.

**One tab per account.** Clicking an account's name (or its row) opens that console in a
tab named after the account, and clicking it again brings *that* tab to the front instead
of opening another one — without reloading it, so whatever you had open in the console is
still there. Ctrl/⌘ or middle click still means "a new tab", as everywhere else. The
console page claims the same name for itself (`botTabName`, in both pages), so a console
tab you opened by hand is found too; it used to call every console tab `evony_console`,
which is why duplicate tabs piled up. Test: `test-console-tabs.js` (the real pages, in
headless Chrome).

### The Accounts tab

Every field of every account in one grid, for changing many accounts without opening
each one's ✎: one row an account, one column a field — on/off, keep on, server, email,
password, security code, notes, proxy, after maintenance, autorun scripts, start-up
parameters, the prepend and append goals files, sort order, and the status from the
Fleet tab. Click a cell, or move to it with the arrow keys and press Enter, and change
it: the save is immediate, there is no Save button, and the footer says what the save
did — a goals file is read at once, start-up parameters apply from the console's next
start, a proxy from its next login. Enter saves and moves down, Tab saves and moves
right, Esc cancels, Space flips a switch, typing starts an edit over the old value,
Delete opens the cell empty. A dropdown stepped through with the keys is saved on Enter,
not at every step.

The shortcuts do the tedious part. **Apply to all** (Ctrl+Shift+A) takes the selected
cell's value to every account listed — or, if any rows are ticked, to those only — after
a confirm that names them; a name, an email or a sort order is each account's own and is
refused. **Fill down** (Ctrl+D) copies the cell above. **Undo** (Ctrl+Z) puts the last
change back on every account it touched. Alt+↑/↓ moves a row, **Renumber** makes the
order 1, 2, 3… as shown, and 🗑 deletes an account after a confirm. Switching an account
on or off here does what the Fleet tab's box does: its console comes up or goes down,
one account at a time when applied to all.

Under the table, every column that can be added up carries its **total** — coins,
cities, prestige, troops, resources, items — for the rows on screen, so a filter or a
view narrows the figures with the rows.

A console started this way comes up with its engine **live** — if the bot is on, its
goals are on, the account's prepend and append goals included. Only `-autorun 0` in its
start-up parameters starts it paused. `BOT_AUTOSTART=1 node
director.js` brings up every account's console on startup, for a machine that has just
rebooted; without it the Director only says which accounts have no bot.

Requires Node 24+ for the built-in `node:sqlite`. No npm install, no dependencies.

## One process per account

A second login for the same account gets kicked, and the two supervisors then fight and
trip the server's rate limiter. Three guards enforce this, all learned the hard way:

- a console started with `ACCOUNT_ID` is **pinned** — `/?account=<other>` cannot switch it
- a second console for an account already running **refuses to start**
- the Director asks every console who it holds and skips those accounts

### Proxies

**Proxies** holds the list, one per line (`host:port`, `host:port:user:pass`,
`socks5://user:pass@host:port`, `http://host:port`). **Test all** tunnels to the game
server through every line and asks for the policy file — never a login — and says which
work, how fast, and why the rest do not (most often: it wants a username and password, or
this PC's IP allowed at the provider). Each account's ✎ dialog, and the Accounts tab, has
a **Proxy** dropdown with three kinds of choice:

- **Random**, the default for a new account: a line of the list that no other account
  uses and that has not failed its test (one that passed first, else an untested one),
  picked for this account and **kept** — the same IP on every login — until that line
  fails a test, leaves the list, or another account is pinned to it. Then a new one is
  picked and the Director's log says so. With the list empty it logs in direct.
- **Direct**: this PC's own IP.
- **One line** of the list, pinned, with its last test result beside it and the accounts
  already on it. Sharing a line is allowed but warned about: one proxy per account.

The console of that account logs in through it from its next login on, and the
Director's own polls of the account go the same way (`proxy-pick.js`).

**When somebody else logs into an account**, the game sends `server.ConnectionLost` — the
same thing its own client shows as *"Another user has logged into your account"*. The
console treats it as the kick it is: it stands down (30 minutes by default, as NEAT does),
writes it in capitals in the log, and the console page shows a red bar naming the time and
the IP with a **Take it back now** button; the Director's fleet list shows a *someone else
logged in* pill near the top of the list. Only one bot should ever play an account.

**A hold that climbs.** An account's *After a kick* minutes are one step of a ladder: the
first drop holds its console out that long, the next twice as long, then three times … up
to an hour, and any login that holds for two minutes puts it back to the first step
(`session.js holdForKick`). Blank or 0 is the old behaviour — straight back in.

**A console that cannot get in changes its own proxy.** Ten minutes of trying without a
login that holds for two minutes — logins that fail, and logins the server drops again
seconds later, which are the same thing — and it closes the socket, moves the account to
another free line and starts again a minute later (`session.js rotateProxyIfStuck`; it rests
first because rate limiting is per account, not per IP). Each further move
in the same spell waits twice as long as the last (10, 20, 40 minutes, up to an hour), it
never takes a line another account is on, and it stays put rather than share one. The
Accounts grid shows such a line as "· moved by its console"; the account's own Proxy
setting is untouched, and **choosing a proxy there puts it back**. Nothing is moved while
the account is switched off, in a kick hold, or standing down for maintenance.
`OTTO_PROXY_ROTATE_MIN` and `OTTO_SETTLED_SEC` change the two times.

### After maintenance: everyone follows the clock

Every console hears the announcement on the system channel, stands down five minutes
before the announced start, and comes back at the announced end. From then on it checks
the game port every 30 seconds — a TCP handshake through the account's proxy, which costs
no login — and spends a login only once the port answers, after a stagger of up to 15
seconds so the fleet does not arrive as one burst. No login of any kind is made while the
stand-down is open, whoever asks for it: the supervisor, a page poll, a script, the engine
or the Director all get the same refusal, because a login into a maintenance can hold an
account back for half an hour. The page's **maintenance override** is the way through.

#### One bot hearing it stands the whole fleet down

Not every account is told. **An account on holiday is sent no system message at all**, so
its console used to sit connected into the start of the window, have the socket closed
under it, and then spend the whole maintenance on the reconnect ladder — logins into a
closed server, and a proxy hammered until it answered "host unreachable" (2026-09-23).

So the announcement is not kept to the console that heard it. The first console to hear
it — or to find the game port closed — writes the window where the whole fleet reads it
(`maintWindow:<server>` in the organization's settings, `maint.js`), and every other
console takes it on as its own stand-down, holidayed accounts included. Each console says
on its record whose word it is going by. A console's own plan always wins over the
fleet's, and a console that has come back through a window never adopts that one again.

**The Director hears it too, and declares it itself.** It watches every console at once,
so it sees what no single console can: two consoles reporting the server down, or three
losing the game socket in the same sweep, is the server — they do not share a proxy, and
one alone proves nothing (a dying proxy looks the same from one console). One account
still logged in settles it the other way: the server is up. While a window is open the
Director makes **no poll login of its own**, which is what used to log an account with no
console of its own into a maintenance.

The end is found the same way round: an account that was out and is logged in again is
the only proof the server is back, so every way back in now writes `maintOver:<server>`
(not just the dormant race's monitor, whose silence once stranded thirteen consoles for
70 minutes). A console that adopted the window then goes to its port check and staggered
login, not straight to a login of its own.

#### The maintenance race (dormant)

There is also a *maintenance race*, in which one account probes for the end of the window
and the others log in behind it. It is **off** since 2026-09-20: it bought no real speed,
and the monitor's repeated logins into a closed server ran its proxy into the ground. It
runs only on a console started with `OTTO_MAINT_RACE=1`. What it does then: each account's
✎ dialog has **After maintenance** (and a column of the same name):

- **Maintenance monitor** — one per server. From two minutes into the window it probes
  the game port every 15 s (through its proxy, if it has one) and tries a login every
  30 s once it answers; the moment it is in, it writes `maintOver:<server>` to the
  database. Making another account the monitor turns the old one into a follower.
- **Follower** — spends no login at all through the window (not the supervisor, not a
  page, not a script), and logs in the instant that signal is newer than the window's
  start.
- **Normal** — comes back on its own schedule, as before.

The role is kept per account and read on every tick, so it survives any restart and a
change applies at once; `OTTO_MAINT_MONITOR=1` / `OTTO_MAINT_FOLLOW=1` on a console's
start override it. The window (`maintWindow:<server>`: the announced start, for 90
minutes) is written by any console that hears the maintenance announcement, so it arms
itself whenever maintenance comes. A follower started with `AUTOSCRIPTS=1
RUNSCRIPT=<file>` then runs that script in every city the moment it is back.

### Market glitch ready

A **Market glitch ready** column says whether a holidayed account can be traded out of
yet. A holidayed account's resources are put back at every maintenance to what they were
at the one before, so an account that has only just gone on holiday has nothing to be put
back to — it has to have been on holiday **across** a maintenance. Holiday mode reports
only how much protection is LEFT, never when it began, so the console watches instead: it
records when it first saw the holiday and counts the maintenances that end while the
account is still on it (`holidayRun`, session.js). The count is kept in the account's own
settings, so a console restart does not lose it, and it is dropped the moment the holiday
ends. The column reads `—` off holiday, `not yet · 0 maintenances` before the first one,
and `ready · N maintenances` after. While a console is offline the count is left alone:
it cannot see, which is not the same as the holiday being over.

### The Resources tab

Every city's food, wood, stone, iron and gold, recorded **once an hour on the hour** and
again **every morning at 08:30** — just before the daily maintenance window, so that one
holds what each town was carrying into it (`city-resources.js`; the morning records are
marked in the `kind` column as `morning:<date>` and get their own table, so the hourly
series is unchanged). A Director that was down at 08:30 catches the day's record up at
its next start, marked late on the page; past 14:30 it gives the morning up rather than
pass an afternoon reading off as one.

Underneath, **Towns the glitch does not put back**. A holidayed account's towns are put
back at every maintenance to what they held at the one before, except that some towns
never are — and selling one of those dry gives the resources away for real. For every
maintenance (timed from `maintEnded:<account>` and `maintWindow:<server>` in the org's
settings, falling back to the daily 08:30–09:30 window) each town's last reading before
it is compared with its first reading after, against what that town was put back to at
the maintenance before. A town is named either as **never put back** — drained, and still
drained afterwards, at every maintenance we have records either side of — or as **empty
beside the rest**, meaning its put-back amount is under a twentieth of its account's
middle town on two of wood, stone and iron and has never moved, which is what a town sold
dry before the record began looks like now. Food and gold never decide it (troops eat one
and everything costs the other), only accounts the record has seen put back are judged at
all, and the page says how many maintenances the verdict rests on — one is a suspicion,
not a finding.

### The Trading tab's Glitch log

A third view beside **Trading results** and **Trading**: one record per maintenance, day
by day, filtered by date (`glitch-log.js`). For each maintenance it holds **what every
town of every account went in with and what it came out with**, the difference per
resource, and the trading runs of that day.

- The **before** record is taken at the fleet's stand-down — five minutes before the
  announced start — and the **after** record once every console has reported in again
  from the other side (or twenty minutes on, if some never do). Both are filed in
  `city_resources` under `kind = maint:<date>:before|:after`, so the hourly series and the
  08:30 record are untouched.
- Before the "before" record, **every account is logged in afresh**, because a console's
  cached resource figures go stale on a busy account and only a relog refreshes them. That
  is a real cost — a refresh ends every city's running script — so it fires once per
  maintenance, only when the window was actually announced, never inside the stand-down,
  and never twice in a quarter of an hour. Each town is marked **live** or **cached**, so
  a cached figure is never passed off as the server's. The switch is on the tab, with the
  lead time; turn it off and the record still happens.
- Each day also lists its **runs** — the play, the price, which accounts were banks and
  which were buying or selling, and when it started and stopped. The runs are archived as
  they happen, because the settings only ever hold the run going on right now.
- **Record before now**, **Record after now** and **Relog the fleet now** do each step on
  demand; the relog asks first.

### The Monitor tab

One watcher over the **whole server** — every player, not just ours — run from the
Director. It answers the questions a fleet cannot: who owns what, where, which of the big
accounts are actually being played, and who has just come off holiday.

**It never logs in.** A second login for an account kicks whatever holds it, and the
Monitor has to run for hours, so it drives *one console* over HTTP instead: it asks that
console to read the map and the rankings on the connection it already has. The game keeps
seeing a single session for the account, and that account goes on playing its own goals
exactly as before. Pick whose console in **Monitor → Setup**; an account with no console
running cannot be picked. It runs as its own process (`monitor.js`, logging to
`monitor.log`), started and stopped by the Start button and restarted by the Director
within a minute if it is switched on and not running — so a Director restart never drops
a sweep.

Three passes, each on its own clock:

| pass | default | what it reads |
|---|---|---|
| **map** | every 10 min | all 1,600 blocks of the 800×800 world — every player city, its lord, alliance, prestige and **state** |
| **rankings** | every 15 min | the game's Statistics window end to end (players, alliances, heroes, cities) |
| **watch** | every 15 min | each watched lord by name: prestige, cities, rank, population, last login |

The periods, the blocks per request and the pause between requests are all on the Setup
view, and **Map sweep now / Rankings now / Watch now** run one immediately. The map is
live; the rankings are recomputed server-side only about every fifteen minutes, so reading
them faster buys nothing (EVONY-RULES §6).

Measured on ss71 (2026-09-23, through Lord02): a whole-world sweep takes **about two
minutes** (118 s and 107 s) and finds **13,549 player cities across 2,501 lords**, 165 of
them on holiday. Between two sweeps five minutes apart, 641 lords had moved prestige and
the rest had not — which is the whole signal. The first sweep also fills the shared map
cache with the entire world (51 MB → 248 MB of `evony.db`, a one-off: the second sweep
added nothing), so NPC farming and the valley goals get the world for free.

**The Changes view** lists what moved — a lord coming off holiday, one that has stopped
moving, an alliance change, a city gained or lost. Search it by lord or by what was said,
and sort it by any column it shows, including **Best hero**: each lord's highest-level
hero in the server's hero ranking, which is the game's own measure of best. Clicking that
hero opens the lord:

- their **ten best heroes**, with level, attack, politics and intelligence;
- every **prestige reading** we hold, newest first, with the ones that moved marked — so
  "has not moved prestige for 2,729 min" becomes a number and a time. A reading is always
  kept when the prestige *moved*; between moves the watch pass keeps a heartbeat one as
  well (**Keep a reading every**, 60 min by default), or a lord standing still would leave
  a single row and no plateau to read. Those in-between readings are thrown away after
  **Throw those away after** days (14) — a reading that recorded a move is kept for ever;
- every **city of theirs**, as a script to paste into whichever city will do the scouting,
  with a Copy button:

  ```
  a = ["706,460", "708,460", "707,461", ...]
  scout {a.shift()} any s:100k
  repeat 10
  ```

  `repeat`, not `loop`: `loop 10` would run the assignment again each round and scout the
  first city ten times over (SCRIPTS.md). All of it comes from sweeps already taken —
  opening a lord asks the game nothing.

**One caution on the very top accounts:** prestige is a signed 32-bit number and the
biggest lords are at its ceiling — the highest on ss71 reads 99.94% of 2,147,483,647.
Their prestige cannot move much further, so *Still for* means nothing for them. Judge
those by the watch pass's **Last login** instead.

The Monitor stands down with its console: when maintenance was announced it reported
*waiting for the console* every 30 seconds until the console logged back in. It never logs
in itself, so it cannot log in during maintenance and cannot kick anything.

**Statistics** is the four ranked lists, filtered **a column at a time** — every player in
one alliance, every hero of one lord, every city of a level, alliances above a member
count. The boxes are built from each list's own columns, so a text column takes a
substring and a number column takes a range. The console's own Statistics tab fills the
same tables, and either can read them.

**Cities** is what the map found, which is far more than the rankings list: every player
city on the server with its coordinates, level, lord, alliance, prestige and the lord's
state — peace, truce, beginner, **holiday** or dream truce. That state is the only honest
read of whether a stranger is sitting out; the player bean's `furlough` flag is not
(EVONY-RULES §4).

**Lords** is one row per lord, and the column that matters is **Still for**: how long
their prestige has not changed. A bot that is farming moves prestige constantly; one that
has stopped does not. *Not moving* filters to the lords that have stood still longer than
the threshold — and **a lord on holiday is never called still**, because a holidayed
account cannot move prestige at all, so its stillness says nothing. Set the watch list to
the lords of the **top N heroes** (10, 50, 100 — the hero rank names its lord) and add any
other names by hand.

**Changes** is the feed: came off holiday, went on holiday, stopped moving, moving again,
changed alliance, gained or lost a city. Holiday endings are the headline one — a holidayed
account's prestige is frozen, so the moment its state goes `holiday → peace` it is back in
play. Clicking a lord's name anywhere in the tab opens their prestige history and their
changes.

**The alliance filter** sits on Cities, Lords and Changes: a button that opens every
alliance the map has seen, with a search box and how many lords fly each one. Tick the
ones to **hide these** — which is what it is for, since the feed is mostly the same few
big alliances shuffling about — or switch it to **only these** and see nothing else.
*(no alliance)* is a row like any other, and a lord who is in none is never swept away by
an exclusion that did not name them. The choice is remembered per view, so a feed cleaned
up once opens clean.

Everything lands in the shared database, keyed by server rather than by organization,
because the rankings and the map are public: `mon_city`, `mon_player`,
`mon_player_history`, `mon_event`, `mon_sweep`, beside the `stat_*` tables. A map sweep
also fills the ordinary map cache, so NPC farming and the valley goals get the whole world
for free.

By hand, without the Director:

```bash
node monitor.js                 # run it (--org <id> when there is more than one)
node monitor.js --once map      # one full sweep, then exit
node monitor.js --status        # what it knows
```

Test: `test-monitor.js` — the analysis, a whole-world sweep against a stub console, and
the real page in headless Chrome. Nothing in it logs in.


## The console

Laid out like NEAT: header counters (packages, reports, mail, coins, prestige, honor,
server time), city tabs, and one icon per panel. A city tab turns red when armies are
inbound, amber when its food runs out within a day, and gets a `*` when a manual
control is in force. The tab of the city holding the hero a `traininghero` goal names
is always green, with a dashed border while that hero is marching.

The row above the editor holds two **manual controls, kept per city, that outrank the
goals** until set back to Auto:

- **Gate Control** — Open/Closed goes to the server at once, then the engine holds it
  every tick, even in a city with no goals. Auto hands the gate back to
  `config gate:` + `gatepolicy`.
- **War Town Mode** — overrides `config wartown:` for the city. Switching it on makes
  the next tick recall the marches still heading out of the city, exactly as the goal
  does.

Under the editor, **Apply** checks goals or a script for errors without saving anything
and **Save** keeps them. **Every city's editor is its own:** its goals are the goals the
engine runs there and nowhere else, and its scripts live in that city's own ten
**loadouts** — the first line names one, each city remembers which one it has open, and
**Run** runs it in that city, alongside any other city's run. Unsaved edits and the
**Output** tab stay with their city too. A script with any error is refused whole; a goal
line with an error is skipped and the rest run. Tick **all towns** beside Run to start
what is in the editor in every city of the account at once — one run each, each with its
own Output and its own Stop, and no other city's loadouts touched.

**The goal editor colours every line as you type.** Blue lines are ones the engine acts
on, red lines have an error or would do nothing, and grey lines are comments. Hover a red
line, or put the cursor on it, to see why. The strip under the editor counts each kind,
and Apply's Output lists them too. A line read differently from how it was written, such
as `wartown 1` or an obsolete NEAT goal, stays blue and says what it was read as. Scripts
are coloured the same way.

The selector under the editor, beside Apply and Save, opens the texts the whole account
shares instead of the city's own: the **New-city template**, the **Prepend goals** and
**Append goals** every city runs before and after its own, and **Goal set 1** to **9**,
which a script's `loadgoals N` runs. On the script tab it holds the city's loadouts and
the **New-city script**. When a script has changed the goals a city runs, the editor's hint
says so, and **Clear script goals** puts the city back on its saved goals.

The pause button stops the engine acting until it is resumed. The log is split
by kind: **Log** is what the bot did, **Engine** its per-city thinking, **Debug**
everything including the protocol trace.

**Statistics**, beside Items, is the game's own Statistics window: every player, alliance,
hero and city on the server, ranked, read through this console's connection
(`statistics.js`; never a login). **All** shows the top 10 of each list, and a list on its
own pages through it as the game's window does (First, Prev, a page box, Next, Last),
100 to a page, fetched from the server as you go; the next 5 pages are read in the
background so Next is instant, and a page read in the last 10 minutes comes from the
database. A list's length shows with a ~ until its last page has been read. Typing in
the search box searches every list at once in the database, over what browsing and
Refresh have read: a lord's name finds the lord, their heroes and their cities; an
alliance's name finds its members and cities. **Enter** (or *Ask the server*) asks the
game for that exact name, and a **Page** button opens the page it is on. Click any name
to search for it; a heading sorts what has been read (Rank goes back to the game's
pages). **Refresh** reads all four lists whole, for searching — alliances first, one page
at a time with a pause between, waiting while the account's market orders are busy — and
a read that stopped (a console restart) carries on from its last page. Every console on
the same server shares what was read.

**Alliance**, beside Reports, is the game's Alliance window: **Info** (founder, host,
members, ranking, prestige, intro and notice), **Members** (sortable; **View** opens a
member with Friends List, Blocklist, Mail, and, when your rank allows it as the game's
window does, Promote and Expel), the **Friendly**, **Neutral** and **Hostile** alliances
(a host or vice host can change a standing or mark a new alliance), **War Reports** (each
opens as a battle report) and **Events**. **Friends**, after Statistics, is the Blocklist
and My Friends: add a name, view or delete one; a name on the other list is moved across
after asking. Both tabs read through this console's live connection when opened or on
**Refresh**, never a login, and nothing polls (`alliance.js`). Every change asks first and
runs the script command of the same name (`setofficer`, `expel`, `declare`, `addfriend`,
`block`…), so it logs and refuses the same way.

The header's **Reports** and **Mail** boxes open the game's own mailbox. A report is
drawn the way the game's report screens drew it (`mailbox.js` decodes, `public/reportview.js`
draws). The game's "battle log on the web" is a Flash page, so **`/report`** stands in
for it: give it the game's link (`…evony.com/default.html?logfile/….xml`) and the console
fetches the log from the game's report server, with no game login needed. A report's
*Open as a battle log* opens it there, and battle-log links pasted in chat link to it.

### Scripts

A script is NEAT's script language, run from a city's loadouts: labels, `goto` and
`gosub`, `if`, variables and expressions, functions, NEAT's objects
(`city.troop.archer`, `m_context.ItemCount(...)`) and its function library, and some 130
commands for marches, building, research, troops, heroes, the market, items, quests, chat
and the alliance. NEAT's example scripts run as the wiki writes them. **[SCRIPTS.md](SCRIPTS.md)**
is the reference: the language, every command with its usage and how it differs from
NEAT, the objects and functions, and the safety switches.

The box beside **Run** starts at a line number or a label (NEAT's Run box), and a `stop`
line pauses the run until **Resume**. Autorun is off until switched on — in the Director,
per account (✎ → **Autorun scripts**) or for every account (**Start-up**, NEAT's Custom
Parameters), or with `AUTOSCRIPTS=1` / `-autoscripts 1` in `CmdParms.txt` — and it applies
from a console's next start; then a saved loadout holding `label autorun` starts by
itself once each time the console starts, after the startup file, unless the console last
started it under 10 minutes ago. Nothing a script does spends cents except `buyitem`, and
that stops at 100 items a run without `confirm`. A line typed in the chat
box that starts with `\` runs an in-line command (`\who Bob`) instead of going out as chat.
Scripts use the console's own session and never log in. `holidaysnipe` and NEAT's
background attacks (`spamattack`, `capture`...) keep running after the script that started
them ends. The timed marches behind the extra-cities trick (`deploy bu … @:14:30:07.500`,
`marchcheck`, `buildstatus`, `logout now`) are in
[SCRIPTS.md](SCRIPTS.md#timed-marches-and-extra-cities).

| variable | what it does |
|---|---|
| `AUTOSCRIPTS` | `1` switches autorun on (NEAT's `-autoscripts 1`); it is off otherwise |
| `RUNSCRIPT` | the startup file every city runs first (NEAT's `-runscript`); default `AutoRunScript.txt` |
| `EVONY_SCRIPTS_DIR` | where `call`, `get` and the startup file are read, default `scripts\` |
| `EVONY_MEDIA_DIR` | where `play` finds sounds, default `media\` |
| `EVONY_CMDPARMS` | NEAT's parameter file, default `CmdParms.txt`; the console's command line (where the Director puts its start-up parameters) wins over it, the variables above over both, and every `-name value` reaches scripts as `Config.<name>` |
| `OTTO_ALLOW_RESET_PLAYER` | `1` lets `resetplayer` delete the lord; off otherwise, whatever a script says |
| `OTTO_ALLOW_ABANDON_TOWN` | `1` lets `abandontown` give up a city, and then only one `buildnpc` built or a person adopted with `allowabandon`; off otherwise |
| `OTTO_TROOP_TRACE` | `1` prints the troop goal's decisions to the console's own output (`console-<id>.log`, `[troops …]` lines): each city's troop note with what its batches were sized from, every batch, mayor change and production change sent, and the traininghero's moves |

## Goals

Declarative end states, re-evaluated every tick, order-independent — the NEAT model.
Scripts are the imperative counterpart. Parsed by `goals.js`, evaluated by `engine.js`.
The goal language is NEAT's: every goal and config key its wiki documents is read in
NEAT's syntax and does what the wiki's page says. Where the wiki is silent the bot takes
the careful reading, and the plan note says what it did.

```
config comfort:1,hero:1,npc:5
build f:10:37
research lo:5,ho:5
troop b:5k,t:5k
troop a:100k,s:100k
fortification ab:5000
taxpolicy 20 100
distancepolicy 15
npcteams 3
requestresources any wood 2m 200k * 500k /below:100k
requesttroops any archer 200k 10k * 50k /below:100k
defensepolicy /junktroop:5000 /usetruce:79
rallypolicy r:2 t:1 max:8
```

**How lines combine.** `config` lines merge, and a key written again later wins. A goal a
city has once, such as `comfortpolicy` or `defensepolicy`, is replaced by a later line of
the same name. `troop`, `build`, `research`, `plan` and `fortification` lines stack and are
worked in the order written. Numbers take `5k`, `1.5m` and `2b`. Troop, fortification and
resource names are the same in every goal: NEAT's abbreviations (`warr`, `cav`, `cata`,
`ram`, `pult`, `tra`, `ab`, `at`, `tre`, `lumber` …), full names and plurals.

**A city's turn.** The engine visits every city once a minute, one at a time. Most goals
share three actions a turn. Hiding and the gate go first, before anything else is read,
and some work has a slot of its own that never waits behind the rest: one construction
order, one research start, up to 20 troop batches, and the free finishes. Anything the
server refused is retried later, from 1 minute up to 4 hours. While it waits it uses no
action slot and writes no log line; the engine's plan note lists it under `held back`.

**Goal marches never overfill a rally spot.** A city has as many march slots as its
Rally Spot level. Every march holds one, going, camped or coming home. Before any goal
march leaves, the engine checks the sending city's slots. That covers NPC farming,
buildnpc, valleys and flats, transfers and traininghero. Hiding is exempt: getting the
army out is never held. `rallypolicy` (wiki: RallyPolicy) goes in the sending city's goals
and caps goal marches by kind: `n` NPC farming (`n:10:1` caps one level), `b` buildnpc and
flats, `v` valleys, `m` medal hunting, `t` troop reinforcements, `r` resource transports.
The server lists a valley attack like an NPC attack, so `n` counts valley attacks too.
`max:8` is ours: goals stop at 8 busy slots, whatever holds them, so a L10 rally spot
always keeps 2 free for scripts and manual marches. `npcteams` counts the city's attacks
(NPC farming, valley farming and captures), as in NEAT.

### Building and research

**Build lines are targets, the NEAT way.** `build f:10:37` means at least 37 farms at L10
or higher. A missing quantity counts as 1. Nothing is demolished unless a level or
quantity is 0: `c:0:8` keeps the 8 strongest cottages, `inn:2:0` takes the inn down to L1
one level at a time, `i:0:0` removes every iron mine. The Town Hall and Walls are never
demolished. Targets for one type combine (`b:4:15,b:9:2` is 15 barracks, two at L9), and
the lowest building is raised first. When two targets contradict, the one written first
wins and the plan says so. Lines run in order like troop stages. A line with no free plot
is skipped until one frees, and a one-per-city building with no plot stops with
`Needs space: Academy`. `?w:10?` or `?met:10,w:10?` before or after a group holds it back
until the condition is met (`?i:4:0?` means no iron mine at L4 or higher; inside a
condition `st` is the Stable and `sp` Stockpile). `config building:0` pauses construction.
Use `t` or `th` for the Town Hall; full names work too.

**Prerequisites are built first, the NEAT way.** Before the bot places a construction
order it asks the game what the order needs. A building it needs, including Town Hall
levels, is built or raised first ("Cottage L9 needs Town Hall L8"). The prerequisite's own
needs are checked the same way. If there's no plot for it, the bot says `Needs space: Farm`
and stops, except that below Town Hall L10 a field gets a plot by raising the Town Hall.
Fields a line wants that don't fit also raise the Town Hall, no higher than they need. An
order that needs research is skipped and noted for the research goal. A level-10 upgrade
needing a Michelangelo's Script is skipped when you hold none, and spends one when you do
(NEAT's wiki warns of the same). When resources or idle population are short, the builder
waits and says what for, and troop and wall batches leave that cost in the bank.

**A city has one builder.** Each turn sends at most one construction order, and none while
something is already being built. The Walls a fortification goal needs come first, then
the lines in order. Within a line, demolitions go first, then new buildings, then upgrades
from the lowest level up: the fastest work first. A city without Walls gets them built
when a `w:` target or a fortification goal needs them. New buildings only go on open
plots. Outside the walls the Town Hall decides how many plots are open: 13 at level 1, 3
more per level, all 40 at level 10. The plan note says what can't be built and why, e.g.
`no free field plot for 7 more Farm (all 40 in use)`, and the Buildings tab shows the
prerequisite being built, what the builder waits for, and what it skipped.

**Free speed-ups.** The game finishes a construction or research for nothing when the job
is a short one: its preset time, before research and the mayor shorten it, is five minutes
or less. That covers the early levels: a Farm's first four, a Cottage's, Sawmill's or
Quarry's first three, an Ironmine's or Rally Spot's first two, the first level of a
Barracks, Stable, Inn, Forge or Feasting Hall, and Informatics 1. The engine finishes these
the moment it sees them, including the building it has just started, so the builder moves
straight on. The time left doesn't matter: a long job with a minute to go is still a long
job. Demolitions, troops and fortifications never get a free finish. A refused one isn't
asked again. `config freespeedup:0` turns them off in a city.

**Research, the NEAT way.** `research lo:5,ho:5,com:4` researches Logistics and Horseback
Riding to level 5 and Compass to 4. Lines run in order, one research at a time in each
city, and a city never starts a tech another city is already researching. Use NEAT's
codes (`st` or `sp` for Stockpile) or full names, and a `?condition?` before or after the
targets as on a build line (`research ?a:10?pr:10`; inside a condition `st` is the Stable).
A tech the target needs is researched first. A building it needs is built before the build
lines' own work, including the Academy when a tech has reached the level this city's
Academy allows (Machinery needs Academy L9). When resources are short it waits and says
for what, and troop and wall batches leave the cost in the bank. `config research:0`
pauses research. With a research line or `config research:1`, the techs your build lines
need are researched too. A script's `research` line, or NEAT's older `techgoals`, adds a
research line.

**Plans.** `plan c:4:9,i:4:40,b:4:14,mi:4` puts buildings and research on one line. It is
finished before the next plan line starts: every building standing at its level and every
research at its level. On a plan line `st` is the Stable and `sp` Stockpile. Plan lines
come ahead of your build and research lines, which carry on whenever the plan leaves the
builder or the Academy free. `config plan:0` pauses them.

### Troops and walls

**Troops train in batches of about 30 minutes.** Each turn the engine reads the barracks
queues and the city's per-unit training time (mayor and research included), and fills the
free slots: a barracks holds as many batches as its level. A batch is the smallest of: the
queue time's worth of training, the idle population, the resources, and what is still
short. Troops already queued, out on a march from the city, or reinforcing it on their way
in count toward the target. Stages are worked in order, and the engine drops back to an
earlier stage that is no longer met. Batch time is fixed when a batch is queued, so the
attack mayor is appointed first. Batches leave the next construction's and research's
cost in the bank, and a day of the troops' food. `config troop:0` stops training.

**Troop lines take NEAT's switches**, and each switch overrides its config key for that
line. `/queuetime` (hours; `config troopqueuetime`) sets the batch length, 30 minutes by
default; `/slot` and `config troopslot` do the same in minutes, and 0 removes the cap.
So a level-10 barracks takes ten 30-minute batches. A troop the mayor trains **instantly**
(under a second each: the insta hero) has no batch length: the whole shortfall goes in one
batch, as population and resources allow, and it leaves its queue slot free for the next.
Whether a type can be trained is the game's Enlist rule (every building, research and item
in its conditionBean met); the server's `permition` flag is ignored, as the client does.
`/increment` at 0 trains the line left to right, each type filling the barracks before the
next. A share like `0.01` or a number like `500` takes turns, and `1` keeps every type at
the same share of its target. `/usereserved` lets training spend part of the day of food
kept for troop upkeep. `/usepopmax` (`config troopsusepopmax`) lets it take part of the
whole population: production is set to 0 while the batches go in, then put back.
**With a `traininghero` named, the barracks are kept for it** (`config trooptraineronly`,
`/traineronly`, on by default). While it is away, another hero queues only troops it
builds **instantly** — those finish as they are placed and leave the slot free. Anything
slower waits, because a batch another hero queues holds its slot for the whole queue time,
and a city that filled nine slots with 30-minute batches had nothing free when the training
hero came round. A hero that has never been mayor here and has at least the training
hero's attack is let through once, so its speed is measured rather than guessed. Set
`config trooptraineronly:0` (or `/traineronly:0` on a line) for NEAT's rule instead, where
`/idlequeuetime` lets another hero queue small batches in empty barracks while the
`traininghero` is away and types it trains slower wait for it.
`config reservedbarrack:1` keeps one barracks free for the first line under attack, and
`config troopdelbadque:1` cancels a batch queued far too slowly (one a turn, only while
the best attack hero is mayor).

**Fortifications count the wall queue** toward the target, and each order is sized to the
fortified space left. The Walls level sets the space: 1,000 at L1 up to 55,000 at L10. A
trap (`tra`) takes 1, abatis (`ab`) 2, an archer tower (`at`) 3, rolling logs (`r`) 4 and a
trebuchet (`tre`) 5. When a stage needs more space than the Walls give, the Walls upgrade
goes to the builder. `config fortification:0` pauses the goal, the first Walls included.
`config wallqueuetime` sets the batch length (15 minutes by default), and
`config fortsusereserved` works like `/usereserved`. During an attack, one of each type on
the first `fortification` line goes up first.

### City upkeep

**City upkeep, the NEAT way.** `config comfort:1` (on unless you write `comfort:0`) keeps
each city's grievance at 0 and its loyalty as high as its tax allows, praying or giving
disaster relief only when that helps, and holds the tax your gold allows.
`taxpolicy <min> <max> [war]` sets that range (default `0 100`): the tax sits at the
minimum and rises, up to the maximum, only when the city has less than a day of hero
salary banked and the tax isn't paying it. It uses the war rate while under attack, and
keeps a rate you set by hand. `comfortpolicy <min> <max> [options]` adds a round every
min–max minutes: `popraise` (only below the population limit), `bless`, `pray`, `relief`,
and levies of `gold food wood stone iron`. A levy comes only in a round where no popraise
was needed, never while under attack, and never below 50 loyalty.
`production <food> <wood> <stone> <iron>` and `warehousepolicy <food> <lumber> <stone> <iron>`
hold the Town Hall labour split and the warehouse's protected split, checked every half
hour. Wounded troops in the medic camp are healed when the city can spare the gold, unless
`config nohealing:1`.

### Resources, troops and the market

**Resources and troops move from the nearest city that can spare them, the NEAT way.**
`requestresources <from> <type> <localAmount> <remoteAmount> [minBatch] [maxBatch] [troopType]`
and `requesttroops <from> <troop> <localAmount> <remoteAmount> [minBatch] [maxBatch]` ask
only while the city holds less than localAmount, counting what is on its way, and never
fill it past that. They never take a sender below remoteAmount, or below the level at which
the sender's own line would ask for more, so two cities can't pass resources back and
forth. One batch number is the maximum per send; `*` as maxBatch (or a maxBatch bigger than
one march takes) sends as much as **one march carries**: the Rally Spot's troop limit ×
each carrier's hold at the account's Logistics, less the march's own food — about 1b on
100,000 transports at Logistics 10. A minimum batch waits until it fits,
unless the city is down to half of localAmount. `*` means "doesn't matter", `troopType`
carries the resources (transports by default), and `<from>` is `any`, a city name or `x,y`,
several joined with `|` (`!Name` in NEAT's wiki is only markup, and reads as `Name`).
`/below:<amount>` is ours: start asking only under that amount, then fill to localAmount.
`/maxdist:<tiles>` is ours too, and works on every one of these lines, request and
send alike: never reach farther than that. `requestresources any wood 2m 200k * 500k /50`
takes wood from any city within 50 tiles and passes over the rest, saying how far each one
was; on a `keepresources` or `sendresources` line it passes over receivers the same way.
`/50` on its own is the short form of `/maxdist:50`. The distance is the one the plan's
notes already print, this city's `x,y` to the other's, and a distance that can't be read
is an error, so the line doesn't run rather than reach across the map.
`/steps:<a>,<b>` is ours too, for evening an account out, the poorest city first:
`requestresources any gold 20000b 20000b 100m * t /steps:1000b,10000b` works at 1t, then
10t, then 20t (localAmount). At each level a city under it takes from cities over it, never
taking them below it; a level waits while any city with the same line is still under a
lower level that another city could fill (by a minimum batch). The richest free city sends
(one still out on a mission here is not waited for). At the last level remoteAmount is the
senders' floor, so cities already at the top neither receive nor pass gold round among
themselves. A `/steps` line doesn't count as the sender's own floor for other lines.
Across resources the stepped lines go lowest step first, then the emptiest (what the city
holds over its step), so gold in trillions doesn't take every free sender from iron. Each
sender makes one trip to a city at a time unless the line says `/slots:N`.
**Food never goes past 950b in a city** (it resets to 0 at 1t): no request, keep or send
line fills one of our cities past it, counting what is on its way.
A line with an error doesn't run. Rules for each line:
- What is already on its way counts: our transports and reinforcements heading in, and
  market purchases in transit.
- **Lowest first:** a sender leaves a resource for another of our cities that holds less of it,
  is asking for it, and that it could send to right now (no mission to it still out, near
  enough, something over that line's floor). The neediest city takes every sender first.
- The **nearest** city that can send the whole batch sends it. It needs enough over its
  remoteAmount, spare transports (a quarter stay home for farming) and a free rally slot.
  If no city can send it all, the one that can send the most does.
- Only **one mission at a time** between a sender and the city, going or coming back, as
  in NEAT. `/slots:N` on a line allows more. While the nearest sender is still busy with
  this city, the line waits for it instead of calling on a farther one.
- Lines one sender serves ride in **one march**: food, wood and stone from one city is a
  single transport.
- **A march takes at most 10,000 troops per Rally Spot level** of the sending city, every
  kind together (100,000 at L10). A bigger batch goes over several marches, and the plan
  says when a sender's march is full.
- **Carriers are counted the way the game counts them**: each holds its load raised by the
  account's Logistics (+100% at Logistics 10: a transport 10,000, a cavalry 200, a scout 10;
  read from `army.getTroopParam` for the sending city when the console has asked it, else
  from the login; unread, the base load, the plan says so and the transport asks for it),
  less the food the march carries for its own trip at its slowest troop's speed. A minimum
  batch is judged on that. Scouts eat 10 an hour, so a city too far for a carrier to feed
  itself gets nothing on it, and the plan says so. The same cap holds for every
  march the bot sends: a hide march takes the most valuable troops up to it and says how
  many stay home, and anything else over it is refused before it is sent.

**Surplus goes where it is wanted.** These lines go in the sending city.
`keepresources <to> f:1b,w:20m [minBatch] [troopType]` keeps that much in the city and
ships everything over it.
`sendresources <to> <type> <localAmount> <remoteAmount> [minBatch] [maxBatch] [troopType]`
sends while this city holds more than localAmount and the receiver holds less than
remoteAmount. `keeptroops` and `sendtroops` do the same for troops, counting only the
troops at home. `<to>` is `any`, a city name or `x,y`, several joined with `|`; coordinates
can be another account's city, which works with keep lines or a `*` remoteAmount.
Receivers are served nearest first, one mission each unless `/slots:N`, no farther than
`/maxdist:<tiles>` when the line says one, a quarter of the transports stay home, and a war
town sends nothing. Neither a send nor a sale leaves the
city short of what its other goals need: a day of hero salary in gold, the food for the
next comfort, and the next construction's cost.

**The market keeps the rest in line.** With `config trade:1` the city trades toward its
`tradepolicy /type:<res> /min:<amount|Nd> /max:<amount> /batch:<amount>` lines, or
`resourcelimits <food> <lumber> <stone> <iron>`. `Nd` is N days: of troop upkeep for food,
of hero salary for gold. It never bids gold below gold's `/min` and buys what is under
`/min` with the spare. It sells what is over `/max`, using the proceeds for resources under
`/max`. It sells for gold in an emergency (gold under a day of hero salary, or food under 30
minutes of upkeep). `/allowselltomin` and `/donotautosellabovemax` work as in NEAT. Orders
take only what the market already offers, each at its own price, paced 1.2 s apart. Offers
of ours that sit unfilled for 20 minutes are cancelled (the fee is lost), and a running
`holidaysnipe` is left alone. With neither kind of line, `config trade:1` trades on NEAT's
built-in values, buying wood, stone and iron up to 20m each, so write the lines first.

### NPC farming, valleys and flats

**NPC farming works the NEAT way.** `config npc:<n>` farms level n and up, highest first.
It picks camps by the first rule that is set: `npclist`, `npcbounds`, `farmingpolicy`
`/mindistance` `/maxdistance`, then `distancepolicy`'s first number
(`distancepolicy <farming> <building> <valley> <acquire> <scan>`), otherwise 10 tiles,
measured the short way round the map. `excludelist` always applies. Each camp is hit again
8.4 hours after its last hit, or on `config farmingcycle`, a level's `farmingpolicy`
`/cycle`, or hourly under `config training:1` (levels 1-9) and `training10:1` (level 10).
`config farmingcyclemin`, `/mincycle` or `config smartfarming:2` hit the camp worth most
per trip instead, and smartfarming 1 and 3 take only the transports the refill needs.
Levels 1-5 need Military Tradition at level+2 and Archery 10, Archery 9 with Horseback
Riding 8 or 9, or Archery 8 with Horseback Riding 5 or 6. Levels 6-10 need `npclimits`
(troops that must be home before a run leaves) and `npctroops`. `npcheroes` says which
heroes go (a line with no level covers levels 1-5), `npcteams` how many runs may be out
(10 by default), and `config npclimit:<days>` stops farming once the city holds that many
days of food. Intel heroes and the best politics hero stay home unless
`config trainint:1` (intel heroes farm first) or `config trainpol:1` (the politics hero
goes first while another hero stands in as mayor). The farming history resets after
maintenance. The console reads the map around every farming city by itself, a few blocks
a minute and each block every four hours, so a new city finds its camps;
`config mapscan:0` turns that off.

**Valleys and flats, the NEAT way.** `config valley:10` captures level-10 valleys of the
city's main resource: forests for lumber, hills for iron, deserts for stone, lakes for
food. Add `config valleymin:5` to take the highest level from 5 to 10 first, and to swap
the lowest valley for a better one once the slots (the Town Hall level) are full.
`config valleyfarming:10`, with `valleyfarming <forest> <desert> <hill> <swamp> <grassland> <lake>`
miles, hits valleys hourly once every slot is full. `safevalleyfarm 9,10` scouts valleys
and hits only the ones it can take without losses. `config hunting:5` hunts medals by
capturing a valley and letting it go before the next wave; `huntingpos` and `huntingtype`
say where. `config acquireflats:1` holds nearby flats, and `config abandonflats:1` lets the
ones below buildnpc's level go just before maintenance so they level up.
`config buildnpc:5` (or 10, 15, 20) captures a flat, founds a city on it, and hands it
back as an NPC; `npcbuildpolicy /level:10 /mindistance:1 /maxdistance:5` says how far out.
`valleytroops`, `valleyheroes` and `valleylimit` choose the troops, the heroes, and what
stays home. Before any march the game is asked who holds the tile, nothing marches from a
war town or a city under attack, and a valley is given up only for the reasons above.
`config abandon:1` strips a city you plan to give away (its queues, troops and walls go,
the tax goes to 100 and levies drain its loyalty), but only once its `troop`,
`fortification`, `taxpolicy` and `comfortpolicy` lines are gone and `comfort:0` is set. It
never acts in your only city.

### Heroes

**The mayor is always a hero at home**: the best politics hero, or the best attack hero
while troops are being queued, promoted straight over the old one. It is left alone under
`config hero:0` or `config nomayor:1`.

**Levelling, points and firing.** With `config hero:1` or higher, heroes are levelled and
any points no `heropoints` line covers go into their best stat. `heropoints <hero> att:500 int`
spends them in stages, and `nolevelheroes` names heroes left unlevelled. Heroes are fired
only when a slot is needed — for a hire, or for the training hero coming round — or with
`keepheroes /always` (ours), or `keepheroes /firebelow:<n>` (ours) which lets an idle hero
under level *n* go for a slot even under `config hero:1`.
`config hero:XY` keeps X good politics heroes and Y intel
heroes and the rest attack: the bot sets those aside, then fires the worst attack score.
It never fires a hero `keepheroes` protects (with no `keepheroes` line, NEAT's default
`any:level>=50|any:base>=69`), the mayor, a hero that is out, a prisoner or the training
hero. `feastinghallspace` only says where hiring stops. The hall's free slots are read from
the inn when needed.

**Captured heroes, and letting them go.** A prisoner sits in a Feasting Hall slot, so the
level-2 hero a conquered valley drops into your cell quietly blocks the training hero's
round until somebody notices. Write a `keepcapturedheroes` line and the bot **releases the
prisoners it does not keep**:

```
keepcapturedheroes any:level>600|any:base>145
```

keeps a prisoner past level 600 or with a base over 145 and lets the rest go. With **no
line the goal is off** and nothing is ever released, as before — the line is the opt-in.
One release a pass, on a cooldown, never off a half-loaded roster, and always by hero id.

**A hero of your own is never released.** Releasing a captured hero from the captor's side
loses it (EVONY-RULES.md §5) — the owner uses a Stone of Finding (`lostheroes`, then
`recover`). A captured hero leaves its owner's roster the moment it is taken, so a live
roster cannot tell you it was yours. Every console therefore writes its own heroes into a
**fleet register** (`fleet_heroes` in `evony.db`) that is kept forever, and before any
release the bot refuses when the prisoner's **id** is on that register, when any hero of
yours has ever carried its **name**, or while the register is **incomplete** — an account
that has not reported its heroes in 24 hours could be this prisoner's owner. `release
<name>` still works by hand, and `OTTO_NO_RELEASE=1` stops every release fleet-wide.

A prisoner you persuade is judged by `keepcapturedheroes` (with no line, NEAT's default
`any:level>=200|any:base>69`), not `keepheroes`. `herofirelimit N` and
`capturedfirelimit N` are read as `keepheroes any:level>=N` and
`keepcapturedheroes any:level>=N`.

The Director marks an account holding prisoners: a violet edge down its row, a **Prisoners**
column, and a "Holding prisoners" view.

**A city with no hero of its own** has no mayor, trains nothing, defends with nobody, and
traps the training hero when it arrives — the trainer becomes the only hero, takes the
mayor's office, and has to be stood down again to leave. So such a city fills itself,
ahead of every other hero goal and without waiting for `config fasthero`: an **Ardee's
Sigil of Recruitment** first, then a **Crystal of Attunement**, opened in that city so the
hero lands there; failing that, the best offer the inn has that the city can pay for, with
no base bar. A city whose whole roster is one visiting training hero, or one prisoner,
counts as empty. `config hero:0` switches it off. Right after a login the inventory has not
arrived, and no box is ruled out on that.

**A city holding ten** has no slot for the training hero. It is freed in the order that
costs least: a prisoner `keepcapturedheroes` does not keep goes first; failing that the
weakest idle hero is **marched** to the nearest city of the account under 9 heroes with a
free hall slot — nothing is lost, and it works under `config hero:1`; only then is anyone
dismissed, and that needs `config hero:XY`, or `keepheroes /firebelow:<n>` to let an idle
hero under level *n* go. The march carries one scout, so a city with none sends nobody and
says so — and the training hero's own move is now held back for the same reason instead of
standing the mayor down for a march that cannot go.

**The training hero never holds the office alone.** While it is the only hero in a city it
is passing through, it is stood down as mayor and not re-appointed until that city has a
hero of its own.

**Hiring and rewards.** With `config hero:10` or higher and `config fasthero:65`, each city
hires from its inn by itself. It reads the inn at most every ten minutes and hires the
best offer the makeup still wants whose base is 65 or more, one at a time, as long as over
1,000,000 gold stays in the city after paying level × 1000. It stops when
`feastinghallspace` slots are free, plus one while a training hero is on its way. When
the hall is full, it fires one idle hero below the bar that `keepheroes` doesn't protect
to make room for a better offer. At `fasthero:120` or more it judges attack + intel −
level. It never refreshes the inn (`innrefresh` pays game coins only with `force`) and
never hires an offer that needs an item. With `config hero:1` or higher, heroes below 100
loyalty are rewarded with gold (level × 100), lowest loyalty first, one at a time, always
keeping a day of hero salaries in the city.

**The training hero.** `traininghero <hero> [minStay] [maxStay] [npcHits]` sends one hero
round every city whose goals list it. It stays at least minStay seconds (600 by default),
then leaves after maxStay seconds or npcHits NPC runs from that city, whichever comes
first. It moves only from home (idle or mayor), and every city on its round keeps a hall
slot free for it while it is elsewhere. A city is on the round once, with its own line's
stay when it has one (a city line and the prepend's both naming the hero used to leave it
"nowhere else to go").

**Keeping Excalibur on a hero.** `keepherobuff <hero> <excalibur|wealth|artofwar> [/below:<n>]`
(OTTObot's own; NEAT has no such goal) keeps a 7-day attribute item running on a hero: the
city holding it uses one when none is running, and a new one when it runs out. With
`/below`, only while the hero's own attribute (before the item's +25%) is under n —
`keepherobuff OTTO excalibur /below:1526` keeps the training hero at insta catapult. It
never uses a second one on a running buff, never on a prisoner, uses one a pass, waits
10 minutes for a used one to show and holds a refused one for an hour. The engine's plan
says how long the running one has left.

**Spam heroes.** `spamheroes <hero-string>` names the heroes a script's spamattack or
loyaltyattack may send (default: base 69 or less, under level 50). `spamheroes /reset`
clears earlier lines, and from a script it lasts until the script goals are cleared. The
engine's plan lists which heroes those are. Neither the training hero nor the keepatthome
hero is ever one of them.

### Defence

**Defence reacts to the attacks the server reports.** Each hostile army is matched to the
city it is marching on, including armies already on their way when the bot logged in.
Hiding and the gate act first in a city's turn and never wait behind other goals. They
also keep their own clock: the bot looks again at the exact moment a wave enters the lead
window, so `config hiding:0.5` (30 s) and `config gate:0.1` (6 s) work as the NEAT wiki
describes. An attack under `defensepolicy /junktroop` troops (1000 by default; 0 makes
every attack count) is junk and sets nothing off; one of unknown size counts. Waves that
land at least `config attackgap` seconds apart (6 by default) are separate attacks, and
the city counts as under attack while a real one is inbound and for
`config defensecooldown` minutes (30 by default) after the last lands or is recalled.

**Hiding and the gate.** `config hiding:<minutes>` sends the garrison out just before a
wave lands, so it lands on an empty town, and brings it home once the wave has passed. It
goes to your nearest city that is not under attack itself, or where
`hidingpolicy /target:x,y` says (`hidingpolicy` is ours: NEAT works these things out
itself), and a hide march carries food at the game's own rate of twice upkeep.
`config gate:<minutes>` sets the gate for the waves inside that lead:
`gatepolicy <noattack> <regular> <scoutbomb> <mixed> <maintenance>` gives each case 0 (the
bot decides), 1 (open) or 2 (closed). It uses each wave's troop mix to tell a scout bomb
(`/scoutratio`, 0.9 by default) from a regular or mixed attack, and `/mintoggle` (10 s by
default) keeps it from flipping faster. The gate is only switched back after a wave has
landed, as soon as the server reports the battle. The console's Gate Control outranks it.

**Defence items.** `defensepolicy` uses defensive items for you, the way NEAT does.
`/usetruce:<loyalty>` spends a Truce Agreement and `/usespeech:<loyalty>` a Speech Text
when a city's loyalty falls to that value while it is under attack. `/usewarhorn`,
`/useivoryhorn`, `/usecorselet`, `/useultracorselet` and `/usepenicillin` (0 or 1) apply
those buffs while under attack. A truce covers the whole account for 12 hours, so only one
city ever sends it. The game refuses one while any army is marching at you, or while your
own attacks are out (transports and reinforcements don't matter), so the bot uses it in
the gap after a wave lands. Speech Text goes first, then the truce, then comfort. The
defence items are sent at the top of each city's turn, outside its action budget. They
are also sent between ticks: a wave landing, the last wave leaving, or loyalty falling
to a line wakes the engine within about 1.5 s. Items are used only if you hold them,
never on top of a buff that is already running, and never while you are in truce; the
plan line says why each one is waiting. The log has a line for each wave (landed or
turned back, its time, the loyalty) and for each loyalty change while a city is at war.
Each use says how many seconds after the last wave it went. The Director's header counts
the accounts under attack right now (armies inbound, or a wave in the last 30 min). Each
such row has an "under attack" badge, and hovering over it names the cities.

**War Town.** `config wartown:1` or `2` (or War Town Mode on the console) locks a city down
for war. It sends no NPC farming or valley runs, buildnpc stands down, and no resource or
troop transfers leave it, though other cities can still supply it. With 1 the training
hero comes and goes as usual; with 2 it stays once it lands there. When you switch it on,
the city recalls the marches it still has heading out, once each, with its own castle id;
armies coming home or camped elsewhere are left alone. `wartownpolicy 06:00 12:00 [...]`
applies the lockdown only during those hours, on this machine's clock.

**Heroes kept home.** `config keepatthome:1` keeps your best attack hero home (never the
training hero; the second best while `config training` is on), and `homeheroes N` keeps N
heroes home while farming (the mayor doesn't count). Hiding can still use them to lead an
escape.

**The embassy and alliance chat.** `config embassy:1` keeps the Embassy's "allow alliance
troops" box open, `0` keeps it closed, and `2` opens it only while the city is under
attack and for `config defensecooldown` after. Only cities that write the setting are
touched. `config warrules:<minutes>` tells alliance chat about a real attack at once, again
every that many minutes while the picture changes, and every five times that while it
doesn't. The message is deliberately short: alliance chat is not private.

### Reports, hours and priorities

**Report cleaning.** `reportstokeep 1 a:500 b:1 a:3800 a:6000` opens the account's NPC and
valley attack reports a few at a time and deletes the ones not worth keeping. It keeps
reports with treasure, valley attacks losing 500 archers or more, npc5 attacks losing a
ballista, and npc10 attacks losing under 3,800 or over 6,000 archers; a 0 keeps every
report of that kind. Lost battles, captured heroes and anything that isn't an NPC or
valley attack are never deleted. It runs from the first city that has the line.

**Quests claim themselves, the free daily amulet with them.** The game's Quests window has
a Routine tab and a Daily tab, and a finished quest waits there until someone presses
Claim. Every city with goals looks at both tabs, claims what is finished, and looks again:
half an hour after a quiet look, a minute after a claim (a claim can open the next quest in
a chain), ten minutes after the server refuses. A tab whose quest types all say "nothing
finished" costs exactly two requests, so a quiet account is almost free. **It is on without
a goal line**, because a free amulet a day is not worth forgetting; `config
completequests:0` turns it off in a city, `:1` claims everything but the Promotion quests,
`:2` claims those in the game's own order and `:3` (the default) takes a title before a
rank — a title is worth having on its own, since the city cap is titleId + 1. The key is
ours; NEAT keeps the same four choices in its Global Settings. An account whose goals have
been emptied for a holiday is never visited, so it claims nothing. The `completequests`
script command is unchanged and claims on demand, whatever this key says.

**Office hours and mission priorities.** `schedulepolicy 06:00 12:00 17:00 23:00` lets a
city act only in those hours, on this machine's clock. Its defence never stops: hiding, the
gate, emergency walls, defence items, the war town recall, warrules and the embassy still
act, and the training hero doesn't leave the city outside them.
`processingpolicy n:10 m:20 *:5` weighs npc farming (n), buildnpc (b), valley farming (v),
safe valley farming (s), valley acquisition (a), medal hunting (m), sendtroops (t) and
sendresources (r). Each mission sent adds points to its task and the fewest points go
first, so `m:20` sends about twice as many medal hunters as `n:10`. `!b` or `b:0` turns a
task off, `*`/`!*` covers the rest, and `/start:13:00 /end:14:00 !n` does it for an hour.
Rescue (q) is accepted and does nothing: the wiki itself isn't sure what it is.

### Account-wide goals and scripts

**New cities and global goals.** When a city is founded or captured, OTTObot gives it the
account's *New-city template*, but only if the city has no goals yet. It logs the line
count and records the city in the registry at once. A console (not `goalsd.js`) also runs
the account's *New-city script* once there, if you have written one. Around every city's
own goals run two account-wide texts, *Prepend goals* and *Append goals*. The city's own
goals come first, then the prepend goals, then the append goals, and that is also the order
of priority: a config key or a one-per-city goal (`comfortpolicy`, `defensepolicy` …) that
an earlier text already set is kept, so the city's own line beats the prepend's and the
prepend's beats the append's. Troop, build and fortification lines stack in the same order.
(NEAT reads PrependGoals first and lets a later text win; this order is the user's.) A
script's goal lines still win over all three. The Director can keep either text in step
with a file: ✎ on the account, then a path under *Prepend goals file* or *Append goals
file*, typed or picked with Browse. It checks the files every 15 seconds and copies a
changed one in, so edit the file, not the console's editor. Errors say which text they are in ("append
line 3: …"), and every city's plan says so while a global line is broken. The texts are
read every turn, so an edit counts from the next one. An account without a template is
offered NEAT's default !NewCityGoals.txt, word for word. Cities that buildnpc builds to hand
back get neither the template nor the script.

**Goals set by scripts.** A script can change the goals a city is running without touching
the saved ones, as NEAT allows. A script's `config npc:5` or `goal <line>` runs after the
city's saved goals, so its settings win. `loadgoals N` runs the account's goal set N (Goal
set 1 to 9 in the goal editor) in place of the city's goals. `loadgoals <city>` runs
another city's saved goals instead. `resetgoals` stops all goals until the script sets new
ones. A bare `loadgoals`, the **Clear script goals** button, saving the city's goals, or
restarting the console puts the city back on its saved goals. While a script's goals are
active the goal editor's hint and the engine's plan say so.

### NEAT goal files

**A NEAT goal file reads as it stands.** All 46 config keys the NEAT wiki documents are
accepted, and each does what its page says (`monitorarmy` does nothing, as in NEAT).
`troopslot`, `freespeedup`, `completequests` and `mapscan` are ours. A config key written on its own line
(`wartown 1`) is read as `config wartown:1`, with a note. NEAT's obsolete lines
(`ballsused`, `npc10troops`, `npc10list`, `npc10limit`, `npc10heroes`, `npcexcludelist`,
`npc10excludelist`, `noabandonflats`, `capturedfirelimit`) are read as the goals that
replaced them, and the editor says so. A value that can't be read is an error,
never a silent 0. NEAT's `set name value` and `%name%` work in scripts, not in goal files.

### Modules

Most modules export `{parsers, plans, executors, configKeys}` and are wired generically;
the exceptions are under the table.

| module | covers |
|---|---|
| `goal-upkeep.js` | comfort, comfortpolicy, taxpolicy, levies, production, warehousepolicy, healing |
| `goal-war.js` | incoming attacks, hiding, gate and gatepolicy, war town, keepatthome, attackgap, defensecooldown, embassy, warrules |
| `goal-heroes.js` | hero strings, keepheroes, keepcapturedheroes and releasing, heropoints, levelling, firing, hiring, rewards, spamheroes, keepherobuff, empty cities, freeing a full hall |
| `goal-npc.js` | NPC farming — camps, cycles, research gate, troop sizing, the background map scan |
| `goal-buildnpc.js` | turning flats into NPC camps (**off by default**, see below) |
| `goal-valley.js` | valleys, valley farming, safe valley farming, hunting, flats, abandon |
| `goal-transfer.js` | requestresources, requesttroops, keep and send lines — nearest sender, one march per sender |
| `goal-trade.js` | config trade, tradepolicy, resourcelimits — the market |
| `goal-reports.js` | reportstokeep |
| `goal-quests.js` | completequests — the Routine and Daily quests, claimed on their own |
| `goal-research.js` | research |
| `goal-plan.js` | plan lines |
| `processing.js` | schedulepolicy, processingpolicy |
| `goalmods.js` | defensepolicy items, training heroes, mayors |
| `goallayers.js` | the account's texts (template, prepend, append, goal sets, new-city script) and the script goal layer |
| `speedups.js` | free finishes |

`goal-research.js`, `goal-plan.js` and `processing.js` bring their own parsers, but the
engine plans them itself, around the builder and the action budget. `goallayers.js` and
`speedups.js` are not goal modules. Neither is `rally.js`: it is the rally slots they all
share, and `rallypolicy`. The build, troop and fortification lines are `engine.js`'s own.

## Upgrading from the old goals

Saved goals keep loading after an update, but some lines now mean what they mean in NEAT,
not what they meant here. Two one-off tools rewrite saved goals. Both are dry runs unless
given `--apply`, work on the database `EVONY_DB` names (else `evony.db`), and save every row
they change in `json-backup/` beside it first.

**Request lines: run `migrate-goals-transfer.js` once.** `requestresources` and
`requesttroops` took this tool's own order (`<min> <max> <batch> <keep>`) and take NEAT's
now. `node migrate-goals-transfer.js` prints every change, and
`node migrate-goals-transfer.js --apply` writes them (`--account <id>` for one account). Each
old line becomes the NEAT line that does the same:
`requestresources any wood 100000 2000000 500000 200000` becomes
`requestresources any wood 2000000 200000 * 500000 /below:100000`. A line that already has
`/below` is left alone, so a second run changes nothing. Until it runs, an old line reads in
the new order: one whose batch is bigger than its keep is an error, and the rest fill the
city only to the old minimum and keep the old maximum in every sender.

**Build lines: usually leave them.** A `build` target means "at least" now, and nothing
comes down without a 0. `c:10:1,b:10:1` used to mean exactly one cottage and one barracks
at L10, and the old engine demolished any others; now they stay.
`node migrate-goals-build.js` rewrites each such target as `c:10:1,c:0:1`, which brings
those demolitions back (`--db <file>` reads another database). Apply it only if you want
them.

**What changes on the first start:**
- **Tax goes to 0%.** With `config comfort:1` and no `taxpolicy` line the range is NEAT's
  `0 100`, so the tax sits at 0% and rises only when a city has less than a day of hero
  salary banked. Add `taxpolicy N N` to pin a rate or `taxpolicy 20 100` for a floor, in
  each city or in the Prepend goals.
- **`troopsusepopmax` works.** It used to do nothing. While troop batches need more than
  the idle population, production is set to 0 for a few seconds so field workers can
  train, and resource output drops until the population grows back. Remove it, or set it
  to 0, to train from idle population only.
- **`config hero:1` spends points and gold.** Points no `heropoints` line covers go into
  each hero's best stat, which only Holy Water undoes, and heroes under 100 loyalty are
  rewarded with gold (level × 100), keeping a day of salaries.
- **Defence items get used.** A `defensepolicy` with `/usewarhorn`, `/usecorselet` or
  `/usepenicillin` uses them on the first real attack, for the whole account, and
  `/usetruce` spends a Truce Agreement once loyalty falls to its number while under attack.
- **Build lines run in order.** A later line waits while an earlier one has work to do,
  and a missing one-per-city building with no plot stops the lines with `Needs space: …`.
- **NPC farming needs research.** Levels 1-5 farm only with the research NEAT's FAQ names,
  and pause with a note without it. Camps are picked within 10 tiles unless a rule says
  otherwise (it was 20), and the farming history resets after maintenance.
- **The new-city template.** An account's `default` goals are its New-city template now,
  and open from the editor's selector. A city founded or captured gets its copy the moment
  it appears, and the log says so. Cities buildnpc builds to hand back get none. A template
  line like `s:0:0` takes down every sawmill in a captured city, so read it first.
- **The barracks are the training hero's.** With a `traininghero` named, another hero
  queues only what it builds instantly while the hero is away — instant batches leave
  their slot free, a 30-minute one holds it, and nine of those meant the training hero
  arrived to a full barracks and trained nothing. `config trooptraineronly:0` or
  `/traineronly:0` goes back to NEAT's `troopidlequeuetime` rule.
- **Also:** troop ladders fill the barracks faster (up to 20 batches a turn); comfort
  popraises only below the population limit and prays or gives relief only when that helps; wounded troops are
  healed; construction no longer waits behind troops, and waits for resources instead of
  backing off for hours; early levels are finished for free; the engine's state moves from
  city names to castle ids, and the log says so once.

**Before switching on:** `config trade:1` with no `tradepolicy` or `resourcelimits` line
trades on NEAT's built-in values and buys wood, stone and iron up to 20m each in every
city. `config abandon:1` disbands a city's troops and destroys its walls. `config valleymin`
and `config hunting` give valleys up by design.

## Safety

**`buildnpc` is default-deny.** `city.giveupCastle` is irreversible and takes the account
password, so abandoning is gated on a persistent registry keyed by **fieldId** — cities
teleport (`city.advMoveCastle` keeps the castleId, changes the fieldId), so identity is
resolved by castleId first. `abandonable=1` is reachable only through `claimFlat()` →
`markBuilt()`, and the claim is written *before* the build. Anything that turns up
unrecorded — a capture, a purchase, a hand-built city — is permanently protected however
empty it looks. `test-buildnpc.js` was verified by sabotage: deleting any single guard
clause makes tests fail.

**`allowabandon` is the one way past that, and it is for a person.** A flat-city founded
by something else — NEAT's `npcbuild`, the game's own client — is protected for good by
the rule above, which is right for every city but that one. `allowabandon <city> confirm`
records the row as `origin='adopted'`, which `abandontown` accepts and **the goal engine
never does**: `buildnpc`'s own guard demands `origin === 'buildnpc'`, so the engine can
still only give up what it built itself. `allowabandon <city> confirm off` undoes it, and
a city that teleports loses it automatically.

**The account's security code** — the game's second password — guards five irreversible
actions: abandoning a city, disbanding troops, dismissing a hero, the tax rate and
restarting the lord. `security.js` answers the game's `-200` refusal by authenticating
once a session, unlocking that one action and sending the command again; see EVONY-RULES.md
§5c. The code is stored per account, read at the moment it is wanted, never logged, and
OTTObot never sets, changes or removes one in the game.

**Maintenance.** The server announces maintenance ~15 minutes ahead on
`server.SystemInfoMsg`. The bot stands down 5 minutes before, sits out the window, then
recovers on a 5-minute ladder — probing with a bare **TCP handshake**, never a login.
Reachability costs a handshake; a login is a scarce, account-scoped resource, and
spending them against a server in maintenance is believed to be what earns a block.

## Organizations

Every user belongs to one or more organizations, and **all customer data is scoped to
one**: game accounts, goals, snapshots, engine state, the city registry, proxies, probes
and uptime. The org comes from the signed-in session, never from a request parameter.

The risk being defended against is one missing `WHERE orgId = ?` — the `accounts` table
holds other people's game logins in plain text, so a leak there is a breach, not a bug.
So the defence is structural: callers never get an unscoped handle. They call `D.org(id)`,
which closes over the org and applies it to every read and write, and anything reached by
account id is checked for ownership first — an id guessed or leaked from elsewhere simply
does not resolve. `test-tenancy.js` covers that from both directions.

The **map cache is deliberately shared**. It describes the game world, not a customer, and
every tenant scanning it makes it better for everyone. The one piece of tenant data that
used to live there — "is this city mine" — is computed at read time instead.

First run:

```bash
OTTO_PASSWORD='...' node migrate-tenancy.js you@example.com "Your Fleet"
```

That creates your user, your org, and moves any existing single-operator data into it.
Registration is closed by default; `ALLOW_SIGNUP=1` opens it.

## Running it on a server

It is portable — the only Windows-specific thing was the NEAT process scan, which
now short-circuits off Windows. Node 24+ is the only requirement.

**Binding to anything but loopback requires at least one registered user**, because
otherwise the first stranger to find the port becomes the operator:

```
REFUSING TO BIND 0.0.0.0: no users exist yet.
```

Passwords are scrypt-hashed with `timingSafeEqual`. Sessions are 32 random bytes,
httpOnly + SameSite=Strict, 12h expiry, revocable per user. Failed logins back off
exponentially per IP, and a wrong password and an unknown email return the *same*
message so the form cannot be used to discover who has an account here.

**Put TLS in front of it.** The login cookie is only marked `Secure` when a proxy sets
`X-Forwarded-Proto: https`. Over plain HTTP on the open internet the password and cookie
travel in clear text. Terminate TLS at Caddy or nginx, or reach it through an SSH tunnel
(`ssh -L 8712:localhost:8712 host`) and leave it bound to loopback — the tunnel needs no
password at all and exposes nothing.

## Storage

One SQLite file, `evony.db` (see `STORAGE.md`). It holds accounts, **snapshot history**,
goals keyed per account (each city's own, and the account's template, global goals, goal
sets and new-city script), engine state keyed per `(account, castle id)`, the shared map
cache, uptime samples and the city registry. Goals a script sets are kept in memory only.

`evony.db` is gitignored — it contains every account's password in plain text.

## Tests

Run the offline suites by name, each against a throwaway database so nothing touches
your `evony.db`:

```bash
for t in test-enginestate test-goals test-war test-npc test-heroes test-buildnpc \
  test-queue-cancel test-maint test-maint-fleet test-tenancy test-teleport test-holiday-snipe test-mail \
  test-stone-of-finding test-rename-hero test-transfer test-water-hero \
  test-timed-march test-auth test-city-editors test-items test-snapshot \
  test-goal-lines test-incoming test-defence-items test-wartown test-build-neat \
  test-newcity test-speedups test-hero-fixes test-neat-compat test-script-layer \
  test-prereq test-hiring test-upkeep test-npc-parity test-resources-market \
  test-misc-goals test-research test-troop-parity test-valleys test-plan-schedule \
  test-captured-heroes test-goal-quests \
  test-script test-script-lang test-script-objects test-script-functions \
  test-script-regex test-script-net test-script-post test-script-deploy \
  test-script-city test-script-hero test-script-account test-script-market \
  test-script-info test-script-social test-script-goals test-script-console \
  test-script-compat test-script-safety test-botctl test-director-fleet \
  test-director-accounts test-proxy-pick test-holiday-login test-statistics test-monitor \
  test-armies-tab test-glitch-log; do
  EVONY_DB=/tmp/otto-$t.db node $t.js; rm -f /tmp/otto-$t.db*
done
```

2,934 tests in 65 suites, no network required. `test-holiday-snipe` has 10 known
failures, which it had before the goals and scripts build-outs.

**Never run `test-*.js` as a glob.** `test-scope`, `test-login`, `test-raw`, `test-block`,
`test-buy`, `test-wall`, `test-clean`, `test-castle`, `test-ctx`, `test-shapes` and
`test-lookup` log in to the live game.

## Not in this repo

- `.env`, `evony.db`, `accounts.json`, `proxies.txt` — credentials
- `src/` — the decompiled 1922 client. It is the authority for every command and field
  name, but it is someone else's copyrighted code.
- `ffdec/`, `*.pcap`, `payloads*.txt` — tooling and captures
