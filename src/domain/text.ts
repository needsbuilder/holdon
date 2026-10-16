/**
 * Small, pure text helpers: normalisation for matching, and redaction of
 * anything actionable (phone numbers, links, email addresses) before text
 * that came from a suspicious message is shown to the older adult.
 */

const APOSTROPHES = /['‘’‛′`]/g;

// Cyrillic, Greek and other letters that look like Latin ones (in either case), so "bitcoіn" with a Cyrillic "і"
// still reads as bitcoin, and "gıft" with a dotless "ı" as gift.
const LOOKALIKES: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', і: 'i', ј: 'j', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ѕ: 's', ԁ: 'd', һ: 'h', ԛ: 'q', ԝ: 'w', ӏ: 'l',
  α: 'a', β: 'b', ε: 'e', ζ: 'z', η: 'h', ι: 'i', κ: 'k', μ: 'm', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
  ı: 'i', ɡ: 'g',
};
const LOOKALIKE_LETTERS = new RegExp(`[${Object.keys(LOOKALIKES).join('')}]`, 'g');
// "U.S.", "D.M.V." and "I.R.S." are the words "us", "dmv" and "irs".
const DOTTED_INITIALS = /(?<![a-z0-9])[a-z](?:\.[a-z])+\.?(?![a-z0-9])/g;
// Short forms read as the word they stand for.
const ABBREVIATIONS: Record<string, string> = { dept: 'department', govt: 'government' };

// Invisible format characters: zero-width spaces and joiners, soft hyphens, direction marks.
const INVISIBLE = /\p{Cf}/gu;
// Separates the two readings of a text that has invisible characters in it. No phrase can match across it.
const READING_BREAK = '|';

/**
 * Text form used for matching words: accents and other marks dropped,
 * letters that only look Latin read as Latin, lower-cased, dotted initials
 * joined, apostrophes dropped, every other non-alphanumeric run turned into one
 * space, and padded with spaces. Only ever compared, never shown.
 *
 * An invisible character may hide inside a word (a zero-width space in "gift")
 * or stand between two words (zero-width spaces for the spaces in "keep it
 * secret"), so a text that has one is read both ways, with them dropped and
 * with them as spaces. Both readings are kept, separated so that no phrase
 * matches across them (see {@link readings}).
 */
export function normalizeText(value: string): string {
  const joined = normalizeReading(value.replace(INVISIBLE, ''));
  if (!/\p{Cf}/u.test(value)) return ` ${joined} `;
  const apart = normalizeReading(value.replace(INVISIBLE, ' '));
  return joined === apart ? ` ${joined} ` : ` ${joined} ${READING_BREAK} ${apart} `;
}

/** The readings in a text produced by {@link normalizeText}, each padded with spaces. Usually just one. */
export function readings(normalizedText: string): string[] {
  return normalizedText.split(READING_BREAK).map((reading) => ` ${reading.trim()} `);
}

function normalizeReading(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\p{M}\p{Cf}]/gu, '')
    .toLowerCase()
    .replace(LOOKALIKE_LETTERS, (letter) => LOOKALIKES[letter]!)
    .replace(DOTTED_INITIALS, (initials) => initials.replace(/\./g, ''))
    .replace(APOSTROPHES, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => ABBREVIATIONS[word] ?? word)
    .join(' ');
}

/** Whole-word phrase test against text produced by {@link normalizeText}. */
export function containsPhrase(normalizedText: string, phrase: string): boolean {
  const needle = normalizeText(phrase);
  return needle.trim().length > 0 && normalizedText.includes(needle);
}

/**
 * Name form used for trusted-payee lookups: letters and digits in any script,
 * lower-cased, with every other run turned into one space. For names in plain
 * Latin letters it gives the same key as earlier versions did. Unlike
 * {@link normalizeText} it keeps accents and never reads one letter as
 * another, so a look-alike name never shares a vouched-for name's key.
 *
 * Combining marks are kept with their letter, so names in scripts that write
 * vowels as marks stay distinct. A name with no letter or digit at all comes
 * back empty: it names nobody and must never match a trusted payee.
 */
export function normalizeName(value: string): string {
  const name = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
  return /[\p{L}\p{N}]/u.test(name) ? name : '';
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

/**
 * The website name inside `text` that stands for the page at `url`, if the
 * text already names it: "irs.gov" in "...publishes on irs.gov." for a page on
 * www.irs.gov, or "duke-energy.com" for a page on news.duke-energy.com.
 *
 * Lets a view turn that mention into the source link instead of printing the
 * website a second time after the sentence. Pure; changes no wording.
 */
export function hostMention(text: string, url: string): string | undefined {
  const host = extractHost(url);
  if (!host) return undefined;
  const labels = host.split('.');
  // The full host first, then its parent domains, never a bare top-level domain.
  for (let start = 0; start <= labels.length - 2; start += 1) {
    const candidate = labels.slice(start).join('.');
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(^|[^a-z0-9.-])(${escaped})(?![a-z0-9-]|\\.[a-z0-9])`, 'i').exec(text);
    if (match) return match[2];
  }
  return undefined;
}

export function hostMatchesDomain(host: string, domain: string): boolean {
  const d = domain.toLowerCase();
  return host === d || host.endsWith(`.${d}`);
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL_WITH_SCHEME = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;
// Real top-level domains: common generic ones and every country code. Words that end a name, such as "Smith" in
// "Dr.Smith" or "Crew" in "J.Crew", are not top-level domains, so those names are left alone.
const TOP_LEVEL_DOMAINS = [
  'com', 'net', 'org', 'gov', 'edu', 'mil', 'int', 'info', 'biz', 'name', 'pro', 'mobi', 'asia', 'tel', 'travel', 'jobs', 'aero', 'coop', 'museum',
  'app', 'dev', 'page', 'xyz', 'top', 'site', 'online', 'website', 'store', 'shop', 'tech', 'space', 'live', 'life', 'world', 'today', 'news',
  'email', 'link', 'click', 'help', 'support', 'services', 'solutions', 'agency', 'company', 'business', 'center', 'group', 'network', 'systems',
  'zone', 'cloud', 'digital', 'global', 'media', 'finance', 'financial', 'money', 'cash', 'pay', 'credit', 'loan', 'loans', 'tax', 'claims',
  'insurance', 'legal', 'law', 'lawyer', 'attorney', 'exchange', 'trade', 'market', 'markets', 'delivery', 'express', 'repair', 'plumbing',
  'roofing', 'contractors', 'construction', 'builders', 'homes', 'realty', 'energy', 'solar', 'health', 'clinic', 'care', 'charity', 'foundation',
  'events', 'tickets', 'tours', 'deals', 'discount', 'sale', 'coupons', 'review', 'reviews', 'bid', 'win', 'vip', 'club', 'fun', 'buzz', 'guru',
  'icu', 'cyou', 'monster', 'quest', 'sbs', 'cfd', 'bond', 'lol', 'zip', 'mov', 'llc', 'inc', 'ltd', 'gmbh', 'secure', 'host', 'hosting',
  'stream', 'download',
  ...('ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cc cd cf cg ch ci ck cl cm cn ' +
    'co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk ' +
    'hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg ' +
    'mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ' +
    'ro rs ru rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy ' +
    'uz va vc ve vg vi vn vu wf ws ye yt za zm zw').split(' '),
];
// Endings that never end an ordinary name, so they count in any case, as in "Greenleaf.Store" or "IRS-Help.AI".
const ANY_CASE_ENDINGS = [
  'com', 'net', 'org', 'gov', 'edu', 'info', 'biz', 'app', 'xyz', 'top', 'site', 'online', 'website', 'store', 'shop', 'live', 'help', 'support',
  'services', 'finance', 'money', 'pay', 'link', 'click', 'ai', 'io', 'icu', 'cyou', 'sbs', 'cfd', 'cc', 'ru', 'cn', 'tk',
];
// Country codes that are also short English words ("it.Is", "Acct.No"). Like any word, they count as an ending only
// in lower case with a path after them, as in "go.to/refund", or after "www.".
const WORD_ENDINGS = ['is', 'it', 'in', 'no', 'so', 'to', 'me', 'at', 'be', 'do', 'go', 'us', 'my', 'by', 'as', 'an', 'or', 'of', 'on', 'am', 'hi'];
// Every other ending can also end a name ("Smith Bros.Roofing"), so it counts in lower case or ALL CAPS, or with a path.
const OTHER_ENDINGS = TOP_LEVEL_DOMAINS.filter((ending) => !ANY_CASE_ENDINGS.includes(ending) && !WORD_ENDINGS.includes(ending));
const HOST_LABELS = '\\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+';
const LINK_PATH = '\\/[^\\s<>"\')]*';
const DOMAIN_ANY_CASE = new RegExp(`${HOST_LABELS}(?:${ANY_CASE_ENDINGS.join('|')})\\b(?:${LINK_PATH})?`, 'gi');
const DOMAIN_CAPITALS = new RegExp(`${HOST_LABELS}(?:${OTHER_ENDINGS.map((ending) => ending.toUpperCase()).join('|')})\\b(?:${LINK_PATH})?`, 'g');
const DOMAIN_WITH_PATH = new RegExp(`${HOST_LABELS}(?:${OTHER_ENDINGS.join('|')})${LINK_PATH}`, 'gi');
// Any ending in lower case, as links are written, such as greenleaf.example or greenleaf.roofing; a word ending
// only with a path after it. "Dr.Smith" or "J.Crew" in a name is left alone.
const BARE_HOST = new RegExp(`${HOST_LABELS}(?!(?:${WORD_ENDINGS.join('|')})\\b(?!\\/))[a-z]{2,24}\\b(?:${LINK_PATH})?`, 'g');
// A number written with its country code, such as +44 20 7946 0958 or +44 (0)20 7946 0958. Digits may be separated
// by any dash: hyphen, non-breaking hyphen, figure dash, en and em dash, or minus sign.
const PHONE_INTERNATIONAL = /\+\d{1,3}(?:[\s.()\-\u2010-\u2015\u2212]{0,2}\d){7,13}\b/g;
// The same dialled with 011 or 00 before the country code, such as 011 44 20 7946 0958.
const PHONE_EXIT_CODE = /\b(?:011|00)[\s.\-\u2010-\u2015\u2212]?\d{1,3}(?:[\s.()\-\u2010-\u2015\u2212]{0,2}\d){6,13}\b/g;
// Ten digits with common separators, with or without a leading 1.
const PHONE_NUMERIC = /(?:\+?1[\s.\-\u2010-\u2015\u2212]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.\-\u2010-\u2015\u2212]?)\d{3}[\s.\-\u2010-\u2015\u2212]?\d{4}\b/g;
// Toll-free vanity numbers such as 1-800-MEDICARE or 1-800-75-CONED.
const PHONE_VANITY =
  /(?:\+?1[\s.\-\u2010-\u2015\u2212]?)?(?:\(8(?:00|33|44|55|66|77|88)\)\s?|\b8(?:00|33|44|55|66|77|88)[.\-\u2010-\u2015\u2212])[A-Za-z0-9]{2,8}(?:[.\-\u2010-\u2015\u2212][A-Za-z0-9]{2,8}){0,2}\b/g;
// Seven-digit local numbers.
const PHONE_LOCAL = /\b\d{3}[\s.\-\u2010-\u2015\u2212]\d{4}\b/g;

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
  // Invisible characters can hide inside a number or link ("212-55\u200b5-0142"), and are never needed on screen.
  return value
    .replace(INVISIBLE, '')
    .replace(EMAIL, REDACTED_EMAIL)
    .replace(URL_WITH_SCHEME, REDACTED_LINK)
    .replace(DOMAIN_ANY_CASE, REDACTED_LINK)
    .replace(DOMAIN_CAPITALS, REDACTED_LINK)
    .replace(DOMAIN_WITH_PATH, REDACTED_LINK)
    .replace(BARE_HOST, REDACTED_LINK)
    .replace(PHONE_INTERNATIONAL, REDACTED_PHONE)
    .replace(PHONE_EXIT_CODE, REDACTED_PHONE)
    .replace(PHONE_NUMERIC, REDACTED_PHONE)
    .replace(PHONE_VANITY, (match) => (match.replace(/[^A-Za-z0-9]/g, '').length >= 10 ? REDACTED_PHONE : match))
    .replace(PHONE_LOCAL, REDACTED_PHONE);
}

/** True when the text still contains something that looks like a phone number, link or email address. */
export function containsActionableContact(value: string): boolean {
  const scrubbed = value.replace(INVISIBLE, '').split(REDACTED_LINK).join(' ').split(REDACTED_PHONE).join(' ').split(REDACTED_EMAIL).join(' ');
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
