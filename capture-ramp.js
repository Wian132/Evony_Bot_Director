'use strict';
// WATCH CAPTURE ON A RESOURCE PASS AND RAISE THE PRICE WHEN IT FALLS.
//
// The user, 2026-09-28: "0.01 or 0.001 initially and then ramp it up when we drop under 60%".
// Cheap is where a buy-back starts, because the gold we pay goes to a HOLIDAY account and
// comes back at the next maintenance, so a cheap fill is nearly free. But cheap is also what
// other players' bots watch for, so capture decays as they find the book: measured 2026-09-27,
// stone at 0.001 returned 41% while stone at 3 returned 92%. The answer is not a fixed price
// but a floor that rises as soon as the cheap price stops paying.
//
// MEASURE ON OUR SIDE ONLY. The obvious denominator - how much the banks lost - is WRONG:
// a selling side's resource total falls when an order is LISTED and comes back when it is
// cancelled, and with cancel-and-replace every 2 s the banks' stone swung between 33t and 83t
// on 2026-09-28 while nothing at all was selling. That produced capture readings of -0%, 322%
// and 560% in one run. What we GAIN is real (it is goods delivered), so the ramp keys off our
// arrival RATE: when a window brings in less than 60% of the best rate seen so far, the price
// steps up.
//
// A PRICE CHANGE IS THE DANGEROUS MOMENT. Every city cancels and re-lists, and on 2026-09-23
// the banks re-listed while our bids stayed at the old price: a 0.001 bid never crosses a
// 0.002 ask, the two books de-synchronised, and nothing crossed at all until it was spotted.
// So after every ramp this checks that BOTH sides are quoting the new price, and says so.
//
//   node capture-ramp.js [minutes]
const http = require('http');
const fs = require('fs');
const A = require('./auth');
const D = require('./db');

const org = D.all('SELECT id FROM orgs LIMIT 1')[0];
const usr = D.all('SELECT id FROM users LIMIT 1')[0];
const ses = A.newSession(usr.id, org.id, '127.0.0.1', 'capture-ramp');
const COOKIE = 'otto_sid=' + (typeof ses === 'string' ? ses : (ses.id || ses.sid));
const TOK = A.internalToken();

const CONTROL = __dirname + '/scripts/glitch-res-control.txt';
const BANKS = ['a2', 'a3', 'a17', 'a20', 'a21'];
const OURS = ['a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12', 'a13', 'a14', 'a15',
  'a16', 'a18', 'a19', 'a23', 'a24', 'a25', 'a26', 'a27', 'a28', 'a29', 'a30', 'a31'];

const RUNGS = [0.001, 0.01, 0.1, 1, 3];       // the ladder the price climbs
const FLOOR = 60;                              // capture % under which it steps up
const DONE_AT = 1e12;                          // banks under 1t of the resource: the pass is done
const EVERY_MS = 4 * 60000;

const T = (n) => (n / 1e12).toFixed(2) + 't';
const portOf = (id) => {
  const L = fs.readFileSync(__dirname + '/console-' + id + '.log', 'utf8');
  const m = [...L.matchAll(/port:\s*(\d+)/g)];
  return m.length ? m[m.length - 1][1] : null;
};
const get = (port, path) => new Promise((res) => {
  http.get({ host: 'localhost', port, path, headers: { Cookie: COOKIE, 'x-otto-internal': TOK }, timeout: 25000 },
    (r) => { let s = ''; r.on('data', (d) => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch { res(null); } }); })
    .on('error', () => res(null)).on('timeout', () => res(null));
});

function priceNow() {
  const L = fs.readFileSync(CONTROL, 'utf8').split(/\r?\n/);
  const i = L.findIndex((l) => /^price = /.test(l));
  return { line: i, value: Number(L[i].replace('price = ', '')) };
}
function setPrice(v) {
  const L = fs.readFileSync(CONTROL, 'utf8').split(/\r?\n/);
  const i = L.findIndex((l) => /^price = /.test(l));
  L[i] = 'price = ' + v;
  fs.writeFileSync(CONTROL, L.join('\n'));
}
function resNow() {
  const m = /^res = "(\w+)"/m.exec(fs.readFileSync(CONTROL, 'utf8'));
  return m ? m[1] : 'stone';
}

async function held(list, res) {
  let n = 0;
  for (const a of list) {
    const p = portOf(a);
    if (!p) continue;
    const s = await get(p, '/api/session');
    for (const c of ((s && s.cities) || [])) {
      const j = await get(p, '/api/city?id=' + c.id);
      n += (j && j.resources && j.resources[res]) || 0;
    }
  }
  return n;
}

// After a ramp, BOTH books must be quoting the new price or nothing crosses.
async function bothSidesQuoting(price) {
  const M = require('./otto-mcp.js');
  const runs = (n, args) => M.TOOLS.find((x) => x.name === n).fn(args);
  const look = async (a) => {
    const p = portOf(a);
    const s = await get(p, '/api/session');
    for (const c of ((s && s.cities) || []).slice(0, 3)) {
      const o = String(await runs('script_runs', { account: a, city: String(c.id) }));
      if (o.includes(' ' + price + ' ')) return true;
    }
    return false;
  };
  return { banks: await look(BANKS[1]), ours: await look(OURS[10]) };
}

(async () => {
  const minutes = Number(process.argv[2] || 180);
  const until = Date.now() + minutes * 60000;
  const res = resNow();
  let prev = null, best = 0;
  console.log('watching ' + res + ' — ramp when capture < ' + FLOOR + '%');

  while (Date.now() < until) {
    const b = await held(BANKS, res);
    const o = await held(OURS, res);
    const now = Date.now();
    const stamp = new Date().toTimeString().slice(0, 8);
    let line = stamp + '  price ' + priceNow().value + '  banks ' + T(b) + '  ours ' + T(o);

    if (prev) {
      const got = o - prev.o;                    // what actually ARRIVED: the only honest figure
      const mins = (now - prev.t) / 60000;
      const rate = got / mins;                   // tonnes a minute reaching us
      if (rate > best) best = rate;
      const pct = best > 0 ? (100 * rate / best) : 100;
      line += "   we +" + T(got) + "  (" + T(rate * 60) + "/h, " + pct.toFixed(0) + "% of best)";
      console.log(line);

      if (b < DONE_AT) { console.log("  the banks are out of " + res + " — pass finished"); return; }

      // Only judge a price once it has had a full window to work, and never ramp off a window
      // that simply had nothing to buy.
      if (best > 0 && pct < FLOOR) {
        const cur = priceNow().value;
        const next = RUNGS.find((r) => r > cur);
        if (!next) console.log("  " + pct.toFixed(0) + "% of best but the price is already at the top rung (" + cur + ")");
        else {
          setPrice(next);
          best = 0;                              // a new price sets its own baseline
          console.log("  arrivals at " + pct.toFixed(0) + "% of best — price " + cur + " -> " + next);
          await new Promise((r) => setTimeout(r, 25000));
          const q = await bothSidesQuoting(next);
          console.log("  re-listed at " + next + ": banks " + (q.banks ? "yes" : "NO") + ", ours " + (q.ours ? "yes" : "NO")
            + (q.banks && q.ours ? "" : "   *** BOOKS DE-SYNCHRONISED — CHECK IT ***"));
        }
      }
    } else console.log(line + '   (baseline)');

    prev = { b, o, t: now };
    await new Promise((r) => setTimeout(r, EVERY_MS));
  }
  console.log('watch window closed');
})().catch((e) => { console.error(e); process.exit(1); });
