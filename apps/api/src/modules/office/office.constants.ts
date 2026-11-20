/**
 * Office reference prefixes for `nextReference(tx, tenantId, prefix)` and the
 * geo resolver kinds registered by OfficeModule.
 */
export const OFFICE_REFERENCE_PREFIX = {
  CORRESPONDENCE_IN: 'COR-IN',
  CORRESPONDENCE_OUT: 'COR-OUT',
  APPOINTMENT: 'APT',
  CASE: 'CASE',
  PROJECT: 'PRJ',
} as const;

/** GeoScopeService kinds: use in `@RequirePermission(..., { geo: { kind, from: 'params', key: 'id' } })`. */
export const OFFICE_GEO_KIND = {
  CASE: 'officeCase',
  PROJECT: 'officeProject',
} as const;

/** Default public-reference prefix when the tenant slug yields none. */
export const DEFAULT_PUBLIC_REFERENCE_PREFIX = 'REQ';
