# Storage

Everything persistent lives in one SQLite file: **`evony.db`** (plus `evony.db-wal`
and `evony.db-shm`, which are part of it — back up all three, or none).

`node:sqlite` ships with Node 24, so this stays dependency-free.

## Tables

| table | what it holds |
|---|---|
| `accounts` | id, label, server, email, password, enabled, notes, pinned proxy |
| `snapshots` | one numeric row per Director poll — **history**, not last-value-only |
| `account_latest` | the bulky part of the newest snapshot (items, city list) |
| `goals` | goal and script source, keyed `(accountId, cityKey, kind)`: a city's goals are cityKey `<cityId>`, its script loadouts kind `script`, cityKey `<cityId>:load1`…`:load10`. The account's own texts use keys no city can have (a city's is its castle id, all digits): `default` the New-city template, `prepend` and `append` the goals every city runs before and after its own, `set1`…`set9` the goal sets a script's `loadgoals N` runs, and kind `script`, cityKey `newcity` the New-city script |
| `engine_state` | the engine's bookkeeping, one row per key: each city's under its castle id (`lastFocus`, `troopStage`, backoffs, npc cycles, mission points and the other goals' timers), `hero` for the traininghero's round, and the `_keyedBy` marker |
| `map_cache` | every castle and NPC camp seen, and the flats and valleys around the cities the background map scan covers, with a `seen` timestamp |
| `tile_levels` | one row per level change of a tile: free flats and valleys go up a level at each maintenance |
| `city_registry` | every city the tool has seen and where it came from — buildnpc's abandon guard (README, Safety) |
| `settings` | proxy list text, watchlist, uptime probe list, each account's maintenance plan (`abandonflats` reads it) |
| `uptime` | one row per probe per minute — a **gap** means the bot was not running |
| `player_snapshots` | prestige history for the offline-detection watchlist |

## What this fixed

- **No history.** Snapshots were overwritten each poll, so nothing could be charted.
- **Torn writes.** `mapcache.json` was a 150 KB whole-file rewrite with two
  writers and no atomicity; a crash mid-write truncated it. Now one transaction.
- **Two competing goal stores.** `goalstore.json` and the browser's localStorage
  disagreed silently. One store now.
- **Cross-account goal leakage.** The old `default` key was global, so a new
  account silently inherited Lord22's build order. Goals are per account now.
- **Cross-city goal and script leakage.** A city with no goals of its own showed
  and ran the account's `default`, and one saved empty went back to running it;
  script loadouts were ten per account, so Load 1 was the same in every city. Now
  each city reads only its own rows (`db.goals.own`, `db.goals.loadouts`). The
  first time a city is seen it gets a **copy** of what it used to fall through to
  (its name's row, the account `default`, or the account-wide `load1`…`load10`),
  so nothing that ran before stops; those rows are only seeds after that.

## What the NEAT goals changed

- **The account's own texts are goal rows.** NEAT keeps !NewCityGoals.txt,
  !PrependGoals.txt, !AppendGoals.txt and !NewCityScript.txt as files beside the
  bot; here they, and the goal sets a script loads, are rows of `goals` under the
  keys above. The
  template reuses the `default` row, which add-account.js and the old /goals page
  already wrote, so every account that had one keeps it as its template and
  nothing is migrated. A template saved empty means "no template": the
  install-wide default no longer seeds that account's cities. The account keys
  are kept out of the by-name lookup, so a city called "prepend" is never seeded
  from the prepend goals.
- **New cities are seeded when they appear.** The copy of the template is made
  the moment the server reports the city (`db.goals.seed`), and logged, not on the
  engine's first read. A city with a row of its own, an empty one included, is
  never overwritten. A city buildnpc built to hand back gets an empty row.
- **Script goals are never stored.** The goal lines a script sets (`goal`,
  `config`, `loadgoals`, `resetgoals`) live in the console's memory, on top of the
  saved goals (`goallayers.js`). A restart, saving the city's goals, a bare
  `loadgoals` or **Clear script goals** ends them. `loadgoals N` copies the goal
  set's text when it loads, so a later edit to the set changes nothing until the
  next load.
- **Engine state is keyed by castle id.** It was keyed by city name, and names are
  not unique (a new city takes the server's default name), so two cities could
  share one set of backoffs and timers. On the first start each account's name
  rows are moved to the city or cities of that name (each keeps a copy when
  several share it), the name rows are deleted, and a `_keyedBy` marker stops it
  happening again; the log says what moved. The engine's per-city plan reports
  (the console's Engine view) are kept by castle id too, in memory.
- **The map cache holds the terrain too.** The console's background map scan reads
  a few 20×20 blocks a minute around the cities that farm, build NPCs or have a
  valley goal, and keeps every castle and camp and the empty flats and valleys it
  sees. Which block is due comes from the tiles' own `seen` times
  (`mapCache.blockSeen`): a block is read again after 4 hours, or at once when it
  holds NPC camps cached without a level. Writing a scan looks up each tile's
  previous level by its id instead of loading the whole table. NPC farming reads
  only the camps (`mapCache.npcs`), and reportstokeep one tile at a time
  (`mapCache.tile`).
- **The registry learns of a city at once.** A city that appears is recorded
  the moment the server reports it. buildnpc writes its claim when it founds a
  city on a flat it has captured, just before the build (it used to be at the
  capture), and a capture or founding that fails marks its pending row
  abandoned. Nothing else changed in how a city becomes abandonable.

## Running it

    node director.js                                   # fleet + uptime, :8712
    node server.js                                     # console for .env account, :8711
    CONSOLE_PORT=8713 ACCOUNT_ID=a2 node server.js     # console for another account

The console's goal engine is always live; its pause button is the only thing that
stops it acting, and a restart resumes it.

**One process per account.** A second login for the same account gets kicked, and
the two supervisors then fight and trip the server's rate limiter. The Director
asks every configured console who it holds and skips those accounts; `goalsd.js`
refuses to start against a console-held account.

## Migration

`node migrate-sqlite.js` imports the old JSON (idempotent).
`node migrate-sqlite.js --archive` also moves the JSON into `json-backup/`.
The JSON files are still on disk and are no longer read by anything.

`node migrate-goals-transfer.js` and `node migrate-goals-build.js` rewrite saved
goal lines for the NEAT goals (README, Upgrading from the old goals). Both are dry
runs unless given `--apply`, and both save every row they change in `json-backup/`
beside the database first. The engine state's move to castle ids needs no command:
it happens once, on the first start.
