import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfig } from '../config/app-config';
import { CAPTCHA_VERIFIERS, type CaptchaVerifier, CaptchaVerifierRegistry } from './captcha';
import { JobRunRecorder, JobScheduler } from './jobs';
import { defaultMessageProviders, MESSAGE_PROVIDERS, MessageProviderRegistry } from './messaging';
import { RATE_LIMIT_STORE, MemoryRateLimitStore, type RateLimitStore, RedisRateLimitStore } from './ratelimit';
import { MALWARE_SCANNER, NoopMalwareScanner } from './scanning';

/**
 * Shared platform services for pilot hardening (docs/ARCHITECTURE.md §16). Owner: platform-infra.
 *
 * Defaults bound here send, verify and scan nothing:
 *   MESSAGE_PROVIDERS  -> a log provider per channel (SKIPPED)
 *   MALWARE_SCANNER    -> NoopMalwareScanner (files stay PENDING; fail closed)
 *   CAPTCHA_VERIFIERS  -> none (a tenant that selects a provider is refused)
 *   RATE_LIMIT_STORE   -> memory, or Redis with RATE_LIMIT_STORE=redis
 * Vendor providers are chosen from AppConfig in these factories; secrets come only from env.
 */
@Global()
@Module({
  providers: [
    { provide: MESSAGE_PROVIDERS, useFactory: () => defaultMessageProviders() },
    MessageProviderRegistry,
    { provide: MALWARE_SCANNER, useClass: NoopMalwareScanner },
    { provide: CAPTCHA_VERIFIERS, useFactory: (): CaptchaVerifier[] => [] },
    {
      provide: CaptchaVerifierRegistry,
      inject: [CAPTCHA_VERIFIERS],
      useFactory: (verifiers: CaptchaVerifier[]) => new CaptchaVerifierRegistry(verifiers),
    },
    {
      provide: RATE_LIMIT_STORE,
      inject: [AppConfig],
      useFactory: (config: AppConfig): RateLimitStore =>
        config.values.RATE_LIMIT_STORE === 'redis'
          ? new RedisRateLimitStore(new Redis(config.values.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 }))
          : new MemoryRateLimitStore(),
    },
    JobRunRecorder,
    JobScheduler,
  ],
  exports: [MESSAGE_PROVIDERS, MessageProviderRegistry, MALWARE_SCANNER, CaptchaVerifierRegistry, RATE_LIMIT_STORE, JobRunRecorder, JobScheduler],
})
export class PlatformModule {}
