'use client';

/**
 * Captcha hook for public writes. Offices use the honeypot and rate limits
 * only (`captchaProvider: 'none'`) unless they configure a provider. A widget
 * for a provider is registered with `registerCaptchaWidget`; none is bundled,
 * because the portal loads no third-party scripts by default. Without a
 * widget the form explains that the check is unavailable, matching the API,
 * which fails closed (no verifier bound → every public write is refused).
 */
import type { PublicPortalInfo } from '@ngao360/shared';
import type { ComponentType } from 'react';

export type CaptchaProvider = PublicPortalInfo['captcha']['provider'];

export interface CaptchaWidgetProps {
  siteKey: string | null;
  onToken: (token: string | null) => void;
}

const widgets = new Map<Exclude<CaptchaProvider, 'none'>, ComponentType<CaptchaWidgetProps>>();

export function registerCaptchaWidget(provider: Exclude<CaptchaProvider, 'none'>, widget: ComponentType<CaptchaWidgetProps>): void {
  widgets.set(provider, widget);
}

/** 'none' → no check; 'ready' → a widget is registered; 'unavailable' → provider set but no widget. */
export function captchaState(captcha: PublicPortalInfo['captcha']): 'none' | 'ready' | 'unavailable' {
  if (captcha.provider === 'none') return 'none';
  return widgets.has(captcha.provider) ? 'ready' : 'unavailable';
}

export function CaptchaSlot({ captcha, onToken }: { captcha: PublicPortalInfo['captcha']; onToken: (token: string | null) => void }) {
  if (captcha.provider === 'none') return null;
  const Widget = widgets.get(captcha.provider);
  if (!Widget) return null;
  return (
    <div className="mb-5">
      <Widget siteKey={captcha.siteKey} onToken={onToken} />
    </div>
  );
}
