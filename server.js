'use strict';
// Local UI server for the Evony offline-account scanner. No dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { EvonyClient, getServerConfig } = require('./evony');

const { Session } = require('./session');
const D = require('./db');
const AUTH = require('./auth');
AUTH.configure();

// One console per account: a second login for the same account gets kicked, so
// running a second account means a second process on another port.
const PORT = Number(process.env.CONSOLE_PORT || 8711);

const SESSION = new Session();
// Set only when the account was chosen explicitly, not inferred from .env.
const PINNED = process.env.ACCOUNT_ID || null;

// ONE CONSOLE PER ACCOUNT. Two logins for the same account make the server kick
// one of them, and the two supervisors then fight and trip the rate limiter.
// Ask every other configured console who it holds before starting; if one of
// them already owns this account, refuse rather than start the fight.
(async () => {
  const mine = SESSION.account && SESSION.account.id;
  if (!mine) return;
  const probes = (SESSION.org ? SESSION.org.settings : D.settings)
    .get('probes', [{ probe: 'console', url: 'http://localhost:8711' }]);
  for (const pr of probes) {
    const url = String(pr.url || '').replace(/\/$/, '');
    if (!url || url.endsWith(':' + PORT)) continue;            // that is us
    const held = await new Promise((resolve) => {
      const req = http.get(url + '/api/session', { timeout: 1500 }, (res) => {
        let b = ''; res.on('data', (c) => (b += c));
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
    if (held && held.account && held.account.id === mine) {
      console.error(`
  REFUSING TO START: ${url} is already running account `
        + `${mine} (${SESSION.account.label}).
  One console per account — `
        + `start this one with a different ACCOUNT_ID, or stop that one first.
`);
      process.exit(1);
    }
  }
})();

console.log(`  account: ${SESSION.account ? SESSION.account.id + ' ' + SESSION.account.label : '(from .env)'}`
  + `   port: ${PORT}   engine: live`);

SESSION.startSupervisor();     // heartbeat + auto-reconnect for the console session
SESSION.startEngine();         // ticks the goal engine, live, unless paused from the console

function loadEnv() {
  const out = {};
  const p = path.join(__dirname, '.env');
  if (fs.existsSync(p)) for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2];
  }
  return out;
}

const LOADOUTS = 10;     // script loadout slots per city

// Scripts running now, by city: { stop, startedAt, lines, dropped }. Stop sets
// `stop`, which the run polls between lines — the only way an endless `repeat`
// ends while its line keeps going through.
const SCRIPT_RUNS = new Map();
const SCRIPT_KEEP = 2000;          // lines a run keeps; older ones are dropped

// A script's parse errors, once each: loop/repeat expansion copies a bad line.
function scriptErrors(actions) {
  const seen = new Map();
  for (const a of actions) if (a.cmd === 'error') seen.set(`${a.line}:${a.error}`, { line: a.line, error: a.error });
  return [...seen.values()];
}

// NEAT's !NewCityScript.txt: the account's new-city script (goallayers.js) runs
// once in a city the moment it appears (session.js cityAdded). It is an
// ordinary run of that city's, as /api/script starts one: it shows in
// /api/script/runs, Stop ends it, it never doubles a run already going there,
// and a script with errors runs whole or not at all.
SESSION.runNewCityScript = async (castleId, src, log) => {
  const { parse, run } = require('./script');
  const actions = parse(src || '');
  const errors = scriptErrors(actions);
  if (errors.length) return { ok: false, errors };
  const key = String(castleId);
  if (SCRIPT_RUNS.has(key)) return { ok: false, error: 'a script is already running in that city' };
  const running = { stop: false, startedAt: Date.now(), lines: [], dropped: 0 };
  SCRIPT_RUNS.set(key, running);
  try {
    const game = await SESSION.connect();
    const n = await run(game, actions, (m) => {
      running.lines.push(m);
      if (running.lines.length > SCRIPT_KEEP) { running.lines.shift(); running.dropped++; }
      log(m);
    }, {
      castle: castleId, session: SESSION, shouldStop: () => running.stop,
      otherScripts: () => [...SCRIPT_RUNS].filter(([, r]) => r !== running && !r.atLogout).map(([city]) => city),
      atLogout: (on) => { running.atLogout = !!on; },
    });
    return { ok: true, actions: n, stopped: running.stop };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    SCRIPT_RUNS.delete(key);
  }
};

function body(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

async function runScan({ names }, log) {
  // shares the console's session — a second login would kick it
  const g = await SESSION.connect();
  const c = g.c;
  log(`scanning as ${g.player.playerInfo.userName}`);

  const now = Date.now();
  const rows = [];

  for (const name of names) {
    c.send('common.getPlayerInfoByName', { userName: name });
    let info = null;
    try {
      const r = await c.await(['common.getPlayerInfoByName'], 8000);
      if (r.data && r.data.ok === 1) info = r.data.playerInfo;
      else log(`  ${name}: not found (ok=${r.data && r.data.ok})`);
    } catch (e) { log(`  ${name}: ${e.message}`); }

    if (info) {
      const was = ORG.players.latest(name);
      const delta = was ? info.prestige - was.prestige : null;
      const mins = was ? Math.round((now - was.at) / 60000) : null;
      rows.push({
        name: info.userName, alliance: info.alliance, prestige: info.prestige,
        castles: info.castleCount, rank: info.ranking, population: info.population,
        office: info.office, delta, sinceMin: mins,
        stalled: was ? delta === 0 : null,
      });
      ORG.players.record(name, info.prestige, now);
      log(`  ${name}: pres ${info.prestige}` + (delta === null ? ' (first sighting)' : delta === 0 ? `  NOT MOVING for ${mins}m` : `  +${delta}`));
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  return rows;   // shared session stays open
}

const rawBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b));
});

const server = http.createServer(async (req, res) => {
  // Login gate first: everything below controls live accounts.
  if (await AUTH.guard(req, res, { readBody: rawBody })) return;

  // Signed in is not enough — this console belongs to ONE organization, and a
  // user from another has no business seeing its bots or its stored password.
  if (SESSION.orgId && req.org && req.org.id !== SESSION.orgId) {
    res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: false, error: 'This console belongs to another organization.' }));
  }
  const ORG = SESSION.org;

  const send = (code, type, data) => { res.writeHead(code, {
    // never let a browser hold on to a stale page or a stale account list
    'Cache-Control': 'no-store, must-revalidate', 'Content-Type': type.includes('charset') ? type : type + '; charset=utf-8' }); res.end(data); };

  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;

  // NOTE: match on pathname, not req.url — "/?account=a1" is not "/"
  if (url.pathname === '/' || url.pathname === '/app' || url.pathname === '/app.html') {
    return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'public', 'app.html')));
  }
  if (url.pathname === '/scanner' || url.pathname === '/index.html') {
    return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  }
  // The web battle log rebuilt without Flash, and the report view it shares
  // with the console's Reports window.
  if (url.pathname === '/report' || url.pathname === '/report.html') {
    return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'public', 'report.html')));
  }
  if (url.pathname === '/reportview.js' || url.pathname === '/reportview.css') {
    const js = url.pathname.endsWith('.js');
    return send(200, js ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
      fs.readFileSync(path.join(__dirname, 'public', js ? 'reportview.js' : 'reportview.css')));
  }

  // ---- shared session endpoints ----
  if (url.pathname === '/api/session') {
    return send(200, 'application/json', JSON.stringify({ ...SESSION.header(), cities: SESSION.cities() }));
  }
  // Focus an account by id from the Director's shared accounts.json
  if (url.pathname === '/api/switch' && req.method === 'POST') {
    const b = await body(req);
    // A console started with an explicit ACCOUNT_ID is PINNED to that account.
    // A stale browser tab at /?account=<other> used to switch it on every load,
    // which silently moved a console onto an account another console already
    // held — two logins, a kick, and a throttled account. The URL does not get
    // to override the process.
    if (PINNED && b.accountId !== PINNED) {
      return send(200, 'application/json', JSON.stringify({
        ok: false,
        pinned: PINNED,
        error: `this console is pinned to ${SESSION.account.label} (${PINNED}). `
             + `Open the console that runs ${b.accountId} instead of switching this one.`,
      }));
    }
    const acc = ORG.accounts.get(b.accountId);
    if (!acc) return send(200, 'application/json', JSON.stringify({ ok: false, error: 'unknown account ' + b.accountId }));
    try { const h = await SESSION.switchTo(acc); return send(200, 'application/json', JSON.stringify({ ok: true, ...h })); }
    catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }

  if (url.pathname === '/api/connect' && req.method === 'POST') {
    // Connect is also how a script's logout is ended early (logout.js).
    if (SESSION.maint.plan && SESSION.maint.plan.source === 'logout') SESSION.clearMaintenancePlan();
    try { await SESSION.connect(); } catch (e) { /* reported via header */ }
    return send(200, 'application/json', JSON.stringify(SESSION.header()));
  }
  // What our own armies are doing right now — the direct answer to "is it
  // actually farming", which the logs only imply.
  // Diagnostic: the raw shapes the server actually sends, so UI work is built
  // against reality rather than against the bean definitions, which list only a
  // subset of what arrives at runtime. Internal token only.
  if (url.pathname === '/api/debug/city' && AUTH.isInternal(req)) {
    try {
      const g = await SESSION.connect();
      const c = q.get('id') ? g.castles.find((x) => String(g.castleId(x)) === q.get('id')) : g.castle();
      if (!c) return send(200, 'application/json', JSON.stringify({ error: 'no such city' }));
      const shape = (v, depth = 0) => {
        if (v === null || v === undefined) return typeof v;
        if (Array.isArray(v)) return `array[${v.length}]` + (v.length && depth < 2 ? ' of ' + JSON.stringify(shape(v[0], depth + 1)) : '');
        if (typeof v === 'object') {
          if (depth >= 2) return 'object{' + Object.keys(v).slice(0, 12).join(',') + '}';
          return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, shape(x, depth + 1)]));
        }
        return typeof v === 'string' ? `"${String(v).slice(0, 24)}"` : String(v);
      };
      // One hero in full, when asked for by name — the shape summary truncates.
      const heroName = q.get('hero');
      if (heroName) {
        const h = (c.heros || []).find((x) => String(x.name || '').toLowerCase() === heroName.toLowerCase());
        return send(200, 'application/json', JSON.stringify({ hero: h || null }, null, 1));
      }
      return send(200, 'application/json', JSON.stringify({
        castleKeys: Object.keys(c),
        castle: shape(c),
        playerKeys: Object.keys(g.player || {}),
        player: shape(g.player || {}),
      }, null, 1));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ error: e.message })); }
  }

  // Manual valley actions from the Valleys tab.
  //
  // `field.giveUpField {fieldId}` releases a valley — irreversible, so it is
  // only ever accepted for a field this city actually holds, never for an
  // arbitrary id the caller sends. Founding a city is the same check.
  if (url.pathname === '/api/valley' && req.method === 'POST') {
    const b = await body(req);
    try {
      const g = await SESSION.connect();
      const fieldId = Number(b.fieldId);
      if (!Number.isFinite(fieldId)) throw new Error('no field id');

      const owner = (g.castles || []).find((c) => (c.fields || []).some((f) => Number(f.id) === fieldId));
      if (!owner) throw new Error('that field is not one of yours');
      const field = (owner.fields || []).find((f) => Number(f.id) === fieldId);

      if (b.action === 'abandon') {
        const r = await g.req('field.giveUpField', { fieldId });
        SESSION.note(`valley ${fieldId} abandoned -> ok=${r && r.ok}`, { city: owner.name, kind: 'act' });
        return send(200, 'application/json', JSON.stringify({ ok: r && r.ok === 1, error: r && r.errorMsg }));
      }

      if (b.action === 'build') {
        const C2 = require('./constants');
        const t = C2.FIELD_TYPES[Number(field.type)] || {};
        if (!t.buildable) throw new Error(`a ${t.name || 'field'} cannot be built on — only flats can`);
        const r = await g.req('city.constructCastle', {
          castleId: g.castleId(owner), fieldId, isTroopBack: true,
        });
        SESSION.note(`constructCastle on ${fieldId} -> ok=${r && r.ok}`, { city: owner.name, kind: 'act' });
        return send(200, 'application/json', JSON.stringify({ ok: r && r.ok === 1, error: r && r.errorMsg }));
      }

      throw new Error('action must be "abandon" or "build"');
    } catch (e) {
      return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (url.pathname === '/api/marches') {
    const { incomingArmies } = require('./snapshot');
    const out = SESSION.marches();
    let inc = [];
    try { inc = SESSION.connected ? incomingArmies(SESSION.game) : []; } catch (e) { /* reported as empty */ }
    return send(200, 'application/json', JSON.stringify({
      now: Date.now(), serverNow: SESSION.game ? SESSION.game.now() : Date.now(),
      outgoing: out, incoming: inc,
      count: out.length, incomingCount: inc.length,
      marches: out,                       // kept for anything already reading it
    }));
  }
  // The server's item catalogue, cached once per install. Gives real names for
  // the ids we hold, which is what makes "useheroitem OTTO excalibur" possible.
  if (url.pathname === '/api/itemdefs') {
    const cached = D.settings.get('itemDefs', null);
    if (cached && !q.get('refresh')) return send(200, 'application/json', JSON.stringify(cached));
    try {
      const g = await SESSION.connect();
      const raw = await g.itemDefs();
      D.settings.set('itemDefs', raw);
      return send(200, 'application/json', JSON.stringify(raw));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ error: e.message })); }
  }
  // The Items tab: everything the account holds, named (items.js). Read from the
  // session's own copy, which server.ItemUpdate keeps current — the tab polls,
  // so this never connects or asks the server anything.
  if (url.pathname === '/api/items') {
    const g = SESSION.game;
    if (!g || !g.player) return send(200, 'application/json', JSON.stringify({ ok: false, error: 'not connected' }));
    return send(200, 'application/json', JSON.stringify({ ok: true, ...require('./items').inventory(g) }));
  }
  if (url.pathname === '/api/city') {
    return send(200, 'application/json', JSON.stringify(SESSION.city(q.get('id')) || {}));
  }
  // kind: activity (what the bot did) | engine (its thinking) | reports |
  // debug (everything, the protocol trace included). 'log' is the old name for debug.
  if (url.pathname === '/api/log') {
    const kind = q.get('kind') || 'activity';
    return send(200, 'application/json', JSON.stringify(
      SESSION.logView(kind, { city: q.get('city') || null, q: q.get('q') || '' })));
  }

  if (url.pathname === '/api/log/clear' && req.method === 'POST') {
    const b = await body(req);
    const removed = SESSION.clearLog(b.kind || 'debug', b.city || null);
    return send(200, 'application/json', JSON.stringify({ ok: true, removed }));
  }

  // ---- the console's per-city controls -----------------------------------
  // Gate Control: auto | open | closed. Open/closed go to the server at once.
  if (url.pathname === '/api/gate' && req.method === 'POST') {
    const b = await body(req);
    try { return send(200, 'application/json', JSON.stringify(await SESSION.setGate(b.city, String(b.mode || '')))); }
    catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }
  // War Town Mode: auto | 0 | 1 | 2 — overrides `config wartown:` for the city.
  if (url.pathname === '/api/wartown' && req.method === 'POST') {
    const b = await body(req);
    try { return send(200, 'application/json', JSON.stringify(SESSION.setWarTown(b.city, b.mode))); }
    catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }
  // The pause button: the engine stops acting; its mode is left alone.
  if (url.pathname === '/api/pause' && req.method === 'POST') {
    const b = await body(req);
    SESSION.userPaused = !!b.paused;
    SESSION.note(SESSION.userPaused ? 'PAUSED from the console — the engine will not act until resumed' : 'resumed from the console');
    return send(200, 'application/json', JSON.stringify({ ok: true, paused: SESSION.userPaused }));
  }
  // Per-city data that costs a request: queues | research | reinf | prod.
  if (url.pathname === '/api/cityx') {
    try {
      const data = await SESSION.cityExtra(q.get('id'), q.get('kind'), q.get('fresh') === '1');
      return send(200, 'application/json', JSON.stringify(data));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ error: e.message })); }
  }
  if (url.pathname === '/api/engine/report') {
    return send(200, 'application/json', JSON.stringify({
      paused: SESSION.userPaused, lastTickAt: SESSION.lastTickAt || null,
      report: SESSION.engineReport(q.get('city')),
    }));
  }

  // Cancel one of our own market offers. Only an offer this city actually has
  // is accepted, never an arbitrary id.
  if (url.pathname === '/api/trade/cancel' && req.method === 'POST') {
    const b = await body(req);
    try {
      const g = SESSION.game;
      if (!SESSION.connected || !g) throw new Error('not connected');
      const castle = g.castles.find((c) => g.castleId(c) === Number(b.city));
      if (!castle) throw new Error('no such city');
      const t = (castle.trades || []).find((x) => Number(x.id) === Number(b.tradeId));
      if (!t) throw new Error('that offer is not one of this city\'s');
      const r = await g.cancelTrade(g.castleId(castle), t.id);
      SESSION.note(`cancelled ${Number(t.tradeType) === 0 ? 'buy' : 'sell'} offer: ${t.resourceName || 'resource'} `
        + `${Number(t.amount).toLocaleString('en-US')} @ ${t.price} -> ${r && r.ok === 1 ? 'ok' : (r && r.errorMsg) || 'refused'}`,
      { city: castle.name, kind: 'act' });
      return send(200, 'application/json', JSON.stringify({ ok: !!(r && r.ok === 1), error: r && r.errorMsg }));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }

  // Cancel one batch in a barrack or the Walls queue: the ✖ on the Barracks and
  // Fortifications panels. {city, kind: troop|wall, positionId, queueId}. Only a
  // batch the city's queue holds right now is sent (queue-cancel.js).
  if (url.pathname === '/api/queue/cancel' && req.method === 'POST') {
    const b = await body(req);
    try {
      const g = SESSION.game;
      if (!SESSION.connected || !g) throw new Error('not connected');
      const castle = g.castles.find((c) => g.castleId(c) === Number(b.city));
      if (!castle) throw new Error('no such city');
      const r = await require('./queue-cancel').cancelOne(g, castle, String(b.kind || ''),
        { positionId: b.positionId, queueId: b.queueId }, { session: SESSION });
      SESSION.note(r.text, { city: castle.name, kind: 'act' });
      return send(200, 'application/json', JSON.stringify({ ok: r.ok, error: r.error }));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }

  // Recall one of our own marches. army.callBackArmy {castleId, armyId}
  // (ArmyCommands.as:118) — the castle is the one the army left from.
  if (url.pathname === '/api/army/recall' && req.method === 'POST') {
    const b = await body(req);
    try {
      const g = SESSION.game;
      if (!SESSION.connected || !g) throw new Error('not connected');
      const a = ((g.player && g.player.selfArmys) || []).find((x) => String(x.armyId) === String(b.armyId));
      if (!a) throw new Error('no such army of yours');
      const castle = g.castles.find((c) => Number(c.fieldId) === Number(a.startFieldId));
      if (!castle) throw new Error('cannot tell which city that army belongs to');
      const r = await g.req('army.callBackArmy', { castleId: g.castleId(castle), armyId: a.armyId });
      SESSION.note(`recalled army ${a.armyId} (${a.targetPosName || 'target'}) -> ${r && r.ok === 1 ? 'ok' : (r && r.errorMsg) || 'refused'}`,
        { city: castle.name, kind: 'act' });
      return send(200, 'application/json', JSON.stringify({ ok: !!(r && r.ok === 1), error: r && r.errorMsg }));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }
  if (url.pathname === '/api/chat' && req.method === 'GET') {
    const ch = q.get('channel') || 'alliance';
    return send(200, 'application/json', JSON.stringify({ lines: (SESSION.chat[ch] || []).slice(-200) }));
  }
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    const b = await body(req);
    try { await SESSION.sendChat(b.channel, b.msg, b.target); return send(200, 'application/json', '{"ok":true}'); }
    catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }
  // ---- mail & reports: the windows behind the header's Mail / Reports boxes ----
  //   GET  /api/mail?box=inbox|system|sent&page=1     GET /api/mail/read?id=
  //   POST /api/mail/delete {ids}   /api/mail/markread {ids}   /api/mail/send {to, title, body}
  //   GET  /api/reports?type=army|trade|other&page=1   GET /api/reports/read?id=
  //   POST /api/reports/delete {ids}   /api/reports/markread {ids}
  // Each one is the user opening the window or acting in it — nothing polls.
  // Not connected, or refused by the server: {ok:false, error}. See session.js.
  if (url.pathname === '/api/mail' || url.pathname.startsWith('/api/mail/')
      || url.pathname === '/api/reports' || url.pathname.startsWith('/api/reports/')) {
    const reply = (v) => send(200, 'application/json', JSON.stringify(v));
    const b = req.method === 'POST' ? await body(req) : {};
    try {
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /api/mail': return reply(await SESSION.mailList(q.get('box') || 'inbox', q.get('page')));
        case 'GET /api/mail/read': return reply(await SESSION.mailRead(q.get('id')));
        case 'POST /api/mail/delete': return reply(await SESSION.mailDelete(b.ids));
        case 'POST /api/mail/markread': return reply(await SESSION.mailMarkRead(b.ids));
        case 'POST /api/mail/send': return reply(await SESSION.mailSend(b.to, b.title, b.body));
        case 'GET /api/reports': return reply(await SESSION.reportPage(q.get('type') || 'army', q.get('page')));
        case 'GET /api/reports/read': return reply(await SESSION.reportRead(q.get('id')));
        case 'POST /api/reports/delete': return reply(await SESSION.reportDelete(b.ids));
        case 'POST /api/reports/markread': return reply(await SESSION.reportMarkRead(b.ids));
        // the web battle log, fetched from the game's report host: ?u=<link>&from=&to=
        case 'GET /api/reports/log': return reply(await SESSION.reportLog(q.get('u'), { from: q.get('from'), to: q.get('to') }));
        default: break;
      }
    } catch (e) { return reply({ ok: false, error: e.message }); }
  }
  // Manual override: keep working even while the server reports maintenance.
  if (url.pathname === '/api/maintenance' && req.method === 'POST') {
    const b = await body(req);
    if (b.check) SESSION.maint.checkedAt = 0;          // force a re-read now
    // Start the stand-down protocol for a window you know about but we did not
    // see announced: pause 5 min before it, sit out the window, then retry on a
    // 5-minute ladder.
    if (b.plan !== undefined) {
      if (b.plan === null || b.plan === false) SESSION.clearMaintenancePlan();
      else SESSION.planMaintenance(Number(b.inMin) || 15, Number(b.windowMin) || 15);
    }
    const m = b.override === undefined ? SESSION.maint : SESSION.setMaintenanceOverride(b.override);
    return send(200, 'application/json', JSON.stringify({ ok: true, maintenance: { ...m, paused: SESSION.paused } }));
  }
  // A city's Goals window shows that city's own goals, exactly what the engine
  // runs there (db.goals.own) — never another city's or the default's.
  if (url.pathname === '/api/editor') {
    const city = q.get('city') || 'default';
    const kind = q.get('kind') === 'script' ? 'script' : 'goal';
    const acct = SESSION.account && SESSION.account.id;
    const g = SESSION.game;
    const castle = g && (g.castles || []).find((c) => String(g.castleId(c)) === city);
    const entry = kind === 'goal' && city !== 'default'
      ? ORG.goals.own(acct, city, castle && castle.name, kind)
      : ORG.goals.find(acct, [city], kind);
    return send(200, 'application/json', JSON.stringify({ src: (entry && entry.src) || '' }));
  }
  // ---- manual hero operations (inn + feasting hall) ----
  if (url.pathname === '/api/inn') {
    try {
      const g = await SESSION.connect();
      const cid = Number(q.get('city')) || g.castleId(g.castle());
      const d = await g.tavernList(cid);
      const { Game } = require('./game');
      const base = (h, k) => Number(h[k] || 0) - Number(h[k + 'Added'] || 0);
      return send(200, 'application/json', JSON.stringify({
        heroes: (d.heros || []).map((h) => ({
          name: h.name, level: h.level, base: Game.heroBase(h),
          attack: Game.attrValue(h, 'power'), politics: Game.attrValue(h, 'management'), intel: Game.attrValue(h, 'stratagem'),
          baseAttack: base(h, 'power'), basePolitics: base(h, 'management'), baseIntel: base(h, 'stratagem'),
        })),
      }));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ error: e.message })); }
  }

  if (url.pathname === '/api/hero' && req.method === 'POST') {
    const b = await body(req);
    try {
      const g = await SESSION.connect();
      const castle = b.city ? g.castles.find((c) => g.castleId(c) === Number(b.city)) || g.castle() : g.castle();
      const cid = g.castleId(castle);
      const hero = b.heroName ? g.findHero(castle, b.heroName) : null;
      let r;

      // Holy Water, as the waterhero script line (water-hero.js), its lines sent
      // back for the page to show. The preview only checks: it sends nothing.
      if (b.action === 'water' || b.action === 'waterpreview') {
        if (!hero) throw new Error('hero not found in this city');
        const WH = require('./water-hero');
        const a = { hero: String(hero.id), rule: b.heropoints ? WH.parseRule(b.heropoints) : null };
        if (b.action === 'waterpreview') {
          const p = WH.prepare(g, a);
          return send(200, 'application/json', JSON.stringify({ ok: p.ok, need: p.need, held: p.held, lines: p.lines.map((l) => l.trim()) }));
        }
        const lines = [];
        const went = await WH.run(g, a, { log: (m) => lines.push(m.trim()) });
        for (const l of lines) SESSION.note(`manual: waterhero ${hero.name}: ${l}`, { city: castle.name, kind: 'act' });
        return send(200, 'application/json', JSON.stringify({ ok: went, lines }));
      }

      // What the next inn refresh would spend; the page asks before paying coins.
      if (b.action === 'refreshinnpreview') {
        const cost = g.innRefreshCost();
        return send(200, 'application/json', JSON.stringify({ ok: true, held: cost.held, text: cost.text }));
      }

      // Release only a prisoner we hold, never Fire or promote one, promote only
      // an idle hero (Game.heroActionRefusal, which the script asks too).
      if (['mayor', 'fire', 'release'].includes(b.action)) {
        const no = require('./game').Game.heroActionRefusal(b.action, hero);
        if (no) throw new Error(no);
      }

      if (b.action === 'mayor') {
        // Straight over the sitting mayor, as the client does (CastleChief.as:377-394):
        // discharging first left the city with no mayor whenever the promotion failed.
        r = await g.promoteToChief(cid, hero.id);
      } else if (b.action === 'unmayor') {
        r = await g.dischargeChief(cid);
      } else if (b.action === 'fire') {
        r = await g.fireHero(cid, hero.id);
      } else if (b.action === 'release') {
        r = await g.releaseHero(cid, hero.id);
      } else if (b.action === 'addpoint') {
        if (!hero) throw new Error('hero not found in this city');
        const alloc = { management: 0, power: 0, stratagem: 0 };
        const key = { attack: 'power', politics: 'management', intel: 'stratagem' }[b.attr] || b.attr;
        if (!(key in alloc)) throw new Error('attribute must be attack, politics or intel');
        alloc[key] = Number(b.amount) || 1;
        r = await g.addPoint(cid, hero, alloc);   // increments; game.js converts to totals
      } else if (b.action === 'levelup') {
        if (!hero) throw new Error('hero not found in this city');
        r = await g.levelUpHero(cid, hero.id);
      } else if (b.action === 'recall') {
        // hero.callBackHero {castleId, heroId}: the Feasting Hall's recall, which
        // it offers for a hero out marching (3) or defending a valley (2).
        if (!hero) throw new Error('hero not found in this city');
        if (![2, 3].includes(Number(hero.status))) throw new Error(`${hero.name} is not out marching or defending`);
        r = await g.callBackHero(cid, hero.id);
      } else if (b.action === 'hire') {
        r = await g.hireHero(cid, b.heroName);
      } else if (b.action === 'refreshinn') {
        // Coins only when the page has asked (it sends force after its ask()).
        const cost = g.innRefreshCost();
        if (!cost.item && !b.force) throw new Error(`not refreshed: ${cost.text}`);
        r = await g.refreshTavern(cid);
      } else {
        throw new Error('unknown action ' + b.action);
      }

      SESSION.note(`manual: ${b.action}${b.heroName ? ' ' + b.heroName : ''} -> ${r && r.ok === 1 ? 'ok' : (r && r.errorMsg) || 'ok=' + (r && r.ok)}`,
        { city: castle.name, kind: 'act' });
      return send(200, 'application/json', JSON.stringify({ ok: r && r.ok === 1, result: r }));
    } catch (e) {
      return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (url.pathname === '/api/map') {
    try {
      const r = Math.max(1, Math.min(40, Number(q.get('r')) || 10));
      // NOTE: Number(null) is 0, so test the raw params before converting
      const rawX = q.get('x'), rawY = q.get('y');
      let cx = Number(rawX), cy = Number(rawY);
      if (rawX === null || rawY === null || rawX === '' || rawY === '' || Number.isNaN(cx) || Number.isNaN(cy)) {
        const g = await SESSION.connect();
        const c = q.get('city') ? g.castles.find((x) => g.castleId(x) === Number(q.get('city'))) : g.castle();
        const xy = g.castleXY(c) || { x: 400, y: 400 };
        cx = xy.x; cy = xy.y;
      }
      // Served from the session's block cache while fresh; fresh=1 re-reads it.
      const out = await SESSION.scanArea(cx, cy, r, { fresh: q.get('fresh') === '1' });
      return send(200, 'application/json', JSON.stringify(out));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ error: e.message })); }
  }

  // The panning map: ?blocks=440,280;460,280[&fresh=1] names up to 9 20x20
  // blocks by any point inside them (wrapped into the world, aligned to 20).
  // Cached blocks come straight back; the rest are asked for only over a live
  // socket — this never logs in. Returns {blocks, missing, skipped, offline,
  // fetched, cached, ttlMs, tiles, diplo} — diplo is the alliance's standing
  // with others, for the map's colours (Session.diplomacy).
  if (url.pathname === '/api/mapblocks') {
    try {
      const points = String(q.get('blocks') || '').split(';')
        .map((s) => s.split(',').map((v) => (v.trim() === '' ? NaN : Number(v))))
        .filter((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
        .map(([x, y]) => ({ x, y }));
      const out = await SESSION.mapBlocks(points, { fresh: q.get('fresh') === '1' });
      return send(200, 'application/json', JSON.stringify(out));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ error: e.message })); }
  }

  if (url.pathname === '/api/mapsearch') {
    return send(200, 'application/json', JSON.stringify(SESSION.searchCache(q.get('q'))));
  }

  if (url.pathname === '/api/market') {
    try {
      const g = await SESSION.connect();
      const out = {};
      for (const res of ['food', 'wood', 'stone', 'iron']) {
        const d = await g.searchTrades(res);
        const sellers = (d.sellers || []).map((s) => Number(s.price)).filter((x) => x > 0);
        const buyers = (d.buyers || []).map((s) => Number(s.price)).filter((x) => x > 0);
        out[res] = {
          bestAsk: sellers.length ? Math.min(...sellers) : null,
          bestBid: buyers.length ? Math.max(...buyers) : null,
          sellVolume: (d.sellers || []).reduce((n2, s) => n2 + Number(s.amount || 0), 0),
          buyVolume: (d.buyers || []).reduce((n2, s) => n2 + Number(s.amount || 0), 0),
        };
      }
      const cid = Number(q.get('city')) || g.castleId(g.castle());
      const mine = await g.myTrades(cid).catch(() => ({}));
      out.mine = mine.trades || mine.tradeList || [];
      return send(200, 'application/json', JSON.stringify(out));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ error: e.message })); }
  }

  if (url.pathname === '/api/config') {
    const env = loadEnv();
    return send(200, 'application/json', JSON.stringify({
      server: env.EVONY_SERVER || 'ss71',
      email: env.EVONY_EMAIL || '',
      hasPassword: !!env.EVONY_PASSWORD,
      names: ORG.settings.get('watchlist', ['WhoAreYou']),
    }));
  }

  if (url.pathname === '/goals' || url.pathname === '/goals.html') {
    return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'public', 'goals.html')));
  }

  if (url.pathname === '/api/goals' && req.method === 'POST') {
    const b = await body(req);
    const { parseGoals, describe } = require('./goals');
    const parsed = parseGoals(b.src || '');
    // The editor's colours ask this on every pause in typing: the parse and its
    // per-line standing only. A check never saves, whatever else it is sent.
    if (b.check) return send(200, 'application/json', JSON.stringify({ ok: true, errors: parsed.errors, lines: parsed.lines }));
    let saved = null;
    if (b.save) {
      const key = String(b.city || 'default').trim() || 'default';
      ORG.goals.set(SESSION.account && SESSION.account.id, key, b.kind === 'script' ? 'script' : 'goal', b.src);
      saved = key;
    }
    return send(200, 'application/json', JSON.stringify({
      ok: true, errors: parsed.errors, lines: parsed.lines, described: describe(parsed), saved,
      engineNote: SESSION.userPaused
        ? 'Saved. The engine is PAUSED — these take effect when you resume it.'
        : 'Saved. The engine picks these up on its next tick.',
    }));
  }

  // The account-wide texts behind the editor's selector (goallayers.js): the
  // new-city template, the Prepend and Append goals every city runs around its
  // own, and the new-city script.
  //   GET  /api/goals/account?which=template|prepend|append|script
  //   POST /api/goals/account {which, src, save}  -> {errors (with where), described, note}
  if (url.pathname === '/api/goals/account') {
    const G = require('./goallayers');
    const acct = SESSION.account && SESSION.account.id;
    try {
      if (!ORG || !acct) throw new Error('this console has no account to keep account-wide goals under');
      if (req.method !== 'POST') return send(200, 'application/json', JSON.stringify(G.readText(ORG.goals, acct, q.get('which'))));
      const b = await body(req);
      const r = G.saveText(ORG.goals, acct, b);
      if (r.saved) {
        if (SESSION.userPaused && (r.which === 'prepend' || r.which === 'append')) r.note = 'Saved. The engine is PAUSED — these take effect when you resume it.';
        SESSION.note(`${r.label} saved from the console (${G.goalLines(b.src)} line(s))`);
      }
      return send(200, 'application/json', JSON.stringify(r));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }

  if (url.pathname === '/script' || url.pathname === '/script.html') {
    return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'public', 'script.html')));
  }

  if (url.pathname === '/api/script' && req.method === 'POST') {
    const b = await body(req);
    // The editor's colours: each line's standing, asked on every pause in typing.
    // It logs nothing and runs nothing. The page sends parseOnly with it, so a
    // console older than the page only parses too.
    if (b.parseOnly && b.lines) {
      return send(200, 'application/json', JSON.stringify({ ok: true, ...require('./script').lineStatus(b.src || '') }));
    }
    const env = loadEnv();
    const lines = [];
    const log = (m) => { lines.push(m); console.log('[script] ' + m); };
    const { parse, run } = require('./script');
    const { Game } = require('./game');

    const actions = parse(b.src || '');
    const errors = scriptErrors(actions);
    log(`parsed ${actions.filter((a) => a.cmd !== 'error').length} action(s)` + (errors.length ? `, ${errors.length} error(s)` : ''));

    if (b.parseOnly) {
      for (const a of actions) log(a.cmd === 'error' ? `line ${a.line}: ERROR ${a.error}` : `line ${a.line}: ${a.cmd} ${JSON.stringify({ ...a, cmd: undefined, line: undefined, raw: undefined })}`);
      return send(200, 'application/json', JSON.stringify({ ok: true, log: lines, errors }));
    }

    // A script is one sequence; running it with lines missing is not what was
    // written, so it runs whole or not at all.
    if (errors.length) {
      for (const e of errors) log(`line ${e.line}: ERROR ${e.error}`);
      log('nothing was run — fix the error(s) and run it again');
      return send(200, 'application/json', JSON.stringify({ ok: false, log: lines, errors }));
    }

    // One run per city at a time, so Stop and the live output know which run
    // is meant.
    const key = String(b.castle ?? b.city ?? '');
    if (SCRIPT_RUNS.has(key)) {
      log('a script is already running in this city — stop it first');
      return send(200, 'application/json', JSON.stringify({ ok: false, log: lines, errors }));
    }
    const running = { stop: false, startedAt: Date.now(), lines, dropped: 0 };
    SCRIPT_RUNS.set(key, running);
    // Use the SHARED session. Logging in a second time for the same account makes
    // the server kick the first connection, which is what was knocking the
    // console offline every time a script ran.
    try {
      const game = await SESSION.connect();
      // The console sends the open city tab as `city`. Reading only `castle`
      // ran every console script in the FIRST city, whichever tab was open.
      // Live unless a caller asks otherwise — only the old /script page still does.
      const n = await run(game, actions, (m) => {
        log(m);
        // an endless `repeat` would otherwise grow this without bound
        if (lines.length > SCRIPT_KEEP) { lines.shift(); running.dropped++; }
      }, {
        dryRun: b.dryRun === true, castle: b.castle ?? b.city, autoReq: !!b.autoReq, session: SESSION, shouldStop: () => running.stop,
        // `logout` waits for the other cities' scripts, except any already waiting at a logout.
        otherScripts: () => [...SCRIPT_RUNS].filter(([, r]) => r !== running && !r.atLogout).map(([city]) => city),
        atLogout: (on) => { running.atLogout = !!on; },
      });
      log(`done — ${n} action(s) executed`);
    } catch (e) {
      log('ERROR: ' + e.message);
    } finally {
      SCRIPT_RUNS.delete(key);
    }
    const kept = running.dropped ? [`(${running.dropped} earlier line(s) not kept)`, ...lines] : lines;
    return send(200, 'application/json', JSON.stringify({ ok: true, log: kept, errors, stopped: running.stop }));
  }

  // Stop a city's script after the line it is on; waits (sleep, @time, market
  // pacing) are cut short.
  if (url.pathname === '/api/script/stop' && req.method === 'POST') {
    const b = await body(req);
    const running = SCRIPT_RUNS.get(String(b.city ?? ''));
    if (!running) return send(200, 'application/json', JSON.stringify({ ok: false, error: 'no script is running in that city' }));
    running.stop = true;
    return send(200, 'application/json', JSON.stringify({ ok: true }));
  }

  // Which cities have a script running, and ?city='s output so far — how the
  // page shows a long run as it goes, and finds runs again after a reload.
  if (url.pathname === '/api/script/runs') {
    const running = q.get('city') === null ? null : SCRIPT_RUNS.get(q.get('city'));
    const tail = running ? running.lines.slice(-400) : null;
    return send(200, 'application/json', JSON.stringify({
      runs: [...SCRIPT_RUNS].map(([city, r]) => ({ city, startedAt: r.startedAt, stopping: r.stop })),
      lines: tail,
      dropped: running ? running.dropped + running.lines.length - tail.length : 0,
    }));
  }

  // Script loadouts: numbered slots per CITY, so a city's Load 1 is its own and
  // saving it never changes another city's. Kept as goals rows of kind 'script'
  // keyed <cityId>:load<N>, read exactly (db.goals.loadouts). An emptied slot is
  // saved empty, not deleted: a city with no rows at all is one never opened,
  // and its first look copies in the account-wide slots the console used to
  // share between cities.
  if (url.pathname === '/api/loadouts') {
    const acct = SESSION.account && SESSION.account.id;
    try {
      const b = req.method === 'POST' ? await body(req) : {};
      const city = String(b.city ?? q.get('city') ?? '').trim();
      if (!/^\d+$/.test(city)) throw new Error('loadouts belong to a city — open one first');
      if (req.method === 'POST') {
        const slot = Number(b.slot);
        if (!Number.isInteger(slot) || slot < 1 || slot > LOADOUTS) throw new Error(`there is no loadout ${b.slot}`);
        const src = String(b.src || '');
        ORG.goals.set(acct, `${city}:load${slot}`, 'script', src.trim() ? src : '');
        return send(200, 'application/json', JSON.stringify({ ok: true, errors: scriptErrors(require('./script').parse(src)) }));
      }
      const slots = ORG.goals.loadouts(acct, city);
      return send(200, 'application/json', JSON.stringify({ ok: true, account: acct || null, city, count: LOADOUTS, slots }));
    } catch (e) { return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message })); }
  }

  if (url.pathname === '/api/scan' && req.method === 'POST') {
    const b = await body(req);
    const env = loadEnv();
    const lines = [];
    const log = (m) => { lines.push(m); console.log('[scan] ' + m); };
    const names = (b.names || []).map((s) => s.trim()).filter(Boolean);
    ORG.settings.set('watchlist', names);
    try {
      const rows = await runScan({ names }, log);
      return send(200, 'application/json', JSON.stringify({ ok: true, rows, log: lines }));
    } catch (e) {
      log('ERROR: ' + e.message);
      return send(200, 'application/json', JSON.stringify({ ok: false, error: e.message, log: lines }));
    }
  }

  send(404, 'text/plain', 'not found');
});

const HOST = AUTH.bindHost();
server.listen(PORT, HOST, () => console.log(
  `
  Evony console -> http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`
  + `   auth ${AUTH.isEnabled() ? 'ON' : 'OFF (localhost only)'}
`));
