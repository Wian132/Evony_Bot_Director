'use strict';
// Cancelling what the barracks and the Walls are making.
//
//   canceltroopqueues [n]      each barrack keeps its first n batches, the rest are cancelled
//   cancelfortifications [n]   the Walls queue keeps its first n batches
//
// NEAT's commands and meaning (guide.neatportal.com/wiki/CancelTroopQueues and
// /CancelFortifications): with no n, every batch goes. canceltroops,
// cancelwalls and clearwallqueue (the wiki's old page name) do the same. The ✖
// on a batch in the console's Barracks and Fortifications panels is cancelOne().
//
// The client cancels one batch at a time, by the queueId the queue reply gives
// it (Barrack.doCancel, Wall.doCancel):
//   troop.cancelTroopProduce                   {castleId, positionId, queueId}
//   fortifications.cancelFortificationProduce  {castleId, queueId}
// Neither queue is pushed, so it is read first. Batches go from the back, so
// the one in training is the last to go.
const C = require('./constants');

const BARRACKS = 2;   // building typeId
const TROOP_BY_TYPE = Object.fromEntries(C.TROOPS.map((t) => [t.typeId, t]));

const KINDS = {
  troop: { batches: 'troop', where: 'barracks', read: (g, cid) => g.troopQueue(cid) },
  wall: { batches: 'fortification', where: 'Walls', read: (g, cid) => g.wallQueue(cid) },
};
const COMMANDS = {
  canceltroopqueues: 'troop', canceltroops: 'troop',
  cancelfortifications: 'wall', cancelwalls: 'wall', clearwallqueue: 'wall',
};

const fmt = (v) => Number(v || 0).toLocaleString('en-US');
const say = (r) => (r && r.ok === 1 ? 'ok'
  : `FAILED (ok=${r ? r.ok : '?'})${r && r.errorMsg ? ' - ' + r.errorMsg : ''}`);

// `cmd` is one of COMMANDS; args are the tokens after it.
function parseArgs(cmd, args) {
  const kind = COMMANDS[cmd];
  if (!kind) throw new Error('not a queue-cancel command: ' + cmd);
  if (args.length > 1 || (args.length === 1 && !/^\d+$/.test(args[0]))) {
    throw new Error(`${cmd}: usage  ${cmd} [n]   — leaves n batches in `
      + `${kind === 'troop' ? 'each barrack' : 'the Walls queue'}; without n every batch is cancelled`);
  }
  return { kind, keep: args.length ? parseInt(args[0], 10) : 0 };
}

// One batch in words: "4,916 Ballista".
function describe(kind, it) {
  const def = kind === 'troop' ? TROOP_BY_TYPE[it.type] : C.WALL_BY_TYPE[it.type];
  return `${fmt(it.num)} ${def ? def.name : 'of type ' + it.type}`;
}

// A barrack by the number the console's Barracks panel gives it: its place
// among the city's barracks, in plot order.
function barrackName(castle, positionId) {
  const plots = (castle.buildings || []).filter((b) => Number(b.typeId) === BARRACKS)
    .map((b) => Number(b.positionId)).sort((a, b) => a - b);
  const i = plots.indexOf(Number(positionId));
  return i === -1 ? `the barrack on plot ${positionId}` : `barrack ${i}`;
}

// The queue as the server holds it now: one entry per barrack (the Walls give
// one), its batches in queue order. Throws when it cannot be read.
async function read(game, castle, kind) {
  const r = await KINDS[kind].read(game, game.castleId(castle));
  if (!r || r.ok !== 1) throw new Error(`the ${KINDS[kind].where} queue could not be read (${(r && r.errorMsg) || 'no reply'})`);
  return (r.allProduceQueue || []).map((b) => ({
    positionId: Number(b.positionId),
    items: (b.allProduceQueue || []).map((p) => ({ queueId: Number(p.queueId), type: Number(p.type), num: Number(p.num || 0) })),
  }));
}

function send(game, cid, kind, positionId, queueId) {
  return kind === 'troop' ? game.cancelTroop(cid, positionId, queueId) : game.cancelWall(cid, queueId);
}

// The console keeps the queues for a few seconds; after a cancel it should read
// them again rather than show batches that are gone.
function forget(session, cid) {
  if (session && session.xcache) session.xcache.delete(`${cid}:queues`);
}

// What was cancelled comes back on the engine's next pass while a goal still
// wants it. Null when that will not happen.
function refillNote(session, castle, kind) {
  if (!session || session.userPaused) return null;
  const stage = kind === 'troop' ? session.activeTroopStage : session.activeFortStage;
  if (typeof stage !== 'function') return null;
  const st = stage.call(session, castle);
  if (!st || st.done) return null;
  return `this city's ${KINDS[kind].batches} goal is still short, so the engine will queue more on its next pass — pause it to keep the queue empty`;
}

// The console's ✖: one batch, and only one this city's queue holds right now,
// never an arbitrary id. Resolves { ok, error, text } for the log.
async function cancelOne(game, castle, kind, { positionId, queueId } = {}, { session = null } = {}) {
  if (!KINDS[kind]) throw new Error('kind must be troop or wall');
  const queues = await read(game, castle, kind);
  const b = queues.find((x) => (kind === 'wall' || x.positionId === Number(positionId))
    && x.items.some((it) => it.queueId === Number(queueId)));
  if (!b) throw new Error('that batch is no longer in the queue — it may have finished');
  const it = b.items.find((x) => x.queueId === Number(queueId));
  const cid = game.castleId(castle);
  const where = kind === 'troop' ? barrackName(castle, b.positionId) : 'the Walls';
  let r;
  try { r = await send(game, cid, kind, b.positionId, it.queueId); } finally { forget(session, cid); }
  return {
    ok: !!(r && r.ok === 1),
    error: r && r.ok !== 1 ? (r.errorMsg || `the server refused it (ok=${r.ok})`) : null,
    text: `cancel ${describe(kind, it)} in ${where} (queue ${it.queueId}) -> ${say(r)}`,
  };
}

// The script commands. Resolves how many batches were cancelled.
async function run(game, a, { castle: ref, session = null, dryRun = false, log = () => {} } = {}) {
  const castle = game.castle(ref);
  const cid = game.castleId(castle);
  const k = KINDS[a.kind];
  let queues;
  try { queues = await read(game, castle, a.kind); } catch (e) { log(`  ${e.message} — nothing sent`); return 0; }
  // The Walls are one queue, however the reply splits it.
  if (a.kind === 'wall') queues = [{ positionId: null, items: queues.flatMap((b) => b.items) }];

  const doomed = [];
  for (const b of queues) {
    for (let i = b.items.length - 1; i >= a.keep; i--) doomed.push({ b, it: b.items[i] });
  }
  const total = queues.reduce((s, b) => s + b.items.length, 0);
  const keeping = a.keep ? `, keeping ${a.keep} per ${a.kind === 'troop' ? 'barrack' : 'queue'}` : '';
  if (!doomed.length) {
    log(`  nothing to cancel — ${castle.name} has ${total} ${k.batches} batch(es) queued${keeping}`);
    return 0;
  }
  log(`  ${castle.name}: cancelling ${doomed.length} of ${total} ${k.batches} batch(es)${keeping}`);

  let cancelled = 0, misses = 0;
  for (const { b, it } of doomed) {
    const line = `  ${a.kind === 'troop' ? barrackName(castle, b.positionId) : 'Walls'}: ${describe(a.kind, it)} (queue ${it.queueId})`;
    if (dryRun) { log(line + ' — [dry run] not sent'); continue; }
    let r;
    try { r = await send(game, cid, a.kind, b.positionId, it.queueId); } catch (e) {
      log(`${line} -> ${e.message}`);
      // Unanswered twice running: the server is ignoring us; stop, as trading does.
      if (++misses >= 2) { log('  STOPPING: the server stopped answering. Give it a few minutes.'); break; }
      continue;
    }
    misses = 0;
    if (r && r.ok === 1) cancelled++;
    log(`${line} -> ${say(r)}`);
  }
  if (dryRun) return 0;
  forget(session, cid);
  log(`  cancelled ${cancelled} of ${doomed.length}`);
  const note = cancelled ? refillNote(session, castle, a.kind) : null;
  if (note) log('  note: ' + note);
  return cancelled;
}

module.exports = { KINDS, COMMANDS, parseArgs, describe, barrackName, read, cancelOne, refillNote, run };
