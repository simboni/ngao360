import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { loadConfig, missingProviderEnv } from '../../config/config.schema';
import { CaptchaVerifierRegistry, type CaptchaVerifier } from '../captcha';
import { defaultMessageProviders, LogMessageProvider, type MessageProvider, MessageProviderRegistry } from '../messaging';
import { MemoryRateLimitStore, RedisRateLimitStore } from '../ratelimit';
import { NoopMalwareScanner } from '../scanning';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://x@localhost/x',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('message provider registry', () => {
  it('defaults every channel to a log provider that is not a delivery', async () => {
    const registry = new MessageProviderRegistry(defaultMessageProviders());
    for (const ch of ['EMAIL', 'SMS', 'PUSH'] as const) {
      expect(registry.get(ch)).toBeInstanceOf(LogMessageProvider);
      expect(registry.isDeliveryConfigured(ch)).toBe(false);
    }
    const r = await registry.get('SMS').send({
      tenantId: randomUUID(), messageId: randomUUID(), channel: 'SMS', templateKey: 'contact.verify_sms',
      to: '+254700000001', subject: 's', text: 't', idempotencyKey: 'k-12345678',
    });
    expect(r.status).toBe('SKIPPED');
  });

  it('lets a configured provider replace the log provider for its channel', () => {
    const fake: MessageProvider = { channel: 'EMAIL', name: 'fake', isConfigured: () => true, send: async () => ({ status: 'SENT' }) };
    const registry = new MessageProviderRegistry([...defaultMessageProviders(), fake]);
    expect(registry.get('EMAIL').name).toBe('fake');
    expect(registry.isDeliveryConfigured('EMAIL')).toBe(true);
    expect(registry.isDeliveryConfigured('SMS')).toBe(false);
  });
});

describe('malware scanner default', () => {
  it('never reports CLEAN without a real engine (fail closed)', async () => {
    const s = new NoopMalwareScanner();
    expect(s.isConfigured()).toBe(false);
    expect((await s.scan()).status).toBe('ERROR');
  });
});

describe('captcha verifier registry (fail closed)', () => {
  const verifier = (impl: CaptchaVerifier['verify'], configured = true): CaptchaVerifier => ({
    provider: 'hcaptcha', siteKey: () => 'site', isConfigured: () => configured, verify: impl,
  });

  it('passes only for provider none or a verified token', async () => {
    const reg = new CaptchaVerifierRegistry([verifier(async (t) => (t === 'good' ? { ok: true } : { ok: false, reason: 'invalid' }))]);
    expect(await reg.verify('none', undefined, null)).toEqual({ ok: true });
    expect(await reg.verify('hcaptcha', 'good', null)).toEqual({ ok: true });
    expect(await reg.verify('hcaptcha', 'bad', null)).toEqual({ ok: false, reason: 'invalid' });
    expect(await reg.verify('hcaptcha', undefined, null)).toEqual({ ok: false, reason: 'missing' });
    expect(await reg.verify('turnstile', 'good', null)).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('refuses when the provider throws or is not configured', async () => {
    const throwing = new CaptchaVerifierRegistry([verifier(async () => { throw new Error('network down'); })]);
    expect(await throwing.verify('hcaptcha', 'tok', null)).toEqual({ ok: false, reason: 'unavailable' });
    const unconfigured = new CaptchaVerifierRegistry([verifier(async () => ({ ok: true }), false)]);
    expect(await unconfigured.verify('hcaptcha', 'tok', null)).toEqual({ ok: false, reason: 'not_configured' });
  });
});

describe('rate-limit stores', () => {
  it('memory store counts within a fixed window and resets', async () => {
    const s = new MemoryRateLimitStore();
    expect((await s.hit('k', 1000)).count).toBe(1);
    expect((await s.hit('k', 1000)).count).toBe(2);
    expect((await s.peek('k'))?.count).toBe(2);
    await s.reset('k');
    expect(await s.peek('k')).toBeNull();
  });

  const redisUrl = process.env.REDIS_URL;
  (redisUrl ? it : it.skip)('redis store shares counters across instances', async () => {
    const a = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
    const b = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
    const prefix = `ngao360:test:${randomUUID()}:`;
    const s1 = new RedisRateLimitStore(a, prefix);
    const s2 = new RedisRateLimitStore(b, prefix);
    try {
      expect((await s1.hit('ip', 5000)).count).toBe(1);
      const second = await s2.hit('ip', 5000);
      expect(second.count).toBe(2);
      expect(second.resetAt).toBeGreaterThan(Date.now());
      expect((await s1.peek('ip'))?.count).toBe(2);
      await s2.reset('ip');
      expect(await s1.peek('ip')).toBeNull();
    } finally {
      await s1.onModuleDestroy();
      await s2.onModuleDestroy();
    }
  });
});

describe('provider configuration (names only, fail closed)', () => {
  it('defaults to the log / no-op providers', () => {
    const c = loadConfig({ ...BASE_ENV } as NodeJS.ProcessEnv);
    expect([c.EMAIL_PROVIDER, c.SMS_PROVIDER, c.PUSH_PROVIDER, c.MALWARE_SCANNER, c.CAPTCHA_PROVIDER, c.RATE_LIMIT_STORE]).toEqual(['log', 'log', 'log', 'none', 'none', 'memory']);
    expect(missingProviderEnv(c)).toEqual([]);
  });

  it('refuses to start when a selected provider lacks its secrets, without printing values', () => {
    const env = { ...BASE_ENV, SMS_PROVIDER: 'africastalking', AFRICASTALKING_USERNAME: 'sandbox' } as NodeJS.ProcessEnv;
    expect(() => loadConfig(env)).toThrow(/AFRICASTALKING_API_KEY/);
    try {
      loadConfig(env);
    } catch (e) {
      expect((e as Error).message).not.toContain('sandbox');
    }
  });

  it('requires messaging keys in production', () => {
    const env = { ...BASE_ENV, NODE_ENV: 'production', APP_DATABASE_URL: 'postgresql://y@localhost/y', COOKIE_SECURE: 'true' } as NodeJS.ProcessEnv;
    expect(() => loadConfig(env)).toThrow(/MESSAGING_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...env, MESSAGING_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'), MESSAGING_HASH_KEY: 'h'.repeat(40) })).not.toThrow();
  });
});
