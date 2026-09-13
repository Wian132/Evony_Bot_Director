'use strict';
// buildnpc — turn nearby flats into NPC camps.
//
// The mechanic, read out of the 1922 client rather than guessed:
//   * FieldInfoWin.as gates the build button on
//         isMineField && fieldType == TYPE_FLAT
//     so a flat must be OCCUPIED first — an army sent with missionType 4
//     (MISSION.construct) to the flat's fieldId.
//   * `city.constructCastle {castleId, fieldId, isTroopBack}` then founds the city.
//   * `city.giveupCastle {password, castleId}` abandons it, and the server later
//     re-seeds an NPC on the vacated tile.
//
// THE DANGER
// ----------
// giveupCastle is irreversible and takes the account password. A targeting slip
// destroys a real city. So abandoning is default-deny and gated on a persistent
// registry (db.city_registry) that records, BEFORE the build is attempted, which
// exact fieldId we intend to create. Anything not in that registry as an
// own-built buildnpc city — a capture, a hand-built city, a city that simply
// appeared — is permanently protected, no matter how empty it looks.
//
// UNVERIFIED: nothing in the client lets a player choose the LEVEL of the NPC
// that respawns, and no command for it exists. Level targeting is deliberately
// NOT offered here rather than shipped as a switch that quietly does nothing.
const C = require('./constants');
const D = require('./db');

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

  // npcbuildpolicy <level> <fromTiles>-<toTiles>   e.g.
  //     npcbuildpolicy 10 0-5          level 10 NPCs within 5 tiles
  //     npcbuildpolicy 5  6-10         level 5 NPCs in the 6-10 tile ring
  //
  // A flat's LEVEL decides the level of the NPC that ends up on it, and an
  // unowned flat gains +1 at each daily maintenance. So a band is a target: a
  // flat below its band's level is left alone to keep growing, and only one that
  // has reached the target is built on.
  npcbuildpolicy: {
    kind: 'policy', multi: true,
    parse(args) {
      const errs = [];
      const level = NUM(args[0]);
      if (level === null || level < 1 || level > 10) errs.push('expected a level 1-10, e.g. npcbuildpolicy 10 0-5');
      const range = String(args[1] || '').match(/^(\d+)\s*-\s*(\d+)$/);
      let from = 0, to = null;
      if (!range) errs.push('expected a tile range like 0-5 or 6-10');
      else {
        from = Number(range[1]); to = Number(range[2]);
        if (to < from) errs.push(`range ${from}-${to} runs backwards`);
      }
      return { level, from, to, errors: errs };
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

function buildNpcPlan(ctx, state, game) {
  const cfg = ctx.config || {};
  if (n(cfg.buildnpc) < 1) return null;              // off unless explicitly asked for

  const P = policyFor(ctx);
  const st = (state.buildnpc = state.buildnpc || {});
  st.abandons = Array.isArray(st.abandons) ? st.abandons.filter((t) => Date.now() - t < 86400000) : [];

  const accountId = ctx.accountId || null;
  const notes = [];
  const actions = [];

  if (!accountId) {
    return { note: 'buildnpc — no account id on the context, so the registry cannot be trusted; standing down', actions: [] };
  }

  const rows = D.registry.all(accountId);
  const pending = rows.filter((r) => r.state === 'pending-build');
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

  // ---- 2. start a new one?
  const inFlight = pending.length + built.length;
  if (!actions.length && inFlight < P.maxConcurrent) {
    const home = (game.castleXY && game.castleXY(ctx.castle)) || null;
    if (!home) notes.push('no map position for this city');
    else {
      const only = (ctx.goals || []).filter((g) => g.name === 'buildnpclist')
        .flatMap((g) => g.coords || []).map((c) => C.coordsToFieldId(c.x, c.y));
      const bands = bandsFor(ctx);
      if (bands.length) {
        const s = surveyFlats(accountId, home, bands, only);
        notes.push(bands.map((b) => `L${b.level}@${b.from}-${b.to}t`).join(' '));
        notes.push(`${s.ready.length} at target, ${s.growing.length} still levelling, ${s.overshot.length} overshot`);
      }
      const target = pickFlat(accountId, home, P.distance, only, bands);
      if (!target) notes.push(bands.length ? 'no flat has reached its target level yet' : `no free flat within ${P.distance} tiles`);
      else {
        actions.push({
          kind: 'claimFlat',
          fieldId: target.id, target: { x: target.x, y: target.y },
          distance: Math.round(target.dist * 10) / 10,
          level: n(target.level), wantLevel: target.want === undefined ? null : target.want,
          label: `occupy flat ${target.x},${target.y} L${n(target.level)} `
               + `(${Math.round(target.dist * 10) / 10} tiles) to build an NPC on`,
        });
        Object.defineProperty(actions[actions.length - 1], 'state', { value: state, enumerable: false });
      }
    }
  } else if (!actions.length) {
    notes.push(`${inFlight}/${P.maxConcurrent} flat(s) already being converted`);
  }

  const head = `buildnpc — ${actions.length ? actions[0].kind : 'nothing to do'}`;
  return {
    note: [head, `${built.length} built, ${pending.length} pending, ${st.abandons.length}/${P.perDay} abandoned today`, ...notes].join(' | '),
    actions,
  };
}

// The bands from npcbuildpolicy, nearest ring first.
function bandsFor(ctx) {
  return (ctx.goals || [])
    .filter((g) => g.name === 'npcbuildpolicy' && g.level)
    .map((g) => ({ level: g.level, from: n(g.from), to: n(g.to) }))
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
    const row = { ...t, dist, want: band.level, level: lvl };
    if (lvl === band.level) out.ready.push(row);
    else if (lvl < band.level) out.growing.push(row);
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
  // Occupy the flat. The registry claim is written FIRST: if the march lands and
  // we crash before recording, an unrecorded city is a protected city, which is
  // the safe direction to fail in.
  async claimFlat(game, castle, action, state) {
    const accountId = (state && state.accountId) || (action && action.accountId);
    if (!accountId) return { ok: 0, errorMsg: 'no account id — refusing to claim' };
    D.registry.claimFlat(accountId, action.fieldId, action.target, 'buildnpc: occupying');

    const hero = (castle.heros || []).find((h) => Number(h.status) === 0);
    const bean = game.buildArmyBean({
      missionType: C.MISSION.construct,
      heroId: hero ? hero.id : undefined,
      targetPoint: action.fieldId,
      troops: { peasants: 100 },
    });
    return game.newArmy(game.castleId(castle), bean);
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
  _internals: { canAbandon, policyFor, cityTotals, pickFlat, surveyFlats, bandsFor, bandAt, DEF },
};
