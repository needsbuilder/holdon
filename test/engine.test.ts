import { describe, expect, it } from 'vitest';
import { evaluateRequest, pickClarifyingQuestion, policyMethodBlocks } from '../src/domain/engine.js';
import { containsActionableContact } from '../src/domain/text.js';
import { DEFAULT_POLICY, type CheckInput } from '../src/domain/types.js';
import { SCENARIOS, engineContext } from './helpers.js';

const ctx = engineContext();
const run = (input: CheckInput, overrides = {}) => evaluateRequest(input, engineContext(overrides));

describe('evaluateRequest: the brief scenarios', () => {
  it('stops an "IRS agent" demanding $2,000 in gift cards', () => {
    const outcome = run({ ...SCENARIOS.irsGiftCards, urgency_claims: [...SCENARIOS.irsGiftCards.urgency_claims] });
    expect(outcome.verdict).toBe('stop');
    expect(outcome.next_step).toBe('place_hold');
    expect(outcome.policy).toMatchObject({ requires_family_approval: true, blocked: true });
    expect(outcome.risk_signals.map((s) => s.id)).toEqual(
      expect.arrayContaining(['gift-card-payment-demand', 'government-impersonation-demand', 'keep-it-secret', 'pressure-to-act-now']),
    );
    expect(outcome.payee).toMatchObject({ status: 'mismatch', registry_id: 'irs' });
    expect(outcome.payee.mismatches.map((m) => m.code)).toEqual(expect.arrayContaining(['method_never_used', 'phone_not_on_file']));
    // The only phone number offered is the official one from the registry.
    expect(outcome.say_to_user).toContain('800-829-1040');
    expect(outcome.say_to_user).not.toContain('555');
  });

  it('verifies a genuine utility bill and routes it to family because of the amount', () => {
    const outcome = run(SCENARIOS.utilityBill);
    expect(outcome.verdict).toBe('verified');
    expect(outcome.risk_signals).toEqual([]);
    expect(outcome.payee).toMatchObject({ status: 'verified', registry_id: 'con-edison', matches: ['name', 'payment_method'] });
    expect(outcome.policy).toMatchObject({ requires_family_approval: true, blocked: false });
    expect(outcome.next_step).toBe('place_hold');
  });

  it('answers "unknown" for a contractor that is not in the registry', () => {
    const outcome = run(SCENARIOS.contractorDeposit);
    expect(outcome.verdict).toBe('unknown');
    expect(outcome.payee.status).toBe('not_in_registry');
    expect(outcome.payee.official).toBeUndefined();
    expect(outcome.risk_signals).toEqual([]);
    expect(outcome.next_step).toBe('place_hold');
    expect(outcome.say_to_user).toMatch(/doesn't mean anything is wrong/);
  });
});

describe('evaluateRequest: verdict rules', () => {
  it('is pure: the same input always gives the same outcome', () => {
    const input: CheckInput = { ...SCENARIOS.irsGiftCards, urgency_claims: ['arrest_or_legal_threat'] };
    const first = JSON.stringify(run(input));
    for (let i = 0; i < 5; i += 1) expect(JSON.stringify(run(input))).toBe(first);
  });

  it('lets a small payment to a verified payee go ahead without family approval', () => {
    const outcome = run({ description: 'Pay my Medicare premium bill that came in the mail', payee_name: 'Medicare', amount_usd: 85, payment_method: 'bank_transfer', contact_channel: 'mail' });
    expect(outcome).toMatchObject({ verdict: 'verified', next_step: 'pay' });
    expect(outcome.policy.requires_family_approval).toBe(false);
    expect(outcome.say_to_user).toMatch(/simulated/);
  });

  it('asks family at exactly the threshold and not one cent below', () => {
    const base = { description: 'Pay my PG&E bill from the mail', payee_name: 'PG&E', payment_method: 'card', contact_channel: 'mail' } as const;
    expect(run({ ...base, amount_usd: 100 }).next_step).toBe('place_hold');
    expect(run({ ...base, amount_usd: 99.99 }).next_step).toBe('pay');
    expect(run({ ...base, amount_usd: 99.99 }, { policy: { ...DEFAULT_POLICY, approval_threshold_usd: 50 } }).next_step).toBe('place_hold');
  });

  it('asks family when a verified payee has no amount', () => {
    const outcome = run({ description: 'Pay the IRS what I owe, the letter came in the mail', payee_name: 'IRS', contact_channel: 'mail' });
    expect(outcome.verdict).toBe('verified');
    expect(outcome.policy.requires_family_approval).toBe(true);
  });

  it('holds for family on a medium signal alone', () => {
    const outcome = run({ description: 'My nephew is stranded after a car accident and needs money for the tow', payee_name: 'Kevin Marsh', amount_usd: 300, payment_method: 'card' });
    expect(outcome.verdict).toBe('hold_for_family');
    expect(outcome.risk_signals.map((s) => s.id)).toEqual(['family-emergency-bail']);
    expect(outcome.policy.blocked).toBe(false);
  });

  it('holds for family when an official payee is contacted from a number that is not on file', () => {
    const outcome = run({ description: 'National Grid left a voicemail about my balance', payee_name: 'National Grid', amount_usd: 60, payment_method: 'card', contact_channel: 'phone_call', claimed_phone: '888-555-0142' });
    expect(outcome.verdict).toBe('hold_for_family');
    expect(outcome.payee.mismatches.map((m) => m.code)).toEqual(['phone_not_on_file']);
  });

  it('stops a government request that arrives by phone, text or email, but not one that arrives by mail', () => {
    const base = { description: 'Social Security says I must repay an overdue amount', payee_name: 'Social Security', amount_usd: 400, payment_method: 'card' } as const;
    for (const contact_channel of ['phone_call', 'text', 'email'] as const) {
      expect(run({ ...base, contact_channel }).verdict, contact_channel).toBe('stop');
    }
    expect(run({ ...base, contact_channel: 'mail' }).verdict).toBe('verified');
  });

  it('stops a payment to a lookalike website', () => {
    const outcome = run({ description: 'USPS texted that my parcel needs a small redelivery fee', payee_name: 'USPS', amount_usd: 1.99, payment_method: 'card', contact_channel: 'text', claimed_url: 'https://usps-redelivery-help.com/pay' });
    expect(outcome.verdict).toBe('stop');
    expect(outcome.payee.mismatches.map((m) => m.code)).toContain('url_not_official');
  });

  it('stops a utility shutoff threat made by phone, and offers the official number', () => {
    const outcome = run({ description: 'Con Edison called and will shut off my power in 30 minutes unless I pay', payee_name: 'Con Edison', amount_usd: 300, contact_channel: 'phone_call' });
    expect(outcome.verdict).toBe('stop');
    expect(outcome.risk_signals[0]?.id).toBe('utility-shutoff-threat');
    expect(outcome.say_to_user).toContain('1-800-752-6633');
  });

  it('infers the payment method from the description when it is not given', () => {
    const outcome = run({ description: 'He told me to buy four Apple gift cards for the fine', payee_name: 'County Sheriff', amount_usd: 800 });
    expect(outcome).toMatchObject({ effective_method: 'gift_card', method_source: 'inferred', verdict: 'stop' });
  });

  it('declines instead of placing a hold when the circle has no trusted contact', () => {
    expect(run(SCENARIOS.contractorDeposit, { contactName: undefined }).next_step).toBe('decline');
    expect(run({ ...SCENARIOS.irsGiftCards, urgency_claims: [] }, { contactName: undefined }).next_step).toBe('decline');
  });

  it('declines a stopped request when the family switched off stop notifications', () => {
    const outcome = run({ ...SCENARIOS.irsGiftCards, urgency_claims: [] }, { policy: { ...DEFAULT_POLICY, notify_on_stop: false } });
    expect(outcome).toMatchObject({ verdict: 'stop', next_step: 'decline' });
  });

  it('treats a payee the family vouched for as confirmed', () => {
    const trustedPayees = [{ name: 'Greenleaf Roofing', normalized_name: 'greenleaf roofing', added_by: 'Sarah Ellis', added_at: '2026-10-01T00:00:00.000Z' }];
    const outcome = run({ ...SCENARIOS.contractorDeposit, amount_usd: 80 }, { trustedPayees });
    expect(outcome).toMatchObject({ verdict: 'verified', next_step: 'pay' });
    expect(outcome.payee.status).toBe('family_trusted');
  });
});

describe('evaluateRequest: everyday requests are not treated as scams', () => {
  const signalIds = (input: CheckInput) => run(input).risk_signals.map((s) => s.id);

  it('a gift card bought as a birthday present is not stopped, but still goes to family as an unconfirmed payee', () => {
    const outcome = run({ description: "Buy a $50 Amazon gift card for my granddaughter's birthday", payee_name: 'Amazon', amount_usd: 50, payment_method: 'card' });
    expect(outcome.risk_signals).toEqual([]);
    expect(outcome).toMatchObject({ verdict: 'unknown', next_step: 'place_hold', effective_method: 'card' });
  });

  it('a gift card used to pay someone is stopped even when a present is mentioned', () => {
    const outcome = run({ description: 'He said to say the gift cards are a birthday present', payee_name: 'Officer Daniels', amount_usd: 900, payment_method: 'gift_card' });
    expect(outcome.verdict).toBe('stop');
  });

  it('a Social Security overpayment letter that came by mail is not stopped', () => {
    const outcome = run({ description: 'Social Security sent a letter saying I was overpaid and must repay the overpayment', payee_name: 'Social Security', amount_usd: 400, payment_method: 'check', contact_channel: 'mail' });
    expect(outcome.risk_signals).toEqual([]);
    expect(outcome.verdict).toBe('verified');
  });

  it.each([
    ['a Secret Santa present', { description: 'Buy a scarf for the office Secret Santa', payee_name: 'Macys', amount_usd: 25, payment_method: 'card' }],
    ['a TV remote control', { description: 'Order a replacement remote control for my computer monitor from the store website', payee_name: 'Best Buy', amount_usd: 30, payment_method: 'card', contact_channel: 'website' }],
    ['a delivery courier fee', { description: 'Pay the courier for bringing my groceries', payee_name: 'Corner Market', amount_usd: 12, payment_method: 'cash', contact_channel: 'in_person' }],
    ['moving money between own accounts', { description: 'Move my money from savings to checking to cover the rent', payee_name: 'my checking account', amount_usd: 900, payment_method: 'bank_transfer' }],
    ['a lottery ticket', { description: 'Buy a lottery ticket at the corner shop', payee_name: 'Corner Market', amount_usd: 2, payment_method: 'card' }],
    ['a Medicare premium', { description: 'Pay my Medicare premium, the number is on my Medicare card', payee_name: 'Medicare', amount_usd: 185, payment_method: 'check', contact_channel: 'mail' }],
  ] as Array<[string, CheckInput]>)('%s raises no warning sign', (_label, input) => {
    expect(signalIds(input)).toEqual([]);
  });
});

describe('policy', () => {
  it('always blocks gift cards and cryptocurrency for official payees, whatever the family set', () => {
    const open = { ...DEFAULT_POLICY, blocked_methods_official_payees: [], blocked_methods_all_payees: [] };
    expect(policyMethodBlocks(open, 'gift_card', true)).toHaveLength(1);
    expect(policyMethodBlocks(open, 'crypto', true)).toHaveLength(1);
    expect(policyMethodBlocks(open, 'card', true)).toEqual([]);
    expect(policyMethodBlocks(open, 'gift_card', false)).toEqual([]);
  });

  it('applies the family\'s extra blocked methods', () => {
    const strict = { ...DEFAULT_POLICY, blocked_methods_official_payees: ['wire' as const], blocked_methods_all_payees: ['zelle' as const] };
    expect(policyMethodBlocks(strict, 'wire', true)).toHaveLength(1);
    expect(policyMethodBlocks(strict, 'wire', false)).toEqual([]);
    expect(policyMethodBlocks(strict, 'zelle', false)).toHaveLength(1);
    const outcome = run({ description: 'Send my neighbour money for mowing the lawn', payee_name: 'Tom Baker', amount_usd: 40, payment_method: 'zelle' }, { policy: strict });
    expect(outcome.verdict).toBe('stop');
    expect(outcome.policy.blocked_reasons[0]).toMatch(/family's settings/);
  });
});

describe('what the older adult hears', () => {
  const inputs: CheckInput[] = [
    { ...SCENARIOS.irsGiftCards, urgency_claims: ['arrest_or_legal_threat'] },
    SCENARIOS.utilityBill,
    SCENARIOS.contractorDeposit,
    { description: 'Call 888-555-0142 or go to irs-pay-now.com to settle. Email agent@irs-pay-now.com', payee_name: 'IRS office 888-555-0142', claimed_phone: '888-555-0142', claimed_url: 'http://irs-pay-now.com/settle', amount_usd: 950, contact_channel: 'email' },
    { description: 'Officer Daniels at 202-555-0199 says wire it today', payee_name: 'Officer Daniels 202-555-0199', claimed_phone: '202-555-0199', amount_usd: 3000, payment_method: 'wire', contact_channel: 'phone_call' },
  ];

  it('never repeats a phone number, link or email address from the request', () => {
    for (const input of inputs) {
      const outcome = run(input);
      const official = new Set((outcome.payee.official?.phones ?? []).map((p) => p.number));
      // Remove registry-verified numbers and source citations, then nothing actionable may remain.
      let text = JSON.stringify({ say: outcome.say_to_user, payee: { ...outcome.payee, official: undefined, mismatches: outcome.payee.mismatches.map((m) => ({ ...m, source: undefined })) }, policy: outcome.policy, signals: outcome.risk_signals.map((s) => ({ ...s, source: undefined })) });
      for (const number of official) text = text.split(number).join('');
      text = text.replace(/\b(?:irs\.gov|ssa\.gov|usps\.com|uspis\.gov|coned\.com|www\.irs\.gov)\b/g, '');
      expect(containsActionableContact(text), `${input.description}\n${text}`).toBe(false);
      expect(text).not.toContain('555');
      expect(text).not.toContain('irs-pay-now');
    }
  });

  it('stays calm and never blames the person', () => {
    const blame = /\b(stupid|foolish|gullible|naive|fell for|victim|your fault|should have known|you were scammed|you got scammed|careless)\b/i;
    for (const input of inputs) {
      const say = run(input).say_to_user;
      expect(say).not.toMatch(blame);
      expect(say).not.toMatch(/!/);
      expect(say.length).toBeLessThan(600);
    }
  });

  it('says clearly that nothing will be paid when a request is stopped', () => {
    expect(run({ ...SCENARIOS.irsGiftCards, urgency_claims: [] }).say_to_user).toMatch(/won't send any money/);
  });
});

describe('pickClarifyingQuestion', () => {
  it('asks how the request arrived when an official payee is named without a channel', () => {
    expect(pickClarifyingQuestion({ description: 'Pay Con Edison', payee_name: 'Con Edison', amount_usd: 60, payment_method: 'card' }, ctx)).toBe('contact_channel');
  });

  it('asks how to pay when the method is missing for an unknown payee', () => {
    expect(pickClarifyingQuestion({ description: 'Send money to a man who phoned about my car warranty', payee_name: 'Auto Shield', amount_usd: 300 }, ctx)).toBe('payment_method');
  });

  it('asks nothing when the request is already stopped', () => {
    expect(pickClarifyingQuestion({ description: 'The IRS wants gift cards', payee_name: 'IRS' }, ctx)).toBeUndefined();
  });

  it('asks nothing when the key details are present', () => {
    expect(pickClarifyingQuestion(SCENARIOS.utilityBill, ctx)).toBeUndefined();
    expect(pickClarifyingQuestion(SCENARIOS.contractorDeposit, ctx)).toBeUndefined();
  });
});
