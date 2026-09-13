'use strict';
// Map scanner + local map memory.
//
//   node mapscan.js                     scan the whole world (800x800)
//   node mapscan.js 400 200 599 399     scan one province
//   node mapscan.js --find WhoAreYou    instant lookup from the cache (no login)
//   node mapscan.js --alliance Marvel   everyone in an alliance
//
// The server clamps map requests to 20x20, so the region is tiled into blocks and
// pipelined. Responses echo their own x1/y1/x2/y2, so they are self-identifying.
const fs = require('fs');
const path = require('path');
const { Game } = require('./game');
const C = require('./constants');

const D = require('./db');
const BLOCK = 20;          // server maximum
const IN_FLIGHT = 16;      // blocks pipelined at once

function loadEnv() {
  const out = {};
  const p = path.join(__dirname, '.env');
  if (fs.existsSync(p)) for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2];
  }
  return out;
}

const loadCache = () => D.mapCache.asJson();

function show(rows) {
  if (!rows.length) return console.log('nothing matched');
  console.log(`${rows.length} match(es):`);
  for (const c of rows.slice(0, 200)) {
    const { x, y } = C.fieldIdToCoords(Number(c.id));
    console.log(`  ${String(c.userName || '(npc)').padEnd(18)} ${String(c.name || '').padEnd(20)} ${String(x + ',' + y).padEnd(9)} ${String(c.allianceName || '-').padEnd(14)} pres ${Number(c.prestige || 0).toLocaleString('en-US')}`);
  }
  if (rows.length > 200) console.log(`  … and ${rows.length - 200} more`);
}

// ---------- offline lookups ----------
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };

if (argv.includes('--find') || argv.includes('--alliance')) {
  const cache = loadCache();
  const all = Object.values(cache.castles || {});
  if (!all.length) { console.log('cache is empty — run a scan first'); process.exit(0); }
  const age = Math.round((Date.now() - cache.updatedAt) / 60000);
  console.log(`cache: ${all.length.toLocaleString('en-US')} castles, ${age} min old\n`);
  const q = (flag('--find') || flag('--alliance') || '').toLowerCase();
  const key = argv.includes('--find') ? 'userName' : 'allianceName';
  const t0 = Date.now();
  const rows = all.filter((c) => String(c[key] || '').toLowerCase().includes(q));
  console.log(`searched in ${Date.now() - t0}ms`);
  show(rows);
  process.exit(0);
}

// ---------- scan ----------
(async () => {
  const env = loadEnv();
  const [ax, ay, bx, by] = argv.map(Number);
  const region = argv.length === 4 ? { x1: ax, y1: ay, x2: bx, y2: by } : { x1: 0, y1: 0, x2: 799, y2: 799 };

  const blocks = [];
  for (let y = region.y1; y <= region.y2; y += BLOCK)
    for (let x = region.x1; x <= region.x2; x += BLOCK)
      blocks.push({ x1: x, y1: y, x2: Math.min(x + BLOCK - 1, region.x2), y2: Math.min(y + BLOCK - 1, region.y2) });

  console.log(`region ${region.x1},${region.y1} -> ${region.x2},${region.y2}  = ${blocks.length} blocks of ${BLOCK}x${BLOCK}`);

  const g = new Game((m) => { if (!/^-> /.test(m)) console.log('  ' + m); });
  await g.connect(env.EVONY_SERVER || 'ss71', env.EVONY_EMAIL, env.EVONY_PASSWORD);

  const cache = loadCache();
  cache.castles = cache.castles || {};

  let done = 0, found = 0, alive = true;
  g.c.on('log', (m) => { if (/closed/.test(m)) alive = false; });
  g.c.on('cmd', (cmd, data) => {
    if (cmd !== 'common.mapInfoSimple') return;
    done++;

    // Decode the terrain byte pair for this block. Without it an NPC camp has no
    // LEVEL, and npc farming cannot choose targets — which is why a bulk sweep
    // used to leave most camps unusable.
    const terrain = new Map();
    if (typeof data.mapStr === 'string' && data.mapStr.length) {
      const w = data.x2 - data.x1 + 1;
      for (let yy = data.y1; yy <= data.y2; yy++) {
        for (let xx = data.x1; xx <= data.x2; xx++) {
          const idx = ((yy - data.y1) * w + (xx - data.x1)) * 2;
          const t = C.decodeTile(data.mapStr.substr(idx, 2));
          if (t) terrain.set(xx + ',' + yy, t);
        }
      }
    }

    // Empty tiles matter too: a FLAT is where an NPC can be built, and its level
    // is what decides the level of the NPC that ends up there. They appear only
    // in mapStr, never in `castles`, so they used to be decoded and thrown away.
    for (const [xy, t] of terrain) {
      if (!t || !t.key) continue;
      if (t.key === 'castle' || t.key === 'npc') continue;      // covered below
      const [xx, yy] = xy.split(',').map(Number);
      const id = C.coordsToFieldId(xx, yy);
      if (cache.castles[id] && cache.castles[id].userName) continue;   // occupied
      cache.castles[id] = {
        id, x: xx, y: yy,
        kind: t.key, typeName: t.name, type: t.type, level: t.level,
        npc: false, seen: Date.now(),
      };
    }

    for (const c of data.castles || []) {
      // NPC camps are kept too -- the npc farming goal reads them from here.
      const xy = C.fieldIdToCoords(Number(c.id));
      const t = terrain.get(xy.x + ',' + xy.y);
      cache.castles[c.id] = {
        id: c.id, x: xy.x, y: xy.y,
        name: c.name, userName: c.userName, allianceName: c.allianceName,
        prestige: c.prestige, honor: c.honor, state: c.state, furlough: c.furlough,
        npc: !!c.npc,
        level: t ? t.level : undefined,
        kind: t ? t.key : (c.npc ? 'npc' : 'player'),
        typeName: t ? t.name : undefined,
        seen: Date.now(),
      };
      found++;
    }
  });

  const t0 = Date.now();
  for (let i = 0; i < blocks.length && alive; i += IN_FLIGHT) {
    const batch = blocks.slice(i, i + IN_FLIGHT);
    const target = done + batch.length;
    for (const b of batch) g.c.send('common.mapInfoSimple', b);
    const deadline = Date.now() + 30000;
    while (done < target && Date.now() < deadline && alive) await new Promise((r) => setTimeout(r, 5));
    if (done < target) console.log(`  block batch timed out (${done}/${target}) — continuing`);
    if (i % (IN_FLIGHT * 10) === 0 || i + IN_FLIGHT >= blocks.length) {
      const pct = Math.round((done / blocks.length) * 100);
      const rate = done / ((Date.now() - t0) / 1000);
      const eta = Math.round((blocks.length - done) / Math.max(rate, 0.01));
      console.log(`  ${String(pct).padStart(3)}%  ${done}/${blocks.length} blocks  ${Object.keys(cache.castles).length.toLocaleString('en-US')} castles  ${rate.toFixed(1)} blocks/s  eta ${eta}s`);
    }
  }

  // One transaction for the whole sweep: either the scan lands or it does not,
  // instead of the old 150 KB whole-file rewrite that a crash could truncate.
  D.mapCache.upsertMany(Object.values(cache.castles));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nscanned ${done} blocks in ${secs}s — ${D.mapCache.count().toLocaleString('en-US')} castles cached`);
  console.log(`cache: ${D.FILE} (${(D.stats().sizeBytes / 1e6).toFixed(1)} MB total)`);
  g.close();
  process.exit(0);
})();
