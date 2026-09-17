'use strict';
// Teleporting a city: three items, three commands (CityCommands.as).
//
//   teleport 123,456       Advanced Teleporter  player.more.castle.1.a  city.advMoveCastle  onto an empty flat
//   warteleport 123,456    War Teleporter       player.more.castle.1.c  city.WarMoveCastle  onto an NPC camp
//   teleport thuringia     City Teleporter      consume.move.1          city.moveCastle     somewhere in that state
//   teleport random        City Teleporter, the state picked at random (MoveCityWin.randomName)
//
// Each takes `from <city>`; without it the open city tab moves.
//
// The server spends the item and is the judge of every target. But a refused
// teleport is a confusing error at best, so before sending: the item must be
// held (UseGoodWin.canUseGood checks the same; an inventory not loaded yet
// counts as none, since a missing one is bought with cents), the target must not be one of
// our own cities, and, read live off the map, a coordinate teleport must be
// the kind of tile its item lands on. A tile that cannot be read is left to
// the server to judge.
const C = require('./constants');

const KINDS = {
  adv: { itemId: 'player.more.castle.1.a', label: 'Advanced Teleporter' },
  war: { itemId: 'player.more.castle.1.c', label: 'War Teleporter' },
  state: { itemId: 'consume.move.1', label: 'City Teleporter' },
};
const ITEM_IDS = new Set(Object.values(KINDS).map((k) => k.itemId));

// ErrorCode.as, the codes a move can hit. The server's own errorMsg is shown too.
const HINTS = {
  [-77]: 'armies from this city are still out — recall them first',
  [-78]: 'alliance troops are stationed in this city — they have to leave first',
  [-81]: 'that tile is not an empty flat',
  [-84]: 'that tile is already yours',
  [-90]: 'this city is still on teleport cooldown',
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const ZONE_BY_NORM = new Map(C.ZONES.map((z) => [norm(z), z]));
const fmt = (v) => Number(v || 0).toLocaleString('en-US');

// `cmd` is teleport or warteleport; args are the tokens after it.
function parseArgs(cmd, args) {
  const toks = args.slice();
  let from = null;
  const fi = toks.findIndex((t) => t.toLowerCase() === 'from');
  if (fi !== -1) {
    from = toks.slice(fi + 1).join(' ');
    if (!from) throw new Error(`${cmd}: "from" needs a city name`);
    toks.splice(fi);
  }
  const usage = cmd === 'warteleport'
    ? 'warteleport: usage  warteleport <x,y>   (onto an NPC camp)'
    : 'teleport: usage  teleport <x,y>  |  teleport <state>  |  teleport random';
  if (!toks.length) throw new Error(usage);

  const xy = toks.join('').match(/^(\d+),(\d+)$/);
  if (xy) {
    const target = { x: +xy[1], y: +xy[2] };
    if (target.x >= C.MAP_W || target.y >= C.MAP_W) {
      throw new Error(`${cmd}: ${target.x},${target.y} is off the map (0-${C.MAP_W - 1})`);
    }
    return { kind: cmd === 'warteleport' ? 'war' : 'adv', target, from };
  }
  if (cmd === 'warteleport') throw new Error(usage + ' — a War Teleporter needs coordinates');

  const word = norm(toks.join(''));
  if (word === 'random' || word === 'any') return { kind: 'state', zone: null, from };
  const zone = ZONE_BY_NORM.get(word);
  if (!zone) {
    throw new Error(`teleport: "${toks.join(' ')}" is neither coordinates (like 123,456) nor a state. `
      + `States: ${C.ZONES.join(', ')} — or random`);
  }
  return { kind: 'state', zone, from };
}

// How many of an item we hold, or null when the inventory was never loaded
// (run() then sends nothing).
function heldCount(game, itemId) {
  const items = game.player && game.player.items;
  if (!Array.isArray(items)) return null;
  const it = items.find((i) => i.id === itemId);
  return it ? Number(it.count || 0) : 0;
}

// One live tile, through the console's map reader. Never logs in to do it.
async function readTile(session, xy) {
  if (!session || typeof session.scanArea !== 'function' || !session.connected) return null;
  try {
    const r = await session.scanArea(xy.x, xy.y, 0, { fresh: true });
    return (r.tiles || []).find((t) => t.x === xy.x && t.y === xy.y) || null;
  } catch { return null; }
}

function describeTile(t) {
  const lvl = t.level ? ` (level ${t.level})` : '';
  if (t.kind === 'npc') return 'an NPC camp' + lvl;
  if (t.userName || t.kind === 'player' || t.kind === 'castle') {
    return 'a city' + (t.name ? ` (${t.name}${t.userName ? ', ' + t.userName : ''})` : '');
  }
  if (t.kind === 'flat') return 'an empty flat' + lvl;
  return `${t.typeName || t.kind}${t.level ? ' level ' + t.level : ''}`;
}

// Is this the kind of tile the item lands on?
function judge(kind, tile, xy) {
  const where = `${xy.x},${xy.y}`;
  if (!tile) return { refuse: false, text: `${where}: could not read the tile first — the server will judge it` };
  const what = describeTile(tile);
  const flat = tile.kind === 'flat' && !tile.userName && !tile.npc;
  if (kind === 'adv') {
    if (flat) return { refuse: false, text: `${where} is ${what}` };
    return { refuse: true, text: `${where} is ${what}; an Advanced Teleporter only lands on an empty flat`
      + (tile.kind === 'npc' ? ` — to land on an NPC use:  warteleport ${where}` : '') };
  }
  if (tile.kind === 'npc') return { refuse: false, text: `${where} is ${what}` };
  return { refuse: true, text: `${where} is ${what}; a War Teleporter only lands on an NPC camp`
    + (flat ? ` — to land on a flat use:  teleport ${where}` : '') };
}

// The new tile arrives as a server.CastleUpdate push, and it can beat the
// command's own reply, so listen from before the send. arm() starts the clock
// once the server has said yes.
function waitForMove(game, castleId, fromField, ms) {
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
    if (cmd !== 'server.CastleUpdate' || !data || !data.castleBean) return;
    const cb = data.castleBean;
    // 0 add, 1 delete; anything else is an update (Context.onCastleUpdate)
    if (Number(game.castleId(cb)) !== Number(castleId) || [0, 1].includes(Number(data.updateType))) return;
    if (cb.fieldId === undefined || Number(cb.fieldId) === Number(fromField)) return;
    finish(Number(cb.fieldId));
  };
  game.c.on('cmd', onCmd);
  return {
    promise,
    arm: () => { if (!settled) timer = setTimeout(() => finish(null), ms); },
    cancel: () => finish(null),
  };
}

// Resolves true when the city moved.
async function run(game, a, { castle: ref, session = null, dryRun = false, log = () => {},
  waitMs = 5000, random = Math.random } = {}) {
  const kind = KINDS[a.kind];
  if (!kind) throw new Error('unknown teleport kind: ' + a.kind);
  const castle = game.castle(a.from ?? ref);
  const castleId = game.castleId(castle);
  const fromField = castle.fieldId;
  const here = game.castleXY(castle);
  const at = here ? `${here.x},${here.y} (${C.zoneOf(here.x, here.y)})` : '(position unknown)';

  // The game buys a missing teleporter with cents (the move window's buy
  // prompt), so an unknown count is none held.
  const held = heldCount(game, kind.itemId);
  if (held === null) {
    log(`  the inventory is not loaded, so whether ${/^[AEIOU]/.test(kind.label) ? 'an' : 'a'} ${kind.label} is held cannot be checked`
      + ' — nothing sent (the game would buy one with cents)');
    return false;
  }
  if (held < 1) {
    log(`  no ${kind.label} in the inventory (${kind.itemId}) — nothing sent`);
    return false;
  }
  const holding = `, ${fmt(held)} held`;

  let send, targetField = null;
  if (a.target) {
    targetField = C.coordsToFieldId(a.target.x, a.target.y);
    const own = (game.castles || []).find((c) => Number(c.fieldId) === targetField);
    if (own) {
      log(`  ${a.target.x},${a.target.y} is your own city ${own.name} — nothing sent`);
      return false;
    }
    const v = judge(a.kind, await readTile(session, a.target), a.target);
    log('  ' + v.text + (v.refuse ? ' — nothing sent' : ''));
    if (v.refuse) return false;
    log(`  ${kind.label}: ${castle.name} ${at} -> ${a.target.x},${a.target.y} `
      + `(${C.zoneOf(a.target.x, a.target.y)})${holding}`);
    send = () => (a.kind === 'war' ? game.warMoveCastle(castleId, targetField) : game.advMoveCastle(castleId, targetField));
  } else {
    // The zone ids are the server's; only ever send one it listed.
    let z;
    try { z = await game.zoneInfo(); } catch (e) { z = { errorMsg: e.message }; }
    const zones = (z && z.zones) || [];
    if (!zones.length) {
      log(`  could not read the list of states (${(z && z.errorMsg) || 'empty reply'}) — nothing sent`);
      return false;
    }
    let zone;
    if (a.zone) {
      zone = zones.find((x) => norm(x.name) === norm(a.zone));
      if (!zone) {
        log(`  the server lists no state called ${a.zone} (it has: ${zones.map((x) => x.name).join(', ')}) — nothing sent`);
        return false;
      }
    } else {
      zone = zones[Math.min(zones.length - 1, Math.floor(random() * zones.length))];
      log(`  random pick: ${zone.name}`);
    }
    log(`  ${zone.name}: ${fmt(zone.playerCount)} players, ${fmt(zone.castleCount)} cities, ${Number(zone.rate || 0)}% crowded`);
    log(`  ${kind.label}: ${castle.name} ${at} -> somewhere in ${zone.name}${holding}`);
    send = () => game.moveCastle(castleId, zone.id);
  }

  if (dryRun) { log('  [dry run] not sent'); return false; }

  const moved = waitForMove(game, castleId, fromField, waitMs);
  let r;
  try { r = await send(); } catch (e) { moved.cancel(); throw e; }
  if (!r || r.ok !== 1) {
    moved.cancel();
    const hint = r && HINTS[r.ok];
    log(`  -> FAILED (ok=${r ? r.ok : '?'})${r && r.errorMsg ? ' - ' + r.errorMsg : ''}${hint ? ' — ' + hint : ''}`);
    return false;
  }
  moved.arm();
  let newField = await moved.promise;
  // An exact-tile move the server accepted landed on that tile, push or not.
  if (newField === null && targetField !== null) newField = targetField;
  if (newField !== null) castle.fieldId = newField;

  // Stop trusting any buildnpc claim on this city now, then let the registry
  // follow it to the new tile (see goal-buildnpc.js canAbandon).
  if (session && session.org && session.account && session.account.id) {
    try { session.org.registry.markMoved(session.account.id, castleId); } catch (e) { log('  city registry: ' + e.message); }
    if (typeof session.reconcileRegistry === 'function') session.reconcileRegistry(game);
  }

  const left = heldCount(game, kind.itemId);
  const spent = held !== null && left !== null && left < held ? `, ${fmt(left)} ${kind.label} left` : '';
  if (newField === null) {
    log(`  -> ok — ${castle.name} moved, but the server has not said where yet${spent}`);
  } else {
    const xy = C.fieldIdToCoords(newField);
    log(`  -> ok — ${castle.name} is now at ${xy.x},${xy.y} (${C.zoneOf(xy.x, xy.y)})${spent}`);
  }
  return true;
}

module.exports = { KINDS, ITEM_IDS, HINTS, parseArgs, heldCount, judge, describeTile, run };
