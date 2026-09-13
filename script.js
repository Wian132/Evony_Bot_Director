'use strict';
// NEAT-style script parser + executor.
//
//   attack 123,456 any:level<500,attack>400 a:99k,c:500,cata:500 @07:00:00.500
//   scout 500,500 any s:1
//   transport 123,456 any t:1000 wood:100000
//   reinforce 123,456 any a:5000
//   sell wood 1000 @0.55
//   buy food 1000 @1.2
//   cleanreports trade
//   sleep 5
//   echo hello
//
// from <castle> may be appended to any march:  attack 1,2 any a:100 from MyCity
const C = require('./constants');
const { Game } = require('./game');

// attack = power, politics = management, intel = stratagem
const ATTR = Game.ATTR;

const num = (s) => {
  const m = String(s).trim().match(/^([\d.]+)\s*([kmb])?$/i);
  if (!m) throw new Error('bad number: ' + s);
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
};

function parseTroops(s) {
  const troops = {};
  for (const part of s.split(',')) {
    const m = part.trim().match(/^([a-z]+)\s*:\s*([\d.]+[kmb]?)$/i);
    if (!m) throw new Error('bad troop string: ' + part);
    const t = C.BY_CODE[m[1].toLowerCase()];
    if (!t) throw new Error('unknown troop code: ' + m[1]);
    troops[t.key] = num(m[2]);
  }
  return troops;
}

function parseResources(s) {
  const out = {};
  for (const part of s.split(',')) {
    const m = part.trim().match(/^(wood|food|stone|iron|gold)\s*:\s*([\d.]+[kmb]?)$/i);
    if (!m) throw new Error('bad resource string: ' + part);
    out[m[1].toLowerCase()] = num(m[2]);
  }
  return out;
}

// "@07:00:00.500" / "@07:00:00:500" / "07:00:00"
function parseLandTime(s) {
  const m = String(s).replace(/^@/, '').match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[.:](\d{1,3}))?$/);
  if (!m) throw new Error('bad time: ' + s);
  return { h: +m[1], m: +m[2], s: +m[3], ms: m[4] ? +String(m[4]).padEnd(3, '0') : 0 };
}

// next occurrence of that wall-clock time, on the server clock
function nextOccurrence(t, serverNow) {
  const d = new Date(serverNow);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.h, t.m, t.s, t.ms).getTime();
  return target <= serverNow ? target + 86400000 : target;
}

function parseLine(raw) {
  const line = raw.replace(/\/\/.*$/, '').trim();
  if (!line) return null;

  const tok = line.split(/\s+/);
  const cmd = tok[0].toLowerCase();

  if (cmd === 'sleep') return { cmd, seconds: parseFloat(tok[1]) };
  if (cmd === 'echo') return { cmd, text: line.slice(5) };
  if (cmd === 'cleanreports') return { cmd, type: (tok[1] || 'trade').toLowerCase() };
  if (cmd === 'repeat') return { cmd, times: Math.max(1, parseInt(tok[1] || '1', 10)) };
  if (cmd === 'loop') return { cmd, times: Math.max(1, parseInt(tok[1] || '1', 10)) };
  if (cmd === 'endloop') return { cmd };

  // wall abatis 1000     (aliases: trap, abatis, tower, logs, rocks)
  if (cmd === 'wall' || cmd === 'walls') {
    const w = C.WALL_BY_CODE[(tok[1] || '').toLowerCase()];
    if (!w) throw new Error('wall: type must be one of ' + C.WALLS.map((x) => x.code).join('/'));
    return { cmd: 'wall', wall: w, amount: num(tok[2] || '1') };
  }

  // train a 10k   (troops)
  if (cmd === 'train') {
    const t = C.BY_CODE[(tok[1] || '').toLowerCase()];
    if (!t) throw new Error('train: unknown troop code ' + tok[1]);
    return { cmd: 'train', troop: t, amount: num(tok[2] || '1') };
  }

  // production 0 0 0 0   (food wood stone iron, percentages)
  // zeroing them frees all field labour back into idle population
  if (cmd === 'production' || cmd === 'produce') {
    const nums = tok.slice(1).map((x) => parseInt(x, 10));
    if (nums.length !== 4 || nums.some((x) => Number.isNaN(x) || x < 0 || x > 100)) {
      throw new Error('production: usage  production <food> <wood> <stone> <iron>   (0-100 each)');
    }
    return { cmd: 'production', rates: { food: nums[0], wood: nums[1], stone: nums[2], iron: nums[3] } };
  }
  if (cmd === 'tax') {
    const v = parseInt(tok[1], 10);
    if (Number.isNaN(v) || v < 0 || v > 100) throw new Error('tax: usage  tax <0-100>');
    return { cmd: 'tax', rate: v };
  }

  // ---- items ----
  if (cmd === 'buyitem') {
    if (!tok[1]) throw new Error('buyitem: usage  buyitem <itemId> [amount]');
    return { cmd: 'buyitem', itemId: tok[1], amount: parseInt(tok[2] || '1', 10) };
  }
  if (cmd === 'useitem') {
    if (!tok[1]) throw new Error('useitem: usage  useitem <itemId> [num]');
    return { cmd: 'useitem', itemId: tok[1], amount: parseInt(tok[2] || '1', 10) };
  }
  // useheroitem OTTO excalibur repeat 5    (NEAT spelling)
  // useheroitem OTTO excalibur 5           (same thing)
  // useheroitem OTTO hero.power.1          (ids always work)
  if (cmd === 'useheroitem' || cmd === 'heroitem') {
    const HI = require('./heroitems');
    if (!tok[1] || !tok[2]) {
      throw new Error('useheroitem: usage  useheroitem <hero> <item> [repeat <n>]  |  items: '
        + Object.values(HI.ALL).map((d) => d.names[0]).join(', '));
    }
    const rest = tok.slice(2);
    let times = 1;
    const ri = rest.findIndex((t) => String(t).toLowerCase() === 'repeat');
    if (ri !== -1) { times = parseInt(rest[ri + 1] || '1', 10) || 1; rest.splice(ri, 2); }
    else if (/^\d+$/.test(rest[rest.length - 1] || '')) times = parseInt(rest.pop(), 10) || 1;
    const word = rest.join('');
    const itemId = HI.resolveItem(word);
    if (!itemId) {
      throw new Error(`useheroitem: unknown item "${rest.join(' ')}". Known: `
        + Object.values(HI.ALL).map((d) => d.names[0]).join(', ')
        + ' — or give the raw id, e.g. hero.power.1');
    }
    if (times < 1 || times > 500) throw new Error('useheroitem: repeat must be between 1 and 500');
    return { cmd: 'useheroitem', heroName: tok[1], itemId, times };
  }
  if (cmd === 'heroitems') return { cmd: 'heroitems' };

  if (cmd === 'packages' || cmd === 'inventory') return { cmd: 'packages' };
  if (cmd === 'lostheroes') return { cmd: 'lostheroes' };
  if (cmd === 'recover') {
    if (!tok[1]) throw new Error('recover: usage  recover <heroId>   (see lostheroes)');
    return { cmd: 'recover', heroId: tok.slice(1).join(' ') };
  }
  if (cmd === 'find') {
    if (!tok[1]) throw new Error('find: usage  find <player name>');
    return { cmd: 'find', query: tok.slice(1).join(' ') };
  }

  // ---- hero management ----
  if (cmd === 'heroes' || cmd === 'herolist') return { cmd: 'heroes' };
  if (cmd === 'inn' || cmd === 'tavern') return { cmd: 'inn' };
  if (cmd === 'innrefresh' || cmd === 'refreshinn') return { cmd: 'innrefresh' };
  if (cmd === 'hire') {
    if (!tok[1]) throw new Error('hire: give a hero name, or "best" / "best politics"');
    if (tok[1].toLowerCase() === 'best') {
      const attr = tok[2] ? ATTR[(tok[2] || '').toLowerCase()] : null;
      if (tok[2] && !attr) throw new Error('hire best: attribute must be attack/politics/intel');
      return { cmd: 'hire', best: true, attr };
    }
    return { cmd: 'hire', name: tok.slice(1).join(' ') };
  }
  if (cmd === 'fire' || cmd === 'release') {
    if (!tok[1]) throw new Error(`${cmd}: give a hero name`);
    return { cmd, name: tok.slice(1).join(' ') };
  }
  if (cmd === 'mayor' || cmd === 'appoint') {
    if (!tok[1]) throw new Error('mayor: give a hero name');
    return { cmd: 'mayor', name: tok.slice(1).join(' ') };
  }
  if (cmd === 'unmayor' || cmd === 'unappoint' || cmd === 'dischargemayor') return { cmd: 'unmayor' };
  if (cmd === 'levelup') {
    if (!tok[1]) throw new Error('levelup: give a hero name (or "all")');
    const last = (tok[tok.length - 1] || '').toLowerCase();
    let attr = null, nameToks = tok.slice(1);
    if (ATTR[last] || last === 'auto') { attr = last === 'auto' ? null : ATTR[last]; nameToks = tok.slice(1, -1); }
    return { cmd: 'levelup', name: nameToks.join(' '), attr };
  }
  if (cmd === 'addpoint' || cmd === 'addpoints') {
    const attr = ATTR[(tok[tok.length - 2] || '').toLowerCase()];
    const n = parseInt(tok[tok.length - 1], 10);
    if (!attr || Number.isNaN(n)) throw new Error('addpoint: usage  addpoint <hero> <attack|politics|intel> <n>');
    return { cmd: 'addpoint', name: tok.slice(1, -2).join(' '), attr, amount: n };
  }

  // buildcity 123,456   -- turn an owned flat into a new city
  if (cmd === 'buildcity' || cmd === 'newcity') {
    const m = (tok[1] || '').match(/^(\d+)\s*,\s*(\d+)$/);
    if (!m) throw new Error('buildcity: expected coords like 123,456');
    return { cmd: 'buildcity', target: { x: +m[1], y: +m[2] } };
  }

  // build cottage [at 12]   (buildings; troops are `train`)
  if (cmd === 'build') {
    const key = (tok[1] || '').toLowerCase().replace(/[^a-z]/g, '');
    const b = C.BUILDING_BY_CODE[key];
    if (!b) throw new Error('build: unknown building "' + tok[1] + '" (try cottage, academy, feastinghall, barracks…)');
    let at = null;
    const ai = tok.findIndex((t) => t.toLowerCase() === 'at');
    if (ai > 0) at = parseInt(tok[ai + 1], 10);
    return { cmd: 'build', building: b, at };
  }

  // upgrade academy [at 12]
  if (cmd === 'upgrade') {
    const key = (tok[1] || '').toLowerCase().replace(/[^a-z]/g, '');
    const b = C.BUILDING_BY_CODE[key];
    if (!b) throw new Error('upgrade: unknown building "' + tok[1] + '"');
    let at = null;
    const ai = tok.findIndex((t) => t.toLowerCase() === 'at');
    if (ai > 0) at = parseInt(tok[ai + 1], 10);
    return { cmd: 'upgrade', building: b, at };
  }

  // research archery
  if (cmd === 'research') {
    const key = tok.slice(1).join('').toLowerCase().replace(/[^a-z]/g, '');
    const t = C.TECH_BY_CODE[key];
    if (!t) throw new Error('research: unknown tech "' + tok.slice(1).join(' ') + '"');
    return { cmd: 'research', tech: t };
  }

  if (cmd === 'sell' || cmd === 'buy') {
    // sell wood 1000 @0.55
    const priceTok = tok.find((t) => t.startsWith('@'));
    if (!priceTok) throw new Error(`${cmd}: missing @price`);
    return { cmd, resource: tok[1].toLowerCase(), amount: num(tok[2]), price: priceTok.slice(1) };
  }

  if (['attack', 'scout', 'transport', 'reinforce'].includes(cmd)) {
    const coords = tok[1] && tok[1].match(/^(\d+)\s*,\s*(\d+)$/);
    if (!coords) throw new Error(`${cmd}: expected coords like 123,456`);
    const target = { x: +coords[1], y: +coords[2] };

    // hero is OPTIONAL everywhere. Give a name ("Wian"), "any", or "any:level<500,attack>400".
    // Omit it entirely and no heroId is sent (NewArmyWin.as only sets heroId when one is selected).
    let from = null, land = null, hero = null, troops = null, resources = null;
    for (let i = 2; i < tok.length; i++) {
      const t = tok[i];
      if (t.toLowerCase() === 'from') { from = tok[++i]; continue; }
      if (t.startsWith('@')) { land = parseLandTime(t); continue; }
      if (/^(wood|food|stone|iron|gold):/i.test(t)) { resources = parseResources(t); continue; }
      if (/^[a-z]+:[\d.]+[kmb]?(,[a-z]+:[\d.]+[kmb]?)*$/i.test(t) && C.BY_CODE[t.split(':')[0].toLowerCase()]) { troops = parseTroops(t); continue; }
      if (hero === null) { hero = t; continue; }
      throw new Error(`${cmd}: unexpected token "${t}"`);
    }
    if (!troops) throw new Error(`${cmd}: no troop string (e.g. a:1000,c:500)`);
    return { cmd, target, hero, troops, resources, land, from };
  }

  throw new Error('unknown command: ' + cmd);
}

// Expands `repeat N` (NEAT-style: run the previous action N more times) and
// `loop N` ... `endloop` blocks into a flat action list.
function expand(raw) {
  const out = [];
  const stack = [];
  for (const a of raw) {
    if (a.cmd === 'loop') { stack.push({ times: a.times, body: [], line: a.line }); continue; }
    if (a.cmd === 'endloop') {
      const blk = stack.pop();
      if (!blk) { out.push({ cmd: 'error', line: a.line, raw: a.raw, error: 'endloop without loop' }); continue; }
      const expanded = [];
      for (let i = 0; i < blk.times; i++) expanded.push(...blk.body.map((x) => ({ ...x })));
      (stack.length ? stack[stack.length - 1].body : out).push(...expanded);
      continue;
    }
    const sink = stack.length ? stack[stack.length - 1].body : out;
    if (a.cmd === 'repeat') {
      const prev = sink[sink.length - 1];
      if (!prev) { sink.push({ cmd: 'error', line: a.line, raw: a.raw, error: 'repeat with no previous action' }); continue; }
      for (let i = 0; i < a.times; i++) sink.push({ ...prev });
      continue;
    }
    sink.push(a);
  }
  for (const blk of stack) out.push({ cmd: 'error', line: blk.line, raw: 'loop', error: 'loop without endloop' });
  return out;
}

function parse(text) {
  const raw = [];
  text.split(/\r?\n/).forEach((line, i) => {
    try { const a = parseLine(line); if (a) raw.push({ ...a, line: i + 1, raw: line.trim() }); }
    catch (e) { raw.push({ cmd: 'error', line: i + 1, raw: line.trim(), error: e.message }); }
  });
  return expand(raw);
}

// ---------------------------------------------------------------- executor

// The server sends a human-readable errorMsg on failure -- always show it.
const say = (r) => {
  if (!r) return 'no response';
  if (r.ok === 1) return 'ok';
  return `FAILED (ok=${r.ok})` + (r.errorMsg ? ` - ${r.errorMsg}` : ` ${JSON.stringify(r)}`);
};

async function run(game, actions, log, opts = {}) {
  const dryRun = !!opts.dryRun;
  let done = 0;
  let lastTradeAt = 0, tradeMisses = 0;

  for (const a of actions) {
    if (a.cmd === 'error') { log(`line ${a.line}: PARSE ERROR — ${a.error}`); continue; }
    log(`line ${a.line}: ${a.raw}`);

    try {
      if (a.cmd === 'echo') { log('  ' + a.text); continue; }
      if (a.cmd === 'sleep') { await new Promise((r) => setTimeout(r, a.seconds * 1000)); continue; }

      if (a.cmd === 'cleanreports') {
        if (dryRun) { log('  [dry run] would delete all ' + a.type + ' reports'); continue; }
        const n = await game.cleanReports(a.type);
        log(`  removed ${n} ${a.type} report(s)`);
        done++; continue;
      }

      if (a.cmd === 'production') {
        const castle = game.castle(opts.castle);
        const r0 = castle.resource || {};
        const busy = ['food', 'wood', 'stone', 'iron'].reduce((s2, k) => s2 + Number((r0[k] && r0[k].workPeople) || 0), 0);
        log(`  set production food ${a.rates.food}% wood ${a.rates.wood}% stone ${a.rates.stone}% iron ${a.rates.iron}% (currently ${busy.toLocaleString('en-US')} on fields)`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.setProduction(game.castleId(castle), a.rates);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'tax') {
        const castle = game.castle(opts.castle);
        log(`  set tax rate to ${a.rate}%`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.setTax(game.castleId(castle), a.rate);
        log('  -> ' + say(r));
        done++; continue;
      }

      // ---- items ----
      if (a.cmd === 'buyitem') {
        log(`  buy ${a.amount} x ${a.itemId} from the shop (costs cents)`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.buyItem(a.itemId, a.amount);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'useitem') {
        const castle = game.castle(opts.castle);
        if (a.itemId === 'player.item.stoneoffinding') {
          log('  the Stone of Finding is not used through shop.useGoods — use "lostheroes" then "recover <heroId>"');
          continue;
        }
        log(`  use ${a.amount} x ${a.itemId} in ${castle.name}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.useItem(game.castleId(castle), a.itemId, a.amount);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'useheroitem') {
        const HI = require('./heroitems');
        log(`  ${a.heroName} <- ${a.times} x ${HI.describeItem(a.itemId)}`);
        if (dryRun) { log('  [dry run] nothing sent'); done++; continue; }
        const r = await HI.useOnHero(game, { heroName: a.heroName, itemId: a.itemId, times: a.times, log });
        if (!r.ok && !r.used) { log('  ' + r.error); continue; }
        const d = (k) => (r.after[k] - r.before[k]);
        const moved = ['power', 'management', 'stratagem', 'experience']
          .filter((k) => d(k) !== 0)
          .map((k) => `${k} ${r.before[k]} -> ${r.after[k]} (+${d(k)})`);
        const spent = r.heldBefore !== undefined && r.heldAfter !== undefined
          ? `, ${r.heldBefore} -> ${r.heldAfter} left` : '';
        log(`  used ${r.used} on ${r.hero} in ${r.castle}${spent}`
          + (moved.length
            ? ' — ' + moved.join(', ')
            : ' — the server accepted and consumed it, but reports no change to the'
              + ' hero attributes it sends us'));
        if (r.error) log('  ' + r.error);
        done++;
        continue;
      }

      if (a.cmd === 'heroitems') {
        const HI = require('./heroitems');
        const rows = HI.heldHeroItems(game);
        if (!rows.length) { log('  no hero items in the inventory'); done++; continue; }
        log('  hero items held:');
        for (const r of rows) log(`    ${String(r.count).padStart(6)}  ${r.label.padEnd(30)} ${r.id}`);
        log('  use any of them with:  useheroitem <hero> <name or id> repeat <n>');
        done++;
        continue;
      }

      if (a.cmd === 'packages') {
        const castle = game.castle(opts.castle);
        const d = await game.packageList(game.castleId(castle));
        const ps = d.packages || [];
        if (!ps.length) { log('  no packages'); continue; }
        for (const p of ps.slice(0, 25)) log(`  [${p.id}] ${p.packageName} (status ${p.status}, ${(p.itemList || []).length} item(s))`);
        if (ps.length > 25) log(`  … and ${ps.length - 25} more`);
        continue;
      }

      if (a.cmd === 'lostheroes') {
        const d = await game.lostHeroes();
        const hs = d.heros || d.disappearHeros || d.list || [];
        if (!hs.length) { log('  no heroes lost in the last 24h (nothing for a Stone of Finding to recover)'); continue; }
        for (const h of hs) log(`  id ${h.id}  ${h.name}  L${h.level}  atk ${Game.attrValue(h, 'power')} pol ${Game.attrValue(h, 'management')} int ${Game.attrValue(h, 'stratagem')}`);
        continue;
      }

      if (a.cmd === 'recover') {
        const castle = game.castle(opts.castle);
        log(`  recover lost hero ${a.heroId} (consumes a Stone of Finding)`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.recoverHero(game.castleId(castle), a.heroId);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'find') {
        const D = require('./db');
        const total = D.mapCache.count();
        if (!total) { log('  no map cache yet — run:  node mapscan.js'); continue; }
        const hits = D.mapCache.search(a.query, 500);
        log(`  cache holds ${total.toLocaleString('en-US')} castles (${Math.round((Date.now() - D.mapCache.updatedAt()) / 60000)} min old)`);
        if (!hits.length) { log('  no match'); continue; }
        for (const h of hits.slice(0, 20)) {
          const xy = C.fieldIdToCoords(Number(h.id));
          log(`  ${String(h.userName).padEnd(16)} ${String(h.name || '').padEnd(18)} ${xy.x},${xy.y}  ${h.allianceName || '-'}  pres ${Number(h.prestige || 0).toLocaleString('en-US')}`);
        }
        continue;
      }

      // ---- hero management ----
      if (a.cmd === 'heroes') {
        const castle = game.castle(opts.castle);
        const hs = castle.heros || [];
        if (!hs.length) { log('  no heroes in this city'); continue; }
        for (const h of hs) {
          const dom = Game.dominant(h);
          log(`  ${String(h.name).padEnd(14)} L${String(h.level).padEnd(4)} atk ${String(Game.attrValue(h, 'power')).padStart(4)}  pol ${String(Game.attrValue(h, 'management')).padStart(4)}  int ${String(Game.attrValue(h, 'stratagem')).padStart(4)}  loyalty ${h.loyalty ?? '?'}  unspent ${h.remainPoint || 0}  [${dom === 'power' ? 'attack' : dom === 'management' ? 'politics' : 'intel'} hero]`);
        }
        continue;
      }

      if (a.cmd === 'inn' || a.cmd === 'innrefresh') {
        const castle = game.castle(opts.castle);
        const cid = game.castleId(castle);
        if (a.cmd === 'innrefresh') {
          if (dryRun) { log('  [dry run] would refresh the inn'); continue; }
          const rr = await game.refreshTavern(cid);
          log('  refresh -> ' + say(rr));
          done++;
        }
        const d = await game.tavernList(cid);
        const list = d.heros || [];
        if (!list.length) { log('  inn is empty'); continue; }
        for (const h of list) {
          const dom = Game.dominant(h);
          log(`  ${String(h.name).padEnd(14)} L${String(h.level).padEnd(4)} atk ${String(Game.attrValue(h, 'power')).padStart(4)}  pol ${String(Game.attrValue(h, 'management')).padStart(4)}  int ${String(Game.attrValue(h, 'stratagem')).padStart(4)}  [${dom === 'power' ? 'attack' : dom === 'management' ? 'politics' : 'intel'}]`);
        }
        continue;
      }

      if (a.cmd === 'hire') {
        const castle = game.castle(opts.castle);
        const cid = game.castleId(castle);
        let name = a.name;
        if (a.best) {
          const d = await game.tavernList(cid);
          const list = d.heros || [];
          if (!list.length) { log('  inn is empty, nothing to hire'); continue; }
          const key = a.attr || null;
          const scored = list.map((h) => ({ h, v: key ? Game.attrValue(h, key) : Math.max(Game.attrValue(h, 'power'), Game.attrValue(h, 'management'), Game.attrValue(h, 'stratagem')) }));
          scored.sort((x, y) => y.v - x.v);
          name = scored[0].h.name;
          log(`  best${a.attr ? ' ' + a.attr : ''} in the inn: ${name} (${scored[0].v})`);
        }
        log(`  hire ${name}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.hireHero(cid, name);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'fire' || a.cmd === 'release') {
        const castle = game.castle(opts.castle);
        const h = game.findHero(castle, a.name);
        if (!h) { log(`  no hero named "${a.name}" in ${castle.name}`); continue; }
        log(`  ${a.cmd} ${h.name} (id ${h.id}, L${h.level})`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = a.cmd === 'fire' ? await game.fireHero(game.castleId(castle), h.id)
                                   : await game.releaseHero(game.castleId(castle), h.id);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'mayor') {
        const castle = game.castle(opts.castle);
        const h = game.findHero(castle, a.name);
        if (!h) { log(`  no hero named "${a.name}"`); continue; }
        log(`  appoint ${h.name} as mayor of ${castle.name}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.promoteToChief(game.castleId(castle), h.id);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'unmayor') {
        const castle = game.castle(opts.castle);
        log(`  remove the mayor of ${castle.name}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.dischargeChief(game.castleId(castle));
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'levelup') {
        const castle = game.castle(opts.castle);
        const cid = game.castleId(castle);
        const targets = a.name.toLowerCase() === 'all' ? (castle.heros || []) : [game.findHero(castle, a.name)].filter(Boolean);
        if (!targets.length) { log(`  no hero named "${a.name}"`); continue; }

        for (const h of targets) {
          const dom = a.attr || Game.dominant(h);
          const label = dom === 'power' ? 'attack' : dom === 'management' ? 'politics' : 'intel';
          log(`  ${h.name} L${h.level} -> level up, points go to ${label}${a.attr ? '' : ' (dominant)'}`);
          if (dryRun) { log('  [dry run] not sent'); continue; }

          const r = await game.levelUpHero(cid, h.id);
          log('    levelUp -> ' + say(r));
          if (r.ok !== 1) continue;

          const fresh = (await game.heroAfter(castle, h.id)) || h;
          const pts = Number(fresh.remainPoint || 0);
          if (pts <= 0) { log('    no unspent points to assign'); done++; continue; }
          const alloc = { management: 0, power: 0, stratagem: 0 };
          alloc[dom] = pts;
          const ar = await game.addPoint(cid, fresh, alloc);   // increments; game.js converts to totals
          log(`    +${pts} ${label} -> ` + say(ar));
          done++;
        }
        continue;
      }

      if (a.cmd === 'addpoint') {
        const castle = game.castle(opts.castle);
        const h = game.findHero(castle, a.name);
        if (!h) { log(`  no hero named "${a.name}"`); continue; }
        const label = a.attr === 'power' ? 'attack' : a.attr === 'management' ? 'politics' : 'intel';
        log(`  ${h.name}: +${a.amount} ${label} (unspent ${h.remainPoint || 0})`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const alloc = { management: 0, power: 0, stratagem: 0 };
        alloc[a.attr] = a.amount;
        const r = await game.addPoint(game.castleId(castle), h, alloc);   // increments; game.js converts to totals
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'buildcity') {
        const castle = game.castle(opts.castle);
        const fieldId = C.coordsToFieldId(a.target.x, a.target.y);
        log(`  found city on flat ${a.target.x},${a.target.y} (field ${fieldId}) from ${castle.name}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.constructCastle(game.castleId(castle), fieldId, false);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'build') {
        const castle = game.castle(opts.castle);
        const cid = game.castleId(castle);

        // explain prerequisites BEFORE spending a round trip on a doomed build
        const cond = await game.buildConditions(cid, a.building.typeId).catch(() => null);
        const missing = game.unmet(cond);
        if (cond) log(`  ${a.building.name}: costs ${['wood', 'stone', 'iron', 'food'].map((k) => `${k} ${(cond[k] || 0).toLocaleString('en-US')}`).join(', ')}, ${cond.time}s`);
        if (missing.length) {
          log(`  BLOCKED - needs ${missing.map((m) => m.text).join('; ')}`);
          if (opts.autoReq) {
            for (const m of missing.filter((x) => x.kind === 'building')) {
              const spot = game.findBuildings(castle, m.typeId)[0];
              if (!spot) { log(`    cannot auto-fix: no ${(C.BUILDING_BY_ID[m.typeId] || {}).name} in this city to upgrade`); continue; }
              if (dryRun) { log(`    [dry run] would upgrade ${(C.BUILDING_BY_ID[m.typeId] || {}).name} at pos ${spot.positionId}`); continue; }
              const ur = await game.upgradeBuilding(cid, spot.positionId);
              log(`    queued upgrade of ${(C.BUILDING_BY_ID[m.typeId] || {}).name} (pos ${spot.positionId}) -> ${say(ur)}`);
            }
            log('    prerequisite queued - re-run this line once it finishes');
          }
          continue;
        }

        const pos = a.at ?? game.freeSlot(castle, !!a.building.outside);
        if (pos === null || pos === undefined || Number.isNaN(pos)) { log(`  no free ${a.building.outside ? 'field' : 'city'} slot - specify one with "at N"`); continue; }
        log(`  build ${a.building.name} (type ${a.building.typeId}) at position ${pos}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.newBuilding(cid, pos, a.building.typeId);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'upgrade') {
        const castle = game.castle(opts.castle);
        const cid = game.castleId(castle);
        const spots = game.findBuildings(castle, a.building.typeId);
        if (!spots.length) { log(`  no ${a.building.name} in ${castle.name}`); continue; }
        const spot = a.at != null ? spots.find((s) => s.positionId === a.at) || { positionId: a.at } : spots.sort((x, y) => (x.level || 0) - (y.level || 0))[0];

        const chk = await game.checkUpgrade(cid, spot.positionId).catch(() => null);
        if (chk && chk.ok !== 1) { log(`  BLOCKED - ${say(chk)}`); continue; }
        const missing = game.unmet(chk && (chk.conditionBean || chk.condition));
        if (missing.length) {
          log(`  BLOCKED - needs ${missing.map((m) => m.text).join('; ')}`);
          if (!opts.autoReq) continue;
          for (const m of missing.filter((x) => x.kind === 'building')) {
            const s2 = game.findBuildings(castle, m.typeId)[0];
            if (!s2) { log('    cannot auto-fix: prerequisite building not present'); continue; }
            if (dryRun) { log(`    [dry run] would upgrade ${(C.BUILDING_BY_ID[m.typeId] || {}).name}`); continue; }
            const ur = await game.upgradeBuilding(cid, s2.positionId);
            log(`    queued upgrade of ${(C.BUILDING_BY_ID[m.typeId] || {}).name} -> ${say(ur)}`);
          }
          continue;
        }

        log(`  upgrade ${a.building.name} at position ${spot.positionId} (level ${spot.level ?? '?'})`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.upgradeBuilding(cid, spot.positionId);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'research') {
        const castle = game.castle(opts.castle);
        const cid = game.castleId(castle);
        const list = await game.researchList(cid).catch(() => null);
        const beans = (list && (list.acailableResearchBeans || list.availableResearchBeans)) || [];
        const bean = beans.find((b) => b.typeId === a.tech.typeId);
        if (bean) log(`  ${a.tech.name}: level ${bean.level}/${bean.avalevel}${bean.upgradeing ? ' (already researching)' : ''}`);
        log(`  research ${a.tech.name} (tech ${a.tech.typeId}) in ${castle.name}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.research(cid, a.tech.typeId);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'wall') {
        const castle = game.castle(opts.castle);
        log(`  build ${a.amount.toLocaleString('en-US')} x ${a.wall.name} (type ${a.wall.typeId}) in ${castle.name}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.produceWall(game.castleId(castle), a.wall.typeId, a.amount);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'train') {
        const castle = game.castle(opts.castle);
        log(`  train ${a.amount.toLocaleString('en-US')} x ${a.troop.name} (type ${a.troop.typeId}) in ${castle.name}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }
        const r = await game.produceTroop(game.castleId(castle), a.troop.typeId, a.amount);
        log('  -> ' + say(r));
        done++; continue;
      }

      if (a.cmd === 'sell' || a.cmd === 'buy') {
        const castle = game.castle(opts.castle);
        log(`  ${a.cmd} ${a.amount.toLocaleString()} ${a.resource} @ ${a.price} from ${castle.name || game.castleId(castle)}`);
        if (dryRun) { log('  [dry run] not sent'); continue; }

        // Market writes are throttled hardest by the server. Pace them, and stop
        // the run once it starts ignoring us instead of hammering it further.
        const gap = Number(opts.tradeGapMs ?? 1200);
        if (lastTradeAt) {
          const wait = gap - (Date.now() - lastTradeAt);
          if (wait > 0) await new Promise((res) => setTimeout(res, wait));
        }
        lastTradeAt = Date.now();

        let r;
        try {
          r = await game.newTrade({ castleId: game.castleId(castle), resource: a.resource, type: a.cmd, amount: a.amount, price: a.price });
        } catch (e) {
          tradeMisses++;
          log(`  -> ${e.message}`);
          if (tradeMisses >= 2) { log('  STOPPING: the server stopped answering market commands. Give it a few minutes.'); break; }
          continue;
        }
        tradeMisses = 0;
        log('  -> ' + say(r));
        if (r.ok === -38) { log('  marketplace full (10 offers max) — stopping this run'); break; }
        done++; continue;
      }

      // ---- marches ----
      const castle = game.castle(a.from ?? opts.castle);
      const from = game.castleXY(castle);
      const targetPoint = C.coordsToFieldId(a.target.x, a.target.y);
      const troopKeys = Object.keys(a.troops).filter((k) => a.troops[k] > 0);
      const march = from ? C.marchTimeMs(from, a.target, troopKeys, game.marchSkillParam) : null;
      const hero = a.hero ? game.pickHero(castle, a.hero) : null;

      let restTimeSec = 0, sendAt = null;
      if (a.land) {
        if (march === null) throw new Error('cannot compute march time (castle coords unknown) — @time needs it');
        const serverNow = game.now();
        const targetMs = nextOccurrence(a.land, serverNow);
        const slack = targetMs - serverNow - march;
        if (slack < 0) throw new Error(`too late: march takes ${(march / 1000).toFixed(1)}s but target is ${((targetMs - serverNow) / 1000).toFixed(1)}s away`);
        // camp time is whole seconds; the leftover fraction is absorbed by delaying the send
        restTimeSec = Math.floor(slack / 1000);
        sendAt = targetMs - march - restTimeSec * 1000;
        log(`  march ${(march / 1000).toFixed(1)}s, camp ${restTimeSec}s, send in ${((sendAt - serverNow) / 1000).toFixed(3)}s -> lands ${new Date(targetMs).toLocaleTimeString()}.${String(a.land.ms).padStart(3, '0')}`);
      } else if (march !== null) {
        log(`  march ${(march / 1000).toFixed(1)}s (no @time, lands on arrival)`);
      }

      const bean = game.buildArmyBean({
        missionType: C.MISSION[a.cmd],
        heroId: hero ? hero.id : undefined,
        targetPoint,
        troops: a.troops,
        resources: a.resources || {},
        restTimeSec,
      });
      log(`  ${a.cmd} -> field ${targetPoint} (${a.target.x},${a.target.y}) hero ${hero ? (hero.name || hero.id) : 'none'} missionType ${bean.missionType}`);

      if (dryRun) { log('  [dry run] not sent'); continue; }

      if (sendAt) {
        const wait = sendAt - game.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      const r = await game.newArmy(game.castleId(castle), bean);
      log('  -> ' + say(r));
      done++;
    } catch (e) {
      log(`  FAILED: ${e.message}`);
      if (opts.stopOnError) break;
    }
  }
  return done;
}

module.exports = { parse, parseLine, run, parseTroops, parseLandTime, nextOccurrence };
