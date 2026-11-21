import { webAuthnRpIdProblem } from '../config.schema';

describe('WEBAUTHN_RP_ID start-up check', () => {
  it('accepts the origin host itself', () => {
    expect(webAuthnRpIdProblem('app.ngao360.co.ke', 'https://app.ngao360.co.ke')).toBeNull();
    expect(webAuthnRpIdProblem('localhost', 'http://localhost:3000')).toBeNull();
  });

  it('accepts the registrable parent domain used in production', () => {
    expect(webAuthnRpIdProblem('ngao360.co.ke', 'https://app.ngao360.co.ke')).toBeNull();
  });

  it('refuses an unrelated domain or a lookalike suffix', () => {
    expect(webAuthnRpIdProblem('ngao360.co.ke', 'https://staging.example.org')).toMatch(/must equal/);
    expect(webAuthnRpIdProblem('o360.co.ke', 'https://app.ngao360.co.ke')).toMatch(/must equal/);
  });

  it('refuses a child of the origin host and values with a scheme or path', () => {
    expect(webAuthnRpIdProblem('x.app.ngao360.co.ke', 'https://app.ngao360.co.ke')).toMatch(/must equal/);
    expect(webAuthnRpIdProblem('https://ngao360.co.ke', 'https://app.ngao360.co.ke')).toMatch(/bare host/);
  });
});
