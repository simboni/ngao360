/**
 * Privacy notices shown at collection (blueprint 9.2 and 15.2): what is
 * collected, why, who receives it, how long it is kept and the person's rights.
 *
 * The notice text is versioned. Every citizen case and appointment stores the
 * version that was shown (`privacyNoticeVersion`), so a later change to the
 * wording never rewrites what a person agreed to. The controller name, contact
 * and retention period come from the tenant's office module configuration
 * (`OfficeModuleConfig`), because each office is its own data controller.
 */
import { z } from 'zod';

export const CURRENT_PORTAL_PRIVACY_NOTICE_VERSION = 'office-portal-2026-11-v2';
export const CURRENT_APPOINTMENT_PRIVACY_NOTICE_VERSION = 'office-appointment-2026-11-v1';

export const PrivacyNoticeSectionSchema = z.object({
  heading: z.string(),
  body: z.string(),
});
export type PrivacyNoticeSection = z.infer<typeof PrivacyNoticeSectionSchema>;

export const PrivacyNoticeSchema = z.object({
  version: z.string(),
  title: z.string(),
  /** Short summary shown next to the submit button. */
  summary: z.string(),
  /** What / why / who / how long / rights / contact. */
  sections: z.array(PrivacyNoticeSectionSchema),
});
export type PrivacyNotice = z.infer<typeof PrivacyNoticeSchema>;

export interface PrivacyNoticeContext {
  /** Data controller, e.g. "Office of the Governor, Bungoma County (synthetic)". */
  controllerName: string;
  /** Contact for data-protection requests (office email or postal address). */
  dataProtectionContact: string;
  /** Months case records and contact details are kept after closure. */
  caseRetentionMonths: number;
  contactRetentionMonths: number;
}

/** Public-portal notice (S24). Plain language, no legal advice. */
export function portalPrivacyNotice(ctx: PrivacyNoticeContext): PrivacyNotice {
  return {
    version: CURRENT_PORTAL_PRIVACY_NOTICE_VERSION,
    title: 'How we use the information in your request',
    summary: `${ctx.controllerName} uses this information only to handle your request. Contact details are optional.`,
    sections: [
      {
        heading: 'What we collect',
        body:
          'The type of issue, your description, the ward it concerns and an optional photograph. Your name, phone number ' +
          'or email address only if you choose to give them. We do not ask for your ID number, political views, ethnicity or religion; please do not include them. ' +
          'We do not keep your IP address or device details with your request, and we remove location data hidden in photos before storing them.',
      },
      {
        heading: 'Why we collect it',
        body:
          'To look into your request, refer it to the institution responsible if it is not handled by this office, and tell you about progress if you ask us to.',
      },
      {
        heading: 'Who receives it',
        body:
          `Authorised staff of ${ctx.controllerName}. If another public body is responsible (for example a national agency or a ` +
          'county department), we share the details of the issue with it. We share your contact details only if you agreed to be contacted. ' +
          'Your request is never used for campaigning or political profiling.',
      },
      {
        heading: 'How long we keep it',
        body:
          `Contact details are deleted ${ctx.contactRetentionMonths} months after the case is closed, or earlier if you ask. ` +
          `${ctx.caseRetentionMonths} months after closure, your description, messages and photo are removed too; an anonymised record ` +
          '(type of issue, area, dates and what the office did) is kept.',
      },
      {
        heading: 'Your rights',
        body:
          'You may ask to see or correct your personal information, to have it removed from your request earlier, or object to its use, under the Data Protection Act, 2019. ' +
          'You may also complain to the Office of the Data Protection Commissioner.',
      },
      {
        heading: 'Contact',
        body: `Data-protection requests: ${ctx.dataProtectionContact}. Quote your request reference.`,
      },
    ],
  };
}

/** Notice read to (or shown to) a person requesting an appointment. */
export function appointmentPrivacyNotice(ctx: PrivacyNoticeContext): PrivacyNotice {
  return {
    version: CURRENT_APPOINTMENT_PRIVACY_NOTICE_VERSION,
    title: 'How we use your appointment details',
    summary: `${ctx.controllerName} uses your name, contact and purpose only to arrange and follow up the appointment.`,
    sections: [
      { heading: 'What we collect', body: 'Your name, organisation (if any), a phone number or email address and the purpose of the appointment.' },
      { heading: 'Why', body: 'To schedule the appointment, confirm or change it, and record any agreed follow-up.' },
      { heading: 'Who receives it', body: `Authorised staff of ${ctx.controllerName} only.` },
      { heading: 'How long we keep it', body: `Appointment records are kept for ${ctx.caseRetentionMonths} months.` },
      { heading: 'Your rights and contact', body: `Data-protection requests: ${ctx.dataProtectionContact}.` },
    ],
  };
}
