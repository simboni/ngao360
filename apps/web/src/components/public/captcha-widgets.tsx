'use client';

/**
 * hCaptcha and Cloudflare Turnstile widgets for the public portal (PI4). The provider's script is
 * loaded only on a portal whose office chose that provider (and only on the page that shows the
 * form); nothing third-party loads otherwise. The token goes to the API, which verifies it
 * server-side and fails closed. Without a site key the widget says the check is unavailable.
 */
import { useEffect, useRef, useState } from 'react';
import { type CaptchaWidgetProps, registerCaptchaWidget } from './captcha';

interface RenderApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string | number;
  remove?: (id: string | number) => void;
}

const SCRIPTS = {
  hcaptcha: { src: 'https://js.hcaptcha.com/1/api.js?render=explicit', global: 'hcaptcha' },
  turnstile: { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', global: 'turnstile' },
} as const;

const loading = new Map<string, Promise<RenderApi>>();

function loadProvider(provider: keyof typeof SCRIPTS): Promise<RenderApi> {
  const existing = loading.get(provider);
  if (existing) return existing;
  const { src, global } = SCRIPTS[provider];
  const p = new Promise<RenderApi>((resolve, reject) => {
    const ready = () => {
      const api = (window as unknown as Record<string, RenderApi | undefined>)[global];
      if (api) resolve(api);
      else reject(new Error('captcha api missing'));
    };
    if ((window as unknown as Record<string, unknown>)[global]) return ready();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.defer = true;
    s.onload = ready;
    s.onerror = () => reject(new Error('captcha script failed'));
    document.head.appendChild(s);
  });
  p.catch(() => loading.delete(provider));
  loading.set(provider, p);
  return p;
}

function makeWidget(provider: keyof typeof SCRIPTS) {
  return function CaptchaWidget({ siteKey, onToken }: CaptchaWidgetProps) {
    const el = useRef<HTMLDivElement>(null);
    const [failed, setFailed] = useState(false);
    // The parent passes a new callback each render; keep the latest without re-rendering the widget.
    const tokenRef = useRef(onToken);
    tokenRef.current = onToken;
    useEffect(() => {
      if (!siteKey || !el.current) return;
      let id: string | number | null = null;
      let api: RenderApi | null = null;
      let cancelled = false;
      loadProvider(provider)
        .then((a) => {
          if (cancelled || !el.current) return;
          api = a;
          id = a.render(el.current, {
            sitekey: siteKey,
            callback: (token: string) => tokenRef.current(token),
            'expired-callback': () => tokenRef.current(null),
            'error-callback': () => tokenRef.current(null),
          });
        })
        .catch(() => !cancelled && setFailed(true));
      return () => {
        cancelled = true;
        if (api?.remove && id !== null) api.remove(id);
      };
    }, [siteKey]);
    if (!siteKey || failed) {
      return (
        <p role="status" className="text-meta text-slate">
          The anti-spam check could not load, so the request cannot be sent right now. Please try again later.
        </p>
      );
    }
    return <div ref={el} data-captcha-provider={provider} />;
  };
}

registerCaptchaWidget('hcaptcha', makeWidget('hcaptcha'));
registerCaptchaWidget('turnstile', makeWidget('turnstile'));
