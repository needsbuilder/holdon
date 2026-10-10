/**
 * End-to-end scenarios through a real MCP client over Streamable HTTP,
 * negotiating protocol version 2025-11-25, against a real HTTP server.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { containsActionableContact } from '../src/domain/text.js';
import { CONTACT_TOKEN, MEMBER_TOKEN, SCENARIOS, call, connect, startTestServer, textOf, type TestServer } from './helpers.js';

const MEMBER_TOOLS = [
  'holdon_cancel_hold',
  'holdon_check_request',
  'holdon_get_hold',
  'holdon_list_holds',
  'holdon_pay',
  'holdon_place_hold',
  'holdon_verify_payee',
  'holdon_wait_for_decision',
];
const CONTACT_TOOLS = ['holdon_family_decide', 'holdon_family_inbox', 'holdon_get_circle', 'holdon_update_policy'];

let t: TestServer;
let margaret: Client & { asked: string[] };
let sarah: Client & { asked: string[] };

beforeEach(async () => {
  t = await startTestServer();
  margaret = await connect(t.url, MEMBER_TOKEN);
  sarah = await connect(t.url, CONTACT_TOKEN);
});
afterEach(async () => {
  await Promise.allSettled([margaret.close(), sarah.close()]);
  await t.close();
});

describe('scenario (a): an "IRS agent" demands $2,000 in gift cards', () => {
  it('is stopped, placed on hold for the family, and denied by the trusted contact', async () => {
    expect(margaret.getNegotiatedProtocolVersion()).toBe('2025-11-25');

    const check = await call<any>(margaret, 'holdon_check_request', SCENARIOS.irsGiftCards);
    expect(check.verdict).toBe('stop');
    expect(check.next_step).toBe('place_hold');
    expect(check.policy).toMatchObject({ requires_family_approval: true, blocked: true });
    expect(check.payee).toMatchObject({ status: 'mismatch', registry_id: 'irs' });
    expect(check.payee.official.phones[0].number).toBe('800-829-1040');
    const giftCard = check.risk_signals.find((s: any) => s.id === 'gift-card-payment-demand');
    expect(giftCard).toMatchObject({ severity: 'high', source: { publisher: 'Federal Trade Commission' } });
    expect(giftCard.source.url).toMatch(/^https:\/\/consumer\.ftc\.gov\//);
    expect(giftCard.source.quote).toBe('No real business or government agency will ever tell you to buy a gift card to pay them.');
    // Nothing from the caller is repeated to the older adult; only the registry number appears.
    expect(JSON.stringify(check)).not.toContain('555-0142');
    expect(check.say_to_user).toContain('800-829-1040');

    const placed = await call<any>(margaret, 'holdon_place_hold', {
      check_id: check.check_id,
      summary: 'Someone claiming to be the IRS wants $2,000 in gift cards. Callback number 1-888-555-0142.',
    });
    expect(placed).toMatchObject({ status: 'pending_family', blocked: true, next_step: 'wait' });
    expect(placed.notified).toEqual([expect.objectContaining({ name: 'Sarah Ellis', relationship: 'daughter' })]);
    expect(Date.parse(placed.expires_at)).toBeGreaterThan(Date.now());
    expect(JSON.stringify(placed)).not.toContain('/approve/');

    const inbox = await call<any>(sarah, 'holdon_family_inbox');
    expect(inbox.count).toBe(1);
    const item = inbox.holds[0];
    expect(item).toMatchObject({ hold_id: placed.hold_id, blocked: true, can_approve: false, member: { name: 'Margaret Ellis' }, secrecy_requested: true });
    expect(item.member_words).toContain('IRS agent');
    expect(item.untrusted_contact_details.claimed_phone).toBe('1-888-555-0142');
    expect(item.risk_signals.length).toBeGreaterThanOrEqual(3);
    expect(item.approval_url).toMatch(new RegExp(`^${t.url}/approve/${placed.hold_id}\\?t=`));

    // A stopped request cannot be approved, even by the trusted contact.
    const approve = await sarah.callTool({ name: 'holdon_family_decide', arguments: { hold_id: placed.hold_id, decision: 'approve' } });
    expect(approve.isError).toBe(true);
    expect(textOf(approve)).toMatch(/Error \(blocked\): This request was stopped and cannot be approved/);

    const denied = await call<any>(sarah, 'holdon_family_decide', { hold_id: placed.hold_id, decision: 'deny', note: 'Mom, the real IRS sends letters. I will call you tonight.' });
    expect(denied).toMatchObject({ status: 'denied', decision: { by: 'Sarah Ellis' } });

    const hold = await call<any>(margaret, 'holdon_get_hold', { hold_id: placed.hold_id });
    expect(hold).toMatchObject({ status: 'denied', next_step: 'none', decision: { by: 'Sarah Ellis', note: 'Mom, the real IRS sends letters. I will call you tonight.' } });
    expect(hold.say_to_user).toContain('Nothing has been paid');
    expect(containsActionableContact(hold.summary)).toBe(false);

    const pay = await margaret.callTool({ name: 'holdon_pay', arguments: { hold_id: placed.hold_id } });
    expect(pay.isError).toBe(true);
  });
});

describe('scenario (b): a genuine utility bill', () => {
  it('is verified, held for approval, approved, paid (simulated) and receipted', async () => {
    const check = await call<any>(margaret, 'holdon_check_request', SCENARIOS.utilityBill);
    expect(check).toMatchObject({ verdict: 'verified', next_step: 'place_hold', risk_signals: [] });
    expect(check.payee).toMatchObject({ status: 'verified', registry_id: 'con-edison', matches: ['name', 'payment_method'], mismatches: [] });
    expect(check.payee.official).toMatchObject({ name: 'Con Edison', website: 'coned.com' });
    expect(check.policy).toMatchObject({ requires_family_approval: true, blocked: false });

    const placed = await call<any>(margaret, 'holdon_place_hold', { check_id: check.check_id, summary: 'Con Edison electric bill, $182.40' });
    expect(placed).toMatchObject({ status: 'pending_family', blocked: false });

    const inbox = await call<any>(sarah, 'holdon_family_inbox');
    expect(inbox.holds[0]).toMatchObject({ can_approve: true, requires_trust_payee: false, amount_usd: 182.4, payee_status: 'verified' });

    const approved = await call<any>(sarah, 'holdon_family_decide', { hold_id: placed.hold_id, decision: 'approve', note: 'Looks right.' });
    expect(approved).toMatchObject({ status: 'approved', trusted_payee_added: false });

    const ready = await call<any>(margaret, 'holdon_get_hold', { hold_id: placed.hold_id });
    expect(ready).toMatchObject({ status: 'approved', next_step: 'pay' });

    const receipt = await call<any>(margaret, 'holdon_pay', { hold_id: placed.hold_id });
    expect(receipt).toMatchObject({ hold_id: placed.hold_id, amount_usd: 182.4, payee: 'Con Edison', method: 'card', simulated: true });
    expect(receipt.receipt_id).toMatch(/^rcpt_/);
    expect(receipt.confirmation).toMatch(/^SIM-/);
    expect(receipt.say_to_user).toMatch(/simulated/);

    const again = await call<any>(margaret, 'holdon_pay', { hold_id: placed.hold_id });
    expect(again.receipt_id).toBe(receipt.receipt_id);

    const paid = await call<any>(margaret, 'holdon_get_hold', { hold_id: placed.hold_id });
    expect(paid).toMatchObject({ status: 'paid', receipt: { receipt_id: receipt.receipt_id, simulated: true } });
    expect((await call<any>(sarah, 'holdon_family_inbox')).count).toBe(0);
    expect((await call<any>(sarah, 'holdon_family_inbox', { status: 'all' })).holds[0].status).toBe('paid');
  });

  it('can be paid straight away when it is under the family approval limit', async () => {
    const check = await call<any>(margaret, 'holdon_check_request', { ...SCENARIOS.utilityBill, amount_usd: 64.1 });
    expect(check).toMatchObject({ verdict: 'verified', next_step: 'pay', policy: { requires_family_approval: false } });
    const receipt = await call<any>(margaret, 'holdon_pay', { check_id: check.check_id });
    expect(receipt).toMatchObject({ amount_usd: 64.1, payee: 'Con Edison', simulated: true });
  });
});

describe('scenario (c): an unknown contractor asks for a deposit', () => {
  it('is reported as not_in_registry and held for the family, who must vouch for the payee', async () => {
    const check = await call<any>(margaret, 'holdon_check_request', SCENARIOS.contractorDeposit);
    expect(check).toMatchObject({ verdict: 'unknown', next_step: 'place_hold', risk_signals: [] });
    expect(check.payee).toMatchObject({ status: 'not_in_registry', name: 'Greenleaf Roofing' });
    expect(check.payee.official).toBeUndefined();
    expect(check.say_to_user).toMatch(/can't confirm who they are/);

    const placed = await call<any>(margaret, 'holdon_place_hold', { check_id: check.check_id, summary: 'Roofer wants a $1,500 deposit by check' });
    expect(placed).toMatchObject({ status: 'pending_family', blocked: false });

    const item = (await call<any>(sarah, 'holdon_family_inbox')).holds[0];
    expect(item).toMatchObject({ can_approve: true, requires_trust_payee: true, payee_status: 'not_in_registry' });

    const bare = await sarah.callTool({ name: 'holdon_family_decide', arguments: { hold_id: placed.hold_id, decision: 'approve' } });
    expect(bare.isError).toBe(true);
    expect(textOf(bare)).toMatch(/trust_payee: true/);

    const approved = await call<any>(sarah, 'holdon_family_decide', { hold_id: placed.hold_id, decision: 'approve', trust_payee: true });
    expect(approved).toMatchObject({ status: 'approved', trusted_payee_added: true, payee_status: 'family_trusted' });
    const receipt = await call<any>(margaret, 'holdon_pay', { hold_id: placed.hold_id });
    expect(receipt).toMatchObject({ payee: 'Greenleaf Roofing', amount_usd: 1500, method: 'check' });
    expect((await call<any>(sarah, 'holdon_get_circle')).circle.trusted_payees[0].name).toBe('Greenleaf Roofing');
  });
});

describe('scenario (d): paying before approval', () => {
  it('returns a clear tool error and pays nothing', async () => {
    const check = await call<any>(margaret, 'holdon_check_request', SCENARIOS.utilityBill);
    const placed = await call<any>(margaret, 'holdon_place_hold', { check_id: check.check_id, summary: 'Electric bill' });

    const early = await margaret.callTool({ name: 'holdon_pay', arguments: { hold_id: placed.hold_id } });
    expect(early.isError).toBe(true);
    expect(textOf(early)).toBe(
      "Error (not_approved): This payment is still waiting for Sarah's answer, so it cannot be paid yet. Nothing has been paid. Use holdon_wait_for_decision or holdon_get_hold to check on it.",
    );
    expect(early.structuredContent).toBeUndefined();

    const viaCheck = await margaret.callTool({ name: 'holdon_pay', arguments: { check_id: check.check_id } });
    expect(viaCheck.isError).toBe(true);
    expect(textOf(viaCheck)).toMatch(/Error \(not_approved\)/);

    expect((await call<any>(margaret, 'holdon_get_hold', { hold_id: placed.hold_id })).status).toBe('pending_family');
    expect(t.store.getReceiptByHold(placed.hold_id)).toBeUndefined();
  });
});

describe('scenario (e): role enforcement', () => {
  it('lists different tools for each role', async () => {
    expect((await margaret.listTools()).tools.map((tool) => tool.name).sort()).toEqual(MEMBER_TOOLS);
    expect((await sarah.listTools()).tools.map((tool) => tool.name).sort()).toEqual(CONTACT_TOOLS);
  });

  it('does not let the member approve their own hold or change the family settings', async () => {
    const check = await call<any>(margaret, 'holdon_check_request', SCENARIOS.utilityBill);
    const placed = await call<any>(margaret, 'holdon_place_hold', { check_id: check.check_id, summary: 'Electric bill' });

    for (const [name, args] of [
      ['holdon_family_decide', { hold_id: placed.hold_id, decision: 'approve' }],
      ['holdon_update_policy', { approval_threshold_usd: 10000 }],
      ['holdon_family_inbox', {}],
      ['holdon_get_circle', {}],
    ] as const) {
      await expect(margaret.callTool({ name, arguments: args }), name).rejects.toThrow(/not found/i);
    }
    expect(t.store.getHold(placed.hold_id)?.status).toBe('pending_family');
    expect(t.service.circleView('circle_ellis').policy.approval_threshold_usd).toBe(100);
  });

  it('does not let the trusted contact pay or act as the member', async () => {
    const check = await call<any>(margaret, 'holdon_check_request', SCENARIOS.utilityBill);
    const placed = await call<any>(margaret, 'holdon_place_hold', { check_id: check.check_id, summary: 'Electric bill' });
    await call(sarah, 'holdon_family_decide', { hold_id: placed.hold_id, decision: 'approve' });
    await expect(sarah.callTool({ name: 'holdon_pay', arguments: { hold_id: placed.hold_id } })).rejects.toThrow(/not found/i);
    await expect(sarah.callTool({ name: 'holdon_place_hold', arguments: { summary: 'anything' } })).rejects.toThrow(/not found/i);
    expect(t.store.getHold(placed.hold_id)?.status).toBe('approved');
  });

  it('gives every tool a title, an icon, annotations and an output schema', async () => {
    const readOnly = new Set(['holdon_check_request', 'holdon_verify_payee', 'holdon_get_hold', 'holdon_list_holds', 'holdon_wait_for_decision', 'holdon_family_inbox', 'holdon_get_circle']);
    for (const client of [margaret, sarah]) {
      for (const tool of (await client.listTools()).tools) {
        expect(tool.title, tool.name).toBeTruthy();
        expect(tool.description!.length, tool.name).toBeGreaterThan(40);
        expect(tool.icons?.[0]?.src, tool.name).toMatch(/^data:image\/svg\+xml;base64,/);
        expect(tool.outputSchema, tool.name).toMatchObject({ type: 'object' });
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(readOnly.has(tool.name));
        expect(tool.annotations?.openWorldHint, tool.name).toBeTypeOf('boolean');
      }
    }
    const pay = (await margaret.listTools()).tools.find((tool) => tool.name === 'holdon_pay')!;
    expect(pay.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(pay.description).toMatch(/SIMULATED/);
  });
});

describe('state across sessions', () => {
  it('a hold placed in one session is decided elsewhere and picked up in a new session', async () => {
    const check = await call<any>(margaret, 'holdon_check_request', SCENARIOS.utilityBill);
    const placed = await call<any>(margaret, 'holdon_place_hold', { check_id: check.check_id, summary: 'Electric bill' });
    await margaret.close();

    await call(sarah, 'holdon_family_decide', { hold_id: placed.hold_id, decision: 'approve', note: 'Go ahead, Mom.' });

    const nextDay = await connect(t.url, MEMBER_TOKEN);
    const open = await call<any>(nextDay, 'holdon_list_holds', { status: 'open' });
    expect(open.count).toBe(1);
    expect(open.holds[0]).toMatchObject({ hold_id: placed.hold_id, status: 'approved', next_step: 'pay', decision: { by: 'Sarah Ellis', note: 'Go ahead, Mom.' } });
    expect(open.say_to_user).toMatch(/1 approved and ready to pay/);
    const receipt = await call<any>(nextDay, 'holdon_pay', { hold_id: placed.hold_id });
    expect(receipt.simulated).toBe(true);
    expect((await call<any>(nextDay, 'holdon_list_holds', { status: 'paid' })).count).toBe(1);
    await nextDay.close();
  });

  it('the member can cancel a hold, and the family sees that', async () => {
    const check = await call<any>(margaret, 'holdon_check_request', SCENARIOS.contractorDeposit);
    const placed = await call<any>(margaret, 'holdon_place_hold', { check_id: check.check_id, summary: 'Roofer deposit' });
    const cancelled = await call<any>(margaret, 'holdon_cancel_hold', { hold_id: placed.hold_id });
    expect(cancelled).toMatchObject({ status: 'cancelled', next_step: 'none' });
    expect((await call<any>(sarah, 'holdon_family_inbox')).count).toBe(0);
    const late = await sarah.callTool({ name: 'holdon_family_decide', arguments: { hold_id: placed.hold_id, decision: 'approve', trust_payee: true } });
    expect(textOf(late)).toMatch(/Error \(already_decided\)/);
  });
});

describe('waiting for a decision', () => {
  it('sends progress notifications and returns as soon as the trusted contact answers', async () => {
    const check = await call<any>(margaret, 'holdon_check_request', SCENARIOS.utilityBill);
    const placed = await call<any>(margaret, 'holdon_place_hold', { check_id: check.check_id, summary: 'Electric bill' });

    const progress: Array<{ progress: number; total?: number; message?: string }> = [];
    const decided = new Promise((resolve, reject) => {
      setTimeout(() => call(sarah, 'holdon_family_decide', { hold_id: placed.hold_id, decision: 'approve' }).then(resolve, reject), 250);
    });
    const result = await margaret.callTool(
      { name: 'holdon_wait_for_decision', arguments: { hold_id: placed.hold_id, timeout_seconds: 10 } },
      { onprogress: (update) => progress.push(update) },
    );
    const waited = result.structuredContent as any;

    expect(waited).toMatchObject({ status: 'approved', timed_out: false, next_step: 'pay' });
    expect(waited.waited_seconds).toBeLessThan(5);
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress[0]).toMatchObject({ total: 10, message: 'Waiting for the trusted contact to answer. Nothing has been paid.' });
    expect(progress.at(-1)!.progress).toBeGreaterThan(progress[0]!.progress);
    await decided;
  });

  it('times out politely when nobody answers', async () => {
    const check = await call<any>(margaret, 'holdon_check_request', SCENARIOS.utilityBill);
    const placed = await call<any>(margaret, 'holdon_place_hold', { check_id: check.check_id, summary: 'Electric bill' });
    const waited = await call<any>(margaret, 'holdon_wait_for_decision', { hold_id: placed.hold_id, timeout_seconds: 1 });
    expect(waited).toMatchObject({ status: 'pending_family', timed_out: true, next_step: 'wait' });
    expect(waited.waited_seconds).toBeGreaterThanOrEqual(1);
    expect(waited.say_to_user).toMatch(/hasn't answered yet/);
  });

  it('returns at once when the hold is already decided', async () => {
    const check = await call<any>(margaret, 'holdon_check_request', SCENARIOS.utilityBill);
    const placed = await call<any>(margaret, 'holdon_place_hold', { check_id: check.check_id, summary: 'Electric bill' });
    await call(sarah, 'holdon_family_decide', { hold_id: placed.hold_id, decision: 'deny' });
    const waited = await call<any>(margaret, 'holdon_wait_for_decision', { hold_id: placed.hold_id, timeout_seconds: 30 });
    expect(waited).toMatchObject({ status: 'denied', timed_out: false, waited_seconds: 0 });
  });
});

describe('one clarifying question (MCP form elicitation)', () => {
  const vague = { description: 'Someone from Social Security says I have to repay an overpayment of benefits.', payee_name: 'Social Security', amount_usd: 400, payment_method: 'card' };

  it('asks how the request arrived when the client supports elicitation, and the answer changes the verdict', async () => {
    const client = await connect(t.url, MEMBER_TOKEN, { elicitation: { contact_channel: 'phone_call' } });
    const check = await call<any>(client, 'holdon_check_request', vague);
    expect(client.asked).toEqual(['One quick question to help keep this safe: how did this request to pay reach you? There is no wrong answer.']);
    expect(check.clarification).toEqual({ field: 'contact_channel', status: 'answered', answer: 'phone_call' });
    expect(check.interpreted.contact_channel).toBe('phone_call');
    expect(check.verdict).toBe('stop');
    expect(check.risk_signals.map((s: any) => s.id)).toContain('government-impersonation-demand');
    await client.close();
  });

  it('carries on without the answer when the user declines', async () => {
    const client = await connect(t.url, MEMBER_TOKEN, { elicitation: null });
    const check = await call<any>(client, 'holdon_check_request', vague);
    expect(client.asked).toHaveLength(1);
    expect(check.clarification).toEqual({ field: 'contact_channel', status: 'declined' });
    expect(check.verdict).toBe('verified');
    expect(check.next_step).toBe('place_hold');
    await client.close();
  });

  it('hands the question to the assistant when the client has no elicitation support', async () => {
    const check = await call<any>(margaret, 'holdon_check_request', vague);
    expect(check.clarification).toEqual({ field: 'contact_channel', status: 'ask_user', question: 'How did the request reach you?' });
    expect(check.verdict).toBe('verified');
  });

  it('asks nothing when the details are complete or the request is already stopped', async () => {
    const client = await connect(t.url, MEMBER_TOKEN, { elicitation: { contact_channel: 'mail' } });
    expect((await call<any>(client, 'holdon_check_request', SCENARIOS.utilityBill)).clarification).toBeUndefined();
    expect((await call<any>(client, 'holdon_check_request', SCENARIOS.irsGiftCards)).clarification).toBeUndefined();
    expect(client.asked).toEqual([]);
    await client.close();
  });

  it('works the same way for a 2026-07-28 client', async () => {
    const client = await connect(t.url, MEMBER_TOKEN, { elicitation: { contact_channel: 'text' }, mode: 'auto' });
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const check = await call<any>(client, 'holdon_check_request', vague);
    expect(client.asked).toHaveLength(1);
    expect(check.clarification).toMatchObject({ status: 'answered', answer: 'text' });
    expect(check.verdict).toBe('stop');
    await client.close();
  });
});

describe('input validation', () => {
  it('returns tool execution errors with messages the model can act on', async () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['holdon_check_request', {}, /description/],
      ['holdon_check_request', { description: 'x' }, /description is too short/],
      ['holdon_check_request', { description: 'Pay the bill', amount_usd: -5 }, /amount_usd must be greater than zero/],
      ['holdon_check_request', { description: 'Pay the bill', payment_method: 'barter' }, /payment_method/],
      ['holdon_get_hold', { hold_id: 'not-a-hold' }, /hold_id looks like "hold_\.\.\."/],
      ['holdon_wait_for_decision', { hold_id: 'hold_abc', timeout_seconds: 600 }, /between 1 and 50/],
    ];
    for (const [name, args, pattern] of cases) {
      const result = await margaret.callTool({ name, arguments: args });
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(textOf(result), name).toMatch(pattern);
    }
    const decide = await sarah.callTool({ name: 'holdon_family_decide', arguments: { hold_id: 'hold_abc', decision: 'maybe' } });
    expect(decide.isError).toBe(true);
    expect(textOf(decide)).toMatch(/decision must be "approve" or "deny"/);
    const policy = await sarah.callTool({ name: 'holdon_update_policy', arguments: {} });
    expect(policy.isError).toBe(true);
    expect(textOf(policy)).toMatch(/Give at least one setting to change/);
  });

  it('explains an unknown hold or check id', async () => {
    const hold = await margaret.callTool({ name: 'holdon_get_hold', arguments: { hold_id: 'hold_doesnotexist' } });
    expect(textOf(hold)).toMatch(/Error \(not_found\): No hold with id "hold_doesnotexist"/);
    const place = await margaret.callTool({ name: 'holdon_place_hold', arguments: { check_id: 'chk_doesnotexist', summary: 'Something' } });
    expect(textOf(place)).toMatch(/Error \(not_found\)/);
  });
});

describe('family settings', () => {
  it('lets the trusted contact tighten the policy, which changes the next check', async () => {
    const before = await call<any>(margaret, 'holdon_check_request', { ...SCENARIOS.utilityBill, amount_usd: 64.1 });
    expect(before.next_step).toBe('pay');

    const updated = await call<any>(sarah, 'holdon_update_policy', { approval_threshold_usd: 25, blocked_methods_all_payees: ['wire', 'gift_card'] });
    expect(updated.changed).toEqual(['approval_threshold_usd', 'blocked_methods_all_payees']);
    expect(updated.circle.policy).toMatchObject({ approval_threshold_usd: 25, blocked_methods_all_payees: ['gift_card', 'wire'], always_blocked_methods_official_payees: ['gift_card', 'crypto'] });

    const after = await call<any>(margaret, 'holdon_check_request', { ...SCENARIOS.utilityBill, amount_usd: 64.1 });
    expect(after.next_step).toBe('place_hold');
    // The member's view never reveals the family's limit, so it cannot be coached around.
    expect(JSON.stringify(after)).not.toMatch(/\b25\b/);
  });
});
