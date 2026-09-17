'use strict';
// Script regexes run in a worker thread, with a time limit. V8's backtracking
// engine can spend minutes on a pattern like /^(a+)+$/ against "aaaa…!", and on
// the console's own thread that stops everything: the game connection, logins,
// every city's run, and Stop itself. Here only the worker is stuck: after
// LIMIT_MS it is terminated, the line fails with $error, and a fresh worker takes
// the next regex. One regex at a time goes to the worker, so a runaway one delays
// the others by at most LIMIT_MS and never fails them.
const path = require('path');
const { Worker } = require('worker_threads');

const LIMIT_MS = 2000;
const MAX_SUBJECT = 1e6;

let worker = null;
let busy = null;                 // the request in the worker now
const queue = [];
let seq = 0;

function spawn() {
  const w = new Worker(path.join(__dirname, 'script-regex-worker.js'));
  w.unref();                     // an idle worker never keeps the console process alive
  w.on('message', (msg) => {
    if (!busy || msg.id !== busy.id) return;
    const r = busy; busy = null;
    clearTimeout(r.timer);
    if (msg.ok) r.resolve(msg.value); else r.reject(new Error(msg.error));
    next();
  });
  const gone = (e) => {
    if (worker !== w) return;
    worker = null;
    if (busy) { const r = busy; busy = null; clearTimeout(r.timer); r.reject(e || new Error('the regex worker stopped')); }
    next();
  };
  w.on('error', gone);
  w.on('exit', () => gone(null));
  return w;
}

function next() {
  if (busy || !queue.length) return;
  const r = queue.shift();
  if (!worker) worker = spawn();
  busy = r;
  r.timer = setTimeout(() => {
    if (busy !== r) return;
    busy = null;
    const w = worker; worker = null;
    if (w) w.terminate().catch(() => {});
    r.reject(new Error(`the regular expression /${r.msg.source}/ ran for over ${LIMIT_MS / 1000} s and was stopped`
      + ' — simplify it (nested repeats like (a+)+ can take for ever)'));
    next();
  }, LIMIT_MS);
  worker.postMessage(r.msg);
}

function run(op, re, subject, extra = {}) {
  const text = String(subject);
  if (text.length > MAX_SUBJECT) {
    return Promise.reject(new Error(`a regular expression can search at most ${MAX_SUBJECT.toLocaleString('en-US')} characters`));
  }
  return new Promise((resolve, reject) => {
    queue.push({ id: ++seq, resolve, reject, msg: { id: seq, op, source: re.source, flags: re.flags, lastIndex: re.lastIndex, subject: text, extra } });
    next();
  });
}

// A match the way JavaScript returns one: an array with index, input and groups.
const matchArray = (p, input) => (p ? Object.assign([...p.values], { index: p.index, input, groups: p.groups }) : null);

module.exports = {
  LIMIT_MS, MAX_SUBJECT,
  async test(re, s) { const v = await run('test', re, s); re.lastIndex = v.lastIndex; return v.result; },
  async exec(re, s) { const v = await run('exec', re, s); re.lastIndex = v.lastIndex; return matchArray(v.match, String(s)); },
  async match(s, re) { const v = await run('match', re, s); return re.global ? v.all : matchArray(v.match, String(s)); },
  async matchAll(s, re) { return (await run('matchAll', re, s)).map((p) => matchArray(p, String(s))); },
  search: (s, re) => run('search', re, s),
  split: (s, re, limit) => run('split', re, s, { limit }),
  replace: (s, re, repl) => run('replace', re, s, { repl }),
  replaceAll: (s, re, repl) => run('replaceAll', re, s, { repl }),
  async hits(s, re) { return (await run('hits', re, s)).map((p) => matchArray(p, String(s))); },
};
