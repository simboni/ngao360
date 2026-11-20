/**
 * File names of the 2022 presidential polling-station forms (34A) as published
 * on the IEBC portal: `1_34_A_<15-digit station code>_<KIEMS serial>_<YYYYMMDD>_<HHMMSS>.<ext>`
 * (docs/DATA_SOURCES_2022.md). The split of the station code into county(3) +
 * constituency(3) + ward(4) + centre(3) + station(2) is INFERRED, not documented.
 *
 * Parsing is tolerant of letter case and of `_`, `-`, `.` or space separators.
 * Nothing here fetches anything: the importer works on local files only.
 */

export const FORM_34A_FILE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'pdf', 'webp', 'heic'] as const;

export interface Parsed34AFileName {
  stationCode: string;
  /** Inferred segments of the station code. */
  countyCode: string;
  constituencyCode: string;
  wardCode: string;
  centreCode: string;
  streamCode: string;
  kiemsSerial: string;
  /** Capture time printed in the name, as an ISO string (local time, no zone in the source). */
  capturedAt: string;
  extension: string;
}

export type Parse34AResult = { ok: true; value: Parsed34AFileName } | { ok: false; reason: string };

const NAME_RE =
  /^1[\s_.-]+34[\s_.-]*a[\s_.-]+(\d{15})[\s_.-]+([a-z0-9]{1,40})[\s_.-]+(\d{8})[\s_.-]+(\d{6})\.([a-z0-9]{2,5})$/i;

function validDate(ymd: string, hms: string): string | null {
  const y = Number(ymd.slice(0, 4));
  const mo = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  const h = Number(hms.slice(0, 2));
  const mi = Number(hms.slice(2, 4));
  const s = Number(hms.slice(4, 6));
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}`;
}

/** Parse a 34A file name (base name only, no directories). */
export function parse34AFileName(fileName: string): Parse34AResult {
  const base = fileName.split(/[\\/]/).pop()!.trim();
  const m = NAME_RE.exec(base);
  if (!m) {
    if (!/\.[a-z0-9]{2,5}$/i.test(base)) return { ok: false, reason: 'No file extension' };
    if (!/^1[\s_.-]+34[\s_.-]*a/i.test(base)) return { ok: false, reason: 'Does not start with 1_34_A (presidential polling-station form)' };
    if (!/\d{15}/.test(base)) return { ok: false, reason: 'No 15-digit polling-station code' };
    return { ok: false, reason: 'Does not match 1_34_A_<15-digit station code>_<KIEMS serial>_<YYYYMMDD>_<HHMMSS>.<ext>' };
  }
  const [, code, serial, ymd, hms, ext] = m as unknown as [string, string, string, string, string, string];
  const extension = ext.toLowerCase();
  if (!(FORM_34A_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
    return { ok: false, reason: `Unsupported file type .${extension} (expected ${FORM_34A_FILE_EXTENSIONS.join(', ')})` };
  }
  const capturedAt = validDate(ymd, hms);
  if (!capturedAt) return { ok: false, reason: `Invalid date or time in the name (${ymd} ${hms})` };
  return {
    ok: true,
    value: {
      stationCode: code,
      countyCode: code.slice(0, 3),
      constituencyCode: code.slice(3, 6),
      wardCode: code.slice(6, 10),
      centreCode: code.slice(10, 13),
      streamCode: code.slice(13, 15),
      kiemsSerial: serial.toUpperCase(),
      capturedAt,
      extension,
    },
  };
}

/** Build a canonical 34A file name (used by the synthetic test fixtures). */
export function format34AFileName(p: { stationCode: string; kiemsSerial: string; capturedAt: string; extension: string }): string {
  const ymd = p.capturedAt.slice(0, 10).replace(/-/g, '');
  const hms = p.capturedAt.slice(11, 19).replace(/:/g, '');
  return `1_34_A_${p.stationCode}_${p.kiemsSerial}_${ymd}_${hms}.${p.extension}`;
}
