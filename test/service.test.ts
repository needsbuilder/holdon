import { beforeEach, describe, expect, it } from 'vitest';
import { signApprovalToken, verifyApprovalToken } from '../src/approval.js';
import { loadRegistry } from '../src/domain/registry.js';
import { loadRules } from '../src/domain/rules.js';
import { containsActionableContact } from '../src/domain/text.js';
import { HoldOnError, hashToken } from '../src/service.js';
import { SCENARIOS, createTestService, type TestService } from './helpers.js';

const HOUR = 3_600_000;
let t: TestService;

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof HoldOnError) return error.code;
    throw error;
  }
  return undefined;
}

function holdFor(scenario: Record<string, unknown>, summary = 'Please take a look') {
  const { check_id, outcome } = t.service.checkRequest(t.margaret, scenario as never);
  const { hold } = t.service.placeHold(t.margaret, { check_id, summary });
  return { check_id, outcome, hold };
}

beforeEach(() => {
  t = createTestService();
});

describe('roles', () => {
  it('lets only the member check, hold, pay and cancel', () => {
    expect(errorCode(() => t.service.checkRequest(t.sarah, SCENARIOS.utilityBill))).toBe('forbidden');
    expect(errorCode(() => t.service.placeHold(t.sarah, { summary: 'x' }))).toBe('forbidden');
    expect(errorCode(() => t.service.pay(t.sarah, { hold_id: 'hold_x' }))).toBe('forbidden');
    expect(errorCode(() => t.service.cancelHold(t.sarah, 'hold_x'))).toBe('forbidden');
  });

  it('lets only the trusted contact decide and change settings', () => {
    const { hold } = holdFor(SCENARIOS.utilityBill);
    expect(errorCode(() => t.service.familyDecide(t.margaret, { hold_id: hold.id, decision: 'approve' }))).toBe('forbidden');
    expect(errorCode(() => t.service.familyInbox(t.margaret, {}))).toBe('forbidden');
    expect(errorCode(() => t.service.updatePolicy(t.margaret, { approval_threshold_usd: 100000 }))).toBe('forbidden');
    expect(errorCode(() => t.service.getCircle(t.margaret))).toBe('forbidden');
    expect(t.service.store.getHold(hold.id)?.status).toBe('pending_family');
  });

  it('keeps one circle from seeing another circle\'s holds', () => {
    const now = new Date().toISOString();
    t.store.upsertCircle({ id: 'circle_other', name: 'Other family', policy: t.service.circleView('circle_ellis').policy }, now);
    t.store.upsertUser({ id: 'user_other_contact', circle_id: 'circle_other', name: 'Other Contact', role: 'contact', token_hash: hashToken('other-contact-token') }, now);
    t.store.upsertUser({ id: 'user_other_member', circle_id: 'circle_other', name: 'Other Member', role: 'member', token_hash: hashToken('other-member-token') }, now);
    const { hold } = holdFor(SCENARIOS.utilityBill);
    const otherContact = t.service.authenticate('other-contact-token')!;
    const otherMember = t.service.authenticate('other-member-token')!;
    expect(errorCode(() => t.service.familyDecide(otherContact, { hold_id: hold.id, decision: 'approve' }))).toBe('not_found');
    expect(t.service.familyInbox(otherContact, {})).toEqual([]);
    expect(errorCode(() => t.service.getHold(otherMember, hold.id))).toBe('not_found');
    expect(errorCode(() => t.service.pay(otherMember, { hold_id: hold.id }))).toBe('not_found');
  });

  it('rejects unknown tokens', () => {
    expect(t.service.authenticate('nope')).toBeUndefined();
    expect(t.service.authenticate('')).toBeUndefined();
  });
});

describe('hold lifecycle', () => {
  it('verified bill: hold, approve, pay, receipt', () => {
    const { hold } = holdFor(SCENARIOS.utilityBill);
    expect(hold).toMatchObject({ status: 'pending_family', blocked: false, amount_cents: 18240, payment_method: 'card' });
    expect(errorCode(() => t.service.pay(t.margaret, { hold_id: hold.id }))).toBe('not_approved');

    const decided = t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve', note: 'That is your usual bill, go ahead.' });
    expect(decided.hold.status).toBe('approved');
    expect(t.service.memberHoldView(decided.hold)).toMatchObject({ next_step: 'pay', decision: { by: 'Sarah Ellis', note: 'That is your usual bill, go ahead.' } });

    const { receipt } = t.service.pay(t.margaret, { hold_id: hold.id });
    expect(t.service.receiptView(receipt)).toMatchObject({ amount_usd: 182.4, payee: 'Con Edison', method: 'card', simulated: true });
    expect(receipt.confirmation).toMatch(/^SIM-[0-9A-F]{8}$/);
    expect(t.service.getHold(t.margaret, hold.id).status).toBe('paid');
  });

  it('paying twice returns the same receipt and charges nothing new', () => {
    const { hold } = holdFor(SCENARIOS.utilityBill);
    t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve' });
    const first = t.service.pay(t.margaret, { hold_id: hold.id }).receipt;
    const second = t.service.pay(t.margaret, { hold_id: hold.id }).receipt;
    expect(second).toEqual(first);
  });

  it('placing a hold twice for the same check reuses the hold', () => {
    const { check_id } = t.service.checkRequest(t.margaret, SCENARIOS.utilityBill);
    const first = t.service.placeHold(t.margaret, { check_id, summary: 'Electric bill' });
    const second = t.service.placeHold(t.margaret, { check_id, summary: 'Electric bill' });
    expect(second.hold.id).toBe(first.hold.id);
    expect(second.reused).toBe(true);
    expect(t.service.familyInbox(t.sarah, {})).toHaveLength(1);
  });

  it('refuses a hold whose details differ from the check it refers to', () => {
    const { check_id } = t.service.checkRequest(t.margaret, { ...SCENARIOS.utilityBill, amount_usd: 64.1 });
    expect(errorCode(() => t.service.placeHold(t.margaret, { check_id, summary: 'Electric bill', amount_usd: 6400 }))).toBe('invalid_input');
    expect(errorCode(() => t.service.placeHold(t.margaret, { check_id, summary: 'Electric bill', payee_name: 'Officer Daniels' }))).toBe('invalid_input');
    expect(errorCode(() => t.service.placeHold(t.margaret, { check_id, summary: 'Electric bill', payment_method: 'wire' }))).toBe('invalid_input');
    expect(t.service.familyInbox(t.sarah, {})).toEqual([]);
    // Repeating the checked details is fine.
    const { hold } = t.service.placeHold(t.margaret, { check_id, summary: 'Electric bill', amount_usd: 64.1, payee_name: 'con edison', payment_method: 'card' });
    expect(hold).toMatchObject({ amount_cents: 6410, payee_name: 'Con Edison', payment_method: 'card' });
  });

  it('runs a check itself when a hold is placed without one', () => {
    const { hold } = t.service.placeHold(t.margaret, { summary: 'The IRS wants $500 in gift cards', payee_name: 'IRS', amount_usd: 500 });
    expect(hold.blocked).toBe(true);
    expect(t.service.familyHoldView(hold, t.sarah.user_id).risk_signals.map((s) => s.id)).toContain('gift-card-payment-demand');
  });

  it('a denied hold cannot be paid, and the note reaches the member', () => {
    const { hold } = holdFor(SCENARIOS.utilityBill);
    const { hold: denied } = t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'deny', note: 'Let me check the amount first.' });
    expect(denied.status).toBe('denied');
    expect(errorCode(() => t.service.pay(t.margaret, { hold_id: hold.id }))).toBe('denied');
    expect(t.service.memberHoldView(denied).say_to_user).toContain('Let me check the amount first.');
  });

  it('an approval can be withdrawn until it is paid, but a denial cannot be reversed', () => {
    const { hold } = holdFor(SCENARIOS.utilityBill);
    t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve' });
    expect(t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'deny' }).hold.status).toBe('denied');
    expect(errorCode(() => t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve' }))).toBe('already_decided');
  });

  it('repeating the same decision is harmless', () => {
    const { hold } = holdFor(SCENARIOS.utilityBill);
    t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve' });
    expect(t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve' }).hold.status).toBe('approved');
  });

  it('the member can cancel a pending hold, after which it cannot be decided or paid', () => {
    const { hold } = holdFor(SCENARIOS.utilityBill);
    expect(t.service.cancelHold(t.margaret, hold.id).status).toBe('cancelled');
    expect(t.service.cancelHold(t.margaret, hold.id).status).toBe('cancelled');
    expect(errorCode(() => t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve' }))).toBe('already_decided');
    expect(errorCode(() => t.service.pay(t.margaret, { hold_id: hold.id }))).toBe('cancelled');
  });
});

describe('stopped requests', () => {
  it('can be denied but never approved or paid', () => {
    const { hold, outcome } = holdFor({ ...SCENARIOS.irsGiftCards, urgency_claims: ['arrest_or_legal_threat'] });
    expect(outcome.verdict).toBe('stop');
    expect(hold.blocked).toBe(true);
    const view = t.service.familyHoldView(hold, t.sarah.user_id);
    expect(view).toMatchObject({ can_approve: false, requires_trust_payee: false });
    expect(view.cannot_approve_reason).toMatch(/stopped and cannot be approved/);
    expect(errorCode(() => t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve', trust_payee: true }))).toBe('blocked');
    expect(errorCode(() => t.service.pay(t.margaret, { hold_id: hold.id }))).toBe('blocked');
    expect(t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'deny' }).hold.status).toBe('denied');
  });
});

describe('payees outside the registry', () => {
  it('need the contact to vouch for them, and are remembered afterwards', () => {
    const { hold } = holdFor(SCENARIOS.contractorDeposit);
    const before = t.service.familyHoldView(hold, t.sarah.user_id);
    expect(before).toMatchObject({ can_approve: true, requires_trust_payee: true, payee_status: 'not_in_registry' });
    expect(errorCode(() => t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve' }))).toBe('payee_not_verified');
    expect(t.service.store.getHold(hold.id)?.status).toBe('pending_family');

    const decided = t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve', trust_payee: true });
    expect(decided.trustedPayeeAdded).toBe(true);
    expect(t.service.memberHoldView(decided.hold).payee_status).toBe('family_trusted');
    expect(t.service.pay(t.margaret, { hold_id: hold.id }).receipt).toMatchObject({ payee: 'Greenleaf Roofing', amount_cents: 150000, method: 'check' });

    // A later session: the same payee is now a confirmed payee, and a small amount needs no approval.
    const next = t.service.checkRequest(t.margaret, { ...SCENARIOS.contractorDeposit, description: 'Final payment to the roofer', amount_usd: 75 });
    expect(next.outcome).toMatchObject({ verdict: 'verified', next_step: 'pay' });
    expect(next.outcome.payee.status).toBe('family_trusted');
    expect(t.service.circleView('circle_ellis').trusted_payees.map((p) => p.name)).toEqual(['Greenleaf Roofing']);
  });

  it('stop being confirmed when the contact removes them', () => {
    const { hold } = holdFor(SCENARIOS.contractorDeposit);
    t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve', trust_payee: true });
    const { changed } = t.service.updatePolicy(t.sarah, { remove_trusted_payee: 'greenleaf roofing' });
    expect(changed).toEqual(['trusted_payees']);
    // The approval stands on record, but payment is re-checked at pay time and refused.
    expect(errorCode(() => t.service.pay(t.margaret, { hold_id: hold.id }))).toBe('payee_not_verified');
    expect(errorCode(() => t.service.updatePolicy(t.sarah, { remove_trusted_payee: 'Nobody Inc' }))).toBe('not_found');
  });

  it('cannot be approved without an amount', () => {
    const { hold } = holdFor({ description: 'The roofer wants a deposit', payee_name: 'Greenleaf Roofing', payment_method: 'check' });
    expect(t.service.familyHoldView(hold, t.sarah.user_id).can_approve).toBe(false);
    expect(errorCode(() => t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve', trust_payee: true }))).toBe('blocked');
  });
});

describe('paying without a hold', () => {
  it('works for a confirmed payee under the approval limit', () => {
    const { check_id, outcome } = t.service.checkRequest(t.margaret, { description: 'Medicare premium bill from the mail', payee_name: 'Medicare', amount_usd: 85, payment_method: 'bank_transfer', contact_channel: 'mail' });
    expect(outcome.next_step).toBe('pay');
    const { receipt, hold } = t.service.pay(t.margaret, { check_id });
    expect(receipt).toMatchObject({ payee: 'Medicare', amount_cents: 8500, method: 'bank_transfer' });
    expect(t.service.memberHoldView(hold).decision?.by).toBe('Family policy');
    expect(t.service.pay(t.margaret, { check_id }).receipt.id).toBe(receipt.id);
  });

  it('is refused when the check needed family approval', () => {
    const { check_id } = t.service.checkRequest(t.margaret, SCENARIOS.utilityBill);
    expect(errorCode(() => t.service.pay(t.margaret, { check_id }))).toBe('not_approved');
    const stopped = t.service.checkRequest(t.margaret, { ...SCENARIOS.irsGiftCards, urgency_claims: [] });
    expect(errorCode(() => t.service.pay(t.margaret, { check_id: stopped.check_id }))).toBe('not_approved');
  });

  it('is re-checked against the policy in force at pay time', () => {
    const { check_id } = t.service.checkRequest(t.margaret, { description: 'Medicare premium bill from the mail', payee_name: 'Medicare', amount_usd: 85, payment_method: 'bank_transfer', contact_channel: 'mail' });
    t.service.updatePolicy(t.sarah, { approval_threshold_usd: 50 });
    expect(errorCode(() => t.service.pay(t.margaret, { check_id }))).toBe('not_approved');
  });

  it('needs exactly one of hold_id and check_id', () => {
    expect(errorCode(() => t.service.pay(t.margaret, {}))).toBe('invalid_input');
    expect(errorCode(() => t.service.pay(t.margaret, { hold_id: 'hold_a', check_id: 'chk_b' }))).toBe('invalid_input');
  });
});

describe('payment method at pay time', () => {
  it('asks for a method when none was given, then refuses one the payee never uses', () => {
    const { hold } = holdFor({ description: 'Con Edison bill from the mail', payee_name: 'Con Edison', amount_usd: 150, contact_channel: 'mail' });
    t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve' });
    expect(errorCode(() => t.service.pay(t.margaret, { hold_id: hold.id }))).toBe('method_required');
    expect(errorCode(() => t.service.pay(t.margaret, { hold_id: hold.id, payment_method: 'zelle' }))).toBe('method_not_allowed');
    expect(errorCode(() => t.service.pay(t.margaret, { hold_id: hold.id, payment_method: 'gift_card' }))).toBe('method_not_allowed');
    expect(t.service.pay(t.margaret, { hold_id: hold.id, payment_method: 'bank_transfer' }).receipt.method).toBe('bank_transfer');
  });

  it('honours a method the family blocked after the approval', () => {
    const { hold } = holdFor(SCENARIOS.utilityBill);
    t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve' });
    t.service.updatePolicy(t.sarah, { blocked_methods_all_payees: ['card'] });
    expect(errorCode(() => t.service.pay(t.margaret, { hold_id: hold.id }))).toBe('method_not_allowed');
  });
});

describe('expiry', () => {
  it('a pending hold expires after the policy window and can no longer be decided', () => {
    const { hold } = holdFor(SCENARIOS.utilityBill);
    t.clock.advance(23 * HOUR);
    expect(t.service.getHold(t.margaret, hold.id).status).toBe('pending_family');
    t.clock.advance(2 * HOUR);
    expect(t.service.getHold(t.margaret, hold.id).status).toBe('expired');
    expect(errorCode(() => t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve' }))).toBe('already_decided');
    expect(errorCode(() => t.service.pay(t.margaret, { hold_id: hold.id }))).toBe('expired');
  });

  it('an approval lapses if it is not used within the window', () => {
    const { hold } = holdFor(SCENARIOS.utilityBill);
    t.clock.advance(20 * HOUR);
    t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve' });
    t.clock.advance(20 * HOUR);
    expect(t.service.getHold(t.margaret, hold.id).status).toBe('approved');
    t.clock.advance(5 * HOUR);
    expect(errorCode(() => t.service.pay(t.margaret, { hold_id: hold.id }))).toBe('expired');
  });

  it('the sweep expires lapsed holds and announces it', () => {
    const seen: string[] = [];
    t.service.events.on('event', (event: { type: string }) => seen.push(event.type));
    holdFor(SCENARIOS.utilityBill);
    t.clock.advance(25 * HOUR);
    expect(t.service.sweepExpired()).toBe(1);
    expect(seen).toEqual(['hold.created', 'hold.expired']);
    expect(t.service.sweepExpired()).toBe(0);
  });
});

describe('policy settings', () => {
  it('reports what changed and nothing when nothing did', () => {
    expect(t.service.updatePolicy(t.sarah, { approval_threshold_usd: 250, hold_expiry_hours: 12 }).changed).toEqual(['approval_threshold_usd', 'hold_expiry_hours']);
    expect(t.service.updatePolicy(t.sarah, { approval_threshold_usd: 250 }).changed).toEqual([]);
    expect(t.service.getCircle(t.sarah).policy).toMatchObject({ approval_threshold_usd: 250, hold_expiry_hours: 12 });
  });

  it('keeps the gift card and cryptocurrency floor for official payees whatever is requested', () => {
    const { circle } = t.service.updatePolicy(t.sarah, { blocked_methods_official_payees: [], blocked_methods_all_payees: [] });
    expect(circle.policy.always_blocked_methods_official_payees).toEqual(['gift_card', 'crypto']);
    expect(t.service.checkRequest(t.margaret, { description: 'Pay my PG&E bill with gift cards', payee_name: 'PG&E', amount_usd: 20, payment_method: 'gift_card', contact_channel: 'mail' }).outcome.verdict).toBe('stop');
  });

  it('describes the circle', () => {
    expect(t.service.getCircle(t.sarah)).toMatchObject({
      name: 'Ellis family',
      members: [{ id: 'user_margaret', name: 'Margaret Ellis' }],
      contacts: [{ id: 'user_sarah', name: 'Sarah Ellis', relationship: 'daughter' }],
      policy: { approval_threshold_usd: 100, hold_expiry_hours: 24, notify_on_stop: true },
      trusted_payees: [],
    });
  });
});

describe('views', () => {
  it('gives the member a view with nothing actionable from the message, and the contact the full context', () => {
    const { hold } = holdFor(
      { ...SCENARIOS.irsGiftCards, claimed_url: 'http://irs-settlement-desk.com/pay', urgency_claims: ['arrest_or_legal_threat'] },
      'IRS agent wants $2,000 in gift cards, call back 1-888-555-0142 or irs-settlement-desk.com',
    );
    const memberView = t.service.memberHoldView(hold);
    const memberJson = JSON.stringify(memberView);
    expect(memberJson).not.toContain('555');
    expect(memberJson).not.toContain('irs-settlement-desk');
    expect(memberJson).not.toContain('/approve/');
    expect(containsActionableContact(memberView.summary)).toBe(false);
    expect(memberView.payee_name).toBe('Internal Revenue Service');

    const familyView = t.service.familyHoldView(hold, t.sarah.user_id);
    expect(familyView.untrusted_contact_details).toMatchObject({ claimed_phone: '1-888-555-0142', claimed_url: 'http://irs-settlement-desk.com/pay' });
    expect(familyView.member_words).toContain('1-888-555-0142');
    expect(familyView.approval_url).toContain(`/approve/${hold.id}`);
    expect(familyView.policy.approval_threshold_usd).toBe(100);
    expect(familyView.secrecy_requested).toBe(true);
  });
});

describe('reasons for the trusted contact', () => {
  const rules = loadRules();
  const registry = loadRegistry();
  const labels = new Set(rules.patterns.map((pattern) => pattern.label));
  const summaries = new Set(registry.payees.flatMap((payee) => [...payee.never_methods, ...payee.contact_facts].map((fact) => fact.summary)));

  it('are separate items, blocking ones first, in the words of the rules and registry files', () => {
    const { hold, outcome } = holdFor({ ...SCENARIOS.irsGiftCards, urgency_claims: ['arrest_or_legal_threat', 'pay_immediately'] });
    const reasons = t.service.familyHoldView(hold, t.sarah.user_id).reasons;

    expect(reasons.map((reason) => [reason.kind, reason.blocking, reason.text])).toEqual([
      ['scam_pattern', true, 'Asked to pay with gift cards or a prepaid card'],
      ['scam_pattern', true, 'Someone claiming to be from the government is demanding money'],
      ['scam_pattern', true, 'Told to keep the payment secret'],
      ['official_fact', true, 'The IRS never asks for or accepts gift cards for a tax bill.'],
      ['policy', true, 'Hold On never pays a government agency, utility or other official payee with gift cards.'],
      ['scam_pattern', false, 'Pressure to pay right away'],
      ['official_fact', false, expect.stringMatching(/^The phone number that was given is not one of the numbers Internal Revenue Service publishes on irs\.gov\./)],
    ]);
    // Nothing is written for the occasion: pattern labels and registry summaries are copied as they are.
    for (const reason of reasons.filter((item) => item.kind === 'scam_pattern')) expect(labels.has(reason.text), reason.text).toBe(true);
    expect(summaries.has(reasons[3]!.text)).toBe(true);
    // A policy sentence is the one the engine already recorded, and has no source to link.
    expect(outcome.policy.blocked_reasons).toContain(reasons[4]!.text);
    expect(reasons[4]!.source).toBeUndefined();
    // Every other reason carries the official page it rests on.
    expect(reasons[0]!.source).toMatchObject({ publisher: 'Federal Trade Commission', url: 'https://consumer.ftc.gov/articles/avoiding-and-reporting-gift-card-scams' });
    expect(reasons[3]!.source).toMatchObject({ publisher: 'Internal Revenue Service', url: 'https://www.irs.gov/newsroom/taxpayers-shouldnt-let-gift-card-scammers-ruin-the-holidays' });
    for (const reason of reasons.filter((item) => item.kind !== 'policy')) expect(reason.source?.url, reason.text).toMatch(/^https:\/\//);
    // Exactly the reasons that were already recorded as blocking, no more and no fewer.
    expect(reasons.filter((reason) => reason.blocking)).toHaveLength(outcome.policy.blocked_reasons.length);
  });

  it('are empty for a verified bill, and list warning signs for a request that is only held', () => {
    expect(t.service.familyHoldView(holdFor(SCENARIOS.utilityBill).hold, t.sarah.user_id).reasons).toEqual([]);
    const held = holdFor({ description: 'National Grid left a voicemail about my balance', payee_name: 'National Grid', amount_usd: 60, payment_method: 'card', contact_channel: 'phone_call', claimed_phone: '888-555-0142' });
    const reasons = t.service.familyHoldView(held.hold, t.sarah.user_id).reasons;
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatchObject({ kind: 'official_fact', blocking: false, source: { publisher: 'National Grid', url: 'https://www.nationalgridus.com/Our-Company/Scam-Alert' } });
    expect(reasons[0]!.text).not.toContain('555');
  });

  it('do not change the verdict, the stored reasons or what can be approved', () => {
    const { hold, outcome } = holdFor({ ...SCENARIOS.irsGiftCards, urgency_claims: ['arrest_or_legal_threat'] });
    const view = t.service.familyHoldView(hold, t.sarah.user_id);
    expect(view).toMatchObject({ verdict: 'stop', blocked: true, can_approve: false, blocked_reasons: outcome.policy.blocked_reasons });
    expect(view.cannot_approve_reason).toMatch(/^This request was stopped and cannot be approved\./);
    expect(errorCode(() => t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve' }))).toBe('blocked');
  });
});

describe('approval links', () => {
  const secret = 'a-test-secret-of-reasonable-length';

  it('verify for the hold and contact they were issued for', () => {
    const token = signApprovalToken(secret, 'hold_abc', 'user_sarah');
    expect(verifyApprovalToken(secret, token, 'hold_abc')).toBe('user_sarah');
  });

  it('are rejected for another hold, another secret, after tampering or after expiry', () => {
    const now = Date.now();
    const token = signApprovalToken(secret, 'hold_abc', 'user_sarah', now);
    expect(verifyApprovalToken(secret, token, 'hold_other')).toBeUndefined();
    expect(verifyApprovalToken('another-secret-entirely-000', token, 'hold_abc')).toBeUndefined();
    const [payload, signature] = token.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ h: 'hold_abc', u: 'user_margaret', e: now + 1e9 })).toString('base64url');
    expect(verifyApprovalToken(secret, `${forged}.${signature}`, 'hold_abc')).toBeUndefined();
    expect(verifyApprovalToken(secret, `${payload}.${signature.slice(0, -2)}xx`, 'hold_abc')).toBeUndefined();
    expect(verifyApprovalToken(secret, token, 'hold_abc', now + 8 * 24 * HOUR)).toBeUndefined();
    expect(verifyApprovalToken(secret, undefined, 'hold_abc')).toBeUndefined();
    expect(verifyApprovalToken(secret, 'garbage', 'hold_abc')).toBeUndefined();
  });
});
