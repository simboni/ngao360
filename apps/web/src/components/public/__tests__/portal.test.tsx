/**
 * Public portal (S24, tracking, public projects) logic and rendering tests.
 * Run: pnpm --filter @ngao360/web exec tsx --tsconfig src/components/public/__tests__/tsconfig.json --test src/components/public/__tests__/*.test.tsx
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CASE_STATUS_PUBLIC_STAGE, CONTACT_PREFERENCES, CURRENT_PORTAL_PRIVACY_NOTICE_VERSION, PROJECT_STAGE_KINDS, PUBLIC_CASE_STAGES } from '@ngao360/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiRequestError } from '@/lib/api-client';
import { en, translate } from '../i18n';
import { checkPhoto, photoType, scaledSize } from '../photo';
import { portalErrorKey, publicFileHref, serverFieldErrors } from '../portal-api';
import { PortalProvider } from '../portal-context';
import { formatMoney, PUBLIC_STAGE_SHORT } from '../project-labels';
import { ProjectDisclaimer, ProjectStageBadge } from '../project-parts';
import { buildSubmission, draftOf, EMPTY_REQUEST, orderedErrors, parseDraft, type RequestFormState, validateRequest } from '../request-model';
import { normaliseReference, publicStageSteps } from '../track-model';

const V = CURRENT_PORTAL_PRIVACY_NOTICE_VERSION;
const valid: RequestFormState = {
  ...EMPTY_REQUEST,
  category: 'WATER_SANITATION',
  description: 'The communal tap near the market has been dry for two weeks.',
  constituencyId: '11111111-1111-4111-8111-111111111111',
  privacyAcknowledged: true,
};

describe('i18n string table', () => {
  it('interpolates and falls back to English for missing Kiswahili keys', () => {
    assert.equal(translate('en', 'request.description.count', { count: 5, max: 4000 }), '5 of 4000 characters');
    assert.equal(translate('sw', 'request.submit'), en['request.submit']);
    assert.equal(translate('sw', 'shell.nav.home'), 'Mwanzo');
  });

  it('has a label for every public stage, contact preference and project stage kind', () => {
    for (const s of PUBLIC_CASE_STAGES) assert.ok(en[`stage.${s}`]);
    for (const p of CONTACT_PREFERENCES) assert.ok(en[`request.contact.${p}`]);
    for (const k of PROJECT_STAGE_KINDS) {
      assert.ok(en[`projects.stage.${k}`]);
      assert.ok(en[`projects.legend.${k}`]);
    }
  });

  it('never says a project is completed without "(reported)" or "verified"', () => {
    for (const [key, value] of Object.entries(en)) {
      if (/\bcomplete(d)?\b/i.test(value) && key.startsWith('projects.stage.')) {
        assert.match(value, /reported|verified/i, `${key} must qualify completion`);
      }
    }
    assert.equal(PUBLIC_STAGE_SHORT.REPORTED_COMPLETE, 'Completed (reported)');
    assert.equal(PUBLIC_STAGE_SHORT.VERIFIED_COMPLETE, 'Verified completed');
    assert.equal(PUBLIC_STAGE_SHORT.COMMITMENT, 'Commitment');
  });

  it('keeps visible portal text in the string table (no hard-coded English in JSX text nodes of the form)', () => {
    const dir = join(__dirname, '..');
    for (const f of readdirSync(dir).filter((n) => /^(request-form|track-view|receipt)\.tsx$/.test(n))) {
      const src = readFileSync(join(dir, f), 'utf8');
      // JSX text nodes are lines that are only words between tags.
      const offenders = src.split('\n').filter((l) => /^\s+[A-Z][a-z]+( [a-z]+){2,}[.!]?\s*$/.test(l));
      assert.deepEqual(offenders, [], `${f} has untranslated text`);
    }
  });
});

describe('S24 request model', () => {
  it('builds a valid submission and passes the shared schema', () => {
    const r = validateRequest(valid, V, { requireLocation: true });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.payload.geographicUnitId, valid.constituencyId);
      assert.equal(r.payload.contactPreference, 'NONE');
      assert.equal(r.payload.consentToContact, false);
    }
  });

  it('sends no contact details at all when the person chose "Do not contact me"', () => {
    const p = buildSubmission({ ...valid, name: 'Typed then changed mind', phone: '0712345678', email: 'x@example.org', consentToContact: true }, V);
    assert.equal(p.name, undefined);
    assert.equal(p.phone, undefined);
    assert.equal(p.email, undefined);
    assert.equal(p.consentToContact, false);
  });

  it('sends only the field for the chosen channel', () => {
    const p = buildSubmission({ ...valid, contactPreference: 'SMS', phone: '0712 345678', email: 'x@example.org', consentToContact: true }, V);
    assert.equal(p.phone, '0712 345678');
    assert.equal(p.email, undefined);
  });

  it('prefers the ward over the constituency', () => {
    const p = buildSubmission({ ...valid, wardId: '22222222-2222-4222-8222-222222222222' }, V);
    assert.equal(p.geographicUnitId, '22222222-2222-4222-8222-222222222222');
  });

  it('reports plain-language errors in page order', () => {
    const r = validateRequest({ ...EMPTY_REQUEST, contactPreference: 'PHONE' }, V, { requireLocation: true });
    assert.equal(r.ok, false);
    if (!r.ok) {
      const fields = orderedErrors(r.errors).map((e) => e.field);
      assert.deepEqual(fields, ['category', 'description', 'constituencyId', 'phone', 'consentToContact', 'privacyAcknowledged']);
    }
  });

  it('accepts a landmark instead of a constituency', () => {
    const r = validateRequest({ ...valid, constituencyId: '', landmark: 'Behind the Kimilili bus stage' }, V, { requireLocation: true });
    assert.equal(r.ok, true);
  });

  it('refuses a submission with a filled honeypot only on the server (it is still sent)', () => {
    const p = buildSubmission({ ...valid, website: 'http://spam' }, V);
    assert.equal(p.website, 'http://spam');
  });

  it('drafts never contain contact details or consent', () => {
    const d = draftOf({ ...valid, contactPreference: 'EMAIL', email: 'secret@example.org', name: 'Secret', consentToContact: true });
    const json = JSON.stringify(d);
    assert.ok(!json.includes('secret@example.org'));
    assert.ok(!json.includes('Secret'));
    assert.deepEqual(Object.keys(d).sort(), ['category', 'constituencyId', 'description', 'landmark', 'wardId']);
    assert.deepEqual(parseDraft(JSON.stringify(d)), d);
    assert.equal(parseDraft('{not json'), null);
    assert.equal(parseDraft(JSON.stringify({ category: '' })), null);
  });
});

describe('photo checks', () => {
  const accepted = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
  it('accepts allowed types and refuses others or oversized files', () => {
    assert.deepEqual(checkPhoto({ name: 'a.jpg', type: 'image/jpeg', size: 1000 }, 8_000_000, accepted), { ok: true });
    assert.deepEqual(checkPhoto({ name: 'a.pdf', type: 'application/pdf', size: 1000 }, 8_000_000, accepted), { ok: false, reason: 'type' });
    assert.deepEqual(checkPhoto({ name: 'a.png', type: 'image/png', size: 9_000_000 }, 8_000_000, accepted), { ok: false, reason: 'size' });
  });
  it('infers HEIC from the extension when the browser gives no type', () => {
    assert.equal(photoType({ name: 'IMG_1.HEIC', type: '' }), 'image/heic');
    assert.equal(photoType({ name: 'x', type: 'image/heif' }), 'image/heic');
  });
  it('scales down to 1600 px on the long side and never up', () => {
    assert.deepEqual(scaledSize(4000, 3000), { width: 1600, height: 1200 });
    assert.deepEqual(scaledSize(800, 600), { width: 800, height: 600 });
  });
});

describe('tracking', () => {
  it('shows "Referred" instead of "Being worked on" for referred requests', () => {
    const steps = publicStageSteps('REFERRED');
    assert.deepEqual(steps.map((s) => s.stage), ['RECEIVED', 'UNDER_REVIEW', 'REFERRED', 'RESOLUTION_PROPOSED', 'CLOSED']);
    assert.deepEqual(steps.map((s) => s.state), ['done', 'done', 'current', 'upcoming', 'upcoming']);
  });
  it('maps every internal status to a step on the line', () => {
    for (const stage of Object.values(CASE_STATUS_PUBLIC_STAGE)) {
      assert.equal(publicStageSteps(stage).filter((s) => s.state === 'current').length, 1);
    }
  });
  it('normalises typed references', () => {
    assert.equal(normaliseReference(' bg-7k3f 9q2x '), 'BG-7K3F9Q2X');
  });
});

describe('portal API helpers', () => {
  it('prefixes evidence file paths with /api', () => {
    assert.equal(publicFileHref('/public/x/projects/1/evidence/2/file'), '/api/public/x/projects/1/evidence/2/file');
    assert.equal(publicFileHref('/api/public/x'), '/api/public/x');
  });
  it('maps API errors to portal messages', () => {
    const err = (code: string, status = 400) => new ApiRequestError(status, { statusCode: status, error: 'x', code, message: 'x' });
    assert.equal(portalErrorKey(err('RATE_LIMITED', 429)), 'common.error.rateLimited');
    assert.equal(portalErrorKey(err('ABUSE_CHECK_FAILED')), 'common.error.abuse');
    assert.equal(portalErrorKey(new TypeError('Failed to fetch')), 'common.error.offline');
    const v = new ApiRequestError(400, { statusCode: 400, error: 'x', code: 'VALIDATION_FAILED', message: 'x', details: [{ path: 'payload.phone', message: 'bad' }] });
    assert.deepEqual(serverFieldErrors(v), { phone: 'bad' });
  });
  it('formats money strings without float rounding', () => {
    assert.equal(formatMoney('12500000.5', 'KES'), 'KES 12,500,000.50');
    assert.equal(formatMoney(null, 'KES'), null);
  });
});

describe('public project rendering', () => {
  const wrap = (node: React.ReactNode) => renderToStaticMarkup(<PortalProvider slug="bungoma-governor">{node}</PortalProvider>);
  it('stage badges carry a word and an icon', () => {
    const html = wrap(<ProjectStageBadge kind="REPORTED_COMPLETE" />);
    assert.match(html, /Completed \(reported\)/);
    assert.match(html, /<svg/);
    assert.match(html, /aria-hidden="true"/);
  });
  it('the disclaimer always says a photograph is not proof of completion', () => {
    const html = wrap(<ProjectDisclaimer text="Synthetic disclaimer." />);
    assert.match(html, /A photograph alone does not prove that a project is complete/);
    assert.match(html, /Synthetic disclaimer/);
  });
});
