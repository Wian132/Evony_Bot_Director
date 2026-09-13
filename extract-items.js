'use strict';
// Copy the item catalogue out of the Evony client into itemcatalog.json, which
// items.js reads to name the console's Items tab.
//
//   node extract-items.js <EvonyClient1922.swf | WarReport.swf> [out.json]
//
// The catalogue is the XML asset bound to com.evony.eum.GetDataXML_XMLItem: a
// DefineBinaryData tag (87) that the SymbolClass tag (76) names. Both SWFs
// embed it. The output is git-ignored, like the SWFs themselves.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parseItemXml, CATALOGUE } = require('./items');

const [file, out = CATALOGUE] = process.argv.slice(2);
if (!file) { console.error('usage: node extract-items.js <client .swf> [out.json]'); process.exit(1); }

let buf = fs.readFileSync(file);
const sig = buf.toString('latin1', 0, 3);
if (sig === 'CWS') buf = Buffer.concat([buf.subarray(0, 8), zlib.inflateSync(buf.subarray(8))]);
else if (sig !== 'FWS') { console.error(`${file}: not an SWF this can read (signature ${sig})`); process.exit(1); }

// Header: signature, version, length, then the frame RECT (5-bit field size,
// four fields), frame rate and frame count.
const nbits = buf[8] >> 3;
let p = 8 + Math.ceil((5 + nbits * 4) / 8) + 4;
const blobs = new Map();
const classes = new Map();
while (p + 2 <= buf.length) {
  const hdr = buf.readUInt16LE(p); p += 2;
  const code = hdr >> 6;
  let len = hdr & 0x3f;
  if (len === 0x3f) { len = buf.readUInt32LE(p); p += 4; }
  const body = buf.subarray(p, p + len); p += len;
  if (code === 0) break;
  if (code === 87) blobs.set(body.readUInt16LE(0), body.subarray(6));
  if (code === 76) {
    let q = 2;
    for (let n = body.readUInt16LE(0); n > 0; n--) {
      const id = body.readUInt16LE(q); q += 2;
      const end = body.indexOf(0, q);
      classes.set(body.toString('utf8', q, end), id); q = end + 1;
    }
  }
}

const id = classes.get('com.evony.eum.GetDataXML_XMLItem');
const xml = id !== undefined && blobs.get(id);
if (!xml) { console.error(`${file}: no GetDataXML_XMLItem asset in it`); process.exit(1); }

const items = parseItemXml(xml.toString('utf8'));
fs.writeFileSync(out, JSON.stringify({
  source: path.basename(file), extracted: new Date().toISOString(),
  items: Object.fromEntries(items),
}));
console.log(`${items.size} items -> ${path.basename(out)}`);
