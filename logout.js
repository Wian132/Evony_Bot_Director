'use strict';
// NEAT's `logout`: take the console off the game for a while, then log back in.
//
//   logout now @:14:35         off now, back at 14:35 on this machine's clock
//   logout now 1:05:00         off now, back 1h05m later
//   logout @:13:40 @:14:35     at 13:40, off until 14:35
//   logout 1:00 29:00          NEAT's example: off in 1 minute, back 29 minutes after that
//
// The extra-cities recipe logs off once the build marches are out and stays off
// until a few minutes after they land.
//
// Times: `@:hh:mm[:ss]` is a clock time, anything else a wait (s, m:ss or
// h:mm:ss). The time to come back is required: NEAT's form without one leaves
// the bot off for good, and a console that never logs in again would need a
// restart to come back.
//
// Other cities' scripts in this console are waited for first, so the first city
// to finish does not cut the others off mid-send. Scripts that are themselves
// waiting at a logout do not count. Nothing runs after a logout (script.parse
// refuses it): from then on there is no game to run it against.
//
// It rides the session's stand-down (Session.logoutUntil): no login of any kind
// until the time, kept across a console restart. Pressing Connect in the
// console ends it early.

const OTHERS_WAIT_MS = 15 * 60000;

function parseWhen(t, what) {
  const s = String(t || '');
  if (/^(now|0)$/i.test(s)) return { wait: 0 };
  if (s.startsWith('@:')) return { at: require('./script').parseLandTime(s) };
  if (/^\d+$/.test(s)) return { wait: Number(s) };
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (m) return { wait: Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) };
  throw new Error(`logout: ${what} "${s}" is not a time — now, a wait (90, 1:30, 1:05:00) or a clock time (@:14:35)`);
}

function parseArgs(args) {
  if (args.length < 2) {
    throw new Error('logout: say when to log out and when to log back in, e.g.  logout now @:14:35  or  logout now 1:05:00');
  }
  if (args.length > 2) throw new Error(`logout: unexpected "${args[2]}"`);
  return { out: parseWhen(args[0], 'log-out time'), back: parseWhen(args[1], 'log-back-in time') };
}

// Server-clock ms for each end. A clock time to come back is its next
// occurrence after the log-out; a wait is counted from the log-out.
function times(a, serverNow) {
  const S = require('./script');
  const outAt = a.out.at ? S.nextOccurrence(a.out.at, serverNow) : serverNow + a.out.wait * 1000;
  const backAt = a.back.at ? S.nextOccurrence(a.back.at, outAt) : outAt + a.back.wait * 1000;
  return { outAt, backAt };
}

async function run(game, a, { session, log, dryRun, stopped = () => false, otherScripts, atLogout }) {
  const TM = require('./timed-march');
  const { outAt, backAt } = times(a, game.now());
  if (backAt - outAt < 60000) throw new Error('logout: that is less than a minute off the game');
  log(`  log out ${outAt - game.now() > 1000 ? 'at ' + TM.clock(outAt).slice(0, 8) : 'now'},`
    + ` back at ${TM.clock(backAt).slice(0, 8)} (${TM.tz()}) — ${TM.dur(backAt - outAt).replace(/\.\d+s$/, 's')} off the game`);
  if (dryRun) { log('  [dry run] staying logged in'); return false; }
  if (!session || typeof session.logoutUntil !== 'function') throw new Error('logout only works from the console');

  while (game.now() < outAt) {
    if (stopped()) { log('  stopped — still logged in'); return false; }
    await new Promise((r) => setTimeout(r, Math.min(1000, outAt - game.now())));
  }

  if (atLogout) atLogout(true);
  try {
    const started = Date.now();
    let said = '';
    for (;;) {
      if (stopped()) { log('  stopped — still logged in'); return false; }
      const others = otherScripts ? otherScripts() : [];
      if (!others.length) break;
      const names = others.map((id) => {
        const c = (game.castles || []).find((x) => String(game.castleId(x)) === String(id));
        return c ? c.name : id;
      }).join(', ');
      if (names !== said) { log(`  waiting for the script${others.length === 1 ? '' : 's'} in ${names} to finish first`); said = names; }
      if (Date.now() - started > OTHERS_WAIT_MS) {
        log(`  still running after ${OTHERS_WAIT_MS / 60000} minutes: ${names} — logging out anyway`);
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally { if (atLogout) atLogout(false); }

  // Every city's build marches, as the last thing seen before going dark.
  const CB = require('./city-build');
  const status = CB.status(game);
  if (!status.some((l) => /no build marches on their way/.test(l))) for (const l of status) log('  ' + l);

  // The session keeps local time; the script works on the server's clock.
  const localBack = backAt - (game.now() - Date.now());
  session.logoutUntil(localBack, 'logged out by a script');
  log(`  logged out until ${TM.clock(backAt).slice(0, 8)} — press Connect in the console to come back sooner`);
  return true;
}

module.exports = { parseArgs, times, run };
