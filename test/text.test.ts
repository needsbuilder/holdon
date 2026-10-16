import { describe, expect, it } from 'vitest';
import { loadRegistry } from '../src/domain/registry.js';
import {
  containsActionableContact,
  containsPhrase,
  extractHost,
  formatUsd,
  hostMatchesDomain,
  hostMention,
  normalizeName,
  normalizeText,
  phoneDigits,
  readings,
  redactUntrusted,
} from '../src/domain/text.js';

// Built from code points so that no invisible character or look-alike dash hides in this file.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const ZERO_WIDTH_JOINER = String.fromCharCode(0x200d);
const SOFT_HYPHEN = String.fromCharCode(0xad);

describe('phoneDigits', () => {
  it('treats different spellings of the same US number as equal', () => {
    const forms = ['1-800-633-4227', '(800) 633-4227', '+1 800.633.4227', '800 633 4227', '1-800-MEDICARE'];
    expect(new Set(forms.map(phoneDigits))).toEqual(new Set(['8006334227']));
  });

  it('returns undefined for text that is not a US phone number', () => {
    expect(phoneDigits('call me')).toBeUndefined();
    expect(phoneDigits('12345')).toBeUndefined();
  });
});

describe('extractHost', () => {
  it('reads the host with or without a scheme and drops www', () => {
    expect(extractHost('https://www.irs.gov/payments')).toBe('irs.gov');
    expect(extractHost('IRS.gov/payments')).toBe('irs.gov');
    expect(extractHost('sa.www4.irs.gov')).toBe('sa.www4.irs.gov');
  });

  it('returns undefined for something that is not a link', () => {
    expect(extractHost('not a link')).toBeUndefined();
    expect(extractHost('')).toBeUndefined();
  });

  it('matches subdomains but not lookalikes', () => {
    expect(hostMatchesDomain('sa.www4.irs.gov', 'irs.gov')).toBe(true);
    expect(hostMatchesDomain('irs.gov.example.com', 'irs.gov')).toBe(false);
    expect(hostMatchesDomain('notirs.gov', 'irs.gov')).toBe(false);
  });
});

describe('hostMention', () => {
  it("finds the source's website when the sentence already names it", () => {
    expect(hostMention("The link that was given is not on Internal Revenue Service's official site, irs.gov.", 'https://www.irs.gov/help/tax-scams/recognize-tax-scams-and-fraud')).toBe('irs.gov');
    expect(hostMention('one of the numbers National Grid publishes on nationalgridus.com. Caller ID can also be faked.', 'https://www.nationalgridus.com/Our-Company/Scam-Alert')).toBe('nationalgridus.com');
  });

  it('accepts the parent domain of the page, as written in the sentence', () => {
    expect(hostMention("not on Duke Energy's official site, duke-energy.com.", 'https://news.duke-energy.com/releases/x')).toBe('duke-energy.com');
    expect(hostMention('official site, usps.com or uspis.gov.', 'https://www.uspis.gov/news/scam-article/x')).toBe('uspis.gov');
    expect(hostMention('See IRS.gov for details', 'https://www.irs.gov/payments')).toBe('IRS.gov');
  });

  it('finds nothing when the website is not named, or only looks alike', () => {
    expect(hostMention('Asked to pay with gift cards or a prepaid card', 'https://consumer.ftc.gov/articles/avoiding-and-reporting-gift-card-scams')).toBeUndefined();
    expect(hostMention('Go to irs.gov.evil.example now', 'https://www.irs.gov/payments')).toBeUndefined();
    expect(hostMention('Visit notirs.gov today', 'https://www.irs.gov/payments')).toBeUndefined();
    expect(hostMention('anything', 'not a url')).toBeUndefined();
  });
});

describe('normalizeText and containsPhrase', () => {
  it('matches whole words regardless of case, punctuation and apostrophes', () => {
    const text = normalizeText("He said: DON'T tell anyone, and buy Gift-Cards!");
    expect(containsPhrase(text, 'dont tell')).toBe(true);
    expect(containsPhrase(text, 'gift cards')).toBe(true);
    expect(containsPhrase(text, 'gift card')).toBe(false);
  });

  it('does not match inside longer words', () => {
    expect(containsPhrase(normalizeText('my first payment'), 'irs')).toBe(false);
    expect(containsPhrase(normalizeText('the IRS called'), 'irs')).toBe(true);
  });

  it('reads dotted initials, "Dept." and "&" as the words they stand for', () => {
    expect(normalizeText('Pay the U.S. Treasury')).toBe(' pay the us treasury ');
    expect(normalizeText('D.M.V. renewal')).toBe(' dmv renewal ');
    expect(normalizeText('the I.R.S')).toBe(' the irs ');
    expect(normalizeText('Dept. of Motor Vehicles')).toBe(' department of motor vehicles ');
    expect(normalizeText("Gov't office")).toBe(' government office ');
    expect(normalizeText('PSE&G')).toBe(' pse and g ');
    // A link or an e-mail address is not a run of initials.
    expect(normalizeText('x.com and j.doe@mail.com')).toBe(' x com and j doe mail com ');
  });

  it('drops accents and reads look-alike Cyrillic and Greek letters as Latin', () => {
    expect(normalizeText('gíft cárds')).toBe(' gift cards ');
    expect(normalizeText('bitcoіn')).toBe(' bitcoin ');
    expect(normalizeText('ВІТСОІN')).toBe(' bitcoin ');
    expect(normalizeText('Ｇｉｆｔ Ｃａｒｄｓ')).toBe(' gift cards ');
  });

  it('reads a dotless ı, a Latin script ɡ and a Cyrillic ӏ as i, g and l', () => {
    expect(normalizeText('gıft cards')).toBe(' gift cards ');
    expect(normalizeText('ɡift cards')).toBe(' gift cards ');
    expect(normalizeText('Google Pӏay')).toBe(' google play ');
    expect(normalizeText('GOOGLE PӀAY')).toBe(' google play ');
  });

  it('reads invisible characters inside a word as dropped: zero-width space, ZWNJ, ZWJ and soft hyphen', () => {
    for (const hidden of ['​', '‌', '‍', '­', '⁠', '﻿']) {
      expect(normalizeText(`gi${hidden}ft ca${hidden}rds`), JSON.stringify(hidden)).toBe(' gift cards | gi ft ca rds ');
      expect(containsPhrase(normalizeText(`gi${hidden}ft ca${hidden}rds`), 'gift cards'), JSON.stringify(hidden)).toBe(true);
    }
  });

  it('reads invisible characters between words as spaces too, keeping both readings', () => {
    const say = `keep${ZERO_WIDTH_SPACE}it${ZERO_WIDTH_SPACE}secret`;
    expect(normalizeText(say)).toBe(' keepitsecret | keep it secret ');
    expect(readings(normalizeText(say))).toEqual([' keepitsecret ', ' keep it secret ']);
    expect(readings(normalizeText('keep it secret'))).toEqual([' keep it secret ']);
    expect(normalizeText(`gift${ZERO_WIDTH_SPACE} cards`)).toBe(' gift cards ');
  });

  it.each([
    ['gift cards', 'between words', `Target${ZERO_WIDTH_SPACE}gift${ZERO_WIDTH_SPACE}cards`],
    ['gift cards', 'between words', `gift${ZERO_WIDTH_JOINER}cards`],
    ['gift cards', 'inside a word', `gi${ZERO_WIDTH_SPACE}ft ca${SOFT_HYPHEN}rds`],
    ['bitcoin', 'between words', `send${ZERO_WIDTH_SPACE}bitcoin`],
    ['bitcoin', 'inside a word', `send bit${ZERO_WIDTH_SPACE}coin`],
    ['keep it secret', 'between words', `keep${ZERO_WIDTH_JOINER}it${ZERO_WIDTH_JOINER}secret`],
    ['keep it secret', 'inside a word', `keep it se${SOFT_HYPHEN}cret`],
  ])('finds "%s" with invisible characters %s', (phrase, _where, say) => {
    expect(containsPhrase(normalizeText(say), phrase)).toBe(true);
  });

  it('never matches a phrase across the two readings', () => {
    // The readings are "cards gift" and "cards gi ft"; read one after the other they would say "gift cards".
    expect(containsPhrase(normalizeText(`cards gi${ZERO_WIDTH_SPACE}ft`), 'gift cards')).toBe(false);
  });
});

describe('normalizeName', () => {
  it('keeps letters and digits in any script, so different names stay different', () => {
    const names = ['김철수', '이영희', '国税局', 'Иван', 'José', 'Jose', 'राम', 'रीम'];
    const keys = names.map(normalizeName);
    expect(keys.every((key) => key.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(names.length);
    expect(normalizeName('  ИВАН  Петров ')).toBe('иван петров');
    expect(normalizeName('Ｇｒｅｅｎｌｅａｆ　Ｒｏｏｆｉｎｇ')).toBe('greenleaf roofing');
  });

  it('gives the same key as before for names in plain Latin letters, including every registry name', () => {
    // The key earlier versions stored: Latin letters and digits only. (normalizeText now joins "I.R.S." into "irs" for matching words; keys stay as they were.)
    const earlierKey = (value: string) =>
      value.normalize('NFKC').toLowerCase().replace(/['‘’‛′`]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
    const registryNames = loadRegistry().payees.flatMap((payee) => [payee.name, ...payee.aliases]);
    for (const name of [...registryNames, 'Greenleaf Roofing', "O'Brien & Sons", 'Dr. Smith-Jones 2nd', 'J.R. Plumbing']) {
      expect(normalizeName(name), name).toBe(earlierKey(name));
    }
  });

  it('gives nothing to match on for a name with no letter or digit', () => {
    expect(normalizeName('???')).toBe('');
    expect(normalizeName('📞 — ✉')).toBe('');
    expect(normalizeName('́́')).toBe('');
  });
});

describe('redactUntrusted', () => {
  it('removes phone numbers, links and email addresses', () => {
    const text = 'Call 1-888-555-0142 or (888) 555 0142, visit http://irs-pay.example.com/now or usps-redelivery.com/pay, or write to agent@fake-irs.com.';
    const redacted = redactUntrusted(text);
    expect(redacted).not.toMatch(/555/);
    expect(redacted).not.toMatch(/example\.com|usps-redelivery|fake-irs/);
    expect(redacted).toContain('[phone number removed]');
    expect(redacted).toContain('[link removed]');
    expect(redacted).toContain('[email address removed]');
    expect(containsActionableContact(redacted)).toBe(false);
  });

  it('leaves ordinary text and amounts alone', () => {
    const text = 'I owe $2,000 for 2025 and must pay by 5 pm today.';
    expect(redactUntrusted(text)).toBe(text);
    expect(containsActionableContact(text)).toBe(false);
  });

  it('removes vanity numbers', () => {
    expect(redactUntrusted('call 1-800-FAKE-IRS now')).not.toMatch(/FAKE/);
  });

  it('removes links whatever their ending', () => {
    for (const link of ['greenleaf.store', 'pay-now.services', 'Greenleaf.roofing/deposit', 'irs-help.ai', 'refunds.agency']) {
      const redacted = redactUntrusted(`Bob Plumbing ${link}`);
      expect(redacted, link).toBe('Bob Plumbing [link removed]');
      expect(containsActionableContact(`Bob Plumbing ${link}`), link).toBe(true);
    }
  });

  it('leaves names with a dot in them alone', () => {
    for (const name of ['Dr.Smith Dental', 'J.Crew', 'St.Louis Bakery', 'Smith Jr. Roofing', 'Pay by 5 p.m. today', 'Bill for $182.40', 'DR.SMITH DENTAL', 'Mt.Vernon Feed']) {
      expect(redactUntrusted(name), name).toBe(name);
    }
  });

  it('removes links with a capitalised ending, as a real top-level domain', () => {
    for (const link of ['Greenleaf.Store', 'GREENLEAF.STORE', 'Pay-Now.Services', 'IRS-Help.AI/refund', 'REFUNDS.AGENCY', 'Refunds.Agency/claim', 'Greenleaf.COM']) {
      expect(redactUntrusted(`Bob Plumbing ${link}`), link).toBe('Bob Plumbing [link removed]');
      expect(containsActionableContact(`Bob Plumbing ${link}`), link).toBe(true);
    }
  });

  it('leaves a name alone when the word after the dot could end a name, or is a short English word', () => {
    for (const name of ['Smith Bros.Roofing', 'Acct.No 4417', 'I paid it.Is that ok?', 'I paid it.is that ok?', 'Dr.Smith', 'J.Crew', 'St.Louis', 'U.S.Bank', 'ACCT.NO 4417']) {
      expect(redactUntrusted(name), name).toBe(name);
      expect(containsActionableContact(name), name).toBe(false);
    }
  });

  it('still removes those endings written the way links are: lower case, ALL CAPS, or with a path', () => {
    for (const link of ['smith-bros.roofing', 'SMITH-BROS.ROOFING', 'Smith-Bros.Roofing/deposit', 'go.to/refund', 'irs-help.us/pay', 'www.irs-help.us']) {
      expect(redactUntrusted(`Bob Plumbing ${link}`), link).toBe('Bob Plumbing [link removed]');
      expect(containsActionableContact(`Bob Plumbing ${link}`), link).toBe(true);
    }
  });

  it('removes phone numbers written with any dash, with invisible characters inside, or with 011 or 00 before the country code', () => {
    const dashes = [0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212].map((code) => String.fromCharCode(code));
    const enDash = String.fromCharCode(0x2013);
    const phones = [
      ...dashes.map((dash) => `212${dash}555${dash}0142`),
      `(212) 555${enDash}0142`,
      `555${enDash}0142`,
      `1${dashes[1]}800${dashes[1]}FAKE${dashes[1]}IRS`,
      `+44 20${enDash}7946${enDash}0958`,
      `212-55${ZERO_WIDTH_SPACE}5-0142`,
      `2${SOFT_HYPHEN}1${SOFT_HYPHEN}2 555 0142`,
      '011 44 20 7946 0958',
      '011-52-55-1234-5678',
      '0044 20 7946 0958',
      '00 44 20 7946 0958',
      `00${enDash}44${enDash}20${enDash}7946${enDash}0958`,
    ];
    for (const phone of phones) {
      expect(redactUntrusted(`Call ${phone} now`), JSON.stringify(phone)).toBe('Call [phone number removed] now');
      expect(containsActionableContact(`Call ${phone} now`), JSON.stringify(phone)).toBe(true);
    }
    for (const text of ['Holtsville, NY 00501', 'Invoice 00123 for $1,000,000', `Smith${enDash}Jones Roofing, 2024${enDash}2025`, 'Order 0011 shipped']) {
      expect(redactUntrusted(text), text).toBe(text);
    }
    // An invisible character alone is nothing to remove.
    expect(containsActionableContact(`Greenleaf${ZERO_WIDTH_SPACE} Roofing`)).toBe(false);
  });

  it('removes international phone numbers', () => {
    for (const phone of ['+44 20 7946 0958', '+44 (0)20 7946 0958', '+91 98765 43210', '+234-803-123-4567', '+61.2.9876.5432']) {
      expect(redactUntrusted(`Call ${phone} now`), phone).toBe('Call [phone number removed] now');
      expect(containsActionableContact(`Call ${phone} now`), phone).toBe(true);
    }
    for (const text of ['Up +5 since Monday', 'Pay $1,500 + $25 fee', 'Order +12345']) {
      expect(redactUntrusted(text), text).toBe(text);
    }
  });
});

describe('formatUsd', () => {
  it('shows cents only when there are some', () => {
    expect(formatUsd(2000)).toBe('$2,000');
    expect(formatUsd(182.4)).toBe('$182.40');
  });
});
