'use strict';
// One report's body — mailbox.js describeReport() in, HTML out — shared by the
// console's Reports window (app.html) and the stand-alone battle log
// (report.html, the Flash-free stand-in for the game's WarReport.swf page).
// Styles: reportview.css. Everything from the report is escaped here.
(function () {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : esc(n));
  // LootResourceUi's order and words (木材 is "Lumber")
  const RES = [['food', 'Food', '&#127806;'], ['wood', 'Lumber', '&#129717;'], ['stone', 'Stone', '&#129704;'],
    ['iron', 'Iron', '&#9935;'], ['gold', 'Gold', '&#129689;']];

  // cols: [{h, a:'n'|''}]; rows: [cells] or {cells, cls}, cells already HTML
  function table(cols, rows, cls) {
    const head = cols.map((c) => `<th>${esc(c.h)}</th>`).join('');
    const body = rows.map((r) => {
      const o = Array.isArray(r) ? { cells: r } : r;
      return `<tr${o.cls ? ` class="${o.cls}"` : ''}>`
        + o.cells.map((v, i) => `<td${cols[i] && cols[i].a ? ` class="${cols[i].a}"` : ''}>${v == null ? '' : v}</td>`).join('') + '</tr>';
    }).join('');
    return `<table class="rv-t${cls ? ' ' + cls : ''}">${cols.some((c) => c.h) ? `<thead><tr>${head}</tr></thead>` : ''}<tbody>${body}</tbody></table>`;
  }
  const kv = (rows) => `<table class="rv-t rv-kv"><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${fmt(v)}</td></tr>`).join('')}</tbody></table>`;
  const sub = (t) => (t ? `<div class="rv-sub">${esc(t)}</div>` : '');
  const lost = (n) => (n ? `<span class="rv-neg">${fmt(n)}</span>` : '0');

  // BattleTroopUi: one side of a battle
  function side(sd) {
    const whose = sd.whose === 'you' ? 'our side' : sd.whose === 'enemy' ? 'enemy side' : '';
    const res = sd.won === true ? '<span class="rv-won">Victory</span>' : sd.won === false ? '<span class="rv-lost">Defeat</span>' : '';
    const who = [
      sd.king ? `Lord <b>${esc(sd.king)}</b>` : '',
      sd.hero ? `Hero <b>${esc(sd.hero)}</b>${sd.heroLevel != null ? ` (Lv ${fmt(sd.heroLevel)})` : ''}` : '',
      sd.heroExp != null ? `hero experience ${fmt(sd.heroExp)}` : '',
      sd.castlePos ? `castle ${esc(sd.castlePos)}` : '',
    ].filter(Boolean).join(' &middot; ');
    const troops = sd.troops || [];
    const rows = troops.map((u) => [esc(u.name), fmt(u.count), lost(u.lost), fmt(u.left)]);
    if (troops.length > 1 && sd.total) rows.push({ cls: 'total', cells: ['Total', fmt(sd.total.count), lost(sd.total.lost), fmt(sd.total.left)] });
    return `<div class="rv-side${sd.won === true ? ' won' : sd.won === false ? ' lost' : ''}">`
      + `<div class="rv-sh">${esc(sd.role)}${whose ? ` <span class="rv-whose">${whose}</span>` : ''}${res}</div>`
      + `<div class="rv-who">${who || '<span class="rv-muted">no lord or hero named</span>'}</div>`
      + (rows.length ? table([{ h: 'Troop' }, { h: 'Amount', a: 'n' }, { h: 'Lost', a: 'n' }, { h: 'Left', a: 'n' }], rows)
        : '<div class="rv-none">no troops</div>')
      + '</div>';
  }

  function section(s) {
    if (!s) return '';
    if (s.type === 'sides') return `<div class="rv-sides">${(s.sides || []).map(side).join('')}</div>`;
    if (s.type === 'kv') return sub(s.title) + kv(s.rows || []);
    if (s.type === 'res') {
      const sign = s.sign === '-' || s.sign === '+' ? s.sign : '';
      const r = s.res || {};
      const cells = RES.filter(([k]) => r[k] !== undefined && r[k] !== null).map(([k, label, ico]) => {
        const v = r[k];
        return `<span><span class="rv-ico">${ico}</span>${label} `
          + `<b class="${v && sign === '-' ? 'rv-neg' : v && sign === '+' ? 'rv-pos' : ''}">${v && sign ? sign : ''}${fmt(v)}</b></span>`;
      });
      return sub(s.title) + `<div class="rv-res">${cells.join('') || '<span class="rv-muted">none</span>'}</div>`;
    }
    if (s.type === 'units') {
      const cols = (s.cols || []).map((c, i) => ({ h: c, a: i ? 'n' : '' }));
      return sub(s.title) + table(cols, (s.rows || []).map((row) => row.map((v, i) => (i ? fmt(v) : esc(v)))));
    }
    if (s.type === 'text') return sub(s.title) + `<div class="rv-text">${esc(s.text)}</div>`;
    if (s.type === 'raw') return sub(s.title) + `<pre class="rv-raw">${esc(s.text)}</pre>`;
    return '';
  }

  function body(d) {
    d = d || {};
    let h = '';
    if (d.headline) h += `<div class="rv-headline">${esc(d.headline)}</div>`;
    if (d.verdict && d.verdict.text) {
      h += `<div class="rv-verdict${d.verdict.good === true ? ' good' : d.verdict.good === false ? ' bad' : ''}">${esc(d.verdict.text)}</div>`;
    }
    for (const l of d.lines || []) h += `<div class="rv-line">${esc(l)}</div>`;
    for (const s of d.sections || []) h += section(s);
    for (const l of d.foot || []) h += `<div class="rv-foot">${esc(l)}</div>`;
    return `<div class="rv">${h || '<div class="rv-none">This report is empty.</div>'}</div>`;
  }

  // What the game calls each kind (the report list's own subjects vary).
  const KIND = {
    battle: 'Battle report', scout: 'Scout report', movement: 'Troop movement', trade: 'Trade report',
    rob: 'Robbed on the way', uprising: 'Uprising', heroEscape: 'Heroes deserted', troopDie: 'Troops starved',
    war: 'War declared', policy: 'Policy report', heroFlee: 'Hero fled', troopMoves: 'Troop movements',
    uprisingWar: 'Uprising war', levy: 'Levy', abandon: 'Colony abandoned', sowDiscord: 'Sow discord',
  };

  window.ReportView = { body, section, esc, fmt, kindTitle: (k) => KIND[k] || 'Report' };
})();
