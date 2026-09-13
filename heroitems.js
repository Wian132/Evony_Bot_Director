'use strict';
// Hero items: the things you apply TO a hero rather than to a city.
//
//   hero.useItem {castleId, heroId, itemId}      (HeroCommand.as)
//
// The ids below come out of the decompiled client. The NAMES do not: the client
// ships its item catalogue as an XML asset, and `common.getItemDefXml` only
// returns items added after that build shipped — so asking the server for
// "which id is Excalibur" comes back empty. The names here are therefore the
// operator's, matched to the ids by what each one does.
//
// Because of that, every command also accepts the raw id, and `heroitems`
// prints what you actually hold. If a name here is wrong, the id still works.

// +25% to one attribute, permanently.
const ATTRIBUTE_ITEMS = {
  'hero.power.1': {
    names: ['excalibur', 'exc', 'attack', 'power'],
    label: 'Excalibur',
    effect: '+25% attack',
    attr: 'power',
  },
  'hero.management.1': {
    names: ['wealthofnations', 'wealth', 'won', 'politics', 'management', 'pol'],
    label: 'Wealth of Nations',
    effect: '+25% politics',
    attr: 'management',
  },
  'hero.intelligence.1': {
    names: ['intelligence', 'intel', 'int', 'stratagem', 'strat'],
    label: 'Intelligence tome',        // UNCONFIRMED NAME — the id is right
    effect: '+25% intelligence',
    attr: 'stratagem',
  },
};

// A percentage of the hero's experience, which is what makes levelling cheap.
//
// UNCONFIRMED: which of a/b/c is Anabasis, which is Epitome of Military Science
// and which is On Wars. They are ordered small -> large here, the usual
// convention for an a/b/c triple, and every one of them is accepted by name AND
// by id so a wrong guess costs nothing but a relabel.
const EXPERIENCE_ITEMS = {
  'player.experience.1.a': { names: ['anabasis', 'exp1', 'expsmall'], label: 'Anabasis', effect: 'hero experience (small)' },
  'player.experience.1.b': { names: ['epitome', 'epitomeofmilitaryscience', 'ems', 'exp2'], label: 'Epitome of Military Science', effect: 'hero experience (medium)' },
  'player.experience.1.c': { names: ['onwars', 'onwar', 'ow', 'exp3', 'explarge'], label: 'On Wars', effect: 'hero experience (large)' },
};

// Holy Water is named here so `useheroitem <hero> holy water` finds it, but it is
// never used through hero.useItem: the client resets with hero.resetPoint, and
// script.js hands it to waterhero (water-hero.js).
const OTHER_ITEMS = {
  'hero.reset.1': { names: ['holywater', 'water', 'reset', 'resetpoints', 'heroreset'], label: 'Holy Water', effect: 'resets attribute points — see waterhero' },
};

const ALL = { ...ATTRIBUTE_ITEMS, ...EXPERIENCE_ITEMS, ...OTHER_ITEMS };

// name or id -> id. Loyalty items (hero.loyalty.1..9) are accepted by id only.
function resolveItem(word) {
  const w = String(word || '').toLowerCase().replace(/[\s_'-]/g, '');
  if (!w) return null;
  if (ALL[word]) return word;                              // exact id
  for (const [id, def] of Object.entries(ALL)) {
    if (id.toLowerCase() === w) return id;
    if (def.names.includes(w)) return id;
    if (def.label.toLowerCase().replace(/[\s'-]/g, '') === w) return id;
  }
  // an id we do not have a friendly name for, e.g. hero.loyalty.4
  if (/^(hero|player|consume)\.[a-z0-9.]+$/i.test(word)) return word;
  return null;
}

const describeItem = (id) => (ALL[id] ? `${ALL[id].label} (${ALL[id].effect})` : id);

// Everything this account holds that can be applied to a hero.
function heldHeroItems(game) {
  const items = ((game.player && game.player.items) || [])
    .reduce((m, i) => { m[i.id] = Number(i.count || 0); return m; }, {});
  const rows = [];
  for (const [id, def] of Object.entries(ALL)) {
    if (items[id]) rows.push({ id, count: items[id], label: def.label, effect: def.effect });
  }
  for (const [id, count] of Object.entries(items)) {
    if (!ALL[id] && /^hero\./.test(id) && count) {
      rows.push({ id, count, label: id, effect: 'hero item' });
    }
  }
  return rows.sort((a, b) => b.count - a.count);
}

const countOf = (game, itemId) => {
  const it = ((game.player && game.player.items) || []).find((i) => i.id === itemId);
  return it ? Number(it.count || 0) : 0;
};

// Apply one item `times` times to a named hero.
//
// Stops early rather than pushing on when the hero cannot be found, the item
// runs out, or the server refuses — repeating a refused command is how an
// account gets throttled.
async function useOnHero(game, { heroName, itemId, times = 1, log = () => {} }) {
  if (itemId === 'hero.reset.1') {
    return { ok: false, used: 0, error: `Holy Water goes through hero.resetPoint, not hero.useItem — use  waterhero ${heroName || '<hero>'}` };
  }
  const wanted = String(heroName || '').toLowerCase();
  let castle = null, hero = null;
  for (const c of game.castles || []) {
    const h = (c.heros || []).find((x) => String(x.name || '').toLowerCase() === wanted);
    if (h) { castle = c; hero = h; break; }
  }
  if (!hero) return { ok: false, used: 0, error: `no hero called "${heroName}" in any city` };

  const have = countOf(game, itemId);
  if (!have) return { ok: false, used: 0, error: `no ${describeItem(itemId)} in the inventory` };
  const n = Math.min(times, have);
  if (n < times) log(`  only ${have} ${describeItem(itemId)} held — using ${n}`);

  // The attribute items do NOT move `power` — they set a timed percentage buff
  // in powerBuffAdded and add an entry to `buffs`. Watching only the base is why
  // a successful Excalibur looked like a no-op.
  const snap = (x) => ({
    power: Number(x.power || 0),
    management: Number(x.management || 0),
    stratagem: Number(x.stratagem || 0),
    experience: Number(x.experience || 0),
    powerBuff: Number(x.powerBuffAdded || 0),
    managementBuff: Number(x.managementBuffAdded || 0),
    stratagemBuff: Number(x.stratagemBuffAdded || 0),
    buffEnds: Math.max(0, ...((x.buffs || []).map((b) => Number(b.endTime || 0)))) || 0,
  });
  const before = snap(hero);

  let used = 0;
  for (let i = 0; i < n; i++) {
    const r = await game.req('hero.useItem', {
      castleId: game.castleId(castle), heroId: hero.id, itemId,
    });
    if (!r || r.ok !== 1) {
      return { ok: used > 0, used, before, hero: hero.name, castle: castle.name,
        error: (r && r.errorMsg) || `refused after ${used} use(s) (ok=${r && r.ok})` };
    }
    used++;
    // let the server's own update land before reading the hero again
    await new Promise((res) => setTimeout(res, 250));
  }

  // Give the server's own HeroUpdate time to land before reading the hero back.
  const fresh = (await game.heroAfter(castle, hero.id, 1500))
    || (castle.heros || []).find((x) => x.id === hero.id) || hero;
  return {
    ok: true, used, hero: hero.name, castle: castle.name, itemId,
    heldBefore: have, heldAfter: countOf(game, itemId),
    before,
    after: snap(fresh),
    buffs: (fresh.buffs || []).map((b) => ({ text: b.descName, endTime: Number(b.endTime || 0) })),
  };
}

module.exports = {
  ATTRIBUTE_ITEMS, EXPERIENCE_ITEMS, OTHER_ITEMS, ALL,
  resolveItem, describeItem, heldHeroItems, countOf, useOnHero,
};
