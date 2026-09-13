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
| `goals` | goal and script source, keyed `(accountId, cityKey, kind)`: a city's goals are cityKey `<cityId>`, its script loadouts kind `script`, cityKey `<cityId>:load1`…`:load10` |
| `engine_state` | per-city engine timers (`lastFocus`, `troopStage`, npc cycles) |
| `map_cache` | every castle and NPC camp seen, with a `seen` timestamp |
| `settings` | proxy list text, watchlist, uptime probe list |
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
