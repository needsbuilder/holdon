import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RuleFileSchema,
  evaluateCondition,
  inferMethod,
  loadRules,
  matchPatterns,
  referencedLexicons,
  type Condition,
  type Features,
} from '../src/domain/rules.js';
import { extractHost, normalizeText } from '../src/domain/text.js';
import { packagePath } from '../src/paths.js';

const rules = loadRules();
const wordCount = (text: string) => text.trim().split(/\s+/).length;

/** Official publishers a rule may cite: FTC, IRS, SSA and its OIG, FBI/IC3, CFPB, Medicare, and a utility's own newsroom. */
const OFFICIAL_SOURCE_DOMAINS = ['ftc.gov', 'irs.gov', 'ssa.gov', 'ic3.gov', 'fbi.gov', 'consumerfinance.gov', 'medicare.gov', 'duke-energy.com'];

function features(overrides: Partial<Features> & { say?: string } = {}): Features {
  const { say, ...rest } = overrides;
  return { text: normalizeText(say ?? ''), method: 'unknown', channel: 'unknown', claims: [], secrecy_requested: false, ...rest };
}

describe('rules/scam-patterns.json', () => {
  it('parses against the strict schema', () => {
    const raw = JSON.parse(readFileSync(packagePath('rules', 'scam-patterns.json'), 'utf8'));
    expect(() => RuleFileSchema.parse(raw)).not.toThrow();
  });

  it('holds between 8 and 12 patterns with unique ids', () => {
    expect(rules.patterns.length).toBeGreaterThanOrEqual(8);
    expect(rules.patterns.length).toBeLessThanOrEqual(12);
    expect(new Set(rules.patterns.map((p) => p.id)).size).toBe(rules.patterns.length);
  });

  it('only refers to lexicons that exist', () => {
    for (const name of referencedLexicons(rules)) expect(rules.lexicons[name], name).toBeDefined();
  });

  describe.each(rules.patterns.map((pattern) => [pattern.id, pattern] as const))('%s', (_id, pattern) => {
    it('carries official guidance with source_url, verbatim quote and checked date', () => {
      expect(pattern.guidance.length).toBeGreaterThanOrEqual(1);
      for (const source of pattern.guidance) {
        expect(source.source_url).toMatch(/^https:\/\//);
        expect(source.quote.trim().length).toBeGreaterThan(0);
        expect(source.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(source.publisher.length).toBeGreaterThan(1);
      }
    });

    it('keeps every quote under 25 words', () => {
      for (const source of pattern.guidance) expect(wordCount(source.quote), source.quote).toBeLessThan(25);
    });

    it('cites official sources only', () => {
      for (const source of pattern.guidance) {
        const host = extractHost(source.source_url)!;
        expect(OFFICIAL_SOURCE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`)), host).toBe(true);
      }
    });
  });
});

describe('evaluateCondition', () => {
  const gift: Condition = { any: [{ method_in: ['gift_card'] }, { text: 'gift_card' }] };

  it('matches on a structured field and reports the evidence', () => {
    expect(evaluateCondition(gift, features({ method: 'gift_card' }), rules)).toEqual(['payment method: gift_card']);
  });

  it('matches on words from a lexicon', () => {
    expect(evaluateCondition(gift, features({ say: 'buy three Google Play cards' }), rules)).toEqual(['words: "google play cards"']);
  });

  it('returns undefined when nothing matches', () => {
    expect(evaluateCondition(gift, features({ say: 'pay my bill by check', method: 'check' }), rules)).toBeUndefined();
  });

  it('requires every branch of all and supports not', () => {
    const condition: Condition = { all: [{ channel_in: ['phone_call'] }, { not: { flag: 'secrecy_requested' } }] };
    expect(evaluateCondition(condition, features({ channel: 'phone_call' }), rules)).toEqual(['contact channel: phone_call']);
    expect(evaluateCondition(condition, features({ channel: 'phone_call', secrecy_requested: true }), rules)).toBeUndefined();
    expect(evaluateCondition(condition, features({ channel: 'mail' }), rules)).toBeUndefined();
  });

  it('resolves a payee category from the registry or from the words used', () => {
    const condition: Condition = { payee_category_in: ['government'] };
    expect(evaluateCondition(condition, features({ registry_category: 'government' }), rules)).toEqual(['payee category: government']);
    expect(evaluateCondition(condition, features({ say: 'the sheriff called' }), rules)).toEqual(['mentions government: "sheriff"']);
    expect(evaluateCondition(condition, features({ registry_category: 'utility' }), rules)).toBeUndefined();
  });
});

describe('each pattern', () => {
  const ids = (f: Features) => matchPatterns(f, rules).map((signal) => signal.id);

  const cases: Array<{ id: string; hit: Features; miss: Features }> = [
    {
      id: 'gift-card-payment-demand',
      hit: features({ say: 'he wants it in Target gift cards' }),
      miss: features({ say: 'buy a birthday present for my niece', method: 'card' }),
    },
    {
      id: 'government-impersonation-demand',
      hit: features({ say: 'the IRS called about back taxes', registry_category: 'government', channel: 'phone_call' }),
      miss: features({ say: 'pay my quarterly estimated taxes', registry_category: 'government', channel: 'mail' }),
    },
    {
      id: 'keep-it-secret',
      hit: features({ say: "he said don't tell anyone at the bank" }),
      miss: features({ say: 'I told my daughter about it already' }),
    },
    {
      id: 'crypto-atm-payment',
      hit: features({ say: 'put the cash in a bitcoin atm at the gas station' }),
      miss: features({ say: 'pay at the ATM fee free' }),
    },
    {
      id: 'family-emergency-bail',
      hit: features({ say: 'my grandson is in jail and needs bail' }),
      miss: features({ say: 'my grandson has a birthday next week' }),
    },
    {
      id: 'tech-support-remote-access',
      hit: features({ say: 'Microsoft called, found a virus and needs remote access to fix it', channel: 'phone_call' }),
      miss: features({ say: 'buy a new laptop and a TV remote control on the store website', channel: 'website' }),
    },
    {
      id: 'overpayment-refund',
      hit: features({ say: 'they refunded too much and I need to send back the difference' }),
      miss: features({ say: 'I am waiting for my refund' }),
    },
    {
      id: 'prize-lottery-fee',
      hit: features({ say: 'I won the sweepstakes and must pay the taxes first' }),
      miss: features({ say: 'buy a lottery ticket', method: 'card' }),
    },
    {
      id: 'medicare-card-fee',
      hit: features({ say: 'they need a payment for my new Medicare card' }),
      miss: features({ say: 'pay my Medicare premium' }),
    },
    {
      id: 'utility-shutoff-threat',
      hit: features({ say: 'the power company will shut off my lights', channel: 'phone_call' }),
      miss: features({ say: 'a disconnection notice from the power company came with my bill', channel: 'mail' }),
    },
    {
      id: 'move-money-to-protect-it',
      hit: features({ say: 'the bank fraud department said to move my money to a safe account' }),
      miss: features({ say: 'move $200 from checking to savings' }),
    },
    {
      id: 'pressure-to-act-now',
      hit: features({ say: 'I have to pay right now or lose the deal' }),
      miss: features({ say: 'the bill is due at the end of the month' }),
    },
  ];

  it('has an example for every pattern in the file', () => {
    expect(cases.map((c) => c.id).sort()).toEqual(rules.patterns.map((p) => p.id).sort());
  });

  it.each(cases)('$id matches its example and not its counter-example', ({ id, hit, miss }) => {
    expect(ids(hit)).toContain(id);
    expect(ids(miss)).not.toContain(id);
  });

  it('attaches the primary official source to each signal', () => {
    const [signal] = matchPatterns(features({ method: 'gift_card' }), rules);
    expect(signal?.source.url).toBe('https://consumer.ftc.gov/articles/avoiding-and-reporting-gift-card-scams');
    expect(signal?.source.quote).toMatch(/gift card/);
    expect(signal?.source.publisher).toBe('Federal Trade Commission');
  });
});

describe('inferMethod', () => {
  it.each([
    ['he wants iTunes cards', 'gift_card'],
    ['send bitcoin to this wallet address', 'crypto'],
    ['wire it through Western Union', 'wire'],
    ['pay him on Zelle', 'zelle'],
    ['send it with Cash App', 'payment_app'],
    ['mail cash in an envelope', 'cash'],
  ])('reads "%s" as %s', (say, method) => {
    expect(inferMethod(normalizeText(say), rules)).toBe(method);
  });

  it('returns undefined when the words do not say how', () => {
    expect(inferMethod(normalizeText('pay my electric bill'), rules)).toBeUndefined();
  });
});
