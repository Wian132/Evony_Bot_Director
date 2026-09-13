'use strict';
// The Stone of Finding: bring back a hero you have lost.
//
//   lostheroes                 who the stone can bring back, and how many stones are held
//   recover <hero>             restore that hero, by name or id, into the open city tab
//   recover <hero> to <city>   ... into another city
//
// The client never spends the stone through shop.useGoods. Using it opens the
// "RESTORE YOUR HERO" window (UseGoodWin.btnClickHandle -> DisappearHeroList),
// which lists hero.GetDisappearHeros {} and restores a row with
// hero.RecoverDisappearHero {castleid, id}: lowercase keys, the row's id as a
// string (HeroCommand.as). The server spends the stone, and the hero comes back
// as a server.HeroUpdate push into that city.
//
// Seen live on ss71 (2026-09-13): a hero captured by the city it attacked is on
// the list, although the client heads the time column "Dismissed Time". The
// row id is not the hero's id. The attributes listed are the base ones, without
// allocated points. A restore that worked replies ok 2, with "<hero> has been
// restored successfully, please check your feasting hall to confirm." as errorMsg.
//
// The client only ever sends an id off that list, so this does too: the name is
// looked up in a fresh read of the list, and nothing is sent without a stone.
const { heldCount } = require('./teleport');
const { feastingHall } = require('./goal-heroes');

const ITEM_ID = 'player.item.stoneoffinding';
const LABEL = 'Stone of Finding';

const fmt = (v) => Number(v || 0).toLocaleString('en-US');
const stones = (n) => (n === 1 ? `1 ${LABEL}` : `${fmt(n)} Stones of Finding`);
const USAGE = 'recover: usage  recover <hero name or id> [to <city>]   (see lostheroes)';

// Tokens after `recover`: a hero name (spaces allowed) or id, then `to <city>`.
function parseArgs(args) {
  const toks = args.slice();
  let to = null;
  const ti = toks.map((t) => t.toLowerCase()).lastIndexOf('to');
  if (ti === 0) throw new Error(USAGE);
  if (ti > 0) {
    to = toks.slice(ti + 1).join(' ');
    if (!to) throw new Error('recover: "to" needs a city name');
    toks.splice(ti);
  }
  const hero = toks.join(' ').trim();
  if (!hero) throw new Error(USAGE);
  return { hero, to };
}

// DisappearHeroBean.disppeartime is a string. Epoch time is shown on the
// server's clock; anything else is shown as the server sent it.
function when(game, s) {
  const t = String(s ?? '').trim();
  if (!/^\d{10,}$/.test(t)) return t || '?';
  const d = new Date((t.length <= 10 ? Number(t) * 1000 : Number(t)) + ((game && game.serverTzOffsetMs) || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// The server's list, or { error }. A refused read must never look like
// "nobody to restore".
async function readList(game) {
  let d;
  try { d = await game.lostHeroes(); } catch (e) { return { error: e.message }; }
  if (!d || d.ok !== 1) return { error: (d && d.errorMsg) || `refused (ok=${d ? d.ok : '?'})` };
  return {
    heroes: (d.heros || []).map((h) => ({
      id: String(h.id), name: String(h.name || ''), level: Number(h.level || 0),
      attack: Number(h.power || 0), politics: Number(h.management || 0), intel: Number(h.stratagem || 0),
      lostAt: h.disppeartime,
    })),
  };
}

const describe = (game, h) => `${h.name.padEnd(14)} L${String(h.level).padEnd(4)} base atk ${String(h.attack).padStart(4)}`
  + `  pol ${String(h.politics).padStart(4)}  int ${String(h.intel).padStart(4)}  lost ${when(game, h.lostAt)}  id ${h.id}`;

// By id, then by name ignoring case. Two heroes of one name are never guessed
// between: the wrong one still costs a stone.
function pick(list, want) {
  const byId = list.find((h) => h.id === want);
  if (byId) return { hero: byId };
  const byName = list.filter((h) => h.name.toLowerCase() === want.toLowerCase());
  if (byName.length > 1) return { many: byName };
  return { hero: byName[0] || null };
}

// The hero's HeroUpdate can beat the command's own reply, so listen from before
// the send; arm() starts the clock once the server has said yes. The restored
// hero may not keep the list's id, so its name matches too.
function waitForHero(game, castleId, lost, ms) {
  let settle, timer = null, settled = false;
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
    if (Number(data.castleId) !== Number(castleId)) return;
    const h = data.hero;
    if (String(h.id) === lost.id || String(h.name || '').toLowerCase() === lost.name.toLowerCase()) finish(h);
  };
  game.c.on('cmd', onCmd);
  return {
    promise,
    arm: () => { if (!settled) timer = setTimeout(() => finish(null), ms); },
    cancel: () => finish(null),
  };
}

async function list(game, log) {
  const held = heldCount(game, ITEM_ID);
  const r = await readList(game);
  if (r.error) { log(`  could not read the lost heroes (${r.error})`); return false; }
  if (held !== null) log(`  ${stones(held)} held`);
  if (!r.heroes.length) { log('  no lost heroes to restore'); return true; }
  for (const h of r.heroes) log('  ' + describe(game, h));
  log('  restore one with:  recover <name or id> [to <city>]');
  return true;
}

// `a` is a parsed lostheroes or recover line. Resolves true when a hero was
// restored (or, for lostheroes, when the list was read).
async function run(game, a, { castle: ref, dryRun = false, log = () => {}, waitMs = 5000 } = {}) {
  if (a.cmd === 'lostheroes') return list(game, log);

  const castle = game.castle(a.to ?? ref);
  const castleId = game.castleId(castle);
  const held = heldCount(game, ITEM_ID);
  if (held === 0) {
    log(`  no ${LABEL} in the inventory (${ITEM_ID}) — nothing sent`);
    return false;
  }

  const r = await readList(game);
  if (r.error) { log(`  could not read the lost heroes (${r.error}) — nothing sent`); return false; }
  const p = pick(r.heroes, a.hero);
  if (p.many) {
    log(`  ${p.many.length} lost heroes are called ${a.hero} — recover one by its id — nothing sent`);
    for (const h of p.many) log('    ' + describe(game, h));
    return false;
  }
  if (!p.hero) {
    log(`  no lost hero called ${a.hero} — nothing sent`);
    log(r.heroes.length
      ? '  the stone can restore: ' + r.heroes.map((h) => `${h.name} (id ${h.id})`).join(', ')
      : '  the list is empty — nobody to restore');
    return false;
  }

  const h = p.hero;
  log(`  ${LABEL}: restore ${h.name} L${h.level} (lost ${when(game, h.lostAt)}, id ${h.id}) into ${castle.name}`
    + (held === null ? '' : `, ${stones(held)} held`));
  if (dryRun) { log('  [dry run] not sent'); return false; }

  const back = waitForHero(game, castleId, h, waitMs);
  let res;
  try { res = await game.recoverHero(castleId, h.id); } catch (e) { back.cancel(); throw e; }
  // ok 2 is the server saying it worked (see the top of this file).
  if (!res || (res.ok !== 1 && res.ok !== 2)) {
    back.cancel();
    // The client checks nothing before sending, so the hall is only named when
    // the server has already said no.
    const hall = feastingHall({ castle });
    const full = hall.capacity !== null && hall.free === 0
      ? ` — ${castle.name}'s Feasting Hall looks full (${hall.used}/${hall.capacity}); make room, or restore into another city with  recover ${h.name} to <city>`
      : '';
    log(`  -> FAILED (ok=${res ? res.ok : '?'})${res && res.errorMsg ? ' - ' + res.errorMsg : ''}${full}`);
    return false;
  }
  back.arm();
  const hero = await back.promise;
  const left = heldCount(game, ITEM_ID);
  const spent = held !== null && left !== null && left < held ? `, ${stones(left)} left` : '';
  log(hero
    ? `  -> ok — ${hero.name || h.name} L${hero.level ?? h.level} is back in ${castle.name}${spent}`
    : `  -> ok — the server accepted it${res.errorMsg ? ` (${res.errorMsg})` : ''}, but ${h.name} has not shown up in ${castle.name} yet${spent}`);
  return true;
}

module.exports = { ITEM_ID, parseArgs, readList, pick, when, run };
