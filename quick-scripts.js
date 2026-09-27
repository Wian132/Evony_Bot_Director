'use strict';
// The Script tab's "Quick…" dropdown (scripts/quick-scripts.txt, served by
// /api/script/quick and drawn in public/app.html).
//
// WHY IT EXISTS (the user, 2026-09-24): "whenever I try to do something I do it in the
// script window and trading is turned off until you restart it. I want to be able to just
// click an option in the dropdown which says turn trading back on."
//
// Running a script by hand in a city ENDS that city's autorun run — a city has one run at a
// time — and nothing puts it back, so after any hand-run the account is out of the play
// until its console is restarted. These entries start it again in one click.
//
// The file is read on every ask, so entries are added by editing it; nothing restarts.
//   Label | script file | all
//     "all"    run it in every city of the account that has no run of its own going
//     {side}   becomes "buy" or "sell" from the side this account is on in the Trading
//              tab's setup; the entry is left out when that is not known
//     # ...    a comment
// An entry is dropped rather than shown broken when its file is missing, names a folder or
// is not a .txt: the dropdown must never offer something that cannot run.
const fs = require('fs');
const path = require('path');

const FILE = 'quick-scripts.txt';

function list({ dir, side = null, file = FILE } = {}) {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { return []; }
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const bits = line.split('|').map((x) => x.trim());
    const label = bits[0], named = bits[1] || '';
    const all = (bits[2] || '').toLowerCase() === 'all';
    if (!label || !named) continue;
    if (named.includes('{side}') && !side) continue;
    const real = named.replace('{side}', String(side || ''));
    if (real.includes('/') || real.includes(String.fromCharCode(92)) || !/[.]txt$/i.test(real)) continue;
    let ok = false;
    try { ok = fs.statSync(path.join(dir, real)).isFile(); } catch { ok = false; }
    if (!ok) continue;
    out.push({ label, file: real, all });
  }
  return out;
}

// The side this account is on, from the Trading tab's saved setup ("buy" | "sell" | null).
function sideOf(org, accountId) {
  if (!org || !accountId) return null;
  let sides = null;
  try { sides = ((org.settings.get('tradingSetup', null) || {}).sides) || {}; } catch { return null; }
  const s = sides[accountId];
  return s === 'buy' || s === 'sell' ? s : null;
}

module.exports = { FILE, list, sideOf };
