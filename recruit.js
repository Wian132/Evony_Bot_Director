'use strict';
// Recruit heroes for a city.
//   base = the top attribute less one point per level, plus unspent points
//   (Game.heroBase, the formula the goals and the console use: a Lv2 hero
//   showing pol 62 has base 60)
//
//   node recruit.js            hire from the inn, refreshing as needed
//   node recruit.js --dry      show what it would hire
//   node recruit.js --boxes 2  also open 2 hero boxes (best first) before hiring
const fs = require('fs');
const path = require('path');
const { Game } = require('./game');

const WANT = { management: 1, stratagem: 1, power: 4 };   // 1 politics, 1 intel, rest attack
const MIN_BASE = 60;
const MAX_REFRESH = Number(process.env.MAX_REFRESH || 40);

const DRY = process.argv.includes('--dry');
const BOXES = (() => { const i = process.argv.indexOf('--boxes'); return i >= 0 ? Number(process.argv[i + 1] || 1) : 0; })();

// best first — these grant the strongest heroes
const HERO_BOXES = [
  ['player.box.hero.f', "Ardee's Sigil of Recruitment"],
  ['player.box.hero.d', 'Holy Helm of Mars'],
  ['player.box.hero.c', 'Plate Helm of Lancelot'],
  ['player.box.hero.b', 'Chain Helm of Beowulf'],
];

const label = (k) => (k === 'power' ? 'attack' : k === 'management' ? 'politics' : 'intel');
const base = (h, k) => Game.attrValue(h, k);
// the hero's role is its top attribute; its base is Game.heroBase
const bestAttr = (h) => ({ k: Game.dominant(h), v: Game.heroBase(h) });

function loadEnv() {
  const out = {};
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2];
  }
  return out;
}

(async () => {
  const env = loadEnv();
  const g = new Game(() => {});
  await g.connect(env.EVONY_SERVER, env.EVONY_EMAIL, env.EVONY_PASSWORD);
  const castle = g.castle();
  const cid = g.castleId(castle);

  const describe = (h) => {
    const b = bestAttr(h);
    return `${String(h.name).padEnd(14)} L${String(h.level).padEnd(3)} atk ${String(base(h, 'power')).padStart(3)} pol ${String(base(h, 'management')).padStart(3)} int ${String(base(h, 'stratagem')).padStart(3)}  (base ${b.v} ${label(b.k)})`;
  };

  // what we already have counts toward the targets
  const need = { ...WANT };
  console.log(`heroes already in ${castle.name}: ${(castle.heros || []).length}`);
  for (const h of castle.heros || []) {
    console.log('  ' + describe(h));
    const b = bestAttr(h);
    if (need[b.k] > 0) need[b.k]--;
  }
  console.log(`\nwanted: ${Object.entries(need).map(([k, v]) => `${v} ${label(k)}`).join(', ')}  (base >= ${MIN_BASE})\n`);

  if (BOXES > 0) {
    const items = Object.fromEntries((g.player.items || []).map((i) => [i.id, i.count]));
    let opened = 0;
    for (const [id, name] of HERO_BOXES) {
      while (opened < BOXES && (items[id] || 0) > 0) {
        console.log(`opening ${name}…`);
        if (DRY) { console.log('  [dry] not sent'); opened++; items[id]--; continue; }
        const r = await g.useItem(cid, id, 1);
        console.log(`  -> ${r.ok === 1 ? 'ok' : (r.errorMsg || 'ok=' + r.ok)}`);
        opened++; items[id]--;
        await new Promise((s) => setTimeout(s, 900));
      }
    }
  }

  let refreshes = 0, hired = 0;
  const seen = new Set();
  while (Object.values(need).some((v) => v > 0) && refreshes <= MAX_REFRESH) {
    const d = await g.tavernList(cid);
    const offers = d.heros || [];
    let tookOne = false;

    for (const h of offers) {
      const b = bestAttr(h);
      if (b.v < MIN_BASE || !need[b.k]) continue;
      if (DRY && seen.has(h.name)) continue;      // live hiring removes the offer; dry run must pretend
      seen.add(h.name);
      console.log(`hire  ${describe(h)}`);
      if (DRY) { need[b.k]--; hired++; tookOne = true; continue; }
      const r = await g.hireHero(cid, h.name);
      if (r.ok === 1) { need[b.k]--; hired++; tookOne = true; console.log('  -> hired'); }
      else { console.log(`  -> ${r.errorMsg || 'ok=' + r.ok}`); if (r.ok === -57 || /space|full/i.test(r.errorMsg || '')) { refreshes = MAX_REFRESH + 1; break; } }
      await new Promise((s) => setTimeout(s, 700));
    }

    if (!Object.values(need).some((v) => v > 0)) break;
    if (!tookOne) {
      if (refreshes >= MAX_REFRESH) break;
      refreshes++;
      if (refreshes % 10 === 0) console.log(`  …${refreshes} refreshes, still need ${Object.entries(need).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${label(k)}`).join(', ')}`);
      if (DRY) break;
      await g.refreshTavern(cid);
      await new Promise((s) => setTimeout(s, 650));
    }
  }

  console.log(`\nhired ${hired} hero(es) after ${refreshes} refresh(es)`);
  const left = Object.entries(need).filter(([, v]) => v > 0);
  if (left.length) console.log('still wanted: ' + left.map(([k, v]) => `${v} ${label(k)}`).join(', '));
  g.close();
  process.exit(0);
})();
