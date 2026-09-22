'use strict';
// High-level game operations on top of the raw client.
const { EvonyClient, getServerConfig } = require('./evony');
const C = require('./constants');
const SEC = require('./security');

class Game {
  constructor(log = () => {}) {
    this.log = log;
    this.c = null;
    this.player = null;
    this.castles = [];
    this.holiday = null;       // { hours, minutes, text } while the account is on holiday
    this.marchSkillParam = 100;
    this.serverOffset = 0;     // serverNow - localNow, in ms
    // The account's security code, and what this SESSION has unlocked with it.
    // Both die with the Game, which is what the game does too: an unlock "will
    // only be effective during this session and will end at logout"
    // (UnlockSecurityCode.as). The code itself is deliberately non-enumerable,
    // so it cannot reach a log line, a snapshot or a JSON dump by accident.
    Object.defineProperty(this, '_secCode', { value: null, writable: true, enumerable: false });
    Object.defineProperty(this, '_secAuthed', { value: false, writable: true, enumerable: false });
    Object.defineProperty(this, '_secUnlocked', { value: 0, writable: true, enumerable: false });
  }

  // Set by the session from the account record. A FUNCTION is read at the
  // moment the code is wanted, so changing it in the Director takes effect on
  // the next protected command rather than the next login.
  setSecurityCode(code) { this._secCode = code || null; return this; }
  securityCode() {
    const c = this._secCode;
    const v = typeof c === 'function' ? c() : c;
    return v ? String(v) : null;
  }
  hasSecurityCode() { return !!this.securityCode(); }

  // Send a command the game may guard with the security code, answering a -200
  // by unlocking and sending it once more. See security.js for the protocol.
  reqProtected(cmd, data, ms) {
    return SEC.sendProtected(this, cmd, data, { code: this.securityCode(), log: this.log, timeout: ms });
  }

  // What a login reply means. ok=1 is the plain yes; ok=-100 is a yes as well,
  // for an account on HOLIDAY: the server sends the whole player with it and
  // only asks the game's own client to show its holiday panel, from which a
  // person may end the holiday (EvonyClient.as:5104-5111, HolidayTips.as:205).
  // NEAT logs in regardless and so does OTTObot — the holiday is never ended
  // here, and `msg` carries "<hours>,<minutes>,<minutes left>".
  // Anything else is a refusal, and its text must stay SHORT: the reply carries
  // the entire player bean (100 KB+), which has no place in a log line.
  static loginOutcome(data) {
    if (!data) return { error: 'login failed: no reply' };
    if (data.ok === 1) return { ok: true };
    if (data.ok === -100) {
      const parts = String(data.msg || data.errorMsg || '').split(',').map((x) => Number(x) || 0);
      const hours = parts[0] || 0, minutes = parts[1] || 0;
      return { ok: true, holiday: { hours, minutes, text: `${hours}h${String(minutes).padStart(2, '0')}m` } };
    }
    const why = data.ok === -5 ? 'the game wants a captcha (ok=-5)'
      : data.ok === 2 ? 'the game has no lord on this account yet (ok=2)'
        : `ok=${data.ok}`;
    const said = String(data.errorMsg || data.msg || '').slice(0, 200);
    return { error: `login failed: ${why}${said ? ' — ' + said : ''}` };
  }

  now() { return Date.now() + this.serverOffset; }

  // The server's own wall clock, in ITS timezone — not the viewer's.
  serverClock() {
    const d = new Date(this.now() + (this.serverTzOffsetMs || 0));
    const p = (n) => String(n).padStart(2, '0');
    return {
      text: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
      date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
      tz: `UTC${(this.serverTzOffsetMs || 0) >= 0 ? '+' : ''}${(this.serverTzOffsetMs || 0) / 3600000}`,
      offsetMs: this.serverTzOffsetMs || 0,
    };
  }

  // A login that fails — no reply, a refusal, anything after the socket opened —
  // closes its socket. Left open, it stayed logged-in-pending: Lord06's console held
  // three sockets on 2026-09-18 after unanswered logins, and a login the server
  // finished late on one of them took the account off the live socket.
  async connect(server, email, password, proxy = null) {
    try {
      return await this._connect(server, email, password, proxy);
    } catch (e) {
      try { if (this.c) this.c.close(); } catch {}
      throw e;
    }
  }
  async _connect(server, email, password, proxy = null) {
    const cfg = await getServerConfig(server);
    this.log(`${server} -> ${cfg.host}:${cfg.port} (${cfg.state})${proxy ? ' via ' + proxy.label : ''}`);
    this.proxy = proxy;
    this.c = new EvonyClient();
    this.c.on('log', (m) => this.log(m));
    await this.c.connect(cfg.host, cfg.port, proxy);

    const tLogin = Date.now();
    const lr = await this.c.login(email, password);
    const rtt = Date.now() - tLogin;
    // ok=1, or ok=-100 for an account on holiday — a login either way, see
    // Game.loginOutcome. Anything else throws, and never with the payload in it.
    const outcome = Game.loginOutcome(lr && lr.data);
    if (outcome.error) throw new Error(outcome.error);
    this.player = lr.data.player;
    this.castles = this.player.castles || [];
    this.holiday = outcome.holiday || null;
    this.log(`logged in as ${this.player.playerInfo.userName} - ${this.castles.length} castle(s)`);
    if (this.holiday) {
      this.log(`holiday mode: about ${this.holiday.text} of protection left — logged in as usual,`
        + ' and the holiday is left running');
    }

    // The server also sends its wall clock as text ("2026.09.12 12.57.29"), which
    // together with the epoch tells us its timezone — measured, not assumed.
    // (ss71 reports UTC-5 and does not appear to observe DST.)
    const dt = String(this.player.currentDateTime || '').match(/(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2})\.(\d{2})\.(\d{2})/);
    if (dt && this.player.currentTime) {
      const asUtc = Date.UTC(+dt[1], +dt[2] - 1, +dt[3], +dt[4], +dt[5], +dt[6]);
      this.serverTzOffsetMs = Math.round((asUtc - this.player.currentTime) / 60000) * 60000;
      this.log(`server timezone UTC${this.serverTzOffsetMs >= 0 ? '+' : ''}${this.serverTzOffsetMs / 3600000}`);
    }

    // LoginResponse carries the server clock. The reply left the server roughly
    // one one-way trip ago, so add half the measured round trip back.
    if (this.player.currentTime) {
      this.serverOffset = Math.round(this.player.currentTime + rtt / 2 - Date.now());
      this.log(`server clock offset ${this.serverOffset > 0 ? '+' : ''}${this.serverOffset}ms (login rtt ${rtt}ms)`);
    } else {
      this.log('no currentTime in LoginResponse - using local clock for @ timing');
    }

    // Heroes are not in LoginResponse; the server pushes them as server.HeroUpdate.
    this.c.on('cmd', (cmd, data) => { if (cmd === 'server.HeroUpdate') this.applyHeroUpdate(data); });

    // Items are pushed the same way. Without this the inventory we hold goes
    // stale the moment anything is spent, so a count of 52 stays 52 forever.
    this.c.on('cmd', (cmd, data) => {
      if (cmd !== 'server.ItemUpdate' || !data) return;
      const list = data.items || (data.item ? [data.item] : []);
      if (!Array.isArray(list) || !list.length) return;
      this.player = this.player || {};
      this.player.items = this.player.items || [];
      for (const it of list) {
        if (!it || it.id === undefined) continue;
        const i = this.player.items.findIndex((x) => x.id === it.id);
        const count = Number(it.count || 0);
        if (i >= 0) { if (count > 0) this.player.items[i] = { ...this.player.items[i], ...it }; else this.player.items.splice(i, 1); }
        else if (count > 0) this.player.items.push(it);
      }
    });
    // And the player buffs (truce, horns, corselets...), which defensepolicy
    // reads to know what is already running. See applyPlayerBuffUpdate.
    this.c.on('cmd', (cmd, data) => { if (cmd === 'server.PlayerBuffUpdate') this.applyPlayerBuffUpdate(data); });
    // And each city's medic camp, which the healing goal reads (goal-upkeep.js).
    this.c.on('cmd', (cmd, data) => { if (cmd === 'server.InjuredTroopUpdate') this.applyInjuredUpdate(data); });
    // Each city's own buffs (a forced gate, slowed marches...): castle.buffs.
    // See applyCastleBuffUpdate.
    this.c.on('cmd', (cmd, data) => { if (cmd === 'server.CastleBuffUpdate') this.applyCastleBuffUpdate(data); });
    // And the end of a research (applyResearchComplete).
    this.c.on('cmd', (cmd, data) => { if (cmd === 'server.ResearchCompleteUpdate') this.applyResearchComplete(data); });

    // march/load skill params (affects march time)
    try {
      this.c.send('army.getTroopParam', {});
      const p = await this.c.await(['army.getTroopParam'], 8000);
      if (p && p.data) {
        this.marchSkillParam = p.data.marchSkillParam ?? 100;
        this.loadSkillParam = p.data.loadSkillParam ?? 100;
        this.log(`march skill ${this.marchSkillParam}, load skill ${this.loadSkillParam}`);
      }
    } catch { this.log('army.getTroopParam: no reply, assuming marchSkill=100'); }

    // The clock offset is only as accurate as the round trip it was measured on
    // (error is bounded by rtt/2). Sample a few cheap round trips to find the real
    // floor, so we can say how much to trust it.
    try {
      const me = this.player.playerInfo.userName;
      const samples = [];
      for (let i = 0; i < 3; i++) {
        const t = Date.now();
        this.c.send('common.getPlayerInfoByName', { userName: me });
        await this.c.await(['common.getPlayerInfoByName'], 8000);
        samples.push(Date.now() - t);
      }
      this.minRtt = Math.min(...samples);
      this.clockUncertaintyMs = Math.round(Math.max(0, rtt - this.minRtt) / 2);
      const verdict = this.clockUncertaintyMs > 250 ? '  <- LOW CONFIDENCE, reconnect for tighter timing' : '';
      this.log(`rtt floor ${this.minRtt}ms, clock offset good to +/-${this.clockUncertaintyMs}ms${verdict}`);
    } catch { this.log('clock calibration skipped'); }

    // give the server a moment to push hero state
    await new Promise((r) => setTimeout(r, 2500));
    const heroCount = this.castles.reduce((n, c) => n + ((c.heros || []).length), 0);
    this.log(`heroes known: ${heroCount}`);
    return this.player;
  }

  castle(ref) {
    if (!this.castles.length) throw new Error('no castles loaded');
    if (ref === undefined || ref === null || ref === '') return this.castles[0];
    const byName = this.castles.find((c) => (c.name || '').toLowerCase() === String(ref).toLowerCase());
    if (byName) return byName;
    const byId = this.castles.find((c) => c.castleId === Number(ref) || c.id === Number(ref));
    if (byId) return byId;
    const idx = Number(ref);
    if (!Number.isNaN(idx) && this.castles[idx]) return this.castles[idx];
    throw new Error('unknown castle: ' + ref);
  }

  // updateType 0 add, 1 delete, 2 update (Context.onHeroUpdate, the client's
  // only way a hero ever leaves a city). A dismissed hero arrives as a delete;
  // treating that as an update kept it on the roster until the next login.
  applyHeroUpdate(data) {
    if (!data || !data.hero) return;
    const c = this.castles.find((x) => this.castleId(x) === data.castleId);
    if (!c) return;
    c.heros = c.heros || [];
    const i = c.heros.findIndex((h) => h.id === data.hero.id);
    if (Number(data.updateType) === 1) { if (i >= 0) c.heros.splice(i, 1); return; }
    if (i >= 0) c.heros[i] = data.hero; else c.heros.push(data.hero);
  }

  castleId(c) { return c.castleId ?? c.id; }
  castleXY(c) {
    if (c.fieldId !== undefined) return C.fieldIdToCoords(c.fieldId);
    const m = String(c.coords || c.pos || '').match(/(\d+)\s*,\s*(\d+)/);
    if (m) return { x: +m[1], y: +m[2] };
    return null;
  }

  // ---- hero selection ----
  // "any", a hero name, or "any:level<500,attack>400". `skip` holds ids an
  // "any" must not pick: heroes a script has just sent, before the server's
  // HeroUpdate has marked them away.
  pickHero(castle, spec, skip = null) {
    const heros = castle.heros || [];
    if (!heros.length) throw new Error('no heroes in castle');
    const idle = heros.filter((h) => (h.status === 0 || h.status === undefined) && !(skip && skip.has(h.id)));
    const pool = idle.length ? idle : heros;

    if (!spec || spec === 'any') return pool[0];

    const [head, cond] = String(spec).split(':');
    let cands = pool;
    if (head && head !== 'any') {
      const byName = heros.find((h) => (h.name || '').toLowerCase() === head.toLowerCase());
      if (!byName) throw new Error('hero not found: ' + head);
      return byName;
    }
    if (cond) {
      const FIELD = { level: 'level', attack: 'power', power: 'power', politics: 'management', intel: 'stratagem' };
      for (const clause of cond.split(',')) {
        const m = clause.match(/^(\w+)\s*(<=|>=|<|>|=)\s*(\d+)$/);
        if (!m) throw new Error('bad hero condition: ' + clause);
        const f = FIELD[m[1]]; const op = m[2]; const v = +m[3];
        if (!f) throw new Error('unknown hero field: ' + m[1]);
        cands = cands.filter((h) => {
          const x = Number(h[f] ?? 0);
          return op === '<' ? x < v : op === '>' ? x > v : op === '<=' ? x <= v : op === '>=' ? x >= v : x === v;
        });
      }
    }
    if (!cands.length) throw new Error('no hero matches ' + spec);
    return cands[0];
  }

  // ---- marches ----
  // troops: {archer: 100, ...}; resources for transport: {wood: 1000,...}
  buildArmyBean({ missionType, heroId, targetPoint, troops, resources = {}, restTimeSec = 0 }) {
    // heroId is omitted when there is no hero — NewArmyWin.as only sets it when one is selected.
    const heroPart = heroId === undefined || heroId === null ? {} : { heroId };
    return {
      resource: { iron: resources.iron || 0, food: resources.food || 0, wood: resources.wood || 0, stone: resources.stone || 0, gold: resources.gold || 0 },
      troops: { ...C.EMPTY_TROOPS, ...troops },
      missionType,
      useItem: false,
      restTime: restTimeSec,
      useFlag: false,
      backAfterConstruct: false,
      ...heroPart,
      targetPoint,
    };
  }

  // A march over the city's limit (10,000 troops per Rally Spot level, at most
  // 100,000; rally.js marchTroopLimit) is refused here, in the server's reply
  // shape, rather than sent to be refused: every caller already handles that.
  // A city whose list shows no Rally Spot is left to the server to judge. A War
  // Ensign (useFlag, /big) and the Horde banner (useItem, /horde) raise the limit.
  async newArmy(castleId, bean) {
    const castle = this.castles.find((c) => String(this.castleId(c)) === String(castleId));
    const big = !!(bean && bean.useFlag), horde = !!(bean && bean.useItem);
    const limit = castle ? require('./rally').marchTroopLimit(castle, { big, horde }) : null;
    const troops = Object.values((bean && bean.troops) || {}).reduce((t, v) => t + (Number(v) || 0), 0);
    if (limit && troops > limit) {
      const why = horde ? `with the Horde banner${big ? ' and a War Ensign' : ''}` : `10,000 per Rally Spot level${big ? ', +25% with a War Ensign' : ''}`;
      return { ok: 0, errorMsg: `a march from ${castle.name || 'this city'} takes at most ${limit.toLocaleString('en-US')} troops `
        + `(${why}), not ${troops.toLocaleString('en-US')}` };
    }
    this.c.send('army.newArmy', { castleId, newArmyBean: bean });
    const r = await this.c.await(['army.newArmy'], 12000);
    return r.data;
  }

  // army.callBackArmy {castleId, armyId} (ArmyCommands.as:105)
  recallArmy(castleId, armyId) { return this.req('army.callBackArmy', { castleId, armyId }); }

  // The speed inputs for marches from one city. The client asks per city
  // (ArmyCommands.getTroopParam(castleId)), because transportStationParam is
  // that city's Relief Station. Held for a few minutes: none of it moves fast.
  async troopParams(castleId, maxAgeMs = 300000) {
    this._troopParams = this._troopParams || new Map();
    const hit = this._troopParams.get(castleId);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.p;
    const d = (await this.req('army.getTroopParam', { castleId }, 8000)) || {};
    const p = {
      marchSkill: Number(d.marchSkillParam ?? this.marchSkillParam ?? 100),
      driveSkill: Number(d.driveSkillParam ?? d.marchSkillParam ?? this.marchSkillParam ?? 100),
      loadSkill: Number(d.loadSkillParam ?? this.loadSkillParam ?? 100),
      relief: Number(d.transportStationParam || 0),
    };
    this._troopParams.set(castleId, { at: Date.now(), p });
    return p;
  }

  // Who holds a tile: field.getOtherFieldInfo {fieldId} -> bean {userName, allianceName}.
  // The client gives a march the Relief Station speed when the answer is you or
  // your alliance (NewArmyWin.otherFieldInfo). The raw values are kept, because
  // that test is ActionScript `==`, where a missing name equals a missing name.
  async fieldOwner(fieldId) {
    const r = await this.req('field.getOtherFieldInfo', { fieldId }, 8000);
    const b = r && r.bean;
    return b ? { userName: b.userName, allianceName: b.allianceName } : null;
  }

  // The whole answer, for a goal that is about to march on a valley or flat:
  // {ok, bean: MapCastleBean {userName, canOccupy, canScout, ...}}. The client
  // offers Attack only when canOccupy and Scout only when canScout
  // (FieldInfoWin.as:1127, :1590), and an unowned tile has no userName.
  fieldInfo(fieldId) { return this.req('field.getOtherFieldInfo', { fieldId }, 8000); }

  // field.giveUpField {fieldId}: let a valley or flat go (FieldCommand.as:25,
  // the Abandon button in CurFieldView.as:758). No castle id: the server knows
  // whose it is. Irreversible, so callers check it is one of ours first.
  giveUpField(fieldId) { return this.req('field.giveUpField', { fieldId }); }

  // troop.disbandTroop {castleId, troopType, num} (TroopCommands.as:72) and
  // fortifications.destructWallProtect {castleId, typeId, num}
  // (FortificationsCommands.as:70): both destroy what they name, for good.
  // Disbanding is "Dismiss armies", bit 4 (SWDisband.as:364). Destroying wall
  // fortifications is NOT protected — the client has no -200 branch on it.
  disbandTroop(castleId, troopType, num) { return this.reqProtected('troop.disbandTroop', { castleId, troopType, num }); }
  destructWall(castleId, typeId, num) { return this.req('fortifications.destructWallProtect', { castleId, typeId, num }); }

  // city.giveupCastle {password, castleId}: gives a city up for good, and takes
  // the account password as SHA1 of the text (GiveupCastle.as:417) AS WELL AS
  // the security code when "Abandon cities" is protected (bit 2). Callers check
  // the city registry first — see goal-buildnpc.js.
  giveUpCastle(castleId, passwordHash) {
    return this.reqProtected('city.giveupCastle', { password: passwordHash, castleId });
  }

  // common.deleteUserAndRestart {pwd}: deletes the lord. Bit 1, "Restart game",
  // the one option the game will not let a player switch off.
  deleteUserAndRestart(passwordHash) {
    return this.reqProtected('common.deleteUserAndRestart', { pwd: passwordHash });
  }

  // The item catalogue, straight from the server. Item NAMES are not in the
  // decompiled client — it fetches this XML at runtime — so this is the only
  // authoritative answer to "which id is Excalibur".
  // The catalogue arrives in several packages, not one frame, so collect until
  // they stop coming rather than taking the first and assuming that is all.
  async itemDefs({ quietMs = 2500, maxMs = 30000 } = {}) {
    const parts = [];
    let last = Date.now();
    const onCmd = (cmd, data) => {
      if (cmd !== 'common.getItemDefXml') return;
      parts.push(data);
      last = Date.now();
    };
    this.c.on('cmd', onCmd);
    this.c.send('common.getItemDefXml', {});
    const started = Date.now();
    try {
      // finished when nothing new has arrived for a while
      while (Date.now() - started < maxMs && (parts.length === 0 || Date.now() - last < quietMs)) {
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally { this.c.off('cmd', onCmd); }
    return {
      packages: parts.length,
      itemXml: parts.sort((a, b) => Number(a.packageId || 0) - Number(b.packageId || 0))
        .map((p) => String(p.itemXml || '')).join(''),
    };
  }

  // ---- building ----
  // FortificationsCommands.as: produceWallProtect(castleId, wallProtectType, num)
  async produceWall(castleId, wallProtectType, num) {
    this.c.send('fortifications.produceWallProtect', { castleId, wallProtectType, num });
    const r = await this.c.await(['fortifications.produceWallProtect'], 12000);
    return r.data;
  }

  async wallQueue(castleId) {
    this.c.send('fortifications.getProduceQueue', { castleId });
    const r = await this.c.await(['fortifications.getProduceQueue'], 12000);
    return r.data;
  }

  // TroopCommands.as: produceTroop(castleId, positionId, troopType, num, isShare, toIdle)
  async produceTroop(castleId, troopType, num, positionId = 4) {
    this.c.send('troop.produceTroop', { castleId, positionId, troopType, num, isShare: false, toIdle: false });
    const r = await this.c.await(['troop.produceTroop'], 12000);
    return r.data;
  }

  // ---- items / shop ----
  buyItem(itemId, amount) { return this.req('shop.buy', { itemId, amount }); }
  useItem(castleId, itemId, num = 1) { return this.req('shop.useGoods', { castleId, itemId, num }); }
  useCastleItem(castleId, itemId) { return this.req('shop.useCastleGoods', { castleId, itemId }); }
  packageList(castleId) { return this.req('common.getPackageList', { castleId }); }

  // ---- defence items (defensepolicy) ----
  // Each goes through the command the client uses for it (constants.js
  // DEFENSE_ITEM_USE). The outcome is kept per item id for the whole account,
  // so a second city knows a truce or a horn has just gone out, even before the
  // server's buff push arrives: itemUses[itemId] = {at, ok, castleId, errorMsg}.
  async useDefenceItem(castleId, itemId) {
    const how = C.DEFENSE_ITEM_USE[itemId];
    if (!how) return { ok: 0, errorMsg: `${itemId} is not a defence item` };
    this.itemUses = this.itemUses || {};
    const note = (ok, errorMsg) => { this.itemUses[itemId] = { at: Date.now(), ok, castleId, errorMsg: errorMsg || null }; };
    let r;
    try {
      r = how.cmd === 'city.setStopWarState' ? await this.useTruce(itemId)
        : how.cmd === 'shop.useCastleGoods' ? await this.useCastleItem(castleId, itemId)
        : await this.useItem(castleId, itemId, 1);
    } catch (e) { note(null, e.message); throw e; }   // no reply: it may or may not have gone through
    note(r && r.ok === 1 ? 1 : 0, r && r.errorMsg);
    return r;
  }

  // Truce Agreement: city.setStopWarState {ItemId, passWord} — capital I and a
  // camelCase passWord, exactly as CityCommands.as:134-142 sends them. It has no
  // castleId because it changes the whole account's status. passWord is the
  // SHA1 the login sent (evony.js keeps it private); it is never logged.
  async useTruce(itemId = C.DEFENSE_ITEMS.truce) {
    const passWord = this.c && typeof this.c.passwordHash === 'function' ? this.c.passwordHash() : null;
    if (!passWord) return { ok: 0, errorMsg: 'this session never logged in with a password, so it cannot sign a truce' };
    return this.req('city.setStopWarState', { ItemId: itemId, passWord });
  }

  // server.PlayerBuffUpdate {updateType, buffBean}, applied the way
  // Context.onPlayerBuffUpdate does: 0 adds, 1 deletes the first buff of that
  // typeId, anything else updates it. Without this the login's buff list goes
  // stale, and a truce or horn already running would look absent.
  applyPlayerBuffUpdate(data) {
    const b = data && data.buffBean;
    if (!b || b.typeId === undefined || b.typeId === null) return;
    this.player = this.player || {};
    const list = (this.player.buffs = this.player.buffs || []);
    if (Number(data.updateType) === 0) { list.push(b); return; }
    const i = list.findIndex((x) => x && x.typeId === b.typeId);
    if (i < 0) return;
    if (Number(data.updateType) === 1) list.splice(i, 1);
    else list[i] = { ...list[i], ...b };
  }

  // server.CastleBuffUpdate {castleid, updateType, buffBean} — note the
  // lowercase castleid (CastleBuffUpdate.as). Context.as does not listen for
  // it; the buff bar does (PLayerBuffBar.as:190-240, castlebuffRefresh; its
  // addCastleBuff, :262-282, shows ForceopenclosegateBuff, IncArmyActionTimeBuff,
  // MoveCastleCoolDownBuff and a few more off the city): on the city whose
  // id is castleid, 1 removes the buff of that typeId, 0 and 2 add it or copy
  // its typeId/descName/endTime onto the one already there, and any other
  // type only updates one already there. One difference: the client's 0 for
  // a buff it already holds adds a second copy; here the one copy is updated,
  // so a castle holds one buff per type, as the login's list does. Without
  // this castle.buffs stays as it was at login (timed marches read it).
  applyCastleBuffUpdate(data) {
    const b = data && data.buffBean;
    if (!b || b.typeId === undefined || b.typeId === null) return;
    const cid = data.castleid ?? data.castleId;
    const c = (this.castles || []).find((x) => Number(this.castleId(x)) === Number(cid));
    if (!c) return;
    const list = (c.buffs = Array.isArray(c.buffs) ? c.buffs : []);
    const type = Number(data.updateType);
    if (type === 1) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i] && list[i].typeId === b.typeId) list.splice(i, 1);
      return;
    }
    const i = list.findIndex((x) => x && x.typeId === b.typeId);
    if (i >= 0) list[i] = { ...list[i], ...b };
    else if (type === 0 || type === 2) list.push({ ...b });
  }

  // The embassy's "allow alliance troops to station" box: army.setAllowAllianceArmy
  // {castleId, isAllow} (ArmyCommands.as:156-167), sent by the Embassy window
  // (Embassy.as:545-549), which sets castle.allowAlliance itself; the reply is a
  // plain CommandResponse.
  setAllowAlliance(castleId, isAllow) {
    return this.req('army.setAllowAllianceArmy', { castleId, isAllow: !!isAllow });
  }

  // ---- teleporting a city (CityCommands.as) ----
  // Each one spends its item server-side; none goes through shop.useGoods.
  // targetId is a fieldId, y * 800 + x (DesignatedMoveCityWin.changeZone). The
  // new tile arrives as a server.CastleUpdate push — Context.onCastleUpdate is
  // the only place the real client learns it too. See teleport.js.
  zoneInfo() { return this.req('common.zoneInfo', {}); }
  moveCastle(castleId, zoneId) { return this.req('city.moveCastle', { castleId, zoneId }); }             // City Teleporter
  advMoveCastle(castleId, targetId) { return this.req('city.advMoveCastle', { castleId, targetId }); }   // Advanced Teleporter
  warMoveCastle(castleId, targetId) { return this.req('city.WarMoveCastle', { castleId, targetId }); }  // War Teleporter

  // ---- dismissed heroes: what a Stone of Finding restores (stone-of-finding.js) ----
  lostHeroes() { return this.req('hero.GetDisappearHeros', {}); }
  // NOTE: this command uses lowercase `castleid` and `id`, unlike every other one.
  recoverHero(castleId, heroId) { return this.req('hero.RecoverDisappearHero', { castleid: castleId, id: String(heroId) }); }

  // ---- heroes ----
  // Attribute names: power = Attack, management = Politics, stratagem = Intelligence.
  // Both inn replies are a HeroListResponse, which also carries posCount: the
  // Feasting Hall's free hero slots (HeroListResponse.as:18,44-46; the hire
  // window shows it as its free-slot line, Tavern.as:586-591, HireHero.as:735-738).
  // Every read notes it (noteHall), so goals can use the server's own number,
  // and the offers too (noteInn), which the hiring goal works from.
  async tavernList(castleId) { return this.noteHall(castleId, this.noteInn(castleId, await this.req('hero.getHerosListFromTavern', { castleId }))); }
  async refreshTavern(castleId) { return this.noteHall(castleId, this.noteInn(castleId, await this.req('hero.refreshHerosListFromTavern', { castleId }))); }

  // The inn's offers as last read, per city: the reply's heros, each a HeroBean
  // with its level, attributes and the item a hire needs (itemId x itemAmount,
  // HireHero.as:735-747). goal-heroes' hiring step judges them and takes a hired
  // one off the list, as the client does (Tavern.as onHireHeroResponse).
  noteInn(castleId, r) {
    if (!r || r.ok !== 1 || !Array.isArray(r.heros)) return r;
    const c = (this.castles || []).find((x) => Number(this.castleId(x)) === Number(castleId));
    this.innSeen = this.innSeen || {};
    this.innSeen[c ? this.castleId(c) : castleId] = { at: Date.now(), offers: r.heros.slice() };
    return r;
  }

  // posCount is the free slots at that moment. The hall's size is that plus the
  // heroes then on the roster, which stays true through hires, fires and
  // arrivals until the Feasting Hall itself changes level — so the level is kept
  // too, and goal-heroes.feastingHall ignores a reading taken at another level.
  // A reply without posCount says nothing (the client's field would default to
  // 0, "full"), so it is not noted.
  noteHall(castleId, r) {
    const raw = r && r.posCount;
    if (!r || r.ok !== 1 || raw === undefined || raw === null || raw === '' || !Number.isFinite(Number(raw))) return r;
    const c = (this.castles || []).find((x) => Number(this.castleId(x)) === Number(castleId));
    if (!c) return r;
    const heroes = (c.heros || []).length;
    const fh = (c.buildings || []).find((b) => Number(b.typeId) === 27);   // 27 = Feasting Hall
    this.hallSeen = this.hallSeen || {};
    this.hallSeen[this.castleId(c)] = {
      at: Date.now(), posCount: Number(raw), heroes, capacity: Number(raw) + heroes,
      fhLevel: fh ? Number(fh.level) : null,
    };
    return r;
  }
  // A hire names the inn offer (HireHero.as:526); the hero then arrives on the
  // roster by a server.HeroUpdate add. awardGold is the Reward window's gold
  // choice (AwardHero.as:647).
  hireHero(castleId, heroName) { return this.req('hero.hireHero', { castleId, heroName }); }
  // Dismissing a hero is one of the five the security code can guard
  // (HeroProperties.as:2007, bit 8). releaseHero is NOT — the client has no
  // -200 branch on it.
  fireHero(castleId, heroId) { return this.reqProtected('hero.fireHero', { castleId, heroId }); }
  releaseHero(castleId, heroId) { return this.req('hero.releaseHero', { castleId, heroId }); }
  promoteToChief(castleId, heroId) { return this.req('hero.promoteToChief', { castleId, heroId }); }
  dischargeChief(castleId) { return this.req('hero.dischargeChief', { castleId }); }
  levelUpHero(castleId, heroId) { return this.req('hero.levelUp', { castleId, heroId }); }
  resetPoint(castleId, heroId) { return this.req('hero.resetPoint', { castleId, heroId }); }
  awardGold(castleId, heroId) { return this.req('hero.awardGold', { castleId, heroId }); }
  callBackHero(castleId, heroId) { return this.req('hero.callBackHero', { castleId, heroId }); }
  // The key is newName (HeroCommand.changeName); see rename-hero.js.
  renameHero(castleId, heroId, newName) { return this.req('hero.changeName', { castleId, heroId, newName }); }

  // hero.addPoint carries ABSOLUTE NEW TOTALS, not increments.
  // HeroProperties.as seeds its boxes from the hero's current attributes
  // (refreshInitData), bumps them by 1 per click, and submits those numbers
  // (onSubmitHero). Sending increments would zero the untouched attributes.
  // Callers pass increments here and we convert against the live hero.
  addPoint(castleId, hero, { management = 0, power = 0, stratagem = 0 } = {}) {
    if (!hero || typeof hero !== 'object') throw new Error('addPoint needs the hero object, not just an id');
    const cur = (k) => Math.round(Number(hero[k] || 0));
    return this.req('hero.addPoint', {
      castleId, heroId: hero.id,
      management: cur('management') + Math.max(0, Math.round(management)),
      power: cur('power') + Math.max(0, Math.round(power)),
      stratagem: cur('stratagem') + Math.max(0, Math.round(stratagem)),
    });
  }

  static ATTR = { attack: 'power', power: 'power', atk: 'power',
                  politics: 'management', pol: 'management', management: 'management',
                  intel: 'stratagem', int: 'stratagem', stratagem: 'stratagem' };

  // The attribute field ALREADY includes allocated points — HeroProperties.as
  // displays h.power directly and never reads powerAdded. So the effective value
  // is the field itself.
  static attrValue(h, key) { return Number(h[key] || 0); }
  // A hero's base is its strongest attribute less the one point per level that
  // levelling gave it, with any unspent points added back. The *Added fields
  // can't tell us: the live roster sends 0 for every one (Griselda: L26,
  // power 87, powerAdded 0 — base 61). The attribute is pre-buff, since an
  // Excalibur's 25% lives in powerBuffAdded and never touches it.
  static heroBase(h) {
    const top = Math.max(...['power', 'management', 'stratagem'].map((k) => Game.attrValue(h, k)));
    return top - Number(h.level || 0) + Number(h.remainPoint || 0);
  }

  // ---- banked experience ----
  // A hero keeps earning experience past the level it has: the server only
  // raises the level when hero.levelUp is sent, one level a time. So a hero can
  // sit on enough experience for dozens of levels while its unspent points
  // (remainPoint) read 0 — every point it has won so far is already spent.
  // INFERRED: a level costs level^2 x 100, which fits every row of the wiki's
  // ListAllHeroes sample (L193 needs 3,724,900) and the live roster (OTTO at
  // L1146 wants 131,331,600 = 1146^2 x 100, 2026-09-22). The bean's own
  // upgradeExp is used for the first step when it is there.
  static expToNext(level) { return Number(level || 0) * Number(level || 0) * 100; }
  // How many levels the experience a hero is already holding would buy.
  static heroLevelsReady(h) {
    if (!h) return 0;
    let L = Number(h.level || 0), left = Number(h.experience || 0), n = 0;
    let cost = Number(h.upgradeExp || 0) > 0 ? Number(h.upgradeExp) : Game.expToNext(L);
    while (cost > 0 && left >= cost && n < 100000) { left -= cost; n++; L++; cost = Game.expToNext(L); }
    return n;
  }

  // What a hero costs, by the client's own sums: a hire takes level x 1000 gold
  // (HireHero.as:743, its gold row) besides a free slot and any item the offer
  // names; a gold reward takes level x 100 (AwardHero.as:647, 693); the salary is
  // level x 20 gold an hour (HireHero.as:598-599).
  static hireCost(h) { return Number((h && h.level) || 0) * 1000; }
  static awardCost(h) { return Number((h && h.level) || 0) * 100; }
  static heroSalary(h) { return Number((h && h.level) || 0) * 20; }

  // HeroConstants.as: 0 free, 1 chief (mayor), 2 guard, 3 marching, 4 captured, 5 returning, 8 farming
  static HERO_STATUS = { free: 0, mayor: 1, garrison: 2, marching: 3, captured: 4, returning: 5, farming: 8 };
  static isMayor(h) { return Number(h && h.status) === 1; }

  // Which attribute this hero is built around — that's where new points should go.
  static dominant(h) {
    const scores = ['power', 'management', 'stratagem'].map((k) => ({ k, v: Game.attrValue(h, k) }));
    scores.sort((a, b) => b.v - a.v);
    return scores[0].k;
  }

  // Why the client would not offer this action on this hero, or null. A prisoner
  // we hold (status 4) is offered Release (and Persuade) and nothing else; Fire
  // is for anyone else (HeroProperties.as:1195-1218), and the mayor's window
  // offers only idle heroes beside the sitting mayor (HerosMansion.as:448-467).
  // Releasing a captured hero from the captor's side loses it — its owner
  // brings it home with a Stone of Finding — so release is never sent for one of
  // our own heroes. The script and the console both ask this.
  static heroActionRefusal(action, h) {
    if (!h) return 'hero not found in this city';
    const st = Number(h.status), prisoner = st === 4;
    if (action === 'release' && !prisoner) return `${h.name} is not a prisoner (${Game.STATUS_WORD[st] || `status ${h.status}`}) — release only dismisses a prisoner you hold; fire dismisses your own hero`;
    if (action === 'fire' && prisoner) return `${h.name} is a prisoner you hold — a prisoner is dismissed with release, not fire`;
    if (action === 'mayor') {
      if (prisoner) return `${h.name} is a prisoner you hold — only your own heroes can be mayor`;
      if (st !== 0 && st !== 1) return `${h.name} is ${Game.STATUS_WORD[st] || `status ${h.status}`}, not idle at home — only an idle hero can be made mayor`;
    }
    return null;
  }
  static STATUS_WORD = { 0: 'idle', 1: 'mayor', 2: 'guarding a valley', 3: 'marching', 4: 'a prisoner', 5: 'returning', 8: 'farming' };

  // What the next inn refresh would cost. It spends a Hero Hunting when one is
  // held (Tavern.as:548); with none the client offers to buy one and sends the
  // same command, and the server charges game coins (Tavern.as:473-479, 515-528).
  // held is null when the inventory has never loaded.
  static HERO_HUNTING = 'consume.refreshtavern.1';
  innRefreshCost() {
    const items = this.player && this.player.items;
    const held = Array.isArray(items) ? Number((items.find((i) => i.id === Game.HERO_HUNTING) || {}).count || 0) : null;
    return {
      held, item: held > 0,
      text: held > 0 ? `spends 1 Hero Hunting (${held} held)`
        : held === 0 ? 'no Hero Hunting held, so the server charges game coins'
          : 'the inventory has not loaded, so it cannot tell whether this costs a Hero Hunting or game coins',
    };
  }

  // One hero, by its name. "any" and an empty name used to mean the city's first
  // hero, so `fire any`, `release any` or a bare `levelup attack` acted on
  // whichever hero happened to be listed first; now only a real name matches.
  // (Marches pick "any" through pickHero, which is a different thing.)
  findHero(castle, name) {
    const heros = (castle && castle.heros) || [];
    const want = String(name == null ? '' : name).trim().toLowerCase();
    if (!want) return null;
    return heros.find((h) => (h.name || '').toLowerCase() === want) || null;
  }

  // Re-read a hero after an action (the server pushes server.HeroUpdate).
  async heroAfter(castle, heroId, ms = 1200) {
    await new Promise((r) => setTimeout(r, ms));
    return (castle.heros || []).find((h) => h.id === heroId) || null;
  }

  // ---- town hall: production allocation & tax ----
  // Each rate is a percentage. Labour assigned to fields comes out of population,
  // so dropping rates to 0 frees the whole city for troop training.
  productionData(castleId) { return this.req('interior.getResourceProduceData', { castleId }); }
  setProduction(castleId, { food = 0, wood = 0, stone = 0, iron = 0 }) {
    return this.req('interior.modifyCommenceRate', { castleId, foodrate: food, woodrate: wood, stonerate: stone, ironrate: iron });
  }
  // "Adjust tax rate" is bit 16 of the security code (AdjustmentCess.as:470).
  setTax(castleId, tax) { return this.reqProtected('interior.modifyTaxRate', { castleId, tax }); }

  // ---- town hall: comforting and levies (goal-upkeep.js) ----
  // interior.pacifyPeople {castleId, typeId}: 1 disaster relief, 2 praying,
  // 3 blessing, 4 population raising (InteriorCommands.as:87-98, the
  // PacifyPeopleView.as combo box and comChange :443-472).
  pacify(castleId, typeId) { return this.req('interior.pacifyPeople', { castleId, typeId }); }
  // interior.taxation {castleId, typeId} is the Levy window: 1 gold, 2 food,
  // 3 lumber, 4 stone, 5 iron, and every levy costs the city 20 loyalty
  // (InteriorCommands.as:41-52, CollectionMaterialsView.as:398-414 and 835).
  levy(castleId, typeId) { return this.req('interior.taxation', { castleId, typeId }); }

  // ---- warehouse protection (goal-upkeep.js warehousepolicy) ----
  // city.getStoreList {castleId} -> {totalCap, storeBeans: [{storeTypeId, storePercent, ...}]},
  // storeTypeId 1 food, 2 lumber, 3 stone, 4 iron; city.modifyStorePercent sends
  // the four percentages together (CityCommands.as:55-69 and 122-132;
  // WareHouse.as:556 and 884-941).
  storeList(castleId) { return this.req('city.getStoreList', { castleId }); }
  setStorePercent(castleId, { food = 0, wood = 0, stone = 0, iron = 0 }) {
    return this.req('city.modifyStorePercent', { castleId, foodrate: food, woodrate: wood, stonerate: stone, ironrate: iron });
  }

  // ---- the medic camp (goal-upkeep.js healing) ----
  // army.getInjuredTroop {castleId} answers with a bare CommandResponse; the
  // camp itself comes as a server.InjuredTroopUpdate push {castleId, goldNeed,
  // troop} (ArmyCommands.as:118-128; HospitalWin.as:228-252 and 557). Every
  // push is kept here, asked for or not: injured[castleId] = {at, goldNeed,
  // troop, total}, `at` on this machine's clock.
  applyInjuredUpdate(data) {
    if (!data || data.castleId === undefined || data.castleId === null) return;
    const troop = data.troop && typeof data.troop === 'object' ? data.troop : {};
    let total = 0;
    for (const v of Object.values(troop)) { const x = Number(v); if (Number.isFinite(x) && x > 0) total += x; }
    this.injured = this.injured || {};
    this.injured[Number(data.castleId)] = { at: Date.now(), goldNeed: Number(data.goldNeed || 0), troop, total };
  }

  // Ask for a city's camp and wait a moment for the push, which may trail the
  // reply. camp is null when no push came: the server said nothing about any
  // wounded there.
  async readInjured(castleId, graceMs = 2000) {
    const cid = Number(castleId);
    const asked = Date.now();
    const fresh = () => { const c = this.injured && this.injured[cid]; return c && c.at >= asked ? c : null; };
    // connect() applies this push for a live session; listening here as well
    // means a Game that was never connected (a script run against a bare Game,
    // the offline suites) still hears the camp while this call waits.
    const c = this.c;
    const on = (cmd, data) => { if (cmd === 'server.InjuredTroopUpdate' && data && Number(data.castleId) === cid) this.applyInjuredUpdate(data); };
    if (c && typeof c.on === 'function') c.on('cmd', on);
    try {
      const r = await this.req('army.getInjuredTroop', { castleId: cid });
      if (!r || r.ok !== 1) return r || { ok: 0, errorMsg: 'no reply to army.getInjuredTroop' };
      // a reply that carries the camp itself counts the same as the push
      if (r.troop && typeof r.troop === 'object') this.applyInjuredUpdate({ ...r, castleId: cid });
      while (!fresh() && Date.now() - asked < graceMs) await new Promise((res) => setTimeout(res, 100));
      return { ok: 1, camp: fresh() };
    } finally { if (c && typeof c.off === 'function') c.off('cmd', on); }
  }

  // army.cureInjuredTroop {castleId} heals the whole camp. The client sends it
  // only when goldNeed is within the city's gold (HospitalWin.as:490-504).
  cureInjured(castleId) { return this.req('army.cureInjuredTroop', { castleId }); }

  // ---- construction ----
  async req(cmd, data, ms = 12000) {
    this.c.send(cmd, data);
    const r = await this.c.await([cmd], ms);
    return r.data;
  }

  // city.constructCastle(castleId, fieldId, isTroopBack) -- turns an owned flat into a city
  constructCastle(castleId, fieldId, isTroopBack = false) {
    return this.req('city.constructCastle', { castleId, fieldId, isTroopBack });
  }

  newBuilding(castleId, positionId, buildingType) {
    return this.req('castle.newBuilding', { castleId, positionId, buildingType });
  }

  // Take a building down ONE level; at level 0 it is gone and its plot frees.
  // The client's "demolish completely" is this order finished at once with the
  // paid player.destroy.1.a item (DestrctChoiceWin.as).
  destructBuilding(castleId, positionId) {
    return this.req('castle.destructBuilding', { castleId, positionId });
  }

  upgradeBuilding(castleId, positionId) {
    return this.req('castle.upgradeBuilding', { castleId, positionId });
  }

  checkUpgrade(castleId, positionId) {
    return this.req('castle.checkOutUpgrade', { castleId, positionId });
  }

  // Conditions for constructing a NEW building of this type.
  async buildConditions(castleId, typeId) {
    const d = await this.req('castle.getAvailableBuildingBean', { castleId, typeId });
    const entry = (d.builingList || []).find((x) => Number(x.typeId) === Number(typeId)) || (d.builingList || [])[0];
    return entry ? entry.conditionBean : null;
  }

  // What one construction order needs, read the way the client's own windows
  // read it before they offer the button (CastleCommands.as:103-127):
  //   a new building   castle.getAvailableBuildingBean {castleId, typeId}
  //                    -> builingList[] (sic) {typeId, conditionBean}
  //   the next level   castle.checkOutUpgrade {castleId, positionId}
  //                    -> conditionBean (BuildingInfoWin.sendCheckRequest)
  // Returns { cond } — null when the reply names none — or { error }. Only
  // `req` is used, so the goal engine can run it on a stand-in game too.
  async constructionCondition(castleId, { kind, typeId, positionId }) {
    try {
      if (kind === 'upgrade') {
        const r = await this.req('castle.checkOutUpgrade', { castleId, positionId });
        if (!r || r.ok !== 1) return { error: (r && r.errorMsg) || 'no reply' };
        return { cond: r.conditionBean || null };
      }
      const r = await this.req('castle.getAvailableBuildingBean', { castleId, typeId });
      if (!r || r.ok !== 1) return { error: (r && r.errorMsg) || 'no reply' };
      const list = r.builingList || [];
      const entry = list.find((x) => Number(x.typeId) === Number(typeId)) || (list.length === 1 ? list[0] : null);
      return { cond: (entry && entry.conditionBean) || null };
    } catch (e) {
      return { error: e.message };
    }
  }

  // Every list read also notes what is being researched (noteResearchList).
  async researchList(castleId) {
    const r = await this.req('tech.getResearchList', { castleId });
    this.noteResearchList(castleId, r);
    return r;
  }

  // Queues: what is actually being made right now, per building.
  troopQueue(castleId) { return this.req('troop.getProduceQueue', { castleId }); }
  wallQueue(castleId) { return this.req('fortifications.getProduceQueue', { castleId }); }
  idleBarracks(castleId) { return this.req('troop.checkIdleBarrack', { castleId }); }
  // One batch out of a queue, by the queueId the queue reply gives it
  // (Barrack.doCancel, Wall.doCancel). The reply names neither the batch nor the
  // city, so each command waits in its own lane. See queue-cancel.js.
  cancelTroop(castleId, positionId, queueId) {
    return this.lane('troop.cancelTroopProduce', () => this.req('troop.cancelTroopProduce', { castleId, positionId, queueId }));
  }
  cancelWall(castleId, queueId) {
    return this.lane('fortifications.cancelFortificationProduce',
      () => this.req('fortifications.cancelFortificationProduce', { castleId, queueId }));
  }

  // Market: our own offers, and purchases still in transit.
  myTrades(castleId) { return this.req('trade.getMyTradeList', { castleId }); }
  transitTrades(castleId) { return this.req('trade.getTransingTradeList', { castleId }); }

  // Plots taken, and the Town Hall level that decides how many field plots are
  // open. A finished demolition is pushed as a status-0, level-0 bean
  // (UIUtil.isBuildingDestroy): that plot is empty, whatever the list says. A
  // building waiting in the construction queue has its plot spoken for.
  static plotsInUse(castle) {
    const standing = (castle.buildings || []).filter((b) => !(Number(b.status || 0) === 0 && Number(b.level || 0) === 0));
    const th = standing.find((b) => Number(b.typeId) === C.TOWN_HALL);
    return {
      used: new Set([...standing, ...(castle.buildingQueues || [])].map((b) => Number(b.positionId))),
      townHall: th ? Number(th.level || 0) : 1,
    };
  }

  // How many plots are left, inside the walls and out. Uses the same slot
  // ranges as freeSlot() below rather than a second set of assumptions.
  // Outside, `total` is what the Town Hall has opened, not all 40.
  freeSlots(castle) {
    const { used, townHall } = Game.plotsInUse(castle);
    const span = ({ from, to }) => {
      let free = 0, total = 0;
      for (let p = from; p <= to; p++) { total++; if (!used.has(p)) free++; }
      return { free, total, used: total - free };
    };
    return {
      inside: span(C.plotRange(false)),
      outside: span(C.plotRange(true, townHall)),
    };
  }
  // The reply carries the tech as it now stands (ResearchResponse.tech).
  async research(castleId, techId) {
    const r = await this.req('tech.research', { castleId, techId });
    if (r && r.ok === 1) this.noteResearch(castleId, { typeId: techId, ...(r.tech || {}), upgradeing: true });
    return r;
  }

  // ---- free finishes and speed-ups (speedups.js) ----
  // castle.speedUpBuildCommand {castleId, positionId, itemId} (CastleCommands.as:175-187)
  // and tech.speedUpResearch {castleId, itemId} (TechCommand.as:84-95). The
  // itemId C.FREE_SPEED.item costs nothing on a job whose preset time is five
  // minutes or less. Neither reply names the city or the job, so each command
  // waits in its own lane.
  speedUpBuild(castleId, positionId, itemId) {
    return this.lane('castle.speedUpBuildCommand',
      () => this.req('castle.speedUpBuildCommand', { castleId, positionId, itemId }));
  }

  async speedUpResearch(castleId, itemId) {
    const r = await this.lane('tech.speedUpResearch', () => this.req('tech.speedUpResearch', { castleId, itemId }));
    // Finished, or still running with a new end time (ResearchResponse.tech).
    if (r && r.ok === 1) this.noteResearch(castleId, r.tech && r.tech.upgradeing ? r.tech : null);
    return r;
  }

  // What each city is researching, as the last research list or research reply
  // showed it. The server pushes the END of a research (server.ResearchCompleteUpdate,
  // which carries only the castleId, and clears the city here: connect) but
  // never its start, and the free finish must not read the list every tick to
  // look for one, so every read and every start leaves its answer here: the
  // console's Research tab, the script's `research` line, the research goal
  // (goal-research.js, which also asks it what the other cities research).
  noteResearch(castleId, bean) {
    const map = (this._research = this._research || new Map());
    const cid = Number(castleId);
    if (!bean || !bean.upgradeing) { map.delete(cid); return; }
    const level = bean.level === undefined || bean.level === null || bean.level === '' ? null : Number(bean.level);
    map.set(cid, {
      typeId: Number(bean.typeId), level: Number.isFinite(level) ? level : null,
      // on the server's clock, like the start and end times
      startTime: Number(bean.startTime || 0), endTime: Number(bean.endTime || 0), seenAt: this.now(),
    });
  }

  // The list names, on the one tech being researched in a city, that city
  // (AvailableResearchListBean.castleId; BottomToolBar.onRefreshResearchList
  // shows the one whose castleId is the city in view). A list that shows none
  // for the city it was read for means nothing runs there.
  noteResearchList(castleId, r) {
    if (!r || (r.ok !== undefined && r.ok !== 1)) return;
    const beans = r.acailableResearchBeans || r.availableResearchBeans || [];
    let here = null;
    for (const b of beans) {
      if (!b || !b.upgradeing || b.castleId === undefined || b.castleId === null) continue;
      if (Number(b.castleId) === Number(castleId)) here = b;
      else this.noteResearch(b.castleId, b);
    }
    this.noteResearch(castleId, here);
  }

  runningResearch(castleId) {
    return (this._research && this._research.get(Number(castleId))) || null;
  }

  // A research has ended in that city: server.ResearchCompleteUpdate carries
  // only its castleId (ResearchCompleteUpdate.as), and the client's research
  // window reads the list again on it (Technology.onResearchComplete). Nothing
  // runs there now, so the research goal reads the list for its next decision
  // rather than waiting out the end time.
  applyResearchComplete(data) {
    if (!data || data.castleId === undefined || data.castleId === null) return;
    this.noteResearch(data.castleId, null);
  }

  findBuildings(castle, typeId) {
    return (castle.buildings || []).filter((b) => b.typeId === typeId);
  }

  // Lowest free slot of the right kind, or null when the castle is full.
  freeSlot(castle, outside) {
    const { used, townHall } = Game.plotsInUse(castle);
    const { from, to } = C.plotRange(!!outside, townHall);
    for (let p = from; p <= to; p++) if (!used.has(p)) return p;
    return null;
  }

  // Turn a conditionBean into readable "what's missing" lines. Give the castle
  // and the bank is checked too, as the client's build window does before it
  // enables the button (UIUtil.isConditionMatch + isResourceConditionMatch).
  unmet(cond, castle = null) {
    const items = this.player && Array.isArray(this.player.items) ? this.player.items : null;
    return Game.unmetOf(cond, { resource: castle ? castle.resource || null : null, items });
  }

  // The same, pure. ConditionBean.as: buildings[] {typeId, level, curLevel,
  // successFlag}; techs[] {id, level, curLevel, successFlag} — the tech's key
  // is `id`, not typeId (ConditionDependTechBean.as:32-34), which is why this
  // used to print "tech undefined"; items[] {id, num, curNum, successFlag}
  // (ConditionDependItemBean.as); and the cost: food, wood, stone, iron, gold,
  // population. `items` is the inventory (player.items, kept current by
  // server.ItemUpdate) and beats the bean's flag, which is as old as the read;
  // without it the flag decides. The bank is checked only when `resource`
  // (castle.resource) is given: food/wood/stone/iron are {amount}, gold a number.
  static unmetOf(cond, { resource = null, items = null } = {}) {
    if (!cond) return [];
    const out = [];
    const num = (x) => Number(x || 0);
    const fmt = (x) => Math.round(num(x)).toLocaleString('en-US');
    for (const b of cond.buildings || []) {
      if (b.successFlag) continue;
      const typeId = num(b.typeId);
      const name = (C.BUILDING_BY_ID[typeId] || {}).name || `building ${typeId}`;
      out.push({ kind: 'building', typeId, name, need: num(b.level), have: num(b.curLevel), text: `${name} level ${num(b.level)} (you have ${num(b.curLevel)})` });
    }
    for (const t of cond.techs || []) {
      if (t.successFlag) continue;
      const id = num(t.id ?? t.typeId);
      const name = (C.TECH_BY_ID[id] || {}).name || `tech ${id}`;
      out.push({ kind: 'tech', id, typeId: id, name, need: num(t.level), have: num(t.curLevel), text: `research ${name} level ${num(t.level)} (you have ${num(t.curLevel)})` });
    }
    for (const it of cond.items || []) {
      const need = Math.max(1, num(it.num));
      const held = items ? Game.countOf(items, it.id) : (it.successFlag ? need : num(it.curNum));
      if (held >= need) continue;
      const name = Game.itemName(it.id);
      out.push({ kind: 'item', id: String(it.id), name, need, have: held, text: `${need} ${name} (you have ${held})` });
    }
    if (resource) {
      for (const key of ['food', 'wood', 'stone', 'iron', 'gold']) {
        const need = num(cond[key]);
        const have = Game.bankOf(resource, key);
        if (need > 0 && need > have) out.push({ kind: 'resource', key, need, have, text: `${key} ${fmt(need)} (you have ${fmt(have)})` });
      }
      // what is free once the fields and the builder are staffed, as troop
      // training counts it (engine.js idleOf)
      const pop = num(cond.population);
      const idle = Math.max(0, num(resource.curPopulation) - num(resource.workPeople) - num(resource.buildPeople));
      if (pop > 0 && idle < pop) out.push({ kind: 'population', need: pop, have: idle, text: `idle population ${fmt(pop)} (you have ${fmt(idle)})` });
    }
    return out;
  }

  // castle.resource: food/wood/stone/iron are ResourceOutputBeans {amount, ...};
  // gold is a plain number (UIUtil.isResourceConditionMatch reads both so).
  static bankOf(resource, key) {
    const v = resource && resource[key];
    return Number((v && typeof v === 'object' ? v.amount : v) || 0);
  }

  static countOf(items, id) {
    const it = (items || []).find((x) => x && String(x.id) === String(id));
    return it ? Number(it.count || 0) : 0;
  }

  // An item's name from the catalogue (items.js), or the few the engine talks
  // about itself, or its id.
  static ITEM_NAMES = { 'consume.blueprint.1': "Michelangelo's Script" };
  static itemName(id) {
    try {
      const d = require('./items').catalogue().get(String(id));
      if (d && d.name) return d.name;
    } catch { /* no catalogue */ }
    return Game.ITEM_NAMES[id] || String(id);
  }

  // ---- market ----
  // A market reply names its command and nothing else: no castle, no trade id,
  // and a search does not even say which resource it answers. Two callers with
  // the same command in flight would each take the first reply — the console's
  // Market panel reading food while the sniper reads wood gets wood's prices.
  // So each market READ queues in its own lane, whoever is asking; a caller
  // that pipelines a batch of reads holds the lane until every reply is in.
  // The writes are pipelined through `pipe` below, never through a lane — and
  // nothing may send trade.newTrade / trade.cancelTrade around it, or its replies
  // would be taken from the pipe's requests.
  lane(cmd, fn) {
    this._lanes = this._lanes || new Map();
    const run = (this._lanes.get(cmd) || Promise.resolve()).then(() => fn());
    this._lanes.set(cmd, run.catch(() => {}));
    return run;
  }

  // Market WRITES are pipelined instead of queued: each goes out the moment it
  // is asked for, and each reply goes to the oldest request still waiting for
  // one. That is sound because the server works through them strictly in the
  // order it got them — measured 2026-09-18 (market-probe.js): orders sent
  // together were created with rising trade ids in exactly the order sent — and
  // a write's reply carries nothing else to match on anyway ({packageId, ok}).
  // It matters because a lone order costs TWO round trips (~527 ms from South
  // Africa), while five sent together all landed within 727 ms: queued in one
  // lane, an account's cities waited on each other's round trips; pipelined,
  // they don't.
  //
  // A reply that never comes would shift every later reply onto the wrong
  // request. So once a request times out, nothing new is sent until everything
  // already in flight has been answered or has timed out as well — the pipe
  // drains and starts clean — and the requests asked for meanwhile go out then.
  // Timeouts are taken strictly oldest-first, the order the replies are owed.
  //
  // At most PIPE_LIMIT writes are in flight per account, across all its cities
  // and both commands; the rest wait here, in order, and go out as replies come
  // in. The server works through an account's commands roughly one at a time
  // (~4-5 orders a second), so 90 orders sent at once from nine cities sat in
  // its queue for 20-30 s: replies came after our timeout, and the heartbeat,
  // queued behind them, failed and cycled the socket — Lord06 was down 28% of
  // 2026-09-18 that way. Twenty in flight kept the same throughput (Lord07,
  // two cities) without the queue. A write's timeout starts when it is SENT.
  static PIPE_LIMIT = Math.max(1, Number(process.env.OTTO_PIPE_LIMIT) || 20);
  pipeInFlight() {
    let n = 0;
    for (const p of (this._pipes || new Map()).values()) n += p.waiting.length;
    return n;
  }
  pipeQueued() { return (this._pipeQ || []).length; }
  pipe(cmd, data, ms = 12000) {
    // Only on a connection that says every reply reaches it as a 'cmd' event, in
    // order (evony.js sets `pipelines`), and only when req is the Game's own: a
    // test that stubs req, or answers through await alone, gets exactly what it
    // had before — one at a time through req.
    if (!this.c || this.c.pipelines !== true || typeof this.c.send !== 'function'
      || Object.prototype.hasOwnProperty.call(this, 'req')) {
      return this.lane(cmd, () => this.req(cmd, data, ms));
    }
    this._pipes = this._pipes || new Map();
    let p = this._pipes.get(cmd);
    if (!p) {
      p = { waiting: [], held: [], draining: false, timer: null };
      this._pipes.set(cmd, p);
      this.c.on('cmd', (name, d) => {
        if (name !== cmd || !p.waiting.length) return;
        const head = p.waiting.shift();
        if (this.c.noteReply) this.c.noteReply();
        head.resolve(d);
        this._pipeArm(p, cmd);
        this._pipePump();
      });
    }
    this._pipeQ = this._pipeQ || [];
    if (!this._pipeCloseHooked) {
      // a write still waiting its turn when the socket goes would wait forever
      this._pipeCloseHooked = true;
      this.c.on('log', (m) => {
        if (!/^socket closed/.test(m)) return;
        for (const q of this._pipeQ.splice(0)) q.entry.reject(new Error(`no reply to ${q.cmd} (the connection closed before it was sent)`));
      });
    }
    return new Promise((resolve, reject) => {
      const entry = { data, ms, resolve, reject, deadline: 0 };
      if (p.draining) { p.held.push(entry); return; }
      if (this._pipeQ.length || this.pipeInFlight() >= Game.PIPE_LIMIT) { this._pipeQ.push({ p, cmd, entry }); this._pipePump(); return; }
      this._pipeSend(p, cmd, entry);
    });
  }
  // Send what waits, oldest first, while there is room; a pipe that is draining
  // takes its next write only once it is clean again.
  _pipePump() {
    const q = this._pipeQ || [];
    for (let i = 0; i < q.length && this.pipeInFlight() < Game.PIPE_LIMIT;) {
      if (q[i].p.draining) { i++; continue; }
      const { p, cmd, entry } = q.splice(i, 1)[0];
      this._pipeSend(p, cmd, entry);
    }
  }
  // Every request `pipe` was asked for, in order; a request that got no reply
  // comes back as { ok: 'noreply', errorMsg } rather than failing the batch.
  pipeMany(cmd, list, ms = 12000) {
    return Promise.all(list.map((d) => this.pipe(cmd, d, ms).catch((e) => ({ ok: 'noreply', errorMsg: e.message }))));
  }
  _pipeSend(p, cmd, entry) {
    try { this.c.send(cmd, entry.data); } catch (e) { entry.reject(e); return; }
    entry.deadline = Date.now() + entry.ms;
    p.waiting.push(entry);
    if (!p.timer) this._pipeArm(p, cmd);
  }
  // One timer, always for the OLDEST request: that is the reply owed first.
  _pipeArm(p, cmd) {
    clearTimeout(p.timer);
    p.timer = null;
    if (!p.waiting.length) {
      if (p.draining) {
        p.draining = false;
        // what was held while draining goes first, then the limit applies again
        const held = p.held.splice(0).map((entry) => ({ p, cmd, entry }));
        this._pipeQ = [...held, ...(this._pipeQ || [])];
      }
      this._pipePump();
      return;
    }
    const head = p.waiting[0];
    p.timer = setTimeout(() => {
      p.timer = null;
      if (p.waiting[0] !== head) return this._pipeArm(p, cmd);
      p.waiting.shift();
      p.draining = true;
      if (this.c.noteTimeout) this.c.noteTimeout(cmd);
      head.reject(new Error('no reply to ' + cmd + (this.c.missedReplies >= 3 ? ' (server is ignoring this account — rate limited)' : '')));
      this._pipeArm(p, cmd);
      this._pipePump();
    }, Math.max(0, head.deadline - Date.now()));
  }

  // NOTE: price is a STRING on the wire (TradeCommands.as newTrade param5:String)
  async newTrade({ castleId, resource, type, amount, price }) {
    const resType = C.TRADE_RES[resource];
    const tradeType = C.TRADE_TYPE[type];
    if (resType === undefined) throw new Error('trade resource must be food/wood/stone/iron, got ' + resource);
    if (tradeType === undefined) throw new Error('trade type must be buy/sell');
    // 30 s, not 12: with ~100 orders in flight on one account the server works
    // through fills at its own pace, and replies came back LATE, not lost — a
    // 12 s timeout drained the pipe on replies that were on their way, stalling
    // the whole account 12-30 s at a time (seen live 2026-09-18, Lord06/Lord07).
    return this.pipe('trade.newTrade', { castleId, resType, tradeType, amount, price: String(price) }, 30000);
  }

  // The top of one resource's book (the client shows five a side: Market.as
  // "the five highest buy offers" / "the five lowest sell offers"). Every read,
  // whoever asks — the console's Market panel, holidaysnipe, goal-trade — leaves
  // its answer in marketBook(), so the market goals can price a plan without a
  // read of their own each time.
  async searchTrades(resource) {
    const d = await this.lane('trade.searchTrades', () => this.req('trade.searchTrades', { resType: C.TRADE_RES[resource] }));
    if (d && (d.ok === undefined || d.ok === 1) && (Array.isArray(d.sellers) || Array.isArray(d.buyers))) {
      this._books = this._books || {};
      this._books[resource] = { at: Date.now(), sellers: d.sellers || [], buyers: d.buyers || [] };
    }
    return d;
  }

  // { at, sellers, buyers } as the last read found it, or null.
  marketBook(resource) { return (this._books && this._books[resource]) || null; }

  myTrades(castleId) {
    return this.lane('trade.getMyTradeList', () => this.req('trade.getMyTradeList', { castleId }));
  }

  // pipelined like newTrade: a cancel costs the same two round trips alone
  cancelTrade(castleId, tradeId) {
    return this.pipe('trade.cancelTrade', { castleId, tradeId }, 30000);
  }

  // ---- reports ----
  // reportType is ObjConstants' 0 trade, 1 army, 2 other. A type it does not
  // know is refused: it used to fall back to 0, so `cleanreports armies` (not
  // `army`) deleted every trade report.
  // A report reply names its command and nothing else, and the console's
  // Reports window and the reportstokeep goal (goal-reports.js) both ask, so
  // each report command waits in its own lane, as the market's do.
  // A list or a delete on an account with hundreds of thousands of reports is
  // slow on the server's side, and behind a trading account's market orders it
  // waits longer still: 12 s gave up on replies that were on their way
  // (Lord06 2026-09-20), and a late reply is then taken for the next request's.
  static REPORT_WAIT = 30000;
  async reportList(type = 'trade', pageNo = 1, pageSize = 50) {
    const reportType = C.REPORT_TYPE[type];
    if (reportType === undefined) throw new Error(`unknown report type "${type}" — trade, army or other`);
    return this.lane('report.receiveReportList',
      () => this.req('report.receiveReportList', { pageNo, pageSize, reportType }, Game.REPORT_WAIT));
  }

  deleteReports(ids) {
    // ReportCommands.as: idStr
    return this.lane('report.deleteReport', () => this.req('report.deleteReport', { idStr: ids.join(',') }, Game.REPORT_WAIT));
  }

  async cleanReports(type = 'trade') {
    let removed = 0;
    for (let guard = 0; guard < 40; guard++) {
      const page = await this.reportList(type, 1, 50);
      const ids = (page.reports || []).map((r) => r.id);
      if (!ids.length) break;
      await this.deleteReports(ids);
      removed += ids.length;
      this.log(`  deleted ${ids.length} ${type} report(s)`);
      if (!page.totalPage || page.totalPage <= 1) {
        const after = await this.reportList(type, 1, 50);
        if (!(after.reports || []).length) break;
      }
    }
    return removed;
  }

  // report.markAsRead is how the client OPENS a report (PublicReportCanvas
  // .showDetail): the reply is a ReportResponse whose `report` is the full
  // ReportBean, XML `content` included — receiveReportList is only the index.
  readReport(reportId) {
    const ask = () => this.req('report.markAsRead', { reportId: Number(reportId) });
    // (an object that borrows Game's methods without its lanes still reads)
    return typeof this.lane === 'function' ? this.lane('report.markAsRead', ask) : ask();
  }
  // The "mark as read" button: ids comma-joined (PublicReportCanvas.onMarkAsReadSelected).
  markReportsRead(ids) { return this.req('report.readOverReport', { reportIds: ids.join(',') }); }

  // ---- quests ----
  // QuestCommands.as, as the game's own Quests window asks (QuestWin.as): the
  // tab's quest types (:1649-1650), one type's quests (:641), and the claim
  // button (:1293). A quest reply names only its command -- not the tab, the
  // type or the quest it answers -- so each waits in its own lane, as the
  // market and report reads do. The completequests script command sends the
  // same three (script-cmd-account.js).
  questTypes(castleId, type) {
    return this.lane('quest.getQuestType', () => this.req('quest.getQuestType', { castleId: Number(castleId), type: Number(type) }));
  }
  questList(castleId, typeId) {
    return this.lane('quest.getQuestList', () => this.req('quest.getQuestList', { castleId: Number(castleId), typeId: Number(typeId) }));
  }
  questAward(castleId, questId) {
    return this.lane('quest.award', () => this.req('quest.award', { castleId: Number(castleId), questId: Number(questId) }));
  }

  // ---- mail ----
  // MailCommands.as. `type` is the box — MailConstants MAIL_RECEIVE 1 (inbox),
  // MAIL_SYSTEM 2, MAIL_SEND 3. Replies: MailListResponse {pageNo, totalPage,
  // mails: [MailBean]}, MailResponse (one mail with its content), and a plain
  // CommandResponse {ok, errorMsg} for delete and send.
  mailList(type, pageNo = 1, pageSize = 10) { return this.req('mail.receiveMailList', { pageNo, type, pageSize }); }
  // Opening a mail IS reading it: MailWin.onSeeAbout sends only this.
  readMail(mailId) { return this.req('mail.readMail', { mailId: Number(mailId) }); }
  markMailRead(ids) { return this.req('mail.readOverMailList', { mailIds: ids.join(',') }); }
  // NOTE: lowercase, underscored `str_mailid` — MailCommands.deleteMail.
  deleteMail(ids) { return this.req('mail.deleteMail', { str_mailid: ids.join(',') }); }
  sendMail(username, title, content) { return this.req('mail.sendMail', { username, title, content }); }

  // Cheap read used as a heartbeat — keeps the socket warm and proves it is alive.
  async ping(ms = 10000) {
    const name = (this.player && this.player.playerInfo && this.player.playerInfo.userName) || 'x';
    this.c.send('common.getPlayerInfoByName', { userName: name });
    await this.c.await(['common.getPlayerInfoByName'], ms);
    return true;
  }

  get alive() { return !!(this.c && this.c.sock && !this.c.sock.destroyed); }
  get idleMs() { return Date.now() - (this.c && this.c.lastFrameAt ? this.c.lastFrameAt : 0); }

  close() { if (this.c) this.c.close(); }
}

module.exports = { Game };
