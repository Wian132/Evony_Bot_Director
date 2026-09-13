'use strict';
// The remaining goal evaluators. Each returns a plan: { note, actions: [...] }
// Actions are descriptors; the engine decides whether to execute or just report.
const fs = require('fs');
const path = require('path');
const C = require('./constants');

const n = (x) => Number(x || 0);

// ------------------------------------------------------------- comfortpolicy
// comfortpolicy <minMinutes> <maxMinutes> <mode>   e.g. "comfortpolicy 15 16 popraise"
// Fires interior.pacifyPeople on a jittered interval between min and max.
function comfortPlan(ctx, state) {
  const g = ctx.goals.find((x) => x.name === 'comfortpolicy');
  if (!g && ctx.config.comfort !== 1) return null;
  const mode = (g && g.mode) || 'popraise';
  const typeId = C.PACIFY[mode];
  if (!typeId) return { note: `comfort: unknown mode "${mode}"` };

  const minM = g ? g.everyMinMin : 15;
  const maxM = g ? g.everyMaxMin : 20;
  const last = n(state.lastComfort);
  // pick (and remember) a target gap so it isn't perfectly periodic
  if (!state.comfortGapMs) state.comfortGapMs = (minM + Math.random() * Math.max(0, maxM - minM)) * 60000;
  const due = last + state.comfortGapMs;
  const waitMs = due - Date.now();
  if (last && waitMs > 0) return { note: `comfort (${mode}): next in ${Math.ceil(waitMs / 60000)} min` };

  return {
    note: `comfort (${mode}): due now`,
    actions: [{ kind: 'pacify', typeId, mode, label: `comfort: ${mode}` }],
  };
}

// ------------------------------------------------------------- defensepolicy
// /usetruce:<loyalty> /usespeech:<loyalty> fire on LOYALTY thresholds.
// /usewarhorn /usecorselet /usepenicillin fire when a NON-JUNK attack is inbound.
// /junktroop:<n> -- attacks smaller than this are ignored entirely.
function defensePlan(ctx, state) {
  const g = ctx.goals.find((x) => x.name === 'defensepolicy');
  if (!g) return null;
  const sw = g.switches || {};
  const junk = n(sw.junktroop) || 1000;
  const loyalty = n((ctx.castle.resource || {}).support);
  // An unscouted army reports "?" per troop type, so its size is UNKNOWN rather
  // than zero. Treat unknown as a real threat — assuming junk would be the
  // dangerous default.
  const incoming = (ctx.incoming || []).filter((a) => a.troops === null || a.troops === undefined || n(a.troops) >= junk);
  const actions = [];
  const cool = (key, ms) => {
    const k = 'def_' + key;
    if (Date.now() - n(state[k]) < ms) return false;
    state[k] = Date.now(); return true;
  };

  // loyalty-triggered items
  if (sw.usetruce !== undefined && loyalty <= n(sw.usetruce) && cool('truce', 10 * 60000)) {
    actions.push({ kind: 'useItem', itemId: C.DEFENSE_ITEMS.truce, label: `truce agreement (loyalty ${loyalty} <= ${sw.usetruce})` });
  }
  if (sw.usespeech !== undefined && loyalty <= n(sw.usespeech) && cool('speech', 5 * 60000)) {
    actions.push({ kind: 'useItem', itemId: C.DEFENSE_ITEMS.speech, label: `speech text (loyalty ${loyalty} <= ${sw.usespeech})` });
  }

  // attack-triggered items
  if (incoming.length) {
    const pairs = [['usewarhorn', 'warhorn'], ['useivoryhorn', 'ivoryhorn'], ['usecorselet', 'corselet'],
                   ['useultracorselet', 'ultracorselet'], ['usepenicillin', 'penicillin']];
    for (const [flag, item] of pairs) {
      if (n(sw[flag]) === 1 && cool(item, 30 * 60000)) {
        actions.push({ kind: 'useItem', itemId: C.DEFENSE_ITEMS[item], label: `${item} (under attack)` });
      }
    }
  }

  const note = `defense: loyalty ${loyalty}, ${incoming.length} real attack(s) inbound` +
    (ctx.incoming && ctx.incoming.length > incoming.length ? ` (${ctx.incoming.length - incoming.length} junk ignored)` : '');
  return { note, actions };
}

// requestresources / requesttroops moved to goal-transfer.js: nearest sender,
// arrivals counted, one march per sender, and the rally spot honoured.

// --------------------------------------------------------------- npc farming
// NOTE: npcPlan used to live here as a stub reading mapcache.json directly.
// goal-npc.js supersedes it (levels, cycles, npclimits, troop sizing) and is
// what the engine actually calls, so the stub was removed rather than ported.

// --------------------------------------------------------------------- mayor
// The mayor's stats drive the city: POLITICS speeds resource production and
// construction, ATTACK speeds troop training. So:
//   default            -> best politics hero
//   about to train     -> best attack hero
//   about to build     -> best politics hero
// Swapping costs two commands, so only swap when the desired hero actually differs.
function mayorPlan(ctx, intent) {
  if (ctx.config.hero === 0) return null;
  const heroes = (ctx.castle.heros || []);
  if (!heroes.length) return { note: 'mayor: no heroes in this city' };

  // The attribute field already includes allocated points (HeroProperties.as shows
  // h.power directly), so adding *Added here would double-count.
  const val = (h, k) => n(h[k]);
  const bestBy = (k) => heroes.slice().sort((a, b) => val(b, k) - val(a, k))[0];

  const wantAttack = intent === 'train';
  const want = wantAttack ? bestBy('power') : bestBy('management');
  if (!want) return null;

  // HeroConstants.as: 1 = chief (mayor). 2 is GARRISON, not mayor.
  const current = heroes.find((h) => Number(h.status) === 1);
  const why = wantAttack ? 'training troops' : (intent === 'build' ? 'building' : 'resource production');

  if (current && current.id === want.id) {
    return { note: `mayor: ${current.name} already set for ${why}` };
  }
  return {
    note: `mayor: want ${want.name} (${wantAttack ? 'atk ' + val(want, 'power') : 'pol ' + val(want, 'management')}) for ${why}` +
          (current ? `, currently ${current.name}` : ', currently none'),
    actions: [{ kind: 'setMayor', hero: want, hadMayor: !!current, label: `appoint ${want.name} as mayor (${why})` }],
  };
}

// ------------------------------------------------------------- traininghero
// Cross-city: the named hero rotates through every city that lists it.
// Leaves once minStay has elapsed AND (maxStay passed OR npcHits done).
// Moving = discharge as mayor -> reinforce march to the next city -> re-appoint.
function trainingHeroPlan(game, cityGoals, state) {
  const wanted = new Map();     // heroName -> [castle, ...]
  for (const { castle, parsed } of cityGoals) {
    for (const g of parsed.goals.filter((x) => x.name === 'traininghero')) {
      const key = String(g.hero).toLowerCase();
      if (!wanted.has(key)) wanted.set(key, { goal: g, cities: [] });
      wanted.get(key).cities.push(castle);
    }
  }
  const plans = [];
  for (const [key, { goal, cities }] of wanted) {
    const holder = game.castles.find((c) => (c.heros || []).some((h) => (h.name || '').toLowerCase() === key));
    if (!holder) { plans.push({ hero: goal.hero, note: `traininghero ${goal.hero}: not found in any city yet` }); continue; }
    if (cities.length < 2) {
      plans.push({ hero: goal.hero, note: `traininghero ${goal.hero}: parked in ${holder.name} (only one city wants it, so no rotation)` });
      continue;
    }
    const st = (state.hero = state.hero || {});
    const rec = (st[key] = st[key] || { since: Date.now(), at: game.castleId(holder), npcHits: 0 });
    if (rec.at !== game.castleId(holder)) { rec.at = game.castleId(holder); rec.since = Date.now(); rec.npcHits = 0; }

    const stayed = (Date.now() - rec.since) / 1000;
    const minOk = stayed >= n(goal.minStaySec);
    const maxOk = goal.maxStaySec ? stayed >= n(goal.maxStaySec) : false;
    const hitsOk = goal.npcHits ? rec.npcHits >= n(goal.npcHits) : false;
    if (!minOk || !(maxOk || hitsOk || !goal.maxStaySec)) {
      plans.push({ hero: goal.hero, note: `traininghero ${goal.hero}: in ${holder.name} for ${Math.round(stayed)}s (min ${goal.minStaySec}s)` });
      continue;
    }
    const idx = cities.findIndex((c) => game.castleId(c) === game.castleId(holder));
    const next = cities[(idx + 1) % cities.length];
    if (game.castleId(next) === game.castleId(holder)) { plans.push({ hero: goal.hero, note: `traininghero ${goal.hero}: nowhere else to go` }); continue; }
    plans.push({
      hero: goal.hero, note: `traininghero ${goal.hero}: ${holder.name} -> ${next.name} after ${Math.round(stayed)}s`,
      actions: [{ kind: 'moveHero', heroName: goal.hero, from: holder, to: next, label: `move ${goal.hero} to ${next.name}` }],
    });
  }
  return plans;
}

module.exports = { comfortPlan, defensePlan, trainingHeroPlan, mayorPlan };
