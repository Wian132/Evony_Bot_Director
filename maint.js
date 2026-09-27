'use strict';
// The fleet's word on maintenance — one record per server, shared by every
// console and by the Director through the organization's settings.
//
// WHY THIS EXISTS (2026-09-23). The daily maintenance is announced on the
// system chat, and until now each console had to hear that announcement for
// itself before it would stand down. An account **on holiday is not sent the
// system message** (observed 2026-09-23: a2, a3, a7-a13 and a15-a21 all logged
// four copies of "Evony Server ss71 will be taken offline for daily security
// maintenance"; the holidayed a4, a5, a6 and a14 logged none). So the holiday
// consoles sat connected into the start of the window, had the socket closed
// under them at 09:00:00, and then spent the whole maintenance on the reconnect
// ladder — the exact login churn that gets an account held back for half an
// hour and that kills a proxy (EVONY-RULES.md section 2).
//
// So the first console to hear it writes the window down here, the Director
// declares one itself when the fleet's own behaviour says the server has gone
// (several consoles dropped at once, or a console reports the port closed), and
// every console reads it. One bot hearing the announcement now stands the whole
// fleet down, holidayed accounts included.
//
//   maintWindow:<server> = { startAt, resumeAt, until, text, by, at }
//   maintOver:<server>   = ms when an account was verifiably logged in again
//
// Both live in the ORG's settings, not the install-wide ones: a role or a
// signal written install-wide is never read (EVONY-RULES.md section 7).

const PRE_PAUSE_MIN = 5;    // stand down this long before the announced start
const WINDOW_MIN = 15;      // assumed length of the window ("usually 15 minutes")
const SPAN_MIN = 90;        // how long a record stays meaningful at all

const winKey = (server) => 'maintWindow:' + (server || 'ss71');
const overKey = (server) => 'maintOver:' + (server || 'ss71');

// The record as it stands right now, or null when there is nothing current.
// `phase` is what a console should be doing about it:
//   before      carry on as normal, the stand-down has not started
//   standdown   no logins of any kind
//   recovering  the announced end has passed: probe the free TCP port, and
//               spend a login only once it answers
//   over        an account is verifiably in again — nobody has to wait
function read(settings, server, now = Date.now()) {
  let win = null, over = 0;
  try {
    win = settings.get(winKey(server), null);
    over = Number(settings.get(overKey(server), 0)) || 0;
  } catch { return null; }
  if (!win || !win.startAt) return null;
  const startAt = Number(win.startAt);
  const until = Number(win.until) || startAt + SPAN_MIN * 60000;
  if (!(now < until)) return null;                       // expired: it tells us nothing
  const resumeAt = Number(win.resumeAt) || startAt + WINDOW_MIN * 60000;
  const pauseAt = startAt - PRE_PAUSE_MIN * 60000;
  // Only a signal from INSIDE this window means anything: yesterday's stranded
  // the whole fleet once already (EVONY-RULES.md section 2, 2026-09-20).
  const done = over > startAt ? over : 0;
  return {
    server: server || 'ss71', startAt, pauseAt, resumeAt, until,
    text: win.text || null, by: win.by || null, at: Number(win.at) || startAt, over: done,
    phase: done ? 'over' : now < pauseAt ? 'before' : now < resumeAt ? 'standdown' : 'recovering',
  };
}

// Is the server in maintenance as far as the fleet is concerned — i.e. should
// nothing spend a login right now? True through the stand-down; during the
// recovery a login is earned by the port answering, which only a console checks.
function standingDown(settings, server, now = Date.now()) {
  const rec = read(settings, server, now);
  return !!(rec && rec.phase === 'standdown');
}

// Write the window down for the whole fleet. An armed window is left alone
// (the announcement is repeated every three minutes, and the Director's own
// detection must not push the start later every sweep) unless `force`.
// -> the record written, or null when one was already armed.
function declare(settings, server, { startAt, resumeAt, text, by, force = false } = {}, now = Date.now()) {
  try {
    const cur = read(settings, server, now);
    if (cur && !force && cur.phase !== 'over') return null;
    const start = Number(startAt) || now;
    const rec = {
      startAt: start,
      resumeAt: Number(resumeAt) || start + WINDOW_MIN * 60000,
      until: start + SPAN_MIN * 60000,
      text: String(text || 'maintenance').slice(0, 120),
      by: by || null,
      at: now,
    };
    settings.set(winKey(server), rec);
    // A new window means nobody has come back through it yet: an "it is over"
    // left from the last one would say the fleet is free the moment it is armed.
    if (Number(settings.get(overKey(server), 0)) || 0) settings.set(overKey(server), 0);
    return rec;
  } catch { return null; }
}

// An account is logged in again, so the server is back: release the fleet.
// Only ever called with a login that actually holds — a guess here is what
// sends every console into a closed server.
function signalBack(settings, server, at = Date.now()) {
  try { settings.set(overKey(server), at); return at; } catch { return null; }
}

// What one sweep of the fleet means for a server. The Director watches every
// console at once, so it can see what no single console can:
//
//   'back'     an account that was out is logged in again. That is the only
//              proof the server is up, and it releases everyone who adopted the
//              window without hearing the announcement themselves.
//   'down'     two consoles say the server is down, or three lost the game
//              socket in the same sweep. Each logs in through its own proxy, so
//              nothing but the server takes them together; one alone is not
//              enough, because a single proxy dying looks exactly like this from
//              one console (EVONY-RULES.md section 2, 2026-09-20).
//   null       nothing to say. One account still logged in settles it: the
//              server is up, whatever happened to the others.
//
// sweep: { connected, dropped, saysDown, back } — counts from one uptime sweep.
const DROPPED_IS_MAINTENANCE = 3;
const SAYS_DOWN_IS_MAINTENANCE = 2;
function verdict(sweep, rec) {
  const sv = sweep || {};
  if (sv.back) return rec && rec.phase !== 'over' && rec.phase !== 'before' ? 'back' : null;
  if (rec && rec.phase !== 'over') return null;            // the fleet already knows
  if (sv.connected) return null;
  if ((sv.saysDown || 0) >= SAYS_DOWN_IS_MAINTENANCE || (sv.dropped || 0) >= DROPPED_IS_MAINTENANCE) return 'down';
  return null;
}

module.exports = {
  read, standingDown, declare, signalBack, verdict, winKey, overKey,
  PRE_PAUSE_MIN, WINDOW_MIN, SPAN_MIN, DROPPED_IS_MAINTENANCE, SAYS_DOWN_IS_MAINTENANCE,
};
