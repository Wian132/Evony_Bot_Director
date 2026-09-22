'use strict';
// The hero commands (script-cmd-hero.js), offline, through the real VM:
// script.parse + script.run on a real Game whose game.req is stubbed. Every
// Usage and Example line of the wiki's hero pages is read here, and each
// command is run against a fake city to see what goes out.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-sh-')), 't.db');   // goals.js opens it
const C = require('./constants');
const { Game } = require('./game');
const script = require('./script');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const F = (x, y) => C.coordsToFieldId(x, y);
const parseErr = (line) => { try { script.parseLine(line); } catch (e) { return e.message; } return null; };
const errs = (src) => script.parse(src).filter((x) => x.cmd === 'error').map((x) => x.error);

// City 9: Ken (idle), QUEEN (mayor), Rider (marching), Bob (a prisoner we
// hold, asking 2 Nation Medals; base 80, over the captured default's 69), Smarty
// (intel, no experience to spare), Junk
// (low level, low base), Tiny (a low prisoner). Fla: Farmer1 and BigGuy.
function world({ gold = 500000, items = {}, replies = {}, inn = null } = {}) {
  const g = new Game();
  g.player = {
    playerInfo: { userName: 'Lord02' },
    items: Object.entries({ 'hero.loyalty.9': 1, 'player.experience.1.c': 3, 'hero.reset.1': 50, ...items }).map(([id, count]) => ({ id, count })),
  };
  g.castles = [
    { id: 1, name: '9', fieldId: F(571, 648), resource: { gold }, heros: [
      { id: 11, name: 'Ken', status: 0, level: 40, power: 120, management: 30, stratagem: 20, loyalty: 80, experience: 200000, upgradeExp: 160000, remainPoint: 0 },
      { id: 12, name: 'QUEEN', status: 1, level: 193, power: 67, management: 254, stratagem: 21, loyalty: 100, experience: 4737560, upgradeExp: 3724900, remainPoint: 0 },
      { id: 13, name: 'Rider', status: 3, level: 60, power: 200, management: 10, stratagem: 10, loyalty: 90, experience: 500000, upgradeExp: 360000 },
      { id: 14, name: 'Bob', status: 4, level: 90, power: 170, management: 10, stratagem: 12, loyalty: 10, itemId: 'hero.loyalty.9', itemAmount: 2, experience: 1e7, upgradeExp: 810000 },
      { id: 15, name: 'Smarty', status: 0, level: 30, power: 20, management: 40, stratagem: 90, loyalty: 100, experience: 10, upgradeExp: 90000 },
      { id: 16, name: 'Junk', status: 0, level: 10, power: 55, management: 20, stratagem: 10, loyalty: 60, experience: 20000, upgradeExp: 10000, remainPoint: 0 },
      { id: 17, name: 'Tiny', status: 4, level: 5, power: 30, management: 5, stratagem: 5, loyalty: 0 },
    ] },
    { id: 2, name: 'Fla', fieldId: F(484, 619), resource: { gold: 5 }, heros: [
      { id: 21, name: 'Farmer1', status: 0, level: 297, power: 363, management: 27, stratagem: 21, experience: 10180331, upgradeExp: 8820900 },
      { id: 22, name: 'BigGuy', status: 0, level: 346, power: 414, management: 21, stratagem: 46, experience: 8467980, upgradeExp: 11971600 },
    ] },
  ];
  const hero = (id) => g.castles.flatMap((c) => c.heros).find((h) => h.id === id);
  const INN = inn || { ok: 1, posCount: 2, heros: [
    { id: 91, name: 'Brawn', level: 60, power: 130, powerAdded: 59, management: 20, stratagem: 15 },      // base 71
    { id: 92, name: 'Veteran', level: 90, power: 160, powerAdded: 89, management: 30, stratagem: 20 },    // base 71, more attack now
    { id: 93, name: 'Kid', level: 5, power: 76, powerAdded: 4, management: 10, stratagem: 12, itemId: 'hero.loyalty.3', itemAmount: 1 },   // base 72, but a jewel
    { id: 94, name: 'Clerk', level: 20, power: 20, management: 85, managementAdded: 19, stratagem: 30 },  // base pol 66
  ] };
  const sent = [];
  const R = {
    'hero.getHerosListFromTavern': () => INN,
    'hero.refreshHerosListFromTavern': () => INN,
    'hero.levelUp': (d) => { const h = hero(d.heroId); h.level++; h.remainPoint = num(h.remainPoint) + 10; return { ok: 1 }; },
    'hero.useItem': (d) => { const it = g.player.items.find((i) => i.id === d.itemId); if (it) it.count--; return { ok: 1 }; },
    ...replies,
  };
  g.req = async (cmd, data) => {
    sent.push({ cmd, data });
    const r = R[cmd];
    return typeof r === 'function' ? r(data) : (r || { ok: 1 });
  };
  g.heroAfter = async (castle, id) => (castle.heros || []).find((h) => h.id === id) || null;
  return { g, sent, hero };
}
const num = (x) => Number(x || 0);

// The console's goal store, for one city's goals.
const session = (w, goals) => ({ account: { id: 'a1' }, org: { goals: { own: (acc, id, name) => (goals[name] === undefined ? null : { src: goals[name] }) } } });
// The goals branch's store: layers(), so the script's own goal layer counts too.
const layered = (goals) => ({ account: { id: 'a1' }, org: { goals: {
  own: (acc, id, name) => (goals[name] === undefined ? null : { src: goals[name] }),
  layers: (acc, id, name) => ({ city: goals[name] || null, prepend: null, append: null }),
} } });

// `see($error, $result)` in a script hands the two to the test as they are.
async function runIn(w, src, opts = {}) {
  const out = [], seen = [];
  const acts = script.parse(src, { globals: { see: (e, r) => { seen.push([e, r]); } } });
  const bad = acts.filter((a) => a.cmd === 'error');
  if (bad.length) throw new Error('parse: ' + bad.map((b) => `line ${b.line}: ${b.error}`).join('; '));
  const done = await script.run(w.g, acts, (m) => out.push(m),
    { castle: '9', repeatGapMs: 0, globals: { see: (e, r) => { seen.push([e, r]); } }, ...opts });
  return { done, out, text: out.join('\n'), seen };
}
const cmds = (w) => w.sent.map((s) => s.cmd);
const writes = (w) => w.sent.filter((s) => !/getHerosListFromTavern/.test(s.cmd));
// what $error and $result held after the line above
const TAIL = '\nsee($error, $result)';
const tail = (r) => { const last = r.seen[r.seen.length - 1]; return last ? [last[0] == null ? '' : String(last[0]), last[1]] : []; };
const noError = (e) => !e;

// ---------------------------------------------------------------------------
section('the wiki lines read');

t('ChangeHeroName and RenameHero read the same', () => {
  const want = { cmd: 'renamehero', hero: 'ken', name: 'henry', anyway: false };
  assert.deepStrictEqual(script.parseLine('changeheroname ken henry'), want);
  assert.deepStrictEqual(script.parseLine('renamehero ken henry'), want);
  assert.deepStrictEqual(script.parseLine('ChangeHeroName ken henry'), want);
});
t('FindHero: every argument word', () => {
  for (const [w, attr] of [['atk', 'power'], ['power', 'power'], ['att', 'power'], ['attack', 'power'],
    ['pol', 'management'], ['management', 'management'], ['politics', 'management'],
    ['int', 'stratagem'], ['stratagem', 'stratagem'], ['intel', 'stratagem'], ['intelligence', 'stratagem']]) {
    assert.deepStrictEqual(script.parseLine('findhero ' + w), { cmd: 'findhero', attr }, w);
  }
  assert.match(parseErr('findhero'), /findhero atk \| pol \| int/);
  assert.match(parseErr('findhero wisdom'), /findhero atk \| pol \| int/);
});
t('FireHero: a name, and a hero string only with all', () => {
  assert.deepStrictEqual(script.parseLine('firehero Ken'), { cmd: 'fire', name: 'Ken' });
  assert.deepStrictEqual(script.parseLine('fire Sir Ken'), { cmd: 'fire', name: 'Sir Ken' }, 'OTTObot\'s fire keeps names with spaces');
  assert.match(parseErr('firehero any:level<50'), /name the hero — "any:level<50" is refused here, so a slip cannot pick whichever hero is listed first; to fire every hero it matches, end the line with all: {2}firehero any:level<50 all/);
  assert.deepStrictEqual(script.parseLine('firehero any:level<50 all'), { cmd: 'fire', heroes: 'any:level<50', all: true });
  assert.match(parseErr('firehero !Ken'), /can pick more than one hero, and a fired hero is gone for good/);
  assert.match(parseErr('firehero bob,fred'), /can pick more than one hero/);
  assert.match(parseErr('firehero any:levle<50 all'), /unknown hero field "levle"/);
  assert.match(parseErr('firehero none all'), /picks no hero/);
  assert.match(parseErr('fire all'), /put a hero string before all/);
  assert.match(parseErr('firehero'), /give a hero name/);
});
t('the goals branch\'s one-hero rule: fire/release/mayor/levelup/addpoint refuse any', () => {
  for (const l of ['fire any', 'release any', 'mayor any', 'appoint any:pol>100', 'levelup any', 'levelup any attack', 'addpoint any attack 5', 'persuadehero any']) {
    assert.match(parseErr(l), /name the hero — "any[^"]*" is refused here, so a slip cannot pick whichever hero is listed first/, l);
  }
  assert.match(parseErr('levelup attack'), /give a hero name/, 'a bare attribute no longer means the first hero');
  assert.deepStrictEqual(script.parseLine('levelup all'), { cmd: 'levelup', name: 'all', attr: null });
  assert.deepStrictEqual(script.parseLine('levelup all politics'), { cmd: 'levelup', name: 'all', attr: 'management' });
});
t('ListAllHeroes', () => {
  assert.deepStrictEqual(script.parseLine('ListAllHeroes'), { cmd: 'listallheroes' });
  assert.match(parseErr('listallheroes now'), /nothing goes after it/);
});
t('PersuadeHero', () => {
  assert.deepStrictEqual(script.parseLine('persuadehero Ken'), { cmd: 'persuadehero', name: 'Ken' });
  assert.match(parseErr('persuadehero'), /give a hero name/);
});
t('ReleaseHero: a name, and a hero string only with all', () => {
  assert.deepStrictEqual(script.parseLine('releasehero Bob'), { cmd: 'release', name: 'Bob' });
  assert.match(parseErr('releasehero any:level<100'), /to release every prisoner it matches, end the line with all: {2}releasehero any:level<100 all/);
  assert.deepStrictEqual(script.parseLine('releasehero any:level<100 all'), { cmd: 'release', heroes: 'any:level<100', all: true });
});
t('RewardHeroes, UpLevelHeroes', () => {
  assert.deepStrictEqual(script.parseLine('rewardheroes'), { cmd: 'rewardheroes' });
  assert.deepStrictEqual(script.parseLine('uplevelheroes'), { cmd: 'uplevelheroes' });
  assert.match(parseErr('uplevelheroes Ken'), /one hero: levelup <hero>/);
});
t('SetMayor: every valid argument', () => {
  for (const [w, attr] of [['att', 'power'], ['atk', 'power'], ['attack', 'power'], ['pol', 'management'], ['politics', 'management'],
    ['int', 'stratagem'], ['intel', 'stratagem'], ['intelligence', 'stratagem']]) {
    assert.deepStrictEqual(script.parseLine('setmayor ' + w), { cmd: 'setmayor', attr }, w);
  }
  assert.deepStrictEqual(script.parseLine('setmayor remove'), { cmd: 'unmayor' });
  assert.deepStrictEqual(script.parseLine('setmayor none'), { cmd: 'unmayor' });
  assert.match(parseErr('setmayor Ken'), /a hero by name: setmayorbyname <hero>/);
  // the page's own example block, comments and all
  const page = '// appoints highest politic hero to mayor\nsetmayor pol\n\n// appoints highest attack hero to mayor\nsetmayor att\n'
    + '// appoints highest intel hero to mayor\nsetmayor int\n\n// demotes current mayor\nsetmayor remove\nsetmayor none';
  assert.deepStrictEqual(errs(page), []);
});
t('SetMayorByName', () => {
  assert.deepStrictEqual(script.parseLine('setMayorbyname Henry'), { cmd: 'mayor', name: 'Henry' });
  assert.deepStrictEqual(script.parseLine('setMayorbyname !HeroName'), { cmd: 'mayor', name: '!HeroName' }, 'the wiki\'s ! is read past when it runs');
  assert.deepStrictEqual(script.parseLine('appoint Henry'), { cmd: 'mayor', name: 'Henry' });
  assert.match(parseErr('setmayorbyname bob,fred'), /one hero, by its name/);
});
t('UseHeroItem: the three examples, the medal by name', () => {
  assert.deepStrictEqual(script.parseLine('useheroitem !BigGuy on war'), { cmd: 'useheroitem', heroName: '!BigGuy', itemId: 'player.experience.1.c', times: 1 });
  assert.deepStrictEqual(script.parseLine('useheroitem !BigGuy anabasis'), { cmd: 'useheroitem', heroName: '!BigGuy', itemId: 'player.experience.1.a', times: 1 });
  assert.deepStrictEqual(script.parseLine('useheroitem !BigGuy nation medal'), { cmd: 'useheroitem', heroName: '!BigGuy', itemId: 'hero.loyalty.9', times: 1 });
  assert.strictEqual(script.parseLine('useheroitem BigGuy cross medal repeat 3').itemId, 'hero.loyalty.1');
  assert.strictEqual(script.parseLine('useheroitem BigGuy justice').itemId, 'hero.loyalty.8');
  assert.strictEqual(script.parseLine('useheroitem BigGuy hero.loyalty.4').itemId, 'hero.loyalty.4', 'ids still work');
  assert.match(parseErr('useheroitem BigGuy bravery medal'), /unknown item "bravery medal"/);
});
t('WaterHero: every example on the page', () => {
  assert.deepStrictEqual(script.parseLine('waterhero !BigGuy'), { cmd: 'waterhero', hero: '!BigGuy', rule: null });
  for (const l of ['waterhero Smarty /heropoints="att"', 'waterhero billybob /heropoints="att"',
    'waterhero Robert1 /heropoints="pol:300,int:100 att"', 'waterhero Robert2 /heropoints="pol:300 int:100 att"']) {
    assert.strictEqual(script.parseLine(l).cmd, 'waterhero', l);
  }
  assert.strictEqual(script.parseLine('waterhero Robert2 /heropoints="pol:300 int:100 att"').rule.stages.length, 3);
});
t('innrefresh; innrefresh force is refused (it would pay game coins)', () => {
  assert.deepStrictEqual(script.parseLine('innrefresh'), { cmd: 'innrefresh' });
  assert.deepStrictEqual(script.parseLine('refreshinn'), { cmd: 'innrefresh' });
  assert.match(parseErr('refreshinn force'), /refreshinn force: a refresh with no Hero Hunting held is paid in game coins, and scripts spend cents only through buyitem — buy a Hero Hunting with buyitem first/);
  assert.match(parseErr('innrefresh force'), /buy a Hero Hunting with buyitem first \(buyitem Hero Hunting\), then innrefresh/);
  assert.match(parseErr('innrefresh now'), /usage {2}innrefresh {3}— nothing goes after it/);
});
t('the Stone of Finding lines read as before', () => {
  assert.deepStrictEqual(script.parseLine('recover Aldric'), { cmd: 'recover', hero: 'Aldric', to: null });
  assert.deepStrictEqual(script.parseLine('lostheroes'), { cmd: 'lostheroes' });
});

// ---------------------------------------------------------------------------
section('fire and release');

t('firehero Ken: hero.fireHero with the city and the hero', async () => {
  const w = world();
  const r = await runIn(w, 'firehero Ken' + TAIL);
  assert.deepStrictEqual(w.sent, [{ cmd: 'hero.fireHero', data: { castleId: 1, heroId: 11 } }], r.text);
  const [e, res] = tail(r);
  assert.ok(noError(e), 'no $error: ' + e);
  assert.strictEqual(res, 1);
});
t('a hero away from town, a prisoner, or one not here: nothing sent, and $error says why', async () => {
  for (const [line, why] of [['fire Rider', /Rider is marching, away from town — a hero is fired from the Feasting Hall, idle or mayor/],
    ['firehero Bob', /Bob is a prisoner you hold — a prisoner is dismissed with release, not fire/],
    ['fire Nobody', /no hero named "Nobody" in 9/]]) {
    const w = world();
    const r = await runIn(w, line + TAIL);
    assert.deepStrictEqual(w.sent, [], line);
    assert.match(tail(r)[0], why, line);
  }
});
t('two heroes share a name: fire <name> sends nothing and names both ids; fire <id> fires that one', async () => {
  const w = world();
  w.g.castles[0].heros.push({ id: 18, name: 'Ken', status: 0, level: 900, power: 1100, management: 30, stratagem: 20, loyalty: 100 });
  let r = await runIn(w, 'fire Ken' + TAIL);
  assert.deepStrictEqual(w.sent, [], 'nothing sent: the big Ken could be the one picked');
  assert.match(tail(r)[0], /2 heroes in 9 are named Ken \(id 11 L40, id 18 L900\) — fire one by its id/);
  r = await runIn(w, 'fire 11' + TAIL);
  assert.deepStrictEqual(w.sent, [{ cmd: 'hero.fireHero', data: { castleId: 1, heroId: 11 } }], r.text);
});
t('fire <id> works for a hero whose name is unique too', async () => {
  const w = world();
  await runIn(w, 'fire 16');
  assert.deepStrictEqual(w.sent, [{ cmd: 'hero.fireHero', data: { castleId: 1, heroId: 16 } }]);
});
t('the mayor may be fired (NEAT: idle, mayor)', async () => {
  const w = world();
  await runIn(w, 'fire QUEEN');
  assert.deepStrictEqual(cmds(w), ['hero.fireHero']);
});
t('a hero this script just sent on a march is left alone, before the server says it is away', async () => {
  const w = world();
  w.g.newArmy = async (castleId, bean) => { w.sent.push({ cmd: 'army.newArmy', data: { castleId, heroId: bean.heroId } }); return { ok: 1 }; };
  const r = await runIn(w, 'reinforce Fla Ken s:1\nfire Ken\nsetmayorbyname Ken' + TAIL);
  assert.deepStrictEqual(cmds(w).filter((c) => !/getTroopParam|getOtherFieldInfo/.test(c)), ['army.newArmy'], r.text);
  assert.match(r.text, /not sent: Ken was just sent on a march by this script/);
});
t('firehero any:level<50 all: only heroes no keep rule protects (the default keeps base 69+)', async () => {
  const w = world();
  const r = await runIn(w, 'firehero any:level<50 all' + TAIL);
  // base = Game.heroBase (top attribute − level + unspent points): Ken 80, Smarty 60, Junk 45
  assert.deepStrictEqual(writes(w).map((s) => s.data.heroId), [15, 16], r.text);
  assert.match(r.text, /Ken \(L40, base 80\): kept — keepheroes any:level>=50\|any:base>=69 \(the default\)/);
  assert.match(r.text, /fire Smarty \(id 15, L30\) -> ok/);
  assert.match(r.text, /fire Junk \(id 16, L10\) -> ok/);
  assert.doesNotMatch(r.text, /Bob|Tiny/, 'prisoners are not fired');
  assert.strictEqual(tail(r)[1], 2, '$result: how many went');
});
t('the city\'s keepheroes goal decides instead of the default', async () => {
  const w = world();
  const r = await runIn(w, 'firehero any:level<50 all', { session: session(w, { 9: 'keepheroes any:level>=35' }) });
  assert.deepStrictEqual(writes(w).map((s) => s.data.heroId), [15, 16], r.text);
  assert.match(r.text, /Ken \(L40, base 80\): kept — keepheroes any:level>=35$/m);
});
t('a dry run lists who would go and sends nothing', async () => {
  const w = world();
  const r = await runIn(w, 'firehero any:level<50 all', { dryRun: true });
  assert.deepStrictEqual(w.sent, []);
  assert.match(r.text, /fire Junk \(id 16, L10, base 45\)\n {2}\[dry run\] not sent/);
});
t('nothing matching is no failure', async () => {
  const w = world();
  const r = await runIn(w, 'firehero any:level>1000 all' + TAIL);
  assert.deepStrictEqual(w.sent, []);
  assert.match(r.text, /no hero in 9 matches any:level>1000 — nothing to fire/);
  assert.ok(noError(tail(r)[0]));
});
t('releasehero Bob: hero.releaseHero, with the Stone of Finding reminder', async () => {
  const w = world();
  const r = await runIn(w, 'releasehero Bob');
  assert.deepStrictEqual(w.sent, [{ cmd: 'hero.releaseHero', data: { castleId: 1, heroId: 14 } }]);
  assert.match(r.text, /a released prisoner leaves for good; if it is a hero of your own other account, bring it home with a Stone of Finding there instead: lostheroes, recover/);
});
t('release is only for a prisoner: one of our own heroes is never released', async () => {
  const w = world();
  const r = await runIn(w, 'release Ken' + TAIL);
  assert.deepStrictEqual(w.sent, []);
  assert.match(tail(r)[0], /Ken is not a prisoner \(idle\) — release only dismisses a prisoner you hold; fire dismisses your own hero/);
});
t('releasehero any:level<100 all: prisoners only, keepcapturedheroes (default) protects', async () => {
  const w = world();
  const r = await runIn(w, 'releasehero any:level<100 all' + TAIL);
  assert.deepStrictEqual(writes(w).map((s) => [s.cmd, s.data.heroId]), [['hero.releaseHero', 17]], r.text);
  assert.ok(r.text.includes(`Bob (L90, base 80): kept — keepcapturedheroes ${require('./goal-heroes').DEFAULT_KEEP_CAPTURED} (the default)`), r.text);
  assert.doesNotMatch(r.text, /release (Ken|Junk|Smarty)/);
  assert.strictEqual(tail(r)[1], 1);
});

// ---------------------------------------------------------------------------
section('mayor');

t('setmayorbyname Ken: hero.promoteToChief', async () => {
  const w = world();
  const r = await runIn(w, 'setMayorbyname Ken' + TAIL);
  assert.deepStrictEqual(w.sent, [{ cmd: 'hero.promoteToChief', data: { castleId: 1, heroId: 11 } }]);
  assert.strictEqual(tail(r)[1], 'Ken');
});
t('the wiki\'s !Name finds Name for one hero', async () => {
  const w = world();
  const r = await runIn(w, 'setMayorbyname !Ken');
  assert.deepStrictEqual(w.sent.map((s) => s.data.heroId), [11]);
  assert.match(r.text, /reading !Ken as Ken — the ! in the wiki only stops a wiki link/);
});
t('already mayor: nothing sent, and no error', async () => {
  const w = world();
  const r = await runIn(w, 'mayor QUEEN' + TAIL);
  assert.deepStrictEqual(w.sent, []);
  assert.match(r.text, /QUEEN is already mayor of 9/);
  assert.ok(noError(tail(r)[0]));
});
t('a marching hero or a prisoner is not made mayor', async () => {
  for (const [line, why] of [['mayor Rider', /Rider is marching, not idle at home — only an idle hero can be made mayor/],
    ['appoint Bob', /Bob is a prisoner you hold — only your own heroes can be mayor/]]) {
    const w = world();
    const r = await runIn(w, line + TAIL);
    assert.deepStrictEqual(w.sent, [], line);
    assert.match(tail(r)[0], why, line);
  }
});
t('setmayor att / int: the most of it among idle heroes and the mayor', async () => {
  const w = world();
  const r = await runIn(w, 'setmayor att\nsetmayor int');
  // Rider has 200 attack but is marching; Bob 170 but a prisoner
  assert.deepStrictEqual(w.sent.map((s) => [s.cmd, s.data.heroId]), [['hero.promoteToChief', 11], ['hero.promoteToChief', 15]], r.text);
  assert.match(r.text, /most attack: Ken \(attack 120, L40\)/);
});
t('setmayor pol when the best politics hero is mayor already: nothing sent', async () => {
  const w = world();
  const r = await runIn(w, 'setmayor pol');
  assert.deepStrictEqual(w.sent, []);
  assert.match(r.text, /QUEEN is already mayor of 9/);
});
t('setmayor remove / none: hero.dischargeChief, and nothing when there is no mayor', async () => {
  const w = world();
  await runIn(w, 'setmayor remove');
  assert.deepStrictEqual(w.sent, [{ cmd: 'hero.dischargeChief', data: { castleId: 1 } }]);
  const w2 = world();
  w2.hero(12).status = 0;
  const r = await runIn(w2, 'setmayor none\nunmayor');
  assert.deepStrictEqual(w2.sent, []);
  assert.match(r.text, /9 has no mayor — nothing to remove/);
});
t('dry run', async () => {
  const w = world();
  const r = await runIn(w, 'setmayor att\nsetmayor none', { dryRun: true });
  assert.deepStrictEqual(w.sent, []);
  assert.match(r.text, /appoint Ken as mayor of 9\n {2}\[dry run\] not sent/);
  assert.match(r.text, /remove the mayor of 9 \(QUEEN\)\n {2}\[dry run\] not sent/);
});

// ---------------------------------------------------------------------------
section('persuade and reward');

t('persuadehero Bob: the cost is said, the medals are checked, hero.tryGetSeizedHero goes out', async () => {
  const w = world({ items: { 'hero.loyalty.9': 2 } });
  const r = await runIn(w, 'persuadehero Bob' + TAIL);
  assert.deepStrictEqual(w.sent, [{ cmd: 'hero.tryGetSeizedHero', data: { castleId: 1, heroId: 14 } }], r.text);
  assert.match(r.text, /persuade Bob \(id 14, L90\) to join you — costs 90,000 gold and 2 x Nation Medal/);
  assert.strictEqual(tail(r)[1], 'Bob');
});
t('too few medals, too little gold, or not a prisoner: nothing sent', async () => {
  const cases = [
    [{}, 'persuadehero Bob', /not sent: 1 x Nation Medal held of the 2 it asks for/],
    [{ gold: 50000, items: { 'hero.loyalty.9': 5 } }, 'persuadehero Bob', /not sent: 9 has 50,000 gold of the 90,000/],
    [{}, 'persuadehero Ken', /Ken is not a prisoner \(idle\) — persuading is for a prisoner you hold/],
  ];
  for (const [o, line, why] of cases) {
    const w = world(o);
    const r = await runIn(w, line + TAIL);
    assert.deepStrictEqual(w.sent, [], line);
    assert.match(tail(r)[0], why, line);
  }
});
t('persuade dry run: the cost, nothing sent', async () => {
  const w = world({ items: { 'hero.loyalty.9': 2 } });
  const r = await runIn(w, 'persuadehero Tiny', { dryRun: true });
  assert.deepStrictEqual(w.sent, []);
  assert.match(r.text, /persuade Tiny \(id 17, L5\) to join you — costs 5,000 gold\n {2}\[dry run\] not sent/);
});
t('rewardheroes: our heroes under 100 loyalty, lowest first, level x 100 gold each', async () => {
  const w = world();
  const r = await runIn(w, 'rewardheroes' + TAIL);
  assert.deepStrictEqual(w.sent.map((s) => [s.cmd, s.data.heroId]), [['hero.awardGold', 16], ['hero.awardGold', 11], ['hero.awardGold', 13]], r.text);
  assert.deepStrictEqual(w.sent[0].data, { castleId: 1, heroId: 16 });
  assert.match(r.text, /3 reward\(s\), 11,000 gold in all/);
  assert.match(r.text, /reward Junk \(L10, loyalty 60\) — 1,000 gold -> ok/);
  assert.doesNotMatch(r.text, /Bob|Tiny|QUEEN|Smarty/, 'prisoners and loyal heroes are left out');
  assert.strictEqual(tail(r)[1], 3);
});
t('rewards stop where the gold does', async () => {
  const w = world({ gold: 5500 });
  const r = await runIn(w, 'rewardheroes');
  assert.deepStrictEqual(w.sent.map((s) => s.data.heroId), [16, 11], r.text);
  assert.match(r.text, /Rider \(loyalty 90\) — left out: its reward is 6,000 gold and 500 is left/);
  const poor = world({ gold: 10 });
  const r2 = await runIn(poor, 'rewardheroes' + TAIL);
  assert.deepStrictEqual(poor.sent, []);
  assert.match(tail(r2)[0], /too little gold to reward anyone/);
});
t('reward dry run', async () => {
  const w = world();
  const r = await runIn(w, 'rewardheroes', { dryRun: true });
  assert.deepStrictEqual(w.sent, []);
  assert.match(r.text, /reward Rider \(L60, loyalty 90\) — 6,000 gold\n {2}\[dry run\] not sent/);
});

// ---------------------------------------------------------------------------
section('listallheroes');

t('every city, NEAT\'s line, and the lines in $result', async () => {
  const w = world();
  const r = await runIn(w, 'ListAllHeroes' + TAIL);
  assert.deepStrictEqual(w.sent, []);
  assert.match(r.text, /^ {2}9 QUEEN Lvl:193 \[P:254 A:67 I:21\] exp:4737560\/3724900$/m);
  assert.match(r.text, /^ {2}Fla BigGuy Lvl:346 \[P:21 A:414 I:46\] exp:8467980\/11971600$/m);
  assert.match(r.text, /^ {2}9 Bob Lvl:90 .* \(prisoner\)$/m);
  assert.match(r.text, /^ {2}9 Tiny Lvl:5 \[P:5 A:30 I:5\] exp:\?\/\? \(prisoner\)$/m);
  const res = tail(r)[1].split('\n');
  assert.strictEqual(res.length, 9);
  assert.strictEqual(res[0], '9 Ken Lvl:40 [P:30 A:120 I:20] exp:200000/160000');
});
t('the command module can be called from an in-line command', async () => {
  const H = require('./script-cmd-hero');
  const spec = H.commands.listallheroes;
  const a = spec.parse('', { word: 'listallheroes', line: 'listallheroes', tok: ['listallheroes'] });
  const w = world();
  const logged = [];
  const res = await spec.run({ cmd: 'listallheroes', ...a }, { game: w.g, log: (m) => logged.push(m) });
  assert.strictEqual(res.result.split('\n').length, 9);
  assert.strictEqual(logged.length, 9);
});

// ---------------------------------------------------------------------------
section('the inn');

t('findhero atk: the best base attack that can be hired; a better one needing a jewel is passed over', async () => {
  const w = world();
  const r = await runIn(w, 'findhero atk' + TAIL);
  assert.deepStrictEqual(writes(w), [{ cmd: 'hero.hireHero', data: { castleId: 1, heroName: 'Veteran' } }], r.text);
  assert.match(r.text, /Kid \(L5, attack 76, base 72\) passed over: hiring Kid takes 1 x Lion Medal and 0 are held/);
  assert.match(r.text, /best attack hero in the inn: Veteran \(L90, attack 160, base 71\) — costs 90,000 gold/);
  assert.strictEqual(tail(r)[1], 'Veteran');
});
t('findhero pol, and a jewel that is held', async () => {
  const w = world({ items: { 'hero.loyalty.3': 1 } });
  await runIn(w, 'findhero pol\nfindhero power');
  assert.deepStrictEqual(writes(w).map((s) => s.data.heroName), ['Clerk', 'Kid']);
});
t('no free slot in the Feasting Hall, or too little gold: nothing sent', async () => {
  const w = world({ inn: { ok: 1, posCount: 0, heros: [{ id: 91, name: 'Brawn', level: 60, power: 130 }] } });
  const r = await runIn(w, 'findhero att' + TAIL);
  assert.deepStrictEqual(writes(w), []);
  assert.match(tail(r)[0], /no free slot — fire a hero first/);
  const poor = world({ gold: 1000 });
  const r2 = await runIn(poor, 'findhero int' + TAIL);
  assert.deepStrictEqual(writes(poor), []);
  assert.match(tail(r2)[0], /no hero in the inn can be hired now/);
});
t('a refused inn list is said as such, not as an empty inn', async () => {
  const w = world({ inn: { ok: -1, errorMsg: 'no inn in this city' } });
  const r = await runIn(w, 'findhero pol' + TAIL);
  assert.deepStrictEqual(writes(w), []);
  assert.match(tail(r)[0], /the inn's list was refused: FAILED \(ok=-1\) - no inn in this city/);
});
t('findhero dry run', async () => {
  const w = world();
  const r = await runIn(w, 'findhero atk', { dryRun: true });
  assert.deepStrictEqual(writes(w), []);
  assert.match(r.text, /costs 90,000 gold\n {2}\[dry run\] not sent/);
});
t('hire <name>: the inn\'s spelling, the cost said; one not in the inn is not sent', async () => {
  const w = world();
  const r = await runIn(w, 'hire brawn\nhire Nobody');
  assert.deepStrictEqual(writes(w), [{ cmd: 'hero.hireHero', data: { castleId: 1, heroName: 'Brawn' } }], r.text);
  assert.match(r.text, /hire Brawn — costs 60,000 gold/);
  assert.match(r.text, /no hero named "Nobody" in the inn — it has Brawn, Veteran, Kid, Clerk/);
});
t('the inventory not loaded: a hero asking for a jewel or medals is not hired or persuaded; the inn\'s list missing sends no hire', async () => {
  const w = world();
  w.g.player.items = undefined;
  const r = await runIn(w, 'hire Kid' + TAIL + '\npersuadehero Bob' + TAIL + '\nhire Brawn' + TAIL);
  assert.deepStrictEqual(writes(w), [{ cmd: 'hero.hireHero', data: { castleId: 1, heroName: 'Brawn' } }], 'Brawn asks for no jewel');
  assert.match(r.seen[0][0], /not hired: hiring Kid takes 1 x .*, and the inventory has not loaded, so whether they are held cannot be checked/);
  assert.match(r.seen[1][0], /not sent: it asks for 2 x Nation Medal, and the inventory has not loaded/);
  const f = world();
  f.g.player.items = undefined;
  await runIn(f, 'findhero atk');
  assert.deepStrictEqual(writes(f).map((s) => s.data.heroName), ['Veteran'], 'Kid (base 72, a jewel) is passed over while the inventory is unknown');
  const lost = world({ replies: { 'hero.getHerosListFromTavern': () => { throw new Error('no reply to hero.getHerosListFromTavern'); } } });
  const r2 = await runIn(lost, 'hire Brawn' + TAIL);
  assert.deepStrictEqual(writes(lost), []);
  assert.match(tail(r2)[0], /not hired: the inn's list did not come \(no reply to hero.getHerosListFromTavern\), so what hiring Brawn costs is not known/);
});
t('hire best keeps its ranking (the attribute now)', async () => {
  const w = world();
  await runIn(w, 'hire best attack');
  assert.deepStrictEqual(writes(w).map((s) => s.data.heroName), ['Veteran']);
});
t('innrefresh: a Hero Hunting is spent; with none, nothing goes (never game coins)', async () => {
  const none = world();
  const r = await runIn(none, 'innrefresh' + TAIL);
  assert.deepStrictEqual(none.sent, []);
  assert.match(tail(r)[0], /not refreshed: no Hero Hunting held, so the server charges game coins — buy a Hero Hunting with buyitem first \(buyitem Hero Hunting\)/);
  // a line made while the script runs is refused then too
  const forced = world();
  const r2 = await runIn(forced, 'w = "force"\ninnrefresh {w}' + TAIL);
  assert.deepStrictEqual(forced.sent, []);
  assert.match(tail(r2)[0], /innrefresh force: .* buy a Hero Hunting with buyitem first/);
  const held = world({ items: { 'consume.refreshtavern.1': 3 } });
  const r3 = await runIn(held, 'innrefresh');
  assert.deepStrictEqual(cmds(held), ['hero.refreshHerosListFromTavern', 'hero.getHerosListFromTavern']);
  assert.match(r3.text, /spends 1 Hero Hunting \(3 held\)/);
  const unknown = world();
  unknown.g.player.items = undefined;
  const r4 = await runIn(unknown, 'innrefresh');
  assert.deepStrictEqual(unknown.sent, []);
  assert.match(r4.text, /inventory has not loaded/);
});

// ---------------------------------------------------------------------------
section('levels and points');

t('levelup Ken: hero.levelUp, then the new points to its best attribute as totals', async () => {
  const w = world();
  const r = await runIn(w, 'levelup Ken');
  assert.deepStrictEqual(w.sent, [
    { cmd: 'hero.levelUp', data: { castleId: 1, heroId: 11 } },
    { cmd: 'hero.addPoint', data: { castleId: 1, heroId: 11, management: 30, power: 130, stratagem: 20 } },
  ], r.text);
});
t('levelup all leaves out prisoners and heroes short of experience', async () => {
  const w = world();
  const r = await runIn(w, 'levelup all');
  assert.deepStrictEqual(w.sent.filter((s) => s.cmd === 'hero.levelUp').map((s) => s.data.heroId), [11, 12, 13, 16], r.text);
  assert.match(r.text, /Smarty: left — Smarty has 10 of the 90,000 experience its next level takes/);
  assert.match(r.text, /Bob: left — Bob is a prisoner you hold/);
});
t('levelup of one hero short of experience: nothing sent', async () => {
  const w = world();
  const r = await runIn(w, 'levelup Smarty' + TAIL);
  assert.deepStrictEqual(w.sent, []);
  assert.match(tail(r)[0], /Smarty has 10 of the 90,000 experience/);
});
t('uplevelheroes without goals to read: every ready hero here, points to the best', async () => {
  const w = world();
  const r = await runIn(w, 'uplevelheroes' + TAIL);
  assert.deepStrictEqual(w.sent.filter((s) => s.cmd === 'hero.levelUp').map((s) => s.data.heroId), [11, 12, 13, 16], r.text);
  const q = w.sent.find((s) => s.cmd === 'hero.addPoint' && s.data.heroId === 12);
  assert.deepStrictEqual(q.data, { castleId: 1, heroId: 12, management: 264, power: 67, stratagem: 21 }, 'QUEEN\'s best is politics');
  assert.match(r.text, /config hero, nolevelheroes and heropoints are not applied/);
  assert.strictEqual(tail(r)[1], 4);
});
t('uplevelheroes needs config hero:1 or more (NEAT)', async () => {
  const w = world();
  const r = await runIn(w, 'uplevelheroes' + TAIL, { session: session(w, { 9: 'keepheroes any:level>=100' }) });
  assert.deepStrictEqual(w.sent, []);
  assert.match(tail(r)[0], /uplevelheroes needs config hero:1 or more in 9's goals \(config hero not set/);
  const off = world();
  const r2 = await runIn(off, 'uplevelheroes' + TAIL, { session: session(off, { 9: 'config hero:0' }) });
  assert.deepStrictEqual(off.sent, []);
  assert.match(tail(r2)[0], /hero management off/);
});
// The script's own `config hero:1` lands in the goal LAYER, not in the saved
// text. Until 2026-09-22 uplevelheroes read only the saved goals and refused the
// line the same script had just written.
t('uplevelheroes sees config hero:1 set by the script itself', async () => {
  const GL = require('./goallayers');
  const w = world();
  GL.clearScriptLayer('a1', 1);
  try {
    GL.addScriptLine('a1', 1, 'config hero:1');
    const r = await runIn(w, 'uplevelheroes' + TAIL, { session: layered({ 9: 'keepheroes any:level>=100' }) });
    assert.deepStrictEqual(w.sent.filter((s) => s.cmd === 'hero.levelUp').map((s) => s.data.heroId), [11, 12, 13, 16], r.text);
  } finally { GL.clearScriptLayer('a1', 1); }
});
t('uplevelheroes still refused when no layer sets config hero', async () => {
  const w = world();
  require('./goallayers').clearScriptLayer('a1', 1);
  const r = await runIn(w, 'uplevelheroes' + TAIL, { session: layered({ 9: 'keepheroes any:level>=100' }) });
  assert.deepStrictEqual(w.sent, []);
  assert.match(tail(r)[0], /uplevelheroes needs config hero:1 or more/);
});
t('uplevelheroes: nolevelheroes holds back, heropoints spends', async () => {
  const w = world();
  const goals = 'config hero:1\nnolevelheroes Rider|QUEEN\nheropoints Junk pol:25 att';
  const r = await runIn(w, 'uplevelheroes', { session: session(w, { 9: goals }) });
  assert.deepStrictEqual(w.sent.filter((s) => s.cmd === 'hero.levelUp').map((s) => s.data.heroId), [11, 16], r.text);
  assert.match(r.text, /Rider: held back by nolevelheroes Rider\|QUEEN/);
  // Junk: 10 new points, politics to 25 (5), then the rest to attack
  const j = w.sent.find((s) => s.cmd === 'hero.addPoint' && s.data.heroId === 16);
  assert.deepStrictEqual(j.data, { castleId: 1, heroId: 16, management: 25, power: 60, stratagem: 10 });
  assert.match(r.text, /Junk L10 -> L11, points by heropoints Junk pol:25 att/);
});
t('uplevelheroes dry run', async () => {
  const w = world();
  const r = await runIn(w, 'uplevelheroes', { dryRun: true });
  assert.deepStrictEqual(w.sent, []);
  assert.match(r.text, /Ken L40 -> L41, points to attack, its best/);
  assert.match(r.text, /\[dry run\] not sent/);
});
t('addpoint on a prisoner: nothing sent', async () => {
  const w = world();
  const r = await runIn(w, 'addpoint Bob attack 5' + TAIL);
  assert.deepStrictEqual(w.sent, []);
  assert.match(tail(r)[0], /Bob is a prisoner you hold, not one of your heroes/);
});

// ---------------------------------------------------------------------------
section('hero items and water');

t('useheroitem !BigGuy nation medal: hero.useItem with the medal, on BigGuy', async () => {
  const w = world();
  const r = await runIn(w, 'useheroitem !BigGuy nation medal');
  assert.deepStrictEqual(w.sent, [{ cmd: 'hero.useItem', data: { castleId: 2, heroId: 22, itemId: 'hero.loyalty.9' } }], r.text);
  assert.match(r.text, /reading !BigGuy as BigGuy/);
  assert.match(r.text, /BigGuy <- 1 x Nation Medal/);
});
t('useheroitem on a captured hero: nothing sent (NEAT)', async () => {
  const w = world();
  const r = await runIn(w, 'useheroitem Bob on war' + TAIL);
  assert.deepStrictEqual(w.sent, []);
  assert.match(tail(r)[0], /Bob is a prisoner you hold, not one of your heroes — hero items cannot be used on a captured hero/);
});
t('useheroitem dry run sends nothing', async () => {
  const w = world();
  const r = await runIn(w, 'useheroitem Ken anabasis', { dryRun: true });
  assert.deepStrictEqual(w.sent, []);
  assert.match(r.text, /\[dry run\] nothing sent/);
});
t('waterhero !BigGuy finds BigGuy (dry run)', async () => {
  const w = world();
  const r = await runIn(w, 'waterhero !BigGuy', { dryRun: true });
  assert.deepStrictEqual(w.sent, []);
  assert.match(r.text, /reading !BigGuy as BigGuy/);
  assert.match(r.text, /Holy Water on BigGuy L346 in Fla/);
});

// ---------------------------------------------------------------------------
(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n + '\n'); continue; }
    try { await f(); console.log('  ok    ' + n); pass++; }
    catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
