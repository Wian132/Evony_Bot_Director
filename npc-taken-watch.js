// npc-taken-watch.js — part of the evony-npc10 skill. Tails the takers' console logs
// (the account ids given, or a8,a9,a10) for the TAKEN lines job-take.txt prints once a
// target is theirs, and adds each to scripts/glitch-done.txt so every drainer stops,
// recalls and moves on.   node npc-taken-watch.js a10,a8
// Adds every target a taker reports TAKEN to scripts/glitch-done.txt, so the drainers
// stop hitting it and move on. Prints each change.
const fs = require('fs');
const DONE = __dirname + '/scripts/glitch-done.txt';
const LOGS = (process.argv[2] || 'a8,a9,a10').split(',').map((id) => `${__dirname}/console-${id}.log`);
const off = new Map(LOGS.map((f) => [f, fs.existsSync(f) ? fs.statSync(f).size : 0]));
setInterval(() => {
  for (const f of LOGS) {
    const size = fs.statSync(f).size, from = off.get(f);
    if (size <= from) { off.set(f, size); continue; }
    const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(size - from); fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd);
    off.set(f, size);
    for (const m of buf.toString('utf8').matchAll(/· TAKEN (\d+,\d+) by (\S+)/g)) {
      const s = fs.readFileSync(DONE, 'utf8');
      const cur = (/doneTargets = "([^"]*)"/.exec(s) || [])[1] || ' ';
      if (cur.includes(' ' + m[1] + ' ')) continue;
      fs.writeFileSync(DONE, s.replace(/doneTargets = "[^"]*"/, `doneTargets = "${cur}${m[1]} "`));
      console.log(`${new Date().toTimeString().slice(0, 8)} TAKEN ${m[1]} by ${m[2]} — drainers stop there`);
    }
  }
}, 5000);
console.log('watching for captured targets');
