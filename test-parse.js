'use strict';
const s = require('./script');

const src = `
attack 123,456 any s:100k
repeat 10
wall abatis 1000
repeat 3
loop 2
  wall tower 500
  train a 10k
endloop
transport 123,456 t:1000 wood:100k
`.trim();

let n = 0;
const acts = s.parse(src);
for (const a of acts) {
  const { line, raw, ...rest } = a;
  console.log(`${String(++n).padStart(3)} (src ${String(line).padStart(2)})  ${a.cmd.padEnd(10)} ${JSON.stringify({ ...rest, cmd: undefined })}`);
}
console.log(`\ntotal expanded actions: ${acts.length}`);
