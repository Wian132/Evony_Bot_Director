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
  + `   port: ${PORT}   engine: ${SESSION.engineMode}`);

SESSION.startSupervisor();     // heartbeat + auto-reconnect for the console session
SESSION.startEngine();         // ticks the goal engine while engineMode != 'off'

function loadEnv() {
  const out = {};
  const p = path.join(__dirname, '.env');
  if (fs.existsSync(p)) for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2];
  }
  return out;
}

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
    try { await SESSION.connect(); } catch (e) { /* reported via header */ }
    return send(200, 'application/json', JSON.stringify(SESSION.header()));
  }
  // What our own armies are doing right now — the direct answer to "is it
  // actually farming", which the logs only imply.
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
  if (url.pathname === '/api/city') {
    return send(200, 'application/json', JSON.stringify(SESSION.city(q.get('id')) || {}));
  }
  if (url.pathname === '/api/log') {
    const kind = q.get('kind') || 'log';
    const lines = kind === 'reports' ? SESSION.reports : SESSION.log;
    return send(200, 'application/json', JSON.stringify({ lines: lines.slice(-300) }));
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
  if (url.pathname === '/api/engine' && req.method === 'POST') {
    const b = await body(req);
    SESSION.engineMode = ['off', 'plan', 'live'].includes(b.mode) ? b.mode : 'off';
    SESSION.note('engine mode -> ' + SESSION.engineMode);
    return send(200, 'application/json', JSON.stringify({ ok: true, mode: SESSION.engineMode }));
  }
  if (url.pathname === '/api/editor') {
    const city = q.get('city') || 'default';
    const kind = q.get('kind') === 'script' ? 'script' : 'goal';
    const acct = SESSION.account && SESSION.account.id;
    const entry = ORG.goals.find(acct, [city], kind);
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
          name: h.name, level: h.level,
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

      if (b.action === 'mayor') {
        if (!hero) throw new Error('hero not found in this city');
        const current = (castle.heros || []).find((h) => Number(h.status) === 1);
        if (current && current.id !== hero.id) await g.dischargeChief(cid);
        r = await g.promoteToChief(cid, hero.id);
      } else if (b.action === 'unmayor') {
        r = await g.dischargeChief(cid);
      } else if (b.action === 'fire') {
        if (!hero) throw new Error('hero not found in this city');
        r = await g.fireHero(cid, hero.id);
      } else if (b.action === 'release') {
        if (!hero) throw new Error('hero not found in this city');
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
      } else if (b.action === 'hire') {
        r = await g.hireHero(cid, b.heroName);
      } else if (b.action === 'refreshinn') {
        r = await g.refreshTavern(cid);
      } else {
        throw new Error('unknown action ' + b.action);
      }

      SESSION.note(`manual: ${b.action}${b.heroName ? ' ' + b.heroName : ''} -> ${r && r.ok === 1 ? 'ok' : (r && r.errorMsg) || 'ok=' + (r && r.ok)}`);
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
      const out = await SESSION.scanArea(cx, cy, r);
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
    let saved = null;
    if (b.save) {
      const key = String(b.city || 'default').trim() || 'default';
      ORG.goals.set(SESSION.account && SESSION.account.id, key, b.kind === 'script' ? 'script' : 'goal', b.src);
      saved = key;
    }
    return send(200, 'application/json', JSON.stringify({
      ok: true, errors: parsed.errors, described: describe(parsed), saved,
      engineNote: SESSION.engineMode === 'off'
        ? 'Saved. The engine is OFF for this console — switch it to plan or live to act on these goals.'
        : `Saved. The engine is running in ${SESSION.engineMode.toUpperCase()} mode and will pick these up on the next tick.`,
    }));
  }

  if (url.pathname === '/script' || url.pathname === '/script.html') {
    return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'public', 'script.html')));
  }

  if (url.pathname === '/api/script' && req.method === 'POST') {
    const b = await body(req);
    const env = loadEnv();
    const lines = [];
    const log = (m) => { lines.push(m); console.log('[script] ' + m); };
    const { parse, run } = require('./script');
    const { Game } = require('./game');

    const actions = parse(b.src || '');
    const errs = actions.filter((a) => a.cmd === 'error');
    log(`parsed ${actions.length - errs.length} action(s)` + (errs.length ? `, ${errs.length} parse error(s)` : ''));

    if (b.parseOnly) {
      for (const a of actions) log(a.cmd === 'error' ? `line ${a.line}: ERROR ${a.error}` : `line ${a.line}: ${a.cmd} ${JSON.stringify({ ...a, cmd: undefined, line: undefined, raw: undefined })}`);
      return send(200, 'application/json', JSON.stringify({ ok: true, log: lines }));
    }

    // Use the SHARED session. Logging in a second time for the same account makes
    // the server kick the first connection, which is what was knocking the
    // console offline every time a script ran (even a dry run).
    try {
      const game = await SESSION.connect();
      const n = await run(game, actions, log, { dryRun: b.dryRun !== false, castle: b.castle, autoReq: !!b.autoReq });
      log(`done — ${n} action(s) executed`);
    } catch (e) {
      log('ERROR: ' + e.message);
    }
    return send(200, 'application/json', JSON.stringify({ ok: true, log: lines }));
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
