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
// Built from code points so that no invisible character hides in this file.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const SOFT_HYPHEN = String.fromCharCode(0xad);
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

  it('lets a present excuse a gift card mention, but never for a government agency or utility', () => {
    const say = normalizeText('a gift card as a thank you gift');
    expect(inferMethod(say, rules)).toBeUndefined();
    expect(inferMethod(say, rules, true)).toBe('gift_card');
  });
});

describe('gift card and cryptocurrency words', () => {
  const ids = (say: string) => matchPatterns(features({ say }), rules).map((signal) => signal.id);

  it.each([
    ['he wants $500 in Google Play', 'gift_card'],
    ['load it onto OneVanilla cards', 'gift_card'],
    ['buy a prepaid Visa at the pharmacy', 'gift_card'],
    ['pay with a prepaid card', 'gift_card'],
    ['bring two Target gift cards', 'gift_card'],
    ['send him eGift cards', 'gift_card'],
    ['pay it in Litecoin', 'crypto'],
    ['send USDC to this account', 'crypto'],
    ['buy Dogecoin and send it', 'crypto'],
    ['pay in digital currency', 'crypto'],
    ['open a Coinbase account and send it', 'crypto'],
    ['put the cash in the crypto machine at the gas station', 'crypto'],
  ])('reads "%s" as %s, and the matching pattern stops it', (say, method) => {
    expect(inferMethod(normalizeText(say), rules)).toBe(method);
    expect(ids(say)).toContain(method === 'gift_card' ? 'gift-card-payment-demand' : 'crypto-atm-payment');
  });

  it.each([
    'pay my Visa credit card bill',
    'buy groceries at Target with my debit card',
    'pay the Google Fi phone bill',
    'renew the digital edition of the newspaper',
    'pay the plumber for the new water heater',
    'top up my prepaid phone plan',
    'take the coins to the bank',
  ])('leaves "%s" alone', (say) => {
    expect(inferMethod(normalizeText(say), rules)).toBeUndefined();
    expect(ids(say)).toEqual([]);
  });

  it.each([
    ['the roofer wants the deposit sent in bit coin', 'crypto'],
    ['he will only take stable coins', 'crypto'],
    ['send it in ETH to his Kraken account', 'crypto'],
    ['pay through CoinFlip at the store', 'crypto'],
    ['he wants it in gíft cards', 'gift_card'],
    ['he wants it in GIFT CARDS', 'gift_card'],
    ['send it in bitcoіn', 'crypto'],
    ['pay with ВІТСОІN', 'crypto'],
    ['he wants $300 in Google Play codes', 'gift_card'],
    ['he wants it in gıft cards', 'gift_card'],
    ['he wants it in ɡift cards', 'gift_card'],
    ['read him the Google Pӏay card', 'gift_card'],
    ['he wants it in gi​ft cards', 'gift_card'],
    ['he wants it in gi‌ft cards', 'gift_card'],
    ['he wants it in gi‍ft cards', 'gift_card'],
    ['he wants it in gi­ft cards', 'gift_card'],
    ['pay with Google Play', 'gift_card'],
    ['he wants $500 of Google Play', 'gift_card'],
    ['read him the Google Play numbers', 'gift_card'],
    ['read him the Google Play card numbers', 'gift_card'],
    ['buy ETH and send it to him', 'crypto'],
    ['pay me in ether', 'crypto'],
    ['send ETH to this address', 'crypto'],
    ['put it in his ETH wallet', 'crypto'],
    ['load his ether wallet', 'crypto'],
  ])('reads "%s" as %s, whatever spelling, accents or look-alike letters are used', (say, method) => {
    expect(inferMethod(normalizeText(say), rules)).toBe(method);
    expect(ids(say)).toContain(method === 'gift_card' ? 'gift-card-payment-demand' : 'crypto-atm-payment');
  });

  it.each([
    ['the caller said to pay with Google Play', 'gift_card'],
    ['pay him with Google Play', 'gift_card'],
    ['pay them with Google Play', 'gift_card'],
    ['I already paid with Google Play once', 'gift_card'],
    ['he wants $500 worth of Google Play', 'gift_card'],
    ['he wants $1,500 of Google Play', 'gift_card'],
    ['he wants 500 dollars of google play', 'gift_card'],
    ['pay the man with ETH', 'crypto'],
    ['pay the man with ether', 'crypto'],
    ['pay using ETH', 'crypto'],
    ['send ether to this address', 'crypto'],
    ['buy ether at the kiosk', 'crypto'],
    ['transfer ETH to his account', 'crypto'],
    ['deposit ETH into the account he gave me', 'crypto'],
    ['he wants 0.5 ETH', 'crypto'],
    ['he wants 2 ETH by tonight', 'crypto'],
  ])('reads "%s" as %s: Google Play and ETH as a way to pay, or after an amount', (say, method) => {
    expect(inferMethod(normalizeText(say), rules)).toBe(method);
    expect(ids(say)).toContain(method === 'gift_card' ? 'gift-card-payment-demand' : 'crypto-atm-payment');
  });

  it.each([
    'Renew my Audible subscription with Google Play',
    'Buy an app with Google Play for my crossword puzzles',
    'My YouTube subscription billed through Google Play',
    'Pay for the movie I rented on Google Play with my card',
  ])('leaves "%s" alone: buying something from Google Play is not paying someone with it', (say) => {
    expect(inferMethod(normalizeText(say), rules)).toBeUndefined();
    expect(ids(say)).toEqual([]);
  });

  it.each([
    ['gift cards', 'between words', `Pay him in Target${ZERO_WIDTH_SPACE}gift${ZERO_WIDTH_SPACE}cards`, 'gift_card', 'gift-card-payment-demand'],
    ['gift cards', 'inside a word', `Pay him in gi${ZERO_WIDTH_SPACE}ft ca${SOFT_HYPHEN}rds`, 'gift_card', 'gift-card-payment-demand'],
    ['bitcoin', 'between words', `He wants me to send${ZERO_WIDTH_SPACE}bitcoin`, 'crypto', 'crypto-atm-payment'],
    ['bitcoin', 'inside a word', `He wants me to send bit${ZERO_WIDTH_SPACE}coin`, 'crypto', 'crypto-atm-payment'],
    ['keep it secret', 'between words', `He asked me to keep${ZERO_WIDTH_SPACE}it${ZERO_WIDTH_SPACE}secret`, undefined, 'keep-it-secret'],
    ['keep it secret', 'inside a word', `He asked me to keep it se${SOFT_HYPHEN}cret`, undefined, 'keep-it-secret'],
  ])('reads %s with invisible characters %s', (_words, _where, say, method, id) => {
    expect(inferMethod(normalizeText(say), rules)).toBe(method);
    expect(ids(say)).toContain(id);
  });

  it.each(['Donation to ETH Zurich alumni fund', 'Pay the dentist bill for the ether used'])(
    'leaves "%s" alone: "eth" and "ether" count only in payment-shaped wording',
    (say) => {
      expect(inferMethod(normalizeText(say), rules)).toBeUndefined();
      expect(ids(say)).toEqual([]);
    },
  );

  it.each([
    'Renew my Google Play subscription',
    'Pay for the Google Play Pass family plan',
    'Fix the coin machine at the laundromat I own',
    'Take my coin jar to the coin machine at the grocery store',
    'Renew the digital currency newsletter subscription',
    'Pay the virtual currency course fee at the community college',
  ])('leaves "%s" alone: a brand or a machine is not a payment method', (say) => {
    expect(inferMethod(normalizeText(say), rules)).toBeUndefined();
    expect(ids(say)).toEqual([]);
  });
});

describe('payee_is', () => {
  const condition: Condition = { payee_is: ['government', 'utility'] };
  const payee = (name: string, say = '') => features({ say: `${say} ${name}`, payee_name: normalizeText(name) });

  it('reads the payee name only, when there is one', () => {
    expect(evaluateCondition(condition, payee('County Sheriff'), rules)).toEqual(['payee named as government: "sheriff"']);
    expect(evaluateCondition(condition, payee('Amazon', 'a gift card for my grandson the police officer'), rules)).toBeUndefined();
    expect(evaluateCondition(condition, features({ say: 'the police officer wants gift cards' }), rules)).toEqual(['payee named as government: "police officer"']);
  });

  it('counts the registry category, but not the post office', () => {
    expect(evaluateCondition(condition, { ...payee('Con Edison'), registry_category: 'utility' }, rules)).toEqual(['payee category: utility']);
    expect(evaluateCondition(condition, { ...payee('USPS'), registry_category: 'postal' }, rules)).toBeUndefined();
  });

  it('reads "City of" at the start of the name and a utility name as the whole name', () => {
    expect(evaluateCondition(condition, payee('City of Springfield'), rules)).toEqual(['payee named as government: "city of"']);
    expect(evaluateCondition(condition, payee('Georgia Power Corp.'), rules)).toEqual(['payee named as utility: "georgia power"']);
    expect(evaluateCondition(condition, payee('Georgia Power Washing'), rules)).toBeUndefined();
    expect(evaluateCondition(condition, payee('City of Hope Thrift', 'tickets in the city of light'), rules)).toEqual(['payee named as government: "city of"']);
    expect(evaluateCondition(condition, payee('Car Show', 'tickets to the city of Industry car show'), rules)).toBeUndefined();
  });

  it('is not read by the scam patterns that use payee_category_in', () => {
    const say = 'the DMV says my license will be suspended';
    expect(evaluateCondition({ payee_category_in: ['government'] }, features({ say }), rules)).toBeUndefined();
    expect(evaluateCondition({ payee_is: ['government'] }, features({ say }), rules)).toEqual(['payee named as government: "the dmv"']);
  });

  it('reads "DMV" as the whole payee name, not as the start of a business name', () => {
    expect(evaluateCondition(condition, payee('DMV'), rules)).toEqual(['payee named as government: "dmv"']);
    expect(evaluateCondition(condition, payee('D.M.V. billing'), rules)).toEqual(['payee named as government: "dmv"']);
    expect(evaluateCondition(condition, payee('DMV Hardware'), rules)).toBeUndefined();
  });

  it('reads "DMV" and "Rural Electric" at the end of the payee name, before words such as Office or renewal', () => {
    for (const name of ['Virginia DMV', 'California DMV', 'NY DMV', 'Florida DMV office', 'DMV Office', 'DMV renewal']) {
      expect(evaluateCondition(condition, payee(name), rules), name).toEqual(['payee named as government: "dmv"']);
    }
    // "dmv fees" is itself a government payee phrase, so it is the longer match that is reported.
    expect(evaluateCondition(condition, payee('Virginia DMV fees'), rules)).toEqual(['payee named as government: "dmv fees"']);
    for (const name of ['Southern Rural Electric', 'Jackson Rural Electric', 'Jackson Rural Electric billing']) {
      expect(evaluateCondition(condition, payee(name), rules), name).toEqual(['payee named as utility: "rural electric"']);
    }
    expect(evaluateCondition(condition, payee('Jackson Rural Electric Cooperative'), rules)).toEqual(['payee named as utility: "electric cooperative"']);
    for (const name of ['DMV Roofing', 'DMV Hardware', 'Rural Electric Supply', 'Rural Electric Supply Company']) {
      expect(evaluateCondition(condition, payee(name), rules), name).toBeUndefined();
    }
  });

  it('reads each reading of a payee name with invisible characters in it', () => {
    expect(evaluateCondition(condition, payee(`City${ZERO_WIDTH_SPACE}of Springfield`), rules)).toEqual(['payee named as government: "city of"']);
    expect(evaluateCondition(condition, payee(`Georgia${ZERO_WIDTH_SPACE}Power`), rules)).toEqual(['payee named as utility: "georgia power"']);
  });
});
