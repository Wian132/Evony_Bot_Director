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
//   config monitorarmy:<n>               accepted, does nothing (see below)
//   config keepatthome:<n>               reserve N attack heroes in the city
//   config attackgap:<seconds|2min>      minimum spacing between outgoing attacks
//   config defensecooldown:<minutes|30s> minimum spacing between defensive responses
//   config nohealing:<0|1>               never heal wounded troops
//   gatepolicy <na> <reg> <sb> <mix> <mnt> [/switches]
//   hidingpolicy /switch:value ...       (our addition — NEAT infers these)
//
// The last four are LIMITS, not actions: they are exported as helpers
// (keepAttHome / attackAllowed / defenceAllowed / healingAllowed) for the goals
// that do march, and reported by plans.constraints so they are visible.
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
function durationMs(v, unit = 'min') {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return unit === 'sec' ? v * 1000 : v * 60000;
  const m = String(v).trim().match(/^([\d.]+)\s*(ms|s|sec|secs|seconds?|min|mins|minutes?|h|hr|hours?)?$/i);
  if (!m) return 0;
  const q = parseFloat(m[1]);
  if (!isFinite(q)) return 0;
  const u = (m[2] || unit).toLowerCase();
  if (u === 'ms') return q;
  if (u[0] === 's') return q * 1000;
  if (u[0] === 'h') return q * 3600000;
  return q * 60000;
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

// "a:50000,s:10" -> {archer: 50000, scouter: 10}
function parseTroopSpec(s, errs, label) {
  const out = {};
  for (const part of String(s).split(',')) {
    const p = part.trim();
    if (!p) continue;
    const [code, amt] = kv(p);
    const t = C.BY_CODE[code.toLowerCase()] || C.BY_KEY[code];
    if (!t) { errs.push(`${label}: unknown troop code "${code}"`); continue; }
    const q = parseInt(String(amt).replace(/[,\s]/g, ''), 10);
    if (!isFinite(q)) { errs.push(`${label}: bad amount "${amt}" for ${code}`); continue; }
    out[t.key] = q;
  }
  return out;
}

// ------------------------------------------------------------------ incoming
// engine.js flattens each inbound army to {troops:<total>, reachTime, from}, so
// the per-type breakdown is normally gone by the time we see it. We read
// whichever shape is present: a raw ArmyBean (troop / troops as an object), or
// the flattened total. `known` says whether the total can be trusted.
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

// Every plan starts here: the inbound armies worth reacting to, soonest first.
function threatsOf(ctx, opts = {}) {
  const game = ctx.game;
  const nowMs = game && game.now ? game.now() : Date.now();
  // /junk:0 means "react to everything" and must not fall back to the default
  const junk = opts.junk === null || opts.junk === undefined ? 1000 : n(opts.junk);
  const list = (ctx.incoming || [])
    .map((a) => classify(normalizeArmy(a, nowMs), opts))
    .filter((a) => a.msUntil === null || a.msUntil > -60000);   // drop stale entries
  const real = list.filter((a) => a.total === null || a.total >= junk);
  real.sort((a, b) => (a.msUntil ?? Infinity) - (b.msUntil ?? Infinity));
  return { now: nowMs, all: list, real, junk: list.length - real.length };
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
  wartown: {
    kind: 'config', multi: false,
    parse(value) {
      const errs = [];
      const v = parseInt(value, 10);
      if (!Number.isInteger(v) || v < 0 || v > 2) {
        errs.push(`wartown must be 0 (off), 1 (on, traininghero may move) or 2 (on, traininghero stays), got "${value}"`);
      }
      const mode = clamp(Number.isInteger(v) ? v : 0, 0, 2);
      return { mode, enabled: mode > 0, heroMayMove: mode === 1, errors: errs };
    },
  },

  // --------------------------------------------------------- config monitorarmy
  // Kept only so the line does not error. Per the NEAT wiki this goal has never
  // done anything on NEAT or YAEB; it is accepted and ignored.
  monitorarmy: {
    kind: 'config', multi: false,
    parse() { return { noop: true, errors: [] }; },
  },

  // ------------------------------------------------ config keepatthome:<n>
  // INFERRED (the wiki page would not load — surge-protected throughout this
  // session). Read as: keep N ATTACK heroes in the city rather than out
  // farming. The Hiding page names it as the goal that guarantees hiding a
  // hero to march with, which is the reading used here. It never marches
  // anything itself — it only ever stops another goal from marching.
  keepatthome: {
    kind: 'config', multi: false,
    parse(value) {
      const errs = [];
      const v = parseInt(value, 10);
      if (value !== undefined && value !== null && value !== '' && !Number.isInteger(v)) {
        errs.push(`keepatthome: expected a hero count, got "${value}"`);
      }
      const keep = Math.max(0, Number.isInteger(v) ? v : 0);
      return { keep, enabled: keep > 0, errors: errs };
    },
  },

  // --------------------------------------------- config attackgap:<seconds>
  // INFERRED unit: seconds. Write "2min" if you mean minutes — the suffix is
  // honoured and removes the ambiguity.
  attackgap: {
    kind: 'config', multi: false,
    parse(value) {
      const errs = [];
      const ms = durationMs(value, 'sec');
      if (value !== undefined && value !== null && value !== '' && ms === 0 && String(value) !== '0') {
        errs.push(`attackgap: cannot read "${value}" as a duration (seconds, or "2min")`);
      }
      return { gapMs: ms, enabled: ms > 0, errors: errs };
    },
  },

  // ---------------------------------------- config defensecooldown:<minutes>
  // INFERRED unit: minutes. Write "30s" if you mean seconds.
  defensecooldown: {
    kind: 'config', multi: false,
    parse(value) {
      const errs = [];
      const ms = durationMs(value, 'min');
      if (value !== undefined && value !== null && value !== '' && ms === 0 && String(value) !== '0') {
        errs.push(`defensecooldown: cannot read "${value}" as a duration (minutes, or "30s")`);
      }
      return { cooldownMs: ms, enabled: ms > 0, errors: errs };
    },
  },

  // ------------------------------------------------ config nohealing:<0|1>
  // INFERRED. 1 means never heal wounded troops, i.e. never send
  // army.cureInjuredTroop (ArmyCommands.as:160). Nothing in this bot heals
  // today, so this only records the intent for whatever adds healing later.
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
      const maxRestMs = sw.maxrest !== undefined ? durationMs(sw.maxrest, 'min') : 8 * 3600000;
      // NewArmyWin.as:1707 clamps the encamp input at 24h, so never ask for more.
      if (maxRestMs > 24 * 3600000) errs.push('/maxrest is capped at 24h by the game client');

      return {
        target,
        missionType,
        keep,
        keepRes: sw.keepres !== undefined ? n(sw.keepres) : 0,
        sendResources: sw.resources === undefined ? true : n(sw.resources) === 1,
        sendGold: n(sw.gold) === 1,                       // off by default: gold is wanted at home
        needHero: sw.needhero === undefined ? true : n(sw.needhero) === 1,
        junk: sw.junk !== undefined ? n(sw.junk) : null,
        maxRestMs: clamp(maxRestMs, 0, 24 * 3600000),
        marginMs: sw.margin !== undefined ? durationMs(sw.margin, 'min') : 5 * 60000,
        minLeadMs: sw.minlead !== undefined ? durationMs(sw.minlead, 'sec') : 4000,
        horizonMs: sw.horizon !== undefined ? durationMs(sw.horizon, 'min') : 60 * 60000,
        maxMarches: sw.maxmarches !== undefined ? n(sw.maxmarches) : 0,   // 0 = do not check
        recall: sw.recall === undefined ? true : n(sw.recall) === 1,
        foodShare: (() => {
          if (sw.foodshare === undefined) return 0.9;
          const f = parseFloat(sw.foodshare);
          if (!isFinite(f)) { errs.push(`/foodshare must be a fraction between 0.05 and 1 — got "${sw.foodshare}"`); return 0.9; }
          return clamp(f, 0.05, 1);
        })(),
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
                    'keepatthome', 'attackgap', 'defensecooldown', 'nohealing'];

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
  // to free a hero up, so only a FREE hero may lead the march.
  const heroes = castle.heros || [];
  const hero = heroes.find((h) => Number(h.status) === HERO.FREE);
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
  // NewArmyWin.as:3104 + 1717:
  //   portableFood = upkeepPerHour * oneWayHours
  //   needFood     = portableFood + upkeepPerHour * restHours
  // and the client refuses to send when needFood > the city's food. The food
  // also rides in the army's carry capacity, so it eats into what we can hide.
  const upkeepPerHour = Object.entries(troops).reduce((s, [k, v]) => s + v * C.BY_KEY[k].food, 0);
  const loads = Object.entries(troops).reduce((s, [k, v]) => s + v * C.BY_KEY[k].load, 0);
  const res = castle.resource || {};
  const foodHave = n(res.food && res.food.amount);
  const foodBudget = Math.floor(foodHave * opt.foodShare);

  const oneWayHours = oneWayMs / 3600000;
  const foodFor = (sec) => Math.ceil(upkeepPerHour * (oneWayHours + sec / 3600));

  let clampedByFood = false;
  if (foodFor(restSec) > foodBudget) {
    const affordable = Math.floor(((foodBudget / Math.max(1, upkeepPerHour)) - oneWayHours) * 3600);
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
  // config defensecooldown paces every defensive response, this one included.
  const cool = defenceAllowed(ctx, state, game);
  if (!cool.ok) return { note: `${head} — held by defensecooldown for another ${hhmmss(cool.waitMs)}`, actions: [] };

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

  // Signature of the current picture: which waves, how big, landing when
  // (bucketed to a minute so a ticking clock is not "a change").
  const sig = t.real
    .map((a) => `${a.armyId ?? a.from}:${a.total ?? '?'}:${Math.round((a.msUntil ?? 0) / 60000)}`)
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
// config wartown:<0|1|2>
// A lockdown flag. It does not itself march anything: it tells the rest of the
// bot to stop moving troops around. On the 0 -> 1/2 transition it also does the
// wiki's "recallall" for you, which needs ctx.selfArmies to name the armies.
function warTownPlan(ctx, state, game) {
  game = game || ctx.game;
  const cfg = parsers.wartown.parse(ctx.config.wartown);
  if (ctx.config.wartown === undefined || ctx.config.wartown === null) return null;

  const st = warState(state);
  const ws = (st.wartown = st.wartown || {});
  const now = game && game.now ? game.now() : Date.now();

  if (!cfg.enabled) {
    if (ws.on) { ws.on = false; ws.liftedAt = now; return { note: 'wartown: lifted — normal troop movement resumes', actions: [], lockdown: false }; }
    return { note: 'wartown: off', actions: [], lockdown: false };
  }

  const suppressed = 'npc farming, valley/hunting runs, KeepResources, SendResources, KeepTroops and SendTroops';
  const heroNote = cfg.heroMayMove ? 'traininghero may still move in and out' : 'traininghero stays put once it lands here';

  const armies = ctx.selfArmies || null;
  const fresh = !ws.on;
  if (fresh) { ws.on = true; ws.since = now; }

  // Re-issue the recall if armies are still out a minute later: the first pass
  // may have been a dry run, or a callBackArmy may simply have failed.
  const retry = !fresh && armies && armies.length && now - n(ws.lastRecallAt) > 60000;
  if (!fresh && !retry) {
    return { note: `wartown ${cfg.mode}: locked down — ${suppressed} are held; ${heroNote}`, actions: [], lockdown: true, heroMayMove: cfg.heroMayMove };
  }

  if (!armies) {
    return {
      note: `wartown ${cfg.mode}: locking down — ${suppressed} are held; ${heroNote}. ` +
            'Cannot recall marching armies automatically (no server.SelfArmysUpdate feed)',
      actions: [], lockdown: true, heroMayMove: cfg.heroMayMove,
    };
  }
  ws.lastRecallAt = now;
  return {
    note: `wartown ${cfg.mode}: ${fresh ? 'locking down and recalling' : 'still recalling'} ${armies.length} marching army(ies); ${heroNote}`,
    actions: armies.map((a) => ({ kind: 'recallArmy', armyId: a.armyId, label: `recall army ${a.armyId}` })),
    lockdown: true, heroMayMove: cfg.heroMayMove,
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
// They are limits the OTHER goals are supposed to respect, so they are exposed
// as helpers as well as reported in a plan note.

// power / management / stratagem ALREADY include the points allocated with
// hero.addPoint — `powerAdded` is the separate count of those allocations, not
// a bonus to add on. HeroProperties.as (1274, 1610, 2134) renders the panel
// straight from heroMes.power and never touches powerAdded.
const heroAttack = (h) => n(h.power);
const isAttackHero = (h) => heroAttack(h) >= Math.max(n(h.management), n(h.stratagem));

// The heroes keepatthome reserves: the strongest attack heroes that are home
// and idle. Anything wanting to send a hero out should skip these.
function keepAttHome(ctx) {
  const cfg = parsers.keepatthome.parse(ctx.config.keepatthome);
  if (!cfg.enabled) return { keep: 0, reserved: [], reservedIds: new Set() };
  const home = (ctx.castle.heros || []).filter((h) => h.status === HERO.FREE && isAttackHero(h));
  const reserved = home.slice().sort((a, b) => heroAttack(b) - heroAttack(a)).slice(0, cfg.keep);
  return { keep: cfg.keep, reserved, reservedIds: new Set(reserved.map((h) => h.id)), short: cfg.keep - reserved.length };
}

// True when another outgoing attack may leave now. Stamp noteAttackSent() after
// each attack march so the gap is measured from the right moment.
function attackAllowed(ctx, state, game) {
  const cfg = parsers.attackgap.parse(ctx.config.attackgap);
  if (!cfg.enabled) return { ok: true, waitMs: 0 };
  const now = (game || ctx.game) && ((game || ctx.game).now ? (game || ctx.game).now() : Date.now());
  const since = now - n(warState(state).lastAttackAt);
  return since >= cfg.gapMs ? { ok: true, waitMs: 0 } : { ok: false, waitMs: cfg.gapMs - since };
}
function noteAttackSent(state, at) { warState(state).lastAttackAt = at || Date.now(); }

// Same shape for the defensive side: one defensive response per cooldown.
function defenceAllowed(ctx, state, game) {
  const cfg = parsers.defensecooldown.parse(ctx.config.defensecooldown);
  if (!cfg.enabled) return { ok: true, waitMs: 0 };
  const now = (game || ctx.game) && ((game || ctx.game).now ? (game || ctx.game).now() : Date.now());
  const since = now - n(warState(state).lastDefenceAt);
  return since >= cfg.cooldownMs ? { ok: true, waitMs: 0 } : { ok: false, waitMs: cfg.cooldownMs - since };
}
function noteDefenceUsed(state, at) { warState(state).lastDefenceAt = at || Date.now(); }

function healingAllowed(ctx) { return !parsers.nohealing.parse(ctx.config.nohealing).on; }

// One plan so the limits show up in the tick report rather than being invisible.
function constraintsPlan(ctx, state, game) {
  game = game || ctx.game;
  const cfg = ctx.config || {};
  const lines = [];

  if (cfg.keepatthome !== undefined) {
    const k = keepAttHome(ctx);
    if (k.keep) {
      lines.push(`keepatthome ${k.keep}: holding ${k.reserved.map((h) => h.name).join(', ') || 'nobody'}` +
                 (k.short > 0 ? ` (${k.short} short — they are out)` : ''));
    }
  }
  if (cfg.attackgap !== undefined) {
    const a = attackAllowed(ctx, state, game);
    const g = parsers.attackgap.parse(cfg.attackgap);
    if (g.enabled) lines.push(`attackgap ${hhmmss(g.gapMs)}: ${a.ok ? 'clear to attack' : `hold ${hhmmss(a.waitMs)}`}`);
  }
  if (cfg.defensecooldown !== undefined) {
    const d = defenceAllowed(ctx, state, game);
    const g = parsers.defensecooldown.parse(cfg.defensecooldown);
    if (g.enabled) lines.push(`defensecooldown ${hhmmss(g.cooldownMs)}: ${d.ok ? 'ready' : `hold ${hhmmss(d.waitMs)}`}`);
  }
  if (cfg.nohealing !== undefined && !healingAllowed(ctx)) {
    lines.push('nohealing: wounded troops are left wounded (nothing in this bot heals yet, so nothing to suppress)');
  }

  return lines.length ? { note: lines.join(' | '), actions: [] } : null;
}

// Other modules ask this before moving troops out of a city.
function isWarTown(ctx) {
  const cfg = parsers.wartown.parse(ctx.config.wartown);
  return cfg.enabled ? cfg.mode : 0;
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
  async recallArmy(game, castle, a, state) {
    const r = await game.req('army.callBackArmy', { castleId: game.castleId(castle), armyId: a.armyId });
    if (state && r && r.ok === 1) {
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
        gs.lastDefenceAt = at;              // a gate flip is a defensive response
      }
    }
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
  if (cfg.wartown !== undefined) {
    const w = parsers.wartown.parse(cfg.wartown);
    out.push(w.enabled
      ? `wartown ${w.mode}: troop movement locked down, ${w.heroMayMove ? 'traininghero may still rotate' : 'traininghero stays put'}`
      : 'wartown: off');
  }
  if (cfg.keepatthome !== undefined) {
    const k = parsers.keepatthome.parse(cfg.keepatthome);
    out.push(k.enabled ? `keepatthome: ${k.keep} attack hero(es) stay in the city and are never sent farming` : 'keepatthome: off');
  }
  if (cfg.attackgap !== undefined) {
    const a = parsers.attackgap.parse(cfg.attackgap);
    out.push(a.enabled ? `attackgap: at least ${hhmmss(a.gapMs)} between outgoing attacks` : 'attackgap: off');
  }
  if (cfg.defensecooldown !== undefined) {
    const d = parsers.defensecooldown.parse(cfg.defensecooldown);
    out.push(d.enabled ? `defensecooldown: at least ${hhmmss(d.cooldownMs)} between defensive responses` : 'defensecooldown: off');
  }
  if (cfg.nohealing !== undefined) {
    out.push(parsers.nohealing.parse(cfg.nohealing).on ? 'nohealing: wounded troops are never healed' : 'nohealing: off');
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
  },
  executors,
  // integration helpers
  configKeys,
  describe,
  isWarTown,
  keepAttHome,
  attackAllowed, noteAttackSent,
  defenceAllowed, noteDefenceUsed,
  healingAllowed,
  // exported for the tests
  _internals: { durationMs, count, normalizeArmy, classify, threatsOf, buildHideMarch, gateBotChoice, hidingOptions, hhmmss, isAttackHero },
};
