import { Global, Logger, type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CSRF_HEADER } from '@ngao360/shared';
import Redis from 'ioredis';
import { AppConfig } from '../config/app-config';
import { CAPTCHA_VERIFIER, type CaptchaVerifier as OfficeCaptchaVerifier } from '../modules/office/public/public-abuse.service';
import { CAPTCHA_VERIFIERS, type CaptchaVerifier, CaptchaVerifierRegistry, HttpCaptchaVerifier } from './captcha';
import { JobRunRecorder, JobScheduler } from './jobs';
import { TallyComparisonRetryService } from './jobs/handlers/tally-comparison-retry.service';
import { TasksDueSoonService } from './jobs/handlers/tasks-due-soon.service';
import { StageComparisonController } from './jobs/handlers/stage-comparison.controller';
import { defaultMessageProviders, MESSAGE_OUTBOX, MESSAGE_PROVIDERS, type MessageProvider, MessageProviderRegistry } from './messaging';
import { CaseAcknowledgementService } from './messaging/case-acknowledgement.service';
import { ContactsService } from './messaging/contacts.service';
import { MeContactsController, OutboxAdminController } from './messaging/messaging.controllers';
import { MessagingCrypto } from './messaging/messaging-crypto';
import { OutboxDispatcherService } from './messaging/outbox-dispatcher.service';
import { MessageOutboxService } from './messaging/outbox.service';
import { AfricasTalkingSmsProvider } from './messaging/providers/africastalking.provider';
import { SmtpEmailProvider } from './messaging/providers/smtp.provider';
import { WebPushProvider } from './messaging/providers/webpush.provider';
import { SmsWebhooksController, webhookRequestMiddleware } from './messaging/webhooks.controller';
import { FileScanController, JobsController } from './platform.controllers';
import { AccountRateLimitGuard, RATE_LIMIT_STORE, MemoryRateLimitStore, type RateLimitStore, RedisRateLimitStore } from './ratelimit';
import { ClamdMalwareScanner, MALWARE_SCANNER, type MalwareScanner, NoopMalwareScanner } from './scanning';
import { FileScanService } from './scanning/file-scan.service';

/** Vendor providers selected by env; the log provider stays for every channel not configured. */
export function messageProvidersFromConfig(config: AppConfig): MessageProvider[] {
  const v = config.values;
  const providers: MessageProvider[] = defaultMessageProviders();
  if (v.EMAIL_PROVIDER === 'smtp' && v.SMTP_HOST && v.EMAIL_FROM_ADDRESS) {
    providers.push(
      new SmtpEmailProvider({
        host: v.SMTP_HOST,
        port: v.SMTP_PORT,
        secure: v.SMTP_SECURE,
        ...(v.SMTP_USER ? { user: v.SMTP_USER } : {}),
        ...(v.SMTP_PASSWORD ? { password: v.SMTP_PASSWORD } : {}),
        fromAddress: v.EMAIL_FROM_ADDRESS,
        fromName: v.EMAIL_FROM_NAME,
      }),
    );
  }
  if (v.SMS_PROVIDER === 'africastalking' && v.AFRICASTALKING_USERNAME && v.AFRICASTALKING_API_KEY) {
    providers.push(
      new AfricasTalkingSmsProvider({
        baseUrl: v.AFRICASTALKING_BASE_URL,
        username: v.AFRICASTALKING_USERNAME,
        apiKey: v.AFRICASTALKING_API_KEY,
        ...(v.AFRICASTALKING_SENDER_ID ? { senderId: v.AFRICASTALKING_SENDER_ID } : {}),
      }),
    );
  }
  if (v.PUSH_PROVIDER === 'webpush' && v.VAPID_PUBLIC_KEY && v.VAPID_PRIVATE_KEY && v.VAPID_SUBJECT) {
    providers.push(new WebPushProvider({ publicKey: v.VAPID_PUBLIC_KEY, privateKey: v.VAPID_PRIVATE_KEY, subject: v.VAPID_SUBJECT }));
  }
  return providers;
}

export function malwareScannerFromConfig(config: AppConfig): MalwareScanner {
  const v = config.values;
  if (v.MALWARE_SCANNER === 'clamd') return new ClamdMalwareScanner({ host: v.CLAMD_HOST, port: v.CLAMD_PORT, timeoutMs: v.CLAMD_TIMEOUT_MS });
  return new NoopMalwareScanner();
}

export function captchaVerifiersFromConfig(config: AppConfig): CaptchaVerifier[] {
  const v = config.values;
  if (v.CAPTCHA_PROVIDER === 'none' || !v.CAPTCHA_SITE_KEY || !v.CAPTCHA_SECRET) return [];
  return [
    new HttpCaptchaVerifier({
      provider: v.CAPTCHA_PROVIDER,
      siteKey: v.CAPTCHA_SITE_KEY,
      secret: v.CAPTCHA_SECRET,
      ...(v.CAPTCHA_VERIFY_URL ? { verifyUrl: v.CAPTCHA_VERIFY_URL } : {}),
      timeoutMs: v.CAPTCHA_TIMEOUT_MS,
    }),
  ];
}

/**
 * Production always keeps counters in Redis (shared across API instances); memory is only for
 * development and tests with RATE_LIMIT_STORE=memory. Commands fail fast when Redis is down so
 * the limiters refuse (503) instead of hanging.
 */
export function rateLimitStoreFromConfig(config: AppConfig): RateLimitStore {
  const v = config.values;
  if (v.RATE_LIMIT_STORE === 'redis' || v.NODE_ENV === 'production') {
    if (v.RATE_LIMIT_STORE !== 'redis') new Logger('PlatformModule').warn('RATE_LIMIT_STORE=memory is ignored in production: using Redis');
    return new RedisRateLimitStore(
      new Redis(v.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2000, commandTimeout: 1500 }),
    );
  }
  return new MemoryRateLimitStore();
}

/**
 * Shared platform services for pilot hardening (docs/ARCHITECTURE.md §16). Owner: platform-infra.
 *
 * Providers are chosen from AppConfig (env) in the factories above; each defaults to the log /
 * no-op one:
 *   MESSAGE_PROVIDERS  -> log per channel; SMTP, Africa's Talking, web-push when configured
 *   MALWARE_SCANNER    -> none (files stay PENDING; fail closed), or clamd
 *   CAPTCHA_VERIFIERS  -> none (a tenant that selects a provider is refused), or hCaptcha / Turnstile
 *   RATE_LIMIT_STORE   -> memory in development, Redis with RATE_LIMIT_STORE=redis and always in production
 * Durable jobs registered here: messaging.dispatch, files.scan_pending, tally.comparison_retry,
 * tasks.due_soon (office.retention and field.station_status_record register from their modules).
 */
@Global()
@Module({
  controllers: [MeContactsController, OutboxAdminController, SmsWebhooksController, FileScanController, JobsController, StageComparisonController],
  providers: [
    { provide: MESSAGE_PROVIDERS, inject: [AppConfig], useFactory: messageProvidersFromConfig },
    MessageProviderRegistry,
    { provide: MALWARE_SCANNER, inject: [AppConfig], useFactory: malwareScannerFromConfig },
    { provide: CAPTCHA_VERIFIERS, inject: [AppConfig], useFactory: captchaVerifiersFromConfig },
    {
      provide: CaptchaVerifierRegistry,
      inject: [CAPTCHA_VERIFIERS],
      useFactory: (verifiers: CaptchaVerifier[]) => new CaptchaVerifierRegistry(verifiers),
    },
    // The Office portal's captcha hook, bound to the registry (fail closed).
    {
      provide: CAPTCHA_VERIFIER,
      inject: [CaptchaVerifierRegistry],
      useFactory: (registry: CaptchaVerifierRegistry): OfficeCaptchaVerifier => ({
        verify: async (provider, token, remoteIp) => (await registry.verify(provider, token, remoteIp)).ok,
      }),
    },
    { provide: RATE_LIMIT_STORE, inject: [AppConfig], useFactory: rateLimitStoreFromConfig },
    { provide: APP_GUARD, useClass: AccountRateLimitGuard },
    JobRunRecorder,
    JobScheduler,
    MessagingCrypto,
    MessageOutboxService,
    { provide: MESSAGE_OUTBOX, useExisting: MessageOutboxService },
    OutboxDispatcherService,
    ContactsService,
    CaseAcknowledgementService,
    FileScanService,
    TallyComparisonRetryService,
    TasksDueSoonService,
  ],
  exports: [
    MESSAGE_PROVIDERS,
    MessageProviderRegistry,
    MALWARE_SCANNER,
    CaptchaVerifierRegistry,
    CAPTCHA_VERIFIER,
    RATE_LIMIT_STORE,
    JobRunRecorder,
    JobScheduler,
    MessagingCrypto,
    MessageOutboxService,
    MESSAGE_OUTBOX,
    OutboxDispatcherService,
    CaseAcknowledgementService,
    FileScanService,
  ],
})
export class PlatformModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(webhookRequestMiddleware(CSRF_HEADER)).forRoutes({ path: 'webhooks/*path', method: RequestMethod.POST });
  }
}
