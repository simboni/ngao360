/**
 * The 47 counties of Kenya with their official codes (Constitution of Kenya 2010,
 * First Schedule; codes 001–047 as used by the IEBC). Public reference data.
 *
 * Everything BELOW county level in the demo seed is synthetic.
 */

export interface KenyaCounty {
  /** Three-digit official code, e.g. "039". */
  code: string;
  /** Official name as listed in the First Schedule. */
  name: string;
}

export const KENYA_COUNTIES: readonly KenyaCounty[] = Object.freeze([
  { code: '001', name: 'Mombasa' },
  { code: '002', name: 'Kwale' },
  { code: '003', name: 'Kilifi' },
  { code: '004', name: 'Tana River' },
  { code: '005', name: 'Lamu' },
  { code: '006', name: 'Taita Taveta' },
  { code: '007', name: 'Garissa' },
  { code: '008', name: 'Wajir' },
  { code: '009', name: 'Mandera' },
  { code: '010', name: 'Marsabit' },
  { code: '011', name: 'Isiolo' },
  { code: '012', name: 'Meru' },
  { code: '013', name: 'Tharaka-Nithi' },
  { code: '014', name: 'Embu' },
  { code: '015', name: 'Kitui' },
  { code: '016', name: 'Machakos' },
  { code: '017', name: 'Makueni' },
  { code: '018', name: 'Nyandarua' },
  { code: '019', name: 'Nyeri' },
  { code: '020', name: 'Kirinyaga' },
  { code: '021', name: "Murang'a" },
  { code: '022', name: 'Kiambu' },
  { code: '023', name: 'Turkana' },
  { code: '024', name: 'West Pokot' },
  { code: '025', name: 'Samburu' },
  { code: '026', name: 'Trans Nzoia' },
  { code: '027', name: 'Uasin Gishu' },
  { code: '028', name: 'Elgeyo-Marakwet' },
  { code: '029', name: 'Nandi' },
  { code: '030', name: 'Baringo' },
  { code: '031', name: 'Laikipia' },
  { code: '032', name: 'Nakuru' },
  { code: '033', name: 'Narok' },
  { code: '034', name: 'Kajiado' },
  { code: '035', name: 'Kericho' },
  { code: '036', name: 'Bomet' },
  { code: '037', name: 'Kakamega' },
  { code: '038', name: 'Vihiga' },
  { code: '039', name: 'Bungoma' },
  { code: '040', name: 'Busia' },
  { code: '041', name: 'Siaya' },
  { code: '042', name: 'Kisumu' },
  { code: '043', name: 'Homa Bay' },
  { code: '044', name: 'Migori' },
  { code: '045', name: 'Kisii' },
  { code: '046', name: 'Nyamira' },
  { code: '047', name: 'Nairobi City' },
]);

const BY_CODE = new Map(KENYA_COUNTIES.map((c) => [c.code, c]));

/** Normalise a county name for comparison ("Tharaka Nithi" == "Tharaka-Nithi", "Nairobi" == "Nairobi City"). */
export function normaliseCountyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bcity\b/g, '')
    .replace(/[^a-z]/g, '');
}

/**
 * Normalise a county code: numeric codes are zero-padded to three digits.
 * Returns null when the input is not a 1–3 digit number.
 */
export function normaliseCountyCode(code: string): string | null {
  const trimmed = code.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  return trimmed.padStart(3, '0');
}

export function findCountyByCode(code: string): KenyaCounty | undefined {
  const normalised = normaliseCountyCode(code);
  return normalised ? BY_CODE.get(normalised) : undefined;
}

/** True when `name` is an acceptable spelling of the official county name for `code`. */
export function countyNameMatches(code: string, name: string): boolean {
  const county = findCountyByCode(code);
  return !!county && normaliseCountyName(county.name) === normaliseCountyName(name);
}
