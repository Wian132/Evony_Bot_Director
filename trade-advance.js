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
const STEPS = [
  { name: 'stone', res: 'stone', price: 0.001, banks: 'sell' },
  { name: 'food', res: 'food', price: 0.001, banks: 'sell' },
  { name: 'wood', res: 'wood', price: 0.001, banks: 'sell' },
  { name: 'iron', res: 'iron', price: 0.001, banks: 'sell' },
  { name: 'gold', res: 'stone', price: 150, banks: 'buy' },   // last: sweeps every refund
];

const BANKS = ['a4', 'a5', 'a8', 'a9', 'a11', 'a13', 'a14', 'a15', 'a16'];
// a23 Lord23 joined the fleet on 2026-09-25 (moved into the hub, not on holiday), so it
// trades on OUR side like the rest (the user: "you can also add Lord23 to the trading so
// it starts adding res").
// a7 Lord07 is OUT of the trading (the user, 2026-09-26) — they use it by hand.
// 2026-09-26 19:2x: Lord02 (a2), Lord17 (a17), Lord03 (a3), Lord21 (a21) and
// Lord20 (a20) went ON HOLIDAY, so they are no longer our side. a7 Lord07 is out of
// the trading by the user's choice. TOMORROW the user takes the nine current banks OUT of
// holiday and these five become the banks — BANKS and OURS both have to be swapped then.
const OURS = ['a1', 'a6', 'a10', 'a12', 'a18', 'a19', 'a23'];
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

function call(path, method, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : JSON.stringify(body);
    const req = http.request({
      host: 'localhost', port: 8712, path, method,
      headers: { Cookie: 'otto_sid=' + cookie, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
      timeout: 180000,
    }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { reject(new Error('bad reply: ' + s.slice(0, 200))); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timed out')));
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stepOf = (res, price) => STEPS.find((s) => s.res === res && (Number(price) >= 50) === (s.price >= 50));

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

  const view = await call('/api/trading/setup', 'GET', null, cookie);
  const ctl = view.control || {};              // `control` IS the parsed control file
  // the caps the user has set, so the room arithmetic matches what the play will obey
  LIVE = ctl.caps || ((view.setup && view.setup.play && view.setup.play.caps) || null);
  const running = !!(view.run && view.run.state !== 'stopped' && view.run.state !== 'idle');
  const step = stepOf(ctl.res, ctl.price);
  if (!step) { say(`control file says res="${ctl.res}" price=${ctl.price} — not one of mine, leaving it alone`); return; }

  // What we are draining, and where it has to land.
  const gold = step.name === 'gold';
  const left = gold ? totals(BANKS, 'gold') : totals(BANKS, step.res);
  const room = gold ? roomFor(BANKS, step.res)          // the banks must have room for the carrier
    : roomFor(OURS, step.res);                          // we must have room for what they sell
  const ours = totals(OURS, gold ? 'gold' : step.res);  // measured on our side: it updates first

  const moved = st.name === step.name && st.seen !== null ? ours - st.seen : null;
  const stalled = st.name === step.name && moved !== null && Math.abs(moved) < 0.2 * T && (now - st.since) > STALL_MS;

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
    D.settings.set(STATE_KEY, { name: step.name, since: now, seen: ours });
    return;
  }

  if (!done) {
    if (!running) { say('not running — starting ' + step.name + ' again'); await startStep(step, cookie, say); }
    D.settings.set(STATE_KEY, { name: step.name, since: st.name === step.name ? st.since : now, seen: ours });
    return;
  }

  say(`${step.name} is finished (${done})`);
  const next = STEPS[STEPS.indexOf(step) + 1];
  if (!next) {
    say('iron was the last one — stopping the play and cleaning the reports');
    await call('/api/trading/stop', 'POST', { clean: true }, cookie);
    D.settings.set(STATE_KEY, { name: 'done', since: now, seen: null });
    say('ALL PASSES DONE');
    return;
  }
  if (await startStep(next, cookie, say)) {
    D.settings.set(STATE_KEY, { name: next.name, since: Date.now(), seen: totals(OURS, next.name === 'gold' ? 'gold' : next.res) });
  }
}

main().catch((e) => { console.error('trade-advance failed: ' + e.message); process.exitCode = 1; });
