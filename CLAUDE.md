# OTTObot — notes for Claude

A bot and fleet console for the live game Evony (server ss71). README.md explains the
apps, SCRIPTS.md the script language.

## Read EVONY-RULES.md before touching the live game

**Always read [EVONY-RULES.md](EVONY-RULES.md) first when a request would act on the real
game** — starting, stopping or editing a running script (trading, marches, anything),
placing or cancelling market orders, logging an account in, starting, stopping or
restarting a console or the Director, switching an account on or off, changing its proxy,
running a test file that might log in, using or buying items. It holds what has been
learned about how Evony behaves and how the fleet breaks, so the same costly mistakes
aren't made twice: a second login kicking a console, logging in during maintenance, a
rate-limited account, a hero lost to `release`, gold spent from stale balances.

Pure code work (editing files, offline tests) doesn't need it — until the change is about
to go live.

[EVONY-STRATEGY.md](EVONY-STRATEGY.md) says how the user plays and what the fleet is built
towards: alts, dump, builders, spammers, mains and banks; insta heroes; the amulet farm.
Read it when a request names a role or a plan and the reason behind it isn't obvious.

## Keep EVONY-RULES.md current

**Every lesson, as soon as it is learned — not at the end.** Whenever something goes
wrong, surprises you, or the user corrects or teaches you something about the game or the
fleet, write it down before moving on: into EVONY-RULES.md (how the game behaves, what
must never happen), and into the skill for that kind of task (`.claude/skills/…`: how to
run it, what went wrong) when there is one — or a new skill when the user will ask for the
same kind of task again. Say in your reply what you recorded. (The user, 2026-09-18.)

When you learn something about how the game behaves — a reply code, a limit, a timing,
what the server does under load, a mechanic the user explains — **add it to
EVONY-RULES.md in the same session**, in the right section, with the date and how it was
observed. Mark inferences as *unverified*. Correct or remove entries that turn out to be
wrong. Every future session relies on this file to know how Evony works.
