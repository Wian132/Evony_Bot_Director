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
    this.c.on('cmd', (cmd, data) => {
      if (cmd !== 'server.HeroUpdate' || !data || !data.hero) return;
      const c = this.castles.find((x) => this.castleId(x) === data.castleId);
      if (!c) return;
      c.heros = c.heros || [];
      const i = c.heros.findIndex((h) => h.id === data.hero.id);
      if (i >= 0) c.heros[i] = data.hero; else c.heros.push(data.hero);
    });

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

  castleId(c) { return c.castleId ?? c.id; }
  castleXY(c) {
    if (c.fieldId !== undefined) return C.fieldIdToCoords(c.fieldId);
    const m = String(c.coords || c.pos || '').match(/(\d+)\s*,\s*(\d+)/);
    if (m) return { x: +m[1], y: +m[2] };
    return null;
  }

  // ---- hero selection ----
  // "any", a hero name, or "any:level<500,attack>400"
  pickHero(castle, spec) {
    const heros = castle.heros || [];
    if (!heros.length) throw new Error('no heroes in castle');
    const idle = heros.filter((h) => h.status === 0 || h.status === undefined);
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

  // ---- lost heroes (this is what a Stone of Finding actually drives) ----
  lostHeroes() { return this.req('hero.GetDisappearHeros', {}); }
  // NOTE: this command uses lowercase `castleid` and `id`, unlike every other one.
  recoverHero(castleId, heroId) { return this.req('hero.RecoverDisappearHero', { castleid: castleId, id: String(heroId) }); }

  // ---- heroes ----
  // Attribute names: power = Attack, management = Politics, stratagem = Intelligence.
  tavernList(castleId) { return this.req('hero.getHerosListFromTavern', { castleId }); }
  refreshTavern(castleId) { return this.req('hero.refreshHerosListFromTavern', { castleId }); }
  hireHero(castleId, heroName) { return this.req('hero.hireHero', { castleId, heroName }); }
  fireHero(castleId, heroId) { return this.req('hero.fireHero', { castleId, heroId }); }
  releaseHero(castleId, heroId) { return this.req('hero.releaseHero', { castleId, heroId }); }
  promoteToChief(castleId, heroId) { return this.req('hero.promoteToChief', { castleId, heroId }); }
  dischargeChief(castleId) { return this.req('hero.dischargeChief', { castleId }); }
  levelUpHero(castleId, heroId) { return this.req('hero.levelUp', { castleId, heroId }); }
  resetPoint(castleId, heroId) { return this.req('hero.resetPoint', { castleId, heroId }); }
  awardGold(castleId, heroId) { return this.req('hero.awardGold', { castleId, heroId }); }
  callBackHero(castleId, heroId) { return this.req('hero.callBackHero', { castleId, heroId }); }
  renameHero(castleId, heroId, name) { return this.req('hero.changeName', { castleId, heroId, name }); }

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
  // is the field itself; base (what the hero started with) is field - *Added.
  static attrValue(h, key) { return Number(h[key] || 0); }
  static attrBase(h, key) { return Number(h[key] || 0) - Number(h[key + 'Added'] || 0); }

  // HeroConstants.as: 0 free, 1 chief (mayor), 2 guard, 3 marching, 4 captured, 5 returning, 8 farming
  static HERO_STATUS = { free: 0, mayor: 1, garrison: 2, marching: 3, captured: 4, returning: 5, farming: 8 };
  static isMayor(h) { return Number(h && h.status) === 1; }

  // Which attribute this hero is built around — that's where new points should go.
  static dominant(h) {
    const scores = ['power', 'management', 'stratagem'].map((k) => ({ k, v: Game.attrValue(h, k) }));
    scores.sort((a, b) => b.v - a.v);
    return scores[0].k;
  }

  findHero(castle, name) {
    const heros = castle.heros || [];
    if (!name || name === 'any') return heros[0] || null;
    return heros.find((h) => (h.name || '').toLowerCase() === String(name).toLowerCase()) || null;
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

  // Tear a building down completely (frees its slot).
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
    const entry = (d.builingList || []).find((x) => x.typeId === typeId) || (d.builingList || [])[0];
    return entry ? entry.conditionBean : null;
  }

  researchList(castleId) { return this.req('tech.getResearchList', { castleId }); }
  research(castleId, techId) { return this.req('tech.research', { castleId, techId }); }

  findBuildings(castle, typeId) {
    return (castle.buildings || []).filter((b) => b.typeId === typeId);
  }

  // Lowest free slot of the right kind, or null when the castle is full.
  freeSlot(castle, outside) {
    const used = new Set((castle.buildings || []).map((b) => b.positionId));
    const from = outside ? C.SLOTS.outsideFrom : C.SLOTS.insideFrom;
    const to = outside ? C.SLOTS.outsideTo : C.SLOTS.insideTo;
    for (let p = from; p <= to; p++) if (!used.has(p)) return p;
    return null;
  }

  // Turn a conditionBean into readable "what's missing" lines.
  unmet(cond) {
    if (!cond) return [];
    const out = [];
    for (const b of cond.buildings || []) {
      if (b.successFlag) continue;
      const name = (C.BUILDING_BY_ID[b.typeId] || {}).name || `building ${b.typeId}`;
      out.push({ kind: 'building', typeId: b.typeId, need: b.level, have: b.curLevel, text: `${name} level ${b.level} (you have ${b.curLevel})` });
    }
    for (const t of cond.techs || []) {
      if (t.successFlag) continue;
      const name = (C.TECH_BY_ID[t.typeId] || {}).name || `tech ${t.typeId}`;
      out.push({ kind: 'tech', typeId: t.typeId, need: t.level, have: t.curLevel, text: `${name} level ${t.level} (you have ${t.curLevel})` });
    }
    return out;
  }

  // ---- market ----
  // NOTE: price is a STRING on the wire (TradeCommands.as newTrade param5:String)
  async newTrade({ castleId, resource, type, amount, price }) {
    const resType = C.TRADE_RES[resource];
    const tradeType = C.TRADE_TYPE[type];
    if (resType === undefined) throw new Error('trade resource must be food/wood/stone/iron, got ' + resource);
    if (tradeType === undefined) throw new Error('trade type must be buy/sell');
    this.c.send('trade.newTrade', { castleId, resType, tradeType, amount, price: String(price) });
    const r = await this.c.await(['trade.newTrade'], 12000);
    return r.data;
  }

  async searchTrades(resource) {
    this.c.send('trade.searchTrades', { resType: C.TRADE_RES[resource] });
    const r = await this.c.await(['trade.searchTrades'], 12000);
    return r.data;
  }

  async myTrades(castleId) {
    this.c.send('trade.getMyTradeList', { castleId });
    const r = await this.c.await(['trade.getMyTradeList'], 12000);
    return r.data;
  }

  async cancelTrade(castleId, tradeId) {
    this.c.send('trade.cancelTrade', { castleId, tradeId });
    const r = await this.c.await(['trade.cancelTrade'], 12000);
    return r.data;
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
