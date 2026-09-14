'use strict';
// High-level game operations on top of the raw client.
const { EvonyClient, getServerConfig } = require('./evony');
const C = require('./constants');

class Game {
  constructor(log = () => {}) {
    this.log = log;
    this.c = null;
    this.player = null;
    this.castles = [];
    this.marchSkillParam = 100;
    this.serverOffset = 0;     // serverNow - localNow, in ms
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

  async connect(server, email, password, proxy = null) {
    const cfg = await getServerConfig(server);
    this.log(`${server} -> ${cfg.host}:${cfg.port} (${cfg.state})${proxy ? ' via ' + proxy.label : ''}`);
    this.proxy = proxy;
    this.c = new EvonyClient();
    this.c.on('log', (m) => this.log(m));
    await this.c.connect(cfg.host, cfg.port, proxy);

    const tLogin = Date.now();
    const lr = await this.c.login(email, password);
    const rtt = Date.now() - tLogin;
    if (!lr || !lr.data || lr.data.ok !== 1) throw new Error('login failed: ' + JSON.stringify(lr && lr.data));
    this.player = lr.data.player;
    this.castles = this.player.castles || [];
    this.log(`logged in as ${this.player.playerInfo.userName} - ${this.castles.length} castle(s)`);

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

  async newArmy(castleId, bean) {
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
  fireHero(castleId, heroId) { return this.req('hero.fireHero', { castleId, heroId }); }
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
  setTax(castleId, tax) { return this.req('interior.modifyTaxRate', { castleId, tax }); }

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
  // which carries only the castleId) but never its start, and the free finish
  // must not read the list every tick to look for one, so every read and every
  // start leaves its answer here: the console's Research tab, the script's
  // `research` line, any research goal that reads the list.
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
  // So each market command queues in its own lane, whoever is asking. A caller
  // that pipelines a batch (holiday-snipe.js) holds the lane until every reply
  // of the batch is in.
  lane(cmd, fn) {
    this._lanes = this._lanes || new Map();
    const run = (this._lanes.get(cmd) || Promise.resolve()).then(() => fn());
    this._lanes.set(cmd, run.catch(() => {}));
    return run;
  }

  // NOTE: price is a STRING on the wire (TradeCommands.as newTrade param5:String)
  async newTrade({ castleId, resource, type, amount, price }) {
    const resType = C.TRADE_RES[resource];
    const tradeType = C.TRADE_TYPE[type];
    if (resType === undefined) throw new Error('trade resource must be food/wood/stone/iron, got ' + resource);
    if (tradeType === undefined) throw new Error('trade type must be buy/sell');
    return this.lane('trade.newTrade', () => this.req('trade.newTrade', { castleId, resType, tradeType, amount, price: String(price) }));
  }

  searchTrades(resource) {
    return this.lane('trade.searchTrades', () => this.req('trade.searchTrades', { resType: C.TRADE_RES[resource] }));
  }

  myTrades(castleId) {
    return this.lane('trade.getMyTradeList', () => this.req('trade.getMyTradeList', { castleId }));
  }

  cancelTrade(castleId, tradeId) {
    return this.lane('trade.cancelTrade', () => this.req('trade.cancelTrade', { castleId, tradeId }));
  }

  // ---- reports ----
  async reportList(type = 'trade', pageNo = 1, pageSize = 50) {
    this.c.send('report.receiveReportList', { pageNo, pageSize, reportType: C.REPORT_TYPE[type] ?? 0 });
    const r = await this.c.await(['report.receiveReportList'], 12000);
    return r.data;
  }

  async deleteReports(ids) {
    this.c.send('report.deleteReport', { idStr: ids.join(',') });   // ReportCommands.as: idStr
    const r = await this.c.await(['report.deleteReport'], 12000);
    return r.data;
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
  readReport(reportId) { return this.req('report.markAsRead', { reportId: Number(reportId) }); }
  // The "mark as read" button: ids comma-joined (PublicReportCanvas.onMarkAsReadSelected).
  markReportsRead(ids) { return this.req('report.readOverReport', { reportIds: ids.join(',') }); }

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
