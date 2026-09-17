'use strict';
// NEAT's `logout`: take the console off the game for a while, then log back in.
//
//   logout now @:14:35         off now, back at 14:35 on this machine's clock; the run ends here
//   logout now 1:05:00         off now, back 1h05m later; the run ends here
//   logout @:01:30:31 @:06:35:00   NEAT: at 01:30:31, off until 06:35:00, then the script carries on
//   logout 1:00 29:00          NEAT: off in 1 minute, back 29 minutes after that, then carries on
//
// `now` is OTTObot's form: the extra-cities recipe logs off once the build
// marches are out and stays off until a few minutes after they land, and
// nothing may follow it (script.parse refuses a line after it). Any other time
// to log out is NEAT's form: the run waits through the time off and carries on
// with the next line once the console is back (the Logout page's spam waves:
// logout 1:00 29:00 / attack ... / repeat 3 / sleep 45 / loop).
//
// Times: `@:hh:mm[:ss]` is a clock time, anything else a wait (s, m:ss or
// h:mm:ss). The time to come back is required: NEAT's form without one leaves
// the bot off for good, and a console that never logs in again would need
// someone to press Connect to come back.
//
// Other cities' scripts in this console are waited for first, so the first city
// to finish does not cut the others off mid-send. Scripts that are themselves
// waiting at a logout (or waiting to come back from one) do not count.
//
// It rides the session's stand-down (Session.logoutUntil): no login of any kind
// until the time, kept across a console restart, and the session's supervisor
// does the logging back in (a port check, then one login every few minutes).
// Nothing here logs in. Pressing Connect in the console ends it early, and a
// script waiting to carry on goes on from there.

const OTHERS_WAIT_MS = 15 * 60000;
// How long past the time to come back a waiting script keeps waiting for the
// session's login (maintenance, a blocked login) before it gives up and ends.
const BACK_WAIT_MS = 6 * 3600000;

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
    throw new Error('logout: say when to log out and when to log back in, e.g.  logout now @:14:35  or  logout 1:00 29:00'
      + ' — NEAT\'s form with no time to come back would leave the console off for good');
  }
  if (args.length > 2) throw new Error(`logout: unexpected "${args[2]}"`);
  const a = { out: parseWhen(args[0], 'log-out time'), back: parseWhen(args[1], 'log-back-in time') };
  // NEAT's forms carry on after the console is back; `now` ends the run.
  if (!/^now$/i.test(String(args[0]))) a.resume = true;
  return a;
}

// Server-clock ms for each end. A clock time to come back is its next
// occurrence after the log-out; a wait is counted from the log-out.
function times(a, serverNow) {
  const S = require('./script');
  const outAt = a.out.at ? S.nextOccurrence(a.out.at, serverNow) : serverNow + a.out.wait * 1000;
  const backAt = a.back.at ? S.nextOccurrence(a.back.at, outAt) : outAt + a.back.wait * 1000;
  return { outAt, backAt };
}

// Resolves { outAt, backAt } (server clock) once the console is logged out,
// false for a dry run or a Stop before it went.
async function run(game, a, { session, log, dryRun, stopped = () => false, otherScripts, atLogout }) {
  const TM = require('./timed-march');
  const { outAt, backAt } = times(a, game.now());
  if (backAt - outAt < 60000) throw new Error('logout: that is less than a minute off the game');
  log(`  log out ${outAt - game.now() > 1000 ? 'at ' + TM.clock(outAt).slice(0, 8) : 'now'},`
    + ` back at ${TM.clock(backAt).slice(0, 8)} (${TM.tz()}) — ${TM.dur(backAt - outAt).replace(/\.\d+s$/, 's')} off the game`
    + (a.resume ? ', and the script carries on after that' : ''));
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
  return { outAt, backAt };
}

// NEAT's carry-on: wait until the session is logged in again (at the time, or
// sooner if Connect was pressed) and resolve its new Game, or null when the run
// should end instead (Stop, the console now on another account, or no login
// long after the time). While it waits it counts as a script at a logout, so
// another city's logout does not wait for it.
async function waitBack(game, when, { session, log, stopped = () => false, atLogout, pollMs = 1000, giveUpMs = BACK_WAIT_MS }) {
  const TM = require('./timed-march');
  const who = (g) => ((g && g.player && g.player.playerInfo) || {}).userName;
  const me = who(game);
  const localBack = when.backAt - (game.now() - Date.now());
  if (atLogout) atLogout(true);
  try {
    let noted = localBack;
    for (;;) {
      if (stopped()) {
        log(`  stopped — the console stays off until ${TM.clock(when.backAt).slice(0, 8)} (Connect brings it back sooner)`);
        return null;
      }
      const g = session && session.game;
      if (session && session.connected && g) {
        if (g !== game) {
          if (who(g) && me && who(g) !== me) {
            log(`  the console is logged in as ${who(g)} now, not ${me} — the script ends here`);
            return null;
          }
          log(`  back on the game at ${TM.clock(g.now ? g.now() : Date.now()).slice(0, 8)} — the script carries on`);
          return g;
        }
        // Still on the connection it logged out from, after the time: this
        // session never stood down (no supervisor), so there is nothing to wait for.
        if (Date.now() >= localBack) { log('  the console never went off the game — the script carries on'); return g; }
      }
      if (Date.now() > localBack + giveUpMs) {
        log(`  not logged back in ${Math.round(giveUpMs / 3600000)} hours after ${TM.clock(when.backAt).slice(0, 8)} — the script ends here`);
        return null;
      }
      if (Date.now() - noted >= 10 * 60000) {
        noted = Date.now();
        log('  still waiting for the console to log back in (it tries every few minutes; Stop ends this script)');
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally { if (atLogout) atLogout(false); }
}

module.exports = { parseArgs, times, run, waitBack, BACK_WAIT_MS };
