'use strict';
// buildnpc — turn nearby flats into NPC camps, the NEAT way (wiki BuildNpc,
// NpcBuildPolicy, ValleyTroops, ValleyHeroes).
//
//   config buildnpc:<n>   1-5 build npcs of that level, 10 level 10, 15 levels 5
//                         and 10, 20 every flat; 0 off. A flat's level is the
//                         level of the npc that ends up on it (db.js tile_levels).
//   npcbuildpolicy /level:<n|a-b> /mindistance:<miles> /maxdistance:<miles>
//                         how far out each level is built (no max: min + 1);
//                         without one, distancepolicy's second number, else 10.
//
// The mechanic, read out of the 1922 client rather than guessed:
//   * a flat is taken like a valley, by an attack (army.newArmy missionType 5)
//     that wins while a field slot is free (goal-valley.js does the march:
//     ValleyTroops or the wiki's capture defaults, ValleyHeroes). The server
//     pushes server.CastleFieldUpdate and the flat is in castle.fields.
//   * FieldInfoWin.as offers "Build City" only on a flat you hold, and only
//     when isFitCondition (:1308-1315) holds: the city has 10,000 each of food,
//     wood, stone, iron and gold, and 250 workers, and the lord's title allows
//     another city; and no build march is already on its way (checkIsBuilding).
//     The button sends `city.constructCastle {castleId, fieldId, isTroopBack}`
//     (:1934), which founds the city.
//   * `city.giveupCastle {password, castleId}` abandons it, and the server later
//     re-seeds an NPC on the vacated tile.
//
// THE DANGER
// ----------
// giveupCastle is irreversible and takes the account password. A targeting slip
// destroys a real city. So abandoning is default-deny and gated on a persistent
// registry (db.city_registry) that records, BEFORE the city is founded, which
// exact fieldId we intend to create. Anything not in that registry as an
// own-built buildnpc city — a capture, a hand-built city, a city that simply
// appeared — is permanently protected, no matter how empty it looks.
//
// The claim goes into the registry at the founding, not at the capture: a flat
// we hold could otherwise be built on by hand (the Valleys tab's Build city
// button) and that city would be taken for ours. A claim that never became a
// city — the city never appeared, or an old one from before this flow — is
// let go (registry.markAbandoned, the state a flat we handed back has), so it
// no longer counts against /maxconcurrent: one failure used to stop buildnpc
// for good.
const C = require('./constants');
const D = require('./db');
const W = require('./goal-war');
const R = require('./rally');
const V = require('./goal-valley');

const n = (x) => Number(x || 0);
const fmt = (x) => Math.round(n(x)).toLocaleString('en-US');

// ---- defaults, all overridable from buildnpcpolicy ------------------------
const DEF = {
  distance: 10,          // tiles from the home city
  maxConcurrent: 1,      // flats being converted at once
  keepCities: 2,         // never take the account below this many cities
  maxRes: 5e6,           // refuse to abandon a city holding more than this
  maxTroops: 250,        // refuse to abandon a city holding more than this
  maxHeroes: 0,          // refuse to abandon a city with any hero in it
  minAgeMin: 5,          // must have existed this long (lets state settle)
  maxAgeHours: 24,       // and no longer than this — an old city is suspicious
  perDay: 4,             // hard ceiling on abandons per account per day
};

function NUM(v) {
  if (v === null || v === undefined || v === true) return null;
  const m = String(v).trim().match(/^([\d.]+)\s*([kmb])?$/i);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Number(m[1]) * mult;
}

function kv(tok) {
  const i = tok.indexOf(':');
  return i === -1 ? [tok, null] : [tok.slice(0, i), tok.slice(i + 1)];
}

// ------------------------------------------------------------------ parsers

const parsers = {
  // buildnpcpolicy /distance:10 /maxconcurrent:1 /keepcities:3 /maxres:5m
  //                /maxtroops:250 /minage:5 /maxage:24 /perday:4
  buildnpcpolicy: {
    kind: 'policy', multi: false,
    parse(args) {
      const errs = [];
      const sw = {};
      const known = new Set(['distance', 'maxconcurrent', 'keepcities', 'maxres',
        'maxtroops', 'maxheroes', 'minage', 'maxage', 'perday']);
      for (const tok of args) {
        if (!String(tok).startsWith('/')) { errs.push(`expected /switch:value, got "${tok}"`); continue; }
        const [k, v] = kv(String(tok).slice(1));
        const key = k.toLowerCase();
        if (!known.has(key)) { errs.push(`unknown switch "/${k}" — known: ${[...known].join(', ')}`); continue; }
        const num = NUM(v);
        if (num === null) { errs.push(`/${k} needs a number`); continue; }
        sw[key] = num;
      }
      return { switches: sw, errors: errs };
    },
  },

  // npcbuildpolicy /level:<n|a-b> /mindistance:<miles> /maxdistance:<miles>   wiki NpcBuildPolicy
  //     npcbuildpolicy /level:10 /mindistance:1 /maxdistance:5   level 10 npcs 1-5 miles out
  //     npcbuildpolicy /level:1-4 /mindistance:10 /maxdistance:20
  //   "If a maxdistance is not set, the bot defaults to mindistance + 1 mile."
  // OTTObot's older form still reads: npcbuildpolicy <level> <from>-<to>.
  //
  // A flat's LEVEL decides the level of the NPC that ends up on it, and an
  // unowned flat gains +1 at each daily maintenance. Only a flat AT a level
  // config buildnpc asks for is built on; acquireflats/abandonflats grow the rest.
  npcbuildpolicy: {
    kind: 'policy', multi: true,
    parse(args) {
      const errs = [];
      if (args.some((a) => String(a).startsWith('/'))) {
        let lo = null, hi = null, from = null, to = null;
        const miles = (v, what) => {
          const d = /^(\d+(\.\d+)?|\.\d+)$/.test(String(v == null ? '' : v)) ? parseFloat(v) : null;
          if (d === null) errs.push(`${what}:${v} — needs a number of miles`);
          return d;
        };
        for (const tok of args) {
          if (!String(tok).startsWith('/')) { errs.push(`expected /switch:value, got "${tok}"`); continue; }
          const [k, v] = kv(String(tok).slice(1));
          const key = k.toLowerCase();
          if (key === 'level') {
            const m = String(v == null ? '' : v).match(/^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/);
            const a = m ? Number(m[1]) : null, b = m ? Number(m[2] || m[1]) : null;
            if (a === null || a < 1 || b > 10 || b < a) { errs.push(`/level:${v} — a level 1-10, or a range like /level:1-4`); continue; }
            lo = a; hi = b;
          } else if (key === 'mindistance' || key === 'min') from = miles(v, `/${key}`);
          else if (key === 'maxdistance' || key === 'max') to = miles(v, `/${key}`);
          else errs.push(`unknown switch "/${k}" (known: /level /mindistance /maxdistance)`);
        }
        if (lo === null) errs.push('needs /level:<n> (or a range, /level:1-4)');
        if (from === null && to === null) errs.push('needs /mindistance or /maxdistance');
        if (from !== null && to === null) to = from + 1;          // the wiki's default
        if (from === null) from = 0;
        if (to !== null && to < from) { errs.push(`/mindistance ${from} is past /maxdistance ${to} — read the other way round`); [from, to] = [to, from]; }
        const levels = lo === null ? [] : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
        return { level: lo, levels, from, to, errors: errs };
      }
      const level = NUM(args[0]);
      if (level === null || level < 1 || level > 10) errs.push('expected /level:<n> /mindistance:<miles> /maxdistance:<miles>, e.g. npcbuildpolicy /level:10 /mindistance:1 /maxdistance:5');
      const range = String(args[1] || '').match(/^(\d+)\s*-\s*(\d+)$/);
      let from = 0, to = null;
      if (!range) errs.push('expected a tile range like 0-5 or 6-10');
      else {
        from = Number(range[1]); to = Number(range[2]);
        if (to < from) errs.push(`range ${from}-${to} runs backwards`);
      }
      return { level, levels: level !== null && level >= 1 && level <= 10 ? [level] : [], from, to, errors: errs };
    },
  },

  // config buildnpc:<n>, checked as the goals are read (goals.js runs a config
  // key's value through its config-kind parser): 0, 1-5, 10, 15 or 20.
  buildnpc: {
    kind: 'config', multi: false,
    parse(value) {
      const w = V.buildWanted({ buildnpc: value });
      return { value, errors: w.bad ? [w.bad.replace(/^config /, '')] : [] };
    },
  },

  // buildnpclist x,y x,y ...   — restrict building to exactly these flats
  buildnpclist: {
    kind: 'directive', multi: true,
    parse(args) {
      const errs = [];
      const coords = args.flatMap((t) => String(t).split(/\s+/)).map((t) => {
        const m = String(t).match(/^(\d+)\s*,\s*(\d+)$/);
        if (!m) { errs.push(`"${t}" is not an x,y coordinate`); return null; }
        return { x: Number(m[1]), y: Number(m[2]) };
      }).filter(Boolean);
      if (!coords.length) errs.push('needs at least one flat coordinate, e.g. buildnpclist 571,650');
      return { coords, errors: errs };
    },
  },
};

const configKeys = ['buildnpc'];

// --------------------------------------------------------------- the guard
//
// The single most important function in this file. Returns {ok:false, why} for
// anything it is not completely certain about.

function policyFor(ctx) {
  const g = (ctx.goals || []).find((x) => x.name === 'buildnpcpolicy');
  const sw = (g && g.switches) || {};
  const out = { ...DEF };
  for (const k of Object.keys(DEF)) {
    const alias = { maxConcurrent: 'maxconcurrent', keepCities: 'keepcities', maxRes: 'maxres',
      maxTroops: 'maxtroops', maxHeroes: 'maxheroes', minAgeMin: 'minage', maxAgeHours: 'maxage',
      perDay: 'perday', distance: 'distance' }[k] || k.toLowerCase();
    if (sw[alias] !== undefined) out[k] = sw[alias];
  }
  return out;
}

function cityTotals(castle) {
  const r = castle.resource || {};
  const res = n(r.food && r.food.amount) + n(r.wood && r.wood.amount)
    + n(r.stone && r.stone.amount) + n(r.iron && r.iron.amount) + n(r.gold);
  const troops = Object.values(castle.troop || {}).reduce((s, v) => s + n(v), 0);
  const heroes = (castle.heros || []).length;
  return { res, troops, heroes };
}

// accountId may be null (no Director row); that alone is disqualifying, because
// without it the registry cannot prove anything about this city.
function canAbandon({ accountId, game, castle, policy = DEF, now = Date.now(), abandonedToday = 0 }) {
  const why = (s) => ({ ok: false, why: s });
  const P = { ...DEF, ...policy };

  if (!accountId) return why('no account id — the registry cannot vouch for this city');
  if (!game || !castle) return why('no city to check');

  const castleId = Number(game.castleId(castle));
  const fieldId = Number(castle.fieldId);
  if (!Number.isFinite(fieldId)) return why('this city has no map position');

  // 1. the registry must say WE built it, on this exact tile
  const row = D.registry.get(accountId, fieldId);
  if (!row) return why(`no registry entry for field ${fieldId} — never abandon an unrecorded city`);
  if (row.origin !== 'buildnpc') return why(`registry says origin "${row.origin}" — only cities built by buildnpc may be abandoned`);
  if (!row.abandonable) return why('registry has this city marked not abandonable');
  if (row.state !== 'built') return why(`registry state is "${row.state}", expected "built"`);

  // 2. and it must still be the same city, on the same tile
  if (Number(row.castleId) !== castleId) {
    return why(`castle id mismatch (registry ${row.castleId}, live ${castleId}) — refusing on identity`);
  }
  // Cities can be teleported (city.advMoveCastle keeps the castleId and changes
  // the fieldId). A city that has moved is no longer obviously the throwaway we
  // built on a flat we picked, so the claim stops counting.
  if (n(row.moves) > 0) {
    return why(`this city has been teleported ${n(row.moves)} time(s) since it was built — the claim no longer stands`);
  }

  // 3. age window
  const ageMs = now - n(row.builtAt);
  if (ageMs < P.minAgeMin * 60000) {
    return why(`only ${Math.round(ageMs / 60000)}m old, waiting for ${P.minAgeMin}m`);
  }
  if (ageMs > P.maxAgeHours * 3600000) {
    return why(`${(ageMs / 3600000).toFixed(1)}h old, past the ${P.maxAgeHours}h window — leaving it alone`);
  }

  // 4. it must be empty
  const t = cityTotals(castle);
  if (t.heroes > P.maxHeroes) return why(`${t.heroes} hero(es) inside (max ${P.maxHeroes})`);
  if (t.troops > P.maxTroops) return why(`${fmt(t.troops)} troops inside (max ${fmt(P.maxTroops)})`);
  if (t.res > P.maxRes) return why(`${fmt(t.res)} resources inside (max ${fmt(P.maxRes)})`);

  // 5. never strand the account
  const cities = (game.castles || []).length;
  if (cities <= P.keepCities) return why(`only ${cities} city(ies) left, keeping at least ${P.keepCities}`);
  if (Number(game.castleId(game.castles[0])) === castleId) return why('this is the first/home city');

  // 6. rate limit
  if (abandonedToday >= P.perDay) return why(`already abandoned ${abandonedToday} today (max ${P.perDay})`);

  return {
    ok: true,
    why: `registered buildnpc city on field ${fieldId}, ${Math.round(ageMs / 60000)}m old, `
       + `${t.heroes} heroes / ${fmt(t.troops)} troops / ${fmt(t.res)} resources`,
    fieldId, castleId, totals: t, ageMs,
  };
}

// ------------------------------------------------------------------- plan

// The claim flow's clocks (OUR CHOICE; the wiki gives none):
const CAPTURE_WAIT_MS = 10 * 60000;    // after the capture march was last seen, the flat should be ours
const FOUND_WAIT_MS = 30 * 60000;      // after constructCastle (or its build march) was last seen, the city should stand
const FOUND_RETRY_MS = 10 * 60000;     // a refused constructCastle is asked again after this...
const FOUND_TRIES = 3;                 // ...this many times, then the claim is let go
const HELD_WAIT_MS = 24 * 3600000;     // a held flat whose founding never opens is not held for ever
const FAILED_COOLDOWN_MS = 6 * 3600000; // a flat a capture failed on is not tried again for this long
const ORPHAN_WAIT_MS = 3600000;        // a registry claim nothing explains is let go after this

// FieldInfoWin.as isFitCondition (:1308-1315): the founding city holds at
// least 10,000 each of wood, food, gold, stone and iron and 250 workers, and
// titleId >= the number of cities (city-build.js titleSlots). OUR CHOICE on top:
// a build already on its way counts as a city, since the client counts cities
// only and two builds could otherwise land over the limit.
const FOUND_RES = 10000;
const FOUND_WORKERS = 250;

function foundingGate(game, castle, book = null) {
  const res = (castle && castle.resource) || {};
  const have = {
    food: n(res.food && res.food.amount), wood: n(res.wood && res.wood.amount),
    stone: n(res.stone && res.stone.amount), iron: n(res.iron && res.iron.amount), gold: n(res.gold),
  };
  const why = [];
  const low = Object.entries(have).filter(([, v]) => v < FOUND_RES);
  if (low.length) why.push(`needs 10,000 ${low.map(([k]) => k).join(', ')} (has ${low.map(([k, v]) => `${fmt(v)} ${k}`).join(', ')})`);
  const sent = book ? n(book.committed(castle).troops.peasants) : 0;
  const workers = n((castle.troop || {}).peasants) - sent;
  if (workers < FOUND_WORKERS) why.push(`needs ${FOUND_WORKERS} workers (has ${fmt(workers)})`);
  const title = require('./city-build').titleSlots(game || { castles: [castle] });
  const armies = (game && game.player && game.player.selfArmys) || [];
  const building = armies.filter((a) => Number(a.missionType) === C.MISSION.construct && (Number(a.direction) || 1) === 1).length;
  if (title.title === null) why.push('the lord\'s title is not known, so neither is an open city slot');
  else if (title.open - building < 1) why.push(`no open city slot (the title allows ${title.max}, ${title.cities} cities${building ? ` and ${building} build(s) on the way` : ''})`);
  return { ok: !why.length, why: why.join('; ') };
}

// A registry claim that never became a city is let go, and only such a one:
// markAbandoned is called for a buildnpc row still pending-build, nothing else.
function expireClaim(accountId, fieldId) {
  const row = D.registry.get(accountId, fieldId);
  if (!row || row.origin !== 'buildnpc' || row.state !== 'pending-build') return false;
  D.registry.markAbandoned(accountId, fieldId);
  return true;
}

function buildNpcPlan(ctx, state, game) {
  const cfg = ctx.config || {};
  if (cfg.buildnpc === undefined || cfg.buildnpc === null || cfg.buildnpc === '') return null;   // off unless asked for
  const want = V.buildWanted(cfg);
  if (want.bad) return { note: `buildnpc — held: ${want.bad}`, actions: [] };
  if (!want.on) return null;

  // A war town stands the whole goal down: occupying a flat is an attack
  // march (wiki BuildNpc), which WarTownPolicy counts with the npc and valley
  // attacks it stops, and nothing irreversible — abandoning a city — is done
  // while the city is locked down for war. It picks up again once lifted.
  const war = W.lockdown(ctx);
  if (war.on) return { note: `buildnpc — standing down: ${war.why}`, actions: [] };

  const P = policyFor(ctx);
  const st = (state.buildnpc = state.buildnpc || {});
  st.abandons = Array.isArray(st.abandons) ? st.abandons.filter((t) => Date.now() - t < 86400000) : [];
  st.claims = st.claims && typeof st.claims === 'object' ? st.claims : {};
  st.failed = st.failed && typeof st.failed === 'object' ? st.failed : {};

  const accountId = ctx.accountId || null;
  const notes = [];
  const actions = [];

  if (!accountId) {
    return { note: 'buildnpc — no account id on the context, so the registry cannot be trusted; standing down', actions: [] };
  }

  const rows = D.registry.all(accountId);
  const built = rows.filter((r) => r.state === 'built');

  // ---- 1. anything of ours that is finished and safe to hand back?
  for (const c of game.castles || []) {
    const verdict = canAbandon({
      accountId, game, castle: c, policy: P, abandonedToday: st.abandons.length,
    });
    if (verdict.ok) {
      actions.push({
        kind: 'abandonCity',
        castleId: verdict.castleId, fieldId: verdict.fieldId,
        label: `abandon ${c.name} (field ${verdict.fieldId}) -> becomes a flat for an NPC: ${verdict.why}`,
      });
      Object.defineProperty(actions[actions.length - 1], 'state', { value: state, enumerable: false });
      break;                       // one at a time, always
    }
    // only explain the near-misses, not every protected city in the account
    const row = D.registry.get(accountId, Number(c.fieldId));
    if (row && row.origin === 'buildnpc' && row.state === 'built') notes.push(`${c.name}: ${verdict.why}`);
  }

  // ---- 2. the flats this city is working on: captured, founded, built or failed
  const now = n(ctx.now) || Date.now();
  const castle = ctx.castle || {};
  const book = ctx.rally || R.rallyBook({ game, armies: ctx.selfArmies || null, goalsOf: (c) => (c === castle ? ctx.goals : null) });
  const arriving = (id, mission) => book.arriving(id, mission).length > 0;
  const heldHere = new Map(V.heldFields(castle).map((f) => [f.id, f]));
  const heldBy = new Map();
  for (const c of game.castles || []) for (const f of V.heldFields(c)) heldBy.set(f.id, c);
  const cityAt = new Set((game.castles || []).map((c) => Number(c.fieldId)));
  const xy = (id) => { const p = C.fieldIdToCoords(Number(id)); return `${p.x},${p.y}`; };
  for (const [fid, at] of Object.entries(st.failed)) if (now - n(at) > FAILED_COOLDOWN_MS) delete st.failed[fid];

  for (const [id, cl] of Object.entries(st.claims)) {
    const fid = Number(id);
    if (cityAt.has(fid)) {
      const row = D.registry.get(accountId, fid);
      notes.push(row && row.state === 'built' ? `${xy(fid)}: the npc city stands (registry: built)` : `${xy(fid)}: a city stands there now, not recorded as ours — protected`);
      delete st.claims[id];
      continue;
    }
    if (cl.stage === 'capturing') {
      if (heldHere.has(fid)) { cl.stage = 'held'; cl.heldAt = now; }
      else if (heldBy.has(fid)) { notes.push(`${xy(fid)}: ${heldBy.get(fid).name} holds it — its own buildnpc founds it`); delete st.claims[id]; continue; }
      else if (arriving(fid, C.MISSION.attack)) { cl.seenAt = now; notes.push(`${xy(fid)}: the capture is on its way`); continue; }
      else if (now - Math.max(n(cl.sentAt), n(cl.seenAt)) > CAPTURE_WAIT_MS) {
        st.failed[fid] = now;
        delete st.claims[id];
        notes.push(`${xy(fid)}: the capture did not take the flat — it is not tried again for ${Math.round(FAILED_COOLDOWN_MS / 3600000)}h`);
        continue;
      } else { notes.push(`${xy(fid)}: capture sent, waiting for it to land`); continue; }
    }
    if (cl.stage === 'held') {
      if (!heldHere.has(fid)) { notes.push(`${xy(fid)}: no longer held — the claim is dropped`); delete st.claims[id]; continue; }
      if (now - n(cl.heldAt || cl.sentAt) > HELD_WAIT_MS) {
        notes.push(`${xy(fid)}: held ${Math.round(HELD_WAIT_MS / 3600000)}h and never founded — the claim is dropped (the flat stays held)`);
        st.failed[fid] = now;
        delete st.claims[id];
      }
      continue;
    }
    if (cl.stage === 'founding') {
      if (arriving(fid, C.MISSION.construct)) { cl.seenAt = now; notes.push(`${xy(fid)}: the city is being built`); continue; }
      if (now - Math.max(n(cl.foundAt), n(cl.seenAt)) > FOUND_WAIT_MS) {
        const let_ = expireClaim(accountId, fid);
        notes.push(`${xy(fid)}: founding sent ${Math.round((now - n(cl.foundAt)) / 60000)}m ago and no city stands there — the claim is let go${let_ ? ' (registry)' : ''}`);
        st.failed[fid] = now;
        delete st.claims[id];
        continue;
      }
      notes.push(`${xy(fid)}: founding sent, waiting for the city`);
    }
  }

  // ---- 3. registry claims nothing here explains: the old occupy flow's, or a
  // claim whose state was lost. One on a flat this city holds is founded; one
  // with nothing behind it (no flat held, no march on its way, no city on it)
  // is let go after an hour, so it stops counting against /maxconcurrent.
  for (const r of rows.filter((x) => x.state === 'pending-build' && x.origin === 'buildnpc')) {
    const fid = Number(r.fieldId);
    if (st.claims[fid]) continue;
    if (heldHere.has(fid)) {
      st.claims[fid] = { stage: 'held', heldAt: now, sentAt: now, level: heldHere.get(fid).level, adopted: true };
      notes.push(`${xy(fid)}: an earlier claim on a flat this city holds — it is founded when the founding opens`);
      continue;
    }
    if (heldBy.has(fid) || cityAt.has(fid) || arriving(fid, C.MISSION.attack) || arriving(fid, C.MISSION.construct)) continue;
    if (now - n(r.firstSeen) > ORPHAN_WAIT_MS && expireClaim(accountId, fid)) {
      notes.push(`${xy(fid)}: a claim from ${Math.round((now - n(r.firstSeen)) / 3600000)}h ago that never became a city — let go`);
    }
  }

  const pending = D.registry.all(accountId).filter((r) => r.state === 'pending-build');
  const claims = Object.entries(st.claims);
  const levelsText = want.all ? 'every level' : `L${want.levels.join('/')}`;

  // ---- 4. found a flat this city holds, once the founding is open
  const hold = V.holdAll(ctx, state);
  const toFound = claims.find(([, c]) => c.stage === 'held');
  if (!actions.length && toFound) {
    const [id, cl] = toFound;
    const gate = foundingGate(game, castle, book);
    if (hold) notes.push(`${xy(id)}: founding held — ${hold}`);
    else if (!gate.ok) notes.push(`${xy(id)}: founding waits — ${gate.why}`);
    else if (cl.triedAt && now - n(cl.triedAt) < FOUND_RETRY_MS) notes.push(`${xy(id)}: founding was refused (${cl.error || 'no reason given'}), asked again in ${Math.ceil((FOUND_RETRY_MS - (now - n(cl.triedAt))) / 60000)}m`);
    else {
      const p = C.fieldIdToCoords(Number(id));
      const action = {
        kind: 'foundCity', fieldId: Number(id), target: p, level: n(cl.level),
        label: `found a city on the flat at ${p.x},${p.y} L${n(cl.level)} (city.constructCastle), to hand back as a level ${n(cl.level)} npc`,
      };
      Object.defineProperty(action, 'state', { value: state, enumerable: false });
      Object.defineProperty(action, 'rally', {
        value: { from: castle, kind: 'b', missionType: C.MISSION.construct, targetFieldId: Number(id), troops: { peasants: FOUND_WORKERS } },
        enumerable: false,
      });
      actions.push(action);
    }
  }

  // ---- 5. start a new one? Registry claims (being founded) and built cities
  // count account-wide; this city's own captures count too.
  const own = claims.filter(([, c]) => c.stage === 'capturing' || c.stage === 'held').length;
  const inFlight = pending.length + built.length + own;
  if (!actions.length && inFlight >= P.maxConcurrent) {
    notes.push(`${inFlight}/${P.maxConcurrent} flat(s) already being converted`);
    const old = built.find((r) => now - n(r.builtAt) > P.maxAgeHours * 3600000);
    if (old) notes.push(`${xy(old.fieldId)} was built ${Math.round((now - n(old.builtAt)) / 3600000)}h ago, past the ${P.maxAgeHours}h window — it is left alone for good; abandon it by hand (or raise buildnpcpolicy /maxage) for buildnpc to go on`);
  } else if (!actions.length) {
    const home = V.homeOf(game, castle);
    const gate = foundingGate(game, castle, book);
    const only = (ctx.goals || []).filter((g) => g.name === 'buildnpclist')
      .flatMap((g) => g.coords || []).map((c) => C.coordsToFieldId(c.x, c.y));
    const onlySet = only.length ? new Set(only) : null;
    // every tile the registry knows, but a claim that was let go (abandoned: a
    // flat again, or an npc now) — its flat rests in st.failed, then may be tried again
    const claimed = new Set([...rows.filter((r) => r.state !== 'abandoned').map((r) => Number(r.fieldId)), ...claims.map(([id]) => Number(id))]);
    const excl = V.excludedIds(ctx);
    const inBand = (f, dist) => { const b = V.buildBand(ctx, f.level); return dist >= b.min && dist <= b.max; };
    // a flat this city already holds at a wanted level (acquireflats) is founded
    // without a march
    const mine = home ? [...heldHere.values()].filter((f) => f.kind === 'flat' && want.levels.includes(f.level) && !claimed.has(f.id)
      && !st.failed[f.id] && !excl.has(f.id) && (!onlySet || onlySet.has(f.id)) && inBand(f, C.mapDistance(home, f))) : [];
    if (hold) notes.push(`held: ${hold}`);
    else if (!home) notes.push('no map position for this city');
    else if (!gate.ok) notes.push(`no flat is captured until the city could found on it: ${gate.why}`);
    else if (mine.length) {
      const f = mine[0];
      st.claims[f.id] = { stage: 'held', heldAt: now, sentAt: now, level: f.level, x: f.x, y: f.y };
      notes.push(`${f.x},${f.y}: a held L${f.level} flat — founded next`);
    } else {
      const tiles = V.loadTiles(ctx);
      const st2 = V.vstate(state, now);
      const skip = V.busyTargets(ctx, castle, st2);
      for (const id of claimed) skip.add(id);
      for (const id of Object.keys(st.failed)) skip.add(Number(id));
      const cands = [];
      let stale = 0;
      for (const level of want.levels) {
        const band = V.buildBand(ctx, level);
        const pool = V.targetsIn(ctx, tiles.flats, home, { kinds: ['flat'], levels: [level], reach: band.max, minDist: band.min, skip });
        cands.push(...pool.list.filter((t) => !onlySet || onlySet.has(t.id)));
        stale += pool.stale;
      }
      cands.sort((a, b) => a.dist - b.dist || b.level - a.level || a.id - b.id);
      const target = cands[0];
      const slots = V.slotsOf(ctx, castle, st2, tiles);
      const reserve = n(cfg.hunting) > 0 ? 1 : 0;
      if (!target) notes.push(`no free ${levelsText} flat in range${onlySet ? ' (buildnpclist)' : ''}${stale ? ` — ${stale} waiting for a fresh map read` : ''}`);
      else if (slots.cap === null) notes.push('the Town Hall level is not known, so neither are the field slots');
      else if (slots.free - reserve <= 0) {
        notes.push(`no free field slot to capture ${target.x},${target.y} into (${slots.held.length}/${slots.cap} held${slots.flying.size ? `, ${slots.flying.size} capture(s) on the way` : ''}${reserve ? ', one kept for hunting' : ''})`);
      }
      else {
        const r = V.planAttack({ ctx, state, game, castle, home, st: st2, target, purpose: 'build', capture: true, rallyKind: 'b', table: V.CAPTURE_TROOPS, reserve, tag: 'buildnpc: ' });
        if (!r.action) notes.push(`waiting to capture ${target.x},${target.y} L${target.level}: ${r.why}`);
        else { r.action.kind = 'claimFlat'; actions.push(r.action); }
      }
    }
  }

  const head = `buildnpc ${levelsText} — ${actions.length ? actions[0].label : 'nothing to do'}`;
  return {
    note: [head, `${built.length} built, ${pending.length} being founded, ${own} captured or on the way, ${st.abandons.length}/${P.perDay} abandoned today`, ...notes].join(' | '),
    actions,
  };
}

// The bands from npcbuildpolicy, nearest ring first.
function bandsFor(ctx) {
  return (ctx.goals || [])
    .filter((g) => g.name === 'npcbuildpolicy' && g.level)
    .map((g) => ({ level: g.level, levels: Array.isArray(g.levels) && g.levels.length ? g.levels : [g.level], from: n(g.from), to: n(g.to) }))
    .sort((a, b) => a.from - b.from);
}

function bandAt(bands, dist) {
  return bands.find((b) => dist >= b.from && dist <= b.to) || null;
}

// Survey the flats around a city against the configured bands.
//
// A flat BELOW its band's target level is deliberately left alone: unowned, it
// gains +1 at the next maintenance, which is how it grows toward the target.
// Only a flat that has reached the target is a build candidate. A flat ABOVE the
// target has overshot and is reported rather than used.
function surveyFlats(accountId, home, bands, onlyIds) {
  const taken = new Set(D.registry.all(accountId).map((r) => Number(r.fieldId)));
  const want = onlyIds && onlyIds.length ? new Set(onlyIds) : null;
  const maxDist = bands.length ? Math.max(...bands.map((b) => b.to)) : 0;

  const out = { ready: [], growing: [], overshot: [], outside: 0 };
  for (const t of D.mapCache.flats()) {
    if (taken.has(Number(t.id))) continue;
    if (want && !want.has(Number(t.id))) continue;
    const dist = Math.hypot(n(t.x) - home.x, n(t.y) - home.y);
    if (dist <= 0 || dist > maxDist) { out.outside++; continue; }
    const band = bandAt(bands, dist);
    if (!band) { out.outside++; continue; }
    const lvl = n(t.level);
    const levels = band.levels || [band.level];
    const row = { ...t, dist, want: band.level, level: lvl };
    if (levels.includes(lvl)) out.ready.push(row);
    else if (lvl < Math.min(...levels)) out.growing.push(row);
    else out.overshot.push(row);
  }
  for (const k of ['ready', 'growing', 'overshot']) out[k].sort((a, b) => a.dist - b.dist);
  return out;
}

// Nearest unclaimed flat. With bands configured it must also be AT its band's
// target level; without them any flat inside `radius` will do.
function pickFlat(accountId, home, radius, onlyIds, bands) {
  if (bands && bands.length) return surveyFlats(accountId, home, bands, onlyIds).ready[0] || null;

  const taken = new Set(D.registry.all(accountId).map((r) => Number(r.fieldId)));
  const want = onlyIds && onlyIds.length ? new Set(onlyIds) : null;
  return D.mapCache.flats()
    .filter((t) => !taken.has(Number(t.id)))
    .filter((t) => !want || want.has(Number(t.id)))
    .map((t) => ({ ...t, dist: Math.hypot(n(t.x) - home.x, n(t.y) - home.y) }))
    .filter((t) => t.dist > 0 && t.dist <= radius)
    .sort((a, b) => a.dist - b.dist)[0] || null;
}

// -------------------------------------------------------------- executors

const executors = {
  // Capture the flat: an attack with ValleyTroops (or the wiki's defaults) and a
  // ValleyHeroes hero, sent by goal-valley's executor once the game has said
  // the flat is free and attackable and a field slot is free. Nothing goes into
  // the registry yet — that waits for the founding (see the header).
  async claimFlat(game, castle, action, state) {
    const accountId = (state && state.accountId) || (action && action.accountId);
    if (!accountId) return { ok: 0, errorMsg: 'no account id — refusing to claim' };
    state = state || action.state || {};
    const res = await V.executors.valleyAttack(game, castle, action, state);
    if (res && res.ok === 1) {
      const st = (state.buildnpc = state.buildnpc || {});
      st.claims = st.claims || {};
      st.claims[action.fieldId] = { stage: 'capturing', sentAt: Date.now(), level: n(action.level), x: action.target.x, y: action.target.y, heroId: action.heroId };
    }
    return res;
  },

  // Found the city (city.constructCastle, as the Build City button sends it).
  // Checked again against live state first: the flat is this city's and a
  // flat, the founding gate is open. Then the registry claim is written FIRST:
  // if we crash between it and the city appearing, the row stays pending-build
  // (and is let go later), and a city that turns up unrecorded is protected —
  // the safe direction to fail in. isTroopBack: any troops on the flat go home
  // rather than stay in a city that is to be handed back.
  async foundCity(game, castle, action, state) {
    const accountId = (state && state.accountId) || (action && action.accountId);
    if (!accountId) return { ok: 0, errorMsg: 'no account id — refusing to found' };
    state = state || action.state || {};
    const st = (state.buildnpc = state.buildnpc || {});
    st.claims = st.claims || {};
    st.failed = st.failed || {};
    const fieldId = Number(action.fieldId);
    const cl = st.claims[fieldId];
    if (!cl || cl.stage !== 'held') return { ok: 0, errorMsg: 'no held claim on that flat any more' };
    const f = V.heldFields(castle).find((x) => x.id === fieldId);
    if (!f || f.kind !== 'flat') return { ok: 0, errorMsg: 'that flat is not held by this city now' };
    const gate = foundingGate(game, castle);
    if (!gate.ok) return { ok: 0, errorMsg: `refused at the final check: ${gate.why}` };
    const cid = game.castleId(castle);
    const row = D.registry.claimFlat(accountId, fieldId, { x: f.x, y: f.y }, `buildnpc: founding from castle ${cid}`);
    if (!row || row.origin !== 'buildnpc' || row.state !== 'pending-build') {
      return { ok: 0, errorMsg: `the registry would not record the claim (${row ? `${row.origin}, ${row.state}` : 'no row'}) — refusing` };
    }
    const res = await game.constructCastle(cid, fieldId, true);
    if (res && res.ok === 1) {
      cl.stage = 'founding';
      cl.foundAt = Date.now();
      delete cl.error;
    } else {
      cl.tries = n(cl.tries) + 1;
      cl.triedAt = Date.now();
      cl.error = (res && res.errorMsg) || 'refused';
      if (cl.tries >= FOUND_TRIES) {
        expireClaim(accountId, fieldId);
        st.failed[fieldId] = Date.now();
        delete st.claims[fieldId];
      }
    }
    return res || { ok: 0, errorMsg: 'no answer' };
  },

  // The last gate. Re-runs the full guard against live state immediately before
  // sending, so a plan computed a minute ago cannot act on stale facts.
  async abandonCity(game, castle, action, state) {
    const accountId = (state && state.accountId) || (action && action.accountId);
    const target = (game.castles || []).find((c) => Number(game.castleId(c)) === Number(action.castleId));
    if (!target) return { ok: 0, errorMsg: 'that city is no longer in the account' };

    const st = (state && state.buildnpc) || {};
    const verdict = canAbandon({
      accountId, game, castle: target,
      abandonedToday: (st.abandons || []).length,
    });
    if (!verdict.ok) return { ok: 0, errorMsg: 'refused at the final check: ' + verdict.why };
    if (Number(verdict.fieldId) !== Number(action.fieldId)) {
      return { ok: 0, errorMsg: 'field id changed between planning and sending — refusing' };
    }

    const acc = D.accounts.get(accountId);
    if (!acc || !acc.password) return { ok: 0, errorMsg: 'no stored password for this account' };

    const res = await game.req('city.giveupCastle', { password: acc.password, castleId: verdict.castleId });
    if (res && res.ok === 1) {
      D.registry.markAbandoned(accountId, verdict.fieldId);
      st.abandons = st.abandons || [];
      st.abandons.push(Date.now());
    }
    return res;
  },
};

module.exports = {
  parsers,
  plans: { buildnpc: buildNpcPlan },
  executors,
  configKeys,
  _internals: {
    canAbandon, policyFor, cityTotals, pickFlat, surveyFlats, bandsFor, bandAt, DEF,
    foundingGate, expireClaim, FOUND_RES, FOUND_WORKERS,
    CAPTURE_WAIT_MS, FOUND_WAIT_MS, FOUND_RETRY_MS, FOUND_TRIES, HELD_WAIT_MS, FAILED_COOLDOWN_MS, ORPHAN_WAIT_MS,
  },
};
