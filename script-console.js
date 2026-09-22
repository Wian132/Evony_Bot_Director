'use strict';
// The console's side of scripts: what server.js hands every run it starts.
// No game traffic here, and no require('./script') at load time.
//
//   call load3 | call 3 | call "Load 3"         a loadout of the run's city, by slot
//   call "farm upgrades"                        ... or by the name its first line gives it
//   call "UseItems.txt" | call sub/items.txt    ... else a file in the console's scripts
//                                               folder (<repo>\scripts). Never a URL, a
//                                               full path or a ..: scriptFile() says why.
//   label autorun                               NEAT's autorun: once the console has logged
//                                               in after a start, every city runs each saved
//                                               loadout holding it, from that line. First,
//                                               in every city, the startup file: RUNSCRIPT
//                                               (NEAT's -runscript), else AutoRunScript.txt,
//                                               from the scripts folder when it is there.
//                                               OFF unless AUTOSCRIPTS=1 switches it on
//                                               (NEAT's -autoscripts 1). The same switches may
//                                               sit in <repo>\CmdParms.txt as NEAT writes them
//                                               (-autoscripts 1 / -runscript Items.txt);
//                                               the environment wins over the file. Its last
//                                               start per account is kept (autorunGate): a
//                                               console that starts again within 10 minutes
//                                               skips it.
//   say "text" | say "es# texto" | play x.mp3   go to the open console tabs (Notifier): a
//                                               tab speaks with the browser's voice or plays
//                                               the sound. Sound files live in <repo>\media
//                                               (mediaFile). No tab open: nothing is heard.
const fs = require('fs');
const path = require('path');

// EVONY_SCRIPTS_DIR / EVONY_MEDIA_DIR / EVONY_CMDPARMS move them (tests, as
// EVONY_DB moves the database).
const SCRIPTS_DIR = process.env.EVONY_SCRIPTS_DIR ? path.resolve(process.env.EVONY_SCRIPTS_DIR) : path.join(__dirname, 'scripts');
const MEDIA_DIR = process.env.EVONY_MEDIA_DIR ? path.resolve(process.env.EVONY_MEDIA_DIR) : path.join(__dirname, 'media');
const CMDPARMS = process.env.EVONY_CMDPARMS ? path.resolve(process.env.EVONY_CMDPARMS) : path.join(__dirname, 'CmdParms.txt');
const LOADOUTS = 10;
const MAX_FILE = 1024 * 1024;           // a "script" bigger than this is something else

// Windows opens these as devices wherever they sit (scripts\CON would read the console).
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

// A name a script gives -> its path inside `dir`. Plain relative names only:
// segments of [A-Za-z0-9 _.-] split by / or \, no .., no drive, no leading slash.
// The name alone is not enough: a link under the folder (a symlink, or a
// junction, which needs no admin rights) reaches anywhere. So no part of the
// name may be a link, and the real path must be inside the folder's real path.
function inside(dir, name, what) {
  const s = String(name == null ? '' : name).trim();
  const no = (why) => new Error(`${s || '(no name)'}: ${why} — only files in the console's ${what} folder (${dir})`);
  if (!s) throw no('no file named');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) throw no('not a URL');
  if (/^[A-Za-z]:/.test(s) || /^[\\/]/.test(s) || path.isAbsolute(s)) throw no('not a full path');
  const parts = s.split(/[\\/]+/);
  for (const p of parts) {
    if (p === '..' || /^\.+$/.test(p)) throw no('no .. or . in the name');
    if (!/^[A-Za-z0-9 _.-]+$/.test(p)) throw no(`"${p}" has characters a file name here cannot have`);
    if (DEVICE.test(p.trim())) throw no(`"${p}" is a device name`);
  }
  const full = path.resolve(dir, ...parts);
  if (!full.startsWith(dir + path.sep)) throw no('outside the folder');
  noLinks(dir, parts, full, no);
  return full;
}

const sameOrUnder = (p, root) => {
  const a = process.platform === 'win32' ? p.toLowerCase() : p, b = process.platform === 'win32' ? root.toLowerCase() : root;
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};

// No part of the name is a link, and what exists of it really is in the folder.
// A folder that does not exist holds nothing to read, so there is nothing to check.
function noLinks(dir, parts, full, no) {
  let realDir;
  try { realDir = fs.realpathSync.native(dir); } catch { return; }
  let at = dir;
  for (const seg of parts) {
    at = path.join(at, seg);
    let st;
    try { st = fs.lstatSync(at); } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) break;       // the rest does not exist
      throw no(`"${seg}" cannot be checked (${e.code || e.message})`);
    }
    if (st.isSymbolicLink()) throw no(`"${seg}" is a link (symlink or junction)`);
  }
  // the real path of the file, or of the nearest part of it that exists
  for (let q = full; sameOrUnder(q, dir); q = path.dirname(q)) {
    let real;
    try { real = fs.realpathSync.native(q); } catch { continue; }          // not there: try its parent
    const ok = sameOrUnder(real, realDir) && (q !== full || real.length > realDir.length);
    if (!ok) throw no('its real path is outside the folder');
    return;
  }
}

// The file `call` and `get` read: its path, or an Error saying why not. It only
// looks (lstat, realpath); nothing is created and nothing is read.
const scriptFile = (name) => inside(SCRIPTS_DIR, name, 'scripts');

// A script file's text, null when there is no such file.
function readScriptFile(name) {
  const f = scriptFile(name);
  let st;
  try { st = fs.statSync(f); } catch { return null; }
  if (!st.isFile()) return null;
  if (st.size > MAX_FILE) throw new Error(`${name} is ${Math.round(st.size / 1024)} KB — too big for a script`);
  return fs.readFileSync(f, 'utf8');
}

// A sound `play` names: 'SingleAttack.mp3' or NEAT's 'media/SingleAttack.mp3',
// both in <repo>\media. -> { file, rel } (rel is what /api/script/media takes).
function mediaFile(name) {
  const rel = String(name == null ? '' : name).trim().replace(/^media[\\/]+/i, '');
  const file = inside(MEDIA_DIR, rel, 'media');
  if (!/\.(mp3|wav|ogg|m4a)$/i.test(file)) throw new Error(`${rel}: a sound is an .mp3, .wav, .ogg or .m4a file`);
  return { file, rel: rel.replace(/\\/g, '/') };
}
const MEDIA_TYPES = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };

// ------------------------------------------------------------------ call

// A loadout is named by its first line: "// farm upgrades" -> "farm upgrades"
// (the console shows the first 30 characters of it).
function loadName(src) {
  const first = String(src || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  return first.replace(/^\/\/\s*/, '').trim();
}

// `call <name>` in a city whose loadouts are `slots` ([{slot, src}], empties
// left out) -> { src, from }. Throws with what to write instead when nothing
// matches. Slot first (3, load3, Load 3), then a loadout's name, then a file.
function resolveCall(name, slots, { readFile = readScriptFile } = {}) {
  const want = String(name == null ? '' : name).trim();
  if (!want) throw new Error('call: say which script — call load3, call "farm upgrades" or call "UseItems.txt"');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(want)) {
    throw new Error(`call: scripts are not fetched from the web (${want}) — save it as a loadout, or as a file in ${SCRIPTS_DIR}`);
  }
  const list = (slots || []).filter((s) => s && String(s.src || '').trim());
  const m = /^(?:load\s*)?(\d+)$/i.exec(want);
  if (m) {
    const n = Number(m[1]);
    if (n < 1 || n > LOADOUTS) throw new Error(`call: there is no Load ${n} — a city has Load 1 to Load ${LOADOUTS}`);
    const s = list.find((x) => Number(x.slot) === n);
    if (!s) throw new Error(`call: Load ${n} is empty in this city`);
    return { src: String(s.src), from: `Load ${n}` };
  }
  const lw = want.toLowerCase();
  const byName = list.find((x) => { const nm = loadName(x.src).toLowerCase(); return nm === lw || (nm.length > 30 && nm.slice(0, 30) === lw); });
  if (byName) return { src: String(byName.src), from: `Load ${byName.slot} (${loadName(byName.src).slice(0, 30)})` };
  const tries = /\.[A-Za-z0-9]{1,5}$/.test(want) ? [want] : [want, want + '.txt'];
  let bad = null;
  for (const f of tries) {
    let text;
    try { text = readFile(f); } catch (e) { bad = bad || e; continue; }
    if (text !== null && text !== undefined) return { src: String(text), from: path.join(path.basename(SCRIPTS_DIR), ...f.split(/[\\/]+/)) };
  }
  if (bad && !list.length) throw bad;
  throw new Error(`call: no loadout in this city is named "${want}", and there is no file ${want} in ${SCRIPTS_DIR}`
    + (bad ? ` (${bad.message})` : ''));
}

// ------------------------------------------------------------------ autorun

// A line `label autorun` (any case, @ or a trailing // comment allowed).
const AUTORUN_RE = /^[ \t]*@?[ \t]*label[ \t]+autorun[ \t]*(?:\/\/.*)?$/im;
const hasAutorun = (src) => AUTORUN_RE.test(String(src || ''));

// NEAT's switch values: 1, yes, on, true are on; any other value is off.
const switchOn = (v) => /^(1|yes|on|true)$/i.test(String(v).trim());

// NEAT's start-up parameters (wiki StartupParameters): `-name value`, also
// -name=value, -name:value, /name value, /name=value, /name:value, a value
// with spaces in "quotes". Several may share a line, as on a command line, or
// sit one a line, as in CmdParms.txt; a line starting # or // is a comment.
// `text` is a string, or a command line already split (process.argv). Only the
// names given come back, lower case; a later name wins over an earlier one.
function parseCmdParms(text, stray = null) {
  let toks;
  if (Array.isArray(text)) toks = text.map(String);
  else {
    toks = [];
    for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
      if (/^\s*(#|\/\/)/.test(line)) continue;
      const re = /((?:"[^"]*"?|[^\s"])+)/g;             // /runscript:"My Items.txt" is one word
      let m;
      while ((m = re.exec(line))) toks.push(m[1]);
    }
  }
  const out = {};
  for (let i = 0; i < toks.length; i++) {
    const m = /^[-/]([A-Za-z]+)(?:[=:](.*))?$/.exec(toks[i]);
    if (!m) { if (stray) stray.push(toks[i]); continue; }      // a stray word: nothing names it
    let v = m[2];
    if (v === undefined && i + 1 < toks.length && !/^[-/][A-Za-z]+(?:[=:].*)?$/.test(toks[i + 1])) v = toks[++i];
    out[m[1].toLowerCase()] = v === undefined ? '' : String(v).replace(/"/g, '');
  }
  return out;
}

// The console's own command line (server.js hands it over at start): the
// Director puts its fleet-wide and per-account start-up parameters there, as
// NEAT's Director does, and `node server.js -autoscripts 1` works by hand.
let STARTUP_ARGS = {};
function setStartupArgs(argv) { STARTUP_ARGS = parseCmdParms(argv || []); return STARTUP_ARGS; }
const startupArgs = () => ({ ...STARTUP_ARGS });

// NEAT's CmdParms.txt, which gives its parameters to every console started from
// this folder, with the console's command line over it: the command line wins.
function readCmdParms(file = CMDPARMS, args = STARTUP_ARGS) {
  let fromFile = {};
  try { fromFile = parseCmdParms(fs.readFileSync(file, 'utf8')); } catch { /* no file: no parameters */ }
  return { ...fromFile, ...args };
}

// What starts at startup: { on, runscript, from } from the environment, else
// the command line (the Director), else CmdParms.txt. Off unless one of them
// switches it on: a console that starts scripts by itself should be one its
// operator meant to.
function autorunSettings(env = process.env, parms = readCmdParms(), args = STARTUP_ARGS) {
  const where = (k) => (args && args[k] !== undefined ? 'the Director\'s start-up parameters' : 'CmdParms.txt');
  const on = env.AUTOSCRIPTS !== undefined ? switchOn(env.AUTOSCRIPTS)
    : parms.autoscripts !== undefined ? switchOn(parms.autoscripts) : false;
  const from = env.AUTOSCRIPTS !== undefined ? 'AUTOSCRIPTS' : parms.autoscripts !== undefined ? where('autoscripts') : null;
  const named = env.RUNSCRIPT !== undefined ? env.RUNSCRIPT : parms.runscript;
  return { on, runscript: named && String(named).trim() ? String(named).trim() : null, from };
}

// NEAT's parameters (wiki StartupParameters), and what an OTTObot console does
// with each. `use`: it acts on it. `refuse`: the Director will not keep it,
// and says where it belongs instead. Anything else is kept and reaches scripts
// as Config.<name> (as -teleport does), with `note` saying OTTObot has no such
// setting of its own.
const STARTUP_PARMS = {
  autoscripts: { use: 'autorun scripts: 1 on, 0 off (off unless switched on)' },
  runscript: { use: 'the file every city runs first at autorun, from the scripts folder (else AutoRunScript.txt)' },
  autorun: { use: 'autorun goals: 0 starts the engine paused until Resume; 1, or not set, starts it live' },
  maxtrade: { use: 'the most one buy/sell order in a script may be for (default 99,999,999)' },
  teleport: { use: 'Config.teleport for scripts (the state a teleport goes to)' },
  username: { refuse: 'the account\'s own Email field is its login' },
  u: { refuse: 'the account\'s own Email field is its login' },
  password: { refuse: 'the account\'s own Password field is used — a parameter would sit on the command line for anyone on this PC to read' },
  server: { refuse: 'the account\'s own Server field says where it logs in' },
  s: { refuse: 'the account\'s own Server field says where it logs in' },
  serverhost: { refuse: 'the game server is found from the account\'s Server field' },
  serverport: { refuse: 'the game server is found from the account\'s Server field' },
  proxy: { refuse: 'pick it in the account\'s Proxy dropdown (Proxies holds the list)' },
  ssk: { refuse: 'NeatPortal keys mean nothing to OTTObot, and they are secrets' },
  token: { refuse: 'NeatPortal keys mean nothing to OTTObot, and they are secrets' },
  prependgoals: { refuse: 'use the account\'s Prepend goals file box' },
  appendgoals: { refuse: 'use the account\'s Append goals file box' },
  basedir: { refuse: 'every console uses its own folder (scripts\\, media\\, CmdParms.txt)' },
  autologin: { note: 'a console always logs in; switch the account off to keep it out' },
  delay: { note: 'no login delay — the Director starts a console when asked' },
  title: { note: 'the console\'s tab is titled with the account\'s Label' },
  maintenance: { note: 'use the account\'s After maintenance setting' },
  secure: { note: 'always on: scripts never see the login in Config, and resetplayer needs OTTO_ALLOW_RESET_PLAYER=1' },
  claimpackages: { note: 'packages are claimed by goals and scripts, not by a switch' },
};
const NO_GUI = ['netbookmode', 'connectioncheckdelay', 'logintimeout', 'minimize', 'minimizetotray', 'ttsattackwarning', 'attackfocus',
  'balloonattackwarning', 'captchaautosolve', 'attackwarning', 'warreports', 'notradingreports', 'noattackreports', 'noamuletmessages',
  'nosystemmessages', 'sce', 'compatible', 'resetfh', 'showsettings'];
for (const k of NO_GUI) STARTUP_PARMS[k] = { note: 'a setting of NEAT\'s own window, which OTTObot does not have' };
for (const k of ['player', 'sex', 'faceindex', 'zone', 'city', 'flag']) STARTUP_PARMS[k] = { note: 'for creating a new account, which OTTObot does not do' };

// A start-up parameter text the Director is asked to keep, checked:
// { parms, errors: [...], notes: [...] }. An error means it is not kept.
function checkStartupParms(text) {
  const src = String(text == null ? '' : text);
  const errors = [], notes = [];
  if (src.length > 4000) return { parms: {}, errors: ['more than 4000 characters — that is not a list of start-up parameters'], notes };
  const stray = [];
  const parms = parseCmdParms(src, stray);
  // a word no -name comes before: a missing dash, or a value with spaces not in "quotes"
  if (stray.length) {
    errors.push(`${stray.slice(0, 3).map((w) => `"${w.slice(0, 30)}"`).join(', ')} — not a parameter: each starts with - or /`
      + ' (-autoscripts 1), and a value with spaces goes in "quotes"');
  }
  for (const [k, v] of Object.entries(parms)) {
    const p = STARTUP_PARMS[k];
    if (p && p.refuse) errors.push(`-${k}: ${p.refuse}`);
    else if (p && p.note) notes.push(`-${k}: ${p.note}`);
    else if (!p) notes.push(`-${k}: not one of OTTObot's — scripts read it as Config.${k}`);
    if (['autoscripts', 'autorun'].includes(k) && !/^(1|yes|on|true|0|no|off|false)$/i.test(v)) errors.push(`-${k} ${v}: say 1 (on) or 0 (off)`);
    if (k === 'maxtrade' && !(/^\d+$/.test(v) && Number(v) >= 1)) errors.push(`-maxtrade ${v}: a whole number of at least 1`);
    if (k === 'runscript') { try { scriptFile(v); } catch (e) { errors.push(`-runscript: ${e.message}`); } }
  }
  return { parms, errors, notes };
}

// Parameters -> a command line: ['-autoscripts', '1', ...], for spawn (no shell).
const parmsToArgs = (parms) => Object.entries(parms || {}).flatMap(([k, v]) => (v === '' ? [`-${k}`] : [`-${k}`, String(v)]));

// Autorun's last start per account, in the console's database settings (the
// `store`: get(key, default) / set(key, value)). A console that starts again
// within AUTORUN_GAP_MS — a crash loop, another session restarting it — skips
// autorun, so the same orders are not sent again on every start. The start is
// recorded before anything runs; one that cannot be recorded is not made.
// -> { ok: true } | { ok: false, why }
const AUTORUN_GAP_MS = 10 * 60000;
const AUTORUN_KEY = 'autorunLastStart';
function autorunGate(store, accountId, now = Date.now(), gapMs = AUTORUN_GAP_MS) {
  const who = String(accountId || 'console');
  let all;
  try { all = store.get(AUTORUN_KEY, {}) || {}; } catch (e) { return { ok: false, why: `not started — its last start could not be read (${e.message})` }; }
  if (typeof all !== 'object' || Array.isArray(all)) all = {};
  const last = Number(all[who]) || 0;
  if (last && now >= last && now - last < gapMs) {
    const mins = Math.max(1, Math.round((now - last) / 60000));
    return { ok: false, last, why: `not started — it already started ${mins} minute(s) ago (${new Date(last).toLocaleTimeString()}), and it`
      + ` waits ${Math.round(gapMs / 60000)} minutes between starts, so a console that keeps restarting does not run it again each time` };
  }
  try { store.set(AUTORUN_KEY, { ...all, [who]: now }); } catch (e) {
    return { ok: false, why: `not started — its start could not be recorded (${e.message}), and without that a restart would run it again` };
  }
  return { ok: true, last: last || null };
}

// The startup file every city runs first: { name, src } | null | { name, error }.
function startupScript(settings, { readFile = readScriptFile } = {}) {
  const name = settings.runscript || 'AutoRunScript.txt';
  let src;
  try { src = readFile(name); } catch (e) { return { name, error: e.message }; }
  if (src === null || src === undefined) return settings.runscript ? { name, error: `there is no ${name} in ${SCRIPTS_DIR}` } : null;
  return String(src).trim() ? { name, src: String(src) } : null;
}

// One city's autorun, in the order NEAT runs it: the startup file, then each
// saved loadout holding `label autorun`, from that label.
function autorunPlan(slots, startup) {
  const plan = [];
  if (startup && startup.src) plan.push({ what: startup.name, src: startup.src, startLine: null });
  for (const s of (slots || []).slice().sort((a, b) => a.slot - b.slot)) {
    if (hasAutorun(s.src)) plan.push({ what: `Load ${s.slot}`, slot: s.slot, src: String(s.src), startLine: 'autorun' });
  }
  return plan;
}

// ------------------------------------------------------------------ say / play

// What scripts say and play, for the console tabs to pick up. Each open tab
// polls (poll) every couple of seconds with its own id; push() answers how many
// tabs polled lately, which is what `say` reports. A tab in the background is
// polled slowly by its browser, so "lately" is generous.
class Notifier {
  constructor({ keep = 100, liveMs = 75000, maxAgeMs = 5 * 60000, now = Date.now } = {}) {
    this.keep = keep; this.liveMs = liveMs; this.maxAgeMs = maxAgeMs; this.now = now;
    this.boot = now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.seq = 0;
    this.items = [];
    this.tabs = new Map();              // tab id -> last poll
  }

  listeners() {
    const t = this.now();
    let n = 0;
    for (const [id, at] of this.tabs) { if (t - at <= this.liveMs) n++; else this.tabs.delete(id); }
    return n;
  }

  push(note) {
    const item = { ...note, seq: ++this.seq, t: this.now() };
    this.items.push(item);
    if (this.items.length > this.keep) this.items.shift();
    return this.listeners();
  }

  // A tab's first poll (no `after`) learns where the list is; later ones get
  // what came since. A tab that knew another process (`boot`) gets what this
  // one has queued, so a console restart loses nothing it was asked to say.
  poll({ after, boot, tab } = {}) {
    const t = this.now();
    if (tab) this.tabs.set(String(tab).slice(0, 40), t);
    const fresh = (x) => t - x.t <= this.maxAgeMs;
    let items = [];
    if (after !== undefined && after !== null && after !== '') {
      const from = boot && boot !== this.boot ? 0 : Number(after) || 0;
      items = this.items.filter((x) => x.seq > from && fresh(x));
    }
    return { boot: this.boot, seq: this.seq, items, tabs: this.listeners() };
  }
}

module.exports = {
  SCRIPTS_DIR, MEDIA_DIR, MEDIA_TYPES, CMDPARMS, LOADOUTS,
  scriptFile, readScriptFile, mediaFile,
  loadName, resolveCall,
  hasAutorun, switchOn, parseCmdParms, readCmdParms, setStartupArgs, startupArgs, checkStartupParms, parmsToArgs, STARTUP_PARMS,
  autorunSettings, startupScript, autorunPlan, autorunGate, AUTORUN_GAP_MS, AUTORUN_KEY,
  Notifier,
};
