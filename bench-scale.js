'use strict';
// What does one account actually cost? Measured, not guessed.
//
//   node --expose-gc bench-scale.js
//
// Nothing here touches the network — it loads the real modules, builds castle
// objects shaped like the real ones, and runs real plan ticks.
const v8 = require('v8');

const MB = (b) => (b / 1048576).toFixed(1);
const gc = () => { if (global.gc) { global.gc(); global.gc(); } };
const rss = () => process.memoryUsage().rss;
const heap = () => process.memoryUsage().heapUsed;

console.log('\n=== baseline ===');
gc();
const bare = { rss: rss(), heap: heap() };
console.log(`  bare node               rss ${MB(bare.rss)} MB   heap ${MB(bare.heap)} MB`);

// Load everything a running console loads.
require('./constants');
require('./amf3');
require('./evony');
require('./game');
require('./db');
require('./goals');
require('./engine');
require('./goalmods');
require('./snapshot');
gc();
const loaded = { rss: rss(), heap: heap() };
console.log(`  + all modules + sqlite  rss ${MB(loaded.rss)} MB   heap ${MB(loaded.heap)} MB`
  + `   (+${MB(loaded.rss - bare.rss)} MB)`);

// ---------------------------------------------------------------- a castle
// Shaped like what the server actually sends: ~30 buildings, 10 heroes with
// full attribute sets, all troop types, walls, resources.
function castle(i) {
  const heros = [];
  for (let h = 0; h < 10; h++) {
    heros.push({
      id: i * 100 + h, name: 'Hero' + h, level: 120, loyalty: 100, status: h === 0 ? 1 : 0,
      power: 700, management: 300, stratagem: 250, experience: 1234567,
      powerAdded: 40, managementAdded: 20, stratagemAdded: 10,
      castleId: i, seq: h, notLoyal: 0, hp: 100, killCount: 0,
    });
  }
  const buildings = [];
  for (let b = 0; b < 32; b++) {
    buildings.push({ id: i * 1000 + b, typeId: (b % 20) + 1, level: 9, positionId: b, castleId: i, state: 0 });
  }
  const troop = {};
  for (const k of ['peasants', 'militia', 'scouter', 'pikemen', 'swordsmen', 'archer',
    'carriage', 'lightCavalry', 'heavyCavalry', 'ballista', 'batteringRam', 'catapult']) {
    troop[k] = 100000;
  }
  return {
    id: i, fieldId: 400 * 800 + i, name: 'City' + i,
    resource: {
      food: { amount: 9e9, increaseRate: 500000, workPeople: 13000 },
      wood: { amount: 9e9, increaseRate: 500000, workPeople: 13000 },
      stone: { amount: 9e9, increaseRate: 500000, workPeople: 13000 },
      iron: { amount: 9e9, increaseRate: 500000, workPeople: 13000 },
      gold: 9e9, curPopulation: 120000, maxPopulation: 120000, workPeople: 52000, buildPeople: 0,
    },
    troop, heros, buildings,
    fortification: { trap: 5000, abatis: 5000, arrowTower: 5000, rollingLogs: 5000, rockfall: 5000 },
  };
}

// ------------------------------------------------------- one account's state
const ACCOUNTS = Number(process.env.N || 100);
const CITIES = Number(process.env.CITIES || 9);

console.log(`\n=== ${ACCOUNTS} accounts x ${CITIES} cities, held in memory ===`);
gc();
const before = { rss: rss(), heap: heap() };

const sessions = [];
for (let a = 0; a < ACCOUNTS; a++) {
  const castles = [];
  for (let c = 0; c < CITIES; c++) castles.push(castle(a * 100 + c));
  sessions.push({
    castles,
    player: {
      playerInfo: { userName: 'Lord' + a, prestige: 3e8, honor: 1e8, medal: 1200, ranking: 500 },
      selfArmys: [], enemyArmys: [],
      items: Array.from({ length: 110 }, (_, k) => ({ id: 'player.item.' + k, count: 100 })),
    },
    // the per-account rings the console keeps
    log: new Array(400).fill(null).map((_, k) => ({ t: Date.now(), m: 'log line ' + k })),
    chat: { alliance: [], world: [], private: [], system: [] },
    engineState: {},
  });
}
gc();
const after = { rss: rss(), heap: heap() };
const perAccount = (after.heap - before.heap) / ACCOUNTS;

console.log(`  heap for all            ${MB(after.heap - before.heap)} MB`);
console.log(`  PER ACCOUNT             ${(perAccount / 1024).toFixed(0)} KB`
  + `   (${(perAccount / CITIES / 1024).toFixed(0)} KB per city)`);
console.log(`  process rss now         ${MB(after.rss)} MB`);

// ------------------------------------------------------------- tick cost
console.log('\n=== engine plan tick (dry run, no network) ===');
const { Engine } = require('./engine');
const { parseGoals } = require('./goals');
const GOALS = parseGoals([
  'config comfort:1,hero:1,troopsusepopmax:1,npc:5',
  'comfortpolicy 15 16 popraise',
  'build f:10:37',
  'troop b:5k,t:5k',
  'troop wo:10k,w:10k,s:10k,p:10k,sw:10k,a:10k,t:10k,c:10k,cata:10k,b:10k',
  'fortification ab:5000',
  'distancepolicy 15',
  'npcteams 3',
].join('\n'));

const g = {
  castles: sessions[0].castles,
  player: sessions[0].player,
  castle: () => sessions[0].castles[0],
  castleId: (c) => c.id,
  castleXY: () => ({ x: 400, y: 400 }),
  now: () => Date.now(),
  req: async () => ({ ok: 1 }),
};
const e = new Engine(g, () => {}, 'bench');
e.dryRun = true;
e.goalsFor = () => GOALS;

(async () => {
  await e.focus(g.castles[0]);                    // warm up
  const N = 50;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) await e.focus(g.castles[i % CITIES]);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log(`  one city plan tick      ${ms.toFixed(1)} ms`);
  console.log(`  ${CITIES} cities                ${(ms * CITIES).toFixed(0)} ms per account per tick`);
  console.log(`  ${ACCOUNTS} accounts on a 60s tick   `
    + `${((ms * CITIES * ACCOUNTS) / 1000).toFixed(1)}s of CPU per minute `
    + `= ${((ms * CITIES * ACCOUNTS) / 600).toFixed(1)}% of ONE core`);

  console.log('\n=== v8 heap ceiling ===');
  const hs = v8.getHeapStatistics();
  console.log(`  heap limit              ${MB(hs.heap_size_limit)} MB (raise with --max-old-space-size)`);
  console.log('');
})();
