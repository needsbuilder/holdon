/**
 * Small, pure text helpers: normalisation for matching, and redaction of
 * anything actionable (phone numbers, links, email addresses) before text
 * that came from a suspicious message is shown to the older adult.
 */

const APOSTROPHES = /['‘’‛′`]/g;

/** Lower-case, drop apostrophes, turn every other non-alphanumeric run into one space, and pad with spaces. */
export function normalizeText(value: string): string {
  const core = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return ` ${core} `;
}

/** Whole-word phrase test against text produced by {@link normalizeText}. */
export function containsPhrase(normalizedText: string, phrase: string): boolean {
  const needle = normalizeText(phrase);
  return needle.trim().length > 0 && normalizedText.includes(needle);
}

/** Name form used for registry and trusted-payee lookups. */
export function normalizeName(value: string): string {
  return normalizeText(value).trim();
}

const KEYPAD: Record<string, string> = {
  a: '2', b: '2', c: '2', d: '3', e: '3', f: '3', g: '4', h: '4', i: '4', j: '5', k: '5', l: '5',
  m: '6', n: '6', o: '6', p: '7', q: '7', r: '7', s: '7', t: '8', u: '8', v: '8', w: '9', x: '9', y: '9', z: '9',
};

/**
 * Reduce a US phone number to its ten national digits so that
 * "1-800-MEDICARE", "(800) 633-4227" and "+1 800.633.4227" compare equal.
 * Returns undefined when the text does not look like a US number.
 */
export function phoneDigits(value: string): string | undefined {
  const mapped = value
    .toLowerCase()
    .replace(/[a-z]/g, (letter) => KEYPAD[letter] ?? '')
    .replace(/\D/g, '');
  let digits = mapped;
  if (digits.length >= 11 && digits.startsWith('1')) digits = digits.slice(1);
  // Vanity numbers such as 1-800-MEDICARE spell more than ten digits; the dial pad ignores the rest.
  if (digits.length > 10 && /[a-z]/i.test(value)) digits = digits.slice(0, 10);
  return digits.length === 10 ? digits : undefined;
}

/** Hostname of a link the user was given, tolerating a missing scheme. Returns undefined if it cannot be read. */
export function extractHost(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const host = new URL(candidate).hostname.toLowerCase().replace(/\.$/, '');
    if (!host.includes('.')) return undefined;
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return undefined;
  }
}

export function hostMatchesDomain(host: string, domain: string): boolean {
  const d = domain.toLowerCase();
  return host === d || host.endsWith(`.${d}`);
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL_WITH_SCHEME = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;
const BARE_DOMAIN =
  /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|gov|edu|info|biz|co|us|io|me|ly|app|xyz|top|site|online|link|click|shop|live|cc|ru|cn|tk|support|help|pay|money|cash)\b(?:\/[^\s<>"')]*)?/gi;
// Ten digits with common separators, with or without a leading 1.
const PHONE_NUMERIC = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-]?)\d{3}[\s.-]?\d{4}\b/g;
// Toll-free vanity numbers such as 1-800-MEDICARE or 1-800-75-CONED.
const PHONE_VANITY =
  /(?:\+?1[\s.-]?)?(?:\(8(?:00|33|44|55|66|77|88)\)\s?|\b8(?:00|33|44|55|66|77|88)[.-])[A-Za-z0-9]{2,8}(?:[.-][A-Za-z0-9]{2,8}){0,2}\b/g;
// Seven-digit local numbers.
const PHONE_LOCAL = /\b\d{3}[\s.-]\d{4}\b/g;

export const REDACTED_LINK = '[link removed]';
export const REDACTED_PHONE = '[phone number removed]';
export const REDACTED_EMAIL = '[email address removed]';

/**
 * Remove phone numbers, links and email addresses from free text.
 *
 * Design principle 2: nothing actionable from a suspicious message is ever
 * repeated on the older adult's surface. Official contact details are added
 * back separately, from the registry only.
 */
export function redactUntrusted(value: string): string {
  return value
    .replace(EMAIL, REDACTED_EMAIL)
    .replace(URL_WITH_SCHEME, REDACTED_LINK)
    .replace(BARE_DOMAIN, REDACTED_LINK)
    .replace(PHONE_NUMERIC, REDACTED_PHONE)
    .replace(PHONE_VANITY, (match) => (match.replace(/[^A-Za-z0-9]/g, '').length >= 10 ? REDACTED_PHONE : match))
    .replace(PHONE_LOCAL, REDACTED_PHONE);
}

/** True when the text still contains something that looks like a phone number, link or email address. */
export function containsActionableContact(value: string): boolean {
  const scrubbed = value.split(REDACTED_LINK).join(' ').split(REDACTED_PHONE).join(' ').split(REDACTED_EMAIL).join(' ');
  return redactUntrusted(scrubbed) !== scrubbed;
}

export function formatUsd(amount: number): string {
  const hasCents = Math.round(amount * 100) % 100 !== 0;
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

export function toCents(amountUsd: number): number {
  return Math.round(amountUsd * 100);
}

export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

const METHOD_LABELS: Record<string, string> = {
  gift_card: 'gift cards',
  crypto: 'cryptocurrency',
  wire: 'a wire transfer',
  zelle: 'Zelle',
  payment_app: 'a payment app',
  cash: 'cash',
  check: 'a check',
  card: 'a credit or debit card',
  bank_transfer: 'a bank account payment',
  unknown: 'an unspecified method',
};

export function methodLabel(method: string): string {
  return METHOD_LABELS[method] ?? method;
}

/** Short names for labels and lists, the same wording the MCP Apps cards use (ui/shared.js). */
const METHOD_NAMES: Record<string, string> = {
  gift_card: 'Gift cards',
  crypto: 'Cryptocurrency',
  wire: 'Wire transfer',
  zelle: 'Zelle',
  payment_app: 'Payment app',
  cash: 'Cash',
  check: 'Check',
  card: 'Credit or debit card',
  bank_transfer: 'Bank account',
  unknown: 'Not specified',
};

export function methodName(method: string): string {
  return METHOD_NAMES[method] ?? 'Not specified';
}

const CHANNEL_NAMES: Record<string, string> = {
  phone_call: 'Phone call',
  text: 'Text message',
  email: 'Email',
  mail: 'Postal mail',
  in_person: 'In person',
  website: 'Website or pop-up',
};

export function channelName(channel: string | undefined): string | undefined {
  return channel ? CHANNEL_NAMES[channel] : undefined;
}

const CHANNEL_LABELS: Record<string, string> = {
  phone_call: 'a phone call',
  text: 'a text message',
  email: 'an email',
  mail: 'postal mail',
  in_person: 'an in-person visit',
  website: 'a website or pop-up',
  unknown: 'an unspecified channel',
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}
