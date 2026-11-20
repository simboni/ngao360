/**
 * String tables for the public portal (S24, tracking, public projects).
 *
 * English is complete. Kiswahili (`sw`) is a partial table that falls back to
 * English key by key, so translators can add strings without code changes
 * (blueprint 12.4: English first, architecture ready for Kiswahili).
 *
 * Rules for every string: plain language, short sentences, no jargon, no
 * political language. Statuses are always shown as a word next to an icon.
 */

export const PORTAL_LOCALES = ['en', 'sw'] as const;
export type PortalLocale = (typeof PORTAL_LOCALES)[number];

export const en = {
  // Shell
  'shell.portal': 'Public service portal',
  'shell.nav.label': 'Portal',
  'shell.nav.home': 'Home',
  'shell.nav.request': 'Report an issue',
  'shell.nav.track': 'Track a request',
  'shell.nav.projects': 'Projects',
  'shell.footer.noAccount': 'No account is needed. We collect only what we need to handle your request.',
  'shell.footer.privacy': 'Privacy notice',
  'shell.skip': 'Skip to main content',

  // Common
  'common.loading': 'Loading…',
  'common.retry': 'Try again',
  'common.optional': 'optional',
  'common.required': 'required',
  'common.back': 'Back',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.notFound.title': 'This portal is not available',
  'common.notFound.body': 'Check the web address. If you followed a link from an office, contact that office directly.',
  'common.error.generic': 'Something went wrong. Please try again in a moment.',
  'common.error.offline': 'You appear to be offline. Check your connection and try again.',
  'common.error.rateLimited': 'Too many attempts from your connection. Please wait a few minutes and try again.',
  'common.error.abuse': 'We could not accept this request. Please try again.',
  'common.error.validation': 'Some answers need attention. Check the messages below.',
  'common.errorSummary': 'There is a problem',

  // Home
  'home.title': 'How can we help?',
  'home.intro': 'Report a service issue to {office}, follow a request you already made, or see public information about development projects.',
  'home.request.title': 'Report an issue',
  'home.request.body': 'Water, roads, health, markets and other public services. It takes about 3 minutes. No account needed.',
  'home.track.title': 'Track a request',
  'home.track.body': 'Use the reference and tracking code you received when you made the request.',
  'home.projects.title': 'Development projects',
  'home.projects.body': 'See who is responsible for each project, where the commitment came from and whether completion has been verified.',
  'home.privacy.title': 'Your information',
  'home.privacy.body': 'We collect only what we need to handle your request. Contact details are optional. Your request is never used for campaigning.',
  'home.privacy.link': 'Read the privacy notice',
  'home.emergency': 'For emergencies, call 999 or 112. This portal is not monitored around the clock.',

  // Request form
  'request.title': 'Report an issue',
  'request.intro': 'Tell us about a problem with a public service. You do not need an account. Fields marked "optional" can be left empty.',
  'request.step.what': '1. What is the issue?',
  'request.step.where': '2. Where is it?',
  'request.step.photo': '3. Photo',
  'request.step.contact': '4. Can we contact you?',
  'request.step.privacy': '5. Before you send',
  'request.category': 'Type of issue',
  'request.category.placeholder': 'Choose the closest match',
  'request.description': 'Describe the issue',
  'request.description.hint': 'What is happening, since when, and who is affected. Do not include ID numbers or other people’s personal details.',
  'request.description.count': '{count} of {max} characters',
  'request.constituency': 'Constituency',
  'request.constituency.placeholder': 'Choose a constituency',
  'request.ward': 'Ward',
  'request.ward.placeholder': 'Choose a ward',
  'request.ward.hint': 'Choose the constituency first. If you are not sure of the ward, leave it empty.',
  'request.landmark': 'Nearest landmark',
  'request.landmark.hint': 'For example "near Kimilili market". Please do not give a home address.',
  'request.photo': 'Add a photo',
  'request.photo.hint': 'One photo, up to {size}. JPEG, PNG, WebP or HEIC. Avoid photos that show people’s faces or vehicle number plates.',
  'request.photo.remove': 'Remove photo',
  'request.photo.selected': 'Selected: {name} ({size})',
  'request.photo.resized': 'We made the photo smaller to save data and removed its hidden location details.',
  'request.photo.tooLarge': 'This photo is larger than {size}. Choose a smaller photo.',
  'request.photo.badType': 'This file type is not accepted. Choose a JPEG, PNG, WebP or HEIC photo.',
  'request.contact.legend': 'How should we contact you about this request?',
  'request.contact.hint': 'Contact is optional. If you choose "Do not contact me", we will not store any contact details and you can still track your request with the reference and tracking code.',
  'request.contact.NONE': 'Do not contact me',
  'request.contact.PHONE': 'Phone call',
  'request.contact.SMS': 'SMS',
  'request.contact.EMAIL': 'Email',
  'request.name': 'Your name',
  'request.phone': 'Phone number',
  'request.phone.hint': 'For example 0712 345678',
  'request.email': 'Email address',
  'request.consent': 'I agree that the office may contact me about this request using the details above.',
  'request.privacy.read': 'I have read how my information will be used.',
  'request.privacy.version': 'Notice version {version}',
  'request.submit': 'Send request',
  'request.submitting': 'Sending…',
  'request.draftRestored': 'We restored the issue description you started earlier on this device. Contact details are never saved on the device.',
  'request.draftClear': 'Start again',
  'request.noticeChanged': 'The privacy notice was updated while you were filling in the form. Please read it again below, then send.',
  'request.captchaUnavailable': 'This office requires an extra security check that cannot be shown right now. Please try again later or contact the office directly.',
  'request.error.category': 'Choose the type of issue',
  'request.error.location': 'Choose a constituency, or describe the nearest landmark',
  'request.error.description': 'Describe the issue in at least 20 characters (no more than 4,000)',
  'request.error.landmark': 'Keep the landmark under 300 characters',
  'request.error.name': 'Keep your name under 200 characters',
  'request.error.phone': 'Enter a phone number such as 0712 345678, or choose "Do not contact me"',
  'request.error.email': 'Enter an email address such as name@example.com, or choose "Do not contact me"',
  'request.error.consent': 'Tick the box to let us contact you, or choose "Do not contact me"',
  'request.error.privacy': 'Confirm that you have read how your information will be used',
  'request.error.photo': 'Choose a different photo',

  // Receipt
  'receipt.title': 'Request received',
  'receipt.body': 'Thank you. Your request has been recorded.',
  'receipt.reference': 'Reference',
  'receipt.code': 'Tracking code',
  'receipt.warning': 'Write down or take a screenshot of both now. The tracking code is shown only once and we cannot show it again. You need both to check progress.',
  'receipt.submittedAt': 'Received {date}',
  'receipt.track': 'Track this request',
  'receipt.another': 'Report another issue',

  // Track
  'track.title': 'Track a request',
  'track.intro': 'Enter the reference and the tracking code you received when you made the request.',
  'track.reference': 'Reference',
  'track.reference.hint': 'For example BG-7K3F-9Q2X',
  'track.code': 'Tracking code',
  'track.code.hint': '8 letters and numbers',
  'track.submit': 'Show progress',
  'track.notFound': 'We could not find a request with that reference and tracking code. Check both and try again.',
  'track.stage': 'Current stage',
  'track.category': 'Type of issue',
  'track.location': 'Location',
  'track.submittedAt': 'Received',
  'track.updatedAt': 'Last update',
  'track.updates': 'Updates',
  'track.updates.none': 'There are no updates yet. We will add them here as your request moves forward.',
  'track.referredTo': 'Referred to',
  'track.referred.note': 'These institutions are responsible for this kind of issue. The office follows up with them.',
  'track.privacy': 'Only updates meant for you are shown. Staff notes and other people’s requests are never shown here.',
  'track.another': 'Check another request',
  'track.feedback.title': 'Tell us what you think of the proposed resolution',
  'track.feedback.body': 'This is optional. An officer will read your answer before the request is closed.',
  'track.feedback.legend': 'Your answer',
  'track.feedback.CONFIRM_RESOLVED': 'Yes, the issue is resolved',
  'track.feedback.DISPUTE': 'No, the issue is not resolved',
  'track.feedback.ADDITIONAL_INFORMATION': 'I want to add information',
  'track.feedback.message': 'Message',
  'track.feedback.submit': 'Send feedback',
  'track.feedback.thanks': 'Thank you. Your feedback has been added to the request.',
  'track.feedback.closed': 'Feedback is no longer open for this request.',

  // Stages (public)
  'stage.RECEIVED': 'Received',
  'stage.UNDER_REVIEW': 'Being reviewed',
  'stage.IN_PROGRESS': 'Being worked on',
  'stage.REFERRED': 'Referred to the responsible institution',
  'stage.RESOLUTION_PROPOSED': 'Resolution proposed',
  'stage.CLOSED': 'Closed',

  // Projects
  'projects.title': 'Development projects',
  'projects.intro': 'Projects this office tracks. Each project names the institution legally responsible for it and where the commitment came from.',
  'projects.disabled': 'Project information is not published on this portal.',
  'projects.search': 'Search by name',
  'projects.category': 'Category',
  'projects.stage': 'Stage',
  'projects.area': 'Area',
  'projects.all': 'All',
  'projects.allWards': '{name} (all wards)',
  'projects.apply': 'Show projects',
  'projects.clear': 'Clear filters',
  'projects.count': '{count} projects',
  'projects.empty': 'No published projects match these filters.',
  'projects.responsible': 'Responsible institution',
  'projects.source': 'Source of commitment',
  'projects.verification': 'Completion',
  'projects.updated': 'Last updated {date}',
  'projects.prev': 'Previous',
  'projects.next': 'Next',
  'projects.page': 'Page {page} of {pages}',
  'projects.stage.COMMITMENT': 'Commitment',
  'projects.stage.APPROVED': 'Approved',
  'projects.stage.IMPLEMENTATION': 'Ongoing',
  'projects.stage.REPORTED_COMPLETE': 'Completed (reported)',
  'projects.stage.VERIFIED_COMPLETE': 'Verified completed',
  'projects.stage.CANCELLED': 'Cancelled',
  'projects.legend.title': 'What the stages mean',
  'projects.legend.COMMITMENT': 'A promise or plan. It is not yet an approved, funded project.',
  'projects.legend.APPROVED': 'Approved by the responsible body. Work has not started.',
  'projects.legend.IMPLEMENTATION': 'Work is being procured or is under way.',
  'projects.legend.REPORTED_COMPLETE': 'Someone has reported the work as complete. It has not yet been independently verified.',
  'projects.legend.VERIFIED_COMPLETE': 'Completion has been checked against an inspection report, completion certificate or handover document.',
  'projects.legend.CANCELLED': 'The project will not go ahead.',
  'project.back': 'All projects',
  'project.tracked': 'This office tracks this project. It is the responsibility of {institution}.',
  'project.implementing': 'Implementing agency',
  'project.owner': 'Project owner',
  'project.sourceDetail': 'Details of the commitment',
  'project.description': 'About the project',
  'project.finance': 'Money',
  'project.funding': 'Funding source',
  'project.allocation': 'Approved allocation',
  'project.contract': 'Contract amount',
  'project.expenditure': 'Expenditure reported',
  'project.expenditure.asOf': 'as of {date}',
  'project.expenditure.source': 'Source: {source}',
  'project.schedule': 'Schedule',
  'project.start': 'Start date',
  'project.expected': 'Expected completion',
  'project.actual': 'Actual completion',
  'project.delay': 'Reason for delay',
  'project.milestones': 'Milestones',
  'project.milestone.planned': 'Planned {date}',
  'project.milestone.actual': 'Done {date}',
  'project.evidence': 'Published evidence',
  'project.evidence.captured': 'Dated {date}',
  'project.evidence.open': 'Open file',
  'project.evidence.none': 'No evidence has been published for this project.',
  'project.location': 'Location',
  'project.coordinates': 'Map position: {lat}, {lng}',
  'project.notFound': 'This project is not published, or the link is wrong.',
  'project.photoNote': 'A photograph alone does not prove that a project is complete.',
  'project.notProvided': 'Not published',
} as const;

export type PortalStringKey = keyof typeof en;
export type PortalStrings = Record<PortalStringKey, string>;

/**
 * Kiswahili. Intentionally partial: missing keys fall back to English.
 * Add translations reviewed by a fluent speaker; do not machine-translate
 * the privacy notice or legal wording.
 */
export const sw: Partial<PortalStrings> = {
  'shell.nav.home': 'Mwanzo',
};

const TABLES: Record<PortalLocale, Partial<PortalStrings>> = { en, sw };

export function isPortalLocale(v: unknown): v is PortalLocale {
  return typeof v === 'string' && (PORTAL_LOCALES as readonly string[]).includes(v);
}

/** Translate a key, interpolating `{name}` placeholders. Falls back to English. */
export function translate(locale: PortalLocale, key: PortalStringKey, vars?: Record<string, string | number>): string {
  const raw = TABLES[locale][key] ?? en[key];
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export type Translate = (key: PortalStringKey, vars?: Record<string, string | number>) => string;

export function translator(locale: PortalLocale): Translate {
  return (key, vars) => translate(locale, key, vars);
}

/** Human file size for hints ("8 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
