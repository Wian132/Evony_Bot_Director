'use strict';
// Hero commands for scripts (the command-module contract is at the top of script.js).
//
//   heroes | herolist                   the city's heroes
//   listallheroes                       every hero in every city, as NEAT prints them:
//                                         CityA Queen Lvl:193 [P:254 A:67 I:21] exp:4737560/3724900
//                                       ($result: those lines)
//   inn | tavern                        the inn's heroes
//   innrefresh                          a new inn list; it spends a Hero Hunting you hold. With none held
//                                       (or the inventory not loaded) nothing is sent: the server would
//                                       charge game coins. innrefresh force is refused — buyitem first
//   hire, findhero, persuadehero        a hero asking for jewels or medals goes only while the loaded
//                                       inventory shows them (an unknown count is none held)
//   hire <name> | hire best [attack|politics|intel]
//   findhero atk | pol | int            hire the inn's best hero of that kind, by base (also power,
//                                       att, attack, management, politics, stratagem, intel);
//                                       $result: its name
//   fire <hero> | firehero <hero>       one hero, named, idle or mayor (not away from town)
//   release <prisoner> | releasehero <prisoner>    a prisoner you hold goes free, for good
//   firehero any:level<50 all           every hero a hero string (see HeroString) picks, but only
//   releasehero any:level<100 all       when the line ends in all; keepheroes / keepcapturedheroes
//                                       (or their defaults) still protect; $result: how many went
//   mayor <hero> | appoint <hero> | setmayorbyname <hero>     (already mayor: nothing sent)
//   setmayor att | pol | int            the hero with the most of it (also atk attack politics
//                                       intel intelligence) | setmayor none | remove: no mayor
//   unmayor | unappoint | dischargemayor
//   persuadehero <prisoner>             ask a prisoner you hold to join: level x 1,000 gold, plus the
//                                       medals it asks for (its itemId x itemAmount)
//   rewardheroes                        a gold reward (level x 100 each) for every hero under 100 loyalty;
//                                       $result: how many were rewarded
//   levelup <hero|all> [attack|politics|intel|auto]
//   uplevelheroes                       every hero here with the experience goes up one level, less
//                                       nolevelheroes; its points go by heropoints, else to its best
//                                       attribute; needs config hero:1 or more in the city's goals
//   addpoint <hero> <attack|politics|intel> <n>
//   renamehero | changeheroname <hero> <new name> [anyway]   (rename-hero.js)
//   waterhero <hero> [/heropoints="pol:300 att"]              (water-hero.js: Holy Water, then the points)
//   useheroitem OTTO excalibur repeat 5 | useheroitem OTTO nation medal | useheroitem OTTO hero.power.1
//                                       (heroitems.js; also heroitem) — never on a prisoner
//   heroitems                           hero items held
//   lostheroes | recover <hero> [to <city>]                   (stone-of-finding.js)
//
// fire, release, mayor, persuadehero, levelup and addpoint act on ONE hero, by
// name: "any" (or any:<filter>) used to mean the city's first hero there, so a
// slip could fire, release or re-spec whichever hero was listed first; it is
// refused. A hero string that picks several heroes needs the closing `all`.
// The wiki writes !BigGuy where the ! only stops a wiki link, so one hero's
// !Name finds Name when no hero is called !Name; in a hero string (fire,
// release) !Name keeps its meaning, "everyone but Name".
// A mayor set here may be swapped back by the goal engine's mayor plan on its
// next tick, unless the city's goals say config hero:0.
const { Game } = require('./game');
const H = require('./goal-heroes');

// attack = power, politics = management, intel = stratagem
const ATTR = Game.ATTR;
// NEAT's words for them (SetMayor, FindHero): att atk attack power, pol politics
// management, int intel intelligence stratagem.
const ATTR_WORD = { ...Game.ATTR, att: 'power', intelligence: 'stratagem' };

const attrLabel = (dom) => (dom === 'power' ? 'attack' : dom === 'management' ? 'politics' : 'intel');
const miss = (env, why) => { env.log('  ' + why); return { ok: false, error: why }; };
const num = (x) => Number(x || 0);
const fmt = (x) => Math.floor(num(x)).toLocaleString('en-US');
const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();
const known = (x) => x !== undefined && x !== null && x !== '' && Number.isFinite(Number(x));

// ------------------------------------------------------------------ status
// HeroConstants.as: 0 idle, 1 mayor, 2 guarding, 3 marching, 4 a prisoner we
// hold, 5 returning, 8 farming.
const PRISONER = 4;
const STATUS_WORD = Game.STATUS_WORD
  || { 0: 'idle', 1: 'mayor', 2: 'guarding a valley', 3: 'marching', 4: 'a prisoner', 5: 'returning', 8: 'farming' };
const statusOf = (h) => Number(h && h.status);
const isPrisoner = (h) => statusOf(h) === PRISONER;
const statusWord = (h) => STATUS_WORD[statusOf(h)] || `status ${h.status}`;

// Why the client would not offer this action on this hero, or null:
// Game.heroActionRefusal where game.js has it (the goals branch), else the same
// rules. A prisoner we hold is offered Release and Persuade and nothing else;
// Fire is for anyone else (HeroProperties.as:1178-1218); the mayor's window
// lists only idle heroes (HerosMansion.as:448-467). Releasing a captured hero
// from the captor's side loses it — its owner brings it home with a Stone of
// Finding — so release is never sent for one of our own heroes.
function clientRefusal(action, h) {
  if (typeof Game.heroActionRefusal === 'function') return Game.heroActionRefusal(action, h);
  if (!h) return 'hero not found in this city';
  const st = statusOf(h), prisoner = st === PRISONER;
  if (action === 'release' && !prisoner) return `${h.name} is not a prisoner (${statusWord(h)}) — release only dismisses a prisoner you hold; fire dismisses your own hero`;
  if (action === 'fire' && prisoner) return `${h.name} is a prisoner you hold — a prisoner is dismissed with release, not fire`;
  if (action === 'mayor') {
    if (prisoner) return `${h.name} is a prisoner you hold — only your own heroes can be mayor`;
    if (st !== 0 && st !== 1) return `${h.name} is ${statusWord(h)}, not idle at home — only an idle hero can be made mayor`;
  }
  return null;
}

// The client's rules plus NEAT's: FireHero takes a hero that is idle or mayor,
// not one away from town; PersuadeHero is for a prisoner (the button shows only
// for status 4, HeroProperties.as:1178-1184); a prisoner is levelled, given
// points, items or rewards by nobody (UseHeroItem: "cannot be applied to a
// captured hero"; the point boxes are off for it, HeroProperties.as:1437-1442).
function refusal(action, h) {
  const no = clientRefusal(action, h);
  if (no) return no;
  const st = statusOf(h);
  if (action === 'fire' && st !== 0 && st !== 1) return `${h.name} is ${statusWord(h)}, away from town — a hero is fired from the Feasting Hall, idle or mayor`;
  if (action === 'persuade' && st !== PRISONER) return `${h.name} is not a prisoner (${statusWord(h)}) — persuading is for a prisoner you hold`;
  if (['levelup', 'addpoint', 'item', 'reward'].includes(action) && st === PRISONER) return `${h.name} is a prisoner you hold, not one of your heroes`;
  return null;
}

// A hero this run sent on a march a moment ago, before the server's HeroUpdate
// has marked it away.
function busyWhy(env, h) {
  const at = env.sentHeroes && env.sentHeroes.get(h.id);
  return at !== undefined && Date.now() - at < 60000 ? `${h.name} was just sent on a march by this script` : null;
}

// ------------------------------------------------------------------ finding heroes
// A name with none of a hero string's marks, and not any / none.
const isPlainName = (s) => !/[:,|*?!]/.test(s) && !/^(any|none)$/i.test(String(s).trim());

// One hero, named, for a line that acts on exactly one.
function oneHero(what, name, hint = '') {
  const s = String(name || '').trim();
  if (!s) throw new Error(`${what}: give a hero name`);
  if (/^any(:|$)/i.test(s)) throw new Error(`${what}: name the hero — "${s}" is refused here, so a slip cannot pick whichever hero is listed first${hint}`);
  if (!isPlainName(s.replace(/^!/, ''))) throw new Error(`${what}: one hero, by its name — "${s}" reads as a hero string${hint}`);
  return s;
}

// This city's hero of that name (any case); !Name finds Name when no hero is
// called !Name (the wiki's link-stopper).
function heroNamed(castle, name) {
  const heros = (castle && castle.heros) || [];
  const want = lc(name);
  if (!want) return null;
  // a hero id picks exactly that hero — the safe way when names repeat
  if (/^\d+$/.test(want)) {
    const byId = heros.find((h) => String(h.id) === want);
    if (byId) return byId;
  }
  const hit = heros.find((h) => lc(h.name) === want);
  if (hit || !want.startsWith('!')) return hit || null;
  return heros.find((h) => lc(h.name) === want.slice(1)) || null;
}
// The same, logging when the ! was read past.
function findOne(env, castle, name) {
  const h = heroNamed(castle, name);
  if (h && String(name).trim().startsWith('!') && lc(h.name) !== lc(name)) {
    env.log(`  (reading ${String(name).trim()} as ${h.name} — the ! in the wiki only stops a wiki link)`);
  }
  return h;
}
// The first city holding a hero of that name, in the order heroitems.js and
// rename-hero.js search.
function heroAnywhere(game, name) {
  const want = lc(name);
  for (const c of game.castles || []) {
    const h = (c.heros || []).find((x) => lc(x.name) === want);
    if (h) return { castle: c, hero: h };
  }
  return null;
}
// For a line that finds its hero in any city: the name to hand on, the wiki's
// !Name read as Name when only that exists.
function bangName(env, name) {
  const s = String(name == null ? '' : name).trim();
  if (!s.startsWith('!') || heroAnywhere(env.game, s)) return s;
  const found = heroAnywhere(env.game, s.slice(1));
  if (!found) return s;
  env.log(`  (reading ${s} as ${found.hero.name} — the ! in the wiki only stops a wiki link)`);
  return found.hero.name;
}

// ------------------------------------------------------------------ what things cost
function goldOf(castle) {
  const g = castle && castle.resource && castle.resource.gold;
  return known(g) ? Math.floor(Number(g)) : null;
}
// null when the inventory has not loaded
function heldCount(game, id) {
  const items = game.player && game.player.items;
  if (!Array.isArray(items)) return null;
  const it = items.find((i) => i && i.id === id);
  return it ? num(it.count) : 0;
}
function itemName(id) {
  const medal = require('./items').MEDALS[id];
  if (medal) return medal;
  const hi = require('./heroitems').ALL[id];
  return hi ? hi.label : id;
}

// The Hero Hunting an inn refresh spends: Game#innRefreshCost where game.js
// has it (the goals branch), else the same reading. It spends one when held
// (Tavern.as:541-552); with none the client offers to buy one and sends the
// same command, and the server charges game coins (Tavern.as:473-479, 515-528).
const HERO_HUNTING = Game.HERO_HUNTING || 'consume.refreshtavern.1';
function innRefreshCost(game) {
  if (typeof game.innRefreshCost === 'function') return game.innRefreshCost();
  const held = heldCount(game, HERO_HUNTING);
  return {
    held, item: held > 0,
    text: held > 0 ? `spends 1 Hero Hunting (${held} held)`
      : held === 0 ? 'no Hero Hunting held, so the server charges game coins'
        : 'the inventory has not loaded, so it cannot tell whether this costs a Hero Hunting or game coins',
  };
}

// What the hire window lists above its Hire button (HireHero.as:721-747): a free
// Feasting Hall slot (the inn list's posCount, Tavern.as:586-591), level x 1,000
// gold, and itemAmount of the hero's itemId jewel. why is null unless one of
// them is known to fall short (an unknown is left to the server).
function hireCheck(game, castle, h, posCount) {
  const gold = num(h.level) * 1000;
  const jewel = h.itemId && num(h.itemAmount) > 0 ? { id: String(h.itemId), n: num(h.itemAmount) } : null;
  const cost = `${fmt(gold)} gold` + (jewel ? ` and ${jewel.n} x ${itemName(jewel.id)}` : '');
  const have = goldOf(castle);
  let why = null;
  if (known(posCount) && Number(posCount) < 1) why = `the Feasting Hall in ${castle.name} has no free slot — fire a hero first`;
  else if (have !== null && have < gold) why = `hiring ${h.name} costs ${fmt(gold)} gold and ${castle.name} has ${fmt(have)}`;
  else if (jewel) {
    // an unknown count is none held: nothing that could cost cents goes out unseen
    const held = heldCount(game, jewel.id);
    if (held === null) why = `hiring ${h.name} takes ${jewel.n} x ${itemName(jewel.id)}, and the inventory has not loaded, so whether they are held cannot be checked`;
    else if (held < jewel.n) why = `hiring ${h.name} takes ${jewel.n} x ${itemName(jewel.id)} and ${held} ${held === 1 ? 'is' : 'are'} held`;
  }
  return { cost, why };
}

// ------------------------------------------------------------------ the city's goals
// The goals AS THEY ARE RUNNING: the city's own text, the global prepend and
// append, and the script's own goal layer on top — goallayers.runningGoals, the
// same reading script-cmd-deploy makes. Reading only the saved text (what this
// did until 2026-09-22) meant a script that set `config hero:1` itself was still
// refused by uplevelheroes, because the line it had just written was in the
// script layer and never in the saved goals. null only when this run has no
// goal store at all (tests, a bare run). goals.js is loaded only here.
function cityGoals(env, castle) {
  const s = env.session;
  const store = s && s.org && s.org.goals;
  if (!store) return null;
  const acct = s.account && s.account.id;
  try {
    if (typeof store.layers === 'function') {
      const GL = require('./goallayers');
      if (typeof GL.runningGoals === 'function') {
        // no layer at all still means "goals readable, nothing set", as before
        return GL.runningGoals(store, acct, env.game.castleId(castle), castle.name)
          || { goals: [], config: {}, errors: [] };
      }
    }
    if (typeof store.own !== 'function') return null;
    const entry = store.own(acct, env.game.castleId(castle), castle.name, 'goal');
    if (!entry || !String(entry.src || '').trim()) return { goals: [], config: {}, errors: [] };
    return require('./goals').parseGoals(entry.src);
  } catch { return null; }
}
// One hero-string goal's rules in order, honouring /reset (goal-heroes.js).
function rulesFor(goals, name) {
  const out = [];
  for (const g of goals || []) {
    if (g.name !== name) continue;
    if (g.reset) { out.length = 0; continue; }
    if (g.spec && !(g.spec.errors && g.spec.errors.length)) out.push(g);
  }
  return out;
}
// Who keepheroes (with herofirelimit) or keepcapturedheroes protects, or their
// wiki defaults, as the goal engine reads them (goal-heroes.js keepPlan).
function keepRules(env, castle, captured) {
  const goals = (cityGoals(env, castle) || {}).goals || [];
  const name = captured ? 'keepcapturedheroes' : 'keepheroes';
  const specs = rulesFor(goals, name).map((g) => g.spec);
  if (!captured) {
    const limit = goals.find((g) => g.name === 'herofirelimit' && g.spec);
    if (limit) specs.push(limit.spec);
  }
  const dflt = !specs.length;
  if (dflt) specs.push(H.parseHeroString(captured ? H.DEFAULT_KEEP_CAPTURED : H.DEFAULT_KEEP));
  return { name, specs, dflt };
}

// ------------------------------------------------------------------ fire / release
const RELEASE_NOTE = '  (a released prisoner leaves for good; if it is a hero of your own other account, bring it home with a Stone of Finding there instead: lostheroes, recover)';

// fire | firehero | release | releasehero: one hero by name, or with a closing
// `all` every hero a hero string picks.
function parseDismiss(cmd) {
  const who = cmd === 'release' ? 'prisoner' : 'hero';
  return (args, { word, tok }) => {
    const words = tok.slice(1);
    let all = false;
    if (words.length > 1 && lc(words[words.length - 1]) === 'all') { all = true; words.pop(); }
    const text = words.join(' ').trim();
    if (!text) throw new Error(`${word}: give a hero name`);
    if (lc(text) === 'all') throw new Error(`${word}: name the ${who}, or put a hero string before all — e.g.  ${word} any:level<50 all`);
    if (isPlainName(text)) return { cmd, name: text };
    const spec = H.parseHeroString(text);
    if (spec.errors.length) throw new Error(`${word}: ${spec.errors[0]}`);
    if (spec.isNone) throw new Error(`${word}: "${text}" picks no hero`);
    if (!all) {
      const end = `to ${cmd} every ${who} it matches, end the line with all:  ${word} ${text} all`;
      if (/^any(:|$)/i.test(text)) throw new Error(`${word}: name the hero — "${text}" is refused here, so a slip cannot pick whichever hero is listed first; ${end}`);
      throw new Error(`${word}: "${text}" can pick more than one ${who}, and a ${cmd === 'fire' ? 'fired hero' : 'released prisoner'} is gone for good — ${end}`);
    }
    return { cmd, heroes: spec.src, all: true };
  };
}

// hero.fireHero / hero.releaseHero {castleId, heroId} (HeroCommand.as:172-182,
// 91-101; sent by HeroProperties.as:1738-1745)
const dismiss = (game, cmd, cid, h) => (cmd === 'fire' ? game.fireHero(cid, h.id) : game.releaseHero(cid, h.id));

async function runDismiss(a, env) {
  const game = env.game;
  const castle = env.castle;
  const cid = game.castleId(castle);
  if (!a.all) {
    const h = heroNamed(castle, a.name);
    if (!h) return miss(env, `no hero named "${a.name}" in ${castle.name}`);
    // Never guess between heroes that share a name: a big hero can share its name
    // with a fresh one (the user, 2026-09-18). Given by id, it is exactly that hero.
    if (String(h.id) !== lc(a.name).replace(/^!/, '')) {
      const same = ((castle && castle.heros) || []).filter((x) => lc(x.name) === lc(h.name));
      if (same.length > 1) {
        return miss(env, `not sent: ${same.length} heroes in ${castle.name} are named ${h.name} `
          + `(${same.map((x) => `id ${x.id} L${x.level}`).join(', ')}) — ${a.cmd} one by its id`);
      }
    }
    const no = refusal(a.cmd, h) || busyWhy(env, h);
    if (no) return miss(env, `not sent: ${no}`);
    env.log(`  ${a.cmd} ${h.name} (id ${h.id}, L${h.level})`);
    if (a.cmd === 'release') env.log(RELEASE_NOTE);
    if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
    const r = await dismiss(game, a.cmd, cid, h);
    env.log('  -> ' + env.say(r));
    return { done: 1, result: r && r.ok === 1 ? 1 : 0 };
  }

  // Every hero the string picks: prisoners for release, our own for fire (the
  // pool best/worst is measured against).
  const who = a.cmd === 'release' ? 'prisoner' : 'hero';
  const roster = castle.heros || [];
  const pool = roster.filter((h) => isPrisoner(h) === (a.cmd === 'release'));
  const hits = H.matchHeroes(pool, a.heroes);
  if (!hits.length) { env.log(`  no ${who} in ${castle.name} matches ${a.heroes} — nothing to ${a.cmd}`); return { result: 0 }; }
  const keep = keepRules(env, castle, a.cmd === 'release');
  const go = [];
  for (const h of hits) {
    const no = refusal(a.cmd, h) || busyWhy(env, h);
    if (no) { env.log(`  ${h.name}: left — ${no}`); continue; }
    const k = keep.specs.find((s) => H.matchHero(h, s, roster));
    if (k) { env.log(`  ${h.name} (L${h.level}, base ${H.heroBase(h)}): kept — ${keep.name} ${H.describeHeroString(k)}${keep.dflt ? ' (the default)' : ''}`); continue; }
    go.push(h);
  }
  if (!go.length) { env.log(`  nothing to ${a.cmd}`); return { result: 0 }; }
  if (a.cmd === 'release') env.log(RELEASE_NOTE);
  if (env.dryRun) {
    for (const h of go) env.log(`  ${a.cmd} ${h.name} (id ${h.id}, L${h.level}, base ${H.heroBase(h)})`);
    env.log('  [dry run] not sent');
    return {};
  }
  let done = 0, gone = 0;
  for (const h of go) {
    if (env.stopped()) break;
    // re-read: a push since the list was made may have moved it
    const live = (castle.heros || []).find((x) => x.id === h.id);
    const no = !live ? 'no longer in this city' : refusal(a.cmd, live);
    if (no) { env.log(`  ${h.name}: left — ${no}`); continue; }
    const r = await dismiss(game, a.cmd, cid, live);
    done++;
    if (r && r.ok === 1) gone++;
    env.log(`  ${a.cmd} ${live.name} (id ${live.id}, L${live.level}) -> ${env.say(r)}`);
  }
  return { done, result: gone };
}

// ------------------------------------------------------------------ mayor
async function appoint(env, castle, h, why) {
  const game = env.game;
  if (statusOf(h) === 1) { env.log(`  ${h.name} is already mayor of ${castle.name}`); return { result: h.name }; }
  const no = refusal('mayor', h) || busyWhy(env, h);
  if (no) return miss(env, `not sent: ${no}`);
  env.log(`  appoint ${h.name} as mayor of ${castle.name}${why}`);
  if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
  // hero.promoteToChief {castleId, heroId} (HeroCommand.as:127-137), straight
  // over a sitting mayor, as the client does (CastleChief.as:377-390)
  const r = await game.promoteToChief(game.castleId(castle), h.id);
  if (!r || r.ok !== 1) { env.log('  -> ' + env.say(r)); return { done: 1, result: '' }; }
  // The server can answer ok and change nothing (game.js mayorTook).
  if (await game.mayorTook(game.castleId(castle), h.id) === false) {
    return miss(env, `the server answered ok, but ${h.name} is still not mayor of ${castle.name} ${require('./game').Game.MAYOR_CONFIRM_MS / 1000}s later`
      + ' — it ignored the appointment (seen in a city under attack; see EVONY-RULES)');
  }
  env.log('  -> ok');
  return { done: 1, result: h.name };
}

async function removeMayor(a, env) {
  const game = env.game;
  const castle = env.castle;
  const heros = castle.heros;
  const mayor = Array.isArray(heros) ? heros.find((h) => statusOf(h) === 1) : null;
  if (Array.isArray(heros) && !mayor) { env.log(`  ${castle.name} has no mayor — nothing to remove`); return { result: '' }; }
  env.log(`  remove the mayor of ${castle.name}${mayor ? ` (${mayor.name})` : ''}`);
  if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
  // hero.dischargeChief {castleId} (HeroCommand.as:104-113)
  const r = await game.dischargeChief(game.castleId(castle));
  env.log('  -> ' + env.say(r));
  return { done: 1, result: mayor ? mayor.name : '' };
}

// ------------------------------------------------------------------ levels and points
// The client offers Level Up only while experience - upgradeExp > 0
// (HeroProperties.as:1420-1426). Null when it can, or cannot tell.
function expWhy(h) {
  if (!known(h.experience) || !known(h.upgradeExp)) return null;
  const e = num(h.experience), need = num(h.upgradeExp);
  return e - need > 0 ? null : `has ${fmt(e)} of the ${fmt(need)} experience its next level takes`;
}
const pointsText = (add) => ['power', 'management', 'stratagem'].filter((k) => add[k] > 0).map((k) => `+${add[k]} ${attrLabel(k)}`).join(', ');

async function runInn(a, env) {
  const game = env.game;
  const castle = env.castle;
  const cid = game.castleId(castle);
  let done = 0;
  if (a.cmd === 'innrefresh') {
    // with no Hero Hunting held the server charges game coins, and scripts
    // spend cents only through buyitem
    const cost = innRefreshCost(game);
    if (!cost.item) return miss(env, `not refreshed: ${cost.text} — buy a Hero Hunting with buyitem first (buyitem Hero Hunting)`);
    env.log(`  refresh the inn: ${cost.text}`);
    if (env.dryRun) { env.log('  [dry run] would refresh the inn'); return {}; }
    // hero.refreshHerosListFromTavern {castleId} (HeroCommand.as:225-234; Tavern.as:515-528)
    const rr = await game.refreshTavern(cid);
    env.log('  refresh -> ' + env.say(rr));
    done++;
  }
  const d = await game.tavernList(cid);
  const list = d.heros || [];
  if (!list.length) { env.log('  inn is empty'); return { done }; }
  for (const h of list) {
    const dom = Game.dominant(h);
    env.log(`  ${String(h.name).padEnd(14)} L${String(h.level).padEnd(4)} atk ${String(Game.attrValue(h, 'power')).padStart(4)}  pol ${String(Game.attrValue(h, 'management')).padStart(4)}  int ${String(Game.attrValue(h, 'stratagem')).padStart(4)}  [${attrLabel(dom)}]`);
  }
  return { done };
}

async function runStone(a, env) {
  const ok = await require('./stone-of-finding').run(env.game, a, { castle: env.opts.castle, dryRun: env.dryRun, log: env.log });
  return { done: ok && a.cmd === 'recover' ? 1 : 0, ok: !!ok || env.dryRun };
}

// NEAT's medal names (items.js MEDALS): nation medal, nationmedal, nation.
function medalByWord(word) {
  const w = lc(word).replace(/[\s_'-]/g, '');
  for (const [id, name] of Object.entries(require('./items').MEDALS)) {
    const full = lc(name).replace(/\s/g, '');
    if (w === full || w === full + 's' || w === full.replace(/medal$/, '')) return id;
  }
  return null;
}

const listLine = (c, h) => `${c.name} ${h.name} Lvl:${num(h.level)} [P:${Math.floor(num(h.management))} A:${Math.floor(num(h.power))} I:${Math.floor(num(h.stratagem))}]`
  + ` exp:${known(h.experience) ? Math.floor(num(h.experience)) : '?'}/${known(h.upgradeExp) ? Math.floor(num(h.upgradeExp)) : '?'}`
  + (isPrisoner(h) ? ' (prisoner)' : '');

const commands = {
  heroes: {
    aliases: ['herolist'],
    usage: 'heroes',
    parse: () => ({ cmd: 'heroes' }),
    async run(a, env) {
      const castle = env.castle;
      const hs = castle.heros || [];
      if (!hs.length) { env.log('  no heroes in this city'); return {}; }
      for (const h of hs) {
        const dom = Game.dominant(h);
        env.log(`  ${String(h.name).padEnd(14)} L${String(h.level).padEnd(4)} atk ${String(Game.attrValue(h, 'power')).padStart(4)}  pol ${String(Game.attrValue(h, 'management')).padStart(4)}  int ${String(Game.attrValue(h, 'stratagem')).padStart(4)}  loyalty ${h.loyalty ?? '?'}  unspent ${h.remainPoint || 0}  [${attrLabel(dom)} hero]`);
      }
      return {};
    },
  },

  // NEAT's ListAllHeroes line per hero, every city.
  listallheroes: {
    usage: 'listallheroes',
    parse(args) {
      if (String(args || '').trim()) throw new Error('listallheroes: nothing goes after it');
      return { cmd: 'listallheroes' };
    },
    async run(a, env) {
      const lines = [];
      for (const c of env.game.castles || []) for (const h of c.heros || []) lines.push(listLine(c, h));
      if (!lines.length) { env.log('  no heroes in any city'); return { result: '' }; }
      for (const l of lines) env.log('  ' + l);
      return { result: lines.join('\n') };
    },
  },

  inn: { aliases: ['tavern'], usage: 'inn', parse: () => ({ cmd: 'inn' }), run: runInn },
  // innrefresh — spends a held Hero Hunting; with none it does nothing (the
  // server would charge game coins, and only buyitem spends cents)
  innrefresh: {
    aliases: ['refreshinn'],
    usage: 'innrefresh   (spends a Hero Hunting you hold)',
    parse(args, { word, tok }) {
      const extra = tok.slice(1).map((t) => t.toLowerCase());
      if (extra.includes('force')) {
        throw new Error(`${word} force: a refresh with no Hero Hunting held is paid in game coins, and scripts spend cents only through buyitem`
          + ' — buy a Hero Hunting with buyitem first (buyitem Hero Hunting), then innrefresh');
      }
      if (extra.length) throw new Error(`${word}: usage  innrefresh   — nothing goes after it (it spends a Hero Hunting you hold)`);
      return { cmd: 'innrefresh' };
    },
    run: runInn,
  },

  hire: {
    usage: 'hire <hero> | hire best [attack|politics|intel]',
    parse(args, { tok }) {
      if (!tok[1]) throw new Error('hire: give a hero name, or "best" / "best politics"');
      if (tok[1].toLowerCase() === 'best') {
        const attr = tok[2] ? ATTR[(tok[2] || '').toLowerCase()] : null;
        if (tok[2] && !attr) throw new Error('hire best: attribute must be attack/politics/intel');
        return { cmd: 'hire', best: true, attr };
      }
      return { cmd: 'hire', name: tok.slice(1).join(' ') };
    },
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      const cid = game.castleId(castle);
      let d = null;
      try { d = await game.tavernList(cid); } catch (e) {
        if (a.best) throw e;
        // what the hero asks (gold, a jewel) is only on the list: nothing goes out unseen
        return miss(env, `not hired: the inn's list did not come (${e.message}), so what hiring ${a.name} costs is not known`);
      }
      const list = (d && d.heros) || [];
      let h = null;
      if (a.best) {
        if (!list.length) return miss(env, 'inn is empty, nothing to hire');
        const key = a.attr || null;
        const scored = list.map((x) => ({ h: x, v: key ? Game.attrValue(x, key) : Math.max(Game.attrValue(x, 'power'), Game.attrValue(x, 'management'), Game.attrValue(x, 'stratagem')) }));
        scored.sort((x, y) => y.v - x.v);
        h = scored[0].h;
        env.log(`  best${a.attr ? ' ' + a.attr : ''} in the inn: ${h.name} (${scored[0].v})`);
      } else if (d) {
        h = list.find((x) => lc(x.name) === lc(a.name));
        if (!h) return miss(env, `no hero named "${a.name}" in the inn${list.length ? ' — it has ' + list.map((x) => x.name).join(', ') : ''}`);
      }
      const name = h ? h.name : a.name;
      if (h) {
        const c = hireCheck(game, castle, h, d && d.posCount);
        if (c.why) return miss(env, `not hired: ${c.why}`);
        env.log(`  hire ${name} — costs ${c.cost}`);
      } else env.log(`  hire ${name}`);
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      // hero.hireHero {castleId, heroName} (HeroCommand.as:78-88; HireHero.as:524-527)
      const r = await game.hireHero(cid, name);
      env.log('  -> ' + env.say(r));
      return { done: 1, result: r && r.ok === 1 ? name : '' };
    },
  },

  // NEAT: "recruit the best hero of the type specified that is available in the
  // inn". Best is by base — what the hero grows from — then by the attribute
  // now; a better one that cannot be hired (gold, a jewel) is passed over, named.
  findhero: {
    usage: 'findhero atk|pol|int',
    parse(args, { word, tok }) {
      const attr = ATTR_WORD[lc(tok[1])];
      if (!attr || tok.length > 2) throw new Error(`${word}: usage  findhero atk | pol | int   (also power att attack, management politics, stratagem intel intelligence)`);
      return { cmd: 'findhero', attr };
    },
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      const cid = game.castleId(castle);
      const label = attrLabel(a.attr);
      const d = await game.tavernList(cid);
      if (d && d.ok !== undefined && d.ok !== 1) return miss(env, `the inn's list was refused: ${env.verdict(d)}`);
      const list = (d && d.heros) || [];
      if (!list.length) return miss(env, 'the inn is empty — nothing to hire');
      if (known(d.posCount) && Number(d.posCount) < 1) return miss(env, `not hired: the Feasting Hall in ${castle.name} has no free slot — fire a hero first`);
      const base = (h) => H.baseOf(h, a.attr);
      const ranked = list.slice().sort((x, y) => base(y) - base(x)
        || Game.attrValue(y, a.attr) - Game.attrValue(x, a.attr) || num(x.level) - num(y.level));
      const about = (h) => `${h.name} (L${h.level}, ${label} ${Game.attrValue(h, a.attr)}, base ${base(h)})`;
      let pick = null;
      for (const h of ranked) {
        const c = hireCheck(game, castle, h, null);
        if (c.why) { env.log(`  ${about(h)} passed over: ${c.why}`); continue; }
        pick = { h, cost: c.cost };
        break;
      }
      if (!pick) return miss(env, `not hired: no hero in the inn can be hired now`);
      env.log(`  best ${label} hero in the inn: ${about(pick.h)} — costs ${pick.cost}`);
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      // hero.hireHero {castleId, heroName} (HeroCommand.as:78-88; HireHero.as:524-527)
      const r = await game.hireHero(cid, pick.h.name);
      env.log('  -> ' + env.say(r));
      return { done: 1, result: r && r.ok === 1 ? pick.h.name : '' };
    },
  },

  fire: { aliases: ['firehero'], usage: 'fire <hero> | firehero <hero string> all', parse: parseDismiss('fire'), run: runDismiss },
  release: { aliases: ['releasehero'], usage: 'release <prisoner> | releasehero <hero string> all', parse: parseDismiss('release'), run: runDismiss },

  mayor: {
    aliases: ['appoint', 'setmayorbyname'],
    usage: 'mayor <hero>',
    parse(args, { word, tok }) {
      if (!tok[1]) throw new Error(`${word}: give a hero name`);
      return { cmd: 'mayor', name: oneHero(word, tok.slice(1).join(' '), ' (the best one by an attribute: setmayor pol)') };
    },
    async run(a, env) {
      const castle = env.castle;
      const h = findOne(env, castle, a.name);
      if (!h) return miss(env, `no hero named "${a.name}" in ${castle.name}`);
      return appoint(env, castle, h, '');
    },
  },

  // setmayor att|pol|int — the hero with the most of it among those who may be
  // mayor (idle, or mayor now); setmayor none|remove — no mayor.
  setmayor: {
    usage: 'setmayor att|pol|int | setmayor none|remove',
    parse(args, { word, tok }) {
      const w = lc(tok[1]);
      if (tok.length === 2 && (w === 'none' || w === 'remove')) return { cmd: 'unmayor' };
      const attr = ATTR_WORD[w];
      if (!attr || tok.length > 2) throw new Error(`${word}: usage  setmayor att | pol | int | none   (also atk attack, politics, intel intelligence, remove) — a hero by name: setmayorbyname <hero>`);
      return { cmd: 'setmayor', attr };
    },
    async run(a, env) {
      const castle = env.castle;
      const label = attrLabel(a.attr);
      const cands = (castle.heros || []).filter((h) => !refusal('mayor', h) && !busyWhy(env, h));
      if (!cands.length) return miss(env, `no hero in ${castle.name} can be mayor — none is idle at home`);
      const best = cands.slice().sort((x, y) => Game.attrValue(y, a.attr) - Game.attrValue(x, a.attr) || num(y.level) - num(x.level))[0];
      env.log(`  most ${label}: ${best.name} (${label} ${Game.attrValue(best, a.attr)}, L${best.level})`);
      return appoint(env, castle, best, '');
    },
  },

  unmayor: {
    aliases: ['unappoint', 'dischargemayor'],
    usage: 'unmayor',
    parse: () => ({ cmd: 'unmayor' }),
    run: removeMayor,
  },

  // hero.tryGetSeizedHero {castleId, heroId} (HeroCommand.as:253-263), sent by
  // the prisoner's Persuade button, which asks level x 1,000 gold plus
  // itemAmount of its itemId medal (HeroProperties.as:1468-1470, 1746-1748).
  persuadehero: {
    aliases: ['persuade'],
    usage: 'persuadehero <prisoner>',
    parse: (args, { word, tok }) => ({ cmd: 'persuadehero', name: oneHero(word, tok.slice(1).join(' ')) }),
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      const h = findOne(env, castle, a.name);
      if (!h) return miss(env, `no hero named "${a.name}" in ${castle.name}`);
      const no = refusal('persuade', h);
      if (no) return miss(env, `not sent: ${no}`);
      const gold = num(h.level) * 1000;
      const medal = h.itemId && num(h.itemAmount) > 0 ? { id: String(h.itemId), n: num(h.itemAmount) } : null;
      env.log(`  persuade ${h.name} (id ${h.id}, L${h.level}) to join you — costs ${fmt(gold)} gold${medal ? ` and ${medal.n} x ${itemName(medal.id)}` : ''}`);
      const have = goldOf(castle);
      if (have !== null && have < gold) return miss(env, `not sent: ${castle.name} has ${fmt(have)} gold of the ${fmt(gold)}`);
      if (medal) {
        // an unknown count is none held: nothing that could cost cents goes out unseen
        const held = heldCount(game, medal.id);
        if (held === null) return miss(env, `not sent: it asks for ${medal.n} x ${itemName(medal.id)}, and the inventory has not loaded, so whether they are held cannot be checked`);
        if (held < medal.n) return miss(env, `not sent: ${held} x ${itemName(medal.id)} held of the ${medal.n} it asks for`);
      }
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      const r = await game.req('hero.tryGetSeizedHero', { castleId: game.castleId(castle), heroId: h.id });
      env.log('  -> ' + env.say(r));
      return { done: 1, result: r && r.ok === 1 ? h.name : '' };
    },
  },

  // Every hero of ours under 100 loyalty, lowest first, one gold reward each —
  // the client charges level x 100 (AwardHero.as:562, 690-693) — while the
  // city's gold lasts.
  rewardheroes: {
    usage: 'rewardheroes',
    parse(args) {
      if (String(args || '').trim()) throw new Error('rewardheroes: nothing goes after it');
      return { cmd: 'rewardheroes' };
    },
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      const cid = game.castleId(castle);
      const want = (castle.heros || [])
        .filter((h) => !refusal('reward', h) && known(h.loyalty) && Number(h.loyalty) < 100)
        .sort((x, y) => num(x.loyalty) - num(y.loyalty));
      if (!want.length) { env.log(`  every hero in ${castle.name} is at 100 loyalty — nothing to reward`); return { result: 0 }; }
      let gold = goldOf(castle);
      const plan = [];
      for (const h of want) {
        const cost = num(h.level) * 100;
        if (gold !== null && cost > gold) { env.log(`  ${h.name} (loyalty ${h.loyalty}) — left out: its reward is ${fmt(cost)} gold and ${fmt(gold)} is left`); continue; }
        if (gold !== null) gold -= cost;
        plan.push({ h, cost });
      }
      if (!plan.length) return miss(env, `not sent: ${castle.name} has too little gold to reward anyone`);
      const total = plan.reduce((s, p) => s + p.cost, 0);
      env.log(`  ${plan.length} reward(s), ${fmt(total)} gold in all`);
      if (env.dryRun) {
        for (const { h, cost } of plan) env.log(`  reward ${h.name} (L${h.level}, loyalty ${h.loyalty}) — ${fmt(cost)} gold`);
        env.log('  [dry run] not sent');
        return {};
      }
      let done = 0, rewarded = 0;
      for (const { h, cost } of plan) {
        if (env.stopped()) break;
        // hero.awardGold {castleId, heroId} (HeroCommand.as:212-222; AwardHero.as:645-647)
        const r = await game.awardGold(cid, h.id);
        done++;
        if (r && r.ok === 1) rewarded++;
        env.log(`  reward ${h.name} (L${h.level}, loyalty ${h.loyalty}) — ${fmt(cost)} gold -> ${env.say(r)}`);
      }
      return { done, result: rewarded };
    },
  },

  // Finds the hero in whichever city it is; see rename-hero.js.
  renamehero: {
    aliases: ['changeheroname'],
    usage: 'renamehero <hero> <new name> [anyway]',
    parse: (args, { tok }) => ({ cmd: 'renamehero', ...require('./rename-hero').parseArgs(tok.slice(1)) }),
    async run(a, env) {
      const ok = await require('./rename-hero').run(env.game, a, { dryRun: env.dryRun, log: env.log });
      return { done: ok ? 1 : 0, ok: !!ok || env.dryRun };
    },
  },

  // Holy Water; the rest of the line goes whole, as /heropoints="..." may hold spaces.
  waterhero: {
    usage: 'waterhero <hero> [/heropoints="pol:300 att"]',
    parse: (args, { line, tok }) => ({ cmd: 'waterhero', ...require('./water-hero').parseArgs(line.slice(tok[0].length)) }),
    async run(a, env) {
      const hero = bangName(env, a.hero);
      const ok = await require('./water-hero').run(env.game, hero === a.hero ? a : { ...a, hero }, { dryRun: env.dryRun, log: env.log });
      return { done: ok ? 1 : 0, ok: !!ok || env.dryRun };
    },
  },

  levelup: {
    usage: 'levelup <hero|all> [attack|politics|intel|auto]',
    parse(args, { tok }) {
      if (!tok[1]) throw new Error('levelup: give a hero name (or "all")');
      const last = (tok[tok.length - 1] || '').toLowerCase();
      let attr = null, nameToks = tok.slice(1);
      if (ATTR[last] || last === 'auto') { attr = last === 'auto' ? null : ATTR[last]; nameToks = tok.slice(1, -1); }
      const name = nameToks.join(' ');
      return { cmd: 'levelup', name: name.toLowerCase() === 'all' ? 'all' : oneHero('levelup', name), attr };
    },
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      const cid = game.castleId(castle);
      const one = a.name.toLowerCase() !== 'all';
      const targets = one ? [findOne(env, castle, a.name)].filter(Boolean) : (castle.heros || []);
      if (!targets.length) return miss(env, one ? `no hero named "${a.name}"` : `no heroes in ${castle.name}`);

      let done = 0;
      for (const h of targets) {
        const short = expWhy(h);
        const no = refusal('levelup', h) || (short && `${h.name} ${short}`);
        if (no) {
          if (one) return miss(env, `not sent: ${no}`);
          env.log(`  ${h.name}: left — ${no}`);
          continue;
        }
        const dom = a.attr || Game.dominant(h);
        const label = attrLabel(dom);
        env.log(`  ${h.name} L${h.level} -> level up, points go to ${label}${a.attr ? '' : ' (dominant)'}`);
        if (env.dryRun) { env.log('  [dry run] not sent'); continue; }

        // hero.levelUp {castleId, heroId} (HeroCommand.as:159-169)
        const r = await game.levelUpHero(cid, h.id);
        env.log('    levelUp -> ' + env.say(r));
        if (r.ok !== 1) continue;

        const fresh = (await game.heroAfter(castle, h.id)) || h;
        const pts = Number(fresh.remainPoint || 0);
        if (pts <= 0) { env.log('    no unspent points to assign'); done++; continue; }
        const alloc = { management: 0, power: 0, stratagem: 0 };
        alloc[dom] = pts;
        const ar = await game.addPoint(cid, fresh, alloc);   // increments; game.js converts to totals
        env.log(`    +${pts} ${label} -> ` + env.say(ar));
        done++;
      }
      return { done };
    },
  },

  // NEAT's UpLevelHeroes: every hero of this city, one level each, except those
  // nolevelheroes holds back and those without the experience; the new points
  // by the first heropoints rule that matches, else all to the best attribute.
  // Only with config hero:1 or more in the city's goals, as in NEAT.
  uplevelheroes: {
    usage: 'uplevelheroes',
    parse(args) {
      if (String(args || '').trim()) throw new Error('uplevelheroes: nothing goes after it — one hero: levelup <hero>');
      return { cmd: 'uplevelheroes' };
    },
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      const cid = game.castleId(castle);
      const parsed = cityGoals(env, castle);
      if (parsed) {
        const policy = H.heroPolicy(parsed.config || {});
        if (!policy.manage) return miss(env, `not levelled: uplevelheroes needs config hero:1 or more in ${castle.name}'s goals (${policy.why}) — or write  levelup all`);
      } else env.log('  (this run has no goals to read: config hero, nolevelheroes and heropoints are not applied)');
      const goals = (parsed && parsed.goals) || [];
      const heros = castle.heros || [];
      const noLevel = rulesFor(goals, 'nolevelheroes');
      const pointRules = rulesFor(goals, 'heropoints').filter((g) => g.stages && g.stages.length);

      const ready = [];
      for (const h of heros) {
        if (isPrisoner(h)) continue;
        const held = noLevel.find((g) => H.matchHero(h, g.spec, heros));
        if (held) { env.log(`  ${h.name}: held back by nolevelheroes ${H.describeHeroString(held.spec)}`); continue; }
        const why = expWhy(h);
        if (why) { env.log(`  ${h.name} L${h.level}: ${why}`); continue; }
        ready.push(h);
      }
      if (!ready.length) { env.log(`  no hero in ${castle.name} is ready for a level`); return { result: 0 }; }

      let done = 0, levelled = 0;
      for (const h of ready) {
        if (env.stopped()) break;
        const rule = pointRules.find((g) => H.matchHero(h, g.spec, heros));
        const where = rule ? `by heropoints ${H.describeHeroString(rule.spec)} ${rule.stages.map((s) => s.raw).join(' ')}`
          : `to ${attrLabel(Game.dominant(h))}, its best`;
        env.log(`  ${h.name} L${h.level} -> L${num(h.level) + 1}, points ${where}`);
        if (env.dryRun) continue;
        // hero.levelUp {castleId, heroId} (HeroCommand.as:159-169)
        const r = await game.levelUpHero(cid, h.id);
        done++;
        env.log('    levelUp -> ' + env.say(r));
        if (!r || r.ok !== 1) continue;
        levelled++;
        const fresh = (await game.heroAfter(castle, h.id)) || h;
        const pts = num(fresh.remainPoint);
        if (pts <= 0) { env.log('    no unspent points to assign'); continue; }
        let add;
        if (rule) {
          const p = H.allocateStages(fresh, rule.stages, pts);
          if (p.off || p.spent <= 0) { env.log(`    ${pts} point(s) held — heropoints ${H.describeHeroString(rule.spec)} says off`); continue; }
          add = p.add;
        } else {
          add = { power: 0, management: 0, stratagem: 0 };
          add[Game.dominant(fresh)] = pts;
        }
        // hero.addPoint takes the new totals; game.addPoint converts (HeroProperties.as:1846)
        const ar = await game.addPoint(cid, fresh, add);
        done++;
        env.log(`    ${pointsText(add)} -> ` + env.say(ar));
      }
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      return { done, result: levelled };
    },
  },

  addpoint: {
    aliases: ['addpoints'],
    usage: 'addpoint <hero> <attack|politics|intel> <n>',
    parse(args, { tok }) {
      const attr = ATTR[(tok[tok.length - 2] || '').toLowerCase()];
      const n = parseInt(tok[tok.length - 1], 10);
      if (!attr || Number.isNaN(n)) throw new Error('addpoint: usage  addpoint <hero> <attack|politics|intel> <n>');
      return { cmd: 'addpoint', name: oneHero('addpoint', tok.slice(1, -2).join(' ')), attr, amount: n };
    },
    async run(a, env) {
      const game = env.game;
      const castle = env.castle;
      const h = findOne(env, castle, a.name);
      if (!h) return miss(env, `no hero named "${a.name}"`);
      const no = refusal('addpoint', h);
      if (no) return miss(env, `not sent: ${no}`);
      const label = attrLabel(a.attr);
      env.log(`  ${h.name}: +${a.amount} ${label} (unspent ${h.remainPoint || 0})`);
      if (env.dryRun) { env.log('  [dry run] not sent'); return {}; }
      const alloc = { management: 0, power: 0, stratagem: 0 };
      alloc[a.attr] = a.amount;
      const r = await game.addPoint(game.castleId(castle), h, alloc);   // increments; game.js converts to totals
      env.log('  -> ' + env.say(r));
      return { done: 1 };
    },
  },

  // useheroitem OTTO excalibur repeat 5    (NEAT spelling)
  // useheroitem OTTO excalibur 5           (same thing)
  // useheroitem OTTO nation medal          (the nine medals by name, items.js)
  // useheroitem OTTO hero.power.1          (ids always work)
  useheroitem: {
    aliases: ['heroitem'],
    usage: 'useheroitem <hero> <item> [repeat <n>]',
    parse(args, { line, tok }) {
      const HI = require('./heroitems');
      // useheroitem <hero> holy water /heropoints="pol" — the switch is waterhero's
      const WH = require('./water-hero');
      const sw = line.match(WH.SWITCH);
      const hp = tok.findIndex((t, i) => i > 1 && /^\/?heropoints\b/i.test(String(t)));
      if (sw && hp !== -1) tok = tok.slice(0, hp);
      if (!tok[1] || !tok[2]) {
        throw new Error('useheroitem: usage  useheroitem <hero> <item> [repeat <n>]  |  items: '
          + Object.values(HI.ALL).map((d) => d.names[0]).join(', ') + ', or a medal: nation medal …');
      }
      const rest = tok.slice(2);
      let times = 1;
      const ri = rest.findIndex((t) => String(t).toLowerCase() === 'repeat');
      if (ri !== -1) { times = parseInt(rest[ri + 1] || '1', 10) || 1; rest.splice(ri, 2); }
      else if (/^\d+$/.test(rest[rest.length - 1] || '')) times = parseInt(rest.pop(), 10) || 1;
      const word = rest.join('');
      const itemId = HI.resolveItem(word) || medalByWord(word);
      if (!itemId) {
        throw new Error(`useheroitem: unknown item "${rest.join(' ')}". Known: `
          + Object.values(HI.ALL).map((d) => d.names[0]).join(', ')
          + ', the medals by name (nation medal, cross medal …) — or give the raw id, e.g. hero.power.1');
      }
      if (times < 1 || times > 500) throw new Error('useheroitem: repeat must be between 1 and 500');
      // The client resets through hero.resetPoint, never hero.useItem.
      if (itemId === WH.ITEM_ID) {
        if (times !== 1) throw new Error('useheroitem: Holy Water resets a hero once — a second one only costs more. Use  waterhero <hero>');
        return { cmd: 'waterhero', ...WH.parseArgs(sw && hp !== -1 ? `${tok[1]} ${line.slice(sw.index)}` : tok[1]) };
      }
      if (sw && hp !== -1) throw new Error('useheroitem: /heropoints only goes with Holy Water');
      return { cmd: 'useheroitem', heroName: tok[1], itemId, times };
    },
    async run(a, env) {
      const HI = require('./heroitems');
      const heroName = bangName(env, a.heroName);
      const label = HI.ALL[a.itemId] ? HI.describeItem(a.itemId) : itemName(a.itemId);
      // heroitems.js takes the first city holding the name; so does this check
      const found = heroAnywhere(env.game, heroName);
      const no = found && refusal('item', found.hero);
      if (no) return miss(env, `not sent: ${no} — hero items cannot be used on a captured hero`);
      env.log(`  ${heroName} <- ${a.times} x ${label}`);
      if (env.dryRun) { env.log('  [dry run] nothing sent'); return {}; }
      // hero.useItem {castleId, heroId, itemId} (HeroCommand.as:145-156; AwardHero.as:662, AwardJewelry.as:296)
      const r = await HI.useOnHero(env.game, { heroName, itemId: a.itemId, times: a.times, log: env.log });
      if (!r.ok && !r.used) return miss(env, r.error);
      const d = (k) => (r.after[k] - r.before[k]);
      const moved = ['power', 'management', 'stratagem', 'experience']
        .filter((k) => d(k) !== 0)
        .map((k) => `${k} ${r.before[k]} -> ${r.after[k]} (+${d(k)})`);
      const spent = r.heldBefore !== undefined && r.heldAfter !== undefined
        ? `, ${r.heldBefore} -> ${r.heldAfter} left` : '';
      env.log(`  used ${r.used} on ${r.hero} in ${r.castle}${spent}`
        + (moved.length
          ? ' — ' + moved.join(', ')
          : ' — the server accepted and consumed it, but reports no change to the'
            + ' hero attributes it sends us'));
      if (r.error) env.log('  ' + r.error);
      return { done: 1, ok: !r.error, error: r.error || undefined };
    },
  },

  heroitems: {
    usage: 'heroitems',
    parse: () => ({ cmd: 'heroitems' }),
    async run(a, env) {
      const HI = require('./heroitems');
      const rows = HI.heldHeroItems(env.game);
      if (!rows.length) { env.log('  no hero items in the inventory'); return { done: 1 }; }
      env.log('  hero items held:');
      for (const r of rows) env.log(`    ${String(r.count).padStart(6)}  ${r.label.padEnd(30)} ${r.id}`);
      env.log('  use any of them with:  useheroitem <hero> <name or id> repeat <n>');
      return { done: 1 };
    },
  },

  // The Stone of Finding's restore window; see stone-of-finding.js.
  lostheroes: { usage: 'lostheroes', parse: () => ({ cmd: 'lostheroes' }), run: runStone },
  recover: {
    usage: 'recover <hero> [to <city>]',
    parse: (args, { tok }) => ({ cmd: 'recover', ...require('./stone-of-finding').parseArgs(tok.slice(1)) }),
    run: runStone,
  },
};

module.exports = { commands };
