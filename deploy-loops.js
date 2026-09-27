'use strict';
// NEAT's background attacks for scripts (script-cmd-deploy.js parses them):
//
//   spamattack 111,222 c:500,s:500 10    10 waves, one after another, each with an idle
//                                        SpamHero at 100 loyalty
//   loyaltyattack 111,222 s:100,c:5k     a wave every 30 s until the target's loyalty is 7
//                                        or lower (a bare number is cavalry; none is 500)
//   capture 111,222 3000                 a wave every 30 s until the city is taken
//     both: a battle lost there recalls every attack of yours on its way to it, from any city;
//     and both stop after 100 waves or 12 hours (/waves=N /hours=N on the line change that),
//     or when 3 reports in a row about the target cannot be read (the waves would go on blind)
//   guardedattack 111,222 cav:99000,s:1000 10 a:500000 ab:1
//                                        the attack goes now (the line reports it); 10 scouts
//                                        follow, timed to land 15-30 s before it, and the attack
//                                        is recalled if they die, bring no report, or see
//                                        a:500000 OR ab:1 or more there
//   setguard 111,222 a:60000,cav:50000 ab:100    the same watch over attacks already on their way
//   endspamattack | endloyaltyattack (capture too) | endguardedattack (setguard too) [all]
//   attackstatus
//
// One task per kind, target and city: the same line again while its task runs
// (a script loop, a second run) says so and starts nothing — the end... line
// ends the one running. A console runs 10 at most at once (LIMITS). A
// guardedattack whose city is gone, or whose guard fails, recalls its attack.
//
// NEAT runs these beside the script: the line that starts one returns, the script
// carries on or ends, and the end... line stops it. Each is a task on the
// console's session, like holiday-snipe.js: it reads the session's game afresh at
// every step (a reconnect is a new Game), waits while the console is offline,
// stops if the console switches account, and writes to the Log tab under its
// city. It does not survive a console restart. The console's Stop button ends
// the script, not these.
//
// How a task knows what happened: the army reports. New ones about the target
// are opened with report.markAsRead — the only way the client opens one
// (ReportCommands.as:31), so they show as read in the game too — one at a time
// with the console's own report calls (Session.mrQueue), and decoded with
// mailbox.js. A battle report gives the loyalty CHANGE (BattleReportDetail:
// 民心变化, "loyalty change"); only a scout report gives the level (ScoutInfoUi's
// support). So loyaltyattack starts from your latest scout report of the target
// and refuses to start without one.
const C = require('./constants');
const D = require('./script-cmd-deploy');

const TIMING = {
  tickMs: 1000,         // how often a task looks at the world
  waveMs: 30000,        // loyaltyattack / capture: one wave every 30 s (wiki)
  spamGapMs: 3000,      // spamattack: between waves
  idleMs: 5000,         // no SpamHero free: look again after this
  reportMs: 10000,      // how often the army reports are read while waves go out
  guardPollMs: 2000,    // guards: how often, once the scouts are due
  findArmyMs: 5000,     // how long a new march may take to show in selfArmys
  marginMs: 3000,       // a guard decides this long before the attack lands, at the latest
  stopWaitMs: 5000,     // end...: how long to wait for a task to wind down
  offlineMs: 2000,
};
const MAX_REFUSED = 3;
const LOYALTY_FLOOR = 7;
// Bounds on what runs in the background (a script in a loop starts lines again
// and again, and a task outlives the script):
const LIMITS = {
  tasks: 10,            // background attacks per console at once
  waves: 100,           // loyaltyattack / capture: waves a line sends at most (/waves=N)
  hours: 12,            // ... and for how long (/hours=N)
  unreadable: 3,        // reports in a row about the target that cannot be read end it
};

const TASKS = new Map();
let seq = 0;

const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const verdict = (r) => (!r ? 'no response' : r.ok === 1 ? 'ok'
  : `FAILED (ok=${r.ok})` + (r.errorMsg ? ` - ${r.errorMsg}` : ` ${JSON.stringify(r)}`));
const dur = (ms) => require('./timed-march').dur(ms);
const clock = (ms) => require('./timed-march').clock(ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// epoch seconds or ms -> ms
const msOf = (v) => { const n = Number(v); return !Number.isFinite(n) || n <= 0 ? null : n < 1e11 ? n * 1000 : n; };
// "NPC(111,222)" -> {x, y} (ReportBean.targetPos)
const posOf = (s) => { const m = String(s == null ? '' : s).match(/\((\d+)\s*,\s*(\d+)\)\s*$/); return m ? { x: +m[1], y: +m[2] } : null; };
const samePlace = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y;
const outbound = (a) => Number(a.direction) === 1;
// A task's own attacks on the tile: the ones that left ITS city. Not the whole
// account's — a lost wave in one city must never recall another city's hits on the
// same target (the user, 2026-09-23; ally-drain.txt had it happen live).
const attacksTo = (g, fid, homeFieldId) => D.armiesOf(g).filter((a) => outbound(a)
  && Number(a.missionType) === C.MISSION.attack && Number(a.targetFieldId) === fid
  && (homeFieldId === undefined || Number(a.startFieldId) === Number(homeFieldId)));

// ------------------------------------------------------------------ reports

// A reply names only its command, so these go one at a time with the console's
// Mail and Reports tabs (Session.mrQueue).
const queued = (session, fn) => (session && typeof session.mrQueue === 'function' ? session.mrQueue(fn) : fn());

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (v === null || v === undefined || v === '' ? [] : Array.isArray(v) ? v : [v]);
const bool = (v) => {
  if (v === true || v === false) return v;
  if (v === null || v === undefined || v === '') return null;
  const s = String(isObj(v) ? v._text : v).toLowerCase();
  return s === 'true' || s === '1' ? true : s === 'false' || s === '0' ? false : null;
};
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(isObj(v) ? v._text : v);
  return Number.isFinite(n) ? n : null;
};
// A scout's count: a number, or a range at a lower Informatics ("1000-2000"),
// read as its top so a guard errs toward calling the attack off. null: not shown.
function countOf(v) {
  const n = numOrNull(v);
  if (n !== null) return n;
  const m = String(isObj(v) ? v._text : v).match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  return m ? Number(m[2]) : null;
}
const unitsOf = (v) => {
  const out = new Map();
  for (const u of list(v).filter(isObj)) out.set(Number(u.typeId), countOf(u.count));
  return out;
};

// A report's XML -> what the tasks need of it (mailbox.js reads the same XML
// for the Reports tab: battle() and scout()).
function decode(content) {
  let root;
  try { root = require('./mailbox').parseXml(String(content == null ? '' : content)); } catch { return null; }
  const data = isObj(root) && isObj(root.reportData) ? root.reportData : null;
  if (!data) return null;
  const has = (k) => Object.prototype.hasOwnProperty.call(data, k);
  if (has('battleReport')) {
    const b = isObj(data.battleReport) ? data.battleReport : {};
    return { kind: 'battle', mine: bool(b.isAttack) === true, attackerWon: bool(b.isAttackSuccess),
      seized: bool(b.isSeize) === true, loyaltyChange: numOrNull(b.support) };
  }
  if (has('scoutReport')) {
    const s = isObj(data.scoutReport) ? data.scoutReport : {};
    const info = isObj(s.scoutInfo) ? s.scoutInfo : null;
    return {
      kind: 'scout', mine: bool(s.isAttack) === true, success: bool(s.isSuccess), info: !!info,
      loyalty: info ? numOrNull(info.support) : null,
      troops: info && isObj(info.troops) ? unitsOf(info.troops.troopStrType) : null,
      forts: info && isObj(info.fortifications) ? unitsOf(info.fortifications.fortificationsType) : null,
    };
  }
  return { kind: 'other' };
}

// report id -> decoded, per connection, shared by tasks watching one place
const CONTENT = new WeakMap();
async function contentOf(session, g, row) {
  let cache = CONTENT.get(g);
  if (!cache) { cache = new Map(); CONTENT.set(g, cache); }
  if (cache.has(row.id)) return cache.get(row.id);
  let src = row.content;
  if (src === undefined || src === null || src === '') {
    // report.markAsRead {reportId} (ReportCommands.as:31) -> ReportResponse {report}
    const d = await queued(session, () => g.readReport(row.id));
    src = d && d.report ? d.report.content : null;
  }
  const rep = decode(src);
  if (rep) Object.assign(rep, { id: row.id, at: msOf(row.eventTime) });
  cache.set(row.id, rep);
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return rep;
}
// report.receiveReportList {pageNo, pageSize, reportType} (ReportCommands.as:43-48)
const reportPage = (session, g, page) => queued(session, () => g.reportList('army', page, 20));
const byTime = (a, b) => (msOf(a.eventTime) || 0) - (msOf(b.eventTime) || 0) || Number(a.id) - Number(b.id);

// Your newest scout report of the target that shows its loyalty, or null.
async function scoutedLoyalty(session, g, target, maxReads = 10) {
  let reads = 0;
  for (let page = 1; page <= 3 && reads < maxReads; page++) {
    const d = await reportPage(session, g, page);
    const rows = ((d && d.reports) || []).filter((r) => samePlace(posOf(r.targetPos), target)).sort(byTime).reverse();
    for (const r of rows) {
      if (reads++ >= maxReads) break;
      const rep = await contentOf(session, g, r);
      if (rep && rep.kind === 'scout' && rep.mine && rep.loyalty !== null) return { loyalty: rep.loyalty, at: rep.at };
    }
    if (!d || !Number(d.totalPage) || page >= Number(d.totalPage)) break;
  }
  return null;
}

// Is it safe to let the attack land? Any one amount at or over its limit (OR,
// as the wiki says) calls it off, and so does anything the report cannot show.
function judge(rep, limits) {
  if (rep.success === false) return { recall: true, why: 'the scouts were wiped out' };
  if (!rep.info) return { recall: true, why: 'the scout report shows nothing of the city (Informatics too low?)' };
  const over = [], seen = [];
  const look = (units, want, idOf, nameOf, what) => {
    const keys = Object.keys(want || {});
    if (!keys.length) return;
    if (!units) { over.push(`the report shows no ${what}, so they cannot be checked`); return; }
    for (const k of keys) {
      const v = units.has(idOf(k)) ? units.get(idOf(k)) : 0;
      if (v === null) { over.push(`the report does not show how many ${nameOf(k)}`); continue; }
      seen.push(`${fmt(v)} ${nameOf(k)}`);
      if (v >= want[k]) over.push(`${fmt(v)} ${nameOf(k)} (limit ${fmt(want[k])})`);
    }
  };
  look(rep.troops, limits.troops, (k) => C.BY_KEY[k].typeId, (k) => C.BY_KEY[k].name, 'troops');
  look(rep.forts, limits.forts, (k) => C.WALL_BY_CODE[k].typeId, (k) => C.WALL_BY_CODE[k].name, 'fortifications');
  return over.length ? { recall: true, why: over.join(', ') } : { recall: false, seen: seen.join(', ') || 'nothing listed' };
}
const limitText = (limits) => [
  ...Object.entries(limits.troops || {}).map(([k, n]) => `${fmt(n)} ${C.BY_KEY[k].name}`),
  ...Object.entries(limits.forts || {}).map(([k, n]) => `${fmt(n)} ${C.WALL_BY_CODE[k].name}`),
].join(' OR ') + ' or more';

// ------------------------------------------------------------------- a task

const END_WORD = { spamattack: 'endspamattack', loyaltyattack: 'endloyaltyattack', capture: 'endloyaltyattack',
  guardedattack: 'endguardedattack', setguard: 'endguardedattack' };

class Task {
  constructor(session, a, game, castle) {
    this.id = ++seq;
    this.kind = a.cmd;
    this.a = a;
    this.session = session;
    this.accountId = session.account ? session.account.id : null;
    this.castleId = game.castleId(castle);
    this.cityName = castle.name;
    this.target = a.target;
    this.fieldId = C.coordsToFieldId(a.target.x, a.target.y);
    this.homeFieldId = Number(castle.fieldId);   // only this city's marches are this task's
    this.started = Date.now();
    this.since = game.now();          // server clock: reports from then on are this task's
    this.baseline = new Set();        // report ids already there when it began
    this.handled = new Set();
    this.stats = { sent: 0, refused: 0, recalled: 0 };
    this.loyalty = null;
    this.drops = [];
    this.maxWaves = a.maxWaves || LIMITS.waves;              // loyaltyattack / capture
    this.maxMs = (a.maxHours || LIMITS.hours) * 3600000;
    this.unreadable = 0;
    this.running = false;
    this.why = null;
    this.state = 'starting';
    this.done = Promise.resolve();
  }
  get where() { return `${this.target.x},${this.target.y}`; }
  label() { return `#${this.id} ${this.kind} ${this.where} from ${this.cityName}`; }
  say(m) { this.session.note(`${this.kind} #${this.id} ${this.where}: ${m}`, { city: this.cityName, kind: 'act' }); }
  get game() {
    const s = this.session;
    return s.connected && s.game ? s.game : null;
  }
  castle(g) { return (g.castles || []).find((c) => g.castleId(c) === this.castleId) || null; }
  // A sleep that stop() cuts short.
  nap(ms) {
    return new Promise((r) => {
      const t = setTimeout(() => { this._wake = null; r(); }, Math.max(0, ms));
      this._wake = () => { clearTimeout(t); this._wake = null; r(); };
    });
  }
  stop(why) { this.running = false; this.why = this.why || why; if (this._wake) this._wake(); }
  end(why) { if (!this.ended) { this.ended = true; this.why = this.why || why; this.say(`${why} — done (${this.summary()})`); } this.running = false; }
  // The game to act on now, or null after a nap (offline) or when it must stop.
  async ready() {
    if ((this.session.account ? this.session.account.id : null) !== this.accountId) { this.end('the console switched account'); return null; }
    const g = this.game;
    if (!g) { await this.nap(TIMING.offlineMs); return null; }
    return g;
  }
  summary() {
    const s = this.stats;
    const rec = s.recalled ? `, ${s.recalled} recalled` : '';
    if (this.kind === 'spamattack') return `${s.sent} of ${this.a.waves} waves sent, ${s.refused} refused${rec}`;
    if (this.kind === 'loyaltyattack') return `${s.sent} waves sent, loyalty ${this.loyalty === null ? 'not known' : this.loyalty}${rec}`;
    if (this.kind === 'capture') return `${s.sent} waves sent${rec}`;
    return this.state + rec;
  }
  start(body) {
    this.running = true;
    TASKS.set(this.id, this);
    this.done = body(this)
      .catch(async (e) => {
        // a guard that fails must not leave its attack to land unwatched
        const g = this.armyIds && this.armyIds.size ? this.game : null;
        if (g) { try { await this.recall(g, liveAttacks(g, this), 'its guard stopped on an error'); } catch { /* said below */ } }
        this.end('stopped on an error: ' + e.message);
      })
      .finally(() => {
        if (!this.ended) this.end(this.why ? `ended by ${this.why}` : 'ended');
        this.running = false;
        TASKS.delete(this.id);
      });
  }

  // The army reports about the target that are new to this task, oldest first.
  // this.unreadable counts those in a row that could not be read (no content,
  // or neither a battle nor a scout report): a wave's result is only known
  // from its report, so the waves must not go on blind.
  async reports(g) {
    const d = await reportPage(this.session, g, 1);
    const out = [];
    for (const r of ((d && d.reports) || []).slice().sort(byTime)) {
      if (this.handled.has(r.id)) continue;
      this.handled.add(r.id);
      const at = msOf(r.eventTime);
      if (this.baseline.has(r.id) || (at !== null && at < this.since)) continue;
      if (!samePlace(posOf(r.targetPos), this.target)) continue;
      const rep = await contentOf(this.session, g, r);
      if (!rep || (rep.kind !== 'battle' && rep.kind !== 'scout')) { this.unreadable = (this.unreadable || 0) + 1; continue; }
      this.unreadable = 0;
      out.push(rep);
    }
    return out;
  }
  async snapshot(g) {
    try { for (const r of ((await reportPage(this.session, g, 1)) || {}).reports || []) this.baseline.add(r.id); } catch { /* the time filter still holds */ }
  }

  // One attack at the target. true when the server took it.
  async wave(g, castle, hero, label) {
    const bean = g.buildArmyBean({ missionType: C.MISSION.attack, heroId: hero ? hero.id : undefined,
      targetPoint: this.fieldId, troops: this.a.troops, resources: {} });
    let r;
    try { r = await g.newArmy(g.castleId(castle), bean); } catch (e) { r = { ok: 0, errorMsg: e.message }; }
    const ok = !!(r && r.ok === 1);
    if (ok) { this.stats.sent++; if (hero) D.markSent(g, hero.id); } else this.stats.refused++;
    this.say(`${label}: ${D.troopTextOf(this.a.troops)}, hero ${hero ? hero.name : 'none'} -> ${verdict(r)}`);
    return ok;
  }

  // army.callBackArmy {castleId, armyId} (ArmyCommands.as:105-116), from the city it left.
  async recall(g, armies, why) {
    for (const a of armies) {
      const home = D.homeOf(g, a);
      if (!home) { this.say(`${D.armyText(g, a)}: cannot tell which city it left from — NOT recalled`); continue; }
      let r;
      try { r = await g.recallArmy(g.castleId(home), a.armyId); } catch (e) { r = { ok: 0, errorMsg: e.message }; }
      if (r && r.ok === 1) this.stats.recalled++;
      this.say(`recall ${D.armyText(g, a)} (${why}) -> ${verdict(r)}`);
    }
  }
}

// --------------------------------------------------------------- the bodies

async function spamBody(t) {
  let refusedRow = 0, waiting = false;
  while (t.running && t.stats.sent < t.a.waves) {
    const g = await t.ready();
    if (!g) continue;
    const castle = t.castle(g);
    if (!castle) { t.end('its city is not there any more'); break; }
    const hero = D.spamPool(t.session, g, castle, { skip: D.recentSkip(g), loyal: true }).heroes[0];
    if (!hero) {
      if (!waiting) t.say(`no SpamHero at 100 loyalty is free in ${castle.name} — waiting for one`);
      waiting = true;
      await t.nap(TIMING.idleMs);
      continue;
    }
    waiting = false;
    if (await t.wave(g, castle, hero, `wave ${t.stats.sent + 1} of ${t.a.waves}`)) refusedRow = 0;
    else if (++refusedRow >= MAX_REFUSED) { t.end(`the server refused ${MAX_REFUSED} waves in a row`); break; }
    if (t.running && t.stats.sent < t.a.waves) await t.nap(TIMING.spamGapMs);
  }
  if (t.stats.sent >= t.a.waves) t.end(`all ${t.a.waves} waves sent`);
}

// loyaltyattack and capture: a wave every waveMs, the reports read every reportMs.
async function loyaltyBody(t) {
  const capture = t.kind === 'capture';
  let lastWave = 0, lastRead = 0, refusedRow = 0, waiting = false, holding = false;
  while (t.running) {
    const g = await t.ready();
    if (!g) continue;
    const castle = t.castle(g);
    if (!castle) { t.end('its city is not there any more'); break; }

    if (Date.now() - lastRead >= TIMING.reportMs) {
      lastRead = Date.now();
      let reps = [];
      try { reps = await t.reports(g); } catch (e) { t.say(`could not read the reports (${e.message}) — trying again`); }
      const before = t.loyalty;
      for (const r of reps) {
        if (r.kind === 'battle' && r.mine) {
          if (r.loyaltyChange !== null) {
            t.drops.push(r.loyaltyChange);
            if (t.loyalty !== null) t.loyalty = Math.max(0, t.loyalty + r.loyaltyChange);
          }
          if (r.seized) t.taken = true;
          else if (r.attackerWon === false) t.lost = true;
        } else if (r.kind === 'scout' && r.mine && r.loyalty !== null) t.loyalty = r.loyalty;
      }
      if (t.loyalty !== before && t.loyalty !== null) t.say(`loyalty ${t.loyalty}`);
    }
    if ((t.unreadable || 0) >= LIMITS.unreadable) {
      t.end(`${t.unreadable} reports in a row about ${t.where} could not be read, so what the waves did is not known — stopped (the waves on their way are left to land)`);
      break;
    }
    if (t.stats.sent >= t.maxWaves) { t.end(`${t.maxWaves} waves sent — the most this line sends (write /waves=N on it for more)`); break; }
    if (Date.now() - t.started >= t.maxMs) { t.end(`it ran ${dur(t.maxMs)} — the longest this line runs (write /hours=N on it for longer)`); break; }
    if (t.lost) {
      await t.recall(g, attacksTo(g, t.fieldId, t.homeFieldId), 'a wave lost its battle there');
      t.end(`a wave lost its battle, so ${t.cityName}'s attacks on their way there were recalled (no other city's)`);
      break;
    }
    if (t.taken) {
      const left = attacksTo(g, t.fieldId, t.homeFieldId).length;
      t.end(`${t.where} was taken${left ? ` — the ${left} wave(s) still on the way are left to land` : ''}`);
      break;
    }
    if (!capture && t.loyalty !== null && t.loyalty <= LOYALTY_FLOOR) {
      await t.recall(g, attacksTo(g, t.fieldId, t.homeFieldId), `loyalty is down to ${t.loyalty}`);
      t.end(`loyalty is ${t.loyalty}`);
      break;
    }

    // loyaltyattack holds back while the waves already out should take it to 7
    const out = attacksTo(g, t.fieldId, t.homeFieldId).length;
    const avg = t.drops.length ? t.drops.reduce((s, x) => s + x, 0) / t.drops.length : 0;
    const expect = capture || t.loyalty === null ? null : t.loyalty + avg * out;
    const hold = expect !== null && avg < 0 && expect <= LOYALTY_FLOOR;
    if (hold !== holding) {
      t.say(hold ? `holding: the ${out} wave(s) on the way should take loyalty from ${t.loyalty} to about ${Math.max(0, Math.round(expect))}` : 'sending again');
      holding = hold;
    }
    if (!hold && Date.now() - lastWave >= TIMING.waveMs) {
      const hero = D.spamPool(t.session, g, castle, { skip: D.recentSkip(g) }).heroes[0];
      if (!hero) {
        if (!waiting) t.say(`no SpamHero is free in ${castle.name} — waiting for one`);
        waiting = true;
      } else {
        waiting = false;
        lastWave = Date.now();
        if (await t.wave(g, castle, hero, `wave ${t.stats.sent + 1}`)) refusedRow = 0;
        else if (++refusedRow >= MAX_REFUSED) { t.end(`the server refused ${MAX_REFUSED} waves in a row`); break; }
      }
    }
    await t.nap(TIMING.tickMs);
  }
}

// guardedattack (after its attack went out) and setguard.
async function guardBody(t) {
  if (t.kind === 'guardedattack') {
    t.state = `scouts go at ${clock(t.scoutAt)}`;
    let g = null;
    while (t.running) {
      g = await t.ready();
      if (!g) continue;
      const left = t.scoutAt - g.now();
      if (left <= 0) break;
      await t.nap(Math.min(TIMING.tickMs, left));
    }
    if (!t.running) { if (!t.ended) t.end('ended before the scouts went — the attack is left on its way (recall x,y calls it back)'); return; }
    const castle = t.castle(g);
    if (!castle) {
      // no city to send the scouts from: the attack cannot be guarded, so it comes back
      await t.recall(g, liveAttacks(g, t), 'its city is gone, so no scouts can go');
      t.state = 'recalled: its city is gone';
      t.end(`${t.cityName} is not one of your cities any more, so no scouts could go — the attack was recalled where it could be`);
      return;
    }
    const bean = g.buildArmyBean({ missionType: C.MISSION.scout, targetPoint: t.fieldId, troops: { scouter: t.a.scouts }, resources: {} });
    let r;
    try { r = await g.newArmy(g.castleId(castle), bean); } catch (e) { r = { ok: 0, errorMsg: e.message }; }
    t.say(`${fmt(t.a.scouts)} scouts, no hero -> ${verdict(r)}`);
    if (!r || r.ok !== 1) {
      await t.recall(g, liveAttacks(g, t), 'its scouts could not be sent');
      t.state = 'recalled: no scouts';
      t.end('the scouts could not be sent, so the attack was recalled');
      return;
    }
    t.scoutLands = g.now() + t.scoutMs;
    t.state = `scouts land ${clock(t.scoutLands)}, the attack ${clock(t.landing)}`;
  } else t.state = `watching for a scout report before ${clock(t.landing)}`;

  let lastRead = 0;
  while (t.running) {
    const g = await t.ready();
    if (!g) continue;
    const live = liveAttacks(g, t);
    if (!live.length) { t.state = 'the attack is no longer on its way'; t.end('the attack is no longer on its way (landed or recalled)'); return; }
    // read while the scouts are due: from a second before they land, or at
    // once when none of ours is seen on the way; every reportMs while far off
    const scoutsOut = D.armiesOf(g).filter((a) => outbound(a) && Number(a.missionType) === C.MISSION.scout && Number(a.targetFieldId) === t.fieldId);
    const due = t.scoutLands || Math.min(...scoutsOut.map((a) => require('./timed-march').landingOf(g, a) || Infinity), Infinity);
    const near = !Number.isFinite(due) || g.now() >= due - 1000 || t.landing - g.now() < 60000;
    if (Date.now() - lastRead >= (near ? TIMING.guardPollMs : TIMING.reportMs)) {
      lastRead = Date.now();
      let reps = [];
      try { reps = await t.reports(g); } catch (e) { t.say(`could not read the reports (${e.message})`); }
      const rep = reps.filter((x) => x.kind === 'scout' && x.mine).pop();
      if (rep) {
        const j = judge(rep, t.a.limits);
        if (j.recall) {
          await t.recall(g, live, j.why);
          t.state = `recalled: ${j.why}`;
          t.end(`called off — ${j.why}`);
        } else {
          t.state = `let through: ${j.seen}`;
          t.end(`the scouts saw ${j.seen} — under every limit, so the attack goes on`);
        }
        return;
      }
    }
    if (g.now() >= t.landing - TIMING.marginMs) {
      await t.recall(g, live, 'no scout report came back before it lands');
      t.state = 'recalled: no scout report';
      t.end('no scout report came back in time, so the attack was recalled');
      return;
    }
    await t.nap(Math.min(TIMING.tickMs, TIMING.guardPollMs));
  }
  if (!t.ended) t.end('ended — the attack is left as it is (recall x,y calls it back)');
}
const liveAttacks = (g, t) => D.armiesOf(g).filter((a) => outbound(a) && t.armyIds.has(a.armyId));

// Our new army as the server pushed it (as timed-march.js finds one).
async function findArmy(game, castle, bean, before) {
  const until = Date.now() + TIMING.findArmyMs;
  for (;;) {
    const hit = D.armiesOf(game).find((x) => !before.has(x.armyId) && outbound(x)
      && Number(x.missionType) === Number(bean.missionType) && Number(x.targetFieldId) === Number(bean.targetPoint)
      && (x.startFieldId === undefined || Number(x.startFieldId) === Number(castle.fieldId)));
    if (hit || Date.now() >= until) return hit || null;
    await sleep(50);
  }
}

// ------------------------------------------------------------- the commands

// The same line again (a loop in a script, a second run of it) finds its task
// still running: one task per kind, target and city, and the line says so and
// starts nothing (NEAT's end... word ends it). A console runs LIMITS.tasks at most.
function sameTask(session, kind, castleId, fid) {
  return [...TASKS.values()].find((t) => t.running && t.session === session && t.kind === kind
    && Number(t.castleId) === Number(castleId) && t.fieldId === fid) || null;
}
const runningOn = (session) => [...TASKS.values()].filter((t) => t.running && t.session === session);

// A script line starts a task. -> { ok, error?, id?, done?, lines }
async function start(a, env) {
  const game = env.game;
  const castle = env.castle;
  const kind = a.cmd;
  const where = `${a.target.x},${a.target.y}`;
  const fid = C.coordsToFieldId(a.target.x, a.target.y);
  const own = (game.castles || []).find((c) => Number(c.fieldId) === fid);
  if (own) throw new Error(`${where} is your own city ${own.name}`);
  const lines = [];
  const troops = a.troops ? D.troopTextOf(a.troops) : '';
  if (env.session) {
    const twin = sameTask(env.session, kind, game.castleId(castle), fid);
    if (twin) {
      return { ok: true, id: twin.id, lines: [`${twin.label()} is already running (${twin.summary()}, for ${dur(Date.now() - twin.started)})`
        + ` — nothing new started; ${END_WORD[kind]} ends it`] };
    }
    const n = runningOn(env.session).length;
    if (n >= LIMITS.tasks) {
      const msg = `${n} background attacks are running on this console already — the most there can be; end one (endspamattack,`
        + ' endloyaltyattack, endguardedattack) or see them with attackstatus';
      return { ok: false, error: msg, lines: [msg] };
    }
  }
  if (kind === 'spamattack' || kind === 'loyaltyattack' || kind === 'capture') {
    const sr = D.spamPool(env.session, game, castle, { loyal: kind === 'spamattack' });
    const free = sr.heroes;
    lines.push(kind === 'spamattack'
      ? `${a.waves} waves of ${troops} at ${where}, one after another, each with an idle SpamHero at 100 loyalty`
      : `a wave of ${troops} at ${where} every ${Math.round(TIMING.waveMs / 1000)}s with an idle SpamHero, until `
        + (kind === 'capture' ? 'the city is taken' : `its loyalty is ${LOYALTY_FLOOR} or lower`)
        + ` (${fmt(a.maxWaves || LIMITS.waves)} waves or ${a.maxHours || LIMITS.hours} h at most, and ${LIMITS.unreadable} reports in a row that`
        + ` cannot be read stop it); a battle lost there recalls ${castle.name}'s attacks on their way to it (no other city's)`);
    lines.push(`SpamHeroes: ${sr.text} — free now: ${free.map((h) => h.name).join(', ') || 'none'}`);
  }

  if (kind === 'setguard') {
    // this city's attacks only: setguard in one city never watches (or recalls) another's
    const list = attacksTo(game, fid, castle.fieldId);
    if (!list.length) {
      const others = attacksTo(game, fid).length;
      throw new Error(`no attack from ${castle.name} is on its way to ${where} — send it (and a scout after it) first`
        + (others ? ` (${others} attack(s) of other cities are on their way there; setguard watches only this city's)` : ''));
    }
    const TM = require('./timed-march');
    const lands = list.map((x) => TM.landingOf(game, x)).filter((x) => x !== null);
    if (lands.length !== list.length) throw new Error(`the server gives no landing time for an attack on its way to ${where}, so it cannot be watched`);
    const landing = Math.min(...lands);
    const starts = list.map((x) => msOf(x.startTime)).filter((x) => x !== null);
    lines.push(`watching ${castle.name}'s ${list.length} attack(s) on their way to ${where} (the first lands ${clock(landing)}): recalled if the scouts die,`
      + ` bring no report by then, or see ${limitText(a.limits)}`);
    if (env.dryRun) return { ok: true, lines: [...lines, '[dry run] not started'] };
    const need = needSession(env, lines);
    if (need) return need;
    const t = new Task(env.session, a, game, castle);
    t.armyIds = new Set(list.map((x) => x.armyId));
    t.landing = landing;
    t.since = starts.length ? Math.min(...starts) : game.now() - 60000;
    t.start(guardBody);
    return started(t, lines);
  }

  if (kind === 'guardedattack') {
    const hero = D.pickHero(castle, 'any', { skip: D.recentSkip(game, env.sentHeroes), attackFirst: true });
    const bean = game.buildArmyBean({ missionType: C.MISSION.attack, heroId: hero ? hero.id : undefined, targetPoint: fid, troops: a.troops, resources: {} });
    const p = await D.paramsFor(game, castle);
    const from = game.castleXY(castle);
    const scoutMs = C.marchTimeMs(from, a.target, ['scouter'], { marchSkill: p.marchSkill, driveSkill: p.driveSkill,
      castleBuffs: castle.buffs, playerBuffs: game.player && game.player.buffs, now: game.now() }) || 0;
    lines.push(`attack -> (${where}) from ${castle.name} · hero ${hero ? hero.name : 'none'} · ${troops}; then ${fmt(a.scouts)} scouts timed to land`
      + ` 15-30 s before it (they march ${dur(scoutMs)}); the attack is recalled if they die, bring no report, or see ${limitText(a.limits)}`);
    if (env.dryRun) return { ok: true, lines: [...lines, '[dry run] not sent'] };
    if (!env.session || typeof env.session.note !== 'function') return needSession(env, lines);
    const before = new Set(D.armiesOf(game).map((x) => x.armyId));
    let r;
    try { r = await game.newArmy(game.castleId(castle), bean); } catch (e) { r = { ok: 0, errorMsg: e.message }; }
    lines.push('-> ' + env.say(r));
    if (!r || r.ok !== 1) return { ok: false, error: verdict(r), lines, done: 1 };
    if (hero) D.markSent(game, hero.id, env.sentHeroes);
    const army = await findArmy(game, castle, bean, before);
    const landing = army ? require('./timed-march').landingOf(game, army) : null;
    if (!army || landing === null) {
      const msg = `the attack went, but the server has not shown when it lands, so it is NOT guarded — recall ${where} calls it back`;
      lines.push(msg);
      return { ok: false, error: msg, lines, done: 1 };
    }
    const lead = 15000 + Math.random() * 15000;
    const t = new Task(env.session, a, game, castle);
    t.armyIds = new Set([army.armyId]);
    t.landing = landing;
    t.scoutMs = scoutMs;
    t.scoutAt = landing - lead - scoutMs;
    lines.push(`it lands ${clock(landing)}; the scouts go ${t.scoutAt <= game.now() ? 'now, and land ' + Math.round((landing - game.now() - scoutMs) / 1000) + 's ahead of it'
      : `at ${clock(t.scoutAt)} to land ${Math.round(lead / 1000)}s ahead of it`}`);
    t.start(guardBody);
    const out = started(t, lines);
    return { ...out, done: 1 };
  }

  if (env.dryRun) return { ok: true, lines: [...lines, '[dry run] not started'] };
  const need = needSession(env, lines);
  if (need) return need;
  const t = new Task(env.session, a, game, castle);
  if (kind === 'loyaltyattack') {
    // the level only comes from a scout report (see the top)
    const known = await scoutedLoyalty(env.session, game, a.target);
    if (!known) {
      const msg = `the loyalty of ${where} is not known — scout it first (scout ${where} none s:100): loyaltyattack stops at ${LOYALTY_FLOOR} by your scout reports, and the battle reports only give the change`;
      return { ok: false, error: msg, lines: [...lines, msg] };
    }
    t.loyalty = known.loyalty;
    lines.push(`loyalty ${known.loyalty} by your scout report${known.at ? ' of ' + new Date(known.at).toLocaleString() : ''}`);
  }
  await t.snapshot(game);
  t.start(kind === 'spamattack' ? spamBody : loyaltyBody);
  return started(t, lines);
}

function needSession(env, lines) {
  if (env.session && typeof env.session.note === 'function') return null;
  const msg = 'background attacks run inside the console — start this from a loadout there';
  return { ok: false, error: msg, lines: [...lines, msg] };
}
function started(t, lines) {
  return { ok: true, id: t.id, lines: [...lines, `started as #${t.id} — it goes on after this script ends; its lines go to the Log tab;`
    + ` ${END_WORD[t.kind]} ends it (the console's Stop does not)`] };
}

const ENDS = { endspamattack: ['spamattack'], endloyaltyattack: ['loyaltyattack', 'capture'], endguardedattack: ['guardedattack', 'setguard'] };
// end... : this city's tasks of those kinds, or every city's with `all`.
async function end(word, a, env) {
  const kinds = ENDS[word];
  const cid = env.game.castleId(env.castle);
  const running = [...TASKS.values()].filter((t) => kinds.includes(t.kind) && t.running);
  const mine = running.filter((t) => a.all || t.castleId === cid);
  if (!mine.length) {
    const others = running.length;
    return { stopped: 0, lines: [`no ${kinds.join(' or ')} running${a.all ? '' : ' from ' + env.castle.name}`
      + (others ? ` — ${others} from other cities; "${word} all" ends those` : '')] };
  }
  if (env.dryRun) return { stopped: 0, lines: mine.map((t) => `would end ${t.label()} (${t.summary()}) — [dry run] left running`) };
  for (const t of mine) t.stop(word);
  await Promise.race([Promise.all(mine.map((t) => t.done)), sleep(TIMING.stopWaitMs)]);
  return { stopped: mine.length, lines: mine.map((t) => `ended ${t.label()} — ${t.summary()}`) };
}

function status() {
  const list = [...TASKS.values()].filter((t) => t.running);
  if (!list.length) return { count: 0, lines: ['no background attacks running'] };
  return { count: list.length, lines: list.map((t) => `${t.label()}: ${t.summary()} (running ${dur(Date.now() - t.started)})`) };
}

// Tests: end everything at once.
async function stopAll() {
  const list = [...TASKS.values()];
  for (const t of list) t.stop('stopAll');
  await Promise.all(list.map((t) => t.done));
}

module.exports = { start, end, status, stopAll, decode, judge, scoutedLoyalty, TASKS, TIMING, CONTENT, LOYALTY_FLOOR, LIMITS };
