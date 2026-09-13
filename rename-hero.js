'use strict';
// Rename a hero, as the Feasting Hall's Change Name button does.
//
//   renamehero <hero> <new name>          by the hero's name or id, in whichever city it is
//   renamehero <hero> <new name> anyway   ... even when another hero already has that name
//
// The client (HeroChangeName.as) sends hero.changeName {castleId, heroId,
// newName} for the hero's own city, shows errorMsg when ok is not 1, and learns
// the new name from the server.HeroUpdate that follows. What it checks first,
// and so does this:
//   - no quote, backslash or space (InputTextFilter.specialCharFilter, InputTextControl)
//   - at most 10 wide, a character from U+0391 up counting 2 (textChange cuts
//     the box off there; InputTextFilter.isChinese)
//   - no rename for a prisoner: the button is off at status 4 (HERO_SEIZED_STATU)
//
// Two heroes of one name are never guessed between, and a rename onto a name
// another hero already has needs `anyway`: useheroitem finds a hero by name in
// every city and takes the first, so it could spend one hero's items on the other.

const USAGE = 'renamehero: usage  renamehero <hero name or id> <new name> [anyway]';
const MAX_WIDTH = 10;
const WIDE = /[\u0391-\uFFE5]/;
const SEIZED = 4;

// Counted per UTF-16 unit, as the client counts.
const width = (s) => s.split('').reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);

function checkName(name) {
  if (/["'\\]/.test(name)) throw new Error(`renamehero: the game refuses a quote or a backslash in a hero name ("${name}")`);
  if (width(name) > MAX_WIDTH) throw new Error(`renamehero: "${name}" is too long — the game takes ${MAX_WIDTH} letters at most, and a Chinese character counts as 2`);
}

// Tokens after `renamehero`: the hero (spaces allowed), the new name, then an
// optional `anyway`. The new name can't hold a space, so it is the last token.
function parseArgs(args) {
  const toks = args.slice();
  let anyway = false;
  if (toks.length > 2 && toks[toks.length - 1].toLowerCase() === 'anyway') { anyway = true; toks.pop(); }
  if (toks.length < 2) throw new Error(USAGE);
  const name = toks.pop();
  checkName(name);
  return { hero: toks.join(' '), name, anyway };
}

const rows = (game) => (game.castles || []).flatMap((castle) => (castle.heros || []).map((hero) => ({ castle, hero })));

// Every city's entry for one hero, by id then by name ignoring case. A hero that
// moved can stay listed in the city it left too; that is still one hero, so the
// freshest entry comes first (experience only grows).
function locate(game, want) {
  const all = rows(game);
  let hits = all.filter((r) => String(r.hero.id) === want);
  if (!hits.length) hits = all.filter((r) => String(r.hero.name || '').toLowerCase() === want.toLowerCase());
  if (new Set(hits.map((r) => String(r.hero.id))).size > 1) return { many: hits };
  return { entries: hits.sort((x, y) => Number(y.hero.experience || 0) - Number(x.hero.experience || 0)) };
}

// The new name's HeroUpdate can beat the command's own reply, so listen from
// before the send; arm() starts the clock once the server has said yes.
function waitForName(game, heroId, name, ms) {
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
    if (String(data.hero.id) === String(heroId) && data.hero.name === name) finish({ hero: data.hero, castleId: data.castleId });
  };
  game.c.on('cmd', onCmd);
  return {
    promise,
    arm: () => { if (!settled) timer = setTimeout(() => finish(null), ms); },
    cancel: () => finish(null),
  };
}

const describe = (r) => `${r.hero.name} L${r.hero.level ?? '?'} in ${r.castle.name}, id ${r.hero.id}`;

// `a` is a parsed renamehero line. Resolves true when the hero was renamed.
async function run(game, a, { dryRun = false, log = () => {}, waitMs = 5000 } = {}) {
  const found = locate(game, a.hero);
  if (found.many) {
    log(`  more than one hero is called ${a.hero} — rename one by its id — nothing sent`);
    for (const r of found.many) log('    ' + describe(r));
    return false;
  }
  if (!found.entries.length) { log(`  no hero called ${a.hero} in any city — nothing sent`); return false; }

  const { hero, castle } = found.entries[0];
  const old = hero.name;
  if (Number(hero.status) === SEIZED) {
    log(`  ${old} is a prisoner held in ${castle.name}, not one of your heroes — the game won't rename it — nothing sent`);
    return false;
  }
  if (old === a.name) { log(`  ${old} already has that name — nothing sent`); return false; }

  const clash = rows(game).find((r) => String(r.hero.id) !== String(hero.id)
    && String(r.hero.name || '').toLowerCase() === a.name.toLowerCase());
  if (clash && !a.anyway) {
    log(`  ${describe(clash)} already has that name — nothing sent`);
    log(`  useheroitem finds a hero by name and takes the first, so two heroes called ${a.name} could get each other's items.`);
    log(`  rename it all the same with:  renamehero ${a.hero} ${a.name} anyway`);
    return false;
  }

  log(`  rename ${old} (L${hero.level ?? '?'}, id ${hero.id}) in ${castle.name} to ${a.name}`
    + (clash ? ` — ${clash.hero.name} in ${clash.castle.name} has that name too` : ''));
  if (found.entries.length > 1) {
    log(`  ${old} is listed in ${found.entries.map((r) => r.castle.name).join(' and ')}, which it can't be — `
      + `trying ${castle.name}, the fresher entry, first`);
  }
  if (dryRun) { log('  [dry run] not sent'); return false; }

  // Another city is only tried when the server refuses this one.
  let refused = null;
  for (const e of found.entries) {
    const push = waitForName(game, hero.id, a.name, waitMs);
    let res;
    try { res = await game.renameHero(game.castleId(e.castle), hero.id, a.name); } catch (err) { push.cancel(); throw err; }
    if (res && res.ok === 1) push.arm(); else push.cancel();
    const seen = await push.promise;
    if (seen || (res && res.ok === 1)) {
      const home = seen && (game.castles || []).find((c) => Number(game.castleId(c)) === Number(seen.castleId));
      log(seen
        ? `  -> ok — ${old} is now ${seen.hero.name}${home ? ` in ${home.name}` : ''}`
        : `  -> ok — the server accepted it${res.errorMsg ? ` (${res.errorMsg})` : ''}, but the new name has not come back yet`);
      log(`  scripts and goals that name ${old} need ${a.name} now`);
      return true;
    }
    refused = res;
    if (found.entries.length > 1) log(`  ${e.castle.name}: FAILED (ok=${res ? res.ok : '?'})${res && res.errorMsg ? ' - ' + res.errorMsg : ''}`);
  }
  log(`  -> FAILED (ok=${refused ? refused.ok : '?'})${refused && refused.errorMsg ? ' - ' + refused.errorMsg : ''}`);
  return false;
}

module.exports = { MAX_WIDTH, parseArgs, width, locate, run };
