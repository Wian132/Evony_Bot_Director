'use strict';
// Holy Water: reset a hero's attribute points and spend them again, as NEAT's
// waterhero does (http://guide.neatportal.com/wiki/WaterHero).
//
//   waterhero <hero>                                     reset, then every point into the highest stat
//   waterhero <hero> /heropoints="att"                   ... every point into attack
//   waterhero <hero> /heropoints="pol:300,int:100 att"   ... by heropoints stages, in order
//   waterhero <hero> /heropoints=off                     ... and leave the points unspent
//
// <hero> is a name or an id, in whichever city it is. The switch takes what a
// heropoints goal takes (goal-heroes.js parseStages / allocateStages). The
// highest stat is the highest AFTER the reset, so an intel-born hero that was
// built into attack comes back an intel hero unless the switch says att.
//
// What the client does (HeroProperties.as, the Feasting Hall's reset button):
//   - the button is off for a prisoner, status 4 (HERO_SEIZED_STATU)
//   - it asks "需要花费洗髓丹{0}" with ceil(level / 10): one Holy Water
//     (hero.reset.1) per ten levels begun, as the item's own text says
//   - it sends hero.resetPoint {castleId, heroId} only when that many are held
//   - on ok it just re-reads the hero: the new stats come in a server.HeroUpdate
// It never sends hero.useItem for Holy Water.
//
// NEAT waters "a hero in the feasting hall", so a hero that is out is refused:
// reset mid-march, an attack hero would reach its target on its base stats.
//
// The points go back with hero.addPoint, which carries ABSOLUTE totals
// (game.addPoint), so they are only ever spent against the stats the reset's
// own HeroUpdate brought back. The old stats plus the refund would ask the
// server for the old build and then some.
const { heldCount } = require('./teleport');
const { locate } = require('./rename-hero');
const H = require('./goal-heroes');

const ITEM_ID = 'hero.reset.1';
const LABEL = 'Holy Water';
// Holy Water that has to be opened before it counts (the client's item table).
const PACKS = {
  'hero.reset.1.a': 'Holy Water (5 pieces package)',
  'player.box.fbgift.holywater': 'Minor Redistribution Pack',
  'player.box.currently.1': 'Hero Package',
};
const SEIZED = 4;
const HOME = new Set([0, 1]);                 // idle, mayor
const USAGE = 'waterhero: usage  waterhero <hero name or id> [/heropoints="att"]'
  + '   (targets as in heropoints: att, pol:300,int:100 att, off)';

const n = (v) => Number(v || 0);
const fmt = (v) => n(v).toLocaleString('en-US');
const cost = (level) => Math.max(1, Math.ceil(n(level) / 10));
const LABELS = { power: 'att', management: 'pol', stratagem: 'int' };
const KEYS = ['power', 'management', 'stratagem'];

// The /heropoints value: heropoints stages, one per word.
function parseRule(raw) {
  const words = String(raw || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('waterhero: /heropoints needs targets, e.g. /heropoints="att" or /heropoints="pol:300 att"');
  const { stages, errors } = H.parseStages(words);
  if (errors.length) throw new Error('waterhero: ' + errors[0]);
  return { raw: words.join(' '), stages };
}

// Everything after `waterhero`, as typed, so a quoted switch keeps its spaces.
function parseArgs(text) {
  let rest = String(text || '');
  let rule = null;
  const m = rest.match(/(^|\s)\/heropoints\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/i);
  if (m) {
    const raw = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (/^["']/.test(raw)) throw new Error('waterhero: the /heropoints quote is never closed');
    rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length);
    rule = parseRule(raw);
  }
  const other = rest.match(/(^|\s)(\/\S*)/);
  if (other) throw new Error(`waterhero: unknown switch ${other[2]} — the only one is /heropoints="..."`);
  const hero = rest.trim().replace(/\s+/g, ' ');
  if (!hero) throw new Error(USAGE);
  return { hero, rule };
}

const stats = (h) => `att ${fmt(h.power)} · pol ${fmt(h.management)} · int ${fmt(h.stratagem)} · ${fmt(h.remainPoint)} unspent`;
const snap = (h) => ({ power: n(h.power), management: n(h.management), stratagem: n(h.stratagem), remainPoint: n(h.remainPoint) });
const spentSum = (h) => KEYS.reduce((s, k) => s + n(h[k]), 0);
// The refund shows as more unspent points, or fewer on the attributes.
const wasReset = (h, before) => n(h.remainPoint) > before.remainPoint || spentSum(h) < spentSum(before);
const describeAdd = (add) => KEYS.filter((k) => add[k] > 0).map((k) => `${LABELS[k]} +${fmt(add[k])}`).join(', ');
const ruleText = (rule) => (rule ? `/heropoints="${rule.raw}"` : 'the highest stat');

// Where the refund goes, worked out on the stats the reset brought back.
function plan(hero, rule) {
  const points = n(hero.remainPoint);
  return { points, ...H.allocateStages(hero, rule ? rule.stages : [], points) };
}

// A HeroUpdate can beat the command's own reply, so listen from before the
// send; arm() starts the clock once the server has said yes. A push for the
// hero that fails `test` is kept, so a timeout can still say what came back.
function waitForHero(game, heroId, test, ms) {
  let settle, timer = null, settled = false, last = null;
  const promise = new Promise((resolve) => { settle = resolve; });
  const finish = (v) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    game.c.off('cmd', onCmd);
    settle(v);
  };
  const onCmd = (cmd, data) => {
    if (cmd !== 'server.HeroUpdate' || !data || !data.hero || Number(data.updateType) === 1) return;
    if (String(data.hero.id) !== String(heroId)) return;
    last = { hero: data.hero, castleId: data.castleId };
    if (test(data.hero)) finish({ ...last, matched: true });
  };
  game.c.on('cmd', onCmd);
  return {
    promise,
    arm: () => { if (!settled) timer = setTimeout(() => finish(last && { ...last, matched: false }), ms); },
    cancel: () => finish(null),
  };
}

const describe = (r) => `${r.hero.name} L${r.hero.level ?? '?'} in ${r.castle.name}, id ${r.hero.id}`;

// Everything checked before a reset is sent, and nothing is sent here: the
// hero, whether it is home, the cost and the stock. `lines` is what to show;
// `ok` says whether run() would go on to send.
function prepare(game, a) {
  const lines = [];
  const say = (m) => lines.push(m);
  const out = { ok: false, lines };
  const found = locate(game, a.hero);
  if (found.many) {
    say(`  more than one hero is called ${a.hero} — water one by its id — nothing sent`);
    for (const r of found.many) say('    ' + describe(r));
    return out;
  }
  if (!found.entries.length) {
    say(`  no hero called ${a.hero} in any city — nothing sent`);
    if (a.hero.startsWith('!')) say('  (the ! in the wiki\'s "waterhero !BigGuy" only stops a wiki link — leave it out)');
    return out;
  }

  const { hero, castle } = found.entries[0];
  const need = cost(hero.level);
  const held = heldCount(game, ITEM_ID);
  Object.assign(out, { hero, castle, entries: found.entries, need, held });
  const st = n(hero.status);
  if (st === SEIZED) {
    say(`  ${hero.name} is a prisoner held in ${castle.name}, not one of your heroes — the game won't reset it — nothing sent`);
    return out;
  }
  if (!HOME.has(st)) {
    say(`  ${hero.name} is ${H.STATUS_NAME[st] || 'status ' + st}, not in the Feasting Hall — water it once it is home — nothing sent`);
    return out;
  }

  say(`  ${LABEL} on ${hero.name} L${hero.level ?? '?'} in ${castle.name} (id ${hero.id}): ${stats(hero)}`);
  say(`  costs ${fmt(need)} ${LABEL} (one per 10 levels)${held === null ? '' : `, ${fmt(held)} held`}; `
    + `the points then go ${a.rule ? 'by ' + ruleText(a.rule) : 'to its highest stat once reset'}`);
  if (held !== null && held < need) {
    say(`  not enough ${LABEL} — nothing sent`);
    for (const [id, name] of Object.entries(PACKS)) {
      const k = heldCount(game, id);
      if (k) say(`  ${fmt(k)} x ${name} held — open one with  useitem ${id}`);
    }
    return out;
  }
  if (found.entries.length > 1) {
    say(`  ${hero.name} is listed in ${found.entries.map((r) => r.castle.name).join(' and ')}, which it can't be — `
      + `trying ${castle.name}, the fresher entry, first`);
  }
  out.ok = true;
  return out;
}

// `a` is a parsed waterhero line. Resolves true when the reset went through,
// i.e. when Holy Water was spent.
async function run(game, a, { dryRun = false, log = () => {}, waitMs = 5000 } = {}) {
  const ready = prepare(game, a);
  for (const l of ready.lines) log(l);
  if (!ready.ok) return false;
  if (dryRun) { log('  [dry run] not sent'); return false; }
  const { hero, entries, need, held } = ready;

  // Another city is only tried when the server refuses this one; a refusal
  // costs nothing.
  const before = snap(hero);
  let refused = null;
  for (const e of entries) {
    const push = waitForHero(game, hero.id, (h) => wasReset(h, before), waitMs);
    let res;
    try { res = await game.resetPoint(game.castleId(e.castle), hero.id); } catch (err) { push.cancel(); throw err; }
    if (!res || res.ok !== 1) {
      push.cancel();
      refused = res;
      if (entries.length > 1) log(`  ${e.castle.name}: FAILED (ok=${res ? res.ok : '?'})${res && res.errorMsg ? ' - ' + res.errorMsg : ''}`);
      continue;
    }
    push.arm();
    await spend(game, e.castle, hero, before, await push.promise, a, { log, need, held, waitMs });
    return true;
  }
  log(`  -> FAILED (ok=${refused ? refused.ok : '?'})${refused && refused.errorMsg ? ' - ' + refused.errorMsg : ''}`);
  return false;
}

// After an accepted reset: spend the refund, then say what it cost.
async function spend(game, sentTo, hero, before, seen, a, { log, need, held, waitMs }) {
  const tally = () => {
    const now = heldCount(game, ITEM_ID);
    if (held === null || now === null || now >= held) {
      return `  ${LABEL}: ${fmt(need)} due; the inventory we hold has not moved yet${held === null ? '' : ` (${fmt(held)})`}`;
    }
    const used = held - now;
    return `  ${LABEL}: ${fmt(used)} used, ${fmt(now)} left`
      + (used === need ? '' : ` — the game took ${fmt(used)}, not the ${fmt(need)} that ceil(level / 10) makes it`);
  };

  if (!seen) {
    log(`  -> ok — the server accepted the reset, but ${hero.name}'s new stats have not come back — no points spent;`
      + ' spend them with addpoint or on the Heroes tab once they show');
    log(tally());
    return;
  }
  if (!seen.matched) {
    log(`  -> ok — but ${hero.name} came back unchanged (${stats(seen.hero)}): it had no spent points to give back`);
    log(tally());
    return;
  }
  const home = (game.castles || []).find((c) => Number(game.castleId(c)) === Number(seen.castleId)) || sentTo;
  log(`  -> reset: ${stats(before)}  =>  ${stats(seen.hero)}`);

  // The roster entry is the push itself unless something moved since (the
  // push can land before the reply, and a heropoints goal may spend first).
  const live = (home.heros || []).find((h) => String(h.id) === String(hero.id)) || seen.hero;
  if (n(live.remainPoint) < n(seen.hero.remainPoint)) {
    log(`  ${fmt(n(seen.hero.remainPoint) - n(live.remainPoint))} point(s) were spent before this could (a heropoints goal?) — spending the rest`);
  }
  const p = plan(live, a.rule);
  if (p.off) { log(`  ${fmt(p.points)} point(s) left unspent, as ${ruleText(a.rule)} says`); log(tally()); return; }
  if (p.spent <= 0) { log(`  no points to spend`); log(tally()); return; }

  const done = waitForHero(game, hero.id, (h) => n(h.remainPoint) < p.points, waitMs);
  let r;
  try { r = await game.addPoint(game.castleId(home), live, p.add); } catch (err) { done.cancel(); throw err; }
  if (!r || r.ok !== 1) {
    done.cancel();
    log(`  spending the points FAILED (ok=${r ? r.ok : '?'})${r && r.errorMsg ? ' - ' + r.errorMsg : ''} — `
      + `${fmt(p.points)} point(s) are unspent; spend them with addpoint or on the Heroes tab`);
    log(tally());
    return;
  }
  done.arm();
  const after = await done.promise;
  log(`  -> spent ${fmt(p.spent)} by ${ruleText(a.rule)}: ${describeAdd(p.add)}`
    + (after && after.matched ? `  =>  ${stats(after.hero)}` : ' (the new stats have not come back yet)')
    + (p.spent < p.points ? `, ${fmt(p.points - p.spent)} left unspent` : ''));
  log(tally());
}

module.exports = { ITEM_ID, LABEL, PACKS, cost, parseRule, parseArgs, plan, prepare, run };
