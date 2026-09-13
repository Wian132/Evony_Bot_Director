'use strict';
// The Items tab's data: catalogue parsing, the inventory rows, and extract-items.js
// run against a hand-built SWF. No network, and the real itemcatalog.json is
// never read or written.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const I = require('./items');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-items-'));

const XML = `<?xml version="1.0" encoding="UTF-8"?><itemDefineI18n>
  <itemEum id="hero.loyalty.3" name="Lion Medal" itemType="奖章" desc="Increase a hero's Loyalty by 15 when rewarded."/>
  <itemEum id="consume.move.1" name="City Teleporter" itemType="宝物" desc="Teleport your city &amp; its valleys &#8217;randomly&#x2019;."/>
  <itemEum id="player.gold.1.a" name="Tax Policy " itemType="生产" itemDesc="Only the long text."/>
  <itemEum id="consume.2.a" name="Beginner Guidelines" itemType="加速" desc="Speeds things up."/>
  <itemEum name="no id here" itemType="宝物"/>
</itemDefineI18n>`;

const game = (items) => ({ player: { items } });
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

// ---------------------------------------------------------------------------
section('the catalogue');

t('reads id, name, type and desc, and decodes entities', () => {
  const m = I.parseItemXml(XML);
  assert.strictEqual(m.size, 4, 'the tag without an id is skipped');
  assert.deepStrictEqual(m.get('hero.loyalty.3'), { name: 'Lion Medal', type: '奖章', desc: "Increase a hero's Loyalty by 15 when rewarded." });
  assert.strictEqual(m.get('consume.move.1').desc, 'Teleport your city & its valleys ’randomly’.');
});

t('trims the name, and falls back to itemDesc when there is no desc', () => {
  const g = I.parseItemXml(XML).get('player.gold.1.a');
  assert.strictEqual(g.name, 'Tax Policy');
  assert.strictEqual(g.desc, 'Only the long text.');
});

// ---------------------------------------------------------------------------
section('the inventory');

t('names each held item and files it under the game\'s category', () => {
  const r = I.inventory(game([
    { id: 'consume.move.1', count: 2 }, { id: 'consume.2.a', count: 40 }, { id: 'player.gold.1.a', count: 1 },
  ]), I.parseItemXml(XML));
  const rows = byId(r.items);
  assert.strictEqual(r.named, true);
  assert.deepStrictEqual([rows['consume.move.1'].name, rows['consume.move.1'].category], ['City Teleporter', 'General']);
  assert.strictEqual(rows['consume.2.a'].category, 'Speed Up');
  assert.strictEqual(rows['player.gold.1.a'].category, 'Produce');
  assert.ok(r.items.every((x) => !x.medal));
});

t('medals are kept apart, by type from the catalogue', () => {
  const r = I.inventory(game([{ id: 'hero.loyalty.3', count: 12 }]), I.parseItemXml(XML));
  assert.deepStrictEqual(r.items, [{
    id: 'hero.loyalty.3', count: 12, medal: true, name: 'Lion Medal', category: 'Medal',
    desc: "Increase a hero's Loyalty by 15 when rewarded.",
  }]);
});

t('without a catalogue, medals are still medals and everything else lists by id', () => {
  const r = I.inventory(game([{ id: 'hero.loyalty.9', count: 3 }, { id: 'consume.move.1', count: 1 }]), new Map());
  const rows = byId(r.items);
  assert.strictEqual(r.named, false);
  assert.deepStrictEqual([rows['hero.loyalty.9'].name, rows['hero.loyalty.9'].medal], ['Nation Medal', true]);
  assert.deepStrictEqual([rows['consume.move.1'].name, rows['consume.move.1'].category], ['consume.move.1', 'Other']);
});

t('drops what is used up, and survives a missing or odd list', () => {
  const r = I.inventory(game([{ id: 'consume.move.1', count: 0 }, null, { count: 5 }, { id: 'x.y', count: '4' }]), new Map());
  assert.deepStrictEqual(r.items.map((x) => [x.id, x.count]), [['x.y', 4]]);
  assert.deepStrictEqual(I.inventory(null, new Map()).items, []);
  assert.deepStrictEqual(I.inventory({ player: {} }, new Map()).items, []);
});

// ---------------------------------------------------------------------------
section('extract-items.js');

// A minimal SWF: header, an empty frame RECT, then the tags.
function tag(code, body) {
  if (body.length < 0x3f) { const h = Buffer.alloc(2); h.writeUInt16LE((code << 6) | body.length); return Buffer.concat([h, body]); }
  const h = Buffer.alloc(6); h.writeUInt16LE((code << 6) | 0x3f); h.writeUInt32LE(body.length, 2);
  return Buffer.concat([h, body]);
}
function binaryData(id, text) {
  const b = Buffer.alloc(6); b.writeUInt16LE(id);
  return tag(87, Buffer.concat([b, Buffer.from(text, 'utf8')]));
}
function symbolClass(pairs) {
  const parts = [Buffer.from([pairs.length & 0xff, pairs.length >> 8])];
  for (const [id, name] of pairs) parts.push(Buffer.from([id & 0xff, id >> 8]), Buffer.from(name + '\0', 'utf8'));
  return tag(76, Buffer.concat(parts));
}
function swf(tags, { compress = false } = {}) {
  const rest = Buffer.concat([Buffer.from([0x00, 0, 24, 1, 0]), ...tags, tag(0, Buffer.alloc(0))]);
  const head = Buffer.from('FWS\x0a\0\0\0\0', 'latin1');
  head.writeUInt32LE(8 + rest.length, 4);
  if (!compress) return Buffer.concat([head, rest]);
  head.write('C', 0, 'latin1');
  return Buffer.concat([head, zlib.deflateSync(rest)]);
}
const run = (file, out) => execFileSync(process.execPath, [path.join(__dirname, 'extract-items.js'), file, out], { encoding: 'utf8', stdio: 'pipe' });

for (const compress of [false, true]) {
  t(`finds the item table among the other assets (${compress ? 'compressed' : 'plain'} SWF)`, () => {
    const file = path.join(tmp, `c${compress}.swf`), out = path.join(tmp, `c${compress}.json`);
    fs.writeFileSync(file, swf([
      binaryData(7, '<techDefine><itemEum id="not.this" name="Wrong table"/></techDefine>'),
      binaryData(9, XML),
      symbolClass([[7, 'com.evony.eum.GetDataXML_XMLTech'], [9, 'com.evony.eum.GetDataXML_XMLItem']]),
    ], { compress }));
    assert.match(run(file, out), /4 items/);
    const j = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(j.source, path.basename(file));
    assert.deepStrictEqual(Object.keys(j.items).sort(), ['consume.2.a', 'consume.move.1', 'hero.loyalty.3', 'player.gold.1.a']);
    assert.strictEqual(I.inventory(game([{ id: 'consume.move.1', count: 1 }]), new Map(Object.entries(j.items))).items[0].name, 'City Teleporter');
  });
}

t('refuses an SWF without the item table, and writes nothing', () => {
  const file = path.join(tmp, 'none.swf'), out = path.join(tmp, 'none.json');
  fs.writeFileSync(file, swf([binaryData(7, '<techDefine/>'), symbolClass([[7, 'com.evony.eum.GetDataXML_XMLTech']])]));
  assert.throws(() => run(file, out), (e) => e.status === 1 && /no GetDataXML_XMLItem/.test(e.stderr));
  assert.ok(!fs.existsSync(out));
});

// ---------------------------------------------------------------------------

(async () => {
  let pass = 0, fail = 0;
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n + '\n'); continue; }
    try { await f(); console.log('  ok    ' + n); pass++; }
    catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
