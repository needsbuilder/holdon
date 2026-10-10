import { describe, expect, it } from 'vitest';
import {
  containsActionableContact,
  containsPhrase,
  extractHost,
  formatUsd,
  hostMatchesDomain,
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
