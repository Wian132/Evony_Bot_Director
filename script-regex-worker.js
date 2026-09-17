'use strict';
// The worker thread script-regex.js runs script regexes in. It only matches: it
// gets the pattern, flags and text, runs one operation and posts back plain data
// (match arrays become { values, index, groups }). A pattern that backtracks for
// ever is stopped from outside by terminating this thread.
const { parentPort } = require('worker_threads');

const plain = (m) => (m ? { values: [...m], index: m.index, groups: m.groups ? { ...m.groups } : undefined } : null);

parentPort.on('message', ({ id, op, source, flags, lastIndex, subject, extra }) => {
  try {
    const re = new RegExp(source, flags);
    re.lastIndex = lastIndex || 0;
    let value;
    switch (op) {
      case 'test': value = { result: re.test(subject), lastIndex: re.lastIndex }; break;
      case 'exec': value = { match: plain(re.exec(subject)), lastIndex: re.lastIndex }; break;
      case 'match': value = re.global ? { all: subject.match(re) } : { match: plain(subject.match(re)) }; break;
      case 'matchAll': value = [...subject.matchAll(re)].map(plain); break;
      case 'search': value = subject.search(re); break;
      case 'split': value = subject.split(re, extra.limit); break;
      case 'replace': value = subject.replace(re, extra.repl); break;
      case 'replaceAll': value = subject.replaceAll(re, extra.repl); break;
      // every match a callback replacement needs (the callback itself runs in the script)
      case 'hits': value = re.global ? [...subject.matchAll(re)].map(plain) : [plain(re.exec(subject))].filter(Boolean); break;
      default: throw new Error('unknown regex operation ' + op);
    }
    parentPort.postMessage({ id, ok: true, value });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e.message });
  }
});
