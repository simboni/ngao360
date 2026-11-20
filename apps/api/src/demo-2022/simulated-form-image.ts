/**
 * Plain mock-up images of SIMULATED governor forms (37A / 37B / 37C) for the
 * 2022 historical demo. Same conventions as the rehearsal fixture generator
 * (scripts/fixtures/generate-form-images.py): a red banner, a diagonal
 * watermark, no official layout, no stamps, no signatures, no names. Rendered
 * in-process with sharp (already an API dependency) so the demo needs no
 * Python. Each image carries a code strip derived from its identity, so two
 * forms never share a SHA-256 even where text rendering is unavailable.
 */
import sharp from 'sharp';
import { HISTORICAL_DEMO_LABEL } from '@ngao360/shared';

export const SIMULATED_FORM_BANNER = 'SIMULATED FORM - NOT AN IEBC FORM - HISTORICAL DEMO';

export interface SimulatedFormImage {
  formNumber: '37A' | '37B' | '37C';
  /** Station code, constituency code or county code. */
  identity: string;
  heading: string;
  subheading: string;
  rows: Array<[label: string, value: string | number]>;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function simulatedFormSvg(f: SimulatedFormImage): string {
  const W = 760;
  const rowH = 30;
  const top = 170;
  const H = top + f.rows.length * rowH + 140;
  const rows = f.rows
    .map(([label, value], i) => {
      const y = top + i * rowH;
      return `<line x1="40" y1="${y + 8}" x2="${W - 40}" y2="${y + 8}" stroke="#aab0b8" stroke-width="1"/>
<text x="48" y="${y}" font-size="16" fill="#1e2228">${esc(label)}</text>
<text x="${W - 48}" y="${y}" font-size="16" font-family="DejaVu Sans Mono, monospace" text-anchor="end" fill="#1e2228">${esc(String(value))}</text>`;
    })
    .join('\n');
  // Code strip: one bar per character of the identity (height from its char code).
  const strip = [...`${f.formNumber}:${f.identity}`]
    .map((ch, i) => `<rect x="${40 + i * 9}" y="${H - 70}" width="6" height="${10 + (ch.charCodeAt(0) % 30)}" fill="#3a4048"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans, Arial, sans-serif">
<rect width="${W}" height="${H}" fill="#faf9f5"/>
<rect x="0" y="0" width="${W}" height="44" fill="#b02020"/>
<text x="${W / 2}" y="29" font-size="18" font-weight="bold" fill="#ffffff" text-anchor="middle">${esc(SIMULATED_FORM_BANNER)}</text>
<text x="40" y="84" font-size="22" font-weight="bold" fill="#1e2228">Form ${esc(f.formNumber)} (simulated) - ${esc(f.heading)}</text>
<text x="40" y="112" font-size="15" fill="#5f6670">${esc(f.subheading)}</text>
<text x="40" y="136" font-size="13" fill="#b02020">${esc(HISTORICAL_DEMO_LABEL)}: figures are generated, not read from any real form.</text>
${rows}
<text x="${W / 2}" y="${H / 2}" font-size="96" font-weight="bold" fill="#b02020" fill-opacity="0.12" text-anchor="middle" transform="rotate(-30 ${W / 2} ${H / 2})">SIMULATED</text>
${strip}
<text x="40" y="${H - 18}" font-size="12" fill="#5f6670">${esc(`${f.formNumber} ${f.identity}`)} - no stamp, no signature, no personal data</text>
</svg>`;
}

export async function renderSimulatedFormPng(f: SimulatedFormImage): Promise<Buffer> {
  return sharp(Buffer.from(simulatedFormSvg(f))).png({ compressionLevel: 9, palette: true }).toBuffer();
}
