'use strict';
// War & defence goals: Hiding, Gate/GatePolicy, WarRules, WarTown, MonitorArmy.
//
// Everything in `plans` is PURE — it reads ctx/state and returns action
// descriptors. Nothing here touches the socket. `executors` are the only place
// a command is actually sent, keyed by action.kind, exactly as the engine's
// existing goal modules are wired.
//
// PROTOCOL FACTS, all read out of the decompiled client (src/scripts/...):
//   army.newArmy      {castleId, newArmyBean}          ArmyCommands.as:104
//   army.callBackArmy {castleId, armyId}               ArmyCommands.as:118
//   army.setArmyGoOut {castleId, isArmyGoOut:Boolean}  ArmyCommands.as:143
//   common.allianceChat {msg, languageType:int}        CommonCommands.as:172
//   newArmyBean.restTime is SECONDS  (NewArmyWin.as:2784 restTime = encampTime/1000)
//   castle.goOutForBattle is the gate flag             CastleBean.as:369
//     TrainningField.as:392-395 sets goOutForBattle then calls setArmyGoOut,
//     so goOutForBattle === true means "troops sally out" === GATE OPEN.
//   ArmyBean.reachTime is an ABSOLUTE server-epoch timestamp in ms:
//     CastlePercent.as:151 renders it as reachTime + timeDiff - localNow, and
//     Context.as:378 defines timeDiff = localNow - server.currentTime.
//     So remaining ms == reachTime - game.now().
//   ArmyBean carries its troop counts under `troop` (singular) as a
//     TroopStrBean, whose fields are STRINGS (TroopStrBean.as:11-35) — an
//     unscouted army reports "?" rather than a number.
//   army.newArmy replies with a bare CommandResponse {ok, errorMsg, msg,
//     packageId} — NO armyId (CommandResponse.as). A recall therefore needs the
//     armyId from a server.SelfArmysUpdate push; see ctx.selfArmies below.
//
// GOAL LINES (see `describe` at the bottom for the one-line summaries):
//   config hiding:<minutes|30s>          dodge an incoming attack
//   config gate:<minutes|6s>             open/close the gate before impact
//   config warrules:<minutes>            alliance-chat alerts
//   config wartown:<0|1|2>               lock the city down for war
//   wartownpolicy <start> <end> [...]    ...only between these times
//   config monitorarmy:<n>               accepted, does nothing (see below)
//   config keepatthome:<0|1>             keep the best attack hero home
//   config attackgap:<seconds>           waves this far apart are separate attacks
//   config defensecooldown:<minutes>     still "under attack" this long after a hit
//   config embassy:<0|1|2>               the embassy's alliance-troops box
//   config nohealing:<0|1>               never heal wounded troops
//   gatepolicy <na> <reg> <sb> <mix> <mnt> [/switches]
//   hidingpolicy /switch:value ...       (our addition — NEAT infers these)
//
// War town, keepatthome, attackgap, defensecooldown and nohealing are rules
// the OTHER goals read, not actions: they are exported as helpers (lockdown /
// isWarTown / keepAttHome / attackGroups / underAttack / healingAllowed) and
// reported by plans.wartown and plans.constraints so they are visible.
//
// ctx is {game, castle, goals, config, fortifications, incoming} as built by
// engine.js. Two OPTIONAL extras are used when present and degraded to a note
// when absent:
//   ctx.selfArmies  [{armyId, targetFieldId, missionType, reachTime}]  from
//                   server.SelfArmysUpdate — needed to recall a hidden army.
//   ctx.maintenance truthy while the server is in a maintenance window.
//   ctx.incomingByCastle {castleId: <number of inbound armies>} — lets hiding
//                   avoid running INTO a city that is itself under attack.
const C = require('./constants');

const n = (x) => Number(x || 0);
const fmt = (x) => Math.round(n(x)).toLocaleString('en-US');
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// TroopStrBean fields are strings and an unscouted army sends "?" — so a count
// is either a real number or genuinely unknown. Never coerce "?" to 0.
function count(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/[,\s]/g, '');
  if (!/^\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

const TROOP_KEYS = C.TROOPS.map((t) => t.key);
const RES_KEYS = ['iron', 'stone', 'wood', 'food'];

// HeroConstants.as — the mayor is status 1, NOT 2. 2 is the garrison.
const HERO = { FREE: 0, CHIEF: 1, GUARD: 2, SEND: 3, SEIZED: 4, BACK: 5, FARM: 8 };

// ---------------------------------------------------------------- durations
// goals.js's NUM() does Math.round(), so `config gate:0.1` arrives as 0 and
// `config hiding:0.5` arrives as 1. A value NUM cannot parse is passed through
// as the raw string instead, so "30s" / "90sec" / "2h" survive intact and are
// the way to ask for a sub-minute lead time today. Plain numbers mean MINUTES.
// (Do NOT write "2m" — NUM reads m as the millions multiplier.)
const DURATION = /^([\d.]+)\s*(ms|s|sec|secs|seconds?|min|mins|minutes?|h|hr|hours?)?$/i;
function durationMs(v, unit = 'min') {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return unit === 'sec' ? v * 1000 : v * 60000;
  const m = String(v).trim().match(DURATION);
  if (!m) return 0;
  const q = parseFloat(m[1]);
  if (!isFinite(q)) return 0;
  const u = (m[2] || unit).toLowerCase();
  if (u === 'ms') return q;
  if (u[0] === 's') return q * 1000;
  if (u[0] === 'h') return q * 3600000;
  return q * 60000;
}

// NEAT's defaults for the two defence timings (wiki AttackGap, DefenseCooldown).
const ATTACK_GAP_DEFAULT_MS = 6000;
const DEFENSE_COOLDOWN_DEFAULT_MS = 30 * 60000;

// "06:00" / "6:00" -> minutes after midnight; "24:00" is the end of the day.
function clockMin(s) {
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (mi > 59 || h > 24 || (h === 24 && mi > 0)) return null;
  return h * 60 + mi;
}
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// "06:00 12:00 22:00 02:00" -> [{from, to, text}] in minutes after midnight,
// with the errors. wartownpolicy reads its hours this way, and so does
// schedulepolicy (processing.js), on this machine's clock; a window may run
// past midnight (22:00 02:00).
function parseWindows(args, goal) {
  const errs = [], windows = [];
  const toks = (args || []).map(String).filter(Boolean);
  if (!toks.length) errs.push(`expected: ${goal} <start> <end> [<start> <end> ...], e.g. ${goal} 06:00 12:00`);
  if (toks.length % 2) errs.push(`times come in start/end pairs — "${toks[toks.length - 1]}" has no end time`);
  for (let i = 0; i + 1 < toks.length; i += 2) {
    const a = clockMin(toks[i]), b = clockMin(toks[i + 1]);
    const bad = a === null ? toks[i] : b === null ? toks[i + 1] : null;
    if (bad !== null) { errs.push(`"${bad}" is not a time of day — write hh:mm, e.g. 06:00`); continue; }
    const from = a % 1440, to = b;                  // 24:00 only makes sense as an end
    if (from === to % 1440 && to !== 1440) { errs.push(`${toks[i]} ${toks[i + 1]} starts and ends at the same time`); continue; }
    windows.push({ from, to, text: `${hhmm(from)}-${hhmm(to)}` });
  }
  return { windows, errors: errs };
}

// ------------------------------------------------------------ switch parsing
const kv = (s) => { const i = s.indexOf(':'); return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)]; };

function parseSwitches(args, errs, known) {
  const sw = {};
  for (const tok of args) {
    if (!String(tok).startsWith('/')) { errs.push(`expected /switch:value, got "${tok}"`); continue; }
    const [k, v] = kv(String(tok).slice(1));
    const key = k.toLowerCase();
    if (known && !known.has(key)) errs.push(`unknown switch "/${k}"`);
    sw[key] = v === null ? 1 : v;
  }
  return sw;
}

// The goals number grammar (goals.js NUM): 5000, 5k, 1.5m, 1b. goals.js loads
// this module, so it cannot be required from here; this is the same grammar.
const NUM = (s) => {
  const m = String(s).trim().match(/^([\d.]+)\s*([kmbd])?$/i);
  if (!m) return null;
  const v = parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9, d: 1e9 }[(m[2] || '').toLowerCase()] || 1);
  if (!isFinite(v)) return null;
  return Number.isInteger(v) ? v : (v >= 1 ? Math.round(v * 1000) / 1000 : v);
};

// Switch values arrive as the raw text after the colon. Numbers are read with
// the goals grammar, so a k/m suffix means what it says: before this,
// /keepres:100k hid no resources at all and /junk:5k turned the junk filter
// inside out. Anything unreadable is an error and the default stands.
function numSwitch(sw, key, errs, def, { min = null, max = null, what = 'a number, e.g. 5000, 5k or 1.5m' } = {}) {
  if (sw[key] === undefined) return def;
  const v = NUM(sw[key]);
  if (v === null || (min !== null && v < min) || (max !== null && v > max)) {
    errs.push(`/${key} needs ${what} — got "${sw[key]}"`);
    return def;
  }
  return v;
}
// 0 or 1 (a bare /switch means 1).
function flagSwitch(sw, key, errs, def) {
  if (sw[key] === undefined) return def;
  const v = NUM(sw[key]);
  if (v !== 0 && v !== 1) { errs.push(`/${key} is 0 or 1 — got "${sw[key]}"`); return def; }
  return v === 1;
}
// Durations keep their own grammar (a bare number is `unit`; 30s, 2min, 1h).
function durationSwitch(sw, key, errs, unit, def) {
  if (sw[key] === undefined) return def;
  const v = sw[key];
  if (typeof v !== 'number' && !DURATION.test(String(v).trim())) {
    errs.push(`/${key} needs a duration (${unit === 'sec' ? 'seconds' : 'minutes'}, or with a unit: 30s, 5min, 1h) — got "${v}"`);
    return def;
  }
  return durationMs(v, unit);
}

// "a:50000,s:10" -> {archer: 50000, scouter: 10}. Troop words from the table
// every goal shares (constants.js TROOP_WORDS); amounts in the goals grammar,
// so a:20k keeps 20,000 (parseInt used to make that 20).
function parseTroopSpec(s, errs, label) {
  const out = {};
  for (const part of String(s).split(',')) {
    const p = part.trim();
    if (!p) continue;
    const [code, amt] = kv(p);
    const t = C.troopByWord(code);
    if (!t) { errs.push(`${label}: unknown troop code "${code}"`); continue; }
    const q = amt === null ? null : NUM(amt);
    if (q === null) { errs.push(`${label}: bad amount "${amt}" for ${code}`); continue; }
    out[t.key] = q;
  }
  return out;
}

// ------------------------------------------------------------------ incoming
// engine.js hands each inbound army over with its per-type TroopStrBean kept
// under `troop` (so a scout bomb can be told from a regular wave) and its total
// under `troops` (null when unscouted). We read whichever shape is present: a
// raw ArmyBean (troop / troops as an object), or a bare total. `known` says
// whether the total can be trusted.
function normalizeArmy(a, nowMs) {
  const raw = (a && (a.troop || a.troops)) || null;
  let byType = null, total = null, known = false;

  if (raw && typeof raw === 'object') {
    byType = {};
    let sum = 0, anyUnknown = false, anyKnown = false;
    for (const k of TROOP_KEYS) {
      const c = count(raw[k]);
      if (c === null) { if (raw[k] !== undefined) anyUnknown = true; byType[k] = null; continue; }
      byType[k] = c; sum += c; anyKnown = true;
    }
    total = anyKnown ? sum : null;
    known = anyKnown && !anyUnknown;
  } else {
    const c = count(raw);
    if (c !== null) { total = c; known = true; }
  }

  // reachTime is server-epoch ms (verified). The other two branches are
  // defensive only — they have NOT been seen on the wire.
  const rt = n(a && a.reachTime);
  let msUntil = null;
  if (rt > 1e12) msUntil = rt - nowMs;              // epoch ms  <- the real case
  else if (rt > 1e9) msUntil = rt * 1000 - nowMs;   // epoch seconds
  else if (rt > 0) msUntil = rt;                    // already a remaining value

  return {
    raw: a,
    armyId: a && a.armyId,
    missionType: a && a.missionType,
    from: (a && (a.from || a.startPosName)) || '?',
    king: (a && a.king) || null,
    alliance: (a && a.alliance) || null,
    hero: (a && a.hero) || null,
    reachTime: rt || null,
    msUntil,
    byType, total, known,
  };
}

// A scout bomb is a wave that is essentially all scouts. Without a breakdown we
// cannot tell, so the kind is 'unknown' and GatePolicy treats it as regular.
function classify(army, opts) {
  const ratio = n(opts.scoutratio) || 0.9;
  if (!army.byType || army.total === null || !army.total) {
    return { ...army, kind: army.total ? 'regular' : 'unknown', scouts: null, scoutRatio: null };
  }
  const scouts = army.byType.scouter;
  if (scouts === null) return { ...army, kind: 'regular', scouts: null, scoutRatio: null };
  const r = scouts / army.total;
  return { ...army, scouts, scoutRatio: r, kind: r >= ratio ? 'scoutbomb' : 'regular' };
}

// The junk line every defensive goal shares unless it sets its own /junk:
// defensepolicy's /junktroop, which the wiki says keeps a junk attack from
// triggering "the attack warning, gatepolicy, hiding, defensepolicy, or other
// defensive measures" (DefensePolicy). NEAT's default is 1000.
function defaultJunk(ctx) {
  const dp = (ctx.goals || []).find((x) => x.name === 'defensepolicy');
  const v = dp && dp.switches ? dp.switches.junktroop : undefined;
  const j = v === undefined || v === null || v === true ? NaN : Number(v);
  return Number.isFinite(j) && j >= 0 ? j : 1000;
}

// Every plan starts here: the inbound armies worth reacting to, soonest first.
function threatsOf(ctx, opts = {}) {
  const game = ctx.game;
  const nowMs = game && game.now ? game.now() : Date.now();
  // /junk:0 means "react to everything" and must not fall back to the default
  const junk = opts.junk === null || opts.junk === undefined ? defaultJunk(ctx) : n(opts.junk);
  const list = (ctx.incoming || [])
    .map((a) => classify(normalizeArmy(a, nowMs), opts))
    .filter((a) => a.msUntil === null || a.msUntil > -60000);   // drop stale entries
  const real = list.filter((a) => a.total === null || a.total >= junk);
  real.sort((a, b) => (a.msUntil ?? Infinity) - (b.msUntil ?? Infinity));
  return { now: nowMs, all: list, real, junk: list.length - real.length };
}

// The moments (server-epoch ms) at which this city's hiding and gate goals
// next have something to decide. The engine otherwise asks them once a minute,
// and NEAT's own examples lead by 30 s (hiding:0.5) and 6 s (gate:0.1), so it
// runs one extra war-only pass at each of these (Engine.nextWakeAt).
//   hiding  each wave's reachTime - lead (launch); once troops are out, the
//           moment the last wave plus /margin has passed (the early recall)
//   gate    each wave's reachTime - lead (it enters the window), a few seconds
//           after its reachTime (it has left it), and the end of a /mintoggle
//           hold after a flip
// Past moments are returned too: the engine keeps the ones it has not looked
// at since. A wave with no known arrival time is left to the regular tick.
//
// Never right at impact: our idea of the server clock can be a few hundred ms
// out, and a gate flipped a moment early lets the wave meet the other setting.
// The army list push that follows the battle usually brings the look sooner
// anyway (Engine.noteHostile), and that one comes from the server.
const GATE_SETTLE_MS = 3000;
function warMoments(ctx, state) {
  const out = [];
  const st = (state && state.war) || {};
  const hiding = parsers.hiding.parse(ctx.config && ctx.config.hiding);
  if (hiding.enabled) {
    const opt = hidingOptions(ctx);
    const t = threatsOf(ctx, { junk: opt.junk });
    const lands = t.real.filter((a) => a.msUntil !== null).map((a) => t.now + a.msUntil);
    if (st.hide) {
      if (opt.recall) out.push(Math.max(n(st.hide.forImpactAt), ...lands) + opt.marginMs);
    } else {
      for (const at of lands) out.push(at - hiding.leadMs);
    }
  }
  // A manual Open or Closed on the console is held by the regular tick.
  const manual = ctx.controls && (ctx.controls.gate === 'open' || ctx.controls.gate === 'closed');
  const gate = parsers.gate.parse(ctx.config && ctx.config.gate);
  if (gate.enabled && !manual) {
    const pol = (ctx.goals || []).find((x) => x.name === 'gatepolicy');
    const sw = (pol && pol.switches) || {};
    const t = threatsOf(ctx, { junk: sw.junk, scoutratio: sw.scoutratio });
    for (const a of t.real) {
      if (a.msUntil !== null) out.push(t.now + a.msUntil - gate.leadMs, t.now + a.msUntil + GATE_SETTLE_MS);
    }
    const gs = st.gate || {};
    // the same hold gatePlan applies (10 s unless /mintoggle says otherwise)
    if (gs.lastAt) out.push(n(gs.lastAt) + (sw.mintoggle !== undefined ? durationMs(sw.mintoggle, 'sec') : 10000));
  }
  return out.filter((x) => Number.isFinite(x));
}

const hhmmss = (ms) => {
  if (ms === null || ms === undefined) return '?';
  const s = Math.max(0, Math.round(ms / 1000));
  const p = (x) => String(x).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`
                   : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
};

const warState = (state) => (state.war = state.war || {});

// ============================================================================
//                                   PARSERS
// ============================================================================
// kind:'config'  -> parse(value)  where value is the string/number that goals.js
//                   stored under ctx.config[name] for `config name:value`.
// kind:'policy'  -> parse(args)   where args are the tokens after the goal name.
const parsers = {
  // ------------------------------------------------- config hiding:<minutes>
  hiding: {
    kind: 'config', multi: false,
    parse(value) {
      const errs = [];
      const ms = durationMs(value);
      if (value !== undefined && value !== null && value !== '' && ms === 0 && String(value) !== '0') {
        errs.push(`hiding: cannot read "${value}" as a duration (use minutes, or "30s")`);
      }
      if (ms > 60 * 60000) errs.push(`hiding: ${value} is over an hour of lead time — that is almost certainly a typo`);
      return { leadMs: ms, enabled: ms > 0, errors: errs };
    },
  },

  // ---------------------------------------------------- config gate:<minutes>
  gate: {
    kind: 'config', multi: false,
    parse(value) {
      const errs = [];
      const ms = durationMs(value);
      if (value !== undefined && value !== null && value !== '' && ms === 0 && String(value) !== '0') {
        errs.push(`gate: cannot read "${value}" as a duration (use minutes, or "6s")`);
      }
      return { leadMs: ms, enabled: ms > 0, errors: errs };
    },
  },

  // ------------------------------------------------- config warrules:<minutes>
  warrules: {
    kind: 'config', multi: false,
    parse(value) {
      const errs = [];
      const ms = durationMs(value);
      if (value !== undefined && value !== null && value !== '' && ms === 0 && String(value) !== '0') {
        errs.push(`warrules: cannot read "${value}" as a duration (minutes)`);
      }
      // wiki: updates every X minutes on change, a reminder every X*5 otherwise
      return { everyMs: ms, reminderMs: ms * 5, enabled: ms > 0, errors: errs };
    },
  },

  // -------------------------------------------------- config wartown:<0|1|2>
  // wiki WarTown. A value that is not 0, 1 or 2 is reported; a larger number
  // still reads as 2 (the strictest lockdown), anything unreadable as off.
  wartown: {
    kind: 'config', multi: false,
    parse(value) {
      const errs = [];
      const s = value === undefined || value === null ? '' : String(value).trim();
      const v = /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
      if (!/^[012]$/.test(s)) {
        errs.push(`wartown must be 0 (off), 1 (on, traininghero may move) or 2 (on, traininghero stays), got "${value}"`);
      }
      const mode = Number.isFinite(v) ? clamp(Math.round(v) || (v > 0 ? 1 : 0), 0, 2) : 0;
      return { mode, enabled: mode > 0, heroMayMove: mode === 1, errors: errs };
    },
  },

  // ------------------------------------------ wartownpolicy <start> <end> ...
  // wiki WarTownPolicy: the War Town lockdown holds only between each start
  // and end time, and the city plays normally the rest of the day. It has no
  // effect unless config wartown:1 or 2 is on. Times are hh:mm on this
  // machine's clock, as `@:` times in scripts are; a window may run past
  // midnight (wartownpolicy 22:00 02:00).
  wartownpolicy: {
    kind: 'policy', multi: false,
    parse(args) { return parseWindows(args, 'wartownpolicy'); },
  },

  // --------------------------------------------------------- config monitorarmy
  // Kept only so the line does not error. Per the NEAT wiki this goal has never
  // done anything on NEAT or YAEB; it is accepted and ignored.
  monitorarmy: {
    kind: 'config', multi: false,
    parse() { return { noop: true, errors: [] }; },
  },

  // ------------------------------------------------ config keepatthome:<0|1>
  // wiki KeepAttHome (default 0): on/off. On keeps the city's best attack hero
  // home for defence instead of sending it farming — the traininghero never
  // counts, and while config training is on it keeps the SECOND best (the best
  // is out training). It never marches anything; it only stops other goals
  // from marching that hero (see keepAttHome below). A larger number is
  // reported and read as on: there is one hero to keep, not a count.
  keepatthome: {
    kind: 'config', multi: false,
    parse(value) {
      const errs = [];
      const s = value === undefined || value === null ? '' : String(value).trim();
      let on = false;
      if (s === '1') on = true;
      else if (/^\d+$/.test(s) && Number(s) > 1) {
        on = true;
        errs.push(`keepatthome is on/off (0 or 1) — it keeps the one best attack hero home; "${value}" is read as 1`);
      } else if (s !== '' && s !== '0') errs.push(`keepatthome: expected 0 or 1, got "${value}"`);
      return { on, keep: on ? 1 : 0, enabled: on, errors: errs };
    },
  },

  // --------------------------------------------- config attackgap:<seconds>
  // wiki AttackGap (default 6): incoming waves that land at least this many
  // seconds after the wave before are a separate attack, each evaded on its
  // own; closer waves are one attack, evaded together once. Bare numbers are
  // seconds; "1min" works too.
  attackgap: {
    kind: 'config', multi: false,
    parse(value) {
      const errs = [];
      const set = value !== undefined && value !== null && value !== '';
      let ms = set ? durationMs(value, 'sec') : ATTACK_GAP_DEFAULT_MS;
      if (set && ms === 0 && String(value) !== '0') {
        errs.push(`attackgap: cannot read "${value}" as seconds — using the default ${ATTACK_GAP_DEFAULT_MS / 1000}`);
        ms = ATTACK_GAP_DEFAULT_MS;
      }
      return { gapMs: ms, isDefault: !set, errors: errs };
    },
  },

  // ---------------------------------------- config defensecooldown:<minutes>
  // wiki DefenseCooldown (default 30): how long after an attack lands on the
  // city, or is recalled, the city still counts as under attack. Junk attacks
  // never start it. Bare numbers are minutes; "90s" works too. (It no longer
  // paces the gate: gatepolicy /mintoggle does that.)
  defensecooldown: {
    kind: 'config', multi: false,
    parse(value) {
      const errs = [];
      const set = value !== undefined && value !== null && value !== '';
      let ms = set ? durationMs(value, 'min') : DEFENSE_COOLDOWN_DEFAULT_MS;
      if (set && ms === 0 && String(value) !== '0') {
        errs.push(`defensecooldown: cannot read "${value}" as minutes — using the default ${DEFENSE_COOLDOWN_DEFAULT_MS / 60000}`);
        ms = DEFENSE_COOLDOWN_DEFAULT_MS;
      }
      return { cooldownMs: ms, isDefault: !set, errors: errs };
    },
  },

  // ------------------------------------------------- config embassy:<0|1|2>
  // wiki Embassy (default 1): 1 keeps the embassy's "allow alliance troops"
  // box always open, 0 always closed, 2 open only while the city is under
  // attack and for config defensecooldown after (underAttack below). Anything
  // else, an empty value included, is an error, and the box is then left as
  // it is (embassyPlan says why the default is not applied either).
  embassy: {
    kind: 'config', multi: false,
    parse(value) {
      const errs = [];
      const s = value === undefined || value === null ? '' : String(value).trim();
      const ok = /^[012]$/.test(s);
      if (!ok) errs.push(`embassy must be 0 (always closed), 1 (always open) or 2 (open while under attack), got "${s}"`);
      return { mode: ok ? Number(s) : null, errors: errs };
    },
  },

  // ------------------------------------------------ config nohealing:<0|1>
  // wiki NoHealing (default 0): 1 means never heal wounded troops, i.e. never
  // send army.cureInjuredTroop (ArmyCommands.as:174). goal-upkeep.js heals
  // the medic camp unless this says 1 (healingAllowed below).
  nohealing: {
    kind: 'config', multi: false,
    parse(value) {
      const errs = [];
      const v = parseInt(value, 10);
      if (value !== undefined && value !== null && value !== '' && (v !== 0 && v !== 1)) {
        errs.push(`nohealing: expected 0 or 1, got "${value}"`);
      }
      return { on: v === 1, errors: errs };
    },
  },

  // ------- gatepolicy <noattack> <regular> <scoutbomb> <mixed> <maintenance>
  gatepolicy: {
    kind: 'policy', multi: false,
    parse(args) {
      const errs = [];
      const positional = args.filter((a) => !String(a).startsWith('/'));
      const switches = parseSwitches(args.filter((a) => String(a).startsWith('/')), errs, new Set([
        'junk', 'scoutratio', 'strongarchers', 'weakarchers', 'loyaltyattack', 'defenceratio', 'defenseratio', 'mintoggle',
      ]));
      // Numbers go to the plan as numbers (5k = 5000). One it cannot read is
      // an error and is dropped, so the plan's default applies rather than NaN.
      const ratio = { what: 'a multiple of the wave, e.g. 5' };
      const numeric = {
        junk: {}, strongarchers: {}, weakarchers: {}, loyaltyattack: {}, defenceratio: ratio, defenseratio: ratio,
        scoutratio: { max: 1, what: 'the share of the wave that is scouts, 0 to 1, e.g. 0.9' },
      };
      for (const [key, opt] of Object.entries(numeric)) {
        if (switches[key] === undefined) continue;
        const v = numSwitch(switches, key, errs, undefined, opt);
        if (v === undefined) delete switches[key]; else switches[key] = v;
      }
      // /mintoggle stays a duration (seconds, or 30s / 2min) for the plan to read
      if (switches.mintoggle !== undefined && durationSwitch(switches, 'mintoggle', errs, 'sec', null) === null) {
        delete switches.mintoggle;
      }
      if (positional.length !== 5) {
        errs.push('expected: gatepolicy <noattack> <regular> <scoutbomb> <mixed> <maintenance>  (five values, each 0=bot 1=open 2=close)');
      }
      const names = ['noattack', 'regular', 'scoutbomb', 'mixed', 'maintenance'];
      const rules = {};
      names.forEach((name, i) => {
        const v = parseInt(positional[i], 10);
        if (positional[i] !== undefined && (!Number.isInteger(v) || v < 0 || v > 2)) {
          errs.push(`${name}: expected 0 (bot's choice), 1 (open gate) or 2 (close gate), got "${positional[i]}"`);
        }
        rules[name] = Number.isInteger(v) && v >= 0 && v <= 2 ? v : 0;
      });
      return { rules, switches, errors: errs };
    },
  },

  // ---------------------------------------------------------- hidingpolicy
  // Our addition. NEAT infers all of this; spelling it out means the bot never
  // has to guess where an unattended account's whole army is being sent.
  hidingpolicy: {
    kind: 'policy', multi: false,
    parse(args) {
      const errs = [];
      const known = new Set(['target', 'mission', 'keep', 'keepres', 'resources', 'gold',
        'needhero', 'junk', 'maxrest', 'margin', 'minlead', 'horizon', 'maxmarches', 'recall', 'foodshare']);
      const sw = parseSwitches(args, errs, known);

      let target = null;
      if (sw.target !== undefined) {
        const m = String(sw.target).match(/^(\d+)\s*,\s*(\d+)$/);
        if (!m) errs.push(`/target must be written x,y — got "${sw.target}"`);
        else target = { x: +m[1], y: +m[2] };
      }

      let missionType = C.MISSION.transport;
      if (sw.mission !== undefined) {
        const key = String(sw.mission).toLowerCase();
        if (C.MISSION[key] === undefined) errs.push(`/mission must be one of ${Object.keys(C.MISSION).join(', ')} — got "${sw.mission}"`);
        else missionType = C.MISSION[key];
      }

      const keep = sw.keep !== undefined ? parseTroopSpec(sw.keep, errs, '/keep') : {};
      const maxRestMs = durationSwitch(sw, 'maxrest', errs, 'min', 8 * 3600000);
      // NewArmyWin.as:1707 clamps the encamp input at 24h, so never ask for more.
      if (maxRestMs > 24 * 3600000) errs.push('/maxrest is capped at 24h by the game client');

      return {
        target,
        missionType,
        keep,
        keepRes: numSwitch(sw, 'keepres', errs, 0),
        sendResources: flagSwitch(sw, 'resources', errs, true),
        sendGold: flagSwitch(sw, 'gold', errs, false),          // off by default: gold is wanted at home
        needHero: flagSwitch(sw, 'needhero', errs, true),
        junk: numSwitch(sw, 'junk', errs, null),
        maxRestMs: clamp(maxRestMs, 0, 24 * 3600000),
        marginMs: durationSwitch(sw, 'margin', errs, 'min', 5 * 60000),
        minLeadMs: durationSwitch(sw, 'minlead', errs, 'sec', 4000),
        horizonMs: durationSwitch(sw, 'horizon', errs, 'min', 60 * 60000),
        maxMarches: numSwitch(sw, 'maxmarches', errs, 0, { what: 'a whole number of marches' }),   // 0 = do not check
        recall: flagSwitch(sw, 'recall', errs, true),
        foodShare: numSwitch(sw, 'foodshare', errs, 0.9, { min: 0.05, max: 1, what: 'a fraction between 0.05 and 1' }),
        errors: errs,
      };
    },
  },
};

// Config keys this module owns. goals.js's CONFIG_KEYS must learn about these
// or every one of these lines reports "unknown config key" (the value is still
// stored, so the goal works — it just shouts about it).
// (goals.js already lists warrules, wartown, keepatthome and attackgap.)
const configKeys = ['hiding', 'gate', 'warrules', 'wartown', 'monitorarmy',
                    'keepatthome', 'attackgap', 'defensecooldown', 'nohealing', 'embassy'];

// Defaults for a hidingpolicy that was never written.
function hidingOptions(ctx) {
  const g = (ctx.goals || []).find((x) => x.name === 'hidingpolicy');
  if (g) return g;
  return parsers.hidingpolicy.parse([]);
}

// ============================================================================
//                                    PLANS
// ============================================================================

// ------------------------------------------------------------------- hiding
// config hiding:<minutes>
//
// Send the garrison (and, on a transport, the loose resources) out of the city
// so the incoming wave lands on an empty town, then bring it home once the wave
// has passed. This is the single thing that keeps an unattended account alive.
//
// Timing: the army leaves the instant army.newArmy is accepted, so the launch
// only has to beat impact. What has to be engineered is the RETURN — the march
// must still be away when the wave lands. restTime (seconds the army encamps at
// the target) is the lever: pick it so the round trip ends after the last wave
// in the horizon, plus a margin.
function hidingPlan(ctx, state, game) {
  game = game || ctx.game;
  const opt = hidingOptions(ctx);
  const lead = parsers.hiding.parse(ctx.config.hiding).leadMs;
  const st = warState(state);

  const t = threatsOf(ctx, { junk: opt.junk, scoutratio: 0.9 });
  const out = st.hide || null;

  // ---- nothing enabled: still report a dangling hide march so it is visible
  if (!lead) {
    if (!out) return null;
    return { note: 'hiding: disabled (config hiding:0) but a hide march is still recorded as out', actions: [] };
  }

  // ---- the wave has passed: bring them home
  if (out) {
    const stillThreatened = t.real.some((a) => a.msUntil === null || a.msUntil > -opt.marginMs);
    const pastImpact = t.now > n(out.forImpactAt) + opt.marginMs;
    if (t.now > n(out.expectedReturnAt) + 60000) {
      delete st.hide;
      return { note: 'hiding: hide march should be home by now — clearing', actions: [] };
    }
    if (!stillThreatened && pastImpact && opt.recall) {
      const armyId = resolveHideArmyId(ctx, out);
      if (armyId === null) {
        return {
          note: `hiding: wave passed, army due home ${hhmmss(n(out.expectedReturnAt) - t.now)} from now` +
                ' (cannot recall early — no armyId; needs server.SelfArmysUpdate)',
          actions: [],
        };
      }
      return {
        note: 'hiding: wave passed — recalling the hide march',
        actions: [{ kind: 'recallArmy', armyId, label: `recall hide march (army ${armyId})` }],
      };
    }
    return {
      note: `hiding: troops are out, impact ${hhmmss(n(out.forImpactAt) - t.now)} away, home in ${hhmmss(n(out.expectedReturnAt) - t.now)}`,
      actions: [],
    };
  }

  // ---- nothing inbound
  if (!t.real.length) {
    return { note: `hiding: armed, nothing inbound${t.junk ? ` (${t.junk} junk ignored)` : ''}`, actions: [] };
  }

  const first = t.real[0];
  if (first.msUntil === null) {
    return { note: 'hiding: an attack is inbound but its arrival time is unknown — not launching blind', actions: [] };
  }
  if (first.msUntil > lead) {
    return { note: `hiding: ${t.real.length} wave(s) inbound, first lands in ${hhmmss(first.msUntil)} — launching at T-${hhmmss(lead)}`, actions: [] };
  }
  if (first.msUntil < opt.minLeadMs) {
    return { note: `hiding: too late — impact in ${hhmmss(first.msUntil)}, under the ${hhmmss(opt.minLeadMs)} minimum`, actions: [] };
  }

  const built = buildHideMarch(ctx, opt, t, game);
  if (built.error) return { note: `hiding: ${built.error}`, actions: [] };
  return { note: built.note, actions: [built.action] };
}

// Match our recorded hide march back to a live armyId. army.newArmy does not
// return one (CommandResponse has no armyId field), so either we captured it
// from a later server.SelfArmysUpdate or we cannot recall early.
function resolveHideArmyId(ctx, out) {
  if (out.armyId) return out.armyId;
  const mine = ctx.selfArmies || [];
  const hit = mine.find((a) => n(a.targetFieldId) === n(out.targetFieldId) && n(a.missionType) === n(out.missionType));
  return hit ? hit.armyId : null;
}

// Pure: works out where to go, what to load, and how long to encamp.
function buildHideMarch(ctx, opt, t, game) {
  const castle = ctx.castle;
  const here = game.castleXY(castle);
  if (!here) return { error: 'this city has no map position, cannot compute a march' };

  // -- rally spots -------------------------------------------------------
  if (opt.maxMarches && ctx.selfArmies && ctx.selfArmies.length >= opt.maxMarches) {
    return { error: `all ${opt.maxMarches} march slot(s) are in use — recall something or raise /maxmarches` };
  }

  // -- hero --------------------------------------------------------------
  // HeroConstants.as: 0 FREE, 1 CHIEF (mayor), 2 GUARD, 3 SEND, 4 SEIZED,
  // 5 BACK, 8 FARM. The wiki is explicit that hiding never demotes the mayor
  // to free a hero up, so only a FREE hero may lead the march. Which one:
  // see hideHero (keepatthome's defender and the traininghero go last).
  const heroes = castle.heros || [];
  const pick = hideHero(ctx, heroes);
  const hero = pick.hero;
  if (!hero && opt.needHero) {
    const mayor = heroes.find((h) => Number(h.status) === HERO.CHIEF);
    return { error: 'no idle hero to lead the hide march' + (mayor ? ` (${mayor.name} is mayor and will not be demoted for this)` : '') +
                    ' — use KeepAttHome, or /needhero:0 to march without one' };
  }

  // -- target ------------------------------------------------------------
  const target = pickHideTarget(ctx, opt, game, here);
  if (target.error) return { error: target.error };

  // -- troops ------------------------------------------------------------
  const have = castle.troop || {};
  const troops = {};
  let moving = 0;
  for (const key of TROOP_KEYS) {
    const send = Math.max(0, count(have[key]) - n(opt.keep[key]));
    if (send > 0) { troops[key] = send; moving += send; }
  }
  if (!moving) return { error: 'no troops left to hide once /keep is honoured' };

  // -- timing ------------------------------------------------------------
  // Only waves inside the horizon count; one far-future march must not force a
  // multi-hour encampment.
  const inHorizon = t.real.filter((a) => a.msUntil !== null && a.msUntil <= opt.horizonMs);
  const lastImpactIn = inHorizon.length ? Math.max(...inHorizon.map((a) => a.msUntil)) : t.real[0].msUntil;

  const oneWayMs = C.marchTimeMs(here, target.xy, Object.keys(troops), game.marchSkillParam ?? 100);
  if (oneWayMs === null) return { error: 'cannot compute march time for this troop mix' };
  const roundTripMs = 2 * oneWayMs;

  // Be away until the last wave has landed, plus the margin.
  let restSec = Math.ceil(Math.max(0, (lastImpactIn + opt.marginMs - roundTripMs)) / 1000);
  restSec = clamp(restSec, 0, Math.floor(opt.maxRestMs / 1000));

  // -- food --------------------------------------------------------------
  // NewArmyWin.as:2852, 3102 + 1717 (C.marchFood, shared with npc farming):
  //   foodPerHour  = sum of foodRequest * 2 * count      (twice the upkeep)
  //   portableFood = foodPerHour * oneWayHours
  //   needFood     = portableFood + foodPerHour * restHours
  // and the client refuses to send when needFood > the city's food. The food
  // also rides in the army's carry capacity, so it eats into what we can hide.
  // Counting it once planned camps the city could not feed.
  const foodPerHour = C.marchFoodPerHour(troops);
  const loads = Object.entries(troops).reduce((s, [k, v]) => s + v * C.BY_KEY[k].load, 0);
  const res = castle.resource || {};
  const foodHave = n(res.food && res.food.amount);
  const foodBudget = Math.floor(foodHave * opt.foodShare);

  const oneWayHours = oneWayMs / 3600000;
  const foodFor = (sec) => Math.ceil(C.marchFood(troops, oneWayMs, sec * 1000));

  let clampedByFood = false;
  if (foodFor(restSec) > foodBudget) {
    const affordable = Math.floor(((foodBudget / Math.max(1, foodPerHour)) - oneWayHours) * 3600);
    restSec = Math.max(0, affordable);
    clampedByFood = true;
  }
  const needFood = foodFor(restSec);
  if (needFood > foodBudget) {
    return { error: `not enough food to march ${fmt(moving)} troops (needs ${fmt(needFood)}, budget ${fmt(foodBudget)} of ${fmt(foodHave)})` };
  }

  // -- resources ---------------------------------------------------------
  // Only a transport actually banks them; on any other mission they just ride
  // along and come back, which is still better than being plundered.
  const resources = {};
  let carried = 0;
  const space = Math.max(0, loads - needFood);
  if (opt.sendResources && space > 0) {
    const pool = opt.sendGold ? [...RES_KEYS, 'gold'] : RES_KEYS;
    const excess = {};
    let totalExcess = 0;
    for (const r of pool) {
      const amount = r === 'gold' ? n(res.gold) : n(res[r] && res[r].amount);
      // food already committed to upkeep is not ours to move
      const usable = r === 'food' ? Math.max(0, amount - needFood) : amount;
      const e = Math.max(0, usable - opt.keepRes);
      excess[r] = e; totalExcess += e;
    }
    if (totalExcess > 0) {
      // Plunder takes a slice of everything, so hide proportionally rather than
      // emptying one store and leaving the rest.
      const scale = Math.min(1, space / totalExcess);
      for (const r of pool) {
        const take = Math.floor(excess[r] * scale);
        if (take > 0) { resources[r] = take; carried += take; }
      }
    }
  }

  // -- bean --------------------------------------------------------------
  const targetPoint = C.coordsToFieldId(target.xy.x, target.xy.y);
  const bean = game.buildArmyBean({
    missionType: opt.missionType,
    heroId: hero ? hero.id : undefined,
    targetPoint,
    troops,
    resources,
    restTimeSec: restSec,
  });

  const returnAt = t.now + roundTripMs + restSec * 1000;
  const impactAt = t.now + lastImpactIn;
  const safe = returnAt > impactAt;

  const bits = [
    `${fmt(moving)} troop(s)`,
    carried ? `${fmt(carried)} resources` : 'no resources',
    `to ${target.label} (${target.xy.x},${target.xy.y})`,
    `encamp ${hhmmss(restSec * 1000)}`,
    `home in ${hhmmss(roundTripMs + restSec * 1000)}`,
  ];
  const warn = [];
  if (!safe) warn.push('WARNING: the round trip is shorter than the wait — the army lands back before impact');
  if (clampedByFood) warn.push(`encamp time cut to fit ${fmt(foodBudget)} food`);
  if (!hero) warn.push('no hero aboard');
  else if (pick.why) warn.push(`led by ${hero.name}, ${pick.why}`);

  return {
    note: `hiding: launching — ${bits.join(', ')}${warn.length ? ' [' + warn.join('; ') + ']' : ''}`,
    action: {
      kind: 'hideTroops',
      bean, targetPoint, targetXY: target.xy, missionType: opt.missionType,
      troops, resources, restSec, heroId: hero ? hero.id : null,
      forImpactAt: impactAt, expectedReturnAt: returnAt, safe,
      label: `hide ${fmt(moving)} troops at ${target.label}, back in ${hhmmss(roundTripMs + restSec * 1000)}`,
    },
  };
}

// Where to run to. An explicit /target always wins; otherwise the nearest city
// of our own that is not itself under attack, which on a transport means the
// hidden resources are actually banked rather than just taken for a walk.
function pickHideTarget(ctx, opt, game, here) {
  if (opt.target) return { xy: opt.target, label: 'the configured target' };

  const mine = (game.castles || []).filter((c) => game.castleId(c) !== game.castleId(ctx.castle));
  const scored = mine
    .map((c) => ({ c, xy: game.castleXY(c) }))
    .filter((x) => x.xy)
    .map((x) => ({ ...x, d: Math.hypot(x.xy.x - here.x, x.xy.y - here.y), threatened: n((ctx.incomingByCastle || {})[game.castleId(x.c)] || 0) > 0 }))
    .sort((a, b) => (a.threatened - b.threatened) || (a.d - b.d));

  if (!scored.length) {
    return { error: 'nowhere to hide — this is the only city, so set a destination with `hidingpolicy /target:x,y` (a flat or valley you own)' };
  }
  return { xy: scored[0].xy, label: scored[0].c.name || 'your other city' };
}

// --------------------------------------------------------------------- gate
// config gate:<minutes>  +  gatepolicy <na> <reg> <sb> <mix> <mnt>
//
// goOutForBattle === true means the garrison sallies out — GATE OPEN.
// Policy values: 0 = bot's choice, 1 = always open, 2 = always close.
function gatePlan(ctx, state, game) {
  game = game || ctx.game;

  // Gate Control on the console (Auto / Open / Closed). A manual Open or Closed
  // outranks every gate goal and is held until someone sets it back to Auto:
  // NEAT's semantics, where "Closed" means the gate stays closed. Only the
  // console writes ctx.controls, so a goal file alone never lands here.
  const manual = ctx.controls && ctx.controls.gate;
  if (manual === 'open' || manual === 'closed') {
    const want = manual === 'open';
    const head = `gate: manual ${want ? 'OPEN' : 'CLOSED'} from the console`;
    if (!!ctx.castle.goOutForBattle === want) return { note: `${head} — holding`, actions: [] };
    return {
      note: `${head} — the gate is ${want ? 'closed' : 'open'}, putting it back`,
      actions: [{ kind: 'setGate', open: want, scenario: 'manual', label: `${want ? 'open' : 'close'} the gate (manual setting)` }],
    };
  }

  const cfg = parsers.gate.parse(ctx.config.gate);
  const pol = (ctx.goals || []).find((x) => x.name === 'gatepolicy');
  if (!cfg.enabled) {
    return pol ? { note: 'gatepolicy is set but idle — it needs `config gate:<minutes>` to switch on', actions: [] } : null;
  }

  const sw = (pol && pol.switches) || {};
  const rules = (pol && pol.rules) || { noattack: 0, regular: 0, scoutbomb: 0, mixed: 0, maintenance: 0 };
  const t = threatsOf(ctx, { junk: sw.junk, scoutratio: sw.scoutratio });
  const st = warState(state);
  const gs = (st.gate = st.gate || {});

  // Only waves that land inside the lead window are being reacted to.
  const active = t.real.filter((a) => a.msUntil !== null && a.msUntil > 0 && a.msUntil <= cfg.leadMs);

  let scenario;
  if (ctx.maintenance) scenario = 'maintenance';
  else if (!active.length) scenario = 'noattack';
  else {
    const sb = active.some((a) => a.kind === 'scoutbomb');
    const reg = active.some((a) => a.kind !== 'scoutbomb');
    scenario = sb && reg ? 'mixed' : sb ? 'scoutbomb' : 'regular';
  }

  const rule = rules[scenario];
  const bot = rule === 0 ? gateBotChoice(scenario, ctx, active, sw) : null;
  const want = rule === 1 ? true : rule === 2 ? false : bot.open;
  const why = rule === 1 ? 'policy: always open' : rule === 2 ? 'policy: always close' : `bot's choice: ${bot.why}`;

  const current = ctx.castle.goOutForBattle;
  const head = `gate: ${scenario}${active.length ? ` (${active.length} wave(s), first in ${hhmmss(active[0].msUntil)})` : ''} -> ${want ? 'OPEN' : 'CLOSED'} [${why}]`;

  if (current === want) return { note: `${head} — already ${want ? 'open' : 'closed'}`, actions: [] };

  const minToggle = sw.mintoggle !== undefined ? durationMs(sw.mintoggle, 'sec') : 10000;
  if (t.now - n(gs.lastAt) < minToggle) {
    return { note: `${head} — holding, last toggle was ${hhmmss(t.now - n(gs.lastAt))} ago`, actions: [] };
  }
  // /mintoggle is the only pacing: config defensecooldown is NEAT's
  // under-attack window (underAttack below), not a gate throttle.

  return {
    note: head,
    actions: [{ kind: 'setGate', open: want, scenario, label: `${want ? 'open' : 'close'} the gate (${scenario})` }],
  };
}

// INFERRED, not verified: the wiki describes the behaviour in prose only
// ("300,000 archers ... below 100,000 archers ... small loyalty attacks").
// Anyone who cares about the exact call should set 1 or 2 in gatepolicy.
function gateBotChoice(scenario, ctx, active, sw) {
  const troop = ctx.castle.troop || {};
  const archers = count(troop.archer) || 0;
  const strong = n(sw.strongarchers) || 300000;
  const weak = n(sw.weakarchers) || 100000;
  const loyaltyAttack = n(sw.loyaltyattack) || 5000;
  const ratio = n(sw.defenceratio) || n(sw.defenseratio) || 5;
  const garrison = TROOP_KEYS.reduce((s, k) => s + (count(troop[k]) || 0), 0);
  const incoming = active.reduce((s, a) => s + (a.total || 0), 0);

  switch (scenario) {
    case 'noattack':
      return { open: false, why: 'quiet, keep the garrison behind the walls' };
    case 'scoutbomb':
      return archers >= strong
        ? { open: true, why: `${fmt(archers)} archers >= ${fmt(strong)}, meet the scouts in the field` }
        : { open: false, why: `only ${fmt(archers)} archers, let the walls take the scouts` };
    case 'regular':
      if (incoming && incoming <= loyaltyAttack) {
        return { open: true, why: `small wave (${fmt(incoming)}), sally out so it cannot chip loyalty` };
      }
      if (incoming && garrison >= ratio * incoming) {
        return { open: true, why: `garrison ${fmt(garrison)} is ${ratio}x the wave` };
      }
      if (archers < weak) {
        return { open: false, why: `only ${fmt(archers)} archers (under ${fmt(weak)}), stay inside` };
      }
      return { open: false, why: 'hold behind the walls and the fortifications' };
    case 'mixed':
      return { open: false, why: 'scouts and a real wave together — closing is the safe call' };
    case 'maintenance':
    default:
      return { open: false, why: 'maintenance, default to closed' };
  }
}

// ----------------------------------------------------------------- warrules
// config warrules:<minutes>
// Alliance chat gets a short heads-up on the first non-junk attack, an update
// every X minutes while the picture changes, and a reminder every X*5 when it
// does not. Deliberately vague: alliance chat is not private.
function warRulesPlan(ctx, state, game) {
  game = game || ctx.game;
  const cfg = parsers.warrules.parse(ctx.config.warrules);
  if (!cfg.enabled) return null;

  const t = threatsOf(ctx, {});
  const st = warState(state);
  const cs = (st.chat = st.chat || {});

  if (!t.real.length) {
    if (cs.lastSig) cs.lastSig = null;
    return { note: 'warrules: armed, nothing to report', actions: [] };
  }

  // Signature of the current picture: which waves, how big, landing when. The
  // landing moment is bucketed to a minute of the CLOCK: bucketing the time
  // still to go changed the signature every minute on its own, so a quiet
  // attack posted an "update" every X minutes instead of a reminder every 5X.
  const sig = t.real
    .map((a) => `${a.armyId ?? a.from}:${a.total ?? '?'}:${a.msUntil === null ? '?' : Math.round((t.now + a.msUntil) / 60000)}`)
    .sort().join('|');

  const changed = sig !== cs.lastSig;
  const since = t.now - n(cs.lastAt);
  const due = changed ? since >= cfg.everyMs : since >= cfg.reminderMs;

  if (!cs.lastAt) {
    // first non-junk attack: report immediately, as the wiki describes
  } else if (!due) {
    return {
      note: `warrules: ${t.real.length} wave(s) known, next ${changed ? 'update' : 'reminder'} in ` +
            `${hhmmss((changed ? cfg.everyMs : cfg.reminderMs) - since)}`,
      actions: [],
    };
  }

  const xy = game.castleXY(ctx.castle);
  const where = xy ? `${xy.x},${xy.y}` : '?';
  const first = t.real[0];
  const msg = `[war] ${ctx.castle.name || 'city'} (${where}): ${t.real.length} incoming, ` +
              `first in ${hhmmss(first.msUntil)} from ${first.king || first.from}` +
              (t.junk ? ` (+${t.junk} junk)` : '');

  return {
    note: `warrules: ${changed ? 'picture changed' : 'reminder'} — telling the alliance`,
    actions: [{ kind: 'allianceChat', msg, sig, label: `alliance chat: ${msg}` }],
  };
}

// ------------------------------------------------------------------ wartown
// config wartown:<0|1|2>   (+ wartownpolicy <start> <end> ...)
//
// wiki WarTown: "lock down most troop movements in preparation of war. No npc
// farming runs, KeepResource, SendResource, KeepTroop, or SendTroop goals".
// This plan reports; the holding is done by every goal that marches, which
// all ask lockdown() below:
//   goal-npc       no farming runs from this city
//   goal-buildnpc  stands down: no flat occupied, no city abandoned
//   goal-transfer  this city sends no transfer march; its own requests are
//                  still served by the other cities — supplies coming IN move
//                  nothing out of it, and NEAT holds only the sending goals
//   engine.js      wartown:2 keeps the traininghero here once it has landed,
//                  wartown:1 lets it come and go
// Hiding is not held: an evasion is the one march a city under attack needs.
// The console's War Town Mode counts exactly as the config key does.
//
// NEAT recalls nothing itself (the wiki points at the recallall script). This
// does that recallall once, when war town is switched on: every march still
// heading OUT of this city (ArmyConstants.as direction 1), each recalled once
// with this city's castleId — the city it left from, which army.callBackArmy
// wants (server.js's console recall does the same) — and again only if it is
// still heading out a while later. Marches already coming home are left to
// arrive. Armies camped elsewhere — a reinforcement standing in another city,
// troops holding a valley, an encampment — were put there on purpose and stay:
// recallall is for "troops marching from the city". The hide march, and under
// wartown:1 the traininghero's own move, are not touched. A wartownpolicy
// window opening later recalls nothing: its runs finish and come home, which
// is what the wiki's advice to pair it with SchedulePolicy counts on.
const RECALL_PENDING_MS = 55000;      // proposed, never sent: a dry run, or the slice ran out of actions
const RECALL_RETRY_MS = 2 * 60000;    // sent, and the army is still heading out
const RECALL_MAX_TRIES = 3;

const nowOf = (ctx, game) => { const g = game || (ctx && ctx.game); return g && g.now ? g.now() : Date.now(); };

// The console's War Town Mode for this city, or null on Auto (or no console).
function consoleWarTown(ctx) {
  const v = ctx.controls && ctx.controls.wartown;
  return v === undefined || v === null || v === '' || v === 'auto' ? null : v;
}

// This machine's clock, minutes after midnight.
const minuteOfDay = (at) => { const d = new Date(at); return d.getHours() * 60 + d.getMinutes(); };

// The wartownpolicy window `at` falls in, or null.
function windowAt(windows, at) {
  const m = minuteOfDay(at);
  return windows.find((w) => (w.from < w.to ? m >= w.from && m < w.to : m >= w.from || m < w.to)) || null;
}
// The window that opens next after `at`.
function nextWindow(windows, at) {
  const m = minuteOfDay(at);
  const wait = (w) => (w.from - m + 1440) % 1440;
  return windows.slice().sort((a, b) => wait(a) - wait(b))[0] || null;
}

// The War Town lockdown, as every goal that marches asks about it.
//   on          true while marches out of this city are held
//   mode        the switch: 0 off, 1 on (traininghero may move), 2 on (it stays)
//   heroMayMove false only while the lockdown holds under mode 2
//   window      the wartownpolicy window in force, when there is one
//   why         a few words for a plan note
function lockdown(ctx, at) {
  const fromConsole = consoleWarTown(ctx);
  const raw = fromConsole !== null ? fromConsole : (ctx.config || {}).wartown;
  if (raw === undefined || raw === null) {
    return { on: false, mode: 0, heroMayMove: true, window: null, source: null, errors: [], why: 'war town off' };
  }
  const cfg = parsers.wartown.parse(raw);
  const source = fromConsole !== null ? 'the console' : 'config';
  const base = { mode: cfg.mode, source, errors: cfg.errors, window: null };
  if (!cfg.enabled) return { ...base, on: false, heroMayMove: true, why: 'war town off' };

  const pol = (ctx.goals || []).find((g) => g.name === 'wartownpolicy');
  const windows = (pol && pol.windows) || [];
  if (!windows.length) return { ...base, on: true, heroMayMove: cfg.heroMayMove, why: `war town ${cfg.mode} (${source})` };
  const when = at === undefined ? nowOf(ctx) : at;
  const w = windowAt(windows, when);
  if (!w) {
    const next = nextWindow(windows, when);
    return { ...base, on: false, heroMayMove: true, scheduled: true, next,
      why: `war town ${cfg.mode} (${source}) waits for its wartownpolicy hours, next ${next.text}` };
  }
  return { ...base, on: true, heroMayMove: cfg.heroMayMove, scheduled: true, window: w,
    why: `war town ${cfg.mode} (${source}, wartownpolicy ${w.text})` };
}

// Other modules ask this before moving troops out of a city: the mode while
// the lockdown holds, 0 when it does not.
function isWarTown(ctx, at) {
  const l = lockdown(ctx, at);
  return l.on ? l.mode : 0;
}

const trainingHeroNames = (ctx) => new Set((ctx.goals || [])
  .filter((g) => g.name === 'traininghero' && g.hero).map((g) => String(g.hero).toLowerCase()));

const MISSION_NAME = Object.fromEntries(Object.entries(C.MISSION).map(([k, v]) => [v, k]));

// This city's own marches, sorted for the switch-on recall. ArmyConstants.as:
// direction 1 going out, 2 coming home, 3 camped.
function marchesFrom(ctx, st, heroMayMove) {
  const fid = Number(ctx.castle && ctx.castle.fieldId);
  const out = { recall: [], camped: [], left: [], known: Number.isFinite(fid) };
  if (!out.known) return out;
  const hide = st.hide || null;
  const th = trainingHeroNames(ctx);
  for (const a of ctx.selfArmies || []) {
    const b = a.raw || a;                          // the engine wraps the ArmyBean
    if (Number(b.startFieldId ?? a.startFieldId) !== fid) continue;
    const dir = Number(b.direction ?? a.direction) || 1;
    if (dir === 2) continue;                       // already coming home
    const target = n(b.targetFieldId ?? a.targetFieldId);
    const mission = n(b.missionType ?? a.missionType);
    const xy = target ? C.fieldIdToCoords(target) : null;
    const m = {
      armyId: a.armyId ?? b.armyId, missionType: mission, targetFieldId: target, hero: b.hero || null,
      what: `${MISSION_NAME[mission] || 'march'} to ${b.targetPosName || (xy ? `${xy.x},${xy.y}` : '?')}`,
    };
    if (dir === 3) { out.camped.push(m); continue; }
    const isHide = hide && ((hide.armyId != null && String(hide.armyId) === String(m.armyId))
      || (target === n(hide.targetFieldId) && mission === n(hide.missionType)));
    if (isHide) { out.left.push({ ...m, why: 'the hide march' }); continue; }
    if (heroMayMove && m.hero && th.has(String(m.hero).toLowerCase())) {
      out.left.push({ ...m, why: 'the traininghero on its way (war town 1)' });
      continue;
    }
    out.recall.push(m);
  }
  return out;
}

function warTownPlan(ctx, state, game) {
  game = game || ctx.game;
  const set = consoleWarTown(ctx) !== null || (ctx.config.wartown !== undefined && ctx.config.wartown !== null);
  if (!set) {
    const pol = (ctx.goals || []).find((g) => g.name === 'wartownpolicy');
    return pol ? { note: 'wartownpolicy: idle — it schedules a war town, so it needs config wartown:1 or 2', actions: [], lockdown: false } : null;
  }

  const st = warState(state);
  const ws = (st.wartown = st.wartown || {});
  const now = nowOf(ctx, game);
  const lock = lockdown(ctx, now);
  const errs = lock.errors.length ? ` [${lock.errors.join('; ')}]` : '';
  const head = `wartown ${lock.mode}${lock.source === 'the console' ? ' (console)' : ''}`;

  if (!lock.mode) {
    const lifted = !!ws.on;
    if (lifted) { ws.on = false; ws.liftedAt = now; delete ws.targets; delete ws.recall; }
    return { note: `${lifted ? `${head}: lifted — normal troop movement resumes` : `${head}: off`}${errs}`, actions: [], lockdown: false };
  }

  // Switched on (not a window opening): note what is heading out right now.
  const marches = marchesFrom(ctx, st, lock.heroMayMove);
  if (!ws.on) {
    ws.on = true; ws.since = now; ws.recall = {};
    ws.targets = lock.on ? marches.recall.map((m) => m.armyId).filter((id) => id !== undefined && id !== null) : [];
  }
  if (!lock.on) {
    return { note: `${head}: outside its wartownpolicy hours — normal troop movement until ${hhmm(lock.next.from)}${errs}`,
      actions: [], lockdown: false, heroMayMove: true };
  }

  const bits = [];
  const live = new Map(marches.recall.map((m) => [String(m.armyId), m]));
  // one that has turned round, landed or gone drops off the list for good
  ws.targets = (ws.targets || []).filter((id) => live.has(String(id)));
  const recs = (ws.recall = ws.recall || {});
  for (const id of Object.keys(recs)) if (!ws.targets.some((x) => String(x) === id)) delete recs[id];

  // Each army: recalled once; again only once a sent recall has had
  // RECALL_RETRY_MS to turn it round and it is still heading out; never more
  // than RECALL_MAX_TRIES times. A recall planned but never sent is simply
  // planned again on the next tick.
  const actions = [], waiting = [], stuck = [];
  for (const id of ws.targets) {
    const m = live.get(String(id));
    const rec = recs[id];
    if (rec) {
      const due = rec.sentAt ? now - n(rec.sentAt) >= RECALL_RETRY_MS : now - n(rec.plannedAt) >= RECALL_PENDING_MS;
      if (!due) { waiting.push(m); continue; }
      if (rec.sentAt && n(rec.tries) >= RECALL_MAX_TRIES) { stuck.push({ ...m, error: rec.error }); continue; }
    }
    recs[id] = { ...(rec || {}), plannedAt: now };
    actions.push({
      kind: 'recallArmy', wartown: true, armyId: m.armyId, castleId: game.castleId(ctx.castle),
      label: `wartown: recall ${m.what} (army ${m.armyId})`,
    });
  }

  if (!marches.known) bits.push('this city has no map position, so its marches cannot be told apart — nothing recalled');
  else if (ctx.selfArmies === undefined || ctx.selfArmies === null) bits.push('no army list yet — nothing recalled');
  if (actions.length) bits.push(`recalling ${actions.length} march(es) still heading out`);
  if (waiting.length) bits.push(`${waiting.length} recalled, waiting for them to turn round`);
  for (const m of stuck) bits.push(`${m.what} (army ${m.armyId}) would not turn back after ${RECALL_MAX_TRIES} recalls${m.error ? ` (${m.error})` : ''} — recall it by hand`);
  const later = marches.recall.filter((m) => !ws.targets.some((x) => String(x) === String(m.armyId))).length;
  if (later) bits.push(`${later} other march(es) heading out are left alone (only what was out at switch-on is recalled)`);
  if (marches.camped.length) bits.push(`${marches.camped.length} camped elsewhere stay where they are`);
  for (const m of marches.left) bits.push(`${m.why} is not recalled`);

  const heroNote = lock.heroMayMove ? 'the traininghero may still come and go' : 'the traininghero stays once it lands here';
  return {
    note: `${head}: locked down${lock.window ? ` (${lock.window.text})` : ''} — npc farming, buildnpc and transfers ` +
          `out of this city are held; ${heroNote}${bits.length ? '; ' + bits.join('; ') : ''}${errs}`,
    actions, lockdown: true, heroMayMove: lock.heroMayMove,
  };
}

// -------------------------------------------------------------- monitorarmy
// Accepted so the line does not error. The NEAT wiki is blunt about it: the
// goal has never done anything on NEAT or on YAEB.
function monitorArmyPlan(ctx) {
  if (ctx.config.monitorarmy === undefined) return null;
  return { note: 'monitorarmy: accepted and ignored — it has never done anything (NEAT wiki)', actions: [] };
}

// --------------------------------------------------------------- constraints
// keepatthome / attackgap / defensecooldown / nohealing never march anything.
// They are rules the OTHER goals read, so they are exposed as helpers as well
// as reported in a plan note.

// power / management / stratagem ALREADY include the points allocated with
// hero.addPoint — `powerAdded` is the separate count of those allocations, not
// a bonus to add on. HeroProperties.as (1274, 1610, 2134) renders the panel
// straight from heroMes.power and never touches powerAdded.
const heroAttack = (h) => n(h.power);

// wiki KeepAttHome: the hero kept home is the city's best attack hero — never
// the traininghero, and the second best while config training is on (the best
// is out training). Left out of the ranking: the mayor, which is home anyway
// and can neither farm nor lead a march (HomeHeroes leaves it out of its count
// the same way), and captives. The ranking covers the whole roster, home or
// away. While the hero it picks is away, the best one at home below it stands
// in, so an attack hero is in the city whenever one can be; the stand-in is
// free again as soon as the real one is back.
//   hero         the hero kept home right now (null: nobody can be)
//   away         the ranked hero, when it is out and `hero` stands in for it
//   reservedIds  what npc farming must not send; hiding takes it last
function keepAttHome(ctx) {
  const cfg = parsers.keepatthome.parse((ctx.config || {}).keepatthome);
  const out = { on: cfg.on, keep: cfg.keep, hero: null, away: null, training: false,
    reserved: [], reservedIds: new Set(), short: cfg.keep, errors: cfg.errors };
  if (!cfg.on) return out;
  const c = ctx.config || {};
  out.training = n(c.training) >= 1 || n(c.training10) >= 1;
  const th = trainingHeroNames(ctx);
  const ranked = ((ctx.castle && ctx.castle.heros) || [])
    .filter((h) => n(h.status) !== HERO.CHIEF && n(h.status) !== HERO.SEIZED && !th.has(String(h.name || '').toLowerCase()))
    .sort((a, b) => heroAttack(b) - heroAttack(a));
  const at = out.training ? 1 : 0;
  const top = ranked[at];
  if (!top) return out;
  const isHome = (h) => h.status === undefined || n(h.status) === HERO.FREE;
  out.hero = isHome(top) ? top : ranked.slice(at + 1).find(isHome) || null;
  out.away = isHome(top) ? null : top;
  if (out.hero) { out.reserved = [out.hero]; out.reservedIds = new Set([out.hero.id]); out.short = 0; }
  return out;
}

// Hiding needs a FREE hero to lead the march, and the wiki's advice is to use
// KeepAttHome or HomeHeroes so one is home. So it takes a hero no rule holds
// first; then keepatthome's defender, which is exactly why that rule is there
// when all else is out; and the traininghero last, so its rotation only breaks
// when nobody else is in. homeheroes counts heroes held back from FARMING, and
// an evasion is not farming, so its home heroes are free for this.
function hideHero(ctx, heroes) {
  const free = heroes.filter((h) => Number(h.status) === HERO.FREE);
  const kept = keepAttHome(ctx).reservedIds;
  const th = trainingHeroNames(ctx);
  const isTh = (h) => th.has(String(h.name || '').toLowerCase());
  const plain = free.find((h) => !kept.has(h.id) && !isTh(h));
  if (plain) return { hero: plain, why: null };
  const defender = free.find((h) => kept.has(h.id));
  if (defender) return { hero: defender, why: 'the keepatthome hero, as nobody else is home' };
  const trainee = free.find(isTh);
  return trainee ? { hero: trainee, why: 'the traininghero, as nobody else is home' } : { hero: null, why: null };
}

// wiki AttackGap: the real waves, soonest first, grouped into attacks. A wave
// landing at least `attackgap` after the wave before it starts a new attack;
// closer waves are one attack, evaded together once. Junk is defaultJunk's
// (defensepolicy /junktroop). Hiding's march already stays out past every wave
// inside hidingpolicy /horizon, so each separate attack there is evaded; coming
// home BETWEEN attacks and going out again is not done: a relaunch that misses
// its moment would leave the whole army home when the next attack lands.
// Waves with no known arrival time cannot be placed.
function attackGroups(ctx, threats) {
  const gapMs = parsers.attackgap.parse((ctx.config || {}).attackgap).gapMs;
  const t = threats || threatsOf(ctx, {});
  const timed = t.real.filter((a) => a.msUntil !== null).sort((a, b) => a.msUntil - b.msUntil);
  const groups = [];
  for (const a of timed) {
    const g = groups[groups.length - 1];
    if (g && a.msUntil - g.lastMs < gapMs) { g.waves.push(a); g.lastMs = a.msUntil; }
    else groups.push({ firstMs: a.msUntil, lastMs: a.msUntil, waves: [a] });
  }
  return { gapMs, groups, waves: timed.length, untimed: t.real.length - timed.length };
}

// One key per inbound wave, stable from tick to tick.
function waveKey(a) {
  const raw = a.raw || {};
  const id = a.armyId ?? raw.armyId ?? (raw.raw && raw.raw.armyId);
  return id !== undefined && id !== null ? `id:${id}` : `at:${a.from}@${a.reachTime}`;
}

// wiki DefenseCooldown: the city is under attack while a real wave is inbound,
// and for `defensecooldown` minutes after the last one landed or was recalled.
// Junk (defaultJunk: defensepolicy /junktroop) never starts it. A landing or a
// recall is only seen by looking, so each call remembers the waves it sees
// (state.war.defense) and settles the ones that have gone: gone once its time
// had come, it landed then; gone earlier, it was recalled (or turned away) just
// now. goalmods' defensePlan and plans.constraints both call it every tick
// (the same call twice is harmless). The wiki's users of the window are
// defensepolicy /usetruce /usespeech and config embassy:2.
function underAttack(ctx, state) {
  const cfg = parsers.defensecooldown.parse((ctx.config || {}).defensecooldown);
  const t = threatsOf(ctx, {});
  const now = t.now;
  // a quiet city that has never been attacked keeps no record at all
  if (!t.real.length && !(state && state.war && state.war.defense)) {
    return { on: false, inbound: 0, leftMs: 0, cooldownMs: cfg.cooldownMs, lastEndAt: null, sinceEndMs: null, attacks: attackGroups(ctx, t) };
  }
  const st = warState(state || {});
  const ds = (st.defense = st.defense || {});
  ds.waves = ds.waves || {};
  const seen = new Set();
  for (const a of t.real) {
    const key = waveKey(a);
    seen.add(key);
    const landAt = a.msUntil === null ? null : now + a.msUntil;
    ds.waves[key] = landAt;
    if (landAt !== null && landAt <= now) ds.lastEndAt = Math.max(n(ds.lastEndAt), landAt);
  }
  for (const [key, landAt] of Object.entries(ds.waves)) {
    if (seen.has(key)) continue;
    ds.lastEndAt = Math.max(n(ds.lastEndAt), landAt !== null && n(landAt) <= now ? n(landAt) : now);
    delete ds.waves[key];
  }
  const inbound = t.real.filter((a) => a.msUntil === null || a.msUntil > 0).length;
  const leftMs = ds.lastEndAt ? Math.max(0, n(ds.lastEndAt) + cfg.cooldownMs - now) : 0;
  return {
    on: inbound > 0 || leftMs > 0, inbound, leftMs, cooldownMs: cfg.cooldownMs,
    lastEndAt: ds.lastEndAt || null, sinceEndMs: ds.lastEndAt ? now - ds.lastEndAt : null,
    attacks: attackGroups(ctx, t),
  };
}

function healingAllowed(ctx) { return !parsers.nohealing.parse(ctx.config.nohealing).on; }

const minutesText = (ms) => (ms % 60000 ? hhmmss(ms) : `${ms / 60000} min`);

// One plan so the rules show up in the tick report rather than being invisible.
function constraintsPlan(ctx, state) {
  const cfg = ctx.config || {};
  const lines = [];
  const errs = (e) => (e && e.length ? ` [${e.join('; ')}]` : '');

  if (cfg.keepatthome !== undefined) {
    const k = keepAttHome(ctx);
    const which = k.training ? 'second-best attack hero (config training is on)' : 'best attack hero';
    if (!k.on) { if (k.errors.length) lines.push(`keepatthome: off${errs(k.errors)}`); }
    else if (k.hero && !k.away) lines.push(`keepatthome: ${k.hero.name} (atk ${heroAttack(k.hero)}), the ${which}, stays home${errs(k.errors)}`);
    else if (k.hero) lines.push(`keepatthome: ${k.away.name}, the ${which}, is out — ${k.hero.name} stays home until it is back${errs(k.errors)}`);
    else if (k.away) lines.push(`keepatthome: ${k.away.name}, the ${which}, is out and nobody can stand in — it stays home once back${errs(k.errors)}`);
    else lines.push(`keepatthome: there is no ${which} to keep home${errs(k.errors)}`);
  }

  // Looked at every tick, set or not: the under-attack window has to see waves land.
  const u = underAttack(ctx, state);
  if (cfg.attackgap !== undefined) {
    const g = u.attacks;
    lines.push(`attackgap ${g.gapMs / 1000}s: ${g.waves ? `${g.waves} wave(s) inbound = ${g.groups.length} separate attack(s)` : 'nothing inbound'}` +
               errs(parsers.attackgap.parse(cfg.attackgap).errors));
  }
  if (cfg.defensecooldown !== undefined || u.on) {
    const now = u.inbound ? 'under attack' : u.on ? `under attack for another ${hhmmss(u.leftMs)} (the last wave landed or was recalled ${hhmmss(u.sinceEndMs)} ago)` : 'not under attack';
    lines.push(`defensecooldown ${minutesText(u.cooldownMs)}: ${now}${u.inbound ? ` — ${u.inbound} real wave(s) inbound` : ''}` +
               errs(parsers.defensecooldown.parse(cfg.defensecooldown).errors));
  }
  if (cfg.nohealing !== undefined && !healingAllowed(ctx)) {
    lines.push('nohealing: wounded troops are left in the medic camp');
  }

  return lines.length ? { note: lines.join(' | '), actions: [] } : null;
}

// ------------------------------------------------------------------ embassy
// config embassy:<0|1|2>
//
// The box is CastleBean.allowAlliance (the console's General tab shows it as
// "Alliance help"), set with army.setAllowAllianceArmy {castleId, isAllow}
// from the Embassy window (Embassy.as:545-549). It is only sent when the box
// differs from what the setting wants.
//
// NEAT's default is 1, "always open", but only a city whose goals say
// `config embassy:<0|1|2>` (its own, or the account's prepend/append goals) is
// touched: applied to every city, the default would open the box to alliance
// troops in every live city, none of which sets the key, the moment this
// shipped. A city that never mentions it keeps the box however it was set.
//
// A city with no Embassy is left alone as well: the box lives in the Embassy
// window, and alliance troops can only station up to the Embassy's level
// ("allied armies stationed: n/level", Embassy.as:445), so without one there
// is nothing to allow.
const EMBASSY_TYPE = 28;                // constants.js BUILDINGS: Embassy
const EMBASSY_RETRY_MS = 5 * 60000;     // a refused or unanswered change is asked again after this

function embassyPlan(ctx, state, game) {
  const raw = (ctx.config || {}).embassy;
  if (raw === undefined || raw === null) return null;
  const cfg = parsers.embassy.parse(raw);
  if (cfg.errors.length) return { note: `embassy: ${cfg.errors.join('; ')} — the box is left as it is`, actions: [] };
  const word = { 0: 'always closed', 1: 'always open', 2: 'open while under attack' }[cfg.mode];
  const head = `embassy ${cfg.mode} (${word})`;

  const castle = ctx.castle || {};
  const building = (castle.buildings || []).find((b) => n(b.typeId) === EMBASSY_TYPE && n(b.level) > 0);
  if (!building) return { note: `${head}: this city has no Embassy, so there is no box to set`, actions: [] };

  let want, why;
  if (cfg.mode === 2) {
    const u = underAttack(ctx, state);
    want = u.on;
    why = u.inbound ? `under attack, ${u.inbound} real wave(s) inbound`
      : u.on ? `under attack for another ${hhmmss(u.leftMs)} (config defensecooldown)` : 'not under attack';
  } else {
    want = cfg.mode === 1;
    why = null;
  }
  const set = want ? 'open' : 'closed';
  const known = castle.allowAlliance === true || castle.allowAlliance === false;
  const lead = `${head}: ${why ? `${why} — ` : ''}alliance troops ${want ? 'allowed' : 'not allowed'}`;
  if (known && castle.allowAlliance === want) return { note: `${lead}; the box is already ${set}`, actions: [] };

  // A change the server refused, or never answered, waits before it is asked again.
  const last = state && state.war && state.war.embassy;
  const now = nowOf(ctx, game);
  if (last && !last.ok && last.want === want && now - n(last.at) < EMBASSY_RETRY_MS) {
    return {
      note: `${lead}; setting it ${set} ${last.error ? `was refused (${last.error})` : 'got no reply'} ` +
            `${hhmmss(now - n(last.at))} ago, trying again in ${hhmmss(EMBASSY_RETRY_MS - (now - n(last.at)))}`,
      actions: [],
    };
  }
  return {
    note: `${lead}; the box is ${known ? (castle.allowAlliance ? 'open' : 'closed') : 'not reported'} — setting it ${set}`,
    actions: [{ kind: 'setEmbassy', allow: want, label: `${want ? 'open' : 'close'} the embassy to alliance troops (config embassy:${cfg.mode})` }],
  };
}

// ============================================================================
//                                  EXECUTORS
// ============================================================================
// (game, castle, action, state) -> the raw command response. `state` is
// optional; pass the same per-city state object the plans were given and the
// bookkeeping (gate cooldown, hide march record, chat timestamps) is kept for
// you. Without it the plans still work, they just re-decide every tick.
const executors = {
  // army.newArmy {castleId, newArmyBean}   ArmyCommands.as:104
  async hideTroops(game, castle, a, state) {
    const r = await game.newArmy(game.castleId(castle), a.bean);
    if (state && r && r.ok === 1) {
      const st = warState(state);
      st.hide = {
        armyId: null,                       // newArmy's reply carries no armyId
        launchedAt: game.now ? game.now() : Date.now(),
        forImpactAt: a.forImpactAt,
        expectedReturnAt: a.expectedReturnAt,
        targetFieldId: a.targetPoint,
        missionType: a.missionType,
        troops: a.troops,
      };
    }
    return r;
  },

  // army.callBackArmy {castleId, armyId}   ArmyCommands.as:118
  // castleId is the city the army LEFT from (server.js's console recall looks
  // it up the same way); an action that names it uses it. War town recalls are
  // counted per army, sent or refused, so the plan knows when to try again.
  async recallArmy(game, castle, a, state) {
    const castleId = a.castleId !== undefined && a.castleId !== null ? a.castleId : game.castleId(castle);
    let r;
    try {
      r = await game.req('army.callBackArmy', { castleId, armyId: a.armyId });
    } finally {
      if (state && a.wartown) {
        const st = warState(state);
        const ws = (st.wartown = st.wartown || {});
        const recs = (ws.recall = ws.recall || {});
        const rec = (recs[a.armyId] = recs[a.armyId] || {});
        rec.sentAt = game.now ? game.now() : Date.now();
        rec.tries = n(rec.tries) + 1;
        rec.error = r && r.ok === 1 ? null : (r && r.errorMsg) || (r ? `ok=${r.ok}` : 'no reply');
      }
    }
    if (state && !a.wartown && r && r.ok === 1) {
      const st = warState(state);
      if (st.hide && (st.hide.armyId === a.armyId || st.hide.armyId === null)) delete st.hide;
    }
    return r;
  },

  // army.setArmyGoOut {castleId, isArmyGoOut}   ArmyCommands.as:143
  async setGate(game, castle, a, state) {
    const r = await game.req('army.setArmyGoOut', { castleId: game.castleId(castle), isArmyGoOut: !!a.open });
    if (r && r.ok === 1) {
      castle.goOutForBattle = !!a.open;     // the server does not echo it back
      if (state) {
        const gs = warState(state);
        const at = game.now ? game.now() : Date.now();
        gs.gate = gs.gate || {};
        gs.gate.lastAt = at; gs.gate.want = !!a.open;
      }
    }
    return r;
  },

  // army.setAllowAllianceArmy {castleId, isAllow}   ArmyCommands.as:156-167
  // (game.setAllowAlliance). The client sets castle.allowAlliance itself and
  // nothing echoes it back, so an ok does the same here. Every attempt is
  // stamped, so a refusal waits EMBASSY_RETRY_MS before it is asked again.
  async setEmbassy(game, castle, a, state) {
    const castleId = game.castleId(castle);
    let r;
    try {
      r = typeof game.setAllowAlliance === 'function' ? await game.setAllowAlliance(castleId, !!a.allow)
        : await game.req('army.setAllowAllianceArmy', { castleId, isAllow: !!a.allow });
    } finally {
      if (state) {
        warState(state).embassy = {
          at: game.now ? game.now() : Date.now(), want: !!a.allow, ok: !!(r && r.ok === 1),
          error: r && r.ok === 1 ? null : (r && r.errorMsg) || (r ? `ok=${r.ok}` : null),
        };
      }
    }
    if (r && r.ok === 1) castle.allowAlliance = !!a.allow;
    return r;
  },

  // common.allianceChat {msg, languageType}   CommonCommands.as:172
  async allianceChat(game, castle, a, state) {
    const r = await game.req('common.allianceChat', { msg: a.msg, languageType: 0 });
    if (state) {
      const cs = warState(state);
      cs.chat = cs.chat || {};
      cs.chat.lastAt = game.now ? game.now() : Date.now();
      cs.chat.lastSig = a.sig;
    }
    return r;
  },

  async note(game, castle, a) { return { ok: 1, msg: a.label }; },
};

// ============================================================================
//                                  DESCRIBE
// ============================================================================
// One readable line per configured war goal, matching goals.js's describe().
function describe(parsed) {
  const out = [];
  const cfg = parsed.config || {};
  const goal = (name) => (parsed.goals || []).find((g) => g.name === name);

  if (cfg.hiding !== undefined) {
    const h = parsers.hiding.parse(cfg.hiding);
    const p = goal('hidingpolicy') || parsers.hidingpolicy.parse([]);
    out.push(h.enabled
      ? `hiding: ${hhmmss(h.leadMs)} before impact, march everything${p.sendResources ? ' and the loose resources' : ''} to ` +
        `${p.target ? `${p.target.x},${p.target.y}` : 'the nearest safe city of yours'}, back once the wave has landed`
      : 'hiding: off');
  }
  if (cfg.gate !== undefined) {
    const g = parsers.gate.parse(cfg.gate);
    const p = goal('gatepolicy');
    const word = { 0: 'bot', 1: 'open', 2: 'close' };
    out.push(g.enabled
      ? `gate: decide ${hhmmss(g.leadMs)} before impact` +
        (p ? ` — quiet:${word[p.rules.noattack]} regular:${word[p.rules.regular]} scoutbomb:${word[p.rules.scoutbomb]} mixed:${word[p.rules.mixed]} maintenance:${word[p.rules.maintenance]}` : ' (bot decides — no gatepolicy set)')
      : 'gate: off');
  }
  if (cfg.warrules !== undefined) {
    const w = parsers.warrules.parse(cfg.warrules);
    out.push(w.enabled ? `warrules: alert the alliance, updates every ${hhmmss(w.everyMs)}, reminders every ${hhmmss(w.reminderMs)}` : 'warrules: off');
  }
  const wtp = goal('wartownpolicy');
  const hours = wtp && wtp.windows && wtp.windows.length ? wtp.windows.map((w) => w.text).join(', ') : null;
  if (cfg.wartown !== undefined) {
    const w = parsers.wartown.parse(cfg.wartown);
    out.push(w.enabled
      ? `wartown ${w.mode}: no npc farming, buildnpc or transfers out of this city${hours ? ` during ${hours}` : ''}, ` +
        `${w.heroMayMove ? 'traininghero may still rotate' : 'traininghero stays once it lands here'}`
      : 'wartown: off');
  }
  if (wtp) {
    out.push(`wartownpolicy: war town only during ${hours || '(no valid hours)'} on this machine's clock` +
             (parsers.wartown.parse(cfg.wartown).enabled ? '' : ' — idle until config wartown:1 or 2'));
  }
  if (cfg.keepatthome !== undefined) {
    const k = parsers.keepatthome.parse(cfg.keepatthome);
    out.push(k.on ? 'keepatthome: the best attack hero (never the traininghero; the second best while config training is on) stays home, never sent farming' : 'keepatthome: off');
  }
  if (cfg.attackgap !== undefined) {
    const a = parsers.attackgap.parse(cfg.attackgap);
    out.push(`attackgap: incoming waves ${a.gapMs / 1000}s or more apart are separate attacks, closer ones one attack`);
  }
  if (cfg.defensecooldown !== undefined) {
    const d = parsers.defensecooldown.parse(cfg.defensecooldown);
    out.push(`defensecooldown: still under attack ${minutesText(d.cooldownMs)} after the last real wave lands or is recalled`);
  }
  if (cfg.nohealing !== undefined) {
    out.push(parsers.nohealing.parse(cfg.nohealing).on ? 'nohealing: wounded troops are never healed' : 'nohealing: off');
  }
  if (cfg.embassy !== undefined) {
    const e = parsers.embassy.parse(cfg.embassy);
    out.push(e.errors.length ? 'embassy: not understood, the box is left as it is'
      : `embassy: alliance troops ${e.mode === 1 ? 'always allowed' : e.mode === 0 ? 'never allowed'
        : 'allowed only while under attack and for config defensecooldown after'} (the Embassy's box)`);
  }
  if (cfg.monitorarmy !== undefined) out.push('monitorarmy: accepted, does nothing');
  return out;
}

module.exports = {
  parsers,
  plans: {
    hiding: hidingPlan,
    gate: gatePlan,
    warrules: warRulesPlan,
    wartown: warTownPlan,
    monitorarmy: monitorArmyPlan,
    constraints: constraintsPlan,      // keepatthome / attackgap / defensecooldown / nohealing
    embassy: embassyPlan,              // config embassy (after constraints: it reads the same window)
  },
  executors,
  // integration helpers
  configKeys,
  describe,
  lockdown, isWarTown,               // war town, for every goal that marches
  keepAttHome,                       // the hero keepatthome keeps home
  attackGroups, underAttack,         // attackgap / defensecooldown
  healingAllowed,
  // daily windows on this machine's clock: wartownpolicy's, and schedulepolicy's (processing.js)
  parseWindows, windowAt, nextWindow, hhmm,
  // exported for the tests
  _internals: { durationMs, count, normalizeArmy, classify, threatsOf, buildHideMarch, gateBotChoice, hidingOptions, hhmmss, defaultJunk,
    clockMin, windowAt, marchesFrom, hideHero },
  // when the hiding and gate goals next need a look (Engine.nextWakeAt)
  warMoments,
};
