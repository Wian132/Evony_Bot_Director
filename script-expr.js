'use strict';
// The script language's expressions (NEAT's Operators, Strings, Arrays, JSON and
// CreateFunction pages): a tokenizer, a parser to a small AST and an async
// evaluator. No eval, no Function, no vm — scripts are user text, so this is a
// sandbox: __proto__/prototype/constructor (and every __name) are never read or
// written, prototype methods are whitelisted, and a script only ever holds
// plain data and callables the globals hand it.
//
//   numbers      12  1.5  0x1f  1e3  20k 1.5m 2b (k/m/b = thousand/million/billion)  2% (= 0.02)
//   strings      "a\tb {x + 1}"  (escapes; {expr} is filled in)   'no {filling} here'
//                a { that is not a whole expression stays as it is; \{ is always a {
//   literals     true false null undefined NaN Infinity  [1, "a", [2]]  {a: 1, "b c": 2}  /re/gi
//   operators    ?:  || or  && and  |  ^  &  == = != <> === !==  < <= > >= is in
//                << >> >>>  + -  * / % MOD  ! - + ~  a.b  a[i]  f(x)  ++ -- += -= *= /= %=
//                (= compares inside an expression, like NEAT's `if a = 1`; a statement
//                 `x = 1` assigns — see parseStatement)
//   calls        every call is awaited; so is every member or index read that gives a
//                Promise, so globals may be async. (a + b) (c - 1) multiplies (NEAT).
//   methods      strings, numbers, arrays, Dates and RegExps get a whitelist of the
//                usual methods; forEach map filter some every find findIndex reduce
//                sort sortOn toArray run here, so a callback may be a script function
//   CreateFunction("v,i,a", "expr")   a script function; the body may assign
//                (`total += x`) and reads the script's variables when it runs
//
// A function that wants NEAT's unquoted arguments (IsHeroInCastle(any:att>200))
// sets its own property rawArgs = true: when the argument text is not an
// expression, or is one bare name nothing defines, it gets that text as a string.
//
// Scope: identifiers resolve through a Scope (function arguments, then the
// script's variables, then $result/$error, then the global layers in order).
//
// Every regex match (test exec match matchAll search split replace replaceAll,
// with a regex or with text that JavaScript turns into one) runs in
// script-regex.js's worker with a time limit: a runaway pattern fails its line
// instead of freezing the console.

const R = require('./script-regex');

const SCRIPT_FN = Symbol('scriptFunction');
const SCOPED = Symbol('scopedBuiltin');

class ExprError extends Error {
  constructor(msg, pos) {
    super(pos === undefined ? msg : `${msg} (column ${pos + 1})`);
    this.bare = msg;
    this.pos = pos;
  }
}

const BLOCKED = new Set(['__proto__', 'prototype', 'constructor', '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__', 'caller', 'callee', 'arguments']);
const blockedKey = (k) => typeof k === 'string' && (BLOCKED.has(k) || k.startsWith('__'));
// A script-made object with a callable `then` would be taken for a Promise by
// every await, and a script function there would hang the run: never set one.
const blockedWrite = (k) => blockedKey(k) || k === 'then';

// ------------------------------------------------------------------- tokenizer

const OPS = ['===', '!==', '>>>', '<<', '>>', '<=', '>=', '==', '!=', '<>', '&&', '||', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '=', '+', '-', '*', '/', '%', '<', '>', '!', '~', '&', '|', '^',
  '?', ':', '.', ',', '(', ')', '[', ']', '{', '}'];
const WORD_OPS = new Set(['and', 'or', 'mod']);          // any case
const EXACT_WORD_OPS = new Set(['is', 'in']);            // lower case only
const LITERALS = { true: true, false: false, null: null, undefined: undefined, NaN: NaN, Infinity: Infinity };
const isWordOp = (t) => t && t.t === 'id' && (WORD_OPS.has(t.v.toLowerCase()) || EXACT_WORD_OPS.has(t.v));
const wordOp = (t) => (EXACT_WORD_OPS.has(t.v) ? t.v : t.v.toLowerCase());

const ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

// The index of the } that closes the { at j, skipping quoted text, or -1.
function findClose(src, j) {
  let depth = 0;
  for (let k = j; k < src.length; k++) {
    const c = src[k];
    if (c === '\\') { k++; continue; }
    if (c === '"' || c === "'") {
      let q = k + 1;
      while (q < src.length && src[q] !== c) q += src[q] === '\\' ? 2 : 1;
      if (q >= src.length) return -1;
      k = q;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return k;
  }
  return -1;
}

class Lexer {
  constructor(src, base = 0) {
    this.src = src;
    this.base = base;
    this.i = 0;
    this.buf = [];
    this.last = null;       // the last token scanned (for regex vs division)
  }
  peek(k = 0) { while (this.buf.length <= k) this.buf.push(this.scan()); return this.buf[k]; }
  next() { const t = this.peek(); this.buf.shift(); return t; }
  reset(i, last) { this.i = i; this.buf = []; this.last = last; }
  err(msg, at) { return new ExprError(msg, this.base + at); }

  regexAllowed() {
    const p = this.last;
    if (!p) return true;
    if (p.t === 'op') return ![')', ']', '}', '++', '--'].includes(p.v);
    if (p.t === 'id') return isWordOp(p);
    return false;
  }

  scan() {
    const src = this.src;
    const start0 = this.i;
    while (this.i < src.length && /\s/.test(src[this.i])) this.i++;
    const ws = this.i > start0;
    const s = this.i;
    const tok = (t, v, e) => { this.i = e; const k = { t, v, s, e, ws }; this.last = k; return k; };
    if (s >= src.length) return { t: 'eof', v: '', s, e: s, ws };
    const c = src[s];
    const rest = src.slice(s);

    if (/\d/.test(c) || (c === '.' && /\d/.test(src[s + 1] || ''))) {
      const m = /^(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(rest);
      let v = Number(m[0]);
      let e = s + m[0].length;
      const suf = src[e];
      if (suf && /[kmb]/i.test(suf) && !/[\w$]/.test(src[e + 1] || '')) {
        v *= { k: 1e3, m: 1e6, b: 1e9 }[suf.toLowerCase()];
        e++;
      }
      if (src[e] === '%') { v /= 100; e++; }
      // 5k is 5000 exactly; 1.1m should not come out 1100000.0000000002
      if (!Number.isInteger(v) && Number.isFinite(v)) v = Number(v.toPrecision(15));
      return tok('num', v, e);
    }
    if (c === '"' || c === "'") return this.scanString(c, s, tok);
    if (c === '/' && this.regexAllowed()) return this.scanRegex(s, tok);
    const id = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (id) return tok('id', id[0], s + id[0].length);
    for (const op of OPS) if (rest.startsWith(op)) return tok('op', op, s + op.length);
    throw this.err(`unexpected "${c}"`, s);
  }

  scanString(q, s, tok) {
    const src = this.src;
    const parts = [];
    let buf = '';
    let j = s + 1;
    for (;;) {
      if (j >= src.length) throw this.err('this string has no closing ' + q, s);
      const ch = src[j];
      if (ch === q) { j++; break; }
      if (ch === '\\') {
        const n = src[j + 1];
        if (n === undefined) { buf += '\\'; j++; continue; }
        if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(src.slice(j + 2, j + 4))) {
          buf += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16)); j += 4; continue;
        }
        if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(j + 2, j + 6))) {
          buf += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 6; continue;
        }
        buf += n in ESC ? ESC[n] : n;
        j += 2;
        continue;
      }
      if (q === '"' && ch === '{') {
        const close = findClose(src, j);
        if (close > j) {
          try {
            const ast = parseExpression(src.slice(j + 1, close), this.base + j + 1);
            if (buf) parts.push(buf);
            parts.push(ast);
            buf = '';
            j = close + 1;
            continue;
          } catch (e) { if (!(e instanceof ExprError)) throw e; }
        }
      }
      buf += ch;
      j++;
    }
    if (!parts.length) return tok('str', buf, j);
    if (buf) parts.push(buf);
    return tok('tpl', parts, j);
  }

  scanRegex(s, tok) {
    const src = this.src;
    let j = s + 1;
    let inClass = false;
    for (;;) {
      if (j >= src.length || src[j] === '\n') throw this.err('this regular expression has no closing /', s);
      const ch = src[j];
      if (ch === '\\') { j += 2; continue; }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) break;
      j++;
    }
    const pattern = src.slice(s + 1, j);
    const flags = /^[a-z]*/.exec(src.slice(j + 1))[0];
    try { new RegExp(pattern, flags); } catch (e) { throw this.err('bad regular expression: ' + e.message, s); }
    return tok('re', { pattern, flags }, j + 1 + flags.length);
  }
}

// ---------------------------------------------------------------------- parser

const BIN_PREC = {
  '||': 1, or: 1, '&&': 2, and: 2, '|': 3, '^': 4, '&': 5,
  '==': 6, '=': 6, '!=': 6, '<>': 6, '===': 6, '!==': 6,
  '<': 7, '<=': 7, '>': 7, '>=': 7, is: 7, in: 7,
  '<<': 8, '>>': 8, '>>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10, mod: 10,
};
const COMPOUND = new Set(['+=', '-=', '*=', '/=', '%=']);
const LVALUE = new Set(['id', 'member', 'index']);

class Parser {
  // list: NEAT's juxtaposition (echo a b "c"): a ( or [ after a space starts a
  // new item instead of calling or indexing the one before.
  constructor(src, base = 0, { list = false } = {}) {
    this.src = src;
    this.lx = new Lexer(src, base);
    this.base = base;
    this.list = list;
  }
  err(msg, t) { return new ExprError(msg, this.base + t.s); }
  unexpected(t) {
    if (t.t === 'eof') return this.err('the expression ends too soon', t);
    const shown = t.t === 'str' || t.t === 'tpl' ? 'a string' : t.t === 'num' ? String(t.v) : `"${this.src.slice(t.s, t.e)}"`;
    return this.err(`unexpected ${shown}`, t);
  }
  isOp(t, v) { return t.t === 'op' && t.v === v; }
  expect(v) {
    const t = this.lx.next();
    if (!this.isOp(t, v)) throw this.unexpected(t);
    return t;
  }

  expression() { return this.ternary(); }

  ternary() {
    const test = this.binary(1);
    if (!this.isOp(this.lx.peek(), '?')) return test;
    this.lx.next();
    const then = this.ternary();
    this.expect(':');
    const other = this.ternary();
    return { type: 'cond', test, then, else: other, s: test.s, e: other.e, src: this.src, base: this.base };
  }

  binOp(t) {
    if (t.t === 'op' && BIN_PREC[t.v] !== undefined) return t.v;
    if (isWordOp(t)) return wordOp(t);
    return null;
  }

  binary(min) {
    let left = this.unary();
    for (;;) {
      const t = this.lx.peek();
      const op = this.binOp(t);
      if (!op || BIN_PREC[op] < min) return left;
      this.lx.next();
      const right = this.binary(BIN_PREC[op] + 1);
      const type = op === '&&' || op === 'and' || op === '||' || op === 'or' ? 'logic' : 'bin';
      const norm = op === 'and' ? '&&' : op === 'or' ? '||' : op === '=' ? '==' : op === '<>' ? '!=' : op === 'mod' ? '%' : op;
      left = { type, op: norm, left, right, s: left.s, e: right.e, src: this.src, base: this.base };
    }
  }

  unary() {
    const t = this.lx.peek();
    if (t.t === 'op' && ['!', '-', '+', '~'].includes(t.v)) {
      this.lx.next();
      const arg = this.unary();
      return { type: 'unary', op: t.v, arg, s: t.s, e: arg.e, src: this.src, base: this.base };
    }
    if (t.t === 'op' && (t.v === '++' || t.v === '--')) {
      this.lx.next();
      const target = this.postfix();
      if (!LVALUE.has(target.type)) throw this.err(`${t.v} needs a variable after it`, t);
      return { type: 'update', op: t.v, prefix: true, target, s: t.s, e: target.e, src: this.src, base: this.base };
    }
    return this.postfix();
  }

  postfix() {
    let n = this.primary();
    for (;;) {
      const t = this.lx.peek();
      if (this.isOp(t, '.')) {
        this.lx.next();
        const name = this.lx.next();
        if (name.t !== 'id') throw this.err('a name must follow the dot', name);
        if (blockedKey(name.v)) throw this.err(`"${name.v}" cannot be read`, name);
        n = { type: 'member', obj: n, name: name.v, s: n.s, e: name.e, src: this.src, base: this.base };
        continue;
      }
      if (this.isOp(t, '[')) {
        if (this.list && t.ws) return n;
        this.lx.next();
        const index = this.expression();
        const close = this.expect(']');
        n = { type: 'index', obj: n, index, s: n.s, e: close.e, src: this.src, base: this.base };
        continue;
      }
      if (this.isOp(t, '(')) {
        if (this.list && t.ws) return n;
        n = this.call(n);
        continue;
      }
      if (t.t === 'op' && (t.v === '++' || t.v === '--') && LVALUE.has(n.type)) {
        this.lx.next();
        return { type: 'update', op: t.v, prefix: false, target: n, s: n.s, e: t.e, src: this.src, base: this.base };
      }
      if (t.t === 'op' && COMPOUND.has(t.v) && LVALUE.has(n.type)) {
        this.lx.next();
        const value = this.ternary();
        return { type: 'assign', op: t.v, target: n, value, s: n.s, e: value.e, src: this.src, base: this.base };
      }
      return n;
    }
  }

  call(callee) {
    const open = this.lx.next();
    const args = [];
    try {
      if (!this.isOp(this.lx.peek(), ')')) {
        for (;;) {
          args.push(this.expression());
          const t = this.lx.next();
          if (this.isOp(t, ')')) break;
          if (!this.isOp(t, ',')) throw this.unexpected(t);
        }
      } else this.lx.next();
      return { type: 'call', callee, args, s: callee.s, e: this.lx.last.e, src: this.src, base: this.base };
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      // NEAT's unquoted text, IsHeroInCastle(any:att>200): kept whole for a
      // function that asks for it (rawArgs); anything with quotes or brackets
      // in it is a real mistake.
      let depth = 1, k = open.e;
      for (; k < this.src.length && depth; k++) {
        if (this.src[k] === '(') depth++;
        else if (this.src[k] === ')') depth--;
      }
      const raw = this.src.slice(open.e, k - 1);
      if (depth || /["'()[\]{}]/.test(raw)) throw e;
      this.lx.reset(k, { t: 'op', v: ')', s: k - 1, e: k });
      return { type: 'call', callee, args: [], rawText: raw.trim(), s: callee.s, e: k, src: this.src, base: this.base };
    }
  }

  primary() {
    const t = this.lx.next();
    const n = (type, props) => ({ type, s: t.s, e: t.e, src: this.src, base: this.base, ...props });
    if (t.t === 'num') return n('num', { value: t.v });
    if (t.t === 'str') return n('str', { value: t.v });
    if (t.t === 'tpl') return n('tpl', { parts: t.v });
    if (t.t === 're') return n('re', { pattern: t.v.pattern, flags: t.v.flags });
    if (t.t === 'id') {
      if (Object.prototype.hasOwnProperty.call(LITERALS, t.v)) return n('lit', { value: LITERALS[t.v] });
      if (isWordOp(t)) throw this.unexpected(t);
      if (blockedKey(t.v)) throw this.err(`"${t.v}" cannot be used`, t);
      return n('id', { name: t.v });
    }
    if (this.isOp(t, '(')) {
      const inner = this.expression();
      const close = this.expect(')');
      return { ...inner, paren: true, s: t.s, e: close.e };
    }
    if (this.isOp(t, '[')) {
      const items = [];
      if (this.isOp(this.lx.peek(), ']')) { const c = this.lx.next(); return { ...n('arr', { items }), e: c.e }; }
      for (;;) {
        items.push(this.expression());
        const sep = this.lx.next();
        if (this.isOp(sep, ']')) return { ...n('arr', { items }), e: sep.e };
        if (!this.isOp(sep, ',')) throw this.unexpected(sep);
        if (this.isOp(this.lx.peek(), ']')) { const c = this.lx.next(); return { ...n('arr', { items }), e: c.e }; }
      }
    }
    if (this.isOp(t, '{')) {
      const props = [];
      for (;;) {
        const k = this.lx.next();
        if (this.isOp(k, '}')) return { ...n('obj', { props }), e: k.e };
        let key;
        if (k.t === 'id' || k.t === 'str') key = k.v;
        else if (k.t === 'num') key = String(k.v);
        else throw this.unexpected(k);
        if (blockedWrite(key)) throw this.err(`"${key}" cannot be a key`, k);
        this.expect(':');
        props.push({ key, value: this.expression() });
        const sep = this.lx.next();
        if (this.isOp(sep, '}')) return { ...n('obj', { props }), e: sep.e };
        if (!this.isOp(sep, ',')) throw this.unexpected(sep);
      }
    }
    throw this.unexpected(t);
  }

  end() {
    const t = this.lx.peek();
    if (t.t !== 'eof') throw this.unexpected(t);
  }
}

// A whole expression.
function parseExpression(src, base = 0) {
  const p = new Parser(String(src), base);
  const ast = p.expression();
  p.end();
  return ast;
}

// As much of src from `start` as reads as one expression — `if $error goto x`
// takes `$error` and leaves `goto x`. end is where the rest begins.
function parsePrefix(src, start = 0, base = 0) {
  const text = String(src);
  const p = new Parser(text, base);
  p.lx.i = start;
  const ast = p.expression();
  const t = p.lx.peek();
  return { ast, end: t.t === 'eof' ? text.length : t.s };
}

// echo's list: expressions side by side, printed with a space between.
function parseList(src, base = 0) {
  const p = new Parser(String(src), base, { list: true });
  const items = [];
  while (p.lx.peek().t !== 'eof') items.push(p.expression());
  return items;
}

// Where an assignment's target ends, if the text starts with one: a name, then
// any .name or [..], then = (not ==), += -= *= /= %=, ++ or --.
function assignmentStart(src) {
  const s = String(src);
  if (/^(\+\+|--)\s*[A-Za-z_$]/.test(s)) return true;
  const id = /^[A-Za-z_$][\w$]*/.exec(s);
  if (!id) return false;
  let k = id[0].length;
  for (;;) {
    const m = /^\s*\.\s*[A-Za-z_$][\w$]*/.exec(s.slice(k));
    if (m) { k += m[0].length; continue; }
    const b = /^\s*\[/.exec(s.slice(k));
    if (!b) break;
    let depth = 0, j = k + b[0].length - 1;
    for (; j < s.length; j++) {
      const c = s[j];
      if (c === '"' || c === "'") { let q = j + 1; while (q < s.length && s[q] !== c) q += s[q] === '\\' ? 2 : 1; j = q; continue; }
      if (c === '[') depth++;
      else if (c === ']' && --depth === 0) break;
    }
    if (j >= s.length) return false;
    k = j + 1;
  }
  return /^\s*(=(?!=)|\+=|-=|\*=|\/=|%=|\+\+|--)/.test(s.slice(k));
}

// A statement: `x = expr` assigns; anything else is an expression (which may
// itself assign with += -= *= /= %= ++ --, as CreateFunction bodies do).
function parseStatement(src, base = 0) {
  const text = String(src);
  const p = new Parser(text, base);
  const t0 = p.lx.peek();
  if (t0.t === 'id' && !LITERALS.hasOwnProperty(t0.v) && !isWordOp(t0)) {
    const target = p.postfix();
    const t = p.lx.peek();
    if (LVALUE.has(target.type) && p.isOp(t, '=')) {
      p.lx.next();
      const value = p.expression();
      p.end();
      return { type: 'assign', op: '=', target, value, s: target.s, e: value.e, src: text, base };
    }
  }
  return parseExpression(text, base);
}

// ------------------------------------------------------------------- values

const isScriptFunction = (f) => typeof f === 'function' && !!f[SCRIPT_FN];
function makeScriptFunction(impl, info = {}) {
  const f = async (...args) => impl(args);
  Object.defineProperty(f, SCRIPT_FN, { value: info });
  return f;
}

const OBJ_TOSTRING = Object.prototype.toString;
const OBJ_VALUEOF = Object.prototype.valueOf;
const isObj = (v) => v !== null && (typeof v === 'object' || typeof v === 'function');

// Text for echo, + and "{x}". An object's own toString is used only when it is
// real JS code (a class method, a Date), never a script function stored on it.
function toStr(v, depth = 0) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string': return v;
    case 'number': case 'boolean': case 'bigint': return String(v);
    case 'symbol': return 'symbol';
    case 'function': return 'function Function() {}';
    default: break;
  }
  if (depth > 20) return '...';
  if (Array.isArray(v)) return v.map((x) => (x === null || x === undefined ? '' : toStr(x, depth + 1))).join(',');
  if (v instanceof Promise) return '[object Promise]';
  let t;
  try { t = v.toString; } catch { t = null; }
  if (typeof t === 'function' && t !== OBJ_TOSTRING && !isScriptFunction(t)) {
    const r = t.call(v);
    return typeof r === 'string' ? r : r instanceof Promise ? '[object Promise]' : String(r);
  }
  return '[object Object]';
}

function toPrim(v, hint = 'default') {
  if (!isObj(v)) return v;
  if (v instanceof Date) {
    if (hint === 'number') { const vo = v.valueOf(); return typeof vo === 'number' ? vo : v.getTime(); }
    return toStr(v);
  }
  if (Array.isArray(v) || typeof v === 'function') return toStr(v);
  let vo;
  try { vo = v.valueOf; } catch { vo = null; }
  if (typeof vo === 'function' && vo !== OBJ_VALUEOF && !isScriptFunction(vo)) {
    const r = vo.call(v);
    if (!isObj(r)) return r;
  }
  return toStr(v);
}
const toNum = (v) => Number(toPrim(v, 'number'));
const truthy = (v) => !!v;

function looseEq(a, b) {
  if (a === b) return true;
  const ao = isObj(a), bo = isObj(b);
  if (ao && bo) return false;
  // eslint-disable-next-line eqeqeq
  return (ao ? toPrim(a) : a) == (bo ? toPrim(b) : b);
}

function isType(v, name) {
  const n = String(name);
  switch (n.toLowerCase()) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number';
    case 'int': return typeof v === 'number' && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
    case 'uint': return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 4294967295;
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return isObj(v);
    case 'function': return typeof v === 'function';
    case 'date': return v instanceof Date;
    case 'regexp': return v instanceof RegExp;
    case 'null': return v === null;
    case 'undefined': case 'void': return v === undefined;
    default: break;
  }
  for (let p = isObj(v) ? Object.getPrototypeOf(v) : null; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, 'constructor');
    if (d && typeof d.value === 'function' && d.value.name === n) return true;
  }
  return false;
}

const BUILTIN_PROTOS = new Set([Object.prototype, Array.prototype, Function.prototype, String.prototype,
  Number.prototype, Boolean.prototype, Date.prototype, RegExp.prototype, Promise.prototype,
  Map.prototype, Set.prototype, Error.prototype, Symbol.prototype]);
const SAFE_OBJECT_METHODS = new Set(['toString', 'valueOf', 'hasOwnProperty', 'toLocaleString', 'propertyIsEnumerable']);

// Is `key` defined by class code (not a built-in prototype) somewhere up the chain?
function classMember(obj, key) {
  for (let p = Object.getPrototypeOf(obj); p; p = Object.getPrototypeOf(p)) {
    if (BUILTIN_PROTOS.has(p)) return false;
    if (Object.prototype.hasOwnProperty.call(p, key)) return true;
  }
  return false;
}

const STRING_METHODS = new Set(['charAt', 'charCodeAt', 'codePointAt', 'endsWith', 'includes', 'indexOf',
  'lastIndexOf', 'localeCompare', 'normalize', 'search', 'slice', 'split', 'startsWith', 'substr',
  'substring', 'toLowerCase', 'toUpperCase', 'toLocaleLowerCase', 'toLocaleUpperCase', 'trim',
  'trimStart', 'trimEnd', 'valueOf', 'toString', 'at']);
const NUMBER_METHODS = new Set(['toFixed', 'toPrecision', 'toString', 'toLocaleString', 'valueOf', 'toExponential']);
const DATE_METHODS = new Set(Object.getOwnPropertyNames(Date.prototype)
  .filter((k) => /^(get|set|to)[A-Z]/.test(k) || k === 'valueOf'));
const REGEXP_METHODS = new Set(['test', 'exec', 'toString']);
const REGEXP_PROPS = new Set(['source', 'flags', 'global', 'ignoreCase', 'multiline', 'sticky', 'unicode', 'dotAll', 'lastIndex']);
const ARRAY_PLAIN = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'slice', 'concat', 'indexOf',
  'lastIndexOf', 'includes', 'reverse', 'fill', 'flat', 'at']);
const MAX_TEXT = 1e7;

const describe = (n) => (n && n.src ? n.src.slice(n.s, n.e).trim() : 'that');

// NEAT's wiki writes built-in methods in any case (myVar.subStr(3,2),
// string.toupperCase(), array.IndexOf()): the exact name, else the one that
// differs from it only in case. Beans' own members stay exact.
const CI_NAMES = new Map();
function methodName(kind, k) {
  const exact = kind === 'string' ? STRING_METHODS.has(k) || !!STRING_ASYNC[k]
    : kind === 'array' ? ARRAY_PLAIN.has(k) || !!ARRAY_ASYNC[k]
      : kind === 'number' ? NUMBER_METHODS.has(k) : DATE_METHODS.has(k);
  if (exact) return k;
  let m = CI_NAMES.get(kind);
  if (!m) {
    const names = kind === 'string' ? [...STRING_METHODS, ...Object.keys(STRING_ASYNC)]
      : kind === 'array' ? [...ARRAY_PLAIN, ...Object.keys(ARRAY_ASYNC)]
        : kind === 'number' ? [...NUMBER_METHODS] : [...DATE_METHODS];
    m = new Map(names.map((x) => [x.toLowerCase(), x]));
    CI_NAMES.set(kind, m);
  }
  return m.get(String(k).toLowerCase()) || null;
}

// A value's member, the way a script may see it.
function getMember(obj, key, node) {
  if (obj === null || obj === undefined) {
    throw new Error(`${describe(node && node.obj)} is ${obj === null ? 'null' : 'undefined'}, so it has no ${typeof key === 'string' ? '.' + key : '[' + key + ']'}`);
  }
  if (typeof key !== 'string' && typeof key !== 'number') key = toStr(key);
  if (blockedKey(key)) throw new Error(`"${key}" cannot be read`);
  const k = String(key);
  switch (typeof obj) {
    case 'string': {
      if (k === 'length') return obj.length;
      if (/^\d+$/.test(k)) return obj[Number(k)];
      const m = methodName('string', k);
      return m ? (...a) => stringMethod(obj, m, a) : undefined;
    }
    case 'number': {
      const m = methodName('number', k);
      return m ? (...a) => obj[m](...a) : undefined;
    }
    case 'boolean':
      return k === 'toString' || k === 'valueOf' ? () => obj[k]() : undefined;
    case 'function':
      return Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined;
    default: break;
  }
  if (Array.isArray(obj)) {
    if (k === 'length') return obj.length;
    if (/^\d+$/.test(k)) return obj[Number(k)];
    if (Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
    const m = methodName('array', k);
    if (m) return (...a) => ARRAY_ASYNC[m] ? ARRAY_ASYNC[m](obj, a, null) : obj[m](...a);
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
  if (classMember(obj, k)) return obj[k];
  if (obj instanceof Date) { const m = methodName('date', k); return m ? (...a) => obj[m](...a) : undefined; }
  if (obj instanceof RegExp) {
    if (REGEXP_PROPS.has(k)) return obj[k];
    if (k === 'test' || k === 'exec') return (s) => R[k](obj, toStr(s));
    return REGEXP_METHODS.has(k) ? (...a) => obj[k](...a) : undefined;
  }
  if (SAFE_OBJECT_METHODS.has(k) && k in obj) return obj[k];
  return undefined;
}

// obj.key(...) run by the evaluator itself, or null to call the member found.
function builtinMethod(obj, key) {
  if (typeof key !== 'string') return null;
  if (typeof obj === 'string') {
    if (blockedKey(key)) return null;
    const m = methodName('string', key);
    return m ? (args, scope) => stringMethod(obj, m, args, scope) : null;
  }
  if (Array.isArray(obj)) {
    if (Object.prototype.hasOwnProperty.call(obj, key) || blockedKey(key)) return null;
    const m = methodName('array', key);
    if (m && ARRAY_ASYNC[m]) return (args, scope) => ARRAY_ASYNC[m](obj, args, scope);
    if (m) return (args) => obj[m](...args);
    return null;
  }
  return null;
}

async function stringMethod(str, key, args, scope) {
  if (STRING_ASYNC[key]) return STRING_ASYNC[key](str, args, scope);
  const r = String.prototype[key].apply(str, args);
  return r;
}

const capText = (s) => { if (s.length > MAX_TEXT) throw new Error('that text would be longer than 10 million characters'); return s; };

// String methods that call back into the script, or build long text.
const STRING_ASYNC = Object.assign(Object.create(null), {
  concat:(s, a) => capText(s + a.map((x) => toStr(x)).join('')),
  repeat: (s, a) => { if (s.length * Math.max(0, Number(a[0]) || 0) > MAX_TEXT) capText('x'.repeat(MAX_TEXT + 1)); return s.repeat(a[0]); },
  padStart: (s, a) => { if (Number(a[0]) > MAX_TEXT) capText('x'.repeat(MAX_TEXT + 1)); return s.padStart(a[0], a[1]); },
  padEnd: (s, a) => { if (Number(a[0]) > MAX_TEXT) capText('x'.repeat(MAX_TEXT + 1)); return s.padEnd(a[0], a[1]); },
  // The regex ones run in script-regex.js's worker. Text given where JavaScript
  // makes a regex of it (match, matchAll, search) is a regex there too.
  match: (s, a) => R.match(s, toRegex(a[0], '')),
  matchAll: (s, a) => {
    const re = toRegex(a[0], 'g');
    if (!re.global) throw new Error('matchAll needs a regular expression with the g flag, e.g. /x/g');
    return R.matchAll(s, re);
  },
  search: (s, a) => R.search(s, toRegex(a[0], '')),
  split: (s, a) => (a[0] instanceof RegExp ? R.split(s, a[0], a[1]) : s.split(a[0] === undefined ? undefined : toStr(a[0]), a[1])),
  replace: (s, a, scope) => replaceText(s, a[0], a[1], false, scope),
  replaceAll: (s, a, scope) => replaceText(s, a[0], a[1], true, scope),
  // AS3's (avmplus String::localeCompare): the first differing character code of
  // this string less the other's, else the length difference — the Strings page
  // shows "def".localeCompare("abc") as 3; a sort reads only the sign
  localeCompare: (s, a) => {
    const o = toStr(a[0]);
    for (let i = 0; i < Math.min(s.length, o.length); i++) if (s.charCodeAt(i) !== o.charCodeAt(i)) return s.charCodeAt(i) - o.charCodeAt(i);
    return s.length - o.length;
  },
});

// What String.prototype.match/matchAll/search make of a non-regex argument.
function toRegex(x, flags) {
  if (x instanceof RegExp) return x;
  return new RegExp(x === undefined ? '(?:)' : toStr(x), flags);
}

async function replaceText(s, pattern, repl, all, scope) {
  const pat = pattern instanceof RegExp ? pattern : toStr(pattern);
  if (all && pat instanceof RegExp && !pat.global) throw new Error('replaceAll needs a regular expression with the g flag, e.g. /x/g');
  if (typeof repl !== 'function') {
    if (pat instanceof RegExp) return capText(await (all ? R.replaceAll(s, pat, toStr(repl)) : R.replace(s, pat, toStr(repl))));
    return capText(all ? s.replaceAll(pat, toStr(repl)) : s.replace(pat, toStr(repl)));
  }
  // a callback may be a script function: collect the matches, then await each
  const re = pat instanceof RegExp
    ? new RegExp(pat.source, all && !pat.flags.includes('g') ? pat.flags + 'g' : pat.flags)
    : new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), all ? 'g' : '');
  const hits = await R.hits(s, re);
  let out = '', at = 0;
  for (const m of hits) {
    out += s.slice(at, m.index) + toStr(await callValue(repl, [...m, m.index, s], undefined, 'the replacement', scope));
    at = m.index + m[0].length;
  }
  return capText(out + s.slice(at));
}

const cb = (f, what) => {
  if (typeof f !== 'function') throw new Error(`${what} needs a function — e.g. CreateFunction("v,i,a", "v > 10")`);
  return f;
};

// Comparison for a sort with no comparator: as text, like AS3 and JS.
const textOrder = (a, b) => {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  const x = toStr(a), y = toStr(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

async function mergeSort(arr, cmp) {
  if (arr.length < 2) return arr;
  const mid = arr.length >> 1;
  const a = await mergeSort(arr.slice(0, mid), cmp), b = await mergeSort(arr.slice(mid), cmp);
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) out.push((await cmp(a[i], b[j])) > 0 ? b[j++] : a[i++]);
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

// AS3 Array.sortOn options
const SORT = { CASEINSENSITIVE: 1, DESCENDING: 2, UNIQUESORT: 4, RETURNINDEXEDARRAY: 8, NUMERIC: 16 };

const ARRAY_ASYNC = Object.assign(Object.create(null), {
  async forEach(arr, a, scope) { const f = cb(a[0], 'forEach'); for (let i = 0; i < arr.length; i++) await callValue(f, [arr[i], i, arr], undefined, 'forEach', scope); return undefined; },
  async map(arr, a, scope) { const f = cb(a[0], 'map'); const out = []; for (let i = 0; i < arr.length; i++) out.push(await callValue(f, [arr[i], i, arr], undefined, 'map', scope)); return out; },
  async filter(arr, a, scope) { const f = cb(a[0], 'filter'); const out = []; for (let i = 0; i < arr.length; i++) if (truthy(await callValue(f, [arr[i], i, arr], undefined, 'filter', scope))) out.push(arr[i]); return out; },
  async some(arr, a, scope) { const f = cb(a[0], 'some'); for (let i = 0; i < arr.length; i++) if (truthy(await callValue(f, [arr[i], i, arr], undefined, 'some', scope))) return true; return false; },
  async every(arr, a, scope) { const f = cb(a[0], 'every'); for (let i = 0; i < arr.length; i++) if (!truthy(await callValue(f, [arr[i], i, arr], undefined, 'every', scope))) return false; return true; },
  async find(arr, a, scope) { const f = cb(a[0], 'find'); for (let i = 0; i < arr.length; i++) if (truthy(await callValue(f, [arr[i], i, arr], undefined, 'find', scope))) return arr[i]; return undefined; },
  async findIndex(arr, a, scope) { const f = cb(a[0], 'findIndex'); for (let i = 0; i < arr.length; i++) if (truthy(await callValue(f, [arr[i], i, arr], undefined, 'findIndex', scope))) return i; return -1; },
  async reduce(arr, a, scope) {
    const f = cb(a[0], 'reduce');
    let i = 0, acc;
    if (a.length > 1) acc = a[1];
    else { if (!arr.length) throw new Error('reduce of an empty array needs a start value'); acc = arr[0]; i = 1; }
    for (; i < arr.length; i++) acc = await callValue(f, [acc, arr[i], i, arr], undefined, 'reduce', scope);
    return acc;
  },
  async sort(arr, a, scope) {
    const f = a[0];
    const cmp = typeof f === 'function'
      ? async (x, y) => toNum(await callValue(f, [x, y], undefined, 'sort', scope))
      : typeof f === 'number' ? sortOnCompare(f) : textOrder;
    const sorted = await mergeSort(arr.slice(), cmp);
    for (let i = 0; i < sorted.length; i++) arr[i] = sorted[i];
    return arr;
  },
  async sortOn(arr, a) {
    const names = (Array.isArray(a[0]) ? a[0] : [a[0]]).map((x) => toStr(x));
    const optsList = Array.isArray(a[1]) ? a[1] : names.map(() => Number(a[1]) || 0);
    const rows = [];
    for (let i = 0; i < arr.length; i++) {
      const keys = [];
      for (const n of names) {
        let v = isObj(arr[i]) || typeof arr[i] === 'string' ? getMember(arr[i], n) : undefined;
        if (v instanceof Promise) v = await v;
        keys.push(v);
      }
      rows.push({ i, v: arr[i], keys });
    }
    let dup = false;
    rows.sort((x, y) => {
      for (let k = 0; k < names.length; k++) {
        const r = sortOnCompare(optsList[k] || 0)(x.keys[k], y.keys[k]);
        if (r) return r;
      }
      dup = true;
      return x.i - y.i;
    });
    const o = Number(optsList[0]) || 0;
    if (o & SORT.UNIQUESORT && dup) return 0;
    if (o & SORT.RETURNINDEXEDARRAY) return rows.map((r) => r.i);
    for (let i = 0; i < rows.length; i++) arr[i] = rows[i].v;
    return arr;
  },
  toArray: (arr) => arr.slice(),
  join: (arr, a) => capText(arr.map((x) => (x === null || x === undefined ? '' : toStr(x))).join(a.length && a[0] !== undefined ? toStr(a[0]) : ',')),
  toString: (arr) => toStr(arr),
});

function sortOnCompare(opts) {
  const o = Number(opts) || 0;
  const dir = o & SORT.DESCENDING ? -1 : 1;
  return (x, y) => {
    let r;
    if (o & SORT.NUMERIC) {
      const a = toNum(x), b = toNum(y);
      r = Number.isNaN(a) ? (Number.isNaN(b) ? 0 : 1) : Number.isNaN(b) ? -1 : a - b;
    } else {
      let a = x === undefined || x === null ? '' : toStr(x), b = y === undefined || y === null ? '' : toStr(y);
      if (o & SORT.CASEINSENSITIVE) { a = a.toLowerCase(); b = b.toLowerCase(); }
      r = a < b ? -1 : a > b ? 1 : 0;
    }
    return r * dir;
  };
}

// ---------------------------------------------------------------- evaluator

// Values reach the caller through an async function, so a Promise (a getter's
// or a call's) is awaited there; nothing a script can build is thenable.
const settle = (v) => v;

const FORBIDDEN_FNS = new Set([Function, eval, Object.getPrototypeOf(async function () {}).constructor,
  Object.getPrototypeOf(function* () {}).constructor, setTimeout, setInterval, setImmediate]);

async function callValue(fn, args, thisArg, label, scope) {
  if (typeof fn !== 'function') {
    // NEAT: d = (a + b) (c - 1) multiplies
    if (typeof fn === 'number' && args.length === 1 && typeof args[0] === 'number') return fn * args[0];
    throw new Error(`${label || 'that'} is not a function`);
  }
  if (FORBIDDEN_FNS.has(fn)) throw new Error(`${label || 'that'} cannot be called from a script`);
  const r = fn[SCOPED] ? fn(scope, ...args) : fn.apply(thisArg, args);
  return r instanceof Promise ? await r : r;
}

function setMember(obj, key, value, node) {
  if (obj === null || obj === undefined) throw new Error(`${describe(node && node.obj)} is ${obj === null ? 'null' : 'undefined'} — nothing to set a property on`);
  if (typeof key !== 'string' && typeof key !== 'number') key = toStr(key);
  if (blockedWrite(String(key))) throw new Error(`"${key}" cannot be set`);
  const plain = Array.isArray(obj) || (typeof obj === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(obj)));
  if (!plain) throw new Error(`${describe(node && node.obj)} is not a list or object this script made, so it cannot be changed`);
  if (Object.isFrozen(obj)) throw new Error(`${describe(node && node.obj)} is read-only`);
  if (Array.isArray(obj) && /^\d+$/.test(String(key)) && Number(key) > obj.length + 1e6) throw new Error('that index is too far past the end of the list');
  obj[key] = value;
  return value;
}

async function readTarget(target, scope) {
  if (target.type === 'id') { const r = scope.lookup(target.name); return r.found ? await r.value : undefined; }
  const obj = await evaluate(target.obj, scope);
  const key = target.type === 'member' ? target.name : await evaluate(target.index, scope);
  return { obj, key, value: await getMember(obj, key, target) };
}

async function writeTarget(target, value, scope, ref) {
  if (target.type === 'id') { scope.assign(target.name, value); return value; }
  const r = ref || { obj: await evaluate(target.obj, scope), key: target.type === 'member' ? target.name : await evaluate(target.index, scope) };
  return setMember(r.obj, r.key, value, target);
}

function arith(op, a, b) {
  switch (op) {
    case '+': { const x = toPrim(a), y = toPrim(b); return typeof x === 'string' || typeof y === 'string' ? capText(toStr(x) + toStr(y)) : x + y; }
    case '-': return toNum(a) - toNum(b);
    case '*': return toNum(a) * toNum(b);
    case '/': return toNum(a) / toNum(b);
    case '%': return toNum(a) % toNum(b);
    case '<<': return toNum(a) << toNum(b);
    case '>>': return toNum(a) >> toNum(b);
    case '>>>': return toNum(a) >>> toNum(b);
    case '&': return toNum(a) & toNum(b);
    case '|': return toNum(a) | toNum(b);
    case '^': return toNum(a) ^ toNum(b);
    case '<': return toPrim(a, 'number') < toPrim(b, 'number');
    case '<=': return toPrim(a, 'number') <= toPrim(b, 'number');
    case '>': return toPrim(a, 'number') > toPrim(b, 'number');
    case '>=': return toPrim(a, 'number') >= toPrim(b, 'number');
    case '==': return looseEq(a, b);
    case '!=': return !looseEq(a, b);
    case '===': return a === b;
    case '!==': return a !== b;
    default: throw new Error('unknown operator ' + op);
  }
}

function hasKey(obj, key) {
  if (!isObj(obj)) throw new Error(`"in" needs a list or object on its right, not ${toStr(obj)}`);
  const k = String(typeof key === 'number' ? key : toStr(key));
  if (blockedKey(k)) return false;
  if (Array.isArray(obj) && /^\d+$/.test(k)) return Number(k) < obj.length;
  return Object.prototype.hasOwnProperty.call(obj, k) || classMember(obj, k);
}

async function evaluate(node, scope) {
  switch (node.type) {
    case 'num': case 'str': case 'lit': return node.value;
    case 'tpl': {
      let out = '';
      for (const p of node.parts) out += typeof p === 'string' ? p : toStr(await evaluate(p, scope));
      return capText(out);
    }
    case 're': return new RegExp(node.pattern, node.flags);
    case 'arr': { const a = []; for (const it of node.items) a.push(await evaluate(it, scope)); return a; }
    case 'obj': { const o = {}; for (const p of node.props) o[p.key] = await evaluate(p.value, scope); return o; }
    case 'id': { const r = scope.lookup(node.name); return r.found ? settle(r.value) : undefined; }
    case 'member': return settle(getMember(await evaluate(node.obj, scope), node.name, node));
    case 'index': {
      const obj = await evaluate(node.obj, scope);
      return settle(getMember(obj, await evaluate(node.index, scope), node));
    }
    case 'call': return callNode(node, scope);
    case 'unary': {
      const v = await evaluate(node.arg, scope);
      if (node.op === '!') return !truthy(v);
      if (node.op === '-') return -toNum(v);
      if (node.op === '+') return toNum(v);
      return ~toNum(v);
    }
    case 'logic': {
      const l = await evaluate(node.left, scope);
      if (node.op === '&&') return truthy(l) ? evaluate(node.right, scope) : l;
      return truthy(l) ? l : evaluate(node.right, scope);
    }
    case 'bin': {
      if (node.op === 'is') {
        const v = await evaluate(node.left, scope);
        const r = node.right;
        const name = r.type === 'id' ? r.name : r.type === 'str' ? r.value : null;
        if (name !== null) return isType(v, name);
        const t = await evaluate(r, scope);
        return isType(v, typeof t === 'function' ? t.name : toStr(t));
      }
      const a = await evaluate(node.left, scope);
      const b = await evaluate(node.right, scope);
      if (node.op === 'in') return hasKey(b, a);
      return arith(node.op, a, b);
    }
    case 'cond': return truthy(await evaluate(node.test, scope)) ? evaluate(node.then, scope) : evaluate(node.else, scope);
    case 'assign': {
      if (node.op === '=') {
        const ref = node.target.type === 'id' ? null
          : { obj: await evaluate(node.target.obj, scope), key: node.target.type === 'member' ? node.target.name : await evaluate(node.target.index, scope) };
        return writeTarget(node.target, await evaluate(node.value, scope), scope, ref);
      }
      const cur = await readTarget(node.target, scope);
      const old = node.target.type === 'id' ? cur : cur.value;
      const v = arith(node.op[0], old, await evaluate(node.value, scope));
      return writeTarget(node.target, v, scope, node.target.type === 'id' ? null : cur);
    }
    case 'update': {
      const cur = await readTarget(node.target, scope);
      const old = toNum(node.target.type === 'id' ? cur : cur.value);
      const v = node.op === '++' ? old + 1 : old - 1;
      await writeTarget(node.target, v, scope, node.target.type === 'id' ? null : cur);
      return node.prefix ? v : old;
    }
    default: throw new Error('cannot evaluate ' + node.type);
  }
}

const isRaw = (fn) => typeof fn === 'function' && Object.prototype.hasOwnProperty.call(fn, 'rawArgs') && fn.rawArgs === true;

async function callNode(node, scope) {
  const label = describe(node.callee);
  let fn, thisArg, builtin = null;
  const c = node.callee;
  if (c.type === 'member' || c.type === 'index') {
    const obj = await evaluate(c.obj, scope);
    const key = c.type === 'member' ? c.name : await evaluate(c.index, scope);
    if (obj === null || obj === undefined) getMember(obj, key, c);
    builtin = builtinMethod(obj, typeof key === 'number' ? String(key) : key);
    if (!builtin) { fn = await settle(getMember(obj, key, c)); thisArg = obj; }
  } else {
    fn = await evaluate(c, scope);
  }
  if (!builtin && typeof fn !== 'function' && typeof fn !== 'number') {
    throw new Error(`${label} is not a function${fn === undefined && c.type === 'id' ? ' (nothing by that name is defined)' : ''}`);
  }
  let args;
  if (node.rawText !== undefined) {
    if (!isRaw(fn)) throw new Error(`${label}(${node.rawText}): that is not an expression — put text in quotes`);
    args = [node.rawText];
  } else if (isRaw(fn) && node.args.length === 1 && node.args[0].type === 'id' && !scope.lookup(node.args[0].name).found) {
    args = [node.args[0].name];
  } else {
    args = [];
    for (const a of node.args) args.push(await evaluate(a, scope));
  }
  if (builtin) { const r = builtin(args, scope); return r instanceof Promise ? await r : r; }
  return callValue(fn, args, thisArg, label, scope);
}

// ------------------------------------------------------------------- scope

// Case-insensitive lookup into a global layer, built once per layer object.
const lowerIndex = new WeakMap();
function layerGet(layer, name) {
  if (Object.prototype.hasOwnProperty.call(layer, name)) return { found: true, value: layer[name] };
  let idx = lowerIndex.get(layer);
  if (!idx) {
    idx = new Map();
    for (const k of Object.getOwnPropertyNames(layer)) if (!idx.has(k.toLowerCase())) idx.set(k.toLowerCase(), k);
    lowerIndex.set(layer, idx);
  }
  const real = idx.get(name.toLowerCase());
  return real !== undefined ? { found: true, value: layer[real] } : null;
}

class Scope {
  // vars: the script's true variables (a Map, shared by every frame of a run);
  // specials: $result, $error; layers: global objects, first match wins;
  // readOnly: names a script may not assign (BuildVersion...).
  constructor({ vars = new Map(), specials = new Map(), layers = [], readOnly = new Set(), locals = null, parent = null } = {}) {
    Object.assign(this, { vars, specials, layers, readOnly, locals, parent });
  }
  child(locals) {
    const s = Object.create(Scope.prototype);
    Object.assign(s, this, { locals, parent: this });
    return s;
  }
  lookup(name) {
    for (let s = this; s; s = s.parent) if (s.locals && s.locals.has(name)) return { found: true, value: s.locals.get(name) };
    if (this.vars.has(name)) return { found: true, value: this.vars.get(name) };
    if (this.specials.has(name)) return { found: true, value: this.specials.get(name) };
    for (const layer of this.layers) {
      if (!layer) continue;
      const r = layerGet(layer, name);
      if (r) return r;
    }
    return { found: false, value: undefined };
  }
  // A true variable only (arguments, then the script's), any case — what a
  // %name% falls back to when no `set` made it.
  lookupVar(name) {
    for (let s = this; s; s = s.parent) if (s.locals && s.locals.has(name)) return { found: true, value: s.locals.get(name) };
    if (this.vars.has(name)) return { found: true, value: this.vars.get(name) };
    const low = String(name).toLowerCase();
    for (const [k, v] of this.vars) if (k.toLowerCase() === low) return { found: true, value: v };
    return { found: false, value: undefined };
  }
  assign(name, value) {
    // exact case, like the variables: `e = list.shift()` is not the constant E
    if (this.readOnly.has(name)) throw new Error(`${name} is a constant — it cannot be assigned`);
    for (let s = this; s; s = s.parent) if (s.locals && s.locals.has(name)) { s.locals.set(name, value); return; }
    if (String(name).startsWith('$')) { this.specials.set(name, value); return; }
    this.vars.set(name, value);
  }
}

// CreateFunction("v,i,a", "v > 10"): the body is one statement, read now and
// run each call with the arguments as local names over the caller's scope.
function CreateFunction(scope, params = '', body = '') {
  const names = toStr(params).split(',').map((x) => x.trim()).filter(Boolean);
  for (const n of names) if (!/^[A-Za-z_$][\w$]*$/.test(n) || blockedKey(n)) throw new Error(`CreateFunction: "${n}" is not a name`);
  let ast;
  try { ast = parseStatement(toStr(body)); } catch (e) { throw new Error('CreateFunction: ' + e.message); }
  return makeScriptFunction((args) => evaluate(ast, scope.child(new Map(names.map((n, i) => [n, args[i]])))),
    { name: 'CreateFunction', params: names, source: toStr(body) });
}
CreateFunction[SCOPED] = true;

const builtins = () => ({ CreateFunction });

// ------------------------------------------------------- {expr} in plain text

// Command arguments are not expressions, but NEAT fills {expr} in them too:
// scout {castle.coords}. The spans that parse; \{ stays a brace.
function textSpans(text) {
  const out = [];
  const s = String(text);
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '\\' && s[j + 1] === '{') { j++; continue; }
    if (s[j] !== '{') continue;
    const close = findClose(s, j);
    if (close < 0) continue;
    try { out.push({ s: j, e: close + 1, ast: parseExpression(s.slice(j + 1, close), j + 1) }); j = close; } catch { /* literal brace */ }
  }
  return out;
}
const hasSpans = (text) => textSpans(text).length > 0;
async function fillText(text, scope) {
  const s = String(text);
  let out = '', at = 0;
  for (const sp of textSpans(s)) {
    out += s.slice(at, sp.s) + toStr(await evaluate(sp.ast, scope));
    at = sp.e;
  }
  return (out + s.slice(at)).replace(/\\\{/g, '{');
}

// Every name an expression reads (not member names or object keys), for the
// load-time lint; `writes` gets the names it assigns.
function names(node, reads = new Set(), writes = new Set()) {
  if (!node || typeof node !== 'object') return { reads, writes };
  switch (node.type) {
    case 'id': reads.add(node.name); break;
    case 'tpl': for (const p of node.parts) if (typeof p !== 'string') names(p, reads, writes); break;
    case 'arr': for (const i of node.items) names(i, reads, writes); break;
    case 'obj': for (const p of node.props) names(p.value, reads, writes); break;
    case 'member': names(node.obj, reads, writes); break;
    case 'index': names(node.obj, reads, writes); names(node.index, reads, writes); break;
    case 'call': names(node.callee, reads, writes); for (const a of node.args) names(a, reads, writes); break;
    case 'unary': names(node.arg, reads, writes); break;
    case 'bin': case 'logic':
      names(node.left, reads, writes);
      if (!(node.op === 'is' && node.right.type === 'id')) names(node.right, reads, writes);
      break;
    case 'cond': names(node.test, reads, writes); names(node.then, reads, writes); names(node.else, reads, writes); break;
    case 'assign': case 'update':
      if (node.target.type === 'id') writes.add(node.target.name);
      if (node.op !== '=' || node.target.type !== 'id') names(node.target, reads, writes);
      if (node.value) names(node.value, reads, writes);
      break;
    default: break;
  }
  return { reads, writes };
}

module.exports = {
  ExprError, Scope, CreateFunction, builtins, SCRIPT_FN,
  parseExpression, parsePrefix, parseList, parseStatement, assignmentStart,
  evaluate, callValue, getMember, toStr, toPrim, toNum, truthy, looseEq, isType,
  makeScriptFunction, isScriptFunction, blockedKey,
  textSpans, hasSpans, fillText, names, describe,
};
