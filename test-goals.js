'use strict';
const { parseGoals, describe } = require('./goals');

const src = `comfortpolicy 15 16 popraise
defensepolicy /usetruce:79 /usespeech:2 /junktroop:5000 /usewarhorn:1 /usecorselet:1 /usepenicillin:1
config comfort:1
fortification ab:1
fortification ab:5
fortification ab:10
fortification ab:50
fortification ab:500
fortification ab:5000
fortification tra:45k,ab:5k
traininghero otto 30 60
troop b:30k,cp:20k
troop r:150k,b:50k,cp:50k
troop r:300k,b:50k,cp:50k
troop c:100k,cata:100k,wo:50k,w:50k,p:50k,sw:50k,a:300k
troop s:1m
troop r:500k,cp:200k,b:300k
troop s:5m
troop a:1m,c:200k,cata:500k
build b:0:1,c:10:23,rs:10:1,a:10:1
requestresources any food 1b 2b 100m 1b t
requestresources any wood 1b 2b 100m 1b t
requestresources any stone 1b 2b 100m 1b t
requestresources any iron 1b 2b 100m 1b t
requestresources any gold 1b 2b 100m 1b t
config troopsusepopmax:1
config warrules:2
config wartown:0
config hero:1`;

const p = parseGoals(src);
console.log('=== interpreted ===');
for (const l of describe(p)) console.log(l);
console.log(`\n=== ${p.errors.length} error(s) ===`);
for (const e of p.errors) console.log(`  line ${e.line}: ${e.error}`);
