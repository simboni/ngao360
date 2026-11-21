/**
 * Message templates (MESSAGE_TEMPLATE_KEYS). Owner: platform-infra.
 *
 * Every message is about the recipient's own account or work, or (Office acknowledgements) the
 * request the citizen themselves submitted. No persuasion, no outreach, no other people's personal
 * data. Payload values are plain strings chosen by the enqueuing module (references, labels, dates);
 * one-time secrets (invitation / recovery tokens, verification codes) come from the sealed secret
 * payload and appear only in the rendered body, never in logs or the outbox payload.
 *
 * SMS bodies stay short (one or two segments) and never carry a link to a sign-in secret: an SMS
 * invitation would put a bearer token in an operator's logs, so invitations and recovery links are
 * e-mail only.
 */
import { MESSAGE_TEMPLATE_KEYS, type MessageChannel } from '@ngao360/shared';

export interface RenderInput {
  templateKey: string;
  channel: MessageChannel;
  payload: Record<string, unknown>;
  secrets: Record<string, string>;
  /** Web origin for links, e.g. https://app.ngao360.example. */
  webOrigin: string;
  /** Sender name shown in e-mail ("NGAO360"). */
  productName: string;
}

export interface RenderedMessage {
  subject: string;
  text: string;
  html: string | null;
  link: string | null;
}

export class TemplateRenderError extends Error {}

/** `auth.security_alert` events (auth-recovery) and the sentence the person reads. */
const SECURITY_EVENTS: Record<string, string> = {
  passkey_registered: 'A passkey was added to your account',
  passkey_revoked: 'A passkey was removed from your account',
  passkey_counter_regression: 'A sign-in was refused because a passkey looked cloned',
  recovery_codes_generated: 'New recovery codes were created for your account',
  recovery_code_used: 'A recovery code was used to sign in to your account',
  account_recovery_requested: 'An administrator started recovery of your account',
  account_recovery_completed: 'Your account was recovered and a new password was set',
};

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : fallback);

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function html(paragraphs: string[], link: { href: string; label: string } | null, footer: string): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 12px">${escapeHtml(p)}</p>`).join('');
  const button = link
    ? `<p style="margin:16px 0"><a href="${escapeHtml(link.href)}" style="background:#0f4c81;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escapeHtml(link.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:15px;color:#1a1a1a;max-width:560px">${body}${button}<p style="margin:24px 0 0;font-size:12px;color:#666">${escapeHtml(footer)}</p></body></html>`;
}

function absolute(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Only same-origin relative paths are linked (never an arbitrary URL from a payload). */
function safePath(v: unknown): string | null {
  const p = str(v);
  return p.startsWith('/') && !p.startsWith('//') && !/[\s<>"']/.test(p) ? p : null;
}

export function renderMessage(input: RenderInput): RenderedMessage {
  const { payload: p, secrets: s, channel, webOrigin, productName } = input;
  const footer = `${productName} sends service messages about your own account and work only.`;
  const org = str(p.organisationName, productName);
  switch (input.templateKey) {
    case MESSAGE_TEMPLATE_KEYS.AUTH_INVITATION: {
      if (channel !== 'EMAIL') throw new TemplateRenderError('Invitations are sent by e-mail only');
      if (!s.token) throw new TemplateRenderError('Invitation token missing');
      const link = absolute(webOrigin, `/accept-invitation#token=${encodeURIComponent(s.token)}`);
      const expires = str(p.expiresAt);
      const lines = [
        `You have been invited to ${org} on ${productName}.`,
        'Open the link below to set your password. The link works once' + (expires ? ` and expires on ${expires}.` : '.'),
        'If you did not expect this invitation, ignore this e-mail.',
      ];
      return { subject: `Your ${productName} invitation`, text: `${lines.join('\n\n')}\n\n${link}\n\n${footer}`, html: html(lines, { href: link, label: 'Accept invitation' }, footer), link };
    }
    case MESSAGE_TEMPLATE_KEYS.AUTH_RECOVERY_LINK: {
      if (channel !== 'EMAIL') throw new TemplateRenderError('Recovery links are sent by e-mail only');
      const given = safePath(s.recoverPath);
      const path = (given?.startsWith('/recover') ? given : null) ?? (s.token ? `/recover#token=${encodeURIComponent(s.token)}` : null);
      if (!path) throw new TemplateRenderError('Recovery token missing');
      const link = absolute(webOrigin, path);
      const lines = [
        `An administrator of ${org} approved the recovery of your ${productName} account.`,
        'Open the link below to set a new password. You will set up two-step sign-in again afterwards. The link works once.',
        'If you did not ask for this, contact your administrator straight away.',
      ];
      return { subject: `Recover your ${productName} account`, text: `${lines.join('\n\n')}\n\n${link}\n\n${footer}`, html: html(lines, { href: link, label: 'Recover account' }, footer), link };
    }
    case MESSAGE_TEMPLATE_KEYS.AUTH_SECURITY_ALERT: {
      const what = SECURITY_EVENTS[str(p.event)] ?? 'A security setting on your account changed';
      const when = str(p.at) || str(p.occurredAt);
      const text = `${productName} security alert: ${what}${when ? ` (${when})` : ''}. If this was not you, contact your administrator.`;
      const link = absolute(webOrigin, '/settings/account');
      return { subject: `${productName} security alert`, text: channel === 'EMAIL' ? `${text}\n\n${link}\n\n${footer}` : text, html: html([text], { href: link, label: 'Review your account' }, footer), link };
    }
    case MESSAGE_TEMPLATE_KEYS.CONTACT_VERIFY_EMAIL:
    case MESSAGE_TEMPLATE_KEYS.CONTACT_VERIFY_SMS: {
      if (!/^\d{6}$/.test(s.code ?? '')) throw new TemplateRenderError('Verification code missing');
      const text = `Your ${productName} verification code is ${s.code}. It expires in 10 minutes. Do not share it.`;
      return { subject: `${productName} verification code`, text: channel === 'EMAIL' ? `${text}\n\n${footer}` : text, html: html([text], null, footer), link: null };
    }
    case MESSAGE_TEMPLATE_KEYS.NOTIFICATION_ALERT: {
      const title = str(p.title, 'New notification');
      const body = str(p.body);
      const path = safePath(p.link);
      const link = path ? absolute(webOrigin, path) : null;
      const critical = p.severity === 'CRITICAL';
      const subject = `${critical ? '[Critical] ' : ''}${title}`.slice(0, 200);
      if (channel === 'SMS') return { subject, text: `${productName}: ${subject}${body ? ` - ${body}` : ''}`.slice(0, 300), html: null, link: null };
      const lines = [title, ...(body ? [body] : [])];
      return { subject, text: `${lines.join('\n\n')}${link ? `\n\n${link}` : ''}\n\n${footer}`, html: html(lines, link ? { href: link, label: 'Open in NGAO360' } : null, footer), link };
    }
    case MESSAGE_TEMPLATE_KEYS.OFFICE_CASE_ACKNOWLEDGEMENT: {
      const office = str(p.officeName, org);
      const ref = str(p.reference);
      if (!ref) throw new TemplateRenderError('Case reference missing');
      const text = `${office} received your request ${ref}. Use your reference and tracking code to follow it on the public portal. Reply STOP to stop messages.`;
      const emailText = `${office} received your request ${ref}.\n\nUse your reference and the tracking code you were shown to follow it on the public portal.\n\nThis is the only message we send unless you asked to be contacted about this request.`;
      return {
        subject: `Request ${ref} received`,
        text: channel === 'SMS' ? text : emailText,
        html: html([`${office} received your request ${ref}.`, 'Use your reference and the tracking code you were shown to follow it on the public portal.'], null, `${office} uses this address only for your request.`),
        link: null,
      };
    }
    default:
      throw new TemplateRenderError(`Unknown template ${input.templateKey}`);
  }
}
