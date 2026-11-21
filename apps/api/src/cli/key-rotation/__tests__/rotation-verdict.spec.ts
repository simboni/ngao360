import { ROTATION_EXIT_CODES, rotationVerdict, type RotationResult } from '../rotation';

const steps = (done = true): RotationResult['steps'] => ({ s: { scanned: 1, rewritten: 1, current: 0, unreadable: 0, skipped: 0, raced: 0, done } });
const base: RotationResult = { target: 'agent-data', dryRun: false, keyId: 'k1', steps: steps(), complete: true, tenantId: null, tenantComplete: false, validated: false };

describe('key rotation verdict', () => {
  it('only an unscoped, non-dry, complete run says the previous key can be retired (exit 0)', () => {
    expect(rotationVerdict(base)).toBe('complete');
    expect(ROTATION_EXIT_CODES.complete).toBe(0);
  });

  it('a run limited to one tenant never reports complete, even when that tenant is done', () => {
    const scoped: RotationResult = { ...base, complete: false, tenantId: '00000000-0000-4000-8000-000000000001', tenantComplete: true };
    expect(rotationVerdict(scoped)).toBe('tenant-complete');
    expect(ROTATION_EXIT_CODES['tenant-complete']).not.toBe(0);
    // Even a (mis)constructed result with complete=true is judged by its scope.
    expect(rotationVerdict({ ...scoped, complete: true })).toBe('tenant-complete');
    expect(rotationVerdict({ ...scoped, tenantComplete: false })).toBe('incomplete');
  });

  it('incomplete and stopped runs fail with distinct non-zero codes', () => {
    expect(rotationVerdict({ ...base, complete: false })).toBe('incomplete');
    expect(rotationVerdict({ ...base, steps: steps(false) })).toBe('stopped');
    const codes = new Set(Object.values(ROTATION_EXIT_CODES).filter((c) => c !== 0));
    expect(codes.size).toBe(3);
  });

  it('a dry run is never a retire signal', () => {
    expect(rotationVerdict({ ...base, dryRun: true })).toBe('dry-run-complete');
  });
});
