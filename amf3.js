'use strict';
// AMF3 codec. Encoder writes everything inline (no reference tables -- legal, just larger).
// Decoder implements the reference tables, since the server does use them.

function writeU29(n) {
  n = n >>> 0;
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x4000) return Buffer.from([(n >> 7) | 0x80, n & 0x7f]);
  if (n < 0x200000) return Buffer.from([(n >> 14) | 0x80, ((n >> 7) & 0x7f) | 0x80, n & 0x7f]);
  return Buffer.from([(n >> 22) | 0x80, ((n >> 15) & 0x7f) | 0x80, ((n >> 8) & 0x7f) | 0x80, n & 0xff]);
}

// UTF-8-vr: (length << 1) | 1, then bytes. Empty string is the single byte 0x01.
function vr(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([writeU29((b.length << 1) | 1), b]);
}

const EMPTY = Buffer.from([0x01]);

function encode(v) {
  if (v === null || v === undefined) return Buffer.from([0x01]);
  if (typeof v === 'boolean') return Buffer.from([v ? 0x03 : 0x02]);
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= -0x10000000 && v < 0x10000000) {
      return Buffer.concat([Buffer.from([0x04]), writeU29(v < 0 ? v + 0x20000000 : v)]);
    }
    const b = Buffer.alloc(9); b[0] = 0x05; b.writeDoubleBE(v, 1); return b;
  }
  if (typeof v === 'string') return Buffer.concat([Buffer.from([0x06]), vr(v)]);
  if (Array.isArray(v)) {
    const parts = [Buffer.from([0x09]), writeU29((v.length << 1) | 1), EMPTY];
    for (const x of v) parts.push(encode(x));
    return Buffer.concat(parts);
  }
  if (typeof v === 'object') {
    // anonymous dynamic object: U29O-traits 0x0B (dynamic, 0 sealed props) + empty class name
    const parts = [Buffer.from([0x0a, 0x0b]), EMPTY];
    for (const k of Object.keys(v)) { parts.push(vr(k), encode(v[k])); }
    parts.push(EMPTY);
    return Buffer.concat(parts);
  }
  throw new Error('AMF3 encode: unsupported ' + typeof v);
}

// ---------------- decode ----------------

function newCtx() { return { strings: [], objects: [], traits: [] }; }

function u29(r) {
  let v = 0;
  for (let i = 0; i < 3; i++) {
    const b = r.buf[r.pos++];
    v = (v << 7) | (b & 0x7f);
    if (!(b & 0x80)) return v >>> 0;
  }
  return (((v << 8) | r.buf[r.pos++]) >>> 0);
}

function readStr(r, ctx) {
  const h = u29(r);
  if ((h & 1) === 0) return ctx.strings[h >> 1];
  const n = h >> 1;
  const s = r.buf.toString('utf8', r.pos, r.pos + n); r.pos += n;
  if (n > 0) ctx.strings.push(s);
  return s;
}

function readValue(r, ctx) {
  const m = r.buf[r.pos++];
  switch (m) {
    case 0x00: case 0x01: return null;
    case 0x02: return false;
    case 0x03: return true;
    case 0x04: { const v = u29(r); return v > 0x0fffffff ? v - 0x20000000 : v; }
    case 0x05: { const v = r.buf.readDoubleBE(r.pos); r.pos += 8; return v; }
    case 0x06: return readStr(r, ctx);
    case 0x08: {
      const h = u29(r);
      if ((h & 1) === 0) return ctx.objects[h >> 1];
      const ms = r.buf.readDoubleBE(r.pos); r.pos += 8;
      const d = new Date(ms); ctx.objects.push(d); return d;
    }
    case 0x09: {
      const h = u29(r);
      if ((h & 1) === 0) return ctx.objects[h >> 1];
      const dense = h >> 1;
      const out = []; ctx.objects.push(out);
      for (;;) { const k = readStr(r, ctx); if (k === '') break; out[k] = readValue(r, ctx); }
      for (let i = 0; i < dense; i++) out.push(readValue(r, ctx));
      return out;
    }
    case 0x0a: {
      const h = u29(r);
      if ((h & 1) === 0) return ctx.objects[h >> 1];
      let traits;
      if ((h & 3) === 1) {
        traits = ctx.traits[h >> 2];
      } else {
        const ext = (h & 4) !== 0, dyn = (h & 8) !== 0, count = h >> 4;
        const cls = readStr(r, ctx);
        traits = { cls, dyn, ext, props: [] };
        if (!ext) for (let i = 0; i < count; i++) traits.props.push(readStr(r, ctx));
        ctx.traits.push(traits);
      }
      const obj = {}; ctx.objects.push(obj);
      if (traits.cls) obj.__class = traits.cls;
      for (const p of traits.props) obj[p] = readValue(r, ctx);
      if (traits.dyn) for (;;) { const k = readStr(r, ctx); if (k === '') break; obj[k] = readValue(r, ctx); }
      return obj;
    }
    case 0x0b: { const s = readStr(r, ctx); return s; }                     // XMLDocument
    case 0x0c: {                                                            // ByteArray
      const h = u29(r);
      if ((h & 1) === 0) return ctx.objects[h >> 1];
      const n = h >> 1; const b = r.buf.subarray(r.pos, r.pos + n); r.pos += n;
      ctx.objects.push(b); return b;
    }
    default: throw new Error('AMF3: unknown marker 0x' + m.toString(16) + ' at ' + (r.pos - 1));
  }
}

function decode(buf) { return readValue({ buf, pos: 0 }, newCtx()); }

module.exports = { encode, decode, readValue, newCtx, writeU29, vr };
