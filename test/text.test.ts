import { describe, expect, it } from 'vitest';
import {
  containsActionableContact,
  containsPhrase,
  extractHost,
  formatUsd,
  hostMatchesDomain,
  hostMention,
  normalizeText,
  phoneDigits,
  redactUntrusted,
} from '../src/domain/text.js';

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
});

describe('formatUsd', () => {
  it('shows cents only when there are some', () => {
    expect(formatUsd(2000)).toBe('$2,000');
    expect(formatUsd(182.4)).toBe('$182.40');
  });
});
