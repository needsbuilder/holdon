/**
 * Application service: every action Hold On can take, with role checks.
 *
 * The MCP tools, the family approval web page and the tests all go through
 * this one class, so the safety rules are enforced in a single place:
 *
 * - members (older adults) can ask, wait, cancel and pay; they can never decide.
 * - contacts (trusted family) can decide and set policy; they can never pay.
 * - a stopped request can never be approved, and an unapproved hold can never be paid.
 */
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { evaluateRequest, pickClarifyingQuestion, policyMethodBlocks, type EngineContext } from './domain/engine.js';
import {
  sayDecision,
  sayHoldPlaced,
  sayHoldStatus,
  sayInbox,
  sayPaid,
  sayVerifyPayee,
} from './domain/language.js';
import { verifyPayee, type PayeeQuery, type Registry } from './domain/registry.js';
import type { RuleSet } from './domain/rules.js';
import { formatUsd, fromCents, methodLabel, normalizeName, redactUntrusted, toCents } from './domain/text.js';
import {
  DEFAULT_POLICY,
  PAYMENT_METHODS,
  POLICY_FLOOR_BLOCKED_METHODS,
  type CheckInput,
  type CheckOutcome,
  type ClarifyingField,
  type ContactChannel,
  type HoldStatus,
  type PayeeResult,
  type PayeeStatus,
  type PaymentMethod,
  type Policy,
  type PolicyDecision,
  type Principal,
  type RiskSignal,
  type Role,
  type UrgencyClaim,
  type Verdict,
} from './domain/types.js';
import type { CheckRow, EventRow, HoldRow, ReceiptRow, Store, UserRow } from './store/db.js';

export type ErrorCode =
  | 'forbidden'
  | 'not_found'
  | 'invalid_input'
  | 'not_approved'
  | 'denied'
  | 'expired'
  | 'cancelled'
  | 'blocked'
  | 'payee_not_verified'
  | 'method_required'
  | 'method_not_allowed'
  | 'amount_required'
  | 'already_decided'
  | 'invalid_state';

/** An error that is safe and useful to show to the person or assistant that caused it. */
export class HoldOnError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HoldOnError';
  }
}

export type HoldEventType = 'hold.created' | 'hold.decided' | 'hold.paid' | 'hold.cancelled' | 'hold.expired' | 'policy.updated';

export interface ServiceEvent extends EventRow {
  type: HoldEventType;
}

export interface ReceiptView {
  receipt_id: string;
  hold_id: string;
  amount_usd: number;
  payee: string;
  method: PaymentMethod;
  confirmation: string;
  paid_at: string;
  simulated: true;
}

export interface DecisionView {
  by: string;
  at: string;
  note?: string;
}

/** What the older adult's assistant is allowed to see about a hold. */
export interface MemberHoldView {
  hold_id: string;
  check_id: string;
  status: HoldStatus;
  summary: string;
  amount_usd?: number;
  payee_name?: string;
  payment_method: PaymentMethod;
  verdict: Verdict;
  payee_status: PayeeStatus;
  blocked: boolean;
  blocked_reasons: string[];
  created_at: string;
  expires_at: string;
  decision?: DecisionView;
  receipt?: ReceiptView;
  say_to_user: string;
  next_step: 'wait' | 'pay' | 'none';
}

/** Full context for the trusted contact, including the untrusted details the member never sees repeated. */
export interface FamilyHoldView extends Omit<MemberHoldView, 'say_to_user' | 'next_step'> {
  member: { id: string; name: string };
  member_words: string;
  contact_channel?: ContactChannel;
  urgency_claims: UrgencyClaim[];
  secrecy_requested: boolean;
  untrusted_contact_details: { claimed_phone?: string; claimed_url?: string; warning: string };
  risk_signals: RiskSignal[];
  payee: PayeeResult;
  policy: PolicyDecision & { approval_threshold_usd: number };
  can_approve: boolean;
  cannot_approve_reason?: string;
  requires_trust_payee: boolean;
  approval_url: string;
}

export interface CircleView {
  id: string;
  name: string;
  members: Array<{ id: string; name: string }>;
  contacts: Array<{ id: string; name: string; relationship?: string }>;
  policy: Policy & { always_blocked_methods_official_payees: PaymentMethod[] };
  trusted_payees: Array<{ name: string; added_by: string; added_at: string }>;
}

export interface PolicyPatch {
  approval_threshold_usd?: number;
  blocked_methods_official_payees?: PaymentMethod[];
  blocked_methods_all_payees?: PaymentMethod[];
  hold_expiry_hours?: number;
  notify_on_stop?: boolean;
  remove_trusted_payee?: string;
}

export interface ServiceOptions {
  store: Store;
  registry: Registry;
  rules: RuleSet;
  /** Builds the signed approval link for a hold and a contact. Supplied by the HTTP layer. */
  approvalUrl?: (holdId: string, contactUserId: string) => string;
  clock?: () => Date;
}

const UNTRUSTED_WARNING =
  'These details came from the message or caller and are not verified. Do not call the number or open the link; use the official contact details instead.';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

function newConfirmation(): string {
  return `SIM-${randomBytes(4).toString('hex').toUpperCase()}`;
}

export class HoldOnService {
  readonly store: Store;
  readonly registry: Registry;
  readonly rules: RuleSet;
  readonly events = new EventEmitter();
  approvalUrl: (holdId: string, contactUserId: string) => string;
  private readonly clock: () => Date;

  constructor(options: ServiceOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.rules = options.rules;
    this.clock = options.clock ?? (() => new Date());
    this.approvalUrl = options.approvalUrl ?? ((holdId) => `/approve/${holdId}`);
    this.events.setMaxListeners(0);
  }

  // --- identity ----------------------------------------------------------

  authenticate(token: string): Principal | undefined {
    const user = this.store.getUserByTokenHash(hashToken(token));
    return user ? this.principalOf(user) : undefined;
  }

  principalOf(user: UserRow): Principal {
    return { user_id: user.id, name: user.name, role: user.role, circle_id: user.circle_id, relationship: user.relationship };
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private requireRole(principal: Principal, role: Role, action: string): void {
    if (principal.role !== role) {
      const who = role === 'member' ? 'the person the circle protects' : 'a trusted contact';
      throw new HoldOnError('forbidden', `Only ${who} can ${action}. You are signed in as ${principal.name} (${principal.role}).`);
    }
  }

  private policyOf(circleId: string): Policy {
    return { ...DEFAULT_POLICY, ...(this.store.getCircle(circleId)?.policy ?? {}) };
  }

  private primaryContact(circleId: string): UserRow | undefined {
    return this.store.listUsers(circleId, 'contact')[0];
  }

  private engineContext(circleId: string): EngineContext {
    return {
      registry: this.registry,
      rules: this.rules,
      policy: this.policyOf(circleId),
      trustedPayees: this.store.listTrustedPayees(circleId),
      contactName: this.primaryContact(circleId)?.name,
    };
  }

  private emit(type: HoldEventType, circleId: string, holdId?: string): void {
    const row = this.store.insertEvent({ circle_id: circleId, type, hold_id: holdId, created_at: this.now() });
    this.events.emit('event', row as ServiceEvent);
  }

  // --- checks (member) ---------------------------------------------------

  /** Which single clarifying question, if any, would help. Pure with respect to stored state. */
  clarifyingQuestion(principal: Principal, input: CheckInput): ClarifyingField | undefined {
    this.requireRole(principal, 'member', 'check a payment request');
    return pickClarifyingQuestion(input, this.engineContext(principal.circle_id));
  }

  checkRequest(principal: Principal, input: CheckInput): { check_id: string; outcome: CheckOutcome } {
    this.requireRole(principal, 'member', 'check a payment request');
    const outcome = evaluateRequest(input, this.engineContext(principal.circle_id));
    const check: CheckRow = {
      id: newId('chk'),
      circle_id: principal.circle_id,
      member_id: principal.user_id,
      input,
      outcome,
      created_at: this.now(),
    };
    this.store.insertCheck(check);
    return { check_id: check.id, outcome };
  }

  verifyPayee(principal: Principal, query: PayeeQuery): PayeeResult & { say_to_user: string } {
    const result = verifyPayee(this.registry, this.store.listTrustedPayees(principal.circle_id), query);
    return { ...result, say_to_user: sayVerifyPayee(result) };
  }

  // --- holds (member) ----------------------------------------------------

  placeHold(
    principal: Principal,
    input: { check_id?: string; summary: string; amount_usd?: number; payee_name?: string; payment_method?: PaymentMethod },
  ): { hold: HoldRow; notified: Array<{ name: string; relationship?: string; via: string[] }>; reused: boolean } {
    this.requireRole(principal, 'member', 'place a hold');
    const contacts = this.store.listUsers(principal.circle_id, 'contact');
    if (contacts.length === 0) {
      throw new HoldOnError('invalid_state', 'This circle has no trusted contact yet, so there is no one to ask. Add a trusted contact first.');
    }

    let check: CheckRow;
    if (input.check_id) {
      const found = this.store.getCheck(input.check_id);
      if (!found || found.member_id !== principal.user_id) {
        throw new HoldOnError('not_found', `No check with id "${input.check_id}" was found for ${principal.name}. Call holdon_check_request first, or leave check_id out.`);
      }
      check = found;
      const existing = this.store.findOpenHoldByCheck(check.id);
      if (existing && existing.status === 'pending_family') {
        return { hold: existing, notified: this.notifiedList(contacts), reused: true };
      }
    } else {
      // A hold always carries rule and registry context, so run the check now from what was given.
      const created = this.checkRequest(principal, {
        description: input.summary,
        payee_name: input.payee_name,
        amount_usd: input.amount_usd,
        payment_method: input.payment_method,
      });
      check = this.store.getCheck(created.check_id)!;
    }

    const amount = input.amount_usd ?? check.input.amount_usd;
    const method =
      input.payment_method && input.payment_method !== 'unknown' ? input.payment_method : check.outcome.effective_method;
    const now = this.clock();
    const policy = this.policyOf(principal.circle_id);
    const hold: HoldRow = {
      id: newId('hold'),
      circle_id: principal.circle_id,
      member_id: principal.user_id,
      check_id: check.id,
      summary: input.summary,
      amount_cents: amount === undefined ? undefined : toCents(amount),
      payee_name: input.payee_name ?? check.input.payee_name,
      payment_method: method,
      status: 'pending_family',
      blocked: check.outcome.policy.blocked,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + policy.hold_expiry_hours * 3_600_000).toISOString(),
      updated_at: now.toISOString(),
    };
    this.store.insertHold(hold);
    this.emit('hold.created', hold.circle_id, hold.id);
    return { hold, notified: this.notifiedList(contacts), reused: false };
  }

  private notifiedList(contacts: UserRow[]): Array<{ name: string; relationship?: string; via: string[] }> {
    const via = ['family_inbox', 'live_events', 'approval_page'];
    if (process.env.HOLDON_WEBHOOK_URL) via.push('webhook');
    return contacts.map((c) => ({ name: c.name, ...(c.relationship ? { relationship: c.relationship } : {}), via }));
  }

  /** Load a hold the principal may see, applying expiry first. */
  private loadHold(principal: Principal, holdId: string): HoldRow {
    const hold = this.store.getHold(holdId);
    const visible =
      hold && hold.circle_id === principal.circle_id && (principal.role === 'contact' || hold.member_id === principal.user_id);
    if (!hold || !visible) {
      throw new HoldOnError('not_found', `No hold with id "${holdId}" was found. Use holdon_list_holds to see the holds that exist.`);
    }
    return this.applyExpiry(hold);
  }

  private applyExpiry(hold: HoldRow): HoldRow {
    if ((hold.status === 'pending_family' || hold.status === 'approved') && hold.expires_at <= this.now()) {
      const changed = this.store.updateHold(hold.id, [hold.status], { status: 'expired', updated_at: this.now() });
      if (changed) this.emit('hold.expired', hold.circle_id, hold.id);
      return this.store.getHold(hold.id)!;
    }
    return hold;
  }

  /** Expire lapsed holds so live listeners hear about it. Called on a timer by the HTTP server. */
  sweepExpired(): number {
    const lapsed = this.store.listLapsedHolds(this.now());
    lapsed.forEach((hold) => this.applyExpiry(hold));
    return lapsed.length;
  }

  getHold(principal: Principal, holdId: string): HoldRow {
    this.requireRole(principal, 'member', 'look up their holds');
    return this.loadHold(principal, holdId);
  }

  listHolds(principal: Principal, filter: { status?: HoldStatus | 'open' | 'all'; limit?: number }): HoldRow[] {
    this.requireRole(principal, 'member', 'list their holds');
    this.sweepExpired();
    const status = filter.status ?? 'all';
    const statuses: HoldStatus[] | undefined =
      status === 'all' ? undefined : status === 'open' ? ['pending_family', 'approved'] : [status];
    return this.store.listHolds({
      circle_id: principal.circle_id,
      member_id: principal.user_id,
      statuses,
      limit: filter.limit ?? 20,
    });
  }

  /**
   * Wait until the hold leaves `pending_family` or the timeout passes.
   * `onTick` is called about once per interval so the caller can send progress.
   */
  async waitForDecision(
    principal: Principal,
    holdId: string,
    options: { timeoutMs: number; intervalMs: number; signal?: AbortSignal; onTick?: (elapsedMs: number) => void | Promise<void> },
  ): Promise<{ hold: HoldRow; waitedMs: number; timedOut: boolean }> {
    this.requireRole(principal, 'member', 'wait for a decision');
    const started = Date.now();
    let hold = this.loadHold(principal, holdId);
    if (hold.status !== 'pending_family') return { hold, waitedMs: 0, timedOut: false };

    let wake: (() => void) | undefined;
    const onEvent = (event: ServiceEvent) => {
      if (event.hold_id === holdId) wake?.();
    };
    this.events.on('event', onEvent);
    const onAbort = () => wake?.();
    options.signal?.addEventListener('abort', onAbort);
    try {
      for (;;) {
        const elapsed = Date.now() - started;
        hold = this.loadHold(principal, holdId);
        if (hold.status !== 'pending_family') return { hold, waitedMs: elapsed, timedOut: false };
        if (elapsed >= options.timeoutMs || options.signal?.aborted) return { hold, waitedMs: elapsed, timedOut: true };
        await options.onTick?.(elapsed);
        const pause = Math.min(options.intervalMs, options.timeoutMs - elapsed);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(pause, 1));
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
      }
    } finally {
      this.events.off('event', onEvent);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  cancelHold(principal: Principal, holdId: string): HoldRow {
    this.requireRole(principal, 'member', 'cancel their own hold');
    const hold = this.loadHold(principal, holdId);
    if (hold.status === 'cancelled') return hold;
    if (hold.status !== 'pending_family' && hold.status !== 'approved') {
      throw new HoldOnError('invalid_state', `This hold is already ${statusWord(hold.status)}, so there is nothing to cancel.`);
    }
    this.store.updateHold(hold.id, ['pending_family', 'approved'], { status: 'cancelled', updated_at: this.now() });
    this.emit('hold.cancelled', hold.circle_id, hold.id);
    return this.store.getHold(hold.id)!;
  }

  // --- payment (member, simulated) ---------------------------------------

  pay(
    principal: Principal,
    input: { hold_id?: string; check_id?: string; payment_method?: PaymentMethod },
  ): { receipt: ReceiptRow; hold: HoldRow } {
    this.requireRole(principal, 'member', 'make a payment');
    if ((input.hold_id ? 1 : 0) + (input.check_id ? 1 : 0) !== 1) {
      throw new HoldOnError('invalid_input', 'Give exactly one of hold_id (after family approval) or check_id (when the check said next_step "pay").');
    }
    const contact = this.primaryContact(principal.circle_id);
    const contactFirst = contact?.name.split(' ')[0] ?? 'your trusted contact';

    let hold: HoldRow;
    if (input.hold_id) {
      hold = this.loadHold(principal, input.hold_id);
    } else {
      const check = this.store.getCheck(input.check_id!);
      if (!check || check.member_id !== principal.user_id) {
        throw new HoldOnError('not_found', `No check with id "${input.check_id}" was found for ${principal.name}.`);
      }
      const existing = this.store.findOpenHoldByCheck(check.id);
      if (existing) {
        hold = this.applyExpiry(existing);
      } else {
        // Re-evaluate against today's policy: a check is only a snapshot.
        const fresh = evaluateRequest(check.input, this.engineContext(principal.circle_id));
        if (fresh.verdict !== 'verified' || fresh.policy.requires_family_approval) {
          throw new HoldOnError(
            'not_approved',
            `This payment needs ${contactFirst}'s approval first. Call holdon_place_hold with this check_id, then pay with the hold_id once it is approved. Nothing has been paid.`,
          );
        }
        const now = this.clock();
        hold = {
          id: newId('hold'),
          circle_id: principal.circle_id,
          member_id: principal.user_id,
          check_id: check.id,
          summary: check.input.description,
          amount_cents: check.input.amount_usd === undefined ? undefined : toCents(check.input.amount_usd),
          payee_name: check.input.payee_name,
          payment_method: fresh.effective_method,
          status: 'approved',
          blocked: false,
          decision_by: 'policy',
          decision_by_name: 'Family policy',
          decision_at: now.toISOString(),
          decision_note: "Confirmed payee and under the family's approval limit.",
          created_at: now.toISOString(),
          expires_at: new Date(now.getTime() + this.policyOf(principal.circle_id).hold_expiry_hours * 3_600_000).toISOString(),
          updated_at: now.toISOString(),
        };
        this.store.insertHold(hold);
      }
    }

    if (hold.status === 'paid') {
      return { receipt: this.store.getReceiptByHold(hold.id)!, hold };
    }
    if (hold.blocked) {
      throw new HoldOnError('blocked', 'This request was stopped for safety and cannot be paid through Hold On. Nothing has been paid.');
    }
    switch (hold.status) {
      case 'pending_family':
        throw new HoldOnError('not_approved', `This payment is still waiting for ${contactFirst}'s answer, so it cannot be paid yet. Nothing has been paid. Use holdon_wait_for_decision or holdon_get_hold to check on it.`);
      case 'denied':
        throw new HoldOnError('denied', `${hold.decision_by_name ?? contactFirst} asked that this not be paid, so it will not be. Nothing has been paid.`);
      case 'expired':
        throw new HoldOnError('expired', 'This hold has ended without being paid. Start again with holdon_check_request if the payment is still needed.');
      case 'cancelled':
        throw new HoldOnError('cancelled', 'This hold was cancelled. Start again with holdon_check_request if the payment is still needed.');
      default:
        break;
    }

    const check = this.store.getCheck(hold.check_id)!;
    const trusted = this.store.listTrustedPayees(principal.circle_id);
    const registryId = check.outcome.payee.registry_id;
    const entry = registryId ? this.registry.byId.get(registryId) : undefined;
    const familyTrusted = hold.payee_name ? trusted.find((t) => t.normalized_name === normalizeName(hold.payee_name!)) : undefined;
    if (!entry && !familyTrusted) {
      throw new HoldOnError(
        'payee_not_verified',
        `Hold On only pays payees it can confirm: an official payee from the registry, or one ${contactFirst} has vouched for. This payee is neither, so nothing has been paid.`,
      );
    }
    const payeeName = entry?.name ?? familyTrusted!.name;

    if (hold.amount_cents === undefined) {
      throw new HoldOnError('amount_required', 'No amount was given for this payment, so it cannot be paid. Start again with holdon_check_request and include the amount.');
    }

    let method = hold.payment_method;
    if (method === 'unknown') {
      if (!input.payment_method || input.payment_method === 'unknown') {
        throw new HoldOnError('method_required', 'I need to know how to pay before I can do this. Call holdon_pay again with payment_method set to card, bank_transfer or check.');
      }
      method = input.payment_method;
    }
    const never = entry?.never_methods.find((fact) => fact.methods.includes(method));
    const blocks = policyMethodBlocks(this.policyOf(principal.circle_id), method, Boolean(entry));
    if (never) {
      throw new HoldOnError('method_not_allowed', `${entry!.name} does not take payment by ${methodLabel(method)}, so this cannot be paid that way. Nothing has been paid.`);
    }
    if (blocks.length > 0) {
      throw new HoldOnError('method_not_allowed', `${blocks[0]} Nothing has been paid.`);
    }

    const now = this.now();
    const receipt: ReceiptRow = {
      id: newId('rcpt'),
      hold_id: hold.id,
      circle_id: hold.circle_id,
      amount_cents: hold.amount_cents,
      payee: payeeName,
      method,
      confirmation: newConfirmation(),
      created_at: now,
    };
    const paid = this.store.transaction(() => {
      const changed = this.store.updateHold(hold.id, ['approved'], {
        status: 'paid',
        payment_method: method,
        receipt_id: receipt.id,
        updated_at: now,
      });
      if (changed) this.store.insertReceipt(receipt);
      return changed;
    });
    if (!paid) {
      // Another request paid, cancelled or expired it in the meantime; report the current truth.
      return this.pay(principal, { hold_id: hold.id });
    }
    this.emit('hold.paid', hold.circle_id, hold.id);
    return { receipt, hold: this.store.getHold(hold.id)! };
  }

  // --- trusted contact ---------------------------------------------------

  familyInbox(principal: Principal, filter: { status?: 'pending' | 'all'; limit?: number }): HoldRow[] {
    this.requireRole(principal, 'contact', 'open the family inbox');
    this.sweepExpired();
    return this.store.listHolds({
      circle_id: principal.circle_id,
      statuses: (filter.status ?? 'pending') === 'pending' ? ['pending_family'] : undefined,
      limit: filter.limit ?? 20,
    });
  }

  /** One hold with expiry applied, for the trusted contact's approval page. */
  familyHold(principal: Principal, holdId: string): HoldRow {
    this.requireRole(principal, 'contact', 'review a hold');
    return this.loadHold(principal, holdId);
  }

  /** Why the trusted contact cannot approve this hold, or undefined when they can. */
  approvalBlocker(hold: HoldRow, check: CheckRow): string | undefined {
    if (hold.blocked) {
      const reasons = check.outcome.policy.blocked_reasons.join(' ');
      return `This request was stopped and cannot be approved. ${reasons} You can deny it, and a call with your family member may help.`;
    }
    if (hold.amount_cents === undefined) {
      return 'No amount was given, so there is nothing specific to approve. Deny it, or ask your family member to start again with the amount.';
    }
    if (check.outcome.payee.status === 'not_in_registry' && !hold.payee_name) {
      return 'No payee was named, so there is nothing specific to approve. Deny it, or ask your family member to start again with the payee name.';
    }
    return undefined;
  }

  private needsTrust(hold: HoldRow, check: CheckRow): boolean {
    if (check.outcome.payee.registry_id) return false;
    if (!hold.payee_name) return false;
    const trusted = this.store.listTrustedPayees(hold.circle_id);
    return !trusted.some((t) => t.normalized_name === normalizeName(hold.payee_name!));
  }

  familyDecide(
    principal: Principal,
    input: { hold_id: string; decision: 'approve' | 'deny'; note?: string; trust_payee?: boolean },
  ): { hold: HoldRow; trustedPayeeAdded: boolean } {
    this.requireRole(principal, 'contact', 'approve or deny a hold');
    const hold = this.loadHold(principal, input.hold_id);
    const check = this.store.getCheck(hold.check_id)!;
    const target: HoldStatus = input.decision === 'approve' ? 'approved' : 'denied';

    if (hold.status === target) return { hold, trustedPayeeAdded: false };
    const revoking = hold.status === 'approved' && target === 'denied';
    if (hold.status !== 'pending_family' && !revoking) {
      throw new HoldOnError('already_decided', `This hold is already ${statusWord(hold.status)}, so it can no longer be ${input.decision === 'approve' ? 'approved' : 'denied'}.`);
    }

    let trustedPayeeAdded = false;
    const now = this.clock();
    if (input.decision === 'approve') {
      const blocker = this.approvalBlocker(hold, check);
      if (blocker) throw new HoldOnError('blocked', blocker);
      if (this.needsTrust(hold, check)) {
        if (input.trust_payee !== true) {
          throw new HoldOnError(
            'payee_not_verified',
            `"${hold.payee_name}" is not in the registry of official payees, so Hold On cannot confirm who they are. To approve, call again with trust_payee: true to say that you personally know and trust this payee. Otherwise deny the request.`,
          );
        }
        this.store.addTrustedPayee(hold.circle_id, {
          name: hold.payee_name!,
          normalized_name: normalizeName(hold.payee_name!),
          added_by: principal.name,
          added_at: now.toISOString(),
          note: input.note,
        });
        trustedPayeeAdded = true;
      }
    }

    const policy = this.policyOf(hold.circle_id);
    const changed = this.store.updateHold(hold.id, [hold.status], {
      status: target,
      decision_by: principal.user_id,
      decision_by_name: principal.name,
      decision_at: now.toISOString(),
      decision_note: input.note,
      // An approval is good for one more expiry window, then lapses unused.
      ...(target === 'approved' ? { expires_at: new Date(now.getTime() + policy.hold_expiry_hours * 3_600_000).toISOString() } : {}),
      updated_at: now.toISOString(),
    });
    if (!changed) return this.familyDecide(principal, input);
    this.emit('hold.decided', hold.circle_id, hold.id);
    return { hold: this.store.getHold(hold.id)!, trustedPayeeAdded };
  }

  getCircle(principal: Principal): CircleView {
    this.requireRole(principal, 'contact', "see the circle's settings");
    return this.circleView(principal.circle_id);
  }

  updatePolicy(principal: Principal, patch: PolicyPatch): { circle: CircleView; changed: string[] } {
    this.requireRole(principal, 'contact', "change the circle's settings");
    const current = this.policyOf(principal.circle_id);
    const next: Policy = { ...current };
    const changed: string[] = [];
    const cleanMethods = (methods: PaymentMethod[]) =>
      [...new Set(methods)].filter((m) => m !== 'unknown').sort((a, b) => PAYMENT_METHODS.indexOf(a) - PAYMENT_METHODS.indexOf(b));

    if (patch.approval_threshold_usd !== undefined && patch.approval_threshold_usd !== current.approval_threshold_usd) {
      next.approval_threshold_usd = patch.approval_threshold_usd;
      changed.push('approval_threshold_usd');
    }
    if (patch.blocked_methods_official_payees !== undefined) {
      // The built-in floor is reported separately and cannot be removed, so it is not stored twice.
      const value = cleanMethods(patch.blocked_methods_official_payees).filter((m) => !POLICY_FLOOR_BLOCKED_METHODS.includes(m));
      if (JSON.stringify(value) !== JSON.stringify(current.blocked_methods_official_payees)) {
        next.blocked_methods_official_payees = value;
        changed.push('blocked_methods_official_payees');
      }
    }
    if (patch.blocked_methods_all_payees !== undefined) {
      const value = cleanMethods(patch.blocked_methods_all_payees);
      if (JSON.stringify(value) !== JSON.stringify(current.blocked_methods_all_payees)) {
        next.blocked_methods_all_payees = value;
        changed.push('blocked_methods_all_payees');
      }
    }
    if (patch.hold_expiry_hours !== undefined && patch.hold_expiry_hours !== current.hold_expiry_hours) {
      next.hold_expiry_hours = patch.hold_expiry_hours;
      changed.push('hold_expiry_hours');
    }
    if (patch.notify_on_stop !== undefined && patch.notify_on_stop !== current.notify_on_stop) {
      next.notify_on_stop = patch.notify_on_stop;
      changed.push('notify_on_stop');
    }
    if (changed.length > 0) this.store.setPolicy(principal.circle_id, next);
    if (patch.remove_trusted_payee !== undefined) {
      const removed = this.store.removeTrustedPayee(principal.circle_id, normalizeName(patch.remove_trusted_payee));
      if (!removed) {
        throw new HoldOnError('not_found', `"${patch.remove_trusted_payee}" is not on the family's list of confirmed payees. Use holdon_get_circle to see the list.`);
      }
      changed.push('trusted_payees');
    }
    if (changed.length > 0) this.emit('policy.updated', principal.circle_id);
    return { circle: this.circleView(principal.circle_id), changed };
  }

  // --- views -------------------------------------------------------------

  circleView(circleId: string): CircleView {
    const circle = this.store.getCircle(circleId);
    if (!circle) throw new HoldOnError('not_found', 'This circle no longer exists.');
    const policy = this.policyOf(circleId);
    return {
      id: circle.id,
      name: circle.name,
      members: this.store.listUsers(circleId, 'member').map((u) => ({ id: u.id, name: u.name })),
      contacts: this.store
        .listUsers(circleId, 'contact')
        .map((u) => ({ id: u.id, name: u.name, ...(u.relationship ? { relationship: u.relationship } : {}) })),
      policy: { ...policy, always_blocked_methods_official_payees: [...POLICY_FLOOR_BLOCKED_METHODS] },
      trusted_payees: this.store
        .listTrustedPayees(circleId)
        .map((t) => ({ name: t.name, added_by: t.added_by, added_at: t.added_at })),
    };
  }

  receiptView(receipt: ReceiptRow): ReceiptView {
    return {
      receipt_id: receipt.id,
      hold_id: receipt.hold_id,
      amount_usd: fromCents(receipt.amount_cents),
      payee: receipt.payee,
      method: receipt.method,
      confirmation: receipt.confirmation,
      paid_at: receipt.created_at,
      simulated: true,
    };
  }

  private baseView(hold: HoldRow, check: CheckRow) {
    const receipt = hold.status === 'paid' ? this.store.getReceiptByHold(hold.id) : undefined;
    const trusted = hold.payee_name
      ? this.store.listTrustedPayees(hold.circle_id).some((t) => t.normalized_name === normalizeName(hold.payee_name!))
      : false;
    const payeeStatus: PayeeStatus =
      check.outcome.payee.status === 'not_in_registry' && trusted ? 'family_trusted' : check.outcome.payee.status;
    return {
      hold_id: hold.id,
      check_id: hold.check_id,
      status: hold.status,
      ...(hold.amount_cents === undefined ? {} : { amount_usd: fromCents(hold.amount_cents) }),
      payment_method: hold.payment_method,
      verdict: check.outcome.verdict,
      payee_status: payeeStatus,
      blocked: hold.blocked,
      blocked_reasons: hold.blocked ? check.outcome.policy.blocked_reasons : [],
      created_at: hold.created_at,
      expires_at: hold.expires_at,
      ...(hold.decision_at
        ? {
            decision: {
              by: hold.decision_by_name ?? 'Trusted contact',
              at: hold.decision_at,
              ...(hold.decision_note ? { note: hold.decision_note } : {}),
            },
          }
        : {}),
      ...(receipt ? { receipt: this.receiptView(receipt) } : {}),
    };
  }

  memberHoldView(hold: HoldRow): MemberHoldView {
    const check = this.store.getCheck(hold.check_id)!;
    const contact = this.primaryContact(hold.circle_id);
    // Official name when known; otherwise the member's own words with anything actionable removed.
    const payeeName = check.outcome.payee.registry_id
      ? check.outcome.payee.name
      : hold.payee_name
        ? redactUntrusted(hold.payee_name)
        : undefined;
    const base = this.baseView(hold, check);
    return {
      ...base,
      summary: redactUntrusted(hold.summary),
      ...(payeeName ? { payee_name: payeeName } : {}),
      say_to_user: sayHoldStatus({
        status: hold.status,
        blocked: hold.blocked,
        contactName: contact?.name,
        deciderName: hold.decision_by === 'policy' ? undefined : hold.decision_by_name,
        note: hold.decision_note && hold.decision_by !== 'policy' ? hold.decision_note : undefined,
        payeeName,
        amount_usd: base.amount_usd,
      }),
      next_step: hold.status === 'pending_family' ? 'wait' : hold.status === 'approved' ? 'pay' : 'none',
    };
  }

  placedMessage(hold: HoldRow): string {
    const view = this.memberHoldView(hold);
    return sayHoldPlaced({
      status: hold.status,
      blocked: hold.blocked,
      contactName: this.primaryContact(hold.circle_id)?.name,
      payeeName: view.payee_name,
      amount_usd: view.amount_usd,
    });
  }

  familyHoldView(hold: HoldRow, contactUserId: string): FamilyHoldView {
    const check = this.store.getCheck(hold.check_id)!;
    const member = this.store.getUser(hold.member_id);
    const policy = this.policyOf(hold.circle_id);
    const blocker = this.approvalBlocker(hold, check);
    const open = hold.status === 'pending_family';
    const words = check.input.description === hold.summary ? hold.summary : `${hold.summary}\n\n${check.input.description}`;
    return {
      ...this.baseView(hold, check),
      summary: hold.summary,
      ...(hold.payee_name ? { payee_name: hold.payee_name } : {}),
      member: { id: hold.member_id, name: member?.name ?? 'Family member' },
      member_words: words,
      ...(check.input.contact_channel ? { contact_channel: check.input.contact_channel } : {}),
      urgency_claims: check.input.urgency_claims ?? [],
      secrecy_requested: check.input.secrecy_requested === true,
      untrusted_contact_details: {
        ...(check.input.claimed_phone ? { claimed_phone: check.input.claimed_phone } : {}),
        ...(check.input.claimed_url ? { claimed_url: check.input.claimed_url } : {}),
        warning: UNTRUSTED_WARNING,
      },
      risk_signals: check.outcome.risk_signals,
      payee: check.outcome.payee,
      policy: { ...check.outcome.policy, approval_threshold_usd: policy.approval_threshold_usd },
      can_approve: open && !blocker,
      ...(open && blocker ? { cannot_approve_reason: blocker } : {}),
      requires_trust_payee: open && !blocker && this.needsTrust(hold, check),
      approval_url: this.approvalUrl(hold.id, contactUserId),
    };
  }

  decisionMessage(hold: HoldRow, decision: 'approve' | 'deny', trustedPayeeAdded: boolean): string {
    const member = this.store.getUser(hold.member_id);
    return sayDecision({
      decision,
      memberName: member?.name ?? 'your family member',
      payeeName: hold.payee_name,
      amount_usd: hold.amount_cents === undefined ? undefined : fromCents(hold.amount_cents),
      trustedPayee: trustedPayeeAdded,
    });
  }

  inboxMessage(principal: Principal, count: number): string {
    return sayInbox(count, this.store.listUsers(principal.circle_id, 'member')[0]?.name);
  }

  paidMessage(receipt: ReceiptRow): string {
    return sayPaid({
      payeeName: receipt.payee,
      amount_usd: fromCents(receipt.amount_cents),
      method: receipt.method,
      confirmation: receipt.confirmation,
    });
  }

  /** One-line description of a hold for logs and notifications to the trusted contact. */
  headline(hold: HoldRow): string {
    const member = this.store.getUser(hold.member_id)?.name ?? 'A family member';
    const amount = hold.amount_cents === undefined ? 'a payment' : formatUsd(fromCents(hold.amount_cents));
    return `${member}: ${amount}${hold.payee_name ? ` to ${hold.payee_name}` : ''}${hold.blocked ? ' (stopped by Hold On)' : ''}`;
  }
}

function statusWord(status: HoldStatus): string {
  return status === 'pending_family' ? 'waiting for an answer' : status;
}
