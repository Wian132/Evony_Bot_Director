'use strict';
// Timed marches (`@:hh:mm:ss.fff`): land at an exact moment, prove it from the
// server's own stamp, and put right any march that misses.
//
// Why this is fussy: the extra-cities trick, and the same trick for flats,
// needs every march to arrive in the SAME server second. One that lands early
// takes the one open slot by itself and the rest are refused. One that lands
// late arrives after the limit is back in force.
//
// Landing one:
//   * the march time is worked out the way the client does it (C.marchTimeMs),
//     with this city's own troop params, and the Relief Station applied when
//     the client would apply it (target yours or your alliance's);
//   * camp time is whole seconds, so the leftover fraction is taken up by
//     holding the send back, and the last few ms are spun, not slept, because
//     timers fire up to ~16 ms late on Windows;
//   * it is sent one one-way trip early, so the server stamps it on time.
// Checking it:
//   * the server pushes the new army in SelfArmysUpdate with its reachTime, and
//     that stamp is the truth. It is held against the aimed moment, and against
//     every march already accepted for that moment, from any city's script;
//   * a march that misses is recalled at once, while it has only been out a few
//     seconds. The miss is learned: a steady network lead, or a speed factor for
//     that city and kind of target. Then it is sent again, up to MAX_RETRIES.
const C = require('./constants');

const TOL_FIRST_MS = 300;   // the first march for a moment, against the aimed time
const TOL_MS = 200;         // every later one, against the marches already due
const MAX_RETRIES = 2;
const SPIN_MS = 30;
const SEND_MARGIN_MS = 50;  // time to get the send out after planning it

// The client gives a march the Relief Station speed toward these.
const RELIEF_CLASSES = new Set(['mine', 'alliance', 'unowned']);

// Accepted landings per aimed moment, shared by every script run in this
// console, so the fifth city's marches line up with the first city's.
// aimMs -> [{ armyId, landing, castleId, fieldId }]
const MOMENTS = new Map();

// ------------------------------------------------------------------ format

const p2 = (n) => String(n).padStart(2, '0');
const p3 = (n) => String(n).padStart(3, '0');
// On the bot machine's own clock, which is what `@:` is written in.
function clock(ms) {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
}
function tz() {
  const off = -new Date().getTimezoneOffset() / 60;
  return `UTC${off >= 0 ? '+' : ''}${off}`;
}
function dur(ms) {
  const neg = ms < 0; ms = Math.abs(ms);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = (ms % 60000) / 1000;
  const sec = s.toFixed(3).padStart(6, '0');
  return (neg ? '-' : '') + (h ? `${h}h ${p2(m)}m ${sec}s` : m ? `${m}m ${sec}s` : `${s.toFixed(3)}s`);
}
const signed = (ms) => { const v = Math.round(ms) || 0; return `${v >= 0 ? '+' : '-'}${Math.abs(v).toLocaleString('en-US')} ms`; };
const verdict = (r) => (!r ? 'no response' : r.ok === 1 ? 'ok'
  : `FAILED (ok=${r.ok})` + (r.errorMsg ? ` - ${r.errorMsg}` : ` ${JSON.stringify(r)}`));

// ------------------------------------------------------------------- model

// What has been learned about this connection: how early to send so the
// server stamps the send on time, a speed factor per city and kind of target
// for when the server's march time is not the client's, and whether reachTime
// already counts the camp.
// relief: kind of tile -> whether the server gives it the Relief Station speed,
// once a landing has shown the client's rule to be wrong for it. That is the
// server's rule, not a city's, so every city's marches use it from then on.
function model(game) {
  if (!game._landModel) {
    game._landModel = { leadMs: Math.max(0, Math.round((Number(game.minRtt) || 0) / 2)), scale: new Map(), relief: new Map(), reach: null };
  }
  return game._landModel;
}
const reliefApplies = (game, cls) => {
  const learned = model(game).relief.get(cls);
  return learned === undefined ? RELIEF_CLASSES.has(cls) : learned;
};

// Whose tile it is, in the client's terms (NewArmyWin.otherFieldInfo). Its
// test is ActionScript `==`, kept here as JS `==`: a tile with no alliance
// "matches" a player with none, so the client gives that march relief too.
async function targetClass(game, { targetPoint, toCity, construct }) {
  if (construct || toCity) return 'mine';
  const own = (game.castles || []).some((c) => Number(c.fieldId) === targetPoint
    || (c.fields || []).some((f) => Number(f.id) === targetPoint));
  if (own) return 'mine';
  const me = (game.player && game.player.playerInfo) || {};
  let owner = null;
  try { owner = await game.fieldOwner(targetPoint); } catch { return 'other'; }
  if (!owner || me.userName == null) return 'other';
  /* eslint-disable eqeqeq */
  if (owner.userName == me.userName) return 'mine';
  if (owner.allianceName == me.alliance) return owner.userName == null ? 'unowned' : 'alliance';
  /* eslint-enable eqeqeq */
  return 'other';
}

async function speedParams(game, castle) {
  try { return await game.troopParams(game.castleId(castle)); } catch {
    const m = Number(game.marchSkillParam ?? 100);
    return { marchSkill: m, driveSkill: m, relief: 0, fallback: true };
  }
}

// When to send, and with how much camp, so the march lands at aimMs.
function plan({ game, castle, from, target, troopKeys, aimMs, params, cls, key }) {
  const m = model(game);
  const now = game.now();
  const applied = reliefApplies(game, cls);
  const base = C.marchTimeMs(from, target, troopKeys, {
    marchSkill: params.marchSkill, driveSkill: params.driveSkill,
    relief: applied ? params.relief : 0,
    castleBuffs: castle.buffs, playerBuffs: game.player && game.player.buffs, now,
  });
  if (base === null) throw new Error('cannot work out the march time for those troops');
  const scale = m.scale.get(key) || 1;
  const march = base * scale;
  const slack = aimMs - now - march - m.leadMs - SEND_MARGIN_MS;
  if (slack < 0) {
    throw new Error(`too late: the march takes ${dur(march)} but ${clock(aimMs)} is only ${dur(aimMs - now)} away`);
  }
  const restTimeSec = Math.floor(slack / 1000);
  return { base, scale, march, applied, restTimeSec, sendAt: aimMs - march - restTimeSec * 1000 - m.leadMs, leadMs: m.leadMs };
}

// Sleep until close, then spin to the millisecond. False if stopped.
async function waitUntil(game, serverMs, stopped) {
  for (;;) {
    if (stopped()) return false;
    const left = serverMs - game.now();
    if (left <= 0) return true;
    if (left > SPIN_MS) await new Promise((r) => setTimeout(r, Math.min(250, left - SPIN_MS)));
    else await new Promise((r) => setImmediate(r));
  }
}

const armies = (game) => (game.player && game.player.selfArmys) || [];

// Our new army as the server pushed it (ArmyConstants: direction 1 = outbound).
async function findArmy(game, { castle, bean, before, timeoutMs = 5000 }) {
  const started = Date.now();
  for (;;) {
    const hit = armies(game).find((x) => !before.has(x.armyId)
      && Number(x.direction) === 1
      && Number(x.missionType) === Number(bean.missionType)
      && Number(x.targetFieldId) === Number(bean.targetPoint)
      && (x.startFieldId === undefined || Number(x.startFieldId) === Number(castle.fieldId)));
    if (hit) return hit;
    if (Date.now() - started >= timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// When the server has it landing. The client counts down to reachTime
// (ArmyMovementBar), so reachTime is taken to include the camp. Another reading
// is used only when that one fits no speed rule (`fits`, from the plan) and the
// other lands within seconds of the aim. Picking whichever reading is nearest
// would be wrong: a march 17 minutes early reads as 17 minutes late when the
// camp is 34 minutes. Once a reading is clearly right it is kept.
function landingOf(game, army, aimMs = null, fits = null) {
  const m = model(game);
  let reach = Number(army.reachTime);
  if (!Number.isFinite(reach) || reach <= 0) return null;
  if (reach < 1e11) reach *= 1000;       // epoch seconds, not ms
  const rest = Number(army.restTime) || 0;
  const reads = { withCamp: reach, campSeconds: reach + rest * 1000, campMs: reach + rest };
  if (!rest) return reach;
  if (m.reach) return reads[m.reach];
  if (aimMs === null) return reads.withCamp;
  if (!fits || fits(reads.withCamp - aimMs)) {
    if (Math.abs(reads.withCamp - aimMs) < 5000 && rest >= 10) m.reach = 'withCamp';
    return reads.withCamp;
  }
  for (const k of ['campSeconds', 'campMs']) {
    if (Math.abs(reads[k] - aimMs) < 5000) {
      if (rest >= 10) m.reach = k;
      return reads[k];
    }
  }
  return reads.withCamp;                 // the caller sees it does not fit, and leaves it alone
}

// Every accepted march still outbound for this moment.
function moment(game, aimMs) {
  const live = new Set(armies(game).filter((x) => Number(x.direction) === 1).map((x) => x.armyId));
  const kept = (MOMENTS.get(aimMs) || []).filter((p) => live.has(p.armyId));
  if (kept.length) MOMENTS.set(aimMs, kept); else MOMENTS.delete(aimMs);
  return kept;
}
function record(aimMs, entry) {
  MOMENTS.set(aimMs, [...(MOMENTS.get(aimMs) || []).filter((p) => p.armyId !== entry.armyId), entry]);
}
const spread = (list) => (list.length < 2 ? 0 : Math.max(...list.map((p) => p.landing)) - Math.min(...list.map((p) => p.landing)));

// Is this landing good enough? The first march for a moment is held against
// the aimed time; every later one against the marches already accepted, since
// being together is what counts. A server that stamps whole seconds only has
// the second to go by.
function judge(landing, aimMs, peers) {
  const sec = (x) => Math.floor(x / 1000);
  const whole = landing % 1000 === 0;
  const anchor = peers.length
    ? peers.reduce((b, p) => (Math.abs(p.landing - aimMs) < Math.abs(b.landing - aimMs) ? p : b)).landing
    : null;
  const ref = anchor ?? aimMs;
  const off = landing - ref;
  let ok;
  if (whole) ok = anchor === null ? Math.abs(landing - aimMs) < 1000 : sec(landing) === sec(anchor);
  else ok = sec(landing) === sec(ref) && Math.abs(off) <= (anchor === null ? TOL_FIRST_MS : TOL_MS);
  return { ok, off, anchor, whole };
}

// Learn from a landing: a small miss is the network (move the send lead half
// way toward it). A big one means the server's march time differs: when it is
// off by the Relief Station factor, the relief rule for this kind of tile is
// wrong for every city; otherwise this city's marches to it are scaled.
// `relief` is the city's Relief Station multiplier; pl.applied says whether the
// plan counted it.
function learn(game, key, pl, err, whole, { relief = 0, cls = null } = {}) {
  if (whole) return null;
  const m = model(game);
  if (Math.abs(err) > 1000) {
    const factor = (pl.march + err) / pl.march;
    const R = Number(relief) || 0;
    const near = (a, b) => Math.abs(a - b) / b < 0.02;
    if (cls && R > 1 && pl.applied && near(factor, R)) {
      m.relief.set(cls, false);
      return `learned: the server does not give these marches the Relief Station x${R} — no city's march to this kind of tile counts it now`;
    }
    if (cls && R > 1 && !pl.applied && near(factor, 1 / R)) {
      m.relief.set(cls, true);
      return `learned: the server gives these marches the Relief Station x${R}, which the client would not — every city's march to this kind of tile counts it now`;
    }
    const s = (m.scale.get(key) || 1) * factor;
    m.scale.set(key, s);
    return `learned: the server's march time is ${(s * 100).toFixed(2)}% of the client's formula for them — every march from this city to this kind of tile uses that now`;
  }
  m.leadMs = Math.max(0, Math.min(2000, Math.round(m.leadMs + err / 2)));
  return null;
}

async function waitHome(game, armyId, stopped, timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (stopped()) return false;
    if (!armies(game).some((x) => x.armyId === armyId)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// One timed march, landed and checked. makeBean(restTimeSec) builds the army
// bean for each try, so a retry can pick a hero again. Returns
//   { sent: true, r, bean, landing }   kept (landing null if it could not be checked)
//   { sent: false, r?, why }           refused, recalled, stopped or given up
async function send({ game, castle, construct = false, from, target, targetPoint, toCity = null,
  troopKeys, aimMs, makeBean, log, stopped = () => false, dryRun = false, checkMs = 5000 }) {
  const cid = game.castleId(castle);
  const params = await speedParams(game, castle);
  const cls = await targetClass(game, { targetPoint, toCity, construct });
  const key = `${cid}:${cls}`;
  const edge = aimMs % 1000;
  const tomorrow = new Date(aimMs).toDateString() !== new Date(game.now()).toDateString();
  const hours = (aimMs - game.now()) / 3600000;
  log(`  aim ${clock(aimMs)}${tomorrow ? ' tomorrow' : ''} (${tz()}, this machine's clock)`
    + (hours > 12 ? ` — ${Math.floor(hours)}h away: if you meant today, that time has passed` : ''));
  if (edge < 100 || edge > 900) {
    log('  note: that is right on a second boundary, so a few ms of network jitter can split the'
      + ' landings over two seconds. Aim mid-second instead, e.g. .500');
  }
  const kind = { mine: 'your own tile', alliance: 'your alliance\'s tile', unowned: 'a tile with no alliance', other: 'someone else\'s tile' }[cls];
  const relief = Number(params.relief) > 1
    ? `the city's Relief Station x${params.relief} ${reliefApplies(game, cls) ? 'applies' : 'does not apply'}`
      + (model(game).relief.has(cls) ? ' (learned from an earlier landing)' : '')
    : 'no Relief Station speed from this city';
  log(`  ${kind}: ${relief} · march skill ${params.marchSkill}, drive skill ${params.driveSkill}`
    + (params.fallback ? ' (troop params unavailable — using the login values)' : ''));

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const pl = plan({ game, castle, from, target, troopKeys, aimMs, params, cls, key });
    log(`  march ${dur(pl.march)}${pl.scale !== 1 ? ` (x${pl.scale.toFixed(4)} learned)` : ''}, camp ${dur(pl.restTimeSec * 1000)},`
      + ` send in ${((pl.sendAt - game.now()) / 1000).toFixed(3)}s, ${pl.leadMs} ms ahead for the network`);
    const bean = makeBean(pl.restTimeSec);
    if (dryRun) { log('  [dry run] not sent'); return { sent: false, why: 'dry run' }; }

    const before = new Set(armies(game).map((x) => x.armyId));
    if (!(await waitUntil(game, pl.sendAt, stopped))) { log('  stopped before it was sent'); return { sent: false, why: 'stopped' }; }
    const r = await game.newArmy(cid, bean);
    log('  -> ' + verdict(r));
    if (!r || r.ok !== 1) return { sent: false, r, why: 'refused' };

    // A miss no speed rule could explain (the Relief Station either way, plus
    // the network) says the stamp was misread, not the march. Recalling on a
    // misreading would throw away good marches, so it is left alone.
    const R = Math.max(2, Number(params.relief) || 0);
    const fits = (e) => e >= -pl.march * (1 - 1 / R) - 10000 && e <= pl.march * (R - 1) + 10000;
    const army = await findArmy(game, { castle, bean, before, timeoutMs: checkMs });
    const landing = army ? landingOf(game, army, aimMs, fits) : null;
    if (landing === null) {
      log('  the server has not shown this march, so its landing cannot be checked');
      return { sent: true, r, bean, landing: null };
    }
    const err = landing - aimMs;
    if (!fits(err)) {
      log(`  the server's stamp (reachTime ${army.reachTime}, restTime ${army.restTime}) does not fit this march at all —`
        + ' left alone, not recalled. Check it with buildstatus or in the game');
      return { sent: true, r, bean, landing: null, odd: true };
    }
    const peers = moment(game, aimMs).filter((p) => p.armyId !== army.armyId);
    const j = judge(landing, aimMs, peers);
    const lesson = learn(game, key, pl, err, j.whole, { relief: params.relief, cls });
    if (j.ok) {
      record(aimMs, { armyId: army.armyId, landing, castleId: cid, fieldId: targetPoint });
      const all = moment(game, aimMs);
      log(`  server: lands ${clock(landing)} (${signed(landing - aimMs)})`
        + ` — ${all.length} march${all.length === 1 ? '' : 'es'} due then${all.length > 1 ? `, ${Math.round(spread(all))} ms apart` : ''}`);
      return { sent: true, r, bean, landing };
    }

    log(`  server: lands ${clock(landing)} (${signed(landing - aimMs)}) — MISSED:`
      + (j.anchor === null ? ' not on the aimed moment' : ` not with the ${peers.length} already due at ${clock(j.anchor)}`));
    if (lesson) log('  ' + lesson);
    let rr;
    try { rr = await game.recallArmy(cid, army.armyId); } catch (e) { rr = { ok: 0, errorMsg: e.message }; }
    if (!rr || rr.ok !== 1) {
      log(`  RECALL REFUSED (${verdict(rr)}) — it will land ${clock(landing)}, out of step. Recall it in the game before then.`);
      return { sent: true, r, bean, landing, missed: true };
    }
    log('  recalled — waiting for it to come home');
    if (!(await waitHome(game, army.armyId, stopped))) {
      log(stopped() ? '  stopped — it is on its way home and is not sent again' : '  it is not home yet, so it is not sent again');
      return { sent: false, why: stopped() ? 'stopped' : 'recalled' };
    }
    if (attempt === MAX_RETRIES) {
      log(`  gave up after ${MAX_RETRIES + 1} tries — this line did not land`);
      return { sent: false, why: 'missed' };
    }
    log(`  home — sending it again (try ${attempt + 2} of ${MAX_RETRIES + 1})`);
  }
  return { sent: false, why: 'missed' };
}

// `marchcheck`: hold the client formula against the server's own times for
// every march this account has out, before anything rides on it. Both stamps
// are the server's (startTime, reachTime), so the network plays no part: a
// right formula agrees to the millisecond. Each march is worked out with and
// without the sending city's Relief Station, which shows the server's relief
// rule for that kind of tile. Read-only, apart from asking for troop params.
async function check(game, log) {
  const out = armies(game).filter((a) => Number(a.direction) === 1 && Number(a.reachTime) > 0 && Number(a.startTime) > 0);
  if (!out.length) { log('  no marches out to compare against — send one (a scout will do) and run this again'); return 0; }
  const ms = (v) => (Number(v) < 1e11 ? Number(v) * 1000 : Number(v));
  const MISSIONS = Object.fromEntries(Object.entries(C.MISSION).map(([k, v]) => [v, k]));
  let exact = 0, near = 0, shown = 0;
  for (const a of out) {
    const castle = (game.castles || []).find((c) => Number(c.fieldId) === Number(a.startFieldId));
    if (!castle) continue;
    const params = await speedParams(game, castle);
    const keys = Object.entries(a.troop || a.troops || {}).filter(([k, v]) => C.BY_KEY[k] && Number(v) > 0).map(([k]) => k);
    if (!keys.length) continue;
    const start = ms(a.startTime);
    const server = ms(a.reachTime) - start - (Number(a.restTime) || 0) * 1000;
    const from = C.fieldIdToCoords(Number(a.startFieldId)), to = C.fieldIdToCoords(Number(a.targetFieldId));
    const base = { marchSkill: params.marchSkill, driveSkill: params.driveSkill, castleBuffs: castle.buffs, playerBuffs: game.player && game.player.buffs, now: start };
    const plain = C.marchTimeMs(from, to, keys, base);
    const relieved = Number(params.relief) > 1 ? C.marchTimeMs(from, to, keys, { ...base, relief: params.relief }) : null;
    const useRelief = relieved !== null && Math.abs(server - relieved) < Math.abs(server - plain);
    const formula = useRelief ? relieved : plain;
    const off = server - formula;
    if (Math.abs(off) <= 1) exact++; else if (Math.abs(off) <= 1000) near++;
    shown++;
    log(`  ${String(castle.name).padEnd(14)} -> ${to.x},${to.y}  ${(MISSIONS[Number(a.missionType)] || 'mission ' + a.missionType).padEnd(9)}`
      + ` server ${dur(server)}  formula ${dur(formula)}${relieved !== null ? (useRelief ? ' with' : ' without') + ` relief x${params.relief}` : ''}`
      + `  ${signed(off)}`);
  }
  if (!shown) { log('  none of the marches out came from a city of this account'); return 0; }
  log(`  ${exact} of ${shown} to the millisecond, ${near} within a second, ${shown - exact - near} further out`
    + (exact === shown ? ' — the formula is the server\'s' : ''));
  return shown;
}

module.exports = {
  send, check, plan, judge, learn, landingOf, targetClass, moment, record, spread, model, clock, dur, signed, tz,
  MOMENTS, RELIEF_CLASSES, TOL_MS, TOL_FIRST_MS, MAX_RETRIES,
};
