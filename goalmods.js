'use strict';
// The remaining goal evaluators. Each returns a plan: { note, actions: [...] }
// Actions are descriptors; the engine decides whether to execute or just report.
const fs = require('fs');
const path = require('path');
const C = require('./constants');
const W = require('./goal-war');

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
// defensepolicy [/junktroop:n] [/usetruce:loyalty] [/usespeech:loyalty]
//               [/usewarhorn /useivoryhorn /usecorselet /useultracorselet /usepenicillin :0|1]
// As the NEAT wiki has it (DefensePolicy, DefenseCooldown):
//   /junktroop   an attack under this many troops is junk and sets nothing off
//                (default 1000; /junktroop:0 makes every attack count).
//   /usetruce    a Truce Agreement, and /usespeech a Speech Text, once this city's
//                loyalty is at or below the value WHILE it is under attack.
//   the horns, corselets and Penicillin are used while under attack (default off).
// "Under attack" is a real attack marching at this city, or one that landed or
// was recalled less than `config defensecooldown` minutes ago (NEAT's default
// 30) — the one window every goal shares, kept by goal-war.js underAttack. The
// truce needs that window: the game will not truce while any army is
// marching at you (the item's own text), so it can only go in the gap after a
// wave lands.
//
// Every item but Speech Text works on the whole account (the truce status, and
// player buffs for the rest), so one city using it covers them all: a second
// city sees the first one's use through game.itemUses and the buff list, and
// does not send another. Nothing is used that is not held, nothing whose buff
// is already running, and a use only counts once the server has said ok — the
// engine's executor stamps state.defence.used, never this plan.
const DEF_JUNK = 1000;
const DEF_RETRY_MS = 2 * 60000;        // after a refusal or a lost reply
const DEF_SPEECH_MS = 2 * 60000;       // after a Speech Text, until the city shows loyalty 100
const DEF_BUFF_GROUPS = [              // items that make the same buff: the first held is used
  [['usewarhorn', 'warhorn'], ['useivoryhorn', 'ivoryhorn']],
  [['usecorselet', 'corselet'], ['useultracorselet', 'ultracorselet']],
  [['usepenicillin', 'penicillin']],
];

// An inbound army's size, from the engine's flat total or a raw TroopStrBean.
// An unscouted army sends "?" per type, so its size is UNKNOWN (null), and
// unknown counts as a real threat — assuming junk would be the dangerous default.
function armySize(a) {
  if (!a) return null;
  const t = a.troops !== undefined ? a.troops : a.troop;
  if (t === null || t === undefined) return null;
  if (typeof t === 'object') {
    let sum = 0, any = false;
    for (const v of Object.values(t)) {
      const s = String(v ?? '').trim().replace(/[,\s]/g, '');
      if (/^\d+$/.test(s)) { sum += parseInt(s, 10); any = true; } else if (v !== undefined && v !== null) return null;
    }
    return any ? sum : null;
  }
  if (a.known === false) return null;   // a partial total: some types were "?"
  const s = String(t).trim().replace(/[,\s]/g, '');
  return /^\d+$/.test(s) ? parseInt(s, 10) : null;
}

// How many of an item the account holds; null when no inventory was loaded.
function heldCount(game, itemId) {
  const items = game && game.player && game.player.items;
  if (!Array.isArray(items)) return null;
  const it = items.find((i) => i && i.id === itemId);
  return it ? Number(it.count || 0) : 0;
}

// The longest-running player buff of these typeIds: an object while one runs,
// false when none does, null when the session holds no buff list at all.
// (The client itself compares 'PlayerPeaceCoolDownBuff ' with a trailing
// space — PlayerInfoWin.as:1698 — so ids are trimmed.)
function runningBuff(game, typeIds, serverNow) {
  const list = game && game.player && game.player.buffs;
  if (!Array.isArray(list)) return null;
  let best = false;
  for (const b of list) {
    if (!b || !typeIds.includes(String(b.typeId || '').trim())) continue;
    const end = Number(b.endTime || 0);
    if (end && end <= serverNow) continue;          // expired; the delete push is late
    if (!best || (best.end && (!end || end > best.end))) best = { typeId: String(b.typeId).trim(), end: end || null };
  }
  return best;
}

// "40 s", "25 min", "3 h 5 min" — to the nearest unit
const span = (ms) => {
  const mins = Math.round(Math.max(0, ms) / 60000);
  if (mins >= 60) return `${Math.floor(mins / 60)} h ${mins % 60} min`;
  if (ms >= 59500) return `${mins} min`;
  return `${Math.max(1, Math.round(Math.max(0, ms) / 1000))} s`;
};

function defensePlan(ctx, state) {
  const g = ctx.goals.find((x) => x.name === 'defensepolicy');
  if (!g) return null;
  const sw = g.switches || {};
  const game = ctx.game || {};
  const now = Date.now();
  const serverNow = typeof game.now === 'function' ? game.now() : now;
  const junk = sw.junktroop !== undefined ? n(sw.junktroop) : DEF_JUNK;
  const sup = (ctx.castle.resource || {}).support;
  // No loyalty on the castle bean is "unknown", never 0 — 0 would fire the truce.
  const loyalty = sup === undefined || sup === null || sup === '' || !isFinite(Number(sup)) ? null : Number(sup);

  // The old plan stamped def_<item> when it PLANNED a use, sent or not. Those
  // stamps mean nothing now; uses live in state.defence.used.
  for (const k of ['truce', 'speech', 'warhorn', 'ivoryhorn', 'corselet', 'ultracorselet', 'penicillin']) delete state['def_' + k];
  const def = (state.defence = state.defence || {});
  const used = (def.used = def.used || {});

  // Armies marching at this city, less any whose landing time is long past.
  const fresh = (ctx.incoming || []).filter((a) => {
    const rt = Number(a && a.reachTime);
    return !(rt > 1e12 && rt < serverNow - 60000);
  });
  const real = fresh.filter((a) => { const s = armySize(a); return s === null || s >= junk; });
  // NEAT's DefenseCooldown window, the same one every goal reads (goal-war.js
  // underAttack): it starts when the wave lands or is recalled, not when it
  // was last seen marching. A defence.attackSeen left in saved state by an
  // earlier build means nothing now.
  delete def.attackSeen;
  const win = W.underAttack(ctx, state);
  const underAttack = win.on;

  // Armies marching at ANY of the account's cities: the game refuses a truce
  // while there are any, junk included — it knows nothing of /junktroop.
  const cid = game.castleId ? String(game.castleId(ctx.castle)) : null;
  const elsewhere = Object.entries(ctx.incomingByCastle || {})
    .filter(([k]) => k !== cid).reduce((s, [, v]) => s + n(v), 0);
  const atAccount = fresh.length + elsewhere;

  const uses = game.itemUses || {};
  const truceUse = C.DEFENSE_ITEM_USE[C.DEFENSE_ITEMS.truce];
  const truced = runningBuff(game, truceUse.buffs, serverNow);
  const notes = [], actions = [];
  const info = (key) => ({ key, id: C.DEFENSE_ITEMS[key], use: C.DEFENSE_ITEM_USE[C.DEFENSE_ITEMS[key]] });
  // The last ok for an item: this city's own stamp, or anyone's on the account.
  const lastOk = (it) => {
    const u = uses[it.id];
    const acct = u && u.ok === 1 && (it.use.scope === 'account' || String(u.castleId) === cid) ? n(u.at) : 0;
    return Math.max(n(used[it.key]), acct);
  };
  // After an ok, the same item is not used again for as long as it runs, even
  // if the buff push never comes: a second horn on a running horn is wasted.
  // (The buff list covers what this session did not send, and restarts.)
  const okGuard = (it) => (it.key === 'speech' ? DEF_SPEECH_MS : it.use.lastsMs);
  const refused = (it) => {
    const u = uses[it.id];
    if (!u || u.ok === 1 || now - n(u.at) >= DEF_RETRY_MS) return null;
    return it.use.scope === 'account' || String(u.castleId) === cid ? u : null;
  };
  // " from <city>" when another city sent it
  const fromCity = (u) => {
    if (!u || String(u.castleId) === cid) return '';
    const c = (game.castles || []).find((x) => game.castleId && String(game.castleId(x)) === String(u.castleId));
    return ` from ${(c && c.name) || `city ${u.castleId}`}`;
  };
  const refusedNote = (it, u) => `${it.use.name}${fromCity(u)} ${u.ok === null ? 'got no reply' : `was refused (${u.errorMsg || 'no reason given'})`} `
    + `${span(now - n(u.at))} ago, trying again in ${span(DEF_RETRY_MS - (now - n(u.at)))}`;
  const lacking = (it) => (heldCount(game, it.id) === null ? 'the inventory has not loaded' : `no ${it.use.name} is held`);

  // ---- Truce Agreement: the whole account, 12 hours
  let trucing = false;
  if (sw.usetruce !== undefined) {
    const t = info('truce');
    const low = loyalty !== null && loyalty <= sw.usetruce;
    const cool = runningBuff(game, C.TRUCE_COOLDOWN_BUFFS, serverNow);
    const last = lastOk(t);
    if (truced) notes.push(`truce: the account is in truce${truced.end ? ` for another ${span(truced.end - serverNow)}` : ''}`);
    else if (loyalty === null) notes.push('truce: loyalty unknown');
    else if (!low) { /* nothing to say: loyalty is above the line */ }
    else if (!underAttack) notes.push(`truce: loyalty ${loyalty} <= ${sw.usetruce}, but not under attack`);
    else if (cool) notes.push(`truce: in truce cooldown${cool.end ? ` for another ${span(cool.end - serverNow)}` : ''}, the game allows no new truce`);
    else if (last && now - last < okGuard(t)) {
      const u = uses[t.id];
      notes.push(`truce: a Truce Agreement went out ${span(now - last)} ago${u && u.ok === 1 ? fromCity(u) : ''} and covers every city`);
    } else if (refused(t)) notes.push('truce: ' + refusedNote(t, refused(t)));
    else if (!(heldCount(game, t.id) > 0)) notes.push(`truce: loyalty ${loyalty} <= ${sw.usetruce}, but ${lacking(t)}`);
    else if (atAccount > 0) {
      notes.push(`truce: loyalty ${loyalty} <= ${sw.usetruce}, held while ${atAccount} army(ies) march at the account — `
        + 'the game refuses a truce until none do, so it goes in the first gap');
    } else {
      trucing = true;
      const mine = (ctx.selfArmies || []).length;
      notes.push('truce: using one — it covers every city for 12 h, so no other city sends another'
        + (mine ? `; ${mine} of our own march(es) are out, and the item text says the game refuses a truce then` : ''));
      actions.push({ kind: 'defenceItem', item: t.key, itemId: t.id, scope: 'account',
        label: `Truce Agreement for the whole account (loyalty ${loyalty} <= ${sw.usetruce})` });
    }
  }

  // ---- Speech Text: this city's loyalty back to 100
  if (sw.usespeech !== undefined) {
    const t = info('speech');
    const last = lastOk(t);
    if (loyalty === null) notes.push('speech: loyalty unknown');
    else if (loyalty > sw.usespeech) { /* above the line */ }
    else if (!underAttack) notes.push(`speech: loyalty ${loyalty} <= ${sw.usespeech}, but not under attack`);
    else if (truced) notes.push('speech: not needed, no attack can land in truce');
    else if (last && now - last < okGuard(t)) notes.push(`speech: one went out ${span(now - last)} ago`);
    else if (refused(t)) notes.push('speech: ' + refusedNote(t, refused(t)));
    else if (!(heldCount(game, t.id) > 0)) notes.push(`speech: loyalty ${loyalty} <= ${sw.usespeech}, but ${lacking(t)}`);
    else {
      actions.push({ kind: 'defenceItem', item: t.key, itemId: t.id, scope: 'city',
        label: `Speech Text (loyalty ${loyalty} <= ${sw.usespeech})` });
    }
  }

  // ---- horns, corselets, Penicillin: account buffs, while under attack
  const waiting = [];
  for (const group of DEF_BUFF_GROUPS) {
    const on = group.filter(([flag]) => n(sw[flag]) === 1).map(([, key]) => info(key));
    if (!on.length || !underAttack) continue;
    const names = on.map((it) => it.use.name).join('/');
    const running = runningBuff(game, on[0].use.buffs, serverNow);
    const recent = on.map((it) => ({ it, at: lastOk(it) })).find(({ it, at }) => at && now - at < okGuard(it));
    const no = on.map((it) => ({ it, u: refused(it) })).find((x) => x.u);
    if (truced || trucing) waiting.push(names);
    else if (running) notes.push(`${names}: already running${running.end ? ` for another ${span(running.end - serverNow)}` : ''}`);
    else if (recent) notes.push(`${recent.it.use.name}: went out ${span(now - recent.at)} ago`);
    else if (no) notes.push(refusedNote(no.it, no.u));
    else {
      const pick = on.find((it) => heldCount(game, it.id) > 0);
      if (!pick) notes.push(`${names}: ${on.map(lacking).filter((x, i, a) => a.indexOf(x) === i).join(', ')}`);
      else actions.push({ kind: 'defenceItem', item: pick.key, itemId: pick.id, scope: 'account', label: `${pick.use.name} (under attack)` });
    }
  }
  // A truce stops every attack, so a buff used beside it would be wasted.
  if (waiting.length) {
    notes.push(`${waiting.join(', ')}: ${truced ? 'not needed, no attack can land in truce' : 'waiting to see whether the truce takes'}`);
  }

  const jn = fresh.length - real.length;
  const head = `defense: loyalty ${loyalty === null ? '?' : loyalty}, ${real.length} real attack(s) inbound`
    + (jn ? ` (${jn} junk under ${junk} ignored)` : '')
    + (!real.length && underAttack ? `; under attack for another ${span(win.leftMs)} (defensecooldown)` : '');
  return { note: [head, ...notes].join('; '), actions };
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
