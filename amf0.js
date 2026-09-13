'use strict';
// Minimal AMF0 codec (+ partial AMF3 decode for the avmplus 0x11 switch).
// Evony frames are: [4-byte BE length][AMF0 payload] where payload = {cmd, data}

function encKey(s) {
  const b = Buffer.from(s, 'utf8');
  const h = Buffer.alloc(2); h.writeUInt16BE(b.length, 0);
  return Buffer.concat([h, b]);
}

function encode(v) {
  if (v === null) return Buffer.from([0x05]);
  if (v === undefined) return Buffer.from([0x06]);
  if (typeof v === 'number') { const b = Buffer.alloc(9); b[0] = 0x00; b.writeDoubleBE(v, 1); return b; }
  if (typeof v === 'boolean') return Buffer.from([0x01, v ? 1 : 0]);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    if (b.length > 0xffff) { const h = Buffer.alloc(5); h[0] = 0x0c; h.writeUInt32BE(b.length, 1); return Buffer.concat([h, b]); }
    const h = Buffer.alloc(3); h[0] = 0x02; h.writeUInt16BE(b.length, 1); return Buffer.concat([h, b]);
  }
  if (Array.isArray(v)) {
    const h = Buffer.alloc(5); h[0] = 0x0a; h.writeUInt32BE(v.length, 1);
    return Buffer.concat([h, ...v.map(encode)]);
  }
  if (typeof v === 'object') {
    const parts = [Buffer.from([0x03])];
    for (const k of Object.keys(v)) { parts.push(encKey(k), encode(v[k])); }
    parts.push(Buffer.from([0x00, 0x00, 0x09]));
    return Buffer.concat(parts);
  }
  throw new Error('AMF0 encode: unsupported ' + typeof v);
}

function readStr(r) {
  const n = r.buf.readUInt16BE(r.pos); r.pos += 2;
  const s = r.buf.toString('utf8', r.pos, r.pos + n); r.pos += n;
  return s;
}

function readProps(r, obj) {
  for (;;) {
    const n = r.buf.readUInt16BE(r.pos); r.pos += 2;
    if (n === 0) { r.pos += 1; return obj; }           // 0x00 0x00 0x09 terminator
    const k = r.buf.toString('utf8', r.pos, r.pos + n); r.pos += n;
    obj[k] = readValue(r);
  }
}

function readValue(r) {
  const m = r.buf[r.pos++];
  switch (m) {
    case 0x00: { const v = r.buf.readDoubleBE(r.pos); r.pos += 8; return v; }
    case 0x01: return r.buf[r.pos++] !== 0;
    case 0x02: return readStr(r);
    case 0x03: return readProps(r, {});
    case 0x05: return null;
    case 0x06: return undefined;
    case 0x07: { const i = r.buf.readUInt16BE(r.pos); r.pos += 2; return { __ref: i }; }
    case 0x08: { r.pos += 4; return readProps(r, {}); }                 // ECMA array
    case 0x09: return undefined;                                        // stray object-end
    case 0x0a: { const n = r.buf.readUInt32BE(r.pos); r.pos += 4; const a = []; for (let i = 0; i < n; i++) a.push(readValue(r)); return a; }
    case 0x0b: { const ms = r.buf.readDoubleBE(r.pos); r.pos += 10; return new Date(ms); }
    case 0x0c: { const n = r.buf.readUInt32BE(r.pos); r.pos += 4; const s = r.buf.toString('utf8', r.pos, r.pos + n); r.pos += n; return s; }
    case 0x10: { const cls = readStr(r); const o = readProps(r, {}); o.__class = cls; return o; }
    case 0x11: return readAmf3(r, { strings: [], objects: [], traits: [] });
    default: throw new Error('AMF0: unknown marker 0x' + m.toString(16) + ' at ' + (r.pos - 1));
  }
}

// ---- AMF3 (decode only, enough for game payloads) ----
function u29(r) {
  let v = 0;
  for (let i = 0; i < 3; i++) {
    const b = r.buf[r.pos++];
    v = (v << 7) | (b & 0x7f);
    if (!(b & 0x80)) return v;
  }
  return (v << 8) | r.buf[r.pos++];
}

function amf3Str(r, ctx) {
  const h = u29(r);
  if ((h & 1) === 0) return ctx.strings[h >> 1];
  const n = h >> 1;
  const s = r.buf.toString('utf8', r.pos, r.pos + n); r.pos += n;
  if (n > 0) ctx.strings.push(s);
  return s;
}

function readAmf3(r, ctx) {
  const m = r.buf[r.pos++];
  switch (m) {
    case 0x00: case 0x01: return null;
    case 0x02: return false;
    case 0x03: return true;
    case 0x04: { const v = u29(r); return v > 0x0fffffff ? v - 0x20000000 : v; }
    case 0x05: { const v = r.buf.readDoubleBE(r.pos); r.pos += 8; return v; }
    case 0x06: return amf3Str(r, ctx);
    case 0x08: { const h = u29(r); if ((h & 1) === 0) return ctx.objects[h >> 1]; const ms = r.buf.readDoubleBE(r.pos); r.pos += 8; const d = new Date(ms); ctx.objects.push(d); return d; }
    case 0x09: {
      const h = u29(r);
      if ((h & 1) === 0) return ctx.objects[h >> 1];
      const dense = h >> 1; const out = []; ctx.objects.push(out);
      for (;;) { const k = amf3Str(r, ctx); if (k === '') break; out[k] = readAmf3(r, ctx); }
      for (let i = 0; i < dense; i++) out.push(readAmf3(r, ctx));
      return out;
    }
    case 0x0a: {
      const h = u29(r);
      if ((h & 1) === 0) return ctx.objects[h >> 1];
      let traits;
      if ((h & 3) === 1) { traits = ctx.traits[h >> 2]; }
      else {
        const ext = (h & 4) !== 0, dyn = (h & 8) !== 0, count = h >> 4;
        const cls = amf3Str(r, ctx);
        traits = { cls, dyn, ext, props: [] };
        if (!ext) for (let i = 0; i < count; i++) traits.props.push(amf3Str(r, ctx));
        ctx.traits.push(traits);
      }
      const obj = {}; ctx.objects.push(obj);
      if (traits.cls) obj.__class = traits.cls;
      for (const p of traits.props) obj[p] = readAmf3(r, ctx);
      if (traits.dyn) for (;;) { const k = amf3Str(r, ctx); if (k === '') break; obj[k] = readAmf3(r, ctx); }
      return obj;
    }
    default: throw new Error('AMF3: unknown marker 0x' + m.toString(16) + ' at ' + (r.pos - 1));
  }
}

function decode(buf) { return readValue({ buf, pos: 0 }); }

module.exports = { encode, decode };
