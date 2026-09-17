'use strict';
// Hero items: the things you apply TO a hero rather than to a city.
//
//   hero.useItem {castleId, heroId, itemId}      (HeroCommand.as)
//
// The ids come out of the decompiled client; the names and effects come out of
// the item catalogue extracted from WarReport.swf (itemcatalog.json), which is
// the client's own wording — `common.getItemDefXml` only returns items added
// after that build shipped, so the server itself never names these.
//
// Every command also accepts the raw id, so an id the catalogue does not name
// still works, and `heroitems` prints what you actually hold.

// +25% to one attribute for 7 days. It is a TIMED BUFF, not a permanent gain:
// it lands in powerBuffAdded / managementBuffAdded / stratagemBuffAdded and adds
// an entry to the hero's `buffs`, and the base attribute never moves.
const ATTRIBUTE_ITEMS = {
  'hero.power.1': {
    names: ['excalibur', 'exc', 'excal', 'attack', 'power'],
    label: 'Excalibur',
    effect: '+25% attack for 7 days',
    attr: 'power',
  },
  'hero.management.1': {
    names: ['wealthofnations', 'thewealthofnations', 'wealth', 'won', 'politics', 'management', 'pol'],
    label: 'The Wealth of Nations',
    effect: '+25% politics for 7 days',
    attr: 'management',
  },
  'hero.intelligence.1': {
    names: ['artofwar', 'theartofwar', 'aow', 'intelligence', 'intel', 'int', 'stratagem', 'strat'],
    label: 'The Art of War',
    effect: '+25% intelligence for 7 days',
    attr: 'stratagem',
  },
};

// Experience, which is what makes levelling cheap: a flat figure or a share of
// the level cap, whichever is greater. a/b/c really do run small -> large.
const EXPERIENCE_ITEMS = {
  'player.experience.1.a': { names: ['anabasis', 'exp1', 'expsmall'], label: 'Anabasis', effect: '+1,000 experience or 8% of the level cap' },
  'player.experience.1.b': { names: ['epitome', 'epitomeofmilitaryscience', 'ems', 'exp2'], label: 'Epitome of Military Science', effect: '+10,000 experience or 30% of the level cap' },
  'player.experience.1.c': { names: ['onwar', 'onwars', 'ow', 'exp3', 'explarge'], label: 'On War', effect: '+100,000 experience or 100% of the level cap' },
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

// Everything this account holds that can be applied to a hero. Ids ALL does not
// name (the nine loyalty medals, and anything the game adds later) are named
// from the item catalogue when it has them, and by their id when it does not.
function heldHeroItems(game) {
  const items = ((game.player && game.player.items) || [])
    .reduce((m, i) => { m[i.id] = Number(i.count || 0); return m; }, {});
  const rows = [];
  for (const [id, def] of Object.entries(ALL)) {
    if (items[id]) rows.push({ id, count: items[id], label: def.label, effect: def.effect });
  }
  let cat = null;
  for (const [id, count] of Object.entries(items)) {
    if (!ALL[id] && /^hero\./.test(id) && count) {
      if (!cat) { try { cat = require('./items').catalogue(); } catch { cat = new Map(); } }
      const d = cat.get(id) || {};
      rows.push({ id, count, label: d.name || require('./items').MEDALS[id] || id, effect: d.desc || 'hero item' });
    }
  }
  return rows.sort((a, b) => b.count - a.count);
}

// The rows the console's hero-item window offers. The three attribute items come
// first and always, even at zero, so the window says outright that none is held
// rather than leaving a gap; then everything else held that hero.useItem takes.
// Holy Water is left out: it does not go through hero.useItem at all, and the
// hero row has its own Reset button for it.
function heroItemChoices(game) {
  const rows = Object.entries(ATTRIBUTE_ITEMS).map(([id, def]) => ({
    id, count: countOf(game, id), label: def.label, effect: def.effect, attr: def.attr,
  }));
  for (const r of heldHeroItems(game)) {
    if (!ATTRIBUTE_ITEMS[r.id] && r.id !== 'hero.reset.1') rows.push(r);
  }
  return rows;
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
async function useOnHero(game, { heroName, heroId, castleId, itemId, times = 1, log = () => {} }) {
  if (itemId === 'hero.reset.1') {
    return { ok: false, used: 0, error: `Holy Water goes through hero.resetPoint, not hero.useItem — use  waterhero ${heroName || '<hero>'}` };
  }
  // Without a castleId this takes the first city holding the name, which is what
  // the script line does. The console has the city the operator clicked in, and
  // passes it, so two heroes of the same name in two cities stay apart.
  const wanted = String(heroName || '').toLowerCase();
  const where = castleId === undefined || castleId === null ? (game.castles || [])
    : (game.castles || []).filter((c) => String(game.castleId(c)) === String(castleId));
  let castle = null, hero = null;
  for (const c of where) {
    const h = (c.heros || []).find((x) => (heroId === undefined || heroId === null
      ? String(x.name || '').toLowerCase() === wanted
      : String(x.id) === String(heroId)));
    if (h) { castle = c; hero = h; break; }
  }
  if (!hero) {
    return { ok: false, used: 0,
      error: `no hero called "${heroName}" in ${where.length === 1 ? where[0].name : 'any city'}` };
  }

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
  resolveItem, describeItem, heldHeroItems, heroItemChoices, countOf, useOnHero,
};
