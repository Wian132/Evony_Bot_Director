// Walk the day's passes to the end, one at a time, through the Director's Trading tab.
//
// THE DAY'S ORDER (the user, 2026-09-26): **1. gold  2. stone  3. food  4. wood  5. iron**
//
// And gold moves THROUGH STONE, not food. The user's reason, from watching it jam:
// "maybe its because its over 900b food in each town ... going forward as a rule transfer
// gold through stone, for exactly this reason, because theres no more space for more food".
// A town's food may never pass 950b (at 1t it resets to 0) and ours sit near the 900b soft
// cap, so a gold pass carried by food strangles itself: on 2026-09-26 Lord08 still held 364t
// of gold with 0.9t of food room, and 229t of it could not move at all. Stone's cap is
// 2,000b a town — the banks had ~98t of stone room against the ~5t needed to carry the
// remaining 747t of gold. Room, not gold, is what ends a pass (EVONY-RULES §4).
//
// Run it on a timer. Each run: look at the pass that is on, decide whether it is finished,
// and if it is, start the next. After iron it stops the play and cleans the reports.
//
// NOTE THE SIDES FLIP. In a GOLD pass the holiday banks BUY the carrier dear and their gold
// comes to us. In a RESOURCE pass they SELL it cheap and we buy. Get it backwards and the
// tab's own check refuses the start (it will not let a non-holiday account sell under 50).

const http = require('http');
const D = require('C:/EvonyTool/db');

// name      what the control file says      who buys
// GOLD RUNS LAST (the user, 2026-09-26: "clear up stone food and wood and then repass
// through gold else we need to run through gold after wood again and after food again").
// Every resource pass begins with canceltrade, and cancelling a bank's resting BUY orders
// REFUNDS the gold they had locked up — so gold reappears after each one. Measured that
// day: the banks read 0.77t of gold and looked finished, then 8.64t the moment the stone
// pass cancelled their books. Draining the resources first and sweeping gold at the end
// collects all of it in one pass instead of chasing it four times.
// Gold is carried by STONE, never food (food caps at 950b a town and jams).
// 2026-09-27: GOLD RUNS FIRST AS WELL AS LAST, which is the user's order in full — "1. Gold
// 2. Stone 3. food 4. wood 5. iron" and then "repass through gold". Gold is the prize and it
// dwarfs the rest: the five banks hold 4,380t of gold against ~150t of food/wood/stone/iron
// between them. Capture is also at its highest in the half hour after maintenance, before the
// other players' bots have loaded, so the valuable pass belongs in that window and not five
// passes later. The closing sweep still earns its place: every resource pass opens with
// canceltrade, and cancelling a bank's resting BUY orders REFUNDS the gold locked in them, so
// gold keeps reappearing behind us (measured 2026-09-26: the banks read 0.77t and looked
// finished, then 8.64t the moment the stone pass cancelled their books).
// Gold is carried by STONE, never food (food caps at 950b a town and jams).
const STEPS = [
  { name: 'gold', res: 'stone', price: 150, banks: 'buy' },     // first: the post-maintenance window
  // 2026-09-27: the resource passes buy at 3, not 0.001. Measured that day on stone, same
  // fleet and scripts, 20-minute windows: at 0.001 only 41% of what left the banks reached
  // us, at 3 it was 92%. Cheap is what other players' bots lock onto, and the gold we pay
  // goes to a HOLIDAY account, so it returns in that bank's restore baseline and the closing
  // gold sweep takes it back — a dear buy-back is close to free. (Turn the price ladder OFF
  // or it walks this straight back down to 0.001: EVONY-RULES, the ladder's raw-count bug.)
  // 2026-09-27, CORRECTED same day: 1, not 3. Price 3 DEADLOCKED the food pass from a cold
  // start — 20 minutes, ~17,400 sell orders and ~17,900 of our bids placed, and ZERO fills
  // on either side (verified by relogging both a bank and two of ours: no food moved and no
  // gold left us, so it was not leakage either). Dropping to 1 crossed immediately: 1,643
  // fills in the next 2.5 minutes. The mechanism is NOT understood — it is not 'same price
  // never crosses', because at 1 both sides are also on the same price and it crosses fine.
  // 1 is the user's own starting figure and it is known to work; 3 is only safe as a step UP
  // from a price that is already moving, which is how the stone pass reached it.
  // 2026-09-28 the user: "make stone cheaper than 1 ... 0.01 or 0.001 initially and then
  // ramp it up when we drop under 60%". Starting cheap and RAISING on a capture drop is the
  // opposite of the 2026-09-27 reading (0.001 returned 41%, 3 returned 92%) — the point is to
  // buy back as much as possible while the book is ours and only pay up once other players'
  // bots have found it. WATCH THE BOOKS ON EVERY RAMP: a price change makes both sides cancel
  // and re-list, and on 2026-09-23 the banks re-listed while our bids stayed at the old price,
  // so the two books de-synchronised and nothing crossed at all.
  { name: 'stone', res: 'stone', price: 0.001, banks: 'sell' },
  { name: 'food', res: 'food', price: 1, banks: 'sell' },
  { name: 'wood', res: 'wood', price: 1, banks: 'sell' },
  { name: 'iron', res: 'iron', price: 1, banks: 'sell' },
  { name: 'gold sweep', res: 'stone', price: 150, banks: 'buy' },  // last: every refund
];

// 2026-09-27 09:4x — FIVE banks, the rotation done. The user took the nine older banks OUT
// of holiday after this morning's maintenance and left in the five they holidayed last night,
// which came through it and so are glitch-ready: a2 Lord02, a3 Lord03, a17 Lord17,
// a20 Lord20, a21 Lord21. They hold 4,380t of gold between them.
// The nine are RECEIVERS now and are in OURS below. Check the Director's holiday column
// against this list before every start — out of holiday there is no put-back, so a cheap sale
// or a dear buy from one of them is a real loss (the skill, and EVONY-RULES §4).
const BANKS = ['a2', 'a3', 'a17', 'a20', 'a21'];
// OURS is everything out of holiday, which is what the user asked for on 2026-09-27:
// "5 banks (moving off side) onto everything", naming a24, a25 and a23 to be brought in.
// a7 Lord07 is back IN — it was held out on 2026-09-26 only ("keep lord07 out of
// trading for TODAY please ill be using it myself"), and that day is over.
// 178 towns, 156.8t of stone
// between them — enough to carry 23,526t of gold against the 4,380t there is to move.
// a1 Lord01 is LEFT OUT at the user's word ("yes Lord01 can sit out"): all ten of its
// towns hold 99.2-100.1t of gold, so at the 100t cap it would sit on the sitout anyway.
// a24 Lord24, a25 Lord25 and a23 Lord23 hold almost no stone (0, 0 and 0.3t), so they sit
// the opening GOLD pass out with nothing to sell. They come alive at the stone pass — Lord24
// and Lord25 have ~600m of gold a town, thousands of orders' worth at 0.001 — and then
// carry that stone into the closing sweep. Their 28 near-empty towns are the fleet's best
// gold room, so it is worth having them in from the start.
// 2026-09-28 the user: "add these accounts to the trading aswell please, I just want them to
// get some gold in now when we move the gold so they can participate in buying throughout the
// day and actually scale up tomorrow". The six that were just brought to 10 cities join OURS:
// they SELL stone at 150 for the banks' gold. Their stone floor is lifted to 0 in
// glitch-res-control.txt (they hold ~0.8b a town, so the standard 1b floor would sit them out).
const OURS = ['a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12', 'a13', 'a14', 'a15',
  'a16', 'a18', 'a19', 'a23', 'a24', 'a25',
  'a26', 'a27', 'a28', 'a29', 'a30', 'a31'];
const CAP = { food: 900e9, wood: 800e9, stone: 2000e9, iron: 800e9 };
const T = 1e12;

const LEFT_DONE = 1.0 * T;     // the side we are draining holds under this: done
const ROOM_DONE = 1.0 * T;     // the receiving side has less room than this: done
const STALL_MS = 25 * 60000;   // nothing measurable moved in this long: move on
const STATE_KEY = 'tradeAdvance';

function each(ids, fn) { for (const id of ids) { const r = D.all('SELECT json FROM account_latest WHERE accountId = ?', id)[0]; if (r) fn(JSON.parse(r.json)); } }

// A failed poll writes a row with NO `totals` (it happened all through the user's network
// move on 2026-09-25 and killed every run of this script for two hours). Always guard it.
const totals = (ids, k) => { let n = 0; each(ids, (j) => { if (j.totals) n += j.totals[k] || 0; }); return n; };
// CAP is only the fallback: LIVE holds the caps the user has set, read each run.
let LIVE = null;
// A cap of 0 means NO CAP (the control file only applies capRes when it is > 0), which
// the user set for wood/stone/iron on 2026-09-26 so they drain completely. Treat it as
// unlimited room — read as a literal 0 it would look like "no room left" and this would
// skip the step instead of running it.
const capOf = (res) => {
  const v = LIVE && LIVE[res] !== undefined ? LIVE[res] : CAP[res];
  return Number(v) > 0 ? Number(v) : Infinity;
};
const roomFor = (ids, res) => {
  if (!Number.isFinite(capOf(res))) return Infinity;   // uncapped: never "out of room"
  let n = 0;
  each(ids, (j) => { for (const c of j.cityList || []) { const left = capOf(res) - (c[res] || 0); if (left > 0) n += left; } });
  return n;
};

function sid() {
  const A = require('C:/EvonyTool/auth');
  const org = D.all('SELECT id FROM orgs LIMIT 1')[0];
  const u = D.all('SELECT id FROM users LIMIT 1')[0];
  const s = A.newSession(u.id, org.id, '127.0.0.1', 'trade-advance');
  return typeof s === 'string' ? s : (s.id || s.sid);
}

function call(path, method, body, cookie, port = 8712) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : JSON.stringify(body);
    const req = http.request({
      host: 'localhost', port, path, method,
      headers: { Cookie: 'otto_sid=' + cookie, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
      timeout: 180000,
    }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => {
        if (!s.trim()) return resolve({ ok: res.statusCode < 400 });   // /api/reconnect answers empty
        try { resolve(JSON.parse(s)); } catch { reject(new Error('bad reply: ' + s.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timed out')));
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the port a console is really on, from its own log header (ports move on every restart)
function portOf(id) {
  try {
    const log = require('fs').readFileSync('C:/EvonyTool/console-' + id + '.log', 'utf8');
    const m = [...log.matchAll(/port:\s*(\d+)/g)];
    return m.length ? m[m.length - 1][1] : null;
  } catch { return null; }
}

// Reconnect every bank and wait until each one's snapshot is newer than the relog, so the
// figures the run judges on are from AFTER a fresh login. Never fatal: if a bank will not
// come back in time we carry on with what we have rather than skipping the run entirely.
async function relogBanks(cookie) {
  const at = Date.now();
  for (const id of BANKS) {
    const port = portOf(id);
    if (!port) continue;
    try { await call('/api/reconnect', 'POST', {}, cookie, port); } catch { /* try the rest */ }
  }
  for (let i = 0; i < 12; i++) {
    const stale = BANKS.filter((id) => {
      const r = D.all('SELECT at FROM account_latest WHERE accountId = ?', id)[0];
      return !r || r.at < at;
    });
    if (!stale.length) return true;
    await sleep(10000);
  }
  return false;
}

// THE TWO GOLD STEPS LOOK IDENTICAL from the control file — both are stone at 150 — so
// res+price cannot tell the opening pass from the closing sweep. The saved state carries the
// step's INDEX and that is what picks between them. Without it, finishing the sweep would
// read as finishing the opening pass and the day would loop back round to stone for ever.
// Returns { s, i }, or null when the file is set to something that is not one of mine.
const stepOf = (res, price, idx) => {
  const c = STEPS.map((s, i) => ({ s, i }))
    .filter(({ s }) => s.res === res && (Number(price) >= 50) === (s.price >= 50));
  if (!c.length) return null;
  return c.find((x) => x.i === idx) || c[0];
};

async function startStep(step, cookie, say) {
  const st = await call('/api/trading/setup', 'GET', null, cookie);
  if (st.run && st.run.state !== 'stopped' && st.run.state !== 'idle') {
    await call('/api/trading/stop', 'POST', { clean: false }, cookie);
    for (let i = 0; i < 40; i++) {
      const s = await call('/api/trading/setup', 'GET', null, cookie);
      if (!s.run || s.run.state === 'stopped' || s.run.state === 'idle') break;
      await sleep(10000);
    }
  }
  const sides = {};
  for (const id of BANKS) sides[id] = step.banks;
  for (const id of OURS) sides[id] = step.banks === 'buy' ? 'sell' : 'buy';
  // Keep whatever caps and runways the USER has set in the Trading tab. This script used
  // to impose its own CAP constant on every step, which would have silently undone the
  // raise the user made on 2026-09-26 (wood 800b->2t, stone 2t->3t, iron 800b->2t) at the
  // next step. Only the resource and the price belong to the schedule; the limits are the
  // user's. CAP is still used for the room arithmetic below, from the live setup.
  const cur = (st.setup && st.setup.play) || {};
  const play = { res: step.res, price: step.price, prevRes: 'auto',
    keepGold: cur.keepGold === undefined ? 20000000 : cur.keepGold,
    keepRes: cur.keepRes === undefined ? 1000000000 : cur.keepRes,
    capGold: cur.capGold === undefined ? 100e12 : cur.capGold,
    caps: cur.caps || CAP };
  let save = await call('/api/trading/setup', 'POST', { sides, play }, cookie);
  let errs = (save.check && save.check.errors) || [];

  // An account the user is playing by hand, or one still reconnecting, blocks the WHOLE
  // start. On 2026-09-26 three kicked accounts held the sequence for 50 minutes between
  // food and wood. So: drop the accounts the check names and start with the rest — losing
  // three of twelve buyers costs a little throughput; losing an hour costs a pass. They
  // rejoin at the next step. Never force a start for them: a kicked or rate-limited
  // account must not be restarted (EVONY-RULES §4).
  if (errs.length) {
    const byLabel = new Map(((save.accounts) || []).map((a) => [a.label, a.id]));
    const drop = new Set();
    for (const e of errs) for (const [label, id] of byLabel) if (String(e).startsWith(label + ' ')) drop.add(id);
    const kept = Object.fromEntries(Object.entries(sides).filter(([id]) => !drop.has(id)));
    const banksLeft = BANKS.filter((id) => kept[id]).length, oursLeft = OURS.filter((id) => kept[id]).length;
    if (!drop.size || !banksLeft || !oursLeft) { say('NOT started — ' + errs.join(' | ').slice(0, 300)); return false; }
    say(`leaving out ${[...drop].join(', ')} (${errs.length} blocked) and starting with ${banksLeft} banks / ${oursLeft} of ours`);
    save = await call('/api/trading/setup', 'POST', { sides: kept, play }, cookie);
    errs = (save.check && save.check.errors) || [];
    if (errs.length) { say('NOT started — ' + errs.join(' | ').slice(0, 300)); return false; }
  }
  const r = await call('/api/trading/start', 'POST', {}, cookie);
  say(r.ok ? `started the ${step.name} pass (${step.res} @ ${step.price})` : 'start refused — ' + (r.error || '?'));
  return !!r.ok;
}

async function main() {
  const say = (m) => console.log(new Date().toLocaleTimeString() + '  ' + m);
  const cookie = sid();
  const now = Date.now();

  let st = null;
  try { st = D.settings.get(STATE_KEY, null); } catch { /* first run */ }
  st = st || { name: null, since: now, seen: null };

  // ONE CYCLE A DAY. When the last step finishes the state is marked done WITH THE DATE, and
  // every later run that same day stops here. Without this the day loops: `idx: null` matches
  // no step, so stepOf() fell back to the FIRST one, read the finished gold sweep as the
  // opening gold pass and set off through stone/food/wood/iron again — observed 2026-09-27,
  // "ALL PASSES DONE" at 18:06 and a fresh stone pass at 18:26.
  // A new day (after maintenance puts the banks' resources back) starts the cycle again.
  const today = new Date().toISOString().slice(0, 10);
  if (st.name === 'done' && st.day === today) {
    say(`the day's passes are done (finished ${new Date(st.since).toLocaleTimeString()}) — nothing to do until tomorrow`);
    return;
  }

  // RELOG THE BANKS BEFORE JUDGING. `account_latest` lags badly on a busy account and this
  // script's whole job is deciding "is this pass finished?" from it. On 2026-09-27 that cost
  // time in BOTH directions in one morning:
  //   - gold: the cache read 1,194t left when the banks had been empty for 25 minutes, so the
  //     pass sat doing nothing until a hand relog;
  //   - stone: the cache read no movement while ~1.2t every 5 min was really filling, so the
  //     stall rule below fired and restarted a perfectly healthy pass, costing ~10 minutes to
  //     the autorun gate.
  // A reconnect is cheap and keeps each console's autorun script up (see bank-truth.js), so
  // do it every run and judge on figures from after it.
  await relogBanks(cookie);
  const view = await call('/api/trading/setup', 'GET', null, cookie);
  const ctl = view.control || {};              // `control` IS the parsed control file
  // the caps the user has set, so the room arithmetic matches what the play will obey
  LIVE = ctl.caps || ((view.setup && view.setup.play && view.setup.play.caps) || null);
  const running = !!(view.run && view.run.state !== 'stopped' && view.run.state !== 'idle');
  const hit = stepOf(ctl.res, ctl.price, st.idx);
  if (!hit) { say(`control file says res="${ctl.res}" price=${ctl.price} — not one of mine, leaving it alone`); return; }
  const step = hit.s, idx = hit.i;
  // the same step we were watching last run? by INDEX, so the two gold passes stay apart
  const same = st.idx === idx;

  // What we are draining, and where it has to land.
  // A GOLD STEP IS ONE PRICED >= 50 — never `name === 'gold'`. The closing sweep is called
  // 'gold sweep', so a name test silently made it measure the banks' STONE instead of their
  // GOLD and misjudge itself (introduced and caught 2026-09-27). Same signature the control
  // file uses for `kind`.
  const gold = Number(step.price) >= 50;
  const left = gold ? totals(BANKS, 'gold') : totals(BANKS, step.res);
  const room = gold ? roomFor(BANKS, step.res)          // the banks must have room for the carrier
    : roomFor(OURS, step.res);                          // we must have room for what they sell
  const ours = totals(OURS, gold ? 'gold' : step.res);  // measured on our side: it updates first

  // MOVEMENT IS MEASURED ON THE BANKS, because they are the side relogBanks() just
  // refreshed. It used to be measured on ours ("it updates first"), which was not true: our
  // eighteen accounts are exactly the busy ones whose snapshots lag, and a false "nothing
  // moved" is what restarted a healthy stone pass on 2026-09-27.
  const moved = same && st.seenLeft !== undefined && st.seenLeft !== null ? st.seenLeft - left : null;
  const stalled = same && moved !== null && Math.abs(moved) < 0.2 * T && (now - st.since) > STALL_MS;

  const roomTxt = Number.isFinite(room) ? (room / T).toFixed(1) + 't' : 'uncapped';
  say(`${step.name}: banks ${(left / T).toFixed(1)}t · receiving room ${roomTxt} · we hold ${(ours / T).toFixed(1)}t`
    + (moved === null ? '' : ` · moved ${(moved / T).toFixed(2)}t since last check`) + (running ? '' : ' · NOT running'));

  // A STALL IS ONLY "FINISHED" WHEN THERE IS LITTLE LEFT TO MOVE. On 2026-09-26 four
  // accounts were out of the play (two consoles each, kicking one another), iron moved
  // nothing for 27 minutes and this called it done and stopped the day — with 25.4t still
  // in the banks and 230.6t of room on our side. A stall with plenty at both ends is a
  // FAULT, not completion: say so and start the step again rather than skipping it.
  const plenty = left > 5 * T && room > 5 * T;
  const done = left < LEFT_DONE ? 'the banks are out of it'
    : room < ROOM_DONE ? 'the receiving side has no room left'
      : (stalled && !plenty) ? `nothing has moved for ${Math.round((now - st.since) / 60000)} min` : null;
  if (stalled && plenty) {
    say(`STALLED with ${(left / T).toFixed(1)}t still there and ${(room / T).toFixed(1)}t of room `
      + '— that is a fault, not the end of the pass; starting it again');
    await startStep(step, cookie, say);
    D.settings.set(STATE_KEY, { name: step.name, idx, since: now, seen: ours, seenLeft: left });
    return;
  }

  if (!done) {
    if (!running) { say('not running — starting ' + step.name + ' again'); await startStep(step, cookie, say); }
    D.settings.set(STATE_KEY, { name: step.name, idx, since: same ? st.since : now, seen: ours, seenLeft: left });
    return;
  }

  say(`${step.name} is finished (${done})`);
  const next = STEPS[idx + 1];
  if (!next) {
    say(`${step.name} was the last one — stopping the play and cleaning the reports`);
    await call('/api/trading/stop', 'POST', { clean: true }, cookie);
    D.settings.set(STATE_KEY, { name: 'done', idx: null, day: today, since: now, seen: null });
    say('ALL PASSES DONE');
    return;
  }
  if (await startStep(next, cookie, say)) {
    const nextIsGold = Number(next.price) >= 50;
    D.settings.set(STATE_KEY, {
      name: next.name, idx: idx + 1, since: Date.now(),
      seen: totals(OURS, nextIsGold ? 'gold' : next.res),
      seenLeft: nextIsGold ? totals(BANKS, 'gold') : totals(BANKS, next.res),
    });
  }
}

main().catch((e) => { console.error('trade-advance failed: ' + e.message); process.exitCode = 1; });
