/**
 * Just enough WOFF2 to answer one question: does this file contain A-Z?
 *
 * WHY THIS EXISTS. `fetch-fonts.mjs` vendored the wrong Google Fonts subset for
 * the entire life of the project. Every weight of Archivo in `public/fonts`
 * held 262 glyphs and not one of A-Z or 0-9 — it was the `latin-ext` slice,
 * which is only the accented characters. The browser dutifully fell through to
 * the next family in the stack, so the app rendered in Helvetica/Arial on every
 * screen, and `document.fonts.check('900 100px Archivo')` returned false.
 *
 * Nothing caught it. The app looked fine, because a well-set sans-serif looks
 * fine; DESIGN.md's "Archivo exclusively" was satisfied in the CSS and violated
 * on the glass. The only honest test of a vendored binary is to read the
 * binary, so that is what this does.
 *
 * SCOPE. WOFF2 transforms `glyf` and `loca` and leaves every other table
 * intact, so `cmap` comes out of the brotli stream byte-identical to the TTF's.
 * That means no glyph outlines have to be understood — just the header, the
 * table directory and cmap formats 4 and 12. Anything beyond that is the
 * business of a real font library, not this file.
 *
 * Spec: https://www.w3.org/TR/WOFF2/ §4 (header), §5 (table directory).
 */
import { brotliDecompressSync } from 'node:zlib';

/** Table tags, in the order WOFF2 assigns them to flag values 0..62. */
const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post',
  'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
  'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop',
  'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

/** WOFF2's variable-length integer. Spec §4.1 "UIntBase128". */
function readBase128(buf, pos) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buf[pos++];
    if (byte === undefined) throw new Error('truncated UIntBase128');
    // Leading zeros and overflow past 2^32 are both malformed per spec.
    if (i === 0 && byte === 0x80) throw new Error('UIntBase128 has a leading zero');
    if (value & 0xfe000000) throw new Error('UIntBase128 overflow');
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value >>> 0, pos];
  }
  throw new Error('UIntBase128 too long');
}

/**
 * Decompress a WOFF2 and return its tables as `{ tag: Buffer }`.
 *
 * `glyf` and `loca` come back in their TRANSFORMED form and are not usable as
 * TrueType tables. Nothing here needs them.
 */
export function woff2Tables(buf) {
  if (buf.length < 48 || buf.toString('ascii', 0, 4) !== 'wOF2') {
    throw new Error('not a WOFF2 file');
  }
  const numTables = buf.readUInt16BE(12);

  let pos = 48;
  const entries = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[pos++];
    const index = flags & 0x3f;

    let tag;
    if (index === 0x3f) {
      tag = buf.toString('ascii', pos, pos + 4);
      pos += 4;
    } else {
      tag = KNOWN_TAGS[index];
      if (!tag) throw new Error(`unknown table flag ${index}`);
    }

    let origLength;
    [origLength, pos] = readBase128(buf, pos);

    // A non-zero transform on glyf/loca (version 0) or on anything else
    // (version != 0) is followed by the transformed length.
    const transform = (flags >> 6) & 0x03;
    const transformed =
      tag === 'glyf' || tag === 'loca' ? transform === 0 : transform !== 0;
    let length = origLength;
    if (transformed) [length, pos] = readBase128(buf, pos);

    entries.push({ tag, length });
  }

  const stream = brotliDecompressSync(buf.subarray(pos));

  const tables = {};
  let offset = 0;
  for (const e of entries) {
    tables[e.tag] = stream.subarray(offset, offset + e.length);
    offset += e.length;
  }
  return tables;
}

/** Every Unicode codepoint the font maps, as a Set. Formats 4 and 12 only. */
export function codepoints(cmap) {
  const out = new Set();
  if (!cmap || cmap.length < 4) return out;

  const numSubtables = cmap.readUInt16BE(2);
  for (let i = 0; i < numSubtables; i++) {
    const rec = 4 + i * 8;
    if (rec + 8 > cmap.length) break;
    const offset = cmap.readUInt32BE(rec + 4);
    if (offset + 4 > cmap.length) continue;
    const format = cmap.readUInt16BE(offset);

    if (format === 4) {
      const segX2 = cmap.readUInt16BE(offset + 6);
      const segs = segX2 / 2;
      const endBase = offset + 14;
      const startBase = endBase + segX2 + 2;
      for (let s = 0; s < segs; s++) {
        const end = cmap.readUInt16BE(endBase + s * 2);
        const start = cmap.readUInt16BE(startBase + s * 2);
        if (start > end || end === 0xffff) continue;
        for (let cp = start; cp <= end; cp++) out.add(cp);
      }
    } else if (format === 12) {
      const nGroups = cmap.readUInt32BE(offset + 12);
      for (let g = 0; g < nGroups; g++) {
        const rg = offset + 16 + g * 12;
        if (rg + 12 > cmap.length) break;
        const start = cmap.readUInt32BE(rg);
        const end = cmap.readUInt32BE(rg + 4);
        // Guard against a malformed range asking for millions of iterations.
        if (end - start > 0x10000) continue;
        for (let cp = start; cp <= end; cp++) out.add(cp);
      }
    }
  }
  return out;
}

/**
 * The characters this app actually sets type in: A-Z, 0-9 and the punctuation
 * the brand voice uses — the angle brackets of `<PUMP YOUR ARMS>`, the em dash,
 * the middot in Rhythm's tagline, the apostrophe in DON'T.
 */
export const REQUIRED = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  ...' .,:!?#+-/<>()',
  "'",
  '—',
  '·',
].map((c) => c.codePointAt(0));

/** `{ ok, missing }` — `missing` is the characters, not the codepoints. */
export function checkCoverage(buf) {
  const cps = codepoints(woff2Tables(buf).cmap);
  const missing = REQUIRED.filter((cp) => !cps.has(cp)).map((cp) =>
    String.fromCodePoint(cp)
  );
  return { ok: missing.length === 0, missing, total: cps.size };
}
