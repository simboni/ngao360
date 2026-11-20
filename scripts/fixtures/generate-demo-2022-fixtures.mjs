#!/usr/bin/env node
/**
 * SYNTHETIC fixtures for the 2022 historical demo tests (fixtures/demo-2022/34a/).
 *
 * Tiny generated PNG and PDF files whose names follow the 34A pattern
 * 1_34_A_<15-digit station code>_<KIEMS serial>_<YYYYMMDD>_<HHMMSS>.<ext>, plus
 * badly named files. The station codes match the small synthetic test config
 * (fixtures/demo-2022/bungoma-small.config.json) or are deliberately unknown.
 * No real scan, form, name or figure is used. Deterministic output.
 *
 *   pnpm fixtures:demo-2022
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'fixtures', 'demo-2022', '34a');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** 8×8 RGB PNG with a seed-dependent pattern and a tEXt note (synthetic). */
function png(seed) {
  const w = 8;
  const h = 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 3) + 1 + x * 3;
      raw[o] = (seed * 37 + x * 13) & 0xff;
      raw[o + 1] = (seed * 91 + y * 17) & 0xff;
      raw[o + 2] = (seed * 53 + x * y) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from(`Comment\0SYNTHETIC TEST FIXTURE ${seed} - not an IEBC form`, 'latin1')),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** One-page PDF with a single synthetic line of text. */
function pdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 8 Tf 10 50 Td (${text}) Tj ET`;
  objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

rmSync(OUT, { recursive: true, force: true });
const files = {
  // Known codes in the small synthetic registry (constituency 001 ward 0001, constituency 002 ward 0003).
  '1_34_A_039001000100101_KIT00001_20220809_181500.png': png(1),
  'batch-b/1-34-a-039002000300101-kit00002-20220809-190102.PDF': pdf('SYNTHETIC TEST FIXTURE 2 - not an IEBC form'),
  // A second, different scan of the first station: intake flags a possible duplicate.
  '1_34_A_039001000100101_KIT00001_20220809_181530.png': png(3),
  // Same bytes as the first file under another name: a re-import of the same file.
  'copies/1 34 A 039001000100101 KIT00001 20220809 181500.png': png(1),
  // Valid pattern, station code not in the registry: goes to a draft registry version.
  '1_34_A_039002000399901_KIT00009_20220809_200000.png': png(9),
  // Badly named files.
  'scan_0001.png': png(20),
  '1_34_A_0390010001001_KIT1_20220809_181500.png': png(21),
  '1_34_A_039001000100101_KIT1_20221340_181500.png': png(22),
  'notes.txt': Buffer.from('SYNTHETIC fixture directory for pnpm demo:import-34a tests.\n'),
};
for (const [name, data] of Object.entries(files)) {
  const p = join(OUT, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
}
console.log(`Wrote ${Object.keys(files).length} synthetic fixtures to ${OUT}`);
