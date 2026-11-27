// png-squeeze-optimizer v2: a lossless PNG re-encoder for 1280x720 RGBA screenshots.
//
// Strategy: mirror make.fun's own scale screen — colour-type reduction (palette
// when <=256 colours, grey / grey+alpha / RGB / RGBA otherwise, with a tRNS key
// when one fully-transparent value can stand in for an alpha channel), per-row
// filter selection (fixed filters, minimum-sum, fewest-distinct-pairs and brute
// force by zlib level 4 with a 32 KiB dictionary), every candidate weighed by
// zlib at level 6. Then, for the two best candidates, re-encode at zlib level 9
// (default and filtered strategies), and try full-flush block splits of the best
// stream (a fresh Huffman tree per block helps heterogeneous screenshots); the
// smallest stream wins. Everything is deterministic: no clock, no randomness, no
// environment reads, so two runs write identical bytes.
//
// Run: node main.ts  (reads /input/<id>/image.png, writes /output/<id>/image.png)
// Local dev: MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, createDeflate, deflateSync, inflateSync } from 'node:zlib';

const WIDTH = 1280;
const HEIGHT = 720;

// ---------------------------------------------------------------------------
// PNG chunk plumbing (CRC-32, chunk writer, IHDR)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// ---------------------------------------------------------------------------
// PNG decoding (input is a stored colour-type-6 PNG, but every filter is handled)
// ---------------------------------------------------------------------------

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(bytes) {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('bad signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  const idat = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9] };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!header || header.colourType !== 6 || header.depth !== 8) throw new Error('not an 8-bit RGBA PNG');
  const { width, height } = header;
  const bpp = 4;
  const stride = width * bpp;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  if (raw.length !== height * (stride + 1)) throw new Error('unexpected inflated size');
  const rgba = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) rgba.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) rgba[o + i] = raw[src + i] + (i >= bpp ? rgba[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) rgba[o + i] = raw[src + i] + (y > 0 ? rgba[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        rgba[o + i] = raw[src + i] + (((i >= bpp ? rgba[o + i - bpp] : 0) + (y > 0 ? rgba[p + i] : 0)) >> 1);
      }
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? rgba[o + i - bpp] : 0;
        const b = y > 0 ? rgba[p + i] : 0;
        const c = y > 0 && i >= bpp ? rgba[p + i - bpp] : 0;
        rgba[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else throw new Error(`bad filter ${ft} on row ${y}`);
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Image analysis: opaque / grey / colours (<=256) / transparent key
// ---------------------------------------------------------------------------

function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many
    ? null
    : [...counts.keys()].map((c) => {
        const b = new Uint8Array(Uint32Array.of(c).buffer);
        return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
      });
  return { opaque, grey, colours };
}

function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Palette forms
// ---------------------------------------------------------------------------

function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

// ---------------------------------------------------------------------------
// Filtered data: fixed filter, minsum, fewest-pairs, or per-row brute force
// ---------------------------------------------------------------------------

const SCREEN = Object.freeze({ level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY });
const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

function filtered(samples, width, height, bpp, choice, raw = new Uint8Array(height * (width * bpp + 1))) {
  const stride = width * bpp;
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t]);
      else if (choice === 'pairs') cost = pairsOf(trial[t], seen, ++stamp);
      else {
        cost = deflateSync(trial[t], before.length === 0 ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Screen: every form x filter choice, weighed by zlib at level 6; keep the top 2
// (level-6 and level-9 rankings can invert, so the runner-up gets a level-9 try)
// ---------------------------------------------------------------------------

const FILTERS = Object.freeze({
  paletteCount: Object.freeze([0, 'minsum', 'brute']),
  paletteLuminance: Object.freeze([0, 'minsum', 'brute']),
  channels: Object.freeze([0, 1, 2, 3, 4, 'minsum', 'pairs', 'brute']),
});

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', FILTERS.paletteCount],
      ['luminance', FILTERS.paletteLuminance],
    ]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: FILTERS.channels });
  return forms;
}

const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

function screen(rgba, width, height) {
  const top = []; // up to 2 best {form, data, zlib, bytes}, ascending bytes
  let spare = null;
  const consider = (cand) => {
    if (top.length < 2) {
      top.push(cand);
      top.sort((a, b) => a.bytes - b.bytes);
    } else if (cand.bytes < top[1].bytes) {
      top[1] = cand;
      top.sort((a, b) => a.bytes - b.bytes);
    }
  };
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice, spare !== null && spare.length === size ? spare : new Uint8Array(size));
      spare = null;
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      const cand = { form, data, zlib: new Uint8Array(zlib.buffer, zlib.byteOffset, zlib.length), bytes };
      if (top.length < 2 || bytes < top[1].bytes) consider(cand);
      else spare = data;
      // A candidate that does not make the top 2 frees its buffer for reuse.
      if (top[0] !== cand && top[1] !== cand) spare = data;
    }
  }
  return top;
}

// ---------------------------------------------------------------------------
// Final encode: level 9 (default + filtered strategies) and full-flush splits
// ---------------------------------------------------------------------------

function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

/** Deflate `data` with a Z_FULL_FLUSH every `rows` rows (fresh Huffman tree per block). */
function deflateSplit(data, stride, rows, strategy = constants.Z_DEFAULT_STRATEGY) {
  return new Promise((resolve, reject) => {
    const d = createDeflate({ level: 9, memLevel: 9, strategy });
    const chunks = [];
    d.on('data', (c) => chunks.push(c));
    d.on('error', reject);
    d.on('end', () => resolve(Buffer.concat(chunks)));
    const rowBytes = stride;
    let at = 0;
    const step = async () => {
      while (at < data.length) {
        const next = Math.min(data.length, at + rows * rowBytes);
        const last = next >= data.length;
        d.write(data.subarray(at, next));
        at = next;
        if (!last) await new Promise((res, rej) => d.flush(constants.Z_FULL_FLUSH, (err) => (err ? rej(err) : res())));
      }
      d.end();
    };
    step().catch(reject);
  });
}

async function encode(rgba, width, height) {
  const top = screen(rgba, width, height);
  // Best stream so far: the level-6 screening winner.
  let bestForm = top[0].form;
  let bestStream = top[0].zlib;
  let bestBytes = top[0].bytes;
  const considerStream = (form, stream) => {
    const bytes = stream.length + chunkBytes(form);
    if (bytes < bestBytes) {
      bestBytes = bytes;
      bestForm = form;
      bestStream = stream;
    }
  };
  // Re-encode the top 2 at level 9 (default strategy for both, filtered for the best).
  for (let k = 0; k < top.length; k++) {
    const cand = top[k];
    const z9 = deflateSync(cand.data, { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY });
    considerStream(cand.form, new Uint8Array(z9.buffer, z9.byteOffset, z9.length));
    if (k === 0) {
      const z9f = deflateSync(cand.data, { level: 9, memLevel: 9, strategy: constants.Z_FILTERED });
      considerStream(cand.form, new Uint8Array(z9f.buffer, z9f.byteOffset, z9f.length));
    }
  }
  // Block splits of the best stream's data (fresh Huffman tree per block).
  const stride = width * bestForm.bpp + 1;
  const bestData = top.find((c) => c.form === bestForm)?.data ?? top[0].data;
  for (const rows of [90, 180, 360]) {
    for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED]) {
      const split = await deflateSplit(bestData, stride, rows, strategy);
      considerStream(bestForm, new Uint8Array(split.buffer, split.byteOffset, split.length));
    }
  }
  return pngOfForm(width, height, bestForm, bestStream);
}

// ---------------------------------------------------------------------------
// Main: one run over the whole set
// ---------------------------------------------------------------------------

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(I).sort()) {
  const inPath = join(I, id, 'image.png');
  const outDir = join(O, id);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'image.png');
  try {
    const { width, height, rgba } = decodePng(new Uint8Array(readFileSync(inPath)));
    writeFileSync(outPath, await encode(rgba, width, height));
  } catch {
    // Fall back to the stored input: valid and answered, even if it earns 0.
    copyFileSync(inPath, outPath);
  }
}
