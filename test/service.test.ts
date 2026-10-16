import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { signApprovalToken, verifyApprovalToken } from '../src/approval.js';
import { loadRegistry } from '../src/domain/registry.js';
import { loadRules } from '../src/domain/rules.js';
import { containsActionableContact } from '../src/domain/text.js';
import { HoldOnError, HoldOnService, hashToken } from '../src/service.js';
import { Store } from '../src/store/db.js';
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

/** The code and the sentence of a refusal; fails the test if the action went through. */
function refusal(action: () => unknown): { code: string; message: string } {
  try {
    action();
  } catch (error) {
    if (error instanceof HoldOnError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('Expected Hold On to refuse, but it went ahead.');
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

  it('are remembered by their own name in any script, so one vouch does not cover every name', () => {
    const work = { description: 'Payment for the garden work', amount_usd: 500, payment_method: 'check', contact_channel: 'in_person' } as const;
    const { hold } = holdFor({ ...work, payee_name: '김철수' });
    t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve', trust_payee: true });
    for (const payee_name of ['이영희', '国税局', 'Иван']) {
      const { check_id, outcome } = t.service.checkRequest(t.margaret, { ...work, payee_name, amount_usd: 50 });
      expect(outcome.payee.status, payee_name).toBe('not_in_registry');
      expect(outcome.next_step, payee_name).toBe('place_hold');
      expect(errorCode(() => t.service.pay(t.margaret, { check_id })), payee_name).toBe('not_approved');
    }
    const same = t.service.checkRequest(t.margaret, { ...work, payee_name: '김철수', amount_usd: 50 });
    expect(same.outcome).toMatchObject({ verdict: 'verified', next_step: 'pay', payee: { status: 'family_trusted' } });
    expect(t.service.pay(t.margaret, { check_id: same.check_id }).receipt.payee).toBe('김철수');
  });

  it('cannot be vouched for when the name has no letters or numbers', () => {
    const { hold } = holdFor({ description: 'Pay the man who came to the door', payee_name: '???', amount_usd: 50, payment_method: 'check', contact_channel: 'in_person' });
    const view = t.service.familyHoldView(hold, t.sarah.user_id);
    expect(view).toMatchObject({ can_approve: false, requires_trust_payee: false });
    expect(view.cannot_approve_reason).toMatch(/no letters or numbers/);
    expect(errorCode(() => t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve', trust_payee: true }))).toBe('blocked');
    expect(t.service.circleView('circle_ellis').trusted_payees).toEqual([]);
  });

  it("are paid only under a list entry whose own name is the hold's payee", () => {
    // A row whose key does not belong to its name, as an older, looser key could leave behind.
    t.store.addTrustedPayee('circle_ellis', { name: '김철수', normalized_name: '이영희', added_by: 'Sarah Ellis', added_at: '2026-10-01T00:00:00.000Z' });
    const { hold, outcome } = holdFor({ description: 'Payment for the garden work', payee_name: '이영희', amount_usd: 500, payment_method: 'check', contact_channel: 'in_person' });
    expect(outcome.payee.status).toBe('not_in_registry');
    // The vouch cannot be recorded over the stale row, so nothing confirms this payee and nothing is paid.
    expect(t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve', trust_payee: true }).trustedPayeeAdded).toBe(false);
    expect(errorCode(() => t.service.pay(t.margaret, { hold_id: hold.id }))).toBe('payee_not_verified');
  });

  it('are re-keyed when a database written with the old Latin-only key is opened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'holdon-rekey-'));
    try {
      const path = join(dir, 'holdon.db');
      const before = new Store(path);
      before.upsertCircle({ id: 'circle_x', name: 'X', policy: t.service.circleView('circle_ellis').policy }, '2026-10-01T00:00:00.000Z');
      const row = { added_by: 'Sarah Ellis', added_at: '2026-10-01T00:00:00.000Z' };
      before.addTrustedPayee('circle_x', { ...row, name: '김철수', normalized_name: '' });
      before.addTrustedPayee('circle_x', { ...row, name: 'Café Roma', normalized_name: 'caf roma' });
      before.addTrustedPayee('circle_x', { ...row, name: 'Greenleaf Roofing', normalized_name: 'greenleaf roofing' });
      before.close();
      const after = new Store(path);
      expect(after.listTrustedPayees('circle_x').map((p) => [p.name, p.normalized_name])).toEqual([
        ['Café Roma', 'café roma'],
        ['Greenleaf Roofing', 'greenleaf roofing'],
        ['김철수', '김철수'],
      ]);
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never put a phone number from the payee name on the receipt or in what is said', () => {
    const { hold } = holdFor({ description: 'The roofer wants a deposit', payee_name: 'Greenleaf Roofing 888-555-0142', amount_usd: 500, payment_method: 'check', contact_channel: 'in_person' });
    t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve', trust_payee: true });
    const { receipt } = t.service.pay(t.margaret, { hold_id: hold.id });
    expect(receipt.payee).toBe('Greenleaf Roofing [phone number removed]');
    expect(t.service.paidMessage(receipt)).not.toContain('555');
    expect(JSON.stringify(t.service.memberHoldView(t.store.getHold(hold.id)!))).not.toContain('555');
  });

  it('never say a number or link from a vouched-for name on later checks, lookups or receipts', () => {
    for (const payee_name of ['Greenleaf Roofing 212-555-0199', 'Bob Plumbing greenleaf.store']) {
      const { hold } = holdFor({ description: 'The job deposit', payee_name, amount_usd: 500, payment_method: 'check', contact_channel: 'in_person' });
      t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve', trust_payee: true });

      const { check_id, outcome } = t.service.checkRequest(t.margaret, { description: 'deposit', payee_name, amount_usd: 50, payment_method: 'check' });
      expect(outcome).toMatchObject({ verdict: 'verified', next_step: 'pay', payee: { status: 'family_trusted' } });
      const looked = t.service.verifyPayee(t.margaret, { name: payee_name });
      expect(looked.status).toBe('family_trusted');
      const { receipt } = t.service.pay(t.margaret, { check_id });
      for (const shown of [JSON.stringify(outcome), JSON.stringify(looked), JSON.stringify(t.service.receiptView(receipt)), t.service.paidMessage(receipt)]) {
        expect(shown, payee_name).not.toMatch(/555|greenleaf\.store/);
      }
    }
    const said = t.service.checkRequest(t.margaret, { description: 'deposit', payee_name: 'Greenleaf Roofing 212-555-0199', amount_usd: 50, payment_method: 'check' }).outcome.say_to_user;
    expect(said).toMatch(/^Greenleaf Roofing \[phone number removed\] is a payee your family has already confirmed\./);
    expect(t.service.verifyPayee(t.margaret, { name: 'Bob Plumbing greenleaf.store' }).say_to_user).toBe(
      'Bob Plumbing [link removed] is not in the official registry, but Sarah Ellis has confirmed this payee for the family.',
    );
  });

  it('never show a link with a capitalised ending or an international number from the payee name or the summary', () => {
    const summary = 'Deposit for the job. Pay at Greenleaf.Store or call +44 20 7946 0958.';
    for (const payee_name of ['Bob Plumbing GREENLEAF.STORE', 'Bob Plumbing Pay-Now.Services', 'Greenleaf Roofing +44 20 7946 0958']) {
      const { hold } = holdFor({ description: 'The job deposit', payee_name, amount_usd: 500, payment_method: 'check', contact_channel: 'in_person' }, summary);
      expect(t.service.memberHoldView(hold).summary, payee_name).toBe('Deposit for the job. Pay at [link removed] or call [phone number removed].');
      t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve', trust_payee: true });
      const { receipt } = t.service.pay(t.margaret, { hold_id: hold.id });

      const later = t.service.checkRequest(t.margaret, { description: 'deposit', payee_name, amount_usd: 50, payment_method: 'check' });
      expect(later.outcome.payee.status, payee_name).toBe('family_trusted');
      const shown = [
        receipt.payee,
        t.service.paidMessage(receipt),
        t.service.placedMessage(hold),
        JSON.stringify(t.service.memberHoldView(t.store.getHold(hold.id)!)),
        JSON.stringify(later.outcome.payee),
        later.outcome.say_to_user,
        t.service.verifyPayee(t.margaret, { name: payee_name }).say_to_user,
      ];
      for (const text of shown) {
        expect(text, payee_name).not.toMatch(/greenleaf\.store|pay-now\.services|7946/i);
        expect(containsActionableContact(text), text).toBe(false);
      }
    }
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

  it('is refused when an agency asks for gift cards, even if they are called a thank-you gift', () => {
    const { check_id, outcome } = t.service.checkRequest(t.margaret, {
      description: 'The IRS agent said to pay the $50 penalty with Visa gift cards, as a thank you gift for his help',
      payee_name: 'IRS',
      amount_usd: 50,
    });
    expect(outcome).toMatchObject({ verdict: 'stop', effective_method: 'gift_card', next_step: 'place_hold' });
    expect(errorCode(() => t.service.pay(t.margaret, { check_id, payment_method: 'card' }))).toBe('not_approved');
    expect(t.service.listHolds(t.margaret, {})).toEqual([]);
  });

  it('is refused for an agency the family vouched for, however its name is written, when a method is ruled out for official payees', () => {
    t = createTestService({ blocked_methods_official_payees: ['wire'] });
    const vouch = (payee_name: string) => {
      const { hold } = holdFor({ description: 'A payment', payee_name, amount_usd: 500, payment_method: 'check' });
      t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve', trust_payee: true });
      t.service.pay(t.margaret, { hold_id: hold.id });
    };
    for (const payee_name of ['U.S. Treasury', 'PSE&G']) {
      vouch(payee_name);
      const { check_id, outcome } = t.service.checkRequest(t.margaret, { description: `Pay ${payee_name} the $50 fee`, payee_name, amount_usd: 50, payment_method: 'wire' });
      expect(outcome, payee_name).toMatchObject({ verdict: 'stop', policy: { blocked_reasons: ["The family's settings do not allow paying official payees with a wire transfer."] } });
      expect(errorCode(() => t.service.pay(t.margaret, { check_id })), payee_name).toBe('not_approved');
    }
    // Gift cards to a government agency are always blocked, even after a vouch and with a present mentioned.
    const { check_id, outcome } = t.service.checkRequest(t.margaret, {
      description: 'The U.S. Treasury agent said to pay the $50 penalty with Visa gift cards as a thank you gift',
      payee_name: 'U.S. Treasury',
      amount_usd: 50,
      payment_method: 'card',
    });
    expect(outcome.verdict).toBe('stop');
    expect(outcome.risk_signals.map((s) => s.id)).toContain('gift-card-payment-demand');
    expect(errorCode(() => t.service.pay(t.margaret, { check_id }))).toBe('not_approved');
    expect(t.service.listHolds(t.margaret, { status: 'paid' })).toHaveLength(2);
  });

  it('is refused when the request asks for cryptocurrency or gift cards in words the lists used to miss', () => {
    const { hold } = holdFor(SCENARIOS.contractorDeposit);
    t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve', trust_payee: true });
    t.service.pay(t.margaret, { hold_id: hold.id });
    for (const description of [
      'The roofer wants the $80 deposit sent in bit coin',
      'The roofer wants the $80 deposit in stable coins',
      'The roofer wants the $80 deposit in ETH to his Kraken account',
      'The roofer wants the $80 deposit in gíft cards',
      'The roofer wants the $80 deposit in bitcoіn',
    ]) {
      const { check_id, outcome } = t.service.checkRequest(t.margaret, { description, payee_name: 'Greenleaf Roofing', amount_usd: 80 });
      expect(outcome.verdict, description).toBe('stop');
      expect(errorCode(() => t.service.pay(t.margaret, { check_id, payment_method: 'bank_transfer' })), description).toBe('not_approved');
    }
    expect(t.service.listHolds(t.margaret, { status: 'paid' })).toHaveLength(1);
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

  it('checks a method first given at pay time as a check would, for agencies and utilities outside the registry too', () => {
    const cases = [
      { description: 'Pay the Maple County Tax Office $150', payee_name: 'Maple County Tax Office', method: 'crypto' },
      { description: 'Pay the Springfield water bill', payee_name: 'Springfield Water Utility', method: 'gift_card' },
    ] as const;
    for (const { description, payee_name, method } of cases) {
      const { hold } = holdFor({ description, payee_name, amount_usd: 150, contact_channel: 'mail' });
      expect(hold.payment_method).toBe('unknown');
      t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve', trust_payee: true });
      expect(errorCode(() => t.service.pay(t.margaret, { hold_id: hold.id, payment_method: method }))).toBe('method_not_allowed');
      expect(t.service.store.getHold(hold.id)?.status).toBe('approved');
      expect(t.service.pay(t.margaret, { hold_id: hold.id, payment_method: 'check' }).receipt.method).toBe('check');
    }
  });

  it('refuses a gift card given at pay time to a payee the family vouched for', () => {
    const { hold } = holdFor({ description: 'The roofer wants a deposit', payee_name: 'Greenleaf Roofing', amount_usd: 500, contact_channel: 'in_person' });
    t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve', trust_payee: true });
    expect(errorCode(() => t.service.pay(t.margaret, { hold_id: hold.id, payment_method: 'gift_card' }))).toBe('method_not_allowed');
  });

  it('honours a method the family blocked after the approval', () => {
    const { hold } = holdFor(SCENARIOS.utilityBill);
    t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve' });
    t.service.updatePolicy(t.sarah, { blocked_methods_all_payees: ['card'] });
    // The card was the approved method, not one chosen now, so the settings changed under the approval: blocked.
    expect(refusal(() => t.service.pay(t.margaret, { hold_id: hold.id }))).toEqual({
      code: 'blocked',
      message: "I can't make this payment to Con Edison now. Your family's settings don't allow payments by a credit or debit card. Nothing has been paid.",
    });
  });

  it('says why in plain words: the method, one reason, and that nothing was paid', () => {
    const coned = holdFor({ description: 'Con Edison bill from the mail', payee_name: 'Con Edison', amount_usd: 150, contact_channel: 'mail' }).hold;
    t.service.familyDecide(t.sarah, { hold_id: coned.id, decision: 'approve' });
    // The floor is a policy sentence, so it comes first.
    expect(refusal(() => t.service.pay(t.margaret, { hold_id: coned.id, payment_method: 'gift_card' }))).toEqual({
      code: 'method_not_allowed',
      message: "I can't pay Con Edison with gift cards. Hold On never pays a government agency or utility with gift cards. Nothing has been paid.",
    });
    // No policy sentence: the registry's own fact.
    expect(refusal(() => t.service.pay(t.margaret, { hold_id: coned.id, payment_method: 'zelle' })).message).toBe(
      "I can't pay Con Edison with Zelle. Con Edison does not accept prepaid gift cards, cryptocurrency, wire transfers, or cash apps such as Venmo, Zelle or PayPal. Nothing has been paid.",
    );

    // A payee the family vouched for: the pattern's own words for the person, and the payee is never called official.
    const roofer = holdFor({ description: 'The roofer wants a deposit', payee_name: 'Greenleaf Roofing', amount_usd: 500, contact_channel: 'in_person' }).hold;
    t.service.familyDecide(t.sarah, { hold_id: roofer.id, decision: 'approve', trust_payee: true });
    const giftCards = refusal(() => t.service.pay(t.margaret, { hold_id: roofer.id, payment_method: 'gift_card' }));
    expect(giftCards).toEqual({
      code: 'method_not_allowed',
      message: "I can't pay Greenleaf Roofing with gift cards. Gift cards are for gifts. Real businesses and government agencies do not ask to be paid with them. Nothing has been paid.",
    });
    // An agency outside the registry is described by what the request says, not as an official payee.
    const office = holdFor({ description: 'Pay the Maple County Tax Office $150', payee_name: 'Maple County Tax Office', amount_usd: 150, contact_channel: 'mail' }).hold;
    t.service.familyDecide(t.sarah, { hold_id: office.id, decision: 'approve', trust_payee: true });
    const crypto = refusal(() => t.service.pay(t.margaret, { hold_id: office.id, payment_method: 'crypto' }));
    expect(crypto.message).toBe(
      "I can't pay Maple County Tax Office with cryptocurrency. This request mentions a government agency or utility, and Hold On never pays one with cryptocurrency. Nothing has been paid.",
    );
    for (const { message } of [giftCards, crypto]) {
      expect(message).not.toMatch(/known scam pattern|official/i);
      expect(message).not.toMatch(/!/);
    }
  });

  it('refuses with blocked, not method_not_allowed, when the rules changed after the approval', () => {
    const { hold } = holdFor({ description: 'Con Edison bill from the mail', payee_name: 'Con Edison', amount_usd: 150, contact_channel: 'mail' });
    t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve' });
    // A later rules file now reads these very words as a demand for secrecy, whatever the method.
    const rules = structuredClone(loadRules());
    rules.lexicons.secrecy!.push('bill from the mail');
    const later = new HoldOnService({ store: t.store, registry: loadRegistry(), rules, clock: () => t.clock.now });
    expect(refusal(() => later.pay(t.margaret, { hold_id: hold.id, payment_method: 'bank_transfer' }))).toEqual({
      code: 'blocked',
      message:
        "I can't make this payment to Con Edison now. Being told not to tell family or friends is a strong warning sign. Honest requests can be talked over with someone you trust. Nothing has been paid.",
    });
    expect(t.store.getHold(hold.id)?.status).toBe('approved');
  });

  it('asks how the payment was requested, rather than suggesting a method', () => {
    const { hold } = holdFor({ description: 'Con Edison bill from the mail', payee_name: 'Con Edison', amount_usd: 150, contact_channel: 'mail' });
    t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve' });
    const { code, message } = refusal(() => t.service.pay(t.margaret, { hold_id: hold.id }));
    expect(code).toBe('method_required');
    expect(message).toMatch(/how you were asked to pay/);
    expect(message).toMatch(/Nothing has been paid\./);
    expect(message).not.toMatch(/\bcard\b|bank_transfer|\bcheck\b/);
  });

  it('refuses another method when the request mentioned gift cards and no method was given until now', () => {
    // A gift card for a birthday is not a demand for gift cards, so the check holds it for the family as an unknown payee.
    const { hold, outcome } = holdFor({ description: "Buy a $50 Amazon gift card for my granddaughter's birthday", payee_name: 'Amazon', amount_usd: 50 });
    expect(outcome).toMatchObject({ verdict: 'unknown', effective_method: 'unknown' });
    t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve', trust_payee: true });
    // The card is not the problem, so the sentence does not open with it; it never says "check" or "asked", which fit
    // neither a present she chose herself nor a payment by paper check.
    const said = "I can't make this payment yet. Because it mentions gift cards, I need to look at it again together with how you'll be paying. Nothing has been paid.";
    expect(refusal(() => t.service.pay(t.margaret, { hold_id: hold.id, payment_method: 'card' }))).toEqual({ code: 'method_not_allowed', message: said });
    expect(refusal(() => t.service.pay(t.margaret, { hold_id: hold.id, payment_method: 'check' })).message).toBe(said);
    expect(said).not.toMatch(/\bcheck\b|\basked\b|credit or debit/);
    expect(errorCode(() => t.service.pay(t.margaret, { hold_id: hold.id, payment_method: 'gift_card' }))).toBe('method_not_allowed');

    // The same on the check_id path, now that Amazon is a confirmed payee and the amount is under the limit.
    const next = t.service.checkRequest(t.margaret, { description: "Buy a $40 Amazon gift card for my grandson's birthday", payee_name: 'Amazon', amount_usd: 40 });
    expect(next.outcome.next_step).toBe('pay');
    expect(errorCode(() => t.service.pay(t.margaret, { check_id: next.check_id, payment_method: 'card' }))).toBe('method_not_allowed');
    // Stating the method in the check is the way through: the rules and the family see both.
    const stated = t.service.checkRequest(t.margaret, { description: "Buy a $40 Amazon gift card for my grandson's birthday", payee_name: 'Amazon', amount_usd: 40, payment_method: 'card' });
    expect(t.service.pay(t.margaret, { check_id: stated.check_id }).receipt).toMatchObject({ payee: 'Amazon', method: 'card' });
  });

  it('refuses a wire to an agency outside the registry when the family blocked wires to official payees', () => {
    t = createTestService({ blocked_methods_official_payees: ['wire'] });
    const { hold } = holdFor({ description: 'My car registration renewal from the Department of Motor Vehicles', payee_name: 'Department of Motor Vehicles', amount_usd: 60, contact_channel: 'mail' });
    t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve', trust_payee: true });
    expect(refusal(() => t.service.pay(t.margaret, { hold_id: hold.id, payment_method: 'wire' }))).toEqual({
      code: 'method_not_allowed',
      message:
        "I can't pay Department of Motor Vehicles with a wire transfer. This request mentions a government agency or utility, and your family's settings don't allow paying one with a wire transfer. Nothing has been paid.",
    });
    expect(t.service.pay(t.margaret, { hold_id: hold.id, payment_method: 'check' }).receipt.method).toBe('check');
  });

  it('lets the family approve and pay a wire to a payee that only has an agency word near it, when wires to official payees are blocked', () => {
    t = createTestService({ blocked_methods_official_payees: ['wire'] });
    const cases = [
      { description: 'Pay DMV Roofing for the gutter repair', payee_name: 'DMV Roofing' },
      { description: 'A new generator from Rural Electric Supply', payee_name: 'Rural Electric Supply' },
      { description: 'Pay the deck contractor my son at the State Police recommended', payee_name: 'Smith Decks' },
    ];
    for (const words of cases) {
      const { outcome, hold } = holdFor({ ...words, amount_usd: 60, payment_method: 'wire', contact_channel: 'in_person' });
      expect(outcome.verdict, words.payee_name).toBe('unknown');
      expect(t.service.familyHoldView(hold, t.sarah.user_id), words.payee_name).toMatchObject({ can_approve: true, requires_trust_payee: true });
      t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve', trust_payee: true });
      expect(t.service.pay(t.margaret, { hold_id: hold.id }).receipt, words.payee_name).toMatchObject({ payee: words.payee_name, method: 'wire' });
    }
  });
});

describe('paying a check that already has a hold', () => {
  it('does not pay a check whose hold the family denied, and takes back the vouch that came with the approval', () => {
    const { check_id, hold } = holdFor({ ...SCENARIOS.contractorDeposit, amount_usd: 80 });
    expect(t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve', trust_payee: true }).trustedPayeeAdded).toBe(true);
    const denied = t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'deny' });

    expect(errorCode(() => t.service.pay(t.margaret, { hold_id: hold.id }))).toBe('denied');
    expect(refusal(() => t.service.pay(t.margaret, { check_id }))).toEqual({ code: 'denied', message: 'Sarah Ellis asked that this not be paid, so it will not be. Nothing has been paid.' });
    expect(t.service.listHolds(t.margaret, { status: 'paid' })).toEqual([]);

    expect(denied.trustedPayeeRemoved).toBe(true);
    expect(t.service.decisionMessage(denied.hold, 'deny', false, denied.trustedPayeeRemoved)).toContain('Greenleaf Roofing is no longer a confirmed payee for the family.');
    expect(t.service.circleView('circle_ellis').trusted_payees).toEqual([]);
    expect(t.service.checkRequest(t.margaret, { ...SCENARIOS.contractorDeposit, amount_usd: 80 }).outcome.payee.status).toBe('not_in_registry');
  });

  it('does not pay a check whose hold was cancelled or ran out', () => {
    const medicare = { description: 'Medicare premium bill from the mail', payee_name: 'Medicare', amount_usd: 85, payment_method: 'bank_transfer', contact_channel: 'mail' } as const;
    const cancelled = holdFor(medicare);
    t.service.cancelHold(t.margaret, cancelled.hold.id);
    expect(errorCode(() => t.service.pay(t.margaret, { check_id: cancelled.check_id }))).toBe('cancelled');

    const lapsed = holdFor(medicare);
    t.clock.advance(25 * HOUR);
    expect(t.service.sweepExpired()).toBe(1);
    expect(errorCode(() => t.service.pay(t.margaret, { check_id: lapsed.check_id }))).toBe('expired');
    expect(t.service.listHolds(t.margaret, { status: 'paid' })).toEqual([]);
  });

  it('only takes back a vouch that the withdrawn approval itself added', () => {
    const first = holdFor(SCENARIOS.contractorDeposit);
    t.service.familyDecide(t.sarah, { hold_id: first.hold.id, decision: 'approve', trust_payee: true });
    t.service.pay(t.margaret, { hold_id: first.hold.id });
    const second = holdFor({ ...SCENARIOS.contractorDeposit, description: 'The roofer wants the final payment' });
    expect(t.service.familyDecide(t.sarah, { hold_id: second.hold.id, decision: 'approve' }).trustedPayeeAdded).toBe(false);
    expect(t.service.familyDecide(t.sarah, { hold_id: second.hold.id, decision: 'deny' }).trustedPayeeRemoved).toBe(false);
    expect(t.service.circleView('circle_ellis').trusted_payees.map((p) => p.name)).toEqual(['Greenleaf Roofing']);
  });

  it('leaves nothing behind when a payment the family settings allow is refused, and says the settings allowed it', () => {
    const { check_id, outcome } = t.service.checkRequest(t.margaret, { description: 'Medicare premium bill from the mail', payee_name: 'Medicare', amount_usd: 85, contact_channel: 'mail' });
    expect(outcome.next_step).toBe('pay');
    expect(errorCode(() => t.service.pay(t.margaret, { check_id, payment_method: 'gift_card' }))).toBe('method_not_allowed');
    expect(errorCode(() => t.service.pay(t.margaret, { check_id }))).toBe('method_required');
    expect(t.service.listHolds(t.margaret, {})).toEqual([]);

    const { hold } = t.service.pay(t.margaret, { check_id, payment_method: 'check' });
    expect(t.service.listHolds(t.margaret, {}).map((h) => h.status)).toEqual(['paid']);
    expect(t.service.memberHoldView(hold).decision?.by).toBe('Family policy');

    // A hold an earlier version left approved by the settings is described as such, not as Sarah's answer.
    const earlier = t.service.checkRequest(t.margaret, { description: 'Medicare premium bill from the mail', payee_name: 'Medicare', amount_usd: 85, contact_channel: 'mail' });
    t.store.insertHold({ ...hold, id: 'hold_left_by_policy', check_id: earlier.check_id, status: 'approved', payment_method: 'unknown', receipt_id: undefined });
    const say = t.service.memberHoldView(t.store.getHold('hold_left_by_policy')!).say_to_user;
    expect(say).toBe("Your family's settings allow the $85 payment to Medicare without asking anyone first. I can make the payment whenever you're ready.");
    expect(say).not.toMatch(/Sarah/);
  });

  it('lets a later "no" stand over an earlier "yes" for the same check, by check_id and by hold_id', () => {
    const c = t.service.checkRequest(t.margaret, SCENARIOS.contractorDeposit);
    const a = t.service.placeHold(t.margaret, { check_id: c.check_id, summary: 'Roofing deposit' });
    t.service.familyDecide(t.sarah, { hold_id: a.hold.id, decision: 'approve', trust_payee: true });
    t.clock.advance(60_000);
    // Placing it again returns the approved hold, not a second hold the family could answer differently.
    const b = t.service.placeHold(t.margaret, { check_id: c.check_id, summary: 'Roofing deposit' });
    expect(b).toMatchObject({ reused: true, hold: { id: a.hold.id, status: 'approved' } });
    expect(t.service.placedMessage(b.hold)).toBe("Sarah said yes to the $1,500 payment to Greenleaf Roofing. I can make the payment whenever you're ready.");
    expect(t.service.memberHoldView(b.hold).next_step).toBe('pay');

    t.clock.advance(60_000);
    const d = t.service.familyDecide(t.sarah, { hold_id: b.hold.id, decision: 'deny' });
    // What Sarah is told is true on every path.
    expect(t.service.decisionMessage(d.hold, 'deny', false, d.trustedPayeeRemoved)).toMatch(/^Denied\. The \$1,500 payment to Greenleaf Roofing will not be made/);
    expect(errorCode(() => t.service.pay(t.margaret, { check_id: c.check_id }))).toBe('denied');
    expect(errorCode(() => t.service.pay(t.margaret, { hold_id: a.hold.id }))).toBe('denied');
    expect(t.service.listHolds(t.margaret, { status: 'paid' })).toEqual([]);
  });

  it('withdraws an approval of the same check that an earlier version left beside a newer hold, and its vouch', () => {
    const c = t.service.checkRequest(t.margaret, SCENARIOS.contractorDeposit);
    const a = t.service.placeHold(t.margaret, { check_id: c.check_id, summary: 'Roofing deposit' }).hold;
    t.service.familyDecide(t.sarah, { hold_id: a.id, decision: 'approve', trust_payee: true });
    // An earlier version placed a second hold for the same check beside the approved one.
    t.clock.advance(60_000);
    const now = t.clock.now.toISOString();
    const second = { ...a, id: 'hold_second', status: 'pending_family' as const, created_at: now, updated_at: now };
    t.store.insertHold({ ...second, decision_by: undefined, decision_by_name: undefined, decision_at: undefined, decision_note: undefined });

    const d = t.service.familyDecide(t.sarah, { hold_id: 'hold_second', decision: 'deny', note: 'Not this one, Mom.' });
    expect(d.trustedPayeeRemoved).toBe(true);
    // The withdrawn approval gets its own note, not the words Sarah wrote about the other hold.
    expect(t.store.getHold(a.id)).toMatchObject({ status: 'denied', decision_by_name: 'Sarah Ellis', decision_note: 'This approval was withdrawn because a later payment to the same payee was turned down.' });
    expect(errorCode(() => t.service.pay(t.margaret, { hold_id: a.id }))).toBe('denied');
    expect(errorCode(() => t.service.pay(t.margaret, { check_id: c.check_id }))).toBe('denied');
    expect(t.service.circleView('circle_ellis').trusted_payees).toEqual([]);
  });

  it('pays a check placed on hold again after a denial once the family approves the new hold', () => {
    const c = t.service.checkRequest(t.margaret, SCENARIOS.contractorDeposit);
    const first = t.service.placeHold(t.margaret, { check_id: c.check_id, summary: 'Roofing deposit' }).hold;
    t.service.familyDecide(t.sarah, { hold_id: first.id, decision: 'deny' });
    t.clock.advance(60_000);
    const again = t.service.placeHold(t.margaret, { check_id: c.check_id, summary: 'Roofing deposit, after a call' });
    expect(again.reused).toBe(false);
    expect(errorCode(() => t.service.pay(t.margaret, { check_id: c.check_id }))).toBe('not_approved');
    t.service.familyDecide(t.sarah, { hold_id: again.hold.id, decision: 'approve', trust_payee: true });
    expect(t.service.pay(t.margaret, { check_id: c.check_id }).hold.id).toBe(again.hold.id);
  });

  it('returns the paid hold, not a new one, when a paid check is placed on hold again', () => {
    const { check_id, hold } = holdFor(SCENARIOS.utilityBill);
    t.service.familyDecide(t.sarah, { hold_id: hold.id, decision: 'approve' });
    t.service.pay(t.margaret, { hold_id: hold.id });
    const again = t.service.placeHold(t.margaret, { check_id, summary: 'Electric bill' });
    expect(again).toMatchObject({ reused: true, hold: { id: hold.id, status: 'paid' } });
    expect(t.service.familyInbox(t.sarah, {})).toEqual([]);
    expect(t.service.placedMessage(again.hold)).toMatch(/^The \$182\.40 payment to Con Edison has been made\./);
  });
});

describe('a denial is not undone by asking again', () => {
  it('sends a fresh check for the same registry payee to the family, under the limit too, until the hold window has passed', () => {
    const input = { description: 'My Con Edison electric bill came in the mail and I would like to pay it.', payee_name: 'Con Edison', amount_usd: 50, payment_method: 'card', contact_channel: 'mail' } as const;
    const first = holdFor(input);
    t.service.familyDecide(t.sarah, { hold_id: first.hold.id, decision: 'deny' });
    expect(errorCode(() => t.service.pay(t.margaret, { check_id: first.check_id }))).toBe('denied');

    const again = t.service.checkRequest(t.margaret, input);
    expect(again.outcome).toMatchObject({ verdict: 'verified', next_step: 'place_hold' });
    expect(again.outcome.say_to_user).toBe(
      'Con Edison is on my list of official payees. A recent payment to them was turned down, so Sarah gets a quick request to approve this one first. Nothing is paid until then.',
    );
    expect(errorCode(() => t.service.pay(t.margaret, { check_id: again.check_id }))).toBe('not_approved');
    expect(t.service.listHolds(t.margaret, { status: 'paid' })).toEqual([]);

    t.clock.advance(25 * HOUR);
    const later = t.service.checkRequest(t.margaret, input);
    expect(t.service.pay(t.margaret, { check_id: later.check_id }).receipt).toMatchObject({ payee: 'Con Edison', method: 'card' });
  });

  it('does the same for a payee the family vouched for earlier, and for a denied amount asked for in smaller pieces', () => {
    const vouched = holdFor(SCENARIOS.contractorDeposit);
    t.service.familyDecide(t.sarah, { hold_id: vouched.hold.id, decision: 'approve', trust_payee: true });
    t.service.pay(t.margaret, { hold_id: vouched.hold.id });
    const big = holdFor({ ...SCENARIOS.contractorDeposit, description: 'The roofer wants another $1,500' });
    t.service.familyDecide(t.sarah, { hold_id: big.hold.id, decision: 'deny' });

    for (const amount_usd of [80, 90]) {
      const { check_id, outcome } = t.service.checkRequest(t.margaret, { ...SCENARIOS.contractorDeposit, amount_usd });
      expect(outcome).toMatchObject({ verdict: 'verified', next_step: 'place_hold', payee: { status: 'family_trusted' } });
      expect(errorCode(() => t.service.pay(t.margaret, { check_id }))).toBe('not_approved');
    }
    expect(t.service.listHolds(t.margaret, { status: 'paid' })).toHaveLength(1);
  });

  it('withdraws an earlier approval of the same payment checked twice, by name or by registry entry, and says so', () => {
    const cases = [
      { input: SCENARIOS.contractorDeposit, payee: 'Greenleaf Roofing', amount: '$1,500', vouched: true },
      { input: SCENARIOS.utilityBill, payee: 'Con Edison', amount: '$182.40', vouched: false },
    ];
    for (const { input, payee, amount, vouched } of cases) {
      const c1 = t.service.checkRequest(t.margaret, input);
      const a = t.service.placeHold(t.margaret, { check_id: c1.check_id, summary: 'Please take a look' }).hold;
      t.service.familyDecide(t.sarah, { hold_id: a.id, decision: 'approve', trust_payee: vouched });
      t.clock.advance(HOUR);
      const c2 = t.service.checkRequest(t.margaret, input);
      const b = t.service.placeHold(t.margaret, { check_id: c2.check_id, summary: 'Please take a look' }).hold;
      expect(b.id, payee).not.toBe(a.id);

      const denied = t.service.familyDecide(t.sarah, { hold_id: b.id, decision: 'deny' });
      expect(denied, payee).toMatchObject({ approvalsWithdrawn: 1, trustedPayeeRemoved: vouched });
      expect(t.service.decisionMessage(denied.hold, 'deny', denied.trustedPayeeAdded, denied.trustedPayeeRemoved, denied.approvalsWithdrawn)).toBe(
        `Denied. The ${amount} payment to ${payee} will not be made, and Margaret will be told. An earlier approval of a payment to ${payee} is withdrawn too.` +
          (vouched ? ` ${payee} is no longer a confirmed payee for the family.` : '') +
          ' A short call to talk it through can help.',
      );
      expect(t.store.getHold(a.id), payee).toMatchObject({ status: 'denied', decision_by_name: 'Sarah Ellis' });
      expect(t.service.memberHoldView(t.store.getHold(a.id)!).next_step).toBe('none');
      for (const route of [{ hold_id: a.id }, { check_id: c1.check_id }, { hold_id: b.id }, { check_id: c2.check_id }]) {
        expect(errorCode(() => t.service.pay(t.margaret, route)), `${payee} ${JSON.stringify(route)}`).toBe('denied');
      }
    }
    expect(t.service.listHolds(t.margaret, { status: 'paid' })).toEqual([]);
    expect(t.service.circleView('circle_ellis').trusted_payees).toEqual([]);
  });

  it('leaves approvals for other payees, and paid ones, alone', () => {
    const bill = holdFor(SCENARIOS.utilityBill);
    t.service.familyDecide(t.sarah, { hold_id: bill.hold.id, decision: 'approve' });
    const paid = holdFor(SCENARIOS.contractorDeposit);
    t.service.familyDecide(t.sarah, { hold_id: paid.hold.id, decision: 'approve', trust_payee: true });
    t.service.pay(t.margaret, { hold_id: paid.hold.id });
    t.clock.advance(HOUR);
    const again = holdFor(SCENARIOS.contractorDeposit);
    const denied = t.service.familyDecide(t.sarah, { hold_id: again.hold.id, decision: 'deny' });
    expect(denied).toMatchObject({ approvalsWithdrawn: 0, trustedPayeeRemoved: false });
    expect(t.service.decisionMessage(denied.hold, 'deny', false, false, denied.approvalsWithdrawn)).not.toMatch(/withdrawn/);
    expect(t.service.pay(t.margaret, { hold_id: bill.hold.id }).receipt.payee).toBe('Con Edison');
    expect(t.service.circleView('circle_ellis').trusted_payees.map((p) => p.name)).toEqual(['Greenleaf Roofing']);
  });

  it('does not pay an approval that a later "no" to the same payee outweighs, but pays one given after the "no"', () => {
    const first = holdFor(SCENARIOS.contractorDeposit);
    t.service.familyDecide(t.sarah, { hold_id: first.hold.id, decision: 'approve', trust_payee: true });
    t.clock.advance(HOUR);
    // An earlier version recorded a later "no" to the same payee, on another check, without withdrawing this approval.
    const other = t.service.checkRequest(t.margaret, SCENARIOS.contractorDeposit);
    const now = t.clock.now.toISOString();
    t.store.insertHold({ ...first.hold, id: 'hold_denied_later', check_id: other.check_id, status: 'denied', decision_by: t.sarah.user_id, decision_by_name: 'Sarah Ellis', decision_at: now, created_at: now, updated_at: now });

    expect(refusal(() => t.service.pay(t.margaret, { hold_id: first.hold.id }))).toEqual({
      code: 'denied',
      message: 'Sarah Ellis later said no to a payment to this payee, so this approval no longer stands. Nothing has been paid.',
    });
    expect(errorCode(() => t.service.pay(t.margaret, { check_id: first.check_id }))).toBe('denied');

    t.clock.advance(HOUR);
    const after = holdFor(SCENARIOS.contractorDeposit);
    t.service.familyDecide(t.sarah, { hold_id: after.hold.id, decision: 'approve' });
    expect(t.service.pay(t.margaret, { hold_id: after.hold.id }).receipt).toMatchObject({ payee: 'Greenleaf Roofing', method: 'check' });
    expect(t.service.listHolds(t.margaret, { status: 'paid' }).map((h) => h.id)).toEqual([after.hold.id]);
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
    // A reason whose sentence already names the official website says which words those are, so a view shows the website once.
    expect(reasons[6]!.source?.named_in_text).toBe('irs.gov');
    expect(reasons[6]!.text).toContain('publishes on irs.gov.');
    for (const reason of reasons.slice(0, 4)) expect(reason.source?.named_in_text, reason.text).toBeUndefined();
    // Exactly the reasons that were already recorded as blocking, no more and no fewer.
    expect(reasons.filter((reason) => reason.blocking)).toHaveLength(outcome.policy.blocked_reasons.length);
  });

  it('are empty for a verified bill, and list warning signs for a request that is only held', () => {
    expect(t.service.familyHoldView(holdFor(SCENARIOS.utilityBill).hold, t.sarah.user_id).reasons).toEqual([]);
    const held = holdFor({ description: 'National Grid left a voicemail about my balance', payee_name: 'National Grid', amount_usd: 60, payment_method: 'card', contact_channel: 'phone_call', claimed_phone: '888-555-0142' });
    const reasons = t.service.familyHoldView(held.hold, t.sarah.user_id).reasons;
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatchObject({ kind: 'official_fact', blocking: false, source: { publisher: 'National Grid', url: 'https://www.nationalgridus.com/Our-Company/Scam-Alert', named_in_text: 'nationalgridus.com' } });
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
