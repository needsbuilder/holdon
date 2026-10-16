import { describe, expect, it } from 'vitest';
import { evaluateRequest, payTimeRefusal, pickClarifyingQuestion, policyMethodBlocks } from '../src/domain/engine.js';
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

  it('a present is no excuse when gift cards go to a government agency or utility', () => {
    const cases: CheckInput[] = [
      { description: 'The IRS agent said to pay the $50 penalty with Visa gift cards, as a thank you gift for his help', payee_name: 'IRS', amount_usd: 50 },
      { description: 'The man from the power company wants two Target gift cards as a Christmas present so my lights stay on', payee_name: 'Georgia Power', amount_usd: 200 },
      { description: 'The deputy said a Google Play card for his birthday would clear my warrant', payee_name: 'County Sheriff', amount_usd: 300 },
    ];
    for (const input of cases) {
      const outcome = run(input);
      expect(outcome, input.description).toMatchObject({ verdict: 'stop', effective_method: 'gift_card', method_source: 'inferred' });
      expect(outcome.risk_signals.map((s) => s.id), input.description).toContain('gift-card-payment-demand');
    }
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

  const noWiresToOfficials = { ...DEFAULT_POLICY, blocked_methods_official_payees: ['wire' as const] };

  it.each([
    'Department of Motor Vehicles',
    'DMV',
    'Franchise Tax Board',
    'State Police',
    'Los Angeles Department of Water and Power',
    'Georgia Power',
    'City of Springfield',
    'Madison County Municipal Court',
    'Tri-County Electric Cooperative',
  ])('treats %s as an official payee, for the floor and for the family\'s settings', (payee_name) => {
    const wire = run({ description: `Pay ${payee_name}`, payee_name, amount_usd: 60, payment_method: 'wire', contact_channel: 'mail' }, { policy: noWiresToOfficials });
    expect(wire.verdict).toBe('stop');
    expect(wire.policy.blocked_reasons).toEqual(["The family's settings do not allow paying official payees with a wire transfer."]);
    const crypto = run({ description: `Pay ${payee_name}`, payee_name, amount_usd: 60, payment_method: 'crypto', contact_channel: 'mail' });
    expect(crypto.policy.blocked_reasons).toContain('Hold On never pays a government agency, utility or other official payee with cryptocurrency.');
  });

  it.each(['Power Washing Pros', 'Clearwater Plumbing', 'Hot Water Heater Express', 'Citywide Movers', 'County Line Feed Store', 'Light and Bright Cleaning'])(
    'does not treat %s as official for an everyday word in its name',
    (payee_name) => {
      const outcome = run({ description: `Pay ${payee_name} for the job`, payee_name, amount_usd: 60, payment_method: 'wire', contact_channel: 'in_person' }, { policy: noWiresToOfficials });
      expect(outcome.policy.blocked_reasons).toEqual([]);
    },
  );

  it.each([
    'U.S. Treasury',
    'U.S. Marshals',
    'D.M.V.',
    'Dept. of Motor Vehicles',
    'Dept. of Revenue',
    'Department of Motor Vehicle',
    'Secretary of State',
    'E-ZPass',
    'PSE&G',
    'SDG&E',
    'LADWP',
    'Southwest Gas',
    'Georgia Power Co.',
    'Post Office',
    'U.S.P.S.',
  ])('treats %s as an official payee however it is written', (payee_name) => {
    const wire = run({ description: `Pay the $60 fee to ${payee_name}`, payee_name, amount_usd: 60, payment_method: 'wire', contact_channel: 'mail' }, { policy: noWiresToOfficials });
    expect(wire.verdict).toBe('stop');
    expect(wire.policy.blocked_reasons).toContain("The family's settings do not allow paying official payees with a wire transfer.");
    const crypto = run({ description: `Pay the $60 fee to ${payee_name}`, payee_name, amount_usd: 60, payment_method: 'crypto', contact_channel: 'mail' });
    expect(crypto.policy.blocked_reasons).toContain('Hold On never pays a government agency, utility or other official payee with cryptocurrency.');
  });

  it.each([
    ['Georgia Power Washing', 'wire'],
    ['Kentucky Power Sports', 'check'],
    ['Rocky Mountain Power Equipment', 'check'],
    ['Smith Water and Sewer', 'check'],
    ["Bob's Gas and Electric", 'check'],
    ['Pacific Power Washing', 'wire'],
    ['Tampa Electric Contractors', 'wire'],
  ] as const)('does not treat %s as official because a utility name starts or sounds like it', (payee_name, method) => {
    const policy = { ...DEFAULT_POLICY, blocked_methods_official_payees: [method] };
    const outcome = run({ description: `Pay ${payee_name} for the job`, payee_name, amount_usd: 60, payment_method: method, contact_channel: 'in_person' }, { policy });
    expect(outcome.policy.blocked_reasons).toEqual([]);
  });

  it.each([
    ['DMV Roofing', { description: 'Pay DMV Roofing for the gutter repair', payee_name: 'DMV Roofing' }],
    ['Rural Electric Supply', { description: 'A new generator from Rural Electric Supply', payee_name: 'Rural Electric Supply' }],
    ['a contractor recommended by "my son at the State Police"', { description: 'Pay the deck contractor my son at the State Police recommended', payee_name: 'Smith Decks' }],
    ['a shop "next to the post office"', { description: 'New glasses from the optician next to the post office', payee_name: 'Main Street Optical' }],
  ] as Array<[string, CheckInput]>)('does not treat %s as official for an agency word that is not the payee', (_label, input) => {
    const outcome = run({ ...input, amount_usd: 60, payment_method: 'wire', contact_channel: 'in_person' }, { policy: noWiresToOfficials });
    expect(outcome.policy.blocked_reasons).toEqual([]);
    expect(outcome).toMatchObject({ verdict: 'unknown', next_step: 'place_hold' });
  });

  it.each([
    ['the payee is named', { description: 'Renewal notice', payee_name: 'DMV' }],
    ['the payee is named with "the"', { description: 'Renewal notice', payee_name: 'The DMV' }],
    ['no payee is named', { description: 'Pay the DMV registration fee' }],
    ['no payee is named, and the State Police is', { description: 'Pay the State Police for the accident report' }],
  ] as Array<[string, CheckInput]>)('still treats the DMV and the State Police as official when %s', (_label, input) => {
    const wire = run({ ...input, amount_usd: 60, payment_method: 'wire', contact_channel: 'mail' }, { policy: noWiresToOfficials });
    expect(wire.policy.blocked_reasons).toEqual(["The family's settings do not allow paying official payees with a wire transfer."]);
  });

  it.each(['The City of Los Angeles', 'the County of Fairfax', 'Georgia Power billing', 'The Georgia Power Company', 'Georgia Power customer service', 'Southwest Gas bill payment', 'Georgia Power account'])(
    'treats %s as an official payee, with "the" in front or a billing word after the name',
    (payee_name) => {
      const wire = run({ description: `Pay ${payee_name}`, payee_name, amount_usd: 60, payment_method: 'wire', contact_channel: 'mail' }, { policy: noWiresToOfficials });
      expect(wire.verdict).toBe('stop');
      expect(wire.policy.blocked_reasons).toEqual(["The family's settings do not allow paying official payees with a wire transfer."]);
    },
  );

  it('reads "city of" and "county of" as a government payee only at the start of the payee name', () => {
    const noCards = { ...DEFAULT_POLICY, blocked_methods_official_payees: ['card' as const] };
    const show = run({ description: 'Tickets to the city of Industry car show', payee_name: 'Car Show', amount_usd: 40, payment_method: 'card', contact_channel: 'in_person' }, { policy: noCards });
    expect(show.policy.blocked_reasons).toEqual([]);
    const city = run({ description: 'My water bill', payee_name: 'City of Springfield', amount_usd: 40, payment_method: 'card', contact_channel: 'mail' }, { policy: noCards });
    expect(city.policy.blocked_reasons).toEqual(["The family's settings do not allow paying official payees with a credit or debit card."]);
  });
});

describe('official payee words that are not scam signs', () => {
  const ids = (input: CheckInput) => run(input).risk_signals.map((s) => s.id);

  it.each([
    ['a City of Hope donation by phone', { description: 'Donation to City of Hope, they called asking for support', payee_name: 'City of Hope', amount_usd: 50, payment_method: 'card', contact_channel: 'phone_call' }],
    ['a granddaughter in the city of Chicago', { description: 'My granddaughter studies in the city of Chicago and needs help with books', payee_name: 'Emma', amount_usd: 60, payment_method: 'zelle', contact_channel: 'text' }],
    ['the city of light', { description: 'Tour package to Paris, the city of light', payee_name: 'Rick Steves Tours', amount_usd: 90, payment_method: 'card', contact_channel: 'email' }],
    ['a county of Fairfax chapter', { description: 'Annual dues for the garden club, county of Fairfax chapter', payee_name: 'Garden Club', amount_usd: 30, payment_method: 'check', contact_channel: 'email' }],
    ['an emailed DMV renewal', { description: 'My DMV registration renewal reminder came by email', payee_name: 'DMV', amount_usd: 85, payment_method: 'card', contact_channel: 'email' }],
    ['an emailed city water bill', { description: 'The City of Springfield emailed my water bill', payee_name: 'City of Springfield', amount_usd: 60, payment_method: 'card', contact_channel: 'email' }],
  ] as Array<[string, CheckInput]>)('%s is held for the family, not stopped as government impersonation', (_label, input) => {
    const outcome = run(input);
    expect(outcome.risk_signals.map((s) => s.id)).not.toContain('government-impersonation-demand');
    expect(outcome).toMatchObject({ verdict: 'unknown', next_step: 'place_hold' });
  });

  it.each([
    ['a plumber shutting off the water main', { description: 'The plumber from Smith Water and Sewer has to shut off the water main to fix the leak, he wants a deposit', payee_name: 'Smith Water and Sewer', amount_usd: 90, payment_method: 'check', contact_channel: 'in_person' }],
    ['an electrician disconnecting a stove', { description: "Bob's Gas and Electric is coming to disconnect the old stove and hook up the new one", payee_name: "Bob's Gas and Electric", amount_usd: 90, payment_method: 'check', contact_channel: 'phone_call' }],
    ['a power washer turning off sprinklers', { description: 'Pacific Power Washing will turn off my sprinklers before they wash the house', payee_name: 'Pacific Power Washing', amount_usd: 90, payment_method: 'card', contact_channel: 'in_person' }],
    ['a deck job that needs the gas grill disconnected', { description: 'Georgia Power Washing quoted the deck, they need the gas grill disconnected first', payee_name: 'Georgia Power Washing', amount_usd: 90, payment_method: 'card', contact_channel: 'phone_call' }],
  ] as Array<[string, CheckInput]>)('%s is not a utility shutoff threat', (_label, input) => {
    expect(ids(input)).toEqual([]);
    expect(run(input).verdict).toBe('unknown');
  });

  it.each([
    ["a USPS gift card for a graduation", { description: "Buy a USPS gift card for my granddaughter's graduation", payee_name: 'USPS', amount_usd: 25, payment_method: 'card', contact_channel: 'in_person' }],
    ['postage for a birthday gift card', { description: 'Postage to mail a birthday gift card to my grandson', payee_name: 'USPS', amount_usd: 12, payment_method: 'card', contact_channel: 'in_person' }],
  ] as Array<[string, CheckInput]>)('%s at the post office can be paid', (_label, input) => {
    expect(run(input)).toMatchObject({ verdict: 'verified', next_step: 'pay', risk_signals: [] });
    expect(run({ ...input, payment_method: undefined }).effective_method).toBe('unknown');
  });

  it.each([
    ['a grandson who is a police officer', { description: "My grandson the police officer turns 30, buy him a $50 Amazon gift card for his birthday", payee_name: 'Amazon', amount_usd: 50, payment_method: 'card' }],
    ['a granddaughter who works at the IRS', { description: 'Birthday gift card for my granddaughter who works at the IRS', payee_name: 'Starbucks', amount_usd: 25, payment_method: 'card' }],
    ['a utility lineman', { description: 'A thank you gift card for the utility company lineman who fixed our power after the storm', payee_name: 'Home Depot', amount_usd: 40, payment_method: 'card' }],
    ['a grandson, bought at a shop with "DMV" in its name', { description: "Buy a $50 gift card for my grandson's birthday at DMV Hardware", payee_name: 'DMV Hardware', amount_usd: 50, payment_method: 'card' }],
  ] as Array<[string, CheckInput]>)('a present for %s is still a present, because only the payee counts', (_label, input) => {
    expect(ids(input)).not.toContain('gift-card-payment-demand');
    expect(run({ ...input, payment_method: undefined }).effective_method).toBe('unknown');
  });

  it('drops the present exception when the payee named is a utility outside the registry, even one the family vouched for', () => {
    const trustedPayees = [{ name: 'Southwest Gas', normalized_name: 'southwest gas', added_by: 'Sarah Ellis', added_at: '2026-10-01T00:00:00.000Z' }];
    const input: CheckInput = { description: 'Southwest Gas says pay the bill with gift cards as a thank you gift', payee_name: 'Southwest Gas', amount_usd: 40, payment_method: 'card' };
    const outcome = run(input, { trustedPayees });
    expect(outcome.verdict).toBe('stop');
    expect(outcome.risk_signals.find((s) => s.id === 'gift-card-payment-demand')?.matched_on).toContain('payee named as utility: "southwest gas"');
  });

  it('keeps the same evidence for the demo gift card demand', () => {
    const signal = run({ ...SCENARIOS.irsGiftCards, urgency_claims: [...SCENARIOS.irsGiftCards.urgency_claims] }).risk_signals.find((s) => s.id === 'gift-card-payment-demand');
    expect(signal?.matched_on).toEqual(['payment method: gift_card', 'words: "gift cards"']);
  });
});

describe('a payee the family recently said no to', () => {
  const bill: CheckInput = { description: 'My Con Edison electric bill came in the mail', payee_name: 'Con Edison', amount_usd: 50, payment_method: 'card', contact_channel: 'mail' };
  const deposit: CheckInput = { ...SCENARIOS.contractorDeposit, amount_usd: 80 };
  const trustedPayees = [{ name: 'Greenleaf Roofing', normalized_name: 'greenleaf roofing', added_by: 'Sarah Ellis', added_at: '2026-10-01T00:00:00.000Z' }];

  it('goes to the family again even under the limit, by registry entry or by name', () => {
    const coned = run(bill, { recentDenials: { registryIds: ['con-edison'], names: [] } });
    expect(coned).toMatchObject({ verdict: 'verified', next_step: 'place_hold', policy: { requires_family_approval: true, blocked: false } });
    expect(coned.say_to_user).toBe(
      'Con Edison is on my list of official payees. A recent payment to them was turned down, so Sarah gets a quick request to approve this one first. Nothing is paid until then.',
    );
    const roofer = run(deposit, { trustedPayees, recentDenials: { registryIds: [], names: ['greenleaf roofing'] } });
    expect(roofer).toMatchObject({ verdict: 'verified', next_step: 'place_hold' });
  });

  it('does not touch other payees', () => {
    expect(run(bill, { recentDenials: { registryIds: ['irs'], names: ['greenleaf roofing'] } }).next_step).toBe('pay');
    expect(run(deposit, { trustedPayees, recentDenials: { registryIds: ['con-edison'], names: ['bob plumbing'] } }).next_step).toBe('pay');
  });
});

describe('payTimeRefusal', () => {
  const bill: CheckInput = { description: 'Con Edison bill from the mail', payee_name: 'Con Edison', amount_usd: 150, contact_channel: 'mail' };

  it('puts down to the method only what the method chosen at pay time brings', () => {
    expect(payTimeRefusal(bill, 'unknown', 'bank_transfer', ctx)).toBeUndefined();
    expect(payTimeRefusal(bill, 'unknown', 'gift_card', ctx)).toEqual({ code: 'method_not_allowed', reason: { kind: 'policy', rule: 'floor', official_by: 'registry' } });
    expect(payTimeRefusal(bill, 'unknown', 'zelle', ctx)).toMatchObject({ code: 'method_not_allowed', reason: { kind: 'official_fact' } });
    expect(payTimeRefusal(SCENARIOS.contractorDeposit, 'unknown', 'gift_card', ctx)).toMatchObject({ code: 'method_not_allowed', reason: { kind: 'scam_pattern' } });
  });

  it('reports what stands whatever the method as blocked', () => {
    const noCards = engineContext({ policy: { ...DEFAULT_POLICY, blocked_methods_all_payees: ['card'] } });
    expect(payTimeRefusal(bill, 'card', 'card', noCards)).toEqual({ code: 'blocked', reason: { kind: 'policy', rule: 'family_all_payees' } });
    expect(payTimeRefusal(bill, 'card', 'card', ctx)).toBeUndefined();
  });

  it('refuses another method when the words mention gift cards or cryptocurrency and no method was approved', () => {
    const birthday: CheckInput = { description: "A gift card for my granddaughter's birthday", payee_name: 'Amazon', amount_usd: 50 };
    expect(payTimeRefusal(birthday, 'unknown', 'card', ctx)).toEqual({ code: 'method_not_allowed', reason: { kind: 'mentioned_method', mentioned: 'gift_card' } });
    // Approved with the method stated, the words were weighed against it at the time.
    expect(payTimeRefusal(birthday, 'card', 'card', ctx)).toBeUndefined();
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
