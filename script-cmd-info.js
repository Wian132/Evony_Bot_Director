'use strict';
// Information, map and fetch commands for scripts (the command-module contract
// is at the top of script.js).
//
//   listbuffs                   BUFFS: <what> (expires in 177d:7h:29m:18), one line a buff:
//                               the account's, then this city's ([City] in front)
//   listitems                   Items: 2 Civil Code, 82 Truce Agreement, ...  (every item held)
//   listmedals                  Medals: 94 Freedom Medal, 117 Wisdom Medal, ...
//   listcommands [word]         *** every command *** and each one's usage; with a word, only
//                               the commands whose names hold it
//   scanmap x,y radius          read the map into memory: the square of tiles within `radius` of
//   scanmap x1,y1 x2,y2         x,y, or the rectangle between the top-left and bottom-right
//   scanrec x1,y1 x2,y2         corners. findfield, FindField and the other map functions search
//                               it. A 20x20 block the console read in the last 30 minutes is not
//                               asked again. The 16 states are 200x200: Thuringia is 400,200 599,399
//   rescanmap x,y radius | rescanmap x1,y1 x2,y2 | rescanrec x1,y1 x2,y2
//                               the same, but every block is read again, and what was known there
//                               is forgotten first (ResetMap), so a castle that has gone drops out
//   findfield <type> <level> <radius> [<hero> <troops>]
//                               read the map around this city (as scanmap) and list each field of
//                               that type (castle npc forest desert hill swamp grassland lake flat)
//                               and level (0 = any) within the radius, nearest first. With a hero
//                               and troops: an  attack x,y <hero> <troops>  line a field, with its
//                               distance and mission time, to paste into a script. Valley owners
//                               are not checked (NEAT's neither).
//   get "<http(s) address>" | get "<file>" | get url
//                               a web page (a battle log: report = xml($result)) or a file in the
//                               console's scripts folder (<repo>\scripts). With no such file,
//                               NewCityGoals.txt, PrependGoals.txt and AppendGoals.txt are the
//                               account's goal texts. Only addresses on the public internet
//                               (script-net.js): never this machine, its networks or a special-
//                               purpose address. Put an address in quotes (// starts a comment).
//   find <player name>          castles of that player in the saved map cache
//
// $result: listbuffs, listitems, listmedals and listcommands -> an array of plain objects, each
// printing as its line; the scans -> {area, blocks, read, known, failed, castles, npcs, stopped};
// findfield -> the field ids nearest first, or with a hero and troops the attack lines as text
// (execute $result sends them); get -> the text. $error says why not.
//
// Scans go through the console's own map reader (Session.fetchMapBlocks: common.mapInfoSimple,
// 20x20 tiles a request, 9 on the wire at once), paced (run() opts.scanGapMs, 300 ms between
// batches; opts.scanTimeoutMs, 10 s for a batch's answers) and cut short by Stop. A run without
// the session reads a block at a time with game.req. Castles, NPCs and flats land in the saved
// map cache for good; forests, hills and the other valleys stay in the session's memory for 30
// minutes, so scan shortly before searching them. A script never logs in: with the console
// offline a scan fails and says so (findfield then searches what is already known).
const fs = require('fs');
const C = require('./constants');
const W = require('./script-words');
const E = require('./script-expr');

// Required when first used, so loading the command table stays cheap.
const lazy = (name) => { let m = null; return () => (m = m || require(name)); };
const F = lazy('./script-functions');
const NET = lazy('./script-net');

const safe = (f, dflt = null) => { try { return f(); } catch { return dflt; } };
const p2 = (n) => String(n).padStart(2, '0');
// A $result row prints as its line (echo $result, rows.join(', ')).
const printsAs = (o, text) => Object.defineProperty(o, 'toString', { value: () => text, enumerable: false });
const nothingAfter = (word) => (args) => {
  if (String(args || '').trim()) throw new Error(`${word}: nothing goes after it`);
  return {};
};

// NEAT's lengths of time: 01m:41, 2h:57m:46, 177d:7h:29m:18.
function neatTime(sec) {
  const t = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  if (d) return `${d}d:${h}h:${p2(m)}m:${p2(s)}`;
  if (h) return `${h}h:${p2(m)}m:${p2(s)}`;
  return `${p2(m)}m:${p2(s)}`;
}
// ListBuffs: "More than a year", "More than 3 years", else the time left.
function expiresIn(ms) {
  const days = ms / 86400000;
  if (days >= 730) return `More than ${Math.floor(days / 365)} years`;
  if (days >= 365) return 'More than a year';
  return neatTime(ms / 1000);
}

// ------------------------------------------------------------------ listbuffs

// The account's buffs, then the run's city's, as they came with the login and
// the pushes since. One whose end has passed is left out.
function buffRows(env) {
  const g = env.game;
  const now = typeof g.now === 'function' ? g.now() : Date.now();
  const castle = safe(() => env.castle);
  const rows = [];
  const add = (b, city) => {
    if (!b || typeof b !== 'object') return;
    const end = Number(b.endTime) || 0;
    if (end && end <= now) return;
    const what = String(b.descName || b.typeId || 'a buff');
    const row = {
      typeId: b.typeId === undefined || b.typeId === null ? null : String(b.typeId),
      descName: b.descName === undefined || b.descName === null ? null : String(b.descName),
      endTime: end || null,
      expiresIn: end ? Math.floor((end - now) / 1000) : null,   // seconds; null = no end
      city,
    };
    rows.push(printsAs(row, `${city ? `[${city}] ` : ''}${what}${end ? ` (expires in ${expiresIn(end - now)})` : ''}`));
  };
  for (const b of (g.player && g.player.buffs) || []) add(b, null);
  if (castle) for (const b of castle.buffs || []) add(b, String(castle.name || g.castleId(castle)));
  return rows;
}

// ------------------------------------------------------------------ listitems / listmedals

// items.js names what is held and files the nine loyalty medals apart; the
// order is the server's, as NEAT prints it.
function heldItems(env, medalsOnly) {
  const inv = require('./items').inventory(env.game);
  const rows = inv.items.filter((r) => !medalsOnly || r.medal).map((r) => printsAs(
    { id: r.id, name: r.name, count: r.count, category: r.category, medal: r.medal }, `${r.count} ${r.name}`));
  return { rows, named: inv.named };
}

const itemList = (word, label, medalsOnly) => ({
  usage: word,
  parse: nothingAfter(word),
  async run(a, env) {
    const { rows, named } = heldItems(env, medalsOnly);
    env.log(`  ${label}: ${rows.length ? rows.join(', ') : 'none'}`);
    if (!named && rows.some((r) => r.name === r.id)) env.log('  (item names come from itemcatalog.json — see items.js; ids are shown instead)');
    return { ok: true, result: rows };
  },
});

// ------------------------------------------------------------------ listcommands

// Only when the run cannot hand over its registry (env.registry).
const LANGUAGE = ['label', 'goto', 'gosub', 'return', 'gosubreturn', 'if', 'ifgoto', 'ifgosub', 'loop', 'endloop',
  'repeat', 'end', 'exit', 'stop', 'die', 'echo', 'print', 'sleep', 'set', 'execute', 'call', 'command',
  'function', 'endfunction', 'callfunc'];

// { commands: [{name, usage, words}], inline: [...], keywords } — the run's own
// registry when the VM offers it, else the command modules on disk.
function commandTable(env) {
  if (typeof env.registry === 'function') {
    const r = safe(() => env.registry());
    if (r && Array.isArray(r.commands)) {
      return { commands: r.commands, inline: Array.isArray(r.inline) ? r.inline : [], keywords: r.keywords || LANGUAGE };
    }
  }
  const commands = [], inline = [], taken = new Set(LANGUAGE);
  const files = safe(() => fs.readdirSync(__dirname), []).filter((f) => /^script-cmd-[\w-]+\.js$/.test(f)).sort();
  for (const f of files) {
    let mod;
    try { mod = require('./' + f); } catch { continue; }
    for (const [name, spec] of Object.entries(mod.commands || {})) {
      if (!spec || typeof spec.parse !== 'function') continue;
      const words = (spec.words || [name, ...(spec.aliases || [])]).map((w) => String(w).toLowerCase()).filter((w) => !taken.has(w));
      for (const w of words) taken.add(w);
      if (words.length) commands.push({ name, usage: spec.usage || name, words });
    }
    for (const [name, spec] of Object.entries(mod.inline || {})) {
      inline.push({ name, usage: (spec && spec.usage) || name, words: [name, ...((spec && spec.aliases) || [])].map((w) => String(w).toLowerCase()) });
    }
  }
  return { commands, inline, keywords: LANGUAGE };
}

async function runListCommands(a, env) {
  const T = commandTable(env);
  const tidy = (c, inline) => {
    const words = (Array.isArray(c.words) ? c.words : [c.name]).map((w) => String(w).toLowerCase());
    const name = String(c.name);
    const row = { name, usage: String(c.usage || name), words, inline };
    return printsAs(row, row.usage);
  };
  const cmds = T.commands.map((c) => tidy(c, false)).filter((c) => c.words.length).sort((x, y) => x.name.localeCompare(y.name));
  const inl = T.inline.map((c) => tidy(c, true)).sort((x, y) => x.name.localeCompare(y.name));
  const f = a.filter;
  const hit = (c) => !f || c.name.includes(f) || c.words.some((w) => w.includes(f));
  // NEAT's line: a command by its name, or by its words when its name starts no line
  if (!f) env.log(`  *** ${cmds.flatMap((c) => (c.words.includes(c.name) ? [c.name] : c.words)).join(', ')} ***`);
  const shown = cmds.filter(hit), shownInline = inl.filter(hit);
  for (const c of shown) {
    const also = c.words.filter((w) => w !== c.name);
    env.log(`  ${c.usage}${also.length ? `   (also: ${also.join(', ')})` : ''}`);
  }
  if (shownInline.length) env.log(`  in-line, as  command "<name> ...":  ${shownInline.map((c) => c.usage).join(' | ')}`);
  if (!f) env.log(`  language: ${T.keywords.join(' ')}`);
  const rows = [...shown, ...shownInline];
  if (f && !rows.length) {
    const why = `no command has "${f}" in its name — listcommands on its own lists them all`;
    env.log('  ' + why);
    return { ok: false, error: why, result: [] };
  }
  return { ok: true, result: rows };
}

// ------------------------------------------------------------------ the map: areas

const BLOCK = 20;                    // the server answers at most 20x20 tiles (Session.MAP_BLOCK)
const WORLD = C.MAP_W;
const CHUNK = 6 * BLOCK;             // a rescan forgets and re-reads 6x6 blocks at a time
const wrapXY = (v) => ((Math.floor(v) % WORLD) + WORLD) % WORLD;
const XY = /^(-?\d+)\s*,\s*(-?\d+)$/;
const OFFLINE = 'the console is not connected to the game — a scan reads the map over its connection, and a script never logs in';

// "x,y radius" or "x1,y1 x2,y2" -> an area. The world wraps, so a corner a
// little off the map (city.x - 5 at the edge) is fine.
function parseArea(word, args, rectOnly) {
  const usage = rectOnly
    ? `${word} x1,y1 x2,y2   (the top-left and bottom-right corners; ${word} 0,0 799,799 is the whole map)`
    : `${word} x,y radius | ${word} x1,y1 x2,y2   (e.g. ${word} 111,222 30 or ${word} 0,0 799,799)`;
  const tok = String(args || '').trim().split(/\s+/).filter(Boolean);
  const a = tok.length === 2 ? XY.exec(tok[0]) : null;
  if (!a) throw new Error(`${word}: usage  ${usage}`);
  const fits = (v) => v >= -WORLD && v < 2 * WORLD;
  const b = XY.exec(tok[1]);
  if (b) {
    let [x1, y1, x2, y2] = [a[1], a[2], b[1], b[2]].map(Number);
    if (![x1, y1, x2, y2].every(fits)) throw new Error(`${word}: the map runs 0,0 to 799,799`);
    if (x2 < x1) [x1, x2] = [x2, x1];
    if (y2 < y1) [y1, y2] = [y2, y1];
    return { x1, y1, x2, y2, label: `${x1},${y1} ${x2},${y2}` };
  }
  if (rectOnly || !/^\d+(\.\d+)?$/.test(tok[1])) throw new Error(`${word}: usage  ${usage}`);
  const cx = Number(a[1]), cy = Number(a[2]);
  if (!fits(cx) || !fits(cy)) throw new Error(`${word}: the map runs 0,0 to 799,799`);
  const r = Math.min(400, Number(tok[1]));          // 400 either way already wraps round the world
  return { cx: wrapXY(cx), cy: wrapXY(cy), r, label: `${wrapXY(cx)},${wrapXY(cy)} radius ${r}` };
}

// A circle is read as the square around it, as the console's map does.
function areaBox(area) {
  const b = area.r !== undefined
    ? { x1: area.cx - area.r, y1: area.cy - area.r, x2: area.cx + area.r, y2: area.cy + area.r }
    : { x1: area.x1, y1: area.y1, x2: area.x2, y2: area.y2 };
  const fit = (lo, hi) => (hi - lo >= WORLD - 1 ? [0, WORLD - 1] : [Math.floor(lo), Math.ceil(hi)]);
  [b.x1, b.x2] = fit(b.x1, b.x2);
  [b.y1, b.y2] = fit(b.y1, b.y2);
  return b;
}

// The aligned 20x20 blocks (origins, wrapped into the world) that cover an
// area, nearest the middle first, so a scan cut short has read what matters.
function areaBlocks(area) {
  const b = areaBox(area);
  const mx = (b.x1 + b.x2) / 2, my = (b.y1 + b.y2) / 2;
  const out = new Map();
  for (let by = Math.floor(b.y1 / BLOCK) * BLOCK; by <= b.y2; by += BLOCK) {
    for (let bx = Math.floor(b.x1 / BLOCK) * BLOCK; bx <= b.x2; bx += BLOCK) {
      const o = { x: wrapXY(bx), y: wrapXY(by), d: Math.hypot(bx + BLOCK / 2 - mx, by + BLOCK / 2 - my) };
      const k = o.x + ',' + o.y;
      if (!out.has(k) || out.get(k).d > o.d) out.set(k, o);
    }
  }
  return [...out.values()].sort((p, q) => p.d - q.d || p.y - q.y || p.x - q.x).map(({ x, y }) => ({ x, y }));
}

// Blocks grouped by the 6x6-block cell they sit in, in the order met.
function chunked(blocks) {
  const m = new Map();
  for (const o of blocks) {
    const k = Math.floor(o.x / CHUNK) + ',' + Math.floor(o.y / CHUNK);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(o);
  }
  return [...m.values()];
}

// An unwrapped span of x (or y) -> the world ranges it covers.
function worldRanges(lo, hi) {
  lo = Math.floor(lo); hi = Math.ceil(hi);
  if (hi - lo >= WORLD - 1) return [[0, WORLD - 1]];
  const a = wrapXY(lo), b = wrapXY(hi);
  return a <= b ? [[a, b]] : [[a, WORLD - 1], [0, b]];
}

// ------------------------------------------------------------------ the map: reading

// Without the console's session (a run from elsewhere, a test) blocks are read
// one at a time with game.req; which blocks were read is kept here per game.
const READ_KEEP = 30 * 60000;        // as long as the session keeps a block (Session.MAP_BLOCK_KEEP)
const OWN_READS = new WeakMap();
function ownReads(g) {
  let m = OWN_READS.get(g);
  if (!m) { m = new Map(); OWN_READS.set(g, m); }
  const now = Date.now();
  for (const [k, at] of m) if (now - at > READ_KEEP) m.delete(k);
  return m;
}

const viaSession = (S) => !!(S && typeof S.fetchMapBlocks === 'function' && typeof S.mapStore === 'function');
const keyOf = (o) => o.x + ',' + o.y;

// One batch through the session: Session.mapBatch pipelines them on the
// socket, matches each reply by the rectangle it echoes and files it where
// FindField and the map functions read (mapStore, map_cache).
async function sessionBatch(env, batch, fresh, since) {
  const S = env.session;
  const t0 = Date.now();
  const floor = Number(S.constructor && S.constructor.MAP_FRESH_FLOOR) || 15000;
  // CommonCommands.as:375 mapInfoSimple(x1, y1, x2, y2) -> MapInfoSimpleResponse.as {x1, y1, x2, y2, mapStr, castles}
  await S.fetchMapBlocks(env.game, batch, { fresh, timeoutMs: Number(env.opts.scanTimeoutMs ?? 10000) });
  const store = S.mapStore();
  return batch.map((o) => {
    const e = store.blocks.get(keyOf(o));
    if (!e) return null;
    return !fresh || (e.at > since && e.at >= t0 - floor) ? e : null;
  });
}

// One batch with game.req, a block at a time (a reply is matched by command
// name only, so one is on the wire at once), filed as the session files them.
async function reqBatch(env, batch) {
  const g = env.game;
  const ms = Number(env.opts.scanTimeoutMs ?? 10000);
  const out = [];
  for (const o of batch) {
    if (env.stopped()) break;              // a shorter answer: the caller sees the Stop
    const data = { x1: o.x, y1: o.y, x2: o.x + BLOCK - 1, y2: o.y + BLOCK - 1 };
    // CommonCommands.as:375 mapInfoSimple(x1, y1, x2, y2); MapInfoSimpleResponse.as echoes the rectangle
    const ask = () => g.req('common.mapInfoSimple', data, ms);
    let r = null;
    try { r = typeof g.lane === 'function' ? await g.lane('common.mapInfoSimple', ask) : await ask(); } catch { r = null; }
    const fits = r && typeof r.mapStr === 'string' && r.mapStr.length && Number(r.x1) === o.x && Number(r.y1) === o.y;
    out.push(fits ? { x1: o.x, y1: o.y, x2: Number(r.x2 ?? data.x2), y2: Number(r.y2 ?? data.y2), mapStr: r.mapStr, castles: r.castles || [], at: Date.now() } : null);
  }
  const got = out.filter(Boolean);
  if (got.length) {
    const reads = ownReads(g);
    for (const e of got) reads.set(e.x1 + ',' + e.y1, e.at);
    try {
      const { Session } = require('./session');
      const mine = new Set((g.castles || []).map((c) => Number(c.fieldId)));
      const tiles = [];
      // `relation` is how a castle stands to THIS account: no place in the shared table
      for (const e of got) for (const { relation, ...t } of Session.prototype.mapBlockTiles.call(null, e, mine)) tiles.push({ ...t, seen: e.at });
      require('./db').mapCache.upsertMany(tiles.filter((t) => t.userName || t.npc || t.kind === 'flat'));
    } catch (e) { env.log('  the map cache was not written: ' + e.message); }
  }
  return out;
}

// ResetMap over a chunk's blocks, just before they are read again: what was
// known there is hidden until seen anew. -> the time of the reset (0: none).
function forget(env, chunk) {
  const xs = chunk.map((o) => o.x), ys = chunk.map((o) => o.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  const w = Math.max(...xs) + BLOCK - x, h = Math.max(...ys) + BLOCK - y;
  const Fm = F();
  const reset = typeof Fm.resetMap === 'function' ? Fm.resetMap : (ctx, ...args) => Fm.globals(ctx).ResetMap(...args);
  try { reset(env.ctx, x, y, w, h); } catch (e) { env.log('  the old readings were not forgotten: ' + e.message); return 0; }
  const reads = OWN_READS.get(env.game);
  if (reads) for (const o of chunk) reads.delete(keyOf(o));
  return Date.now();
}

// Read an area's blocks. fresh: every block again, after a ResetMap; else only
// the blocks not read in the last 30 minutes. -> { sum, dry }
async function readArea(env, area, { fresh = false } = {}) {
  const S = env.session;
  const session = viaSession(S);
  const all = areaBlocks(area);
  const known = new Set();
  if (!fresh) {
    const have = session ? safe(() => S.mapStore().blocks, new Map()) : ownReads(env.game);
    for (const o of all) if (have.has(keyOf(o))) known.add(keyOf(o));
  }
  const todo = all.filter((o) => !known.has(keyOf(o)));
  const sum = { area: area.label, blocks: all.length, read: 0, known: known.size, failed: 0, castles: 0, npcs: 0, stopped: false };
  printsAs(sum, `SCAN COMPLETED: ${area.label}`);
  if (env.dryRun) return { sum, dry: true, todo: todo.length };
  if (!todo.length) return { sum };
  if (session ? !S.connected : !(env.game && typeof env.game.req === 'function')) throw new Error(OFFLINE);

  const gap = Math.max(0, Number(env.opts.scanGapMs ?? 300));
  const per = session ? Number(S.constructor && S.constructor.MAP_BATCH) || 9 : 9;
  const failed = [];
  const big = todo.length > 5 * per;
  let batches = 0, done = 0, shown = 0, unread = 0;   // unread: forgotten, not yet read again
  outer:
  for (const chunk of chunked(todo)) {
    let since = 0;
    if (fresh) {
      if (env.stopped()) { sum.stopped = true; break; }
      since = forget(env, chunk);
      if (since) unread = chunk.length;
      await new Promise((r) => setTimeout(r, 2));    // a reading in the reset's own millisecond stays hidden
    }
    for (let i = 0; i < chunk.length; i += per) {
      if (batches++ && gap) await env.pause(gap);
      if (env.stopped()) { sum.stopped = true; break outer; }
      env.follow();
      const batch = chunk.slice(i, i + per);
      const got = session ? await sessionBatch(env, batch, fresh, since) : await reqBatch(env, batch);
      got.forEach((e, j) => {
        if (!e) { failed.push(batch[j]); return; }
        sum.read++;
        for (const c of e.castles || []) { if (c && c.npc) sum.npcs++; else if (c) sum.castles++; }
      });
      done += got.length;
      if (unread) unread -= got.length;
      if (got.length < batch.length) { sum.stopped = true; break outer; }
      if (big) {
        const pct = Math.floor((done * 4) / todo.length) * 25;
        if (pct > shown && pct < 100) { shown = pct; env.log(`  ${pct}% — ${done} of ${todo.length} blocks`); }
      }
    }
    unread = 0;
  }
  sum.failed = failed.length;
  return { sum, failed, unread: sum.stopped ? unread : 0 };
}

async function runScan(a, env) {
  let r;
  try { r = await readArea(env, a.area, { fresh: a.fresh }); } catch (e) {
    env.log('  ' + e.message);
    return { ok: false, error: e.message };
  }
  const { sum } = r;
  if (r.dry) {
    env.log(`  ${a.area.label}: would read ${r.todo} of ${sum.blocks} blocks of 20x20${sum.known ? ` (${sum.known} already read)` : ''}${a.fresh ? ', forgetting what is known there first' : ''}`);
    env.log('  [dry run] not sent');
    return {};
  }
  const tally = `${sum.blocks} block${sum.blocks === 1 ? '' : 's'}: ${sum.read} read${sum.known ? `, ${sum.known} already read` : ''}`
    + `${sum.failed ? `, ${sum.failed} did not answer` : ''} — ${sum.castles} castle${sum.castles === 1 ? '' : 's'}, ${sum.npcs} NPC${sum.npcs === 1 ? '' : 's'} in the blocks read`;
  const done = sum.read || sum.failed ? 1 : 0;
  if (sum.stopped) {
    env.log(`  stopped after ${sum.read + sum.failed} of ${sum.blocks - sum.known} blocks — ${tally}`);
    if (r.unread) env.log(`  ${r.unread} block${r.unread === 1 ? ' was' : 's were'} forgotten and not read again: what was known there stays hidden until a scan reads it`);
    return { ok: false, error: 'stopped', end: true, done, result: sum };
  }
  env.log(`  SCAN COMPLETED: ${sum.area}`);
  env.log(`  ${tally}`);
  if (sum.failed) {
    const which = r.failed.slice(0, 6).map(keyOf).join(' ') + (r.failed.length > 6 ? ' …' : '');
    const hidden = a.fresh ? '; what was known there stays hidden until a scan reads it' : '';
    env.log(`  no answer for the blocks at ${which}${hidden}`);
    return { ok: false, error: `${sum.failed} of ${sum.blocks} blocks did not answer — run it again for the rest`, done, result: sum };
  }
  return { ok: true, done, result: sum };
}

const scanCommand = (word, { rectOnly = false, fresh = false } = {}) => ({
  usage: rectOnly ? `${word} x1,y1 x2,y2` : `${word} x,y radius | ${word} x1,y1 x2,y2`,
  parse: (args) => ({ area: parseArea(word, args, rectOnly), fresh }),
  run: runScan,
});

// ------------------------------------------------------------------ findfield

const FIELD_WORDS = 'castle, npc, forest, desert, hill, swamp, grassland, lake or flat';
// 5.0990 miles -> "5.09", 7 -> "7": cut, not rounded (NEAT's findfield output).
const miles = (d) => String(Math.floor(d * 100 + 1e-9) / 100);

function describeField(t) {
  const lv = t.level === undefined || t.level === null ? '' : ` level ${t.level}`;
  if (t.type === 11) return `${t.name || 'castle'} — ${t.userName || '?'}${t.allianceName ? ` (${t.allianceName})` : ''}`;
  if (t.type === 12) return `NPC${lv}`;
  return `${(C.FIELD_TYPES[t.type] || {}).name || 'field'}${lv}`;
}

// Every known field of the type (and level) within the radius, the short way
// round the map, nearest first.
async function fieldsNear(env, home, a) {
  const Fm = F();
  const r = a.radius;
  const byId = new Map();
  const castles = a.type === 11 || a.type === 12;
  for (const [x1, x2] of worldRanges(home.x - r, home.x + r)) {
    for (const [y1, y2] of worldRanges(home.y - r, home.y + r)) {
      for (const t of await Fm.mapTiles(env.ctx, x1, y1, x2, y2, { castles })) byId.set(t.id, t);
    }
  }
  const out = [];
  for (const t of byId.values()) {
    if (t.type !== a.type || (a.level && Number(t.level) !== a.level)) continue;
    const d = C.mapDistance(home, t);
    if (d <= r + 1e-9) out.push({ t, d });
  }
  return out.sort((p, q) => p.d - q.d || p.t.id - q.t.id);
}

// The inputs of the city's march times: its skills (one cached server read,
// none in a dry run) and the buffs that speed marches up or slow them down.
async function marchInputs(env, castle) {
  const g = env.game;
  let p = { marchSkill: Number(g.marchSkillParam ?? 100) };
  const online = env.session ? !!env.session.connected : true;
  if (!env.dryRun && online && typeof g.troopParams === 'function') {
    try { p = await g.troopParams(g.castleId(castle)); } catch { /* the login's skill will do */ }
  }
  return { marchSkill: p.marchSkill, driveSkill: p.driveSkill, relief: 0, castleBuffs: castle.buffs,
    playerBuffs: g.player && g.player.buffs, now: typeof g.now === 'function' ? g.now() : Date.now() };
}

const FINDFIELD_USAGE = 'findfield <type> <level> <radius> [<hero> <troops>]   e.g. findfield npc 5 10 | findfield hill 10 20 any s:100000';

function parseFindField(args, { tok }) {
  const t = tok.slice(1);
  if (t.length === 4) throw new Error('findfield: the troops go after the hero — findfield hill 10 20 any s:100000');
  if (t.length !== 3 && t.length !== 5) throw new Error('findfield: usage  ' + FINDFIELD_USAGE);
  const type = F().fieldType(t[0]);
  if (type < 0) throw new Error(`findfield: "${t[0]}" is no field type — ${FIELD_WORDS}`);
  if (!/^\d+$/.test(t[1]) || Number(t[1]) > 15) throw new Error('findfield: the level is a number, 0 for any level — findfield npc 0 10');
  if (!/^\d+(\.\d+)?$/.test(t[2]) || !(Number(t[2]) > 0)) throw new Error('findfield: the radius is a number of miles — findfield npc 5 10');
  const out = { type, word: t[0].toLowerCase(), level: Number(t[1]), radius: Math.min(400, Number(t[2])) };
  if (t.length === 5) {
    let troops;
    try { troops = W.parseTroops(t[4]); } catch (e) { throw new Error(`findfield: ${e.message} — the troops are written as for attack (s:100000, a:5k,c:500)`); }
    Object.assign(out, { hero: t[3], troopText: t[4], troops });
  }
  return out;
}

async function runFindField(a, env) {
  const castle = env.castle;
  const home = C.fieldIdToCoords(Number(castle.fieldId));
  let done = 0;
  if (env.dryRun) env.log('  [dry run] the map is not read — this searches what is already known');
  else {
    let note = null;
    try {
      const r = await readArea(env, { cx: home.x, cy: home.y, r: a.radius, label: `${home.x},${home.y} radius ${a.radius}` });
      done = r.sum.read || r.sum.failed ? 1 : 0;
      if (r.sum.stopped) { env.log('  stopped while reading the map'); return { ok: false, error: 'stopped', end: true, done }; }
      if (r.sum.failed) note = `${r.sum.failed} of ${r.sum.blocks} blocks did not answer, so fields there may be missing`;
    } catch (e) { note = `${e.message} — searching what is already known`; }
    if (note) env.log('  ' + note);
  }
  const hits = await fieldsNear(env, home, a);
  env.log(`  Found ${hits.length} ${a.word} ${a.level ? `level ${a.level}` : 'of any level'} within a ${a.radius}-mile radius around ${home.x},${home.y}`);
  if (!a.hero) {
    for (const { t, d } of hits) env.log(`  ${t.x},${t.y}  ${describeField(t)}  (${miles(d)} miles)`);
    return { ok: true, done, result: hits.map(({ t }) => t.id) };
  }
  // NEAT's attack script, to paste into a script (or execute $result)
  const skills = await marchInputs(env, castle);
  const keys = Object.keys(a.troops).filter((k) => a.troops[k] > 0);
  const lines = [];
  let total = 0;
  for (const { t, d } of hits) {
    const ms = C.marchTimeMs(home, t, keys, skills);
    const sec = ms === null ? null : Math.floor(ms / 1000);
    if (sec !== null) total += sec;
    lines.push(`attack ${t.x},${t.y} ${a.hero} ${a.troopText} //Distance: ${miles(d)} Mission time: ${sec === null ? '?' : neatTime(sec)}`);
  }
  if (hits.length) {
    lines.push(`//Accumulated mission time: ${neatTime(total)}`);
    env.log('  Copy and paste this into the script window');
    env.log('');
    for (const l of lines) env.log('  ' + l);
  }
  return { ok: true, done, result: lines.join('\n') };
}

// ------------------------------------------------------------------ get

const MAX_GET = 2 * 1024 * 1024;
const FILE_NAME = /^[A-Za-z0-9 _./\\-]+\.[A-Za-z0-9]{1,5}$/;

// A web page, through script-net.js: public internet addresses only, checked
// on the URL, on every lookup (at connect time) and on every redirect.
async function fetchPage(url, env) {
  const r = await NET().safeFetch(url, {
    timeoutMs: Number(env.opts.getTimeoutMs ?? 15000), maxBytes: MAX_GET, redirects: 3,
    headers: { accept: 'text/xml, text/plain, */*' }, lookup: env.opts.dnsLookup || undefined,
  });
  const host = safe(() => new URL(r.url).host, url);
  if (r.status >= 300 && r.status < 400) throw new Error(`${host} sent it on too many times${r.headers.location ? ` (to ${r.headers.location})` : ''}`);
  if (r.status !== 200) throw new Error(`${host} answered ${r.status}${r.status === 404 ? ' (no such page — a battle log may have expired)' : ''}`);
  return r.text;
}
let urlFetcher = null;   // tests put a fake here (setUrlFetcher)

// A file in the console's scripts folder: script-console.js's rules, shared
// with `call`. null when there is none.
function readConsoleFile(name) {
  const SC = require('./script-console');
  return { text: SC.readScriptFile(name), dir: SC.SCRIPTS_DIR };
}

function parseGet(args) {
  const s = String(args || '').trim();
  if (!s) throw new Error('get: usage  get "<http(s) address>" | get "<file in the scripts folder>" | get <variable>');
  if (/^https?:$/i.test(s)) throw new Error('get: put the address in quotes — get "http://…" (// starts a comment)');
  try { E.parseExpression(s); } catch (e) {
    if (FILE_NAME.test(s)) return { name: s };
    throw new Error(`get: ${e.message} — write  get "<address or file name>"`);
  }
  return { expr: s };
}

async function runGet(a, env) {
  // what to get: the name as written, or the expression's value now
  let target = a.name;
  if (target === undefined) {
    let v;
    try {
      const ev = typeof env.evaluate === 'function' ? env.evaluate : env.ctx.evaluate;
      v = await ev(a.expr);
    } catch (e) {
      if (!FILE_NAME.test(a.expr)) throw e;
    }
    target = v === undefined || v === null ? (FILE_NAME.test(a.expr) ? a.expr : '') : E.toStr(v);
  }
  target = String(target).trim();
  const fail = (why) => { env.log('  ' + why); return { ok: false, error: why, result: '' }; };
  if (!target) return fail(`get: ${a.expr} is empty — say which address or file`);

  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) {
    try { NET().checkUrl(target); } catch (e) { return fail(e.message); }
    env.log(`  ${target}`);
    if (env.dryRun) { env.log('  [dry run] not fetched'); return { result: '' }; }
    let text;
    try { text = await (urlFetcher || fetchPage)(target, env); } catch (e) { return fail(e.message); }
    text = String(text);
    env.log(`  -> ${text.length.toLocaleString('en-US')} characters`);
    return { ok: true, result: text };
  }

  let file;
  try { file = readConsoleFile(target); } catch (e) { return fail(e.message); }
  let text = file.text;
  let from = target;
  if (text === null || text === undefined) {
    // NEAT's NewCityGoals.txt, PrependGoals.txt, AppendGoals.txt: the account's goal texts
    const goals = safe(() => require('./script-cmd-goals'));
    const t = goals && typeof goals.goalFile === 'function' ? safe(() => goals.goalFile(target, env)) : null;
    if (t === null || t === undefined) return fail(`no file ${target} in ${file.dir}`);
    text = t;
    from = `${target} (the account's goals)`;
  }
  text = String(text).replace(/^﻿/, '');
  const n = text ? text.split(/\r?\n/).length : 0;
  env.log(`  -> ${from}: ${n} line${n === 1 ? '' : 's'}`);
  return { ok: true, result: text };
}

// ------------------------------------------------------------------ commands

const commands = {
  listbuffs: {
    usage: 'listbuffs',
    parse: nothingAfter('listbuffs'),
    async run(a, env) {
      const rows = buffRows(env);
      if (!rows.length) env.log('  BUFFS: none');
      for (const r of rows) env.log(`  BUFFS: ${r}`);
      return { ok: true, result: rows };
    },
  },
  listitems: itemList('listitems', 'Items', false),
  listmedals: itemList('listmedals', 'Medals', true),
  listcommands: {
    usage: 'listcommands [word]',
    parse(args) {
      const w = String(args || '').trim().toLowerCase();
      if (/\s/.test(w)) throw new Error('listcommands: one word at most — listcommands attack');
      return { filter: w || null };
    },
    run: runListCommands,
  },

  scanmap: scanCommand('scanmap'),
  rescanmap: scanCommand('rescanmap', { fresh: true }),
  scanrec: scanCommand('scanrec', { rectOnly: true }),
  rescanrec: scanCommand('rescanrec', { rectOnly: true, fresh: true }),
  findfield: { usage: 'findfield <type> <level> <radius> [<hero> <troops>]', parse: parseFindField, run: runFindField },

  get: { usage: 'get "<http(s) address>" | get "<file>" | get <variable>', parse: parseGet, run: runGet },

  find: {
    usage: 'find <player name>',
    parse(args, { tok }) {
      if (!tok[1]) throw new Error('find: usage  find <player name>');
      return { cmd: 'find', query: tok.slice(1).join(' ') };
    },
    async run(a, env) {
      const D = require('./db');
      const total = D.mapCache.count();
      if (!total) { const why = 'no map cache yet — scan the map first:  scanmap <x,y> <radius>'; env.log('  ' + why); return { ok: false, error: why }; }
      const hits = D.mapCache.search(a.query, 500);
      env.log(`  cache holds ${total.toLocaleString('en-US')} castles (${Math.round((Date.now() - D.mapCache.updatedAt()) / 60000)} min old)`);
      if (!hits.length) { env.log('  no match'); return { result: [] }; }
      const rows = [];
      for (const h of hits.slice(0, 20)) {
        const xy = C.fieldIdToCoords(Number(h.id));
        env.log(`  ${String(h.userName).padEnd(16)} ${String(h.name || '').padEnd(18)} ${xy.x},${xy.y}  ${h.allianceName || '-'}  pres ${Number(h.prestige || 0).toLocaleString('en-US')}`);
        rows.push({ userName: h.userName, name: h.name || '', x: xy.x, y: xy.y, coords: `${xy.x},${xy.y}`,
          allianceName: h.allianceName || '', prestige: Number(h.prestige || 0) });
      }
      return { result: rows };
    },
  },
};

module.exports = {
  commands,
  // for tests
  neatTime, expiresIn, areaBlocks, parseArea,
  setUrlFetcher(fn) { urlFetcher = typeof fn === 'function' ? fn : null; },
};
